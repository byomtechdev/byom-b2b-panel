/* ============================================================================
 *  B2B YÖNETİM PANELİ  —  Electron Ana Süreç (main.js)
 *  ---------------------------------------------------------------------------
 *  Görevleri:
 *   1) Ana pencereyi açar.
 *   2) Ayarları  <userData>/ayarlar.json  dosyasında saklar (API anahtarları vb.).
 *   3) REST API isteklerini BURADAN atar. İki alan (namespace) desteklenir:
 *        · wc/v3       → WooCommerce çekirdek uçları (ürün/stok/kategori/müşteri)
 *        · wc-b2b/v1   → b2b-core eklentisinin B2B uçları (bayi, sipariş, medya)
 *      Her ikisi de AYNI Consumer Key / Secret ile çalışır.
 *      (İstekler neden burada? WooCommerce sunucusu CORS başlığı göndermez;
 *       arayüzden doğrudan fetch atılırsa tarayıcı motoru engeller. Node'da CORS yok.)
 *   4) Depo fişi önizleme penceresini açar, yazdırır ve PDF olarak kaydeder.
 *   4.5) Ürün kataloğunu Excel'e döker ve Excel/CSV dosyalarını okur (bölüm 3.4).
 *   5) SSL sertifika doğrulamasını gevşetir (bölüm 0) — müşteri sitelerindeki
 *      eksik/süresi geçmiş sertifikalar yüzünden bağlantı kopmasın diye.
 *   6) Uygulamayı otomatik günceller (bölüm 3.5, electron-updater — GitHub
 *      Releases yayın akışı). Yalnızca paketlenmiş (kurulmuş) sürümde çalışır.
 * ==========================================================================*/

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

/* BYOM Brain entegrasyonu: lisans doğrulama/aktivasyon motoru ve destek masası.
   Ana pencere ANCAK lisans doğrulandıktan sonra açılır (bkz. app.whenReady). */
const byom = require('./src/main/byom');

/* Excel motoru: ürün dökümünü .xlsx olarak yazar, .xlsx/.xls/.csv okur.
   Harici bağımlılık YOK — ayrıntı için src/main/byom-excel.js başlığı. */
const excel = require('./src/main/byom-excel');

/* Telemetri (sessiz hata avcısı): yakalanmamış hataları arka planda hub'a
   yazar. Akışı ASLA beklemez, hata durumunda ASLA throw etmez; ağ yoksa
   kayıt diske kuyruklanır ve sonraki açılışta gönderilir.
   Ayrıntı ve gizlilik sınırları: src/main/byom-telemetri.js başlığı. */
const telemetri = require('./src/main/byom-telemetri');

/* Yönetici Master PIN ve cihaz (saha terminali) kilidi — bkz. bölüm 3.9.
   DOM'suz ve Electron'suz saf motor: hash'leme, kaba kuvvet sayacı ve cihaz
   rolü geçişleri orada; diske yazma kararı BURADA. Doğrulamanın arayüzde
   değil ana süreçte olmasının sebebi `nodeIntegration: true` — renderer'da
   yazılan her kontrol aynı konsoldan atlatılabilir. */
const yoneticiKilit = require('./src/main/byom-yonetici-kilit');

/* Arayüzden gelen hata kanalını bağlar ve önceki oturumdan kalan kuyruğu
   boşaltır. `kunye`, kaydın HANGİ firmaya/sürüme ait olduğunu söyler
   (lisans anahtarı maskelenerek gider). */
telemetri.kur({ kunye: byom.lisansOzeti });

let anaPencere = null;

/* ==========================================================================
 *  0.5) PLATFORM AYRIMI  (macOS uyumluluk katmanı)
 *  ---------------------------------------------------------------------------
 *  ANA GELİŞTİRME ORTAMI WINDOWS'TUR. Aşağıdaki her şey KOŞULLU çalışır:
 *  `isMac` false olduğunda yardımcılar boş nesne döndürür ya da hiç
 *  çağrılmaz; Windows'taki pencere seçenekleri, menü davranışı ve kısayollar
 *  birebir eskisi gibi kalır.
 *
 *  Dosya yolları zaten `path.join` ile kuruluyor (ayar dosyası, geçici fiş,
 *  index.html, lisans ekranı, Excel kaydetme). `path.join` ayracı işletim
 *  sistemine göre kendisi seçer; Windows'ta "\", macOS'te "/" üretir. Bu
 *  yüzden yol tarafında değiştirilecek bir şey YOKTUR.
 * ========================================================================*/

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/**
 * Ana pencereye YALNIZCA macOS'te eklenecek seçenekler.
 *
 * Windows'ta boş nesne döner; `Object.assign` sonucu mevcut seçenek
 * listesiyle birebir aynı kalır.
 *
 * `hiddenInset`: macOS'te sistem başlık çubuğu kaldırılır, kapat/küçült/
 * büyüt düğmeleri (trafik lambaları) uygulamanın kendi başlık şeridinin
 * üzerine biner. Bu, macOS'te beklenen görünümdür. Üstteki şeritte onlara
 * yer açan boşluk ve pencereyi taşıma bölgesi index.html'deki `html.mac`
 * kurallarındadır (Windows'ta o sınıf hiç eklenmez).
 */
function macAnaPencereSecenekleri() {
  if (!isMac) return {};

  return {
    titleBarStyle: 'hiddenInset',
    /* Şerit yüksekliği 52px'tir (Tailwind'in h-20'si kurumsal temada
       `header.h-20 { height: 52px !important }` ile eziliyor). Düğmeler
       (12px) o şeride göre ortalanır. Not: bu konum ekran noktası
       cinsindendir ve arayüz ölçeğinden etkilenmez; %70–%120 aralığının
       tamamında şeridin içinde kalacak şekilde biraz yukarı alındı. */
    trafficLightPosition: { x: 18, y: 18 }
  };
}

/**
 * macOS menü çubuğu.
 *
 * NEDEN GEREKLİ: Windows'ta `Menu.setApplicationMenu(null)` sade bir görünüm
 * verir ve hiçbir şey kaybolmaz. macOS'te ise KOPYALA / YAPIŞTIR / KES /
 * TÜMÜNÜ SEÇ ve ÇIK kısayolları menüden gelir; menü kaldırılırsa ⌘C ve ⌘V
 * uygulamanın hiçbir yerinde çalışmaz. Bu yüzden macOS'e en küçük standart
 * menü kurulur.
 *
 * Görünüm/Yenile menüsü BİLEREK yok: ⌘R gibi kısayollar menüye konsaydı
 * menü hızlandırıcısı arayüzdeki kendi yenileme kısayolunu ezerdi.
 */
function macMenusunuKur() {
  const ad = app.name || 'BYOM B2B Panel';

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: ad,
      submenu: [
        { role: 'about', label: ad + ' Hakkında' },
        { type: 'separator' },
        { role: 'hide', label: ad + ' Uygulamasını Gizle' },
        { role: 'hideOthers', label: 'Diğerlerini Gizle' },
        { role: 'unhide', label: 'Tümünü Göster' },
        { type: 'separator' },
        { role: 'quit', label: 'Çık' }
      ]
    },
    {
      label: 'Düzen',
      submenu: [
        { role: 'undo', label: 'Geri Al' },
        { role: 'redo', label: 'Yinele' },
        { type: 'separator' },
        { role: 'cut', label: 'Kes' },
        { role: 'copy', label: 'Kopyala' },
        { role: 'paste', label: 'Yapıştır' },
        { role: 'selectAll', label: 'Tümünü Seç' }
      ]
    },
    {
      label: 'Pencere',
      submenu: [
        { role: 'minimize', label: 'Simge Durumuna Küçült' },
        { role: 'zoom', label: 'Yakınlaştır' },
        { type: 'separator' },
        { role: 'close', label: 'Pencereyi Kapat' }
      ]
    }
  ]));
}

/* ==========================================================================
 *  0) SSL / SERTİFİKA ESNEKLİĞİ
 *  ---------------------------------------------------------------------------
 *  Müşterilerin siteleri çoğu zaman ucuz/otomatik (Let's Encrypt, cPanel AutoSSL)
 *  sertifikalar kullanıyor; ara sertifika zinciri eksik kuruluyor, sertifika
 *  süresi geçiyor ya da adres www'lu/www'suz uyuşmuyor. Bu durumlarda tarayıcı
 *  "Sitenin güvenlik sertifikası (SSL) doğrulanamadı" diyerek isteği kesiyor ve
 *  panel kendi mağazasına bağlanamıyordu.
 *
 *  Bu yüzden sertifika doğrulaması hem Node (fetch/TLS) hem de Chromium (ağ
 *  yığını) tarafında gevşetiliyor. Trafik yine HTTPS ile şifreli gider; yalnızca
 *  "sertifikayı kim imzalamış" denetimi yapılmaz.
 *
 *  GÜVENLİK NOTU: Bu, ortadaki adam (MITM) saldırısına karşı korumayı kaldırır.
 *  Uygulama yalnızca kullanıcının kendi mağazasına, kendi girdiği adrese bağlandığı
 *  için kabul edilmiş bir ödünleşmedir.
 * ========================================================================*/

// --- Node tarafı (main süreçteki fetch / TLS) ---
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Node yukarıdaki ayar yüzünden açılışta uyarı basar; konsolu kirletmesin.
const _asilUyariYaz = process.emitWarning.bind(process);
process.emitWarning = function (uyari) {
  const metin = typeof uyari === 'string' ? uyari : (uyari && uyari.message) || '';
  if (metin.indexOf('NODE_TLS_REJECT_UNAUTHORIZED') !== -1) return;
  return _asilUyariYaz.apply(null, arguments);
};

/**
 * Gelistirme gunlugu.
 *
 * Uretimde (paketlenmis surumde) SESSIZDIR. Bu satirlar kullaniciya hicbir
 * sey anlatmaz; yalnizca gelistirme sirasinda akisi izlemeye yarar. Hata ve
 * uyarilar bu suzgecten GECMEZ - onlar console.error / console.warn ile
 * dogrudan yazilir, cunku destek isteyen kullanicidan gunluk istenebilir.
 *
 * @param {...*} parcalar Yazilacaklar.
 */
function gunluk() {
  if (app.isPackaged) return;
  console.log.apply(console, arguments);
}

// --- Chromium tarafı (pencereler, görseller, net.fetch) ---
// Bu anahtarlar app hazır olmadan ÖNCE eklenmek zorunda; dosyanın en başında.
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');

// Anahtar bir sebeple işlemezse ikinci emniyet: sertifika hatasını elle onayla.
app.on('certificate-error', function (olay, icerik, url, hata, sertifika, geriCagir) {
  console.warn('Sertifika hatası yok sayıldı:', hata, '→', url);
  olay.preventDefault();
  geriCagir(true); // true = sertifikaya güven
});

/** Üçüncü emniyet: oturumun sertifika denetimini tamamen "geçerli" say. */
function sertifikaDenetiminiGevset() {
  try {
    session.defaultSession.setCertificateVerifyProc(function (istek, geriCagir) {
      geriCagir(0); // 0 = başarılı (Chromium'un kendi sonucunu ez)
    });
  } catch (e) {
    console.error('Sertifika denetimi gevşetilemedi:', e);
  }
}

/* ==========================================================================
 *  1) AYAR DOSYASI YÖNETİMİ
 * ========================================================================*/

function ayarYolu() {
  return path.join(app.getPath('userData'), 'ayarlar.json');
}

function varsayilanAyarlar() {
  const bitis = new Date();
  bitis.setDate(bitis.getDate() + 365); // Yıllık bakım: kurulumdan itibaren 365 gün
  return {
    /* Beyaz etiket (white-label): kod içinde HİÇBİR müşteri unvanı gömülü
       değildir. Boş bırakılır; kullanıcı Ayarlar sekmesinden kendi firma
       adını yazana kadar başlıkta "Firma Adı Girilmedi" görünür. */
    firmaAdi: '',
    demoModu: true, // İLK AÇILIŞTA DEMO AKTİF — sunum için hazır gelsin
    wooUrl: '',
    ck: '',
    cs: '',
    // Bağlantı doğrulandıktan sonra Site Adresi / Consumer Key / Secret kutuları
    // kilitlenir (salt okunur + maskeli). Kullanıcı ya da bayi sahibi çalışan bir
    // bağlantıyı yanlışlıkla bozmasın diye. Kilit "KİLİDİ AÇ" ile kaldırılır.
    apiKilitli: false,
    // Bağlantı kurulduğunda sitenin b2b-core theme-config'inden çekilen logo
    // adresi (bkz. siteLogosunuGetir). Sitede/eklentide logo yoksa boş kalır.
    siteLogosu: '',
    // Site logosu yoksa/çekilemezse Vitrin Editörü › Marka Görselleri panelinden yüklenen
    // yerel logo (data:image/... base64) — bkz. yerelLogoYukle.
    yerelLogo: '',
    // Sitenin tarayıcı sekmesi simgesi (favicon). Yine Marka Görselleri panelinden
    // yüklenir ve theme-config'in branding.favicon alanına gönderilir.
    yerelFavicon: '',
    lisansBitis: bitis.toISOString().slice(0, 10),
    tema: 'acik',
    // Urun sekmesindeki liste gorunumu: 'tablo' (Excel tipi izgara) veya
    // 'kart' (surukle-birak siralamanin calistigi eski duzen).
    urunGorunumu: 'tablo',
    /* Sol üst logo genişliği (px). Ayarlar → "Logo Genişliği" kaydırıcısı;
       renderer --logo-width CSS değişkenine yazar (Faz 11, Orhan Bey talebi).
       220 = eski sabit max-width, mevcut kurulumlar aynı görünür. */
    logoGenislik: 220,
    // Canlı sipariş kontrolü: sipariş sekmesi açıkken kaç saniyede bir tazelensin.
    otoYenile: true,
    otoYenileSaniye: 60,
    // Bayi onayı e-postası ("Bayiliğiniz Onaylanmıştır") gönderilsin mi?
    onayEpostasi: true,
    // Sipariş durumu değişince müşteriye bilgi e-postası gitsin mi?
    durumEpostasi: true,
    // ---- YEDEK YOL (b2b-core eklentisi kurulu DEĞİLSE) ----
    // Eklenti yoksa üyelik onayı, müşterinin meta alanı üzerinden yürütülür.
    b2bAlan: 'b2b_durum',
    b2bBekliyor: 'bekliyor',
    b2bOnaylandi: 'onaylandi',
    b2bReddedildi: 'reddedildi'
  };
}

