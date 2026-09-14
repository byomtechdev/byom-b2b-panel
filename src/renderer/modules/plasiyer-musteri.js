/* ============================================================================
 *  PLASİYER MÜŞTERİ VE SİPARİŞ AKIŞI
 *  (src/renderer/modules/plasiyer-musteri.js)
 *  ---------------------------------------------------------------------------
 *  Saha satış ekranının müşteri yarısı ve "Müşterilerim" sekmesi:
 *    · Katalog & Satış üst şeridi — MÜŞTERİ AÇILIR MENÜSÜ (Faz 9), seçili
 *      müşterinin iskonto/bakiye künyesi, "son siparişi kopyala"
 *    · Yeni müşteri formu — ALGORİTMİK doğrulama (TCKN/VKN kontrol toplamı,
 *      GSM biçimi, iskonto tavanı) + yerel mükerrer uyarısı
 *    · Sipariş tamamlama — üç ödeme yöntemi, BİLEŞİK iskonto özeti
 *    · Müşterilerim — portföy kartları, müşteri profili (notlar + siparişler)
 *    · Kendi Siparişlerim — çevrimdışı KUYRUK ŞERİDİ (bekleyen / hatalı)
 *
 *  KURALLARI YAZMAZ, ÇAĞIRIR. Kontrol toplamları `src/shared/dogrulama.js`,
 *  koli/iskonto/sepet matematiği `src/renderer/plasiyer-siparis-motor.js`
 *  içindedir (ikisi de DOM'suz, `node --test` altında ölçülür). Sepet, vitrin
 *  modülüyle PAYLAŞILIR — `PlasiyerVitrin.sepetAl()` tek sepeti döndürür.
 *
 *  MÜŞTERİ SEÇİLİNCE FİYAT DEĞİŞİR (Faz 9): seçim `musteriIskontosuUygula`
 *  ile sepete bayi iskontosunu yazar ve vitrin YENİDEN ÇİZİLİR — kart, matris
 *  ve modaldaki fiyat artık o müşterinin net fiyatıdır. Müşterisiz vitrin
 *  liste fiyatı gösterir.
 *
 *  ÇEVRİMDIŞI MÜŞTERİ: kimlik `temp_musteri_<uuid>` METİNDİR, sayısal
 *  WordPress kimliğiyle karışmaz. Kayıt `musteri:kuyruga` IPC'siyle ANA
 *  SÜREÇTE diske eklenir — renderer tarafında oku-değiştir-yaz yapılmaz;
 *  eşitleme motoru aynı dosyayı aynı anda temizliyor olabilir (yarış).
 *  Eşitleme sunucuda TCKN/VKN/telefonla MEVCUT bayiyi bulursa yeni hesap
 *  açmaz, siparişi ona bağlar (class-b2b-rest-plasiyer.php → musteri_esitle).
 * ==========================================================================*/

'use strict';

