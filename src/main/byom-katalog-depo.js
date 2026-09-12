/* ============================================================================
 *  BYOM — ÇEVRİMDIŞI KATALOG DEPOSU (src/main/byom-katalog-depo.js)
 *  ---------------------------------------------------------------------------
 *  Plasiyer sahada internetsiz çalışır. Bu modül ürün kataloğunu diske yazar
 *  ve SKU / barkod / ad üzerinde bellekte indeks tutarak milisaniyelik arama
 *  verir.
 *
 *  NEDEN SQLite DEĞİL — bilinçli sapma:
 *  Şartname "hızlı SQLite **veya** hafif indeksli depolama" diyordu; ikinci
 *  yol seçildi. Sebepleri:
 *    · Panelin çalışma zamanı bağımlılığı tek kalemdir (electron-updater).
 *      `better-sqlite3` yerel (native) bir modüldür; her Electron sürümünde
 *      yeniden derlenmesi gerekir ve electron-builder yapılandırmasına
 *      ek yük bindirir. Aynı ilke `byom-excel.js`'te de geçerli: Excel
 *      motoru harici bağımlılık olmadan yazıldı.
 *    · Katalog büyüklüğü bir toptancıda binlerce satırdır, milyonlarca değil.
 *      Tamamı belleğe sığar; indeks Map/Set ile O(1) çalışır.
 *    · Dosya JSON olduğu için destek isteyen müşteride gözle okunabilir.
 *  Bu yüzden dosya adı `katalog.json`'dur — şartnamedeki `katalog.db` adı
 *  SQLite varsayıyordu; uzantıyı gerçeğe uydurmak, ileride dosyayı açan
 *  birinin "bu neden SQLite değil" diye şaşırmasını önler.
 *
 *  ARAMA SÖZLEŞMESİ:
 *   1. SKU ve barkod TAM eşleşme ile indeksten gelir (tek Map okuması).
 *   2. Ad aramasında Türkçe harfler normalize edilir: "SİLİKON" yazan ürün
 *      "silikon" aramasında da bulunur. Normalize edilmezse İ/ı ayrımı
 *      yüzünden aramanın yarısı sonuç vermez.
 *   3. Sonuçlarda SPOT ürünler kategorisinin en tepesine sabitlenir.
 *
 *  TEST EDİLEBİLİRLİK: Electron'a bağımlılık `kur({ dizin })` ile aşılabilir;
 *  dizin verilmezse `app.getPath('userData')` kullanılır. Böylece modül düz
 *  `node --test` altında gerçek disk davranışıyla ölçülebilir.
 * ==========================================================================*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Depo dosyasının adı. */
const DOSYA = 'katalog.json';

/** Veri dizininin adı (userData altında). */
const DIZIN = 'byom-data';

/** Şema sürümü — alan adları değişirse artırılır, eski dosya yok sayılır. */
const SEMA = 1;

/** Tek aramada dönebilecek en çok sonuç (arayüz sanallaştırması için yeter). */
const EN_COK_SONUC = 500;

/* ==========================================================================
 *  DURUM
 * ========================================================================*/

let veriDizini = '';          // kur() ile verilir ya da app'ten okunur
let urunler = [];             // normalize edilmiş ürün kayıtları
let sonGuncelleme = '';       // ISO zaman

/* İndeksler — hepsi urunler dizisindeki KONUMU tutar, nesneyi değil. */
const skuIndeks = new Map();      // 'ABC-1'      -> konum
const barkodIndeks = new Map();   // '869...'     -> konum
const adIndeks = new Map();       // 'silikon'    -> Set(konum)
const kimlikIndeks = new Map();   // 12           -> konum
const kategoriIndeks = new Map(); // 'Kimyasallar'-> Set(konum)

/* ==========================================================================
 *  METİN NORMALİZASYONU
 * ========================================================================*/

/** Türkçe harfleri ASCII'ye indirir ve küçültür. */
function normalize(ham) {
  return String(ham === null || ham === undefined ? '' : ham)
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .replace(/Ş/g, 's').replace(/ş/g, 's')
    .replace(/Ğ/g, 'g').replace(/ğ/g, 'g')
    .replace(/Ü/g, 'u').replace(/ü/g, 'u')
    .replace(/Ö/g, 'o').replace(/ö/g, 'o')
    .replace(/Ç/g, 'c').replace(/ç/g, 'c')
    .toLowerCase()
    .trim();
}

/** Addan arama jetonları üretir (2+ karakter). */
function jetonlar(ad) {
  return normalize(ad)
    .split(/[^a-z0-9]+/)
    .filter(function (j) { return j.length >= 2; });
}

