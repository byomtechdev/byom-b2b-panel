/* ============================================================================
 *  YÖNETİCİ MASTER PIN VE CİHAZ KİLİDİ — ANA SÜREÇ MOTORU
 *  ---------------------------------------------------------------------------
 *  Sahaya verilen laptopta plasiyerin yönetici ekranına geçmesini engeller.
 *  İki ayrı kontrol, tek dosyada:
 *
 *    1) YÖNETİCİ MASTER PIN (6 hane) — "Yönetici Girişi" kapısını açar.
 *    2) CİHAZ ROLÜ — cihaz bir plasiyere tahsis edilirse yönetici kapısı
 *       arayüzden tamamen kalkar; geri dönmek Master PIN ister.
 *
 *  NEDEN BU DOSYA AYRI VE DOM'SUZ:
 *  Doğrulama arayüzde yapılamaz — renderer'da `nodeIntegration: true` olduğu
 *  için orada yazılan her kontrol, aynı konsoldan atlatılabilir. Bu yüzden
 *  hash'leme ve karşılaştırma ana süreçte durur, arayüz yalnızca sonuç alır.
 *  Electron'a hiç dokunmaz (ayar okuma/yazma ENJEKTE edilir), böylece
 *  `node --test` altında doğrudan koşar.
 *
 *  ---------------------------------------------------------------------------
 *  SIR YÖNETİMİ — DÖRT KURAL
 *
 *   1) DÜZ METİN PIN DİSKE YAZILMAZ. Yalnızca scrypt özeti saklanır.
 *      Depodaki geliştirici kilidi tuzsuz SHA-256 kullanıyor ve bu
 *      "kabul edilmiş risk" olarak kayıtlı (BYOM-REGISTRY.md §5.20 madde 18);
 *      YENİ bir güvenlik kontrolünde o kalıbı tekrar etmiyoruz. Her PIN kendi
 *      16 baytlık rastgele tuzunu alır: iki cihazdaki aynı PIN aynı özeti
 *      vermez, hazır tablo (rainbow table) işe yaramaz.
 *
 *   2) ÖZET ARAYÜZE DÖNMEZ. `ayar:oku` kanalı özeti siler, yerine
 *      `yoneticiPinKurulu: true/false` koyar (bkz. maskele). Arayüzün özete
 *      ihtiyacı yok; eline geçerse çevrimdışı deneme yapılabilirdi.
 *
 *   3) KORUMALI ALANLAR GENEL YAZMA KANALINDAN GEÇMEZ. `ayar:yaz` her anahtarı
 *      kabul eden genel bir kanaldır; `cihazRolu` oraya açık kalsaydı kilitli
 *      cihazdaki biri tek satırla kilidi kaldırabilirdi (bkz. suz).
 *
 *   4) DENEME SAYACI DİSKE YAZILIR, belleğe değil. Bellekte tutulsa
 *      uygulamayı kapatıp açmak sayacı sıfırlardı; saha laptopunda bu
 *      "kilit yok" demektir.
 *
 *  ---------------------------------------------------------------------------
 *  ⚠️ DÜRÜST SINIR — OKUMADAN "GÜVENLİ" DEME
 *
 *  Bu katman, cihazı eline alan plasiyerin ARAYÜZDEN yönetici ekranına
 *  geçmesini engeller. Dosya sistemine erişen birine karşı MUTLAK değildir:
 *  `ayarlar.json` düz metin bir dosyadır; elle düzenleyip `cihazRolu`'nü
 *  değiştiren ya da `yoneticiPinHash`'i silip PIN'i yeniden kuran biri kilidi
 *  aşar. 6 haneli PIN de (10^6 olasılık) dosyayı kopyalayan biri için
 *  çevrimdışı denemeye açıktır; scrypt bunu yavaşlatır, imkânsız kılmaz.
 *
 *  Bu, lisans deposundan (`byom-lisans-deposu.js`) bilinçli olarak FARKLI bir
 *  tehdit modelidir: orada korunan şey firmanın parasıdır ve safeStorage/HWID
 *  imzası kullanılır. Burada korunan şey "çalışan yanlış ekranı açmasın"dır.
 *  Daha güçlüsü gerekiyorsa ayar dosyasını HWID-HMAC ile imzalamak gerekir —
 *  ayrı bir görev, çünkü ayar dosyasını elle düzeltebilmek şu anda destek
 *  sürecinin parçası.
 * ==========================================================================*/

