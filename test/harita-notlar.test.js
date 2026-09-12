'use strict';
/* ============================================================================
 *  HARİTA VERİSİ VE ZİYARET NOTU TESTİ — src/renderer/harita-veri.js
 *  ---------------------------------------------------------------------------
 *  Kapsam:
 *   1. 81 il kütüğü: eksiksizlik, plaka/ad/bölge tutarlılığı, konum sınırları
 *   2. İl çözümleme: Türkçe harf, yaygın yazımlar, plaka
 *   3. Durum geçişleri: beklemede → görüldü → çözüldü, GERİYE GİDİŞ YOK
 *   4. Harita veri filtreleri: il / plasiyer / durum / gün / etiket
 *   5. Çözülmemiş sayacı — "görüldü" DE çözülmemiş sayılır
 *   6. haritayiKur: sunucu yanıtını 81 ile oturtma, tanınmayan il KAYBOLMAZ
 *   7. Yoğunluk tonu ve uyarı kararı
 *   8. Gerçek SVG sınır yollarını besleme kapısı
 *
 *  DOM GEREKMEZ.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../src/renderer/harita-veri.js');

/* ------------------------------------------------------------------ *
 *  Yardımcılar
 * ------------------------------------------------------------------ */

function not(ek) {
  return Object.assign(
    {
      id: 1,
      durum: 'beklemede',
      il: 'İzmir',
      etiketler: ['stok-dolu'],
      not: '',
      plasiyerId: 10,
      plasiyerAdi: 'Ahmet',
      musteriId: 20,
      musteriAdi: 'Ege Hırdavat',
      yanit: '',
      zaman: new Date().toISOString()
    },
    ek || {}
  );
}

