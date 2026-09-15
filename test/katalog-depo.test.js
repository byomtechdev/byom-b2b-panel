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
 *   7. SAYFALAMA (Faz 13): `araSayfali` kırpılmamış toplamı söyler, `ofset`
 *      ile sonraki dilim gelir; `ara()` geriye uyumlu dizi döndürmeye devam
 *      eder; `yalniz_koli` / `kdv_orani` taşınır; `SEMA` artmaz
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

/* =========================================================================
 * 9. SAYFALAMA — "500 kalem" yanılgısının kökü (Faz 13)
 *
 * Ürün sahibi ekranda solda "500 kalem", sağ üstte "1111 ürün" görüp sistemin
 * kataloğu yarım çektiğini sandı. Eşitleme 1111'in TAMAMINI yazıyordu; 500
 * yalnızca ARAMA SONUCU kırpmasıydı. Asıl zarar metin değildi: filtresiz
 * gezinmede alfabetik 501. üründen sonrası ERİŞİLEMEZDİ.
 * ====================================================================== */

/** 1111 ürünlük katalog kurar (sayfalama sınırlarını aşan gerçek boyut). */
async function kalabalikKatalog() {
  tazeDepo();

  const liste = [];

  /* Ad alfabetik sıralamaya girer; dolgulu numara sıranın tahmin edilebilir
     kalmasını sağlar (aksi hâlde "Urun 10" < "Urun 2" olur ve iki sayfanın
     kesişmediğini ölçmek zorlaşır). */
  for (let i = 1; i <= 1111; i++) {
    liste.push(urun(i, 'Urun ' + String(i).padStart(4, '0')));
  }

  await Depo.kataloguGuncelle(getirici(liste));

  return liste;
}

test('araSayfali: 1111 üründe toplam 1111 döner, sayfa 500\'dür', async (t) => {
  await kalabalikKatalog();

  assert.equal(Depo.durum().urun, 1111, 'esitleme TAMAMINI yazdi');

  const sayfa1 = Depo.araSayfali('');

  assert.equal(sayfa1.toplam, 1111, 'KIRPILMAMIS toplam soylenir');
  assert.equal(sayfa1.urunler.length, 500, 'tek sayfa EN_COK_SONUC kadar');
  assert.equal(sayfa1.ofset, 0);
  assert.equal(Depo.EN_COK_SONUC, 500, 'sayfa boyu sabiti');
});

test('araSayfali: ofset ikinci sayfayı verir ve hiçbir ürün iki sayfada birden çıkmaz', async (t) => {
  await kalabalikKatalog();

  const sayfa1 = Depo.araSayfali('');
  const sayfa2 = Depo.araSayfali('', { ofset: 500 });
  const sayfa3 = Depo.araSayfali('', { ofset: 1000 });

  assert.equal(sayfa2.urunler.length, 500);
  assert.equal(sayfa2.ofset, 500);
  assert.equal(sayfa2.toplam, 1111, 'toplam her sayfada ayni');
  assert.equal(sayfa3.urunler.length, 111, 'son sayfa kalani verir');

  const k1 = new Set(sayfa1.urunler.map((u) => u.id));
  const k2 = new Set(sayfa2.urunler.map((u) => u.id));

  sayfa2.urunler.forEach((u) => assert.equal(k1.has(u.id), false, 'urun ' + u.id + ' iki sayfada birden'));
  sayfa3.urunler.forEach((u) => {
    assert.equal(k1.has(u.id), false, 'urun ' + u.id + ' 1. ve 3. sayfada');
    assert.equal(k2.has(u.id), false, 'urun ' + u.id + ' 2. ve 3. sayfada');
  });

  /* Üç sayfa birlikte kataloğun TAMAMINI kapsar: 501. ürün artık erişilebilir. */
  const hepsi = new Set(
    sayfa1.urunler.concat(sayfa2.urunler, sayfa3.urunler).map((u) => u.id)
  );

  assert.equal(hepsi.size, 1111, 'sayfalarin birlesimi tum katalog');

  /* Ofset sonuç kümesinin dışındaysa boş dilim döner, toplam yine dogrudur. */
  const bos = Depo.araSayfali('', { ofset: 5000 });

  assert.equal(bos.urunler.length, 0);
  assert.equal(bos.toplam, 1111);
});

test('araSayfali: kırpma SÜZGEÇTEN SONRA yapılır — sorgu ve kategori toplamı daraltır', async (t) => {
  tazeDepo();

  const liste = [];

  for (let i = 1; i <= 700; i++) {
    liste.push(urun(i, (i % 2 === 0 ? 'Silikon ' : 'Vida ') + String(i).padStart(4, '0')));
  }

  await Depo.kataloguGuncelle(getirici(liste));

  const s = Depo.araSayfali('silikon');

  assert.equal(s.toplam, 350, 'toplam SUZGEC sonucudur, katalog boyu degil');
  assert.equal(s.urunler.length, 350, '500 altinda kaldigi icin kirpilmadi');

  /* Kırpılan sorguda da toplam gerçeği söyler. */
  const v = Depo.araSayfali('vida');

  assert.equal(v.toplam, 350);

  /* SKU tam eşleşmesi kırpmadan etkilenmez (kirpma en sonda). */
  assert.equal(Depo.araSayfali('SKU-699').urunler.length, 1, 'SKU ile her urun bulunur');
});

