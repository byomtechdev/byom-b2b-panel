/* ============================================================================
 *  YÖNETİCİ MASTER PIN DEĞİŞTİRME — AYARLAR SEKMESİ KARTI
 *  src/renderer/modules/yonetici-pin.js
 *  ---------------------------------------------------------------------------
 *  "API & Sistem Ayarları ▸ 🔑 Yönetici Master PIN" kartının mantığı.
 *
 *  NEDEN AYRI MODÜL: `renderer.js` 330 KB ve ayarlar sekmesi orada çiziliyor.
 *  Yeni özelliği oraya yazmak dosyayı daha da şişirirdi; bu depoda kalıp,
 *  yeni özellik modüllerini `src/renderer/modules/` altına koymaktır
 *  (bkz. panel CLAUDE.md §1.2).
 *
 *  ┌────────────────────────────────────────────────────────────────────────┐
 *  │ DOĞRULAMA BURADA YAPILMAZ.                                             │
 *  │ `nodeIntegration: true` olduğu için renderer'da yazılan her            │
 *  │ karşılaştırma aynı konsoldan atlatılabilir. Eski ve yeni PIN           │
 *  │ `auth:yonetici-pin-degistir` kanalıyla ana sürece gider; buradaki iş   │
 *  │ yalnızca alanları toplamak ve sonucu göstermek.                        │
 *  │                                                                        │
 *  │ PIN HİÇBİR YERDE SAKLANMAZ: okunur, IPC'ye verilir, alanlar anında     │
 *  │ temizlenir. (Aynı söz renderer-plasiyer.js'te de geçerli.)             │
 *  └────────────────────────────────────────────────────────────────────────┘
 *
 *  Yükleme: `<script src>` ile, renderer.js'ten SONRA (durum, bildir, $ ve
 *  ipcRenderer kısayollarını kullanır).
 * ==========================================================================*/

'use strict';

