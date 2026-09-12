/* ============================================================================
 *  ÇİFT KAPILI GİRİŞ VE ROL KISITLAMASI — ARAYÜZ (renderer-plasiyer.js)
 *  ---------------------------------------------------------------------------
 *  Lisans doğrulaması geçildikten sonra kullanıcıyı iki kapıyla karşılar:
 *    👑 Yönetici Girişi   → mevcut tam panel (hiçbir davranış değişmez)
 *    💼 Pazarlamacı Girişi → plasiyer seçimi + PIN, sonra KISITLI panel
 *
 *  MEVCUT AKIŞ BOZULMAZ — en önemli tasarım kararı:
 *  `baslat()` ve sekme akışına DOKUNULMAZ. Kapı bir KAPLAMADIR (overlay):
 *  panel arkada normal şekilde açılır, kapı üstünde durur. Yönetici kapıyı
 *  seçince kaplama kalkar ve panel 2.0.0'daki hâliyle devam eder. Böylece
 *  `sifir-kurulum.test.js`'in kilitlediği açılış dalı (bağlantı yoksa
 *  Ayarlar'a düş, sipariş isteği atma) aynen korunur.
 *
 *  SIFIR KURULUMDA KAPI GÖSTERİLMEZ. Bağlantı (adres + iki anahtar) yoksa
 *  pazarlamacı girişi çalışamaz; kapı açmak kullanıcıyı tıklayınca hata veren
 *  bir düğmeyle karşılaştırırdı. O durumda doğrudan yönetici akışına geçilir.
 *
 *  DURUM ADI: Şartname `appState.currentUser = { role, id, name, region }`
 *  diyor. Bu depoda durum nesnesi `durum` ve alan adları Türkçedir; aynı bilgi
 *  için iki ad tutmak (bu depoda iki kez canımızı yakmış) bir hata sınıfıdır.
 *  Tek ad kullanılır:
 *      durum.oturum = { rol: 'admin'|'plasiyer', id, ad, bolge }
 *
 *  SIR: PIN bu katmanda SAKLANMAZ; okunur, IPC'ye verilir, alan temizlenir.
 *  Oturum jetonu arayüze HİÇ GELMEZ (bkz. main.js § 3.6).
 *
 *  Yükleme sırası: renderer.js ve renderer-ek.js'ten SONRA (durum, $, bildir,
 *  sekmeAc, api kısayollarını kullanır).
 * ==========================================================================*/

'use strict';

