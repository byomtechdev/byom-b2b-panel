/* ============================================================================
 *  ÜRÜN SIRALAMA MOTORU — KADEMELİ (DOMİNO) TAŞIMA (src/renderer/sira-motor.js)
 *  ---------------------------------------------------------------------------
 *  DOM'suz, saf mantık katmanı. Ürün & Stok Yönetimi'ndeki sürükle-bırak
 *  sıralamasının bütün hesabı buradadır:
 *
 *   1) DOMİNO TAŞIMA  — bir ürün 5. sıradan 2. sıraya gelince aradaki tüm
 *      ürünler doğal olarak birer sıra kayar (`splice` çıkar + `splice` sok).
 *      Sonuç dizi = sitenin "Genel Katalog Sıralaması" (menu_order = indeks).
 *
 *   2) SÜZGEÇ GÜVENLİĞİ — kategori süzülmüşken bile TAM liste üzerinde
 *      çalışır: hedefin GLOBAL komşuluğu esas alınır; başka kategorilerin
 *      ürünleri yerinden oynamaz, göreli sıraları korunur.
 *
 *   3) BIRAKMA KONUMU — sabit satır yüksekliğinde imleç → (indeks, önce/sonra,
 *      kesme). Sanal listede DOM'a bakmadan hesaplanır; 2px mavi kılavuz
 *      çizgisi `kesme * satirYuksekligi` piksele çizilir.
 *
 *   4) KUYRUK — art arda taşımalar TEK isteğe indirgenir (1500 ms debounce);
 *      istek uçarken gelen yeni taşıma bittiğinde bir kez daha gönderilir
 *      (her gönderim tam anlık görüntü olduğu için son yazan kazanır).
 *
 *  Neden DOM'suz: aynı dosya Electron arayüzünde (window.SiraMotor) ve
 *  node:test altında (require) çalışır; zamanlayıcılar enjekte edilebilir.
 *
 *  Sözleşme: BYOM-REGISTRY.md §3 (POST /products/reorder), §5.8.
 * ==========================================================================*/

