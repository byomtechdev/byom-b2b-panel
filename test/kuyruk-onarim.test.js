'use strict';
/* ============================================================================
 *  KUYRUK ONARIM IPC'LERİ — main.js § 3.8 (M1)
 *  ---------------------------------------------------------------------------
 *  Sahada yaşanan kriz: çevrimdışı açılan müşteri sunucuda silinip yeniden
 *  açılınca (42 → 44) köprülenmiş siparişler `404 Müşteri bulunamadı` aldı,
 *  `kalici_hata`ya düştü ve onaracak hiçbir yol olmadığı için `ayarlar.json`
 *  ELLE temizlendi. main.js'in 49 IPC kanalının hiçbiri o satıra dokunamıyordu.
 *
 *  Bu dosya üç yeni kanalı ve iki güncellenen kanalı kilitler:
 *    siparis:kuyruktan-sil · siparis:kuyrukta-yeniden-bagla ·
 *    musteri:kunyeden-dirilt · sync:durum · sync:esitle (temizlik çağrısı)
 *
 *  YÖNTEM: `main.js` Electron'a bağlı olduğu için `require` EDİLEMEZ. Handler
 *  GÖVDESİ kaynaktan çıkarılıp `new Function` ile koşturulur — yani gerçek
 *  üretim kodu sınanıyor, kopyası değil. Kanal adı değişirse test
 *  "bulunamadı" diye kırılır, sessizce geçmez. (Kalıp: rest-adres.test.js)
 *
 *  NEDEN ANA SÜREÇTE: kuyruk mutasyonu renderer'da yapılamaz — eşitleme turu
 *  aynı diziyi temizliyor ve oku-değiştir-yaz gönderilmiş siparişi diriltir
 *  (Faz 9'da `musteri:kuyruga` aynı gerekçeyle buraya taşındı).
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n?/g, '\n');
const syncMotor = require('../src/renderer/plasiyer-sync-motor.js');

/* ------------------------------------------------------------------ *
 *  Handler çıkarıcı
 * ------------------------------------------------------------------ */

/**
 * `ipcMain.handle('<kanal>', function (...) { … })` gövdesini çıkarır.
 *
 * @param {string} kanal IPC kanal adı.
 * @returns {string} Çağrılabilir fonksiyon metni.
 */
function handlerMetni(kanal) {
  const imza = "ipcMain.handle('" + kanal + "'";
  const basla = MAIN.indexOf(imza);

  assert.notEqual(basla, -1, kanal + ' kanali main.js icinde bulunamadi');

  const kalan = MAIN.slice(basla);
  const bitis = kalan.indexOf('\n});\n');

  assert.notEqual(bitis, -1, kanal + ' govdesinin sonu bulunamadi');

  const tam = kalan.slice(0, bitis);
  const fnBasla = tam.indexOf('function');

  assert.notEqual(fnBasla, -1, kanal + ' icin fonksiyon govdesi yok');

  return tam.slice(fnBasla) + '\n}';
}

/** Kaynaktan bir yardımcı fonksiyon çıkarıp çalıştırılabilir hâle getirir. */
function fonksiyonuCikar(ad) {
  const basla = MAIN.indexOf('function ' + ad + '(');

  assert.notEqual(basla, -1, ad + ' fonksiyonu main.js icinde bulunamadi');

  const kalan = MAIN.slice(basla);
  const bitis = kalan.indexOf('\n}\n');

  assert.notEqual(bitis, -1, ad + ' govdesinin sonu bulunamadi');

  return new Function('return ' + kalan.slice(0, bitis + 3))();
}

/**
 * Handler'ı sahte bir ana süreç bağlamında koşturulabilir hâle getirir.
 *
 * Handler'ların çağırdığı ÜRETİM yardımcıları da kaynaktan çıkarılıp verilir —
 * taklit yazılmaz, yoksa yardımcıdaki bir hata testte görünmezdi.
 *
 * @param {string} kanal  IPC kanal adı.
 * @param {object} baglam Handler'ın kullandığı dış adlar.
 * @returns {function}
 */
function handler(kanal, baglam) {
  const tam = Object.assign({
    kuyrukSatiriBul: fonksiyonuCikar('kuyrukSatiriBul'),
    geciciMusteriKimligi: fonksiyonuCikar('geciciMusteriKimligi')
  }, baglam);

  const adlar = Object.keys(tam);
  const govde = 'return (' + handlerMetni(kanal) + ');';

  return Function.apply(null, adlar.concat([govde])).apply(null, adlar.map((a) => tam[a]));
}

