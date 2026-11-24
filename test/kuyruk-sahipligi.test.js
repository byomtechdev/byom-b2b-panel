'use strict';
/* ============================================================================
 *  KUYRUK SAHİPLİĞİ (Faz 22-E) — main.js'teki GERÇEK handler gövdeleri
 *  ---------------------------------------------------------------------------
 *  Ürün sahibi: "X profilinde çalışıp Y profiline girince X'in müşterileri
 *  görünüyor." Kuyruk cihaz geneldir (ayarlar.json); eskiden eşitleme BÜTÜN
 *  kayıtları o an oturumu açık olanın kimliği ve jetonuyla gönderiyordu: X'in
 *  çevrimdışı siparişi Y'nin siparişi olarak açılır, ciro Y'ye yazılırdı.
 *
 *  KİLİTLENEN SÖZLER
 *   1. Kuyruğa yazılan sipariş / müşteri / not, ana süreçteki OTURUMDAN
 *      damgalanır (`sahipPlasiyerId`) — arayüzün gönderdiği kimliğe bakılmaz.
 *   2. Eşitleme yalnızca o anki pazarlamacının kayıtlarını gönderir; başkasının
 *      kayıtları DOKUNULMADAN, sırası korunarak kuyrukta kalır.
 *   3. Damgasız eski sipariş gövdedeki `plasiyerId` ile sahiplenir; hiçbir
 *      sahip bilgisi olmayan kayıt eski davranışla gider (mahsur kalmaz).
 *   4. `sync:durum` oturumdakinin işini sayar, başkasınınkini `baskasinin`'da.
 *   5. §6.1: ikinci çağrı zararsız; tur ortasında patlama veri kaybettirmez.
 *
 *  Handler'lar main.js'ten METİN olarak çıkarılıp sahte bağlamla çalıştırılır
 *  (kuyruk-onarim.test.js ile aynı yöntem) — taklit değil, gerçek kod.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n?/g, '\n');
const syncMotor = require('../src/renderer/plasiyer-sync-motor.js');

function handlerMetni(kanal) {
  const imza = "ipcMain.handle('" + kanal + "'";
  const basla = MAIN.indexOf(imza);

  assert.notEqual(basla, -1, kanal + ' kanali main.js icinde bulunamadi');

  const kalan = MAIN.slice(basla);
  const tam = kalan.slice(0, kalan.indexOf('\n});\n'));

  /* `async function` öneki kesilmesin: kesilirse gövdedeki await derleme hatası olur. */
  const fn = tam.indexOf('function');
  const bas = ('async ' === tam.slice(fn - 6, fn)) ? fn - 6 : fn;

  return tam.slice(bas) + '\n}';
}

function fonksiyonuCikar(ad) {
  const basla = MAIN.indexOf('function ' + ad + '(');

  assert.notEqual(basla, -1, ad + ' fonksiyonu main.js icinde bulunamadi');

  const kalan = MAIN.slice(basla);

  return new Function('return ' + kalan.slice(0, kalan.indexOf('\n}\n') + 3))();
}

function handler(kanal, baglam) {
  const tam = Object.assign({
    kuyrukSahibi: fonksiyonuCikar('kuyrukSahibi'),
    sahibininMi: fonksiyonuCikar('sahibininMi'),
    kuyrukSatiriBul: fonksiyonuCikar('kuyrukSatiriBul'),
    geciciMusteriKimligi: fonksiyonuCikar('geciciMusteriKimligi'),
    syncMotor: syncMotor,
    plasiyerOturumu: null,
    esitlemeSuruyor: false,
    sonEsitleme: null
  }, baglam);

  const adlar = Object.keys(tam);

  return Function.apply(null, adlar.concat(['return (' + handlerMetni(kanal) + ');'])).apply(null, adlar.map((a) => tam[a]));
}

function sahteAyarlar(baslangic) {
  const kutu = { veri: JSON.parse(JSON.stringify(baslangic || {})), yazma: 0 };

  kutu.ayarlariOku = () => kutu.veri;
  kutu.ayarlariYaz = (yama) => { kutu.yazma++; Object.assign(kutu.veri, yama); return kutu.veri; };

  return kutu;
}

/** Kuyruk satırı. `sahip` verilirse damgalı (22-E sonrası), verilmezse damgasız. */
function siparis(yerelKimlik, plasiyerId, sahip) {
  const s = {
    durum: syncMotor.BEKLIYOR,
    zaman: '2026-11-24T09:00:00.000Z',
    kayit: { yerelKimlik, plasiyerId, musteriId: 44, odeme: 'nakit', kalemler: [{ product_id: 1, quantity: 6 }] }
  };

  if (sahip) s.sahipPlasiyerId = sahip;

  return s;
}

