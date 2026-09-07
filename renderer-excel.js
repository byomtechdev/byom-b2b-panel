/* ============================================================================
 *  B2B YÖNETİM PANELİ — EXCEL DÖKÜMÜ VE SÜTUN EŞLEŞTİRMELİ İÇE AKTARMA
 *  ---------------------------------------------------------------------------
 *  renderer.js, renderer-ek.js ve renderer-izgara.js'ten SONRA yüklenir ve
 *  onların genel kapsamdaki yardımcılarını kullanır:
 *    $, kacis, para, paraSade, sayiCoz, bildir, onayla, bekle, ikon,
 *    butonuMesgulEt, woo, durum, urunNormalle, urunleriYukle, izg,
 *    izgKategorileriYukle, izgKategoriAgaciCiz, DEMO_URUNLER
 *
 *  NEDEN AYRI DOSYA
 *  ----------------
 *  Excel alışverişi tek başına bir konu başlığı: dosya seçimi, biçim okuma,
 *  sütun eşleştirme sihirbazı ve toplu senkronizasyon. Izgara dosyasının
 *  içine konsaydı iki ayrı iş (tablo çizimi + veri aktarımı) tek dosyada
 *  birbirine karışırdı. Dosya OKUMA/YAZMA işi ana süreçtedir
 *  (src/main/byom-excel.js); burası yalnızca arayüz ve senkronizasyon.
 *
 *  ÜÇ İŞ
 *  -----
 *   A) EXCEL DÖKÜMÜ — kataloğu standart bir .xlsx dosyasına yazar.
 *   B) SÜTUN EŞLEŞTİRME — yüklenen dosyanın başlıklarını panelin alanlarına
 *      bağlar; tanıdık başlıkları (Fiyat, SKU, Stok…) kendiliğinden seçer.
 *   C) SENKRONİZASYON — SKU eşleşenleri günceller (PUT), eşleşmeyenleri yeni
 *      ürün olarak ekler (POST); canlı ilerleme çubuğu ve özet rapor verir.
 * ==========================================================================*/

'use strict';

/* ==========================================================================
 *  BÖLÜM 0 — DURUM VE ORTAK YARDIMCILAR
 * ========================================================================*/

/** Sihirbazın geçici durumu (pencere kapanınca anlamını yitirir). */
const XLS = {
  yol: '',
  ad: '',
  bicim: '',
  basliklar: [],
  satirlar: [],
  kirpildi: false,
  /** { alanKodu: excelSutunIndeksi }  —  -1 = kullanma */
  esleme: Object.create(null),
  /** Otomatik tanınan alan kodları (rozet göstermek için). */
  otomatik: Object.create(null),
  calisiyor: false,
  durdur: false
};

/** Bir seferde okunacak en fazla satır — devasa dosyalar arayüzü boğmasın. */
const XLS_EN_FAZLA_SATIR = 20000;

/** Önizlemede gösterilecek satır sayısı. */
const XLS_ONIZLEME = 3;

function xlsDemoMu() {
  return !!(typeof durum !== 'undefined' && durum && durum.ayarlar && durum.ayarlar.demoModu);
}

/**
 * Başlık karşılaştırması için metni sadeleştirir.
 *
 * Türkçe küçültme ÖNCE yapılır (I→ı, İ→i); ardından çengelli harfler ASCII
 * karşılıklarına indirilir. Böylece "FİYATI", "Fiyati" ve "fiyati" aynı
 * anahtara düşer.
 */
