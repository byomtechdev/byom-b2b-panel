/* ============================================================================
 *  SİPARİŞ FİŞİ — DOM'SUZ (src/renderer/siparis-fisi.js)
 *  ---------------------------------------------------------------------------
 *  MÜŞTERİYE DÖNÜK sipariş fişi: normalleştirme, yazdırılabilir HTML (A4 ve
 *  80 mm termal), WhatsApp metni ve wa.me adresi.
 *
 *  Depo fişi (renderer.js → depoFisiHtml) DEPOCU içindir: toplama kutucuğu,
 *  KDV sütunu, ürün görseli. Bu fiş BAYİNİN eline geçer: ne aldı, ne kadar
 *  iskonto gördü, ne ödeyecek. İkisi ayrı belgedir; biri diğerini sarmaz.
 *
 *  NEDEN DOM'SUZ: aynı fişi ÜÇ kaynaktan üretmesi gerekiyor —
 *    (a) yönetici listesi   renderer.js → b2bSiparisNormalle çıktısı
 *    (b) saha listesi       modules/plasiyer-siparislerim.js → normalle çıktısı
 *    (c) ham sunucu yükü    prepare_order / ince_siparis_yuku / wc/v3 orders
 *  Kuralı her ekranda tekrar yazmak üç farklı fiş demekti. Modül yalnızca
 *  metin kurar; `node --test` altında doğrudan koşar. Aynı kalıp:
 *  plasiyer-siparis-motor.js, vitrin-motor.js.
 *
 *  KAYNAK TESPİTİ: `items` / `line_items` / `date_created` / `status_label` /
 *  `number` / `dealer` / `billing` alanlarından biri varsa yük HAM'dır
 *  (sunucu sözleşmesi, İngilizce anahtarlar); yoksa panelin NORMAL nesnesidir
 *  (Türkçe anahtarlar). (a) ve (b) aynı okuyucudan geçer: ortak alan adları
 *  aynıdır, birinde olmayan alan '' / 0 olur.
 *
 *  PARA — tek kural, sunucuyla aynı sıra:
 *      Ara toplam  = Σ kalem.tutar (satır fiyatları iskontoluysa liste tutarı)
 *      Bayi isk.   = verilen tutar ‖ satır farkı ‖ ara × oran
 *      Ödeme isk.  = verilen tutar ‖ (ara − bayi) × oran      ← BİLEŞİK
 *      Net         = sunucunun toplamı ‖ ara − bayi − ödeme
 *  Sunucu net verdiyse o basılır: panelin hesabı gösterim, sunucununki
 *  gerçek (§0 madde 1 — formül burada YENİDEN YAZILMAZ, yalnızca dökülür).
 *  Hiçbir alan NaN/undefined çıkmaz; her tutar kuruşa yuvarlanır.
 *
 *  GÜVENLİK: her kullanıcı metni HTML'e `kacis` ile girer; logo yalnızca
 *  data:image/ ya da http(s)/file şemasıyla basılır (javascript: giremez).
 *  Fişte etkileşimli öğe, harici CSS/JS ya da CDN YOKTUR.
 * ==========================================================================*/

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  SABİTLER
   * ------------------------------------------------------------------ */

  /** Para birimi eki — fişte simge değil kısaltma: "2.052,00 TL". */
  var PARA_BIRIMI = 'TL';

  /** WhatsApp metninde en çok kalem; fazlası "… ve N kalem daha" olur. */
  var WA_EN_COK_KALEM = 20;

  /**
   * WhatsApp metni üst sınırı (karakter). wa.me adresi encodeURIComponent ile
   * şişer (Türkçe harf 6-9 karakter) ve Windows'ta çok uzun URL tarayıcıya hiç
   * ulaşmıyor. 1800 karakterlik metin kodlanmış hâliyle güvenli aralıkta kalır.
   */
  var WA_EN_COK_KARAKTER = 1800;

  /** Saha ödeme anahtarı → etiket (plasiyer-siparis-motor.js ile aynı üç yöntem). */
  var ODEME_ETIKET = { nakit: 'Nakit', vade: 'Vade', kart: 'Kredi Kartı' };

  var ALT_YAZI = 'BYOM B2B · Bu fiş bilgi amaçlıdır, fatura yerine geçmez.';

  /** Logoya izin verilen şemalar — javascript:/vbscript: fişe giremez. */
  var LOGO_SEMASI = /^(?:data:image\/|https?:\/\/|file:\/\/)/i;

  /* ------------------------------------------------------------------ *
   *  YARDIMCILAR — sayı, metin, kaçış
   * ------------------------------------------------------------------ */

  function sayi(n) {
    n = Number(n);
    return isFinite(n) ? n : 0;
  }

  /** Kuruşa yuvarlar — kayan nokta artığı (0.1+0.2) hiçbir toplamda görünmesin. */
  function kurus(n) {
    return Math.round(sayi(n) * 100) / 100;
  }

  /** Yüzdeyi 0-100'e sıkıştırır, iki ondalıkta tutar. */
  function yuzde(n) {
    n = sayi(n);

    if (n < 0) return 0;
    if (n > 100) return 100;

    return Math.round(n * 100) / 100;
  }

  function metin(x) {
    return (x === null || x === undefined) ? '' : String(x).trim();
  }

  /** Satır içi metin: yeni satır/sekmeler tek boşluğa iner (WhatsApp satırı bozulmasın). */
  function tekSatir(x) {
    return metin(x).replace(/\s+/g, ' ');
  }

  /** İlk dolu metin (argüman sırasıyla). */
  function ilkDolu() {
    for (var i = 0; i < arguments.length; i++) {
      var m = metin(arguments[i]);

      if (m) return m;
    }

    return '';
  }

  /**
   * İlk POZİTİF sayı. Sıfır "bilinmiyor" sayılır ve sonraki adaya geçilir:
   * yönetici listesi her alanı `Number(…) || 0` ile doldurur, yani 0 çoğu
   * zaman "alan yok" demektir; ilk sıfırda durmak yedek alanı hiç okumamak olurdu.
   */
  function ilkPozitif() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];

      if (v === null || v === undefined || v === '') continue;

      var n = Number(v);

      if (isFinite(n) && n > 0) return n;
    }

    return 0;
  }

  /** HTML kaçışı — her kullanıcı metni fişe buradan girer. */
  function kacis(m) {
    return String(m === null || m === undefined ? '' : m).replace(/[&<>"']/g, function (k) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k];
    });
  }

  /**
   * "2.052,00 TL" — Türk muhasebe biçimi, Intl'siz.
   *
   * Neden Intl yok: Electron küçük ICU ile gelebiliyor ve 'tr-TR' verisi
   * yoksa sessizce en-US'a düşüyordu ("2,052.00"). Metin işleme her ortamda
   * aynı sonucu verir; node altındaki test de bu yüzden deterministtir.
   * (renderer.js → paraSade ile aynı kural; simge yerine kısaltma basar.)
   */
  function paraYaz(n, birim) {
    var d = sayi(n);
    var ham = Math.abs(d).toFixed(2);

    /* İşaret YUVARLAMADAN SONRA belirlenir: -0.004 kuruşta sıfırdır,
       "-0,00 TL" yazılmaz (fişte hatalı iade gibi okunurdu). */
    var eksi = d < 0 && Number(ham) !== 0;
    var nokta = ham.indexOf('.');
    var tam = ham.slice(0, nokta);
    var ondalik = ham.slice(nokta + 1);
    var gruplu = '';

    for (var i = 0; i < tam.length; i++) {
      if (i > 0 && (tam.length - i) % 3 === 0) gruplu += '.';
      gruplu += tam.charAt(i);
    }

    var ek = metin(birim === undefined ? PARA_BIRIMI : birim);

    return (eksi ? '-' : '') + gruplu + ',' + ondalik + (ek ? ' ' + ek : '');
  }

  /** Koli sayısı / oran gibi kısa sayılar: 2 → "2", 2.5 → "2,5", 12.25 → "12,25". */
  function sayiYaz(n) {
    return String(Math.round(sayi(n) * 100) / 100).replace('.', ',');
  }

  function oranYazi(o) {
    return '%' + sayiYaz(o);
  }

  function iki(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Tarihi ISO + "dd.mm.yyyy hh:mm" (yerel saat) olarak çözer; bozuksa ikisi de ''. */
  function tarihCoz(ham) {
    if (ham === null || ham === undefined || ham === '') return { iso: '', yazi: '' };

    var t = ham instanceof Date ? ham : new Date(ham);

    if (isNaN(t.getTime())) return { iso: '', yazi: '' };

    return {
      iso: t.toISOString(),
      yazi: iki(t.getDate()) + '.' + iki(t.getMonth() + 1) + '.' + t.getFullYear() +
            ' ' + iki(t.getHours()) + ':' + iki(t.getMinutes())
    };
  }

  /** Saha anahtarı ("nakit") etikete çevrilir; zaten etiketse dokunulmaz. */
  function odemeEtiketi(x) {
    var m = metin(x);

    return ODEME_ETIKET[m.toLowerCase()] || m;
  }

  /* ------------------------------------------------------------------ *
   *  KALEM
   * ------------------------------------------------------------------ */

  /**
   * Bir satırı tek biçime indirger. Üç kaynağın alan adları birlikte okunur
   * (panel: adet/koliIci/koli/birim/tutar/kod · sunucu: quantity/box_quantity/
   * boxes/unit_price/total/sku · ince yük: koli_ici_adet/birim_fiyat/satir_toplami).
   *
   * KOLİ MATEMATİĞİ TEK YÖNLÜ TAMAMLANIR: koli içi biliniyorsa koli sayısı
   * adetten, koli sayısı biliniyorsa (ve adet tam bölünüyorsa) koli içi
   * adetten türetilir. Koli içi 1 olan ürün tekildir: koli 0'dır —
   * "1 koli × 1 = 1" fişi kirletir.
   *
   * `liste` (iskontosuz satır tutarı) dışa VERİLMEZ; yalnızca ara toplam ve
   * satır iskontosu hesabında kullanılır.
   */
  function kalemNormalle(k) {
    k = (k && 'object' === typeof k) ? k : {};

    var adet = ilkPozitif(k.adet, k.quantity);
    var koliIci = Math.floor(ilkPozitif(k.koliIci, k.koli_ici_adet, k.box_quantity));
    var koli = ilkPozitif(k.koli, k.boxes);
    var tutar = ilkPozitif(k.tutar, k.total, k.satir_toplami);
    var birim = ilkPozitif(k.birim, k.unit_price, k.birim_fiyat, k.fiyat, k.price);
    var liste = ilkPozitif(k.listeAraToplam, k.list_subtotal);
    var sku = ilkDolu(k.sku, k.kod);

    if ('-' === sku) sku = '';   // yönetici listesi boş SKU'yu '-' yazar

    /*
     * Koli TAM SAYIDIR. Sunucu `boxes` alanını `round(adet / koli, 2)` ile
     * verir; 47 adet / 24 = 1,96 "1,96 koli × 24 = 47" diye basılıyordu.
     * Tam bölünmeyen adette koli hiç yazılmaz — yanlış bir küsurat yerine
     * düz adet göstermek doğrudur.
     */
    if (koliIci > 1 && adet > 0 && !koli && 0 === adet % koliIci) koli = adet / koliIci;
    if (koli > 0 && Math.abs(koli - Math.round(koli)) > 0.0001) koli = 0;
    if (koli > 0) koli = Math.round(koli);
    if (koli > 0 && !koliIci && adet > 0 && 0 === adet % koli) koliIci = adet / koli;
    if (1 === koliIci) koli = 0;

    if (!tutar && birim > 0 && adet > 0) tutar = kurus(birim * adet);
    if (!birim && tutar > 0 && adet > 0) birim = kurus(tutar / adet);

    /* Liste tutarı satır tutarından küçük olamaz; küçük/yoksa iskonto yok sayılır. */
    if (liste < tutar) liste = tutar;

    return {
      kalem: {
        ad: ilkDolu(k.ad, k.name),
        sku: sku,
        adet: adet,
        koli: koli,
        koliIci: koliIci,
        birim: kurus(birim),
        tutar: kurus(tutar)
      },
      liste: kurus(liste)
    };
  }

  /**
   * İl adı: WooCommerce Türkiye'de ili "TR35" gibi bir KOD olarak saklar;
   * fişe ve WhatsApp metnine o kod düşüyordu ("İl: TR35"). Çözüm varsa
   * `HaritaVeri` ile ada çevrilir — motorun HaritaVeri'ye ZORUNLU bağımlılığı
   * yoktur (node --test altında `window` yok, ham metin olduğu gibi kalır).
   */
  function ilCoz(ham) {
    var s = metin(ham);

    if (!s) return '';

    var V = (typeof window !== 'undefined' && window.HaritaVeri) || null;

    if (V && 'function' === typeof V.ilBul) {
      var il = null;

      try { il = V.ilBul(s); } catch (e) { il = null; }

      if (il && il.ad) return String(il.ad);
    }

    return s;
  }

  /** "2 koli × 24 = 48" · "2 koli · 47" (koli içi bilinmiyor) · "40" */
  function koliAdetYazi(k) {
    var adet = sayiYaz(k.adet);

    /* Çarpım adede eşit DEĞİLSE eşitlik yazılmaz: sunucu koliyi yukarı
       yuvarladığında (ceil) "2 koli × 24 = 47" gibi yanlış bir denklem
       basılıyordu. */
    if (k.koli > 0 && k.koliIci > 0 && Math.abs(k.koli * k.koliIci - k.adet) < 0.0001) {
      return sayiYaz(k.koli) + ' koli × ' + sayiYaz(k.koliIci) + ' = ' + adet;
    }
    if (k.koli > 0) return sayiYaz(k.koli) + ' koli · ' + adet;

    return adet;
  }

  /* ------------------------------------------------------------------ *
   *  KAYNAK OKUYUCULAR — ham (sunucu) ve normal (panel)
   * ------------------------------------------------------------------ */

  function hamMi(k) {
    return Array.isArray(k.items) || Array.isArray(k.line_items) ||
      k.date_created !== undefined || k.status_label !== undefined ||
      k.number !== undefined || !!k.dealer || !!k.billing;
  }

  function metaHaritasi(md) {
    var m = {};

    (Array.isArray(md) ? md : []).forEach(function (x) {
      if (x && x.key) m[String(x.key)] = x.value;
    });

    return m;
  }

  /**
   * Ücret satırlarından iskonto tutarlarını toplar.
   *
   * Sunucu iki iskontoyu NEGATİF ÜCRET SATIRI olarak yazar ("Plasiyer
   * İskontosu (%10)", "Ödeme Yöntemi İskontosu — Nakit (%5)"); satır
   * fiyatlarına dokunmaz (class-b2b-rest-plasiyer.php). Adında "ödeme" geçen
   * satır ödeme iskontosu, diğer iskonto satırları bayi iskontosudur;
   * parantezdeki oran da okunur.
   */
  function ucretSatirlari(k) {
    var liste = Array.isArray(k.fee_lines) ? k.fee_lines : (Array.isArray(k.ucretler) ? k.ucretler : []);
    var u = { bayi: 0, bayiOran: 0, odeme: 0, odemeOran: 0 };

    liste.forEach(function (f) {
      if (!f || 'object' !== typeof f) return;

      var ad = tekSatir(f.name || f.ad).toLowerCase();
      var tutar = Math.abs(sayi(f.total !== undefined ? f.total : f.tutar));
      var es = /%\s*(\d+(?:[.,]\d+)?)/.exec(ad);
      var oran = es ? sayi(es[1].replace(',', '.')) : 0;

      if (!tutar) return;

      if (/[öo]deme/.test(ad)) {
        u.odeme = kurus(u.odeme + tutar);
        if (oran) u.odemeOran = oran;
      } else if (/iskonto|indirim|plasiyer|bayi/.test(ad)) {
        u.bayi = kurus(u.bayi + tutar);
        if (oran) u.bayiOran = oran;
      }
    });

    return u;
  }

  /** Sunucu sözleşmesi (prepare_order / ince_siparis_yuku / wc/v3 orders). */
  function hamOku(k) {
    var bayi = (k.dealer && 'object' === typeof k.dealer) ? k.dealer : {};
    var fatura = (k.billing && 'object' === typeof k.billing) ? k.billing : {};
    var teslim = (k.shipping && 'object' === typeof k.shipping) ? k.shipping : {};
    var fiyat = (k.pricing && 'object' === typeof k.pricing) ? k.pricing : {};
    var meta = metaHaritasi(k.meta_data);
    var ucret = ucretSatirlari(k);

    var yetkili = ilkDolu(bayi.contact_name, [metin(fatura.first_name), metin(fatura.last_name)].filter(Boolean).join(' '));
    var unvan = ilkDolu(bayi.company_name, fatura.company, yetkili);

    /* Firma yoksa yetkili ünvan olur; aynı adı ikinci kez yazmayız. */
    if (unvan === yetkili) yetkili = '';

    return {
      numara: ilkDolu(k.number, k.id),
      tarih: k.date_created || k.date || '',
      durumEtiketi: ilkDolu(k.status_label, k.status),
      unvan: unvan,
      yetkili: yetkili,
      telefon: ilkDolu(bayi.phone, fatura.phone, teslim.phone),
      il: ilCoz(ilkDolu(bayi.il, bayi.city, fatura.city, teslim.city, fatura.state)),
      vergiNo: ilkDolu(bayi.tax_number, fatura.tax_number, meta._b2b_tax_number, meta.b2b_tax_number),
      plasiyerId: ilkPozitif(k.plasiyer_id, meta._b2b_plasiyer_id),
      plasiyerAd: ilkDolu(k.plasiyer_ad, meta._b2b_plasiyer_ad),
      /*
       * Bayi oranı YALNIZCA ücret satırı tabanlı kaynaklardan okunur
       * (plasiyer_iskonto damgası, ücret satırı). `pricing.order_rate` bilerek
       * okunmaz: web siparişinde satır fiyatları ZATEN iskontoludur; oranı bir
       * kez daha uygulamak iskontoyu iki kez düşmek olurdu. O akışta iskonto
       * `list_subtotal` / `pricing.list_total` farkından türer (bkz. normalle).
       */
      bayiOrani: ilkPozitif(k.plasiyer_iskonto, meta._b2b_plasiyer_iskonto, ucret.bayiOran),
      bayiTutar: ucret.bayi,
      odemeOrani: ilkPozitif(k.odeme_iskonto, k._b2b_odeme_iskonto, meta._b2b_odeme_iskonto, k.payment_discount_rate, ucret.odemeOran),
      odemeTutar: ilkPozitif(ucret.odeme, k.payment_discount_amount),
      listeVerilen: ilkPozitif(fiyat.list_total),
      araVerilen: ilkPozitif(k.subtotal),
      netVerilen: ilkPozitif(k.total),
      odeme: odemeEtiketi(ilkDolu(k.payment_method_title, k.payment_title, meta._b2b_odeme_tipi, k.payment_type_label, k.payment_method)),
      not: ilkDolu(k.customer_note, meta._b2b_vade_notu, k.note),
      kalemler: Array.isArray(k.items) ? k.items : (Array.isArray(k.line_items) ? k.line_items : k.kalemler)
    };
  }

  /** Panelin normal nesnesi (b2bSiparisNormalle ya da plasiyer-siparislerim → normalle). */
  function normalOku(k) {
    var firma = metin(k.firma);
    var musteri = metin(k.musteri);
    /*
     * Ücret satırları panel nesnesinde de okunur: iskonto satır fiyatına
     * değil negatif ücret satırına yazılır ve ORAN damgası boş olabilir
     * (eski sipariş, web akışı). Tutar varken oranı bekleyip satırı hiç
     * basmamak, müşteriye "Ara toplam ile NET neden farklı?" sorusunu
     * cevapsız bırakıyordu.
     */
    var ucret = ucretSatirlari(k);

    return {
      numara: ilkDolu(k.numara, k.id),
      tarih: k.tarih || '',
      durumEtiketi: ilkDolu(k.durumEtiketi, k.durum),
      /* Yönetici listesinde `musteri` yetkili, `firma` ünvandır; saha listesinde
         `musteri` doğrudan ünvandır (firma alanı yok). Firma yoksa müşteri ünvan olur. */
      unvan: firma || musteri,
      /* Saha listesi (Faz 12) yetkiliyi ayrı alanda taşır; yönetici listesinde
         `musteri` yetkilidir. Açık alan varsa o kazanır. */
      yetkili: metin(k.yetkili) || ((firma && musteri !== firma) ? musteri : ''),
      telefon: metin(k.telefon),
      il: ilkDolu(k.il, k.sehir),
      vergiNo: ilkDolu(k.vergiNo, k.tcKimlik),
      plasiyerId: ilkPozitif(k.plasiyerId),
      plasiyerAd: metin(k.plasiyerAd),
      bayiOrani: ilkPozitif(k.bayiIskontoOrani, k.iskonto, k.iskontoOrani, ucret.bayiOran),
      bayiTutar: ilkPozitif(k.bayiIskontoTutar, ucret.bayi),
      odemeOrani: ilkPozitif(k.odemeIskontoOrani, k.odemeIskonto, ucret.odemeOran),
      odemeTutar: ilkPozitif(k.odemeIskontoTutar, ucret.odeme),
      listeVerilen: 0,
      araVerilen: ilkPozitif(k.araToplam),
      netVerilen: ilkPozitif(k.tutar, k.net, k.genelToplam),
      odeme: odemeEtiketi(ilkDolu(k.odeme, k.odemeTipiEtiket, k.odemeTipi)),
      not: ilkDolu(k.notlar, k.not, k.siparisNotu, k.vadeNotu),
      kalemler: k.kalemler
    };
  }

  /* ------------------------------------------------------------------ *
   *  NORMALLEŞTİRME
   * ------------------------------------------------------------------ */

  /**
   * Üç kaynaktan tek fiş nesnesi.
   *
   * @param {object} kaynak  (a) yönetici normal · (b) saha normal · (c) ham sunucu yükü
   * @param {object} baglam  { firmaAdi, logo, plasiyerAd, plasiyerId }
   *                         (`kagit` / `paraBirimi` çizim seçeneğidir → html/whatsappMetni)
   * @returns {object} { numara, tarih, tarihYazi, durumEtiketi, firma, plasiyer,
   *                     musteri, kalemler, cesit, toplamAdet, toplamKoli, araToplam,
   *                     bayiIskontoOrani, bayiIskontoTutar, odemeIskontoOrani,
   *                     odemeIskontoTutar, net, odeme, not }
   */
  function normalle(kaynak, baglam) {
    var k = (kaynak && 'object' === typeof kaynak) ? kaynak : {};
    var b = (baglam && 'object' === typeof baglam) ? baglam : {};
    var o = hamMi(k) ? hamOku(k) : normalOku(k);

    var kalemler = [];
    var toplamAdet = 0;
    var toplamKoli = 0;
    var araKalem = 0;
    var listeKalem = 0;

    (Array.isArray(o.kalemler) ? o.kalemler : []).forEach(function (h) {
      var n = kalemNormalle(h);

      kalemler.push(n.kalem);
      toplamAdet += n.kalem.adet;
      toplamKoli += n.kalem.koli;
      araKalem += n.kalem.tutar;
      listeKalem += n.liste;
    });

    araKalem = kurus(araKalem);
    listeKalem = kurus(listeKalem);

    /*
     * ARA TOPLAM = iskontosuz tutar. Kalem tutarı varsa kalemlerden; satır
     * fiyatları iskontolu geldiyse (web siparişi: liste > tutar) liste tutarı
     * esas alınır ve fark bayi iskontosu olur. Kalem tutarı yoksa sunucunun
     * verdiği ara toplam.
     */
    var araToplam = araKalem > 0
      ? Math.max(araKalem, listeKalem, kurus(o.listeVerilen))
      : kurus(ilkPozitif(o.listeVerilen, o.araVerilen));
    var satirIskonto = araKalem > 0 ? kurus(araToplam - araKalem) : 0;

    /* BAYİ İSKONTOSU: verilen tutar (ücret satırı) + satır farkı; ikisi de yoksa orandan.
       Oran bilinmiyorsa tutardan geri okunur (yalnızca gösterim, tek ondalık). */
    var bayiOrani = yuzde(o.bayiOrani);
    var bayiTutar = kurus(sayi(o.bayiTutar) + satirIskonto) || kurus(araToplam * bayiOrani / 100);

    if (!bayiOrani && bayiTutar > 0 && araToplam > 0) bayiOrani = Math.round(bayiTutar / araToplam * 1000) / 10;

    var bayiSonrasi = kurus(araToplam - bayiTutar);

    /* ÖDEME İSKONTOSU bayi SONRASI tutara uygulanır — bileşik; sunucuyla aynı sıra. */
    var odemeOrani = yuzde(o.odemeOrani);
    var odemeTutar = kurus(o.odemeTutar) || kurus(bayiSonrasi * odemeOrani / 100);

    if (!odemeOrani && odemeTutar > 0 && bayiSonrasi > 0) odemeOrani = Math.round(odemeTutar / bayiSonrasi * 1000) / 10;

    /* NET: sunucu verdiyse sunucununki — panelin hesabı gösterim, sunucununki gerçek. */
    var net = o.netVerilen > 0 ? kurus(o.netVerilen) : kurus(bayiSonrasi - odemeTutar);

    if (net < 0) net = 0;

    /* Plasiyer: siparişin damgası önce; bağlamdaki ad yalnızca aynı kişiyse
       (ya da sipariş kimlik taşımıyorsa) kullanılır — 7 numaralı plasiyerin
       siparişine 3 numaranın adını yazmak yanlış künye olurdu. */
    var siparisPid = ilkPozitif(o.plasiyerId);
    var baglamPid = ilkPozitif(b.plasiyerId);
    var plasiyerAd = o.plasiyerAd || ((!siparisPid || siparisPid === baglamPid) ? metin(b.plasiyerAd) : '');

    var tarih = tarihCoz(o.tarih);
    var logo = metin(b.logo);

    return {
      numara: o.numara,
      tarih: tarih.iso,
      tarihYazi: tarih.yazi,
      durumEtiketi: o.durumEtiketi,
      firma: { ad: metin(b.firmaAdi), logo: LOGO_SEMASI.test(logo) ? logo : '' },
      plasiyer: { id: siparisPid || baglamPid, ad: plasiyerAd },
      musteri: { unvan: o.unvan, yetkili: o.yetkili, telefon: o.telefon, il: o.il, vergiNo: o.vergiNo },
      kalemler: kalemler,
      cesit: kalemler.length,
      toplamAdet: kurus(toplamAdet),
      toplamKoli: kurus(toplamKoli),
      araToplam: araToplam,
      bayiIskontoOrani: bayiOrani,
      bayiIskontoTutar: bayiTutar,
      odemeIskontoOrani: odemeOrani,
      odemeIskontoTutar: odemeTutar,
      net: net,
      odeme: o.odeme,
      not: o.not
    };
  }

  /** Elde fiş mi, kaynak mı? Kaynaksa normalleştirir — html/whatsapp ikisini de kabul eder. */
  function fisEmin(x) {
    if (x && 'object' === typeof x && x.musteri && 'object' === typeof x.musteri &&
        Array.isArray(x.kalemler) && 'number' === typeof x.net) {
      return x;
    }

    return normalle(x, {});
  }

  /* ------------------------------------------------------------------ *
   *  HTML — A4 ve 80 mm termal
   * ------------------------------------------------------------------ */

  function stil(termal) {
    var ortak = [
      '* { box-sizing: border-box; }',
      'html, body { margin:0; padding:0; }',
      'h3 { margin:0 0 2mm; font-size:9.5px; font-weight:800; letter-spacing:.8px; text-transform:uppercase; color:#64748b; }',
      'table { width:100%; border-collapse:collapse; }',
      'th, td { vertical-align:top; }',
      /* Rakam sütunları eş genişlikli rakamla dizilir: virgüller alt alta gelir. */
      '.sayi { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }',
      'dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:1mm 3mm; }',
      'dt { color:#64748b; white-space:nowrap; }',
      'dd { margin:0; font-weight:600; overflow-wrap:anywhere; }',
      '.kalemler th { text-align:left; font-size:9.5px; letter-spacing:.5px; color:#64748b; border-bottom:1.5px solid #0f172a; padding:2mm 1.5mm; }',
      '.kalemler th.sayi { text-align:right; }',
      '.kalemler td { padding:1.8mm 1.5mm; border-bottom:1px solid #e2e8f0; }',
      '.s-ad { overflow-wrap:anywhere; }',
      '.s-sku { color:#64748b; white-space:nowrap; }',
      '.toplamlar td { padding:1.2mm 1.5mm; }',
      '.toplamlar .etiket { text-align:right; color:#475569; }',
      '.toplamlar .indirim .deger { color:#b91c1c; }',
      '.toplamlar .net td { font-weight:900; border-top:2px solid #0f172a; padding-top:2.5mm; }',
      '.not { border:1px dashed #94a3b8; border-radius:2mm; padding:3mm; white-space:pre-wrap; overflow-wrap:anywhere; }',
      '.alt { border-top:1px solid #cbd5e1; padding-top:2mm; font-size:9px; color:#64748b; text-align:center; }',
      '.logo { display:block; object-fit:contain; }',
      '.bos { text-align:center; color:#94a3b8; padding:6mm 0; }'
    ];

    var a4 = [
      '@page { size: A4; margin: 12mm; }',
      'body { font-family:"Segoe UI", Arial, sans-serif; font-size:11px; color:#0f172a; background:#e8eaee; }',
      '.sayfa { width:210mm; min-height:297mm; margin:16px auto; padding:12mm; background:#fff; box-shadow:0 10px 40px rgba(0,0,0,.28); }',
      '.ust { display:flex; justify-content:space-between; align-items:flex-start; gap:10mm; border-bottom:2px solid #0f172a; padding-bottom:4mm; margin-bottom:5mm; }',
      '.marka { display:flex; align-items:center; gap:4mm; min-width:0; }',
      '.logo { max-height:18mm; max-width:60mm; }',
      '.firma { font-size:16px; font-weight:800; overflow-wrap:anywhere; }',
      '.baslik { text-align:right; white-space:nowrap; }',
      '.fis-turu { font-size:18px; font-weight:900; letter-spacing:1.5px; }',
      '.no { font-size:14px; font-weight:800; }',
      '.tarih, .durum { color:#475569; }',
      '.kunye { display:grid; grid-template-columns:1fr 1fr; gap:4mm; margin-bottom:5mm; }',
      '.kutu { border:1px solid #cbd5e1; border-radius:2mm; padding:3mm; }',
      '.toplamlar { margin:4mm 0 0 auto; width:auto; min-width:85mm; }',
      '.toplamlar .net td { font-size:14px; }',
      '.not { margin-top:5mm; }',
      '.alt { margin-top:8mm; }'
    ];

    var termalStil = [
      '@page { size: 80mm auto; margin: 3mm; }',
      'body { font-family:"Segoe UI", Arial, sans-serif; font-size:11px; color:#000; background:#fff; }',
      '.sayfa { width:74mm; margin:0 auto; padding:2mm 0; }',
      '.ust { text-align:center; border-bottom:1px dashed #000; padding-bottom:2mm; margin-bottom:2mm; }',
      '.logo { max-width:60mm; max-height:14mm; margin:0 auto 1mm; }',
      '.firma { font-size:14px; font-weight:800; overflow-wrap:anywhere; }',
      '.fis-turu { font-size:14px; font-weight:900; letter-spacing:1.5px; margin-top:1mm; }',
      '.no { font-size:13px; font-weight:800; }',
      '.kunye { display:block; margin-bottom:2mm; }',
      '.kutu { border:0; border-bottom:1px dashed #94a3b8; padding:1.5mm 0; }',
      'dl { gap:.5mm 2mm; }',
      '.kalemler th { font-size:9px; padding:1mm .5mm; }',
      '.kalemler td { padding:1mm .5mm; font-size:10.5px; }',
      '.s-sku { font-size:9px; }',
      /* Termal kâğıtta rakamlar eş genişlikli ve bir tık büyük: 80 mm'de kolon
         hizası ancak böyle okunur; oransal yazıda virgüller kayar. */
      '.sayi { font-family:"Courier New", Consolas, monospace; font-size:12px; }',
      '.toplamlar { width:100%; margin-top:2mm; border-top:1px dashed #000; }',
      '.toplamlar .net td { font-size:14px; }',
      '.not { margin-top:2mm; }',
      '.alt { margin-top:4mm; }'
    ];

    /* Fişte etkileşimli öğe yoktur; yazdırmada yalnızca ekran süsü (gölge, gri zemin)
       kalkar ve satır/kutular sayfa sınırında bölünmez. */
    var yazdir = [
      '@media print {',
      '  body { background:#fff; }',
      '  .sayfa { width:auto; min-height:0; margin:0; padding:0; box-shadow:none; }',
      '  thead { display:table-header-group; }',
      '  tr, .kutu, .toplamlar, .not { page-break-inside:avoid; }',
      '}'
    ];

    return ortak.concat(termal ? termalStil : a4, yazdir).join('\n');
  }

  /**
   * Tam HTML belgesi (satır içi <style>, harici kaynak yok).
   *
   * @param {object} fis      normalle() çıktısı (kaynak nesne de kabul edilir)
   * @param {object} secenek  { kagit: 'a4'|'termal', paraBirimi: 'TL' }
   */
  function html(fis, secenek) {
    fis = fisEmin(fis);

    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var termal = 'termal' === metin(s.kagit).toLowerCase();
    var birim = s.paraBirimi === undefined ? PARA_BIRIMI : s.paraBirimi;
    var firma = fis.firma || {};
    var m = fis.musteri || {};
    var p = fis.plasiyer || {};
    var kalemler = Array.isArray(fis.kalemler) ? fis.kalemler : [];
    var logo = metin(firma.logo);

    function para(n) {
      return paraYaz(n, birim);
    }

    /* Boş alan satır olarak basılmaz: müşteri fişinde "Telefon: —" gürültüdür. */
    function kunyeSatiri(dt, dd) {
      return dd ? '<dt>' + dt + '</dt><dd>' + kacis(dd) + '</dd>' : '';
    }

    var bayiKutusu = '<div class="kutu"><h3>Bayi</h3><dl>' +
      '<dt>Ünvan</dt><dd>' + kacis(m.unvan || '—') + '</dd>' +
      kunyeSatiri('Yetkili', m.yetkili) +
      kunyeSatiri('Telefon', m.telefon) +
      kunyeSatiri('İl', m.il) +
      kunyeSatiri('Vergi No', m.vergiNo) +
      '</dl></div>';

    var ozet = sayi(fis.cesit) + ' çeşit · ' + sayiYaz(fis.toplamAdet) + ' adet' +
      (fis.toplamKoli > 0 ? ' · ' + sayiYaz(fis.toplamKoli) + ' koli' : '');

    var siparisKutusu = '<div class="kutu"><h3>Sipariş</h3><dl>' +
      kunyeSatiri('Plasiyer', p.ad) +
      kunyeSatiri('Ödeme', fis.odeme) +
      '<dt>Kalem</dt><dd>' + kacis(ozet) + '</dd>' +
      '</dl></div>';

    var satirlar = kalemler.length
      ? kalemler.map(function (k) {
          return '<tr>' +
            '<td class="s-ad">' + kacis(k.ad || '—') + '</td>' +
            '<td class="s-sku">' + kacis(k.sku || '—') + '</td>' +
            '<td class="s-adet sayi">' + kacis(koliAdetYazi(k)) + '</td>' +
            '<td class="s-birim sayi">' + kacis(para(k.birim)) + '</td>' +
            '<td class="s-tutar sayi">' + kacis(para(k.tutar)) + '</td>' +
            '</tr>';
        }).join('')
      : '<tr><td class="bos" colspan="5">Kalem yok</td></tr>';

    function toplamSatiri(etiket, deger, sinif) {
      return '<tr' + (sinif ? ' class="' + sinif + '"' : '') + '>' +
        '<td class="etiket">' + etiket + '</td>' +
        '<td class="deger sayi">' + deger + '</td>' +
        '</tr>';
    }

    /* İskonto satırı yalnızca varsa basılır: sıfırlık bir "−0,00" satırı
       müşteriye "iskonto alamadın" demektir ve yanlış anlaşılır. */
    var toplamlar = toplamSatiri('Ara toplam', kacis(para(fis.araToplam))) +
      (fis.bayiIskontoTutar > 0.005 || fis.bayiIskontoOrani > 0
        ? toplamSatiri('Bayi iskontosu (' + kacis(oranYazi(fis.bayiIskontoOrani)) + ')',
                       '&minus;' + kacis(para(fis.bayiIskontoTutar)), 'indirim')
        : '') +
      (fis.odemeIskontoTutar > 0.005 || fis.odemeIskontoOrani > 0
        ? toplamSatiri('Ödeme iskontosu (' + kacis(oranYazi(fis.odemeIskontoOrani)) + ')',
                       '&minus;' + kacis(para(fis.odemeIskontoTutar)), 'indirim')
        : '') +
      toplamSatiri('NET ÖDENECEK', kacis(para(fis.net)), 'net');

    return '<!DOCTYPE html>\n' +
      '<html lang="tr"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Sipariş Fişi #' + kacis(fis.numara) + '</title>' +
      '<style>\n' + stil(termal) + '\n</style></head>' +
      '<body class="' + (termal ? 'termal' : 'a4') + '"><div class="sayfa">' +
      '<header class="ust">' +
        '<div class="marka">' +
          (LOGO_SEMASI.test(logo) ? '<img class="logo" src="' + kacis(logo) + '" alt="">' : '') +
          (firma.ad ? '<div class="firma">' + kacis(firma.ad) + '</div>' : '') +
        '</div>' +
        '<div class="baslik">' +
          '<div class="fis-turu">SİPARİŞ FİŞİ</div>' +
          '<div class="no">#' + kacis(fis.numara || '—') + '</div>' +
          (fis.tarihYazi ? '<div class="tarih">' + kacis(fis.tarihYazi) + '</div>' : '') +
          (fis.durumEtiketi ? '<div class="durum">' + kacis(fis.durumEtiketi) + '</div>' : '') +
        '</div>' +
      '</header>' +
      '<section class="kunye">' + bayiKutusu + siparisKutusu + '</section>' +
      '<table class="kalemler"><thead><tr>' +
        '<th>Ürün</th><th>SKU</th><th class="sayi">Koli × Adet</th><th class="sayi">Birim</th><th class="sayi">Tutar</th>' +
      '</tr></thead><tbody>' + satirlar + '</tbody></table>' +
      '<table class="toplamlar"><tbody>' + toplamlar + '</tbody></table>' +
      (fis.not ? '<section class="not"><h3>Sipariş Notu</h3>' + kacis(fis.not) + '</section>' : '') +
      '<footer class="alt">' + kacis(ALT_YAZI) + '</footer>' +
      '</div></body></html>';
  }

  /* ------------------------------------------------------------------ *
   *  WHATSAPP
   * ------------------------------------------------------------------ */

  /**
   * WhatsApp biçimli düz metin: *kalın* başlıklar, _italik_ plasiyer satırı.
   *
   * Kalem 20 ile, metin 1800 karakterle sınırlıdır. Sınır aşılırsa ÖNCE kalem
   * düşürülür (özet zaten "… ve N kalem daha" der), SONRA not kırpılır;
   * başlık ve toplamlar hiçbir koşulda düşmez — müşteri ne ödeyeceğini her
   * durumda görmeli.
   */
  function whatsappMetni(fis, secenek) {
    fis = fisEmin(fis);

    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var birim = s.paraBirimi === undefined ? PARA_BIRIMI : s.paraBirimi;
    var firma = fis.firma || {};
    var m = fis.musteri || {};
    var p = fis.plasiyer || {};
    var kalemler = Array.isArray(fis.kalemler) ? fis.kalemler : [];

    function para(n) {
      return paraYaz(n, birim);
    }

    var bas = ['*SİPARİŞ FİŞİ #' + tekSatir(fis.numara || '—') + '*'];

    if (firma.ad) bas.push('*Firma:* ' + tekSatir(firma.ad));

    bas.push('*Bayi:* ' + tekSatir(m.unvan || '—') + (m.yetkili ? ' (' + tekSatir(m.yetkili) + ')' : ''));

    if (fis.tarihYazi) bas.push('*Tarih:* ' + fis.tarihYazi);
    if (fis.durumEtiketi) bas.push('*Durum:* ' + tekSatir(fis.durumEtiketi));
    if (fis.odeme) bas.push('*Ödeme:* ' + tekSatir(fis.odeme));

    var son = ['*Ara toplam:* ' + para(fis.araToplam)];

    if (fis.bayiIskontoTutar > 0.005 || fis.bayiIskontoOrani > 0) {
      son.push('*Bayi iskontosu (' + oranYazi(fis.bayiIskontoOrani) + '):* −' + para(fis.bayiIskontoTutar));
    }

    if (fis.odemeIskontoTutar > 0.005 || fis.odemeIskontoOrani > 0) {
      son.push('*Ödeme iskontosu (' + oranYazi(fis.odemeIskontoOrani) + '):* −' + para(fis.odemeIskontoTutar));
    }

    son.push('*NET ÖDENECEK: ' + para(fis.net) + '*');

    if (p.ad) son.push('_Plasiyer: ' + tekSatir(p.ad) + '_');

    var satirlar = kalemler.map(function (k) {
      return '• ' + tekSatir(k.ad || '—') + ' — ' + koliAdetYazi(k) + ' adet — ' + para(k.tutar);
    });

    var not = metin(fis.not);

    function kur(n, notMetni) {
      var orta = satirlar.slice(0, n);

      if (satirlar.length > n) orta.push('… ve ' + (satirlar.length - n) + ' kalem daha');

      var parcalar = bas.concat(['']);

      if (orta.length) parcalar = parcalar.concat(orta, ['']);

      parcalar = parcalar.concat(son);

      if (notMetni) parcalar.push('*Not:* ' + notMetni);

      return parcalar.join('\n');
    }

    var n = Math.min(WA_EN_COK_KALEM, satirlar.length);
    var sonuc = kur(n, not);

    while (sonuc.length > WA_EN_COK_KARAKTER && n > 0) {
      n--;
      sonuc = kur(n, not);
    }

    if (sonuc.length > WA_EN_COK_KARAKTER && not) {
      var fazla = sonuc.length - WA_EN_COK_KARAKTER + 1;

      not = fazla >= not.length ? '' : not.slice(0, not.length - fazla) + '…';
      sonuc = kur(n, not);
    }

    /* Son çare (aşırı uzun ünvan/ad): sert kes. Buraya düşmek istisnadır. */
    if (sonuc.length > WA_EN_COK_KARAKTER) sonuc = sonuc.slice(0, WA_EN_COK_KARAKTER - 1) + '…';

    return sonuc;
  }

  /**
   * wa.me telefonu: "0532 415 22 78" → "905324152278". 10 hane → 90 öneki;
   * "00" uluslararası öneki atılır; 11-15 hane dışında ''. Sabit numara
   * YOKTUR. renderer.js → waTelefon (Faz 11) ile aynı kural; ikisi aynı kalmalı.
   */
  function waTelefon(ham) {
    var r = String(ham === null || ham === undefined ? '' : ham).replace(/[^0-9]/g, '');

    if (0 === r.indexOf('00')) r = r.slice(2);
    if (11 === r.length && '0' === r.charAt(0)) r = r.slice(1);
    if (10 === r.length) r = '90' + r;

    return (r.length >= 11 && r.length <= 15) ? r : '';
  }

  /** wa.me adresi; müşteri telefonu yoksa ''. */
  function waAdresi(fis, secenek) {
    fis = fisEmin(fis);

    var tel = waTelefon(fis.musteri && fis.musteri.telefon);

    if (!tel) return '';

    return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(whatsappMetni(fis, secenek));
  }

  /* ------------------------------------------------------------------ *
   *  DIŞA VERME — çift modlu
   * ------------------------------------------------------------------ */

  var SiparisFisi = {
    normalle: normalle,
    html: html,
    whatsappMetni: whatsappMetni,
    waTelefon: waTelefon,
    waAdresi: waAdresi,
    paraYaz: paraYaz,
    kacis: kacis,
    /* sabitler */
    PARA_BIRIMI: PARA_BIRIMI,
    WA_EN_COK_KALEM: WA_EN_COK_KALEM,
    WA_EN_COK_KARAKTER: WA_EN_COK_KARAKTER,
    ALT_YAZI: ALT_YAZI
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = SiparisFisi;
  if (typeof window !== 'undefined') window.SiparisFisi = SiparisFisi;
})();
