'use strict';
/* ============================================================================
 *  ÇEVRİMDIŞI EŞİTLEME MOTORU TESTİ — src/renderer/plasiyer-sync-motor.js
 *  ---------------------------------------------------------------------------
 *  Kapsam:
 *   1. Outbox kuyruk boşaltma: müşteri → köprü → sipariş → not sırası
 *   2. GEÇİCİ ID EŞLEŞTİRME: temp_musteri_<uuid> → gerçek user_id
 *   3. Hata toleransı: ağ hatası bekler, 4xx kalıcı hata olur, bir kayıt
 *      diğerlerini DURDURMAZ, deneme sayacı tavanı
 *   4. Temizlik: gönderilen düşer, kalıcı hatalı KALIR (kullanıcı görsün)
 *   5. Özet mesajı
 *
 *  DOM GEREKMEZ: motor saf mantıktır, ağ katmanı enjekte edilir.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/renderer/plasiyer-sync-motor.js');

/* ------------------------------------------------------------------ *
 *  Yardımcılar
 * ------------------------------------------------------------------ */

function geciciMusteri(uuid, unvan) {
  return { id: S.GECICI_ONEK + uuid, gecici: true, senkron: false, unvan: unvan || ('Firma ' + uuid) };
}

function siparis(musteriId, kalemSayisi) {
  return {
    durum: 'bekliyor',
    zaman: '2026-09-12T10:00:00.000Z',
    kayit: {
      plasiyerId: 7,
      musteriId: musteriId,
      odeme: 'nakit',
      kalemler: new Array(kalemSayisi || 1).fill({ product_id: 1, quantity: 24 })
    }
  };
}

function not(etiket) {
  return { durum: 'bekliyor', etiketler: [etiket || 'stok-dolu'], not: '', yerelKimlik: 'n-' + (etiket || 'x') };
}

/** Her zaman başarılı gönderici. */
function basarili(alan, sayac) {
  return async function () {
    sayac.n = (sayac.n || 0) + 1;

    const veri = {};

    if ('musteri' === alan) veri.user_id = 1000 + sayac.n;
    if ('siparis' === alan) veri.siparisId = 2000 + sayac.n;
    if ('not' === alan) veri.notId = 3000 + sayac.n;

    return { ok: true, durum: 200, veri: veri };
  };
}

/** Ağ hatası (geçici). */
function agYok() {
  return async function () { return { ok: false, durum: 0, hata: 'Ağ yok' }; };
}

/** Kalıcı ret. */
function reddet(durum, mesaj) {
  return async function () { return { ok: false, durum: durum, hata: mesaj || ('HTTP ' + durum) }; };
}

/* =========================================================================
 * 1. Saf yardımcılar
 * ====================================================================== */

test('geciciMi: temp_musteri_ önekini ayırır', (t) => {
  assert.equal(S.geciciMi(S.GECICI_ONEK + 'abc'), true);
  assert.equal(S.geciciMi('temp_musteri_x'), true);
  assert.equal(S.geciciMi(42), false, 'sayisal WP kimligi gecici DEGIL');
  assert.equal(S.geciciMi('42'), false);
  assert.equal(S.geciciMi(''), false);
  assert.equal(S.geciciMi(null), false);
  assert.equal(S.geciciMi('musteri_temp_x'), false, 'onek BASTA olmali');
});

test('kaliciRet: 4xx kalıcı, 409 ve 5xx geçici', (t) => {
  [400, 401, 403, 404, 422].forEach((d) => {
    assert.equal(S.kaliciRet({ durum: d }), true, d + ' kalici');
  });

  /* 409 = "once musteriyi esitle" — siradaki turda duzelebilir. */
  assert.equal(S.kaliciRet({ durum: 409 }), false, '409 GECICI (siradaki tur duzeltir)');

  [0, 500, 502, 503].forEach((d) => {
    assert.equal(S.kaliciRet({ durum: d }), false, d + ' gecici');
  });

  assert.equal(S.kaliciRet(null), false, 'yanit yoksa gecici');
});

