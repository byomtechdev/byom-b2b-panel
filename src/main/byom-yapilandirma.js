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

/** Kullanıcının yazdığı adresi temizler: boşluk, sondaki /, eksik protokol, /api eki. */
function adresiTemizle(ham) {
  let adres = String(ham || '').trim().replace(/\s+/g, '');
  if (!adres) return '';
  adres = adres.replace(/\/+$/, '');
  adres = adres.replace(/\/api(\/v\d+)?$/i, ''); // Kullanıcı ".../api/v1" yapıştırırsa
  if (!/^https?:\/\//i.test(adres)) {
    // localhost ve 127.0.0.1 için http, geri kalan her şey için https varsayılır.
    adres = (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(adres) ? 'http://' : 'https://') + adres;
  }
  return adres.replace(/\/+$/, '');
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

  return app.isPackaged ? VARSAYILAN_URETIM : VARSAYILAN_GELISTIRME;
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
  adresGecerliMi
};
