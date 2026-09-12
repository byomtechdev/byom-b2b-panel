'use strict';
/* ============================================================================
 *  MÜŞTERİ DOĞRULAMA MOTORU — TCKN / VKN / GSM birim testleri
 *  ---------------------------------------------------------------------------
 *  Vektörler şartnamedeki formüllerden ÜRETİLDİ ve kamuya açık test
 *  numaralarıyla (10000000146) ÇAPRAZ DOĞRULANDI. Aynı vektörler PHP
 *  ikizinin testinde de kullanılır (scripts/tests/php/dogrulama.test.php):
 *  iki taraf ayrışırsa sahada yazılan müşteri eşitlemede reddedilir.
 *
 *  Kilitlenen sözler:
 *   1. TCKN: ilk hane 0 olamaz; iki kontrol hanesi formüle uyar; tek hanelik
 *      bozulma YAKALANIR; negatif ara sonuç doğru mod alır.
 *   2. VKN: Maliye kontrol toplamı; "sonuç 0 → 9" kuralı; tek hanelik
 *      bozulma YAKALANIR.
 *   3. GSM: şartname deseni; üç yazım biçimi AYNI kayda iner (05XXXXXXXXX).
 *   4. Form denetimi İLK hatayı değil HEPSİNİ döner; iskonto tavanını aşamaz.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const D = require(path.join(__dirname, '..', 'src', 'shared', 'dogrulama.js'));

/* ---- Referans üreteçleri (yalnızca test içinde; üründe ÜRETEÇ YOK) ---- */

