/* ============================================================================
 *  ÇEVRİMDIŞI EŞİTLEME MOTORU — DOM'SUZ
 *  src/renderer/plasiyer-sync-motor.js
 *  ---------------------------------------------------------------------------
 *  Sahada yazılan siparişleri, çevrimdışı eklenen müşterileri ve ziyaret
 *  notlarını ağ geri geldiğinde merkeze iletir (Outbox Dispatcher).
 *
 *  SIRA DEĞİŞTİRİLEMEZ — işin kalbi bu:
 *    1) MÜŞTERİLER. `temp_musteri_<uuid>` kayıtları gerçek `user_id`ye çevrilir.
 *    2) KİMLİK KÖPRÜSÜ. Bekleyen siparişlerdeki geçici kimlikler gerçek
 *       kimliklerle DEĞİŞTİRİLİR.
 *    3) SİPARİŞLER. Ancak şimdi gönderilebilir.
 *    4) NOTLAR. Sıradan bağımsız; en sona alındı çünkü en az aciliyetli.
 *  Sunucu geçici kimlikli siparişi 409 ile REDDEDER (bkz. PHP
 *  B2B_REST_Plasiyer::siparis_olustur). Yani sıra yanlışsa siparişler sessizce
 *  değil, GÖRÜNÜR biçimde başarısız olur.
 *
 *  HATA TOLERANSI:
 *   · Başarılı kayıt kuyruktan DÜŞER, başarısız olan KALIR ve sonraki turda
 *     tekrar denenir.
 *   · Bir kaydın patlaması turu DURDURMAZ; sıradakine geçilir.
 *   · AĞ HATASI ile SUNUCU REDDİ ayrılır: ağ hatasında kayıt bekler,
 *     4xx (kalıcı ret) alındığında kayıt `kalici_hata` işaretlenip kuyrukta
 *     bırakılır ama BİR DAHA denenmez — 50 kez aynı 400'ü almanın anlamı yok
 *     ve kullanıcıya gösterilecek bir sebep oluşur.
 *   · Deneme sayacı `deneme` alanında tutulur; EN_COK_DENEME'ye ulaşan kayıt
 *     da kalıcı hata sayılır.
 *
 *  NEDEN DOM'SUZ: bu mantık para ve müşteri kaydı taşır; `node --test` altında
 *  doğrudan koşabilmesi gerekir. Ağ katmanı (`gonderici`) ENJEKTE EDİLİR.
 * ==========================================================================*/