/** Sahte ayar dosyası — okuma/yazma sayılır. */
function sahteAyarlar(baslangic) {
  const kutu = { veri: Object.assign({}, baslangic), yazma: 0 };

  kutu.ayarlariOku = function () { return kutu.veri; };
  kutu.ayarlariYaz = function (yama) {
    kutu.yazma++;
    Object.assign(kutu.veri, yama);
    return kutu.veri;
  };

  return kutu;
}

/** Kuyruk satırı üretir. */
function satir(yerelKimlik, musteriId, ek) {
  return Object.assign({
    durum: syncMotor.BEKLIYOR,
    zaman: '2026-09-28T09:00:00.000Z',
    kayit: {
      yerelKimlik: yerelKimlik,
      plasiyerId: 7,
      musteriId: musteriId,
      odeme: 'nakit',
      kalemler: [{ product_id: 1, quantity: 24 }],
      toplamlar: { genelToplam: 1200 }
    }
  }, ek || {});
}

/* =========================================================================
 * 1. siparis:kuyruktan-sil
 * ====================================================================== */

test('siparis:kuyruktan-sil: kaydı kuyruktan düşürür', async (t) => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [satir('sip-a', 44), satir('sip-b', 45)] });
  const h = handler('siparis:kuyruktan-sil', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-a' });

  assert.equal(sonuc.ok, true);
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu.length, 1);
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[0].kayit.yerelKimlik, 'sip-b');
});

test('siparis:kuyruktan-sil: GÖNDERİLMİŞ kaydı silmez', async (t) => {
  const g = satir('sip-c', 44, { durum: syncMotor.GONDERILDI, siparisId: 900 });
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [g] });
  const h = handler('siparis:kuyruktan-sil', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-c' });

  assert.equal(sonuc.ok, false, 'gonderilmis siparis kuyruktan silinemez');
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu.length, 1);
  assert.equal(kutu.yazma, 0, 'reddedilen istek DISKE YAZMAZ');
});

test('siparis:kuyruktan-sil: olmayan kayıt 404 döner', async (t) => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [] });
  const h = handler('siparis:kuyruktan-sil', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'yok' });

  assert.equal(sonuc.ok, false);
  assert.equal(sonuc.durum, 404);
});

test('siparis:kuyruktan-sil: kimliksiz istek reddedilir', async (t) => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [satir('sip-a', 44)] });
  const h = handler('siparis:kuyruktan-sil', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  assert.equal((await h(null, {})).ok, false);
  assert.equal((await h(null, null)).ok, false);
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu.length, 1, 'bos kimlik BUTUN kuyrugu silmez');
});

/* =========================================================================
 * 2. siparis:kuyrukta-yeniden-bagla
 * ====================================================================== */

test('siparis:kuyrukta-yeniden-bagla: hedefi değiştirir ve kaydı onarır', async (t) => {
  const s = satir('sip-a', 42, { durum: syncMotor.ONARIM_GEREKLI, deneme: 2, hata: 'Müşteri bulunamadı.' });
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [s] });
  const h = handler('siparis:kuyrukta-yeniden-bagla', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-a', musteriId: 44 });

  assert.equal(sonuc.ok, true);

  const yeni = kutu.veri.plasiyerSiparisKuyrugu[0];

  assert.equal(yeni.kayit.musteriId, 44);
  assert.equal(yeni.durum, syncMotor.BEKLIYOR, 'onarildi');
  assert.equal(yeni.deneme, 0, 'sayac sifirlandi');
  assert.equal(yeni.hata, '');
});

test('siparis:kuyrukta-yeniden-bagla: GEÇİCİ kimliğe bağlanamaz', async (t) => {
  const s = satir('sip-a', 42, { durum: syncMotor.ONARIM_GEREKLI });
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [s] });
  const h = handler('siparis:kuyrukta-yeniden-bagla', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  /*
   * Gecici kimlige baglamak siparisi "musterisi henuz esitlenmedi" halkasina
   * sokardi; onarim dugmesi kullaniciya SUNUCUDAKI bayiyi sectirir.
   */
  const sonuc = await h(null, { yerelKimlik: 'sip-a', musteriId: syncMotor.GECICI_ONEK + 'x' });

  assert.equal(sonuc.ok, false);
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[0].kayit.musteriId, 42, 'hedef DEGISMEDI');
});

