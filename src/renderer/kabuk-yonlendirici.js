/* ============================================================================
 *  KABUK YÖNLENDİRİCİSİ (Shell View Router) — src/renderer/kabuk-yonlendirici.js
 *  ---------------------------------------------------------------------------
 *  Üç kesin kabuk, tek belge:
 *
 *      durum.kabuk === 'kapi'      → yalnızca giriş kaplaması ve ORTAK iskelet
 *      durum.kabuk === 'admin'     → yönetici menüsü + gövdeleri + yönetici modalları
 *      durum.kabuk === 'plasiyer'  → saha menüsü (3 sekme) + gövdeleri
 *
 *  NEDEN "GİZLEME" DEĞİL "SÖKME" (Zero Style Bleeding):
 *  Faz 6-7'de rol ayrımı CSS ile yapılıyordu (`data-rol-gizli` → display:none).
 *  Gizli düğüm DOM'DA DURUR: `getElementById` onu bulur, klavye odağı ona
 *  düşebilir, bir CSS kuralı onu geri getirebilir, bir modül yanlışlıkla ona
 *  yazabilir. Karşı rolün arayüzü belgede hiç yoksa bunların hiçbiri olamaz.
 *
 *  NEDEN ŞABLONDAN KLONLAMA DEĞİL, AYNI DÜĞÜMÜ PARK ETME:
 *  renderer.js olay dinleyicilerini açılışta belirli kimliklere TEK SEFER
 *  bağlar ve dinleyici düğümün üzerinde yaşar. `cloneNode` dinleyiciyi
 *  KOPYALAMAZ ama "bağlandı" bayraklarını (`dataset.izgBagli` gibi) KOPYALAR:
 *  klon "bağlıyım" der, hiçbir tıklamaya cevap vermez — sessiz ölü arayüz.
 *  `element.remove()` ise dinleyiciyi SİLMEZ; aynı düğüm geri takıldığında
 *  çalışır. Bu yüzden düğümler bir yorum düğümü (yer tutucu) ile yer
 *  değiştirilir ve sırası bozulmadan geri konur.
 *
 *  İŞARETLEME SÖZLEŞMESİ (index.html):
 *      data-kabuk="admin"            → yalnızca yönetici kabuğunda
 *      data-kabuk="plasiyer"         → yalnızca saha kabuğunda
 *      data-kabuk="admin plasiyer"   → İKİ oturum kabuğunda da (ORTAK); kapı
 *                                      dâhil HİÇ SÖKÜLMEZ (bkz. aşağı)
 *      işaretsiz                     → iskelet; yönlendirici dokunmaz
 *
 *  ORTAK DÜĞÜMLER NEDEN KAPIDA DA DURUR: `#sekme-siparisler` iki rolün
 *  paylaştığı tek gövde. renderer.js'in otomatik yenileme zamanlayıcısı
 *  `#siparisListesi`'ne koşulsuz yazar; çıkıştan sonra düğüm sökülü olsa her
 *  tik bir TypeError üretir ve telemetriyi doldurur. Kapı kaplaması zaten
 *  ekranı örter — ortak düğümün arkada durması hiçbir şey sızdırmaz.
 *
 *  ZAMANLAMA KİLİDİ: renderer.js `baslat()` iki IPC turu sonra `olaylariBagla()`
 *  koşturur ve o bağlayıcı NULL KORUMASIZDIR. Boot bitmeden bir yönetici
 *  düğümü sökülürse `$('#…').addEventListener` patlar, `sekmeAc` hiç
 *  çağrılmaz, uygulama ölü ekranda kalır. Bu yüzden renderer.js boot
 *  bitiminde `window.__byomHazir = true` + `byom:hazir` olayı yayar; hazır
 *  değilken gelen geçiş ERTELENİR ve olayla uygulanır. Test ortamında
 *  (renderer.js yüklenmez) bayrak tanımsızdır → geçiş anında uygulanır.
 *
 *  Çift modlu: `<script src>` ile `window.KabukYonlendirici`, `node --test`
 *  altında `module.exports` (jsdom penceresi `kur(window)` ile verilir).
 * ==========================================================================*/

