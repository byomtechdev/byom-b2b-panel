/* ============================================================================
 *  BYOM BRAIN — DONANIM KİMLİĞİ (HWID) ÜRETİCİSİ
 *  ---------------------------------------------------------------------------
 *  Bu bilgisayara özel, kopyalanamaz ve SABİT bir kimlik üretir.
 *
 *  Nasıl çalışır?
 *   1) İşletim sistemine göre donanıma gömülü seri numaraları okunur:
 *        · Windows → anakart seri no, BIOS seri no, işlemci kimliği,
 *                    sistem UUID'si (Win32_ComputerSystemProduct) ve
 *                    Windows MachineGuid (kayıt defteri).
 *        · Linux   → /etc/machine-id, DMI ürün UUID'si, anakart seri no.
 *        · macOS   → IOPlatformUUID ve IOPlatformSerialNumber.
 *   2) Üreticilerin boş bıraktığı şablon değerler ("To be filled by O.E.M.",
 *      "Default string", sıfırlarla dolu UUID'ler…) ELENİR. Bunlar elenmezse
 *      aynı marka iki bilgisayar aynı kimliği üretirdi.
 *   3) Kalan değerler sıralanıp birleştirilir ve node:crypto ile SHA-256
 *      özeti alınır. Ham seri numaraları ASLA sunucuya gönderilmez; yalnızca
 *      geri döndürülemez özet gider (gizlilik + KVKK).
 *   4) Sonuç okunabilir biçime çevrilir:  BYOM-XXXX-XXXX-XXXX-XXXX-XXXX
 *
 *  Neden kopyalanamaz?
 *   Kimlik bir dosyada saklanmaz, HER AÇILIŞTA donanımdan yeniden hesaplanır.
 *   Uygulama klasörü ya da ayar dosyaları başka bilgisayara kopyalansa bile
 *   orada BAŞKA bir HWID üretilir; BYOM Brain lisansı "invalid_hwid" der.
 *
 *  NOT: Hangi alanların özete katılacağı ÖZETE_GIRENLER listeleriyle sabittir.
 *  Disk seri numarası bilerek özete KATILMAZ (disk değişimi çok yaygın; kimlik
 *  gereksiz yere bozulup müşteriyi lisans kilidine düşürürdü) — yalnızca
 *  destek ekranında teşhis bilgisi olarak toplanır.
 * ==========================================================================*/

'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

/* ==========================================================================
 *  1) DEĞER SÜZME — "anlamlı" seri numarası nedir?
 * ========================================================================*/

/** Üreticilerin doldurmayı unuttuğu şablon değerler. Küçük harfle karşılaştırılır. */
const ANLAMSIZ_DEGERLER = [
  'to be filled by o.e.m.', 'to be filled by o.e.m', 'tobefilledbyoem',
  'default string', 'system serial number', 'system serialnumber',
  'chassis serial number', 'base board serial number', 'baseboard serial number',
  'not applicable', 'not specified', 'not available', 'none', 'null', 'nil',
  'unknown', 'n/a', 'na', 'invalid', 'oem', 'serial', 'x.x.x', '.',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff'
];

/**
 * Değerin kimliğe katılmaya değer olup olmadığını söyler.
 * Kısa, sıfırlarla dolu ya da şablon değerler elenir.
 */
function anlamliMi(ham) {
  const deger = String(ham === null || ham === undefined ? '' : ham).trim();
  if (deger.length < 4) return false;

  const kucuk = deger.toLowerCase();
  if (ANLAMSIZ_DEGERLER.indexOf(kucuk) !== -1) return false;

  const sade = kucuk.replace(/[-\s_.:]/g, '');
  if (sade.length < 4) return false;
  if (/^0+$/.test(sade)) return false;   // 0000-0000
  if (/^f+$/.test(sade)) return false;   // FFFFFFFF
  if (/^x+$/.test(sade)) return false;   // XXXXXXXX
  if (/^1+$/.test(sade)) return false;

  return true;
}

