'use strict';
/* ============================================================================
 *  FAZ 20 — ARAYÜZ DÜĞMESİ: meşgul durumu + etiket biçimi
 *  ---------------------------------------------------------------------------
 *  "Yenile çalışmıyor" şikâyetinin kökü ölçüldü: on bir Yenile düğmesinin on
 *  biri de yükleyiciyi çağırıyordu ama HİÇBİRİ geri bildirim vermiyordu;
 *  aynı veri gelince ekran değişmiyor, kullanıcı art arda basıyordu.
 *
 *  Bu dosya src/renderer/arayuz-dugme.js'in sözlerini kilitler:
 *    1. iş sürerken aria-busy + disabled, bitince (başarı ya da hata) eski hâl
 *    2. süren işe ikinci basış YENİ İŞ AÇMAZ (aynı söz döner)
 *    3. meşgul görünüm en az `enAz` ms sürer (ekranda görülsün)
 *    4. önceden kapalı düğme iş bitince yine kapalı kalır
 *    5. bagla() aynı düğmeye iki kez bağlanmaz (tek tıkta iki istek yok)
 *    6. etiket(): BÜYÜK HARF → Türkçe kurallı başlık düzeni; karışığa dokunmaz
 *
 *  Sahte düğme kullanılır: modül yalnızca öznitelik API'sine dayanır, DOM
 *  gerekmez (çift modlu dışa aktarım — node altında module.exports).
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const A = require(path.join(__dirname, '..', 'src', 'renderer', 'arayuz-dugme.js'));

class SahteDugme {
  constructor() {
    this.nit = {};
    this.disabled = false;
    this.dinleyiciler = {};
  }
  setAttribute(ad, deger) { this.nit[ad] = String(deger); }
  getAttribute(ad) { return Object.prototype.hasOwnProperty.call(this.nit, ad) ? this.nit[ad] : null; }
  removeAttribute(ad) { delete this.nit[ad]; }
  addEventListener(tur, f) { (this.dinleyiciler[tur] = this.dinleyiciler[tur] || []).push(f); }
  tikla() { (this.dinleyiciler.click || []).forEach(function (f) { f({ type: 'click' }); }); }
}

function erteleme() {
  let coz;
  let red;
  const soz = new Promise(function (a, b) { coz = a; red = b; });
  return { soz: soz, coz: coz, red: red };
}

const uyu = (ms) => new Promise((r) => setTimeout(r, ms));

test('calistir: is SURERKEN aria-busy="true" + disabled; bitince ikisi de kalkar', async () => {
  const d = new SahteDugme();
  const e = erteleme();

  const soz = A.calistir(d, function () { return e.soz; }, { enAz: 0 });

  assert.equal(d.getAttribute('aria-busy'), 'true', 'meşgul işaretli');
  assert.equal(d.disabled, true, 'kilitli');
  assert.equal(A.mesgulMu(d), true);

  e.coz(42);
  assert.equal(await soz, 42, 'işin sonucu aynen döner');

  assert.equal(d.getAttribute('aria-busy'), null, 'işaret kalktı');
  assert.equal(d.disabled, false, 'kilit açıldı');
  assert.equal(A.mesgulMu(d), false);
});

test('calistir: is HATA verse de dugme serbest kalir ve hata geri firlatilir (yutulmaz)', async () => {
  const d = new SahteDugme();

  await assert.rejects(
    A.calistir(d, function () { return Promise.reject(new Error('ağ yok')); }, { enAz: 0 }),
    /ağ yok/
  );

  assert.equal(d.getAttribute('aria-busy'), null);
  assert.equal(d.disabled, false, 'hata sonrası düğme kilitli KALMAZ');
});

test('calistir: es zamanli ikinci basis YENI IS ACMAZ, surenin sozunu dondurur', async () => {
  const d = new SahteDugme();
  const e = erteleme();
  let cagri = 0;
  const is = function () { cagri++; return e.soz; };

  const birinci = A.calistir(d, is, { enAz: 0 });
  const ikinci = A.calistir(d, is, { enAz: 0 });

  assert.equal(cagri, 1, 'yükleyici TEK kez çağrıldı');
  assert.equal(birinci, ikinci, 'aynı söz');

  e.coz('tamam');
  assert.equal(await ikinci, 'tamam');

  /* İş bittikten sonra yeni basış yeni iş açar. */
  await A.calistir(d, function () { cagri++; return 'yeni'; }, { enAz: 0 });
  assert.equal(cagri, 2);
});