function ayarlariOku() {
  try {
    const ham = fs.readFileSync(ayarYolu(), 'utf8');
    return Object.assign(varsayilanAyarlar(), JSON.parse(ham));
  } catch (e) {
    return varsayilanAyarlar();
  }
}

function ayarlariYaz(yeni) {
  const tam = Object.assign(ayarlariOku(), yeni || {});
  try {
    fs.mkdirSync(path.dirname(ayarYolu()), { recursive: true });
    fs.writeFileSync(ayarYolu(), JSON.stringify(tam, null, 2), 'utf8');
  } catch (e) {
    console.error('Ayarlar kaydedilemedi:', e);
  }
  return tam;
}

/*
 * AYAR KANALLARI — YÖNETİCİ PIN VE CİHAZ KİLİDİ İÇİN SÜZÜLÜR (bkz. bölüm 3.9)
 *
 * Bu iki kanal GENEL amaçlıdır: arayüz her anahtarı okuyup geri yazabilir.
 * Cihaz kilidi ve Master PIN alanları buradan serbest geçseydi kilit hiçbir
 * şey ifade etmezdi — kilitli cihazdaki biri tek satırla
 * `ayar:yaz { cihazRolu: 'standart' }` diyerek yönetici kapısını geri açardı.
 * Bu yüzden:
 *   okuma → `maskele`  : PIN özeti arayüze HİÇ gitmez, yerine bool bayrak.
 *   yazma → `suz`      : korumalı alanlar sessizce ayıklanır.
 *
 * Korumalı alanlar YALNIZCA bölüm 3.9'daki PIN doğrulamalı kanallardan yazılır.
 * İçerideki `ayarlariYaz()` çağrıları süzgeçten geçmez (gerekir de: kilidi
 * yazan kod onu kullanıyor) — süzgeç bilinçli olarak IPC SINIRINDA durur.
 */
ipcMain.handle('ayar:oku', () => yoneticiKilit.maskele(ayarlariOku()));
ipcMain.handle('ayar:yaz', (olay, yeni) => yoneticiKilit.maskele(ayarlariYaz(yoneticiKilit.suz(yeni))));

/** Destek verirken lazım olan teknik bilgiler (Ayarlar sekmesinde gösterilir). */
ipcMain.handle('uygulama:bilgi', () => ({
  surum: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  ayarDosyasi: ayarYolu()
}));

/* ==========================================================================
 *  2) WOOCOMMERCE REST API KÖPRÜSÜ
 * ========================================================================*/

/** Hatanın sertifika/TLS kaynaklı olup olmadığını anlar (kod + mesaj birlikte). */
function sertifikaHatasiMi(e) {
  const parcalar = [
    (e && e.code) || '',
    (e && e.message) || '',
    (e && e.cause && e.cause.code) || '',
    (e && e.cause && e.cause.message) || ''
  ].join(' ');
  return /CERT|SSL|TLS|self[- ]signed|UNABLE_TO_VERIFY|DEPTH_ZERO|HOSTNAME/i.test(parcalar);
}

/**
 * İsteği "sertifika katılığı olmadan" atar.
 *
 * 1) Önce Node'un fetch'i denenir (NODE_TLS_REJECT_UNAUTHORIZED=0 sayesinde
 *    sertifika doğrulaması yapılmaz).
 * 2) Node katmanı yine de sertifika yüzünden takılırsa, Chromium ağ yığını
 *    (net.fetch) ile tekrar denenir; orada da 'ignore-certificate-errors' ve
 *    setCertificateVerifyProc devrede olduğu için istek geçer.
 */
async function esnekIstek(adres, secenekler) {
  try {
    return await fetch(adres, secenekler);
  } catch (e) {
    if (!sertifikaHatasiMi(e)) throw e;
    console.warn('Node tarafı SSL yüzünden takıldı, Chromium ağ yığını deneniyor:', (e && e.message) || e);
    return await net.fetch(adres, secenekler);
  }
}

/** Ağ hatalarını esnafın anlayacağı Türkçeye çevirir. */
function agHatasiTurkce(e) {
  const kod = (e && (e.code || (e.cause && e.cause.code))) || '';
  const ad = (e && e.name) || '';

  if (ad === 'TimeoutError' || ad === 'AbortError') {
    return 'Bağlantı zaman aşımına uğradı (25 saniye). Site çok yavaş veya kapalı olabilir.';
  }
  if (kod === 'ENOTFOUND' || kod === 'EAI_AGAIN') {
    return 'Site adresine ulaşılamadı. İnternet bağlantınızı ve yazdığınız adresi kontrol edin.';
  }
  if (kod === 'ECONNREFUSED') {
    return 'Sunucu bağlantıyı reddetti. Site adresi veya port yanlış olabilir.';
  }
  if (kod === 'ECONNRESET') {
    return 'Bağlantı sunucu tarafından kesildi. Lütfen tekrar deneyin.';
  }
  if (sertifikaHatasiMi(e)) {
    // Sertifika doğrulaması zaten kapalı (bkz. bölüm 0). Buraya düşülüyorsa sorun
    // "sertifikaya güvenilmedi" değil, TLS el sıkışmasının hiç tamamlanamamasıdır.
    return 'Site ile güvenli bağlantı (SSL) kurulamadı.\n' +
           'Sertifika doğrulaması kapalı olduğu hâlde el sıkışma tamamlanmadı; ' +
           'sunucunun TLS ayarları çok eski olabilir.\n' +
           'Adresi http:// olarak deneyin veya hosting firmanıza SSL ayarlarını sorun.';
  }
  return 'Bağlantı hatası: ' + ((e && e.message) || 'bilinmeyen sebep');
}

/** HTTP durum kodlarını Türkçe açıklamaya çevirir. */
function httpHatasiTurkce(durum, veri) {
  const mesaj = veri && veri.message ? String(veri.message) : '';
  if (durum === 401 || durum === 403) {
    return 'Consumer Key / Consumer Secret hatalı ya da yetkisi yok.\n' +
           'WooCommerce\'de anahtarı "Okuma/Yazma" izniyle oluşturduğunuzdan emin olun.' +
           (mesaj ? '\n\nSunucu mesajı: ' + mesaj : '');
  }
  if (durum === 404) {
    return 'Adres bulunamadı. Site adresi yanlış olabilir veya WooCommerce REST API kapalı olabilir.' +
           (mesaj ? '\n\nSunucu mesajı: ' + mesaj : '');
  }
  if (durum === 400) {
    return 'İstek reddedildi (geçersiz veri).' + (mesaj ? '\n\nSunucu mesajı: ' + mesaj : '');
  }
  if (durum >= 500) {
    return 'Sitede sunucu hatası oluştu (HTTP ' + durum + '). Hosting firmanıza danışın.' +
           (mesaj ? '\n\nSunucu mesajı: ' + mesaj : '');
  }
  return 'Beklenmeyen hata (HTTP ' + durum + ').' + (mesaj ? '\n\nSunucu mesajı: ' + mesaj : '');
}

/** Desteklenen API alanları (namespace). İkisi de aynı anahtarlarla çalışır. */
const API_ALANLARI = {
  woo: 'wc/v3',        // WooCommerce çekirdek
  b2b: 'wc-b2b/v1',    // b2b-core eklentisi
  /*
   * b2b-core'un ESKİ ad alanı. Bazı kurulumlarda (ve bazı tema paketlerinde)
   * kurumsal başvuru uçları "wc-b2b/v1" yerine yalnızca "b2b/v1" altında
   * yayınlanıyor. Panel önce kanonik ad alanını dener, "rest_no_route"
   * alırsa buraya düşer (bkz. renderer.js → bekleyenBasvurulariGetir).
   *
   * NOT: WooCommerce'in Consumer Key/Secret doğrulaması yalnızca "wc/" ve
   * "wc-" ile başlayan ad alanlarında devreye girer; "b2b/v1" bunların
   * dışındadır. Bu yüzden yedek ad alanı ancak sitede kimlik doğrulamayı
   * kendisi çözen bir eklenti varsa yanıt verir — dönmezse kanonik uçtan
   * gelen sonuç kullanılır, kullanıcıya ekstra bir hata gösterilmez.
   */
  b2bAlt: 'b2b/v1',
  /*
   * BYOM 2.0 lego vitrin düzeni (b2b-core 2.4.0+). "byomWc" ayna ad alanı
   * "wc-" öneki taşıdığı için WooCommerce anahtar doğrulaması kendiliğinden
   * çalışır; "byom" sartname adresidir (eklenti filtreyle açar). Panel önce
   * aynayı, sonra sartname adresini dener (renderer-vitrin.js).
   */
  byom: 'byom/v1',
  byomWc: 'wc-byom/v1'
};