/** Büyük/küçük harf ve boşluk farklarının kimliği değiştirmemesi için sadeleştirir. */
function sadelestir(ham) {
  return String(ham).trim().replace(/\s+/g, ' ').toUpperCase();
}

/* ==========================================================================
 *  2) KOMUT ÇALIŞTIRICI
 *  ---------------------------------------------------------------------------
 *  Donanım bilgisi okunurken hiçbir hata uygulamayı durdurmamalı: komut yoksa,
 *  yasaklıysa ya da zaman aşımına uğrarsa boş metin döner ve o kaynak elenir.
 * ========================================================================*/

function komutCalistir(dosya, argumanlar, sureAsimi) {
  return new Promise(function (cozumle) {
    let bitti = false;
    const bitir = function (cikti) {
      if (bitti) return;
      bitti = true;
      cozumle(String(cikti || ''));
    };

    try {
      const cocuk = execFile(
        dosya,
        argumanlar,
        {
          timeout: Number(sureAsimi) > 0 ? Number(sureAsimi) : 9000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8'
        },
        function (hata, ciktiStd) {
          // Komut hata verse bile kısmi çıktı gelmiş olabilir; onu da değerlendiririz.
          bitir(ciktiStd || '');
        }
      );
      cocuk.on('error', function () { bitir(''); });
    } catch (e) {
      bitir('');
    }
  });
}

/** "ANAHTAR=değer" satırlarından oluşan çıktıyı nesneye çevirir. */
function satirlariCoz(cikti) {
  const sonuc = {};
  String(cikti || '').split(/\r?\n/).forEach(function (satir) {
    const yer = satir.indexOf('=');
    if (yer <= 0) return;
    const anahtar = satir.slice(0, yer).trim();
    const deger = satir.slice(yer + 1).trim();
    if (anahtar) sonuc[anahtar] = deger;
  });
  return sonuc;
}

