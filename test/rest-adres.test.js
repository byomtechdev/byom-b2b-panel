'use strict';
/* ============================================================================
 *  REST ADRES KURULUMU — main.js yol/taban birleştirme testleri
 *  ---------------------------------------------------------------------------
 *  `main.js` Electron'a bağlı olduğu için `require` EDİLEMEZ. Bu yüzden iki
 *  yöntem birlikte kullanılıyor:
 *
 *   1) DAVRANIŞ: ilgili saf fonksiyonun GÖVDESİ kaynaktan çıkarılıp
 *      `new Function` ile kendi başına koşturulur. Yani gerçek üretim kodu
 *      sınanıyor — kopyası değil. Fonksiyon yeniden adlandırılır/silinirse
 *      test "bulunamadı" diye kırılır, sessizce geçmez.
 *   2) KAYNAK DENETİMİ: fonksiyonun DOĞRU YERLERDE ÇAĞRILDIĞI regex ile
 *      doğrulanır. Motor kusursuz olsa da çağrılmıyorsa hiçbir işe yaramaz —
 *      bu boşluk Faz 4 ve Faz 6'da iki kez canımızı yaktı.
 *
 *  Kilitlenen sözler:
 *   · İstek adresi ile HATA MESAJINDAKİ adres AYNI kaynaktan gelir (çift bölü
 *     çizgisi yüzünden kullanıcı yanlış teşhise sürüklenmişti).
 *   · Taban adresi gövdesindeki çift bölüler ve bozuk protokoller temizlenir.
 *   · Sorgu dizesi yol sıkıştırmasından ETKİLENMEZ.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n?/g, '\n');

/** Kaynaktan bir fonksiyon gövdesi çıkarıp çalıştırılabilir hâle getirir. */
function fonksiyonuCikar(ad) {
  const basla = MAIN.indexOf('function ' + ad + '(');

  assert.notEqual(basla, -1, ad + ' fonksiyonu main.js icinde bulunamadi');

  const kalan = MAIN.slice(basla);
  const bitis = kalan.indexOf('\n}\n');

  assert.notEqual(bitis, -1, ad + ' govdesinin sonu bulunamadi');

  return new Function('return ' + kalan.slice(0, bitis + 3))();
}

const restYoluKur = fonksiyonuCikar('restYoluKur');
const tabanAdresiTemizle = fonksiyonuCikar('tabanAdresiTemizle');

/* =========================================================================
 * 1. restYoluKur — /wp-json/<ad alanı>/<uç>
 * ====================================================================== */

test('restYoluKur: tek bolu ile birlestirir', (t) => {
  assert.equal(restYoluKur('wc-b2b/v1', '/admin/plasiyerler'), '/wp-json/wc-b2b/v1/admin/plasiyerler');
  assert.equal(restYoluKur('wc-b2b/v1', 'admin/plasiyerler'), '/wp-json/wc-b2b/v1/admin/plasiyerler');
  assert.equal(restYoluKur('wc/v3', '/products'), '/wp-json/wc/v3/products');
});

test('restYoluKur: CIFT BOLU hicbir konumda kalmaz', (t) => {
  /* Kullanicinin bildirdigi belirti: /wp-json/wc-b2b/v1//admin/plasiyerler */
  assert.equal(restYoluKur('wc-b2b/v1', '//admin/plasiyerler'), '/wp-json/wc-b2b/v1/admin/plasiyerler');
  assert.equal(restYoluKur('wc-b2b/v1/', '/admin/plasiyer'), '/wp-json/wc-b2b/v1/admin/plasiyer');
  assert.equal(restYoluKur('/wc-b2b/v1/', '//admin//plasiyer//'), '/wp-json/wc-b2b/v1/admin/plasiyer');

  /* Hicbir ciktida "//" olmamali — genel kural. */
  [['wc-b2b/v1', '/a'], ['/wc/v3/', '//b//c'], ['b2b/v1', '']].forEach(function ([alan, yol]) {
    assert.ok(restYoluKur(alan, yol).indexOf('//') === -1,
      'cift bolu kaldi: ' + restYoluKur(alan, yol));
  });
});

