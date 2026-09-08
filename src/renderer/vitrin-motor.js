/* ============================================================================
 *  VİTRİN EDİTÖRÜ — MOTOR (src/renderer/vitrin-motor.js)
 *  ---------------------------------------------------------------------------
 *  DOM'suz, saf mantık katmanı. İki iş yapar:
 *
 *   1) DÜZEN İNDİRGEYİCİSİ (reducer)
 *      Blok sırası / aç-kapat / sil / ekle / ayar / renk token'ları için
 *      DEĞİŞMEZ (immutable) durum güncellemeleri. Her eylem yeni bir durum
 *      ve önizleme çerçevesine gidecek postMessage zarfını döndürür
 *      (BYOM-REGISTRY.md §3.2). Geri al / yinele 100 adıma kadar.
 *
 *   2) ÇEVRİMDIŞI KUYRUK (Offline-Outbox)
 *      YAYINLA → çevrimiçiyse doğrudan PUT; ağ hatasıysa / çevrimdışıysa
 *      en güncel şema TEK kayıt olarak yerel hafızaya yazılır
 *      (localStorage.byom_layout_outbox). Bağlantı gelince kuyruk tek PUT
 *      ile eşitlenir; 200 OK gelince kayıt DERHAL silinir (auto-purge).
 *      Üstel geri çekilme: 5s → 10s → 20s → 40s → 80s → 120s.
 *
 *  Neden DOM'suz: aynı dosya hem Electron arayüzünde (window.VitrinMotor)
 *  hem node:test altında (require) çalışır; kuyruk mantığı gerçek ağ
 *  olmadan, enjekte edilen zamanlayıcı/depo ile birebir test edilir.
 *
 *  Sözleşme: BYOM-REGISTRY.md §2 (şema), §3 (REST), §3.3 (outbox).
 * ==========================================================================*/

