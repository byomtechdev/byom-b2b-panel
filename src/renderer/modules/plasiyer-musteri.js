/* ============================================================================
 *  PLASİYER MÜŞTERİ VE SİPARİŞ AKIŞI
 *  (src/renderer/modules/plasiyer-musteri.js)
 *  ---------------------------------------------------------------------------
 *  Saha satış ekranının müşteri yarısı: müşteri seçimi/arama, cari risk
 *  uyarısı, ÇEVRİMDIŞI müşteri ekleme, "son siparişi kopyala" ve sipariş
 *  tamamlama (üç ödeme yöntemi + vade/politika notu + sevkiyat notu).
 *
 *  KURALLARI YAZMAZ, ÇAĞIRIR. Geçici müşteri kimliği, iskonto tavanı ve
 *  sipariş gövdesi `src/renderer/plasiyer-siparis-motor.js` içindedir (DOM'suz,
 *  `node --test` altında ölçülür). Sepet, vitrin modülüyle PAYLAŞILIR —
 *  `PlasiyerVitrin.sepetAl()` tek sepeti döndürür; ikinci bir sepet nesnesi
 *  tutmak aynı bilgi için iki depo olurdu.
 *
 *  İSKONTO TAVANI İKİ YERDE: burada arayüz anında uyarır, sunucu
 *  (B2B_Plasiyer::iskonto_gecerli_mi) son sözü söyler. Bu bilinçli bir
 *  tekrardır: biri hız, diğeri güvenlik.
 *
 *  ÇEVRİMDIŞI MÜŞTERİ: kimlik `temp_musteri_<uuid>` METİNDİR, sayısal
 *  WordPress kimliğiyle karışmaz. Eşitleme bu öneke bakarak "sunucuda henüz
 *  yok" kararını verir. Kayıt yerel listede bekler; Faz 3 eşitleme kuyruğu
 *  onu sunucuya iletecek.
 * ==========================================================================*/

'use strict';

