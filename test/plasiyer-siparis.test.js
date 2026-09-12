'use strict';
/* ============================================================================
 *  PLASİYER SİPARİŞ MOTORU TESTİ — src/renderer/plasiyer-siparis-motor.js
 *  ---------------------------------------------------------------------------
 *  Kapsam:
 *   1. Hibrit koli matematiği: koli katları vs tekil adet, yukarı tamamlama
 *   2. Sepet: ekle/artır/azalt/sil, satır silme eşiği, toplamlar
 *   3. "Son siparişi kopyala": bugünün fiyatı, katalogda olmayan kalem,
 *      düzenlenebilirlik
 *   4. Geçici müşteri UUID: biçim, teklik, metin kimlik ayrımı
 *   5. İskonto tavanı: kırpma, ret, geçersiz değerler
 *   6. Sipariş denetimi ve gövdesi (üç ödeme yöntemi, notlar)
 *
 *  DOM GEREKMEZ: motor saf mantıktır, doğrudan require edilir.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/renderer/plasiyer-siparis-motor.js');

/* ------------------------------------------------------------------ *
 *  Yardımcılar
 * ------------------------------------------------------------------ */

/** Koli içi adedi verilen ürün. */
function u(id, ad, fiyat, koli) {
  return {
    id: id,
    name: ad,
    sku: 'SKU-' + id,
    barcode: '869' + id,
    price: fiyat,
    koli_ici_adet: undefined === koli ? 1 : koli
  };
}

function katalog(liste) {
  const harita = new Map(liste.map(function (x) { return [Number(x.id), x]; }));
  return function (id) { return harita.get(Number(id)) || null; };
}

function adetleri(sepet) {
  return sepet.satirlar.map(function (s) { return [s.id, s.adet]; });
}

/* =========================================================================
 * 1. HİBRİT KOLİ MATEMATİĞİ
 * ====================================================================== */

test('koliIci: geçersiz değerlerin hepsi 1 olur (tekil satış)', (t) => {
  [undefined, null, 0, -3, 'abc', '', NaN, 0.4].forEach((k) => {
    assert.equal(M.koliIci({ koli_ici_adet: k }), 1, 'deger: ' + String(k));
  });

  assert.equal(M.koliIci({ koli_ici_adet: 24 }), 24);
  assert.equal(M.koliIci({ koli_ici_adet: 24.9 }), 24, 'ondalik asagi');
  assert.equal(M.koliIci(null), 1, 'urun yoksa 1');
});

test('koliliMi: yalnızca 1\'den büyük koli koli sayılır', (t) => {
  assert.equal(M.koliliMi(u(1, 'A', 10, 24)), true);
  assert.equal(M.koliliMi(u(1, 'A', 10, 1)), false);
  assert.equal(M.koliliMi(u(1, 'A', 10, 0)), false);
});

test('adediOturt: KOLİLİ üründe yukarı tamamlanır', (t) => {
  const urun = u(1, 'Silikon', 10, 24);

  assert.equal(M.adediOturt(urun, 24), 24, 'tam kat degismez');
  assert.equal(M.adediOturt(urun, 25), 48, '25 -> 48 (eksik sevkiyat yerine tam koli)');
  assert.equal(M.adediOturt(urun, 1), 24, '1 -> bir koli');
  assert.equal(M.adediOturt(urun, 48), 48);
  assert.equal(M.adediOturt(urun, 49), 72);

  /* Sıfır ve negatif bir koliye çekilir: "0 adetli satır" yoktur. */
  assert.equal(M.adediOturt(urun, 0), 24);
  assert.equal(M.adediOturt(urun, -5), 24);
  assert.equal(M.adediOturt(urun, 'abc'), 24);
});

test('adediOturt: TEKİL üründe adet aynen kalır', (t) => {
  const urun = u(1, 'Çivi', 2, 1);

  assert.equal(M.adediOturt(urun, 1), 1);
  assert.equal(M.adediOturt(urun, 7), 7);
  assert.equal(M.adediOturt(urun, 0), 1, 'en az bir');
  assert.equal(M.adediOturt(urun, 2.3), 3, 'ondalik yukari');
});