'use strict';

const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 *  SABİTLER
 * ------------------------------------------------------------------ */

/** Master PIN hane sayısı — şartname: 6 haneli. */
const PIN_UZUNLUK = 6;

/** Kaç hatalı denemeden sonra kilit? (şartname: 3) */
const EN_COK_DENEME = 3;

/** Kilit süresi saniye (şartname: 60). */
const KILIT_SN = 60;

/**
 * scrypt maliyeti. N=16384 · r=8 · p=1 → ~16 MB bellek, ~50-80 ms.
 *
 * Masaüstünde kullanıcı 80 ms'yi fark etmez; çevrimdışı denemede ise 10^6
 * olasılık tek çekirdekte günlere çıkar. Bu sayıları DÜŞÜRME: tek kazancı
 * ölçülemeyecek bir hız, bedeli kaba kuvvetin kolaylaşması.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const ANAHTAR_BAYT = 32;
const TUZ_BAYT = 16;

/** Cihaz rolleri. */
const ROL_STANDART = 'standart';
const ROL_KILITLI = 'plasiyer_kilitli';

/**
 * Genel `ayar:yaz` kanalından YAZILAMAYAN alanlar.
 *
 * Bu liste güvenliğin kendisidir, süsleme değil: arayüz bu alanları yalnızca
 * bu dosyadaki PIN doğrulamalı yollardan değiştirebilir.
 */
const KORUMALI_ALANLAR = [
  'yoneticiPinHash',
  'yoneticiPinDeneme',
  'yoneticiPinKilitBitis',
  'cihazRolu',
  'tahsisliPlasiyerId',
  'tahsisliPlasiyerAd',
  /* ---- PIN kurtarma (Faz 8) ---- */
  /* Kurtarma deneme sayacı arayüzden sıfırlanabilse yerel kısıtlama anlamsız
     olurdu; sıfırlama damgası da denetim kaydıdır, silinebilir olmamalı. */
  'pinKurtarmaDeneme',
  'pinKurtarmaKilitBitis',
  'yoneticiPinSifirlamaZamani'
];

/* ------------------------------------------------------------------ *
 *  PIN KURTARMA — TALEP KODU (challenge) ve TEK KULLANIMLIK KOD (OTP)
 *  ---------------------------------------------------------------
 *  Akış (düz metin PIN HİÇBİR YERE GİTMEZ):
 *
 *    1) Patron PIN'i unuttu → panel TALEP KODU gösterir.
 *       Talep kodu lisans anahtarı + HWID'den TÜRETİLİR, yani o cihaza
 *       özgüdür ve merkez onu lisans kaydından yeniden hesaplayıp
 *       arayanın gerçekten o cihazın başında olduğunu doğrulayabilir.
 *       SIR DEĞİLDİR — bir kimliktir; telefonda okunmak için vardır.
 *
 *    2) Merkez, o lisans+HWID için TEK KULLANIMLIK bir kod üretir.
 *       Kodun gücü, tekliği ve süresi HUB tarafında tutulur.
 *
 *    3) Patron kodu panele yazar → panel hub'a doğrulatır → PIN yerel
 *       olarak SİLİNİR ve patron yenisini kurar.
 *
 *  Neden bu tasarım (eski düz metin senkronunun yerine):
 *    · Hub PIN'i HİÇ GÖRMEZ. Hub sızıntısı müşteri PIN'lerini açığa çıkarmaz.
 *    · BYOM personeli müşterinin PIN'ini öğrenmez; yalnızca SIFIRLAMA yetkisi
 *      verir. Yetki vermek, sırrı bilmekten daha az ayrıcalıktır.
 *    · Kod tek kullanımlık ve süreli: yakalanan bir kod ikinci kez işlemez.
 *
 *  ⚠️ KALAN RİSK — DÜRÜST NOT:
 *  Her kurtarma yolu SOSYAL MÜHENDİSLİĞE açıktır. Kötü niyetli bir plasiyer
 *  merkezi arayıp patron gibi davranabilir. Bunu panel çözemez; çözüm merkezin
 *  KİMLİK DOĞRULAMASIDIR. Panel tarafındaki karşı önlem denetlenebilirliktir:
 *  her başarılı sıfırlama `yoneticiPinSifirlamaZamani` olarak damgalanır ve
 *  Ayarlar kartında gösterilir — patron "bu PIN ne zaman sıfırlandı?" sorusunu
 *  sorabilir. (Eski düz metin tasarımında bu risk AYNEN vardı; üstelik merkez
 *  PIN'i söylediği için iz bile kalmıyordu.)
 * ------------------------------------------------------------------ */