test('siparis:kuyrukta-yeniden-bagla: geçersiz müşteri kimliği reddedilir', async (t) => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [satir('sip-a', 42, { durum: syncMotor.ONARIM_GEREKLI })] });
  const h = handler('siparis:kuyrukta-yeniden-bagla', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  assert.equal((await h(null, { yerelKimlik: 'sip-a', musteriId: 0 })).ok, false);
  assert.equal((await h(null, { yerelKimlik: 'sip-a', musteriId: -3 })).ok, false);
  assert.equal(kutu.yazma, 0);
});

test('siparis:kuyrukta-yeniden-bagla: GÖNDERİLMİŞ kaydı yeniden bağlamaz', async (t) => {
  const g = satir('sip-c', 44, { durum: syncMotor.GONDERILDI, siparisId: 900 });
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [g] });
  const h = handler('siparis:kuyrukta-yeniden-bagla', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-c', musteriId: 55 });

  assert.equal(sonuc.ok, false, 'yeniden gondermek MUKERRER siparis olurdu');
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[0].kayit.musteriId, 44);
});

/* =========================================================================
 * 3. musteri:kunyeden-dirilt — SAHA SENARYOSUNUN TEK TIKLIK CEVABI
 * ====================================================================== */

test('musteri:kunyeden-dirilt: künyeden YENİ geçici müşteri açar ve siparişi ona bağlar', async (t) => {
  const s = satir('sip-a', 42, {
    durum: syncMotor.ONARIM_GEREKLI,
    deneme: 1,
    hata: 'Müşteri bulunamadı.',
    musteriKunyesi: { id: 'temp_musteri_eski', unvan: 'Ahmetler Ticaret', telefon: '05321112233', il: 'İzmir' }
  });

  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [s], plasiyerYerelMusteriler: [] });
  const h = handler('musteri:kunyeden-dirilt', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-a' });

  assert.equal(sonuc.ok, true);

  const yeniler = kutu.veri.plasiyerYerelMusteriler;

  assert.equal(yeniler.length, 1, 'yeni gecici musteri kuyruga girdi');
  assert.equal(yeniler[0].unvan, 'Ahmetler Ticaret');
  assert.equal(yeniler[0].telefon, '05321112233');
  assert.equal(syncMotor.geciciMi(yeniler[0].id), true, 'kimlik temp_musteri_ ile baslar');
  assert.notEqual(yeniler[0].id, 'temp_musteri_eski', 'ESKI kimlik yeniden kullanilmaz');
  assert.equal(yeniler[0].senkron, false);
  assert.equal(yeniler[0].gercekId, undefined, 'olu kimlik tasinmaz');

  const sip = kutu.veri.plasiyerSiparisKuyrugu[0];

  assert.equal(sip.kayit.musteriId, yeniler[0].id, 'siparis YENI gecici kimlige bagli');
  assert.equal(sip.durum, syncMotor.BEKLIYOR, 'onarildi');
  assert.equal(sip.deneme, 0);
});

