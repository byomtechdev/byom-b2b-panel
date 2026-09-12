/* ============================================================================
 *  TÜRKİYE HARİTA VERİSİ VE ZİYARET NOTU MANTIĞI — DOM'SUZ
 *  src/renderer/harita-veri.js
 *  ---------------------------------------------------------------------------
 *  81 ilin kütüğü (plaka, ad, bölge, yaklaşık coğrafi konum) + harita
 *  kokpitinin kullandığı bütün SAF hesap: durum geçişleri, filtreler,
 *  yoğunluk tonu, uyarı kararı.
 *
 *  ╔══════════════════════════════════════════════════════════════════════╗
 *  ║  GEOMETRİ HAKKINDA DÜRÜST NOT — OKUMADAN GEÇME                       ║
 *  ╠══════════════════════════════════════════════════════════════════════╣
 *  ║  Bu dosya GERÇEK İL SINIR POLİGONLARI İÇERMEZ.                       ║
 *  ║                                                                      ║
 *  ║  81 ilin gerçek sınır yolu (SVG `path`) ~100 KB'lık ölçülmüş          ║
 *  ║  coğrafi veridir; bellekten üretilemez, üretilirse harita tanınmaz    ║
 *  ║  bir karalamaya döner. Onun yerine her il, GERÇEĞE YAKIN coğrafi      ║
 *  ║  konumunda bir KUTU olarak çizilir (kartogram / tile-map üslubu).     ║
 *  ║  Bu bilinçli ve yaygın bir görselleştirme biçimidir: konum ilişkisi   ║
 *  ║  doğru, sınır şekli şematiktir.                                      ║
 *  ║                                                                      ║
 *  ║  GERÇEK SINIRLARA GEÇİŞ — TEK DOSYA, TEK ALAN:                       ║
 *  ║  `ILLER[n].yol` alanına o ilin SVG `d` dizesini yazın (ya da          ║
 *  ║  `yollariYukle(harita)` ile toptan besleyin). Başka HİÇBİR yer        ║
 *  ║  değişmez: hover, ipucu, bölünmüş ekran, yakınlaştırma, uyarı         ║
 *  ║  ikonu ve filtreler iki kaynakta da aynı çalışır                     ║
 *  ║  (`harita-kokpit.js` yol varsa <path>, yoksa <rect> basar).           ║
 *  ╚══════════════════════════════════════════════════════════════════════╝
 *
 *  KONUM SİSTEMİ: 1000x420 birimlik soyut tuval. x batıdan doğuya,
 *  y kuzeyden güneye artar. Değerler ilin yaklaşık merkezidir.
 * ==========================================================================*/

