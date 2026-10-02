/* ============================================================================
 *  REVİZE ÖNİZLEME MOTORU — DOM'suz, çift modlu (Faz 19)
 *  ---------------------------------------------------------------------------
 *  Revize penceresinde depocu adet değiştirdikçe / ürün ekleyip çıkardıkça
 *  ekrandaki toplamı hesaplar. SUNUCUYA GİTMEZ (Registry §0 madde 3); son söz
 *  eklentidedir ve formül oradakiyle BİREBİR aynıdır:
 *
 *      taban  = Σ güncel satır tutarı
 *      bayi   = round( taban × bayiOranı / 100 , 2 )            (saha: ücret satırı)
 *      ödeme  = round( (taban − bayi) × ödemeOranı / 100 , 2 )   (bileşik)
 *      toplam = taban − bayi − ödeme + kargo
 *
 *  Sunucu ikizi: b2b-core › B2B_Ucret_Motoru::tutarlar(). İkisi ayrışırsa
 *  ekranda gösterilen ile siteye yazılan tutar ayrışır — Depo Fişi 6501'de
 *  yaşanan "iskonto 3.520,92'de çakılı kaldı" hatasının ekrandaki ikizi.
 *
 *  KDV KİPİ İKİ YÖNLÜDÜR: satır fiyatı siparişin MEVCUT kipindedir (KDV hariç
 *  yapılmış siparişte zaten nettir). Dönüşüm yalnızca hedef kip mevcut
 *  kipten FARKLIYSA yapılır — aksi hâlde KDV hariç bir sipariş yeniden
 *  açıldığında fiyat İKİNCİ KEZ bölünürdü.
 *
 *  SİPARİŞE ÖZEL İSKONTO REVİZESİ girilmişse (Faz 15) satır fiyatı LİSTE
 *  fiyatından yeniden kurulur ve bayi iskonto ÜCRET SATIRI kalkar (iskonto
 *  artık satır fiyatındadır — sunucu: apply_discount_rate).
 *
 *  Bu bir TAHMİNDİR: kuruş yuvarlaması satır başına yapılır; sunucu KDV
 *  dönüşümünde yuvarlamadan saklar (Faz 18 ölçümü: ≤ 1 kuruş). Ekran bunu
 *  "kesin tutar sitede hesaplanır" diye açıkça söyler.
 * ==========================================================================*/

