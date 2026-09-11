/* ============================================================================
 *  BYOM — TELEMETRİ (SESSİZ HATA AVCISI) · ANA SÜREÇ
 *  ---------------------------------------------------------------------------
 *  Amaç: müşteri "çalışmıyor" demeden ÖNCE hatayı görmek. Panelde oluşan her
 *  yakalanmamış hata, kullanıcıya tek bir ek uyarı göstermeden hub'a gider.
 *
 *  TASARIM SÖZÜ — ÜÇ MADDE:
 *
 *   1) ARAYÜZ ASLA BEKLEMEZ.
 *      Gönderim tamamen ateşle-ve-unut. İstek 3 saniyede (SURE_ASIMI_MS)
 *      kesilir, zamanlayıcı `unref` edilir (çıkışı geciktirmez) ve HER hata
 *      sessizce yutulur. Ağ yoksa, hub kapalıysa, DNS çözülmüyorsa panel
 *      bunu hiç fark etmez.
 *
 *   2) ÖNCE DİSKE, SONRA AĞA.
 *      Hata kaydı ilk iş olarak <userData>/byom-telemetri-kuyruk.json
 *      dosyasına yazılır, gönderim ondan SONRA denenir. Sebebi: main.js'teki
 *      uncaughtException kancası `dialog.showErrorBox` ile ana süreci SENKRON
 *      kilitler; kullanıcı kutuyu kapatana kadar hiçbir async istek ilerlemez.
 *      Kayıt diskte olduğu için kullanıcı uygulamayı kapatsa bile hata
 *      kaybolmaz — bir sonraki açılışta kuyruk boşaltılır.
 *
 *   3) ÇÖKME DAVRANIŞI DEĞİŞMEZ.
 *      Bu modül hiçbir yerde yeni `process.on('uncaughtException')` kurmaz;
 *      main.js'te 2.0.0'dan beri duran kancaların İÇİNE tek satır ekler
 *      (bkz. main.js → "YAKALANMAMIŞ HATALAR"). Yani hata diyaloğu, günlük
 *      satırları ve uygulamanın ayakta kalma davranışı birebir eskisi gibi.
 *      `kur()` yalnızca arayüzden gelen IPC kanalını bağlar ve kuyruğu boşaltır.
 *
 *  GİZLİLİK: Lisans anahtarı MASKELİ gider (son 4 hane). Ham donanım seri
 *  numarası hiç gönderilmez; HWID zaten geri döndürülemez SHA-256 özetidir
 *  (bkz. src/utils/hwid.js). Ayar dosyası, müşteri verisi, Woo API anahtarı
 *  payload'a GİRMEZ.
 *
 *  UÇ NOKTA: <apiTabani>/api/telemetry — adres yapilandirma.apiTabani()'den
 *  gelir (geliştirmede localhost:3000, kurulu sürümde hub.byomtech.com).
 *  Gömülü adres YOKTUR; "0 KM" kurulum kuralı burada da geçerlidir.
 * ==========================================================================*/

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, ipcMain } = require('electron');
const yapilandirma = require('./byom-yapilandirma');

/** Hub üzerindeki toplama ucu. */
const UC = '/api/telemetry';

/** İstek bu süreden uzun sürerse kesilir. Panel beklemez. */
const SURE_ASIMI_MS = 3000;

/** Diskteki kuyrukta en çok kaç kayıt tutulur (en yenisi kalır). */
const KUYRUK_EN_COK = 50;

/** Aynı parmak izi bu süre içinde tekrar gönderilmez (döngüye giren hata seli). */
const AYNI_HATA_SUSMA_MS = 60 * 1000;

/** Tek alanın en çok kaç karakteri gider (yığın izi şişmesin). */
const EN_UZUN_METIN = 4000;

let kuruldu = false;
let bosaltmaSuruyor = false;

/** Lisans/firma künyesini veren geri çağırma — main.js `kur()` sırasında bağlar. */
let kunyeGeriCagir = null;

