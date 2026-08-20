/* ============================================================================
 *  BYOM BRAIN — ENTEGRASYON ÇEKİRDEĞİ (ana süreç)
 *  ---------------------------------------------------------------------------
 *  Sorumlulukları:
 *    1) AÇILIŞ AKIŞI (splash / startup check)
 *         · Donanım kimliğini üret
 *         · Kayıtlı lisans anahtarı yoksa   → Aktivasyon ekranı
 *         · Varsa POST /api/v1/license/validate ile doğrula
 *             active / expiring_soon        → uygulamayı aç
 *             expired / suspended /
 *             invalid_hwid / not_found      → uygulamayı KİLİTLE, iletişim ekranı
 *             sunucuya ulaşılamıyor         → çevrimdışı izin süresi içindeyse aç
 *    2) Uygulama açıkken periyodik yeniden doğrulama (varsayılan 6 saat)
 *    3) Bütün ipcMain kanalları (lisans + destek masası)
 *
 *  Bu dosya main.js'ten YALNIZCA iki satırla kullanılır:
 *      const byom = require('./src/main/byom');
 *      byom.baslat({ anaPencereyiAc, anaPencereyiGetir });
 * ==========================================================================*/

'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');

const { hwidDetay, onbellegiTemizle } = require('../utils/hwid');
const yapilandirma = require('./byom-yapilandirma');
const depo = require('./byom-lisans-deposu');
const lisansServisi = require('./byom-lisans-servisi');
const destekServisi = require('./byom-destek-servisi');

/* ==========================================================================
 *  DURUM
 * ========================================================================*/

const durum = {
  hwid: '',
  hwidBilgi: null,
  /** Son doğrulama sonucu (arayüzde rozet bu bilgiyle çizilir). */
  lisans: {
    durum: '',            // active | expiring_soon | expired | …
    kalanGun: null,
    bitisTarihi: '',
    firmaAdi: '',
    domain: '',
    musteriAdi: '',
    plan: '',
    lisansAnahtari: '',
    sonDogrulama: '',
    cevrimdisi: false     // Sunucuya ulaşılamadı, çevrimdışı izinle açıldı
  },
  /** 'kontrol' | 'aktivasyon' | 'kilit' | 'acik' */
  mod: 'kontrol',
  kilitSebebi: '',
  acilisTamam: false
};

let lisansPenceresi = null;
let anaPencereyiAcGeriCagir = null;
let anaPencereyiGetirGeriCagir = null;
let otoKontrolZamanlayici = null;

/* ==========================================================================
 *  YARDIMCILAR
 * ========================================================================*/

/** Uygulama sürümü — sunucu lisans kaydına "hangi sürüm kullanılıyor" diye yazar. */
function uygulamaSurumu() {
  try { return app.getVersion(); } catch (e) { return ''; }
}

/** Lisans anahtarını arayüzde göstermek için maskeler: BYOM-XXXX-…-1234 */
function anahtariMaskele(anahtar) {
  const a = String(anahtar || '').trim();
  if (a.length <= 8) return a ? a.slice(0, 2) + '••••' : '';
  return a.slice(0, 4) + '••••••••••••' + a.slice(-4);
}

function anaPencere() {
  try {
    const p = anaPencereyiGetirGeriCagir ? anaPencereyiGetirGeriCagir() : null;
    return p && !p.isDestroyed() ? p : null;
  } catch (e) {
    return null;
  }
}

/* Ana pencere daha yüklenmeden gönderilen olaylar kaybolmasın diye kuyruklanır;
   arayüz hazır olduğunu bildirince (anaPencereHazir) sırayla iletilir. */
let anaPencereHazirMi = false;
const bekleyenOlaylar = [];

/** Ana pencereye olay gönderir (hazır değilse kuyruğa alır). */
function anaPencereyeGonder(kanal, veri) {
  const p = anaPencere();
  if (!p || !anaPencereHazirMi) {
    bekleyenOlaylar.push({ kanal: kanal, veri: veri });
    if (bekleyenOlaylar.length > 20) bekleyenOlaylar.shift(); // taşmasın
    return;
  }
  try { p.webContents.send(kanal, veri); } catch (e) { /* kapanıyor olabilir */ }
}

/** main.js, ana pencere arayüzü yüklenince bunu çağırır. */
function anaPencereHazir() {
  anaPencereHazirMi = true;
  const p = anaPencere();
  if (!p) return;
  while (bekleyenOlaylar.length) {
    const olay = bekleyenOlaylar.shift();
    try { p.webContents.send(olay.kanal, olay.veri); } catch (e) { /* yok say */ }
  }
}

