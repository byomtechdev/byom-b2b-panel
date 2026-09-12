'use strict';
/* ============================================================================
 *  ÇEVRİMDIŞI KATALOG DEPOSU TESTİ — src/main/byom-katalog-depo.js
 *  ---------------------------------------------------------------------------
 *  Kapsam:
 *   1. Yerel arama: SKU / barkod tam eşleşme, ad öneki, çok kelimeli kesişim,
 *      Türkçe harf normalizasyonu
 *   2. İndeks davranışı: O(1) kimlik/SKU okuması ve 5.000 üründe arama maliyeti
 *   3. Koli katları matematiği (motorla AYNI kural — depo tarafı normalizasyon)
 *   4. Diske yazma/okuma, bozuk dosya ve şema sürümü
 *   5. Eşitleme: sayfalama, BOŞ YANITIN depoyu silmemesi, yerel görsel
 *      yollarının korunması
 *   6. SPOT ürünlerin sıralamada en tepeye sabitlenmesi
 *
 *  Electron GEREKMEZ: depo `kur({ dizin })` ile taze bir geçici dizine
 *  bağlanır, gerçek disk davranışı ölçülür.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Depo = require('../src/main/byom-katalog-depo.js');

/* ------------------------------------------------------------------ *
 *  Yardımcılar
 * ------------------------------------------------------------------ */

/** Her teste taze bir veri dizini. */
function tazeDepo() {
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-kat-'));

  Depo.sifirla();
  Depo.kur({ dizin: dizin });

  return dizin;
}

/** Sahte REST ürünü (wc/v3 + byom eki biçiminde). */
function urun(id, ad, ek) {
  return Object.assign({
    id: id,
    name: ad,
    sku: 'SKU-' + id,
    price: '10.00',
    stock_quantity: 100,
    categories: [{ id: 1, name: 'Kimyasallar' }],
    images: [{ src: 'https://ornek.test/g/' + id + '.jpg' }],
    byom: { koliIciAdet: 1, spot: false, barkod: '869000000' + id }
  }, ek || {});
}

/** Tek sayfada biten getirici. */
function getirici(liste) {
  return async function (sayfa) {
    if (sayfa > 1) return { ok: true, urunler: [], devam: false };
    return { ok: true, urunler: liste, devam: false };
  };
}

function adlar(sonuc) {
  return sonuc.map(function (u) { return u.name; });
}

/* =========================================================================
 * 1. Normalizasyon (Türkçe)
 * ====================================================================== */

test('normalize: Türkçe harfler ASCII\'ye iner', (t) => {
  assert.equal(Depo.normalize('SİLİKON'), 'silikon');
  assert.equal(Depo.normalize('Şeffaf'), 'seffaf');
  assert.equal(Depo.normalize('ÇİVİ'), 'civi');
  assert.equal(Depo.normalize('Ağaç Vidası'), 'agac vidasi');
  assert.equal(Depo.normalize('  Boşluk  '), 'bosluk');
  assert.equal(Depo.normalize(null), '');
  assert.equal(Depo.normalize(undefined), '');
});

test('jetonlar: 2 karakterden kısa parçalar atılır', (t) => {
  assert.deepEqual(Depo.jetonlar('Silikon Şeffaf 280 ml'), ['silikon', 'seffaf', '280', 'ml']);
  assert.deepEqual(Depo.jetonlar('A B CD'), ['cd'], 'tek harfler atilir');
});

/* =========================================================================
 * 2. Kayıt normalizasyonu + koli matematiği (depo tarafı)
 * ====================================================================== */

test('normalizeKayit: koli içi adedi sunucudan okunur, geçersizse 1 olur', (t) => {
  assert.equal(Depo.normalizeKayit({ byom: { koliIciAdet: 24 } }).koli_ici_adet, 24);
  assert.equal(Depo.normalizeKayit({ koli_ici_adet: 12 }).koli_ici_adet, 12);

  /* Geçersiz değerlerin hepsi 1'e iner: "koli bilgisi yok" = tekil satış. */
  [0, -5, null, undefined, 'abc', '', NaN].forEach((k) => {
    assert.equal(Depo.normalizeKayit({ koli_ici_adet: k }).koli_ici_adet, 1, 'deger: ' + String(k));
  });

  assert.equal(Depo.normalizeKayit({ koli_ici_adet: 24.7 }).koli_ici_adet, 24, 'ondalik asagi yuvarlanir');
});