/* ==========================================================================
 *  KURULUM
 * ========================================================================*/

/** Veri dizinini çözer. Electron yoksa kur({ dizin }) zorunludur. */
function dizinCoz() {
  if (veriDizini) return veriDizini;

  try {
    const { app } = require('electron');
    veriDizini = path.join(app.getPath('userData'), DIZIN);
  } catch (e) {
    veriDizini = '';
  }

  return veriDizini;
}

function dosyaYolu() {
  const d = dizinCoz();
  return d ? path.join(d, DOSYA) : '';
}

/**
 * Depoyu açar: dizini oluşturur, varsa dosyayı okur ve indeksleri kurar.
 *
 * @param {object} secenek { dizin } — test ve taşıma için.
 * @returns {object} { ok, urun, sonGuncelleme }
 */
function kur(secenek) {
  secenek = secenek || {};

  if (secenek.dizin) veriDizini = String(secenek.dizin);

  const d = dizinCoz();

  if (d) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* izin yok: bellekte çalışır */ }
  }

  yukle();

  return { ok: true, urun: urunler.length, sonGuncelleme: sonGuncelleme };
}

/* ==========================================================================
 *  DİSK
 * ========================================================================*/

function yukle() {
  urunler = [];
  sonGuncelleme = '';

  const yol = dosyaYolu();

  if (!yol) {
    indeksleriKur();
    return;
  }

  try {
    const ham = JSON.parse(fs.readFileSync(yol, 'utf8'));

    /* Şema sürümü uyuşmazsa dosya YOK SAYILIR: yarı okunmuş bir kayıt
       sessizce yanlış fiyat göstermekten iyidir; ilk eşitlemede dolar. */
    if (!ham || SEMA !== Number(ham.sema) || !Array.isArray(ham.urunler)) {
      indeksleriKur();
      return;
    }

    urunler = ham.urunler.map(normalizeKayit);
    sonGuncelleme = String(ham.sonGuncelleme || '');
  } catch (e) {
    urunler = [];   // dosya yok / bozuk
  }

  indeksleriKur();
}

function kaydet() {
  const yol = dosyaYolu();

  if (!yol) return false;

  try {
    const govde = JSON.stringify({ sema: SEMA, sonGuncelleme: sonGuncelleme, urunler: urunler });

    /* Önce geçici dosyaya, sonra yerine taşı: yazma sırasında elektrik
       giderse eski katalog sağlam kalır, yarım JSON oluşmaz. */
    const gecici = yol + '.tmp';

    fs.writeFileSync(gecici, govde, 'utf8');
    fs.renameSync(gecici, yol);

    return true;
  } catch (e) {
    return false;
  }
}

/* ==========================================================================
 *  KAYIT NORMALİZASYONU
 * ========================================================================*/

/** Ham REST ürününü (ya da diskten okunan kaydı) tek biçimli kayda çevirir. */
function normalizeKayit(ham) {
  ham = ham || {};

  const byom = ham.byom || {};

  /*
   * Koli içi adedi SUNUCUDAN gelir (b2b_get_box_quantity). Sahada on üç ayrı
   * meta adı altında durabiliyor; o listeyi panelde tekrar etmek aynı kuralın
   * iki yerde yaşaması demek olurdu.
   */
  let koli = Number(ham.koli_ici_adet !== undefined ? ham.koli_ici_adet : byom.koliIciAdet);

  if (!isFinite(koli) || koli < 1) koli = 1;

  const kategoriler = Array.isArray(ham.categories)
    ? ham.categories.map(function (k) { return typeof k === 'string' ? k : String((k && k.name) || ''); }).filter(Boolean)
    : [];

  const gorselAdres = ham.image_url
    || (Array.isArray(ham.images) && ham.images.length ? String(ham.images[0].src || '') : '');

  return {
    id: Number(ham.id) || 0,
    name: String(ham.name || ''),
    sku: String(ham.sku || ''),
    barcode: String(ham.barcode !== undefined ? ham.barcode : (byom.barkod || '')),
    price: Number(ham.price) || 0,
    stock_quantity: ham.stock_quantity === null || ham.stock_quantity === undefined ? null : Number(ham.stock_quantity),
    koli_ici_adet: Math.floor(koli),
    categories: kategoriler,
    image_url: String(gorselAdres || ''),
    local_image_path: String(ham.local_image_path || ''),
    is_spot: !!(ham.is_spot !== undefined ? ham.is_spot : byom.spot),
    updated_at: String(ham.updated_at || ham.date_modified || '')
  };
}

/* ==========================================================================
 *  İNDEKSLER
 * ========================================================================*/