/** Kullanıcının yazdığı adresi temizler: boşluk, /wp-json eki, sondaki / ve eksik protokol. */
function tabanAdresiTemizle(ham) {
  let taban = String(ham || '').trim().replace(/\s+/g, '');

  if (!taban) return '';

  /*
   * FAZ 7'DE GÜÇLENDİRİLDİ — eski hâli iki gerçek hatayı geçiriyordu:
   *
   *   "https://site.com//shop"  → aynen kalıyordu. `new URL` gövdedeki çift
   *      bölüyü NORMALİZE ETMEZ; pathname "//shop/wp-json/..." olarak gidiyor
   *      ve WordPress 404 dönüyordu. Kullanıcının gördüğü şey yine
   *      "eklenti bulunamadı" oluyordu — yanlış iz.
   *
   *   "https:/site.com" (tek bölü) → `/^https?:\/\//` testini geçemediği için
   *      BAŞINA BİR PROTOKOL DAHA ekleniyordu: "https://https:/site.com".
   *      Bu GEÇERLİ bir URL olduğu için "Site adresi geçersiz" kapısı hiç
   *      açılmıyor, host literal olarak "https" oluyor ve kullanıcı
   *      "adres hatalı" yerine "sunucuya ulaşılamıyor" görüyordu.
   *
   * Çözüm, bu depoda ZATEN DOĞRU YAZILMIŞ kardeş temizleyicinin kalıbı:
   * `src/main/byom-yapilandirma.js → adresiTemizle()`. İki temizleyicinin
   * aynı kurallarla çalışması bilinçli — biri hub adresi, diğeri mağaza
   * adresi için ve ikisi de kullanıcının ELLE yazdığı alanlar.
   */
  let protokol = '';
  const protokolEsi = taban.match(/^(https?):\/*/i);

  if (protokolEsi) {
    protokol = protokolEsi[1].toLowerCase() + '://';
    taban = taban.slice(protokolEsi[0].length);
  }

  /* Kullanıcı tam REST adresini yapıştırdıysa kuyruğu at. Bölü sıkıştırmadan
     ÖNCE yapılır: "site.com//wp-json/x" → "site.com/" → "site.com". */
  taban = taban.replace(/\/wp-json.*$/i, '');

  taban = taban.replace(/^\/+/, '');        // "//site.com" artığı
  taban = taban.replace(/\/{2,}/g, '/');    // GÖVDEDEKİ çift bölüler
  taban = taban.replace(/\/+$/, '');

  if (!taban) return '';

  if (!protokol) {
    /* localhost için http: https ile yerel geliştirme sunucusu çoğunlukla
       yanıt vermez. Kardeş temizleyiciyle aynı kural. */
    protokol = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(taban)
      ? 'http://' : 'https://';
  }

  return protokol + taban;
}

/**
 * REST isteğini Node üzerinden atar (CORS yok, sertifika/zaman aşımı yönetimi burada).
 *
 * istek = {
 *   alan: 'woo' | 'b2b' | 'wc/v3' | 'wc-b2b/v1',   (varsayılan: 'woo')
 *   yol: 'orders/981/status',
 *   metod: 'GET' | 'POST' | 'PUT' | 'DELETE',
 *   sorgu: { per_page: 20 },
 *   govde: { ... },
 *   sureAsimi: 25000,                               (milisaniye)
 *   taban / ck / cs                                 (verilmezse ayarlardan okunur)
 * }
 *
 * döner = { ok, durum, veri, toplam, sayfa, kod, hata }
 *   · kod  → WordPress hata kodu (ör. "rest_no_route", "b2b_sku_exists")
 *   · sayfa → X-WP-TotalPages
 */
/**
 * REST yolunu kurar: `/wp-json/<ad alanı>/<uç>` — TEK bölü çizgisiyle.
 *
 * NEDEN AYRI BİR FONKSİYON (Faz 7):
 * Yol iki yerde kuruluyordu — istek atılırken ve HATA MESAJI yazılırken.
 * İstek tarafı baştaki bölüleri temizliyordu, hata mesajı TEMİZLEMİYORDU:
 *
 *     istek : .../wp-json/wc-b2b/v1/admin/plasiyerler     ← doğru
 *     mesaj : .../wp-json/wc-b2b/v1//admin/plasiyerler    ← çift bölü
 *
 * Kullanıcı hata mesajındaki `//`yi görüp isteğin bozuk olduğunu sandı ve bir
 * hata ayıklama turu bunun peşinde geçti. Gerçek sorun sunucuda rotanın hiç
 * olmamasıydı (eski eklenti sürümü). Aynı metni iki yerde kurmak, birinin
 * yanlış olmasına davetiyedir; artık TEK yerde kuruluyor.
 *
 * Parçalar tek tek kırpılır, sonra kullanıcının istediği sağlamlaştırma
 * regex'i son bir süzgeç olarak uygulanır: `([^:]\/)\/+` → `$1`.
 * `https://` ZARAR GÖRMEZ çünkü desen bölüden önce iki nokta OLMAMASINI
 * şart koşar. Yalnızca YOL üzerinde çalışır — sorgu dizesi burada henüz
 * eklenmemiştir (`url.searchParams` ile sonra ekleniyor), dolayısıyla sorgu
 * içindeki bir `//` bozulmaz.
 */
function restYoluKur(alan, yol) {
  const parcalar = ['wp-json', String(alan || ''), String(yol || '')]
    .map(function (p) { return p.replace(/^\/+|\/+$/g, ''); })
    .filter(Boolean);

  return ('/' + parcalar.join('/')).replace(/([^:]\/)\/+/g, '$1');
}

async function apiIstek(istek) {
  istek = istek || {};
  const ayarlar = ayarlariOku();

  const hamTaban = String(istek.taban || ayarlar.wooUrl || '').trim();
  const ck = String(istek.ck || ayarlar.ck || '').trim();
  const cs = String(istek.cs || ayarlar.cs || '').trim();

  if (!hamTaban) {
    return { ok: false, durum: 0, hata: 'Site adresi girilmemiş.\nAyarlar sekmesinden WooCommerce site adresini yazın.' };
  }
  if (!ck || !cs) {
    return { ok: false, durum: 0, hata: 'Consumer Key ve Consumer Secret girilmemiş.\nAyarlar sekmesinden anahtarları yapıştırın.' };
  }

  const alan = API_ALANLARI[istek.alan] || istek.alan || API_ALANLARI.woo;
  const taban = tabanAdresiTemizle(hamTaban);
  const restYolu = restYoluKur(alan, istek.yol);

  let url;
  try {
    url = new URL(taban + restYolu);
  } catch (e) {
    return { ok: false, durum: 0, hata: 'Site adresi geçersiz.\nDoğru örnek: https://www.siteniz.com' };
  }

  const sorgu = istek.sorgu || {};
  Object.keys(sorgu).forEach(function (anahtar) {
    const deger = sorgu[anahtar];
    if (deger !== undefined && deger !== null && deger !== '') {
      url.searchParams.set(anahtar, String(deger));
    }
  });

  const yetki = 'Basic ' + Buffer.from(ck + ':' + cs, 'utf8').toString('base64');
  const metod = (istek.metod || 'GET').toUpperCase();
  const sureAsimi = Number(istek.sureAsimi) > 0 ? Number(istek.sureAsimi) : 25000;

  try {
    const yanit = await esnekIstek(url.toString(), {
      method: metod,
      headers: {
        Authorization: yetki,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'B2B-Yonetim-Paneli/1.0'
      },
      body: istek.govde ? JSON.stringify(istek.govde) : undefined,
      signal: AbortSignal.timeout(sureAsimi)
    });

    const metin = await yanit.text();
    let veri = null;
    try {
      veri = metin ? JSON.parse(metin) : null;
    } catch (e) {
      veri = null;
    }

    if (!yanit.ok) {
      const kod = veri && veri.code ? String(veri.code) : '';

      // JSON gelmediyse muhtemelen WooCommerce değil, normal bir web sayfası döndü
      if (veri === null && metin && metin.indexOf('<') === 0) {
        return {
          ok: false,
          durum: yanit.status,
          hata: 'Bu adres WooCommerce REST API adresi gibi görünmüyor (HTTP ' + yanit.status + ').\n' +
                'Sadece site adresini yazın, örnek: https://www.siteniz.com'
        };
      }

      /*
       * b2b-core eklentisi kurulu/etkin değilse bu uç hiç kayıtlı olmaz.
       *
       * "GÜNCEL DEĞİL" İHTİMALİ DE SÖYLENİR (Faz 7). Eskiden mesaj yalnızca
       * "bulunamadı veya etkin değil" diyordu; oysa en sık sebep eklentinin
       * KURULU AMA ESKİ olmasıdır — yeni bir panel sürümü, sitede henüz
       * güncellenmemiş bir eklentinin yayınlamadığı ucu çağırır. Kullanıcı
       * "eklenti kurulu, etkin de" deyip hatayı panelde arar. Yaşanan tam
       * olarak bu oldu: panel 2.15.0 uçlarını çağırırken site 2.12.0'daydı.
       *
       * Aranan adres ARTIK `restYoluKur` ile kuruluyor — istekle BİREBİR
       * aynı metin. İkisini ayrı kurmak, mesajda çift bölü çizgisi gösterip
       * teşhisi yanlış yöne çeviriyordu.
       */
      if (kod === 'rest_no_route' && alan === API_ALANLARI.b2b) {
        return {
          ok: false,
          durum: yanit.status,
          kod: kod,
          eklentiYok: true,
          hata: 'Bu uç sitenizde bulunamadı. Üç olası sebep var:\n' +
                '  1) "B2B Core" eklentisi etkin değil.\n' +
                '     → WordPress › Eklentiler listesinden etkinleştirin.\n' +
                '  2) Eklenti etkin ama SÜRÜMÜ ESKİ (en sık sebep).\n' +
                '     → Panel yeni uçlar çağırıyor; güncel b2b-core.zip ile güncelleyin.\n' +
                '  3) Eklenti etkin ve güncel ama WooCommerce DEVRE DIŞI.\n' +
                '     → Bu uçlar WooCommerce gerektirir ve WooCommerce kapalıysa\n' +
                '       hiç kaydedilmez (B2B_Core::include_wc_dependent).\n' +
                'Hâlâ sürüyorsa Ayarlar › Kalıcı Bağlantılar sayfasında\n' +
                '"Değişiklikleri kaydet" deyip REST rotalarını yenileyin.\n' +
                '(Aranan adres: ' + restYoluKur(alan, istek.yol) + ')'
        };
      }

      return {
        ok: false,
        durum: yanit.status,
        kod: kod,
        veri: veri,
        hata: httpHatasiTurkce(yanit.status, veri)
      };
    }

    return {
      ok: true,
      durum: yanit.status,
      veri: veri,
      toplam: Number(yanit.headers.get('x-wp-total') || 0),
      sayfa: Number(yanit.headers.get('x-wp-totalpages') || 1)
    };
  } catch (e) {
    /*
     * agSorunu: taşıma katmanı hatası (DNS, bağlantı reddi, zaman aşımı, TLS).
     * Vitrin Editörü'nün çevrimdışı kuyruğu YALNIZCA bu bayrak (ya da 5xx)
     * varken yayını kuyrukta tutar; 4xx yanıtlar tekrar denenmez.
     * Desen src/main/byom-api.js ile aynıdır.
     */
    return {
      ok: false,
      durum: 0,
      agSorunu: true,
      kod: (e && (e.code || (e.cause && e.cause.code))) || (e && e.name) || '',
      hata: agHatasiTurkce(e)
    };
  }
}

/** Genel API köprüsü — hem wc/v3 hem wc-b2b/v1 için. */
ipcMain.handle('api:istek', (olay, istek) => apiIstek(istek));

/** Eski çağrı adı: her zaman WooCommerce çekirdek (wc/v3) alanına gider. */
ipcMain.handle('woo:istek', (olay, istek) => {
  return apiIstek(Object.assign({}, istek || {}, { alan: API_ALANLARI.woo }));
});

/* ==========================================================================
 *  3) DEPO FİŞİ — ÖNİZLEME / YAZDIR / PDF
 * ========================================================================*/

const gecikoDosyalar = new Map(); // pencereId -> temp dosya yolu

/** Arayüzden gelen A4 fiş HTML'ini geçici dosyaya yazıp yeni pencerede açar. */
ipcMain.handle('fis:onizleme', async (olay, veri) => {
  veri = veri || {};
  try {
    const dosyaAdi = 'depo-fisi-' + Date.now() + '-' + Math.round(Math.random() * 9999) + '.html';
    const gecikoYol = path.join(os.tmpdir(), dosyaAdi);
    fs.writeFileSync(gecikoYol, String(veri.html || ''), 'utf8');

    const pencere = new BrowserWindow({
      width: 1020,
      height: 980,
      minWidth: 700,
      minHeight: 500,
      title: veri.baslik || 'Depo Fişi',
      parent: anaPencere || undefined,
      backgroundColor: '#e8eaee',
      autoHideMenuBar: true,
      // Ana pencereyle aynı sebep: 'ready-to-show' bu ayarlarla tetiklenmeyebiliyor.
      // Fiş penceresi de doğrudan görünür açılıyor.
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        spellcheck: false
      }
    });

    pencere.setMenuBarVisibility(false);
    gecikoDosyalar.set(pencere.id, gecikoYol);

    pencereyiKesinGoster(pencere, false);
    pencere.once('ready-to-show', function () {
      pencereyiKesinGoster(pencere, false);
    });

    pencere.on('closed', function () {
      const yol = gecikoDosyalar.get(pencere.id);
      gecikoDosyalar.delete(pencere.id);
      if (yol) {
        try { fs.unlinkSync(yol); } catch (e) { /* önemli değil */ }
      }
    });

    await pencere.loadFile(gecikoYol);
    pencereyiKesinGoster(pencere, false);
    return { ok: true };
  } catch (e) {
    return { ok: false, hata: 'Fiş penceresi açılamadı: ' + e.message };
  }
});

/** Fiş penceresinden çağrılır: Windows yazdırma penceresini açar. */
ipcMain.handle('fis:yazdir', async (olay) => {
  const icerik = olay.sender;
  return await new Promise(function (cozumle) {
    icerik.print(
      {
        silent: false,
        printBackground: true,
        margins: { marginType: 'none' } // Kenar boşluğunu CSS'teki @page 12mm belirlesin
      },
      function (basarili, hataSebebi) {
        if (basarili) {
          cozumle({ ok: true });
        } else if (hataSebebi === 'cancelled' || hataSebebi === 'Print job canceled') {
          cozumle({ ok: false, iptal: true });
        } else {
          cozumle({ ok: false, hata: 'Yazdırma başarısız: ' + (hataSebebi || 'bilinmeyen sebep') });
        }
      }
    );
  });
});

/** Fiş penceresinden çağrılır: kaydetme penceresi açar, A4 PDF üretir ve açar. */
ipcMain.handle('fis:pdf', async (olay, veri) => {
  veri = veri || {};
  const icerik = olay.sender;
  const pencere = BrowserWindow.fromWebContents(icerik);

  let masaustu;
  try { masaustu = app.getPath('desktop'); } catch (e) { masaustu = app.getPath('documents'); }

  const secim = await dialog.showSaveDialog(pencere, {
    title: 'Depo Fişini PDF Olarak Kaydet',
    defaultPath: path.join(masaustu, (veri.dosyaAdi || 'Depo-Fisi') + '.pdf'),
    filters: [{ name: 'PDF Dosyası', extensions: ['pdf'] }],
    buttonLabel: 'Kaydet'
  });

  if (secim.canceled || !secim.filePath) {
    return { ok: false, iptal: true };
  }

  try {
    const pdf = await icerik.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 } // Boşluk CSS'teki @page 12mm'den gelir
    });
    fs.writeFileSync(secim.filePath, pdf);
    shell.openPath(secim.filePath); // Kaydedilen PDF'i hemen göster
    return { ok: true, yol: secim.filePath };
  } catch (e) {
    return { ok: false, hata: 'PDF oluşturulamadı: ' + e.message };
  }
});

