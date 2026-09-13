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

/* =========================================================================
 * 9. FAZ 10 — TR IL KODU NORMALIZASYONU + GERCEK IL SINIRLARI
 *    Saha denetimi Gorsel 2-3: WooCommerce billing_state "TR34" biciminde
 *    ISO kodu saklar; harita "TR34 eslenemedi" diyip Istanbul'u kaybediyordu.
 * ====================================================================== */

test('ilBul: TR il kodlari ("TR-35", "TR35", "tr 35", "035", "35") ve adlar AYNI ile cozulur', (t) => {
  ['TR-35', 'TR35', 'tr35', 'tr 35', 'TR_35', '035', '35', 35, 'İzmir', 'IZMIR', 'izmir', ' TR-35 '].forEach((y) => {
    const il = H.ilBul(y);
    assert.ok(il, 'cozuldu: ' + String(y));
    assert.equal(il.plaka, 35, 'yazim: ' + String(y));
  });

  assert.equal(H.ilBul('TR34').plaka, 34, 'Istanbul kodu');
  assert.equal(H.ilBul('TR-06').plaka, 6, 'basi sifirli kod');
  assert.equal(H.ilBul('TR-81').plaka, 81, 'son plaka');
  assert.equal(H.ilBul('TR1').plaka, 1, 'tek haneli kod');
});

test('ilBul: gecersiz kodlar null doner (82+, 0, harf karisimi)', (t) => {
  ['TR-82', 'TR99', '0', 'TR-00', 'TR-0', '100', 'TR-3A', 'TRX35', 'US-35'].forEach((y) => {
    assert.equal(H.ilBul(y), null, 'girdi: ' + y);
  });
});

test('notlariSuz: notun ili "TR35" kodu, suzgec "İzmir" adi — yine eslesir', (t) => {
  const liste = [
    { id: 1, il: 'TR35', durum: 'beklemede' },
    { id: 2, il: 'İzmir', durum: 'beklemede' },
    { id: 3, il: 'TR34', durum: 'beklemede' },
    { id: 4, il: 'Ankara', durum: 'beklemede' }
  ];

  assert.deepEqual(H.notlariSuz(liste, { il: 'İzmir' }).map((n) => n.id), [1, 2], 'kod ve ad ayni il');
  assert.deepEqual(H.notlariSuz(liste, { il: 'TR-35' }).map((n) => n.id), [1, 2], 'suzgec kodla da verilebilir');
  assert.deepEqual(H.notlariSuz(liste, { il: 'istanbul' }).map((n) => n.id), [3], 'TR34 = Istanbul');
  assert.deepEqual(H.notlariSuz(liste, { il: 'TR06' }).map((n) => n.id), [4]);
});

test('haritayiKur: "TR34" kodlu il yaniti Istanbul kutusuna oturur, "eslenemedi" olmaz', (t) => {
  const sonuc = H.haritayiKur({ iller: { 'TR34': { bayiSayisi: 3, siparis: 5, ciro: 1500 }, 'TR-35': { bayiSayisi: 1 } } });
  const ist = sonuc.iller.find((i) => i.plaka === 34);
  const izm = sonuc.iller.find((i) => i.plaka === 35);

  assert.equal(ist.bayiSayisi, 3, 'TR34 Istanbul olcumune yazildi');
  assert.equal(ist.ciro, 1500);
  assert.equal(izm.bayiSayisi, 1, 'TR-35 Izmir');
  assert.equal(sonuc.tanimsiz.length, 0, 'taninmayan il YOK ("TR34 eslenemedi" bitti)');
  assert.equal(sonuc.toplam.ciro, 1500, 'ciro il toplamina girdi');
});

