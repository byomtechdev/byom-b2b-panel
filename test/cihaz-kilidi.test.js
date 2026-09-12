'use strict';
/* ============================================================================
 *  YÖNETİCİ MASTER PIN VE CİHAZ KİLİDİ — BİRİM TESTLERİ
 *  ---------------------------------------------------------------------------
 *  Kilitlenen sözler:
 *   1. Düz metin PIN diske YAZILMAZ; özet tuzlu ve her seferinde farklı.
 *   2. Hatalı PIN reddedilir; 3 denemede 60 saniye kilit; süre dolunca hak yenilenir.
 *   3. Özet ARAYÜZE DÖNMEZ (maskele) ve korumalı alanlar genel yazma
 *      kanalından GEÇMEZ (suz) — kilidin tamamı buna dayanıyor.
 *   4. Cihaz kilitleme/açma durum geçişleri; PIN'siz kilitleme REDDEDİLİR.
 *   5. Kilit açma ekranı kaba kuvvet sayacından muaf DEĞİL.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const Kilit = require(path.join(__dirname, '..', 'src', 'main', 'byom-yonetici-kilit.js'));

/** Geçerli bir Master PIN. */
const DOGRU = '135790';
const YANLIS = '000000';

/** Kurulu PIN'li taze ayar nesnesi. */
function ayarlarKur(pin) {
  const kur = Kilit.pinKur(pin || DOGRU, {});

  assert.equal(kur.ok, true, 'kurulum basarili olmali');

  return Object.assign({ cihazRolu: 'standart' }, kur.yazilacak);
}

/** `yazilacak` alanını ayarlara uygular (main.js'in yaptığı iş). */
function uygula(ayarlar, sonuc) {
  return Object.assign({}, ayarlar, (sonuc && sonuc.yazilacak) || {});
}

/* =========================================================================
 * 1. PIN BİÇİMİ
 * ====================================================================== */

test('PIN biçimi: TAM 6 hane ve yalnizca rakam', (t) => {
  assert.equal(Kilit.pinBicimi('135790').ok, true);

  /* Eksik/fazla hane reddedilir. */
  assert.equal(Kilit.pinBicimi('12345').ok, false, '5 hane');
  assert.equal(Kilit.pinBicimi('1234567').ok, false, '7 hane');
  assert.equal(Kilit.pinBicimi('').ok, false, 'bos');

  /* Rakam disi reddedilir — harfli "PIN" sessizce kabul edilmemeli. */
  assert.equal(Kilit.pinBicimi('12a456').ok, false, 'harf');
  assert.equal(Kilit.pinBicimi('12-456').ok, false, 'tire');
  assert.equal(Kilit.pinBicimi(null).ok, false, 'null');
  assert.equal(Kilit.pinBicimi(undefined).ok, false, 'undefined');

  /* Bas/son bosluk kirpilir: kullanici farkinda olmadan yapistirabilir. */
  const b = Kilit.pinBicimi('  135790  ');
  assert.equal(b.ok, true, 'bosluklu girdi kirpilir');
  assert.equal(b.pin, '135790');

  /* Hata mesaji hane sayisini SOYLER. */
  assert.match(Kilit.pinBicimi('123').hata, /6 haneli/);
});

/* =========================================================================
 * 2. HASHLEME
 * ====================================================================== */

test('ozetleme: duz metin PIN ozette GECMEZ', (t) => {
  const o = Kilit.ozetle(DOGRU);

  assert.equal(o.ok, true);
  assert.ok(!o.hash.includes(DOGRU), 'PIN ozetin icinde gorunmuyor');
  assert.match(o.hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/, 'beklenen bicim');
});

test('ozetleme: AYNI PIN her seferinde FARKLI ozet uretir (tuz)', (t) => {
  const a = Kilit.ozetle(DOGRU).hash;
  const b = Kilit.ozetle(DOGRU).hash;

  assert.notEqual(a, b, 'tuz rastgele — hazir tablo ise yaramaz');

  /* Ama ikisi de ayni PIN'i dogrular. */
  assert.equal(Kilit.dogrula(DOGRU, a), true);
  assert.equal(Kilit.dogrula(DOGRU, b), true);
});

