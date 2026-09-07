/* ============================================================================
 *  B2B YÖNETİM PANELİ  —  Arayüz Mantığı (renderer.js)
 *  ---------------------------------------------------------------------------
 *  · Demo Modu : internet/API olmadan gerçekçi örnek verilerle çalışır.
 *  · Canlı Mod : ana sürece IPC ile istek göndererek iki REST alanını kullanır:
 *        wc-b2b/v1  → b2b-core eklentisi (bayiler, B2B siparişleri, medya, ürün)
 *        wc/v3      → WooCommerce çekirdek (fiyat/stok güncelleme, kategoriler)
 *    Eklenti kurulu değilse uygulama otomatik olarak wc/v3 yedek yoluna düşer.
 * ==========================================================================*/

const { ipcRenderer } = require('electron');

/* ==========================================================================
 *  BÖLÜM 1 — YARDIMCI FONKSİYONLAR
 * ========================================================================*/

const $ = (secici) => document.querySelector(secici);
const $$ = (secici) => Array.prototype.slice.call(document.querySelectorAll(secici));

/** HTML'e gömülecek her metni güvenli hale getirir (siteden gelen veriye güvenilmez). */
function kacis(metin) {
  return String(metin === null || metin === undefined ? '' : metin).replace(/[&<>"']/g, function (k) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k];
  });
}

/* --------------------------------------------------------------------------
 *  PARA BİÇİMİ — Türk muhasebe standardı:  1.234,56 ₺   (simge SAĞDA)
 *  --------------------------------------------------------------------------
 *  Neden Intl.NumberFormat KULLANILMIYOR: Electron paketi küçük ICU ile
 *  gelebiliyor ve 'tr-TR' yerel verisi bulunamadığında sessizce 'en-US'a
 *  düşüyordu. Sonuç, kullanıcının ekranında "₺10.00" (simge SOLDA, nokta
 *  ayraçlı) biçimiydi — fatura ve depo fişinde kabul edilemez.
 *
 *  Biçim artık yerel veriden BAĞIMSIZ, elle kurulur:
 *    · binlik ayracı  "."   · kuruş ayracı ","   · simge sonda, ince boşlukla
 *  Böylece hangi makinede, hangi ICU derlemesiyle çalışırsa çalışsın
 *  fiş ile ekran birebir aynı sayıyı gösterir.
 * ------------------------------------------------------------------------*/
const PARA_SIMGESI = '₺';

/** 1234.5 -> "1.234,50" (simgesiz; tablo hücreleri ve fiş sütunları için). */
function paraSade(deger) {
  let n = Number(deger);
  if (!isFinite(n)) n = 0;

  /* toFixed(2) yuvarlamayı kuruşta bitirir; sonrasında yalnızca metin işlenir,
     böylece kayan nokta artığı (0.1+0.2) hiçbir toplamda görünmez. */
  const ham = Math.abs(n).toFixed(2);

  /* İşaret YUVARLAMADAN SONRA belirlenir: -0 ve -0.004 gibi değerler kuruşta
     sıfıra indiği için "-0,00 ₺" yazılmaz (fişte hatalı iade gibi okunurdu). */
  const eksiMi = n < 0 && Number(ham) !== 0;
  const nokta = ham.indexOf('.');
  const tam = ham.slice(0, nokta);
  const kurus = ham.slice(nokta + 1);

  /* Binlik ayracı: sağdan üçerli. Regex yerine döngü — çok uzun tutarlarda da
     (milyarlık cari toplamlar) tek geçişte ve öngörülebilir çalışır. */
  let gruplu = '';
  for (let i = 0; i < tam.length; i++) {
    if (i > 0 && (tam.length - i) % 3 === 0) gruplu += '.';
    gruplu += tam[i];
  }

  return (eksiMi ? '-' : '') + gruplu + ',' + kurus;
}

/** 1234.5 -> "1.234,50 ₺" — kullanıcıya gösterilen TEK para biçimi. */
function para(deger) {
  return paraSade(deger) + ' ' + PARA_SIMGESI;
}

/** "1.234,56" / "1234.56" / "1234,56" gibi her yazımı sayıya çevirir. */
function sayiCoz(metin) {
  if (metin === null || metin === undefined) return NaN;
  let s = String(metin).trim().replace(/\s/g, '').replace(/₺|TL/gi, '');
  if (s === '') return NaN;
  if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

/** Sayıyı kutuda gösterilecek Türkçe yazıma çevirir: 1234.5 -> "1234,50" */
function fiyatYazi(deger) {
  const n = Number(deger);
  return (isFinite(n) ? n : 0).toFixed(2).replace('.', ',');
}

function tarihYaz(ham, saatliMi) {
  if (!ham) return '—';
  const t = new Date(ham);
  if (isNaN(t.getTime())) return String(ham);
  const secenek = saatliMi
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  return new Intl.DateTimeFormat('tr-TR', secenek).format(t);
}

/** Sadece saat:dakika:saniye (üst çubuktaki "son kontrol" bilgisi için). */
function saatYaz(t) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(t || new Date());
}

function bekle(ms) {
  return new Promise(function (c) { setTimeout(c, ms); });
}

/**
 * İnternet gerekmeyen yer tutucu ürün görseli üretir.
 * Renkli emoji yerine tek renkli bir koli çizimi basar: kurumsal arayüzde
 * ürün listesi, emoji kalabalığı yerine sakin bir gri yüzeyle açılır.
 */
function svgGorsel() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">' +
    '<rect width="160" height="160" rx="8" fill="#f1f5f9"/>' +
    '<g fill="none" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M118 58 80 80 42 58"/><path d="M80 80v46"/>' +
    '<path d="M120 104V56a7 7 0 0 0-3.6-6.1l-33-18.3a7 7 0 0 0-6.8 0l-33 18.3A7 7 0 0 0 40 56v48a7 7 0 0 0 3.6 6.1l33 18.3a7 7 0 0 0 6.8 0l33-18.3A7 7 0 0 0 120 104Z"/>' +
    '</g></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const YEDEK_GORSEL = svgGorsel();

/** Sağ altta büyük puntolu bildirim gösterir. */
function bildir(mesaj, tur) {
  const renkler = {
    basari: 'bg-emerald-600 border-emerald-700',
    hata: 'bg-red-600 border-red-700',
    uyari: 'bg-amber-500 border-amber-600',
    bilgi: 'bg-slate-800 border-slate-900'
  };
  const simgeler = { basari: ikon('onay'), hata: ikon('carpi'), uyari: ikon('uyari'), bilgi: ikon('bilgi') };
  const t = tur || 'bilgi';

  const kutu = document.createElement('div');
  kutu.className =
    'bildirim-giris pointer-events-auto max-w-lg rounded-2xl border-2 shadow-2xl px-6 py-5 ' +
    'text-white text-lg font-bold whitespace-pre-line ' + (renkler[t] || renkler.bilgi);
  kutu.innerHTML = '<span class="bildirim-ikon">' + simgeler[t] + '</span>' + kacis(mesaj);
  $('#bildirimAlani').appendChild(kutu);

  const sure = t === 'hata' ? 8000 : 3800;
  setTimeout(function () {
    kutu.style.transition = 'opacity .3s, transform .3s';
    kutu.style.opacity = '0';
    kutu.style.transform = 'translateX(40px)';
    setTimeout(function () { kutu.remove(); }, 320);
  }, sure);
}

/** Büyük butonlu onay penceresi. Promise<boolean> döner. */
function onayla(baslik, mesaj, tamamMetni, tehlikeliMi) {
  return new Promise(function (cozumle) {
    const katman = $('#modalKatman');
    const tamamBtn = $('#modalTamam');
    const vazgecBtn = $('#modalVazgec');

    $('#modalBaslik').textContent = baslik;
    $('#modalMesaj').textContent = mesaj;
    tamamBtn.textContent = tamamMetni || 'EVET';
    tamamBtn.className =
      'flex-1 h-16 rounded-2xl text-xl font-extrabold text-white transition active:scale-95 ' +
      (tehlikeliMi ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700');

    katman.classList.remove('hidden');
    tamamBtn.focus();

    function kapat(sonuc) {
      katman.classList.add('hidden');
      tamamBtn.removeEventListener('click', evet);
      vazgecBtn.removeEventListener('click', hayir);
      katman.removeEventListener('mousedown', disariTikla);
      document.removeEventListener('keydown', tusla);
      cozumle(sonuc);
    }
    function evet() { kapat(true); }
    function hayir() { kapat(false); }
    function disariTikla(o) { if (o.target === katman) kapat(false); }
    function tusla(o) { if (o.key === 'Escape') kapat(false); }

    tamamBtn.addEventListener('click', evet);
    vazgecBtn.addEventListener('click', hayir);
    katman.addEventListener('mousedown', disariTikla);
    document.addEventListener('keydown', tusla);
  });
}

/**
 * Serbest metin soran pencere (ör. bayi red sebebi).
 * Promise<string|null> döner — VAZGEÇ'te null.
 */
function metinSor(baslik, mesaj, varsayilan, tamamMetni) {
  return new Promise(function (cozumle) {
    const katman = $('#metinModalKatman');
    const girdi = $('#metinModalGirdi');
    const tamamBtn = $('#metinModalTamam');
    const vazgecBtn = $('#metinModalVazgec');

    $('#metinModalBaslik').textContent = baslik;
    $('#metinModalMesaj').textContent = mesaj || '';
    girdi.value = varsayilan || '';
    tamamBtn.textContent = tamamMetni || 'DEVAM ET';

    katman.classList.remove('hidden');
    setTimeout(function () { girdi.focus(); }, 30);

    function kapat(sonuc) {
      katman.classList.add('hidden');
      tamamBtn.removeEventListener('click', evet);
      vazgecBtn.removeEventListener('click', hayir);
      katman.removeEventListener('mousedown', disariTikla);
      document.removeEventListener('keydown', tusla);
      cozumle(sonuc);
    }
    function evet() { kapat(girdi.value.trim()); }
    function hayir() { kapat(null); }
    function disariTikla(o) { if (o.target === katman) kapat(null); }
    function tusla(o) {
      if (o.key === 'Escape') kapat(null);
      /* Ctrl+Enter (Windows) — ⌘+Enter (macOS) */
      if (o.key === 'Enter' && (o.ctrlKey || o.metaKey)) kapat(girdi.value.trim());
    }

    tamamBtn.addEventListener('click', evet);
    vazgecBtn.addEventListener('click', hayir);
    katman.addEventListener('mousedown', disariTikla);
    document.addEventListener('keydown', tusla);
  });
}

/**
 * Sipariş durumu penceresi: kargo firması, takip no, not ve e-posta tercihi sorar.
 * secenek = { baslik, aciklama, kargoGoster, onayMetni, bildir }
 * Promise<{carrier, tracking, note, notify}|null> döner.
 */
function durumPenceresi(secenek) {
  secenek = secenek || {};
  return new Promise(function (cozumle) {
    const katman = $('#kargoModalKatman');
    const onayBtn = $('#kargoOnay');
    const vazgecBtn = $('#kargoVazgec');
    const alanlar = $('#kargoAlanlar');
    const uyari = $('#kargoUyari');

    $('#kargoModalBaslik').textContent = secenek.baslik || 'Durumu Güncelle';
    $('#kargoModalAciklama').textContent = secenek.aciklama || '';
    onayBtn.textContent = secenek.onayMetni || 'DURUMU GÜNCELLE';

    $('#kargoFirma').value = secenek.carrier || '';
    $('#kargoTakip').value = secenek.tracking || '';
    $('#kargoAmbar').value = secenek.shipmentNote || '';
    $('#kargoNot').value = '';
    $('#kargoBildir').checked = secenek.bildir !== false;

    alanlar.classList.toggle('hidden', !secenek.kargoGoster);

    /* Serbest sevkiyat kutusu da yalnizca sevkiyat adimlarinda gorunur:
       "Teslim Edildi" adiminda ambar adi sormak anlamsizdi. */
    const ambarSatiri = $('#kargoAmbarSatiri');
    if (ambarSatiri) ambarSatiri.classList.toggle('hidden', !secenek.kargoGoster);
    uyari.classList.add('hidden');

    katman.classList.remove('hidden');
    setTimeout(function () {
      (secenek.kargoGoster ? $('#kargoFirma') : onayBtn).focus();
    }, 30);

    function kapat(sonuc) {
      katman.classList.add('hidden');
      onayBtn.removeEventListener('click', evet);
      vazgecBtn.removeEventListener('click', hayir);
      katman.removeEventListener('mousedown', disariTikla);
      document.removeEventListener('keydown', tusla);
      cozumle(sonuc);
    }
    function evet() {
      kapat({
        carrier: $('#kargoFirma').value.trim(),
        tracking: $('#kargoTakip').value.trim(),
        /* Serbest sevkiyat metni; kargo alanlari bos olsa da tek basina
           gonderilebilir (ambara teslim akisi). */
        shipmentNote: $('#kargoAmbar').value.trim(),
        note: $('#kargoNot').value.trim(),
        notify: !!$('#kargoBildir').checked
      });
    }
    function hayir() { kapat(null); }
    function disariTikla(o) { if (o.target === katman) kapat(null); }
    function tusla(o) { if (o.key === 'Escape') kapat(null); }

    onayBtn.addEventListener('click', evet);
    vazgecBtn.addEventListener('click', hayir);
    katman.addEventListener('mousedown', disariTikla);
    document.addEventListener('keydown', tusla);
  });
}

/** Liste alanlarında "yükleniyor" görünümü. */
function yukleniyorHtml(mesaj) {
  return (
    '<div class="bg-white dark:bg-slate-800 rounded-2xl p-10 border-2 border-slate-200 dark:border-slate-700 ' +
    'text-center text-xl font-bold text-slate-500 dark:text-slate-400">' +
    '<span class="donuyor mr-2">' + ikon('donen') + '</span>' + kacis(mesaj || 'Yükleniyor…') +
    '</div>'
  );
}

/** Liste boşsa gösterilecek dostane kutu. */
function bosHtml(simge, baslik, aciklama) {
  return (
    '<div class="bg-white dark:bg-slate-800 rounded-2xl p-12 border-2 border-dashed border-slate-300 ' +
    'dark:border-slate-600 text-center">' +
    '<div class="text-6xl mb-4">' + simge + '</div>' +
    '<div class="text-2xl font-black mb-2">' + kacis(baslik) + '</div>' +
    '<div class="text-lg text-slate-500 dark:text-slate-400 leading-relaxed whitespace-pre-line">' +
    kacis(aciklama || '') + '</div></div>'
  );
}

/** Butonu "çalışıyor" durumuna alır; geri almak için çağrılabilir fonksiyon döner. */
function butonuMesgulEt(buton, mesaj) {
  const eskiMetin = buton.innerHTML;
  const eskiSinif = buton.className;
  buton.disabled = true;
  buton.innerHTML = '<span class="donuyor">' + ikon('donen') + '</span> ' + (mesaj || 'İŞLENİYOR…');
  return function () {
    buton.disabled = false;
    buton.innerHTML = eskiMetin;
    buton.className = eskiSinif;
  };
}

/* ==========================================================================
 *  BÖLÜM 2 — DEMO VERİLERİ (sunum için gerçekçi hırdavat / toptan verisi)
 * ========================================================================*/

/* Demo kataloğu: JENERİK ürünler. Tescilli marka adı BİLEREK kullanılmaz —
   ekosistem her firmaya sıfırdan kurulabilen temiz bir şablondur ve kutudan
   çıkan veride başka şirketlerin markaları bulunmamalıdır. */
const DEMO_URUNLER = [
  { id: 901, ad: 'Darbeli Matkap 600W (13 mm Mandren)',        kod: 'MTK-600-13',     fiyat: 2450.00, stok: 42,  durum: 'publish', gorsel: svgGorsel() },
  { id: 902, ad: 'Darbeli Matkap 710W Profesyonel',            kod: 'MTK-710-PRO',    fiyat: 2890.00, stok: 18,  durum: 'publish', gorsel: svgGorsel() },
  { id: 903, ad: 'Kargaburun Pense 180 mm',                    kod: 'PNS-KRG180',     fiyat: 385.50,  stok: 156, durum: 'publish', gorsel: svgGorsel() },
  { id: 904, ad: 'Şerit Metre 5 m x 25 mm',                    kod: 'MTR-5X25',       fiyat: 289.90,  stok: 240, durum: 'publish', gorsel: svgGorsel() },
  { id: 905, ad: 'Çelik Vida 4x40 mm (1000 Adet Kutu)',        kod: 'VDA-4X40-1000',  fiyat: 720.00,  stok: 85,  durum: 'publish', gorsel: svgGorsel() },
  { id: 906, ad: 'Plastik Dübel 8 mm (500 Adet Poşet)',        kod: 'DBL-8-500',      fiyat: 195.00,  stok: 320, durum: 'publish', gorsel: svgGorsel() },
  { id: 907, ad: 'Şeffaf Silikon 310 ml',                      kod: 'SLK-310-SFF',    fiyat: 118.75,  stok: 480, durum: 'publish', gorsel: svgGorsel() },
  { id: 908, ad: 'Profesyonel Silikon Tabancası',              kod: 'SLK-TBC-PRO',    fiyat: 265.00,  stok: 64,  durum: 'publish', gorsel: svgGorsel() },
  { id: 909, ad: 'Çelik Kapı Kilidi 3 Anahtarlı',              kod: 'KLT-CK3',        fiyat: 1150.00, stok: 27,  durum: 'publish', gorsel: svgGorsel() },
  { id: 910, ad: 'NYA Elektrik Kablosu 2.5 mm (100 m Makara)', kod: 'KBL-NYA25-100',  fiyat: 3240.00, stok: 12,  durum: 'publish', gorsel: svgGorsel() },
  { id: 911, ad: 'LED Ampul E27 12W Beyaz (10\'lu Paket)',      kod: 'LED-E27-12-10',  fiyat: 340.00,  stok: 190, durum: 'publish', gorsel: svgGorsel() },
  { id: 912, ad: 'Tork Anahtarı Seti 8 Parça 1/2"',            kod: 'TRK-SET8',       fiyat: 1875.00, stok: 9,   durum: 'publish', gorsel: svgGorsel() },
  { id: 913, ad: 'Alüminyum Merdiven 8 Basamaklı',             kod: 'MRD-ALM8',       fiyat: 2130.00, stok: 15,  durum: 'publish', gorsel: svgGorsel() },
  { id: 914, ad: 'İş Eldiveni Nitril Kaplı (12 Çift)',         kod: 'ELD-NTR-12',     fiyat: 410.00,  stok: 275, durum: 'publish', gorsel: svgGorsel() },
  { id: 915, ad: 'Bahçe Hortumu 20 m',                         kod: 'BHC-HRT20',      fiyat: 890.00,  stok: 0,   durum: 'draft',   gorsel: svgGorsel() }
];

/* Demo kalemlerine benzersiz kimlik verir. Gerçek siparişlerde bu değer
   WooCommerce'in sipariş kalemi ID'sidir ve revize penceresi satırı onunla
   bulur; demo verisinde de bulunmazsa pencere hiç açılmaz. */
let demoKalemSayaci = 5000;

/** Demo kalemlerini kısa yazmak için: stok kodundan sipariş kalemi üretir. */
function demoKalem(kod, adet) {
  const u = DEMO_URUNLER.filter(function (x) { return x.kod === kod; })[0] || {};
  const birim = Number(u.fiyat || 0);
  const tutar = Math.round(birim * adet * 100) / 100;
  return {
    kalemId: ++demoKalemSayaci,
    urunId: Number(u.id || 0),
    ad: u.ad || kod,
    kod: kod,
    adet: adet,
    birim: birim,
    tutar: tutar,
    araToplam: tutar,
    gorsel: u.gorsel || YEDEK_GORSEL
  };
}

const DEMO_SIPARISLER = [
  {
    id: 10248, numara: '10248', aliciTipi: 'corporate', odemeTipi: 'cash', bayiId: 506, musteri: 'Ahmet Yılmaz', firma: 'Yılmaz Hırdavat Ltd. Şti.',
    telefon: '0532 415 22 78', adres: 'Karaköy Mah. Tersane Cad. No:14/A, Beyoğlu / İSTANBUL',
    tarih: '2026-08-05T09:12:00', durum: 'b2b-received', kargo: '', takip: '',
    notlar: 'Kargoya vermeden önce lütfen arayın, elden teslim alacağız.',
    kalemler: [
      demoKalem('MTK-600-13', 4), demoKalem('VDA-4X40-1000', 6),
      demoKalem('DBL-8-500', 10), demoKalem('PNS-KRG180', 7)
    ]
  },
  {
    id: 10247, numara: '10247', aliciTipi: 'corporate', odemeTipi: 'card', provizyon: 'PRV-8842-119037', bayiId: 507, musteri: 'Fatma Demir', firma: 'Demir Yapı Market',
    telefon: '0555 908 61 30', adres: 'Cumhuriyet Mah. 1512 Sok. No:3, Bornova / İZMİR',
    tarih: '2026-08-04T16:40:00', durum: 'b2b-preparing', notlar: '', kargo: '', takip: '',
    kalemler: [demoKalem('KBL-NYA25-100', 2), demoKalem('LED-E27-12-10', 5), demoKalem('SLK-310-SFF', 12)]
  },
  {
    id: 10246, numara: '10246', aliciTipi: 'corporate', odemeTipi: 'term', bayiId: 508, musteri: 'Mustafa Kaya', firma: 'Kaya İnşaat Malzemeleri',
    telefon: '0542 771 04 96', adres: 'Ostim OSB 1234. Cad. No:57, Yenimahalle / ANKARA',
    tarih: '2026-08-04T11:05:00', durum: 'b2b-ready', kargo: '', takip: '',
    notlar: 'Fatura firma adına kesilecek. Vergi No: 7734009812',
    kalemler: [demoKalem('MRD-ALM8', 6), demoKalem('TRK-SET8', 4), demoKalem('ELD-NTR-12', 10)]
  },
  {
    id: 10245, numara: '10245', aliciTipi: 'corporate', odemeTipi: 'cash', bayiId: 509, musteri: 'Hüseyin Şahin', firma: 'Şahin Nalburiye',
    telefon: '0533 220 18 45', adres: 'Merkez Mah. Atatürk Bulvarı No:88, Şehitkamil / GAZİANTEP',
    tarih: '2026-08-03T14:22:00', durum: 'completed', notlar: '',
    kargo: 'Aras Kargo', takip: '7812340091223',
    /* Müşteri web sitesinden "Siparişimi Teslim Aldım" dedi */
    teslimDurum: 'delivered', teslimTarih: '2026-08-04T11:05:00',
    kalemler: [demoKalem('SLK-TBC-PRO', 8), demoKalem('SLK-310-SFF', 24), demoKalem('MTR-5X25', 2)]
  },
  {
    id: 10244, numara: '10244', aliciTipi: 'corporate', odemeTipi: 'card', provizyon: 'PRV-8842-118455', bayiId: 510, musteri: 'Zeynep Aydın', firma: 'Aydın Elektrik Toptan',
    telefon: '0544 662 37 12', adres: 'Sanayi Mah. 5. Sokak No:21, Nilüfer / BURSA',
    tarih: '2026-08-03T09:48:00', durum: 'b2b-received', kargo: '', takip: '',
    notlar: 'Ödeme havale ile yapılacak, dekont bekleniyor.',
    kalemler: [demoKalem('KBL-NYA25-100', 3), demoKalem('LED-E27-12-10', 6), demoKalem('KLT-CK3', 1)]
  },
  {
    id: 10243, numara: '10243', aliciTipi: 'corporate', odemeTipi: 'cash', bayiId: 506, musteri: 'Osman Çelik', firma: 'Yılmaz Hırdavat Ltd. Şti.',
    telefon: '0537 118 90 04', adres: 'Karaköy Mah. Tersane Cad. No:14/A, Beyoğlu / İSTANBUL',
    tarih: '2026-08-02T17:30:00', durum: 'b2b-shipped',
    notlar: 'Palet üstünde streçlenerek gönderilsin.',
    kargo: 'Yurtiçi Kargo', takip: '4471209983311',
    kalemler: [demoKalem('MTK-710-PRO', 2), demoKalem('ELD-NTR-12', 3), demoKalem('DBL-8-500', 2)]
  },
  {
    id: 10242, numara: '10242', aliciTipi: 'corporate', odemeTipi: 'term', bayiId: 507, musteri: 'Emine Koç', firma: 'Demir Yapı Market',
    telefon: '0546 300 55 71', adres: 'Cumhuriyet Mah. 1512 Sok. No:3, Bornova / İZMİR',
    tarih: '2026-08-02T10:15:00', durum: 'completed', notlar: '',
    kargo: 'MNG Kargo', takip: '9920014457781',
    /* Müşteri "Teslim Alınmadı / Sorun Var" dedi */
    teslimDurum: 'not_delivered', teslimTarih: '2026-08-03T09:20:00',
    kalemler: [demoKalem('PNS-KRG180', 4), demoKalem('MTR-5X25', 3), demoKalem('SLK-310-SFF', 6)]
  },
  {
    id: 10241, numara: '10241', aliciTipi: 'corporate', odemeTipi: 'card', provizyon: 'PRV-8842-117980', bayiId: 508, musteri: 'Kemal Arslan', firma: 'Kaya İnşaat Malzemeleri',
    telefon: '0532 007 44 19', adres: 'Ostim OSB 1234. Cad. No:57, Yenimahalle / ANKARA',
    tarih: '2026-08-01T13:02:00', durum: 'cancelled', kargo: '', takip: '',
    notlar: 'Müşteri sipariş iptali talep etti.',
    kalemler: [demoKalem('LED-E27-12-10', 4), demoKalem('DBL-8-500', 3)]
  },

  /* --- BİREYSEL MÜŞTERİ SİPARİŞLERİ ---
     Firma unvanı ve vergi künyesi YOKTUR; depo fişinde Ad-Soyad / T.C. Kimlik /
     Teslimat Adresi basılır ve kartta mavi [MÜŞTERİ] rozeti görünür. */
  {
    id: 10240, numara: '10240', aliciTipi: 'individual', odemeTipi: 'card', provizyon: 'PRV-8842-117204',
    bayiId: 0, musteri: 'Elif Tanrıkulu', firma: '', tcKimlik: '17845620394',
    telefon: '0533 471 66 08', adres: 'Bahçelievler Mah. Papatya Sok. No:7 D:4, Çankaya / ANKARA',
    tarih: '2026-08-05T13:55:00', durum: 'b2b-received', kargo: '', takip: '',
    notlar: 'Kapıda kimlik ibrazı ile teslim alınacak.',
    kalemler: [demoKalem('MTR-5X25', 1), demoKalem('PNS-KRG180', 2), demoKalem('LED-E27-12-10', 1)]
  },
  {
    id: 10239, numara: '10239', aliciTipi: 'individual', odemeTipi: 'cash',
    bayiId: 0, musteri: 'Ramazan Duran', firma: '', tcKimlik: '',
    telefon: '0505 902 13 77', adres: 'Yeşilyurt Mah. 4021 Sok. No:12, Karşıyaka / İZMİR',
    tarih: '2026-08-04T08:30:00', durum: 'b2b-shipped',
    notlar: '',
    kargo: 'Sürat Kargo', takip: '3391077452210',
    kalemler: [demoKalem('SLK-310-SFF', 2), demoKalem('SLK-TBC-PRO', 1)]
  }
];

/* Demo iskonto oranları — b2b-core eklentisinin varsayılanlarıyla aynı. */
const DEMO_ISKONTO_ORANLARI = { cash: 12, card: 8, term: 0 };

/* Sipariş toplamlarını kalemlerden hesapla ve seçilen sipariş türünün
   iskontosunu uygula — demo verisi kendi içinde tutarlı kalsın. */
DEMO_SIPARISLER.forEach(function (s) {
  const araToplam = Math.round(s.kalemler.reduce(function (t, k) { return t + k.tutar; }, 0) * 100) / 100;
  const oran = DEMO_ISKONTO_ORANLARI[s.odemeTipi] || 0;

  s.odemeIskonto = oran;
  s.odemeIskontoTutar = Math.round(araToplam * (oran / 100) * 100) / 100;
  s.tutar = Math.round((araToplam - s.odemeIskontoTutar) * 100) / 100;
});

const DEMO_UYELER = [
  /* --- Onay bekleyen kurumsal başvurular ---
     kaynak:'pending-users' → gerçek kurulumda bu kayıtlar /pending-users
     ucundan gelir ve onayları "approve-user" ucuna gider (bkz. uyeKarar).
     il / ilce alanları başvuru künyesindeki "İl / İlçe" satırını besler. */
  { id: 501, durum: 'pending', kaynak: 'pending-users', ad: 'Serkan Öztürk', firma: 'Öztürk Yapı Market San. Tic. Ltd. Şti.', vergiNo: '6540218793',
    vergiDairesi: 'Kadıköy', telefon: '0532 884 12 07', eposta: 'serkan@ozturkyapi.com.tr',
    il: 'İSTANBUL', ilce: 'Kadıköy',
    adres: 'Bostancı Mah. Ankara Cad. No:112, Kadıköy / İSTANBUL', tarih: '2026-08-05T08:20:00' },
  { id: 502, durum: 'pending', kaynak: 'pending-users', ad: 'Ayşe Korkmaz', firma: 'Korkmaz Nalburiye', vergiNo: '3320984561',
    vergiDairesi: 'Çankaya', telefon: '0555 210 76 33', eposta: 'ayse.korkmaz@gmail.com',
    il: 'ANKARA', ilce: 'Çankaya',
    adres: 'Kızılay Mah. 12. Sok. No:8, Çankaya / ANKARA', tarih: '2026-08-04T19:05:00' },
  { id: 503, durum: 'pending', kaynak: 'pending-users', ad: 'Bülent Yıldırım', firma: 'Yıldırım Elektrik Malzemeleri', vergiNo: '8871203954',
    vergiDairesi: 'Konak', telefon: '0542 619 08 24', eposta: 'info@yildirimelektrik.com',
    il: 'İZMİR', ilce: 'Konak',
    adres: 'Alsancak Mah. 1476 Sok. No:5, Konak / İZMİR', tarih: '2026-08-04T12:44:00' },
  { id: 504, durum: 'pending', kaynak: 'pending-users', ad: 'Hatice Polat', firma: 'Polat İnşaat Hırdavat', vergiNo: '1129873460',
    vergiDairesi: 'Osmangazi', telefon: '0537 452 91 66', eposta: 'polat.hirdavat@hotmail.com',
    il: 'BURSA', ilce: 'Osmangazi',
    adres: 'Demirtaş OSB 4. Cad. No:19, Osmangazi / BURSA', tarih: '2026-08-03T15:31:00' },
  { id: 505, durum: 'pending', kaynak: 'pending-users', ad: 'Murat Şen', firma: 'Şen Kardeşler Toptan Hırdavat', vergiNo: '4408125577',
    vergiDairesi: 'Seyhan', telefon: '0544 703 28 90', eposta: 'muratsen@senkardesler.com.tr',
    il: 'ADANA', ilce: 'Seyhan',
    adres: 'Yeni Sanayi Sitesi 7. Blok No:34, Seyhan / ADANA', tarih: '2026-08-02T10:09:00' },

  /* --- Onaylı bayiler (sipariş geçmişi ekranını denemek için) --- */
  { id: 506, durum: 'approved', ad: 'Ahmet Yılmaz', firma: 'Yılmaz Hırdavat Ltd. Şti.', vergiNo: '5510432198',
    vergiDairesi: 'Beyoğlu', telefon: '0532 415 22 78', eposta: 'ahmet@yilmazhirdavat.com',
    adres: 'Karaköy Mah. Tersane Cad. No:14/A, Beyoğlu / İSTANBUL',
    tarih: '2025-11-14T09:00:00', onayTarihi: '2025-11-15T10:12:00' },
  { id: 507, durum: 'approved', ad: 'Fatma Demir', firma: 'Demir Yapı Market', vergiNo: '2298110043',
    vergiDairesi: 'Bornova', telefon: '0555 908 61 30', eposta: 'fatma@demiryapi.com',
    adres: 'Cumhuriyet Mah. 1512 Sok. No:3, Bornova / İZMİR',
    tarih: '2025-12-02T14:20:00', onayTarihi: '2025-12-02T16:40:00' },
  { id: 508, durum: 'approved', ad: 'Mustafa Kaya', firma: 'Kaya İnşaat Malzemeleri', vergiNo: '7734009812',
    vergiDairesi: 'Yenimahalle', telefon: '0542 771 04 96', eposta: 'mustafa@kayainsaat.com.tr',
    adres: 'Ostim OSB 1234. Cad. No:57, Yenimahalle / ANKARA',
    tarih: '2026-01-19T11:05:00', onayTarihi: '2026-01-19T13:30:00' },
  { id: 509, durum: 'approved', ad: 'Hüseyin Şahin', firma: 'Şahin Nalburiye', vergiNo: '6612094433',
    vergiDairesi: 'Şehitkamil', telefon: '0533 220 18 45', eposta: 'huseyin@sahinnalburiye.com',
    adres: 'Merkez Mah. Atatürk Bulvarı No:88, Şehitkamil / GAZİANTEP',
    tarih: '2026-02-08T08:15:00', onayTarihi: '2026-02-08T09:00:00' },
  { id: 510, durum: 'approved', ad: 'Zeynep Aydın', firma: 'Aydın Elektrik Toptan', vergiNo: '3341778820',
    vergiDairesi: 'Nilüfer', telefon: '0544 662 37 12', eposta: 'zeynep@aydinelektrik.com',
    adres: 'Sanayi Mah. 5. Sokak No:21, Nilüfer / BURSA',
    tarih: '2026-03-22T17:44:00', onayTarihi: '2026-03-23T08:50:00' },

  /* --- Reddedilmiş / askıya alınmış örnekler --- */
  { id: 511, durum: 'rejected', ad: 'Levent Acar', firma: 'Acar Ticaret', vergiNo: '1000000001',
    vergiDairesi: '—', telefon: '0530 000 00 01', eposta: 'levent@acarticaret.com',
    adres: 'Merkez / ESKİŞEHİR', tarih: '2026-06-11T10:00:00',
    redSebebi: 'Vergi levhası ile firma unvanı eşleşmedi.' },
  { id: 512, durum: 'suspended', ad: 'Necati Doğan', firma: 'Doğan Yapı Malzeme', vergiNo: '1000000002',
    vergiDairesi: 'Selçuklu', telefon: '0530 000 00 02', eposta: 'necati@doganyapi.com',
    adres: 'Yeni Sanayi Sitesi 3. Blok No:12, Selçuklu / KONYA', tarih: '2026-04-05T12:00:00' }
];

/* Demo modunda kategori kutusunu doldurmak için örnek liste */
const DEMO_KATEGORILER = [
  { id: 15, ad: 'El Aletleri' },
  { id: 16, ad: 'Elektrikli El Aletleri' },
  { id: 17, ad: 'Bağlantı Elemanları (Vida - Dübel)' },
  { id: 18, ad: 'Elektrik Malzemeleri' },
  { id: 19, ad: 'Yapı Kimyasalları (Silikon - Yapıştırıcı)' },
  { id: 20, ad: 'İş Güvenliği Ürünleri' },
  { id: 21, ad: 'Merdiven ve Yükseltici' }
];

/* ==========================================================================
 *  BÖLÜM 3 — UYGULAMA DURUMU VE SABİTLER
 * ========================================================================*/

const durum = {
  ayarlar: null,
  bilgi: null,
  siteBilgisi: null,        // /wc-b2b/v1/ping yanıtı
  b2bVar: false,            // Sitede b2b-core eklentisi bulundu mu?
  siparisler: [],
  urunler: [],
  uyeler: [],
  yuklenenGorseller: [],    // Ürün ekleme penceresinde sürükle-bırak ile yüklenenler
  aktifSekme: 'siparisler',
  canliBaglantiTamam: false,
  urunAramaZaman: null,
  uyeAramaZaman: null,
  siparisSuzgec: '',
  /* Sipariş sekmesi: 'active' | 'shipped' | 'delivered'
     Her sekme sunucudan KENDİ durum kümesini çeker; sekme değişimi yeni bir
     istek demektir (yerel süzme değil), böylece "Teslim Edilenler" sekmesinde
     binlerce eski sipariş de sayfalanarak gelebilir. */
  siparisSekme: 'active',
  /* Eski/iptal edilmiş sipariş yüklemelerini ayırt etmek için (bkz.
     siparisleriYukle); sekme değişimi süren bir turu geçersiz kılar. */
  siparisYuklemeBileti: 0,
  /* Revize penceresinde açık olan sipariş (kapanınca null). */
  revizeSiparis: null,
  /* Teslim durumu süzgeci — sunucuda değil, yüklenen listede yerel olarak uygulanır
     (REST ucu meta alanına göre süzme desteklemiyor). */
  teslimSuzgec: '',
  /* Bayiler / Müşteriler sekmesi hangi filtreyle açılıyor.
     Varsayılan 'pending': panel açıldığında ilk görülmesi gereken şey karar
     bekleyen kurumsal başvurulardır. */
  uyeSuzgec: 'pending',
  urunDurumSuzgec: '',
  bekleyenUyeSayisi: 0,

  /* --- Geliştirici kilidi (master lock) ---
     Oturumluktur: diske YAZILMAZ, uygulama her açıldığında şifre yeniden
     sorulur (bkz. GELİŞTİRİCİ KİLİDİ bölümü). */
  masterKilitAcik: false,
  kilitPenceresiAcik: false,

  /* Sitede /pending-users ucu bulunamadıysa true olur; boşa istek atmamak
     için oturum boyunca hatırlanır (bkz. bekleyenBasvurulariGetir). */
  basvuruUcuYok: false,
  otoYenileZaman: null,

  /* Logo önbellek damgası: marka görseli her değiştiğinde artar ve
     http(s) logo adresine ?b2bv= olarak eklenir (bkz. logoAdresi).
     Sitedeki logo AYNI dosya adıyla değiştirildiğinde tarayıcının
     eski kopyayı önbellekten vermesini engeller. */
  logoDamgasi: 1,

  siparisYukleniyor: false,
  sonKontrol: null,

  /* --- Sipariş listesi sayfalama durumu --- */
  siparislerToplam: 0,        // Sitedeki gerçek sipariş sayısı (X-WP-Total)
  siparislerKesildi: false,   // Sayfa tavanına takıldı mı?

  /* --- Üye listesi sayfalama durumu --- */
  uyelerToplam: 0,

  /* --- Ürün listesi sayfalama durumu (bkz. tumSayfalariGetir) ---
     WooCommerce REST ucu bir istekte en fazla 100 kayıt döndürür. 900+ ürünlü
     mağazalarda liste sayfa sayfa çekilir; sıralama ise ancak TAM liste
     hafızadayken güvenlidir (eksik listeye menu_order yazmak, ekranda
     görünmeyen ürünlerin sırasını bozar). */
  urunlerToplam: 0,           // Mağazadaki gerçek ürün sayısı (X-WP-Total)
  urunlerTamYuklendi: false,  // Tüm sayfalar hafızaya alındı mı?
  urunYukleniyor: false,      // Arka planda sayfa çekiliyor mu?
  urunYuklemeBileti: 0        // Eski/iptal edilmiş yüklemeleri ayırt etmek için
};

/* ==========================================================================
 *  SİPARİŞ DURUMLARI — YENİ AKIŞ
 *  --------------------------------------------------------------------------
 *  processing   → Sipariş Alındı / Hazırlanıyor   (WooCommerce çekirdek durumu)
 *  order-ready  → Sipariş Hazır
 *  shipped      → Kargoya / Ambara Verildi
 *  delivered    → Teslim Edildi
 *
 *  ESKİ DURUMLAR: 1.1.0 ve öncesinde akış "b2b-received / b2b-preparing /
 *  b2b-ready / b2b-shipped / completed" idi. Veritabanındaki eski siparişler
 *  olduğu gibi durur; burada hem etiketleri hem de yeni akıştaki karşılıkları
 *  (DURUM_ESLEME) tutulur, böylece geçmiş siparişler doğru sekmede ve doğru
 *  rozetle görünür.
 * ========================================================================*/

const SIPARIS_DURUMLARI = {
  /* --- Yeni akış --- */
  processing:      { etiket: 'Sipariş Alındı / Hazırlanıyor', sinif: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30' },
  'order-ready':   { etiket: 'Sipariş Hazır',   sinif: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30' },
  shipped:         { etiket: 'Kargoya Verildi', sinif: 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30' },
  delivered:       { etiket: 'Teslim Edildi',   sinif: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30' },

  /* --- Eski akış (geçmiş siparişler) --- */
  'b2b-received':  { etiket: 'Sipariş Alındı',  sinif: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30' },
  'b2b-preparing': { etiket: 'Hazırlanıyor',    sinif: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30' },
  'b2b-ready':     { etiket: 'Sipariş Hazır',   sinif: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30' },
  'b2b-shipped':   { etiket: 'Kargoya Verildi', sinif: 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30' },

  /* --- WooCommerce çekirdek durumları --- */
  pending:         { etiket: 'Ödeme Bekliyor',  sinif: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30' },
  'on-hold':       { etiket: 'Beklemede',       sinif: 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-600/30 dark:text-slate-200 dark:border-slate-500/40' },
  completed:       { etiket: 'Tamamlandı',      sinif: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30' },
  cancelled:       { etiket: 'İptal Edildi',    sinif: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30' },
  refunded:        { etiket: 'İade Edildi',     sinif: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30' },
  failed:          { etiket: 'Başarısız',       sinif: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30' }
};

/** Eski durum anahtarlarının yeni akıştaki karşılığı (sunucudaki eşleme ile aynı). */
const DURUM_ESLEME = {
  'b2b-received': 'processing',
  'b2b-preparing': 'processing',
  'b2b-ready': 'order-ready',
  'b2b-shipped': 'shipped',
  completed: 'delivered'
};

/** Bir durumu yeni akıştaki karşılığına çevirir (yalnızca gösterim/gruplama). */
function durumNormalle(kod) {
  const ham = String(kod || '').replace(/^wc-/, '');
  return DURUM_ESLEME[ham] || ham;
}

function durumBilgisi(kod) {
  return SIPARIS_DURUMLARI[kod] || { etiket: kod || 'Bilinmiyor', sinif: 'bg-slate-200 text-slate-700 border-slate-300' };
}

/* ==========================================================================
 *  SİPARİŞ SEKMELERİ  [Aktif] [Kargodakiler] [Teslim Edilenler]
 *  --------------------------------------------------------------------------
 *  Her sekme kendi durum kümesini sunucuya gönderir. Küme, eklentideki
 *  b2b_get_order_status_groups() ile BİREBİR aynıdır; eklenti bağlıyken
 *  `group` parametresi kullanılır ve liste tek kaynaktan gelir.
 *
 *  Eklenti yokken (yedek yol) wc/v3 kullanılır; orada `group` bilinmediği için
 *  durumlar virgüllü liste olarak gönderilir.
 * ========================================================================*/

const SIPARIS_SEKMELERI = [
  {
    kod: 'active',
    simge: ikon('paket'),
    etiket: 'Aktif Siparişler',
    aciklama: 'Henüz kargolanmamış tüm siparişler',
    durumlar: ['pending', 'on-hold', 'processing', 'order-ready', 'b2b-received', 'b2b-preparing', 'b2b-ready'],
    /* Eklenti yokken WooCommerce'in kendi durumları */
    wooDurumlar: ['pending', 'on-hold', 'processing']
  },
  {
    kod: 'shipped',
    simge: ikon('kamyon'),
    etiket: 'Kargodakiler',
    aciklama: 'Kargoya / ambara verilmiş siparişler',
    durumlar: ['shipped', 'b2b-shipped'],
    wooDurumlar: ['shipped']
  },
  {
    kod: 'delivered',
    simge: ikon('bayrak'),
    etiket: 'Teslim Edilenler',
    aciklama: 'Bayinin teslim aldığını bildirdiği siparişler',
    durumlar: ['delivered', 'completed'],
    wooDurumlar: ['completed']
  },
  {
    /* İptal edilen siparişler akıştaki hiçbir adıma ait değildir; kendi
       sekmelerinde toplanır. Buradan ya yeniden akışa alınırlar (durum
       düğmeleriyle) ya da kalıcı olarak silinirler (bkz. siparisSil).

       grupYok: b2b-core'un `group` parametresi yalnızca akış sekmelerini
       (active/shipped/delivered) tanır; bu sekme için doğrudan `status`
       gönderilir. */
    kod: 'cancelled',
    simge: ikon('yasak'),
    etiket: 'İptal Edilenler',
    aciklama: 'İptal edilmiş siparişler — buradan kalıcı olarak silinebilir',
    durumlar: ['cancelled'],
    wooDurumlar: ['cancelled'],
    grupYok: true
  }
];

function sekmeTanimi(kod) {
  return SIPARIS_SEKMELERI.filter(function (s) { return s.kod === kod; })[0] || SIPARIS_SEKMELERI[0];
}

/** Sipariş kartındaki tek-tık durum butonları. `yedek`, eklenti yoksa kullanılır. */
const DURUM_DUGMELERI = [
  {
    kod: 'order-ready', yedek: 'processing', simge: ikon('onay'), etiket: 'SİPARİŞ HAZIR',
    /* Bu adım pratikte AMBARA VERİLDİ adımıdır: mal depodan çıkar, çoğu zaman
       bir ambara / nakliyeciye teslim edilir ve HENÜZ takip numarası yoktur.
       Sevkiyat paneli burada da açılır ki ambar adı yazılabilsin; alanların
       hiçbiri zorunlu değildir (bkz. index.html > kargoAmbarSatiri). */
    renk: 'bg-purple-600 hover:bg-purple-700', kargoSor: true,
    kargoBaslik: 'Sipariş Hazır / Ambara Verildi',
    aciklama: 'Sipariş hazırlandı, sevkiyat bekliyor.'
  },
  {
    kod: 'shipped', yedek: 'completed', simge: ikon('kamyon'), etiket: 'KARGOYA VERİLDİ',
    renk: 'bg-sky-600 hover:bg-sky-700', kargoSor: true,
    aciklama: 'Sipariş kargoya veya ambara teslim edildi.'
  },
  {
    kod: 'delivered', yedek: 'completed', simge: ikon('bayrak'), etiket: 'TESLİM EDİLDİ',
    renk: 'bg-emerald-600 hover:bg-emerald-700', kargoSor: false,
    aciklama: 'Sipariş bayiye teslim edildi.'
  }
];

/** Sipariş listesi üstündeki durum süzgeci düğmeleri (sekme içinde daraltma). */
const SIPARIS_SUZGECLERI_B2B = [
  { kod: '', simge: ikon('liste'), etiket: 'Tümü' },
  { kod: 'processing', simge: ikon('yeniKayit'), etiket: 'Alındı / Hazırlanıyor' },
  { kod: 'order-ready', simge: ikon('onay'), etiket: 'Sipariş Hazır' },
  { kod: 'shipped', simge: ikon('kamyon'), etiket: 'Kargoda' },
  { kod: 'delivered', simge: ikon('bayrak'), etiket: 'Teslim Edildi' }
];

const SIPARIS_SUZGECLERI_WOO = [
  { kod: '', simge: ikon('liste'), etiket: 'Tümü' },
  { kod: 'pending', simge: ikon('yeniKayit'), etiket: 'Ödeme Bekliyor' },
  { kod: 'processing', simge: ikon('ayar'), etiket: 'Hazırlanıyor' },
  { kod: 'on-hold', simge: ikon('durakla'), etiket: 'Beklemede' },
  { kod: 'completed', simge: ikon('bayrak'), etiket: 'Tamamlandı' }
];

/* ==========================================================================
 *  TESLİM DURUMU (müşterinin web panelinden verdiği cevap)
 *  ---------------------------------------------------------------------------
 *  Müşteri "Hesabım > Siparişler" sayfasında kargoya verilen siparişi
 *  "Teslim Aldım" veya "Teslim Alınmadı / Sorun Var" olarak işaretler.
 *  Cevap sipariş meta'sında  b2b_delivery_confirmation  anahtarında durur ve
 *  /wc-b2b/v1/orders yanıtında "delivery" nesnesiyle gelir.
 *
 *  Meta anahtarı bilerek alt çizgisiz: WooCommerce "_" ile başlayan meta'yı
 *  gizli sayıp wc/v3 yanıtındaki meta_data listesinden düşürür. Eklenti
 *  kurulu değilken (yedek yol) bu alanı okuyabilmemiz buna bağlı.
 * ========================================================================*/

const TESLIM_DURUMLARI = {
  delivered: {
    etiket: 'Teslim Alındı', simge: ikon('onay'),
    sinif: 'bg-emerald-100 text-emerald-800 border-emerald-300 ' +
           'dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
  },
  not_delivered: {
    etiket: 'Teslim Edilemedi', simge: ikon('yasak'),
    sinif: 'bg-red-100 text-red-800 border-red-300 ' +
           'dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30'
  },
  bekliyor: {
    etiket: 'Onay Bekliyor', simge: ikon('saat'),
    sinif: 'bg-slate-200 text-slate-700 border-slate-300 ' +
           'dark:bg-slate-600/30 dark:text-slate-200 dark:border-slate-500/40'
  }
};

/**
 * Siparişin teslim durumu kodu.
 * 'delivered' | 'not_delivered' | 'bekliyor' | 'yok'
 *
 * 'yok' = sipariş henüz kargoya verilmedi; müşterinin işaretleyeceği bir şey
 * olmadığı için rozet gösterilmez (her siparişe "Onay Bekliyor" basmak
 * ekranı gereksiz yere kalabalıklaştırırdı).
 */
function teslimKodu(s) {
  const ham = String((s && s.teslimDurum) || '');
  if (ham === 'delivered' || ham === 'not_delivered') return ham;

  /* teslimBekliyor sunucudan gelir (kargoda + işaretlenmemiş). Demo modunda ve
     eklentisiz yedek yolda bu alan olmadığı için duruma bakılır.
     Durum normalleştirilir: hem yeni 'shipped' hem eski 'b2b-shipped' sayılır. */
  const bekliyorMu = (s && s.teslimBekliyor === true) || durumNormalle(s && s.durum) === 'shipped';
  return bekliyorMu ? 'bekliyor' : 'yok';
}

/** Sipariş kartındaki yeşil/kırmızı/gri teslim rozeti. */
function teslimRozetiHtml(s) {
  const kod = teslimKodu(s);
  const bilgi = TESLIM_DURUMLARI[kod];
  if (!bilgi) return '';

  const ipucu = s && s.teslimTarih
    ? ' title="' + kacis('Müşteri işaretledi: ' + tarihYaz(s.teslimTarih, true)) + '"'
    : ' title="Müşterinin web sitesindeki teslim bildirimi"';

  return '<span' + ipucu + ' class="inline-block mt-1 px-3 py-1 rounded-lg border-2 ' +
         'text-base font-bold whitespace-nowrap ' + bilgi.sinif + '">' +
         bilgi.simge + ' ' + kacis(bilgi.etiket) + '</span>';
}

/** Sipariş listesi üstündeki teslim durumu süzgeci. */
const TESLIM_SUZGECLERI = [
  { kod: '', simge: ikon('kamyon'), etiket: 'Teslim: Tümü' },
  { kod: 'bekliyor', simge: ikon('saat'), etiket: 'Onay Bekliyor' },
  { kod: 'delivered', simge: ikon('onay'), etiket: 'Teslim Alındı' },
  { kod: 'not_delivered', simge: ikon('yasak'), etiket: 'Teslim Edilemedi' }
];

/* ==========================================================================
 *  ALICI TİPİ (BİREYSEL MÜŞTERİ / KURUMSAL BAYİ)
 *  ---------------------------------------------------------------------------
 *  Aynı mağazadan hem son kullanıcı hem bayi alışveriş yapabilir; depoya inen
 *  fiş ile muhasebeye giden bilgi ise BİRBİRİNDEN FARKLIDIR (bireyselde T.C.
 *  kimlik + teslimat adresi, kurumsalda vergi dairesi + vergi no + cari adres).
 *  Bu yüzden alıcı tipi sipariş kartında rozet, depo fişinde ise ayrı bir
 *  künye bloğu olarak gösterilir.
 *
 *  Değer sunucudan üç ayrı yoldan gelebilir:
 *    · b2b-core uçları        →  order.buyer_type
 *    · WooCommerce wc/v3      →  meta_data._b2b_buyer_type  (alt çizgili)
 *    · hiçbiri yoksa          →  firma/vergi bilgisinden ÇIKARIM yapılır
 *
 *  Çıkarım bilinçli olarak "vergi no VEYA firma unvanı varsa kurumsal" der:
 *  eski siparişlerde buyer_type alanı hiç yazılmamıştır ve hepsini bireysel
 *  göstermek, bayi siparişlerinin fişine yanlış künye basardı.
 * ========================================================================*/

const ALICI_TIPLERI = {
  individual: {
    kod: 'individual', etiket: 'MÜŞTERİ', simge: ikon('kisi'),
    sinif: 'bg-sky-100 text-sky-800 border-sky-400 ' +
           'dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/40'
  },
  corporate: {
    kod: 'corporate', etiket: 'BAYİ', simge: ikon('bina'),
    sinif: 'bg-emerald-100 text-emerald-800 border-emerald-400 ' +
           'dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40'
  }
};

/** Sunucudan gelen ham alıcı tipi / rol adını 'individual' | 'corporate' | '' yapar. */
function aliciTipiCoz(ham) {
  const s = String(ham === null || ham === undefined ? '' : ham)
    .trim().toLocaleLowerCase('tr-TR');
  if (!s) return '';

  if (['corporate', 'kurumsal', 'dealer', 'bayi', 'b2b', 'b2b_customer', 'approved_dealer',
       'wholesale', 'wholesale_customer', 'company', 'firma'].indexOf(s) !== -1) {
    return 'corporate';
  }
  if (['individual', 'bireysel', 'customer', 'musteri', 'müşteri', 'b2c',
       'retail', 'personal', 'sahis', 'şahıs'].indexOf(s) !== -1) {
    return 'individual';
  }
  return '';
}

/** Siparişin alıcı tipi: 'individual' | 'corporate'. Alan yoksa künyeden çıkarılır. */
function aliciTipiKodu(s) {
  if (!s) return 'individual';

  const acik = aliciTipiCoz(s.aliciTipi);
  if (acik) return acik;

  /* Alan hiç yazılmamış (eski sipariş): vergi no ya da firma unvanı varsa kurumsal. */
  const vergi = String(s.vergiNo || '').replace(/[^0-9]/g, '');
  if (vergi.length >= 10) return 'corporate';
  if (String(s.firma || '').trim()) return 'corporate';
  if (Number(s.bayiId || 0) > 0 && String(s.vergiDairesi || '').trim()) return 'corporate';

  return 'individual';
}

/** Sipariş kartındaki mavi [MÜŞTERİ] / yeşil [BAYİ] rozeti. */
function aliciRozetiHtml(s) {
  const bilgi = ALICI_TIPLERI[aliciTipiKodu(s)] || ALICI_TIPLERI.individual;
  const kesinMi = !!aliciTipiCoz(s && s.aliciTipi);

  const ipucu = kesinMi
    ? 'Alıcı rolü siteden bildirildi'
    : 'Alıcı rolü sipariş künyesinden çıkarıldı (eski sipariş)';

  return '<span title="' + kacis(ipucu) + '" ' +
         'class="inline-block px-3 py-1 rounded-lg border-2 text-base font-black ' +
         'tracking-wide whitespace-nowrap ' + bilgi.sinif + '">' +
         bilgi.simge + ' [' + kacis(bilgi.etiket) + ']</span>';
}

/**
 * Kredi kartı ile ödenen siparişlerde yeşil [POS Onaylı] etiketi.
 *
 * Banka provizyon kodu (transaction_id) varsa rozetin yanına basılır: kargo
 * çıkışından önce depocunun "para gerçekten geçmiş mi?" sorusuna bakacağı tek
 * yer burasıdır. Kod yoksa rozet yine gösterilir ama provizyon alanı yazılmaz —
 * boş bir "Provizyon: —" satırı, tahsilatın yapılmadığı izlenimi verirdi.
 */
function posRozetiHtml(s) {
  if (!s) return '';

  const tip = String(s.odemeTipi || '').trim();

  /* Ödeme tipi AÇIKÇA yazılmışsa yalnızca ona bakılır. Ödeme başlığından
     çıkarım sadece tip hiç yokken (eski sipariş / eklentisiz yol) yapılır:
     aksi hâlde "Kapıda nakit veya kart" gibi bir ağ geçidi adı, nakit
     siparişe de POS rozeti bastırırdı. */
  const kartMi = tip
    ? tip === 'card'
    : /kredi kart|kredi_kart|credit card|sanal ?pos|\bpos\b|iyzico|paytr|payten|craftgate|param ?pos/i
        .test(String(s.odeme || ''));

  if (!kartMi) return '';

  const kod = String(s.provizyon || '').trim();

  return '<span title="' + kacis(kod ? 'Banka provizyon kodu: ' + kod : 'Kredi kartı ile ödendi') + '" ' +
         'class="inline-block mt-1 px-3 py-1 rounded-lg border-2 text-base font-bold whitespace-nowrap ' +
         'bg-emerald-100 text-emerald-800 border-emerald-400 ' +
         'dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40">' +
         ikon('kart') + ' [POS Onaylı]' + (kod ? ' · ' + kacis(kod) : '') + '</span>';
}

/**
 * Onaylanan kurumsal başvuruya verilecek WordPress rolü.
 *
 * Sözleşme gereği SABİT: sitedeki fiyat/görünürlük kuralları bu rol adına
 * bakar. Eski `dealers/<id>/approve` ucu rolü kendisi belirler (genellikle
 * approved_dealer); yeni `approve-user` ucuna ise rol AÇIKÇA gönderilir.
 */
const B2B_BAYI_ROLU = 'b2b_customer';

/* --- Bayi durumları --- */
const BAYI_DURUMLARI = {
  pending:   { etiket: 'ONAY BEKLİYOR', sinif: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30' },
  approved:  { etiket: 'ONAYLI BAYİ',   sinif: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30' },
  rejected:  { etiket: 'REDDEDİLDİ',    sinif: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30' },
  suspended: { etiket: 'ASKIYA ALINDI', sinif: 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-600/30 dark:text-slate-200 dark:border-slate-500/40' }
};

function bayiDurumBilgisi(kod) {
  return BAYI_DURUMLARI[kod] || { etiket: String(kod || 'BİLİNMİYOR').toLocaleUpperCase('tr-TR'), sinif: 'bg-slate-200 text-slate-700 border-slate-300' };
}

/* ==========================================================================
 *  BAYİYE ÖZEL İSKONTO — anahtar (toggle) + oran kutusu
 *  --------------------------------------------------------------------------
 *  Anahtar açıkken bayi siteye girdiğinde TÜM ürün fiyatları genel site
 *  fiyatı yerine bu orana göre hesaplanır:
 *
 *      bayi_fiyatı = site_fiyatı × (1 − oran / 100)
 *
 *  Kaydetme  PUT /wc-b2b/v1/dealers/<id>  ucuna gider. WordPress'in kendi
 *  /wp/v2/users ucu KULLANILMAZ: WooCommerce'in Consumer Key/Secret
 *  doğrulaması yalnızca "wc/" ve "wc-" ile başlayan namespace'lerde devreye
 *  girer, "wp/v2" onların dışındadır ve istek 401 döner.
 * ========================================================================*/

/** Bayi kartındaki iskonto satırı. */
function bayiIskontoHtml(u) {
  /* Onay bekleyen / reddedilen başvuruda fiyat ayarı anlamsızdır. */
  if (u.durum !== 'approved' && u.durum !== 'suspended') return '';

  const acik = !!u.iskontoAktif;
  const oran = Number(u.iskontoOran || 0);

  return '' +
  '<div data-iskonto-kutu="' + u.id + '" ' +
       'class="rounded-2xl border-2 border-dashed p-4 flex flex-wrap items-center gap-4 transition ' +
       (acik
         ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10'
         : 'border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-900/40') + '">' +

    /* --- Anahtar --- */
    '<button type="button" role="switch" data-eylem="iskonto-anahtar" data-id="' + u.id + '" ' +
            'aria-checked="' + (acik ? 'true' : 'false') + '" ' +
            'title="Bayiye özel iskontoyu aç / kapat" ' +
            'class="relative w-20 h-11 rounded-full shrink-0 transition-colors focus:outline-none ' +
                   'focus:ring-4 focus:ring-emerald-500/30 ' +
                   (acik ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600') + '">' +
      '<span class="absolute top-1 left-1 w-9 h-9 rounded-full bg-white shadow-lg transition-transform duration-200 ' +
            (acik ? 'translate-x-9' : '') + '"></span>' +
    '</button>' +

    '<div class="min-w-0">' +
      '<div class="text-lg font-extrabold">' + ikon('yuzde') + ' Özel İskonto</div>' +
      '<div class="text-base font-semibold ' +
           (acik ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400') + '">' +
        (acik
          ? 'Açık — bayi %' + kacis(oranYaz(oran)) + ' indirimli fiyat görüyor'
          : 'Kapalı — bayi genel site fiyatını görüyor') +
      '</div>' +
    '</div>' +

    /* --- Oran --- */
    '<label class="ml-auto flex items-center gap-2 text-lg font-extrabold shrink-0">' +
      '<span>Oran</span>' +
      '<span class="relative">' +
        '<input data-iskonto-oran="' + u.id + '" type="number" min="0" max="100" step="0.5" ' +
               'inputmode="decimal" value="' + kacis(String(oran)) + '" ' +
               'class="w-28 h-12 pl-4 pr-8 rounded-xl text-xl font-black text-right ' +
                      'bg-white dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-600 ' +
                      'focus:border-marka-600 focus:ring-4 focus:ring-marka-600/20 outline-none transition" />' +
        '<span class="absolute right-3 top-1/2 -translate-y-1/2 text-lg font-black text-slate-400 ' +
              'pointer-events-none">%</span>' +
      '</span>' +
    '</label>' +

    '<button data-eylem="iskonto-kaydet" data-id="' + u.id + '" ' +
            'class="h-12 px-6 rounded-xl bg-marka-700 hover:bg-marka-800 active:scale-95 ' +
                   'text-white text-lg font-extrabold shadow-md transition shrink-0">' + ikon('kaydet') + ' KAYDET</button>' +

    '<div data-iskonto-durum="' + u.id + '" class="w-full text-base font-bold"></div>' +
  '</div>';
}

/** Oranı Türkçe ondalık ayracıyla yazar (35 → "35", 12.5 → "12,5"). */
function oranYaz(oran) {
  const n = Number(oran) || 0;
  return (Math.abs(n - Math.round(n)) < 0.001)
    ? String(Math.round(n))
    : String(n).replace('.', ',');
}

/*
 * Bayiler / Müşteriler sekmesinin filtre sekmeleri.
 *
 * Sıra bilinçlidir: ekran artık yalnızca "onay kuyruğu" değil, İKİLİ bir
 * müşteri defteridir. Önce bütün kayıtlar, sonra onaylı bayiler, en sonda
 * karar bekleyen başvurular gelir; bekleyen sekmesi kırmızı sayaç taşır.
 */
const UYE_SUZGECLERI = [
  { kod: 'all', simge: ikon('kullanicilar'), etiket: 'Tüm Müşteriler' },
  { kod: 'approved', simge: ikon('onay'), etiket: 'Onaylı Bayiler' },
  { kod: 'pending', simge: ikon('saat'), etiket: 'Onay Bekleyenler' },
  { kod: 'rejected', simge: ikon('carpi'), etiket: 'Reddedilen' }
];

/* ==========================================================================
 *  BÖLÜM 4 — REST API KÖPRÜSÜ (wc-b2b/v1 + wc/v3)
 * ========================================================================*/

/**
 * Ana sürece istek gönderir.
 * @param {'b2b'|'woo'} alan     Hangi API alanı kullanılacak.
 * @param {string}      yol      Uç nokta yolu (ör. 'orders/981/status').
 * @param {object}      secenek  { metod, sorgu, govde, sureAsimi }
 */
function api(alan, yol, secenek) {
  secenek = secenek || {};
  return ipcRenderer.invoke('api:istek', {
    alan: alan,
    yol: yol,
    metod: secenek.metod || 'GET',
    sorgu: secenek.sorgu || {},
    govde: secenek.govde || null,
    sureAsimi: secenek.sureAsimi || 0
  });
}

/** b2b-core eklentisinin uçları — /wp-json/wc-b2b/v1/... */
function b2b(yol, secenek) { return api('b2b', yol, secenek); }

/** WooCommerce çekirdek uçları — /wp-json/wc/v3/... */
function woo(yol, secenek) { return api('woo', yol, secenek); }

/** b2b-core'un ESKİ ad alanı — /wp-json/b2b/v1/... (bkz. main.js → API_ALANLARI.b2bAlt) */
function b2bAlt(yol, secenek) { return api('b2bAlt', yol, secenek); }

/** Yanıt "böyle bir uç yok" anlamına mı geliyor? (yedek ad alanına düşme kararı) */
function ucBulunamadiMi(cevap) {
  if (!cevap) return true;
  if (cevap.ok) return false;
  const kod = String(cevap.kod || '');
  return kod === 'rest_no_route' || Number(cevap.durum) === 404;
}

/**
 * Aynı yolu önce kanonik (wc-b2b/v1), sonra eski (b2b/v1) ad alanında dener.
 *
 * Neden iki uç: kurumsal başvuru ekranı sahada iki farklı eklenti sürümüyle
 * karşılaşıyor. Tek ad alanına bağlanmak, diğerinde ekranın "başvuru yok"
 * göstermesine yol açardı — ki bu, gerçekten bekleyen başvuru varken en
 * kötü sessiz hatadır. Yalnızca "uç yok" hatasında ikinciye geçilir;
 * yetki/ağ hataları olduğu gibi geri döner.
 */
async function b2bIkiliUc(yol, secenek) {
  const cevap = await b2b(yol, secenek);
  if (!ucBulunamadiMi(cevap)) return cevap;

  const yedek = await b2bAlt(yol, secenek);
  return ucBulunamadiMi(yedek) ? cevap : yedek;
}

/* --------------------------------------------------------------------------
 *  SAYFALAMA — "mağazanın TAMAMINI getir"
 *  --------------------------------------------------------------------------
 *  Hem WooCommerce çekirdeği (wc/v3) hem b2b-core (wc-b2b/v1) bir istekte en
 *  fazla 100 kayıt döndürür (per_page üst sınırı). 900+ ürünlü bir mağazada
 *  tek istek listenin yalnızca ilk parçasını getirir; bu da ürün listesinin
 *  eksik görünmesine ve — daha kötüsü — sıralamanın bozulmasına yol açar.
 *
 *  Bu yardımcı, yanıttaki X-WP-TotalPages başlığını okuyup sayfa sayfa
 *  ilerler ve tüm kayıtları tek dizide birleştirir. Başlık gelmezse
 *  (bazı güvenlik eklentileri başlıkları kırpar) "paket dolu geldiyse devam
 *  et" kuralıyla emniyetli biçimde ilerler.
 * ------------------------------------------------------------------------*/

/** REST ucunun izin verdiği en büyük sayfa boyu. */
const SAYFA_BOYU = 100;

/** Sonsuz döngüye karşı emniyet freni (100 x 500 = 50.000 kayıt). */
const EN_FAZLA_SAYFA = 500;

/**
 * Sipariş listesi için sayfa tavanı (100 x 60 = 6.000 sipariş).
 *
 * Ürün ve bayi sayısı doğal olarak sınırlıdır; sipariş sayısı ise zamanla
 * sınırsız büyür. Tavana takılırsa kullanıcı AÇIKÇA uyarılır (sessiz kırpma
 * yok). Daha fazlası gerekiyorsa yalnızca bu sayı büyütülür.
 */
const SIPARIS_SAYFA_TAVANI = 60;

/**
 * Sayfalanmış bir REST listesinin TÜM kayıtlarını çeker.
 *
 * @param {'b2b'|'woo'} alan    Hangi API alanı.
 * @param {string}      yol     Uç nokta yolu (ör. 'products').
 * @param {object}      sorgu   Sabit sorgu parametreleri (per_page/page hariç).
 * @param {object}      secenek { sureAsimi, sayfaBoyu, enFazlaSayfa, ilerleme(alinan, toplam, sayfa, toplamSayfa) }
 * @returns {Promise<{ok, veri, toplam, eksik, kesildi, hata, kod, durum}>}
 *   · eksik   = true → liste kısmi geldi (bir sayfa alınamadı)
 *   · kesildi = true → sayfa tavanına takıldı, sunucuda daha fazlası var
 */
async function tumSayfalariGetir(alan, yol, sorgu, secenek) {
  secenek = secenek || {};

  const cagir = (alan === 'b2b') ? b2b : woo;
  const sureAsimi = Number(secenek.sureAsimi) > 0 ? Number(secenek.sureAsimi) : 30000;

  /* Bazı uçlar (ör. /products/order) daha büyük sayfa boyuna izin verir. */
  const sayfaBoyu = Number(secenek.sayfaBoyu) > 0 ? Number(secenek.sayfaBoyu) : SAYFA_BOYU;

  /* Çağıran taraf kendi tavanını koyabilir (ör. siparişler). */
  const tavan = Number(secenek.enFazlaSayfa) > 0
    ? Math.min(Number(secenek.enFazlaSayfa), EN_FAZLA_SAYFA)
    : EN_FAZLA_SAYFA;

  const hepsi = [];
  const gorulen = {};          // Aynı kayıt iki sayfada birden gelirse tekrarlamasın

  let sayfa = 1;
  let toplamSayfa = 1;
  let toplamKayit = 0;

  while (sayfa <= toplamSayfa && sayfa <= tavan) {
    const cevap = await cagir(yol, {
      sorgu: Object.assign({}, sorgu || {}, { per_page: sayfaBoyu, page: sayfa }),
      sureAsimi: sureAsimi
    });

    if (!cevap || !cevap.ok) {
      /* İlk sayfa bile gelmediyse gerçek bir hatadır. Sonraki sayfalardan biri
         düşerse elimizdeki kısmi liste korunur ama "eksik" işaretlenir:
         çağıran taraf bu listeyle SIRALAMA yapmamalıdır. */
      return {
        ok: hepsi.length > 0,
        veri: hepsi,
        toplam: toplamKayit || hepsi.length,
        eksik: true,
        hata: (cevap && cevap.hata) || 'Liste alınamadı.',
        kod: cevap && cevap.kod,
        durum: cevap && cevap.durum
      };
    }

    const paket = Array.isArray(cevap.veri) ? cevap.veri : [];

    paket.forEach(function (kayit) {
      const anahtar = String((kayit && kayit.id) !== undefined ? kayit.id : hepsi.length);
      if (gorulen[anahtar]) return;
      gorulen[anahtar] = true;
      hepsi.push(kayit);
    });

    if (sayfa === 1) {
      toplamSayfa = Math.max(1, Number(cevap.sayfa) || 1);
      toplamKayit = Number(cevap.toplam) || 0;
    }

    /* Başlık eksik/yanlışsa: paket ağzına kadar doluysa daha fazlası var demektir. */
    if (sayfa >= toplamSayfa && paket.length >= sayfaBoyu) {
      toplamSayfa = sayfa + 1;
    }

    if (typeof secenek.ilerleme === 'function') {
      secenek.ilerleme(hepsi.length, toplamKayit || hepsi.length, sayfa, toplamSayfa);
    }

    if (paket.length === 0) break;   // Boş sayfa: liste bitti

    sayfa++;
  }

  /*
   * Tavana takılıp takılmadığımız sessizce yutulmaz: çağıran taraf
   * kullanıcıya "listenin tamamı değil" diyebilsin diye bildirilir.
   */
  const kesildi = ( sayfa > tavan && sayfa <= toplamSayfa );

  return {
    ok: true,
    veri: hepsi,
    toplam: toplamKayit || hepsi.length,
    eksik: false,
    kesildi: kesildi
  };
}

/**
 * Ürün kategorilerinin TAMAMI (WooCommerce çekirdek ucu; her iki modda çalışır).
 *
 * Hem "yeni ürün" hem "ürün düzenle" penceresindeki kategori kutusu buradan
 * beslenir. Tek istekle 100 kategori geliyordu; geniş kataloglarda listenin
 * sonundaki kategoriler açılır kutuda hiç görünmüyordu.
 *
 * @returns {Promise<{ok, kategoriler, eksik, hata}>}
 */
async function tumKategorileriGetir() {
  const cevap = await tumSayfalariGetir('woo', 'products/categories', {
    orderby: 'name',
    order: 'asc'
  }, { sureAsimi: 30000 });

  if (!cevap.ok) {
    return { ok: false, kategoriler: [], eksik: true, hata: cevap.hata };
  }

  return {
    ok: true,
    eksik: !!cevap.eksik,
    hata: cevap.hata || '',
    kategoriler: (cevap.veri || []).map(function (k) {
      return { id: k.id, ad: k.name };
    })
  };
}

/**
 * Sitede b2b-core eklentisi var mı diye bakar ve site bilgilerini alır.
 * Sonucu `durum.b2bVar` ve `durum.siteBilgisi` içine yazar.
 */
async function eklentiyiTani() {
  if (durum.ayarlar.demoModu) {
    durum.b2bVar = true;
    durum.siteBilgisi = {
      plugin: 'b2b-core (demo)', version: '1.0.0', site: durum.ayarlar.firmaAdi,
      currency: 'TRY', currency_symbol: '₺'
    };
    return true;
  }

  /* Yeni bir site/eklenti tanınıyor: "uç yok" hafızası geçersizdir. */
  durum.basvuruUcuYok = false;

  const cevap = await b2b('ping');

  if (cevap.ok && cevap.veri && cevap.veri.ok) {
    durum.b2bVar = true;
    durum.siteBilgisi = cevap.veri;
    durum.canliBaglantiTamam = true;
    siteLogosunuGetir(); // Fire-and-forget; kendi içinde tek seferlik korumalı.
  } else {
    durum.b2bVar = false;
    durum.siteBilgisi = null;
    if (cevap.ok || cevap.eklentiYok) durum.canliBaglantiTamam = true; // Site ayakta, eklenti yok
  }

  ustCubuguTazele();
  return durum.b2bVar;
}

/* --- API yanıtlarını uygulamanın iç yapısına çevirenler --- */

/** b2b-core /orders yanıtını iç yapıya çevirir. */
function b2bSiparisNormalle(s) {
  const bayi = s.dealer || {};
  const fatura = s.billing || {};
  const teslim = s.shipping || {};

  /* Eklenti sürümüne göre alıcı tipi farklı adlarla gelebilir; hepsi taranır.
     Yanıtta meta_data da varsa (bazı sürümler ekliyor) oradaki alt çizgili
     anahtar da yedek olarak okunur. */
  const b2bMeta = {};
  (s.meta_data || []).forEach(function (m) { if (m && m.key) b2bMeta[m.key] = m.value; });
  const adres = [
    teslim.address_1 || fatura.address_1,
    teslim.address_2 || fatura.address_2,
    teslim.district || fatura.district,
    teslim.city || fatura.city,
    teslim.state || fatura.state
  ].filter(Boolean).join(', ');

  return {
    id: s.id,
    numara: s.number || String(s.id),
    bayiId: bayi.id || 0,
    musteri: bayi.contact_name || [fatura.first_name, fatura.last_name].filter(Boolean).join(' ') || 'İsimsiz Müşteri',
    firma: bayi.company_name || fatura.company || '',
    telefon: bayi.phone || fatura.phone || '',
    vergiNo: bayi.tax_number || '',
    vergiDairesi: bayi.tax_office || '',
    adres: adres,
    tutar: Number(s.total || 0),
    araToplam: Number(s.subtotal || 0),
    kdv: Number(s.total_tax || 0),
    kargoTutar: Number(s.shipping_total || 0),
    /* Bayi iskontosu özeti (b2b-core > B2B_Order_Pricing). Eklenti eski
       sürümdeyse null gelir; fiş kalem toplamlarından kendi hesabını yapar. */
    fiyatOzeti: s.pricing || null,
    tarih: s.date_created || '',
    durum: s.status || 'b2b-received',
    durumEtiketi: s.status_label || '',
    notlar: s.customer_note || '',
    odeme: s.payment_title || '',
    kargo: s.carrier || '',
    takip: s.tracking_number || '',
    /* Serbest sevkiyat metni: özel ambar / nakliyeci / sevk fişi numarası. */
    sevkiyatNotu: s.shipment_note || '',
    /* Sipariş türü (Nakit / Kredi Kartı / Vadeli) ve uygulanan iskonto */
    odemeTipi: s.payment_type || '',
    odemeTipiEtiket: s.payment_type_label || '',
    odemeIskonto: Number(s.payment_discount_rate || 0),
    odemeIskontoTutar: Number(s.payment_discount_amount || 0),
    odemeNotu: s.payment_type_note || '',
    /* Alıcı rolü (bireysel müşteri / kurumsal bayi) — bkz. ALICI TİPİ bölümü */
    aliciTipi: s.buyer_type || bayi.buyer_type || s.customer_type ||
               b2bMeta._b2b_buyer_type || b2bMeta.b2b_buyer_type || '',
    /* Bireysel alıcının T.C. kimlik numarası (yalnızca kurumsal olmayan fişte basılır) */
    tcKimlik: String(s.national_id || bayi.national_id || fatura.tc_no ||
                     b2bMeta._b2b_tc_kimlik || b2bMeta.b2b_tc_kimlik || ''),
    /* Kredi kartı tahsilatının banka provizyon / işlem kodu */
    provizyon: String(s.transaction_id || s.provision_code ||
                      b2bMeta._transaction_id || ''),
    /* --- Müşterinin teslim bildirimi (web paneli) --- */
    teslimDurum: (s.delivery && s.delivery.state) || '',
    teslimEtiket: (s.delivery && s.delivery.state_label) || '',
    teslimTarih: (s.delivery && s.delivery.confirmed_at) || '',
    teslimBekliyor: !!(s.delivery && s.delivery.awaiting),
    /* --- Depo revizesi (adet düzeltmesi) --- */
    revize: !!(s.revision && s.revision.revised),
    revizeTarih: (s.revision && s.revision.revised_at) || '',
    revizeDegisim: (s.revision && s.revision.changes) || [],
    revizeEdilebilir: s.revision ? !!s.revision.can_revise : null,
    kalemler: (s.items || []).map(function (k) {
      const adet = Number(k.quantity || 0);
      const toplam = Number(k.total || 0);
      const birim = Number(k.unit_price || (adet > 0 ? toplam / adet : 0));
      const araToplam = Number(k.subtotal !== undefined ? k.subtotal : toplam);

      return {
        /* Kalem kimliği revize için ZORUNLU: WooCommerce satırı bu id ile
           bulur (ürün id'si değil, sipariş kalemi id'si). */
        kalemId: Number(k.id || 0),
        urunId: Number(k.product_id || 0),
        ad: k.name || '',
        kod: k.sku || '-',
        adet: adet,
        birim: birim,
        tutar: toplam,
        araToplam: araToplam,
        /* --- İSKONTO KÜNYESİ (depo fişi) ---
           b2b-core 'list_subtotal' alanını satır meta'sından üretir; eklenti
           eski sürümdeyse alan hiç gelmez ve liste fiyatı bayi fiyatına
           eşitlenir (iskonto 0 görünür). Olmayan bir indirimi uydurmak
           yerine 'indirim yok' göstermek doğrusudur. */
        listeAraToplam: Number(k.list_subtotal !== undefined && k.list_subtotal !== null
          ? k.list_subtotal
          : araToplam),
        gorsel: k.image || YEDEK_GORSEL
      };
    })
  };
}

/** WooCommerce çekirdek /orders yanıtını iç yapıya çevirir (yedek yol). */
function siparisNormalle(s) {
  const fatura = s.billing || {};
  const teslim = s.shipping || {};
  const adSoyad = [fatura.first_name, fatura.last_name].filter(Boolean).join(' ');
  const adresSatiri = [
    teslim.address_1 || fatura.address_1,
    teslim.address_2 || fatura.address_2,
    teslim.city || fatura.city,
    teslim.state || fatura.state
  ].filter(Boolean).join(', ');

  const meta = {};
  (s.meta_data || []).forEach(function (m) { meta[m.key] = m.value; });

  /* Eklenti etkinse wc/v3 yanıtına da "b2b.delivery" nesnesini ekler; o zaman
     etiket ve "onay bekliyor" bilgisi hazır gelir. Eklenti yoksa aşağıdaki
     meta_data yedeği devreye girer. */
  const teslim0 = (s.b2b && s.b2b.delivery) || null;

  return {
    id: s.id,
    numara: s.number || String(s.id),
    bayiId: Number(s.customer_id || 0),
    musteri: adSoyad || fatura.company || 'İsimsiz Müşteri',
    firma: fatura.company || '',
    telefon: fatura.phone || '',
    /* Eklentisiz yolda vergi künyesi yalnızca meta'da olabilir; depo fişinin
       kurumsal başlığı bu iki alana bağlı olduğu için yaygın adlar taranır. */
    vergiNo: String(meta._b2b_tax_number || meta.b2b_vergi_no || meta.vergi_no ||
                    meta._billing_tax_number || meta.billing_vergi_no || ''),
    vergiDairesi: String(meta._b2b_tax_office || meta.b2b_vergi_dairesi || meta.vergi_dairesi ||
                         meta._billing_tax_office || meta.billing_vergi_dairesi || ''),
    adres: adresSatiri || '',
    tutar: Number(s.total || 0),
    araToplam: 0,
    kdv: Number(s.total_tax || 0),
    kargoTutar: Number(s.shipping_total || 0),
    tarih: s.date_created || '',
    durum: s.status || 'pending',
    durumEtiketi: '',
    notlar: s.customer_note || '',
    odeme: s.payment_method_title || '',
    kargo: meta._b2b_carrier || '',
    takip: meta._b2b_tracking_number || '',
    sevkiyatNotu: String(meta._b2b_shipment_note || meta.b2b_shipment_note || ''),
    /* Sipariş türü meta'dan okunur (eklenti uçları yerine wc/v3 kullanıldığında) */
    odemeTipi: String(meta.b2b_payment_type || meta._b2b_payment_type || ''),
    odemeTipiEtiket: String(meta._b2b_payment_type_label || ''),
    odemeIskonto: Number(meta._b2b_payment_discount_rate || 0),
    odemeIskontoTutar: Number(meta._b2b_payment_discount_amount || 0),
    odemeNotu: String(meta._b2b_payment_note || ''),
    /* Alıcı rolü — eklentisiz yolda yalnızca meta_data'dan okunabilir.
       Alt çizgisiz ayna da taranır: WooCommerce "_" ile başlayan meta'yı
       wc/v3 yanıtından düşürebilir (bkz. TESLİM DURUMU bölümündeki not). */
    aliciTipi: String(meta._b2b_buyer_type || meta.b2b_buyer_type ||
                      (s.b2b && s.b2b.buyer_type) || ''),
    tcKimlik: String(meta._b2b_tc_kimlik || meta.b2b_tc_kimlik ||
                     meta._billing_tc_no || meta.billing_tc_no || ''),
    /* Banka provizyon kodu: wc/v3 sipariş nesnesinde çekirdek alandır. */
    provizyon: String(s.transaction_id || meta._transaction_id || ''),
    /* Teslim bildirimi. Eklenti varsa hazır nesneden, yoksa meta_data'dan.
       (Anahtar alt çizgisiz olduğu için wc/v3 yanıtında görünür.) */
    teslimDurum: teslim0 ? String(teslim0.state || '') : String(meta.b2b_delivery_confirmation || ''),
    teslimEtiket: teslim0 ? String(teslim0.state_label || '') : '',
    /* İşaretleme zamanı "_" ile başladığı için ham meta_data'da gelmez;
       yalnızca eklentinin eklediği nesnede bulunur. */
    teslimTarih: teslim0 ? String(teslim0.confirmed_at || '') : '',
    /* "Onay bekliyor" kararını mümkünse sunucu verir; yedek yolda kargoya
       verilmiş ve henüz işaretlenmemiş sipariş bekliyor sayılır. */
    teslimBekliyor: teslim0
      ? !!teslim0.awaiting
      : (durumNormalle(s.status) === 'shipped' && !meta.b2b_delivery_confirmation),
    /* Revize bilgisi: eklenti varsa hazır nesneden, yoksa meta_data'dan.
       (b2b_order_revised anahtarı alt çizgisiz olduğu için wc/v3 yanıtında
       görünür — b2b_delivery_confirmation ile aynı gerekçe.) */
    revize: !!(s.b2b && s.b2b.revision ? s.b2b.revision.revised : meta.b2b_order_revised === 'yes'),
    revizeTarih: (s.b2b && s.b2b.revision && s.b2b.revision.revised_at) || '',
    revizeDegisim: (s.b2b && s.b2b.revision && s.b2b.revision.changes) || [],
    revizeEdilebilir: (s.b2b && s.b2b.revision) ? !!s.b2b.revision.can_revise : null,
    kalemler: (s.line_items || []).map(function (k) {
      const adet = Number(k.quantity || 0);
      const toplam = Number(k.total || 0);
      const birim = Number(k.price !== undefined && k.price !== null && k.price !== ''
        ? k.price
        : (adet > 0 ? toplam / adet : 0));
      const araToplam = Number(k.subtotal !== undefined && k.subtotal !== null ? k.subtotal : toplam);

      return {
        kalemId: Number(k.id || 0),
        urunId: Number(k.product_id || 0),
        ad: k.name,
        kod: k.sku || '-',
        adet: adet,
        birim: birim,
        tutar: toplam,
        araToplam: araToplam,
        /* wc/v3 çekirdek ucunda liste fiyatı meta'sı OKUNMAZ (b2b-core'a özgü
           alandır). Eklentisiz yolda iskonto sütunu boş kalır. */
        listeAraToplam: araToplam,
        gorsel: (k.image && k.image.src) ? k.image.src : YEDEK_GORSEL
      };
    })
  };
}

/* --------------------------------------------------------------------------
 *  KOLİ İÇİ ADET (B2B sipariş katı)
 *
 *  WooCommerce'de böyle bir çekirdek alan YOKTUR; değer ürünün meta_data
 *  listesinde tutulur. Sitedeki eklenti/tema hangi adı okuyorsa bulabilsin
 *  diye aynı değer birkaç anahtara birden yazılır:
 *
 *    _b2b_koli_adeti   KANONİK ad (b2b-core bunu yazar/okur)
 *    _byom_case_qty    byom-pro-theme'in ilk sırada taradığı ad
 *    _b2b_koli_adet    temanın tarihsel adı (SONDAKİ "i" YOK — dikkat)
 *    _box_quantity     yaygın İngilizce karşılığı
 *    b2b_koli_adeti    ALT ÇİZGİSİZ AYNA — okuma güvencesi
 *
 *  Neden bu kadar çok ad: değer üç ayrı katmanda (panel, eklenti, tema) ayrı
 *  ayrı adlandırılmıştı ve `_b2b_koli_adeti` ile `_b2b_koli_adet` tek harf
 *  farkla ayrışıyordu; panelde girilen koli adedi vitrinde hiç görünmüyordu.
 *  Tek ada indirgemek, o adla veri girilmiş kurulumlarda bilgiyi kaybettirirdi.
 *  Bu yüzden YAZARKEN hepsi birden yazılır, OKURKEN hepsi taranır.
 *
 *  Ayna neden gerekli: WooCommerce "_" ile başlayan meta'yı gizli sayabilir ve
 *  wc/v3 yanıtındaki meta_data listesinden düşürebilir (aynı sebeple sipariş
 *  teslim bildirimi de alt çizgisiz tutuluyor — bkz. TESLİM DURUMU bölümü).
 *  Ayna olmasaydı kaydedilen koli adedi listeyi tazeledikten sonra geri
 *  okunamaz, düzenleme penceresi 1 gösterir ve bir sonraki kayıtta kullanıcının
 *  girdiği değeri sessizce 1'e düşürürdü.
 * ------------------------------------------------------------------------*/
const KOLI_META_ANAHTARI = '_b2b_koli_adeti';
const KOLI_META_YEDEK    = '_box_quantity';
const KOLI_META_AYNA     = 'b2b_koli_adeti';

/* Yazılırken kullanılan TAM liste. Sıra önemsizdir; hepsi aynı değeri alır.
   Doğrudan wc/v3'e yazıldığında (b2b-core devrede değilken) temanın taradığı
   adların da dolması için tema adları da buradadır. */
const KOLI_META_TUM_ANAHTARLAR = [
  KOLI_META_ANAHTARI,   // _b2b_koli_adeti — kanonik
  '_byom_case_qty',     // tema listesinde ilk sırada
  '_b2b_koli_adet',     // temanın tarihsel adı (sondaki "i" yok)
  KOLI_META_YEDEK,      // _box_quantity
  KOLI_META_AYNA,       // b2b_koli_adeti (alt çizgisiz ayna)
  'box_quantity'        // alt çizgisiz İngilizce ayna
];

/** Ürün yanıtından koli içi adedi okur. Bulunamazsa 1 döner. */
function koliAdediCoz(u) {
  const meta = {};
  ((u && u.meta_data) || []).forEach(function (m) {
    if (m && m.key !== undefined && m.key !== null) meta[m.key] = m.value;
  });

  /* b2b-core artık `box_quantity` alanını hazır döndürüyor; en güvenilir
     kaynak odur (WooCommerce "_" ile başlayan meta'yı yanıttan düşürebiliyor).
     Bulunamazsa bilinen bütün meta adları sırayla taranır. */
  const adaylar = [u ? u.box_quantity : undefined].concat(
    KOLI_META_TUM_ANAHTARLAR.map(function (anahtar) { return meta[anahtar]; })
  );

  for (let i = 0; i < adaylar.length; i++) {
    const ham = adaylar[i];
    if (ham === undefined || ham === null || ham === '') continue;
    const n = Math.round(Number(ham));
    if (isFinite(n) && n >= 1) return n;
  }
  return 1;
}

/** Koli adedini API'ye gönderilecek meta_data listesine çevirir. */
function koliMetaVerisi(adet) {
  const n = String(Math.max(1, Math.round(Number(adet) || 1)));
  return KOLI_META_TUM_ANAHTARLAR.map(function (anahtar) {
    return { key: anahtar, value: n };
  });
}

/** sale_price alanını sayıya çevirir; indirim yoksa '' döner. */
function indirimliFiyatCoz(ham) {
  if (ham === undefined || ham === null || String(ham).trim() === '') return '';
  const n = Number(ham);
  return (isFinite(n) && n > 0) ? n : '';
}

/** Hem b2b-core hem WooCommerce ürün yanıtını iç yapıya çevirir. */
function urunNormalle(u) {
  const gorsel = u.image
    ? u.image
    : (u.images && u.images[0] && u.images[0].src ? u.images[0].src : YEDEK_GORSEL);

  const hamFiyat = (u.regular_price !== '' && u.regular_price !== undefined && u.regular_price !== null && Number(u.regular_price) > 0)
    ? u.regular_price
    : u.price;

  return {
    id: u.id,
    ad: u.name || 'İsimsiz Ürün',
    kod: u.sku || '-',
    fiyat: Number(hamFiyat || 0),
    stok: (u.stock_quantity === null || u.stock_quantity === undefined) ? 0 : Number(u.stock_quantity),
    durum: u.status || 'publish',
    gorsel: gorsel || YEDEK_GORSEL,
    /* --- Düzenleme paneli ve sürükle-bırak sıralaması için ek alanlar --- */
    menuSira: Number(u.menu_order || 0),
    gorselId: Number(u.image_id || (u.images && u.images[0] && u.images[0].id) || 0),
    barkod: String(u.barcode || u.sku || ''),
    aciklama: String(u.description || ''),
    stokTakip: !!u.manage_stock,
    /* İndirimli fiyat: indirim yoksa '' kalır (0 ile karıştırılmasın). */
    indirimliFiyat: indirimliFiyatCoz(u.sale_price),
    koliAdedi: koliAdediCoz(u),
    kategoriler: (u.categories || []).map(function (k) {
      return { id: Number(k.id || 0), ad: String(k.name || '') };
    })
  };
}

/** b2b-core /dealers yanıtını iç yapıya çevirir. */
function bayiNormalle(b) {
  const adSoyad = [b.first_name, b.last_name].filter(Boolean).join(' ');
  return {
    id: b.id,
    ad: b.contact_name || adSoyad || b.username || 'İsimsiz Bayi',
    firma: b.company_name || '',
    vergiNo: b.tax_number || '-',
    vergiDairesi: b.tax_office || '',
    telefon: b.phone || '',
    eposta: b.email || '',
    adres: [b.address, b.district, b.city].filter(Boolean).join(', '),
    tarih: b.applied_at || b.registered || '',
    onayTarihi: b.approved_at || '',
    redSebebi: b.reject_reason || '',
    not: b.note || '',
    fiyatGrubu: b.price_group || '',
    krediLimiti: b.credit_limit || '',
    durum: b.status || 'pending',
    /* --- Bayiye özel iskonto ---
       custom_discount_rate ile discount_rate AYNI alanı gösterir; hangisi
       gelirse o okunur. effective_discount_rate ise fiyatlara GERÇEKTEN
       uygulanan orandır (anahtar kapalıysa 0). */
    iskontoAktif: b.custom_discount_active === true || b.custom_discount_active === 'yes' || b.custom_discount_active === 1,
    iskontoOran: Number(
      b.custom_discount_rate !== undefined && b.custom_discount_rate !== null && b.custom_discount_rate !== ''
        ? b.custom_discount_rate
        : (b.discount_rate || 0)
    ) || 0,
    iskontoGecerli: Number(b.effective_discount_rate || 0) || 0
  };
}

/* ==========================================================================
 *  ONAY BEKLEYEN KURUMSAL BAŞVURULAR  (/pending-users)
 *  ---------------------------------------------------------------------------
 *  Sitedeki kayıt formundan gelen kurumsal başvurular, henüz bir "bayi"
 *  kaydına dönüşmeden bu uçta bekler. Alan adları eklenti sürümüne göre
 *  değiştiği için hepsi sırayla taranır (company_name / firma / title …).
 *  Kayıt Tarihi, İl/İlçe gibi alanlar başvuruyu değerlendirmenin tek dayanağı
 *  olduğu için burada boş bırakmak yerine bilinen tüm adlar denenir.
 * ========================================================================*/

function basvuruNormalle(b) {
  b = b || {};
  const meta = b.meta || b.meta_data_map || {};
  const adSoyad = [b.first_name, b.last_name].filter(Boolean).join(' ');

  /** Aynı bilgi için birden çok olası alan adını sırayla dener. */
  const ilk = function (adlar) {
    for (let i = 0; i < adlar.length; i++) {
      const deger = adlar[i];
      if (deger !== undefined && deger !== null && String(deger).trim() !== '') {
        return String(deger).trim();
      }
    }
    return '';
  };

  const il = ilk([b.city, b.il, meta.city, meta.il, b.billing_city]);
  const ilce = ilk([b.district, b.ilce, b.state, meta.district, meta.ilce, b.billing_district]);

  return {
    id: Number(b.id || b.user_id || b.ID || 0),
    /* Bu kayıt /pending-users ucundan geldi: onay isteği "approve-user" ucuna
       gider, "dealers/<id>/approve" ucuna DEĞİL (bkz. uyeKarar). */
    kaynak: 'pending-users',
    durum: 'pending',
    ad: ilk([b.contact_name, adSoyad, b.display_name, b.name, b.username, meta.yetkili]) || 'İsimsiz Başvuru',
    firma: ilk([b.company_name, b.company, b.firma, b.firma_unvani, b.title,
                meta.company_name, meta.firma_adi, meta.company]),
    vergiNo: ilk([b.tax_number, b.vergi_no, b.vat_number, b.tax_id,
                  meta.tax_number, meta.vergi_no, meta.vat_number]),
    vergiDairesi: ilk([b.tax_office, b.vergi_dairesi, meta.tax_office, meta.vergi_dairesi]),
    il: il,
    ilce: ilce,
    telefon: ilk([b.phone, b.telefon, b.billing_phone, meta.phone, meta.telefon]),
    eposta: ilk([b.email, b.user_email, b.eposta]),
    adres: [ilk([b.address, b.address_1, b.adres, meta.address, meta.adres]), ilce, il]
      .filter(Boolean).join(', '),
    tarih: ilk([b.registered, b.registered_at, b.applied_at, b.date_created,
                b.user_registered, b.created_at]),
    onayTarihi: '',
    redSebebi: '',
    not: ilk([b.note, b.not, meta.note]),
    /* Başvuru aşamasında bayiye özel iskonto tanımlanamaz. */
    iskontoAktif: false,
    iskontoOran: 0,
    iskontoGecerli: 0
  };
}

/**
 * Onay bekleyen kurumsal başvuruları getirir.
 *
 * Önce /wc-b2b/v1/pending-users, o yoksa /b2b/v1/pending-users denenir
 * (bkz. b2bIkiliUc). Uç sitede hiç yoksa `ucYok: true` döner ve çağıran
 * taraf eski `dealers?status=pending` yoluna düşer — böylece bu eklentiye
 * sahip olmayan kurulumlarda ekran eskisi gibi çalışmaya devam eder.
 *
 * @returns {Promise<{ok, ucYok, basvurular, toplam, hata}>}
 */
async function bekleyenBasvurulariGetir(arama) {
  /*
   * Uç sitede yoksa bunu OTURUM BOYUNCA hatırla. Aksi hâlde her liste
   * tazelemesi ve her onaydan sonra iki boşa istek daha atılırdı
   * (wc-b2b/v1 → b2b/v1), üstelik ikisi de aynı "rest_no_route" ile döner.
   * Bayrak eklenti yeniden tanındığında sıfırlanır (bkz. eklentiyiTani).
   */
  if (durum.basvuruUcuYok) {
    return { ok: false, ucYok: true, basvurular: [], toplam: 0, hata: '' };
  }

  const sorgu = { per_page: SAYFA_BOYU };
  if (arama) sorgu.search = arama;

  const cevap = await b2bIkiliUc('pending-users', { sorgu: sorgu, sureAsimi: 30000 });

  if (ucBulunamadiMi(cevap)) {
    durum.basvuruUcuYok = true;
    return { ok: false, ucYok: true, basvurular: [], toplam: 0, hata: (cevap && cevap.hata) || '' };
  }

  if (!cevap.ok) {
    return { ok: false, ucYok: false, basvurular: [], toplam: 0, hata: cevap.hata || 'Başvurular alınamadı.' };
  }

  /* Uç ya düz dizi ya da { users: [...] } / { pending: [...] } döndürebilir. */
  const veri = cevap.veri;
  const ham = Array.isArray(veri)
    ? veri
    : (veri && (veri.users || veri.pending || veri.pending_users || veri.data)) || [];

  const basvurular = (Array.isArray(ham) ? ham : []).map(basvuruNormalle)
    .filter(function (u) { return u.id > 0; });

  return {
    ok: true,
    ucYok: false,
    basvurular: basvurular,
    toplam: Number(cevap.toplam) || (veri && Number(veri.total)) || basvurular.length,
    hata: ''
  };
}

function metaOku(kayit) {
  const harita = {};
  (kayit.meta_data || []).forEach(function (m) { harita[m.key] = m.value; });
  return harita;
}

/** WooCommerce müşterisini bayi yapısına çevirir (eklentisiz yedek yol). */
function musteriBayiyeCevir(m) {
  const meta = metaOku(m);
  const fatura = m.billing || {};
  const adSoyad = [m.first_name, m.last_name].filter(Boolean).join(' ');
  const ham = String(meta[durum.ayarlar.b2bAlan] || '');

  let durumKodu = 'pending';
  if (ham === String(durum.ayarlar.b2bOnaylandi)) durumKodu = 'approved';
  else if (ham === String(durum.ayarlar.b2bReddedildi)) durumKodu = 'rejected';
  else if (ham === String(durum.ayarlar.b2bBekliyor)) durumKodu = 'pending';
  else durumKodu = ham ? 'pending' : 'yok';

  return {
    id: m.id,
    ad: adSoyad || m.username || 'İsimsiz Üye',
    firma: fatura.company || meta.firma_adi || meta.company || '',
    vergiNo: meta.vergi_no || meta.tax_number || meta.vat_number || '-',
    vergiDairesi: meta.vergi_dairesi || meta.tax_office || '',
    telefon: fatura.phone || '',
    eposta: m.email || '',
    adres: [fatura.address_1, fatura.city].filter(Boolean).join(', '),
    tarih: m.date_created || '',
    onayTarihi: '',
    redSebebi: '',
    not: '',
    durum: durumKodu,
    hamDurum: ham
  };
}

/* ==========================================================================
 *  BÖLÜM 5 — ÜST ÇUBUK (firma, lisans, bağlantı rozeti)
 * ========================================================================*/

/** BYOM Brain doğrulaması yapıldıysa lisansın gerçek bitiş tarihi (YYYY-AA-GG). */
function lisansBitisTarihi() {
  const byom = window.BYOM && window.BYOM.lisans;
  if (byom && byom.bitisTarihi) return byom.bitisTarihi;
  return durum.ayarlar.lisansBitis;
}

function lisansGunSayisi() {
  /* Tek doğru kaynak BYOM Brain'dir: kalan gün sunucu saatine göre hesaplanır,
     böylece bilgisayarın saati geri alınarak lisans uzatılamaz. Merkezî veri
     yoksa (henüz doğrulanmadıysa) yerel bakım tarihine düşülür. */
  const byom = window.BYOM && window.BYOM.lisans;
  if (byom && byom.durum && byom.kalanGun !== null && byom.kalanGun !== undefined && isFinite(byom.kalanGun)) {
    return Number(byom.kalanGun);
  }

  const bitis = new Date(lisansBitisTarihi() + 'T23:59:59');
  if (isNaN(bitis.getTime())) return 365;
  return Math.ceil((bitis.getTime() - Date.now()) / 86400000);
}

/**
 * Üst çubuktaki firma simgesini günceller: sitedeki logo varsa öncelikli,
 * yoksa Ayarlar'dan yüklenen yerel logo, o da yoksa varsayılan simgesi.
 */
/* --------------------------------------------------------------------------
 *  MARKA GÖRSELİ — TEK ÇÖZÜM NOKTASI
 *  --------------------------------------------------------------------------
 *  Logo iki kaynaktan gelebilir:
 *    · yerelLogo  — Ayarlar'dan yüklenen dosya (data:image/... base64)
 *    · siteLogosu — bağlantı kurulunca sitenin theme-config'inden çekilen adres
 *
 *  ÖNCELİK YERELDEDİR. Eskiden siteLogosu öne alınıyordu; sitede bir logo
 *  varsa kullanıcının yüklediği yeni logo başlıkta HİÇ görünmüyor, "logo
 *  önbellekte takılı kaldı" gibi okunuyordu. Kullanıcının o pencerede
 *  bilerek yüklediği dosya, arka planda çekilmiş adresten önce gelir.
 * ------------------------------------------------------------------------*/
function markaLogosu() {
  return String(durum.ayarlar.yerelLogo || durum.ayarlar.siteLogosu || '').trim();
}

/**
 * Logo adresine önbellek kırıcı ekler.
 *
 * `data:` adresleri içeriğin kendisidir; değişince adres de değişir, ek
 * gerekmez (üstelik ekleme base64'ü bozar). Yalnızca http(s) adreslerine
 * damga eklenir: site logosu aynı DOSYA ADIYLA değiştirildiğinde tarayıcı
 * eskisini önbellekten verir ve panelde eski logo asılı kalırdı.
 */
function logoAdresi(kaynak, damga) {
  const s = String(kaynak || '');
  if (!s || s.slice(0, 5) === 'data:') return s;
  return s + (s.indexOf('?') === -1 ? '?' : '&') + 'b2bv=' + (damga || durum.logoDamgasi || '1');
}

function firmaLogosunuUygula() {
  const kutu = $('#firmaLogoKutu');
  const img = $('#firmaLogo');
  const varsayilan = $('#firmaVarsayilanSimge');
  if (!kutu || !img || !varsayilan) return;

  const kaynak = markaLogosu();

  if (!kaynak) {
    kutu.classList.add('hidden');
    varsayilan.classList.remove('hidden');
    return;
  }

  img.onerror = function () {
    kutu.classList.add('hidden');
    varsayilan.classList.remove('hidden');
  };
  img.onload = function () {
    kutu.classList.remove('hidden');
    varsayilan.classList.add('hidden');
  };
  /* Aynı src yeniden atandığında tarayıcı onload'ı tetiklemez ve kutu gizli
     kalırdı; önce boşaltılıp sonra damgalı adres veriliyor. */
  img.removeAttribute('src');
  img.src = logoAdresi(kaynak);
}

/**
 * Bağlantı kurulduğunda sitenin b2b-core theme-config'inden header logosunu
 * bir kez çeker (bkz. eklentiyiTani). Yalnızca kozmetiktir — hata olursa
 * sessizce geçilir, bağlantıyı etkilemez.
 */
async function siteLogosunuGetir() {
  if (durum.logoKontrolEdildi) return;
  durum.logoKontrolEdildi = true;

  try {
    const cevap = await b2b('theme-config');
    if (!cevap.ok || !cevap.veri || !cevap.veri.config) return;

    const logo = cevap.veri.config.logo || {};
    const url = String((durum.ayarlar.tema === 'koyu' && logo.header_dark) || logo.header || '').trim();

    if (url !== String(durum.ayarlar.siteLogosu || '')) {
      durum.ayarlar = await ipcRenderer.invoke('ayar:yaz', { siteLogosu: url });
      durum.logoDamgasi++;   // Adres değişti: önbellekteki kopya geçersiz.
    }
  } catch (e) {
    /* Sessiz geç — logo kozmetiktir. */
  } finally {
    firmaLogosunuUygula();
  }
}

/* --------------------------------------------------------------------------
 *  SÜRÜM — TEK KAYNAK  (package.json → app.getVersion())
 *  --------------------------------------------------------------------------
 *  Sürüm metni arayüzde İKİ yerde görünür: sol menünün dibindeki marka imzası
 *  ve Ayarlar panelindeki künye. Üçüncüsü olan ÜST BAŞLIK kaldırıldı — sol
 *  üstte artık yalnızca firma logosu ve unvanı duruyor.
 *
 *  Kalan ikisi de burada, `app.getVersion()` değerinden yazılır (main.js >
 *  `uygulama:bilgi` ucu paket sürümünü döndürür). index.html'de sürüm metni
 *  KALMADI; yükseltmede düzeltilecek ikinci bir yer yoktur.
 * ------------------------------------------------------------------------*/

/** Paket sürümü — "1.0.3". Bilgi henüz gelmediyse boş dize. */
function surumNumarasi() {
  return String((durum.bilgi && durum.bilgi.surum) || '').trim();
}

/** Sürümü arayüzdeki İKİ yere birden yazar. */
function surumleriYaz() {
  const s = surumNumarasi();

  /* 1) Sol alt marka imzası: "Bu bir BYOM TECH ürünüdür • v1.0.3" */
  const imza = $('#markaImzasi');
  if (imza) imza.textContent = 'Bu bir BYOM TECH ürünüdür' + (s ? (' • v' + s) : '');

  /* 2) Ayarlar panelindeki künye (sürüm · Electron · ayar dosyası yolu) */
  const kunye = $('#ayarDosyaYolu');
  if (kunye && durum.bilgi) {
    kunye.textContent =
      'Sürüm ' + (s || '—') + ' · Electron ' + (durum.bilgi.electron || '—') + '\n' +
      'Ayar dosyası: ' + (durum.bilgi.ayarDosyasi || '—');
    kunye.style.whiteSpace = 'pre-line';
  }
}

function ustCubuguTazele() {
  $('#firmaAdiBaslik').textContent = durum.ayarlar.firmaAdi || 'Firma Adı Girilmedi';
  firmaLogosunuUygula();

  /* --- Lisans rozeti --- */
  const gun = lisansGunSayisi();
  const rozet = $('#lisansRozet');
  let metin, sinif;
  if (gun > 30) {
    metin = 'Aktif — Yıllık Bakım: ' + gun + ' Gün Kaldı';
    sinif = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30';
  } else if (gun > 0) {
    metin = 'Aktif — Yıllık Bakım: ' + gun + ' Gün Kaldı';
    sinif = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30';
  } else {
    metin = 'Bakım Süresi Doldu — Yenileyin';
    sinif = 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30';
  }
  rozet.innerHTML = ikon('nokta', 'ik-nokta') + ' ' + kacis(metin);
  rozet.className = 'hidden sm:flex items-center gap-2 h-12 px-4 rounded-xl font-bold text-base border-2 ' + sinif;

  /* --- API bağlantı rozeti --- */
  const apiRozet = $('#apiRozet');
  let apiMetin, apiSinif;
  if (durum.ayarlar.demoModu) {
    apiMetin = 'DEMO MODU';
    apiSinif = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30';
  } else if (durum.canliBaglantiTamam && durum.b2bVar) {
    apiMetin = 'CANLI — B2B Core Bağlı';
    apiSinif = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30';
  } else if (durum.canliBaglantiTamam) {
    apiMetin = 'CANLI — Eklenti Yok (WooCommerce)';
    apiSinif = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30';
  } else {
    apiMetin = 'CANLI — Bağlantı Yok';
    apiSinif = 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30';
  }
  apiRozet.innerHTML = ikon('nokta', 'ik-nokta') + ' ' + kacis(apiMetin);
  apiRozet.className = 'flex items-center gap-2 h-12 px-4 rounded-xl font-bold text-base border-2 ' + apiSinif;

  /* --- Ayarlar sekmesindeki lisans detayı --- */
  const detay = $('#lisansDetay');
  if (detay) {
    const siteSatiri = durum.siteBilgisi
      ? '<div class="flex justify-between border-b border-slate-200 dark:border-slate-700 py-2">' +
          '<span class="font-bold">Sitedeki Eklenti</span><span>' +
          kacis((durum.siteBilgisi.plugin || 'b2b-core') + ' v' + (durum.siteBilgisi.version || '?')) + '</span></div>'
      : '';

    detay.innerHTML =
      '<div class="flex justify-between border-b border-slate-200 dark:border-slate-700 py-2">' +
        '<span class="font-bold">Durum</span><span>' + ikon('nokta', 'ik-nokta') + ' ' +
        (gun > 0 ? 'Aktif' : 'Süresi Doldu') + '</span></div>' +
      '<div class="flex justify-between border-b border-slate-200 dark:border-slate-700 py-2">' +
        '<span class="font-bold">Bakım Bitiş Tarihi</span><span>' + kacis(tarihYaz(lisansBitisTarihi())) + '</span></div>' +
      '<div class="flex justify-between border-b border-slate-200 dark:border-slate-700 py-2">' +
        '<span class="font-bold">Kalan Süre</span><span>' + Math.max(0, gun) + ' gün</span></div>' +
      siteSatiri;
  }
}

/* ==========================================================================
 *  BÖLÜM 6 — SEKME YÖNETİMİ
 * ========================================================================*/

const AKTIF_MENU = 'bg-marka-700 text-white border-marka-700 shadow-lg';
const PASIF_MENU = 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100 ' +
                   'dark:bg-slate-900/40 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-700';

function sekmeAc(ad) {
  durum.aktifSekme = ad;

  $$('.menu-btn').forEach(function (btn) {
    const aktifMi = btn.dataset.sekme === ad;
    // 'uyeler' ve 'destek' düğmelerinde köşedeki kırmızı sayaç mutlak konumlanır;
    // bu yüzden 'relative' sınıfı korunmalı.
    const sayacli = btn.dataset.sekme === 'uyeler' || btn.dataset.sekme === 'destek';
    btn.className = 'menu-btn text-left px-5 py-6 rounded-2xl font-extrabold text-xl transition border-2 ' +
      (sayacli ? 'relative ' : '') + (aktifMi ? AKTIF_MENU : PASIF_MENU);
  });

  $$('.sekme-govde').forEach(function (bolum) {
    bolum.classList.toggle('acik', bolum.id === 'sekme-' + ad);
  });

  /*
   * GELİŞTİRİCİ KİLİDİ — sekme açılır ama içerik perdenin arkasında kalır ve
   * hemen şifre penceresi gelir. Sekmeyi hiç açmamak yerine perdeyi göstermek
   * bilinçli bir tercih: kullanıcı tıkladığı yerin NE olduğunu ve neden
   * kapalı olduğunu görür, tıklaması sessizce yutulmuş olmaz.
   */
  if (ad === 'ayarlar') {
    masterKilidiUygula();
    if (!durum.masterKilitAcik) masterKilidiSor();
  }

  // Sekmeye ilk girişte veriyi getir
  if (ad === 'siparisler' && durum.siparisler.length === 0) siparisleriYukle();
  if (ad === 'urunler' && durum.urunler.length === 0) urunleriYukle();
  if (ad === 'uyeler' && durum.uyeler.length === 0) uyeleriYukle();
  if (ad === 'iskonto' && !durum.iskontoYuklendi && typeof iskontoSekmesiYukle === 'function') {
    iskontoSekmesiYukle();
  }
  if (ad === 'vitrin' && !durum.vitrin.yuklendi && typeof vitrinSekmesiYukle === 'function') {
    vitrinSekmesiYukle();
  }
  // BYOM 2.0 Vitrin Editörü (renderer-vitrin.js): ilk açılışta siteden düzeni çeker.
  if (ad === 'vitrin-editor' && typeof vitrinEditorAc === 'function') {
    vitrinEditorAc();
  }

  otoYenileyiAyarla();
}

/* ==========================================================================
 *  BÖLÜM 7 — SİPARİŞLER (canlı kontrol + durum güncelleme)
 * ========================================================================*/

/**
 * [Aktif Siparişler] [Kargodakiler] [Teslim Edilenler] sekmelerini çizer.
 *
 * Sekmeler süzgeçlerden AYRI bir katmandır: süzgeç sekmenin içini daraltır,
 * sekme ise hangi sipariş kümesinin sunucudan çekileceğini belirler.
 */
function siparisSekmeleriCiz() {
  const kap = $('#siparisSekmeler');
  if (!kap) return;

  kap.innerHTML = SIPARIS_SEKMELERI.map(function (t) {
    const aktif = t.kod === durum.siparisSekme;

    /* Sayaç yalnızca AÇIK sekme için gösterilir: diğer sekmelerin adedi
       sunucuya ek istek atmadan bilinemez ve tahmini bir sayı yazmak
       kullanıcıyı yanıltırdı. */
    const sayac = aktif && durum.siparislerToplam
      ? ' <span class="ml-2 px-2 py-0.5 rounded-lg text-base bg-white/25">' + durum.siparislerToplam + '</span>'
      : '';

    return '<button data-siparis-sekme="' + kacis(t.kod) + '" ' +
           'title="' + kacis(t.aciklama) + '" ' +
           'class="h-16 px-6 rounded-2xl border-2 text-xl font-extrabold transition active:scale-95 ' +
           (aktif
             ? 'bg-marka-700 text-white border-marka-700 shadow-lg'
             : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 ' +
               'dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700') +
           '">' + t.simge + ' ' + kacis(t.etiket) + sayac + '</button>';
  }).join('');
}

/** Sipariş listesi üstündeki durum süzgeci düğmelerini çizer. */
function siparisSuzgecleriCiz() {
  const kap = $('#siparisSuzgecler');
  const tumu = (durum.ayarlar.demoModu || durum.b2bVar) ? SIPARIS_SUZGECLERI_B2B : SIPARIS_SUZGECLERI_WOO;

  /* Süzgeç, AÇIK SEKMENİN içini daraltır. Sekmede bulunmayan bir durumu
     süzgeç olarak sunmak boş liste üretirdi (ör. [Kargodakiler] sekmesinde
     "Sipariş Hazır" süzgeci). "Tümü" her zaman kalır. */
  const tanim = sekmeTanimi(durum.siparisSekme);
  const izin = tanim.durumlar.concat(tanim.durumlar.map(durumNormalle));

  const liste = tumu.filter(function (f) {
    return f.kod === '' || izin.indexOf(f.kod) !== -1;
  });

  /* Tek durumlu sekmede süzgeç şeridi bilgi taşımaz; gizlenir. */
  if (liste.length <= 2) {
    kap.innerHTML = '';
    durum.siparisSuzgec = '';
    return;
  }

  // Geçerli olmayan bir süzgeç kaldıysa sıfırla
  if (!liste.some(function (f) { return f.kod === durum.siparisSuzgec; })) durum.siparisSuzgec = '';

  kap.innerHTML = liste.map(function (f) {
    const aktif = f.kod === durum.siparisSuzgec;
    return '<button data-suzgec="' + kacis(f.kod) + '" ' +
           'class="h-12 px-5 rounded-xl border-2 text-lg font-bold transition active:scale-95 ' +
           (aktif
             ? 'bg-marka-700 text-white border-marka-700 shadow-md'
             : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 ' +
               'dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700') +
           '">' + f.simge + ' ' + kacis(f.etiket) + '</button>';
  }).join('');
}

/** Teslim durumu süzgeci düğmelerini çizer. */
function teslimSuzgecleriCiz() {
  const kap = $('#teslimSuzgecler');
  if (!kap) return;

  kap.innerHTML = TESLIM_SUZGECLERI.map(function (f) {
    const aktif = f.kod === durum.teslimSuzgec;
    return '<button data-teslim-suzgec="' + kacis(f.kod) + '" ' +
           'class="h-12 px-5 rounded-xl border-2 text-lg font-bold transition active:scale-95 ' +
           (aktif
             ? 'bg-slate-800 text-white border-slate-800 shadow-md ' +
               'dark:bg-slate-200 dark:text-slate-900 dark:border-slate-200'
             : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 ' +
               'dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700') +
           '">' + f.simge + ' ' + kacis(f.etiket) + '</button>';
  }).join('');
}

/** "Son kontrol: 10:42:15" yazısını tazeler. */
function sonKontrolTazele() {
  const kutu = $('#siparisSonKontrol');
  if (!kutu) return;
  kutu.textContent = durum.sonKontrol ? 'Son kontrol: ' + saatYaz(durum.sonKontrol) : '';
}

/**
 * Siparişleri getirir.
 * @param {boolean} sessizMi Otomatik yenilemede ekranı "yükleniyor" yapmadan tazeler.
 */
async function siparisleriYukle(sessizMi) {
  /*
   * YARIŞ KOŞULU KORUMASI
   *
   * Eskiden devam eden bir yükleme varken çağrı sessizce yutuluyordu; sekme
   * değiştirildiğinde kullanıcının isteği düşüyor, arka plandaki eski turun
   * sonucu ise boşaltılmış listeye yazılıp bütün kayıtları "yeni sipariş"
   * sanarak sahte bildirim üretiyordu.
   *
   * Artık ürün tarafındaki bilet düzeni kullanılır: her çağrı bir bilet alır,
   * await sonrası bileti hâlâ geçerli olmayan tur hiçbir şey yazmaz. Sessiz
   * (otomatik) tur, kullanıcı isteği geldiğinde kendiliğinden iptal olur.
   */
  const bilet = ++durum.siparisYuklemeBileti;

  /* Kullanıcı isteği, süren sessiz turu ezer; sessiz tur ise sırasını bekler
     yerine tamamen atlanır (bir sonraki turda zaten tekrar gelecek). */
  if (durum.siparisYukleniyor && sessizMi) return;

  /*
   * Revize penceresi açıkken otomatik yenileme YAPILMAZ: depocu adetleri
   * girerken liste altından değişir, `durum.revizeSiparis` eski nesneye
   * işaret etmeye devam eder ve onaydan sonra tazelenmiş liste eski verilerle
   * geri yazılabilirdi.
   */
  if (sessizMi && durum.revizeSiparis) return;

  durum.siparisYukleniyor = true;

  /** Bu tur hâlâ güncel mi? Değilse yazma yapılmamalı. */
  const guncelMi = function () {
    return bilet === durum.siparisYuklemeBileti;
  };

  const kap = $('#siparisListesi');
  const oncekiIdler = durum.siparisler.map(function (s) { return String(s.id); });

  if (!sessizMi) kap.innerHTML = yukleniyorHtml('Siparişler getiriliyor…');

  try {
    /* ---------- DEMO ---------- */
    if (durum.ayarlar.demoModu) {
      if (!sessizMi) await bekle(250);
      durum.b2bVar = true;

      const sekme = sekmeTanimi(durum.siparisSekme);

      const tumu = DEMO_SIPARISLER
        .map(function (s) { return JSON.parse(JSON.stringify(s)); })
        /* Demo verisi de sekmeye göre süzülür; aksi halde üç sekme de aynı
           listeyi gösterir ve sunum yanıltıcı olur. */
        .filter(function (s) { return sekme.durumlar.indexOf(String(s.durum)) !== -1; });

      durum.siparisler = durum.siparisSuzgec
        ? tumu.filter(function (s) { return durumNormalle(s.durum) === durumNormalle(durum.siparisSuzgec); })
        : tumu;

      durum.siparislerToplam = durum.siparisler.length;
      durum.siparislerKesildi = false;
      durum.sonKontrol = new Date();

      siparisSekmeleriCiz();
      siparisSuzgecleriCiz();
      siparisleriCiz();
      sonKontrolTazele();
      return;
    }

    /* ---------- CANLI ---------- */
    if (!durum.eklentiTanindi) {
      await eklentiyiTani();
      durum.eklentiTanindi = true;
    }

    const alan = durum.b2bVar ? 'b2b' : 'woo';
    const sekme = sekmeTanimi(durum.siparisSekme);

    /*
     * SEKME → SORGU
     *
     * Eklenti varsa yalnızca `group` gönderilir: sekmenin hangi durumları
     * kapsadığı SUNUCUDA tanımlıdır (b2b_get_order_status_groups), böylece
     * akışa bir adım eklendiğinde masaüstünü güncellemek gerekmez.
     * Süzgeç seçiliyse tek durum gönderilir ve grubu ezer.
     *
     * Eklenti yoksa wc/v3 `group` bilmez; sekmenin WooCommerce karşılığı olan
     * durumlar virgüllü liste olarak gönderilir.
     */
    let sorgu;

    if (durum.b2bVar) {
      sorgu = durum.siparisSuzgec
        ? { status: durum.siparisSuzgec }
        : (sekme.grupYok
            ? { status: sekme.durumlar.join(',') }   // Eklentinin grup adı olmayan sekme
            : { group: sekme.kod });
    } else {
      sorgu = {
        orderby: 'date',
        order: 'desc',
        status: durum.siparisSuzgec || sekme.wooDurumlar.join(',') || 'any'
      };
    }

    const normalle = durum.b2bVar ? b2bSiparisNormalle : siparisNormalle;

    /*
     * SESSIZ YENILEME (otomatik) — YALNIZCA ILK SAYFA
     * -----------------------------------------------
     * Otomatik yenileme birkaç saniyede bir çalışır. Her seferinde onlarca
     * sayfa istemek siteyi gereksiz yere yorar; üstelik değişen şey neredeyse
     * her zaman EN YENI siparişlerdir (liste tarihe göre azalan sıralıdır).
     * Bu yüzden sessiz turda tek sayfa çekilip mevcut listeyle BIRLESTIRILIR;
     * elde tutulan geçmiş siparişler silinmez.
     *
     * NEDEN YALNIZCA SUZGECSIZ LISTEDE?
     * Süzgeç açıkken bir siparişin durumu değişip süzgecin DISINA çıkabilir.
     * Birleştirme yalnızca ekler/tazeler, çıkaramaz; o sipariş listede hayalet
     * gibi asılı kalırdı. Süzgeçli liste zaten çok daha kısadır (çoğunlukla
     * tek sayfa), bu yüzden orada tam yükleme yapılır.
     *
     * SEKMELER SONRASI EK ÖNLEM
     * Artık süzgeçsiz liste de bir KÜMEDIR (ör. yalnızca kargolanmamışlar);
     * bir sipariş kargoya verildiğinde bu kümeden ÇIKAR. Bu yüzden
     * birleştirmenin ardından liste sekmenin durum kümesine göre yeniden
     * süzülür: ilk sayfada dönen ve artık sekmeye ait olmayan siparişler
     * anında düşer.
     *
     * ACIK YUKLEME (ilk açılış, YENİLE, sekme/süzgeç değişimi) — TAM LISTE.
     */
    if (sessizMi && durum.siparisler.length && !durum.siparisSuzgec) {
      const tekSayfa = await (alan === 'b2b' ? b2b : woo)('orders', {
        sorgu: Object.assign({}, sorgu, { per_page: SAYFA_BOYU, page: 1 })
      });

      /* Bu tur beklerken kullanıcı sekme değiştirdiyse sonuç YAZILMAZ. */
      if (!guncelMi()) return;

      if (!tekSayfa.ok) {
        durum.canliBaglantiTamam = false;
        ustCubuguTazele();
        return;
      }

      durum.canliBaglantiTamam = true;
      ustCubuguTazele();

      const taze = (tekSayfa.veri || []).map(normalle);
      const yerler = {};

      durum.siparisler.forEach(function (s, i) { yerler[String(s.id)] = i; });

      const yeniler = [];

      taze.forEach(function (s) {
        const yer = yerler[String(s.id)];

        if (yer === undefined) {
          yeniler.push(s);            // Yeni sipariş
        } else {
          durum.siparisler[yer] = s;  // Durumu/tutarı tazele
        }
      });

      // Liste tarihe göre azalan: yeni siparişler en başa girer.
      if (yeniler.length) durum.siparisler = yeniler.concat(durum.siparisler);

      /* Durumu değişip bu sekmeden çıkmış siparişleri düşür (ör. kargoya
         verilen bir sipariş [Aktif Siparişler] listesinde kalmasın). */
      durum.siparisler = durum.siparisler.filter(function (s) {
        return sekme.durumlar.indexOf(String(s.durum)) !== -1;
      });

      durum.siparislerToplam = Number(tekSayfa.toplam) || durum.siparisler.length;
      durum.sonKontrol = new Date();

      siparisSekmeleriCiz();
      siparisSuzgecleriCiz();
      siparisleriCiz();
      sonKontrolTazele();

      if (yeniler.length && oncekiIdler.length) {
        bildir(yeniler.length + ' yeni sipariş geldi!\n' +
               yeniler.slice(0, 3).map(function (s) { return '#' + s.numara + ' · ' + (s.firma || s.musteri); }).join('\n'),
               'basari');
      }

      return;
    }

    const cevap = await tumSayfalariGetir(alan, 'orders', sorgu, {
      sureAsimi: 30000,
      enFazlaSayfa: SIPARIS_SAYFA_TAVANI,
      ilerleme: function (alinan, toplam) {
        if (sessizMi || !guncelMi()) return;

        kap.innerHTML = yukleniyorHtml(
          toplam > alinan
            ? 'Siparişler getiriliyor…  ' + alinan + ' / ' + toplam
            : 'Siparişler getiriliyor…  ' + alinan + ' sipariş'
        );
      }
    });

    /* Bu tur beklerken kullanıcı sekme değiştirdiyse sonuç YAZILMAZ. */
    if (!guncelMi()) return;

    if (!cevap.ok) {
      durum.canliBaglantiTamam = false;
      ustCubuguTazele();
      if (!sessizMi) {
        durum.siparisler = [];
        durum.siparislerToplam = 0;
        kap.innerHTML = bosHtml(ikon('priz'), 'Siparişler alınamadı', cevap.hata);
        $('#ozetToplam').textContent = '—';
        $('#ozetBekleyen').textContent = '—';
        $('#ozetTutar').textContent = '—';
      }
      return;
    }

    durum.canliBaglantiTamam = true;
    ustCubuguTazele();

    durum.siparisler = (cevap.veri || []).map(normalle);
    durum.siparislerToplam = Number(cevap.toplam) || durum.siparisler.length;
    durum.siparislerKesildi = !!cevap.kesildi;
    durum.sonKontrol = new Date();

    siparisSekmeleriCiz();
    siparisSuzgecleriCiz();
    siparisleriCiz();
    sonKontrolTazele();

    /* Sessiz yenilemede yeni sipariş geldiyse haber ver */
    if (sessizMi && oncekiIdler.length) {
      const yeniler = durum.siparisler.filter(function (s) {
        return oncekiIdler.indexOf(String(s.id)) === -1;
      });
      if (yeniler.length) {
        bildir(yeniler.length + ' yeni sipariş geldi!\n' +
               yeniler.slice(0, 3).map(function (s) { return '#' + s.numara + ' · ' + (s.firma || s.musteri); }).join('\n'),
               'basari');
      }
    }

    /* Liste eksikse SESSIZCE geçilmez: özet kartlar yanıltıcı olurdu. */
    if (!sessizMi && cevap.eksik) {
      bildir('Siparişlerin tamamı getirilemedi.\n' +
             durum.siparisler.length + ' / ' + durum.siparislerToplam + ' sipariş yüklendi: ' +
             (cevap.hata || '') + '\nYENİLE ile tekrar deneyin.', 'uyari');
    } else if (!sessizMi && cevap.kesildi) {
      bildir('En yeni ' + durum.siparisler.length + ' sipariş yüklendi.\n' +
             'Sitenizde toplam ' + durum.siparislerToplam + ' sipariş var; daha eskileri\n' +
             'listelenmedi. Aradığınız siparişi bulmak için durum süzgecini kullanın.', 'bilgi');
    }
  } finally {
    durum.siparisYukleniyor = false;
  }
}

/** Tek bir sipariş kalemini (detay tablosu satırı) çizer. */
function kalemSatiriHtml(k) {
  return '' +
  '<tr class="border-b border-slate-200 dark:border-slate-700">' +
    '<td class="py-2 pr-2 w-14">' +
      '<img src="' + kacis(k.gorsel || YEDEK_GORSEL) + '" alt="" loading="lazy" ' +
           'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" ' +
           'class="w-12 h-12 rounded-lg object-cover bg-slate-100 dark:bg-slate-700" /></td>' +
    '<td class="py-2 pr-3 font-bold">' + kacis(k.ad) + '</td>' +
    '<td class="py-2 pr-3 font-mono text-base text-slate-500 dark:text-slate-400 whitespace-nowrap">' + kacis(k.kod) + '</td>' +
    '<td class="py-2 pr-3 text-right font-black whitespace-nowrap">' + k.adet + ' adet</td>' +
    '<td class="py-2 pr-3 text-right whitespace-nowrap">' + kacis(para(k.birim)) + '</td>' +
    '<td class="py-2 text-right font-black whitespace-nowrap">' + kacis(para(k.tutar)) + '</td>' +
  '</tr>';
}

/** Akıştaki adım sırası (geçmiş/gelecek ayrımı için). */
const AKIS_SIRASI = ['processing', 'order-ready', 'shipped', 'delivered'];

function akisSirasi(kod) {
  return AKIS_SIRASI.indexOf(durumNormalle(kod));
}

/** Sipariş kartındaki tek-tık durum düğmesi. */
function durumDugmesiHtml(s, tanim) {
  const hedef = durum.b2bVar ? tanim.kod : tanim.yedek;
  const aktifMi = durumNormalle(s.durum) === durumNormalle(hedef);

  /* Siparişin şu anki adımından ÖNCEKİ adımlar soluk gösterilir: yanlışlıkla
     geri alma riski azalır ama düzeltme yapmak hâlâ mümkündür. */
  const suAn = akisSirasi(s.durum);
  const bu = akisSirasi(hedef);
  const gecmisMi = !aktifMi && suAn > -1 && bu > -1 && bu < suAn;

  let sinif;
  if (aktifMi) {
    sinif = 'bg-slate-400 dark:bg-slate-600 cursor-default ring-4 ring-slate-300 dark:ring-slate-500';
  } else if (gecmisMi) {
    sinif = tanim.renk + ' opacity-40 hover:opacity-100';
  } else {
    sinif = tanim.renk;
  }

  const ipucu = gecmisMi
    ? 'Geri alma: ' + tanim.aciklama
    : tanim.aciklama;

  return '<button data-eylem="durum" data-id="' + s.id + '" data-hedef="' + kacis(tanim.kod) + '" ' +
         (aktifMi ? 'disabled ' : '') +
         'title="' + kacis(ipucu) + '" ' +
         'class="h-14 px-5 rounded-2xl text-white text-lg font-extrabold shadow-md transition active:scale-95 ' +
         sinif +
         '">' + tanim.simge + ' ' + kacis(tanim.etiket) + (aktifMi ? ' ' + ikon('onay', 'ik-sm') : '') + '</button>';
}

function siparisleriCiz() {
  const kap = $('#siparisListesi');

  /* Teslim süzgeci yereldir: sunucudan gelen liste süzülüp öyle çizilir.
     Özet kartlar da ekranda GÖRÜNEN listeyi anlatsın diye süzgeçten sonra hesaplanır. */
  const liste = durum.teslimSuzgec
    ? durum.siparisler.filter(function (s) { return teslimKodu(s) === durum.teslimSuzgec; })
    : durum.siparisler;

  /* Özet kartlar — "hazırlanmayı bekleyen" = akışın ilk adımındakiler. */
  const bekleyen = liste.filter(function (s) {
    const n = durumNormalle(s.durum);
    return n === 'processing' || n === 'pending' || n === 'on-hold';
  }).length;
  const toplamTutar = liste.reduce(function (t, s) {
    return t + (s.durum === 'cancelled' || s.durum === 'refunded' || s.durum === 'failed' ? 0 : s.tutar);
  }, 0);

  $('#ozetToplam').textContent = liste.length;
  $('#ozetBekleyen').textContent = bekleyen;
  $('#ozetTutar').textContent = para(toplamTutar);

  if (liste.length === 0) {
    if (durum.teslimSuzgec) {
      const teslimTanim = TESLIM_SUZGECLERI.filter(function (f) { return f.kod === durum.teslimSuzgec; })[0];
      kap.innerHTML = bosHtml(ikon('kamyon'),
        'Bu teslim durumunda sipariş yok',
        'Süzgeç: ' + ((teslimTanim && teslimTanim.etiket) || durum.teslimSuzgec) + '\n' +
        '"Teslim: Tümü" düğmesiyle bütün siparişleri görebilirsiniz.');
      return;
    }

    const sekme = sekmeTanimi(durum.siparisSekme);

    if (durum.siparisSuzgec) {
      kap.innerHTML = bosHtml(ikon('kutuBos'), 'Bu durumda sipariş yok',
        'Süzgeci "Tümü" yaparak bu sekmedeki bütün siparişleri görebilirsiniz.');
      return;
    }

    const bosMetin = {
      active: 'Hazırlanmayı bekleyen sipariş yok.\nYeni sipariş geldiğinde burada listelenecek.',
      shipped: 'Şu an yolda olan sipariş yok.\nBir siparişi "KARGOYA VERİLDİ" yaptığınızda buraya düşer.',
      delivered: 'Henüz teslim edilmiş sipariş yok.\nBayi web sitesinden "Siparişi Teslim Aldım" dediğinde sipariş buraya geçer.'
    };

    kap.innerHTML = bosHtml(sekme.simge, sekme.etiket + ': kayıt yok',
      bosMetin[sekme.kod] || 'Sitenize sipariş geldiğinde burada listelenecek.');
    return;
  }

  kap.innerHTML = liste.map(function (s) {
    const d = durumBilgisi(s.durum);
    const etiket = s.durumEtiketi || d.etiket;
    const adetToplam = s.kalemler.reduce(function (t, k) { return t + k.adet; }, 0);

    const kargoBilgisi = (s.kargo || s.takip)
      ? '<div class="text-base font-bold text-sky-700 dark:text-sky-300 mt-1">' +
          ikon('kamyon') + ' ' + kacis(s.kargo || 'Kargo') + (s.takip ? ' · Takip: ' + kacis(s.takip) : '') +
        '</div>'
      : '';

    return '' +
    '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 ' +
         'shadow-sm hover:shadow-md transition p-5 flex flex-col gap-4" data-siparis="' + s.id + '">' +

      /* --- Üst satır: özet --- */
      '<div class="flex flex-col lg:flex-row lg:items-center gap-5">' +

        '<div class="shrink-0 w-full lg:w-36">' +
          '<div class="text-sm font-bold text-slate-400">SİPARİŞ NO</div>' +
          '<div class="text-2xl font-black">#' + kacis(s.numara) + '</div>' +
        '</div>' +

        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 flex-wrap">' +
            /* Alıcı rolü rozeti: mavi [MÜŞTERİ] / yeşil [BAYİ] */
            aliciRozetiHtml(s) +
            '<span class="min-w-0 text-xl font-extrabold truncate">' + kacis(s.firma || s.musteri) + '</span>' +
          '</div>' +
          (s.firma ? '<div class="text-base font-semibold text-slate-500 dark:text-slate-400 truncate">' +
             ikon('kisi') + ' ' + kacis(s.musteri) + '</div>' : '') +
          '<div class="text-base text-slate-500 dark:text-slate-400 mt-1">' +
            ikon('takvim') + ' ' + kacis(tarihYaz(s.tarih, true)) +
            '  ·  ' + ikon('paket') + ' ' + s.kalemler.length + ' çeşit / ' + adetToplam + ' adet' +
            (s.telefon ? '  ·  ' + ikon('telefon') + ' ' + kacis(s.telefon) : '') +
          '</div>' +
          kargoBilgisi +
        '</div>' +

        '<div class="shrink-0 lg:text-right">' +
          '<div class="text-2xl font-black text-emerald-600 dark:text-emerald-400">' + kacis(para(s.tutar)) + '</div>' +
          '<span class="inline-block mt-1 px-3 py-1 rounded-lg border-2 text-base font-bold ' + d.sinif + '">' +
            kacis(etiket) + '</span>' +
          /* Sipariş türü rozeti — renderer-ek.js içinde tanımlıdır (Nakit / Kredi Kartı / Vadeli) */
          (typeof siparisOdemeRozetiHtml === 'function' ? siparisOdemeRozetiHtml(s) : '') +
          /* Kredi kartı tahsilatı: [POS Onaylı] + banka provizyon kodu */
          '<div>' + posRozetiHtml(s) + '</div>' +
          /* Depoda adet düzeltmesi yapıldıysa */
          '<div>' + revizeRozetiHtml(s) + '</div>' +
          /* Müşterinin web sitesinden verdiği teslim cevabı */
          '<div>' + teslimRozetiHtml(s) + '</div>' +
        '</div>' +
      '</div>' +

      /* --- Alt satır: eylem düğmeleri --- */
      '<div class="flex flex-wrap gap-3 pt-4 border-t-2 border-dashed border-slate-200 dark:border-slate-700">' +

        /* Depocu koli düzenlemesi: yalnızca henüz kargolanmamış siparişlerde. */
        (revizeEdilebilirMi(s)
          ? '<button data-eylem="siparis-revize" data-id="' + s.id + '" ' +
                    'title="Koliye fiilen konulan adetleri girin; tutar ve KDV yeniden hesaplanır." ' +
                    'class="h-14 px-5 rounded-2xl bg-marka-700 hover:bg-marka-800 active:scale-95 ' +
                           'text-white text-lg font-extrabold shadow-md transition">' +
              ikon('kalem') + ' SİPARİŞİ HAZIRLA &amp; REVİZE ET' +
            '</button>'
          : '') +

        DURUM_DUGMELERI.map(function (t) { return durumDugmesiHtml(s, t); }).join('') +

        '<button data-eylem="fis" data-id="' + s.id + '" ' +
                'class="h-14 px-5 rounded-2xl bg-red-600 hover:bg-red-700 active:scale-95 ' +
                       'text-white text-lg font-extrabold shadow-md transition">' +
          ikon('yazici') + ' DEPO FİŞİ' +
        '</button>' +

        (s.bayiId
          ? '<button data-eylem="siparis-bayi" data-id="' + s.bayiId + '" ' +
                    'class="h-14 px-5 rounded-2xl bg-slate-700 hover:bg-slate-800 active:scale-95 ' +
                           'text-white text-lg font-extrabold shadow-md transition">' + ikon('bina') + ' BAYİ KARTI</button>'
          : '') +

        /* İptal: sipariş silinmez, "Sipariş İptal Edildi" durumuna alınır.
           Zaten iptal/iade edilmiş siparişte düğme gösterilmez. */
        (['cancelled', 'refunded'].indexOf(String(s.durum)) === -1
          ? '<button data-eylem="siparis-iptal" data-id="' + s.id + '" ' +
                    'title="Siparişi iptal et (durum: Sipariş İptal Edildi)" ' +
                    'class="h-14 px-5 rounded-2xl border-2 border-red-300 dark:border-red-500/40 ' +
                           'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 ' +
                           'hover:bg-red-100 dark:hover:bg-red-500/20 active:scale-95 ' +
                           'text-lg font-extrabold shadow-sm transition">' + ikon('yasak') + ' SİPARİŞİ İPTAL ET</button>'
          : '') +

        /* Kalıcı silme — YALNIZCA iptal edilmiş siparişlerde görünür.
           Sipariş sitedeki veritabanından tamamen kaldırılır (force=true),
           çöp kutusuna bile düşmez; bu yüzden ayrı ve koyu kırmızıdır. */
        (durumNormalle(s.durum) === 'cancelled'
          ? '<button data-eylem="siparis-sil" data-id="' + s.id + '" ' +
                    'title="Siparişi sitenizden KALICI olarak siler. Bu işlem geri alınamaz." ' +
                    'class="h-14 px-5 rounded-2xl bg-red-700 hover:bg-red-800 active:scale-95 ' +
                           'text-white text-lg font-extrabold shadow-md transition">' +
              ikon('cop') + ' SİPARİŞİ KALICI SİL</button>'
          : '') +

        '<button data-eylem="siparis-detay" data-id="' + s.id + '" ' +
                'class="ml-auto h-14 px-5 rounded-2xl border-2 border-slate-300 dark:border-slate-600 ' +
                       'bg-slate-50 dark:bg-slate-900 text-lg font-extrabold transition ' +
                       'hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-95">' +
          ikon('liste') + ' ÜRÜN DÖKÜMÜ' +
        '</button>' +
      '</div>' +

      /* --- Ürün dökümü (açılır) --- */
      '<div data-detay="' + s.id + '" class="hidden">' +
        '<table class="w-full text-lg">' +
          '<tbody>' + s.kalemler.map(kalemSatiriHtml).join('') + '</tbody>' +
        '</table>' +
        (s.notlar
          ? '<div class="mt-3 rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-500/40 ' +
                'bg-amber-50 dark:bg-amber-500/10 p-4 text-lg">' +
              '<b>' + ikon('not') + ' Sipariş Notu:</b> ' + kacis(s.notlar) + '</div>'
          : '') +
      '</div>' +

    '</div>';
  }).join('');
}

/** Sipariş kartındaki ürün dökümünü açar/kapatır. */
function siparisDetayiDegistir(id) {
  const kutu = document.querySelector('[data-detay="' + id + '"]');
  if (kutu) kutu.classList.toggle('hidden');
}

/* ==========================================================================
 *  SİPARİŞ REVİZESİ — DEPOCU KOLİ DÜZENLEME PENCERESİ
 *  --------------------------------------------------------------------------
 *  Müşteri 25 adet istedi ama depocu koli bozmadığı için 20 adet koyduysa,
 *  fiili adet buradan girilir. "SİPARİŞİ ONAYLA" denildiğinde:
 *
 *    POST /wc-b2b/v1/orders/<id>/revise   { items, status: 'order-ready' }
 *
 *  Sunucu birim fiyatı koruyarak satır toplamlarını yeniden kurar, KDV'yi
 *  vergi oranlarından hesaplar, stoğu düzeltir ve durumu "Sipariş Hazır"
 *  yapar. Eklenti yoksa aynı iş wc/v3 üzerinden yapılır; o yolda satır
 *  toplamları İSTEMCİDE hesaplanıp gönderilir, çünkü WooCommerce yalnızca
 *  "quantity" gönderildiğinde tutarı yeniden hesaplamaz.
 * ========================================================================*/

/** Bu sipariş revize edilebilir mi? (kargoya verilmiş sipariş düzenlenemez) */
function revizeEdilebilirMi(s) {
  if (!s) return false;

  /* Sunucu açıkça söylediyse ona uyulur. */
  if (s.revizeEdilebilir === true) return true;
  if (s.revizeEdilebilir === false) return false;

  /* Bilgi yoksa (demo / eklentisiz yedek yol) akıştaki konuma bakılır. */
  const n = durumNormalle(s.durum);
  return ['processing', 'order-ready', 'pending', 'on-hold'].indexOf(n) !== -1;
}

/** Sipariş kartındaki "revize edildi" rozeti. */
function revizeRozetiHtml(s) {
  if (!s || !s.revize) return '';

  const ipucu = s.revizeTarih
    ? ' title="' + kacis('Depoda güncellendi: ' + tarihYaz(s.revizeTarih, true)) + '"'
    : ' title="Sipariş adetleri depoda güncellendi"';

  return '<span' + ipucu + ' class="inline-block mt-1 px-3 py-1 rounded-lg border-2 ' +
         'text-base font-bold whitespace-nowrap ' +
         'bg-amber-100 text-amber-800 border-amber-300 ' +
         'dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30">' +
         ikon('kalem') + ' Revize Edildi</span>';
}

/** Revize penceresini kapatır. */
function revizeModaliKapat() {
  const katman = $('#revizeModalKatman');
  if (katman) katman.classList.add('hidden');
  durum.revizeSiparis = null;
}

/** Penceredeki adet kutularından güncel değerleri okur. */
function revizeSatirlariOku() {
  const satirlar = $$('#revizeGovde [data-revize-satir]');

  return satirlar.map(function (satir) {
    const girdi = satir.querySelector('[data-revize-adet]');
    const ham = girdi ? girdi.value : '';
    const adet = Math.max(0, Math.floor(Number(ham)));

    return {
      kalemId: Number(satir.dataset.revizeSatir),
      adet: isNaN(adet) ? 0 : adet,
      eskiAdet: Number(satir.dataset.eskiAdet || 0),
      birim: Number(satir.dataset.birim || 0),
      birimAra: Number(satir.dataset.birimAra || 0)
    };
  });
}

/** Pencerenin altındaki canlı toplamı tazeler. */
function revizeToplamiTazele() {
  const kutu = $('#revizeToplam');
  if (!kutu) return;

  const satirlar = revizeSatirlariOku();

  let toplam = 0;
  let degisen = 0;
  let adetToplam = 0;

  satirlar.forEach(function (r) {
    toplam += r.birim * r.adet;
    adetToplam += r.adet;
    if (r.adet !== r.eskiAdet) degisen++;
  });

  /* Her satırın kendi tutarını da tazele */
  satirlar.forEach(function (r) {
    const hucre = document.querySelector('[data-revize-satir="' + r.kalemId + '"] [data-revize-tutar]');
    if (hucre) hucre.textContent = para(r.birim * r.adet);

    const satir = document.querySelector('[data-revize-satir="' + r.kalemId + '"]');
    if (!satir) return;

    /* Değişen satır vurgulanır; 0 adet olan satır soluklaşır. */
    satir.classList.toggle('bg-amber-50', r.adet !== r.eskiAdet && r.adet > 0);
    satir.classList.toggle('dark:bg-amber-500/10', r.adet !== r.eskiAdet && r.adet > 0);
    satir.classList.toggle('opacity-50', r.adet === 0);
  });

  kutu.innerHTML =
    '<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1">' +
      '<span class="text-lg font-bold text-slate-500 dark:text-slate-400">' +
        'Toplam adet: <span class="text-slate-900 dark:text-slate-100 font-black">' + adetToplam + '</span>' +
      '</span>' +
      '<span class="text-lg font-bold text-slate-500 dark:text-slate-400">' +
        'Değişen satır: <span class="' + (degisen ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100') +
        ' font-black">' + degisen + '</span>' +
      '</span>' +
      '<span class="ml-auto text-2xl font-black text-emerald-600 dark:text-emerald-400">' +
        kacis(para(toplam)) +
      '</span>' +
    '</div>' +
    '<div class="text-base text-slate-500 dark:text-slate-400 mt-1">' +
      'KDV ve genel toplam onaydan sonra sitede yeniden hesaplanır (yukarıdaki tutar KDV hariç ara toplamdır).' +
    '</div>';
}

/**
 * Revize penceresini açar.
 * @param {string|number} id Sipariş kimliği.
 */
function revizeModaliAc(id) {
  const s = siparisBul(id);

  if (!s) {
    bildir('Sipariş bulunamadı. Listeyi yenileyip tekrar deneyin.', 'uyari');
    return;
  }

  if (!revizeEdilebilirMi(s)) {
    bildir('Bu sipariş revize edilemez.\nKargoya verilmiş siparişlerin içeriği değiştirilemez.', 'uyari');
    return;
  }

  if (!s.kalemler.length) {
    bildir('Bu siparişte ürün yok.', 'uyari');
    return;
  }

  /* Eklenti yokken kalem kimliği gelmeyebilir; onsuz satır güncellenemez. */
  const kimliksiz = s.kalemler.filter(function (k) { return !k.kalemId; }).length;

  if (kimliksiz) {
    bildir('Sipariş kalemleri kimlikleri olmadan geldi; revize yapılamıyor.\n' +
           'YENİLE ile listeyi tazeleyin.', 'hata');
    return;
  }

  durum.revizeSiparis = s;

  $('#revizeModalBaslik').textContent = 'Siparişi Hazırla & Revize Et';
  $('#revizeModalAciklama').textContent =
    '#' + s.numara + ' · ' + (s.firma || s.musteri) +
    '  ·  ' + s.kalemler.length + ' çeşit';

  $('#revizeGovde').innerHTML =
    '<div class="overflow-x-auto rounded-2xl border-2 border-slate-200 dark:border-slate-700">' +
      '<table class="w-full text-lg">' +
        '<thead class="bg-slate-100 dark:bg-slate-900/60">' +
          '<tr class="text-left">' +
            '<th class="p-3 font-black">ÜRÜN</th>' +
            '<th class="p-3 font-black whitespace-nowrap">STOK KODU</th>' +
            '<th class="p-3 font-black text-center whitespace-nowrap">İSTENEN</th>' +
            '<th class="p-3 font-black text-center whitespace-nowrap">KOLİYE KONULAN</th>' +
            '<th class="p-3 font-black text-right whitespace-nowrap">TUTAR</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' +
          s.kalemler.map(function (k) {
            return '' +
            '<tr data-revize-satir="' + k.kalemId + '" ' +
                'data-eski-adet="' + k.adet + '" ' +
                'data-birim="' + k.birim + '" ' +
                'data-birim-ara="' + (k.adet > 0 ? (k.araToplam / k.adet) : k.birim) + '" ' +
                'class="border-t-2 border-slate-200 dark:border-slate-700 transition">' +

              '<td class="p-3">' +
                '<div class="flex items-center gap-3">' +
                  '<img src="' + kacis(k.gorsel || YEDEK_GORSEL) + '" alt="" loading="lazy" ' +
                       'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" ' +
                       'class="w-12 h-12 rounded-lg object-cover bg-slate-100 dark:bg-slate-700 shrink-0" />' +
                  '<span class="font-bold">' + kacis(k.ad) + '</span>' +
                '</div>' +
              '</td>' +

              '<td class="p-3 font-mono text-base text-slate-500 dark:text-slate-400 whitespace-nowrap">' +
                kacis(k.kod) + '</td>' +

              '<td class="p-3 text-center whitespace-nowrap">' +
                '<span class="text-xl font-black">' + k.adet + '</span>' +
                '<span class="text-base text-slate-500 dark:text-slate-400"> adet</span>' +
              '</td>' +

              '<td class="p-3 text-center">' +
                '<div class="inline-flex items-center gap-2">' +
                  '<button type="button" data-revize-eksi="' + k.kalemId + '" tabindex="-1" ' +
                          'class="w-12 h-12 rounded-xl text-2xl font-black bg-slate-200 hover:bg-slate-300 ' +
                                 'dark:bg-slate-700 dark:hover:bg-slate-600 transition active:scale-95">−</button>' +
                  '<input data-revize-adet type="number" min="0" step="1" inputmode="numeric" ' +
                         'value="' + k.adet + '" ' +
                         'class="w-24 h-12 px-2 rounded-xl text-xl font-black text-center ' +
                                'bg-slate-50 dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-600 ' +
                                'focus:border-marka-600 focus:ring-4 focus:ring-marka-600/20 outline-none transition" />' +
                  '<button type="button" data-revize-arti="' + k.kalemId + '" tabindex="-1" ' +
                          'class="w-12 h-12 rounded-xl text-2xl font-black bg-slate-200 hover:bg-slate-300 ' +
                                 'dark:bg-slate-700 dark:hover:bg-slate-600 transition active:scale-95">+</button>' +
                '</div>' +
              '</td>' +

              '<td class="p-3 text-right font-black whitespace-nowrap" data-revize-tutar>' +
                kacis(para(k.tutar)) + '</td>' +

            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>' +
    '</div>';

  $('#revizeNot').value = '';
  $('#revizeBildir').checked = durum.ayarlar.durumEpostasi !== false;
  $('#revizeHazirYap').checked = true;
  $('#revizeUyari').classList.add('hidden');

  revizeToplamiTazele();

  $('#revizeModalKatman').classList.remove('hidden');

  setTimeout(function () {
    const ilk = $('#revizeGovde [data-revize-adet]');
    if (ilk) { ilk.focus(); ilk.select(); }
  }, 40);
}

/** "SİPARİŞİ ONAYLA" — adetleri siteye gönderir. */
async function revizeyiOnayla(buton) {
  const s = durum.revizeSiparis;
  if (!s) return;

  const satirlar = revizeSatirlariOku();
  const degisenler = satirlar.filter(function (r) { return r.adet !== r.eskiAdet; });

  const hazirYap = !!$('#revizeHazirYap').checked;
  const not = $('#revizeNot').value.trim();
  const bildirilsinMi = !!$('#revizeBildir').checked;

  if (!degisenler.length && !hazirYap) {
    const uyari = $('#revizeUyari');
    uyari.textContent = 'Hiçbir adet değişmedi ve durum güncellemesi de kapalı. Yapılacak bir işlem yok.';
    uyari.classList.remove('hidden');
    return;
  }

  /* Tümü sıfırlanmışsa bu bir iptal demektir; yanlışlıkla olmadığı teyit edilir. */
  const toplamAdet = satirlar.reduce(function (t, r) { return t + r.adet; }, 0);

  if (toplamAdet === 0) {
    const eminMi = await onayla(
      'Tüm Adetler Sıfır',
      'Siparişteki bütün ürünlerin adedini 0 yaptınız.\n\n' +
      'Bu, siparişin içini boşaltır ve tutarı sıfırlar. Siparişi iptal etmek istiyorsanız\n' +
      '"SİPARİŞİ İPTAL ET" düğmesini kullanmalısınız.\n\nYine de devam edilsin mi?',
      'EVET, DEVAM ET',
      true
    );
    if (!eminMi) return;
  }

  const hedefDurum = hazirYap ? (durum.b2bVar ? 'order-ready' : 'processing') : '';
  const geriAl = butonuMesgulEt(buton, 'GÖNDERİLİYOR…');

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(400);

    /* Hem ekrandaki kopya hem DEMO_SIPARISLER kaynağı güncellenir; yalnızca
       kopya değişseydi ilk yenilemede/sekme geçişinde revize geri alınırdı
       (siparisDurumDegistir'in demo dalıyla aynı yaklaşım). */
    const kaynak = DEMO_SIPARISLER.filter(function (x) { return String(x.id) === String(s.id); })[0];

    satirlar.forEach(function (r) {
      [s, kaynak].forEach(function (hedef) {
        if (!hedef || !hedef.kalemler) return;
        const k = hedef.kalemler.filter(function (x) { return x.kalemId === r.kalemId; })[0];
        if (!k) return;
        k.adet = r.adet;
        k.tutar = Math.round(r.birim * r.adet * 100) / 100;
      });
    });

    [s, kaynak].forEach(function (hedef) {
      if (!hedef || !hedef.kalemler) return;
      hedef.tutar = hedef.kalemler.reduce(function (t, k) { return t + k.tutar; }, 0);
      if (degisenler.length) hedef.revize = true;
      if (hedefDurum) hedef.durum = hedefDurum;
    });

    geriAl();
    revizeModaliKapat();

    /* Durum değiştiyse sipariş bu sekmeden düşmüş olabilir. */
    if (hedefDurum) await siparisleriYukle(true);
    else siparisleriCiz();

    bildir('#' + s.numara + ' revize edildi.\n' +
           (degisenler.length ? degisenler.length + ' satırın adedi güncellendi.' : 'Adetlerde değişiklik yok.') +
           (hedefDurum ? '\nDurum: ' + durumBilgisi(hedefDurum).etiket : '') +
           '\n(Demo Modu — sitenizde değişiklik yapılmadı)', 'basari');
    return;
  }

  /* ---------- CANLI ---------- */
  let cevap;

  if (durum.b2bVar) {
    /* Tercih edilen yol: tek istekte doğrula + hesapla + durum değiştir. */
    cevap = await b2b('orders/' + s.id + '/revise', {
      metod: 'POST',
      sureAsimi: 45000,
      govde: {
        items: satirlar.map(function (r) {
          return { id: r.kalemId, quantity: r.adet };
        }),
        status: hedefDurum,
        note: not,
        notify: bildirilsinMi
      }
    });
  } else {
    /*
     * Yedek yol — WooCommerce çekirdeği.
     *
     * Satır toplamları BURADA hesaplanır: WooCommerce mevcut bir kalemde
     * yalnızca "quantity" gönderildiğinde tutarı yeniden türetmez, adet
     * değişir ama tutar eski adede ait kalırdı.
     *
     * NOT: Bu uçta adet 0 gönderilen satır SIFIRLANMAZ, tamamen SİLİNİR
     * (WooCommerce'in kendi davranışı). Eklenti kuruluyken kullanılan
     * /revise ucu ise satırı korur ve adedini 0 yapar.
     */
    cevap = await woo('orders/' + s.id, {
      metod: 'PUT',
      sureAsimi: 45000,
      govde: {
        line_items: degisenler.map(function (r) {
          return {
            id: r.kalemId,
            quantity: r.adet,
            subtotal: (r.birimAra * r.adet).toFixed(2),
            total: (r.birim * r.adet).toFixed(2)
          };
        })
      }
    });

    if (cevap.ok && hedefDurum) {
      cevap = await woo('orders/' + s.id, { metod: 'PUT', govde: { status: hedefDurum } });
    }

    if (cevap.ok && not) {
      await woo('orders/' + s.id + '/notes', {
        metod: 'POST',
        govde: { note: not, customer_note: bildirilsinMi }
      });
    }
  }

  geriAl();

  if (!cevap.ok) {
    const uyari = $('#revizeUyari');
    uyari.textContent = 'Sipariş güncellenemedi:\n' + (cevap.hata || 'Bilinmeyen hata.');
    uyari.classList.remove('hidden');
    return;
  }

  /* Yanıttan güncel siparişi al; yoksa listeyi tazele. */
  const yanit = cevap.veri || {};
  const guncelHam = yanit.order || null;

  if (guncelHam && durum.b2bVar) {
    const guncel = b2bSiparisNormalle(guncelHam);
    const sira = durum.siparisler.map(function (x) { return String(x.id); }).indexOf(String(s.id));
    if (sira !== -1) durum.siparisler[sira] = guncel;
  }

  /*
   * Mesaj GÖNDERİLEN isteğe göre değil, SUNUCUNUN döndürdüğüne göre kurulur.
   * (Eski sürümde adet değişmediğinde sunucu durumu değiştirmeden erken
   * dönüyordu ama arayüz yine "Durum: Sipariş Hazır" yazıyordu.)
   */
  const gercekDurum = (guncelHam && guncelHam.status) || yanit.status || '';
  const durumDegisti = (yanit.status_changed === true) ||
                       (!!gercekDurum && !!hedefDurum && durumNormalle(gercekDurum) === durumNormalle(hedefDurum) &&
                        durumNormalle(gercekDurum) !== durumNormalle(s.durum));
  const adetDegisti = (yanit.changed === true) || degisenler.length > 0;

  revizeModaliKapat();

  /* Durum değiştiyse sipariş bu sekmeden düşmüş olabilir; listeyi tazele. */
  if (gercekDurum && durumNormalle(gercekDurum) !== durumNormalle(s.durum)) {
    await siparisleriYukle(true);
  } else {
    siparisleriCiz();
  }

  bildir('#' + s.numara + ' işlendi.\n' +
         (adetDegisti
           ? (yanit.changes ? yanit.changes.length : degisenler.length) +
             ' satırın adedi güncellendi; tutar ve KDV yeniden hesaplandı.'
           : 'Adetlerde değişiklik yok.') +
         (gercekDurum ? '\nDurum: ' + durumBilgisi(gercekDurum).etiket : '') +
         (durumDegisti && bildirilsinMi ? '\nBayiye bilgilendirme e-postası gönderildi.' : ''),
         'basari');
}

/**
 * Sipariş durumunu masaüstünden değiştirir ve API üzerinden siteye gönderir.
 * @param {string|number} id      Sipariş kimliği.
 * @param {string}        hedefKod DURUM_DUGMELERI içindeki `kod` değeri.
 * @param {HTMLElement}   buton    Tıklanan düğme.
 */
async function siparisDurumDegistir(id, hedefKod, buton) {
  const s = durum.siparisler.filter(function (x) { return String(x.id) === String(id); })[0];
  const tanim = DURUM_DUGMELERI.filter(function (t) { return t.kod === hedefKod; })[0];
  if (!s || !tanim) return;

  const hedef = durum.b2bVar ? tanim.kod : tanim.yedek;
  if (String(s.durum) === String(hedef)) return;

  /* Kargoya verilirken kargo firması ve takip numarası sorulur. */
  let ek;
  if (tanim.kargoSor) {
    ek = await durumPenceresi({
      baslik: (tanim.kargoBaslik || tanim.etiket) + ' Olarak İşaretle',
      aciklama: '#' + s.numara + ' · ' + (s.firma || s.musteri) + '\n' + tanim.aciklama,
      kargoGoster: true,
      onayMetni: tanim.etiket,
      carrier: s.kargo,
      tracking: s.takip,
      shipmentNote: s.sevkiyatNotu,
      bildir: durum.ayarlar.durumEpostasi !== false
    });
  } else {
    ek = await durumPenceresi({
      baslik: tanim.etiket,
      aciklama: '#' + s.numara + ' · ' + (s.firma || s.musteri) + '\n' + tanim.aciklama,
      kargoGoster: false,
      onayMetni: tanim.etiket + ' YAP',
      bildir: durum.ayarlar.durumEpostasi !== false
    });
  }

  if (!ek) return;

  const geriAl = butonuMesgulEt(buton, 'GÖNDERİLİYOR…');

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(320);
    s.durum = hedef;
    s.durumEtiketi = '';
    /* Alanlar KOŞULSUZ yazılır: kullanıcı yanlış girdiği takip numarasını
       kutuyu boşaltarak silebilsin (eskiden boş değer yok sayılırdı). */
    s.kargo = ek.carrier || '';
    s.takip = ek.tracking || '';
    s.sevkiyatNotu = ek.shipmentNote || '';

    const kaynak = DEMO_SIPARISLER.filter(function (x) { return String(x.id) === String(id); })[0];
    if (kaynak) {
      kaynak.durum = hedef;
      kaynak.kargo = ek.carrier || '';
      kaynak.takip = ek.tracking || '';
      kaynak.sevkiyatNotu = ek.shipmentNote || '';
    }

    geriAl();
    siparisleriCiz();
    bildir('#' + s.numara + ' → ' + durumBilgisi(hedef).etiket +
           '\n(Demo Modu — sitenizde değişiklik yapılmadı)', 'basari');
    return;
  }

  /* ---------- CANLI ---------- */
  let cevap;

  if (durum.b2bVar) {
    cevap = await b2b('orders/' + id + '/status', {
      metod: 'POST',
      govde: {
        status: hedef,
        note: ek.note || '',
        /* Alanlar BOŞ gönderilebilir: sunucu boş dizeyi "temizle" olarak
           yorumlar, eksik alan diye reddetmez
           (bkz. b2b-core > update_order_status). */
        carrier: ek.carrier || '',
        tracking: ek.tracking || '',
        shipment_note: ek.shipmentNote || '',
        notify: !!ek.notify
      }
    });
  } else {
    /* Eklenti yoksa: WooCommerce çekirdek ucu ile durum değiştir. */
    cevap = await woo('orders/' + id, { metod: 'PUT', govde: { status: hedef } });

    if (cevap.ok && ek.note) {
      await woo('orders/' + id + '/notes', {
        metod: 'POST',
        govde: { note: ek.note, customer_note: !!ek.notify }
      });
    }
  }

  geriAl();

  if (!cevap.ok) {
    bildir('Durum güncellenemedi:\n' + cevap.hata, 'hata');
    return;
  }

  /* Yanıttan güncel siparişi al; yoksa yerelde güncelle. */
  if (durum.b2bVar && cevap.veri && cevap.veri.order) {
    const guncel = b2bSiparisNormalle(cevap.veri.order);
    const sira = durum.siparisler.indexOf(s);
    if (sira !== -1) durum.siparisler[sira] = guncel;
  } else {
    s.durum = hedef;
    s.durumEtiketi = '';
    s.kargo = ek.carrier || '';
    s.takip = ek.tracking || '';
    s.sevkiyatNotu = ek.shipmentNote || '';
  }

  /*
   * Sipariş artık açık SEKMEYE veya SÜZGECE ait değilse listeden düşürülür.
   * Yalnızca süzgece bakmak yetmiyordu: "Aktif Siparişler" sekmesindeki bir
   * sipariş kargoya verildiğinde süzgeç kapalı olsa bile o sekmeye ait olmaz
   * ve hayalet satır olarak asılı kalırdı.
   */
  const acikSekme = sekmeTanimi(durum.siparisSekme);
  const sekmedeMi = acikSekme.durumlar.indexOf(String(hedef)) !== -1;
  const suzgeceUyar = !durum.siparisSuzgec || durumNormalle(durum.siparisSuzgec) === durumNormalle(hedef);

  if (!sekmedeMi || !suzgeceUyar) {
    durum.siparisler = durum.siparisler.filter(function (x) { return String(x.id) !== String(id); });
    durum.siparislerToplam = Math.max(0, Number(durum.siparislerToplam || 0) - 1);
    siparisSekmeleriCiz();
  }

  siparisleriCiz();

  bildir('#' + s.numara + ' → ' + durumBilgisi(hedef).etiket + '\nSiteye gönderildi.' +
         (ek.notify ? '\nMüşteriye bilgilendirme e-postası gönderildi.' : '\n(E-posta gönderilmedi.)') +
         (ek.tracking ? '\nTakip No: ' + ek.tracking : '') +
         (ek.shipmentNote ? '\nSevkiyat: ' + ek.shipmentNote : ''), 'basari');
}

/** Otomatik yenileme zamanlayıcısını kurar / durdurur. */
function otoYenileyiAyarla() {
  if (durum.otoYenileZaman) {
    clearInterval(durum.otoYenileZaman);
    durum.otoYenileZaman = null;
  }

  const acikMi = !!durum.ayarlar.otoYenile;
  const kutu = $('#otoYenileKutu');
  if (kutu) kutu.checked = acikMi;

  if (!acikMi) return;

  const saniye = Math.max(15, Number(durum.ayarlar.otoYenileSaniye) || 60);

  durum.otoYenileZaman = setInterval(function () {
    if (durum.aktifSekme !== 'siparisler') return;   // Sadece sipariş ekranındayken
    if (document.hidden) return;
    if (!$('#modalKatman').classList.contains('hidden')) return;       // Açık pencere varken karıştırma
    if (!$('#kargoModalKatman').classList.contains('hidden')) return;
    if (!$('#bayiModalKatman').classList.contains('hidden')) return;
    siparisleriYukle(true);
  }, saniye * 1000);
}

/* ==========================================================================
 *  BÖLÜM 8 — ÜRÜN & STOK
 * ========================================================================*/

/**
 * Ürün listesinin O AN GÖRÜNEN kabı.
 *
 * Ürün sekmesi iki görünümde çalışır (tablo / kart) ve yalnızca biri açıktır.
 * "Yükleniyor…" kutusu gizli kaba yazılırsa kullanıcı bomboş bir ekrana bakar;
 * bu yüzden görünür olan seçilir. Izgara henüz yüklenmemişse (renderer-izgara.js
 * yoksa) eski kart kabına düşülür.
 */
function urunKabi() {
  const izgara = $('#urunIzgara');
  if (izgara && !izgara.classList.contains('hidden')) return izgara;
  return $('#urunListesi');
}

async function urunleriYukle(aramaMetni) {
  const kap = urunKabi();
  kap.innerHTML = yukleniyorHtml('Ürünler getiriliyor…');
  const arama = (aramaMetni === undefined || aramaMetni === null) ? $('#urunArama').value : aramaMetni;
  const temizArama = String(arama || '').trim();

  /* Yeni bir yükleme, devam eden eskisini geçersiz kılar (arama kutusunda hızlı
     yazarken üst üste binen isteklerin listeyi karıştırmasını önler). */
  const bilet = ++durum.urunYuklemeBileti;

  durum.urunYukleniyor = true;
  durum.urunlerTamYuklendi = false;

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(200);

    if (bilet !== durum.urunYuklemeBileti) return;

    /* Demo ürünlerinde menu_order yok; sıralama algoritması sayısal bir taban
       istediği için KAYNAK listeye aralıklı (10'ar) değerler verilir.
       Kaynak üzerinden verilmesi önemli: süzgeç açıkken kopya listenin
       indeksleri kaynaktakilerle örtüşmez ve değerler çakışırdı. */
    DEMO_URUNLER.forEach(function (u, i) {
      if (!isFinite(Number(u.menuSira))) u.menuSira = i * 10;
    });

    durum.urunler = DEMO_URUNLER
      .filter(function (u) { return !durum.urunDurumSuzgec || u.durum === durum.urunDurumSuzgec; })
      .map(function (u) { return Object.assign({}, u); });

    durum.urunlerToplam = durum.urunler.length;
    durum.urunlerTamYuklendi = true;
    durum.urunYukleniyor = false;

    urunleriCiz(temizArama);
    return;
  }

  /* ---------- CANLI ---------- */
  if (!durum.eklentiTanindi) {
    await eklentiyiTani();
    durum.eklentiTanindi = true;
  }

  if (bilet !== durum.urunYuklemeBileti) return;

  /*
   * TÜM ÜRÜNLER — sayfa sayfa.
   *
   * REST ucu bir istekte en fazla 100 kayıt döndürdüğü için 900+ ürünlü
   * mağazalarda tek istek listenin küçük bir bölümünü getiriyordu. Eksik liste
   * yalnızca "ürün göremiyorum" sorunu değildir: sürükle-bırak sıralaması
   * komşuların menu_order değerine bakarak çalıştığı için, hafızada olmayan
   * ürünler yüzünden sıra da kayıyordu (bkz. renderer-ek.js > SIRA HESABI).
   */
  const alan = durum.b2bVar ? 'b2b' : 'woo';

  /* b2b-core ürün listesi taslakları da döndürür (gizli ürünleri görebilmek için şart).
     Sıralama (menu_order) masaüstünde düzenlenebildiği için liste de aynı
     anahtarla gelmeli; "date desc" ile gelseydi sürükleyip bıraktığınız sıra
     bir sonraki yenilemede kaybolmuş gibi görünürdü. */
  const sorgu = durum.b2bVar
    ? { search: temizArama, status: durum.urunDurumSuzgec || '' }
    : {
        search: temizArama,
        status: durum.urunDurumSuzgec || 'any',
        orderby: 'menu_order',
        order: 'asc'
      };

  const cevap = await tumSayfalariGetir(alan, 'products', sorgu, {
    sureAsimi: 30000,
    ilerleme: function (alinan, toplam) {
      if (bilet !== durum.urunYuklemeBileti) return;

      kap.innerHTML = yukleniyorHtml(
        toplam > alinan
          ? 'Ürünler getiriliyor…  ' + alinan + ' / ' + toplam
          : 'Ürünler getiriliyor…  ' + alinan + ' ürün'
      );
    }
  });

  /* Bu yükleme bu arada eskidiyse (yeni arama başladı) ekrana hiç dokunma. */
  if (bilet !== durum.urunYuklemeBileti) return;

  durum.urunYukleniyor = false;

  if (!cevap.ok) {
    durum.canliBaglantiTamam = false;
    ustCubuguTazele();
    durum.urunler = [];
    durum.urunlerToplam = 0;
    durum.urunlerTamYuklendi = false;
    kap.innerHTML = bosHtml(ikon('priz'), 'Ürünler alınamadı', cevap.hata);
    return;
  }

  durum.canliBaglantiTamam = true;
  ustCubuguTazele();

  durum.urunler = (cevap.veri || []).map(urunNormalle);
  durum.urunlerToplam = Number(cevap.toplam) || durum.urunler.length;

  /* Liste ancak eksiksiz geldiyse sıralama için güvenlidir. */
  durum.urunlerTamYuklendi = !cevap.eksik && durum.urunler.length >= durum.urunlerToplam;

  urunleriCiz('');  // Canlı modda arama sunucuda yapıldı, tekrar süzmeye gerek yok

  if (cevap.eksik) {
    bildir('Ürünlerin tamamı getirilemedi.\n' +
           durum.urunler.length + ' / ' + durum.urunlerToplam + ' ürün yüklendi: ' +
           (cevap.hata || '') +
           '\n\nListe eksik olduğu için sıralama (sürükle-bırak) geçici olarak kapalıdır.\n' +
           'YENİLE ile tekrar deneyin.', 'uyari');
  }
}

/** Yayında / Gizli anahtarı. */
function gorunurlukAnahtariHtml(u) {
  const yayinda = u.durum === 'publish';
  return '' +
  '<button data-eylem="urun-gorunurluk" data-id="' + u.id + '" ' +
          'title="' + (yayinda ? 'Ürünü gizle (taslak yap)' : 'Ürünü yayına al') + '" ' +
          'class="shrink-0 flex items-center gap-3 h-14 px-4 rounded-2xl border-2 font-extrabold text-lg transition ' +
                 'active:scale-95 ' +
          (yayinda
            ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100 ' +
              'dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30'
            : 'bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200 ' +
              'dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600') + '">' +
    '<span class="relative w-14 h-8 rounded-full transition-colors shrink-0 ' +
          (yayinda ? 'bg-emerald-500' : 'bg-slate-400') + '">' +
      '<span class="absolute top-1 left-1 w-6 h-6 rounded-full bg-white shadow transition-transform ' +
            (yayinda ? 'translate-x-6' : '') + '"></span>' +
    '</span>' +
    (yayinda ? 'YAYINDA' : 'GİZLİ') +
  '</button>';
}

/* --------------------------------------------------------------------------
 *  KAYDIRMA KONUMUNU KORUMA
 *  --------------------------------------------------------------------------
 *  Liste `innerHTML` ile baştan yazıldığında tarayıcı kaydırma konumunu
 *  sıfırlar. Kullanıcı 400. üründeyken bir ürünü kaydettiğinde ekran listenin
 *  tepesine fırlıyordu — uzun listelerde çalışmayı imkânsız kılan bir davranış.
 *
 *  Bu sarmalayıcı çizim işlevini araya alır: önce konumu okur, çizimden sonra
 *  geri yazar. Liste kısaldıysa (ürün süzgeç dışına düştü) konum taşmasın diye
 *  içeriğin yeni yüksekliğine sıkıştırılır.
 * ------------------------------------------------------------------------*/
function kaydirmayiKoru(ciz) {
  const govde = $('#anaGovde');

  if (!govde) { ciz(); return; }

  const konum = govde.scrollTop;
  ciz();

  const enFazla = Math.max(0, govde.scrollHeight - govde.clientHeight);
  govde.scrollTop = Math.min(konum, enFazla);
}

function urunleriCiz(arama) {
  /* Kart görünümünün kabı SABİTTİR; tablo görünümünü renderer-izgara.js
     kendi kabına çizer (bkz. urunleriCiz sarmalayıcısı). */
  const kap = $('#urunListesi');
  const anahtar = (arama || '').toLocaleLowerCase('tr-TR');

  const liste = anahtar
    ? durum.urunler.filter(function (u) {
        return u.ad.toLocaleLowerCase('tr-TR').indexOf(anahtar) !== -1 ||
               String(u.kod).toLocaleLowerCase('tr-TR').indexOf(anahtar) !== -1;
      })
    : durum.urunler;

  if (liste.length === 0) {
    kap.innerHTML = anahtar
      ? bosHtml(ikon('ara'), 'Aramanıza uygun ürün bulunamadı', 'Farklı bir kelime veya stok kodu deneyin.')
      : bosHtml(ikon('etiket'), 'Ürün bulunamadı', 'Sitenizdeki ürünler burada listelenecek.\nYENİ ÜRÜN EKLE ile ürün ekleyebilirsiniz.');
    return;
  }

  kap.innerHTML = liste.map(function (u, sira) {
    const stokRengi = u.stok <= 0
      ? 'text-red-600 dark:text-red-400'
      : (u.stok < 20 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400');

    const gizliMi = u.durum !== 'publish';

    return '' +
    '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 ' +
         (gizliMi ? 'border-slate-300 dark:border-slate-600 opacity-80' : 'border-slate-200 dark:border-slate-700') +
         ' shadow-sm hover:shadow-md transition p-5 flex flex-col xl:flex-row xl:items-center gap-5" ' +
         'data-urun="' + u.id + '" data-sira="' + sira + '">' +

      /* Sürükle-bırak tutamağı — masaüstündeki sıra web sitesine birebir yansır */
      '<button type="button" data-tut="' + u.id + '" tabindex="0" ' +
              'title="Sürükleyerek sıralayın · Alt + ↑ / Alt + ↓ ile de taşıyabilirsiniz" ' +
              'aria-label="Ürünü taşı" ' +
              'class="b2b-tut shrink-0 self-start xl:self-center w-10 h-16 rounded-xl cursor-grab active:cursor-grabbing ' +
                     'grid place-items-center text-2xl leading-none select-none ' +
                     'bg-slate-100 hover:bg-slate-200 border-2 border-slate-300 text-slate-500 ' +
                     'dark:bg-slate-700 dark:hover:bg-slate-600 dark:border-slate-600 dark:text-slate-300 transition">' +
        ikon('tutamak', 'ik-lg') +
      '</button>' +

      '<img src="' + kacis(u.gorsel) + '" alt="" loading="lazy" ' +
           'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" ' +
           'class="w-20 h-20 rounded-xl object-cover bg-slate-100 dark:bg-slate-700 shrink-0" />' +

      '<div class="flex-1 min-w-0">' +
        '<div class="text-xl font-extrabold leading-snug">' + kacis(u.ad) +
          (gizliMi ? ' <span class="text-base font-bold text-slate-500">(sitede görünmüyor)</span>' : '') +
        '</div>' +
        '<div class="text-base font-semibold text-slate-500 dark:text-slate-400 mt-1">' +
          ikon('barkod') + ' Stok Kodu: ' + kacis(u.kod) +
          '  ·  <span class="' + stokRengi + '">Mevcut: ' + u.stok + ' adet</span>' +
        '</div>' +
      '</div>' +

      gorunurlukAnahtariHtml(u) +

      '<div class="shrink-0">' +
        '<label class="block text-sm font-bold text-slate-500 dark:text-slate-400 mb-1">FİYAT (₺)</label>' +
        '<input type="text" inputmode="decimal" data-alan="fiyat" value="' + kacis(fiyatYazi(u.fiyat)) + '" ' +
               'class="w-40 h-14 px-3 rounded-xl text-xl font-bold text-right bg-slate-50 dark:bg-slate-900 ' +
                      'border-2 border-slate-300 dark:border-slate-600 focus:border-marka-600 ' +
                      'focus:ring-4 focus:ring-marka-600/20 outline-none transition" />' +
      '</div>' +

      '<div class="shrink-0">' +
        '<label class="block text-sm font-bold text-slate-500 dark:text-slate-400 mb-1">STOK ADEDİ</label>' +
        '<input type="text" inputmode="numeric" data-alan="stok" value="' + u.stok + '" ' +
               'class="w-32 h-14 px-3 rounded-xl text-xl font-bold text-right bg-slate-50 dark:bg-slate-900 ' +
                      'border-2 border-slate-300 dark:border-slate-600 focus:border-marka-600 ' +
                      'focus:ring-4 focus:ring-marka-600/20 outline-none transition" />' +
      '</div>' +

      '<button data-eylem="urun-kaydet" data-id="' + u.id + '" ' +
              'class="shrink-0 w-full xl:w-auto h-14 px-7 rounded-2xl bg-emerald-600 hover:bg-emerald-700 ' +
                     'active:scale-95 text-white text-xl font-extrabold shadow-lg transition">' +
        ikon('kaydet') + ' KAYDET' +
      '</button>' +

      /* Tüm alanları (görsel, ad, barkod, kategori...) düzenleme paneli */
      '<button data-eylem="urun-duzenle" data-id="' + u.id + '" ' +
              'title="Görsel, ad, barkod ve kategoriyi düzenle" ' +
              'class="shrink-0 w-full xl:w-auto h-14 px-7 rounded-2xl bg-marka-700 hover:bg-marka-800 ' +
                     'active:scale-95 text-white text-xl font-extrabold shadow-lg transition">' +
        ikon('kalem') + ' DÜZENLE' +
      '</button>' +

      /* Kalıcı silme. Ürünü gizlemek isteyen kullanıcı için soldaki
         YAYINDA/GİZLİ anahtarı var; bu düğme ürünü tamamen kaldırır. */
      '<button data-eylem="urun-sil" data-id="' + u.id + '" ' +
              'title="Ürünü sitenizden ve bu listeden tamamen sil" ' +
              'aria-label="Ürünü sil" ' +
              'class="shrink-0 w-full xl:w-auto h-14 px-6 rounded-2xl border-2 border-red-300 ' +
                     'dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 ' +
                     'hover:bg-red-100 dark:hover:bg-red-500/20 active:scale-95 ' +
                     'text-xl font-extrabold shadow-sm transition">' +
        ikon('cop') + ' ÜRÜNÜ SİL' +
      '</button>' +
    '</div>';
  }).join('');
}

async function urunKaydet(id, buton) {
  const satir = buton.closest('[data-urun]');
  const urun = durum.urunler.filter(function (u) { return String(u.id) === String(id); })[0];
  if (!satir || !urun) return;

  const fiyat = sayiCoz(satir.querySelector('[data-alan="fiyat"]').value);
  const stokHam = sayiCoz(satir.querySelector('[data-alan="stok"]').value);
  const stok = Math.round(stokHam);

  if (!isFinite(fiyat) || isNaN(fiyat) || fiyat < 0) {
    bildir('Geçerli bir fiyat yazın.\nÖrnek: 1250,50', 'uyari');
    return;
  }
  if (!isFinite(stok) || isNaN(stok) || stok < 0) {
    bildir('Geçerli bir stok adedi yazın.\nÖrnek: 45', 'uyari');
    return;
  }

  const eskiMetin = buton.innerHTML;
  buton.disabled = true;
  buton.innerHTML = '<span class="donuyor">' + ikon('donen') + '</span> KAYDEDİLİYOR';
  buton.className = buton.className.replace('bg-emerald-600 hover:bg-emerald-700', 'bg-slate-500');

  let basarili = true;
  let hataMesaji = '';

  if (!durum.ayarlar.demoModu) {
    // Fiyat/stok güncellemesi WooCommerce çekirdek ucundan yapılır.
    const cevap = await woo('products/' + id, {
      metod: 'PUT',
      govde: { regular_price: fiyat.toFixed(2), stock_quantity: stok, manage_stock: true }
    });
    basarili = cevap.ok;
    hataMesaji = cevap.hata || '';
  } else {
    await bekle(180);
    const kaynak = DEMO_URUNLER.filter(function (u) { return String(u.id) === String(id); })[0];
    if (kaynak) { kaynak.fiyat = fiyat; kaynak.stok = stok; }
  }

  if (basarili) {
    urun.fiyat = fiyat;
    urun.stok = stok;
    buton.innerHTML = ikon('onay') + ' KAYDEDİLDİ';
    buton.className = buton.className.replace('bg-slate-500', 'bg-emerald-700');
    bildir(urun.ad + '\nFiyat: ' + para(fiyat) + '  ·  Stok: ' + stok + ' adet' +
           (durum.ayarlar.demoModu ? '\n(Demo Modu — sitede değişiklik yapılmadı)' : '\nSitede güncellendi.'), 'basari');
  } else {
    buton.innerHTML = ikon('carpi') + ' KAYDEDİLEMEDİ';
    buton.className = buton.className.replace('bg-slate-500', 'bg-red-600');
    bildir('Güncelleme başarısız:\n' + hataMesaji, 'hata');
  }

  setTimeout(function () {
    buton.disabled = false;
    buton.innerHTML = eskiMetin;
    buton.className = buton.className
      .replace('bg-emerald-700', 'bg-emerald-600 hover:bg-emerald-700')
      .replace('bg-red-600', 'bg-emerald-600 hover:bg-emerald-700');
  }, 2200);
}

/**
 * Ürünü gizler (taslak yapar) veya yayına alır.
 * b2b-core varsa /products/{id}/hide · /products/{id}/publish uçları kullanılır.
 */
async function urunGorunurlukDegistir(id, buton) {
  const urun = durum.urunler.filter(function (u) { return String(u.id) === String(id); })[0];
  if (!urun) return;

  const gizlenecekMi = urun.durum === 'publish';

  const eminMi = await onayla(
    gizlenecekMi ? 'Ürünü Gizle' : 'Ürünü Yayınla',
    '"' + urun.ad + '"\n\n' +
    (gizlenecekMi
      ? 'Ürün TASLAK yapılacak ve sitenizden tamamen kaldırılacak.\nMüşterileriniz bu ürünü göremeyecek.'
      : 'Ürün YAYINA alınacak ve sitenizde tekrar görünecek.') +
    (durum.ayarlar.demoModu ? '\n\n(Demo Modu: sitenizde hiçbir değişiklik yapılmaz.)' : ''),
    gizlenecekMi ? 'EVET, GİZLE' : 'EVET, YAYINLA',
    gizlenecekMi
  );
  if (!eminMi) return;

  const geriAl = butonuMesgulEt(buton, gizlenecekMi ? 'GİZLENİYOR…' : 'YAYINLANIYOR…');

  let basarili = true;
  let hataMesaji = '';

  if (durum.ayarlar.demoModu) {
    await bekle(280);
    const kaynak = DEMO_URUNLER.filter(function (u) { return String(u.id) === String(id); })[0];
    if (kaynak) kaynak.durum = gizlenecekMi ? 'draft' : 'publish';
  } else if (durum.b2bVar) {
    const cevap = gizlenecekMi
      ? await b2b('products/' + id + '/hide', { metod: 'POST', govde: { mode: 'draft' } })
      : await b2b('products/' + id + '/publish', { metod: 'POST' });
    basarili = cevap.ok;
    hataMesaji = cevap.hata || '';
  } else {
    const cevap = await woo('products/' + id, {
      metod: 'PUT',
      govde: { status: gizlenecekMi ? 'draft' : 'publish' }
    });
    basarili = cevap.ok;
    hataMesaji = cevap.hata || '';
  }

  geriAl();

  if (!basarili) {
    bildir('İşlem başarısız:\n' + hataMesaji, 'hata');
    return;
  }

  urun.durum = gizlenecekMi ? 'draft' : 'publish';

  // Süzgeç açıksa ve ürün artık uymuyorsa listeden düşür
  if (durum.urunDurumSuzgec && durum.urunDurumSuzgec !== urun.durum) {
    durum.urunler = durum.urunler.filter(function (u) { return String(u.id) !== String(id); });
  }

  /* Konum korunur: kullanıcı listenin ortasındaki ürünü gizlediğinde
     ekranın tepeye fırlaması, uzun listede çalışmayı imkânsız kılıyordu. */
  kaydirmayiKoru(function () {
    urunleriCiz(durum.ayarlar.demoModu ? $('#urunArama').value : '');
  });

  bildir(urun.ad + '\n' + (gizlenecekMi ? 'Ürün gizlendi (taslak).' : 'Ürün yayınlandı.') +
         (durum.ayarlar.demoModu ? '\n(Demo Modu)' : ''),
         gizlenecekMi ? 'uyari' : 'basari');
}

/* --------------------------------------------------------------------------
 *  YENİ ÜRÜN EKLEME + SÜRÜKLE-BIRAK GÖRSEL YÜKLEME
 * ------------------------------------------------------------------------*/

const GECERLI_GORSEL_TURLERI = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const EN_BUYUK_GORSEL_MB = 12;

function urunEkleUyar(mesaj) {
  const kutu = $('#urunEkleUyari');
  if (!mesaj) { kutu.classList.add('hidden'); return; }
  kutu.textContent = mesaj;
  kutu.classList.remove('hidden');
}

function gorselDurumYaz(mesaj, renkSinifi) {
  const kutu = $('#gorselBirakDurum');
  kutu.textContent = mesaj || '';
  kutu.className = 'mt-3 text-base font-bold ' + (renkSinifi || 'text-slate-500 dark:text-slate-400');
}

/** Dosyayı "data:image/jpeg;base64,..." biçimine çevirir. */
function dosyayiVeriAdresineCevir(dosya) {
  return new Promise(function (cozumle, reddet) {
    const okuyucu = new FileReader();
    okuyucu.onload = function () { cozumle(String(okuyucu.result || '')); };
    okuyucu.onerror = function () { reddet(new Error('Dosya okunamadı: ' + dosya.name)); };
    okuyucu.readAsDataURL(dosya);
  });
}

/** Yüklenen görsellerin küçük resimlerini çizer. */
function gorselOnizlemeCiz() {
  const kap = $('#gorselOnizleme');

  if (durum.yuklenenGorseller.length === 0) {
    kap.innerHTML = '';
    return;
  }

  kap.innerHTML = durum.yuklenenGorseller.map(function (g, i) {
    return '' +
    '<div class="relative w-28 h-28 rounded-2xl overflow-hidden border-2 border-slate-300 dark:border-slate-600 ' +
         'bg-slate-100 dark:bg-slate-700 group">' +
      '<img src="' + kacis(g.onizleme) + '" alt="" class="w-full h-full object-cover" />' +
      (i === 0
        ? '<span class="absolute bottom-0 inset-x-0 bg-emerald-600 text-white text-xs font-black text-center py-1">ÖNE ÇIKAN</span>'
        : '') +
      '<button data-gorsel-sil="' + kacis(String(g.id)) + '" title="Kaldır" ' +
              'class="absolute top-1 right-1 w-8 h-8 rounded-lg bg-red-600 hover:bg-red-700 text-white ' +
                     'text-lg font-black grid place-items-center shadow-lg transition">' + ikon('carpi', 'ik-sm') + '</button>' +
    '</div>';
  }).join('');
}

/**
 * Sürükle-bırak veya dosya seçimiyle gelen görselleri
 * POST /wc-b2b/v1/media ucuna yükler.
 */
async function gorselleriYukle(dosyalar) {
  const liste = Array.prototype.slice.call(dosyalar || []).filter(function (d) {
    return d && (GECERLI_GORSEL_TURLERI.indexOf(d.type) !== -1 || /^image\//.test(d.type || ''));
  });

  if (liste.length === 0) {
    gorselDurumYaz('Sadece görsel dosyası (JPG, PNG, WEBP, GIF) bırakabilirsiniz.', 'text-red-600 dark:text-red-400');
    return;
  }

  const urunAdi = $('#yeniAd').value.trim();

  for (let i = 0; i < liste.length; i++) {
    const dosya = liste[i];

    if (dosya.size > EN_BUYUK_GORSEL_MB * 1024 * 1024) {
      gorselDurumYaz('"' + dosya.name + '" çok büyük (en fazla ' + EN_BUYUK_GORSEL_MB + ' MB).',
                     'text-red-600 dark:text-red-400');
      continue;
    }

    gorselDurumYaz('Yükleniyor (' + (i + 1) + '/' + liste.length + '): ' + dosya.name,
                   'text-marka-700 dark:text-marka-300');

    let veriAdresi;
    try {
      veriAdresi = await dosyayiVeriAdresineCevir(dosya);
    } catch (e) {
      gorselDurumYaz(String(e.message), 'text-red-600 dark:text-red-400');
      continue;
    }

    /* ---------- DEMO ---------- */
    if (durum.ayarlar.demoModu) {
      await bekle(350);
      durum.yuklenenGorseller.push({
        id: 'demo-' + Date.now() + '-' + i,
        onizleme: veriAdresi,
        url: veriAdresi,
        demo: true
      });
      gorselOnizlemeCiz();
      continue;
    }

    /* ---------- CANLI ---------- */
    if (!durum.b2bVar) {
      gorselDurumYaz('Dosya yükleme için sitenizde "B2B Core" eklentisi gerekir.\n' +
                     'Eklenti yokken aşağıdaki "Görsel bağlantısı (URL)" alanını kullanın.',
                     'text-red-600 dark:text-red-400');
      return;
    }

    const cevap = await b2b('media', {
      metod: 'POST',
      sureAsimi: 120000,          // Büyük görseller için uzun süre
      govde: {
        filename: dosya.name,
        data: veriAdresi,          // "data:image/...;base64,..." biçimi destekleniyor
        title: urunAdi || dosya.name.replace(/\.[^.]+$/, ''),
        alt: urunAdi || ''
      }
    });

    if (!cevap.ok) {
      gorselDurumYaz('"' + dosya.name + '" yüklenemedi: ' + cevap.hata, 'text-red-600 dark:text-red-400');
      continue;
    }

    durum.yuklenenGorseller.push({
      id: cevap.veri.id,
      onizleme: cevap.veri.thumbnail || cevap.veri.url || veriAdresi,
      url: cevap.veri.url || ''
    });

    gorselOnizlemeCiz();
  }

  const adet = durum.yuklenenGorseller.length;
  gorselDurumYaz(adet ? adet + ' görsel hazır. İlk görsel öne çıkan görsel olacak.' : '',
                 'text-emerald-600 dark:text-emerald-400');
}

function gorselKaldir(gorselId) {
  durum.yuklenenGorseller = durum.yuklenenGorseller.filter(function (g) {
    return String(g.id) !== String(gorselId);
  });
  gorselOnizlemeCiz();
  gorselDurumYaz(durum.yuklenenGorseller.length
    ? durum.yuklenenGorseller.length + ' görsel hazır.'
    : '', 'text-emerald-600 dark:text-emerald-400');
}

function urunModaliKapat() {
  $('#urunModalKatman').classList.add('hidden');
}

async function urunModaliAc() {
  // Formu temizle
  ['#yeniAd', '#yeniKod', '#yeniFiyat', '#yeniIndirimliFiyat', '#yeniStok',
   '#yeniKoliAdedi', '#yeniGorsel', '#yeniAciklama'].forEach(function (s) {
    $(s).value = '';
  });
  $('#yeniStok').value = '0';
  $('#yeniKoliAdedi').value = '1';
  urunEkleUyar('');

  durum.yuklenenGorseller = [];
  gorselOnizlemeCiz();
  gorselDurumYaz('');

  const modEtiketi = $('#urunModalMod');
  if (durum.ayarlar.demoModu) {
    modEtiketi.textContent = 'Demo Modu — ürün sadece bu ekrana eklenir, sitenize kaydedilmez';
    modEtiketi.className = 'text-base font-bold text-amber-600 dark:text-amber-400';
  } else if (durum.b2bVar) {
    modEtiketi.textContent = 'Canlı Mod — ürün ve görselleri WooCommerce sitenize GERÇEKTEN eklenecek';
    modEtiketi.className = 'text-base font-bold text-emerald-600 dark:text-emerald-400';
  } else {
    modEtiketi.textContent = 'Canlı Mod (B2B Core eklentisi yok) — dosya yükleme kapalı, sadece görsel bağlantısı kullanılabilir';
    modEtiketi.className = 'text-base font-bold text-amber-600 dark:text-amber-400';
  }

  $('#urunModalKatman').classList.remove('hidden');
  $('#yeniAd').focus();

  // Kategorileri getir (WooCommerce çekirdek ucu — her iki modda da çalışır)
  const secim = $('#yeniKategori');
  secim.innerHTML = '<option value="">Kategoriler yükleniyor…</option>';

  let kategoriler = DEMO_KATEGORILER;
  if (!durum.ayarlar.demoModu) {
    // Sayfa sayfa: 100'den fazla kategorisi olan kataloglarda liste kesilmesin.
    const cevap = await tumKategorileriGetir();
    kategoriler = cevap.kategoriler;
  }

  secim.innerHTML = '<option value="">— Kategorisiz —</option>' +
    kategoriler.map(function (k) {
      return '<option value="' + k.id + '">' + kacis(k.ad) + '</option>';
    }).join('');
}

async function urunEkle() {
  const ad = $('#yeniAd').value.trim();
  const kod = $('#yeniKod').value.trim();
  const fiyat = sayiCoz($('#yeniFiyat').value);
  const indirimliYazi = $('#yeniIndirimliFiyat').value.trim();
  const indirimli = indirimliYazi ? sayiCoz(indirimliYazi) : NaN;
  const stokHam = sayiCoz($('#yeniStok').value);
  const stok = isNaN(stokHam) ? 0 : Math.round(stokHam);
  const koliHam = sayiCoz($('#yeniKoliAdedi').value);
  const koli = isNaN(koliHam) ? 1 : Math.round(koliHam);
  const kategoriId = $('#yeniKategori').value;
  const kategoriAdi = $('#yeniKategori').selectedOptions[0] ? $('#yeniKategori').selectedOptions[0].textContent : '';
  const gorselUrl = $('#yeniGorsel').value.trim();
  const aciklama = $('#yeniAciklama').value.trim();
  const yuklenenler = durum.yuklenenGorseller.slice();

  /* --- Doğrulamalar --- */
  if (!ad) { urunEkleUyar('Ürün adı boş bırakılamaz.'); $('#yeniAd').focus(); return; }
  if (isNaN(fiyat) || fiyat < 0) {
    urunEkleUyar('Geçerli bir fiyat yazın.\nÖrnek: 2450,00');
    $('#yeniFiyat').focus(); return;
  }
  /* SIFIR da geçersizdir: sale_price="0.00" WooCommerce'de geçerli bir indirim
     sayılır (boş dize DEĞİL ve normal fiyattan küçük), yani ürün sitede bedavaya
     düşer. Üstelik okuma tarafındaki indirimliFiyatCoz (n > 0) sıfırı '' gösterip
     kutuyu boş bıraktığı için kullanıcı hatayı sonradan fark edemiyordu. */
  if (indirimliYazi && (isNaN(indirimli) || !isFinite(indirimli) || indirimli <= 0)) {
    urunEkleUyar('Geçerli bir indirimli fiyat yazın.\nÖrnek: 1990,00\n' +
                 'Sıfır yazılamaz — indirim uygulamak istemiyorsanız kutuyu boş bırakın.');
    $('#yeniIndirimliFiyat').focus(); return;
  }
  /* Sunucu (b2b-core) indirimli fiyatın normal fiyattan KÜÇÜK olmasını şart koşar;
     eşitse HTTP 400 döner. Yalnızca "büyük olamaz" denetlenseydi eşit değer
     panelde geçer, kaydederken sunucudan hata alırdı. */
  if (indirimliYazi && indirimli >= fiyat) {
    urunEkleUyar('İndirimli fiyat, normal fiyattan DÜŞÜK olmalıdır.\n' +
                 'Normal fiyat: ' + para(fiyat) + '\n' +
                 'İndirimli fiyat: ' + para(indirimli) + '\n' +
                 'İndirim uygulamak istemiyorsanız kutuyu boş bırakın.');
    $('#yeniIndirimliFiyat').focus(); return;
  }
  if (stok < 0) { urunEkleUyar('Stok adedi eksi olamaz.'); $('#yeniStok').focus(); return; }
  if (!isFinite(koli) || koli < 1) {
    urunEkleUyar('Koli içi adet en az 1 olmalıdır.\nTek tek satılan ürünlerde 1 yazın.');
    $('#yeniKoliAdedi').focus(); return;
  }
  if (!yuklenenler.length && gorselUrl && !/^https?:\/\//i.test(gorselUrl)) {
    urunEkleUyar('Görsel bağlantısı http:// veya https:// ile başlamalıdır.');
    $('#yeniGorsel').focus(); return;
  }
  const ayniKod = kod && durum.urunler.filter(function (u) {
    return String(u.kod).toLocaleLowerCase('tr-TR') === kod.toLocaleLowerCase('tr-TR');
  })[0];
  if (ayniKod) {
    urunEkleUyar('Bu stok kodu zaten kullanılıyor:\n' + ayniKod.ad);
    $('#yeniKod').focus(); return;
  }

  urunEkleUyar('');
  const dugme = $('#urunEkleOnay');
  const geriAl = butonuMesgulEt(dugme, 'EKLENİYOR…');

  let yeniId = null;

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(300);
    const tumIdler = DEMO_URUNLER.map(function (u) { return u.id; });
    yeniId = (tumIdler.length ? Math.max.apply(null, tumIdler) : 900) + 1;

    const yeni = {
      id: yeniId, ad: ad, kod: kod || '-', fiyat: fiyat, stok: stok, durum: 'publish',
      indirimliFiyat: indirimliYazi ? indirimli : '',
      koliAdedi: koli,
      gorsel: (yuklenenler[0] && yuklenenler[0].onizleme) || gorselUrl || svgGorsel()
    };
    DEMO_URUNLER.unshift(yeni);              // "YENİLE" sonrası da görünsün
    durum.urunler.unshift(Object.assign({}, yeni));

    geriAl();
    urunModaliKapat();
    $('#urunArama').value = '';
    urunleriCiz('');
    bildir('Ürün eklendi:\n' + ad + '\nFiyat: ' + para(fiyat) + '  ·  Stok: ' + stok + ' adet' +
           (indirimliYazi ? '\nİndirimli fiyat: ' + para(indirimli) : '') +
           (koli > 1 ? '\nKoli içi adet: ' + koli : '') +
           (yuklenenler.length ? '\nGörsel: ' + yuklenenler.length + ' adet' : '') +
           (kategoriId ? '\nKategori: ' + kategoriAdi : '') +
           '\n(Demo Modu — sitenize kaydedilmedi)', 'basari');
    yeniUrunuVurgula(yeniId);
    return;
  }

  /* ---------- CANLI ---------- */
  let cevap;

  if (durum.b2bVar) {
    /* b2b-core hızlı ürün oluşturma ucu: medya kimliklerini doğrudan kabul eder. */
    const govde = {
      name: ad,
      regular_price: fiyat.toFixed(2),
      /* Boş dize GÖNDERİLİR: WooCommerce'de indirimi kaldırmanın yolu budur. */
      sale_price: indirimliYazi ? indirimli.toFixed(2) : '',
      manage_stock: true,
      stock_quantity: stok,
      status: 'publish',
      meta_data: koliMetaVerisi(koli)
    };
    if (kod) govde.sku = kod;
    if (aciklama) govde.description = aciklama;
    if (kategoriId) govde.categories = [Number(kategoriId)];

    if (yuklenenler.length) {
      govde.images = yuklenenler.map(function (g) { return g.id; });
    } else if (gorselUrl) {
      govde.images = [gorselUrl];
    }

    cevap = await b2b('products', { metod: 'POST', govde: govde, sureAsimi: 60000 });
  } else {
    /* Yedek yol: WooCommerce çekirdek ürün oluşturma. */
    const govde = {
      name: ad,
      type: 'simple',
      status: 'publish',
      regular_price: fiyat.toFixed(2),
      sale_price: indirimliYazi ? indirimli.toFixed(2) : '',
      manage_stock: true,
      stock_quantity: stok,
      meta_data: koliMetaVerisi(koli)
    };
    if (kod) govde.sku = kod;
    if (aciklama) govde.description = aciklama;
    if (kategoriId) govde.categories = [{ id: Number(kategoriId) }];
    if (gorselUrl) govde.images = [{ src: gorselUrl }];

    cevap = await woo('products', { metod: 'POST', govde: govde, sureAsimi: 60000 });
  }

  geriAl();

  if (!cevap.ok) {
    urunEkleUyar('Ürün eklenemedi:\n' + cevap.hata);
    return;
  }

  yeniId = cevap.veri && (cevap.veri.id || (cevap.veri.product && cevap.veri.product.id));

  urunModaliKapat();
  $('#urunArama').value = '';
  await urunleriYukle('');   // Siteden tazele, gerçek veriyi göster

  bildir('Ürün eklendi:\n' + ad + '\nFiyat: ' + para(fiyat) + '  ·  Stok: ' + stok + ' adet' +
         (indirimliYazi ? '\nİndirimli fiyat: ' + para(indirimli) : '') +
         (koli > 1 ? '\nKoli içi adet: ' + koli : '') +
         (yuklenenler.length ? '\nGörsel: ' + yuklenenler.length + ' adet yüklendi' : '') +
         (kategoriId ? '\nKategori: ' + kategoriAdi : '') +
         '\nSitenize kaydedildi.', 'basari');

  yeniUrunuVurgula(yeniId);
}

/** Eklenen ürüne kaydırıp 3 saniye çerçeveyle işaretler. */
function yeniUrunuVurgula(id) {
  if (!id) return;
  const satir = document.querySelector('[data-urun="' + id + '"]');
  if (!satir) return;
  satir.scrollIntoView({ behavior: 'smooth', block: 'center' });
  satir.classList.add('ring-4', 'ring-emerald-500', 'border-emerald-500');
  setTimeout(function () {
    satir.classList.remove('ring-4', 'ring-emerald-500', 'border-emerald-500');
  }, 3000);
}

/* ==========================================================================
 *  BÖLÜM 9 — B2B ÜYE ONAYLARI VE BAYİ KARTI
 * ========================================================================*/

function uyeSuzgecleriCiz() {
  const kap = $('#uyeSuzgecler');

  kap.innerHTML = UYE_SUZGECLERI.map(function (f) {
    const aktif = f.kod === durum.uyeSuzgec;

    /* Bekleyen sekmesinde sayaç 0 olsa da gösterilir: "(0)" görmek,
       sayacın hiç olmamasından farklıdır — kuyruğun boş olduğu bilgisidir. */
    const sayi = Number(durum.bekleyenUyeSayisi || 0);
    const rozet = (f.kod === 'pending')
      ? ' <span class="ml-1 px-2 py-0.5 rounded-lg text-base ' +
        (aktif
          ? 'bg-white/25'
          : (sayi > 0 ? 'bg-red-600 text-white' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300')) +
        '">' + sayi + '</span>'
      : '';

    return '<button data-uye-suzgec="' + kacis(f.kod) + '" ' +
           'class="h-14 px-5 rounded-2xl border-2 text-lg font-bold transition active:scale-95 ' +
           (aktif
             ? 'bg-marka-700 text-white border-marka-700 shadow-md'
             : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 ' +
               'dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700') +
           '">' + f.simge + ' ' + kacis(f.etiket) + rozet + '</button>';
  }).join('');
}

/** Sol menüdeki kırmızı bildirim sayacı. */
function uyeSayaciTazele() {
  const sayac = $('#uyeSayaci');
  if (durum.bekleyenUyeSayisi > 0) {
    sayac.textContent = durum.bekleyenUyeSayisi;
    sayac.classList.remove('hidden');
  } else {
    sayac.classList.add('hidden');
  }
  uyeSuzgecleriCiz();
}

/** Onay bekleyen bayi sayısını (menü rozeti için) hafifçe sorar. */
async function bekleyenSayisiniTazele() {
  if (durum.ayarlar.demoModu) {
    durum.bekleyenUyeSayisi = DEMO_UYELER.filter(function (u) { return u.durum === 'pending'; }).length;
    uyeSayaciTazele();
    return;
  }

  if (!durum.b2bVar) {
    // Yedek yolda sayı, çekilen listeden hesaplanır.
    uyeSayaciTazele();
    return;
  }

  /* Önce kurumsal başvuru kuyruğu (bkz. bekleyenBasvurulariGetir); bu uç
     yoksa eski bayi sayımına düşülür. Menüdeki kırmızı rozetin, sekmeye
     girildiğinde görülecek liste ile aynı sayıyı göstermesi için ikisinin
     kaynağı da AYNI olmalıdır. */
  const basvuru = await bekleyenBasvurulariGetir('');
  if (basvuru.ok) {
    durum.bekleyenUyeSayisi = basvuru.toplam;
    uyeSayaciTazele();
    return;
  }

  const cevap = await b2b('dealers', { sorgu: { status: 'pending', per_page: 1 } });
  if (cevap.ok) {
    durum.bekleyenUyeSayisi = Number(cevap.toplam || (cevap.veri || []).length || 0);
    uyeSayaciTazele();
  }
}

async function uyeleriYukle() {
  const kap = $('#uyeListesi');
  kap.innerHTML = '<div class="xl:col-span-2">' + yukleniyorHtml('Bayi başvuruları getiriliyor…') + '</div>';

  const arama = $('#uyeArama') ? $('#uyeArama').value.trim() : '';

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(220);
    const anahtar = arama.toLocaleLowerCase('tr-TR');

    durum.uyeler = DEMO_UYELER
      .filter(function (u) { return durum.uyeSuzgec === 'all' || u.durum === durum.uyeSuzgec; })
      .filter(function (u) {
        if (!anahtar) return true;
        return [u.firma, u.ad, u.eposta, u.vergiNo, u.telefon].join(' ')
          .toLocaleLowerCase('tr-TR').indexOf(anahtar) !== -1;
      })
      .map(function (u) { return Object.assign({}, u); });

    durum.bekleyenUyeSayisi = DEMO_UYELER.filter(function (u) { return u.durum === 'pending'; }).length;
    uyeleriCiz();
    return;
  }

  /* ---------- CANLI ---------- */
  if (!durum.eklentiTanindi) {
    await eklentiyiTani();
    durum.eklentiTanindi = true;
  }

  /* Yükleme ilerlemesini liste kutusuna yazan ortak geri çağrı. */
  function ilerlemeYaz(etiket) {
    return function (alinan, toplam) {
      kap.innerHTML = '<div class="xl:col-span-2">' + yukleniyorHtml(
        toplam > alinan
          ? etiket + '  ' + alinan + ' / ' + toplam
          : etiket + '  ' + alinan
      ) + '</div>';
    };
  }

  if (durum.b2bVar) {
    /*
     * ONAY BEKLEYENLER — önce /pending-users ucu denenir.
     *
     * Kurumsal başvurular bu uçta HENÜZ bayi kaydına dönüşmeden bekler ve
     * "dealers?status=pending" listesinde hiç görünmeyebilir. Uç yoksa
     * (eski eklenti sürümü) sessizce aşağıdaki bayi listesine düşülür;
     * uç var ama hata verdiyse kullanıcıya söylenir.
     */
    if (durum.uyeSuzgec === 'pending') {
      kap.innerHTML = '<div class="xl:col-span-2">' +
        yukleniyorHtml('Kurumsal bayilik başvuruları getiriliyor…') + '</div>';

      const basvuru = await bekleyenBasvurulariGetir(arama);

      if (basvuru.ok) {
        durum.canliBaglantiTamam = true;
        ustCubuguTazele();

        durum.uyeler = basvuru.basvurular;
        durum.uyelerToplam = basvuru.toplam;
        durum.bekleyenUyeSayisi = basvuru.toplam;

        uyeleriCiz();
        return;
      }

      if (!basvuru.ucYok) {
        durum.uyeler = [];
        durum.uyelerToplam = 0;
        durum.bekleyenUyeSayisi = 0;
        uyeSayaciTazele();
        kap.innerHTML = '<div class="xl:col-span-2">' +
          bosHtml(ikon('priz'), 'Başvurular alınamadı', basvuru.hata) + '</div>';
        return;
      }

      /* ucYok → aşağıdaki klasik bayi listesi yolu devam eder. */
      kap.innerHTML = '<div class="xl:col-span-2">' +
        yukleniyorHtml('Bayi başvuruları getiriliyor…') + '</div>';
    }

    /*
     * TÜM BAYİLER — sayfa sayfa. Tek istek 100 kayıtla sınırlıydı; 100'den
     * fazla bayisi olan mağazalarda listenin sonu hiç görünmüyor, "Onaylı
     * Bayiler" süzgecinde eski bayiler kayboluyordu.
     */
    const cevap = await tumSayfalariGetir('b2b', 'dealers', {
      status: durum.uyeSuzgec,
      search: arama
    }, {
      sureAsimi: 30000,
      ilerleme: ilerlemeYaz('Bayi başvuruları getiriliyor…')
    });

    if (!cevap.ok) {
      durum.canliBaglantiTamam = false;
      ustCubuguTazele();
      durum.uyeler = [];
      durum.uyelerToplam = 0;
      uyeSayaciTazele();
      kap.innerHTML = '<div class="xl:col-span-2">' + bosHtml(ikon('priz'), 'Bayiler alınamadı', cevap.hata) + '</div>';
      return;
    }

    durum.canliBaglantiTamam = true;
    ustCubuguTazele();
    durum.uyeler = (cevap.veri || []).map(bayiNormalle);
    durum.uyelerToplam = Number(cevap.toplam) || durum.uyeler.length;

    if (durum.uyeSuzgec === 'pending') durum.bekleyenUyeSayisi = durum.uyelerToplam;
    else bekleyenSayisiniTazele();

    uyeleriCiz();

    if (cevap.eksik) {
      bildir('Bayilerin tamamı getirilemedi.\n' +
             durum.uyeler.length + ' / ' + durum.uyelerToplam + ' kayıt yüklendi: ' +
             (cevap.hata || ''), 'uyari');
    }

    return;
  }

  /* ---------- YEDEK YOL: WooCommerce müşterileri + meta alanı ---------- */
  const cevap = await tumSayfalariGetir('woo', 'customers', {
    orderby: 'registered_date',
    order: 'desc',
    search: arama
  }, {
    sureAsimi: 30000,
    ilerleme: ilerlemeYaz('Üyeler getiriliyor…')
  });

  if (!cevap.ok) {
    durum.canliBaglantiTamam = false;
    ustCubuguTazele();
    durum.uyeler = [];
    durum.uyelerToplam = 0;
    uyeSayaciTazele();
    kap.innerHTML = '<div class="xl:col-span-2">' + bosHtml(ikon('priz'), 'Üyeler alınamadı', cevap.hata) + '</div>';
    return;
  }

  durum.canliBaglantiTamam = true;
  ustCubuguTazele();

  const tumu = (cevap.veri || []).map(musteriBayiyeCevir).filter(function (u) { return u.durum !== 'yok'; });
  durum.uyelerToplam = tumu.length;
  durum.bekleyenUyeSayisi = tumu.filter(function (u) { return u.durum === 'pending'; }).length;

  durum.uyeler = durum.uyeSuzgec === 'all'
    ? tumu
    : tumu.filter(function (u) { return u.durum === durum.uyeSuzgec; });

  uyeleriCiz();
}

/**
 * Onay bekleyen kurumsal başvurunun künye tablosu.
 *
 * Alanlar sözleşmede sayılan sırayla basılır: Firma Ünvanı · Vergi Dairesi ·
 * Vergi No · İl/İlçe · Kayıt Tarihi. Eksik alanlar "—" ile gösterilir, çünkü
 * burada boşluk bilgi taşır: vergi numarası girilmemiş bir başvuru zaten
 * onaylanmamalıdır ve bunun ekranda görünmesi gerekir.
 */
function basvuruKunyesiHtml(u) {
  const yer = [u.ilce, u.il].filter(Boolean).join(' / ') || u.adres || '';

  const satir = function (etiket, deger, genisMi) {
    return '<div class="' + (genisMi ? 'sm:col-span-2 ' : '') + 'min-w-0">' +
      '<span class="font-bold text-slate-500 dark:text-slate-400">' + kacis(etiket) + ':</span> ' +
      '<span class="font-semibold">' + kacis(deger || '—') + '</span></div>';
  };

  return '' +
  '<div class="rounded-2xl border-2 border-amber-200 dark:border-amber-500/30 ' +
       'bg-amber-50/60 dark:bg-amber-500/5 p-4">' +
    '<div class="text-base font-black text-amber-800 dark:text-amber-300 mb-2">' +
      ikon('not') + ' KURUMSAL BAŞVURU BİLGİLERİ</div>' +
    '<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-lg">' +
      satir('Firma Ünvanı', u.firma, true) +
      satir('Vergi Dairesi', u.vergiDairesi) +
      satir('Vergi No', u.vergiNo) +
      satir('İl / İlçe', yer) +
      satir('Kayıt Tarihi', u.tarih ? tarihYaz(u.tarih, true) : '') +
      satir('Telefon', u.telefon) +
      satir('E-posta', u.eposta) +
    '</div>' +
  '</div>';
}

function uyeleriCiz() {
  const kap = $('#uyeListesi');
  uyeSayaciTazele();

  if (durum.uyeler.length === 0) {
    const suzgecAdi = (UYE_SUZGECLERI.filter(function (f) { return f.kod === durum.uyeSuzgec; })[0] || {}).etiket || '';
    const aciklama = durum.uyeSuzgec === 'pending'
      ? (durum.b2bVar || durum.ayarlar.demoModu
          ? 'Tüm başvuruları değerlendirdiniz. '
          : 'Onay bekleyen üye görünmüyor.\n\nBaşvurular listelenmiyorsa: Ayarlar → Gelişmiş bölümünden\n' +
            'sitenizin kullandığı B2B alan adını kontrol edin.\n(Şu anki alan: "' + durum.ayarlar.b2bAlan +
            '", beklenen değer: "' + durum.ayarlar.b2bBekliyor + '")')
      : '"' + suzgecAdi + '" süzgecine uyan bayi bulunamadı.';

    kap.innerHTML = '<div class="xl:col-span-2">' +
      bosHtml(durum.uyeSuzgec === 'pending' ? ikon('parlak') : ikon('ara'),
              durum.uyeSuzgec === 'pending' ? 'Onay bekleyen başvuru yok' : 'Kayıt bulunamadı',
              aciklama) + '</div>';
    return;
  }

  kap.innerHTML = durum.uyeler.map(function (u) {
    const d = bayiDurumBilgisi(u.durum);
    const bekliyorMu = u.durum === 'pending';

    /* Duruma göre eylem düğmeleri.
       Kart dar olabildiği için düğmeler esnemez ve büyük punto taşımaz:
       "BAYİLİĞİ ONAYLA · REDDET · SİL" üçlüsü eskiden `flex-1 min-w-56 h-16`
       ölçüsüyle kartın dışına taşıyordu. Ortak ölçü tek yerden verilir. */
    const dugmeSinifi = function (renk) {
      return 'class="' + renk + ' px-3 py-1.5 rounded-xl ' +
             'text-white text-xs font-semibold transition active:scale-95"';
    };

    let dugmeler;
    if (bekliyorMu) {
      dugmeler =
        '<button data-eylem="uye-onayla" data-id="' + u.id + '" ' +
                'title="Rolü b2b_customer yapar; firma toptan fiyatları görmeye başlar." ' +
                dugmeSinifi('bg-emerald-600 hover:bg-emerald-700') + '>' +
                ikon('onay', 'ik-sm') + ' BAYİLİĞİ ONAYLA</button>' +
        '<button data-eylem="uye-reddet" data-id="' + u.id + '" ' +
                dugmeSinifi('bg-red-600 hover:bg-red-700') + '>' +
                ikon('carpi', 'ik-sm') + ' REDDET</button>';
    } else if (u.durum === 'approved') {
      dugmeler =
        '<button data-eylem="bayi-detay" data-id="' + u.id + '" ' +
                dugmeSinifi('bg-marka-700 hover:bg-marka-800') + '>' +
                ikon('liste', 'ik-sm') + ' SİPARİŞ GEÇMİŞİ</button>' +
        (durum.b2bVar || durum.ayarlar.demoModu
          ? '<button data-eylem="uye-askiya-al" data-id="' + u.id + '" ' +
                    dugmeSinifi('bg-slate-600 hover:bg-slate-700') + '>' +
                    ikon('durakla', 'ik-sm') + ' ASKIYA AL</button>'
          : '');
    } else {
      dugmeler =
        '<button data-eylem="uye-onayla" data-id="' + u.id + '" ' +
                dugmeSinifi('bg-emerald-600 hover:bg-emerald-700') + '>' +
                ikon('onay', 'ik-sm') + ' ONAYLA</button>' +
        '<button data-eylem="bayi-detay" data-id="' + u.id + '" ' +
                dugmeSinifi('bg-slate-600 hover:bg-slate-700') + '>' +
                ikon('liste', 'ik-sm') + ' DETAY</button>';
    }

    /* Kalıcı silme — durumdan bağımsız, her bayi kartında görünür (bkz. uyeSil). */
    dugmeler += '<button data-eylem="uye-sil" data-id="' + u.id + '" ' +
                'title="Bu müşteriyi/bayiyi sitenizden KALICI olarak siler. Bu işlem geri alınamaz." ' +
                dugmeSinifi('bg-red-800 hover:bg-red-900') + '>' +
                ikon('cop', 'ik-sm') + ' SİL</button>';

    return '' +
    '<div data-bayi="' + u.id + '" ' +
         'class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 ' +
         'shadow-sm hover:shadow-lg hover:border-marka-400 transition p-6 flex flex-col gap-4 cursor-pointer">' +

      '<div class="flex items-start gap-4">' +
        '<div class="w-14 h-14 rounded-2xl bg-marka-100 dark:bg-marka-900/40 text-marka-700 dark:text-marka-300 ' +
             'grid place-items-center text-3xl shrink-0">' + ikon('bina', 'ik-lg') + '</div>' +
        '<div class="min-w-0">' +
          '<div class="text-xl font-black leading-tight truncate">' + kacis(u.firma || u.ad) + '</div>' +
          '<div class="text-lg font-bold text-marka-700 dark:text-marka-300 truncate">' +
          ikon('kisi') + ' ' + kacis(u.ad) + '</div>' +
        '</div>' +
        '<span class="ml-auto shrink-0 px-3 py-1 rounded-lg border-2 text-base font-bold ' + d.sinif + '">' +
          kacis(d.etiket) + '</span>' +
      '</div>' +

      /* Onay bekleyen KURUMSAL BAŞVURULARDA künye farklıdır: karar vermek için
         gereken alanlar (Firma Ünvanı · Vergi Dairesi · Vergi No · İl/İlçe ·
         Kayıt Tarihi) öne alınır. Onaylı/reddedilmiş kayıtlarda ise iletişim
         bilgileri daha kullanışlı olduğu için eski düzen korunur. */
      (bekliyorMu ? basvuruKunyesiHtml(u) : '' +
      '<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-lg">' +
        '<div><span class="font-bold text-slate-500 dark:text-slate-400">Vergi No:</span> ' + kacis(u.vergiNo || '—') + '</div>' +
        '<div><span class="font-bold text-slate-500 dark:text-slate-400">Telefon:</span> ' + kacis(u.telefon || '—') + '</div>' +
        '<div class="sm:col-span-2 truncate"><span class="font-bold text-slate-500 dark:text-slate-400">E-posta:</span> ' +
          kacis(u.eposta || '—') + '</div>' +
        '<div class="sm:col-span-2"><span class="font-bold text-slate-500 dark:text-slate-400">' +
          (u.durum === 'approved' ? 'Onay:' : 'Başvuru:') + '</span> ' +
          kacis(tarihYaz(u.durum === 'approved' && u.onayTarihi ? u.onayTarihi : u.tarih, true)) + '</div>' +
        (u.redSebebi
          ? '<div class="sm:col-span-2 text-red-700 dark:text-red-300"><span class="font-bold">Red sebebi:</span> ' +
            kacis(u.redSebebi) + '</div>'
          : '') +
      '</div>') +

      /* Bayiye özel iskonto anahtarı + oran kutusu (yalnızca onaylı/askıdaki bayilerde) */
      bayiIskontoHtml(u) +

      '<div class="text-base text-slate-400 dark:text-slate-500">' +
        ikon('bilgi', 'ik-sm') + ' Karta tıklayarak bayi kartını ve sipariş dökümünü açın</div>' +

      '<div class="bayi-eylemler flex flex-wrap items-center gap-2 mt-3">' + dugmeler + '</div>' +
    '</div>';
  }).join('');
}

/**
 * Bayiye özel iskonto ayarını siteye kaydeder.
 *
 * @param {string|number} id     Bayi (kullanıcı) kimliği.
 * @param {HTMLElement}   buton  Tıklanan KAYDET düğmesi.
 * @param {boolean}       sessiz Anahtar tıklamasıyla otomatik kayıtta true.
 * @returns {Promise<boolean>} Kayıt gerçekten siteye işlendi mi?
 */
async function bayiIskontoKaydet(id, buton, sessiz) {
  const u = durum.uyeler.filter(function (x) { return String(x.id) === String(id); })[0] ||
            (durum.acikBayi && String(durum.acikBayi.id) === String(id) ? durum.acikBayi : null);
  if (!u) return false;

  const girdi = document.querySelector('[data-iskonto-oran="' + id + '"]');
  const kutu = document.querySelector('[data-iskonto-durum="' + id + '"]');

  const ham = girdi ? String(girdi.value).replace(',', '.').trim() : String(u.iskontoOran);
  const oran = Number(ham);

  function durumYaz(mesaj, tip) {
    if (!kutu) return;
    kutu.textContent = mesaj || '';
    kutu.className = 'w-full text-base font-bold ' +
      (tip === 'hata' ? 'text-red-700 dark:text-red-300'
        : tip === 'basari' ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-slate-500 dark:text-slate-400');
  }

  if (ham === '' || isNaN(oran) || oran < 0 || oran > 100) {
    durumYaz('Oran 0 ile 100 arasında bir sayı olmalıdır.', 'hata');
    if (girdi) girdi.focus();
    return false;
  }

  /* Anahtar açık ama oran 0 ise indirim uygulanmaz; kullanıcı bunu bilsin. */
  if (u.iskontoAktif && oran === 0) {
    durumYaz('Anahtar açık ama oran %0 — fiyatlarda değişiklik olmaz.', 'uyari');
  }

  const geriAl = buton ? butonuMesgulEt(buton, 'KAYDEDİLİYOR…') : function () {};

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(260);
    u.iskontoOran = oran;
    u.iskontoGecerli = u.iskontoAktif ? oran : 0;
    geriAl();
    uyeleriCiz();
    if (!sessiz) bildir((u.firma || u.ad) + '\nİskonto kaydedildi.\n(Demo Modu)', 'basari');
    return true;
  }

  /* ---------- CANLI ---------- */
  if (!durum.b2bVar) {
    geriAl();
    durumYaz('Bu özellik için sitenizde "B2B Core" eklentisi kurulu ve etkin olmalıdır.', 'hata');
    return false;
  }

  const cevap = await b2b('dealers/' + id, {
    metod: 'PUT',
    govde: {
      custom_discount_active: !!u.iskontoAktif,
      custom_discount_rate: oran
    }
  });

  geriAl();

  if (!cevap.ok) {
    durumYaz('Kaydedilemedi: ' + (cevap.hata || 'Bilinmeyen hata.'), 'hata');
    return false;
  }

  /* Sunucunun döndürdüğü değerler esas alınır (oran orada kırpılıp yuvarlanır). */
  if (cevap.veri) {
    const taze = bayiNormalle(cevap.veri);
    u.iskontoAktif = taze.iskontoAktif;
    u.iskontoOran = taze.iskontoOran;
    u.iskontoGecerli = taze.iskontoGecerli;
  } else {
    u.iskontoOran = oran;
  }

  uyeleriCiz();

  if (!sessiz) {
    bildir((u.firma || u.ad) + '\n' +
           (u.iskontoAktif
             ? 'Özel iskonto AÇIK — %' + oranYaz(u.iskontoOran) + '\nBayi siteye girdiğinde indirimli fiyatları görecek.'
             : 'Özel iskonto KAPALI — bayi genel site fiyatını görecek.'),
           'basari');
  }

  return true;
}

/** Anahtarı çevirir ve değişikliği hemen kaydeder. */
async function bayiIskontoAnahtari(id) {
  const u = durum.uyeler.filter(function (x) { return String(x.id) === String(id); })[0] ||
            (durum.acikBayi && String(durum.acikBayi.id) === String(id) ? durum.acikBayi : null);
  if (!u) return;

  const acilacak = !u.iskontoAktif;

  /* Açarken oran 0 ise uyar: anahtarı açmak tek başına indirim yapmaz. */
  const girdi = document.querySelector('[data-iskonto-oran="' + id + '"]');
  const oran = girdi ? Number(String(girdi.value).replace(',', '.')) : Number(u.iskontoOran);

  if (acilacak && (!oran || oran <= 0)) {
    bildir('Önce bir iskonto oranı girin.\nAnahtarı %0 ile açmak fiyatlarda değişiklik yapmaz.', 'uyari');
    if (girdi) { girdi.focus(); girdi.select(); }
    return;
  }

  if (!acilacak) {
    const eminMi = await onayla(
      'Özel İskontoyu Kapat',
      '"' + (u.firma || u.ad) + '" için özel iskonto kapatılacak.\n\n' +
      'Bayi bundan sonra GENEL SİTE FİYATINI görecek. Oran silinmez, sadece devre dışı kalır.' +
      (durum.ayarlar.demoModu ? '\n\n(Demo Modu: sitenizde hiçbir değişiklik yapılmaz.)' : ''),
      'EVET, KAPAT',
      true
    );
    if (!eminMi) return;
  }

  /* Başarısız kayıtta geri dönebilmek için önceki durumu sakla. */
  const oncekiAktif = u.iskontoAktif;
  const oncekiOran = u.iskontoOran;

  u.iskontoAktif = acilacak;

  /* Kutuda HENÜZ KAYDEDİLMEMİŞ bir oran varsa korunur: yeniden çizim onu
     eski değere döndürür ve kullanıcının yazdığı sayı sessizce kaybolurdu. */
  if (girdi && !isNaN(oran) && oran >= 0 && oran <= 100) {
    u.iskontoOran = oran;
  }

  /* Anahtar hemen çizilir (tıklama geri bildirimi), sonra kaydedilir. */
  uyeleriCiz();

  const kaydedildi = await bayiIskontoKaydet(id, null, true);

  /*
   * Kayıt siteye işlenmediyse anahtar GERİ ÇEVRİLİR. Aksi halde 401/500/zaman
   * aşımı durumunda anahtar yeşil kalır ve kullanıcı iskontonun açıldığını
   * sanır; oysa sitede hiçbir şey değişmemiştir.
   */
  if (!kaydedildi) {
    u.iskontoAktif = oncekiAktif;
    u.iskontoOran = oncekiOran;
    uyeleriCiz();

    bildir((u.firma || u.ad) + '\nİskonto ayarı SİTEYE İŞLENEMEDİ.\n' +
           'Anahtar eski konumuna geri alındı; kartdaki hata mesajına bakın.', 'hata');
    return;
  }

  bildir((u.firma || u.ad) + '\n' +
         (u.iskontoAktif
           ? 'Özel iskonto AÇILDI — %' + oranYaz(u.iskontoOran)
           : 'Özel iskonto KAPATILDI.'),
         u.iskontoAktif ? 'basari' : 'uyari');
}

/**
 * Bayiyi onaylar (approved_dealer) veya reddeder.
 * @param {string|number} id
 * @param {boolean} onayMi
 */
async function uyeKarar(id, onayMi) {
  // Bayi listede olmayabilir (ör. sipariş ekranından açılan bayi kartı) — açık kartı da tara.
  const uye = durum.uyeler.filter(function (u) { return String(u.id) === String(id); })[0] ||
              (durum.acikBayi && String(durum.acikBayi.id) === String(id) ? durum.acikBayi : null);
  if (!uye) return;

  let redSebebi = '';

  if (onayMi) {
    const onaylandi = await onayla(
      'Bayiliği Onayla',
      '"' + (uye.firma || uye.ad) + '" firmasını TOPTAN BAYİ olarak onaylıyorsunuz.\n\n' +
      'Kullanıcının rolü "' + B2B_BAYI_ROLU + '" yapılacak; sitenizde toptan fiyatları\n' +
      'görebilecek ve sipariş verebilecek.' +
      (durum.ayarlar.onayEpostasi !== false
        ? '\n\nFirmaya "Bayiliğiniz Onaylanmıştır" e-postası gönderilecek.'
        : '\n\nE-posta gönderilmeyecek (Ayarlar\'dan açabilirsiniz).') +
      (durum.ayarlar.demoModu ? '\n\n(Demo Modu: sitenizde hiçbir değişiklik yapılmaz.)' : ''),
      'EVET, ONAYLA',
      false
    );
    if (!onaylandi) return;
  } else {
    redSebebi = await metinSor(
      'Başvuruyu Reddet',
      '"' + (uye.firma || uye.ad) + '" firmasının bayilik başvurusunu reddediyorsunuz.\n' +
      'Red sebebini yazabilirsiniz (firmaya gönderilecek e-postada yer alır):',
      '',
      'EVET, REDDET'
    );
    if (redSebebi === null) return;
  }

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(280);
    const kaynak = DEMO_UYELER.filter(function (u) { return String(u.id) === String(id); })[0];
    if (kaynak) {
      kaynak.durum = onayMi ? 'approved' : 'rejected';
      if (onayMi) kaynak.onayTarihi = new Date().toISOString();
      else kaynak.redSebebi = redSebebi || 'Sebep belirtilmedi.';
    }
    durum.bekleyenUyeSayisi = DEMO_UYELER.filter(function (u) { return u.durum === 'pending'; }).length;
    durum.uyeler = durum.uyeler.filter(function (u) {
      return durum.uyeSuzgec === 'all' || String(u.id) !== String(id);
    });
    uyeleriCiz();
    bildir((uye.firma || uye.ad) + '\n' +
           (onayMi ? 'Bayilik onaylandı.' : 'Başvuru reddedildi.') + '\n(Demo Modu)',
           onayMi ? 'basari' : 'uyari');
    return;
  }

  /* ---------- CANLI ---------- */
  let cevap;

  /* Kayıt /pending-users kuyruğundan geldiyse onay AYRI bir uca gider:
     "dealers/<id>/approve" henüz bayi kaydı OLMAYAN bir kullanıcıyı bulamaz
     ve 404 döner. approve-user ise kullanıcının WordPress rolünü doğrudan
     'b2b_customer' yapar. */
  const basvuruMu = String(uye.kaynak || '') === 'pending-users';

  if (durum.b2bVar && basvuruMu) {
    cevap = onayMi
      ? await b2bIkiliUc('approve-user', {
          metod: 'POST',
          sureAsimi: 45000,
          govde: {
            user_id: Number(id),
            id: Number(id),
            role: B2B_BAYI_ROLU,
            approve: true,
            send_email: durum.ayarlar.onayEpostasi !== false
          }
        })
      : await b2bIkiliUc('reject-user', {
          metod: 'POST',
          sureAsimi: 45000,
          govde: {
            user_id: Number(id),
            id: Number(id),
            reason: redSebebi || '',
            send_email: durum.ayarlar.onayEpostasi !== false
          }
        });

    /* Sitede ayrı bir "reject-user" ucu olmayabilir; o zaman klasik bayi
       reddine düşülür (kullanıcı kaydı zaten oluşmuş olur). */
    if (!onayMi && ucBulunamadiMi(cevap)) {
      cevap = await b2b('dealers/' + id + '/reject', {
        metod: 'POST',
        govde: { reason: redSebebi || '', send_email: durum.ayarlar.onayEpostasi !== false }
      });
    }
  } else if (durum.b2bVar) {
    cevap = onayMi
      ? await b2b('dealers/' + id + '/approve', {
          metod: 'POST',
          govde: { send_email: durum.ayarlar.onayEpostasi !== false }
        })
      : await b2b('dealers/' + id + '/reject', {
          metod: 'POST',
          govde: { reason: redSebebi || '', send_email: durum.ayarlar.onayEpostasi !== false }
        });
  } else {
    /* Yedek yol: müşteri meta alanını güncelle. */
    const yeniDeger = onayMi ? durum.ayarlar.b2bOnaylandi : durum.ayarlar.b2bReddedildi;
    cevap = await woo('customers/' + id, {
      metod: 'PUT',
      govde: { meta_data: [{ key: durum.ayarlar.b2bAlan, value: yeniDeger }] }
    });
  }

  if (!cevap.ok) {
    bildir('İşlem başarısız:\n' + cevap.hata, 'hata');
    return;
  }

  if (durum.bekleyenUyeSayisi > 0) durum.bekleyenUyeSayisi--;

  if (durum.uyeSuzgec === 'all') {
    uye.durum = onayMi ? 'approved' : 'rejected';
    if (!onayMi) uye.redSebebi = redSebebi || '';
  } else {
    durum.uyeler = durum.uyeler.filter(function (u) { return String(u.id) !== String(id); });
  }

  uyeleriCiz();

  bildir((uye.firma || uye.ad) + '\n' +
         (onayMi
           ? 'Bayilik onaylandı' + (basvuruMu ? ' (rol: ' + B2B_BAYI_ROLU + ').' : ' (approved_dealer).') +
             (durum.b2bVar && durum.ayarlar.onayEpostasi !== false ? '\nBilgilendirme e-postası gönderildi.' : '')
           : 'Başvuru reddedildi.'),
         onayMi ? 'basari' : 'uyari');

  /*
   * Başvuru kuyruğundan çıkan kayıt SUNUCUDA artık bambaşka bir şeydir
   * (bekleyen kullanıcı → onaylı bayi). Yerel listeden silmek ekranı doğru
   * gösterir ama sayaçlar ile "Onaylı Bayiler" sekmesi eskide kalırdı;
   * bu yüzden liste sunucudan yeniden çekilir.
   */
  if (basvuruMu) {
    await uyeleriYukle();
    bekleyenSayisiniTazele();
  }
}

/** Bayiyi askıya alır (rol korunur, fiyat/sepet erişimi kapanır). */
async function bayiAskiyaAl(id) {
  const uye = durum.uyeler.filter(function (u) { return String(u.id) === String(id); })[0];
  if (!uye) return;

  const eminMi = await onayla(
    'Bayiyi Askıya Al',
    '"' + (uye.firma || uye.ad) + '" askıya alınacak.\n\n' +
    'Bayi rolü korunur ancak toptan fiyat ve sepet erişimi kapanır.' +
    (durum.ayarlar.demoModu ? '\n\n(Demo Modu: sitenizde hiçbir değişiklik yapılmaz.)' : ''),
    'EVET, ASKIYA AL',
    true
  );
  if (!eminMi) return;

  if (durum.ayarlar.demoModu) {
    await bekle(250);
    const kaynak = DEMO_UYELER.filter(function (u) { return String(u.id) === String(id); })[0];
    if (kaynak) kaynak.durum = 'suspended';
  } else {
    const cevap = await b2b('dealers/' + id + '/suspend', { metod: 'POST' });
    if (!cevap.ok) {
      bildir('İşlem başarısız:\n' + cevap.hata, 'hata');
      return;
    }
  }

  if (durum.uyeSuzgec === 'all') uye.durum = 'suspended';
  else durum.uyeler = durum.uyeler.filter(function (u) { return String(u.id) !== String(id); });

  uyeleriCiz();
  bildir((uye.firma || uye.ad) + '\nBayi askıya alındı.' +
         (durum.ayarlar.demoModu ? '\n(Demo Modu)' : ''), 'uyari');
}

/* --------------------------------------------------------------------------
 *  BAYİ KARTI — GEÇMİŞ SİPARİŞ DÖKÜMÜ
 * ------------------------------------------------------------------------*/

function bayiModaliKapat() {
  $('#bayiModalKatman').classList.add('hidden');
}

/** Bayi kartını açar; bilgileri ve geçmiş siparişleri API'den çeker. */
async function bayiDetayiAc(id) {
  const katman = $('#bayiModalKatman');
  const govde = $('#bayiModalGovde');
  const ayak = $('#bayiModalAyak');

  /* Listede varsa hemen başlığı doldur (bekleme hissi olmasın) */
  const listedeki = durum.uyeler.filter(function (u) { return String(u.id) === String(id); })[0] || {};

  $('#bayiModalBaslik').textContent = listedeki.firma || listedeki.ad || 'Bayi Kartı';
  $('#bayiModalAltBaslik').textContent = listedeki.ad || '';
  govde.innerHTML = yukleniyorHtml('Bayi bilgileri ve sipariş geçmişi getiriliyor…');
  ayak.innerHTML = '';
  katman.classList.remove('hidden');

  let bayi = listedeki;
  let istatistik = null;
  let siparisler = [];

  /* ---------- DEMO ---------- */
  if (durum.ayarlar.demoModu) {
    await bekle(320);
    bayi = DEMO_UYELER.filter(function (u) { return String(u.id) === String(id); })[0] || listedeki;
    siparisler = DEMO_SIPARISLER
      .filter(function (s) { return String(s.bayiId) === String(id); })
      .map(function (s) { return JSON.parse(JSON.stringify(s)); });
  } else if (durum.b2bVar) {
    /* ---------- CANLI (b2b-core) ---------- */
    /* Sipariş geçmişi sayfa sayfa: 100'den fazla siparişi olan bayilerde
       geçmiş kesiliyor, "toplam harcama" da eksik hesaplanıyordu. */
    const [detayCevap, siparisCevap] = await Promise.all([
      b2b('dealers/' + id),
      tumSayfalariGetir('b2b', 'dealers/' + id + '/orders', {}, {
        sureAsimi: 30000,
        enFazlaSayfa: SIPARIS_SAYFA_TAVANI
      })
    ]);

    if (detayCevap.ok && detayCevap.veri) {
      bayi = bayiNormalle(detayCevap.veri);
      istatistik = detayCevap.veri.stats || null;
      bayi.sepet = detayCevap.veri.cart || null;
    }

    if (siparisCevap.ok) {
      siparisler = (siparisCevap.veri || []).map(b2bSiparisNormalle);
    } else {
      govde.innerHTML = bosHtml(ikon('priz'), 'Sipariş geçmişi alınamadı', siparisCevap.hata);
    }
  } else {
    /* ---------- YEDEK YOL (WooCommerce) ---------- */
    const cevap = await tumSayfalariGetir('woo', 'orders', {
      customer: id, orderby: 'date', order: 'desc', status: 'any'
    }, {
      sureAsimi: 30000,
      enFazlaSayfa: SIPARIS_SAYFA_TAVANI
    });

    if (cevap.ok) siparisler = (cevap.veri || []).map(siparisNormalle);
  }

  durum.bayiSiparisleri = siparisler;
  if (!bayi.id) bayi.id = id;             // Sipariş ekranından açıldıysa kimlik listeden gelmemiş olabilir
  durum.acikBayi = bayi;                  // Alt eylem düğmeleri (onayla/reddet) için

  /* --- İstatistikler --- */
  const toplamTutar = istatistik && istatistik.total_spent !== undefined
    ? Number(istatistik.total_spent)
    : siparisler.reduce(function (t, s) {
        return t + (s.durum === 'cancelled' || s.durum === 'refunded' ? 0 : s.tutar);
      }, 0);

  const siparisAdedi = istatistik && istatistik.total_orders !== undefined
    ? Number(istatistik.total_orders)
    : siparisler.length;

  const d = bayiDurumBilgisi(bayi.durum);

  $('#bayiModalBaslik').textContent = bayi.firma || bayi.ad || 'Bayi Kartı';
  $('#bayiModalAltBaslik').textContent = (bayi.ad || '—') + '  ·  ' + d.etiket;

  /* --- Sipariş dökümü tablosu --- */
  const siparisTablosu = siparisler.length
    ? '<div class="overflow-x-auto rounded-2xl border-2 border-slate-200 dark:border-slate-700">' +
        '<table class="w-full text-lg">' +
          '<thead class="bg-slate-100 dark:bg-slate-900/60">' +
            '<tr class="text-left">' +
              '<th class="p-3 font-black">SİPARİŞ</th>' +
              '<th class="p-3 font-black">TARİH</th>' +
              '<th class="p-3 font-black">ÜRÜN</th>' +
              '<th class="p-3 font-black">DURUM</th>' +
              '<th class="p-3 font-black text-right">TUTAR</th>' +
              '<th class="p-3"></th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            siparisler.map(function (s) {
              const sd = durumBilgisi(s.durum);
              const adet = s.kalemler.reduce(function (t, k) { return t + k.adet; }, 0);
              return '<tr class="border-t-2 border-slate-200 dark:border-slate-700">' +
                '<td class="p-3 font-black whitespace-nowrap">#' + kacis(s.numara) + '</td>' +
                '<td class="p-3 whitespace-nowrap">' + kacis(tarihYaz(s.tarih, true)) + '</td>' +
                '<td class="p-3 whitespace-nowrap">' + s.kalemler.length + ' çeşit / ' + adet + ' adet</td>' +
                '<td class="p-3"><span class="inline-block px-2 py-1 rounded-lg border-2 text-base font-bold ' +
                  sd.sinif + '">' + kacis(s.durumEtiketi || sd.etiket) + '</span></td>' +
                '<td class="p-3 text-right font-black whitespace-nowrap">' + kacis(para(s.tutar)) + '</td>' +
                '<td class="p-3 text-right">' +
                  '<button data-eylem="bayi-fis" data-id="' + s.id + '" ' +
                          'class="h-11 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white font-extrabold ' +
                                 'text-base transition active:scale-95">' + ikon('yazici', 'ik-sm') + ' FİŞ</button>' +
                '</td>' +
              '</tr>';
            }).join('') +
          '</tbody>' +
        '</table>' +
      '</div>'
    : bosHtml(ikon('kutuBos'), 'Bu bayinin siparişi yok', 'Bayi sipariş verdiğinde geçmişi burada listelenecek.');

  /* --- Kayıtlı sepet (b2b-core) --- */
  const sepet = bayi.sepet;
  const sepetKutusu = (sepet && sepet.items && sepet.items.length)
    ? '<div class="rounded-2xl border-2 border-dashed border-marka-300 dark:border-marka-700 ' +
          'bg-marka-50 dark:bg-marka-900/20 p-5">' +
        '<div class="text-xl font-black mb-3">' + ikon('sepet', 'ik-lg') +
      ' Bayinin Bekleyen Sepeti (' + sepet.items.length + ' çeşit)</div>' +
        '<div class="flex flex-col gap-1 text-lg">' +
          sepet.items.map(function (k) {
            return '<div class="flex justify-between gap-4">' +
              '<span class="truncate">' + kacis(k.name) + ' <span class="text-slate-500">(' + kacis(k.sku || '-') + ')</span></span>' +
              '<span class="font-bold whitespace-nowrap">' + Number(k.quantity || 0) + ' adet · ' + kacis(para(k.total)) + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>'
    : '';

  govde.innerHTML =
    /* Künye */
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-lg">' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Firma:</span> ' + kacis(bayi.firma || '—') + '</div>' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Yetkili:</span> ' + kacis(bayi.ad || '—') + '</div>' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Telefon:</span> ' + kacis(bayi.telefon || '—') + '</div>' +
      '<div class="truncate"><span class="font-bold text-slate-500 dark:text-slate-400">E-posta:</span> ' + kacis(bayi.eposta || '—') + '</div>' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Vergi Dairesi:</span> ' + kacis(bayi.vergiDairesi || '—') + '</div>' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Vergi No:</span> ' + kacis(bayi.vergiNo || '—') + '</div>' +
      '<div class="md:col-span-2"><span class="font-bold text-slate-500 dark:text-slate-400">Adres:</span> ' + kacis(bayi.adres || '—') + '</div>' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Başvuru:</span> ' + kacis(tarihYaz(bayi.tarih, true)) + '</div>' +
      '<div><span class="font-bold text-slate-500 dark:text-slate-400">Onay:</span> ' + kacis(bayi.onayTarihi ? tarihYaz(bayi.onayTarihi, true) : '—') + '</div>' +
      (bayi.redSebebi
        ? '<div class="md:col-span-2 text-red-700 dark:text-red-300"><span class="font-bold">Red sebebi:</span> ' + kacis(bayi.redSebebi) + '</div>'
        : '') +
    '</div>' +

    /* Sayaçlar */
    '<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">' +
      '<div class="bg-slate-50 dark:bg-slate-900/50 rounded-2xl p-5 border-2 border-slate-200 dark:border-slate-700">' +
        '<div class="text-base font-bold text-slate-500 dark:text-slate-400">TOPLAM SİPARİŞ</div>' +
        '<div class="text-4xl font-black mt-1">' + siparisAdedi + '</div></div>' +
      '<div class="bg-slate-50 dark:bg-slate-900/50 rounded-2xl p-5 border-2 border-emerald-300 dark:border-emerald-500/40">' +
        '<div class="text-base font-bold text-emerald-600 dark:text-emerald-400">TOPLAM CİRO</div>' +
        '<div class="text-3xl font-black mt-1 text-emerald-600 dark:text-emerald-400">' + kacis(para(toplamTutar)) + '</div></div>' +
      '<div class="bg-slate-50 dark:bg-slate-900/50 rounded-2xl p-5 border-2 border-slate-200 dark:border-slate-700">' +
        '<div class="text-base font-bold text-slate-500 dark:text-slate-400">DURUM</div>' +
        '<div class="mt-2"><span class="inline-block px-3 py-1 rounded-lg border-2 text-lg font-bold ' + d.sinif + '">' +
          kacis(d.etiket) + '</span></div></div>' +
    '</div>' +

    sepetKutusu +

    '<div>' +
      '<div class="text-xl font-black mb-3">' + ikon('liste', 'ik-lg') + ' Geçmiş Sipariş Dökümü</div>' +
      siparisTablosu +
    '</div>';

  /* --- Alt eylem düğmeleri --- */
  const eylemler = [];

  if (bayi.durum === 'pending' || bayi.durum === 'rejected' || bayi.durum === 'suspended') {
    eylemler.push(
      '<button data-eylem="bayi-modal-onayla" data-id="' + bayi.id + '" ' +
              'class="flex-1 min-w-56 h-16 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 ' +
                     'text-white text-xl font-extrabold shadow-lg transition">' + ikon('onay') + ' TEK TIKLA ONAYLA</button>');
  }
  if (bayi.durum === 'pending') {
    eylemler.push(
      '<button data-eylem="bayi-modal-reddet" data-id="' + bayi.id + '" ' +
              'class="flex-1 min-w-40 h-16 rounded-2xl bg-red-600 hover:bg-red-700 active:scale-95 ' +
                     'text-white text-xl font-extrabold shadow-lg transition">' + ikon('carpi') + ' REDDET</button>');
  }
  eylemler.push(
    '<button data-eylem="bayi-modal-kapat" ' +
            'class="ml-auto h-16 px-8 rounded-2xl text-xl font-extrabold bg-slate-200 hover:bg-slate-300 ' +
                   'dark:bg-slate-700 dark:hover:bg-slate-600 transition active:scale-95">KAPAT</button>');

  ayak.innerHTML = eylemler.join('');
}

/* ==========================================================================
 *  BÖLÜM 10 — DEPO FİŞİ (A4, KOMPAKT — sıfır kağıt israfı)
 *
 *  Sütun sırası:
 *  [Görsel] | [☐ Tik] | [Ürün Adı] | [Barkod/SKU] | [Adet] | [Birim Fiyat] | [Toplam]
 *
 *  Kağıt israfını önlemek için tasarım ölçüleri sıkıştırıldı:
 *   · Üst başlık tek şerit, 2 sütunlu mini başlık
 *   · Ürün görselleri mikro boyut (en fazla 32x32px)
 *   · Hücre boşluğu 3px 6px · Yazılar 10-11px · Çizgiler 1px solid #e2e8f0
 *   · Sipariş notu ve imzalar yan yana (dikeyde yer kazanır)
 * ========================================================================*/

/**
 * Fiş künyesinde tek bir "Etiket: değer" parçası.
 * Değer boşsa parça HİÇ üretilmez — kağıda "Vergi No: —" basmak, o siparişte
 * vergi bilgisi olmadığı hâlde eksik girilmiş izlenimi verirdi.
 */
function fisAlaniHtml(etiket, deger, vurgulaMi) {
  const metin = String(deger === null || deger === undefined ? '' : deger).trim();
  if (!metin) return '';
  return '<span class="etiket">' + kacis(etiket) + ':</span> ' +
         (vurgulaMi ? '<span class="vurgu">' + kacis(metin) + '</span>' : kacis(metin));
}

/** Künye satırlarını "·" ile birleştirir; boş parçalar elenir. */
function fisSatiriHtml(parcalar) {
  const dolu = parcalar.filter(Boolean);
  if (!dolu.length) return '';
  return '<div>' + dolu.join(' &nbsp;·&nbsp; ') + '</div>';
}

/**
 * Depo fişinin ALICI KÜNYESİ — alıcı tipine göre TAMAMEN farklı alanlar basar.
 *
 *   Bireysel müşteri : Ad-Soyad · T.C. Kimlik No (varsa) · Teslimat Adresi · Telefon
 *   Kurumsal bayi    : Firma Ünvanı · Vergi Dairesi · Vergi No · Cari Adres · Telefon
 *
 * İki şablonu tek bir "hepsini bas" bloğunda birleştirmek yanlış olurdu:
 * bireysel siparişin fişinde boş vergi alanları, kurumsal siparişin fişinde
 * ise şahsın T.C. kimliği yer alırdı (ikincisi ayrıca gereksiz kişisel veri).
 */
function fisKunyesiHtml(s) {
  const kurumsalMi = aliciTipiKodu(s) === 'corporate';

  if (kurumsalMi) {
    return '' +
      fisSatiriHtml([
        fisAlaniHtml('Firma Ünvanı', s.firma || s.musteri, true),
        fisAlaniHtml('Tel', s.telefon)
      ]) +
      fisSatiriHtml([
        fisAlaniHtml('Vergi Dairesi', s.vergiDairesi),
        fisAlaniHtml('Vergi No', s.vergiNo)
      ]) +
      fisSatiriHtml([fisAlaniHtml('Cari Adres', s.adres)]) +
      fisSatiriHtml([fisAlaniHtml('Yetkili', s.musteri)]);
  }

  return '' +
    fisSatiriHtml([
      fisAlaniHtml('Ad-Soyad', s.musteri, true),
      fisAlaniHtml('Tel', s.telefon)
    ]) +
    fisSatiriHtml([fisAlaniHtml('T.C. Kimlik No', s.tcKimlik)]) +
    fisSatiriHtml([fisAlaniHtml('Teslimat Adresi', s.adres)]);
}

/** Fiş penceresi kendi belgesinde açıldığı için ikonlar gömülü gelir. */
function fisIkonu(govde, boyut) {
  return '<svg width="' + (boyut || 15) + '" height="' + (boyut || 15) + '" viewBox="0 0 24 24" ' +
         'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
         'stroke-linejoin="round" style="vertical-align:-3px">' + govde + '</svg>';
}

const FIS_IKONLARI = {
  yazici: '<path d="M7 9.2V3.8h10v5.4"/><path d="M6 9.2h12a2.5 2.5 0 0 1 2.5 2.5v4.1H3.5v-4.1A2.5 2.5 0 0 1 6 9.2Z"/><rect x="7" y="14" width="10" height="6.4" rx="1"/>',
  belge:  '<path d="M14 3.6H7.2a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h9.6a2 2 0 0 0 2-2V8.4Z"/><path d="M14 3.6v4.8h4.8"/><path d="M8.6 13h6.8M8.6 16.4h4.6"/>',
  carpi:  '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
  paket:  '<path d="M20.4 7.4 12 12 3.6 7.4"/><path d="M12 12v9.3"/><path d="M20 16.1V7.9a1.5 1.5 0 0 0-.8-1.3l-6.5-3.6a1.5 1.5 0 0 0-1.4 0L4.8 6.6A1.5 1.5 0 0 0 4 7.9v8.2a1.5 1.5 0 0 0 .8 1.3l6.5 3.6a1.5 1.5 0 0 0 1.4 0l6.5-3.6a1.5 1.5 0 0 0 .8-1.3Z"/>'
};

/* --------------------------------------------------------------------------
 *  DEPO FİŞİ — İSKONTO MATEMATİĞİ
 *  --------------------------------------------------------------------------
 *  Tüm satır değerleri SATIR TOPLAMLARINDAN türetilir, yuvarlanmış birim
 *  fiyatlardan DEĞİL.
 *
 *  Neden: birim fiyatı önce kuruşa yuvarlayıp adetle çarpmak, adet büyüdükçe
 *  satır toplamını kaydırır. Örnek — liste 100,00 ₺, iskonto %33,333:
 *      birim bayi = 66,667  →  yuvarlanmış 66,67
 *      3 adet     : 66,67 × 3 = 200,01   (gerçek toplam 200,00)
 *      100 adet   : 66,67 × 100 = 6.667,00 (gerçek toplam 6.666,70)
 *  Fiş ile sitedeki sipariş toplamı böyle ayrışıyordu.
 *
 *  Artık bölme yalnızca GÖSTERİM için yapılır (birim sütunu), toplamlar hep
 *  sunucudan gelen satır tutarlarıdır. Böylece adet 1'den 100'e çıksa da
 *  birim iskonto oranı sabit kalır ve hiçbir satırda kuruş farkı oluşmaz.
 * ------------------------------------------------------------------------*/

/** Fişte ve özet blokta kullanılan varsayılan KDV oranı (yüzde). */
const KDV_ORANI = 20;

/**
 * Bir sipariş kaleminin fiyat künyesi.
 *
 * @param {object} k Normalleştirilmiş kalem (bkz. b2bSiparisNormalle).
 * @returns {{adet:number, birimListe:number, birimBayi:number,
 *            listeToplam:number, satirToplam:number, indirim:number, oran:number}}
 */
function kalemFiyatKunyesi(k) {
  const adet = Number(k.adet) || 0;

  /* Satır toplamları KAYNAK; birim fiyatlar bunlardan türetilir. */
  const satirToplam = Number(k.araToplam);
  const listeToplam = Number(k.listeAraToplam);

  const net = isFinite(satirToplam) ? satirToplam : Number(k.tutar || 0);
  /* Liste bilgisi yoksa (eski sipariş / eklentisiz yol) iskonto YOK sayılır;
     olmayan bir indirimi uydurmak fişi yanlış yapardı. */
  const liste = (isFinite(listeToplam) && listeToplam >= net) ? listeToplam : net;

  const indirim = Math.max(0, liste - net);

  return {
    adet: adet,
    birimListe: adet > 0 ? liste / adet : 0,
    birimBayi: adet > 0 ? net / adet : 0,
    listeToplam: liste,
    satirToplam: net,
    indirim: indirim,
    oran: liste > 0 ? (indirim / liste) * 100 : 0
  };
}

/**
 * Siparişin finansal özeti — fişin alt bloğu bunu birebir basar.
 *
 * KDV iki kipte çalışır:
 *   · Sipariş KDV taşıyorsa (WooCommerce vergisi açık) o tutar kullanılır ve
 *     ara toplamın ÜSTÜNE eklenir.
 *   · Sipariş KDV taşımıyorsa fiyatlar KDV DÂHİL kabul edilir ve tutar
 *     genel toplamdan geri ayrıştırılır (net = toplam / 1,20). Bu kipte fişte
 *     "fiyatlara dâhil" notu basılır; kimse tutarı ikinci kez eklemesin.
 */
function siparisFinansOzeti(s) {
  const kalemler = s.kalemler || [];

  let brutListe = 0;
  let netAra = 0;
  let satirToplamlari = 0;

  kalemler.forEach(function (k) {
    const f = kalemFiyatKunyesi(k);
    brutListe += f.listeToplam;
    netAra += f.satirToplam;
    satirToplamlari += Number(k.tutar || f.satirToplam);
  });

  const iskonto = Math.max(0, brutListe - netAra);
  const genelToplam = Number(s.tutar || 0);
  const kargo = Number(s.kargoTutar || 0);

  /* Kupon / sipariş düzeyi ek indirim: satır ara toplamı ile satır tutarı
     ayrışıyorsa arada kupon vardır. Ayrı satır olarak gösterilir; sessizce
     iskontoya karıştırılsaydı bayi iskonto oranı yanlış görünürdü. */
  const ekIndirim = Math.max(0, netAra - satirToplamlari);

  const kdvHam = Number(s.kdv || 0);
  const kdvDahilMi = !(kdvHam > 0);

  let kdv = kdvHam;

  if (kdvDahilMi) {
    /* Fiyatlar KDV dâhil: net = toplam / (1 + oran), KDV = toplam - net. */
    const carpan = 1 + (KDV_ORANI / 100);
    const kdvsizToplam = genelToplam / carpan;
    kdv = Math.max(0, genelToplam - kdvsizToplam);
  }

  /* Etiketteki oran: vergi varsa gerçek orandan, yoksa varsayılandan. */
  const kdvMatrahi = netAra - ekIndirim + kargo;
  const kdvOrani = (!kdvDahilMi && kdvMatrahi > 0)
    ? Math.round((kdv / kdvMatrahi) * 100)
    : KDV_ORANI;

  return {
    brutListe: brutListe,
    iskonto: iskonto,
    iskontoOrani: brutListe > 0 ? (iskonto / brutListe) * 100 : 0,
    netAra: netAra,
    ekIndirim: ekIndirim,
    kargo: kargo,
    kdv: kdv,
    kdvOrani: isFinite(kdvOrani) && kdvOrani > 0 ? kdvOrani : KDV_ORANI,
    kdvDahilMi: kdvDahilMi,
    genelToplam: genelToplam
  };
}

/** Yüzdeyi fiş için yazar: 12 -> "%12", 12.5 -> "%12,5". */
function fisOranYazi(oran) {
  const n = Number(oran) || 0;
  const yuvarlak = Math.round(n * 10) / 10;
  return '%' + String(yuvarlak).replace('.', ',');
}

function depoFisiHtml(s) {
  const cesit = s.kalemler.length;
  const toplamAdet = s.kalemler.reduce(function (t, k) { return t + k.adet; }, 0);
  const ozet = siparisFinansOzeti(s);

  /* Fiş başlığı alıcı tipine göre değişir (bkz. fisKunyesiHtml). */
  const aliciKod = aliciTipiKodu(s);
  const aliciBilgi = ALICI_TIPLERI[aliciKod] || ALICI_TIPLERI.individual;
  const aliciAdi = aliciKod === 'corporate' ? (s.firma || s.musteri) : s.musteri;

  /* Firma logosu fişe de basılır: ayarlardan logo değiştirildiğinde yazdırılan
     fiş de aynı anda değişsin (kaynak tek: markaLogosu). */
  const logo = markaLogosu();

  /* Yoğunluk kademesi: kalem sayısı arttıkça görsel ve punto otomatik küçülür,
     böylece 30-35 satırlık siparişler de TEK A4 sayfasında kalır.
     Sütun sayısı 7'den 8'e çıktığı için eşikler bir tık aşağı çekildi. */
  const yogunluk = cesit > 24 ? ' sik' : (cesit > 18 ? ' orta' : '');

  const satirlar = s.kalemler.map(function (k) {
    const f = kalemFiyatKunyesi(k);
    const indirimliMi = f.indirim > 0.005;

    return '' +
      '<tr>' +
        '<td class="s-gorsel">' +
          '<img class="urun-gorsel" src="' + kacis(k.gorsel || YEDEK_GORSEL) + '" alt="" ' +
               'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" />' +
        '</td>' +
        '<td class="s-tik"><span class="tik-kutu"></span></td>' +
        '<td class="s-ad">' + kacis(k.ad) + '</td>' +
        '<td class="s-kod">' + kacis(k.kod) + '</td>' +
        '<td class="s-adet">' + k.adet + '</td>' +
        /* Liste birim fiyatı iskonto varsa ÜSTÜ ÇİZİLİ basılır: depocu hangi
           fiyattan hangi fiyata inildiğini tek bakışta görür. */
        '<td class="s-liste' + (indirimliMi ? ' cizili' : '') + '">' +
          kacis(paraSade(f.birimListe)) +
        '</td>' +
        '<td class="s-birim">' + kacis(paraSade(f.birimBayi)) + '</td>' +
        '<td class="s-toplam">' + kacis(paraSade(f.satirToplam)) + '</td>' +
      '</tr>';
  }).join('');

  /* --- Finansal özet satırları --- */
  function ozetSatiri(etiket, deger, sinif) {
    return '<tr' + (sinif ? ' class="' + sinif + '"' : '') + '>' +
             '<td colspan="6" class="etiket">' + etiket + '</td>' +
             '<td colspan="2" class="deger">' + deger + '</td>' +
           '</tr>';
  }

  const ozetSatirlari = '' +
    ozetSatiri('LİSTE FİYATI GENEL TOPLAMI <span class="ince">(iskontosuz brüt)</span>',
               kacis(para(ozet.brutListe))) +

    (ozet.iskonto > 0.005
      ? ozetSatiri('BAYİ İSKONTO TUTARI <span class="ince">(oran: ' +
                     fisOranYazi(ozet.iskontoOrani) + ')</span>',
                   '&minus;' + kacis(para(ozet.iskonto)), 'indirim')
      : ozetSatiri('BAYİ İSKONTOSU', '<span class="ince">uygulanmadı</span>')) +

    ozetSatiri('İSKONTOLU NET ARA TOPLAM', kacis(para(ozet.netAra))) +

    (ozet.ekIndirim > 0.005
      ? ozetSatiri('EK İNDİRİM <span class="ince">(kupon / sipariş indirimi)</span>',
                   '&minus;' + kacis(para(ozet.ekIndirim)), 'indirim')
      : '') +

    (ozet.kargo > 0.005
      ? ozetSatiri('KARGO / NAVLUN', kacis(para(ozet.kargo)))
      : '') +

    ozetSatiri('KDV TUTARI <span class="ince">(' + fisOranYazi(ozet.kdvOrani) +
                 (ozet.kdvDahilMi ? ' &middot; fiyatlara dâhil' : '') + ')</span>',
               kacis(para(ozet.kdv))) +

    ozetSatiri('GENEL TOPLAM <span class="ince">(ödenecek net tutar)</span>',
               kacis(para(ozet.genelToplam)), 'genel');

  return '<!DOCTYPE html>\n' +
'<html lang="tr"><head><meta charset="UTF-8">' +
'<title>Depo Fişi #' + kacis(s.numara) + '</title>' +
'<style>' +
'  @page { size: A4; margin: 8mm; }' +
'  * { box-sizing: border-box; }' +
'  html, body { margin:0; padding:0; }' +
'  body { font-family: "Segoe UI", Arial, sans-serif; background:#e8eaee; color:#0f172a; }' +

'  /* ---- Üst araç çubuğu (kağıda YANSIMAZ) ---- */' +
'  .arac { position: sticky; top:0; z-index:10; display:flex; gap:10px; align-items:center;' +
'          padding:8px 12px; background:#0f172a; box-shadow:0 1px 2px rgba(0,0,0,.25); }' +
'  .arac .baslik { color:#cbd5e1; font-size:12.5px; font-weight:600; margin-right:auto; }' +
'  .arac button { display:inline-flex; align-items:center; gap:6px;' +
'                 font-size:13px; font-weight:600; padding:8px 14px; border:0; border-radius:6px;' +
'                 color:#fff; cursor:pointer; transition:filter .15s, transform .1s; }' +
'  .arac button:hover { filter:brightness(1.12); }' +
'  .arac button:active { transform:scale(.96); }' +
'  .b-yazdir { background:#2563eb; }' +
'  .b-pdf { background:#334155; }' +
'  .b-kapat { background:#334155; }' +

'  /* ---- A4 sayfa ----' +
'     Ölçüler değişkenle veriliyor: kalem sayısı arttıkça .orta / .sik kademesi' +
'     devreye girer ve uzun siparişler de tek sayfada kalır. ---- */' +
'  .sayfa { width:210mm; min-height:297mm; margin:16px auto; padding:8mm; background:#fff;' +
'           box-shadow:0 10px 40px rgba(0,0,0,.28);' +
'           --gorsel:30px; --yazi:10.5px; --imza:11mm; }' +
'  .sayfa.orta { --gorsel:23px; --yazi:10px;   --imza:8mm; }' +
'  .sayfa.sik  { --gorsel:19px; --yazi:9.5px;  --imza:5mm; }' +
'  /* En sık kademede satır yüksekliğini yalnızca görsel hücresi belirler;' +
'     o hücrenin (metni olmayan) boşluğu kısılarak 35 satır tek sayfada tutulur. */' +
'  .sayfa.sik tbody .s-gorsel { padding:1px 4px; }' +
'  .sayfa.sik .bilgi > div { line-height:1.3; }' +

'  /* ---- Üst şerit: tek satırda 2 sütunlu mini başlık ---- */' +
'  .ust { display:flex; align-items:center; justify-content:space-between; gap:10px;' +
'         border:1px solid #e2e8f0; border-radius:3px; padding:3px 6px; margin-bottom:4px; }' +
'  .ust-sol { display:flex; align-items:center; gap:7px; min-width:0; }' +
'  .logo { flex:0 0 auto; height:26px; min-width:26px; max-width:120px; border:1px solid #e2e8f0;' +
'          border-radius:4px; background:#f8fafc; color:#475569;' +
'          display:flex; align-items:center; justify-content:center; overflow:hidden; }' +
'  .logo img { max-height:24px; max-width:116px; object-fit:contain; display:block; }' +
'  .firma { font-size:12px; font-weight:800; line-height:1.2; }' +
'  .fis-turu { font-size:8.5px; font-weight:700; letter-spacing:.6px; color:#64748b; }' +
'  .ust-sag { text-align:right; font-size:10px; line-height:1.35; white-space:nowrap; }' +
'  .ust-sag .no { font-size:13px; font-weight:900; }' +
'  .ust-sag .bayi { font-size:11px; font-weight:800; }' +
'  .ust-sag .etiket { color:#64748b; font-weight:700; }' +

'  /* Alıcı rolü rozeti — ekrandaki mavi [MÜŞTERİ] / yeşil [BAYİ] ile aynı renkler.' +
'     Yazıcı renkli değilse bile çerçeve + kalın yazı ayrımı korur. */' +
'  .alici-rozet { display:inline-block; margin-right:5px; padding:0 5px; border-radius:3px;' +
'                 font-size:8.5px; font-weight:900; letter-spacing:.5px; border:1px solid; }' +
'  .alici-rozet.individual { color:#075985; border-color:#38bdf8; background:#e0f2fe; }' +
'  .alici-rozet.corporate  { color:#065f46; border-color:#34d399; background:#d1fae5; }' +

'  /* ---- Bilgi şeridi: solda bayi künyesi, sağda sipariş özeti ---- */' +
'  .bilgi { display:flex; gap:4px; margin-bottom:4px; }' +
'  .bilgi > div { flex:1; min-width:0; border:1px solid #e2e8f0; border-radius:3px;' +
'                 padding:3px 6px; font-size:10px; line-height:1.45; }' +
'  .bilgi .etiket { color:#64748b; font-weight:700; }' +
'  .bilgi .vurgu { font-weight:800; }' +

'  /* ---- Kompakt ürün tablosu ---- */' +
'  table { width:100%; border-collapse:collapse; table-layout:fixed; }' +
'  thead th { background:#f1f5f9; border:1px solid #e2e8f0; padding:3px 5px;' +
'             font-size:8.5px; font-weight:800; letter-spacing:.2px; text-align:left; color:#334155; }' +
'  tbody td { border:1px solid #e2e8f0; padding:3px 5px; vertical-align:middle; }' +
'  tbody tr:nth-child(even) td { background:#f8fafc; }' +

'  /* ---- Sütun genişlikleri (hem başlık hem hücre) ---- */' +
'  .s-gorsel { width:10mm; text-align:center; }' +
'  .s-tik    { width:7mm;  text-align:center; }' +
'  .s-kod    { width:24mm; }' +
'  .s-adet   { width:11mm; text-align:center; }' +
'  .s-liste  { width:20mm; text-align:right; }' +
'  .s-birim  { width:20mm; text-align:right; }' +
'  .s-toplam { width:22mm; text-align:right; }' +

'  /* Mikro ürün görseli — üst sınır 30x30px */' +
'  .urun-gorsel { width:var(--gorsel); height:var(--gorsel); max-width:30px; max-height:30px;' +
'                 object-fit:cover; border:1px solid #e2e8f0; border-radius:2px;' +
'                 background:#f8fafc; display:block; margin:0 auto; }' +
'  /* display:block — satır altına yazı tabanı boşluğu eklemesin (yer kaybı olmasın) */' +
'  .tik-kutu { display:block; width:12px; height:12px; margin:0 auto; border:1px solid #94a3b8;' +
'              border-radius:2px; background:#fff; }' +

'  tbody .s-ad     { font-size:var(--yazi); font-weight:700; line-height:1.25; word-wrap:break-word; }' +
'  tbody .s-kod    { font-size:9.5px; font-weight:600; font-family:Consolas,"Courier New",monospace;' +
'                    color:#334155; word-wrap:break-word; }' +
'  tbody .s-adet   { font-size:var(--yazi); font-weight:900; }' +
'  /* Liste fiyatı: iskonto varsa üstü çizili ve soluk — indirimli fiyatla' +
'     karışmasın, renksiz yazıcıda da ayrışsın. */' +
'  tbody .s-liste  { font-size:9.5px; font-weight:600; color:#64748b; }' +
'  tbody .s-liste.cizili { text-decoration:line-through; }' +
'  tbody .s-birim  { font-size:var(--yazi); font-weight:800; }' +
'  tbody .s-toplam { font-size:var(--yazi); font-weight:800; }' +

'  tfoot td { padding:3px 6px; font-size:var(--yazi); font-weight:800;' +
'             border:1px solid #e2e8f0; background:#f8fafc; }' +
'  tfoot .etiket { text-align:right; color:#334155; }' +
'  tfoot .deger { text-align:right; white-space:nowrap; }' +
'  tfoot .ince { font-weight:600; color:#64748b; }' +
'  tfoot .indirim td { color:#b91c1c; }' +
'  tfoot .indirim .ince { color:#b91c1c; }' +
'  tfoot .genel td { font-size:12px; font-weight:900; background:#eef2f7;' +
'                    border-top:2px solid #94a3b8; }' +

'  /* ---- Alt bant: sipariş notu ve imzalar YAN YANA (dikeyde yer kazanır) ---- */' +
'  .alt { display:flex; gap:4px; margin-top:4px; align-items:stretch; }' +
'  .not { flex:2; min-width:0; border:1px solid #e2e8f0; border-radius:3px;' +
'         padding:3px 6px; font-size:10px; line-height:1.35; }' +
'  .not .etiket { color:#64748b; font-weight:700; }' +
'  .imzalar { flex:3; display:flex; gap:4px; }' +
'  .imza { flex:1; border:1px solid #e2e8f0; border-radius:3px; padding:3px 6px 2px; }' +
'  .imza .cizgi { height:var(--imza); border-bottom:1px solid #e2e8f0; }' +
'  .imza .etiket { margin-top:2px; font-size:9px; font-weight:700; text-align:center; color:#64748b; }' +

'  .altbilgi { margin-top:3px; border-top:1px solid #e2e8f0; padding-top:2px;' +
'              font-size:8px; display:flex; justify-content:space-between; color:#64748b; }' +

'  /* ---- YAZDIRMA ---- */' +
'  @media print {' +
'    body { background:#fff; }' +
'    .yazdirma-yok { display:none !important; }' +
'    .sayfa { width:auto; min-height:0; margin:0; padding:0; box-shadow:none; }' +
'    thead { display:table-header-group; }' +
'    tfoot { display:table-footer-group; }' +
'    tr { page-break-inside:avoid; }' +
'    .alt { page-break-inside:avoid; }' +
'  }' +
'</style></head><body>' +

'<div class="arac yazdirma-yok">' +
'  <div class="baslik">' + fisIkonu(FIS_IKONLARI.belge) + ' Depo Toplama Fişi &nbsp;·&nbsp; Sipariş #' + kacis(s.numara) +
'    &nbsp;·&nbsp; ' + cesit + ' kalem</div>' +
'  <button class="b-yazdir" id="btnYazdir">' + fisIkonu(FIS_IKONLARI.yazici) + ' YAZDIR</button>' +
'  <button class="b-pdf" id="btnPdf">' + fisIkonu(FIS_IKONLARI.belge) + ' PDF OLARAK KAYDET</button>' +
'  <button class="b-kapat" id="btnKapat">' + fisIkonu(FIS_IKONLARI.carpi) + ' KAPAT</button>' +
'</div>' +

'<div class="sayfa' + yogunluk + '">' +

/* ---- Tek şerit, 2 sütunlu mini başlık: solda firma, sağda sipariş/tarih/bayi ---- */
'  <div class="ust">' +
'    <div class="ust-sol">' +
'      <div class="logo">' +
       (logo
         ? '<img src="' + kacis(logo) + '" alt="" ' +
           'onerror="this.onerror=null;this.parentNode.innerHTML=\'\';" />'
         : fisIkonu(FIS_IKONLARI.paket, 16)) +
'      </div>' +
'      <div>' +
'        <div class="firma">' + kacis(durum.ayarlar.firmaAdi || 'FİRMA ADI') + '</div>' +
'        <div class="fis-turu">DEPO &amp; SEVK FİŞİ &nbsp;·&nbsp; ' +
         (aliciKod === 'corporate' ? 'KURUMSAL BAYİ' : 'BİREYSEL MÜŞTERİ') + '</div>' +
'      </div>' +
'    </div>' +
'    <div class="ust-sag">' +
'      <div><span class="etiket">SİPARİŞ NO:</span> <span class="no">' + kacis(s.numara) + '</span>' +
'           &nbsp;·&nbsp; <span class="etiket">TARİH:</span> ' + kacis(tarihYaz(s.tarih, true)) + '</div>' +
'      <div><span class="alici-rozet ' + aliciKod + '">' + kacis(aliciBilgi.etiket) + '</span>' +
'           <span class="bayi">' + kacis(aliciAdi) + '</span></div>' +
'    </div>' +
'  </div>' +

/* ---- Bilgi şeridi: solda ALICI KÜNYESİ (tipe göre değişir), sağda sipariş özeti ---- */
'  <div class="bilgi">' +
'    <div>' + fisKunyesiHtml(s) + '</div>' +
'    <div>' +
'      <div><span class="etiket">Çeşit:</span> <span class="vurgu">' + cesit + '</span>' +
'           &nbsp;·&nbsp; <span class="etiket">Toplam Adet:</span> <span class="vurgu">' + toplamAdet + '</span></div>' +
'      <div><span class="etiket">Durum:</span> <span class="vurgu">' +
       kacis((s.durumEtiketi || durumBilgisi(s.durum).etiket).toLocaleUpperCase('tr-TR')) + '</span></div>' +
/* Sevkiyat satırı: kargo firması, takip numarası ve serbest ambar notu.
   Üçü de isteğe bağlıdır; hangileri doluysa yalnızca onlar basılır ve
   hiçbiri yoksa satır hiç görünmez (boş "Kargo: —" satırı yer kaybıydı). */
((s.kargo || s.takip || s.sevkiyatNotu)
  ? '      <div><span class="etiket">Sevkiyat:</span> ' +
    [
      s.kargo ? kacis(s.kargo) : '',
      s.takip ? '<span class="etiket">Takip:</span> ' + kacis(s.takip) : '',
      s.sevkiyatNotu ? kacis(s.sevkiyatNotu) : ''
    ].filter(Boolean).join(' &nbsp;·&nbsp; ') + '</div>'
  : '') +
'    </div>' +
'  </div>' +

'  <table>' +
'    <thead><tr>' +
'      <th class="s-gorsel">GÖRSEL</th>' +
'      <th class="s-tik">TİK</th>' +
'      <th class="s-ad">ÜRÜN ADI</th>' +
'      <th class="s-kod">SKU / BARKOD</th>' +
'      <th class="s-adet">MİKTAR</th>' +
'      <th class="s-liste">LİSTE BİRİM</th>' +
'      <th class="s-birim">İSKONTOLU BİRİM</th>' +
'      <th class="s-toplam">SATIR TOPLAMI</th>' +
'    </tr></thead>' +
'    <tbody>' + satirlar + '</tbody>' +
'    <tfoot>' + ozetSatirlari + '</tfoot>' +
'  </table>' +

'  <div class="alt">' +
'    <div class="not"><span class="etiket">SİPARİŞ NOTU:</span> ' + kacis(s.notlar || '—') + '</div>' +
'    <div class="imzalar">' +
'      <div class="imza"><div class="cizgi"></div><div class="etiket">HAZIRLAYAN (Depo)</div></div>' +
'      <div class="imza"><div class="cizgi"></div><div class="etiket">KONTROL EDEN</div></div>' +
'      <div class="imza"><div class="cizgi"></div><div class="etiket">TESLİM ALAN</div></div>' +
'    </div>' +
'  </div>' +

'  <div class="altbilgi">' +
'    <span>' + kacis(durum.ayarlar.firmaAdi || '') + '</span>' +
'    <span>Tutarlar ₺ (Türk Lirası) cinsindendir.</span>' +
'    <span>Yazdırma: ' + kacis(tarihYaz(new Date().toISOString(), true)) + '</span>' +
'  </div>' +

'</div>' +

'<script>' +
'  const { ipcRenderer } = require("electron");' +
'  document.getElementById("btnYazdir").addEventListener("click", function(){ ipcRenderer.invoke("fis:yazdir"); });' +
'  document.getElementById("btnPdf").addEventListener("click", function(){' +
'    ipcRenderer.invoke("fis:pdf", { dosyaAdi: "Depo-Fisi-' + kacis(s.numara) + '" });' +
'  });' +
'  document.getElementById("btnKapat").addEventListener("click", function(){ ipcRenderer.invoke("fis:kapat"); });' +
'  document.addEventListener("keydown", function(o){' +
'    if (o.key === "Escape") ipcRenderer.invoke("fis:kapat");' +
'    if ((o.ctrlKey || o.metaKey) && o.key.toLowerCase() === "p") { o.preventDefault(); ipcRenderer.invoke("fis:yazdir"); }' +
'  });' +
'<\/script></body></html>';
}

/** Siparişi hem ana listede hem bayi kartı listesinde arar. */
function siparisBul(id) {
  const kaynaklar = [durum.siparisler, durum.bayiSiparisleri || []];
  for (let i = 0; i < kaynaklar.length; i++) {
    const bulunan = kaynaklar[i].filter(function (x) { return String(x.id) === String(id); })[0];
    if (bulunan) return bulunan;
  }
  return null;
}

async function depoFisiAc(id) {
  const s = siparisBul(id);
  if (!s) {
    bildir('Sipariş bulunamadı. Listeyi yenileyip tekrar deneyin.', 'uyari');
    return;
  }

  const cevap = await ipcRenderer.invoke('fis:onizleme', {
    html: depoFisiHtml(s),
    baslik: 'Depo Fişi #' + s.numara
  });

  if (!cevap || !cevap.ok) {
    bildir((cevap && cevap.hata) || 'Fiş penceresi açılamadı.', 'hata');
  }
}

/* ==========================================================================
 *  BÖLÜM 11 — AYARLAR
 * ========================================================================*/

/* --------------------------------------------------------------------------
 *  GELİŞTİRİCİ KİLİDİ (MASTER LOCK)
 *  --------------------------------------------------------------------------
 *  "API & Sistem Ayarları" sekmesi menünün en altındadır, kilit ikonu
 *  taşır ve şifre doğrulanmadan İÇERİĞİ HİÇ ÇİZİLMEZ.
 *
 *  Neden gerekli: panel mağazanın kasasında, depoda, tezgâhta açık durur.
 *  API anahtarları ya da çalışma modu yanlışlıkla değiştirildiğinde sitenin
 *  siparişleri panele hiç düşmez ve arıza "uygulama bozuldu" olarak gelir.
 *
 *  Şifre nasıl saklanır: DÜZ METİN OLARAK HİÇBİR YERDE TUTULMAZ. Aşağıdaki
 *  sabit, varsayılan yönetici şifresinin SHA-256 özetidir; girilen metin de
 *  aynı işlevden geçirilip özetler karşılaştırılır.
 *
 *  Sınır — dürüstçe: bu kilit KAZA ÖNLEYİCİDİR, güvenlik sınırı değildir.
 *  Uygulama dosyalarına erişebilen biri özeti değiştirebilir; asıl koruma
 *  WooCommerce tarafındaki anahtar izinleridir.
 *
 *  Kilit oturumluktur: uygulama kapanınca sıfırlanır (diske yazılmaz), çünkü
 *  "bir kez açtım, hep açık kalsın" davranışı kilidin amacını ortadan kaldırır.
 * ------------------------------------------------------------------------*/

/** Geliştirici şifresinin SHA-256 özeti. Düz metin hiçbir yerde tutulmaz. */
const MASTER_SIFRE_OZETI = '5e4a9ff60df0ceef1508059f8a2cfc409c99e20ffee3bc3fb22fc4ee8687aecb';

/** Verilen metnin SHA-256 özeti (küçük harf onaltılık). */
function sha256Hex(metin) {
  /* Node'un crypto modülü senkron ve her zaman kullanılabilir; tarayıcının
     crypto.subtle'ı file:// altında "secure context" saymayabilir. */
  return require('crypto').createHash('sha256')
    .update(String(metin === null || metin === undefined ? '' : metin), 'utf8')
    .digest('hex');
}

/** Girilen şifre doğru mu? (Sabit özetle karşılaştırır.) */
function masterSifreDogruMu(girilen) {
  return sha256Hex(girilen) === MASTER_SIFRE_OZETI;
}

/**
 * Kilidin arayüzdeki karşılığını uygular.
 * Kapalıyken #ayarlarIcerik DOM'da `hidden` kalır — üstü örtülmez, hiç çizilmez.
 */
function masterKilidiUygula() {
  const acik = !!durum.masterKilitAcik;

  const perde = $('#ayarKilitPerdesi');
  const icerik = $('#ayarlarIcerik');
  const simge = $('#ayarKilitSimgesi');

  if (perde) perde.classList.toggle('hidden', acik);
  if (icerik) icerik.classList.toggle('hidden', !acik);

  if (simge) {
    simge.innerHTML = ikon(acik ? 'kilitAcik' : 'kilit');
    simge.title = acik
      ? 'Geliştirici kilidi bu oturum için açık'
      : 'Geliştirici kilidi — şifre gerekir';
  }
}

/** Şifre penceresindeki uyarı kutusu. */
function kilitUyar(mesaj) {
  const kutu = $('#kilitUyari');
  if (!kutu) return;

  if (!mesaj) { kutu.classList.add('hidden'); kutu.textContent = ''; return; }
  kutu.textContent = mesaj;
  kutu.classList.remove('hidden');
}

function kilitPenceresiniKapat() {
  const katman = $('#kilitModalKatman');
  const girdi = $('#kilitSifre');
  const gosterBtn = $('#kilitSifreGosterBtn');

  if (katman) katman.classList.add('hidden');
  /* Şifre DOM'da asılı kalmasın. */
  if (girdi) { girdi.value = ''; girdi.type = 'password'; }
  if (gosterBtn) gosterBtn.innerHTML = ikon('goz');
  kilitUyar('');
}

/**
 * Şifre penceresini açar ve kilidin açılıp açılmadığını döndürür.
 * @returns {Promise<boolean>}
 */
function masterKilidiSor() {
  if (durum.masterKilitAcik) return Promise.resolve(true);

  const katman = $('#kilitModalKatman');
  const girdi = $('#kilitSifre');
  const tamam = $('#kilitTamam');
  const vazgec = $('#kilitVazgec');

  if (!katman || !girdi || !tamam || !vazgec) return Promise.resolve(false);

  return new Promise(function (cozumle) {
    /* Aynı anda ikinci bir pencere açılmasın (menüye üst üste tıklama). */
    if (durum.kilitPenceresiAcik) { cozumle(false); return; }
    durum.kilitPenceresiAcik = true;

    kilitUyar('');
    girdi.value = '';
    girdi.type = 'password';
    katman.classList.remove('hidden');
    setTimeout(function () { girdi.focus(); }, 40);

    const bitir = function (sonuc) {
      tamam.removeEventListener('click', onayla2);
      vazgec.removeEventListener('click', iptal);
      katman.removeEventListener('mousedown', disaTikla);
      katman.removeEventListener('keydown', tusla);
      durum.kilitPenceresiAcik = false;
      kilitPenceresiniKapat();
      cozumle(sonuc);
    };

    function onayla2() {
      const deger = girdi.value;

      if (!deger) {
        kilitUyar('Şifre boş olamaz.');
        girdi.focus();
        return;
      }

      if (!masterSifreDogruMu(deger)) {
        /* Kaç deneme yapıldığı söylenmez ve hesap kilitlenmez: bu bir kaza
           önleyicidir, kaba kuvvet saldırısına karşı bir savunma değil. */
        kilitUyar('Şifre hatalı.\nDoğru şifreyi bilmiyorsanız kurulumu yapan geliştirici ile görüşün.');
        girdi.value = '';
        girdi.focus();
        return;
      }

      durum.masterKilitAcik = true;
      masterKilidiUygula();
      /* Anahtar kutuları kilit açılana kadar boş bırakılıyordu; şimdi doldur. */
      ayarFormunuDoldur();
      bitir(true);
      bildir('Geliştirici kilidi açıldı.\nUygulamayı kapatınca yeniden şifre sorulur.', 'basari');
    }

    function iptal() { bitir(false); }

    function disaTikla(o) { if (o.target === katman) bitir(false); }

    function tusla(o) {
      if (o.key === 'Escape') { bitir(false); return; }
      if (o.key === 'Enter') { o.preventDefault(); onayla2(); }
    }

    tamam.addEventListener('click', onayla2);
    vazgec.addEventListener('click', iptal);
    katman.addEventListener('mousedown', disaTikla);
    katman.addEventListener('keydown', tusla);
  });
}

function ayarFormunuDoldur() {
  /* Geliştirici kilidi kapalıyken site adresi ve API anahtarları DOM'a hiç
     yazılmaz. Yalnızca gizlemek yetmez: F12 konsolu ya da bir ekran
     yakalayıcı gizli kutunun içindeki değeri de okuyabilirdi. */
  const kilitAcik = !!durum.masterKilitAcik;

  $('#girdiFirmaAdi').value = durum.ayarlar.firmaAdi || '';
  $('#girdiUrl').value = kilitAcik ? (durum.ayarlar.wooUrl || '') : '';
  $('#girdiCk').value = kilitAcik ? (durum.ayarlar.ck || '') : '';
  $('#girdiCs').value = kilitAcik ? (durum.ayarlar.cs || '') : '';
  $('#girdiB2bAlan').value = durum.ayarlar.b2bAlan || '';
  $('#girdiB2bBekliyor').value = durum.ayarlar.b2bBekliyor || '';
  $('#girdiB2bOnay').value = durum.ayarlar.b2bOnaylandi || '';
  $('#girdiB2bRed').value = durum.ayarlar.b2bReddedildi || '';
  $('#girdiOnayEpostasi').checked = durum.ayarlar.onayEpostasi !== false;
  $('#girdiDurumEpostasi').checked = durum.ayarlar.durumEpostasi !== false;
  $('#otoYenileKutu').checked = !!durum.ayarlar.otoYenile;
  modToggleTazele();
  apiKilidiniUygula();
  logoOnizlemeGuncelle();
}

/** Ayarlar sekmesindeki yerel logo önizlemesini durum.ayarlar.yerelLogo'ya göre çizer. */
/**
 * Marka görseli değişti: damgayı artırır ve logonun göründüğü TÜM yüzeyleri
 * aynı anda tazeler.
 *
 * Tek çağrı olması bilerek: eskiden çağıranların bazısı yalnızca önizlemeyi,
 * bazısı yalnızca başlığı tazeliyordu; ayarlarda yeni logo seçilmesine rağmen
 * sol üstteki marka alanı eski görseli göstermeye devam ediyordu. Depo fişi
 * de logoyu her açılışta `markaLogosu()` üzerinden okur, ayrıca tazelenmesi
 * gerekmez (bkz. depoFisiHtml).
 */
function markaGorseliDegisti() {
  durum.logoDamgasi++;
  logoOnizlemeGuncelle();
  firmaLogosunuUygula();
}

function logoOnizlemeGuncelle() {
  const kutu = $('#logoOnizlemeKutu');
  const img = $('#logoOnizleme');
  const yokKutu = $('#logoYokKutu');
  const kaldirBtn = $('#logoKaldirBtn');
  if (!kutu || !img || !yokKutu || !kaldirBtn) return;

  const kaynak = String(durum.ayarlar.yerelLogo || '').trim();

  if (kaynak) {
    img.src = kaynak;
    kutu.classList.remove('hidden');
    yokKutu.classList.add('hidden');
    kaldirBtn.classList.remove('hidden');
  } else {
    kutu.classList.add('hidden');
    yokKutu.classList.remove('hidden');
    kaldirBtn.classList.add('hidden');
  }
}

/** Seçilen dosyayı yerel logo olarak kaydeder (base64, ayarlar.json içinde saklanır). */
async function yerelLogoYukle(dosya) {
  if (!dosya) return;

  if (!/^image\//.test(dosya.type)) {
    bildir('Lütfen bir görsel dosyası seçin (PNG, JPG, SVG…).', 'uyari');
    return;
  }
  if (dosya.size > 3 * 1024 * 1024) {
    bildir('Logo dosyası çok büyük (en fazla 3 MB).', 'uyari');
    return;
  }

  try {
    const veriAdresi = await dosyayiVeriAdresineCevir(dosya);
    durum.ayarlar = await ipcRenderer.invoke('ayar:yaz', { yerelLogo: veriAdresi });
    markaGorseliDegisti();
    bildir('Yerel logo kaydedildi.' +
           (durum.ayarlar.siteLogosu ? '\n(Sitenizin logosu bulunduğu için üst çubukta öncelikli gösterilir.)' : ''),
           'basari');
  } catch (e) {
    bildir('Logo yüklenemedi:\n' + String((e && e.message) || e), 'hata');
  }
}

async function yerelLogoKaldir() {
  durum.ayarlar = await ipcRenderer.invoke('ayar:yaz', { yerelLogo: '' });
  markaGorseliDegisti();
  bildir('Yerel logo kaldırıldı.', 'bilgi');
}

/* --------------------------------------------------------------------------
 *  SİTE FAVICON'U
 *  --------------------------------------------------------------------------
 *  Logo ile aynı desende çalışır: dosya base64'e çevrilip ayarlar.json'a
 *  yazılır, "DEĞİŞİKLİKLERİ WEB SİTESİNE GÖNDER" ile theme-config'in
 *  `branding.favicon` alanına iletilir (bkz. renderer-ek.js → vitrinGonder).
 *
 *  Boyut sınırı logodan küçüktür (1 MB): favicon her sayfa isteğinde
 *  yüklenir, base64 olarak yapılandırmaya gömülen büyük bir dosya sitenin
 *  her sayfasını yavaşlatırdı.
 * ------------------------------------------------------------------------*/

const EN_BUYUK_FAVICON_MB = 1;

/** Vitrin sekmesindeki favicon önizlemesini durum.ayarlar.yerelFavicon'a göre çizer. */
function faviconOnizlemeGuncelle() {
  const kutu = $('#faviconOnizlemeKutu');
  const img = $('#faviconOnizleme');
  const yokKutu = $('#faviconYokKutu');
  const kaldirBtn = $('#faviconKaldirBtn');
  if (!kutu || !img || !yokKutu || !kaldirBtn) return;

  const kaynak = String(durum.ayarlar.yerelFavicon || '').trim();

  if (kaynak) {
    img.src = kaynak;
    kutu.classList.remove('hidden');
    yokKutu.classList.add('hidden');
    kaldirBtn.classList.remove('hidden');
  } else {
    kutu.classList.add('hidden');
    yokKutu.classList.remove('hidden');
    kaldirBtn.classList.add('hidden');
  }
}

async function faviconYukle(dosya) {
  if (!dosya) return;

  /* .ico dosyalarında tarayıcı türü "image/x-icon" ya da boş verebilir;
     bu yüzden tür kontrolü uzantıyı da kabul eder. */
  const gorselMi = /^image\//.test(dosya.type) || /\.(ico|png|svg|webp)$/i.test(dosya.name || '');
  if (!gorselMi) {
    bildir('Lütfen bir görsel dosyası seçin (PNG, ICO, SVG veya WEBP).', 'uyari');
    return;
  }
  if (dosya.size > EN_BUYUK_FAVICON_MB * 1024 * 1024) {
    bildir('Favicon dosyası çok büyük (en fazla ' + EN_BUYUK_FAVICON_MB + ' MB).\n' +
           'Favicon her sayfa açılışında yüklenir; küçük tutun.', 'uyari');
    return;
  }

  try {
    const veriAdresi = await dosyayiVeriAdresineCevir(dosya);
    durum.ayarlar = await ipcRenderer.invoke('ayar:yaz', { yerelFavicon: veriAdresi });
    faviconOnizlemeGuncelle();
    bildir('Favicon kaydedildi.\n' +
           'Sitede görünmesi için "DEĞİŞİKLİKLERİ WEB SİTESİNE GÖNDER" deyin.', 'basari');
  } catch (e) {
    bildir('Favicon yüklenemedi:\n' + String((e && e.message) || e), 'hata');
  }
}

async function faviconKaldir() {
  durum.ayarlar = await ipcRenderer.invoke('ayar:yaz', { yerelFavicon: '' });
  faviconOnizlemeGuncelle();
  bildir('Favicon kaldırıldı.\nSiteye işlenmesi için vitrini yeniden gönderin.', 'bilgi');
}

/** Bir anahtarın ortasını gizler: "ck_1234••••••••90ab" (kısa değerlerde tamamı gizlenir). */
function alanMaskele(deger) {
  const s = String(deger || '');
  if (s.length <= 8) return s.replace(/./g, '•');
  return s.slice(0, 4) + '••••••••' + s.slice(-4);
}

/**
 * Bağlantı kilidini arayüze uygular: kilitliyken Site Adresi / Consumer Key /
 * Secret kutuları salt okunur olur, anahtarlar maskelenir ve "KİLİDİ AÇ"
 * kutusu görünür. Amaç kullanıcının ya da bayi sahibi çalışan birinin
 * doğrulanmış bir bağlantıyı yanlışlıkla bozmasını önlemek (bkz. main.js
 * varsayilanAyarlar → apiKilitli notu).
 */
function apiKilidiniUygula() {
  const kilitli = !!durum.ayarlar.apiKilitli;
  const kutu = $('#apiKilitKutusu');
  const url = $('#girdiUrl');
  const ck = $('#girdiCk');
  const cs = $('#girdiCs');
  const csBtn = $('#csGosterBtn');

  if (kutu) kutu.classList.toggle('hidden', !kilitli);

  [url, ck, cs].forEach(function (alan) {
    if (!alan) return;
    alan.readOnly = kilitli;
    alan.classList.toggle('opacity-60', kilitli);
    alan.classList.toggle('cursor-not-allowed', kilitli);
  });

  /* Geliştirici kilidi (master lock) kapalıysa anahtarlar DOM'a hiç yazılmaz;
     maskeli hâlleri bile yazılmaz, çünkü maske de anahtarın ilk/son 4 hanesini
     sızdırır (bkz. alanMaskele). Bkz. GELİŞTİRİCİ KİLİDİ bölümü. */
  const masterAcik = !!durum.masterKilitAcik;

  if (ck) ck.value = !masterAcik ? '' : (kilitli ? alanMaskele(durum.ayarlar.ck) : (durum.ayarlar.ck || ''));
  if (cs) {
    cs.type = 'password';
    cs.value = !masterAcik ? '' : (kilitli ? alanMaskele(durum.ayarlar.cs) : (durum.ayarlar.cs || ''));
  }
  if (csBtn) {
    csBtn.disabled = kilitli;
    csBtn.classList.toggle('opacity-60', kilitli);
    csBtn.classList.toggle('cursor-not-allowed', kilitli);
    csBtn.innerHTML = ikon('goz');
  }
}

/** Başarılı bağlantı testinden sonra kilidi otomatik kapatır (henüz kapalıysa). */
async function apiBaglantisiniKilitle() {
  if (durum.ayarlar.apiKilitli) return;
  durum.ayarlar.apiKilitli = true;
  await ipcRenderer.invoke('ayar:yaz', { apiKilitli: true });
  apiKilidiniUygula();
}

function modToggleTazele() {
  const demo = !!durum.ayarlar.demoModu;
  const dugme = $('#modToggle');
  const topuz = $('#modTopuz');

  dugme.setAttribute('aria-checked', demo ? 'true' : 'false');
  dugme.className =
    'relative shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 ' +
    'focus:ring-marka-600/30 ' + (demo ? 'bg-amber-400' : 'bg-emerald-500');

  /* Topuzun açık konumu `mod-topuz-sag` ile verilir; kayma mesafesi anahtarın
     gerçek genişliğine bağlı olduğu için CSS'te durur. Tailwind'in sabit
     translate-x-* değeri topuzu anahtarın dışına, "Canlı Mod" yazısının
     üstüne taşıyordu. */
  topuz.className =
    'absolute rounded-full bg-white shadow-lg transition-transform duration-200 ' +
    (demo ? '' : 'mod-topuz-sag');

  $('#etiketDemo').className = 'mod-etiket' + (demo ? '' : ' opacity-40');
  $('#etiketCanli').className = 'mod-etiket' + (demo ? ' opacity-40' : '');

  $('#modAciklama').innerHTML = demo
    ? 'Şu an <b>Demo Modu</b> açık. Ekrandaki siparişler, ürünler ve üyeler örnek verilerdir; ' +
      'sitenizde <b>hiçbir değişiklik yapılmaz</b>. Sunum ve deneme için güvenlidir.'
    : 'Şu an <b>Canlı Mod</b> açık. Veriler <b>gerçek WooCommerce sitenizden</b> gelir ve ' +
      'yaptığınız <b>sipariş durumu / bayi onayı / fiyat / stok</b> değişiklikleri <b>siteye anında işlenir</b>. Dikkatli olun!';
}

async function ayarlariKaydet(sessizMi) {
  /* Kilitliyken kutular maskeli metin gösterir ("ck_1234••••••••90ab");
     DOM'dan okuyup kaydedersek gerçek anahtarın üzerine maskeyi yazarız.
     Bu yüzden kilitliyken adres/anahtarlar durum.ayarlar'dan (belleğteki
     gerçek değerlerden) alınır, DOM'a hiç bakılmaz. */
  const kilitli = !!durum.ayarlar.apiKilitli;

  /* Geliştirici kilidi kapalıyken adres/anahtar kutuları BOŞ durur
     (bkz. ayarFormunuDoldur). O hâldeki DOM'u kaydetmek, kayıtlı anahtarların
     üzerine boş dize yazıp bağlantıyı koparırdı. */
  const domGuvenilir = !kilitli && !!durum.masterKilitAcik;

  const yeni = {
    firmaAdi: $('#girdiFirmaAdi').value.trim(),
    wooUrl: domGuvenilir ? $('#girdiUrl').value.trim() : (durum.ayarlar.wooUrl || ''),
    ck: domGuvenilir ? $('#girdiCk').value.trim() : (durum.ayarlar.ck || ''),
    cs: domGuvenilir ? $('#girdiCs').value.trim() : (durum.ayarlar.cs || ''),
    apiKilitli: kilitli,
    demoModu: !!durum.ayarlar.demoModu,
    tema: durum.ayarlar.tema,
    otoYenile: !!$('#otoYenileKutu').checked,
    otoYenileSaniye: durum.ayarlar.otoYenileSaniye || 60,
    onayEpostasi: !!$('#girdiOnayEpostasi').checked,
    durumEpostasi: !!$('#girdiDurumEpostasi').checked,
    b2bAlan: $('#girdiB2bAlan').value.trim() || 'b2b_durum',
    b2bBekliyor: $('#girdiB2bBekliyor').value.trim() || 'bekliyor',
    b2bOnaylandi: $('#girdiB2bOnay').value.trim() || 'onaylandi',
    b2bReddedildi: $('#girdiB2bRed').value.trim() || 'reddedildi'
  };

  const adresDegisti = yeni.wooUrl !== durum.ayarlar.wooUrl ||
                       yeni.ck !== durum.ayarlar.ck ||
                       yeni.cs !== durum.ayarlar.cs;

  durum.ayarlar = await ipcRenderer.invoke('ayar:yaz', yeni);

  // Adres/anahtar değiştiyse eklenti tanıması yeniden yapılmalı
  if (adresDegisti) {
    durum.eklentiTanindi = false;
    durum.b2bVar = false;
    durum.siteBilgisi = null;
    durum.logoKontrolEdildi = false; // Yeni site — logo yeniden çekilsin.
  }

  apiKilidiniUygula();
  ustCubuguTazele();
  otoYenileyiAyarla();

  if (!sessizMi) bildir('Ayarlar kaydedildi.', 'basari');
}

async function baglantiTestEt() {
  const kutu = $('#testSonucu');
  const dugme = $('#baglantiTestBtn');

  // Test her zaman ekrandaki güncel bilgilerle yapılsın
  await ayarlariKaydet(true);

  dugme.disabled = true;
  const eski = dugme.innerHTML;
  dugme.innerHTML = '<span class="donuyor">' + ikon('donen') + '</span> TEST EDİLİYOR…';

  kutu.classList.remove('hidden');
  kutu.className = 'rounded-xl p-4 text-lg font-semibold whitespace-pre-line bg-slate-100 dark:bg-slate-900 ' +
                   'border-2 border-slate-300 dark:border-slate-600';
  kutu.textContent = 'Sitenize bağlanılıyor…';

  /* 1) Önce B2B Core eklentisinin /ping ucu denenir */
  const pingCevap = await b2b('ping');
  durum.eklentiTanindi = true;

  if (pingCevap.ok && pingCevap.veri && pingCevap.veri.ok) {
    durum.b2bVar = true;
    durum.siteBilgisi = pingCevap.veri;
    durum.canliBaglantiTamam = true;

    const p = pingCevap.veri;

    /* Pano sayaçlarını da çekip özet gösterelim */
    const statCevap = await b2b('stats');
    let ozet = '';
    if (statCevap.ok && statCevap.veri) {
      const st = statCevap.veri;
      const bekleyenBayi = (st.dealers && st.dealers.pending) || 0;
      const onayliBayi = (st.dealers && st.dealers.approved) || 0;
      ozet = '\n\nSitedeki durum:' +
             '\n   · Onay bekleyen bayi: ' + bekleyenBayi +
             '\n   · Onaylı bayi: ' + onayliBayi +
             '\n   · Bugünkü sipariş: ' + (st.orders_today || 0);
    }

    kutu.className = 'rounded-xl p-4 text-lg font-semibold whitespace-pre-line bg-emerald-50 text-emerald-900 ' +
                     'border-2 border-emerald-300 dark:bg-emerald-500/10 dark:text-emerald-200 dark:border-emerald-500/30';
    kutu.textContent = 'BAĞLANTI BAŞARILI!\n\n' +
      'B2B Core eklentisi bulundu (sürüm ' + (p.version || '?') + ')\n' +
      'Site: ' + (p.site || '—') + '\n' +
      'WooCommerce: ' + (p.wc_version || '—') + '\n' +
      'Bağlanan kullanıcı: ' + (p.user || '—') + '\n' +
      'Para birimi: ' + (p.currency || '—') +
      ozet +
      (durum.ayarlar.demoModu ? '\n\nCanlı verileri görmek için yukarıdaki anahtarı "Canlı Mod"a alın.' : '');

    bildir('Bağlantı başarılı — B2B Core bağlı!', 'basari');
    dugme.disabled = false;
    dugme.innerHTML = eski;
    await apiBaglantisiniKilitle();
    ustCubuguTazele();
    return;
  }

  /* 2) Eklenti yoksa WooCommerce çekirdeği denenir */
  const wooCevap = await woo('orders', { sorgu: { per_page: 1 } });

  dugme.disabled = false;
  dugme.innerHTML = eski;

  if (wooCevap.ok) {
    durum.b2bVar = false;
    durum.siteBilgisi = null;
    durum.canliBaglantiTamam = true;

    kutu.className = 'rounded-xl p-4 text-lg font-semibold whitespace-pre-line bg-amber-50 text-amber-900 ' +
                     'border-2 border-amber-300 dark:bg-amber-500/10 dark:text-amber-200 dark:border-amber-500/30';
    kutu.textContent = 'WOOCOMMERCE BAĞLANTISI BAŞARILI — ANCAK B2B CORE EKLENTİSİ YOK\n\n' +
      'Anahtarlarınız çalışıyor' + (wooCevap.toplam ? ' (sitede ' + wooCevap.toplam + ' sipariş bulundu)' : '') + '.\n\n' +
      'Şu özellikler için sitenizde "B2B Core" eklentisinin kurulu ve etkin olması gerekir:\n' +
      '   · Bayi başvurularının onaylanması (approved_dealer)\n' +
      '   · [Hazırlanıyor] / [Sipariş Hazır] / [Kargoya Verildi] B2B sipariş durumları\n' +
      '   · Sürükle-bırak ile görsel yükleme\n\n' +
      'Eklentisiz çalışırken uygulama WooCommerce\'in kendi durumlarını kullanır.';

    bildir('Bağlantı kuruldu, ancak B2B Core eklentisi bulunamadı.', 'uyari');
    await apiBaglantisiniKilitle();
  } else {
    durum.canliBaglantiTamam = false;
    kutu.className = 'rounded-xl p-4 text-lg font-semibold whitespace-pre-line bg-red-50 text-red-900 ' +
                     'border-2 border-red-300 dark:bg-red-500/10 dark:text-red-200 dark:border-red-500/30';
    kutu.textContent = 'BAĞLANTI KURULAMADI\n\n' + wooCevap.hata;
    bildir('Bağlantı kurulamadı.', 'hata');
  }

  ustCubuguTazele();
}

/** Demo Canlı geçişi. Canlıya geçerken uyarı gösterir ve verileri tazeler. */
async function moduDegistir() {
  const demoyaMiGeciyor = !durum.ayarlar.demoModu;

  if (!demoyaMiGeciyor) {
    // Canlı moda geçiliyor
    if (!$('#girdiUrl').value.trim() || !$('#girdiCk').value.trim() || !$('#girdiCs').value.trim()) {
      bildir('Canlı moda geçmek için önce Site Adresi, Consumer Key ve Consumer Secret alanlarını doldurun.', 'uyari');
      return;
    }
    const eminMi = await onayla(
      'Canlı Moda Geçiş',
      'Canlı modda gördüğünüz bütün bilgiler GERÇEK sitenizden gelir.\n\n' +
      'Yapacağınız sipariş durumu, bayi onayı, fiyat ve stok değişiklikleri siteye ANINDA işlenir.\n\nDevam edilsin mi?',
      'EVET, CANLI MODA GEÇ',
      false
    );
    if (!eminMi) return;
  }

  durum.ayarlar.demoModu = demoyaMiGeciyor;
  await ayarlariKaydet(true);
  modToggleTazele();

  durum.canliBaglantiTamam = false;
  durum.eklentiTanindi = false;
  durum.b2bVar = false;
  durum.siteBilgisi = null;
  durum.logoKontrolEdildi = false;

  // Tüm listeleri sıfırla
  durum.siparisler = [];
  durum.urunler = [];
  durum.uyeler = [];
  durum.bayiSiparisleri = [];
  durum.siparisSuzgec = '';
  durum.bekleyenUyeSayisi = 0;
  $('#urunArama').value = '';
  $('#uyeArama').value = '';

  await eklentiyiTani();
  durum.eklentiTanindi = true;

  uyeSayaciTazele();
  siparisSuzgecleriCiz();
  ustCubuguTazele();

  bildir(demoyaMiGeciyor ? 'Demo Moduna geçildi.' : 'Canlı Moda geçildi.', demoyaMiGeciyor ? 'uyari' : 'basari');

  await siparisleriYukle();
  if (durum.aktifSekme === 'urunler') urunleriYukle();
  bekleyenSayisiniTazele();
  otoYenileyiAyarla();
}

/* ==========================================================================
 *  BÖLÜM 12 — TEMA VE GÖRÜNÜM ÖLÇEĞİ (UI ZOOM)
 * ========================================================================*/

function temayiUygula() {
  const koyu = durum.ayarlar.tema === 'koyu';
  document.documentElement.classList.toggle('dark', koyu);
  $('#temaBtn').innerHTML = ikon(koyu ? 'gunes' : 'ay');
}

/* Ölçeğin kendisi index.html'in başındaki betikte uygulanır (açılışta ekran
   zıplamasın diye). Buradaki işler sadece arayüzü seçili değere göre tazelemek. */

function olcekSecenekleri() {
  return window.B2B_OLCEK_SECENEKLERI || [70, 80, 90, 100, 110, 120];
}

function olcekSuAn() {
  return window.B2B_OLCEK || (window.b2bOlcekOku ? window.b2bOlcekOku() : 100);
}

/** Üstteki kutuyu ve Ayarlar'daki butonları seçili ölçeğe göre boyar. */
function olcekArayuzunuTazele() {
  const secili = olcekSuAn();

  const kutu = $('#zoomSecUst');
  if (kutu) kutu.value = String(secili);

  $$('#zoomSecenekleri [data-zoom]').forEach(function (btn) {
    const bu = Number(btn.dataset.zoom) === secili;
    btn.className = 'h-12 rounded-xl border-2 text-lg font-extrabold transition active:scale-95 ' +
      (bu
        ? 'bg-marka-700 border-marka-800 text-white shadow-lg'
        : 'bg-slate-50 hover:bg-slate-100 border-slate-300 text-slate-700 ' +
          'dark:bg-slate-900 dark:hover:bg-slate-700 dark:border-slate-600 dark:text-slate-200');
  });

  const bilgi = $('#zoomBilgi');
  if (bilgi) {
    bilgi.textContent = secili === 100
      ? 'Şu an: %100 (Varsayılan)'
      : 'Şu an: %' + secili + (secili < 100 ? ' — ekrana daha çok satır sığar.' : ' — yazılar daha büyük görünür.');
  }
}

/** Yeni ölçeği uygular, saklar ve arayüzü tazeler. */
function olcegiDegistir(yuzde, sessizMi) {
  const uygulanan = window.b2bOlcekUygula ? window.b2bOlcekUygula(yuzde) : 100;
  olcekArayuzunuTazele();
  if (!sessizMi) {
    bildir('Görünüm ölçeği %' + uygulanan + ' yapıldı.' +
           (uygulanan === 100 ? '' : '\nBu seçim hatırlanır, uygulama açılışında geri yüklenir.'), 'bilgi');
  }
}

/** Ctrl + / Ctrl − kısayolları için listede bir adım ilerler. */
function olcegiKaydir(yon) {
  const liste = olcekSecenekleri();
  const simdi = liste.indexOf(olcekSuAn());
  const hedef = Math.min(liste.length - 1, Math.max(0, (simdi === -1 ? liste.indexOf(100) : simdi) + yon));
  olcegiDegistir(liste[hedef], false);
}

/* ==========================================================================
 *  BÖLÜM 13 — OLAY BAĞLANTILARI VE BAŞLANGIÇ
 * ========================================================================*/

function olaylariBagla() {

  /* --- Sol menü --- */
  $$('.menu-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { sekmeAc(btn.dataset.sekme); });
  });

  /* --- Tema --- */
  $('#temaBtn').addEventListener('click', async function () {
    durum.ayarlar.tema = durum.ayarlar.tema === 'koyu' ? 'acik' : 'koyu';
    temayiUygula();
    await ipcRenderer.invoke('ayar:yaz', { tema: durum.ayarlar.tema });
  });

  /* --- Görünüm ölçeği (üst çubuk + Ayarlar) --- */
  $('#zoomSecUst').addEventListener('change', function () {
    olcegiDegistir($('#zoomSecUst').value, false);
  });

  $('#zoomSecenekleri').addEventListener('click', function (o) {
    const btn = o.target.closest('[data-zoom]');
    if (btn) olcegiDegistir(btn.dataset.zoom, false);
  });

  /* --- Yenile butonları --- */
  $('#siparisYenileBtn').addEventListener('click', function () { siparisleriYukle(); });
  $('#urunYenileBtn').addEventListener('click', function () { urunleriYukle($('#urunArama').value); });
  $('#uyeYenileBtn').addEventListener('click', function () { uyeleriYukle(); });

  /* --- Sipariş sekmeleri: [Aktif] [Kargodakiler] [Teslim Edilenler] --- */
  const siparisSekmeKap = $('#siparisSekmeler');
  if (siparisSekmeKap) {
    siparisSekmeKap.addEventListener('click', function (o) {
      const btn = o.target.closest('[data-siparis-sekme]');
      if (!btn) return;

      const yeni = btn.dataset.siparisSekme;
      if (yeni === durum.siparisSekme) return;

      durum.siparisSekme = yeni;

      /* Sekme değişince süzgeç ve elde tutulan liste sıfırlanır: yeni sekme
         BAŞKA bir kümedir, eski kayıtları taşımak hayalet satır üretirdi. */
      durum.siparisSuzgec = '';
      durum.siparisler = [];
      durum.siparislerToplam = 0;

      siparisSekmeleriCiz();
      siparisleriYukle();
    });
  }

  /* --- Sipariş durum süzgeci --- */
  $('#siparisSuzgecler').addEventListener('click', function (o) {
    const btn = o.target.closest('[data-suzgec]');
    if (!btn) return;
    durum.siparisSuzgec = btn.dataset.suzgec;
    siparisSuzgecleriCiz();
    siparisleriYukle();
  });

  /* --- Teslim durumu süzgeci (yerel: sunucuya yeni istek atılmaz) --- */
  const teslimSuzgecKap = $('#teslimSuzgecler');
  if (teslimSuzgecKap) {
    teslimSuzgecKap.addEventListener('click', function (o) {
      const btn = o.target.closest('[data-teslim-suzgec]');
      if (!btn) return;
      durum.teslimSuzgec = btn.dataset.teslimSuzgec;
      teslimSuzgecleriCiz();
      siparisleriCiz();
    });
  }

  /* --- Otomatik yenileme anahtarı --- */
  $('#otoYenileKutu').addEventListener('change', async function () {
    durum.ayarlar.otoYenile = !!$('#otoYenileKutu').checked;
    await ipcRenderer.invoke('ayar:yaz', { otoYenile: durum.ayarlar.otoYenile });
    otoYenileyiAyarla();
    bildir(durum.ayarlar.otoYenile
      ? 'Otomatik yenileme açıldı.\nSipariş ekranı ' + (durum.ayarlar.otoYenileSaniye || 60) + ' saniyede bir tazelenecek.'
      : 'Otomatik yenileme kapatıldı.', 'bilgi');
  });

  /* --- Sipariş listesi eylemleri --- */
  $('#siparisListesi').addEventListener('click', function (o) {
    const fisBtn = o.target.closest('[data-eylem="fis"]');
    if (fisBtn) { depoFisiAc(fisBtn.dataset.id); return; }

    const durumBtn = o.target.closest('[data-eylem="durum"]');
    if (durumBtn) { siparisDurumDegistir(durumBtn.dataset.id, durumBtn.dataset.hedef, durumBtn); return; }

    const detayBtn = o.target.closest('[data-eylem="siparis-detay"]');
    if (detayBtn) { siparisDetayiDegistir(detayBtn.dataset.id); return; }

    const bayiBtn = o.target.closest('[data-eylem="siparis-bayi"]');
    if (bayiBtn) { bayiDetayiAc(bayiBtn.dataset.id); return; }

    const revizeBtn = o.target.closest('[data-eylem="siparis-revize"]');
    if (revizeBtn) { revizeModaliAc(revizeBtn.dataset.id); return; }

    /* siparisIptalEt / siparisSil renderer-ek.js içinde tanımlıdır. */
    const iptalBtn = o.target.closest('[data-eylem="siparis-iptal"]');
    if (iptalBtn && typeof siparisIptalEt === 'function') {
      siparisIptalEt(iptalBtn.dataset.id, iptalBtn);
      return;
    }

    const silBtn = o.target.closest('[data-eylem="siparis-sil"]');
    if (silBtn && typeof siparisSil === 'function') {
      siparisSil(silBtn.dataset.id, silBtn);
      return;
    }
  });

  /* --- Sipariş revize penceresi --- */
  $('#revizeModalKapat').addEventListener('click', revizeModaliKapat);
  $('#revizeVazgec').addEventListener('click', revizeModaliKapat);
  $('#revizeOnay').addEventListener('click', function () { revizeyiOnayla($('#revizeOnay')); });

  $('#revizeModalKatman').addEventListener('mousedown', function (o) {
    if (o.target === $('#revizeModalKatman')) revizeModaliKapat();
  });

  /* Adet kutuları: yazarken ve +/- düğmeleriyle canlı toplam. */
  $('#revizeGovde').addEventListener('input', function (o) {
    if (o.target.matches('[data-revize-adet]')) revizeToplamiTazele();
  });

  $('#revizeGovde').addEventListener('click', function (o) {
    const eksi = o.target.closest('[data-revize-eksi]');
    const arti = o.target.closest('[data-revize-arti]');
    if (!eksi && !arti) return;

    const kalemId = (eksi || arti).dataset[eksi ? 'revizeEksi' : 'revizeArti'];
    const girdi = document.querySelector('[data-revize-satir="' + kalemId + '"] [data-revize-adet]');
    if (!girdi) return;

    const simdi = Math.max(0, Math.floor(Number(girdi.value) || 0));
    girdi.value = eksi ? Math.max(0, simdi - 1) : simdi + 1;

    revizeToplamiTazele();
  });

  $('#revizeModalKatman').addEventListener('keydown', function (o) {
    if (o.key === 'Escape') { revizeModaliKapat(); return; }

    /* Adet kutusunda Enter bir sonraki kutuya geçer; son kutuda onaylar.
       Depocu klavyeden hiç ayrılmadan koliyi girebilsin diye. */
    if (o.key === 'Enter' && o.target.matches('[data-revize-adet]')) {
      o.preventDefault();

      const kutular = $$('#revizeGovde [data-revize-adet]');
      const sira = kutular.indexOf(o.target);

      if (sira > -1 && sira < kutular.length - 1) {
        kutular[sira + 1].focus();
        kutular[sira + 1].select();
      } else {
        revizeyiOnayla($('#revizeOnay'));
      }
    }
  });

  /* --- Ürün listesi --- */
  $('#urunListesi').addEventListener('click', function (o) {
    const kaydetBtn = o.target.closest('[data-eylem="urun-kaydet"]');
    if (kaydetBtn) { urunKaydet(kaydetBtn.dataset.id, kaydetBtn); return; }

    const gorunurlukBtn = o.target.closest('[data-eylem="urun-gorunurluk"]');
    if (gorunurlukBtn) { urunGorunurlukDegistir(gorunurlukBtn.dataset.id, gorunurlukBtn); return; }
  });

  /* Enter'a basınca da kaydetsin */
  $('#urunListesi').addEventListener('keydown', function (o) {
    if (o.key !== 'Enter') return;
    const satir = o.target.closest('[data-urun]');
    if (!satir) return;
    const btn = satir.querySelector('[data-eylem="urun-kaydet"]');
    if (btn) { o.preventDefault(); urunKaydet(btn.dataset.id, btn); }
  });

  /* --- Ürün yayın durumu süzgeci --- */
  $('#urunDurumSuzgec').addEventListener('change', function () {
    durum.urunDurumSuzgec = $('#urunDurumSuzgec').value;
    urunleriYukle($('#urunArama').value);
  });

  /* --- Yeni ürün ekleme --- */
  $('#urunEkleBtn').addEventListener('click', function () { urunModaliAc(); });
  $('#urunEkleOnay').addEventListener('click', function () { urunEkle(); });
  $('#urunEkleVazgec').addEventListener('click', urunModaliKapat);
  $('#urunModalKapat').addEventListener('click', urunModaliKapat);

  $('#urunModalKatman').addEventListener('mousedown', function (o) {
    if (o.target === $('#urunModalKatman')) urunModaliKapat();
  });

  /* Formda Enter'a basınca ekle (açıklama kutusu hariç, orada alt satır gerekli) */
  $('#urunModalKatman').addEventListener('keydown', function (o) {
    if (o.key === 'Escape') { urunModaliKapat(); return; }
    if (o.key === 'Enter' && o.target.tagName !== 'TEXTAREA') { o.preventDefault(); urunEkle(); }
  });

  /* --- SÜRÜKLE-BIRAK GÖRSEL ALANI --- */
  const birakAlani = $('#gorselBirakAlani');
  const VURGU = ['border-marka-500', 'bg-marka-50', 'dark:bg-marka-900/30'];

  birakAlani.addEventListener('click', function () { $('#gorselDosyaSec').click(); });

  birakAlani.addEventListener('dragover', function (o) {
    o.preventDefault();
    o.dataTransfer.dropEffect = 'copy';
    birakAlani.classList.add.apply(birakAlani.classList, VURGU);
  });

  birakAlani.addEventListener('dragleave', function () {
    birakAlani.classList.remove.apply(birakAlani.classList, VURGU);
  });

  birakAlani.addEventListener('drop', function (o) {
    o.preventDefault();
    birakAlani.classList.remove.apply(birakAlani.classList, VURGU);
    const dosyalar = (o.dataTransfer && o.dataTransfer.files) || [];
    if (dosyalar.length) gorselleriYukle(dosyalar);
  });

  $('#gorselDosyaSec').addEventListener('change', function (o) {
    if (o.target.files && o.target.files.length) gorselleriYukle(o.target.files);
    o.target.value = '';   // Aynı dosya tekrar seçilebilsin
  });

  $('#gorselOnizleme').addEventListener('click', function (o) {
    const silBtn = o.target.closest('[data-gorsel-sil]');
    if (silBtn) gorselKaldir(silBtn.dataset.gorselSil);
  });

  /* Pencere dışına dosya bırakılırsa tarayıcı dosyayı açmasın */
  window.addEventListener('dragover', function (o) { o.preventDefault(); });
  window.addEventListener('drop', function (o) { o.preventDefault(); });

  /* --- Ürün arama (yazarken bekleyip arasın) --- */
  $('#urunArama').addEventListener('input', function () {
    const deger = $('#urunArama').value;
    clearTimeout(durum.urunAramaZaman);
    durum.urunAramaZaman = setTimeout(function () {
      if (durum.ayarlar.demoModu) urunleriCiz(deger); // Demo: yerelde süz
      else urunleriYukle(deger);                       // Canlı: sunucuda ara
    }, 350);
  });

  /* --- Bayi süzgeçleri ve arama --- */
  $('#uyeSuzgecler').addEventListener('click', function (o) {
    const btn = o.target.closest('[data-uye-suzgec]');
    if (!btn) return;
    durum.uyeSuzgec = btn.dataset.uyeSuzgec;
    uyeSuzgecleriCiz();
    uyeleriYukle();
  });

  $('#uyeArama').addEventListener('input', function () {
    clearTimeout(durum.uyeAramaZaman);
    durum.uyeAramaZaman = setTimeout(function () { uyeleriYukle(); }, 400);
  });

  /* --- Bayi listesi eylemleri --- */
  $('#uyeListesi').addEventListener('click', function (o) {
    const onay = o.target.closest('[data-eylem="uye-onayla"]');
    if (onay) { uyeKarar(onay.dataset.id, true); return; }

    const red = o.target.closest('[data-eylem="uye-reddet"]');
    if (red) { uyeKarar(red.dataset.id, false); return; }

    const aski = o.target.closest('[data-eylem="uye-askiya-al"]');
    if (aski) { bayiAskiyaAl(aski.dataset.id); return; }

    const detay = o.target.closest('[data-eylem="bayi-detay"]');
    if (detay) { bayiDetayiAc(detay.dataset.id); return; }

    /* --- Bayiye özel iskonto --- */
    const iskontoAnahtar = o.target.closest('[data-eylem="iskonto-anahtar"]');
    if (iskontoAnahtar) { bayiIskontoAnahtari(iskontoAnahtar.dataset.id); return; }

    const iskontoKaydet = o.target.closest('[data-eylem="iskonto-kaydet"]');
    if (iskontoKaydet) { bayiIskontoKaydet(iskontoKaydet.dataset.id, iskontoKaydet, false); return; }

    /* Oran kutusuna tıklamak bayi kartını açmasın. */
    if (o.target.closest('[data-iskonto-kutu]')) return;

    /* Kartın boş bir yerine tıklandıysa bayi kartını aç */
    if (o.target.closest('button')) return;
    const kart = o.target.closest('[data-bayi]');
    if (kart) bayiDetayiAc(kart.dataset.bayi);
  });

  /* Oran kutusunda Enter → kaydet (fare kullanmadan girip geçmek için). */
  $('#uyeListesi').addEventListener('keydown', function (o) {
    if (o.key !== 'Enter') return;

    const girdi = o.target.closest('[data-iskonto-oran]');
    if (!girdi) return;

    o.preventDefault();

    const id = girdi.dataset.iskontoOran;
    const btn = document.querySelector('[data-eylem="iskonto-kaydet"][data-id="' + id + '"]');
    bayiIskontoKaydet(id, btn, false);
  });

  /* --- Bayi kartı penceresi --- */
  $('#bayiModalKapat').addEventListener('click', bayiModaliKapat);

  $('#bayiModalKatman').addEventListener('mousedown', function (o) {
    if (o.target === $('#bayiModalKatman')) bayiModaliKapat();
  });

  $('#bayiModalKatman').addEventListener('keydown', function (o) {
    if (o.key === 'Escape') bayiModaliKapat();
  });

  $('#bayiModalGovde').addEventListener('click', function (o) {
    const fisBtn = o.target.closest('[data-eylem="bayi-fis"]');
    if (fisBtn) depoFisiAc(fisBtn.dataset.id);
  });

  $('#bayiModalAyak').addEventListener('click', async function (o) {
    const kapatBtn = o.target.closest('[data-eylem="bayi-modal-kapat"]');
    if (kapatBtn) { bayiModaliKapat(); return; }

    const onayBtn = o.target.closest('[data-eylem="bayi-modal-onayla"]');
    if (onayBtn) {
      bayiModaliKapat();
      await uyeKarar(onayBtn.dataset.id, true);
      return;
    }

    const redBtn = o.target.closest('[data-eylem="bayi-modal-reddet"]');
    if (redBtn) {
      bayiModaliKapat();
      await uyeKarar(redBtn.dataset.id, false);
    }
  });

  /* --- Ayarlar --- */
  $('#modToggle').addEventListener('click', function () { moduDegistir(); });
  $('#ayarKaydetBtn').addEventListener('click', function () { ayarlariKaydet(false); });
  $('#baglantiTestBtn').addEventListener('click', function () { baglantiTestEt(); });

  $('#csGosterBtn').addEventListener('click', function () {
    const kutu = $('#girdiCs');
    kutu.type = kutu.type === 'password' ? 'text' : 'password';
    $('#csGosterBtn').innerHTML = ikon(kutu.type === 'password' ? 'goz' : 'gozKapali');
  });

  /* --- Bağlantı kilidi --- */
  $('#apiKilitAcBtn').addEventListener('click', async function () {
    const eminMi = await onayla(
      'Bağlantı Kilidini Aç',
      'Site adresi ve API anahtarları tekrar düzenlenebilir hale gelecek.\n\n' +
      'Bu alanları yalnızca gerçekten değiştirmeniz gerekiyorsa açın; ' +
      'doğrulanmış bir bağlantının yanlışlıkla bozulması sitenizle iletişimi keser.',
      'EVET, KİLİDİ AÇ',
      true
    );
    if (!eminMi) return;

    durum.ayarlar.apiKilitli = false;
    await ipcRenderer.invoke('ayar:yaz', { apiKilitli: false });
    apiKilidiniUygula();
    bildir('Kilidi açıldı. Bağlantı bilgilerini düzenleyebilirsiniz.', 'bilgi');
  });

  /* Firma adı yazılırken üst çubuk anında güncellensin */
  $('#girdiFirmaAdi').addEventListener('input', function () {
    $('#firmaAdiBaslik').textContent = $('#girdiFirmaAdi').value || 'Firma Adı Girilmedi';
  });

  /* --- Marka görselleri (Web Vitrini sekmesinde) --- */
  $('#logoYukleBtn').addEventListener('click', function () { $('#logoDosyaSec').click(); });
  $('#logoDosyaSec').addEventListener('change', function (o) {
    const dosya = o.target.files && o.target.files[0];
    yerelLogoYukle(dosya);
    o.target.value = '';
  });
  $('#logoKaldirBtn').addEventListener('click', function () { yerelLogoKaldir(); });

  $('#faviconYukleBtn').addEventListener('click', function () { $('#faviconDosyaSec').click(); });
  $('#faviconDosyaSec').addEventListener('change', function (o) {
    const dosya = o.target.files && o.target.files[0];
    faviconYukle(dosya);
    o.target.value = '';
  });
  $('#faviconKaldirBtn').addEventListener('click', function () { faviconKaldir(); });

  /* --- Geliştirici kilidi --- */
  $('#ayarKilitAcModalBtn').addEventListener('click', function () { masterKilidiSor(); });

  $('#kilitSifreGosterBtn').addEventListener('click', function () {
    const kutu = $('#kilitSifre');
    kutu.type = kutu.type === 'password' ? 'text' : 'password';
    $('#kilitSifreGosterBtn').innerHTML = ikon(kutu.type === 'password' ? 'goz' : 'gozKapali');
    kutu.focus();
  });

  /* --- Kısayollar ---
     KOMUT TUŞU: Windows/Linux'ta Ctrl, macOS'te Cmd (metaKey). İki kol da
     kabul edilir; Windows davranışı hiç değişmez, macOS'te alışıldık
     ⌘+ / ⌘− / ⌘0 / ⌘R de çalışır. */
  document.addEventListener('keydown', function (o) {
    const komutTusu = o.ctrlKey || o.metaKey;

    /* Görünüm ölçeği: Ctrl/⌘+ büyüt · Ctrl/⌘− küçült · Ctrl/⌘0 varsayılan */
    if (komutTusu && (o.key === '+' || o.key === '=')) { o.preventDefault(); olcegiKaydir(1); return; }
    if (komutTusu && (o.key === '-' || o.key === '_')) { o.preventDefault(); olcegiKaydir(-1); return; }
    if (komutTusu && o.key === '0') { o.preventDefault(); olcegiDegistir(100, false); return; }

    if (komutTusu && o.key.toLowerCase() === 'r') { // Yenile
      o.preventDefault();
      if (durum.aktifSekme === 'siparisler') siparisleriYukle();
      if (durum.aktifSekme === 'urunler') urunleriYukle($('#urunArama').value);
      if (durum.aktifSekme === 'uyeler') uyeleriYukle();
    }
    /* Alt+1…5 sol menüdeki İLK BEŞ sekmeye gider. Ayarlar sekmesi bilerek
       kısayolsuzdur: geliştirici kilidinin arkasındadır ve yanlışlıkla
       tetiklenmesi her seferinde şifre penceresi açardı. */
    if (o.key >= '1' && o.key <= '6' && o.altKey) {
      const sekmeler = ['siparisler', 'urunler', 'uyeler', 'iskonto', 'vitrin', 'vitrin-editor'];
      sekmeAc(sekmeler[Number(o.key) - 1]);
    }
  });
}

async function baslat() {
  durum.ayarlar = await ipcRenderer.invoke('ayar:oku');
  durum.bilgi = await ipcRenderer.invoke('uygulama:bilgi');
  durum.bayiSiparisleri = [];

  surumleriYaz();

  temayiUygula();
  olcekArayuzunuTazele();   // Kayıtlı ölçek zaten uygulandı; burada sadece arayüz işaretlenir
  ustCubuguTazele();
  masterKilidiUygula();     // Ayarlar sekmesi kilitli başlar (bkz. GELİŞTİRİCİ KİLİDİ)
  ayarFormunuDoldur();
  faviconOnizlemeGuncelle();
  siparisSekmeleriCiz();
  siparisSuzgecleriCiz();
  teslimSuzgecleriCiz();
  uyeSuzgecleriCiz();
  olaylariBagla();

  // Canlı moddaysak önce sitede B2B Core var mı diye bakalım
  if (!durum.ayarlar.demoModu && durum.ayarlar.wooUrl && durum.ayarlar.ck && durum.ayarlar.cs) {
    await eklentiyiTani();
    durum.eklentiTanindi = true;
    siparisSuzgecleriCiz();
  } else if (durum.ayarlar.demoModu) {
    durum.b2bVar = true;
    durum.eklentiTanindi = true;
  }

  sekmeAc('siparisler');

  // Menüdeki kırmızı bildirim sayacı için bekleyen bayi sayısını çek
  bekleyenSayisiniTazele();

  otoYenileyiAyarla();

  if (durum.ayarlar.demoModu) {
    setTimeout(function () {
      bildir('DEMO MODU açık.\nGördüğünüz veriler örnektir, sitenizde değişiklik yapılmaz.\n' +
             'Gerçek verileriniz için Ayarlar sekmesini kullanın.', 'uyari');
    }, 900);
  }
}

/* ---- OTOMATİK GÜNCELLEME BİLDİRİMLERİ ----
   Ana süreçteki electron-updater akışı (main.js > bölüm 3.5) durum gönderir.
   Kullanıcıya yalnızca kısa bir bildirim düşer; indirme ve kurulum arka
   planda ilerler, çalışma akışı kesilmez. */
ipcRenderer.on('guncelleme:durum', function (olay, veri) {
  if (!veri || !veri.mesaj) return;
  bildir(veri.mesaj, veri.durum === 'indirildi' ? 'basari' : 'bilgi');
});

document.addEventListener('DOMContentLoaded', baslat);