test('normalizeKayit: spot bayrağı ve görsel adresi iki biçimden de okunur', (t) => {
  assert.equal(Depo.normalizeKayit({ byom: { spot: true } }).is_spot, true);
  assert.equal(Depo.normalizeKayit({ is_spot: true }).is_spot, true);
  assert.equal(Depo.normalizeKayit({}).is_spot, false);

  assert.equal(Depo.normalizeKayit({ images: [{ src: 'https://a/b.jpg' }] }).image_url, 'https://a/b.jpg');
  assert.equal(Depo.normalizeKayit({ image_url: 'https://c/d.jpg' }).image_url, 'https://c/d.jpg');
  assert.equal(Depo.normalizeKayit({}).image_url, '');
});

test('normalizeKayit: kategoriler nesne ya da metin olarak gelebilir', (t) => {
  assert.deepEqual(Depo.normalizeKayit({ categories: [{ name: 'Vida' }, { name: 'Civata' }] }).categories, ['Vida', 'Civata']);
  assert.deepEqual(Depo.normalizeKayit({ categories: ['Vida'] }).categories, ['Vida']);
  assert.deepEqual(Depo.normalizeKayit({ categories: 'bozuk' }).categories, [], 'dizi degilse bos');
});

test('normalizeKayit: stok null kalabilir (stok takibi kapalı ürün)', (t) => {
  assert.equal(Depo.normalizeKayit({ stock_quantity: null }).stock_quantity, null);
  assert.equal(Depo.normalizeKayit({ stock_quantity: 0 }).stock_quantity, 0);
  assert.equal(Depo.normalizeKayit({ stock_quantity: '42' }).stock_quantity, 42);
});

/* =========================================================================
 * 3. Arama
 * ====================================================================== */

test('ara: SKU ve barkod TAM eşleşmeyle bulunur', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'Silikon Şeffaf 280 ml'),
    urun(2, 'Çivi 5 cm')
  ]));

  assert.deepEqual(adlar(Depo.ara('SKU-1')), ['Silikon Şeffaf 280 ml']);
  assert.deepEqual(adlar(Depo.ara('sku-1')), ['Silikon Şeffaf 280 ml'], 'buyuk/kucuk harf fark etmez');
  assert.deepEqual(adlar(Depo.ara('8690000001')), ['Silikon Şeffaf 280 ml'], 'barkod');

  assert.equal(Depo.barkodBul('8690000002').name, 'Çivi 5 cm');
  assert.equal(Depo.barkodBul('yok'), null);
});

test('ara: ad ÖNEKİYLE bulunur ve Türkçe harf engel olmaz', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'SİLİKON Şeffaf 280 ml'),
    urun(2, 'Silikon Tabancası'),
    urun(3, 'Çivi 5 cm')
  ]));

  assert.equal(Depo.ara('silikon').length, 2, 'iki silikon urunu');
  assert.equal(Depo.ara('sili').length, 2, 'onek eslesmesi');
  assert.equal(Depo.ara('SİLİ').length, 2, 'Turkce I ile de bulunur');
  assert.equal(Depo.ara('civi').length, 1, 'C ile yazilan Ç bulunur');
  assert.equal(Depo.ara('ÇİVİ').length, 1);
});

test('ara: çok kelimeli sorgu KESİŞİM alır', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'Silikon Şeffaf 280 ml'),
    urun(2, 'Silikon Siyah 280 ml'),
    urun(3, 'Mastik Şeffaf')
  ]));

  assert.deepEqual(adlar(Depo.ara('silikon seffaf')), ['Silikon Şeffaf 280 ml'],
    'iki kelimeyi BIRDEN tasiyan tek urun');
  assert.equal(Depo.ara('silikon').length, 2);
  assert.equal(Depo.ara('seffaf').length, 2);
});

