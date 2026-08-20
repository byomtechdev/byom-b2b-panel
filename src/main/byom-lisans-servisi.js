/* ============================================================================
 *  BYOM BRAIN — LİSANS DOĞRULAMA & AKTİVASYON MOTORU
 *  ---------------------------------------------------------------------------
 *  Uçlar:
 *    POST /api/v1/license/validate   { license_key, hardware_id }
 *    POST /api/v1/license/activate   { license_key, hardware_id, company_name, domain }
 *
 *  Sunucudan dönen "status" değerleri ve uygulamanın tepkisi:
 *    active         → aç
 *    expiring_soon  → aç (rozet turuncu, kalan gün vurgulanır)
 *    expired        → KİLİTLE (süre doldu)
 *    suspended      → KİLİTLE (dondurulmuş)
 *    revoked        → KİLİTLE (iptal edilmiş)
 *    invalid_hwid   → KİLİTLE (lisans başka bilgisayara mühürlü)
 *    not_found      → KİLİTLE (böyle bir anahtar yok)
 *    not_activated  → AKTİVASYON EKRANI (anahtar var, cihaza henüz mühürlenmemiş)
 *
 *  BYOM Brain'in gerçek yanıt biçimi (validate):
 *    { success, valid, status, status_label, days_left, server_time, message,
 *      license: { license_key, product, company_name, domain, version, seats,
 *                 starts_at, expires_at, activated_at, last_ping_at } }
 *  Çözümleyici yine de esnektir: alanlar {data:{…}} içinde de gelse okunur.
 * ==========================================================================*/

'use strict';

const api = require('./byom-api');

/** Uygulamanın açılmasına izin veren durumlar. */
const ACIK_DURUMLAR = ['active', 'expiring_soon'];

/** Kilitlenmesi gereken, sunucunun kesin olarak "hayır" dediği durumlar. */
const KILIT_DURUMLARI = ['expired', 'suspended', 'invalid_hwid', 'not_found', 'revoked', 'inactive', 'cancelled'];

/* not_activated ne açar ne kilitler: lisans gerçek ama henüz bu cihaza
   mühürlenmemiş. Doğru davranış aktivasyon ekranını göstermektir. */
const AKTIVASYON_DURUMLARI = ['not_activated'];

/* ==========================================================================
 *  YANIT ÇÖZÜMLEME
 * ========================================================================*/

/** İç içe yanıtlarda gerçek veri gövdesini bulur. */
function govdeyiBul(veri) {
  if (!veri || typeof veri !== 'object') return {};
  if (veri.data && typeof veri.data === 'object' && !Array.isArray(veri.data)) {
    return Object.assign({}, veri, veri.data);
  }
  if (veri.license && typeof veri.license === 'object') {
    return Object.assign({}, veri, veri.license);
  }
  return veri;
}

/** Farklı adlandırmalardan ilk dolu alanı seçer. */
function alan(kaynak, adlar) {
  for (let i = 0; i < adlar.length; i++) {
    const deger = kaynak[adlar[i]];
    if (deger !== undefined && deger !== null && deger !== '') return deger;
  }
  return '';
}