test('yollariYukle: merkez ve sinir kutusu da beslenir (zoom gercek agirlik merkezine gider)', (t) => {
  delete require.cache[require.resolve('../src/renderer/harita-veri.js')];
  const T = require('../src/renderer/harita-veri.js');

  const eskiX = T.ilBul(35).x;
  const sayi = T.yollariYukle(
    { 35: 'M100 240L110 250L90 250Z' },
    { 35: { x: 100, y: 239.9 } },
    { 35: { x: 60, y: 200, w: 80, h: 70 } }
  );

  assert.equal(sayi, 1);
  assert.equal(T.ilBul(35).x, 100, 'merkez gercek agirlik merkezine tasindi');
  assert.equal(T.ilBul(35).y, 239.9);
  assert.deepEqual(T.ilBul(35).sinir, { x: 60, y: 200, w: 80, h: 70 }, 'sinir kutusu yazildi');
  assert.notEqual(eskiX, 100, 'sematik konum farkliydi (test anlamli)');

  /* Bozuk merkez/sinir yol yazimini engellemez, konumu da bozmaz. */
  const oncekiAnk = { x: T.ilBul(6).x, y: T.ilBul(6).y };
  T.yollariYukle({ 6: 'M1 1L2 2Z' }, { 6: { x: 'a', y: null } }, { 6: { w: NaN } });
  assert.ok(T.ilBul(6).yol, 'yol yazildi');
  assert.deepEqual({ x: T.ilBul(6).x, y: T.ilBul(6).y }, oncekiAnk, 'bozuk merkez konumu bozmadi');
  assert.equal(T.ilBul(6).sinir, undefined, 'bozuk sinir yazilmadi');

  delete require.cache[require.resolve('../src/renderer/harita-veri.js')];
});

test('harita-yollar.js: 81 ilin GERCEK sinir yolu (Natural Earth, kamu mali) eksiksiz ve tuval icinde', (t) => {
  const Y = require('../src/renderer/harita-yollar.js');

  assert.equal(Y.IL_SAYISI, 81);
  assert.match(Y.KAYNAK, /Natural Earth/);
  assert.deepEqual(Y.TUVAL, { w: 1000, h: 420 }, 'kokpit tuvaliyle ayni');

  const plakalar = Object.keys(Y.YOLLAR).map(Number).sort((a, b) => a - b);
  assert.deepEqual(plakalar, Array.from({ length: 81 }, (_, i) => i + 1), 'plaka 1-81 eksiksiz, tekrarsiz');

  plakalar.forEach((p) => {
    const d = Y.YOLLAR[p];
    assert.match(d, /^M[\d.\s\-]+(L[\d.\s\-]+)+Z/, 'SVG yol sozdizimi: ' + p);

    /* Her koordinat tuvalin icinde. */
    const sayilar = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map(Number);
    assert.ok(sayilar.length >= 6 && sayilar.length % 2 === 0, 'cift sayida koordinat: ' + p);
    for (let i = 0; i < sayilar.length; i += 2) {
      assert.ok(sayilar[i] >= 0 && sayilar[i] <= 1000, 'x tuval icinde: ' + p);
      assert.ok(sayilar[i + 1] >= 0 && sayilar[i + 1] <= 420, 'y tuval icinde: ' + p);
    }

    const m = Y.MERKEZLER[p];
    const s = Y.SINIRLAR[p];
    assert.ok(m && isFinite(m.x) && isFinite(m.y), 'merkez var: ' + p);
    assert.ok(s && s.w > 0 && s.h > 0, 'sinir kutusu var: ' + p);
    assert.ok(m.x >= s.x && m.x <= s.x + s.w && m.y >= s.y && m.y <= s.y + s.h, 'merkez kendi sinir kutusunun icinde: ' + p);
    assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= 1000 && s.y + s.h <= 420, 'sinir kutusu tuval icinde: ' + p);
  });
});

test('harita-yollar.js: Natural Earth il adlari kutukle CAPRAZ eslesir (plaka = ISO 3166-2)', (t) => {
  const Y = require('../src/renderer/harita-yollar.js');

  Object.keys(Y.ADLAR).forEach((p) => {
    const il = H.ilBul(Y.ADLAR[p]);
    assert.ok(il, 'NE adi kutukte cozulur: ' + Y.ADLAR[p]);
    assert.equal(il.plaka, Number(p), 'NE adi ile plaka ayni ile isaret eder: ' + Y.ADLAR[p]);
  });

  /* Cografi tutarlilik: gercek merkezler de yon iliskilerini korur. */
  assert.ok(Y.MERKEZLER[35].x < Y.MERKEZLER[65].x, 'Izmir Vanin batisinda');
  assert.ok(Y.MERKEZLER[57].y < Y.MERKEZLER[7].y, 'Sinop Antalyanin kuzeyinde');
  assert.ok(Y.MERKEZLER[22].x < Y.MERKEZLER[6].x && Y.MERKEZLER[6].x < Y.MERKEZLER[30].x, 'Edirne < Ankara < Hakkari');
});