test('ozetleme: gecersiz bicim ozetlenmez', (t) => {
  assert.equal(Kilit.ozetle('123').ok, false);
  assert.equal(Kilit.ozetle('abcdef').ok, false);
});

test('dogrulama: yanlis PIN ve bozuk ozet REDDEDILIR', (t) => {
  const hash = Kilit.ozetle(DOGRU).hash;

  assert.equal(Kilit.dogrula(DOGRU, hash), true, 'dogru PIN gecer');
  assert.equal(Kilit.dogrula(YANLIS, hash), false, 'yanlis PIN gecmez');
  assert.equal(Kilit.dogrula('13579', hash), false, 'eksik hane gecmez');

  /* Ozet okunamiyorsa "gec" DEGIL "gecme" demeli. */
  assert.equal(Kilit.dogrula(DOGRU, ''), false, 'bos ozet');
  assert.equal(Kilit.dogrula(DOGRU, null), false, 'null ozet');
  assert.equal(Kilit.dogrula(DOGRU, 'duzmetin'), false, 'bicimsiz ozet');
  assert.equal(Kilit.dogrula(DOGRU, 'scrypt$0$0$0$aa$bb'), false, 'sifir parametre');
  assert.equal(Kilit.dogrula(DOGRU, 'md5$16384$8$1$aa$bb'), false, 'taninmayan algoritma');
  assert.equal(Kilit.dogrula(DOGRU, 'scrypt$16384$8$1$$'), false, 'bos tuz/ozet');
});

/* =========================================================================
 * 3. MASKELEME VE SÜZME — kilidin dayanak noktası
 * ====================================================================== */

test('maskele: ozet ARAYUZE DONMEZ, yerine bayrak gider', (t) => {
  const ayarlar = ayarlarKur();
  const gorunen = Kilit.maskele(ayarlar);

  assert.equal(gorunen.yoneticiPinHash, undefined, 'ozet silindi');
  assert.equal(gorunen.yoneticiPinKurulu, true, 'yerine bayrak kondu');

  /* Ozgun nesne BOZULMAZ — cagiran onu diske yazabilir. */
  assert.ok(ayarlar.yoneticiPinHash, 'kaynak nesne hala ozeti tasiyor');
});

test('maskele: PIN kurulu degilse bayrak false', (t) => {
  const gorunen = Kilit.maskele({ tema: 'acik' });

  assert.equal(gorunen.yoneticiPinKurulu, false);
  assert.equal(gorunen.tema, 'acik', 'diger alanlar korunur');
});

test('suz: KORUMALI alanlar genel yazma kanalindan GECMEZ', (t) => {
  /* Saldiri senaryosu: kilitli cihazdaki biri tek cagriyla kilidi kaldirmaya
     calisir. `ayar:yaz` her anahtari kabul eden genel bir kanaldir. */
  const kotu = {
    tema: 'koyu',
    cihazRolu: 'standart',
    tahsisliPlasiyerId: 0,
    tahsisliPlasiyerAd: '',
    yoneticiPinHash: Kilit.ozetle('111111').hash,
    yoneticiPinDeneme: 0,
    yoneticiPinKilitBitis: 0,
    yoneticiPinKurulu: false
  };

  const temiz = Kilit.suz(kotu);

  Kilit.KORUMALI_ALANLAR.forEach(function (alan) {
    assert.equal(temiz[alan], undefined, alan + ' suzuldu');
  });

  assert.equal(temiz.yoneticiPinKurulu, undefined, 'turev bayrak da yazilmaz');
  assert.equal(temiz.tema, 'koyu', 'masum alan korunur');
});

test('suz: korumali alan listesi BEKLENEN alti alani kapsar', (t) => {
  /* Listeye yeni bir hassas alan eklenince bu test hatirlatir. */
  assert.deepEqual(Kilit.KORUMALI_ALANLAR.slice().sort(), [
    'cihazRolu',
    'tahsisliPlasiyerAd',
    'tahsisliPlasiyerId',
    'yoneticiPinDeneme',
    'yoneticiPinHash',
    'yoneticiPinKilitBitis'
  ]);
});