/** Sunucudan gelen durum metnini bilinen kodlara indirger. */
function durumuNormalize(ham, gecerliBayragi) {
  let durum = String(ham || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

  const esler = {
    valid: 'active',
    ok: 'active',
    aktif: 'active',
    gecerli: 'active',
    expiring: 'expiring_soon',
    expire_soon: 'expiring_soon',
    yakinda_bitiyor: 'expiring_soon',
    expired_license: 'expired',
    suresi_doldu: 'expired',
    askida: 'suspended',
    banned: 'suspended',
    blocked: 'suspended',
    hwid_mismatch: 'invalid_hwid',
    invalid_hardware: 'invalid_hwid',
    hardware_mismatch: 'invalid_hwid',
    device_mismatch: 'invalid_hwid',
    invalid_hardware_id: 'invalid_hwid',
    notfound: 'not_found',
    missing: 'not_found',
    invalid: 'not_found',
    bulunamadi: 'not_found'
  };
  if (esler[durum]) durum = esler[durum];

  if (!durum) {
    // Sunucu yalnızca boolean döndürdüyse (valid: true/false)
    if (gecerliBayragi === true) durum = 'active';
    else if (gecerliBayragi === false) durum = 'not_found';
  }
  return durum;
}

/** Tarihi ISO gün biçimine (YYYY-AA-GG) çevirir. */
function tariheCevir(ham) {
  if (!ham) return '';
  const t = new Date(ham);
  if (isNaN(t.getTime())) return String(ham);
  return t.toISOString().slice(0, 10);
}

/** Bitiş tarihinden kalan gün sayısını hesaplar. */
function kalanGunHesapla(bitisTarihi) {
  if (!bitisTarihi) return null;
  const t = new Date(String(bitisTarihi).length <= 10 ? bitisTarihi + 'T23:59:59' : bitisTarihi);
  if (isNaN(t.getTime())) return null;
  return Math.ceil((t.getTime() - Date.now()) / 86400000);
}

/**
 * Sunucu yanıtını uygulamanın kullandığı sabit biçime çevirir.
 * döner = { durum, kalanGun, bitisTarihi, firmaAdi, domain, musteriAdi, plan, mesaj, ham }
 */
function yanitiCoz(veri) {
  const g = govdeyiBul(veri);

  const durum = durumuNormalize(
    alan(g, ['status', 'license_status', 'state', 'durum']),
    typeof g.valid === 'boolean' ? g.valid : (typeof g.is_valid === 'boolean' ? g.is_valid : undefined)
  );

  const bitisTarihi = tariheCevir(alan(g, [
    'expires_at', 'expiry_date', 'expire_date', 'valid_until', 'end_date', 'bitis_tarihi'
  ]));

  let kalanGun = alan(g, ['days_remaining', 'days_left', 'remaining_days', 'kalan_gun']);
  kalanGun = kalanGun === '' ? null : Number(kalanGun);
  if (kalanGun === null || !isFinite(kalanGun)) kalanGun = kalanGunHesapla(bitisTarihi);

  return {
    durum: durum,
    kalanGun: (kalanGun === null || !isFinite(kalanGun)) ? null : Math.round(kalanGun),
    bitisTarihi: bitisTarihi,
    firmaAdi: String(alan(g, ['company_name', 'company', 'firma_adi', 'customer_company']) || ''),
    domain: String(alan(g, ['domain', 'site_url', 'website', 'alan_adi']) || ''),
    musteriAdi: String(alan(g, ['customer_name', 'customer', 'owner_name', 'musteri_adi']) || ''),
    plan: String(alan(g, ['product', 'plan', 'package', 'license_type', 'type', 'paket']) || ''),
    mesaj: String(alan(g, ['message', 'status_label', 'detail', 'description', 'mesaj']) || ''),
    ham: veri
  };
}

/** Kilit ekranında gösterilecek Türkçe açıklamalar. */
const DURUM_ACIKLAMALARI = {
  expired: {
    baslik: 'Lisans süresi doldu',
    aciklama: 'Yıllık bakım/lisans süreniz sona erdi. Uygulamayı kullanmaya devam etmek için ' +
              'lisansınızı yenilemeniz gerekiyor.'
  },
  suspended: {
    baslik: 'Lisans donduruldu',
    aciklama: 'Lisansınız BYOM tarafından geçici olarak durduruldu. Sebebini öğrenmek ve ' +
              'yeniden açtırmak için bizimle iletişime geçin.'
  },
  revoked: {
    baslik: 'Lisans iptal edildi',
    aciklama: 'Bu lisans kalıcı olarak iptal edilmiştir. Yeni lisans almak için satış ' +
              'temsilcinizle ya da destek hattımızla görüşün.'
  },
  not_activated: {
    baslik: 'Lisans bu bilgisayara tanımlanmamış',
    aciklama: 'Lisansınız geçerli ancak henüz hiçbir cihaza mühürlenmemiş. ' +
              'Aşağıdaki bilgileri onaylayarak bu bilgisayara tanımlayabilirsiniz.'
  },
  invalid_hwid: {
    baslik: 'Lisans bu bilgisayara tanımlı değil',
    aciklama: 'Bu lisans anahtarı BAŞKA bir bilgisayara kayıtlı. Bilgisayar değiştirdiyseniz ya da ' +
              'donanımınız yenilendiyse lisansın yeni cihaza taşınması gerekir. ' +
              'Aşağıdaki Donanım Kimliğini bize iletin, taşımayı biz yapalım.'
  },
  not_found: {
    baslik: 'Lisans anahtarı bulunamadı',
    aciklama: 'Girilen lisans anahtarı sistemimizde kayıtlı değil. Anahtarı harf/rakam hatası ' +
              'olmadan yeniden girin ya da bizden yeni anahtar isteyin.'
  },
  baglanti: {
    baslik: 'BYOM Brain sunucusuna ulaşılamadı',
    aciklama: 'Lisansınız doğrulanamadı çünkü sunucuya bağlanılamıyor. İnternet bağlantınızı ' +
              'kontrol edip tekrar deneyin.'
  },
  bilinmiyor: {
    baslik: 'Lisans doğrulanamadı',
    aciklama: 'Sunucudan beklenmeyen bir yanıt geldi. Lütfen destek ekibimizle iletişime geçin.'
  }
};

function durumAciklamasi(durum) {
  return DURUM_ACIKLAMALARI[durum] || DURUM_ACIKLAMALARI.bilinmiyor;
}

/* ==========================================================================
 *  SUNUCU ÇAĞRILARI
 * ========================================================================*/

/**
 * Lisansı doğrular.  POST /api/v1/license/validate
 * döner = { ok, agSorunu, durum, kalanGun, …, hata }
 *   · ok:true       → sunucu yanıt verdi (durum alanına bakılır)
 *   · agSorunu:true → sunucuya HİÇ ulaşılamadı (lisans silinmemeli!)
 */
async function dogrula(lisansAnahtari, hardwareId, surum) {
  const anahtar = String(lisansAnahtari || '').trim();
  if (!anahtar) {
    return { ok: false, agSorunu: false, durum: 'not_found', hata: 'Lisans anahtarı boş.' };
  }

  const yanit = await api.istekAt({
    yol: '/api/v1/license/validate',
    metod: 'POST',
    // Sunucu `version` alanını lisans kaydına yazar (hangi sürüm kullanılıyor?).
    govde: { license_key: anahtar, hardware_id: hardwareId, version: surum || '' },
    lisansAnahtari: anahtar,
    hardwareId: hardwareId
  });

  /* Sunucu 4xx döndürse bile gövdede anlamlı bir "status" olabilir
     (ör. 403 + {status:'suspended'}). Önce onu okumaya çalışırız. */
  const cozum = yanitiCoz(yanit.veri);

  if (!yanit.ok) {
    if (yanit.agSorunu) {
      return { ok: false, agSorunu: true, durum: 'baglanti', hata: yanit.hata };
    }
    if (cozum.durum) {
      return Object.assign({ ok: true, agSorunu: false, httpDurum: yanit.durum }, cozum);
    }
    // HTTP koduna göre makul bir duruma indir
    let durum = 'bilinmiyor';
    if (yanit.durum === 404) durum = 'not_found';
    else if (yanit.durum === 401 || yanit.durum === 403) durum = 'suspended';
    else if (yanit.durum === 409) durum = 'invalid_hwid';
    return {
      ok: false,
      agSorunu: yanit.durum >= 500,
      durum: durum,
      httpDurum: yanit.durum,
      hata: yanit.hata
    };
  }

  if (!cozum.durum) {
    return {
      ok: false,
      agSorunu: false,
      durum: 'bilinmiyor',
      hata: 'BYOM Brain beklenmeyen bir yanıt döndürdü (durum alanı yok).',
      ham: yanit.veri
    };
  }

  return Object.assign({ ok: true, agSorunu: false, httpDurum: yanit.durum }, cozum);
}

/**
 * Lisansı bu bilgisayara bağlar.  POST /api/v1/license/activate
 * Sunucuda böyle bir uç yoksa (404) doğrulama ucuna düşer — kimi kurulumlarda
 * validate ucu ilk çağrıda HWID'i kendisi bağlar.
 */
async function aktive(bilgi) {
  bilgi = bilgi || {};
  const anahtar = String(bilgi.lisansAnahtari || '').trim();
  const hardwareId = String(bilgi.hardwareId || '').trim();

  /* Sunucunun beklediği alanlar: license_key, hardware_id, domain?, version?
     company_name/os/hostname yok sayılır ama teşhis için gönderilmesi zararsız. */
  const govde = {
    license_key: anahtar,
    hardware_id: hardwareId,
    domain: String(bilgi.domain || '').trim(),
    version: bilgi.surum || '',
    company_name: String(bilgi.firmaAdi || '').trim(),
    os: process.platform,
    hostname: bilgi.makineAdi || ''
  };

  const yanit = await api.istekAt({
    yol: '/api/v1/license/activate',
    metod: 'POST',
    govde: govde,
    lisansAnahtari: anahtar,
    hardwareId: hardwareId
  });

  if (yanit.ok) {
    const cozum = yanitiCoz(yanit.veri);
    if (!cozum.durum) {
      /* Aktivasyon ucu yalnızca "kaydedildi" dediyse durumu doğrulama ucundan
         öğreniriz — kalan gün ve bitiş tarihi oradan gelir. */
      const kontrol = await dogrula(anahtar, hardwareId, bilgi.surum);
      return Object.assign({}, kontrol, { aktivasyonYapildi: true });
    }
    return Object.assign({ ok: true, agSorunu: false, aktivasyonYapildi: true }, cozum);
  }

  if (yanit.agSorunu) {
    return { ok: false, agSorunu: true, durum: 'baglanti', hata: yanit.hata };
  }

  /* Sunucu hatayı `code` ile bildirir: bunu doğrudan duruma çeviririz —
     böylece kullanıcı "bilinmeyen hata" yerine gerçek sebebi görür. */
  const kod = String((yanit.veri && (yanit.veri.code || yanit.veri.kod)) || '');
  const kodEslemesi = {
    license_expired: 'expired',
    license_suspended: 'suspended',
    license_revoked: 'revoked',
    invalid_hwid: 'invalid_hwid',
    license_not_found: 'not_found',
    invalid_key_format: 'not_found'
  };

  if (kodEslemesi[kod]) {
    const aciklama = durumAciklamasi(kodEslemesi[kod]);
    return {
      ok: true,                       // Sunucu yanıt verdi; karar nettir
      agSorunu: false,
      durum: kodEslemesi[kod],
      httpDurum: yanit.durum,
      mesaj: (yanit.veri && (yanit.veri.error || yanit.veri.message)) || aciklama.aciklama,
      kalanGun: null,
      bitisTarihi: ''
    };
  }

  /* Uç gerçekten yoksa (BYOM kodu olmayan 404/405) doğrulama ucuyla dene:
     bazı kurulumlarda ilk validate çağrısı HWID'i lisansa bağlar. */
  if (!kod && (yanit.durum === 404 || yanit.durum === 405 || yanit.durum === 501)) {
    const kontrol = await dogrula(anahtar, hardwareId, bilgi.surum);
    return Object.assign({}, kontrol, { aktivasyonYapildi: true, aktivasyonUcuYok: true });
  }

  const cozum = yanitiCoz(yanit.veri);
  if (cozum.durum) {
    return Object.assign({ ok: true, agSorunu: false, httpDurum: yanit.durum }, cozum);
  }

  return {
    ok: false,
    agSorunu: false,
    durum: yanit.durum === 409 ? 'invalid_hwid' : 'bilinmiyor',
    httpDurum: yanit.durum,
    hata: yanit.hata
  };
}

module.exports = {
  ACIK_DURUMLAR,
  KILIT_DURUMLARI,
  AKTIVASYON_DURUMLARI,
  dogrula,
  aktive,
  yanitiCoz,
  durumAciklamasi,
  kalanGunHesapla,
  acikMi: function (durum) { return ACIK_DURUMLAR.indexOf(String(durum || '')) !== -1; },
  kilitliMi: function (durum) { return KILIT_DURUMLARI.indexOf(String(durum || '')) !== -1; },
  aktivasyonGerekliMi: function (durum) { return AKTIVASYON_DURUMLARI.indexOf(String(durum || '')) !== -1; }
};