test('denenebilir: kalıcı hata ve tavan dolunca denenmez', (t) => {
  assert.equal(S.denenebilir({ durum: 'bekliyor', deneme: 0 }), true);
  assert.equal(S.denenebilir({ durum: 'bekliyor', deneme: S.EN_COK_DENEME - 1 }), true);
  assert.equal(S.denenebilir({ durum: 'bekliyor', deneme: S.EN_COK_DENEME }), false, 'tavan');
  assert.equal(S.denenebilir({ durum: S.KALICI_HATA, deneme: 0 }), false, 'kalici hata');
  assert.equal(S.denenebilir({ durum: S.GONDERILDI, deneme: 0 }), false, 'gonderilmis');
  assert.equal(S.denenebilir(null), false);
});

/* =========================================================================
 * 2. GEÇİCİ ID EŞLEŞTİRME
 * ====================================================================== */

test('musterileriEsitle: geçici kimlik gerçek user_id ile köprülenir', async (t) => {
  const m1 = geciciMusteri('aaa', 'Ege Hırdavat');
  const m2 = geciciMusteri('bbb', 'Karadeniz Nalbur');
  const liste = [m1, m2];

  const sayac = {};
  const sonuc = await S.musterileriEsitle(liste, basarili('musteri', sayac));

  assert.equal(sonuc.gonderilen, 2);
  assert.equal(sonuc.kalan, 0);
  assert.equal(sonuc.hatalar.length, 0);

  assert.equal(sonuc.kopru[m1.id], 1001, 'kopru: birinci');
  assert.equal(sonuc.kopru[m2.id], 1002, 'kopru: ikinci');

  assert.equal(m1.senkron, true, 'kayit senkron isaretlendi');
  assert.equal(m1.gercekId, 1001, 'gercek kimlik saklandi');
  assert.equal(m1.durum, S.GONDERILDI);
});

test('musterileriEsitle: GERÇEK kimlikli müşteri atlanır', async (t) => {
  const sayac = {};
  const liste = [{ id: 42, unvan: 'Zaten Kayıtlı' }, geciciMusteri('ccc')];

  const sonuc = await S.musterileriEsitle(liste, basarili('musteri', sayac));

  assert.equal(sonuc.gonderilen, 1, 'yalnizca gecici olan gonderildi');
  assert.equal(sayac.n, 1, 'gercek musteri icin istek ATILMADI');
});

test('musterileriEsitle: zaten eşitlenmiş kayıt tekrar gönderilmez ama köprüye girer', async (t) => {
  const m = geciciMusteri('ddd');
  m.senkron = true;
  m.gercekId = 777;

  const sayac = {};
  const sonuc = await S.musterileriEsitle([m], basarili('musteri', sayac));

  assert.equal(sayac.n, undefined, 'istek atilmadi');
  assert.equal(sonuc.kopru[m.id], 777, 'kopru yine kuruldu');
  assert.equal(sonuc.gonderilen, 0);
});

test('kimlikKoprusuKur: bekleyen siparişlerin kimliği DEĞİŞTİRİLİR', (t) => {
  const g1 = S.GECICI_ONEK + 'aaa';
  const g2 = S.GECICI_ONEK + 'bbb';

  const kuyruk = [siparis(g1), siparis(g2), siparis(42)];

  const sonuc = S.kimlikKoprusuKur(kuyruk, { [g1]: 1001 });

  assert.equal(sonuc.koprulenen, 1, 'kopruye giren bir siparis');
  assert.equal(sonuc.bekleyen, 1, 'kopruye girmeyen bir siparis');

  assert.equal(kuyruk[0].kayit.musteriId, 1001, 'kimlik degisti');
  assert.equal(kuyruk[0].kayit.geciciKimlik, g1, 'eski kimlik IZ olarak saklandi');
  assert.equal(kuyruk[0].kayit.geciciMusteri, null, 'gecici kayit temizlendi');

  assert.equal(kuyruk[1].kayit.musteriId, g2, 'koprusu olmayan DOKUNULMADI');
  assert.equal(kuyruk[2].kayit.musteriId, 42, 'gercek kimlik degismedi');
});

test('kimlikKoprusuKur: bozuk girdi çökertmez', (t) => {
  assert.doesNotThrow(() => S.kimlikKoprusuKur(null, null));
  assert.doesNotThrow(() => S.kimlikKoprusuKur([null, {}, { kayit: null }], {}));

  const s = S.kimlikKoprusuKur([], { x: 1 });
  assert.equal(s.koprulenen, 0);
});