(function () {

  /** Yerel (çevrimdışı) müşterilerin ayarlardaki anahtarı. */
  var YEREL_ANAHTAR = 'plasiyerYerelMusteriler';

  var durumM = {
    musteriler: [],      // sunucudan gelenler
    yereller: [],        // çevrimdışı eklenenler (henüz sunucuda yok)
    secili: null,
    sonSiparis: null,
    arama: '',           // seçim penceresi / şerit araması
    portfoyArama: '',    // Müşterilerim sekmesi araması
    yuklendi: false,     // sunucu listesi en az bir kez çekildi mi?
    profil: null         // Müşterilerim'de açık profil
  };

  var bagli = false;
  var portfoyBagli = false;
  var aramaSaat = null;

  function M() {
    return window.PlasiyerSiparisMotor;
  }

  function V() {
    return window.PlasiyerVitrin;
  }

  function D() {
    return window.Dogrulama || null;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function paraYaz(n) {
    if ('function' === typeof window.para) {
      try { return window.para(n); } catch (e) { /* yedek */ }
    }

    return (Number(n) || 0).toFixed(2) + ' ₺';
  }

  function sepet() {
    return V() ? V().sepetAl() : M().sepetKur();
  }

  function tavan() {
    return V() ? V().tavanAl() : 0;
  }

  function oturum() {
    return (window.durum && window.durum.oturum) || {};
  }

  function plasiyerMi() {
    return 'plasiyer' === oturum().rol;
  }

  function yaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  /** Oranı "12" / "12,5" biçiminde yazar. */
  function yuzdeYaz(n) {
    n = Number(n) || 0;

    return String(Math.round(n * 100) / 100).replace('.', ',');
  }

  /** Vitrin ve sepeti yeniden çizer (müşteri/ödeme değişince fiyat değişir). */
  function fiyatlariTazele() {
    if (!V()) return;

    if ('function' === typeof V().vitriniCiz) V().vitriniCiz();
    V().sepetiCiz();
  }

  /* ------------------------------------------------------------------ *
   *  YEREL MÜŞTERİ DEPOSU (ayarlar.json)
   * ------------------------------------------------------------------ */

  async function yerelleriYukle() {
    try {
      var ayar = await ipcRenderer.invoke('ayar:oku');
      var liste = (ayar && ayar[YEREL_ANAHTAR]) || [];

      /* `senkron: true` kayıt sunucuda zaten var (anında eşitleme ya da tur);
         temizlik sıradaki eşitlemede yapılır. Onu ÇEVRİMDIŞI rozetiyle
         listelemek yanlış bilgi olurdu. */
      durumM.yereller = (Array.isArray(liste) ? liste : []).filter(function (x) { return x && !x.senkron; });
    } catch (e) {
      durumM.yereller = [];
    }
  }

  /**
   * Yeni yerel müşteriyi ANA SÜREÇTE kuyruğa ekler (tekil ekleme).
   *
   * Eski yol bütün listeyi `ayar:yaz` ile geri basıyordu; eşitleme aynı anda
   * eşitlenen müşterileri düşürmüşse renderer'ın eski fotoğrafı onları
   * "senkron: false" olarak DİRİLTİYORDU. Ana süreçteki ekleme bu yarışı
   * kapatır.
   */
  async function yerelMusteriKaydet(musteri) {
    try {
      var cevap = await ipcRenderer.invoke('musteri:kuyruga', musteri);

      return !!(cevap && cevap.ok);
    } catch (e) {
      return false;
    }
  }

  /**
   * ÇEVRİMDIŞI müşteriyi cihazdan siler (Faz 11). Kural ana süreçte
   * (musteri:kuyruktan-sil): yalnızca geçici + eşitlenmemiş kayıt; bekleyen
   * sipariş/not varsa RET — sebep kullanıcıya söylenir. Seçili müşteri buysa
   * sepet bırakılır ki satış ekranı sahipsiz bir müşteriyle kalmasın.
   */
  async function yerelMusteriSil(m) {
    if (!m || !M().geciciMi(m.id)) return false;

    var eminMi = ('function' === typeof window.onayla)
      ? await window.onayla('Müşteriyi Cihazdan Sil',
          kacis(m.unvan || '') + '\n\nBu kayıt henüz sunucuya gitmedi; yalnızca bu cihazdan silinecek.',
          'EVET, SİL', true)
      : ('function' === typeof window.confirm ? window.confirm('"' + (m.unvan || '') + '" cihazdan silinsin mi?') : true);

    if (!eminMi) return false;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('musteri:kuyruktan-sil', { id: m.id });
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Ağ hatası.' };
    }

    if (!cevap || !cevap.ok) {
      bildir((cevap && cevap.hata) || 'Müşteri silinemedi.', 'uyari');
      return false;
    }

    durumM.yereller = durumM.yereller.filter(function (x) { return String(x.id) !== String(m.id); });

    if (durumM.secili && String(durumM.secili.id) === String(m.id)) musteriyiBirak();
    if (durumM.profil && String(durumM.profil.id) === String(m.id)) durumM.profil = null;

    portfoyuCiz();
    seridiCiz();
    kuyrukSeridiniCiz();

    bildir('Çevrimdışı müşteri cihazdan silindi: ' + (m.unvan || ''), 'basari');

    return true;
  }

  /* ------------------------------------------------------------------ *
   *  MÜŞTERİ LİSTESİ
   * ------------------------------------------------------------------ */

  /**
   * Plasiyere bağlı müşteriler.
   *
   * Plasiyer oturumunda `plasiyer:get-dealers` kullanılır: kimlik ana süreç
   * belleğindeki OTURUMDAN okunur, arayüzden değil — arayüzdeki bir hata
   * başka bir plasiyerin müşterilerini getirtemez.
   *
   * Yönetici oturumunda tüm bayiler listelenir (wc/v3/customers).
   */
  async function musterileriGetir() {
    if (plasiyerMi()) {
      var cevap = await ipcRenderer.invoke('plasiyer:get-dealers', { arama: '', adet: 500 });

      if (!cevap || !cevap.ok) {
        durumM.musteriler = [];
        return { ok: false, hata: (cevap && cevap.hata) || 'Müşteri listesi alınamadı.' };
      }

      durumM.musteriler = ((cevap.veri && cevap.veri.bayiler) || []).map(function (b) {
        return {
          id: Number(b.id) || 0,
          unvan: String(b.unvan || b.ad || ''),
          ad: String(b.ad || ''),
          vergiNo: String(b.vergiNo || ''),
          kimlikTuru: String(b.kimlikTuru || ''),
          il: String(b.il || ''),
          ilce: String(b.ilce || ''),
          telefon: String(b.telefon || ''),
          eposta: String(b.eposta || ''),
          acikBakiye: Number(b.acikBakiye) || 0,
          /* Faz 9 — bileşik iskontonun iki girdisi sunucudan gelir. */
          iskonto: Number(b.iskonto) || 0,
          odemeIskontolari: (b.odemeIskontolari && 'object' === typeof b.odemeIskontolari) ? b.odemeIskontolari : {},
          gecici: false
        };
      });

      durumM.yuklendi = true;

      return { ok: true };
    }

    /*
     * YÖNETİCİ yolu YALNIZCA açıkça yönetici oturumunda (Faz 10).
     *
     * Eskiden "plasiyer değilse yönetici" varsayılıyordu; `window.durum`
     * üretimde tanımsız kaldığı için rol hiç okunamıyor ve plasiyer ekranına
     * WooCommerce'in BÜTÜN perakende müşterileri dökülüyordu (Görsel 6-7).
     * Rol bilinmiyorsa sunucuya HİÇ gidilmez — "bilmiyorum" hâlinde her şeyi
     * göstermek tam olarak engellemeye çalıştığımız sızıntıdır.
     */
    if ('admin' !== oturum().rol) {
      durumM.musteriler = [];
      return { ok: false, hata: 'Oturum rolü bilinmiyor; müşteri listesi çekilmedi.' };
    }

    durumM.musteriler = await woo_musteriler();
    durumM.yuklendi = true;

    return { ok: true };
  }

  async function woo_musteriler() {
    var cevap = await window.woo('/customers', { sorgu: { per_page: 100, search: durumM.arama } });

    if (!cevap || !cevap.ok || !Array.isArray(cevap.veri)) return [];

    return cevap.veri.map(function (c) {
      var byom = c.byom || {};
      var b2b = c.b2b || {};
      var fatura = c.billing || {};

      return {
        id: Number(c.id) || 0,
        unvan: String(fatura.company || (c.first_name + ' ' + c.last_name).trim() || c.email || ''),
        ad: String((c.first_name + ' ' + c.last_name).trim() || ''),
        vergiNo: String(b2b.tax_number || ''),
        kimlikTuru: '',
        il: String(fatura.state || ''),
        ilce: String(fatura.city || ''),
        telefon: String(fatura.phone || ''),
        eposta: String(c.email || ''),
        acikBakiye: Number(byom.acikBakiye) || 0,
        iskonto: Number(b2b.custom_discount_rate) || 0,
        odemeIskontolari: {},
        gecici: false
      };
    });
  }

  /** Liste hiç çekilmemişse çeker (şerit ve portföy ilk açılışta çağırır). */
  async function listeyiHazirla() {
    await yerelleriYukle();

    if (!durumM.yuklendi) {
      try { await musterileriGetir(); } catch (e) { /* çevrimdışı: yereller kalır */ }
    }
  }

  function suz(liste, q) {
    q = String(q || '').toLocaleLowerCase('tr');

    if (!q) return liste;

    var rakam = q.replace(/[^0-9]/g, '');

    return liste.filter(function (m) {
      var metin = (m.unvan + ' ' + m.ad + ' ' + m.vergiNo + ' ' + m.il + ' ' + m.ilce).toLocaleLowerCase('tr');

      if (metin.indexOf(q) !== -1) return true;

      /* Telefon: yazım biçiminden bağımsız rakam karşılaştırması. */
      return rakam.length >= 3 && String(m.telefon || '').replace(/[^0-9]/g, '').indexOf(rakam) !== -1;
    });
  }

  /** Sunucudakiler + çevrimdışı eklenenler, aramaya göre süzülmüş. */
  function tumMusteriler() {
    return suz(durumM.yereller.concat(durumM.musteriler), durumM.arama);
  }

  function musteriBul(id) {
    return durumM.yereller.concat(durumM.musteriler).find(function (m) {
      return String(m.id) === String(id);
    }) || null;
  }

  /* ------------------------------------------------------------------ *
   *  ÜST ŞERİT — MÜŞTERİ AÇILIR MENÜSÜ (Faz 9)
   * ------------------------------------------------------------------ */

  function musteriEtiketi(m) {
    var parca = [m.unvan];

    if (Number(m.iskonto) > 0) parca.push('%' + yuzdeYaz(m.iskonto) + ' İskonto');
    if (m.gecici) parca.push('ÇEVRİMDIŞI');

    return parca.join(' — ');
  }

  function seridiCiz() {
    var kap = el('musteriSerit');

    if (!kap) return;

    var hepsi = durumM.yereller.concat(durumM.musteriler);
    var secili = durumM.secili;

    var secenekler = '<option value="">👤 Müşteri seçin…</option>' +
      hepsi.map(function (m) {
        return '<option value="' + kacis(String(m.id)) + '"' +
          (secili && String(secili.id) === String(m.id) ? ' selected' : '') + '>' +
          kacis(musteriEtiketi(m)) + '</option>';
      }).join('');

    var kunye = '';

    if (secili) {
      var risk = Number(secili.acikBakiye) || 0;

      kunye =
        '<span class="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 text-sm font-bold">' +
          kacis([secili.kimlikTuru ? secili.kimlikTuru.toUpperCase() + ' ' : '', secili.vergiNo].join('') || '') +
          (secili.il ? ' · ' + kacis(secili.il) : '') +
        '</span>' +
        '<span class="px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800 border-2 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 text-sm font-extrabold" title="Bayi iskontosu — fiyatlar buna göre net gösterilir">' +
          'Bayi %' + yuzdeYaz(sepet().iskonto) +
        '</span>' +
        (risk > 0
          ? '<span class="px-3 py-2 rounded-xl bg-red-50 text-red-800 border-2 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900 text-sm font-bold">⚠ Açık Bakiye: ' + kacis(paraYaz(risk)) + '</span>'
          : '<span class="px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800 border-2 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 text-sm font-bold">✓ Bakiye temiz</span>') +
        '<button type="button" id="sonSiparisKopya" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
          '📋 Son Siparişi Sepete Kopyala' +
        '</button>';
    }

    kap.innerHTML =
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<select id="musteriSecim" aria-label="Müşteri seç" ' +
                'class="max-w-xs px-4 py-3 rounded-xl border-2 ' +
                (secili ? 'border-marka-700 ' : 'border-slate-200 dark:border-slate-600 ') +
                'bg-white dark:bg-slate-900 font-extrabold">' + secenekler + '</select>' +
        '<button type="button" id="musteriSec" title="Ünvan, kimlik no, telefon ile ara" class="px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">🔍 Ara</button>' +
        '<button type="button" id="musteriYeni" class="px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">+ Yeni Müşteri</button>' +
        kunye +
        (!secili ? '<span class="text-sm text-slate-500 dark:text-slate-400">Sipariş yazmak için müşteri seçin.</span>' : '') +
      '</div>';

    baglaSerit();

    /* Liste henüz çekilmemişse arka planda çek ve şeridi tazele. */
    if (!durumM.yuklendi && plasiyerMi()) {
      listeyiHazirla().then(seridiCiz).catch(function () { /* çevrimdışı: yereller yeter */ });
    }
  }

  function baglaSerit() {
    var secim = el('musteriSecim');

    if (secim) {
      secim.addEventListener('change', function () {
        var m = musteriBul(secim.value);

        if (m) musteriSec(m);
        else musteriyiBirak();
      });
    }

    var sec = el('musteriSec');
    if (sec) sec.addEventListener('click', secimPerdesiniAc);

    var yeni = el('musteriYeni');
    if (yeni) yeni.addEventListener('click', yeniPerdesiniAc);

    var kopya = el('sonSiparisKopya');
    if (kopya) kopya.addEventListener('click', sonSiparisiKopyala);
  }

  /* ------------------------------------------------------------------ *
   *  MÜŞTERİ SEÇİM PENCERESİ (arama)
   * ------------------------------------------------------------------ */

  function perdeAc(icerik) {
    var perde = el('satisPerde');
    var modal = el('satisModal');

    if (!perde || !modal) return null;

    modal.innerHTML = icerik;
    perde.hidden = false;

    return modal;
  }

  function perdeKapat() {
    var perde = el('satisPerde');
    var modal = el('satisModal');

    if (perde) perde.hidden = true;
    if (modal) modal.innerHTML = '';
  }

  async function secimPerdesiniAc() {
    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div class="text-xl font-extrabold">Müşteri Seç</div>' +
        '<button type="button" id="satisKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +
      '<input id="musteriArama" type="search" autocomplete="off" placeholder="Ünvan, kimlik no, telefon ya da il…" ' +
             'class="mt-5 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
      '<div id="musteriListe" class="mt-4 max-h-80 overflow-y-auto">' +
        '<div class="py-6 text-center text-slate-500">Yükleniyor…</div>' +
      '</div>' +
      '<button type="button" id="musteriYeniAlt" class="mt-4 w-full px-5 py-3 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
        '+ Çevrimdışı Yeni Müşteri Ekle' +
      '</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);
    el('musteriYeniAlt').addEventListener('click', yeniPerdesiniAc);

    var arama = el('musteriArama');

    arama.addEventListener('input', function () {
      if (aramaSaat) window.clearTimeout(aramaSaat);

      aramaSaat = window.setTimeout(function () {
        durumM.arama = arama.value;
        listeyiCiz();
      }, 140);
    });

    await yerelleriYukle();

    var sonuc;

    try {
      sonuc = await musterileriGetir();
    } catch (e) {
      sonuc = { ok: false, hata: 'Sunucuya ulaşılamadı; yalnızca çevrimdışı müşteriler listeleniyor.' };
    }

    if (!sonuc.ok && !durumM.yereller.length) {
      el('musteriListe').innerHTML =
        '<div class="py-6 text-center text-amber-700 dark:text-amber-400 font-semibold">' + kacis(sonuc.hata) + '</div>';
      return;
    }

    listeyiCiz();
    arama.focus();
  }

  function listeyiCiz() {
    var kap = el('musteriListe');

    if (!kap) return;

    var liste = tumMusteriler();

    if (!liste.length) {
      kap.innerHTML = '<div class="py-6 text-center text-slate-500 dark:text-slate-400">Müşteri bulunamadı.</div>';
      return;
    }

    kap.innerHTML = liste.map(function (m) {
      var risk = Number(m.acikBakiye) || 0;

      return '<button type="button" class="musteri-satir w-full text-left px-4 py-3 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition border-b border-slate-100 dark:border-slate-700" ' +
              'data-id="' + kacis(String(m.id)) + '">' +
        '<div class="font-bold">' + kacis(m.unvan) +
          (Number(m.iskonto) > 0 ? ' <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs font-black">%' + kacis(yuzdeYaz(m.iskonto)) + '</span>' : '') +
          (m.gecici ? ' <span class="px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-black">ÇEVRİMDIŞI</span>' : '') +
        '</div>' +
        '<div class="text-xs text-slate-500 dark:text-slate-400">' +
          kacis([m.vergiNo, m.telefon, m.il, m.ilce].filter(Boolean).join(' · ') || '—') +
          (risk > 0 ? ' · <span class="text-red-600 font-bold">Borç ' + kacis(paraYaz(risk)) + '</span>' : '') +
        '</div>' +
      '</button>';
    }).join('');

    kap.onclick = function (olay) {
      var satir = olay.target.closest('.musteri-satir');

      if (!satir) return;

      var bulunan = musteriBul(satir.dataset.id);

      if (bulunan) musteriSec(bulunan);
    };
  }

  /**
   * Müşteriyi seçer: sepete bağlar, BAYİ İSKONTOSUNU uygular, fiyatları
   * yeniden çizer.
   *
   * @param {object} m         Müşteri.
   * @param {object} [secenek] { sessiz: true } → bildirim ve sekme değişimi yok.
   */
  function musteriSec(m, secenek) {
    secenek = secenek || {};

    durumM.secili = m;
    durumM.sonSiparis = null;

    M().musteriIskontosuUygula(sepet(), m, tavan());

    perdeKapat();
    seridiCiz();
    fiyatlariTazele();

    if (!secenek.sessiz && Number(m.acikBakiye) > 0) {
      bildir('Dikkat: ' + m.unvan + ' — açık bakiye ' + paraYaz(m.acikBakiye), 'uyari');
    }
  }

  /** Seçimi kaldırır: iskontolar sıfırlanır, vitrin liste fiyatına döner. */
  function musteriyiBirak() {
    durumM.secili = null;
    durumM.sonSiparis = null;

    M().musteriIskontosuUygula(sepet(), null, tavan());

    seridiCiz();
    fiyatlariTazele();
  }

  /* ------------------------------------------------------------------ *
   *  ÇEVRİMDIŞI YENİ MÜŞTERİ — ALGORİTMİK DOĞRULAMA (Faz 9)
   * ------------------------------------------------------------------ */

  function alan(id, etiket, tip, ek) {
    return '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="' + id + '">' + etiket + '</label>' +
      '<input id="' + id + '" type="' + tip + '" autocomplete="off" ' + (ek || '') +
             ' class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
      '<p id="' + id + 'Hata" class="hidden mt-1 text-xs font-semibold text-red-600 dark:text-red-400"></p>';
  }

  function yeniPerdesiniAc() {
    var t = tavan();

    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div>' +
          '<div class="text-xl font-extrabold">Yeni Müşteri</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' +
            'Çevrimdışı kaydedilir, eşitlemede sunucuya iletilir. Kimlik ve telefon algoritmik olarak denetlenir.' +
          '</div>' +
        '</div>' +
        '<button type="button" id="satisKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +

      alan('ymUnvan', 'Firma ünvanı *', 'text') +
      alan('ymYetkili', 'Yetkili ad soyad *', 'text') +
      alan('ymKimlik', 'Vergi No (10 hane) / TC Kimlik No (11 hane) *', 'text', 'inputmode="numeric" maxlength="11"') +
      alan('ymTelefon', 'Cep telefonu (05XX XXX XX XX) *', 'tel', 'inputmode="tel"') +
      alan('ymEposta', 'E-posta', 'email') +
      alan('ymIl', 'İl *', 'text') +
      alan('ymIlce', 'İlçe', 'text') +
      alan('ymIskonto', 'Bayi iskontosu (%) — en fazla %' + yuzdeYaz(t), 'number', 'min="0" max="' + t + '" step="0.5" value="0"') +

      '<div id="ymMukerrer" class="hidden mt-4 p-3 rounded-xl bg-amber-50 border-2 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200 text-sm font-semibold"></div>' +
      '<p id="ymHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
      '<button type="button" id="ymKaydet" class="mt-6 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">Kaydet ve Seç</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);
    el('ymKaydet').addEventListener('click', yeniKaydet);

    /* Kimlik kutusu yalnızca rakam alır (yapıştırma da süzülür). */
    var kimlik = el('ymKimlik');

    kimlik.addEventListener('input', function () {
      var temiz = kimlik.value.replace(/[^0-9]/g, '').slice(0, 11);
      if (temiz !== kimlik.value) kimlik.value = temiz;
    });

    el('ymUnvan').focus();
  }

  /** Formu okur — doğrulayıcının beklediği alan adlarıyla. */
  function formuOku() {
    return {
      firmaAdi: el('ymUnvan').value,
      yetkili: el('ymYetkili').value,
      kimlikNo: el('ymKimlik').value,
      telefon: el('ymTelefon').value,
      eposta: String((el('ymEposta') || {}).value || '').trim(),
      il: el('ymIl').value,
      ilce: el('ymIlce').value,
      iskonto: el('ymIskonto').value
    };
  }

  /** Alan hatalarını tek tek yazar; HEPSİ birden gösterilir. */
  function hatalariYaz(hatalar) {
    var eslesme = {
      firmaAdi: 'ymUnvan', yetkili: 'ymYetkili', kimlikNo: 'ymKimlik',
      telefon: 'ymTelefon', il: 'ymIl', iskonto: 'ymIskonto'
    };

    Object.keys(eslesme).forEach(function (anahtar) {
      var kutu = el(eslesme[anahtar]);
      var mesaj = el(eslesme[anahtar] + 'Hata');

      yaz(mesaj, hatalar[anahtar] || '');

      if (kutu) {
        kutu.classList.toggle('border-red-400', !!hatalar[anahtar]);
        kutu.setAttribute('aria-invalid', hatalar[anahtar] ? 'true' : 'false');
      }
    });
  }

  /**
   * YEREL MÜKERRER KONTROLÜ — aynı kimlik no ya da telefon eldeki listede
   * (sunucudan gelenler + çevrimdışı eklenenler) var mı?
   *
   * Zorunlu engel DEĞİL, bilgilendirme + tek tıkla mevcut kaydı seçme: son
   * sözü eşitlemede sunucu söyler (mevcut bayiyi bulur, yeni hesap açmaz).
   * Ama sahada yakalanan mükerrer, sunucuya hiç gitmeyen mükerrerdir.
   */
  function yerelMukerrerBul(temiz) {
    var kimlik = String(temiz.kimlikNo || '');
    var gsm = String(temiz.telefon || '');
    var dogrulama = D();

    return durumM.yereller.concat(durumM.musteriler).find(function (m) {
      var mKimlik = String(m.vergiNo || '').replace(/[^0-9]/g, '');

      if (kimlik && mKimlik && kimlik === mKimlik) return true;

      var mGsm = dogrulama ? dogrulama.gsmNormalle(m.telefon) : String(m.telefon || '').replace(/[^0-9]/g, '');

      return !!(gsm && mGsm && gsm === mGsm);
    }) || null;
  }

  async function yeniKaydet() {
    var dogrulama = D();
    var form = formuOku();

    if (!dogrulama) {
      yaz(el('ymHata'), 'Doğrulama motoru yüklenemedi; müşteri kaydedilemez.');
      return;
    }

    var denetim = dogrulama.musteriFormuDenetle(form, { iskontoTavani: tavan() });

    hatalariYaz(denetim.hatalar);

    if (!denetim.ok) {
      yaz(el('ymHata'), 'Eksik ya da hatalı alanlar var; işaretli kutuları düzeltin.');
      return;
    }

    yaz(el('ymHata'), '');

    var temiz = denetim.temiz;

    /* Mükerrer uyarısı: kullanıcı ikinci kez "Kaydet" derse yine de kaydeder
       (sunucu eşitlemede birleştirir). Uyarı kutusu seçme yolu da sunar. */
    var mukerrer = yerelMukerrerBul(temiz);
    var uyari = el('ymMukerrer');

    if (mukerrer && uyari && !uyari.dataset.gecildi) {
      uyari.innerHTML =
        'Bu kimlik no ya da telefon zaten kayıtlı: <b>' + kacis(mukerrer.unvan) + '</b>. ' +
        '<button type="button" id="ymMevcutSec" class="ml-2 px-3 py-1.5 rounded-lg bg-marka-700 text-white font-bold">Onu seç</button> ' +
        'ya da yine de yeni kayıt için tekrar Kaydet\'e basın.';
      uyari.classList.remove('hidden');
      uyari.dataset.gecildi = '1';

      var sec = el('ymMevcutSec');

      if (sec) {
        sec.addEventListener('click', function () {
          musteriSec(mukerrer);
          bildir('Mevcut müşteri seçildi: ' + mukerrer.unvan, 'ok');
        });
      }

      return;
    }

    var sonuc = M().geciciMusteri({
      unvan: temiz.firmaAdi,
      yetkili: temiz.yetkili,
      kimlikNo: temiz.kimlikNo,
      kimlikTuru: temiz.kimlikTuru,
      telefon: temiz.telefon,
      eposta: form.eposta,
      il: temiz.il,
      ilce: temiz.ilce,
      iskonto: temiz.iskonto
    });

    if (!sonuc.ok) {
      yaz(el('ymHata'), sonuc.hata);
      return;
    }

    var kaydedildi = await yerelMusteriKaydet(sonuc.musteri);

    if (!kaydedildi) {
      yaz(el('ymHata'), 'Müşteri yerel olarak kaydedilemedi.');
      return;
    }

    durumM.yereller.unshift(sonuc.musteri);

    musteriSec(sonuc.musteri);
    portfoyuCiz();

    bildir('Müşteri kaydedildi (' + (temiz.kimlikTuru || 'kimlik').toUpperCase() + ' doğrulandı).', 'ok');

    /* Çevrimiçiysek arka planda HEMEN sunucuya yaz — kullanıcı beklemez. */
    anindaEsitle(sonuc.musteri);
  }

  /**
   * ANINDA MÜŞTERİ EŞİTLEME (Faz 10) — Görsel 6: internet varken eklenen
   * müşteri bir sonraki 60 sn yoklamasına kadar "ÇEVRİMDIŞI" rozetiyle
   * kalıyordu. Cihaz çevrimiçiyse yerel kayıt yazıldıktan hemen sonra
   * `/plasiyer/musteri-esitle` tetiklenir; `user_id` gelince geçici kayıt
   * gerçek bayiye çevrilir, rozet kalkar.
   *
   * Sessiz başarısızlık: ağ yoksa ya da sunucu reddetmişse kayıt kuyrukta
   * bekler, olağan eşitleme turu (ya da hata sebebi) onu ele alır.
   */
  async function anindaEsitle(musteri) {
    if (!musteri || !M().geciciMi(musteri.id)) return;
    if ('undefined' !== typeof navigator && false === navigator.onLine) return;
    if (!plasiyerMi()) return;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('musteri:esitle-tek', { id: musteri.id });
    } catch (e) {
      return;
    }

    var yeniId = Number((cevap && cevap.user_id) || 0);

    if (!cevap || !cevap.ok || !yeniId) return;

    var gercek = Object.assign({}, musteri, {
      id: yeniId,
      gecici: false,
      senkron: true,
      gercekId: yeniId
    });

    durumM.yereller = durumM.yereller.filter(function (m) { return String(m.id) !== String(musteri.id); });
    durumM.musteriler = [gercek].concat(durumM.musteriler.filter(function (m) { return Number(m.id) !== yeniId; }));

    /* Seçili müşteri buysa sepet de gerçek kimliğe geçer. */
    if (durumM.secili && String(durumM.secili.id) === String(musteri.id)) {
      musteriSec(gercek, { sessiz: true });
    }

    if (durumM.profil && String(durumM.profil.id) === String(musteri.id)) {
      durumM.profil = gercek;
      profiliCiz(gercek);
    }

    portfoyuCiz();
    seridiCiz();

    bildir(cevap.tekrar
      ? 'Müşteri sunucudaki mevcut bayiyle eşleşti (#' + yeniId + ').'
      : 'Müşteri sunucuya kaydedildi ✓ (bayi #' + yeniId + ').', 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  SON SİPARİŞİ KOPYALA
   * ------------------------------------------------------------------ */

  async function sonSiparisiKopyala() {
    if (!durumM.secili) return bildir('Önce müşteri seçin.', 'uyari');

    /* Çevrimdışı eklenen müşterinin sunucuda siparişi olamaz. */
    if (M().geciciMi(durumM.secili.id)) {
      return bildir('Bu müşteri henüz sunucuda kayıtlı değil; geçmiş siparişi yok.', 'uyari');
    }

    var cevap = await window.woo('/orders', {
      sorgu: { customer: durumM.secili.id, per_page: 1, orderby: 'date', order: 'desc' }
    });

    if (!cevap || !cevap.ok || !Array.isArray(cevap.veri) || !cevap.veri.length) {
      return bildir('Bu müşterinin geçmiş siparişi bulunamadı.', 'uyari');
    }

    var siparis = cevap.veri[0];

    /*
     * Ürünleri YEREL KATALOGDAN çözüyoruz: motorun `urunBul` geri çağrısı
     * bugünün fiyatını verir. Siparişteki fiyat geçmişe aittir; onu kopyalamak
     * zam görmüş ürünü zararına satmak olurdu.
     */
    /* Katalog ekranda süzülü ya da hiç yüklenmemiş olabilir (Faz 12-B):
       kimlikler yerel indeksten çözülür, ağa çıkılmaz. */
    var harita = {};

    if (V() && 'function' === typeof V().urunleriCoz) {
      harita = await V().urunleriCoz((siparis.line_items || siparis.kalemler || []).map(function (k) {
        return Number((k && (k.product_id || k.id)) || 0);
      }));
    }

    var sonuc = M().sonSiparisiKopyala(siparis, function (pid) {
      return harita[pid] || yerelUrunBul(pid);
    }, sepet());

    durumM.sonSiparis = siparis;

    if (V()) V().sepetiCiz();

    var mesaj = sonuc.eklenen + ' kalem sepete eklendi.';

    if (sonuc.atlanan.length) {
      mesaj += ' ' + sonuc.atlanan.length + ' kalem katalogda bulunamadı: ' +
        sonuc.atlanan.map(function (a) { return a.ad; }).join(', ');
    }

    bildir(mesaj, sonuc.atlanan.length ? 'uyari' : 'ok');
  }

  /**
   * Ürünü açık vitrinden arar. Senkron olmak ZORUNDA (motor senkron çağırıyor);
   * vitrinde olmayan kalem "katalogda yok" sayılır ve bildirilir.
   */
  function yerelUrunBul(id) {
    if (V()) {
      var u = V().urunBul(id);
      if (u) return u;
    }

    return null;
  }

  /* ------------------------------------------------------------------ *
   *  SİPARİŞİ TAMAMLA — BİLEŞİK İSKONTO ÖZETİ
   * ------------------------------------------------------------------ */

  function tamamlamaAc() {
    var s = sepet();

    if (!s.satirlar.length) return bildir('Sepet boş.', 'uyari');
    if (!durumM.secili) return bildir('Önce müşteri seçin.', 'uyari');

    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div>' +
          '<div class="text-xl font-extrabold">Siparişi Tamamla</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' + kacis(durumM.secili.unvan) + '</div>' +
        '</div>' +
        '<button type="button" id="satisKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +

      /* ÖDEME — ÜÇ SEÇENEK, fazlası yok (şirket politikası). Her düğme o
         yöntemin iskontosunu da söyler: seçim tutarı DEĞİŞTİRİR. */
      '<div class="mt-6 text-sm font-bold text-slate-600 dark:text-slate-300">Ödeme Yöntemi *</div>' +
      '<div class="mt-2 grid grid-cols-3 gap-2">' +
        M().ODEME_YONTEMLERI.map(function (y) {
          var oran = M().odemeIskontosu(durumM.secili, y);

          return '<button type="button" class="odeme-sec px-4 py-4 rounded-xl border-2 font-extrabold transition ' +
            (s.odeme === y
              ? 'bg-marka-700 text-white border-marka-700'
              : 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700') +
            '" data-odeme="' + y + '">' + kacis(M().ODEME_ETIKET[y]) +
            (oran > 0 ? '<span class="block text-xs font-bold opacity-80">%' + kacis(yuzdeYaz(oran)) + ' iskonto</span>' : '') +
          '</button>';
        }).join('') +
      '</div>' +

      '<label class="block mt-5 text-sm font-bold text-slate-600 dark:text-slate-300" for="vadeNotu">' +
        'Vade Şartı / Şirket Politikası Notu <span class="font-normal opacity-70">(isteğe bağlı)</span>' +
      '</label>' +
      '<textarea id="vadeNotu" rows="2" placeholder="Örn: Vadeli siparişler 30 gün içinde nakden tahsil edilir." ' +
                'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900">' + kacis(s.vadeNotu || '') + '</textarea>' +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="siparisNotu">' +
        'Sevkiyat / Sipariş Notu <span class="font-normal opacity-70">(isteğe bağlı)</span>' +
      '</label>' +
      '<textarea id="siparisNotu" rows="2" placeholder="Örn: Sabah 09:00 öncesi teslim." ' +
                'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900">' + kacis(s.siparisNotu || '') + '</textarea>' +

      /* BAYİ İSKONTOSU — müşterinin oranıyla gelir, tavan açıkça yazılır. */
      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="iskontoOran">' +
        'Bayi İskontosu (%) <span class="font-normal opacity-70">— en fazla %' + kacis(yuzdeYaz(tavan())) + '</span>' +
      '</label>' +
      '<input id="iskontoOran" type="number" min="0" max="' + tavan() + '" step="0.5" value="' + (Number(s.iskonto) || 0) + '" ' +
             'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold" />' +

      '<div id="tamamlaOzet" class="mt-5 p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 space-y-1"></div>' +
      '<p id="tamamlaHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
      '<button type="button" id="tamamlaGonder" class="mt-5 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">' +
        'Siparişi Kaydet' +
      '</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);

    modal.querySelectorAll('.odeme-sec').forEach(function (d) {
      d.addEventListener('click', function () {
        M().odemeSec(s, d.dataset.odeme);   // yöntem + ödeme iskontosu birlikte
        fiyatlariTazele();
        tamamlamaAc();                       // yeniden çiz (seçim ve tutar görünsün)
      });
    });

    el('vadeNotu').addEventListener('input', function () { s.vadeNotu = this.value; });
    el('siparisNotu').addEventListener('input', function () { s.siparisNotu = this.value; });

    var iskonto = el('iskontoOran');

    iskonto.addEventListener('change', function () {
      var karar = M().iskontoYaz(s, iskonto.value, tavan());

      if (!karar.ok) {
        yaz(el('tamamlaHata'), karar.hata);
        iskonto.value = karar.tavan;   // TAVANA kırp
      } else {
        yaz(el('tamamlaHata'), '');
      }

      ozetiCiz();
      fiyatlariTazele();
      seridiCiz();
    });

    el('tamamlaGonder').addEventListener('click', gonder);

    ozetiCiz();

    function ozetiCiz() {
      var g = M().toplamlar(s, tavan());
      var kutu = el('tamamlaOzet');

      if (!kutu) return;

      kutu.innerHTML =
        '<div class="flex justify-between"><span>Kalem</span><span class="font-bold">' + g.satir + ' satır · ' + g.kalem + ' adet' + (g.koli ? ' · ' + g.koli + ' koli' : '') + '</span></div>' +
        '<div class="flex justify-between"><span>Liste toplamı</span><span class="font-bold">' + kacis(paraYaz(g.araToplam)) + '</span></div>' +
        (g.indirim > 0 ? '<div class="flex justify-between text-emerald-700 dark:text-emerald-400"><span>Bayi iskontosu %' + kacis(yuzdeYaz(g.iskontoOrani)) + '</span><span class="font-bold">−' + kacis(paraYaz(g.indirim)) + '</span></div>' : '') +
        (g.odemeIndirim > 0 ? '<div class="flex justify-between text-emerald-700 dark:text-emerald-400"><span>' + kacis(M().ODEME_ETIKET[s.odeme] || 'Ödeme') + ' iskontosu %' + kacis(yuzdeYaz(g.odemeIskontoOrani)) + '</span><span class="font-bold">−' + kacis(paraYaz(g.odemeIndirim)) + '</span></div>' : '') +
        '<div class="flex justify-between text-lg font-black"><span>Net toplam</span><span>' + kacis(paraYaz(g.genelToplam)) + '</span></div>' +
        (g.indirim > 0 || g.odemeIndirim > 0
          ? '<div class="text-xs text-slate-500 dark:text-slate-400">Net = Liste × (1 − bayi/100) × (1 − ödeme/100)</div>'
          : '');
    }
  }

  async function gonder() {
    var s = sepet();

    var denetim = M().siparisDenetle(s, tavan());

    if (!denetim.ok) {
      yaz(el('tamamlaHata'), denetim.hatalar.join(' '));
      return;
    }

    var govde = M().siparisGovdesi(s, oturum(), tavan());

    /*
     * KUYRUĞA YAZIM ANA SÜREÇTE (`siparis:kuyruga`): tek ekleme, oku-değiştir-yaz
     * yok. Eşitleme (online / 60 sn yoklama / açılış) kuyruğu aynı anda
     * temizliyor olabilir; renderer'ın eski fotoğrafını geri basmak gönderilmiş
     * bir siparişi "bekliyor" diye diriltirdi. Gövde `yerelKimlik` taşır: aynı
     * kayıt ağ kesintisinde iki kez gitse sunucu ikinciyi var olana bağlar.
     */
    var dugme = el('tamamlaGonder');

    if (dugme) dugme.disabled = true;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('siparis:kuyruga', govde);
    } catch (e) {
      cevap = null;
    }

    if (dugme) dugme.disabled = false;

    if (!cevap || !cevap.ok) {
      yaz(el('tamamlaHata'), (cevap && cevap.hata) || 'Sipariş yerel kuyruğa yazılamadı.');
      return;
    }

    perdeKapat();

    /* Sepet boşalır; MÜŞTERİ SEÇİLİ KALIR (aynı bayiye ikinci sipariş sık
       görülen akış). Ödeme yöntemi ve notlar sıfırlanır — sipariş başına karar. */
    M().bosalt(s);
    M().odemeSec(s, '');
    s.vadeNotu = '';
    s.siparisNotu = '';

    fiyatlariTazele();
    kuyrukSeridiniCiz();

    bildir('Sipariş yerel kuyruğa kaydedildi (' + govde.kalemler.length + ' kalem, net ' + paraYaz(govde.toplamlar.genelToplam) + '). Eşitlemede sunucuya gönderilecek.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  KENDİ SİPARİŞLERİM — ÇEVRİMDIŞI KUYRUK ŞERİDİ (Faz 9)
   * ------------------------------------------------------------------ */

  function kuyrukMusteriAdi(kayit) {
    if (!kayit) return '—';
    if (kayit.geciciMusteri && kayit.geciciMusteri.unvan) return kayit.geciciMusteri.unvan;

    var m = musteriBul(kayit.musteriId);

    return m ? m.unvan : ('Müşteri #' + kayit.musteriId);
  }

  function zamanYaz(iso) {
    try {
      var t = new Date(iso);
      if (isNaN(t.getTime())) return '';
      return t.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  /**
   * Bekleyen / hatalı siparişleri Kendi Siparişlerim'in tepesine yazar.
   *
   * Kaynak `ayarlar.json → plasiyerSiparisKuyrugu`; gönderilenler zaten
   * düşmüş olur (main.js § 3.8). Kalıcı hatalı kayıt SEBEBİYLE görünür —
   * sahadaki plasiyer "gitti sandım" demesin.
   */
  async function kuyrukSeridiniCiz() {
    var kap = el('plasiyerKuyrukKab');

    if (!kap) return;

    if (!plasiyerMi()) {
      kap.innerHTML = '';
      return;
    }

    var kuyruk = [];

    try {
      var ayar = await ipcRenderer.invoke('ayar:oku');
      kuyruk = (ayar && Array.isArray(ayar.plasiyerSiparisKuyrugu)) ? ayar.plasiyerSiparisKuyrugu : [];
    } catch (e) { kuyruk = []; }

    var Sync = window.PlasiyerSyncMotor;
    var bekleyen = kuyruk.filter(function (k) { return k && k.kayit && (!Sync || Sync.GONDERILDI !== k.durum); });

    if (!bekleyen.length) {
      kap.innerHTML =
        '<div class="flex items-center gap-3 px-4 py-3 rounded-2xl bg-emerald-50 text-emerald-800 border-2 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 font-bold">' +
          '✓ Çevrimdışı bekleyen sipariş yok — yazdığınız her sipariş sunucuya iletildi.' +
        '</div>';
      return;
    }

    var hatali = bekleyen.filter(function (k) { return Sync && Sync.KALICI_HATA === k.durum; }).length;

    kap.innerHTML =
      '<div class="rounded-2xl border-2 ' + (hatali ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-700') + ' bg-white dark:bg-slate-800 p-4">' +
        '<div class="flex items-center gap-3 flex-wrap mb-3">' +
          '<div class="font-extrabold text-lg">📦 Çevrimdışı kuyruk: ' + bekleyen.length + ' sipariş' +
            (hatali ? ' <span class="text-red-600">(' + hatali + ' hatalı)</span>' : '') + '</div>' +
          '<button type="button" id="kuyrukEsitle" class="ml-auto px-4 py-2 rounded-xl bg-marka-700 text-white font-extrabold hover:bg-marka-600 transition">⟳ Şimdi Eşitle</button>' +
        '</div>' +
        '<div class="flex flex-col gap-2">' +
          bekleyen.map(function (k) {
            var kalici = Sync && Sync.KALICI_HATA === k.durum;
            var t = (k.kayit && k.kayit.toplamlar) || {};

            return '<div class="flex items-start gap-3 flex-wrap px-3 py-2 rounded-xl ' + (kalici ? 'bg-red-50 dark:bg-red-950/30' : 'bg-amber-50 dark:bg-amber-950/30') + '">' +
              '<div class="min-w-0 flex-1">' +
                '<div class="font-bold">' + kacis(kuyrukMusteriAdi(k.kayit)) +
                  ' <span class="text-xs font-semibold text-slate-500">' + kacis(zamanYaz(k.zaman)) + '</span></div>' +
                '<div class="text-sm text-slate-600 dark:text-slate-300">' +
                  ((k.kayit.kalemler || []).length) + ' kalem · net ' + kacis(paraYaz(t.genelToplam || 0)) +
                  ' · ' + kacis(M().ODEME_ETIKET[k.kayit.odeme] || k.kayit.odeme || '') +
                '</div>' +
                (k.hata ? '<div class="text-xs font-semibold ' + (kalici ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300') + '">' + (kalici ? '⛔ ' : '⏳ ') + kacis(k.hata) + '</div>' : '') +
              '</div>' +
              '<span class="px-2 py-1 rounded-lg text-xs font-black ' + (kalici ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-950') + '">' +
                (kalici ? 'KİLİTLİ' : 'BEKLİYOR') + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';

    var dugme = el('kuyrukEsitle');

    if (dugme) {
      dugme.addEventListener('click', async function () {
        dugme.disabled = true;

        try {
          if (window.PlasiyerOtoSync && 'function' === typeof window.PlasiyerOtoSync.dene) {
            await window.PlasiyerOtoSync.dene('elle');
          }
        } finally {
          dugme.disabled = false;
        }

        kuyrukSeridiniCiz();

        /* Sunucudaki kendi sipariş listesi de tazelenir (Faz 10 şablonu). */
        if (window.PlasiyerSiparislerim && 'function' === typeof window.PlasiyerSiparislerim.yenile) {
          window.PlasiyerSiparislerim.yenile();
        }
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  MÜŞTERİLERİM — PORTFÖY VE PROFİL (Faz 9)
   * ------------------------------------------------------------------ */

  function kimlikYaz(m) {
    if (!m.vergiNo) return '';

    var tur = m.kimlikTuru ? m.kimlikTuru.toUpperCase() : (11 === String(m.vergiNo).length ? 'TCKN' : 'VKN');

    return tur + ' ' + m.vergiNo;
  }

  function portfoyuCiz() {
    var kap = el('musterilerimKab');
    var ozet = el('musterilerimOzet');

    if (!kap) return;

    var hepsi = durumM.yereller.concat(durumM.musteriler);
    var liste = suz(hepsi, durumM.portfoyArama);

    if (ozet) {
      ozet.textContent = hepsi.length
        ? (hepsi.length + ' müşteri' + (durumM.yereller.length ? ' · ' + durumM.yereller.length + ' çevrimdışı' : ''))
        : 'müşteri yok';
    }

    if (!liste.length) {
      kap.innerHTML =
        '<div class="col-span-full py-12 text-center bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700">' +
          '<div class="text-5xl mb-4" aria-hidden="true">👥</div>' +
          '<div class="text-xl font-bold">' + (hepsi.length ? 'Aramaya uyan müşteri yok' : 'Henüz müşteriniz yok') + '</div>' +
          '<p class="mt-2 text-slate-500 dark:text-slate-400">"+ Yeni Müşteri" ile sahada kayıt açın; kimlik ve telefon anında doğrulanır.</p>' +
        '</div>';
      return;
    }

    kap.innerHTML = liste.map(function (m) {
      var risk = Number(m.acikBakiye) || 0;
      var acik = durumM.profil && String(durumM.profil.id) === String(m.id);

      return '<div class="musteri-kart bg-white dark:bg-slate-800 rounded-2xl border-2 ' +
                (acik ? 'border-marka-700' : 'border-slate-200 dark:border-slate-700') + ' p-4 flex flex-col gap-2" data-id="' + kacis(String(m.id)) + '">' +
        '<div class="flex items-start gap-2">' +
          '<div class="font-extrabold text-lg leading-snug flex-1 min-w-0">' + kacis(m.unvan) + '</div>' +
          (m.gecici ? '<span class="px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-black shrink-0">ÇEVRİMDIŞI</span>' : '') +
        '</div>' +
        '<div class="text-sm text-slate-500 dark:text-slate-400">' +
          kacis([kimlikYaz(m), m.telefon, [m.il, m.ilce].filter(Boolean).join('/')].filter(Boolean).join(' · ') || '—') +
        '</div>' +
        '<div class="flex items-center gap-2 flex-wrap text-xs font-bold">' +
          '<span class="px-2 py-1 rounded-lg bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Bayi %' + kacis(yuzdeYaz(m.iskonto)) + '</span>' +
          (risk > 0
            ? '<span class="px-2 py-1 rounded-lg bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">Borç ' + kacis(paraYaz(risk)) + '</span>'
            : '<span class="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">Bakiye temiz</span>') +
        '</div>' +
        '<div class="mt-1 flex gap-2 flex-wrap">' +
          '<button type="button" class="mk-siparis px-3 py-2 rounded-lg bg-marka-700 text-white font-bold text-sm hover:bg-marka-600" data-id="' + kacis(String(m.id)) + '">🛍️ Sipariş Yaz</button>' +
          '<button type="button" class="mk-not px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + kacis(String(m.id)) + '" title="İsteğe bağlı — patrona not bırakın">📝 Ziyaret Notu</button>' +
          /* HIZLI TEKRAR SİPARİŞ (Faz 12): müşterinin son siparişi BUGÜNÜN fiyatıyla
             sepete dolar ve satış ekranı açılır. Çevrimdışı müşterinin sunucuda
             geçmişi olamaz — düğme gösterilmez. */
          (m.gecici
            ? ''
            : '<button type="button" class="mk-tekrar px-3 py-2 rounded-lg border-2 border-emerald-300 text-emerald-800 dark:border-emerald-500/40 dark:text-emerald-300 font-bold text-sm hover:bg-emerald-50 dark:hover:bg-emerald-500/10" data-id="' + kacis(String(m.id)) + '" title="Son siparişi bugünün fiyatıyla sepete doldur">🔁 Tekrar Sipariş</button>') +
          '<button type="button" class="mk-profil px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + kacis(String(m.id)) + '">Profil</button>' +
          /* Yalnızca henüz sunucuya gitmemiş kayıt silinebilir (Faz 11). Metinde
             "ÇEVRİMDIŞI" geçmez — eşitleme testi rozetin kalktığını o sözcükle ölçer. */
          (m.gecici
            ? '<button type="button" class="mk-sil px-3 py-2 rounded-lg border-2 border-red-300 text-red-700 dark:border-red-500/40 dark:text-red-300 font-bold text-sm hover:bg-red-50 dark:hover:bg-red-500/10" data-id="' + kacis(String(m.id)) + '" title="Henüz sunucuya gitmemiş bu kaydı cihazdan siler.">🗑️ Sil</button>'
            : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  /** Müşteriye ait ziyaret notları (PlasiyerZiyaret belleğinden). */
  function musteriNotlari(m) {
    var Z = window.PlasiyerZiyaret;
    var notlar = (Z && Z.durum && Array.isArray(Z.durum.notlar)) ? Z.durum.notlar : [];

    return notlar.filter(function (n) {
      if (!n) return false;
      if (String(n.musteriId || '') && String(n.musteriId) === String(m.id)) return true;
      return !!(n.musteriAdi && m.unvan && n.musteriAdi === m.unvan);
    });
  }

  /** Müşterinin sunucudaki siparişleri (renderer.js'in yüklediği listeden). */
  function musteriSiparisleri(m) {
    var liste = (window.durum && Array.isArray(window.durum.siparisler)) ? window.durum.siparisler : [];

    return liste.filter(function (s) { return s && Number(s.bayiId) === Number(m.id); }).slice(0, 5);
  }

  function profiliCiz(m) {
    var kap = el('musteriProfilKab');

    if (!kap) return;

    if (!m) {
      kap.hidden = true;
      kap.innerHTML = '';
      return;
    }

    var notlar = musteriNotlari(m);
    var siparisler = musteriSiparisleri(m);
    var Z = window.PlasiyerZiyaret;

    kap.hidden = false;
    kap.innerHTML =
      '<div class="flex items-start justify-between gap-4 flex-wrap">' +
        '<div>' +
          '<div class="text-2xl font-black">' + kacis(m.unvan) +
            (m.gecici ? ' <span class="px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-black align-middle">ÇEVRİMDIŞI</span>' : '') +
          '</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' +
            kacis([m.ad && m.ad !== m.unvan ? 'Yetkili: ' + m.ad : '', kimlikYaz(m), m.telefon, m.eposta, [m.il, m.ilce].filter(Boolean).join('/')].filter(Boolean).join(' · ')) +
          '</div>' +
        '</div>' +
        '<button type="button" id="profilKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +
      '<div class="mt-4 grid gap-4 md:grid-cols-3">' +
        '<div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50">' +
          '<div class="text-xs font-bold text-slate-500">BAYİ İSKONTOSU</div>' +
          '<div class="text-2xl font-black">%' + kacis(yuzdeYaz(m.iskonto)) + '</div>' +
          '<div class="text-xs text-slate-500 mt-1">Ödeme: ' +
            M().ODEME_YONTEMLERI.map(function (y) { return kacis(M().ODEME_ETIKET[y]) + ' %' + kacis(yuzdeYaz(M().odemeIskontosu(m, y))); }).join(' · ') +
          '</div>' +
        '</div>' +
        '<div class="p-4 rounded-xl ' + (Number(m.acikBakiye) > 0 ? 'bg-red-50 dark:bg-red-950/30' : 'bg-slate-50 dark:bg-slate-900/50') + '">' +
          '<div class="text-xs font-bold text-slate-500">AÇIK BAKİYE</div>' +
          '<div class="text-2xl font-black">' + kacis(paraYaz(m.acikBakiye)) + '</div>' +
        '</div>' +
        '<div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 flex flex-col gap-2">' +
          '<button type="button" id="profilSiparis" class="px-4 py-3 rounded-xl bg-marka-700 text-white font-extrabold hover:bg-marka-600">🛍️ Bu Müşteriye Sipariş Yaz</button>' +
          '<button type="button" id="profilNot" class="px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700">📝 Saha Ziyaret Notu <span class="font-normal opacity-70">(isteğe bağlı)</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="mt-5 grid gap-5 md:grid-cols-2">' +
        '<div>' +
          '<div class="font-extrabold mb-2">Son siparişler</div>' +
          (siparisler.length
            ? siparisler.map(function (s) {
                return '<div class="flex justify-between gap-3 py-2 border-t border-slate-100 dark:border-slate-700 text-sm">' +
                  '<span class="font-bold">#' + kacis(s.numara) + '</span>' +
                  '<span class="text-slate-500">' + kacis(String(s.durumEtiketi || s.durum || '')) + '</span>' +
                  '<span class="font-black">' + kacis(paraYaz(s.tutar)) + '</span>' +
                '</div>';
              }).join('')
            : '<div class="text-sm text-slate-500">Yüklü sipariş listesinde bu müşterinin kaydı yok.</div>') +
        '</div>' +
        '<div>' +
          '<div class="font-extrabold mb-2">Ziyaret notları</div>' +
          (notlar.length && Z && 'function' === typeof Z.zilKarti
            ? notlar.slice(0, 5).map(function (n) { return Z.zilKarti(n); }).join('')
            : '<div class="text-sm text-slate-500">Bu müşteri için not yok. Not bırakmak ZORUNLU DEĞİLDİR.</div>') +
        '</div>' +
      '</div>';

    el('profilKapat').addEventListener('click', function () {
      durumM.profil = null;
      profiliCiz(null);
      portfoyuCiz();
    });

    el('profilSiparis').addEventListener('click', function () { siparisYazmayaGec(m); });
    el('profilNot').addEventListener('click', function () { ziyaretNotuAc(m); });
  }

  /** Müşteriyi seçip Katalog & Satış'a geçer. */
  /** Tek tık tekrar sipariş (Faz 12): müşteriyi seç → son siparişi kopyala → satışa geç. */
  async function tekrarSiparisGec(m) {
    musteriSec(m, { sessiz: true });

    await sonSiparisiKopyala();

    if ('function' === typeof window.sekmeAc) window.sekmeAc('satis');
  }

  function siparisYazmayaGec(m) {
    musteriSec(m, { sessiz: true });

    if ('function' === typeof window.sekmeAc) window.sekmeAc('satis');

    if (Number(m.acikBakiye) > 0) bildir('Dikkat: ' + m.unvan + ' — açık bakiye ' + paraYaz(m.acikBakiye), 'uyari');
  }

  /** Ziyaret notu penceresi — PlasiyerZiyaret seçili müşteriyi okur. */
  function ziyaretNotuAc(m) {
    musteriSec(m, { sessiz: true });

    if (window.PlasiyerZiyaret && 'function' === typeof window.PlasiyerZiyaret.formuAc) {
      window.PlasiyerZiyaret.formuAc();
    }
  }

  function portfoyuBagla() {
    if (portfoyBagli) return;

    var kap = el('musterilerimKab');

    if (!kap) return;

    portfoyBagli = true;

    kap.addEventListener('click', function (olay) {
      var hedef = olay.target.closest('button[data-id], .musteri-kart');

      if (!hedef) return;

      var m = musteriBul(hedef.dataset.id);

      if (!m) return;

      if (hedef.classList.contains('mk-siparis')) return siparisYazmayaGec(m);
      if (hedef.classList.contains('mk-not')) return ziyaretNotuAc(m);
      if (hedef.classList.contains('mk-sil')) return yerelMusteriSil(m);
      if (hedef.classList.contains('mk-tekrar')) return tekrarSiparisGec(m);

      /* Profil düğmesi ya da kartın kendisi → profil */
      durumM.profil = m;
      profiliCiz(m);
      portfoyuCiz();
    });

    var arama = el('musterilerimArama');

    if (arama) {
      arama.addEventListener('input', function () {
        durumM.portfoyArama = arama.value;
        portfoyuCiz();
      });
    }

    var yenile = el('musterilerimYenile');
    if (yenile) yenile.addEventListener('click', function () { durumM.yuklendi = false; portfoyuAc(); });

    var yeni = el('musterilerimYeni');
    if (yeni) yeni.addEventListener('click', yeniPerdesiniAc);
  }

  /** "Müşterilerim" sekmesi açılınca. */
  async function portfoyuAc() {
    portfoyuBagla();
    portfoyuCiz();   // eldekiyle hemen çiz

    await listeyiHazirla();

    portfoyuCiz();

    if (durumM.profil) {
      var tazesi = musteriBul(durumM.profil.id);
      profiliCiz(tazesi || null);
    }
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function kur() {
    if (bagli) return;
    bagli = true;

    /* Esc: satış penceresini kapat. */
    document.addEventListener('keydown', function (olay) {
      var perde = el('satisPerde');

      if ('Escape' === olay.key && perde && !perde.hidden) perdeKapat();
    });

    yerelleriYukle();

    /*
     * `sekmeAc` SARILIR (renderer.js'e dokunmadan): Müşterilerim açılınca
     * portföy, Kendi Siparişlerim açılınca kuyruk şeridi çizilir. Eski
     * 'notlarim' adı geriye dönük olarak Müşterilerim'e yönlenir.
     */
    if ('function' === typeof window.sekmeAc) {
      var ozgun = window.sekmeAc;

      window.sekmeAc = function (ad) {
        if ('notlarim' === ad) {
          ad = 'musterilerim';
          arguments[0] = 'musterilerim';
        }

        var sonuc = ozgun.apply(this, arguments);

        if ('musterilerim' === ad) portfoyuAc();
        /* Kuyruk şeridi Faz 10'da 'siparislerim' şablonuna taşındı;
           plasiyer-siparislerim.js kendi sarmalında çizer. */

        return sonuc;
      };
    }
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.PlasiyerMusteri = {
    seridiCiz: seridiCiz,
    secimPerdesiniAc: secimPerdesiniAc,
    yeniPerdesiniAc: yeniPerdesiniAc,
    yeniKaydet: yeniKaydet,
    sonSiparisiKopyala: sonSiparisiKopyala,
    tamamlamaAc: tamamlamaAc,
    musteriSec: musteriSec,
    /* Tekrar sipariş portföydeki GERÇEK kaydı arar (ödeme iskontoları orada). */
    musteriBul: musteriBul,
    musteriyiBirak: musteriyiBirak,
    musterileriGetir: musterileriGetir,
    portfoyuAc: portfoyuAc,
    portfoyuCiz: portfoyuCiz,
    profiliCiz: profiliCiz,
    kuyrukSeridiniCiz: kuyrukSeridiniCiz,
    anindaEsitle: anindaEsitle,
    yerelMusteriSil: yerelMusteriSil,
    /* Saha haritası bayi kartı kısayolları (Faz 12): aynı akış, ikinci kopya yok. */
    siparisYazmayaGec: siparisYazmayaGec,
    ziyaretNotuAc: ziyaretNotuAc,
    tekrarSiparisGec: tekrarSiparisGec,
    yerelMukerrerBul: yerelMukerrerBul,
    durum: durumM,
    YEREL_ANAHTAR: YEREL_ANAHTAR
  };
})();
