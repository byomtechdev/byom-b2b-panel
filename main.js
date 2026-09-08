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

ipcMain.handle('ayar:oku', () => ayarlariOku());
ipcMain.handle('ayar:yaz', (olay, yeni) => ayarlariYaz(yeni));

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
  let taban = String(ham || '').replace(/\s+/g, '');
  taban = taban.replace(/\/wp-json.*$/i, '');
  taban = taban.replace(/\/+$/, '');
  if (!taban) return '';
  if (!/^https?:\/\//i.test(taban)) taban = 'https://' + taban;
  return taban;
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

  let url;
  try {
    url = new URL(taban + '/wp-json/' + alan + '/' + String(istek.yol || '').replace(/^\/+/, ''));
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

      // b2b-core eklentisi kurulu/etkin değilse bu uç hiç kayıtlı olmaz
      if (kod === 'rest_no_route' && alan === API_ALANLARI.b2b) {
        return {
          ok: false,
          durum: yanit.status,
          kod: kod,
          eklentiYok: true,
          hata: 'Sitenizde "B2B Core" eklentisi bulunamadı veya etkin değil.\n' +
                'WordPress yönetim panelinden eklentiyi etkinleştirin.\n' +
                '(Aranan adres: /wp-json/' + alan + '/' + String(istek.yol || '') + ')'
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
  console.log('[Güncelleme] Yeni sürüm bulundu: ' + surum + ' — indiriliyor…');
  guncellemeDurumunuBildir(
    'bulundu',
    'Yeni güncelleme bulundu (' + surum + ').\nArka planda indiriliyor, çalışmaya devam edebilirsiniz.',
    bilgi
  );
});

autoUpdater.on('update-not-available', function () {
  console.log('[Güncelleme] Uygulama güncel.');
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
    console.log('[Güncelleme] Geliştirme ortamında atlandı (yalnızca paketlenmiş sürümde çalışır).');
    return;
  }
  if (guncellemeZamanlayicisi) return; // zaten kurulu

  setTimeout(guncellemeyiKontrolEt, GUNCELLEME_ILK_GECIKME_MS);

  guncellemeZamanlayicisi = setInterval(guncellemeyiKontrolEt, GUNCELLEME_TUR_ARALIGI_MS);
  // Zamanlayıcı yüzünden uygulama kapanışta beklemesin.
  if (typeof guncellemeZamanlayicisi.unref === 'function') guncellemeZamanlayicisi.unref();
}

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

// Ana süreçte yakalanmamış bir hata olursa uygulama sessizce arka planda takılmasın.
process.on('uncaughtException', function (e) {
  console.error('Ana süreçte yakalanmamış hata:', e);
  try {
    dialog.showErrorBox('Beklenmeyen hata', String((e && e.stack) || e));
  } catch (e2) { /* dialog hazır değilse yapacak bir şey yok */ }
});
process.on('unhandledRejection', function (e) {
  console.error('Ana süreçte karşılanmamış promise reddi:', e);
});

// Aynı uygulamanın ikinci kopyası açılmasın
const tekKopyaKilidi = app.requestSingleInstanceLock();
if (!tekKopyaKilidi) {
  // Not: Görev Yöneticisi'nde takılı kalmış eski bir kopya varsa yeni açılış
  // burada durur. Bu satır sebebi konsolda görünür kılar.
  console.log('Uygulama zaten çalışıyor; bu kopya kapatılıyor.');
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