test('adimla: + / - düğmeleri koli katlarında ilerler', (t) => {
  const koli = u(1, 'Silikon', 10, 24);

  assert.equal(M.adimla(koli, 24, 1), 48, '24 -> 48');
  assert.equal(M.adimla(koli, 48, 1), 72, '48 -> 72');
  assert.equal(M.adimla(koli, 48, -1), 24, '48 -> 24');
  assert.equal(M.adimla(koli, 24, -1), 24, 'bir kolinin altina INMEZ');

  const tekil = u(2, 'Çivi', 2, 1);

  assert.equal(M.adimla(tekil, 1, 1), 2);
  assert.equal(M.adimla(tekil, 3, -1), 2);
  assert.equal(M.adimla(tekil, 1, -1), 1, 'birin altina inmez');

  /* Kat dışı bir değerden adımlamak önce oturtur. */
  assert.equal(M.adimla(koli, 25, 1), 72, '25 -> (48) -> 72');
  assert.equal(M.adimla(koli, 25, -1), 24, '25 -> (48) -> 24');
});

test('koliSayisi ve adetEtiketi', (t) => {
  const koli = u(1, 'Silikon', 10, 24);

  assert.equal(M.koliSayisi(koli, 48), 2);
  assert.equal(M.koliSayisi(koli, 24), 1);
  assert.equal(M.koliSayisi(u(2, 'Çivi', 2, 1), 5), 0, 'tekil urunde koli yok');

  assert.equal(M.adetEtiketi(koli, 48), '48 Adet (2 Koli)');
  assert.equal(M.adetEtiketi(koli, 25), '48 Adet (2 Koli)', 'oturtulmus deger yazilir');
  assert.equal(M.adetEtiketi(u(2, 'Çivi', 2, 1), 3), '3 Adet');
});

/* =========================================================================
 * 2. SEPET
 * ====================================================================== */

test('ekle: aynı ürün ikinci kez ARTIRIR (yerine yazmaz)', (t) => {
  const s = M.sepetKur();
  const urun = u(1, 'Silikon', 10, 24);

  M.ekle(s, urun);
  assert.deepEqual(adetleri(s), [[1, 24]], 'varsayilan bir koli');

  M.ekle(s, urun);
  assert.deepEqual(adetleri(s), [[1, 48]], 'ikinci okutma USTUNE ekler');

  M.ekle(s, urun, 24);
  assert.deepEqual(adetleri(s), [[1, 72]]);

  assert.equal(s.satirlar.length, 1, 'tek satir kalir');
});

test('ekle: geçersiz ürün sepeti bozmaz', (t) => {
  const s = M.sepetKur();

  M.ekle(s, null);
  M.ekle(s, {});
  M.ekle(s, { id: 0 });

  assert.equal(s.satirlar.length, 0);
});

test('adetYaz: doğrudan yazılan adet satış birimine oturur', (t) => {
  const s = M.sepetKur();

  M.ekle(s, u(1, 'Silikon', 10, 24));
  M.adetYaz(s, 1, 25);

  assert.deepEqual(adetleri(s), [[1, 48]], '25 -> 48');

  M.adetYaz(s, 999, 10);   // olmayan satır
  assert.equal(s.satirlar.length, 1);
});

test('adimlaSatir: bir birimin altına inerse satır SİLİNİR', (t) => {
  const s = M.sepetKur();

  M.ekle(s, u(1, 'Silikon', 10, 24));
  M.ekle(s, u(2, 'Çivi', 2, 1));

  M.adimlaSatir(s, 1, -1);
  assert.equal(M.satirBul(s, 1), -1, 'bir kolinin altinda satir silinir');

  M.adimlaSatir(s, 2, -1);
  assert.equal(M.satirBul(s, 2), -1, 'tekil urunde de silinir');
  assert.equal(s.satirlar.length, 0);
});

test('sil ve bosalt', (t) => {
  const s = M.sepetKur();

  M.ekle(s, u(1, 'A', 10, 1));
  M.ekle(s, u(2, 'B', 10, 1));

  M.sil(s, 1);
  assert.deepEqual(adetleri(s), [[2, 1]]);

  M.sil(s, 999);   // yok
  assert.equal(s.satirlar.length, 1);

  M.bosalt(s);
  assert.equal(s.satirlar.length, 0);
});