/** Lisans/aktivasyon penceresine ekran durumu gönderir. */
function ekranGonder(veri) {
  if (!lisansPenceresi || lisansPenceresi.isDestroyed()) return;
  try {
    lisansPenceresi.webContents.send('byom:ekran', veri);
  } catch (e) { /* pencere kapanıyor olabilir */ }
}

/** Arayüze verilecek özet lisans bilgisi. */
function lisansOzeti() {
  return {
    mod: durum.mod,
    kilitSebebi: durum.kilitSebebi,
    hwid: durum.hwid,
    hwidGuclu: !!(durum.hwidBilgi && durum.hwidBilgi.guclu),
    apiUrl: yapilandirma.apiTabani(),
    apiKaynagi: yapilandirma.apiKaynagi(),
    lisans: Object.assign({}, durum.lisans, {
      anahtarMaskeli: anahtariMaskele(durum.lisans.lisansAnahtari)
    })
  };
}

/** Sunucudan gelen çözümü hem belleğe hem diske yazar. */
function sonucuKaydet(anahtar, cozum, ekstra) {
  const simdi = new Date().toISOString();
  const basarili = lisansServisi.acikMi(cozum.durum);

  const kayit = depo.yaz(Object.assign({
    lisansAnahtari: anahtar,
    durum: cozum.durum || '',
    kalanGun: cozum.kalanGun === undefined ? null : cozum.kalanGun,
    bitisTarihi: cozum.bitisTarihi || '',
    firmaAdi: cozum.firmaAdi || (ekstra && ekstra.firmaAdi) || '',
    domain: cozum.domain || (ekstra && ekstra.domain) || '',
    musteriAdi: cozum.musteriAdi || '',
    plan: cozum.plan || '',
    sonDeneme: simdi,
    sunucuVerisi: cozum.ham || null
  }, basarili ? { sonDogrulama: simdi } : {}, ekstra || {}), durum.hwid);

  durum.lisans = {
    durum: kayit.durum,
    kalanGun: kayit.kalanGun,
    bitisTarihi: kayit.bitisTarihi,
    firmaAdi: kayit.firmaAdi,
    domain: kayit.domain,
    musteriAdi: kayit.musteriAdi,
    plan: kayit.plan,
    lisansAnahtari: kayit.lisansAnahtari,
    sonDogrulama: kayit.sonDogrulama,
    cevrimdisi: false
  };

  return kayit;
}

/* ==========================================================================
 *  LİSANS PENCERESİ (splash + aktivasyon + kilit ekranı)
 * ========================================================================*/

function lisansPenceresiniAc(baslangicEkrani) {
  if (lisansPenceresi && !lisansPenceresi.isDestroyed()) {
    if (lisansPenceresi.isMinimized()) lisansPenceresi.restore();
    lisansPenceresi.show();
    lisansPenceresi.focus();
    if (baslangicEkrani) ekranGonder(baslangicEkrani);
    return lisansPenceresi;
  }

  lisansPenceresi = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    title: 'BYOM Lisans',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    resizable: true,
    // Ana pencerede olduğu gibi show:false + ready-to-show kullanılmıyor:
    // bazı Windows makinelerinde olay hiç tetiklenmiyor ve pencere görünmüyordu.
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false
    }
  });

  lisansPenceresi.setMenuBarVisibility(false);

  lisansPenceresi.loadFile(path.join(__dirname, '..', '..', 'lisans', 'lisans.html')).catch(function (e) {
    console.error('[BYOM] Lisans ekranı yüklenemedi:', e);
    dialog.showErrorBox('BYOM Lisans ekranı açılamadı', String((e && e.message) || e));
  });

  lisansPenceresi.webContents.on('did-finish-load', function () {
    // Pencere hazır olur olmaz mevcut ekran durumu gönderilir.
    ekranGonder(baslangicEkrani || { mod: durum.mod, ozet: lisansOzeti() });
  });

  lisansPenceresi.webContents.on('before-input-event', function (olay, girdi) {
    if (girdi.type === 'keyDown' && girdi.key === 'F12') {
      lisansPenceresi.webContents.toggleDevTools();
      olay.preventDefault();
    }
  });

  lisansPenceresi.webContents.setWindowOpenHandler(function (detay) {
    if (/^https?:\/\//i.test(detay.url)) shell.openExternal(detay.url);
    return { action: 'deny' };
  });

  lisansPenceresi.on('closed', function () {
    lisansPenceresi = null;
    /* Kullanıcı lisans ekranını kapattıysa ve ana pencere hiç açılmadıysa
       uygulamanın arka planda görünmez şekilde kalması yanlış olur.        */
    if (!anaPencere()) {
      setTimeout(function () {
        if (!anaPencere() && !lisansPenceresi) app.quit();
      }, 150);
    }
  });

  return lisansPenceresi;
}