/* =========================================================================
 * 3. SİPARİŞ GÖNDERİMİ
 * ====================================================================== */

test('siparisleriGonder: başarılılar gönderildi işaretlenir', async (t) => {
  const kuyruk = [siparis(42), siparis(43)];
  const sayac = {};

  const sonuc = await S.siparisleriGonder(kuyruk, basarili('siparis', sayac));

  assert.equal(sonuc.gonderilen, 2);
  assert.equal(sonuc.kalan, 0);
  assert.equal(kuyruk[0].durum, S.GONDERILDI);
  assert.equal(kuyruk[0].siparisId, 2001, 'sunucu kimligi saklandi');
});

test('siparisleriGonder: müşterisi HÂLÂ GEÇİCİ olan sipariş GÖNDERİLMEZ', async (t) => {
  const kuyruk = [siparis(S.GECICI_ONEK + 'zzz'), siparis(42)];
  const sayac = {};

  const sonuc = await S.siparisleriGonder(kuyruk, basarili('siparis', sayac));

  /*
   * Sunucu gecici kimlikli siparisi 409 ile reddeder; bosa deneme sayaci
   * yakmak yerine atlanir ve siradaki turda musteri esitlenince gider.
   */
  assert.equal(sayac.n, 1, 'yalnizca gercek kimlikli siparis gonderildi');
  assert.equal(sonuc.gonderilen, 1);
  assert.equal(kuyruk[0].durum, 'bekliyor', 'atlanan siparis bekliyor');
  assert.match(kuyruk[0].hata, /eşitlenmedi/, 'sebep yazildi');
  assert.equal(kuyruk[0].deneme, undefined, 'DENEME SAYACI YANMADI');
});

test('siparisleriGonder: gönderilmiş sipariş tekrar gönderilmez', async (t) => {
  const kuyruk = [siparis(42)];
  kuyruk[0].durum = S.GONDERILDI;

  const sayac = {};
  await S.siparisleriGonder(kuyruk, basarili('siparis', sayac));

  assert.equal(sayac.n, undefined, 'istek atilmadi');
});

/* =========================================================================
 * 4. HATA TOLERANSI
 * ====================================================================== */

test('hata toleransı: AĞ HATASI kaydı kuyrukta bekletir', async (t) => {
  const kuyruk = [siparis(42)];

  const sonuc = await S.siparisleriGonder(kuyruk, agYok());

  assert.equal(sonuc.gonderilen, 0);
  assert.equal(sonuc.kalan, 1, 'kayit kuyrukta');
  assert.equal(kuyruk[0].durum, S.BEKLIYOR, 'hala bekliyor - tekrar denenecek');
  assert.equal(kuyruk[0].deneme, 1, 'deneme sayaci artti');
  assert.equal(sonuc.hatalar.length, 0, 'gecici hata KULLANICIYA gosterilmez');
});

test('hata toleransı: 4xx KALICI hata olur, bir daha denenmez', async (t) => {
  const kuyruk = [siparis(42)];

  const sonuc = await S.siparisleriGonder(kuyruk, reddet(400, 'Sipariş kalemi yok.'));

  assert.equal(kuyruk[0].durum, S.KALICI_HATA, '4xx kalici');
  assert.equal(sonuc.hatalar.length, 1, 'kullaniciya bildirilir');
  assert.match(sonuc.hatalar[0].hata, /kalemi yok/);

  /* Ikinci tur DENEMEZ. */
  const sayac = {};
  await S.siparisleriGonder(kuyruk, basarili('siparis', sayac));

  assert.equal(sayac.n, undefined, 'kalici hatali kayit bir daha denenmez');
});

test('hata toleransı: deneme TAVANI dolunca kalıcı hataya düşer', async (t) => {
  const kuyruk = [siparis(42)];

  for (let i = 0; i < S.EN_COK_DENEME; i++) {
    await S.siparisleriGonder(kuyruk, agYok());
  }

  assert.equal(kuyruk[0].deneme, S.EN_COK_DENEME);
  assert.equal(kuyruk[0].durum, S.KALICI_HATA, 'tavan dolunca kalici');

  const sayac = {};
  await S.siparisleriGonder(kuyruk, basarili('siparis', sayac));
  assert.equal(sayac.n, undefined, 'artik denenmez');
});