/**
 * Karıştırılması kolay harfler ÇIKARILMIŞ alfabe (Crockford Base32 ruhu).
 *
 * I, L, O, U yok: telefonda "O mu sıfır mı?" diye sorulmasın. Girdi
 * normalleştirmesi bu harfleri zaten karşılıklarına çevirir.
 */
const KOD_ALFABE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Talep kodu uzunluğu (kimlik; sır değil). */
const TALEP_UZUNLUK = 12;

/** Merkezin verdiği tek kullanımlık kodun uzunluğu. */
const KURTARMA_KOD_UZUNLUK = 8;

/** Kurtarma kodu için yerel deneme tavanı ve kilidi. */
const KURTARMA_MAX_DENEME = 5;
const KURTARMA_KILIT = 900;   // 15 dk

/**
 * Talep kodunu lisans + HWID'den türetir.
 *
 * DETERMİNİST: aynı cihaz her zaman aynı kodu gösterir. Böylece merkez kodu
 * lisans kaydından yeniden hesaplayıp arayanı doğrulayabilir. Rastgele olsaydı
 * merkezin onu önceden bilmesi mümkün olmazdı ve her talebi panelin hub'a
 * kaydetmesi ZORUNLU olurdu — internetsiz bir ofiste akış tamamen tıkanırdı.
 *
 * Tekliği TALEP değil, merkezin verdiği KOD sağlar.
 */