test('toplamlar: kuruş kapanışı, koli sayısı, iskonto', (t) => {
  const s = M.sepetKur();

  M.ekle(s, u(1, 'Silikon', 12.5, 24), 48);   // 48 × 12,50 = 600
  M.ekle(s, u(2, 'Çivi', 2.25, 1), 4);        //  4 ×  2,25 =   9

  let t1 = M.toplamlar(s, 0);

  assert.equal(t1.satir, 2);
  assert.equal(t1.kalem, 52);
  assert.equal(t1.koli, 2, 'yalnizca kolili urun koli sayar');
  assert.equal(t1.araToplam, 609);
  assert.equal(t1.iskontoOrani, 0);
  assert.equal(t1.genelToplam, 609);

  /* Tavan 10 iken %10 iskonto uygulanır. */
  s.iskonto = 10;
  t1 = M.toplamlar(s, 10);

  assert.equal(t1.iskontoOrani, 10);
  assert.equal(t1.indirim, 60.9);
  assert.equal(t1.genelToplam, 548.1);

  /* Kayan nokta artığı görünmez. */
  const s2 = M.sepetKur();
  M.ekle(s2, u(3, 'X', 0.1, 1), 3);
  assert.equal(M.toplamlar(s2, 0).araToplam, 0.3, '0.1*3 = 0.3 (0.30000000000000004 degil)');
});

/* =========================================================================
 * 3. İSKONTO TAVANI
 * ====================================================================== */

test('tavaniOku: tanımsız/geçersiz tavan SIFIRDIR (sınırsız değil)', (t) => {
  [undefined, null, '', 'abc', NaN, -5].forEach((x) => {
    assert.equal(M.tavaniOku(x), 0, 'deger: ' + String(x));
  });

  assert.equal(M.tavaniOku(15), 15);
  assert.equal(M.tavaniOku('15'), 15);
  assert.equal(M.tavaniOku(500), 100, '100e sikistirilir');
});

test('iskontoDenetle: tavanı aşan oran REDDEDİLİR', (t) => {
  assert.equal(M.iskontoDenetle(10, 15).ok, true, 'tavan alti gecer');
  assert.equal(M.iskontoDenetle(15, 15).ok, true, 'tavanin TAM degeri gecer');
  assert.equal(M.iskontoDenetle(15.01, 15).ok, false, 'bir ustu reddedilir');
  assert.equal(M.iskontoDenetle(0, 0).ok, true, 'tavan 0 iken %0 gecer');
  assert.equal(M.iskontoDenetle(1, 0).ok, false, 'tavan 0 iken %1 reddedilir');

  const ret = M.iskontoDenetle(30, 15);

  assert.equal(ret.ok, false);
  assert.equal(ret.tavan, 15);
  assert.match(ret.hata, /%15/, 'hata tavani soyler');

  /* Geçersiz istenen oran. */
  assert.equal(M.iskontoDenetle(-1, 15).ok, false);
  assert.equal(M.iskontoDenetle(NaN, 15).ok, false);
  assert.equal(M.iskontoDenetle(Infinity, 15).ok, false);
});

test('iskontoYaz: tavanı aşan istek TAVANA kırpılır ve uyarı döner', (t) => {
  const s = M.sepetKur();

  let karar = M.iskontoYaz(s, 10, 15);
  assert.equal(karar.ok, true);
  assert.equal(s.iskonto, 10);

  karar = M.iskontoYaz(s, 40, 15);
  assert.equal(karar.ok, false, 'asim bildirildi');
  assert.equal(s.iskonto, 15, 'sepete TAVAN yazildi, 40 DEGIL');
});

test('toplamlar: arayüz kurcalansa bile tavan üstü iskonto UYGULANMAZ', (t) => {
  const s = M.sepetKur();

  M.ekle(s, u(1, 'A', 100, 1), 1);

  /* Sepete elle %90 yazılmış (arayüz hatası ya da kurcalama). */
  s.iskonto = 90;

  const t1 = M.toplamlar(s, 10);

  assert.equal(t1.iskontoOrani, 10, 'tavan uygulandi');
  assert.equal(t1.genelToplam, 90, '100 - %10 = 90 (10 DEGIL)');
});

/* =========================================================================
 * 4. SON SİPARİŞİ KOPYALA
 * ====================================================================== */

