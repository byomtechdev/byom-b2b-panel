/* ============================================================================
 *  PAZARLAMACILAR SEKMESİ — YÖNETİCİ (src/renderer/modules/plasiyer-yonetimi.js)
 *  ---------------------------------------------------------------------------
 *  Yöneticinin plasiyer tanımladığı, PIN belirlediği, bayi atadığı ve
 *  performansı gördüğü sekme.
 *
 *  NEDEN AYRI DOSYA: `renderer.js` 330 KB'dır. Yeni bir özelliğin oraya
 *  eklenmesi dosyayı okunamaz hâle getirir ve her görevde gereksiz token
 *  yakar. Bu modül `renderer.js`'in genel yardımcılarını (durum, $, bildir,
 *  onayla, kacis, b2b, sekmeAc) KULLANIR ama içine girmez.
 *
 *  DİZİN ANLAMI:
 *    src/renderer/          → DOM'suz, node:test altında koşan motorlar
 *    src/renderer/modules/  → DOM'a bağlı özellik modülleri (bu dosya)
 *  Ayrımın sebebi: ilk gruptakiler test edilebilir, ikinci gruptakiler
 *  tarayıcı ortamı ister. Karıştırmak "neden bu dosyayı require edemiyorum"
 *  sorusunu doğurur.
 *
 *  PERFORMANS ÇUBUĞU: genişlik (`width`) DEĞİL `transform: scaleX()` ile
 *  büyür. Genişlik animasyonu her karede düzen hesabı (reflow) tetikler;
 *  scaleX kompozitörde çalışır ve 30 satırlık tabloda bile akıcı kalır.
 *
 *  SIR: PIN yalnızca forma girildiği anda okunur, isteğe konur ve alan
 *  temizlenir. Sunucu PIN'i hash'leyerek saklar; buraya asla geri gelmez —
 *  yalnızca `pinTanimli` bayrağı gelir.
 * ==========================================================================*/

'use strict';