/** parmakIzi -> son gönderim zamanı (ms). */
const sonGorulen = new Map();

/* ==========================================================================
 *  KÜNYE — "bu hata kimde, hangi sürümde oldu?"
 * ========================================================================*/

/** Lisans anahtarını maskeler: son 4 hane dışında hiçbir şey gitmez. */
function anahtariMaskele(ham) {
  const a = String(ham || '').trim();
  if (!a) return '';
  return a.length <= 4 ? '****' : '****-' + a.slice(-4);
}

function uygulamaSurumu() {
  try { return app.getVersion(); } catch (e) { return ''; }
}

/** Firma / lisans / donanım künyesi. Geri çağırma yoksa boş alanlarla döner. */
function kunye() {
  const temel = { firma: '', lisans: '', hwid: '', plan: '', lisansDurumu: '' };

  if (typeof kunyeGeriCagir !== 'function') return temel;

  try {
    const ozet = kunyeGeriCagir() || {};
    const l = ozet.lisans || {};
    return {
      firma: String(l.firmaAdi || ''),
      lisans: anahtariMaskele(l.lisansAnahtari),
      hwid: String(ozet.hwid || ''),
      plan: String(l.plan || ''),
      lisansDurumu: String(l.durum || '')
    };
  } catch (e) {
    return temel;
  }
}

/* ==========================================================================
 *  PAYLOAD — ham hatadan tek biçimli kayda
 * ========================================================================*/

function kisalt(ham) {
  const m = String(ham === null || ham === undefined ? '' : ham);
  return m.length > EN_UZUN_METIN ? m.slice(0, EN_UZUN_METIN) + ' …(kısaltıldı)' : m;
}

/** Yığın izinin ilk "dosya:satır:kolon" üçlüsünü ayıklar. */
function yigindanKonum(yigin) {
  const es = String(yigin || '').match(/\(?([^\s()]+?):(\d+):(\d+)\)?/);

  if (!es) return { dosya: '', satir: null, kolon: null };

  return {
    dosya: path.basename(es[1].replace(/^file:[/]*/i, '')),
    satir: Number(es[2]),
    kolon: Number(es[3])
  };
}

/** Ham girdiden (Error ya da arayüzden gelen düz nesne) mesaj + yığın çıkarır. */
function mesajVeYigin(ham) {
  const hata = (ham instanceof Error) ? ham : (ham && ham.hata instanceof Error ? ham.hata : null);

  if (hata) return { mesaj: kisalt(hata.message || String(hata)), yigin: kisalt(hata.stack || '') };

  if (typeof ham === 'string') return { mesaj: kisalt(ham), yigin: '' };

  const duz = ham || {};
  let mesaj = duz.mesaj || duz.message || '';

  if (!mesaj) {
    try { mesaj = JSON.stringify(duz); } catch (e) { mesaj = String(duz); }
  }

  return { mesaj: kisalt(mesaj), yigin: kisalt(duz.yigin || duz.stack || '') };
}

/** Ham girdiyi tek biçimli telemetri kaydına çevirir. */
function kayitKur(tip, ham, kaynak) {
  const duz = (ham && typeof ham === 'object' && !(ham instanceof Error)) ? ham : {};
  const my = mesajVeYigin(ham);

  /* Konum arayüzden geldiyse ona güvenilir; gelmediyse yığından okunur. */
  const konum = (duz.dosya || duz.satir)
    ? {
        dosya: String(duz.dosya || ''),
        satir: duz.satir === undefined || duz.satir === null ? null : Number(duz.satir),
        kolon: duz.kolon === undefined || duz.kolon === null ? null : Number(duz.kolon)
      }
    : yigindanKonum(my.yigin);

  return Object.assign({
    kaynak: String(kaynak || duz.kaynak || 'panel-main'),
    tip: String(tip || duz.tip || 'hata'),
    mesaj: my.mesaj,
    dosya: konum.dosya,
    satir: konum.satir,
    kolon: konum.kolon,
    yigin: my.yigin,
    surum: uygulamaSurumu(),
    sekme: String(duz.sekme || ''),
    ortam: {
      platform: process.platform,
      mimari: process.arch,
      electron: (process.versions && process.versions.electron) || '',
      node: (process.versions && process.versions.node) || '',
      paketli: (function () { try { return !!app.isPackaged; } catch (e) { return false; } })()
    },
    zaman: new Date().toISOString()
  }, kunye());
}

