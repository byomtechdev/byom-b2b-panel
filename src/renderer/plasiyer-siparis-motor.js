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
 *
 *  BİLEŞİK İSKONTO (Faz 9) — TEK FORMÜL:
 *      Net = Liste × (1 − bayi/100) × (1 − ödemeYöntemi/100)
 *  `sepet.iskonto`      = BAYİ iskontosu (müşteri seçilince onun oranından
 *                          gelir, tavana kırpılır; plasiyer düşürebilir)
 *  `sepet.odemeIskonto` = ÖDEME YÖNTEMİ iskontosu (Nakit/Vade/Kart —
 *                          müşterinin `odemeIskontolari` tablosundan, o tablo
 *                          sunucunun ödeme matrisinden gelir)
 *  İki oran TOPLANMAZ, ardışık uygulanır: %10 + %5 ≠ %15, = %14,5. Toplamak
 *  müşteriye söylenen fiyatla sunucunun yazdığı fiyatı ayrıştırırdı; sunucu
 *  da aynı sırayla iki ayrı ücret satırı yazar (class-b2b-rest-plasiyer.php).
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

  /**
   * Ürünün KDV oranı (%). SUNUCUDAN gelir; panel kendi listesini tutmaz.
   * Katalog kaydı `kdv_orani`, ham REST yükü `byom.kdvOrani` adını kullanır.
   * Çözülemeyen değer 0 = "bilinmiyor" (yanlış bir oran uydurmaktan iyidir).
   */
  function kdvOrani(urun) {
    if (!urun || 'object' !== typeof urun) return 0;

    var byom = urun.byom || {};
    var n = Number(undefined !== urun.kdv_orani ? urun.kdv_orani
      : (undefined !== urun.kdvOrani ? urun.kdvOrani : byom.kdvOrani));

    if (!isFinite(n) || n < 0) return 0;

    return n > 100 ? 100 : Math.round(n * 100) / 100;
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
      iskonto: 0,        // bayi iskontosu (%), tavana tabidir
      odemeIskonto: 0,   // ödeme yöntemi iskontosu (%) — bkz. odemeSec
      /*
       * KDV İSTENİYOR MU? (2.18.3 — "KDV İSTİYORUM / KDV İSTEMİYORUM")
       *
       * VARSAYILAN TRUE: fiyatlar KDV DAHİL girilir (sistemin sözleşmesi),
       * yani normal sipariş KDV'lidir. Varsayılanı false yapmak, seçim
       * ekranına hiç girmeyen her siparişi sessizce KDV'siz yazardı — bu bir
       * arayüz tercihi değil, doğrudan fatura hatasıdır.
       *
       * BU BAYRAK FİYAT HESABINA GİRMEZ. `toplamlar()` dokunulmadı: KDV'nin
       * satırlardan düşülmesi SUNUCUNUN işidir
       * (B2B_Order_Revision::apply_vat_mode → `_b2b_vat_excluded`), çünkü oran
       * ürün başınadır (`_byom_kdv_rate`) ve panel kendi oran listesini tutmaz.
       * Motor yalnızca kararı TAŞIR.
       */
      kdvDahil: true
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
        /*
         * ÜRÜNÜN KDV ORANI — yalnızca TAŞINIR, hesaba girmez. Katalog kaydı
         * sunucudan gelir (wc/v3 ürün eki → `byom.kdvOrani`); alan yoksa 0,
         * yani "bilmiyorum". Arayüz o hâlde tahmini KDV düşümü GÖSTERMEZ,
         * "sunucuda hesaplanacak" der — uydurma sayı basmak, plasiyerin
         * müşteriye yanlış fiyat söylemesi demek olurdu.
         */
        kdv_orani: kdvOrani(urun),
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

  /** Yüzdeyi 0-100 aralığına güvenli oturtur (bileşik formülün girdileri). */
  function yuzde(n) {
    n = Number(n);

    if (!isFinite(n) || n < 0) return 0;

    return Math.min(100, n);
  }

  /**
   * BİLEŞİK NET FİYAT — Net = Liste × (1 − bayi/100) × (1 − ödeme/100).
   *
   * Vitrin kartı, matris satırı ve sepet satırı fiyatı BU fonksiyondan basar;
   * toplamlar da aynı iki oranla hesaplanır. Formül tek yerde durur.
   */
  function netFiyat(liste, bayiOrani, odemeOrani) {
    var l = Number(liste) || 0;

    return kurus(l * (1 - yuzde(bayiOrani) / 100) * (1 - yuzde(odemeOrani) / 100));
  }

  /**
   * Sepet toplamları — bileşik iskonto.
   *
   * Bayi iskontosu TAVANLA sınırlanarak uygulanır: arayüzde bir hata olsa bile
   * hesaplanan tutar yöneticinin izin verdiği sınırın altına inemez. Ödeme
   * yöntemi iskontosu tavana TABİ DEĞİLDİR: o plasiyerin verdiği bir taviz
   * değil, mağazanın ödeme matrisinde yazan şirket kuralıdır.
   *
   * Alan adları Faz 2 ile geriye uyumlu: `indirim`/`iskontoOrani` bayi
   * katmanıdır, `genelToplam` her iki katmandan sonraki nettir.
   */
  /**
   * Bir sepet satırının KDV künyesi (Faz 14).
   *
   * KDV FİYATIN İÇİNDEDİR (sistemin sözleşmesi: fiyatlar KDV dâhil girilir).
   * Bu yüzden net = brüt / (1 + oran/100), KDV = brüt − net. 100 TL'lik %10
   * KDV'li ürünün KDV hariç fiyatı 90 DEĞİL 90,91'dir; yüzde ÇIKARARAK
   * (100 × 0,90) hesaplayan bir sistem "90'a %10 ekle → 99" ile kendi
   * kendini yalanlar. Sunucu da aynı bölmeyi yapar
   * (B2B_Order_Revision::apply_vat_mode: subtotal / factor).
   *
   * Oranı bilinmeyen satır için SAYI UYDURULMAZ: net = brüt, kdv 0 ve
   * `bilinmiyor: true` — plasiyer müşteriye yanlış fiyat söylemesin; kesin
   * tutar sunucuda ürünün kendi oranıyla hesaplanır.
   */
  function kalemKdv(satir) {
    var adet = adediOturt(satir, satir.adet);
    var brut = kurus((Number(satir.price) || 0) * adet);
    var oran = kdvOrani(satir);

    if (oran <= 0) {
      return { adet: adet, brut: brut, net: brut, kdv: 0, oran: 0, bilinmiyor: true };
    }

    var net = kurus(brut / (1 + oran / 100));

    return { adet: adet, brut: brut, net: net, kdv: kurus(brut - net), oran: oran, bilinmiyor: false };
  }

  function toplamlar(sepet, tavan) {
    var araToplam = 0;
    var brutAra = 0;
    var kdvToplam = 0;
    var kalem = 0;
    var koli = 0;
    var oranlar = [];
    var bilinmeyen = 0;

    /*
     * KDV KİPİ SİPARİŞ BAŞINADIR (`sepet.kdvDahil`). Alan tanımsızsa KDV
     * DÂHİL sayılır: kuyrukta bekleyen eski siparişler ve bu alanı hiç
     * bilmeyen çağıranlar sessizce KDV'siz hesaba düşmesin.
     *
     * SIRA SUNUCUYLA AYNI: önce satırlar netleşir (KDV düşülür), iskontolar
     * SONRA ve NET matrah üzerinden uygulanır. Ters sıra (KDV'li matrahtan
     * iskonto, sonra KDV düş) hem sunucudan farklı bir sayı üretir hem de
     * müşteriye fazladan indirim yazar — Registry §0 madde 1 sınıfı hata.
     */
    var dahil = false !== sepet.kdvDahil;

    sepet.satirlar.forEach(function (s) {
      var k = kalemKdv(s);

      brutAra += k.brut;
      kdvToplam += k.kdv;
      araToplam += dahil ? k.brut : k.net;
      kalem += k.adet;
      koli += koliSayisi(s, k.adet);

      if (k.bilinmiyor) {
        bilinmeyen++;
      } else if (-1 === oranlar.indexOf(k.oran)) {
        oranlar.push(k.oran);
      }
    });

    var oran = uygulanabilirIskonto(sepet.iskonto, tavan);
    var indirim = kurus(araToplam * (oran / 100));
    var bayiSonrasi = kurus(araToplam - indirim);

    var odemeOrani = yuzde(sepet.odemeIskonto);
    var odemeIndirim = kurus(bayiSonrasi * (odemeOrani / 100));

    return {
      satir: sepet.satirlar.length,
      kalem: kalem,
      koli: koli,
      araToplam: kurus(araToplam),
      /* Brüt liste (KDV dâhil) her kipte aynıdır: özet "Liste (KDV dâhil)"
         satırını ve düşüm farkını bundan kurar. */
      brutAraToplam: kurus(brutAra),
      kdvDahil: dahil,
      iskontoOrani: oran,
      indirim: indirim,
      bayiSonrasi: bayiSonrasi,
      odemeIskontoOrani: odemeOrani,
      odemeIndirim: odemeIndirim,
      genelToplam: kurus(bayiSonrasi - odemeIndirim),
      kdv: {
        dahil: dahil,
        tutar: kurus(kdvToplam),
        dusulen: dahil ? 0 : kurus(kdvToplam),
        oran: 1 === oranlar.length ? oranlar[0] : 0,
        karisik: oranlar.length > 1,
        bilinmeyen: bilinmeyen,
        hicYok: 0 === oranlar.length
      }
    };
  }

  /**
   * Müşterinin ödeme yöntemi iskontosu (%).
   *
   * Kaynak: bayi yükündeki `odemeIskontolari` = { nakit, vade, kart } —
   * sunucu bunu müşterinin grubuna (bireysel/kurumsal) göre ödeme matrisinden
   * hesaplayıp verir. Bilinmeyen yöntem ya da eksik tablo → 0 (iskonto yok).
   */
  function odemeIskontosu(musteri, yontem) {
    var tablo = (musteri && musteri.odemeIskontolari) || {};

    if (!odemeGecerliMi(yontem)) return 0;

    return yuzde(tablo[yontem]);
  }

  /**
   * Ödeme yöntemini seçer ve ödeme iskontosunu müşteriden okur.
   *
   * Yöntem geçersizse seçim TEMİZLENİR (boş) — "bilmiyorum" hâlinde eski
   * yöntemin iskontosunu taşımak yanlış fiyat demekti.
   */
  function odemeSec(sepet, yontem) {
    if (!odemeGecerliMi(yontem)) {
      sepet.odeme = '';
      sepet.odemeIskonto = 0;
      return sepet;
    }

    sepet.odeme = String(yontem);
    sepet.odemeIskonto = odemeIskontosu(sepet.musteri, sepet.odeme);

    return sepet;
  }

  /**
   * Müşteri seçilince sepete uygulanır: bayi iskontosu müşterinin oranıdır
   * (tavana kırpılır), ödeme iskontosu seçili yönteme göre tazelenir.
   *
   * Müşteri `null` ise iki oran da SIFIRLANIR — müşterisiz sepet liste
   * fiyatı gösterir.
   */
  function musteriIskontosuUygula(sepet, musteri, tavan) {
    sepet.musteri = musteri || null;

    if (!musteri) {
      sepet.iskonto = 0;
      sepet.odemeIskonto = 0;
      return sepet;
    }

    sepet.iskonto = uygulanabilirIskonto(musteri.iskonto, tavan);
    sepet.odemeIskonto = odemeIskontosu(musteri, sepet.odeme);

    return sepet;
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

    /*
     * ALGORİTMİK DOĞRULAMA BURADA DEĞİL: TCKN/VKN/GSM denetimi
     * src/shared/dogrulama.js → musteriFormuDenetle'de yapılır ve arayüz onu
     * bu çağrıdan ÖNCE koşturur (tüm hatalar birden gösterilir). Bu fonksiyon
     * yalnızca kaydı ŞEKİLLENDİRİR; kimlik türü (tckn/vkn) formdan gelir.
     */
    var iskonto = Number(bilgi.iskonto);

    if (!isFinite(iskonto) || iskonto < 0) iskonto = 0;

    return {
      ok: true,
      hata: '',
      musteri: {
        id: GECICI_ONEK + uuid(),
        gecici: true,
        senkron: false,
        unvan: unvan,
        ad: String(bilgi.yetkili || bilgi.ad || unvan).trim(),
        vergiNo: String(bilgi.vergiNo || bilgi.kimlikNo || '').trim(),
        kimlikTuru: String(bilgi.kimlikTuru || '').trim(),
        telefon: String(bilgi.telefon || '').trim(),
        eposta: String(bilgi.eposta || '').trim(),
        il: String(bilgi.il || '').trim(),
        ilce: String(bilgi.ilce || '').trim(),
        adres: String(bilgi.adres || '').trim(),
        /* Bayi iskontosu (%) — plasiyerin verdiği; tavan denetimi formda ve
           sunucuda. Ödeme iskontoları sunucudan gelir; çevrimdışı müşteride
           henüz yoktur (boş tablo = 0). */
        iskonto: Math.min(100, iskonto),
        odemeIskontolari: (bilgi.odemeIskontolari && 'object' === typeof bilgi.odemeIskontolari)
          ? bilgi.odemeIskontolari
          : {},
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
  /**
   * "KENDİ SİPARİŞLERİM" SÜZGECİ (Faz 6)
   *
   * Plasiyer oturumunda sipariş listesi YALNIZCA o plasiyerin YAZDIĞI
   * siparişleri göstermeli. Damga `_b2b_plasiyer_id`'dir ve panele eklentinin
   * `plasiyer_id` alanıyla gelir (eklenti 2.15.0).
   *
   * Bayinin kendi sitesinden verdiği sipariş bu listede YOKTUR — aynı kural
   * ciro istatistiğinde de geçerli (`B2B_Plasiyer::get_plasiyer_stats`). İki
   * yerde iki farklı "benim siparişim" tanımı üretmemek için bilinçli olarak
   * aynı damga kullanılıyor.
   *
   * KİMLİK BİLİNMİYORSA BOŞ LİSTE DÖNER. "Bilmiyorum" hâlinde her şeyi
   * göstermek, tam olarak engellemeye çalıştığımız sızıntı olurdu.
   *
   * ⚠️ Bu bir GÖRÜNÜM süzgecidir, yetki sınırı DEĞİLDİR: panel mağaza
   * anahtarlarını taşır, veri cihaza zaten iniyor (bkz. kök CLAUDE.md §10).
   * Sunucu tarafında daraltılmış bir uç ayrı iştir.
   */
  function kendiSiparisleri(liste, plasiyerId) {
    if (!Array.isArray(liste)) return [];

    var benim = Number(plasiyerId) || 0;

    if (!benim) return [];

    return liste.filter(function (s) {
      return Number((s && s.plasiyerId) || 0) === benim;
    });
  }

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

  /**
   * Sunucuya gidecek gövde (eşitleme kuyruğu bunu saklar).
   *
   * `yerelKimlik` (Faz 9): sipariş DİSKE yazılırken bir kez üretilir ve
   * sunucuya gider. Sunucu aynı kimlikle ikinci kez gelen isteğe var olan
   * siparişi döner (`tekrar: true`). Bu olmadan ağ kesintisinde "sunucu
   * yazdı ama yanıt kayboldu" hâli, sıradaki turda AYNI siparişi ikinci kez
   * açıyordu — ciro ve cari iki kez işleniyordu.
   */
  function siparisGovdesi(sepet, plasiyer, tavan) {
    var t = toplamlar(sepet, tavan);

    return {
      yerelKimlik: 'sip-' + uuid(),
      plasiyerId: Number((plasiyer && plasiyer.id) || 0) || 0,
      musteriId: sepet.musteri ? sepet.musteri.id : 0,
      geciciMusteri: !!(sepet.musteri && geciciMi(sepet.musteri.id)) ? sepet.musteri : null,
      odeme: String(sepet.odeme || ''),
      /* KDV KARARI SUNUCUYA TAŞINIR (/plasiyer/siparis → kdvDahil). Alan
         tanımsızsa KDV'li sayılır: eski kuyruk kayıtları ve eski panel
         sürümleri sessizce KDV'siz siparişe dönüşmemeli. */
      kdvDahil: false !== sepet.kdvDahil,
      vadeNotu: String(sepet.vadeNotu || ''),
      siparisNotu: String(sepet.siparisNotu || ''),
      iskontoOrani: t.iskontoOrani,
      bayiIskontoOrani: t.iskontoOrani,
      odemeIskontoOrani: t.odemeIskontoOrani,
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
    kdvOrani: kdvOrani,
    /* sepet */
    sepetKur: sepetKur,
    ekle: ekle,
    adetYaz: adetYaz,
    adimlaSatir: adimlaSatir,
    sil: sil,
    bosalt: bosalt,
    satirBul: satirBul,
    toplamlar: toplamlar,
    kalemKdv: kalemKdv,
    /* bileşik iskonto (Faz 9) */
    netFiyat: netFiyat,
    odemeIskontosu: odemeIskontosu,
    odemeSec: odemeSec,
    musteriIskontosuUygula: musteriIskontosuUygula,
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
    kendiSiparisleri: kendiSiparisleri,
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