(function (kok) {
  'use strict';

  var KABUKLAR = ['kapi', 'admin', 'plasiyer'];

  /** Oturum kabukları — "ortak" tanımı bunların hepsini taşımak demektir. */
  var OTURUM_KABUKLARI = ['admin', 'plasiyer'];

  /** @type {Array<{dugum: Element, yer: Comment, kabuklar: string[], kimlik: string}>} */
  var kayitlar = [];

  var pencere = null;
  var kuruldu = false;
  var bekleyen = '';   // hazır olmadan istenen kabuk

  function kabukListesi(dugum) {
    return String((dugum && dugum.getAttribute && dugum.getAttribute('data-kabuk')) || '')
      .trim().split(/\s+/).filter(Boolean);
  }

  /** Düğüm her oturum kabuğunda var mı? (ortak → hiç sökülmez) */
  function ortakMi(kabuklar) {
    return OTURUM_KABUKLARI.every(function (k) { return kabuklar.indexOf(k) !== -1; });
  }

  function durumNesnesi() {
    return (pencere && pencere.durum) || (kok && kok.durum) || null;
  }

  function hazirMi() {
    var w = pencere || kok;

    /* Bayrak TANIMSIZSA (renderer.js yok — test ortamı) hazır sayılır;
       yalnızca AÇIKÇA false iken beklenir. */
    return !(w && false === w.__byomHazir);
  }

  /**
   * İşaretli düğümleri bir kez toplar. İdempotent: ikinci çağrı yeni düğüm
   * eklemez (kimlik + düğüm eşitliği ile).
   *
   * @param {Window} [w] jsdom penceresi (tarayıcıda verilmez).
   * @returns {number} kayıt sayısı
   */
  function kur(w) {
    pencere = w || kok;

    var belge = pencere.document;

    if (!belge) return 0;

    belge.querySelectorAll('[data-kabuk]').forEach(function (dugum) {
      var var_ = kayitlar.some(function (k) { return k.dugum === dugum; });

      if (var_) return;

      var kabuklar = kabukListesi(dugum).filter(function (k) { return KABUKLAR.indexOf(k) !== -1; });

      if (!kabuklar.length) return;   // tanınmayan işaret: dokunma

      kayitlar.push({
        dugum: dugum,
        yer: belge.createComment('kabuk:' + (dugum.id || dugum.getAttribute('data-sekme') || '')),
        kabuklar: kabuklar,
        kimlik: dugum.id || dugum.getAttribute('data-sekme') || ''
      });
    });

    if (!kuruldu) {
      kuruldu = true;

      /* renderer.js boot bitince ertelenmiş geçiş uygulanır. */
      belge.addEventListener('byom:hazir', function () {
        if (bekleyen) {
          var k = bekleyen;
          bekleyen = '';
          uygula(k);
        }
      });
    }

    return kayitlar.length;
  }

  function takili(kayit) {
    return !!(kayit.dugum.parentNode);
  }

  function sok(kayit) {
    var ebeveyn = kayit.dugum.parentNode;

    if (!ebeveyn) return;

    ebeveyn.replaceChild(kayit.yer, kayit.dugum);
  }

  function tak(kayit) {
    var ebeveyn = kayit.yer.parentNode;

    if (!ebeveyn) return;

    ebeveyn.replaceChild(kayit.dugum, kayit.yer);
  }

  /** Düğüm bu kabukta belgede olmalı mı? */
  function gorunmeli(kayit, kabuk) {
    if (ortakMi(kayit.kabuklar)) return true;          // ortak: her kabukta (kapı dâhil)

    return kayit.kabuklar.indexOf(kabuk) !== -1;
  }

  /**
   * Kabuğu FİİLEN uygular (ertelemesiz). Dışarıdan `kabukGec` kullanılır.
   *
   * @param {string} kabuk
   * @returns {{kabuk: string, takilan: number, sokulen: number}}
   */
  function uygula(kabuk) {
    if (!kuruldu) kur(pencere || kok);

    var takilan = 0;
    var sokulen = 0;

    kayitlar.forEach(function (kayit) {
      var olmali = gorunmeli(kayit, kabuk);
      var varMi = takili(kayit);

      if (olmali && !varMi) { tak(kayit); takilan++; }
      if (!olmali && varMi) { sok(kayit); sokulen++; }
    });

    var belge = (pencere || kok).document;

    if (belge && belge.documentElement) {
      belge.documentElement.setAttribute('data-kabuk', kabuk);
    }

    var d = durumNesnesi();
    if (d) d.kabuk = kabuk;

    if (belge && 'function' === typeof belge.dispatchEvent) {
      try {
        var Olay = (pencere || kok).CustomEvent;
        belge.dispatchEvent(new Olay('byom:kabuk', { detail: { kabuk: kabuk } }));
      } catch (e) { /* eski ortam: olay isteğe bağlı */ }
    }

    return { kabuk: kabuk, takilan: takilan, sokulen: sokulen };
  }

  /**
   * Kabuk değiştirir.
   *
   * Geçersiz ad → hiçbir şey yapılmaz ve `null` döner. Boot bitmemişse
   * `durum.kabuk` hemen yazılır ama DOM işi `byom:hazir`'a ertelenir
   * (`ertelendi: true`).
   *
   * @param {string} kabuk 'kapi' | 'admin' | 'plasiyer'
   * @returns {object|null}
   */
  function kabukGec(kabuk) {
    kabuk = String(kabuk || '');

    if (KABUKLAR.indexOf(kabuk) === -1) return null;

    if (!kuruldu) kur(pencere || kok);

    if (!hazirMi()) {
      bekleyen = kabuk;

      var d = durumNesnesi();
      if (d) d.kabuk = kabuk;

      return { kabuk: kabuk, ertelendi: true };
    }

    bekleyen = '';

    return uygula(kabuk);
  }

  /** Şu anki kabuk (durum yoksa 'kapi'). */
  function aktifKabuk() {
    var d = durumNesnesi();

    return (d && KABUKLAR.indexOf(d.kabuk) !== -1) ? d.kabuk : 'kapi';
  }

  /** Rol → kabuk adı (bilinmeyen rol = kapı). */
  function rolKabugu(rol) {
    return OTURUM_KABUKLARI.indexOf(rol) !== -1 ? rol : 'kapi';
  }

  /**
   * Bir sekmenin ait olduğu kabuklar — düğme SÖKÜLÜ olsa da cevap verir.
   * (renderer-plasiyer.js `sekmeIzinli` bunu okur: "menüde yok = izinli"
   * kuralı sökme ile ters çalışırdı.)
   *
   * @param {string} ad data-sekme
   * @returns {string[]|null} bilinmeyen sekme → null
   */
  function sekmeKabuklari(ad) {
    for (var i = 0; i < kayitlar.length; i++) {
      var k = kayitlar[i];

      if (k.dugum.classList && k.dugum.classList.contains('menu-btn') &&
          k.dugum.getAttribute('data-sekme') === String(ad)) {
        return k.kabuklar.slice();
      }
    }

    return null;
  }

  /** Testler için: kayıtların salt-okunur özeti. */
  function kayitOzeti() {
    return kayitlar.map(function (k) {
      return { kimlik: k.kimlik, kabuklar: k.kabuklar.slice(), takili: takili(k) };
    });
  }

  /** Testler için sıfırlama (jsdom pencereleri arasında). */
  function sifirla() {
    kayitlar = [];
    pencere = null;
    kuruldu = false;
    bekleyen = '';
  }

  var Yonlendirici = {
    kur: kur,
    kabukGec: kabukGec,
    uygula: uygula,
    aktifKabuk: aktifKabuk,
    rolKabugu: rolKabugu,
    sekmeKabuklari: sekmeKabuklari,
    kayitOzeti: kayitOzeti,
    bekleyenKabuk: function () { return bekleyen; },
    sifirla: sifirla,
    KABUKLAR: KABUKLAR,
    OTURUM_KABUKLARI: OTURUM_KABUKLARI
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Yonlendirici;
  }

  if (typeof window !== 'undefined') {
    window.KabukYonlendirici = Yonlendirici;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
