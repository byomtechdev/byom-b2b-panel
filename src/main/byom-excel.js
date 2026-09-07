/* ============================================================================
 *  B2B YÖNETİM PANELİ — EXCEL MOTORU (src/main/byom-excel.js)
 *  ---------------------------------------------------------------------------
 *  Ana süreçte çalışır. İki iş yapar:
 *
 *    YAZMA  → Ürün kataloğunu gerçek bir .xlsx (Office Open XML) dosyasına
 *             döker. Başlık satırı dondurulur, süzgeç açılır, sütun
 *             genişlikleri ve para/adet biçimleri hazır gelir.
 *
 *    OKUMA  → .xlsx, .csv ve .xls dosyalarını satır dizisine çevirir
 *             (ilk satır = sütun başlıkları).
 *
 *  NEDEN HARİCİ KÜTÜPHANE YOK
 *  --------------------------
 *  Uygulamanın tek çalışma bağımlılığı electron-updater; kurulum paketi bu
 *  yüzden küçük ve denetlenebilir kalıyor. Bir .xlsx dosyası aslında içinde
 *  XML barındıran bir ZIP arşividir; Node'un yerleşik `zlib` modülü hem
 *  sıkıştırmayı hem açmayı zaten yapıyor. Geriye ZIP kabuğu (yerel başlık +
 *  merkezî dizin + CRC32) ve XML üretimi/ayrıştırması kalıyor — hepsi bu
 *  dosyada.
 *
 *  DESTEKLENEN OKUMA BİÇİMLERİ
 *  ---------------------------
 *   · .xlsx / .xlsm  → ZIP + SpreadsheetML            (tam destek)
 *   · .csv / .txt    → ayraç sezgisi (; , sekme) + UTF-8/Windows-1254
 *   · .xls           → üç ayrı olasılık sırayla denenir:
 *                        1) aslında ZIP ise .xlsx gibi okunur,
 *                        2) aslında HTML tablosu ise (pek çok ERP dışa
 *                           aktarımı böyledir) tablo ayrıştırılır,
 *                        3) gerçek OLE2/BIFF8 ise CFB kabuğu açılıp
 *                           hücre kayıtları okunur.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const zlib = require('zlib');

/* ==========================================================================
 *  BÖLÜM 1 — ZIP KABUĞU
 * ========================================================================*/

/** CRC32 tablosu (bir kez üretilir). */
const CRC_TABLOSU = (function () {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
}());