/* =========================================================================
 * 4. PIN KURMA / DEĞİŞTİRME
 * ====================================================================== */

test('pinKur: ilk kurulum ozeti ve sifir sayaci yazar', (t) => {
  const sonuc = Kilit.pinKur(DOGRU, {});

  assert.equal(sonuc.ok, true);
  assert.ok(sonuc.yazilacak.yoneticiPinHash);
  assert.equal(sonuc.yazilacak.yoneticiPinDeneme, 0);
  assert.equal(sonuc.yazilacak.yoneticiPinKilitBitis, 0);
  assert.equal(Kilit.dogrula(DOGRU, sonuc.yazilacak.yoneticiPinHash), true);
});

test('pinKur: PIN VARSA REDDEDILIR — yeni PIN yazip yonetici olunamaz', (t) => {
  const ayarlar = ayarlarKur();
  const sonuc = Kilit.pinKur('999999', ayarlar);

  assert.equal(sonuc.ok, false, 'ikinci kurulum reddedildi');
  assert.equal(sonuc.yazilacak, undefined, 'hicbir sey yazilmiyor');

  /* Eski PIN hala gecerli. */
  assert.equal(Kilit.dogrula(DOGRU, ayarlar.yoneticiPinHash), true);
  assert.equal(Kilit.dogrula('999999', ayarlar.yoneticiPinHash), false);
});

test('pinKur: gecersiz bicim kurulmaz', (t) => {
  assert.equal(Kilit.pinKur('12', {}).ok, false);
  assert.equal(Kilit.pinKur('abcdef', {}).ok, false);
});

test('pinDegistir: ESKI PIN dogrulanmadan yenisi yazilmaz', (t) => {
  const ayarlar = ayarlarKur();

  assert.equal(Kilit.pinDegistir(YANLIS, '222222', ayarlar).ok, false, 'yanlis eski PIN');
  assert.equal(Kilit.pinDegistir(DOGRU, '22', ayarlar).ok, false, 'gecersiz yeni PIN');
  assert.equal(Kilit.pinDegistir(DOGRU, '222222', {}).ok, false, 'tanimli PIN yok');

  const iyi = Kilit.pinDegistir(DOGRU, '222222', ayarlar);

  assert.equal(iyi.ok, true);
  assert.equal(Kilit.dogrula('222222', iyi.yazilacak.yoneticiPinHash), true, 'yeni PIN gecer');
  assert.equal(Kilit.dogrula(DOGRU, iyi.yazilacak.yoneticiPinHash), false, 'eski PIN artik gecmez');
});

/* =========================================================================
 * 5. DENEME SAYACI VE 60 SANİYELİK KİLİT
 * ====================================================================== */

test('pinDene: dogru PIN gecer ve sayaci SIFIRLAR', (t) => {
  let ayarlar = ayarlarKur();

  /* Once iki hatali deneme birikmis olsun. */
  ayarlar = uygula(ayarlar, Kilit.pinDene(YANLIS, ayarlar, 1000));
  ayarlar = uygula(ayarlar, Kilit.pinDene(YANLIS, ayarlar, 2000));
  assert.equal(ayarlar.yoneticiPinDeneme, 2);

  const sonuc = Kilit.pinDene(DOGRU, ayarlar, 3000);

  assert.equal(sonuc.ok, true);
  assert.equal(sonuc.yazilacak.yoneticiPinDeneme, 0, 'sayac sifirlandi');
  assert.equal(sonuc.yazilacak.yoneticiPinKilitBitis, 0);
});