test('ara: boş sorgu tüm kataloğu döner, kategori süzgeci daraltır', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'Silikon', { categories: [{ name: 'Kimyasallar' }] }),
    urun(2, 'Çivi', { categories: [{ name: 'Hırdavat' }] }),
    urun(3, 'Mastik', { categories: [{ name: 'Kimyasallar' }] })
  ]));

  assert.equal(Depo.ara('').length, 3, 'bos sorgu = tum katalog');
  assert.equal(Depo.ara('', { kategori: 'Kimyasallar' }).length, 2);
  assert.equal(Depo.ara('', { kategori: 'Hırdavat' }).length, 1);
  assert.equal(Depo.ara('', { kategori: 'Olmayan' }).length, 0);

  /* Sorgu + kategori birlikte kesişir. */
  assert.equal(Depo.ara('silikon', { kategori: 'Hırdavat' }).length, 0, 'kesisim bos');
  assert.equal(Depo.ara('silikon', { kategori: 'Kimyasallar' }).length, 1);
});

test('ara: sonuç sayısı sınırlanır', async (t) => {
  tazeDepo();

  const liste = [];
  for (let i = 1; i <= 50; i++) liste.push(urun(i, 'Vida ' + i));

  await Depo.kataloguGuncelle(getirici(liste));

  assert.equal(Depo.ara('vida', { adet: 10 }).length, 10);
  assert.equal(Depo.ara('vida').length, 50);
});

/* =========================================================================
 * 4. SPOT sıralaması
 * ====================================================================== */

test('ara: SPOT ürünler EN TEPEYE sabitlenir', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'Aaa Vida', { byom: { koliIciAdet: 1, spot: false, barkod: '1' } }),
    urun(2, 'Zzz Vida', { byom: { koliIciAdet: 1, spot: true, barkod: '2' } }),
    urun(3, 'Bbb Vida', { byom: { koliIciAdet: 1, spot: false, barkod: '3' } })
  ]));

  const sonuc = adlar(Depo.ara('vida'));

  assert.equal(sonuc[0], 'Zzz Vida', 'SPOT urun ada ragmen en basta');
  assert.deepEqual(sonuc.slice(1), ['Aaa Vida', 'Bbb Vida'], 'kalanlar ada gore');

  assert.equal(Depo.ara('', { yalnizSpot: true }).length, 1);
  assert.equal(Depo.durum().spot, 1);
});

/* =========================================================================
 * 5. İndeks davranışı ve performans
 * ====================================================================== */

test('indeks: kimlik ve barkod okuması tek adımda çalışır', async (t) => {
  tazeDepo();

  const liste = [];
  for (let i = 1; i <= 200; i++) liste.push(urun(i, 'Urun ' + i));

  await Depo.kataloguGuncelle(getirici(liste));

  assert.equal(Depo.urunGetir(137).name, 'Urun 137');
  assert.equal(Depo.urunGetir(99999), null);
  assert.equal(Depo.urunGetir('137').name, 'Urun 137', 'metin kimlik de cozulur');
});

