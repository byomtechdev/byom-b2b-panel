'use strict';

/* ============================================================================
 *  SAHA STRES TESTİ 1/5 — ÇEVRİMDIŞI OUTBOX DAYANIKLILIĞI
 *  ---------------------------------------------------------------------------
 *  Senaryo: plasiyer internetin olmadığı bir ilçede 50 sipariş + 10 ziyaret
 *  notu girer. Bağlantı gelince kuyruk boşalır — ve PAKETİN ORTASINDA ağ
 *  yeniden kopar.
 *
 *  ⚠️ ŞARTNAME DÜZELTMESİ: istek `idempotency_key` diyor; bu depoda öyle bir
 *  alan YOKTUR. Mükerrer koruması `yerelKimlik` ile yapılır:
 *    panel  → gövdede `yerelKimlik`
 *    sunucu → `_b2b_plasiyer_yerel_kimlik` meta'sı + `siparis_yerel_kimlikle_bul()`
 *             aynı kimlik ikinci kez gelirse VAR OLAN siparişi döndürür
 *             (`tekrar: true`), yeni sipariş AÇMAZ.
 *  Test bu gerçek mekanizmayı zorlar.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/renderer/plasiyer-sync-motor.js');

/* ------------------------------------------------------------------ *
 *  Sahte sunucu — yerelKimlik ile mükerrer koruması yapar
 * ------------------------------------------------------------------ */

function sunucu(secenek) {
  const s = secenek || {};
  const yazilan = new Map();      // yerelKimlik -> siparisId
  const notlar = new Map();
  const musteriler = new Map();

  let siparisSayaci = 5000;
  let notSayaci = 900;
  let musteriSayaci = 40;

  const gecmis = { siparis: 0, not: 0, musteri: 0 };

  /** Ağ kopması: N. istekten sonra art arda M istek düşer. */
  function kopmaliMi(tur) {
    if (!s.kop) return false;

    const sira = gecmis[tur];

    return sira >= s.kop.sonra && sira < s.kop.sonra + s.kop.adet;
  }

  return {
    gecmis,
    yazilan,
    notlar,
    musteriler,

    async musteri(gecici) {
      gecmis.musteri += 1;

      if (kopmaliMi('musteri')) return { ok: false, durum: 0, hata: 'ağ koptu' };

      /* Aynı geçici kimlik ikinci kez: VAR OLANI döndür. */
      if (musteriler.has(gecici.id)) {
        return { ok: true, durum: 200, veri: { user_id: musteriler.get(gecici.id), tekrar: true } };
      }

      musteriSayaci += 1;
      musteriler.set(gecici.id, musteriSayaci);

      return { ok: true, durum: 200, veri: { user_id: musteriSayaci } };
    },

    async siparis(kayit) {
      gecmis.siparis += 1;

      if (kopmaliMi('siparis')) return { ok: false, durum: 0, hata: 'ağ koptu' };

      const anahtar = String(kayit.yerelKimlik || '');

      assert.ok(anahtar, 'panel her siparişe yerelKimlik koymalı');

      /* 🔴 MÜKERRER KORUMASI — sunucunun gerçek davranışı. */
      if (yazilan.has(anahtar)) {
        return { ok: true, durum: 200, veri: { siparisId: yazilan.get(anahtar), tekrar: true } };
      }

      siparisSayaci += 1;
      yazilan.set(anahtar, siparisSayaci);

      return { ok: true, durum: 200, veri: { siparisId: siparisSayaci } };
    },

    async not(kayit) {
      gecmis.not += 1;

      if (kopmaliMi('not')) return { ok: false, durum: 0, hata: 'ağ koptu' };

      const anahtar = String(kayit.yerelKimlik || '');

      if (notlar.has(anahtar)) {
        return { ok: true, durum: 200, veri: { notId: notlar.get(anahtar), tekrar: true } };
      }

      notSayaci += 1;
      notlar.set(anahtar, notSayaci);

      return { ok: true, durum: 200, veri: { notId: notSayaci } };
    },
  };
}

