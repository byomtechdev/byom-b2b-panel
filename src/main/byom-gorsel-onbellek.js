/* ============================================================================
 *  BYOM — GÖRSEL ÖNBELLEĞİ (src/main/byom-gorsel-onbellek.js)
 *  ---------------------------------------------------------------------------
 *  Ürün fotoğraflarını arka planda <userData>/byom-gorseller/ altına indirir.
 *  Plasiyer sahada internetsiz kaldığında vitrin, diskten gelen gerçek
 *  görsellerle çizilir.
 *
 *  TASARIM SÖZLERİ:
 *
 *   1) ARKA PLANDA, SIRAYLA, YAVAŞ. Eşzamanlı indirme EŞ_ZAMAN ile sınırlıdır
 *      (3). Yüzlerce görseli paralel çekmek müşteri sitesinin PHP işçilerini
 *      tüketir ve mağazayı yavaşlatır — plasiyerin kataloğu dolsun diye
 *      patronun sitesini yavaşlatmak kabul edilemez.
 *
 *   2) AYNI GÖRSEL İKİ KEZ İNDİRİLMEZ. Dosya adı adresin SHA-256 özetinden
 *      üretilir; dosya diskte varsa istek hiç atılmaz. Adres değişirse özet
 *      de değişir, yani yeni görsel kendiliğinden indirilir.
 *
 *   3) ARAYÜZE YEREL YOL GİDER. Renderer `file://` yolunu doğrudan kullanır;
 *      görseller IPC üzerinden base64 olarak taşınmaz (10 MB'lık bir katalog
 *      her çizimde belleği iki kez dolaşırdı).
 *
 *   4) HATA AKIŞI DURDURMAZ. Bir görsel inmezse sıradakine geçilir; kuyruk
 *      asla bir dosya yüzünden kilitlenmez. Süre aşımı 15 sn.
 * ==========================================================================*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Görsellerin yazıldığı dizin (userData altında). */
const DIZIN = 'byom-gorseller';

/** Aynı anda en çok kaç indirme. */
const ES_ZAMAN = 3;

/** Tek görsel için süre aşımı (ms). */
const SURE_ASIMI_MS = 15000;

/** Kabul edilen en büyük dosya (byte) — 8 MB. */
const EN_BUYUK = 8 * 1024 * 1024;

/** İzin verilen uzantılar; bilinmeyen tür `.jpg` sayılır. */
const UZANTILAR = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

let gorselDizini = '';

/** Bekleyen işler: { id, adres }. */
let kuyruk = [];

/** Şu an inen iş sayısı. */
let suren = 0;

/** Kuyruk çalışıyor mu? */
let calisiyor = false;

/** İndirme bitince çağrılır: (id, yerelYol) => void */
let bittiGeriCagir = null;

/** Sayaçlar (arayüzde "142/900 görsel" göstergesi). */
const sayac = { indirilen: 0, atlanan: 0, hatali: 0, toplam: 0 };

/* ==========================================================================
 *  DİZİN VE DOSYA ADI
 * ========================================================================*/

function dizinCoz() {
  if (gorselDizini) return gorselDizini;

  try {
    const { app } = require('electron');
    gorselDizini = path.join(app.getPath('userData'), DIZIN);
  } catch (e) {
    gorselDizini = '';
  }

  return gorselDizini;
}

/** Adresten uzantı çıkarır; tanınmayan tür `.jpg` olur. */
function uzanti(adres) {
  let u = '';

  try {
    u = path.extname(new URL(String(adres)).pathname).toLowerCase();
  } catch (e) {
    u = path.extname(String(adres).split('?')[0]).toLowerCase();
  }

  return UZANTILAR.indexOf(u) !== -1 ? u : '.jpg';
}

/**
 * Adresin yerel dosya adı.
 *
 * SHA-256 özeti kullanılır, ürün kimliği DEĞİL: aynı görseli paylaşan iki
 * ürün tek dosya tutar, ayrıca dosya adı kullanıcı verisinden gelmediği için
 * dizin dışına çıkma (path traversal) ihtimali yoktur.
 */
function dosyaAdi(adres) {
  const ozet = crypto.createHash('sha256').update(String(adres)).digest('hex').slice(0, 32);
  return ozet + uzanti(adres);
}

/** Adresin diskteki tam yolu (indirilmiş olsun ya da olmasın). */
function yerelYol(adres) {
  const d = dizinCoz();
  return d ? path.join(d, dosyaAdi(adres)) : '';
}

/** Görsel diskte var mı? */
function onbellekteMi(adres) {
  const y = yerelYol(adres);

  if (!y) return false;

  try {
    return fs.statSync(y).size > 0;
  } catch (e) {
    return false;
  }
}

/* ==========================================================================
 *  KURULUM
 * ========================================================================*/

/**
 * Önbelleği açar.
 *
 * @param {object} secenek { dizin, bitti } — test ve depo bağlantısı için.
 */
function kur(secenek) {
  secenek = secenek || {};

  if (secenek.dizin) gorselDizini = String(secenek.dizin);
  if ('function' === typeof secenek.bitti) bittiGeriCagir = secenek.bitti;

  const d = dizinCoz();

  if (d) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* izin yok */ }
  }

  return { ok: true, dizin: d };
}

/* ==========================================================================
 *  İNDİRME
 * ========================================================================*/

/**
 * Tek görseli indirir.
 *
 * @returns {Promise<object>} { ok, yol, atlandi, hata }
 */