test('pinDene: UC hatali denemede 60 SANIYE kilit', (t) => {
  let ayarlar = ayarlarKur();

  const bir = Kilit.pinDene(YANLIS, ayarlar, 1000);
  assert.equal(bir.ok, false);
  assert.equal(bir.kilitli, false, '1. denemede kilit yok');
  assert.equal(bir.kalanDeneme, 2);
  assert.match(bir.hata, /2 deneme/);
  ayarlar = uygula(ayarlar, bir);

  const iki = Kilit.pinDene(YANLIS, ayarlar, 2000);
  assert.equal(iki.kilitli, false, '2. denemede kilit yok');
  assert.equal(iki.kalanDeneme, 1);
  ayarlar = uygula(ayarlar, iki);

  const uc = Kilit.pinDene(YANLIS, ayarlar, 3000);
  assert.equal(uc.ok, false);
  assert.equal(uc.kilitli, true, '3. denemede KILIT');
  assert.equal(uc.kilitKalanSn, 60, 'tam 60 saniye');
  assert.equal(uc.yazilacak.yoneticiPinKilitBitis, 3000 + 60000);
  assert.match(uc.hata, /60 saniye/);
  ayarlar = uygula(ayarlar, uc);

  /* KILITLIYKEN DOGRU PIN DE GECMEZ — yoksa 60 saniye kurali anlamsiz olurdu. */
  const kilitli = Kilit.pinDene(DOGRU, ayarlar, 10000);
  assert.equal(kilitli.ok, false, 'kilitliyken dogru PIN de reddedilir');
  assert.equal(kilitli.kilitli, true);
  assert.equal(kilitli.kilitKalanSn, 53, 'kalan sure geri sayiyor');
  assert.equal(kilitli.yazilacak, undefined, 'kilitli denemede diske yazma YOK');
});

test('pinDene: kilit suresi dolunca hak YENILENIR', (t) => {
  let ayarlar = ayarlarKur();

  for (let i = 0; i < 3; i++) {
    ayarlar = uygula(ayarlar, Kilit.pinDene(YANLIS, ayarlar, 1000 + i));
  }

  assert.equal(Kilit.durum(ayarlar, 5000).kilitli, true, 'kilit basladi');

  /* 61 saniye sonra. */
  const sonra = 1002 + 61000;

  assert.equal(Kilit.durum(ayarlar, sonra).kilitli, false, 'kilit dustu');

  /* Dogru PIN artik gecer. */
  assert.equal(Kilit.pinDene(DOGRU, ayarlar, sonra).ok, true);

  /* Ve sayac sifirlanip YENIDEN 3 hak verilir: ilk hatali deneme kilit ACMAZ. */
  const hatali = Kilit.pinDene(YANLIS, ayarlar, sonra);

  assert.equal(hatali.kilitli, false, 'sure dolduktan sonraki ilk hata kilit acmaz');
  assert.equal(hatali.kalanDeneme, 2, 'hak yenilendi');
});

test('pinDene: PIN tanimli degilse deneme yapilamaz', (t) => {
  const sonuc = Kilit.pinDene(DOGRU, {}, 1000);

  assert.equal(sonuc.ok, false);
  assert.equal(sonuc.pinKurulu, false);
});

test('durum: arayuze giden ozet icermez, kalan sure/deneme dogru', (t) => {
  const ayarlar = ayarlarKur();
  const d = Kilit.durum(ayarlar, 1000);

  assert.equal(d.pinKurulu, true);
  assert.equal(d.kilitli, false);
  assert.equal(d.kilitKalanSn, 0);
  assert.equal(d.kalanDeneme, 3);
  assert.equal(d.cihazRolu, 'standart');
  assert.equal(d.cihazKilitli, false);

  /* Hicbir alan ozet tasimamali. */
  assert.ok(!JSON.stringify(d).includes('scrypt'), 'durum nesnesi ozet sizdirmiyor');
});

/* =========================================================================
 * 6. CİHAZ KİLİTLEME / AÇMA
 * ====================================================================== */

test('cihazKilitle: cihaz plasiyere tahsis edilir', (t) => {
  const ayarlar = ayarlarKur();
  const sonuc = Kilit.cihazKilitle({ id: 7, ad: 'Ahmet Yılmaz' }, ayarlar);

  assert.equal(sonuc.ok, true);
  assert.equal(sonuc.yazilacak.cihazRolu, 'plasiyer_kilitli');
  assert.equal(sonuc.yazilacak.tahsisliPlasiyerId, 7);
  assert.equal(sonuc.yazilacak.tahsisliPlasiyerAd, 'Ahmet Yılmaz');

  const d = Kilit.durum(uygula(ayarlar, sonuc), 1000);

  assert.equal(d.cihazKilitli, true);
  assert.equal(d.tahsisliPlasiyerId, 7);
  assert.equal(d.tahsisliPlasiyerAd, 'Ahmet Yılmaz');
});