function lisansPenceresiniKapat() {
  if (lisansPenceresi && !lisansPenceresi.isDestroyed()) {
    const p = lisansPenceresi;
    lisansPenceresi = null;   // 'closed' olayındaki app.quit() koruması devreye girmesin
    p.close();
  }
}

/* ==========================================================================
 *  AÇILIŞ AKIŞI
 * ========================================================================*/

/** Uygulamayı açar: lisans penceresi kapanır, ana pencere gelir. */
function uygulamayiAc() {
  durum.mod = 'acik';
  durum.acilisTamam = true;

  if (!anaPencere() && typeof anaPencereyiAcGeriCagir === 'function') {
    anaPencereHazirMi = false;   // Yeni pencere yüklenene kadar olaylar kuyrukta beklesin
    anaPencereyiAcGeriCagir();
  }
  lisansPenceresiniKapat();
  otoKontroluBaslat();
  anaPencereyeGonder('byom:lisans-guncellendi', lisansOzeti());
}

/** Uygulamayı kilitler: ana pencere kapanır, iletişim/kilit ekranı gelir. */
function kilitle(sebep, ayrinti) {
  durum.mod = 'kilit';
  durum.kilitSebebi = sebep || 'bilinmiyor';

  const aciklama = lisansServisi.durumAciklamasi(durum.kilitSebebi);
  const ekran = {
    mod: 'kilit',
    sebep: durum.kilitSebebi,
    baslik: aciklama.baslik,
    aciklama: aciklama.aciklama,
    ekMesaj: (ayrinti && ayrinti.mesaj) || '',
    ozet: lisansOzeti()
  };

  lisansPenceresiniAc(ekran);
  ekranGonder(ekran);

  const p = anaPencere();
  if (p) {
    try { p.destroy(); } catch (e) { /* zaten kapanmış olabilir */ }
  }
  anaPencereHazirMi = false;
  bekleyenOlaylar.length = 0;
  otoKontroluDurdur();
}

/**
 * Program açılış kontrolü.
 * Lisans penceresi ZATEN açık (splash) varsayımıyla çalışır.
 */
async function acilisKontrolu() {
  durum.mod = 'kontrol';
  ekranGonder({ mod: 'kontrol', adim: 'Donanım kimliği hesaplanıyor…' });

  /* 1) Donanım kimliği ------------------------------------------------- */
  try {
    durum.hwidBilgi = await hwidDetay();
    durum.hwid = durum.hwidBilgi.hwid;
  } catch (e) {
    console.error('[BYOM] HWID üretilemedi:', e);
    durum.hwid = '';
  }

  if (!durum.hwid) {
    kilitle('bilinmiyor', { mesaj: 'Bu bilgisayarın donanım kimliği okunamadı. Lütfen destek ekibiyle iletişime geçin.' });
    return;
  }

  /* 2) Kayıtlı lisans -------------------------------------------------- */
  const kayit = depo.oku(durum.hwid);

  if (!kayit.varMi) {
    durum.mod = 'aktivasyon';
    ekranGonder({
      mod: 'aktivasyon',
      bozukKayit: !!kayit.bozuk,
      ozet: lisansOzeti()
    });
    return;
  }

  durum.lisans.lisansAnahtari = kayit.lisansAnahtari;
  durum.lisans.firmaAdi = kayit.firmaAdi;
  durum.lisans.domain = kayit.domain;

  /* 3) Sunucuda doğrula ------------------------------------------------ */
  ekranGonder({ mod: 'kontrol', adim: 'Lisansınız BYOM Brain üzerinde doğrulanıyor…' });
  const sonuc = await lisansServisi.dogrula(kayit.lisansAnahtari, durum.hwid, uygulamaSurumu());

  await sonucuIsle(sonuc, kayit);
}

/**
 * Doğrulama sonucunu değerlendirir: aç / kilitle / çevrimdışı izin ver.
 * Hem açılışta hem periyodik kontrolde kullanılır.
 */