/** Eşitleme bağlamı: oturum `id`, istekler kaydedilir. */
function esitleBaglami(kutu, id, istek) {
  const kayit = [];

  return {
    kayit,
    baglam: {
      ayarlariOku: kutu.ayarlariOku,
      ayarlariYaz: kutu.ayarlariYaz,
      plasiyerOturumu: { id, token: 'jeton-' + id, bitis: 0 },
      plasiyerOturumuGecerliMi: () => true,
      plasiyerIstek: async (yol, govde) => {
        kayit.push({ yol, govde: JSON.parse(JSON.stringify(govde)) });
        if (istek) return istek(yol, govde);
        return { ok: true, veri: { siparisId: 900 + kayit.length, notId: 700 + kayit.length, user_id: 500 + kayit.length } };
      }
    }
  };
}

const kimlikler = (liste) => liste.map((s) => s.kayit.yerelKimlik);

/* =========================================================================
 * 1. DAMGA — kuyruğa yazarken sahiplik oturumdan
 * ====================================================================== */

test('siparis:kuyruga: sipariş OTURUMDAKİ pazarlamacıyla damgalanır (gövdedeki kimliğe bakılmaz)', async () => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [] });
  const h = handler('siparis:kuyruga', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, plasiyerOturumu: { id: 7, token: 't' } });

  await h(null, { kalemler: [{ product_id: 1, quantity: 1 }], plasiyerId: 9, musteriId: 44 });

  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[0].sahipPlasiyerId, 7);
});

test('siparis:kuyruga: oturum yokken damga yazılmaz (eski davranış)', async () => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [] });
  const h = handler('siparis:kuyruga', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz });

  await h(null, { kalemler: [{ product_id: 1, quantity: 1 }], musteriId: 44 });

  assert.equal('sahipPlasiyerId' in kutu.veri.plasiyerSiparisKuyrugu[0], false);
});

test('musteri:kuyruga ve ziyaret:kuyruga: çevrimdışı müşteri ve not da damgalanır', async () => {
  const kutu = sahteAyarlar({ plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const ortak = { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, plasiyerOturumu: { id: 7, token: 't' } };

  await handler('musteri:kuyruga', ortak)(null, { id: 'temp_musteri_a', unvan: 'Ege Hırdavat' });
  await handler('ziyaret:kuyruga', ortak)(null, { musteriId: 44, not: 'Uğradım' });

  assert.equal(kutu.veri.plasiyerYerelMusteriler[0].sahipPlasiyerId, 7);
  assert.equal(kutu.veri.plasiyerZiyaretKuyrugu[0].sahipPlasiyerId, 7);
});

test('musteri:kunyeden-dirilt: diriltilen müşteri SİPARİŞİN sahibine aittir (oturumdakine değil)', async () => {
  const satir = siparis('sip-x', 7, 7);
  satir.kayit.musteriId = 'temp_musteri_olu';
  satir.musteriKunyesi = { unvan: 'Ege Hırdavat', telefon: '555' };

  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [satir], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const h = handler('musteri:kunyeden-dirilt', { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, plasiyerOturumu: { id: 8, token: 't' } });

  const sonuc = await h(null, { yerelKimlik: 'sip-x' });

  assert.equal(sonuc.ok, true);
  assert.equal(kutu.veri.plasiyerYerelMusteriler[0].sahipPlasiyerId, 7);
});

/* =========================================================================
 * 2. EŞİTLEME — yalnızca oturumdakinin işi gider
 * ====================================================================== */

test('sync:esitle: Y oturumunda X\'in siparişi GÖNDERİLMEZ, kuyrukta sırasıyla kalır; Y\'ninki ve sahipsiz eski kayıt gider', async () => {
  const sahipsiz = siparis('sip-eski', 0);   // ne damga ne plasiyerId — eski davranış: gönderilir
  const kutu = sahteAyarlar({
    plasiyerSiparisKuyrugu: [siparis('sip-x1', 7, 7), siparis('sip-y', 8, 8), sahipsiz, siparis('sip-x2', 7, 7)],
    plasiyerYerelMusteriler: [],
    plasiyerZiyaretKuyrugu: []
  });
  const { kayit, baglam } = esitleBaglami(kutu, 8);

  const sonuc = await handler('sync:esitle', baglam)();

  assert.equal(sonuc.ok, true);
  assert.deepEqual(kayit.map((k) => k.govde.yerelKimlik), ['sip-y', 'sip-eski'], 'yalnızca Y ve sahipsiz');
  assert.ok(kayit.every((k) => 8 === k.govde.plasiyerId && 'jeton-8' === k.govde.token));
  assert.deepEqual(kimlikler(kutu.veri.plasiyerSiparisKuyrugu), ['sip-x1', 'sip-x2'], 'X\'inkiler sırasıyla kalır');
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu[0].durum, syncMotor.BEKLIYOR, 'X\'in kaydına dokunulmadı');
});

test('sync:esitle: damgasız ESKİ sipariş gövdedeki plasiyerId ile sahiplenir (22-E öncesi kuyruk)', async () => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [siparis('sip-x-eski', 7)], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const y = esitleBaglami(kutu, 8);

  const sonuc = await handler('sync:esitle', y.baglam)();

  assert.equal(sonuc.bosta, true, 'Y için iş yok, ağa çıkılmaz');
  assert.equal(y.kayit.length, 0);

  const x = esitleBaglami(kutu, 7);
  await handler('sync:esitle', x.baglam)();

  assert.deepEqual(x.kayit.map((k) => k.govde.yerelKimlik), ['sip-x-eski'], 'X oturum açınca gider');
  assert.equal(kutu.veri.plasiyerSiparisKuyrugu.length, 0);
});