function crc32(veri) {
  let c = -1;
  for (let i = 0; i < veri.length; i++) c = CRC_TABLOSU[(c ^ veri[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Tarihi MS-DOS zaman/tarih çiftine çevirir (ZIP başlıkları bunu ister). */
function dosTarihi(t) {
  const yil = Math.max(1980, t.getFullYear());
  return {
    saat: ((t.getHours() << 11) | (t.getMinutes() << 5) | (Math.floor(t.getSeconds() / 2))) & 0xFFFF,
    tarih: (((yil - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()) & 0xFFFF
  };
}

/**
 * Girdilerden bir ZIP arşivi kurar.
 * @param {Array<{ad:string, veri:Buffer}>} girdiler
 */
function zipKur(girdiler) {
  const zaman = dosTarihi(new Date());
  const parcalar = [];
  const dizin = [];
  let konum = 0;

  girdiler.forEach(function (g) {
    const ad = Buffer.from(g.ad, 'utf8');
    const ham = g.veri;
    const sikisik = zlib.deflateRawSync(ham, { level: 6 });

    /* Sıkıştırma kazanç sağlamıyorsa (çok kısa parçalar) olduğu gibi sakla. */
    const deflateMi = sikisik.length < ham.length;
    const govde = deflateMi ? sikisik : ham;
    const ozet = crc32(ham);

    const yerel = Buffer.alloc(30);
    yerel.writeUInt32LE(0x04034B50, 0);
    yerel.writeUInt16LE(20, 4);              // gereken sürüm
    yerel.writeUInt16LE(0x0800, 6);          // bayrak: dosya adı UTF-8
    yerel.writeUInt16LE(deflateMi ? 8 : 0, 8);
    yerel.writeUInt16LE(zaman.saat, 10);
    yerel.writeUInt16LE(zaman.tarih, 12);
    yerel.writeUInt32LE(ozet, 14);
    yerel.writeUInt32LE(govde.length, 18);
    yerel.writeUInt32LE(ham.length, 22);
    yerel.writeUInt16LE(ad.length, 26);
    yerel.writeUInt16LE(0, 28);

    parcalar.push(yerel, ad, govde);

    const merkez = Buffer.alloc(46);
    merkez.writeUInt32LE(0x02014B50, 0);
    merkez.writeUInt16LE(20, 4);             // üreten sürüm
    merkez.writeUInt16LE(20, 6);             // gereken sürüm
    merkez.writeUInt16LE(0x0800, 8);
    merkez.writeUInt16LE(deflateMi ? 8 : 0, 10);
    merkez.writeUInt16LE(zaman.saat, 12);
    merkez.writeUInt16LE(zaman.tarih, 14);
    merkez.writeUInt32LE(ozet, 16);
    merkez.writeUInt32LE(govde.length, 20);
    merkez.writeUInt32LE(ham.length, 24);
    merkez.writeUInt16LE(ad.length, 28);
    merkez.writeUInt16LE(0, 30);             // ek alan
    merkez.writeUInt16LE(0, 32);             // açıklama
    merkez.writeUInt16LE(0, 34);             // disk
    merkez.writeUInt16LE(0, 36);             // iç öznitelik
    merkez.writeUInt32LE(0, 38);             // dış öznitelik
    merkez.writeUInt32LE(konum, 42);         // yerel başlığın konumu

    dizin.push(merkez, ad);
    konum += yerel.length + ad.length + govde.length;
  });

  const dizinGovde = Buffer.concat(dizin);

  const son = Buffer.alloc(22);
  son.writeUInt32LE(0x06054B50, 0);
  son.writeUInt16LE(0, 4);
  son.writeUInt16LE(0, 6);
  son.writeUInt16LE(girdiler.length, 8);
  son.writeUInt16LE(girdiler.length, 10);
  son.writeUInt32LE(dizinGovde.length, 12);
  son.writeUInt32LE(konum, 16);
  son.writeUInt16LE(0, 20);

  return Buffer.concat(parcalar.concat([dizinGovde, son]));
}

/**
 * ZIP arşivini { dosyaAdi: Buffer } sözlüğüne açar.
 *
 * Boyutlar MERKEZÎ DİZİNDEN okunur: yerel başlıkta veri tanımlayıcı (bayrak
 * biti 3) kullanılan arşivlerde boyut alanları sıfır gelir. Verinin başladığı
 * konum ise yerel başlıktan hesaplanır; ek alan uzunluğu iki başlıkta farklı
 * olabilir.
 */
function zipAc(tampon) {
  /* Arşivin sonundaki EOCD kaydı geriye doğru aranır (en fazla 64 KB açıklama). */
  let son = -1;
  const enAz = Math.max(0, tampon.length - 66000);
  for (let i = tampon.length - 22; i >= enAz; i--) {
    if (tampon.readUInt32LE(i) === 0x06054B50) { son = i; break; }
  }
  if (son < 0) throw new Error('ZIP sonu (EOCD) bulunamadı.');

  const adet = tampon.readUInt16LE(son + 10);
  let p = tampon.readUInt32LE(son + 16);

  const dosyalar = Object.create(null);

  for (let i = 0; i < adet; i++) {
    if (p + 46 > tampon.length || tampon.readUInt32LE(p) !== 0x02014B50) break;

    const yontem = tampon.readUInt16LE(p + 10);
    const sikisikBoy = tampon.readUInt32LE(p + 20);
    const adBoy = tampon.readUInt16LE(p + 28);
    const ekBoy = tampon.readUInt16LE(p + 30);
    const yorumBoy = tampon.readUInt16LE(p + 32);
    const yerelKonum = tampon.readUInt32LE(p + 42);
    const ad = tampon.toString('utf8', p + 46, p + 46 + adBoy);

    if (yerelKonum + 30 <= tampon.length && tampon.readUInt32LE(yerelKonum) === 0x04034B50) {
      const yAdBoy = tampon.readUInt16LE(yerelKonum + 26);
      const yEkBoy = tampon.readUInt16LE(yerelKonum + 28);
      const bas = yerelKonum + 30 + yAdBoy + yEkBoy;
      const govde = tampon.slice(bas, bas + sikisikBoy);

      try {
        dosyalar[ad] = (yontem === 0) ? govde : zlib.inflateRawSync(govde);
      } catch (e) {
        /* Tek bir parça bozuksa arşivin tamamı çöpe atılmasın. */
        dosyalar[ad] = Buffer.alloc(0);
      }
    }

    p += 46 + adBoy + ekBoy + yorumBoy;
  }

  return dosyalar;
}

/* ==========================================================================
 *  BÖLÜM 2 — XML YARDIMCILARI
 * ========================================================================*/

/**
 * Metni XML gövdesine gömülebilir hâle getirir.
 *
 * Denetim karakterleri (satır sonu ve sekme dışında) XML 1.0'da YASAKTIR;
 * WooCommerce'ten gelen bazı ürün adlarında bunlara rastlanıyor ve tek bir
 * tanesi dosyanın tamamını Excel'de açılamaz hâle getiriyor.
 */
function xmlKacis(metin) {
  return String(metin === null || metin === undefined ? '' : metin)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML metnindeki varlıkları çözer. */
function xmlCoz(metin) {
  return String(metin === null || metin === undefined ? '' : metin)
    .replace(/&#x([0-9a-fA-F]+);/g, function (t, k) { return String.fromCodePoint(parseInt(k, 16)); })
    .replace(/&#(\d+);/g, function (t, k) { return String.fromCodePoint(parseInt(k, 10)); })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Etiketin bir özniteliğini okur. */
function oznitelik(etiket, ad) {
  const e = new RegExp('\\b' + ad.replace(':', '\\:') + '\\s*=\\s*"([^"]*)"');
  const m = e.exec(etiket);
  return m ? m[1] : '';
}

/** 0 → "A", 25 → "Z", 26 → "AA" */
function sutunHarfi(indeks) {
  let s = '';
  let n = indeks;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** "BC12" → 54 (0 tabanlı sütun indeksi). */
function harfSutunu(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const k = ref.charCodeAt(i);
    if (k < 65 || k > 90) break;
    n = n * 26 + (k - 64);
  }
  return n - 1;
}

/* ==========================================================================
 *  BÖLÜM 3 — XLSX YAZMA
 * ========================================================================*/

const XML_BASI = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/* Biçim kimlikleri — sheet1.xml'deki `s="..."` değerleri styles.xml'deki
   cellXfs sırasına karşılık gelir. */
const BICIM = { normal: 0, baslik: 1, para: 2, tamsayi: 3 };

function stilXml() {
  return XML_BASI +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
      '<fonts count="2">' +
        '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
        '<fill><patternFill patternType="none"/></fill>' +
        '<fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1D4ED8"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
        '<border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border>' +
          '<left style="thin"><color rgb="FFCBD5E1"/></left>' +
          '<right style="thin"><color rgb="FFCBD5E1"/></right>' +
          '<top style="thin"><color rgb="FFCBD5E1"/></top>' +
          '<bottom style="thin"><color rgb="FFCBD5E1"/></bottom>' +
          '<diagonal/>' +
        '</border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="center" vertical="center" wrapText="1"/>' +
        '</xf>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/** Tek hücre. Sayısal türlerde değer sayı olarak, aksi hâlde satır içi metin. */
function hucreXml(ref, deger, tur) {
  if (deger === null || deger === undefined || deger === '') {
    /* Boş hücre yine de yazılır: biçim (kenarlık/hizalama) kaybolmasın. */
    return '<c r="' + ref + '"' + (tur === 'para' ? ' s="' + BICIM.para + '"' : '') + '/>';
  }

  if (tur === 'para' || tur === 'tamsayi') {
    const n = Number(deger);
    if (isFinite(n)) {
      const stil = (tur === 'para') ? BICIM.para : BICIM.tamsayi;
      return '<c r="' + ref + '" s="' + stil + '"><v>' + n + '</v></c>';
    }
  }

  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
         xmlKacis(deger) + '</t></is></c>';
}

/**
 * Çalışma sayfası XML'i.
 *
 * @param {Array<{baslik:string, tur?:string, genislik?:number}>} sutunlar
 * @param {Array<Array>} satirlar
 */
function sayfaXml(sutunlar, satirlar) {
  const sonSutun = sutunHarfi(Math.max(0, sutunlar.length - 1));
  const sonSatir = satirlar.length + 1;
  const alan = 'A1:' + sonSutun + sonSatir;

  const genislikler = sutunlar.map(function (s, i) {
    return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
           (Number(s.genislik) > 0 ? Number(s.genislik) : 18) + '" customWidth="1"/>';
  }).join('');

  const baslikSatiri =
    '<row r="1" ht="28" customHeight="1">' +
    sutunlar.map(function (s, i) {
      return '<c r="' + sutunHarfi(i) + '1" s="' + BICIM.baslik + '" t="inlineStr">' +
             '<is><t xml:space="preserve">' + xmlKacis(s.baslik) + '</t></is></c>';
    }).join('') +
    '</row>';

  const govde = satirlar.map(function (satir, y) {
    const r = y + 2;
    const hucreler = sutunlar.map(function (s, i) {
      return hucreXml(sutunHarfi(i) + r, satir[i], s.tur);
    }).join('');
    return '<row r="' + r + '">' + hucreler + '</row>';
  }).join('');

  return XML_BASI +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="' + alan + '"/>' +
      /* Başlık satırı dondurulur: 900 satırlık dökümde sütun adları hep görünür. */
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + genislikler + '</cols>' +
      '<sheetData>' + baslikSatiri + govde + '</sheetData>' +
      '<autoFilter ref="' + alan + '"/>' +
    '</worksheet>';
}

/**
 * .xlsx dosyasını üretir.
 *
 * @param {object} secenek { sayfaAdi, sutunlar, satirlar }
 * @returns {Buffer}
 */
function xlsxUret(secenek) {
  secenek = secenek || {};
  const sutunlar = secenek.sutunlar || [];
  const satirlar = secenek.satirlar || [];
  /* Excel sayfa adı en fazla 31 karakter ve  : \ / ? * [ ]  kabul etmez. */
  const sayfaAdi = String(secenek.sayfaAdi || 'Sayfa1').replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Sayfa1';

  const yaz = function (metin) { return Buffer.from(metin, 'utf8'); };

  return zipKur([
    {
      ad: '[Content_Types].xml',
      veri: yaz(XML_BASI +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>')
    },
    {
      ad: '_rels/.rels',
      veri: yaz(XML_BASI +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>')
    },
    {
      ad: 'xl/workbook.xml',
      veri: yaz(XML_BASI +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
                  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="' + xmlKacis(sayfaAdi) + '" sheetId="1" r:id="rId1"/></sheets>' +
        '</workbook>')
    },
    {
      ad: 'xl/_rels/workbook.xml.rels',
      veri: yaz(XML_BASI +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>')
    },
    { ad: 'xl/styles.xml', veri: yaz(stilXml()) },
    { ad: 'xl/worksheets/sheet1.xml', veri: yaz(sayfaXml(sutunlar, satirlar)) }
  ]);
}

/* ==========================================================================
 *  BÖLÜM 4 — XLSX OKUMA
 * ========================================================================*/

/** Paylaşılan metin havuzu (xl/sharedStrings.xml). */
function paylasilanMetinler(xml) {
  const liste = [];
  if (!xml) return liste;

  const siRx = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  const tRx = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;

  let m;
  while ((m = siRx.exec(xml)) !== null) {
    const govde = m[1] || '';
    let parca = '';
    let t;
    tRx.lastIndex = 0;
    while ((t = tRx.exec(govde)) !== null) parca += xmlCoz(t[1] || '');
    liste.push(parca);
  }

  return liste;
}

/** Sayıyı, gereksiz kayan nokta artığı olmadan metne çevirir. */
function sayiMetni(ham) {
  const n = Number(ham);
  if (!isFinite(n)) return String(ham);
  /* 15 anlamlı basamak: Excel'in kendi hassasiyeti. 0.1+0.2 artığı silinir. */
  return String(Number(n.toPrecision(15)));
}

/** Çalışma sayfası XML'ini yoğun (dense) satır dizisine çevirir. */
function sayfayiCoz(xml, metinler, enFazlaSatir) {
  const satirlar = [];
  if (!xml) return satirlar;

  const govdeM = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
  const govde = govdeM ? govdeM[1] : '';

  const satirRx = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const hucreRx = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

  let sm;
  let siradaki = 0;   // r özniteliği yoksa sıradaki satır numarası

  while ((sm = satirRx.exec(govde)) !== null) {
    const rNo = Number(oznitelik(sm[1], 'r')) || (siradaki + 1);
    siradaki = rNo;

    /* Aradaki boş satırlar da yerini korumalı; sütun eşleştirmesi satır
       numarasına göre önizleme gösteriyor. */
    while (satirlar.length < rNo - 1) satirlar.push([]);

    const hucreler = [];
    const icerik = sm[2] || '';
    let hm;
    let sirali = 0;

    hucreRx.lastIndex = 0;
    while ((hm = hucreRx.exec(icerik)) !== null) {
      const bas = hm[1] || '';
      const ic = hm[2] || '';
      const ref = oznitelik(bas, 'r');
      const sutun = ref ? harfSutunu(ref) : sirali;
      sirali = sutun + 1;

      const tur = oznitelik(bas, 't');
      let deger = '';

      if (tur === 'inlineStr') {
        const tRx = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRx.exec(ic)) !== null) deger += xmlCoz(t[1] || '');
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(ic);
        const ham = vm ? xmlCoz(vm[1]) : '';

        if (tur === 's') {
          const i = Number(ham);
          deger = (isFinite(i) && metinler[i] !== undefined) ? metinler[i] : '';
        } else if (tur === 'b') {
          deger = (ham === '1') ? 'EVET' : 'HAYIR';
        } else if (tur === 'e' || tur === 'str') {
          deger = ham;
        } else {
          deger = ham === '' ? '' : sayiMetni(ham);
        }
      }

      while (hucreler.length < sutun) hucreler.push('');
      hucreler[sutun] = deger;
    }

    satirlar.push(hucreler);

    if (enFazlaSatir > 0 && satirlar.length >= enFazlaSatir) break;
  }

  return satirlar;
}

/** Arşivdeki ilk çalışma sayfasının yolunu ve adını bulur. */
function ilkSayfaYolu(dosyalar) {
  const oku = function (yol) {
    return dosyalar[yol] ? dosyalar[yol].toString('utf8') : '';
  };

  const kitap = oku('xl/workbook.xml');
  const iliskiler = oku('xl/_rels/workbook.xml.rels');

  const sm = /<sheet\b[^>]*\/?>/.exec(kitap);
  if (sm && iliskiler) {
    const ad = xmlCoz(oznitelik(sm[0], 'name'));
    const rid = oznitelik(sm[0], 'r:id') || oznitelik(sm[0], 'id');

    if (rid) {
      const rRx = /<Relationship\b[^>]*\/?>/g;
      let rm;
      while ((rm = rRx.exec(iliskiler)) !== null) {
        if (oznitelik(rm[0], 'Id') !== rid) continue;

        let hedef = oznitelik(rm[0], 'Target').replace(/^\/+/, '');
        if (hedef.indexOf('xl/') !== 0) hedef = 'xl/' + hedef;
        hedef = hedef.replace(/\/\.\//g, '/');

        if (dosyalar[hedef]) return { yol: hedef, ad: ad };
      }
    }
  }

  /* Yedek yol: ilişkiler okunamadıysa alışıldık dosya adı denenir. */
  if (dosyalar['xl/worksheets/sheet1.xml']) return { yol: 'xl/worksheets/sheet1.xml', ad: 'Sayfa1' };

  const ilk = Object.keys(dosyalar).filter(function (a) {
    return /^xl\/worksheets\/[^/]+\.xml$/.test(a);
  }).sort()[0];

  return ilk ? { yol: ilk, ad: 'Sayfa1' } : null;
}

function xlsxOku(tampon, enFazlaSatir) {
  const dosyalar = zipAc(tampon);
  const sayfa = ilkSayfaYolu(dosyalar);
  if (!sayfa) throw new Error('Çalışma kitabında sayfa bulunamadı.');

  const metinler = paylasilanMetinler(
    dosyalar['xl/sharedStrings.xml'] ? dosyalar['xl/sharedStrings.xml'].toString('utf8') : ''
  );

  return {
    bicim: 'xlsx',
    sayfaAdi: sayfa.ad || 'Sayfa1',
    satirlar: sayfayiCoz(dosyalar[sayfa.yol].toString('utf8'), metinler, enFazlaSatir)
  };
}

/* ==========================================================================
 *  BÖLÜM 5 — METİN / CSV OKUMA
 * ========================================================================*/

/* Windows-1254 (Türkçe ANSI) üst yarısı. Excel'in "CSV (MS-DOS/Windows)"
   çıktısı Türkiye'de bu kod sayfasıyla gelir; UTF-8 varsayılırsa ürün
   adlarındaki ş/ğ/İ harfleri bozulur. */
const CP1254_UST = [
  '\u20AC', '\u0081', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '\u008D', '\u008E', '\u008F',
  '\u0090', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
  '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '\u009D', '\u009E', '\u0178'
].join('');

function cp1254Coz(tampon) {
  let s = '';
  for (let i = 0; i < tampon.length; i++) {
    const b = tampon[i];
    if (b < 0x80) { s += String.fromCharCode(b); continue; }
    if (b < 0xA0) { s += CP1254_UST[b - 0x80]; continue; }

    if (b === 0xD0) { s += 'Ğ'; continue; }   // Ğ
    if (b === 0xDD) { s += 'İ'; continue; }   // İ
    if (b === 0xDE) { s += 'Ş'; continue; }   // Ş
    if (b === 0xF0) { s += 'ğ'; continue; }   // ğ
    if (b === 0xFD) { s += 'ı'; continue; }   // ı
    if (b === 0xFE) { s += 'ş'; continue; }   // ş

    s += String.fromCharCode(b);                   // kalanı Latin-1 ile aynı
  }
  return s;
}

/** Tamponu metne çevirir: BOM → UTF-8/UTF-16, bozuk UTF-8 → Windows-1254. */
function metneCevir(tampon) {
  if (tampon.length >= 3 && tampon[0] === 0xEF && tampon[1] === 0xBB && tampon[2] === 0xBF) {
    return tampon.toString('utf8', 3);
  }
  if (tampon.length >= 2 && tampon[0] === 0xFF && tampon[1] === 0xFE) {
    return tampon.toString('utf16le', 2);
  }
  if (tampon.length >= 2 && tampon[0] === 0xFE && tampon[1] === 0xFF) {
    /* UTF-16BE: bayt çiftlerini çevirip utf16le gibi okuruz. */
    const ters = Buffer.from(tampon.slice(2));
    for (let i = 0; i + 1 < ters.length; i += 2) {
      const t = ters[i]; ters[i] = ters[i + 1]; ters[i + 1] = t;
    }
    return ters.toString('utf16le');
  }

  const utf8 = tampon.toString('utf8');
  return (utf8.indexOf('\uFFFD') === -1) ? utf8 : cp1254Coz(tampon);
}

/** Ayraç sezgisi: tırnak dışındaki ilk satırda en çok geçen ayraç kazanır. */
function ayraciSez(metin) {
  const ilk = metin.split(/\r\n|\n|\r/).filter(function (s) { return s.trim() !== ''; })[0] || '';

  const say = { ';': 0, ',': 0, '\t': 0, '|': 0 };
  let tirnakta = false;

  for (let i = 0; i < ilk.length; i++) {
    const k = ilk[i];
    if (k === '"') { tirnakta = !tirnakta; continue; }
    if (!tirnakta && say[k] !== undefined) say[k]++;
  }

  let enIyi = ';';
  Object.keys(say).forEach(function (k) { if (say[k] > say[enIyi]) enIyi = k; });

  return say[enIyi] > 0 ? enIyi : ';';
}

/** RFC 4180 uyumlu ayrıştırma (çift tırnak kaçışı ve satır içi satır sonu). */
function ayrilmisOku(metin, ayrac, enFazlaSatir) {
  const satirlar = [];
  let satir = [];
  let hucre = '';
  let tirnakta = false;
  let i = 0;

  const bitir = function () {
    satir.push(hucre);
    hucre = '';
  };
  const satirBitir = function () {
    bitir();
    satirlar.push(satir);
    satir = [];
  };

  while (i < metin.length) {
    const k = metin[i];

    if (tirnakta) {
      if (k === '"') {
        if (metin[i + 1] === '"') { hucre += '"'; i += 2; continue; }
        tirnakta = false; i++; continue;
      }
      hucre += k; i++; continue;
    }

    if (k === '"') { tirnakta = true; i++; continue; }
    if (k === ayrac) { bitir(); i++; continue; }

    if (k === '\r' || k === '\n') {
      satirBitir();
      if (k === '\r' && metin[i + 1] === '\n') i++;
      i++;
      if (enFazlaSatir > 0 && satirlar.length >= enFazlaSatir) return satirlar;
      continue;
    }

    hucre += k; i++;
  }

  if (hucre !== '' || satir.length) satirBitir();

  /* Sondaki tamamen boş satırlar atılır (dosya sonu satır sonuyla biter). */
  while (satirlar.length && satirlar[satirlar.length - 1].every(function (h) { return String(h).trim() === ''; })) {
    satirlar.pop();
  }

  return satirlar;
}

function csvOku(tampon, enFazlaSatir) {
  const metin = metneCevir(tampon);
  const ayrac = ayraciSez(metin);

  return {
    bicim: 'csv',
    sayfaAdi: 'CSV',
    satirlar: ayrilmisOku(metin, ayrac, enFazlaSatir)
  };
}

/* ==========================================================================
 *  BÖLÜM 6 — HTML TABLOSU (ERP dışa aktarımlarındaki sahte .xls)
 * ========================================================================*/

function htmlTablosuMu(tampon) {
  const bas = tampon.slice(0, 4096).toString('latin1').toLowerCase();
  return bas.indexOf('<table') !== -1 || bas.indexOf('<html') !== -1;
}

function htmlOku(tampon, enFazlaSatir) {
  const metin = metneCevir(tampon);

  const trRx = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRx = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;

  const satirlar = [];
  let tm;

  while ((tm = trRx.exec(metin)) !== null) {
    const hucreler = [];
    let hm;
    tdRx.lastIndex = 0;

    while ((hm = tdRx.exec(tm[1])) !== null) {
      hucreler.push(
        xmlCoz(String(hm[1])
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/gi, ' '))
          .replace(/\s+/g, ' ')
          .trim()
      );
    }

    if (hucreler.length) satirlar.push(hucreler);
    if (enFazlaSatir > 0 && satirlar.length >= enFazlaSatir) break;
  }

  if (!satirlar.length) throw new Error('HTML içinde tablo bulunamadı.');

  return { bicim: 'html', sayfaAdi: 'Tablo', satirlar: satirlar };
}

/* ==========================================================================
 *  BÖLÜM 7 — ESKİ EXCEL (.xls) — OLE2/CFB + BIFF8
 *  --------------------------------------------------------------------------
 *  .xls dosyası bir "Compound File Binary" kabuğudur: içinde küçük bir dosya
 *  sistemi vardır ve tablo verisi "Workbook" adlı akışta BIFF kayıtları
 *  hâlinde durur. Aşağıda yalnızca HÜCRE OKUMAK için gereken en küçük
 *  altküme uygulanır (biçim, formül ağacı, grafik vb. atlanır).
 * ========================================================================*/

const CFB_IMZA = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

function cfbMi(tampon) {
  if (tampon.length < 8) return false;
  for (let i = 0; i < 8; i++) if (tampon[i] !== CFB_IMZA[i]) return false;
  return true;
}

/** CFB kabuğunu açar; akış adı → Buffer sözlüğü döner. */
function cfbAc(tampon) {
  if (tampon.length < 512) throw new Error('Dosya eksik ya da bozuk (OLE2 başlığı tamamlanmamış).');

  const sektorBoy = 1 << tampon.readUInt16LE(30);
  const miniBoy = 1 << tampon.readUInt16LE(32);
  const fatAdedi = tampon.readUInt32LE(44);
  const dizinIlk = tampon.readUInt32LE(48);
  const miniSinir = tampon.readUInt32LE(56);
  const miniFatIlk = tampon.readUInt32LE(60);
  const difatIlk = tampon.readUInt32LE(68);
  const difatAdedi = tampon.readUInt32LE(72);

  const sektor = function (n) {
    const bas = 512 + (n * sektorBoy);
    return tampon.slice(bas, bas + sektorBoy);
  };

  /* --- DIFAT: FAT sektörlerinin listesi --- */
  const fatSektorleri = [];
  for (let i = 0; i < 109 && fatSektorleri.length < fatAdedi; i++) {
    const s = tampon.readUInt32LE(76 + (i * 4));
    if (s <= 0xFFFFFFFA) fatSektorleri.push(s);
  }

  let d = difatIlk;
  for (let adim = 0; adim < difatAdedi && d <= 0xFFFFFFFA; adim++) {
    const blok = sektor(d);
    const kapasite = (sektorBoy / 4) - 1;
    for (let i = 0; i < kapasite && fatSektorleri.length < fatAdedi; i++) {
      const s = blok.readUInt32LE(i * 4);
      if (s <= 0xFFFFFFFA) fatSektorleri.push(s);
    }
    d = blok.readUInt32LE(sektorBoy - 4);
  }

  /* --- FAT: zincir tablosu --- */
  const fat = [];
  fatSektorleri.forEach(function (fs) {
    const blok = sektor(fs);
    for (let i = 0; i + 4 <= blok.length; i += 4) fat.push(blok.readUInt32LE(i));
  });

  /** Bir zinciri baştan sona izleyip sektör numaralarını verir. */
  const zincir = function (bas, tablo) {
    const yol = [];
    let n = bas;
    const gorulen = Object.create(null);

    while (n <= 0xFFFFFFFA && yol.length < 1000000) {
      if (gorulen[n]) break;              // bozuk dosyada sonsuz döngü olmasın
      gorulen[n] = true;
      yol.push(n);
      n = (tablo[n] === undefined) ? 0xFFFFFFFE : tablo[n];
    }
    return yol;
  };

  const zincirVerisi = function (bas, boy) {
    const parcalar = zincir(bas, fat).map(sektor);
    const hepsi = Buffer.concat(parcalar);
    return (boy > 0 && boy <= hepsi.length) ? hepsi.slice(0, boy) : hepsi;
  };

  /* --- Dizin girdileri --- */
  const dizinVeri = zincirVerisi(dizinIlk, 0);
  const girdiler = [];

  for (let p = 0; p + 128 <= dizinVeri.length; p += 128) {
    const adBoy = dizinVeri.readUInt16LE(p + 64);
    const tur = dizinVeri[p + 66];
    if (tur !== 1 && tur !== 2 && tur !== 5) continue;

    const ad = (adBoy > 2) ? dizinVeri.toString('utf16le', p, p + adBoy - 2) : '';

    girdiler.push({
      ad: ad,
      tur: tur,
      bas: dizinVeri.readUInt32LE(p + 116),
      boy: dizinVeri.readUInt32LE(p + 120)
    });
  }

  /* --- Mini akış kabı (kök girdinin akışı) --- */
  const kok = girdiler.filter(function (g) { return g.tur === 5; })[0];
  const miniKap = kok ? zincirVerisi(kok.bas, kok.boy) : Buffer.alloc(0);

  const miniFat = [];
  if (miniFatIlk <= 0xFFFFFFFA) {
    zincir(miniFatIlk, fat).map(sektor).forEach(function (blok) {
      for (let i = 0; i + 4 <= blok.length; i += 4) miniFat.push(blok.readUInt32LE(i));
    });
  }

  const miniVerisi = function (bas, boy) {
    const parcalar = zincir(bas, miniFat).map(function (n) {
      return miniKap.slice(n * miniBoy, (n + 1) * miniBoy);
    });
    const hepsi = Buffer.concat(parcalar);
    return (boy > 0 && boy <= hepsi.length) ? hepsi.slice(0, boy) : hepsi;
  };

  const akislar = Object.create(null);
  girdiler.forEach(function (g) {
    if (g.tur !== 2 || !g.ad) return;
    akislar[g.ad] = (g.boy < miniSinir) ? miniVerisi(g.bas, g.boy) : zincirVerisi(g.bas, g.boy);
  });

  return akislar;
}

/* --- BIFF kayıt türleri --- */
const BIFF = {
  BOF: 0x0809, EOF: 0x000A, BOUNDSHEET: 0x0085, SST: 0x00FC, CONTINUE: 0x003C,
  LABELSST: 0x00FD, LABEL: 0x0204, NUMBER: 0x0203, RK: 0x027E, MULRK: 0x00BD,
  FORMULA: 0x0006, STRING: 0x0207, BOOLERR: 0x0205
};

/** BIFF akışını { tur, veri, konum } kayıtlarına böler. */
function biffKayitlari(akis) {
  const liste = [];
  let p = 0;
  while (p + 4 <= akis.length) {
    const tur = akis.readUInt16LE(p);
    const boy = akis.readUInt16LE(p + 2);
    if (p + 4 + boy > akis.length) break;
    liste.push({ tur: tur, konum: p, veri: akis.slice(p + 4, p + 4 + boy) });
    p += 4 + boy;
  }
  return liste;
}

/** RK sayısını çözer (BIFF'in 4 baytlık sıkıştırılmış sayı biçimi). */
function rkCoz(rk) {
  const yuzMu = (rk & 1) !== 0;
  const tamMi = (rk & 2) !== 0;
  let v;

  if (tamMi) {
    v = (rk | 0) >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeInt32LE(0, 0);
    b.writeInt32LE((rk & 0xFFFFFFFC) | 0, 4);
    v = b.readDoubleLE(0);
  }

  return yuzMu ? (v / 100) : v;
}

/**
 * SST (paylaşılan metin tablosu) okuyucusu.
 *
 * Zorluk: tablo tek bir kayda sığmaz, CONTINUE kayıtlarına taşar ve METNİN
 * ORTASINDA taşabilir. Her CONTINUE'nun ilk baytı, kalan karakterlerin 1 mi
 * 2 bayt mı olduğunu yeniden bildirir. Bu yüzden parçalar birleştirilemez;
 * sınırların farkında olan bir okuyucu gerekir.
 */
function sstOku(parcalar, benzersizAdet) {
  let si = 0;
  let off = 0;

  const kaldi = function () { return si < parcalar.length ? parcalar[si].length - off : 0; };
  const sonrakiParca = function () { si++; off = 0; };

  const u8 = function () {
    while (si < parcalar.length && off >= parcalar[si].length) sonrakiParca();
    if (si >= parcalar.length) return 0;
    return parcalar[si][off++];
  };
  const u16 = function () { const a = u8(); const b = u8(); return a | (b << 8); };
  const u32 = function () { return (u16() | (u16() << 16)) >>> 0; };

  const atla = function (n) {
    let kalan = n;
    while (kalan > 0 && si < parcalar.length) {
      const alinabilir = Math.min(kalan, kaldi());
      if (alinabilir <= 0) { sonrakiParca(); continue; }
      off += alinabilir;
      kalan -= alinabilir;
    }
  };

  const metinler = [];

  for (let n = 0; n < benzersizAdet && si < parcalar.length; n++) {
    const cch = u16();
    let bayrak = u8();
    let genis = (bayrak & 0x01) !== 0;
    const zenginMi = (bayrak & 0x08) !== 0;
    const ekMi = (bayrak & 0x04) !== 0;

    const calisma = zenginMi ? u16() : 0;
    const ekBoy = ekMi ? u32() : 0;

    let metin = '';
    let kalan = cch;

    while (kalan > 0 && si < parcalar.length) {
      let bosluk = kaldi();

      if (bosluk <= 0) {
        /* Yeni parçaya geçildi: kodlama baytı baştan okunur. */
        sonrakiParca();
        if (si >= parcalar.length) break;
        bayrak = parcalar[si][off++];
        genis = (bayrak & 0x01) !== 0;
        continue;
      }

      const p = parcalar[si];

      if (genis) {
        const alinabilir = Math.min(kalan, Math.floor(bosluk / 2));
        if (alinabilir <= 0) { sonrakiParca(); continue; }
        metin += p.toString('utf16le', off, off + (alinabilir * 2));
        off += alinabilir * 2;
        kalan -= alinabilir;
      } else {
        const alinabilir = Math.min(kalan, bosluk);
        for (let i = 0; i < alinabilir; i++) metin += String.fromCharCode(p[off + i]);
        off += alinabilir;
        kalan -= alinabilir;
      }
    }

    atla(calisma * 4);
    atla(ekBoy);

    metinler.push(metin);
  }

  return metinler;
}

/** BIFF8 XLUnicodeString (2 baytlık uzunluk + bayrak) okur. */
function biffMetni(veri, p) {
  if (p + 3 > veri.length) return { metin: '', son: veri.length };

  const cch = veri.readUInt16LE(p);
  const bayrak = veri[p + 2];
  let q = p + 3;

  const zenginMi = (bayrak & 0x08) !== 0;
  const ekMi = (bayrak & 0x04) !== 0;
  const calisma = zenginMi ? veri.readUInt16LE(q) : 0;
  if (zenginMi) q += 2;
  const ekBoy = ekMi ? veri.readUInt32LE(q) : 0;
  if (ekMi) q += 4;

  let metin = '';
  if (bayrak & 0x01) {
    metin = veri.toString('utf16le', q, Math.min(veri.length, q + (cch * 2)));
    q += cch * 2;
  } else {
    for (let i = 0; i < cch && q + i < veri.length; i++) metin += String.fromCharCode(veri[q + i]);
    q += cch;
  }

  return { metin: metin, son: q + (calisma * 4) + ekBoy };
}

function xlsOku(tampon, enFazlaSatir) {
  const akislar = cfbAc(tampon);
  const akis = akislar['Workbook'] || akislar['Book'] || akislar['WORKBOOK'] || akislar['BOOK'];
  if (!akis || !akis.length) throw new Error('Çalışma kitabı akışı bulunamadı.');

  const kayitlar = biffKayitlari(akis);
  if (!kayitlar.length) throw new Error('Çalışma kitabı okunamadı.');

  /* İlk BOF'un sürümü: 0x0600 = BIFF8. Daha eskisi de denenir, ama metin
     kodlaması farklı olduğu için sonuç bozuk çıkabilir; kullanıcıya
     .xlsx/CSV önerilir (bkz. tabloOku). */
  const surum = kayitlar[0].veri.length >= 2 ? kayitlar[0].veri.readUInt16LE(0) : 0;
  if (surum < 0x0500) throw new Error('Çok eski bir Excel biçimi (BIFF' + surum + ').');

  /* --- Genel bölüm: SST ve sayfa listesi --- */
  const sayfalar = [];
  let metinler = [];

  for (let i = 0; i < kayitlar.length; i++) {
    const k = kayitlar[i];

    if (k.tur === BIFF.BOUNDSHEET && k.veri.length >= 8) {
      const konum = k.veri.readUInt32LE(0);
      const tur = k.veri[5];
      const adBoy = k.veri[6];
      const genis = (k.veri[7] & 0x01) !== 0;
      const ad = genis
        ? k.veri.toString('utf16le', 8, Math.min(k.veri.length, 8 + adBoy * 2))
        : k.veri.toString('latin1', 8, Math.min(k.veri.length, 8 + adBoy));

      if (tur === 0) sayfalar.push({ ad: ad, konum: konum });
      continue;
    }

    if (k.tur === BIFF.SST) {
      const parcalar = [k.veri.slice(8)];
      let j = i + 1;
      while (j < kayitlar.length && kayitlar[j].tur === BIFF.CONTINUE) {
        parcalar.push(kayitlar[j].veri);
        j++;
      }
      metinler = sstOku(parcalar, k.veri.readUInt32LE(4));
      i = j - 1;
      continue;
    }

    /* Genel bölüm ilk EOF ile biter; sayfa verisi sonrasında gelir. */
    if (k.tur === BIFF.EOF) break;
  }

  /* --- İlk çalışma sayfasının kayıtları --- */
  const hedef = sayfalar[0];
  let bas = 0;

  if (hedef) {
    for (let i = 0; i < kayitlar.length; i++) {
      if (kayitlar[i].konum === hedef.konum) { bas = i; break; }
    }
  }
  if (!bas) {
    /* Konum eşleşmediyse ilk EOF'tan sonraki ilk BOF'a atla. */
    let ilkSon = kayitlar.findIndex(function (k) { return k.tur === BIFF.EOF; });
    if (ilkSon < 0) ilkSon = 0;
    for (let i = ilkSon + 1; i < kayitlar.length; i++) {
      if (kayitlar[i].tur === BIFF.BOF) { bas = i; break; }
    }
  }

  const satirlar = [];
  const yaz = function (satir, sutun, deger) {
    while (satirlar.length <= satir) satirlar.push([]);
    const s = satirlar[satir];
    while (s.length <= sutun) s.push('');
    s[sutun] = deger;
  };

  let sonFormul = null;

  for (let i = bas + 1; i < kayitlar.length; i++) {
    const k = kayitlar[i];
    const v = k.veri;

    if (k.tur === BIFF.EOF) break;
    if (v.length < 4) continue;

    const satir = v.readUInt16LE(0);
    const sutun = v.readUInt16LE(2);

    if (enFazlaSatir > 0 && satir >= enFazlaSatir) continue;

    switch (k.tur) {
      case BIFF.LABELSST: {
        const isst = v.readUInt32LE(6);
        yaz(satir, sutun, metinler[isst] !== undefined ? metinler[isst] : '');
        break;
      }
      case BIFF.LABEL: {
        yaz(satir, sutun, biffMetni(v, 6).metin);
        break;
      }
      case BIFF.NUMBER: {
        yaz(satir, sutun, sayiMetni(v.readDoubleLE(6)));
        break;
      }
      case BIFF.RK: {
        yaz(satir, sutun, sayiMetni(rkCoz(v.readUInt32LE(6))));
        break;
      }
      case BIFF.MULRK: {
        const adet = Math.floor((v.length - 6) / 6);
        for (let n = 0; n < adet; n++) {
          yaz(satir, sutun + n, sayiMetni(rkCoz(v.readUInt32LE(4 + (n * 6) + 2))));
        }
        break;
      }
      case BIFF.BOOLERR: {
        if (v[7] === 0) yaz(satir, sutun, v[6] ? 'EVET' : 'HAYIR');
        break;
      }
      case BIFF.FORMULA: {
        /* Sonuç 8 bayt. Son iki bayt 0xFFFF ise sayı değil özel değerdir;
           ilk bayt 0 → metin, hemen ardından STRING kaydı gelir. */
        if (v.length >= 14 && v[12] === 0xFF && v[13] === 0xFF) {
          if (v[6] === 0) { sonFormul = { satir: satir, sutun: sutun }; }
          else if (v[6] === 1) { yaz(satir, sutun, v[8] ? 'EVET' : 'HAYIR'); }
        } else if (v.length >= 14) {
          yaz(satir, sutun, sayiMetni(v.readDoubleLE(6)));
        }
        break;
      }
      case BIFF.STRING: {
        if (sonFormul) {
          yaz(sonFormul.satir, sonFormul.sutun, biffMetni(v, 0).metin);
          sonFormul = null;
        }
        break;
      }
      default: break;
    }
  }

  return {
    bicim: 'xls',
    sayfaAdi: (hedef && hedef.ad) || 'Sayfa1',
    satirlar: satirlar
  };
}

/* ==========================================================================
 *  BÖLÜM 8 — DIŞA AÇILAN ARAYÜZ
 * ========================================================================*/

/**
 * Dosyayı biçimine göre okur.
 *
 * @param {string} yol
 * @param {number} enFazlaSatir  0 = sınırsız
 * @returns {{ok:boolean, bicim?:string, sayfaAdi?:string, basliklar?:string[],
 *            satirlar?:string[][], toplam?:number, kirpildi?:boolean, hata?:string}}
 */
function tabloOku(yol, enFazlaSatir) {
  let tampon;

  try {
    tampon = fs.readFileSync(yol);
  } catch (e) {
    return { ok: false, hata: 'Dosya açılamadı: ' + e.message };
  }

  if (!tampon.length) return { ok: false, hata: 'Dosya boş.' };

  /* +1: başlık satırı sınırın dışında tutulur. */
  const sinir = Number(enFazlaSatir) > 0 ? Number(enFazlaSatir) + 1 : 0;
  const uzanti = String(yol).toLowerCase().replace(/^.*\./, '');

  /* İMZA, UZANTIDAN ÖNCE GELİR: sahada .xls uzantılı CSV'ye de, .csv uzantılı
     gerçek çalışma kitabına da rastlanıyor. Dosyanın ilk baytları ne diyorsa o. */
  const zipMi = tampon.length > 4 && tampon[0] === 0x50 && tampon[1] === 0x4B;
  const ole2Mi = cfbMi(tampon);
  const oneri =
    '\n\nDosyayı Excel\'de açıp "Farklı Kaydet → Excel Çalışma Kitabı (*.xlsx)" ' +
    'ya da "CSV (Virgülle ayrılmış)" seçerek yeniden deneyin.';

  let sonuc = null;

  try {
    if (zipMi) sonuc = xlsxOku(tampon, sinir);            // .xlsx / .xlsm (uzantısı ne olursa olsun)
    else if (ole2Mi) sonuc = xlsOku(tampon, sinir);       // gerçek eski Excel (OLE2/BIFF)
    else if (htmlTablosuMu(tampon)) sonuc = htmlOku(tampon, sinir);
    else sonuc = csvOku(tampon, sinir);
  } catch (e) {
    /* İKİLİ biçimlerde metin olarak yeniden denemek YANLIŞ: bozuk bir .xlsx
       ya da .xls, CSV gibi okunduğunda anlamsız tek bir satır üretir ve
       kullanıcı ekranda çöp veriyle karşılaşır. Açıkça hata verilir. */
    if (zipMi || ole2Mi) {
      return { ok: false, hata: 'Dosya okunamadı: ' + ((e && e.message) || e) + oneri };
    }

    /* Metin dosyalarında son bir şans: uzantısı yanlış konmuş dosyalar sık. */
    try {
      sonuc = csvOku(tampon, sinir);
      if (!sonuc.satirlar.length) throw e;
    } catch (e2) {
      return { ok: false, hata: 'Dosya okunamadı: ' + ((e && e.message) || e) + oneri };
    }
  }

  /* Uzantı ikili bir biçimi vaat ediyor ama içerik metinse ve tek sütunluk
     anlamsız bir sonuç çıktıysa kullanıcıyı uyarmak, sessizce çöp göstermekten
     iyidir. */
  if ((uzanti === 'xls' || uzanti === 'xlsx' || uzanti === 'xlsm') && !zipMi && !ole2Mi &&
      sonuc.bicim === 'csv' && (sonuc.satirlar[0] || []).length < 2) {
    return {
      ok: false,
      hata: 'Bu dosya bir Excel çalışma kitabı gibi görünmüyor (uzantısı .' + uzanti + ' olsa da).' + oneri
    };
  }

  const hepsi = (sonuc.satirlar || []).filter(function (s) {
    return s && s.some(function (h) { return String(h === null || h === undefined ? '' : h).trim() !== ''; });
  });

  if (!hepsi.length) return { ok: false, hata: 'Dosyada veri bulunamadı.' };

  const ham = hepsi[0].map(function (h, i) {
    const t = String(h === null || h === undefined ? '' : h).trim();
    return t || ('Sütun ' + sutunHarfi(i));
  });

  /* Başlık satırı, en uzun veri satırı kadar sütuna tamamlanır: bazı
     dosyalarda son sütunların başlığı boş bırakılıyor. */
  const enGenis = hepsi.reduce(function (a, s) { return Math.max(a, s.length); }, ham.length);
  const basliklar = [];
  for (let i = 0; i < enGenis; i++) basliklar.push(ham[i] || ('Sütun ' + sutunHarfi(i)));

  const satirlar = hepsi.slice(1).map(function (s) {
    const d = [];
    for (let i = 0; i < enGenis; i++) {
      const h = s[i];
      d.push(String(h === null || h === undefined ? '' : h).trim());
    }
    return d;
  });

  return {
    ok: true,
    bicim: sonuc.bicim,
    sayfaAdi: sonuc.sayfaAdi || '',
    basliklar: basliklar,
    satirlar: satirlar,
    toplam: satirlar.length,
    kirpildi: sinir > 0 && hepsi.length >= sinir
  };
}

/** Verilen tabloyu .xlsx olarak diske yazar. */
function xlsxYaz(yol, secenek) {
  fs.writeFileSync(yol, xlsxUret(secenek));
  return yol;
}

module.exports = {
  xlsxUret: xlsxUret,
  xlsxYaz: xlsxYaz,
  tabloOku: tabloOku,
  /* Aşağıdakiler DIŞ KULLANIM İÇİN DEĞİL, ayrı ayrı sınanabilsinler diye
     dışa açıldı. Kırılgan olan kısımlar bunlar: ZIP kabuğu, OLE2 dosya
     sistemi ve BIFF metin/sayı kodlamaları. Uygulama yalnızca yukarıdaki
     üç işlevi çağırır. */
  zipKur: zipKur,
  zipAc: zipAc,
  cfbAc: cfbAc,
  biffKayitlari: biffKayitlari,
  sstOku: sstOku,
  rkCoz: rkCoz,
  biffMetni: biffMetni,
  sutunHarfi: sutunHarfi
};
