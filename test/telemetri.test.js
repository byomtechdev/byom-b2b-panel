'use strict';
/* ============================================================================
 *  TELEMETRİ BİRİM TESTİ  —  src/main/byom-telemetri.js
 *  ---------------------------------------------------------------------------
 *  Telemetrinin tek işi var: hata kaydını kaybetmemek ve bunu yaparken
 *  uygulamanın akışına ASLA dokunmamak. Bu dosya o iki sözü kilitler.
 *
 *  NASIL KOŞAR (Electron olmadan)?
 *  Modül `require('electron')` yapar. Düz Node altında bu çağrı bir STRING
 *  (electron ikilisinin yolu) döndürür; `app` ve `ipcMain` undefined olur ve
 *  kuyruk dosyası yazılamaz. Bu yüzden modül yüklenmeden ÖNCE `require.cache`
 *  içine sahte bir `electron` modülü konur:
 *    · app.getPath('userData') → her testte TAZE bir geçici dizin
 *    · ipcMain.on            → kanal adını ve işleyiciyi yakalar
 *  Böylece üretim kodunda tek satır değişmeden gerçek disk davranışı ölçülür.
 *
 *  FETCH: modül küresel `fetch`i çağırır, biz onu testte değiştiririz.
 *  VARSAYILAN stub daima BAŞARISIZ döner — `kur()`'un kurduğu 4 sn'lik kuyruk
 *  boşaltma zamanlayıcısı test ortasında ateşlerse kuyruğu silmesin diye
 *  (başarısızlıkta `kuyruguBosalt` ilk kayıtta durur ve kuyruğa dokunmaz).
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ==========================================================================
 *  SAHTE ELECTRON  +  MODÜL YÜKLEME
 * ========================================================================*/

/** `app.getPath('userData')`in döndüreceği dizin — her testte değişir. */
let veriDizini = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-tlm-'));

/** `ipcMain.on` ile bağlanan kanallar: ad -> işleyici. */
const ipcKanallari = new Map();

/** electron çözülemiyorsa (panelde `npm install` yapılmamış) suite atlanır. */
let electronYolu = null;

try {
  electronYolu = require.resolve('electron');
} catch (e) {
  electronYolu = null;
}

if (electronYolu) {
  const sahte = new Module(electronYolu, null);
  sahte.filename = electronYolu;
  sahte.loaded = true;
  sahte.exports = {
    app: {
      getVersion: function () { return '9.9.9-test'; },
      getPath: function () { return veriDizini; },
      isPackaged: false
    },
    ipcMain: {
      on: function (kanal, isleyici) { ipcKanallari.set(kanal, isleyici); }
    }
  };

  require.cache[electronYolu] = sahte;
}

const T = electronYolu ? require('../src/main/byom-telemetri.js') : null;

/* ==========================================================================
 *  YARDIMCILAR
 * ========================================================================*/

/** Her teste kendi kuyruk dosyasını verir — testler birbirini kirletmez. */
function tazeDizin() {
  veriDizini = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-tlm-'));
  return veriDizini;
}

function kuyruk() {
  try {
    return JSON.parse(fs.readFileSync(T.kuyrukYolu(), 'utf8'));
  } catch (e) {
    return [];
  }
}

const uyu = (ms) => new Promise((r) => setTimeout(r, ms));

async function bekle(kosul, ms) {
  const bitis = Date.now() + (ms || 2000);
  while (Date.now() < bitis) {
    if (kosul()) return true;
    await uyu(10);
  }
  return kosul();
}

/** Aynı mesajın 60 sn susturulmasına takılmamak için her test kendi metnini üretir. */
let sayac = 0;
function tekilMesaj(etiket) {
  sayac += 1;
  return 'TLM-' + etiket + '-' + sayac + '-' + Date.now();
}

/** Varsayılan: her istek başarısız. Stray kuyruk boşaltması zararsız kalsın. */
function fetchBasarisiz() {
  global.fetch = function () { return Promise.resolve({ ok: false, status: 500 }); };
}

/** Sahte electron kurulamadıysa her testin başında atlama sebebini verir. */
function hazirMi(t) {
  if (!T) {
    t.skip('electron cozulemedi: panelde `npm install` gerekiyor');
    return false;
  }
  return true;
}

fetchBasarisiz();

/* ==========================================================================
 *  1) anahtariMaskele — lisans anahtarı ASLA düz gitmez
 * ========================================================================*/

