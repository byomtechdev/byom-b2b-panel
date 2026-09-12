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

test('suz: korumali alan listesi BEKLENEN dokuz alani kapsar', (t) => {
  /* Listeye yeni bir hassas alan eklenince bu test hatirlatir.
     FAZ 8'DE UC ALAN EKLENDI (PIN kurtarma):
       pinKurtarmaDeneme / pinKurtarmaKilitBitis → arayuzden sifirlanabilse
         yerel kurtarma kisitlamasi anlamsiz olurdu.
       yoneticiPinSifirlamaZamani → DENETIM IZI; silinebilir olmamali, yoksa
         habersiz bir sifirlama hic iz birakmadan gecer. */
  assert.deepEqual(Kilit.KORUMALI_ALANLAR.slice().sort(), [
    'cihazRolu',
    'pinKurtarmaDeneme',
    'pinKurtarmaKilitBitis',
    'tahsisliPlasiyerAd',
    'tahsisliPlasiyerId',
    'yoneticiPinDeneme',
    'yoneticiPinHash',
    'yoneticiPinKilitBitis',
    'yoneticiPinSifirlamaZamani'
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

test('KAYNAK: kilitli cihazda KIMLIK DOGRULANMADAN perde kapatilamaz', (t) => {
  const blok = KAPI.slice(KAPI.indexOf('function pinPerdesiniKapat')).slice(0, 1400);

  /*
   * FAZ 6'DA DUZELTILDI — kosul iki parcali olmali.
   *
   * Faz 5'te yalnizca `cihaz.kilitli` vardi ve bu URETIMDE KILITLENME
   * uretiyordu: plasiyer DOGRU PIN'i girince oturum aciliyor, kapi kaplamasi
   * kalkiyor, ama perde ekranda kalip paneli kapatiyordu. `!durum.oturum`
   * kosulu bu yuzden ZORUNLU ve bu test onu kilitliyor.
   */
  assert.match(blok, /if \(cihaz\.kilitli && !durum\.oturum\) return;/,
    'kosul: kilitli VE oturum yok');

  /* Eski (hatali) tek parcali kosul geri gelmesin. */
  assert.ok(!/if \(cihaz\.kilitli\) return;/.test(blok),
    'Faz 5 hatasi (tek parcali kosul) geri DONMEMIS');
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

/* =========================================================================
 * FAZ 8 — PIN SIFIRLAMA (OTP / CHALLENGE) MOTORU
 * ---------------------------------------------------------------------
 * Düz metin PIN senkronu KALDIRILDI. Merkez PIN'i hiç görmez; yalnızca tek
 * kullanımlık SIFIRLAMA kodu verir ve PIN yerel olarak silinir.
 * ====================================================================== */

/* ---- TALEP KODU (challenge) ---- */

test('talepKodu: lisans + HWID den TURETILIR ve DETERMINISTTIR', (t) => {
  const a = Kilit.talepKodu('BYOM-1111-2222', 'hwid-abc');
  const b = Kilit.talepKodu('BYOM-1111-2222', 'hwid-abc');

  assert.equal(a, b, 'ayni cihaz her zaman ayni kodu gosterir');

  /* DETERMINIST olmak ZORUNDA: merkez kodu lisans kaydindan yeniden
     hesaplayip arayanin gercekten o cihazin basinda oldugunu dogrulayabilsin.
     Rastgele olsaydi her talebin hub'a kaydedilmesi ZORUNLU olurdu ve
     internetsiz bir ofiste akis tamamen tikanirdi. */
  assert.match(a, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/, 'dortlu gruplar');
});

test('talepKodu: HWID ya da LISANS degisince kod DEGISIR', (t) => {
  const temel = Kilit.talepKodu('BYOM-1111-2222', 'hwid-abc');

  assert.notEqual(Kilit.talepKodu('BYOM-1111-2222', 'hwid-XYZ'), temel, 'baska cihaz');
  assert.notEqual(Kilit.talepKodu('BYOM-9999-8888', 'hwid-abc'), temel, 'baska lisans');
});

test('talepKodu: LISANS YOKSA kod uretilmez', (t) => {
  /* Kurtarmanin baglanacagi bir kimlik yok; bos kod arayuzde "—" gosterilir. */
  assert.equal(Kilit.talepKodu('', 'hwid-abc'), '');
  assert.equal(Kilit.talepKodu(null, 'hwid-abc'), '');
  assert.equal(Kilit.talepKodu(undefined, undefined), '');
});

test('talepKodu: alfabede KARISTIRILAN harf YOK (telefonda okunacak)', (t) => {
  /* I, L, O, U cikarildi: "O mu sifir mi?" sorusu destek cagrisi demektir. */
  assert.ok(!/[ILOU]/.test(Kilit.KOD_ALFABE), 'alfabe temiz');

  /* Uretilen kodlar da o alfabeden cikmali — 400 ornek tara. */
  for (let i = 0; i < 400; i++) {
    const kod = Kilit.talepKodu('BYOM-' + i, 'hwid-' + i).replace(/-/g, '');

    for (const ch of kod) {
      assert.ok(Kilit.KOD_ALFABE.indexOf(ch) !== -1, 'alfabe disi karakter: ' + ch);
    }
  }
});

test('talepKodu: SIR DEGIL — PIN ozetinden bagimsiz', (t) => {
  /* Talep kodu bir KIMLIKTIR; PIN'den turetilmez, yani ekranda gostermek ya da
     telefonda okumak PIN hakkinda hicbir sey sizdirmaz. */
  const pinli = Kilit.pinKur('135790', {});
  const a = Kilit.talepKodu('BYOM-1111', 'hwid-1');

  /* Ayni cihaz, PIN kurulu ya da degil — kod AYNI. */
  assert.equal(Kilit.talepKodu('BYOM-1111', 'hwid-1'), a);
  assert.ok(!a.includes('135790'));
  assert.ok(!pinli.yazilacak.yoneticiPinHash.includes(a.replace(/-/g, '')));
});

/* ---- KURTARMA KODU BICIMI ---- */

test('kurtarmaKodunuNormalle: ayirici atilir, KARISTIRILAN harf cevrilir', (t) => {
  assert.equal(Kilit.kurtarmaKodunuNormalle('a1b2-c3d4'), 'A1B2C3D4');
  assert.equal(Kilit.kurtarmaKodunuNormalle(' A1B2 C3D4 '), 'A1B2C3D4');
  assert.equal(Kilit.kurtarmaKodunuNormalle('A1B2_C3D4'), 'A1B2C3D4');

  /* O->0, I/L->1, U->V : telefonda okunan kodda bunlari ayirmak imkansiz.
     Bu bir kolaylik degil HATA ONLEMEDIR; her yazim hatasi merkeze ikinci
     bir cagri demektir. */
  assert.equal(Kilit.kurtarmaKodunuNormalle('OIL2345U'), '0112345V');
  assert.equal(Kilit.kurtarmaKodunuNormalle('oil2345u'), '0112345V');
});

test('kurtarmaKoduBicimi: 8 karakter ve alfabe denetimi', (t) => {
  assert.equal(Kilit.kurtarmaKoduBicimi('A1B2C3D4').ok, true);
  assert.equal(Kilit.kurtarmaKoduBicimi('a1b2-c3d4').ok, true, 'tireli girdi kabul');
  assert.equal(Kilit.kurtarmaKoduBicimi('OIL23450').ok, true, 'cevrilen harfler kabul');

  assert.equal(Kilit.kurtarmaKoduBicimi('A1B2C3D').ok, false, '7 karakter');
  assert.equal(Kilit.kurtarmaKoduBicimi('A1B2C3D45').ok, false, '9 karakter');
  assert.equal(Kilit.kurtarmaKoduBicimi('').ok, false, 'bos');
  assert.equal(Kilit.kurtarmaKoduBicimi(null).ok, false, 'null');

  /* Alfabe disi karakter (normalizasyondan sonra da kalan). */
  assert.equal(Kilit.kurtarmaKoduBicimi('A1B2C3D@').ok, false, 'isaret');
  assert.match(Kilit.kurtarmaKoduBicimi('A1B2C3D@').hata, /geçersiz karakter/i);
  assert.match(Kilit.kurtarmaKoduBicimi('A1B2').hata, /8 karakter/);
});

/* ---- YEREL DENEME / KILIT ---- */

test('kurtarmaDenemesiHazirla: BICIM gecmeyen kod hub a GITMEZ', (t) => {
  const h = Kilit.kurtarmaDenemesiHazirla('A1B2', {}, 1000);

  assert.equal(h.ok, false, 'eksik kod elendi');
  assert.equal(h.kod, undefined, 'hub a gonderilecek kod yok');

  const iyi = Kilit.kurtarmaDenemesiHazirla('a1b2-c3d4', {}, 1000);

  assert.equal(iyi.ok, true);
  assert.equal(iyi.kod, 'A1B2C3D4', 'normalize edilmis hali gonderilir');
});

test('kurtarmaBasarisiz: BES hatali denemede 15 DAKIKA kilit', (t) => {
  let ayarlar = {};

  for (let i = 1; i <= 4; i++) {
    const r = Kilit.kurtarmaBasarisiz(ayarlar, 1000 + i);

    assert.equal(r.kilitli, false, i + '. denemede kilit yok');
    assert.equal(r.kalanDeneme, 5 - i);
    ayarlar = Object.assign({}, ayarlar, r.yazilacak);
  }

  const besinci = Kilit.kurtarmaBasarisiz(ayarlar, 2000);

  assert.equal(besinci.kilitli, true, '5. denemede KILIT');
  assert.equal(besinci.kilitKalanSn, 900, '15 dakika');
  assert.equal(besinci.yazilacak.pinKurtarmaKilitBitis, 2000 + 900000);

  ayarlar = Object.assign({}, ayarlar, besinci.yazilacak);

  /* KILITLIYKEN DOGRU BICIMLI kod bile hub a GITMEZ: merkez bosuna dovulmesin. */
  const kilitli = Kilit.kurtarmaDenemesiHazirla('A1B2C3D4', ayarlar, 2500);

  assert.equal(kilitli.ok, false);
  assert.equal(kilitli.kilitli, true);
  assert.match(kilitli.hata, /saniye sonra/);
});

test('kurtarmaBasarisiz: kilit suresi dolunca hak YENILENIR', (t) => {
  let ayarlar = {};

  for (let i = 0; i < 5; i++) {
    ayarlar = Object.assign({}, ayarlar, Kilit.kurtarmaBasarisiz(ayarlar, 1000 + i).yazilacak);
  }

  const sonra = 1004 + 901000;

  assert.equal(Kilit.kurtarmaDenemesiHazirla('A1B2C3D4', ayarlar, sonra).ok, true, 'kilit dustu');

  /* Sayac sifirdan baslar: sure dolduktan sonraki ilk hata kilit ACMAZ. */
  const hatali = Kilit.kurtarmaBasarisiz(ayarlar, sonra);

  assert.equal(hatali.kilitli, false);
  assert.equal(hatali.kalanDeneme, 4, 'hak yenilendi');
});

/* ---- SIFIRLAMA ---- */

test('pinSifirla: PIN ozeti SILINIR ve sayaclar sifirlanir', (t) => {
  const ayarlar = Object.assign(
    { pinKurtarmaDeneme: 3, pinKurtarmaKilitBitis: 123, yoneticiPinDeneme: 2, yoneticiPinKilitBitis: 9 },
    Kilit.pinKur('135790', {}).yazilacak
  );

  const s = Kilit.pinSifirla(ayarlar, 1700000000000);

  assert.equal(s.ok, true);
  assert.equal(s.yazilacak.yoneticiPinHash, '', 'ozet silindi');
  assert.equal(s.yazilacak.yoneticiPinDeneme, 0);
  assert.equal(s.yazilacak.yoneticiPinKilitBitis, 0);
  assert.equal(s.yazilacak.pinKurtarmaDeneme, 0);
  assert.equal(s.yazilacak.pinKurtarmaKilitBitis, 0);

  /* Uygulandiktan sonra PIN "kurulu degil" sayilir → yeni PIN kurulabilir. */
  const sonra = Object.assign({}, ayarlar, s.yazilacak);

  assert.equal(Kilit.durum(sonra, 1).pinKurulu, false);
  assert.equal(Kilit.pinKur('246802', sonra).ok, true, 'yeni PIN kurulabilir');
});

test('pinSifirla: DEGISMEZ KURAL — PIN silinince CIHAZ KILIDI de kalkar', (t) => {
  /*
   * «kilitli cihaz ⇒ tanimli bir PIN vardir»
   * cihazKilitle PIN olmadan kilitlemeyi zaten reddediyor. PIN silinip kilit
   * birakilsaydi cihaz TUGLAYA donerdi: kilidi acmak PIN ister, PIN yok, yeni
   * PIN kurmak kilidi acmaz.
   */
  let ayarlar = Kilit.pinKur('135790', {}).yazilacak;
  ayarlar = Object.assign({}, ayarlar, Kilit.cihazKilitle({ id: 7, ad: 'Ahmet' }, ayarlar).yazilacak);

  assert.equal(Kilit.durum(ayarlar, 1).cihazKilitli, true, 'once kilitli');

  const sonra = Object.assign({}, ayarlar, Kilit.pinSifirla(ayarlar, 1).yazilacak);
  const d = Kilit.durum(sonra, 1);

  assert.equal(d.pinKurulu, false, 'PIN silindi');
  assert.equal(d.cihazKilitli, false, 'KILIT DE KALKTI (tugla olmasin)');
  assert.equal(d.tahsisliPlasiyerId, 0);
  assert.equal(d.tahsisliPlasiyerAd, '');
});

test('pinSifirla: DENETIM IZI damgalanir', (t) => {
  /* Kurtarma yolu sosyal muhendislige acik; panelin karsi onlemi olayin
     GORUNUR olmasi. Patron "bu PIN ne zaman sifirlandi?" diye sorabilmeli. */
  const s = Kilit.pinSifirla({}, 1757660000000);

  assert.equal(s.yazilacak.yoneticiPinSifirlamaZamani, new Date(1757660000000).toISOString());
  assert.equal(Kilit.durum(s.yazilacak, 1).sifirlamaZamani, s.yazilacak.yoneticiPinSifirlamaZamani);
});

test('durum: kurtarma kilidi ve kalan deneme arayuze TASINIR', (t) => {
  let ayarlar = Kilit.pinKur('135790', {}).yazilacak;

  assert.equal(Kilit.durum(ayarlar, 1000).kurtarmaKilitli, false);
  assert.equal(Kilit.durum(ayarlar, 1000).kurtarmaKalanDeneme, 5);

  for (let i = 0; i < 5; i++) {
    ayarlar = Object.assign({}, ayarlar, Kilit.kurtarmaBasarisiz(ayarlar, 1000 + i).yazilacak);
  }

  const d = Kilit.durum(ayarlar, 1004);

  assert.equal(d.kurtarmaKilitli, true);
  assert.ok(d.kurtarmaKilitKalanSn > 890, 'kalan sure tasindi: ' + d.kurtarmaKilitKalanSn);
  assert.equal(d.kurtarmaKalanDeneme, 0);

  /* Hicbir durum alani OZET sizdirmiyor. */
  assert.ok(!JSON.stringify(d).includes('scrypt'));
});

test('KAYNAK: duz metin PIN senkronu KALDIRILDI (geri donmemis)', (t) => {
  const BYOM = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'byom.js'), 'utf8');
  const MAIN2 = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  /* Yorumlar haric: kaldirilan tasarim BELGELENMIS olmali ama CAGRILMAMALI. */
  const yorumsuz = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.ok(!/pinSenkronla/.test(yorumsuz(BYOM)), 'pinSenkronla kaldirildi');
  assert.ok(!/pin-sync/.test(yorumsuz(BYOM)), 'pin-sync ucu artik cagrilmiyor');
  assert.ok(!/pinKurtarmaSenkronu/.test(yorumsuz(MAIN2)), 'main.js senkron cagrisi kaldirildi');

  /* Yerine sifirlama protokolu gelmis olmali. */
  assert.match(BYOM, /pin-reset\/request/, 'talep ucu var');
  assert.match(BYOM, /pin-reset\/verify/, 'dogrulama ucu var');
  assert.match(MAIN2, /ipcMain\.handle\('auth:pin-kurtarma-talep'/, 'talep kanali kayitli');
  assert.match(MAIN2, /ipcMain\.handle\('auth:pin-kurtarma-dogrula'/, 'dogrulama kanali kayitli');

  /* Kaldirma KARARI yorumda aciklanmis olmali — gerekce canli kalsin. */
  assert.match(BYOM, /DÜZ METİN PIN SENKRONU KALDIRILDI/, 'karar belgelenmis');
});

test('KAYNAK: AG HATASI kurtarma sayacini ILERLETMEZ', (t) => {
  /*
   * "Ulasamadim" ile "kod yanlis" ayri seylerdir. Karistirilirsa internet
   * kesikken kullanici hic yapmadigi bir hata icin 15 dakika kilitlenir.
   * Ayni ayrim byom-api.js -> agSorunu bayraginda da var.
   */
  const MAIN2 = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const blok = MAIN2.slice(MAIN2.indexOf("ipcMain.handle('auth:pin-kurtarma-dogrula'"));

  assert.match(blok.slice(0, 2200), /if \(cevap\.agSorunu\) \{[\s\S]{0,260}?return/,
    'ag hatasi sayac ilerletmeden doner');

  /* Sayac ilerletme yalnizca ag hatasi DISINDAKI dalda olmali. */
  const agDal = blok.indexOf('cevap.agSorunu');
  const sayacDal = blok.indexOf('kurtarmaBasarisiz');

  assert.ok(agDal !== -1 && sayacDal !== -1 && agDal < sayacDal,
    'ag hatasi kontrolu sayac ilerletmeden ONCE gelmeli');
});

test('KAYNAK: sifirlama plasiyer oturumunu da dusurur', (t) => {
  const MAIN2 = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const blok = MAIN2.slice(MAIN2.indexOf("ipcMain.handle('auth:pin-kurtarma-dogrula'"));

  /* Cihazin tahsisi kalktigi icin acik jetonla veri cekmeye devam etmemeli. */
  assert.match(blok.slice(0, 2600), /plasiyerOturumu = null/,
    'sifirlamada jeton dusurulmeli');
});
