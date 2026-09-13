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
  var kayit = { plasiyerler: [], genelCiro: 0, genelSiparis: 0, paraBirimi: '', bayiler: [] };

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

    tabloyuCiz();
    ozetiTazele();
  }

  function ozetiTazele() {
    var ozet = el('plasiyerOzet');

    if (!ozet) return;

    ozet.textContent = kayit.plasiyerler.length + ' pazarlamacı · ' +
                       kayit.genelSiparis + ' sipariş · ' + paraYaz(kayit.genelCiro);
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

    /* Çubuk ölçeği EN YÜKSEK ciroya göre — genel toplama göre değil.
       Genel toplamla ölçeklenseydi 10 plasiyerli bir firmada tüm çubuklar
       okunamayacak kadar kısa kalırdı. */
    var enYuksek = kayit.plasiyerler.reduce(function (m, p) {
      return Math.max(m, Number(p.ciro) || 0);
    }, 0);

    var satirlar = kayit.plasiyerler.map(function (p) {
      var ciro = Number(p.ciro) || 0;
      var oran = enYuksek > 0 ? (ciro / enYuksek) : 0;
      var pay = kayit.genelCiro > 0 ? Math.round((ciro / kayit.genelCiro) * 100) : 0;

      return '' +
        '<tr class="border-t-2 border-slate-100 dark:border-slate-700">' +
          '<td class="py-4 pr-4">' +
            '<div class="font-extrabold text-lg">' + kacis(p.ad || '-') + '</div>' +
            '<div class="text-sm text-slate-500 dark:text-slate-400">' + kacis(p.kullanici || '') + '</div>' +
          '</td>' +
          '<td class="py-4 pr-4">' +
            (p.bolge
              ? '<span class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 font-bold text-sm">' + kacis(p.bolge) + '</span>'
              : '<span class="text-slate-400 text-sm">atanmamış</span>') +
          '</td>' +
          '<td class="py-4 pr-4 text-center font-bold">' + (Number(p.bayi) || 0) + '</td>' +
          '<td class="py-4 pr-4 text-center font-bold">' + (Number(p.siparis) || 0) + '</td>' +
          '<td class="py-4 pr-4 text-center font-bold" title="İskonto tavanı">%' + kacis(String(Number(p.maxIskonto) || 0)) + '</td>' +
          '<td class="py-4 pr-4 min-w-56">' +
            '<div class="font-extrabold">' + kacis(paraYaz(ciro)) + '</div>' +
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

    kap.innerHTML =
      '<div class="overflow-x-auto">' +
        '<table class="w-full text-left">' +
          '<thead class="text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">' +
            '<tr>' +
              '<th class="pb-3 pr-4">Pazarlamacı</th>' +
              '<th class="pb-3 pr-4">Bölge</th>' +
              '<th class="pb-3 pr-4 text-center">Bayi</th>' +
              '<th class="pb-3 pr-4 text-center">Sipariş</th>' +
              '<th class="pb-3 pr-4 text-center">Tavan</th>' +
              '<th class="pb-3 pr-4">Ciro</th>' +
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

    el('pfAd').focus();
  }

  async function kaydet(mevcut) {
    var dugme = el('pfKaydet');
    var hata = el('pfHata');
    var pinAlan = el('pfPin');

    var tavanAlan = el('pfTavan');
    var tavanMetin = String((tavanAlan && tavanAlan.value) || '').trim();

    var govde = {
      plasiyer_id: mevcut ? Number(mevcut.id) : 0,
      ad: String(el('pfAd').value || '').trim(),
      bolge: String(el('pfBolge').value || '').trim(),
      /* '' = tavanı kaldır (globale dön); sayı = kişiye özel tavan. */
      maxIskonto: tavanMetin,
      pin: String((pinAlan && pinAlan.value) || '')
    };

    if ('' !== tavanMetin) {
      var tavanSayi = Number(tavanMetin.replace(',', '.'));

      if (!isFinite(tavanSayi) || tavanSayi < 0 || tavanSayi > 100) {
        return yaz(hata, 'İskonto tavanı 0-100 arasında olmalıdır.');
      }

      govde.maxIskonto = tavanSayi;
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
    listeyiGetir: listeyiGetir,
    tabloyuCiz: tabloyuCiz,
    formuAc: formuAc,
    formuKapat: formuKapat,
    cihaziTahsisEt: cihaziTahsisEt,
    tahsisliId: tahsisliId,
    altSekmeAc: altSekmeAc,
    haritaRozetiYaz: haritaRozetiYaz,
    altSekme: function () { return altSekme; },
    kayit: kayit
  };
})();