test('sync:esitle: başkasının çevrimdışı müşterisi ve notu da gönderilmez, kalır', async () => {
  const kutu = sahteAyarlar({
    plasiyerSiparisKuyrugu: [],
    plasiyerYerelMusteriler: [{ id: 'temp_musteri_x', unvan: 'X Bayi', gecici: true, senkron: false, durum: syncMotor.BEKLIYOR, sahipPlasiyerId: 7 }],
    plasiyerZiyaretKuyrugu: [{ durum: syncMotor.BEKLIYOR, yerelKimlik: 'not-x', musteriId: 44, not: 'X notu', sahipPlasiyerId: 7 }]
  });
  const { kayit, baglam } = esitleBaglami(kutu, 8);

  const sonuc = await handler('sync:esitle', baglam)();

  assert.equal(sonuc.bosta, true);
  assert.equal(kayit.length, 0);
  assert.equal(kutu.veri.plasiyerYerelMusteriler.length, 1);
  assert.equal(kutu.veri.plasiyerZiyaretKuyrugu.length, 1);
});

test('§6.1 sync:esitle İKİ KEZ: ikinci tur hiçbir şey göndermez, X\'in kaydı yine yerinde', async () => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [siparis('sip-x', 7, 7), siparis('sip-y', 8, 8)], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const { kayit, baglam } = esitleBaglami(kutu, 8);
  const h = handler('sync:esitle', baglam);

  await h();
  const ikinci = await h();

  assert.equal(kayit.length, 1, 'yalnızca ilk turda sip-y');
  assert.equal(ikinci.bosta, true);
  assert.deepEqual(kimlikler(kutu.veri.plasiyerSiparisKuyrugu), ['sip-x']);
});

test('§6.1 sync:esitle TUR ORTASINDA PATLAMA: hiçbir kayıt kaybolmaz (kendi de, başkasınınki de)', async () => {
  const kutu = sahteAyarlar({ plasiyerSiparisKuyrugu: [siparis('sip-x', 7, 7), siparis('sip-y', 8, 8)], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const { kayit, baglam } = esitleBaglami(kutu, 8, () => { throw new Error('ağ koptu'); });
  const h = handler('sync:esitle', baglam);   // derleme hatası burada patlar, yutulmaz

  try { await h(); } catch (e) { assert.match(String(e && e.message), /ağ koptu/, 'yalnızca enjekte edilen hata yutulur'); }

  assert.equal(kayit.length, 1, 'enjeksiyon gerçekten tetiklendi (sip-y gönderilmeye çalışıldı)');

  assert.deepEqual(kimlikler(kutu.veri.plasiyerSiparisKuyrugu).sort(), ['sip-x', 'sip-y']);
});

/* =========================================================================
 * 3. SAYAÇ — rozet oturumdakinin işini gösterir
 * ====================================================================== */

test('sync:durum: oturumdaki pazarlamacının işini sayar; başkasınınki baskasinin\'da', async () => {
  const kutu = sahteAyarlar({
    plasiyerSiparisKuyrugu: [siparis('sip-x', 7, 7), siparis('sip-y', 8, 8), siparis('sip-x-eski', 7)],
    plasiyerYerelMusteriler: [{ id: 'temp_musteri_x', unvan: 'X', sahipPlasiyerId: 7 }],
    plasiyerZiyaretKuyrugu: []
  });

  const y = await handler('sync:durum', { ayarlariOku: kutu.ayarlariOku, plasiyerOturumu: { id: 8, token: 't' } })();

  assert.equal(y.siparis, 1);
  assert.equal(y.musteri, 0);
  assert.equal(y.baskasinin, 3);

  const yonetici = await handler('sync:durum', { ayarlariOku: kutu.ayarlariOku })();

  assert.equal(yonetici.siparis, 3, 'oturum yokken eski davranış: hepsi');
  assert.equal(yonetici.musteri, 1);
  assert.equal(yonetici.baskasinin, 0);
});
