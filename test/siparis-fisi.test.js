'use strict';
/* ============================================================================
 *  SİPARİŞ FİŞİ TESTİ — src/renderer/siparis-fisi.js
 *  ---------------------------------------------------------------------------
 *  Kapsam:
 *   1. normalle — üç kaynak: (a) yönetici normal, (b) saha normal, (c) ham
 *      sunucu yükü; alan eşlemesi, koli matematiği, kuruş yuvarlaması,
 *      eksik alan → 0 / '' (asla NaN / undefined), anahtar kümesi, saflık
 *   2. html — kaçış, iki kâğıt kipi (A4 / 80 mm), toplam satırları, logo
 *      şeması, harici kaynak yokluğu
 *   3. whatsappMetni — kalın başlıklar, koli satırı, 20 kalem tavanı,
 *      1800 karakter sınırı
 *   4. waTelefon / waAdresi — Faz 11 vektörleri, encodeURIComponent
 *   5. paraYaz — tr-TR biçimi, Intl'siz determinist
 *
 *  DOM GEREKMEZ: modül saf metin üretir, doğrudan require edilir.
 * ==========================================================================*/

const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../src/renderer/siparis-fisi.js');

/* ------------------------------------------------------------------ *
 *  Yardımcılar ve örnek kaynaklar
 * ------------------------------------------------------------------ */

const FIS_ANAHTARLARI = [
  'numara', 'tarih', 'tarihYazi', 'durumEtiketi', 'firma', 'plasiyer', 'musteri',
  'kalemler', 'cesit', 'toplamAdet', 'toplamKoli', 'araToplam',
  'bayiIskontoOrani', 'bayiIskontoTutar', 'odemeIskontoOrani', 'odemeIskontoTutar',
  /* Faz 12-KDV: KDV BELGEDE dökülür. Üç kaynağın (yönetici / saha / ham) da
     aynı anahtarları döndürmesi kilitli — biri eksik kalırsa o ekranda fişte
     KDV satırı sessizce kaybolurdu. */
  'kdvToplam', 'kdvIstenmedi', 'kdvDusulen',
  'net', 'odeme', 'not'
].sort();

/* Faz 14: `listeBirim` — "Birim Fiyat" sütunu; iskontolu birim `birim`. */
const KALEM_ANAHTARLARI = ['ad', 'sku', 'adet', 'koli', 'koliIci', 'listeBirim', 'birim', 'tutar', 'kdvOrani', 'kdvTutar'].sort();

const TARIH = '2026-09-14T10:30:00+03:00';

/** Yerel saate göre beklenen "dd.mm.yyyy hh:mm" — test hangi saat diliminde koşarsa koşsun. */
function beklenenTarihYazisi(iso) {
  const t = new Date(iso);
  const iki = (n) => (n < 10 ? '0' : '') + n;
  return iki(t.getDate()) + '.' + iki(t.getMonth() + 1) + '.' + t.getFullYear() + ' ' + iki(t.getHours()) + ':' + iki(t.getMinutes());
}

/** Nesnede NaN / undefined / null var mı? (derin) */
function bozukDeger(x, yol) {
  yol = yol || '$';
  if (x === undefined || x === null) return yol;
  if ('number' === typeof x && !Number.isFinite(x)) return yol;
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) { const b = bozukDeger(x[i], yol + '[' + i + ']'); if (b) return b; }
    return '';
  }
  if ('object' === typeof x) {
    for (const k of Object.keys(x)) { const b = bozukDeger(x[k], yol + '.' + k); if (b) return b; }
  }
  return '';
}

/** (a) Yönetici listesi — b2bSiparisNormalle çıktısı. */
function yoneticiKaynak() {
  return {
    id: 6448, numara: '6448', musteri: 'Ali Veli', firma: 'Acme Hırdavat', telefon: '0532 415 22 78',
    vergiNo: '1234567890', tutar: 1839.96, durum: 'processing', durumEtiketi: 'İşleniyor', tarih: TARIH,
    plasiyerId: 7, plasiyerAd: 'Ahmet', odeme: 'Nakit', notlar: 'Kapıya bırakın',
    bayiIskontoOrani: 10, odemeIskonto: 5,
    kalemler: [
      { ad: 'Silikon 280 ml', kod: 'SLK-280', adet: 48, koliIci: 24, tutar: 2052 },
      { ad: 'Çivi', kod: '-', adet: 40, tutar: 100 }
    ]
  };
}

/** (b) Saha listesi — plasiyer-siparislerim.js → normalle çıktısı. */
function sahaKaynak() {
  return {
    id: 91, numara: '91', tarih: TARIH, durum: 'processing', durumEtiketi: 'İşleniyor', tutar: 0,
    musteri: 'Yıldız Nalburiye', odeme: 'vade', iskonto: 10,
    kalemler: [
      { urunId: 5, ad: 'Silikon 280 ml', adet: 48, koliIci: 24, koli: 2, birim: 42.75, tutar: 2052 },
      { urunId: 9, ad: 'Çivi', adet: 40, koliIci: 0, koli: 0, birim: 2.5, tutar: 100 }
    ],
    notlar: ''
  };
}

/** (c) Ham prepare_order yükü — plasiyer siparişi (iskontolar ücret satırında). */
function hamKaynak() {
  return {
    id: 6448, number: '6448', date_created: TARIH, status: 'processing', status_label: 'İşleniyor',
    total: 1839.96, subtotal: 2152,
    dealer: { company_name: 'Acme Hırdavat', contact_name: 'Ali Veli', phone: '+90 532 415 22 78', tax_number: '1234567890', city: '' },
    billing: { first_name: 'Ali', last_name: 'Veli', phone: '', city: 'İzmir' },
    items: [
      { name: 'Silikon 280 ml', sku: 'SLK-280', quantity: 48, unit_price: 42.75, total: 2052, box_quantity: 24, boxes: 2 },
      { name: 'Çivi', sku: 'CV-1', quantity: 40, unit_price: 2.5, total: 100, box_quantity: 1, boxes: 0 }
    ],
    fee_lines: [
      { name: 'Plasiyer İskontosu (%10)', total: '-215.2' },
      { name: 'Ödeme Yöntemi İskontosu — Nakit (%5)', total: '-96.84' }
    ],
    plasiyer_id: 7, plasiyer_ad: 'Ahmet', plasiyer_iskonto: 10,
    payment_method_title: 'Nakit', customer_note: 'Kapıya bırakın'
  };
}

const BAGLAM = { firmaAdi: 'BYOM Hırdavat', logo: 'data:image/png;base64,AAAA', plasiyerAd: 'Ayşe', plasiyerId: 3, kagit: 'a4', paraBirimi: 'TL' };

/* ------------------------------------------------------------------ *
 *  1. normalle
 * ------------------------------------------------------------------ */

test('normalle (a) yönetici: firma → ünvan, müşteri → yetkili, kod → sku, siparişin plasiyeri bağlamı ezer', () => {
  const f = F.normalle(yoneticiKaynak(), BAGLAM);

  assert.equal(f.numara, '6448');
  assert.equal(f.tarih, new Date(TARIH).toISOString());
  assert.equal(f.tarihYazi, beklenenTarihYazisi(TARIH));
  assert.equal(f.durumEtiketi, 'İşleniyor');
  assert.deepEqual(f.firma, { ad: 'BYOM Hırdavat', logo: 'data:image/png;base64,AAAA' });
  assert.deepEqual(f.plasiyer, { id: 7, ad: 'Ahmet' }, 'siparişin damgası bağlamdaki (3/Ayşe) yerine geçmez');
  assert.deepEqual(f.musteri, { unvan: 'Acme Hırdavat', yetkili: 'Ali Veli', telefon: '0532 415 22 78', il: '', vergiNo: '1234567890' });
  assert.equal(f.kalemler[0].sku, 'SLK-280');
  assert.equal(f.kalemler[1].sku, '', "'-' boş SKU'dur");
  assert.equal(f.odeme, 'Nakit');
  assert.equal(f.not, 'Kapıya bırakın');
  assert.equal(f.cesit, 2);
  assert.equal(f.toplamAdet, 88);
  assert.equal(f.toplamKoli, 2);
});

test('normalle (a) yönetici: ara toplam Σ kalem, iskontolar orandan bileşik, net sunucunun tutarı', () => {
  const f = F.normalle(yoneticiKaynak(), BAGLAM);

  assert.equal(f.araToplam, 2152);
  assert.equal(f.bayiIskontoOrani, 10);
  assert.equal(f.bayiIskontoTutar, 215.2);
  assert.equal(f.odemeIskontoOrani, 5);
  assert.equal(f.odemeIskontoTutar, 96.84, 'ödeme iskontosu bayi SONRASI tutara (1936,80 × %5)');
  assert.equal(f.net, 1839.96);
});

test('normalle (b) saha: müşteri ünvandır, iskonto → bayi oranı, ödeme anahtarı etikete döner, plasiyer bağlamdan', () => {
  const f = F.normalle(sahaKaynak(), BAGLAM);

  assert.deepEqual(f.musteri, { unvan: 'Yıldız Nalburiye', yetkili: '', telefon: '', il: '', vergiNo: '' });
  assert.equal(f.bayiIskontoOrani, 10);
  assert.equal(f.odeme, 'Vade');
  assert.deepEqual(f.plasiyer, { id: 3, ad: 'Ayşe' }, 'sipariş kimlik taşımıyorsa bağlamdaki plasiyer yazılır');
  assert.deepEqual(f.kalemler[0], { ad: 'Silikon 280 ml', sku: '', adet: 48, koli: 2, koliIci: 24, listeBirim: 42.75, birim: 42.75, tutar: 2052, kdvOrani: 0, kdvTutar: 0 });
  assert.deepEqual(f.kalemler[1], { ad: 'Çivi', sku: '', adet: 40, koli: 0, koliIci: 0, listeBirim: 2.5, birim: 2.5, tutar: 100, kdvOrani: 0, kdvTutar: 0 });
  /* tutar 0 verildi → net hesaplanır: 2152 − 215,20 = 1936,80 (ödeme iskontosu yok) */
  assert.equal(f.araToplam, 2152);
  assert.equal(f.bayiIskontoTutar, 215.2);
  assert.equal(f.odemeIskontoTutar, 0);
  assert.equal(f.net, 1936.8);
});

test('normalle (c) ham: number/date_created/dealer/billing/items/fee_lines eşlenir', () => {
  const f = F.normalle(hamKaynak(), BAGLAM);

  assert.equal(f.numara, '6448');
  assert.equal(f.tarih, new Date(TARIH).toISOString());
  assert.equal(f.tarihYazi, beklenenTarihYazisi(TARIH));
  assert.equal(f.durumEtiketi, 'İşleniyor');
  assert.deepEqual(f.musteri, { unvan: 'Acme Hırdavat', yetkili: 'Ali Veli', telefon: '+90 532 415 22 78', il: 'İzmir', vergiNo: '1234567890' });
  assert.deepEqual(f.plasiyer, { id: 7, ad: 'Ahmet' });
  assert.deepEqual(f.kalemler[0], { ad: 'Silikon 280 ml', sku: 'SLK-280', adet: 48, koli: 2, koliIci: 24, listeBirim: 42.75, birim: 42.75, tutar: 2052, kdvOrani: 0, kdvTutar: 0 });
  assert.deepEqual(f.kalemler[1], { ad: 'Çivi', sku: 'CV-1', adet: 40, koli: 0, koliIci: 1, listeBirim: 2.5, birim: 2.5, tutar: 100, kdvOrani: 0, kdvTutar: 0 });
  assert.equal(f.araToplam, 2152);
  assert.equal(f.bayiIskontoOrani, 10);
  assert.equal(f.bayiIskontoTutar, 215.2, 'ücret satırından');
  assert.equal(f.odemeIskontoOrani, 5, 'ücret satırı adındaki parantezden');
  assert.equal(f.odemeIskontoTutar, 96.84, 'ücret satırından');
  assert.equal(f.net, 1839.96);
  assert.equal(f.odeme, 'Nakit');
  assert.equal(f.not, 'Kapıya bırakın');
});