test('musteri:kunyeden-dirilt: AYNI ölü kimliğe bağlı TÜM kayıtlar taşınır', async (t) => {
  /* Sahadaki gercek durum: iki siparis + bir not, hepsi 42'ye bagli. */
  const s1 = satir('sip-a', 42, {
    durum: syncMotor.ONARIM_GEREKLI,
    musteriKunyesi: { unvan: 'Ahmetler Ticaret', telefon: '05321112233' }
  });
  const s2 = satir('sip-b', 42, { durum: syncMotor.ONARIM_GEREKLI });
  const s3 = satir('sip-c', 99, { durum: syncMotor.BEKLIYOR });
  const notlar = [
    { durum: syncMotor.BEKLIYOR, yerelKimlik: 'not-1', musteriId: 42, not: 'stok dolu' },
    { durum: syncMotor.BEKLIYOR, yerelKimlik: 'not-2', musteriId: 99, not: 'baska' }
  ];

  const kutu = sahteAyarlar({
    plasiyerSiparisKuyrugu: [s1, s2, s3],
    plasiyerZiyaretKuyrugu: notlar,
    plasiyerYerelMusteriler: []
  });
  const h = handler('musteri:kunyeden-dirilt', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-a' });

  assert.equal(sonuc.ok, true);
  assert.equal(sonuc.siparis, 2, 'iki siparis tasindi');
  assert.equal(sonuc.not, 1, 'bir not tasindi');

  const yeniKimlik = kutu.veri.plasiyerYerelMusteriler[0].id;
  const k = kutu.veri.plasiyerSiparisKuyrugu;

  assert.equal(k[0].kayit.musteriId, yeniKimlik);
  assert.equal(k[1].kayit.musteriId, yeniKimlik, 'ayni olu kimlige bagli IKINCI siparis de tasindi');
  assert.equal(k[1].durum, syncMotor.BEKLIYOR);
  assert.equal(k[2].kayit.musteriId, 99, 'BASKA musterinin siparisine DOKUNULMADI');

  assert.equal(kutu.veri.plasiyerZiyaretKuyrugu[0].musteriId, yeniKimlik);
  assert.equal(kutu.veri.plasiyerZiyaretKuyrugu[1].musteriId, 99, 'baska notun kimligi DEGISMEDI');
});

test('musteri:kunyeden-dirilt: GÖNDERİLMİŞ kayıt taşınmaz', async (t) => {
  const s1 = satir('sip-a', 42, {
    durum: syncMotor.ONARIM_GEREKLI,
    musteriKunyesi: { unvan: 'Ahmetler Ticaret' }
  });
  const s2 = satir('sip-b', 42, { durum: syncMotor.GONDERILDI, siparisId: 700 });

  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [s1, s2], plasiyerYerelMusteriler: [] });
  const h = handler('musteri:kunyeden-dirilt', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  await h(null, { yerelKimlik: 'sip-a' });

  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[1].kayit.musteriId, 42, 'gonderilmis siparis DOKUNULMADI');
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[1].durum, syncMotor.GONDERILDI);
});

test('musteri:kunyeden-dirilt: künye YOKSA reddeder (veri uydurulmaz)', async (t) => {
  const s = satir('sip-a', 42, { durum: syncMotor.ONARIM_GEREKLI });
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [s], plasiyerYerelMusteriler: [] });
  const h = handler('musteri:kunyeden-dirilt', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-a' });

  assert.equal(sonuc.ok, false, '2.2.0 oncesi koprulenen kayitta kunye YOKTUR');
  assert.match(String(sonuc.hata), /künye|bilgi/i);
  assert.equal(kutu.veri.plasiyerYerelMusteriler.length, 0, 'bos musteri ACILMAZ');
  assert.equal(kutu.yazma, 0);
});

/* =========================================================================
 * 4. sync:durum — onarım bekleyenler ayrı sayılır
 * ====================================================================== */

test('sync:durum: onarım bekleyen kayıtlar AYRI sayılır ve hatalıya dahildir', async (t) => {
  const kutu = sahteAyarlar({
    plasiyerSiparisKuyrugu: [
      satir('sip-a', 42, { durum: syncMotor.ONARIM_GEREKLI }),
      satir('sip-b', 44, { durum: syncMotor.KALICI_HATA }),
      satir('sip-c', 44, { durum: syncMotor.BEKLIYOR })
    ],
    plasiyerYerelMusteriler: [],
    plasiyerZiyaretKuyrugu: []
  });

  const h = handler('sync:durum', {
    ayarlariOku: kutu.ayarlariOku,
    syncMotor: syncMotor,
    esitlemeSuruyor: false,
    sonEsitleme: null
  });

  const d = await h();

  assert.equal(d.siparis, 3);
  assert.equal(d.onarim, 1, 'onarim bekleyen ayri sayilir (arayuz dugme basacak)');

  /*
   * ONARIM DA "hatali" SAYILIR: `esitlemeGerekliMi` hepsi hatali ise aga
   * cikmaz. Onarim bekleyeni saymazsak oto-esitleme 60 saniyede bir bosa
   * istek atardi — sahadaki mobil veriyi yakar ve kuyruk yine bosalmaz.
   */
  assert.equal(d.hatali, 2, 'kalici + onarim');
});

/* =========================================================================
 * 5. KAYNAK DENETİMİ — motor doğru olsa da çağrılmıyorsa işe yaramaz
 * ====================================================================== */