test('sonSiparisiKopyala: kalemler sepete dolar, BUGÜNÜN fiyatı kullanılır', (t) => {
  const bul = katalog([u(1, 'Silikon', 15, 24), u(2, 'Çivi', 3, 1)]);

  const siparis = {
    line_items: [
      { product_id: 1, quantity: 48, name: 'Silikon', price: 10 },   // eski fiyat 10
      { product_id: 2, quantity: 5, name: 'Çivi', price: 2 }
    ]
  };

  const sonuc = M.sonSiparisiKopyala(siparis, bul);

  assert.equal(sonuc.eklenen, 2);
  assert.deepEqual(adetleri(sonuc.sepet), [[1, 48], [2, 5]]);

  /*
   * Eski fiyatı kopyalamak zam görmüş ürünü zararına satmak olurdu.
   */
  assert.equal(sonuc.sepet.satirlar[0].price, 15, 'bugunun fiyati (eski 10 DEGIL)');
  assert.equal(sonuc.sepet.satirlar[1].price, 3);
});

test('sonSiparisiKopyala: katalogda OLMAYAN kalem atlanır ve BİLDİRİLİR', (t) => {
  const bul = katalog([u(1, 'Silikon', 15, 24)]);

  const sonuc = M.sonSiparisiKopyala({
    line_items: [
      { product_id: 1, quantity: 24, name: 'Silikon' },
      { product_id: 99, quantity: 10, name: 'Kaldirilmis Urun' }
    ]
  }, bul);

  assert.equal(sonuc.eklenen, 1);
  assert.equal(sonuc.atlanan.length, 1, 'sessizce dusurulmez');
  assert.equal(sonuc.atlanan[0].id, 99);
  assert.equal(sonuc.atlanan[0].ad, 'Kaldirilmis Urun');
  assert.match(sonuc.atlanan[0].sebep, /katalogda yok/);
});

test('sonSiparisiKopyala: adetler satış birimine oturur', (t) => {
  const bul = katalog([u(1, 'Silikon', 15, 24)]);

  const sonuc = M.sonSiparisiKopyala({ line_items: [{ product_id: 1, quantity: 25 }] }, bul);

  assert.deepEqual(adetleri(sonuc.sepet), [[1, 48]], '25 -> 48');
});

test('sonSiparisiKopyala: sepet SONRASINDA tamamen düzenlenebilir', (t) => {
  const bul = katalog([u(1, 'Silikon', 15, 24), u(2, 'Çivi', 3, 1), u(3, 'Mastik', 8, 12)]);

  const sonuc = M.sonSiparisiKopyala({
    line_items: [{ product_id: 1, quantity: 24 }, { product_id: 2, quantity: 5 }]
  }, bul);

  const s = sonuc.sepet;

  /* Adet artır */
  M.adimlaSatir(s, 1, 1);
  assert.equal(s.satirlar[M.satirBul(s, 1)].adet, 48, 'adet artirilabilir');

  /* Adet azalt */
  M.adetYaz(s, 2, 3);
  assert.equal(s.satirlar[M.satirBul(s, 2)].adet, 3, 'adet azaltilabilir');

  /* Kalem sil */
  M.sil(s, 2);
  assert.equal(M.satirBul(s, 2), -1, 'kalem silinebilir');

  /* Yeni ürün ekle */
  M.ekle(s, bul(3), 12);
  assert.equal(M.satirBul(s, 3) !== -1, true, 'yeni urun eklenebilir');
  assert.equal(s.satirlar.length, 2);
});

test('sonSiparisiKopyala: bozuk girdi çökertmez', (t) => {
  const bul = katalog([u(1, 'A', 10, 1)]);

  assert.equal(M.sonSiparisiKopyala(null, bul).eklenen, 0);
  assert.equal(M.sonSiparisiKopyala({}, bul).eklenen, 0);
  assert.equal(M.sonSiparisiKopyala({ line_items: 'bozuk' }, bul).eklenen, 0);
  assert.equal(M.sonSiparisiKopyala({ line_items: [{ product_id: 0 }] }, bul).eklenen, 0);
  assert.equal(M.sonSiparisiKopyala({ line_items: [{ product_id: 1 }] }, null).eklenen, 0, 'urunBul yoksa');

  /* urunBul patlarsa kalem atlanır, akış sürer. */
  const patlak = M.sonSiparisiKopyala(
    { line_items: [{ product_id: 1, name: 'A' }] },
    function () { throw new Error('depo kapali'); }
  );

  assert.equal(patlak.eklenen, 0);
  assert.equal(patlak.atlanan.length, 1);
});

