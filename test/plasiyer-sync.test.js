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

/*
 * ⚠️ BİLİNÇLİ SÖZ DEĞİŞİKLİĞİ (M7, 2026-09-29): 401 bu listeden ÇIKARILDI.
 *
 * Faz 9'da "4xx = kalıcı" kuralı doğruydu; 401 o zaman yalnızca "jeton süresi
 * doldu" demekti ve kullanıcı zaten giriş yapıyordu. Çoklu makine kullanımıyla
 * birlikte 401 SIK ve GEÇİCİ bir hâle geldi: aynı plasiyer ikinci makinede
 * giriş yapınca birincinin jetonu düşüyor. 401'i kalıcı saymak, o makinedeki
 * bekleyen gerçek siparişleri kullanıcı yeniden giriş yapsa bile sonsuza dek
 * gönderilemez yapıyordu. Gerekçe: BYOM-REGISTRY.md §5.50.
 */
test('kaliciRet: 4xx kalıcı (401 HARİÇ), 409 ve 5xx geçici', (t) => {
  [400, 403, 404, 422].forEach((d) => {
    assert.equal(S.kaliciRet({ durum: d }), true, d + ' kalici');
  });

  /* 401 = "şu an kimliğin yok" — PIN ile girince çözülür, kayıt beklemeli. */
  assert.equal(S.kaliciRet({ durum: 401 }), false, '401 KALICI DEGIL (oturum yenilenir)');

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

/* =========================================================================
 * 8. OTOMATİK TETİKLEME KARARI (Faz 4)
 * ====================================================================== */

test('esitlemeGerekliMi: bekleyen kayıt varsa EVET', (t) => {
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 1, musteri: 0, not: 0, hatali: 0 }), true, 'siparis bekliyor');
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 0, musteri: 2, not: 0, hatali: 0 }), true, 'musteri bekliyor');
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 0, musteri: 0, not: 3, hatali: 0 }), true, 'not bekliyor');
});

test('esitlemeGerekliMi: KUYRUK BOŞSA ağa çıkılmaz', (t) => {
  /*
   * Her 60 saniyede boşa istek atmak müşterinin sitesini gereksiz yorar ve
   * sahada veri kotasını yakar.
   */
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 0, musteri: 0, not: 0, hatali: 0 }), false);
});

test('esitlemeGerekliMi: eşitleme SÜRÜYORSA ikinci tur başlamaz', (t) => {
  assert.equal(S.esitlemeGerekliMi({ ok: true, suruyor: true, siparis: 5, hatali: 0 }), false);
});

test('esitlemeGerekliMi: HEPSİ kalıcı hatalıysa denenmez', (t) => {
  /*
   * 4xx almış bir kayıt yüzünden dakikada bir boşa istek atılmamalı; kuyruk
   * hiç boşalmaz ve kullanıcı o kayıtları zaten listede görüyor.
   */
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 2, musteri: 0, not: 0, hatali: 2 }), false, 'ikisi de kalici');
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 3, musteri: 0, not: 0, hatali: 2 }), true, 'biri hala denenebilir');
  assert.equal(S.esitlemeGerekliMi({ ok: true, siparis: 1, musteri: 1, not: 0, hatali: 1 }), true, 'musteri denenebilir');
});

