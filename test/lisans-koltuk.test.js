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
