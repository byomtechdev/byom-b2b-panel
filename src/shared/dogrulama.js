/* ============================================================================
 *  MÜŞTERİ DOĞRULAMA MOTORU — TCKN / VKN / GSM
 *  src/shared/dogrulama.js
 *  ---------------------------------------------------------------------------
 *  Panelin HER katmanında aynı kural: arayüz (yeni müşteri formu), ana süreç
 *  (eşitleme öncesi son denetim) ve `node --test`. Sunucudaki ikizi:
 *  `b2b-core/includes/class-b2b-dogrulama.php`. İki taraf AYNI algoritmayı
 *  taşır; biri "geçerli" derken diğerinin "geçersiz" demesi, sahada yazılan bir
 *  müşterinin eşitlemede reddedilmesi demektir — bu yüzden PHP tarafındaki
 *  testler de bu dosyadaki vektörlerle beslenir.
 *
 *  SAF MANTIK: DOM yok, ağ yok, Electron yok. `src/shared/` altında durur
 *  çünkü hem `<script src>` ile arayüze hem `require` ile ana sürece girer.
 *
 *  ┌────────────────────────────────────────────────────────────────────────┐
 *  │ ALGORİTMALAR (resmî kontrol toplamları)                                │
 *  │                                                                        │
 *  │ TCKN (11 hane, ilk hane 0 olamaz):                                     │
 *  │   d[9]  = ((d0+d2+d4+d6+d8)*7 − (d1+d3+d5+d7)) mod 10                  │
 *  │   d[10] = (d0+…+d9) mod 10                                             │
 *  │   Not: ilk fark en az 0 çıkar (tek hanelerin 7 katı ≥ çift hanelerin   │
 *  │   toplamı olmak zorunda değil!) — (7·0 − 36) gibi negatif sonuçlar için │
 *  │   mod işlemi JS'te NEGATİF döner; bu yüzden ((x % 10) + 10) % 10.      │
 *  │                                                                        │
 *  │ VKN (10 hane):                                                         │
 *  │   i = 0..8 için  v = (d[i] + 9 − i) mod 10                             │
 *  │                  c = v ? ((v · 2^(9−i)) mod 9 || 9) : 0                │
 *  │   d[9] = (10 − Σc mod 10) mod 10                                       │
 *  │                                                                        │
 *  │ GSM (Türkiye):                                                         │
 *  │   ^(05\d{2}|\+905\d{2}|5\d{2})[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}$      │
 *  │   Kayıt biçimi: 05XXXXXXXXX (11 hane, boşluksuz)                       │
 *  └────────────────────────────────────────────────────────────────────────┘
 * ==========================================================================*/

