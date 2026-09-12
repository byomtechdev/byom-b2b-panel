/* ============================================================================
 *  ÇİFT KAPILI GİRİŞ VE ROL KISITLAMASI — ARAYÜZ (renderer-plasiyer.js)
 *  ---------------------------------------------------------------------------
 *  Lisans doğrulaması geçildikten sonra kullanıcıyı iki kapıyla karşılar:
 *    👑 Yönetici Girişi   → mevcut tam panel (hiçbir davranış değişmez)
 *    💼 Pazarlamacı Girişi → plasiyer seçimi + PIN, sonra KISITLI panel
 *
 *  MEVCUT AKIŞ BOZULMAZ — en önemli tasarım kararı:
 *  `baslat()` ve sekme akışına DOKUNULMAZ. Kapı bir KAPLAMADIR (overlay):
 *  panel arkada normal şekilde açılır, kapı üstünde durur. Yönetici kapıyı
 *  seçince kaplama kalkar ve panel 2.0.0'daki hâliyle devam eder. Böylece
 *  `sifir-kurulum.test.js`'in kilitlediği açılış dalı (bağlantı yoksa
 *  Ayarlar'a düş, sipariş isteği atma) aynen korunur.
 *
 *  SIFIR KURULUMDA KAPI GÖSTERİLMEZ. Bağlantı (adres + iki anahtar) yoksa
 *  pazarlamacı girişi çalışamaz; kapı açmak kullanıcıyı tıklayınca hata veren
 *  bir düğmeyle karşılaştırırdı. O durumda doğrudan yönetici akışına geçilir.
 *
 *  DURUM ADI: Şartname `appState.currentUser = { role, id, name, region }`
 *  diyor. Bu depoda durum nesnesi `durum` ve alan adları Türkçedir; aynı bilgi
 *  için iki ad tutmak (bu depoda iki kez canımızı yakmış) bir hata sınıfıdır.
 *  Tek ad kullanılır:
 *      durum.oturum = { rol: 'admin'|'plasiyer', id, ad, bolge }
 *
 *  SIR: PIN bu katmanda SAKLANMAZ; okunur, IPC'ye verilir, alan temizlenir.
 *  Oturum jetonu arayüze HİÇ GELMEZ (bkz. main.js § 3.6).
 *
 *  Yükleme sırası: renderer.js ve renderer-ek.js'ten SONRA (durum, $, bildir,
 *  sekmeAc, api kısayollarını kullanır).
 * ==========================================================================*/

'use strict';