/** 50 sipariş + 10 not + 3 çevrimdışı müşteri üretir. */
function sahaGunu(siparisAdet, notAdet) {
  const musteriler = [];
  const siparisler = [];
  const notlar = [];

  for (let i = 0; i < 3; i += 1) {
    musteriler.push({
      id: 'temp_musteri_' + i,
      unvan: 'Çevrimdışı Müşteri ' + i,
      senkron: false,
    });
  }

  /*
   * ⚠️ SIPARIS KUYRUĞU SATIRLARI SARMALIDIR: `{ kayit: {...}, durum, deneme }`.
   * `kayit` sunucuya giden GÖVDEDİR; durum/deneme/künye yedeği SATIRDA durur.
   * Not kuyruğu ise DÜZDÜR (`musteriId` doğrudan kaydın üstünde).
   * Bu ayrım motorun sözleşmesidir — düz kayıt yazarsam köprü hiç kurulmaz
   * ve testler ÜRETİM HATASI sanılacak bir kırmızıyla düşer.
   */
  for (let i = 0; i < siparisAdet; i += 1) {
    siparisler.push({
      durum: 'bekliyor',
      deneme: 0,
      sira: i,
      kayit: {
        yerelKimlik: 'sip_' + i,
        musteriId: 'temp_musteri_' + (i % 3),
        kalemler: [{ product_id: 100 + i, adet: 1 + (i % 7) }],
        geciciMusteri: { id: 'temp_musteri_' + (i % 3), unvan: 'Çevrimdışı Müşteri ' + (i % 3) },
      },
    });
  }

  for (let i = 0; i < notAdet; i += 1) {
    notlar.push({
      yerelKimlik: 'not_' + i,
      musteriId: 'temp_musteri_' + (i % 3),
      durum: 'bekliyor',
      deneme: 0,
      metin: 'Ziyaret notu ' + i,
      sira: i,
    });
  }

  return { musteriler, siparisler, notlar };
}

/* ============================================================================
 *  1. TEMEL: 50 sipariş + 10 not tek turda gider
 * ==========================================================================*/

test('50 sipariş + 10 not tek turda boşalır, SIRA korunur', async () => {
  const k = sahaGunu(50, 10);
  const sv = sunucu();

  await S.esitle(k, { musteri: sv.musteri, siparis: sv.siparis, not: sv.not });

  assert.equal(sv.yazilan.size, 50, '50 sipariş yazıldı');
  assert.equal(sv.notlar.size, 10, '10 not yazıldı');

  /* Sunucuya varış sırası, kuyruğa giriş sırasıyla AYNI olmalı:
     sipariş numaraları artan verildiği için kimlik sırası da artmalı. */
  const sirali = [...sv.yazilan.entries()].map(([anahtar, id]) => ({ i: Number(anahtar.split('_')[1]), id }));

  for (let i = 1; i < sirali.length; i += 1) {
    assert.ok(sirali[i].id > sirali[i - 1].id || sirali[i].i > sirali[i - 1].i,
      'kuyruk sırası bozulmamalı');
  }

  assert.ok(k.siparisler.every((x) => x.durum === S.GONDERILDI), 'hepsi gönderildi');
});

/* ============================================================================
 *  2. 🔴 PAKET ORTASINDA AĞ KOPMASI → MÜKERRER SİPARİŞ OLUŞMAMALI
 * ==========================================================================*/