function indeksleriKur() {
  skuIndeks.clear();
  barkodIndeks.clear();
  adIndeks.clear();
  kimlikIndeks.clear();
  kategoriIndeks.clear();

  for (let i = 0; i < urunler.length; i++) {
    const u = urunler[i];

    kimlikIndeks.set(u.id, i);

    if (u.sku) skuIndeks.set(normalize(u.sku), i);
    if (u.barcode) barkodIndeks.set(normalize(u.barcode), i);

    jetonlar(u.name).forEach(function (j) {
      let kume = adIndeks.get(j);
      if (!kume) { kume = new Set(); adIndeks.set(j, kume); }
      kume.add(i);
    });

    u.categories.forEach(function (k) {
      let kume = kategoriIndeks.get(k);
      if (!kume) { kume = new Set(); kategoriIndeks.set(k, kume); }
      kume.add(i);
    });
  }
}

/* ==========================================================================
 *  ARAMA
 * ========================================================================*/

/** SPOT ürünler öne, sonra ada göre. */
function siralamaKarsilastir(a, b) {
  if (a.is_spot !== b.is_spot) return a.is_spot ? -1 : 1;
  return normalize(a.name).localeCompare(normalize(b.name), 'tr');
}

/**
 * Katalogda arar.
 *
 * @param {string} sorgu    SKU, barkod ya da ad parçası.
 * @param {object} secenek  { kategori, adet, yalnizSpot }
 * @returns {object[]} kayıtlar
 */
function ara(sorgu, secenek) {
  secenek = secenek || {};

  const adet = Math.min(EN_COK_SONUC, Math.max(1, Number(secenek.adet) || EN_COK_SONUC));
  const q = normalize(sorgu);

  let konumlar = null;   // null = tüm katalog

  if (q) {
    /* 1) TAM eşleşmeler — tek Map okuması, doğrusal tarama YOK. */
    const tam = [];

    if (skuIndeks.has(q)) tam.push(skuIndeks.get(q));
    if (barkodIndeks.has(q)) tam.push(barkodIndeks.get(q));

    /* 2) Ad jetonları. Çok kelimeli sorguda KESİŞİM alınır:
          "silikon seffaf" ikisini birden taşıyan ürünü bulur. */
    const parcalar = q.split(/[^a-z0-9]+/).filter(function (p) { return p.length >= 2; });

    let adKume = null;

    parcalar.forEach(function (p) {
      const bulunan = new Set();

      /* Önek eşleşmesi: "sili" -> "silikon". Jeton sayısı ürün sayısından
         çok daha azdır, bu yüzden jeton listesini taramak ucuzdur. */
      adIndeks.forEach(function (kume, jeton) {
        if (jeton.startsWith(p)) kume.forEach(function (k) { bulunan.add(k); });
      });

      if (null === adKume) {
        adKume = bulunan;
      } else {
        adKume = new Set([...adKume].filter(function (k) { return bulunan.has(k); }));
      }
    });

    konumlar = new Set(tam);

    if (adKume) adKume.forEach(function (k) { konumlar.add(k); });
  }

  /* 3) Kategori süzgeci — kesişim. */
  if (secenek.kategori) {
    const kat = kategoriIndeks.get(secenek.kategori) || new Set();

    konumlar = null === konumlar
      ? new Set(kat)
      : new Set([...konumlar].filter(function (k) { return kat.has(k); }));
  }

  let sonuc = null === konumlar
    ? urunler.slice()
    : [...konumlar].map(function (k) { return urunler[k]; });

  if (secenek.yalnizSpot) sonuc = sonuc.filter(function (u) { return u.is_spot; });

  sonuc.sort(siralamaKarsilastir);

  return sonuc.slice(0, adet);
}

/** Kimliğe göre tek ürün. */
function urunGetir(id) {
  const k = kimlikIndeks.get(Number(id));
  return undefined === k ? null : urunler[k];
}

/** Barkod ile tek ürün (el terminali / karekod okuyucu akışı). */
function barkodBul(barkod) {
  const k = barkodIndeks.get(normalize(barkod));
  return undefined === k ? null : urunler[k];
}

/** Kategori listesi — ürün sayısıyla, ada göre sıralı. */
function kategoriler() {
  const liste = [];

  kategoriIndeks.forEach(function (kume, ad) {
    liste.push({ ad: ad, adet: kume.size });
  });

  liste.sort(function (a, b) { return normalize(a.ad).localeCompare(normalize(b.ad), 'tr'); });

  return liste;
}