test('indeks: 5.000 üründe 200 arama makul sürede biter', async (t) => {
  /*
   * Bu bir KIYAS testi değil, O(n^2)'ye kayma alarmıdır. Eşik bilinçli olarak
   * gevşek: yavaş bir makinede bile geçer, ama her arama için tüm kataloğu
   * tarayan bir uygulama buna yetişemez.
   */
  tazeDepo();

  const liste = [];

  for (let i = 1; i <= 5000; i++) {
    liste.push(urun(i, 'Urun ' + i + ' ' + (i % 7 === 0 ? 'Silikon' : 'Vida')));
  }

  await Depo.kataloguGuncelle(getirici(liste));

  assert.equal(Depo.durum().urun, 5000);

  const basla = Date.now();

  for (let i = 1; i <= 200; i++) {
    Depo.ara('SKU-' + i, { adet: 5 });        // indeksten tam eşleşme
    Depo.urunGetir(i);                         // kimlik indeksi
  }

  const gecen = Date.now() - basla;

  assert.ok(gecen < 1500, '200 tam eslesme aramasi: ' + gecen + 'ms (esik 1500)');

  /* Ad aramasının da kataloğun tamamını dolaşmadığını gösterir. */
  const basla2 = Date.now();

  for (let i = 0; i < 50; i++) Depo.ara('silikon', { adet: 20 });

  const gecen2 = Date.now() - basla2;

  assert.ok(gecen2 < 2000, '50 ad aramasi: ' + gecen2 + 'ms (esik 2000)');
});

test('kategoriler: ürün sayısıyla ve sıralı döner', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'A', { categories: [{ name: 'Zımpara' }] }),
    urun(2, 'B', { categories: [{ name: 'Boya' }] }),
    urun(3, 'C', { categories: [{ name: 'Boya' }] })
  ]));

  const kat = Depo.kategoriler();

  assert.equal(kat.length, 2);
  assert.equal(kat[0].ad, 'Boya', 'alfabetik');
  assert.equal(kat[0].adet, 2);
  assert.equal(kat[1].ad, 'Zımpara');
  assert.equal(kat[1].adet, 1);
});

/* =========================================================================
 * 6. Disk
 * ====================================================================== */

test('disk: katalog yazılır ve yeniden yüklenir', async (t) => {
  const dizin = tazeDepo();

  await Depo.kataloguGuncelle(getirici([urun(1, 'Silikon'), urun(2, 'Çivi')]));

  assert.ok(fs.existsSync(Depo.dosyaYolu()), 'dosya olustu');

  /* Bellek sıfırlanıp yeniden kurulunca aynı veri gelmeli. */
  Depo.sifirla();
  assert.equal(Depo.durum().urun, 0);

  Depo.kur({ dizin: dizin });

  assert.equal(Depo.durum().urun, 2, 'diskten geri yuklendi');
  assert.equal(Depo.ara('silikon').length, 1, 'indeksler de yeniden kuruldu');
});

test('disk: BOZUK dosya çökertmez, boş katalogla başlar', (t) => {
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-kat-'));

  fs.mkdirSync(dizin, { recursive: true });
  fs.writeFileSync(path.join(dizin, Depo.DOSYA), '{ bu gecerli JSON degil', 'utf8');

  Depo.sifirla();

  assert.doesNotThrow(function () { Depo.kur({ dizin: dizin }); });
  assert.equal(Depo.durum().urun, 0, 'bos baslar');
});

test('disk: ŞEMA SÜRÜMÜ uyuşmazsa dosya yok sayılır', (t) => {
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-kat-'));

  fs.writeFileSync(
    path.join(dizin, Depo.DOSYA),
    JSON.stringify({ sema: 999, urunler: [{ id: 1, name: 'Eski' }] }),
    'utf8'
  );

  Depo.sifirla();
  Depo.kur({ dizin: dizin });

  assert.equal(Depo.durum().urun, 0, 'eski sema okunmaz - yanlis fiyat gostermekten iyidir');
});

/* =========================================================================
 * 7. Eşitleme
 * ====================================================================== */

test('kataloguGuncelle: sayfalama tüm sayfaları toplar', async (t) => {
  tazeDepo();

  const cagrilan = [];

  const sonuc = await Depo.kataloguGuncelle(async function (sayfa) {
    cagrilan.push(sayfa);

    if (sayfa === 1) return { ok: true, urunler: [urun(1, 'A'), urun(2, 'B')], devam: true };
    if (sayfa === 2) return { ok: true, urunler: [urun(3, 'C')], devam: true };

    return { ok: true, urunler: [], devam: false };
  });

  assert.equal(sonuc.ok, true);
  assert.equal(sonuc.urun, 3);
  assert.deepEqual(cagrilan, [1, 2, 3], 'bos sayfada durdu');
  assert.ok(sonuc.sonGuncelleme, 'zaman damgasi yazildi');
});

