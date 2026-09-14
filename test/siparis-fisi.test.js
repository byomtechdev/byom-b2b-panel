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
  'net', 'odeme', 'not'
].sort();

const KALEM_ANAHTARLARI = ['ad', 'sku', 'adet', 'koli', 'koliIci', 'birim', 'tutar'].sort();

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
  assert.deepEqual(f.kalemler[0], { ad: 'Silikon 280 ml', sku: '', adet: 48, koli: 2, koliIci: 24, birim: 42.75, tutar: 2052 });
  assert.deepEqual(f.kalemler[1], { ad: 'Çivi', sku: '', adet: 40, koli: 0, koliIci: 0, birim: 2.5, tutar: 100 });
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
  assert.deepEqual(f.kalemler[0], { ad: 'Silikon 280 ml', sku: 'SLK-280', adet: 48, koli: 2, koliIci: 24, birim: 42.75, tutar: 2052 });
  assert.deepEqual(f.kalemler[1], { ad: 'Çivi', sku: 'CV-1', adet: 40, koli: 0, koliIci: 1, birim: 2.5, tutar: 100 });
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

  assert.ok(h.includes('Ara toplam</td><td class="deger sayi">2.152,00 TL'));
  assert.ok(h.includes('Bayi iskontosu (%10)</td><td class="deger sayi">&minus;215,20 TL'));
  assert.ok(h.includes('Ödeme iskontosu (%5)</td><td class="deger sayi">&minus;96,84 TL'));
  assert.ok(h.includes('<tr class="net"><td class="etiket">NET ÖDENECEK</td><td class="deger sayi">1.839,96 TL'));
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

  /* kalem tablosu: Ürün · SKU · Koli×Adet · Birim · Tutar */
  assert.ok(h.includes('<th>Ürün</th><th>SKU</th><th class="sayi">Koli × Adet</th><th class="sayi">Birim</th><th class="sayi">Tutar</th>'));
  assert.ok(h.includes('<td class="s-adet sayi">2 koli × 24 = 48</td><td class="s-birim sayi">42,75 TL</td><td class="s-tutar sayi">2.052,00 TL</td>'));
  assert.ok(h.includes('<td class="s-ad">Çivi</td><td class="s-sku">—</td><td class="s-adet sayi">40</td>'));

  /* not kutusu */
  assert.ok(h.includes('<section class="not"><h3>Sipariş Notu</h3>Kapıya bırakın</section>'));
  assert.ok(h.includes('<title>Sipariş Fişi #6448</title>'));
});

test('html iskonto satırı yalnızca varsa; logo yalnızca güvenli şemayla; harici kaynak yok', () => {
  const sade = F.normalle({ numara: '5', tutar: 100, kalemler: [{ ad: 'A', adet: 1, tutar: 100 }] }, { firmaAdi: 'X' });
  const h1 = F.html(sade);

  assert.ok(!h1.includes('Bayi iskontosu'));
  assert.ok(!h1.includes('Ödeme iskontosu'));
  assert.ok(h1.includes('NET ÖDENECEK'));
  assert.ok(!h1.includes('<img'), 'logo yoksa img yok');
  assert.ok(!h1.includes('class="not"'), 'not yoksa kutu yok');
  assert.ok(!/<link|<script|https?:\/\//i.test(h1), 'harici CSS/JS/CDN yok');

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
  assert.ok(satirlar.includes('*Ara toplam:* 2.152,00 TL'));
  assert.ok(satirlar.includes('*Bayi iskontosu (%10):* −215,20 TL'));
  assert.ok(satirlar.includes('*Ödeme iskontosu (%5):* −96,84 TL'));
  assert.ok(satirlar.includes('*NET ÖDENECEK: 1.839,96 TL*'));
  assert.ok(satirlar.includes('_Plasiyer: Ahmet_'));
  assert.ok(satirlar.includes('*Not:* Kapıya bırakın'));
  assert.ok(m.indexOf('*Ara toplam:*') > m.indexOf('• Çivi'), 'toplamlar kalemlerden sonra');
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
  assert.ok(m.includes('*NET ÖDENECEK: 999,00 TL*'));
  assert.ok(m.includes('kalem daha'));
  assert.ok((m.match(/^• /gm) || []).length < 20, 'kalem sayısı sınır için düşürüldü');

  /* kalemsiz ama dev notlu: not kırpılır, NET kalır */
  const devNot = F.whatsappMetni(F.normalle({ numara: '9', tutar: 1, notlar: 'n'.repeat(5000) }, {}));
  assert.ok(devNot.length <= F.WA_EN_COK_KARAKTER);
  assert.ok(devNot.includes('*NET ÖDENECEK: 1,00 TL*'));
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

test('dışa verme: altı işlev + kacis + sabitler; window yokken module.exports', () => {
  ['normalle', 'html', 'whatsappMetni', 'waTelefon', 'waAdresi', 'paraYaz', 'kacis'].forEach((ad) => {
    assert.equal(typeof F[ad], 'function', ad);
  });
  assert.equal(F.PARA_BIRIMI, 'TL');
  assert.equal(F.WA_EN_COK_KALEM, 20);
  assert.equal(F.WA_EN_COK_KARAKTER, 1800);
  assert.equal(F.ALT_YAZI, 'BYOM B2B · Bu fiş bilgi amaçlıdır, fatura yerine geçmez.');
  assert.equal(F.kacis('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');

  /* Kaynak denetimi: çift modlu dışa verme satırları birebir duruyor. */
  const fs = require('node:fs');
  const path = require('node:path');
  const kaynak = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'siparis-fisi.js'), 'utf8');
  assert.ok(kaynak.includes("if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = SiparisFisi;"));
  assert.ok(kaynak.includes("if (typeof window !== 'undefined') window.SiparisFisi = SiparisFisi;"));
  assert.ok(kaynak.includes("'use strict';"));
  assert.ok(!/document\.|window\.open|fetch\(|XMLHttpRequest|require\(/.test(kaynak), 'DOM / ağ / require yok');
});

/* ------------------------------------------------------------------ *
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
  assert.ok(h.includes('Ara toplam</td><td class="deger sayi">2.152,00 TL'));
  assert.ok(h.includes('Bayi iskontosu (%10)</td><td class="deger sayi">&minus;215,20 TL'));
  assert.ok(h.includes('Ödeme iskontosu (%5)</td><td class="deger sayi">&minus;96,84 TL'));
  assert.ok(h.includes('<tr class="net"><td class="etiket">NET ÖDENECEK</td><td class="deger sayi">1.839,96 TL'));

  /* whatsappMetni: aynı döküm, aynı sıra — iki kanal ayrışamaz */
  const satirlar = F.whatsappMetni(f).split('\n');
  assert.ok(satirlar.includes('*Ara toplam:* 2.152,00 TL'));
  assert.ok(satirlar.includes('*Bayi iskontosu (%10):* −215,20 TL'));
  assert.ok(satirlar.includes('*Ödeme iskontosu (%5):* −96,84 TL'));
  assert.ok(satirlar.includes('*NET ÖDENECEK: 1.839,96 TL*'));
  assert.ok(satirlar.indexOf('*NET ÖDENECEK: 1.839,96 TL*') > satirlar.indexOf('*Ara toplam:* 2.152,00 TL'));
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
