/* ==========================================================================
 *  B2B YÖNETİM PANELİ — ÜRÜN VERİ IZGARASI (Excel tipi tablo)
 *  --------------------------------------------------------------------------
 *  Bu dosya renderer.js ve renderer-ek.js'ten SONRA yüklenir ve onların
 *  genel kapsamdaki yardımcılarını kullanır:
 *    $, $$, kacis, para, paraSade, fiyatYazi, sayiCoz, bildir, onayla,
 *    metinSor, bekle, ikon, butonuMesgulEt, woo/b2b, durum, urunNormalle,
 *    urunleriCiz, YEDEK_GORSEL
 *
 *  NEDEN AYRI DOSYA
 *  ----------------
 *  renderer.js zaten 6.000+ satır. Izgara, kategori ağacı ve toplu işlemler
 *  tek bir konu başlığı; ayrı dosyada tutulunca hem aranabilir kalıyor hem de
 *  kart görünümünün eski kodu bozulmadan yerinde duruyor.
 *
 *  DÖRT İŞ
 *  -------
 *   A) SANALLAŞTIRILMIŞ IZGARA — 5.000 üründe bile yalnızca ekrandaki ~20
 *      satır DOM'a çizilir. Hücreye çift tıklanınca yerinde düzenlenir,
 *      Enter kaydeder.
 *   B) KISMİ GÜNCELLEME — tek ürün değiştiğinde TÜM liste yeniden çekilmez;
 *      yalnızca o ürüne PATCH atılır, yerel state ve o satır güncellenir.
 *      Kaydırma konumu korunur.
 *   C) KATEGORİ AĞACI — ekleme / yeniden adlandırma / silme ve tek tıkla
 *      ürünleri kategoriye göre süzme.
 *   D) TOPLU İŞLEMLER — seçili ürünlere iskonto, kategori ve durum uygulama.
 * ========================================================================*/

'use strict';

/* ==========================================================================
 *  BÖLÜM 0 — DURUM VE ORTAK YARDIMCILAR
 * ========================================================================*/

/**
 * Izgaraya ait durum. renderer.js'teki `durum` nesnesine iliştirilir ki
 * sekme değişimi, yenileme ve ayar kaydı gibi mevcut akışlar tek bir state
 * ağacıyla çalışmayı sürdürsün.
 */
function izg() {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  if (!d) return null;

  if (!d.izgara) {
    d.izgara = {
      /* 'tablo' | 'kart' — kullanıcı seçimi ayarlara yazılır. */
      gorunum: 'tablo',
      /* Seçili ürün kimlikleri (toplu işlemler için). */
      secili: Object.create(null),
      /* Sol paneldeki kategori süzgeci: 0 = tümü, -1 = kategorisiz. */
      kategoriSuzgec: 0,
      kategoriler: [],
      kategorilerYuklendi: false,
      kategoriAcik: true,
      /* Sanallaştırma penceresi. */
      ilkSatir: 0,
      sonSatir: 0,
      /* Açık hücre düzenlemesi: { id, alan } */
      duzenlenen: null,
      /* Son çizilen liste — satır tıklamalarını çözmek için. */
      liste: []
    };
  }

  return d.izgara;
}

/** Sabit satır yüksekliği (px). Sanallaştırma matematiği buna dayanır. */
const IZGARA_SATIR_YUKSEKLIGI = 68;

/** Görünen pencerenin üstüne/altına fazladan çizilen satır sayısı. */
const IZGARA_TAMPON = 6;

/**
 * Izgara sütunları.
 *
 *   genislik    → ferah ekran şablonu
 *   darGenislik → taşıyıcı daraldığında kullanılan sıkışık şablon
 *
 * ÜRÜN ADI ESNEK sütundur (`minmax(0, 1fr)` — grid dünyasında `flex: 1`
 * karşılığı): artan genişliğin tamamını o yutar, böylece tablo HER ekran
 * genişliğinde sağ kenara tam yaslanır.
 *
 * NEDEN ALT SINIR 0: eskiden `minmax(200px, 1fr)` idi ve sabit sütunlarla
 * birlikte 1046px'lik bir taban genişlik dayatıyordu. Kategori paneli açıkken
 * 1280–1400px arası pencerelerde taşıyıcı bu tabandan dar kalıyor, ızgara
 * satırın DIŞINA taşıyor ve İŞLEM sütununun sağında satır zemininin
 * boyamadığı koyu bir şerit kalıyordu. 0 alt sınırıyla taşma olmuyor; uzun
 * ürün adları zaten `text-overflow: ellipsis` ile kısalıyor.
 */
const IZGARA_SUTUNLARI = [
  /* ⋮⋮ tutamak — sürükleyerek sıralama (bkz. BÖLÜM I). */
  { kod: 'tut',       etiket: '',             genislik: '28px',  ortaGenislik: '26px',  darGenislik: '24px', hiza: 'center' },
  { kod: 'sec',       etiket: '',             genislik: '44px',  ortaGenislik: '40px',  darGenislik: '36px', hiza: 'center' },
  { kod: 'gorsel',    etiket: 'GÖRSEL',       genislik: '68px',  ortaGenislik: '56px',  darGenislik: '46px', hiza: 'center' },
  { kod: 'kod',       etiket: 'SKU / BARKOD', genislik: '150px', ortaGenislik: '120px', darGenislik: '96px', hiza: 'left',  duzenlenir: true },
  { kod: 'ad',        etiket: 'ÜRÜN ADI',     genislik: 'minmax(0, 1fr)', ortaGenislik: 'minmax(0, 1fr)', darGenislik: 'minmax(0, 1fr)', hiza: 'left', duzenlenir: true },
  { kod: 'kategori',  etiket: 'KATEGORİ',     genislik: '150px', ortaGenislik: '110px', darGenislik: '86px', hiza: 'left' },
  { kod: 'fiyat',     etiket: 'LİSTE FİYATI', genislik: '130px', ortaGenislik: '112px', darGenislik: '98px', hiza: 'right', duzenlenir: true },
  /* KDV oranı fiyatın HEMEN yanında: fiyat girerken oranın da doğru olduğu
     tek bakışta görülür (çift tıklayıp yerinde düzenlenir). */
  { kod: 'kdv',       etiket: 'KDV %',        genislik: '78px',  ortaGenislik: '68px',  darGenislik: '58px', hiza: 'right', duzenlenir: true },
  { kod: 'stok',      etiket: 'STOK',         genislik: '90px',  ortaGenislik: '76px',  darGenislik: '62px', hiza: 'right', duzenlenir: true },
  { kod: 'durum',     etiket: 'DURUM',        genislik: '110px', ortaGenislik: '96px',  darGenislik: '84px', hiza: 'center' },
  { kod: 'islem',     etiket: 'İŞLEM',        genislik: '104px', ortaGenislik: '102px', darGenislik: '98px', hiza: 'center' }
];

/**
 * Kademeler — sabit sütun toplamları: ferah 846px, orta 702px, dar 592px.
 *
 * `enAz` = o kademenin seçilebilmesi için taşıyıcıda olması gereken en küçük
 * genişlik; her biri "sabit toplam + ÜRÜN ADI'na en az 220px" olarak
 * hesaplandı. İlk uyan kademe kullanılır.
 *
 * NEDEN ÜÇ KADEME: 1440px'lik VARSAYILAN pencerede bile ızgaraya kalan yer
 * yaklaşık 764px'tir (sol menü 288 + sayfa boşluğu 48 + kategori paneli 320 +
 * aralık 16 + çerçeve 4 düşülür). Tek bir sıkışık kademe bu genişlikte ÜRÜN
 * ADI'na 60px bile bırakmıyordu.
 *
 * ÖLÇÜLEN ŞEY PENCERE DEĞİL TAŞIYICIDIR: kategori paneli kapatılınca tablo
 * genişler ve sütunlar kendiliğinden ferahlar.
 */
const IZGARA_KADEMELERI = [
  { alan: 'genislik',     enAz: 1172 },
  { alan: 'ortaGenislik', enAz: 1026 },
  { alan: 'darGenislik',  enAz: 0 }
];

/** O anki taşıyıcı genişliğine uyan grid şablonu. */
function izgSablon() {
  const kaydirma = $('#izgKaydirma');
  const en = kaydirma ? kaydirma.clientWidth : 0;

  /* Henüz ölçülemiyorsa (kabuk yeni kuruldu) ferah kademe varsayılır;
     ilk gerçek ölçümde izgBasligiEsitle doğrusunu yazar. */
  const kademe = (en > 0)
    ? (IZGARA_KADEMELERI.filter(function (k) { return en >= k.enAz; })[0] || IZGARA_KADEMELERI[IZGARA_KADEMELERI.length - 1])
    : IZGARA_KADEMELERI[0];

  return IZGARA_SUTUNLARI.map(function (s) {
    return s[kademe.alan] || s.genislik;
  }).join(' ');
}

/**
 * Şablonu TEK bir CSS değişkenine yazar; başlık şeridi ve bütün satırlar
 * onu okur (index.html → `.izg-satir { grid-template-columns: var(--izg-sablon) }`).
 *
 * Şablon satır HTML'ine gömülü olsaydı genişlik her değiştiğinde binlerce
 * satırın yeniden çizilmesi gerekirdi; değişken sayesinde tek yazma yetiyor
 * ve satır HTML'i de kısalıyor (sanallaştırma ucuzluyor).
 */
function izgSablonuUygula() {
  const kap = $('#urunIzgara');
  if (!kap) return;

  const sablon = izgSablon();
  if (kap.dataset.sablon === sablon) return;

  kap.dataset.sablon = sablon;
  kap.style.setProperty('--izg-sablon', sablon);
}

/** Demo modu açık mı? */
function izgDemoMu() {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  return !!(d && d.ayarlar && d.ayarlar.demoModu);
}

/** Ürün kimliğinden ürün nesnesi. */
function izgUrunBul(id) {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  if (!d) return null;
  return d.urunler.filter(function (u) { return String(u.id) === String(id); })[0] || null;
}

/**
 * KDV oranını yazıya çevirir: 20 → "%20", 10.5 → "%10,5".
 *
 * Değer hiç gelmediyse mağaza varsayılanı (20) gösterilir; ürün kendi
 * oranını taşımıyorsa sitede zaten varsayılan geçerlidir.
 */
function izgKdvYazi(oran) {
  const n = Number(oran);
  const deger = isFinite(n) && n >= 0 ? n : 20;
  return '%' + String(Math.round(deger * 100) / 100).replace('.', ',');
}

/** Ürünün ilk kategori adı (yoksa boş). */
function izgKategoriAdi(u) {
  const k = (u.kategoriler || [])[0];
  return k ? String(k.ad || '') : '';
}

/* ==========================================================================
 *  BÖLÜM A — SANALLAŞTIRILMIŞ IZGARA
 * ========================================================================*/

/**
 * Süzgeçlerden geçmiş ürün listesi.
 *
 * Arama CANLI modda sunucuda yapılır (urunleriYukle), o yüzden burada arama
 * yalnızca demo modda uygulanır; kategori ve durum süzgeci her iki modda da
 * yerel çalışır (ikisi de hafızadaki listeye bakar).
 */
function izgFiltreliListe() {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  const g = izg();
  if (!d || !g) return [];

  let liste = d.urunler || [];

  /* Kategori süzgeci */
  if (g.kategoriSuzgec === -1) {
    liste = liste.filter(function (u) { return !(u.kategoriler || []).length; });
  } else if (g.kategoriSuzgec > 0) {
    const hedef = String(g.kategoriSuzgec);
    liste = liste.filter(function (u) {
      return (u.kategoriler || []).some(function (k) { return String(k.id) === hedef; });
    });
  }

  /* Durum süzgeci — canlı modda sunucu zaten süzer, demo modda burada. */
  if (izgDemoMu() && d.urunDurumSuzgec) {
    liste = liste.filter(function (u) { return u.durum === d.urunDurumSuzgec; });
  }

  /* Arama — yalnızca demo modda (canlıda sunucu arar). */
  if (izgDemoMu()) {
    const alan = $('#urunArama');
    const anahtar = (alan ? alan.value : '').trim().toLocaleLowerCase('tr-TR');

    if (anahtar) {
      liste = liste.filter(function (u) {
        return u.ad.toLocaleLowerCase('tr-TR').indexOf(anahtar) !== -1 ||
               String(u.kod).toLocaleLowerCase('tr-TR').indexOf(anahtar) !== -1;
      });
    }
  }

  return liste;
}

/** Pencere yeniden boyutlandırma dinleyicisi bir kez bağlanır. */
let izgOlcuBagli = false;

/**
 * Başlık şeridini satır gövdesiyle YATAYDA eşitler.
 *
 * Başlık, satırların kaydırma kutusunun DIŞINDA durur (dikeyde sabit kalsın
 * diye). Bunun bedeli: liste sağa kaydırılınca satırlar kayıyor, başlıklar
 * yerinde duruyordu; sütun adları verilerin üstünden kaçıyordu.
 *
 * İKİ AYRI KAYMA VARDI, İKİSİ DE BURADA KAPANIR:
 *
 *  1) YATAY KAYDIRMA — başlık kutusunun `scrollLeft` değeri satır
 *     kutusununkine yazılır. Kutu `overflow:hidden` olduğu için kullanıcı
 *     onu kendi başına kaydıramaz; yalnızca buradan sürülür.
 *
 *  2) DİKEY KAYDIRMA ÇUBUĞU — çubuk satır alanından yer yer (clientWidth
 *     küçülür) ama başlık kutusundan yemez. Aradaki fark kadar başlık
 *     kutusuna sağdan boşluk bırakılır; iki kutunun içerik genişliği
 *     birebir eşitlenir ve sütunlar piksel piksel kilitlenir.
 */
function izgBasligiEsitle() {
  const kaydirma = $('#izgKaydirma');
  const kutu = $('#izgBaslikKutu');
  if (!kaydirma || !kutu) return;

  /* Genişlik değişmiş olabilir (pencere boyu, kategori paneli açılıp
     kapanması); sıkışık / ferah şablon kararı her ölçümde yenilenir. */
  izgSablonuUygula();

  const cubuk = Math.max(0, kaydirma.offsetWidth - kaydirma.clientWidth);
  const bosluk = cubuk + 'px';
  if (kutu.style.paddingRight !== bosluk) kutu.style.paddingRight = bosluk;

  if (kutu.scrollLeft !== kaydirma.scrollLeft) kutu.scrollLeft = kaydirma.scrollLeft;
}