(function (kok) {
  'use strict';

  /** Yalnızca rakamları bırakır. Sunucudaki `b2b_sanitize_tax_number` ikizi. */
  function rakamlar(deger) {
    return String(deger === null || deger === undefined ? '' : deger).replace(/[^0-9]/g, '');
  }

  /** JS'te `%` negatif sayıda negatif döner; kontrol toplamı için düzeltilir. */
  function mod10(n) {
    return ((n % 10) + 10) % 10;
  }

  /* ------------------------------------------------------------------ *
   *  TCKN
   * ------------------------------------------------------------------ */

  /**
   * T.C. Kimlik Numarası kontrol toplamı.
   *
   * Uzunluk ve ilk hane denetimi TEK BAŞINA yetmez: "11111111110" gibi diziler
   * kontrol toplamını da geçer — o yüzden bu fonksiyon "gerçek kişiye ait mi"
   * demez, "biçimsel olarak geçerli mi" der. Kimliğin gerçekliğini yalnızca
   * NVİ sorgusu bilir; bu depoda öyle bir şey yok ve olmamalı.
   */
  function tcknGecerli(deger) {
    var s = rakamlar(deger);

    if (11 !== s.length) return false;
    if ('0' === s[0]) return false;

    var d = s.split('').map(Number);

    var tek = d[0] + d[2] + d[4] + d[6] + d[8];
    var cift = d[1] + d[3] + d[5] + d[7];

    if (mod10(tek * 7 - cift) !== d[9]) return false;

    var toplam = 0;

    for (var i = 0; i < 10; i++) toplam += d[i];

    return mod10(toplam) === d[10];
  }

  /* ------------------------------------------------------------------ *
   *  VKN
   * ------------------------------------------------------------------ */

  /**
   * Vergi Kimlik Numarası kontrol toplamı (Maliye).
   *
   * `(v · 2^k) mod 9` sıfır çıkarsa 9 alınır — bu yalnızca v = 9 iken olur
   * (2^k ile 9 aralarında asal). Sunucudaki `b2b_is_valid_vkn` bunu
   * `t === 9` özel durumuyla yazar; ikisi matematiksel olarak AYNI şeydir.
   */
  function vknGecerli(deger) {
    var s = rakamlar(deger);

    if (10 !== s.length) return false;

    var d = s.split('').map(Number);
    var toplam = 0;

    for (var i = 0; i < 9; i++) {
      var v = (d[i] + (9 - i)) % 10;
      var c = 0;

      if (0 !== v) {
        c = (v * Math.pow(2, 9 - i)) % 9;
        if (0 === c) c = 9;
      }

      toplam += c;
    }

    return ((10 - (toplam % 10)) % 10) === d[9];
  }

  /**
   * Uzunluğa göre doğru algoritmayı seçer: 10 hane VKN, 11 hane TCKN.
   *
   * Sahada tek bir alan var ("TCKN / VKN"); kullanıcı hangisini yazdığını
   * seçmek zorunda kalmamalı. Dönen `tur`, sunucuya hangi meta anahtarına
   * yazılacağını söyler.
   */
  function kimlikNoCoz(deger) {
    var s = rakamlar(deger);

    if (10 === s.length) {
      return vknGecerli(s)
        ? { ok: true, tur: 'vkn', deger: s }
        : { ok: false, tur: 'vkn', deger: s, hata: 'Vergi Kimlik No kontrol toplamı tutmuyor.' };
    }

    if (11 === s.length) {
      return tcknGecerli(s)
        ? { ok: true, tur: 'tckn', deger: s }
        : { ok: false, tur: 'tckn', deger: s, hata: 'T.C. Kimlik No kontrol toplamı tutmuyor.' };
    }

    return {
      ok: false,
      tur: '',
      deger: s,
      hata: s.length ? 'Kimlik no 10 hane (VKN) ya da 11 hane (TCKN) olmalı.' : 'Kimlik no boş.'
    };
  }

  /* ------------------------------------------------------------------ *
   *  GSM
   * ------------------------------------------------------------------ */

  /** Şartnamedeki desen — birebir. */
  var GSM_DESEN = /^(05\d{2}|\+905\d{2}|5\d{2})[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}$/;

  /**
   * GSM numarasını 05XXXXXXXXX biçimine getirir; geçersizse boş string.
   *
   * Girdi "+90 532 111 22 33", "0532-111-2233", "5321112233" olabilir —
   * hepsi aynı kayda inmeli, yoksa mükerrer kontrolü aynı müşteriyi üç kez
   * "yeni" sayar.
   */
  function gsmNormalle(deger) {
    var ham = String(deger === null || deger === undefined ? '' : deger).trim();

    if (!GSM_DESEN.test(ham)) return '';

    var s = ham.replace(/[\s\-]/g, '');

    if (0 === s.indexOf('+90')) s = s.slice(3);   // +905xx… → 5xx…
    if (0 === s.indexOf('0')) s = s.slice(1);     // 05xx… → 5xx…

    return 10 === s.length ? '0' + s : '';
  }

  function gsmGecerli(deger) {
    return '' !== gsmNormalle(deger);
  }

  /* ------------------------------------------------------------------ *
   *  YENİ MÜŞTERİ FORMU — toplu denetim
   * ------------------------------------------------------------------ */

  /**
   * Formun tamamını bir kerede denetler; İLK hatayı değil HEPSİNİ döner.
   *
   * Sahadaki plasiyer üç alanı da yanlış yazmışsa üç ayrı tur yerine tek turda
   * görmeli. `iskontoTavani` verilirse iskonto onu aşamaz — bu kural motorda da
   * (plasiyer-siparis-motor) ve sunucuda da var; burada yalnızca formu erken
   * eler.
   */
  function musteriFormuDenetle(form, secenek) {
    form = form || {};
    secenek = secenek || {};

    var hatalar = {};

    if (!String(form.firmaAdi || '').trim()) hatalar.firmaAdi = 'Firma adı boş olamaz.';
    if (!String(form.yetkili || '').trim()) hatalar.yetkili = 'Yetkili ad soyad boş olamaz.';
    if (!String(form.il || '').trim()) hatalar.il = 'İl seçin.';

    var kimlik = kimlikNoCoz(form.kimlikNo);

    if (!kimlik.ok) hatalar.kimlikNo = kimlik.hata;

    var gsm = gsmNormalle(form.telefon);

    if (!gsm) hatalar.telefon = 'Telefon Türkiye GSM biçiminde olmalı (05XX XXX XX XX).';

    var iskonto = Number(form.iskonto);

    if (!Number.isFinite(iskonto) || iskonto < 0 || iskonto > 100) {
      hatalar.iskonto = 'İskonto 0-100 arasında olmalı.';
    } else if (Number.isFinite(Number(secenek.iskontoTavani)) && iskonto > Number(secenek.iskontoTavani)) {
      hatalar.iskonto = 'İskonto tavanınız %' + Number(secenek.iskontoTavani) + '; daha yüksek veremezsiniz.';
    }

    var ok = 0 === Object.keys(hatalar).length;

    return {
      ok: ok,
      hatalar: hatalar,
      /* Temizlenmiş (kayda hazır) hâli — yalnızca ok ise anlamlı. */
      temiz: ok ? {
        firmaAdi: String(form.firmaAdi).trim(),
        yetkili: String(form.yetkili).trim(),
        il: String(form.il).trim(),
        ilce: String(form.ilce || '').trim(),
        telefon: gsm,
        kimlikTuru: kimlik.tur,
        kimlikNo: kimlik.deger,
        iskonto: iskonto
      } : null
    };
  }

  /* ------------------------------------------------------------------ *
   *  DIŞA AKTARIM — çift mod
   * ------------------------------------------------------------------ */

  var Dogrulama = {
    rakamlar: rakamlar,
    tcknGecerli: tcknGecerli,
    vknGecerli: vknGecerli,
    kimlikNoCoz: kimlikNoCoz,
    gsmNormalle: gsmNormalle,
    gsmGecerli: gsmGecerli,
    musteriFormuDenetle: musteriFormuDenetle,
    GSM_DESEN: GSM_DESEN
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Dogrulama;
  }

  if (typeof window !== 'undefined') {
    window.Dogrulama = Dogrulama;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