test('restYoluKur: bos/eksik girdi cokme uretmez', (t) => {
  assert.equal(restYoluKur('b2b/v1', ''), '/wp-json/b2b/v1');
  assert.equal(restYoluKur('b2b/v1', null), '/wp-json/b2b/v1');
  assert.equal(restYoluKur('b2b/v1', undefined), '/wp-json/b2b/v1');
  assert.equal(restYoluKur('', '/x'), '/wp-json/x');
  assert.equal(restYoluKur('', ''), '/wp-json');
});

test('restYoluKur: yol icindeki sayisal/çok parcali ucler korunur', (t) => {
  assert.equal(restYoluKur('wc-b2b/v1', '/orders/12/revise'), '/wp-json/wc-b2b/v1/orders/12/revise');
  assert.equal(restYoluKur('wc/v3', '/products/categories/7'), '/wp-json/wc/v3/products/categories/7');
});

/* =========================================================================
 * 2. tabanAdresiTemizle — kullanıcının ELLE yazdığı mağaza adresi
 * ====================================================================== */

test('tabanAdresiTemizle: normal girdiler', (t) => {
  assert.equal(tabanAdresiTemizle('https://site.com'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('https://site.com/'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('site.com'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('  https://site.com  '), 'https://site.com');
  assert.equal(tabanAdresiTemizle(''), '');
  assert.equal(tabanAdresiTemizle(null), '');
});

test('tabanAdresiTemizle: GOVDEDEKI cift bolu temizlenir', (t) => {
  /*
   * `new URL` govdedeki cift boluyu NORMALIZE ETMEZ: pathname "//shop/..."
   * olarak gider ve WordPress 404 doner. Kullanicinin gordugu sey yine
   * "eklenti bulunamadi" olur — yanlis iz.
   */
  assert.equal(tabanAdresiTemizle('https://site.com//shop'), 'https://site.com/shop');
  assert.equal(tabanAdresiTemizle('https://site.com///magaza//'), 'https://site.com/magaza');

  const u = new URL(tabanAdresiTemizle('https://site.com//shop') + '/wp-json/wc-b2b/v1/x');

  assert.equal(u.host, 'site.com');
  assert.equal(u.pathname, '/shop/wp-json/wc-b2b/v1/x');
});

test('tabanAdresiTemizle: BOZUK PROTOKOL duzeltilir (host "https" olmaz)', (t) => {
  /*
   * Eski hâl `/^https?:\/\//` testini kullaniyordu; "https:/site.com" onu
   * gecemedigi icin BASINA BIR PROTOKOL DAHA ekleniyordu:
   *     "https://https:/site.com"
   * Bu GECERLI bir URL oldugu icin "Site adresi gecersiz" kapisi hic acilmiyor,
   * host literal olarak "https" oluyordu ve kullanici "adres hatali" yerine
   * "sunucuya ulasilamiyor" goruyordu.
   */
  assert.equal(tabanAdresiTemizle('https:/site.com'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('https:site.com'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('//site.com'), 'https://site.com');

  ['https:/site.com', 'https:site.com', '//site.com'].forEach(function (ham) {
    const url = new URL(tabanAdresiTemizle(ham) + '/wp-json/x');

    assert.equal(url.host, 'site.com', ham + ' icin host site.com olmali');
    assert.notEqual(url.host, 'https', ham + ' icin host "https" OLMAMALI');
  });
});

test('tabanAdresiTemizle: yapistirilmis REST adresi kirpilir', (t) => {
  assert.equal(tabanAdresiTemizle('https://site.com/wp-json/wc/v3'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('https://site.com//wp-json/wc/v3'), 'https://site.com');
  assert.equal(tabanAdresiTemizle('https://site.com/shop/wp-json/'), 'https://site.com/shop');
});

test('tabanAdresiTemizle: localhost icin http (https yerel sunucuda yanit vermez)', (t) => {
  assert.equal(tabanAdresiTemizle('localhost:8080'), 'http://localhost:8080');
  assert.equal(tabanAdresiTemizle('127.0.0.1:8000'), 'http://127.0.0.1:8000');

  /* Acikca yazilan protokol KORUNUR — karar kullanicinin. */
  assert.equal(tabanAdresiTemizle('https://localhost:8080'), 'https://localhost:8080');
  assert.equal(tabanAdresiTemizle('http://site.com'), 'http://site.com');
});

/* =========================================================================
 * 3. SORGU DİZESİ — yol sıkıştırması onu BOZMAZ
 * ====================================================================== */

test('sorgu dizesindeki "//" yol sikistirmasindan ETKILENMEZ', (t) => {
  /*
   * Sartnamedeki regex (`([^:]\/)\/+` -> `$1`) TAM URL uzerinde kosarsa
   * sorgu degerlerini bozar: "?search=a//b" -> "?search=a/b".
   * Bu yuzden sikistirma YALNIZCA yol uzerinde, sorgu EKLENMEDEN ONCE yapilir;
   * sorgu `url.searchParams` ile sonra konur. Bu test o sirayi kilitler.
   */
  const url = new URL('https://site.com' + restYoluKur('wc/v3', '/products'));

  url.searchParams.set('search', 'a//b');
  url.searchParams.set('adres', 'https://cdn.x/a.jpg');

  assert.equal(url.pathname, '/wp-json/wc/v3/products', 'yol temiz');
  assert.equal(url.searchParams.get('search'), 'a//b', 'sorgu degeri BOZULMADI');
  assert.equal(url.searchParams.get('adres'), 'https://cdn.x/a.jpg', 'adres degeri korundu');
});

/* =========================================================================
 * 4. KAYNAK DENETİMİ — doğru yerlerde çağrılıyor mu?
 * ====================================================================== */

test('KAYNAK: istek adresi restYoluKur ile kurulur (elle birlestirme YOK)', (t) => {
  assert.match(MAIN, /const restYolu = restYoluKur\(alan, istek\.yol\);/,
    'apiIstek restYoluKur cagirmali');
  assert.match(MAIN, /url = new URL\(taban \+ restYolu\);/,
    'URL taban + restYolu ile kurulmali');

  /* Eski elle birlestirme geri DONMEMIS olmali. */
  assert.ok(!/'\/wp-json\/' \+ alan \+ '\/' \+ String\(istek\.yol/.test(MAIN),
    'elle /wp-json birlestirmesi geri donmus');
});

test('KAYNAK: HATA MESAJI da ayni kaynaktan gelir (cift bolu yanlis teshise yol acti)', (t) => {
  const blok = MAIN.slice(MAIN.indexOf("kod === 'rest_no_route'"));

  assert.match(blok.slice(0, 1600), /Aranan adres: ' \+ restYoluKur\(alan, istek\.yol\)/,
    'hata mesaji restYoluKur kullanmali');

  /* Mesaj UC olasiligi birden soylemeli: etkin degil / eski surum / WooCommerce
     kapali. Yalnizca "etkin degil" demek, kullaniciyi yanlis ize sokuyordu. */
  assert.match(blok.slice(0, 1600), /GÜNCEL DEĞİL|SÜRÜMÜ ESKİ/, 'eski surum olasiligi yazili');
  assert.match(blok.slice(0, 1600), /WooCommerce DEVRE DIŞI|WooCommerce gerektirir/,
    'WooCommerce kapali olasiligi yazili');
});

test('KAYNAK: sekmeAc rozet korumasi ELLE LISTE degil OZNITELIK okur', (t) => {
  /*
   * `sekmeAc` className'i yeniden kurarken `relative` sinifini yalnizca rozetli
   * dugmelere geri koyar. Eskiden liste ELLE yaziliydi
   * (`=== 'uyeler' || === 'destek'`) ve sonradan eklenen rozetli dugmeler
   * (notlarim, plasiyerler) listeye girmedigi icin rozetleri <nav>'in kosesine
   * kaciyordu. DOM testleri bunu goremez: onlar kendi `sekmeAc` taklidini
   * kullanir, yani uretimdeki bu satiri yalnizca kaynak denetimi kilitler.
   */
  const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').replace(/\r\n?/g, '\n');
  const blok = RENDERER.slice(RENDERER.indexOf('function sekmeAc')).slice(0, 2000);

  assert.match(blok, /const sayacli = '1' === btn\.dataset\.sayacli;/,
    'sayacli karari data-sayacli ozniteliginden okunmali');

  assert.ok(!/sayacli = btn\.dataset\.sekme === 'uyeler'/.test(blok),
    'elle yazilmis rozet listesi geri donmus');
});