test('hata toleransı: bir kaydın patlaması DİĞERLERİNİ durdurmaz', async (t) => {
  const kuyruk = [siparis(42), siparis(43), siparis(44)];
  let n = 0;

  const sonuc = await S.siparisleriGonder(kuyruk, async () => {
    n++;
    if (2 === n) throw new Error('beklenmeyen çöküş');
    return { ok: true, durum: 200, veri: { siparisId: 5000 + n } };
  });

  assert.equal(n, 3, 'UC kayit da denendi');
  assert.equal(sonuc.gonderilen, 2, 'ikisi gitti');
  assert.equal(kuyruk[1].durum, S.BEKLIYOR, 'patlayan bekliyor');
  assert.match(kuyruk[1].hata, /çöküş/);
});

test('hata toleransı: müşteri eşitlemesi patlarsa sipariş turu yine çalışır', async (t) => {
  const m = geciciMusteri('eee');
  const kuyruk = [siparis(42)];

  const sayac = {};

  const ozet = await S.esitle(
    { musteriler: [m], siparisler: kuyruk, notlar: [] },
    {
      musteri: reddet(400, 'Ünvan zorunlu'),
      siparis: basarili('siparis', sayac),
      not: basarili('not', {})
    }
  );

  assert.equal(ozet.musteri.gonderilen, 0, 'musteri gitmedi');
  assert.equal(ozet.siparis.gonderilen, 1, 'GERCEK kimlikli siparis yine gitti');
  assert.equal(ozet.hatalar.length, 1, 'musteri hatasi bildirildi');
  assert.equal(ozet.ok, false);
});

/* =========================================================================
 * 5. TAM TUR — sıra ve köprü
 * ====================================================================== */

test('esitle: SIRA müşteri → köprü → sipariş → not', async (t) => {
  const g = S.GECICI_ONEK + 'fff';
  const m = geciciMusteri('fff', 'Yeni Bayi');

  const kuyruk = [siparis(g)];
  const notlar = [not('ozel-talep')];

  const sira = [];

  const ozet = await S.esitle(
    { musteriler: [m], siparisler: kuyruk, notlar: notlar },
    {
      musteri: async () => { sira.push('musteri'); return { ok: true, durum: 200, veri: { user_id: 555 } }; },
      siparis: async (kayit) => {
        sira.push('siparis:' + kayit.musteriId);
        return { ok: true, durum: 200, veri: { siparisId: 999 } };
      },
      not: async () => { sira.push('not'); return { ok: true, durum: 200, veri: { notId: 111 } }; }
    }
  );

  assert.deepEqual(sira, ['musteri', 'siparis:555', 'not'], 'sira ve KOPRULENMIS kimlik');

  assert.equal(ozet.koprulenen, 1);
  assert.equal(ozet.musteri.gonderilen, 1);
  assert.equal(ozet.siparis.gonderilen, 1);
  assert.equal(ozet.not.gonderilen, 1);
  assert.equal(ozet.toplamGonderilen, 3);
  assert.equal(ozet.ok, true);
  assert.equal(ozet.hatalar.length, 0);
});

test('esitle: müşteri eşitlenemezse siparişi de BEKLER (köprü kurulamadı)', async (t) => {
  const g = S.GECICI_ONEK + 'ggg';
  const m = geciciMusteri('ggg');
  const kuyruk = [siparis(g)];

  const sayac = {};

  const ozet = await S.esitle(
    { musteriler: [m], siparisler: kuyruk, notlar: [] },
    { musteri: agYok(), siparis: basarili('siparis', sayac), not: basarili('not', {}) }
  );

  assert.equal(ozet.koprulenen, 0, 'kopru kurulamadi');
  assert.equal(sayac.n, undefined, 'siparis GONDERILMEDI');
  assert.equal(kuyruk[0].kayit.musteriId, g, 'kimlik hala gecici');
  assert.equal(ozet.siparis.kalan, 1);
});

