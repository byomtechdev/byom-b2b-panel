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
 *  KDV — BELGEDE DÖKÜLÜR, BURADA HESAPLANMAZ:
 *      Fiyatlar KDV DAHİL girilir (sistemin sözleşmesi); WooCommerce vergi
 *      motoruna dokunulmaz. Oran ürün başına `_byom_kdv_rate`, yoksa mağaza
 *      varsayılanı — PANEL KENDİ ORAN LİSTESİNİ TUTMAZ. Satır KDV'si sunucudan
 *      `vat_rate` / `vat_amount` olarak gelir ve OLDUĞU GİBİ basılır; alan hiç
 *      yoksa (eski eklenti) yalnızca o zaman orandan türetilir.
 *      "KDV istemiyorum" siparişinde sunucu satırları netleştirir
 *      (`_b2b_vat_excluded`, `_b2b_vat_removed`); fiş bunu AÇIKÇA yazar ve
 *      NET'ten KDV'yi İKİNCİ KEZ DÜŞMEZ.
 *
 *  GÜVENLİK: her kullanıcı metni HTML'e `kacis` ile girer; logo yalnızca
 *  data:image/ ya da http(s)/file şemasıyla basılır (javascript: giremez).
 *  html() çıktısında etkileşimli öğe, betik, harici CSS/JS ya da CDN YOKTUR.
 *
 *  FAZ 14 (2026-09-19) — İKİ FİŞİN ORTAK PARÇALARI BURADA:
 *    · A4 sütunları SABİT (8): Ürün Adı · Kod / Barkod · Koli / Adet · Birim
 *      Fiyat · İskontolu Birim Fiyat · KDV Oranı · KDV Tutarı · Satır Tutarı.
 *      Bilinmeyen değer "—" olur, sütun kaybolmaz. Kalem `listeBirim` taşır.
 *    · ozetBlogu(): ALTI SABİT SATIR (Liste Fiyatı Ara Toplamı · Bayi İskonto
 *      Tutarı · İskontolu Ara Toplam · <Yöntem> Sipariş İskontosu · KDV ·
 *      NET ÖDENECEK TUTAR). Depo fişi (renderer.js → depoFisiHtml) de bu
 *      çiziciyi kullanır — iki fiş aynı sözcük ve sırayla kapanır.
 *    · sayfalaraBol(): sayfa ÖLÇÜSÜ sabit, sayfa SAYISI değişken; özet bloğu
 *      bölünmez, yer yoksa tek başına son sayfaya geçer.
 *    · aracCubugu() + pencere(): Yazdır · PDF · WhatsApp'tan Gönder · Kapat
 *      araç çubuğu ve gömülü IPC betiği (yalnızca fiş penceresinde). html()
 *      saf kalır; testin "DOM/ağ/require yok" sözü motorun kendisi içindir.
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
  function kalemNormalle(k, kdvHaric) {
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

    /*
     * BİRİM LİSTE FİYATI (Faz 14) — "Birim Fiyat" sütunu ve liste toplamı.
     *
     * Kaynak sırası: panelin `listeBirim`i · sunucunun `list_unit_price`ı ·
     * satır toplamı metasından bölme · yoksa iskontolu birim (iskonto yok).
     * Liste toplamı BİRİM × GÜNCEL ADET ile kurulur, satır metası
     * (`list_subtotal`) ile DEĞİL: revizyonda meta ölçeklenmemişse düşen
     * adet fişte bayi iskontosu gibi görünürdü — depo fişinin
     * `kalemFiyatKunyesi` ile aynı koruma; iki fiş aynı sayıyı basmalı.
     */
    var listeBirim = ilkPozitif(k.listeBirim, k.list_unit_price);

    if (!listeBirim && liste > 0 && adet > 0) listeBirim = kurus(liste / adet);
    if (listeBirim > 0 && adet > 0) liste = kurus(listeBirim * adet);
    if (!listeBirim || listeBirim < birim) listeBirim = birim;

    /*
     * SATIR KDV KÜNYESİ — SUNUCUDAN GELİR, BURADA YENİDEN HESAPLANMAZ.
     * `prepare_order` ve `kalem_dokumu` satır başına `vat_rate` + `vat_amount`
     * üretiyor (satır metası → ürün oranı; WooCommerce vergi satırı varsa O
     * kazanıyor). Aynı hesabı panelde tekrarlamak aynı kuralın ikinci kopyası
     * olurdu — panel KENDİ oran listesini tutmaz, sunucudan geleni basar.
     */
    var kdvOrani = yuzde(ilkPozitif(k.kdvOrani, k.vat_rate, k.kdv_orani));
    var kdvTutar = kurus(ilkPozitif(k.kdvTutar, k.vat_amount, k.kdv_tutari));

    /*
     * TEK YEDEK — alan HİÇ gelmediyse (eski eklenti / ince yük) orandan türetilir.
     * Fiyatlar KDV DAHİL girilir (sistemin sözleşmesi), yani KDV tutarın
     * İÇİNDEDİR: tutar × o / (100 + o). Sipariş "KDV hariç" kipine çevrildiyse
     * satır tutarı zaten nettir ve KDV üstüne eklenir: tutar × o / 100.
     * Sunucu tutarı gönderdiği anda bu dal hiç çalışmaz.
     */
    if (!kdvTutar && kdvOrani > 0 && tutar > 0) {
      kdvTutar = kdvHaric ? kurus(tutar * kdvOrani / 100) : kurus(tutar * kdvOrani / (100 + kdvOrani));
    }

    /* Liste tutarı satır tutarından küçük olamaz; küçük/yoksa iskonto yok sayılır. */
    if (liste < tutar) liste = tutar;

    return {
      kalem: {
        ad: ilkDolu(k.ad, k.name),
        sku: sku,
        adet: adet,
        koli: koli,
        koliIci: koliIci,
        listeBirim: kurus(listeBirim),
        birim: kurus(birim),
        tutar: kurus(tutar),
        kdvOrani: kdvOrani,
        kdvTutar: kdvTutar
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
   *  KDV ÖZETİ — SUNUCUNUN SATIRLARINDAN, YENİDEN HESAPLAMADAN
   * ------------------------------------------------------------------ */

  /**
   * Fişin KDV künyesi: toplam, tek oran (varsa) ve "karışık oran" bayrağı.
   *
   * Toplam için SUNUCUNUN kök alanı (`vat_total` → `kdvToplam`) önce gelir;
   * yoksa satırların kendi tutarları toplanır. İki yol da sunucu verisidir —
   * panel oran × tutar çarpmaz (§0 madde 1: formül burada yeniden yazılmaz).
   *
   * Sepette birden çok KDV oranı olabilir (%1 gıda + %20 hırdavat). Tek bir
   * oran yazmak müşteriye yanlış bilgi olurdu; o hâlde etiket "karışık oran"
   * der ve tutar yine doğru kalır.
   */
  function kdvOzeti(fis) {
    var kalemler = Array.isArray(fis && fis.kalemler) ? fis.kalemler : [];
    var oranlar = [];
    var kalemToplam = 0;

    kalemler.forEach(function (k) {
      if (!k || 'object' !== typeof k) return;

      kalemToplam = kurus(kalemToplam + sayi(k.kdvTutar));

      var o = sayi(k.kdvOrani);

      if ((o > 0 || sayi(k.kdvTutar) > 0) && -1 === oranlar.indexOf(o)) oranlar.push(o);
    });

    var kokToplam = kurus(sayi(fis && fis.kdvToplam));
    var toplam = kokToplam > 0 ? kokToplam : kalemToplam;
    var istenmedi = !!(fis && fis.kdvIstenmedi);

    return {
      /* KDV hiç bilinmiyorsa fişte KDV sütunu/satırı BASILMAZ — boş bir
         "%0 · 0,00" sütunu belgeyi kalabalıklaştırır ve yanlış okunur. */
      dolu: !!(toplam > 0.005 || oranlar.length || istenmedi),
      toplam: toplam,
      oran: 1 === oranlar.length ? oranlar[0] : 0,
      karisik: oranlar.length > 1
    };
  }

  function kdvEtiketi(oz) {
    if (oz.karisik) return 'KDV (karışık oran)';
    if (oz.oran > 0) return 'KDV (' + oranYazi(oz.oran) + ')';

    return 'KDV';
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
    var u = { bayi: 0, bayiOran: 0, odeme: 0, odemeOran: 0, odemeAd: '' };

    liste.forEach(function (f) {
      if (!f || 'object' !== typeof f) return;

      var hamAd = tekSatir(f.name || f.ad);
      var ad = hamAd.toLowerCase();
      var tutar = Math.abs(sayi(f.total !== undefined ? f.total : f.tutar));
      var es = /%\s*(\d+(?:[.,]\d+)?)/.exec(ad);
      var oran = es ? sayi(es[1].replace(',', '.')) : 0;

      if (!tutar) return;

      if (/[öo]deme/.test(ad)) {
        u.odeme = kurus(u.odeme + tutar);
        if (oran) u.odemeOran = oran;

        /* "Ödeme Yöntemi İskontosu — Nakit (%5)" → yöntem adı satırdan okunur;
           ödeme başlığı gelmeyen yükte özet satırı yine "Nakit Sipariş
           İskontosu" der. */
        var yontem = /[—–-]\s*([^()]+?)\s*(?:\(|$)/.exec(hamAd);

        if (yontem && metin(yontem[1])) u.odemeAd = metin(yontem[1]);
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
      /*
       * KDV KÜNYESİ (sunucu sözleşmesi). "KDV'siz sipariş"in sunucu temsili:
       * `_b2b_vat_excluded = 'yes'` + `_b2b_vat_removed` (B2B_Order_Revision::
       * apply_vat_mode). `vat_total` satır KDV'lerinin toplamıdır; WooCommerce
       * vergi motoru açıksa gerçek vergi zaten o toplamın içindedir.
       */
      kdvIstenmedi: !!(true === k.vat_excluded || 'yes' === k.vat_excluded || k.kdvIstenmedi || 'yes' === meta._b2b_vat_excluded),
      kdvDusulen: ilkPozitif(k.vat_removed, k.kdvDusulen, meta._b2b_vat_removed),
      kdvToplam: ilkPozitif(k.vat_total, k.kdvToplam, k.total_tax),
      odeme: odemeEtiketi(ilkDolu(k.payment_method_title, k.payment_title, meta._b2b_odeme_tipi, k.payment_type_label, k.payment_method, ucret.odemeAd)),
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
      /* Panelin normalizasyonları aynı künyeyi Türkçe adlarla taşır
         (plasiyer-siparislerim.js → normalle); İngilizce adlar da kabul edilir
         ki iki okuyucu ASLA ayrışmasın. */
      kdvIstenmedi: !!(k.kdvIstenmedi || true === k.vat_excluded || 'yes' === k.vat_excluded),
      kdvDusulen: ilkPozitif(k.kdvDusulen, k.vat_removed),
      kdvToplam: ilkPozitif(k.kdvToplam, k.vat_total, k.toplamKdv),
      odeme: odemeEtiketi(ilkDolu(k.odeme, k.odemeTipiEtiket, k.odemeTipi, ucret.odemeAd)),
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
   *                     odemeIskontoTutar, kdvToplam, kdvIstenmedi, kdvDusulen,
   *                     net, odeme, not }
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
    var kdvKalem = 0;

    /* KDV hariç kipinde satır tutarı ZATEN nettir; kalem çözücüsü yedek
       türetmeyi buna göre yapmalı (içinden ayrıştır ≠ üstüne ekle). */
    var kdvIstenmedi = !!o.kdvIstenmedi;

    (Array.isArray(o.kalemler) ? o.kalemler : []).forEach(function (h) {
      var n = kalemNormalle(h, kdvIstenmedi);

      kalemler.push(n.kalem);
      toplamAdet += n.kalem.adet;
      toplamKoli += n.kalem.koli;
      araKalem += n.kalem.tutar;
      listeKalem += n.liste;
      kdvKalem += n.kalem.kdvTutar;
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

    /*
     * KDV TOPLAMI — sunucunun kök alanı önce, yoksa satırların toplamı.
     * NET'ten İKİNCİ KEZ DÜŞÜLMEZ: fiyatlar KDV dahil girilir, "KDV istemiyorum"
     * seçildiğinde satır tutarları sunucuda ZATEN netleştirilmiştir. Burada
     * tekrar çıkarmak müşteriye iki kez indirim yazmak olurdu.
     */
    var kdvToplam = kurus(o.kdvToplam) || kurus(kdvKalem);

    /* "Düşülen KDV" yalnızca KDV hariç siparişte anlamlıdır. Sunucu damgası
       (`_b2b_vat_removed`) yoksa satır KDV'lerinin toplamı aynı tutardır —
       ikisi de sunucu verisi, panel yeni bir sayı uydurmaz. */
    var kdvDusulen = kdvIstenmedi ? (kurus(o.kdvDusulen) || kdvToplam) : 0;

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
      kdvToplam: kdvToplam,
      kdvIstenmedi: kdvIstenmedi,
      kdvDusulen: kdvDusulen,
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
   *  ÖZET BLOĞU — ALTI SABİT SATIR, İKİ FİŞ, TEK ÇİZİCİ (Faz 14)
   * ------------------------------------------------------------------ */

  /**
   * Sabit satır etiketleri. Depo fişi (renderer.js → depoFisiHtml) ve sipariş
   * fişi AYNI çiziciyi çağırır; sözcükler burada tek yerde durur. Ürün
   * sahibinin isteği: iskonto olmasa da satırlar hep basılır, değeri "—" olur.
   */
  var OZET_ETIKET = {
    liste: 'Liste Fiyatı Ara Toplamı',
    bayi: 'Bayi İskonto Tutarı',
    ara: 'İskontolu Ara Toplam',
    odeme: 'Sipariş İskontosu',
    odemeYok: 'Ödeme Yöntemi Sipariş İskontosu',
    kdv: 'KDV',
    net: 'NET ÖDENECEK TUTAR'
  };

  /** Olmayan değerin işareti — boş hücre "unutulmuş" okunur, tire "yok" der. */
  var YOK = '—';

  /**
   * Sayfalama kapasiteleri (satır). Sayfa ölçüsü SABİTTİR: kalem sayısı
   * artınca punto/satır küçülmez, sayfa sayısı artar. Kapasiteler bilerek
   * temkinli: iki satıra sarmış ürün adları ve iskonto notu için pay bırakır.
   *   ilk   : birinci sayfa (tam başlık + künye alır)
   *   devam : devam sayfaları (kompakt başlık)
   *   ozet  : özet bloğu + notlar + alt yazı için son sayfada gereken satır payı
   */
  var SAYFA_KAPASITESI = { ilk: 20, devam: 26, ozet: 9 };

  /**
   * Kalemleri sabit kapasiteli sayfalara böler (saf fonksiyon).
   *
   * Son sayfada özet için yer kalmadıysa özet TEK BAŞINA yeni sayfaya geçer;
   * bloğun yarısı bir sayfada, toplamı ötekinde kalırsa fiş okunamaz olur.
   *
   * @param {number} n   Kalem sayısı.
   * @param {object} kap { ilk, devam, ozet } — verilmeyen alan varsayılandan.
   * @returns {{ sayfalar: Array<{bas:number, son:number, kapasite:number}>, ozetAyri: boolean, toplam: number }}
   */
  function sayfalaraBol(n, kap) {
    n = Math.max(0, Math.floor(sayi(n)));

    var k = (kap && 'object' === typeof kap) ? kap : {};
    var ilk = Math.max(1, Math.floor(sayi(k.ilk)) || SAYFA_KAPASITESI.ilk);
    var devam = Math.max(1, Math.floor(sayi(k.devam)) || SAYFA_KAPASITESI.devam);
    var ozet = Math.max(0, Math.floor(sayi(k.ozet)) || SAYFA_KAPASITESI.ozet);

    var sayfalar = [];
    var i = 0;

    do {
      var kapasite = sayfalar.length ? devam : ilk;
      var son = Math.min(n, i + kapasite);

      sayfalar.push({ bas: i, son: son, kapasite: kapasite });
      i = son;
    } while (i < n);

    var sonSayfa = sayfalar[sayfalar.length - 1];
    var ozetAyri = (sonSayfa.kapasite - (sonSayfa.son - sonSayfa.bas)) < ozet;

    return { sayfalar: sayfalar, ozetAyri: ozetAyri, toplam: sayfalar.length + (ozetAyri ? 1 : 0) };
  }

  /**
   * Normalleştirilmiş fişten özet nesnesi (ozetBlogu girdisi).
   *
   * Liste = fişin ara toplamı (iskontosuz), iskontolu ara = liste − bayi,
   * net = sunucunun tutarı. KDV "üstüne" bayrağı: net ≈ (ara − ödeme) + KDV
   * ise WooCommerce vergi motoru KDV'yi toplama EKLEMİŞTİR; aksi hâlde KDV
   * fiyatların içindedir. İkisi ayrı sorudur ("ne ödeyeceğim" / "içinde ne
   * kadar vergi var") ve fiş ikisini de açıkça yazar.
   */
  function fisOzeti(fis) {
    fis = fisEmin(fis);

    var oz = kdvOzeti(fis);
    var liste = kurus(fis.araToplam);
    var bayi = kurus(fis.bayiIskontoTutar);
    var ara = kurus(liste - bayi);
    var odeme = kurus(fis.odemeIskontoTutar);
    var net = kurus(fis.net);
    var beklenen = kurus(ara - odeme);
    var ustune = !fis.kdvIstenmedi && oz.toplam > 0.005 &&
      Math.abs(net - (beklenen + oz.toplam)) < 0.05 && Math.abs(net - beklenen) > 0.05;

    return {
      liste: liste,
      bayiOrani: yuzde(fis.bayiIskontoOrani),
      bayiTutar: bayi,
      iskontoluAra: ara,
      odemeAdi: metin(fis.odeme),
      odemeOrani: yuzde(fis.odemeIskontoOrani),
      odemeTutar: odeme,
      kdv: {
        tutar: oz.toplam,
        oran: oz.oran,
        karisik: oz.karisik,
        istenmedi: !!fis.kdvIstenmedi,
        dusulen: kurus(fis.kdvDusulen) || (fis.kdvIstenmedi ? oz.toplam : 0),
        bilinmiyor: !oz.dolu,
        ustune: ustune
      },
      ekSatirlar: [],
      net: net
    };
  }

  /**
   * ALTI SABİT SATIR: Liste Fiyatı Ara Toplamı · Bayi İskonto Tutarı ·
   * İskontolu Ara Toplam · <Yöntem> Sipariş İskontosu · KDV · NET ÖDENECEK.
   *
   * Satırlar her fişte VARDIR; olmayan değer "—" ile basılır. Ek satırlar
   * (kargo, kupon, kapanmayan artık) yalnızca sıfır değilse KDV'den önce
   * araya girer — kapanmayan bir çıkarma listesi basmak fişi yalancı yapar.
   *
   * @param {object} o        fisOzeti() çıktısı ya da aynı biçimde elle kurulmuş nesne.
   * @param {object} secenek  { paraBirimi }
   * @returns {string} <table class="toplamlar">…</table>
   */
  function ozetBlogu(o, secenek) {
    o = (o && 'object' === typeof o) ? o : {};

    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var birim = s.paraBirimi === undefined ? PARA_BIRIMI : s.paraBirimi;
    var kdv = (o.kdv && 'object' === typeof o.kdv) ? o.kdv : {};

    function para(n) {
      return paraYaz(n, birim);
    }

    function satir(sinif, etiket, deger) {
      return '<tr class="' + sinif + '"><td class="etiket">' + etiket + '</td>' +
        '<td class="deger sayi">' + deger + '</td></tr>';
    }

    var bayiVar = sayi(o.bayiTutar) > 0.005;
    var odemeVar = sayi(o.odemeTutar) > 0.005;
    var odemeAd = tekSatir(o.odemeAdi);
    var odemeEtiket = odemeAd ? (odemeAd + ' ' + OZET_ETIKET.odeme) : OZET_ETIKET.odemeYok;

    if (sayi(o.odemeOrani) > 0) odemeEtiket += ' (' + oranYazi(o.odemeOrani) + ')';

    var govde = satir('liste', kacis(OZET_ETIKET.liste), kacis(para(o.liste)));

    govde += satir(bayiVar ? 'indirim bayi' : 'bayi bos',
      kacis(OZET_ETIKET.bayi + (sayi(o.bayiOrani) > 0 ? ' (' + oranYazi(o.bayiOrani) + ')' : '')),
      bayiVar ? '&minus;' + kacis(para(o.bayiTutar)) : YOK);

    govde += satir('ara', kacis(OZET_ETIKET.ara), kacis(para(o.iskontoluAra)));

    govde += satir(odemeVar ? 'indirim odeme' : 'odeme bos', kacis(odemeEtiket),
      odemeVar ? '&minus;' + kacis(para(o.odemeTutar)) : YOK);

    (Array.isArray(o.ekSatirlar) ? o.ekSatirlar : []).forEach(function (e) {
      if (!e || 'object' !== typeof e || Math.abs(sayi(e.tutar)) < 0.005) return;

      govde += satir('ek' + (e.sinif ? ' ' + String(e.sinif) : ''), kacis(e.etiket),
        (sayi(e.tutar) < 0 ? '&minus;' : '') + kacis(para(Math.abs(sayi(e.tutar)))));
    });

    if (kdv.istenmedi) {
      govde += satir('kdv-yok', kacis(OZET_ETIKET.kdv), 'UYGULANMADI');
    } else if (kdv.bilinmiyor || !(sayi(kdv.tutar) > 0.005 || sayi(kdv.oran) > 0)) {
      govde += satir('kdv bos', kacis(OZET_ETIKET.kdv), YOK);
    } else {
      govde += satir('kdv', kacis(kdvEtiketi({ karisik: !!kdv.karisik, oran: sayi(kdv.oran) })),
        (kdv.ustune ? '+' : '') + kacis(para(kdv.tutar)) +
        ' <span class="ince">' + (kdv.ustune ? 'toplama eklenir' : 'fiyatlara dâhil') + '</span>');
    }

    govde += satir('net', kacis(OZET_ETIKET.net), kacis(para(o.net)));

    return '<table class="toplamlar"><tbody>' + govde + '</tbody></table>';
  }

  /* ------------------------------------------------------------------ *
   *  HTML — A4 (sayfalı) ve 80 mm termal
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
      /* Ürün adı en çok İKİ satır: satır yüksekliği sınırlı kalsın ki sayfa
         kapasitesi (sayfalaraBol) kâğıtta da tutsun. */
      '.s-ad { overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }',
      '.s-sku { color:#64748b; white-space:nowrap; }',
      '.s-liste { color:#475569; }',
      '.toplamlar td { padding:1.2mm 1.5mm; }',
      '.toplamlar .etiket { text-align:right; color:#475569; }',
      '.toplamlar .indirim .deger { color:#b91c1c; }',
      '.toplamlar .bos .deger { color:#94a3b8; }',
      '.toplamlar .ara td { font-weight:700; border-top:1px solid #cbd5e1; }',
      '.toplamlar .kdv .etiket, .toplamlar .kdv .deger { font-weight:700; }',
      '.toplamlar .ince { font-weight:500; color:#64748b; font-size:.9em; }',
      '.toplamlar .kdv-yok .deger { color:#b45309; font-weight:800; }',
      /* KDV'siz sipariş uyarısı: müşteri fişe bakınca "neden KDV yok?" sorusunu
         sormadan cevabını görmeli. Bu yüzden toplam bloğunun altında, çerçeveli. */
      '.kdv-notu { margin-top:3mm; border:1.5px solid #b45309; border-radius:2mm; padding:2.5mm 3mm; color:#7c2d12; background:#fffbeb; font-weight:600; }',
      /* Termal kip: KDV kalemin ALTINDA ikinci satırdır; üstteki satırın alt
         çizgisi kaldırılır ki kalem tek blok gibi okunsun. */
      '.kalemler tr.s-kdvli td { border-bottom:0; }',
      '.s-kdv-bilgi { padding-top:0 !important; color:#475569; }',
      '.toplamlar .net td { font-weight:900; border-top:2px solid #0f172a; padding-top:2.5mm; }',
      '.not { border:1px dashed #94a3b8; border-radius:2mm; padding:3mm; white-space:pre-wrap; overflow-wrap:anywhere; }',
      '.alt { border-top:1px solid #cbd5e1; padding-top:2mm; font-size:9px; color:#64748b; text-align:center; }',
      '.logo { display:block; object-fit:contain; }',
      '.bos-kalem { text-align:center; color:#94a3b8; padding:6mm 0; }'
    ];

    var a4 = [
      '@page { size: A4; margin: 12mm; }',
      'body { font-family:"Segoe UI", Arial, sans-serif; font-size:11px; color:#0f172a; background:#e8eaee; }',
      /*
       * SAYFA ÖLÇÜSÜ SABİT: 297 mm − 2 × 12 mm kenar = 273 mm içerik. Ekranda
       * ve kâğıtta aynı yükseklik; taşan içerik GİZLENİR (sayfalaraBol zaten
       * taşırmaz, bu son emniyettir). Kalem sayısı artınca punto küçülmez,
       * sayfa sayısı artar.
       */
      '.sayfa { position:relative; width:210mm; height:297mm; margin:16px auto; padding:12mm; background:#fff; box-shadow:0 10px 40px rgba(0,0,0,.28); overflow:hidden; }',
      '.sayfa-no { position:absolute; right:12mm; bottom:5mm; font-size:9px; color:#94a3b8; }',
      '.ust { display:flex; justify-content:space-between; align-items:flex-start; gap:10mm; border-bottom:2px solid #0f172a; padding-bottom:4mm; margin-bottom:5mm; }',
      '.ust.devam { padding-bottom:2mm; margin-bottom:3mm; border-bottom-width:1px; }',
      '.ust.devam .fis-turu { font-size:13px; }',
      '.ust.devam .firma { font-size:12px; }',
      '.marka { display:flex; align-items:center; gap:4mm; min-width:0; }',
      '.logo { max-height:18mm; max-width:60mm; }',
      '.firma { font-size:16px; font-weight:800; overflow-wrap:anywhere; }',
      '.baslik { text-align:right; white-space:nowrap; }',
      '.fis-turu { font-size:18px; font-weight:900; letter-spacing:1.5px; }',
      '.no { font-size:14px; font-weight:800; }',
      '.tarih, .durum { color:#475569; }',
      '.kunye { display:grid; grid-template-columns:1fr 1fr; gap:4mm; margin-bottom:5mm; }',
      '.kutu { border:1px solid #cbd5e1; border-radius:2mm; padding:3mm; }',
      '.kalemler { table-layout:fixed; }',
      '.kalemler .s-sku { width:24mm; }',
      '.kalemler .s-adet { width:24mm; }',
      '.kalemler .s-liste, .kalemler .s-birim, .kalemler .s-kdvtutar { width:19mm; }',
      '.kalemler .s-kdv { width:14mm; }',
      '.kalemler .s-tutar { width:22mm; }',
      '.toplamlar { margin:4mm 0 0 auto; width:auto; min-width:95mm; }',
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
       kalkar. A4'te her .sayfa bir kâğıt sayfasıdır: sabit 273 mm ve zorunlu
       sayfa sonu — tarayıcının kendi bölmesine bırakılmaz. */
    var yazdir = [
      '@media print {',
      '  body { background:#fff; }',
      '  .sayfa { width:auto; margin:0; padding:0; box-shadow:none; }',
      '  body.a4 .sayfa { height:273mm; page-break-after:always; break-after:page; }',
      '  body.a4 .sayfa:last-child { page-break-after:auto; break-after:auto; }',
      '  body.termal .sayfa { height:auto; }',
      '  thead { display:table-header-group; }',
      '  tr, .kutu, .toplamlar, .not, .kdv-notu { page-break-inside:avoid; }',
      '}'
    ];

    return ortak.concat(termal ? termalStil : a4, yazdir).join('\n');
  }

  /**
   * A4 sütun başlıkları — ürün sahibinin sırası, SABİT (KDV künyesi olmasa da
   * sütun durur, değeri "—"): Ürün Adı · Kod / Barkod · Koli / Adet · Birim
   * Fiyat · İskontolu Birim Fiyat · KDV Oranı · KDV Tutarı · Satır Tutarı.
   */
  var A4_BASLIK = '<tr><th>Ürün Adı</th><th>Kod / Barkod</th><th class="sayi">Koli / Adet</th>' +
    '<th class="sayi">Birim Fiyat</th><th class="sayi">İskontolu Birim Fiyat</th>' +
    '<th class="sayi">KDV Oranı</th><th class="sayi">KDV Tutarı</th><th class="sayi">Satır Tutarı</th></tr>';

  var A4_SUTUN = 8;

  /**
   * Tam belge. Üçüncü parametre (araç çubuğu) yalnızca pencere() tarafından
   * verilir; html() SAF kalır — etkileşimli öğe, betik ve harici kaynak yok.
   */
  function belgeKur(fis, secenek, arac) {
    fis = fisEmin(fis);

    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var termal = 'termal' === metin(s.kagit).toLowerCase();
    var birim = s.paraBirimi === undefined ? PARA_BIRIMI : s.paraBirimi;
    var firma = fis.firma || {};
    var m = fis.musteri || {};
    var p = fis.plasiyer || {};
    var kalemler = Array.isArray(fis.kalemler) ? fis.kalemler : [];
    var logo = metin(firma.logo);
    var logoVar = LOGO_SEMASI.test(logo);
    var oz = kdvOzeti(fis);

    function para(n) {
      return paraYaz(n, birim);
    }

    /* Boş alan satır olarak basılmaz: müşteri fişinde "Telefon: —" gürültüdür. */
    function kunyeSatiri(dt, dd) {
      return dd ? '<dt>' + dt + '</dt><dd>' + kacis(dd) + '</dd>' : '';
    }

    /* Oranı da tutarı da bilinmeyen kalem "%0" yazmaz: %0 KDV gerçek bir
       orandır (bazı gıda/kitap), "bilmiyorum" ile karıştırılamaz. */
    function kdvliMi(k) {
      return k.kdvOrani > 0 || k.kdvTutar > 0;
    }

    /* --- Başlıklar --- */
    var markaHtml = '<div class="marka">' +
      (logoVar ? '<img class="logo" src="' + kacis(logo) + '" alt="">' : '') +
      (firma.ad ? '<div class="firma">' + kacis(firma.ad) + '</div>' : '') +
      '</div>';

    var tamBaslik = '<header class="ust">' + markaHtml +
      '<div class="baslik">' +
        '<div class="fis-turu">SİPARİŞ FİŞİ</div>' +
        '<div class="no">#' + kacis(fis.numara || YOK) + '</div>' +
        (fis.tarihYazi ? '<div class="tarih">' + kacis(fis.tarihYazi) + '</div>' : '') +
        (fis.durumEtiketi ? '<div class="durum">' + kacis(fis.durumEtiketi) + '</div>' : '') +
      '</div></header>';

    function devamBasligi(no, toplam) {
      return '<header class="ust devam">' + markaHtml +
        '<div class="baslik"><div class="fis-turu">SİPARİŞ FİŞİ</div>' +
        '<div class="no">#' + kacis(fis.numara || YOK) + ' · sayfa ' + no + '/' + toplam + ' · devam</div></div></header>';
    }

    var bayiKutusu = '<div class="kutu"><h3>Bayi</h3><dl>' +
      '<dt>Ünvan</dt><dd>' + kacis(m.unvan || YOK) + '</dd>' +
      kunyeSatiri('Yetkili', m.yetkili) +
      kunyeSatiri('Telefon', m.telefon) +
      kunyeSatiri('İl', m.il) +
      kunyeSatiri('Vergi No', m.vergiNo) +
      '</dl></div>';

    var ozetMetni = sayi(fis.cesit) + ' çeşit · ' + sayiYaz(fis.toplamAdet) + ' adet' +
      (fis.toplamKoli > 0 ? ' · ' + sayiYaz(fis.toplamKoli) + ' koli' : '');

    var siparisKutusu = '<div class="kutu"><h3>Sipariş</h3><dl>' +
      kunyeSatiri('Plasiyer', p.ad) +
      kunyeSatiri('Ödeme', fis.odeme) +
      '<dt>Kalem</dt><dd>' + kacis(ozetMetni) + '</dd>' +
      '</dl></div>';

    var kunye = '<section class="kunye">' + bayiKutusu + siparisKutusu + '</section>';

    /* --- Kalem satırları --- */
    function a4Satir(k) {
      var iskontolu = k.listeBirim > k.birim + 0.004;

      return '<tr>' +
        '<td class="s-ad">' + kacis(k.ad || YOK) + '</td>' +
        '<td class="s-sku">' + kacis(k.sku || YOK) + '</td>' +
        '<td class="s-adet sayi">' + kacis(koliAdetYazi(k)) + '</td>' +
        '<td class="s-liste sayi">' + kacis(para(k.listeBirim)) + '</td>' +
        '<td class="s-birim sayi">' + (iskontolu ? kacis(para(k.birim)) : YOK) + '</td>' +
        '<td class="s-kdv sayi">' + kacis(kdvliMi(k) ? oranYazi(k.kdvOrani) : YOK) + '</td>' +
        '<td class="s-kdvtutar sayi">' + kacis(kdvliMi(k) ? para(k.kdvTutar) : YOK) + '</td>' +
        '<td class="s-tutar sayi">' + kacis(para(k.tutar)) + '</td>' +
        '</tr>';
    }

    /*
     * 80 mm TERMALDE kâğıt tek sütundur: sekiz sütun ürün adını üç harfe
     * düşürür. Aynı bilgi kalemin ALTINDA ikinci satır olur ("KDV %20 ·
     * 34,20 TL"). İki ayrı çizici yazmak yerine iki bayrak — düzen değişir,
     * veri ve kaynak değişmez.
     */
    var termalSutun = 5;

    function termalSatir(k) {
      var altVar = oz.dolu && kdvliMi(k);

      var satir = '<tr' + (altVar ? ' class="s-kdvli"' : '') + '>' +
        '<td class="s-ad">' + kacis(k.ad || YOK) + '</td>' +
        '<td class="s-sku">' + kacis(k.sku || YOK) + '</td>' +
        '<td class="s-adet sayi">' + kacis(koliAdetYazi(k)) + '</td>' +
        '<td class="s-birim sayi">' + kacis(para(k.birim)) + '</td>' +
        '<td class="s-tutar sayi">' + kacis(para(k.tutar)) + '</td>' +
        '</tr>';

      if (altVar) {
        satir += '<tr class="s-kdv-satir"><td class="s-kdv-bilgi" colspan="' + termalSutun + '">' +
          kacis('KDV ' + oranYazi(k.kdvOrani) + ' · ' + para(k.kdvTutar)) + '</td></tr>';
      }

      return satir;
    }

    function tablo(bas, son) {
      var dilim = kalemler.slice(bas, son);
      var govde = dilim.length
        ? dilim.map(termal ? termalSatir : a4Satir).join('')
        : '<tr><td class="bos-kalem" colspan="' + (termal ? termalSutun : A4_SUTUN) + '">Kalem yok</td></tr>';

      var baslik = termal
        ? '<tr><th>Ürün</th><th>Kod / Barkod</th><th class="sayi">Koli × Adet</th><th class="sayi">Birim</th><th class="sayi">Tutar</th></tr>'
        : A4_BASLIK;

      return '<table class="kalemler"><thead>' + baslik + '</thead><tbody>' + govde + '</tbody></table>';
    }

    /* --- Özet, KDV notu, sipariş notu, alt yazı --- */
    var ozet = fisOzeti(fis);
    var kdvDusulen = ozet.kdv.dusulen;

    var kdvNotu = fis.kdvIstenmedi
      ? '<section class="kdv-notu">Bu siparişte KDV uygulanmamıştır' +
        (kdvDusulen > 0.005 ? ' (düşülen KDV: ' + kacis(para(kdvDusulen)) + ')' : '') +
        '. Tutarlar, ürünlerin tekil KDV oranları düşüldükten sonraki değerlerdir.</section>'
      : '';

    var kapanis = ozetBlogu(ozet, { paraBirimi: birim }) + kdvNotu +
      (fis.not ? '<section class="not"><h3>Sipariş Notu</h3>' + kacis(fis.not) + '</section>' : '') +
      '<footer class="alt">' + kacis(ALT_YAZI) + '</footer>';

    /* --- Sayfalar --- */
    var sayfalar;

    if (termal) {
      sayfalar = '<div class="sayfa">' + tamBaslik + kunye + tablo(0, kalemler.length) + kapanis + '</div>';
    } else {
      var bolum = sayfalaraBol(kalemler.length, s.kapasite);
      var toplam = bolum.toplam;

      sayfalar = bolum.sayfalar.map(function (sf, i) {
        var no = i + 1;
        var sonSayfa = (i === bolum.sayfalar.length - 1) && !bolum.ozetAyri;

        return '<div class="sayfa' + (i ? ' devam' : '') + '" data-sayfa="' + no + '">' +
          (i ? devamBasligi(no, toplam) : tamBaslik + kunye) +
          tablo(sf.bas, sf.son) +
          (sonSayfa ? kapanis : '') +
          '<div class="sayfa-no">Sayfa ' + no + ' / ' + toplam + '</div>' +
          '</div>';
      }).join('');

      if (bolum.ozetAyri) {
        sayfalar += '<div class="sayfa devam ozet-sayfasi" data-sayfa="' + toplam + '">' +
          devamBasligi(toplam, toplam) + kapanis +
          '<div class="sayfa-no">Sayfa ' + toplam + ' / ' + toplam + '</div></div>';
      }
    }

    var a = (arac && 'object' === typeof arac) ? arac : { stil: '', govde: '', betik: '' };

    return '<!DOCTYPE html>\n' +
      '<html lang="tr"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Sipariş Fişi #' + kacis(fis.numara) + '</title>' +
      '<style>\n' + stil(termal) + (a.stil ? '\n' + a.stil : '') + '\n</style></head>' +
      '<body class="' + (termal ? 'termal' : 'a4') + '">' + a.govde + sayfalar + a.betik + '</body></html>';
  }

  /**
   * Tam HTML belgesi (satır içi <style>, harici kaynak yok, etkileşim yok).
   *
   * @param {object} fis      normalle() çıktısı (kaynak nesne de kabul edilir)
   * @param {object} secenek  { kagit: 'a4'|'termal', paraBirimi: 'TL', kapasite }
   */
  function html(fis, secenek) {
    return belgeKur(fis, secenek, null);
  }

  /* ------------------------------------------------------------------ *
   *  ARAÇ ÇUBUĞU + PENCERE — Yazdır · PDF · WhatsApp · Kapat (Faz 14)
   * ------------------------------------------------------------------ */

  /**
   * Fiş penceresinin araç çubuğu (kâğıda YANSIMAZ). Depo fişi de aynı
   * çubuğu basar — iki pencere aynı dört düğmeyle konuşur.
   *
   * WhatsApp düğmesi `fis:whatsapp` IPC'sini çağırır: ana süreç fişin
   * görselini panoya kopyalar ve müşterinin numarasıyla wa.me sohbetini
   * açar. Telefon yoksa düğme devre dışıdır ve sebebini söyler.
   *
   * @param {object} secenek { baslik, dosyaAdi, whatsapp: { tel, metin } }
   * @returns {{ stil: string, govde: string, betik: string }}
   */
  function aracCubugu(secenek) {
    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var wa = (s.whatsapp && 'object' === typeof s.whatsapp) ? s.whatsapp : {};
    var tel = waTelefon(wa.tel);

    var stilSatirlari = [
      '.arac { position:sticky; top:0; z-index:10; display:flex; gap:10px; align-items:center; padding:8px 12px; background:#0f172a; box-shadow:0 1px 2px rgba(0,0,0,.25); font-family:"Segoe UI", Arial, sans-serif; }',
      '.arac .baslik { color:#cbd5e1; font-size:12.5px; font-weight:600; margin-right:auto; white-space:normal; text-align:left; }',
      '.arac button { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; padding:8px 14px; border:0; border-radius:6px; color:#fff; cursor:pointer; transition:filter .15s, transform .1s; }',
      '.arac button:hover { filter:brightness(1.12); }',
      '.arac button:active { transform:scale(.96); }',
      '.arac button[disabled] { opacity:.45; cursor:not-allowed; filter:none; transform:none; }',
      '.b-yazdir { background:#2563eb; }',
      '.b-pdf { background:#334155; }',
      '.b-wa { background:#16a34a; }',
      '.b-kapat { background:#334155; }',
      '.fis-toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); max-width:640px; padding:10px 16px; border-radius:8px; background:#0f172a; color:#fff; font:600 13px "Segoe UI", Arial, sans-serif; box-shadow:0 8px 24px rgba(0,0,0,.35); z-index:20; }',
      '.fis-toast.ok { background:#166534; }',
      '.fis-toast.hata { background:#991b1b; }',
      '@media print { .yazdirma-yok { display:none !important; } }'
    ];

    var govde = '<div class="arac yazdirma-yok">' +
      '<div class="baslik">' + kacis(s.baslik || '') + '</div>' +
      '<button class="b-yazdir" id="btnYazdir" type="button">🖨️ YAZDIR</button>' +
      '<button class="b-pdf" id="btnPdf" type="button">📄 PDF OLARAK KAYDET</button>' +
      '<button class="b-wa" id="btnWa" type="button"' +
        (tel ? '' : ' disabled title="Müşterinin kayıtlı telefon numarası yok"') +
        '>📲 WHATSAPP\'TAN GÖNDER</button>' +
      '<button class="b-kapat" id="btnKapat" type="button">✕ KAPAT</button>' +
      '</div>' +
      '<div id="fisToast" class="fis-toast yazdirma-yok" hidden></div>';

    /* JSON içindeki "<" kaçışlanır: gömülü betikte "</script" dizisi belgeyi
       erken kapatırdı (ürün adları serbest metindir). */
    var veri = JSON.stringify({
      dosyaAdi: metin(s.dosyaAdi) || 'Fis',
      baslik: metin(s.baslik),
      tel: tel,
      metin: metin(wa.metin)
    }).replace(/</g, '\\u003c');

    var betik = '<script>(function () {' +
      'var ipc = require("electron").ipcRenderer;' +
      'var V = ' + veri + ';' +
      'function el(id) { return document.getElementById(id); }' +
      'var zaman = 0;' +
      'function toast(m, tur) { var t = el("fisToast"); if (!t) return; t.textContent = m; t.className = "fis-toast yazdirma-yok " + (tur || ""); t.hidden = false; clearTimeout(zaman); zaman = setTimeout(function () { t.hidden = true; }, 7000); }' +
      'el("btnYazdir").addEventListener("click", function () { ipc.invoke("fis:yazdir"); });' +
      'el("btnPdf").addEventListener("click", function () {' +
        'ipc.invoke("fis:pdf", { dosyaAdi: V.dosyaAdi, baslik: V.baslik }).then(function (c) {' +
          'if (c && c.ok) toast("PDF kaydedildi: " + (c.yol || ""), "ok");' +
          'else if (c && !c.iptal) toast((c && c.hata) || "PDF oluşturulamadı.", "hata");' +
        '});' +
      '});' +
      'var wa = el("btnWa");' +
      'if (wa && !wa.disabled) wa.addEventListener("click", function () {' +
        'wa.disabled = true; toast("Fiş görseli hazırlanıyor…");' +
        'ipc.invoke("fis:whatsapp", { tel: V.tel, metin: V.metin, dosyaAdi: V.dosyaAdi }).then(function (c) {' +
          'wa.disabled = false;' +
          'if (c && c.ok) toast(c.mesaj || "Fiş görseli panoya kopyalandı. Açılan WhatsApp sohbetinde Ctrl+V ile yapıştırıp gönderin.", "ok");' +
          'else toast((c && c.hata) || "WhatsApp açılamadı.", "hata");' +
        '});' +
      '});' +
      'el("btnKapat").addEventListener("click", function () { ipc.invoke("fis:kapat"); });' +
      'document.addEventListener("keydown", function (o) {' +
        'if (o.key === "Escape") ipc.invoke("fis:kapat");' +
        'if ((o.ctrlKey || o.metaKey) && o.key.toLowerCase() === "p") { o.preventDefault(); ipc.invoke("fis:yazdir"); }' +
      '});' +
      '})();<\/script>';

    return { stil: stilSatirlari.join('\n'), govde: govde, betik: betik, tel: tel };
  }

  /**
   * Araç çubuklu fiş penceresi (fis:onizleme'ye giden belge).
   * html() saf kalır; etkileşim yalnızca burada eklenir.
   */
  function pencere(fis, secenek) {
    fis = fisEmin(fis);

    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var arac = aracCubugu({
      baslik: 'Sipariş Fişi #' + (fis.numara || YOK) + ' · ' + sayi(fis.cesit) + ' kalem' +
        (metin(fis.musteri && fis.musteri.unvan) ? ' · ' + metin(fis.musteri.unvan) : ''),
      dosyaAdi: 'Siparis-Fisi-' + String(fis.numara || 'fis').replace(/[^0-9A-Za-z_-]+/g, '_'),
      whatsapp: { tel: fis.musteri && fis.musteri.telefon, metin: whatsappMetni(fis, s) }
    });

    return belgeKur(fis, s, arac);
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

    /*
     * Toplam satırları fişteki ALTI SATIRLA aynı sözcükleri kullanır (iki
     * kanal ayrışamaz). Farkı: WhatsApp 1800 karakterle sınırlı; iskonto
     * yoksa "—" satırı basılmaz, yalnızca dolu satırlar gider.
     */
    var oz0 = fisOzeti(fis);
    var son = ['*' + OZET_ETIKET.liste + ':* ' + para(oz0.liste)];
    var iskontoVar = false;

    if (oz0.bayiTutar > 0.005 || oz0.bayiOrani > 0) {
      iskontoVar = true;
      son.push('*' + OZET_ETIKET.bayi + ' (' + oranYazi(oz0.bayiOrani) + '):* −' + para(oz0.bayiTutar));
    }

    if (oz0.odemeTutar > 0.005 || oz0.odemeOrani > 0) {
      if (iskontoVar) son.push('*' + OZET_ETIKET.ara + ':* ' + para(oz0.iskontoluAra));

      iskontoVar = true;
      son.push('*' + (oz0.odemeAdi ? oz0.odemeAdi + ' ' + OZET_ETIKET.odeme : OZET_ETIKET.odemeYok) +
        ' (' + oranYazi(oz0.odemeOrani) + '):* −' + para(oz0.odemeTutar));
    }

    /*
     * KDV TEK SATIR. WhatsApp 1800 karakterle sınırlı; kalem başına KDV yazmak
     * bütçeyi yer ve sınıra dayanınca ilk düşen şey KALEM olur. Müşterinin
     * mesajdan öğrenmesi gereken tek şey "ne kadar KDV var / var mı".
     */
    var waOz = kdvOzeti(fis);

    if (fis.kdvIstenmedi) {
      var waDusulen = kurus(fis.kdvDusulen) || waOz.toplam;

      son.push('*KDV UYGULANMADI*' + (waDusulen > 0.005 ? ' (düşülen: ' + para(waDusulen) + ')' : ''));
    } else if (waOz.toplam > 0.005) {
      son.push('*' + kdvEtiketi(waOz) + ':* ' + para(waOz.toplam));
    }

    son.push('*' + OZET_ETIKET.net + ': ' + para(fis.net) + '*');

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
    pencere: pencere,
    whatsappMetni: whatsappMetni,
    waTelefon: waTelefon,
    waAdresi: waAdresi,
    paraYaz: paraYaz,
    kacis: kacis,
    /* Faz 14 — iki fişin ortak parçaları */
    fisOzeti: fisOzeti,
    ozetBlogu: ozetBlogu,
    sayfalaraBol: sayfalaraBol,
    aracCubugu: aracCubugu,
    /* sabitler */
    PARA_BIRIMI: PARA_BIRIMI,
    WA_EN_COK_KALEM: WA_EN_COK_KALEM,
    WA_EN_COK_KARAKTER: WA_EN_COK_KARAKTER,
    ALT_YAZI: ALT_YAZI,
    OZET_ETIKET: OZET_ETIKET,
    SAYFA_KAPASITESI: SAYFA_KAPASITESI
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = SiparisFisi;
  if (typeof window !== 'undefined') window.SiparisFisi = SiparisFisi;
})();