(function (kok) {
  'use strict';

  function sinirla(n, enAz, enCok) {
    n = Number(n);
    if (!isFinite(n)) return enAz;
    return Math.max(enAz, Math.min(enCok, Math.round(n)));
  }

  function idEsit(a, b) {
    return String(a) === String(b);
  }

  /** Kimliğin listedeki indeksi (-1: yok). */
  function indeks(liste, id) {
    if (!Array.isArray(liste)) return -1;
    for (var i = 0; i < liste.length; i++) {
      if (liste[i] && idEsit(liste[i].id, id)) return i;
    }
    return -1;
  }

  /**
   * Domino taşıma: `eskiIndex`'teki öğe çıkarılır, `yeniIndex`'e sokulur.
   * Aradaki öğeler birer sıra kayar. Dizi YERİNDE değişir (kaynak dizi = tek
   * gerçek; kopya döndürmek kart/tablo görünümünü ayrı gerçeklere bölerdi).
   *
   * @returns {{from:number,to:number,degisti:boolean,etkilenen:Array}|null}
   *   etkilenen: sırası değişen kimlikler (taşınan dahil), yeni sıralarıyla.
   */
  function tasi(liste, eskiIndex, yeniIndex) {
    if (!Array.isArray(liste) || !liste.length) return null;

    var n = liste.length;
    eskiIndex = sinirla(eskiIndex, 0, n - 1);
    yeniIndex = sinirla(yeniIndex, 0, n - 1);

    if (eskiIndex === yeniIndex) {
      return { from: eskiIndex, to: yeniIndex, degisti: false, etkilenen: [] };
    }

    var tasinan = liste.splice(eskiIndex, 1)[0];
    liste.splice(yeniIndex, 0, tasinan);

    var bas = Math.min(eskiIndex, yeniIndex);
    var son = Math.max(eskiIndex, yeniIndex);
    var etkilenen = [];
    for (var i = bas; i <= son; i++) etkilenen.push(liste[i].id);

    return { from: eskiIndex, to: yeniIndex, degisti: true, etkilenen: etkilenen };
  }

  /**
   * Kimlikle taşıma: `kaynakId`, `hedefId`'nin ÖNÜNE (oncesineMi=true) ya da
   * ARKASINA gelir. Süzülmüş bir görünümden çağrılsa bile TAM liste üzerinde
   * hesaplanır; kaynak ile hedef arasındaki başka kategorilerin ürünleri
   * yalnızca birer kayar, göreli sıraları bozulmaz.
   */
  function tasiId(liste, kaynakId, hedefId, oncesineMi) {
    var eski = indeks(liste, kaynakId);
    var hedef = indeks(liste, hedefId);

    if (eski === -1 || hedef === -1 || eski === hedef) return null;

    /* Hedef indeksi "kaynak çıkarılmış" diziye göre: kaynak hedeften önceyse
       hedef bir sola kayar. */
    var yeni = hedef + (oncesineMi ? 0 : 1);
    if (eski < yeni) yeni -= 1;

    return tasi(liste, eski, yeni);
  }

  /**
   * Pozisyonel menu_order: her ürüne indeksini yazar.
   * @returns {Array<{id, menu_order}>} yalnızca DEĞERİ DEĞİŞEN ürünler.
   */
  function konumlariYaz(liste, alan) {
    alan = alan || 'menuSira';
    var degisen = [];

    if (!Array.isArray(liste)) return degisen;

    for (var i = 0; i < liste.length; i++) {
      var u = liste[i];
      if (!u) continue;
      if (Number(u[alan]) !== i) {
        u[alan] = i;
        degisen.push({ id: u.id, menu_order: i });
      }
    }

    return degisen;
  }

  /** Sıralı kimlik listesi (sunucuya giden gövde). */
  function idListesi(liste) {
    if (!Array.isArray(liste)) return [];
    var out = [];
    for (var i = 0; i < liste.length; i++) {
      if (!liste[i]) continue;
      var n = Number(liste[i].id);
      out.push(isFinite(n) && n > 0 ? n : liste[i].id);
    }
    return out;
  }

  /**
   * Sabit satır yüksekliğinde bırakma konumu.
   *
   * @param {number} y              Kaydırma kutusunun İÇERİK koordinatındaki y
   *                                (clientY - kutu.top + scrollTop).
   * @param {number} satirYuksekligi px
   * @param {number} toplam         Görünen listedeki öğe sayısı
   * @returns {{indeks:number,oncesineMi:boolean,kesme:number}|null}
   *   kesme: görünen listede sokulacak yer (0..toplam); kılavuz çizgisi
   *   `kesme * satirYuksekligi` pikselde durur.
   */
  function birakmaKonumu(y, satirYuksekligi, toplam) {
    toplam = Number(toplam) || 0;
    satirYuksekligi = Number(satirYuksekligi) || 0;
    if (toplam <= 0 || satirYuksekligi <= 0) return null;

    var ham = Number(y) / satirYuksekligi;
    if (!isFinite(ham)) return null;

    var idx = Math.floor(ham);

    if (idx < 0) return { indeks: 0, oncesineMi: true, kesme: 0 };
    if (idx >= toplam) return { indeks: toplam - 1, oncesineMi: false, kesme: toplam };

    var oncesineMi = (ham - idx) < 0.5;
    return { indeks: idx, oncesineMi: oncesineMi, kesme: oncesineMi ? idx : idx + 1 };
  }

  /**
   * Bırakma, kaynağın bulunduğu yere denk mi? (kesme = kendi indeksi ya da
   * hemen altı ise taşıma bir şey değiştirmez; boş yere istek atılmaz.)
   */
  function bosTasimaMi(gorunen, kaynakId, kesme) {
    var i = indeks(gorunen, kaynakId);
    if (i === -1) return true;
    return kesme === i || kesme === i + 1;
  }

  /** Görünen listede komşu: yon -1 üst, +1 alt. */
  function komsu(gorunen, id, yon) {
    var i = indeks(gorunen, id);
    if (i === -1) return null;
    var j = i + (yon < 0 ? -1 : 1);
    if (j < 0 || j >= gorunen.length) return null;
    return gorunen[j] || null;
  }

  /**
   * Gönderim kuyruğu: `bekleme` ms içindeki taşımalar tek isteğe indirgenir.
   * `gonder()` bir Promise döndürür; uçarken gelen `planla()` bittiğinde bir
   * kez daha çalıştırılır. Zamanlayıcılar test için enjekte edilebilir.
   */
  function createKuyruk(secenek) {
    secenek = secenek || {};

    var bekleme = Number(secenek.bekleme) > 0 ? Number(secenek.bekleme) : 1500;
    var setT = secenek.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = secenek.clearTimeout || function (t) { clearTimeout(t); };
    var gonder = typeof secenek.gonder === 'function' ? secenek.gonder : function () { return Promise.resolve(true); };

    var zaman = null;
    var ucuyor = false;
    var tekrar = false;
    var gonderim = 0;

    function calistir() {
      if (ucuyor) {
        tekrar = true;
        return Promise.resolve(false);
      }

      ucuyor = true;
      gonderim++;

      return Promise.resolve()
        .then(function () { return gonder(); })
        .then(function (sonuc) {
          ucuyor = false;
          if (tekrar) { tekrar = false; return calistir(); }
          return sonuc;
        }, function (hata) {
          ucuyor = false;
          if (tekrar) { tekrar = false; return calistir(); }
          throw hata;
        });
    }

    function planla() {
      if (zaman !== null) clearT(zaman);
      zaman = setT(function () {
        zaman = null;
        calistir();
      }, bekleme);
    }

    function hemen() {
      if (zaman !== null) { clearT(zaman); zaman = null; }
      return calistir();
    }

    function iptal() {
      if (zaman !== null) { clearT(zaman); zaman = null; }
      tekrar = false;
    }

    return {
      planla: planla,
      hemen: hemen,
      iptal: iptal,
      bekliyorMu: function () { return zaman !== null; },
      ucuyorMu: function () { return ucuyor; },
      gonderimSayisi: function () { return gonderim; }
    };
  }

  var SiraMotor = {
    indeks: indeks,
    tasi: tasi,
    tasiId: tasiId,
    konumlariYaz: konumlariYaz,
    idListesi: idListesi,
    birakmaKonumu: birakmaKonumu,
    bosTasimaMi: bosTasimaMi,
    komsu: komsu,
    createKuyruk: createKuyruk
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = SiraMotor;
  }

  if (typeof window !== 'undefined') {
    window.SiraMotor = SiraMotor;
  }
})(this);