test('esitlemeGerekliMi: bozuk/başarısız durum yanıtı EVET demez', (t) => {
  [null, undefined, {}, { ok: false, siparis: 5 }, 'bozuk', 0].forEach((x) => {
    assert.equal(S.esitlemeGerekliMi(x), false, 'girdi: ' + String(x));
  });
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

/* =========================================================================
 * FAZ 9 — NOT KÖPRÜSÜ: çevrimdışı müşteriye yazılan ziyaret notu da
 * müşteri eşitlenince gerçek kimliğe bağlanır (eskiden 0 gidiyordu).
 * ====================================================================== */

test('notKoprusuKur: gecici musterili notun kimligi DEGISTIRILIR, izi kalir', (t) => {
  const notlar = [
    { durum: 'bekliyor', musteriId: S.GECICI_ONEK + 'a', not: 'x', yerelKimlik: 'n1' },
    { durum: 'bekliyor', musteriId: 20, not: 'y', yerelKimlik: 'n2' },
    { durum: 'bekliyor', musteriId: S.GECICI_ONEK + 'yok', not: 'z', yerelKimlik: 'n3' }
  ];

  const s = S.notKoprusuKur(notlar, { [S.GECICI_ONEK + 'a']: 77 });

  assert.equal(s.koprulenen, 1);
  assert.equal(s.bekleyen, 1, 'karsiligi olmayan not dokunulmadan bekler');
  assert.equal(notlar[0].musteriId, 77);
  assert.equal(notlar[0].geciciKimlik, S.GECICI_ONEK + 'a', 'teshis izi');
  assert.equal(notlar[1].musteriId, 20, 'gercek kimlik degismez');
  assert.equal(notlar[2].musteriId, S.GECICI_ONEK + 'yok');
});

test('notKoprusuKur: bozuk girdi cokertmez', (t) => {
  assert.deepEqual(S.notKoprusuKur(null, {}), { koprulenen: 0, bekleyen: 0 });
  assert.deepEqual(S.notKoprusuKur([null, {}, 5], null), { koprulenen: 0, bekleyen: 0 });
});

test('esitle: notlar da kopruden gecer — musteri esitlenince not gercek kimlikle gider', async (t) => {
  const musteriler = [geciciMusteri('k', 'Kopru Ltd')];
  const notlar = [{ durum: 'bekliyor', musteriId: S.GECICI_ONEK + 'k', etiketler: ['stok-dolu'], not: '', yerelKimlik: 'n-k' }];
  const gidenNotlar = [];

  const ozet = await S.esitle(
    { musteriler, siparisler: [], notlar },
    {
      musteri: async () => ({ ok: true, durum: 200, veri: { user_id: 501 } }),
      siparis: async () => ({ ok: true, durum: 200, veri: { siparisId: 1 } }),
      not: async (n) => { gidenNotlar.push(n.musteriId); return { ok: true, durum: 200, veri: { notId: 9 } }; }
    }
  );

  assert.equal(ozet.koprulenen, 1, 'not koprulendi');
  assert.deepEqual(gidenNotlar, [501], 'not GERCEK kimlikle gitti (0 degil)');
  assert.equal(notlar[0].durum, S.GONDERILDI);
});

/* =========================================================================
 * 8. ONARIM — SİLİNMİŞ MÜŞTERİ VE KİLİTLİ KUYRUK (M1)
 * -------------------------------------------------------------------------
 *  Sahada yaşanan kriz: plasiyer çevrimdışı müşteri açtı, 2 sipariş yazdı;
 *  müşteri sunucuda silinip yeniden açılınca (42 → 44) köprülenmiş siparişler
 *  "404 Müşteri bulunamadı" aldı. 404 kalıcı sayıldığı için kayıtlar
 *  `kalici_hata`ya düştü, `esitlemeGerekliMi` bir daha ağa çıkmadı ve
 *  onaracak hiçbir yol olmadığı için `ayarlar.json` elle temizlendi.
 *
 *  Kökü İKİ veri yok etmesiydi:
 *   · köprü kurulurken `kayit.geciciMusteri = null` (künye siliniyordu)
 *   · `esitlenenMusterileriTemizle` senkron müşteriyi listeden düşürüyordu
 *  Köprüden sonra elde yalnızca bir sayı kalıyordu; o sayı ölünce kurtarma
 *  verisi de ölüyordu.
 * ====================================================================== */

/** Müşterisi silinmiş sipariş yanıtı — sunucunun GERÇEK kodu. */
function musteriSilinmis() {
  return async function () {
    return { ok: false, durum: 404, kod: 'b2b_plasiyer_musteri_yok', hata: 'Müşteri bulunamadı.' };
  };
}

test('retTuru: müşterisi silinmiş sipariş KALICI DEĞİL, ONARIM ister', (t) => {
  assert.equal(S.retTuru({ durum: 404, kod: 'b2b_plasiyer_musteri_yok' }), 'onarim');

  /*
   * KOD OLMADAN 404 hala KALICI: "bilmedigim bir 404" icin onarim kapisi
   * acmak, kullaniciya cozemeyecegi bir dugme gostermek olurdu.
   */
  assert.equal(S.retTuru({ durum: 404 }), 'kalici', 'kodsuz 404 kalici KALIR');
  assert.equal(S.retTuru({ durum: 400, kod: 'b2b_plasiyer_bos_siparis' }), 'kalici');
  assert.equal(S.retTuru({ durum: 409 }), 'gecici', '409 = once musteriyi esitle');
  assert.equal(S.retTuru({ durum: 0 }), 'gecici', 'ag hatasi');
  assert.equal(S.retTuru({ durum: 503 }), 'gecici');
  assert.equal(S.retTuru(null), 'gecici');
});

test('kaliciRet: onarılabilir ret KALICI SAYILMAZ (eski sözleşme korunur)', (t) => {
  assert.equal(S.kaliciRet({ durum: 404, kod: 'b2b_plasiyer_musteri_yok' }), false);

  /* Faz 9'dan beri kilitli olan söz aynen duruyor. */
  assert.equal(S.kaliciRet({ durum: 404 }), true);
  assert.equal(S.kaliciRet({ durum: 403 }), true);
});

test('denenebilir: onarım bekleyen kayıt OTOMATİK turda denenmez', (t) => {
  assert.equal(S.denenebilir({ durum: S.ONARIM_GEREKLI, deneme: 0 }), false);
});

test('siparisleriGonder: müşterisi silinmiş sipariş ONARIM_GEREKLI olur, sayaç YANMAZ', async (t) => {
  const kuyruk = [siparis(42)];

  const ozet = await S.siparisleriGonder(kuyruk, musteriSilinmis());

  assert.equal(kuyruk[0].durum, S.ONARIM_GEREKLI, 'kalici_hata DEGIL');
  assert.equal(kuyruk[0].deneme || 0, 0, 'insan karari bekleyen kayit deneme hakki YAKMAZ');
  assert.match(kuyruk[0].hata, /Müşteri bulunamadı/);
  assert.equal(ozet.gonderilen, 0);
  assert.equal(ozet.kalan, 1);
  assert.equal(ozet.hatalar.length, 1, 'kullaniciya sebebiyle bildirilir');
  assert.equal(ozet.hatalar[0].onarim, true, 'onarilabilir oldugu isaretlenir');
});

test('siparisleriGonder: onarım bekleyen kayıt İKİNCİ turda tekrar denenmez', async (t) => {
  const kuyruk = [siparis(42)];
  let cagri = 0;

  const gonder = async function () {
    cagri++;
    return { ok: false, durum: 404, kod: 'b2b_plasiyer_musteri_yok', hata: 'Müşteri bulunamadı.' };
  };

  await S.siparisleriGonder(kuyruk, gonder);
  await S.siparisleriGonder(kuyruk, gonder);

  assert.equal(cagri, 1, 'ikinci turda AGA HIC CIKILMADI');
});

test('kayitOnar: onarılan kayıt BEKLİYOR durumuna döner ve deneme sayacı SIFIRLANIR', (t) => {
  const k = { durum: S.ONARIM_GEREKLI, deneme: 3, hata: 'Müşteri bulunamadı.' };

  assert.equal(S.kayitOnar(k), true);
  assert.equal(k.durum, S.BEKLIYOR);
  assert.equal(k.deneme, 0, 'sayac sifirlanmazsa iki denemede yine kilitlenirdi');
  assert.equal(k.hata, '');

  /* Kalici hatali kayit da elle tekrar denenebilir. */
  const kh = { durum: S.KALICI_HATA, deneme: S.EN_COK_DENEME, hata: 'HTTP 400' };
  assert.equal(S.kayitOnar(kh), true);
  assert.equal(kh.durum, S.BEKLIYOR);
  assert.equal(kh.deneme, 0);
});

test('kayitOnar: GÖNDERİLMİŞ kayda dokunmaz', (t) => {
  const k = { durum: S.GONDERILDI, deneme: 0, siparisId: 900 };

  assert.equal(S.kayitOnar(k), false, 'gonderilmis siparis yeniden gonderilirse MUKERRER olur');
  assert.equal(k.durum, S.GONDERILDI);
  assert.equal(S.kayitOnar(null), false);
});

test('kimlikKoprusuKur: müşteri künyesi YEDEKLENİR (kurtarma verisi yok edilmez)', (t) => {
  const g = S.GECICI_ONEK + 'yyy';
  const satir = siparis(g);

  satir.kayit.geciciMusteri = { id: g, unvan: 'Ahmetler Ticaret', telefon: '05321112233', il: 'İzmir' };

  const kopru = {};
  kopru[g] = 44;

  S.kimlikKoprusuKur([satir], kopru);

  assert.equal(satir.kayit.musteriId, 44, 'kopru kuruldu');
  assert.equal(satir.kayit.geciciKimlik, g, 'iz duruyor');

  /* KÜNYE SATIRDA yedek kalır — müşteri sonradan silinse bile diriltilebilir. */
  assert.ok(satir.musteriKunyesi, 'kunye yedegi YOK EDILMEDI');
  assert.equal(satir.musteriKunyesi.unvan, 'Ahmetler Ticaret');
  assert.equal(satir.musteriKunyesi.telefon, '05321112233');
});

test('kimlikKoprusuKur: gövde (kayit) SUNUCUYA GİDEN biçimini korur', (t) => {
  const g = S.GECICI_ONEK + 'zzz';
  const satir = siparis(g);

  satir.kayit.geciciMusteri = { id: g, unvan: 'Kocabiyik' };

  const kopru = {};
  kopru[g] = 55;

  S.kimlikKoprusuKur([satir], kopru);

  /*
   * Yedek KUYRUK SATIRINDA durur, govdede DEGIL: govde `/plasiyer/siparis`
   * semasidir ve `geciciMusteri` diye bir alani yoktur. Yedek govdeye
   * konsaydi sunucu sozlesmesi sessizce buyumus olurdu.
   */
  assert.equal(satir.kayit.geciciMusteri, null, 'govde temiz kaldi');
  assert.equal(satir.kayit.odeme, 'nakit', 'diger govde alanlari degismedi');
  assert.equal(satir.kayit.plasiyerId, 7);
  assert.equal(satir.kayit.kalemler.length, 1);
});

test('esitlenenMusterileriTemizle: bekleyen SİPARİŞİ olan senkron müşteri DÜŞMEZ', (t) => {
  const liste = [
    { id: 'temp_musteri_a', senkron: true, gercekId: 44 },
    { id: 'temp_musteri_b', senkron: true, gercekId: 45 }
  ];

  /* a'nin siparisi kopruden gecti ama HENUZ GONDERILMEDI. */
  const siparisler = [
    { durum: S.ONARIM_GEREKLI, kayit: { musteriId: 44, geciciKimlik: 'temp_musteri_a' } }
  ];

  const temiz = S.esitlenenMusterileriTemizle(liste, { siparisler: siparisler, notlar: [] });

  assert.equal(temiz.length, 1, 'yalnizca b dustu');
  assert.equal(temiz[0].id, 'temp_musteri_a', 'bekleyen kaydi olan musteri KALDI');
});

test('esitlenenMusterileriTemizle: bekleyen NOTU olan senkron müşteri de düşmez', (t) => {
  const liste = [{ id: 'temp_musteri_c', senkron: true, gercekId: 46 }];
  const notlar = [{ durum: S.BEKLIYOR, musteriId: 46, geciciKimlik: 'temp_musteri_c' }];

  const temiz = S.esitlenenMusterileriTemizle(liste, { siparisler: [], notlar: notlar });

  assert.equal(temiz.length, 1);
});

test('esitlenenMusterileriTemizle: gönderilmiş kayıt müşteriyi TUTMAZ', (t) => {
  const liste = [{ id: 'temp_musteri_d', senkron: true, gercekId: 47 }];
  const siparisler = [{ durum: S.GONDERILDI, kayit: { musteriId: 47, geciciKimlik: 'temp_musteri_d' } }];

  const temiz = S.esitlenenMusterileriTemizle(liste, { siparisler: siparisler, notlar: [] });

  assert.equal(temiz.length, 0, 'isi biten musteri listeyi sisirmez');
});

test('esitlenenMusterileriTemizle: İKİNCİ ARGÜMANSIZ çağrı eski davranışı korur', (t) => {
  const liste = [
    { id: 'temp_musteri_e', senkron: true },
    { id: 'temp_musteri_f', senkron: false }
  ];

  const temiz = S.esitlenenMusterileriTemizle(liste);

  assert.equal(temiz.length, 1);
  assert.equal(temiz[0].id, 'temp_musteri_f');
});

test('esitle: SAHA SENARYOSU — müşteri silinmişse sipariş onarılabilir kalır', async (t) => {
  const g = S.GECICI_ONEK + 'saha';
  const m = geciciMusteri('saha', 'Ahmetler Ticaret');
  const satir = siparis(g, 3);

  satir.kayit.geciciMusteri = { id: g, unvan: 'Ahmetler Ticaret', telefon: '05321112233' };

  /* 1. tur: müşteri 42 olarak açılır, sipariş köprülenir ama sunucu 42'yi silmiştir. */
  const ozet = await S.esitle(
    { musteriler: [m], siparisler: [satir], notlar: [] },
    {
      musteri: async () => ({ ok: true, durum: 200, veri: { user_id: 42 } }),
      siparis: musteriSilinmis()
    }
  );

  assert.equal(ozet.koprulenen, 1);
  assert.equal(satir.durum, S.ONARIM_GEREKLI, 'siparis KILITLENMEDI, onarilabilir');
  assert.equal(satir.deneme || 0, 0);

  /* Kurtarma verisi iki yerde birden hayatta: künye yedeği + yerel müşteri. */
  assert.equal(satir.musteriKunyesi.unvan, 'Ahmetler Ticaret');

  const kalanMusteriler = S.esitlenenMusterileriTemizle([m], { siparisler: [satir], notlar: [] });
  assert.equal(kalanMusteriler.length, 1, 'musteri kaydi da KALDI (kopru haritasi yasiyor)');

  /* 2. tur: kullanıcı onardı (yeni müşteriye bağladı) → sipariş gider. */
  satir.kayit.musteriId = 44;
  S.kayitOnar(satir);

  const ozet2 = await S.esitle(
    { musteriler: [], siparisler: [satir], notlar: [] },
    { siparis: async () => ({ ok: true, durum: 200, veri: { siparisId: 777 } }) }
  );

  assert.equal(ozet2.siparis.gonderilen, 1, 'onarimdan sonra GITTI');
  assert.equal(satir.durum, S.GONDERILDI);
});

/* ============================================================================
 *  M7 — ÇOKLU CİHAZ: 401 "kalıcı" DEĞİLDİR
 *
 *  Aynı plasiyer ikinci bir makinede PIN ile girdiğinde sunucudaki jeton yuvası
 *  üzerine yazılır ve BİRİNCİ makinenin jetonu düşer. O makinede bekleyen
 *  çevrimdışı siparişler 401 alır. 401'i 4xx diye "kalıcı" saymak, kullanıcı
 *  aynı makinede yeniden giriş yapsa bile o siparişlerin BİR DAHA HİÇ
 *  denenmemesi demekti — sahada yazılmış gerçek siparişlerin sessiz kaybı.
 *
 *  401 ≠ "istek yanlış". 401 = "şu an kimliğin yok" ve PIN ile girince çözülür.
 * ==========================================================================*/

test('401 KALICI DEĞİL — oturum yenilenince gider', () => {
  assert.equal(S.retTuru({ durum: 401 }), 'yetki');
  assert.notEqual(S.retTuru({ durum: 401 }), 'kalici');
});

test('401 deneme hakkını YAKMAZ', () => {
  const k = { durum: 'bekliyor', deneme: 0 };

  S.hataIsle(k, { durum: 401, hata: 'Oturum süresi doldu.' });
  S.hataIsle(k, { durum: 401, hata: 'Oturum süresi doldu.' });
  S.hataIsle(k, { durum: 401, hata: 'Oturum süresi doldu.' });

  assert.equal(k.deneme, 0, 'sayaç ilerlemedi');
  assert.notEqual(k.durum, 'kalici_hata', 'kalıcı hataya DÜŞMEDİ');
  assert.equal(S.denenebilir(k), true, 'yeniden denenebilir kaldı');
});

test('oturum kapalıyken TAVAN AŞILMAZ — giriş yapınca kayıt hâlâ gider', async () => {
  /* Kullanıcı bir hafta boyunca kapalı oturumla dolaşsa bile. */
  const k = { durum: 'bekliyor', deneme: 0 };

  for (let i = 0; i < 20; i += 1) {
    S.hataIsle(k, { durum: 401 });
  }

  assert.equal(S.denenebilir(k), true, '20 turdan sonra bile denenebilir');
});

test('401 mesajı SEBEBİ söyler (kullanıcı ne yapacağını bilsin)', () => {
  const k = { durum: 'bekliyor', deneme: 0 };

  S.hataIsle(k, { durum: 401, hata: 'Oturum süresi doldu. Tekrar PIN ile giriş yapın.' });

  assert.match(String(k.hata), /oturum/i);
});

test('403 HÂLÂ kalıcı — o gerçekten "bu kaydı yazamazsın" demektir', () => {
  assert.equal(S.retTuru({ durum: 403, kod: 'b2b_plasiyer_portfoy_disi' }), 'kalici');
});

test('400 HÂLÂ kalıcı (sözleşme korundu)', () => {
  assert.equal(S.retTuru({ durum: 400 }), 'kalici');
  assert.equal(S.kaliciRet({ durum: 400 }), true);
});

test('401 kalıcı SAYILMAZ — eski kaliciRet sözleşmesi de öyle der', () => {
  assert.equal(S.kaliciRet({ durum: 401 }), false);
});
