'use strict';
/* ============================================================================
 *  M7 — KOLTUK (alt lisans) KİLİT MESAJI
 *  ---------------------------------------------------------------------------
 *  Bir firmanın ana lisansı altında N koltuk (alt lisans) açılır. Koltuklar
 *  dolduğunda hub `seat_limit_reached` döner. Panel bu kodu tanımıyorsa yanıt
 *  `bilinmiyor`a düşer ya da — daha kötüsü — 409 üzerinden `invalid_hwid`
 *  sayılır ve ekranda "Bu lisans anahtarı BAŞKA bir bilgisayara kayıtlı" yazar.
 *
 *  O cümle YANLIŞ bir teşhistir: anahtar doğru, koltuk dolu. Müşteri donanım
 *  kimliğini gönderip "taşıyın" der, destek de taşımaya çalışır — Faz 7'deki
 *  `//` hata mesajının aynı sınıfı (BYOM-REGISTRY.md §5.30).
 *
 *  Şartname: docs/hub/BYOM-HUB-API-SARTNAME.md §8 madde 2.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/main/byom-lisans-servisi.js');

test('seat_limit_reached KİLİT durumudur', () => {
  assert.equal(L.kilitliMi('seat_limit_reached'), true);
  assert.equal(L.acikMi('seat_limit_reached'), false);
});

test('hub kod yazımları tek duruma toplanır', () => {
  ['seat_limit_reached', 'seat_limit', 'no_seats_available', 'koltuk_dolu'].forEach((kod) => {
    assert.equal(
      L.yanitiCoz({ status: kod }).durum,
      'seat_limit_reached',
      kod + ' → seat_limit_reached'
    );
  });
});

test('mesaj DONANIM DEĞİL KOLTUK der (yanlış teşhis üretmez)', () => {
  const m = L.durumAciklamasi('seat_limit_reached');

  assert.match(m.baslik, /koltuk/i, 'başlık koltuktan söz eder');
  assert.doesNotMatch(
    m.aciklama,
    /BAŞKA bir bilgisayara kayıtlı/i,
    'donanım taşıma metni ÇIKMAZ — anahtar doğru, koltuk dolu'
  );
  assert.match(m.aciklama, /koltuk|lisans/i);
});

test('mesaj NE YAPILACAĞINI söyler', () => {
  const m = L.durumAciklamasi('seat_limit_reached');

  /* Kullanıcının elinde iki yol var: koltuk boşaltmak ya da yeni koltuk almak. */
  assert.match(m.aciklama, /boşalt|yeni koltuk|ek koltuk/i);
});

test('invalid_hwid mesajı DEĞİŞMEDİ (gerçek donanım taşıması hâlâ anlatılıyor)', () => {
  const m = L.durumAciklamasi('invalid_hwid');

  assert.match(m.aciklama, /BAŞKA bir bilgisayara kayıtlı/);
});

test('bilinmeyen kod HÂLÂ bilinmiyora düşer (sessiz yutma yok)', () => {
  assert.equal(L.durumAciklamasi('uydurma_kod'), L.durumAciklamasi('bilinmiyor'));
});

/* ============================================================================
 *  🔴 AKTİVASYONDA KOLTUK DOLU — LİSANS ATLATMA RİSKİ
 *
 *  Hub şartnamesi koltuk dolduğunda aktivasyona şunu döndürüyor:
 *      HTTP 409  { success:false, code:'seat_limit_reached',
 *                  error:'...', status:'active' }
 *
 *  `aktive()` hata yolunda ÖNCE `code` eşlemesine bakar; orada
 *  `seat_limit_reached` yoksa gövdedeki `status` okunur — ve o gövdede
 *  **"active"** yazmaktadır (ana lisans gerçekten etkindir, dolan şey
 *  koltuktur). Sonuç: panel lisansı GEÇERLİ sayar ve uygulama AÇILIR.
 *
 *  Koltuk sayısı bir ÜRÜN SINIRIDIR; bu, ücretsiz ek kurulum demektir.
 * ==========================================================================*/

const api = require('../src/main/byom-api.js');

/** `istekAt`i tek seferlik yanıtla değiştirir; sonra geri alır. */
async function sahteYanitla(yanit, is) {
  const gercek = api.istekAt;

  api.istekAt = async () => yanit;

  try {
    return await is();
  } finally {
    api.istekAt = gercek;
  }
}

const KOLTUK_DOLU_YANITI = {
  ok: false,
  agSorunu: false,
  durum: 409,
  veri: {
    success: false,
    code: 'seat_limit_reached',
    error: 'Bu lisansın tüm koltukları dolu.',
    /* Şartnamenin birebir gövdesi: ana lisans ETKİN, dolan koltuktur. */
    status: 'active',
  },
  hata: 'Bu lisansın tüm koltukları dolu.',
};

test('AKTİVASYON: koltuk dolu yanıtı uygulamayı AÇMAZ', async () => {
  const sonuc = await sahteYanitla(KOLTUK_DOLU_YANITI, () =>
    L.aktive({ lisansAnahtari: 'BYOMP-4T8N-KV2R-7WQZ', hardwareId: 'hw-123', domain: 'x.com' })
  );

  assert.equal(sonuc.durum, 'seat_limit_reached', 'durum koltuk doluya çözülmeli');
  assert.equal(L.acikMi(sonuc.durum), false, 'UYGULAMA AÇILMAMALI');
  assert.equal(L.kilitliMi(sonuc.durum), true, 'kilit ekranı gösterilmeli');
});

test('AKTİVASYON: koltuk dolu kararı NET verilir (ağ sorunu sayılmaz)', async () => {
  const sonuc = await sahteYanitla(KOLTUK_DOLU_YANITI, () =>
    L.aktive({ lisansAnahtari: 'BYOMP-4T8N-KV2R-7WQZ', hardwareId: 'hw-123' })
  );

  assert.equal(sonuc.agSorunu, false, 'sunucu yanıt verdi — ağ sorunu DEĞİL');
  assert.equal(sonuc.ok, true, 'karar nettir');
  assert.match(String(sonuc.mesaj || ''), /koltuk/i, 'kullanıcıya SEBEP söylenir');
});

test('AKTİVASYON: gerçek donanım uyuşmazlığı hâlâ invalid_hwid', async () => {
  const sonuc = await sahteYanitla(
    {
      ok: false, agSorunu: false, durum: 409,
      veri: { success: false, code: 'invalid_hwid', error: 'Başka bilgisayara kayıtlı.', status: 'invalid_hwid' },
      hata: 'Başka bilgisayara kayıtlı.',
    },
    () => L.aktive({ lisansAnahtari: 'K', hardwareId: 'hw-9' })
  );

  assert.equal(sonuc.durum, 'invalid_hwid');
});

test('DOĞRULAMA: koltuk dolu gövdesi de uygulamayı açmaz', async () => {
  /* Hub bunu validate ucunda da döndürebilir (ana lisans etkin, koltuk yok). */
  const sonuc = await sahteYanitla(
    {
      ok: false, agSorunu: false, durum: 409,
      veri: { success: false, status: 'seat_limit_reached', code: 'seat_limit_reached' },
      hata: 'koltuk dolu',
    },
    () => L.dogrula('BYOMP-4T8N-KV2R-7WQZ', 'hw-123', '2.8.0')
  );

  assert.equal(sonuc.durum, 'seat_limit_reached');
  assert.equal(L.acikMi(sonuc.durum), false);
});