test('anahtariMaskele: bos/gecersiz girdi bos doner', (t) => {
  if (!hazirMi(t)) return;

  assert.equal(T.anahtariMaskele(''), '');
  assert.equal(T.anahtariMaskele(null), '');
  assert.equal(T.anahtariMaskele(undefined), '');
  assert.equal(T.anahtariMaskele('   '), '');
});

test('anahtariMaskele: 4 ve daha kisa anahtar TAMAMEN gizlenir', (t) => {
  if (!hazirMi(t)) return;

  assert.equal(T.anahtariMaskele('AB'), '****');
  assert.equal(T.anahtariMaskele('ABCD'), '****');
});

test('anahtariMaskele: yalnizca son 4 hane gorunur, ham anahtar KAYBOLUR', (t) => {
  if (!hazirMi(t)) return;

  const ham = 'BYOM-1111-2222-3333-9876';
  const maskeli = T.anahtariMaskele(ham);

  assert.equal(maskeli, '****-9876');
  assert.equal(maskeli.indexOf('1111'), -1, 'govde sizmamali');
  assert.equal(maskeli.indexOf('2222'), -1, 'govde sizmamali');
  assert.ok(ham.indexOf(maskeli) === -1, 'maskeli metin ham anahtarin alt dizesi degil');

  assert.equal(T.anahtariMaskele('ABCDE'), '****-BCDE');
  assert.equal(T.anahtariMaskele('  BYOM-0000-1234  '), '****-1234', 'bosluklar kirpilir');
});

/* ==========================================================================
 *  2) yigindanKonum — "hangi dosya, kaçıncı satır?"
 * ========================================================================*/

test('yigindanKonum: yigin izinden dosya/satir/kolon ayiklanir', (t) => {
  if (!hazirMi(t)) return;

  const yigin = 'Error: patladi\n    at kimse (C:\\proje\\panel\\renderer-izgara.js:1234:17)\n    at baska (x.js:1:1)';
  const k = T.yigindanKonum(yigin);

  assert.equal(k.dosya, 'renderer-izgara.js', 'tam yol degil, YALNIZCA dosya adi');
  assert.equal(k.satir, 1234);
  assert.equal(k.kolon, 17);
});

test('yigindanKonum: file:// oneki soyulur, POSIX yolu da calisir', (t) => {
  if (!hazirMi(t)) return;

  const k = T.yigindanKonum('at fn (file:///C:/proje/panel/main.js:42:9)');
  assert.equal(k.dosya, 'main.js');
  assert.equal(k.satir, 42);
  assert.equal(k.kolon, 9);

  const p = T.yigindanKonum('at fn (/home/kisi/panel/src/main/byom.js:7:3)');
  assert.equal(p.dosya, 'byom.js');
  assert.equal(p.satir, 7);
});

test('yigindanKonum: konum yoksa null doner, PATLAMAZ', (t) => {
  if (!hazirMi(t)) return;

  [''  , null, undefined, 'konumsuz bir mesaj', 'Error: sadece mesaj'].forEach((girdi) => {
    const k = T.yigindanKonum(girdi);
    assert.deepEqual(k, { dosya: '', satir: null, kolon: null }, 'girdi: ' + String(girdi));
  });
});

/* ==========================================================================
 *  3) kayitKur — ham hatadan tek biçimli kayda
 * ========================================================================*/

test('kayitKur: Error nesnesinden mesaj, yigin ve konum cikarilir', (t) => {
  if (!hazirMi(t)) return;

  const hata = new Error('izgara cizilemedi');
  const k = T.kayitKur('uncaughtException', hata, 'panel-main');

  assert.equal(k.tip, 'uncaughtException');
  assert.equal(k.kaynak, 'panel-main');
  assert.equal(k.mesaj, 'izgara cizilemedi');
  assert.ok(k.yigin.indexOf('izgara cizilemedi') !== -1, 'yigin izi tasinir');
  assert.equal(k.dosya, 'telemetri.test.js', 'konum yigindan okunur');
  assert.equal(typeof k.satir, 'number');
  assert.ok(k.satir > 0);
});