async function sonucuIsle(sonuc, kayit, sessizYenilemeMi) {
  /* --- Sunucuya ulaşılamadı: çevrimdışı izin süresi --- */
  if (!sonuc.ok && sonuc.agSorunu) {
    const ayar = yapilandirma.oku();
    const izinGunu = Number(ayar.cevrimdisiIzinGunu) > 0 ? Number(ayar.cevrimdisiIzinGunu) : 7;
    const sonBasarili = kayit && kayit.sonDogrulama ? new Date(kayit.sonDogrulama).getTime() : 0;
    const gecenGun = sonBasarili ? Math.floor((Date.now() - sonBasarili) / 86400000) : 9999;

    // Kayıt başka bir bilgisayardan kopyalanmışsa çevrimdışı izin verilmez.
    const tasindi = !!(kayit && kayit.tasindi);

    if (!tasindi && sonBasarili && gecenGun <= izinGunu && lisansServisi.acikMi(kayit.durum)) {
      durum.lisans = {
        durum: kayit.durum,
        kalanGun: kayit.kalanGun,
        bitisTarihi: kayit.bitisTarihi,
        firmaAdi: kayit.firmaAdi,
        domain: kayit.domain,
        musteriAdi: kayit.musteriAdi,
        plan: kayit.plan,
        lisansAnahtari: kayit.lisansAnahtari,
        sonDogrulama: kayit.sonDogrulama,
        cevrimdisi: true,
        cevrimdisiKalanGun: Math.max(0, izinGunu - gecenGun)
      };
      depo.yaz({ sonDeneme: new Date().toISOString() }, durum.hwid);

      if (sessizYenilemeMi) {
        anaPencereyeGonder('byom:lisans-guncellendi', lisansOzeti());
      } else {
        uygulamayiAc();
        anaPencereyeGonder('byom:uyari', {
          tur: 'uyari',
          mesaj: 'BYOM Brain sunucusuna ulaşılamadı.\n' +
                 'Uygulama çevrimdışı izinle açıldı — kalan süre: ' +
                 Math.max(0, izinGunu - gecenGun) + ' gün.\n' +
                 'İnternet bağlantınızı kontrol edin.'
        });
      }
      return;
    }

    // Çevrimdışı izin yok/bitti: kilit ekranı (yeniden dene düğmesiyle)
    if (sessizYenilemeMi) {
      // Uygulama açıkken geçici ağ hatası yüzünden kapatılmaz, sadece uyarılır.
      anaPencereyeGonder('byom:uyari', {
        tur: 'uyari',
        mesaj: 'Lisans kontrolü yapılamadı: BYOM Brain sunucusuna ulaşılamıyor.'
      });
      return;
    }
    kilitle('baglanti', { mesaj: sonuc.hata });
    return;
  }

  /* --- Sunucu yanıt verdi --- */
  if (sonuc.ok && lisansServisi.acikMi(sonuc.durum)) {
    sonucuKaydet(kayit && kayit.lisansAnahtari ? kayit.lisansAnahtari : durum.lisans.lisansAnahtari, sonuc);
    if (sessizYenilemeMi) {
      anaPencereyeGonder('byom:lisans-guncellendi', lisansOzeti());
      if (sonuc.durum === 'expiring_soon') {
        anaPencereyeGonder('byom:uyari', {
          tur: 'uyari',
          mesaj: 'Lisansınızın bitmesine ' + (sonuc.kalanGun === null ? 'az' : sonuc.kalanGun + ' gün') + ' kaldı.\n' +
                 'Kesintisiz kullanım için yenileme talebinizi 🎧 BYOM Destek sekmesinden iletebilirsiniz.'
        });
      }
    } else {
      uygulamayiAc();
      if (sonuc.durum === 'expiring_soon') {
        anaPencereyeGonder('byom:uyari', {
          tur: 'uyari',
          mesaj: 'Lisansınızın bitmesine ' + (sonuc.kalanGun === null ? 'az' : sonuc.kalanGun + ' gün') + ' kaldı.\n' +
                 'Yenileme için 🎧 BYOM Destek sekmesinden talep açabilirsiniz.'
        });
      }
    }
    return;
  }

  /* --- Lisans gerçek ama bu cihaza hiç mühürlenmemiş ---
     Kilit ekranı yanıltıcı olurdu: kullanıcının yapması gereken tek şey
     aktivasyonu tamamlamak. Bilgileri hazır gelen aktivasyon ekranı açılır. */
  if (sonuc.ok && lisansServisi.aktivasyonGerekliMi(sonuc.durum)) {
    const anahtar = (kayit && kayit.lisansAnahtari) || durum.lisans.lisansAnahtari || '';
    durum.mod = 'aktivasyon';
    durum.lisans.durum = sonuc.durum;

    const aciklama = lisansServisi.durumAciklamasi('not_activated');
    const ekran = {
      mod: 'aktivasyon',
      bilgiMesaji: sonuc.mesaj || aciklama.aciklama,
      acikAnahtar: anahtar,
      ozet: lisansOzeti()
    };

    lisansPenceresiniAc(ekran);
    ekranGonder(ekran);

    /* Uygulama açıkken bu duruma düşmek olağandışıdır (yönetici mührü
       kaldırmış olabilir): açık pencere kapatılır, kullanıcı aktivasyona alınır. */
    const acikPencere = anaPencere();
    if (acikPencere) {
      try { acikPencere.destroy(); } catch (e) { /* zaten kapanmış olabilir */ }
      anaPencereHazirMi = false;
      bekleyenOlaylar.length = 0;
      otoKontroluDurdur();
    }
    return;
  }

  /* --- Sunucu "hayır" dedi: kilit --- */
  const kilitDurumu = sonuc.durum && sonuc.durum !== 'bilinmiyor' ? sonuc.durum : 'bilinmiyor';
  sonucuKaydet(kayit && kayit.lisansAnahtari ? kayit.lisansAnahtari : durum.lisans.lisansAnahtari, {
    durum: kilitDurumu,
    kalanGun: sonuc.kalanGun === undefined ? null : sonuc.kalanGun,
    bitisTarihi: sonuc.bitisTarihi || (kayit && kayit.bitisTarihi) || '',
    firmaAdi: sonuc.firmaAdi || (kayit && kayit.firmaAdi) || '',
    domain: sonuc.domain || (kayit && kayit.domain) || '',
    musteriAdi: sonuc.musteriAdi || '',
    plan: sonuc.plan || '',
    ham: sonuc.ham || null
  });

  kilitle(kilitDurumu, { mesaj: sonuc.mesaj || sonuc.hata || '' });
}