/** Izgara kabuğunu (başlık + kaydırma kutusu) bir kez kurar. */
function izgKabuguCiz() {
  const kap = $('#urunIzgara');
  if (!kap) return;

  const baslik = IZGARA_SUTUNLARI.map(function (s) {
    if (s.kod === 'sec') {
      return '<div class="izg-bh" style="text-align:center">' +
               '<input type="checkbox" id="izgTumunuSec" aria-label="Tümünü seç" ' +
                      'class="w-5 h-5 accent-marka-600 cursor-pointer" />' +
             '</div>';
    }
    return '<div class="izg-bh" style="text-align:' + s.hiza + '">' + kacis(s.etiket) + '</div>';
  }).join('');

  kap.innerHTML =
    '<div class="rounded-2xl overflow-hidden border-2 border-slate-200 dark:border-slate-700 ' +
                'bg-white dark:bg-slate-800">' +
      '<div id="izgBaslikKutu" class="izg-baslik-kutu">' +
        '<div id="izgBaslik" class="izg-satir izg-baslik">' +
          baslik +
        '</div>' +
      '</div>' +
      '<div id="izgKaydirma" class="overflow-auto" style="max-height:calc(100vh - 420px); min-height:280px">' +
        '<div id="izgBosluk" style="position:relative">' +
          '<div id="izgGovde" style="position:absolute; left:0; right:0; top:0"></div>' +
        '</div>' +
      '</div>' +
      '<div id="izgAltbilgi" class="flex flex-wrap items-center gap-3 px-4 py-3 text-base font-bold ' +
                                   'text-slate-500 dark:text-slate-400 border-t-2 border-slate-200 ' +
                                   'dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40"></div>' +
    '</div>';

  /* Sütun şablonu kabuk kurulur kurulmaz yazılır; ilk çizimde satırlar
     zaten doğru genişlikte doğar. */
  izgSablonuUygula();

  const kaydirma = $('#izgKaydirma');
  if (kaydirma && !kaydirma.dataset.bagli) {
    kaydirma.dataset.bagli = '1';
    kaydirma.addEventListener('scroll', function () {
      izgPencereyiCiz();
      izgBasligiEsitle();
    }, { passive: true });
  }

  /* Pencere boyu değişince dikey kaydırma çubuğu gelip gidebilir; başlığın
     sağ boşluğu buna göre yeniden ölçülmeli. Kabuk her yeniden kurulduğunda
     #izgKaydirma yenilendiği için satır dinleyicisi de yenilenir, ama pencere
     dinleyicisi TEK sefer bağlanır (yoksa her çizimde bir tane daha eklenir). */
  if (!izgOlcuBagli) {
    izgOlcuBagli = true;
    window.addEventListener('resize', function () { izgBasligiEsitle(); }, { passive: true });
  }

  const tumu = $('#izgTumunuSec');
  if (tumu) {
    tumu.addEventListener('change', function () {
      izgTumunuSec(!!tumu.checked);
    });
  }
}

/**
 * Izgarayı çizer.
 *
 * @param {boolean} konumuKoru Kaydırma konumu korunsun mu? Kısmi güncelleme
 *   sonrası TRUE gelir; liste yeniden yüklendiğinde FALSE.
 */
function izgCiz(konumuKoru) {
  const g = izg();
  if (!g) return;

  const kap = $('#urunIzgara');
  if (!kap || kap.classList.contains('hidden')) return;

  if (!$('#izgGovde')) izgKabuguCiz();

  const kaydirma = $('#izgKaydirma');
  const eskiKonum = kaydirma ? kaydirma.scrollTop : 0;

  g.liste = izgFiltreliListe();

  const bosluk = $('#izgBosluk');
  if (bosluk) bosluk.style.height = (g.liste.length * IZGARA_SATIR_YUKSEKLIGI) + 'px';

  izgPencereyiCiz();
  izgAltbilgiCiz();
  izgSecimCubuguTazele();

  /* Kaydırma konumu: kısmi güncellemede kullanıcının bulunduğu yer korunur.
     Liste kısaldıysa (süzgeç değişti) taşan konum sona sabitlenir. */
  if (kaydirma) {
    if (konumuKoru) {
      const enFazla = Math.max(0, (g.liste.length * IZGARA_SATIR_YUKSEKLIGI) - kaydirma.clientHeight);
      kaydirma.scrollTop = Math.min(eskiKonum, enFazla);
    } else {
      kaydirma.scrollTop = 0;
    }
    izgPencereyiCiz();
  }

  /* Liste boyu değişince dikey çubuk gelip gidebilir; başlık her çizimde
     satırlara yeniden eşitlenir. */
  izgBasligiEsitle();
}

/** Yalnızca görünen pencereyi (üst/alt tamponla) DOM'a yazar. */
function izgPencereyiCiz() {
  const g = izg();
  const kaydirma = $('#izgKaydirma');
  const govde = $('#izgGovde');
  if (!g || !kaydirma || !govde) return;

  const toplam = g.liste.length;

  if (toplam === 0) {
    govde.style.transform = 'translateY(0)';
    govde.innerHTML = izgBosHtml();
    return;
  }

  const ilk = Math.max(0, Math.floor(kaydirma.scrollTop / IZGARA_SATIR_YUKSEKLIGI) - IZGARA_TAMPON);
  const adet = Math.ceil(kaydirma.clientHeight / IZGARA_SATIR_YUKSEKLIGI) + (IZGARA_TAMPON * 2);
  const son = Math.min(toplam, ilk + adet);

  /* Aynı pencere yeniden çizilmesin: kaydırma her pikselde olay üretir,
     DOM'u her seferinde yeniden yazmak düzenlenen hücrenin odağını
     kaybettiriyordu. */
  if (g.ilkSatir === ilk && g.sonSatir === son && govde.dataset.dolu === '1' && !g.tazeleGerek) {
    return;
  }

  g.ilkSatir = ilk;
  g.sonSatir = son;
  g.tazeleGerek = false;

  govde.style.transform = 'translateY(' + (ilk * IZGARA_SATIR_YUKSEKLIGI) + 'px)';
  govde.dataset.dolu = '1';
  govde.innerHTML = g.liste.slice(ilk, son).map(izgSatirHtml).join('');
}

/** Liste boşken gösterilecek kutu. */
function izgBosHtml() {
  const g = izg();
  const suzgecVar = g && (g.kategoriSuzgec !== 0);

  return '<div class="p-12 text-center">' +
    '<div class="text-2xl font-black mb-2">Ürün bulunamadı</div>' +
    '<div class="text-lg text-slate-500 dark:text-slate-400">' +
      (suzgecVar
        ? 'Seçili kategoride ürün yok. Üstteki haplardan ya da soldaki ağaçtan “Tüm Ürünler”e dönebilirsiniz.'
        : 'Aramanıza uyan ürün yok ya da mağazanız henüz boş.') +
    '</div></div>';
}

