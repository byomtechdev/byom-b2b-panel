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
 *    · sayfalaraBol(): sayfa ÖLÇÜSÜ sabit, sayfa SAYISI değişken; sayfalar
 *      SIRAYLA dolar (ilk sayfa dolmadan ikincisi açılmaz), özet bloğu
 *      bölünmez ve son sayfada en az ÜÇ kalemle birlikte basılır (14-C).
 *    · A4 tablolar ÇİZGİLİDİR (ince satır + sütun çizgisi): rakam sütunları
 *      alt alta gelince kaymış görünmez. Özet tablosu sabit iki sütun:
 *      etiket solda, tutar sağda, çerçeveli (14-C).
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

  /* ------------------------------------------------------------------ *
   *  AKILLI AD KISALTMA (Faz 16-C)
   *  -------------------------------------------------------------------
   *  Saha: "Uzun ürün isimleri yüzünden 10 kalemlik sipariş 2 sayfaya
   *  taşıyor; tabloyu genişlettiğimizde isimler alt alta 2-3 satır kaplıyor."
   *
   *  A4'te ad sütununa 210 − 24 (kenar) − 121 (sabit sayı sütunları) = 65 mm,
   *  hücre dolgusu düşünce ≈62 mm kalır; 10.5px Segoe UI'da ≈44 karakter.
   *  Ad TAM yazıldığı için 3 satıra sarıyor ve 14-B sayfalayıcısı satır
   *  yüksekliğini ÖLÇTÜĞÜ için sayfa kapasitesi üçe bölünüyordu.
   *
   *  SÖZLEŞME — anlamı ve ayırt ediciliği bozma:
   *   1. Sığan ad ASLA değiştirilmez.
   *   2. Rakam taşıyan sözcük (ölçü/model) ve hemen ardındaki kısa birim
   *      ASLA atılmaz — ürünü ayırt eden şey odur.
   *   3. Baştaki iki ve sondaki iki sözcük ASLA atılmaz (marka/malzeme ve
   *      bitiş niteleyicisi: "SAĞ DAMLALIK", "SDS-PLUS 800W").
   *   4. Önce bilgi taşımayan DOLGU sözcükleri düşer — onlar için "…" konmaz,
   *      çünkü kaybedilen bir bilgi yoktur.
   *   5. Sonra ORTADAN DIŞA doğru atılır ve boşluğa "…" konur: kısaltıldığı
   *      GÖRÜLÜR. Ortadan başlamak, ürün adını taşıyan sözcüğün (Türkçede
   *      çoğu zaman sona yakın) en son atılmasını sağlar.
   *   6. Son çare sözcüğü kırpmaktır (4 harf + "…"), rakamlı sözcük HARİÇ.
   *
   *  Kesin kimlik yandaki **Kod / Barkod** sütunundadır; ad insan için bir
   *  doğrulamadır. Bu yüzden kısaltmak güvenlidir, kodu kırpmak olmazdı.
   * ------------------------------------------------------------------ */

  /** A4'te ad sütununa sığan karakter sayısı. */
  var KISALT_A4 = 44;

  /**
   * 80 mm termalde kısaltma KAPALI (0).
   *
   * Kısaltma bir SAYFA TAŞMASI çözümüdür ve o sorun yalnızca A4'te vardır:
   * rulo sürekli kâğıttır, ad iki satıra sararsa kâğıt iki satır uzar ve
   * başka hiçbir şey olmaz. O dar sütunda (~20 mm) kısaltmak ise ölçüyü yok
   * etmek pahasına olurdu.
   */
  var KISALT_TERMAL = 0;

  /**
   * Bilgi taşımayan dolgu sözcükleri (Türkçe büyük harfle karşılaştırılır).
   *
   * Liste BİLİNÇLİ OLARAK KISA: "ne işe yaradığı belirsiz" sözcükleri buraya
   * eklemek, gerçekten ayırt edici bir sözcüğü sessizce atmak demektir.
   * Paketleme sözcükleri (ADET, KUTU, PAKET) burada YOKTUR — çünkü genelde
   * bir rakamın ardından gelirler ve o hâlde zaten korunurlar.
   */
  var DOLGU = [
    'ORİJİNAL', 'ORIJINAL', 'PROFESYONEL', 'KALİTELİ', 'KALITELI',
    'SÜPER', 'SUPER', 'EKSTRA', 'PREMIUM', 'PREMİUM', 'STANDART',
    'EKONOMİK', 'EKONOMIK', 'GARANTİLİ', 'GARANTILI', 'MARKA'
  ];

  /** Türkçe büyük harf (i → İ, ı → I). */
  function buyuk(s) {
    return String(s || '').replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
  }

  function rakamliMi(s) {
    return /\d/.test(String(s || ''));
  }

  /**
   * Ürün adını verilen karakter sınırına akıllıca indirir.
   *
   * @param {string} ad    Ürün adı.
   * @param {number} limit Karakter sınırı (0 / geçersiz → kısaltma yok).
   * @returns {string}
   */
  function kisaltAd(ad, limit) {
    var metin = tekSatir(ad).trim();

    limit = Number(limit) || 0;

    if (!metin || limit < 8 || metin.length <= limit) return metin;

    var sozcukler = metin.split(' ');

    /*
     * --- 1) Dolgu sözcükleri: kaybedilen bilgi yok, işaret de konmaz. ---
     *
     * UÇLAR DA SÜZÜLÜR. "ORİJİNAL BOSCH GBH 2-26 …" adında baştaki ORİJİNAL
     * korunursa marka+model ikilisi (BOSCH GBH) baş korumasının dışında kalır
     * ve MODEL AİLESİ atılır — fişin ayırt ediciliği tam da orada kırılıyordu.
     * Dolgunun yeri değil, bilgi taşımaması önemlidir.
     */
    if (sozcukler.length > 2) {
      var suzulmus = sozcukler.filter(function (s) {
        return DOLGU.indexOf(buyuk(s)) === -1;
      });

      if (suzulmus.length >= 2) sozcukler = suzulmus;
    }

    if (sozcukler.join(' ').length <= limit) return sozcukler.join(' ');

    /* --- 2) Koruma kümesi --- */
    var n = sozcukler.length;
    var korumali = {};

    [0, 1, n - 2, n - 1].forEach(function (i) {
      if (i >= 0 && i < n) korumali[i] = true;
    });

    sozcukler.forEach(function (s, i) {
      if (!rakamliMi(s)) return;

      korumali[i] = true;

      /* Ölçünün BİRİMİ de korunur: "100x60" tek başına eksiktir. */
      if (i + 1 < n && sozcukler[i + 1].length <= 4 && !rakamliMi(sozcukler[i + 1])) {
        korumali[i + 1] = true;
      }
    });

    /* --- 3) Ortadan dışa doğru at --- */
    var atilabilir = [];

    for (var i = 0; i < n; i++) {
      if (!korumali[i]) atilabilir.push(i);
    }

    /* Orta indise yakınlık sırası: ürün adını taşıyan sözcük en son atılsın. */
    var orta = (n - 1) / 2;

    atilabilir.sort(function (a, b) {
      return Math.abs(a - orta) - Math.abs(b - orta) || a - b;
    });

    var atilan = {};

    for (var k = 0; k < atilabilir.length; k++) {
      if (kur(sozcukler, atilan).length <= limit) break;

      atilan[atilabilir[k]] = true;
    }

    var sonuc = kur(sozcukler, atilan);

    if (sonuc.length <= limit) return sonuc;

    /* --- 4) Son çare: rakamsız sözcükleri kırp --- */
    var kalanlar = sozcukler.map(function (s, i) { return atilan[i] ? null : i; })
      .filter(function (i) { return null !== i; })
      .filter(function (i) { return !rakamliMi(sozcukler[i]) && sozcukler[i].length > 5; })
      .sort(function (a, b) { return sozcukler[b].length - sozcukler[a].length; });

    for (var j = 0; j < kalanlar.length; j++) {
      sozcukler[kalanlar[j]] = sozcukler[kalanlar[j]].slice(0, 4) + '…';

      if (kur(sozcukler, atilan).length <= limit) break;
    }

    sonuc = kur(sozcukler, atilan);

    /*
     * Tek sözcüklü ad: atacak ya da kısaltacak başka sözcük yok, kırpmaktan
     * başka çare kalmaz. Çok sözcüklüde DURULUR — daha fazla bozmak yerine
     * biraz taşmasına izin vermek dürüsttür.
     */
    if (sonuc.length > limit && 1 === sozcukler.length) {
      sonuc = sonuc.slice(0, Math.max(1, limit - 1)).replace(/…$/, '') + '…';
    }

    return sonuc;
  }

  /** Atılanları çıkarıp bitişik boşluklara tek "…" koyar. */
  function kur(sozcukler, atilan) {
    var parcalar = [];
    var bosluk = false;

    sozcukler.forEach(function (s, i) {
      if (atilan[i]) { bosluk = true; return; }

      if (bosluk) { parcalar.push('…'); bosluk = false; }

      parcalar.push(s);
    });

    return parcalar.join(' ');
  }

  /**
   * Bir fişin TÜM adlarını kısaltır ve AYIRT EDİCİLİĞİ korur.
   *
   * İki AYRI ürün aynı metne inerse depocu yanlış rafa gider; o yüzden
   * çakışan grubun sınırı açılır (8'er karakter) ta ki ayrışana kadar.
   * En kötü hâlde orijinal adlara dönülür — çakışmaktansa taşmak yeğdir.
   *
   * @param {string[]} adlar Ürün adları.
   * @param {number}   limit Karakter sınırı.
   * @returns {string[]}
   */
  function kisaltListe(adlar, limit) {
    var liste = Array.isArray(adlar) ? adlar : [];
    var sinir = liste.map(function () { return Number(limit) || 0; });

    function ciz() {
      return liste.map(function (a, i) { return kisaltAd(a, sinir[i]); });
    }

    var cikti = ciz();

    for (var tur = 0; tur < 12; tur++) {
      var sayac = {};

      cikti.forEach(function (c, i) {
        var anahtar = c + '\u0000' + '';

        sayac[c] = sayac[c] || [];
        sayac[c].push(i);

        return anahtar;
      });

      var cakisan = false;

      Object.keys(sayac).forEach(function (c) {
        var indisler = sayac[c];

        if (indisler.length < 2) return;

        /* AYNI ürün iki kez geçiyorsa çakışma değildir. */
        var ozgun = {};

        indisler.forEach(function (i) { ozgun[tekSatir(liste[i]).trim()] = true; });

        if (Object.keys(ozgun).length < 2) return;

        cakisan = true;

        indisler.forEach(function (i) { sinir[i] += 8; });
      });

      if (!cakisan) break;

      cikti = ciz();
    }

    return cikti;
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

  /**
   * Özet satırındaki YÖNTEM adı: "<Yöntem> Sipariş İskontosu".
   *
   * Eklenti ödeme tipini "Nakit Sipariş" / "Vadeli Sipariş" gibi tam ETİKETLE
   * verir (b2b-discount-functions.php → label); olduğu gibi eklenince satır
   * "Nakit Sipariş Sipariş İskontosu" oluyordu (ürün sahibi: "iki kez
   * sipariş yazmaya gerek yok"). Bilinen üç yöntem kısa adına iner
   * (short_label ile aynı sözcükler), tanınmayan etiketin sondaki
   * "Sipariş(i)" sözcüğü düşer. Türkçe İ/ı için toLowerCase yetmez;
   * karşılaştırma öncesi İ→i indirgenir.
   */
  function odemeKisaAd(x) {
    var m = tekSatir(odemeEtiketi(x));
    var k = m.replace(/İ/g, 'i').toLowerCase();

    if (!m) return '';
    if (/nak[iı]t|havale|eft/.test(k)) return 'Nakit';
    if (/vade/.test(k)) return 'Vade';
    if (/kred[iı]|kart/.test(k)) return 'Kredi Kartı';

    return m.replace(/\s*sipari[şs]i?\s*$/i, '').trim() || m;
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
   * İSKONTO REVİZESİ künyesini iki sayıya indirger (Faz 15).
   *
   * Sunucu `revision.discount_revision` altında `{ ilk, eski, yeni, zaman,
   * kullanıcı }` verir; panel normalizasyonları `iskontoRevize` adıyla taşır.
   * Fişin ihtiyacı yalnızca İLK ve YENİ orandır.
   *
   * ASLA null DÖNMEZ. Fiş nesnesinin değişmez sözü: hiçbir alan `null` /
   * `undefined` / `NaN` olamaz, olmayan değer `0` ya da `''` olur
   * (siparis-fisi.test.js → "asla NaN / undefined"). Bu yüzden künye yokken
   * de `{ ilk: 0, yeni: 0 }` döner ve dipnot kendiliğinden susar.
   *
   * @param {object} k Ham sunucu yükü ya da panel normalizasyonu.
   * @returns {{ilk:number,yeni:number}}
   */
  function iskontoKutugu(k) {
    var kaynak = null;

    if (k && 'object' === typeof k) {
      if (k.revision && 'object' === typeof k.revision && k.revision.discount_revision &&
          'object' === typeof k.revision.discount_revision) {
        kaynak = k.revision.discount_revision;
      } else if (k.iskontoRevize && 'object' === typeof k.iskontoRevize) {
        kaynak = k.iskontoRevize;
      }
    }

    kaynak = kaynak || {};

    return { ilk: yuzde(kaynak.ilk), yeni: yuzde(kaynak.yeni) };
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
      /*
       * İSKONTO REVİZESİ KÜNYESİ (eklenti 2.21.0) — { ilk, eski, yeni, … }.
       * Fiş yeni fiyatları ZATEN basar (satır tutarları sunucuda değişti);
       * bu künye yalnızca "neden değişti" sorusunu dipnotta cevaplar.
       * Fiş kendi başına hiçbir şey HESAPLAMAZ.
       */
      iskontoRevize: iskontoKutugu(k),
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
      /* Bkz. hamOku — iki okuyucu ASLA ayrışmamalı. */
      iskontoRevize: iskontoKutugu(k),
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
      iskontoRevize: iskontoKutugu(o),
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

  /* ------------------------------------------------------------------ *
   *  SAYFALAMA — SIRALI DOLDURMA, ÖZETE EN AZ ÜÇ KALEM EŞLİK EDER (Faz 14-C)
   *
   *  Satır yükseklikleri fiş penceresinde ÖLÇÜLÜR (ürün adı kaç satıra
   *  sardıysa o kadar yer kaplar; ad ASLA kırpılmaz), sonra bu saf fonksiyon
   *  kalemleri sayfalara böler. Kural üç maddedir:
   *    1) SAYFALAR SIRAYLA DOLDURULUR — ilk sayfa dolmadan ikincisi açılmaz.
   *       (14-B'nin "dengeli" dağıtımı 20 kalemi 10 + 10 bölüyor, ilk
   *       sayfanın yarısı bembeyaz kalıyordu: kâğıt israfı. Ürün sahibi
   *       reddetti.)
   *    2) Özet bloğu (toplamlar + dipnot + not + imza) BÖLÜNMEZ ve son
   *       sayfaya kalemlerle BİRLİKTE gider. Son sayfaya sığmıyorsa bir
   *       sayfa daha açılır ama özet TEK BAŞINA basılmaz: önceki sayfanın
   *       kuyruğundan en az `enAz` (3) kalem özete eşlik eder — dizgideki
   *       dul/yetim satır kuralı. Özet sığıyor ama son sayfada 3'ten az
   *       kalem varsa yine önceki sayfadan kalem çekilir.
   *    3) Özet tek bir kalemle bile bir sayfaya sığmıyorsa (istisna) ayrı
   *       sayfaya gider (`ozetAyri`).
   *  Hiçbir sayfa boşaltılmaz, sıra değişmez, kalem kaybolmaz.
   *
   *  Birim önemsizdir (px, mm ya da "satır"): sayı verilirse her kalem 1
   *  ağırlık sayılır (testler ve tahminler için).
   * ------------------------------------------------------------------ */

  /**
   * @param {number[]|number} agirliklar  Kalem yükseklikleri (ya da kalem sayısı).
   * @param {object} kap  { ilk, devam, ozet, enAz } — ilk sayfa ve devam sayfası
   *                      kapasitesi, özet bloğunun ağırlığı (aynı birim) ve özete
   *                      eşlik edecek en az kalem sayısı (varsayılan 3).
   * @returns {{ sayfalar: Array<{bas:number, son:number, agirlik:number}>, ozetAyri: boolean, toplam: number }}
   */
  function sayfalaraBol(agirliklar, kap) {
    var w = [];
    var i;

    if (Array.isArray(agirliklar)) {
      for (i = 0; i < agirliklar.length; i++) {
        var a = Number(agirliklar[i]);
        w.push(isFinite(a) && a > 0 ? a : 0);
      }
    } else {
      var n = Math.max(0, Math.floor(Number(agirliklar) || 0));
      for (i = 0; i < n; i++) w.push(1);
    }

    var k = (kap && 'object' === typeof kap) ? kap : {};
    var ilk = Number(k.ilk);
    var devam = Number(k.devam);
    var ozet = Number(k.ozet);
    var enAz = Number(k.enAz);

    if (!isFinite(ilk) || ilk <= 0) ilk = 20;
    if (!isFinite(devam) || devam <= 0) devam = ilk;
    if (!isFinite(ozet) || ozet < 0) ozet = 0;
    /* Varsayılan sabit burada yazılır: fonksiyon toString ile fiş penceresine
       gömülür, dış değişken orada yoktur. */
    if (!isFinite(enAz) || enAz < 1) enAz = 3;

    var adet = w.length;

    /* 1) SIRALI DOLDURMA: sayfa dolmadan yenisi açılmaz. Tek başına sayfadan
       büyük bir kalem yine bir sayfaya konur (taşma, kırpma değil). */
    var sayfalar = [];
    var bas = 0;
    var agirlik = 0;
    var kapasite = ilk;

    for (i = 0; i < adet; i++) {
      if (i > bas && agirlik + w[i] > kapasite) {
        sayfalar.push({ bas: bas, son: i, agirlik: agirlik });
        bas = i;
        agirlik = 0;
        kapasite = devam;
      }

      agirlik += w[i];
    }

    sayfalar.push({ bas: bas, son: adet, agirlik: agirlik });

    /* Kaynak sayfanın SON kalemini hedef sayfanın BAŞINA taşır (sıra korunur). */
    function kuyruktanTasi(kaynak, hedef) {
      var j = kaynak.son - 1;

      hedef.bas = j;
      hedef.agirlik += w[j];
      kaynak.son = j;
      kaynak.agirlik -= w[j];
    }

    var ozetAyri = false;
    var sonIdx = sayfalar.length - 1;
    var son = sayfalar[sonIdx];

    if (adet > 0 && son.agirlik + ozet > (0 === sonIdx ? ilk : devam)) {
      /* 2a) Özet son sayfaya sığmıyor: bir sayfa daha açılır ve son kalem
         özetle birlikte oraya iner (eşlik kuralı aşağıda tamamlar). İlk
         sayfa hiç boşaltılmaz (başlık tek başına kalmasın); boşalan devam
         sayfası düşer. Son kalem bile özetle sığmıyorsa özet ayrı sayfadır. */
      var yeni = { bas: son.son, son: son.son, agirlik: 0 };
      var taban = sonIdx > 0 ? 0 : 1;

      if (son.son - son.bas > taban && w[son.son - 1] + ozet <= devam) {
        kuyruktanTasi(son, yeni);

        if (son.son === son.bas) sayfalar.splice(sonIdx, 1);

        sayfalar.push(yeni);
      } else {
        ozetAyri = true;
      }
    }

    /* 2b) EŞLİK KURALI: son sayfada özetin yanında en az `enAz` kalem
       bulunmalı (kalem yeterse). Azsa önceki sayfanın kuyruğundan çekilir —
       önceki sayfa dolu kalır (en az bir kalem), son sayfa yetim görünmez.
       Çekilen kalem özetle birlikte sığmalıdır. */
    sonIdx = sayfalar.length - 1;
    son = sayfalar[sonIdx];

    if (!ozetAyri && sonIdx > 0) {
      var onceki = sayfalar[sonIdx - 1];
      var eslik = Math.min(enAz, adet);

      while (son.son - son.bas < eslik && onceki.son - onceki.bas > 1) {
        if (son.agirlik + w[onceki.son - 1] + ozet > devam) break;

        kuyruktanTasi(onceki, son);
      }
    }

    return { sayfalar: sayfalar, ozetAyri: ozetAyri, toplam: sayfalar.length + (ozetAyri ? 1 : 0) };
  }

  /**
   * Normalleştirilmiş fişten özet nesnesi (ozetBlogu girdisi).
   *
   * Liste = fişin ara toplamı (iskontosuz), iskontolu ara = liste − bayi,
   * net = sunucunun tutarı. KDV "üstüne" bayrağı: net ≈ (ara − ödeme) + KDV
   * ise WooCommerce vergi motoru KDV'yi toplama EKLEMİŞTİR; aksi hâlde KDV
   * fiyatların içindedir. İkisi ayrı sorudur ("ne ödeyeceğim" / "içinde ne
   * kadar vergi var") ve fiş ikisini de dipnotta açıkça yazar.
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
   * KDV satırı yalın yazılır ("KDV (%20) · 358,67 TL"); dâhil mi, eklendi mi,
   * uygulanmadı mı — açıklaması kdvDipnotu() ile toplamın ALTINDA küçük
   * puntoda durur (resmî belgede tablo içine renkli kutu girmez).
   *
   * DÜZEN (14-C, ürün sahibi: "kimisi sağdan kimisi soldan, nizami olsun"):
   * iki sabit sütun — etiket SOLA, tutar SAĞA dayalı, her hücre çerçeveli,
   * tablo sabit genişlikte ve sağa yaslı. Yuvarlama / kapanmayan fark
   * satırı BASILMAZ (ürün sahibi istemedi); kargo ve kupon gibi gerçek
   * kalemler ekSatirlar ile girer.
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
    var odemeAd = odemeKisaAd(o.odemeAdi);   // "Nakit Sipariş" → "Nakit" ("Sipariş Sipariş" tekrarı olmaz)
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
      govde += satir('kdv', kacis(kdvEtiketi({ karisik: !!kdv.karisik, oran: sayi(kdv.oran) })), kacis(para(kdv.tutar)));
    }

    govde += satir('net', kacis(OZET_ETIKET.net), kacis(para(o.net)));

    return '<table class="toplamlar"><tbody>' + govde + '</tbody></table>';
  }

  /**
   * KDV dipnotu — toplamın altında küçük puntoda, renkli kutu değil.
   * Üç hâl: uygulanmadı · toplama eklendi · fiyatlara dâhil. KDV künyesi
   * hiç yoksa dipnot yoktur (bilinmeyen şey yazılmaz).
   *
   * @param {object} kdv  fisOzeti().kdv biçimi.
   * @param {object} secenek { paraBirimi }
   * @returns {string} düz metin ('' olabilir)
   */
  function kdvDipnotu(kdv, secenek) {
    kdv = (kdv && 'object' === typeof kdv) ? kdv : {};

    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var birim = s.paraBirimi === undefined ? PARA_BIRIMI : s.paraBirimi;

    if (kdv.istenmedi) {
      var dusulen = kurus(kdv.dusulen) || kurus(kdv.tutar);

      return 'Bu siparişte KDV uygulanmamıştır' +
        (dusulen > 0.005 ? ' (düşülen KDV: ' + paraYaz(dusulen, birim) + ')' : '') +
        '. Tutarlar, ürünlerin tekil KDV oranları düşüldükten sonraki değerlerdir.';
    }

    if (kdv.bilinmiyor || !(sayi(kdv.tutar) > 0.005 || sayi(kdv.oran) > 0)) return '';

    var etiket = kdvEtiketi({ karisik: !!kdv.karisik, oran: sayi(kdv.oran) });

    if (kdv.ustune) {
      return etiket + ' tutara eklenmiştir; NET ÖDENECEK TUTAR KDV dâhildir.';
    }

    return 'Fiyatlara KDV dâhildir. ' + etiket + ' satırı bilgi amaçlıdır; toplamdan ayrıca düşülmez ya da eklenmez.';
  }

  /**
   * İSKONTO REVİZESİ dipnotu (Faz 15).
   *
   * Fiş yeni fiyatları zaten basar — satır tutarları sunucuda değişmiştir ve
   * revize ÖNCESİ liste hiçbir yerde görünmez (ürün sahibinin isteği). Bu
   * dipnot yalnızca "oran neden farklı" sorusunu cevaplar: müşteriye giden
   * belgede sessiz bir fiyat değişikliği bırakmamak için vardır.
   *
   * Künye yoksa dipnot da yoktur — bilinmeyen şey yazılmaz.
   *
   * @param {object} fis normalle() çıktısı.
   * @returns {string} düz metin ('' olabilir)
   */
  function iskontoDipnotu(fis) {
    var k = iskontoKutugu(fis);

    /* Künye hiç yoksa ya da oran gerçekten değişmediyse dipnot basmak gürültüdür. */
    if (!(k.ilk > 0 || k.yeni > 0)) return '';
    if (Math.abs(k.ilk - k.yeni) < 0.005) return '';

    return 'Bu siparişte bayi iskonto oranı ' + oranYazi(k.ilk) + ' yerine ' + oranYazi(k.yeni) +
      ' olarak uygulanmıştır. Tutarlar liste fiyatı üzerinden yeniden hesaplanmıştır.';
  }

  /* ------------------------------------------------------------------ *
   *  HTML — A4 (akış + pencerede sayfalama) ve 80 mm termal
   *
   *  TASARIM DİLİ (Faz 14-B, ürün sahibi): resmî fiş/fatura gibi — tek yazı
   *  ailesi, siyah metin, ince gri çizgiler, önemli alanlar kalın; renkli
   *  rozet, sarı/turuncu bilgi kutusu, çizgili satır zemini YOK. Açıklamalar
   *  toplamın altında küçük puntoda dipnottur.
   * ------------------------------------------------------------------ */

  function stil(termal) {
    var ortak = [
      '* { box-sizing: border-box; }',
      'html, body { margin:0; padding:0; }',
      'h3 { margin:0 0 1.5mm; font-size:8.5px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:#555; }',
      'table { width:100%; border-collapse:collapse; }',
      'th, td { vertical-align:top; }',
      /* Rakam sütunları eş genişlikli rakamla dizilir: virgüller alt alta gelir. */
      '.sayi { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }',
      'dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:.8mm 3mm; }',
      'dt { color:#555; white-space:nowrap; }',
      'dd { margin:0; font-weight:600; overflow-wrap:anywhere; }',
      '.kalemler th { text-align:left; font-size:8.5px; letter-spacing:.3px; color:#222; font-weight:700; border-top:1px solid #222; border-bottom:1px solid #222; padding:1.6mm 1.2mm; }',
      '.kalemler th.sayi { text-align:right; }',
      '.kalemler td { padding:1.5mm 1.2mm; border-bottom:1px solid #d9d9d9; }',
      /* Ürün adı TAM yazılır: kaç satıra sararsa sarar, kırpma YOK (Faz 14-B).
         Satır yüksekliği sayfalamada ÖLÇÜLÜR, tahmin edilmez. */
      '.s-ad { overflow-wrap:anywhere; font-weight:600; }',
      '.s-sku { color:#444; white-space:nowrap; font-family:Consolas, "Courier New", monospace; font-size:.92em; }',
      '.s-liste { color:#444; }',
      '.toplamlar td { padding:1.1mm 1.5mm; border-bottom:1px solid #e3e3e3; }',
      /* Etiket SOLA, tutar SAĞA (14-C): iki sabit sütun, karışık hiza yok. */
      '.toplamlar .etiket { text-align:left; color:#222; }',
      '.toplamlar .bos .deger { color:#888; }',
      '.toplamlar .ara td { font-weight:700; }',
      '.toplamlar .kdv-yok .deger { font-weight:700; }',
      '.toplamlar .net td { font-weight:800; border-top:2px solid #222; border-bottom:2px double #222; padding-top:2mm; padding-bottom:2mm; }',
      '.dipnot { margin-top:2mm; font-size:8.5px; line-height:1.4; color:#444; }',
      /* Termal kip: KDV kalemin ALTINDA ikinci satırdır; üstteki satırın alt
         çizgisi kaldırılır ki kalem tek blok gibi okunsun. */
      '.kalemler tr.s-kdvli td { border-bottom:0; }',
      '.s-kdv-bilgi { padding-top:0 !important; color:#444; }',
      '.not { border:1px solid #bbb; padding:2.5mm 3mm; white-space:pre-wrap; overflow-wrap:anywhere; }',
      '.alt { border-top:1px solid #bbb; padding-top:2mm; font-size:8.5px; color:#555; text-align:center; }',
      '.logo { display:block; object-fit:contain; }',
      '.bos-kalem { text-align:center; color:#777; padding:6mm 0; }',
      '.belge-devam[hidden], .sayfa-alt[hidden] { display:none; }'
    ];

    var a4 = [
      '@page { size: A4; margin: 12mm; }',
      'body { font-family:"Segoe UI", Arial, sans-serif; font-size:10.5px; color:#111; background:#e8eaee; }',
      /*
       * AKIŞ → SAYFALAR. Belge önce tek akış olarak basılır (.belge); fiş
       * penceresindeki sayfalayıcı satırları ÖLÇÜP .sayfa yapraklarına
       * dağıtır. Sayfalayıcı çalışamazsa akış olduğu gibi kalır ve tarayıcı
       * kendi bölmesini yapar (thead tekrarı + satır bölünmez).
       */
      '.belge, .sayfa { width:210mm; margin:16px auto; padding:12mm; background:#fff; box-shadow:0 10px 40px rgba(0,0,0,.28); }',
      '.sayfa { position:relative; height:297mm; overflow:hidden; --kenar:12mm; }',
      '.sayfa-alt { position:absolute; left:var(--kenar); right:var(--kenar); bottom:var(--kenar); border-top:1px solid #bbb; padding-top:1.2mm; font-size:8px; color:#555; display:flex; justify-content:space-between; }',
      '.ust { display:flex; justify-content:space-between; align-items:flex-start; gap:10mm; border-bottom:2px solid #222; padding-bottom:3.5mm; margin-bottom:4mm; }',
      '.ust.devam { padding-bottom:2mm; margin-bottom:3mm; border-bottom-width:1px; }',
      '.ust.devam .fis-turu { font-size:12px; }',
      '.ust.devam .firma { font-size:11px; }',
      '.ust.devam .logo { max-height:9mm; }',
      '.marka { display:flex; align-items:center; gap:4mm; min-width:0; }',
      '.logo { max-height:16mm; max-width:55mm; }',
      '.firma { font-size:15px; font-weight:800; overflow-wrap:anywhere; }',
      '.baslik { text-align:right; white-space:nowrap; }',
      '.fis-turu { font-size:17px; font-weight:800; letter-spacing:1px; }',
      '.no { font-size:12.5px; font-weight:800; }',
      '.tarih, .durum { color:#333; }',
      '.kunye { display:grid; grid-template-columns:1fr 1fr; gap:4mm; margin-bottom:4mm; }',
      '.kutu { border:1px solid #bbb; padding:2.5mm 3mm; }',
      /* Sütun genişlikleri: ürün adı kalan alanı alır (~66 mm) ve SARAR. */
      '.kalemler { table-layout:fixed; }',
      '.kalemler .s-sku { width:19mm; }',
      '.kalemler .s-adet { width:22mm; }',
      '.kalemler .s-liste, .kalemler .s-birim { width:17mm; }',
      '.kalemler .s-kdv { width:11mm; }',
      '.kalemler .s-kdvtutar { width:16mm; }',
      '.kalemler .s-tutar { width:19mm; }',
      /* ÇİZGİLİ TABLO (14-C): ince satır VE sütun çizgileri — birim fiyat /
         iskontolu birim fiyat alt alta gelince kaymış görünmesin. Başlık
         satırı koyu çerçeveli, gövde açık gri. Termalde yok (rulo). */
      '.kalemler th { border:1px solid #222; }',
      '.kalemler td { border:1px solid #c9c9c9; }',
      /* Özet tablosu: SABİT ölçü (104 mm), etiket sütunu 66 mm, çerçeveli, sağa yaslı. */
      '.toplamlar { margin:3mm 0 0 auto; width:104mm; table-layout:fixed; }',
      '.toplamlar td { border:1px solid #c9c9c9; padding:1.4mm 2mm; }',
      '.toplamlar .etiket { width:66mm; }',
      '.toplamlar .net td { font-size:13px; }',
      '.dipnot { width:104mm; margin-left:auto; }',
      '.not { margin-top:4mm; }',
      '.alt { margin-top:6mm; }'
    ];

    var termalStil = [
      '@page { size: 80mm auto; margin: 3mm; }',
      'body { font-family:"Segoe UI", Arial, sans-serif; font-size:11px; color:#000; background:#fff; }',
      '.belge { width:74mm; margin:0 auto; padding:2mm 0; }',
      '.ust { text-align:center; border-bottom:1px dashed #000; padding-bottom:2mm; margin-bottom:2mm; }',
      '.logo { max-width:60mm; max-height:14mm; margin:0 auto 1mm; }',
      '.firma { font-size:14px; font-weight:800; overflow-wrap:anywhere; }',
      '.fis-turu { font-size:14px; font-weight:900; letter-spacing:1.5px; margin-top:1mm; }',
      '.no { font-size:13px; font-weight:800; }',
      '.kunye { display:block; margin-bottom:2mm; }',
      '.kutu { border:0; border-bottom:1px dashed #999; padding:1.5mm 0; }',
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

    /* Yazdırma: ekran süsü kalkar; sayfalanmış belgede her .sayfa bir kâğıt
       (sabit 273 mm, zorunlu sayfa sonu); akış kalmışsa tarayıcı böler ama
       satır, özet ve kutular bölünmez, başlık satırı her sayfada tekrarlanır. */
    var yazdir = [
      '@media print {',
      '  body { background:#fff; }',
      '  .belge, .sayfa { width:auto; margin:0; padding:0; box-shadow:none; }',
      '  body.a4 .sayfa { height:273mm; --kenar:0; page-break-after:always; break-after:page; }',
      '  body.a4 .sayfa:last-child { page-break-after:auto; break-after:auto; }',
      '  body.termal .belge { height:auto; }',
      '  thead { display:table-header-group; }',
      '  tr, .kutu, .toplamlar, .not, .kapanis { page-break-inside:avoid; break-inside:avoid; }',
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
   * Tam belge. Üçüncü parametre (araç çubuğu + sayfalayıcı) yalnızca pencere()
   * tarafından verilir; html() SAF kalır — etkileşimli öğe, betik ve harici
   * kaynak yok.
   *
   * BELGE İSKELETİ (sayfalayıcı sözleşmesi — depo fişi de aynı iskeleti kurar):
   *   .belge[data-kagit][data-icerik-mm]
   *     .belge-bas          ilk sayfa başlığı (marka + fiş künyesi + kutular)
   *     .belge-devam[hidden] devam sayfası başlığı (kopyalanır; .sayfa-no doldurulur)
   *     table.kalemler      thead + tbody (satırlar sayfalara TAŞINIR)
   *     .kapanis            toplamlar + dipnot + not + alt yazı (BÖLÜNMEZ)
   *     .sayfa-alt[hidden]  her sayfanın alt satırı (kopyalanır; .sayfa-no / .sayfa-toplam)
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
        '<div class="no">No: #' + kacis(fis.numara || YOK) + '</div>' +
        (fis.tarihYazi ? '<div class="tarih">Tarih: ' + kacis(fis.tarihYazi) + '</div>' : '') +
        (fis.durumEtiketi ? '<div class="durum">Durum: ' + kacis(fis.durumEtiketi) + '</div>' : '') +
      '</div></header>';

    var devamBasligi = '<header class="ust devam">' + markaHtml +
      '<div class="baslik"><div class="fis-turu">SİPARİŞ FİŞİ</div>' +
      '<div class="no">No: #' + kacis(fis.numara || YOK) + ' · Sayfa <span class="sayfa-no"></span> / <span class="sayfa-toplam"></span> (devam)</div></div></header>';

    var bayiKutusu = '<div class="kutu"><h3>Alıcı</h3><dl>' +
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

    /*
     * AKILLI AD KISALTMA (Faz 16-C) — YALNIZCA A4.
     *
     * Kısaltma bir GÖSTERİM katmanıdır: `k.ad` dokunulmaz, fiş nesnesi tam adı
     * taşımaya devam eder (WhatsApp metni ve depo fişi özeti onu okur).
     * Liste hâlinde çağrılır ki aynı fişte iki AYRI ürün aynı metne inmesin.
     */
    var kisaAdlar = termal
      ? kalemler.map(function (k) { return k.ad; })
      : kisaltListe(kalemler.map(function (k) { return k.ad; }), KISALT_A4);

    function a4Satir(k, sira) {
      var iskontolu = k.listeBirim > k.birim + 0.004;

      return '<tr>' +
        '<td class="s-ad">' + kacis(kisaAdlar[sira] || k.ad || YOK) + '</td>' +
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

    var govde = kalemler.length
      ? kalemler.map(termal ? termalSatir : a4Satir).join('')
      : '<tr><td class="bos-kalem" colspan="' + (termal ? termalSutun : A4_SUTUN) + '">Kalem yok</td></tr>';

    var baslikSatiri = termal
      ? '<tr><th>Ürün</th><th>Kod / Barkod</th><th class="sayi">Koli × Adet</th><th class="sayi">Birim</th><th class="sayi">Tutar</th></tr>'
      : A4_BASLIK;

    var tablo = '<table class="kalemler"><thead>' + baslikSatiri + '</thead><tbody>' + govde + '</tbody></table>';

    /* --- Kapanış: özet, dipnot, not, alt yazı (BÖLÜNMEZ) --- */
    var ozet = fisOzeti(fis);
    var dipnot = kdvDipnotu(ozet.kdv, { paraBirimi: birim });

    /* İskonto revizesi dipnotu KDV dipnotundan ÖNCE: fiyatın neden değiştiği,
       verginin nasıl hesaplandığından önce gelen sorudur. */
    var iskDipnot = iskontoDipnotu(fis);

    var kapanis = '<div class="kapanis">' +
      ozetBlogu(ozet, { paraBirimi: birim }) +
      (iskDipnot ? '<div class="dipnot">' + kacis(iskDipnot) + '</div>' : '') +
      (dipnot ? '<div class="dipnot">' + kacis(dipnot) + '</div>' : '') +
      (fis.not ? '<section class="not"><h3>Sipariş Notu</h3>' + kacis(fis.not) + '</section>' : '') +
      '<footer class="alt">' + kacis(ALT_YAZI) + '</footer>' +
      '</div>';

    var sayfaAlti = termal ? '' :
      '<div class="sayfa-alt" hidden>' +
        '<span>' + kacis(firma.ad ? firma.ad + ' · ' : '') + 'Sipariş Fişi No: #' + kacis(fis.numara || YOK) + '</span>' +
        '<span>Sayfa <span class="sayfa-no"></span> / <span class="sayfa-toplam"></span></span>' +
      '</div>';

    var belge = '<div class="belge" data-kagit="' + (termal ? 'termal' : 'a4') + '" data-icerik-mm="273">' +
      '<div class="belge-bas">' + tamBaslik + kunye + '</div>' +
      (termal ? '' : '<div class="belge-devam" hidden>' + devamBasligi + '</div>') +
      tablo + kapanis + sayfaAlti +
      '</div>';

    var a = (arac && 'object' === typeof arac) ? arac : { stil: '', govde: '', betik: '' };

    return '<!DOCTYPE html>\n' +
      '<html lang="tr"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Sipariş Fişi #' + kacis(fis.numara) + '</title>' +
      '<style>\n' + stil(termal) + (a.stil ? '\n' + a.stil : '') + '\n</style></head>' +
      '<body class="' + (termal ? 'termal' : 'a4') + '">' + a.govde + belge + a.betik + '</body></html>';
  }

  /**
   * Tam HTML belgesi (satır içi <style>, harici kaynak yok, etkileşim yok).
   *
   * @param {object} fis      normalle() çıktısı (kaynak nesne de kabul edilir)
   * @param {object} secenek  { kagit: 'a4'|'termal', paraBirimi: 'TL' }
   */
  function html(fis, secenek) {
    return belgeKur(fis, secenek, null);
  }

  /* ------------------------------------------------------------------ *
   *  SAYFALAYICI BETİĞİ — fiş penceresinde ÖLÇ, SIRAYLA DOLDUR, YAPRAKLARA DİZ
   *
   *  Neden pencerede: satır yüksekliği ürün adının kaç satıra sardığına,
   *  fonta ve sütun genişliğine bağlıdır; bunu HTML üretirken tahmin etmek
   *  ya adı kırpmayı (yasak) ya da sayfayı taşırmayı gerektirir. Pencere
   *  belgeyi bir kez akış olarak yerleştirir, gerçek yükseklikleri okur ve
   *  sayfalaraBol() ile (AYNI fonksiyon — toString ile gömülür, ikinci kopya
   *  yok) yapraklara dağıtır. Depo fişi de bu betiği kullanır.
   * ------------------------------------------------------------------ */
  function sayfalayiciBetigi() {
    return '<script>(function () {' +
      'var belge = document.querySelector(".belge");' +
      'if (!belge || "termal" === belge.getAttribute("data-kagit")) return;' +
      'var sayfalaraBol = ' + sayfalaraBol.toString() + ';' +
      'function doldur(kok, no, toplam) {' +
        'var i, l = kok.querySelectorAll(".sayfa-no"); for (i = 0; i < l.length; i++) l[i].textContent = no;' +
        'l = kok.querySelectorAll(".sayfa-toplam"); for (i = 0; i < l.length; i++) l[i].textContent = toplam;' +
      '}' +
      'function calistir() {' +
        'if (!belge.parentNode) return;' +
        'var bas = belge.querySelector(".belge-bas"), devam = belge.querySelector(".belge-devam"),' +
            'tablo = belge.querySelector("table.kalemler"), kapanis = belge.querySelector(".kapanis"),' +
            'altSablon = belge.querySelector(".sayfa-alt");' +
        'if (!bas || !tablo || !kapanis || !tablo.tBodies.length) return;' +
        'var mm = Number(belge.getAttribute("data-icerik-mm")) || 273;' +
        'var probe = document.createElement("div");' +
        'probe.style.cssText = "position:absolute;visibility:hidden;height:" + mm + "mm;width:1px;";' +
        'document.body.appendChild(probe); var H = probe.offsetHeight; document.body.removeChild(probe);' +
        'if (!H) return;' +
        'var thead = tablo.tHead, satirlar = Array.prototype.slice.call(tablo.tBodies[0].rows);' +
        'var devamH = 0; if (devam) { devam.hidden = false; devamH = devam.offsetHeight; devam.hidden = true; }' +
        'var altH = 0; if (altSablon) { altSablon.hidden = false; altH = altSablon.offsetHeight; altSablon.hidden = true; }' +
        'var basH = bas.offsetHeight, theadH = thead ? thead.offsetHeight : 0, kapanisH = kapanis.offsetHeight;' +
        'if (!basH || !kapanisH) return;' +
        'var pay = 10;' +
        'var agirliklar = satirlar.map(function (tr) { return tr.offsetHeight; });' +
        'var sonuc = sayfalaraBol(agirliklar, { ilk: H - basH - theadH - altH - pay, devam: H - devamH - theadH - altH - pay, ozet: kapanisH + pay });' +
        'var toplam = sonuc.toplam, kapsayici = document.createElement("div"); kapsayici.className = "sayfalar";' +
        'function sayfaKur(no, baslik, dilim, kapanisMi) {' +
          'var s = document.createElement("div"); s.className = "sayfa" + (no > 1 ? " devam" : ""); s.setAttribute("data-sayfa", no);' +
          's.appendChild(baslik);' +
          'if (dilim) { var t = document.createElement("table"); t.className = tablo.className;' +
            'if (thead) t.appendChild(thead.cloneNode(true));' +
            'var tb = document.createElement("tbody"); for (var i = 0; i < dilim.length; i++) tb.appendChild(dilim[i]);' +
            't.appendChild(tb); s.appendChild(t); }' +
          'if (kapanisMi) s.appendChild(kapanis);' +
          'if (altSablon) { var alt = altSablon.cloneNode(true); alt.hidden = false; doldur(alt, no, toplam); s.appendChild(alt); }' +
          'return s;' +
        '}' +
        'function devamBasligi(no) { var b = devam ? devam.cloneNode(true) : document.createElement("div"); b.hidden = false; doldur(b, no, toplam); return b; }' +
        'for (var i = 0; i < sonuc.sayfalar.length; i++) {' +
          'var sf = sonuc.sayfalar[i], son = (i === sonuc.sayfalar.length - 1) && !sonuc.ozetAyri;' +
          'kapsayici.appendChild(sayfaKur(i + 1, i ? devamBasligi(i + 1) : bas, satirlar.slice(sf.bas, sf.son), son));' +
        '}' +
        'if (sonuc.ozetAyri) kapsayici.appendChild(sayfaKur(toplam, devamBasligi(toplam), null, true));' +
        'belge.parentNode.replaceChild(kapsayici, belge);' +
        'document.body.setAttribute("data-sayfali", toplam);' +
      '}' +
      'try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(calistir, calistir); else calistir(); } catch (e) { calistir(); }' +
      '})();<\/script>';
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
   * @returns {{ stil: string, govde: string, betik: string, tel: string }}
   */
  function aracCubugu(secenek) {
    var s = (secenek && 'object' === typeof secenek) ? secenek : {};
    var wa = (s.whatsapp && 'object' === typeof s.whatsapp) ? s.whatsapp : {};
    var tel = waTelefon(wa.tel);

    var stilSatirlari = [
      '.arac { position:sticky; top:0; z-index:10; display:flex; gap:8px; align-items:center; padding:8px 12px; background:#1f2937; box-shadow:0 1px 2px rgba(0,0,0,.25); font-family:"Segoe UI", Arial, sans-serif; }',
      '.arac .baslik { color:#e5e7eb; font-size:12.5px; font-weight:600; margin-right:auto; white-space:normal; text-align:left; }',
      '.arac button { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; letter-spacing:.2px; padding:8px 14px; border:1px solid transparent; border-radius:4px; color:#fff; cursor:pointer; transition:filter .15s, transform .1s; }',
      '.arac button:hover { filter:brightness(1.12); }',
      '.arac button:active { transform:scale(.97); }',
      '.arac button[disabled] { opacity:.45; cursor:not-allowed; filter:none; transform:none; }',
      '.b-yazdir { background:#2563eb; }',
      '.b-pdf { background:#374151; border-color:#4b5563; }',
      '.b-wa { background:#15803d; }',
      '.b-kapat { background:#374151; border-color:#4b5563; }',
      '.fis-toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); max-width:640px; padding:10px 16px; border-radius:6px; background:#1f2937; color:#fff; font:600 13px "Segoe UI", Arial, sans-serif; box-shadow:0 8px 24px rgba(0,0,0,.35); z-index:20; }',
      '.fis-toast.ok { background:#166534; }',
      '.fis-toast.hata { background:#991b1b; }',
      '@media print { .yazdirma-yok { display:none !important; } }'
    ];

    var govde = '<div class="arac yazdirma-yok">' +
      '<div class="baslik">' + kacis(s.baslik || '') + '</div>' +
      '<button class="b-yazdir" id="btnYazdir" type="button">YAZDIR</button>' +
      '<button class="b-pdf" id="btnPdf" type="button">PDF OLARAK KAYDET</button>' +
      '<button class="b-wa" id="btnWa" type="button"' +
        (tel ? '' : ' disabled title="Müşterinin kayıtlı telefon numarası yok"') +
        '>WHATSAPP\'TAN GÖNDER</button>' +
      '<button class="b-kapat" id="btnKapat" type="button">KAPAT</button>' +
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
   * Araç çubuklu, sayfalayıcılı fiş penceresi (fis:onizleme'ye giden belge).
   * html() saf kalır; etkileşim ve sayfalama betiği yalnızca burada eklenir.
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

    /* Sayfalayıcı araç çubuğu betiğinden ÖNCE: belge yapraklara dizilmeden
       yazdırma/PDF tetiklenmesin. */
    return belgeKur(fis, s, { stil: arac.stil, govde: arac.govde, betik: sayfalayiciBetigi() + arac.betik });
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
      son.push('*' + (odemeKisaAd(oz0.odemeAdi) ? odemeKisaAd(oz0.odemeAdi) + ' ' + OZET_ETIKET.odeme : OZET_ETIKET.odemeYok) +
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
    kdvDipnotu: kdvDipnotu,
    iskontoDipnotu: iskontoDipnotu,
    odemeKisaAd: odemeKisaAd,
    sayfalaraBol: sayfalaraBol,
    sayfalayiciBetigi: sayfalayiciBetigi,
    aracCubugu: aracCubugu,
    /* Faz 16-C — akilli ad kisaltma (depo fisi de ayni ciziciyi cagirir) */
    kisaltAd: kisaltAd,
    kisaltListe: kisaltListe,
    /* sabitler */
    KISALT_A4: KISALT_A4,
    KISALT_TERMAL: KISALT_TERMAL,
    PARA_BIRIMI: PARA_BIRIMI,
    WA_EN_COK_KALEM: WA_EN_COK_KALEM,
    WA_EN_COK_KARAKTER: WA_EN_COK_KARAKTER,
    ALT_YAZI: ALT_YAZI,
    OZET_ETIKET: OZET_ETIKET
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = SiparisFisi;
  if (typeof window !== 'undefined') window.SiparisFisi = SiparisFisi;
})();