test('sonSiparisiKopyala: var olan sepetin ÜSTÜNE de yazabilir', (t) => {
  const bul = katalog([u(1, 'A', 10, 1), u(2, 'B', 10, 1)]);

  const s = M.sepetKur();
  M.ekle(s, bul(1), 2);

  M.sonSiparisiKopyala({ line_items: [{ product_id: 2, quantity: 3 }] }, bul, s);

  assert.equal(s.satirlar.length, 2, 'mevcut satir korundu');
});

/* =========================================================================
 * 5. GEÇİCİ MÜŞTERİ
 * ====================================================================== */

test('geciciMusteri: temp_musteri_<uuid> biçiminde METİN kimlik üretir', (t) => {
  const sonuc = M.geciciMusteri({ unvan: 'Ege Hırdavat Ltd.', vergiNo: '1234567890', il: 'İzmir' });

  assert.equal(sonuc.ok, true);

  const id = sonuc.musteri.id;

  assert.equal(typeof id, 'string', 'METIN - sayisal WP kimligiyle karismaz');
  assert.ok(id.startsWith(M.GECICI_ONEK), 'onek: ' + id);
  assert.match(id.slice(M.GECICI_ONEK.length), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'UUID v4 bicimi: ' + id);

  assert.equal(sonuc.musteri.gecici, true);
  assert.equal(sonuc.musteri.senkron, false, 'henuz sunucuda yok');
  assert.equal(sonuc.musteri.unvan, 'Ege Hırdavat Ltd.');
  assert.equal(sonuc.musteri.vergiNo, '1234567890');
  assert.equal(sonuc.musteri.il, 'İzmir');
  assert.ok(sonuc.musteri.olusturma, 'olusturma zamani var');
});

test('geciciMusteri: ünvan ZORUNLU', (t) => {
  [undefined, null, '', '   '].forEach((x) => {
    const r = M.geciciMusteri({ unvan: x });
    assert.equal(r.ok, false, 'deger: ' + String(x));
    assert.equal(r.musteri, null);
    assert.match(r.hata, /ünvan/i);
  });

  assert.equal(M.geciciMusteri(null).ok, false, 'bilgi yoksa');
});

test('geciciMusteri: her çağrıda BENZERSİZ kimlik (çakışma olmaz)', (t) => {
  const kumeler = new Set();

  for (let i = 0; i < 500; i++) {
    kumeler.add(M.geciciMusteri({ unvan: 'Firma ' + i }).musteri.id);
  }

  assert.equal(kumeler.size, 500, '500 kayit, 500 ayri kimlik');
});

test('geciciMi: geçici ve gerçek kimlikleri ayırır', (t) => {
  const id = M.geciciMusteri({ unvan: 'X' }).musteri.id;

  assert.equal(M.geciciMi(id), true);
  assert.equal(M.geciciMi('temp_musteri_abc'), true);

  assert.equal(M.geciciMi(42), false, 'sayisal WP kimligi gecici DEGIL');
  assert.equal(M.geciciMi('42'), false);
  assert.equal(M.geciciMi(''), false);
  assert.equal(M.geciciMi(null), false);
  assert.equal(M.geciciMi(undefined), false);
  assert.equal(M.geciciMi('musteri_temp_x'), false, 'onek BASTA olmali');
});