/** Tek bir ızgara satırı. */
function izgSatirHtml(u) {
  const g = izg();
  const seciliMi = !!(g && g.secili[u.id]);
  const yayindaMi = u.durum === 'publish';

  const stokRengi = u.stok <= 0
    ? 'text-red-600 dark:text-red-400'
    : (u.stok < 20 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400');

  const kategori = izgKategoriAdi(u);

  /* data-duzenle: çift tıklanınca hangi alanın açılacağını söyler. */
  function hucre(sinif, icerik, alan, hiza, baslik) {
    return '<div class="izg-h ' + sinif + '"' +
             (alan ? ' data-duzenle="' + alan + '" title="Düzenlemek için çift tıklayın"' : '') +
             (baslik && !alan ? ' title="' + kacis(baslik) + '"' : '') +
             ' style="text-align:' + (hiza || 'left') + '">' + icerik + '</div>';
  }

  const tasiniyorMu = (typeof izgTasinanMi === 'function') && izgTasinanMi(u.id);

  return '' +
  '<div class="izg-satir izg-veri' + (seciliMi ? ' izg-secili' : '') +
       (yayindaMi ? '' : ' izg-taslak') + (tasiniyorMu ? ' izg-tasiniyor' : '') + '" data-izg-id="' + u.id + '" ' +
       'style="height:' + IZGARA_SATIR_YUKSEKLIGI + 'px">' +

    /* ⋮⋮ tutamak: pointer ile sürükle (BÖLÜM I), Alt + ↑/↓ ile klavyeden taşı. */
    '<div class="izg-h izg-tut" data-izg-tut="' + u.id + '" role="button" tabindex="0" ' +
         'aria-label="Ürünü taşı" title="Sürükleyerek sıralayın · Alt + ↑ / Alt + ↓ ile de taşıyabilirsiniz">' +
      ikon('tutamak') +
    '</div>' +

    '<div class="izg-h" style="text-align:center">' +
      '<input type="checkbox" data-izg-sec="' + u.id + '" ' + (seciliMi ? 'checked ' : '') +
             'aria-label="Ürünü seç" class="w-5 h-5 accent-marka-600 cursor-pointer" />' +
    '</div>' +

    '<div class="izg-h" style="text-align:center">' +
      '<img src="' + kacis(u.gorsel) + '" alt="" loading="lazy" ' +
           'onerror="this.onerror=null;this.src=\'' + YEDEK_GORSEL + '\'" ' +
           'class="w-12 h-12 rounded-lg object-cover bg-slate-100 dark:bg-slate-700 mx-auto" />' +
    '</div>' +

    hucre('izg-kod', kacis(u.kod), 'kod') +
    hucre('izg-ad', kacis(u.ad), 'ad') +
    hucre('izg-kategori',
          kategori ? kacis(kategori) : '<span class="izg-bos">—</span>',
          '', 'left', kategori) +
    hucre('izg-para', kacis(paraSade(u.fiyat)), 'fiyat', 'right') +
    hucre('izg-kdv', kacis(izgKdvYazi(u.kdv)), 'kdv', 'right') +
    hucre('izg-stok ' + stokRengi, String(u.stok), 'stok', 'right') +

    '<div class="izg-h" style="text-align:center">' +
      '<button type="button" data-izg-durum="' + u.id + '" ' +
              'title="' + (yayindaMi ? 'Ürünü gizle (taslak yap)' : 'Ürünü yayına al') + '" ' +
              'class="izg-rozet ' + (yayindaMi ? 'izg-yayinda' : 'izg-gizli') + '">' +
        (yayindaMi ? 'YAYINDA' : 'GİZLİ') +
      '</button>' +
    '</div>' +

    '<div class="izg-h izg-islemler">' +
      '<button type="button" data-eylem="urun-duzenle" data-id="' + u.id + '" ' +
              'title="Tüm alanları düzenle (görsel, açıklama, kategori…)" ' +
              'aria-label="Ürünü düzenle" class="izg-islem izg-islem-duzenle">' +
        ikon('kalem') +
      '</button>' +
      '<button type="button" data-eylem="urun-sil" data-id="' + u.id + '" ' +
              'title="Ürünü tamamen sil" aria-label="Ürünü sil" ' +
              'class="izg-islem izg-islem-sil">' +
        ikon('cop') +
      '</button>' +
    '</div>' +

  '</div>';
}

/* --------------------------------------------------------------------------
 *  SATIR SONU İŞLEM DÜĞMELERİ  (kalem = düzenle, çöp kutusu = sil)
 *  --------------------------------------------------------------------------
 *  Bu iki düğme uzun süre ÇALIŞMIYORDU. Sebebi: `[data-eylem="urun-duzenle"]`
 *  ve `[data-eylem="urun-sil"]` devri (event delegation) yalnızca KART
 *  görünümünün kabına — `#urunListesi` — bağlıydı (renderer.js ve
 *  renderer-ek.js). Izgara ise bambaşka bir kaba, `#urunIzgara`'ya çiziliyor;
 *  tıklamalar hiçbir dinleyiciye ulaşmıyordu. Bağlantı artık
 *  izgOlaylariBagla içinde, ızgaranın kendi kabında kuruluyor.
 *
 *  Devir kullanılmasının sebebi sanallaştırma: satırlar kaydırma sırasında
 *  saniyede onlarca kez yeniden yazılıyor, tek tek düğmeye dinleyici bağlamak
 *  hem pahalı olurdu hem de yeni çizilen satırlarda dinleyici olmazdı.
 * ------------------------------------------------------------------------*/

/** KALEM — tüm alanları düzenleme penceresini açar (görsel, açıklama, kategori…). */
function izgUrunDuzenle(id) {
  if (typeof urunDuzenleAc !== 'function') {
    bildir('Ürün düzenleme penceresi yüklenemedi.\nUygulamayı yeniden başlatın.', 'hata');
    return;
  }

  /* Pencere kapanırken kaydedilen ürün, ızgarada YERİNDE tazeleniyor
     (renderer-ek.js > ekUrunuYerindeGuncelle); burada ek bir iş yok. */
  urunDuzenleAc(id);
}

/** ÇÖP KUTUSU — onay penceresini açar; onaylanırsa ürünü siler. */
function izgUrunSil(id, dugme) {
  if (typeof urunSil !== 'function') {
    bildir('Ürün silme işlevi yüklenemedi.\nUygulamayı yeniden başlatın.', 'hata');
    return;
  }

  /* urunSil onayı kendi soruyor, silince listeyi ve ızgarayı tazeliyor. */
  urunSil(id, dugme);
}

/** Alt bilgi çubuğu: kaç ürün gösteriliyor, kaç tanesi süzüldü. */
function izgAltbilgiCiz() {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  const g = izg();
  const kutu = $('#izgAltbilgi');
  if (!kutu || !g || !d) return;

  const gosterilen = g.liste.length;
  const toplam = (d.urunler || []).length;
  const magaza = Number(d.urunlerToplam) || toplam;

  const parcalar = [
    '<span>' + ikon('liste') + ' <b>' + gosterilen + '</b> ürün listeleniyor</span>',
    /* Sıra eşitleme durumu (BÖLÜM I → izgSiraDurumCiz doldurur). */
    '<span id="izgSiraDurum" class="izg-sira-durum"></span>'
  ];

  if (gosterilen !== toplam) {
    parcalar.push('<span>(hafızadaki ' + toplam + ' üründen süzüldü)</span>');
  }

  if (magaza > toplam) {
    parcalar.push('<span class="text-amber-600 dark:text-amber-400">' + ikon('uyari') +
                  ' Mağazadaki ' + magaza + ' ürünün tamamı yüklenmedi</span>');
  }

  parcalar.push('<span class="ml-auto">Hücreye <b>çift tıklayın</b> · ' +
                '<b>Enter</b> kaydeder · <b>Esc</b> vazgeçer</span>');

  kutu.innerHTML = parcalar.join('');
}

/* ==========================================================================
 *  BÖLÜM B — HÜCRE İÇİ DÜZENLEME
 * ========================================================================*/

/** Alan tanımları: doğrulama ve biçimleme tek yerde. */
const IZGARA_ALANLARI = {
  kod:   { etiket: 'Stok kodu', tur: 'metin' },
  ad:    { etiket: 'Ürün adı',  tur: 'metin', zorunlu: true },
  fiyat: { etiket: 'Liste fiyatı', tur: 'para' },
  /* KDV oranı: 0-100 arası yüzde. Boş bırakılırsa mağaza varsayılanına döner. */
  kdv:   { etiket: 'KDV oranı',    tur: 'yuzde' },
  stok:  { etiket: 'Stok adedi',   tur: 'tamsayi' }
};

/** Hücrenin ham (düzenlenebilir) değeri. */
function izgHamDeger(u, alan) {
  if (alan === 'kdv') return izgKdvYazi(u.kdv);
  if (alan === 'fiyat') return fiyatYazi(u.fiyat);
  if (alan === 'stok') return String(u.stok);
  if (alan === 'kod') return u.kod === '-' ? '' : String(u.kod);
  return String(u[alan] || '');
}

/** Hücreyi düzenleme kipine alır. */
function izgHucreAc(hucre) {
  const g = izg();
  if (!g || hucre.querySelector('input')) return;

  const satir = hucre.closest('[data-izg-id]');
  if (!satir) return;

  const id = satir.getAttribute('data-izg-id');
  const alan = hucre.getAttribute('data-duzenle');
  const u = izgUrunBul(id);
  if (!u || !IZGARA_ALANLARI[alan]) return;

  /* Başka bir hücre açıksa önce onu kapat (iki açık kutu karışıklık yaratır). */
  izgHucreKapat();

  g.duzenlenen = { id: id, alan: alan };

  const tanim = IZGARA_ALANLARI[alan];
  const sayisalMi = tanim.tur !== 'metin';

  hucre.classList.add('izg-duzenleniyor');
  hucre.innerHTML =
    '<input type="text" class="izg-girdi" ' +
           (sayisalMi ? 'inputmode="decimal" ' : '') +
           'value="' + kacis(izgHamDeger(u, alan)) + '" ' +
           'aria-label="' + kacis(tanim.etiket) + '" />';

  const girdi = hucre.querySelector('input');
  girdi.focus();
  girdi.select();

  girdi.addEventListener('keydown', function (o) {
    if (o.key === 'Enter') { o.preventDefault(); izgHucreKaydet(hucre); }
    else if (o.key === 'Escape') { o.preventDefault(); izgHucreKapat(); }
    else if (o.key === 'Tab') {
      /* Tab: kaydet ve aynı satırda bir sonraki düzenlenebilir hücreye geç. */
      o.preventDefault();
      izgHucreKaydet(hucre, o.shiftKey ? -1 : 1);
    }
  });

  /* Odak kaybında da kaydet: kullanıcı başka yere tıkladığında yazdığı
     değerin sessizce kaybolması en can sıkıcı davranıştı. */
  girdi.addEventListener('blur', function () {
    if (hucre.classList.contains('izg-duzenleniyor')) izgHucreKaydet(hucre);
  });
}

/** Açık hücreyi kaydetmeden kapatır (satırı yeniden çizer). */
function izgHucreKapat() {
  const g = izg();
  if (!g || !g.duzenlenen) return;

  const acik = $('.izg-duzenleniyor');
  g.duzenlenen = null;

  if (acik) {
    const satir = acik.closest('[data-izg-id]');
    if (satir) izgSatiriTazele(satir.getAttribute('data-izg-id'));
  }
}

/**
 * Hücreyi kaydeder.
 *
 * @param {Element} hucre  Düzenlenen hücre.
 * @param {number}  gecis  +1 / -1 ise kaydettikten sonra komşu hücreye geçer.
 */
async function izgHucreKaydet(hucre, gecis) {
  const g = izg();
  if (!g) return;

  const girdi = hucre.querySelector('input');
  const satir = hucre.closest('[data-izg-id]');
  if (!girdi || !satir) return;

  const id = satir.getAttribute('data-izg-id');
  const alan = hucre.getAttribute('data-duzenle');
  const u = izgUrunBul(id);
  const tanim = IZGARA_ALANLARI[alan];
  if (!u || !tanim) return;

  const ham = girdi.value.trim();

  /* Kapanışı ÖNCE yap: kaydetme sırasında blur olayı ikinci kez tetiklenip
     aynı isteği iki kere göndermesin. */
  hucre.classList.remove('izg-duzenleniyor');
  g.duzenlenen = null;

  /* --- Doğrulama --- */
  let deger;

  if (tanim.tur === 'para') {
    deger = sayiCoz(ham);
    if (!isFinite(deger) || isNaN(deger) || deger < 0) {
      bildir('Geçerli bir fiyat yazın.\nÖrnek: 1250,50', 'uyari');
      izgSatiriTazele(id);
      return;
    }
  } else if (tanim.tur === 'yuzde') {
    const n = sayiCoz(ham.replace('%', ''));
    if (!isFinite(n) || isNaN(n) || n < 0 || n > 100) {
      bildir('Geçerli bir KDV oranı yazın (0 ile 100 arasında).\nÖrnek: 20', 'uyari');
      izgSatiriTazele(id);
      return;
    }
    deger = Math.round(n * 100) / 100;
  } else if (tanim.tur === 'tamsayi') {
    const n = sayiCoz(ham);
    if (!isFinite(n) || isNaN(n) || n < 0) {
      bildir('Geçerli bir stok adedi yazın.\nÖrnek: 45', 'uyari');
      izgSatiriTazele(id);
      return;
    }
    deger = Math.round(n);
  } else {
    if (tanim.zorunlu && !ham) {
      bildir(tanim.etiket + ' boş bırakılamaz.', 'uyari');
      izgSatiriTazele(id);
      return;
    }
    deger = ham;
  }

  /* Değer değişmediyse istek atma. */
  const eski = alan === 'kod' ? (u.kod === '-' ? '' : u.kod) : u[alan];
  if (String(eski) === String(deger)) {
    izgSatiriTazele(id);
    if (gecis) izgKomsuHucreyeGec(id, alan, gecis);
    return;
  }

  await izgAlanKaydet(u, alan, deger);
  izgSatiriTazele(id);

  if (gecis) izgKomsuHucreyeGec(id, alan, gecis);
}

/** Aynı satırda bir önceki/sonraki düzenlenebilir hücreyi açar. */
function izgKomsuHucreyeGec(id, alan, yon) {
  const duzenlenirler = IZGARA_SUTUNLARI
    .filter(function (s) { return s.duzenlenir; })
    .map(function (s) { return s.kod; });

  const su = duzenlenirler.indexOf(alan);
  const hedef = duzenlenirler[su + yon];
  if (!hedef) return;

  const satir = $('[data-izg-id="' + id + '"]');
  if (!satir) return;

  const hucre = satir.querySelector('[data-duzenle="' + hedef + '"]');
  if (hucre) izgHucreAc(hucre);
}

/* ==========================================================================
 *  BÖLÜM C — KISMİ GÜNCELLEME (OPTIMISTIC UPDATE)
 * ========================================================================*/

/**
 * TEK ürünün TEK alanını siteye yazar ve yerel state'i günceller.
 *
 * BURASI İŞİN ÖZÜ: eskiden ürün düzenlendiğinde `urunleriYukle()` çağrılıp
 * mağazanın TÜM ürünleri (900+ üründe sayfa sayfa, onlarca istek) yeniden
 * çekiliyordu. Liste sıfırdan çizildiği için kullanıcının kaydırma konumu da
 * en başa dönüyordu: 400. üründeki fiyatı düzelten kişi her kayıttan sonra
 * listenin tepesine fırlıyordu.
 *
 * Artık yalnızca ilgili ürüne PATCH atılır, yanıt yerel kayda işlenir ve
 * SADECE o satır yeniden çizilir. Kaydırma konumuna hiç dokunulmaz.
 *
 * @returns {Promise<boolean>} Başarılı mı?
 */
async function izgAlanKaydet(u, alan, deger) {
  /* İyimser güncelleme: kullanıcı sonucu ANINDA görür. Sunucu reddederse
     aşağıda eski değere geri dönülür. */
  const oncekiDeger = u[alan];
  const oncekiKod = u.kod;

  if (alan === 'kod') { u.kod = deger || '-'; u.barkod = deger; }
  else u[alan] = deger;

  izgSatiriTazele(u.id);

  /* ---------- DEMO ---------- */
  if (izgDemoMu()) {
    await bekle(120);
    const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
      .filter(function (x) { return String(x.id) === String(u.id); })[0];
    if (kaynak) {
      if (alan === 'kod') { kaynak.kod = deger || '-'; kaynak.barkod = deger; }
      else kaynak[alan] = deger;
    }
    bildir(u.ad + '\n' + IZGARA_ALANLARI[alan].etiket + ' güncellendi.\n(Demo Modu)', 'basari');
    return true;
  }

  /* ---------- CANLI: yalnızca değişen alan gönderilir ---------- */
  const govde = {};

  if (alan === 'fiyat') govde.regular_price = Number(deger).toFixed(2);
  else if (alan === 'stok') { govde.stock_quantity = deger; govde.manage_stock = true; }
  else if (alan === 'ad') govde.name = deger;
  else if (alan === 'kod') govde.sku = deger;
  /* KDV oranı WooCommerce'in vergi sınıfına DEĞİL, kendi meta alanımıza yazılır. */
  else if (alan === 'kdv') govde.meta_data = [{ key: '_byom_kdv_rate', value: String(deger) }];

  const cevap = await woo('products/' + u.id, { metod: 'PUT', govde: govde, sureAsimi: 30000 });

  if (!cevap || !cevap.ok) {
    /* Geri al — ekrandaki değer siteyle uyuşmalı. */
    if (alan === 'kod') { u.kod = oncekiKod; u.barkod = oncekiKod === '-' ? '' : oncekiKod; }
    else u[alan] = oncekiDeger;

    izgSatiriTazele(u.id);

    const metin = (cevap && cevap.hata) ? cevap.hata : 'Bilinmeyen hata';
    bildir('Güncelleme başarısız:\n' + metin +
           '\n\nEkrandaki değer eski hâline döndürüldü.', 'hata');
    return false;
  }

  /* Sunucu yanıtı KAYNAK: WooCommerce fiyatı biçimlendirebilir ya da SKU'yu
     benzersizleştirebilir; ekranda sitedeki gerçek değer görünmeli. */
  if (cevap.veri && cevap.veri.id) {
    const taze = urunNormalle(cevap.veri);
    Object.keys(taze).forEach(function (a) { u[a] = taze[a]; });
    izgSatiriTazele(u.id);
  }

  bildir(u.ad + '\n' + IZGARA_ALANLARI[alan].etiket + ': ' +
         (alan === 'fiyat' ? para(u.fiyat) : (alan === 'kdv' ? izgKdvYazi(deger) : String(deger))) +
         '\nSitede güncellendi.', 'basari');

  return true;
}

/**
 * Tek satırı yerinde yeniden çizer — kaydırma konumuna DOKUNMAZ.
 *
 * Satır o an sanallaştırma penceresinin dışındaysa (ekranda değilse) hiçbir
 * şey yapılmaz; pencere oraya kaydırıldığında zaten güncel veriyle çizilir.
 */
function izgSatiriTazele(id) {
  const eski = $('[data-izg-id="' + id + '"]');
  if (!eski) return;

  const u = izgUrunBul(id);
  if (!u) { eski.remove(); return; }

  const kap = document.createElement('div');
  kap.innerHTML = izgSatirHtml(u);
  const yeni = kap.firstElementChild;
  if (yeni) eski.replaceWith(yeni);
}

/* ==========================================================================
 *  BÖLÜM D — SEÇİM VE TOPLU İŞLEMLER
 * ========================================================================*/

/** Seçili ürün kimlikleri (dizi). */
function izgSeciliIdler() {
  const g = izg();
  if (!g) return [];
  return Object.keys(g.secili).filter(function (id) { return g.secili[id]; });
}

/** Seçili ürün nesneleri — listede olmayan (süzülmüş) kimlikler elenir. */
function izgSeciliUrunler() {
  return izgSeciliIdler().map(izgUrunBul).filter(Boolean);
}

/** Bir ürünün seçimini değiştirir. */
function izgSecimDegistir(id, seciliMi) {
  const g = izg();
  if (!g) return;

  if (seciliMi) g.secili[id] = true;
  else delete g.secili[id];

  izgSatiriTazele(id);
  izgSecimCubuguTazele();
}

/** Görünen (süzgeçten geçmiş) tüm ürünleri seçer / bırakır. */
function izgTumunuSec(seciliMi) {
  const g = izg();
  if (!g) return;

  g.liste.forEach(function (u) {
    if (seciliMi) g.secili[u.id] = true;
    else delete g.secili[u.id];
  });

  g.tazeleGerek = true;
  izgPencereyiCiz();
  izgSecimCubuguTazele();
}

/** Seçimi tamamen temizler. */
function izgSecimiTemizle() {
  const g = izg();
  if (!g) return;

  g.secili = Object.create(null);
  g.tazeleGerek = true;
  izgPencereyiCiz();
  izgSecimCubuguTazele();
}

/** Toplu işlem çubuğunu ve "tümünü seç" kutusunu güncel tutar. */
function izgSecimCubuguTazele() {
  const g = izg();
  const cubuk = $('#topluCubuk');
  if (!g || !cubuk) return;

  const adet = izgSeciliIdler().length;

  cubuk.classList.toggle('hidden', adet === 0);
  cubuk.classList.toggle('flex', adet > 0);

  const sayac = $('#topluSayac');
  if (sayac) sayac.textContent = adet + ' ürün seçildi';

  const tumu = $('#izgTumunuSec');
  if (tumu) {
    const gorunen = g.liste.length;
    const gorunenSecili = g.liste.filter(function (u) { return g.secili[u.id]; }).length;
    tumu.checked = gorunen > 0 && gorunenSecili === gorunen;
    tumu.indeterminate = gorunenSecili > 0 && gorunenSecili < gorunen;
  }
}

/**
 * Seçili ürünlere sırayla bir işlem uygular.
 *
 * İstekler SIRAYLA gönderilir, hepsi birden değil: WooCommerce REST ucu
 * eşzamanlı yazma isteğinde 429/500 döndürebiliyor ve yarısı uygulanmış bir
 * toplu işlem, kullanıcının hangi ürünün değiştiğini bilememesi demek.
 * Sıralı akışta ilerleme de gösterilebiliyor.
 *
 * @param {Array}    urunler  Hedef ürünler.
 * @param {string}   baslik   İlerleme metni.
 * @param {Function} isle     async (urun) => {ok:boolean, hata:string}
 */
async function izgTopluUygula(urunler, baslik, isle) {
  const kutu = $('#topluSayac');
  let basarili = 0;
  const hatalar = [];

  for (let i = 0; i < urunler.length; i++) {
    if (kutu) kutu.textContent = baslik + ' ' + (i + 1) + ' / ' + urunler.length;

    try {
      const sonuc = await isle(urunler[i]);
      if (sonuc && sonuc.ok) basarili++;
      else hatalar.push(urunler[i].ad + ': ' + ((sonuc && sonuc.hata) || 'bilinmeyen hata'));
    } catch (e) {
      hatalar.push(urunler[i].ad + ': ' + String((e && e.message) || e));
    }

    izgSatiriTazele(urunler[i].id);
  }

  izgSecimCubuguTazele();

  if (hatalar.length) {
    bildir(basarili + ' ürün güncellendi, ' + hatalar.length + ' üründe hata:\n\n' +
           hatalar.slice(0, 5).join('\n') +
           (hatalar.length > 5 ? ('\n… ve ' + (hatalar.length - 5) + ' tane daha') : ''),
           basarili ? 'uyari' : 'hata');
  } else {
    bildir(basarili + ' ürün güncellendi.' + (izgDemoMu() ? '\n(Demo Modu)' : '\nSitede güncellendi.'),
           'basari');
  }

  return basarili;
}

/** TOPLU İSKONTO — seçili ürünlerin liste fiyatını yüzdeyle düşürür. */
/* --------------------------------------------------------------------------
 *  TOPLU KDV ATAMA
 *  --------------------------------------------------------------------------
 *  Seçili ürünlerin KDV oranı TEK istekte yazılır: eklentinin
 *  `POST wc-b2b/v1/products/vat` ucu yalnızca meta günceller (ürün başına
 *  wp_update_post çağrılmaz). Eklenti yoksa WooCommerce ucundan ürün ürün
 *  yazılır — o yolda ilerleme çubuğu görünür.
 * ------------------------------------------------------------------------*/
async function izgTopluKdv() {
  const urunler = izgSeciliUrunler();
  if (!urunler.length) return;

  const cevap = await metinSor(
    'Toplu KDV Ata',
    urunler.length + ' ürünün KDV oranı girdiğiniz değerle değiştirilecek.\n\n' +
    'Örnek: 10 yazarsanız seçili ürünler %10 KDV ile işlem görür.\n' +
    'KDV oranını yüzde olarak yazın (0-100):',
    '20',
    'ORANI UYGULA'
  );

  if (cevap === null) return;

  const oran = sayiCoz(String(cevap).replace('%', ''));

  if (!isFinite(oran) || isNaN(oran) || oran < 0 || oran > 100) {
    bildir('Geçerli bir KDV oranı yazın (0 ile 100 arasında).\nÖrnek: 20', 'uyari');
    return;
  }

  const yeni = Math.round(oran * 100) / 100;

  const eminMi = await onayla(
    'KDV Oranını Onayla',
    urunler.length + ' ürünün KDV oranı ' + izgKdvYazi(yeni) + ' olarak ayarlanacak.\n\n' +
    'Bu oran ürünün fiyatını DEĞİŞTİRMEZ; belge dökümünde (depo fişi, sipariş\n' +
    'özeti) ve "KDV hariç sipariş" dönüşümünde kullanılır.' +
    (izgDemoMu() ? '\n\n(Demo Modu: sitenizde değişiklik yapılmaz.)' : ''),
    'EVET, UYGULA',
    true
  );

  if (!eminMi) return;

  /* ---------- DEMO ---------- */
  if (izgDemoMu()) {
    await bekle(200);
    urunler.forEach(function (u) {
      u.kdv = yeni;
      const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
        .filter(function (x) { return String(x.id) === String(u.id); })[0];
      if (kaynak) kaynak.kdv = yeni;
    });
    izgCiz(true);
    bildir(urunler.length + ' ürünün KDV oranı ' + izgKdvYazi(yeni) + ' yapıldı.\n(Demo Modu)', 'basari');
    return;
  }

  /* ---------- CANLI: tek toplu istek ----------
     Eklenti kontrolü renderer-ek.js'in yardımcısıyla, o yüklenmediyse
     doğrudan durum.b2bVar ile yapılır (dosya sırası değişse de çalışsın). */
  const eklentiVar = (typeof ekEklentiVarMi === 'function')
    ? ekEklentiVarMi()
    : !!(typeof durum !== 'undefined' && durum && durum.b2bVar);

  if (eklentiVar) {
    const c = await b2b('products/vat', {
      metod: 'POST',
      govde: { ids: urunler.map(function (u) { return Number(u.id); }), rate: yeni },
      sureAsimi: 60000
    });

    if (c && c.ok) {
      const veri = c.veri || {};
      urunler.forEach(function (u) { u.kdv = yeni; });
      izgCiz(true);

      const atlanan = (veri.skipped && veri.skipped.length) || 0;
      bildir((veri.count || urunler.length) + ' ürünün KDV oranı ' + izgKdvYazi(yeni) + ' yapıldı.' +
             (atlanan ? '\n' + atlanan + ' ürün atlandı (bulunamadı).' : ''), 'basari');
      return;
    }

    /* Uç yoksa (eski eklenti) WooCommerce yoluna düşülür; başka hata gerçektir. */
    const kod = String((c && c.kod) || '');
    const http = Number(c && c.durum) || 0;

    if (!(kod === 'rest_no_route' || http === 404)) {
      bildir('KDV oranı yazılamadı:\n' + (typeof ekHataMetni === 'function' ? ekHataMetni(c) : ''), 'hata');
      return;
    }
  }

  /* ---------- YEDEK: WooCommerce ucundan ürün ürün ---------- */
  await izgTopluUygula(urunler, 'KDV oranı yazılıyor', async function (u) {
    const c = await woo('products/' + u.id, {
      metod: 'PUT',
      govde: { meta_data: [{ key: '_byom_kdv_rate', value: String(yeni) }] },
      sureAsimi: 30000
    });

    if (c && c.ok) { u.kdv = yeni; return { ok: true }; }
    return { ok: false, hata: (c && c.hata) || '' };
  });
}

async function izgTopluIskonto() {
  const urunler = izgSeciliUrunler();
  if (!urunler.length) return;

  const cevap = await metinSor(
    'Toplu İskonto Uygula',
    urunler.length + ' ürünün LİSTE FİYATI girdiğiniz oranda düşürülecek.\n\n' +
    'Örnek: 15 yazarsanız 100,00 ₺ olan ürün 85,00 ₺ olur.\n' +
    'İndirim oranını yüzde olarak yazın:',
    '10',
    'ORANI UYGULA'
  );

  if (cevap === null) return;

  const oran = sayiCoz(cevap);

  if (!isFinite(oran) || isNaN(oran) || oran <= 0 || oran >= 100) {
    bildir('Geçerli bir oran yazın (0 ile 100 arasında).\nÖrnek: 15', 'uyari');
    return;
  }

  /* Önizleme: kullanıcı ilk ürünün ne olacağını görsün. */
  const ornek = urunler[0];
  const yeniOrnek = ornek.fiyat * (1 - (oran / 100));

  const eminMi = await onayla(
    'İskontoyu Onayla',
    urunler.length + ' üründe liste fiyatı %' + oran + ' düşürülecek.\n\n' +
    'Örnek — ' + ornek.ad + '\n' +
    para(ornek.fiyat) + '  →  ' + para(yeniOrnek) + '\n\n' +
    'Bu işlem ürünlerin SİTEDEKİ fiyatını değiştirir ve geri alınamaz.' +
    (izgDemoMu() ? '\n\n(Demo Modu: sitenizde değişiklik yapılmaz.)' : ''),
    'EVET, UYGULA',
    true
  );

  if (!eminMi) return;

  await izgTopluUygula(urunler, 'İskonto uygulanıyor', async function (u) {
    /* Kuruşa yuvarlama TEK yerde yapılır; ekranda ve sitede aynı sayı durur. */
    const yeni = Math.round(u.fiyat * (1 - (oran / 100)) * 100) / 100;

    if (izgDemoMu()) {
      await bekle(60);
      u.fiyat = yeni;
      const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
        .filter(function (x) { return String(x.id) === String(u.id); })[0];
      if (kaynak) kaynak.fiyat = yeni;
      return { ok: true };
    }

    const c = await woo('products/' + u.id, {
      metod: 'PUT',
      govde: { regular_price: yeni.toFixed(2) },
      sureAsimi: 30000
    });

    if (c && c.ok) { u.fiyat = yeni; return { ok: true }; }
    return { ok: false, hata: (c && c.hata) || '' };
  });
}

/* --------------------------------------------------------------------------
 *  TOPLU ZAM
 *  --------------------------------------------------------------------------
 *  İskontonun aynadaki görüntüsü: fiyatı DÜŞÜRMEK yerine ARTIRIR ve iki
 *  artış türünü destekler.
 *
 *    Yüzde       →  Yeni Fiyat = Mevcut Fiyat * (1 + Zam / 100)
 *    Sabit tutar →  Yeni Fiyat = Mevcut Fiyat + Tutar
 *
 *  Yalnızca `regular_price` gönderilir; kampanyalı (indirimli) fiyata
 *  dokunulmaz. Liste fiyatını yükseltmek WooCommerce'in "indirimli fiyat
 *  liste fiyatından küçük olmalı" kuralını bozmaz.
 * ------------------------------------------------------------------------*/

/**
 * Zam sonrası fiyat.
 *
 * Kuruşa yuvarlama TEK yerde yapılır (iskontoda olduğu gibi); ekrandaki sayı
 * ile siteye giden sayı böylece hiç ayrışmaz.
 */
function izgZamliFiyat(mevcut, secim) {
  const taban = Number(mevcut) || 0;

  const yeni = (secim.tur === 'yuzde')
    ? taban * (1 + (Number(secim.miktar) / 100))
    : taban + Number(secim.miktar);

  if (!isFinite(yeni)) return taban;

  return Math.max(0, Math.round(yeni * 100) / 100);
}

/**
 * Toplu zam penceresi: artış türü ve miktar sorar.
 *
 * Promise<{tur:'yuzde'|'tutar', miktar:number} | null> döner (VAZGEÇ → null).
 */
function izgZamSor(urunler) {
  return new Promise(function (cozumle) {
    const katman = $('#zamModalKatman');
    const girdi = $('#zamMiktar');
    const birim = $('#zamBirim');
    const onizleme = $('#zamOnizleme');
    const uyari = $('#zamUyari');
    const tamamBtn = $('#zamTamam');
    const vazgecBtn = $('#zamVazgec');
    const yuzdeBtn = $('#zamTurYuzde');
    const tutarBtn = $('#zamTurTutar');

    if (!katman || !girdi) { cozumle(null); return; }

    /* Son kullanılan tür oturum boyunca hatırlanır: aynı zam çoğu zaman
       birkaç kategoriye arka arkaya uygulanıyor. */
    const g = izg();
    let tur = (g && g.zamTuru === 'tutar') ? 'tutar' : 'yuzde';

    $('#zamModalAciklama').textContent =
      urunler.length + ' ürünün LİSTE FİYATI artırılacak.';

    girdi.value = (tur === 'yuzde') ? '10' : '';

    function turuCiz() {
      yuzdeBtn.className = 'zam-tur' + (tur === 'yuzde' ? ' zam-tur-aktif' : '');
      tutarBtn.className = 'zam-tur' + (tur === 'tutar' ? ' zam-tur-aktif' : '');
      birim.textContent = (tur === 'yuzde') ? '%' : PARA_SIMGESI;
      girdi.placeholder = (tur === 'yuzde') ? 'Örnek: 10' : 'Örnek: 25,00';
    }

    /** Girilen miktarı çözer; geçersizse NaN döner. */
    function miktariOku() {
      const n = sayiCoz(girdi.value);
      if (!isFinite(n) || isNaN(n) || n <= 0) return NaN;
      /* Yüzde için akla yatkın tavan: 1000'in üstü neredeyse her zaman
         yanlış yazımdır (virgül yerine nokta, fazladan sıfır…). */
      if (tur === 'yuzde' && n > 1000) return NaN;
      return n;
    }

    function onizle() {
      const miktar = miktariOku();
      const gecerli = !isNaN(miktar);

      tamamBtn.disabled = !gecerli;
      tamamBtn.classList.toggle('opacity-40', !gecerli);
      tamamBtn.classList.toggle('cursor-not-allowed', !gecerli);

      if (!gecerli) {
        uyari.classList.remove('hidden');
        uyari.textContent = (tur === 'yuzde')
          ? 'Geçerli bir oran yazın (0 ile 1000 arasında). Örnek: 10'
          : 'Geçerli bir tutar yazın. Örnek: 25,00';
        onizleme.textContent = '';
        return;
      }

      uyari.classList.add('hidden');

      const secim = { tur: tur, miktar: miktar };
      const ornek = urunler[0];
      const yeniOrnek = izgZamliFiyat(ornek.fiyat, secim);

      let eskiToplam = 0;
      let yeniToplam = 0;
      urunler.forEach(function (u) {
        eskiToplam += Number(u.fiyat) || 0;
        yeniToplam += izgZamliFiyat(u.fiyat, secim);
      });

      onizleme.innerHTML =
        '<div class="text-slate-500 dark:text-slate-400">ÖRNEK — ' + kacis(ornek.ad) + '</div>' +
        '<div class="text-xl font-black mt-1">' +
          kacis(para(ornek.fiyat)) +
          ' <span class="text-rose-600">→</span> ' +
          '<span class="text-rose-600">' + kacis(para(yeniOrnek)) + '</span>' +
        '</div>' +
        '<div class="mt-2 text-slate-500 dark:text-slate-400">' +
          'Seçili ' + urunler.length + ' ürünün toplam liste değeri: ' +
          kacis(para(eskiToplam)) + ' → ' + kacis(para(yeniToplam)) +
        '</div>';
    }

    function kapat(sonuc) {
      katman.classList.add('hidden');
      tamamBtn.removeEventListener('click', evet);
      vazgecBtn.removeEventListener('click', hayir);
      yuzdeBtn.removeEventListener('click', yuzdeSec);
      tutarBtn.removeEventListener('click', tutarSec);
      girdi.removeEventListener('input', onizle);
      girdi.removeEventListener('keydown', girdiTusu);
      katman.removeEventListener('mousedown', disariTikla);
      document.removeEventListener('keydown', tusla);
      cozumle(sonuc);
    }

    function evet() {
      const miktar = miktariOku();
      if (isNaN(miktar)) { onizle(); girdi.focus(); return; }
      if (g) g.zamTuru = tur;
      kapat({ tur: tur, miktar: miktar });
    }
    function hayir() { kapat(null); }
    function yuzdeSec() { tur = 'yuzde'; turuCiz(); onizle(); girdi.focus(); }
    function tutarSec() { tur = 'tutar'; turuCiz(); onizle(); girdi.focus(); }
    function girdiTusu(o) { if (o.key === 'Enter') { o.preventDefault(); evet(); } }
    function disariTikla(o) { if (o.target === katman) kapat(null); }
    function tusla(o) { if (o.key === 'Escape') kapat(null); }

    tamamBtn.addEventListener('click', evet);
    vazgecBtn.addEventListener('click', hayir);
    yuzdeBtn.addEventListener('click', yuzdeSec);
    tutarBtn.addEventListener('click', tutarSec);
    girdi.addEventListener('input', onizle);
    girdi.addEventListener('keydown', girdiTusu);
    katman.addEventListener('mousedown', disariTikla);
    document.addEventListener('keydown', tusla);

    turuCiz();
    onizle();
    katman.classList.remove('hidden');
    setTimeout(function () { girdi.focus(); girdi.select(); }, 30);
  });
}

/** TOPLU ZAM — seçili ürünlerin liste fiyatını yüzde ya da sabit tutarla artırır. */
async function izgTopluZam() {
  const urunler = izgSeciliUrunler();
  if (!urunler.length) return;

  const secim = await izgZamSor(urunler);
  if (!secim) return;

  const ornek = urunler[0];
  const yeniOrnek = izgZamliFiyat(ornek.fiyat, secim);
  const artisYazi = (secim.tur === 'yuzde')
    ? ('%' + oranYaz(secim.miktar))
    : para(secim.miktar);

  const eminMi = await onayla(
    'Zammı Onayla',
    urunler.length + ' üründe liste fiyatı ' + artisYazi + ' artırılacak.\n\n' +
    'Örnek — ' + ornek.ad + '\n' +
    para(ornek.fiyat) + '  →  ' + para(yeniOrnek) + '\n\n' +
    'Bu işlem ürünlerin SİTEDEKİ fiyatını değiştirir ve geri alınamaz.' +
    (izgDemoMu() ? '\n\n(Demo Modu: sitenizde değişiklik yapılmaz.)' : ''),
    'EVET, UYGULA',
    true
  );

  if (!eminMi) return;

  await izgTopluUygula(urunler, 'Zam uygulanıyor', async function (u) {
    const yeni = izgZamliFiyat(u.fiyat, secim);

    if (izgDemoMu()) {
      await bekle(60);
      u.fiyat = yeni;
      const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
        .filter(function (x) { return String(x.id) === String(u.id); })[0];
      if (kaynak) kaynak.fiyat = yeni;
      return { ok: true };
    }

    const c = await woo('products/' + u.id, {
      metod: 'PUT',
      govde: { regular_price: yeni.toFixed(2) },
      sureAsimi: 30000
    });

    if (c && c.ok) { u.fiyat = yeni; return { ok: true }; }
    return { ok: false, hata: (c && c.hata) || '' };
  });
}

/** TOPLU KATEGORİ — seçili ürünleri tek bir kategoriye taşır. */
async function izgTopluKategori() {
  const urunler = izgSeciliUrunler();
  if (!urunler.length) return;

  const g = izg();
  if (!g.kategorilerYuklendi) await izgKategorileriYukle();

  if (!g.kategoriler.length) {
    bildir('Kategori bulunamadı.\nÖnce soldaki panelden kategori ekleyin.', 'uyari');
    return;
  }

  const secim = await izgKategoriSor(
    'Toplu Kategori Değiştir',
    urunler.length + ' ürün seçilen kategoriye taşınacak.'
  );

  if (secim === null) return;

  const hedef = g.kategoriler.filter(function (k) { return String(k.id) === String(secim); })[0];
  if (!hedef) return;

  await izgTopluUygula(urunler, 'Kategori değiştiriliyor', async function (u) {
    if (izgDemoMu()) {
      await bekle(60);
      u.kategoriler = [{ id: hedef.id, ad: hedef.ad }];
      const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
        .filter(function (x) { return String(x.id) === String(u.id); })[0];
      if (kaynak) kaynak.kategoriler = [{ id: hedef.id, ad: hedef.ad }];
      return { ok: true };
    }

    const c = await woo('products/' + u.id, {
      metod: 'PUT',
      govde: { categories: [{ id: Number(hedef.id) }] },
      sureAsimi: 30000
    });

    if (c && c.ok) { u.kategoriler = [{ id: hedef.id, ad: hedef.ad }]; return { ok: true }; }
    return { ok: false, hata: (c && c.hata) || '' };
  });

  izgCiz(true);
  izgKategoriAgaciCiz();
}

/** TOPLU DURUM — seçili ürünleri yayına / taslağa alır. */
async function izgTopluDurum(hedefDurum) {
  const urunler = izgSeciliUrunler().filter(function (u) { return u.durum !== hedefDurum; });

  if (!urunler.length) {
    bildir('Seçili ürünlerin tamamı zaten ' +
           (hedefDurum === 'publish' ? 'yayında.' : 'taslak.'), 'bilgi');
    return;
  }

  const yayinlaMi = hedefDurum === 'publish';

  const eminMi = await onayla(
    yayinlaMi ? 'Toplu Yayına Al' : 'Toplu Taslağa Al',
    urunler.length + ' ürün ' +
    (yayinlaMi
      ? 'YAYINA alınacak ve sitenizde görünecek.'
      : 'TASLAK yapılacak ve sitenizden kaldırılacak.') +
    (izgDemoMu() ? '\n\n(Demo Modu: sitenizde değişiklik yapılmaz.)' : ''),
    yayinlaMi ? 'EVET, YAYINLA' : 'EVET, TASLAĞA AL',
    !yayinlaMi
  );

  if (!eminMi) return;

  await izgTopluUygula(urunler, yayinlaMi ? 'Yayınlanıyor' : 'Taslağa alınıyor', async function (u) {
    if (izgDemoMu()) {
      await bekle(60);
      u.durum = hedefDurum;
      const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
        .filter(function (x) { return String(x.id) === String(u.id); })[0];
      if (kaynak) kaynak.durum = hedefDurum;
      return { ok: true };
    }

    const c = await woo('products/' + u.id, {
      metod: 'PUT',
      govde: { status: hedefDurum },
      sureAsimi: 30000
    });

    if (c && c.ok) { u.durum = hedefDurum; return { ok: true }; }
    return { ok: false, hata: (c && c.hata) || '' };
  });

  izgCiz(true);
}

/** Tek ürünün yayın durumunu değiştirir (ızgaradaki rozet). */
async function izgDurumDegistir(id) {
  const u = izgUrunBul(id);
  if (!u) return;

  const gizlenecekMi = u.durum === 'publish';
  const hedef = gizlenecekMi ? 'draft' : 'publish';
  const onceki = u.durum;

  /* İyimser: rozet anında değişir. */
  u.durum = hedef;
  izgSatiriTazele(id);

  let basarili = true;
  let hataMesaji = '';

  if (izgDemoMu()) {
    await bekle(120);
    const kaynak = (typeof DEMO_URUNLER !== 'undefined' ? DEMO_URUNLER : [])
      .filter(function (x) { return String(x.id) === String(id); })[0];
    if (kaynak) kaynak.durum = hedef;
  } else {
    const c = await woo('products/' + id, { metod: 'PUT', govde: { status: hedef }, sureAsimi: 30000 });
    basarili = !!(c && c.ok);
    hataMesaji = (c && c.hata) || '';
  }

  if (!basarili) {
    u.durum = onceki;
    izgSatiriTazele(id);
    bildir('Durum değiştirilemedi:\n' + hataMesaji, 'hata');
    return;
  }

  /* Durum süzgeci açıksa ve ürün artık uymuyorsa listeden düşür. */
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  if (d && d.urunDurumSuzgec && d.urunDurumSuzgec !== hedef) {
    d.urunler = d.urunler.filter(function (x) { return String(x.id) !== String(id); });
    izgCiz(true);
  }

  bildir(u.ad + '\n' + (gizlenecekMi ? 'Ürün gizlendi (taslak).' : 'Ürün yayınlandı.') +
         (izgDemoMu() ? '\n(Demo Modu)' : ''), gizlenecekMi ? 'uyari' : 'basari');
}

/* ==========================================================================
 *  BÖLÜM E — KATEGORİ AĞACI
 * ========================================================================*/

/**
 * Kategorileri (ebeveyn bilgisiyle birlikte) çeker.
 *
 * renderer.js'teki `tumKategorileriGetir` yalnızca id ve ad döndürüyor;
 * ağaç için `parent` ve `count` de gerekiyor, o yüzden burada ayrı okunur.
 */
async function izgKategorileriYukle() {
  const g = izg();
  if (!g) return;

  if (izgDemoMu()) {
    await bekle(80);
    g.kategoriler = (typeof DEMO_KATEGORILER !== 'undefined' ? DEMO_KATEGORILER : [])
      .map(function (k) {
        return { id: Number(k.id), ad: String(k.ad || k.name || ''), ust: 0, adet: 0 };
      });
    g.kategorilerYuklendi = true;
    return;
  }

  const cevap = await tumSayfalariGetir('woo', 'products/categories',
    { orderby: 'name', order: 'asc' }, { sureAsimi: 30000 });

  if (!cevap || !cevap.ok) {
    g.kategoriler = [];
    g.kategorilerYuklendi = false;
    return;
  }

  g.kategoriler = (cevap.veri || []).map(function (k) {
    return {
      id: Number(k.id),
      ad: String(k.name || ''),
      ust: Number(k.parent || 0),
      adet: Number(k.count || 0)
    };
  });

  g.kategorilerYuklendi = true;
}

/** Kategori ağacını sol panele çizer. */
function izgKategoriAgaciCiz() {
  const g = izg();
  const kap = $('#kategoriAgaci');
  if (!g || !kap) return;

  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  const urunler = (d && d.urunler) || [];

  /* Hafızadaki ürünlere göre gerçek sayım: sunucudaki `count` yayında olmayan
     ürünleri saymayabiliyor, panelde taslaklar da görünüyor. */
  const sayim = Object.create(null);
  let kategorisiz = 0;

  urunler.forEach(function (u) {
    const kl = u.kategoriler || [];
    if (!kl.length) { kategorisiz++; return; }
    kl.forEach(function (k) {
      sayim[k.id] = (sayim[k.id] || 0) + 1;
    });
  });

  function dugmeHtml(etiket, id, adet, derinlik, ekSinif) {
    const aktifMi = g.kategoriSuzgec === id;

    return '' +
      '<div class="flex items-stretch gap-1" style="padding-left:' + (derinlik * 14) + 'px">' +
        '<button type="button" data-kat-suz="' + id + '" ' +
                'class="kat-dugme flex-1 ' + (aktifMi ? 'kat-aktif' : '') + ' ' + (ekSinif || '') + '">' +
          '<span class="kat-ad">' + kacis(etiket) + '</span>' +
          '<span class="kat-adet">' + adet + '</span>' +
        '</button>' +
        (id > 0
          ? '<button type="button" data-kat-duzenle="' + id + '" title="Kategoriyi yeniden adlandır" ' +
                    'aria-label="Kategoriyi yeniden adlandır" class="kat-islem">' + ikon('kalem') + '</button>' +
            '<button type="button" data-kat-sil="' + id + '" title="Kategoriyi sil" ' +
                    'aria-label="Kategoriyi sil" class="kat-islem kat-islem-sil">' + ikon('cop') + '</button>'
          : '') +
      '</div>';
  }

  /* Ağaç: yalnızca iki düzey değil, herhangi bir derinlik desteklenir. */
  const cocuklar = Object.create(null);
  g.kategoriler.forEach(function (k) {
    (cocuklar[k.ust] = cocuklar[k.ust] || []).push(k);
  });

  /* Sahipsiz kalan dallar (üstü silinmiş) kök seviyeye alınır ki gizlenmesin. */
  const kimlikler = Object.create(null);
  g.kategoriler.forEach(function (k) { kimlikler[k.id] = true; });
  g.kategoriler.forEach(function (k) {
    if (k.ust && !kimlikler[k.ust]) (cocuklar[0] = cocuklar[0] || []).push(k);
  });

  const parcalar = [];
  const gezildi = Object.create(null);

  function daliCiz(ustId, derinlik) {
    (cocuklar[ustId] || []).forEach(function (k) {
      if (gezildi[k.id] || derinlik > 6) return;   // döngü koruması
      gezildi[k.id] = true;

      parcalar.push(dugmeHtml(k.ad, k.id, sayim[k.id] || 0, derinlik));
      daliCiz(k.id, derinlik + 1);
    });
  }

  parcalar.push(dugmeHtml('Tüm Ürünler', 0, urunler.length, 0, 'kat-tumu'));
  daliCiz(0, 0);

  if (kategorisiz > 0) parcalar.push(dugmeHtml('Kategorisiz', -1, kategorisiz, 0));

  if (!g.kategoriler.length) {
    parcalar.push('<div class="p-4 text-base font-semibold text-slate-500 dark:text-slate-400 text-center">' +
                  'Kategori bulunamadı.<br />YENİ KATEGORİ ile ekleyebilirsiniz.</div>');
  }

  kap.innerHTML = parcalar.join('');
}

/** Yeni kategori ekler. */
async function izgKategoriEkle() {
  const ad = await metinSor('Yeni Kategori', 'Kategori adını yazın:', '', 'KATEGORİ EKLE');
  if (ad === null) return;

  const temiz = String(ad).trim();
  if (!temiz) { bildir('Kategori adı boş olamaz.', 'uyari'); return; }

  const g = izg();

  if (izgDemoMu()) {
    await bekle(120);
    const yeniId = Math.max(0, ...g.kategoriler.map(function (k) { return k.id; })) + 1;
    g.kategoriler.push({ id: yeniId, ad: temiz, ust: 0, adet: 0 });
    izgKategoriAgaciCiz();
    bildir('Kategori eklendi: ' + temiz + '\n(Demo Modu)', 'basari');
    return;
  }

  const cevap = await woo('products/categories', { metod: 'POST', govde: { name: temiz } });

  if (!cevap || !cevap.ok) {
    bildir('Kategori eklenemedi:\n' + ((cevap && cevap.hata) || 'Bilinmeyen hata'), 'hata');
    return;
  }

  g.kategoriler.push({
    id: Number(cevap.veri.id),
    ad: String(cevap.veri.name || temiz),
    ust: Number(cevap.veri.parent || 0),
    adet: 0
  });

  g.kategoriler.sort(function (a, b) { return a.ad.localeCompare(b.ad, 'tr'); });
  izgKategoriAgaciCiz();
  bildir('Kategori eklendi: ' + temiz, 'basari');
}

/** Kategoriyi yeniden adlandırır. */
async function izgKategoriDuzenle(id) {
  const g = izg();
  const kat = g.kategoriler.filter(function (k) { return String(k.id) === String(id); })[0];
  if (!kat) return;

  const ad = await metinSor('Kategoriyi Yeniden Adlandır',
                            'Yeni adı yazın:', kat.ad, 'KAYDET');
  if (ad === null) return;

  const temiz = String(ad).trim();
  if (!temiz || temiz === kat.ad) return;

  const onceki = kat.ad;
  kat.ad = temiz;                 // iyimser
  izgKategoriAgaciCiz();

  if (izgDemoMu()) {
    await bekle(120);
    bildir('Kategori adı güncellendi.\n(Demo Modu)', 'basari');
    return;
  }

  const cevap = await woo('products/categories/' + id, { metod: 'PUT', govde: { name: temiz } });

  if (!cevap || !cevap.ok) {
    kat.ad = onceki;
    izgKategoriAgaciCiz();
    bildir('Kategori güncellenemedi:\n' + ((cevap && cevap.hata) || ''), 'hata');
    return;
  }

  /* Ürün kayıtlarındaki kategori adı da tazelensin (ızgara sütunu okuyor). */
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  if (d) {
    d.urunler.forEach(function (u) {
      (u.kategoriler || []).forEach(function (k) {
        if (String(k.id) === String(id)) k.ad = temiz;
      });
    });
  }

  izgCiz(true);
  bildir('Kategori adı güncellendi: ' + temiz, 'basari');
}

/** Kategoriyi siler. */
async function izgKategoriSil(id) {
  const g = izg();
  const kat = g.kategoriler.filter(function (k) { return String(k.id) === String(id); })[0];
  if (!kat) return;

  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  const etkilenen = ((d && d.urunler) || []).filter(function (u) {
    return (u.kategoriler || []).some(function (k) { return String(k.id) === String(id); });
  }).length;

  const eminMi = await onayla(
    'Kategoriyi Sil',
    '"' + kat.ad + '" kategorisi silinecek.\n\n' +
    (etkilenen
      ? (etkilenen + ' ürün bu kategoride. Ürünler SİLİNMEZ; yalnızca ' +
         'kategorisiz kalır ve sitede "Kategorisiz" altında görünür.\n\n')
      : '') +
    'Bu işlem geri alınamaz.' +
    (izgDemoMu() ? '\n\n(Demo Modu: sitenizde değişiklik yapılmaz.)' : ''),
    'EVET, SİL',
    true
  );

  if (!eminMi) return;

  if (!izgDemoMu()) {
    /* force=true olmadan WooCommerce kategoriyi çöp kutusuna atmaz, siler;
       terim (term) nesneleri çöp kutusunu desteklemez. */
    const cevap = await woo('products/categories/' + id + '?force=true', { metod: 'DELETE' });

    if (!cevap || !cevap.ok) {
      bildir('Kategori silinemedi:\n' + ((cevap && cevap.hata) || ''), 'hata');
      return;
    }
  } else {
    await bekle(120);
  }

  g.kategoriler = g.kategoriler.filter(function (k) { return String(k.id) !== String(id); });

  /* Ürünlerdeki referansı da düşür. */
  if (d) {
    d.urunler.forEach(function (u) {
      u.kategoriler = (u.kategoriler || []).filter(function (k) { return String(k.id) !== String(id); });
    });
  }

  if (g.kategoriSuzgec === Number(id)) g.kategoriSuzgec = 0;

  izgKategoriAgaciCiz();
  izgCiz(false);
  bildir('Kategori silindi: ' + kat.ad + (izgDemoMu() ? '\n(Demo Modu)' : ''), 'basari');
}

/** Kategori süzgecini uygular. */
function izgKategoriSuz(id) {
  const g = izg();
  if (!g) return;

  g.kategoriSuzgec = Number(id);
  izgKategoriAgaciCiz();
  izgCiz(false);

  /* Kart görünümündeyken de süzgeç geçerli olsun. */
  if (g.gorunum === 'kart') izgKartGorunumunuCiz();
}

/**
 * Kategori seçtiren küçük pencere.
 *
 * Yeni bir modal HTML'i eklemek yerine mevcut `metinSor` altyapısı
 * kullanılamadı (o yalnızca serbest metin alıyor); bu yüzden basit ve
 * erişilebilir bir seçim penceresi burada kuruluyor.
 */
function izgKategoriSor(baslik, aciklama) {
  const g = izg();

  return new Promise(function (cozumle) {
    const katman = document.createElement('div');
    katman.className = 'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm grid place-items-center p-6';

    const secenekler = g.kategoriler.map(function (k) {
      return '<option value="' + k.id + '">' + kacis(k.ad) + '</option>';
    }).join('');

    katman.innerHTML =
      '<div class="w-full max-w-xl bg-white dark:bg-slate-800 rounded-3xl shadow-2xl ' +
                  'border-2 border-slate-200 dark:border-slate-700 overflow-hidden">' +
        '<div class="p-6 border-b-2 border-slate-200 dark:border-slate-700">' +
          '<div class="text-2xl font-black">' + kacis(baslik) + '</div>' +
          '<div class="text-lg text-slate-600 dark:text-slate-300 mt-1">' + kacis(aciklama) + '</div>' +
        '</div>' +
        '<div class="p-6">' +
          '<label for="izgKatSecim" class="block text-lg font-extrabold mb-2">Hedef Kategori</label>' +
          '<select id="izgKatSecim" class="w-full h-14 px-4 rounded-xl text-lg font-bold ' +
                  'bg-slate-50 dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-600 ' +
                  'focus:border-marka-600 outline-none transition">' + secenekler + '</select>' +
        '</div>' +
        '<div class="flex gap-3 p-5 bg-slate-50 dark:bg-slate-900/50 border-t-2 ' +
                    'border-slate-200 dark:border-slate-700">' +
          '<button id="izgKatVazgec" class="flex-1 h-16 rounded-2xl text-xl font-extrabold ' +
                  'bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 ' +
                  'transition active:scale-95">VAZGEÇ</button>' +
          '<button id="izgKatTamam" class="flex-[2] h-16 rounded-2xl text-xl font-extrabold text-white ' +
                  'bg-marka-700 hover:bg-marka-800 transition active:scale-95 shadow-lg">UYGULA</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(katman);

    const sec = katman.querySelector('#izgKatSecim');
    setTimeout(function () { sec.focus(); }, 30);

    function kapat(sonuc) {
      document.removeEventListener('keydown', tusla);
      katman.remove();
      cozumle(sonuc);
    }
    function tusla(o) { if (o.key === 'Escape') kapat(null); }

    katman.querySelector('#izgKatTamam').addEventListener('click', function () { kapat(sec.value); });
    katman.querySelector('#izgKatVazgec').addEventListener('click', function () { kapat(null); });
    katman.addEventListener('mousedown', function (o) { if (o.target === katman) kapat(null); });
    document.addEventListener('keydown', tusla);
  });
}

/* ==========================================================================
 *  BÖLÜM F — GÖRÜNÜM YÖNETİMİ VE OLAY BAĞLAMA
 * ========================================================================*/

/** Kart görünümünü (eski liste) kategori süzgecini de uygulayarak çizer. */
function izgKartGorunumunuCiz() {
  const d = (typeof durum !== 'undefined' && durum) ? durum : null;
  const g = izg();
  if (!d || !g) return;

  /* urunleriCiz TÜM durum.urunler'i çizer; kategori süzgeci için listeyi
     geçici olarak daraltıp sonra geri koyuyoruz. Kopya değil ASIL diziyi
     değiştirmek şart: sıralama kodu (renderer-ek) da aynı diziyi okuyor. */
  if (g.kategoriSuzgec === 0) {
    urunleriCiz(izgDemoMu() ? ($('#urunArama') ? $('#urunArama').value : '') : '');
    return;
  }

  const tamam = d.urunler;
  d.urunler = izgFiltreliListe();

  try {
    urunleriCiz('');
  } finally {
    d.urunler = tamam;
  }
}

/** Görünümü değiştirir (tablo / kart) ve ayarlara yazar. */
function izgGorunumSec(gorunum) {
  const g = izg();
  if (!g) return;

  g.gorunum = (gorunum === 'kart') ? 'kart' : 'tablo';

  const izgara = $('#urunIzgara');
  const liste = $('#urunListesi');
  const tabloBtn = $('#gorunumTabloBtn');
  const kartBtn = $('#gorunumKartBtn');

  const tabloMu = g.gorunum === 'tablo';

  if (izgara) izgara.classList.toggle('hidden', !tabloMu);
  if (liste) {
    liste.classList.toggle('hidden', tabloMu);
    liste.classList.toggle('flex', !tabloMu);
  }

  const aktif = 'bg-marka-700 text-white shadow';
  const pasif = 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600';

  if (tabloBtn) tabloBtn.className = 'gorunum-btn h-12 px-5 rounded-xl text-lg font-extrabold transition ' +
                                    (tabloMu ? aktif : pasif);
  if (kartBtn) kartBtn.className = 'gorunum-btn h-12 px-5 rounded-xl text-lg font-extrabold transition ' +
                                  (tabloMu ? pasif : aktif);

  if (tabloMu) izgCiz(false);
  else izgKartGorunumunuCiz();

  /* Seçim yalnızca tablo görünümünde anlamlı. */
  const cubuk = $('#topluCubuk');
  if (cubuk && !tabloMu) { cubuk.classList.add('hidden'); cubuk.classList.remove('flex'); }
  else izgSecimCubuguTazele();

  /* Tercih kalıcı olsun. */
  if (typeof ipcRenderer !== 'undefined' && durum && durum.ayarlar &&
      durum.ayarlar.urunGorunumu !== g.gorunum) {
    ipcRenderer.invoke('ayar:yaz', { urunGorunumu: g.gorunum }).then(function (yeni) {
      if (yeni) durum.ayarlar = yeni;
    }).catch(function () { /* Görünüm tercihi kozmetiktir; sessiz geç. */ });
  }
}

/** Kategori panelini açar / kapatır. */
function izgKategoriPaneliDegistir() {
  const g = izg();
  const govde = $('#kategoriPanelGovde');
  const baslik = $('#kategoriPanelBaslik');
  const ok = $('#kategoriOk');
  if (!g || !govde) return;

  g.kategoriAcik = !g.kategoriAcik;

  govde.classList.toggle('hidden', !g.kategoriAcik);
  if (baslik) baslik.setAttribute('aria-expanded', g.kategoriAcik ? 'true' : 'false');
  if (ok) ok.style.transform = g.kategoriAcik ? '' : 'rotate(-90deg)';
}

/** Ürün sekmesi açıldığında çağrılır. */
async function izgSekmeAcildi() {
  const g = izg();
  if (!g) return;

  /*
   * Kayitli gorunum tercihi ILK acilista geri okunur.
   *
   * Yalnizca bir kez: kullanici oturum icinde gorunum degistirdiginde
   * ayara yaziliyor, her sekme acilisinda ayardan okunsaydi o degisiklik
   * bir sonraki sekme gecisinde geri alinabilirdi (yaris durumu).
   */
  if (!g.gorunumOkundu) {
    g.gorunumOkundu = true;

    const d = (typeof durum !== 'undefined' && durum) ? durum : null;
    const kayitli = d && d.ayarlar ? d.ayarlar.urunGorunumu : '';

    if (kayitli === 'kart' || kayitli === 'tablo') g.gorunum = kayitli;
  }

  izgGorunumSec(g.gorunum);

  if (!g.kategorilerYuklendi) {
    await izgKategorileriYukle();
  }

  izgKategoriAgaciCiz();
}

/** Olayları bağlar (tek sefer). */
function izgOlaylariBagla() {
  const bolum = $('#sekme-urunler');
  if (!bolum || bolum.dataset.izgBagli === '1') return;
  bolum.dataset.izgBagli = '1';

  /* --- Görünüm anahtarı --- */
  const tabloBtn = $('#gorunumTabloBtn');
  const kartBtn = $('#gorunumKartBtn');
  if (tabloBtn) tabloBtn.addEventListener('click', function () { izgGorunumSec('tablo'); });
  if (kartBtn) kartBtn.addEventListener('click', function () { izgGorunumSec('kart'); });

  /* --- Kategori paneli --- */
  const panelBaslik = $('#kategoriPanelBaslik');
  if (panelBaslik) panelBaslik.addEventListener('click', izgKategoriPaneliDegistir);

  const katEkle = $('#kategoriEkleBtn');
  if (katEkle) katEkle.addEventListener('click', izgKategoriEkle);

  const agac = $('#kategoriAgaci');
  if (agac) {
    agac.addEventListener('click', function (o) {
      const suz = o.target.closest ? o.target.closest('[data-kat-suz]') : null;
      if (suz) { izgKategoriSuz(suz.getAttribute('data-kat-suz')); return; }

      const duzenle = o.target.closest ? o.target.closest('[data-kat-duzenle]') : null;
      if (duzenle) { izgKategoriDuzenle(duzenle.getAttribute('data-kat-duzenle')); return; }

      const sil = o.target.closest ? o.target.closest('[data-kat-sil]') : null;
      if (sil) { izgKategoriSil(sil.getAttribute('data-kat-sil')); }
    });
  }

  /* --- Toplu işlem düğmeleri --- */
  const bagla = function (secici, islev) {
    const el = $(secici);
    if (el) el.addEventListener('click', islev);
  };

  bagla('#topluKdvBtn', izgTopluKdv);
  bagla('#topluIskontoBtn', izgTopluIskonto);
  bagla('#topluZamBtn', izgTopluZam);
  bagla('#topluKategoriBtn', izgTopluKategori);
  bagla('#topluYayinlaBtn', function () { izgTopluDurum('publish'); });
  bagla('#topluTaslakBtn', function () { izgTopluDurum('draft'); });
  bagla('#topluTemizleBtn', izgSecimiTemizle);

  /* --- Izgara olayları (olay devri) --- */
  const izgara = $('#urunIzgara');
  if (izgara) {
    izgara.addEventListener('change', function (o) {
      const kutu = o.target.closest ? o.target.closest('[data-izg-sec]') : null;
      if (kutu) izgSecimDegistir(kutu.getAttribute('data-izg-sec'), !!kutu.checked);
    });

    izgara.addEventListener('click', function (o) {
      const yakin = function (secici) {
        return o.target && o.target.closest ? o.target.closest(secici) : null;
      };

      /* YAYINDA / GİZLİ rozeti */
      const rozet = yakin('[data-izg-durum]');
      if (rozet) { izgDurumDegistir(rozet.getAttribute('data-izg-durum')); return; }

      /* Satır sonu: KALEM (düzenle) ve ÇÖP KUTUSU (sil).
         Bu devir ızgaranın KENDİ kabında kurulur; kart görünümünün
         #urunListesi dinleyicileri buraya hiç ulaşmıyor (bkz. izgUrunDuzenle
         başlığındaki not). İki dinleyici çakışmaz: kaplar ayrıdır. */
      const duzenle = yakin('[data-eylem="urun-duzenle"]');
      if (duzenle) { izgUrunDuzenle(duzenle.getAttribute('data-id')); return; }

      const sil = yakin('[data-eylem="urun-sil"]');
      if (sil) { izgUrunSil(sil.getAttribute('data-id'), sil); return; }
    });

    izgara.addEventListener('dblclick', function (o) {
      const hucre = o.target.closest ? o.target.closest('[data-duzenle]') : null;
      if (hucre) izgHucreAc(hucre);
    });
  }
}

/* ==========================================================================
 *  BÖLÜM G — MEVCUT AKIŞLARA BAĞLANMA
 *  --------------------------------------------------------------------------
 *  renderer.js'teki fonksiyonlar sarmalanır (monkey-patch). Böylece o
 *  dosyadaki çağrı yerlerinin hiçbiri değişmiyor; ızgara var olan akışa
 *  ekleniyor. Sarma İDEMPOTENTTİR: dosya iki kez yüklense de zincir
 *  büyümez.
 * ========================================================================*/

(function izgBagla() {
  /* --- sekmeAc: ürün sekmesi açılınca ızgarayı hazırla --- */
  if (typeof sekmeAc === 'function' && !sekmeAc.izgSarildi) {
    const eskiSekmeAc = sekmeAc;

    sekmeAc = function (ad) {
      eskiSekmeAc.apply(this, arguments);

      if (ad === 'urunler') {
        izgOlaylariBagla();
        izgSekmeAcildi();
      }
    };

    sekmeAc.izgSarildi = true;
  }

  /* --- urunleriCiz: tablo görünümündeyken ızgarayı da tazele --- */
  if (typeof urunleriCiz === 'function' && !urunleriCiz.izgSarildi) {
    const eskiCiz = urunleriCiz;

    urunleriCiz = function (arama) {
      eskiCiz.apply(this, arguments);

      const g = izg();
      if (!g) return;

      /* Kategori ağacındaki sayılar ürün listesine bağlı; birlikte tazelenir. */
      izgKategoriAgaciCiz();

      if (g.gorunum === 'tablo') {
        /* Liste yeniden çizildi: seçimden artık var olmayan kimlikleri düş. */
        const d = (typeof durum !== 'undefined' && durum) ? durum : null;
        if (d) {
          const varOlan = Object.create(null);
          d.urunler.forEach(function (u) { varOlan[u.id] = true; });
          Object.keys(g.secili).forEach(function (id) {
            if (!varOlan[id]) delete g.secili[id];
          });
        }

        g.tazeleGerek = true;
        izgCiz(true);
      }
    };

    urunleriCiz.izgSarildi = true;
  }
}());

/* ==========================================================================
 *  BÖLÜM H — AKICILIK: YAPIŞKAN KATEGORİ HAPLARI, ARAMA KISAYOLLARI
 *  --------------------------------------------------------------------------
 *  Vitrin Editörü'ndeki tasarım dili ürün yönetimine taşınır:
 *   - Tablonun tepesine yapışkan "kategori hapları": tıklanınca liste
 *     SUNUCUYA GİTMEDEN (izgKategoriSuz → yerel süzgeç) anında süzülür.
 *     Sol ağaç ve haplar aynı süzgeci paylaşır; biri değişince öteki de
 *     işaretlenir.
 *   - Arama kutusu: hızlı temizle düğmesi (×, Esc) ve Ctrl/⌘+F kısayolu.
 *   - Geçişler (150ms ease-out) ve rakam hizası CSS'te (index.html).
 *
 *  BÖLÜM G ile aynı desen: mevcut fonksiyonlar sarmalanır, çağrı yerleri
 *  değişmez, sarma idempotenttir.
 * ========================================================================*/

(function izgAkicilik() {
  var HAP_SINIRI = 18;

  /** Kategori haplarını çizer (ürün sayısına göre sıralı, en çok 18 + Tümü + Kategorisiz). */
  function izgKategoriHaplariCiz() {
    var g = izg();
    var kap = $('#izgKategoriHaplari');
    if (!g || !kap) return;

    var d = (typeof durum !== 'undefined' && durum) ? durum : null;
    var urunler = (d && d.urunler) || [];

    var sayim = Object.create(null);
    var kategorisiz = 0;
    urunler.forEach(function (u) {
      var kl = u.kategoriler || [];
      if (!kl.length) { kategorisiz++; return; }
      kl.forEach(function (k) { sayim[k.id] = (sayim[k.id] || 0) + 1; });
    });

    var liste = (g.kategoriler || []).map(function (k) {
      return { id: Number(k.id), ad: String(k.ad || ''), adet: sayim[k.id] || 0 };
    }).sort(function (a, b) {
      return (b.adet - a.adet) || a.ad.localeCompare(b.ad, 'tr');
    }).slice(0, HAP_SINIRI);

    var hap = function (etiket, id, adet) {
      var aktif = Number(g.kategoriSuzgec) === Number(id);
      return '<button type="button" role="tab" aria-selected="' + (aktif ? 'true' : 'false') + '" ' +
               'class="izg-hap' + (aktif ? ' is-on' : '') + '" data-izg-hap="' + id + '">' +
               '<span>' + kacis(etiket) + '</span><span class="izg-hap__adet">' + adet + '</span></button>';
    };

    var html = hap('Tüm Ürünler', 0, urunler.length);
    if (kategorisiz) html += hap('Kategorisiz', -1, kategorisiz);
    html += liste.map(function (k) { return hap(k.ad, k.id, k.adet); }).join('');

    kap.innerHTML = html;
    kap.classList.toggle('hidden', !urunler.length && !(g.kategoriler || []).length);

    var aktifHap = kap.querySelector('.izg-hap.is-on');
    if (aktifHap && aktifHap.scrollIntoView) {
      try { aktifHap.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) { /* eski motor */ }
    }
  }

  /* --- izgKategoriAgaciCiz: ağaç her çizildiğinde haplar da tazelenir --- */
  if (typeof izgKategoriAgaciCiz === 'function' && !izgKategoriAgaciCiz.hapSarildi) {
    var eskiAgac = izgKategoriAgaciCiz;
    izgKategoriAgaciCiz = function () {
      eskiAgac.apply(this, arguments);
      izgKategoriHaplariCiz();
    };
    izgKategoriAgaciCiz.hapSarildi = true;
  }

  /* --- izgKategoriSuz: süzgeç değişince haplar da işaretlenir --- */
  if (typeof izgKategoriSuz === 'function' && !izgKategoriSuz.hapSarildi) {
    var eskiSuz = izgKategoriSuz;
    izgKategoriSuz = function () {
      eskiSuz.apply(this, arguments);
      izgKategoriHaplariCiz();
    };
    izgKategoriSuz.hapSarildi = true;
  }

  /* --- izgOlaylariBagla: hap tıklaması, arama temizle, kısayollar --- */
  if (typeof izgOlaylariBagla === 'function' && !izgOlaylariBagla.hapSarildi) {
    var eskiBagla = izgOlaylariBagla;
    izgOlaylariBagla = function () {
      eskiBagla.apply(this, arguments);

      var bolum = $('#sekme-urunler');
      if (!bolum || bolum.dataset.hapBagli === '1') return;
      bolum.dataset.hapBagli = '1';

      var haplar = $('#izgKategoriHaplari');
      if (haplar) {
        haplar.addEventListener('click', function (o) {
          var btn = o.target.closest ? o.target.closest('[data-izg-hap]') : null;
          if (btn) izgKategoriSuz(btn.getAttribute('data-izg-hap'));
        });
      }

      var arama = $('#urunArama');
      var temizle = $('#urunAramaTemizle');

      var temizleGoster = function () {
        if (temizle && arama) temizle.classList.toggle('hidden', !arama.value);
      };

      var aramayiTemizle = function () {
        if (!arama || !arama.value) return;
        arama.value = '';
        temizleGoster();
        /* renderer.js'teki mevcut input dinleyicisi (debounce → yükle/çiz) tetiklenir. */
        arama.dispatchEvent(new Event('input', { bubbles: true }));
        arama.focus();
      };

      if (arama) {
        arama.addEventListener('input', temizleGoster);
        arama.addEventListener('keydown', function (o) {
          if (o.key === 'Escape' && arama.value) { o.preventDefault(); aramayiTemizle(); }
        });
        temizleGoster();
      }

      if (temizle) temizle.addEventListener('click', aramayiTemizle);

      /* Ctrl/⌘+F: ürün sekmesi açıkken tarayıcı aramasını değil ürün aramasını açar. */
      document.addEventListener('keydown', function (o) {
        var d = (typeof durum !== 'undefined' && durum) ? durum : null;
        if (!d || d.aktifSekme !== 'urunler') return;
        if ((o.ctrlKey || o.metaKey) && !o.altKey && String(o.key).toLowerCase() === 'f' && arama) {
          o.preventDefault();
          arama.focus();
          arama.select();
        }
      }, true);
    };
    izgOlaylariBagla.hapSarildi = true;
  }

  /* Dışa açık: testler ve manuel tazeleme için. */
  window.izgKategoriHaplariCiz = izgKategoriHaplariCiz;
}());

/* ==========================================================================
 *  BÖLÜM I — KADEMELİ (DOMİNO) SIRALAMA MOTORU + 60 FPS SÜRÜKLE-BIRAK
 *  --------------------------------------------------------------------------
 *  Hesap src/renderer/sira-motor.js'te (DOM'suz, test edilir); burada
 *  yalnızca DOM'a bağlanır:
 *
 *   - Taşıma: `durum.urunler` (= window.byomUrunler) dizisinde splice; aradaki
 *     ürünler birer kayar; menu_order = indeks. TAM yeniden çizim YAPILMAZ:
 *     tablo görünümünde satır düğümü, kart görünümünde kart düğümü
 *     `insertBefore` ile hedef konuma taşınır (0 ms).
 *   - Kategori süzgeci açıkken de çalışır; hedefin GLOBAL komşuluğu esas
 *     alınır, öteki kategorilerin göreli sırası bozulmaz ("Tüm Ürünler" ana
 *     kataloğu ile kategori görünümü aynı diziyi paylaşır).
 *   - Kılavuz çizgisi: 2px canlı mavi `.byom-drop-marker`, kesme noktasında.
 *   - Tablo: pointer olaylarıyla sürükleme (sanal listede DOM'a bakmadan
 *     konum hesabı, kenara yaklaşınca otomatik kaydırma, rAF ile tek kare).
 *     Kart: renderer-ek.js'in HTML5 sürüklemesi korunur; bırakma ve Alt+↑/↓
 *     buradaki motora yönlendirilir (idempotent sarma).
 *   - Eşitleme: 1500 ms debounce → `POST byom/v1/products/reorder {ids}`
 *     (tek CASE UPDATE). Yedekler: eski `wc-b2b/v1 products/reorder`
 *     (200'lük parçalar) → eklenti yoksa yalnızca değişen ürünlere WC PUT.
 *     Arka planda, sessizce; başarısızlıkta liste siteden geri yüklenir.
 * ========================================================================*/

(function izgSiralama() {
  var M = (typeof window !== 'undefined' && window.SiraMotor) ? window.SiraMotor : null;
  if (!M) {
    console.error('[Izgara] SiraMotor yüklenmedi (src/renderer/sira-motor.js).');
    return;
  }

  var SIRA_BEKLEME = 1500;      // ms — art arda taşımalar tek istek
  var KENAR_KAYDIRMA = 56;      // px — kenara bu kadar yaklaşınca otomatik kaydırma
  var KAYDIRMA_HIZI = 22;       // px/kare — en hızlı kenar kaydırması
  var SURUKLEME_ESIGI = 4;      // px — tıklama ile sürüklemeyi ayıran eşik

  function d() { return (typeof durum !== 'undefined' && durum) ? durum : null; }
  function cssId(id) { return String(id).replace(/["\\]/g, ''); }

  /* Şartname adı: window.byomUrunler = asıl dizinin takma adı (kopya değil). */
  try {
    Object.defineProperty(window, 'byomUrunler', {
      configurable: true,
      get: function () { var x = d(); return x && Array.isArray(x.urunler) ? x.urunler : []; },
      set: function (v) { var x = d(); if (x && Array.isArray(v)) x.urunler = v; }
    });
  } catch (e) { /* tanımlıysa dokunma */ }

  /* --------------------------------------------------------------------------
   *  Eşitleme durumu (alt bilgi şeridinde gösterilir)
   * ------------------------------------------------------------------------*/

  function sd() {
    var x = d();
    if (!x) return null;
    if (!x.izgSira) x.izgSira = { durum: '', hata: '', kuyruk: null };
    return x.izgSira;
  }

  function izgSiraDurumCiz() {
    var s = sd();
    var el = $('#izgSiraDurum');
    if (!s || !el) return;

    var m = {
      bekliyor: ['Sıra değişti · siteye yazılacak…', 'is-busy'],
      gonderiliyor: ['Sıra siteye yazılıyor…', 'is-busy'],
      ok: ['Genel katalog sırası siteye kaydedildi ✓', 'is-ok'],
      demo: ['Sıra kaydedildi (demo modu — sitede değişiklik yok)', 'is-ok'],
      hata: ['Sıra kaydedilemedi: ' + String(s.hata || '').split('\n')[0], 'is-err']
    }[s.durum];

    el.textContent = m ? m[0] : '';
    el.className = 'izg-sira-durum ' + (m ? m[1] : '');
  }

  /* --------------------------------------------------------------------------
   *  Taşıma (tek giriş noktası)
   * ------------------------------------------------------------------------*/

  /** Sürüklenmekte olan ürün (satır yeniden çizilirken soluk kalsın). */
  var sur = null;
  function izgTasinanMi(id) { return !!(sur && sur.aktif && String(sur.id) === String(id)); }

  /**
   * kaynakId, hedefId'nin önüne/arkasına gelir; aradakiler kayar; DOM'da yalnızca
   * ilgili düğüm taşınır; 1500 ms sonra siteye yazılır.
   * @returns {boolean} bir şey değiştiyse true
   */
  function izgSiraTasiId(kaynakId, hedefId, oncesineMi) {
    var x = d();
    var g = izg();
    if (!x || !g || !Array.isArray(x.urunler)) return false;

    /* Sunucudaki bilinen değer ilk taşımada yedeklenir (eklentisiz yedek yol
       yalnızca değişenleri PUT'lar). */
    x.urunler.forEach(function (u) { if (u && u.menuSiraSite === undefined) u.menuSiraSite = Number(u.menuSira) || 0; });

    var sonuc = M.tasiId(x.urunler, kaynakId, hedefId, !!oncesineMi);
    if (!sonuc || !sonuc.degisti) return false;

    M.konumlariYaz(x.urunler, 'menuSira');
    x.siralamaDegisti = true;

    g.liste = izgFiltreliListe();

    if (g.gorunum === 'tablo') {
      if (!izgSatiriDomdaTasi(kaynakId)) {
        g.tazeleGerek = true;
        izgPencereyiCiz();
      }
    } else if (!izgKartiDomdaTasi(kaynakId)) {
      izgKartGorunumunuCiz();
    }

    izgSiraGonderPlanla();
    return true;
  }

  /** Klavye: görünen listede bir üst/alt komşuyla yer değiştirir. */
  function izgKomsuylaTasi(id, yon) {
    var g = izg();
    if (!g) return false;

    if (typeof siralamaGuvenliMi === 'function' && !siralamaGuvenliMi()) return false;

    g.liste = izgFiltreliListe();
    var hedef = M.komsu(g.liste, id, yon);
    if (!hedef) return false;

    var oldu = izgSiraTasiId(id, hedef.id, yon < 0);
    if (!oldu) return false;

    /* Odak taşınan öğede kalsın (düğüm taşındıysa zaten kalır; yeniden
       çizildiyse tutamak yeniden bulunur). */
    var secici = g.gorunum === 'tablo'
      ? '[data-izg-tut="' + cssId(id) + '"]'
      : '[data-urun="' + cssId(id) + '"] [data-tut]';
    var tut = document.querySelector(secici);
    if (tut) {
      try { tut.focus({ preventScroll: true }); } catch (e) { tut.focus(); }
      if (tut.scrollIntoView) tut.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }

  /* --------------------------------------------------------------------------
   *  DOM'da tek düğüm taşıma (tam yeniden çizim yok)
   * ------------------------------------------------------------------------*/

  /** Tablo: satır düğümünü pencere içinde hedef konuma taşır. */
  function izgSatiriDomdaTasi(id) {
    var g = izg();
    var govde = $('#izgGovde');
    if (!g || !govde || govde.dataset.dolu !== '1') return false;

    var ilk = g.ilkSatir;
    var son = Math.min(g.sonSatir, g.liste.length);

    var satir = govde.querySelector('[data-izg-id="' + cssId(id) + '"]');
    if (!satir) return false;

    var yeniIdx = M.indeks(g.liste, id);
    if (yeniIdx < ilk || yeniIdx >= son) return false;

    var sonraki = (yeniIdx + 1 < son) ? g.liste[yeniIdx + 1] : null;
    if (sonraki) {
      var sonrakiDugum = govde.querySelector('[data-izg-id="' + cssId(sonraki.id) + '"]');
      if (!sonrakiDugum) return false;
      govde.insertBefore(satir, sonrakiDugum);
    } else {
      govde.appendChild(satir);
    }

    /* Pencere ile DOM birebir mi? (taşıma pencere sınırını aştıysa değildir) */
    var beklenen = g.liste.slice(ilk, son);
    var dugumler = govde.children;
    if (dugumler.length !== beklenen.length) return false;
    for (var i = 0; i < beklenen.length; i++) {
      if (String(dugumler[i].getAttribute('data-izg-id')) !== String(beklenen[i].id)) return false;
    }
    return true;
  }

  /** Kart: kart düğümünü hedef konuma taşır (parçalı çizimde eksik parça varsa false). */
  function izgKartiDomdaTasi(id) {
    var g = izg();
    var kap = $('#urunListesi');
    if (!g || !kap) return false;

    var kart = kap.querySelector('[data-urun="' + cssId(id) + '"]');
    if (!kart) return false;

    var idx = M.indeks(g.liste, id);
    if (idx === -1) return false;

    var sonraki = g.liste[idx + 1];
    if (!sonraki) {
      if (kap.querySelector('[data-urun-devam]')) return false;   // henüz çizilmemiş kartlar var
      kap.appendChild(kart);
      return true;
    }

    var sonrakiKart = kap.querySelector('[data-urun="' + cssId(sonraki.id) + '"]');
    if (!sonrakiKart) return false;

    kap.insertBefore(kart, sonrakiKart);
    return true;
  }

  /* --------------------------------------------------------------------------
   *  2px canlı mavi kılavuz çizgisi
   * ------------------------------------------------------------------------*/

  function markerAl(kap) {
    var m = null;
    for (var i = 0; i < kap.children.length; i++) {
      if (kap.children[i].classList && kap.children[i].classList.contains('byom-drop-marker')) { m = kap.children[i]; break; }
    }
    if (!m) {
      m = document.createElement('div');
      m.className = 'byom-drop-marker';
      m.hidden = true;
      m.setAttribute('aria-hidden', 'true');
      kap.appendChild(m);
    }
    return m;
  }

  /** Tablo: kesme noktasına (içerik koordinatı) çizgi. */
  function izgTabloCizgisi(kesme) {
    var bosluk = $('#izgBosluk');
    if (!bosluk) return;
    var m = markerAl(bosluk);
    m.style.transform = 'translateY(' + Math.max(0, kesme * IZGARA_SATIR_YUKSEKLIGI - 1) + 'px)';
    m.hidden = false;
  }

  /** Kart (HTML5 DnD, renderer-ek.js çağırır): kartın üstüne/altına çizgi. */
  function izgBirakmaCizgisi(kap, satir, konum) {
    if (!kap || !satir) return;
    var m = markerAl(kap);
    var bosluk = 8;   // kartlar arası 16px boşluğun ortası
    var top = (konum === 'once') ? satir.offsetTop - bosluk : satir.offsetTop + satir.offsetHeight + bosluk;
    m.style.transform = 'translateY(' + Math.max(0, top - 1) + 'px)';
    m.hidden = false;
  }

  function izgBirakmaCizgisiGizle() {
    var hepsi = document.querySelectorAll('.byom-drop-marker');
    for (var i = 0; i < hepsi.length; i++) hepsi[i].hidden = true;
  }

  /* --------------------------------------------------------------------------
   *  Tablo görünümü: pointer tabanlı sürükleme (sanal liste)
   * ------------------------------------------------------------------------*/

  function tabloSuruklemeBagla() {
    var kap = $('#urunIzgara');
    if (!kap || kap.dataset.surukleBagli === '1') return;
    kap.dataset.surukleBagli = '1';

    kap.addEventListener('pointerdown', function (o) {
      if (o.pointerType === 'mouse' && o.button !== 0) return;
      var tut = o.target && o.target.closest ? o.target.closest('[data-izg-tut]') : null;
      if (!tut) return;

      var id = tut.getAttribute('data-izg-tut');
      var u = izgUrunBul(id);
      if (!u) return;

      o.preventDefault();

      sur = { id: id, u: u, x0: o.clientX, y0: o.clientY, x: o.clientX, y: o.clientY, aktif: false, kare: 0, hiz: 0, kaydirmaKare: 0, konum: null, hayalet: null };

      window.addEventListener('pointermove', hareket, { passive: false });
      window.addEventListener('pointerup', birak);
      window.addEventListener('pointercancel', iptal);
      window.addEventListener('keydown', escIptal, true);
    });

    /* Alt + ↑ / ↓ : tutamak odaklıyken klavyeyle taşıma */
    kap.addEventListener('keydown', function (o) {
      if (!o.altKey || (o.key !== 'ArrowUp' && o.key !== 'ArrowDown')) return;
      var tut = o.target && o.target.closest ? o.target.closest('[data-izg-tut]') : null;
      if (!tut) return;
      o.preventDefault();
      izgKomsuylaTasi(tut.getAttribute('data-izg-tut'), o.key === 'ArrowUp' ? -1 : 1);
    });
  }

  function hareket(o) {
    if (!sur) return;
    sur.x = o.clientX;
    sur.y = o.clientY;

    if (!sur.aktif) {
      if (Math.abs(sur.y - sur.y0) < SURUKLEME_ESIGI && Math.abs(sur.x - sur.x0) < SURUKLEME_ESIGI) return;
      if (typeof siralamaGuvenliMi === 'function' && !siralamaGuvenliMi()) { iptal(); return; }
      baslat();
    }

    o.preventDefault();
    if (!sur.kare) sur.kare = requestAnimationFrame(kareCiz);
  }

  function baslat() {
    sur.aktif = true;
    document.body.classList.add('izg-surukleniyor');

    var satir = document.querySelector('#izgGovde [data-izg-id="' + cssId(sur.id) + '"]');
    if (satir) satir.classList.add('izg-tasiniyor');

    var h = document.createElement('div');
    h.className = 'izg-hayalet';
    h.innerHTML =
      '<img src="' + kacis(sur.u.gorsel || '') + '" alt="" onerror="this.style.visibility=\'hidden\'" />' +
      '<span class="izg-hayalet__ad">' + kacis(sur.u.ad || '') + '</span>' +
      '<span class="izg-hayalet__sira" data-izg-hayalet-sira></span>';
    document.body.appendChild(h);
    sur.hayalet = h;
  }

  /** Tek karede: hayalet konumu + kılavuz çizgisi + kenar kaydırma kararı. */
  function kareCiz() {
    if (!sur || !sur.aktif) return;
    sur.kare = 0;

    if (sur.hayalet) {
      sur.hayalet.style.transform = 'translate3d(' + (sur.x + 14) + 'px,' + (sur.y - 18) + 'px,0)';
    }

    konumuGuncelle();

    var kaydirma = $('#izgKaydirma');
    if (!kaydirma) return;
    var kutu = kaydirma.getBoundingClientRect();
    var hiz = 0;
    if (sur.y < kutu.top + KENAR_KAYDIRMA) {
      hiz = -Math.ceil((1 - Math.max(0, sur.y - kutu.top) / KENAR_KAYDIRMA) * KAYDIRMA_HIZI);
    } else if (sur.y > kutu.bottom - KENAR_KAYDIRMA) {
      hiz = Math.ceil((1 - Math.max(0, kutu.bottom - sur.y) / KENAR_KAYDIRMA) * KAYDIRMA_HIZI);
    }
    sur.hiz = hiz;
    if (hiz && !sur.kaydirmaKare) sur.kaydirmaKare = requestAnimationFrame(kaydirmaDongusu);
  }

  /** Kenar kaydırma döngüsü: kaydırma olayı pencereyi yeniden çizer, çizgi tazelenir. */
  function kaydirmaDongusu() {
    if (!sur || !sur.aktif || !sur.hiz) { if (sur) sur.kaydirmaKare = 0; return; }
    var kaydirma = $('#izgKaydirma');
    if (!kaydirma) { sur.kaydirmaKare = 0; return; }

    /* Sınırlar burada uygulanır: uç noktada döngü durur (tarayıcı zaten 0'a
       sıkıştırır; sanal DOM'da negatif değere kayabilirdi). */
    var enFazla = Math.max(0, kaydirma.scrollHeight - kaydirma.clientHeight);
    var onceki = kaydirma.scrollTop;
    var hedef = Math.max(0, Math.min(enFazla, onceki + sur.hiz));
    if (hedef === onceki) { sur.hiz = 0; sur.kaydirmaKare = 0; return; }
    kaydirma.scrollTop = hedef;

    konumuGuncelle();
    sur.kaydirmaKare = requestAnimationFrame(kaydirmaDongusu);
  }

  function konumuGuncelle() {
    var g = izg();
    var kaydirma = $('#izgKaydirma');
    if (!g || !kaydirma) return;

    var kutu = kaydirma.getBoundingClientRect();
    var icY = sur.y - kutu.top + kaydirma.scrollTop;
    var konum = M.birakmaKonumu(icY, IZGARA_SATIR_YUKSEKLIGI, g.liste.length);
    if (!konum) return;

    sur.konum = konum;
    izgTabloCizgisi(konum.kesme);

    var rozet = sur.hayalet ? sur.hayalet.querySelector('[data-izg-hayalet-sira]') : null;
    if (rozet) {
      var kaynakIdx = M.indeks(g.liste, sur.id);
      var hedefSira = konum.kesme - (kaynakIdx !== -1 && kaynakIdx < konum.kesme ? 1 : 0) + 1;
      rozet.textContent = M.bosTasimaMi(g.liste, sur.id, konum.kesme) ? 'yerinde' : hedefSira + '. sıra';
    }
  }

  function birak() {
    if (!sur) return;
    var s = sur;
    temizle();

    if (!s.aktif || !s.konum) return;

    var g = izg();
    if (!g) return;
    g.liste = izgFiltreliListe();

    if (M.bosTasimaMi(g.liste, s.id, s.konum.kesme)) return;

    var hedef = g.liste[s.konum.indeks];
    if (!hedef || String(hedef.id) === String(s.id)) return;

    izgSiraTasiId(s.id, hedef.id, s.konum.oncesineMi);
  }

  function iptal() { temizle(); }
  function escIptal(o) { if (o.key === 'Escape' && sur) { o.preventDefault(); temizle(); } }

  function temizle() {
    window.removeEventListener('pointermove', hareket);
    window.removeEventListener('pointerup', birak);
    window.removeEventListener('pointercancel', iptal);
    window.removeEventListener('keydown', escIptal, true);

    if (sur) {
      if (sur.kare) cancelAnimationFrame(sur.kare);
      if (sur.kaydirmaKare) cancelAnimationFrame(sur.kaydirmaKare);
      if (sur.hayalet && sur.hayalet.parentNode) sur.hayalet.parentNode.removeChild(sur.hayalet);
      var satir = document.querySelector('#izgGovde [data-izg-id="' + cssId(sur.id) + '"]');
      if (satir) satir.classList.remove('izg-tasiniyor');
    }

    document.body.classList.remove('izg-surukleniyor');
    izgBirakmaCizgisiGizle();
    sur = null;
  }

  /* --------------------------------------------------------------------------
   *  Eşitleme: 1500 ms debounce, arka planda, sessiz
   * ------------------------------------------------------------------------*/

  function izgSiraGonderPlanla() {
    var s = sd();
    if (!s) return;
    if (!s.kuyruk) s.kuyruk = M.createKuyruk({ bekleme: SIRA_BEKLEME, gonder: izgSiraGonder });
    s.durum = 'bekliyor';
    izgSiraDurumCiz();
    s.kuyruk.planla();
  }

  /** Bekleyen taşımaları hemen gönderir (ör. sekme kapanmadan). */
  function izgSiraHemenGonder() {
    var s = sd();
    if (!s || !s.kuyruk || !s.kuyruk.bekliyorMu()) return Promise.resolve(false);
    return s.kuyruk.hemen();
  }

  async function izgSiraGonder() {
    var x = d();
    var s = sd();
    if (!x || !s || !Array.isArray(x.urunler) || !x.urunler.length) return false;

    var ids = M.idListesi(x.urunler);
    s.durum = 'gonderiliyor';
    izgSiraDurumCiz();

    try {
      if (izgDemoMu()) {
        await bekle(120);
        demoSirasiniYaz(x.urunler);
        x.urunler.forEach(function (u) { u.menuSiraSite = u.menuSira; });
        x.siralamaDegisti = false;
        s.durum = 'demo';
        izgSiraDurumCiz();
        return true;
      }

      var cevap = await izgSiraIstek(ids);

      if (cevap && cevap.ok) {
        x.urunler.forEach(function (u) { u.menuSiraSite = u.menuSira; });
        x.siralamaDegisti = false;
        s.durum = 'ok';
        s.hata = '';
        izgSiraDurumCiz();

        var veri = cevap.veri || {};
        var atlanan = (veri.skipped && veri.skipped.length) || (veri.failed && veri.failed.length) || 0;
        if (atlanan) bildir(atlanan + ' ürünün sırası siteye yazılamadı (ürün silinmiş olabilir).', 'uyari');
        return true;
      }

      s.durum = 'hata';
      s.hata = (typeof ekHataMetni === 'function') ? ekHataMetni(cevap) : String((cevap && cevap.hata) || 'Bilinmeyen hata');
      izgSiraDurumCiz();

      bildir('Sıralama siteye kaydedilemedi:\n' + s.hata +
             '\n\nEkrandaki sıra sitedeki gerçek sıraya geri alınıyor…', 'hata');
      await urunleriYukle(typeof ekAramaMetni === 'function' ? ekAramaMetni() : '');
      return false;
    } catch (e) {
      s.durum = 'hata';
      s.hata = String((e && e.message) || e);
      izgSiraDurumCiz();
      return false;
    }
  }

  /**
   * 1) byom/v1 → wc-byom/v1 (tek CASE UPDATE, 5000'e kadar)
   * 2) eski eklenti: wc-b2b/v1 products/reorder, 200'lük parçalar (siraTopluYaz)
   * 3) eklenti yok: yalnızca değişen ürünlere WooCommerce PUT (siraWooIleGonder)
   */
  async function izgSiraIstek(ids) {
    var x = d();
    var alanlar = ['wc-byom/v1', 'byom/v1'];
    var son = null;

    for (var i = 0; i < alanlar.length; i++) {
      var c = await api(alanlar[i], 'products/reorder', { metod: 'POST', govde: { ids: ids }, sureAsimi: 60000 });
      if (c && c.ok) return c;
      son = c;
      var kod = String((c && c.kod) || '');
      var http = Number(c && c.durum) || 0;
      /* Uç yok / yetki yok → sıradaki yol; başka her hata gerçektir. */
      if (!(kod === 'rest_no_route' || http === 404 || http === 401 || http === 403)) return c;
    }

    if (typeof ekEklentiVarMi === 'function' && ekEklentiVarMi() && typeof siraTopluYaz === 'function') {
      var items = ids.map(function (id, i) { return { id: id, menu_order: i }; });
      var basarisiz = await siraTopluYaz(items);
      if (basarisiz === null) return son || { ok: false, hata: 'Sıralama ucu yanıt vermedi.' };
      return { ok: true, veri: { failed: basarisiz } };
    }

    if (typeof siraWooIleGonder === 'function') {
      var degisen = (x ? x.urunler : []).filter(function (u) { return Number(u.menuSiraSite) !== Number(u.menuSira); })
        .map(function (u) { return { id: Number(u.id), menu_order: Number(u.menuSira) }; });
      if (!degisen.length) return { ok: true, veri: { failed: [] } };
      if (degisen.length > 25) bildir('B2B Core eklentisi yok; ' + degisen.length + ' ürünün sırası WooCommerce ucundan tek tek yazılıyor…', 'bilgi');
      var kalan = await siraWooIleGonder(degisen);
      if (kalan.length === degisen.length) {
        return { ok: false, hata: 'WooCommerce ürün güncelleme ucu yanıt vermedi.\nAPI anahtarınızın "Okuma/Yazma" izni olduğundan emin olun.' };
      }
      return { ok: true, veri: { failed: kalan } };
    }

    return son || { ok: false, hata: 'Sıralama ucu bulunamadı.' };
  }

  /** Demo: kaynak listeye konumları yaz ve aynı sıraya diz. */
  function demoSirasiniYaz(liste) {
    if (typeof DEMO_URUNLER === 'undefined') return;
    var konum = Object.create(null);
    liste.forEach(function (u, i) { konum[String(u.id)] = i; });
    DEMO_URUNLER.forEach(function (u) { if (konum[String(u.id)] !== undefined) u.menuSira = konum[String(u.id)]; });
    DEMO_URUNLER.sort(function (a, b) { return (Number(a.menuSira) || 0) - (Number(b.menuSira) || 0); });
  }

  /* --------------------------------------------------------------------------
   *  Mevcut akışlara bağlanma (idempotent sarma)
   * ------------------------------------------------------------------------*/

  /* Kart görünümünün bırakma ve klavye yolu → bu motor (renderer-ek.js). */
  if (typeof urunTasimasiniUygula === 'function' && !urunTasimasiniUygula.izgSarildi) {
    urunTasimasiniUygula = function (kaynakId, hedefId, oncesineMi) {
      izgSiraTasiId(kaynakId, hedefId, !!oncesineMi);
      return Promise.resolve();
    };
    urunTasimasiniUygula.izgSarildi = true;
  }

  if (typeof urunuKomsuylaTasi === 'function' && !urunuKomsuylaTasi.izgSarildi) {
    urunuKomsuylaTasi = function (id, yon) {
      izgKomsuylaTasi(id, yon);
      return Promise.resolve();
    };
    urunuKomsuylaTasi.izgSarildi = true;
  }

  /* Eski seyrek kuyruk (siraBekleyen) artık kullanılmaz; çağrılırsa buraya düşer. */
  if (typeof siralamayiGonder === 'function' && !siralamayiGonder.izgSarildi) {
    siralamayiGonder = function () { izgSiraGonderPlanla(); return Promise.resolve(); };
    siralamayiGonder.izgSarildi = true;
  }

  /* Olay bağlama: tablo sürüklemesi (kabuk yeniden kurulsa da kap aynı). */
  if (typeof izgOlaylariBagla === 'function' && !izgOlaylariBagla.siraSarildi) {
    var eskiBagla = izgOlaylariBagla;
    izgOlaylariBagla = function () {
      eskiBagla.apply(this, arguments);
      tabloSuruklemeBagla();
    };
    izgOlaylariBagla.siraSarildi = true;
  }

  /* Alt bilgi şeridi çizilince eşitleme durumu da yazılır. */
  if (typeof izgAltbilgiCiz === 'function' && !izgAltbilgiCiz.siraSarildi) {
    var eskiAltbilgi = izgAltbilgiCiz;
    izgAltbilgiCiz = function () {
      eskiAltbilgi.apply(this, arguments);
      izgSiraDurumCiz();
    };
    izgAltbilgiCiz.siraSarildi = true;
  }

  /* Sekme değişirken bekleyen sıra hemen gönderilir (1,5 sn beklemeden). */
  if (typeof sekmeAc === 'function' && !sekmeAc.siraSarildi) {
    var eskiSekmeAc = sekmeAc;
    sekmeAc = function (ad) {
      var x = d();
      if (x && x.aktifSekme === 'urunler' && ad !== 'urunler') izgSiraHemenGonder();
      return eskiSekmeAc.apply(this, arguments);
    };
    sekmeAc.siraSarildi = true;
  }

  /* Dışa açık (renderer-ek.js, testler ve el ile çağrılar için). */
  window.izgSiraTasiId = izgSiraTasiId;
  window.izgKomsuylaTasi = izgKomsuylaTasi;
  window.izgBirakmaCizgisi = izgBirakmaCizgisi;
  window.izgBirakmaCizgisiGizle = izgBirakmaCizgisiGizle;
  window.izgTasinanMi = izgTasinanMi;
  window.izgSiraGonderPlanla = izgSiraGonderPlanla;
  window.izgSiraHemenGonder = izgSiraHemenGonder;
  window.izgSiraDurumCiz = izgSiraDurumCiz;
}());