test('kayitKur: kunye ve ortam alanlari doldurulur, zaman ISO-8601', (t) => {
  if (!hazirMi(t)) return;

  const k = T.kayitKur('hata', new Error(tekilMesaj('ortam')));

  assert.equal(k.surum, '9.9.9-test', 'app.getVersion()');
  assert.equal(k.kaynak, 'panel-main', 'varsayilan kaynak');
  assert.equal(k.ortam.platform, process.platform);
  assert.equal(k.ortam.paketli, false);
  assert.equal(k.ortam.node, process.versions.node);
  assert.match(k.zaman, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

  /* Künye anahtarları HER kayıtta bulunur (boş da olsa) - hub şeması sabit. */
  ['firma', 'lisans', 'hwid', 'plan', 'lisansDurumu'].forEach((alan) => {
    assert.ok(Object.prototype.hasOwnProperty.call(k, alan), 'alan eksik: ' + alan);
  });
});

test('kayitKur: arayuzden gelen konum YIGINA EZDIRILMEZ', (t) => {
  if (!hazirMi(t)) return;

  /*
   * Arayüz window olayından gerçek dosya/satırı zaten biliyor. Yığından
   * yeniden okumak onu test dosyasının konumuna çevirirdi.
   */
  const k = T.kayitKur('window.onerror', {
    mesaj: 'undefined is not a function',
    dosya: 'file:///C:/panel/renderer-vitrin.js',
    satir: 880,
    kolon: 12,
    yigin: 'at baskaDosya (main.js:1:1)',
    sekme: 'vitrin-editor'
  }, 'panel-renderer');

  assert.equal(k.dosya, 'file:///C:/panel/renderer-vitrin.js', 'arayuzun verdigi deger korunur');
  assert.equal(k.satir, 880);
  assert.equal(k.kolon, 12);
  assert.equal(k.sekme, 'vitrin-editor');
  assert.equal(k.kaynak, 'panel-renderer');
});

test('kayitKur: duz metin ve nesne girdileri de kayda cevrilir', (t) => {
  if (!hazirMi(t)) return;

  const m = T.kayitKur('elle', 'sadece bir mesaj');
  assert.equal(m.mesaj, 'sadece bir mesaj');
  assert.equal(m.yigin, '');

  /* Mesajı olmayan nesne JSON'a serilir - bilgi tamamen kaybolmasın. */
  const n = T.kayitKur('elle', { durum: 500, kod: 'bozuk_yanit' });
  assert.ok(n.mesaj.indexOf('bozuk_yanit') !== -1, 'nesne icerigi korunur: ' + n.mesaj);
});

test('kayitKur: uzun metin 4000 karakterde kirpilir (yuk sismez)', (t) => {
  if (!hazirMi(t)) return;

  const uzun = 'x'.repeat(12000);
  const k = T.kayitKur('hata', { mesaj: uzun, yigin: uzun });

  assert.ok(k.mesaj.length < 4100, 'mesaj kirpildi: ' + k.mesaj.length);
  assert.ok(k.yigin.length < 4100, 'yigin kirpildi: ' + k.yigin.length);
  assert.ok(/kısaltıldı/.test(k.mesaj), 'kirpma isareti var');
});

test('kayitKur: kunye geri cagirmasi PATLASA BILE kayit uretilir', (t) => {
  if (!hazirMi(t)) return;

  T.kur({ kunye: function () { throw new Error('lisans durumu okunamadi'); } });

  const k = T.kayitKur('hata', new Error(tekilMesaj('kunye-patlak')));

  assert.equal(k.firma, '', 'kunye bos kalir');
  assert.equal(k.lisans, '');
  assert.ok(k.mesaj.length > 0, 'kayit yine uretilir');
});

test('kayitKur: kunye baglanirsa firma gelir, lisans MASKELI gider', (t) => {
  if (!hazirMi(t)) return;

  const hamAnahtar = 'BYOM-7777-8888-5432';

  T.kur({
    kunye: function () {
      return {
        hwid: 'BYOM-AAAA-BBBB-CCCC-DDDD-EEEE',
        lisans: { firmaAdi: 'Deneme Hirdavat', lisansAnahtari: hamAnahtar, plan: 'pro', durum: 'active' }
      };
    }
  });

  const k = T.kayitKur('hata', new Error(tekilMesaj('kunye')));

  assert.equal(k.firma, 'Deneme Hirdavat');
  assert.equal(k.plan, 'pro');
  assert.equal(k.lisansDurumu, 'active');
  assert.equal(k.hwid, 'BYOM-AAAA-BBBB-CCCC-DDDD-EEEE');
  assert.equal(k.lisans, '****-5432');
  assert.equal(JSON.stringify(k).indexOf(hamAnahtar), -1, 'HAM ANAHTAR yuke hic girmez');
});

/* ==========================================================================
 *  4) parmakIzi — tekrar eden hatayı tanıma
 * ========================================================================*/

test('parmakIzi: ayni hata ayni iz, farkli satir farkli iz', (t) => {
  if (!hazirMi(t)) return;

  const a = { kaynak: 'panel-main', tip: 'hata', dosya: 'renderer.js', satir: 10, mesaj: 'ayni' };
  const b = { kaynak: 'panel-main', tip: 'hata', dosya: 'renderer.js', satir: 10, mesaj: 'ayni' };
  const c = { kaynak: 'panel-main', tip: 'hata', dosya: 'renderer.js', satir: 11, mesaj: 'ayni' };
  const d = { kaynak: 'panel-main', tip: 'hata', dosya: 'renderer.js', satir: 10, mesaj: 'baska' };
  const e = { kaynak: 'panel-renderer', tip: 'hata', dosya: 'renderer.js', satir: 10, mesaj: 'ayni' };

  assert.equal(T.parmakIzi(a), T.parmakIzi(b));
  assert.notEqual(T.parmakIzi(a), T.parmakIzi(c), 'satir ize girer');
  assert.notEqual(T.parmakIzi(a), T.parmakIzi(d), 'mesaj ize girer');
  assert.notEqual(T.parmakIzi(a), T.parmakIzi(e), 'kaynak ize girer');
});

test('parmakIzi: mesajin ilk 160 karakteri esassa AYNI iz sayilir', (t) => {
  if (!hazirMi(t)) return;

  /*
   * Bilinçli davranış: aynı hatanın sonuna değişken bir kimlik eklenmesi
   * (istek id'si, zaman damgası) onu "yeni hata" yapıp sel üretmemeli.
   */
  const ortak = 'y'.repeat(200);
  const a = { kaynak: 'k', tip: 't', dosya: 'f.js', satir: 1, mesaj: ortak + 'AAA' };
  const b = { kaynak: 'k', tip: 't', dosya: 'f.js', satir: 1, mesaj: ortak + 'ZZZ' };

  assert.equal(T.parmakIzi(a), T.parmakIzi(b));
});

/* ==========================================================================
 *  5) Kuyruk — hata anında kayıt diske yazılır
 * ========================================================================*/

test('bildir: kayit SENKRON olarak diske yazilir (cokme sonrasi sag kalir)', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  const mesaj = tekilMesaj('kuyruk');

  assert.equal(kuyruk().length, 0, 'taze dizin bos baslar');

  T.bildir('uncaughtException', new Error(mesaj), 'panel-main');

  /* HİÇ await YOK: kayıt, ağ denemesinden ÖNCE diskte olmalı. main.js'teki
     dialog.showErrorBox ana süreci senkron kilitlediği için bu şart. */
  const k = kuyruk();

  assert.equal(k.length, 1, 'kayit aninda diskte');
  assert.equal(k[0].mesaj, mesaj);
  assert.equal(k[0].tip, 'uncaughtException');
  assert.equal(k[0].kaynak, 'panel-main');
  assert.equal(k[0].dosya, 'telemetri.test.js');
});