function gunOnce(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

/* =========================================================================
 * 1. 81 İL KÜTÜĞÜ
 * ====================================================================== */

test('kütük: TAM 81 il var', (t) => {
  assert.equal(H.ILLER.length, 81);
});

test('kütük: plakalar 1-81 arası ve TEKRARSIZ', (t) => {
  const plakalar = H.ILLER.map((il) => il.plaka).sort((a, b) => a - b);

  assert.equal(new Set(plakalar).size, 81, 'tekrar eden plaka yok');
  assert.equal(plakalar[0], 1);
  assert.equal(plakalar[80], 81);

  /* Hiç boşluk olmamalı: 1..81 eksiksiz. */
  for (let i = 0; i < 81; i++) {
    assert.equal(plakalar[i], i + 1, (i + 1) + '. plaka eksik');
  }
});

test('kütük: il adları tekrarsız ve boş değil', (t) => {
  const adlar = H.ILLER.map((il) => il.ad);

  assert.equal(new Set(adlar).size, 81, 'tekrar eden il adi yok');

  adlar.forEach((ad) => {
    assert.ok(ad && ad.length >= 3, 'gecerli il adi: ' + ad);
  });
});

test('kütük: bilinen plakalar doğru ile işaret eder', (t) => {
  const beklenen = {
    1: 'Adana', 6: 'Ankara', 7: 'Antalya', 16: 'Bursa', 34: 'İstanbul',
    35: 'İzmir', 33: 'Mersin', 42: 'Konya', 55: 'Samsun', 61: 'Trabzon',
    63: 'Şanlıurfa', 65: 'Van', 81: 'Düzce'
  };

  Object.keys(beklenen).forEach((plaka) => {
    assert.equal(H.ilBul(Number(plaka)).ad, beklenen[plaka], plaka + ' plakasi');
  });
});

test('kütük: her ilin bölgesi TANINAN yedi bölgeden biri', (t) => {
  const gecerli = ['Marmara', 'Ege', 'Akdeniz', 'İç Anadolu', 'Karadeniz', 'Doğu Anadolu', 'Güneydoğu Anadolu'];

  H.ILLER.forEach((il) => {
    assert.ok(gecerli.indexOf(il.bolge) !== -1, il.ad + ' bolgesi taninmiyor: ' + il.bolge);
  });

  assert.equal(H.bolgeler().length, 7, 'yedi bolge');
});

test('kütük: konumlar tuval İÇİNDE', (t) => {
  H.ILLER.forEach((il) => {
    assert.ok(il.x > 0 && il.x < H.TUVAL.w, il.ad + ' x tuval disinda: ' + il.x);
    assert.ok(il.y > 0 && il.y < H.TUVAL.h, il.ad + ' y tuval disinda: ' + il.y);
  });
});

test('kütük: coğrafi yön ilişkileri doğru', (t) => {
  /*
   * Sinir poligonlari sematik ama KONUM ILISKISI gercek olmali; harita
   * "Turkiye gibi" okunsun. Birkac temel yon denetimi.
   */
  const izmir = H.ilBul('İzmir');
  const van = H.ilBul('Van');
  const sinop = H.ilBul('Sinop');
  const antalya = H.ilBul('Antalya');
  const edirne = H.ilBul('Edirne');
  const hakkari = H.ilBul('Hakkâri');

  assert.ok(izmir.x < van.x, 'Izmir Vanin BATISINDA');
  assert.ok(edirne.x < izmir.x, 'Edirne Izmirin batisinda');
  assert.ok(sinop.y < antalya.y, 'Sinop Antalyanin KUZEYINDE');
  assert.ok(hakkari.x > van.x || hakkari.y > van.y, 'Hakkari Vanin guneydogusunda');
  assert.ok(H.ilBul('Ankara').x > izmir.x, 'Ankara Izmirin dogusunda');
  assert.ok(H.ilBul('Ankara').x < van.x, 'Ankara Vanin batisinda');
});

test('bolgeIlleri: bölgeye göre süzer', (t) => {
  const ege = H.bolgeIlleri('Ege');

  assert.ok(ege.length >= 5, 'Ege illeri: ' + ege.length);
  ege.forEach((il) => assert.equal(il.bolge, 'Ege'));

  assert.equal(H.bolgeIlleri('ege').length, ege.length, 'kucuk harf de calisir');
  assert.equal(H.bolgeIlleri('Olmayan').length, 0);
});

/* =========================================================================
 * 2. İL ÇÖZÜMLEME
 * ====================================================================== */

test('ilBul: Türkçe harfler ve büyük/küçük harf engel olmaz', (t) => {
  ['İzmir', 'izmir', 'IZMIR', 'ızmır', 'İZMİR'].forEach((y) => {
    assert.equal(H.ilBul(y).plaka, 35, 'yazim: ' + y);
  });

  ['Şanlıurfa', 'sanliurfa', 'ŞANLIURFA', 'urfa'].forEach((y) => {
    assert.equal(H.ilBul(y).plaka, 63, 'yazim: ' + y);
  });

  assert.equal(H.ilBul('Kahramanmaraş').plaka, 46);
  assert.equal(H.ilBul('kmaras').plaka, 46, 'kisaltma');
  assert.equal(H.ilBul('maras').plaka, 46);
  assert.equal(H.ilBul('afyon').plaka, 3, 'eski ad');
  assert.equal(H.ilBul('İçel').plaka, 33, 'Mersinin eski adi');
  assert.equal(H.ilBul('hakkari').plaka, 30, 'supheli sapkali harf');
  assert.equal(H.ilBul('igdir').plaka, 76);
});

test('ilBul: tanınmayan ad null döner', (t) => {
  [null, undefined, '', 'Olmayanşehir', 'xyz', 999, 0].forEach((y) => {
    assert.equal(H.ilBul(y), null, 'girdi: ' + String(y));
  });
});

test('normalize: noktalama ve boşluk atılır', (t) => {
  assert.equal(H.normalize('  İç Anadolu '), 'icanadolu');
  assert.equal(H.normalize('Afyon-Karahisar'), 'afyonkarahisar');
  assert.equal(H.normalize(null), '');
});

/* =========================================================================
 * 3. DURUM GEÇİŞLERİ
 * ====================================================================== */

test('DURUMLAR: sıra beklemede → gorundu → cozuldu', (t) => {
  assert.deepEqual(H.DURUMLAR, ['beklemede', 'gorundu', 'cozuldu']);
});

test('durumGecerliMi', (t) => {
  ['beklemede', 'gorundu', 'cozuldu'].forEach((d) => assert.equal(H.durumGecerliMi(d), true, d));
  ['', null, undefined, 'uydurma', 'COZULDU'].forEach((d) => assert.equal(H.durumGecerliMi(d), false, String(d)));
});

test('ilerleyebilirMi: İLERİ evet, GERİYE HAYIR', (t) => {
  /* Ileri ve ayni yere gecis serbest. */
  assert.equal(H.ilerleyebilirMi('beklemede', 'gorundu'), true);
  assert.equal(H.ilerleyebilirMi('beklemede', 'cozuldu'), true, 'iki adim ileri de olur');
  assert.equal(H.ilerleyebilirMi('gorundu', 'cozuldu'), true);
  assert.equal(H.ilerleyebilirMi('gorundu', 'gorundu'), true, 'ayni yere gecis (idempotent)');
  assert.equal(H.ilerleyebilirMi('cozuldu', 'cozuldu'), true);

  /*
   * GERIYE GIDIS YOK: cozulmus notu "beklemede"ye dondurmek haritadaki
   * kirmizi uyariyi yeniden yakardi ve patron kapattigi isi tekrar acmis
   * olurdu. PHP tarafi da (B2B_Ziyaret::durum_ilerlet) ayni kurali uygular.
   */
  assert.equal(H.ilerleyebilirMi('cozuldu', 'gorundu'), false);
  assert.equal(H.ilerleyebilirMi('cozuldu', 'beklemede'), false);
  assert.equal(H.ilerleyebilirMi('gorundu', 'beklemede'), false);

  /* Gecersiz durumlar. */
  assert.equal(H.ilerleyebilirMi('uydurma', 'cozuldu'), false);
  assert.equal(H.ilerleyebilirMi('beklemede', 'uydurma'), false);
});

test('sonrakiDurum: düğme etiketi için bir sonraki adım', (t) => {
  assert.equal(H.sonrakiDurum('beklemede'), 'gorundu');
  assert.equal(H.sonrakiDurum('gorundu'), 'cozuldu');
  assert.equal(H.sonrakiDurum('cozuldu'), null, 'son duraktan sonrasi yok');
  assert.equal(H.sonrakiDurum('uydurma'), 'gorundu', 'bilinmeyen durumda makul varsayilan');
});

test('cozulmemisMi: GÖRÜLDÜ de çözülmemiştir', (t) => {
  assert.equal(H.cozulmemisMi(not({ durum: 'beklemede' })), true);
  assert.equal(H.cozulmemisMi(not({ durum: 'gorundu' })), true, 'patron okudu ama IS BITMEDI');
  assert.equal(H.cozulmemisMi(not({ durum: 'cozuldu' })), false);
  assert.equal(H.cozulmemisMi(null), false);
});

/* =========================================================================
 * 4. FİLTRELER
 * ====================================================================== */

test('notlariSuz: İL süzgeci (Türkçe harf duyarsız)', (t) => {
  const liste = [not({ il: 'İzmir' }), not({ il: 'Trabzon' }), not({ il: 'izmir' })];

  assert.equal(H.notlariSuz(liste, { il: 'İzmir' }).length, 2, 'iki yazim da tutar');
  assert.equal(H.notlariSuz(liste, { il: 'IZMIR' }).length, 2);
  assert.equal(H.notlariSuz(liste, { il: 'Trabzon' }).length, 1);
  assert.equal(H.notlariSuz(liste, { il: 'Ankara' }).length, 0);
  assert.equal(H.notlariSuz(liste, {}).length, 3, 'suzgecsiz hepsi');
});

test('notlariSuz: PLASİYER süzgeci', (t) => {
  const liste = [not({ plasiyerId: 10 }), not({ plasiyerId: 11 }), not({ plasiyerId: 10 })];

  assert.equal(H.notlariSuz(liste, { plasiyerId: 10 }).length, 2);
  assert.equal(H.notlariSuz(liste, { plasiyerId: 11 }).length, 1);
  assert.equal(H.notlariSuz(liste, { plasiyerId: '10' }).length, 2, 'metin kimlik de cozulur');
  assert.equal(H.notlariSuz(liste, { plasiyerId: 99 }).length, 0);
});

test('notlariSuz: DURUM süzgeci', (t) => {
  const liste = [
    not({ durum: 'beklemede' }),
    not({ durum: 'gorundu' }),
    not({ durum: 'cozuldu' }),
    not({ durum: 'beklemede' })
  ];

  assert.equal(H.notlariSuz(liste, { durum: 'beklemede' }).length, 2);
  assert.equal(H.notlariSuz(liste, { durum: 'cozuldu' }).length, 1);
});

test('notlariSuz: GÜN süzgeci (harita üst barındaki tarih seçici)', (t) => {
  const liste = [
    not({ zaman: gunOnce(0) }),
    not({ zaman: gunOnce(3) }),
    not({ zaman: gunOnce(10) }),
    not({ zaman: gunOnce(40) })
  ];

  assert.equal(H.notlariSuz(liste, { gun: 1 }).length, 1, 'gunluk');
  assert.equal(H.notlariSuz(liste, { gun: 7 }).length, 2, 'haftalik');
  assert.equal(H.notlariSuz(liste, { gun: 30 }).length, 3, 'aylik');
  assert.equal(H.notlariSuz(liste, { gun: 0 }).length, 4, '0 = siniri yok');
});

test('notlariSuz: BOZUK tarihli not SÜZÜLMEZ (şikayet kaybolmaz)', (t) => {
  const liste = [not({ zaman: 'bozuk-tarih' }), not({ zaman: '' }), not({ zaman: gunOnce(40) })];

  /*
   * Tarih alani bozuk diye bir sikayeti gizlemek, onu kaybetmek olurdu.
   * Yalnizca OKUNABILIR ve eski olan dusurulur.
   */
  assert.equal(H.notlariSuz(liste, { gun: 7 }).length, 2, 'okunamayan tarihler kalir');
});

test('notlariSuz: ETİKET süzgeci', (t) => {
  const liste = [
    not({ etiketler: ['stok-dolu'] }),
    not({ etiketler: ['fiyat-yuksek', 'ozel-talep'] }),
    not({ etiketler: [] })
  ];

  assert.equal(H.notlariSuz(liste, { etiket: 'stok-dolu' }).length, 1);
  assert.equal(H.notlariSuz(liste, { etiket: 'ozel-talep' }).length, 1);
  assert.equal(H.notlariSuz(liste, { etiket: 'sikayet-hasar' }).length, 0);
});

test('notlariSuz: süzgeçler BİRLİKTE kesişir', (t) => {
  const liste = [
    not({ il: 'İzmir', plasiyerId: 10, durum: 'beklemede' }),
    not({ il: 'İzmir', plasiyerId: 11, durum: 'beklemede' }),
    not({ il: 'Trabzon', plasiyerId: 10, durum: 'beklemede' }),
    not({ il: 'İzmir', plasiyerId: 10, durum: 'cozuldu' })
  ];

  assert.equal(H.notlariSuz(liste, { il: 'İzmir', plasiyerId: 10, durum: 'beklemede' }).length, 1);
});

test('notlariSuz: bozuk girdi çökertmez', (t) => {
  assert.deepEqual(H.notlariSuz(null, {}), []);
  assert.deepEqual(H.notlariSuz([null, undefined], {}), []);
  assert.doesNotThrow(() => H.notlariSuz([not()], null));
});

test('cozulmemisSayisi: menü rozeti sayacı', (t) => {
  const liste = [
    not({ durum: 'beklemede' }),
    not({ durum: 'gorundu' }),
    not({ durum: 'cozuldu' }),
    not({ il: 'Trabzon', durum: 'beklemede' })
  ];

  assert.equal(H.cozulmemisSayisi(liste), 3, 'beklemede + gorundu');
  assert.equal(H.cozulmemisSayisi(liste, { il: 'İzmir' }), 2, 'il bazinda');
  assert.equal(H.cozulmemisSayisi(liste, { il: 'Trabzon' }), 1);
  assert.equal(H.cozulmemisSayisi([]), 0);
});

/* =========================================================================
 * 5. SUNUCU VERİSİNİ OTURTMA
 * ====================================================================== */

test('haritayiKur: yanıt 81 ile oturur, eksikler SIFIR olur', (t) => {
  const sonuc = H.haritayiKur({
    iller: {
      'İzmir': { bayiSayisi: 3, bayiler: [{ id: 1, unvan: 'A' }], siparis: 5, ciro: 12000, not: { toplam: 2, beklemede: 1, gorundu: 1, cozuldu: 0, cozulmemis: 2 } },
      'Trabzon': { bayiSayisi: 1, siparis: 1, ciro: 500 }
    }
  });

  assert.equal(sonuc.iller.length, 81, 'butun iller listede');

  const izmir = sonuc.iller.find((il) => 35 === il.plaka);

  assert.equal(izmir.bayiSayisi, 3);
  assert.equal(izmir.siparis, 5);
  assert.equal(izmir.ciro, 12000);
  assert.equal(izmir.not.cozulmemis, 2);
  assert.equal(izmir.uyari, true, 'cozulmemis not varsa UYARI');
  assert.equal(izmir.bayiler.length, 1);

  const ankara = sonuc.iller.find((il) => 6 === il.plaka);

  assert.equal(ankara.bayiSayisi, 0, 'veri gelmeyen il sifirlanir');
  assert.equal(ankara.ciro, 0);
  assert.equal(ankara.uyari, false);

  assert.equal(sonuc.toplam.bayi, 4);
  assert.equal(sonuc.toplam.siparis, 6);
  assert.equal(sonuc.toplam.ciro, 12500);
  assert.equal(sonuc.toplam.cozulmemis, 2);
  assert.equal(sonuc.enCokCiro, 12000);
});

test('haritayiKur: TANINMAYAN il adı KAYBOLMAZ', (t) => {
  const sonuc = H.haritayiKur({
    iller: {
      'İzmir': { bayiSayisi: 1, ciro: 100 },
      'Olmayanşehir': { bayiSayisi: 5, ciro: 9999 },
      '—': { bayiSayisi: 2, ciro: 50 }
    }
  });

  assert.equal(sonuc.tanimsiz.length, 2, 'iki taninmayan kayit');

  const adlar = sonuc.tanimsiz.map((x) => x.ad);

  assert.ok(adlar.indexOf('Olmayanşehir') !== -1);
  assert.ok(adlar.indexOf('—') !== -1, 'ili bos bayiler de gorunur');

  /*
   * Sessizce dusurmek "ciro toplami neden tutmuyor" diye aranacak bir hata
   * olurdu. Taninmayan kayitlar il toplamina GIRMEZ ama listede DURUR.
   */
  assert.equal(sonuc.toplam.ciro, 100, 'taninmayan ciro il toplamina girmez');
});

test('haritayiKur: AYNI ilin iki yazımı TOPLANIR', (t) => {
  const sonuc = H.haritayiKur({
    iller: {
      'İzmir': { bayiSayisi: 2, ciro: 100, siparis: 1 },
      'izmir': { bayiSayisi: 3, ciro: 200, siparis: 2 }
    }
  });

  const izmir = sonuc.iller.find((il) => 35 === il.plaka);

  assert.equal(izmir.bayiSayisi, 5, 'iki yazim toplandi');
  assert.equal(izmir.ciro, 300);
  assert.equal(izmir.siparis, 3);
  assert.equal(sonuc.tanimsiz.length, 0);
});

test('haritayiKur: boş/bozuk yanıt çökertmez', (t) => {
  [null, {}, { iller: null }, { iller: 'bozuk' }].forEach((y) => {
    const s = H.haritayiKur(y);

    assert.equal(s.iller.length, 81, 'girdi: ' + JSON.stringify(y));
    assert.equal(s.toplam.ciro, 0);
    assert.equal(s.enCokCiro, 0);
  });
});

/* =========================================================================
 * 6. YOĞUNLUK VE UYARI
 * ====================================================================== */

test('yogunluk: 0-1 arası, en yüksek ile göre ölçeklenir', (t) => {
  const il = { ciro: 100, siparis: 5, bayiSayisi: 2 };

  assert.equal(H.yogunluk(il, 100, 'ciro'), 1, 'en yuksek = 1');
  assert.ok(H.yogunluk(il, 400, 'ciro') > 0 && H.yogunluk(il, 400, 'ciro') < 1);
  assert.equal(H.yogunluk({ ciro: 0 }, 100, 'ciro'), 0, 'sifir deger = 0');
  assert.equal(H.yogunluk(il, 0, 'ciro'), 0, 'tavan 0 ise 0');

  /* Karekök ölçek: 1/4 değer yarı ton verir — tek büyük il diğerlerini
     tamamen soluk bırakmasın. */
  assert.equal(H.yogunluk({ ciro: 25 }, 100, 'ciro'), 0.5);

  assert.equal(H.yogunluk(il, 5, 'siparis'), 1, 'siparis olcutu');
  assert.equal(H.yogunluk(il, 2, 'bayi'), 1, 'bayi olcutu');

  /* Hiçbir ölçüt 1'i geçemez. */
  assert.ok(H.yogunluk({ ciro: 9999 }, 10, 'ciro') <= 1);
});

test('uyari: yalnızca çözülmemiş not varsa', (t) => {
  const s = H.haritayiKur({
    iller: {
      'İzmir': { not: { cozulmemis: 1, toplam: 1 } },
      'Ankara': { not: { cozulmemis: 0, toplam: 3, cozuldu: 3 } },
      'Bursa': { bayiSayisi: 5 }
    }
  });

  assert.equal(s.iller.find((il) => 35 === il.plaka).uyari, true, 'cozulmemis var');
  assert.equal(s.iller.find((il) => 6 === il.plaka).uyari, false, 'hepsi cozulmus');
  assert.equal(s.iller.find((il) => 16 === il.plaka).uyari, false, 'hic not yok');
});

/* =========================================================================
 * 7. GERÇEK SINIR YOLLARI — tek kapı
 * ====================================================================== */

test('yol: varsayılan olarak BOŞ (şematik kutu çizilir)', (t) => {
  /*
   * Dosya basligindaki durust not: 81 ilin gercek sinir poligonu olculmus
   * cografi veridir, bellekten uretilemez. Kutuk konumu dogru tutar, sinir
   * sekli sematiktir.
   */
  assert.equal(H.yolluIlSayisi(), 0, 'baslangicta hic gercek yol yok');
  H.ILLER.forEach((il) => assert.equal(il.yol, '', il.ad));
});

test('yollariYukle: gerçek SVG yolları TEK KAPIDAN beslenir', (t) => {
  const sayi = H.yollariYukle({
    35: 'M180,230 L200,240 L190,260 Z',
    'Ankara': 'M440,175 L460,180 L450,200 Z',
    'izmir': 'M1,1 L2,2 Z',              // ayni ile ikinci yazim
    'Olmayanşehir': 'M0,0 Z',            // taninmaz
    6: ''                                 // bos yol yazilmaz
  });

  assert.equal(sayi, 3, 'uc gecerli atama (Izmir iki kez yazildi)');
  assert.ok(H.ilBul(35).yol.length > 0, 'Izmir yolu yazildi');
  assert.ok(H.ilBul('Ankara').yol.length > 0, 'Ankara yolu yazildi');
  assert.equal(H.yolluIlSayisi(), 2, 'iki ayri il yol aldi');

  /* Temizlik: diğer testleri etkilemesin. */
  H.ILLER.forEach((il) => { il.yol = ''; });
  assert.equal(H.yolluIlSayisi(), 0);
});

test('yollariYukle: bozuk girdi çökertmez', (t) => {
  [null, undefined, 'metin', 42].forEach((g) => {
    assert.equal(H.yollariYukle(g), 0, 'girdi: ' + String(g));
  });
});

/* =========================================================================
 * 8. ETİKETLER
 * ====================================================================== */

test('ETIKETLER: altı hızlı etiket ve okunabilir adları', (t) => {
  const anahtarlar = Object.keys(H.ETIKETLER);

  assert.equal(anahtarlar.length, 6);

  ['siparis-alindi', 'stok-dolu', 'fiyat-yuksek', 'yetkili-yoktu', 'ozel-talep', 'sikayet-hasar']
    .forEach((a) => assert.ok(H.ETIKETLER[a], 'etiket var: ' + a));

  assert.equal(H.etiketAdi('ozel-talep'), 'Özel Fiyat/Ürün Talebi');
  assert.equal(H.etiketAdi('bilinmeyen'), 'bilinmeyen', 'taninmayan anahtar oldugu gibi doner');
  assert.equal(H.etiketAdi(null), '');
});
