/* ============================================================================
 *  VİTRİN EDİTÖRÜ — ARAYÜZ (renderer-vitrin.js)
 *  ---------------------------------------------------------------------------
 *  Web sitesinin ana sayfasını WP-Admin'e girmeden, lego parçaları gibi
 *  düzenleyen sekme (#sekme-vitrin-editor):
 *
 *   SOL PANEL  "Lego Çantası": blokları sürükleyip sıralama (pointer tabanlı,
 *              yalnızca transform → 60 FPS), aç/kapat, sil, ayar çarkı
 *              (registry şemasından üretilen form), blok ekleme paleti,
 *              renk & köşe token'ları.
 *   SAĞ PANEL  Canlı önizleme (iframe). Her değişiklik postMessage ile
 *              DOM takası / CSS değişkeni olarak uygulanır; sayfa yenilenmez,
 *              sunucuya gidilmez (BYOM-REGISTRY.md §3.2).
 *   YAYINLA    Tek PUT (byom/v1/storefront-layout). Çevrimdışıysa kuyruk
 *              (Offline-Outbox, src/renderer/vitrin-motor.js).
 *
 *  Güvenlik: nodeIntegration açık olduğu için sunucudan gelen HER dize
 *  kacis() ile basılır; layout/registry verisi hiçbir zaman ham innerHTML
 *  olmaz.
 *
 *  renderer.js, renderer-ek.js ve src/renderer/vitrin-motor.js'ten SONRA
 *  yüklenir. Sekme ilk açıldığında `vitrinEditorAc()` ile başlar.
 * ==========================================================================*/