test('bildir: ayni hata 60 sn icinde kuyruga IKINCI kez yazilmaz', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  const hata = new Error(tekilMesaj('tekrar'));

  T.bildir('hata', hata, 'panel-main');
  T.bildir('hata', hata, 'panel-main');
  T.bildir('hata', hata, 'panel-main');

  assert.equal(kuyruk().length, 1, 'sel onleyici: tek kayit');
});

test('bildir: FARKLI hatalar ayri ayri kuyruklanir', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  T.bildir('hata', new Error(tekilMesaj('ayri-a')), 'panel-main');
  T.bildir('hata', new Error(tekilMesaj('ayri-b')), 'panel-main');

  assert.equal(kuyruk().length, 2);
});

test('bildir: kuyruk 50 kayitla sinirli, EN YENI kayitlar kalir', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  const etiketler = [];

  for (let i = 0; i < 60; i++) {
    const m = tekilMesaj('tavan-' + i);
    etiketler.push(m);
    T.bildir('hata', { mesaj: m, dosya: 'x.js', satir: i }, 'panel-main');
  }

  const k = kuyruk();

  assert.equal(k.length, T.KUYRUK_EN_COK, 'tavan uygulandi');
  assert.equal(k.length, 50);
  assert.equal(k[k.length - 1].mesaj, etiketler[59], 'en yeni kayit korunur');
  assert.equal(k[0].mesaj, etiketler[10], 'en eski 10 kayit dusmus');
});