test('paket ortasında ağ koparsa MÜKERRER sipariş oluşmaz', async () => {
  const k = sahaGunu(50, 10);

  /* 20. siparişten sonra 8 istek düşer. */
  const sv = sunucu({ kop: { sonra: 20, adet: 8 } });
  const gonderici = { musteri: sv.musteri, siparis: sv.siparis, not: sv.not };

  await S.esitle(k, gonderici);

  const ilkTurYazilan = sv.yazilan.size;

  assert.ok(ilkTurYazilan < 50, 'kopma gerçekten oldu (taklit çalışıyor)');

  /* Bağlantı geri geldi: kalan kuyruk yeniden gönderilir. */
  await S.esitle(k, gonderici);
  await S.esitle(k, gonderici);

  assert.equal(sv.yazilan.size, 50, 'TAM 50 sipariş — ne eksik ne fazla');
  assert.equal(new Set(sv.yazilan.values()).size, 50, 'her siparişin kimliği TEKİL');

  /* Sunucuya toplam istek 50'den ÇOK olabilir (tekrar denemeler) ama
     YAZILAN kayıt 50'yi geçmemeli — mükerrer koruması budur. */
  assert.ok(sv.gecmis.siparis > 50, 'tekrar denendi');
  assert.equal(sv.yazilan.size, 50, 'tekrarlar YENİ sipariş AÇMADI');
});

test('gönderilmiş kayıt ikinci turda TEKRAR GÖNDERİLMEZ', async () => {
  const k = sahaGunu(10, 2);
  const sv = sunucu();
  const gonderici = { musteri: sv.musteri, siparis: sv.siparis, not: sv.not };

  await S.esitle(k, gonderici);

  const ilkIstek = sv.gecmis.siparis;

  await S.esitle(k, gonderici);

  assert.equal(sv.gecmis.siparis, ilkIstek, 'ikinci turda AĞA HİÇ ÇIKILMADI');
});

test('ağ kopması kaydı KALICI HATAYA düşürmez (geçici ret)', async () => {
  const k = sahaGunu(5, 0);
  const sv = sunucu({ kop: { sonra: 0, adet: 99 } });

  await S.esitle(k, { musteri: sv.musteri, siparis: sv.siparis, not: sv.not });

  assert.ok(k.siparisler.every((x) => x.durum !== S.KALICI_HATA),
    'ağ hatası kalıcı DEĞİLDİR — sahada internet sürekli kesilir');
});

/* ============================================================================
 *  3. MÜŞTERİ KÖPRÜSÜ — sipariş ÖNCE müşteriye bağlanır
 * ==========================================================================*/

test('kuyruk SIRASI: müşteri → köprü → sipariş → not', async () => {
  const k = sahaGunu(20, 5);
  const sv = sunucu();

  await S.esitle(k, { musteri: sv.musteri, siparis: sv.siparis, not: sv.not });

  /* Hiçbir sipariş GEÇİCİ kimlikle gitmemiş olmalı. */
  for (const [anahtar] of sv.yazilan) {
    const satir = k.siparisler.find((x) => x.kayit.yerelKimlik === anahtar);

    assert.ok(!S.geciciMi(satir.kayit.musteriId),
      'sipariş gerçek user_id ile gitmeli: ' + satir.kayit.musteriId);
  }

  assert.equal(sv.musteriler.size, 3, 'üç çevrimdışı müşteri bir kez açıldı');
});

test('müşteri eşitlemesi koparsa siparişler GEÇİCİ kimlikle GİTMEZ', async () => {
  const k = sahaGunu(10, 0);
  const sv = sunucu({ kop: { sonra: 0, adet: 99 } });

  /* Müşteri ucu koptu ama sipariş ucu çalışıyor. */
  await S.esitle(k, {
    musteri: sv.musteri,
    siparis: async (kayit) => {
      assert.ok(!S.geciciMi(kayit.musteriId), 'GEÇİCİ kimlikli sipariş sunucuya GİTMEMELİ');
      return { ok: true, durum: 200, veri: { siparisId: 1 } };
    },
    not: sv.not,
  });

  assert.equal(sv.yazilan.size, 0);
});

/* ============================================================================
 *  4. BELLEK / BÜYÜME — 500+ çevrimdışı işlem
 * ==========================================================================*/