/* ==========================================================================
 *  PERİYODİK YENİDEN DOĞRULAMA
 *  ---------------------------------------------------------------------------
 *  Uygulama günlerce açık kalabiliyor. Lisans askıya alınırsa ya da süresi
 *  dolarsa bir sonraki açılışı beklemeden fark edilmeli.
 * ========================================================================*/

function otoKontroluBaslat() {
  otoKontroluDurdur();
  const saat = Number(yapilandirma.oku().otoKontrolSaati) > 0 ? Number(yapilandirma.oku().otoKontrolSaati) : 6;
  otoKontrolZamanlayici = setInterval(function () {
    yenidenDogrula(true);
  }, saat * 3600 * 1000);
}

function otoKontroluDurdur() {
  if (otoKontrolZamanlayici) {
    clearInterval(otoKontrolZamanlayici);
    otoKontrolZamanlayici = null;
  }
}

/** Lisansı yeniden doğrular. sessiz=true → uygulama açıkken arka planda. */
async function yenidenDogrula(sessiz) {
  const kayit = depo.oku(durum.hwid);
  if (!kayit.varMi) {
    if (!sessiz) {
      durum.mod = 'aktivasyon';
      ekranGonder({ mod: 'aktivasyon', ozet: lisansOzeti() });
    }
    return { ok: false, hata: 'Kayıtlı lisans yok.' };
  }

  const sonuc = await lisansServisi.dogrula(kayit.lisansAnahtari, durum.hwid, uygulamaSurumu());
  await sonucuIsle(sonuc, kayit, !!sessiz);
  return sonuc;
}

/* ==========================================================================
 *  IPC KANALLARI — LİSANS
 * ========================================================================*/