/** Depo künyesi (arayüzde "son eşitleme" göstergesi). */
function durum() {
  return {
    urun: urunler.length,
    kategori: kategoriIndeks.size,
    spot: urunler.filter(function (u) { return u.is_spot; }).length,
    sonGuncelleme: sonGuncelleme,
    dosya: dosyaYolu()
  };
}

/* ==========================================================================
 *  EŞİTLEME
 * ========================================================================*/

/**
 * Kataloğu sunucudan çeker ve diske yazar.
 *
 * `getirici` ENJEKTE EDİLİR: ağ katmanı bu modülün sorumluluğu değildir
 * (main.js REST köprüsünü verir, test sahte sayfalayıcı verir). Modül böylece
 * ağ olmadan gerçek disk davranışıyla ölçülebilir.
 *
 * @param {function} getirici  async (sayfa) => { ok, urunler[], devam }
 * @param {object}   secenek   { ilerleme }
 * @returns {Promise<object>} { ok, urun, eklenen, hata }
 */
async function kataloguGuncelle(getirici, secenek) {
  secenek = secenek || {};

  if ('function' !== typeof getirici) {
    return { ok: false, hata: 'Getirici verilmedi.', urun: urunler.length };
  }

  const toplanan = [];
  let sayfa = 1;

  /* Sonsuz döngü emniyeti: 200 sayfa × 100 ürün = 20.000 kalem. */
  for (; sayfa <= 200; sayfa++) {
    let cevap;

    try {
      cevap = await getirici(sayfa);
    } catch (e) {
      return { ok: false, hata: (e && e.message) || 'Katalog çekilemedi.', urun: urunler.length };
    }

    if (!cevap || !cevap.ok) {
      return { ok: false, hata: (cevap && cevap.hata) || 'Katalog çekilemedi.', urun: urunler.length };
    }

    const gelen = Array.isArray(cevap.urunler) ? cevap.urunler : [];

    gelen.forEach(function (u) { toplanan.push(normalizeKayit(u)); });

    if ('function' === typeof secenek.ilerleme) {
      try { secenek.ilerleme({ sayfa: sayfa, toplam: toplanan.length }); } catch (e) { /* yok say */ }
    }

    if (!cevap.devam || !gelen.length) break;
  }

  /*
   * BOŞ YANITI DEPOYA YAZMA. Sunucu geçici olarak boş liste döndürürse
   * (yetki sorunu, eklenti kapalı) sahadaki plasiyerin kataloğu silinmiş
   * olurdu — internetsiz kalan kişi elinde hiçbir ürün olmadan sahada kalır.
   */
  if (!toplanan.length) {
    return { ok: false, hata: 'Sunucudan ürün gelmedi; mevcut katalog korundu.', urun: urunler.length };
  }

  /* Daha önce indirilmiş yerel görsel yollarını KORU. */
  const eskiGorseller = new Map();

  urunler.forEach(function (u) {
    if (u.local_image_path) eskiGorseller.set(u.id, u.local_image_path);
  });

  toplanan.forEach(function (u) {
    if (!u.local_image_path && eskiGorseller.has(u.id)) u.local_image_path = eskiGorseller.get(u.id);
  });

  urunler = toplanan;
  sonGuncelleme = new Date().toISOString();

  indeksleriKur();
  kaydet();

  return { ok: true, urun: urunler.length, eklenen: toplanan.length, sonGuncelleme: sonGuncelleme };
}

/** Tek ürünün yerel görsel yolunu yazar (indirici çağırır). */
function gorselYoluYaz(id, yerelYol) {
  const u = urunGetir(id);

  if (!u) return false;

  u.local_image_path = String(yerelYol || '');

  return kaydet();
}

/** Yerel görseli olmayan, ama uzak adresi olan ürünler (indirme kuyruğu girdisi). */
function gorselsizUrunler(adet) {
  const sinir = Math.max(1, Number(adet) || 200);
  const liste = [];

  for (let i = 0; i < urunler.length && liste.length < sinir; i++) {
    const u = urunler[i];
    if (u.image_url && !u.local_image_path) liste.push({ id: u.id, adres: u.image_url });
  }

  return liste;
}

/** Testlerin kullandığı sıfırlama. */
function sifirla() {
  urunler = [];
  sonGuncelleme = '';
  indeksleriKur();
}

module.exports = {
  kur,
  ara,
  urunGetir,
  barkodBul,
  kategoriler,
  durum,
  kataloguGuncelle,
  gorselYoluYaz,
  gorselsizUrunler,
  kaydet,
  yukle,
  sifirla,
  /* Saf yardımcılar — test ve arayüz için: */
  normalize,
  jetonlar,
  normalizeKayit,
  dosyaYolu,
  DOSYA,
  DIZIN,
  SEMA,
  EN_COK_SONUC
};