test('esitle: ikinci tur kaldığı yerden devam eder', async (t) => {
  const g = S.GECICI_ONEK + 'hhh';
  const m = geciciMusteri('hhh');
  const kuyruk = [siparis(g)];

  /* 1. tur: ağ yok. */
  await S.esitle({ musteriler: [m], siparisler: kuyruk, notlar: [] }, { musteri: agYok(), siparis: agYok() });

  assert.equal(m.senkron, false);
  assert.equal(kuyruk[0].kayit.musteriId, g);

  /* 2. tur: ağ geldi. */
  const ozet = await S.esitle(
    { musteriler: [m], siparisler: kuyruk, notlar: [] },
    {
      musteri: async () => ({ ok: true, durum: 200, veri: { user_id: 888 } }),
      siparis: async () => ({ ok: true, durum: 200, veri: { siparisId: 777 } })
    }
  );

  assert.equal(ozet.musteri.gonderilen, 1);
  assert.equal(ozet.koprulenen, 1);
  assert.equal(ozet.siparis.gonderilen, 1);
  assert.equal(kuyruk[0].kayit.musteriId, 888, 'kopru kuruldu');
});

test('esitle: eksik gönderici verilirse o adım atlanır', async (t) => {
  const ozet = await S.esitle({ musteriler: [geciciMusteri('x')], siparisler: [siparis(42)], notlar: [not()] }, {});

  assert.equal(ozet.toplamGonderilen, 0, 'hicbir sey gonderilmedi');
  assert.equal(ozet.ok, true, 'hata da uretilmedi');

  assert.doesNotThrow(() => S.esitle({}, {}));
});

/* =========================================================================
 * 6. TEMİZLİK
 * ====================================================================== */

test('gonderilenleriTemizle: gönderilen düşer, KALICI HATALI KALIR', (t) => {
  const kuyruk = [
    { durum: S.GONDERILDI },
    { durum: S.BEKLIYOR },
    { durum: S.KALICI_HATA, hata: 'Ürün silinmiş' }
  ];

  const temiz = S.gonderilenleriTemizle(kuyruk);

  assert.equal(temiz.length, 2, 'gonderilen dustu');
  assert.equal(temiz[0].durum, S.BEKLIYOR);

  /*
   * Kalici hatali kayit BILINCLI olarak kalir: "su siparis gitmedi, sebebi
   * bu" diyebilmek icin. Sessizce silmek, plasiyerin yazdigi siparisin
   * kaybolmasini kimsenin fark etmemesi olurdu.
   */
  assert.equal(temiz[1].durum, S.KALICI_HATA, 'kalici hatali KALDI');

  assert.deepEqual(S.gonderilenleriTemizle(null), []);
  assert.deepEqual(S.gonderilenleriTemizle([null, undefined]), []);
});

test('esitlenenMusterileriTemizle: senkron olanlar düşer', (t) => {
  const liste = [
    { id: 'temp_musteri_a', senkron: true },
    { id: 'temp_musteri_b', senkron: false }
  ];

  const temiz = S.esitlenenMusterileriTemizle(liste);

  assert.equal(temiz.length, 1);
  assert.equal(temiz[0].id, 'temp_musteri_b');
});

/* =========================================================================
 * 7. ÖZET MESAJI
 * ====================================================================== */

test('ozetMesaji: hiç iş yapılmadıysa BOŞ döner', (t) => {
  assert.equal(S.ozetMesaji(null), '');
  assert.equal(S.ozetMesaji({ toplamGonderilen: 0 }), '', '"0 siparis iletildi" demek gurultudur');
});

test('ozetMesaji: yapılan işi insan diliyle söyler', (t) => {
  const mesaj = S.ozetMesaji({
    toplamGonderilen: 5,
    siparis: { gonderilen: 3 },
    musteri: { gonderilen: 1 },
    not: { gonderilen: 1 },
    hatalar: []
  });

  assert.match(mesaj, /3 adet bekleyen sipariş merkeze iletildi/);
  assert.match(mesaj, /1 yeni müşteri kaydedildi/);
  assert.match(mesaj, /1 ziyaret notu gönderildi/);
});

test('ozetMesaji: hatalar da sayılır', (t) => {
  const mesaj = S.ozetMesaji({
    toplamGonderilen: 2,
    siparis: { gonderilen: 2 },
    musteri: { gonderilen: 0 },
    not: { gonderilen: 0 },
    hatalar: [{ hata: 'x' }, { hata: 'y' }]
  });

  assert.match(mesaj, /2 adet bekleyen sipariş/);
  assert.match(mesaj, /2 kayıt gönderilemedi/);
});