(function () {
  'use strict';

  /* ==========================================================================
   *  0) ORTAM VE YEDEKLİ YARDIMCILAR
   * ========================================================================*/

  var electron = null;
  try { electron = require('electron'); } catch (e) { electron = null; }

  var M = window.VitrinMotor;
  if (!M) {
    console.error('[Vitrin Editörü] VitrinMotor yüklenmedi (src/renderer/vitrin-motor.js).');
    return;
  }

  var secDeg = function (s, kap) { return (kap || document).querySelector(s); };
  var secHep = function (s, kap) { return Array.prototype.slice.call((kap || document).querySelectorAll(s)); };

  var kac = typeof kacis === 'function' ? kacis : function (m) {
    return String(m === null || m === undefined ? '' : m).replace(/[&<>"']/g, function (k) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k];
    });
  };
  var uyar = function (mesaj, tur) {
    if (typeof bildir === 'function') bildir(mesaj, tur);
    else console.log('[Vitrin]', tur || 'bilgi', mesaj);
  };
  var sor = function (baslik, mesaj, tamam, tehlikeli) {
    if (typeof onayla === 'function') return onayla(baslik, mesaj, tamam, tehlikeli);
    return Promise.resolve(window.confirm(baslik + '\n\n' + mesaj));
  };
  var ikn = function (ad, sinif) {
    ad = /^[A-Za-z0-9_-]{1,32}$/.test(String(ad)) ? String(ad) : 'paket';
    if (typeof ikon === 'function') return ikon(ad, sinif);
    return '<svg class="ik' + (sinif ? ' ' + sinif : '') + '" aria-hidden="true"><use href="#ik-' + ad + '"></use></svg>';
  };
  var apiCagir = function (alan, yol, secenek) {
    if (typeof api === 'function') return api(alan, yol, secenek);
    if (electron && electron.ipcRenderer) {
      secenek = secenek || {};
      return electron.ipcRenderer.invoke('api:istek', {
        alan: alan, yol: yol, metod: secenek.metod || 'GET', sorgu: secenek.sorgu || {},
        govde: secenek.govde || null, sureAsimi: secenek.sureAsimi || 0
      });
    }
    return Promise.resolve({ ok: false, durum: 0, hata: 'API köprüsü yok.' });
  };
  var b2bCagir = function (yol, secenek) { return apiCagir('b2b', yol, secenek); };
  var wooCagir = function (yol, secenek) { return apiCagir('woo', yol, secenek); };

  function durumNesnesi() {
    try { return (typeof durum !== 'undefined' && durum) ? durum : null; } catch (e) { return null; }
  }
  function demoMu() {
    var d = durumNesnesi();
    return !!(d && d.ayarlar && d.ayarlar.demoModu);
  }
  function siteAdresi() {
    var d = durumNesnesi();
    var ham = d && d.ayarlar ? String(d.ayarlar.wooUrl || '') : '';
    ham = ham.replace(/\s+/g, '').replace(/\/wp-json.*$/i, '').replace(/\/+$/, '');
    if (ham && !/^https?:\/\//i.test(ham)) ham = 'https://' + ham;
    return ham;
  }
  function uygulamaSurumu() {
    var d = durumNesnesi();
    return d && d.bilgi && d.bilgi.surum ? String(d.bilgi.surum) : '';
  }
  /** Duzenin revizyondan bagimsiz parmak izi (esitleme karsilastirmasi). */
  function duzenImzasi(layout) {
    try { return JSON.stringify(Object.assign({}, layout, { revision: 0, updated_at: '', updated_by: '' })); } catch (e) { return null; }
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* Palet ikonları: registry `icon` → index.html #ik-* sprite adı. Yoksa paket. */
  var BLOK_IKONLARI = {
    'hero-combo': 'panel', 'flash-deals': 'parlak', 'category-pills': 'etiket', 'grid-showcase': 'paket',
    'quick-matrix': 'sepet', 'trust-badges': 'kalkan', slider: 'resim', 'dual-banner': 'resim',
    'strip-banner': 'resim', 'category-grid': 'klasor', 'trust-bar': 'kalkan', 'cta-band': 'bina',
    'category-shelf': 'liste', 'hero-slider': 'resim', 'catalog-cta': 'kure'
  };

  function blokIkonu(tip, registry) {
    var g = registry && registry[tip];
    var ad = String((g && g.icon) || '');
    /* Sunucu verisi: yalnizca guvenli sprite adi kabul edilir (secici/HTML enjeksiyonu olmaz). */
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(ad)) ad = BLOK_IKONLARI[tip] || 'paket';
    return secDeg('#ik-' + ad) ? ad : (BLOK_IKONLARI[tip] || 'paket');
  }

  /** Onizleme / disari acma adresi yalnizca http(s) olabilir (javascript: vb. engellenir). */
  function guvenliOnizlemeUrl(u) {
    u = String(u || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /** Sunucudan gelen sinir degerleri niteliklere ham basilmaz. */
  function sayi(v, varsayilan) {
    var n = parseInt(v, 10);
    return isNaN(n) || n < 0 ? varsayilan : n;
  }

  /* ==========================================================================
   *  1) DURUM
   * ========================================================================*/

  var VE = window.VitrinEditor = {
    acildi: false,
    yukleniyor: false,
    demo: false,
    state: null,               // { layout, history, future, dirty }
    registry: {},
    cache: null,               // son GET yanıtı (layout, registry, preview, revision, site)
    revision: 0,
    preview: { url: '', token: '', origin: '' },
    site: null,
    outbox: null,
    agDurumu: 'online',
    agAyrinti: {},
    onizlemeHazir: false,
    pingZaman: null,
    pingDeneme: 0,
    acikAyar: null,            // ayar formu açık olan blok id
    secili: null,
    uyarilar: [],
    cihaz: 'desktop',
    kategoriler: null,
    tokenKare: 0,
    bekleyenToken: null,
    /* Vitrin içeriği (theme-config > showcase): banner + öne çıkan ürünler. */
    showcase: { banners: [], featured: [], yuklendi: false, kirli: false, kaydediliyor: false, durum: '', hata: '', tekrar: false },
    showcaseZaman: null,
    /* Önizlemenin "içerik yok" dediği bloklar (BYOM_READY / BYOM_APPLIED refresh). */
    bosBloklar: {},
    /* Ürün seçici için ad/kod/görsel önbelleği: id → {ad, kod, gorsel}. */
    urunAdlari: {}
  };

  var UI = {};

  function uiBagla() {
    UI.bolum = secDeg('#sekme-vitrin-editor');
    UI.durum = secDeg('#veDurum');
    UI.yukleBtn = secDeg('#veYukleBtn');
    UI.geriBtn = secDeg('#veGeriAlBtn');
    UI.yineBtn = secDeg('#veYineleBtn');
    UI.sifirlaBtn = secDeg('#veSifirlaBtn');
    UI.yayinlaBtn = secDeg('#veYayinlaBtn');
    UI.uyarilar = secDeg('#veUyarilar');
    UI.liste = secDeg('#veBlokListesi');
    UI.palet = secDeg('#vePalet');
    UI.tokenlar = secDeg('#veTokenlar');
    UI.iframe = secDeg('#vitrinOnizleme');
    UI.cerceve = secDeg('#veOnizlemeKap');
    UI.bos = secDeg('#veOnizlemeBos');
    UI.bosMetin = secDeg('#veOnizlemeBosMetin');
    UI.baglanti = secDeg('#veBaglanti');
    UI.revizyon = secDeg('#veRevizyon');
    UI.cihazlar = secDeg('#veCihazlar');
    UI.olcek = secDeg('#veOlcek');
    UI.yenileBtn = secDeg('#veYenileBtn');
    UI.disariBtn = secDeg('#veDisariBtn');
  }

  /* ==========================================================================
   *  2) DURUM ŞERİDİ / UYARILAR
   * ========================================================================*/

  var DURUM_GORUNUM = {
    online: { metin: 'Çevrimiçi', sinif: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30', nokta: 'text-emerald-500' },
    offline: { metin: 'Çevrimdışı: Düzenlemeler yerel hafızada', sinif: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30', nokta: 'text-amber-500' },
    queued: { metin: 'Kuyrukta yayın bekliyor', sinif: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30', nokta: 'text-amber-500' },
    syncing: { metin: 'Eşitleniyor…', sinif: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30', nokta: 'text-sky-500' },
    conflict: { metin: 'Çakışma: sunucuda daha yeni sürüm', sinif: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30', nokta: 'text-red-500' },
    error: { metin: 'Hata', sinif: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30', nokta: 'text-red-500' }
  };

  function durumCiz() {
    if (!UI.durum) return;
    var ad = VE.agDurumu;
    var g = DURUM_GORUNUM[ad] || DURUM_GORUNUM.online;
    var metin = g.metin;
    var ayr = VE.agAyrinti || {};

    if (ad === 'queued') {
      metin = ayr.offline ? 'Çevrimdışı: Düzenlemeler yerel hafızada · kuyrukta yayın bekliyor (1)' : 'Kuyrukta yayın bekliyor (1)';
      if (ayr.attempts) metin += ' · ' + ayr.attempts + '. deneme';
    } else if (ad === 'error' && ayr.hata) {
      metin = 'Hata: ' + String(ayr.hata).split('\n')[0];
    } else if (ad === 'online' && VE.state && VE.state.dirty) {
      metin = 'Çevrimiçi · yayınlanmamış değişiklikler var';
    }

    UI.durum.className = 'inline-flex items-center gap-2 h-10 px-3 rounded-xl border-2 text-base font-bold ' + g.sinif;
    UI.durum.innerHTML =
      (ad === 'syncing' || (ad === 'queued' && !ayr.offline)
        ? '<span class="donuyor">' + ikn('donen', 'ik-sm') + '</span>'
        : ikn('nokta', 'ik-nokta ' + g.nokta)) +
      '<span>' + kac(metin) + '</span>';

    if (UI.yayinlaBtn) {
      UI.yayinlaBtn.disabled = !VE.state || ad === 'syncing';
      UI.yayinlaBtn.classList.toggle('opacity-60', !VE.state || ad === 'syncing');
    }
  }

  function uyarilariCiz() {
    if (!UI.uyarilar) return;
    var liste = VE.uyarilar || [];
    if (!liste.length) {
      UI.uyarilar.classList.add('hidden');
      UI.uyarilar.innerHTML = '';
      return;
    }
    UI.uyarilar.classList.remove('hidden');
    UI.uyarilar.innerHTML =
      '<details class="rounded-2xl border-2 border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-4 py-3" open>' +
        '<summary class="cursor-pointer text-base font-extrabold text-amber-800 dark:text-amber-300">' +
          ikn('uyari') + ' Sunucu ' + liste.length + ' uyarı bildirdi</summary>' +
        '<ul class="mt-2 flex flex-col gap-1 text-sm text-amber-900 dark:text-amber-200">' +
          liste.map(function (u) {
            return '<li>• ' + kac(u.message || u.code || '') + (u.block_id ? ' <code class="text-xs">(' + kac(u.block_id) + ')</code>' : '') + '</li>';
          }).join('') +
        '</ul></details>';
  }

  function revizyonCiz() {
    if (!UI.revizyon) return;
    var lay = VE.state ? VE.state.layout : null;
    var tarih = lay && lay.updated_at ? (typeof tarihYaz === 'function' ? tarihYaz(lay.updated_at, true) : lay.updated_at) : '—';
    UI.revizyon.innerHTML =
      '<span class="font-extrabold">Sürüm ' + kac(String(VE.revision || 0)) + '</span>' +
      '<span class="text-slate-500 dark:text-slate-400"> · ' + kac(tarih) + '</span>' +
      (VE.state && VE.state.dirty ? '<span class="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 text-xs font-bold">taslak</span>' : '');
  }

  function gecmisButonlari() {
    if (UI.geriBtn) UI.geriBtn.disabled = !VE.state || !VE.state.history.length;
    if (UI.yineBtn) UI.yineBtn.disabled = !VE.state || !VE.state.future.length;
  }

  /* ==========================================================================
   *  3) EYLEM DAĞITICI
   *  Her indirgeyici sonucu: durum güncellenir, taslak yazılır, önizlemeye
   *  mesaj gider, ilgili panel yeniden çizilir.
   * ========================================================================*/

  function dispatch(sonuc, secenek) {
    secenek = secenek || {};
    if (!sonuc || sonuc.state === VE.state) {
      if (sonuc && sonuc.error) hataMesaji(sonuc.error);
      return false;
    }
    VE.state = sonuc.state;
    if (VE.outbox && VE.state.dirty) VE.outbox.saveDraft(VE.state.layout);
    if (sonuc.message) onizlemeyeGonder(sonuc.message);
    if (!secenek.listeyiAtla) listeCiz();
    if (secenek.tokenlariCiz) tokenlariCiz();
    gecmisButonlari();
    revizyonCiz();
    durumCiz();
    return true;
  }

  function hataMesaji(kod) {
    if (kod === 'singleton') uyar('Bu blok sayfada yalnızca bir kez bulunabilir.', 'uyari');
    else if (kod === 'limit') uyar('Sayfada en fazla ' + M.MAX_BLOCKS + ' blok olabilir.', 'uyari');
    else if (kod === 'unknown_type') uyar('Bilinmeyen blok tipi.', 'hata');
  }

  /* ==========================================================================
   *  4) SOL PANEL — BLOK LİSTESİ
   * ========================================================================*/

  function blokEtiketi(tip) {
    var g = VE.registry[tip];
    return g && g.label ? g.label : tip;
  }

  function listeCiz() {
    if (!UI.liste || !VE.state) return;
    var bloklar = VE.state.layout.blocks;

    if (!bloklar.length) {
      UI.liste.innerHTML = '<li class="text-base text-slate-500 dark:text-slate-400 px-3 py-6 text-center border-2 border-dashed rounded-2xl">' +
        'Sayfada blok yok. Aşağıdaki paletten ekleyin.</li>';
      return;
    }

    UI.liste.innerHTML = bloklar.map(function (b, i) {
      var g = VE.registry[b.type] || {};
      var yeniMi = VE.cache && Array.isArray(VE.cache.blokIdleri) && VE.cache.blokIdleri.indexOf(b.id) === -1;
      var ayarVar = (Array.isArray(g.settings) && g.settings.length > 0) || !!bannerSlotu(b) || oneCikanGosterilsinMi(b);
      var bosMu = !!VE.bosBloklar[b.id];
      var acik = VE.acikAyar === b.id;
      return (
        '<li class="ve-row' + (b.enabled ? '' : ' is-off') + (acik ? ' is-open' : '') + (VE.secili === b.id ? ' is-selected' : '') + '" ' +
            'data-ve-row data-id="' + kac(b.id) + '" data-index="' + i + '" tabindex="0" ' +
            'aria-label="' + kac(blokEtiketi(b.type)) + '">' +
          '<div class="ve-row__main">' +
            '<button type="button" class="ve-handle" data-ve-handle title="Sürükleyerek sırala (Alt+↑/↓)" aria-label="Sırala">' + ikn('tutamak') + '</button>' +
            '<span class="ve-row__icon">' + ikn(blokIkonu(b.type, VE.registry)) + '</span>' +
            '<span class="ve-row__label" data-ve-select>' +
              '<span class="ve-row__title">' + kac(blokEtiketi(b.type)) + '</span>' +
              '<span class="ve-row__sub">' + kac(g.description || b.type) + (yeniMi ? ' · <b class="text-amber-600 dark:text-amber-300">yayınla → önizlemede görünür</b>' : '') + '<b class="ve-badge-empty" data-ve-bos title="Önizlemede bu blok için gösterilecek içerik yok"' + (bosMu ? '' : ' hidden') + '> · içerik yok → ⚙ ile ekleyin</b></span>' +
            '</span>' +
            '<button type="button" class="ve-switch" role="switch" aria-checked="' + (b.enabled ? 'true' : 'false') + '" data-ve-toggle title="' + (b.enabled ? 'Kapat' : 'Aç') + '"><span class="ve-switch__knob"></span></button>' +
            (ayarVar ? '<button type="button" class="ve-iconbtn" data-ve-settings title="Ayarlar" aria-expanded="' + (acik ? 'true' : 'false') + '">' + ikn('ayar') + '</button>' : '') +
            '<button type="button" class="ve-iconbtn ve-iconbtn--danger" data-ve-remove title="Sil">' + ikn('cop') + '</button>' +
          '</div>' +
          (acik ? '<div class="ve-row__settings" data-ve-form>' + ayarFormuHtml(b, g) + '</div>' : '') +
        '</li>'
      );
    }).join('');

    if (VE.acikAyar) {
      var form = secDeg('[data-ve-row][data-id="' + cssKac(VE.acikAyar) + '"] [data-ve-form]', UI.liste);
      if (form) ayarFormunuBagla(form, VE.acikAyar);
    }
  }

  function cssKac(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ---------- Ayar formu (registry şemasından) ---------- */

  function ayarFormuHtml(blok, girdi) {
    var alanlar = Array.isArray(girdi.settings) ? girdi.settings : [];
    var html = alanlar.map(function (alan) { return alanHtml(alan, blok.settings[alan.key], blok.type); }).join('');
    /* Görsel ve ürün içeriği: sunucuda çizilir, theme-config'e kaydedilir (bkz. bölüm 12). */
    html += bannerYoneticiHtml(blok) + oneCikanYoneticiHtml(blok);
    if (!html) return '<p class="text-sm text-slate-500">Bu bloğun ayarı yok.</p>';
    return html;
  }

  var INPUT_SINIF = 'w-full h-11 px-3 rounded-xl text-base font-semibold bg-slate-50 dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-600 focus:border-marka-600 focus:ring-4 focus:ring-marka-600/20 outline-none transition';

  function canliRozet(alan) {
    return alan.live
      ? '<span class="ve-live" title="Önizlemede anında uygulanır">canlı</span>'
      : '<span class="ve-stale" title="Yayınlandığında güncellenir">yayınla</span>';
  }

  function alanHtml(alan, deger, tip) {
    var k = kac(alan.key);
    var etiket = '<label class="ve-field__label">' + kac(alan.label || alan.key) + canliRozet(alan) + '</label>';
    var yardim = alan.help ? '<span class="ve-field__help">' + kac(alan.help) + '</span>' : '';
    var govde = '';

    switch (alan.type) {
      case 'text':
        govde = '<input type="text" class="' + INPUT_SINIF + '" data-ve-field="' + k + '" value="' + kac(deger === undefined ? '' : deger) + '" maxlength="' + sayi(alan.max, 200) + '" placeholder="' + kac(alan.placeholder || '') + '" />';
        break;
      case 'textarea':
        govde = '<textarea class="' + INPUT_SINIF + ' h-24 py-2" data-ve-field="' + k + '" maxlength="' + sayi(alan.max, 600) + '">' + kac(deger === undefined ? '' : deger) + '</textarea>';
        break;
      case 'number':
        govde = '<input type="number" class="' + INPUT_SINIF + '" data-ve-field="' + k + '" value="' + kac(deger) + '" min="' + kac(alan.min !== undefined ? alan.min : '') + '" max="' + kac(alan.max !== undefined ? alan.max : '') + '" step="' + kac(alan.step || 1) + '" />';
        break;
      case 'select':
        govde = '<select class="' + INPUT_SINIF + '" data-ve-field="' + k + '">' +
          (alan.options || []).map(function (o) {
            var v = o && o.value !== undefined ? String(o.value) : String(o);
            var l = o && o.label !== undefined ? String(o.label) : v;
            return '<option value="' + kac(v) + '"' + (String(deger) === v ? ' selected' : '') + '>' + kac(l) + '</option>';
          }).join('') + '</select>';
        break;
      case 'toggle':
        govde = '<button type="button" class="ve-switch ve-switch--inline" role="switch" aria-checked="' + (deger ? 'true' : 'false') + '" data-ve-field="' + k + '" data-ve-type="toggle"><span class="ve-switch__knob"></span></button>';
        break;
      case 'color':
        govde = '<div class="flex items-center gap-2"><input type="color" class="ve-color" data-ve-field="' + k + '" data-ve-type="color" value="' + kac(deger || '#000000') + '" />' +
          '<input type="text" class="' + INPUT_SINIF + ' font-mono" data-ve-field="' + k + '" data-ve-type="color-text" value="' + kac(deger || '') + '" maxlength="7" /></div>';
        break;
      case 'datetime':
        govde = '<input type="datetime-local" class="' + INPUT_SINIF + '" data-ve-field="' + k + '" data-ve-type="datetime" value="' + kac(datetimeYerel(deger)) + '" />';
        break;
      case 'product':
        govde = '<div class="ve-product" data-ve-product="' + k + '">' +
          '<div class="flex items-center gap-2">' +
            '<input type="text" class="' + INPUT_SINIF + '" data-ve-product-search placeholder="Ürün ara (ad veya stok kodu)…" autocomplete="off" />' +
            '<button type="button" class="ve-iconbtn" data-ve-product-clear title="Otomatik seçime dön">' + ikn('carpi') + '</button>' +
          '</div>' +
          '<div class="ve-product__secili text-sm mt-1" data-ve-product-label>' + (Number(deger) > 0 ? 'Seçili ürün #' + kac(String(deger)) : 'Otomatik seçim') + '</div>' +
          '<div class="ve-product__sonuc hidden" data-ve-product-results></div>' +
          '<input type="hidden" data-ve-field="' + k + '" data-ve-type="product" value="' + kac(String(deger || 0)) + '" />' +
        '</div>';
        break;
      case 'products':
        govde = urunlerAlaniHtml(alan, deger);
        break;
      case 'category':
        govde = '<select class="' + INPUT_SINIF + '" data-ve-field="' + k + '" data-ve-type="category" data-ve-category>' +
          '<option value="0">Tüm kategoriler</option>' +
          (Number(deger) > 0 ? '<option value="' + kac(String(deger)) + '" selected>Kategori #' + kac(String(deger)) + '</option>' : '') +
          '</select>';
        break;
      case 'items':
        govde = itemsHtml(alan, Array.isArray(deger) ? deger : []);
        break;
      default:
        govde = '<input type="text" class="' + INPUT_SINIF + '" data-ve-field="' + k + '" value="' + kac(deger === undefined ? '' : deger) + '" />';
    }

    return '<div class="ve-field" data-ve-fieldbox="' + k + '">' + etiket + govde + yardim + '</div>';
  }

  function itemsHtml(alan, liste) {
    var max = sayi(alan.max, 6);
    var k = kac(alan.key);
    var alanlar = alan.fields || [];
    return '<div class="ve-items" data-ve-items="' + k + '" data-ve-max="' + max + '">' +
      liste.map(function (oge, i) {
        return '<div class="ve-item" data-ve-item="' + i + '">' +
          '<div class="ve-item__head"><span>' + (i + 1) + '.</span><button type="button" class="ve-iconbtn ve-iconbtn--danger" data-ve-item-remove title="Kaldır">' + ikn('cop', 'ik-sm') + '</button></div>' +
          alanlar.map(function (alt) {
            var d = oge && oge[alt.key] !== undefined ? oge[alt.key] : alt.default;
            if (alt.type === 'select') {
              return '<label class="ve-item__field"><span>' + kac(alt.label || alt.key) + '</span><select class="' + INPUT_SINIF + ' h-10" data-ve-item-field="' + kac(alt.key) + '">' +
                (alt.options || []).map(function (o) {
                  var v = o && o.value !== undefined ? String(o.value) : String(o);
                  return '<option value="' + kac(v) + '"' + (String(d) === v ? ' selected' : '') + '>' + kac(o && o.label !== undefined ? o.label : v) + '</option>';
                }).join('') + '</select></label>';
            }
            return '<label class="ve-item__field"><span>' + kac(alt.label || alt.key) + '</span><input type="text" class="' + INPUT_SINIF + ' h-10" data-ve-item-field="' + kac(alt.key) + '" value="' + kac(d === undefined ? '' : d) + '" maxlength="' + sayi(alt.max, 200) + '" /></label>';
          }).join('') +
        '</div>';
      }).join('') +
      (liste.length < max ? '<button type="button" class="ve-addbtn" data-ve-item-add>' + ikn('arti', 'ik-sm') + ' Öğe ekle</button>' : '') +
    '</div>';
  }

  function datetimeYerel(iso) {
    if (!iso) return '';
    var t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + 'T' + p(t.getHours()) + ':' + p(t.getMinutes());
  }

  function datetimeIso(yerel) {
    if (!yerel) return '';
    var t = new Date(yerel);
    if (isNaN(t.getTime())) return '';
    /* Yerel saat, saat dilimi ofsetiyle (sunucu site saat dilimine göre yorumlar). */
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var ofset = -t.getTimezoneOffset();
    var isaret = ofset >= 0 ? '+' : '-';
    ofset = Math.abs(ofset);
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + 'T' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':00' + isaret + p(Math.floor(ofset / 60)) + ':' + p(ofset % 60);
  }

  /** Bir bloğun ayar formundaki değişiklikleri indirgeyiciye bağlar. */
  function ayarFormunuBagla(form, id) {
    var blok = VE.state.layout.blocks.filter(function (b) { return b.id === id; })[0];
    if (!blok) return;
    var girdi = VE.registry[blok.type] || {};
    var alanlar = {};
    (girdi.settings || []).forEach(function (a) { alanlar[a.key] = a; });

    var uygula = function (anahtar, deger) {
      var kismi = {};
      kismi[anahtar] = deger;
      var degisti = dispatch(M.updateSettings(VE.state, id, kismi, VE.registry), { listeyiAtla: true });
      revizyonCiz();
      /* Kaynak / banner modu değişince banner ya da öne çıkan ürün yöneticisi belirir/kaybolur. */
      if (degisti && (anahtar === 'source' || anahtar === 'deal_source' || anahtar === 'banner_mode')) listeCiz();
    };
    var uygulaGec = debounce(uygula, 90);

    form.addEventListener('input', function (o) {
      var el = o.target;
      var k = el.getAttribute('data-ve-field');
      if (!k) return;
      var tip = el.getAttribute('data-ve-type') || (alanlar[k] && alanlar[k].type);
      if (tip === 'toggle') return;
      if (tip === 'color') {
        var metin = secDeg('[data-ve-field="' + cssKac(k) + '"][data-ve-type="color-text"]', form);
        if (metin) metin.value = el.value.toUpperCase();
        uygulaGec(k, el.value);
      } else if (tip === 'color-text') {
        var hex = M.hexNormalle(el.value);
        if (hex) {
          var renk = secDeg('[data-ve-field="' + cssKac(k) + '"][data-ve-type="color"]', form);
          if (renk) renk.value = hex;
          uygulaGec(k, hex);
        }
      } else if (tip === 'datetime') {
        uygulaGec(k, datetimeIso(el.value));
      } else if (el.tagName === 'SELECT') {
        uygula(k, el.value);
      } else if (el.type === 'number') {
        uygulaGec(k, el.value);
      } else {
        uygulaGec(k, el.value);
      }
    });

    form.addEventListener('change', function (o) {
      var el = o.target;
      var k = el.getAttribute('data-ve-field');
      if (!k) return;
      if (el.tagName === 'SELECT' || el.type === 'number') uygula(k, el.value);
    });

    form.addEventListener('click', function (o) {
      var sw = o.target.closest('[data-ve-type="toggle"]');
      if (sw && form.contains(sw)) {
        var k = sw.getAttribute('data-ve-field');
        var yeni = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', yeni ? 'true' : 'false');
        uygula(k, yeni);
        return;
      }

      var temizle = o.target.closest('[data-ve-product-clear]');
      if (temizle) {
        var kutu = temizle.closest('[data-ve-product]');
        urunSec(kutu, 0, '');
        return;
      }

      var sonuc = o.target.closest('[data-ve-product-pick]');
      if (sonuc) {
        var kutu2 = sonuc.closest('[data-ve-product]');
        urunSec(kutu2, parseInt(sonuc.getAttribute('data-ve-product-pick'), 10) || 0, sonuc.getAttribute('data-ve-product-name') || '');
        return;
      }

      var ekle = o.target.closest('[data-ve-item-add]');
      if (ekle) {
        var kap = ekle.closest('[data-ve-items]');
        var kAd = kap.getAttribute('data-ve-items');
        var mevcut = itemsOku(kap, alanlar[kAd]);
        var bos = {};
        ((alanlar[kAd] && alanlar[kAd].fields) || []).forEach(function (alt) { bos[alt.key] = M.klon(alt.default); });
        mevcut.push(bos);
        uygula(kAd, mevcut);
        listeCiz();
        return;
      }

      var kaldir = o.target.closest('[data-ve-item-remove]');
      if (kaldir) {
        var kap2 = kaldir.closest('[data-ve-items]');
        var kAd2 = kap2.getAttribute('data-ve-items');
        var idx = parseInt(kaldir.closest('[data-ve-item]').getAttribute('data-ve-item'), 10);
        var liste = itemsOku(kap2, alanlar[kAd2]);
        liste.splice(idx, 1);
        uygula(kAd2, liste);
        listeCiz();
      }
    });

    /* Tekrarlayıcı alan girdileri: her tuşta listeyi topla, gönder. */
    var itemsGec = debounce(function (kap, k) { uygula(k, itemsOku(kap, alanlar[k])); }, 120);
    form.addEventListener('input', function (o) {
      var el = o.target;
      if (!el.hasAttribute('data-ve-item-field')) return;
      var kap = el.closest('[data-ve-items]');
      itemsGec(kap, kap.getAttribute('data-ve-items'));
    });

    /* Ürün arama (woo/v3 products?search=). */
    secHep('[data-ve-product-search]', form).forEach(function (girdiEl) {
      var kutu = girdiEl.closest('[data-ve-product]');
      var ara = debounce(function () {
        var q = girdiEl.value.trim();
        var sonucKutu = secDeg('[data-ve-product-results]', kutu);
        if (q.length < 2) { sonucKutu.classList.add('hidden'); sonucKutu.innerHTML = ''; return; }
        if (VE.demo) {
          sonucKutu.classList.remove('hidden');
          sonucKutu.innerHTML = '<div class="ve-product__hint">Demo modunda ürün araması yapılamaz.</div>';
          return;
        }
        sonucKutu.classList.remove('hidden');
        sonucKutu.innerHTML = '<div class="ve-product__hint"><span class="donuyor">' + ikn('donen', 'ik-sm') + '</span> Aranıyor…</div>';
        wooCagir('products', { sorgu: { search: q, per_page: 8, status: 'publish' }, sureAsimi: 15000 }).then(function (cevap) {
          if (!cevap || !cevap.ok) {
            sonucKutu.innerHTML = '<div class="ve-product__hint text-red-600">' + kac((cevap && cevap.hata) || 'Arama başarısız') + '</div>';
            return;
          }
          var urunler = Array.isArray(cevap.veri) ? cevap.veri : [];
          if (!urunler.length) { sonucKutu.innerHTML = '<div class="ve-product__hint">Sonuç yok.</div>'; return; }
          sonucKutu.innerHTML = urunler.map(function (u) {
            return '<button type="button" class="ve-product__pick" data-ve-product-pick="' + kac(String(u.id)) + '" data-ve-product-name="' + kac(u.name || '') + '">' +
              '<span class="font-bold">' + kac(u.name || '') + '</span>' +
              (u.sku ? '<span class="text-xs text-slate-500 font-mono ml-2">' + kac(u.sku) + '</span>' : '') +
            '</button>';
          }).join('');
        });
      }, 300);
      girdiEl.addEventListener('input', ara);
    });

    /* Kategori listesi. */
    secHep('[data-ve-category]', form).forEach(function (sel) {
      kategorileriGetir().then(function (liste) {
        var secili = sel.value;
        sel.innerHTML = '<option value="0">Tüm kategoriler</option>' + liste.map(function (k) {
          return '<option value="' + kac(String(k.id)) + '"' + (String(k.id) === String(secili) ? ' selected' : '') + '>' + kac(k.ad) + '</option>';
        }).join('');
        if (Number(secili) > 0 && !liste.some(function (k) { return String(k.id) === String(secili); })) {
          sel.insertAdjacentHTML('beforeend', '<option value="' + kac(secili) + '" selected>Kategori #' + kac(secili) + '</option>');
        }
      });
    });

    showcaseOlaylariBagla(form);
    urunlerAlaniniBagla(form, uygula);

    function urunSec(kutu, id, ad) {
      var gizli = secDeg('input[data-ve-type="product"]', kutu);
      var etiket = secDeg('[data-ve-product-label]', kutu);
      var sonuc = secDeg('[data-ve-product-results]', kutu);
      var arama = secDeg('[data-ve-product-search]', kutu);
      gizli.value = String(id);
      etiket.textContent = id > 0 ? 'Seçili: ' + (ad || ('#' + id)) : 'Otomatik seçim';
      sonuc.classList.add('hidden');
      sonuc.innerHTML = '';
      if (arama) arama.value = '';
      uygula(gizli.getAttribute('data-ve-field'), id);
    }
  }

  /* ---------- Çoklu ürün seçici (type: products) ----------
   * Bloğun KENDİ listesi: kaynak "Seçtiğim ürünler" iken sitede yalnızca bu
   * ürünler basılır (başka bloğun ürünü kopyalanmaz). Değişiklik BYOM_SETTINGS
   * ile önizlemeye gider; dinleyici bloğu sunucuda yeniden çizer. */

  function urunlerAlaniHtml(alan, deger) {
    var k = kac(alan.key);
    var ids = urunIdleriTemizle(deger, sayi(alan.max, 24));
    return '<div class="ve-products" data-ve-products="' + k + '" data-ve-max="' + sayi(alan.max, 24) + '">' +
      '<input type="hidden" data-ve-field="' + k + '" data-ve-type="products" value="' + kac(JSON.stringify(ids)) + '" />' +
      '<div class="ve-product">' +
        '<input type="text" class="' + INPUT_SINIF + '" data-ve-products-search placeholder="Ürün ara ve listeye ekle (ad / stok kodu)…" autocomplete="off" />' +
        '<div class="ve-product__sonuc hidden" data-ve-products-results></div>' +
      '</div>' +
      '<div class="ve-featured-list" data-ve-products-list>' + urunlerListesiHtml(ids) + '</div>' +
    '</div>';
  }

  function urunIdleriTemizle(deger, max) {
    var kaynak = deger;
    if (typeof kaynak === 'string') { try { kaynak = JSON.parse(kaynak); } catch (e) { kaynak = kaynak.split(','); } }
    if (!Array.isArray(kaynak)) return [];
    var gorulen = {};
    var out = [];
    kaynak.forEach(function (v) {
      if (v && typeof v === 'object') v = v.id;
      var id = parseInt(v, 10);
      if (id > 0 && !gorulen[id] && out.length < max) { gorulen[id] = true; out.push(id); }
    });
    return out;
  }

  function urunlerListesiHtml(ids) {
    if (!ids.length) {
      return '<div class="ve-banner-list__bos">Henüz ürün seçilmedi; aramadan ekleyin. Kaynak “Seçtiğim ürünler” iken sitede yalnızca bu liste basılır.</div>';
    }
    return ids.map(function (id, i) {
      var u = VE.urunAdlari[id] || {};
      return '<div class="ve-featured__row" data-ve-products-row="' + i + '">' +
        (u.gorsel ? '<img class="ve-featured__img" src="' + kac(u.gorsel) + '" alt="" />' : '<span class="ve-featured__img ve-featured__img--bos">' + ikn('paket', 'ik-sm') + '</span>') +
        '<span class="ve-featured__body"><b>' + kac(u.ad || ('Ürün #' + id)) + '</b><small class="font-mono">' + kac(u.kod || ('#' + id)) + '</small></span>' +
        '<span class="ve-banner__actions">' +
          '<button type="button" class="ve-iconbtn" data-ve-products-yukari title="Yukarı">' + ikn('yukariOk', 'ik-sm') + '</button>' +
          '<button type="button" class="ve-iconbtn" data-ve-products-asagi title="Aşağı">' + ikn('asagiOk', 'ik-sm') + '</button>' +
          '<button type="button" class="ve-iconbtn ve-iconbtn--danger" data-ve-products-sil title="Listeden çıkar">' + ikn('cop', 'ik-sm') + '</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  /** Bilinmeyen kimliklerin adlarını doldurur (önce hafızadaki ürün listesi, sonra site). */
  function urunAdlariniGetir(ids) {
    var d = durumNesnesi();
    var eksik = [];
    ids.forEach(function (id) {
      if (VE.urunAdlari[id]) return;
      var k = d && Array.isArray(d.urunler) ? d.urunler.filter(function (x) { return Number(x.id) === Number(id); })[0] : null;
      if (k) VE.urunAdlari[id] = { ad: k.ad || '', kod: k.kod || '', gorsel: guvenliGorselUrl(k.gorsel) };
      else eksik.push(id);
    });
    if (!eksik.length || VE.demo) return Promise.resolve();
    return wooCagir('products', { sorgu: { include: eksik.join(','), per_page: 100 }, sureAsimi: 20000 }).then(function (c) {
      if (!c || !c.ok || !Array.isArray(c.veri)) return;
      c.veri.forEach(function (u) {
        VE.urunAdlari[Number(u.id)] = { ad: u.name || '', kod: u.sku || '', gorsel: guvenliGorselUrl(u.images && u.images[0] && u.images[0].src) };
      });
    }).catch(function () { /* ad tamamlama isteğe bağlı */ });
  }

  function urunlerAlaniniBagla(form, uygula) {
    secHep('[data-ve-products]', form).forEach(function (kutu) {
      var k = kutu.getAttribute('data-ve-products');
      var max = parseInt(kutu.getAttribute('data-ve-max'), 10) || 24;
      var gizli = secDeg('input[data-ve-type="products"]', kutu);
      var liste = secDeg('[data-ve-products-list]', kutu);
      var arama = secDeg('[data-ve-products-search]', kutu);
      var sonuc = secDeg('[data-ve-products-results]', kutu);

      var oku = function () { return urunIdleriTemizle(gizli.value, max); };
      var yaz = function (ids) {
        gizli.value = JSON.stringify(ids);
        liste.innerHTML = urunlerListesiHtml(ids);
        uygula(k, ids);
      };

      urunAdlariniGetir(oku()).then(function () { if (document.body.contains(liste)) liste.innerHTML = urunlerListesiHtml(oku()); });

      var ara = debounce(function () {
        var q = arama.value.trim();
        if (q.length < 2) { sonuc.classList.add('hidden'); sonuc.innerHTML = ''; return; }
        sonuc.classList.remove('hidden');
        if (VE.demo) {
          var d = durumNesnesi();
          var yerel = (d && Array.isArray(d.urunler) ? d.urunler : []).filter(function (u) {
            var m = q.toLocaleLowerCase('tr-TR');
            return String(u.ad || '').toLocaleLowerCase('tr-TR').indexOf(m) !== -1 || String(u.kod || '').toLocaleLowerCase('tr-TR').indexOf(m) !== -1;
          }).slice(0, 8);
          sonuc.innerHTML = yerel.length
            ? yerel.map(function (u) { return urunSonucHtml(u.id, u.ad, u.kod, u.gorsel); }).join('')
            : '<div class="ve-product__hint">Demo verisinde sonuç yok.</div>';
          return;
        }
        sonuc.innerHTML = '<div class="ve-product__hint"><span class="donuyor">' + ikn('donen', 'ik-sm') + '</span> Aranıyor…</div>';
        wooCagir('products', { sorgu: { search: q, per_page: 8, status: 'publish' }, sureAsimi: 15000 }).then(function (c) {
          if (!c || !c.ok) { sonuc.innerHTML = '<div class="ve-product__hint text-red-600">' + kac((c && c.hata) || 'Arama başarısız') + '</div>'; return; }
          var secili = {};
          oku().forEach(function (id) { secili[id] = true; });
          var urunler = (Array.isArray(c.veri) ? c.veri : []).filter(function (u) { return !secili[u.id]; });
          if (!urunler.length) { sonuc.innerHTML = '<div class="ve-product__hint">Sonuç yok (ya da hepsi listede).</div>'; return; }
          sonuc.innerHTML = urunler.map(function (u) { return urunSonucHtml(u.id, u.name, u.sku, u.images && u.images[0] && u.images[0].src); }).join('');
        });
      }, 300);
      arama.addEventListener('input', ara);

      kutu.addEventListener('click', function (o) {
        var ekle = o.target.closest('[data-ve-products-ekle]');
        if (ekle) {
          var id = parseInt(ekle.getAttribute('data-ve-products-ekle'), 10);
          var ids = oku();
          if (id > 0 && ids.indexOf(id) === -1) {
            if (ids.length >= max) { uyar('En fazla ' + max + ' ürün seçilebilir.', 'uyari'); return; }
            VE.urunAdlari[id] = { ad: ekle.getAttribute('data-ad') || '', kod: ekle.getAttribute('data-kod') || '', gorsel: ekle.getAttribute('data-gorsel') || '' };
            ids.push(id);
            yaz(ids);
          }
          sonuc.classList.add('hidden');
          sonuc.innerHTML = '';
          arama.value = '';
          return;
        }
        var satir = o.target.closest('[data-ve-products-row]');
        if (!satir) return;
        var i = parseInt(satir.getAttribute('data-ve-products-row'), 10);
        var liste2 = oku();
        if (o.target.closest('[data-ve-products-sil]')) {
          liste2.splice(i, 1);
        } else if (o.target.closest('[data-ve-products-yukari]') && i > 0) {
          var t = liste2[i - 1]; liste2[i - 1] = liste2[i]; liste2[i] = t;
        } else if (o.target.closest('[data-ve-products-asagi]') && i < liste2.length - 1) {
          var t2 = liste2[i + 1]; liste2[i + 1] = liste2[i]; liste2[i] = t2;
        } else {
          return;
        }
        yaz(liste2);
      });
    });
  }

  function urunSonucHtml(id, ad, kod, gorsel) {
    return '<button type="button" class="ve-product__pick" data-ve-products-ekle="' + kac(String(id)) + '" data-ad="' + kac(ad || '') + '" data-kod="' + kac(kod || '') + '" data-gorsel="' + kac(guvenliGorselUrl(gorsel)) + '">' +
      '<span class="font-bold">' + kac(ad || '') + '</span>' + (kod ? '<span class="text-xs text-slate-500 font-mono ml-2">' + kac(kod) + '</span>' : '') +
    '</button>';
  }

  function itemsOku(kap, alan) {
    var alanlar = (alan && alan.fields) || [];
    return secHep('[data-ve-item]', kap).map(function (oge) {
      var out = {};
      alanlar.forEach(function (alt) {
        var el = secDeg('[data-ve-item-field="' + cssKac(alt.key) + '"]', oge);
        out[alt.key] = el ? el.value : alt.default;
      });
      return out;
    });
  }

  function kategorileriGetir() {
    if (VE.kategoriler) return Promise.resolve(VE.kategoriler);
    if (VE.demo) { VE.kategoriler = []; return Promise.resolve(VE.kategoriler); }
    var p;
    if (typeof tumKategorileriGetir === 'function') {
      p = tumKategorileriGetir().then(function (c) { return c && c.ok ? c.kategoriler : []; });
    } else {
      p = wooCagir('products/categories', { sorgu: { per_page: 100, orderby: 'name', order: 'asc' } }).then(function (c) {
        return c && c.ok && Array.isArray(c.veri) ? c.veri.map(function (k) { return { id: k.id, ad: k.name }; }) : [];
      });
    }
    return p.then(function (liste) { VE.kategoriler = liste; return liste; }).catch(function () { return []; });
  }

  /* ---------- Liste olayları (aç/kapat, sil, ayar, seç, klavye) ---------- */

  function listeOlaylariniBagla() {
    UI.liste.addEventListener('click', function (o) {
      var satir = o.target.closest('[data-ve-row]');
      if (!satir) return;
      var id = satir.getAttribute('data-id');

      if (o.target.closest('[data-ve-toggle]')) {
        dispatch(M.toggle(VE.state, id));
        return;
      }
      if (o.target.closest('[data-ve-remove]')) {
        var blok = VE.state.layout.blocks.filter(function (b) { return b.id === id; })[0];
        sor('Blok silinsin mi?', '"' + blokEtiketi(blok ? blok.type : id) + '" bloğu sayfadan kaldırılacak. Yayınlayana kadar geri alabilirsiniz (Ctrl+Z).', 'SİL', true)
          .then(function (evet) {
            if (!evet) return;
            if (VE.acikAyar === id) VE.acikAyar = null;
            dispatch(M.remove(VE.state, id));
          });
        return;
      }
      if (o.target.closest('[data-ve-settings]')) {
        VE.acikAyar = VE.acikAyar === id ? null : id;
        VE.secili = id;
        listeCiz();
        onizlemeyeGonder(M.mesaj('BYOM_SELECT', { id: id }));
        return;
      }
      if (o.target.closest('[data-ve-select]')) {
        VE.secili = id;
        secHep('[data-ve-row]', UI.liste).forEach(function (r) { r.classList.toggle('is-selected', r.getAttribute('data-id') === id); });
        onizlemeyeGonder(M.mesaj('BYOM_SELECT', { id: id }));
      }
    });

    UI.liste.addEventListener('keydown', function (o) {
      var satir = o.target.closest('[data-ve-row]');
      if (!satir || o.target !== satir) return;
      var id = satir.getAttribute('data-id');
      var idx = parseInt(satir.getAttribute('data-index'), 10);
      if (o.altKey && (o.key === 'ArrowUp' || o.key === 'ArrowDown')) {
        o.preventDefault();
        var hedef = o.key === 'ArrowUp' ? idx - 1 : idx + 1;
        if (dispatch(M.move(VE.state, id, hedef))) {
          var yeni = secDeg('[data-ve-row][data-id="' + cssKac(id) + '"]', UI.liste);
          if (yeni) yeni.focus();
        }
      } else if (o.key === 'Delete') {
        o.preventDefault();
        dispatch(M.remove(VE.state, id));
      } else if (o.key === ' ') {
        o.preventDefault();
        dispatch(M.toggle(VE.state, id));
      }
    });

    surukleBagla(UI.liste);
  }

  /* ---------- Sürükle-bırak: pointer + transform (layout thrash yok) ---------- */

  function surukleBagla(liste) {
    liste.addEventListener('pointerdown', function (e) {
      var tutamak = e.target.closest('[data-ve-handle]');
      if (!tutamak || (e.button !== undefined && e.button !== 0)) return;
      var satir = tutamak.closest('[data-ve-row]');
      if (!satir) return;

      e.preventDefault();
      try { tutamak.setPointerCapture(e.pointerId); } catch (err) { /* jsdom */ }

      var satirlar = secHep('[data-ve-row]', liste);
      var rects = satirlar.map(function (r) { return r.getBoundingClientRect(); });
      var baslangic = satirlar.indexOf(satir);
      var id = satir.getAttribute('data-id');
      var yBaslangic = e.clientY;
      var aralik = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 8;
      var yukseklik = rects[baslangic].height + aralik;
      var hedef = baslangic;
      var kare = 0;
      var sonY = yBaslangic;
      var iptal = false;

      /* Hayalet: satırın kopyası, sabit konumda, yalnızca transform ile oynar. */
      var hayalet = satir.cloneNode(true);
      hayalet.classList.add('ve-ghost');
      hayalet.style.width = rects[baslangic].width + 'px';
      hayalet.style.left = rects[baslangic].left + 'px';
      hayalet.style.top = rects[baslangic].top + 'px';
      document.body.appendChild(hayalet);

      satir.classList.add('ve-lifting');
      liste.classList.add('is-dragging');
      satirlar.forEach(function (r) { r.style.willChange = 'transform'; });

      var gosterge = document.createElement('div');
      gosterge.className = 've-dropline';
      liste.appendChild(gosterge);

      /* Bırakma çizgisi: hedef = işaretçinin üstünde kalan (sürüklenen hariç) satır sayısı.
         hedef > baslangic ise sayılan son satırın indeksi hedef'tir (sürüklenen satır
         atlandığı için), aksi hâlde hedef-1. */
      function gostergeGuncelle() {
        var listeRect = liste.getBoundingClientRect();
        var y;
        if (hedef <= 0) {
          y = rects[0].top - aralik / 2;
        } else {
          var son = hedef > baslangic ? hedef : hedef - 1;
          son = Math.max(0, Math.min(rects.length - 1, son));
          y = rects[son].bottom + aralik / 2;
        }
        gosterge.style.transform = 'translate3d(0,' + (y - listeRect.top + liste.scrollTop) + 'px,0)';
      }

      function kaydir() {
        satirlar.forEach(function (r, i) {
          if (i === baslangic) return;
          var kay = 0;
          if (i < baslangic && i >= hedef) kay = yukseklik;
          else if (i > baslangic && i <= hedef) kay = -yukseklik;
          r.style.transform = kay ? 'translate3d(0,' + kay + 'px,0)' : '';
        });
        gostergeGuncelle();
      }

      function guncelle() {
        kare = 0;
        hayalet.style.transform = 'translate3d(0,' + (sonY - yBaslangic) + 'px,0) scale(1.02)';
        var sayac = 0;
        rects.forEach(function (rc, i) {
          if (i === baslangic) return;
          if (rc.top + rc.height / 2 < sonY) sayac++;
        });
        if (sayac !== hedef) { hedef = sayac; kaydir(); }
      }

      function onMove(ev) {
        sonY = ev.clientY;
        if (!kare) kare = requestAnimationFrame(guncelle);
      }

      function temizle() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('keydown', onKey);
        if (kare) cancelAnimationFrame(kare);
        try { tutamak.releasePointerCapture(e.pointerId); } catch (err) { /* önemsiz */ }
        if (hayalet.parentNode) hayalet.parentNode.removeChild(hayalet);
        if (gosterge.parentNode) gosterge.parentNode.removeChild(gosterge);
        satirlar.forEach(function (r) { r.style.transform = ''; r.style.willChange = ''; });
        satir.classList.remove('ve-lifting');
        liste.classList.remove('is-dragging');
      }

      function onUp() {
        temizle();
        if (!iptal && hedef !== baslangic) {
          dispatch(M.move(VE.state, id, hedef));
        }
      }

      function onCancel() { iptal = true; temizle(); }
      function onKey(ev) { if (ev.key === 'Escape') onCancel(); }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      document.addEventListener('keydown', onKey);
      gostergeGuncelle();
    });
  }

  /* ==========================================================================
   *  5) SOL PANEL — PALET
   * ========================================================================*/

  function paletCiz() {
    if (!UI.palet) return;
    var tipler = Object.keys(VE.registry);
    if (!tipler.length) { UI.palet.innerHTML = '<p class="text-sm text-slate-500">Blok kayıt defteri alınamadı.</p>'; return; }

    var gruplar = { lego: [], classic: [] };
    tipler.forEach(function (t) { (gruplar[VE.registry[t].group === 'classic' ? 'classic' : 'lego']).push(t); });

    var mevcut = {};
    if (VE.state) VE.state.layout.blocks.forEach(function (b) { mevcut[b.type] = true; });

    var grupHtml = function (baslik, liste) {
      if (!liste.length) return '';
      return '<div class="ve-palette__group"><div class="ve-palette__title">' + kac(baslik) + '</div><div class="ve-palette__grid">' +
        liste.map(function (t) {
          var g = VE.registry[t];
          var kapali = g.singleton && mevcut[t];
          return '<button type="button" class="ve-chip" data-ve-add="' + kac(t) + '"' + (kapali ? ' disabled title="Sayfada zaten var (tekil blok)"' : ' title="' + kac(g.description || '') + '"') + '>' +
            ikn(blokIkonu(t, VE.registry)) + '<span>' + kac(g.label || t) + '</span></button>';
        }).join('') + '</div></div>';
    };

    UI.palet.innerHTML = grupHtml('Lego blokları', gruplar.lego) + grupHtml('Klasik bölümler', gruplar.classic);
  }

  function paletOlaylari() {
    UI.palet.addEventListener('click', function (o) {
      var btn = o.target.closest('[data-ve-add]');
      if (!btn || btn.disabled) return;
      var tip = btn.getAttribute('data-ve-add');
      var sonuc = M.add(VE.state, tip, VE.registry);
      if (dispatch(sonuc)) {
        paletCiz();
        VE.secili = sonuc.block.id;
        uyar('"' + blokEtiketi(tip) + '" eklendi. Sunucu çizimi gerektirdiği için önizlemede YAYINLA sonrasında görünür.', 'bilgi');
        var yeni = secDeg('[data-ve-row][data-id="' + cssKac(sonuc.block.id) + '"]', UI.liste);
        if (yeni) { yeni.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); yeni.classList.add('is-new'); }
      }
    });
  }

  /* ==========================================================================
   *  6) SOL PANEL — RENK & STİL
   * ========================================================================*/

  var TOKEN_ALANLARI = [
    ['primary', 'Ana renk'], ['accent', 'Vurgu rengi'], ['bg', 'Sayfa zemini'],
    ['surface', 'Kart yüzeyi'], ['border', 'Kenarlık'], ['text_main', 'Metin']
  ];

  function tokenlariCiz() {
    if (!UI.tokenlar || !VE.state) return;
    var t = VE.state.layout.tokens;
    var etkin = t.mode === 'custom' ? t : (VE.cache && VE.cache.tokens_effective ? Object.assign({}, t, VE.cache.tokens_effective) : t);

    UI.tokenlar.innerHTML =
      '<div class="ve-mode">' +
        '<button type="button" class="ve-mode__btn' + (t.mode !== 'custom' ? ' is-on' : '') + '" data-ve-mode="inherit">Temanın renkleri</button>' +
        '<button type="button" class="ve-mode__btn' + (t.mode === 'custom' ? ' is-on' : '') + '" data-ve-mode="custom">Özel</button>' +
      '</div>' +
      '<div class="ve-swatches">' +
        TOKEN_ALANLARI.map(function (a) {
          var v = M.hexNormalle(etkin[a[0]]) || '#000000';
          return '<label class="ve-swatch" data-ve-token="' + a[0] + '">' +
            '<span class="ve-swatch__chip" style="background:' + kac(v) + ';color:' + M.kontrast(v) + '">' + ikn('kalem', 'ik-sm') + '</span>' +
            '<span class="ve-swatch__body"><span class="ve-swatch__name">' + kac(a[1]) + '</span>' +
              '<input type="text" class="ve-swatch__hex" data-ve-token-text="' + a[0] + '" value="' + kac(v) + '" maxlength="7" spellcheck="false" /></span>' +
            '<input type="color" class="ve-swatch__picker" data-ve-token-color="' + a[0] + '" value="' + kac(v) + '" />' +
          '</label>';
        }).join('') +
      '</div>' +
      '<div class="ve-radius">' +
        '<div class="flex items-center justify-between"><span class="ve-field__label">Köşe yuvarlaklığı</span><span class="font-mono font-bold" data-ve-radius-label>' + kac(String(etkin.radius)) + 'px</span></div>' +
        '<input type="range" min="0" max="32" step="1" value="' + kac(String(etkin.radius)) + '" data-ve-radius class="w-full" />' +
        '<div class="ve-radius__preview" style="border-radius:' + kac(String(etkin.radius)) + 'px"></div>' +
      '</div>';
  }

  function tokenGonderPlanla() {
    if (VE.tokenKare) return;
    VE.tokenKare = requestAnimationFrame(function () {
      VE.tokenKare = 0;
      if (VE.bekleyenToken) {
        var kismi = VE.bekleyenToken;
        VE.bekleyenToken = null;
        dispatch(M.setTokens(VE.state, kismi), { listeyiAtla: true });
      }
    });
  }

  function tokenDegis(kismi) {
    VE.bekleyenToken = Object.assign({}, VE.bekleyenToken || {}, kismi, { mode: 'custom' });
    tokenGonderPlanla();
  }

  function tokenOlaylari() {
    UI.tokenlar.addEventListener('input', function (o) {
      var el = o.target;
      var k = el.getAttribute('data-ve-token-color');
      if (k) {
        var hex = el.value.toUpperCase();
        var metin = secDeg('[data-ve-token-text="' + k + '"]', UI.tokenlar);
        var chip = secDeg('[data-ve-token="' + k + '"] .ve-swatch__chip', UI.tokenlar);
        if (metin) metin.value = hex;
        if (chip) { chip.style.background = hex; chip.style.color = M.kontrast(hex); }
        var kismi = {}; kismi[k] = hex;
        tokenDegis(kismi);
        return;
      }
      k = el.getAttribute('data-ve-token-text');
      if (k) {
        var h = M.hexNormalle(el.value);
        if (!h) return;
        var renk = secDeg('[data-ve-token-color="' + k + '"]', UI.tokenlar);
        var chip2 = secDeg('[data-ve-token="' + k + '"] .ve-swatch__chip', UI.tokenlar);
        if (renk) renk.value = h;
        if (chip2) { chip2.style.background = h; chip2.style.color = M.kontrast(h); }
        var kismi2 = {}; kismi2[k] = h;
        tokenDegis(kismi2);
        return;
      }
      if (el.hasAttribute('data-ve-radius')) {
        var r = parseInt(el.value, 10) || 0;
        var etiket = secDeg('[data-ve-radius-label]', UI.tokenlar);
        var on = secDeg('.ve-radius__preview', UI.tokenlar);
        if (etiket) etiket.textContent = r + 'px';
        if (on) on.style.borderRadius = r + 'px';
        tokenDegis({ radius: r });
      }
    });

    UI.tokenlar.addEventListener('click', function (o) {
      var btn = o.target.closest('[data-ve-mode]');
      if (!btn) return;
      var mod = btn.getAttribute('data-ve-mode');
      if (mod === 'inherit') {
        /* Temaya dön: token'ları sitenin etkin renkleriyle eşitle ki kaydırıcılar sıçramasın. */
        var kismi = { mode: 'inherit' };
        if (VE.cache && VE.cache.tokens_effective) {
          TOKEN_ALANLARI.forEach(function (a) { if (VE.cache.tokens_effective[a[0]]) kismi[a[0]] = VE.cache.tokens_effective[a[0]]; });
          if (VE.cache.tokens_effective.radius !== undefined) kismi.radius = VE.cache.tokens_effective.radius;
        }
        dispatch(M.setTokens(VE.state, kismi), { listeyiAtla: true, tokenlariCiz: true });
      } else {
        dispatch(M.setTokensMode(VE.state, 'custom'), { listeyiAtla: true, tokenlariCiz: true });
      }
    });
  }

  /* ==========================================================================
   *  7) SAĞ PANEL — CANLI ÖNİZLEME KÖPRÜSÜ
   * ========================================================================*/

  function onizlemeyeGonder(msg) {
    if (!msg || !UI.iframe || !VE.preview.url) return false;
    var pencere = UI.iframe.contentWindow;
    if (!pencere) return false;
    var zarf = Object.assign({}, msg, { token: VE.preview.token });
    try {
      pencere.postMessage(zarf, VE.preview.origin || '*');
      return true;
    } catch (e) {
      return false;
    }
  }

  function onizlemeYukle() {
    if (!UI.iframe) return;
    VE.onizlemeHazir = false;
    baglantiCiz();

    if (VE.demo || !VE.preview.url) {
      UI.cerceve.classList.add('hidden');
      UI.cerceve.hidden = true;
      UI.bos.classList.remove('hidden');
      UI.bos.hidden = false;
      if (UI.bosMetin) {
        UI.bosMetin.textContent = VE.demo
          ? 'Demo modunda canlı önizleme yok. Gerçek siteniz için Ayarlar sekmesinden bağlantı kurun.'
          : 'Önizleme adresi alınamadı. Siteden yeniden yükleyin.';
      }
      return;
    }

    UI.bos.classList.add('hidden');
    UI.bos.hidden = true;
    UI.cerceve.classList.remove('hidden');
    UI.cerceve.hidden = false;
    onizlemeOlcekle();

    try { VE.preview.origin = new URL(VE.preview.url).origin; } catch (e) { VE.preview.origin = '*'; }

    if (UI.iframe.getAttribute('src') !== VE.preview.url) {
      UI.iframe.setAttribute('src', VE.preview.url);
    } else {
      try { UI.iframe.contentWindow.location.reload(); } catch (e) { UI.iframe.setAttribute('src', VE.preview.url); }
    }
  }

  function pingBaslat() {
    pingDurdur();
    VE.pingDeneme = 0;
    var vur = function () {
      if (VE.onizlemeHazir || VE.pingDeneme >= 40) { pingDurdur(); return; }
      VE.pingDeneme++;
      onizlemeyeGonder(M.mesaj('BYOM_PING', {}));
      VE.pingZaman = setTimeout(vur, 500);
    };
    vur();
  }

  function pingDurdur() {
    if (VE.pingZaman) { clearTimeout(VE.pingZaman); VE.pingZaman = null; }
  }

  function baglantiCiz() {
    if (!UI.baglanti) return;
    UI.baglanti.className = 'inline-flex items-center gap-2 text-sm font-bold ' + (VE.onizlemeHazir ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400');
    UI.baglanti.innerHTML = ikn('nokta', 'ik-nokta') + '<span>' + (VE.onizlemeHazir ? 'Önizleme bağlı' : 'Önizleme bekleniyor') + '</span>';
  }

  function onizlemeMesaji(e) {
    var veri = e && e.data;
    if (!veri || typeof veri !== 'object' || veri.source !== 'byom-preview') return;
    if (UI.iframe && e.source && UI.iframe.contentWindow && e.source !== UI.iframe.contentWindow) return;

    if (veri.type === 'BYOM_EDIT_REQUEST') {
      duzenlemeIstegi(veri.payload && veri.payload.id);
      return;
    }

    if (veri.type === 'BYOM_READY') {
      VE.onizlemeHazir = true;
      pingDurdur();
      baglantiCiz();
      /* Önizlemenin bildirdiği boş bloklar listede rozetlenir. */
      VE.bosBloklar = {};
      ((veri.payload && veri.payload.blocks) || []).forEach(function (b) { if (b && b.empty) VE.bosBloklar[String(b.id)] = true; });
      listeCiz();
      /* Yeniden yüklenen çerçeve taslağı bilmez: tam senkron gönder. */
      if (VE.state) onizlemeyeGonder(M.mesaj('BYOM_LAYOUT', { layout: M.klon(VE.state.layout) }));
      if (VE.secili) onizlemeyeGonder(M.mesaj('BYOM_SELECT', { id: VE.secili }));
    } else if (veri.type === 'BYOM_APPLIED') {
      /* Sunucuda yeniden çizilen blok: "içerik yok" rozeti yerinde güncellenir (form yeniden çizilmez, odak kaybolmaz). */
      var p = veri.payload || {};
      if (p.what === 'refresh' && p.id) {
        var bosId = String(p.id);
        if (p.empty) VE.bosBloklar[bosId] = true; else delete VE.bosBloklar[bosId];
        var rozet = secDeg('[data-ve-row][data-id="' + cssKac(bosId) + '"] [data-ve-bos]', UI.liste);
        if (rozet) rozet.hidden = !p.empty;
      }
    } else if (veri.type === 'BYOM_ERROR') {
      console.warn('[Vitrin Editörü] önizleme:', veri.payload && veri.payload.message);
    }
  }

  /* Cihaz genislikleri: iframe bu genislikte CIZILIR; konteyner darsa scale ile kucultulur. */
  var CIHAZ_GENISLIK = { desktop: 1280, tablet: 820, mobile: 390 };

  function cihazSec(ad) {
    VE.cihaz = CIHAZ_GENISLIK[ad] ? ad : 'desktop';
    if (UI.cerceve) {
      UI.cerceve.classList.remove('ve-frame--desktop', 've-frame--tablet', 've-frame--mobile');
      UI.cerceve.classList.add('ve-frame--' + VE.cihaz);
    }
    if (UI.cihazlar) {
      secHep('[data-ve-device]', UI.cihazlar).forEach(function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-ve-device') === VE.cihaz);
      });
    }
    onizlemeOlcekle();
  }

  /**
   * Onizlemeyi konteynere sigdirir.
   *
   * iframe her zaman cihaz genisliginde (masaustu 1280px) cizilir; konteyner
   * daha darsa transform: scale(k) ile kucultulur ve yatayda ortalanir.
   * Site boylece gercek masaustu kirilma noktalarinda kalir (mobil alt cubuk
   * masaustu onizlemesinde gorunmez). Yukseklik k'ya bolunerek verilir ki
   * olceklenmis iframe konteynerin tamamini doldursun.
   */
  function onizlemeOlcekle() {
    var kap = UI.cerceve, fr = UI.iframe;
    if (!kap || !fr) return;
    var kapW = kap.clientWidth, kapH = kap.clientHeight;
    if (!kapW || !kapH) return;

    var w = CIHAZ_GENISLIK[VE.cihaz] || 1280;
    var k = Math.min(1, kapW / w);
    var h = Math.round(kapH / k);
    var ofset = Math.max(0, Math.round((kapW - w * k) / 2));

    fr.style.width = w + 'px';
    fr.style.height = h + 'px';
    fr.style.transform = 'translate3d(' + ofset + 'px,0,0) scale(' + k.toFixed(4) + ')';
    kap.setAttribute('data-olcek', k.toFixed(3));

    if (UI.olcek) {
      UI.olcek.textContent = '%' + Math.round(k * 100) + ' · ' + w + 'px';
      UI.olcek.hidden = false;
    }
  }

  function olcekDinleyiciBagla() {
    if (!UI.cerceve) return;
    var planla = (function () {
      var t = 0;
      return function () {
        if (t) return;
        t = requestAnimationFrame(function () { t = 0; onizlemeOlcekle(); });
      };
    })();
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(planla).observe(UI.cerceve); } catch (e) { /* eski motor */ }
    }
    window.addEventListener('resize', planla);
    /* Sekme acilinca konteyner olculebilir hale gelir; ilk olcum orada. */
    document.addEventListener('visibilitychange', planla);
  }

  /* ==========================================================================
   *  8) VERİ AKIŞI — YÜKLE / YAYINLA / SIFIRLA
   * ========================================================================*/

  function storefrontIstek(secenek) {
    /* Önce wc-byom/v1 (WooCommerce anahtar doğrulaması garantili), sonra byom/v1. */
    return apiCagir('wc-byom/v1', 'storefront-layout', secenek).then(function (cevap) {
      if (cevap && cevap.ok) return cevap;
      var kod = String((cevap && cevap.kod) || '');
      var d = Number(cevap && cevap.durum) || 0;
      if (kod === 'rest_no_route' || d === 404 || d === 401 || d === 403) {
        return apiCagir('byom/v1', 'storefront-layout', secenek).then(function (c2) {
          if (c2 && c2.ok) return c2;
          /* İkisi de yoksa ilk yanıtı döndür ama eklenti eksik ipucunu ekle. */
          var son = (c2 && c2.durum) ? c2 : cevap;
          if (String((c2 && c2.kod) || '') === 'rest_no_route' && kod === 'rest_no_route') {
            son = Object.assign({}, son, { eklentiEski: true, hata: 'Sitede "storefront-layout" ucu bulunamadı.\nB2B Core eklentisini 2.4.0 veya üstüne güncelleyin.' });
          }
          return son;
        });
      }
      return cevap;
    });
  }

  function yanitiUygula(veri) {
    /* Yanitta eksik olan parcalar (registry / onizleme / site) ELDEKI degerlerle
       korunur: asgari bir PUT yaniti bloklari demo registry'ye dusurmemeli. */
    if (veri.registry && Object.keys(veri.registry).length) VE.registry = veri.registry;
    else if (!VE.registry || !Object.keys(VE.registry).length) VE.registry = M.demoRegistry();

    var layout = M.normalizeClient(veri.layout || {}, VE.registry);
    VE.revision = Number(veri.revision !== undefined ? veri.revision : (layout.revision || 0)) || 0;
    layout.revision = VE.revision;

    if (veri.preview && veri.preview.url) {
      VE.preview = { url: guvenliOnizlemeUrl(veri.preview.url), token: String(veri.preview.token || ''), origin: '' };
    } else if (!VE.preview) {
      VE.preview = { url: '', token: '', origin: '' };
    }

    if (veri.site) VE.site = veri.site;

    VE.cache = {
      layout: layout,
      registry: VE.registry,
      preview: VE.preview,
      revision: VE.revision,
      site: VE.site || null,
      tokens_effective: veri.tokens_effective || (VE.cache && VE.cache.tokens_effective) || null,
      blokIdleri: layout.blocks.map(function (b) { return b.id; }),
      alindi: new Date().toISOString()
    };
    if (VE.outbox) VE.outbox.saveCache(VE.cache);
    return layout;
  }

  function editoruKur(layout) {
    VE.state = M.createState(layout);
    VE.acikAyar = null;
    VE.secili = null;
    VE.uyarilar = [];
    listeCiz();
    paletCiz();
    tokenlariCiz();
    uyarilariCiz();
    gecmisButonlari();
    revizyonCiz();
    durumCiz();
    onizlemeYukle();

    if (VE.site && VE.site.layout_supported === false) {
      uyar('Sitenizin teması lego vitrin düzenini desteklemiyor.\nBYOM Pro Theme 2.0 veya üstünü kurun; aksi hâlde yayınlanan düzen ana sayfada görünmez.', 'uyari');
    }
  }

  function yukle(zorla) {
    if (VE.yukleniyor) return Promise.resolve();
    VE.yukleniyor = true;
    VE.demo = demoMu();

    if (UI.yukleBtn) UI.yukleBtn.disabled = true;

    if (VE.demo) {
      VE.registry = M.demoRegistry();
      showcaseYukle();
      var demoLay = M.demoLayout(VE.registry);
      VE.cache = { layout: demoLay, registry: VE.registry, preview: { url: '', token: '' }, revision: 0, tokens_effective: M.VARSAYILAN_TOKENLAR, blokIdleri: demoLay.blocks.map(function (b) { return b.id; }) };
      VE.revision = 0;
      VE.preview = { url: '', token: '', origin: '' };
      editoruKur(demoLay);
      VE.yukleniyor = false;
      if (UI.yukleBtn) UI.yukleBtn.disabled = false;
      VE.agDurumu = 'online'; durumCiz();
      return Promise.resolve();
    }

    var geriAl = UI.yukleBtn && typeof butonuMesgulEt === 'function' ? butonuMesgulEt(UI.yukleBtn, 'YÜKLENİYOR…') : function () {};

    return storefrontIstek({ sureAsimi: 20000 }).then(function (cevap) {
      if (cevap && cevap.ok && cevap.veri && cevap.veri.layout) {
        var layout = yanitiUygula(cevap.veri);
        var taslak = VE.outbox ? VE.outbox.loadDraft() : null;
        var kuyruk = VE.outbox ? VE.outbox.peek() : null;

        var kur = function (lay, kirli) {
          editoruKur(lay);
          if (kirli) { VE.state.dirty = true; revizyonCiz(); durumCiz(); }
        };

        if (kuyruk && kuyruk.layout) {
          /* Kuyrukta bekleyen yayın var: onu düzenlemeye devam et, eşitleme sürsün. */
          kur(M.normalizeClient(kuyruk.layout, VE.registry), true);
          VE.outbox.sync();
        } else if (taslak && taslak.layout && !zorla) {
          sor('Kaydedilmemiş taslak bulundu', 'Bu bilgisayarda yayınlanmamış bir vitrin taslağı var (' + kac(taslak.saved_at || '') + ').\nTaslağı açmak ister misiniz? "Hayır" derseniz sitedeki düzen yüklenir ve taslak silinir.', 'TASLAĞI AÇ', false)
            .then(function (evet) {
              if (evet) kur(M.normalizeClient(taslak.layout, VE.registry), true);
              else { VE.outbox.clearDraft(); kur(layout, false); }
            });
        } else {
          if (zorla && VE.outbox) VE.outbox.clearDraft();
          kur(layout, false);
        }

        if (VE.agDurumu === 'offline' || VE.agDurumu === 'error') { VE.agDurumu = 'online'; VE.agAyrinti = {}; durumCiz(); }
        showcaseYukle();
      } else {
        var onbellek = VE.outbox ? VE.outbox.loadCache() : null;
        var hataMetni = (cevap && (cevap.hata || (cevap.veri && cevap.veri.message))) || 'Siteye ulaşılamadı.';
        if (onbellek && onbellek.layout) {
          VE.registry = onbellek.registry || M.demoRegistry();
          VE.cache = onbellek;
          VE.revision = onbellek.revision || 0;
          VE.preview = Object.assign({ url: '', token: '', origin: '' }, onbellek.preview || {});
          VE.preview.url = guvenliOnizlemeUrl(VE.preview.url);
          VE.site = onbellek.site || null;
          var taslak2 = VE.outbox ? VE.outbox.loadDraft() : null;
          var kuyruk2 = VE.outbox ? VE.outbox.peek() : null;
          var lay = (kuyruk2 && kuyruk2.layout) || (taslak2 && taslak2.layout) || onbellek.layout;
          if (onbellek.showcase) {
            VE.showcase.banners = (onbellek.showcase.banners || []).map(bannerNormalle).filter(Boolean);
            VE.showcase.featured = (onbellek.showcase.featured || []).slice();
            VE.showcase.yuklendi = true;
            VE.showcase.durum = 'offline';
          }
          editoruKur(M.normalizeClient(lay, VE.registry));
          if (kuyruk2 || taslak2) { VE.state.dirty = true; revizyonCiz(); }
          VE.agDurumu = kuyruk2 ? 'queued' : 'offline';
          VE.agAyrinti = { offline: true, count: kuyruk2 ? 1 : 0 };
          durumCiz();
          uyar('Siteye ulaşılamadı; son bilinen düzen yerel önbellekten açıldı.\n' + hataMetni, 'uyari');
        } else {
          VE.agDurumu = (cevap && cevap.eklentiEski) ? 'error' : 'offline';
          VE.agAyrinti = { hata: hataMetni, offline: true };
          durumCiz();
          if (UI.liste) {
            UI.liste.innerHTML = '<li class="rounded-2xl border-2 border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/30 p-4 text-base text-red-800 dark:text-red-300 whitespace-pre-line">' +
              ikn('uyari') + ' ' + kac(hataMetni) + '\n\n<button type="button" class="mt-3 h-11 px-4 rounded-xl bg-marka-700 text-white font-extrabold" data-ve-retry>TEKRAR DENE</button></li>';
          }
        }
      }
    }).catch(function (e) {
      uyar('Vitrin düzeni yüklenemedi: ' + String((e && e.message) || e), 'hata');
    }).then(function () {
      VE.yukleniyor = false;
      geriAl();
      if (UI.yukleBtn) UI.yukleBtn.disabled = false;
    });
  }

  function yayinla(force) {
    if (!VE.state) return Promise.resolve();
    if (VE.demo) {
      uyar('DEMO MODU: yayın yapılmaz. Gerçek siteniz için Ayarlar sekmesinden bağlantı kurun.', 'uyari');
      return Promise.resolve();
    }
    if (!VE.outbox) return Promise.resolve();

    var geriAl = UI.yayinlaBtn && typeof butonuMesgulEt === 'function' ? butonuMesgulEt(UI.yayinlaBtn, 'YAYINLANIYOR…') : function () {};
    var layout = M.klon(VE.state.layout);

    /* Bekleyen görsel/ürün değişikliği varsa önce o gider (bağımsız uç, hata yayını engellemez). */
    var on = VE.showcase.kirli && !VE.showcase.kaydediliyor ? showcaseKaydet({}) : Promise.resolve();

    return on.then(function () { return VE.outbox.publish(layout, VE.revision, !!force); }).then(function (sonuc) {
      geriAl();
      return yayinSonucu(sonuc);
    }).catch(function (e) {
      geriAl();
      uyar('Yayınlanamadı: ' + String((e && e.message) || e), 'hata');
    });
  }

  function yayinSonucu(sonuc) {
    if (!sonuc) return;

    if (sonuc.ok) {
      var veri = sonuc.veri || {};
      if (veri.layout) {
        var yeni = yanitiUygula(veri);
        VE.state = M.markClean(M.createState(yeni), VE.revision);
      } else {
        VE.revision = Number(sonuc.revision) || VE.revision + 1;
        VE.state = M.markClean(VE.state, VE.revision);
        if (VE.cache) { VE.cache.revision = VE.revision; VE.cache.blokIdleri = VE.state.layout.blocks.map(function (b) { return b.id; }); VE.outbox.saveCache(VE.cache); }
      }
      VE.uyarilar = sonuc.warnings || [];
      listeCiz(); paletCiz(); tokenlariCiz(); uyarilariCiz(); gecmisButonlari(); revizyonCiz(); durumCiz();
      uyar('Vitrin yayınlandı (sürüm ' + VE.revision + ').' + (VE.uyarilar.length ? '\n' + VE.uyarilar.length + ' uyarı var; listeye bakın.' : ''), 'basari');
      onizlemeYukle();
      return;
    }

    if (sonuc.queued) {
      durumCiz();
      uyar(sonuc.offline
        ? 'Çevrimdışı: yayın kuyruğa alındı. Bağlantı gelince otomatik gönderilecek.'
        : 'Siteye ulaşılamadı: yayın kuyruğa alındı, bağlantı gelince otomatik gönderilecek.' + (sonuc.hata ? '\n' + sonuc.hata : ''), 'uyari');
      return;
    }

    if (sonuc.conflict) {
      var c = sonuc.current || {};
      return sor('Sunucuda daha yeni bir düzen var',
        'Başka bir cihazdan yayınlanmış (sürüm ' + kac(String(c.current_revision || '?')) + ', sizde ' + VE.revision + ').\n' +
        'ÜZERİNE YAZ: sizin düzeniniz geçerli olur.\nVAZGEÇ: sunucudaki düzen indirilir, taslağınız kaybolur.',
        'ÜZERİNE YAZ', true)
        .then(function (evet) {
          if (evet) {
            /* Uzerine yaz: kuyruktaki ESKI kayit degil, editordeki GUNCEL duzen gonderilir. */
            VE.outbox.clear();
            return yayinla(true);
          }
          /* Vazgec: kuyruk ve taslak silinir, sunucudaki duzen indirilir. */
          VE.outbox.clear();
          VE.outbox.clearDraft();
          VE.agDurumu = 'online';
          VE.agAyrinti = {};
          return yukle(true);
        });
    }

    if (sonuc.error) {
      durumCiz();
      uyar('Yayınlanamadı: ' + (sonuc.hata || 'sunucu isteği reddetti'), 'hata');
    }
  }

  function sifirla() {
    if (VE.demo) { uyar('DEMO MODU: sıfırlama yapılmaz.', 'uyari'); return; }
    sor('Varsayılan düzene dönülsün mü?', 'Sitedeki düzen silinir ve temanın varsayılan dizilimi devreye girer. Bu işlem geri alınamaz.', 'VARSAYILANA DÖN', true)
      .then(function (evet) {
        if (!evet) return;
        return storefrontIstek({ metod: 'DELETE', sureAsimi: 20000 }).then(function (cevap) {
          if (!cevap || !cevap.ok) { uyar('Sıfırlanamadı: ' + kac((cevap && cevap.hata) || ''), 'hata'); return; }
          if (VE.outbox) { VE.outbox.clear(); VE.outbox.clearDraft(); }
          var lay = yanitiUygula(cevap.veri || {});
          editoruKur(lay);
          uyar('Vitrin varsayılan düzene döndürüldü.', 'basari');
        });
      });
  }

  /* ==========================================================================
   *  9) OUTBOX + AĞ OLAYLARI
   * ========================================================================*/

  function outboxKur() {
    var depo;
    try { depo = window.localStorage; } catch (e) { depo = null; }
    if (!depo) {
      var bellek = {};
      depo = { getItem: function (k) { return bellek[k] === undefined ? null : bellek[k]; }, setItem: function (k, v) { bellek[k] = String(v); }, removeItem: function (k) { delete bellek[k]; } };
    }

    VE.outbox = M.createOutbox({
      storage: depo,
      isOnline: function () { return typeof navigator === 'undefined' || navigator.onLine !== false; },
      put: function (govde) { return storefrontIstek({ metod: 'PUT', govde: govde, sureAsimi: 30000 }); },
      ping: function () { return b2bCagir('ping', { sureAsimi: 8000 }).then(function (c) { return !!(c && c.ok); }); },
      client: { app: 'byom-b2b-panel', version: uygulamaSurumu() },
      onState: function (ad, ayrinti) {
        var oncekiAd = VE.agDurumu;
        VE.agDurumu = ad;
        VE.agAyrinti = ayrinti || {};

        /* Esitleme baslarken kuyruktaki duzenin parmak izi alinir: editordeki
           duzen bu sirada degistiyse "temiz" isaretlenmez, taslak korunur. */
        if (ad === 'syncing') {
          var kayit = VE.outbox && VE.outbox.peek();
          VE.esitlenenImza = kayit && kayit.layout ? duzenImzasi(kayit.layout) : null;
        }

        durumCiz();

        if (ad === 'online' && oncekiAd === 'syncing' && ayrinti && ayrinti.revision !== undefined) {
          VE.revision = Number(ayrinti.revision) || VE.revision;
          if (VE.state) {
            if (VE.esitlenenImza === null || duzenImzasi(VE.state.layout) === VE.esitlenenImza) {
              VE.state = M.markClean(VE.state, VE.revision);
            } else {
              VE.state.layout.revision = VE.revision;
              VE.outbox.saveDraft(VE.state.layout);
            }
          }
          VE.esitlenenImza = null;
          revizyonCiz();
          durumCiz();
        }
      }
    });

    window.addEventListener('online', function () {
      if (VE.showcase.kirli && !VE.showcase.kaydediliyor) showcaseKaydet({});
      VE.outbox.goOnline().then(function (s) {
        if (s && s.synced) {
          uyar('Kuyruktaki yayın eşitlendi (sürüm ' + (s.revision || VE.revision) + ').', 'basari');
          if (s.layout) {
            var lay = yanitiUygula(Object.assign({}, s.veri, { layout: s.layout }));
            /* Editorde esitlenenden sonra yapilmis degisiklik varsa ezilmez (kirli kalir). */
            if (!(VE.state && VE.state.dirty)) VE.state = M.markClean(M.createState(lay), VE.revision);
            listeCiz(); revizyonCiz(); durumCiz();
          }
          onizlemeYukle();
        } else if (s && s.conflict) {
          yayinSonucu(s);
        }
      });
    });
    window.addEventListener('offline', function () { VE.outbox.goOffline(); });
  }

  /* ==========================================================================
   *  10) KLAVYE
   * ========================================================================*/

  function klavyeBagla() {
    document.addEventListener('keydown', function (o) {
      if (!UI.bolum || !UI.bolum.classList.contains('acik') || !VE.state) return;
      var komut = o.ctrlKey || o.metaKey;
      if (!komut) return;
      var t = o.target;
      var yaziyor = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      var k = o.key.toLowerCase();

      if (k === 's') { o.preventDefault(); yayinla(false); return; }
      if (yaziyor && (k === 'z' || k === 'y')) return; /* metin kutusunda tarayıcının geri alması */
      if (k === 'z' && !o.shiftKey) { o.preventDefault(); dispatch(M.undo(VE.state)); tokenlariCiz(); paletCiz(); }
      else if (k === 'y' || (k === 'z' && o.shiftKey)) { o.preventDefault(); dispatch(M.redo(VE.state)); tokenlariCiz(); paletCiz(); }
    });
  }

  /* ==========================================================================
   *  12) VİTRİN İÇERİĞİ — BANNER, ÖNE ÇIKAN ÜRÜN, MARKA (eski "Web Vitrini" sekmesi)
   *  ---------------------------------------------------------------------------
   *  Banner ve öne çıkan ürünler DÜZENİN parçası değildir; eklentinin
   *  theme-config'inde (showcase.banners / showcase.featured_products) yaşar ve
   *  tema onları sunucuda çizer. Bu yüzden:
   *   - blok ayar çarkında (⚙) yönetilir, ama YAYINLA'dan bağımsız olarak
   *     değişiklikten ~1 sn sonra kendiliğinden kaydedilir (debounce);
   *   - çevrimdışıysa "bağlantı gelince kaydedilecek" olarak bekler;
   *   - kayıt sonrası önizleme iframe'i yenilenir (sunucu çizimi gerekir).
   *  Görsel yükleme (media ucu) bağlantı ister; çevrimdışı/demo modda kutu
   *  bunu söyler.
   * ========================================================================*/

  /* Blok tipi -> theme-config banner "slot" değeri (tema byom_showcase_layout ile dağıtır). */
  var BLOK_SLOT = { slider: 'slider', 'hero-slider': 'slider', 'dual-banner': 'dual', 'strip-banner': 'strip', 'hero-combo': 'slider' };
  var SLOT_ETIKET = { slider: 'Slider / hero görselleri', dual: "2'li banner görselleri", strip: 'Geniş şerit görselleri' };

  function bannerSlotu(blok) {
    if (!blok) return '';
    if (blok.type === 'hero-combo' && blok.settings && blok.settings.banner_mode === 'product') return '';
    return BLOK_SLOT[blok.type] || '';
  }

  function oneCikanGosterilsinMi(blok) {
    if (!blok || !blok.settings) return false;
    var kaynak = blok.settings.source || blok.settings.deal_source;
    return kaynak === 'featured' || kaynak === 'auto';
  }

  function bannerNormalle(b) {
    if (!b || typeof b !== 'object') return null;
    var image = String(b.image || b.url || b.gorselUrl || '').trim();
    if (!image) return null;
    var slot = String(b.slot || '');
    if (['slider', 'dual', 'strip'].indexOf(slot) === -1) slot = '';
    return {
      image: image,
      media_id: Number(b.media_id || b.mediaId || 0) || 0,
      alt: String(b.alt || b.title || b.baslik || ''),
      link: String(b.link || ''),
      slot: slot
    };
  }

  function guvenliGorselUrl(u) {
    u = String(u || '');
    return /^(https?:\/\/|data:image\/)/i.test(u) ? u : '';
  }

  function dosyaOku(dosya) {
    if (typeof dosyayiVeriAdresineCevir === 'function') return dosyayiVeriAdresineCevir(dosya);
    return new Promise(function (coz, red) {
      var r = new FileReader();
      r.onload = function () { coz(String(r.result)); };
      r.onerror = function () { red(new Error('Dosya okunamadı')); };
      r.readAsDataURL(dosya);
    });
  }

  /* ---------- yükleme ---------- */

  function showcaseYukle() {
    VE.showcase.yuklendi = false;
    if (VE.demo) {
      VE.showcase.banners = [];
      VE.showcase.featured = [];
      VE.showcase.yuklendi = true;
      return Promise.resolve();
    }
    return b2bCagir('theme-config', { sureAsimi: 20000 }).then(function (cevap) {
      if (!cevap || !cevap.ok) {
        VE.showcase.durum = 'hata';
        VE.showcase.hata = (cevap && cevap.hata) || 'Vitrin görselleri alınamadı.';
        showcaseDurumCiz();
        return;
      }
      var sc = (cevap.veri && cevap.veri.config && cevap.veri.config.showcase) || {};
      VE.showcase.banners = (Array.isArray(sc.banners) ? sc.banners : []).map(bannerNormalle).filter(Boolean);
      var idler = (Array.isArray(sc.featured_products) ? sc.featured_products : []).map(function (u) {
        return Number(u && typeof u === 'object' ? u.id : u) || 0;
      }).filter(Boolean);
      var d = durumNesnesi();
      VE.showcase.featured = idler.map(function (id) {
        var k = d && Array.isArray(d.urunler) ? d.urunler.filter(function (x) { return Number(x.id) === id; })[0] : null;
        return { id: id, ad: (k && k.ad) || ('Ürün #' + id), kod: (k && k.kod) || '', gorsel: guvenliGorselUrl(k && k.gorsel) };
      });
      VE.showcase.yuklendi = true;
      VE.showcase.kirli = false;
      VE.showcase.durum = 'ok';
      if (VE.cache) { VE.cache.showcase = { banners: VE.showcase.banners, featured: VE.showcase.featured }; if (VE.outbox) VE.outbox.saveCache(VE.cache); }
      if (VE.acikAyar) listeCiz();
      return urunAdlariniTamamla(idler.filter(function (id) { return !(d && Array.isArray(d.urunler) && d.urunler.some(function (x) { return Number(x.id) === id; })); }));
    }).catch(function (e) {
      VE.showcase.durum = 'hata';
      VE.showcase.hata = String((e && e.message) || e);
      showcaseDurumCiz();
    });
  }

  function urunAdlariniTamamla(idler) {
    if (!idler.length || VE.demo) return Promise.resolve();
    return wooCagir('products', { sorgu: { include: idler.join(','), per_page: 100 }, sureAsimi: 20000 }).then(function (c) {
      if (!c || !c.ok || !Array.isArray(c.veri)) return;
      c.veri.forEach(function (u) {
        VE.showcase.featured.forEach(function (f) {
          if (Number(f.id) === Number(u.id)) {
            f.ad = u.name || f.ad;
            f.kod = u.sku || f.kod;
            f.gorsel = guvenliGorselUrl(u.images && u.images[0] && u.images[0].src) || f.gorsel;
          }
        });
      });
      if (VE.acikAyar) listeCiz();
    }).catch(function () { /* ad tamamlama isteğe bağlı */ });
  }

  /* ---------- kaydetme (debounce) ---------- */

  function showcaseKaydetPlanla() {
    VE.showcase.kirli = true;
    VE.showcase.durum = 'bekliyor';
    showcaseDurumCiz();
    clearTimeout(VE.showcaseZaman);
    VE.showcaseZaman = setTimeout(function () { showcaseKaydet({}); }, 900);
  }

  function showcaseKaydet(secenek) {
    secenek = secenek || {};
    clearTimeout(VE.showcaseZaman);
    if (VE.demo) {
      VE.showcase.kirli = false;
      VE.showcase.durum = 'demo';
      showcaseDurumCiz();
      return Promise.resolve({ ok: false, demo: true });
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      VE.showcase.durum = 'offline';
      showcaseDurumCiz();
      return Promise.resolve({ ok: false, offline: true });
    }
    if (VE.showcase.kaydediliyor) {
      VE.showcase.tekrar = true;
      return Promise.resolve({ ok: false, busy: true });
    }

    var govde = { config: { showcase: {
      banners: VE.showcase.banners.map(function (b, i) {
        return { image: b.image, media_id: b.media_id || 0, title: b.alt || '', alt: b.alt || '', link: b.link || '', slot: b.slot || '', menu_order: i };
      }),
      featured_products: VE.showcase.featured.map(function (u) { return Number(u.id); })
    } } };

    /* Marka görselleri yalnızca kullanıcı "SİTEYE GÖNDER" dediğinde gider;
       boş dize gönderilmez (deep_merge sitedeki logoyu silerdi). */
    if (secenek.branding) {
      var d = durumNesnesi();
      var marka = {};
      if (d && d.ayarlar && d.ayarlar.yerelLogo) marka.logo = d.ayarlar.yerelLogo;
      if (d && d.ayarlar && d.ayarlar.yerelFavicon) marka.favicon = d.ayarlar.yerelFavicon;
      if (Object.keys(marka).length) govde.config.branding = marka;
      else { uyar('Gönderilecek yerel logo/favicon yok. Önce dosya yükleyin.', 'uyari'); return Promise.resolve({ ok: false }); }
    }

    VE.showcase.kaydediliyor = true;
    VE.showcase.durum = 'kaydediliyor';
    showcaseDurumCiz();

    return b2bCagir('theme-config', { metod: 'POST', govde: govde, sureAsimi: 30000 }).then(function (cevap) {
      VE.showcase.kaydediliyor = false;
      if (cevap && cevap.ok) {
        VE.showcase.kirli = false;
        VE.showcase.durum = 'ok';
        VE.showcase.hata = '';
        if (VE.cache) { VE.cache.showcase = { banners: VE.showcase.banners, featured: VE.showcase.featured }; if (VE.outbox) VE.outbox.saveCache(VE.cache); }
        showcaseDurumCiz();
        if (secenek.branding) uyar('Marka görselleri siteye gönderildi.', 'basari');
        if (VE.showcase.tekrar) { VE.showcase.tekrar = false; return showcaseKaydet({}); }
        onizlemeYukle();
        return { ok: true };
      }
      var agHatasi = !cevap || cevap.agSorunu || (!cevap.durum && !cevap.hata) || Number(cevap.durum) >= 500;
      VE.showcase.durum = agHatasi ? 'offline' : 'hata';
      VE.showcase.hata = (cevap && cevap.hata) || 'Kaydedilemedi.';
      showcaseDurumCiz();
      if (!agHatasi) uyar('Vitrin görselleri kaydedilemedi:\n' + VE.showcase.hata, 'hata');
      return { ok: false, hata: VE.showcase.hata };
    }).catch(function (e) {
      VE.showcase.kaydediliyor = false;
      VE.showcase.durum = 'hata';
      VE.showcase.hata = String((e && e.message) || e);
      showcaseDurumCiz();
      return { ok: false };
    });
  }

  function showcaseDurumMetni() {
    var s = VE.showcase;
    switch (s.durum) {
      case 'kaydediliyor': return { m: 'Kaydediliyor…', c: 'is-busy' };
      case 'bekliyor': return { m: 'Değişiklik var, kaydedilecek…', c: 'is-busy' };
      case 'ok': return { m: s.kirli ? 'Kaydedilmemiş değişiklik var' : 'Siteye kaydedildi ✓', c: s.kirli ? 'is-warn' : 'is-ok' };
      case 'offline': return { m: 'Çevrimdışı: bağlantı gelince kaydedilecek', c: 'is-warn' };
      case 'demo': return { m: 'Demo modu: siteye kaydedilmez', c: 'is-warn' };
      case 'hata': return { m: 'Hata: ' + String(s.hata || '').split('\n')[0], c: 'is-err' };
      default: return { m: s.yuklendi ? '' : 'Vitrin görselleri yükleniyor…', c: '' };
    }
  }

  function showcaseDurumCiz() {
    var bilgi = showcaseDurumMetni();
    secHep('[data-ve-showcase-durum]').forEach(function (el) {
      el.textContent = bilgi.m;
      el.className = 've-showcase-durum ' + bilgi.c;
    });
    var marka = secDeg('#veMarkaDurum');
    if (marka && VE.showcase.durum) { marka.textContent = bilgi.m; }
  }

  /* ---------- HTML ---------- */

  function bannerYoneticiHtml(blok) {
    var slot = bannerSlotu(blok);
    if (!slot) return '';
    var liste = VE.showcase.banners.map(function (b, i) { return { b: b, i: i }; });
    var bunlar = liste.filter(function (x) { return x.b.slot === slot; });
    var serbest = liste.filter(function (x) { return !x.b.slot; });
    var notu = blok.type === 'hero-combo'
      ? 'Hero bloğu Slider ile aynı görsel havuzunu kullanır.'
      : (slot === 'dual' ? 'İlk iki görsel yan yana basılır.' : (slot === 'strip' ? 'Her görsel tam genişlik bir şerit olur.' : 'Sırayla kayar; ilk görsel öncelikli yüklenir.'));

    var ogeHtml = function (x, tasima) {
      var b = x.b;
      return '<div class="ve-banner" data-ve-banner="' + x.i + '">' +
        '<img class="ve-banner__img" src="' + kac(guvenliGorselUrl(b.image)) + '" alt="" loading="lazy" />' +
        '<div class="ve-banner__fields">' +
          '<input type="text" class="' + INPUT_SINIF + ' h-9 text-sm" data-ve-banner-alan="alt" value="' + kac(b.alt) + '" placeholder="Başlık (opsiyonel)" maxlength="120" />' +
          '<input type="text" class="' + INPUT_SINIF + ' h-9 text-sm font-mono" data-ve-banner-alan="link" value="' + kac(b.link) + '" placeholder="Bağlantı: https://… veya /kategori/…" maxlength="500" />' +
        '</div>' +
        '<div class="ve-banner__actions">' +
          (tasima
            ? '<button type="button" class="ve-iconbtn" data-ve-banner-tasi title="Bu bloğa taşı">' + ikn('yukle', 'ik-sm') + '</button>'
            : '<button type="button" class="ve-iconbtn" data-ve-banner-yukari title="Yukarı">' + ikn('yukariOk', 'ik-sm') + '</button>' +
              '<button type="button" class="ve-iconbtn" data-ve-banner-asagi title="Aşağı">' + ikn('asagiOk', 'ik-sm') + '</button>') +
          '<button type="button" class="ve-iconbtn ve-iconbtn--danger" data-ve-banner-sil title="Kaldır">' + ikn('cop', 'ik-sm') + '</button>' +
        '</div>' +
      '</div>';
    };

    return '<div class="ve-field ve-banners" data-ve-banners="' + kac(slot) + '">' +
      '<label class="ve-field__label">' + ikn('resim', 'ik-sm') + ' ' + kac(SLOT_ETIKET[slot] || 'Banner görselleri') + '<span class="ve-stale" title="Sunucu çizer; kaydedilince önizleme yenilenir">sunucu</span></label>' +
      '<span class="ve-field__help">' + kac(notu) + '</span>' +
      '<div class="ve-drop" data-ve-drop tabindex="0" role="button" aria-label="Görsel yükle">' +
        '<input type="file" accept="image/*" multiple data-ve-banner-file hidden />' +
        ikn('yukle') + '<span>Görseli buraya <b>sürükleyip bırakın</b> ya da <b>tıklayıp seçin</b></span>' +
        '<small>PNG · JPG · WEBP · en fazla 5 MB' + (VE.demo ? ' · demo modunda yalnızca önizlenir' : '') + '</small>' +
      '</div>' +
      '<div class="ve-banner-list" data-ve-banner-list>' +
        (bunlar.length ? bunlar.map(function (x) { return ogeHtml(x, false); }).join('') : '<div class="ve-banner-list__bos">Bu blok için henüz görsel yok.</div>') +
      '</div>' +
      (serbest.length
        ? '<div class="ve-banner-list__grup">Yerleşimi belirlenmemiş (eski) görseller — tema otomatik dağıtır</div>' +
          '<div class="ve-banner-list">' + serbest.map(function (x) { return ogeHtml(x, true); }).join('') + '</div>'
        : '') +
      '<div class="ve-showcase-durum" data-ve-showcase-durum></div>' +
    '</div>';
  }

  function oneCikanYoneticiHtml(blok) {
    if (!oneCikanGosterilsinMi(blok)) return '';
    var liste = VE.showcase.featured;
    return '<div class="ve-field ve-featured" data-ve-featured>' +
      '<label class="ve-field__label">' + ikn('yildiz', 'ik-sm') + ' Öne çıkan ürünler (panel seçimi)<span class="ve-stale" title="Sunucu çizer; kaydedilince önizleme yenilenir">sunucu</span></label>' +
      '<span class="ve-field__help">"Otomatik" kaynak önce bu listeyi kullanır; boşsa indirimli ve yeni ürünlere düşer. Sıra sitede aynen korunur.</span>' +
      '<div class="ve-product">' +
        '<input type="text" class="' + INPUT_SINIF + '" data-ve-featured-search placeholder="Ürün ara (ad veya stok kodu)…" autocomplete="off" />' +
        '<div class="ve-product__sonuc hidden" data-ve-featured-results></div>' +
      '</div>' +
      '<div class="ve-featured-list" data-ve-featured-list>' +
        (liste.length
          ? liste.map(function (u, i) {
              return '<div class="ve-featured__row" data-ve-featured-row="' + i + '">' +
                (u.gorsel ? '<img class="ve-featured__img" src="' + kac(guvenliGorselUrl(u.gorsel)) + '" alt="" />' : '<span class="ve-featured__img ve-featured__img--bos">' + ikn('paket', 'ik-sm') + '</span>') +
                '<span class="ve-featured__body"><b>' + kac(u.ad) + '</b>' + (u.kod ? '<small class="font-mono">' + kac(u.kod) + '</small>' : '') + '</span>' +
                '<span class="ve-banner__actions">' +
                  '<button type="button" class="ve-iconbtn" data-ve-featured-yukari title="Yukarı">' + ikn('yukariOk', 'ik-sm') + '</button>' +
                  '<button type="button" class="ve-iconbtn" data-ve-featured-asagi title="Aşağı">' + ikn('asagiOk', 'ik-sm') + '</button>' +
                  '<button type="button" class="ve-iconbtn ve-iconbtn--danger" data-ve-featured-sil title="Listeden çıkar">' + ikn('cop', 'ik-sm') + '</button>' +
                '</span>' +
              '</div>';
            }).join('')
          : '<div class="ve-banner-list__bos">Henüz ürün seçilmedi; arama kutusundan ekleyin.</div>') +
      '</div>' +
      '<div class="ve-showcase-durum" data-ve-showcase-durum></div>' +
    '</div>';
  }

  /* ---------- olaylar (ayar formu içinde) ---------- */

  function showcaseOlaylariBagla(form) {
    var bannerKutu = secDeg('[data-ve-banners]', form);

    if (bannerKutu) {
      var slot = bannerKutu.getAttribute('data-ve-banners');
      var drop = secDeg('[data-ve-drop]', bannerKutu);
      var dosyaGirdi = secDeg('[data-ve-banner-file]', bannerKutu);

      var yukle = function (dosyalar) {
        var liste = Array.prototype.slice.call(dosyalar || []).filter(function (f) { return f && /^image\//.test(f.type); });
        if (!liste.length) { uyar('Lütfen bir görsel dosyası seçin (PNG, JPG, WEBP).', 'uyari'); return; }
        if (!VE.demo && typeof navigator !== 'undefined' && navigator.onLine === false) { uyar('Görsel yüklemek için internet bağlantısı gerekir. Çevrimdışısınız.', 'uyari'); return; }
        drop.classList.add('is-busy');
        var sira = Promise.resolve();
        liste.forEach(function (dosya) {
          sira = sira.then(function () {
            if (dosya.size > 5 * 1024 * 1024) { uyar('"' + dosya.name + '" çok büyük (en fazla 5 MB).', 'uyari'); return; }
            return dosyaOku(dosya).then(function (veri) {
              if (VE.demo) { VE.showcase.banners.push({ image: veri, media_id: 0, alt: '', link: '', slot: slot }); return; }
              return b2bCagir('media', { metod: 'POST', govde: { filename: dosya.name, data: veri, title: 'Banner' }, sureAsimi: 45000 }).then(function (c) {
                if (!c || !c.ok || !c.veri || !c.veri.url) { uyar('"' + dosya.name + '" yüklenemedi:\n' + kac((c && c.hata) || ''), 'hata'); return; }
                VE.showcase.banners.push({ image: String(c.veri.url), media_id: Number(c.veri.id || 0), alt: '', link: '', slot: slot });
              });
            });
          });
        });
        sira.then(function () {
          drop.classList.remove('is-busy');
          listeCiz();
          showcaseKaydetPlanla();
        }).catch(function (e) {
          drop.classList.remove('is-busy');
          uyar('Görsel yüklenirken hata: ' + String((e && e.message) || e), 'hata');
        });
      };

      drop.addEventListener('click', function () { dosyaGirdi.click(); });
      drop.addEventListener('keydown', function (o) { if (o.key === 'Enter' || o.key === ' ') { o.preventDefault(); dosyaGirdi.click(); } });
      dosyaGirdi.addEventListener('change', function () { yukle(dosyaGirdi.files); dosyaGirdi.value = ''; });
      drop.addEventListener('dragover', function (o) { o.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
      drop.addEventListener('drop', function (o) {
        o.preventDefault();
        drop.classList.remove('is-over');
        yukle(o.dataTransfer && o.dataTransfer.files);
      });

      bannerKutu.addEventListener('input', debounce(function (o) {
        var el = o.target;
        var alan = el.getAttribute('data-ve-banner-alan');
        if (!alan) return;
        var kart = el.closest('[data-ve-banner]');
        var b = VE.showcase.banners[parseInt(kart.getAttribute('data-ve-banner'), 10)];
        if (!b) return;
        b[alan] = String(el.value || '').slice(0, alan === 'link' ? 500 : 120);
        showcaseKaydetPlanla();
      }, 250));

      bannerKutu.addEventListener('click', function (o) {
        var kart = o.target.closest('[data-ve-banner]');
        if (!kart) return;
        var i = parseInt(kart.getAttribute('data-ve-banner'), 10);
        var b = VE.showcase.banners[i];
        if (!b) return;

        if (o.target.closest('[data-ve-banner-sil]')) {
          VE.showcase.banners.splice(i, 1);
        } else if (o.target.closest('[data-ve-banner-tasi]')) {
          b.slot = slot;
        } else if (o.target.closest('[data-ve-banner-yukari]') || o.target.closest('[data-ve-banner-asagi]')) {
          var yon = o.target.closest('[data-ve-banner-yukari]') ? -1 : 1;
          var ayni = VE.showcase.banners.map(function (x, j) { return { x: x, j: j }; }).filter(function (p) { return p.x.slot === slot; });
          var k = ayni.findIndex(function (p) { return p.j === i; });
          var hedef = k + yon;
          if (k === -1 || hedef < 0 || hedef >= ayni.length) return;
          var a = ayni[k].j, c = ayni[hedef].j;
          var t = VE.showcase.banners[a]; VE.showcase.banners[a] = VE.showcase.banners[c]; VE.showcase.banners[c] = t;
        } else {
          return;
        }
        listeCiz();
        showcaseKaydetPlanla();
      });
    }

    var featKutu = secDeg('[data-ve-featured]', form);

    if (featKutu) {
      var arama = secDeg('[data-ve-featured-search]', featKutu);
      var sonuc = secDeg('[data-ve-featured-results]', featKutu);

      var ara = debounce(function () {
        var q = arama.value.trim();
        if (q.length < 2) { sonuc.classList.add('hidden'); sonuc.innerHTML = ''; return; }
        sonuc.classList.remove('hidden');
        if (VE.demo) { sonuc.innerHTML = '<div class="ve-product__hint">Demo modunda ürün araması yapılamaz.</div>'; return; }
        sonuc.innerHTML = '<div class="ve-product__hint"><span class="donuyor">' + ikn('donen', 'ik-sm') + '</span> Aranıyor…</div>';
        wooCagir('products', { sorgu: { search: q, per_page: 8, status: 'publish' }, sureAsimi: 15000 }).then(function (c) {
          if (!c || !c.ok) { sonuc.innerHTML = '<div class="ve-product__hint text-red-600">' + kac((c && c.hata) || 'Arama başarısız') + '</div>'; return; }
          var secili = {};
          VE.showcase.featured.forEach(function (u) { secili[u.id] = true; });
          var urunler = (Array.isArray(c.veri) ? c.veri : []).filter(function (u) { return !secili[u.id]; });
          if (!urunler.length) { sonuc.innerHTML = '<div class="ve-product__hint">Sonuç yok (ya da hepsi listede).</div>'; return; }
          sonuc.innerHTML = urunler.map(function (u) {
            return '<button type="button" class="ve-product__pick" data-ve-featured-ekle="' + kac(String(u.id)) + '" data-ad="' + kac(u.name || '') + '" data-kod="' + kac(u.sku || '') + '" data-gorsel="' + kac(guvenliGorselUrl(u.images && u.images[0] && u.images[0].src)) + '">' +
              '<span class="font-bold">' + kac(u.name || '') + '</span>' + (u.sku ? '<span class="text-xs text-slate-500 font-mono ml-2">' + kac(u.sku) + '</span>' : '') +
            '</button>';
          }).join('');
        });
      }, 300);
      arama.addEventListener('input', ara);

      featKutu.addEventListener('click', function (o) {
        var ekle = o.target.closest('[data-ve-featured-ekle]');
        if (ekle) {
          VE.showcase.featured.push({ id: parseInt(ekle.getAttribute('data-ve-featured-ekle'), 10), ad: ekle.getAttribute('data-ad') || '', kod: ekle.getAttribute('data-kod') || '', gorsel: ekle.getAttribute('data-gorsel') || '' });
          listeCiz();
          showcaseKaydetPlanla();
          return;
        }
        var satir = o.target.closest('[data-ve-featured-row]');
        if (!satir) return;
        var i = parseInt(satir.getAttribute('data-ve-featured-row'), 10);
        if (o.target.closest('[data-ve-featured-sil]')) {
          VE.showcase.featured.splice(i, 1);
        } else if (o.target.closest('[data-ve-featured-yukari]') && i > 0) {
          var t = VE.showcase.featured[i - 1]; VE.showcase.featured[i - 1] = VE.showcase.featured[i]; VE.showcase.featured[i] = t;
        } else if (o.target.closest('[data-ve-featured-asagi]') && i < VE.showcase.featured.length - 1) {
          var t2 = VE.showcase.featured[i + 1]; VE.showcase.featured[i + 1] = VE.showcase.featured[i]; VE.showcase.featured[i] = t2;
        } else {
          return;
        }
        listeCiz();
        showcaseKaydetPlanla();
      });
    }

    showcaseDurumCiz();
  }

  /* ---------- marka görselleri (logo/favicon, renderer.js yardımcılarıyla) ---------- */

  function markaOlaylariBagla() {
    var btn = secDeg('#veMarkaGonderBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (VE.demo) { uyar('DEMO MODU: siteye gönderilmez.', 'uyari'); return; }
      var geri = typeof butonuMesgulEt === 'function' ? butonuMesgulEt(btn, 'GÖNDERİLİYOR…') : function () {};
      showcaseKaydet({ branding: true }).then(geri, geri);
    });
    if (typeof logoOnizlemeGuncelle === 'function') { try { logoOnizlemeGuncelle(); } catch (e) { /* ayarlar henüz yok */ } }
    if (typeof faviconOnizlemeGuncelle === 'function') { try { faviconOnizlemeGuncelle(); } catch (e) { /* ayarlar henüz yok */ } }
  }

  /* ---------- önizlemeden gelen "ayarı aç" isteği ---------- */

  function duzenlemeIstegi(id) {
    if (!VE.state || !id) return;
    var blok = VE.state.layout.blocks.filter(function (b) { return b.id === id; })[0];
    if (!blok) return;
    VE.acikAyar = id;
    VE.secili = id;
    listeCiz();
    var satir = secDeg('[data-ve-row][data-id="' + cssKac(id) + '"]', UI.liste);
    if (satir) {
      satir.scrollIntoView({ block: 'center', behavior: 'smooth' });
      satir.classList.add('is-new');
      var hedef = secDeg('[data-ve-drop], [data-ve-featured-search], [data-ve-field]', satir);
      if (hedef) setTimeout(function () { try { hedef.focus(); } catch (e) { /* jsdom */ } }, 250);
    }
  }

  /* ==========================================================================
   *  11) BAŞLAT
   * ========================================================================*/

  function olaylariBagla() {
    if (UI.yukleBtn) UI.yukleBtn.addEventListener('click', function () {
      if (VE.state && VE.state.dirty) {
        sor('Değişiklikler kaybolsun mu?', 'Yayınlanmamış değişiklikler var. Siteden yeniden yüklerseniz taslak silinir.', 'YENİDEN YÜKLE', true)
          .then(function (evet) { if (evet) yukle(true); });
      } else yukle(true);
    });
    if (UI.geriBtn) UI.geriBtn.addEventListener('click', function () { dispatch(M.undo(VE.state)); tokenlariCiz(); paletCiz(); });
    if (UI.yineBtn) UI.yineBtn.addEventListener('click', function () { dispatch(M.redo(VE.state)); tokenlariCiz(); paletCiz(); });
    if (UI.sifirlaBtn) UI.sifirlaBtn.addEventListener('click', sifirla);
    if (UI.yayinlaBtn) UI.yayinlaBtn.addEventListener('click', function () { yayinla(false); });
    if (UI.yenileBtn) UI.yenileBtn.addEventListener('click', function () { onizlemeYukle(); });
    if (UI.disariBtn) UI.disariBtn.addEventListener('click', function () {
      var adres = guvenliOnizlemeUrl(VE.preview.url) || guvenliOnizlemeUrl(siteAdresi());
      if (!adres) return;
      if (electron && electron.shell) electron.shell.openExternal(adres);
      else window.open(adres, '_blank');
    });
    if (UI.cihazlar) UI.cihazlar.addEventListener('click', function (o) {
      var b = o.target.closest('[data-ve-device]');
      if (b) cihazSec(b.getAttribute('data-ve-device'));
    });
    if (UI.liste) UI.liste.addEventListener('click', function (o) {
      if (o.target.closest('[data-ve-retry]')) yukle(true);
    });
    if (UI.iframe) UI.iframe.addEventListener('load', function () {
      VE.onizlemeHazir = false;
      baglantiCiz();
      pingBaslat();
    });

    window.addEventListener('message', onizlemeMesaji);
    olcekDinleyiciBagla();
    markaOlaylariBagla();
    listeOlaylariniBagla();
    paletOlaylari();
    tokenOlaylari();
    klavyeBagla();
  }

  function vitrinEditorAc() {
    if (VE.acildi) {
      if (!VE.state && !VE.yukleniyor) yukle(false);
      /* Sekme yeniden acildiginda konteyner genisligi degismis olabilir. */
      requestAnimationFrame(onizlemeOlcekle);
      return;
    }
    VE.acildi = true;
    uiBagla();
    if (!UI.bolum) return;
    outboxKur();
    olaylariBagla();
    cihazSec('desktop');
    durumCiz();
    yukle(false).then(function () {
      if (VE.outbox && !VE.demo) VE.outbox.startPolling();
    });
  }

  window.vitrinEditorAc = vitrinEditorAc;

  /* Sekme değişimini sar: sekmeAc renderer.js'te tanımlıysa ve bizim satır
     eklenmemişse bile editör açılsın. */
  if (typeof window.sekmeAc === 'function') {
    var eskiSekmeAc = window.sekmeAc;
    window.sekmeAc = function (ad) {
      var sonuc = eskiSekmeAc.apply(this, arguments);
      if (ad === 'vitrin-editor') vitrinEditorAc();
      return sonuc;
    };
  }
})();