(function () {

  /** Master PIN hane sayısı — ana süreçteki `PIN_UZUNLUK` ile aynı olmalı. */
  var PIN_UZUNLUK = 6;

  var bagli = false;

  function el(id) {
    return document.getElementById(id);
  }

  /** Yalnızca rakam, en çok 6 hane. Yapıştırma da süzülür. */
  function rakamSuz(kutu) {
    var temiz = kutu.value.replace(/[^0-9]/g, '').slice(0, PIN_UZUNLUK);
    if (temiz !== kutu.value) kutu.value = temiz;
  }

  function hataYaz(mesaj, iyiMi) {
    var p = el('ypinAyarHata');

    if (!p) return;

    p.textContent = String(mesaj || '');
    p.classList.toggle('hidden', !mesaj);
    p.classList.toggle('text-red-600', !iyiMi);
    p.classList.toggle('dark:text-red-400', !iyiMi);
    p.classList.toggle('text-emerald-700', !!iyiMi);
    p.classList.toggle('dark:text-emerald-400', !!iyiMi);
  }

  /** PIN alanlarını temizler — sır ekranda bırakılmaz. */
  function alanlariTemizle() {
    ['ypinMevcut', 'ypinYeni', 'ypinYeni2'].forEach(function (id) {
      var kutu = el(id);
      if (kutu) kutu.value = '';
    });
  }

  /**
   * Rozeti ve kurtarma kutusunu mevcut duruma göre çizer.
   *
   * PIN kurulu DEĞİLSE değiştirme anlamsızdır: kart "henüz belirlenmedi" der ve
   * düğme kapanır. PIN ilk kez giriş kapısında kurulur (oradaki modal), bu
   * yüzden burada ikinci bir kurulum akışı YOK — aynı işi iki yerde yapmak,
   * "PIN zaten tanımlı" hatasını kullanıcıya gösteren bir yol açardı.
   */
  function durumuCiz() {
    var ayarlar = (typeof durum !== 'undefined' && durum.ayarlar) || {};
    var kurulu = !!ayarlar.yoneticiPinKurulu;

    var rozet = el('ypinDurumRozeti');

    if (rozet) {
      rozet.textContent = kurulu ? 'Tanımlı' : 'Henüz belirlenmedi';
      rozet.className = 'ml-auto text-sm font-extrabold px-3 py-1 rounded-lg ' + (kurulu
        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300');
    }

    var dugme = el('ypinDegistirBtn');

    if (dugme) dugme.disabled = !kurulu;

    var mevcut = el('ypinMevcut');

    if (mevcut) mevcut.disabled = !kurulu;

    /* Kurtarma kutusu: `pinSenkron` açıkça false DEĞİLSE açık sayılır —
       varsayılan kurtarılabilir olmaktır (şartname bunu istiyor). */
    var kutu = el('ypinSenkronKutu');

    if (kutu) kutu.checked = (false !== ayarlar.pinSenkron);

    if (!kurulu) {
      hataYaz('PIN henüz belirlenmedi. Giriş ekranındaki "Yönetici Girişi" ' +
              'kapısından ilk PIN\'i oluşturun.', false);
    }
  }

  /** Kurtarma tercihi — ayarlara yazılır, ana süreç onu okur. */
  async function senkronTercihiniYaz() {
    var kutu = el('ypinSenkronKutu');

    if (!kutu) return;

    try {
      var yeni = await ipcRenderer.invoke('ayar:yaz', { pinSenkron: !!kutu.checked });

      if (typeof durum !== 'undefined' && yeni) durum.ayarlar = yeni;

      if (typeof bildir === 'function') {
        bildir(kutu.checked
          ? 'PIN kurtarma açık: PIN bir daha kurulduğunda/değiştiğinde merkeze iletilecek.'
          : 'PIN kurtarma kapalı: PIN yalnızca bu bilgisayarda kalacak.', 'ok');
      }
    } catch (e) {
      /* Tercih yazılamadıysa kutuyu gerçek duruma geri al: kullanıcı
         kapattığını sanmasın. */
      durumuCiz();
    }
  }

  /**
   * PIN değiştirme.
   *
   * SIRA: biçim → eşitlik → ana süreç. İlk iki adım YEREL ve ucuz; ana sürece
   * gitmeden eleyebildiğimiz hatayı göndermiyoruz (kaba kuvvet sayacı boşuna
   * ilerlemesin — `pinDegistir` yanlış "mevcut PIN"i sayaçla cezalandırmıyor
   * ama yine de gürültü üretmemek doğru).
   */
  async function degistir() {
    var mevcut = el('ypinMevcut');
    var yeni = el('ypinYeni');
    var yeni2 = el('ypinYeni2');
    var dugme = el('ypinDegistirBtn');

    var a = String((mevcut && mevcut.value) || '');
    var b = String((yeni && yeni.value) || '');
    var c = String((yeni2 && yeni2.value) || '');

    if (a.length !== PIN_UZUNLUK) return hataYaz('Mevcut PIN ' + PIN_UZUNLUK + ' haneli olmalı.', false);
    if (b.length !== PIN_UZUNLUK) return hataYaz('Yeni PIN ' + PIN_UZUNLUK + ' haneli olmalı.', false);
    if (b !== c) return hataYaz('İki yeni PIN aynı değil.', false);
    if (a === b) return hataYaz('Yeni PIN mevcut PIN ile aynı olamaz.', false);

    hataYaz('', false);
    if (dugme) dugme.disabled = true;

    var cevap = null;

    try {
      cevap = await ipcRenderer.invoke('auth:yonetici-pin-degistir', { eski: a, yeni: b });
    } catch (e) {
      cevap = null;
    }

    /* Sır yerel değişkenlerde bırakılmaz. */
    a = ''; b = ''; c = '';
    alanlariTemizle();

    if (dugme) dugme.disabled = false;

    if (!cevap) return hataYaz('Doğrulama yapılamadı. Uygulamayı yeniden başlatın.', false);

    if (!cevap.ok) {
      return hataYaz(cevap.hata || 'PIN değiştirilemedi.', false);
    }

    /* Ana sürecin döndürdüğü taze durumu ayarlara yansıt. */
    if (typeof durum !== 'undefined' && durum.ayarlar && cevap.durum) {
      durum.ayarlar.yoneticiPinKurulu = !!cevap.durum.pinKurulu;
    }

    durumuCiz();
    hataYaz('PIN değiştirildi.', true);

    if (typeof bildir === 'function') bildir('Yönetici Master PIN değiştirildi.', 'basari');
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function olaylariBagla() {
    if (bagli) return;   // sekme her açılışta çağrılır; çift bağlanma YOK
    bagli = true;

    ['ypinMevcut', 'ypinYeni', 'ypinYeni2'].forEach(function (id) {
      var kutu = el(id);

      if (!kutu) return;

      kutu.addEventListener('input', function () { rakamSuz(kutu); });
      kutu.addEventListener('keydown', function (olay) {
        if ('Enter' === olay.key) degistir();
      });
    });

    var dugme = el('ypinDegistirBtn');
    if (dugme) dugme.addEventListener('click', degistir);

    var kutu = el('ypinSenkronKutu');
    if (kutu) kutu.addEventListener('change', senkronTercihiniYaz);
  }

  /** Ayarlar sekmesi açıldığında kartı tazeler — `sekmeAc`'ı SARAR. */
  function akisaBaglan() {
    if ('function' !== typeof window.sekmeAc) return;

    var ozgun = window.sekmeAc;

    window.sekmeAc = function (ad) {
      var sonuc = ozgun.apply(this, arguments);

      if ('ayarlar' === ad) {
        olaylariBagla();
        durumuCiz();
      }

      return sonuc;
    };
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', akisaBaglan);
  } else {
    akisaBaglan();
  }

  window.YoneticiPin = {
    durumuCiz: durumuCiz,
    degistir: degistir,
    olaylariBagla: olaylariBagla,
    senkronTercihiniYaz: senkronTercihiniYaz,
    PIN_UZUNLUK: PIN_UZUNLUK
  };
})();