test('calistir: cok hizli biten iste bile mesgul gorunum en az enAz ms surer', async () => {
  const d = new SahteDugme();
  const bas = Date.now();

  const soz = A.calistir(d, function () { return 'anında'; }, { enAz: 80 });

  await uyu(20);
  assert.equal(d.getAttribute('aria-busy'), 'true', '20 ms sonra hâlâ meşgul');

  await soz;
  assert.ok(Date.now() - bas >= 75, 'en az ~80 ms görünür kaldı');
  assert.equal(d.getAttribute('aria-busy'), null);
});

test('calistir: varsayilan enAz ENAZ_MS (350) ve sozlesmede yazili', () => {
  assert.equal(A.ENAZ_MS, 350);
});

test('calistir: ONCEDEN kapali dugme is bitince yine KAPALI kalir', async () => {
  const d = new SahteDugme();
  d.disabled = true;

  await A.calistir(d, function () { return 1; }, { enAz: 0 });

  assert.equal(d.disabled, true, 'kendi kapalılığı korunur');
  assert.equal(d.getAttribute('aria-busy'), null);
});

test('calistir: dugme yoksa is yine kosar (zarif dusus); is yoksa bos soz', async () => {
  assert.equal(await A.calistir(null, function () { return 'koştu'; }), 'koştu');
  assert.equal(await A.calistir(new SahteDugme(), null), undefined);
});

test('bagla: tiklama isi mesgul durumuyla calistirir; AYNI dugmeye ikinci baglama YAPILMAZ', async () => {
  const d = new SahteDugme();
  const e = erteleme();
  let cagri = 0;

  assert.equal(A.bagla(d, function () { cagri++; return e.soz; }, { enAz: 0 }), true);
  assert.equal(A.bagla(d, function () { cagri += 100; }), false, 'ikinci bağlama reddedilir');
  assert.equal(d.getAttribute('data-dg-bagli'), '1');

  d.tikla();
  d.tikla();   // iş sürerken ikinci tık
  assert.equal(cagri, 1, 'tek tıkta iki istek yok, süren işe ikinci tık yeni iş açmaz');
  assert.equal(d.getAttribute('aria-busy'), 'true');

  e.coz();
  await uyu(5);
  assert.equal(d.getAttribute('aria-busy'), null);
});

test('bagla: dugme ya da is yoksa false doner, patlamaz', () => {
  assert.equal(A.bagla(null, function () {}), false);
  assert.equal(A.bagla(new SahteDugme(), 'is-degil'), false);
});

test('etiket: BUYUK HARF Turkce kuralli baslik duzenine iner (I→ı, İ→i)', () => {
  assert.equal(A.etiket('EVET, SİL'), 'Evet, Sil');
  assert.equal(A.etiket('ZAMMI UYGULA'), 'Zammı Uygula');
  assert.equal(A.etiket('İŞLENİYOR…'), 'İşleniyor…');
  assert.equal(A.etiket('DIŞA AKTAR'), 'Dışa Aktar');
  assert.equal(A.etiket('BAYİYİ KALICI OLARAK SİL'), 'Bayiyi Kalıcı Olarak Sil');
  assert.equal(A.etiket('EVET, İPTAL ET'), 'Evet, İptal Et');
});

test('etiket: kisaltmalar korunur, kesme isaretinden sonraki ek kuculur, baglaclar kucuk', () => {
  assert.equal(A.etiket('KDV DAHİL'), 'KDV Dahil');
  assert.equal(A.etiket("PIN'İ DEĞİŞTİR"), "PIN'i Değiştir");
  assert.equal(A.etiket('B2B ÜYE'), 'B2B Üye');
  assert.equal(A.etiket('DIŞA AKTAR VE KAYDET'), 'Dışa Aktar ve Kaydet');
  assert.equal(A.etiket('VE KAYDET'), 'Ve Kaydet', 'ilk sözcük bağlaç olsa da büyük başlar');
  assert.equal(A.etiket('%12 İSKONTO'), '%12 İskonto', 'harfsiz parça dokunulmaz');
});

test('etiket: zaten KARISIK duzende yazilmis metne ve harfsiz metne DOKUNMAZ', () => {
  assert.equal(A.etiket('Siparişi Kaydet'), 'Siparişi Kaydet');
  assert.equal(A.etiket('PIN kodu'), 'PIN kodu');
  assert.equal(A.etiket('↶'), '↶');
  assert.equal(A.etiket(''), '');
  assert.equal(A.etiket(null), '');
  assert.equal(A.etiket(undefined), '');
});