/** Aynı hatanın tekrarını tanıyan kısa imza. */
function parmakIzi(kayit) {
  return [
    kayit.kaynak,
    kayit.tip,
    kayit.dosya,
    kayit.satir,
    String(kayit.mesaj || '').slice(0, 160)
  ].join('|');
}

/** Bu kayıt az önce gönderildi mi? (hata döngülerinde sel önleyici) */
function cokSikMi(kayit) {
  const iz = parmakIzi(kayit);
  const simdi = Date.now();
  const onceki = sonGorulen.get(iz);

  if (onceki && (simdi - onceki) < AYNI_HATA_SUSMA_MS) return true;

  sonGorulen.set(iz, simdi);

  /* Harita sınırsız büyümesin: en eski girdi atılır. */
  if (sonGorulen.size > 200) {
    const ilk = sonGorulen.keys().next();
    if (!ilk.done) sonGorulen.delete(ilk.value);
  }

  return false;
}

/* ==========================================================================
 *  DİSK KUYRUĞU — çökmeden sağ kurtulan kayıtlar
 * ========================================================================*/

function kuyrukYolu() {
  return path.join(app.getPath('userData'), 'byom-telemetri-kuyruk.json');
}

function kuyruguOku() {
  try {
    const ham = JSON.parse(fs.readFileSync(kuyrukYolu(), 'utf8'));
    return Array.isArray(ham) ? ham : [];
  } catch (e) {
    return [];
  }
}

function kuyrugaYaz(liste) {
  try {
    const yol = kuyrukYolu();
    fs.mkdirSync(path.dirname(yol), { recursive: true });
    fs.writeFileSync(yol, JSON.stringify(liste.slice(-KUYRUK_EN_COK)), 'utf8');
    return true;
  } catch (e) {
    return false; // Disk dolu / izin yok: telemetri uğruna panel durmaz.
  }
}

function kuyrugaEkle(kayit) {
  const liste = kuyruguOku();
  liste.push(kayit);
  return kuyrugaYaz(liste);
}

/** Gönderilen kaydı kuyruktan düşürür (zaman + parmak izi eşleşmesiyle). */
function kuyruktanDus(kayit) {
  const iz = parmakIzi(kayit);

  kuyrugaYaz(kuyruguOku().filter(function (k) {
    return !(k && k.zaman === kayit.zaman && parmakIzi(k) === iz);
  }));
}

/* ==========================================================================
 *  GÖNDERİM — 3 saniye, tek deneme, sessiz
 * ========================================================================*/

function gonder(kayit) {
  return new Promise(function (bitir) {
    let adres = '';

    try {
      adres = yapilandirma.adresBirlestir(yapilandirma.apiTabani(), UC);
    } catch (e) {
      return bitir(false);
    }

    if (!adres) return bitir(false);

    /* AbortController + unref'li zamanlayıcı: hub yanıt vermezse istek 3 sn
       sonra kesilir ve bu zamanlayıcı uygulamanın kapanmasını geciktirmez. */
    const iptal = new AbortController();
    const saat = setTimeout(function () {
      try { iptal.abort(); } catch (e) { /* yok sayılır */ }
    }, SURE_ASIMI_MS);

    if (typeof saat.unref === 'function') saat.unref();

    let istek;

    try {
      istek = fetch(adres, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kayit),
        signal: iptal.signal
      });
    } catch (e) {
      clearTimeout(saat);
      return bitir(false);
    }

    istek.then(function (cevap) {
      clearTimeout(saat);
      bitir(!!(cevap && cevap.ok));
    }).catch(function () {
      clearTimeout(saat); // Ağ yok / DNS yok / sertifika / zaman aşımı — hepsi sessiz.
      bitir(false);
    });
  });
}

