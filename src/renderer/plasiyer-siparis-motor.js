/* ============================================================================
 *  PLASİYER SİPARİŞ MOTORU — DOM'SUZ (src/renderer/plasiyer-siparis-motor.js)
 *  ---------------------------------------------------------------------------
 *  Saha satışının bütün SAF mantığı burada: koli matematiği, sepet indirgeyici,
 *  "son siparişi kopyala", geçici müşteri kimliği ve iskonto tavanı.
 *
 *  NEDEN DOM'SUZ: bu kurallar para hesaplar. `node --test` altında doğrudan
 *  koşabilmeleri gerekiyor; bir tarayıcı ortamı kurup tıklama taklit etmek
 *  hem yavaş hem kırılgan olurdu. Arayüz (plasiyer-vitrin.js /
 *  plasiyer-musteri.js) bu motoru ÇAĞIRIR, kuralları tekrar yazmaz.
 *  Aynı kalıp: sira-motor.js, vitrin-motor.js.
 *
 *  HİBRİT KOLİ MATEMATİĞİ — tek kural:
 *    koli_ici_adet > 1  → adet koli katlarında ilerler (24 → 48 → 72)
 *    koli_ici_adet ≤ 1  → tekil adet (1 → 2 → 3)
 *  Kat dışı bir değer elle yazılırsa YUKARI tamamlanır: 25 adet isteyen
 *  bayiye 24 göndermek eksik sevkiyattır, 48 göndermek bilinçli karardır
 *  (eklentideki b2b_snap_to_box ile aynı yön).
 *
 *  İSKONTO TAVANI: bu motorun kararı ARAYÜZ İÇİNDİR — kullanıcıya anında
 *  geri bildirim verir. SON SÖZ SUNUCUDADIR
 *  (B2B_Plasiyer::iskonto_gecerli_mi). İki yerde kural olması bilinçli bir
 *  tekrar değil; biri hız, diğeri güvenlik.
 * ==========================================================================*/

