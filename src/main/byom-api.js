/* ============================================================================
 *  BYOM BRAIN — HTTP İSTEMCİSİ
 *  ---------------------------------------------------------------------------
 *  Lisans ve destek uçlarına yapılan bütün istekler buradan geçer.
 *
 *  Neden ana süreçte?  Arayüzden doğrudan fetch atılsaydı CORS ve karışık
 *  içerik (mixed content) engellerine takılırdı; ayrıca lisans anahtarı
 *  arayüz katmanında dolaşmazsa daha güvenlidir.
 *
 *  Dayanıklılık:
 *   · Node fetch takılırsa Chromium ağ yığını (net.fetch) ile tekrar denenir.
 *   · Her hata Türkçeleştirilir; "agSorunu" bayrağı sayesinde çağıran taraf
 *     "sunucu ulaşılamıyor" ile "sunucu hayır dedi" durumlarını ayırabilir.
 *     Bu ayrım kritik: internet yokken lisans SİLİNMEMELİ, çevrimdışı izin
 *     süresi devreye girmeli.
 * ==========================================================================*/

'use strict';

const { app, net } = require('electron');
const yapilandirma = require('./byom-yapilandirma');

/** Hatanın sertifika/TLS kaynaklı olup olmadığını anlar. */
function sertifikaHatasiMi(e) {
  const parcalar = [
    (e && e.code) || '',
    (e && e.message) || '',
    (e && e.cause && e.cause.code) || '',
    (e && e.cause && e.cause.message) || ''
  ].join(' ');
  return /CERT|SSL|TLS|self[- ]signed|UNABLE_TO_VERIFY|DEPTH_ZERO|HOSTNAME/i.test(parcalar);
}

/** Önce Node fetch, sertifika yüzünden takılırsa Chromium ağ yığını. */
async function esnekIstek(adres, secenekler) {
  try {
    return await fetch(adres, secenekler);
  } catch (e) {
    if (!sertifikaHatasiMi(e)) throw e;
    console.warn('[BYOM] Node tarafı SSL yüzünden takıldı, Chromium ağ yığını deneniyor.');
    return await net.fetch(adres, secenekler);
  }
}

/** Ağ hatalarını kullanıcının anlayacağı Türkçeye çevirir. */
function agHatasiTurkce(e, taban) {
  const kod = (e && (e.code || (e.cause && e.cause.code))) || '';
  const ad = (e && e.name) || '';

  if (ad === 'TimeoutError' || ad === 'AbortError') {
    return 'BYOM Brain sunucusu zamanında yanıt vermedi.\nİnternet bağlantınızı kontrol edip tekrar deneyin.';
  }
  if (kod === 'ENOTFOUND' || kod === 'EAI_AGAIN') {
    return 'BYOM Brain adresine ulaşılamadı (' + taban + ').\nİnternet bağlantınızı kontrol edin.';
  }
  if (kod === 'ECONNREFUSED') {
    return 'BYOM Brain sunucusu bağlantıyı reddetti (' + taban + ').\n' +
           'Sunucu çalışmıyor olabilir veya adres/port yanlış olabilir.';
  }
  if (kod === 'ECONNRESET') {
    return 'BYOM Brain ile bağlantı kesildi. Lütfen tekrar deneyin.';
  }
  if (sertifikaHatasiMi(e)) {
    return 'BYOM Brain ile güvenli bağlantı (SSL) kurulamadı.\nSunucunun sertifika ayarlarını kontrol edin.';
  }
  return 'BYOM Brain\'e bağlanılamadı: ' + ((e && e.message) || 'bilinmeyen sebep');
}

/** HTTP durum kodunu Türkçe açıklamaya çevirir. */
function httpHatasiTurkce(durum, veri) {
  const sunucuMesaji = veri && (veri.message || veri.error || veri.hata)
    ? String(veri.message || veri.error || veri.hata)
    : '';
  const ek = sunucuMesaji ? '\n\nSunucu mesajı: ' + sunucuMesaji : '';

  if (durum === 400 || durum === 422) return 'Gönderilen bilgiler geçersiz.' + ek;
  if (durum === 401) return 'Lisans anahtarı doğrulanamadı (yetkisiz).' + ek;
  if (durum === 403) return 'Bu işlem için yetkiniz yok.' + ek;
  if (durum === 404) return 'İstenen kayıt bulunamadı.' + ek;
  if (durum === 409) return 'Bu lisans başka bir bilgisayarda kullanımda.' + ek;
  if (durum === 429) return 'Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin.' + ek;
  if (durum >= 500) return 'BYOM Brain sunucusunda hata oluştu (HTTP ' + durum + ').' + ek;
  return 'Beklenmeyen yanıt (HTTP ' + durum + ').' + ek;
}