/* ==========================================================================
 *  DIŞ YÜZ
 * ========================================================================*/

/**
 * Bir hatayı bildirir. ASLA throw etmez, ASLA beklemez, dönüş değeri yoktur.
 * Çağıran taraf `await` ETMEMELİDİR: akış anında devam eder.
 */
function bildir(tip, ham, kaynak) {
  let kayit = null;

  try {
    kayit = kayitKur(tip, ham, kaynak);
    if (cokSikMi(kayit)) return;
    kuyrugaEkle(kayit);       // 1) Önce disk: çökme olsa bile kayıt sağ kalır.
  } catch (e) {
    return;                   // Telemetrinin kendi hatası hiçbir şeyi bozmaz.
  }

  /* 2) Sonra ağ. Bilinçli olarak beklenmez; başarılıysa kuyruktan düşer. */
  Promise.resolve()
    .then(function () { return gonder(kayit); })
    .then(function (oldu) { if (oldu) kuyruktanDus(kayit); })
    .catch(function () { /* sessiz */ });
}

/** Diskte bekleyen kayıtları sırayla gönderir; gidemeyenler kuyrukta kalır. */
async function kuyruguBosalt() {
  if (bosaltmaSuruyor) return;
  bosaltmaSuruyor = true;

  try {
    const bekleyen = kuyruguOku();

    for (const kayit of bekleyen) {
      if (!kayit) continue;

      let oldu = false;
      try { oldu = await gonder(kayit); } catch (e) { oldu = false; }

      if (!oldu) break;        // Ağ kapalı: kalanı denemenin anlamı yok.
      kuyruktanDus(kayit);
    }
  } catch (e) {
    /* sessiz */
  } finally {
    bosaltmaSuruyor = false;
  }
}

/**
 * Telemetriyi devreye alır.
 *
 *   secenekler.kunye : lisans/firma özetini döndüren fonksiyon
 *                      (main.js → byom.lisansOzeti)
 *
 * NOT: Node tarafındaki `uncaughtException` / `unhandledRejection` kancaları
 * BURADA KURULMAZ — main.js'te zaten varlar ve oradan `bildir()` çağrılır.
 * Böylece mevcut hata diyaloğu ve çökme davranışı hiç değişmez.
 */
function kur(secenekler) {
  secenekler = secenekler || {};

  if (typeof secenekler.kunye === 'function') kunyeGeriCagir = secenekler.kunye;
  if (kuruldu) return;
  kuruldu = true;

  /* Arayüzden (renderer) gelen hatalar. `on` kullanılır, `handle` DEĞİL:
     tek yönlü mesajda arayüz cevap beklemez, akış kesilmez. */
  try {
    ipcMain.on('byom:telemetri', function (olay, yuk) {
      bildir((yuk && yuk.tip) || 'arayuz', yuk, (yuk && yuk.kaynak) || 'panel-renderer');
    });
  } catch (e) {
    /* ipcMain hazır değilse telemetri sessizce devre dışı kalır. */
  }

  /* Önceki oturumdan kalan kayıtlar — açılışı yavaşlatmamak için gecikmeli. */
  const saat = setTimeout(function () { kuyruguBosalt(); }, 4000);
  if (typeof saat.unref === 'function') saat.unref();
}

module.exports = {
  kur,
  bildir,
  kuyruguBosalt,
  /* Saf yardımcılar — test ve teşhis ekranı için (ağ/Electron gerektirmez): */
  kayitKur,
  parmakIzi,
  anahtariMaskele,
  yigindanKonum,
  kuyrukYolu,
  UC,
  SURE_ASIMI_MS,
  KUYRUK_EN_COK
};
