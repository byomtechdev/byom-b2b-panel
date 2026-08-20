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

let anaPencere = null;

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
    firmaAdi: 'Örnek Hırdavat ve Yapı Market A.Ş.',
    demoModu: true, // İLK AÇILIŞTA DEMO AKTİF — sunum için hazır gelsin
    wooUrl: '',
    ck: '',
    cs: '',
    // Bağlantı doğrulandıktan sonra Site Adresi / Consumer Key / Secret kutuları
    // kilitlenir (salt okunur + maskeli). Kullanıcı ya da bayi sahibi çalışan bir
    // bağlantıyı yanlışlıkla bozmasın diye. Kilit "🔓 KİLİDİ AÇ" ile kaldırılır.
    apiKilitli: false,
    // Bağlantı kurulduğunda sitenin b2b-core theme-config'inden çekilen logo
    // adresi (bkz. siteLogosunuGetir). Sitede/eklentide logo yoksa boş kalır.
    siteLogosu: '',
    // Site logosu yoksa/çekilemezse Ayarlar sekmesinden yüklenen yerel logo
    // (data:image/... base64) — bkz. yerelLogoYukle.
    yerelLogo: '',
    lisansBitis: bitis.toISOString().slice(0, 10),
    tema: 'acik',
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
  b2b: 'wc-b2b/v1'     // b2b-core eklentisi
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
    return { ok: false, durum: 0, hata: 'Site adresi girilmemiş.\n⚙️ Ayarlar sekmesinden WooCommerce site adresini yazın.' };
  }
  if (!ck || !cs) {
    return { ok: false, durum: 0, hata: 'Consumer Key ve Consumer Secret girilmemiş.\n⚙️ Ayarlar sekmesinden anahtarları yapıştırın.' };
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
    return { ok: false, durum: 0, hata: agHatasiTurkce(e) };
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

/** Kullanıcı "Daha Sonra" demedikçe aynı indirme için diyalog tekrar açılmasın. */
let guncellemeDiyaloguGosterildi = false;

autoUpdater.on('update-available', function (bilgi) {
  console.log('[Güncelleme] Yeni sürüm bulundu: ' + ((bilgi && bilgi.version) || '?') + ' — indiriliyor…');
});

/** İndirme tamamlanınca kullanıcıya sorar; onaylarsa uygulamayı kapatıp kurulumu başlatır. */
autoUpdater.on('update-downloaded', async function (bilgi) {
  if (guncellemeDiyaloguGosterildi) return;
  guncellemeDiyaloguGosterildi = true;

  const surum = (bilgi && bilgi.version) || '';
  const pencere = (anaPencere && !anaPencere.isDestroyed()) ? anaPencere : undefined;

  const secim = await dialog.showMessageBox(pencere, {
    type: 'info',
    title: '🔄 Güncelleme Hazır',
    message: 'B2B Yönetim Paneli' + (surum ? ' ' + surum : '') + ' sürümü indirildi.',
    detail: 'Yeni sürümü kurmak için uygulama birkaç saniyeliğine kapanıp yeniden açılacak.\n' +
            'Devam eden bir işleminiz varsa önce tamamlayın.\n\nŞimdi kurulsun mu?',
    buttons: ['🔁 ŞİMDİ YENİDEN BAŞLAT VE KUR', 'DAHA SONRA'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  if (secim.response === 0) {
    autoUpdater.quitAndInstall();
  } else {
    // Ertelendi: sonraki "update-downloaded" (ör. yeni bir sürüm) tekrar sorabilsin.
    guncellemeDiyaloguGosterildi = false;
  }
});

autoUpdater.on('error', function (hata) {
  console.warn('[Güncelleme] Kontrol/indirme hatası:', (hata && hata.message) || hata);
});

/** Açılıştan birkaç saniye sonra sessizce güncelleme kontrolü başlatır. */
function otomatikGuncellemeyiBaslat() {
  if (!app.isPackaged) {
    console.log('[Güncelleme] Geliştirme ortamında atlandı (yalnızca paketlenmiş sürümde çalışır).');
    return;
  }

  setTimeout(function () {
    autoUpdater.checkForUpdatesAndNotify({
      title: '🔄 Güncelleme Hazır',
      body: 'B2B Yönetim Paneli {version} indirildi ve uygulamadan çıkıldığında otomatik kurulacak.'
    }).catch(function (e) {
      console.warn('[Güncelleme] checkForUpdatesAndNotify başarısız:', (e && e.message) || e);
    });
  }, 5000);
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
  anaPencere = new BrowserWindow({
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
  });

  // Ekrana getirme birden çok yola bağlandı; biri çalışmazsa diğeri yakalar.
  pencereyiKesinGoster(anaPencere, true);
  anaPencere.once('ready-to-show', function () {
    pencereyiKesinGoster(anaPencere, true);
  });
  anaPencere.webContents.once('did-finish-load', function () {
    pencereyiKesinGoster(anaPencere, true);
    // Arayüz hazır: BYOM'un beklettiği lisans bildirimleri şimdi iletilebilir.
    byom.anaPencereHazir();
    // Sessiz güncelleme kontrolü (bkz. bölüm 3.5) — yalnızca paketlenmiş sürümde çalışır.
    otomatikGuncellemeyiBaslat();
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

  anaPencere.loadFile(path.join(__dirname, 'index.html')).catch(function (e) {
    console.error('loadFile başarısız:', e);
    pencereyiKesinGoster(anaPencere, true);
    dialog.showErrorBox('Uygulama açılamadı', 'index.html yüklenemedi:\n' + e.message);
  });

  // F12 → Geliştirici araçları (destek verirken lazım olur)
  anaPencere.webContents.on('before-input-event', function (olay, girdi) {
    if (girdi.type === 'keyDown' && girdi.key === 'F12') {
      anaPencere.webContents.toggleDevTools();
      olay.preventDefault();
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
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.byomtech.b2b');
    }
    Menu.setApplicationMenu(null); // Sade görünüm: üst menü çubuğu olmasın
    sertifikaDenetiminiGevset();   // SSL katılığı: bkz. bölüm 0

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

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
  });
}