test('normalle (c) ham web siparişi: satır fiyatı iskontoluysa liste tutarı ara toplam, fark bayi iskontosu', () => {
  const f = F.normalle({
    id: 12, number: '12', date_created: TARIH, status: 'completed', total: 180,
    billing: { company: 'Web Bayi', first_name: 'Can', last_name: 'Kaya' },
    items: [
      { name: 'A', quantity: 2, total: 90, list_subtotal: 100 },
      { name: 'B', quantity: 1, total: 90, list_subtotal: 100 }
    ]
  }, {});

  assert.equal(f.araToplam, 200);
  assert.equal(f.bayiIskontoTutar, 20);
  assert.equal(f.bayiIskontoOrani, 10, 'oran tutardan geri okunur (gösterim)');
  assert.equal(f.net, 180);
  assert.equal(f.musteri.unvan, 'Web Bayi');
  assert.equal(f.musteri.yetkili, 'Can Kaya');
});

test('normalle koli matematiği: koli adetten, koli içi koliden türetilir; tekil üründe koli 0', () => {
  const f = F.normalle({ numara: '1', kalemler: [
    { ad: 'A', adet: 72, koliIci: 24, tutar: 10 },          // koli yok → 3
    { ad: 'B', adet: 48, koli: 2, tutar: 10 },              // koli içi yok → 24
    { ad: 'C', adet: 47, koli: 2, tutar: 10 },              // tam bölünmez → koli içi 0, koli kalır
    { ad: 'D', adet: 5, koliIci: 1, koli: 5, tutar: 10 },   // tekil → koli 0
    { ad: 'E', adet: 3, tutar: 10 }
  ] }, {});

  assert.equal(f.kalemler[0].koli, 3);
  assert.equal(f.kalemler[1].koliIci, 24);
  assert.deepEqual([f.kalemler[2].koli, f.kalemler[2].koliIci], [2, 0]);
  assert.deepEqual([f.kalemler[3].koli, f.kalemler[3].koliIci], [0, 1]);
  assert.deepEqual([f.kalemler[4].koli, f.kalemler[4].koliIci], [0, 0]);
  assert.equal(f.toplamKoli, 7);
  assert.equal(f.toplamAdet, 175);
  assert.equal(f.cesit, 5);
});

test('normalle para yuvarlaması: kayan nokta artığı kuruşta kapanır, tutar/birim birbirinden türer', () => {
  const f = F.normalle({ numara: '2', bayiIskontoOrani: 12.5, odemeIskonto: 3,
    kalemler: [
      { ad: 'A', adet: 3, birim: 33.33 },     // tutar yok → 99,99
      { ad: 'B', adet: 3, tutar: 0.3 },       // birim → 0,10
      { ad: 'C', adet: 1, tutar: 0.1 },
      { ad: 'D', adet: 1, tutar: 0.2 }
    ] }, {});

  const kurusMu = (x) => Math.round(x * 100) / 100 === x;

  assert.equal(f.kalemler[0].tutar, 99.99);
  assert.equal(f.kalemler[1].birim, 0.1);
  assert.equal(f.araToplam, 100.59);
  assert.equal(f.bayiIskontoTutar, 12.57);
  assert.equal(f.odemeIskontoTutar, 2.64, '(100,59 − 12,57) × %3 = 2,6406');
  assert.equal(f.net, 85.38);

  ['araToplam', 'bayiIskontoTutar', 'odemeIskontoTutar', 'net'].forEach((k) => assert.ok(kurusMu(f[k]), k + ' kuruşa yuvarlı değil: ' + f[k]));
  f.kalemler.forEach((k) => { assert.ok(kurusMu(k.tutar)); assert.ok(kurusMu(k.birim)); });
});

test('normalle eksik alanlar: {} / null / metin / bozuk kalem → 0 ve \'\'; asla NaN / undefined', () => {
  [F.normalle({}, {}), F.normalle(null), F.normalle('x', null), F.normalle({ kalemler: [null, 7, 'a', {}] }, { logo: 'javascript:alert(1)' })]
    .forEach((f) => {
      assert.equal(bozukDeger(f), '', 'bozuk değer: ' + bozukDeger(f));
      assert.deepEqual(Object.keys(f).sort(), FIS_ANAHTARLARI);
      assert.equal(f.tarih, '');
      assert.equal(f.tarihYazi, '');
      assert.equal(f.net, 0);
      assert.equal(f.firma.logo, '', 'javascript: şeması logo olamaz');
      f.kalemler.forEach((k) => assert.deepEqual(Object.keys(k).sort(), KALEM_ANAHTARLARI));
    });

  const bozukTarih = F.normalle({ numara: '3', tarih: 'dün', kalemler: [] }, {});
  assert.equal(bozukTarih.tarih, '');
  assert.equal(bozukTarih.tarihYazi, '');
  assert.equal(bozukTarih.numara, '3');
});

test('normalle girdiyi değiştirmez (saf) ve fiş anahtar kümesi üç kaynakta aynıdır', () => {
  [yoneticiKaynak(), sahaKaynak(), hamKaynak()].forEach((k) => {
    const once = JSON.stringify(k);
    const f = F.normalle(k, BAGLAM);
    assert.equal(JSON.stringify(k), once, 'kaynak nesne değişti');
    assert.deepEqual(Object.keys(f).sort(), FIS_ANAHTARLARI);
    f.kalemler.forEach((x) => assert.deepEqual(Object.keys(x).sort(), KALEM_ANAHTARLARI));
    assert.equal(bozukDeger(f), '');
  });
});

/* ------------------------------------------------------------------ *
 *  2. html
 * ------------------------------------------------------------------ */

test('html kullanıcı metnini kaçışlar: ünvandaki <b> ve & fişe etiket olarak girmez', () => {
  const k = yoneticiKaynak();
  k.firma = 'Acme <b>&</b> "Co"';
  k.notlar = "<script>alert('x')</script>";
  k.kalemler[0].ad = 'Silikon <i>280</i>';

  const h = F.html(F.normalle(k, BAGLAM));

  assert.ok(h.includes('Acme &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;'));
  assert.ok(!h.includes('<b>&</b>'));
  assert.ok(h.includes('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;'));
  assert.ok(!/<script/i.test(h), 'betik etiketi yok');
  assert.ok(h.includes('Silikon &lt;i&gt;280&lt;/i&gt;'));
});

test('html iki kâğıt kipi: A4 (@page A4, 12mm, iki sütun künye) ve termal (80mm, tek sütun, monospace rakam)', () => {
  const f = F.normalle(yoneticiKaynak(), BAGLAM);
  const a4 = F.html(f, { kagit: 'a4' });
  const termal = F.html(f, { kagit: 'termal' });
  const varsayilan = F.html(f);

  assert.notEqual(a4, termal);
  assert.equal(varsayilan, a4, 'kâğıt verilmezse A4');

  assert.ok(a4.includes('@page { size: A4; margin: 12mm; }'));
  assert.ok(a4.includes('grid-template-columns:1fr 1fr'));
  assert.ok(!a4.includes('80mm'));

  assert.ok(termal.includes('@page { size: 80mm auto'));
  assert.ok(termal.includes('.kunye { display:block'));
  assert.ok(termal.includes('monospace'));
  assert.ok(termal.includes('.logo { max-width:60mm'));
  assert.ok(!termal.includes('size: A4'));

  [a4, termal].forEach((h) => {
    assert.ok(h.startsWith('<!DOCTYPE html>'));
    assert.ok(h.includes('<html lang="tr">'));
    assert.ok(h.includes('font-variant-numeric: tabular-nums'));
    assert.ok(h.includes('@media print'));
    assert.ok(h.includes('SİPARİŞ FİŞİ'));
    assert.ok(h.includes('#6448'));
  });
});

test('html toplam bloğu, künye, kalem tablosu ve alt yazı basılır', () => {
  const h = F.html(F.normalle(yoneticiKaynak(), BAGLAM));

  assert.ok(h.includes('Liste Fiyatı Ara Toplamı</td><td class="deger sayi">2.152,00 TL'));
  assert.ok(h.includes('Bayi İskonto Tutarı (%10)</td><td class="deger sayi">&minus;215,20 TL'));
  assert.ok(h.includes('Nakit Sipariş İskontosu (%5)</td><td class="deger sayi">&minus;96,84 TL'));
  assert.ok(h.includes('<tr class="net"><td class="etiket">NET ÖDENECEK TUTAR</td><td class="deger sayi">1.839,96 TL'));
  assert.ok(h.includes('BYOM B2B · Bu fiş bilgi amaçlıdır, fatura yerine geçmez.'));

  /* künye */
  assert.ok(h.includes('<dt>Ünvan</dt><dd>Acme Hırdavat</dd>'));
  assert.ok(h.includes('<dt>Yetkili</dt><dd>Ali Veli</dd>'));
  assert.ok(h.includes('<dt>Telefon</dt><dd>0532 415 22 78</dd>'));
  assert.ok(h.includes('<dt>Vergi No</dt><dd>1234567890</dd>'));
  assert.ok(!h.includes('<dt>İl</dt>'), 'boş il satırı basılmaz');
  assert.ok(h.includes('<dt>Plasiyer</dt><dd>Ahmet</dd>'));
  assert.ok(h.includes('<dt>Ödeme</dt><dd>Nakit</dd>'));
  assert.ok(h.includes('2 çeşit · 88 adet · 2 koli'));

  /* kalem tablosu: SABİT sekiz sütun (Faz 14) — KDV künyesi yoksa "—" */
  assert.ok(h.includes('<th>Ürün Adı</th><th>Kod / Barkod</th><th class="sayi">Koli / Adet</th><th class="sayi">Birim Fiyat</th><th class="sayi">İskontolu Birim Fiyat</th><th class="sayi">KDV Oranı</th><th class="sayi">KDV Tutarı</th><th class="sayi">Satır Tutarı</th>'), 'sekiz sütun SABİT — KDV künyesi olmasa da');
  assert.ok(!h.includes('<th>SKU</th>'), 'başlık müşterinin okuduğu dile çevrildi');
  assert.ok(h.includes('<td class="s-adet sayi">2 koli × 24 = 48</td><td class="s-liste sayi">42,75 TL</td><td class="s-birim sayi">—</td><td class="s-kdv sayi">—</td><td class="s-kdvtutar sayi">—</td><td class="s-tutar sayi">2.052,00 TL</td>'), 'iskonto ve KDV bilinmiyorsa hücre "—"');
  assert.ok(h.includes('İskontolu Ara Toplam</td><td class="deger sayi">1.936,80 TL'), 'köprü satırı HER fişte: liste − bayi');
  assert.ok(h.includes('<td class="s-ad">Çivi</td><td class="s-sku">—</td><td class="s-adet sayi">40</td>'));

  /* not kutusu */
  assert.ok(h.includes('<section class="not"><h3>Sipariş Notu</h3>Kapıya bırakın</section>'));
  assert.ok(h.includes('<title>Sipariş Fişi #6448</title>'));
});

