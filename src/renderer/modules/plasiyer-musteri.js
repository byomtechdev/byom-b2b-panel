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
    profil: null,        // Müşterilerim'de açık profil
    /*
     * Ödeme yöntemi iskontosu varsayılanı (eklenti 2.21.0) — sahada AÇILAN,
     * henüz WordPress kimliği olmayan müşteri için KURUMSAL satır.
     * null = sunucu göndermedi (eski eklenti) → tablo boş kalır, uydurulmaz.
     */
    odemeVarsayilan: null,
    /* Matris anahtarı açık mı? null = bilinmiyor (eski eklenti).
       Üç oran da 0 iken "kapalı mı, sıfır mı" ayrımı bununla yapılır. */
    odemeMatrisiAcik: null
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

  /** Çizgi ikon (index.html › window.ikon). Yoksa boş — emoji yedeği yok (Faz 20). */
  function ikonHtml(ad) {
    return 'function' === typeof window.ikon ? window.ikon(ad) : '';
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

      /*
       * ÖDEME İSKONTOSU VARSAYILANI (eklenti 2.21.0).
       *
       * Sahada açılan müşterinin WordPress kimliği yoktur; sunucu onun için
       * oran üretemiyordu ve panel üç yöntemi de %0 gösteriyordu. Sunucu artık
       * KURUMSAL satırı ayrıca gönderiyor (eşitlenen saha müşterisi bayi olur).
       * `odemeMatrisiAcik` ayrı bir sorudur: üç oran da 0 iken "matris kapalı
       * mı, oranlar mı 0" ayrımını yapıp kullanıcıya SEBEBİNİ söyleyebilelim.
       */
      durumM.odemeVarsayilan = (cevap.veri && cevap.veri.odemeIskontolariVarsayilan &&
                                'object' === typeof cevap.veri.odemeIskontolariVarsayilan)
        ? cevap.veri.odemeIskontolariVarsayilan
        : null;

      durumM.odemeMatrisiAcik = (cevap.veri && undefined !== cevap.veri.odemeMatrisiAcik)
        ? !!cevap.veri.odemeMatrisiAcik
        : null;   // null = eski eklenti, bilinmiyor

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
          /* ÖDEME YÖNTEMİ YETKİLERİ (Faz 19) — yönetici bu bayiye bir yöntemi
             kapattıysa düğmesi saha ekranında HİÇ basılmaz. Alan yoksa (eski
             eklenti) null kalır ve motor üç yöntemi de açık sayar. */
          odemeIzinleri: (b.odemeIzinleri && 'object' === typeof b.odemeIzinleri) ? b.odemeIzinleri : null,
          /* Bayiye özel oran/yetki VAR: sıfır oranlar BİLİNÇLİDİR, oturum
             varsayılanıyla doldurulmaz (odemeTablosunuTamamla). */
          odemeOzelAyar: !!b.odemeOzelAyar,
          /* TESLİM ŞUBELERİ (Faz 16-E) — bayi yükünde gelir; müşteri seçilir
             seçilmez kutu dolsun diye ikinci istek atılmaz. Eski eklenti
             alanı göndermez: boş dizi kalır ve kutu hiç basılmaz. */
          subeler: Array.isArray(b.subeler) ? b.subeler : [],
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

    var secenekler = '<option value="">Müşteri seçin…</option>' +
      hepsi.map(function (m) {
        return '<option value="' + kacis(String(m.id)) + '"' +
          (secili && String(secili.id) === String(m.id) ? ' selected' : '') + '>' +
          kacis(musteriEtiketi(m)) + '</option>';
      }).join('');

    var kunye = '';

    if (secili) {
      var risk = Number(secili.acikBakiye) || 0;

      /* Künye ÇİP olarak (Faz 20): bilgi, eylem değil — düğmelerden görsel olarak ayrışsın. */
      kunye =
        '<span class="pv-cip">' +
          kacis([secili.kimlikTuru ? secili.kimlikTuru.toUpperCase() + ' ' : '', secili.vergiNo].join('') || '') +
          (secili.il ? ' · ' + kacis(secili.il) : '') +
        '</span>' +
        '<span class="pv-cip pv-cip--iyi" title="Bayi iskontosu — fiyatlar buna göre net gösterilir">' +
          'Bayi %' + yuzdeYaz(sepet().iskonto) +
        '</span>' +
        (risk > 0
          ? '<span class="pv-cip pv-cip--risk">' + ikonHtml('uyari') + ' Açık bakiye: ' + kacis(paraYaz(risk)) + '</span>'
          : '<span class="pv-cip pv-cip--iyi">' + ikonHtml('onay') + ' Bakiye temiz</span>') +
        '<button type="button" id="sonSiparisKopya" class="dg dg-ikincil">' +
          ikonHtml('kopyala') + ' Son Siparişi Sepete Kopyala' +
        '</button>';
    }

    kap.innerHTML =
      '<div class="flex items-center gap-2 flex-wrap">' +
        /* Terminalin en önemli denetimi: 44px, geniş, seçiliyken mavi çerçeve. */
        '<select id="musteriSecim" aria-label="Müşteri seç" ' +
                'class="rounded-xl border-2 ' +
                (secili ? 'border-marka-700 ' : 'border-slate-200 dark:border-slate-600 ') +
                'bg-white dark:bg-slate-900">' + secenekler + '</select>' +
        '<button type="button" id="musteriSec" title="Ünvan, kimlik no, telefon ile ara" class="dg dg-ikincil dg-b">' + ikonHtml('ara') + ' Ara</button>' +
        '<button type="button" id="musteriYeni" class="dg dg-ikincil dg-b">' + ikonHtml('arti') + ' Yeni Müşteri</button>' +
        kunye +
        (!secili ? '<span class="metin-ikincil">Sipariş yazmak için müşteri seçin.</span>' : '') +
      '</div>' +
      subeSeridiHtml(secili);

    baglaSerit();

    /* Liste henüz çekilmemişse arka planda çek ve şeridi tazele. */
    if (!durumM.yuklendi && plasiyerMi()) {
      listeyiHazirla().then(seridiCiz).catch(function () { /* çevrimdışı: yereller yeter */ });
    }
  }

  /* ------------------------------------------------------------------ *
   *  TESLİM ŞUBESİ (Faz 16-E)
   *  ---------------------------------------------------------------------
   *  "Pazarlamacı ana müşteriye gidiyor ama malı onun alt şubesine teslim
   *  edecek." Sipariş TEMELDE ANA CARİYE yazılır; şube yalnızca teslimat
   *  noktasıdır ve sunucuya `subeId` olarak gider.
   *
   *  Şube listesi bayi yükünde GELİR (`/plasiyer/dealers → subeler`); müşteri
   *  seçilir seçilmez kutu dolsun diye ikinci bir istek atılmaz.
   * ------------------------------------------------------------------ */

  /** Seçili müşterinin şubeleri. */
  function subeleriAl(musteri) {
    return (musteri && Array.isArray(musteri.subeler)) ? musteri.subeler : [];
  }

  /**
   * Şube şeridi.
   *
   * ŞUBESİZ MÜŞTERİDE SEÇİM KUTUSU BASILMAZ: tek seçeneği "şubesiz" olan bir
   * kutu ekranı kalabalıklaştırmaktan başka iş yapmaz. Ekleme yolu yine durur.
   */
  function subeSeridiHtml(secili) {
    if (!secili) return '';

    var subeler = subeleriAl(secili);
    var sepet = window.PlasiyerVitrin ? window.PlasiyerVitrin.sepetAl() : null;
    var seciliSube = (sepet && sepet.subeId) ? String(sepet.subeId) : '';

    var kutu = '';

    if (subeler.length) {
      kutu =
        '<select id="subeSecim" aria-label="Teslim şubesi" ' +
                'class="max-w-xs px-3 py-2 rounded-xl border-2 border-slate-200 dark:border-slate-600 ' +
                       'bg-white dark:bg-slate-900 font-bold">' +
          '<option value="">Şubesiz — merkeze teslim</option>' +
          subeler.map(function (sb) {
            return '<option value="' + kacis(String(sb.id)) + '"' +
              (seciliSube === String(sb.id) ? ' selected' : '') + '>' +
              kacis(subeKunyesi(sb)) + '</option>';
          }).join('') +
        '</select>';
    }

    return '<div class="flex items-center gap-2 flex-wrap mt-2">' +
        '<span class="text-sm font-bold text-slate-500 dark:text-slate-400">' + ikonHtml('bina') + ' Teslim Şubesi:</span>' +
        kutu +
        (subeler.length ? '' : '<span class="text-sm text-slate-500 dark:text-slate-400">Tanımlı şube yok — sipariş merkeze yazılır.</span>') +
        '<button type="button" id="subeEkle" class="dg dg-ikincil dg-k">' + ikonHtml('arti') + ' Şube</button>' +
      '</div>';
  }

  /** "Kocabıyık Şubesi — İzmir / Konak" (sunucudaki kunye() ile aynı biçim). */
  function subeKunyesi(sb) {
    if (!sb || !sb.ad) return '';

    var yer = [sb.il, sb.ilce].filter(Boolean).join(' / ');

    return yer ? (sb.ad + ' — ' + yer) : String(sb.ad);
  }

  /** Şube perdesini açar (ekleme). */
  function subePerdesiniAc() {
    var secili = durumM.secili;

    if (!secili) { bildir('Önce müşteri seçin.', 'hata'); return; }

    var kap = el('satisPerde');

    if (!kap) return;

    var alan = function (id, etiket, ek) {
      return '<label class="block mb-3"><span class="block font-bold mb-1">' + kacis(etiket) + '</span>' +
        '<input id="' + id + '" ' + (ek || '') + ' class="w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900" /></label>';
    };

    kap.innerHTML =
      '<div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">' +
        '<div class="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-800 p-6 max-h-[90vh] overflow-auto">' +
          '<div class="text-xl font-black mb-1">Yeni Şube</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mb-4">' +
            kacis(secili.unvan || '') + ' — sipariş yine bu cariye yazılır, şube yalnızca teslimat noktasıdır.' +
          '</div>' +
          alan('subeAd', 'Şube adı *') +
          alan('subeYetkili', 'Yetkili') +
          alan('subeTelefon', 'Telefon (05XX XXX XX XX)', 'inputmode="tel"') +
          alan('subeIl', 'İl') +
          alan('subeIlce', 'İlçe') +
          alan('subeAdres', 'Adres') +
          '<div class="flex gap-2 justify-end mt-4">' +
            '<button type="button" id="subeVazgec" class="dg dg-ikincil dg-b">Vazgeç</button>' +
            '<button type="button" id="subeKaydet" class="dg dg-birincil dg-b">Kaydet</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    kap.hidden = false;

    var kapat = function () { kap.innerHTML = ''; kap.hidden = true; };

    var vazgec = el('subeVazgec');
    if (vazgec) vazgec.addEventListener('click', kapat);

    var kaydet = el('subeKaydet');

    if (kaydet) {
      kaydet.addEventListener('click', async function () {
        var ad = (el('subeAd').value || '').trim();

        /* ADSIZ KAYIT AĞA ÇIKMAZ: sunucu da reddeder ama sahadaki mobil
           bağlantıda boş bir tur beklemek gereksiz. */
        if (!ad) { bildir('Şube adı zorunludur.', 'hata'); return; }

        kaydet.disabled = true;

        var cevap;

        try {
          cevap = await ipcRenderer.invoke('sube:kaydet', {
            musteriId: Number(secili.id) || 0,
            ad: ad,
            yetkili: (el('subeYetkili').value || '').trim(),
            telefon: (el('subeTelefon').value || '').trim(),
            il: (el('subeIl').value || '').trim(),
            ilce: (el('subeIlce').value || '').trim(),
            adres: (el('subeAdres').value || '').trim()
          });
        } catch (e) {
          cevap = { ok: false, hata: (e && e.message) || 'Şube kaydedilemedi.' };
        } finally {
          kaydet.disabled = false;
        }

        var veri = (cevap && cevap.veri) || {};

        if (!cevap || !cevap.ok || !veri.ok) {
          bildir((veri && veri.message) || (cevap && cevap.hata) || 'Şube kaydedilemedi.', 'hata');
          return;
        }

        /* Sunucunun döndürdüğü liste TEK doğruluk kaynağıdır. */
        secili.subeler = Array.isArray(veri.subeler) ? veri.subeler : subeleriAl(secili);

        kapat();
        bildir('Şube eklendi: ' + ad, 'ok');
        seridiCiz();
      });
    }

    var adAlani = el('subeAd');
    if (adAlani) adAlani.focus();
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

    /* Teslim şubesi (Faz 16-E): seçim SEPETE yazılır, müşteri DEĞİŞMEZ. */
    var subeKutu = el('subeSecim');

    if (subeKutu) {
      subeKutu.addEventListener('change', function () {
        /* Motor SEPETE yazar; musteri alanina DOKUNMAZ (cari ana musteride). */
        M().subeSec(sepet(), subeKutu.value);
      });
    }

    var subeDugme = el('subeEkle');
    if (subeDugme) subeDugme.addEventListener('click', subePerdesiniAc);

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
        '<button type="button" id="satisKapat" class="dg dg-sessiz dg-kare dg-k shrink-0" aria-label="Kapat">' + (window.ikon ? window.ikon('carpi') : '×') + '</button>' +
      '</div>' +
      '<input id="musteriArama" type="search" autocomplete="off" placeholder="Ünvan, kimlik no, telefon ya da il…" ' +
             'class="mt-5 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
      '<div id="musteriListe" class="mt-4 max-h-80 overflow-y-auto">' +
        '<div class="py-6 text-center text-slate-500">Yükleniyor…</div>' +
      '</div>' +
      '<button type="button" id="musteriYeniAlt" class="dg dg-ikincil dg-b dg-tam mt-4">' +
        ikonHtml('arti') + ' Çevrimdışı Yeni Müşteri Ekle' +
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
  /**
   * Müşterinin ödeme yöntemi iskonto tablosunu tamamlar (Faz 15).
   *
   * Sahada açılan müşterinin (ve "Tekrar Sipariş"te sipariş yükünden kurulan
   * sentetik kaydın) tablosu YOKTU; üç yöntem de %0 görünüyor ama sunucu
   * siparişi yazarken gerçek müşteri kimliğinden matrisi okuyup uyguluyordu.
   * Plasiyer müşterinin yanında gördüğünden FARKLI bir fiyatla satış yazıyordu.
   *
   * Eksikse oturum varsayılanı (sunucunun gönderdiği KURUMSAL satır) konur.
   * Kayıtta tablo VARSA dokunulmaz — gerçek bayinin kendi oranı kazanır.
   * Son söz yine sunucudadır (siparis_olustur oranı kimlikten okur).
   *
   * @param {object} m Müşteri kaydı (yerinde değiştirilir).
   * @returns {object} aynı kayıt
   */
  function odemeTablosunuTamamla(m) {
    if (!m || 'object' !== typeof m) return m;

    /*
     * BAYİYE ÖZEL AYAR (Faz 19): yönetici bu bayiye oran/yetki tanımladıysa
     * sunucunun gönderdiği tablo KESİNDİR — kapalı yöntemin %0'ı da, "bu
     * bayiye kart iskontosu yok" diye bilerek girilmiş %0 da. Kurumsal
     * varsayılanla doldurmak, plasiyerin sunucunun uygulamayacağı bir
     * iskontoyu müşteriye söylemesi olurdu (2.21.0'da kapatılan hata sınıfı).
     */
    if (m.odemeOzelAyar) return m;

    var tablo = m.odemeIskontolari;
    var dolu = tablo && 'object' === typeof tablo &&
      ['nakit', 'vade', 'kart'].some(function (y) { return Number(tablo[y]) > 0; });

    if (dolu) return m;

    if (durumM.odemeVarsayilan && 'object' === typeof durumM.odemeVarsayilan) {
      m.odemeIskontolari = {
        nakit: Number(durumM.odemeVarsayilan.nakit) || 0,
        vade: Number(durumM.odemeVarsayilan.vade) || 0,
        kart: Number(durumM.odemeVarsayilan.kart) || 0
      };
    } else if (!tablo || 'object' !== typeof tablo) {
      m.odemeIskontolari = {};
    }

    return m;
  }

  function musteriSec(m, secenek) {
    secenek = secenek || {};

    odemeTablosunuTamamla(m);

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

  /**
   * Müşteri formu — İKİ KİP, TEK FORM (Faz 13).
   *
   * `mevcut` verilirse düzenleme kipi: alanlar dolu açılır, başlık ve düğme
   * değişir, kayıt yolu farklıdır. Doğrulama (`musteriFormuDenetle`) ve alan
   * listesi ORTAK kalır — iki kopya, iki kural demek olurdu ve bu depoda iki
   * kez canımızı yakmış hata sınıfıdır (§5.13 / §5.14).
   */
  function yeniPerdesiniAc(mevcut) {
    var t = tavan();
    var duzenle = !!(mevcut && mevcut.id);
    var d = duzenle ? mevcut : {};

    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div>' +
          '<div class="text-xl font-extrabold">' + (duzenle ? 'Müşteri Bilgilerini Düzenle' : 'Yeni Müşteri') + '</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' +
            (duzenle
              ? (M().geciciMi(d.id)
                  ? 'Bu kayıt henüz sunucuya gitmedi; değişiklik cihazda saklanır ve eşitlemede iletilir.'
                  : 'Bu müşteri sunucuda kayıtlı; değişiklik doğrudan merkeze yazılır.')
              : 'Çevrimdışı kaydedilir, eşitlemede sunucuya iletilir. Kimlik ve telefon algoritmik olarak denetlenir.') +
          '</div>' +
        '</div>' +
        '<button type="button" id="satisKapat" class="dg dg-sessiz dg-kare dg-k shrink-0" aria-label="Kapat">' + (window.ikon ? window.ikon('carpi') : '×') + '</button>' +
      '</div>' +

      alan('ymUnvan', 'Firma ünvanı *', 'text', onDeger(d.unvan)) +
      alan('ymYetkili', 'Yetkili ad soyad *', 'text', onDeger(d.ad || d.yetkili)) +
      alan('ymKimlik', 'Vergi No (10 hane) / TC Kimlik No (11 hane) *', 'text', 'inputmode="numeric" maxlength="11" ' + onDeger(d.kimlikNo || d.vergiNo)) +
      alan('ymTelefon', 'Cep telefonu (05XX XXX XX XX) *', 'tel', 'inputmode="tel" ' + onDeger(d.telefon)) +
      /* E-posta İSTEĞE BAĞLI: sahada çoğu zaman toplanamaz. Boş bırakılırsa
         müşteriye HİÇBİR e-posta gönderilmez (sunucu 2.19.0'dan beri uydurma
         adres üretmiyor); iletişim WhatsApp üzerinden kurulur. */
      alan('ymEposta', 'E-posta (isteğe bağlı)', 'email', onDeger(epostaGoster(d.eposta))) +
      '<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Boş bırakabilirsiniz — müşteriye e-posta gönderilmez, iletişim telefondan kurulur.</p>' +
      alan('ymIl', 'İl *', 'text', onDeger(d.il)) +
      alan('ymIlce', 'İlçe', 'text', onDeger(d.ilce)) +
      alan('ymIskonto', 'Bayi iskontosu (%) — en fazla %' + yuzdeYaz(t), 'number', 'min="0" max="' + t + '" step="0.5" value="' + (Number(d.iskonto) || 0) + '"') +

      '<div id="ymMukerrer" class="hidden mt-4 p-3 rounded-xl bg-amber-50 border-2 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200 text-sm font-semibold"></div>' +
      '<p id="ymHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
      '<button type="button" id="ymKaydet" class="dg dg-birincil dg-b dg-tam mt-6">' +
        (duzenle ? 'Değişiklikleri Kaydet' : 'Kaydet ve Seç') + '</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);
    el('ymKaydet').addEventListener('click', function () {
      if (duzenle) return duzenlemeyiKaydet(mevcut);

      return yeniKaydet();
    });

    /* Kimlik kutusu yalnızca rakam alır (yapıştırma da süzülür). */
    var kimlik = el('ymKimlik');

    kimlik.addEventListener('input', function () {
      var temiz = kimlik.value.replace(/[^0-9]/g, '').slice(0, 11);
      if (temiz !== kimlik.value) kimlik.value = temiz;
    });

    el('ymUnvan').focus();
  }

  /** `value="…"` özniteliği — boş değer için hiç yazılmaz. */
  function onDeger(v) {
    var s = String(v === null || v === undefined ? '' : v).trim();

    return s ? ('value="' + kacis(s) + '"') : '';
  }

  /**
   * Yer tutucu e-postayı GÖSTERMEZ.
   *
   * Sunucu e-postasız bayi için `…@<alan>.invalid` üretir (RFC 6761: asla
   * çözülmez, posta dışarı çıkmaz). Bunu forma doldurmak kullanıcıya gerçek
   * bir adres varmış gibi gösterirdi.
   */
  function epostaGoster(v) {
    var s = String(v || '').trim();

    return /\.invalid$/i.test(s) ? '' : s;
  }

  /**
   * Düzenlemeyi kaydeder — kayıt türüne göre İKİ AYRI YOL.
   *
   * Çevrimdışı (henüz eşitlenmemiş) kayıt cihazda güncellenir; eşitlenmiş ya
   * da sunucudan gelen bayi merkeze yazılır. Ara yol YOKTUR: `musteri-esitle`
   * mevcut bayiyi bulunca alanları GÜNCELLEMEZ (yalnızca eşleştirir), bu
   * yüzden "eşitlenince düzelir" beklentisi yanlış olurdu.
   */
  async function duzenlemeyiKaydet(mevcut) {
    var dogrulama = D();
    var form = formuOku();

    if (!dogrulama) {
      yaz(el('ymHata'), 'Doğrulama motoru yüklenemedi; kayıt güncellenemez.');
      return;
    }

    var denetim = dogrulama.musteriFormuDenetle(form, { iskontoTavani: tavan() });

    hatalariYaz(denetim.hatalar);

    if (!denetim.ok) {
      yaz(el('ymHata'), 'Eksik ya da hatalı alanlar var; işaretli kutuları düzeltin.');
      return;
    }

    yaz(el('ymHata'), '');

    var t = denetim.temiz;
    var yuk = {
      id: mevcut.id,
      unvan: t.firmaAdi,
      ad: t.yetkili,
      kimlikNo: t.kimlikNo,
      kimlikTuru: t.kimlikTuru,
      telefon: t.telefon,
      eposta: form.eposta,
      il: t.il,
      ilce: t.ilce,
      iskonto: t.iskonto
    };

    var gecici = M().geciciMi(mevcut.id);
    var cevap = null;

    try {
      cevap = await ipcRenderer.invoke(gecici ? 'musteri:kuyrukta-guncelle' : 'musteri:guncelle', yuk);
    } catch (e) {
      cevap = { ok: false, hata: String(e && e.message ? e.message : e) };
    }

    if (!cevap || !cevap.ok) {
      yaz(el('ymHata'), (cevap && cevap.hata) || 'Kayıt güncellenemedi.');
      return;
    }

    /* Yerel görünümü tazele: kullanıcı değişikliği ANINDA görmeli. */
    var guncel = Object.assign({}, mevcut, yuk);

    if (cevap.musteri) guncel = Object.assign(guncel, cevap.musteri);

    durumM.yereller = durumM.yereller.map(function (x) { return (x && String(x.id) === String(mevcut.id)) ? guncel : x; });
    durumM.musteriler = durumM.musteriler.map(function (x) { return (x && String(x.id) === String(mevcut.id)) ? guncel : x; });

    if (durumM.secili && String(durumM.secili.id) === String(mevcut.id)) musteriSec(guncel, { sessiz: true });
    if (durumM.profil && String(durumM.profil.id) === String(mevcut.id)) durumM.profil = guncel;

    perdeKapat();
    portfoyuCiz();
    profiliCiz(durumM.profil);
    seridiCiz();

    if (cevap.iskontoKirpildi) {
      bildir('Bilgiler güncellendi. İskonto tavanınız aşıldığı için oran %' + yuzdeYaz(tavan()) + ' olarak kaydedildi.', 'uyari');
      return;
    }

    bildir(guncel.unvan + ' bilgileri güncellendi.', 'ok');
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
        '<button type="button" id="ymMevcutSec" class="dg dg-birincil dg-k ml-2">Onu seç</button> ' +
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
   *  SİPARİŞİ TAMAMLA — BİLEŞİK İSKONTO ÖZETİ + KDV TERCİHİ
   * ------------------------------------------------------------------ */

  /*
   * KDV MATEMATİĞİ MOTORDA (Faz 14): `PlasiyerSiparisMotor.toplamlar` KDV
   * kipini bilir ve `kdv` künyesini verir; `kalemKdv` satır başına net/KDV
   * döker. Bu dosyada ikinci bir KDV hesabı YOKTUR (Faz 13'ün `kdvTahmini`si
   * kaldırıldı — aynı kural için iki hesap, iskontoları KDV'li matrahtan
   * düşüren yanlış sayıyı üretiyordu). Oran ÜRÜN BAŞINADIR ve sunucudan gelir;
   * oranı bilinmeyen satır için sayı uydurulmaz. SON SÖZ SUNUCUDADIR
   * (B2B_Order_Revision::apply_vat_mode) — ekrandaki sayı gösterimdir.
   */

  /**
   * Ödeme yöntemi iskontosunun RAKAMSAL şeridi (Faz 15).
   *
   * Üç hâl:
   *   · yöntem seçili + oran > 0  → "Nakit iskontosu (%5): −45,00 ₺" + matrah
   *   · yöntem seçili + oran = 0  → "Bu yöntemde iskonto yok"
   *   · hiçbir yöntemde oran yok  → SEBEBİ yazan uyarı (sessiz sıfır yok)
   *
   * @param {object} s Sepet.
   * @returns {string} HTML
   */
  function kapaliYontemNotu(musteri) {
    var mot = M();
    var acik = mot.izinliYontemler(musteri);
    var kapali = mot.ODEME_YONTEMLERI.filter(function (y) { return acik.indexOf(y) === -1; });

    if (!kapali.length) return '';

    return '<div class="mt-2 px-1 text-xs font-bold text-slate-500 dark:text-slate-400" data-kapali-yontem>' +
           '🔒 Bu müşteri için yönetici tarafından kapatılan ödeme yöntemi: ' +
           kacis(kapali.map(function (y) { return mot.ODEME_ETIKET[y]; }).join(', ')) +
           '</div>';
  }

  function odemeIskontoSeridi(s) {
    var mot = M();
    var musteri = durumM.secili;
    var oranlar = mot.izinliYontemler(musteri).map(function (y) { return mot.odemeIskontosu(musteri, y); });
    var hicOranYok = !oranlar.some(function (o) { return Number(o) > 0; });

    /* Hiçbir yöntemde oran yoksa: bu bir ayar sorunudur, kullanıcı bilmeli. */
    if (hicOranYok) {
      var sebep = (false === durumM.odemeMatrisiAcik)
        ? 'Ödeme yöntemi iskontoları KAPALI (WordPress → B2B Ayarları → "Ödeme seçeneklerini rol bazlı yönet").'
        : 'Bu müşteri için ödeme yöntemi iskontosu tanımlı değil. Yönetici panelinde ' +
          '<b>İskonto Oranları → Kurumsal Bayiler</b> satırından tanımlayabilirsiniz.';

      return '<div class="mt-2 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 ' +
             'bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-sm text-slate-600 dark:text-slate-300">' +
             'ℹ️ ' + sebep + '</div>';
    }

    if (!mot.odemeGecerliMi(s.odeme)) {
      return '<div class="mt-2 px-1 text-sm font-bold text-slate-500 dark:text-slate-400">' +
             'Ödeme yöntemi seçin — iskonto tutarı burada hesaplanacak.</div>';
    }

    var g = mot.toplamlar(s, tavan());
    var oran = Number(g.odemeIskontoOrani) || 0;
    var tutar = Number(g.odemeIndirim) || 0;
    var etiket = kacis(mot.ODEME_ETIKET[s.odeme] || 'Ödeme');

    if (!(oran > 0) || !(tutar > 0)) {
      return '<div class="mt-2 px-1 text-sm font-bold text-slate-500 dark:text-slate-400">' +
             etiket + ' seçildi — bu yöntemde iskonto yok (%0).</div>';
    }

    /* Matrah AÇIKÇA yazılır: ödeme iskontosu bayi iskontosundan SONRAKİ
       tutara uygulanır (bileşik). Yazılmazsa "neyin %5'i" sorusu kalır. */
    var matrah = Number(g.araToplam) - Number(g.indirim || 0);

    return '<div class="mt-2 rounded-xl border-2 border-emerald-300 dark:border-emerald-500/40 ' +
           'bg-emerald-50 dark:bg-emerald-500/10 px-4 py-3">' +
             '<div class="flex flex-wrap items-baseline justify-between gap-2">' +
               '<span class="text-sm font-bold text-emerald-800 dark:text-emerald-300">' +
                 etiket + ' iskontosu (%' + kacis(yuzdeYaz(oran)) + ')</span>' +
               '<span class="text-lg font-black text-emerald-700 dark:text-emerald-400">−' + kacis(paraYaz(tutar)) + '</span>' +
             '</div>' +
             '<div class="mt-1 text-xs text-emerald-700/80 dark:text-emerald-400/80">' +
               kacis(paraYaz(matrah)) + ' üzerinden hesaplandı' +
               (Number(g.indirim) > 0 ? ' (bayi iskontosu düşüldükten sonra)' : '') +
             '</div>' +
           '</div>';
  }

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
        '<button type="button" id="satisKapat" class="dg dg-sessiz dg-kare dg-k shrink-0" aria-label="Kapat">' + (window.ikon ? window.ikon('carpi') : '×') + '</button>' +
      '</div>' +

      /* ÖDEME — ÜÇ SEÇENEK, fazlası yok (şirket politikası). Her düğme o
         yöntemin iskontosunu da söyler: seçim tutarı DEĞİŞTİRİR. */
      '<div class="mt-6 text-sm font-bold text-slate-600 dark:text-slate-300">Ödeme Yöntemi *</div>' +
      /*
       * YALNIZCA İZİNLİ YÖNTEMLER (Faz 19). Yöneticinin bu bayiye kapattığı
       * yöntemin düğmesi BASILMAZ — gizlenmiş/soluk bir düğme bile "belki
       * seçilir" diye okunur. Altındaki tek satır plasiyerin müşteriye
       * "neden nakit yok?" sorusunu cevaplayabilmesi içindir; seçenek sunmaz.
       */
      '<div class="mt-2 grid ' + ({ 1: 'grid-cols-1', 2: 'grid-cols-2' }[M().izinliYontemler(durumM.secili).length] || 'grid-cols-3') + ' gap-2">' +
        M().izinliYontemler(durumM.secili).map(function (y) {
          var oran = M().odemeIskontosu(durumM.secili, y);

          return '<button type="button" class="odeme-sec px-4 py-4 rounded-xl border-2 font-extrabold transition ' +
            (s.odeme === y
              ? 'bg-marka-700 text-white border-marka-700'
              : 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700') +
            '" data-odeme="' + y + '">' + kacis(M().ODEME_ETIKET[y]) +
            /* Kutunun İÇİNDE küçük "%X iskonto" (ürün sahibi). Oranı 0 olan
               yöntemde "%0" yazmak "iskonto var ama sıfır" diye okunur; o
               yüzden yalnızca pozitif oran basılır. */
            (oran > 0 ? '<span class="block text-xs font-bold opacity-80">%' + kacis(yuzdeYaz(oran)) + ' iskonto</span>' : '') +
          '</button>';
        }).join('') +
      '</div>' +
      kapaliYontemNotu(durumM.secili) +

      /*
       * ÖDEME İSKONTOSU — RAKAMSAL, DÜĞMELERİN ALTINDA (Faz 15).
       *
       * Ürün sahibi: "bu butona basıldığı zaman kaç iskonto yapıldığı da
       * rakamsal olarak en altta hesaplansın, okunsun, belirtilsin."
       * Yüzde bir vaattir; müşterinin duymak istediği TL'dir.
       *
       * Üç oran da 0 ise SEBEBİ yazılır. Sessiz sıfır, bu fazın düzelttiği
       * hata sınıfının ta kendisi: kullanıcı "iskonto tanımladım ama
       * görünmüyor" diyor, ekran hiçbir şey söylemiyordu.
       */
      odemeIskontoSeridi(s) +

      /*
       * KDV TERCİHİ — ödeme yönteminin HEMEN ALTINDA, çünkü ikisi de "bu
       * sipariş nasıl kesilecek" sorusunun parçasıdır ve plasiyer ikisini de
       * müşterinin yanında, aynı anda sorar.
       *
       * VARSAYILAN "KDV İSTİYORUM": fiyatlar KDV dahil girilir, normal sipariş
       * KDV lidir. Varsayılanı diğer yöne çevirmek, bu ekrana hiç bakmayan
       * plasiyerin her siparişini sessizce KDV siz yazması olurdu.
       */
      '<div class="mt-5 text-sm font-bold text-slate-600 dark:text-slate-300">KDV Tercihi *</div>' +
      '<div class="mt-2 grid grid-cols-2 gap-2">' +
        [
          { kod: '1', etiket: '✅ KDV İSTİYORUM', alt: 'Fiyatlar KDV dahildir' },
          { kod: '0', etiket: '🚫 KDV İSTEMİYORUM', alt: 'Ürünlerin tekil KDV oranları düşülür' }
        ].map(function (y) {
          var secili = ('1' === y.kod) === (false !== s.kdvDahil);

          return '<button type="button" class="kdv-sec px-4 py-4 rounded-xl border-2 font-extrabold transition ' +
            (secili
              ? ('0' === y.kod ? 'bg-amber-600 text-white border-amber-600' : 'bg-marka-700 text-white border-marka-700')
              : 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700') +
            '" data-kdv="' + y.kod + '" aria-pressed="' + (secili ? 'true' : 'false') + '">' + kacis(y.etiket) +
            '<span class="block text-xs font-bold opacity-80">' + kacis(y.alt) + '</span>' +
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
      /* Saha akışının asıl işlemi: birincil kademe (44px), tam genişlik. */
      '<button type="button" id="tamamlaGonder" class="dg dg-birincil dg-b dg-tam mt-5">' +
        ikonHtml('kaydet') + ' Siparişi Kaydet' +
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

    /* KDV seçimi vitrin fiyatlarını DEĞİŞTİRMEZ (KDV fiyatın içindedir, raf
       etiketi aynı kalır); yalnızca pencere ve özet bloğu yeniden çizilir. */
    modal.querySelectorAll('.kdv-sec').forEach(function (d) {
      d.addEventListener('click', function () {
        s.kdvDahil = '1' === d.dataset.kdv;
        tamamlamaAc();
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

    /*
     * ÖZET — KDV KİPİNE GÖRE (Faz 14). Sayılar MOTORDAN gelir
     * (`toplamlar` → `kdv` künyesi, `brutAraToplam`); burada aritmetik yok.
     *
     * KDV DÂHİL: liste, iskontolar, net; altında "KDV (%20) — fiyatlara
     * dâhil: X" bilgi satırı (müşteri ne kadar KDV'li aldığını görür).
     * KDV HARİÇ: liste (KDV dâhil) → düşülen KDV → liste (KDV hariç) →
     * iskontolar NET matrahtan → net (KDV hariç). 100 TL %10 → 90,91 (90 DEĞİL);
     * sunucu aynı sırayla yazar, ekran onun tahminidir.
     */
    function ozetiCiz() {
      var g = M().toplamlar(s, tavan());
      var kutu = el('tamamlaOzet');

      if (!kutu) return;

      var haric = false === g.kdvDahil;
      var kdv = g.kdv || {};
      var satir = function (etiket, deger, sinif) {
        return '<div class="flex justify-between gap-3' + (sinif ? ' ' + sinif : '') + '"><span>' + etiket + '</span><span class="font-bold whitespace-nowrap">' + deger + '</span></div>';
      };
      var oranYazisi = kdv.karisik ? 'karışık oran' : (kdv.oran > 0 ? '%' + yuzdeYaz(kdv.oran) : '');

      var html = satir('Kalem', g.satir + ' satır · ' + g.kalem + ' adet' + (g.koli ? ' · ' + g.koli + ' koli' : ''));

      if (haric) {
        html += satir('Liste toplamı (KDV dâhil)', kacis(paraYaz(g.brutAraToplam)), 'text-slate-500 dark:text-slate-400');

        if (kdv.hicYok) {
          html += '<div class="mt-1 text-xs text-amber-700 dark:text-amber-400">KDV oranları bu cihazda yok; düşüm SUNUCUDA hesaplanacak (kataloğu eşitleyin).</div>';
        } else {
          html += satir('Düşülen KDV' + (oranYazisi ? ' (' + kacis(oranYazisi) + ')' : ''), '−' + kacis(paraYaz(kdv.dusulen)), 'text-amber-700 dark:text-amber-400');
        }

        html += satir('Liste toplamı (KDV hariç)', kacis(paraYaz(g.araToplam)));
      } else {
        html += satir('Liste toplamı', kacis(paraYaz(g.araToplam)));
      }

      if (g.indirim > 0) html += satir('Bayi iskontosu %' + kacis(yuzdeYaz(g.iskontoOrani)), '−' + kacis(paraYaz(g.indirim)), 'text-emerald-700 dark:text-emerald-400');
      if (g.odemeIndirim > 0) html += satir(kacis(M().ODEME_ETIKET[s.odeme] || 'Ödeme') + ' iskontosu %' + kacis(yuzdeYaz(g.odemeIskontoOrani)), '−' + kacis(paraYaz(g.odemeIndirim)), 'text-emerald-700 dark:text-emerald-400');

      html += '<div class="flex justify-between gap-3 text-lg font-black"><span>' + (haric ? 'Net toplam (KDV hariç)' : 'Net toplam') + '</span><span data-tamamla-net>' + kacis(paraYaz(g.genelToplam)) + '</span></div>';

      if (!haric && !kdv.hicYok && kdv.tutar > 0) {
        html += satir('KDV' + (oranYazisi ? ' (' + kacis(oranYazisi) + ')' : '') + ' — fiyatlara dâhil', kacis(paraYaz(kdv.tutar)), 'text-slate-500 dark:text-slate-400');
      }

      if (g.indirim > 0 || g.odemeIndirim > 0) {
        html += '<div class="text-xs text-slate-500 dark:text-slate-400">Net = Liste' + (haric ? ' (KDV hariç)' : '') + ' × (1 − bayi/100) × (1 − ödeme/100)</div>';
      }

      if (haric) {
        /*
         * "KDV DAHİL DEĞİL : xxx ₺" — ürün sahibinin istediği BİREBİR ifade.
         *
         * Üstteki "Düşülen KDV" satırı hesabın adımıdır; bu satır müşterinin
         * duyacağı CÜMLEdir ("fiyata KDV dâhil değil, şu kadar düştü").
         * KDV istendiğinde bu satır HİÇ basılmaz (ürün sahibi: "Kdv istendiyse
         * bu satır yazılmasına gerek yok").
         */
        html += '<div class="mt-2 pt-2 border-t border-dashed border-amber-400 font-extrabold text-amber-700 dark:text-amber-400">🚫 Bu sipariş KDV UYGULANMADAN yazılacak</div>';

        if (!kdv.hicYok && kdv.dusulen > 0) {
          html += '<div class="flex justify-between gap-3 mt-1 text-base font-black text-amber-700 dark:text-amber-400">' +
                    '<span>KDV DAHİL DEĞİL :</span><span class="whitespace-nowrap">' + kacis(paraYaz(kdv.dusulen)) + '</span>' +
                  '</div>';
        }

        html += '<div class="text-xs text-slate-500 dark:text-slate-400">Kesin tutar sunucuda, ürün başına KDV oranıyla hesaplanır.' +
          (kdv.bilinmeyen > 0 ? ' ' + kdv.bilinmeyen + ' kalemin oranı bu cihazda yok, sunucuda çözülecek.' : '') + '</div>';
      }

      html += kdvDokumu(g, haric);

      kutu.innerHTML = html;
    }

    /**
     * Satır satır KDV dökümü — ürün · KDV % · KDV tutarı · KDV hariç tutar.
     * Plasiyer "bu ürünün KDV'si ne kadar?" sorusuna bakmadan cevap verir;
     * KDV hariç kipte hangi satırın ne kadar düştüğü görünür. Oranı
     * bilinmeyen satır "—" ile işaretlenir, sayı uydurulmaz.
     */
    function kdvDokumu(g, haric) {
      if (!s.satirlar.length || (g.kdv && g.kdv.hicYok && !haric)) return '';

      var satirlar = s.satirlar.map(function (satir) {
        var k = M().kalemKdv(satir);

        return '<tr class="border-t border-slate-200 dark:border-slate-700">' +
          '<td class="py-1 pr-2 truncate max-w-[14rem]">' + kacis(satir.name || '') + ' <span class="text-slate-400">×' + k.adet + '</span></td>' +
          '<td class="py-1 pr-2 text-right whitespace-nowrap">' + (k.bilinmiyor ? '—' : '%' + kacis(yuzdeYaz(k.oran))) + '</td>' +
          '<td class="py-1 pr-2 text-right whitespace-nowrap">' + (k.bilinmiyor ? '—' : kacis(paraYaz(k.kdv))) + '</td>' +
          '<td class="py-1 text-right whitespace-nowrap font-bold">' + kacis(paraYaz(haric ? k.net : k.brut)) + '</td>' +
        '</tr>';
      }).join('');

      return '<details class="mt-2 text-xs kdv-dokumu"><summary class="cursor-pointer font-bold text-slate-600 dark:text-slate-300">KDV dökümü (satır satır)</summary>' +
        '<table class="w-full mt-1"><thead><tr class="text-slate-500"><th class="text-left font-semibold">Ürün</th><th class="text-right font-semibold">KDV %</th><th class="text-right font-semibold">KDV</th><th class="text-right font-semibold">' + (haric ? 'KDV hariç' : 'Tutar') + '</th></tr></thead>' +
        '<tbody>' + satirlar + '</tbody></table></details>';
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
    /* KDV tercihi de SİPARİŞ BAŞINA karardır: bir müşteriye KDV siz yazmak,
       sıradaki siparişi de sessizce KDV siz yapmamalı. */
    s.kdvDahil = true;
    s.vadeNotu = '';
    s.siparisNotu = '';

    fiyatlariTazele();
    kuyrukSeridiniCiz();

    bildir('Sipariş yerel kuyruğa kaydedildi (' + govde.kalemler.length + ' kalem, net ' + paraYaz(govde.toplamlar.genelToplam) + '). Eşitlemede sunucuya gönderilecek.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  KENDİ SİPARİŞLERİM — ÇEVRİMDIŞI KUYRUK ŞERİDİ (Faz 9)
   * ------------------------------------------------------------------ */

  /**
   * Kuyruk satırının müşteri adı.
   *
   * SIRA ÖNEMLİ — künye yedeği (M1) en önce: köprü kurulduktan sonra
   * `kayit.geciciMusteri` `null`'lanır ve müşteri sunucuda silinmişse
   * `musteriBul` da bulamaz. Yedek olmasaydı plasiyer ekranda "Müşteri #42"
   * görür ve hangi siparişi onardığını bilemezdi.
   *
   * @param {object} satir Kuyruk satırı (kayıt DEĞİL — yedek satırda durur).
   * @returns {string}
   */
  function kuyrukMusteriAdi(satir) {
    if (!satir) return '—';

    var kayit = satir.kayit || satir;   // eski çağrı biçimi (doğrudan kayıt) da çalışsın

    if (satir.musteriKunyesi && satir.musteriKunyesi.unvan) return satir.musteriKunyesi.unvan;
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

  /* ------------------------------------------------------------------ *
   *  KUYRUK ONARIMI (M1)
   *  ---------------------------------------------------------------------
   *  Sahada çevrimdışı açılan müşteri sunucuda silinip yeniden açılınca
   *  (42 → 44) köprülenmiş siparişler `404 Müşteri bulunamadı` aldı ve şerit
   *  onları "KİLİTLİ" diye gösterdi — ama YAPACAK BİR ŞEY SUNMADI. Tek çıkış
   *  `ayarlar.json`'u elle düzenlemekti.
   *
   *  Üç eylem, hepsi ana süreçte (kuyruk mutasyonu eşitleme turuyla yarışır):
   *    · Müşteriyi Yeniden Oluştur — künye yedeğinden yeni geçici müşteri
   *    · Başka Müşteriye Bağla     — portföydeki GERÇEK bayiye taşı
   *    · Siparişi Sil              — onayla
   * ------------------------------------------------------------------ */

  /** Motorun durum sabitleri — metin SABİT YAZILMAZ, tek kaynak motordur. */
  function S() {
    return window.PlasiyerSyncMotor;
  }

  function onarimBekliyorMu(satir) {
    var Sync = S();

    return !!Sync && Sync.ONARIM_GEREKLI === (satir && satir.durum);
  }

  function kaliciHataliMi(satir) {
    var Sync = S();

    return !!Sync && Sync.KALICI_HATA === (satir && satir.durum);
  }

  /**
   * Hedef seçici — YALNIZCA sunucudaki bayiler.
   *
   * Geçici müşteriye bağlamak siparişi "müşteri henüz eşitlenmedi" halkasına
   * sokardı (sync motoru onu göndermez, kullanıcı yine kilitli sanır).
   */
  function hedefSeciciHtml() {
    var secenekler = (durumM.musteriler || [])
      .filter(function (m) { return m && !M().geciciMi(m.id) && Number(m.id) > 0; })
      .map(function (m) {
        return '<option value="' + kacis(m.id) + '">' + kacis(m.unvan || ('#' + m.id)) + '</option>';
      })
      .join('');

    return '<select class="kuyruk-hedef px-2 py-1 rounded-lg border-2 border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-sm font-semibold">' +
      '<option value="">Müşteri seçin…</option>' + secenekler +
      '</select>';
  }

  /** Bir kuyruk satırının işaretlemesi. */
  function kuyrukSatiriHtml(satir) {
    var onarim = onarimBekliyorMu(satir);
    var kalici = kaliciHataliMi(satir);
    var sorunlu = onarim || kalici;
    var t = (satir.kayit && satir.kayit.toplamlar) || {};
    var kalem = (satir.kayit.kalemler || []).length;

    var rozet = onarim ? 'ONARIM GEREKLİ' : (kalici ? 'KİLİTLİ' : 'BEKLİYOR');
    var rozetSinif = onarim
      ? 'bg-orange-500 text-white'
      : (kalici ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-950');
    var zemin = sorunlu ? 'bg-red-50 dark:bg-red-950/30' : 'bg-amber-50 dark:bg-amber-950/30';

    var eylemler = '';

    /*
     * ÖDEME YÖNTEMİ KAPALI (Faz 19): yönetici bu bayiye yöntemi sipariş
     * kuyruktayken kapattı. Müşteri onarımı (dirilt / bağla) burada
     * ANLAMSIZDIR — müşteri doğru, yöntem yanlış. Seçici sunucunun AÇIK
     * dediği yöntemlerden kurulur; liste gelmediyse müşterinin bilinen
     * izinlerinden.
     */
    if (onarim && 'b2b_plasiyer_odeme_kapali' === satir.hataKodu) {
      var acikYontemler = (Array.isArray(satir.izinliOdeme) && satir.izinliOdeme.length)
        ? satir.izinliOdeme.filter(function (y) { return M().odemeGecerliMi(y) && y !== satir.kayit.odeme; })
        : M().izinliYontemler(musteriBul(satir.kayit.musteriId)).filter(function (y) { return y !== satir.kayit.odeme; });

      eylemler =
        '<div class="w-full flex items-center gap-2 flex-wrap pt-2 mt-1 border-t border-red-200 dark:border-red-900">' +
          (acikYontemler.length
            ? '<select class="kuyruk-odeme-sec px-2 py-1 rounded-lg border-2 border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-sm font-semibold">' +
                acikYontemler.map(function (y) {
                  return '<option value="' + kacis(y) + '">' + kacis(M().ODEME_ETIKET[y] || y) + '</option>';
                }).join('') +
              '</select>' +
              '<button type="button" class="dg dg-birincil dg-k kuyruk-odeme">' + ikonHtml('kart') + ' Ödeme Yöntemini Değiştir</button>'
            : '<span class="text-xs font-bold text-red-700 dark:text-red-300">Bu müşteri için açık başka ödeme yöntemi yok — yöneticiyle görüşün.</span>') +
          '<button type="button" class="dg dg-tehlike dg-k kuyruk-sil ml-auto">' + ikonHtml('cop') + ' Siparişi Sil</button>' +
        '</div>';
    } else if (onarim) {
      /* Künye yedeği YOKSA düğme hiç basılmaz: 2.2.0 öncesi köprülenen
         kayıtlarda yedek yoktur ve boş bir müşteri açmak isimsiz cari üretirdi
         (Faz 11'in "çalışan/çalışmayan ayar" reddiyle aynı ilke). */
      var dirilt = (satir.musteriKunyesi && satir.musteriKunyesi.unvan)
        ? '<button type="button" class="dg dg-birincil dg-k kuyruk-dirilt">' + ikonHtml('yenile') + ' Müşteriyi Yeniden Oluştur</button>'
        : '';

      eylemler =
        '<div class="w-full flex items-center gap-2 flex-wrap pt-2 mt-1 border-t border-red-200 dark:border-red-900">' +
          dirilt +
          hedefSeciciHtml() +
          '<button type="button" class="dg dg-ikincil dg-k kuyruk-bagla">' + ikonHtml('zincir') + ' Bu Müşteriye Bağla</button>' +
          '<button type="button" class="dg dg-tehlike dg-k kuyruk-sil ml-auto">' + ikonHtml('cop') + ' Siparişi Sil</button>' +
        '</div>';
    } else if (kalici) {
      eylemler =
        '<div class="w-full flex items-center gap-2 flex-wrap pt-2 mt-1 border-t border-red-200 dark:border-red-900">' +
          '<button type="button" class="dg dg-birincil dg-k kuyruk-tekrar">' + ikonHtml('yenile') + ' Tekrar Dene</button>' +
          '<button type="button" class="dg dg-tehlike dg-k kuyruk-sil ml-auto">' + ikonHtml('cop') + ' Siparişi Sil</button>' +
        '</div>';
    }

    return '<div data-kuyruk="' + kacis(satir.kayit.yerelKimlik || '') + '" class="flex items-start gap-3 flex-wrap px-3 py-2 rounded-xl ' + zemin + '">' +
      '<div class="min-w-0 flex-1">' +
        '<div class="font-bold">' + kacis(kuyrukMusteriAdi(satir)) +
          ' <span class="text-xs font-semibold text-slate-500">' + kacis(zamanYaz(satir.zaman)) + '</span></div>' +
        '<div class="text-sm text-slate-600 dark:text-slate-300">' +
          kalem + ' kalem · ' +
          /* Ödeme yöntemi kuyrukta DEĞİŞTİYSE ekrandaki net eski yöntemin
             iskontosuyla hesaplanmıştır: uydurulmaz, "merkezde" denir. */
          (satir.odemeDegisti
            ? 'net merkezde yeniden hesaplanacak (ödeme yöntemi değişti)'
            : 'net ' + kacis(paraYaz(t.genelToplam || 0))) +
          ' · ' + kacis(M().ODEME_ETIKET[satir.kayit.odeme] || satir.kayit.odeme || '') +
        '</div>' +
        (satir.hata ? '<div class="text-xs font-semibold ' + (sorunlu ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300') + '">' + (sorunlu ? '⛔ ' : '⏳ ') + kacis(satir.hata) + '</div>' : '') +
      '</div>' +
      '<span class="px-2 py-1 rounded-lg text-xs font-black ' + rozetSinif + '">' + rozet + '</span>' +
      eylemler +
    '</div>';
  }

  /** Şeritten sonra çizilir; satır bulunamazsa sessizce döner. */
  async function onarimIstegi(kanal, yuk, basariMesaji) {
    var cevap;

    try {
      cevap = await ipcRenderer.invoke(kanal, yuk);
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'İşlem tamamlanamadı.' };
    }

    if (!cevap || !cevap.ok) {
      bildir((cevap && cevap.hata) || 'İşlem tamamlanamadı.', 'hata');
      return null;
    }

    if (basariMesaji) bildir(basariMesaji(cevap), 'ok');

    await kuyrukSeridiniCiz();

    return cevap;
  }

  /** Onarım düğmelerini şerit kabına bağlar (her çizimde yeniden). */
  function onarimOlaylariniBagla(kap) {
    kap.querySelectorAll('[data-kuyruk]').forEach(function (sat) {
      var yerel = sat.getAttribute('data-kuyruk');

      var dirilt = sat.querySelector('.kuyruk-dirilt');
      var bagla = sat.querySelector('.kuyruk-bagla');
      var tekrar = sat.querySelector('.kuyruk-tekrar');
      var sil = sat.querySelector('.kuyruk-sil');
      var odemeDegis = sat.querySelector('.kuyruk-odeme');

      if (odemeDegis) {
        odemeDegis.addEventListener('click', async function () {
          var sec = sat.querySelector('.kuyruk-odeme-sec');
          var yeni = sec ? String(sec.value || '') : '';

          if (!yeni) {
            bildir('Önce yeni ödeme yöntemini seçin.', 'hata');
            return;
          }

          /* Yöntem değişince İSKONTO DA değişir: müşteriyle teyit edilmeli. */
          var onay = await onayla(
            'Ödeme Yöntemi Değiştirilecek',
            'Siparişin ödeme yöntemi ' + (M().ODEME_ETIKET[yeni] || yeni) + ' olarak değiştirilecek.\n\n' +
            'Ödeme yöntemi iskontosu değişebilir; kesin tutar merkezde hesaplanır.\n' +
            'Müşteriyle teyit ettiniz mi?',
            'EVET, DEĞİŞTİR',
            false
          );

          if (!onay) return;

          onarimIstegi('siparis:kuyrukta-odeme-degistir', { yerelKimlik: yerel, odeme: yeni }, function () {
            return 'Ödeme yöntemi ' + (M().ODEME_ETIKET[yeni] || yeni) + ' oldu; sipariş eşitlemede merkeze gidecek.';
          });
        });
      }

      if (dirilt) {
        dirilt.addEventListener('click', function () {
          onarimIstegi('musteri:kunyeden-dirilt', { yerelKimlik: yerel }, function (c) {
            return '“' + (c.unvan || 'Müşteri') + '” yeniden oluşturuldu; ' +
              (Number(c.siparis) || 0) + ' sipariş ona bağlandı. Eşitlemede merkeze gidecek.';
          });
        });
      }

      if (bagla) {
        bagla.addEventListener('click', function () {
          var sec = sat.querySelector('.kuyruk-hedef');
          var hedef = sec ? String(sec.value || '') : '';

          if (!hedef) {
            bildir('Önce siparişin bağlanacağı müşteriyi seçin.', 'hata');
            return;
          }

          onarimIstegi('siparis:kuyrukta-yeniden-bagla', { yerelKimlik: yerel, musteriId: Number(hedef) }, function () {
            return 'Sipariş yeni müşteriye bağlandı; eşitlemede merkeze gidecek.';
          });
        });
      }

      if (tekrar) {
        tekrar.addEventListener('click', function () {
          /* Hedef DEĞİŞMEZ; amaç yalnızca deneme sayacını sıfırlayıp kaydı
             yeniden kuyruğa almaktır (aynı kanal, mevcut kimlikle). */
          var satirVerisi = sonKuyruk.filter(function (x) {
            return x && x.kayit && String(x.kayit.yerelKimlik) === String(yerel);
          })[0];

          var hedef = satirVerisi ? Number(satirVerisi.kayit.musteriId) : 0;

          if (!hedef) {
            bildir('Bu kaydın hedefi çözülemedi; müşteriyi seçip bağlayın.', 'hata');
            return;
          }

          onarimIstegi('siparis:kuyrukta-yeniden-bagla', { yerelKimlik: yerel, musteriId: hedef }, function () {
            return 'Sipariş yeniden kuyruğa alındı.';
          });
        });
      }

      if (sil) {
        sil.addEventListener('click', async function () {
          var satirVerisi = sonKuyruk.filter(function (x) {
            return x && x.kayit && String(x.kayit.yerelKimlik) === String(yerel);
          })[0];

          var kalem = satirVerisi ? (satirVerisi.kayit.kalemler || []).length : 0;
          var tutar = satirVerisi ? ((satirVerisi.kayit.toplamlar || {}).genelToplam || 0) : 0;

          /* Ne kaybedileceği AÇIKÇA söylenir — silme geri alınamaz. */
          var onay = await onayla(
            'Bu sipariş kuyruktan SİLİNECEK ve merkeze hiç gitmeyecek.\n\n' +
            kuyrukMusteriAdi(satirVerisi) + ' · ' + kalem + ' kalem · ' + paraYaz(tutar) + '\n\n' +
            'Bu işlem geri alınamaz. Silinsin mi?'
          );

          if (!onay) return;

          onarimIstegi('siparis:kuyruktan-sil', { yerelKimlik: yerel }, function () {
            return 'Sipariş kuyruktan silindi.';
          });
        });
      }
    });
  }

  /** Şeridin son okuduğu kuyruk — onarım düğmeleri künyeyi buradan okur. */
  var sonKuyruk = [];

  /**
   * Bekleyen / hatalı siparişleri Kendi Siparişlerim'in tepesine yazar.
   *
   * Kaynak `ayarlar.json → plasiyerSiparisKuyrugu`; gönderilenler zaten
   * düşmüş olur (main.js § 3.8). Kalıcı hatalı ve ONARIM BEKLEYEN kayıt
   * SEBEBİYLE görünür — sahadaki plasiyer "gitti sandım" demesin.
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

    sonKuyruk = bekleyen;

    if (!bekleyen.length) {
      kap.innerHTML =
        '<div class="flex items-center gap-3 px-4 py-3 rounded-2xl bg-emerald-50 text-emerald-800 border-2 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 font-bold">' +
          '✓ Çevrimdışı bekleyen sipariş yok — yazdığınız her sipariş sunucuya iletildi.' +
        '</div>';
      return;
    }

    var hatali = bekleyen.filter(function (k) { return Sync && Sync.bildirilir(k); }).length;

    kap.innerHTML =
      '<div class="rounded-2xl border-2 ' + (hatali ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-700') + ' bg-white dark:bg-slate-800 p-4">' +
        '<div class="flex items-center gap-3 flex-wrap mb-3">' +
          '<div class="font-extrabold text-lg">📦 Çevrimdışı kuyruk: ' + bekleyen.length + ' sipariş' +
            (hatali ? ' <span class="text-red-600">(' + hatali + ' hatalı)</span>' : '') + '</div>' +
          '<button type="button" id="kuyrukEsitle" class="dg dg-birincil dg-k ml-auto">' + ikonHtml('yenile') + ' Şimdi Eşitle</button>' +
        '</div>' +
        '<div class="flex flex-col gap-2">' +
          bekleyen.map(kuyrukSatiriHtml).join('') +
        '</div>' +
      '</div>';

    onarimOlaylariniBagla(kap);

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
          '<button type="button" class="dg dg-birincil dg-k mk-siparis" data-id="' + kacis(String(m.id)) + '">' + ikonHtml('sepet') + ' Sipariş Yaz</button>' +
          '<button type="button" class="dg dg-ikincil dg-k mk-not" data-id="' + kacis(String(m.id)) + '" title="İsteğe bağlı — patrona not bırakın">' + ikonHtml('not') + ' Ziyaret Notu</button>' +
          /* HIZLI TEKRAR SİPARİŞ (Faz 12): müşterinin son siparişi BUGÜNÜN fiyatıyla
             sepete dolar ve satış ekranı açılır. Çevrimdışı müşterinin sunucuda
             geçmişi olamaz — düğme gösterilmez. */
          (m.gecici
            ? ''
            : '<button type="button" class="dg dg-ikincil dg-k mk-tekrar" data-id="' + kacis(String(m.id)) + '" title="Son siparişi bugünün fiyatıyla sepete doldur">' + ikonHtml('yenile') + ' Tekrar Sipariş</button>') +
          '<button type="button" class="dg dg-ikincil dg-k dg-kare mk-duzenle" data-id="' + kacis(String(m.id)) + '" title="Müşteri bilgilerini düzenle" aria-label="Müşteri bilgilerini düzenle">' + ikonHtml('kalem') + '</button>' +
          '<button type="button" class="dg dg-ikincil dg-k mk-profil" data-id="' + kacis(String(m.id)) + '">Profil</button>' +
          /* Yalnızca henüz sunucuya gitmemiş kayıt silinebilir (Faz 11). Metinde
             "ÇEVRİMDIŞI" geçmez — eşitleme testi rozetin kalktığını o sözcükle ölçer. */
          (m.gecici
            ? '<button type="button" class="dg dg-tehlike dg-k mk-sil" data-id="' + kacis(String(m.id)) + '" title="Henüz sunucuya gitmemiş bu kaydı cihazdan siler.">' + ikonHtml('cop') + ' Sil</button>'
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
        '<button type="button" id="profilKapat" class="dg dg-sessiz dg-kare dg-k shrink-0" aria-label="Kapat">' + (window.ikon ? window.ikon('carpi') : '×') + '</button>' +
      '</div>' +
      '<div class="mt-4 grid gap-4 md:grid-cols-3">' +
        '<div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50">' +
          '<div class="text-xs font-bold text-slate-500">BAYİ İSKONTOSU</div>' +
          '<div class="text-2xl font-black">%' + kacis(yuzdeYaz(m.iskonto)) + '</div>' +
          '<div class="text-xs text-slate-500 mt-1">Ödeme: ' +
            M().ODEME_YONTEMLERI.map(function (y) {
              return M().izinliYontemler(m).indexOf(y) === -1
                ? kacis(M().ODEME_ETIKET[y]) + ' 🔒 kapalı'
                : kacis(M().ODEME_ETIKET[y]) + ' %' + kacis(yuzdeYaz(M().odemeIskontosu(m, y)));
            }).join(' · ') +
          '</div>' +
        '</div>' +
        '<div class="p-4 rounded-xl ' + (Number(m.acikBakiye) > 0 ? 'bg-red-50 dark:bg-red-950/30' : 'bg-slate-50 dark:bg-slate-900/50') + '">' +
          '<div class="text-xs font-bold text-slate-500">AÇIK BAKİYE</div>' +
          '<div class="text-2xl font-black">' + kacis(paraYaz(m.acikBakiye)) + '</div>' +
        '</div>' +
        '<div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 flex flex-col gap-2">' +
          '<button type="button" id="profilSiparis" class="dg dg-birincil dg-b">' + ikonHtml('sepet') + ' Bu Müşteriye Sipariş Yaz</button>' +
          '<button type="button" id="profilDuzenle" class="dg dg-ikincil dg-b">' + ikonHtml('kalem') + ' Müşteri Bilgilerini Düzenle</button>' +
          '<button type="button" id="profilNot" class="dg dg-ikincil dg-b">' + ikonHtml('not') + ' Saha Ziyaret Notu <span class="font-normal opacity-70">(isteğe bağlı)</span></button>' +
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

    var duzenleD = el('profilDuzenle');

    if (duzenleD) duzenleD.addEventListener('click', function () { yeniPerdesiniAc(m); });
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
      if (hedef.classList.contains('mk-duzenle')) return yeniPerdesiniAc(m);

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
    /* Meşgul durumuyla (Faz 20): iş bitene kadar ikon döner, ikinci basış yeni tur açmaz.
       Modül yoksa düz tıklama (zarif düşüş). */
    if (yenile && window.ArayuzDugme && 'function' === typeof window.ArayuzDugme.bagla) window.ArayuzDugme.bagla(yenile, function () { durumM.yuklendi = false; return portfoyuAc(); });
    else if (yenile) yenile.addEventListener('click', function () { durumM.yuklendi = false; return portfoyuAc(); });

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
    /* Teslim şubesi (Faz 16-E) */
    subePerdesiniAc: subePerdesiniAc,
    subeKunyesi: subeKunyesi,
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
