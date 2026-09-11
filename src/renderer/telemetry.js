/* ============================================================================
 *  BYOM — TELEMETRİ (SESSİZ HATA AVCISI) · ARAYÜZ
 *  src/renderer/telemetry.js
 *  ---------------------------------------------------------------------------
 *  Arayüzde (renderer) oluşan yakalanmamış hataları ve karşılanmamış promise
 *  reddini toplar, ana sürece tek yönlü IPC ile geçirir; ana süreç hub'a
 *  yazar (bkz. src/main/byom-telemetri.js).
 *
 *  NEDEN EN ÖNCE YÜKLENİR?
 *  index.html'in <head> bölümünde, tailwind'den ve renderer*.js'ten ÖNCE
 *  gelir. Sonraki betiklerin yükleme/çalışma hatalarını da yakalayabilmesi
 *  için dinleyicilerin ilk sırada kurulması gerekir. Bu dosyanın hiçbir
 *  başka betiğe bağımlılığı YOKTUR (durum, $, bildir… hiçbirini kullanmaz).
 *
 *  ARAYÜZ AKIŞINI KESMEME GARANTİLERİ:
 *   · `addEventListener` kullanılır, `window.onerror = …` ATAMASI YAPILMAZ.
 *     Atama yapılsaydı başka bir betiğin kurduğu onerror sessizce ezilirdi;
 *     dinleyici ise eklenir, var olanı bozmaz.
 *   · `preventDefault()` ÇAĞRILMAZ: hata normalde olduğu gibi DevTools
 *     konsoluna da basılır. Telemetri gözlemci, filtre değil.
 *   · Gönderim `ipcRenderer.send` ile tek yönlü ve senkron-beklemesizdir.
 *     IPC yoksa (tarayıcı/jsdom) 3 sn'lik `fetch` yedeği denenir; o da
 *     olmazsa hata sessizce yutulur. Hiçbir dalda `await` edilmez.
 *   · Tüm gövde try/catch içindedir: telemetrinin kendi hatası paneli
 *     etkilemez.
 *
 *  GİZLİLİK: Burada lisans anahtarı/HWID TOPLANMAZ. Künye alanlarını ana
 *  süreç kendi belleğinden ekler (maskeli), böylece anahtar arayüz katmanında
 *  hiç dolaşmaz.
 * ==========================================================================*/