test('bildir: disk yazilamazsa (getPath patlar) PATLAMAZ', (t) => {
  if (!hazirMi(t)) return;

  fetchBasarisiz();

  const oncekiDizin = veriDizini;

  /* app.getPath'i bozuyoruz: telemetri kendi hatasini yutmali. */
  veriDizini = null;
  const kirikYol = path.join('\u0000gecersiz', 'yol');

  try {
    veriDizini = kirikYol; // fs bu yolu reddeder
    assert.doesNotThrow(function () {
      T.bildir('hata', new Error(tekilMesaj('disk-yok')), 'panel-main');
    }, 'telemetri kendi hatasini yutar');
  } finally {
    veriDizini = oncekiDizin;
  }
});

/* ==========================================================================
 *  6) Zaman aşımı ve akışı kesmeme
 * ========================================================================*/

test('SURE_ASIMI_MS sozlesmesi 3000 ms', (t) => {
  if (!hazirMi(t)) return;

  assert.equal(T.SURE_ASIMI_MS, 3000, 'panel ve PHP tarafi ayni sureyi kullanir');
  assert.equal(T.UC, '/api/telemetry');
  assert.equal(T.KUYRUK_EN_COK, 50);
});

test('bildir: hub hic yanit vermezse cagiran taraf BEKLEMEZ', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();

  /* Asla çözülmeyen istek: gerçek "hub kapalı / ağ yok" hâli. */
  global.fetch = function () { return new Promise(function () { /* sonsuz */ }); };

  const basla = Date.now();
  T.bildir('hata', new Error(tekilMesaj('askida')), 'panel-main');
  const gecen = Date.now() - basla;

  assert.ok(gecen < 100, 'bildir aninda donmeli, gecen: ' + gecen + 'ms');
  assert.equal(kuyruk().length, 1, 'gidemeyen kayit kuyrukta BEKLER');

  fetchBasarisiz();
});

test('bildir: istek 3 sn sonra AbortSignal ile kesilir', async (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();

  let yakalananSignal = null;

  global.fetch = function (adres, secenek) {
    yakalananSignal = secenek && secenek.signal;
    return new Promise(function (_, reddet) {
      /* Gerçek fetch gibi davran: iptal edilince reddet. */
      if (secenek && secenek.signal) {
        secenek.signal.addEventListener('abort', function () {
          reddet(Object.assign(new Error('iptal'), { name: 'AbortError' }));
        });
      }
    });
  };

  T.bildir('hata', new Error(tekilMesaj('sureasimi')), 'panel-main');

  /*
   * `bildir` isteği MİKRO GÖREVDE atar (Promise.resolve().then), senkron
   * değil - akışı kesmemesinin asıl sebebi bu. Dolayısıyla fetch'in
   * çağrıldığını görmek için bir tur beklemek gerekir.
   */
  const istekAtildi = await bekle(() => yakalananSignal !== null, 500);

  assert.equal(istekAtildi, true, 'istege AbortSignal verilir');
  assert.equal(yakalananSignal.aborted, false, 'baslangicta kesilmemis');

  /* Süre aşımından biraz sonra sinyal düşmüş olmalı. */
  const kesildi = await bekle(() => yakalananSignal.aborted, T.SURE_ASIMI_MS + 900);

  assert.equal(kesildi, true, 'istek ' + T.SURE_ASIMI_MS + ' ms sonra kesilir');
  assert.equal(kuyruk().length, 1, 'kesilen istegin kaydi kuyrukta kalir');

  fetchBasarisiz();
});

test('bildir: fetch SENKRON patlasa bile akis kesilmez', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();

  global.fetch = function () { throw new Error('fetch yok'); };

  assert.doesNotThrow(function () {
    T.bildir('hata', new Error(tekilMesaj('fetch-patlak')), 'panel-main');
  });

  assert.equal(kuyruk().length, 1, 'kayit korunur');

  fetchBasarisiz();
});

test('bildir: istek 200 donerse kayit kuyruktan DUSER', async (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();

  let gidenGovde = null;
  let gidenAdres = null;

  global.fetch = function (adres, secenek) {
    gidenAdres = adres;
    gidenGovde = JSON.parse(secenek.body);
    return Promise.resolve({ ok: true, status: 200 });
  };

  T.bildir('hata', new Error(tekilMesaj('basarili')), 'panel-main');

  assert.equal(kuyruk().length, 1, 'once diske yazilir');

  const bosaldi = await bekle(() => kuyruk().length === 0, 2000);

  assert.equal(bosaldi, true, 'gonderilen kayit kuyruktan silinir');
  assert.ok(/\/api\/telemetry$/.test(gidenAdres), 'uc dogru: ' + gidenAdres);
  assert.equal(gidenGovde.kaynak, 'panel-main', 'govde JSON olarak gider');

  fetchBasarisiz();
});