/**
 * BYOM Brain'e istek atar.
 *
 * istek = {
 *   yol: '/api/v1/license/validate',
 *   metod: 'GET' | 'POST' | 'PUT' | 'PATCH',
 *   sorgu: { license_key: '…' },
 *   govde: { … },
 *   lisansAnahtari, hardwareId,     → başlıklara da eklenir
 *   sureAsimi,
 *   htmlUyarisi                     → false ise, HTML dönen hata sayfaları
 *                                     "yanlış adres" (agSorunu) sayılmaz;
 *                                     bağlantı yoklaması bunu kullanır.
 * }
 *
 * döner = { ok, durum, veri, hata, agSorunu, kod, url }
 */
async function istekAt(istek) {
  istek = istek || {};
  const taban = yapilandirma.apiTabani();

  let url;
  try {
    /* Kök + yol birleştirmesi tek yerden geçer: çift slash ve eksik protokol
       burada sanitize edilir (bkz. yapilandirma.adresBirlestir).            */
    url = new URL(yapilandirma.adresBirlestir(taban, istek.yol));
  } catch (e) {
    return {
      ok: false,
      durum: 0,
      agSorunu: true,
      url: taban,
      hata: 'BYOM Brain adresi geçersiz: ' + taban + '\nAyarlar ▸ BYOM Brain bölümünden düzeltin.'
    };
  }

  const sorgu = istek.sorgu || {};
  Object.keys(sorgu).forEach(function (anahtar) {
    const deger = sorgu[anahtar];
    if (deger !== undefined && deger !== null && deger !== '') {
      url.searchParams.set(anahtar, String(deger));
    }
  });

  const basliklar = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'BYOM-B2B-Panel/' + (function () { try { return app.getVersion(); } catch (e) { return '1.0.0'; } })(),
    'X-BYOM-Client': 'b2b-yonetim-paneli'
  };
  if (istek.lisansAnahtari) {
    basliklar['X-License-Key'] = String(istek.lisansAnahtari);
    basliklar.Authorization = 'Bearer ' + String(istek.lisansAnahtari);
  }
  if (istek.hardwareId) basliklar['X-Hardware-Id'] = String(istek.hardwareId);

  const metod = (istek.metod || 'GET').toUpperCase();
  const sureAsimi = Number(istek.sureAsimi) > 0 ? Number(istek.sureAsimi) : yapilandirma.sureAsimi();

  try {
    const yanit = await esnekIstek(url.toString(), {
      method: metod,
      headers: basliklar,
      body: istek.govde && metod !== 'GET' ? JSON.stringify(istek.govde) : undefined,
      signal: AbortSignal.timeout(sureAsimi)
    });

    const metin = await yanit.text();
    let veri = null;
    try {
      veri = metin ? JSON.parse(metin) : null;
    } catch (e) {
      veri = null;
    }

    if (!yanit.ok) {
      /* JSON yerine HTML geldiyse muhtemelen BYOM Brain değil, başka bir sunucu
         yanıt veriyor (yanlış adres, vekil sunucu, giriş sayfası…).            */
      if (istek.htmlUyarisi !== false && veri === null && metin && metin.trim().indexOf('<') === 0) {
        return {
          ok: false,
          durum: yanit.status,
          agSorunu: true,
          url: url.toString(),
          hata: 'Bu adres BYOM Brain API\'si gibi görünmüyor (HTTP ' + yanit.status + ').\n' +
                'Adres: ' + taban
        };
      }
      return {
        ok: false,
        durum: yanit.status,
        veri: veri,
        url: url.toString(),
        hata: httpHatasiTurkce(yanit.status, veri)
      };
    }

    return { ok: true, durum: yanit.status, veri: veri, url: url.toString() };
  } catch (e) {
    return {
      ok: false,
      durum: 0,
      agSorunu: true,
      /* Taşıma katmanı hata kodu (ENOTFOUND, ECONNREFUSED, …). Çağıran taraf
         "bu host hiç çözülmüyor" ile "bu rota yok" ayrımını buradan yapar. */
      kod: (e && (e.code || (e.cause && e.cause.code))) || (e && e.name) || '',
      url: url.toString(),
      hata: agHatasiTurkce(e, taban)
    };
  }
}

module.exports = { istekAt, agHatasiTurkce, httpHatasiTurkce };
