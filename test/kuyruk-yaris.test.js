'use strict';
/* ============================================================================
 *  KUYRUK YARIŞI — eşitleme sürerken kuyruğa yazılan kayıt KAYBOLMAZ
 *  (main.js'teki GERÇEK handler gövdeleri)
 *  ---------------------------------------------------------------------------
 *  Ürün sahibi: "Yeni updateler geldiğinde sistemdeki eski siparişlere hiçbir
 *  şey olmaması gerekiyor." Güncelleme öncesi incelemede bulundu (Faz 22
 *  öncesinden beri var).
 *
 *  HATA: `sync:esitle` kuyruğu turun BAŞINDA okur, ağ isteklerini bekler
 *  (her biri 45 sn'ye kadar) ve turun SONUNDA kuyruğu o eski kopyadan yeniden
 *  yazar. Saha siparişlerinin HEPSİ önce kuyruğa yazılır ve eşitleme 60 sn'de
 *  bir / bağlantı gelince kendiliğinden çalışır: tur sürerken yazılan sipariş,
 *  not ya da geçici müşteri sondaki yazmada dosyadan silinir — hiç gönderilmez.
 *
 *  Mevcut testler bunu GÖREMEDİ: taklit `ayarlariOku` her çağrıda AYNI nesneyi
 *  döndürüyordu, gerçek kod dosyayı her seferinde yeniden okur (yeni kopya).
 *  Bu dosyadaki taklit gerçeğe sadıktır: her okuma TAZE bir kopya (CLAUDE.md
 *  §6.1 — "taklit, taklit ettiği API'nin yapmadığını yapmamalı").
 *
 *  KİLİTLENEN SÖZLER
 *   1. Tur sürerken kuyruğa yazılan sipariş / not / müşteri tur bitince KUYRUKTA.
 *   2. Tur sürerken kuyruktan silinen kayıt GERİ GELMEZ.
 *   3. Turun kendi sonuçları korunur: gönderilen düşer, hatalı kalır (deneme
 *      sayısıyla), köprülenen kimlik yazılır.
 *   4. Tur sürerken yazılan sipariş, aynı turda eşitlenen geçici müşteriye
 *      bağlıysa müşteri kaydı (gerçek kimliğiyle) KALIR → sonraki tur bağlar.
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

/** main.js'te tanımlıysa yardımcıyı çıkarır (düzeltmeyle eklenen yardımcılar dahil). */
function varsaCikar(ad) {
  return MAIN.indexOf('function ' + ad + '(') === -1 ? undefined : fonksiyonuCikar(ad);
}

function handler(kanal, baglam) {
  const tam = Object.assign({
    kuyrukSahibi: fonksiyonuCikar('kuyrukSahibi'),
    sahibininMi: fonksiyonuCikar('sahibininMi'),
    kuyrukSatiriBul: fonksiyonuCikar('kuyrukSatiriBul'),
    geciciMusteriKimligi: fonksiyonuCikar('geciciMusteriKimligi'),
    kuyrukBirlestir: varsaCikar('kuyrukBirlestir'),
    syncMotor: syncMotor,
    plasiyerOturumu: null,
    esitlemeSuruyor: false,
    sonEsitleme: null
  }, baglam);

  const adlar = Object.keys(tam);

  return Function.apply(null, adlar.concat(['return (' + handlerMetni(kanal) + ');'])).apply(null, adlar.map((a) => tam[a]));
}

/**
 * GERÇEĞE SADIK ayar deposu: `ayarlariOku` her çağrıda dosyayı yeniden okur
 * (JSON.parse → TAZE kopya), `ayarlariYaz` okunanın üstüne yamayı birleştirip
 * dosyaya yazar — main.js'teki ayarlariOku / ayarlariYaz ile aynı anlam.
 */
function dosyaAyarlari(baslangic) {
  const kutu = { metin: JSON.stringify(baslangic || {}), yazma: 0 };

  kutu.ayarlariOku = () => JSON.parse(kutu.metin);
  kutu.ayarlariYaz = (yama) => {
    kutu.yazma++;
    const tam = Object.assign(JSON.parse(kutu.metin), yama || {});
    kutu.metin = JSON.stringify(tam);
    return tam;
  };
  kutu.durum = () => JSON.parse(kutu.metin);

  return kutu;
}

function siparis(yerelKimlik, musteriId, sahip) {
  return {
    durum: syncMotor.BEKLIYOR,
    zaman: '2026-11-24T09:00:00.000Z',
    sahipPlasiyerId: sahip || 7,
    kayit: { yerelKimlik, plasiyerId: sahip || 7, musteriId: musteriId || 44, odeme: 'nakit', kalemler: [{ product_id: 1, quantity: 6 }] }
  };
}