(function () {

  /** Yerel (çevrimdışı) müşterilerin ayarlardaki anahtarı. */
  var YEREL_ANAHTAR = 'plasiyerYerelMusteriler';

  var durumM = {
    musteriler: [],      // sunucudan gelenler
    yereller: [],        // çevrimdışı eklenenler (henüz sunucuda yok)
    secili: null,
    sonSiparis: null,
    arama: ''
  };

  var bagli = false;
  var aramaSaat = null;

  function M() {
    return window.PlasiyerSiparisMotor;
  }

  function V() {
    return window.PlasiyerVitrin;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function paraYaz(n) {
    if ('function' === typeof window.para) {
      try { return window.para(n); } catch (e) { /* yedek */ }
    }

    return (Number(n) || 0).toFixed(2) + ' ₺';
  }

  function sepet() {
    return V() ? V().sepetAl() : M().sepetKur();
  }

  function tavan() {
    return V() ? V().tavanAl() : 0;
  }

  function yaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  /* ------------------------------------------------------------------ *
   *  YEREL MÜŞTERİ DEPOSU (ayarlar.json)
   * ------------------------------------------------------------------ */

  async function yerelleriYukle() {
    try {
      var ayar = await ipcRenderer.invoke('ayar:oku');
      var liste = (ayar && ayar[YEREL_ANAHTAR]) || [];

      durumM.yereller = Array.isArray(liste) ? liste : [];
    } catch (e) {
      durumM.yereller = [];
    }
  }

  async function yerelleriKaydet() {
    try {
      var yeni = {};
      yeni[YEREL_ANAHTAR] = durumM.yereller;

      await ipcRenderer.invoke('ayar:yaz', yeni);
    } catch (e) { /* kayıt başarısızlığı akışı durdurmaz */ }
  }

  /* ------------------------------------------------------------------ *
   *  MÜŞTERİ LİSTESİ
   * ------------------------------------------------------------------ */

  /**
   * Plasiyere bağlı müşteriler.
   *
   * Plasiyer oturumunda `plasiyer:get-dealers` kullanılır: kimlik ana süreç
   * belleğindeki OTURUMDAN okunur, arayüzden değil — arayüzdeki bir hata
   * başka bir plasiyerin müşterilerini getirtemez.
   *
   * Yönetici oturumunda tüm bayiler listelenir (wc/v3/customers).
   */
  async function musterileriGetir() {
    var oturum = (window.durum && window.durum.oturum) || {};

    if ('plasiyer' === oturum.rol) {
      var cevap = await ipcRenderer.invoke('plasiyer:get-dealers', { arama: durumM.arama, adet: 200 });

      if (!cevap || !cevap.ok) {
        durumM.musteriler = [];
        return { ok: false, hata: (cevap && cevap.hata) || 'Müşteri listesi alınamadı.' };
      }

      durumM.musteriler = ((cevap.veri && cevap.veri.bayiler) || []).map(function (b) {
        return {
          id: Number(b.id) || 0,
          unvan: String(b.unvan || b.ad || ''),
          ad: String(b.ad || ''),
          vergiNo: String(b.vergiNo || ''),
          il: String(b.il || ''),
          ilce: String(b.ilce || ''),
          telefon: String(b.telefon || ''),
          acikBakiye: Number(b.acikBakiye) || 0,
          gecici: false
        };
      });

      return { ok: true };
    }

    /* Yönetici: WooCommerce müşteri ucu (byom eki bakiyeyi taşır). */
    var woo = await woo_musteriler();

    durumM.musteriler = woo;

    return { ok: true };
  }

  async function woo_musteriler() {
    var cevap = await window.woo('/customers', { sorgu: { per_page: 100, search: durumM.arama } });

    if (!cevap || !cevap.ok || !Array.isArray(cevap.veri)) return [];

    return cevap.veri.map(function (c) {
      var byom = c.byom || {};
      var fatura = c.billing || {};

      return {
        id: Number(c.id) || 0,
        unvan: String(fatura.company || (c.first_name + ' ' + c.last_name).trim() || c.email || ''),
        ad: String((c.first_name + ' ' + c.last_name).trim() || ''),
        vergiNo: '',
        il: String(fatura.state || ''),
        ilce: String(fatura.city || ''),
        telefon: String(fatura.phone || ''),
        acikBakiye: Number(byom.acikBakiye) || 0,
        gecici: false
      };
    });
  }

  /** Sunucudakiler + çevrimdışı eklenenler, aramaya göre süzülmüş. */
  function tumMusteriler() {
    var q = String(durumM.arama || '').toLocaleLowerCase('tr');

    var hepsi = durumM.yereller.concat(durumM.musteriler);

    if (!q) return hepsi;

    return hepsi.filter(function (m) {
      return (m.unvan + ' ' + m.ad + ' ' + m.vergiNo + ' ' + m.il).toLocaleLowerCase('tr').indexOf(q) !== -1;
    });
  }

  /* ------------------------------------------------------------------ *
   *  ÜST ŞERİT
   * ------------------------------------------------------------------ */

  function seridiCiz() {
    var kap = el('musteriSerit');

    if (!kap) return;

    if (!durumM.secili) {
      kap.innerHTML =
        '<div class="flex items-center gap-2 flex-wrap">' +
          '<button type="button" id="musteriSec" class="px-5 py-3 rounded-xl bg-marka-700 text-white font-extrabold hover:bg-marka-600 transition">' +
            '👤 Müşteri Seç' +
          '</button>' +
          '<button type="button" id="musteriYeni" class="px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
            '+ Yeni Müşteri' +
          '</button>' +
          '<span class="text-sm text-slate-500 dark:text-slate-400">Sipariş yazmak için müşteri seçin.</span>' +
        '</div>';

      baglaSerit();
      return;
    }

    var m = durumM.secili;
    var risk = Number(m.acikBakiye) || 0;

    kap.innerHTML =
      '<div class="flex items-center gap-3 flex-wrap">' +
        '<div class="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-700">' +
          '<div class="font-extrabold leading-tight">' + kacis(m.unvan) +
            (m.gecici ? ' <span class="ml-1 px-2 py-0.5 rounded-lg bg-amber-200 text-amber-900 text-xs font-black">ÇEVRİMDIŞI</span>' : '') +
          '</div>' +
          '<div class="text-xs text-slate-500 dark:text-slate-400">' +
            kacis([m.vergiNo, m.il, m.ilce].filter(Boolean).join(' · ') || '—') +
          '</div>' +
        '</div>' +

        /* CARİ RİSK UYARISI — borç varsa kırmızı, yoksa sessiz. */
        (risk > 0
          ? '<div class="px-4 py-2.5 rounded-xl bg-red-50 text-red-800 border-2 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900 font-bold">' +
              '⚠ Açık Bakiye: ' + kacis(paraYaz(risk)) +
            '</div>'
          : '<div class="px-4 py-2.5 rounded-xl bg-emerald-50 text-emerald-800 border-2 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 font-bold">' +
              '✓ Bakiye temiz' +
            '</div>') +

        '<button type="button" id="sonSiparisKopya" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
          '📋 Son Siparişi Sepete Kopyala' +
        '</button>' +

        '<button type="button" id="musteriDegistir" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
          'Değiştir' +
        '</button>' +
      '</div>';

    baglaSerit();
  }

  function baglaSerit() {
    var sec = el('musteriSec');
    if (sec) sec.addEventListener('click', secimPerdesiniAc);

    var degistir = el('musteriDegistir');
    if (degistir) degistir.addEventListener('click', secimPerdesiniAc);

    var yeni = el('musteriYeni');
    if (yeni) yeni.addEventListener('click', yeniPerdesiniAc);

    var kopya = el('sonSiparisKopya');
    if (kopya) kopya.addEventListener('click', sonSiparisiKopyala);
  }

  /* ------------------------------------------------------------------ *
   *  MÜŞTERİ SEÇİM PENCERESİ
   * ------------------------------------------------------------------ */

  function perdeAc(icerik) {
    var perde = el('satisPerde');
    var modal = el('satisModal');

    if (!perde || !modal) return null;

    modal.innerHTML = icerik;
    perde.hidden = false;

    return modal;
  }

  function perdeKapat() {
    var perde = el('satisPerde');
    var modal = el('satisModal');

    if (perde) perde.hidden = true;
    if (modal) modal.innerHTML = '';
  }

  async function secimPerdesiniAc() {
    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div class="text-xl font-extrabold">Müşteri Seç</div>' +
        '<button type="button" id="satisKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +
      '<input id="musteriArama" type="search" autocomplete="off" placeholder="Ünvan, vergi no ya da il…" ' +
             'class="mt-5 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
      '<div id="musteriListe" class="mt-4 max-h-80 overflow-y-auto">' +
        '<div class="py-6 text-center text-slate-500">Yükleniyor…</div>' +
      '</div>' +
      '<button type="button" id="musteriYeniAlt" class="mt-4 w-full px-5 py-3 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
        '+ Çevrimdışı Yeni Müşteri Ekle' +
      '</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);
    el('musteriYeniAlt').addEventListener('click', yeniPerdesiniAc);

    var arama = el('musteriArama');

    arama.addEventListener('input', function () {
      if (aramaSaat) window.clearTimeout(aramaSaat);

      aramaSaat = window.setTimeout(function () {
        durumM.arama = arama.value;
        listeyiCiz();
      }, 140);
    });

    await yerelleriYukle();

    var sonuc = await musterileriGetir();

    if (!sonuc.ok) {
      el('musteriListe').innerHTML =
        '<div class="py-6 text-center text-amber-700 dark:text-amber-400 font-semibold">' + kacis(sonuc.hata) + '</div>';
      return;
    }

    listeyiCiz();
    arama.focus();
  }

  function listeyiCiz() {
    var kap = el('musteriListe');

    if (!kap) return;

    var liste = tumMusteriler();

    if (!liste.length) {
      kap.innerHTML = '<div class="py-6 text-center text-slate-500 dark:text-slate-400">Müşteri bulunamadı.</div>';
      return;
    }

    kap.innerHTML = liste.map(function (m) {
      var risk = Number(m.acikBakiye) || 0;

      return '<button type="button" class="musteri-satir w-full text-left px-4 py-3 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition border-b border-slate-100 dark:border-slate-700" ' +
              'data-id="' + kacis(String(m.id)) + '">' +
        '<div class="font-bold">' + kacis(m.unvan) +
          (m.gecici ? ' <span class="px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-black">ÇEVRİMDIŞI</span>' : '') +
        '</div>' +
        '<div class="text-xs text-slate-500 dark:text-slate-400">' +
          kacis([m.vergiNo, m.il, m.ilce].filter(Boolean).join(' · ') || '—') +
          (risk > 0 ? ' · <span class="text-red-600 font-bold">Borç ' + kacis(paraYaz(risk)) + '</span>' : '') +
        '</div>' +
      '</button>';
    }).join('');

    kap.onclick = function (olay) {
      var satir = olay.target.closest('.musteri-satir');

      if (!satir) return;

      var id = satir.dataset.id;
      var bulunan = tumMusteriler().find(function (m) { return String(m.id) === String(id); });

      if (bulunan) musteriSec(bulunan);
    };
  }

  function musteriSec(m) {
    durumM.secili = m;
    durumM.sonSiparis = null;

    sepet().musteri = m;

    perdeKapat();
    seridiCiz();

    if (Number(m.acikBakiye) > 0) {
      bildir('Dikkat: ' + m.unvan + ' — açık bakiye ' + paraYaz(m.acikBakiye), 'uyari');
    }
  }

  /* ------------------------------------------------------------------ *
   *  ÇEVRİMDIŞI YENİ MÜŞTERİ
   * ------------------------------------------------------------------ */

  function yeniPerdesiniAc() {
    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div>' +
          '<div class="text-xl font-extrabold">Yeni Müşteri</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' +
            'Çevrimdışı kaydedilir, eşitlemede sunucuya iletilir.' +
          '</div>' +
        '</div>' +
        '<button type="button" id="satisKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +

      alan('ymUnvan', 'Firma ünvanı *', 'text') +
      alan('ymYetkili', 'Yetkili adı', 'text') +
      alan('ymVergi', 'Vergi / TC no', 'text') +
      alan('ymTelefon', 'Telefon', 'tel') +
      alan('ymIl', 'İl', 'text') +
      alan('ymIlce', 'İlçe', 'text') +

      '<p id="ymHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
      '<button type="button" id="ymKaydet" class="mt-6 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">Kaydet ve Seç</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);
    el('ymKaydet').addEventListener('click', yeniKaydet);
    el('ymUnvan').focus();
  }

  function alan(id, etiket, tip) {
    return '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="' + id + '">' + etiket + '</label>' +
      '<input id="' + id + '" type="' + tip + '" autocomplete="off" ' +
             'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />';
  }

  async function yeniKaydet() {
    var sonuc = M().geciciMusteri({
      unvan: el('ymUnvan').value,
      yetkili: el('ymYetkili').value,
      vergiNo: el('ymVergi').value,
      telefon: el('ymTelefon').value,
      il: el('ymIl').value,
      ilce: el('ymIlce').value
    });

    if (!sonuc.ok) {
      yaz(el('ymHata'), sonuc.hata);
      return;
    }

    durumM.yereller.unshift(sonuc.musteri);

    await yerelleriKaydet();

    musteriSec(sonuc.musteri);

    bildir('Müşteri çevrimdışı kaydedildi. Eşitlemede sunucuya iletilecek.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  SON SİPARİŞİ KOPYALA
   * ------------------------------------------------------------------ */

  async function sonSiparisiKopyala() {
    if (!durumM.secili) return bildir('Önce müşteri seçin.', 'uyari');

    /* Çevrimdışı eklenen müşterinin sunucuda siparişi olamaz. */
    if (M().geciciMi(durumM.secili.id)) {
      return bildir('Bu müşteri henüz sunucuda kayıtlı değil; geçmiş siparişi yok.', 'uyari');
    }

    var cevap = await window.woo('/orders', {
      sorgu: { customer: durumM.secili.id, per_page: 1, orderby: 'date', order: 'desc' }
    });

    if (!cevap || !cevap.ok || !Array.isArray(cevap.veri) || !cevap.veri.length) {
      return bildir('Bu müşterinin geçmiş siparişi bulunamadı.', 'uyari');
    }

    var siparis = cevap.veri[0];

    /*
     * Ürünleri YEREL KATALOGDAN çözüyoruz: motorun `urunBul` geri çağrısı
     * bugünün fiyatını verir. Siparişteki fiyat geçmişe aittir; onu kopyalamak
     * zam görmüş ürünü zararına satmak olurdu.
     */
    var sonuc = M().sonSiparisiKopyala(siparis, yerelUrunBul, sepet());

    durumM.sonSiparis = siparis;

    if (V()) V().sepetiCiz();

    var mesaj = sonuc.eklenen + ' kalem sepete eklendi.';

    if (sonuc.atlanan.length) {
      mesaj += ' ' + sonuc.atlanan.length + ' kalem katalogda bulunamadı: ' +
        sonuc.atlanan.map(function (a) { return a.ad; }).join(', ');
    }

    bildir(mesaj, sonuc.atlanan.length ? 'uyari' : 'ok');
  }

  /**
   * Ürünü önce açık vitrinden, bulamazsa YEREL DEPODAN arar.
   *
   * Senkron olmak ZORUNDA (motor senkron çağırıyor), bu yüzden IPC
   * kullanılamaz; vitrinde olmayan kalem için son siparişten gelen ad ve
   * koli bilgisi kullanılır ve kalem "katalogda yok" sayılmaz ise eklenir.
   * Katalog eşitlenmişse ürün zaten vitrin listesindedir.
   */
  function yerelUrunBul(id) {
    if (V()) {
      var u = V().urunBul(id);
      if (u) return u;
    }

    return null;
  }

  /* ------------------------------------------------------------------ *
   *  SİPARİŞİ TAMAMLA
   * ------------------------------------------------------------------ */

  function tamamlamaAc() {
    var s = sepet();
    var t = M().toplamlar(s, tavan());

    if (!s.satirlar.length) return bildir('Sepet boş.', 'uyari');
    if (!durumM.secili) return bildir('Önce müşteri seçin.', 'uyari');

    var modal = perdeAc(
      '<div class="flex items-start justify-between gap-4">' +
        '<div>' +
          '<div class="text-xl font-extrabold">Siparişi Tamamla</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' + kacis(durumM.secili.unvan) + '</div>' +
        '</div>' +
        '<button type="button" id="satisKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +

      /* ÖDEME — ÜÇ SEÇENEK, fazlası yok (şirket politikası). */
      '<div class="mt-6 text-sm font-bold text-slate-600 dark:text-slate-300">Ödeme Yöntemi *</div>' +
      '<div class="mt-2 grid grid-cols-3 gap-2">' +
        M().ODEME_YONTEMLERI.map(function (y) {
          return '<button type="button" class="odeme-sec px-4 py-4 rounded-xl border-2 font-extrabold transition ' +
            (s.odeme === y
              ? 'bg-marka-700 text-white border-marka-700'
              : 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700') +
            '" data-odeme="' + y + '">' + kacis(M().ODEME_ETIKET[y]) + '</button>';
        }).join('') +
      '</div>' +

      '<label class="block mt-5 text-sm font-bold text-slate-600 dark:text-slate-300" for="vadeNotu">' +
        'Vade Şartı / Şirket Politikası Notu <span class="font-normal opacity-70">(isteğe bağlı)</span>' +
      '</label>' +
      '<textarea id="vadeNotu" rows="2" placeholder="Örn: Vadeli siparişler 30 gün içinde nakden tahsil edilir." ' +
                'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900">' + kacis(s.vadeNotu || '') + '</textarea>' +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="siparisNotu">' +
        'Sevkiyat / Sipariş Notu <span class="font-normal opacity-70">(isteğe bağlı)</span>' +
      '</label>' +
      '<textarea id="siparisNotu" rows="2" placeholder="Örn: Sabah 09:00 öncesi teslim." ' +
                'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900">' + kacis(s.siparisNotu || '') + '</textarea>' +

      /* İSKONTO — tavan açıkça yazılır. */
      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="iskontoOran">' +
        'İskonto (%) <span class="font-normal opacity-70">— en fazla %' + tavan() + '</span>' +
      '</label>' +
      '<input id="iskontoOran" type="number" min="0" max="' + tavan() + '" step="0.5" value="' + (Number(s.iskonto) || 0) + '" ' +
             'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold" />' +

      '<div id="tamamlaOzet" class="mt-5 p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 space-y-1"></div>' +
      '<p id="tamamlaHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
      '<button type="button" id="tamamlaGonder" class="mt-5 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">' +
        'Siparişi Kaydet' +
      '</button>'
    );

    if (!modal) return;

    el('satisKapat').addEventListener('click', perdeKapat);

    modal.querySelectorAll('.odeme-sec').forEach(function (d) {
      d.addEventListener('click', function () {
        s.odeme = d.dataset.odeme;
        tamamlamaAc();   // yeniden çiz (seçim görünsün)
      });
    });

    el('vadeNotu').addEventListener('input', function () { s.vadeNotu = this.value; });
    el('siparisNotu').addEventListener('input', function () { s.siparisNotu = this.value; });

    var iskonto = el('iskontoOran');

    iskonto.addEventListener('change', function () {
      var karar = M().iskontoYaz(s, iskonto.value, tavan());

      if (!karar.ok) {
        yaz(el('tamamlaHata'), karar.hata);
        iskonto.value = karar.tavan;   // TAVANA kırp
      } else {
        yaz(el('tamamlaHata'), '');
      }

      ozetiCiz();
      if (V()) V().sepetiCiz();
    });

    el('tamamlaGonder').addEventListener('click', gonder);

    ozetiCiz();

    function ozetiCiz() {
      var g = M().toplamlar(s, tavan());
      var kutu = el('tamamlaOzet');

      if (!kutu) return;

      kutu.innerHTML =
        '<div class="flex justify-between"><span>Kalem</span><span class="font-bold">' + g.satir + ' satır · ' + g.kalem + ' adet' + (g.koli ? ' · ' + g.koli + ' koli' : '') + '</span></div>' +
        '<div class="flex justify-between"><span>Ara toplam</span><span class="font-bold">' + kacis(paraYaz(g.araToplam)) + '</span></div>' +
        (g.indirim > 0 ? '<div class="flex justify-between text-emerald-700 dark:text-emerald-400"><span>İskonto %' + g.iskontoOrani + '</span><span class="font-bold">−' + kacis(paraYaz(g.indirim)) + '</span></div>' : '') +
        '<div class="flex justify-between text-lg font-black"><span>Genel toplam</span><span>' + kacis(paraYaz(g.genelToplam)) + '</span></div>';
    }

    /* Boş sepet/müşteri ile buraya gelinmez; t yalnızca ilk çizimde kullanılır. */
    void t;
  }

  async function gonder() {
    var s = sepet();
    var oturum = (window.durum && window.durum.oturum) || {};

    var denetim = M().siparisDenetle(s, tavan());

    if (!denetim.ok) {
      yaz(el('tamamlaHata'), denetim.hatalar.join(' '));
      return;
    }

    var govde = M().siparisGovdesi(s, oturum, tavan());

    /*
     * FAZ 2 SINIRI: sipariş gövdesi hazır ve doğrulanmış durumda yerel
     * kuyruğa yazılır. Sunucuya gönderen eşitleme ucu FAZ 3'tedir
     * (`POST /plasiyer/siparis` + çevrimdışı kuyruk). Burada yarım bir
     * gönderim denemek, plasiyerin "kaydettim" sanıp siparişin kaybolmasına
     * yol açardı; o yüzden kuyruk açıkça yerel ve görünür tutuluyor.
     */
    var dugme = el('tamamlaGonder');

    if (dugme) dugme.disabled = true;

    try {
      var ayar = await ipcRenderer.invoke('ayar:oku');
      var kuyruk = (ayar && ayar.plasiyerSiparisKuyrugu) || [];

      if (!Array.isArray(kuyruk)) kuyruk = [];

      kuyruk.push({ kayit: govde, zaman: new Date().toISOString(), durum: 'bekliyor' });

      await ipcRenderer.invoke('ayar:yaz', { plasiyerSiparisKuyrugu: kuyruk });
    } catch (e) {
      if (dugme) dugme.disabled = false;
      yaz(el('tamamlaHata'), 'Sipariş yerel kuyruğa yazılamadı.');
      return;
    }

    if (dugme) dugme.disabled = false;

    perdeKapat();

    M().bosalt(s);
    s.odeme = '';
    s.vadeNotu = '';
    s.siparisNotu = '';
    s.iskonto = 0;

    if (V()) V().sepetiCiz();

    bildir('Sipariş yerel kuyruğa kaydedildi (' + govde.kalemler.length + ' kalem). Eşitlemede sunucuya gönderilecek.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function kur() {
    if (bagli) return;
    bagli = true;

    /* Esc: satış penceresini kapat. */
    document.addEventListener('keydown', function (olay) {
      var perde = el('satisPerde');

      if ('Escape' === olay.key && perde && !perde.hidden) perdeKapat();
    });

    yerelleriYukle();
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.PlasiyerMusteri = {
    seridiCiz: seridiCiz,
    secimPerdesiniAc: secimPerdesiniAc,
    yeniPerdesiniAc: yeniPerdesiniAc,
    sonSiparisiKopyala: sonSiparisiKopyala,
    tamamlamaAc: tamamlamaAc,
    musteriSec: musteriSec,
    durum: durumM,
    YEREL_ANAHTAR: YEREL_ANAHTAR
  };
})();