(function (kok) {
  'use strict';

  /** Ana süreçteki dinleyiciyle aynı kanal adı (byom-telemetri.js → kur). */
  var KANAL = 'byom:telemetri';

  /** IPC yoksa kullanılacak yedek uç ve süre aşımı. */
  var YEDEK_UC = '/api/telemetry';
  var SURE_ASIMI_MS = 3000;

  /** Aynı hata bu süre içinde tekrar gönderilmez (sonsuz döngüye giren hata). */
  var AYNI_HATA_SUSMA_MS = 60 * 1000;

  /** Tek alanın en çok kaç karakteri gider. */
  var EN_UZUN_METIN = 4000;

  var kuruldu = false;
  var sonGorulen = Object.create(null);

  /* ------------------------------------------------------------------ *
   *  Yardımcılar
   * ------------------------------------------------------------------ */

  function kisalt(ham) {
    var m = String(ham === null || ham === undefined ? '' : ham);
    return m.length > EN_UZUN_METIN ? m.slice(0, EN_UZUN_METIN) + ' …(kısaltıldı)' : m;
  }

  /** Uzun file:// yolundan yalnızca dosya adını bırakır. */
  function dosyaAdi(ham) {
    var y = String(ham || '').replace(/^file:[/]*/i, '').split('?')[0];
    var parcalar = y.split(/[\\/]/);
    return parcalar[parcalar.length - 1] || '';
  }

  /** Reddedilen promise'in sebebini mesaj + yığına çevirir. */
  function sebebiCoz(sebep) {
    if (sebep && typeof sebep === 'object' && sebep.stack) {
      return { mesaj: kisalt(sebep.message || String(sebep)), yigin: kisalt(sebep.stack) };
    }

    if (sebep && typeof sebep === 'object') {
      var metin;
      try { metin = JSON.stringify(sebep); } catch (e) { metin = String(sebep); }
      return { mesaj: kisalt(metin), yigin: '' };
    }

    return { mesaj: kisalt(sebep), yigin: '' };
  }

  /** Hangi sekmede olduğumuz — destek için en kıymetli tek alan. */
  function aktifSekme() {
    try {
      if (kok.durum && kok.durum.aktifSekme) return String(kok.durum.aktifSekme);
    } catch (e) { /* durum henüz yok */ }
    return '';
  }

  /** Aynı hatanın seli engellenir. */
  function cokSikMi(yuk) {
    var iz = [yuk.tip, yuk.dosya, yuk.satir, String(yuk.mesaj || '').slice(0, 160)].join('|');
    var simdi = Date.now();

    if (sonGorulen[iz] && (simdi - sonGorulen[iz]) < AYNI_HATA_SUSMA_MS) return true;

    sonGorulen[iz] = simdi;
    return false;
  }

  /* ------------------------------------------------------------------ *
   *  Taşıma — 1) IPC (tercih)  2) fetch yedeği  3) sessizlik
   * ------------------------------------------------------------------ */

  /** Electron IPC kanalı; yoksa null. Her çağrıda denenir (betik sırası fark etmez). */
  function ipc() {
    try {
      if (typeof kok.require !== 'function') return null;
      var elektron = kok.require('electron');
      return (elektron && elektron.ipcRenderer) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Yedek yol — NORMALDE ÇALIŞMAZ, bilinçli olarak atıldır.
   *
   * Electron'da IPC daima vardır; bu dal yalnızca IPC'nin bulunmadığı bir
   * ortamda (tarayıcı, jsdom, ileride contextIsolation'a geçilir ve preload
   * ipcRenderer'ı açmazsa) devreye girer. O durumda hub adresini öğrenmenin
   * tek yolu kalmaz: adres GÖMÜLMEZ ("0 KM" kuralı), bu yüzden yalnızca biri
   * `durum.telemetriTabani`'yi elle doldurmuşsa gönderim yapılır — aksi
   * hâlde sessizce vazgeçilir. Yani bu bir kaçış kapısıdır, birincil yol değil.
   *
   * `keepalive` sayesinde pencere kapanırken de gidebilir; başarısızlık sessiz.
   */
  function fetchYedegi(yuk) {
    try {
      if (typeof kok.fetch !== 'function') return;

      var taban = String((kok.durum && kok.durum.telemetriTabani) || '').replace(/\/+$/, '');
      if (!taban) return; // Gömülü adres yok: taban bilinmiyorsa gönderilmez.

      var secenek = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(yuk),
        keepalive: true
      };

      if (typeof kok.AbortController === 'function') {
        var iptal = new kok.AbortController();
        secenek.signal = iptal.signal;
        kok.setTimeout(function () {
          try { iptal.abort(); } catch (e) { /* yok sayılır */ }
        }, SURE_ASIMI_MS);
      }

      /* Dönen promise BİLİNÇLİ olarak beklenmez; yalnız reddi yutulur. */
      var istek = kok.fetch(taban + YEDEK_UC, secenek);
      if (istek && typeof istek.catch === 'function') istek.catch(function () { /* sessiz */ });
    } catch (e) {
      /* sessiz */
    }
  }

  /**
   * Hata yükünü yollar. Hiçbir koşulda throw etmez, hiçbir koşulda beklemez.
   * Dışarıya da açıktır: yakaladığı hatayı gömmek istemeyen bir arayüz
   * fonksiyonu `Telemetri.bildir({ tip: 'elle', mesaj: … })` diyebilir.
   */
  function bildir(ham) {
    try {
      ham = ham || {};

      var yuk = {
        kaynak: 'panel-renderer',
        tip: String(ham.tip || 'arayuz'),
        mesaj: kisalt(ham.mesaj),
        dosya: dosyaAdi(ham.dosya),
        satir: ham.satir === undefined || ham.satir === null ? null : Number(ham.satir),
        kolon: ham.kolon === undefined || ham.kolon === null ? null : Number(ham.kolon),
        yigin: kisalt(ham.yigin),
        sekme: ham.sekme === undefined ? aktifSekme() : String(ham.sekme),
        adres: dosyaAdi((kok.location && kok.location.pathname) || ''),
        zaman: new Date().toISOString()
      };

      if (cokSikMi(yuk)) return;

      var kanal = ipc();

      if (kanal && typeof kanal.send === 'function') {
        kanal.send(KANAL, yuk);   // Tek yönlü: cevap beklenmez, arayüz durmaz.
        return;
      }

      fetchYedegi(yuk);
    } catch (e) {
      /* Telemetri hiçbir şeyi bozmaz. */
    }
  }

  /* ------------------------------------------------------------------ *
   *  Küresel kancalar
   * ------------------------------------------------------------------ */

  /**
   * `window.onerror` ve `window.onunhandledrejection` karşılıkları.
   *
   * Atama yerine dinleyici eklenir (bkz. dosya başlığı). Üçüncü argüman
   * `true` DEĞİLDİR: yakalama (capture) evresine girilmez, olay normal akışını
   * sürdürür ve konsola da basılır.
   */
  function kur() {
    if (kuruldu) return;
    if (!kok || typeof kok.addEventListener !== 'function') return;

    kuruldu = true;

    /* 1) Senkron hatalar + betik yükleme hataları (window.onerror karşılığı). */
    kok.addEventListener('error', function (olay) {
      try {
        /* Görsel/betik yükleme hatası: olay hedefte taşınır, `message` yoktur. */
        if (olay && !olay.message && olay.target && olay.target !== kok) {
          var hedef = olay.target;
          var kaynakAdres = hedef.src || hedef.href || '';
          if (!kaynakAdres) return;

          bildir({
            tip: 'kaynak-yuklenemedi',
            mesaj: (hedef.tagName || 'KAYNAK') + ' yüklenemedi: ' + dosyaAdi(kaynakAdres),
            dosya: kaynakAdres
          });
          return;
        }

        bildir({
          tip: 'window.onerror',
          mesaj: (olay && olay.message) || 'bilinmeyen hata',
          dosya: olay && olay.filename,
          satir: olay && olay.lineno,
          kolon: olay && olay.colno,
          yigin: olay && olay.error && olay.error.stack
        });
      } catch (e) {
        /* sessiz */
      }
    });

    /* 2) Karşılanmamış promise reddi (window.onunhandledrejection karşılığı). */
    kok.addEventListener('unhandledrejection', function (olay) {
      try {
        var coz = sebebiCoz(olay && olay.reason);

        bildir({
          tip: 'unhandledrejection',
          mesaj: coz.mesaj || 'karşılanmamış promise reddi',
          yigin: coz.yigin
        });
      } catch (e) {
        /* sessiz */
      }
    });
  }

  var Telemetri = { kur: kur, bildir: bildir, KANAL: KANAL };

  /* Dual mod: betik olarak yüklenince window'a yazar ve kendini kurar;
     node:test altında require edilince yalnızca dışa verir (sira-motor.js /
     vitrin-motor.js ile aynı kalıp). */
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Telemetri;
  }

  if (typeof window !== 'undefined') {
    window.Telemetri = Telemetri;
    kur();
  }
})(typeof window !== 'undefined' ? window : this);