test('cihazKilitle: MASTER PIN YOKSA REDDEDILIR (geri donusu olmayan kilit)', (t) => {
  const sonuc = Kilit.cihazKilitle({ id: 7, ad: 'Ahmet' }, { cihazRolu: 'standart' });

  assert.equal(sonuc.ok, false, 'PIN yoksa kilitlenemez');
  assert.equal(sonuc.yazilacak, undefined);
  assert.match(sonuc.hata, /Master PIN/, 'sebep kullaniciya soylenir');
});

test('cihazKilitle: gecersiz plasiyer reddedilir', (t) => {
  const ayarlar = ayarlarKur();

  assert.equal(Kilit.cihazKilitle({ id: 0, ad: 'Ahmet' }, ayarlar).ok, false, 'id yok');
  assert.equal(Kilit.cihazKilitle({ id: -3, ad: 'Ahmet' }, ayarlar).ok, false, 'negatif id');
  assert.equal(Kilit.cihazKilitle({ id: 7, ad: '   ' }, ayarlar).ok, false, 'ad bos');
  assert.equal(Kilit.cihazKilitle(null, ayarlar).ok, false, 'nesne yok');
});

test('cihazAc: DOGRU Master PIN kilidi acar ve tahsisi temizler', (t) => {
  let ayarlar = ayarlarKur();
  ayarlar = uygula(ayarlar, Kilit.cihazKilitle({ id: 7, ad: 'Ahmet' }, ayarlar));

  assert.equal(Kilit.durum(ayarlar, 1000).cihazKilitli, true, 'once kilitli');

  const sonuc = Kilit.cihazAc(DOGRU, ayarlar, 1000);

  assert.equal(sonuc.ok, true);
  assert.equal(sonuc.yazilacak.cihazRolu, 'standart');
  assert.equal(sonuc.yazilacak.tahsisliPlasiyerId, 0);
  assert.equal(sonuc.yazilacak.tahsisliPlasiyerAd, '');

  const d = Kilit.durum(uygula(ayarlar, sonuc), 1000);

  assert.equal(d.cihazKilitli, false, 'standart moda donuldu');
  assert.equal(d.pinKurulu, true, 'PIN silinmedi — kilit tekrar kurulabilir');
});

test('cihazAc: YANLIS PIN kilidi ACMAZ ve rol KORUNUR', (t) => {
  let ayarlar = ayarlarKur();
  ayarlar = uygula(ayarlar, Kilit.cihazKilitle({ id: 7, ad: 'Ahmet' }, ayarlar));

  const sonuc = Kilit.cihazAc(YANLIS, ayarlar, 1000);

  assert.equal(sonuc.ok, false);
  assert.equal((sonuc.yazilacak || {}).cihazRolu, undefined, 'rol degismedi');

  /* Sayac ilerledi ama cihaz HALA kilitli. */
  const sonra = uygula(ayarlar, sonuc);

  assert.equal(sonra.yoneticiPinDeneme, 1, 'deneme sayildi');
  assert.equal(Kilit.durum(sonra, 1000).cihazKilitli, true, 'kilit yerinde');
});

test('cihazAc: kilit acma ekrani KABA KUVVET SAYACINDAN MUAF DEGIL', (t) => {
  let ayarlar = ayarlarKur();
  ayarlar = uygula(ayarlar, Kilit.cihazKilitle({ id: 7, ad: 'Ahmet' }, ayarlar));

  /* Uc yanlis deneme → 60 saniye kilit, cihaz hala tahsisli. */
  for (let i = 0; i < 3; i++) {
    ayarlar = uygula(ayarlar, Kilit.cihazAc(YANLIS, ayarlar, 1000 + i));
  }

  const dorduncu = Kilit.cihazAc(DOGRU, ayarlar, 1500);

  assert.equal(dorduncu.ok, false, 'kilitliyken dogru PIN de beklemek zorunda');
  assert.equal(dorduncu.kilitli, true);
  assert.equal(Kilit.durum(ayarlar, 1500).cihazKilitli, true, 'cihaz tahsisli kaldi');
});