(function () {

  /**
   * Plasiyer oturumunda GÖRÜNECEK sekmeler.
   *
   * FAZ 2'DE DEĞİŞTİ: "Ürün & Stok Yönetimi" (urunler) plasiyere KAPANDI,
   * yerine "Katalog & Sipariş Yazma" (satis) geldi. Sebebi yetki: `urunler`
   * sekmesi fiyat ve stok DÜZENLER; plasiyerin işi satmak, katalogu
   * değiştirmek değil. `satis` sekmesi aynı veriyi salt-okunur gösterir ve
   * sipariş yazar.
   */
  var PLASIYER_SEKMELERI = ['satis', 'siparisler', 'notlarim'];

  /**
   * ROL → GÖRÜNECEK SEKMELER (Faz 6) — TEK DOĞRULUK KAYNAĞI.
   *
   * Eskiden iki liste vardı: `PLASIYER_SEKMELERI` (izinli) ve
   * `KISITLI_SEKMELER` (yasak). Birbirinin tümleyeni olmak ZORUNDA olan iki
   * liste, bu depoda tekrar tekrar canımızı yakmış hata sınıfıdır: yeni bir
   * sekme eklendiğinde yalnızca birine yazılır ve sekme sessizce yanlış rolde
   * görünür. Artık tek beyaz liste var; yasak listesi DOM'dan türetilir
   * (`kisitliSekmeler`), yani menüye eklenen her yeni düğme varsayılan olarak
   * KAPALI başlar — güvenli taraf.
   *
   * YÖNETİCİ DE KISITLANIR (Faz 6'nın asıl değişikliği): "Katalog & Sipariş
   * Yazma" plasiyerin saha ekranıdır, yöneticinin depo/onay dünyasına ait
   * değil. İkisi iç içe geçtiği için menü karmaşıktı.
   */
  var ROL_SEKMELERI = {
    /* Şirket yönetimi: sipariş/depo, ürün/stok, üye onayı, iskonto, vitrin,
       pazarlamacılar (+ içindeki harita alt sekmesi), destek, ayarlar. */
    admin: ['siparisler', 'urunler', 'uyeler', 'iskonto', 'vitrin-editor', 'plasiyerler', 'destek', 'ayarlar'],

    /* Saha: katalog + kendi siparişleri + kendi notları. Başka hiçbir şey. */
    plasiyer: PLASIYER_SEKMELERI
  };

  /**
   * Plasiyer oturumunda KAPANAN sekmeler — DOM'dan türetilir.
   *
   * Testler bu listeyi okuyor; elle yazılmış bir kopya tutmak yerine menüyü
   * tarıyoruz ki liste asla gerçeklikten ayrışamasın.
   */
  function kisitliSekmeler(rol) {
    var izinli = ROL_SEKMELERI[rol || 'plasiyer'] || [];
    var hepsi = [];

    document.querySelectorAll('.menu-btn').forEach(function (btn) {
      var ad = btn.dataset.sekme;
      if (ad && izinli.indexOf(ad) === -1) hepsi.push(ad);
    });

    return hepsi;
  }

  /** Rol bu sekmeyi görebilir mi? Bilinmeyen rol → kısıtlama yok (eski davranış). */
  function sekmeIzinli(ad, rol) {
    var izinli = ROL_SEKMELERI[rol];

    if (!izinli) return true;

    return izinli.indexOf(ad) !== -1;
  }

  /**
   * Plasiyer oturumunda sol menüdeki sıra.
   *
   * DOM sırası yöneticiye göre dizilmiş (Siparişler en üstte). Plasiyerin ilk
   * işi SATIŞ YAZMAK olduğu için onun dünyasında Katalog başa alınır. Flex
   * `order` kullanılıyor: DOM'u taşımak yöneticinin sırasını bozardı.
   */
  var PLASIYER_SIRA = { satis: '1', siparisler: '2', notlarim: '3' };

  /** Plasiyer oturumunda değişen menü etiketleri (çıkışta geri alınır). */
  var PLASIYER_ETIKET = { siparisler: 'Kendi Siparişlerim' };

  /** Özgün etiketler — ilk kısıtlamada bir kez saklanır. */
  var ozgunEtiketler = null;

  var kapi = null;
  var pinPerde = null;
  var ypinPerde = null;
  var plasiyerListesi = [];

  /**
   * CİHAZ DURUMU (Master PIN + saha terminali kilidi).
   *
   * Tek doğruluk kaynağı ANA SÜREÇTİR; burada tutulan kopya yalnızca hangi
   * ekranın çizileceğine karar vermek için. Buradaki bir değeri değiştirmek
   * kilidi AÇMAZ: korumalı alanlar `ayar:yaz` kanalından süzülür ve PIN
   * doğrulaması ana süreçte yapılır (bkz. main.js § 3.9).
   */
  var cihaz = {
    pinKurulu: false,
    kilitli: false,          // cihaz bir plasiyere tahsis edildi mi?
    plasiyerId: 0,
    plasiyerAd: ''
  };

  /** Master PIN penceresinin hangi amaçla açıldığı: kur | dogrula | kilit-ac */
  var ypinModu = '';

  /** Kilit geri sayımı zamanlayıcısı (60 sn). */
  var ypinSayacZaman = null;

  /* ------------------------------------------------------------------ *
   *  Yardımcılar
   * ------------------------------------------------------------------ */

  function el(id) {
    return document.getElementById(id);
  }

  function gorunur(dugum, goster) {
    if (!dugum) return;
    dugum.hidden = !goster;
  }

  /** Bağlantı kurulu mu? renderer.js'teki aynı adlı yardımcıyı kullanır. */
  function baglantiVar() {
    try {
      if (typeof baglantiKuruluMu === 'function') return !!baglantiKuruluMu();
    } catch (e) { /* yardımcı henüz yok */ }

    var a = (typeof durum !== 'undefined' && durum.ayarlar) || {};

    return !!(String(a.wooUrl || '').trim() && String(a.ck || '').trim() && String(a.cs || '').trim());
  }

  function hataYaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  /**
   * Güvenli IPC çağrısı.
   *
   * `ipcRenderer` yoksa (jsdom testleri) ya da kanal patlarsa `null` döner —
   * kapı hiçbir koşulda çökmemeli, en kötü hâlde kısıtlamasız mevcut davranışa
   * düşmeli.
   */
  async function ipc(kanal, veri) {
    try {
      if ('undefined' === typeof ipcRenderer || !ipcRenderer || !ipcRenderer.invoke) return null;

      return await ipcRenderer.invoke(kanal, veri);
    } catch (e) {
      return null;
    }
  }

  /**
   * Cihaz durumunu ayarlardan okur.
   *
   * Ayar nesnesi ana süreçte MASKELENİR: `yoneticiPinHash` hiç gelmez, yerine
   * `yoneticiPinKurulu` bayrağı gelir (bkz. byom-yonetici-kilit.js → maskele).
   */
  function cihazDurumunuAl() {
    var a = (typeof durum !== 'undefined' && durum.ayarlar) || {};

    cihaz.pinKurulu = !!a.yoneticiPinKurulu;
    cihaz.kilitli = 'plasiyer_kilitli' === a.cihazRolu;
    cihaz.plasiyerId = Number(a.tahsisliPlasiyerId || 0) || 0;
    cihaz.plasiyerAd = String(a.tahsisliPlasiyerAd || '');

    /* Tahsisli plasiyer bilgisi eksikse kilit UYGULANMAZ. Adı/kimliği olmayan
       bir kilit, kimsenin giremediği bir cihaz demekti. */
    if (cihaz.kilitli && (!cihaz.plasiyerId || !cihaz.plasiyerAd)) cihaz.kilitli = false;

    return cihaz;
  }

  /* ------------------------------------------------------------------ *
   *  OTURUM DURUMU
   * ------------------------------------------------------------------ */

  function oturumKur(rol, bilgi) {
    bilgi = bilgi || {};

    durum.oturum = {
      rol: rol,
      id: Number(bilgi.id || 0) || 0,
      ad: String(bilgi.ad || ''),
      bolge: String(bilgi.bolge || ''),
      /* İskonto tavanı (Faz 2). Yalnızca GÖSTERİM ve anında uyarı içindir;
         son sözü sunucu söyler (B2B_Plasiyer::iskonto_gecerli_mi). */
      maxIskonto: Number(bilgi.maxIskonto || 0) || 0
    };

    return durum.oturum;
  }

  function plasiyerMi() {
    return !!(durum.oturum && 'plasiyer' === durum.oturum.rol);
  }

  /* ------------------------------------------------------------------ *
   *  ARAYÜZ KISITLAMASI
   * ------------------------------------------------------------------ */

  /**
   * Plasiyer oturumunda menüyü ve üst barı daraltır.
   *
   * Düğmeler GİZLENİR, ayrıca `disabled` yapılır: yalnızca CSS ile gizlemek
   * klavyeyle (Tab) erişimi açık bırakırdı.
   */
  function kisitlamayiUygula() {
    var rol = (durum.oturum && durum.oturum.rol) || '';
    var izinliListe = ROL_SEKMELERI[rol] || null;

    /* Etiketleri bir kez sakla: çıkışta geri yazmak için. */
    if (!ozgunEtiketler) {
      ozgunEtiketler = {};
      document.querySelectorAll('.menu-btn').forEach(function (btn) {
        var etiket = btn.querySelector('span.align-middle');
        if (btn.dataset.sekme && etiket) ozgunEtiketler[btn.dataset.sekme] = etiket.textContent;
      });
    }

    document.querySelectorAll('.menu-btn').forEach(function (btn) {
      var ad = btn.dataset.sekme;
      var kapat = !!izinliListe && !sekmeIzinli(ad, rol);

      /* Üç katlı kapatma: gizli + disabled + aria-hidden. Yalnızca CSS ile
         gizlemek klavyeyle (Tab) erişimi açık bırakırdı. */
      btn.classList.toggle('plasiyer-gizli', kapat);
      btn.disabled = kapat;
      if (kapat) btn.setAttribute('aria-hidden', 'true');
      else btn.removeAttribute('aria-hidden');

      /* Sıra ve etiket yalnızca plasiyer dünyasında değişir. */
      var etiket = btn.querySelector('span.align-middle');

      if ('plasiyer' === rol) {
        btn.style.order = PLASIYER_SIRA[ad] || '';
        if (etiket && PLASIYER_ETIKET[ad]) etiket.textContent = PLASIYER_ETIKET[ad];
      } else {
        btn.style.order = '';
        if (etiket && ozgunEtiketler[ad]) etiket.textContent = ozgunEtiketler[ad];
      }
    });

    /*
     * `data-rol` İKİ YÖNLÜ ÇALIŞIR (Faz 6'da genişledi).
     *
     * Eskiden yalnızca `data-rol="admin"` vardı ve plasiyerde gizleniyordu.
     * Artık `data-rol="plasiyer"` de var (Saha Notlarım); her işaretli düğüm
     * YALNIZCA kendi rolünde görünür. Oturum yoksa (kapı ekranı) ikisi de
     * gizlenir — arkadaki panelde rol etiketli bir düğmenin yanıp sönmesi
     * kullanıcıya yanlış ipucu verirdi.
     */
    document.querySelectorAll('[data-rol]').forEach(function (d) {
      var hedef = d.dataset.rol;

      d.classList.toggle('plasiyer-gizli', !rol || hedef !== rol);
    });

    ustBariTazele();

    /* Kısıtlı bir sekmede kalındıysa izinli İLK sekmeye geç. */
    if (izinliListe && !sekmeIzinli(durum.aktifSekme, rol)) {
      sekmeAc(izinliListe[0]);
    }
  }

  /** Üst barda plasiyerin adı, bölgesi ve çıkış düğmesi. */
  function ustBariTazele() {
    var kutu = el('plasiyerUstBar');

    if (!plasiyerMi()) {
      if (kutu) kutu.remove();
      return;
    }

    if (!kutu) {
      kutu = document.createElement('div');
      kutu.id = 'plasiyerUstBar';
      kutu.className = 'flex items-center gap-3 ml-auto';

      var hedef = document.querySelector('header .flex') || document.querySelector('header');
      if (hedef) hedef.appendChild(kutu);
    }

    var ad = durum.oturum.ad || 'Pazarlamacı';
    var bolge = durum.oturum.bolge ? (durum.oturum.bolge + ' Bölgesi') : 'Bölge atanmamış';

    /*
     * YALNIZCA KİMLİK KÜNYESİ — çıkış düğmesi BURADA DEĞİL (Faz 6).
     *
     * Faz 1'de üst bara bir "Çıkış Yap" konmuştu; Faz 6'da sol menüye her iki
     * rol için kalıcı bir çıkış düğmesi eklendi ve ikisi aynı işi yapan iki
     * düğme hâline geldi. Aynı eylemin iki yerde durması, bu görevde
     * düzeltmemiz istenen karmaşanın ta kendisi: kullanıcı hangisinin "gerçek"
     * olduğunu sorgulamaya başlar. Çıkış TEK yerde (sol menü altı), her rolde
     * AYNI yerde. Üst barda kalan şey bir BİLGİ, eylem değil.
     */
    kutu.innerHTML =
      '<span class="px-4 py-2 rounded-xl bg-marka-700 text-white font-extrabold text-base">' +
        '<span aria-hidden="true">💼</span> ' + kacis(ad) +
        ' <span class="font-semibold opacity-80">— ' + kacis(bolge) + '</span>' +
      '</span>';
  }

  /* ------------------------------------------------------------------ *
   *  KAPI
   * ------------------------------------------------------------------ */

  function kapiyiGoster() {
    if (!kapi) return;

    var firma = el('kapiFirma');

    if (firma) {
      var ad = '';

      try {
        ad = (durum.lisans && durum.lisans.firmaAdi) || '';
      } catch (e) { ad = ''; }

      firma.textContent = ad || 'Devam etmek için giriş tipini seçin';
    }

    kapi.hidden = false;
    kapi.classList.remove('kapali');
  }

  /** Kapıyı yumuşak geçişle kapatır (transform + opacity, layout yok). */
  function kapiyiKapat() {
    if (!kapi) return;

    kapi.classList.add('kapali');

    /* Geçiş bitince DOM'dan çıkar: arkadaki panel tam erişilebilir olsun. */
    window.setTimeout(function () {
      if (kapi) kapi.hidden = true;
    }, 220);
  }

  /**
   * "👑 Yönetici Girişi" düğmesi — ARTIK DOĞRUDAN AÇMAZ.
   *
   * Master PIN'den geçmek zorunludur; sahaya verilen laptopta plasiyerin
   * yönetici ekranına geçmesini engelleyen şey tam olarak bu adım.
   *
   * HİÇBİR REST İSTEĞİ ATILMAZ (Faz 4 sözü korunur): PIN ana sürece IPC ile
   * gider, sunucuya çıkılmaz. Sunucusu kapalı bir mağazada yönetici yine
   * paneli açıp ayarları düzeltebilir.
   */
  function yoneticiSec() {
    /* PIN hiç tanımlanmamışsa ilk kurulum ekranı gelir — şartname:
       "Eğer PIN yoksa ... Master PIN Belirleyin modalı açılsın". */
    ypinAc(cihaz.pinKurulu ? 'dogrula' : 'kur');
  }

  /**
   * Master PIN geçildikten SONRA asıl yönetici girişi.
   *
   * `yoneticiSec`'ten ayrı tutulması bilinçli: panel açma adımının tek bir
   * yeri olsun ve o yere yalnızca doğrulanmış yoldan girilebilsin.
   */
  function yoneticiGirisiniTamamla() {
    oturumKur('admin', {});
    kisitlamayiUygula();
    ypinKapat();
    kapiyiKapat();
  }

  /* ------------------------------------------------------------------ *
   *  YÖNETİCİ MASTER PIN AKIŞI
   *  ---------------------------------------------------------------
   *  Üç mod, tek pencere:
   *    kur       → ilk kurulum (iki kutu: PIN + tekrar)
   *    dogrula   → yönetici kapısını aç
   *    kilit-ac  → cihaz kilidini kaldır (patron çıkışı)
   *
   *  DOĞRULAMA BURADA YOK. Üç mod da ana sürece IPC atar ve yalnızca
   *  "oldu/olmadı" alır; PIN özeti arayüze hiç gelmez.
   * ------------------------------------------------------------------ */

  /** Master PIN hane sayısı — ana süreçteki `PIN_UZUNLUK` ile aynı olmalı. */
  var YPIN_UZUNLUK = 6;

  var YPIN_METIN = {
    kur: {
      baslik: 'Yönetici Master PIN Belirleyin (6 Haneli)',
      aciklama: 'Bu PIN yönetici ekranını ve cihaz kilidini açar. Sahadaki pazarlamacıyla paylaşmayın.',
      dugme: 'PIN\'i Kaydet ve Gir'
    },
    dogrula: {
      baslik: 'Yönetici Girişi',
      aciklama: '6 haneli yönetici PIN\'inizi girin.',
      dugme: 'Giriş Yap'
    },
    'kilit-ac': {
      baslik: 'Cihaz Kilidini Aç',
      aciklama: 'Bu cihaz saha satışına tahsisli. Kilidi kaldırmak için yönetici PIN\'inizi girin.',
      dugme: 'Kilidi Aç'
    }
  };

  function ypinAlanlariTemizle() {
    var a = el('ypinKod');
    var b = el('ypinKod2');

    /* PIN ekranda bile bırakılmaz (bkz. dosya başlığı — SIR kuralı). */
    if (a) a.value = '';
    if (b) b.value = '';
  }

  function ypinSayaciDurdur() {
    if (ypinSayacZaman) {
      window.clearInterval(ypinSayacZaman);
      ypinSayacZaman = null;
    }
  }

  /**
   * 60 saniyelik kilidi kullanıcıya geri sayarak gösterir.
   *
   * Düğme kapatılır: kilitliyken denemeye devam etmek ana süreçte zaten
   * reddediliyor, ama kullanıcıya sebebini göstermek gerekir — yoksa
   * "uygulama bozuldu" sanır.
   */
  function ypinKilidiGoster(kalan) {
    var dugme = el('ypinGonder');
    var hata = el('ypinHata');

    ypinSayaciDurdur();

    var sn = Number(kalan) || 0;

    function ciz() {
      if (sn <= 0) {
        ypinSayaciDurdur();
        if (dugme) dugme.disabled = false;
        hataYaz(hata, 'Tekrar deneyebilirsiniz.');
        return;
      }

      if (dugme) dugme.disabled = true;
      hataYaz(hata, 'Çok fazla hatalı deneme. ' + sn + ' saniye bekleyin.');
      sn--;
    }

    ciz();
    ypinSayacZaman = window.setInterval(ciz, 1000);
  }

  function ypinAc(mod) {
    ypinModu = YPIN_METIN[mod] ? mod : 'dogrula';

    var metin = YPIN_METIN[ypinModu];

    var baslik = el('ypinBaslik');
    var aciklama = el('ypinAciklama');
    var dugme = el('ypinGonder');

    if (baslik) baslik.textContent = metin.baslik;
    if (aciklama) aciklama.textContent = metin.aciklama;
    if (dugme) {
      dugme.textContent = metin.dugme;
      dugme.disabled = false;
    }

    /* Onay kutusu YALNIZCA ilk kurulumda: tek kutuyla kurulan PIN'deki yazım
       hatası, cihaz kilitlendikten sonra geri dönüşü olmayan bir kilit üretir. */
    gorunur(el('ypinOnayAlan'), 'kur' === ypinModu);

    /* Kilit açma modunda "Geri Dön" kullanıcıyı terminale bırakır; kapatma
       düğmeleri kilidi AÇMAZ, yalnızca bu pencereyi kapatır. */
    ypinAlanlariTemizle();
    hataYaz(el('ypinHata'), '');
    ypinSayaciDurdur();

    gorunur(ypinPerde, true);

    var kod = el('ypinKod');
    if (kod) kod.focus();
  }

  function ypinKapat() {
    ypinSayaciDurdur();
    ypinAlanlariTemizle();
    hataYaz(el('ypinHata'), '');
    gorunur(ypinPerde, false);

    var dugme = el('ypinGonder');
    if (dugme) dugme.disabled = false;
  }

  /**
   * Master PIN gönderimi — üç mod tek yerden.
   *
   * Ana süreç yanıtı `{ ok, hata, kilitli, kilitKalanSn, durum }` biçiminde
   * gelir; `durum` maskelenmiş cihaz durumudur (özet içermez).
   */
  async function ypinGonder() {
    var kod = el('ypinKod');
    var kod2 = el('ypinKod2');
    var dugme = el('ypinGonder');
    var hata = el('ypinHata');

    var pin = String((kod && kod.value) || '');

    if (pin.length !== YPIN_UZUNLUK) {
      return hataYaz(hata, 'PIN ' + YPIN_UZUNLUK + ' haneli olmalı.');
    }

    if ('kur' === ypinModu && pin !== String((kod2 && kod2.value) || '')) {
      return hataYaz(hata, 'İki PIN aynı değil. Tekrar girin.');
    }

    hataYaz(hata, '');
    if (dugme) dugme.disabled = true;

    var cevap;

    if ('kur' === ypinModu) {
      cevap = await ipc('auth:yonetici-pin-kur', { pin: pin });
    } else if ('kilit-ac' === ypinModu) {
      cevap = await ipc('cihaz:ac', { pin: pin });
    } else {
      cevap = await ipc('auth:yonetici-pin-dogrula', { pin: pin });
    }

    /* PIN yerel değişkende bırakılmaz. */
    pin = '';
    ypinAlanlariTemizle();

    if (!cevap) {
      if (dugme) dugme.disabled = false;
      return hataYaz(hata, 'Doğrulama yapılamadı. Uygulamayı yeniden başlatın.');
    }

    if (!cevap.ok) {
      if (cevap.kilitli) {
        ypinKilidiGoster(cevap.kilitKalanSn);
      } else {
        if (dugme) dugme.disabled = false;
        hataYaz(hata, cevap.hata || 'PIN doğrulanamadı.');
      }
      return;
    }

    /* Ana sürecin döndürdüğü taze durum esas alınır — yerel kopya değil. */
    if (cevap.durum) {
      cihaz.pinKurulu = !!cevap.durum.pinKurulu;
      cihaz.kilitli = !!cevap.durum.cihazKilitli;
      cihaz.plasiyerId = Number(cevap.durum.tahsisliPlasiyerId || 0) || 0;
      cihaz.plasiyerAd = String(cevap.durum.tahsisliPlasiyerAd || '');

      /* Ayar nesnesi de tazelenir ki başka modüller eski değeri okumasın. */
      if (typeof durum !== 'undefined' && durum.ayarlar) {
        durum.ayarlar.yoneticiPinKurulu = cihaz.pinKurulu;
        durum.ayarlar.cihazRolu = cihaz.kilitli ? 'plasiyer_kilitli' : 'standart';
        durum.ayarlar.tahsisliPlasiyerId = cihaz.plasiyerId;
        durum.ayarlar.tahsisliPlasiyerAd = cihaz.plasiyerAd;
      }
    }

    if ('kilit-ac' === ypinModu) {
      ypinKapat();
      terminalModunuKapat();

      if (typeof bildir === 'function') bildir('Cihaz kilidi açıldı. Standart giriş ekranına dönüldü.', 'basari');
      return;
    }

    /* kur / dogrula → yönetici paneli açılır. */
    yoneticiGirisiniTamamla();
  }

  /* ------------------------------------------------------------------ *
   *  SAHA TERMİNALİ MODU (cihaz bir plasiyere kilitli)
   * ------------------------------------------------------------------ */

  /**
   * Yönetici kapısını EKRANDAN KALDIRIR, doğrudan plasiyer PIN ekranını açar.
   *
   * Düğme hem gizlenir hem `disabled` yapılır hem `aria-hidden` alır: yalnızca
   * CSS ile gizlemek klavyeyle (Tab) erişimi açık bırakırdı — § 4.5'teki
   * kısıtlama kalıbının aynısı.
   */
  function terminalModunuAc() {
    var yon = el('kapiYonetici');

    if (yon) {
      yon.hidden = true;
      yon.disabled = true;
      yon.setAttribute('aria-hidden', 'true');
    }

    gorunur(el('kapiKartlar'), false);
    gorunur(el('kapiTerminal'), true);
    gorunur(el('kapiKilitAc'), true);

    var ad = el('kapiTerminalAd');
    if (ad) ad.textContent = cihaz.plasiyerAd + ' — Saha Satış Terminali';

    var firma = el('kapiFirma');
    if (firma) firma.textContent = '';

    kapiyiGoster();

    /* Kapı zaten opak: PIN penceresi kapanırsa arkada yönetici paneli değil
       bu kaplama durur. İki katmanlı koruma bilinçli. */
    pinPerdesiniAc();
  }

  /** Kilit kaldırıldıktan sonra standart çift kapıya döner. */
  function terminalModunuKapat() {
    var yon = el('kapiYonetici');

    if (yon) {
      yon.hidden = false;
      yon.disabled = false;
      yon.removeAttribute('aria-hidden');
    }

    gorunur(el('kapiTerminal'), false);
    gorunur(el('kapiKilitAc'), false);
    gorunur(el('kapiKartlar'), true);

    /* Plasiyer PIN penceresinin çıkışları geri gelir. */
    gorunur(el('pinKapat'), true);
    gorunur(el('pinGeri'), true);
    gorunur(el('pinSecimAlan'), true);
    gorunur(pinPerde, false);

    kapiyiGoster();
  }

  /* ------------------------------------------------------------------ *
   *  PLASİYER PIN AKIŞI
   * ------------------------------------------------------------------ */

  /** Plasiyer listesi için süre aşımı — modal ASLA asılı kalmamalı. */
  var LISTE_SURE_ASIMI_MS = 3000;

  /** Kayıtlı plasiyer yokken gösterilen tek mesaj. */
  var PLASIYER_YOK_MESAJI =
    'Henüz kayıtlı pazarlamacı bulunamadı. Lütfen Yönetici Girişi yaparak plasiyer tanımlayın.';

  /**
   * İsteği süre aşımıyla yarıştırır.
   *
   * `b2b()` ana sürece IPC ile gider ve oradaki süre aşımı 20+ saniyedir.
   * Giriş ekranında 20 saniye beklemek "uygulama kilitlendi" demektir; kullanıcı
   * 3 saniyede cevap görmeli ve her hâlde çıkış yolu açık kalmalı.
   */
  function sureAsimiyla(soz, ms) {
    return Promise.race([
      soz,
      new Promise(function (coz) {
        window.setTimeout(function () { coz({ ok: false, sureAsimi: true }); }, ms);
      })
    ]);
  }

  async function plasiyerleriYukle() {
    var secim = el('pinPlasiyer');

    if (!secim) return;

    secim.innerHTML = '<option value="">Yükleniyor…</option>';
    secim.disabled = true;

    hataYaz(el('pinHata'), '');

    var cevap;

    try {
      cevap = await sureAsimiyla(b2b('/admin/plasiyerler'), LISTE_SURE_ASIMI_MS);
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || '' };
    }

    secim.disabled = false;

    /*
     * TEK MESAJ KURALI: süre aşımı, ağ hatası, yetki hatası ve "hiç kayıt yok"
     * hâllerinin hepsi kullanıcı için AYNI şeydir — girilecek pazarlamacı yok.
     * Ayrı ayrı teknik metinler göstermek sahada kimseye yardımcı olmuyor;
     * yapılacak iş her durumda aynı: yönetici girişinden plasiyer tanımla.
     */
    var basarisiz = !cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok;

    plasiyerListesi = basarisiz
      ? []
      : (cevap.veri.plasiyerler || []).filter(function (p) { return p && p.pinTanimli; });

    if (!plasiyerListesi.length) {
      secim.innerHTML = '<option value="">— kayıtlı pazarlamacı yok —</option>';

      hataYaz(el('pinHata'), PLASIYER_YOK_MESAJI);

      /* Giriş düğmesi kapatılır: basılacak bir şey yok, ama perde açık kalır
         ve kullanıcı ✕ / Geri Dön / ESC ile çıkabilir. */
      var giris = el('pinGiris');
      if (giris) giris.disabled = true;

      return;
    }

    var giris2 = el('pinGiris');
    if (giris2) giris2.disabled = false;

    secim.innerHTML = plasiyerListesi.map(function (p) {
      var etiket = p.ad + (p.bolge ? ' — ' + p.bolge : '');
      return '<option value="' + Number(p.id) + '">' + kacis(etiket) + '</option>';
    }).join('');

    /* Son giren pazarlamacı hatırlanır (sır değil, yalnızca kolaylık). */
    var son = (durum.ayarlar && durum.ayarlar.plasiyerSonOturum) || null;

    if (son && son.id) secim.value = String(son.id);
  }

  /**
   * Kilitli cihazda PIN penceresini terminal biçimine sokar.
   *
   * · Başlık "[Plasiyer Adı] — Saha Satış Terminali".
   * · Pazarlamacı SEÇİMİ kapalı: cihaz tek kişiye tahsisli, başkası seçilemez.
   * · ÇIKIŞ DÜĞMELERİ KAPALI: Faz 4'te eklenen çıkışlar burada bir kaçış
   *   yoluna dönüşürdü. (Kapı kaplaması arkada durduğu için pencere kapansa
   *   bile panel görünmez; yine de iki katman birden kapatılıyor.)
   * · Liste için AĞA ÇIKILMAZ: plasiyerin kim olduğu ayarlardan biliniyor,
   *   internetsiz sahada da açılış çalışmalı.
   */
  function terminalPinGorunumu() {
    var baslik = el('pinBaslik');
    var alt = el('pinAltBaslik');

    if (baslik) baslik.textContent = cihaz.plasiyerAd + ' — Saha Satış Terminali';
    if (alt) alt.textContent = 'PIN\'inizi girin.';

    gorunur(el('pinSecimAlan'), false);
    gorunur(el('pinKapat'), false);
    gorunur(el('pinGeri'), false);

    /* Giriş akışı seçim kutusunun değerini okur; tahsisli plasiyeri tek
       seçenek olarak koyuyoruz ki `pinGirisDene` değişmeden çalışsın. */
    var secim = el('pinPlasiyer');

    if (secim) {
      secim.innerHTML = '';

      var secenek = document.createElement('option');

      secenek.value = String(cihaz.plasiyerId);
      secenek.textContent = cihaz.plasiyerAd;
      secim.appendChild(secenek);
      secim.value = String(cihaz.plasiyerId);
    }
  }

  function pinPerdesiniAc() {
    /* Kilitli cihazda bağlantı uyarısı kapıyı kapatmaz: plasiyer PIN'ini
       girebilmeli, bağlantı sorunu ayrıca bildirilir. */
    if (!cihaz.kilitli && !baglantiVar()) {
      hataYaz(el('kapiUyari'), 'Pazarlamacı girişi için önce site bağlantısı kurulmalı. Yönetici girişinden API & Sistem Ayarları\'nı doldurun.');
      return;
    }

    gorunur(pinPerde, true);
    hataYaz(el('pinHata'), '');

    var kod = el('pinKod');
    if (kod) kod.value = '';

    if (cihaz.kilitli) {
      terminalPinGorunumu();
      if (kod) kod.focus();
      return;
    }

    plasiyerleriYukle().then(function () {
      if (kod) kod.focus();
    });
  }

  function pinPerdesiniKapat() {
    /*
     * KİLİTLİ CİHAZDA KİMLİK DOĞRULANMADAN PENCERE KAPANMAZ.
     *
     * Tek satır, üç kaçış yolunu birden kapatır: ✕ düğmesi, perdeye tıklama
     * ve ESC. Kapanabilseydi plasiyer PIN girmeden panele düşerdi.
     *
     * ⚠️ `!durum.oturum` KOŞULU ZORUNLU — KALDIRMA.
     * Faz 5'te koşul yalnızca `cihaz.kilitli` idi ve bu ÜRÜNDE KİLİTLENMEYE
     * yol açıyordu: plasiyer DOĞRU PIN'i girince oturum açılıyor, kapı
     * kaplaması kalkıyor, ama bu pencere ekranda kalıp paneli kapatıyordu —
     * kimliğini doğruladığı uygulamayı kullanamıyordu. Koruma "kaçışı
     * engelle" demek, "doğrulandıktan sonra da kapatma" demek değil.
     */
    if (cihaz.kilitli && !durum.oturum) return;

    gorunur(pinPerde, false);

    var kod = el('pinKod');
    if (kod) kod.value = '';   // PIN ekranda bile bırakılmaz

    /* Giriş düğmesi bir dahaki açılışta kullanılabilir olsun. */
    var giris = el('pinGiris');
    if (giris) giris.disabled = false;

    hataYaz(el('pinHata'), '');
  }

  /**
   * Modalı kapatıp DOĞRUDAN yönetici akışına geçer.
   *
   * "Geri Dön / Yönetici Girişi" düğmesi: pazarlamacı girişi mümkün olmadığında
   * (hiç plasiyer tanımlı değil) kullanıcının tek yapabileceği iş bu, ve iki
   * tıklamaya bölmek gereksiz.
   */
  function geriDonYonetici() {
    pinPerdesiniKapat();
    yoneticiSec();
  }

  async function pinGirisDene() {
    var secim = el('pinPlasiyer');
    var kod = el('pinKod');
    var dugme = el('pinGiris');

    var id = Number(secim && secim.value) || 0;
    var pin = String((kod && kod.value) || '');

    if (!id) return hataYaz(el('pinHata'), 'Pazarlamacı seçin.');
    if (!pin) return hataYaz(el('pinHata'), 'PIN girin.');

    hataYaz(el('pinHata'), '');
    if (dugme) dugme.disabled = true;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('plasiyer:auth', { id: id, pin: pin });
    } finally {
      /* PIN hem değişkenden hem ekrandan SİLİNİR. */
      pin = '';
      if (kod) kod.value = '';
      if (dugme) dugme.disabled = false;
    }

    if (!cevap || !cevap.ok) {
      hataYaz(el('pinHata'), (cevap && cevap.hata) || 'Giriş başarısız.');
      if (kod) kod.focus();
      return;
    }

    oturumKur('plasiyer', cevap);

    /* Sır olmayan kısmı kaydet: bir dahaki açılışta seçili gelsin. */
    try {
      await ipcRenderer.invoke('plasiyer:save-session', {
        id: cevap.id,
        ad: cevap.ad,
        bolge: cevap.bolge
      });
    } catch (e) { /* kolaylık özelliği; başarısızlığı akışı durdurmaz */ }

    pinPerdesiniKapat();
    kisitlamayiUygula();

    /*
     * GİRİŞTE AÇILAN SEKME: plasiyerin ilk işi SATIŞ YAZMAK.
     *
     * `kisitlamayiUygula()` yalnızca KISITLI bir sekmede kalındıysa sekme
     * değiştirir; "Kendi Siparişlerim" plasiyere açık olduğu için orada
     * kalıyordu ve saha satışçısı girişte sipariş listesine düşüyordu. Menüde
     * Katalog'u başa aldığımız hâlde ikinci maddeye inmek tutarsızdı.
     *
     * Karar BURADA verilir, `kisitlamayiUygula` içinde DEĞİL: o fonksiyon her
     * yeniden çizimde çalışır ve gereksiz sekme değişimi veri yükleme turu
     * tetiklerdi (`plasiyer-kapi.dom.test.js` bunu ayrıca kilitliyor).
     */
    sekmeAc(PLASIYER_SEKMELERI[0]);

    kapiyiKapat();

    bildir('Hoş geldiniz ' + cevap.ad + (cevap.bolge ? ' — ' + cevap.bolge + ' Bölgesi' : ''), 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  ÇIKIŞ
   * ------------------------------------------------------------------ */

  /**
   * Oturumu kapatır ve karşılama kapısına döner.
   *
   * HER İKİ ROL İÇİN ÇALIŞIR (Faz 6). Eskiden yalnızca plasiyer üst barındaki
   * düğmeden çağrılıyordu; yönetici panele girdikten sonra kapıya dönemiyordu.
   *
   * SIRA ÖNEMLİ:
   *  1) Jeton ana süreçte iptal edilir (ağ yoksa da yerel oturum düşer).
   *  2) `durum.oturum = null` — bellekteki rol sıfırlanır.
   *  3) Kısıtlama yeniden uygulanır: rol yok ⇒ bütün menü varsayılana döner,
   *     plasiyer etiketleri/sırası geri alınır, üst bardaki ad kutusu silinir.
   *  4) Kapı gösterilir. Cihaz kilitliyse kapı terminal biçiminde açılır ve
   *     doğrudan o plasiyerin PIN ekranına döner — şartnamenin istediği davranış.
   */
  async function cikisYap() {
    try {
      await ipcRenderer.invoke('plasiyer:logout');
    } catch (e) { /* sunucuya ulaşılamasa da yerel oturum düşer */ }

    durum.oturum = null;

    kisitlamayiUygula();

    /* Açık kalmış bir perde arkada durmasın: kapı temiz bir ekrana açılmalı. */
    ypinKapat();

    if (cihaz.kilitli) {
      terminalModunuAc();   // kaplama + "[Ad] — Saha Satış Terminali" + PIN
      return;
    }

    kapiyiGoster();
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function olaylariBagla() {
    var yon = el('kapiYonetici');
    var pla = el('kapiPlasiyer');

    if (yon) yon.addEventListener('click', yoneticiSec);
    if (pla) pla.addEventListener('click', pinPerdesiniAc);

    var kapat = el('pinKapat');
    if (kapat) kapat.addEventListener('click', pinPerdesiniKapat);

    var geri = el('pinGeri');
    if (geri) geri.addEventListener('click', geriDonYonetici);

    var giris = el('pinGiris');
    if (giris) giris.addEventListener('click', pinGirisDene);

    /*
     * PERDEYE TIKLAMA KAPATIR. Hedef denetimi şart: kartın İÇİNE tıklamak
     * (select açmak, PIN yazmak) perdeyi kapatmamalı. `currentTarget`
     * karşılaştırması tam bunu ayırır.
     */
    if (pinPerde) {
      pinPerde.addEventListener('click', function (olay) {
        if (olay.target === pinPerde) pinPerdesiniKapat();
      });
    }

    var kod = el('pinKod');

    if (kod) {
      kod.addEventListener('keydown', function (olay) {
        if ('Enter' === olay.key) pinGirisDene();
      });

      /* Yalnızca rakam kabul: yapıştırma da süzülür. */
      kod.addEventListener('input', function () {
        var temiz = kod.value.replace(/[^0-9]/g, '').slice(0, 6);
        if (temiz !== kod.value) kod.value = temiz;
      });
    }

    /* ---- YÖNETİCİ MASTER PIN PENCERESİ ---- */

    var ykapat = el('ypinKapat');
    if (ykapat) ykapat.addEventListener('click', ypinKapat);

    var ygeri = el('ypinGeri');
    if (ygeri) ygeri.addEventListener('click', ypinKapat);

    var ygonder = el('ypinGonder');
    if (ygonder) ygonder.addEventListener('click', ypinGonder);

    if (ypinPerde) {
      ypinPerde.addEventListener('click', function (olay) {
        if (olay.target === ypinPerde) ypinKapat();
      });
    }

    /* Her iki PIN kutusu: yalnızca rakam + Enter gönderir. */
    ['ypinKod', 'ypinKod2'].forEach(function (id) {
      var kutu = el(id);

      if (!kutu) return;

      kutu.addEventListener('keydown', function (olay) {
        if ('Enter' === olay.key) ypinGonder();
      });

      kutu.addEventListener('input', function () {
        var temiz = kutu.value.replace(/[^0-9]/g, '').slice(0, YPIN_UZUNLUK);
        if (temiz !== kutu.value) kutu.value = temiz;
      });
    });

    /*
     * ÇIKIŞ YAP — sol menünün altında, HER İKİ ROL İÇİN tek kanonik çıkış.
     * Oturum yokken de bağlı kalır (zararsız): kapı kaplaması zaten üstte.
     */
    var cikis = el('cikisYapDugme');
    if (cikis) cikis.addEventListener('click', cikisYap);

    /* Kilitli terminaldeki discreet 🔓 — patron çıkışı. */
    var kilitAc = el('kapiKilitAc');
    if (kilitAc) kilitAc.addEventListener('click', function () { ypinAc('kilit-ac'); });

    /* Terminal ekranındaki "PIN ile Giriş" düğmesi (pencere kapanmışsa geri açar). */
    var terminalGiris = el('kapiTerminalGiris');
    if (terminalGiris) terminalGiris.addEventListener('click', pinPerdesiniAc);

    /*
     * ESC SIRASI ÖNEMLİ: Master PIN penceresi plasiyer penceresinin ÜSTÜNDE
     * durur (z-80 > z-70). Üstteki kapanmadan alttakine dokunulmamalı, yoksa
     * tek ESC iki pencereyi birden kapatırdı.
     */
    document.addEventListener('keydown', function (olay) {
      if ('Escape' !== olay.key) return;

      if (ypinPerde && !ypinPerde.hidden) return ypinKapat();
      if (pinPerde && !pinPerde.hidden) pinPerdesiniKapat();
    });
  }

  /**
   * Tek kez kurulum.
   *
   * ÇİFT BAĞLANMA KORUMASI (kök CLAUDE.md §6): `baslat` iki yoldan
   * çağrılabiliyor — DOMContentLoaded ve (belge hazırsa) doğrudan. Bayrak
   * olmasa olay dinleyicileri iki kez bağlanır ve tek tıklama PIN denemesini
   * İKİ KEZ gönderirdi; kaba kuvvet sayacı boşuna ilerlerdi.
   */
  var kuruldu = false;

  /**
   * Ayarlar hazır olduktan sonra hangi kapının çizileceğine karar verir.
   *
   * SIRA ÖNEMLİ — yukarıdan aşağı:
   *   1) CİHAZ KİLİDİ her şeyin önündedir. Tahsisli cihazda ne çift kapı ne
   *      sıfır-kurulum dalı çalışır; yönetici kapısı ekranda HİÇ olmaz.
   *   2) SIFIR KURULUM (bağlantı yok + Master PIN de yok): mevcut davranış
   *      aynen korunur — kapı gösterilmez, doğrudan yönetici akışı.
   *      `sifir-kurulum.test.js`'in kilitlediği dal budur.
   *   3) Master PIN TANIMLIYSA bağlantı olmasa bile kapı gösterilir: yönetici
   *      ekranı PIN'siz açılmamalı. (Taze kurulumda PIN yoktur, yani yeni
   *      kullanıcı kurulum ekranına PIN sorulmadan ulaşır — yazım hatası olan
   *      bir PIN'in taze kurulumu kilitlemesi bundan daha kötü olurdu.)
   */
  function kapiyiKur() {
    cihazDurumunuAl();

    if (cihaz.kilitli) {
      terminalModunuAc();
      return;
    }

    if (!baglantiVar() && !cihaz.pinKurulu) {
      oturumKur('admin', {});
      kapi.hidden = true;
      return;
    }

    kapiyiGoster();
  }

  /**
   * AÇILIŞ SIRASI HATASI DÜZELTMESİ — okumadan değiştirme.
   *
   * `renderer.js` ayarları `await ipcRenderer.invoke('ayar:oku')` ile çeker ve
   * `durum.ayarlar` bu iş bitene kadar **null**'dır. Her iki dosya da
   * DOMContentLoaded'a bağlı olduğu için buradaki kod, ayarlar gelmeden
   * çalışıyordu: `baglantiVar()` boş nesne görüp `false` dönüyor, kapı
   * kendini gizliyor ve çift kapı GERÇEK UYGULAMADA HİÇ GÖRÜNMÜYORDU.
   *
   * Testler bunu yakalamıyordu çünkü `durum.ayarlar`'ı önceden dolduruyorlar.
   * Üretimde ise Faz 4'e kadar `[hidden]` CSS hatası kapıyı zorla görünür
   * tuttuğu için belirti maskeliydi; o hata düzeltilince ortaya çıktı.
   *
   * Çözüm: ayarlar hazırsa SENKRON devam et (test yolu ve hızlı yol aynı
   * kalır), değilse kendimiz okuyup bekle. Cihaz kilidi de aynı nesneden
   * geldiği için tek IPC turu üç soruyu birden cevaplar.
   */
  async function ayarlariBekleyipKur() {
    var cevap = await sureAsimiyla(ipc('ayar:oku'), LISTE_SURE_ASIMI_MS);

    /* `durum.ayarlar` hâlâ boşsa dolduruyoruz; renderer.js birazdan aynı
       içerikle üzerine yazacak. Dolmuşsa DOKUNMUYORUZ — tek doğruluk kaynağı
       orası kalsın. */
    if (cevap && !cevap.sureAsimi && typeof durum !== 'undefined' && !durum.ayarlar) {
      durum.ayarlar = cevap;
    }

    kapiyiKur();
  }

  function baslat() {
    if (kuruldu) return;

    kapi = el('girisKapisi');
    pinPerde = el('pinPerde');
    ypinPerde = el('ypinPerde');

    if (!kapi) return;   // işaretleme yoksa sessizce devre dışı

    kuruldu = true;

    olaylariBagla();

    if (typeof durum !== 'undefined' && durum.ayarlar) {
      kapiyiKur();
      return;
    }

    ayarlariBekleyipKur();
  }

  /* renderer.js DOMContentLoaded'da boot ediyor; biz de aynı anı bekliyoruz. */
  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', baslat);
  } else {
    baslat();
  }

  /* Yönetim modülünün ve testlerin kullandığı küçük yüz. */
  window.PlasiyerKapi = {
    oturumKur: oturumKur,
    plasiyerMi: plasiyerMi,
    kisitlamayiUygula: kisitlamayiUygula,
    cikisYap: cikisYap,
    kapiyiGoster: kapiyiGoster,
    yoneticiSec: yoneticiSec,
    yoneticiGirisiniTamamla: yoneticiGirisiniTamamla,
    pinPerdesiniAc: pinPerdesiniAc,
    pinPerdesiniKapat: pinPerdesiniKapat,
    geriDonYonetici: geriDonYonetici,
    plasiyerleriYukle: plasiyerleriYukle,

    /* Master PIN ve cihaz kilidi (bkz. main.js § 3.9) */
    ypinAc: ypinAc,
    ypinKapat: ypinKapat,
    ypinGonder: ypinGonder,
    cihazDurumunuAl: cihazDurumunuAl,
    terminalModunuAc: terminalModunuAc,
    terminalModunuKapat: terminalModunuKapat,
    kapiyiKur: kapiyiKur,
    cihaz: cihaz,

    PLASIYER_SEKMELERI: PLASIYER_SEKMELERI,
    ROL_SEKMELERI: ROL_SEKMELERI,
    kisitliSekmeler: kisitliSekmeler,
    sekmeIzinli: sekmeIzinli,
    LISTE_SURE_ASIMI_MS: LISTE_SURE_ASIMI_MS,
    PLASIYER_YOK_MESAJI: PLASIYER_YOK_MESAJI,
    YPIN_UZUNLUK: YPIN_UZUNLUK
  };
})();
