/* ============================================================================
 *  BYOM BRAIN — YEREL LİSANS DEPOSU
 *  ---------------------------------------------------------------------------
 *  Lisans anahtarı ve son doğrulama sonucunu  <userData>/byom-lisans.json
 *  dosyasında saklar.
 *
 *  Korumalar:
 *   1) Electron safeStorage varsa içerik işletim sistemi anahtarıyla şifrelenir
 *      (Windows'ta DPAPI → yalnız o kullanıcı, o makine çözebilir).
 *   2) safeStorage yoksa içerik açık JSON yazılır ama HWID ile HMAC imzalanır;
 *      dosya elle kurcalanırsa ya da başka makineye kopyalanırsa imza tutmaz.
 *   3) Kayıttaki hardwareId, o anki HWID ile karşılaştırılır. Farklıysa kayıt
 *      "taşınmış" sayılır: çevrimdışı izin süresi İPTAL edilir, sunucuya
 *      doğrulatmadan uygulama açılmaz.
 *
 *  Yani dosyayı kopyalamak lisansı taşımaya yetmez; asıl karar her hâlükârda
 *  BYOM Brain'in verdiği yanıttır.
 * ==========================================================================*/

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const DOSYA_SURUMU = 1;

function dosyaYolu() {
  return path.join(app.getPath('userData'), 'byom-lisans.json');
}

/** İşletim sistemi şifrelemesi kullanılabilir mi? */
function korumaVar() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  } catch (e) {
    return false;
  }
}

/** safeStorage yoksa kullanılan imza: HWID'e bağlı HMAC. */
function imzala(metin, hwid) {
  return crypto.createHmac('sha256', 'BYOM-LISANS|' + String(hwid || 'hwid-yok'))
    .update(String(metin), 'utf8')
    .digest('hex');
}

/** Boş/yeni kayıt iskeleti. */
function bosKayit() {
  return {
    lisansAnahtari: '',
    firmaAdi: '',
    domain: '',
    hardwareId: '',
    durum: '',            // active | expiring_soon | expired | suspended | invalid_hwid …
    kalanGun: null,
    bitisTarihi: '',
    musteriAdi: '',
    plan: '',
    sonDogrulama: '',     // Sunucunun EVET dediği son an (ISO)
    sonDeneme: '',        // Son doğrulama denemesi (başarılı olmasa da)
    sunucuVerisi: null,   // Sunucudan gelen ham yanıt (teşhis için)
    aktivasyonTarihi: ''
  };
}

/**
 * Kaydı okur.
 * döner = { ...kayit, varMi, tasindi, bozuk }
 *   · tasindi → kayıttaki HWID bu makineninkiyle uyuşmuyor
 *   · bozuk   → dosya var ama çözülemedi/imza tutmadı
 */
function oku(hwid) {
  const bos = Object.assign(bosKayit(), { varMi: false, tasindi: false, bozuk: false });

  let ham;
  try {
    ham = fs.readFileSync(dosyaYolu(), 'utf8');
  } catch (e) {
    return bos; // Dosya yok → ilk kurulum
  }

  let zarf;
  try {
    zarf = JSON.parse(ham);
  } catch (e) {
    return Object.assign(bos, { bozuk: true });
  }

  let icerikMetni = '';
  try {
    if (zarf && zarf.korumali) {
      icerikMetni = safeStorage.decryptString(Buffer.from(String(zarf.veri || ''), 'base64'));
    } else if (zarf && typeof zarf.veri === 'string') {
      if (zarf.imza && zarf.imza !== imzala(zarf.veri, hwid)) {
        // İmza tutmuyor: dosya kurcalanmış ya da başka makineden kopyalanmış.
        return Object.assign(bos, { bozuk: true, tasindi: true });
      }
      icerikMetni = zarf.veri;
    } else {
      // Eski/biçimsiz dosya: doğrudan kaydın kendisi olabilir.
      icerikMetni = JSON.stringify(zarf);
    }
  } catch (e) {
    return Object.assign(bos, { bozuk: true });
  }

  let kayit;
  try {
    kayit = JSON.parse(icerikMetni);
  } catch (e) {
    return Object.assign(bos, { bozuk: true });
  }

  const tam = Object.assign(bosKayit(), kayit || {});
  const tasindi = !!(hwid && tam.hardwareId && tam.hardwareId !== hwid);

  return Object.assign(tam, {
    varMi: !!tam.lisansAnahtari,
    tasindi: tasindi,
    bozuk: false
  });
}

/** Kaydı (varsa üzerine ekleyerek) yazar. */
function yaz(yeni, hwid) {
  const mevcut = oku(hwid);
  delete mevcut.varMi; delete mevcut.tasindi; delete mevcut.bozuk;

  const kayit = Object.assign(bosKayit(), mevcut, yeni || {});
  if (hwid) kayit.hardwareId = hwid;

  const icerikMetni = JSON.stringify(kayit);
  let zarf;

  if (korumaVar()) {
    try {
      zarf = {
        surum: DOSYA_SURUMU,
        korumali: true,
        veri: safeStorage.encryptString(icerikMetni).toString('base64')
      };
    } catch (e) {
      zarf = null;
    }
  }
  if (!zarf) {
    zarf = {
      surum: DOSYA_SURUMU,
      korumali: false,
      veri: icerikMetni,
      imza: imzala(icerikMetni, hwid)
    };
  }

  try {
    fs.mkdirSync(path.dirname(dosyaYolu()), { recursive: true });
    fs.writeFileSync(dosyaYolu(), JSON.stringify(zarf, null, 2), 'utf8');
  } catch (e) {
    console.error('[BYOM] Lisans kaydedilemedi:', e && e.message);
    return Object.assign(kayit, { yazilamadi: true });
  }

  return kayit;
}

/** Lisansı tamamen siler (kullanıcı "başka lisans gireceğim" dediğinde). */
function sil() {
  try {
    fs.unlinkSync(dosyaYolu());
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { oku, yaz, sil, dosyaYolu, korumaVar, bosKayit };