(function (kok) {
  'use strict';

  /** Geçici (çevrimdışı) müşteri kimliği öneki. */
  var GECICI_ONEK = 'temp_musteri_';

  /** Ödeme yöntemleri — ÜÇ TANE, fazlası yok (şirket politikası). */
  var ODEME_YONTEMLERI = ['nakit', 'vade', 'kart'];

  var ODEME_ETIKET = { nakit: 'Nakit', vade: 'Vade', kart: 'Kredi Kartı' };

  /* ------------------------------------------------------------------ *
   *  KOLİ MATEMATİĞİ
   * ------------------------------------------------------------------ */

  /** Koli içi adedi güvenli okunur: tanımsız/0/negatif/ondalık → 1. */
  function koliIci(urun) {
    var n = Number(urun && urun.koli_ici_adet);

    if (!isFinite(n) || n < 1) return 1;

    return Math.floor(n);
  }

  /** Ürün koli katlarında mı satılır? */
  function koliliMi(urun) {
    return koliIci(urun) > 1;
  }

  /**
   * Adedi ürünün satış birimine oturtur.
   *
   * Kat dışı değer YUKARI tamamlanır (eksik sevkiyat yerine tam koli).
   * Sonuç en az bir birimdir: 0 ya da negatif istek bir koliye çekilir —
   * "sepette 0 adetli satır" diye bir şey yoktur, silinmesi gerekir.
   */
  function adediOturt(urun, adet) {
    var birim = koliIci(urun);
    var n = Number(adet);

    if (!isFinite(n) || n <= 0) return birim;

    return Math.ceil(n / birim) * birim;
  }

  /**
   * `+` / `-` düğmelerinin bir adımı.
   *
   * @param {object} urun Ürün.
   * @param {number} adet Mevcut adet.
   * @param {number} yon  +1 artır, -1 azalt.
   * @returns {number} Yeni adet (en az bir birim).
   */
  function adimla(urun, adet, yon) {
    var birim = koliIci(urun);
    var simdi = adediOturt(urun, adet);
    var hedef = simdi + (yon < 0 ? -birim : birim);

    return hedef < birim ? birim : hedef;
  }

  /** Kaç koli ediyor? (tekil satılan üründe 0) */
  function koliSayisi(urun, adet) {
    var birim = koliIci(urun);

    if (birim <= 1) return 0;

    return Math.floor(adediOturt(urun, adet) / birim);
  }

  /** "48 Adet (2 Koli)" / "3 Adet" */
  function adetEtiketi(urun, adet) {
    var n = adediOturt(urun, adet);
    var koli = koliSayisi(urun, n);

    return koli > 0 ? (n + ' Adet (' + koli + ' Koli)') : (n + ' Adet');
  }

  /* ------------------------------------------------------------------ *
   *  SEPET
   * ------------------------------------------------------------------ */

  /** Boş sepet durumu. */
  function sepetKur() {
    return {
      satirlar: [],
      musteri: null,
      odeme: '',
      vadeNotu: '',
      siparisNotu: '',
      iskonto: 0
    };
  }

  function satirBul(sepet, id) {
    for (var i = 0; i < sepet.satirlar.length; i++) {
      if (Number(sepet.satirlar[i].id) === Number(id)) return i;
    }

    return -1;
  }

  /**
   * Ürünü sepete ekler; zaten varsa adedi ARTIRIR (yerine yazmaz).
   *
   * Artırmak bilinçli: plasiyer aynı ürünü ikinci kez okuttuğunda "üstüne
   * ekle" demek ister; yerine yazmak ilk girdiyi sessizce kaybettirirdi.
   */
  function ekle(sepet, urun, adet) {
    if (!urun || !Number(urun.id)) return sepet;

    var k = satirBul(sepet, urun.id);
    var istenen = adediOturt(urun, undefined === adet || null === adet ? koliIci(urun) : adet);

    if (k === -1) {
      sepet.satirlar.push({
        id: Number(urun.id),
        name: String(urun.name || ''),
        sku: String(urun.sku || ''),
        barcode: String(urun.barcode || ''),
        price: Number(urun.price) || 0,
        koli_ici_adet: koliIci(urun),
        adet: istenen
      });
    } else {
      sepet.satirlar[k].adet = adediOturt(urun, sepet.satirlar[k].adet + istenen);
    }

    return sepet;
  }

  /** Satır adedini doğrudan yazar (matris modundaki adet kutucuğu). */
  function adetYaz(sepet, id, adet) {
    var k = satirBul(sepet, id);

    if (k === -1) return sepet;

    sepet.satirlar[k].adet = adediOturt(sepet.satirlar[k], adet);

    return sepet;
  }

  /** Bir adım artır/azalt; bir birimin altına düşerse satır SİLİNİR. */
  function adimlaSatir(sepet, id, yon) {
    var k = satirBul(sepet, id);

    if (k === -1) return sepet;

    var satir = sepet.satirlar[k];
    var birim = koliIci(satir);

    if (yon < 0 && adediOturt(satir, satir.adet) <= birim) {
      sepet.satirlar.splice(k, 1);
      return sepet;
    }

    satir.adet = adimla(satir, satir.adet, yon);

    return sepet;
  }

  function sil(sepet, id) {
    var k = satirBul(sepet, id);

    if (k !== -1) sepet.satirlar.splice(k, 1);

    return sepet;
  }

  function bosalt(sepet) {
    sepet.satirlar = [];
    return sepet;
  }

  /* ------------------------------------------------------------------ *
   *  TOPLAMLAR
   * ------------------------------------------------------------------ */

  /** Kuruşta yuvarlar — kayan nokta artığı toplamlarda görünmesin. */
  function kurus(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  /**
   * Sepet toplamları.
   *
   * İskonto TAVANLA sınırlanarak uygulanır: arayüzde bir hata olsa bile
   * hesaplanan tutar yöneticinin izin verdiği sınırın altına inemez.
   */
  function toplamlar(sepet, tavan) {
    var araToplam = 0;
    var kalem = 0;
    var koli = 0;

    sepet.satirlar.forEach(function (s) {
      var adet = adediOturt(s, s.adet);

      araToplam += (Number(s.price) || 0) * adet;
      kalem += adet;
      koli += koliSayisi(s, adet);
    });

    var oran = uygulanabilirIskonto(sepet.iskonto, tavan);
    var indirim = kurus(araToplam * (oran / 100));

    return {
      satir: sepet.satirlar.length,
      kalem: kalem,
      koli: koli,
      araToplam: kurus(araToplam),
      iskontoOrani: oran,
      indirim: indirim,
      genelToplam: kurus(araToplam - indirim)
    };
  }

  /* ------------------------------------------------------------------ *
   *  İSKONTO TAVANI
   * ------------------------------------------------------------------ */

  /** Tavanı güvenli okur: tanımsız/geçersiz → 0 (sınırsız DEĞİL). */
  function tavaniOku(tavan) {
    var n = Number(tavan);

    if (!isFinite(n) || n < 0) return 0;

    return Math.min(100, n);
  }

  /** Tavanı aşmayan, uygulanabilir iskonto oranı. */
  function uygulanabilirIskonto(istenen, tavan) {
    var t = tavaniOku(tavan);
    var n = Number(istenen);

    if (!isFinite(n) || n <= 0) return 0;

    return Math.min(t, n);
  }

  /**
   * İstenen iskonto tavanı aşıyor mu?
   *
   * @returns {object} { ok, oran, tavan, hata }
   */
  function iskontoDenetle(istenen, tavan) {
    var t = tavaniOku(tavan);
    var n = Number(istenen);

    if (!isFinite(n) || n < 0) {
      return { ok: false, oran: 0, tavan: t, hata: 'İskonto oranı geçersiz.' };
    }

    if (n > t) {
      return {
        ok: false,
        oran: t,
        tavan: t,
        hata: 'Verebileceğiniz en yüksek iskonto %' + t + '. İstenen: %' + n + '.'
      };
    }

    return { ok: true, oran: n, tavan: t, hata: '' };
  }

  /** Sepete iskonto yazar; tavanı aşarsa TAVANA kırpar ve uyarıyı döndürür. */
  function iskontoYaz(sepet, istenen, tavan) {
    var karar = iskontoDenetle(istenen, tavan);

    sepet.iskonto = karar.ok ? Number(istenen) : karar.tavan;

    return karar;
  }

  /* ------------------------------------------------------------------ *
   *  SON SİPARİŞİ KOPYALA
   * ------------------------------------------------------------------ */

  /**
   * Son siparişin kalemlerini sepete doldurur.
   *
   * `urunBul(id)` ENJEKTE EDİLİR (katalog deposu verir). Sebebi: siparişteki
   * fiyat GEÇMİŞE aittir; bugünün fiyatı katalogdan okunur. Eski fiyatı
   * kopyalamak, zam görmüş bir ürünü zararına satmak olurdu.
   *
   * Katalogda bulunamayan kalem ATLANIR ve `atlanan` listesinde döner —
   * sessizce düşürmek plasiyerin eksik sipariş yazmasına yol açardı.
   *
   * Sepet bundan sonra TAMAMEN DÜZENLENEBİLİRDİR: adetler değişir, satır
   * silinir, yeni ürün eklenir (bkz. ekle/sil/adimlaSatir).
   *
   * @param {object}   siparis  { line_items: [{ product_id, quantity, name }] }
   * @param {function} urunBul  (id) => urun|null
   * @param {object}   sepet    Hedef sepet (verilmezse yenisi kurulur).
   * @returns {object} { sepet, eklenen, atlanan[] }
   */
  function sonSiparisiKopyala(siparis, urunBul, sepet) {
    sepet = sepet || sepetKur();

    var kalemler = (siparis && (siparis.line_items || siparis.kalemler)) || [];
    var atlanan = [];
    var eklenen = 0;

    if (!Array.isArray(kalemler) || 'function' !== typeof urunBul) {
      return { sepet: sepet, eklenen: 0, atlanan: atlanan };
    }

    kalemler.forEach(function (k) {
      var id = Number((k && (k.product_id || k.id)) || 0);
      var adet = Number((k && (k.quantity || k.adet)) || 0);

      if (!id) return;

      var urun = null;

      try { urun = urunBul(id); } catch (e) { urun = null; }

      if (!urun) {
        atlanan.push({ id: id, ad: String((k && k.name) || ('#' + id)), sebep: 'katalogda yok' });
        return;
      }

      ekle(sepet, urun, adet > 0 ? adet : koliIci(urun));
      eklenen++;
    });

    return { sepet: sepet, eklenen: eklenen, atlanan: atlanan };
  }

  /* ------------------------------------------------------------------ *
   *  GEÇİCİ (ÇEVRİMDIŞI) MÜŞTERİ
   * ------------------------------------------------------------------ */

  /**
   * RFC 4122 v4 biçiminde kimlik.
   *
   * `crypto.randomUUID` varsa o kullanılır; yoksa `crypto.getRandomValues`,
   * o da yoksa Math.random'a düşülür. Son yedek kriptografik değildir ama bu
   * kimlik bir SIR değil, yalnızca eşitlemeye kadar kullanılacak bir
   * etikettir — çakışmaması yeter.
   */
  function uuid() {
    try {
      if (kok.crypto && 'function' === typeof kok.crypto.randomUUID) return kok.crypto.randomUUID();
    } catch (e) { /* yedeğe düş */ }

    try {
      if (kok.crypto && 'function' === typeof kok.crypto.getRandomValues) {
        var b = new Uint8Array(16);
        kok.crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;

        var h = [].map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');

        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      }
    } catch (e) { /* yedeğe düş */ }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return ('x' === c ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  /**
   * Çevrimdışı müşteri kaydı üretir.
   *
   * Kimlik `temp_musteri_<uuid>` biçimindedir ve METİNDİR: sayısal bir
   * WordPress kimliğiyle KARIŞTIRILAMAZ. Eşitleme bu öneke bakarak
   * "sunucuda henüz yok" kararını verir.
   */
  function geciciMusteri(bilgi) {
    bilgi = bilgi || {};

    var unvan = String(bilgi.unvan || bilgi.ad || '').trim();

    if (!unvan) return { ok: false, hata: 'Firma ünvanı zorunludur.', musteri: null };

    return {
      ok: true,
      hata: '',
      musteri: {
        id: GECICI_ONEK + uuid(),
        gecici: true,
        senkron: false,
        unvan: unvan,
        ad: String(bilgi.yetkili || bilgi.ad || unvan).trim(),
        vergiNo: String(bilgi.vergiNo || '').trim(),
        telefon: String(bilgi.telefon || '').trim(),
        eposta: String(bilgi.eposta || '').trim(),
        il: String(bilgi.il || '').trim(),
        ilce: String(bilgi.ilce || '').trim(),
        adres: String(bilgi.adres || '').trim(),
        acikBakiye: 0,
        olusturma: new Date().toISOString()
      }
    };
  }

  /** Kimlik geçici mi? (eşitleme ve sipariş gönderimi buna bakar) */
  function geciciMi(id) {
    return 'string' === typeof id && 0 === id.indexOf(GECICI_ONEK);
  }

  /* ------------------------------------------------------------------ *
   *  SİPARİŞ GÖVDESİ
   * ------------------------------------------------------------------ */

  /** Ödeme yöntemi geçerli mi? */
  function odemeGecerliMi(yontem) {
    return ODEME_YONTEMLERI.indexOf(String(yontem || '')) !== -1;
  }

  /**
   * Sipariş gönderilmeye hazır mı?
   *
   * @returns {object} { ok, hatalar[] }
   */
  function siparisDenetle(sepet, tavan) {
    var hatalar = [];

    if (!sepet.musteri || (!Number(sepet.musteri.id) && !geciciMi(sepet.musteri.id))) {
      hatalar.push('Müşteri seçilmedi.');
    }

    if (!sepet.satirlar.length) hatalar.push('Sepet boş.');

    if (!odemeGecerliMi(sepet.odeme)) hatalar.push('Ödeme yöntemi seçilmedi (Nakit / Vade / Kredi Kartı).');

    var iskonto = iskontoDenetle(sepet.iskonto, tavan);

    if (!iskonto.ok) hatalar.push(iskonto.hata);

    return { ok: 0 === hatalar.length, hatalar: hatalar };
  }

  /** Sunucuya gidecek gövde (Faz 2 eşitleme kuyruğu bunu saklar). */
  function siparisGovdesi(sepet, plasiyer, tavan) {
    var t = toplamlar(sepet, tavan);

    return {
      plasiyerId: Number((plasiyer && plasiyer.id) || 0) || 0,
      musteriId: sepet.musteri ? sepet.musteri.id : 0,
      geciciMusteri: !!(sepet.musteri && geciciMi(sepet.musteri.id)) ? sepet.musteri : null,
      odeme: String(sepet.odeme || ''),
      vadeNotu: String(sepet.vadeNotu || ''),
      siparisNotu: String(sepet.siparisNotu || ''),
      iskontoOrani: t.iskontoOrani,
      toplamlar: t,
      kalemler: sepet.satirlar.map(function (s) {
        return {
          product_id: s.id,
          quantity: adediOturt(s, s.adet),
          sku: s.sku,
          name: s.name,
          price: s.price,
          koli_ici_adet: s.koli_ici_adet
        };
      })
    };
  }

  var Motor = {
    /* koli */
    koliIci: koliIci,
    koliliMi: koliliMi,
    adediOturt: adediOturt,
    adimla: adimla,
    koliSayisi: koliSayisi,
    adetEtiketi: adetEtiketi,
    /* sepet */
    sepetKur: sepetKur,
    ekle: ekle,
    adetYaz: adetYaz,
    adimlaSatir: adimlaSatir,
    sil: sil,
    bosalt: bosalt,
    satirBul: satirBul,
    toplamlar: toplamlar,
    /* iskonto */
    tavaniOku: tavaniOku,
    uygulanabilirIskonto: uygulanabilirIskonto,
    iskontoDenetle: iskontoDenetle,
    iskontoYaz: iskontoYaz,
    /* son siparis */
    sonSiparisiKopyala: sonSiparisiKopyala,
    /* musteri */
    uuid: uuid,
    geciciMusteri: geciciMusteri,
    geciciMi: geciciMi,
    /* siparis */
    odemeGecerliMi: odemeGecerliMi,
    siparisDenetle: siparisDenetle,
    siparisGovdesi: siparisGovdesi,
    /* sabitler */
    GECICI_ONEK: GECICI_ONEK,
    ODEME_YONTEMLERI: ODEME_YONTEMLERI,
    ODEME_ETIKET: ODEME_ETIKET
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Motor;
  }

  if (typeof window !== 'undefined') {
    window.PlasiyerSiparisMotor = Motor;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