test('html özet satırları SABİT — iskonto yoksa "—" basılır; logo yalnızca güvenli şemayla; harici kaynak yok', () => {
  /* Faz 14 (ürün sahibi): "iskonto olmazsa (-) şeklinde yok olarak gözükecek
     ama standart olarak bu bilgiler hep olacak." Satır kaybolmaz, değeri
     tire olur; müşteri her fişte aynı altı satırı görür. */
  const sade = F.normalle({ numara: '5', tutar: 100, kalemler: [{ ad: 'A', adet: 1, tutar: 100 }] }, { firmaAdi: 'X' });
  const h1 = F.html(sade);

  assert.ok(h1.includes('<tr class="bayi bos"><td class="etiket">Bayi İskonto Tutarı</td><td class="deger sayi">—</td></tr>'));
  assert.ok(h1.includes('<tr class="ara"><td class="etiket">İskontolu Ara Toplam</td><td class="deger sayi">100,00 TL</td></tr>'));
  assert.ok(h1.includes('<tr class="odeme bos"><td class="etiket">Ödeme Yöntemi Sipariş İskontosu</td><td class="deger sayi">—</td></tr>'));
  assert.ok(h1.includes('<tr class="kdv bos"><td class="etiket">KDV</td><td class="deger sayi">—</td></tr>'));
  assert.ok(h1.includes('NET ÖDENECEK TUTAR'));
  assert.ok(!h1.includes('&minus;'), 'iskonto yokken eksi işaretli tutar yok');
  assert.ok(!h1.includes('<img'), 'logo yoksa img yok');
  assert.ok(!h1.includes('class="not"'), 'not yoksa kutu yok');
  assert.ok(!/<link|<script|https?:\/\//i.test(h1), 'harici CSS/JS/CDN yok — html() SAF');

  const logolu = F.html(F.normalle(sade, { logo: 'data:image/png;base64,AAAA' }));
  assert.ok(logolu.includes('<img class="logo" src="data:image/png;base64,AAAA" alt="">'));

  /* elle kurulmuş fişte kötü şema yine süzülür */
  const kotu = Object.assign({}, sade, { firma: { ad: 'X', logo: 'javascript:alert(1)' } });
  assert.ok(!F.html(kotu).includes('<img'));

  /* kalemsiz fiş boş satırla açılır, patlamaz */
  assert.ok(F.html(F.normalle({}, {})).includes('Kalem yok'));
});
/* ------------------------------------------------------------------ *
 *  3. whatsappMetni
 * ------------------------------------------------------------------ */

test('whatsappMetni: kalın başlıklar, koli satırı, tekil satır, toplamlar, italik plasiyer, not', () => {
  const m = F.whatsappMetni(F.normalle(yoneticiKaynak(), BAGLAM));
  const satirlar = m.split('\n');

  assert.equal(satirlar[0], '*SİPARİŞ FİŞİ #6448*');
  assert.ok(satirlar.includes('*Firma:* BYOM Hırdavat'));
  assert.ok(satirlar.includes('*Bayi:* Acme Hırdavat (Ali Veli)'));
  assert.ok(satirlar.includes('*Tarih:* ' + beklenenTarihYazisi(TARIH)));
  assert.ok(satirlar.includes('*Ödeme:* Nakit'));
  assert.ok(satirlar.includes('• Silikon 280 ml — 2 koli × 24 = 48 adet — 2.052,00 TL'));
  assert.ok(satirlar.includes('• Çivi — 40 adet — 100,00 TL'));
  assert.ok(satirlar.includes('*Liste Fiyatı Ara Toplamı:* 2.152,00 TL'));
  assert.ok(satirlar.includes('*Bayi İskonto Tutarı (%10):* −215,20 TL'));
  assert.ok(satirlar.includes('*Nakit Sipariş İskontosu (%5):* −96,84 TL'));
  assert.ok(satirlar.includes('*NET ÖDENECEK TUTAR: 1.839,96 TL*'));
  assert.ok(satirlar.includes('_Plasiyer: Ahmet_'));
  assert.ok(satirlar.includes('*Not:* Kapıya bırakın'));
  assert.ok(m.indexOf('*Liste Fiyatı Ara Toplamı:*') > m.indexOf('• Çivi'), 'toplamlar kalemlerden sonra');
  assert.ok(!m.includes('&lt;'), 'WhatsApp metni HTML kaçışlı DEĞİL');
});

test('whatsappMetni: 20 kalem tavanı ve "… ve N kalem daha"', () => {
  const kalemler = [];
  for (let i = 1; i <= 25; i++) kalemler.push({ ad: 'Ürün ' + i, adet: i, tutar: i });

  const m = F.whatsappMetni(F.normalle({ numara: '7', kalemler }, {}));

  assert.equal((m.match(/^• /gm) || []).length, 20);
  assert.ok(m.includes('… ve 5 kalem daha'));
  assert.ok(m.includes('• Ürün 20 —'));
  assert.ok(!m.includes('• Ürün 21 —'));
});

test('whatsappMetni: 1800 karakter sınırı — kalem düşer, başlık ve NET satırı korunur', () => {
  const kalemler = [];
  for (let i = 1; i <= 200; i++) kalemler.push({ ad: 'Çok uzun ürün adı numara ' + i + ' — Endüstriyel silikon yapıştırıcı 280 ml şeffaf', adet: 48, koliIci: 24, tutar: 2052 });

  const f = F.normalle({ numara: '8', tutar: 999, kalemler, notlar: 'x'.repeat(500) }, { firmaAdi: 'BYOM', plasiyerAd: 'Ahmet' });
  const m = F.whatsappMetni(f);

  assert.ok(m.length <= F.WA_EN_COK_KARAKTER, 'uzunluk ' + m.length);
  assert.ok(m.startsWith('*SİPARİŞ FİŞİ #8*'));
  assert.ok(m.includes('*NET ÖDENECEK TUTAR: 999,00 TL*'));
  assert.ok(m.includes('kalem daha'));
  assert.ok((m.match(/^• /gm) || []).length < 20, 'kalem sayısı sınır için düşürüldü');

  /* kalemsiz ama dev notlu: not kırpılır, NET kalır */
  const devNot = F.whatsappMetni(F.normalle({ numara: '9', tutar: 1, notlar: 'n'.repeat(5000) }, {}));
  assert.ok(devNot.length <= F.WA_EN_COK_KARAKTER);
  assert.ok(devNot.includes('*NET ÖDENECEK TUTAR: 1,00 TL*'));
  assert.ok(devNot.includes('*Not:* nnn'));
  assert.ok(devNot.endsWith('…'));
});

/* ------------------------------------------------------------------ *
 *  4. waTelefon / waAdresi
 * ------------------------------------------------------------------ */

test('waTelefon vektörleri (Faz 11 ile aynı kural)', () => {
  assert.equal(F.waTelefon('0532 415 22 78'), '905324152278');
  assert.equal(F.waTelefon('5324152278'), '905324152278', '10 hane → 90 öneki');
  assert.equal(F.waTelefon('+90 532 415 22 78'), '905324152278');
  assert.equal(F.waTelefon('00905324152278'), '905324152278', '00 öneki atılır');
  assert.equal(F.waTelefon('(0532) 415-22-78'), '905324152278');
  assert.equal(F.waTelefon('12345'), '', '11 haneden az');
  assert.equal(F.waTelefon('1234567890123456'), '', '15 haneden çok');
  assert.equal(F.waTelefon(''), '');
  assert.equal(F.waTelefon(null), '');
  assert.equal(F.waTelefon(undefined), '');
  assert.equal(F.waTelefon(5324152278), '905324152278', 'sayı da kabul');
});

test('waAdresi: wa.me + encodeURIComponent (& → %26), telefon yoksa boş', () => {
  const k = yoneticiKaynak();
  k.firma = 'A & B Hırdavat';

  const f = F.normalle(k, BAGLAM);
  const a = F.waAdresi(f);

  assert.ok(a.startsWith('https://wa.me/905324152278?text='));
  assert.ok(a.includes('%26'), '& kodlanır');
  assert.ok(!a.includes(' '), 'boşluk kalmaz');
  assert.ok(!/[&]/.test(a.slice(a.indexOf('?text=') + 6)), 'metin içinde çıplak & yok');
  assert.equal(decodeURIComponent(a.slice(a.indexOf('?text=') + 6)), F.whatsappMetni(f));

  const telefonsuz = F.normalle(sahaKaynak(), BAGLAM);
  assert.equal(F.waAdresi(telefonsuz), '');

  /* kaynak nesne doğrudan verilirse de çalışır */
  assert.ok(F.waAdresi(hamKaynak()).startsWith('https://wa.me/905324152278?text='));
});

/* ------------------------------------------------------------------ *
 *  5. paraYaz
 * ------------------------------------------------------------------ */

test('paraYaz vektörleri: tr-TR gruplama, iki ondalık, işaret, bozuk girdi', () => {
  assert.equal(F.paraYaz(0), '0,00 TL');
  assert.equal(F.paraYaz(1234.5), '1.234,50 TL');
  assert.equal(F.paraYaz(2052), '2.052,00 TL');
  assert.equal(F.paraYaz(-60), '-60,00 TL');
  assert.equal(F.paraYaz(1234567.891), '1.234.567,89 TL');
  assert.equal(F.paraYaz(999.999), '1.000,00 TL');
  assert.equal(F.paraYaz(-0.004), '0,00 TL', 'kuruşta sıfıra inen eksi işaret almaz');
  assert.equal(F.paraYaz(NaN), '0,00 TL');
  assert.equal(F.paraYaz('abc'), '0,00 TL');
  assert.equal(F.paraYaz('1500'), '1.500,00 TL');
  assert.equal(F.paraYaz(10, '₺'), '10,00 ₺', 'birim seçilebilir');
  assert.equal(F.paraYaz(10, ''), '10,00', 'boş birim ek bırakmaz');
});

/* ------------------------------------------------------------------ *
 *  6. Dışa verme sözleşmesi
 * ------------------------------------------------------------------ */

test('dışa verme: işlevler + kacis + sabitler; window yokken module.exports; motor DOM/ağ kullanmaz', () => {
  ['normalle', 'html', 'pencere', 'whatsappMetni', 'waTelefon', 'waAdresi', 'paraYaz', 'kacis',
   'fisOzeti', 'ozetBlogu', 'kdvDipnotu', 'sayfalaraBol', 'sayfalayiciBetigi', 'aracCubugu'].forEach((ad) => {
    assert.equal(typeof F[ad], 'function', ad);
  });
  assert.equal(F.PARA_BIRIMI, 'TL');
  assert.equal(F.WA_EN_COK_KALEM, 20);
  assert.equal(F.WA_EN_COK_KARAKTER, 1800);
  assert.equal(F.ALT_YAZI, 'BYOM B2B · Bu fiş bilgi amaçlıdır, fatura yerine geçmez.');
  assert.equal(F.OZET_ETIKET.net, 'NET ÖDENECEK TUTAR');
  assert.equal(F.SAYFA_KAPASITESI, undefined, 'sabit satır kapasitesi KALKTI — yükseklik pencerede ölçülür');
  assert.equal(F.kacis('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');

  /* Kaynak denetimi: çift modlu dışa verme satırları birebir duruyor. */
  const fs = require('node:fs');
  const path = require('node:path');
  const kaynak = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'siparis-fisi.js'), 'utf8');
  assert.ok(kaynak.includes("if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = SiparisFisi;"));
  assert.ok(kaynak.includes("if (typeof window !== 'undefined') window.SiparisFisi = SiparisFisi;"));
  assert.ok(kaynak.includes("'use strict';"));

  /* Motorun KENDİSİ DOM/ağ/require kullanmaz. İki istisna METİN olarak üretilir
     ve yalnızca fiş penceresinde çalışır: sayfalayıcı betiği (ölçüm) ve araç
     çubuğu betiği (IPC). Denetim onların dışındaki kaynağa bakar. */
  const bas = kaynak.indexOf('function sayfalayiciBetigi(');
  const son = kaynak.indexOf('function pencere(');
  assert.ok(bas > 0 && son > bas, 'sayfalayiciBetigi … pencere sırası');
  const motor = kaynak.slice(0, bas) + kaynak.slice(son);
  assert.ok(!/document\.|window\.open|fetch\(|XMLHttpRequest|require\(/.test(motor), 'DOM / ağ / require yok (pencere betikleri hariç)');
});/* ------------------------------------------------------------------ *
 *  7. Faz 12 inceleme turu düzeltmeleri — koli TAM SAYIDIR, il ADI,
 *     ücret satırları
 *
 *  Aşağıdaki sözler CANLI FİŞTE görülen hatalardan doğdu; her biri bir
 *  şikâyetin karşılığıdır. Mevcut iddialar gevşetilmedi, yalnızca eklendi.
 * ------------------------------------------------------------------ */

test('koli tam sayıdır: sunucunun kesirli `boxes` değeri (47/24 = 1,96) DÜŞÜRÜLÜR', () => {
  /* NEDEN: `prepare_order` koli alanını round(adet/koliIci, 2) ile veriyor.
     Fişte "1,96 koli × 24 = 47" yazıyordu — yarım koli diye bir şey yoktur ve
     bayi fişi okunamaz hâle geliyordu. Kesirli koli artık yok sayılır; düz
     adet basmak uydurma bir küsurattan iyidir. */
  const f = F.normalle({
    id: 1, number: '1', date_created: TARIH,
    items: [{ name: 'Silikon', sku: 'S1', quantity: 47, unit_price: 10, total: 470, box_quantity: 24, boxes: 1.96 }]
  }, {});

  assert.equal(f.kalemler[0].koli, 0, 'kesirli koli 0 olur');
  assert.equal(f.kalemler[0].koliIci, 24, 'koli içi korunur — koli türetilemedi diye silinmez');
  assert.equal(f.kalemler[0].adet, 47);
  assert.equal(f.toplamKoli, 0, 'özet satırı da kesirli koli toplamaz');

  const h = F.html(f);
  assert.ok(h.includes('<td class="s-adet sayi">47</td>'), 'düz adet basılır');
  assert.ok(!h.includes('1,96'), 'kesirli koli fişin hiçbir yerinde görünmez');
  assert.ok(!/1,96 koli/.test(F.whatsappMetni(f)));
  assert.ok(h.includes('1 çeşit · 47 adet'), 'koli yoksa özette koli yazılmaz');
});

test('koli eşitliği: yukarı yuvarlanmış koli (2 × 24 ≠ 47) DENKLEM YAZMAZ, "2 koli · 47" yazar', () => {
  /* NEDEN: sunucu koliyi ceil ile verdiğinde fiş "2 koli × 24 = 47" diye
     matematiksel olarak YANLIŞ bir denklem basıyordu. Bayi çarpımı eliyle
     doğrular; tutmayan bir çarpım bütün belgeye olan güveni siler. Eşitlik
     yalnızca koli × koliIci === adet iken basılır; koli bilgisi kaybolmaz. */
  const f = F.normalle({
    id: 2, number: '2', date_created: TARIH,
    items: [{ name: 'Çivi', sku: 'C1', quantity: 47, unit_price: 10, total: 470, box_quantity: 24, boxes: 2 }]
  }, {});

  assert.deepEqual([f.kalemler[0].koli, f.kalemler[0].koliIci, f.kalemler[0].adet], [2, 24, 47]);

  const h = F.html(f);
  assert.ok(h.includes('<td class="s-adet sayi">2 koli · 47</td>'), 'koli bilgisi durur, denklem kurulmaz');
  assert.ok(!h.includes('= 47'), 'yanlış denklem basılmaz');
  assert.ok(!h.includes('2 koli × 24'));
  assert.ok(F.whatsappMetni(f).includes('• Çivi — 2 koli · 47 adet — 470,00 TL'));
});

test('koli eşitliği: TAM BÖLÜNMEDE denklem korunur — "2 koli × 24 = 48"', () => {
  /* NEDEN: yukarıdaki düzeltmeyi yaparken denklemi tamamen kaldırmak
     kolaycılık olurdu; çarpım tuttuğunda bayinin okumak istediği satır tam
     olarak odur. İki kural bir arada dursun diye ayrı test. */
  const f = F.normalle({
    id: 3, number: '3', date_created: TARIH,
    items: [
      { name: 'Silikon', sku: 'S1', quantity: 48, unit_price: 10, total: 480, box_quantity: 24, boxes: 2 },
      { name: 'Vida', sku: 'V1', quantity: 72, unit_price: 1, total: 72, box_quantity: 24 }
    ]
  }, {});

  assert.deepEqual([f.kalemler[0].koli, f.kalemler[1].koli], [2, 3], 'koli adetten de türetilir');
  assert.equal(f.toplamKoli, 5);

  const h = F.html(f);
  assert.ok(h.includes('<td class="s-adet sayi">2 koli × 24 = 48</td>'));
  assert.ok(h.includes('<td class="s-adet sayi">3 koli × 24 = 72</td>'));
  assert.ok(h.includes('2 çeşit · 120 adet · 5 koli'));
  assert.ok(F.whatsappMetni(f).includes('• Silikon — 2 koli × 24 = 48 adet — 480,00 TL'));
});

test('il adı: window YOKKEN (node --test) WooCommerce kodu HAM kalır — uydurulmaz, silinmez', () => {
  /* NEDEN: WooCommerce Türkiye'de ili "TR35" gibi bir KOD saklar; fişte ve
     WhatsApp metninde "İl: TR35" görünüyordu. Çözüm motora ZORUNLU bağımlılık
     eklemeden yapıldı: `ilCoz` yalnızca window.HaritaVeri varsa çevirir.
     Node altında window yoktur — ham metin KORUNUR. */
  const kaynak = {
    id: 4, number: '4', date_created: TARIH,
    dealer: { company_name: 'Ege Nalbur', city: 'TR35' },
    items: [{ name: 'A', quantity: 1, total: 100 }]
  };

  assert.equal(typeof window, 'undefined', 'bu testin ön koşulu: window yok');

  const f = F.normalle(kaynak, {});
  assert.equal(f.musteri.il, 'TR35');
  assert.ok(F.html(f).includes('<dt>İl</dt><dd>TR35</dd>'));

  /* KAYNAK DENETİMİ: davranış testi "hiç çeviri yok" ile "çeviri var ama
     window yok" hâllerini ayıramaz. Çözücünün il alanına bağlı olduğunu
     kaynaktan doğruluyoruz — kaldırılırsa TR35 sahada geri döner. */
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'renderer', 'siparis-fisi.js'), 'utf8');
  assert.ok(/function ilCoz\s*\(/.test(src), 'ilCoz kaldırılmış');
  assert.ok(/il:\s*ilCoz\(/.test(src), 'il alanı ilCoz üzerinden geçmiyor');
  assert.ok(/window\.HaritaVeri/.test(src), 'çözüm isteğe bağlı HaritaVeri üzerinden olmalı');
});

test('il adı: window.HaritaVeri varsa kod ADA çevrilir; çözücü patlarsa ham metne düşülür', () => {
  /* NEDEN: gerçek panelde (Electron) HaritaVeri yüklüdür ve fişte "İzmir"
     yazmalıdır. ilBul'un patlaması ya da ili tanımaması FİŞİ DÜŞÜRMEZ —
     bir künye satırı uğruna belge kaybedilmez. */
  const kaynak = {
    id: 5, number: '5', date_created: TARIH,
    dealer: { company_name: 'Ege Nalbur', city: 'TR35' },
    items: [{ name: 'A', quantity: 1, total: 100 }]
  };

  try {
    global.window = { HaritaVeri: { ilBul: (s) => (/35/.test(s) ? { plaka: 35, ad: 'İzmir' } : null) } };
    assert.equal(F.normalle(kaynak, {}).musteri.il, 'İzmir');
    assert.ok(F.html(F.normalle(kaynak, {})).includes('<dt>İl</dt><dd>İzmir</dd>'));

    global.window = { HaritaVeri: { ilBul: () => { throw new Error('patla'); } } };
    assert.equal(F.normalle(kaynak, {}).musteri.il, 'TR35', 'çözücü patlarsa ham metin');

    global.window = { HaritaVeri: { ilBul: () => null } };
    assert.equal(F.normalle(kaynak, {}).musteri.il, 'TR35', 'tanınmayan il ham kalır');

    global.window = { HaritaVeri: {} };
    assert.equal(F.normalle(kaynak, {}).musteri.il, 'TR35', 'ilBul yoksa ham kalır');
  } finally {
    /* Sonraki testler "window yok" varsayımıyla koşar; ortam geri bırakılır. */
    delete global.window;
  }

  assert.equal(typeof window, 'undefined', 'test kendi ortamını geri bıraktı');
});

test('ücret satırları: iki iskonto da basılır ve Ara toplam − iskontolar = NET kapanır', () => {
  /* NEDEN: sunucu plasiyer ve ödeme yöntemi iskontosunu SATIR FİYATINA
     dokunmadan negatif ÜCRET SATIRI olarak yazar (Registry §0 madde 1). Bu
     satırlar fişe taşınmadığında "Ara toplam 2.152" ile "NET 1.839,96"
     arasındaki 312,04 TL fişte AÇIKLAMASIZ kalıyor, bayi "bu para nereye
     gitti?" diye arıyordu. Sunucu `total` göndermese bile döküm kendi içinde
     kapanmalı. */
  const f = F.normalle({
    id: 6, number: '6', date_created: TARIH,
    items: [
      { name: 'Silikon 280 ml', sku: 'SLK-280', quantity: 48, unit_price: 42.75, total: 2052, box_quantity: 24, boxes: 2 },
      { name: 'Çivi', sku: 'CV-1', quantity: 40, unit_price: 2.5, total: 100 }
    ],
    fee_lines: [
      { name: 'Plasiyer İskontosu (%10)', total: '-215.2' },
      { name: 'Ödeme Yöntemi İskontosu — Nakit (%5)', total: '-96.84' }
    ]
  }, {});

  assert.equal(f.araToplam, 2152);
  assert.equal(f.bayiIskontoTutar, 215.2, 'plasiyer iskontosu ücret satırından');
  assert.equal(f.bayiIskontoOrani, 10, 'oran satır adındaki parantezden');
  assert.equal(f.odemeIskontoTutar, 96.84, 'ödeme iskontosu AYRI satır');
  assert.equal(f.odemeIskontoOrani, 5);
  assert.equal(f.net, 1839.96, 'sunucu total vermese de net iskontolardan kapanır');
  assert.equal(Math.round((f.araToplam - f.bayiIskontoTutar - f.odemeIskontoTutar) * 100) / 100, f.net,
    'Ara toplam − bayi − ödeme = NET');

  /* html: üç tutar da ekranda, eşitlik gözle doğrulanabilir */
  const h = F.html(f);
  assert.ok(h.includes('Liste Fiyatı Ara Toplamı</td><td class="deger sayi">2.152,00 TL'));
  assert.ok(h.includes('Bayi İskonto Tutarı (%10)</td><td class="deger sayi">&minus;215,20 TL'));
  assert.ok(h.includes('Nakit Sipariş İskontosu (%5)</td><td class="deger sayi">&minus;96,84 TL'));
  assert.ok(h.includes('<tr class="net"><td class="etiket">NET ÖDENECEK TUTAR</td><td class="deger sayi">1.839,96 TL'));

  /* whatsappMetni: aynı döküm, aynı sıra — iki kanal ayrışamaz */
  const satirlar = F.whatsappMetni(f).split('\n');
  assert.ok(satirlar.includes('*Liste Fiyatı Ara Toplamı:* 2.152,00 TL'));
  assert.ok(satirlar.includes('*Bayi İskonto Tutarı (%10):* −215,20 TL'));
  assert.ok(satirlar.includes('*Nakit Sipariş İskontosu (%5):* −96,84 TL'));
  assert.ok(satirlar.includes('*NET ÖDENECEK TUTAR: 1.839,96 TL*'));
  assert.ok(satirlar.indexOf('*NET ÖDENECEK TUTAR: 1.839,96 TL*') > satirlar.indexOf('*Liste Fiyatı Ara Toplamı:* 2.152,00 TL'));
});

test('ücret satırları: `ucretler` (panel adı) `fee_lines` ile aynı okunur; işaret ve ilgisiz satır', () => {
  /* NEDEN: aynı bilgi iki adla dolaşıyor — sunucu `fee_lines:[{name,total}]`,
     panel normalizasyonları `ucretler:[{ad,tutar}]`. Aynı kural için iki
     okuyucu yazmak bu depoda iki kez canımızı yakmış hata sınıfıdır
     (§5.13/§5.14); tek okuyucu ikisini de kabul eder. Tutar negatif de
     pozitif de gelebilir (satır zaten indirimdir) → mutlak değer. Kargo gibi
     ilgisiz bir ücret satırı ise iskonto sanılıp NET'i eksiltmemeli. */
  const govde = (ucret) => ({
    id: 7, number: '7', date_created: TARIH,
    items: [{ name: 'A', quantity: 1, unit_price: 1000, total: 1000 }],
    ucretler: ucret
  });

  const eksili = F.normalle(govde([
    { ad: 'Plasiyer İskontosu (%10)', tutar: -100 },
    { ad: 'Ödeme Yöntemi İskontosu — Nakit (%5)', tutar: -45 }
  ]), {});

  assert.deepEqual([eksili.araToplam, eksili.bayiIskontoTutar, eksili.odemeIskontoTutar, eksili.net],
    [1000, 100, 45, 855]);

  const artili = F.normalle(govde([
    { ad: 'Plasiyer İskontosu (%10)', tutar: 100 },
    { ad: 'Ödeme Yöntemi İskontosu — Nakit (%5)', tutar: 45 }
  ]), {});

  assert.deepEqual([artili.bayiIskontoTutar, artili.odemeIskontoTutar, artili.net], [100, 45, 855]);

  const kargo = F.normalle(govde([{ ad: 'Kargo Bedeli', tutar: 50 }]), {});
  assert.deepEqual([kargo.bayiIskontoTutar, kargo.odemeIskontoTutar, kargo.net], [0, 0, 1000]);
  assert.ok(!F.html(kargo).includes('Bayi iskontosu'), 'kargo iskonto satırı üretmez');
});

/* ------------------------------------------------------------------ *
 *  8. KDV — BELGEDE DÖKÜLÜR, PANELDE HESAPLANMAZ
 *
 *  Ürün sahibi: "Müşteri fişi aldığında neyden ne kadar vermiş, kaç KDV'li
 *  vermiş öğrensin." Oran ürün başına sunucudan gelir (`_byom_kdv_rate` →
 *  `vat_rate`); panel KENDİ oran listesini TUTMAZ. "KDV istemiyorum" seçilen
 *  siparişte sunucu satırları netleştirir; fiş bunu AÇIKÇA yazar ve NET'ten
 *  KDV'yi İKİNCİ KEZ DÜŞMEZ.
 * ------------------------------------------------------------------ */

/** (a) yönetici normalizasyonu — Türkçe anahtarlar + KDV künyesi. */
function kdvYoneticiKaynak() {
  const k = yoneticiKaynak();

  k.bayiIskontoOrani = 0;
  k.odemeIskonto = 0;
  k.tutar = 2152;
  k.kdvToplam = 358.67;
  k.kalemler = [
    { ad: 'Silikon 280 ml', kod: 'SLK-280', adet: 48, koliIci: 24, tutar: 2052, kdvOrani: 20, kdvTutar: 342 },
    { ad: 'Çivi', kod: 'CV-1', adet: 40, tutar: 100, kdvOrani: 20, kdvTutar: 16.67 }
  ];

  return k;
}

/** (b) saha normalizasyonu — plasiyer-siparislerim.js → normalle çıktısı. */
function kdvSahaKaynak() {
  return {
    id: 91, numara: '91', tarih: TARIH, durum: 'processing', durumEtiketi: 'İşleniyor', tutar: 2152,
    musteri: 'Yıldız Nalburiye', odeme: 'nakit', iskonto: 0,
    kdvIstenmedi: false, kdvDusulen: 0, kdvToplam: 358.67,
    kalemler: [
      { urunId: 5, ad: 'Silikon 280 ml', adet: 48, koliIci: 24, koli: 2, birim: 42.75, tutar: 2052, kdvOrani: 20, kdvTutar: 342 },
      { urunId: 9, ad: 'Çivi', adet: 40, birim: 2.5, tutar: 100, kdvOrani: 20, kdvTutar: 16.67 }
    ],
    notlar: ''
  };
}

/** (c) ham prepare_order yükü — İngilizce sözleşme adları. */
function kdvHamKaynak() {
  return {
    id: 6448, number: '6448', date_created: TARIH, status: 'processing', status_label: 'İşleniyor',
    total: 2152, subtotal: 2152, vat_total: 358.67, vat_excluded: false, vat_removed: 0,
    dealer: { company_name: 'Acme Hırdavat', phone: '0532 415 22 78' },
    items: [
      { name: 'Silikon 280 ml', sku: 'SLK-280', quantity: 48, unit_price: 42.75, total: 2052, box_quantity: 24, boxes: 2, vat_rate: 20, vat_amount: 342 },
      { name: 'Çivi', sku: 'CV-1', quantity: 40, unit_price: 2.5, total: 100, vat_rate: 20, vat_amount: 16.67 }
    ],
    payment_method_title: 'Nakit'
  };
}

test('KDV: ÜÇ KAYNAK da aynı künyeyi verir (kalemde oran+tutar, kökte toplam) ve A4 fişte KDV SÜTUNLARI basılır', () => {
  /* NEDEN ÜÇÜ BİRDEN: aynı fiş üç ekrandan üretiliyor. Biri KDV alanını
     taşımazsa o ekranda fiş sessizce KDV'siz çıkar — "eksik fiş" şikâyeti tam
     olarak bu sınıftan doğdu (kalem dökümünün `items` altında kalması, Faz 11
     Görsel 6). Anahtar kümesi FIS_ANAHTARLARI ile zaten kilitli; burada
     DEĞERİN de taşındığını ölçüyoruz. */
  [kdvYoneticiKaynak(), kdvSahaKaynak(), kdvHamKaynak()].forEach((kaynak, i) => {
    const f = F.normalle(kaynak, BAGLAM);
    const ad = ['yönetici', 'saha', 'ham'][i];

    assert.equal(f.kalemler[0].kdvOrani, 20, ad + ': satır oranı');
    assert.equal(f.kalemler[0].kdvTutar, 342, ad + ': satır KDV tutarı');
    assert.equal(f.kalemler[1].kdvOrani, 20, ad);
    assert.equal(f.kalemler[1].kdvTutar, 16.67, ad);
    assert.equal(f.kdvToplam, 358.67, ad + ': kök toplam sunucudan');
    assert.equal(f.kdvIstenmedi, false, ad);
    assert.equal(f.kdvDusulen, 0, ad);
    assert.equal(bozukDeger(f), '', ad + ': bozuk deger');

    const h = F.html(f);

    assert.ok(h.includes('<th class="sayi">KDV Oranı</th>'), ad + ': KDV oranı sütunu');
    assert.ok(h.includes('<th class="sayi">KDV Tutarı</th>'), ad + ': KDV tutarı sütunu');
    assert.ok(h.includes('<td class="s-kdv sayi">%20</td>'), ad + ': satırda oran');
    assert.ok(h.includes('<td class="s-kdvtutar sayi">342,00 TL</td>'), ad + ': satırda tutar');
    /* Faz 14-B: KDV satırı YALIN; açıklaması dipnotta (renkli kutu değil). */
    assert.ok(h.includes('<tr class="kdv"><td class="etiket">KDV (%20)</td><td class="deger sayi">358,67 TL</td></tr>'), ad + ': toplam KDV satırı yalın');
    assert.ok(h.includes('<div class="dipnot">Fiyatlara KDV dâhildir. KDV (%20) satırı bilgi amaçlıdır; toplamdan ayrıca düşülmez ya da eklenmez.</div>'), ad + ': dipnot');
    assert.ok(h.indexOf('KDV (%20)') < h.indexOf('NET ÖDENECEK TUTAR'), ad + ': KDV, NET satırından ÖNCE');
    assert.ok(!h.includes('kdv-notu') && !h.includes('class="ince"'), ad + ': kutu / satır içi not yok');

    /* Aynı bilgi WhatsApp'ta TEK SATIR — kalem başına yazmak 1800 karakter
       bütçesini yer ve sınıra dayanınca ilk düşen şey kalem olurdu. */
    const wa = F.whatsappMetni(f).split('\n');

    assert.ok(wa.includes('*KDV (%20):* 358,67 TL'), ad + ': WhatsApp KDV satırı');
    assert.ok(wa.indexOf('*KDV (%20):* 358,67 TL') < wa.indexOf('*NET ÖDENECEK TUTAR: 2.152,00 TL*'), ad);
  });
});
test('sütun sırası ürün sahibinin istediği gibi (Faz 14) — Ürün Adı · Kod/Barkod · Koli/Adet · Birim Fiyat · İskontolu Birim Fiyat · KDV Oranı · KDV Tutarı · Satır Tutarı', () => {
  /* NEDEN: sıra doğrudan ürün sahibinin cümlesidir ("Yeni düzen: …").
     Sütunları alfabetik ya da "para en sağa" diye yeniden dizmek fişi
     yeniden tartışmaya açar; sıra bir tercih değil, kabul edilmiş bir istektir.
     Sütunlar SABİTTİR: künye yoksa hücre "—" olur, sütun kaybolmaz. */
  const kaynak = kdvHamKaynak();
  kaynak.items[0].list_unit_price = 47.5;   // web siparişi: liste 47,50 → iskontolu 42,75

  const h = F.html(F.normalle(kaynak, BAGLAM));

  assert.ok(h.includes(
    '<th>Ürün Adı</th><th>Kod / Barkod</th><th class="sayi">Koli / Adet</th>' +
    '<th class="sayi">Birim Fiyat</th><th class="sayi">İskontolu Birim Fiyat</th>' +
    '<th class="sayi">KDV Oranı</th><th class="sayi">KDV Tutarı</th><th class="sayi">Satır Tutarı</th>'
  ));

  assert.ok(h.includes(
    '<td class="s-ad">Silikon 280 ml</td><td class="s-sku">SLK-280</td>' +
    '<td class="s-adet sayi">2 koli × 24 = 48</td>' +
    '<td class="s-liste sayi">47,50 TL</td><td class="s-birim sayi">42,75 TL</td>' +
    '<td class="s-kdv sayi">%20</td><td class="s-kdvtutar sayi">342,00 TL</td>' +
    '<td class="s-tutar sayi">2.052,00 TL</td>'
  ), 'hücre sırası başlıkla birebir; liste > iskontolu birim ikisi de yazılır');

  /* Liste birim gelmeyen satırda iskontolu birim "—": iki fiyat aynıysa ikinci sütun bilgi değil gürültü */
  assert.ok(h.includes('<td class="s-liste sayi">2,50 TL</td><td class="s-birim sayi">—</td>'));
});
test('KDV İSTENMEDİ: açık dipnot basılır, toplam KDV satırı UYGULANMADI der ve NET İKİNCİ KEZ DÜŞMEZ', () => {
  /* NEDEN: "KDV istemiyorum" seçildiğinde sunucu satır tutarlarını ZATEN
     netleştirir (B2B_Order_Revision::apply_vat_mode → `_b2b_vat_excluded`).
     Panelin bir kez daha KDV çıkarması müşteriye iki kez indirim yazmak, yani
     doğrudan para hatasıdır. Fişin görevi hesaplamak değil, olanı AÇIKÇA
     söylemek: müşteri "KDV siz aldım, şu kadar düştü" diye okuyabilmeli. */
  const govde = (ek) => Object.assign({
    id: 20, number: '20', date_created: TARIH,
    dealer: { company_name: 'Acme Hırdavat', phone: '0532 415 22 78' },
    vat_excluded: true, vat_removed: 358.67,
    items: [
      { name: 'Silikon 280 ml', sku: 'SLK-280', quantity: 48, unit_price: 35.625, total: 1710, box_quantity: 24, boxes: 2, vat_rate: 20, vat_amount: 342 },
      { name: 'Çivi', sku: 'CV-1', quantity: 40, unit_price: 2.083, total: 83.33, vat_rate: 20, vat_amount: 16.67 }
    ]
  }, ek || {});

  const f = F.normalle(govde({ total: 1793.33 }), BAGLAM);

  assert.equal(f.kdvIstenmedi, true);
  assert.equal(f.kdvDusulen, 358.67, 'sunucunun vat_removed damgası');
  assert.equal(f.araToplam, 1793.33);
  assert.equal(f.net, 1793.33, 'NET = sunucunun tutarı; KDV bir kez daha düşülmez');

  /* Sunucu `total` göndermese bile panelin kendi hesabı KDV düşmez. */
  const hesapli = F.normalle(govde({}), BAGLAM);

  assert.equal(hesapli.net, hesapli.araToplam, 'panel hesabı da KDV çıkarmaz');
  assert.equal(hesapli.net, 1793.33);

  const h = F.html(f);

  /* Faz 14-B: açıklama sarı kutuda DEĞİL, toplamın altında küçük puntoda dipnotta. */
  assert.ok(h.includes('<div class="dipnot">Bu siparişte KDV uygulanmamıştır (düşülen KDV: 358,67 TL). Tutarlar, ürünlerin tekil KDV oranları düşüldükten sonraki değerlerdir.</div>'), 'dipnot');
  assert.ok(!h.includes('kdv-notu') && !h.includes('#fffbeb'), 'sarı bilgi kutusu YOK');
  assert.ok(h.includes('Bu siparişte KDV uygulanmamıştır (düşülen KDV: 358,67 TL)'), 'düşülen tutar yazıyla');
  assert.ok(h.includes('<tr class="kdv-yok"><td class="etiket">KDV</td><td class="deger sayi">UYGULANMADI</td>'));
  assert.ok(!h.includes('KDV (%20)</td>'), 'toplam KDV satırı KDV siz siparişte basılmaz');
  assert.ok(h.includes('<tr class="net"><td class="etiket">NET ÖDENECEK TUTAR</td><td class="deger sayi">1.793,33 TL'));
  assert.ok(h.includes('<td class="s-kdv sayi">%20</td>'), 'hangi orandan düşüldüğü satırda görünür');

  const wa = F.whatsappMetni(f).split('\n');

  assert.ok(wa.includes('*KDV UYGULANMADI* (düşülen: 358,67 TL)'));
  assert.ok(wa.includes('*NET ÖDENECEK TUTAR: 1.793,33 TL*'));

  /* `vat_removed` damgası yoksa satır KDV lerinin toplamı yazılır — panel
     yeni bir sayı UYDURMAZ, iki değer de sunucunundur. */
  const damgasiz = F.normalle(govde({ total: 1793.33, vat_removed: 0 }), BAGLAM);

  assert.equal(damgasiz.kdvDusulen, 358.67);
  assert.ok(F.html(damgasiz).includes('(düşülen KDV: 358,67 TL)'));

  /* SAHA ŞABLONU (panelin normal nesnesi) aynı künyeyi TÜRKÇE adlarla taşır.
     İki okuyucu ayrışırsa saha ekranından basılan fiş sessizce KDV'li görünür
     ve müşteriye YANLIŞ belge gider — ham yükte geçen bir test bunu görmez. */
  const saha = F.normalle({
    id: 91, numara: '91', tarih: TARIH, tutar: 1793.33,
    musteri: 'Yıldız Nalburiye', odeme: 'nakit',
    kdvIstenmedi: true, kdvDusulen: 358.67, kdvToplam: 400,
    kalemler: [
      { ad: 'Silikon 280 ml', adet: 48, koliIci: 24, koli: 2, birim: 35.625, tutar: 1710, kdvOrani: 20, kdvTutar: 342 },
      { ad: 'Çivi', adet: 40, birim: 2.083, tutar: 83.33, kdvOrani: 20, kdvTutar: 16.67 }
    ]
  }, {});

  assert.equal(saha.kdvIstenmedi, true, 'panel nesnesi de KDV künyesini taşır');
  assert.equal(saha.kdvDusulen, 358.67, 'düşülen KDV panel adıyla okunur');
  assert.equal(saha.kdvToplam, 400, 'kök alan satır toplamını ezer (panel tarafında da)');
  assert.ok(F.html(saha).includes('Bu siparişte KDV uygulanmamıştır (düşülen KDV: 358,67 TL)'));
  assert.ok(F.html(saha).includes('<td class="deger sayi">UYGULANMADI</td>'));
});
test('KDV termal: 80 mm tek sütundur — KDV kalemin ALTINDA ikinci satır, yan yana sütun YOK', () => {
  /* NEDEN: 74 mm lik kâğıda yedi sütun sığmaz; sığdırmaya çalışmak ürün adını
     üç harfe düşürür. Aynı veri, iki yerleşim: A4 tablo, termal liste. Tek
     çizici iki bayrakla çalışır — ikinci bir kod yolu iki farklı fiş demekti. */
  const f = F.normalle(kdvHamKaynak(), BAGLAM);
  const termal = F.html(f, { kagit: 'termal' });
  const a4 = F.html(f, { kagit: 'a4' });

  assert.ok(termal.includes('<tr class="s-kdv-satir"><td class="s-kdv-bilgi" colspan="5">KDV %20 · 342,00 TL</td></tr>'));
  assert.ok(termal.includes('KDV %20 · 16,67 TL'));
  assert.ok(!termal.includes('<th class="sayi">KDV Tutarı</th>'), 'termalde KDV SÜTUNU yok');
  assert.ok(!termal.includes('<td class="s-kdv sayi">'), 'termalde oran sütunu yok');
  assert.ok(termal.includes('KDV (%20)</td><td class="deger sayi">358,67 TL'), 'toplam KDV termalde de var');

  assert.ok(a4.includes('<th class="sayi">KDV Tutarı</th>'), 'A4 sütunlu');
  assert.ok(!a4.includes('s-kdv-satir'), 'A4 te ikinci satır yok');

  /* Kalem tek blok okunsun diye üstteki satırın alt çizgisi kalkar. */
  assert.ok(termal.includes('<tr class="s-kdvli">'));
  assert.ok(termal.includes('.kalemler tr.s-kdvli td { border-bottom:0; }'));
});

test('KDV karışık oran: toplam satırların toplamıdır, etiket "karışık oran" der', () => {
  /* NEDEN: sepette %20 hırdavat ile %1 gıda birlikte olabilir. Tek bir oran
     yazmak müşteriye YANLIŞ bilgi verir ("%20 KDV ödedim" sanır); satırı hiç
     basmamak ise sorulan soruyu cevapsız bırakır. Tutar her hâlde doğrudur. */
  const f = F.normalle({
    id: 30, number: '30', date_created: TARIH, total: 1900,
    dealer: { company_name: 'Karma Bayi' },
    items: [
      { name: 'Silikon', sku: 'S1', quantity: 1, unit_price: 1800, total: 1800, vat_rate: 20, vat_amount: 300 },
      { name: 'Un', sku: 'U1', quantity: 1, unit_price: 100, total: 100, vat_rate: 1, vat_amount: 0.99 }
    ]
  }, {});

  assert.equal(f.kdvToplam, 300.99, 'kök alan yok → satırların toplamı');
  assert.equal(f.kalemler[0].kdvOrani, 20);
  assert.equal(f.kalemler[1].kdvOrani, 1);

  const h = F.html(f);

  assert.ok(h.includes('KDV (karışık oran)</td><td class="deger sayi">300,99 TL'));
  assert.ok(!h.includes('KDV (%20)</td>'), 'tek orana indirgenmez');
  assert.ok(h.includes('<td class="s-kdv sayi">%20</td>'));
  assert.ok(h.includes('<td class="s-kdv sayi">%1</td>'), 'her satır KENDİ oranını gösterir');
  assert.ok(F.whatsappMetni(f).includes('*KDV (karışık oran):* 300,99 TL'));

  /* Tek orana dönünce etiket de döner. */
  const tek = F.normalle({
    id: 31, number: '31', date_created: TARIH, total: 1900,
    items: [{ name: 'Silikon', quantity: 1, total: 1800, vat_rate: 20, vat_amount: 300 }]
  }, {});

  assert.ok(F.html(tek).includes('KDV (%20)</td>'));
});

test('KDV künyesi HİÇ yokken: fiş çökmez; A4 sütunu ve özet satırı DURUR ama "—" basılır, termalde alt satır ve uyarı YOK', () => {
  /* NEDEN (Faz 14): sütun düzeni SABİT — künye yoksa hücre "—" (bilmiyoruz).
     "%0 · 0,00" YAZILMAZ: %0 KDV gerçek bir orandır, bilinmiyorla
     karıştırılamaz. Termal tek sütundur; orada KDV alt satırı ve uyarı
     bloğu yalnızca künye varken basılır. */
  const f = F.normalle(yoneticiKaynak(), BAGLAM);

  assert.equal(f.kdvToplam, 0);
  assert.equal(f.kdvIstenmedi, false);
  assert.equal(f.kdvDusulen, 0);
  f.kalemler.forEach((k) => {
    assert.equal(k.kdvOrani, 0, 'sayı olmalı — undefined/NaN değil');
    assert.equal(k.kdvTutar, 0);
  });

  const a4 = F.html(f, { kagit: 'a4' });
  const a4Govde = a4.slice(a4.indexOf('<body'));

  assert.ok(a4Govde.includes('<th class="sayi">KDV Oranı</th>'), 'A4: sütun SABİT');
  assert.ok(a4Govde.includes('<td class="s-kdv sayi">—</td><td class="s-kdvtutar sayi">—</td>'), 'A4: hücre "—"');
  assert.ok(!a4Govde.includes('%0'), 'A4: %0 uydurulmaz');
  assert.ok(a4Govde.includes('<tr class="kdv bos"><td class="etiket">KDV</td><td class="deger sayi">—</td></tr>'), 'A4: özet satırı "—"');
  assert.ok(!a4Govde.includes('kdv-notu'), 'A4: uyarı bloğu yok');
  assert.ok(a4Govde.includes('NET ÖDENECEK TUTAR'), 'A4: belge yine tam');

  const termal = F.html(f, { kagit: 'termal' });
  const tGovde = termal.slice(termal.indexOf('<body'));

  assert.ok(!tGovde.includes('s-kdv'), 'termal: KDV alt satırı yok');
  assert.ok(!tGovde.includes('kdv-notu'), 'termal: uyarı bloğu yok');
  assert.ok(tGovde.includes('<tr class="kdv bos">'), 'termal: özet satırı yine sabit');

  assert.ok(!/KDV/.test(F.whatsappMetni(f)), 'WhatsApp metninde KDV geçmez (bilinmeyen sayı yazılmaz)');

  /* Bozuk / eksik kaynaklarda da çökmez. */
  [F.normalle({}, {}), F.normalle(null), F.normalle({ kalemler: [null, 7, { ad: 'A', adet: 1, tutar: 5 }] }, {})]
    .forEach((x) => {
      assert.equal(bozukDeger(x), '', 'bozuk deger: ' + bozukDeger(x));
      assert.ok(F.html(x).includes('NET ÖDENECEK TUTAR'));
    });
});
test('KDV türetmesi: tutar HİÇ gelmediyse orandan — KDV dahil fiyattan AYRIŞTIRILIR, KDV hariç siparişte ÜSTÜNE eklenir', () => {
  /* NEDEN: fiyatlar KDV DAHİL girilir (sistemin sözleşmesi). 120 TL lik %20
     KDV li bir ürünün KDV si 24 değil 20 TL dir — "tutar × oran" yazmak her
     satırda sessiz bir para hatası olurdu. Sipariş KDV hariç kipine
     çevrildiyse satır tutarı ZATEN nettir ve KDV üstüne eklenir. Bu dal
     YALNIZCA sunucu tutarı hiç göndermediğinde çalışır. */
  const dahil = F.normalle({
    id: 40, number: '40', date_created: TARIH,
    items: [{ name: 'A', quantity: 1, total: 120, vat_rate: 20 }]
  }, {});

  assert.equal(dahil.kalemler[0].kdvTutar, 20, '120 × 20/120 = 20 (içinden ayrıştırma)');
  assert.equal(dahil.kdvToplam, 20);

  const haric = F.normalle({
    id: 41, number: '41', date_created: TARIH, vat_excluded: true,
    items: [{ name: 'A', quantity: 1, total: 100, vat_rate: 20 }]
  }, {});

  assert.equal(haric.kalemler[0].kdvTutar, 20, '100 × 20/100 = 20 (üstüne ekleme)');

  /* SUNUCU TUTARI HER ZAMAN KAZANIR — türetme onu ezmez (tek kaynak kuralı). */
  const sunucu = F.normalle({
    id: 42, number: '42', date_created: TARIH,
    items: [{ name: 'A', quantity: 1, total: 120, vat_rate: 20, vat_amount: 5 }]
  }, {});

  assert.equal(sunucu.kalemler[0].kdvTutar, 5, 'sunucunun tutarı yeniden hesaplanmaz');

  /* Kök `vat_total` de satır toplamını ezer. */
  const kok = F.normalle({
    id: 43, number: '43', date_created: TARIH, vat_total: 99,
    items: [{ name: 'A', quantity: 1, total: 120, vat_rate: 20, vat_amount: 20 }]
  }, {});

  assert.equal(kok.kdvToplam, 99, 'kök alan satır toplamından önce gelir');
});

/* ------------------------------------------------------------------ *
 *  8. Faz 14 — sayfalama, ortak özet bloğu, araç çubuklu pencere
 *
 *  Ürün sahibi: "ürün kalemi çok olunca satırlar ve sütunlar küçülmesin;
 *  gerekirse birden fazla sayfaya yayılsın ama net ve okunabilir olsun".
 *  Sayfa ölçüsü SABİT, sayfa sayısı değişkendir; özet bloğu bölünmez.
 * ------------------------------------------------------------------ */

test('sayfalaraBol: DENGELİ dağıtım — özet tek başına sayfaya atılmaz, sayfa sayısı en az, hiçbir kalem kayıp/çift değil', () => {
  /* Ürün sahibi: "ikinci sayfada sadece iskonto tablosu olmasın; sırf onun
     için sayfa basılmaz, denge olsun". Birim önemsiz: sayı → her kalem 1. */
  const kap = { ilk: 20, devam: 26, ozet: 9 };
  const dag = (n, k) => F.sayfalaraBol(n, k || kap).sayfalar.map((s) => s.son - s.bas);

  assert.deepEqual(dag(5), [5], '5 kalem + özet tek sayfa');
  assert.deepEqual(dag(11), [11], '11 kalem + 9 özet = 20 → tek sayfa (sınır)');
  assert.deepEqual(dag(12), [6, 6], 'özet sığmayınca sayfa AÇILIR ama kalemler DENGELİ bölünür');
  assert.deepEqual(dag(20), [10, 10], '20 kalem → 20 + boş sayfada özet DEĞİL');
  assert.deepEqual(dag(23), [12, 11]);
  assert.deepEqual(dag(37), [20, 17], 'son sayfa özetle dolar (17 + 9 = 26), ilk sayfa doldurulur');
  assert.deepEqual(dag(50), [17, 17, 16], 'üç sayfa, dengeli');
  assert.equal(F.sayfalaraBol(50, kap).toplam, 3);
  assert.equal(F.sayfalaraBol(20, kap).ozetAyri, false, 'özet yalnız sayfaya GİTMEZ');

  /* Hiçbir kalem iki sayfada birden değil, hiçbiri kayıp değil. */
  const cok = F.sayfalaraBol(50, kap);
  const gorulen = [];
  cok.sayfalar.forEach((s) => { for (let i = s.bas; i < s.son; i++) gorulen.push(i); });
  assert.deepEqual(gorulen, Array.from({ length: 50 }, (_, i) => i));

  /* Ölçülmüş yükseklikler (px): farklı satırlar farklı ağırlık. */
  const px = F.sayfalaraBol([40, 40, 80, 40, 40, 120, 40, 40], { ilk: 200, devam: 220, ozet: 150 });
  assert.equal(px.sayfalar.reduce((t, s) => t + (s.son - s.bas), 0), 8, 'kalem sayısı korunur');
  px.sayfalar.forEach((s, i) => {
    const kapasite = (i === 0 ? 200 : 220) - (i === px.sayfalar.length - 1 ? 150 : 0);
    assert.ok(s.agirlik <= kapasite, 'sayfa ' + (i + 1) + ' taşmaz: ' + s.agirlik + ' ≤ ' + kapasite);
  });
  assert.equal(px.ozetAyri, false);

  /* Özet tek başına bir sayfadan büyükse (istisna) ayrı sayfa. */
  const dev = F.sayfalaraBol(3, { ilk: 10, devam: 10, ozet: 12 });
  assert.equal(dev.ozetAyri, true);
  assert.equal(dev.toplam, 2);

  /* Sıfır kalem: tek sayfa, özet o sayfada. Bozuk girdi çökmez. */
  assert.deepEqual(F.sayfalaraBol(0, kap).sayfalar, [{ bas: 0, son: 0, agirlik: 0 }]);
  assert.equal(F.sayfalaraBol('abc').sayfalar.length, 1);
  assert.equal(F.sayfalaraBol(-4).sayfalar[0].son, 0);
  assert.equal(F.sayfalaraBol([1, 'x', null, 2], { ilk: 10 }).sayfalar[0].agirlik, 3, 'bozuk ağırlık 0 sayılır');
});
test('html A4: belge AKIŞ iskeletiyle basılır (sayfalama pencerede ölçülerek yapılır); sabit ölçü, ad kırpılmaz, yoğunluk kademesi YOK', () => {
  const kalemler = [];
  for (let i = 1; i <= 50; i++) kalemler.push({ ad: 'Ürün ' + i + ' — çok uzun bir ürün adı ki sarsın ve yine de tam okunsun', adet: 1, tutar: 10 });

  const h = F.html(F.normalle({ numara: '77', tutar: 500, kalemler }, { firmaAdi: 'X' }));

  /* Sayfalayıcı sözleşmesi (depo fişi de aynı iskeleti kurar) */
  assert.ok(h.includes('<div class="belge" data-kagit="a4" data-icerik-mm="273">'));
  assert.ok(h.includes('<div class="belge-bas">'), 'ilk sayfa başlığı');
  assert.ok(h.includes('<div class="belge-devam" hidden>'), 'devam başlığı şablonu (gizli)');
  assert.ok(h.includes('Sayfa <span class="sayfa-no"></span> / <span class="sayfa-toplam"></span> (devam)'));
  assert.ok(h.includes('<table class="kalemler">'));
  assert.ok(h.includes('<div class="kapanis">'), 'özet + dipnot + not + alt yazı tek blok');
  assert.ok(h.includes('<div class="sayfa-alt" hidden>'), 'sayfa altı şablonu');
  assert.equal((h.match(/<div class="sayfa[" ]/g) || []).length, 0, 'html() sayfa üretmez — ölçüm pencerede');
  assert.equal((h.match(/<td class="s-ad">/g) || []).length, 50, 'hiçbir kalem kayıp / çift değil');
  assert.equal((h.match(/<table class="toplamlar">/g) || []).length, 1, 'özet bloğu bir kez');
  assert.equal((h.match(/<section class="kunye">/g) || []).length, 1);

  /* Sabit ölçü, kırpma yok, renkli süs yok. */
  assert.ok(h.includes('.sayfa { position:relative; height:297mm; overflow:hidden; --kenar:12mm; }'));
  assert.ok(h.includes('body.a4 .sayfa { height:273mm; --kenar:0; page-break-after:always; break-after:page; }'));
  assert.ok(!/line-clamp|\.sik|\.orta|--yazi|--gorsel/.test(h), 'ürün adı KIRPILMAZ; yoğunluk kademesi yok');
  assert.ok(!/#fffbeb|#b45309|#b91c1c|nth-child\(even\)/.test(h), 'sarı/kırmızı vurgu ve çizgili zemin yok');
  assert.ok(h.includes('tr, .kutu, .toplamlar, .not, .kapanis { page-break-inside:avoid; break-inside:avoid; }'), 'akış yedeğinde de bölünmez');
  assert.ok(h.includes('thead { display:table-header-group; }'));
  assert.ok(h.includes('<div class="no">No: #77</div>'), 'belge numarası kalın künye');

  /* Termal SAYFALANMAZ (rulo): devam başlığı ve sayfa altı yok */
  const termal = F.html(F.normalle({ numara: '79', tutar: 1, kalemler }, {}), { kagit: 'termal' });
  const tGovde = termal.slice(termal.indexOf('<body'));
  assert.ok(tGovde.includes('data-kagit="termal"'));
  assert.ok(!tGovde.includes('belge-devam') && !tGovde.includes('sayfa-alt'), 'termal gövdesinde devam başlığı / sayfa altı yok');
});
test('ozetBlogu: ALTI SABİT SATIR — dolu ve boş hâller, ek satırlar, KDV üç hâl; kdvDipnotu açıklaması', () => {
  const dolu = F.ozetBlogu({
    liste: 2152, bayiOrani: 10, bayiTutar: 215.2, iskontoluAra: 1936.8,
    odemeAdi: 'Nakit', odemeOrani: 5, odemeTutar: 96.84,
    kdv: { tutar: 358.67, oran: 20, karisik: false, istenmedi: false, dusulen: 0, bilinmiyor: false, ustune: false },
    ekSatirlar: [{ etiket: 'KARGO / NAVLUN', tutar: 50 }, { etiket: 'Kupon', tutar: -12.5, sinif: 'indirim' }, { etiket: 'sıfır', tutar: 0 }],
    net: 1839.96
  });

  const sira = ['Liste Fiyatı Ara Toplamı', 'Bayi İskonto Tutarı (%10)', 'İskontolu Ara Toplam', 'Nakit Sipariş İskontosu (%5)', 'KARGO / NAVLUN', 'Kupon', 'KDV (%20)', 'NET ÖDENECEK TUTAR'];
  let son = -1;
  sira.forEach((e) => { const i = dolu.indexOf(e); assert.ok(i > son, 'sıra: ' + e); son = i; });
  assert.ok(!dolu.includes('sıfır'), 'sıfır ek satır basılmaz');
  assert.ok(dolu.includes('<tr class="indirim bayi"><td class="etiket">Bayi İskonto Tutarı (%10)</td><td class="deger sayi">&minus;215,20 TL</td></tr>'));
  assert.ok(dolu.includes('<tr class="ara"><td class="etiket">İskontolu Ara Toplam</td><td class="deger sayi">1.936,80 TL</td></tr>'));
  assert.ok(dolu.includes('<tr class="ek"><td class="etiket">KARGO / NAVLUN</td><td class="deger sayi">50,00 TL</td></tr>'));
  assert.ok(dolu.includes('<tr class="ek indirim"><td class="etiket">Kupon</td><td class="deger sayi">&minus;12,50 TL</td></tr>'));
  assert.ok(dolu.includes('<tr class="kdv"><td class="etiket">KDV (%20)</td><td class="deger sayi">358,67 TL</td></tr>'), 'KDV satırı yalın');
  assert.ok(dolu.includes('<tr class="net"><td class="etiket">NET ÖDENECEK TUTAR</td><td class="deger sayi">1.839,96 TL</td></tr>'));
  assert.ok(!dolu.includes('class="ince"'), 'tablo içine açıklama girmez');

  /* Hiç iskonto, KDV bilinmiyor → aynı altı satır, değerler "—" */
  const bos = F.ozetBlogu({ liste: 100, iskontoluAra: 100, kdv: { bilinmiyor: true }, net: 100 });
  assert.equal((bos.match(/<tr /g) || []).length, 6, 'tam altı satır');
  assert.ok(bos.includes('<tr class="bayi bos"><td class="etiket">Bayi İskonto Tutarı</td><td class="deger sayi">—</td></tr>'));
  assert.ok(bos.includes('<tr class="odeme bos"><td class="etiket">Ödeme Yöntemi Sipariş İskontosu</td><td class="deger sayi">—</td></tr>'));
  assert.ok(bos.includes('<tr class="kdv bos"><td class="etiket">KDV</td><td class="deger sayi">—</td></tr>'));

  /* KDV üç hâl: istenmedi / üstüne eklenir / karışık */
  assert.ok(F.ozetBlogu({ kdv: { istenmedi: true } }).includes('<tr class="kdv-yok"><td class="etiket">KDV</td><td class="deger sayi">UYGULANMADI</td></tr>'));
  assert.ok(F.ozetBlogu({ kdv: { tutar: 20, oran: 20, ustune: true } }).includes('<tr class="kdv"><td class="etiket">KDV (%20)</td><td class="deger sayi">20,00 TL</td></tr>'));
  assert.ok(F.ozetBlogu({ kdv: { tutar: 30, karisik: true } }).includes('KDV (karışık oran)</td>'));

  /* Dipnot: açıklama TABLONUN ALTINDA küçük puntoda — üç hâl + bilinmiyorsa boş */
  assert.equal(F.kdvDipnotu({ tutar: 20, oran: 20 }), 'Fiyatlara KDV dâhildir. KDV (%20) satırı bilgi amaçlıdır; toplamdan ayrıca düşülmez ya da eklenmez.');
  assert.equal(F.kdvDipnotu({ tutar: 20, oran: 20, ustune: true }), 'KDV (%20) tutara eklenmiştir; NET ÖDENECEK TUTAR KDV dâhildir.');
  assert.equal(F.kdvDipnotu({ istenmedi: true, dusulen: 358.67 }), 'Bu siparişte KDV uygulanmamıştır (düşülen KDV: 358,67 TL). Tutarlar, ürünlerin tekil KDV oranları düşüldükten sonraki değerlerdir.');
  assert.equal(F.kdvDipnotu({ istenmedi: true }), 'Bu siparişte KDV uygulanmamıştır. Tutarlar, ürünlerin tekil KDV oranları düşüldükten sonraki değerlerdir.');
  assert.equal(F.kdvDipnotu({ tutar: 30, karisik: true }), 'Fiyatlara KDV dâhildir. KDV (karışık oran) satırı bilgi amaçlıdır; toplamdan ayrıca düşülmez ya da eklenmez.');
  assert.equal(F.kdvDipnotu({ bilinmiyor: true }), '', 'bilinmeyen şey yazılmaz');
  assert.equal(F.kdvDipnotu(null), '');

  /* Kaçış: etiketler HTML olarak yorumlanmaz; bozuk girdi çökertmez */
  assert.ok(F.ozetBlogu({ odemeAdi: '<b>x</b>', odemeTutar: 1, ekSatirlar: [{ etiket: '<i>', tutar: 1 }] }).includes('&lt;b&gt;x&lt;/b&gt; Sipariş İskontosu'));
  assert.ok(F.ozetBlogu(null).includes('NET ÖDENECEK TUTAR'));
  assert.ok(F.ozetBlogu({ ekSatirlar: 'x', kdv: 5 }).includes('NET ÖDENECEK TUTAR'));
});
test('fisOzeti: liste − bayi = iskontolu ara; KDV "üstüne" bayrağı yalnızca net ≈ (ara − ödeme) + KDV iken', () => {
  const f = F.normalle(hamKaynak(), BAGLAM);
  const o = F.fisOzeti(f);

  assert.equal(o.liste, 2152);
  assert.equal(o.bayiTutar, 215.2);
  assert.equal(o.iskontoluAra, 1936.8);
  assert.equal(o.odemeAdi, 'Nakit');
  assert.equal(o.odemeTutar, 96.84);
  assert.equal(o.net, 1839.96);
  assert.equal(o.kdv.bilinmiyor, true, 'bu kaynakta KDV künyesi yok');
  assert.equal(o.kdv.ustune, false);
  assert.deepEqual(o.ekSatirlar, []);
  assert.ok(!F.html(f).includes('class="dipnot"'), 'KDV bilinmiyorsa dipnot yok');

  /* WooCommerce vergi motoru: satır KDV'si var ve toplam = satırlar + KDV */
  const vergili = F.normalle({
    id: 1, number: '1', total: 120, items: [{ name: 'A', quantity: 1, unit_price: 100, total: 100, vat_rate: 20, vat_amount: 20 }]
  }, {});
  const ov = F.fisOzeti(vergili);
  assert.equal(ov.kdv.ustune, true, 'net 120 = 100 + 20 → KDV toplama eklenmiş');
  assert.ok(F.html(vergili).includes('<div class="dipnot">KDV (%20) tutara eklenmiştir; NET ÖDENECEK TUTAR KDV dâhildir.</div>'));

  /* KDV dâhil sistem: total = satırlar */
  const dahil = F.normalle({
    id: 2, number: '2', total: 100, items: [{ name: 'A', quantity: 1, unit_price: 100, total: 100, vat_rate: 20, vat_amount: 16.67 }]
  }, {});
  assert.equal(F.fisOzeti(dahil).kdv.ustune, false);
  assert.ok(F.html(dahil).includes('<div class="dipnot">Fiyatlara KDV dâhildir.'));

  /* Kaynak nesne de kabul edilir (fisEmin) */
  assert.equal(F.fisOzeti(hamKaynak()).liste, 2152);
});
test('pencere: sade araç çubuğu (Yazdır · PDF · WhatsApp · Kapat) + SAYFALAYICI + IPC betiği; telefon yoksa WhatsApp devre dışı; html() SAF kalır', () => {
  const fis = F.normalle(yoneticiKaynak(), BAGLAM);
  const p = F.pencere(fis);

  assert.ok(p.includes('<div class="arac yazdirma-yok">'));
  ['btnYazdir', 'btnPdf', 'btnWa', 'btnKapat'].forEach((id) => assert.ok(p.includes('id="' + id + '"'), id));
  /* Resmî görünüm: düğmelerde emoji YOK, yalın büyük harf etiketler. */
  assert.ok(p.includes('type="button">YAZDIR</button>') && p.includes('type="button">PDF OLARAK KAYDET</button>') &&
            p.includes(">WHATSAPP'TAN GÖNDER</button>") && p.includes('type="button">KAPAT</button>'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(p.slice(p.indexOf('<div class="arac'), p.indexOf('<div class="belge'))), 'araç çubuğunda emoji yok');
  assert.ok(p.includes('ipc.invoke("fis:yazdir")') && p.includes('ipc.invoke("fis:pdf"') && p.includes('ipc.invoke("fis:whatsapp"') && p.includes('ipc.invoke("fis:kapat")'));
  assert.ok(p.includes('@media print { .yazdirma-yok { display:none !important; } }'), 'çubuk kâğıda yansımaz');
  assert.ok(p.includes('"tel":"905324152278"'), 'telefon wa.me biçiminde gömülü');
  assert.ok(p.includes('"dosyaAdi":"Siparis-Fisi-6448"'));
  assert.ok(p.includes('Sipariş Fişi #6448 · 2 kalem · Acme Hırdavat'), 'çubuk başlığı');
  assert.ok(p.includes('Ctrl+V ile yapıştırıp gönderin'), 'kullanıcıya dürüst yönerge: görsel PANODADIR');
  assert.ok(!p.includes('<button class="b-wa" id="btnWa" type="button" disabled'), 'telefon varken düğme açık');
  assert.ok(p.includes('<table class="toplamlar">'), 'belge gövdesi aynen içeride');

  /* SAYFALAYICI: pencerede ölçer, sayfalaraBol AYNI fonksiyondur (toString), araç betiğinden ÖNCE gelir */
  const sb = p.indexOf('var sayfalaraBol = function sayfalaraBol(');
  assert.ok(sb > 0, 'sayfalaraBol gömülü');
  assert.ok(sb < p.indexOf('require("electron")'), 'sayfalayıcı, IPC betiğinden önce');
  const betik = F.sayfalayiciBetigi();
  ['.belge-bas', '.belge-devam', 'table.kalemler', '.kapanis', '.sayfa-alt', 'data-icerik-mm', 'offsetHeight', 'document.fonts', 'replaceChild', 'sayfa-toplam', 'cloneNode(true)']
    .forEach((iz) => assert.ok(betik.includes(iz), 'sayfalayıcı: ' + iz));
  assert.ok(!betik.includes('require('), 'sayfalayıcı IPC/require kullanmaz');
  assert.ok(betik.includes('"termal" === belge.getAttribute("data-kagit")) return;'), 'termalde sayfalama yok');

  /* Telefonsuz müşteri: düğme devre dışı ve sebebi yazılı */
  const telsiz = F.pencere(F.normalle({ numara: '3', tutar: 1, musteri: 'X', kalemler: [] }, {}));
  assert.ok(telsiz.includes('id="btnWa" type="button" disabled title="Müşterinin kayıtlı telefon numarası yok"'));

  /* Gömülü JSON "<" kaçışlı — ürün adındaki "</script>" belgeyi kapatamaz */
  const kotu = F.pencere(F.normalle({ numara: '4</script><b>', tutar: 1, telefon: '05321112233', kalemler: [{ ad: '</script>', adet: 1, tutar: 1 }] }, {}));
  const ipcBetik = kotu.slice(kotu.indexOf('var ipc = require'));
  assert.ok(!ipcBetik.includes('</script><b>'), 'JSON içinde ham </script yok');
  assert.ok(ipcBetik.includes('\\u003c'));

  /* html() etkileşim ve betik içermez */
  const saf = F.html(fis);
  assert.ok(!saf.includes('<script') && !saf.includes('<button') && !saf.includes('class="arac'));

  /* aracCubugu tek başına: depo fişi de kullanır */
  const ac = F.aracCubugu({ baslik: 'Depo Fişi #9', dosyaAdi: 'Depo-Fisi-9', whatsapp: { tel: '0532 415 22 78', metin: 'x' } });
  assert.equal(ac.tel, '905324152278');
  assert.ok(ac.govde.includes('Depo Fişi #9') && ac.betik.includes('"dosyaAdi":"Depo-Fisi-9"') && ac.stil.includes('.b-wa'));
});
test('whatsappMetni Faz 14: iskonto varken "İskontolu Ara Toplam" satırı, altı satır fişle aynı sözcükler', () => {
  const s = F.whatsappMetni(F.normalle(hamKaynak(), BAGLAM)).split('\n');

  assert.ok(s.includes('*Liste Fiyatı Ara Toplamı:* 2.152,00 TL'));
  assert.ok(s.includes('*Bayi İskonto Tutarı (%10):* −215,20 TL'));
  assert.ok(s.includes('*İskontolu Ara Toplam:* 1.936,80 TL'), 'iki iskonto arasında köprü satırı');
  assert.ok(s.includes('*Nakit Sipariş İskontosu (%5):* −96,84 TL'));
  assert.ok(s.includes('*NET ÖDENECEK TUTAR: 1.839,96 TL*'));

  /* İskontosuz siparişte "—" satırları WhatsApp'a girmez (karakter bütçesi) */
  const sade = F.whatsappMetni(F.normalle({ numara: '5', tutar: 100, kalemler: [{ ad: 'A', adet: 1, tutar: 100 }] }, {}));
  assert.ok(!sade.includes('İskontolu Ara Toplam') && !sade.includes('İskonto Tutarı') && !sade.includes('Sipariş İskontosu'), 'boş iskonto satırları WhatsApp\x27a girmez');
});