(function (kok) {
  'use strict';

  /* ==========================================================================
   *  0) SABİTLER VE KÜÇÜK YARDIMCILAR
   * ========================================================================*/

  var SCHEMA_VERSION = 1;
  var MAX_BLOCKS = 40;
  var MAX_HISTORY = 100;
  var SOURCE_DESKTOP = 'byom-desktop';
  var KEYS = {
    outbox: 'byom_layout_outbox',
    draft: 'byom_layout_draft',
    cache: 'byom_layout_cache'
  };
  var BACKOFF = [5000, 10000, 20000, 40000, 80000, 120000];

  var VARSAYILAN_TOKENLAR = {
    mode: 'inherit',
    primary: '#0F62FE',
    accent: '#FF7A00',
    bg: '#F8FAFC',
    surface: '#FFFFFF',
    border: '#E2E8F0',
    text_main: '#0F172A',
    radius: 10
  };

  function klon(deger) {
    return deger === undefined ? undefined : JSON.parse(JSON.stringify(deger));
  }

  function hexMi(deger) {
    return /^#[0-9a-fA-F]{6}$/.test(String(deger || ''));
  }

  function hexNormalle(deger) {
    var s = String(deger || '').trim();
    if (!s) return '';
    if (s[0] !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return hexMi(s) ? s.toUpperCase() : '';
  }

  function hexToRgb(hex) {
    hex = String(hex || '').replace(/^#/, '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
    return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  }

  /** Zemin rengine göre okunaklı yazı rengi (tema ile aynı eşik). */
  function kontrast(hex) {
    var rgb = hexToRgb(hex).map(function (c) {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return l > 0.45 ? '#111827' : '#FFFFFF';
  }

  function varsayilanRng() {
    return Math.random();
  }

  function kimlikUret(tip, rng) {
    rng = rng || varsayilanRng;
    var hex = '';
    for (var i = 0; i < 6; i++) hex += Math.floor(rng() * 16).toString(16);
    return String(tip) + '-' + hex;
  }

  function bulIndeks(bloklar, id) {
    for (var i = 0; i < bloklar.length; i++) {
      if (bloklar[i].id === id) return i;
    }
    return -1;
  }

  /* ==========================================================================
   *  1) REGISTRY YARDIMCILARI
   * ========================================================================*/

  function registryGirdisi(registry, tip) {
    return registry && registry[tip] ? registry[tip] : null;
  }

  function varsayilanAyarlar(registry, tip) {
    var girdi = registryGirdisi(registry, tip);
    var out = {};
    if (!girdi || !Array.isArray(girdi.settings)) return out;
    girdi.settings.forEach(function (alan) {
      out[alan.key] = klon(alan.default);
    });
    return out;
  }

  function canliAnahtarlar(registry, tip) {
    var girdi = registryGirdisi(registry, tip);
    if (!girdi || !Array.isArray(girdi.settings)) return [];
    return girdi.settings.filter(function (a) { return !!a.live; }).map(function (a) { return a.key; });
  }

  function canliMi(registry, tip, anahtar) {
    return canliAnahtarlar(registry, tip).indexOf(anahtar) !== -1;
  }

  function tekilMi(registry, tip) {
    var girdi = registryGirdisi(registry, tip);
    return !!(girdi && girdi.singleton);
  }

  /** Bir ayar değerini şemaya göre (istemci tarafı, hafif) daraltır. */
  function ayarDaralt(alan, deger) {
    if (!alan) return deger;
    switch (alan.type) {
      case 'number': {
        var n = Number(deger);
        if (!isFinite(n)) return alan.default;
        if (alan.min !== undefined) n = Math.max(Number(alan.min), n);
        if (alan.max !== undefined) n = Math.min(Number(alan.max), n);
        var step = alan.step !== undefined ? Number(alan.step) : 1;
        return step >= 1 ? Math.round(n) : n;
      }
      case 'toggle':
        if (typeof deger === 'boolean') return deger;
        return ['1', 'true', 'yes', 'on'].indexOf(String(deger).toLowerCase()) !== -1;
      case 'select': {
        var izinli = (alan.options || []).map(function (o) { return String(o && o.value !== undefined ? o.value : o); });
        return izinli.indexOf(String(deger)) !== -1 ? String(deger) : alan.default;
      }
      case 'color':
        return hexNormalle(deger) || alan.default;
      case 'product':
      case 'category':
        return Math.max(0, parseInt(deger, 10) || 0);
      case 'products': {
        /* Kimlik listesi: dizi, JSON dizesi ya da "1,2,3"; tekrar/gecersiz atilir, max ile kirpilir. */
        var kaynak = deger;
        if (typeof kaynak === 'string') {
          try { kaynak = JSON.parse(kaynak); } catch (e) { kaynak = kaynak.split(','); }
        }
        if (!Array.isArray(kaynak)) return [];
        var gorulen = {};
        var idler = [];
        var enCok = Number(alan.max) > 0 ? Number(alan.max) : 24;
        for (var pi = 0; pi < kaynak.length && idler.length < enCok; pi++) {
          var oge = kaynak[pi];
          if (oge && typeof oge === 'object') oge = oge.id;
          var pid = parseInt(oge, 10);
          if (!(pid > 0) || gorulen[pid]) continue;
          gorulen[pid] = true;
          idler.push(pid);
        }
        return idler;
      }
      case 'items': {
        if (!Array.isArray(deger)) return klon(alan.default);
        var max = alan.max || 6;
        return deger.slice(0, max).map(function (oge) {
          var temiz = {};
          (alan.fields || []).forEach(function (alt) {
            temiz[alt.key] = ayarDaralt(alt, oge && oge[alt.key] !== undefined ? oge[alt.key] : alt.default);
          });
          return temiz;
        });
      }
      case 'textarea':
        return String(deger === undefined || deger === null ? '' : deger).slice(0, alan.max || 600);
      default:
        return String(deger === undefined || deger === null ? '' : deger).slice(0, alan.max || 200);
    }
  }

  /**
   * Sunucudan / önbellekten gelen düzeni arayüzün beklediği biçime doldurur:
   * bilinen tipler, tam ayar kümesi (eksik anahtar → varsayılan), token'lar.
   */
  function normalizeClient(layout, registry) {
    layout = layout && typeof layout === 'object' ? layout : {};
    registry = registry || {};

    var tokenlar = Object.assign({}, VARSAYILAN_TOKENLAR, layout.tokens || {});
    tokenlar.mode = tokenlar.mode === 'custom' ? 'custom' : 'inherit';
    ['primary', 'accent', 'bg', 'surface', 'border', 'text_main'].forEach(function (k) {
      tokenlar[k] = hexNormalle(tokenlar[k]) || VARSAYILAN_TOKENLAR[k];
    });
    tokenlar.radius = Math.max(0, Math.min(32, parseInt(tokenlar.radius, 10) || 0));

    var gorulen = {};
    var bloklar = [];
    var ham = Array.isArray(layout.blocks) ? layout.blocks : [];

    ham.forEach(function (b, i) {
      if (!b || typeof b !== 'object' || !registry[b.type]) return;
      if (tekilMi(registry, b.type) && gorulen['tip:' + b.type]) return;
      var id = String(b.id || '').toLowerCase();
      if (!/^[a-z0-9-]{3,48}$/.test(id) || gorulen[id]) id = b.type + '-' + ('000000' + (i * 7919).toString(16)).slice(-6);
      gorulen[id] = true;
      gorulen['tip:' + b.type] = true;
      var ayar = varsayilanAyarlar(registry, b.type);
      var verilen = b.settings && typeof b.settings === 'object' ? b.settings : {};
      (registry[b.type].settings || []).forEach(function (alan) {
        if (Object.prototype.hasOwnProperty.call(verilen, alan.key)) ayar[alan.key] = ayarDaralt(alan, verilen[alan.key]);
      });
      bloklar.push({ id: id, type: b.type, enabled: b.enabled !== false && String(b.enabled) !== '0', settings: ayar });
    });

    return {
      schema_version: SCHEMA_VERSION,
      revision: Math.max(0, parseInt(layout.revision, 10) || 0),
      updated_at: layout.updated_at || '',
      updated_by: layout.updated_by || 'desktop',
      tokens: tokenlar,
      blocks: bloklar.slice(0, MAX_BLOCKS)
    };
  }

  /* ==========================================================================
   *  2) DÜZEN İNDİRGEYİCİSİ
   * ========================================================================*/

  function mesaj(tip, payload) {
    return { source: SOURCE_DESKTOP, type: tip, payload: payload || {} };
  }

  function createState(layout) {
    return { layout: klon(layout), history: [], future: [], dirty: false };
  }

  /** Yeni düzenle yeni durum: geçmişe eskisini iter, "ileri" yığınını boşaltır. */
  function ilerle(state, yeniLayout, mesajNesnesi) {
    var gecmis = state.history.concat([klon(state.layout)]);
    if (gecmis.length > MAX_HISTORY) gecmis = gecmis.slice(gecmis.length - MAX_HISTORY);
    return {
      state: { layout: yeniLayout, history: gecmis, future: [], dirty: true },
      message: mesajNesnesi || null
    };
  }

  function reorder(state, sira) {
    var eski = state.layout.blocks;
    var haritasi = {};
    eski.forEach(function (b) { haritasi[b.id] = b; });
    var yeni = [];
    var yerlesti = {};
    (sira || []).forEach(function (id) {
      if (haritasi[id] && !yerlesti[id]) { yeni.push(haritasi[id]); yerlesti[id] = true; }
    });
    eski.forEach(function (b) { if (!yerlesti[b.id]) yeni.push(b); });

    var degisti = yeni.some(function (b, i) { return eski[i] !== b; });
    if (!degisti) return { state: state, message: null };

    var layout = klon(state.layout);
    layout.blocks = klon(yeni);
    return ilerle(state, layout, mesaj('BYOM_REORDER', { order: layout.blocks.map(function (b) { return b.id; }) }));
  }

  function move(state, id, hedefIndeks) {
    var bloklar = state.layout.blocks.slice();
    var i = bulIndeks(bloklar, id);
    if (i === -1) return { state: state, message: null };
    hedefIndeks = Math.max(0, Math.min(bloklar.length - 1, parseInt(hedefIndeks, 10) || 0));
    if (hedefIndeks === i) return { state: state, message: null };
    var blok = bloklar.splice(i, 1)[0];
    bloklar.splice(hedefIndeks, 0, blok);
    return reorder(state, bloklar.map(function (b) { return b.id; }));
  }

  function toggle(state, id, enabled) {
    var i = bulIndeks(state.layout.blocks, id);
    if (i === -1) return { state: state, message: null };
    var layout = klon(state.layout);
    layout.blocks[i].enabled = enabled === undefined ? !layout.blocks[i].enabled : !!enabled;
    return ilerle(state, layout, mesaj('BYOM_TOGGLE', { id: id, enabled: layout.blocks[i].enabled }));
  }

  function remove(state, id) {
    var i = bulIndeks(state.layout.blocks, id);
    if (i === -1) return { state: state, message: null };
    var layout = klon(state.layout);
    layout.blocks.splice(i, 1);
    /* Önizlemede blok markup'ı sunucudan gelir; silinen blok gizlenir,
       sıra yeniden bildirilir (yayınlanınca tamamen kalkar). */
    return ilerle(state, layout, mesaj('BYOM_TOGGLE', { id: id, enabled: false }));
  }

  function add(state, tip, registry, secenek) {
    secenek = secenek || {};
    var girdi = registryGirdisi(registry, tip);
    if (!girdi) return { state: state, message: null, error: 'unknown_type' };
    if (state.layout.blocks.length >= MAX_BLOCKS) return { state: state, message: null, error: 'limit' };
    if (tekilMi(registry, tip) && state.layout.blocks.some(function (b) { return b.type === tip; })) {
      return { state: state, message: null, error: 'singleton' };
    }
    var mevcut = {};
    state.layout.blocks.forEach(function (b) { mevcut[b.id] = true; });
    var id = kimlikUret(tip, secenek.rng);
    var guard = 0;
    while (mevcut[id] && guard++ < 20) id = kimlikUret(tip, secenek.rng);

    var blok = { id: id, type: tip, enabled: true, settings: varsayilanAyarlar(registry, tip) };
    var layout = klon(state.layout);
    var at = secenek.atIndex === undefined ? layout.blocks.length : Math.max(0, Math.min(layout.blocks.length, secenek.atIndex));
    layout.blocks.splice(at, 0, blok);
    var sonuc = ilerle(state, layout, mesaj('BYOM_REORDER', { order: layout.blocks.map(function (b) { return b.id; }) }));
    sonuc.block = blok;
    return sonuc;
  }

  function updateSettings(state, id, kismi, registry) {
    var i = bulIndeks(state.layout.blocks, id);
    if (i === -1) return { state: state, message: null };
    var layout = klon(state.layout);
    var blok = layout.blocks[i];
    var girdi = registryGirdisi(registry, blok.type);
    var alanlar = {};
    ((girdi && girdi.settings) || []).forEach(function (a) { alanlar[a.key] = a; });
    var degisen = {};
    Object.keys(kismi || {}).forEach(function (k) {
      var deger = alanlar[k] ? ayarDaralt(alanlar[k], kismi[k]) : kismi[k];
      if (JSON.stringify(blok.settings[k]) !== JSON.stringify(deger)) {
        blok.settings[k] = deger;
        degisen[k] = deger;
      }
    });
    if (!Object.keys(degisen).length) return { state: state, message: null };
    return ilerle(state, layout, mesaj('BYOM_SETTINGS', { id: id, settings: degisen }));
  }

  function setTokens(state, kismi) {
    var layout = klon(state.layout);
    var t = Object.assign({}, VARSAYILAN_TOKENLAR, layout.tokens || {});
    var degisti = false;
    Object.keys(kismi || {}).forEach(function (k) {
      var v = kismi[k];
      if (k === 'radius') v = Math.max(0, Math.min(32, parseInt(v, 10) || 0));
      else if (k === 'mode') v = v === 'custom' ? 'custom' : 'inherit';
      else if (Object.prototype.hasOwnProperty.call(VARSAYILAN_TOKENLAR, k)) { v = hexNormalle(v); if (!v) return; }
      else return;
      if (t[k] !== v) { t[k] = v; degisti = true; }
    });
    if (!degisti) return { state: state, message: null };
    layout.tokens = t;
    return ilerle(state, layout, mesaj('BYOM_TOKENS', { tokens: klon(t) }));
  }

  function setTokensMode(state, mode) {
    return setTokens(state, { mode: mode });
  }

  function undo(state) {
    if (!state.history.length) return { state: state, message: null };
    var onceki = state.history[state.history.length - 1];
    var yeni = {
      layout: klon(onceki),
      history: state.history.slice(0, -1),
      future: [klon(state.layout)].concat(state.future),
      dirty: true
    };
    return { state: yeni, message: mesaj('BYOM_LAYOUT', { layout: klon(yeni.layout) }) };
  }

  function redo(state) {
    if (!state.future.length) return { state: state, message: null };
    var sonraki = state.future[0];
    var yeni = {
      layout: klon(sonraki),
      history: state.history.concat([klon(state.layout)]),
      future: state.future.slice(1),
      dirty: true
    };
    return { state: yeni, message: mesaj('BYOM_LAYOUT', { layout: klon(yeni.layout) }) };
  }

  /** Sunucudan yeni düzen geldi: geçmiş sıfırlanır, kirli bayrağı iner. */
  function replaceLayout(state, layout) {
    return { state: { layout: klon(layout), history: [], future: [], dirty: false }, message: mesaj('BYOM_LAYOUT', { layout: klon(layout) }) };
  }

  function markClean(state, revision) {
    var layout = klon(state.layout);
    if (revision !== undefined) layout.revision = revision;
    return { layout: layout, history: state.history, future: state.future, dirty: false };
  }

  /* ==========================================================================
   *  3) PUT GÖVDESİ
   * ========================================================================*/

  function buildPutBody(layout, baseRevision, force, client) {
    var temiz = {
      schema_version: SCHEMA_VERSION,
      tokens: klon(layout.tokens || VARSAYILAN_TOKENLAR),
      blocks: (layout.blocks || []).map(function (b) {
        return { id: b.id, type: b.type, enabled: b.enabled !== false, settings: klon(b.settings || {}) };
      })
    };
    var govde = { layout: temiz, force: !!force };
    if (baseRevision !== undefined && baseRevision !== null && baseRevision !== '') govde.base_revision = parseInt(baseRevision, 10) || 0;
    if (client) govde.client = klon(client);
    return govde;
  }

  /* ==========================================================================
   *  4) ÇEVRİMDIŞI KUYRUK (OFFLINE-OUTBOX)
   * ========================================================================*/

  function createOutbox(deps) {
    deps = deps || {};

    var storage = deps.storage;
    var now = deps.now || function () { return Date.now(); };
    var timers = deps.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
    var isOnline = deps.isOnline || function () { return true; };
    var put = deps.put;
    var ping = deps.ping || function () { return Promise.resolve(true); };
    var onState = deps.onState || function () {};
    var client = deps.client || { app: 'byom-b2b-panel', version: '' };
    var pollIdle = deps.pollIdle || 60000;
    var pollQueued = deps.pollQueued || 15000;

    var durum = 'online';
    var pollTimer = null;
    var pollGen = 0;   // startPolling her cagrildiginda artar; eski tur kendini yeniden planlamaz
    var retryTimer = null;
    var syncing = false;
    /* Kayit sira numarasi: ayni milisaniyede yazilan iki kaydi ayirt eder.
       Onceki oturumdan kalan kayit varsa oradan devam eder (eski kayit 'daha yeni' sanilmasin). */
    var sira = 0;

    (function () { var k = oku(KEYS.outbox); if (k && typeof k.seq === 'number' && k.seq > sira) sira = k.seq; })();

    function iso(ms) {
      try { return new Date(ms).toISOString(); } catch (e) { return ''; }
    }

    function oku(anahtar) {
      try {
        var ham = storage.getItem(anahtar);
        return ham ? JSON.parse(ham) : null;
      } catch (e) { return null; }
    }

    function yaz(anahtar, deger) {
      try { storage.setItem(anahtar, JSON.stringify(deger)); return true; } catch (e) { return false; }
    }

    function sil(anahtar) {
      try { storage.removeItem(anahtar); } catch (e) { /* özel pencere vb. */ }
    }

    function durumAyarla(ad, ayrinti) {
      durum = ad;
      try { onState(ad, ayrinti || {}); } catch (e) { /* dinleyici hatası kuyruğu bozmasın */ }
    }

    function peek() { return oku(KEYS.outbox); }
    function clear() { sil(KEYS.outbox); }

    /** Kuyruğa yaz: her zaman TEK kayıt, en güncel şema kazanır. */
    function enqueue(layout, baseRevision, force) {
      var eski = peek();
      var kayit = {
        layout: klon(layout),
        base_revision: baseRevision === undefined || baseRevision === null ? null : parseInt(baseRevision, 10) || 0,
        force: !!force,
        queued_at: iso(now()),
        seq: ++sira,
        attempts: eski ? (eski.attempts || 0) : 0,
        last_error: eski ? (eski.last_error || null) : null
      };
      yaz(KEYS.outbox, kayit);
      durumAyarla('queued', { count: 1, offline: !isOnline(), attempts: kayit.attempts });
      return kayit;
    }

    /*
     * Siniflandirma: YALNIZCA tasima katmani hatasi (agSorunu) ve 5xx "ag"
     * sayilir ve kuyrukta kalir. durum:0 ama agSorunu YOKSA bu bir yapilandirma
     * hatasidir (site adresi / anahtar bos) - sonsuza dek yeniden denemek
     * yerine kullaniciya gosterilir.
     */
    function sinifla(cevap) {
      if (cevap && cevap.ok) return 'ok';
      var kod = Number(cevap && cevap.durum) || 0;
      if (!cevap || cevap.agSorunu || kod >= 500) return 'network';
      if (kod === 409) return 'conflict';
      return 'error';
    }

    function dene(kayit) {
      var govde = buildPutBody(kayit.layout, kayit.base_revision, kayit.force,
        Object.assign({}, client, { queued_at: kayit.queued_at }));
      return Promise.resolve()
        .then(function () { return put(govde); })
        .catch(function (e) {
          return { ok: false, durum: 0, agSorunu: true, hata: String((e && e.message) || e) };
        })
        .then(function (cevap) {
          return { kind: sinifla(cevap), cevap: cevap || {} };
        });
    }

    function cakismaAyrintisi(cevap) {
      var veri = (cevap && cevap.veri) || {};
      var data = veri.data || {};
      return { current_revision: data.current_revision, layout: data.layout, message: veri.message || cevap.hata || '' };
    }

    function retryPlanla() {
      var kayit = peek();
      if (!kayit) return;
      /* attempts kaydedilmis deneme sayisidir (>=1 iken cagrilir): 1. basarisizliktan sonra 5 sn, 2.'den sonra 10 sn... */
      var gecikme = BACKOFF[Math.min(Math.max(0, (kayit.attempts || 1) - 1), BACKOFF.length - 1)];
      if (retryTimer) timers.clearTimeout(retryTimer);
      retryTimer = timers.setTimeout(function () {
        retryTimer = null;
        sync();
      }, gecikme);
      return gecikme;
    }

    /**
     * 200 OK sonrasi temizlik. Istek ucarken kuyruga DAHA YENI bir kayit
     * yazilmis olabilir (baglanti dalgalanmasi + yeni YAYINLA); o kayit
     * silinmez, eşitleme yeniden planlanir. Kimlik: queued_at (ISO, siralanabilir).
     */
    /** Depodaki kayit, gonderilen kayittan daha mi yeni? (once seq, yoksa queued_at) */
    function dahaYeniMi(mevcut, gonderilen) {
      if (!mevcut || !gonderilen) return false;
      if (typeof mevcut.seq === 'number' && typeof gonderilen.seq === 'number') return mevcut.seq > gonderilen.seq;
      return !!(mevcut.queued_at && gonderilen.queued_at && mevcut.queued_at > gonderilen.queued_at);
    }

    function basariyiIsle(cevap, gonderilen) {
      var mevcut = peek();
      var dahaYeni = dahaYeniMi(mevcut, gonderilen);
      var veri = cevap.veri || {};

      if (!dahaYeni) {
        clear();
        sil(KEYS.draft);
        if (retryTimer) { timers.clearTimeout(retryTimer); retryTimer = null; }
        durumAyarla('online', { revision: veri.revision });
      } else {
        durumAyarla('queued', { count: 1, offline: !isOnline(), attempts: mevcut.attempts || 0, revision: veri.revision });
        retryPlanla();
      }

      return { ok: true, revision: veri.revision, layout: veri.layout, warnings: veri.warnings || [], veri: veri, pending: dahaYeni };
    }

    /** YAYINLA: anında dene; olmazsa kuyruğa al. */
    function publish(layout, baseRevision, force) {
      if (!isOnline()) {
        var k = enqueue(layout, baseRevision, force);
        return Promise.resolve({ ok: false, queued: true, offline: true, kayit: k });
      }

      durumAyarla('syncing', {});
      var kayit = { layout: layout, base_revision: baseRevision, force: force, queued_at: iso(now()), seq: ++sira };

      return dene(kayit).then(function (r) {
        if (r.kind === 'ok') return basariyiIsle(r.cevap, kayit);

        if (r.kind === 'network') {
          var yeni = enqueue(layout, baseRevision, force);
          yeni.attempts = (yeni.attempts || 0) + 1;
          yeni.last_error = r.cevap.hata || '';
          yaz(KEYS.outbox, yeni);
          var gecikme = retryPlanla();
          durumAyarla('queued', { count: 1, offline: !isOnline(), attempts: yeni.attempts, error: yeni.last_error, next_in: gecikme });
          return { ok: false, queued: true, hata: r.cevap.hata || '' };
        }

        if (r.kind === 'conflict') {
          var c = cakismaAyrintisi(r.cevap);
          durumAyarla('conflict', c);
          return { ok: false, conflict: true, current: c };
        }

        durumAyarla('error', { hata: r.cevap.hata || '', durum: r.cevap.durum, veri: r.cevap.veri });
        return { ok: false, error: true, hata: r.cevap.hata || '', durum: r.cevap.durum, veri: r.cevap.veri };
      });
    }

    /** Kuyruğu eşitle (tek PUT). */
    function sync() {
      var kayit = peek();
      if (!kayit) {
        /* Kuyruk bos: 'conflict' yalnizca bekleyen kayitla anlamlidir, o da sifirlanir. */
        if (durum !== 'error') durumAyarla(isOnline() ? 'online' : 'offline', { offline: !isOnline() });
        return Promise.resolve({ ok: true, empty: true });
      }
      if (!isOnline()) {
        durumAyarla('queued', { count: 1, offline: true, attempts: kayit.attempts });
        return Promise.resolve({ ok: false, offline: true, queued: true });
      }
      if (syncing) return Promise.resolve({ ok: false, busy: true });

      syncing = true;
      durumAyarla('syncing', { count: 1 });

      return dene(kayit).then(function (r) {
        syncing = false;

        if (r.kind === 'ok') {
          var s = basariyiIsle(r.cevap, kayit);
          s.synced = true;
          return s;
        }

        if (r.kind === 'network') {
          var guncel = peek() || kayit;
          guncel.attempts = (guncel.attempts || 0) + 1;
          guncel.last_error = r.cevap.hata || '';
          yaz(KEYS.outbox, guncel);
          var gecikme = retryPlanla();
          durumAyarla('queued', { count: 1, offline: !isOnline(), attempts: guncel.attempts, error: guncel.last_error, next_in: gecikme });
          return { ok: false, queued: true, hata: guncel.last_error };
        }

        if (r.kind === 'conflict') {
          var c = cakismaAyrintisi(r.cevap);
          durumAyarla('conflict', c);
          return { ok: false, conflict: true, current: c };
        }

        /* 4xx: sunucu isteği reddetti; tekrar denemek anlamsız. Kuyruktan
           çıkar, kullanıcıya göster. Taslak korunur (byom_layout_draft).
           Istek ucarken daha yeni bir kayit yazildiysa o kayit kalir ve planlanir. */
        if (!dahaYeniMi(peek(), kayit)) clear();
        else retryPlanla();
        durumAyarla('error', { hata: r.cevap.hata || '', durum: r.cevap.durum, veri: r.cevap.veri });
        return { ok: false, error: true, hata: r.cevap.hata || '', durum: r.cevap.durum, veri: r.cevap.veri };
      });
    }

    /** Kuyruktaki kaydı zorla (çakışma sonrası "üzerine yaz"). */
    function forceQueued() {
      var kayit = peek();
      if (!kayit) return Promise.resolve({ ok: false, empty: true });
      kayit.force = true;
      yaz(KEYS.outbox, kayit);
      return sync();
    }

    function pollTick(gen) {
      var kuyrukta = !!peek();
      return Promise.resolve()
        .then(function () { return isOnline() ? ping() : false; })
        .catch(function () { return false; })
        .then(function (ulasildi) {
          if (ulasildi) {
            if (kuyrukta) return sync();
            if (durum === 'offline') durumAyarla('online', {});
          } else {
            durumAyarla(kuyrukta ? 'queued' : 'offline', { offline: true, count: kuyrukta ? 1 : 0 });
          }
          return null;
        })
        .then(function () {
          if (gen === pollGen && pollTimer !== null) {
            pollTimer = timers.setTimeout(function () { pollTick(gen); }, peek() ? pollQueued : pollIdle);
          }
        });
    }

    function startPolling() {
      stopPolling();
      var gen = ++pollGen;
      pollTimer = timers.setTimeout(function () { pollTick(gen); }, peek() ? pollQueued : pollIdle);
      if (peek() && isOnline()) sync();
    }

    function stopPolling() {
      pollGen++;
      if (pollTimer !== null) { timers.clearTimeout(pollTimer); pollTimer = null; }
      if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null; }
    }

    function goOnline() {
      durumAyarla(peek() ? 'queued' : 'online', { offline: false, count: peek() ? 1 : 0 });
      return sync();
    }

    function goOffline() {
      durumAyarla(peek() ? 'queued' : 'offline', { offline: true, count: peek() ? 1 : 0 });
    }

    return {
      KEYS: KEYS,
      enqueue: enqueue,
      peek: peek,
      clear: clear,
      publish: publish,
      sync: sync,
      forceQueued: forceQueued,
      startPolling: startPolling,
      stopPolling: stopPolling,
      goOnline: goOnline,
      goOffline: goOffline,
      getState: function () { return durum; },
      saveDraft: function (layout) { return yaz(KEYS.draft, { layout: klon(layout), saved_at: iso(now()) }); },
      loadDraft: function () { return oku(KEYS.draft); },
      clearDraft: function () { sil(KEYS.draft); },
      saveCache: function (veri) { return yaz(KEYS.cache, veri); },
      loadCache: function () { return oku(KEYS.cache); }
    };
  }

  /* ==========================================================================
   *  5) DEMO VERİSİ (demo modu / siteye ulaşılamadığında ilk açılış)
   *  BYOM-REGISTRY.md §2.1-§2.2'nin özeti; sunucudan gelen registry her
   *  zaman bunun üstüne yazar.
   * ========================================================================*/

  function demoRegistry() {
    function f(key, type, label, def, extra, live) {
      return Object.assign({ key: key, type: type, label: label, default: def, live: !!live }, extra || {});
    }
    function opts(map) { return Object.keys(map).map(function (k) { return { value: k, label: map[k] }; }); }
    var kaynakAuto = opts({ auto: 'Otomatik', manual: 'Seçtiğim ürünler', featured: 'Panelden seçilenler', onsale: 'İndirimdekiler', latest: 'En yeniler' });
    var kaynakKat = opts({ manual: 'Seçtiğim ürünler', bestsellers: 'Çok satanlar', featured: 'Panelden seçilenler', onsale: 'İndirimdekiler', latest: 'En yeniler', category: 'Kategori' });
    var ikonlar = ['percent', 'box', 'truck', 'shield', 'wallet', 'clock', 'check', 'bolt', 'star', 'tag'];
    var ikonOpts = ikonlar.map(function (i) { return { value: i, label: i }; });

    return {
      'hero-combo': { type: 'hero-combo', label: 'Hero Kombo', description: 'Kategori ağacı + kampanya ürünü + hızlı fırsatlar', icon: 'panel', group: 'lego', singleton: true, settings: [
        f('eyebrow', 'text', 'Üst etiket', 'Haftanın Kampanyası', { max: 60 }, true),
        f('banner_mode', 'select', 'Merkez alan', 'auto', { options: opts({ auto: 'Otomatik', banners: 'Banner slider', product: 'Kampanya ürünü' }) }),
        f('product_id', 'product', 'Kampanya ürünü', 0),
        f('deal_source', 'select', 'Fırsat kaynağı', 'auto', { options: kaynakAuto }),
        f('deal_products', 'products', 'Fırsat ürünleri (elle)', [], { max: 24 }),
        f('deal_count', 'number', 'Fırsat kartı adedi', 3, { min: 2, max: 4, step: 1 }),
        f('show_categories', 'toggle', 'Kategori ağacını göster', true, {}, true)
      ] },
      'flash-deals': { type: 'flash-deals', label: 'Flaş Fırsatlar', description: 'Geri sayım + indirimli vitrin', icon: 'parlak', group: 'lego', singleton: false, settings: [
        f('title', 'text', 'Başlık', '', { max: 120 }, true),
        f('source', 'select', 'Ürün kaynağı', 'auto', { options: kaynakAuto }),
        f('products', 'products', 'Ürünler (elle seçim)', [], { max: 24 }),
        f('limit', 'number', 'Ürün adedi', 8, { min: 2, max: 24, step: 1 }),
        f('columns', 'select', 'Sütun', '4', { options: opts({ 4: '4', 5: '5', 6: '6' }) }, true),
        f('countdown', 'select', 'Geri sayım', 'daily', { options: opts({ off: 'Kapalı', daily: 'Her gece 00:00', weekly: 'Pazar 23:59', fixed: 'Belirli tarih' }) }, true),
        f('ends_at', 'datetime', 'Bitiş tarihi', '', {}, true)
      ] },
      'category-pills': { type: 'category-pills', label: 'Kategori Hapları', description: 'Yatay, yapışkan kategori butonları', icon: 'etiket', group: 'lego', singleton: true, settings: [
        f('limit', 'number', 'Kategori adedi', 12, { min: 4, max: 30, step: 1 }),
        f('sticky', 'toggle', 'Üstte sabit kalsın', true, {}, true),
        f('show_counts', 'toggle', 'Ürün adedini göster', true, {}, true),
        f('show_all_link', 'toggle', '"Tüm Ürünler" bağlantısı', true, {}, true)
      ] },
      'grid-showcase': { type: 'grid-showcase', label: 'Ürün Izgarası', description: "4'lü / 5'li ürün kartları", icon: 'paket', group: 'lego', singleton: false, settings: [
        f('title', 'text', 'Başlık', 'Katalogdan Seçtiklerimiz', { max: 120 }, true),
        f('subtitle', 'text', 'Alt başlık', '', { max: 200 }, true),
        f('source', 'select', 'Ürün kaynağı', 'latest', { options: kaynakKat }),
        f('category', 'category', 'Kategori', 0),
        f('products', 'products', 'Ürünler (elle seçim)', [], { max: 24 }),
        f('columns', 'select', 'Sütun', '4', { options: opts({ 4: '4', 5: '5' }) }, true),
        f('limit', 'number', 'Ürün adedi', 8, { min: 4, max: 20, step: 1 })
      ] },
      'quick-matrix': { type: 'quick-matrix', label: 'Hızlı Toptan Sipariş', description: 'Çoklu adet girilip tek tıkla sepete', icon: 'sepet', group: 'lego', singleton: false, settings: [
        f('title', 'text', 'Başlık', 'Hızlı Toptan Sipariş', { max: 120 }, true),
        f('subtitle', 'text', 'Alt başlık', 'Adetleri girin, tek tıkla hepsini sepete atın.', { max: 200 }, true),
        f('source', 'select', 'Ürün kaynağı', 'bestsellers', { options: kaynakKat }),
        f('category', 'category', 'Kategori', 0),
        f('products', 'products', 'Ürünler (elle seçim)', [], { max: 24 }),
        f('limit', 'number', 'Satır adedi', 10, { min: 3, max: 30, step: 1 }),
        f('show_case', 'toggle', 'Koli sütunu', true, {}, true)
      ] },
      'trust-badges': { type: 'trust-badges', label: 'Güven Rozetleri', description: 'Minimal B2B avantaj şeridi', icon: 'kalkan', group: 'lego', singleton: false, settings: [
        f('style', 'select', 'Görünüm', 'strip', { options: opts({ strip: 'Şerit', cards: 'Kartlar' }) }, true),
        f('items', 'items', 'Rozetler', [
          { icon: 'box', title: 'Koli İskontosu', text: 'Koli bazlı alımlarda otomatik indirim.' },
          { icon: 'truck', title: 'Anında Sevk', text: 'Stoktaki ürünler aynı gün kargoda.' },
          { icon: 'shield', title: 'Cari Güvence', text: 'Açık hesap ve vadeli ödeme güvencesi.' }
        ], { max: 6, fields: [
          f('icon', 'select', 'İkon', 'check', { options: ikonOpts }),
          f('title', 'text', 'Başlık', '', { max: 40 }),
          f('text', 'text', 'Açıklama', '', { max: 90 })
        ] }, true)
      ] },
      'category-shelf': { type: 'category-shelf', label: 'Kategori Rafı', description: 'Yatay kaydırmalı raf: kategori + ürün sayısı + oklar', icon: 'liste', group: 'lego', singleton: false, settings: [
        f('category', 'category', 'Kategori', 0),
        f('title', 'text', 'Başlık', '', { max: 80 }, true),
        f('products', 'products', 'Ürünler (elle seçim)', [], { max: 24 }),
        f('limit', 'number', 'Raftaki ürün adedi', 10, { min: 4, max: 24, step: 1 }),
        f('columns', 'select', 'Yan yana kart', '5', { options: opts({ 4: '4', 5: '5', 6: '6' }) }, true),
        f('show_count', 'toggle', 'Ürün sayısı rozeti', true, {}, true),
        f('show_all_link', 'toggle', '"Tüm Kategoriyi Gör" bağlantısı', true, {}, true)
      ] },
      'hero-slider': { type: 'hero-slider', label: 'Grafik Banner Slider', description: 'Panelden yüklenen bannerlar: otomatik/elle kaydırma, noktalar, oklar', icon: 'resim', group: 'lego', singleton: true, settings: [
        f('autoplay', 'number', 'Otomatik geçiş (sn)', 5, { min: 0, max: 30, step: 1 }, true),
        f('height', 'select', 'Yükseklik', 'normal', { options: opts({ compact: 'Kompakt', normal: 'Normal', tall: 'Yüksek' }) }, true),
        f('fit', 'select', 'Görsel sığdırma', 'cover', { options: opts({ cover: 'Doldur', contain: 'Sığdır' }) }, true),
        f('show_dots', 'toggle', 'Sayfalama noktaları', true, {}, true),
        f('show_arrows', 'toggle', 'Yön okları', true, {}, true)
      ] },
      'catalog-cta': { type: 'catalog-cta', label: 'Kataloğa Yönlendirme', description: '"1.100+ çeşit" kartı: Tüm Ürünler / Mağazaya Git', icon: 'kure', group: 'lego', singleton: true, settings: [
        f('title', 'text', 'Başlık', '', { max: 120 }, true),
        f('text', 'text', 'Açıklama', '', { max: 200 }, true),
        f('button_label', 'text', 'Düğme yazısı', '', { max: 60 }, true),
        f('show_stats', 'toggle', 'Sayaçlar', true, {}, true),
        f('style', 'select', 'Renk', 'dark', { options: opts({ dark: 'Koyu', light: 'Açık', primary: 'Marka rengi' }) }, true)
      ] },
      slider: { type: 'slider', label: 'Slider', description: 'Panel banner slider', icon: 'resim', group: 'classic', singleton: true, settings: [
        f('autoplay', 'number', 'Otomatik geçiş (sn)', 6, { min: 0, max: 30, step: 1 })
      ] },
      'dual-banner': { type: 'dual-banner', label: "2'li Banner", description: 'İki panel görseli', icon: 'resim', group: 'classic', singleton: false, settings: [] },
      'strip-banner': { type: 'strip-banner', label: 'Geniş Şerit', description: 'Artan panel görselleri', icon: 'resim', group: 'classic', singleton: false, settings: [] },
      'category-grid': { type: 'category-grid', label: 'Kategori İzgarası', description: 'Dairesel kategori kartları', icon: 'klasor', group: 'classic', singleton: false, settings: [
        f('limit', 'number', 'Kategori adedi', 8, { min: 4, max: 24, step: 1 })
      ] },
      'trust-bar': { type: 'trust-bar', label: 'Güven Şeridi (4 kart)', description: 'Klasik avantaj şeridi', icon: 'kalkan', group: 'classic', singleton: false, settings: [] },
      'cta-band': { type: 'cta-band', label: 'Bayilik Çağrısı', description: 'Bayi olmayanlara başvuru çağrısı', icon: 'bina', group: 'classic', singleton: true, settings: [] }
    };
  }

  function demoLayout(registry) {
    registry = registry || demoRegistry();
    /* Eklentideki default_layout() ile AYNI showroom sirasi (BYOM-REGISTRY.md §2.2). */
    var sira = [
      ['hero-slider'], ['category-pills'], ['category-shelf', 'category-shelf-1'], ['category-shelf', 'category-shelf-2'],
      ['dual-banner'], ['category-shelf', 'category-shelf-3'], ['flash-deals'], ['catalog-cta'], ['trust-badges'], ['cta-band']
    ];
    return {
      schema_version: SCHEMA_VERSION,
      revision: 0,
      updated_at: '',
      updated_by: 'default',
      tokens: klon(VARSAYILAN_TOKENLAR),
      blocks: sira.map(function (p) {
        return { id: p[1] || (p[0] + '-default'), type: p[0], enabled: true, settings: varsayilanAyarlar(registry, p[0]) };
      })
    };
  }

  /* ==========================================================================
   *  6) DIŞA AÇIK YÜZEY
   * ========================================================================*/

  var VitrinMotor = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_BLOCKS: MAX_BLOCKS,
    KEYS: KEYS,
    BACKOFF: BACKOFF,
    VARSAYILAN_TOKENLAR: VARSAYILAN_TOKENLAR,
    klon: klon,
    hexNormalle: hexNormalle,
    hexToRgb: hexToRgb,
    kontrast: kontrast,
    kimlikUret: kimlikUret,
    varsayilanAyarlar: varsayilanAyarlar,
    canliAnahtarlar: canliAnahtarlar,
    canliMi: canliMi,
    tekilMi: tekilMi,
    ayarDaralt: ayarDaralt,
    normalizeClient: normalizeClient,
    mesaj: mesaj,
    createState: createState,
    reorder: reorder,
    move: move,
    toggle: toggle,
    remove: remove,
    add: add,
    updateSettings: updateSettings,
    setTokens: setTokens,
    setTokensMode: setTokensMode,
    undo: undo,
    redo: redo,
    replaceLayout: replaceLayout,
    markClean: markClean,
    buildPutBody: buildPutBody,
    createOutbox: createOutbox,
    demoRegistry: demoRegistry,
    demoLayout: demoLayout
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = VitrinMotor;
  }

  if (typeof window !== 'undefined') {
    window.VitrinMotor = VitrinMotor;
  }
})(this);