test('ara: hâlâ DİZİ döner ve araSayfali ile aynı dilimi verir (geriye uyum)', async (t) => {
  await kalabalikKatalog();

  const dizi = Depo.ara('');

  assert.ok(Array.isArray(dizi), 'ara() dizi dondurur - mevcut cagiranlar kirilmaz');
  assert.equal(dizi.length, 500);
  assert.equal(typeof dizi.slice, 'function');
  assert.equal(dizi.toplam, undefined, 'dizi uzerine alan iliştirilmedi');

  assert.deepEqual(
    dizi.map((u) => u.id),
    Depo.araSayfali('').urunler.map((u) => u.id),
    'iki yol ayni suzgec ve siralamayi kullanir'
  );

  /* Eski seçenekler aynen çalışır. */
  assert.equal(Depo.ara('', { adet: 10 }).length, 10);
  assert.equal(Depo.ara('', { adet: 10, ofset: 1105 }).length, 6, 'ofset dizi yolunda da gecerli');
});

/* =========================================================================
 * 10. YENİ ALANLAR — yalniz_koli ve kdv_orani (SEMA ARTMADAN)
 * ====================================================================== */

test('normalizeKayit: yalniz_koli sunucudan taşınır, alan yoksa false olur', (t) => {
  assert.equal(Depo.normalizeKayit({ byom: { yalnizKoli: true } }).yalniz_koli, true, 'REST eki');
  assert.equal(Depo.normalizeKayit({ yalniz_koli: true }).yalniz_koli, true, 'diskten okunan kayit');
  assert.equal(Depo.normalizeKayit({ byom: { yalnizKoli: false } }).yalniz_koli, false);

  /* ALAN YOKSA false: eski katalog dosyalari sema artmadigi icin okunmaya
     devam eder ve "sadece koli" rozeti yanlislikla yanmaz. */
  assert.equal(Depo.normalizeKayit({}).yalniz_koli, false, 'alan yoksa false');
  assert.equal(Depo.normalizeKayit({ byom: {} }).yalniz_koli, false);
});

test('normalizeKayit: kdv_orani taşınır, alan yoksa 0 olur (ekranda gösterilmez, fiş kullanır)', (t) => {
  assert.equal(Depo.normalizeKayit({ byom: { kdvOrani: 20 } }).kdv_orani, 20, 'REST eki');
  assert.equal(Depo.normalizeKayit({ kdv_orani: 10 }).kdv_orani, 10, 'diskten okunan kayit');
  assert.equal(Depo.normalizeKayit({ byom: { kdvOrani: '18' } }).kdv_orani, 18, 'metin sayiya cevrilir');

  [undefined, null, '', 'abc', NaN, false].forEach((k) => {
    assert.equal(Depo.normalizeKayit({ kdv_orani: k }).kdv_orani, 0, 'deger: ' + String(k));
  });

  assert.equal(Depo.normalizeKayit({}).kdv_orani, 0, 'alan yoksa 0');
});

test('SEMA ARTMADI: eski katalog dosyası geçerli kalır, eksik alanlar varsayılana düşer', (t) => {
  /*
   * SEMA'yi artirmak sahadaki katalog dosyalarini yok saydirir ve internetsiz
   * plasiyeri "once esitle" duvarina carpar. Yeni alanlar eksikken guvenle
   * varsayilana dustugu icin surum artirmaya GEREK YOK.
   */
  assert.equal(Depo.SEMA, 1, 'sema sabiti degismedi');

  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-kat-'));

  /* Faz 12 biçiminde, yeni alanları HİÇ taşımayan bir dosya. */
  fs.writeFileSync(
    path.join(dizin, Depo.DOSYA),
    JSON.stringify({
      sema: 1,
      sonGuncelleme: '2026-09-01T00:00:00.000Z',
      urunler: [
        { id: 1, name: 'Eski Silikon', sku: 'SKU-1', price: 10, koli_ici_adet: 24, categories: ['Kimyasallar'], image_url: '', local_image_path: '/yerel/1.jpg', is_spot: false }
      ]
    }),
    'utf8'
  );

  Depo.sifirla();
  Depo.kur({ dizin: dizin });

  assert.equal(Depo.durum().urun, 1, 'ESKI DOSYA OKUNDU - sahadaki katalog yok sayilmadi');

  const u = Depo.urunGetir(1);

  assert.equal(u.name, 'Eski Silikon');
  assert.equal(u.koli_ici_adet, 24, 'eski alanlar korundu');
  assert.equal(u.local_image_path, '/yerel/1.jpg', 'indirilmis gorsel korundu');
  assert.equal(u.yalniz_koli, false, 'yeni alan varsayilana dustu');
  assert.equal(u.kdv_orani, 0, 'yeni alan varsayilana dustu');
});

test('disk: yeni alanlar yazılıp geri okunur', async (t) => {
  const dizin = tazeDepo();

  await Depo.kataloguGuncelle(getirici([
    urun(1, 'Kolili', { byom: { koliIciAdet: 24, yalnizKoli: true, spot: false, barkod: '1', kdvOrani: 20 } }),
    urun(2, 'Tekil', { byom: { koliIciAdet: 1, yalnizKoli: false, spot: false, barkod: '2' } })
  ]));

  Depo.sifirla();
  Depo.kur({ dizin: dizin });

  assert.equal(Depo.urunGetir(1).yalniz_koli, true, 'diskten geri geldi');
  assert.equal(Depo.urunGetir(1).kdv_orani, 20);
  assert.equal(Depo.urunGetir(2).yalniz_koli, false);
  assert.equal(Depo.urunGetir(2).kdv_orani, 0, 'sunucu vermezse 0');
});