test('KAYNAK: sync:esitle müşteri temizliğine KUYRUKLARI verir', (t) => {
  /*
   * Ikinci argumani vermezse esitlenmis musteri listeden duser ve kopru
   * haritasi olur — M1'in tum kurtarma yolu bu cagriya bagli.
   */
  assert.match(
    MAIN,
    /esitlenenMusterileriTemizle\(\s*musteriler\s*,\s*\{[^}]*siparisler[^}]*notlar[^}]*\}\s*\)/,
    'sync:esitle temizlige kuyruklari VERMIYOR'
  );
});

test('KAYNAK: üç onarım kanalı da kayıtlıdır', (t) => {
  ['siparis:kuyruktan-sil', 'siparis:kuyrukta-yeniden-bagla', 'musteri:kunyeden-dirilt'].forEach((k) => {
    assert.ok(MAIN.indexOf("ipcMain.handle('" + k + "'") !== -1, k + ' kanali YOK');
  });
});

/* =========================================================================
 * FAZ 19 — siparis:kuyrukta-odeme-degistir
 * ====================================================================== */

function odemeSatiri(ek) {
  return satir('sip-o', 44, Object.assign({
    durum: syncMotor.ONARIM_GEREKLI, deneme: 1, hata: 'Nakit kapalı.',
    hataKodu: 'b2b_plasiyer_odeme_kapali', izinliOdeme: ['vade', 'kart']
  }, ek || {}));
}

test('Faz 19: kuyrukta-odeme-degistir: yöntemi değiştirir, kaydı ONARIR, eski yöntemi not eder', async (t) => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [odemeSatiri()] });
  const h = handler('siparis:kuyrukta-odeme-degistir', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-o', odeme: 'kart' });

  assert.equal(sonuc.ok, true);
  assert.equal(sonuc.eski, 'nakit');

  const s = kutu.veri.plasiyerSiparisKuyrugu[0];

  assert.equal(s.kayit.odeme, 'kart');
  assert.equal(s.durum, syncMotor.BEKLIYOR, 'yeniden kuyrukta');
  assert.equal(s.deneme, 0);
  assert.equal(s.hataKodu, '', 'onarim kodu temizlendi');
  assert.equal(s.odemeDegisti.eski, 'nakit');
  assert.equal(s.odemeDegisti.yeni, 'kart');
  assert.equal(kutu.yazma, 1, 'TEK yazma');
  assert.equal(s.kayit.musteriId, 44, 'musteri DEGISMEDI');
  assert.equal(s.kayit.yerelKimlik, 'sip-o', 'mukerrer korumasi (yerelKimlik) korunur');
});

test('Faz 19: kuyrukta-odeme-degistir: sunucunun KAPALI dediği yönteme geçilemez', async (t) => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [odemeSatiri({ izinliOdeme: ['vade'] })] });
  const h = handler('siparis:kuyrukta-odeme-degistir', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  const sonuc = await h(null, { yerelKimlik: 'sip-o', odeme: 'kart' });

  assert.equal(sonuc.ok, false);
  assert.match(sonuc.hata, /kapalı/);
  assert.equal(kutu.yazma, 0, 'reddedilen istek DISKE YAZMAZ');
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[0].kayit.odeme, 'nakit');
});

test('Faz 19: kuyrukta-odeme-degistir: geçersiz yöntem, kimliksiz istek, gönderilmiş kayıt REDDEDİLİR', async (t) => {
  const g = odemeSatiri({ durum: syncMotor.GONDERILDI, siparisId: 900 });
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [g] });
  const h = handler('siparis:kuyrukta-odeme-degistir', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, syncMotor });

  assert.equal((await h(null, { yerelKimlik: 'sip-o', odeme: 'havale' })).ok, false, 'gecersiz yontem');
  assert.equal((await h(null, { odeme: 'kart' })).ok, false, 'kimliksiz');
  assert.equal((await h(null, null)).ok, false, 'bos govde');
  assert.equal((await h(null, { yerelKimlik: 'sip-o', odeme: 'kart' })).ok, false, 'gonderilmis siparis degistirilemez');
  assert.equal((await h(null, { yerelKimlik: 'yok', odeme: 'kart' })).durum, 404);
  assert.equal(kutu.yazma, 0);
});