test('harita-yollar.js: kutuge tam beslenir — 81 il <path> kipine gecer, tanima/zoom verisi tutarli', (t) => {
  delete require.cache[require.resolve('../src/renderer/harita-veri.js')];
  const T = require('../src/renderer/harita-veri.js');
  const Y = require('../src/renderer/harita-yollar.js');

  assert.equal(T.yolluIlSayisi(), 0, 'beslenmeden once sematik');
  assert.equal(T.yollariYukle(Y.YOLLAR, Y.MERKEZLER, Y.SINIRLAR), 81, '81 ile yol yazildi');
  assert.equal(T.yolluIlSayisi(), 81);

  T.ILLER.forEach((il) => {
    assert.ok(il.yol && il.sinir, 'yol + sinir: ' + il.ad);
    assert.equal(il.x, Y.MERKEZLER[il.plaka].x, 'merkez NE agirlik merkezi: ' + il.ad);
  });

  /* Izmir'e tiklaninca kokpit bu sinir kutusuyla yaklasir. */
  const izmir = T.ilBul('TR-35');
  assert.ok(izmir.sinir.w > 20 && izmir.sinir.h > 20, 'Izmir sinir kutusu anlamli buyuklukte');

  delete require.cache[require.resolve('../src/renderer/harita-veri.js')];
});

/* =========================================================================
 * 10. FAZ 11 — BELIRLI GUN (tarih) SUZGECI: harita ust barindaki <input type="date">
 * ====================================================================== */

function yerelGun(kaydir) {
  const t = new Date();
  t.setDate(t.getDate() + (kaydir || 0));
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

test('notlariSuz: tarih (YYYY-MM-DD) YALNIZCA o yerel gunun notlarini birakir; gun penceresi yok sayilir', (t) => {
  const bugun = new Date();
  const dun = new Date(Date.now() - 86400000);
  const liste = [
    { id: 1, zaman: bugun.toISOString(), durum: 'beklemede' },
    { id: 2, zaman: dun.toISOString(), durum: 'beklemede' },
    { id: 3, zaman: new Date(Date.now() - 40 * 86400000).toISOString(), durum: 'beklemede' }
  ];

  assert.deepEqual(H.notlariSuz(liste, { tarih: yerelGun(0) }).map((n) => n.id), [1], 'bugun');
  assert.deepEqual(H.notlariSuz(liste, { tarih: yerelGun(-1) }).map((n) => n.id), [2], 'dun');
  assert.deepEqual(H.notlariSuz(liste, { tarih: yerelGun(-1), gun: 1 }).map((n) => n.id), [2], 'tarih varken gun=1 YOK SAYILIR (ikisi ust uste bos verirdi)');
  assert.deepEqual(H.notlariSuz(liste, { tarih: yerelGun(-3) }), [], 'notsuz gun bos');
  assert.equal(H.notlariSuz(liste, { tarih: 'bozuk' }).length, 3, 'bozuk tarih suzgec uygulamaz');
  assert.equal(H.notlariSuz(liste, { tarih: '', gun: 7 }).length, 2, 'bos tarih → gun penceresi calisir');
});

test('notlariSuz: tarih suzgecinde de ZAMANI OKUNAMAYAN not SUZULMEZ (sikayet kaybolmaz)', (t) => {
  const liste = [
    { id: 1, zaman: 'bozuk-tarih', durum: 'beklemede' },
    { id: 2, zaman: '', durum: 'beklemede' },
    { id: 3, zaman: new Date(Date.now() - 40 * 86400000).toISOString(), durum: 'beklemede' }
  ];

  assert.deepEqual(H.notlariSuz(liste, { tarih: yerelGun(0) }).map((n) => n.id), [1, 2], 'okunamayan tarihler kalir, eski not duser');
});

test('notlariSuz: tarih + il + durum birlikte kesisir', (t) => {
  const liste = [
    { id: 1, zaman: new Date().toISOString(), il: 'TR35', durum: 'beklemede' },
    { id: 2, zaman: new Date().toISOString(), il: 'İzmir', durum: 'cozuldu' },
    { id: 3, zaman: new Date().toISOString(), il: 'Ankara', durum: 'beklemede' }
  ];

  assert.deepEqual(H.notlariSuz(liste, { tarih: yerelGun(0), il: 'izmir', durum: 'beklemede' }).map((n) => n.id), [1]);
});