function talepKodu(lisansAnahtari, hwid) {
  const anahtar = String(lisansAnahtari === null || lisansAnahtari === undefined ? '' : lisansAnahtari).trim();
  const cihaz = String(hwid === null || hwid === undefined ? '' : hwid).trim();

  /* Lisans yoksa kurtarmanın bağlanacağı bir kimlik de yok. */
  if (!anahtar) return '';

  const ozet = crypto.createHash('sha256')
    .update(anahtar + '|' + cihaz + '|byom-pin-sifirlama-v1', 'utf8')
    .digest();

  let kod = '';

  for (let i = 0; i < TALEP_UZUNLUK; i++) {
    kod += KOD_ALFABE[ozet[i] % KOD_ALFABE.length];
  }

  /* Dörtlü gruplar: telefonda okunması ve ekranda kontrol edilmesi kolay. */
  return kod.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Kullanıcının yazdığı kodu normalleştirir.
 *
 * Ayırıcıları atar, büyütür ve karıştırılan harfleri çevirir (O→0, I/L→1,
 * U→V). Bu bir kolaylık değil HATA ÖNLEMEDİR: telefonda okunan bir kodda
 * "O" ile "0"ı ayırmak imkânsızdır ve her yazım hatası merkeze ikinci bir
 * çağrı demektir.
 */
function kurtarmaKodunuNormalle(kod) {
  return String(kod === null || kod === undefined ? '' : kod)
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

/** Kod biçim denetimi — ağa çıkmadan önce elenir. */
function kurtarmaKoduBicimi(kod) {
  const temiz = kurtarmaKodunuNormalle(kod);

  if (temiz.length !== KURTARMA_KOD_UZUNLUK) {
    return { ok: false, hata: 'Kurtarma kodu ' + KURTARMA_KOD_UZUNLUK + ' karakter olmalı.' };
  }

  for (let i = 0; i < temiz.length; i++) {
    if (KOD_ALFABE.indexOf(temiz[i]) === -1) {
      return { ok: false, hata: 'Kurtarma kodunda geçersiz karakter var.' };
    }
  }

  return { ok: true, kod: temiz };
}

/** Kurtarma kilidine kalan saniye. */
function kurtarmaKilitKalan(ayarlar, simdi) {
  const bitis = sayi((ayarlar || {}).pinKurtarmaKilitBitis);

  if (!bitis) return 0;

  const kalan = Math.ceil((bitis - simdi) / 1000);

  return kalan > 0 ? kalan : 0;
}

/**
 * Kurtarma denemesini yerel olarak karşılar.
 *
 * Kodun DOĞRULUĞUNA burada karar verilmez — o hub'ın işi. Burada yapılan:
 * biçim elemesi ve hub'ı gereksiz yere dövmeyi engelleyen yerel sayaç.
 *
 * `{ ok: true, kod }` → çağıran hub'a gidebilir.
 */
function kurtarmaDenemesiHazirla(kod, ayarlar, simdi) {
  ayarlar = ayarlar || {};
  simdi = simdi || Date.now();

  const kalanKilit = kurtarmaKilitKalan(ayarlar, simdi);

  if (kalanKilit > 0) {
    return {
      ok: false,
      kilitli: true,
      kilitKalanSn: kalanKilit,
      hata: 'Çok fazla hatalı kurtarma kodu. ' + kalanKilit + ' saniye sonra tekrar deneyin.'
    };
  }

  const bicim = kurtarmaKoduBicimi(kod);

  if (!bicim.ok) return { ok: false, hata: bicim.hata };

  return { ok: true, kod: bicim.kod };
}

/**
 * Hub "kod yanlış" dedi — yerel sayacı ilerletir.
 *
 * Kilit süresi dolmuşsa sayaç sıfırdan başlar (PIN denemesiyle aynı kural).
 */
function kurtarmaBasarisiz(ayarlar, simdi) {
  ayarlar = ayarlar || {};
  simdi = simdi || Date.now();

  const gecmis = sayi(ayarlar.pinKurtarmaKilitBitis) ? 0 : sayi(ayarlar.pinKurtarmaDeneme);
  const deneme = gecmis + 1;

  if (deneme >= KURTARMA_MAX_DENEME) {
    return {
      kilitli: true,
      kilitKalanSn: KURTARMA_KILIT,
      kalanDeneme: 0,
      yazilacak: {
        pinKurtarmaDeneme: deneme,
        pinKurtarmaKilitBitis: simdi + (KURTARMA_KILIT * 1000)
      }
    };
  }

  return {
    kilitli: false,
    kalanDeneme: KURTARMA_MAX_DENEME - deneme,
    yazilacak: { pinKurtarmaDeneme: deneme, pinKurtarmaKilitBitis: 0 }
  };
}

/**
 * PIN'i SİFİRLAR — merkez onayı alındıktan sonra çağrılır.
 *
 * ⚠️ CİHAZ KİLİDİ DE KALKAR — DEĞİŞMEZ KURAL:
 *     «kilitli cihaz ⇒ tanımlı bir PIN vardır»
 *
 * `cihazKilitle` PIN olmadan kilitlemeyi zaten reddediyor. PIN silinip kilit
 * bırakılsaydı cihaz TUĞLAYA dönerdi: kilidi açmak PIN ister, PIN yok, yeni
 * PIN kurmak kilidi açmaz. Bu yüzden sıfırlama ikisini BİRLİKTE temizler.
 *
 * Sıfırlama ZAMANI damgalanır: patron "bu PIN ne zaman, kim tarafından
 * sıfırlandı?" sorusunu sorabilsin. Kurtarma yolunun kaçınılmaz sosyal
 * mühendislik riskine karşı panel tarafındaki tek gerçek karşı önlem budur.
 */
function pinSifirla(ayarlar, simdi) {
  ayarlar = ayarlar || {};
  simdi = simdi || Date.now();

  return {
    ok: true,
    yazilacak: {
      yoneticiPinHash: '',
      yoneticiPinDeneme: 0,
      yoneticiPinKilitBitis: 0,
      pinKurtarmaDeneme: 0,
      pinKurtarmaKilitBitis: 0,
      yoneticiPinSifirlamaZamani: new Date(simdi).toISOString(),
      /* DEĞİŞMEZ KURAL: PIN yoksa kilit de olamaz (bkz. yukarıdaki not). */
      cihazRolu: ROL_STANDART,
      tahsisliPlasiyerId: 0,
      tahsisliPlasiyerAd: ''
    }
  };
}

/* ------------------------------------------------------------------ *
 *  PIN BİÇİMİ
 * ------------------------------------------------------------------ */

/**
 * PIN biçim denetimi.
 *
 * Yalnızca rakam ve TAM 6 hane. "123456 " gibi boşluklu girdiler kırpılır,
 * çünkü kullanıcı farkında olmadan boşluk yapıştırabilir ve sonra kendi
 * PIN'iyle giremez.
 */
function pinBicimi(pin) {
  const temiz = String(pin === null || pin === undefined ? '' : pin).trim();

  if (!/^[0-9]+$/.test(temiz)) {
    return { ok: false, hata: 'PIN yalnızca rakamlardan oluşur.' };
  }
  if (temiz.length !== PIN_UZUNLUK) {
    return { ok: false, hata: 'Yönetici PIN\'i ' + PIN_UZUNLUK + ' haneli olmalı.' };
  }

  return { ok: true, pin: temiz };
}

/* ------------------------------------------------------------------ *
 *  HASH
 * ------------------------------------------------------------------ */

/**
 * PIN'i tuzlu scrypt ile özetler.
 *
 * Biçim: `scrypt$N$r$p$<tuzHex>$<ozetHex>`
 * Parametreler özetin İÇİNDE saklanır; maliyeti ileride artırdığımızda eski
 * özetler okunmaya devam eder (aksi hâlde sahadaki her PIN geçersiz olurdu).
 */
function ozetle(pin) {
  const bicim = pinBicimi(pin);

  if (!bicim.ok) return { ok: false, hata: bicim.hata };

  const tuz = crypto.randomBytes(TUZ_BAYT);
  const ozet = crypto.scryptSync(bicim.pin, tuz, ANAHTAR_BAYT, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
  });

  return {
    ok: true,
    hash: ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, tuz.toString('hex'), ozet.toString('hex')].join('$')
  };
}

