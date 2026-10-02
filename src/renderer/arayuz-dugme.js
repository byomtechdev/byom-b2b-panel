/* ==========================================================================
 *  ARAYÜZ DÜĞMESİ — meşgul durumu (Faz 20)
 *  -------------------------------------------------------------------------
 *  "Yenile çalışmıyor" şikâyetinin KÖK SEBEBİ ölçüldü: on bir Yenile
 *  düğmesinin on biri de yükleyiciyi gerçekten çağırıyordu, ama HİÇBİRİ geri
 *  bildirim vermiyordu. Veri aynı geldiğinde ekranda hiçbir şey değişmiyor,
 *  kullanıcı tıklamanın işe yaramadığını sanıp art arda basıyor ve her
 *  basış yeni bir ağ turu açıyordu.
 *
 *  Bu modül TEK bir sözleşme koyar:
 *    - iş sürerken düğme `aria-busy="true"` + `disabled` olur, ikonu döner
 *      (dönüş CSS'tedir: index.html › ARAYÜZ SİSTEMİ › meşgul);
 *    - süren işe ikinci basış YENİ İŞ BAŞLATMAZ, süren işin sözünü döndürür;
 *    - iş hata verse de düğme eski hâline döner;
 *    - çok hızlı biten işte meşgul görünüm en az ENAZ_MS kalır — "oldu mu?"
 *      sorusu kalmasın.
 *
 *  ETİKETE DOKUNULMAZ. Eski `butonuMesgulEt` innerHTML'i değiştiriyordu; burada
 *  yalnızca öznitelik değişir: ekran okuyucu "meşgul" der, etiket aynı kalır,
 *  düğmenin genişliği zıplamaz.
 *
 *  DOM'SUZ ÇALIŞIR: yalnızca verilen düğümün öznitelik API'sini kullanır;
 *  jsdom testinde ve tarayıcıda aynı kod koşar.
 * ========================================================================*/
'use strict';

