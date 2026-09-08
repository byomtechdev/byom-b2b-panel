/* ============================================================================
 *  B2B YÖNETİM PANELİ  —  EK MODÜL (renderer-ek.js)
 *  ---------------------------------------------------------------------------
 *  Bu dosya index.html içinde renderer.js'ten SONRA yüklenir ve şu yeni
 *  özelliklerin masaüstü tarafını ekler:
 *
 *    A) İskonto Oranları sekmesi   → GET/POST  wc-b2b/v1/settings/discounts
 *    B) Sipariş kartı ödeme rozeti → siparisOdemeRozetiHtml(s)
 *    C) Ürün düzenle penceresi     → PUT wc/v3/products/{id} (yedek: wc-b2b/v1)
 *    D) ⋮⋮ Sürükle-bırak sıralama     → POST wc-b2b/v1/products/reorder
 *                                       (yalnızca yeri değişen ürünler gönderilir)
 *    E) Ürün silme                 → DELETE wc/v3/products/{id}?force=true
 *    F) Sipariş iptali             → POST wc-b2b/v1/orders/{id}/status
 *                                       (yedek: PUT wc/v3/orders/{id})
 *
 *  renderer.js içindeki üst seviye yardımcılar (durum, $, kacis, para, sayiCoz,
 *  fiyatYazi, bildir, onayla, bekle, butonuMesgulEt, api/b2b/woo, urunleriCiz,
 *  urunleriYukle, yeniUrunuVurgula, DEMO_URUNLER, DEMO_KATEGORILER, YEDEK_GORSEL,
 *  svgGorsel, dosyayiVeriAdresineCevir …) burada YENİDEN TANIMLANMAZ, kullanılır.
 * ==========================================================================*/

/* ==========================================================================
 *  BÖLÜM 0 — ORTAK YARDIMCILAR (yalnızca bu dosyaya ait)
 * ========================================================================*/

/** renderer.js'teki `durum` nesnesine güvenli erişim. */
function ekDurum() {
  try {
    return (typeof durum !== 'undefined' && durum) ? durum : null;
  } catch (e) {
    return null;
  }
}

/** Demo modu açık mı? (durum.ayarlar henüz yüklenmemiş olabilir) */
function ekDemoMu() {
  const d = ekDurum();
  return !!(d && d.ayarlar && d.ayarlar.demoModu);
}

/** Sitede b2b-core eklentisi bulundu mu? */
function ekEklentiVarMi() {
  const d = ekDurum();
  return !!(d && d.b2bVar);
}

/** Olay hedefinden en yakın atayı bulur (metin düğümlerine karşı korumalı). */
function ekEnYakin(hedef, secici) {
  if (!hedef) return null;
  const el = (hedef.nodeType === 1) ? hedef : hedef.parentElement;
  return (el && el.closest) ? el.closest(secici) : null;
}

/** Ürün arama kutusundaki metin (kutu yoksa boş dize). */
function ekAramaMetni() {
  const alan = $('#urunArama');
  return alan ? alan.value : '';
}

/** Eklenti bulunamadığında gösterilecek ortak metin. */
const EK_EKLENTI_YOK_MESAJI =
  'B2B Core eklentisi sitenizde bulunamadı.\n' +
  'Bu özellik için eklentinin kurulu ve etkin olması gerekir.';

/** API yanıtından kullanıcıya gösterilecek hata metnini üretir. */
function ekHataMetni(cevap) {
  if (!cevap) return 'Sunucudan yanıt alınamadı.';
  if (cevap.eklentiYok) return EK_EKLENTI_YOK_MESAJI;
  return String(cevap.hata || 'Bilinmeyen bir hata oluştu.');
}

