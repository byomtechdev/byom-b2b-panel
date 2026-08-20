/* ============================================================================
 *  BYOM BRAIN — YAPILANDIRMA
 *  ---------------------------------------------------------------------------
 *  Merkezî lisans/destek sunucusunun (BYOM Brain) adresini ve entegrasyona ait
 *  ayarları saklar.  <userData>/byom-ayarlar.json
 *
 *  Adres şu sırayla belirlenir (ilk bulunan kazanır):
 *    1) BYOM_API_URL ortam değişkeni   → CI / test / geçici yönlendirme
 *    2) Kullanıcının kaydettiği adres  → Ayarlar ▸ BYOM Brain bölümü
 *    3) Varsayılan:
 *         · Geliştirme (paketlenmemiş) → http://localhost:3000
 *         · Üretim     (kurulu .exe)   → https://hub.byomtech.com
 * ==========================================================================*/

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const VARSAYILAN_GELISTIRME = 'http://localhost:3000';
const VARSAYILAN_URETIM = 'https://hub.byomtech.com';

/** Ayar dosyasının tam yolu. */
function dosyaYolu() {
  return path.join(app.getPath('userData'), 'byom-ayarlar.json');
}

function varsayilanlar() {
  return {
    /** Boş bırakılırsa ortama göre otomatik seçilir (bkz. apiTabani). */
    apiUrl: '',
    /** Sunucuya hiç ulaşılamadığında uygulamanın çalışmaya devam edeceği gün sayısı. */
    cevrimdisiIzinGunu: 7,
    /** Uygulama açıkken lisansın kaç saatte bir yeniden doğrulanacağı. */
    otoKontrolSaati: 6,
    /** İstek zaman aşımı (ms). */
    sureAsimi: 20000
  };
}

function oku() {
  try {
    const ham = fs.readFileSync(dosyaYolu(), 'utf8');
    return Object.assign(varsayilanlar(), JSON.parse(ham));
  } catch (e) {
    return varsayilanlar();
  }
}

function yaz(yeni) {
  const tam = Object.assign(oku(), yeni || {});
  try {
    fs.mkdirSync(path.dirname(dosyaYolu()), { recursive: true });
    fs.writeFileSync(dosyaYolu(), JSON.stringify(tam, null, 2), 'utf8');
  } catch (e) {
    console.error('[BYOM] Yapılandırma kaydedilemedi:', e && e.message);
  }
  return tam;
}

/**
 * Kullanıcının yazdığı adresi temizler.
 * Giderilen tipik yazım hataları:
 *   · baştaki/sondaki boşluk ve satır sonları
 *   · eksik ya da bozuk protokol:  "hub.byomtech.com", "https:/hub…", "https:hub…"
 *   · çift slash:  "https://hub.byomtech.com//"
 *   · elle yapıştırılan "/api" veya "/api/v1" eki
 */
function adresiTemizle(ham) {
  let adres = String(ham || '').trim().replace(/\s+/g, '');
  if (!adres) return '';

  /* Protokolü ayır: "https://", "https:/" ve "https:" biçimlerinin hepsi kabul
     edilir; gövde temizlendikten sonra tek biçimde geri eklenir.            */
  let protokol = '';
  const protokolEsi = adres.match(/^(https?):\/*/i);
  if (protokolEsi) {
    protokol = protokolEsi[1].toLowerCase() + '://';
    adres = adres.slice(protokolEsi[0].length);
  }

  adres = adres.replace(/^\/+/, '');           // "//hub.byomtech.com" artığı
  adres = adres.replace(/\/{2,}/g, '/');       // gövdedeki çift slash'lar
  adres = adres.replace(/\/+$/, '');
  adres = adres.replace(/\/api(\/v\d+)?$/i, ''); // Kullanıcı ".../api/v1" yapıştırırsa
  adres = adres.replace(/\/+$/, '');
  if (!adres) return '';

  if (!protokol) {
    // localhost ve 127.0.0.1 için http, geri kalan her şey için https varsayılır.
    protokol = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(adres) ? 'http://' : 'https://';
  }
  return protokol + adres;
}

/**
 * Kök adres ile uç yolunu TEK bir slash ile birleştirir.
 *   adresBirlestir('https://hub.byomtech.com/', '/api/v1/health')
 *     → 'https://hub.byomtech.com/api/v1/health'
 * Böylece hiçbir istek "…com//api/v1/…" gibi çift slash'lı bir rotaya gitmez;
 * kimi sunucular bu yüzden 404 döndürüyordu.
 */
function adresBirlestir(taban, yol) {
  const kok = adresiTemizle(taban);
  const uc = String(yol || '').trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!uc) return kok;
  return kok + '/' + uc;
}

/** Adresin geçerli bir URL olup olmadığını söyler. */
function adresGecerliMi(ham) {
  const adres = adresiTemizle(ham);
  if (!adres) return false;
  try {
    const u = new URL(adres);
    return !!u.hostname;
  } catch (e) {
    return false;
  }
}

/** Şu an kullanılacak API kök adresi. */
function apiTabani() {
  const ortam = adresiTemizle(process.env.BYOM_API_URL);
  if (ortam) return ortam;

  const kayitli = adresiTemizle(oku().apiUrl);
  if (kayitli) return kayitli;

  return adresiTemizle(app.isPackaged ? VARSAYILAN_URETIM : VARSAYILAN_GELISTIRME);
}

/** Adresin nereden geldiğini söyler (Ayarlar ekranında gösterilir). */
function apiKaynagi() {
  if (adresiTemizle(process.env.BYOM_API_URL)) return 'ortam';       // BYOM_API_URL
  if (adresiTemizle(oku().apiUrl)) return 'kullanici';               // Elle girilmiş
  return app.isPackaged ? 'varsayilan-uretim' : 'varsayilan-gelistirme';
}

module.exports = {
  VARSAYILAN_GELISTIRME,
  VARSAYILAN_URETIM,
  dosyaYolu,
  oku,
  yaz,
  apiTabani,
  apiKaynagi,
  adresiTemizle,
  adresBirlestir,
  adresGecerliMi
};