test('cihazAc: PIN tanimli degilse kilit acilamaz', (t) => {
  /* Bu duruma normalde girilemez (cihazKilitle PIN ister) ama elle duzenlenmis
     bir ayar dosyasi bunu uretebilir. O hâlde bile "gec" denmemeli. */
  const ayarlar = { cihazRolu: 'plasiyer_kilitli', tahsisliPlasiyerId: 7, tahsisliPlasiyerAd: 'Ahmet' };
  const sonuc = Kilit.cihazAc('135790', ayarlar, 1000);

  assert.equal(sonuc.ok, false);
  assert.equal(sonuc.pinKurulu, false);
});

test('durum: taninmayan cihazRolu STANDART sayilir', (t) => {
  /* Elle bozulmus bir deger kilidi "yari acik" birakmamali: ya tam kilit ya
     standart. Tanimsiz bir degerle kilitli davranmak, kullanicinin hic
     kilitlemedigi bir cihazi kilitli gosterirdi. */
  const d = Kilit.durum({ cihazRolu: 'sacmalik' }, 1000);

  assert.equal(d.cihazRolu, 'standart');
  assert.equal(d.cihazKilitli, false);
});

test('durum: bozuk sayisal alanlar cokme uretmez', (t) => {
  const d = Kilit.durum({
    cihazRolu: 'plasiyer_kilitli',
    tahsisliPlasiyerId: 'abc',
    yoneticiPinDeneme: 'xx',
    yoneticiPinKilitBitis: 'yy'
  }, 1000);

  assert.equal(d.tahsisliPlasiyerId, 0);
  assert.equal(d.kilitKalanSn, 0);
  assert.equal(d.kalanDeneme, 3);
  assert.equal(d.cihazKilitli, true, 'rol gecerli oldugu icin kilit duruyor');
});

/* =========================================================================
 * 7. KAYNAK DENETİMİ — motorun DOĞRU YERE bağlandığını kanıtlar
 * ---------------------------------------------------------------------
 * Yukarıdaki testler motorun kendisini doğruluyor. Ama motor ne kadar doğru
 * olursa olsun, `main.js` onu ÇAĞIRMIYORSA kilit yoktur. `maskele`/`suz`
 * çağrısını `ayar:oku`/`ayar:yaz` kanallarından kaldıran bir değişiklik
 * davranış testlerinin HİÇBİRİNİ kırmaz — çünkü main.js Electron gerektirdiği
 * için `node --test` altında yüklenemez.
 *
 * Bu, Faz 4'te `[hidden]` hatasında canımızı yakan boşluğun aynısı: söz
 * doğruydu, bağlantı kopuktu ve test bunu görmüyordu. O yüzden burada KAYNAK
 * METNİ denetleniyor.
 * ====================================================================== */

const fs = require('fs');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const KAPI = fs.readFileSync(path.join(__dirname, '..', 'renderer-plasiyer.js'), 'utf8');