/** Yüzdeyi Türkçe yazıma çevirir: 12 → "12", 12.5 → "12,5" */
function iskontoYazi(deger) {
  const n = Number(deger);
  if (!isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

/* Bu modülün `durum` nesnesine eklediği alanları hemen tanımla.
   (Fonksiyon bildirimleri yukarı taşındığı için dosya sonundaki tanım geçerlidir.) */
ekDurumBaslangici();

/** Bir öğenin durum.urunler içindeki sırası. */
function ekUrunIndeksi(liste, id) {
  const dizi = liste || [];
  for (let i = 0; i < dizi.length; i++) {
    if (String(dizi[i].id) === String(id)) return i;
  }
  return -1;
}

/* ==========================================================================
 *  BÖLÜM A — ROL BAZLI ÖDEME MATRİSİ (İSKONTO / FİYAT AYARLARI)
 *  ---------------------------------------------------------------------------
 *  Eskiden tek bir oran listesi vardı (Nakit / Kredi Kartı / Vadeli) ve bu
 *  oranlar SİTEDEKİ HERKESE aynı şekilde uygulanıyordu. Oysa aynı mağaza hem
 *  son kullanıcıya hem bayiye satış yapıyor: bayiye vadeli açılırken bireysel
 *  müşteriye açılmaması, kartta bayiye %8 verilirken bireysele hiç
 *  verilmemesi olağan durumlar.
 *
 *  Bu yüzden ayar artık İKİ BOYUTLUDUR:
 *
 *      rol (individual | corporate)  ×  yöntem (cash | card | term)
 *
 *  ve her hücrede iki bilgi tutulur:
 *
 *      enabled  → yöntem o role sitede GÖSTERİLSİN Mİ?
 *      discount → gösteriliyorsa sepete uygulanacak iskonto yüzdesi
 *
 *  "enabled=false" ile "discount=0" AYNI ŞEY DEĞİLDİR: ilki yöntemi ödeme
 *  ekranından tamamen kaldırır, ikincisi yöntemi açık bırakır ama indirim
 *  vermez (vadeli satışın olağan hâli).
 *
 *  --- SAKLAMA ---
 *  Matris, sunucudaki theme-config.json içine `payment_matrix` anahtarıyla
 *  yazılır (GET/POST /wp-json/wc-b2b/v1/theme-config). theme-config rastgele
 *  anahtar kabul eder (B2B_Config::save → deep_merge), bu yüzden eklentiye
 *  yeni bir uç eklemek gerekmez — vitrin verisi de aynı yoldan gidiyor.
 *
 *  --- ESKİ SÜRÜMLERLE UYUM ---
 *  Site tarafındaki eski kod hâlâ /settings/discounts ucundaki DÜZ oranlara
 *  bakıyor olabilir. Bu yüzden kayıt sırasında KURUMSAL satırın oranları o
 *  uca da yazılır. Sıralama bilinçli: önce matris (asıl kayıt), sonra eski
 *  uç (yansıma). Eski uç hata verirse matris yine de kaydedilmiş olur ve
 *  kullanıcı uyarılır — sessizce yutulmaz.
 * ========================================================================*/

/** Alıcı rolleri — anahtarlar SABİT: individual / corporate. */
const MATRIS_ROLLERI = [
  {
    kod: 'individual', ad: 'Bireysel Müşteriler', simge: ikon('kisi'), renk: 'sky',
    aciklama: 'Sitenizden alışveriş yapan son kullanıcılar (WooCommerce "customer" rolü).'
  },
  {
    kod: 'corporate', ad: 'Kurumsal Bayiler', simge: ikon('bina'), renk: 'emerald',
    aciklama: 'Onaylanmış toptan bayiler (b2b_customer rolü).'
  }
];

/** Ödeme yöntemleri — anahtarlar SABİT: cash / card / term. */
const ODEME_YONTEMLERI = [
  { kod: 'cash', ad: 'Nakit', simge: ikon('nakit'), renk: 'emerald',
    aciklama: 'Nakit veya havale/EFT ile peşin ödenen siparişler.' },
  { kod: 'card', ad: 'Kredi Kartı', simge: ikon('kart'), renk: 'sky',
    aciklama: 'Sanal POS üzerinden kredi kartı ile tahsil edilen siparişler.' },
  { kod: 'term', ad: 'Vadeli', simge: ikon('takvim'), renk: 'amber',
    aciklama: 'Cari hesaba vadeli işlenen siparişler. Genellikle %0 bırakılır.' }
];

/* Sipariş kartı rozetleri ve önizleme metinleri eskiden bu listeden
   besleniyordu; adı korunuyor ki dışarıdaki çağrılar kırılmasın. */
const ISKONTO_TIPLERI = ODEME_YONTEMLERI;

/** Önizlemede kullanılan örnek sepet tutarı. */
const ISKONTO_ORNEK_SEPET = 1000;

/** Durum kutusu renkleri. */
const ISKONTO_KUTU_SINIFLARI = {
  bilgi: 'bg-slate-50 text-slate-700 border-slate-300 ' +
         'dark:bg-slate-900/40 dark:text-slate-200 dark:border-slate-700',
  basari: 'bg-emerald-50 text-emerald-800 border-emerald-300 ' +
          'dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30',
  uyari: 'bg-amber-50 text-amber-800 border-amber-300 ' +
         'dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30',
  hata: 'bg-red-50 text-red-800 border-red-300 ' +
        'dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30'
};

/** Rol kartının kenarlık / başlık renkleri. */
const MATRIS_RENKLERI = {
  sky: {
    kenar: 'border-sky-300 dark:border-sky-500/40',
    baslik: 'text-sky-800 dark:text-sky-300',
    zemin: 'bg-sky-50/60 dark:bg-sky-500/5'
  },
  emerald: {
    kenar: 'border-emerald-300 dark:border-emerald-500/40',
    baslik: 'text-emerald-800 dark:text-emerald-300',
    zemin: 'bg-emerald-50/60 dark:bg-emerald-500/5'
  }
};

/** Önizleme tablosundaki oran sütunu için renk sınıfı. */
function iskontoRenkSinifi(renk) {
  const harita = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    sky: 'text-sky-600 dark:text-sky-400',
    amber: 'text-amber-600 dark:text-amber-400'
  };
  return harita[renk] || 'text-slate-600 dark:text-slate-300';
}

/** Durum kutusunun ikonu TÜRDEN gelir; metnin içine gömülmez. */
const ISKONTO_KUTU_IKONLARI = {
  bilgi: 'bilgi',
  basari: 'onay',
  uyari: 'uyari',
  hata: 'yasak'
};

/**
 * Metne kazara karışmış işaretlemeyi söker.
 *
 * Durum kutusuna gelen metinler `kacis` ile kaçırılır; içlerinde `ikon()`
 * çıktısı gibi bir işaretleme kalırsa ekrana ham `<svg class="ik">…` yazısı
 * olarak basılırdı ("Sitede henüz rol bazlı matris yok" kutusunda görüldüğü
 * gibi). İkonlar artık yalnızca HTML üreten yerlerde doğar; buraya gelen her
 * şey düz metne indirgenir.
 */
function duzMetin(deger) {
  return String(deger === null || deger === undefined ? '' : deger).replace(/<[^>]*>/g, '');
}

/** #iskontoDurum kutusuna ikonlu, renkli bir bilgilendirme kutusu yazar. */
function iskontoDurumYaz(tur, baslik, mesaj) {
  const kutu = $('#iskontoDurum');
  if (!kutu) return;

  if (!baslik && !mesaj) { kutu.innerHTML = ''; return; }

  const bas = duzMetin(baslik);
  const met = duzMetin(mesaj);

  kutu.innerHTML =
    '<div class="flex items-start gap-3 rounded-2xl border-2 px-5 py-4 ' +
         (ISKONTO_KUTU_SINIFLARI[tur] || ISKONTO_KUTU_SINIFLARI.bilgi) + '">' +
      '<span class="shrink-0 mt-0.5">' +
        ikon(ISKONTO_KUTU_IKONLARI[tur] || ISKONTO_KUTU_IKONLARI.bilgi, 'ik-lg') + '</span>' +
      '<div class="min-w-0">' +
        '<div class="text-xl font-black">' + kacis(bas) + '</div>' +
        (met
          ? '<div class="mt-1 text-lg font-semibold whitespace-pre-line leading-relaxed">' + kacis(met) + '</div>'
          : '') +
      '</div>' +
    '</div>';
}

/* --------------------------------------------------------------------------
 *  MATRİS VERİSİ
 * ------------------------------------------------------------------------*/

/**
 * Fabrika ayarı.
 *
 * Bireysel müşteride vadeli KAPALI gelir: açık hesap, tanınan ve cari kaydı
 * olan bayiler içindir; son kullanıcıya vadeli açmak varsayılan olmamalıdır.
 */
function varsayilanMatris() {
  return {
    individual: {
      cash: { enabled: true,  discount: 0 },
      card: { enabled: true,  discount: 0 },
      term: { enabled: false, discount: 0 }
    },
    corporate: {
      cash: { enabled: true,  discount: 12 },
      card: { enabled: true,  discount: 8 },
      term: { enabled: true,  discount: 0 }
    }
  };
}

/** Bir hücreyi okunur hâle getirir; alan adları sunucu sürümüne göre değişebilir. */
function matrisHucresiCoz(ham, varsayilan) {
  const v = varsayilan || { enabled: true, discount: 0 };

  /* Eski biçim: hücre yerine düz sayı (yalnızca oran) yazılmış olabilir. */
  if (typeof ham === 'number' || typeof ham === 'string') {
    const sayi = Number(String(ham).replace(',', '.'));
    return {
      enabled: v.enabled,
      discount: (isFinite(sayi) && sayi >= 0 && sayi <= 100) ? sayi : v.discount
    };
  }

  if (!ham || typeof ham !== 'object') return { enabled: v.enabled, discount: v.discount };

  const acikHam = (ham.enabled !== undefined) ? ham.enabled
                : (ham.active !== undefined) ? ham.active
                : (ham.aktif !== undefined) ? ham.aktif
                : v.enabled;

  const oranHam = (ham.discount !== undefined) ? ham.discount
                : (ham.rate !== undefined) ? ham.rate
                : (ham.oran !== undefined) ? ham.oran
                : v.discount;

  const oran = Number(String(oranHam === null || oranHam === undefined ? 0 : oranHam).replace(',', '.'));

  return {
    enabled: !(acikHam === false || acikHam === 0 || acikHam === '0' ||
               acikHam === 'no' || acikHam === 'false'),
    discount: (isFinite(oran) && oran >= 0 && oran <= 100) ? Math.round(oran * 100) / 100 : 0
  };
}

/** Sunucudan gelen ham matrisi tam ve güvenli bir yapıya çevirir. */
function matrisNormalle(ham) {
  const kaynak = ham && typeof ham === 'object' ? ham : {};
  const varsayilanlar = varsayilanMatris();
  const sonuc = {};

  MATRIS_ROLLERI.forEach(function (rol) {
    /* Rol adı sunucuda "bireysel" / "dealer" gibi de yazılmış olabilir. */
    const rolHam = kaynak[rol.kod] ||
                   (rol.kod === 'individual' ? (kaynak.bireysel || kaynak.customer || kaynak.b2c) : null) ||
                   (rol.kod === 'corporate' ? (kaynak.kurumsal || kaynak.dealer || kaynak.b2b) : null) ||
                   {};

    sonuc[rol.kod] = {};
    ODEME_YONTEMLERI.forEach(function (yon) {
      sonuc[rol.kod][yon.kod] = matrisHucresiCoz(rolHam[yon.kod], varsayilanlar[rol.kod][yon.kod]);
    });
  });

  return sonuc;
}

/**
 * Eski /settings/discounts oranlarını matrise çevirir.
 *
 * Eski oranlar YALNIZCA bayilere uygulanıyordu (o dönem panelde bireysel
 * müşteri kavramı yoktu), bu yüzden kurumsal satıra taşınır. Bireysel satır
 * fabrika ayarında bırakılır — eski oranı oraya da kopyalamak, mağazanın hiç
 * vermediği bir indirimi son kullanıcıya açardı.
 */
function eskiOranlariMatriseCevir(oranlar) {
  const matris = varsayilanMatris();
  const kaynak = oranlar || {};

  ODEME_YONTEMLERI.forEach(function (yon) {
    const sayi = Number(kaynak[yon.kod]);
    if (isFinite(sayi) && sayi >= 0 && sayi <= 100) {
      matris.corporate[yon.kod].discount = Math.round(sayi * 100) / 100;
    }
  });

  return matris;
}

/* --------------------------------------------------------------------------
 *  MATRİS TABLOSU (ARAYÜZ)
 * ------------------------------------------------------------------------*/

/** Tek bir hücrenin satır HTML'i: [anahtar] [yöntem adı] [% kutusu] */
function matrisSatiriHtml(rol, yon, hucre) {
  const anahtar = rol.kod + '|' + yon.kod;
  const acik = !!hucre.enabled;

  return '' +
  '<div data-matris-satir="' + kacis(anahtar) + '" ' +
       'class="rounded-2xl border-2 p-4 flex flex-wrap items-center gap-4 transition ' +
       (acik
         ? 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900/40'
         : 'border-dashed border-slate-300 bg-slate-100/70 dark:border-slate-700 dark:bg-slate-900/70') + '">' +

    /* --- Açık / Kapalı anahtarı --- */
    '<button type="button" role="switch" data-matris-anahtar="' + kacis(anahtar) + '" ' +
            'aria-checked="' + (acik ? 'true' : 'false') + '" ' +
            'title="' + kacis(yon.ad + ' yöntemini "' + rol.ad + '" için aç / kapat') + '" ' +
            'class="relative w-20 h-11 rounded-full shrink-0 transition-colors focus:outline-none ' +
                   'focus:ring-4 focus:ring-emerald-500/30 ' +
                   (acik ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600') + '">' +
      '<span class="absolute top-1 left-1 w-9 h-9 rounded-full bg-white shadow-lg transition-transform duration-200 ' +
            (acik ? 'translate-x-9' : '') + '"></span>' +
    '</button>' +

    '<div class="min-w-0 flex-1">' +
      '<div class="text-lg font-extrabold ' + (acik ? '' : 'opacity-60') + '">' +
        yon.simge + ' ' + kacis(yon.ad) + '</div>' +
      '<div class="text-base font-semibold ' +
           (acik ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400') + '">' +
        (acik ? 'Açık — sitede seçilebilir' : 'Kapalı — sitede hiç görünmez') +
      '</div>' +
    '</div>' +

    /* --- İskonto oranı --- */
    '<label class="flex items-center gap-2 text-lg font-extrabold shrink-0 ' +
           (acik ? '' : 'opacity-50') + '">' +
      '<span>İskonto</span>' +
      '<span class="relative">' +
        '<input data-matris-oran="' + kacis(anahtar) + '" type="text" inputmode="decimal" ' +
               (acik ? '' : 'disabled ') +
               'value="' + kacis(iskontoYazi(hucre.discount)) + '" ' +
               'class="w-28 h-12 pl-4 pr-8 rounded-xl text-xl font-black text-right ' +
                      'bg-white dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-600 ' +
                      'focus:border-marka-600 focus:ring-4 focus:ring-marka-600/20 outline-none transition ' +
                      'disabled:cursor-not-allowed" />' +
        '<span class="absolute right-3 top-1/2 -translate-y-1/2 text-lg font-black text-slate-400 ' +
              'pointer-events-none">%</span>' +
      '</span>' +
    '</label>' +
  '</div>';
}

/** Bir rolün tablosunu ilgili kaba çizer. */
function matrisTablosuCiz(rol) {
  const kap = $(rol.kod === 'individual' ? '#matrisBireysel' : '#matrisKurumsal');
  if (!kap) return;

  const d = ekDurum();
  const matris = (d && d.odemeMatrisi) || varsayilanMatris();
  const renk = MATRIS_RENKLERI[rol.renk] || MATRIS_RENKLERI.sky;

  const acikSayisi = ODEME_YONTEMLERI.filter(function (yon) {
    return matris[rol.kod][yon.kod].enabled;
  }).length;

  kap.innerHTML = '' +
  '<div class="h-full rounded-2xl border-2 ' + renk.kenar + ' ' + renk.zemin + ' p-6 flex flex-col gap-4">' +
    '<div>' +
      '<div class="text-2xl font-black ' + renk.baslik + '">' +
        rol.simge + ' ' + kacis(rol.ad) + '</div>' +
      '<div class="text-base font-semibold text-slate-600 dark:text-slate-300 mt-1">' +
        kacis(rol.aciklama) + '</div>' +
    '</div>' +

    ODEME_YONTEMLERI.map(function (yon) {
      return matrisSatiriHtml(rol, yon, matris[rol.kod][yon.kod]);
    }).join('') +

    /* Hiçbir yöntem açık değilse bu rol sipariş VEREMEZ — sessizce geçilmez. */
    (acikSayisi === 0
      ? '<div class="rounded-xl border-2 border-red-300 dark:border-red-500/40 ' +
             'bg-red-50 dark:bg-red-500/10 p-4 text-lg font-bold ' +
             'text-red-800 dark:text-red-200">' +
          ikon('uyari') + ' Bu rol için hiçbir ödeme yöntemi açık değil — bu grup sitenizden ' +
          'sipariş tamamlayamaz.' +
        '</div>'
      : '') +
  '</div>';
}

/** İki tabloyu da çizer ve önizlemeyi tazeler. */
function matrisiCiz() {
  MATRIS_ROLLERI.forEach(matrisTablosuCiz);
  iskontoOnizlemeCiz();
}

/** Matrisi belleğe yazıp arayüzü yeniler. */
function iskontoFormunuDoldur(matris) {
  const d = ekDurum();
  if (!d) return;

  d.odemeMatrisi = matrisNormalle(matris || d.odemeMatrisi);
  matrisiCiz();
}

/**
 * Ekrandaki kutuları okur.
 * @returns {{matris: object, gecerliMi: boolean, hataliAnahtar: string}}
 */
function matrisFormunuOku() {
  const d = ekDurum();
  const mevcut = (d && d.odemeMatrisi) || varsayilanMatris();
  const sonuc = { matris: {}, gecerliMi: true, hataliAnahtar: '' };

  MATRIS_ROLLERI.forEach(function (rol) {
    sonuc.matris[rol.kod] = {};

    ODEME_YONTEMLERI.forEach(function (yon) {
      const anahtar = rol.kod + '|' + yon.kod;
      const acik = !!mevcut[rol.kod][yon.kod].enabled;
      const alan = document.querySelector('[data-matris-oran="' + anahtar + '"]');
      const ham = alan ? sayiCoz(alan.value) : Number(mevcut[rol.kod][yon.kod].discount);

      /* Kapalı yöntemin oranı doğrulanmaz: kutu devre dışıdır ve o oran
         sitede hiç kullanılmayacaktır. Kapalı bir satırdaki eski/bozuk değer
         yüzünden kaydı engellemek kullanıcıyı çıkışsız bırakırdı. */
      if (!acik) {
        const eski = Number(mevcut[rol.kod][yon.kod].discount);
        sonuc.matris[rol.kod][yon.kod] = {
          enabled: false,
          discount: (isFinite(eski) && eski >= 0 && eski <= 100) ? eski : 0
        };
        return;
      }

      if (isNaN(ham) || !isFinite(ham) || ham < 0 || ham > 100) {
        if (sonuc.gecerliMi) { sonuc.gecerliMi = false; sonuc.hataliAnahtar = anahtar; }
        sonuc.matris[rol.kod][yon.kod] = { enabled: true, discount: 0 };
        return;
      }

      sonuc.matris[rol.kod][yon.kod] = { enabled: true, discount: Math.round(ham * 100) / 100 };
    });
  });

  return sonuc;
}

/* Eski ad — dışarıdan çağıran olursa kırılmasın (kurumsal satırı döndürür). */
function iskontoFormunuOku() {
  const okunan = matrisFormunuOku();
  const kurumsal = okunan.matris.corporate;
  return {
    cash: kurumsal.cash.discount,
    card: kurumsal.card.discount,
    term: kurumsal.term.discount,
    gecerliMi: okunan.gecerliMi,
    hataliTip: null
  };
}

/**
 * Matrisin okunabilir özeti (bildirimlerde, onay penceresinde ve durum
 * kutusunda kullanılır).
 *
 * Çıktı DÜZ METİNDİR: `rol.simge` / `yon.simge` birer SVG dizesidir ve bu
 * özet kaçırılarak basıldığı için ekrana ham `<svg class="ik">…` etiketi
 * olarak sızıyordu. İkonlar yalnızca HTML üreten yerlerde kullanılır.
 */
function matrisOzeti(matris) {
  return MATRIS_ROLLERI.map(function (rol) {
    const satir = ODEME_YONTEMLERI.map(function (yon) {
      const h = matris[rol.kod][yon.kod];
      return yon.ad + ': ' + (h.enabled ? '%' + iskontoYazi(h.discount) : 'kapalı');
    }).join('  ·  ');
    return rol.ad + '\n   ' + satir;
  }).join('\n');
}

/** 1.000 TL örnek sepet üzerinden iki rolü yan yana gösteren önizleme. */
function iskontoOnizlemeCiz() {
  const kap = $('#iskontoOnizleme');
  if (!kap) return;

  const okunan = matrisFormunuOku();
  const matris = okunan.matris;

  const satirlar = ODEME_YONTEMLERI.map(function (yon) {
    const hucre = function (rolKod) {
      const h = matris[rolKod][yon.kod];
      if (!h.enabled) {
        return '<td class="py-3 pr-4 text-right text-lg font-bold whitespace-nowrap ' +
               'text-slate-400 dark:text-slate-500">— kapalı —</td>';
      }
      const odenecek = ISKONTO_ORNEK_SEPET - ISKONTO_ORNEK_SEPET * (h.discount / 100);
      return '<td class="py-3 pr-4 text-right whitespace-nowrap">' +
        '<div class="text-lg font-black ' + iskontoRenkSinifi(yon.renk) + '">%' +
          kacis(iskontoYazi(h.discount)) + '</div>' +
        '<div class="text-base font-bold">' + kacis(para(odenecek)) + '</div>' +
      '</td>';
    };

    return '' +
    '<tr class="border-b border-slate-200 dark:border-slate-700">' +
      '<td class="py-3 pr-4 text-lg font-extrabold whitespace-nowrap">' +
        yon.simge + ' ' + kacis(yon.ad) + '</td>' +
      hucre('individual') +
      hucre('corporate') +
    '</tr>';
  }).join('');

  kap.innerHTML = '' +
  '<div class="h-full rounded-2xl border-2 border-slate-200 dark:border-slate-700 ' +
       'bg-white dark:bg-slate-800 p-5">' +
    '<div class="text-lg font-black mb-1">' + ikon('grafik') + ' Örnek Hesap</div>' +
    '<div class="text-base font-semibold text-slate-500 dark:text-slate-400 mb-3">' +
      'Sepet tutarı ' + kacis(para(ISKONTO_ORNEK_SEPET)) + ' olsaydı, ödenecek tutar:' +
    '</div>' +
    '<div class="overflow-x-auto">' +
      '<table class="w-full text-left border-collapse">' +
        '<thead>' +
          '<tr class="border-b-2 border-slate-300 dark:border-slate-600 ' +
              'text-base font-black text-slate-500 dark:text-slate-400">' +
            '<th class="py-2 pr-4">ÖDEME YÖNTEMİ</th>' +
            '<th class="py-2 pr-4 text-right">' + ikon('kisi', 'ik-sm') + ' BİREYSEL</th>' +
            '<th class="py-2 pr-4 text-right">' + ikon('bina', 'ik-sm') + ' BAYİ</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + satirlar + '</tbody>' +
      '</table>' +
    '</div>' +
    (okunan.gecerliMi
      ? ''
      : '<div class="mt-3 text-base font-bold text-red-600 dark:text-red-400">' +
        ikon('uyari') + ' Bir orana geçersiz değer yazıldı; 0 ile 100 arasında bir sayı olmalı.</div>') +
  '</div>';
}

/** Bir hücrenin açık/kapalı durumunu değiştirir (siteye kayıt YAPMAZ). */
function matrisAnahtariniDegistir(anahtar) {
  const d = ekDurum();
  if (!d || !d.odemeMatrisi) return;

  const parca = String(anahtar || '').split('|');
  const rolKod = parca[0];
  const yonKod = parca[1];
  if (!d.odemeMatrisi[rolKod] || !d.odemeMatrisi[rolKod][yonKod]) return;

  /* Ekrandaki oranlar önce belleğe alınır; aksi hâlde anahtarı çevirmek
     kullanıcının henüz kaydetmediği oran değişikliklerini silerdi. */
  d.odemeMatrisi = matrisFormunuOku().matris;

  d.odemeMatrisi[rolKod][yonKod].enabled = !d.odemeMatrisi[rolKod][yonKod].enabled;

  matrisiCiz();
}

/* --------------------------------------------------------------------------
 *  YÜKLEME / KAYDETME
 * ------------------------------------------------------------------------*/

/**
 * Ödeme matrisini yükler.
 * @param {boolean} zorla True ise önbelleğe bakmadan siteden yeniden çeker.
 */
async function iskontoSekmesiYukle(zorla) {
  const d = ekDurum();
  if (!d) return;

  /* Aynı anda ikinci bir istek başlamasın (sekmeAc + yenile düğmesi çakışması) */
  if (d.iskontoYukleniyor) return;

  if (d.iskontoYuklendi && !zorla) {
    matrisiCiz();
    return;
  }

  d.iskontoYukleniyor = true;
  iskontoDurumYaz('bilgi', 'Ödeme matrisi getiriliyor…', 'Lütfen bekleyin.');

  try {
    /* ---------- DEMO ---------- */
    if (ekDemoMu()) {
      await bekle(200);
      d.odemeMatrisi = matrisNormalle(d.odemeMatrisi);
      d.iskontoYuklendi = true;
      matrisiCiz();
      iskontoDurumYaz(
        'uyari',
        'Demo Modu',
        'Gördüğünüz matris örnektir. Bu ekranda yapacağınız değişiklikler\n' +
        'sitenize gönderilmez, yalnızca bu pencerede saklanır.'
      );
      return;
    }

    /* ---------- CANLI ---------- */
    if (!ekEklentiVarMi()) {
      d.odemeMatrisi = matrisNormalle(d.odemeMatrisi);
      d.iskontoYuklendi = true;
      matrisiCiz();
      iskontoDurumYaz('hata', 'B2B Core eklentisi bulunamadı', EK_EKLENTI_YOK_MESAJI);
      return;
    }

    const cevap = await b2b('theme-config', { sureAsimi: 30000 });

    if (!cevap || !cevap.ok) {
      /* Form DEVRE DIŞI BIRAKILMAZ — kullanıcı yeniden deneyebilsin. */
      d.odemeMatrisi = matrisNormalle(d.odemeMatrisi);
      matrisiCiz();
      iskontoDurumYaz(
        'hata',
        'Ödeme matrisi alınamadı',
        ekHataMetni(cevap) + '\n\nDeğerleri düzenleyip KAYDET ile yeniden deneyebilirsiniz.'
      );
      bildir('Ödeme matrisi alınamadı:\n' + ekHataMetni(cevap), 'hata');
      return;
    }

    const yapilandirma = (cevap.veri && cevap.veri.config) || {};
    const hamMatris = yapilandirma.payment_matrix || yapilandirma.paymentMatrix || null;

    if (hamMatris) {
      d.odemeMatrisi = matrisNormalle(hamMatris);
      d.iskontoYuklendi = true;
      matrisiCiz();
      iskontoDurumYaz('basari', 'Sitedeki güncel matris yüklendi', matrisOzeti(d.odemeMatrisi));
      return;
    }

    /* Sitede henüz matris yok: eski düz oranlardan başlangıç üretilir ki
       kullanıcı sıfırdan yazmak zorunda kalmasın. */
    const eski = await b2b('settings/discounts');
    const oranlar = (eski && eski.ok && eski.veri && (eski.veri.rates || eski.veri.discounts)) || null;

    d.odemeMatrisi = oranlar ? eskiOranlariMatriseCevir(oranlar) : varsayilanMatris();
    d.iskontoYuklendi = true;
    matrisiCiz();

    iskontoDurumYaz(
      'uyari',
      'Sitede henüz rol bazlı matris yok',
      (oranlar
        ? 'Mevcut iskonto oranlarınız KURUMSAL BAYİ satırına taşındı.\n'
        : 'Fabrika ayarları yüklendi.\n') +
      'Bireysel müşteri satırını gözden geçirip KAYDET deyin.\n\n' +
      matrisOzeti(d.odemeMatrisi)
    );
  } catch (e) {
    iskontoDurumYaz('hata', 'Beklenmeyen hata', String((e && e.message) || e));
    bildir('Ödeme matrisi yüklenirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    d.iskontoYukleniyor = false;
  }
}

/** Matrisi doğrular, onay alır ve siteye gönderir. */
async function iskontoKaydet() {
  const d = ekDurum();
  if (!d) return;

  const okunan = matrisFormunuOku();

  if (!okunan.gecerliMi) {
    const alan = document.querySelector('[data-matris-oran="' + okunan.hataliAnahtar + '"]');
    bildir('Geçersiz iskonto oranı.\n0 ile 100 arasında bir sayı olmalıdır.\n' +
           'Örnek: 12  ·  8,5  ·  0', 'uyari');
    if (alan) { alan.focus(); if (alan.select) alan.select(); }
    return;
  }

  const matris = okunan.matris;
  const ozet = matrisOzeti(matris);

  /* Bir rolün bütün yöntemleri kapalıysa o rol sipariş veremez; kullanıcı bunu
     bilerek yapıyor olabilir (ör. siteyi geçici olarak bayiye kapatmak) ama
     kaza eseri de olabileceği için onay metninde AÇIKÇA söylenir. */
  const kapaliRoller = MATRIS_ROLLERI.filter(function (rol) {
    return ODEME_YONTEMLERI.every(function (yon) { return !matris[rol.kod][yon.kod].enabled; });
  });

  const eminMi = await onayla(
    'Ödeme Matrisini Kaydet',
    'Yeni ayarlar:\n' + ozet + '\n\n' +
    (kapaliRoller.length
      ? 'DİKKAT: ' + kapaliRoller.map(function (r) { return r.ad; }).join(' ve ') +
        ' için hiçbir ödeme yöntemi açık değil.\nBu grup sitenizden sipariş TAMAMLAYAMAZ.\n\n'
      : '') +
    'Bu ayarlar kaydedildiği anda web sitenizde geçerli olur.' +
    (ekDemoMu() ? '\n\nDEMO MODU: sitenizde hiçbir değişiklik yapılmaz.' : ''),
    'EVET, KAYDET',
    false
  );

  if (!eminMi) return;

  const dugme = $('#iskontoKaydetBtn');
  const geriAl = dugme ? butonuMesgulEt(dugme, 'KAYDEDİLİYOR…') : function () {};

  try {
    /* ---------- DEMO ---------- */
    if (ekDemoMu()) {
      await bekle(300);
      d.odemeMatrisi = matris;
      d.iskontoYuklendi = true;
      matrisiCiz();
      iskontoDurumYaz('uyari', 'Demo Modu — kaydedildi (yalnızca bu pencerede)', ozet);
      bildir('Ödeme matrisi güncellendi.\n(Demo Modu — sitenizde değişiklik yapılmadı)', 'basari');
      return;
    }

    if (!ekEklentiVarMi()) {
      iskontoDurumYaz('hata', 'Kaydedilemedi', EK_EKLENTI_YOK_MESAJI);
      bildir(EK_EKLENTI_YOK_MESAJI, 'hata');
      return;
    }

    /* ---------- CANLI: asıl kayıt (theme-config → payment_matrix) ---------- */
    const cevap = await b2b('theme-config', {
      metod: 'POST',
      sureAsimi: 45000,
      govde: { config: { payment_matrix: matris } }
    });

    if (!cevap || !cevap.ok) {
      iskontoDurumYaz('hata', 'Kaydedilemedi', ekHataMetni(cevap));
      bildir('Ödeme matrisi kaydedilemedi:\n' + ekHataMetni(cevap), 'hata');
      return;
    }

    /* Sunucu düzeltilmiş matrisi geri döndürdüyse onu kullan. */
    const donen = (cevap.veri && cevap.veri.config &&
                   (cevap.veri.config.payment_matrix || cevap.veri.config.paymentMatrix)) || null;

    d.odemeMatrisi = donen ? matrisNormalle(donen) : matris;
    d.iskontoYuklendi = true;
    matrisiCiz();

    /* ---------- CANLI: eski uca yansıma (geriye dönük uyum) ---------- */
    const eskiCevap = await b2b('settings/discounts', {
      metod: 'POST',
      sureAsimi: 30000,
      govde: {
        cash: matris.corporate.cash.enabled ? matris.corporate.cash.discount : 0,
        card: matris.corporate.card.enabled ? matris.corporate.card.discount : 0,
        term: matris.corporate.term.enabled ? matris.corporate.term.discount : 0
      }
    });

    const yeniOzet = matrisOzeti(d.odemeMatrisi);

    if (!eskiCevap || !eskiCevap.ok) {
      iskontoDurumYaz('uyari', 'Matris kaydedildi, eski oran ucu güncellenemedi',
        yeniOzet + '\n\nEski uç hatası: ' + ekHataMetni(eskiCevap) +
        '\nSitenizin teması matrisi okuyorsa sorun yoktur.');
      bildir('Ödeme matrisi kaydedildi.\n' +
             'Eski iskonto ucu güncellenemedi; teması eski uca bakan siteler\n' +
             'değişikliği görmeyebilir.', 'uyari');
      return;
    }

    iskontoDurumYaz('basari', 'Ödeme matrisi sitenize kaydedildi', yeniOzet);
    bildir('Ödeme matrisi güncellendi.\nSitenizde anında geçerli.', 'basari');
  } catch (e) {
    iskontoDurumYaz('hata', 'Beklenmeyen hata', String((e && e.message) || e));
    bildir('Ödeme matrisi kaydedilirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    geriAl();
  }
}
/* ==========================================================================
 *  BÖLÜM B — SİPARİŞ KARTI ÖDEME ROZETİ
 * ========================================================================*/

/** Ödeme tipi → etiket / simge / renk (SÖZLEŞME §5). */
const ODEME_TIPI_BILGISI = {
  cash: {
    etiket: 'Nakit Sipariş', simge: ikon('nakit'),
    sinif: 'bg-emerald-100 text-emerald-800 border-emerald-300 ' +
           'dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
  },
  card: {
    etiket: 'Kredi Kartı Sipariş', simge: ikon('kart'),
    sinif: 'bg-sky-100 text-sky-800 border-sky-300 ' +
           'dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30'
  },
  term: {
    etiket: 'Vadeli Sipariş', simge: ikon('takvim'),
    sinif: 'bg-amber-100 text-amber-800 border-amber-300 ' +
           'dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30'
  }
};

/**
 * Sipariş kartında durum rozetinin yanına konulacak ödeme tipi rozeti.
 * Ödeme tipi yoksa boş dize döner (eski siparişler için).
 */
function siparisOdemeRozetiHtml(s) {
  if (!s) return '';

  const kod = String(s.odemeTipi || '').trim();
  if (!kod) return '';

  const bilgi = ODEME_TIPI_BILGISI[kod] || {
    etiket: '', simge: ikon('etiket'),
    sinif: 'bg-slate-200 text-slate-800 border-slate-300 ' +
           'dark:bg-slate-600/30 dark:text-slate-200 dark:border-slate-500/40'
  };

  const etiket = String(s.odemeTipiEtiket || '').trim() || bilgi.etiket || kod;

  const hamOran = Number(s.odemeIskonto || 0);
  const oran = (isFinite(hamOran) && hamOran > 0) ? hamOran : 0;

  const metin = etiket +
    (oran > 0 ? ' · %' + iskontoYazi(oran) + ' İskonto Uygulandı' : ' · İskonto Uygulanmadı');

  const hamTutar = Number(s.odemeIskontoTutar || 0);
  const baslik = (isFinite(hamTutar) && hamTutar > 0)
    ? ' title="' + kacis('İskonto tutarı: ' + para(hamTutar)) + '"'
    : '';

  return '<span' + baslik + ' class="inline-block mt-1 px-3 py-1 rounded-lg border-2 ' +
         'text-base font-bold whitespace-nowrap ' + bilgi.sinif + '">' +
         bilgi.simge + ' ' + kacis(metin) + '</span>';
}

/* ==========================================================================
 *  BÖLÜM C — ÜRÜN DÜZENLE PENCERESİ
 * ========================================================================*/

/** #duzenleUyari kutusu. */
function duzenleUyar(mesaj) {
  const kutu = $('#duzenleUyari');
  if (!kutu) return;

  if (!mesaj) { kutu.classList.add('hidden'); kutu.textContent = ''; return; }

  kutu.textContent = mesaj;
  kutu.classList.remove('hidden');
}

/** #duzenleGorselDurum kutusu. */
function duzenleGorselDurumYaz(mesaj, renkSinifi) {
  const kutu = $('#duzenleGorselDurum');
  if (!kutu) return;
  kutu.textContent = mesaj || '';
  kutu.className = 'mt-3 text-base font-bold whitespace-pre-line ' +
    (renkSinifi || 'text-slate-500 dark:text-slate-400');
}

/** Mevcut görsel + yeni yüklenen görsellerin küçük resimleri. */
function duzenleGorselKutusuCiz() {
  const kap = $('#duzenleGorselKutu');
  if (!kap) return;

  const d = ekDurum();
  const urun = d ? d.duzenlenenUrun : null;
  const yeniler = (d && d.duzenleGorselleri) ? d.duzenleGorselleri : [];

  let html = '<div class="flex flex-wrap gap-4 items-start">';

  if (urun) {
    html += '' +
    '<div class="relative w-28 h-28 rounded-2xl overflow-hidden border-2 ' +
         (yeniler.length
           ? 'border-slate-300 dark:border-slate-600 opacity-50'
           : 'border-marka-500') +
         ' bg-slate-100 dark:bg-slate-700">' +
      '<img src="' + kacis(urun.gorsel || YEDEK_GORSEL) + '" alt="" ' +
           'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" ' +
           'class="w-full h-full object-cover" />' +
      '<span class="absolute bottom-0 inset-x-0 bg-slate-800/85 text-white text-xs ' +
            'font-black text-center py-1">ŞU ANKİ</span>' +
    '</div>';
  }

  html += yeniler.map(function (g, i) {
    return '' +
    '<div class="relative w-28 h-28 rounded-2xl overflow-hidden border-2 ' +
         'border-emerald-400 dark:border-emerald-500/50 bg-slate-100 dark:bg-slate-700">' +
      '<img src="' + kacis(g.onizleme || YEDEK_GORSEL) + '" alt="" ' +
           'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" ' +
           'class="w-full h-full object-cover" />' +
      (i === 0
        ? '<span class="absolute bottom-0 inset-x-0 bg-emerald-600 text-white text-xs ' +
          'font-black text-center py-1">ÖNE ÇIKAN</span>'
        : '') +
      '<button type="button" data-duzenle-gorsel-sil="' + kacis(String(g.id)) + '" title="Kaldır" ' +
              'class="absolute top-1 right-1 w-8 h-8 rounded-lg bg-red-600 hover:bg-red-700 ' +
                     'text-white text-lg font-black grid place-items-center shadow-lg transition">' +
                     ikon('carpi', 'ik-sm') + '</button>' +
    '</div>';
  }).join('');

  html += '</div>';

  html += '<div class="mt-3 text-base font-semibold text-slate-500 dark:text-slate-400 leading-relaxed">' +
    (yeniler.length
      ? kacis('Kaydettiğinizde ürünün görselleri yukarıdaki ' + yeniler.length +
              ' yeni görselle DEĞİŞTİRİLİR. İlk görsel öne çıkan görsel olur.')
      : kacis('Yeni görsel bırakmazsanız ürünün mevcut görseli olduğu gibi kalır.')) +
    '</div>';

  kap.innerHTML = html;
}

/** Yüklenen görseli listeden çıkarır. */
function duzenleGorselKaldir(gorselId) {
  const d = ekDurum();
  if (!d) return;

  d.duzenleGorselleri = (d.duzenleGorselleri || []).filter(function (g) {
    return String(g.id) !== String(gorselId);
  });

  duzenleGorselKutusuCiz();
  duzenleGorselDurumYaz(
    d.duzenleGorselleri.length
      ? d.duzenleGorselleri.length + ' yeni görsel hazır.'
      : 'Yeni görsel seçilmedi — mevcut görsel korunacak.',
    d.duzenleGorselleri.length
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-slate-500 dark:text-slate-400'
  );
}

/**
 * Düzenleme penceresine sürükle-bırak / dosya seçimiyle gelen görselleri
 * POST /wc-b2b/v1/media ucuna yükler ve durum.duzenleGorselleri içine ekler.
 */
async function duzenleGorselleriYukle(dosyalar) {
  const d = ekDurum();
  if (!d) return;

  if (!d.duzenleGorselleri) d.duzenleGorselleri = [];

  const liste = Array.prototype.slice.call(dosyalar || []).filter(function (dosya) {
    return dosya && (GECERLI_GORSEL_TURLERI.indexOf(dosya.type) !== -1 || /^image\//.test(dosya.type || ''));
  });

  if (liste.length === 0) {
    duzenleGorselDurumYaz('Sadece görsel dosyası (JPG, PNG, WEBP, GIF) bırakabilirsiniz.',
                          'text-red-600 dark:text-red-400');
    return;
  }

  const adAlani = $('#duzenleAd');
  const urunAdi = adAlani ? adAlani.value.trim() : '';

  for (let i = 0; i < liste.length; i++) {
    const dosya = liste[i];

    if (dosya.size > EN_BUYUK_GORSEL_MB * 1024 * 1024) {
      duzenleGorselDurumYaz('"' + dosya.name + '" çok büyük (en fazla ' + EN_BUYUK_GORSEL_MB + ' MB).',
                            'text-red-600 dark:text-red-400');
      continue;
    }

    duzenleGorselDurumYaz('Yükleniyor (' + (i + 1) + '/' + liste.length + '): ' + dosya.name,
                          'text-marka-700 dark:text-marka-300');

    let veriAdresi;
    try {
      veriAdresi = await dosyayiVeriAdresineCevir(dosya);
    } catch (e) {
      duzenleGorselDurumYaz(String((e && e.message) || e), 'text-red-600 dark:text-red-400');
      continue;
    }

    /* ---------- DEMO ---------- */
    if (ekDemoMu()) {
      await bekle(320);
      d.duzenleGorselleri.push({
        id: 'demo-' + Date.now() + '-' + i,
        onizleme: veriAdresi,
        url: veriAdresi,
        demo: true
      });
      duzenleGorselKutusuCiz();
      continue;
    }

    /* ---------- CANLI ---------- */
    if (!ekEklentiVarMi()) {
      duzenleGorselDurumYaz('Dosya yükleme için sitenizde "B2B Core" eklentisi gerekir.\n' +
                            'Eklenti yokken aşağıdaki "Görsel bağlantısı (URL)" alanını kullanın.',
                            'text-red-600 dark:text-red-400');
      return;
    }

    let cevap;
    try {
      cevap = await b2b('media', {
        metod: 'POST',
        sureAsimi: 120000,
        govde: {
          filename: dosya.name,
          data: veriAdresi,
          title: urunAdi || dosya.name.replace(/\.[^.]+$/, ''),
          alt: urunAdi || ''
        }
      });
    } catch (e) {
      duzenleGorselDurumYaz('"' + dosya.name + '" yüklenemedi: ' + String((e && e.message) || e),
                            'text-red-600 dark:text-red-400');
      continue;
    }

    if (!cevap || !cevap.ok || !cevap.veri) {
      duzenleGorselDurumYaz('"' + dosya.name + '" yüklenemedi: ' + ekHataMetni(cevap),
                            'text-red-600 dark:text-red-400');
      continue;
    }

    d.duzenleGorselleri.push({
      id: cevap.veri.id,
      onizleme: cevap.veri.thumbnail || cevap.veri.url || veriAdresi,
      url: cevap.veri.url || ''
    });

    duzenleGorselKutusuCiz();
  }

  const adet = d.duzenleGorselleri.length;
  duzenleGorselDurumYaz(
    adet
      ? adet + ' yeni görsel hazır. Kaydettiğinizde ürünün görselleri bunlarla değiştirilir.'
      : 'Yeni görsel seçilmedi — mevcut görsel korunacak.',
    adet ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
  );
}

/** Kategori kutusunu doldurur; hata olsa bile pencere KAPATILMAZ. */
async function duzenleKategorileriYukle(seciliId) {
  const secim = $('#duzenleKategori');
  if (!secim) return;

  secim.innerHTML = '<option value="">Kategoriler yükleniyor…</option>';

  let kategoriler = [];
  let hataMi = false;

  try {
    if (ekDemoMu()) {
      kategoriler = DEMO_KATEGORILER.slice();
    } else {
      /* Sayfa sayfa (bkz. renderer.js > tumKategorileriGetir): tek istek
         100 kategoriyle sınırlıydı ve geniş kataloglarda listenin sonundaki
         kategoriler açılır kutuda hiç görünmüyordu. */
      const cevap = await tumKategorileriGetir();

      if (cevap && cevap.ok) {
        kategoriler = cevap.kategoriler;
      } else {
        hataMi = true;
      }
    }
  } catch (e) {
    hataMi = true;
  }

  if (hataMi) {
    secim.innerHTML = '<option value="">— Kategoriler alınamadı —</option>';
    return;
  }

  secim.innerHTML = '<option value="">— Kategorisiz —</option>' +
    kategoriler.map(function (k) {
      return '<option value="' + kacis(String(k.id)) + '"' +
             (String(k.id) === String(seciliId || '') ? ' selected' : '') + '>' +
             kacis(k.ad) + '</option>';
    }).join('');

  if (seciliId) secim.value = String(seciliId);
}

/** Ürün düzenleme penceresini açar ve alanları doldurur. */
async function urunDuzenleAc(id) {
  const d = ekDurum();
  if (!d) return;

  const urun = (d.urunler || []).filter(function (u) {
    return String(u.id) === String(id);
  })[0];

  if (!urun) {
    bildir('Ürün bulunamadı.', 'hata');
    return;
  }

  const katman = $('#urunDuzenleKatman');
  if (!katman) {
    bildir('Düzenleme penceresi bulunamadı.\nUygulamayı yeniden başlatmayı deneyin.', 'hata');
    return;
  }

  try {
    d.duzenlenenUrun = urun;
    d.duzenleGorselleri = [];

    /* --- Başlıklar --- */
    /* Emoji başlıkta ZATEN var (index.html'deki büyük ikonu); burada
       tekrarlanmaz — "Yeni Ürün Ekle" penceresiyle aynı düzen. */
    const baslik = $('#duzenleBaslik');
    if (baslik) baslik.textContent = 'Ürünü Düzenle';

    const altBaslik = $('#duzenleAltBaslik');
    if (altBaslik) {
      altBaslik.textContent = urun.ad + '  ·  #' + urun.id +
        (ekDemoMu()
          ? '  ·  Demo Modu (sitenize kaydedilmez)'
          : '  ·  Değişiklikler sitenize kaydedilir');
    }

    /* --- Alanlar --- */
    const kodDegeri = String(urun.barkod || urun.kod || '');
    d.duzenleIlkKod = (kodDegeri === '-' ? '' : kodDegeri);
    d.duzenleIlkAciklama = String(urun.aciklama || '');

    const adAlani = $('#duzenleAd');
    if (adAlani) adAlani.value = String(urun.ad || '');

    const fiyatAlani = $('#duzenleFiyat');
    if (fiyatAlani) fiyatAlani.value = fiyatYazi(urun.fiyat);

    /* İndirimli fiyat: üründe indirim yoksa kutu BOŞ kalır — "0,00" yazılsaydı
       kullanıcı dokunmadan kaydettiğinde ürün bedavaya düşerdi. */
    const indirimliAlani = $('#duzenleIndirimliFiyat');
    const indirimliDeger = indirimliFiyatCoz(urun.indirimliFiyat);
    /* Açılıştaki indirim durumu saklanır: kaydetme bildirimindeki "İndirim
       kaldırıldı" satırı YALNIZCA gerçekten var olan bir indirim silindiğinde
       çıksın. İndirimsiz üründe kutu zaten boş olduğu için bu satır her kayıtta
       (ör. yalnızca stok düzeltilirken) yanıltıcı biçimde görünüyordu. */
    d.duzenleIlkIndirimliVarMi = (indirimliDeger !== '');
    if (indirimliAlani) {
      indirimliAlani.value = (indirimliDeger === '') ? '' : fiyatYazi(indirimliDeger);
    }

    const stokAlani = $('#duzenleStok');
    if (stokAlani) stokAlani.value = String(Number(urun.stok || 0));

    const koliAlani = $('#duzenleKoliAdedi');
    if (koliAlani) {
      const koliDeger = Math.round(Number(urun.koliAdedi || 1));
      koliAlani.value = String((isFinite(koliDeger) && koliDeger >= 1) ? koliDeger : 1);
    }

    const kodAlani = $('#duzenleKod');
    if (kodAlani) kodAlani.value = d.duzenleIlkKod;

    const aciklamaAlani = $('#duzenleAciklama');
    if (aciklamaAlani) aciklamaAlani.value = d.duzenleIlkAciklama;

    const durumSec = $('#duzenleDurumSec');
    if (durumSec) durumSec.value = (urun.durum === 'publish') ? 'publish' : 'draft';

    const urlAlani = $('#duzenleGorselUrl');
    if (urlAlani) urlAlani.value = '';

    /* --- Görsel bölümü --- */
    duzenleUyar('');
    duzenleGorselKutusuCiz();
    duzenleGorselDurumYaz('Yeni görsel seçilmedi — mevcut görsel korunacak.',
                          'text-slate-500 dark:text-slate-400');

    /* --- Pencereyi aç --- */
    katman.classList.remove('hidden');
    if (adAlani) {
      setTimeout(function () { adAlani.focus(); }, 30);
    }

    /* --- Kategoriler (pencere açıkken arka planda gelir) --- */
    const mevcutKategori = (urun.kategoriler && urun.kategoriler[0])
      ? urun.kategoriler[0].id
      : '';

    /* Kategori yalnızca kullanıcı DEĞİŞTİRİRSE gönderilir; aksi hâlde ürünün
       birden fazla kategorisi varsa kaydetmek onları sessizce silerdi. */
    d.duzenleIlkKategori = String(mevcutKategori || '');
    d.duzenleKategoriSayisi = (urun.kategoriler || []).length;

    await duzenleKategorileriYukle(mevcutKategori);
  } catch (e) {
    duzenleUyar('Ürün bilgileri hazırlanırken hata oluştu:\n' + String((e && e.message) || e));
    bildir('Ürün düzenleme penceresi açılırken hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  }
}

/** Düzenleme penceresini kapatır. */
function urunDuzenleKapat() {
  const katman = $('#urunDuzenleKatman');
  if (katman) katman.classList.add('hidden');

  const d = ekDurum();
  if (d) {
    d.duzenlenenUrun = null;
    d.duzenleGorselleri = [];
  }

  duzenleUyar('');
}

/**
 * Düzenlenen ürünü kaydeder.
 * Ana yol : PUT /wp-json/wc/v3/products/{id}
 * Yedek   : PUT /wp-json/wc-b2b/v1/products/{id}  (wc/v3 kapalıysa)
 */
/**
 * Tek ürünü YERİNDE günceller — listeyi yeniden çekmeden.
 *
 * Öncelik sunucu yanıtındadır: WooCommerce fiyatı biçimlendirebilir, SKU'yu
 * benzersizleştirebilir ya da görsel adresini kendi CDN yoluna çevirebilir;
 * ekranda sitedeki GERÇEK değer görünmelidir. Yanıt gövdesi boş gelirse
 * formdaki değerlerle yetinilir.
 *
 * @param {number|string} id     Ürün kimliği.
 * @param {object}        cevap  PUT yanıtı ({ok, veri}).
 * @param {object}        yerel  Formdan okunan değerler (yedek yol).
 */
function ekUrunuYerindeGuncelle(id, cevap, yerel) {
  const d = ekDurum();
  if (!d) return;

  const urun = (d.urunler || []).filter(function (u) { return String(u.id) === String(id); })[0];
  if (!urun) return;

  /* 1) Sunucu yanıtı varsa onu kaynak al. */
  if (cevap && cevap.veri && cevap.veri.id && typeof urunNormalle === 'function') {
    const taze = urunNormalle(cevap.veri);
    Object.keys(taze).forEach(function (alan) { urun[alan] = taze[alan]; });
  } else {
    /* 2) Yedek yol: formdaki değerler. */
    urun.ad = yerel.ad;
    urun.fiyat = yerel.fiyat;
    urun.indirimliFiyat = yerel.indirimliFiyat;
    urun.stok = yerel.stok;
    urun.durum = yerel.durum;
    urun.koliAdedi = yerel.koliAdedi;

    if (yerel.kod) { urun.kod = yerel.kod; urun.barkod = yerel.kod; }
    if (yerel.aciklama !== null) urun.aciklama = yerel.aciklama;
    if (yerel.gorsel) urun.gorsel = yerel.gorsel;

    if (yerel.kategoriId) {
      urun.kategoriler = [{ id: yerel.kategoriId, ad: String(yerel.kategoriAdi || '') }];
    }
  }

  /* Demo kaynağı da güncellensin; yenilendiğinde değişiklik kaybolmasın. */
  if (ekDemoMu() && typeof DEMO_URUNLER !== 'undefined') {
    const kaynak = DEMO_URUNLER.filter(function (x) { return String(x.id) === String(id); })[0];
    if (kaynak) Object.keys(urun).forEach(function (alan) { kaynak[alan] = urun[alan]; });
  }

  /* Durum süzgeci açıksa ve ürün artık uymuyorsa listeden düşür. */
  if (d.urunDurumSuzgec && d.urunDurumSuzgec !== urun.durum) {
    d.urunler = d.urunler.filter(function (u) { return String(u.id) !== String(id); });
  }

  /*
   * Kaydırma konumu KORUNUR.
   *
   * Tablo görünümünde tek satır yerinde değiştirilir (renderer-izgara.js >
   * izgSatiriTazele), kart görünümünde liste yeniden çizilir ama kabın
   * scrollTop değeri geri yazılır. İkisinde de kullanıcı baktığı yerde kalır.
   */
  const izgaraVar = typeof izg === 'function' && izg();

  if (izgaraVar && izgaraVar.gorunum === 'tablo') {
    if (typeof izgSatiriTazele === 'function') izgSatiriTazele(id);
    if (typeof izgKategoriAgaciCiz === 'function') izgKategoriAgaciCiz();
    /* Ürün süzgeç dışına düştüyse liste kısalmıştır; ızgara yeniden ölçülmeli. */
    if (d.urunDurumSuzgec && typeof izgCiz === 'function') izgCiz(true);
    return;
  }

  const kap = $('#urunListesi');
  const konum = kap ? kap.scrollTop : 0;
  const govde = $('#anaGovde');
  const sayfaKonumu = govde ? govde.scrollTop : 0;

  urunleriCiz(ekDemoMu() ? ekAramaMetni() : '');

  if (kap) kap.scrollTop = konum;
  if (govde) govde.scrollTop = sayfaKonumu;
}

async function urunDuzenleKaydet() {
  const d = ekDurum();
  if (!d) return;

  const urun = d.duzenlenenUrun;
  if (!urun) { bildir('Düzenlenecek ürün seçilmedi.', 'hata'); return; }

  const id = urun.id;

  const adAlani = $('#duzenleAd');
  const fiyatAlani = $('#duzenleFiyat');
  const indirimliAlani = $('#duzenleIndirimliFiyat');
  const stokAlani = $('#duzenleStok');
  const koliAlani = $('#duzenleKoliAdedi');
  const kodAlani = $('#duzenleKod');
  const aciklamaAlani = $('#duzenleAciklama');
  const durumSec = $('#duzenleDurumSec');
  const kategoriSec = $('#duzenleKategori');
  const urlAlani = $('#duzenleGorselUrl');

  const ad = adAlani ? adAlani.value.trim() : '';
  const fiyat = sayiCoz(fiyatAlani ? fiyatAlani.value : '');
  const indirimliYazi = indirimliAlani ? indirimliAlani.value.trim() : '';
  const indirimli = indirimliYazi ? sayiCoz(indirimliYazi) : NaN;
  const stokHam = sayiCoz(stokAlani ? stokAlani.value : '');
  const stok = Math.round(stokHam);
  const koliHam = sayiCoz(koliAlani ? koliAlani.value : '');
  const koli = isNaN(koliHam) ? 1 : Math.round(koliHam);
  const kod = kodAlani ? kodAlani.value.trim() : '';
  const aciklama = aciklamaAlani ? aciklamaAlani.value.trim() : '';
  const yayinDurumu = (durumSec && durumSec.value === 'draft') ? 'draft' : 'publish';
  const kategoriId = kategoriSec ? String(kategoriSec.value || '') : '';
  const kategoriAdi = (kategoriSec && kategoriSec.selectedOptions && kategoriSec.selectedOptions[0])
    ? kategoriSec.selectedOptions[0].textContent
    : '';
  const gorselUrl = urlAlani ? urlAlani.value.trim() : '';
  const yeniGorseller = (d.duzenleGorselleri || []).slice();

  /* --- Doğrulamalar --- */
  if (!ad) {
    duzenleUyar('Ürün adı boş bırakılamaz.');
    if (adAlani) adAlani.focus();
    return;
  }
  if (isNaN(fiyat) || !isFinite(fiyat) || fiyat < 0) {
    duzenleUyar('Geçerli bir fiyat yazın.\nÖrnek: 2450,00');
    if (fiyatAlani) fiyatAlani.focus();
    return;
  }
  /* Sıfır da geçersiz — bkz. renderer.js urunEkle: sale_price="0.00" ürünü
     sitede bedavaya düşürür, panel ise kutuyu boş gösterip hatayı gizler. */
  if (indirimliYazi && (isNaN(indirimli) || !isFinite(indirimli) || indirimli <= 0)) {
    duzenleUyar('Geçerli bir indirimli fiyat yazın.\nÖrnek: 1990,00\n' +
                'Sıfır yazılamaz — indirimi kaldırmak için kutuyu tamamen boşaltın.');
    if (indirimliAlani) indirimliAlani.focus();
    return;
  }
  /* Sunucu eşit fiyatı da reddediyor (bkz. renderer.js urunEkle). */
  if (indirimliYazi && indirimli >= fiyat) {
    duzenleUyar('İndirimli fiyat, normal fiyattan DÜŞÜK olmalıdır.\n' +
                'Normal fiyat: ' + para(fiyat) + '\n' +
                'İndirimli fiyat: ' + para(indirimli) + '\n' +
                'İndirimi kaldırmak için kutuyu tamamen boşaltın.');
    if (indirimliAlani) { indirimliAlani.focus(); if (indirimliAlani.select) indirimliAlani.select(); }
    return;
  }
  if (isNaN(stok) || !isFinite(stok) || stok < 0) {
    duzenleUyar('Geçerli bir stok adedi yazın.\nÖrnek: 45');
    if (stokAlani) stokAlani.focus();
    return;
  }
  if (!isFinite(koli) || koli < 1) {
    duzenleUyar('Koli içi adet en az 1 olmalıdır.\nTek tek satılan ürünlerde 1 yazın.');
    if (koliAlani) koliAlani.focus();
    return;
  }
  if (!yeniGorseller.length && gorselUrl && !/^https?:\/\//i.test(gorselUrl)) {
    duzenleUyar('Görsel bağlantısı http:// veya https:// ile başlamalıdır.');
    if (urlAlani) urlAlani.focus();
    return;
  }

  const kodDegistiMi = (kod !== String(d.duzenleIlkKod || ''));
  const aciklamaDegistiMi = (aciklama !== String(d.duzenleIlkAciklama || ''));

  /* Kategori sadece gerçekten değiştiyse gönderilir: ürün birden fazla
     kategorideyse, dokunulmamış tek seçimli kutu yüzünden diğer kategorileri
     silmeyelim. Kullanıcı bilerek değiştirdiyse taşıma amaçlıdır. */
  const kategoriDegistiMi = (kategoriId !== String(d.duzenleIlkKategori || ''));

  if (kategoriDegistiMi && Number(d.duzenleKategoriSayisi || 0) > 1) {
    const eminMi = await onayla(
      'Kategori Değişikliği',
      'Bu ürün şu anda ' + Number(d.duzenleKategoriSayisi) + ' kategoride görünüyor.\n' +
      'Kaydettiğinizde ürün YALNIZCA seçtiğiniz kategoride kalacak, diğerlerinden çıkarılacak.\n\n' +
      'Devam edilsin mi?',
      'EVET, DEĞİŞTİR',
      true
    );

    if (!eminMi) return;
  }

  if (kod && kodDegistiMi) {
    const cakisan = (d.urunler || []).filter(function (u) {
      if (String(u.id) === String(id)) return false;
      const uKod = String(u.barkod || u.kod || '');
      return uKod && uKod !== '-' &&
             uKod.toLocaleLowerCase('tr-TR') === kod.toLocaleLowerCase('tr-TR');
    })[0];

    if (cakisan) {
      duzenleUyar('Bu barkod / stok kodu başka bir üründe kullanılıyor:\n' +
                  cakisan.ad + ' (#' + cakisan.id + ')');
      if (kodAlani) { kodAlani.focus(); if (kodAlani.select) kodAlani.select(); }
      return;
    }
  }

  duzenleUyar('');

  const dugme = $('#duzenleKaydetBtn');
  const geriAl = dugme ? butonuMesgulEt(dugme, 'KAYDEDİLİYOR…') : function () {};

  try {
    /* ---------- DEMO ---------- */
    if (ekDemoMu()) {
      await bekle(320);

      const yeniGorsel = (yeniGorseller[0] && yeniGorseller[0].onizleme) ||
                         gorselUrl || urun.gorsel || YEDEK_GORSEL;

      const guncelle = function (kayit) {
        if (!kayit) return;
        kayit.ad = ad;
        kayit.fiyat = fiyat;
        kayit.indirimliFiyat = indirimliYazi ? indirimli : '';
        kayit.koliAdedi = koli;
        kayit.stok = stok;
        kayit.durum = yayinDurumu;
        kayit.gorsel = yeniGorsel;
        if (kod) { kayit.kod = kod; kayit.barkod = kod; }
        kayit.aciklama = aciklama;
        if (kategoriDegistiMi && kategoriId) {
          kayit.kategoriler = [{ id: Number(kategoriId), ad: String(kategoriAdi || '') }];
        }
      };

      guncelle(DEMO_URUNLER.filter(function (u) { return String(u.id) === String(id); })[0]);
      guncelle((d.urunler || []).filter(function (u) { return String(u.id) === String(id); })[0]);

      urunDuzenleKapat();
      urunleriCiz('');

      bildir('Ürün güncellendi:\n' + ad + '\nFiyat: ' + para(fiyat) + '  ·  Stok: ' + stok + ' adet' +
             (indirimliYazi ? '\nİndirimli fiyat: ' + para(indirimli)
                            : (d.duzenleIlkIndirimliVarMi ? '\nİndirim kaldırıldı' : '')) +
             (koli > 1 ? '\nKoli içi adet: ' + koli : '') +
             (yeniGorseller.length ? '\nGörsel: ' + yeniGorseller.length + ' adet değiştirildi' : '') +
             '\n(Demo Modu — sitenizde değişiklik yapılmadı)', 'basari');

      yeniUrunuVurgula(id);
      return;
    }

    /* ---------- CANLI — ANA YOL: PUT /wc/v3/products/{id} ---------- */
    const govde = {
      name: ad,
      regular_price: fiyat.toFixed(2),
      /* Kutu boşsa boş dize gider; WooCommerce indirimi böyle kaldırır. */
      sale_price: indirimliYazi ? indirimli.toFixed(2) : '',
      stock_quantity: stok,
      manage_stock: true,
      status: yayinDurumu,
      meta_data: koliMetaVerisi(koli)
    };

    if (kodDegistiMi) govde.sku = kod;
    if (aciklamaDegistiMi) govde.description = aciklama;
    if (kategoriDegistiMi && kategoriId) govde.categories = [{ id: Number(kategoriId) }];

    if (yeniGorseller.length) {
      govde.images = yeniGorseller.map(function (g) { return { id: Number(g.id) }; });
    } else if (gorselUrl) {
      govde.images = [{ src: gorselUrl }];
    }

    let cevap = await woo('products/' + id, {
      metod: 'PUT',
      govde: govde,
      sureAsimi: 60000
    });

    /* ---------- YEDEK YOL: PUT /wc-b2b/v1/products/{id} ---------- */
    let yedekDenendiMi = false;

    if (cevap && !cevap.ok && (cevap.durum === 404 || cevap.kod === 'rest_no_route')) {
      yedekDenendiMi = true;

      const b2bGovde = {
        name: ad,
        regular_price: fiyat.toFixed(2),
        sale_price: indirimliYazi ? indirimli.toFixed(2) : '',
        stock_quantity: stok,
        manage_stock: true,
        status: yayinDurumu,
        description: aciklama,
        meta_data: koliMetaVerisi(koli)
      };

      if (kod) b2bGovde.sku = kod;
      if (kod) b2bGovde.barcode = kod;
      if (kategoriDegistiMi && kategoriId) b2bGovde.categories = [Number(kategoriId)];

      if (yeniGorseller.length) {
        b2bGovde.images = yeniGorseller.map(function (g) { return g.id; });
        b2bGovde.replace_images = true;
      } else if (gorselUrl) {
        b2bGovde.images = [gorselUrl];
        b2bGovde.replace_images = true;
      }

      cevap = await b2b('products/' + id, {
        metod: 'PUT',
        govde: b2bGovde,
        sureAsimi: 60000
      });
    }

    if (!cevap || !cevap.ok) {
      const metin = ekHataMetni(cevap) +
        (yedekDenendiMi ? '\n\n(WooCommerce ucu bulunamadığı için B2B Core ucu da denendi.)' : '');
      duzenleUyar('Ürün güncellenemedi:\n' + metin);
      bildir('Ürün güncellenemedi:\n' + metin, 'hata');
      return;   // Pencere AÇIK kalır, kullanıcı düzeltip yeniden deneyebilir
    }

    /* --- Başarılı --- */
    urunDuzenleKapat();

    /*
     * KISMİ GÜNCELLEME — listeyi baştan çekme.
     *
     * Eskiden burada `await urunleriYukle(...)` vardı: tek ürün kaydedildiğinde
     * mağazanın TÜM ürünleri (900+ üründe sayfa sayfa, onlarca istek) yeniden
     * çekiliyordu. Liste sıfırdan çizildiği için kaydırma konumu da en başa
     * dönüyor, 400. üründeki fiyatı düzelten kişi her kayıtta listenin tepesine
     * fırlıyordu.
     *
     * Artık sunucunun PUT yanıtı doğrudan yerel kayda işlenir. Yanıt gövdesi
     * yoksa (bazı yedek uçlar boş döner) ekrandaki değerler formdan yazılır;
     * ikisi de olmazsa ürün listede eski hâliyle kalır ama YENİLE düğmesi
     * her zaman elde.
     */
    ekUrunuYerindeGuncelle(id, cevap, {
      ad: ad,
      fiyat: fiyat,
      indirimliFiyat: indirimliYazi ? indirimli : '',
      stok: stok,
      durum: yayinDurumu,
      koliAdedi: koli,
      kod: kodDegistiMi ? kod : null,
      aciklama: aciklamaDegistiMi ? aciklama : null,
      kategoriId: (kategoriDegistiMi && kategoriId) ? Number(kategoriId) : null,
      kategoriAdi: kategoriAdi,
      gorsel: (yeniGorseller[0] && yeniGorseller[0].onizleme) || gorselUrl || null
    });

    bildir('Ürün güncellendi:\n' + ad + '\nFiyat: ' + para(fiyat) + '  ·  Stok: ' + stok + ' adet' +
           (indirimliYazi ? '\nİndirimli fiyat: ' + para(indirimli)
                          : (d.duzenleIlkIndirimliVarMi ? '\nİndirim kaldırıldı' : '')) +
           (koli > 1 ? '\nKoli içi adet: ' + koli : '') +
           (kodDegistiMi && kod ? '\nBarkod/SKU: ' + kod : '') +
           (kategoriDegistiMi && kategoriId ? '\nKategori: ' + kategoriAdi : '') +
           (yeniGorseller.length ? '\nGörsel: ' + yeniGorseller.length + ' adet değiştirildi' : '') +
           '\nSitenizde güncellendi.', 'basari');

    yeniUrunuVurgula(id);
  } catch (e) {
    duzenleUyar('Beklenmeyen bir hata oluştu:\n' + String((e && e.message) || e));
    bildir('Ürün güncellenirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    geriAl();
  }
}

/* ==========================================================================
 *  BÖLÜM D — ⋮⋮ SÜRÜKLE-BIRAK SIRALAMA
 * ========================================================================*/

/** Sürükleme sırasında satıra eklenen geçici sınıflar. */
const SIRA_GOSTERGE_SINIFLARI = ['border-t-4', 'border-b-4', 'border-marka-600'];

/** Bütün satırlardan bırakma göstergelerini siler. */
function siraGostergeleriniTemizle() {
  const kap = $('#urunListesi');
  if (!kap) return;

  Array.prototype.slice.call(kap.querySelectorAll('[data-urun]')).forEach(function (satir) {
    satir.classList.remove.apply(satir.classList, SIRA_GOSTERGE_SINIFLARI);
  });
}

/** Sürükleme bittiğinde bütün geçici işaretleri kaldırır. */
function siraSuruklemeyiBitir() {
  const kap = $('#urunListesi');
  const d = ekDurum();

  if (kap) {
    Array.prototype.slice.call(kap.querySelectorAll('[data-urun]')).forEach(function (satir) {
      satir.classList.remove('opacity-40');
      satir.setAttribute('draggable', 'false');
    });
  }

  siraGostergeleriniTemizle();
  if (d) d.suruklenenUrun = null;
}

/**
 * Sıralama yalnızca SÜZGEÇSİZ ve EKSİKSİZ liste üzerinde güvenlidir.
 *
 * İki ayrı tehlike vardır:
 *
 *  1) SÜZGEÇ: Canlı modda arama/durum süzgeci açıkken `durum.urunler` sitedeki
 *     ürünlerin yalnızca bir bölümüdür; bu listeye menu_order yazmak süzülen
 *     ürünleri mağazanın en başına taşır ve gerçek sırayı bozar.
 *
 *  2) EKSİK LİSTE: REST ucu istek başına en fazla 100 kayıt döndürür. Liste
 *     sayfa sayfa çekilmeden (bkz. renderer.js > tumSayfalariGetir) bir ürün
 *     taşındığında, komşuların menu_order değerleri hafızada olmayan ürünlerle
 *     çakışıyor ve altındaki ürünler listenin en dibine düşüyordu.
 *     Bu yüzden liste tamamlanmadan sıralamaya hiç izin verilmez.
 */
function siralamaGuvenliMi() {
  if (ekDemoMu()) return true;

  const d = ekDurum();
  const arama = String(ekAramaMetni() || '').trim();
  const durumSuzgec = (d && d.urunDurumSuzgec) ? String(d.urunDurumSuzgec) : '';

  if (arama || durumSuzgec) {
    bildir('Sıralama yalnızca süzgeçsiz tam listede yapılabilir.\n' +
           'Arama kutusunu boşaltın ve durum süzgecini kaldırın,\n' +
           'sonra ürünleri sürükleyerek sıralayın.', 'uyari');
    return false;
  }

  if (d && d.urunYukleniyor) {
    bildir('Ürünler hâlâ yükleniyor.\n' +
           'Liste tamamlanmadan sıralama yapılırsa sıra kayabilir;\n' +
           'yükleme bitince tekrar deneyin.', 'uyari');
    return false;
  }

  if (d && !d.urunlerTamYuklendi) {
    bildir('Mağazanızdaki ürünlerin tamamı yüklenemedi' +
           (d.urunlerToplam ? ' (' + (d.urunler || []).length + ' / ' + d.urunlerToplam + ').' : '.') +
           '\n\nEksik liste üzerinde sıralama yapmak, ekranda görünmeyen\n' +
           'ürünlerin sırasını bozar. Önce YENİLE ile listeyi tamamlayın.', 'uyari');
    return false;
  }

  return true;
}

/* --------------------------------------------------------------------------
 *  SIRA HESABI — "bir ürün taşındı, bir ürün güncellenir"
 *  ---------------------------------------------------------------------------
 *  SORUN (eski davranış):
 *    Tek bir ürün taşındığında ekrandaki BÜTÜN ürünlere baştan 0,1,2,3…
 *    menu_order yazılıyordu. İki yan etkisi vardı:
 *      1) Tek satır için sitede 100 ürün güncelleniyordu (yavaş ve riskli).
 *      2) Masaüstü listesi mağazanın yalnızca ilk 100 ürününü gösterdiği için
 *         listede olmayan ürünler eski değerleriyle kalıyor, yeni 0..99
 *         aralığıyla çakışıyordu; sonuç: sitedeki sıra "kayıyordu".
 *
 *  ÇÖZÜM:
 *    Taşınan ürüne, YENİ KOMŞULARININ ARASINA düşen bir menu_order verilir
 *    (20 ile 30 arasına bırakıldıysa 25). Böylece yalnızca o ürün güncellenir;
 *    diğer ürünlerin ve ekranda görünmeyen ürünlerin sırası hiç bozulmaz.
 *    Araya tam sayı sığmıyorsa (20 ile 21 arası) yalnızca o dar pencere
 *    yeniden numaralandırılır — yine tüm liste değil.
 * ------------------------------------------------------------------------*/

/** Yeni değer üretirken bırakılan aralık. Araya yer kalsın diye 1 değil 10. */
const SIRA_ADIM = 10;

/** /products/order ucunun izin verdiği en büyük sayfa boyu (REORDER_LIMIT). */
const SIRA_GETIR_BOYU = 500;

/**
 * /products/reorder ucuna tek istekte gönderilecek en fazla ürün.
 * Uç 500'e kadar kabul eder; 200'lük parçalar paylaşımlı hostinglerde
 * zaman aşımına düşmeden geçer.
 */
const SIRA_YAZMA_PARCASI = 200;

/** Ürünün sitede yazılı menu_order değeri (bilinmiyorsa 0). */
function siraDegeri(u) {
  const n = Number(u && u.menuSira);
  return isFinite(n) ? n : 0;
}

/**
 * Hesaplanan değerleri ürünlere yazar.
 * @param {Array} ciftler [{ oge, deger }]
 * @returns {Array} Yalnızca DEĞERİ DEĞİŞEN ürünler: [{ id, menu_order }]
 */
function siraYaz(ciftler) {
  const degisen = [];

  (ciftler || []).forEach(function (c) {
    if (!c || !c.oge) return;

    const yeni = Math.round(Number(c.deger));
    if (!isFinite(yeni)) return;

    /* Değeri zaten doğru olan ürün için siteye istek atılmaz. */
    if (siraDegeri(c.oge) === yeni) return;

    c.oge.menuSira = yeni;
    degisen.push({ id: Number(c.oge.id), menu_order: yeni });
  });

  return degisen;
}

/**
 * Komşuların arasına sayı sığmadığında en dar pencereyi yeniden numaralandırır.
 * Pencere taşınan üründen başlar ve sığana kadar birer adım büyür.
 *
 * @param {Array}  liste  Ekrandaki (yeni) sıra.
 * @param {number} indeks Taşınan ürünün yeni konumu.
 * @returns {Array} Değişen ürünler.
 */
function siraPenceresiniYenidenNumarala(liste, indeks) {
  let bas = indeks;
  let son = indeks;

  /* Tur sayısı listeyle sınırlı: pencere en fazla tüm listeye kadar büyür. */
  for (let tur = 0; tur <= liste.length; tur++) {
    const altSinir = (bas > 0) ? siraDegeri(liste[bas - 1]) : null;
    const ustSinir = (son < liste.length - 1) ? siraDegeri(liste[son + 1]) : null;
    const adet = son - bas + 1;

    /* İki taraftan da sınırlıysa aradaki tam sayı adedi yetmeli. */
    const siginiyorMu = (altSinir === null || ustSinir === null)
      ? true
      : (ustSinir - altSinir) >= (adet + 1);

    if (siginiyorMu) {
      const ciftler = [];

      for (let k = 0; k < adet; k++) {
        let deger;

        if (altSinir === null && ustSinir === null) {
          deger = k * SIRA_ADIM;                        // Pencere = tüm liste
        } else if (altSinir === null) {
          deger = ustSinir - (adet - k) * SIRA_ADIM;    // Listenin başı
        } else if (ustSinir === null) {
          deger = altSinir + (k + 1) * SIRA_ADIM;       // Listenin sonu
        } else {
          const aralik = Math.floor((ustSinir - altSinir) / (adet + 1));
          deger = altSinir + aralik * (k + 1);
        }

        ciftler.push({ oge: liste[bas + k], deger: deger });
      }

      return siraYaz(ciftler);
    }

    if (bas > 0) bas--;
    if (son < liste.length - 1) son++;
  }

  return [];
}

/**
 * Taşınan ürünün yeni menu_order değerini hesaplar.
 * @returns {Array} Güncellenmesi gereken ürünler: [{ id, menu_order }]
 */
function siraDegisiminiHesapla(liste, indeks) {
  if (!liste || !liste.length || indeks < 0 || indeks >= liste.length) return [];

  const oge = liste[indeks];
  const alt = (indeks > 0) ? siraDegeri(liste[indeks - 1]) : null;
  const ust = (indeks < liste.length - 1) ? siraDegeri(liste[indeks + 1]) : null;

  /* Listenin en başına taşındı: üstteki komşudan küçük bir değer yeter. */
  if (alt === null) {
    return siraYaz([{ oge: oge, deger: (ust === null) ? 0 : ust - SIRA_ADIM }]);
  }

  /* Listenin en sonuna taşındı.
     NOT: Bu değer, ekranda görünmeyen (sonraki sayfadaki) bir ürünün değerine
     denk gelebilir; o zaman ikisinin birbirine göre sırasını WooCommerce'in
     ikincil sıralaması belirler. Listenin tamamını yeniden numaralandırmaktan
     çok daha zararsız bir durum. */
  if (ust === null) {
    return siraYaz([{ oge: oge, deger: alt + SIRA_ADIM }]);
  }

  /* İki komşunun arasında tam sayı varsa: SADECE taşınan ürün güncellenir. */
  if (ust - alt >= 2) {
    return siraYaz([{ oge: oge, deger: Math.floor((alt + ust) / 2) }]);
  }

  /* Araya sayı sığmıyor (ör. 20 ile 21, ya da ikisi de 0). */
  return siraPenceresiniYenidenNumarala(liste, indeks);
}

/** Değişen ürünleri gönderim kuyruğuna ekler. */
function siraDegisimleriniKuyrukla(degisen) {
  const d = ekDurum();
  if (!d || !degisen || !degisen.length) return 0;

  if (!d.siraBekleyen) d.siraBekleyen = {};

  degisen.forEach(function (k) {
    d.siraBekleyen[String(k.id)] = k.menu_order;
  });

  d.siralamaDegisti = true;   // Henuz siteye yazilmamis sira degisikligi var
  return degisen.length;
}

/* --------------------------------------------------------------------------
 *  SIRA NUMARASI TABANI
 *  ---------------------------------------------------------------------------
 *  WooCommerce'de yeni ürünlerin menu_order değeri 0'dır; hiç sıralama
 *  yapılmamış bir mağazada BÜTÜN ürünler 0 olur. O zaman "iki komşunun arasına
 *  yerleştirme" işlemez, çünkü 0 ile 0 arasına sayı sığmaz. Aynı sıkışıklık
 *  0,1,2,3… gibi bitişik numaralanmış listelerde de olur.
 *
 *  Bu yüzden ilk taşımadan önce BİR KEZ ürünlere 10'ar aralıklı numara verilir.
 *  Sonraki bütün taşımalar tek ürün güncelleyerek çalışır.
 * ------------------------------------------------------------------------*/

/** Araya yeni sayı sığdıracak kadar boşluk var mı? */
function siraTabaniYetersizMi(liste) {
  if (!liste || liste.length < 2) return false;

  let enKucuk = siraDegeri(liste[0]);
  let enBuyuk = enKucuk;

  liste.forEach(function (u) {
    const v = siraDegeri(u);
    if (v < enKucuk) enKucuk = v;
    if (v > enBuyuk) enBuyuk = v;
  });

  /* Ürün başına ortalama en az 2 birim boşluk yoksa taban yetersizdir. */
  return (enBuyuk - enKucuk) < (liste.length * 2);
}

/**
 * Ürünlere 10'ar aralıklı sıra numarası verir (bir kereliktir).
 *
 * Art arda yapılan taşımalarda hazırlık iki kez başlamasın diye çalışan
 * işin sözü (promise) saklanır; ikinci çağrı aynı işi bekler.
 *
 * @returns {Promise<boolean>} Hazırlık başarılıysa true.
 */
function siraTabaniniHazirla() {
  const d = ekDurum();
  if (!d) return Promise.resolve(false);

  if (d.siraTabaniSozu) return d.siraTabaniSozu;

  d.siraTabaniSozu = (async function () {
    try {
      return await siraTabaniniOlustur();
    } finally {
      d.siraTabaniSozu = null;
    }
  })();

  return d.siraTabaniSozu;
}

/** Asıl hazırlık işi (bkz. siraTabaniniHazirla). */
async function siraTabaniniOlustur() {
  const d = ekDurum();
  if (!d) return false;

  bildir('Ürün sıra numaraları ilk kez hazırlanıyor…\nBu işlem yalnızca bir kez yapılır.', 'bilgi');

  /* ---------- DEMO ---------- */
  if (ekDemoMu()) {
    if (typeof DEMO_URUNLER !== 'undefined') {
      DEMO_URUNLER.forEach(function (u, i) { u.menuSira = i * SIRA_ADIM; });
    }

    (d.urunler || []).forEach(function (u) {
      const kaynak = (typeof DEMO_URUNLER === 'undefined')
        ? null
        : DEMO_URUNLER.filter(function (x) { return String(x.id) === String(u.id); })[0];
      if (kaynak) u.menuSira = kaynak.menuSira;
    });

    return true;
  }

  /* ---------- CANLI (B2B Core) — mağazanın TAMAMI numaralanır ----------
     Ekrandaki liste değil, /products/order ucundan SAYFA SAYFA gelen tam sıra
     kullanılır; aksi halde listede görünmeyen ürünler 0'da kalır ve
     numaralanan ürünlerin önüne geçerdi. (Eskiden yalnızca ilk 500 ürün
     çekiliyordu; 900+ ürünlü mağazalarda kalan ürünler 0'da kalıp sıra
     kaymasına sebep oluyordu.) */
  if (ekEklentiVarMi()) {
    const sirali = await tumSayfalariGetir('b2b', 'products/order', {}, {
      sayfaBoyu: SIRA_GETIR_BOYU,
      sureAsimi: 60000
    });

    if (!sirali || !sirali.ok || !Array.isArray(sirali.veri) || !sirali.veri.length) {
      bildir('Sıra numaraları hazırlanamadı:\n' + ekHataMetni(sirali), 'hata');
      return false;
    }

    /* Bir sayfa bile düştüyse numaralandırma YAPILMAZ: eksik listeye baştan
       0,10,20… yazmak, alınamayan ürünlerin sırasını topluca bozardı. */
    if (sirali.eksik) {
      bildir('Sıra numaraları hazırlanamadı: ürün listesi eksik geldi (' +
             sirali.veri.length + ' / ' + (sirali.toplam || '?') + ').\n' +
             (sirali.hata || '') +
             '\n\nEksik liste üzerinde numaralandırma yapılsaydı, alınamayan\n' +
             'ürünlerin sırası bozulurdu. Lütfen tekrar deneyin.', 'hata');
      return false;
    }

    const items = [];

    sirali.veri.forEach(function (u, i) {
      const hedef = i * SIRA_ADIM;
      if (Number(u.menu_order) !== hedef) items.push({ id: Number(u.id), menu_order: hedef });
    });

    if (items.length) {
      const basarisiz = await siraTopluYaz(items);

      if (basarisiz === null) return false;   // Hata zaten bildirildi

      if (basarisiz.length) {
        bildir(basarisiz.length + ' ürünün sıra numarası yazılamadı.\n' +
               'Bu ürünlerin sırası şimdilik eski değeriyle kaldı.', 'uyari');
      }
    }

    /* Yeni değerlerle tazele: bundan sonraki taşımalar tek ürün günceller. */
    await urunleriYukle(ekAramaMetni());
    return true;
  }

  /* ---------- CANLI (eklenti yok) — hafızadaki tam liste ----------
     durum.urunler artık sayfa sayfa çekilen TAM listedir (bkz. renderer.js >
     tumSayfalariGetir) ve siralamaGuvenliMi() liste eksikken buraya hiç
     gelinmesine izin vermez. */
  const ciftler = (d.urunler || []).map(function (u, i) {
    return { oge: u, deger: i * SIRA_ADIM };
  });

  siraDegisimleriniKuyrukla(siraYaz(ciftler));

  bildir('B2B Core eklentisi bulunamadı; sıra numaraları WooCommerce ucundan\n' +
         (d.urunler || []).length + ' ürün için tek tek yazılacak.\nBu işlem biraz sürebilir.', 'bilgi');
  return true;
}

/**
 * Sıra numaralarını /products/reorder ucuna PARÇA PARÇA yazar.
 *
 * Uç tek istekte en fazla 500 ürün kabul eder (B2B_REST_Extra::REORDER_LIMIT);
 * ayrıca 900+ ürünlük tek bir istek paylaşımlı hostinglerde zaman aşımına
 * uğrar. Bu yüzden istek parçalara bölünür.
 *
 * @param {Array} items [{ id, menu_order }]
 * @returns {Promise<Array|null>} Yazılamayan ID'ler; istek tamamen çökerse null.
 */
async function siraTopluYaz(items) {
  const basarisiz = [];

  for (let i = 0; i < items.length; i += SIRA_YAZMA_PARCASI) {
    const parca = items.slice(i, i + SIRA_YAZMA_PARCASI);

    const yazma = await b2b('products/reorder', {
      metod: 'POST',
      govde: { items: parca },
      sureAsimi: 90000
    });

    if (!yazma || !yazma.ok) {
      bildir('Sıra numaraları hazırlanamadı:\n' + ekHataMetni(yazma) +
             '\n\n(' + (i + parca.length) + ' / ' + items.length + ' ürüne kadar işlendi.)', 'hata');
      return null;
    }

    const veri = yazma.veri || {};
    if (veri.failed && veri.failed.length) basarisiz.push.apply(basarisiz, veri.failed);
  }

  return basarisiz;
}

/**
 * Taşınan satırı, listeyi baştan çizmeden DOM içinde yerine taşır.
 *
 * 900+ ürünlü listede her taşımada bütün kartları yeniden üretmek (innerHTML)
 * arayüzü saniyelerce kilitliyordu. Burada yalnızca TEK düğüm yer değiştirir;
 * odak da doğal olarak taşınan satırda kalır.
 *
 * @param {string|number} id Taşınan ürünün ID'si.
 * @returns {boolean} Taşınabildiyse true; false ise çağıran tam çizim yapmalıdır.
 */
function urunSatiriniDomdaTasi(id) {
  const kap = $('#urunListesi');
  const d = ekDurum();

  if (!kap || !d || !d.urunler || !d.urunler.length) return false;

  /* Ekrandaki liste ile hafızadaki liste birebir aynı değilse (süzgeç açık,
     liste yeni yüklenmiş vb.) düğüm taşımak yanıltıcı olur. */
  const satirlar = kap.querySelectorAll('[data-urun]');
  if (satirlar.length !== d.urunler.length) return false;

  const satir = kap.querySelector('[data-urun="' + String(id).replace(/["\\]/g, '') + '"]');
  if (!satir) return false;

  const indeks = ekUrunIndeksi(d.urunler, id);
  if (indeks === -1) return false;

  const sonraki = d.urunler[indeks + 1];
  const onceki = d.urunler[indeks - 1];

  if (sonraki) {
    const sonrakiDugum = kap.querySelector('[data-urun="' + String(sonraki.id).replace(/["\\]/g, '') + '"]');
    if (!sonrakiDugum) return false;
    kap.insertBefore(satir, sonrakiDugum);
    return true;
  }

  if (onceki) {
    const oncekiDugum = kap.querySelector('[data-urun="' + String(onceki.id).replace(/["\\]/g, '') + '"]');
    if (!oncekiDugum) return false;
    kap.insertBefore(satir, oncekiDugum.nextSibling);
    return true;
  }

  kap.insertBefore(satir, kap.firstChild);
  return true;
}

/** Ürünü listede taşır. Başarılıysa true döner. */
function urunuSirayaTasi(kaynakId, hedefId, oncesineMi) {
  const d = ekDurum();
  if (!d || !d.urunler) return false;

  const liste = d.urunler;
  const kaynakIndeks = ekUrunIndeksi(liste, kaynakId);
  if (kaynakIndeks === -1) return false;

  const oge = liste.splice(kaynakIndeks, 1)[0];

  const hedefIndeks = ekUrunIndeksi(liste, hedefId);
  if (hedefIndeks === -1) {
    liste.splice(kaynakIndeks, 0, oge);   // Geri koy
    return false;
  }

  const yeniIndeks = oncesineMi ? hedefIndeks : hedefIndeks + 1;
  liste.splice(yeniIndeks, 0, oge);

  siraDegisimleriniKuyrukla(siraDegisiminiHesapla(liste, yeniIndeks));
  return true;
}

/**
 * Sürükle-bırak sonucunu uygular.
 * Gerekiyorsa önce sıra numarası tabanını hazırlar (bir kereliktir).
 */
async function urunTasimasiniUygula(kaynakId, hedefId, oncesineMi) {
  const d = ekDurum();
  if (!d || !d.urunler) return;

  if (siraTabaniYetersizMi(d.urunler)) {
    const hazir = await siraTabaniniHazirla();
    if (!hazir) return;
  }

  /* Taban hazırlığı listeyi tazelemiş olabilir; ürünler ID ile yeniden bulunur. */
  if (!urunuSirayaTasi(kaynakId, hedefId, oncesineMi)) return;

  /* Önce tek düğümü taşımayı dene; olmazsa listeyi baştan çiz. */
  if (!urunSatiriniDomdaTasi(kaynakId)) {
    urunleriCiz(ekDemoMu() ? ekAramaMetni() : '');
  }

  siralamayiGonder();
}

/** Ürünü klavyeyle bir sıra yukarı (yon = -1) / aşağı (yon = +1) taşır. */
async function urunuKomsuylaTasi(id, yon) {
  const d = ekDurum();
  if (!d || !d.urunler || !d.urunler.length) return;

  /* Liste ucundaysa hiçbir şey yapma (boş yere taban hazırlığı başlatma). */
  const simdikiIlk = ekUrunIndeksi(d.urunler, id);
  if (simdikiIlk === -1) return;
  if (simdikiIlk + yon < 0 || simdikiIlk + yon >= d.urunler.length) return;

  if (siraTabaniYetersizMi(d.urunler)) {
    const hazir = await siraTabaniniHazirla();
    if (!hazir) return;
  }

  const simdiki = ekUrunIndeksi(d.urunler, id);
  if (simdiki === -1) return;

  const yeni = simdiki + yon;
  if (yeni < 0 || yeni >= d.urunler.length) return;

  const oge = d.urunler.splice(simdiki, 1)[0];
  d.urunler.splice(yeni, 0, oge);

  /* Sürükle-bırak ile aynı hesap: yalnızca yeri değişen ürün güncellenir. */
  siraDegisimleriniKuyrukla(siraDegisiminiHesapla(d.urunler, yeni));

  siralamayiCizVeOdakla(id);
  siralamayiGonder();
}

/** Listeyi tazeler ve taşınan ürünün tutamağına odağı geri verir. */
function siralamayiCizVeOdakla(odakId) {
  /* Tek düğüm taşınabildiyse odak zaten taşınan satırda kalır: klavyeyle
     art arda taşımada (Alt + ↑/↓) odak kaybı ve yeniden çizim yaşanmaz. */
  if (odakId && urunSatiriniDomdaTasi(odakId)) {
    const satir = document.querySelector('[data-urun="' + String(odakId).replace(/["\\]/g, '') + '"]');
    if (satir && satir.scrollIntoView) satir.scrollIntoView({ block: 'nearest' });
    return;
  }

  urunleriCiz(ekDemoMu() ? ekAramaMetni() : '');

  if (!odakId) return;

  const tutamak = document.querySelector('[data-urun="' + odakId + '"] [data-tut]');
  if (tutamak && tutamak.focus) tutamak.focus();
}

/** Bildirim metni: "1 ürün" durumunu ayrıca vurgular. */
function siraAdetYazi(adet) {
  return (adet === 1)
    ? 'Yalnızca taşınan ürünün sırası güncellendi.'
    : adet + ' ürünün sırası güncellendi.';
}

/** Demo verisine yeni sıra değerlerini yazar ve kaynağı yeniden sıralar. */
function demoSiralamasiniYaz(liste) {
  if (typeof DEMO_URUNLER === 'undefined') return;

  const yeni = {};
  liste.forEach(function (k) { yeni[String(k.id)] = k.menu_order; });

  DEMO_URUNLER.forEach(function (u) {
    if (yeni[String(u.id)] !== undefined) u.menuSira = yeni[String(u.id)];
  });

  DEMO_URUNLER.sort(function (a, b) { return siraDegeri(a) - siraDegeri(b); });
}

/**
 * B2B Core eklentisi yokken sıralamayı WooCommerce çekirdek ucundan yazar.
 * Yalnızca değişen ürünler gönderildiği için bu çoğu zaman TEK istektir.
 *
 * @returns {Array} Güncellenemeyen ürün ID'leri.
 */
async function siraWooIleGonder(liste) {
  const basarisiz = [];

  for (let i = 0; i < liste.length; i++) {
    const cevap = await woo('products/' + liste[i].id, {
      metod: 'PUT',
      govde: { menu_order: liste[i].menu_order },
      sureAsimi: 25000
    });

    if (!cevap || !cevap.ok) basarisiz.push(liste[i].id);
  }

  return basarisiz;
}

/** Gönderim başarısızsa ekranı sitedeki gerçek sıraya döndürür. */
async function siraGonderimiBasarisiz(cevap) {
  bildir('Sıralama kaydedilemedi:\n' + ekHataMetni(cevap) +
         '\n\nEkrandaki sıra sitedeki gerçek sıraya geri alınıyor…', 'hata');

  /* İyimser güncellemeyi geri al: sunucudaki gerçek sırayı yeniden yükle. */
  await urunleriYukle(ekAramaMetni());
}

/**
 * Bekleyen sıra değişikliklerini siteye gönderir.
 *
 * Gövdede TÜM liste değil, yalnızca menu_order değeri gerçekten değişen
 * ürünler bulunur (bkz. siraDegisiminiHesapla).
 *
 * @param {boolean} hemenMi True ise beklemeden gönderir (iç kullanım).
 */
async function siralamayiGonder(hemenMi) {
  const d = ekDurum();
  if (!d) return;

  /* --- 600 ms gecikme: art arda taşımalarda tek istek atılsın --- */
  if (!hemenMi || d.siralamaGonderiliyor) {
    if (d.siralamaZamani) clearTimeout(d.siralamaZamani);
    d.siralamaZamani = setTimeout(function () {
      d.siralamaZamani = null;
      siralamayiGonder(true);
    }, 600);
    return;
  }

  const bekleyen = d.siraBekleyen || {};
  const liste = Object.keys(bekleyen).map(function (id) {
    return { id: Number(id), menu_order: Number(bekleyen[id]) };
  });

  if (!liste.length) {
    d.siralamaDegisti = false;
    return;
  }

  /* Kuyruk şimdi boşaltılır: gönderim sürerken yapılan yeni taşımalar
     bir sonraki gönderime kalsın, bu isteğe karışmasın. */
  d.siraBekleyen = {};
  d.siralamaGonderiliyor = true;

  try {
    /* ---------- DEMO ---------- */
    if (ekDemoMu()) {
      await bekle(250);
      demoSiralamasiniYaz(liste);

      d.siralamaDegisti = false;
      bildir('Yeni sıralama kaydedildi.\n' + siraAdetYazi(liste.length) +
             '\n(Demo Modu — sitenizde değişiklik yapılmadı)', 'basari');
      return;
    }

    /* ---------- CANLI ---------- */
    let basarisiz = [];

    if (ekEklentiVarMi()) {
      /* Uç tek istekte en fazla 500 ürün kabul eder. Tek taşımada kuyrukta
         genellikle 1 ürün olur; yine de büyük kuyruklar parçalara bölünür. */
      for (let i = 0; i < liste.length; i += SIRA_YAZMA_PARCASI) {
        const cevap = await b2b('products/reorder', {
          metod: 'POST',
          govde: { items: liste.slice(i, i + SIRA_YAZMA_PARCASI) },
          sureAsimi: 45000
        });

        if (!cevap || !cevap.ok) {
          await siraGonderimiBasarisiz(cevap);
          return;
        }

        const veri = cevap.veri || {};
        if (veri.failed && veri.failed.length) basarisiz.push.apply(basarisiz, veri.failed);
      }
    } else {
      basarisiz = await siraWooIleGonder(liste);

      /* Hiçbiri yazılamadıysa iyimser güncellemeyi geri al. */
      if (basarisiz.length === liste.length) {
        await siraGonderimiBasarisiz({
          hata: 'WooCommerce ürün güncelleme ucu yanıt vermedi.\n' +
                'API anahtarınızın "Okuma/Yazma" izni olduğundan emin olun.'
        });
        return;
      }
    }

    d.siralamaDegisti = false;

    bildir('Yeni sıralama siteye gönderildi.\n' +
           siraAdetYazi(liste.length - basarisiz.length) +
           (basarisiz.length ? '\n' + basarisiz.length + ' ürün güncellenemedi.' : ''), 'basari');
  } catch (e) {
    bildir('Sıralama kaydedilirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    d.siralamaGonderiliyor = false;
  }
}

/** #urunListesi üzerinde delege sürükle-bırak dinleyicilerini kurar. */
function urunSiralamasiniBagla() {
  const kap = $('#urunListesi');
  if (!kap) return;

  /* Liste innerHTML ile yeniden çizilse de kap aynı kalır — bir kez bağla. */
  if (kap.dataset.siralamaBagli === '1') return;
  kap.dataset.siralamaBagli = '1';

  /* --- Sürükleme yalnızca ⋮⋮ tutamağından başlar --- */
  function tutamaktanBaslat(o) {
    const tutamak = ekEnYakin(o.target, '[data-tut]');
    if (!tutamak) return;

    const satir = tutamak.closest('[data-urun]');
    if (satir) satir.setAttribute('draggable', 'true');
  }

  kap.addEventListener('mousedown', tutamaktanBaslat);
  kap.addEventListener('touchstart', tutamaktanBaslat, { passive: true });

  /* Sürükleme başlamadan bırakılırsa satırı yeniden kilitle */
  document.addEventListener('mouseup', function () {
    const d = ekDurum();
    if (d && d.suruklenenUrun) return;   // Gerçek sürükleme sürüyor
    Array.prototype.slice.call(kap.querySelectorAll('[data-urun][draggable="true"]'))
      .forEach(function (satir) { satir.setAttribute('draggable', 'false'); });
  });

  kap.addEventListener('dragstart', function (o) {
    const satir = ekEnYakin(o.target, '[data-urun]');
    if (!satir || satir.getAttribute('draggable') !== 'true') {
      if (o.preventDefault) o.preventDefault();
      return;
    }

    const d = ekDurum();
    if (d) d.suruklenenUrun = satir.dataset.urun;

    if (o.dataTransfer) {
      o.dataTransfer.effectAllowed = 'move';
      try {
        o.dataTransfer.setData('text/plain', String(satir.dataset.urun));
      } catch (e) { /* bazı ortamlar setData'yı kısıtlar — sorun değil */ }
    }

    satir.classList.add('opacity-40');
  });

  /* Aynı satır/konum için göstergeyi boş yere yeniden çizmemek adına son durumu tut */
  let sonGostergeSatiri = null;
  let sonGostergeKonumu = '';

  kap.addEventListener('dragover', function (o) {
    const d = ekDurum();
    if (!d || !d.suruklenenUrun) return;

    o.preventDefault();
    if (o.dataTransfer) o.dataTransfer.dropEffect = 'move';

    const satir = ekEnYakin(o.target, '[data-urun]');

    if (!satir || String(satir.dataset.urun) === String(d.suruklenenUrun)) {
      if (sonGostergeSatiri) {
        siraGostergeleriniTemizle();
        sonGostergeSatiri = null;
        sonGostergeKonumu = '';
      }
      return;
    }

    const kutu = satir.getBoundingClientRect();
    const konum = (o.clientY < kutu.top + (kutu.height / 2)) ? 'once' : 'sonra';

    if (satir === sonGostergeSatiri && konum === sonGostergeKonumu) return;

    siraGostergeleriniTemizle();
    satir.classList.add('border-marka-600', konum === 'once' ? 'border-t-4' : 'border-b-4');

    sonGostergeSatiri = satir;
    sonGostergeKonumu = konum;
  });

  kap.addEventListener('dragleave', function (o) {
    const satir = ekEnYakin(o.target, '[data-urun]');
    if (!satir) return;

    satir.classList.remove.apply(satir.classList, SIRA_GOSTERGE_SINIFLARI);

    if (satir === sonGostergeSatiri) {
      sonGostergeSatiri = null;
      sonGostergeKonumu = '';
    }
  });

  kap.addEventListener('drop', function (o) {
    o.preventDefault();

    sonGostergeSatiri = null;
    sonGostergeKonumu = '';

    const d = ekDurum();
    const satir = ekEnYakin(o.target, '[data-urun]');

    let kaynakId = d ? d.suruklenenUrun : null;
    if (!kaynakId && o.dataTransfer) {
      try { kaynakId = o.dataTransfer.getData('text/plain'); } catch (e) { kaynakId = null; }
    }

    siraGostergeleriniTemizle();

    if (!d || !kaynakId || !satir) { siraSuruklemeyiBitir(); return; }

    const hedefId = satir.dataset.urun;
    if (String(hedefId) === String(kaynakId)) { siraSuruklemeyiBitir(); return; }

    if (!siralamaGuvenliMi()) { siraSuruklemeyiBitir(); return; }

    const kutu = satir.getBoundingClientRect();
    const oncesineMi = (o.clientY < kutu.top + (kutu.height / 2));

    siraSuruklemeyiBitir();

    /* Taşıma async: gerekiyorsa önce sıra numarası tabanı hazırlanır. */
    urunTasimasiniUygula(kaynakId, hedefId, oncesineMi);
  });

  kap.addEventListener('dragend', function () {
    sonGostergeSatiri = null;
    sonGostergeKonumu = '';
    siraSuruklemeyiBitir();
  });

  /* --- Klavye ile taşıma: tutamak odaklıyken Alt + ↑ / ↓ --- */
  kap.addEventListener('keydown', function (o) {
    if (!o.altKey) return;
    if (o.key !== 'ArrowUp' && o.key !== 'ArrowDown') return;

    const tutamak = ekEnYakin(o.target, '[data-tut]');
    if (!tutamak) return;

    const satir = tutamak.closest('[data-urun]');
    if (!satir) return;

    const d = ekDurum();
    if (!d || !d.urunler || !d.urunler.length) return;

    o.preventDefault();

    if (!siralamaGuvenliMi()) return;

    urunuKomsuylaTasi(satir.dataset.urun, (o.key === 'ArrowUp') ? -1 : 1);
  });
}

/* ==========================================================================
 *  BÖLÜM E — ÜRÜN SİLME
 *  ---------------------------------------------------------------------------
 *  Ürün hem sitedeki WooCommerce veritabanından hem de masaüstündeki yerel
 *  listeden kaldırılır. Silme kalıcıdır (force=true): WooCommerce'in varsayılan
 *  davranışı ürünü çöp kutusuna atmaktır, kullanıcı ise "tamamen silinsin"
 *  beklediği için çöp kutusu adımı atlanır.
 * ========================================================================*/

async function urunSil(id, buton) {
  const d = ekDurum();
  if (!d) return;

  const urun = (d.urunler || []).filter(function (u) { return String(u.id) === String(id); })[0];
  if (!urun) return;

  const eminMi = await onayla(
    'Ürünü Sil',
    'Bu ürünü silmek istediğinize emin misiniz?\n\n' +
    '"' + urun.ad + '"  ·  Stok Kodu: ' + urun.kod + '\n\n' +
    (ekDemoMu()
      ? '(Demo Modu: ürün yalnızca bu ekrandan kaldırılır, sitenizde hiçbir şey silinmez.)'
      : 'Ürün sitenizden ve bu listeden KALICI olarak silinecek; bu işlem geri alınamaz.\n' +
        'Ürünü kaydını kaybetmeden gizlemek isterseniz "GİZLİ" düğmesini kullanabilirsiniz.'),
    'EVET, SİL',
    true
  );
  if (!eminMi) return;

  const geriAl = butonuMesgulEt(buton, 'SİLİNİYOR…');

  try {
    if (ekDemoMu()) {
      await bekle(280);

      if (typeof DEMO_URUNLER !== 'undefined') {
        const yer = ekUrunIndeksi(DEMO_URUNLER, id);
        if (yer !== -1) DEMO_URUNLER.splice(yer, 1);
      }
    } else {
      /* Silme WooCommerce çekirdek ucundan yapılır; b2b-core'da silme ucu yok. */
      const cevap = await woo('products/' + id, {
        metod: 'DELETE',
        sorgu: { force: true },
        sureAsimi: 45000
      });

      if (!cevap || !cevap.ok) {
        bildir('Ürün silinemedi:\n' + ekHataMetni(cevap), 'hata');
        return;
      }
    }

    /* Yerel veri: liste + bekleyen sıra kuyruğu birlikte temizlenir. */
    d.urunler = (d.urunler || []).filter(function (u) { return String(u.id) !== String(id); });
    if (d.siraBekleyen) delete d.siraBekleyen[String(id)];

    urunleriCiz(ekDemoMu() ? ekAramaMetni() : '');

    bildir('Ürün silindi.\n' + urun.ad +
           (ekDemoMu()
             ? '\n(Demo Modu — sitenizde değişiklik yapılmadı)'
             : '\nSitenizden de tamamen kaldırıldı.'), 'basari');
  } catch (e) {
    bildir('Ürün silinirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    geriAl();
  }
}

/* ==========================================================================
 *  BÖLÜM F — SİPARİŞ İPTALİ (GEREKÇELİ)
 *  ---------------------------------------------------------------------------
 *  Sipariş SİLİNMEZ; durumu "cancelled" (Sipariş İptal Edildi) yapılır.
 *  Sebep: siparişin veritabanından silinmesi muhasebe/stok geçmişini de
 *  yok eder ve müşteri "Hesabım > Siparişler" sayfasında siparişin ne
 *  olduğunu göremez. İptal durumunda ise müşteri "Sipariş İptal Edildi"
 *  yazısını görür ve WooCommerce stokları geri yükler.
 *
 *  GEREKÇE ZORUNLUDUR. Depo ile muhasebe arasındaki en sık anlaşmazlık
 *  "bu sipariş neden iptal olmuş?" sorusudur; gerekçesiz iptal, aylar sonra
 *  kimsenin cevaplayamadığı bir boşluk bırakır. Girilen metin siparişe NOT
 *  olarak işlenir, sonra durum değiştirilir — sıra önemlidir: durum önce
 *  değiştirilip not sonra düşseydi, not isteği hata verdiğinde sipariş
 *  gerekçesiz iptal edilmiş olarak kalırdı.
 * ========================================================================*/

/**
 * Hazır iptal gerekçeleri.
 *
 * Depocu/kasiyer klavyeye hiç dokunmadan en sık üç dört sebebi seçebilsin
 * diye buradalar; hepsi seçildikten sonra da düzenlenebilir (metin kutusuna
 * yazılır, kilitlenmez).
 */
const IPTAL_SEBEPLERI = [
  'Minimum sepet tutarı karşılanmadı',
  'Stok tükendi',
  'Müşteri vazgeçti',
  'Ödeme alınamadı / provizyon geçmedi',
  'Yanlış / mükerrer sipariş',
  'Teslimat bölgesi dışında',
  'Fiyat hatası'
];

/** Hazır gerekçe düğmelerini çizer. */
function iptalSebepleriCiz() {
  const kap = $('#iptalSebepleri');
  if (!kap) return;

  kap.innerHTML = IPTAL_SEBEPLERI.map(function (sebep) {
    return '<button type="button" data-iptal-sebep="' + kacis(sebep) + '" ' +
      'class="h-12 px-4 rounded-xl border-2 border-slate-300 dark:border-slate-600 ' +
             'bg-slate-50 hover:bg-marka-50 hover:border-marka-400 ' +
             'dark:bg-slate-900 dark:hover:bg-slate-700 ' +
             'text-base font-bold transition active:scale-95">' +
      kacis(sebep) + '</button>';
  }).join('');
}

/** İptal penceresindeki uyarı kutusu. */
function iptalUyar(mesaj) {
  const kutu = $('#iptalUyari');
  if (!kutu) return;

  if (!mesaj) { kutu.classList.add('hidden'); kutu.textContent = ''; return; }
  kutu.textContent = mesaj;
  kutu.classList.remove('hidden');
}

function iptalModaliKapat() {
  const katman = $('#iptalModalKatman');
  if (katman) katman.classList.add('hidden');
  iptalUyar('');
}

/**
 * İptal gerekçesi penceresini açar.
 *
 * @param {object} s Sipariş.
 * @returns {Promise<{sebep: string, bildir: boolean}|null>} Vazgeçilirse null.
 */
function iptalSebebiSor(s) {
  const katman = $('#iptalModalKatman');
  const metin = $('#iptalSebepMetni');
  const onayBtn = $('#iptalOnay');
  const vazgecBtn = $('#iptalVazgec');
  const kapatBtn = $('#iptalModalKapat');
  const sebepKap = $('#iptalSebepleri');
  const bildirKutu = $('#iptalBildir');
  const aciklama = $('#iptalModalAciklama');

  /* Pencere index.html'de yoksa (ör. eski bir sürümün arayüzü) eski basit
     onay akışına düşülür; özellik kaybolur ama iptal yine de yapılabilir. */
  if (!katman || !metin || !onayBtn || !vazgecBtn) {
    return onayla(
      'Siparişi İptal Et',
      'Bu siparişi iptal etmek istediğinize emin misiniz?',
      'EVET, İPTAL ET',
      true
    ).then(function (evet) {
      return evet ? { sebep: 'Sipariş masaüstü yönetim panelinden iptal edildi.', bildir: true } : null;
    });
  }

  const d = ekDurum();

  iptalSebepleriCiz();
  iptalUyar('');
  metin.value = '';

  if (aciklama) {
    aciklama.textContent = '#' + s.numara + '  ·  ' + (s.firma || s.musteri) + '  ·  ' + para(s.tutar);
  }
  if (bildirKutu) {
    bildirKutu.checked = !(d && d.ayarlar && d.ayarlar.durumEpostasi === false);
  }

  katman.classList.remove('hidden');
  setTimeout(function () { metin.focus(); }, 40);

  return new Promise(function (cozumle) {
    const bitir = function (sonuc) {
      onayBtn.removeEventListener('click', tamam);
      vazgecBtn.removeEventListener('click', vazgec);
      if (kapatBtn) kapatBtn.removeEventListener('click', vazgec);
      if (sebepKap) sebepKap.removeEventListener('click', sebepSec);
      katman.removeEventListener('mousedown', disaTikla);
      katman.removeEventListener('keydown', tusla);
      iptalModaliKapat();
      cozumle(sonuc);
    };

    function sebepSec(o) {
      const btn = ekEnYakin(o.target, '[data-iptal-sebep]');
      if (!btn) return;

      /* Seçim metin kutusuna YAZILIR, doğrudan gönderilmez: kullanıcı
         "Stok tükendi — 3 kalem eksik" gibi ekleme yapabilsin. */
      metin.value = btn.dataset.iptalSebep;
      iptalUyar('');
      metin.focus();
      /* İmleç metnin sonuna gitsin ki yazmaya devam edilebilsin. */
      const son = metin.value.length;
      if (metin.setSelectionRange) metin.setSelectionRange(son, son);
    }

    function tamam() {
      const sebep = String(metin.value || '').trim();

      if (!sebep) {
        iptalUyar('İptal gerekçesi zorunludur.\nYukarıdaki hazır seçeneklerden birine basabilir ' +
                  'veya kendi gerekçenizi yazabilirsiniz.');
        metin.focus();
        return;
      }

      bitir({ sebep: sebep, bildir: !!(bildirKutu && bildirKutu.checked) });
    }

    function vazgec() { bitir(null); }

    function disaTikla(o) { if (o.target === katman) bitir(null); }

    function tusla(o) {
      if (o.key === 'Escape') { bitir(null); return; }
      /* Ctrl+Enter ile onayla: gerekçe çok satırlı olabilir, düz Enter
         satır atlamalı. */
      if (o.key === 'Enter' && (o.ctrlKey || o.metaKey)) { o.preventDefault(); tamam(); }
    }

    onayBtn.addEventListener('click', tamam);
    vazgecBtn.addEventListener('click', vazgec);
    if (kapatBtn) kapatBtn.addEventListener('click', vazgec);
    if (sebepKap) sebepKap.addEventListener('click', sebepSec);
    katman.addEventListener('mousedown', disaTikla);
    katman.addEventListener('keydown', tusla);
  });
}

async function siparisIptalEt(id, buton) {
  const d = ekDurum();
  if (!d) return;

  const s = (d.siparisler || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (!s) return;

  if (String(s.durum) === 'cancelled') {
    bildir('Bu sipariş zaten iptal edilmiş.', 'bilgi');
    return;
  }

  const karar = await iptalSebebiSor(s);
  if (!karar) return;

  const sebep = karar.sebep;
  const bilgilendir = !!karar.bildir;

  /* Sipariş notuna hem gerekçe hem kaynağı yazılır: aylar sonra nota bakan
     kişi bunun panelden mi yoksa site üzerinden mi yapıldığını görebilsin. */
  const notMetni = 'İPTAL GEREKÇESİ: ' + sebep + '\n(Masaüstü yönetim panelinden iptal edildi.)';

  const geriAl = butonuMesgulEt(buton, 'İPTAL EDİLİYOR…');

  try {
    /* ---------- DEMO ---------- */
    if (ekDemoMu()) {
      await bekle(300);

      if (typeof DEMO_SIPARISLER !== 'undefined') {
        const kaynak = DEMO_SIPARISLER.filter(function (x) { return String(x.id) === String(id); })[0];
        if (kaynak) {
          kaynak.durum = 'cancelled';
          kaynak.notlar = notMetni;
        }
      }

      s.durum = 'cancelled';
      s.durumEtiketi = '';
      s.notlar = notMetni;

    /* ---------- CANLI (b2b-core) ---------- */
    } else if (ekEklentiVarMi()) {
      const cevap = await b2b('orders/' + id + '/status', {
        metod: 'POST',
        govde: {
          status: 'cancelled',
          note: notMetni,
          notify: bilgilendir
        },
        sureAsimi: 45000
      });

      if (!cevap || !cevap.ok) {
        bildir('Sipariş iptal edilemedi:\n' + ekHataMetni(cevap), 'hata');
        return;
      }

      /* Yanıttan güncel siparişi al; yoksa yerelde işaretle. */
      if (cevap.veri && cevap.veri.order && typeof b2bSiparisNormalle === 'function') {
        const guncel = b2bSiparisNormalle(cevap.veri.order);
        const yer = d.siparisler.indexOf(s);
        if (yer !== -1) d.siparisler[yer] = guncel;
      } else {
        s.durum = 'cancelled';
        s.durumEtiketi = '';
        s.notlar = notMetni;
      }

    /* ---------- CANLI (eklenti yok) ---------- */
    } else {
      /* Gerekçe ÖNCE not olarak düşer: durum değişip not isteği hata verirse
         sipariş gerekçesiz iptal edilmiş olarak kalırdı. */
      const notCevap = await woo('orders/' + id + '/notes', {
        metod: 'POST',
        govde: { note: notMetni, customer_note: bilgilendir },
        sureAsimi: 45000
      });

      if (!notCevap || !notCevap.ok) {
        bildir('İptal gerekçesi siparişe yazılamadı, iptal YAPILMADI:\n' +
               ekHataMetni(notCevap), 'hata');
        return;
      }

      const cevap = await woo('orders/' + id, {
        metod: 'PUT',
        govde: { status: 'cancelled' },
        sureAsimi: 45000
      });

      if (!cevap || !cevap.ok) {
        bildir('Sipariş iptal edilemedi:\n' + ekHataMetni(cevap) +
               '\n\nNot: iptal gerekçesi siparişe zaten yazıldı.', 'hata');
        return;
      }

      s.durum = 'cancelled';
      s.durumEtiketi = '';
      s.notlar = notMetni;
    }

    /* Durum süzgeci açıksa iptal edilen sipariş artık o süzgece uymaz. */
    if (d.siparisSuzgec && d.siparisSuzgec !== 'cancelled') {
      d.siparisler = d.siparisler.filter(function (x) { return String(x.id) !== String(id); });
    }

    siparisleriCiz();

    bildir('#' + s.numara + ' iptal edildi.\nGerekçe: ' + sebep +
           (ekDemoMu()
             ? '\n(Demo Modu — sitenizde değişiklik yapılmadı)'
             : '\nGerekçe sipariş notuna işlendi.' +
               (bilgilendir ? '\nMüşteriye bilgilendirme gönderildi.' : '')), 'basari');
  } catch (e) {
    bildir('Sipariş iptal edilirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    geriAl();
  }
}
/* ==========================================================================
 *  BÖLÜM F2 — SİPARİŞ KALICI SİLME
 *  ---------------------------------------------------------------------------
 *  Düğme (renderer.js) yalnızca "İptal Edilenler" sekmesindeki siparişlerde
 *  görünür. Sipariş, ürün silmeyle aynı desende (bkz. urunSil) WooCommerce
 *  çekirdek ucundan force=true ile silinir — b2b-core'da ayrı bir sipariş
 *  silme ucu yok. Çöp kutusuna düşmez, doğrudan veritabanından kalkar; bu
 *  yüzden geri alınamaz ve iptalden ayrı, koyu kırmızı bir düğmedir.
 * ========================================================================*/

async function siparisSil(id, buton) {
  const d = ekDurum();
  if (!d) return;

  const s = (d.siparisler || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (!s) return;

  if (typeof durumNormalle === 'function' && durumNormalle(s.durum) !== 'cancelled') {
    bildir('Yalnızca iptal edilmiş siparişler kalıcı olarak silinebilir.', 'uyari');
    return;
  }

  const eminMi = await onayla(
    'Siparişi Kalıcı Sil',
    'Bu siparişi sitenizden KALICI olarak silmek istediğinize emin misiniz?\n\n' +
    '#' + s.numara + '  ·  ' + (s.firma || s.musteri) + '  ·  ' + para(s.tutar) + '\n\n' +
    (ekDemoMu()
      ? '(Demo Modu: sipariş yalnızca bu ekrandan kaldırılır, sitenizde hiçbir şey silinmez.)'
      : 'Sipariş sitenizin veritabanından TAMAMEN silinecek, çöp kutusuna bile\n' +
        'düşmeyecek.\nBu işlem GERİ ALINAMAZ.'),
    'EVET, KALICI SİL',
    true
  );
  if (!eminMi) return;

  const geriAl = butonuMesgulEt(buton, 'SİLİNİYOR…');

  try {
    if (ekDemoMu()) {
      await bekle(280);

      if (typeof DEMO_SIPARISLER !== 'undefined') {
        const yer = ekUrunIndeksi(DEMO_SIPARISLER, id);
        if (yer !== -1) DEMO_SIPARISLER.splice(yer, 1);
      }
    } else {
      /* Silme WooCommerce çekirdek ucundan yapılır; b2b-core'da silme ucu yok
         (bkz. urunSil). */
      const cevap = await woo('orders/' + id, {
        metod: 'DELETE',
        sorgu: { force: true },
        sureAsimi: 45000
      });

      if (!cevap || !cevap.ok) {
        bildir('Sipariş silinemedi:\n' + ekHataMetni(cevap), 'hata');
        return;
      }
    }

    /* Yerel liste + görünen toplam sayaç birlikte güncellenir. */
    d.siparisler = (d.siparisler || []).filter(function (x) { return String(x.id) !== String(id); });
    if (d.siparislerToplam > 0) d.siparislerToplam -= 1;

    if (typeof siparisleriCiz === 'function') siparisleriCiz();
    if (typeof siparisSekmeleriCiz === 'function') siparisSekmeleriCiz();

    bildir('Sipariş kalıcı olarak silindi.\n#' + s.numara +
           (ekDemoMu()
             ? '\n(Demo Modu — sitenizde değişiklik yapılmadı)'
             : '\nSitenizden de tamamen kaldırıldı.'), 'basari');
  } catch (e) {
    bildir('Sipariş silinirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    geriAl();
  }
}

/* ==========================================================================
 *  BÖLÜM G — BAYİ (MÜŞTERİ) KALICI SİLME
 *  ---------------------------------------------------------------------------
 *  Bayi kartındaki durumdan (bekliyor/onaylı/reddedilmiş/askıda) bağımsız
 *  olarak her zaman görünür: müşteri hesabı WooCommerce çekirdek ucundan
 *  (wc/v3/customers, force=true) sitenizden TAMAMEN silinir. b2b-core'da ayrı
 *  bir bayi silme ucu yok — /wc-b2b/v1/dealers/{id} yalnızca GET/POST/PUT
 *  destekler (bkz. b2b-core docs/electron-api.md § 2.2).
 * ========================================================================*/

async function uyeSil(id, buton) {
  const d = ekDurum();
  if (!d) return;

  const u = (d.uyeler || []).filter(function (x) { return String(x.id) === String(id); })[0] ||
            (d.acikBayi && String(d.acikBayi.id) === String(id) ? d.acikBayi : null);
  if (!u) return;

  const eminMi = await onayla(
    'Müşteriyi Kalıcı Sil',
    'Bu müşteriyi/bayiyi sitenizden KALICI olarak silmek istediğinize emin misiniz?\n\n' +
    (u.firma || u.ad) + (u.eposta ? '  ·  ' + u.eposta : '') + '\n\n' +
    (ekDemoMu()
      ? '(Demo Modu: kayıt yalnızca bu ekrandan kaldırılır, sitenizde hiçbir şey silinmez.)'
      : 'Müşteri hesabı sitenizin veritabanından TAMAMEN silinecek.\n' +
        'Geçmiş siparişleri etkilemez, ancak hesaba bir daha giriş yapılamaz.\n' +
        'Bu işlem GERİ ALINAMAZ.'),
    'EVET, KALICI SİL',
    true
  );
  if (!eminMi) return;

  const geriAl = butonuMesgulEt(buton, 'SİLİNİYOR…');

  try {
    if (ekDemoMu()) {
      await bekle(280);

      if (typeof DEMO_UYELER !== 'undefined') {
        const yer = ekUrunIndeksi(DEMO_UYELER, id);
        if (yer !== -1) DEMO_UYELER.splice(yer, 1);
      }
    } else {
      const cevap = await woo('customers/' + id, {
        metod: 'DELETE',
        sorgu: { force: true },
        sureAsimi: 45000
      });

      if (!cevap || !cevap.ok) {
        bildir('Müşteri silinemedi:\n' + ekHataMetni(cevap), 'hata');
        return;
      }
    }

    /* Yerel liste + bekleyen sayaç birlikte güncellenir. */
    d.uyeler = (d.uyeler || []).filter(function (x) { return String(x.id) !== String(id); });
    if (u.durum === 'pending' && d.bekleyenUyeSayisi > 0) d.bekleyenUyeSayisi -= 1;
    if (d.uyelerToplam > 0) d.uyelerToplam -= 1;

    if (d.acikBayi && String(d.acikBayi.id) === String(id)) {
      d.acikBayi = null;
      if (typeof bayiModaliKapat === 'function') bayiModaliKapat();
    }

    if (typeof uyeleriCiz === 'function') uyeleriCiz();

    bildir('Müşteri kalıcı olarak silindi.\n' + (u.firma || u.ad) +
           (ekDemoMu()
             ? '\n(Demo Modu — sitenizde değişiklik yapılmadı)'
             : '\nSitenizden de tamamen kaldırıldı.'), 'basari');
  } catch (e) {
    bildir('Müşteri silinirken beklenmeyen bir hata oluştu:\n' +
           String((e && e.message) || e), 'hata');
  } finally {
    geriAl();
  }
}

/* ==========================================================================
 *  BÖLÜM H — OLAY BAĞLANTILARI VE BAŞLANGIÇ
 * ========================================================================*/

/** Bu dosyanın eklediği bütün olay dinleyicilerini bağlar (bir kez çalışır). */
function ekOlaylariBagla() {
  const d = ekDurum();

  if (d) {
    if (d.ekOlaylarBagli) return;
    d.ekOlaylarBagli = true;
  }

  /* --------------------------------------------------------------
   *  A) ROL BAZLI ÖDEME MATRİSİ
   * ------------------------------------------------------------*/
  const iskontoKaydetBtn = $('#iskontoKaydetBtn');
  if (iskontoKaydetBtn) {
    iskontoKaydetBtn.addEventListener('click', function () { iskontoKaydet(); });
  }

  const iskontoYenileBtn = $('#iskontoYenileBtn');
  if (iskontoYenileBtn) {
    iskontoYenileBtn.addEventListener('click', function () { iskontoSekmesiYukle(true); });
  }

  /* Tablolar yeniden çizildiği için tek tek kutulara değil, SABİT kaplara
     dinleyici bağlanır (olay yetkilendirme). */
  ['#matrisBireysel', '#matrisKurumsal'].forEach(function (secici) {
    const kap = $(secici);
    if (!kap) return;

    kap.addEventListener('click', function (o) {
      const anahtarBtn = ekEnYakin(o.target, '[data-matris-anahtar]');
      if (anahtarBtn) matrisAnahtariniDegistir(anahtarBtn.dataset.matrisAnahtar);
    });

    /* Yazarken önizleme tazelenir; tabloyu yeniden ÇİZMEZ (odak kaybolmasın). */
    kap.addEventListener('input', function (o) {
      if (o.target && o.target.matches('[data-matris-oran]')) iskontoOnizlemeCiz();
    });

    kap.addEventListener('keydown', function (o) {
      if (o.key !== 'Enter') return;
      if (!o.target || !o.target.matches('[data-matris-oran]')) return;
      o.preventDefault();
      iskontoKaydet();
    });
  });

  /* İskonto sekmesine ilk girişte veriyi getir (sekmeAc de çağırsa sorun olmaz:
     durum.iskontoYuklendi / durum.iskontoYukleniyor çift isteği engeller). */
  const iskontoMenuBtn = document.querySelector('[data-sekme="iskonto"]');
  if (iskontoMenuBtn) {
    iskontoMenuBtn.addEventListener('click', function () { iskontoSekmesiYukle(false); });
  }

  /* İlk çizim: sekmeye hiç girilmeden de tablolar hazır dursun. */
  matrisiCiz();

  /* --------------------------------------------------------------
   *  C) ÜRÜN DÜZENLE PENCERESİ
   * ------------------------------------------------------------*/

  /* renderer.js'teki click dinleyicisine DOKUNULMAZ; bu İKİNCİ bir dinleyicidir. */
  const urunListesi = $('#urunListesi');
  if (urunListesi) {
    urunListesi.addEventListener('click', function (o) {
      const duzenleBtn = ekEnYakin(o.target, '[data-eylem="urun-duzenle"]');
      if (duzenleBtn) { urunDuzenleAc(duzenleBtn.dataset.id); return; }

      const silBtn = ekEnYakin(o.target, '[data-eylem="urun-sil"]');
      if (silBtn) { urunSil(silBtn.dataset.id, silBtn); return; }
    });
  }

  /* renderer.js'teki #uyeListesi dinleyicisine DOKUNULMAZ; bu İKİNCİ bir dinleyicidir. */
  const uyeListesi = $('#uyeListesi');
  if (uyeListesi) {
    uyeListesi.addEventListener('click', function (o) {
      const silBtn = ekEnYakin(o.target, '[data-eylem="uye-sil"]');
      if (silBtn) { uyeSil(silBtn.dataset.id, silBtn); return; }
    });
  }

  const duzenleKaydetBtn = $('#duzenleKaydetBtn');
  if (duzenleKaydetBtn) {
    duzenleKaydetBtn.addEventListener('click', function () { urunDuzenleKaydet(); });
  }

  const duzenleVazgecBtn = $('#duzenleVazgecBtn');
  if (duzenleVazgecBtn) duzenleVazgecBtn.addEventListener('click', urunDuzenleKapat);

  const duzenleKapatBtn = $('#duzenleKapatBtn');
  if (duzenleKapatBtn) duzenleKapatBtn.addEventListener('click', urunDuzenleKapat);

  const duzenleKatman = $('#urunDuzenleKatman');
  if (duzenleKatman) {
    duzenleKatman.addEventListener('mousedown', function (o) {
      if (o.target === duzenleKatman) urunDuzenleKapat();
    });

    duzenleKatman.addEventListener('keydown', function (o) {
      if (o.key === 'Escape') { urunDuzenleKapat(); return; }
      /* Enter ile kaydet — ama çok satırlı alanda ve butonlar üzerindeyken DEĞİL
         (aksi halde VAZGEÇ/KAPAT düğmesinde Enter'a basınca ürün kaydedilirdi). */
      if (o.key === 'Enter' && o.target &&
          o.target.tagName !== 'TEXTAREA' && o.target.tagName !== 'BUTTON') {
        o.preventDefault();
        urunDuzenleKaydet();
      }
    });
  }

  /* --- Düzenleme penceresi görsel alanı --- */
  const duzenleBirak = $('#duzenleGorselBirak');
  const duzenleDosyaSec = $('#duzenleDosyaSec');
  const DUZENLE_VURGU = ['border-marka-500', 'bg-marka-50', 'dark:bg-marka-900/30'];

  if (duzenleBirak) {
    duzenleBirak.addEventListener('click', function () {
      if (duzenleDosyaSec) duzenleDosyaSec.click();
    });

    duzenleBirak.addEventListener('dragover', function (o) {
      o.preventDefault();
      if (o.dataTransfer) o.dataTransfer.dropEffect = 'copy';
      duzenleBirak.classList.add.apply(duzenleBirak.classList, DUZENLE_VURGU);
    });

    duzenleBirak.addEventListener('dragleave', function () {
      duzenleBirak.classList.remove.apply(duzenleBirak.classList, DUZENLE_VURGU);
    });

    duzenleBirak.addEventListener('drop', function (o) {
      o.preventDefault();
      duzenleBirak.classList.remove.apply(duzenleBirak.classList, DUZENLE_VURGU);
      const dosyalar = (o.dataTransfer && o.dataTransfer.files) || [];
      if (dosyalar.length) duzenleGorselleriYukle(dosyalar);
    });
  }

  if (duzenleDosyaSec) {
    duzenleDosyaSec.addEventListener('change', function (o) {
      if (o.target.files && o.target.files.length) duzenleGorselleriYukle(o.target.files);
      o.target.value = '';   // Aynı dosya tekrar seçilebilsin
    });
  }

  const duzenleGorselKutu = $('#duzenleGorselKutu');
  if (duzenleGorselKutu) {
    duzenleGorselKutu.addEventListener('click', function (o) {
      const silBtn = ekEnYakin(o.target, '[data-duzenle-gorsel-sil]');
      if (silBtn) duzenleGorselKaldir(silBtn.dataset.duzenleGorselSil);
    });
  }

  const duzenleGorselUrl = $('#duzenleGorselUrl');
  if (duzenleGorselUrl) {
    duzenleGorselUrl.addEventListener('input', function () {
      const deger = duzenleGorselUrl.value.trim();

      if (!deger) {
        duzenleUyar('');
        return;
      }

      if (!/^https?:\/\//i.test(deger)) {
        duzenleUyar('Görsel bağlantısı http:// veya https:// ile başlamalıdır.');
        return;
      }

      duzenleUyar('');
      duzenleGorselDurumYaz('Kaydettiğinizde ürün görseli bu bağlantıdan alınacak.',
                            'text-marka-700 dark:text-marka-300');
    });
  }

  /* --------------------------------------------------------------
   *  D) SÜRÜKLE-BIRAK SIRALAMA
   * ------------------------------------------------------------*/
  urunSiralamasiniBagla();
}

/* renderer.js'in `baslat` fonksiyonu bu dosyadan ÖNCE kaydedildiği için önce o
   çalışır; ancak async olduğundan burada durum.ayarlar'a BAĞIMLI OLUNMAZ. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { ekOlaylariBagla(); });
} else {
  ekOlaylariBagla();
}

/* ==========================================================================
 *  BÖLÜM F — BAŞLANGIÇ DEĞERLERİ VE DIŞA AÇMA
 * ========================================================================*/

/** durum nesnesine bu modülün alanlarını ekler. */
function ekDurumBaslangici() {
  const d = ekDurum();
  if (!d) return;

  /* A) Rol bazlı ödeme matrisi (bkz. BÖLÜM A) */
  d.odemeMatrisi = varsayilanMatris();
  d.iskontoYuklendi = false;
  d.iskontoYukleniyor = false;

  /* Eski düz oran nesnesi — sitedeki eski uca yansıtılan değerlerin
     bellekteki karşılığı; dışarıdan okuyan kod kırılmasın diye korunuyor. */
  d.iskonto = {
    cash: d.odemeMatrisi.corporate.cash.discount,
    card: d.odemeMatrisi.corporate.card.discount,
    term: d.odemeMatrisi.corporate.term.discount
  };

  /* C) Ürün düzenleme */
  d.duzenlenenUrun = null;
  d.duzenleGorselleri = [];
  d.duzenleIlkKod = '';
  d.duzenleIlkKategori = '';
  d.duzenleKategoriSayisi = 0;
  d.duzenleIlkAciklama = '';

  /* D) Sıralama */
  d.suruklenenUrun = null;
  d.siralamaDegisti = false;
  d.siralamaGonderiliyor = false;
  d.siralamaZamani = null;
  /* Siteye yazılmayı bekleyen sıra değişiklikleri: { urunId: menu_order } */
  d.siraBekleyen = {};
  /* Süren "sıra numarası tabanı" hazırlığı (varsa) */
  d.siraTabaniSozu = null;

  /* G2) Web Vitrini sekmesi 1.3.0'da kaldırıldı: banner / öne çıkan ürün /
     marka yönetimi Vitrin Editörü'nün blok ayarlarına taşındı
     (renderer-vitrin.js → bölüm 12, theme-config > showcase). */
}

/* Sözleşme gereği tüm fonksiyonlar window üzerinden de erişilebilir olsun
   (renderer.js ve index.html içinden çağrılabilmeleri için). */
window.ekDurum = ekDurum;
window.ekDemoMu = ekDemoMu;
window.ekEklentiVarMi = ekEklentiVarMi;
window.ekEnYakin = ekEnYakin;
window.ekAramaMetni = ekAramaMetni;
window.ekHataMetni = ekHataMetni;
window.iskontoYazi = iskontoYazi;

window.ISKONTO_TIPLERI = ISKONTO_TIPLERI;
window.ISKONTO_ORNEK_SEPET = ISKONTO_ORNEK_SEPET;
window.ODEME_TIPI_BILGISI = ODEME_TIPI_BILGISI;

window.MATRIS_ROLLERI = MATRIS_ROLLERI;
window.ODEME_YONTEMLERI = ODEME_YONTEMLERI;
window.varsayilanMatris = varsayilanMatris;
window.matrisNormalle = matrisNormalle;
window.matrisiCiz = matrisiCiz;
window.matrisTablosuCiz = matrisTablosuCiz;
window.matrisFormunuOku = matrisFormunuOku;
window.matrisAnahtariniDegistir = matrisAnahtariniDegistir;
window.matrisOzeti = matrisOzeti;
window.eskiOranlariMatriseCevir = eskiOranlariMatriseCevir;

window.iskontoSekmesiYukle = iskontoSekmesiYukle;
window.iskontoFormunuDoldur = iskontoFormunuDoldur;
window.iskontoFormunuOku = iskontoFormunuOku;
window.iskontoOnizlemeCiz = iskontoOnizlemeCiz;
window.iskontoDurumYaz = iskontoDurumYaz;
window.iskontoKaydet = iskontoKaydet;

window.siparisOdemeRozetiHtml = siparisOdemeRozetiHtml;

window.urunDuzenleAc = urunDuzenleAc;
window.urunDuzenleKapat = urunDuzenleKapat;
window.urunDuzenleKaydet = urunDuzenleKaydet;
window.duzenleGorselleriYukle = duzenleGorselleriYukle;
window.duzenleGorselKaldir = duzenleGorselKaldir;
window.duzenleGorselKutusuCiz = duzenleGorselKutusuCiz;
window.duzenleKategorileriYukle = duzenleKategorileriYukle;
window.duzenleUyar = duzenleUyar;
window.duzenleGorselDurumYaz = duzenleGorselDurumYaz;

window.urunSiralamasiniBagla = urunSiralamasiniBagla;
window.siralamaGuvenliMi = siralamaGuvenliMi;
window.urunuSirayaTasi = urunuSirayaTasi;
window.siralamayiGonder = siralamayiGonder;
window.siraDegeri = siraDegeri;
window.siraDegisiminiHesapla = siraDegisiminiHesapla;
window.siraDegisimleriniKuyrukla = siraDegisimleriniKuyrukla;
window.siraWooIleGonder = siraWooIleGonder;
window.siraTabaniYetersizMi = siraTabaniYetersizMi;
window.siraTabaniniHazirla = siraTabaniniHazirla;
window.urunTasimasiniUygula = urunTasimasiniUygula;
window.urunuKomsuylaTasi = urunuKomsuylaTasi;

window.urunSil = urunSil;
window.IPTAL_SEBEPLERI = IPTAL_SEBEPLERI;
window.iptalSebepleriCiz = iptalSebepleriCiz;
window.iptalSebebiSor = iptalSebebiSor;
window.iptalModaliKapat = iptalModaliKapat;
window.siparisIptalEt = siparisIptalEt;
window.siparisSil = siparisSil;
window.uyeSil = uyeSil;


window.ekOlaylariBagla = ekOlaylariBagla;