/** Dosyayı okur; yoksa/yetki yoksa boş metin döner (Linux sanal dosyaları için). */
function dosyaOku(yol) {
  try {
    return String(fs.readFileSync(yol, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

/* ==========================================================================
 *  3) PLATFORMA ÖZEL TOPLAYICILAR
 * ========================================================================*/

/* --- WINDOWS ------------------------------------------------------------ */

/*  Tek bir PowerShell çağrısında bütün değerler okunur. Her değer için ayrı
 *  PowerShell başlatmak açılışa saniyeler eklerdi.                          */
const WINDOWS_POWERSHELL = [
  "$ErrorActionPreference='SilentlyContinue';",
  "function Y($a,$d){ Write-Output ($a + '=' + (($d | Where-Object {$_}) -join '')) }",
  "Y 'UUID'    ((Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID);",
  "Y 'KART'    ((Get-CimInstance -ClassName Win32_BaseBoard).SerialNumber);",
  "Y 'BIOS'    ((Get-CimInstance -ClassName Win32_BIOS).SerialNumber);",
  "Y 'ISLEMCI' ((Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).ProcessorId);",
  "Y 'MAKINE'  ((Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid);",
  "Y 'DISK'    ((Get-CimInstance -ClassName Win32_DiskDrive | Where-Object {$_.SerialNumber -and $_.MediaType -notlike '*Removable*'} | Sort-Object -Property Index | Select-Object -First 1).SerialNumber);"
].join(' ');

async function windowsBilesenleri() {
  const bilesenler = satirlariCoz(await komutCalistir(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_POWERSHELL],
    12000
  ));

  /* Yedek yol 1 — PowerShell kapalı/kısıtlı ise MachineGuid'i doğrudan kayıt
     defterinden al. (reg.exe her Windows kurulumunda vardır.)                */
  if (!anlamliMi(bilesenler.MAKINE)) {
    const cikti = await komutCalistir(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      6000
    );
    const eslesme = /MachineGuid\s+REG_SZ\s+([^\s]+)/i.exec(cikti || '');
    if (eslesme) bilesenler.MAKINE = eslesme[1];
  }

  /* Yedek yol 2 — eski sistemlerde CIM yoksa wmic dene. */
  if (!anlamliMi(bilesenler.UUID)) {
    const cikti = await komutCalistir('wmic.exe', ['csproduct', 'get', 'uuid'], 8000);
    const satirlar = String(cikti || '').split(/\r?\n/).map(function (s) { return s.trim(); });
    const deger = satirlar.filter(function (s) { return s && !/^uuid$/i.test(s); })[0];
    if (deger) bilesenler.UUID = deger;
  }

  return bilesenler;
}

/* --- LINUX -------------------------------------------------------------- */

async function linuxBilesenleri() {
  const bilesenler = {
    MAKINE: dosyaOku('/etc/machine-id') || dosyaOku('/var/lib/dbus/machine-id'),
    UUID: dosyaOku('/sys/class/dmi/id/product_uuid'),      // çoğu dağıtımda root gerekir
    KART: dosyaOku('/sys/class/dmi/id/board_serial'),
    BIOS: dosyaOku('/sys/class/dmi/id/product_serial'),
    ISLEMCI: ''
  };

  // /proc/cpuinfo içindeki "Serial" alanı (ARM kartlarda dolu gelir)
  const cpu = dosyaOku('/proc/cpuinfo');
  const seri = /^Serial\s*:\s*(\S+)/im.exec(cpu || '');
  if (seri) bilesenler.ISLEMCI = seri[1];

  // Kök yetkisi yoksa DMI okunamaz; dmidecode varsa oradan denenir.
  if (!anlamliMi(bilesenler.UUID)) {
    bilesenler.UUID = String(await komutCalistir('dmidecode', ['-s', 'system-uuid'], 6000)).trim();
  }

  return bilesenler;
}

/* --- macOS -------------------------------------------------------------- */

async function macosBilesenleri() {
  const cikti = await komutCalistir('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 9000);
  const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/i.exec(cikti || '');
  const seri = /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/i.exec(cikti || '');
  return {
    UUID: uuid ? uuid[1] : '',
    BIOS: seri ? seri[1] : '',
    MAKINE: '',
    KART: '',
    ISLEMCI: ''
  };
}

/**
 * Özete GİRECEK alanlar (platform bazında).
 * Buradaki sıralamanın önemi yoktur; kimlik hesaplanırken alfabetik sıralanır.
 */
const OZETE_GIRENLER = {
  win32: ['UUID', 'KART', 'BIOS', 'ISLEMCI', 'MAKINE'],
  linux: ['UUID', 'KART', 'BIOS', 'ISLEMCI', 'MAKINE'],
  darwin: ['UUID', 'BIOS']
};

async function bilesenleriTopla() {
  if (process.platform === 'win32') return windowsBilesenleri();
  if (process.platform === 'darwin') return macosBilesenleri();
  return linuxBilesenleri();
}

/* ==========================================================================
 *  4) ZAYIF YEDEK — donanımdan hiçbir şey okunamazsa
 *  ---------------------------------------------------------------------------
 *  Sanal makineler ve kilitli kurumsal bilgisayarlarda seri numaraları
 *  okunamayabilir. O zaman kimlik; ağ kartı MAC adresi, makine adı, işlemci
 *  modeli, mimari ve RAM boyutundan üretilir. Bu kimlik "zayıf"tır (guclu:false)
 *  ve BYOM Brain tarafında ek doğrulama istenebilsin diye böyle işaretlenir.
 * ========================================================================*/

/** Sanal/geçici ağ kartlarını eleyerek ilk fiziksel MAC adresini bulur. */
function macAdresiBul() {
  const SANAL_ONEKLER = [
    '00:00:00', '02:00:4c', '00:50:56', '00:0c:29', '00:05:69', '00:1c:14', // VMware
    '08:00:27', '0a:00:27',                                                 // VirtualBox
    '00:15:5d',                                                             // Hyper-V
    '00:16:3e',                                                             // Xen
    '00:ff'                                                                 // Windows sanal bağdaştırıcı
  ];

  let arayuzler = {};
  try { arayuzler = os.networkInterfaces() || {}; } catch (e) { arayuzler = {}; }

  const adaylar = [];
  Object.keys(arayuzler).forEach(function (ad) {
    (arayuzler[ad] || []).forEach(function (bilgi) {
      if (!bilgi || bilgi.internal) return;
      const mac = String(bilgi.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00') return;
      const sanalMi = SANAL_ONEKLER.some(function (onek) { return mac.indexOf(onek) === 0; });
      if (sanalMi) return;
      if (adaylar.indexOf(mac) === -1) adaylar.push(mac);
    });
  });

  // Kart sırası açılışlar arasında değişebildiği için sabit sıralama yapılır.
  adaylar.sort();
  return adaylar[0] || '';
}

function zayifBilesenler() {
  const islemci = (os.cpus() || [])[0] || {};
  return [
    'MAC:' + (macAdresiBul() || 'yok'),
    'HOST:' + sadelestir(os.hostname() || 'bilinmiyor'),
    'CPU-MODEL:' + sadelestir(islemci.model || 'bilinmiyor'),
    'CEKIRDEK:' + String((os.cpus() || []).length),
    'PLATFORM:' + os.platform() + '/' + os.arch(),
    'RAM-GB:' + String(Math.round(os.totalmem() / 1073741824))
  ];
}

/* ==========================================================================
 *  5) KİMLİK ÜRETİMİ
 * ========================================================================*/

/** SHA-256 özetini okunabilir kimliğe çevirir: BYOM-XXXX-XXXX-XXXX-XXXX-XXXX */
function kimligiBicimle(ozet) {
  const kisa = String(ozet).toUpperCase().slice(0, 20);
  return 'BYOM-' + (kisa.match(/.{1,4}/g) || [kisa]).join('-');
}

let _onbellek = null;      // Aynı oturumda tekrar tekrar hesaplanmasın
let _suredekiIslem = null; // Eşzamanlı çağrılarda komutlar iki kez çalışmasın

/**
 * Donanım kimliğini ve teşhis ayrıntılarını üretir.
 *
 * döner = {
 *   hwid        : 'BYOM-A1B2-C3D4-...'   → BYOM Brain'e gönderilen kimlik
 *   ozet        : tam SHA-256 (64 karakter)
 *   guclu       : donanıma gömülü en az 2 kaynak okunabildi mi?
 *   kaynaklar   : ['UUID','KART',…]      → kimliğe katılan alanlar
 *   teshis      : { DISK: '…' }          → kimliğe KATILMAYAN, destek için bilgi
 *   platform    : 'win32' | 'darwin' | 'linux'
 *   uretimZamani: ISO tarih
 * }
 */
async function hwidDetay(yenidenHesapla) {
  if (_onbellek && !yenidenHesapla) return _onbellek;
  if (_suredekiIslem) {
    /* Süren bir hesap varsa YENİDEN HESAPLA istekleri de onu bekler.
       Eskiden yenidenHesapla=true süren işlemi yok sayıp ikinci bir
       PowerShell turu başlatıyordu; ilk tur bitince `_suredekiIslem = null`
       yazdığı için ikinci turun izi siliniyor ve üçüncü bir çağrı ÜÇÜNCÜ
       turu başlatabiliyordu. Açılışta HWID hesabı zaten sürerken kullanıcının
       "Donanım Kimliğini Yenile"ye basması bu duruma yol açıyordu. */
    const suren = _suredekiIslem;
    if (!yenidenHesapla) return suren;
    try { await suren; } catch (e) { /* aşağıda yeniden denenecek */ }
    if (_suredekiIslem && _suredekiIslem !== suren) return _suredekiIslem;
  }

  _suredekiIslem = (async function () {
    let ham = {};
    try {
      ham = (await bilesenleriTopla()) || {};
    } catch (e) {
      console.error('[BYOM/HWID] Donanım bilgisi okunamadı:', e && e.message);
      ham = {};
    }

    const ozeteGirecekler = OZETE_GIRENLER[process.platform] || OZETE_GIRENLER.linux;
    const secilenler = {};
    ozeteGirecekler.forEach(function (alan) {
      if (anlamliMi(ham[alan])) secilenler[alan] = sadelestir(ham[alan]);
    });

    const kaynaklar = Object.keys(secilenler).sort();
    const parcalar = kaynaklar.map(function (alan) { return alan + ':' + secilenler[alan]; });

    /* En az iki donanım kaynağı okunabildiyse kimlik "güçlü"dür. Tek kaynak
       (ör. yalnız MachineGuid) Windows klonlamalarında çakışabilir; o yüzden
       zayıf sayılır ve makineye özgü diğer bilgilerle desteklenir. */
    const guclu = kaynaklar.length >= 2;
    const tumParcalar = guclu ? parcalar : parcalar.concat(zayifBilesenler());

    const imza = 'BYOM-HWID-v1|' + process.platform + '|' + tumParcalar.join('|');
    const ozet = crypto.createHash('sha256').update(imza, 'utf8').digest('hex').toUpperCase();

    const teshis = {};
    Object.keys(ham).forEach(function (alan) {
      if (ozeteGirecekler.indexOf(alan) !== -1) return;
      if (anlamliMi(ham[alan])) teshis[alan] = sadelestir(ham[alan]);
    });

    _onbellek = {
      hwid: kimligiBicimle(ozet),
      ozet: ozet,
      guclu: guclu,
      kaynaklar: kaynaklar,
      teshis: teshis,
      platform: process.platform,
      makineAdi: os.hostname(),
      uretimZamani: new Date().toISOString()
    };
    return _onbellek;
  })();

  const bu = _suredekiIslem;

  /* Kilit HER durumda bırakılır. Eskiden temizleme işlemin İÇİNDE, son satırda
     yapılıyordu: beklenmedik bir hata (ör. crypto çağrısı) o satıra hiç
     ulaşmadan atarsa `_suredekiIslem` sonsuza dek dolu kalır ve uygulama bir
     daha HWID hesaplayamazdı. */
  bu.catch(function () { /* çağıran taraf ele alıyor */ })
    .then(function () {
      if (_suredekiIslem === bu) _suredekiIslem = null;
    });

  return bu;
}

/** Yalnızca kimlik metnini döndürür (en sık kullanılan biçim). */
async function hwidUret() {
  return (await hwidDetay()).hwid;
}

/** Önbelleği temizler — donanım değişikliğinden sonra elle yeniden hesaplamak için.
    SÜREN işlemin kilidine DOKUNULMAZ: kilit de sıfırlansaydı hwidDetay'daki
    kuyruklama dalı ("if (_suredekiIslem)") atlanır ve halihazırda çalışan tura
    PARALEL ikinci bir PowerShell turu başlardı — "Donanım Kimliğini Yenile",
    açılış hesabı sürerken tam olarak buna yol açıyordu. Süren tur kilidi kendi
    finalizer'ında zaten bırakıyor; ardından gelen hwidDetay(true) çağrısı sırası
    gelince temizlenmiş önbellekle yeniden hesaplar. */
function onbellegiTemizle() {
  _onbellek = null;
}

module.exports = {
  hwidUret,
  hwidDetay,
  onbellegiTemizle,
  // Testler / teşhis için dışa açılanlar
  _ic: { anlamliMi, kimligiBicimle, macAdresiBul }
};