function tcknUret(ilk9) {
  const d = String(ilk9).split('').map(Number);
  const d9 = (((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10 + 10) % 10;
  const d10 = (d.reduce((a, b) => a + b, 0) + d9) % 10;

  return ilk9 + d9 + d10;
}

function vknUret(ilk9) {
  const d = String(ilk9).split('').map(Number);
  let toplam = 0;

  for (let i = 0; i < 9; i++) {
    const v = (d[i] + (9 - i)) % 10;
    let c = 0;

    if (0 !== v) { c = (v * Math.pow(2, 9 - i)) % 9; if (0 === c) c = 9; }

    toplam += c;
  }

  return ilk9 + ((10 - (toplam % 10)) % 10);
}

/* =========================================================================
 * 1. TCKN
 * ====================================================================== */

test('TCKN: kamuya acik test numarasi GECER (algoritma gercekle ortusur)', (t) => {
  /* 10000000146 — NVI'nin yayimladigi klasik test numarasi. Bu gecmiyorsa
     formul yanlis yazilmistir; uretilmis vektorlerin hepsi birden yanlis
     olabilir, bu tek satir onu yakalar. */
  assert.equal(D.tcknGecerli('10000000146'), true);
});

test('TCKN: uretilen 200 numara GECER', (t) => {
  for (let i = 0; i < 200; i++) {
    const ilk9 = String(100000000 + Math.floor(i * 4444444.4) % 900000000).slice(0, 9);
    const n = tcknUret(ilk9);

    assert.equal(D.tcknGecerli(n), true, n + ' gecmeli');
  }
});

test('TCKN: TEK HANE bozulunca REDDEDILIR (her konumda)', (t) => {
  const n = tcknUret('123456789');

  assert.equal(D.tcknGecerli(n), true, 'temel numara gecer');

  for (let k = 0; k < 11; k++) {
    const bozuk = n.slice(0, k) + ((Number(n[k]) + 1) % 10) + n.slice(k + 1);

    /* 0. hane bozulup '0' olursa zaten ilk-hane kuraliyla duser; digerleri
       kontrol toplamiyla dusmeli. */
    assert.equal(D.tcknGecerli(bozuk), false, k + '. hane bozuk: ' + bozuk + ' REDDEDILMELI');
  }
});

test('TCKN: ILK HANE 0 OLAMAZ — kontrol toplami tutsa bile', (t) => {
  const n = tcknUret('012345678');   // formule gore tutarli ama 0 ile basliyor

  assert.equal(D.tcknGecerli(n), false);
});

test('TCKN: uzunluk ve bicim', (t) => {
  assert.equal(D.tcknGecerli('1000000014'), false, '10 hane');
  assert.equal(D.tcknGecerli('100000001460'), false, '12 hane');
  assert.equal(D.tcknGecerli(''), false, 'bos');
  assert.equal(D.tcknGecerli(null), false, 'null');
  assert.equal(D.tcknGecerli(undefined), false, 'undefined');
  assert.equal(D.tcknGecerli('1000000014a'), false, 'harf');

  /* Rakam disi karakterler YOK SAYILIR (yapistirma): "100 000 001 46" gecer. */
  assert.equal(D.tcknGecerli('100 000 001 46'), true, 'bosluklu yapistirma');
  assert.equal(D.tcknGecerli(' 10000000146 '), true, 'kenar boslugu');
});

test('TCKN: NEGATIF ara sonuc dogru mod alir', (t) => {
  /*
   * (tek*7 - cift) negatif cikabilir: tekler kucuk, ciftler buyuk.
   * JS'te -4 % 10 === -4 → hane asla -4 olamayacagi icin BUTUN bu numaralar
   * yanlis reddedilirdi. ((x%10)+10)%10 duzeltmesi sart.
   */
  const ilk9 = '191919191';   // tek haneler 1, cift haneler 9 → 5*7 - 36 = -1
  const n = tcknUret(ilk9);

  assert.equal(D.tcknGecerli(n), true, n + ' negatif ara sonucla gecmeli');
});

/* =========================================================================
 * 2. VKN
 * ====================================================================== */

test('VKN: uretilen 200 numara GECER', (t) => {
  for (let i = 0; i < 200; i++) {
    const ilk9 = String(100000000 + Math.floor(i * 3333333.3) % 900000000).slice(0, 9);
    const n = vknUret(ilk9);

    assert.equal(D.vknGecerli(n), true, n + ' gecmeli');
  }
});

test('VKN: TEK HANE bozulunca REDDEDILIR (her konumda)', (t) => {
  const n = vknUret('455011156');

  assert.equal(D.vknGecerli(n), true);

  for (let k = 0; k < 10; k++) {
    const bozuk = n.slice(0, k) + ((Number(n[k]) + 1) % 10) + n.slice(k + 1);

    assert.equal(D.vknGecerli(bozuk), false, k + '. hane bozuk: ' + bozuk + ' REDDEDILMELI');
  }
});

test('VKN: "sonuc 0 → 9" kurali (v = 9 durumu) dogru uygulanir', (t) => {
  /*
   * v_i = 9 iken (v*2^k) mod 9 = 0 cikar ve kural 9 almayi soyler. Bu durumu
   * zorlayan bir sayi: d[0] = 0 → v_0 = (0+9)%10 = 9.
   */
  const n = vknUret('012345678');

  assert.equal(D.vknGecerli(n), true, n + ' (v=9 durumu) gecmeli');

  /* Kural UYGULANMASAYDI (0 alinsaydi) kontrol hanesi farkli cikardi. */
  const d = '012345678'.split('').map(Number);
  let yanlisToplam = 0;

  for (let i = 0; i < 9; i++) {
    const v = (d[i] + (9 - i)) % 10;
    yanlisToplam += v ? ((v * Math.pow(2, 9 - i)) % 9) : 0;   // 9 yerine 0
  }

  const yanlisHane = (10 - (yanlisToplam % 10)) % 10;

  assert.notEqual(String(yanlisHane), n[9], 'kural olmadan farkli hane cikar — test anlamli');
});

test('VKN: tekrarli diziler REDDEDILIR', (t) => {
  /* Eskiden "uzunluk 10" yettigi icin 1111111111 gecerli sayiliyordu ve
     fatura kesilemeyen siparislere yol aciyordu (b2b-functions.php notu). */
  ['1111111111', '0000000000', '2222222222', '9999999999'].forEach((v) => {
    /* Bunlardan yalnizca kontrol toplami tesadufen tutanlar gecer; tesadufi
       olmayan bir iddia icin uretecle karsilastiriyoruz. */
    assert.equal(D.vknGecerli(v), vknUret(v.slice(0, 9)) === v, v);
  });

  assert.equal(D.vknGecerli('1111111111'), false, '1111111111 gecmez');
});

test('VKN: uzunluk ve bicim', (t) => {
  assert.equal(D.vknGecerli('123456789'), false, '9 hane');
  assert.equal(D.vknGecerli('12345678901'), false, '11 hane (TCKN uzunlugu)');
  assert.equal(D.vknGecerli(''), false);
  assert.equal(D.vknGecerli(null), false);
  assert.equal(D.vknGecerli('123 456 7890'), D.vknGecerli('1234567890'), 'bosluk yok sayilir');
});

/* =========================================================================
 * 3. kimlikNoCoz — tek alan, iki algoritma
 * ====================================================================== */

test('kimlikNoCoz: uzunluga gore dogru algoritmayi secer', (t) => {
  const v = D.kimlikNoCoz(vknUret('123456789'));
  const tc = D.kimlikNoCoz(tcknUret('123456789'));

  assert.deepEqual({ ok: v.ok, tur: v.tur }, { ok: true, tur: 'vkn' });
  assert.deepEqual({ ok: tc.ok, tur: tc.tur }, { ok: true, tur: 'tckn' });

  /* Sunucuya yazilacak deger RAKAMLARDAN ibaret. */
  assert.equal(D.kimlikNoCoz(' 1234567890 ').deger, '1234567890');
});

test('kimlikNoCoz: hata mesajlari sebebi SOYLER', (t) => {
  assert.match(D.kimlikNoCoz('').hata, /boş/);
  assert.match(D.kimlikNoCoz('12345').hata, /10 hane.*11 hane/);
  assert.match(D.kimlikNoCoz('1234567891').hata, /Vergi Kimlik No/);
  assert.match(D.kimlikNoCoz('10000000147').hata, /T\.C\. Kimlik No/);
});

/* =========================================================================
 * 4. GSM
 * ====================================================================== */

test('GSM: uc yazim bicimi AYNI kayda iner (05XXXXXXXXX)', (t) => {
  /* Mukerrer kontrolu buna dayaniyor: ayni musteri "+90 532 …", "0532-…" ve
     "532…" ile uc kez "yeni" sayilmamali. */
  const hedef = '05321112233';

  [
    '05321112233',
    '0532 111 22 33',
    '0532-111-22-33',
    '+905321112233',
    '+90532-111-2233',
    '5321112233',
    '532 111 22 33',
    ' 0532 111 22 33 '
  ].forEach((girdi) => {
    assert.equal(D.gsmNormalle(girdi), hedef, JSON.stringify(girdi));
    assert.equal(D.gsmGecerli(girdi), true);
  });
});

test('GSM: gecersizler REDDEDILIR ve bos doner', (t) => {
  [
    '0212 111 22 33',   // sabit hat (021x) — GSM degil
    '05321112',         // kisa
    '053211122334',     // uzun
    '+4915112345678',   // yabanci
    '0532 111 22 3A',   // harf
    '',
    null,
    undefined,
    '0',
    '90 532 111 22 33',  // +'siz ulke kodu desende yok
    /*
     * SARTNAME DESENININ BIR SONUCU — bilincli olarak burada:
     * `\+905\d{2}` ulke kodundan hemen sonra rakam ister; "+90 532 …" (ulke
     * kodundan sonra bosluk) desene UYMAZ ve reddedilir. Insanlar uluslararasi
     * bicimi cogunlukla boyle yazar; desen genisletilecekse once buradaki
     * iddia bilincli olarak degistirilmeli. (Rapora not edildi.)
     */
    '+90 532 111 22 33'
  ].forEach((girdi) => {
    assert.equal(D.gsmNormalle(girdi), '', JSON.stringify(girdi) + ' gecersiz olmali');
    assert.equal(D.gsmGecerli(girdi), false);
  });
});

test('GSM: desen sartnamedekiyle BIREBIR', (t) => {
  assert.equal(
    D.GSM_DESEN.source,
    '^(05\\d{2}|\\+905\\d{2}|5\\d{2})[\\s\\-]?\\d{3}[\\s\\-]?\\d{2}[\\s\\-]?\\d{2}$'
  );
});

/* =========================================================================
 * 5. Yeni müşteri formu — toplu denetim
 * ====================================================================== */

const IYI_FORM = {
  firmaAdi: 'Karun Yapı Market',
  yetkili: 'Ahmet Karun',
  il: 'İzmir',
  ilce: 'Bornova',
  telefon: '+905321112233',
  kimlikNo: vknUret('455011156'),
  iskonto: 12
};

test('musteriFormuDenetle: gecerli form → temiz (kayda hazir) veri', (t) => {
  const r = D.musteriFormuDenetle(IYI_FORM, { iskontoTavani: 15 });

  assert.equal(r.ok, true, JSON.stringify(r.hatalar));
  assert.deepEqual(r.temiz, {
    firmaAdi: 'Karun Yapı Market',
    yetkili: 'Ahmet Karun',
    il: 'İzmir',
    ilce: 'Bornova',
    telefon: '05321112233',          // normalize edildi
    kimlikTuru: 'vkn',
    kimlikNo: vknUret('455011156'),
    iskonto: 12
  });
});

test('musteriFormuDenetle: TUM hatalar bir arada doner (ilk hata degil)', (t) => {
  /* Sahadaki plasiyer uc alani da yanlis yazmissa uc ayri tur yerine tek
     turda gormeli. */
  const r = D.musteriFormuDenetle({
    firmaAdi: '', yetkili: ' ', il: '', telefon: '0212', kimlikNo: '123', iskonto: 150
  });

  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.hatalar).sort(), ['firmaAdi', 'il', 'iskonto', 'kimlikNo', 'telefon', 'yetkili']);
  assert.equal(r.temiz, null, 'hatali formda temiz veri YOK');
});