(function () {

  /** Son çekilen liste — yeniden çizimde tekrar istek atmamak için. */
  var kayit = { plasiyerler: [], genelCiro: 0, genelSiparis: 0, paraBirimi: '', bayiler: [],
    /* Tablo sıralaması (Faz 12): başlığa tıklanır, yerel — ağa çıkmaz. */
    sirala: { alan: 'ciro', yon: -1 },
    /* CİRO DÖNEMİ (Faz 13): 'ay' | 'yil' | 'tumu'. Varsayılan AY, çünkü
       "bu ay ne yaptık" sahada sorulan ilk sorudur. */
    donem: 'ay',
    /* Dönem toplamları — eski eklenti göndermez, o yüzden 0 DEĞİL null:
       0 yazmak "bu ay hiç satış yok" gibi YANLIŞ bir şey söylerdi. */
    genelCiroAy: null, genelCiroYil: null, donemAy: '', donemAyAd: '' };

  /* ------------------------------------------------------------------ *
   *  CİRO DÖNEMİ — aylık / yıllık / tümü  (Faz 13)
   *  ---------------------------------------------------------------
   *  Sunucu (B2B_Plasiyer::get_plasiyer_stats) üç kovayı TEK sorguda
   *  doldurur: ciro/siparis (tüm zamanlar), ciroAy/siparisAy (takvim ayı),
   *  ciroYil/siparisYil (takvim yılı). Dönem değiştirmek bu yüzden YENİ BİR
   *  İSTEK DEĞİL, yalnızca hangi alanın okunacağıdır: çipe basmak HİÇBİR
   *  REST/IPC turu üretmez ("ölçüt değişimi ağa çıkmaz", panel CLAUDE.md §4.10).
   * ------------------------------------------------------------------ */

  /** Dönem → okunacak alan adları. TEK sözlük: üç yerde üç kural doğmasın. */
  var DONEMLER = {
    ay:   { ciro: 'ciroAy',  siparis: 'siparisAy',  genel: 'genelCiroAy' },
    yil:  { ciro: 'ciroYil', siparis: 'siparisYil', genel: 'genelCiroYil' },
    tumu: { ciro: 'ciro',    siparis: 'siparis',    genel: 'genelCiro' }
  };

  /** Yoksa null: "alan gelmedi" ile "değer sıfır" aynı şey değildir. */
  function sayiYaDaNull(v) {
    return (undefined === v || null === v || '' === v) ? null : (Number(v) || 0);
  }

  /**
   * Eklenti dönem alanlarını gönderiyor mu?
   *
   * ESKİ EKLENTİ DAYANIKLILIĞI: bu alanlardan önceki sürümler yalnızca
   * ciro/siparis gönderir. O yükte aylık çip "undefined ₺" basardı; bunun
   * yerine çipler DEVRE DIŞI kalır ve tablo tüm zamanları gösterir.
   */
  function donemDestekli() {
    if (null !== kayit.genelCiroAy || null !== kayit.genelCiroYil) return true;

    return kayit.plasiyerler.some(function (p) {
      return !!p && (undefined !== p.ciroAy || undefined !== p.ciroYil);
    });
  }

  /** Ekranda GERÇEKTEN kullanılan dönem (destek yoksa daima 'tumu'). */
  function aktifDonem() {
    if (!donemDestekli()) return 'tumu';

    return DONEMLER[kayit.donem] ? kayit.donem : 'tumu';
  }

  /** Bir plasiyerin aktif dönemdeki ciro / sipariş sayısı. */
  function donemSayi(p, tur) {
    var deger = p ? p[DONEMLER[aktifDonem()][tur]] : 0;

    /* Alan yoksa tüm zamanlara düş: ekrana undefined / NaN ₺ basmaktansa
       anlamlı bir sayı göstermek yeğdir (Faz 11 ilkesi). */
    if (undefined === deger || null === deger || '' === deger) deger = p ? p[DONEMLER.tumu[tur]] : 0;

    return Number(deger) || 0;
  }

  /** Aktif dönemin genel ciro toplamı; sunucu vermediyse satırlardan toplanır. */
  function genelDonemCiro() {
    var deger = kayit[DONEMLER[aktifDonem()].genel];

    if (undefined !== deger && null !== deger) return Number(deger) || 0;

    /* "toplamın %N'i" satırı aktif dönemle tutarsız kalmasın. */
    return kayit.plasiyerler.reduce(function (t, p) { return t + donemSayi(p, 'ciro'); }, 0);
  }

  /** Aktif dönemin genel sipariş adedi (sunucu yalnızca tüm zamanları gönderir). */
  function genelDonemSiparis() {
    if ('tumu' === aktifDonem()) return Number(kayit.genelSiparis) || 0;

    return kayit.plasiyerler.reduce(function (t, p) { return t + donemSayi(p, 'siparis'); }, 0);
  }

  /** Dönemin kısa adı: 'Eylül' / '2026' / 'Tümü' — başlıkta ve özette. */
  function donemAdi(ad) {
    if ('ay' === ad) return kayit.donemAyAd || 'Bu Ay';
    if ('yil' === ad) return /^[0-9]{4}/.test(kayit.donemAy) ? kayit.donemAy.slice(0, 4) : 'Bu Yıl';

    return 'Tümü';
  }

  /**
   * Dönem çipi: YALNIZCA kayit.donem'i değiştirir.
   *
   * listeyiGetir() BİLEREK ÇAĞRILMAZ — üç kova da elimizde; yeniden istemek
   * hem gereksiz ağ turu hem de §4.10 sözünün ihlali olurdu.
   */
  function donemSec(ad) {
    if (!DONEMLER[ad] || !donemDestekli()) return;

    kayit.donem = ad;

    tabloyuCiz();
    ozetiTazele();
  }

  /** Sıralanmış kopya; ad Türkçe harf duyarlı, sayılar sayısal. */
  function siraliPlasiyerler() {
    var alan = kayit.sirala.alan;
    var yon = kayit.sirala.yon;

    return kayit.plasiyerler.slice().sort(function (a, b) {
      if ('ad' === alan) return String(a.ad || '').localeCompare(String(b.ad || ''), 'tr') * yon;

      /* Ciro/sipariş AKTİF DÖNEMİN alanından okunur: ekranda Eylül cirosu
         yazarken tüm zamanların cirosuna göre sıralamak listeyi yalancı yapar. */
      if ('ciro' === alan || 'siparis' === alan) return (donemSayi(a, alan) - donemSayi(b, alan)) * yon;

      return ((Number(a[alan]) || 0) - (Number(b[alan]) || 0)) * yon;
    });
  }

  var bagli = false;   // çift bağlanma koruması (bkz. kök CLAUDE.md §6)

  function el(id) {
    return document.getElementById(id);
  }

  /**
   * Para biçimi.
   *
   * renderer.js'teki `para()` "kullanıcıya gösterilen TEK para biçimi"dir
   * (1.234,50 ₺ — binlik ayracı, kuruş, işaret kuralları dahil). Burada kendi
   * biçimimizi yazmak aynı ekranda İKİ farklı para görünümü demek olurdu.
   *
   * Fonksiyon adı bilinçli olarak `paraYaz`: `para` denseydi IIFE içinde
   * globali GÖLGELER ve kendi kendini çağırırdı.
   */
  function paraYaz(n) {
    var sayi = Number(n) || 0;

    if ('function' === typeof window.para) {
      try { return window.para(sayi); } catch (e) { /* yedeğe düş */ }
    }

    return sayi.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
           (kayit.paraBirimi ? ' ' + kayit.paraBirimi : '');
  }

  /**
   * PLASİYER RENK PALETİ (Faz 12) — tek kaynak harita-kokpit.js (PHP
   * B2B_Plasiyer::PALET ikizi). Kokpit yüklenmemişse (test harness) küçük
   * bir yedek liste; ikisi de aynı anahtarları taşır.
   */
  function palet() {
    if (window.HaritaKokpit && window.HaritaKokpit.PALET) return window.HaritaKokpit.PALET;

    return { mor: '#7c3aed', safir: '#2563eb', zumrut: '#059669', amber: '#d97706', gul: '#e11d48',
             turkuaz: '#0891b2', indigo: '#4f46e5', kiremit: '#c2410c', zeytin: '#4d7c0f', fuchsia: '#c026d3' };
  }

  function paletAdi(anahtar) {
    var A = (window.HaritaKokpit && window.HaritaKokpit.PALET_ADLARI) || {};
    return A[anahtar] || anahtar || '';
  }

  function renkHex(anahtar) {
    return palet()[String(anahtar || '')] || '';
  }

  /** 81 il — HaritaVeri kütüğünden (plaka sırasıyla). */
  function iller() {
    var V = window.HaritaVeri;
    return (V && Array.isArray(V.ILLER)) ? V.ILLER.slice().sort(function (a, b) { return a.plaka - b.plaka; }) : [];
  }

  /** Başka bir plasiyere atanmış iller: plaka → plasiyer adı (formda uyarı). */
  function ilSahipleri(haricId) {
    var sahip = {};

    kayit.plasiyerler.forEach(function (p) {
      if (Number(p.id) === Number(haricId)) return;

      (Array.isArray(p.iller) ? p.iller : []).forEach(function (plaka) {
        sahip[Number(plaka)] = p.ad || ('#' + p.id);
      });
    });

    return sahip;
  }

  /* ------------------------------------------------------------------ *
   *  VERİ
   * ------------------------------------------------------------------ */

  async function listeyiGetir() {
    var kap = el('plasiyerTablo');

    if (kap) kap.innerHTML = '<div class="py-10 text-center text-slate-500">Yükleniyor…</div>';

    var cevap = await b2b('/admin/plasiyerler');

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
      if (kap) {
        kap.innerHTML = '<div class="py-10 text-center text-red-600 dark:text-red-400 font-semibold">' +
          kacis((cevap && cevap.hata) || 'Pazarlamacı listesi alınamadı.') + '</div>';
      }
      return;
    }

    kayit.plasiyerler  = cevap.veri.plasiyerler || [];
    kayit.genelCiro    = Number(cevap.veri.genelCiro) || 0;
    kayit.genelSiparis = Number(cevap.veri.genelSiparis) || 0;
    kayit.paraBirimi   = String(cevap.veri.paraBirimi || '');

    /* DÖNEM TOPLAMLARI (Faz 13). Alan yoksa null kalır → çipler devre dışı. */
    kayit.genelCiroAy  = sayiYaDaNull(cevap.veri.genelCiroAy);
    kayit.genelCiroYil = sayiYaDaNull(cevap.veri.genelCiroYil);
    kayit.donemAy      = String(cevap.veri.donemAy || '');
    kayit.donemAyAd    = String(cevap.veri.donemAyAd || '');

    tabloyuCiz();
    ozetiTazele();
  }

  function ozetiTazele() {
    var ozet = el('plasiyerOzet');

    if (!ozet) return;

    /* Özet de AKTİF DÖNEMİ anlatır: tablo Eylül'ü gösterirken başlıktaki
       toplamın tüm zamanları söylemesi iki farklı gerçek üretirdi. */
    ozet.textContent = kayit.plasiyerler.length + ' pazarlamacı · ' + donemAdi(aktifDonem()) + ': ' +
                       genelDonemSiparis() + ' sipariş · ' + paraYaz(genelDonemCiro());
  }

  /* ------------------------------------------------------------------ *
   *  TABLO + CİRO ÇUBUĞU
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   *  ALT SEKMELER — Ciro/Performans  |  Saha Ziyaret Haritası  (Faz 6)
   *  ---------------------------------------------------------------
   *  Saha Haritası eskiden sol ANA menüde bağımsız bir düğmeydi ve menüyü
   *  10 satıra çıkarıyordu. Harita, pazarlamacı verisinin bir GÖRÜNÜMÜ olduğu
   *  için buraya taşındı.
   *
   *  `sekmeAc('harita')` GERİYE DÖNÜK ÇALIŞMAYA DEVAM EDER (aşağıdaki sarmal):
   *  Pazarlamacılar sekmesini açar ve harita alt sekmesini seçer. Eski bir
   *  çağrının sessizce hiçbir şey yapmaması, en kötü hata türüdür.
   * ------------------------------------------------------------------ */

  /** Seçili alt sekme — 'performans' | 'harita'. */
  var altSekme = 'performans';

  function altSekmeAc(ad) {
    altSekme = ('harita' === ad) ? 'harita' : 'performans';

    document.querySelectorAll('.plasiyer-alt').forEach(function (d) {
      /* Durum `aria-selected`'de taşınır, stil onu izler (bkz. index.html).
         Tek kaynak: ekran ve ekran okuyucu asla ayrışmaz. */
      d.setAttribute('aria-selected', d.dataset.alt === altSekme ? 'true' : 'false');
    });

    var perf = el('plasiyerAltPerformans');
    var harita = el('plasiyerAltHarita');

    if (perf) perf.hidden = ('performans' !== altSekme);
    if (harita) harita.hidden = ('harita' !== altSekme);

    /* "+ Yeni Pazarlamacı" / "Yenile" haritada işe yaramaz — gizlenir.
       Görünür ama işlevsiz düğme, kullanıcıya yalan söyler. */
    var araclar = el('plasiyerAraclar');
    if (araclar) araclar.hidden = ('performans' !== altSekme);

    if ('harita' === altSekme) {
      /* harita-kokpit.js BU DOSYADAN SONRA yükleniyor; bu yüzden çağrı
         yükleme anında değil TIKLAMA anında yapılır ve yine de korunur. */
      if (window.HaritaKokpit && 'function' === typeof window.HaritaKokpit.sekmeyiAc) {
        window.HaritaKokpit.sekmeyiAc();
      }
    }
  }

  /**
   * Çözülmemiş saha notu sayısını harita alt sekmesindeki rozete yazar.
   *
   * Sol menüdeki "Pazarlamacılar" rozetinde de durmaya devam eder: yönetici
   * sekmeyi hiç açmadan da acil bir not olduğunu görmeli.
   */
  function haritaRozetiYaz(sayi) {
    var rozet = el('haritaAltSayaci');

    if (!rozet) return;

    var n = Number(sayi) || 0;

    rozet.textContent = n > 99 ? '99+' : String(n);
    rozet.classList.toggle('hidden', n <= 0);
  }

  /* ------------------------------------------------------------------ *
   *  CİHAZ TAHSİSİ (saha terminali kilidi)
   *  ---------------------------------------------------------------
   *  Ayrıntı ve tehdit modeli: src/main/byom-yonetici-kilit.js başlığı.
   *  Burada yalnızca düğme ve onay var; karar ana süreçte verilir.
   * ------------------------------------------------------------------ */

  /** Bu cihaz şu an hangi plasiyere tahsisli? (0 = tahsis yok) */
  function tahsisliId() {
    var a = (typeof durum !== 'undefined' && durum.ayarlar) || {};

    if ('plasiyer_kilitli' !== a.cihazRolu) return 0;

    return Number(a.tahsisliPlasiyerId || 0) || 0;
  }

  /**
   * Satır sonundaki kilit düğmesi.
   *
   * Cihaz ZATEN bu plasiyere tahsisliyse düğme yerine durum rozeti gösterilir:
   * aynı kilidi ikinci kez kurmak anlamsız, ve "kilitli" bilgisini yöneticinin
   * görmesi gerekir. Kilidi kaldırmak kasıtlı olarak BURADA DEĞİL — giriş
   * ekranındaki discreet 🔓 + Master PIN ile yapılır; çünkü kilit kurulduktan
   * sonra bu sekmeye ulaşmanın yolu da Master PIN'den geçer.
   */
  function cihazDugmesi(p) {
    var id = Number(p.id) || 0;

    if (tahsisliId() === id && id > 0) {
      return '<span class="px-3 py-2 rounded-lg bg-amber-100 dark:bg-amber-900/40 ' +
             'text-amber-800 dark:text-amber-300 font-bold text-sm" ' +
             'title="Bu cihaz bu pazarlamacıya tahsisli. Kilidi giriş ekranındaki 🔓 ile açabilirsiniz.">' +
             '🔒 Bu Cihaza Tahsisli</span>';
    }

    return '<button type="button" class="plasiyer-cihaz px-3 py-2 rounded-lg border-2 ' +
           'border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 ' +
           'font-bold text-sm hover:bg-amber-50 dark:hover:bg-amber-900/30" ' +
           'data-id="' + id + '" ' +
           'title="Bu bilgisayarı yalnızca bu pazarlamacının girişine kilitler">' +
           '🔒 Bu Cihazı Tahsis Et</button>';
  }

  /**
   * Cihazı plasiyere kilitler.
   *
   * ONAY ŞART: kilit, cihazı eline alan kişinin yönetici ekranını tamamen
   * kapatır. Yanlış satıra tıklayan yöneticinin bunu fark etmeden yapması
   * kabul edilemez.
   */
  async function cihaziTahsisEt(plasiyerId) {
    var p = kayit.plasiyerler.find(function (x) { return Number(x.id) === Number(plasiyerId); });

    if (!p) return;

    var ad = String(p.ad || '').trim() || ('#' + plasiyerId);

    var onay = await onayla(
      'Cihazı Tahsis Et',
      'Bu bilgisayar yalnızca ' + ad + ' girişine kilitlenecektir. ' +
      'Yönetici giriş kapısı ekrandan kalkar ve geri dönmek için Yönetici Master PIN gerekir. ' +
      'Onaylıyor musunuz?',
      'KİLİTLE',
      true
    );

    if (!onay) return;

    var cevap = null;

    try {
      cevap = await ipcRenderer.invoke('cihaz:kilitle', { id: Number(plasiyerId), ad: ad });
    } catch (e) {
      cevap = null;
    }

    if (!cevap || !cevap.ok) {
      /* En sık sebep: Master PIN hiç belirlenmemiş. Ana süreç bunu açıkça
         söylüyor; mesajı olduğu gibi gösteriyoruz. */
      bildir((cevap && cevap.hata) || 'Cihaz kilitlenemedi.', 'hata');
      return;
    }

    /* Ayar kopyası tazelenir ki tablo doğru rozeti çizsin. */
    if (typeof durum !== 'undefined' && durum.ayarlar && cevap.durum) {
      durum.ayarlar.cihazRolu = cevap.durum.cihazKilitli ? 'plasiyer_kilitli' : 'standart';
      durum.ayarlar.tahsisliPlasiyerId = cevap.durum.tahsisliPlasiyerId;
      durum.ayarlar.tahsisliPlasiyerAd = cevap.durum.tahsisliPlasiyerAd;
    }

    tabloyuCiz();

    bildir(ad + ' için cihaz kilidi kuruldu. Uygulama bir dahaki açılışta ' +
           'doğrudan saha satış terminali olarak başlayacak.', 'basari');
  }

  /**
   * ÜÇ DÖNEM ÇİPİ — tablonun üstünde.
   *
   * index.html'e dokunulmadı: çipler tablonun kendi kabına çizilir ve zaten
   * var olan `#plasiyerTablo` delegasyonu tıklamayı yakalar. Böylece hem
   * işaretleme tek yerde kalır hem de her yeniden çizimde seçim doğru görünür.
   */
  function donemCipleri() {
    var destek = donemDestekli();
    var etkin = aktifDonem();

    var secenekler = [
      { ad: 'ay',   ikon: '📅', etiket: 'Bu Ay' + (kayit.donemAyAd ? ' (' + kayit.donemAyAd + ')' : '') },
      { ad: 'yil',  ikon: '🗓️', etiket: 'Bu Yıl' },
      { ad: 'tumu', ikon: 'Σ',  etiket: 'Tümü' }
    ];

    return '<div class="mb-4 flex items-center gap-2 flex-wrap" role="tablist" aria-label="Ciro dönemi">' +
      '<span class="text-sm font-bold text-slate-500 dark:text-slate-400">Ciro dönemi:</span>' +
      secenekler.map(function (sec) {
        var secili = (sec.ad === etkin);

        return '<button type="button" role="tab" data-donem="' + sec.ad + '" ' +
          /* Durum `aria-selected`'te taşınır (alt sekmelerle aynı kural):
             ekran ve ekran okuyucu asla ayrışmaz. */
          'aria-selected="' + (secili ? 'true' : 'false') + '" ' +
          (destek
            ? ''
            : 'disabled aria-disabled="true" title="Bu eklenti sürümü aylık/yıllık ciro göndermiyor — güncelleyin." ') +
          'class="plasiyer-donem px-3 py-1.5 rounded-xl border-2 font-bold text-sm transition ' +
            (secili
              ? 'border-marka-700 bg-marka-700 text-white'
              : 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700') +
            (destek ? '' : ' opacity-50 cursor-not-allowed') + '">' +
          '<span aria-hidden="true">' + sec.ikon + '</span> ' + kacis(sec.etiket) +
        '</button>';
      }).join('') +
      (destek
        ? ''
        : '<span class="text-xs font-bold text-amber-600 dark:text-amber-400">' +
          'Aylık/yıllık ciro için eklentiyi güncelleyin; tablo tüm zamanları gösteriyor.</span>') +
    '</div>';
  }

  /**
   * Hücrenin ikinci satırı: aylık VE yıllık ciro, küçük punto, yan yana.
   *
   * Ürün sahibinin asıl isteği "ikisini de AYRI AYRI görmek"ti: kalın satır
   * seçili dönemi söyler, bu satır her ikisini birden gösterir — dönem
   * değiştirmeden karşılaştırma yapılabilsin. Alanlar yoksa satır HİÇ basılmaz
   * (eski eklentide "undefined ₺" görünmez).
   */
  function ciroAltSatiri(p) {
    var ay = p ? p.ciroAy : undefined;
    var yil = p ? p.ciroYil : undefined;
    var parca = [];

    if (undefined !== ay && null !== ay && '' !== ay) parca.push(donemAdi('ay') + ' ' + paraYaz(ay));
    if (undefined !== yil && null !== yil && '' !== yil) parca.push('Yıllık ' + paraYaz(yil));

    if (!parca.length) return '';

    return '<div class="plasiyer-ciro-alt mt-0.5 text-xs font-bold text-slate-500 dark:text-slate-400">' +
      kacis(parca.join(' · ')) + '</div>';
  }

  function tabloyuCiz() {
    var kap = el('plasiyerTablo');

    if (!kap) return;

    if (!kayit.plasiyerler.length) {
      kap.innerHTML =
        '<div class="py-12 text-center">' +
          '<div class="text-5xl mb-4" aria-hidden="true">💼</div>' +
          '<div class="text-xl font-bold">Henüz pazarlamacı tanımlı değil</div>' +
          '<p class="mt-2 text-slate-500 dark:text-slate-400">' +
            '"+ Yeni Pazarlamacı" ile ad, bölge ve PIN belirleyerek başlayın.</p>' +
        '</div>';
      return;
    }

    /* Çubuk ölçeği AKTİF DÖNEMİN en yükseğine göre — genel toplama göre değil.
       Genel toplamla ölçeklenseydi 10 plasiyerli bir firmada tüm çubuklar
       okunamayacak kadar kısa kalırdı; tüm zamanların en yükseğiyle
       ölçeklenseydi de aylık görünümde bütün çubuklar ezilirdi. */
    var enYuksek = kayit.plasiyerler.reduce(function (m, p) {
      return Math.max(m, donemSayi(p, 'ciro'));
    }, 0);

    var genelDonem = genelDonemCiro();

    var satirlar = siraliPlasiyerler().map(function (p) {
      var ciro = donemSayi(p, 'ciro');
      var oran = enYuksek > 0 ? (ciro / enYuksek) : 0;
      var pay = genelDonem > 0 ? Math.round((ciro / genelDonem) * 100) : 0;

      return '' +
        '<tr class="border-t-2 border-slate-100 dark:border-slate-700">' +
          '<td class="py-4 pr-4">' +
            '<div class="font-extrabold text-lg flex items-center gap-2">' +
              (renkHex(p.renk)
                ? '<span class="plasiyer-renk inline-block w-3.5 h-3.5 rounded-full ring-2 ring-white dark:ring-slate-800 shrink-0" style="background:' + kacis(renkHex(p.renk)) + '" title="' + kacis(paletAdi(p.renk)) + '"></span>'
                : '<span class="plasiyer-renk inline-block w-3.5 h-3.5 rounded-full border-2 border-dashed border-slate-300 shrink-0" title="Renk atanmamış"></span>') +
              '<span>' + kacis(p.ad || '-') + '</span>' +
            '</div>' +
            '<div class="text-sm text-slate-500 dark:text-slate-400">' + kacis(p.kullanici || '') + '</div>' +
          '</td>' +
          '<td class="py-4 pr-4">' +
            (p.bolge
              ? '<span class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 font-bold text-sm">' + kacis(p.bolge) + '</span>'
              : '<span class="text-slate-400 text-sm">atanmamış</span>') +
            /* Sorumlu il sayısı (Faz 12): harita bu illeri plasiyerin rengine boyar. */
            (Array.isArray(p.iller) && p.iller.length
              ? '<div class="plasiyer-iller mt-1 text-xs font-bold text-slate-500 dark:text-slate-400" title="' + kacis(p.iller.map(function (pl) { var v = window.HaritaVeri && window.HaritaVeri.ilBul(Number(pl)); return v ? v.ad : pl; }).join(', ')) + '">🗺️ ' + p.iller.length + ' sorumlu il</div>'
              : '<div class="plasiyer-iller mt-1 text-xs font-bold text-amber-600 dark:text-amber-400">il atanmamış</div>') +
          '</td>' +
          '<td class="py-4 pr-4 text-center font-bold">' + (Number(p.bayi) || 0) + '</td>' +
          '<td class="plasiyer-siparis py-4 pr-4 text-center font-bold">' + donemSayi(p, 'siparis') + '</td>' +
          '<td class="py-4 pr-4 text-center font-bold" title="İskonto tavanı">%' + kacis(String(Number(p.maxIskonto) || 0)) + '</td>' +
          '<td class="plasiyer-ciro py-4 pr-4 min-w-56">' +
            '<div class="font-extrabold">' + kacis(paraYaz(ciro)) + '</div>' +
            ciroAltSatiri(p) +
            '<div class="mt-2 h-2.5 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">' +
              '<div class="ciro-cubuk h-full rounded-full bg-marka-700" ' +
                   'style="transform: scaleX(' + oran.toFixed(4) + ');" ' +
                   'role="img" aria-label="Ciro payı yüzde ' + pay + '"></div>' +
            '</div>' +
            '<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">toplamın %' + pay + '\'i</div>' +
          '</td>' +
          '<td class="py-4 text-right whitespace-nowrap">' +
            (p.pinTanimli
              ? '<span class="text-xs font-bold text-emerald-700 dark:text-emerald-400">PIN ✓</span>'
              : '<span class="text-xs font-bold text-amber-700 dark:text-amber-400">PIN yok</span>') +
            '<div class="mt-2 flex gap-2 justify-end flex-wrap">' +
              '<button type="button" class="plasiyer-duzenle px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + Number(p.id) + '">Düzenle</button>' +
              '<button type="button" class="plasiyer-bayiler px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + Number(p.id) + '">Bayiler</button>' +
              cihazDugmesi(p) +
            '</div>' +
          '</td>' +
        '</tr>';
    }).join('');

    /* Sıralanabilir başlık (Faz 12): tıklanınca aynı alan yön değiştirir. */
    function baslik(alan, etiket, sinif) {
      var aktif = kayit.sirala.alan === alan;
      var ok = aktif ? (kayit.sirala.yon < 0 ? ' ↓' : ' ↑') : '';

      return '<th class="pb-3 pr-4 ' + sinif + '">' +
        '<button type="button" class="plasiyer-sirala uppercase tracking-wide font-bold hover:text-slate-800 dark:hover:text-slate-100 ' + (aktif ? 'text-slate-800 dark:text-slate-100' : '') +
          '" data-alan="' + alan + '" aria-sort="' + (aktif ? (kayit.sirala.yon < 0 ? 'descending' : 'ascending') : 'none') + '" title="Sırala">' +
          etiket + ok + '</button></th>';
    }

    /* Sütun başlığı AKTİF DÖNEMİ yazar: "Ciro" tek başına hangi pencereden
       söz ettiğini söylemez ve yönetici yanlış rakamı raporlar. */
    var donemEk = ' · ' + donemAdi(aktifDonem());

    kap.innerHTML =
      donemCipleri() +
      '<div class="overflow-x-auto">' +
        '<table class="w-full text-left">' +
          '<thead class="text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">' +
            '<tr>' +
              baslik('ad', 'Pazarlamacı', '') +
              '<th class="pb-3 pr-4">Bölge</th>' +
              baslik('bayi', 'Bayi', 'text-center') +
              baslik('siparis', kacis('Sipariş' + donemEk), 'text-center') +
              baslik('maxIskonto', 'Tavan', 'text-center') +
              baslik('ciro', kacis('Ciro' + donemEk), '') +
              '<th class="pb-3 text-right">İşlem</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + satirlar + '</tbody>' +
        '</table>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   *  TANIMLAMA / DÜZENLEME FORMU
   * ------------------------------------------------------------------ */

  function formuKapat() {
    var perde = el('plasiyerFormPerde');
    if (perde) perde.hidden = true;

    /* PIN alanı perdeyle birlikte gitsin; DOM'da bekletilmez. */
    var form = el('plasiyerForm');
    if (form) form.innerHTML = '';
  }

  function formuAc(mevcut) {
    var perde = el('plasiyerFormPerde');
    var form = el('plasiyerForm');

    if (!perde || !form) return;

    var yeni = !mevcut;

    form.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div class="text-xl font-extrabold">' + (yeni ? 'Yeni Pazarlamacı' : 'Pazarlamacıyı Düzenle') + '</div>' +
        '<button type="button" id="plasiyerFormKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +

      '<label class="block mt-6 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfAd">Ad Soyad</label>' +
      '<input id="pfAd" type="text" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" value="' + kacis((mevcut && mevcut.ad) || '') + '" />' +

      (yeni
        ? '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfKullanici">Kullanıcı adı</label>' +
          '<input id="pfKullanici" type="text" autocomplete="off" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
          '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfEposta">E-posta</label>' +
          '<input id="pfEposta" type="email" autocomplete="off" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />'
        : '') +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfBolge">Bölge</label>' +
      '<input id="pfBolge" type="text" list="pfBolgeListe" placeholder="Ege" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" value="' + kacis((mevcut && mevcut.bolge) || '') + '" />' +
      '<datalist id="pfBolgeListe">' +
        ['Marmara', 'Ege', 'Akdeniz', 'İç Anadolu', 'Karadeniz', 'Doğu Anadolu', 'Güneydoğu Anadolu']
          .map(function (b) { return '<option value="' + b + '"></option>'; }).join('') +
      '</datalist>' +

      /* RENK (Faz 12): harita bu plasiyerin sorumlu illerini bu renge boyar. */
      '<div class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300">Harita rengi</div>' +
      '<div id="pfRenkPaleti" class="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Harita rengi">' +
        Object.keys(palet()).map(function (anahtar) {
          var secili = mevcut && String(mevcut.renk || '') === anahtar;
          return '<button type="button" class="pf-renk w-9 h-9 rounded-full ring-2 transition ' + (secili ? 'ring-slate-900 dark:ring-white scale-110' : 'ring-transparent hover:scale-105') +
                 '" data-renk="' + anahtar + '" role="radio" aria-checked="' + (secili ? 'true' : 'false') + '" title="' + kacis(paletAdi(anahtar)) + '" style="background:' + palet()[anahtar] + '"></button>';
        }).join('') +
      '</div>' +
      '<input type="hidden" id="pfRenk" value="' + kacis((mevcut && mevcut.renk) || '') + '" />' +

      /* SORUMLU İLLER (Faz 12): çoklu seçim — bölge kısayolu + arama. Başka
         plasiyerdeki il işaretlenemez (sunucu da çakışmayı reddeder). */
      '<div class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300">Sorumlu iller <span id="pfIlSayac" class="font-normal opacity-70">— 0 il seçili</span></div>' +
      '<div class="mt-2 flex items-center gap-2 flex-wrap">' +
        '<input id="pfIlAra" type="search" placeholder="İl ara…" class="flex-1 min-w-40 px-3 py-2 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold text-sm" />' +
        ['Marmara', 'Ege', 'Akdeniz', 'İç Anadolu', 'Karadeniz', 'Doğu Anadolu', 'Güneydoğu Anadolu'].map(function (b) {
          return '<button type="button" class="pf-bolge-sec px-2.5 py-1.5 rounded-lg border-2 border-slate-200 dark:border-slate-600 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700" data-bolge="' + b + '" title="' + b + ' bölgesinin (uygun) illerini seç">' + b + '</button>';
        }).join('') +
        '<button type="button" id="pfIlTemizle" class="px-2.5 py-1.5 rounded-lg border-2 border-slate-200 dark:border-slate-600 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700">Temizle</button>' +
      '</div>' +
      '<div id="pfIlListe" class="mt-2 max-h-48 overflow-y-auto rounded-xl border-2 border-slate-200 dark:border-slate-600 p-2 grid grid-cols-2 sm:grid-cols-3 gap-1">' +
        (function () {
          var secili = {};
          ((mevcut && Array.isArray(mevcut.iller)) ? mevcut.iller : []).forEach(function (pl) { secili[Number(pl)] = true; });
          var sahip = ilSahipleri(mevcut ? mevcut.id : 0);

          return iller().map(function (il) {
            var baskasinin = sahip[il.plaka];
            return '<label class="pf-il flex items-center gap-2 px-2 py-1 rounded-lg text-sm font-semibold ' + (baskasinin ? 'opacity-50' : 'hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer') + '" data-ad="' + kacis(il.ad) + '" data-bolge="' + kacis(il.bolge) + '" title="' + (baskasinin ? kacis(baskasinin) + ' sorumlu' : kacis(il.bolge)) + '">' +
              '<input type="checkbox" class="pf-il-kutu w-4 h-4 accent-marka-600" value="' + il.plaka + '"' + (secili[il.plaka] ? ' checked' : '') + (baskasinin ? ' disabled' : '') + ' />' +
              '<span>' + kacis(il.ad) + ' <span class="opacity-60">(' + il.plaka + ')</span></span>' +
              (baskasinin ? '<span class="ml-auto text-[10px] font-bold text-amber-600 truncate">' + kacis(baskasinin) + '</span>' : '') +
            '</label>';
          }).join('');
        })() +
      '</div>' +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfTavan">İskonto tavanı (%) <span class="font-normal opacity-70">— sahada verebileceği en yüksek bayi iskontosu</span></label>' +
      '<input id="pfTavan" type="number" min="0" max="100" step="0.5" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" value="' + kacis(String((mevcut && null !== mevcut.maxIskonto && undefined !== mevcut.maxIskonto) ? mevcut.maxIskonto : '')) + '" placeholder="0" />' +
      '<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">Boş bırakılırsa mağazanın genel tavanı geçerlidir. Tanımsız tavan SINIRSIZ değil SIFIRDIR; son söz sunucudadır.</p>' +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfPin">PIN (4-6 rakam)</label>' +
      '<input id="pfPin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-xl font-black tracking-[0.3em] text-center" placeholder="••••" />' +
      '<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">' +
        (yeni
          ? 'Yeni pazarlamacı için PIN zorunludur.'
          : ((mevcut && mevcut.pinTanimli) ? 'PIN tanımlı. Değiştirmek için yeni PIN yazın, dokunmamak için boş bırakın.' : 'PIN tanımlı DEĞİL — panele girebilmesi için belirleyin.')) +
      '</p>' +

      '<p id="pfHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +

      '<button type="button" id="pfKaydet" class="mt-6 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 disabled:opacity-50 transition">Kaydet</button>';

    perde.hidden = false;

    el('plasiyerFormKapat').addEventListener('click', formuKapat);
    el('pfKaydet').addEventListener('click', function () { kaydet(mevcut); });

    var pin = el('pfPin');

    pin.addEventListener('input', function () {
      var temiz = pin.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (temiz !== pin.value) pin.value = temiz;
    });

    /* Renk paleti: tek seçim, tekrar tıklayınca kaldırılır. */
    var paletKap = el('pfRenkPaleti');
    if (paletKap) {
      paletKap.addEventListener('click', function (olay) {
        var d = olay.target.closest('.pf-renk');
        if (!d) return;

        var gizli = el('pfRenk');
        var yeniRenk = gizli.value === d.dataset.renk ? '' : d.dataset.renk;
        gizli.value = yeniRenk;

        paletKap.querySelectorAll('.pf-renk').forEach(function (b) {
          var secili = b.dataset.renk === yeniRenk;
          b.setAttribute('aria-checked', secili ? 'true' : 'false');
          b.className = 'pf-renk w-9 h-9 rounded-full ring-2 transition ' + (secili ? 'ring-slate-900 dark:ring-white scale-110' : 'ring-transparent hover:scale-105');
        });
      });
    }

    /* İl seçici: sayaç, arama, bölge kısayolu, temizle. */
    var ilListe = el('pfIlListe');

    function ilSayaciniYaz() {
      var n = ilListe ? ilListe.querySelectorAll('.pf-il-kutu:checked').length : 0;
      var sayac = el('pfIlSayac');
      if (sayac) sayac.textContent = '— ' + n + ' il seçili';
    }

    if (ilListe) {
      ilListe.addEventListener('change', ilSayaciniYaz);

      var ara = el('pfIlAra');
      if (ara) {
        ara.addEventListener('input', function () {
          var q = String(ara.value || '').toLocaleLowerCase('tr-TR');
          ilListe.querySelectorAll('.pf-il').forEach(function (satir) {
            satir.hidden = !!q && String(satir.dataset.ad || '').toLocaleLowerCase('tr-TR').indexOf(q) === -1;
          });
        });
      }

      form.querySelectorAll('.pf-bolge-sec').forEach(function (b) {
        b.addEventListener('click', function () {
          ilListe.querySelectorAll('.pf-il').forEach(function (satir) {
            var kutu = satir.querySelector('.pf-il-kutu');
            if (satir.dataset.bolge === b.dataset.bolge && kutu && !kutu.disabled) kutu.checked = true;
          });
          ilSayaciniYaz();
        });
      });

      var temizle = el('pfIlTemizle');
      if (temizle) {
        temizle.addEventListener('click', function () {
          ilListe.querySelectorAll('.pf-il-kutu').forEach(function (kutu) { if (!kutu.disabled) kutu.checked = false; });
          ilSayaciniYaz();
        });
      }

      ilSayaciniYaz();
    }

    el('pfAd').focus();
  }

  async function kaydet(mevcut) {
    var dugme = el('pfKaydet');
    var hata = el('pfHata');
    var pinAlan = el('pfPin');

    var tavanAlan = el('pfTavan');
    var tavanMetin = String((tavanAlan && tavanAlan.value) || '').trim();

    /*
     * Boş tavan "kaldır" demektir ve meşru bir eylemdir — ama SESSİZ olmamalı.
     * Alan bir <input type="number">: geçersiz bir tuş (harf) değeri boşaltır,
     * kullanıcı yalnızca PIN değiştirmek isterken mevcut tavanı silebilir.
     * Yalnızca gerçekten tavanı OLAN bir kayıtta sorulur; yeni kayıtta ya da
     * zaten tavansız kayıtta tek fazladan tık bile istemeyiz.
     */
    if ('' === tavanMetin && mevcut && Number(mevcut.maxIskonto) > 0) {
      var tavanOnay = await onayla(
        'İskonto Tavanını Kaldır',
        String(mevcut.ad || 'Bu pazarlamacı') + ' için kişiye özel iskonto tavanı (%' +
        (Number(mevcut.maxIskonto) || 0) + ') kaldırılacak; bundan sonra global tavan geçerli olur.',
        'KALDIR'
      );

      if (!tavanOnay) return;
    }

    var ilKutulari = Array.prototype.slice.call((el('pfIlListe') || document.createElement('div')).querySelectorAll('.pf-il-kutu:checked'));

    function ilListesiCizildi() {
      var kap = el('pfIlListe');

      return !!(kap && kap.querySelector('.pf-il-kutu'));
    }

    var govde = {
      plasiyer_id: mevcut ? Number(mevcut.id) : 0,
      ad: String(el('pfAd').value || '').trim(),
      bolge: String(el('pfBolge').value || '').trim(),
      /* Faz 12: harita rengi + sorumlu iller (plaka listesi). */
      renk: String((el('pfRenk') || {}).value || ''),
      /*
       * `null` = DOKUNMA, `[]` = tümünü kaldır (sunucu sözleşmesi). İl listesi
       * hiç çizilemediyse (HaritaVeri yüklenmemiş) boş dizi göndermek, PIN
       * değiştirmek için açılan bir formun mevcut il atamasını SESSİZCE
       * silmesi demekti.
       */
      iller: ilListesiCizildi()
        ? ilKutulari.map(function (k) { return Number(k.value); }).filter(function (n) { return n >= 1 && n <= 81; })
        : null,
      /* '' = tavanı kaldır (globale dön); sayı = kişiye özel tavan. */
      maxIskonto: tavanMetin,
      pin: String((pinAlan && pinAlan.value) || '')
    };

    if ('' !== tavanMetin) {
      var tavanSayi = Number(tavanMetin.replace(',', '.'));

      if (!isFinite(tavanSayi) || tavanSayi < 0 || tavanSayi > 100) {
        return yaz(hata, 'İskonto tavanı 0-100 arasında olmalıdır.');
      }

      /*
       * METIN olarak gonderilir, sayi olarak DEGIL.
       *
       * Panel ve eklenti ayri yayinlanir: sahadaki kurulumlarin bir kismi
       * hala eski semayi (`type: string`) calistiriyor ve sayi gonderen bir
       * istek orada "Parametreler gecersiz: maxIskonto" ile reddedilir.
       * Sayisal metin HER IKI semadan da gecer (2.18.2 sunucu tarafi zaten
       * ikisini birden kabul ediyor). Deger yukarida dogrulandi ve
       * normallestirildi — "7,5" burada "7.5" olur.
       */
      govde.maxIskonto = String(tavanSayi);
    }

    if (!mevcut) {
      govde.kullanici = String((el('pfKullanici') || {}).value || '').trim();
      govde.eposta = String((el('pfEposta') || {}).value || '').trim();

      if (!govde.kullanici) return yaz(hata, 'Kullanıcı adı zorunludur.');
      if (!govde.eposta) return yaz(hata, 'E-posta zorunludur.');
      if (!/^[0-9]{4,6}$/.test(govde.pin)) return yaz(hata, 'Yeni pazarlamacı için 4-6 haneli PIN zorunludur.');
    } else if (govde.pin && !/^[0-9]{4,6}$/.test(govde.pin)) {
      return yaz(hata, 'PIN 4-6 haneli ve yalnızca rakam olmalıdır.');
    }

    yaz(hata, '');
    if (dugme) dugme.disabled = true;

    var cevap;

    try {
      cevap = await b2b('/admin/plasiyer', { metod: 'POST', govde: govde });
    } finally {
      /* PIN hem yükten hem ekrandan silinir. */
      govde.pin = '';
      if (pinAlan) pinAlan.value = '';
      if (dugme) dugme.disabled = false;
    }

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
      yaz(hata, (cevap && cevap.hata) || 'Kaydedilemedi.');
      return;
    }

    formuKapat();
    bildir(mevcut ? 'Pazarlamacı güncellendi.' : 'Pazarlamacı tanımlandı.', 'ok');
    listeyiGetir();
  }

  function yaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  /* ------------------------------------------------------------------ *
   *  BAYİ ATAMA
   * ------------------------------------------------------------------ */

  async function bayiPerdesiniAc(plasiyerId) {
    var p = kayit.plasiyerler.find(function (x) { return Number(x.id) === Number(plasiyerId); });

    if (!p) return;

    var perde = el('plasiyerFormPerde');
    var form = el('plasiyerForm');

    if (!perde || !form) return;

    form.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div><div class="text-xl font-extrabold">Bayi Ataması</div>' +
        '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' + kacis(p.ad) + (p.bolge ? ' — ' + kacis(p.bolge) : '') + '</div></div>' +
        '<button type="button" id="plasiyerFormKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +
      '<div id="pfBayiYukleniyor" class="mt-5 text-slate-600 dark:text-slate-300">Bayiler yükleniyor…</div>';

    perde.hidden = false;
    el('plasiyerFormKapat').addEventListener('click', formuKapat);

    /*
     * BAYİ LİSTESİ — /wc-b2b/v1/dealers (b2b_get_dealer_meta alanları:
     * company_name, contact_name, first_name/last_name, city, district,
     * assigned_plasiyer_id). Görsel 1'deki "#8, #7" hatası: eski kod
     * `unvan/company/name` arıyordu, yanıt `company_name` taşıyordu → her
     * satır ham kimliğe düşüyordu. Sayfalı toplu getirici (renderer.js
     * tumSayfalariGetir) varsa kullanılır — 100'den fazla bayi kaybolmasın.
     */
    var cevap;

    try {
      cevap = ('function' === typeof window.tumSayfalariGetir)
        ? await window.tumSayfalariGetir('b2b', 'dealers', { status: 'all' }, { sureAsimi: 30000 })
        : await b2b('/dealers', { sorgu: { per_page: 200 } });
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Bayi listesi alınamadı.' };
    }

    var yukleniyor = el('pfBayiYukleniyor');
    var ham = cevap && cevap.ok ? cevap.veri : null;
    var bayiler = Array.isArray(ham) ? ham : ((ham && (ham.dealers || ham.users)) || []);

    if (!cevap || !cevap.ok || !Array.isArray(bayiler)) {
      if (yukleniyor) {
        yukleniyor.className = 'mt-4 text-amber-700 dark:text-amber-400 font-semibold text-sm';
        yukleniyor.textContent = 'Bayi listesi alınamadı' + ((cevap && cevap.hata) ? ': ' + cevap.hata : '.') +
          ' Atamayı WordPress kullanıcı profilinden de yapabilirsiniz (Kullanıcılar ▸ Profil ▸ BYOM Plasiyer).';
      }
      return;
    }

    var satirlar = bayiler.map(function (b) {
      var k = bayiKunyesi(b);
      var bagliMi = Number(b.assigned_plasiyer_id || b.plasiyerId || (b.byom && b.byom.plasiyerId) || 0) === Number(plasiyerId);
      var baskasinin = !bagliMi && Number(b.assigned_plasiyer_id || b.plasiyerId || 0) > 0;

      return '<label class="bayi-satir flex items-center gap-3 py-2 border-b border-slate-100 dark:border-slate-700" data-arama="' + kacis(k.arama) + '">' +
        '<input type="checkbox" class="bayi-sec w-5 h-5 shrink-0" data-id="' + k.id + '"' + (bagliMi ? ' checked' : '') + ' />' +
        '<span class="min-w-0">' +
          '<span class="block font-semibold truncate">' + kacis(k.baslik) + '</span>' +
          (k.altSatir ? '<span class="block text-xs text-slate-500 dark:text-slate-400 truncate">' + kacis(k.altSatir) + '</span>' : '') +
        '</span>' +
        (baskasinin ? '<span class="ml-auto shrink-0 text-xs font-bold text-amber-700 dark:text-amber-400">başka plasiyerde</span>' : '') +
      '</label>';
    }).join('');

    if (yukleniyor) {
      yukleniyor.outerHTML =
        '<input id="pfBayiAra" type="search" autocomplete="off" placeholder="Firma, yetkili, il ya da e-posta ara…" ' +
               'class="mt-5 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
        '<div id="pfBayiListe" class="mt-3 max-h-72 overflow-y-auto">' +
          (satirlar || '<p class="py-6 text-center text-slate-500">Kayıtlı bayi yok.</p>') +
        '</div>' +
        '<p id="pfHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
        '<button type="button" id="pfAta" class="mt-5 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">Atamayı Kaydet</button>';
    }

    var ara = el('pfBayiAra');

    if (ara) {
      ara.addEventListener('input', function () {
        var q = ara.value.toLocaleLowerCase('tr');

        document.querySelectorAll('#pfBayiListe .bayi-satir').forEach(function (satir) {
          satir.hidden = !!q && String(satir.dataset.arama || '').indexOf(q) === -1;
        });
      });
    }

    var ata = el('pfAta');
    if (ata) ata.addEventListener('click', function () { atamayiKaydet(plasiyerId); });
  }

  /**
   * Bayi yanıtından okunur künye: "Firma Ünvanı (Yetkili Adı) — İl/İlçe".
   *
   * Alan adları iki kaynaktan gelebilir: /dealers (company_name, contact_name,
   * city, district) ve plasiyer yükü (unvan, ad, il, ilce). İkisi de okunur.
   */
  function bayiKunyesi(b) {
    var id = Number(b.id || b.ID || 0);
    var firma = String(b.company_name || b.unvan || b.company || '').trim();
    var yetkili = String(b.contact_name || b.ad || [b.first_name, b.last_name].filter(Boolean).join(' ') || b.name || b.display_name || b.username || '').trim();
    var yer = [b.il || b.city, b.ilce || b.district].filter(Boolean).join('/');
    var baslik = firma || yetkili || ('Bayi #' + id);

    if (firma && yetkili && firma !== yetkili) baslik += ' (' + yetkili + ')';
    if (yer) baslik += ' — ' + yer;

    return {
      id: id,
      baslik: baslik,
      altSatir: [b.email || b.eposta, b.tax_number || b.vergiNo].filter(Boolean).join(' · '),
      arama: [firma, yetkili, yer, b.email || b.eposta, b.tax_number || b.vergiNo].filter(Boolean).join(' ').toLocaleLowerCase('tr')
    };
  }

  async function atamayiKaydet(plasiyerId) {
    var dugme = el('pfAta');
    var secimler = Array.prototype.slice.call(document.querySelectorAll('.bayi-sec'));

    if (dugme) dugme.disabled = true;

    var hataSayisi = 0;

    for (var i = 0; i < secimler.length; i++) {
      var kutu = secimler[i];
      var id = Number(kutu.dataset.id) || 0;

      if (!id) continue;

      var cevap = await b2b('/admin/plasiyer/ata', {
        metod: 'POST',
        govde: { dealer_id: id, plasiyer_id: kutu.checked ? Number(plasiyerId) : 0 }
      });

      if (!cevap || !cevap.ok) hataSayisi++;
    }

    if (dugme) dugme.disabled = false;

    if (hataSayisi) {
      yaz(el('pfHata'), hataSayisi + ' bayi atanamadı.');
      return;
    }

    formuKapat();
    bildir('Bayi ataması kaydedildi.', 'ok');
    listeyiGetir();
  }

  /* ------------------------------------------------------------------ *
   *  OLAY BAĞLAMA
   * ------------------------------------------------------------------ */

  function olaylariBagla() {
    if (bagli) return;   // sekme her açılışta çağrılır; ikinci bağlanma YOK
    bagli = true;

    var yenile = el('plasiyerYenile');
    if (yenile) yenile.addEventListener('click', listeyiGetir);

    var yeni = el('plasiyerYeni');
    if (yeni) yeni.addEventListener('click', function () { formuAc(null); });

    /* Alt sekme anahtarı (Ciro | Harita). */
    document.querySelectorAll('.plasiyer-alt').forEach(function (d) {
      d.addEventListener('click', function () { altSekmeAc(d.dataset.alt); });
    });

    /* Satır düğmeleri tabloyla birlikte yeniden çizildiği için OLAY
       DELEGASYONU kullanılır; her çizimde yeniden bağlamak çift tetiklemeye
       yol açardı. */
    var kap = el('plasiyerTablo');

    if (kap) {
      kap.addEventListener('click', function (olay) {
        /* DÖNEM ÇİPİ — yalnızca yerel durum değişir, `listeyiGetir()` ÇAĞRILMAZ.
           Üç kova da (`ciro`/`ciroAy`/`ciroYil`) elimizde; yeniden istemek
           hem gereksiz bir ağ turu hem de "ölçüt değişimi ağa çıkmaz" sözünün
           (panel CLAUDE.md §4.10) ihlali olurdu. */
        var cip = olay.target.closest('.plasiyer-donem');

        if (cip) {
          /* Devre dışı çip (eski eklenti) tarayıcıya göre olay üretebilir. */
          if (!cip.disabled) donemSec(String(cip.dataset.donem || 'tumu'));
          return;
        }

        var sirala = olay.target.closest('.plasiyer-sirala');

        if (sirala) {
          var alan = String(sirala.dataset.alan || 'ciro');

          kayit.sirala = { alan: alan, yon: kayit.sirala.alan === alan ? -kayit.sirala.yon : ('ad' === alan ? 1 : -1) };
          tabloyuCiz();
          return;
        }

        var duzenle = olay.target.closest('.plasiyer-duzenle');

        if (duzenle) {
          var id = Number(duzenle.dataset.id);
          formuAc(kayit.plasiyerler.find(function (p) { return Number(p.id) === id; }) || null);
          return;
        }

        var bayiler = olay.target.closest('.plasiyer-bayiler');

        if (bayiler) {
          bayiPerdesiniAc(Number(bayiler.dataset.id));
          return;
        }

        var cihazDugme = olay.target.closest('.plasiyer-cihaz');
        if (cihazDugme) cihaziTahsisEt(Number(cihazDugme.dataset.id));
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  MEVCUT AKIŞA BAĞLANMA
   * ------------------------------------------------------------------ */

  /*
   * `sekmeAc` SARILIR, değiştirilmez: önce özgün davranış çalışır, sonra
   * sekme bizimse veriyi getiririz. renderer.js'e tek satır eklemeden
   * özellik kazanmanın yolu bu (aynı kalıp renderer-excel.js ve
   * renderer-byom.js'te de kullanılır).
   */
  function akisaBaglan() {
    if ('function' !== typeof window.sekmeAc) return;

    var ozgun = window.sekmeAc;

    window.sekmeAc = function (ad) {
      /*
       * GERİYE DÖNÜK TAKMA AD: 'harita' artık bir ana sekme değil, bu sekmenin
       * alt sekmesi. Eski çağrıları (ve `durum.aktifSekme === 'harita'` kalmış
       * bir oturumu) sessizce yutmak yerine doğru yere yönlendiriyoruz.
       */
      var haritaIstendi = ('harita' === ad);

      if (haritaIstendi) {
        ad = 'plasiyerler';
        arguments[0] = 'plasiyerler';
      }

      var sonuc = ozgun.apply(this, arguments);

      if ('plasiyerler' === ad) {
        olaylariBagla();
        altSekmeAc(haritaIstendi ? 'harita' : altSekme);
        if (!kayit.plasiyerler.length) listeyiGetir();
      }

      return sonuc;
    };
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', akisaBaglan);
  } else {
    akisaBaglan();
  }

  window.PlasiyerYonetimi = {
    bayiKunyesi: bayiKunyesi,
    palet: palet,
    ilSahipleri: ilSahipleri,
    listeyiGetir: listeyiGetir,
    tabloyuCiz: tabloyuCiz,
    formuAc: formuAc,
    formuKapat: formuKapat,
    cihaziTahsisEt: cihaziTahsisEt,
    tahsisliId: tahsisliId,
    altSekmeAc: altSekmeAc,
    donemSec: donemSec,
    aktifDonem: aktifDonem,
    haritaRozetiYaz: haritaRozetiYaz,
    altSekme: function () { return altSekme; },
    kayit: kayit
  };
})();