function lisansKanallariniBagla() {

  /** Donanım kimliği ve teşhis bilgileri. */
  ipcMain.handle('byom:hwid', async function () {
    try {
      const bilgi = await hwidDetay();
      return {
        ok: true,
        hwid: bilgi.hwid,
        guclu: bilgi.guclu,
        kaynaklar: bilgi.kaynaklar,
        platform: bilgi.platform,
        makineAdi: bilgi.makineAdi,
        teshis: bilgi.teshis
      };
    } catch (e) {
      return { ok: false, hata: 'Donanım kimliği üretilemedi: ' + ((e && e.message) || e) };
    }
  });

  /** Arayüzün rozet/ayar ekranı için lisans özeti. */
  ipcMain.handle('byom:durum', function () {
    return lisansOzeti();
  });

  /** Aktivasyon ekranından gelir: lisansı bu bilgisayara bağla. */
  ipcMain.handle('byom:aktive', async function (olay, bilgi) {
    bilgi = bilgi || {};
    const anahtar = String(bilgi.lisansAnahtari || '').trim();
    const firmaAdi = String(bilgi.firmaAdi || '').trim();
    const domain = String(bilgi.domain || '').trim();

    if (anahtar.length < 6) {
      return { ok: false, hata: 'Lisans anahtarı çok kısa görünüyor. Size iletilen anahtarı eksiksiz yapıştırın.' };
    }
    if (firmaAdi.length < 2) {
      return { ok: false, hata: 'Firma adını yazın.' };
    }
    if (!durum.hwid) {
      try {
        durum.hwidBilgi = await hwidDetay();
        durum.hwid = durum.hwidBilgi.hwid;
      } catch (e) { /* aşağıda yakalanır */ }
    }
    if (!durum.hwid) {
      return { ok: false, hata: 'Bu bilgisayarın donanım kimliği okunamadı.' };
    }

    const sonuc = await lisansServisi.aktive({
      lisansAnahtari: anahtar,
      hardwareId: durum.hwid,
      firmaAdi: firmaAdi,
      domain: domain,
      surum: app.getVersion(),
      makineAdi: (durum.hwidBilgi && durum.hwidBilgi.makineAdi) || ''
    });

    if (!sonuc.ok && sonuc.agSorunu) {
      return { ok: false, agSorunu: true, hata: sonuc.hata };
    }

    if (sonuc.ok && lisansServisi.acikMi(sonuc.durum)) {
      sonucuKaydet(anahtar, sonuc, {
        firmaAdi: sonuc.firmaAdi || firmaAdi,
        domain: sonuc.domain || domain,
        aktivasyonTarihi: new Date().toISOString()
      });
      return { ok: true, ozet: lisansOzeti() };
    }

    const kod = sonuc.durum || 'bilinmiyor';
    const aciklama = lisansServisi.durumAciklamasi(kod);
    return {
      ok: false,
      durum: kod,
      baslik: aciklama.baslik,
      hata: (sonuc.mesaj || sonuc.hata || aciklama.aciklama)
    };
  });

  /** Aktivasyon başarılı olduktan sonra lisans ekranından "uygulamayı aç". */
  ipcMain.handle('byom:uygulamayi-ac', function () {
    if (lisansServisi.acikMi(durum.lisans.durum)) {
      uygulamayiAc();
      return { ok: true };
    }
    return { ok: false, hata: 'Geçerli bir lisans doğrulanmadan uygulama açılamaz.' };
  });

  /** Kilit ekranındaki "Tekrar Dene" / ayarlardaki "Lisansı Kontrol Et". */
  ipcMain.handle('byom:yeniden-dogrula', async function (olay, secenek) {
    const sessiz = !!(secenek && secenek.sessiz);
    ekranGonder({ mod: 'kontrol', adim: 'Lisansınız yeniden doğrulanıyor…' });
    const sonuc = await yenidenDogrula(sessiz);
    return { ok: !!(sonuc && sonuc.ok), durum: (sonuc && sonuc.durum) || '', hata: (sonuc && sonuc.hata) || '', ozet: lisansOzeti() };
  });

  /** Kayıtlı lisansı sil → aktivasyon ekranına dön (başka anahtar girilecek). */
  ipcMain.handle('byom:lisans-sil', function () {
    depo.sil();
    durum.lisans = {
      durum: '', kalanGun: null, bitisTarihi: '', firmaAdi: '', domain: '',
      musteriAdi: '', plan: '', lisansAnahtari: '', sonDogrulama: '', cevrimdisi: false
    };
    durum.mod = 'aktivasyon';
    ekranGonder({ mod: 'aktivasyon', ozet: lisansOzeti() });
    return { ok: true };
  });

  /** Donanım kimliğini yeniden hesapla (donanım değişikliği sonrası). */
  ipcMain.handle('byom:hwid-yenile', async function () {
    onbellegiTemizle();
    durum.hwidBilgi = await hwidDetay(true);
    durum.hwid = durum.hwidBilgi.hwid;
    return { ok: true, hwid: durum.hwid };
  });

  /** BYOM Brain adresi — oku / yaz. */
  ipcMain.handle('byom:api-url:oku', function () {
    const ayar = yapilandirma.oku();
    return {
      ok: true,
      apiUrl: yapilandirma.apiTabani(),
      kayitliUrl: ayar.apiUrl || '',
      kaynak: yapilandirma.apiKaynagi(),
      varsayilanGelistirme: yapilandirma.VARSAYILAN_GELISTIRME,
      varsayilanUretim: yapilandirma.VARSAYILAN_URETIM,
      paketlenmis: app.isPackaged,
      cevrimdisiIzinGunu: ayar.cevrimdisiIzinGunu
    };
  });

  ipcMain.handle('byom:api-url:yaz', function (olay, veri) {
    veri = veri || {};
    const ham = String(veri.apiUrl || '').trim();

    if (ham && !yapilandirma.adresGecerliMi(ham)) {
      return { ok: false, hata: 'Adres geçersiz.\nÖrnek: https://hub.byomtech.com veya http://localhost:3000' };
    }
    yapilandirma.yaz({ apiUrl: ham ? yapilandirma.adresiTemizle(ham) : '' });
    return { ok: true, apiUrl: yapilandirma.apiTabani(), kaynak: yapilandirma.apiKaynagi() };
  });

  /**
   * Sunucuya erişilebiliyor mu? (Ayarlar ▸ "Bağlantıyı Test Et")
   *
   * Bu test, LİSANS DOĞRULAMASIYLA AYNI taban adresi ve aynı canlı uç ailesini
   * kullanır. Eskiden yalnızca /api/v1/health yoklanıyordu; bu uç hub'da
   * bulunmadığı için sunucu HTML bir 404 sayfası döndürüyor, istemci de bunu
   * "bu adres BYOM Brain değil" diye ağ sorunu sayıyordu. Sonuç: lisans
   * kontrolü çalışırken bağlantı testi "ulaşılamadı" diyordu.
   *
   * Yoklama sırası (ilk HTTP yanıtı veren kazanır):
   *   1) GET     /api/v1/health              → varsa en ucuz yanıt
   *   2) OPTIONS /api/v1/license/validate    → canlı lisans ucunun hafif ön kontrolü
   *   3) GET     /api/v1/license/validate    → 401/405/400 bile "sunucu ayakta" demek
   *
   * Kural: HTTP durumu ne olursa olsun sunucudan bir yanıt gelmesi bağlantının
   * kurulduğunu kanıtlar. Yalnızca TAŞIMA katmanı hataları (DNS, bağlantı reddi,
   * TLS, zaman aşımı) "ulaşılamadı" sayılır. 5xx ise ayrı raporlanır: bağlantı
   * var ama sunucu hata veriyor.
   */
  ipcMain.handle('byom:baglanti-testi', async function () {
    const api = require('./byom-api');
    const taban = yapilandirma.apiTabani();

    const yoklamalar = [
      { yol: '/api/v1/health', metod: 'GET' },
      { yol: '/api/v1/license/validate', metod: 'OPTIONS' },
      { yol: '/api/v1/license/validate', metod: 'GET' }
    ];

    /* Host hiç çözülmüyorsa / bağlantıyı reddediyorsa başka rota denemenin
       anlamı yok; ilk hatada çıkılır (kullanıcı boşuna beklemesin). */
    const rotaDegistirmeninFaydasiYok = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|CERT|SSL|TLS)/i;

    let sonHata = '';
    let sunucuHatasi = null;

    for (let i = 0; i < yoklamalar.length; i++) {
      const yoklama = yoklamalar[i];
      const yanit = await api.istekAt({
        yol: yoklama.yol,
        metod: yoklama.metod,
        sureAsimi: 8000,
        htmlUyarisi: false          // HTML 404 sayfası ağ sorunu değildir
      });

      if (yanit.ok) {
        return {
          ok: true,
          mesaj: 'BYOM Brain sunucusuna ulaşıldı (' + yoklama.metod + ' ' + yoklama.yol +
                 ' → HTTP ' + yanit.durum + ').',
          apiUrl: taban,
          uc: yoklama.yol,
          httpDurum: yanit.durum
        };
      }

      if (yanit.agSorunu && !yanit.durum) {
        // Taşıma katmanı hatası: sunucudan hiç yanıt gelmedi.
        sonHata = yanit.hata;
        if (rotaDegistirmeninFaydasiYok.test(String(yanit.kod || ''))) break;
        continue;
      }

      if (yanit.durum >= 500) {
        // Sunucu ayakta ama hata veriyor; daha iyi bir yanıt bulmayı sürdür.
        sunucuHatasi = yanit;
        continue;
      }

      /* 4xx / 3xx: sunucu konuştu → bağlantı sağlıklı. Lisans doğrulaması da
         aynı tabana gittiği için bu, testin doğru sonucudur. */
      return {
        ok: true,
        mesaj: 'BYOM Brain sunucusuna ulaşıldı (' + yoklama.metod + ' ' + yoklama.yol +
               ' → HTTP ' + yanit.durum + ').\nBağlantı sağlıklı.',
        apiUrl: taban,
        uc: yoklama.yol,
        httpDurum: yanit.durum
      };
    }

    if (sunucuHatasi) {
      return {
        ok: false,
        hata: 'Sunucuya ulaşıldı ancak BYOM Brain hata döndürüyor (HTTP ' + sunucuHatasi.durum + ').\n' +
              'Adres doğru; sorun sunucu tarafında. Lütfen daha sonra tekrar deneyin.',
        apiUrl: taban,
        httpDurum: sunucuHatasi.durum
      };
    }

    return {
      ok: false,
      hata: sonHata || 'BYOM Brain sunucusuna ulaşılamadı (' + taban + ').',
      apiUrl: taban
    };
  });

  /** Panoya kopyala (HWID / lisans anahtarı). */
  ipcMain.handle('byom:panoya-kopyala', function (olay, metin) {
    try {
      clipboard.writeText(String(metin || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, hata: 'Panoya kopyalanamadı.' };
    }
  });

  /** Dış bağlantı / e-posta / telefon bağlantısını sistemde aç. */
  ipcMain.handle('byom:dis-baglanti', function (olay, adres) {
    const url = String(adres || '');
    if (!/^(https?:|mailto:|tel:)/i.test(url)) return { ok: false, hata: 'Geçersiz bağlantı.' };
    shell.openExternal(url);
    return { ok: true };
  });

  /** Lisans ekranından çıkış. */
  ipcMain.handle('byom:cikis', function () {
    app.quit();
    return { ok: true };
  });
}