test('musteriFormuDenetle: ISKONTO TAVANI asilamaz', (t) => {
  const r = D.musteriFormuDenetle(Object.assign({}, IYI_FORM, { iskonto: 20 }), { iskontoTavani: 15 });

  assert.equal(r.ok, false);
  assert.match(r.hatalar.iskonto, /tavanınız %15/);

  /* Tavan verilmezse 0-100 araligi yeter. */
  assert.equal(D.musteriFormuDenetle(Object.assign({}, IYI_FORM, { iskonto: 20 })).ok, true);

  /* Tavana ESIT izinli. */
  assert.equal(D.musteriFormuDenetle(Object.assign({}, IYI_FORM, { iskonto: 15 }), { iskontoTavani: 15 }).ok, true);
});

test('musteriFormuDenetle: TCKN de kabul eder ve turunu soyler', (t) => {
  const r = D.musteriFormuDenetle(Object.assign({}, IYI_FORM, { kimlikNo: '10000000146' }));

  assert.equal(r.ok, true);
  assert.equal(r.temiz.kimlikTuru, 'tckn');
  assert.equal(r.temiz.kimlikNo, '10000000146');
});

test('musteriFormuDenetle: bozuk girdi cokme uretmez', (t) => {
  assert.equal(D.musteriFormuDenetle(null).ok, false);
  assert.equal(D.musteriFormuDenetle(undefined).ok, false);
  assert.equal(D.musteriFormuDenetle({}).ok, false);
});