/**
 * PIN ile özeti karşılaştırır.
 *
 * `timingSafeEqual` kullanılır: normal `===` karşılaştırması ilk farklı baytta
 * döner ve ölçülebilir zaman farkı bırakır.
 */
function dogrula(pin, hash) {
  const bicim = pinBicimi(pin);

  if (!bicim.ok) return false;
  if (!hash || 'string' !== typeof hash) return false;

  const parca = hash.split('$');

  if (6 !== parca.length || 'scrypt' !== parca[0]) return false;

  const N = Number(parca[1]);
  const r = Number(parca[2]);
  const p = Number(parca[3]);

  if (!(N > 0) || !(r > 0) || !(p > 0)) return false;

  let tuz;
  let beklenen;

  try {
    tuz = Buffer.from(parca[4], 'hex');
    beklenen = Buffer.from(parca[5], 'hex');
  } catch (e) {
    return false;
  }

  if (!tuz.length || !beklenen.length) return false;

  let hesap;

  try {
    hesap = crypto.scryptSync(bicim.pin, tuz, beklenen.length, { N: N, r: r, p: p });
  } catch (e) {
    /* Bozuk/aşırı parametre: özet okunamıyorsa doğrulama BAŞARISIZ sayılır.
       "Okunamadı = geç" demek kilidi tamamen açardı. */
    return false;
  }

  if (hesap.length !== beklenen.length) return false;

  return crypto.timingSafeEqual(hesap, beklenen);
}