test('uuid: biçim doğru ve tekrar etmez', (t) => {
  const a = M.uuid();
  const b = M.uuid();

  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

/* =========================================================================
 * 6. SİPARİŞ DENETİMİ VE GÖVDESİ
 * ====================================================================== */

test('odemeGecerliMi: YALNIZCA üç yöntem', (t) => {
  assert.deepEqual(M.ODEME_YONTEMLERI, ['nakit', 'vade', 'kart']);

  ['nakit', 'vade', 'kart'].forEach((y) => assert.equal(M.odemeGecerliMi(y), true, y));
  ['havale', 'eft', 'cek', '', null, undefined, 'NAKIT'].forEach((y) => {
    assert.equal(M.odemeGecerliMi(y), false, 'reddedilir: ' + String(y));
  });
});

test('siparisDenetle: eksikleri tek tek söyler', (t) => {
  const s = M.sepetKur();

  let d = M.siparisDenetle(s, 10);

  assert.equal(d.ok, false);
  assert.ok(d.hatalar.some((h) => /Müşteri/.test(h)), 'musteri eksik');
  assert.ok(d.hatalar.some((h) => /Sepet boş/.test(h)), 'sepet bos');
  assert.ok(d.hatalar.some((h) => /Ödeme/.test(h)), 'odeme eksik');

  /* Tek tek tamamlanınca hatalar düşer. */
  s.musteri = { id: 42, unvan: 'X' };
  M.ekle(s, u(1, 'A', 10, 1), 2);
  s.odeme = 'nakit';

  d = M.siparisDenetle(s, 10);
  assert.equal(d.ok, true, 'hatalar: ' + d.hatalar.join(' | '));
});

test('siparisDenetle: GEÇİCİ müşteri de geçerli müşteridir', (t) => {
  const s = M.sepetKur();

  s.musteri = M.geciciMusteri({ unvan: 'Yeni Bayi' }).musteri;
  M.ekle(s, u(1, 'A', 10, 1), 1);
  s.odeme = 'vade';

  assert.equal(M.siparisDenetle(s, 0).ok, true, 'cevrimdisi eklenen musteriyle siparis yazilabilir');
});

test('siparisDenetle: tavanı aşan iskonto siparişi ENGELLER', (t) => {
  const s = M.sepetKur();

  s.musteri = { id: 42 };
  M.ekle(s, u(1, 'A', 10, 1), 1);
  s.odeme = 'nakit';
  s.iskonto = 50;

  const d = M.siparisDenetle(s, 10);

  assert.equal(d.ok, false);
  assert.ok(d.hatalar.some((h) => /iskonto/i.test(h)), 'iskonto hatasi: ' + d.hatalar.join(' | '));
});

test('siparisGovdesi: sunucuya gidecek gövde eksiksiz', (t) => {
  const s = M.sepetKur();

  s.musteri = { id: 42, unvan: 'Ege Hırdavat' };
  s.odeme = 'vade';
  s.vadeNotu = 'Vadeli siparişler 30 gün içinde nakden tahsil edilir.';
  s.siparisNotu = 'Kapıda imza ile teslim.';
  s.iskonto = 8;

  M.ekle(s, u(1, 'Silikon', 12.5, 24), 48);

  const g = M.siparisGovdesi(s, { id: 7, ad: 'Ahmet' }, 10);

  assert.equal(g.plasiyerId, 7);
  assert.equal(g.musteriId, 42);
  assert.equal(g.geciciMusteri, null, 'gercek musteride gecici alan bos');
  assert.equal(g.odeme, 'vade');
  assert.match(g.vadeNotu, /30 gün/);
  assert.match(g.siparisNotu, /imza/);
  assert.equal(g.iskontoOrani, 8);
  assert.equal(g.toplamlar.araToplam, 600);
  assert.equal(g.kalemler.length, 1);
  assert.equal(g.kalemler[0].product_id, 1);
  assert.equal(g.kalemler[0].quantity, 48);
  assert.equal(g.kalemler[0].koli_ici_adet, 24);
});

test('siparisGovdesi: geçici müşteri gövdeye TAM kayıt olarak girer', (t) => {
  const s = M.sepetKur();

  s.musteri = M.geciciMusteri({ unvan: 'Yeni Bayi', vergiNo: '1234567890' }).musteri;
  s.odeme = 'nakit';

  M.ekle(s, u(1, 'A', 10, 1), 1);

  const g = M.siparisGovdesi(s, { id: 7 }, 0);

  assert.ok(M.geciciMi(g.musteriId), 'kimlik gecici');
  assert.ok(g.geciciMusteri, 'kayit gonderilir - sunucu musteriyi olusturabilsin');
  assert.equal(g.geciciMusteri.unvan, 'Yeni Bayi');
  assert.equal(g.geciciMusteri.vergiNo, '1234567890');
});

test('siparisGovdesi: tavan gövdedeki orana da uygulanır', (t) => {
  const s = M.sepetKur();

  s.musteri = { id: 1 };
  s.odeme = 'nakit';
  s.iskonto = 90;          // kurcalanmış

  M.ekle(s, u(1, 'A', 100, 1), 1);

  const g = M.siparisGovdesi(s, { id: 7 }, 5);

  assert.equal(g.iskontoOrani, 5, 'tavan uygulandi');
  assert.equal(g.toplamlar.genelToplam, 95);
});