/* ==========================================================================
 *  IPC KANALLARI — DESTEK MASASI
 * ========================================================================*/

/** Destek isteklerinde kullanılan kimlik demeti. */
function destekKimligi() {
  return {
    lisansAnahtari: durum.lisans.lisansAnahtari,
    hardwareId: durum.hwid,
    firmaAdi: durum.lisans.firmaAdi,
    domain: durum.lisans.domain,
    surum: (function () { try { return app.getVersion(); } catch (e) { return ''; } })()
  };
}

/** Lisans yoksa destek uçları çağrılamaz (talepler lisansa bağlı açılır). */
function lisansSartiTamamMi() {
  if (!durum.lisans.lisansAnahtari) {
    return { ok: false, hata: 'Destek talebi açabilmek için önce lisansınızın doğrulanması gerekir.' };
  }
  return null;
}

function destekKanallariniBagla() {

  ipcMain.handle('byom:destek:liste', async function () {
    const engel = lisansSartiTamamMi();
    if (engel) return engel;
    return await destekServisi.listele(destekKimligi());
  });

  ipcMain.handle('byom:destek:detay', async function (olay, veri) {
    const engel = lisansSartiTamamMi();
    if (engel) return engel;
    return await destekServisi.detay(destekKimligi(), (veri || {}).id);
  });

  ipcMain.handle('byom:destek:olustur', async function (olay, veri) {
    const engel = lisansSartiTamamMi();
    if (engel) return engel;
    return await destekServisi.olustur(destekKimligi(), veri || {});
  });

  ipcMain.handle('byom:destek:yanit', async function (olay, veri) {
    const engel = lisansSartiTamamMi();
    if (engel) return engel;
    veri = veri || {};
    return await destekServisi.yanitla(destekKimligi(), veri.id, veri.mesaj);
  });

  /* Talep KAPATMA ucu bilerek yok: BYOM Brain'de kapatma yönetici yetkisidir. */

  /** Öncelik/durum etiketleri arayüzde tek yerden gelsin. */
  ipcMain.handle('byom:destek:secenekler', function () {
    return { ok: true, oncelikler: destekServisi.ONCELIKLER, durumlar: destekServisi.DURUMLAR };
  });
}