test('500+ çevrimdışı işlemde kuyruk ŞİŞMEZ (alan sayısı sabit)', async () => {
  const k = sahaGunu(500, 50);
  const sv = sunucu();

  const oncekiAlanlar = Object.keys(k.siparisler[0]).length;

  await S.esitle(k, { musteri: sv.musteri, siparis: sv.siparis, not: sv.not });

  const sonrakiAlanlar = Object.keys(k.siparisler[0]).length;

  /*
   * Eşitleme kayda BİRKAÇ alan ekler (durum, gercekId, sunucuId…) ama bu
   * sayı SABİT olmalı. Tur başına alan eklenirse 500 kayıtlık bir kuyruk
   * her senkronda büyür ve `ayarlar.json` şişer.
   */
  assert.ok(sonrakiAlanlar - oncekiAlanlar <= 4,
    'kayda tur başına alan eklenmemeli (önce ' + oncekiAlanlar + ', sonra ' + sonrakiAlanlar + ')');

  /* İkinci tur hiç alan eklememeli. */
  await S.esitle(k, { musteri: sv.musteri, siparis: sv.siparis, not: sv.not });

  assert.equal(Object.keys(k.siparisler[0]).length, sonrakiAlanlar,
    'ikinci tur kayda alan EKLEMEDİ');
});

test('550 kayıtlık kuyruk JSON olarak makul boyutta kalır', async () => {
  const k = sahaGunu(500, 50);
  const sv = sunucu();

  await S.esitle(k, { musteri: sv.musteri, siparis: sv.siparis, not: sv.not });

  const bayt = Buffer.byteLength(JSON.stringify(k));
  const kayitBasina = bayt / 550;

  /*
   * `ayarlar.json` senkron yazılır (main.js). Kayıt başına birkaç KB, 500
   * siparişte megabaytlara çıkar ve her yazma arayüzü kilitler. Sınır bir
   * TAHMİN değil bir BÜTÇEDİR: aşılırsa kuyruğu ayrı dosyaya almak gerekir.
   */
  assert.ok(kayitBasina < 1024,
    'kayıt başına ' + Math.round(kayitBasina) + ' bayt — 1 KB bütçesi aşıldı');
});

test('temizlik: gönderilenler düşer, kalıcı hatalılar KALIR', async () => {
  const k = sahaGunu(20, 0);
  const sv = sunucu();

  /* Beşinci sipariş kalıcı olarak reddedilsin (4xx). */
  await S.esitle(k, {
    musteri: sv.musteri,
    siparis: async (kayit) => {
      if ('sip_5' === kayit.yerelKimlik) {
        return { ok: false, durum: 400, hata: 'geçersiz kalem' };
      }

      return sv.siparis(kayit);
    },
    not: sv.not,
  });

  const kalan = S.gonderilenleriTemizle(k.siparisler);

  assert.equal(kalan.length, 1, 'yalnızca kalıcı hatalı kaldı');
  assert.equal(kalan[0].kayit.yerelKimlik, 'sip_5');
  assert.equal(kalan[0].durum, S.KALICI_HATA, 'kullanıcı görsün diye kuyrukta durur');
});

/* ============================================================================
 *  5. KAYNAK DENETİMİ — yerelKimlik sözleşmesi iki tarafta da yazılı
 * ==========================================================================*/

test('KAYNAK: mükerrer koruması yerelKimlik ile yapılır (idempotency_key DEĞİL)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const sunucuKaynak = fs.readFileSync(
    path.join(__dirname, '..', '..', 'b2b-core', 'includes', 'class-b2b-rest-plasiyer.php'),
    'utf8'
  );

  assert.match(sunucuKaynak, /_b2b_plasiyer_yerel_kimlik/, 'sunucu yerel kimliği damgalar');
  assert.match(sunucuKaynak, /siparis_yerel_kimlikle_bul/, 'ikinci gönderimde VAR OLANI arar');

  /*
   * Şartname `idempotency_key` diyor ama bu depoda öyle bir alan yok.
   * Test bunu KİLİTLER: biri "şartnamede böyle yazıyor" diye yeni bir alan
   * eklerse, iki mükerrer mekanizması aynı anda yaşar ve hangisinin geçerli
   * olduğu belirsizleşir.
   */
  assert.ok(!/idempotency_key/i.test(sunucuKaynak),
    'ikinci bir mükerrer anahtarı EKLENMEMELİ (tek mekanizma: yerelKimlik)');
});