(function (kok) {
  'use strict';

  function sayi(n) {
    var x = Number(n);
    return isFinite(x) ? x : 0;
  }

  /** Kuruşa yuvarlar (2 hane). */
  function kurus(n) {
    return Math.round(sayi(n) * 100 + (sayi(n) >= 0 ? 1e-9 : -1e-9)) / 100;
  }

  function oranKirp(o) {
    return Math.max(0, Math.min(100, sayi(o)));
  }

  /**
   * Yüzdelik iskonto tutarları — sunucunun B2B_Ucret_Motoru::tutarlar ikizi.
   *
   * @param {number} taban      Güncel satır toplamı.
   * @param {number} bayiOrani  Bayi iskonto oranı (%), satırı yoksa 0.
   * @param {number} odemeOrani Ödeme yöntemi iskonto oranı (%), satırı yoksa 0.
   * @returns {{bayi:number, odeme:number}} POZİTİF tutarlar.
   */
  function tutarlar(taban, bayiOrani, odemeOrani) {
    var t = Math.max(0, sayi(taban));
    var bayi = kurus(t * oranKirp(bayiOrani) / 100);
    var odeme = kurus((t - bayi) * oranKirp(odemeOrani) / 100);

    return { bayi: bayi, odeme: odeme };
  }

  /**
   * Tek satırın HEDEF kipteki birim fiyatı.
   *
   * @param {object} r       Satır { birim, listeBirim, kdvOrani }.
   * @param {object} secim   { iskontoOran, kdvMevcutHaric, kdvHedefHaric }.
   * @returns {number}
   */
  function birimHesapla(r, secim) {
    var birim = sayi(r.birim);

    /* Siparişe özel iskonto: LİSTE fiyatından (eski oran çarpana girmez). */
    if (null !== secim.iskontoOran && undefined !== secim.iskontoOran && sayi(r.listeBirim) > 0) {
      birim = sayi(r.listeBirim) * (1 - oranKirp(secim.iskontoOran) / 100);
    }

    var kdv = sayi(r.kdvOrani);

    if (kdv > 0 && !!secim.kdvMevcutHaric !== !!secim.kdvHedefHaric) {
      birim = secim.kdvHedefHaric ? birim / (1 + kdv / 100) : birim * (1 + kdv / 100);
    }

    return birim;
  }

  /**
   * Penceredeki seçimlerin tam önizlemesi.
   *
   * @param {object} g {
   *   satirlar: [{ anahtar, adet, birim, listeBirim, kdvOrani, kaldir, yeni }],
   *   iskontoOran: number|null,
   *   kdvMevcutHaric: bool, kdvHedefHaric: bool,
   *   bayiUcret:  { var, oran, eski },
   *   odemeUcret: { var, oran, eski },
   *   bayiIkiYerde: bool  (eklenti 2.28.1 `dealer_discount_twice`),
   *   kargo: number
   * }
   * @returns {object}
   */
  function hesapla(g) {
    g = g || {};

    var secim = {
      iskontoOran: (null === g.iskontoOran || undefined === g.iskontoOran) ? null : sayi(g.iskontoOran),
      kdvMevcutHaric: !!g.kdvMevcutHaric,
      kdvHedefHaric: !!g.kdvHedefHaric
    };

    var satirlar = [];
    var taban = 0;
    var kdvFark = 0;
    var adet = 0;
    var kaldirilan = 0;
    var eklenen = 0;

    (Array.isArray(g.satirlar) ? g.satirlar : []).forEach(function (r) {
      if (!r) return;

      if (r.kaldir) {
        kaldirilan++;
        satirlar.push({ anahtar: r.anahtar, kaldir: true, birim: 0, tutar: 0 });
        return;
      }

      var a = Math.max(0, Math.floor(sayi(r.adet)));
      var birim = birimHesapla(r, secim);
      var tutar = kurus(birim * a);

      /* Kip değişiyorsa satırın KDV farkı (bilgi satırı için). */
      var kdv = sayi(r.kdvOrani);

      if (kdv > 0 && secim.kdvMevcutHaric !== secim.kdvHedefHaric) {
        var onceki = birimHesapla(r, { iskontoOran: secim.iskontoOran, kdvMevcutHaric: secim.kdvMevcutHaric, kdvHedefHaric: secim.kdvMevcutHaric });
        kdvFark += kurus(onceki * a) - tutar;
      }

      if (r.yeni && a > 0) eklenen++;

      taban += tutar;
      adet += a;
      satirlar.push({ anahtar: r.anahtar, kaldir: false, birim: birim, tutar: tutar });
    });

    taban = kurus(taban);

    var bayiU = g.bayiUcret || {};
    var odemeU = g.odemeUcret || {};

    /* İskonto revizesi bayi ÜCRET SATIRINI siler: iskonto satır fiyatına girer. */
    var bayiVar = !!bayiU.var && null === secim.iskontoOran;
    var t = tutarlar(taban, bayiVar ? bayiU.oran : 0, odemeU.var ? odemeU.oran : 0);

    /*
     * ORANI ÇÖZÜLEMEYEN satır: sunucu motoru böyle bir siparişi "belirsiz"
     * sayar ve iskonto satırlarının HİÇBİRİNE dokunmaz (B2B_Ucret_Motoru::tani).
     * Ekran da aynısını söylemeli — iki satır da eski tutarında sabit.
     */
    /*
     * İNDİRİM İKİ YERDE (Faz 21 — canlı #6512): bayi oranı hem satır
     * fiyatlarına işlenmiş hem ayrı ücret satırında. Sunucu motoru bu
     * siparişi de "belirsiz" sayar (sorun: bayi_iskontosu_iki_yerde) ve
     * iskonto satırlarına dokunmaz; düzeltme onarım aracının işidir. İskonto
     * revizesi seçildiyse bayi satırı silinip fiyat listeden kurulacağı için
     * (bayiVar false) sipariş artık iki yerde değildir — kural uygulanmaz.
     */
    var belirsiz = (bayiVar && (!(sayi(bayiU.oran) > 0) || !!g.bayiIkiYerde)) ||
                   (!!odemeU.var && (!!odemeU.sabit || !(sayi(odemeU.oran) > 0)));

    if (belirsiz) {
      t = { bayi: bayiVar ? kurus(bayiU.eski) : 0, odeme: odemeU.var ? kurus(odemeU.eski) : 0 };
    }

    var kargo = kurus(g.kargo);
    var toplam = kurus(taban - t.bayi - t.odeme + kargo);

    return {
      satirlar: satirlar,
      adet: adet,
      kaldirilan: kaldirilan,
      eklenen: eklenen,
      taban: taban,
      kdvFark: kurus(kdvFark),
      bayi: {
        var: !!bayiU.var,
        siliniyor: !!bayiU.var && null !== secim.iskontoOran,
        oran: sayi(bayiU.oran),
        eski: kurus(bayiU.eski),
        yeni: t.bayi,
        fark: kurus(t.bayi - kurus(bayiU.eski))
      },
      odeme: {
        var: !!odemeU.var,
        oran: sayi(odemeU.oran),
        eski: kurus(odemeU.eski),
        yeni: t.odeme,
        fark: kurus(t.odeme - kurus(odemeU.eski))
      },
      kargo: kargo,
      belirsiz: belirsiz,
      toplam: toplam
    };
  }

  var RevizeOnizleme = {
    kurus: kurus,
    tutarlar: tutarlar,
    birimHesapla: birimHesapla,
    hesapla: hesapla
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = RevizeOnizleme;
  }

  if (typeof window !== 'undefined') {
    window.RevizeOnizleme = RevizeOnizleme;
  }
})(typeof window !== 'undefined' ? window : this);