/* ==========================================================================
 *  DIŞARIYA AÇILAN GİRİŞ NOKTASI
 * ========================================================================*/

let kanallarBaglandi = false;

/**
 * Entegrasyonu başlatır.
 * secenekler = {
 *   anaPencereyiAc    : () => void     → lisans doğrulanınca çağrılır
 *   anaPencereyiGetir : () => BrowserWindow|null
 * }
 */
function baslat(secenekler) {
  secenekler = secenekler || {};
  anaPencereyiAcGeriCagir = secenekler.anaPencereyiAc || null;
  anaPencereyiGetirGeriCagir = secenekler.anaPencereyiGetir || null;

  if (!kanallarBaglandi) {
    lisansKanallariniBagla();
    destekKanallariniBagla();
    kanallarBaglandi = true;
  }

  // Splash: kontrol ekranıyla açılır, akış arka planda ilerler.
  lisansPenceresiniAc({ mod: 'kontrol', adim: 'Başlatılıyor…' });

  acilisKontrolu().catch(function (e) {
    console.error('[BYOM] Açılış kontrolü başarısız:', e);
    kilitle('bilinmiyor', { mesaj: 'Açılış kontrolü sırasında beklenmeyen bir hata oluştu:\n' + ((e && e.message) || e) });
  });
}

/** İkinci kopya çalıştırıldığında hangi pencere öne gelmeli? */
function odakla() {
  if (lisansPenceresi && !lisansPenceresi.isDestroyed()) {
    if (lisansPenceresi.isMinimized()) lisansPenceresi.restore();
    lisansPenceresi.show();
    lisansPenceresi.focus();
    return true;
  }
  return false;
}

/** Lisans doğrulanmadan ana pencere açılmasın diye main.js bunu sorar. */
function acilisTamamMi() {
  return durum.acilisTamam && lisansServisi.acikMi(durum.lisans.durum);
}

module.exports = {
  baslat,
  odakla,
  anaPencereHazir,
  acilisTamamMi,
  lisansOzeti,
  yenidenDogrula,
  kilitle,
  lisansPenceresiniAc
};