(function (kok) {
  'use strict';

  /** Bir kayıt en çok kaç kez denenir. */
  var EN_COK_DENEME = 5;

  /** Geçici müşteri kimliği öneki — PHP ikizi: B2B_Plasiyer::GECICI_ONEK. */
  var GECICI_ONEK = 'temp_musteri_';

  /** Kuyruk kayıt durumları. */
  var BEKLIYOR = 'bekliyor';
  var GONDERILDI = 'gonderildi';
  var KALICI_HATA = 'kalici_hata';

  /**
   * Sunucu reddetti ama İNSAN KARARIYLA düzeltilebilir (M1).
   *
   * `kalici_hata`dan farkı: o "bu kayıt bir daha asla gitmeyecek" demektir ve
   * kullanıcıya yapacak bir şey bırakmaz. Bu durum ise "hedefi göster, gitsin"
   * der — kuyruk şeridi onarım düğmelerini YALNIZCA bu durumda basar.
   */
  var ONARIM_GEREKLI = 'onarim_gerekli';

  /**
   * Hangi sunucu hata KODLARI onarılabilir sayılır.
   *
   * KOD ŞARTTIR, durum kodu tek başına yetmez: "bilmediğim bir 404" için
   * onarım kapısı açmak, kullanıcıya çözemeyeceği bir düğme göstermek olurdu.
   * Bugün tek üye: müşterisi sunucudan silinmiş sipariş
   * (B2B_REST_Plasiyer::siparis_olustur → 404 b2b_plasiyer_musteri_yok).
   */
  var ONARIM_KODLARI = ['b2b_plasiyer_musteri_yok'];

  /* ------------------------------------------------------------------ *
   *  YARDIMCILAR
   * ------------------------------------------------------------------ */

  function geciciMi(id) {
    return 'string' === typeof id && 0 === id.indexOf(GECICI_ONEK);
  }

  /** Dizi mi? Değilse boş dizi. */
  function dizi(x) {
    return Array.isArray(x) ? x : [];
  }

  /**
   * Retin türü: 'gecici' | 'kalici' | 'onarim'.
   *
   * · 4xx = istek yanlış, tekrar denemek aynı sonucu verir → 'kalici'
   *   (409 HARİÇ: o "önce müşteriyi eşitle" demektir ve sıradaki turda düzelir).
   * · 0 / 5xx / ağ hatası = 'gecici', beklemeye devam.
   * · ONARIM_KODLARI'ndan biri = 'onarim' — sunucu haklı, veri yanlış; insan
   *   hedefi düzeltirse aynı kayıt gider. Tekrar denemek düzeltmez, ama
   *   "kalıcı" damgalamak da kullanıcıyı çaresiz bırakır.
   */
  function retTuru(cevap) {
    var durum = Number((cevap && cevap.durum) || 0);
    var kod = String((cevap && cevap.kod) || '');

    if (kod && ONARIM_KODLARI.indexOf(kod) !== -1) return 'onarim';

    if (409 === durum) return 'gecici';

    return (durum >= 400 && durum < 500) ? 'kalici' : 'gecici';
  }

  /** Yanıt KALICI bir ret mi? (eski sözleşme — `retTuru`ye devreder) */
  function kaliciRet(cevap) {
    return 'kalici' === retTuru(cevap);
  }

  /** Kayıt bir daha OTOMATİK denenmeli mi? */
  function denenebilir(kayit) {
    if (!kayit) return false;
    if (KALICI_HATA === kayit.durum) return false;
    if (ONARIM_GEREKLI === kayit.durum) return false;
    if (GONDERILDI === kayit.durum) return false;

    return (Number(kayit.deneme) || 0) < EN_COK_DENEME;
  }

  /** Kaydı başarısız işaretler ve gerektiğinde kalıcı hataya düşürür. */
  function hataIsle(kayit, cevap) {
    var tur = retTuru(cevap);

    kayit.hata = String((cevap && cevap.hata) || 'Gönderilemedi.');

    /*
     * ONARIM: deneme hakkı YAKILMAZ. Sebep insanın düzeltmesini beklemek;
     * sayaç ilerleseydi kullanıcı hedefi düzelttiğinde kayıt zaten tavana
     * dayanmış olur ve "onardım ama yine gitmiyor" derdi.
     */
    if ('onarim' === tur) {
      kayit.durum = ONARIM_GEREKLI;

      return kayit;
    }

    kayit.deneme = (Number(kayit.deneme) || 0) + 1;
    kayit.durum = BEKLIYOR;

    if ('kalici' === tur || kayit.deneme >= EN_COK_DENEME) {
      kayit.durum = KALICI_HATA;
    }

    return kayit;
  }

  /** Kullanıcıya bildirilecek (yani otomatik turun çözemeyeceği) kayıt mı? */
  function bildirilir(kayit) {
    return !!kayit && (KALICI_HATA === kayit.durum || ONARIM_GEREKLI === kayit.durum);
  }

  /** Özet listesine giren hata kaydı — onarılabilir olan işaretlenir. */
  function hataKaydi(tip, kayit, ek) {
    var k = { tip: tip, hata: kayit.hata };

    if (ONARIM_GEREKLI === kayit.durum) k.onarim = true;

    if (ek) {
      Object.keys(ek).forEach(function (ad) { k[ad] = ek[ad]; });
    }

    return k;
  }

  /**
   * Kaydı yeniden denenebilir hâle getirir (kullanıcı onardı).
   *
   * Deneme sayacı SIFIRLANIR: onarım öncesi yanmış haklar onarımdan sonraki
   * ilk iki denemede kaydı yine kilitlerdi.
   *
   * GÖNDERİLMİŞ kayda dokunmaz — onu yeniden göndermek mükerrer sipariş
   * demektir (sunucunun `yerelKimlik` koruması yakalar ama buraya kadar
   * getirmenin anlamı yok).
   *
   * @param {object} kayit Kuyruk satırı.
   * @returns {boolean} Onarıldı mı?
   */
  function kayitOnar(kayit) {
    if (!kayit) return false;
    if (GONDERILDI === kayit.durum) return false;

    kayit.durum = BEKLIYOR;
    kayit.deneme = 0;
    kayit.hata = '';

    return true;
  }

  /* ------------------------------------------------------------------ *
   *  1) MÜŞTERİLER
   * ------------------------------------------------------------------ */

  /**
   * Çevrimdışı müşterileri sunucuya kaydeder.
   *
   * @param {Array}    musteriler Yerel müşteri listesi.
   * @param {function} gonder     async (gecici) => { ok, durum, veri:{ user_id } }
   * @returns {Promise<object>} { kopru, gonderilen, kalan, hatalar }
   */
  async function musterileriEsitle(musteriler, gonder) {
    var liste = dizi(musteriler);
    var kopru = {};      // temp_musteri_x -> 42
    var gonderilen = 0;
    var hatalar = [];

    for (var i = 0; i < liste.length; i++) {
      var m = liste[i];

      if (!m || !geciciMi(m.id)) continue;

      /* Zaten eşitlenmişse köprüyü kur ve geç. */
      if (m.senkron && Number(m.gercekId)) {
        kopru[m.id] = Number(m.gercekId);
        continue;
      }

      if (!denenebilir(m)) {
        if (bildirilir(m)) hatalar.push(hataKaydi('musteri', m, { id: m.id }));
        continue;
      }

      var cevap;

      try {
        cevap = await gonder(m);
      } catch (e) {
        cevap = { ok: false, durum: 0, hata: (e && e.message) || 'Ağ hatası.' };
      }

      var yeniId = Number((cevap && cevap.veri && cevap.veri.user_id) || 0);

      if (cevap && cevap.ok && yeniId) {
        m.senkron = true;
        m.gercekId = yeniId;
        m.durum = GONDERILDI;
        m.hata = '';

        kopru[m.id] = yeniId;
        gonderilen++;
      } else {
        hataIsle(m, cevap);

        if (bildirilir(m)) hatalar.push(hataKaydi('musteri', m, { id: m.id }));
      }
    }

    return {
      kopru: kopru,
      gonderilen: gonderilen,
      kalan: liste.filter(function (m) { return m && geciciMi(m.id) && !m.senkron; }).length,
      hatalar: hatalar
    };
  }

  /* ------------------------------------------------------------------ *
   *  2) KİMLİK KÖPRÜSÜ
   * ------------------------------------------------------------------ */

  /**
   * Bekleyen siparişlerdeki geçici müşteri kimliklerini gerçek kimliklerle
   * değiştirir.
   *
   * Köprüde karşılığı OLMAYAN sipariş DOKUNULMADAN bırakılır: müşterisi
   * henüz eşitlenmemiş bir siparişi göndermek sunucudan 409 alır ve boşa
   * deneme sayacı yakar.
   *
   * @param {Array}  kuyruk Sipariş kuyruğu.
   * @param {object} kopru  temp_musteri_x -> user_id
   * @returns {object} { koprulenen, bekleyen }
   */
  function kimlikKoprusuKur(kuyruk, kopru) {
    var liste = dizi(kuyruk);
    var koprulenen = 0;
    var bekleyen = 0;

    kopru = kopru || {};

    liste.forEach(function (satir) {
      var kayit = satir && satir.kayit;

      if (!kayit) return;

      if (!geciciMi(kayit.musteriId)) return;

      if (Object.prototype.hasOwnProperty.call(kopru, kayit.musteriId)) {
        kayit.geciciKimlik = kayit.musteriId;   // izi sakla (teşhis)

        /*
         * --- KURTARMA VERİSİ YOK EDİLMEZ (M1) ---
         *
         * Künye SATIRDA yedeklenir, GÖVDEDE değil: gövde `/plasiyer/siparis`
         * şemasıdır ve `geciciMusteri` diye bir alanı yoktur — yedeği oraya
         * koymak sunucu sözleşmesini sessizce büyütürdü.
         *
         * Eskiden burada künye `null`lanıyor, yerel müşteri kaydı da
         * `esitlenenMusterileriTemizle` ile düşüyordu; geriye yalnızca bir
         * sayı kalıyordu. O sayının gösterdiği kullanıcı sunucuda silinince
         * (sahada oldu) elde HİÇBİR ŞEY kalmıyor ve sipariş sonsuza dek
         * kilitleniyordu.
         */
        if (kayit.geciciMusteri && !satir.musteriKunyesi) {
          satir.musteriKunyesi = kayit.geciciMusteri;
        }

        kayit.musteriId = Number(kopru[kayit.musteriId]);
        kayit.geciciMusteri = null;             // sunucuda artık var
        koprulenen++;
      } else {
        bekleyen++;
      }
    });

    return { koprulenen: koprulenen, bekleyen: bekleyen };
  }

  /**
   * Aynı köprüyü ZİYARET NOTLARINA uygular (Faz 9).
   *
   * Not kayıtları düzdür (`kayit` sarmalı yok): `musteriId` doğrudan
   * kaydın üstünde. Çevrimdışı müşteriye yazılan not `temp_musteri_<uuid>`
   * metniyle bekler; müşteri eşitlenince gerçek kimliğe çevrilir. Karşılığı
   * olmayan not DOKUNULMADAN bırakılır (sıradaki tur).
   *
   * @param {Array}  notlar Not kuyruğu.
   * @param {object} kopru  temp_musteri_x -> user_id
   * @returns {object} { koprulenen, bekleyen }
   */
  function notKoprusuKur(notlar, kopru) {
    var liste = dizi(notlar);
    var koprulenen = 0;
    var bekleyen = 0;

    kopru = kopru || {};

    liste.forEach(function (not) {
      if (!not || !geciciMi(not.musteriId)) return;

      if (Object.prototype.hasOwnProperty.call(kopru, not.musteriId)) {
        not.geciciKimlik = not.musteriId;
        not.musteriId = Number(kopru[not.musteriId]);
        koprulenen++;
      } else {
        bekleyen++;
      }
    });

    return { koprulenen: koprulenen, bekleyen: bekleyen };
  }

  /* ------------------------------------------------------------------ *
   *  3) SİPARİŞLER
   * ------------------------------------------------------------------ */

  /**
   * Bekleyen siparişleri gönderir.
   *
   * @param {Array}    kuyruk Sipariş kuyruğu.
   * @param {function} gonder async (kayit) => { ok, durum, veri:{ siparisId } }
   * @returns {Promise<object>} { gonderilen, kalan, hatalar }
   */
  async function siparisleriGonder(kuyruk, gonder) {
    var liste = dizi(kuyruk);
    var gonderilen = 0;
    var hatalar = [];

    for (var i = 0; i < liste.length; i++) {
      var satir = liste[i];

      if (!satir || !satir.kayit) continue;
      if (GONDERILDI === satir.durum) continue;

      if (!denenebilir(satir)) {
        if (bildirilir(satir)) hatalar.push(hataKaydi('siparis', satir, { yerelKimlik: satir.kayit && satir.kayit.yerelKimlik }));
        continue;
      }

      /* Müşterisi hâlâ geçiciyse GÖNDERİLMEZ: sunucu 409 döndürür ve deneme
         sayacı boşa yanar. Sıradaki turda müşteri eşitlenince gider. */
      if (geciciMi(satir.kayit.musteriId)) {
        satir.hata = 'Müşteri henüz eşitlenmedi.';
        continue;
      }

      var cevap;

      try {
        cevap = await gonder(satir.kayit);
      } catch (e) {
        cevap = { ok: false, durum: 0, hata: (e && e.message) || 'Ağ hatası.' };
      }

      if (cevap && cevap.ok && cevap.veri && cevap.veri.siparisId) {
        satir.durum = GONDERILDI;
        satir.siparisId = Number(cevap.veri.siparisId);
        satir.hata = '';
        gonderilen++;
      } else {
        hataIsle(satir, cevap);

        if (bildirilir(satir)) hatalar.push(hataKaydi('siparis', satir, { yerelKimlik: satir.kayit && satir.kayit.yerelKimlik }));
      }
    }

    return {
      gonderilen: gonderilen,
      kalan: liste.filter(function (s) { return s && GONDERILDI !== s.durum; }).length,
      hatalar: hatalar
    };
  }

  /* ------------------------------------------------------------------ *
   *  4) ZİYARET NOTLARI
   * ------------------------------------------------------------------ */

  /**
   * Bekleyen ziyaret notlarını gönderir.
   *
   * @param {Array}    notlar Not kuyruğu.
   * @param {function} gonder async (not) => { ok, durum, veri:{ notId } }
   * @returns {Promise<object>} { gonderilen, kalan, hatalar }
   */
  async function notlariGonder(notlar, gonder) {
    var liste = dizi(notlar);
    var gonderilen = 0;
    var hatalar = [];

    for (var i = 0; i < liste.length; i++) {
      var not = liste[i];

      if (!not) continue;
      if (GONDERILDI === not.durum) continue;

      if (!denenebilir(not)) {
        if (bildirilir(not)) hatalar.push(hataKaydi('not', not, { yerelKimlik: not.yerelKimlik }));
        continue;
      }

      var cevap;

      try {
        cevap = await gonder(not);
      } catch (e) {
        cevap = { ok: false, durum: 0, hata: (e && e.message) || 'Ağ hatası.' };
      }

      if (cevap && cevap.ok && cevap.veri && cevap.veri.notId) {
        not.durum = GONDERILDI;
        not.notId = Number(cevap.veri.notId);
        not.hata = '';
        gonderilen++;
      } else {
        hataIsle(not, cevap);

        if (bildirilir(not)) hatalar.push(hataKaydi('not', not, { yerelKimlik: not.yerelKimlik }));
      }
    }

    return {
      gonderilen: gonderilen,
      kalan: liste.filter(function (n) { return n && GONDERILDI !== n.durum; }).length,
      hatalar: hatalar
    };
  }

  /* ------------------------------------------------------------------ *
   *  TEMİZLİK
   * ------------------------------------------------------------------ */

  /**
   * Gönderilmiş kayıtları kuyruktan düşürür.
   *
   * KALICI HATALI KAYITLAR KALIR: kullanıcıya "şu sipariş gitmedi, sebebi bu"
   * diyebilmek için. Sessizce silmek, plasiyerin yazdığı siparişin
   * kaybolduğunu kimsenin fark etmemesi olurdu.
   *
   * @param {Array} liste Kuyruk.
   * @returns {Array} temizlenmiş kuyruk
   */
  function gonderilenleriTemizle(liste) {
    return dizi(liste).filter(function (k) { return k && GONDERILDI !== k.durum; });
  }

  /**
   * Kuyrukta HÂLÂ bekleyen kayıtların bağlı olduğu geçici kimlikler.
   *
   * Hem köprülenmiş satırın izini (`geciciKimlik`) hem henüz köprülenmemiş
   * satırın kimliğini (`musteriId`) toplar.
   *
   * @param {object} kuyruklar { siparisler, notlar }
   * @returns {object} { 'temp_musteri_x': true }
   */
  function bagliKimlikler(kuyruklar) {
    var harita = {};

    function isaretle(deger) {
      if (geciciMi(deger)) harita[String(deger)] = true;
    }

    dizi(kuyruklar && kuyruklar.siparisler).forEach(function (satir) {
      if (!satir || GONDERILDI === satir.durum || !satir.kayit) return;

      isaretle(satir.kayit.geciciKimlik);
      isaretle(satir.kayit.musteriId);
    });

    dizi(kuyruklar && kuyruklar.notlar).forEach(function (not) {
      if (!not || GONDERILDI === not.durum) return;

      isaretle(not.geciciKimlik);
      isaretle(not.musteriId);
    });

    return harita;
  }

  /**
   * Eşitlenmiş müşterileri yerel listeden düşürür.
   *
   * KUYRUKLAR VERİLİRSE, bekleyen siparişi/notu olan eşitlenmiş müşteri
   * KALIR (M1). Sebep: kayıt düşünce `temp → gerçek kimlik` köprü haritası da
   * ölüyor; sunucudaki kullanıcı sonradan silinirse (sahada oldu) siparişi
   * hangi müşteriye bağlayacağımızı söyleyecek hiçbir veri kalmıyordu.
   * İşi biten müşteri yine düşer — liste şişmez.
   *
   * İkinci argüman verilmezse eski davranış aynen sürer (geriye uyum).
   *
   * @param {Array}  liste     Yerel müşteri listesi.
   * @param {object} [kuyruklar] { siparisler, notlar }
   * @returns {Array}
   */
  function esitlenenMusterileriTemizle(liste, kuyruklar) {
    var tutulan = kuyruklar ? bagliKimlikler(kuyruklar) : null;

    return dizi(liste).filter(function (m) {
      if (!m) return false;
      if (!m.senkron) return true;
      if (!tutulan) return false;

      return true === tutulan[String(m.id)];
    });
  }

  /* ------------------------------------------------------------------ *
   *  TAM TUR
   * ------------------------------------------------------------------ */

  /**
   * Bütün kuyruğu tek turda boşaltmayı dener.
   *
   * @param {object} kuyruklar { musteriler, siparisler, notlar }
   * @param {object} gonderici { musteri, siparis, not } — üç async fonksiyon
   * @returns {Promise<object>} özet
   */
  async function esitle(kuyruklar, gonderici) {
    kuyruklar = kuyruklar || {};
    gonderici = gonderici || {};

    var ozet = {
      ok: true,
      musteri: { gonderilen: 0, kalan: 0 },
      siparis: { gonderilen: 0, kalan: 0 },
      not: { gonderilen: 0, kalan: 0 },
      koprulenen: 0,
      hatalar: []
    };

    /* --- 1) Müşteriler --- */
    if ('function' === typeof gonderici.musteri) {
      var m = await musterileriEsitle(kuyruklar.musteriler, gonderici.musteri);

      ozet.musteri = { gonderilen: m.gonderilen, kalan: m.kalan };
      ozet.hatalar = ozet.hatalar.concat(m.hatalar);

      /* --- 2) Kimlik köprüsü — siparişler VE notlar --- */
      var k = kimlikKoprusuKur(kuyruklar.siparisler, m.kopru);
      var kn = notKoprusuKur(kuyruklar.notlar, m.kopru);
      ozet.koprulenen = k.koprulenen + kn.koprulenen;
    }

    /* --- 3) Siparişler --- */
    if ('function' === typeof gonderici.siparis) {
      var s = await siparisleriGonder(kuyruklar.siparisler, gonderici.siparis);

      ozet.siparis = { gonderilen: s.gonderilen, kalan: s.kalan };
      ozet.hatalar = ozet.hatalar.concat(s.hatalar);
    }

    /* --- 4) Notlar --- */
    if ('function' === typeof gonderici.not) {
      var n = await notlariGonder(kuyruklar.notlar, gonderici.not);

      ozet.not = { gonderilen: n.gonderilen, kalan: n.kalan };
      ozet.hatalar = ozet.hatalar.concat(n.hatalar);
    }

    ozet.ok = 0 === ozet.hatalar.length;
    ozet.toplamGonderilen = ozet.musteri.gonderilen + ozet.siparis.gonderilen + ozet.not.gonderilen;

    return ozet;
  }

  /**
   * Kullanıcıya gösterilecek sessiz bildirim metni.
   *
   * Hiç iş yapılmadıysa BOŞ döner: "0 sipariş iletildi" demek gürültüdür.
   *
   * @param {object} ozet esitle() çıktısı.
   * @returns {string}
   */
  function ozetMesaji(ozet) {
    if (!ozet || !ozet.toplamGonderilen) return '';

    var parcalar = [];

    if (ozet.siparis.gonderilen) parcalar.push(ozet.siparis.gonderilen + ' adet bekleyen sipariş merkeze iletildi');
    if (ozet.musteri.gonderilen) parcalar.push(ozet.musteri.gonderilen + ' yeni müşteri kaydedildi');
    if (ozet.not.gonderilen) parcalar.push(ozet.not.gonderilen + ' ziyaret notu gönderildi');

    var mesaj = parcalar.join(', ') + '.';

    if (ozet.hatalar.length) {
      mesaj += ' ' + ozet.hatalar.length + ' kayıt gönderilemedi.';
    }

    return mesaj;
  }

  /* ------------------------------------------------------------------ *
   *  OTOMATİK TETİKLEME KARARI (Faz 4)
   * ------------------------------------------------------------------ */

  /**
   * Şimdi eşitleme denenmeli mi?
   *
   * `sync:durum` çıktısına bakar. Karar SAF tutuldu ki test edilebilsin;
   * dinleyiciyi kuran taraf (plasiyer-otosync.js) yalnızca bunu çağırır.
   *
   * YAPILACAK İŞ YOKSA AĞA ÇIKILMAZ: her 60 saniyede boşa istek atmak
   * müşterinin sitesini gereksiz yorar ve sahada veri kotasını yakar.
   *
   * @param {object} durum { suruyor, siparis, musteri, not, hatali }
   * @returns {boolean}
   */
  function esitlemeGerekliMi(durum) {
    if (!durum || !durum.ok) return false;
    if (durum.suruyor) return false;

    var siparis = Number(durum.siparis) || 0;
    var musteri = Number(durum.musteri) || 0;
    var not = Number(durum.not) || 0;
    var hatali = Number(durum.hatali) || 0;

    var bekleyen = siparis + musteri + not;

    if (bekleyen <= 0) return false;

    /*
     * HEPSİ KALICI HATALIYSA DENEMEYİZ. Aksi halde 4xx almış bir kayıt
     * yüzünden dakikada bir boşa istek atılır ve kuyruk hiç boşalmaz.
     * Kullanıcı o kayıtları zaten listede görüyor.
     */
    if (hatali >= bekleyen) return false;

    return true;
  }

  var Sync = {
    esitlemeGerekliMi: esitlemeGerekliMi,
    musterileriEsitle: musterileriEsitle,
    kimlikKoprusuKur: kimlikKoprusuKur,
    notKoprusuKur: notKoprusuKur,
    siparisleriGonder: siparisleriGonder,
    notlariGonder: notlariGonder,
    gonderilenleriTemizle: gonderilenleriTemizle,
    esitlenenMusterileriTemizle: esitlenenMusterileriTemizle,
    esitle: esitle,
    ozetMesaji: ozetMesaji,
    /* saf yardımcılar */
    geciciMi: geciciMi,
    retTuru: retTuru,
    kaliciRet: kaliciRet,
    denenebilir: denenebilir,
    bildirilir: bildirilir,
    kayitOnar: kayitOnar,
    bagliKimlikler: bagliKimlikler,
    /* sabitler */
    EN_COK_DENEME: EN_COK_DENEME,
    GECICI_ONEK: GECICI_ONEK,
    BEKLIYOR: BEKLIYOR,
    GONDERILDI: GONDERILDI,
    KALICI_HATA: KALICI_HATA,
    ONARIM_GEREKLI: ONARIM_GEREKLI,
    ONARIM_KODLARI: ONARIM_KODLARI
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Sync;
  }

  if (typeof window !== 'undefined') {
    window.PlasiyerSyncMotor = Sync;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