async function indir(adres) {
  const hedef = yerelYol(adres);

  if (!hedef) return { ok: false, hata: 'Görsel dizini yok.' };

  /* Zaten varsa istek HİÇ atılmaz. */
  if (onbellekteMi(adres)) {
    sayac.atlanan++;
    return { ok: true, yol: hedef, atlandi: true };
  }

  const iptal = new AbortController();
  const saat = setTimeout(function () {
    try { iptal.abort(); } catch (e) { /* yok say */ }
  }, SURE_ASIMI_MS);

  if ('function' === typeof saat.unref) saat.unref();

  try {
    const cevap = await fetch(String(adres), { signal: iptal.signal });

    clearTimeout(saat);

    if (!cevap || !cevap.ok) {
      sayac.hatali++;
      return { ok: false, hata: 'HTTP ' + ((cevap && cevap.status) || 0) };
    }

    const tampon = Buffer.from(await cevap.arrayBuffer());

    if (!tampon.length) {
      sayac.hatali++;
      return { ok: false, hata: 'Boş yanıt.' };
    }

    if (tampon.length > EN_BUYUK) {
      sayac.hatali++;
      return { ok: false, hata: 'Görsel çok büyük (' + Math.round(tampon.length / 1024) + ' KB).' };
    }

    /* Geçici dosyaya yaz, sonra yerine taşı: yarım dosya önbelleğe girmez. */
    const gecici = hedef + '.tmp';

    fs.writeFileSync(gecici, tampon);
    fs.renameSync(gecici, hedef);

    sayac.indirilen++;

    return { ok: true, yol: hedef, atlandi: false };
  } catch (e) {
    clearTimeout(saat);
    sayac.hatali++;

    return { ok: false, hata: (e && e.message) || 'İndirilemedi.' };
  }
}

/* ==========================================================================
 *  KUYRUK
 * ========================================================================*/

/**
 * Kuyruğa iş ekler. Zaten önbellekte olanlar HİÇ kuyruğa girmez.
 *
 * @param {Array} isler [{ id, adres }]
 * @returns {number} kuyruğa giren iş sayısı
 */
function kuyrugaEkle(isler) {
  if (!Array.isArray(isler)) return 0;

  let eklenen = 0;

  isler.forEach(function (is) {
    const adres = String((is && is.adres) || '');

    if (!adres) return;

    if (onbellekteMi(adres)) {
      /* Dosya zaten var: depoya yolu bildir, indirme yapma. */
      if (bittiGeriCagir) {
        try { bittiGeriCagir(Number(is.id) || 0, yerelYol(adres)); } catch (e) { /* yok say */ }
      }
      return;
    }

    /* Aynı adres kuyrukta iki kez beklemez. */
    if (kuyruk.some(function (k) { return k.adres === adres; })) return;

    kuyruk.push({ id: Number(is.id) || 0, adres: adres });
    eklenen++;
  });

  sayac.toplam += eklenen;

  return eklenen;
}

/** Kuyruğu ES_ZAMAN kadar paralel işler; tamamı bitince durur. */
async function kuyruguIslet() {
  if (calisiyor) return;

  calisiyor = true;

  try {
    while (kuyruk.length || suren) {
      while (kuyruk.length && suren < ES_ZAMAN) {
        const is = kuyruk.shift();

        suren++;

        /* Bilinçli olarak await EDİLMEZ: üç iş birden yürüsün. */
        indir(is.adres)
          .then(function (sonuc) {
            if (sonuc.ok && bittiGeriCagir) {
              try { bittiGeriCagir(is.id, sonuc.yol); } catch (e) { /* yok say */ }
            }
          })
          .catch(function () { /* indir() kendi hatasını yutar */ })
          .then(function () { suren--; });
      }

      /* Slot boşalmasını bekle — meşgul döngü yapmadan. */
      await new Promise(function (r) { setTimeout(r, 25); });
    }
  } finally {
    calisiyor = false;
  }

  return durum();
}

/** Kuyruğa ekle + işlet (ateşle-ve-unut; çağıran beklemek zorunda değil). */
function baslat(isler) {
  const eklenen = kuyrugaEkle(isler);

  /* Kuyruk zaten dönüyorsa ikinci tur başlatılmaz (calisiyor bayrağı). */
  kuyruguIslet();

  return eklenen;
}

function durum() {
  return {
    bekleyen: kuyruk.length,
    suren: suren,
    indirilen: sayac.indirilen,
    atlanan: sayac.atlanan,
    hatali: sayac.hatali,
    toplam: sayac.toplam,
    dizin: dizinCoz()
  };
}

/** Kuyruğu boşaltır (çıkış / oturum değişimi). */
function temizle() {
  kuyruk = [];
}

/** Testlerin kullandığı sıfırlama. */
function sifirla() {
  kuyruk = [];
  suren = 0;
  calisiyor = false;
  sayac.indirilen = 0;
  sayac.atlanan = 0;
  sayac.hatali = 0;
  sayac.toplam = 0;
}

module.exports = {
  kur,
  baslat,
  kuyrugaEkle,
  kuyruguIslet,
  indir,
  durum,
  temizle,
  sifirla,
  /* Saf yardımcılar: */
  dosyaAdi,
  yerelYol,
  onbellekteMi,
  uzanti,
  DIZIN,
  ES_ZAMAN,
  SURE_ASIMI_MS,
  EN_BUYUK
};