test('KAYNAK: ayar:oku MASKELER — PIN ozeti arayuze donmez', (t) => {
  assert.match(
    MAIN,
    /ipcMain\.handle\(\s*'ayar:oku'\s*,\s*\(\)\s*=>\s*yoneticiKilit\.maskele\(/,
    'ayar:oku maskele() ile sarilmali'
  );

  /* Maskelenmemis bir okuma kanali kalmamali. */
  assert.ok(
    !/ipcMain\.handle\(\s*'ayar:oku'\s*,\s*\(\)\s*=>\s*ayarlariOku\(\)\s*\)/.test(MAIN),
    'ham ayarlariOku() donduren ayar:oku kanali YOK'
  );
});

test('KAYNAK: ayar:yaz SUZER — korumali alanlar genel kanaldan gecmez', (t) => {
  assert.match(
    MAIN,
    /ipcMain\.handle\(\s*'ayar:yaz'[\s\S]{0,200}?yoneticiKilit\.suz\(/,
    'ayar:yaz suz() cagirmali'
  );

  assert.ok(
    !/ipcMain\.handle\(\s*'ayar:yaz'\s*,\s*\(olay,\s*yeni\)\s*=>\s*ayarlariYaz\(yeni\)\s*\)/.test(MAIN),
    'suzgecsiz ayar:yaz kanali YOK'
  );
});

test('KAYNAK: alti PIN/cihaz kanali da main.js icinde kayitli', (t) => {
  [
    'auth:yonetici-pin-durum',
    'auth:yonetici-pin-kur',
    'auth:yonetici-pin-dogrula',
    'auth:yonetici-pin-degistir',
    'cihaz:durum',
    'cihaz:kilitle',
    'cihaz:ac'
  ].forEach(function (kanal) {
    assert.ok(
      MAIN.includes("ipcMain.handle('" + kanal + "'"),
      kanal + ' kanali kayitli'
    );
  });
});

test('KAYNAK: ana surec yanitinda `yazilacak` ARAYUZE gonderilmez', (t) => {
  /* `yazilacak` icinde PIN ozeti olabilir; yanit nesnesi onu tasimamali. */
  const blok = MAIN.slice(MAIN.indexOf('function kilitSonucunuUygula'), MAIN.indexOf("ipcMain.handle('auth:yonetici-pin-durum'"));

  assert.ok(blok.length > 100, 'kilitSonucunuUygula bulundu');
  assert.ok(/yazilacak/.test(blok), 'yazilacak diske uygulaniyor');
  assert.ok(
    !/return\s*\{[\s\S]*?yazilacak\s*:/.test(blok),
    'yanit nesnesinde yazilacak alani YOK'
  );
});

test('KAYNAK: kilit acilinca plasiyer oturumu da dusurulur', (t) => {
  const blok = MAIN.slice(MAIN.indexOf("ipcMain.handle('cihaz:ac'"));

  assert.match(
    blok.slice(0, 900),
    /plasiyerOturumu\s*=\s*null/,
    'cihaz:ac basarili olunca jeton dusurulur'
  );
});

test('KAYNAK: kilitli cihazda PIN penceresi kapatilamaz (tek nokta koruma)', (t) => {
  const blok = KAPI.slice(KAPI.indexOf('function pinPerdesiniKapat'));

  assert.match(
    blok.slice(0, 800),
    /if \(cihaz\.kilitli\) return;/,
    'pinPerdesiniKapat basinda kilit kontrolu olmali'
  );
});

test('KAYNAK: yonetici kapisi Master PIN penceresini acar, paneli DOGRUDAN acmaz', (t) => {
  const blok = KAPI.slice(KAPI.indexOf('function yoneticiSec'), KAPI.indexOf('function yoneticiGirisiniTamamla'));

  assert.match(blok, /ypinAc\(/, 'yoneticiSec PIN penceresi acar');
  assert.ok(!/oturumKur\(/.test(blok), 'yoneticiSec oturum KURMAZ');
});

/** Yorumları atar: belgelemede alan adını ANMAK kod onu OKUMAK değildir. */
function yorumsuz(kaynak) {
  return String(kaynak)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('KAYNAK: arayuz PIN ozetini hicbir yerde OKUMAZ', (t) => {
  /* Ozet arayuze hic gelmiyor (maskele siliyor); arayuzun onu okumaya
     calisan bir satiri da olmamali. Yorumlardaki anma serbest — gerekcenin
     yazili olmasi iyi bir sey. */
  const YONETIM = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'modules', 'plasiyer-yonetimi.js'), 'utf8'
  );

  assert.ok(!/yoneticiPinHash/.test(yorumsuz(KAPI)), 'renderer-plasiyer.js ozete dokunmuyor');
  assert.ok(!/yoneticiPinHash/.test(yorumsuz(YONETIM)), 'plasiyer-yonetimi.js de dokunmuyor');

  /* Gerekce YAZILI olmali: alan adi en az bir yorumda anilmali. */
  assert.ok(/yoneticiPinHash/.test(KAPI), 'neden okunmadigi yorumda aciklanmis');
});