(function (kok) {
  'use strict';

  /** Soyut tuval ölçüsü — SVG viewBox ile birebir. */
  var TUVAL = { w: 1000, h: 420 };

  /** Ziyaret notu durumları (PHP ikizi: B2B_Ziyaret::DURUMLAR). */
  var DURUMLAR = ['beklemede', 'gorundu', 'cozuldu'];

  /** Hızlı etiketler (PHP ikizi: B2B_Ziyaret::ETIKETLER). */
  var ETIKETLER = {
    'siparis-alindi': 'Sipariş Alındı',
    'stok-dolu': 'Stok Dolu',
    'fiyat-yuksek': 'Fiyat Yüksek',
    'yetkili-yoktu': 'Yetkili Yoktu',
    'ozel-talep': 'Özel Fiyat/Ürün Talebi',
    'sikayet-hasar': 'Şikayet/Hasar'
  };

  /**
   * 81 İL KÜTÜĞÜ — [plaka, ad, bölge, x, y]
   *
   * Bölge adları plasiyer bölge atamasıyla aynı sözlükten gelir
   * (Marmara / Ege / Akdeniz / İç Anadolu / Karadeniz / Doğu Anadolu /
   * Güneydoğu Anadolu).
   */
  var HAM = [
    [1, 'Adana', 'Akdeniz', 560, 300],
    [2, 'Adıyaman', 'Güneydoğu Anadolu', 700, 285],
    [3, 'Afyonkarahisar', 'Ege', 330, 225],
    [4, 'Ağrı', 'Doğu Anadolu', 880, 185],
    [5, 'Amasya', 'Karadeniz', 560, 120],
    [6, 'Ankara', 'İç Anadolu', 440, 175],
    [7, 'Antalya', 'Akdeniz', 330, 320],
    [8, 'Artvin', 'Karadeniz', 820, 95],
    [9, 'Aydın', 'Ege', 205, 280],
    [10, 'Balıkesir', 'Marmara', 215, 175],
    [11, 'Bilecik', 'Marmara', 300, 145],
    [12, 'Bingöl', 'Doğu Anadolu', 775, 225],
    [13, 'Bitlis', 'Doğu Anadolu', 855, 240],
    [14, 'Bolu', 'Karadeniz', 375, 135],
    [15, 'Burdur', 'Akdeniz', 300, 290],
    [16, 'Bursa', 'Marmara', 265, 150],
    [17, 'Çanakkale', 'Marmara', 165, 160],
    [18, 'Çankırı', 'İç Anadolu', 460, 135],
    [19, 'Çorum', 'Karadeniz', 510, 125],
    [20, 'Denizli', 'Ege', 255, 270],
    [21, 'Diyarbakır', 'Güneydoğu Anadolu', 760, 265],
    [22, 'Edirne', 'Marmara', 160, 105],
    [23, 'Elazığ', 'Doğu Anadolu', 730, 240],
    [24, 'Erzincan', 'Doğu Anadolu', 760, 185],
    [25, 'Erzurum', 'Doğu Anadolu', 820, 165],
    [26, 'Eskişehir', 'İç Anadolu', 345, 180],
    [27, 'Gaziantep', 'Güneydoğu Anadolu', 650, 300],
    [28, 'Giresun', 'Karadeniz', 680, 110],
    [29, 'Gümüşhane', 'Karadeniz', 735, 135],
    [30, 'Hakkâri', 'Doğu Anadolu', 905, 270],
    [31, 'Hatay', 'Akdeniz', 610, 330],
    [32, 'Isparta', 'Akdeniz', 320, 275],
    [33, 'Mersin', 'Akdeniz', 505, 310],
    [34, 'İstanbul', 'Marmara', 250, 110],
    [35, 'İzmir', 'Ege', 180, 230],
    [36, 'Kars', 'Doğu Anadolu', 870, 140],
    [37, 'Kastamonu', 'Karadeniz', 450, 105],
    [38, 'Kayseri', 'İç Anadolu', 565, 225],
    [39, 'Kırklareli', 'Marmara', 195, 95],
    [40, 'Kırşehir', 'İç Anadolu', 490, 195],
    [41, 'Kocaeli', 'Marmara', 290, 120],
    [42, 'Konya', 'İç Anadolu', 425, 265],
    [43, 'Kütahya', 'Ege', 300, 200],
    [44, 'Malatya', 'Doğu Anadolu', 690, 250],
    [45, 'Manisa', 'Ege', 215, 225],
    [46, 'Kahramanmaraş', 'Akdeniz', 625, 270],
    [47, 'Mardin', 'Güneydoğu Anadolu', 790, 300],
    [48, 'Muğla', 'Ege', 225, 310],
    [49, 'Muş', 'Doğu Anadolu', 825, 220],
    [50, 'Nevşehir', 'İç Anadolu', 520, 220],
    [51, 'Niğde', 'İç Anadolu', 530, 255],
    [52, 'Ordu', 'Karadeniz', 640, 105],
    [53, 'Rize', 'Karadeniz', 770, 100],
    [54, 'Sakarya', 'Marmara', 320, 125],
    [55, 'Samsun', 'Karadeniz', 580, 100],
    [56, 'Siirt', 'Güneydoğu Anadolu', 830, 275],
    [57, 'Sinop', 'Karadeniz', 510, 85],
    [58, 'Sivas', 'İç Anadolu', 640, 185],
    [59, 'Tekirdağ', 'Marmara', 205, 120],
    [60, 'Tokat', 'Karadeniz', 600, 145],
    [61, 'Trabzon', 'Karadeniz', 730, 105],
    [62, 'Tunceli', 'Doğu Anadolu', 760, 215],
    [63, 'Şanlıurfa', 'Güneydoğu Anadolu', 705, 310],
    [64, 'Uşak', 'Ege', 270, 235],
    [65, 'Van', 'Doğu Anadolu', 885, 230],
    [66, 'Yozgat', 'İç Anadolu', 540, 175],
    [67, 'Zonguldak', 'Karadeniz', 390, 105],
    [68, 'Aksaray', 'İç Anadolu', 500, 230],
    [69, 'Bayburt', 'Karadeniz', 775, 140],
    [70, 'Karaman', 'İç Anadolu', 455, 295],
    [71, 'Kırıkkale', 'İç Anadolu', 475, 170],
    [72, 'Batman', 'Güneydoğu Anadolu', 805, 275],
    [73, 'Şırnak', 'Güneydoğu Anadolu', 860, 295],
    [74, 'Bartın', 'Karadeniz', 415, 95],
    [75, 'Ardahan', 'Doğu Anadolu', 855, 110],
    [76, 'Iğdır', 'Doğu Anadolu', 905, 175],
    [77, 'Yalova', 'Marmara', 270, 130],
    [78, 'Karabük', 'Karadeniz', 425, 115],
    [79, 'Kilis', 'Güneydoğu Anadolu', 645, 320],
    [80, 'Osmaniye', 'Akdeniz', 595, 300],
    [81, 'Düzce', 'Karadeniz', 350, 120]
  ];

  /**
   * İl kütüğü.
   *
   * `yol` alanı GERÇEK SVG sınır yolu içindir ve varsayılan olarak BOŞTUR
   * (bkz. dosya başlığındaki not). Boşken kokpit kutu çizer.
   */
  var ILLER = HAM.map(function (s) {
    return { plaka: s[0], ad: s[1], bolge: s[2], x: s[3], y: s[4], yol: '' };
  });

  /** ad (normalize) -> il */
  var AD_INDEKS = {};

  /** plaka -> il */
  var PLAKA_INDEKS = {};

  /** Türkçe harfleri ASCII'ye indirir — "İZMİR", "izmir", "İzmir" aynı anahtar. */
  function normalize(ham) {
    return String(ham === null || ham === undefined ? '' : ham)
      .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
      .replace(/Ş/g, 's').replace(/ş/g, 's')
      .replace(/Ğ/g, 'g').replace(/ğ/g, 'g')
      .replace(/Ü/g, 'u').replace(/ü/g, 'u')
      .replace(/Ö/g, 'o').replace(/ö/g, 'o')
      .replace(/Ç/g, 'c').replace(/ç/g, 'c')
      .replace(/Â/g, 'a').replace(/â/g, 'a')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  ILLER.forEach(function (il) {
    AD_INDEKS[normalize(il.ad)] = il;
    PLAKA_INDEKS[il.plaka] = il;
  });

  /* Yaygın yazımlar ve eski adlar — sunucudan ne gelirse tutsun. */
  [
    ['kmaras', 'Kahramanmaraş'], ['kahramanmaras', 'Kahramanmaraş'], ['maras', 'Kahramanmaraş'],
    ['urfa', 'Şanlıurfa'], ['sanliurfa', 'Şanlıurfa'],
    ['afyon', 'Afyonkarahisar'],
    ['icel', 'Mersin'], ['icelmersin', 'Mersin'],
    ['hakkari', 'Hakkâri'],
    ['igdir', 'Iğdır'],
    ['istanbulavrupa', 'İstanbul'], ['istanbulanadolu', 'İstanbul']
  ].forEach(function (c) {
    var il = AD_INDEKS[normalize(c[1])];
    if (il) AD_INDEKS[c[0]] = il;
  });

  /** Ada (ya da plakaya) göre il bulur. */
  function ilBul(ad) {
    if ('number' === typeof ad || /^[0-9]{1,2}$/.test(String(ad))) {
      return PLAKA_INDEKS[Number(ad)] || null;
    }

    return AD_INDEKS[normalize(ad)] || null;
  }

  /** Bölgeye ait iller. */
  function bolgeIlleri(bolge) {
    var b = normalize(bolge);

    return ILLER.filter(function (il) { return normalize(il.bolge) === b; });
  }

  /** Benzersiz bölge listesi (ada göre sıralı). */
  function bolgeler() {
    var kume = {};

    ILLER.forEach(function (il) { kume[il.bolge] = true; });

    return Object.keys(kume).sort(function (a, b) {
      return normalize(a).localeCompare(normalize(b), 'tr');
    });
  }

  /* ------------------------------------------------------------------ *
   *  SUNUCU VERİSİNİ HARİTAYA OTURTMA
   * ------------------------------------------------------------------ */

  /** Boş il ölçümü. */
  function bosOlcum() {
    return {
      bayiSayisi: 0,
      bayiler: [],
      siparis: 0,
      ciro: 0,
      not: { toplam: 0, beklemede: 0, gorundu: 0, cozuldu: 0, cozulmemis: 0 }
    };
  }

  /**
   * `/admin/harita` yanıtını 81 ile oturtur.
   *
   * TANINMAYAN İL ADLARI KAYBOLMAZ: `tanimsiz` dizisinde döner. Sessizce
   * düşürmek, "ciro toplamı neden tutmuyor" diye aranacak bir hata olurdu.
   *
   * @param {object} yanit { iller: { 'İzmir': {...} } }
   * @returns {object} { iller: [...81...], tanimsiz: [...], enCokCiro, toplam }
   */
  function haritayiKur(yanit) {
    var gelen = (yanit && yanit.iller) || {};
    var tanimsiz = [];

    var olcum = {};

    ILLER.forEach(function (il) { olcum[il.plaka] = bosOlcum(); });

    Object.keys(gelen).forEach(function (ad) {
      var il = ilBul(ad);
      var veri = gelen[ad] || {};

      if (!il) {
        tanimsiz.push({ ad: ad, veri: veri });
        return;
      }

      var o = olcum[il.plaka];

      o.bayiSayisi += Number(veri.bayiSayisi) || 0;
      o.bayiler = o.bayiler.concat(Array.isArray(veri.bayiler) ? veri.bayiler : []);
      o.siparis += Number(veri.siparis) || 0;
      o.ciro += Number(veri.ciro) || 0;

      var n = veri.not || {};

      ['toplam', 'beklemede', 'gorundu', 'cozuldu', 'cozulmemis'].forEach(function (k) {
        o.not[k] += Number(n[k]) || 0;
      });
    });

    var enCokCiro = 0;
    var toplam = { bayi: 0, siparis: 0, ciro: 0, cozulmemis: 0 };

    var liste = ILLER.map(function (il) {
      var o = olcum[il.plaka];

      enCokCiro = Math.max(enCokCiro, o.ciro);

      toplam.bayi += o.bayiSayisi;
      toplam.siparis += o.siparis;
      toplam.ciro += o.ciro;
      toplam.cozulmemis += o.not.cozulmemis;

      return {
        plaka: il.plaka,
        ad: il.ad,
        bolge: il.bolge,
        x: il.x,
        y: il.y,
        yol: il.yol,
        bayiSayisi: o.bayiSayisi,
        bayiler: o.bayiler,
        siparis: o.siparis,
        ciro: Math.round(o.ciro * 100) / 100,
        not: o.not,
        /* Haritada kırmızı ünlem gösterilecek mi? */
        uyari: o.not.cozulmemis > 0
      };
    });

    toplam.ciro = Math.round(toplam.ciro * 100) / 100;

    return { iller: liste, tanimsiz: tanimsiz, enCokCiro: enCokCiro, toplam: toplam };
  }

  /**
   * İlin yoğunluk tonu (0-1) — haritada dolgu koyuluğu.
   *
   * Ölçek EN YÜKSEK ile göredir, toplama göre değil: 81 ile bölünse bütün
   * iller neredeyse beyaz kalırdı.
   *
   * @param {object} il       haritayiKur çıktısındaki il.
   * @param {number} enCok    En yüksek değer.
   * @param {string} olcut    'ciro' | 'siparis' | 'bayi'
   * @returns {number} 0-1
   */
  function yogunluk(il, enCok, olcut) {
    var deger = 0;

    if ('siparis' === olcut) deger = Number(il.siparis) || 0;
    else if ('bayi' === olcut) deger = Number(il.bayiSayisi) || 0;
    else deger = Number(il.ciro) || 0;

    var tavan = Number(enCok) || 0;

    if (tavan <= 0 || deger <= 0) return 0;

    /* Karekök ölçek: tek büyük il diğerlerini tamamen soluk bırakmasın. */
    return Math.min(1, Math.sqrt(deger / tavan));
  }

  /* ------------------------------------------------------------------ *
   *  ZİYARET NOTU MANTIĞI
   * ------------------------------------------------------------------ */

  /** Durum geçerli mi? */
  function durumGecerliMi(durum) {
    return DURUMLAR.indexOf(String(durum || '')) !== -1;
  }

  /**
   * Durum ILERI gidebilir mi?
   *
   * PHP tarafıyla (B2B_Ziyaret::durum_ilerlet) AYNI kural: geriye gidiş
   * reddedilir. Çözülmüş notu "beklemede"ye döndürmek haritadaki uyarıyı
   * yeniden yakardı. Arayüz düğmeyi hiç göstermesin diye burada da var.
   */
  function ilerleyebilirMi(simdi, hedef) {
    if (!durumGecerliMi(simdi) || !durumGecerliMi(hedef)) return false;

    return DURUMLAR.indexOf(hedef) >= DURUMLAR.indexOf(simdi);
  }

  /** Bir sonraki mantıklı durum (düğme etiketi için). */
  function sonrakiDurum(simdi) {
    var i = DURUMLAR.indexOf(String(simdi || ''));

    if (i === -1) return DURUMLAR[1];

    return i >= DURUMLAR.length - 1 ? null : DURUMLAR[i + 1];
  }

  /** Not çözülmemiş mi? ("gorundu" DA çözülmemiştir — okundu, bitmedi.) */
  function cozulmemisMi(not) {
    return !!not && 'cozuldu' !== not.durum;
  }

  /**
   * Notları süzer.
   *
   * @param {Array}  notlar Not listesi.
   * @param {object} filtre { il, plasiyerId, durum, gun, etiket }
   * @returns {Array}
   */
  function notlariSuz(notlar, filtre) {
    var liste = Array.isArray(notlar) ? notlar : [];

    filtre = filtre || {};

    var ilAdi = filtre.il ? normalize(filtre.il) : '';
    var sinir = 0;

    if (Number(filtre.gun) > 0) {
      sinir = Date.now() - (Number(filtre.gun) * 86400000);
    }

    return liste.filter(function (n) {
      if (!n) return false;

      if (ilAdi && normalize(n.il) !== ilAdi) return false;

      if (filtre.plasiyerId && Number(n.plasiyerId) !== Number(filtre.plasiyerId)) return false;

      if (filtre.durum && String(n.durum) !== String(filtre.durum)) return false;

      if (filtre.etiket && (!Array.isArray(n.etiketler) || n.etiketler.indexOf(filtre.etiket) === -1)) return false;

      if (sinir) {
        var t = Date.parse(n.zaman || '');

        /* Zamanı okunamayan not SÜZÜLMEZ: tarih alanı bozuk diye bir şikayeti
           gizlemek, onu kaybetmek olurdu. */
        if (!isNaN(t) && t < sinir) return false;
      }

      return true;
    });
  }

  /** Çözülmemiş not sayısı (menü rozeti). */
  function cozulmemisSayisi(notlar, filtre) {
    return notlariSuz(notlar, filtre).filter(cozulmemisMi).length;
  }

  /** Etiket anahtarını okunabilir etikete çevirir. */
  function etiketAdi(anahtar) {
    return ETIKETLER[String(anahtar)] || String(anahtar || '');
  }

  /* ------------------------------------------------------------------ *
   *  GERÇEK SINIR YOLLARINI BESLEME
   * ------------------------------------------------------------------ */

  /**
   * İl sınır yollarını toptan yükler.
   *
   * GERÇEK HARİTAYA GEÇİŞİN TEK KAPISI. Anahtar il adı ya da plaka olabilir:
   *   yollariYukle({ 35: 'M180,230 L...', 'Ankara': 'M...' })
   *
   * @param {object} harita plaka|ad -> SVG `d` dizesi
   * @returns {number} kaç ile yol yazıldı
   */
  function yollariYukle(harita) {
    if (!harita || 'object' !== typeof harita) return 0;

    var sayi = 0;

    Object.keys(harita).forEach(function (anahtar) {
      var il = ilBul(anahtar);
      var yol = String(harita[anahtar] || '').trim();

      if (il && yol) {
        il.yol = yol;
        sayi++;
      }
    });

    return sayi;
  }

  /** Gerçek sınır yolu yüklenmiş il sayısı (kokpit bunu gösterir). */
  function yolluIlSayisi() {
    return ILLER.filter(function (il) { return !!il.yol; }).length;
  }

  var HaritaVeri = {
    TUVAL: TUVAL,
    ILLER: ILLER,
    DURUMLAR: DURUMLAR,
    ETIKETLER: ETIKETLER,
    normalize: normalize,
    ilBul: ilBul,
    bolgeIlleri: bolgeIlleri,
    bolgeler: bolgeler,
    haritayiKur: haritayiKur,
    yogunluk: yogunluk,
    durumGecerliMi: durumGecerliMi,
    ilerleyebilirMi: ilerleyebilirMi,
    sonrakiDurum: sonrakiDurum,
    cozulmemisMi: cozulmemisMi,
    notlariSuz: notlariSuz,
    cozulmemisSayisi: cozulmemisSayisi,
    etiketAdi: etiketAdi,
    yollariYukle: yollariYukle,
    yolluIlSayisi: yolluIlSayisi
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = HaritaVeri;
  }

  if (typeof window !== 'undefined') {
    window.HaritaVeri = HaritaVeri;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