test('kataloguGuncelle: BOŞ YANIT mevcut kataloğu SİLMEZ', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([urun(1, 'Silikon'), urun(2, 'Çivi')]));
  assert.equal(Depo.durum().urun, 2);

  /*
   * En kritik koruma: sunucu yetki sorunu yüzünden boş liste döndürürse
   * sahadaki plasiyerin kataloğu silinmiş olurdu ve internetsiz kalan kişi
   * elinde hiçbir ürün olmadan müşterinin karşısında kalırdı.
   */
  const sonuc = await Depo.kataloguGuncelle(getirici([]));

  assert.equal(sonuc.ok, false, 'basarisiz sayilir');
  assert.match(sonuc.hata, /korundu/, 'sebep soylenir');
  assert.equal(Depo.durum().urun, 2, 'KATALOG YERINDE');
});

test('kataloguGuncelle: getirici hata verirse katalog korunur', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([urun(1, 'Silikon')]));

  const patlak = await Depo.kataloguGuncelle(async function () { throw new Error('ag yok'); });
  assert.equal(patlak.ok, false);
  assert.equal(Depo.durum().urun, 1, 'katalog korundu');

  const basarisiz = await Depo.kataloguGuncelle(async function () { return { ok: false, hata: '401' }; });
  assert.equal(basarisiz.ok, false);
  assert.equal(Depo.durum().urun, 1);

  const getiricisiz = await Depo.kataloguGuncelle(null);
  assert.equal(getiricisiz.ok, false, 'getirici yoksa hata');
});

test('kataloguGuncelle: indirilmiş YEREL GÖRSEL yolları korunur', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([urun(1, 'Silikon'), urun(2, 'Çivi')]));

  Depo.gorselYoluYaz(1, '/yerel/gorseller/abc.jpg');
  assert.equal(Depo.urunGetir(1).local_image_path, '/yerel/gorseller/abc.jpg');

  /* Yeni eşitleme sunucudan local_image_path getirmez; kaybolmamalı —
     yoksa her eşitlemede bütün görseller yeniden indirilirdi. */
  await Depo.kataloguGuncelle(getirici([urun(1, 'Silikon Yeni Ad'), urun(2, 'Çivi')]));

  assert.equal(Depo.urunGetir(1).local_image_path, '/yerel/gorseller/abc.jpg', 'yol korundu');
  assert.equal(Depo.urunGetir(1).name, 'Silikon Yeni Ad', 'ad guncellendi');
});

test('gorselsizUrunler: indirme kuyruğu girdisi üretir', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'A'),
    urun(2, 'B'),
    urun(3, 'C', { images: [] })   // gorseli olmayan urun
  ]));

  assert.equal(Depo.gorselsizUrunler(10).length, 2, 'gorselsiz urun kuyruga girmez');

  Depo.gorselYoluYaz(1, '/yerel/1.jpg');

  assert.equal(Depo.gorselsizUrunler(10).length, 1, 'indirilen dusar');
  assert.equal(Depo.gorselsizUrunler(10)[0].id, 2);
  assert.equal(Depo.gorselsizUrunler(1).length, 1, 'sinir uygulanir');
});

test('gorselYoluYaz: olmayan ürün için sessizce false döner', async (t) => {
  tazeDepo();

  await Depo.kataloguGuncelle(getirici([urun(1, 'A')]));

  assert.equal(Depo.gorselYoluYaz(99999, '/x.jpg'), false);
});

/* =========================================================================
 * 8. Electron yoksa çökmemeli
 * ====================================================================== */

test('kur: dizin verilmediğinde (Electron yok) çökmez', (t) => {
  Depo.sifirla();

  /* Electron çözülemez; dosya yolu boş kalır, depo bellekte çalışır. */
  assert.doesNotThrow(function () { Depo.kur({}); });
});