function xlsSadelestir(metin) {
  return String(metin === null || metin === undefined ? '' : metin)
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Satırdaki bir sütunun kırpılmış metni ('' = yok). */
function xlsHucre(satir, indeks) {
  if (indeks === undefined || indeks === null || indeks < 0) return '';
  const h = satir[indeks];
  return (h === null || h === undefined) ? '' : String(h).trim();
}

/** Dosya adı için "2026-08-31" biçiminde tarih. */
function xlsTarihEki() {
  const t = new Date();
  const iki = function (n) { return (n < 10 ? '0' : '') + n; };
  return t.getFullYear() + '-' + iki(t.getMonth() + 1) + '-' + iki(t.getDate());
}

/* ==========================================================================
 *  BÖLÜM A — EXCEL DÖKÜMÜ (DIŞA AKTARMA)
 * ========================================================================*/

/**
 * Döküm sütunları — sıra dosyada birebir bu şekilde çıkar.
 *
 * `tur` ana sürece gider ve hücre biçimini belirler:
 *   para    → 1.234,56 biçimli SAYI (Excel'de toplanabilir)
 *   tamsayi → basamaksız SAYI
 *   metin   → düz metin
 */
const XLS_DOKUM_SUTUNLARI = [
  { kod: 'gorsel',   baslik: 'Ürün Görseli (URL)', tur: 'metin',   genislik: 44 },
  { kod: 'ad',       baslik: 'Ürün Adı',           tur: 'metin',   genislik: 46 },
  { kod: 'kod',      baslik: 'SKU / Barkod',       tur: 'metin',   genislik: 20 },
  { kod: 'fiyat',    baslik: 'Liste Fiyatı (₺)',   tur: 'para',    genislik: 16 },
  { kod: 'stok',     baslik: 'Stok Adedi',         tur: 'tamsayi', genislik: 13 },
  { kod: 'kategori', baslik: 'Kategori',           tur: 'metin',   genislik: 26 },
  { kod: 'durum',    baslik: 'Durum',              tur: 'metin',   genislik: 14 }
];

/** Ürünün kategorilerini tek hücreye yazar. */
function xlsKategoriYazi(u) {
  return (u.kategoriler || [])
    .map(function (k) { return String(k.ad || ''); })
    .filter(Boolean)
    .join(', ');
}

/**
 * Görsel adresi.
 *
 * Yer tutucu görsel bir `data:` URI'sidir (renderer.js > svgGorsel); binlerce
 * satırlık bir dökümde her hücreye gömülmesi dosyayı megabaytlarca şişirir ve
 * hiçbir işe yaramaz. Boş bırakılır.
 */
function xlsGorselYazi(u) {
  const g = String(u.gorsel || '');
  return (!g || g.indexOf('data:') === 0) ? '' : g;
}

/** Tek ürünü döküm satırına çevirir. */
function xlsDokumSatiri(u) {
  return [
    xlsGorselYazi(u),
    String(u.ad || ''),
    (u.kod && u.kod !== '-') ? String(u.kod) : '',
    Number(u.fiyat) || 0,
    Number(u.stok) || 0,
    xlsKategoriYazi(u),
    u.durum === 'publish' ? 'Yayında' : 'Gizli'
  ];
}

/** EXCEL DÖKÜMÜ AL — kataloğu .xlsx olarak kaydettirir. */
async function xlsDokumAl() {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  const urunler = (d && d.urunler) || [];

  if (!urunler.length) {
    bildir('Dökümü alınacak ürün yok.\nÖnce YENİLE ile ürünleri getirin.', 'uyari');
    return;
  }

  /* Liste eksik geldiyse (sayfalama yarıda kaldı) kullanıcı dökümün de
     eksik olacağını BAŞTAN bilmeli; sonradan fark edilen eksik döküm,
     yanlış fiyat listesi basılması demektir. */
  const magaza = Number(d.urunlerToplam) || urunler.length;
  if (magaza > urunler.length) {
    const surdur = await onayla(
      'Liste Eksik',
      'Mağazanızda ' + magaza + ' ürün var ama şu an hafızada ' + urunler.length + ' tanesi yüklü.\n\n' +
      'Döküm yalnızca yüklü ürünleri içerecek.\n' +
      'Tam döküm için önce YENİLE ile listenin tamamını getirin.',
      'YİNE DE AL',
      false
    );
    if (!surdur) return;
  }

  const buton = $('#urunExcelIndirBtn');
  const geriAl = buton ? butonuMesgulEt(buton, 'HAZIRLANIYOR…') : function () {};

  try {
    const cevap = await ipcRenderer.invoke('excel:disaAktar', {
      dosyaAdi: 'Urun-Dokumu-' + xlsTarihEki(),
      sayfaAdi: 'Ürün Dökümü',
      sutunlar: XLS_DOKUM_SUTUNLARI.map(function (s) {
        return { baslik: s.baslik, tur: s.tur, genislik: s.genislik };
      }),
      satirlar: urunler.map(xlsDokumSatiri)
    });

    if (!cevap) { bildir('Excel dökümü alınamadı.', 'hata'); return; }
    if (cevap.iptal) return;

    if (!cevap.ok) {
      bildir(cevap.hata || 'Excel dökümü alınamadı.', 'hata');
      return;
    }

    bildir('Excel dökümü hazır.\n' + urunler.length + ' ürün yazıldı.\n' + cevap.yol, 'basari');
  } finally {
    geriAl();
  }
}

/* ==========================================================================
 *  BÖLÜM B — SÜTUN EŞLEŞTİRME SİHİRBAZI
 * ========================================================================*/

/**
 * Panelin hedef alanları.
 *
 *  zorunlu   → eşleştirilmeden içe aktarma başlatılamaz
 *  anahtar   → eşleştirme bu alana göre yapılır (SKU)
 *  anahtarlar→ otomatik tanıma sözlüğü (SADELEŞTİRİLMİŞ yazımla)
 */
const XLS_ALANLARI = [
  {
    kod: 'ad', etiket: 'Ürün Adı', zorunlu: false,
    ipucu: 'Yeni ürün oluşturmak için gerekli; eşleşen ürünlerde başlığı günceller.',
    anahtarlar: ['urun adi', 'urun ismi', 'urun adi aciklama', 'malzeme adi', 'stok adi', 'mal adi',
                 'product name', 'urun', 'product', 'name', 'title', 'baslik', 'tanim', 'aciklama',
                 'ad', 'adi', 'isim']
  },
  {
    kod: 'kod', etiket: 'SKU / Barkod', zorunlu: true, anahtar: true,
    ipucu: 'Eşleştirme anahtarı. Bu sütun olmadan içe aktarma yapılamaz.',
    anahtarlar: ['stok kodu', 'urun kodu', 'malzeme kodu', 'sku barkod', 'barkod no', 'barkod',
                 'barcode', 'sku', 'stok kod', 'urun kod', 'referans', 'kod', 'code', 'ref']
  },
  {
    kod: 'fiyat', etiket: 'Liste Fiyatı', zorunlu: false,
    ipucu: 'Ürünün liste (indirimsiz) fiyatı. Boş bırakılan satırlarda fiyata dokunulmaz.',
    anahtarlar: ['liste fiyati', 'satis fiyati', 'birim fiyat', 'list price', 'unit price',
                 'fiyati', 'fiyat', 'price', 'tutar', 'bedel']
  },
  {
    kod: 'stok', etiket: 'Stok Adedi', zorunlu: false,
    ipucu: 'Depodaki adet. Boş bırakılan satırlarda stoğa dokunulmaz.',
    anahtarlar: ['stok adedi', 'stok miktari', 'depo adedi', 'mevcut stok', 'kalan adet',
                 'stok', 'adet', 'miktar', 'quantity', 'stock', 'qty', 'mevcut']
  },
  {
    kod: 'kategori', etiket: 'Kategori', zorunlu: false, istege: true,
    ipucu: 'Yalnızca YENİ ürünlerde kullanılır. Bulunmayan kategori oluşturulur.',
    anahtarlar: ['urun grubu', 'kategori adi', 'kategori', 'category', 'grup', 'group', 'sinif', 'tur']
  },
  {
    kod: 'gorsel', etiket: 'Görsel URL', zorunlu: false, istege: true,
    ipucu: 'Yalnızca YENİ ürünlerde kullanılır. İnternetten erişilebilir bir adres olmalı.',
    anahtarlar: ['urun gorseli url', 'gorsel url', 'resim url', 'image url', 'foto url',
                 'gorsel', 'resim', 'image', 'picture', 'fotograf', 'foto', 'img', 'url']
  }
];

/**
 * Bir Excel başlığının bir alana ne kadar uyduğunu puanlar.
 *
 * Puan iki şeyden gelir:
 *   · eşleşmenin YERİ  — tam eşleşme > sözcük başı/sonu > sözcük içi,
 *   · anahtarın UZUNLUĞU — "Stok Kodu" başlığı hem "stok" (Stok Adedi) hem
 *     "stok kodu" (SKU) sözlüğüne uyar; daha uzun ve daha özgül olan kazanır.
 *
 * Sözcük sınırı denetimleri `slice` ile yapılır. Daha önce `indexOf`
 * karşılaştırmasıyla yapılıyordu ve anahtar hiç geçmediğinde dönen -1,
 * başlıkla anahtar AYNI UZUNLUKTAYSA beklenen konumla (-1) çakışıp yanlış
 * eşleşme üretiyordu: "Sütun A" (7 harf) başlığı "product" (7 harf)
 * anahtarına takılıp Ürün Adı sanılıyordu.
 */
function xlsPuan(alan, sadeBaslik) {
  if (!sadeBaslik) return 0;

  let enIyi = 0;

  alan.anahtarlar.forEach(function (anahtar) {
    let puan = 0;
    const fark = sadeBaslik.length - anahtar.length;

    if (sadeBaslik === anahtar) {
      puan = 1000 + anahtar.length;                                        // birebir
    } else if (fark > 0 && sadeBaslik.slice(0, anahtar.length + 1) === anahtar + ' ') {
      puan = 500 + anahtar.length;                                         // başta, sözcük sonu
    } else if (fark > 0 && sadeBaslik.slice(fark - 1) === ' ' + anahtar) {
      puan = 400 + anahtar.length;                                         // sonda, sözcük başı
    } else if (sadeBaslik.indexOf(' ' + anahtar + ' ') !== -1) {
      puan = 300 + anahtar.length;                                         // ortada, tam sözcük
    } else if (sadeBaslik.indexOf(anahtar) !== -1) {
      puan = 100 + anahtar.length;                                         // sözcük içinde
    }

    if (puan > enIyi) enIyi = puan;
  });

  return enIyi;
}

/**
 * Otomatik tanıma (smart match).
 *
 * Açgözlü ama GLOBAL: bütün (alan, başlık) çiftleri puanlanır, en yüksek
 * puandan başlanarak eşleştirilir ve bir başlık ikinci kez kullanılmaz.
 * Sıralı (alan alan) eşleştirme, "Stok Kodu"nu ilk gördüğü Stok alanına
 * kaptırırdı.
 */
function xlsOtomatikEsle(basliklar) {
  const sade = basliklar.map(xlsSadelestir);
  const adaylar = [];

  XLS_ALANLARI.forEach(function (alan) {
    sade.forEach(function (b, i) {
      const puan = xlsPuan(alan, b);
      if (puan > 0) adaylar.push({ alan: alan.kod, sutun: i, puan: puan });
    });
  });

  adaylar.sort(function (a, b) { return b.puan - a.puan; });

  const esleme = Object.create(null);
  const kullanilan = Object.create(null);

  XLS_ALANLARI.forEach(function (a) { esleme[a.kod] = -1; });

  adaylar.forEach(function (c) {
    if (esleme[c.alan] !== -1 || kullanilan[c.sutun]) return;
    esleme[c.alan] = c.sutun;
    kullanilan[c.sutun] = true;
  });

  return esleme;
}

/** Eşleştirme açılır kutularını çizer. */
function xlsEslestirmeCiz() {
  const kap = $('#excelEsleme');
  if (!kap) return;

  kap.innerHTML = XLS_ALANLARI.map(function (alan, sira) {
    const secili = XLS.esleme[alan.kod];

    const secenekler = ['<option value="-1">— Kullanma —</option>'].concat(
      XLS.basliklar.map(function (b, i) {
        return '<option value="' + i + '"' + (i === secili ? ' selected' : '') + '>' +
               kacis(xlsSutunEtiketi(i) + ' · ' + b) + '</option>';
      })
    ).join('');

    const otomatikMi = XLS.otomatik[alan.kod] && secili >= 0;

    return '' +
      '<label class="block rounded-2xl p-4 border-2 ' +
             (otomatikMi
               ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/5'
               : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40') + '">' +

        '<span class="flex items-center gap-2 text-lg font-extrabold">' +
          '<span class="w-7 h-7 shrink-0 grid place-items-center rounded-lg bg-slate-200 dark:bg-slate-700 ' +
                'text-sm font-black">' + (sira + 1) + '</span>' +
          kacis(alan.etiket) +
          (alan.zorunlu ? '<span class="text-red-600" title="Zorunlu alan">*</span>' : '') +
          (alan.istege ? '<span class="text-sm font-bold text-slate-400">(isteğe bağlı)</span>' : '') +
          (otomatikMi
            ? '<span class="ml-auto text-sm font-black text-emerald-700 dark:text-emerald-300">' +
                ikon('onay', 'ik-sm') + ' otomatik' +
              '</span>'
            : '') +
        '</span>' +

        '<span class="block text-sm font-semibold text-slate-500 dark:text-slate-400 mt-1">' +
          kacis(alan.ipucu) +
        '</span>' +

        '<select data-xls-alan="' + alan.kod + '" ' +
                'class="w-full h-14 px-4 mt-3 rounded-xl text-lg font-bold ' +
                       'bg-white dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-600 ' +
                       'focus:border-marka-600 outline-none transition">' +
          secenekler +
        '</select>' +
      '</label>';
  }).join('');
}

/** 0 → "A", 26 → "AA" (Excel sütun harfi). */
function xlsSutunEtiketi(indeks) {
  let s = '';
  let n = indeks;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Dosyanın ilk satırlarını küçük bir tabloda gösterir. */
function xlsOnizlemeCiz() {
  const kap = $('#excelOnizleme');
  if (!kap) return;

  /* Hangi sütun hangi alana bağlandı — başlığın altında rozet olarak. */
  const tersEsleme = Object.create(null);
  XLS_ALANLARI.forEach(function (a) {
    const i = XLS.esleme[a.kod];
    if (i >= 0) tersEsleme[i] = a.etiket;
  });

  const baslikHtml = XLS.basliklar.map(function (b, i) {
    const bagli = tersEsleme[i];
    return '<th class="px-3 py-2 text-left align-top whitespace-nowrap ' +
                  (bagli ? 'bg-marka-700/10 dark:bg-marka-700/25' : '') + '">' +
             '<div class="text-xs font-black text-slate-400">' + xlsSutunEtiketi(i) + '</div>' +
             '<div class="font-extrabold">' + kacis(b) + '</div>' +
             (bagli
               ? '<div class="text-xs font-black text-marka-700 dark:text-marka-300">→ ' + kacis(bagli) + '</div>'
               : '<div class="text-xs font-bold text-slate-400">— kullanılmıyor</div>') +
           '</th>';
  }).join('');

  const govdeHtml = XLS.satirlar.slice(0, XLS_ONIZLEME).map(function (satir) {
    return '<tr class="border-t-2 border-slate-200 dark:border-slate-700">' +
      XLS.basliklar.map(function (b, i) {
        const deger = xlsHucre(satir, i);
        return '<td class="px-3 py-2 whitespace-nowrap ' +
                      (tersEsleme[i] ? 'bg-marka-700/5 dark:bg-marka-700/10 font-bold' : 'text-slate-500') + '">' +
               (deger ? kacis(deger.length > 42 ? (deger.slice(0, 42) + '…') : deger)
                      : '<span class="text-slate-400">—</span>') +
               '</td>';
      }).join('') +
    '</tr>';
  }).join('');

  kap.innerHTML =
    '<table class="w-full text-sm border-collapse">' +
      '<thead class="bg-slate-100 dark:bg-slate-900/60"><tr>' + baslikHtml + '</tr></thead>' +
      '<tbody>' + govdeHtml + '</tbody>' +
    '</table>';
}

/** Eşleştirme ekranındaki uyarıyı ve BAŞLAT düğmesinin durumunu tazeler. */
function xlsEslestirmeDenetle() {
  const uyari = $('#excelUyari');
  const baslat = $('#excelBaslatBtn');
  if (!uyari || !baslat) return true;

  const notlar = [];
  let engel = false;

  if (XLS.esleme.kod < 0) {
    notlar.push('SKU / Barkod sütunu seçilmeden içe aktarma yapılamaz: ürünler bu koda göre eşleştirilir.');
    engel = true;
  }

  const yazilacak = ['ad', 'fiyat', 'stok'].filter(function (k) { return XLS.esleme[k] >= 0; });

  if (!yazilacak.length) {
    notlar.push('Ürün Adı, Liste Fiyatı ve Stok Adedi sütunlarından en az biri seçilmeli; ' +
                'yoksa güncellenecek bir bilgi kalmıyor.');
    engel = true;
  }

  if (!engel && XLS.esleme.ad < 0) {
    notlar.push('Ürün Adı seçilmedi: dosyada olup sistemde OLMAYAN kodlar yeni ürün olarak ' +
                'eklenemez (ad zorunlu), yalnızca atlanır.');
  }

  if (XLS.kirpildi) {
    notlar.push('Dosya çok büyük olduğu için ilk ' + XLS_EN_FAZLA_SATIR +
                ' satır okundu. Kalanı ikinci bir dosyayla aktarabilirsiniz.');
  }

  uyari.classList.toggle('hidden', !notlar.length);
  uyari.innerHTML = notlar.map(function (n) { return '• ' + kacis(n); }).join('<br />');
  uyari.className = notlar.length
    ? ('rounded-xl p-4 text-base font-bold leading-relaxed ' +
       (engel
         ? 'bg-red-50 text-red-800 border-2 border-red-300 dark:bg-red-500/10 dark:text-red-200 dark:border-red-500/30'
         : 'bg-amber-50 text-amber-800 border-2 border-amber-300 dark:bg-amber-500/10 dark:text-amber-200 dark:border-amber-500/30'))
    : 'hidden';

  baslat.disabled = engel;
  baslat.classList.toggle('opacity-40', engel);
  baslat.classList.toggle('cursor-not-allowed', engel);

  return !engel;
}

/** Bir ögeyi gizler / gösterir (öge yoksa sessizce geçer). */
function xlsGoster(secici, gorunsunMu) {
  const el = $(secici);
  if (el) el.classList.toggle('hidden', !gorunsunMu);
}

/** Pencere başlığını yazar. */
function xlsBaslikYaz(metin) {
  const el = $('#excelModalBaslik');
  if (el) el.textContent = metin;
}

/** Sihirbazı eşleştirme aşamasına alır. */
function xlsAsamaEslestirme() {
  xlsGoster('#excelEslestirme', true);
  xlsGoster('#excelIlerleme', false);

  xlsGoster('#excelVazgecBtn', true);
  xlsGoster('#excelBaslatBtn', true);
  xlsGoster('#excelDurdurBtn', false);
  xlsGoster('#excelBitirBtn', false);

  xlsBaslikYaz('Sütun Eşleştirme');
}

/** Sihirbazı ilerleme aşamasına alır. */
function xlsAsamaIlerleme() {
  xlsGoster('#excelEslestirme', false);
  xlsGoster('#excelIlerleme', true);

  xlsGoster('#excelVazgecBtn', false);
  xlsGoster('#excelBaslatBtn', false);
  xlsGoster('#excelDurdurBtn', true);
  xlsGoster('#excelBitirBtn', false);

  xlsBaslikYaz('İçe Aktarılıyor');
}

function xlsModaliKapat() {
  const katman = $('#excelModalKatman');
  if (katman) katman.classList.add('hidden');
  XLS.durdur = true;
}

/** EXCEL YÜKLE — dosya seçtirir, okur ve sihirbazı açar. */
async function xlsIceAktarAc() {
  if (XLS.calisiyor) {
    bildir('Bir içe aktarma zaten sürüyor.', 'uyari');
    return;
  }

  const secim = await ipcRenderer.invoke('excel:dosyaSec');
  if (!secim || secim.iptal) return;

  if (!secim.ok) {
    bildir(secim.hata || 'Dosya seçilemedi.', 'hata');
    return;
  }

  const buton = $('#urunExcelYukleBtn');
  const geriAl = buton ? butonuMesgulEt(buton, 'OKUNUYOR…') : function () {};

  let cevap;
  try {
    cevap = await ipcRenderer.invoke('excel:tabloOku', {
      yol: secim.yol,
      enFazlaSatir: XLS_EN_FAZLA_SATIR
    });
  } finally {
    geriAl();
  }

  if (!cevap || !cevap.ok) {
    bildir((cevap && cevap.hata) || 'Dosya okunamadı.', 'hata');
    return;
  }

  if (!cevap.satirlar.length) {
    bildir('Dosyada başlık satırından sonra veri yok.\n' +
           'İlk satır sütun başlıkları, sonraki satırlar ürünler olmalı.', 'uyari');
    return;
  }

  XLS.yol = secim.yol;
  XLS.ad = secim.ad || '';
  XLS.bicim = cevap.bicim || '';
  XLS.basliklar = cevap.basliklar || [];
  XLS.satirlar = cevap.satirlar || [];
  XLS.kirpildi = !!cevap.kirpildi;
  XLS.durdur = false;

  XLS.esleme = xlsOtomatikEsle(XLS.basliklar);

  XLS.otomatik = Object.create(null);
  Object.keys(XLS.esleme).forEach(function (k) {
    if (XLS.esleme[k] >= 0) XLS.otomatik[k] = true;
  });

  const aciklama = $('#excelModalAciklama');
  if (aciklama) {
    aciklama.textContent =
      XLS.ad + '  ·  ' + XLS.satirlar.length + ' satır  ·  ' + XLS.basliklar.length + ' sütun' +
      (cevap.sayfaAdi ? ('  ·  “' + cevap.sayfaAdi + '”') : '');
  }

  xlsEslestirmeCiz();
  xlsOnizlemeCiz();
  xlsEslestirmeDenetle();
  xlsAsamaEslestirme();
  xlsGunlukTemizle();

  const katman = $('#excelModalKatman');
  if (katman) katman.classList.remove('hidden');
}

/* ==========================================================================
 *  BÖLÜM C — İÇE AKTARMA MOTORU
 * ========================================================================*/

/** İlerleme çubuğunu ve sayaçları çizer. */
function xlsIlerlemeCiz(islenen, toplam, sayac) {
  const yuzde = toplam > 0 ? Math.round((islenen / toplam) * 100) : 0;

  const metin = $('#excelIlerlemeMetin');
  if (metin) metin.textContent = islenen + ' / ' + toplam + ' ürün işlendi…  %' + yuzde;

  const cubuk = $('#excelIlerlemeCubuk');
  if (cubuk) cubuk.style.width = yuzde + '%';

  const yaz = function (secici, deger) {
    const el = $(secici);
    if (el) el.textContent = String(deger);
  };

  yaz('#excelSayacGuncel', sayac.guncel);
  yaz('#excelSayacYeni', sayac.yeni);
  yaz('#excelSayacAtlanan', sayac.atlanan);
  yaz('#excelSayacHata', sayac.hata);
}

function xlsGunlukTemizle() {
  const kap = $('#excelGunluk');
  if (kap) kap.innerHTML = '';
}

/** Günlüğe tek satır yazar (en fazla 300 satır tutulur). */
function xlsGunluk(metin, tur) {
  const kap = $('#excelGunluk');
  if (!kap) return;

  const renk = {
    guncel: 'text-marka-700 dark:text-marka-300',
    yeni: 'text-emerald-700 dark:text-emerald-300',
    atlanan: 'text-slate-500 dark:text-slate-400',
    hata: 'text-red-700 dark:text-red-300'
  }[tur] || '';

  const satir = document.createElement('div');
  satir.className = 'py-0.5 ' + renk;
  satir.textContent = metin;
  kap.appendChild(satir);

  while (kap.childElementCount > 300) kap.removeChild(kap.firstChild);

  kap.scrollTop = kap.scrollHeight;
}

/** Hafızadaki ürünlerden SKU → ürün dizini kurar (büyük/küçük harf duyarsız). */
function xlsSkuIndeksi() {
  const indeks = Object.create(null);
  const urunler = (typeof durum !== 'undefined' && durum && durum.urunler) || [];

  urunler.forEach(function (u) {
    const kod = String(u.kod || '').trim();
    if (kod && kod !== '-') indeks[kod.toLocaleUpperCase('tr-TR')] = u;
  });

  return indeks;
}

/** Kategori adı → kimlik dizini (sadeleştirilmiş adla). */
function xlsKategoriIndeksi() {
  const g = (typeof izg === 'function') ? izg() : null;
  const indeks = Object.create(null);

  ((g && g.kategoriler) || []).forEach(function (k) {
    const anahtar = xlsSadelestir(k.ad);
    if (anahtar) indeks[anahtar] = Number(k.id);
  });

  return indeks;
}

/**
 * Kategori kimliği bulur; yoksa oluşturur.
 * @returns {Promise<number>} 0 = bulunamadı / oluşturulamadı
 */
async function xlsKategoriBul(ad, indeks, sayac) {
  const anahtar = xlsSadelestir(ad);
  if (!anahtar) return 0;
  if (indeks[anahtar]) return indeks[anahtar];

  const g = (typeof izg === 'function') ? izg() : null;

  if (xlsDemoMu()) {
    const mevcut = ((g && g.kategoriler) || []).map(function (k) { return Number(k.id); });
    const yeniId = (mevcut.length ? Math.max.apply(null, mevcut) : 0) + 1;
    if (g) g.kategoriler.push({ id: yeniId, ad: ad, ust: 0, adet: 0 });
    indeks[anahtar] = yeniId;
    sayac.kategori++;
    return yeniId;
  }

  const cevap = await woo('products/categories', { metod: 'POST', govde: { name: ad }, sureAsimi: 20000 });

  if (cevap && cevap.ok && cevap.veri && cevap.veri.id) {
    const id = Number(cevap.veri.id);
    indeks[anahtar] = id;
    if (g) g.kategoriler.push({ id: id, ad: String(cevap.veri.name || ad), ust: 0, adet: 0 });
    sayac.kategori++;
    return id;
  }

  /* WooCommerce aynı adda kategori varsa "term_exists" der ve var olanın
     kimliğini gövdede döndürür; yeni kategori açmaya çalışmak yerine o
     kullanılır (yoksa her satırda yeniden denenirdi). */
  const varOlan = cevap && cevap.veri && cevap.veri.data && cevap.veri.data.resource_id;
  if (varOlan) {
    const id = Number(varOlan);
    indeks[anahtar] = id;
    return id;
  }

  return 0;
}

/** Sitede SKU'ya göre ürün arar (hafızadaki liste eksik olabilir). */
async function xlsUrunAra(sku) {
  const cevap = await woo('products', {
    sorgu: { sku: sku, per_page: 1, status: 'any' },
    sureAsimi: 20000
  });

  if (cevap && cevap.ok && Array.isArray(cevap.veri) && cevap.veri.length) return cevap.veri[0];
  return null;
}

/** Dosya satırını, panelin anladığı alanlara çevirir. */
function xlsSatiriCoz(satir) {
  const e = XLS.esleme;

  const fiyatYazi = xlsHucre(satir, e.fiyat);
  const stokYazi = xlsHucre(satir, e.stok);

  const fiyat = fiyatYazi === '' ? NaN : sayiCoz(fiyatYazi);
  const stok = stokYazi === '' ? NaN : sayiCoz(stokYazi);

  return {
    sku: xlsHucre(satir, e.kod),
    ad: xlsHucre(satir, e.ad),
    kategori: xlsHucre(satir, e.kategori),
    gorsel: xlsHucre(satir, e.gorsel),
    fiyat: (isFinite(fiyat) && !isNaN(fiyat) && fiyat >= 0) ? fiyat : null,
    stok: (isFinite(stok) && !isNaN(stok)) ? Math.round(stok) : null
  };
}

/**
 * Yerel listeyi güncel tutar.
 *
 * Demo kaynağı (DEMO_URUNLER) YALNIZCA demo modunda yazılır: canlı modda
 * bir ürün kimliği demo kataloğundaki bir kimlikle çakışabilir ve o zaman
 * müşterinin gerçek fiyatı demo verisinin üstüne yazılırdı.
 */
function xlsYereliGuncelle(u, yeni) {
  Object.keys(yeni).forEach(function (a) { u[a] = yeni[a]; });

  if (!xlsDemoMu()) return;

  const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
    .filter(function (x) { return String(x.id) === String(u.id); })[0];

  if (kaynak) Object.keys(yeni).forEach(function (a) { kaynak[a] = yeni[a]; });
}

/**
 * İÇE AKTARMAYI BAŞLAT.
 *
 * İstekler SIRAYLA gönderilir (toplu işlemlerde olduğu gibi): WooCommerce
 * eşzamanlı yazmada 429/500 döndürebiliyor ve yarısı uygulanmış bir aktarım,
 * hangi ürünün değiştiğini bilememek demek.
 */
async function xlsIceAktarBasla() {
  if (XLS.calisiyor) return;
  if (!xlsEslestirmeDenetle()) return;

  const toplam = XLS.satirlar.length;

  const onay = await onayla(
    'İçe Aktarmayı Onayla',
    toplam + ' satır işlenecek.\n\n' +
    'SKU\'su sistemde BULUNAN ürünlerin seçtiğiniz alanları güncellenecek,\n' +
    'BULUNMAYANLAR yeni ürün olarak eklenecek.\n\n' +
    'Bu işlem sitenizdeki ürünleri değiştirir ve geri alınamaz.' +
    (xlsDemoMu() ? '\n\n(Demo Modu: sitenizde değişiklik yapılmaz.)' : ''),
    'EVET, BAŞLAT',
    true
  );

  if (!onay) return;

  XLS.calisiyor = true;
  XLS.durdur = false;

  xlsAsamaIlerleme();
  xlsGunlukTemizle();

  const sayac = { guncel: 0, yeni: 0, atlanan: 0, hata: 0, kategori: 0 };
  xlsIlerlemeCiz(0, toplam, sayac);

  /* Kategori dizini önceden kurulur; her satırda kategori listesi çekmek
     900 ürünlük bir dosyada 900 gereksiz istek demekti. */
  const g = (typeof izg === 'function') ? izg() : null;
  if (g && !g.kategorilerYuklendi && typeof izgKategorileriYukle === 'function' && XLS.esleme.kategori >= 0) {
    await izgKategorileriYukle();
  }

  const skuIndeks = xlsSkuIndeksi();
  const katIndeks = xlsKategoriIndeksi();
  const gorulen = Object.create(null);   // aynı dosyada tekrarlanan SKU'lar

  const tamYuklendi = !!(typeof durum !== 'undefined' && durum && durum.urunlerTamYuklendi);
  const hatalar = [];

  for (let i = 0; i < toplam; i++) {
    if (XLS.durdur) {
      xlsGunluk('— Kullanıcı durdurdu —', 'atlanan');
      break;
    }

    const veri = xlsSatiriCoz(XLS.satirlar[i]);
    const satirNo = i + 2;   // dosyadaki gerçek satır (1 = başlık)

    if (!veri.sku) {
      sayac.atlanan++;
      xlsGunluk(satirNo + '. satır atlandı: SKU boş', 'atlanan');
      xlsIlerlemeCiz(i + 1, toplam, sayac);
      continue;
    }

    const anahtar = veri.sku.toLocaleUpperCase('tr-TR');

    if (gorulen[anahtar]) {
      sayac.atlanan++;
      xlsGunluk(satirNo + '. satır atlandı: “' + veri.sku + '” dosyada zaten geçti', 'atlanan');
      xlsIlerlemeCiz(i + 1, toplam, sayac);
      continue;
    }
    gorulen[anahtar] = true;

    try {
      let hedef = skuIndeks[anahtar] || null;

      /* Hafızadaki liste eksikse (süzgeç açık ya da sayfalama yarım kaldı)
         karar vermeden önce siteye sorulur; yoksa var olan bir ürün "yeni"
         sanılıp SKU çakışmasıyla reddedilirdi. */
      if (!hedef && !tamYuklendi && !xlsDemoMu()) {
        const uzak = await xlsUrunAra(veri.sku);
        if (uzak) {
          hedef = urunNormalle(uzak);
          skuIndeks[anahtar] = hedef;
        }
      }

      if (hedef) {
        const sonuc = await xlsUrunuGuncelle(hedef, veri);
        if (sonuc.ok) {
          if (sonuc.degisti) {
            sayac.guncel++;
            xlsGunluk('✓ ' + veri.sku + ' güncellendi — ' + sonuc.ozet, 'guncel');
          } else {
            sayac.atlanan++;
            xlsGunluk(satirNo + '. satır atlandı: ' + veri.sku + ' için yazılacak veri yok', 'atlanan');
          }
        } else {
          sayac.hata++;
          hatalar.push(veri.sku + ': ' + sonuc.hata);
          xlsGunluk('✕ ' + veri.sku + ' güncellenemedi — ' + sonuc.hata, 'hata');
        }
      } else if (!veri.ad) {
        sayac.atlanan++;
        xlsGunluk(satirNo + '. satır atlandı: ' + veri.sku + ' sistemde yok, ürün adı da boş', 'atlanan');
      } else {
        const sonuc = await xlsUrunEkle(veri, katIndeks, sayac);
        if (sonuc.ok) {
          sayac.yeni++;
          skuIndeks[anahtar] = sonuc.urun;
          xlsGunluk('+ ' + veri.sku + ' yeni ürün olarak eklendi — ' + veri.ad, 'yeni');
        } else {
          sayac.hata++;
          hatalar.push(veri.sku + ': ' + sonuc.hata);
          xlsGunluk('✕ ' + veri.sku + ' eklenemedi — ' + sonuc.hata, 'hata');
        }
      }
    } catch (e) {
      sayac.hata++;
      const metin = String((e && e.message) || e);
      hatalar.push(veri.sku + ': ' + metin);
      xlsGunluk('✕ ' + veri.sku + ' — ' + metin, 'hata');
    }

    xlsIlerlemeCiz(i + 1, toplam, sayac);
  }

  XLS.calisiyor = false;

  /* --- Bitiş --- */
  xlsBaslikYaz(XLS.durdur ? 'İçe Aktarma Durduruldu' : 'İçe Aktarma Tamamlandı');
  xlsGoster('#excelDurdurBtn', false);
  xlsGoster('#excelBitirBtn', true);

  const ozet =
    sayac.guncel + ' ürün güncellendi\n' +
    sayac.yeni + ' yeni ürün eklendi' +
    (sayac.kategori ? ('\n' + sayac.kategori + ' yeni kategori oluşturuldu') : '') +
    (sayac.atlanan ? ('\n' + sayac.atlanan + ' satır atlandı') : '') +
    (sayac.hata ? ('\n' + sayac.hata + ' satırda hata') : '');

  xlsGunluk('', '');
  xlsGunluk('═══ ÖZET ═══', '');
  ozet.split('\n').forEach(function (s) { xlsGunluk(s, ''); });

  bildir((XLS.durdur ? 'İçe aktarma durduruldu.\n\n' : 'İçe aktarma tamamlandı.\n\n') + ozet +
         (xlsDemoMu() ? '\n\n(Demo Modu)' : ''),
         sayac.hata ? 'uyari' : 'basari');

  /* Tabloyu siteden tazele: sunucu fiyatı biçimlendirmiş, SKU'yu
     benzersizleştirmiş ya da stok durumunu değiştirmiş olabilir. */
  if ((sayac.guncel || sayac.yeni) && typeof urunleriYukle === 'function') {
    await urunleriYukle('');
  }

  if (typeof izgKategoriAgaciCiz === 'function') izgKategoriAgaciCiz();
}

/**
 * Var olan ürünü günceller (yalnızca dosyada DOLU olan alanlar gönderilir).
 * @returns {Promise<{ok:boolean, degisti?:boolean, ozet?:string, hata?:string}>}
 */
async function xlsUrunuGuncelle(u, veri) {
  const govde = {};
  const ozet = [];
  const yerel = {};

  if (XLS.esleme.ad >= 0 && veri.ad && veri.ad !== u.ad) {
    govde.name = veri.ad;
    yerel.ad = veri.ad;
    ozet.push('ad');
  }

  if (XLS.esleme.fiyat >= 0 && veri.fiyat !== null && veri.fiyat !== u.fiyat) {
    govde.regular_price = veri.fiyat.toFixed(2);
    yerel.fiyat = veri.fiyat;
    ozet.push(paraSade(u.fiyat) + ' → ' + paraSade(veri.fiyat));
  }

  if (XLS.esleme.stok >= 0 && veri.stok !== null && veri.stok !== u.stok) {
    govde.stock_quantity = veri.stok;
    govde.manage_stock = true;
    yerel.stok = veri.stok;
    ozet.push('stok ' + u.stok + ' → ' + veri.stok);
  }

  if (!Object.keys(govde).length) return { ok: true, degisti: false };

  if (xlsDemoMu()) {
    await bekle(20);
    xlsYereliGuncelle(u, yerel);
    return { ok: true, degisti: true, ozet: ozet.join(', ') };
  }

  const cevap = await woo('products/' + u.id, { metod: 'PUT', govde: govde, sureAsimi: 30000 });

  if (!cevap || !cevap.ok) {
    return { ok: false, hata: (cevap && cevap.hata) ? String(cevap.hata).split('\n')[0] : 'bilinmeyen hata' };
  }

  xlsYereliGuncelle(u, yerel);
  return { ok: true, degisti: true, ozet: ozet.join(', ') };
}

/**
 * Yeni ürün ekler.
 *
 * Kategori ve görsel YALNIZCA burada kullanılır; var olan ürünlerde bu iki
 * alana dokunulmaz (bkz. sihirbazdaki ipuçları). Böylece fiyat listesi
 * güncellemek için atılan bir dosya, elle düzenlenmiş kategori ve görselleri
 * silip süpürmez.
 */
async function xlsUrunEkle(veri, katIndeks, sayac) {
  let kategoriId = 0;
  if (XLS.esleme.kategori >= 0 && veri.kategori) {
    kategoriId = await xlsKategoriBul(veri.kategori, katIndeks, sayac);
  }

  if (xlsDemoMu()) {
    await bekle(20);

    const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : []);
    const idler = kaynak.map(function (x) { return Number(x.id) || 0; });
    const yeniId = (idler.length ? Math.max.apply(null, idler) : 900) + 1;

    const g = (typeof izg === 'function') ? izg() : null;
    const kat = kategoriId
      ? ((g && g.kategoriler) || []).filter(function (k) { return Number(k.id) === kategoriId; })[0]
      : null;

    const yeni = {
      id: yeniId,
      ad: veri.ad,
      kod: veri.sku,
      barkod: veri.sku,
      fiyat: veri.fiyat === null ? 0 : veri.fiyat,
      stok: veri.stok === null ? 0 : veri.stok,
      durum: 'publish',
      indirimliFiyat: '',
      koliAdedi: 1,
      menuSira: 0,
      gorsel: veri.gorsel || (typeof YEDEK_GORSEL !== 'undefined' ? YEDEK_GORSEL : ''),
      kategoriler: kat ? [{ id: kat.id, ad: kat.ad }] : []
    };

    kaynak.unshift(yeni);
    if (typeof durum !== 'undefined' && durum) durum.urunler.unshift(Object.assign({}, yeni));

    return { ok: true, urun: yeni };
  }

  const govde = {
    name: veri.ad,
    type: 'simple',
    status: 'publish',
    sku: veri.sku,
    manage_stock: true,
    stock_quantity: veri.stok === null ? 0 : veri.stok
  };

  if (veri.fiyat !== null) govde.regular_price = veri.fiyat.toFixed(2);
  if (kategoriId) govde.categories = [{ id: kategoriId }];
  if (veri.gorsel && /^https?:\/\//i.test(veri.gorsel)) govde.images = [{ src: veri.gorsel }];

  const cevap = await woo('products', { metod: 'POST', govde: govde, sureAsimi: 60000 });

  if (cevap && cevap.ok && cevap.veri && cevap.veri.id) {
    return { ok: true, urun: urunNormalle(cevap.veri) };
  }

  /* SKU çakışması: ürün aslında SİTEDE var ama hafızadaki listede yoktu.
     Yeni kayıt açmak yerine var olanı bulup güncellemek doğru davranış. */
  const kod = (cevap && cevap.kod) || '';
  if (kod === 'product_invalid_sku' || kod === 'woocommerce_product_invalid_sku') {
    const uzak = await xlsUrunAra(veri.sku);
    if (uzak) {
      const u = urunNormalle(uzak);
      const sonuc = await xlsUrunuGuncelle(u, veri);
      if (sonuc.ok) return { ok: true, urun: u };
      return { ok: false, hata: sonuc.hata };
    }
  }

  return { ok: false, hata: (cevap && cevap.hata) ? String(cevap.hata).split('\n')[0] : 'bilinmeyen hata' };
}

/* ==========================================================================
 *  BÖLÜM D — OLAY BAĞLANTILARI
 * ========================================================================*/

function xlsOlaylariBagla() {
  const bolum = $('#sekme-urunler');
  if (!bolum || bolum.dataset.xlsBagli === '1') return;
  bolum.dataset.xlsBagli = '1';

  const bagla = function (secici, islev) {
    const el = $(secici);
    if (el) el.addEventListener('click', islev);
  };

  bagla('#urunExcelIndirBtn', xlsDokumAl);
  bagla('#urunExcelYukleBtn', xlsIceAktarAc);

  /* --- Sihirbaz --- */
  const esleme = $('#excelEsleme');
  if (esleme) {
    esleme.addEventListener('change', function (o) {
      const kutu = o.target.closest ? o.target.closest('[data-xls-alan]') : null;
      if (!kutu) return;

      const alan = kutu.getAttribute('data-xls-alan');
      const yeni = Number(kutu.value);

      /* Bir Excel sütunu iki alana birden bağlanamaz: aksi hâlde aynı
         sütun hem ad hem fiyat olur ve içe aktarma sessizce saçmalar. */
      if (yeni >= 0) {
        Object.keys(XLS.esleme).forEach(function (k) {
          if (k !== alan && XLS.esleme[k] === yeni) XLS.esleme[k] = -1;
        });
      }

      XLS.esleme[alan] = yeni;
      XLS.otomatik = Object.create(null);   // elle değiştirildi; rozetler kalksın

      xlsEslestirmeCiz();
      xlsOnizlemeCiz();
      xlsEslestirmeDenetle();
    });
  }

  bagla('#excelBaslatBtn', xlsIceAktarBasla);
  bagla('#excelVazgecBtn', xlsModaliKapat);
  bagla('#excelBitirBtn', xlsModaliKapat);
  bagla('#excelKapatBtn', function () {
    if (XLS.calisiyor) { XLS.durdur = true; return; }
    xlsModaliKapat();
  });

  bagla('#excelDurdurBtn', function () {
    XLS.durdur = true;
    xlsGunluk('Durdurma isteği alındı; sıradaki satırdan sonra duracak…', 'atlanan');
  });

  const katman = $('#excelModalKatman');
  if (katman) {
    katman.addEventListener('mousedown', function (o) {
      /* Aktarım sürerken dışarı tıklamak pencereyi kapatmasın: kullanıcı
         ilerlemeyi kaybettiğini sanır. */
      if (o.target === katman && !XLS.calisiyor) xlsModaliKapat();
    });
  }

  document.addEventListener('keydown', function (o) {
    if (o.key !== 'Escape') return;
    const k = $('#excelModalKatman');
    if (!k || k.classList.contains('hidden')) return;
    if (XLS.calisiyor) { XLS.durdur = true; return; }
    xlsModaliKapat();
  });
}

/* ==========================================================================
 *  BÖLÜM E — MEVCUT AKIŞA BAĞLANMA
 *  --------------------------------------------------------------------------
 *  renderer-izgara.js'teki `izgOlaylariBagla` sarmalanır: ürün sekmesi ilk
 *  açıldığında Excel düğmeleri de bağlanır. Sarma İDEMPOTENTTİR.
 * ========================================================================*/

(function xlsBagla() {
  if (typeof izgOlaylariBagla === 'function' && !izgOlaylariBagla.xlsSarildi) {
    const eskisi = izgOlaylariBagla;

    izgOlaylariBagla = function () {
      eskisi.apply(this, arguments);
      xlsOlaylariBagla();
    };

    izgOlaylariBagla.xlsSarildi = true;
    return;
  }

  /* Izgara dosyası bir sebeple yüklenmediyse düğmeler yine de çalışsın. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', xlsOlaylariBagla);
  } else {
    xlsOlaylariBagla();
  }
}());