(function () {
  /** Meşgul görünümün en kısa süresi (ms). Yükleyici 30 ms'de bitse bile
   *  dönen ikon bir an görünsün; daha uzunu kullanıcıyı bekletmek olurdu. */
  var ENAZ_MS = 350;

  /** Düğme → süren işin sözü. Düğme belgeden sökülse de bellek tutulmaz. */
  var surenIsler = new WeakMap();

  function bekle(ms) {
    return new Promise(function (coz) { setTimeout(coz, ms); });
  }

  function mesgulMu(dugme) {
    return !!dugme && surenIsler.has(dugme);
  }

  function mesgulYap(dugme) {
    dugme.__dgOncekiKapali = !!dugme.disabled;
    dugme.setAttribute('aria-busy', 'true');
    dugme.disabled = true;
  }

  function serbestBirak(dugme) {
    dugme.removeAttribute('aria-busy');
    dugme.disabled = !!dugme.__dgOncekiKapali;
    delete dugme.__dgOncekiKapali;
  }

  /**
   * İşi, düğmeyi meşgul göstererek çalıştırır.
   *
   * @param {HTMLElement|null} dugme  meşgul gösterilecek düğme (yoksa yalnızca iş koşar)
   * @param {Function}         is     söz döndürebilir de döndürmeyebilir de
   * @param {object}           [secenek] { enAz: ms }
   * @returns {Promise<*>} işin sonucu (hata da aynen geri fırlatılır)
   */
  function calistir(dugme, is, secenek) {
    secenek = secenek || {};

    if ('function' !== typeof is) return Promise.resolve();

    if (!dugme) {
      try { return Promise.resolve(is()); } catch (hata) { return Promise.reject(hata); }
    }

    /* İKİNCİ BASIŞ: yeni tur açılmaz, sürenin sonucu beklenir. */
    if (surenIsler.has(dugme)) return surenIsler.get(dugme);

    var enAz = undefined !== secenek.enAz ? Math.max(0, Number(secenek.enAz) || 0) : ENAZ_MS;
    var baslangic = Date.now();

    mesgulYap(dugme);

    function kalan() {
      var gecen = Date.now() - baslangic;
      return gecen < enAz ? bekle(enAz - gecen) : Promise.resolve();
    }

    /* İş tıklamayla AYNI ANDA başlar (eşzamanlı) — doğrudan bağlanmış eski
       dinleyicinin davranışı buydu: yükleyici "yükleniyor" metnini hemen basar,
       IPC hemen gider. Eşzamanlı fırlatılan hata da sözün reddine çevrilir. */
    var ilk;
    try {
      ilk = Promise.resolve(is());
    } catch (hata) {
      ilk = Promise.reject(hata);
    }

    var soz = ilk
      .then(
        function (deger) { return kalan().then(function () { return deger; }); },
        function (hata) { return kalan().then(function () { throw hata; }); }
      );

    var izlenen = soz.then(
      function (deger) { surenIsler.delete(dugme); serbestBirak(dugme); return deger; },
      function (hata) { surenIsler.delete(dugme); serbestBirak(dugme); throw hata; }
    );

    surenIsler.set(dugme, izlenen);

    return izlenen;
  }

  /**
   * Düğmenin tıklamasını işe bağlar (meşgul durumuyla).
   *
   * Aynı düğmeye ikinci kez bağlanmaz: sekme her açılışta `kur()` çağıran
   * modüllerde çift bağlama TEK TIKTA İKİ İSTEK demekti (§6 kuralı).
   *
   * @returns {boolean} bağlandı mı
   */
  function bagla(dugme, is, secenek) {
    if (!dugme || 'function' !== typeof is) return false;
    if ('1' === dugme.getAttribute('data-dg-bagli')) return false;

    dugme.setAttribute('data-dg-bagli', '1');

    /* Hata burada YAKALANMAZ: doğrudan bağlı eski dinleyicilerde olduğu gibi
       `unhandledrejection` olarak telemetriye düşsün. Düğme yine de kilitli
       kalmaz — serbest bırakma `calistir`ın kendi zincirindedir. */
    dugme.addEventListener('click', function (olay) {
      calistir(dugme, function () { return is(olay); }, secenek);
    });

    return true;
  }

  /* ------------------------------------------------------------------ *
   *  ETİKET BİÇİMİ — BÜYÜK HARF etiketleri "Başlık Düzeni"ne çevirir.
   *  ---------------------------------------------------------------------
   *  Eski arayüzde düğme metinleri çağıran kodun içinde BÜYÜK HARFLE
   *  yazılıydı ("EVET, SİL", "SİLİNİYOR…"). Ortak pencere ve meşgul
   *  yardımcısı bu metinleri her çağrıda yeniden yazdırmadan tek yerde
   *  biçimler. Türkçe kurallı: I → ı, İ → i (`tr-TR`); kısaltmalar
   *  (KDV, PIN, API…) olduğu gibi kalır, ek kesme işaretinden sonra
   *  küçülür (PIN'İ → PIN'i). Zaten karışık düzende yazılmış metne
   *  DOKUNULMAZ — biçim bilinçli verilmiştir.
   * ------------------------------------------------------------------ */
  var KISALTMALAR = {
    KDV: 1, PIN: 1, API: 1, SKU: 1, POS: 1, PDF: 1, B2B: 1, BYOM: 1, ID: 1, TL: 1,
    CSV: 1, XLSX: 1, URL: 1, HWID: 1, SPOT: 1, WC: 1, SMS: 1, OTP: 1, TC: 1,
    VKN: 1, TCKN: 1, ERP: 1, USB: 1, WP: 1
  };
  var KUCUK_KALANLAR = { 've': 1, 'ile': 1, 'veya': 1, 'ya': 1, 'da': 1, 'de': 1, 'için': 1 };
  var HARF = /[A-Za-zÇĞİÖŞÜçğıöşü]/;

  function etiket(metin) {
    var s = (null === metin || undefined === metin) ? '' : String(metin);

    if (!HARF.test(s)) return s;
    if (s !== s.toLocaleUpperCase('tr-TR')) return s;

    var ilkSozcuk = true;

    return s.split(/(\s+)/).map(function (parca) {
      if (!parca || /^\s+$/.test(parca)) return parca;

      var sonuc = parca.split('\'').map(function (kok, i) {
        if (i > 0) return kok.toLocaleLowerCase('tr-TR');

        var yalin = kok.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü0-9]/g, '');
        if (KISALTMALAR[yalin]) return kok;

        var kucuk = kok.toLocaleLowerCase('tr-TR');
        if (!ilkSozcuk && KUCUK_KALANLAR[kucuk]) return kucuk;

        return kucuk.replace(/^([^A-Za-zÇĞİÖŞÜçğıöşü0-9]*)([a-zçğıöşü])/, function (t, on, h) {
          return on + h.toLocaleUpperCase('tr-TR');
        });
      }).join('\'');

      if (HARF.test(parca)) ilkSozcuk = false;

      return sonuc;
    }).join('');
  }

  var ArayuzDugme = {
    ENAZ_MS: ENAZ_MS,
    calistir: calistir,
    bagla: bagla,
    mesgulMu: mesgulMu,
    etiket: etiket
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = ArayuzDugme;
  if (typeof window !== 'undefined') window.ArayuzDugme = ArayuzDugme;
})();