const OTURUM = { id: 7, token: 'jeton-7', bitis: 0 };

/** Eşitleme işleyicisi; `istek(yol, govde)` ağ yanıtını üretir (async olabilir). */
function esitleyici(kutu, istek) {
  const giden = [];
  const h = handler('sync:esitle', {
    ayarlariOku: kutu.ayarlariOku,
    ayarlariYaz: kutu.ayarlariYaz,
    plasiyerOturumu: OTURUM,
    plasiyerOturumuGecerliMi: () => true,
    plasiyerIstek: async (yol, govde) => {
      giden.push({ yol, govde: JSON.parse(JSON.stringify(govde)) });
      return istek(yol, govde, giden.length);
    }
  });

  return { h, giden };
}

function ekleyici(kanal, kutu) {
  return handler(kanal, { ayarlariOku: kutu.ayarlariOku, ayarlariYaz: kutu.ayarlariYaz, plasiyerOturumu: OTURUM });
}

const yerelKimlikler = (liste) => (liste || []).map((s) => s.kayit && s.kayit.yerelKimlik);

/* =========================================================================
 * 1. Tur sürerken yazılan SİPARİŞ kaybolmaz
 * ====================================================================== */

test('YARIS: eşitleme A\'yı gönderirken kuyruğa yazılan sipariş B tur bitince KUYRUKTA (silinmez)', async () => {
  const kutu = dosyaAyarlari({ plasiyerSiparisKuyrugu: [siparis('A')], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const kuyruga = ekleyici('siparis:kuyruga', kutu);

  const { h, giden } = esitleyici(kutu, async (yol) => {
    if ('/plasiyer/siparis' === yol && 1 === giden.length) {
      /* Tur ağda beklerken pazarlamacı yeni sipariş yazar. */
      const c = await kuyruga(null, { yerelKimlik: 'B', plasiyerId: 7, musteriId: 44, kalemler: [{ product_id: 2, quantity: 3 }] });
      assert.equal(c.ok, true, 'B kuyruğa yazıldı');
    }
    return { ok: true, veri: { siparisId: 900 + giden.length } };
  });

  const sonuc = await h();

  assert.equal(sonuc.ok, true);
  assert.deepEqual(yerelKimlikler(kutu.durum().plasiyerSiparisKuyrugu), ['B'], 'A gönderildi ve düştü; B KUYRUKTA bekliyor');
  assert.equal(kutu.durum().plasiyerSiparisKuyrugu[0].durum, syncMotor.BEKLIYOR, 'B bekliyor durumunda');
});

test('YARIS: tur sürerken yazılan ZİYARET NOTU ve GEÇİCİ MÜŞTERİ de kaybolmaz', async () => {
  const kutu = dosyaAyarlari({ plasiyerSiparisKuyrugu: [siparis('A')], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const notEkle = ekleyici('ziyaret:kuyruga', kutu);
  const musteriEkle = ekleyici('musteri:kuyruga', kutu);

  const { h, giden } = esitleyici(kutu, async () => {
    if (1 === giden.length) {
      await notEkle(null, { yerelKimlik: 'not-1', musteriId: 44, il: 'İzmir', not: 'Tur sırasında yazıldı', etiketler: [] });
      const cm = await musteriEkle(null, { id: 'temp_musteri_yeni', unvan: 'Yeni Bayi Ltd.', telefon: '05321112233', il: 'İzmir' });
      assert.equal(cm.ok, true, 'müşteri kuyruğa yazıldı');
    }
    return { ok: true, veri: { siparisId: 901 } };
  });

  await h();

  const d = kutu.durum();
  assert.deepEqual((d.plasiyerZiyaretKuyrugu || []).map((n) => n.yerelKimlik), ['not-1'], 'not KUYRUKTA');
  assert.equal((d.plasiyerYerelMusteriler || []).length, 1, 'geçici müşteri KUYRUKTA');
  assert.equal(d.plasiyerYerelMusteriler[0].unvan, 'Yeni Bayi Ltd.');
});

/* =========================================================================
 * 2. Tur sürerken silinen kayıt geri gelmez
 * ====================================================================== */

test('YARIS: tur sürerken kuyruktan SİLİNEN sipariş geri gelmez', async () => {
  const hatali = siparis('C');
  const kutu = dosyaAyarlari({ plasiyerSiparisKuyrugu: [siparis('A'), hatali], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const sil = ekleyici('siparis:kuyruktan-sil', kutu);

  const { h, giden } = esitleyici(kutu, async (yol, govde) => {
    if ('A' === govde.yerelKimlik) {
      /* A gönderilirken kullanıcı C'yi kuyruktan siler. */
      const c = await sil(null, { yerelKimlik: 'C' });
      assert.equal(c.ok, true, 'C silindi');
      return { ok: true, veri: { siparisId: 901 } };
    }
    return { ok: false, durum: 400, hata: 'reddedildi' };
  });

  await h();

  assert.deepEqual(yerelKimlikler(kutu.durum().plasiyerSiparisKuyrugu), [], 'A gönderildi, C kullanıcı tarafından silindi — DİRİLMEDİ');
  assert.ok(giden.length >= 1);
});

/* =========================================================================
 * 3. Turun kendi sonuçları korunur
 * ====================================================================== */

test('TUR SONUCU: gönderilen düşer, reddedilen hatalı olarak KALIR (deneme sayısıyla), başkasının kaydına dokunulmaz', async () => {
  const kutu = dosyaAyarlari({
    plasiyerSiparisKuyrugu: [siparis('A'), siparis('R'), siparis('Y1', 44, 9)],
    plasiyerYerelMusteriler: [],
    plasiyerZiyaretKuyrugu: []
  });

  const { h } = esitleyici(kutu, async (yol, govde) => {
    if ('R' === govde.yerelKimlik) return { ok: false, durum: 400, kod: 'rest_invalid_param', hata: 'reddedildi' };
    return { ok: true, veri: { siparisId: 901 } };
  });

  await h();

  const kuyruk = kutu.durum().plasiyerSiparisKuyrugu;
  assert.deepEqual(yerelKimlikler(kuyruk), ['R', 'Y1'], 'A düştü; R kaldı; başkasının Y1\'i yerinde');
  const r = kuyruk.find((s) => 'R' === s.kayit.yerelKimlik);
  assert.notEqual(r.durum, syncMotor.BEKLIYOR, 'R\'nin hata durumu YAZILDI (turun sonucu kaybolmadı)');
});

test('KÖPRÜ: geçici müşteri eşitlenir, A köprülenip gider; tur sırasında aynı geçici müşteriye yazılan B için müşteri kaydı KALIR ve sonraki tur B\'yi gerçek kimlikle gönderir', async () => {
  const gecici = { id: 'temp_musteri_x', unvan: 'Ege Hırdavat', telefon: '05321112233', senkron: false, sahipPlasiyerId: 7 };
  const kutu = dosyaAyarlari({
    plasiyerYerelMusteriler: [gecici],
    plasiyerSiparisKuyrugu: [siparis('A', 'temp_musteri_x')],
    plasiyerZiyaretKuyrugu: []
  });
  const kuyruga = ekleyici('siparis:kuyruga', kutu);

  const { h, giden } = esitleyici(kutu, async (yol) => {
    if ('/plasiyer/musteri-esitle' === yol) {
      /* Müşteri eşitlenirken pazarlamacı aynı geçici müşteriye ikinci sipariş yazar. */
      await kuyruga(null, { yerelKimlik: 'B', plasiyerId: 7, musteriId: 'temp_musteri_x', kalemler: [{ product_id: 2, quantity: 1 }] });
      return { ok: true, veri: { user_id: 555 } };
    }
    return { ok: true, veri: { siparisId: 900 + giden.length } };
  });

  await h();

  const d = kutu.durum();
  assert.deepEqual(yerelKimlikler(d.plasiyerSiparisKuyrugu), ['B'], 'A gitti, B kuyrukta');
  assert.equal(d.plasiyerYerelMusteriler.length, 1, 'B bekledigi icin eşitlenmiş müşteri kaydı KALDI');
  assert.equal(Number(d.plasiyerYerelMusteriler[0].gercekId), 555, 'gerçek kimlik saklı');

  /* İkinci tur: B gerçek kimlikle gider, müşteri kaydı düşer. */
  const ikinci = esitleyici(kutu, async () => ({ ok: true, veri: { siparisId: 990 } }));
  await ikinci.h();

  const gidenB = ikinci.giden.find((g) => '/plasiyer/siparis' === g.yol);
  assert.ok(gidenB, 'B gönderildi');
  assert.equal(gidenB.govde.musteriId, '555', 'B GERÇEK müşteri kimliğiyle gitti');
  assert.deepEqual(yerelKimlikler(kutu.durum().plasiyerSiparisKuyrugu), [], 'kuyruk boş');
  assert.equal(kutu.durum().plasiyerYerelMusteriler.length, 0, 'müşteri kaydı artık düştü');
});

/* =========================================================================
 * 4. musteri:esitle-tek — tek müşteri isteği sürerken eklenen müşteri kaybolmaz
 * ====================================================================== */

test('ESITLE-TEK: A müşterisinin isteği sürerken eklenen müşteri B KUYRUKTA kalır; A eşitlenmiş işaretlenir', async () => {
  const kutu = dosyaAyarlari({
    plasiyerYerelMusteriler: [{ id: 'temp_musteri_a', unvan: 'A Ticaret', senkron: false, sahipPlasiyerId: 7 }],
    plasiyerSiparisKuyrugu: [],
    plasiyerZiyaretKuyrugu: []
  });
  const musteriEkle = ekleyici('musteri:kuyruga', kutu);
  const h = handler('musteri:esitle-tek', {
    ayarlariOku: kutu.ayarlariOku,
    ayarlariYaz: kutu.ayarlariYaz,
    plasiyerOturumu: OTURUM,
    plasiyerOturumuGecerliMi: () => true,
    plasiyerIstek: async () => {
      const cm = await musteriEkle(null, { id: 'temp_musteri_b', unvan: 'B Hırdavat', telefon: '05321112244', il: 'Manisa' });
      assert.equal(cm.ok, true, 'B kuyruğa yazıldı');
      return { ok: true, veri: { user_id: 321 } };
    }
  });

  const sonuc = await h(null, { id: 'temp_musteri_a' });

  assert.equal(sonuc.ok, true);
  const liste = kutu.durum().plasiyerYerelMusteriler;
  assert.equal(liste.length, 2, 'B silinmedi');
  const a = liste.find((m) => 'temp_musteri_a' === m.id);
  assert.equal(a.senkron, true, 'A eşitlenmiş işaretlendi');
  assert.equal(Number(a.gercekId), 321);
  assert.ok(liste.some((m) => 'B Hırdavat' === m.unvan), 'B kuyrukta');
});

test('ESITLE-TEK: istek sürerken kuyruktan silinen müşteri geri gelmez', async () => {
  const kutu = dosyaAyarlari({
    plasiyerYerelMusteriler: [{ id: 'temp_musteri_a', unvan: 'A Ticaret', senkron: false, sahipPlasiyerId: 7 }],
    plasiyerSiparisKuyrugu: [],
    plasiyerZiyaretKuyrugu: []
  });
  const sil = ekleyici('musteri:kuyruktan-sil', kutu);
  const h = handler('musteri:esitle-tek', {
    ayarlariOku: kutu.ayarlariOku,
    ayarlariYaz: kutu.ayarlariYaz,
    plasiyerOturumu: OTURUM,
    plasiyerOturumuGecerliMi: () => true,
    plasiyerIstek: async () => {
      const c = await sil(null, { id: 'temp_musteri_a' });
      assert.equal(c.ok, true, 'A kuyruktan silindi');
      return { ok: true, veri: { user_id: 321 } };
    }
  });

  await h(null, { id: 'temp_musteri_a' });

  assert.equal(kutu.durum().plasiyerYerelMusteriler.length, 0, 'silinen A DİRİLMEDİ');
});

/* =========================================================================
 * 5. Geriye dönük: kimliksiz ESKİ kayıt eski davranışla sürer
 * ====================================================================== */

test('ESKİ KAYIT: yerelKimlik taşımayan eski sipariş gönderilince kuyruktan DÜŞER (eski yol) — ikinci kez gönderilmez', async () => {
  const eski = siparis('X');
  delete eski.kayit.yerelKimlik;   // Faz 9 öncesi kuyruk satırı

  const kutu = dosyaAyarlari({ plasiyerSiparisKuyrugu: [eski], plasiyerYerelMusteriler: [], plasiyerZiyaretKuyrugu: [] });
  const { h, giden } = esitleyici(kutu, async () => ({ ok: true, veri: { siparisId: 901 } }));

  await h();

  assert.equal(giden.filter((g) => '/plasiyer/siparis' === g.yol).length, 1, 'bir kez gönderildi');
  assert.equal(kutu.durum().plasiyerSiparisKuyrugu.length, 0, 'gönderilen eski kayıt düştü');

  const ikinci = esitleyici(kutu, async () => ({ ok: true, veri: { siparisId: 902 } }));
  await ikinci.h();
  assert.equal(ikinci.giden.length, 0, 'ikinci turda TEKRAR GÖNDERİLMEDİ');
});