/* ------------------------------------------------------------------ *
 *  DURUM OKUMA
 * ------------------------------------------------------------------ */

function sayi(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Kilit bitişine kalan saniye (yoksa 0). */
function kilitKalan(ayarlar, simdi) {
  const bitis = sayi((ayarlar || {}).yoneticiPinKilitBitis);

  if (!bitis) return 0;

  const kalan = Math.ceil((bitis - simdi) / 1000);

  return kalan > 0 ? kalan : 0;
}

/**
 * Arayüze gösterilebilir durum — ÖZET İÇERMEZ.
 */
function durum(ayarlar, simdi) {
  ayarlar = ayarlar || {};
  simdi = simdi || Date.now();

  const rol = ROL_KILITLI === ayarlar.cihazRolu ? ROL_KILITLI : ROL_STANDART;
  const kalan = kilitKalan(ayarlar, simdi);

  return {
    pinKurulu: !!ayarlar.yoneticiPinHash,
    kilitli: kalan > 0,
    kilitKalanSn: kalan,
    kalanDeneme: Math.max(0, EN_COK_DENEME - sayi(ayarlar.yoneticiPinDeneme)),
    cihazRolu: rol,
    cihazKilitli: ROL_KILITLI === rol,
    tahsisliPlasiyerId: sayi(ayarlar.tahsisliPlasiyerId),
    tahsisliPlasiyerAd: String(ayarlar.tahsisliPlasiyerAd || ''),

    /* ---- PIN kurtarma durumu (Faz 8) ---- */
    kurtarmaKilitli: kurtarmaKilitKalan(ayarlar, simdi) > 0,
    kurtarmaKilitKalanSn: kurtarmaKilitKalan(ayarlar, simdi),
    kurtarmaKalanDeneme: Math.max(0, KURTARMA_MAX_DENEME - sayi(ayarlar.pinKurtarmaDeneme)),
    /* DENETIM IZI: patron "bu PIN ne zaman sifirlandi?" diye sorabilsin. */
    sifirlamaZamani: String(ayarlar.yoneticiPinSifirlamaZamani || '')
  };
}

/**
 * Ayar nesnesini arayüze vermeye hazırlar: özeti SİLER, yerine bayrak koyar.
 *
 * Özgün nesne değiştirilmez (kopya döner) — çağıran taraf aynı nesneyi diske
 * yazarsa özeti kaybetmemeli.
 */
function maskele(ayarlar) {
  const kopya = Object.assign({}, ayarlar || {});

  kopya.yoneticiPinKurulu = !!kopya.yoneticiPinHash;
  delete kopya.yoneticiPinHash;

  return kopya;
}

/**
 * Genel yazma kanalından gelen nesneden korumalı alanları AYIKLAR.
 *
 * Sessizce atar, hata vermez: arayüz bütün ayar nesnesini geri yazan yerlerde
 * (`ayar:yaz`, ayarlar formu) bu alanlar maskelenmiş hâlde gelir ve bir
 * "hata" değildir. Önemli olan diske GEÇMEMELERİ.
 */
function suz(gelen) {
  const temiz = Object.assign({}, gelen || {});

  KORUMALI_ALANLAR.forEach(function (alan) { delete temiz[alan]; });

  /* Maskelemenin eklediği türev bayrak da geri yazılmaz. */
  delete temiz.yoneticiPinKurulu;

  return temiz;
}

/* ------------------------------------------------------------------ *
 *  PIN KURMA / DEĞİŞTİRME
 * ------------------------------------------------------------------ */

/**
 * İlk kurulum: PIN yoksa belirler.
 *
 * PIN VARSA REDDEDER. Değiştirmek için `pinDegistir` (eski PIN ister) gerekir;
 * aksi hâlde kilitli cihazdaki biri yeni PIN yazıp yönetici olurdu.
 */
function pinKur(pin, ayarlar) {
  ayarlar = ayarlar || {};

  if (ayarlar.yoneticiPinHash) {
    return { ok: false, hata: 'Yönetici PIN\'i zaten tanımlı.' };
  }

  const sonuc = ozetle(pin);

  if (!sonuc.ok) return { ok: false, hata: sonuc.hata };

  return {
    ok: true,
    yazilacak: {
      yoneticiPinHash: sonuc.hash,
      yoneticiPinDeneme: 0,
      yoneticiPinKilitBitis: 0
    }
  };
}

/** PIN değiştirme — eski PIN doğrulanmadan yenisi yazılmaz. */
function pinDegistir(eski, yeni, ayarlar) {
  ayarlar = ayarlar || {};

  if (!ayarlar.yoneticiPinHash) return { ok: false, hata: 'Tanımlı PIN yok.' };
  if (!dogrula(eski, ayarlar.yoneticiPinHash)) return { ok: false, hata: 'Mevcut PIN hatalı.' };

  const sonuc = ozetle(yeni);

  if (!sonuc.ok) return { ok: false, hata: sonuc.hata };

  return {
    ok: true,
    yazilacak: { yoneticiPinHash: sonuc.hash, yoneticiPinDeneme: 0, yoneticiPinKilitBitis: 0 }
  };
}

/* ------------------------------------------------------------------ *
 *  PIN DENEME (kaba kuvvet kilidi)
 * ------------------------------------------------------------------ */

/**
 * PIN dener; sayaç ve kilidi yönetir.
 *
 * Dönen `yazilacak` alanını çağıran diske yazar — motor diske dokunmaz.
 *
 * SIRA ÖNEMLİ: kilit, PIN kontrolünden ÖNCE bakılır. Sonra bakılsaydı kilitli
 * cihazda doğru PIN'i bulan biri kilidi hiç görmeden geçerdi ve 60 saniye
 * kuralı anlamsızlaşırdı.
 */
function pinDene(pin, ayarlar, simdi) {
  ayarlar = ayarlar || {};
  simdi = simdi || Date.now();

  if (!ayarlar.yoneticiPinHash) {
    return { ok: false, pinKurulu: false, hata: 'Yönetici PIN\'i tanımlı değil.' };
  }

  const kalanKilit = kilitKalan(ayarlar, simdi);

  if (kalanKilit > 0) {
    return {
      ok: false,
      kilitli: true,
      kilitKalanSn: kalanKilit,
      hata: 'Çok fazla hatalı deneme. ' + kalanKilit + ' saniye sonra tekrar deneyin.'
    };
  }

  /* Kilit SÜRESİ DOLMUŞ: sayaç sıfırlanır, kullanıcı yeniden 3 hak alır. */
  const gecmisDeneme = sayi(ayarlar.yoneticiPinKilitBitis) ? 0 : sayi(ayarlar.yoneticiPinDeneme);

  if (dogrula(pin, ayarlar.yoneticiPinHash)) {
    return {
      ok: true,
      yazilacak: { yoneticiPinDeneme: 0, yoneticiPinKilitBitis: 0 }
    };
  }

  const deneme = gecmisDeneme + 1;

  if (deneme >= EN_COK_DENEME) {
    return {
      ok: false,
      kilitli: true,
      kilitKalanSn: KILIT_SN,
      kalanDeneme: 0,
      hata: 'Çok fazla hatalı deneme. Giriş ' + KILIT_SN + ' saniye kilitlendi.',
      yazilacak: { yoneticiPinDeneme: deneme, yoneticiPinKilitBitis: simdi + (KILIT_SN * 1000) }
    };
  }

  return {
    ok: false,
    kilitli: false,
    kalanDeneme: EN_COK_DENEME - deneme,
    hata: 'PIN hatalı. ' + (EN_COK_DENEME - deneme) + ' deneme hakkınız kaldı.',
    yazilacak: { yoneticiPinDeneme: deneme, yoneticiPinKilitBitis: 0 }
  };
}

/* ------------------------------------------------------------------ *
 *  CİHAZ KİLİDİ
 * ------------------------------------------------------------------ */

/**
 * Cihazı bir plasiyere tahsis eder (saha terminali modu).
 *
 * MASTER PIN TANIMLI DEĞİLSE REDDEDİLİR. Kilidi açmanın tek yolu Master
 * PIN'dir; PIN'siz kilitlemek cihazı geri dönüşsüz biçimde kilitlerdi —
 * uygulamayı silip yeniden kurmaktan başka çıkış kalmazdı.
 */
function cihazKilitle(plasiyer, ayarlar) {
  ayarlar = ayarlar || {};
  plasiyer = plasiyer || {};

  if (!ayarlar.yoneticiPinHash) {
    return {
      ok: false,
      hata: 'Önce Yönetici Master PIN\'i belirleyin — kilidi açmanın tek yolu o PIN.'
    };
  }

  const id = sayi(plasiyer.id);
  const ad = String(plasiyer.ad || '').trim();

  if (id <= 0) return { ok: false, hata: 'Pazarlamacı seçilmedi.' };
  if (!ad) return { ok: false, hata: 'Pazarlamacı adı boş olamaz.' };

  return {
    ok: true,
    yazilacak: {
      cihazRolu: ROL_KILITLI,
      tahsisliPlasiyerId: id,
      tahsisliPlasiyerAd: ad
    }
  };
}

/**
 * Cihaz kilidini Master PIN ile açar.
 *
 * Kaba kuvvet sayacı burada da işler: kilit açma ekranı, PIN denemesi için
 * sayaçsız bir arka kapı olmamalı. Bu yüzden `pinDene`'den geçer.
 */
function cihazAc(pin, ayarlar, simdi) {
  ayarlar = ayarlar || {};

  const deneme = pinDene(pin, ayarlar, simdi);

  if (!deneme.ok) return deneme;

  return {
    ok: true,
    yazilacak: Object.assign({}, deneme.yazilacak, {
      cihazRolu: ROL_STANDART,
      tahsisliPlasiyerId: 0,
      tahsisliPlasiyerAd: ''
    })
  };
}

/* ------------------------------------------------------------------ *
 *  DIŞA AKTARIM
 * ------------------------------------------------------------------ */

const YoneticiKilit = {
  PIN_UZUNLUK: PIN_UZUNLUK,
  EN_COK_DENEME: EN_COK_DENEME,
  KILIT_SN: KILIT_SN,
  ROL_STANDART: ROL_STANDART,
  ROL_KILITLI: ROL_KILITLI,
  KORUMALI_ALANLAR: KORUMALI_ALANLAR,

  KOD_ALFABE: KOD_ALFABE,
  TALEP_UZUNLUK: TALEP_UZUNLUK,
  KURTARMA_KOD_UZUNLUK: KURTARMA_KOD_UZUNLUK,
  KURTARMA_MAX_DENEME: KURTARMA_MAX_DENEME,
  KURTARMA_KILIT: KURTARMA_KILIT,

  pinBicimi: pinBicimi,
  ozetle: ozetle,
  dogrula: dogrula,
  durum: durum,
  maskele: maskele,
  suz: suz,
  pinKur: pinKur,
  pinDegistir: pinDegistir,
  pinDene: pinDene,
  cihazKilitle: cihazKilitle,
  cihazAc: cihazAc,

  /* ---- PIN kurtarma (Faz 8) ---- */
  talepKodu: talepKodu,
  kurtarmaKodunuNormalle: kurtarmaKodunuNormalle,
  kurtarmaKoduBicimi: kurtarmaKoduBicimi,
  kurtarmaDenemesiHazirla: kurtarmaDenemesiHazirla,
  kurtarmaBasarisiz: kurtarmaBasarisiz,
  pinSifirla: pinSifirla
};

module.exports = YoneticiKilit;