test('bildir: 5xx donerse kayit kuyrukta KALIR', async (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  T.bildir('hata', new Error(tekilMesaj('besyuz')), 'panel-main');

  await uyu(120);

  assert.equal(kuyruk().length, 1, 'hub hata verdi: kayit silinmez');
});

/* ==========================================================================
 *  7) kuyruguBosalt — önceki oturumdan kalanlar
 * ========================================================================*/

test('kuyruguBosalt: hepsi gidince kuyruk tamamen bosalir', async (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  T.bildir('hata', new Error(tekilMesaj('bosalt-a')), 'panel-main');
  T.bildir('hata', new Error(tekilMesaj('bosalt-b')), 'panel-main');
  T.bildir('hata', new Error(tekilMesaj('bosalt-c')), 'panel-main');

  await uyu(120);
  assert.equal(kuyruk().length, 3, 'uc kayit bekliyor');

  let deneme = 0;
  global.fetch = function () { deneme += 1; return Promise.resolve({ ok: true, status: 200 }); };

  await T.kuyruguBosalt();

  assert.equal(kuyruk().length, 0, 'kuyruk bosaldi');
  assert.ok(deneme >= 3, 'her kayit denendi, deneme: ' + deneme);

  fetchBasarisiz();
});

test('kuyruguBosalt: ag kapaliysa ILK hatada durur, kuyruk korunur', async (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  T.bildir('hata', new Error(tekilMesaj('agyok-a')), 'panel-main');
  T.bildir('hata', new Error(tekilMesaj('agyok-b')), 'panel-main');
  T.bildir('hata', new Error(tekilMesaj('agyok-c')), 'panel-main');

  await uyu(120);
  assert.equal(kuyruk().length, 3);

  let deneme = 0;
  global.fetch = function () { deneme += 1; return Promise.reject(new Error('ENOTFOUND')); };

  await T.kuyruguBosalt();

  assert.equal(kuyruk().length, 3, 'hicbir kayit kaybolmaz');
  assert.equal(deneme, 1, 'ilk basarisizlikta durur, 50 istek atmaz');

  fetchBasarisiz();
});

/* ==========================================================================
 *  8) IPC — arayüzden gelen hata
 * ========================================================================*/

test('kur: byom:telemetri kanali TEK YONLU olarak baglanir', (t) => {
  if (!hazirMi(t)) return;

  T.kur({ kunye: function () { return {}; } });

  assert.ok(ipcKanallari.has('byom:telemetri'), 'kanal ipcMain.on ile baglandi');
  assert.equal(typeof ipcKanallari.get('byom:telemetri'), 'function');
});

test('kur: arayuzden gelen yuk kuyruga panel-renderer olarak yazilir', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  const isleyici = ipcKanallari.get('byom:telemetri');
  assert.ok(isleyici, 'kanal onceki testte baglandi');

  const mesaj = tekilMesaj('ipc');

  isleyici({}, {
    kaynak: 'panel-renderer',
    tip: 'unhandledrejection',
    mesaj: mesaj,
    dosya: 'renderer-vitrin.js',
    satir: 512,
    kolon: 8,
    sekme: 'vitrin-editor'
  });

  const k = kuyruk();

  assert.equal(k.length, 1);
  assert.equal(k[0].kaynak, 'panel-renderer');
  assert.equal(k[0].tip, 'unhandledrejection');
  assert.equal(k[0].mesaj, mesaj);
  assert.equal(k[0].dosya, 'renderer-vitrin.js');
  assert.equal(k[0].satir, 512);
  assert.equal(k[0].sekme, 'vitrin-editor');
});

test('kur: bozuk IPC yuku gelse bile PATLAMAZ', (t) => {
  if (!hazirMi(t)) return;

  tazeDizin();
  fetchBasarisiz();

  const isleyici = ipcKanallari.get('byom:telemetri');

  [undefined, null, 'metin', 0, [], { mesaj: null }].forEach((bozuk) => {
    assert.doesNotThrow(function () { isleyici({}, bozuk); }, 'yuk: ' + JSON.stringify(bozuk));
  });
});