/** Fiş penceresini kapatır. */
ipcMain.handle('fis:kapat', (olay) => {
  const pencere = BrowserWindow.fromWebContents(olay.sender);
  if (pencere) pencere.close();
  return { ok: true };
});

/* ==========================================================================
 *  3.4) EXCEL DÖKÜMÜ VE İÇE AKTARMA
 *  ---------------------------------------------------------------------------
 *  Dosya işleri ANA SÜREÇTE yapılır: arayüz tarafında `fs` ile 900 satırlık
 *  bir çalışma kitabı üretmek pencereyi kilitler, üstelik kaydetme/açma
 *  pencereleri (dialog) yalnızca burada açılabilir.
 *
 *  Arayüz tarafı: renderer-excel.js
 * ========================================================================*/

/** Kaydetme penceresinin açılacağı klasör (masaüstü, yoksa belgeler). */
function kayitKlasoru() {
  try { return app.getPath('desktop'); } catch (e) {
    try { return app.getPath('documents'); } catch (e2) { return app.getPath('home'); }
  }
}

/** Dosya adındaki yasak karakterleri temizler. */
function dosyaAdiTemizle(ham) {
  return String(ham || 'Dokum').replace(/[\\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'Dokum';
}

/**
 * Ürün dökümünü .xlsx olarak kaydeder.
 * istek = { dosyaAdi, sayfaAdi, sutunlar:[{baslik,tur,genislik}], satirlar:[[...]] }
 */
ipcMain.handle('excel:disaAktar', async (olay, istek) => {
  istek = istek || {};
  const pencere = BrowserWindow.fromWebContents(olay.sender);

  const secim = await dialog.showSaveDialog(pencere, {
    title: 'Excel Dökümünü Kaydet',
    defaultPath: path.join(kayitKlasoru(), dosyaAdiTemizle(istek.dosyaAdi) + '.xlsx'),
    filters: [{ name: 'Excel Çalışma Kitabı', extensions: ['xlsx'] }],
    buttonLabel: 'Kaydet'
  });

  if (secim.canceled || !secim.filePath) return { ok: false, iptal: true };

  try {
    excel.xlsxYaz(secim.filePath, {
      sayfaAdi: istek.sayfaAdi || 'Ürünler',
      sutunlar: istek.sutunlar || [],
      satirlar: istek.satirlar || []
    });
  } catch (e) {
    return { ok: false, hata: 'Excel dosyası oluşturulamadı:\n' + e.message };
  }

  /* Kaydedilen dosya hemen açılır. Excel kurulu değilse openPath bir hata
     METNİ döndürür (fırlatmaz); o durumda dosya klasörde işaretlenir. */
  let acilmadi = '';
  try { acilmadi = await shell.openPath(secim.filePath); } catch (e) { acilmadi = String((e && e.message) || e); }
  if (acilmadi) { try { shell.showItemInFolder(secim.filePath); } catch (e) { /* yok say */ } }

  return { ok: true, yol: secim.filePath, acildi: !acilmadi };
});

/** İçe aktarılacak dosyayı seçtirir. */
ipcMain.handle('excel:dosyaSec', async (olay) => {
  const pencere = BrowserWindow.fromWebContents(olay.sender);

  const secim = await dialog.showOpenDialog(pencere, {
    title: 'İçe Aktarılacak Excel / CSV Dosyasını Seçin',
    properties: ['openFile'],
    filters: [
      { name: 'Excel ve CSV Dosyaları', extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'txt'] },
      { name: 'Excel Çalışma Kitabı', extensions: ['xlsx', 'xlsm'] },
      { name: 'Eski Excel Dosyası', extensions: ['xls'] },
      { name: 'Metin / CSV', extensions: ['csv', 'txt'] },
      { name: 'Tüm Dosyalar', extensions: ['*'] }
    ],
    buttonLabel: 'Aç'
  });

  if (secim.canceled || !secim.filePaths.length) return { ok: false, iptal: true };

  const yol = secim.filePaths[0];
  let boyut = 0;
  try { boyut = fs.statSync(yol).size; } catch (e) { /* yok say */ }

  return { ok: true, yol: yol, ad: path.basename(yol), boyut: boyut };
});

/**
 * Seçilen dosyayı satır dizisine çevirir.
 * istek = { yol, enFazlaSatir }   (enFazlaSatir 0 → sınırsız)
 */
ipcMain.handle('excel:tabloOku', (olay, istek) => {
  istek = istek || {};
  if (!istek.yol) return { ok: false, hata: 'Dosya yolu verilmedi.' };

  try {
    return excel.tabloOku(String(istek.yol), Number(istek.enFazlaSatir) || 0);
  } catch (e) {
    return { ok: false, hata: 'Dosya okunamadı:\n' + ((e && e.message) || e) };
  }
});

/* ==========================================================================
 *  3.5) OTOMATİK GÜNCELLEME (electron-updater)
 *  ---------------------------------------------------------------------------
 *  Yayın (publish) kaynağı GitHub Releases'tir — bkz. package.json >
 *  build.publish (owner: byomtechdev, repo: byom-b2b-panel). Depo yayına
 *  kapalıysa veya erişilemezse buradaki kontrol sessizce hata verip geçer;
 *  "error" olayı yalnızca konsola loglanır, uygulamanın normal
 *  çalışmasını ETKİLEMEZ.
 *
 *  Yalnızca PAKETLENMİŞ (kurulum ile yüklenmiş) sürümde çalışır: geliştirme
 *  ortamında (`npm start`) electron-updater güncel sürüm bilgisini okuyamaz
 *  ve gereksiz ağ isteği/log kirliliği üretir.
 * ========================================================================*/

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

/** Açılıştaki ilk kontrolün gecikmesi ve sonraki turların aralığı. */
const GUNCELLEME_ILK_GECIKME_MS = 5000;
const GUNCELLEME_TUR_ARALIGI_MS = 30 * 60 * 1000; // 30 dakika

/** Diyalog açıkken ikinci bir "update-downloaded" araya girmesin. */
let guncellemeDiyaloguGosterildi = false;
/** Kullanıcının "Daha Sonra" dediği sürüm; 30 dk.lık turlarda tekrar sorulmaz. */
let ertelenenGuncellemeSurumu = '';
/** Zamanlayıcı tek sefer kurulsun; kurulduysa tekrar başlatma yapılmaz. */
let guncellemeZamanlayicisi = null;
/** Ana pencere henüz yokken üretilen bildirim; pencere açılınca gönderilir. */
let bekleyenGuncellemeBildirimi = null;

/**
 * Güncelleme durumunu arayüze iletir. Ana pencere henüz açılmamışsa (lisans
 * akışı sürüyor olabilir) bildirim saklanır ve pencere yüklenince gönderilir.
 * Bildirim kaçsa bile indirme arka planda devam eder.
 */
function guncellemeDurumunuBildir(durum, mesaj, bilgi) {
  const veri = { durum: durum, mesaj: mesaj, surum: (bilgi && bilgi.version) || '' };

  if (!anaPencere || anaPencere.isDestroyed()) {
    bekleyenGuncellemeBildirimi = veri;
    return;
  }
  try {
    anaPencere.webContents.send('guncelleme:durum', veri);
  } catch (e) {
    /* pencere kapanıyor olabilir; güncelleme akışını etkilemez */
  }
}

/** Ana pencere yüklendiğinde beklemede kalan güncelleme bildirimini iletir. */
function bekleyenGuncellemeBildiriminiGonder() {
  if (!bekleyenGuncellemeBildirimi) return;
  const veri = bekleyenGuncellemeBildirimi;
  bekleyenGuncellemeBildirimi = null;
  guncellemeDurumunuBildir(veri.durum, veri.mesaj, { version: veri.surum });
}

autoUpdater.on('update-available', function (bilgi) {
  const surum = (bilgi && bilgi.version) || '?';
  gunluk('[Güncelleme] Yeni sürüm bulundu: ' + surum + ' — indiriliyor…');
  guncellemeDurumunuBildir(
    'bulundu',
    'Yeni güncelleme bulundu (' + surum + ').\nArka planda indiriliyor, çalışmaya devam edebilirsiniz.',
    bilgi
  );
});

autoUpdater.on('update-not-available', function () {
  gunluk('[Güncelleme] Uygulama güncel.');
});

/** İndirme tamamlanınca kullanıcıya sorar; onaylarsa uygulamayı kapatıp kurulumu başlatır. */
autoUpdater.on('update-downloaded', async function (bilgi) {
  if (guncellemeDiyaloguGosterildi) return;

  const surum = (bilgi && bilgi.version) || '';
  // Bu sürüm için zaten "Daha Sonra" denmiş: kurulum çıkışta yapılacak, rahatsız etme.
  if (surum && surum === ertelenenGuncellemeSurumu) return;
  guncellemeDiyaloguGosterildi = true;

  const pencere = (anaPencere && !anaPencere.isDestroyed()) ? anaPencere : undefined;

  guncellemeDurumunuBildir(
    'indirildi',
    'Güncelleme' + (surum ? ' ' + surum : '') + ' indirildi, kuruluma hazır.',
    bilgi
  );

  const secim = await dialog.showMessageBox(pencere, {
    type: 'info',
    title: 'Güncelleme Hazır',
    message: 'B2B Yönetim Paneli' + (surum ? ' ' + surum : '') + ' sürümü indirildi.',
    detail: 'Yeni sürümü kurmak için uygulama birkaç saniyeliğine kapanıp yeniden açılacak.\n' +
            'Devam eden bir işleminiz varsa önce tamamlayın.\n\nŞimdi kurulsun mu?',
    buttons: ['ŞİMDİ YENİDEN BAŞLAT VE KUR', 'DAHA SONRA'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  guncellemeDiyaloguGosterildi = false;

  if (secim.response === 0) {
    autoUpdater.quitAndInstall();
  } else {
    // Ertelendi: kurulum uygulamadan çıkışta yapılır (autoInstallOnAppQuit).
    // Bu sürüm bir daha sorulmaz; yalnızca YENİ bir sürüm tekrar sorabilir.
    ertelenenGuncellemeSurumu = surum;
  }
});

autoUpdater.on('error', function (hata) {
  console.warn('[Güncelleme] Kontrol/indirme hatası:', (hata && hata.message) || hata);
});

/** Tek bir sessiz kontrol turu. Ağ/depo hatasında yalnızca günlüğe yazar. */
function guncellemeyiKontrolEt() {
  return autoUpdater.checkForUpdatesAndNotify({
    title: 'Güncelleme Hazır',
    body: 'B2B Yönetim Paneli {version} indirildi ve uygulamadan çıkıldığında otomatik kurulacak.'
  }).catch(function (e) {
    console.warn('[Güncelleme] checkForUpdatesAndNotify başarısız:', (e && e.message) || e);
  });
}

/**
 * Açılıştan birkaç saniye sonra ilk kontrolü yapar, ardından 30 dakikada bir
 * turu tekrarlar. Uygulama günlerce açık kalsa da güncelleme yakalanır.
 */
function otomatikGuncellemeyiBaslat() {
  if (!app.isPackaged) {
    gunluk('[Güncelleme] Geliştirme ortamında atlandı (yalnızca paketlenmiş sürümde çalışır).');
    return;
  }
  if (guncellemeZamanlayicisi) return; // zaten kurulu

  setTimeout(guncellemeyiKontrolEt, GUNCELLEME_ILK_GECIKME_MS);

  guncellemeZamanlayicisi = setInterval(guncellemeyiKontrolEt, GUNCELLEME_TUR_ARALIGI_MS);
  // Zamanlayıcı yüzünden uygulama kapanışta beklemesin.
  if (typeof guncellemeZamanlayicisi.unref === 'function') guncellemeZamanlayicisi.unref();
}

/* ==========================================================================
 *  3.6) PLASİYER (SAHA SATIŞ) — KİMLİK VE VERİ KAPISI
 *  ---------------------------------------------------------------------------
 *  Panel tek bir Consumer Key/Secret ile çalışır; başındaki kişi yönetici de
 *  olabilir plasiyer de. "Hangi plasiyer?" sorusunu PIN cevaplar, cevabın
 *  karşılığı kısa ömürlü bir oturum jetonudur.
 *
 *  SIR YÖNETİMİ — ÜÇ KURAL:
 *
 *   1) PIN HİÇBİR YERDE TUTULMAZ. `plasiyer:auth` kanalına gelen PIN doğrudan
 *      isteğe konur ve çağrı biter; ne değişkende bekletilir ne loglanır.
 *      Arayüz de saklamaz (bkz. renderer-plasiyer.js).
 *
 *   2) JETON YALNIZCA ANA SÜREÇ BELLEĞİNDE. Diske YAZILMAZ — ayarlar.json'a
 *      da girmez. Uygulama kapanınca oturum düşer, plasiyer yeniden PIN girer.
 *      Saha cihazı kaybolursa dosyadan jeton okunamaz.
 *      (Bir taşıyıcı jetonun kullanılabilmesi için bellekte DURMASI gerekir;
 *       kaçınılan şey kalıcılaştırmak ve arayüze sızdırmaktır.)
 *
 *   3) JETON ARAYÜZE DÖNMEZ. `plasiyer:auth` yanıtında token alanı yoktur;
 *      `plasiyer:get-dealers` jetonu buradan, bellekten okur. Böylece jeton
 *      DOM'a, DevTools'a ve renderer günlüklerine hiç uğramaz.
 * ========================================================================*/

/** Etkin plasiyer oturumu — { id, ad, bolge, token, bitis }. Yalnızca bellek. */
let plasiyerOturumu = null;

/** Oturumun arayüze gösterilebilir (jetonsuz) hâli. */
function plasiyerOturumOzeti() {
  if (!plasiyerOturumu) return null;

  return {
    id: plasiyerOturumu.id,
    ad: plasiyerOturumu.ad,
    bolge: plasiyerOturumu.bolge,
    maxIskonto: plasiyerOturumu.maxIskonto,
    bitis: plasiyerOturumu.bitis,
    bayiSayisi: plasiyerOturumu.bayiSayisi
  };
}

/** Jeton süresi geçmiş mi? */
function plasiyerOturumuGecerliMi() {
  if (!plasiyerOturumu || !plasiyerOturumu.token) return false;
  if (!plasiyerOturumu.bitis) return true;

  return (plasiyerOturumu.bitis * 1000) > Date.now();
}

/**
 * PIN ile kimlik seçimi.
 *
 * Yanıt arayüze JETON İÇERMEDEN döner.
 */
ipcMain.handle('plasiyer:auth', async function (olay, veri) {
  veri = veri || {};

  const govde = {
    username: String(veri.kullanici || veri.username || '').trim(),
    plasiyer_id: Number(veri.id || veri.plasiyer_id || 0) || 0,
    pin: String(veri.pin || '')
  };

  if (!govde.username && !govde.plasiyer_id) {
    return { ok: false, hata: 'Pazarlamacı seçilmedi.' };
  }
  if (!govde.pin) {
    return { ok: false, hata: 'PIN girilmedi.' };
  }

  let cevap;

  try {
    cevap = await apiIstek({ alan: 'b2b', yol: '/plasiyer/auth', metod: 'POST', govde: govde });
  } finally {
    /* PIN referansı burada bırakılır; nesne çöpe gider, kopyası tutulmaz. */
    govde.pin = '';
  }

  if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
    return {
      ok: false,
      durum: cevap ? cevap.durum : 0,
      hata: (cevap && cevap.hata) || 'PIN doğrulanamadı.'
    };
  }

  const v = cevap.veri;

  plasiyerOturumu = {
    id: Number(v.id) || 0,
    ad: String(v.ad || ''),
    bolge: String(v.bolge || ''),
    maxIskonto: Number(v.maxIskonto) || 0,
    bayiSayisi: Number(v.bayiSayisi) || 0,
    token: String(v.token || ''),     // ARAYÜZE DÖNMEZ
    bitis: Number(v.bitis) || 0
  };

  return Object.assign({ ok: true }, plasiyerOturumOzeti());
});

/** Etkin oturumu sorar (arayüz yeniden çizilirken). */
ipcMain.handle('plasiyer:session', function () {
  if (!plasiyerOturumuGecerliMi()) {
    plasiyerOturumu = null;
    return { ok: true, oturum: null };
  }

  return { ok: true, oturum: plasiyerOturumOzeti() };
});

/**
 * Oturumun SIR OLMAYAN kısmını ayarlara yazar.
 *
 * Amacı yalnızca kolaylık: giriş kapısı bir dahaki açılışta aynı pazarlamacıyı
 * seçili getirir. Jeton ve PIN buraya GİRMEZ — dosya düz JSON'dur.
 */
ipcMain.handle('plasiyer:save-session', function (olay, veri) {
  veri = veri || {};

  const id = Number(veri.id || (plasiyerOturumu && plasiyerOturumu.id) || 0) || 0;

  if (!id) return { ok: false, hata: 'Kaydedilecek oturum yok.' };

  try {
    ayarlariYaz({
      plasiyerSonOturum: {
        id: id,
        ad: String(veri.ad || (plasiyerOturumu && plasiyerOturumu.ad) || ''),
        bolge: String(veri.bolge || (plasiyerOturumu && plasiyerOturumu.bolge) || '')
      }
    });
  } catch (e) {
    return { ok: false, hata: 'Oturum kaydedilemedi.' };
  }

  return { ok: true };
});

/**
 * Plasiyerin KENDİ bayileri.
 *
 * Jeton bellekten okunur; arayüz hangi plasiyer olduğunu söyleyemez
 * (söylese bile oturum kimliği esas alınır). Böylece arayüzdeki bir hata ya
 * da kurcalama başka bir plasiyerin bayilerini getirtemez.
 */
ipcMain.handle('plasiyer:get-dealers', async function (olay, veri) {
  veri = veri || {};

  if (!plasiyerOturumuGecerliMi()) {
    plasiyerOturumu = null;
    return { ok: false, durum: 401, hata: 'Oturum süresi doldu. Tekrar PIN ile giriş yapın.' };
  }

  const cevap = await apiIstek({
    alan: 'b2b',
    yol: '/plasiyer/dealers',
    metod: 'GET',
    sorgu: {
      plasiyer_id: plasiyerOturumu.id,   // arayüzden DEĞİL, oturumdan
      token: plasiyerOturumu.token,
      search: String(veri.arama || ''),
      per_page: Number(veri.adet || 200) || 200,
      page: Number(veri.sayfa || 1) || 1
    }
  });

  if (!cevap || !cevap.ok || !cevap.veri) {
    /* 401 = jeton düşmüş: oturumu burada kapatıp arayüzü kapıya yolluyoruz. */
    if (cevap && 401 === cevap.durum) plasiyerOturumu = null;

    return { ok: false, durum: cevap ? cevap.durum : 0, hata: (cevap && cevap.hata) || 'Bayi listesi alınamadı.' };
  }

  return { ok: true, veri: cevap.veri };
});

/** Çıkış — jetonu sunucuda iptal eder ve bellekten siler. */
ipcMain.handle('plasiyer:logout', async function () {
  const id = plasiyerOturumu ? plasiyerOturumu.id : 0;

  plasiyerOturumu = null;

  if (!id) return { ok: true };

  try {
    await apiIstek({ alan: 'b2b', yol: '/plasiyer/logout', metod: 'POST', govde: { plasiyer_id: id } });
  } catch (e) {
    /* Sunucuya ulaşılamasa bile yerel oturum düştü; kullanıcı kapıya döner. */
  }

  return { ok: true };
});

/**
 * Plasiyerin KENDİ siparişleri — SUNUCUDA daraltılmış uç (Faz 10).
 *
 * Faz 6-9'da "Kendi Siparişlerim" yönetici listesinin panelde süzülmesiydi
 * (görünüm süzgeci, yetki sınırı değil — §5.29 açık kalemi). Artık
 * `GET /plasiyer/siparislerim` jetonla yalnızca `_b2b_plasiyer_id` bu
 * plasiyer olan siparişleri döndürür; bütün şirket listesi cihaza HİÇ inmez.
 */
ipcMain.handle('plasiyer:get-orders', async function (olay, veri) {
  veri = veri || {};

  if (!plasiyerOturumuGecerliMi()) {
    plasiyerOturumu = null;
    return { ok: false, durum: 401, hata: 'Oturum süresi doldu. Tekrar PIN ile giriş yapın.' };
  }

  const cevap = await apiIstek({
    alan: 'b2b',
    yol: '/plasiyer/siparislerim',
    metod: 'GET',
    sorgu: {
      plasiyerId: plasiyerOturumu.id,     // arayüzden DEĞİL, oturumdan
      token: plasiyerOturumu.token,
      per_page: Number(veri.adet || 50) || 50,
      page: Number(veri.sayfa || 1) || 1
    }
  });

  if (!cevap || !cevap.ok || !cevap.veri) {
    if (cevap && 401 === cevap.durum) plasiyerOturumu = null;

    return { ok: false, durum: cevap ? cevap.durum : 0, hata: (cevap && cevap.hata) || 'Siparişler alınamadı.' };
  }

  return { ok: true, veri: cevap.veri };
});

/**
 * PERFORMANSIM (Faz 11) — plasiyerin KENDİ günlük/haftalık/aylık özeti.
 * Jeton yine ana süreç belleğinden; arayüz kimlik SÖYLEYEMEZ. GET olduğu için
 * plasiyerIstek() (POST'a sabit) kullanılmaz, plasiyer:get-orders ile aynı kalıp.
 */
ipcMain.handle('plasiyer:performans', async function () {
  if (!plasiyerOturumuGecerliMi()) {
    plasiyerOturumu = null;
    return { ok: false, durum: 401, hata: 'Oturum süresi doldu. Tekrar PIN ile giriş yapın.' };
  }

  const cevap = await apiIstek({
    alan: 'b2b',
    yol: '/plasiyer/performans',
    metod: 'GET',
    sorgu: {
      plasiyerId: plasiyerOturumu.id,     // arayüzden DEĞİL, oturumdan
      token: plasiyerOturumu.token
    }
  });

  if (!cevap || !cevap.ok || !cevap.veri) {
    if (cevap && 401 === cevap.durum) plasiyerOturumu = null;

    return { ok: false, durum: cevap ? cevap.durum : 0, hata: (cevap && cevap.hata) || 'Performans verisi alınamadı.' };
  }

  return { ok: true, veri: cevap.veri };
});

/**
 * TEK müşteriyi ANINDA eşitler (Faz 10) — çevrimiçiyken eklenen müşteri
 * sıradaki eşitleme turunu beklemez.
 *
 * Yerel kayıt sync motorunun beklediği biçimde işaretlenir (`senkron`,
 * `gercekId`): sıradaki tur köprüyü kurar (bekleyen siparişleri gerçek
 * kimliğe bağlar) ve temizlik kaydı düşürür. Yani bu yol, olağan eşitlemenin
 * ÖNE ALINMIŞ hâlidir; ikinci bir mekanizma değil.
 */
ipcMain.handle('musteri:esitle-tek', async function (olay, veri) {
  const id = String((veri && veri.id) || '');

  if (!id) return { ok: false, hata: 'Müşteri kimliği yok.' };

  if (!plasiyerOturumuGecerliMi()) {
    return { ok: false, durum: 401, hata: 'Oturum kapalı. PIN ile giriş yapın.' };
  }

  const a = ayarlariOku();
  const liste = Array.isArray(a.plasiyerYerelMusteriler) ? a.plasiyerYerelMusteriler : [];
  const m = liste.find(function (x) { return x && String(x.id) === id; });

  if (!m) return { ok: false, hata: 'Yerel müşteri kaydı bulunamadı.' };

  if (m.senkron && Number(m.gercekId)) {
    return { ok: true, user_id: Number(m.gercekId), tekrar: true };
  }

  const cevap = await plasiyerIstek('/plasiyer/musteri-esitle', {
    plasiyerId: plasiyerOturumu.id,
    token: plasiyerOturumu.token,
    gecici: m
  });

  const yeniId = Number((cevap && cevap.veri && cevap.veri.user_id) || 0);

  if (!cevap || !cevap.ok || !yeniId) {
    return { ok: false, durum: cevap ? cevap.durum : 0, hata: (cevap && cevap.hata) || 'Sunucu yanıt vermedi.' };
  }

  m.senkron = true;
  m.gercekId = yeniId;
  m.durum = syncMotor.GONDERILDI;
  m.hata = '';

  ayarlariYaz({ plasiyerYerelMusteriler: liste });

  return {
    ok: true,
    user_id: yeniId,
    tekrar: !!cevap.veri.tekrar,
    eslesme: String(cevap.veri.eslesme || '')
  };
});

/* ==========================================================================
 *  3.7) ÇEVRİMDIŞI KATALOG VE GÖRSEL ÖNBELLEĞİ (Plasiyer Faz 2)
 *  ---------------------------------------------------------------------------
 *  Plasiyer sahada internetsiz çalışır: katalog diske yazılır, görseller
 *  arka planda indirilir. İki modülün de ağ katmanı BURADAN enjekte edilir
 *  (apiIstek), böylece kendileri ağdan habersiz ve test edilebilir kalır.
 * ========================================================================*/

const katalogDepo = require('./src/main/byom-katalog-depo');
const gorselOnbellek = require('./src/main/byom-gorsel-onbellek');

/** Katalog eşitlemesi sürüyor mu? (ikinci tur başlatılmasın) */
let katalogEsitlemeSuruyor = false;

/**
 * Depoyu ve önbelleği açar.
 *
 * Görsel indirmesi bitince yerel yol DOĞRUDAN depoya yazılır; arayüzün
 * aradaki adımı bilmesi gerekmez.
 */
function katalogKur() {
  katalogDepo.kur({});

  gorselOnbellek.kur({
    bitti: function (id, yol) {
      if (id && yol) katalogDepo.gorselYoluYaz(id, yol);
    }
  });
}

/** WooCommerce ürün sayfasını çeken getirici (modüle enjekte edilir). */
function urunGetirici(sayfa) {
  return apiIstek({
    alan: 'woo',
    yol: '/products',
    metod: 'GET',
    sorgu: {
      per_page: 100,
      page: sayfa,
      status: 'publish',
      orderby: 'id',
      order: 'asc'
    },
    sureAsimi: 60000
  }).then(function (cevap) {
    if (!cevap || !cevap.ok) {
      return { ok: false, hata: (cevap && cevap.hata) || 'Ürünler alınamadı.' };
    }

    const gelen = Array.isArray(cevap.veri) ? cevap.veri : [];

    return { ok: true, urunler: gelen, devam: gelen.length >= 100 };
  });
}

/** Kataloğu sunucudan eşitler ve görsel kuyruğunu başlatır. */
ipcMain.handle('katalog:guncelle', async function (olay, veri) {
  veri = veri || {};

  if (katalogEsitlemeSuruyor) {
    return { ok: false, hata: 'Eşitleme zaten sürüyor.', durum: katalogDepo.durum() };
  }

  katalogEsitlemeSuruyor = true;

  try {
    const sonuc = await katalogDepo.kataloguGuncelle(urunGetirici);

    /* Eşitleme başarılıysa eksik görseller arka plana alınır. Bilinçli olarak
       BEKLENMEZ: plasiyer kataloğu hemen kullanmaya başlayabilir, görseller
       damla damla gelir. */
    if (sonuc.ok && false !== veri.gorsel) {
      gorselOnbellek.baslat(katalogDepo.gorselsizUrunler(1000));
    }

    return Object.assign({}, sonuc, { durum: katalogDepo.durum() });
  } finally {
    katalogEsitlemeSuruyor = false;
  }
});

/** Yerel katalogda arar — AĞA ÇIKMAZ. */
ipcMain.handle('katalog:ara', function (olay, veri) {
  veri = veri || {};

  return {
    ok: true,
    urunler: katalogDepo.ara(String(veri.sorgu || ''), {
      kategori: veri.kategori ? String(veri.kategori) : '',
      adet: Number(veri.adet) || 0,
      yalnizSpot: !!veri.yalnizSpot
    })
  };
});

ipcMain.handle('katalog:kategoriler', function () {
  return { ok: true, kategoriler: katalogDepo.kategoriler() };
});

ipcMain.handle('katalog:urun', function (olay, veri) {
  veri = veri || {};

  return { ok: true, urun: katalogDepo.urunGetir(veri.id) };
});

ipcMain.handle('katalog:barkod', function (olay, veri) {
  veri = veri || {};

  return { ok: true, urun: katalogDepo.barkodBul(veri.barkod) };
});

ipcMain.handle('katalog:durum', function () {
  return { ok: true, durum: katalogDepo.durum(), gorsel: gorselOnbellek.durum() };
});

/** Eksik görseller için indirmeyi elle tetikler. */
ipcMain.handle('gorsel:onbellege-al', function (olay, veri) {
  veri = veri || {};

  const eklenen = gorselOnbellek.baslat(
    Array.isArray(veri.isler) ? veri.isler : katalogDepo.gorselsizUrunler(Number(veri.adet) || 1000)
  );

  return { ok: true, eklenen: eklenen, durum: gorselOnbellek.durum() };
});

/**
 * Tek görselin arayüzde kullanılacak adresi.
 *
 * Diskte varsa `file://` yolu döner, yoksa uzak adres. Base64 DÖNMEZ:
 * binlerce görseli IPC üzerinden taşımak belleği gereksiz iki kez dolaşırdı.
 */
ipcMain.handle('gorsel:yol', function (olay, veri) {
  veri = veri || {};

  const urun = katalogDepo.urunGetir(veri.id);

  if (!urun) return { ok: false, adres: '' };

  if (urun.local_image_path) {
    return { ok: true, adres: 'file://' + String(urun.local_image_path).replace(/\\/g, '/'), yerel: true };
  }

  return { ok: true, adres: urun.image_url, yerel: false };
});

/* ==========================================================================
 *  3.8) ÇEVRİMDIŞI EŞİTLEME DAĞITICISI (Plasiyer Faz 3)
 *  ---------------------------------------------------------------------------
 *  Sahada yazılan siparişleri, çevrimdışı eklenen müşterileri ve ziyaret
 *  notlarını ağ geri geldiğinde merkeze iletir.
 *
 *  SIRA DEĞİŞTİRİLEMEZ: müşteri → kimlik köprüsü → sipariş → not.
 *  Sunucu geçici kimlikli siparişi 409 ile reddeder, yani sıra yanlışsa
 *  sessizce değil GÖRÜNÜR biçimde başarısız olur (bkz. plasiyer-sync-motor.js).
 *
 *  KUYRUK ayarlar.json'da durur:
 *    plasiyerYerelMusteriler · plasiyerSiparisKuyrugu · plasiyerZiyaretKuyrugu
 *  Diskte olması bilinçli: uygulama kapanırsa sahada yazılmış sipariş
 *  kaybolmaz. Jeton ise belleğe bağlıdır (bkz. bölüm 3.6) — oturum düşmüşse
 *  eşitleme "PIN gerekiyor" der, kuyruğa dokunmaz.
 * ========================================================================*/

const syncMotor = require('./src/renderer/plasiyer-sync-motor');

/** Eşitleme sürüyor mu? (ikinci tur başlatılmasın) */
let esitlemeSuruyor = false;

/** Son eşitleme özeti — arayüz `sync:durum` ile okur. */
let sonEsitleme = null;

/** Plasiyer uçlarına istek atan küçük yardımcı. */
function plasiyerIstek(yol, govde) {
  return apiIstek({ alan: 'b2b', yol: yol, metod: 'POST', govde: govde, sureAsimi: 45000 });
}

/**
 * Kuyruğu boşaltır.
 *
 * Arayüzü BEKLETMEZ: çağıran `await` etse bile tek turluk iştir ve kuyruk
 * boşsa anında döner. Ağ yoksa kayıtlar kuyrukta kalır, hiçbir şey silinmez.
 */
ipcMain.handle('sync:esitle', async function () {
  if (esitlemeSuruyor) {
    return { ok: false, hata: 'Eşitleme zaten sürüyor.', ozet: sonEsitleme };
  }

  if (!plasiyerOturumuGecerliMi()) {
    return { ok: false, durum: 401, hata: 'Oturum kapalı. PIN ile giriş yapın.' };
  }

  const ayarlar = ayarlariOku();

  const musteriler = Array.isArray(ayarlar.plasiyerYerelMusteriler) ? ayarlar.plasiyerYerelMusteriler : [];
  const siparisler = Array.isArray(ayarlar.plasiyerSiparisKuyrugu) ? ayarlar.plasiyerSiparisKuyrugu : [];
  const notlar = Array.isArray(ayarlar.plasiyerZiyaretKuyrugu) ? ayarlar.plasiyerZiyaretKuyrugu : [];

  /* Yapacak iş yoksa ağa hiç çıkılmaz. */
  if (!musteriler.length && !siparisler.length && !notlar.length) {
    return { ok: true, bosta: true, ozet: null };
  }

  esitlemeSuruyor = true;

  const plasiyerId = plasiyerOturumu.id;
  const jeton = plasiyerOturumu.token;

  try {
    const ozet = await syncMotor.esitle(
      { musteriler: musteriler, siparisler: siparisler, notlar: notlar },
      {
        musteri: function (gecici) {
          return plasiyerIstek('/plasiyer/musteri-esitle', {
            plasiyerId: plasiyerId,
            token: jeton,
            gecici: gecici
          });
        },
        siparis: function (kayit) {
          return plasiyerIstek('/plasiyer/siparis', Object.assign({}, kayit, {
            plasiyerId: plasiyerId,
            token: jeton,
            musteriId: String(kayit.musteriId)
          }));
        },
        not: function (not) {
          return plasiyerIstek('/plasiyer/ziyaret-notu', {
            plasiyerId: plasiyerId,
            token: jeton,
            musteriId: Number(not.musteriId) || 0,   // hâlâ geçiciyse 0 (bağ kurulamadı)
            il: String(not.il || ''),
            etiketler: Array.isArray(not.etiketler) ? not.etiketler : [],
            not: String(not.not || ''),
            gorsel: String(not.gorsel || ''),
            yerelKimlik: String(not.yerelKimlik || '')
          });
        }
      }
    );

    /* Gönderilenler düşer; KALICI HATALI KAYITLAR KALIR (kullanıcı görsün). */
    ayarlariYaz({
      plasiyerYerelMusteriler: syncMotor.esitlenenMusterileriTemizle(musteriler),
      plasiyerSiparisKuyrugu: syncMotor.gonderilenleriTemizle(siparisler),
      plasiyerZiyaretKuyrugu: syncMotor.gonderilenleriTemizle(notlar)
    });

    sonEsitleme = Object.assign({ zaman: new Date().toISOString() }, ozet);

    return { ok: true, ozet: sonEsitleme, mesaj: syncMotor.ozetMesaji(ozet) };
  } finally {
    esitlemeSuruyor = false;
  }
});

/** Kuyruk künyesi — arayüzdeki "bekleyen" göstergesi. */
ipcMain.handle('sync:durum', function () {
  const a = ayarlariOku();

  const say = function (liste) {
    return Array.isArray(liste) ? liste.length : 0;
  };

  const hatali = function (liste) {
    return Array.isArray(liste)
      ? liste.filter(function (k) { return k && syncMotor.KALICI_HATA === k.durum; }).length
      : 0;
  };

  return {
    ok: true,
    suruyor: esitlemeSuruyor,
    musteri: say(a.plasiyerYerelMusteriler),
    siparis: say(a.plasiyerSiparisKuyrugu),
    not: say(a.plasiyerZiyaretKuyrugu),
    hatali: hatali(a.plasiyerSiparisKuyrugu) + hatali(a.plasiyerZiyaretKuyrugu) + hatali(a.plasiyerYerelMusteriler),
    son: sonEsitleme
  };
});

/**
 * Siparişi yerel kuyruğa yazar (çevrimdışı yol) — Faz 9.
 *
 * Eskiden renderer `ayar:oku → push → ayar:yaz` yapıyordu. Aynı anda
 * `sync:esitle` kuyruğu temizlemişse renderer'ın eski fotoğrafı gönderilmiş
 * siparişi "bekliyor" olarak DİRİLTİYORDU (ikinci kez açılırdı). Ekleme ana
 * süreçte, tek yerde, okunduğu anda yazılır.
 */
ipcMain.handle('siparis:kuyruga', function (olay, govde) {
  if (!govde || !Array.isArray(govde.kalemler) || !govde.kalemler.length) {
    return { ok: false, hata: 'Sipariş gövdesi boş.' };
  }

  const a = ayarlariOku();
  const kuyruk = Array.isArray(a.plasiyerSiparisKuyrugu) ? a.plasiyerSiparisKuyrugu : [];

  /* yerelKimlik motorda üretilir; eksikse burada tamamlanır — sunucunun çift
     gönderim koruması bu kimliğe bakar. */
  if (!govde.yerelKimlik) {
    govde.yerelKimlik = 'sip-' + Date.now() + '-' + Math.round(Math.random() * 99999);
  }

  kuyruk.push({ kayit: govde, zaman: new Date().toISOString(), durum: 'bekliyor' });

  ayarlariYaz({ plasiyerSiparisKuyrugu: kuyruk });

  return { ok: true, bekleyen: kuyruk.length, yerelKimlik: String(govde.yerelKimlik) };
});

/** Çevrimdışı müşteriyi yerel listeye ekler (tekil ekleme, aynı gerekçe). */
ipcMain.handle('musteri:kuyruga', function (olay, musteri) {
  if (!musteri || !musteri.id || !musteri.unvan) {
    return { ok: false, hata: 'Müşteri kaydı eksik.' };
  }

  const a = ayarlariOku();
  const liste = Array.isArray(a.plasiyerYerelMusteriler) ? a.plasiyerYerelMusteriler : [];

  /* Aynı geçici kimlik iki kez eklenmez. */
  if (liste.some(function (m) { return m && String(m.id) === String(musteri.id); })) {
    return { ok: true, bekleyen: liste.length, tekrar: true };
  }

  liste.unshift(musteri);

  ayarlariYaz({ plasiyerYerelMusteriler: liste });

  return { ok: true, bekleyen: liste.length };
});

/**
 * ÇEVRİMDIŞI müşteriyi yerel listeden SİLER (Faz 11).
 *
 * Yalnızca sunucuya hiç gitmemiş (temp_musteri_… ve senkron değil) kayıt
 * silinebilir: gerçek bayi sunucuda yaşar, burada silmek yalnızca önbelleği
 * bozar. Kayda BAĞLI bekleyen sipariş/not varsa silme REDDEDİLİR — sync
 * motoru geçici kimliği köprüleyemez, sipariş sonsuza dek "bekliyor" kalır
 * ("Müşteri henüz eşitlenmedi", plasiyer-sync-motor.js). Mutasyon ana süreçte:
 * renderer oku-değiştir-yaz yapsaydı eşitleme turuyla yarışırdı (§3.8).
 */
ipcMain.handle('musteri:kuyruktan-sil', function (olay, veri) {
  const id = String((veri && veri.id) || '');

  if (!id) return { ok: false, hata: 'Müşteri kimliği yok.' };

  if (0 !== id.indexOf(syncMotor.GECICI_ONEK)) {
    return { ok: false, hata: 'Yalnızca çevrimdışı (henüz eşitlenmemiş) müşteri silinebilir.' };
  }

  const a = ayarlariOku();
  const liste = Array.isArray(a.plasiyerYerelMusteriler) ? a.plasiyerYerelMusteriler : [];
  const m = liste.find(function (x) { return x && String(x.id) === id; });

  if (!m) return { ok: false, durum: 404, hata: 'Kayıt bulunamadı (zaten silinmiş olabilir).' };

  if (m.senkron) {
    return { ok: false, hata: 'Bu müşteri sunucuya eşitlenmiş; artık cihazdan silinemez.' };
  }

  const siparisler = Array.isArray(a.plasiyerSiparisKuyrugu) ? a.plasiyerSiparisKuyrugu : [];
  const notlar = Array.isArray(a.plasiyerZiyaretKuyrugu) ? a.plasiyerZiyaretKuyrugu : [];

  const bekleyenSiparis = siparisler.filter(function (satir) {
    return satir && syncMotor.GONDERILDI !== satir.durum && satir.kayit && String(satir.kayit.musteriId) === id;
  }).length;
  const bekleyenNot = notlar.filter(function (n) { return n && String(n.musteriId) === id; }).length;

  if (bekleyenSiparis || bekleyenNot) {
    return {
      ok: false,
      hata: 'Bu müşterinin bekleyen ' +
        [bekleyenSiparis ? bekleyenSiparis + ' siparişi' : '', bekleyenNot ? bekleyenNot + ' notu' : ''].filter(Boolean).join(' ve ') +
        ' var; önce eşitleyin ya da o kayıtları silin.',
      siparis: bekleyenSiparis,
      not: bekleyenNot
    };
  }

  const kalan = liste.filter(function (x) { return !x || String(x.id) !== id; });

  ayarlariYaz({ plasiyerYerelMusteriler: kalan });

  return { ok: true, bekleyen: kalan.length };
});

/** Ziyaret notunu yerel kuyruğa yazar (çevrimdışı yol). */
ipcMain.handle('ziyaret:kuyruga', function (olay, veri) {
  veri = veri || {};

  const a = ayarlariOku();
  const kuyruk = Array.isArray(a.plasiyerZiyaretKuyrugu) ? a.plasiyerZiyaretKuyrugu : [];

  kuyruk.push({
    durum: 'bekliyor',
    zaman: new Date().toISOString(),
    yerelKimlik: String(veri.yerelKimlik || ('not-' + Date.now() + '-' + Math.round(Math.random() * 99999))),
    /* Çevrimdışı müşterinin notu temp_musteri_<uuid> metniyle bekler; eşitleme
       köprüsü (syncMotor.notKoprusuKur) onu gerçek kimliğe çevirir (Faz 9). */
    musteriId: ('string' === typeof veri.musteriId && 0 === veri.musteriId.indexOf(syncMotor.GECICI_ONEK))
      ? veri.musteriId
      : (Number(veri.musteriId) || 0),
    il: String(veri.il || ''),
    etiketler: Array.isArray(veri.etiketler) ? veri.etiketler : [],
    not: String(veri.not || ''),
    gorsel: String(veri.gorsel || '')
  });

  ayarlariYaz({ plasiyerZiyaretKuyrugu: kuyruk });

  return { ok: true, bekleyen: kuyruk.length };
});

/* ==========================================================================
 *  3.9) YÖNETİCİ MASTER PIN VE CİHAZ KİLİDİ (SAHA TERMİNALİ MODU)
 *  ---------------------------------------------------------------------------
 *  Amaç: sahaya verilen laptopta plasiyerin yönetici ekranına geçememesi.
 *
 *  İki ayrı kontrol:
 *    · MASTER PIN (6 hane) — "Yönetici Girişi" kapısını açar.
 *    · CİHAZ ROLÜ — cihaz bir plasiyere tahsis edilirse yönetici kapısı
 *      arayüzden tamamen kalkar; geri dönüş yalnızca Master PIN ile.
 *
 *  NEDEN DOĞRULAMA BURADA: arayüzde `nodeIntegration: true`; orada yazılacak
 *  her karşılaştırma aynı konsoldan atlatılabilir. Bu kanallar arayüze
 *  yalnızca "oldu / olmadı" döner; özet hiç gitmez.
 *
 *  Hash'leme, kaba kuvvet sayacı ve rol geçişleri `byom-yonetici-kilit.js`
 *  içindedir (DOM'suz, test edilebilir). Burada yapılan tek şey: motoru
 *  ayar dosyasına bağlamak.
 *
 *  ⚠️ DÜRÜST SINIR: `ayarlar.json` düz metin bir dosyadır. Bu kilit, cihazı
 *  eline alan plasiyerin ARAYÜZDEN yönetici ekranına geçmesini engeller;
 *  dosya sistemine erişip dosyayı elle düzenleyen birine karşı mutlak
 *  değildir. Ayrıntılı gerekçe: byom-yonetici-kilit.js dosya başlığı.
 * ========================================================================*/

/** Motorun `yazilacak` çıktısını diske uygular ve yeni durumu döndürür. */
function kilitSonucunuUygula(sonuc) {
  if (sonuc && sonuc.yazilacak) ayarlariYaz(sonuc.yazilacak);

  const d = yoneticiKilit.durum(ayarlariOku());

  /* Yanıtta `yazilacak` ARAYÜZE GÖNDERİLMEZ: içinde PIN özeti olabilir. */
  return {
    ok: !!(sonuc && sonuc.ok),
    hata: (sonuc && sonuc.hata) || '',
    kilitli: !!(sonuc && sonuc.kilitli),
    kilitKalanSn: (sonuc && sonuc.kilitKalanSn) || d.kilitKalanSn,
    kalanDeneme: undefined === (sonuc && sonuc.kalanDeneme) ? d.kalanDeneme : sonuc.kalanDeneme,
    durum: d
  };
}

/** Kapı açılışında sorulur: PIN kurulu mu, cihaz kilitli mi, kilit var mı? */
ipcMain.handle('auth:yonetici-pin-durum', function () {
  return { ok: true, durum: yoneticiKilit.durum(ayarlariOku()) };
});

/** İlk kurulum — PIN yoksa belirler. PIN VARSA motor reddeder. */
ipcMain.handle('auth:yonetici-pin-kur', function (olay, veri) {
  veri = veri || {};

  const sonuc = yoneticiKilit.pinKur(String(veri.pin || ''), ayarlariOku());

  /* PIN referansı bırakılmaz; nesne çöpe gider (bkz. bölüm 3.6 kural 1).
     FAZ 8: PIN artık hiçbir yere GÖNDERİLMİYOR — kurtarma, merkezin tek
     kullanımlık SIFIRLAMA kodu ile yapılıyor (bkz. auth:pin-kurtarma-*). */
  veri.pin = '';

  return kilitSonucunuUygula(sonuc);
});

/** Yönetici kapısı doğrulaması — 3 hatalı denemede 60 sn kilit. */
ipcMain.handle('auth:yonetici-pin-dogrula', function (olay, veri) {
  veri = veri || {};

  const sonuc = yoneticiKilit.pinDene(String(veri.pin || ''), ayarlariOku());

  veri.pin = '';

  return kilitSonucunuUygula(sonuc);
});

/** PIN değiştirme — eski PIN doğrulanmadan yenisi yazılmaz. */
ipcMain.handle('auth:yonetici-pin-degistir', function (olay, veri) {
  veri = veri || {};

  const sonuc = yoneticiKilit.pinDegistir(
    String(veri.eski || ''),
    String(veri.yeni || ''),
    ayarlariOku()
  );

  veri.eski = '';
  veri.yeni = '';

  return kilitSonucunuUygula(sonuc);
});

/* ------------------------------------------------------------------ *
 *  PIN KURTARMA (SIFIRLAMA) — tek kullanımlık kod akışı
 *  ---------------------------------------------------------------
 *  Düz metin PIN HİÇBİR YERE GÖNDERİLMEZ. Merkez yalnızca SIFIRLAMA
 *  yetkisi verir; PIN'i öğrenmez. Protokol: src/main/byom.js →
 *  "SIFIRLAMA (OTP / CHALLENGE) PROTOKOLÜ" başlığı.
 * ------------------------------------------------------------------ */

/**
 * Talep kodunu üretir ve merkeze bildirmeyi dener.
 *
 * Bildirim BAŞARISIZ OLSA DA talep kodu döner: patron onu telefonda okur,
 * merkez lisans kaydından aynı kodu yeniden hesaplar. Akışı internete
 * bağımlı kılmamak bilinçli.
 */
ipcMain.handle('auth:pin-kurtarma-talep', async function () {
  const sonuc = await byom.pinSifirlamaTalebi();

  return {
    ok: !!sonuc.talepKodu,
    talepKodu: sonuc.talepKodu || '',
    /* Merkez kaydı aldı mı? Arayüz buna göre "merkeze iletildi" ya da
       "kodu telefonda okuyun" der — kullanıcı ne yapacağını bilsin. */
    bildirildi: !!sonuc.bildirildi,
    durum: yoneticiKilit.durum(ayarlariOku())
  };
});

/**
 * Merkezin verdiği kodu doğrular; geçerliyse PIN'i SİLER.
 *
 * SIRA: yerel eleme (biçim + kilit) → hub → yerel yazma. Hub'a yalnızca
 * biçimi geçerli ve kilitsiz bir deneme gider; hatalı kod yerel sayacı
 * ilerletir ki merkez gereksiz yere dövülmesin.
 */
ipcMain.handle('auth:pin-kurtarma-dogrula', async function (olay, veri) {
  veri = veri || {};

  const hazir = yoneticiKilit.kurtarmaDenemesiHazirla(String(veri.kod || ''), ayarlariOku());

  if (!hazir.ok) return kilitSonucunuUygula(hazir);

  const cevap = await byom.pinSifirlamaDogrula(hazir.kod);

  veri.kod = '';

  if (!cevap.ok) {
    /*
     * AĞ HATASI SAYAÇ İLERLETMEZ. "Ulaşamadım" ile "kod yanlış" farklı
     * şeylerdir; internet kesikken kullanıcıyı 15 dakika kilitlemek,
     * onun hiç yapmadığı bir hatayı cezalandırmak olurdu.
     */
    if (cevap.agSorunu) {
      return { ok: false, agSorunu: true, hata: cevap.hata, durum: yoneticiKilit.durum(ayarlariOku()) };
    }

    const basarisiz = yoneticiKilit.kurtarmaBasarisiz(ayarlariOku());

    if (basarisiz.yazilacak) ayarlariYaz(basarisiz.yazilacak);

    return {
      ok: false,
      kilitli: !!basarisiz.kilitli,
      kilitKalanSn: basarisiz.kilitKalanSn || 0,
      kalanDeneme: basarisiz.kalanDeneme,
      hata: cevap.hata,
      durum: yoneticiKilit.durum(ayarlariOku())
    };
  }

  /* Merkez onayladı: PIN silinir, sayaçlar sıfırlanır, CİHAZ KİLİDİ DE KALKAR
     (değişmez kural: kilitli cihaz ⇒ tanımlı PIN vardır) ve olay damgalanır. */
  const sifirla = yoneticiKilit.pinSifirla(ayarlariOku());

  /* Açık plasiyer oturumu da düşer: cihazın tahsisi kalktı. */
  plasiyerOturumu = null;

  return kilitSonucunuUygula(sifirla);
});

/** Cihaz durumu — açılışta kapının hangi biçimde çizileceğini söyler. */
ipcMain.handle('cihaz:durum', function () {
  return { ok: true, durum: yoneticiKilit.durum(ayarlariOku()) };
});

/**
 * Cihazı plasiyere tahsis eder (saha terminali modu).
 *
 * Master PIN tanımlı değilse motor REDDEDER: kilidi açmanın tek yolu o PIN,
 * PIN'siz kilitlemek cihazı geri dönüşsüz kilitlerdi.
 */
ipcMain.handle('cihaz:kilitle', function (olay, veri) {
  veri = veri || {};

  return kilitSonucunuUygula(
    yoneticiKilit.cihazKilitle({ id: veri.id, ad: veri.ad }, ayarlariOku())
  );
});

/**
 * Cihaz kilidini Master PIN ile açar.
 *
 * Kaba kuvvet sayacı burada da işler — kilit açma ekranı sayaçsız bir arka
 * kapı olmamalı.
 */
ipcMain.handle('cihaz:ac', function (olay, veri) {
  veri = veri || {};

  const sonuc = yoneticiKilit.cihazAc(String(veri.pin || ''), ayarlariOku());

  veri.pin = '';

  /* Kilit açıldıysa plasiyer oturumu da düşürülür: cihaz artık bu kişiye
     tahsisli değil, açık kalan jetonla veri çekmeye devam etmemeli. */
  if (sonuc.ok) plasiyerOturumu = null;

  return kilitSonucunuUygula(sonuc);
});

/* ==========================================================================
 *  4) ANA PENCERE VE UYGULAMA YAŞAM DÖNGÜSÜ
 * ========================================================================*/

/**
 * Pencereyi kesin olarak ekrana getirir.
 * (Birden fazla yerden çağrılabilir; tekrar çağrılması zararsızdır.)
 */
function pencereyiKesinGoster(pencere, buyut) {
  if (!pencere || pencere.isDestroyed()) return;
  try {
    if (pencere.isMinimized()) pencere.restore();
    if (!pencere.isVisible()) pencere.show();
    if (buyut && !pencere.isMaximized()) pencere.maximize();
    pencere.focus();
    pencere.moveTop();
  } catch (e) {
    console.error('Pencere gösterilemedi:', e);
  }
}

function anaPencereyiOlustur() {
  /* Aşağıdaki seçenek listesi WINDOWS İÇİN DEĞİŞMEDİ. macOS'te üstüne
     yalnızca başlık çubuğu ayarları eklenir (bkz. macAnaPencereSecenekleri). */
  anaPencere = new BrowserWindow(Object.assign({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'B2B Yönetim Paneli',
    backgroundColor: '#f1f5f9',
    autoHideMenuBar: true,
    // ÖNEMLİ: show:false + 'ready-to-show' KULLANILMIYOR.
    // Bu pencere ayarlarıyla (autoHideMenuBar / minWidth-minHeight) bazı Windows
    // makinelerinde 'ready-to-show' olayı hiç tetiklenmiyor; pencere yüklenip
    // hazır olduğu hâlde ekrana hiç gelmiyor, uygulama yalnızca Görev
    // Yöneticisi'nde görünüyordu. Pencere doğrudan görünür açılıyor;
    // backgroundColor sayesinde beyaz parlama da olmuyor.
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false
    }
  }, macAnaPencereSecenekleri()));

  // Ekrana getirme birden çok yola bağlandı; biri çalışmazsa diğeri yakalar.
  pencereyiKesinGoster(anaPencere, true);
  anaPencere.once('ready-to-show', function () {
    pencereyiKesinGoster(anaPencere, true);
  });
  anaPencere.webContents.once('did-finish-load', function () {
    pencereyiKesinGoster(anaPencere, true);
    // Arayüz hazır: BYOM'un beklettiği lisans bildirimleri şimdi iletilebilir.
    byom.anaPencereHazir();
    // Açılışta yakalanan güncelleme bildirimi arayüz hazır olunca gösterilir (bkz. bölüm 3.5).
    bekleyenGuncellemeBildiriminiGonder();
  });
  // Son emniyet kemeri: yukarıdakilerin hiçbiri çalışmazsa 3 saniye sonra göster.
  setTimeout(function () {
    pencereyiKesinGoster(anaPencere, true);
  }, 3000);

  /* ---- AÇILIŞ HATALARINI YAKALA ---- */

  // index.html hiç yüklenemezse sessizce boş pencerede kalmasın, sebebini söylesin.
  anaPencere.webContents.on('did-fail-load', function (olay, kod, aciklama, url, anaCerceve) {
    if (!anaCerceve || kod === -3) return; // -3 = kullanıcı iptali, önemsiz
    console.error('Sayfa yüklenemedi:', kod, aciklama, url);
    pencereyiKesinGoster(anaPencere, true);
    dialog.showErrorBox(
      'Uygulama açılamadı',
      'Arayüz dosyası yüklenemedi.\n\nHata: ' + aciklama + ' (' + kod + ')\nDosya: ' + url
    );
  });

  // Arayüz süreci çökerse kullanıcı sebebini görsün.
  anaPencere.webContents.on('render-process-gone', function (olay, ayrinti) {
    console.error('Arayüz süreci sonlandı:', ayrinti);
    dialog.showErrorBox(
      'Arayüz beklenmedik şekilde kapandı',
      'Sebep: ' + (ayrinti && ayrinti.reason) + '\nUygulamayı yeniden başlatın.'
    );
  });

  // Arayüzdeki JS hataları/uyarıları ana süreç konsoluna da düşsün (npm start çıktısı).
  anaPencere.webContents.on('console-message', function (ayrinti) {
    if (ayrinti && ayrinti.level === 'error') {
      console.error('[arayüz] ' + ayrinti.message + '  (' + ayrinti.sourceId + ':' + ayrinti.lineNumber + ')');
    }
  });

  /*
   * VİTRİN EDİTÖRÜ ÖNİZLEME ÇERÇEVESİ
   * ----------------------------------
   * Mağaza sahibi KENDİ sitesini editörün iframe'i içinde görür. WordPress
   * barındırıcıları çoğunlukla "X-Frame-Options: SAMEORIGIN" (ya da CSP
   * frame-ancestors) ekler; bu başlık bizim file:// kökenli pencereyi
   * engeller ve önizleme boş kalırdı. Başlık YALNIZCA alt çerçevede (subFrame)
   * ve YALNIZCA byom_preview=1 taşıyan adreslerde düşürülür; başka hiçbir
   * istek etkilenmez.
   */
  try {
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, function (ayrinti, geriCagir) {
      var basliklar = ayrinti.responseHeaders || {};
      if (ayrinti.resourceType === 'subFrame' && /[?&]byom_preview=1/.test(String(ayrinti.url || ''))) {
        Object.keys(basliklar).forEach(function (ad) {
          var kucuk = ad.toLowerCase();
          if (kucuk === 'x-frame-options') {
            delete basliklar[ad];
          } else if (kucuk === 'content-security-policy' || kucuk === 'content-security-policy-report-only') {
            basliklar[ad] = [].concat(basliklar[ad]).map(function (deger) {
              return String(deger).split(';').filter(function (parca) {
                return !/^\s*frame-ancestors\b/i.test(parca);
              }).join(';');
            });
          }
        });
      }
      geriCagir({ responseHeaders: basliklar });
    });
  } catch (e) {
    console.warn('Önizleme başlık filtresi kurulamadı:', e && e.message);
  }

  anaPencere.loadFile(path.join(__dirname, 'index.html')).catch(function (e) {
    console.error('loadFile başarısız:', e);
    pencereyiKesinGoster(anaPencere, true);
    dialog.showErrorBox('Uygulama açılamadı', 'index.html yüklenemedi:\n' + e.message);
  });

  // F12 → Geliştirici araçları (destek verirken lazım olur)
  // macOS'te F12 klavyede çoğu zaman sistem işlevine bağlı; orada ayrıca
  // sistemin alışıldık kısayolu olan ⌘⌥I de kabul edilir.
  anaPencere.webContents.on('before-input-event', function (olay, girdi) {
    if (girdi.type !== 'keyDown') return;

    const macKisayolu = isMac && girdi.meta && girdi.alt &&
                        String(girdi.key).toLowerCase() === 'i';

    if (girdi.key === 'F12' || macKisayolu) {
      anaPencere.webContents.toggleDevTools();
      olay.preventDefault();
    }
  });

  /*
   * Ana pencere YALNIZCA kendi index.html'inde kalır. Vitrin Editörü'nün
   * önizleme iframe'i uzak site içeriği taşır; o içeriğin top.location ile
   * node-entegre pencereyi başka bir adrese yönlendirmesi engellenir
   * (iframe sandbox'ına ek, ikinci emniyet kemeri).
   */
  anaPencere.webContents.on('will-navigate', function (olay, url) {
    if (!/^file:/i.test(String(url))) {
      olay.preventDefault();
      if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
    }
  });

  // Dış bağlantılar uygulama içinde değil, varsayılan tarayıcıda açılsın
  anaPencere.webContents.setWindowOpenHandler(function (detay) {
    if (/^https?:\/\//i.test(detay.url)) shell.openExternal(detay.url);
    return { action: 'deny' };
  });

  anaPencere.on('closed', function () {
    anaPencere = null;
  });
}

/* ==========================================================================
 *  YAKALANMAMIŞ HATALAR
 *  ---------------------------------------------------------------------------
 *  Kancaların DAVRANIŞI DEĞİŞMEDİ: hata diyaloğu aynı yerde, günlük satırları
 *  aynı, uygulamanın ayakta kalma biçimi aynı. Eklenen tek şey `telemetri.bildir`
 *  satırlarıdır ve bunlar:
 *    · diyalogdan ÖNCE çağrılır — çünkü `showErrorBox` ana süreci senkron
 *      kilitler; kayıt o kilide girmeden diske yazılmış olur,
 *    · `await` edilmez, throw etmez, dönüş değeri okunmaz.
 * ========================================================================*/

// Ana süreçte yakalanmamış bir hata olursa uygulama sessizce arka planda takılmasın.
process.on('uncaughtException', function (e) {
  telemetri.bildir('uncaughtException', e, 'panel-main');
  console.error('Ana süreçte yakalanmamış hata:', e);
  try {
    dialog.showErrorBox('Beklenmeyen hata', String((e && e.stack) || e));
  } catch (e2) { /* dialog hazır değilse yapacak bir şey yok */ }
});
process.on('unhandledRejection', function (e) {
  telemetri.bildir('unhandledRejection', e, 'panel-main');
  console.error('Ana süreçte karşılanmamış promise reddi:', e);
});

/* Arayüz süreci çökerse (beyaz ekran) kullanıcı genelde hiçbir hata görmez;
   tek iz budur. Gözlemcidir: pencereye ya da akışa dokunmaz. */
app.on('render-process-gone', function (olay, icerik, ayrinti) {
  telemetri.bildir('render-process-gone', {
    mesaj: 'Arayüz süreci sonlandı: sebep=' + ((ayrinti && ayrinti.reason) || 'bilinmiyor') +
           ' cikisKodu=' + ((ayrinti && ayrinti.exitCode) === undefined ? '?' : ayrinti.exitCode)
  }, 'panel-main');
});

// Aynı uygulamanın ikinci kopyası açılmasın
const tekKopyaKilidi = app.requestSingleInstanceLock();
if (!tekKopyaKilidi) {
  // Not: Görev Yöneticisi'nde takılı kalmış eski bir kopya varsa yeni açılış
  // burada durur. Bu satır sebebi konsolda görünür kılar.
  gunluk('Uygulama zaten çalışıyor; bu kopya kapatılıyor.');
  app.quit();
} else {
  app.on('second-instance', function () {
    // İkinci kez çalıştırılınca yeni pencere değil, mevcut pencere öne gelsin.
    if (anaPencere && !anaPencere.isDestroyed()) {
      pencereyiKesinGoster(anaPencere, false);
    } else if (!byom.odakla()) {
      // Ne ana pencere ne lisans penceresi var: akışı baştan başlat.
      byom.baslat({ anaPencereyiAc: anaPencereyiOlustur, anaPencereyiGetir: function () { return anaPencere; } });
    }
  });

  app.whenReady().then(function () {
    if (isWindows) {
      app.setAppUserModelId('com.byomtech.b2b');
    }

    /* Windows/Linux: sade görünüm — üst menü çubuğu olmasın (DEĞİŞMEDİ).
       macOS: menü kaldırılırsa ⌘C/⌘V/⌘Q çalışmaz; en küçük standart menü
       kurulur (bkz. macMenusunuKur). */
    if (isMac) macMenusunuKur();
    else Menu.setApplicationMenu(null);
    sertifikaDenetiminiGevset();   // SSL katılığı: bkz. bölüm 0
    otomatikGuncellemeyiBaslat(); // Sessiz güncelleme: açılışta + 30 dk.da bir (bkz. bölüm 3.5)

    /* Çevrimdışı katalog deposu ve görsel önbelleği (bölüm 3.7).
       Yalnızca dizin açar ve diskteki kataloğu belleğe alır — AĞA ÇIKMAZ.
       Eşitleme kararını arayüz verir (katalog:guncelle). */
    katalogKur();

    /* ---- BYOM BRAIN AÇILIŞ KONTROLÜ ----
       Ana pencere doğrudan açılmaz. Önce lisans penceresi (splash) gelir,
       donanım kimliği üretilir ve lisans BYOM Brain'de doğrulanır. Sonuç
       olumluysa aşağıdaki anaPencereyiOlustur geri çağrısı çalıştırılır. */
    byom.baslat({
      anaPencereyiAc: anaPencereyiOlustur,
      anaPencereyiGetir: function () { return anaPencere; }
    });

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        // Lisans hâlâ geçerliyse doğrudan ana pencere, değilse lisans akışı.
        if (byom.acilisTamamMi()) anaPencereyiOlustur();
        else byom.baslat({ anaPencereyiAc: anaPencereyiOlustur, anaPencereyiGetir: function () { return anaPencere; } });
      }
    });
  }).catch(function (e) {
    // whenReady içinde hata olursa uygulama penceresiz şekilde arka planda kalırdı.
    console.error('Açılış sırasında hata:', e);
    dialog.showErrorBox('Uygulama başlatılamadı', String((e && e.stack) || e));
    app.quit();
  });

  /* macOS'te son pencere kapanınca uygulama çalışmaya devam eder (sistem
     alışkanlığı); Dock simgesine tıklanınca 'activate' yeniden açar.
     Windows'taki davranış aynen korunur: son pencere = çıkış. */
  app.on('window-all-closed', function () {
    if (!isMac) app.quit();
  });
}