(function () {

  /**
   * Plasiyer oturumunda GÖRÜNECEK sekmeler.
   *
   * FAZ 2'DE DEĞİŞTİ: "Ürün & Stok Yönetimi" (urunler) plasiyere KAPANDI,
   * yerine "Katalog & Sipariş Yazma" (satis) geldi. Sebebi yetki: `urunler`
   * sekmesi fiyat ve stok DÜZENLER; plasiyerin işi satmak, katalogu
   * değiştirmek değil. `satis` sekmesi aynı veriyi salt-okunur gösterir ve
   * sipariş yazar.
   */
  var PLASIYER_SEKMELERI = ['satis', 'siparisler'];

  /** Plasiyer oturumunda gizlenecek sekmeler (beyaz liste dışı olanlar). */
  var KISITLI_SEKMELER = ['ayarlar', 'iskonto', 'vitrin-editor', 'uyeler', 'destek', 'plasiyerler', 'urunler'];

  var kapi = null;
  var pinPerde = null;
  var plasiyerListesi = [];

  /* ------------------------------------------------------------------ *
   *  Yardımcılar
   * ------------------------------------------------------------------ */

  function el(id) {
    return document.getElementById(id);
  }

  function gorunur(dugum, goster) {
    if (!dugum) return;
    dugum.hidden = !goster;
  }

  /** Bağlantı kurulu mu? renderer.js'teki aynı adlı yardımcıyı kullanır. */
  function baglantiVar() {
    try {
      if (typeof baglantiKuruluMu === 'function') return !!baglantiKuruluMu();
    } catch (e) { /* yardımcı henüz yok */ }

    var a = (typeof durum !== 'undefined' && durum.ayarlar) || {};

    return !!(String(a.wooUrl || '').trim() && String(a.ck || '').trim() && String(a.cs || '').trim());
  }

  function hataYaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  /* ------------------------------------------------------------------ *
   *  OTURUM DURUMU
   * ------------------------------------------------------------------ */

  function oturumKur(rol, bilgi) {
    bilgi = bilgi || {};

    durum.oturum = {
      rol: rol,
      id: Number(bilgi.id || 0) || 0,
      ad: String(bilgi.ad || ''),
      bolge: String(bilgi.bolge || ''),
      /* İskonto tavanı (Faz 2). Yalnızca GÖSTERİM ve anında uyarı içindir;
         son sözü sunucu söyler (B2B_Plasiyer::iskonto_gecerli_mi). */
      maxIskonto: Number(bilgi.maxIskonto || 0) || 0
    };

    return durum.oturum;
  }

  function plasiyerMi() {
    return !!(durum.oturum && 'plasiyer' === durum.oturum.rol);
  }

  /* ------------------------------------------------------------------ *
   *  ARAYÜZ KISITLAMASI
   * ------------------------------------------------------------------ */

  /**
   * Plasiyer oturumunda menüyü ve üst barı daraltır.
   *
   * Düğmeler GİZLENİR, ayrıca `disabled` yapılır: yalnızca CSS ile gizlemek
   * klavyeyle (Tab) erişimi açık bırakırdı.
   */
  function kisitlamayiUygula() {
    var kisit = plasiyerMi();

    document.querySelectorAll('.menu-btn').forEach(function (btn) {
      var ad = btn.dataset.sekme;
      var kapat = kisit && KISITLI_SEKMELER.indexOf(ad) !== -1;

      btn.classList.toggle('plasiyer-gizli', kapat);
      btn.disabled = kapat;
      if (kapat) btn.setAttribute('aria-hidden', 'true');
      else btn.removeAttribute('aria-hidden');
    });

    /* "Pazarlamacılar" sekmesi yalnızca yöneticide. */
    document.querySelectorAll('[data-rol="admin"]').forEach(function (d) {
      d.classList.toggle('plasiyer-gizli', kisit);
    });

    ustBariTazele();

    /* Kısıtlı bir sekmede kalındıysa izinli ilk sekmeye geç. */
    if (kisit && KISITLI_SEKMELER.indexOf(durum.aktifSekme) !== -1) {
      sekmeAc(PLASIYER_SEKMELERI[0]);
    }
  }

  /** Üst barda plasiyerin adı, bölgesi ve çıkış düğmesi. */
  function ustBariTazele() {
    var kutu = el('plasiyerUstBar');

    if (!plasiyerMi()) {
      if (kutu) kutu.remove();
      return;
    }

    if (!kutu) {
      kutu = document.createElement('div');
      kutu.id = 'plasiyerUstBar';
      kutu.className = 'flex items-center gap-3 ml-auto';

      var hedef = document.querySelector('header .flex') || document.querySelector('header');
      if (hedef) hedef.appendChild(kutu);
    }

    var ad = durum.oturum.ad || 'Pazarlamacı';
    var bolge = durum.oturum.bolge ? (durum.oturum.bolge + ' Bölgesi') : 'Bölge atanmamış';

    kutu.innerHTML =
      '<span class="px-4 py-2 rounded-xl bg-marka-700 text-white font-extrabold text-base">' +
        '<span aria-hidden="true">💼</span> ' + kacis(ad) +
        ' <span class="font-semibold opacity-80">— ' + kacis(bolge) + '</span>' +
      '</span>' +
      '<button type="button" id="plasiyerCikis" ' +
              'class="px-4 py-2 rounded-xl border-2 border-slate-200 dark:border-slate-600 ' +
                     'font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">Çıkış Yap</button>';

    var cikis = el('plasiyerCikis');
    if (cikis) cikis.addEventListener('click', cikisYap);
  }

  /* ------------------------------------------------------------------ *
   *  KAPI
   * ------------------------------------------------------------------ */

  function kapiyiGoster() {
    if (!kapi) return;

    var firma = el('kapiFirma');

    if (firma) {
      var ad = '';

      try {
        ad = (durum.lisans && durum.lisans.firmaAdi) || '';
      } catch (e) { ad = ''; }

      firma.textContent = ad || 'Devam etmek için giriş tipini seçin';
    }

    kapi.hidden = false;
    kapi.classList.remove('kapali');
  }

  /** Kapıyı yumuşak geçişle kapatır (transform + opacity, layout yok). */
  function kapiyiKapat() {
    if (!kapi) return;

    kapi.classList.add('kapali');

    /* Geçiş bitince DOM'dan çıkar: arkadaki panel tam erişilebilir olsun. */
    window.setTimeout(function () {
      if (kapi) kapi.hidden = true;
    }, 220);
  }

  function yoneticiSec() {
    oturumKur('admin', {});
    kisitlamayiUygula();
    kapiyiKapat();
  }

  /* ------------------------------------------------------------------ *
   *  PIN AKIŞI
   * ------------------------------------------------------------------ */

  async function plasiyerleriYukle() {
    var secim = el('pinPlasiyer');

    if (!secim) return;

    secim.innerHTML = '<option value="">Yükleniyor…</option>';

    var cevap = await b2b('/admin/plasiyerler');

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
      secim.innerHTML = '<option value="">Liste alınamadı</option>';
      hataYaz(el('pinHata'), (cevap && cevap.hata) || 'Pazarlamacı listesi alınamadı.');
      return;
    }

    plasiyerListesi = (cevap.veri.plasiyerler || []).filter(function (p) { return p && p.pinTanimli; });

    if (!plasiyerListesi.length) {
      secim.innerHTML = '<option value="">PIN tanımlı pazarlamacı yok</option>';
      hataYaz(el('pinHata'), 'Henüz PIN tanımlı bir pazarlamacı yok. Yönetici girişinden "Pazarlamacılar" sekmesinde tanımlayın.');
      return;
    }

    secim.innerHTML = plasiyerListesi.map(function (p) {
      var etiket = p.ad + (p.bolge ? ' — ' + p.bolge : '');
      return '<option value="' + Number(p.id) + '">' + kacis(etiket) + '</option>';
    }).join('');

    /* Son giren pazarlamacı hatırlanır (sır değil, yalnızca kolaylık). */
    var son = (durum.ayarlar && durum.ayarlar.plasiyerSonOturum) || null;

    if (son && son.id) secim.value = String(son.id);
  }

  function pinPerdesiniAc() {
    if (!baglantiVar()) {
      hataYaz(el('kapiUyari'), 'Pazarlamacı girişi için önce site bağlantısı kurulmalı. Yönetici girişinden API & Sistem Ayarları\'nı doldurun.');
      return;
    }

    gorunur(pinPerde, true);
    hataYaz(el('pinHata'), '');

    var kod = el('pinKod');
    if (kod) kod.value = '';

    plasiyerleriYukle().then(function () {
      if (kod) kod.focus();
    });
  }

  function pinPerdesiniKapat() {
    gorunur(pinPerde, false);

    var kod = el('pinKod');
    if (kod) kod.value = '';   // PIN ekranda bile bırakılmaz
  }

  async function pinGirisDene() {
    var secim = el('pinPlasiyer');
    var kod = el('pinKod');
    var dugme = el('pinGiris');

    var id = Number(secim && secim.value) || 0;
    var pin = String((kod && kod.value) || '');

    if (!id) return hataYaz(el('pinHata'), 'Pazarlamacı seçin.');
    if (!pin) return hataYaz(el('pinHata'), 'PIN girin.');

    hataYaz(el('pinHata'), '');
    if (dugme) dugme.disabled = true;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('plasiyer:auth', { id: id, pin: pin });
    } finally {
      /* PIN hem değişkenden hem ekrandan SİLİNİR. */
      pin = '';
      if (kod) kod.value = '';
      if (dugme) dugme.disabled = false;
    }

    if (!cevap || !cevap.ok) {
      hataYaz(el('pinHata'), (cevap && cevap.hata) || 'Giriş başarısız.');
      if (kod) kod.focus();
      return;
    }

    oturumKur('plasiyer', cevap);

    /* Sır olmayan kısmı kaydet: bir dahaki açılışta seçili gelsin. */
    try {
      await ipcRenderer.invoke('plasiyer:save-session', {
        id: cevap.id,
        ad: cevap.ad,
        bolge: cevap.bolge
      });
    } catch (e) { /* kolaylık özelliği; başarısızlığı akışı durdurmaz */ }

    pinPerdesiniKapat();
    kisitlamayiUygula();
    kapiyiKapat();

    bildir('Hoş geldiniz ' + cevap.ad + (cevap.bolge ? ' — ' + cevap.bolge + ' Bölgesi' : ''), 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  ÇIKIŞ
   * ------------------------------------------------------------------ */

  async function cikisYap() {
    try {
      await ipcRenderer.invoke('plasiyer:logout');
    } catch (e) { /* sunucuya ulaşılamasa da yerel oturum düşer */ }

    durum.oturum = null;

    kisitlamayiUygula();
    kapiyiGoster();
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function olaylariBagla() {
    var yon = el('kapiYonetici');
    var pla = el('kapiPlasiyer');

    if (yon) yon.addEventListener('click', yoneticiSec);
    if (pla) pla.addEventListener('click', pinPerdesiniAc);

    var kapat = el('pinKapat');
    if (kapat) kapat.addEventListener('click', pinPerdesiniKapat);

    var giris = el('pinGiris');
    if (giris) giris.addEventListener('click', pinGirisDene);

    var kod = el('pinKod');

    if (kod) {
      kod.addEventListener('keydown', function (olay) {
        if ('Enter' === olay.key) pinGirisDene();
      });

      /* Yalnızca rakam kabul: yapıştırma da süzülür. */
      kod.addEventListener('input', function () {
        var temiz = kod.value.replace(/[^0-9]/g, '').slice(0, 6);
        if (temiz !== kod.value) kod.value = temiz;
      });
    }

    /* Esc tuşu PIN perdesini kapatır, kapıyı kapatmaz. */
    document.addEventListener('keydown', function (olay) {
      if ('Escape' === olay.key && pinPerde && !pinPerde.hidden) pinPerdesiniKapat();
    });
  }

  /**
   * Tek kez kurulum.
   *
   * ÇİFT BAĞLANMA KORUMASI (kök CLAUDE.md §6): `baslat` iki yoldan
   * çağrılabiliyor — DOMContentLoaded ve (belge hazırsa) doğrudan. Bayrak
   * olmasa olay dinleyicileri iki kez bağlanır ve tek tıklama PIN denemesini
   * İKİ KEZ gönderirdi; kaba kuvvet sayacı boşuna ilerlerdi.
   */
  var kuruldu = false;

  function baslat() {
    if (kuruldu) return;

    kapi = el('girisKapisi');
    pinPerde = el('pinPerde');

    if (!kapi) return;   // işaretleme yoksa sessizce devre dışı

    kuruldu = true;

    olaylariBagla();

    /*
     * SIFIR KURULUM: bağlantı yoksa pazarlamacı girişi çalışamaz. Kapıyı
     * göstermek yerine doğrudan yönetici akışına geçilir — kullanıcı
     * kurulum ekranıyla karşılaşmaya devam eder.
     */
    if (!baglantiVar()) {
      oturumKur('admin', {});
      kapi.hidden = true;
      return;
    }

    kapiyiGoster();
  }

  /* renderer.js DOMContentLoaded'da boot ediyor; biz de aynı anı bekliyoruz. */
  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', baslat);
  } else {
    baslat();
  }

  /* Yönetim modülünün ve testlerin kullandığı küçük yüz. */
  window.PlasiyerKapi = {
    oturumKur: oturumKur,
    plasiyerMi: plasiyerMi,
    kisitlamayiUygula: kisitlamayiUygula,
    cikisYap: cikisYap,
    kapiyiGoster: kapiyiGoster,
    PLASIYER_SEKMELERI: PLASIYER_SEKMELERI,
    KISITLI_SEKMELER: KISITLI_SEKMELER
  };
})();
