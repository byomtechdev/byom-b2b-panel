/* ============================================================================
 *  PAZARLAMACILAR SEKMESİ — YÖNETİCİ (src/renderer/modules/plasiyer-yonetimi.js)
 *  ---------------------------------------------------------------------------
 *  Yöneticinin plasiyer tanımladığı, PIN belirlediği, bayi atadığı ve
 *  performansı gördüğü sekme.
 *
 *  NEDEN AYRI DOSYA: `renderer.js` 330 KB'dır. Yeni bir özelliğin oraya
 *  eklenmesi dosyayı okunamaz hâle getirir ve her görevde gereksiz token
 *  yakar. Bu modül `renderer.js`'in genel yardımcılarını (durum, $, bildir,
 *  onayla, kacis, b2b, sekmeAc) KULLANIR ama içine girmez.
 *
 *  DİZİN ANLAMI:
 *    src/renderer/          → DOM'suz, node:test altında koşan motorlar
 *    src/renderer/modules/  → DOM'a bağlı özellik modülleri (bu dosya)
 *  Ayrımın sebebi: ilk gruptakiler test edilebilir, ikinci gruptakiler
 *  tarayıcı ortamı ister. Karıştırmak "neden bu dosyayı require edemiyorum"
 *  sorusunu doğurur.
 *
 *  PERFORMANS ÇUBUĞU: genişlik (`width`) DEĞİL `transform: scaleX()` ile
 *  büyür. Genişlik animasyonu her karede düzen hesabı (reflow) tetikler;
 *  scaleX kompozitörde çalışır ve 30 satırlık tabloda bile akıcı kalır.
 *
 *  SIR: PIN yalnızca forma girildiği anda okunur, isteğe konur ve alan
 *  temizlenir. Sunucu PIN'i hash'leyerek saklar; buraya asla geri gelmez —
 *  yalnızca `pinTanimli` bayrağı gelir.
 * ==========================================================================*/

'use strict';

(function () {

  /** Son çekilen liste — yeniden çizimde tekrar istek atmamak için. */
  var kayit = { plasiyerler: [], genelCiro: 0, genelSiparis: 0, paraBirimi: '', bayiler: [] };

  var bagli = false;   // çift bağlanma koruması (bkz. kök CLAUDE.md §6)

  function el(id) {
    return document.getElementById(id);
  }

  /**
   * Para biçimi.
   *
   * renderer.js'teki `para()` "kullanıcıya gösterilen TEK para biçimi"dir
   * (1.234,50 ₺ — binlik ayracı, kuruş, işaret kuralları dahil). Burada kendi
   * biçimimizi yazmak aynı ekranda İKİ farklı para görünümü demek olurdu.
   *
   * Fonksiyon adı bilinçli olarak `paraYaz`: `para` denseydi IIFE içinde
   * globali GÖLGELER ve kendi kendini çağırırdı.
   */
  function paraYaz(n) {
    var sayi = Number(n) || 0;

    if ('function' === typeof window.para) {
      try { return window.para(sayi); } catch (e) { /* yedeğe düş */ }
    }

    return sayi.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
           (kayit.paraBirimi ? ' ' + kayit.paraBirimi : '');
  }

  /* ------------------------------------------------------------------ *
   *  VERİ
   * ------------------------------------------------------------------ */

  async function listeyiGetir() {
    var kap = el('plasiyerTablo');

    if (kap) kap.innerHTML = '<div class="py-10 text-center text-slate-500">Yükleniyor…</div>';

    var cevap = await b2b('/admin/plasiyerler');

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
      if (kap) {
        kap.innerHTML = '<div class="py-10 text-center text-red-600 dark:text-red-400 font-semibold">' +
          kacis((cevap && cevap.hata) || 'Pazarlamacı listesi alınamadı.') + '</div>';
      }
      return;
    }

    kayit.plasiyerler  = cevap.veri.plasiyerler || [];
    kayit.genelCiro    = Number(cevap.veri.genelCiro) || 0;
    kayit.genelSiparis = Number(cevap.veri.genelSiparis) || 0;
    kayit.paraBirimi   = String(cevap.veri.paraBirimi || '');

    tabloyuCiz();
    ozetiTazele();
  }

  function ozetiTazele() {
    var ozet = el('plasiyerOzet');

    if (!ozet) return;

    ozet.textContent = kayit.plasiyerler.length + ' pazarlamacı · ' +
                       kayit.genelSiparis + ' sipariş · ' + paraYaz(kayit.genelCiro);
  }

  /* ------------------------------------------------------------------ *
   *  TABLO + CİRO ÇUBUĞU
   * ------------------------------------------------------------------ */

  function tabloyuCiz() {
    var kap = el('plasiyerTablo');

    if (!kap) return;

    if (!kayit.plasiyerler.length) {
      kap.innerHTML =
        '<div class="py-12 text-center">' +
          '<div class="text-5xl mb-4" aria-hidden="true">💼</div>' +
          '<div class="text-xl font-bold">Henüz pazarlamacı tanımlı değil</div>' +
          '<p class="mt-2 text-slate-500 dark:text-slate-400">' +
            '"+ Yeni Pazarlamacı" ile ad, bölge ve PIN belirleyerek başlayın.</p>' +
        '</div>';
      return;
    }

    /* Çubuk ölçeği EN YÜKSEK ciroya göre — genel toplama göre değil.
       Genel toplamla ölçeklenseydi 10 plasiyerli bir firmada tüm çubuklar
       okunamayacak kadar kısa kalırdı. */
    var enYuksek = kayit.plasiyerler.reduce(function (m, p) {
      return Math.max(m, Number(p.ciro) || 0);
    }, 0);

    var satirlar = kayit.plasiyerler.map(function (p) {
      var ciro = Number(p.ciro) || 0;
      var oran = enYuksek > 0 ? (ciro / enYuksek) : 0;
      var pay = kayit.genelCiro > 0 ? Math.round((ciro / kayit.genelCiro) * 100) : 0;

      return '' +
        '<tr class="border-t-2 border-slate-100 dark:border-slate-700">' +
          '<td class="py-4 pr-4">' +
            '<div class="font-extrabold text-lg">' + kacis(p.ad || '-') + '</div>' +
            '<div class="text-sm text-slate-500 dark:text-slate-400">' + kacis(p.kullanici || '') + '</div>' +
          '</td>' +
          '<td class="py-4 pr-4">' +
            (p.bolge
              ? '<span class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 font-bold text-sm">' + kacis(p.bolge) + '</span>'
              : '<span class="text-slate-400 text-sm">atanmamış</span>') +
          '</td>' +
          '<td class="py-4 pr-4 text-center font-bold">' + (Number(p.bayi) || 0) + '</td>' +
          '<td class="py-4 pr-4 text-center font-bold">' + (Number(p.siparis) || 0) + '</td>' +
          '<td class="py-4 pr-4 min-w-56">' +
            '<div class="font-extrabold">' + kacis(paraYaz(ciro)) + '</div>' +
            '<div class="mt-2 h-2.5 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">' +
              '<div class="ciro-cubuk h-full rounded-full bg-marka-700" ' +
                   'style="transform: scaleX(' + oran.toFixed(4) + ');" ' +
                   'role="img" aria-label="Ciro payı yüzde ' + pay + '"></div>' +
            '</div>' +
            '<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">toplamın %' + pay + '\'i</div>' +
          '</td>' +
          '<td class="py-4 text-right whitespace-nowrap">' +
            (p.pinTanimli
              ? '<span class="text-xs font-bold text-emerald-700 dark:text-emerald-400">PIN ✓</span>'
              : '<span class="text-xs font-bold text-amber-700 dark:text-amber-400">PIN yok</span>') +
            '<div class="mt-2 flex gap-2 justify-end">' +
              '<button type="button" class="plasiyer-duzenle px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + Number(p.id) + '">Düzenle</button>' +
              '<button type="button" class="plasiyer-bayiler px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + Number(p.id) + '">Bayiler</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
    }).join('');

    kap.innerHTML =
      '<div class="overflow-x-auto">' +
        '<table class="w-full text-left">' +
          '<thead class="text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">' +
            '<tr>' +
              '<th class="pb-3 pr-4">Pazarlamacı</th>' +
              '<th class="pb-3 pr-4">Bölge</th>' +
              '<th class="pb-3 pr-4 text-center">Bayi</th>' +
              '<th class="pb-3 pr-4 text-center">Sipariş</th>' +
              '<th class="pb-3 pr-4">Ciro</th>' +
              '<th class="pb-3 text-right">İşlem</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + satirlar + '</tbody>' +
        '</table>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   *  TANIMLAMA / DÜZENLEME FORMU
   * ------------------------------------------------------------------ */

  function formuKapat() {
    var perde = el('plasiyerFormPerde');
    if (perde) perde.hidden = true;

    /* PIN alanı perdeyle birlikte gitsin; DOM'da bekletilmez. */
    var form = el('plasiyerForm');
    if (form) form.innerHTML = '';
  }

  function formuAc(mevcut) {
    var perde = el('plasiyerFormPerde');
    var form = el('plasiyerForm');

    if (!perde || !form) return;

    var yeni = !mevcut;

    form.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div class="text-xl font-extrabold">' + (yeni ? 'Yeni Pazarlamacı' : 'Pazarlamacıyı Düzenle') + '</div>' +
        '<button type="button" id="plasiyerFormKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +

      '<label class="block mt-6 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfAd">Ad Soyad</label>' +
      '<input id="pfAd" type="text" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" value="' + kacis((mevcut && mevcut.ad) || '') + '" />' +

      (yeni
        ? '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfKullanici">Kullanıcı adı</label>' +
          '<input id="pfKullanici" type="text" autocomplete="off" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />' +
          '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfEposta">E-posta</label>' +
          '<input id="pfEposta" type="email" autocomplete="off" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" />'
        : '') +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfBolge">Bölge</label>' +
      '<input id="pfBolge" type="text" list="pfBolgeListe" placeholder="Ege" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" value="' + kacis((mevcut && mevcut.bolge) || '') + '" />' +
      '<datalist id="pfBolgeListe">' +
        ['Marmara', 'Ege', 'Akdeniz', 'İç Anadolu', 'Karadeniz', 'Doğu Anadolu', 'Güneydoğu Anadolu']
          .map(function (b) { return '<option value="' + b + '"></option>'; }).join('') +
      '</datalist>' +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="pfPin">PIN (4-6 rakam)</label>' +
      '<input id="pfPin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-xl font-black tracking-[0.3em] text-center" placeholder="••••" />' +
      '<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">' +
        (yeni
          ? 'Yeni pazarlamacı için PIN zorunludur.'
          : ((mevcut && mevcut.pinTanimli) ? 'PIN tanımlı. Değiştirmek için yeni PIN yazın, dokunmamak için boş bırakın.' : 'PIN tanımlı DEĞİL — panele girebilmesi için belirleyin.')) +
      '</p>' +

      '<p id="pfHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +

      '<button type="button" id="pfKaydet" class="mt-6 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 disabled:opacity-50 transition">Kaydet</button>';

    perde.hidden = false;

    el('plasiyerFormKapat').addEventListener('click', formuKapat);
    el('pfKaydet').addEventListener('click', function () { kaydet(mevcut); });

    var pin = el('pfPin');

    pin.addEventListener('input', function () {
      var temiz = pin.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (temiz !== pin.value) pin.value = temiz;
    });

    el('pfAd').focus();
  }

  async function kaydet(mevcut) {
    var dugme = el('pfKaydet');
    var hata = el('pfHata');
    var pinAlan = el('pfPin');

    var govde = {
      plasiyer_id: mevcut ? Number(mevcut.id) : 0,
      ad: String(el('pfAd').value || '').trim(),
      bolge: String(el('pfBolge').value || '').trim(),
      pin: String((pinAlan && pinAlan.value) || '')
    };

    if (!mevcut) {
      govde.kullanici = String((el('pfKullanici') || {}).value || '').trim();
      govde.eposta = String((el('pfEposta') || {}).value || '').trim();

      if (!govde.kullanici) return yaz(hata, 'Kullanıcı adı zorunludur.');
      if (!govde.eposta) return yaz(hata, 'E-posta zorunludur.');
      if (!/^[0-9]{4,6}$/.test(govde.pin)) return yaz(hata, 'Yeni pazarlamacı için 4-6 haneli PIN zorunludur.');
    } else if (govde.pin && !/^[0-9]{4,6}$/.test(govde.pin)) {
      return yaz(hata, 'PIN 4-6 haneli ve yalnızca rakam olmalıdır.');
    }

    yaz(hata, '');
    if (dugme) dugme.disabled = true;

    var cevap;

    try {
      cevap = await b2b('/admin/plasiyer', { metod: 'POST', govde: govde });
    } finally {
      /* PIN hem yükten hem ekrandan silinir. */
      govde.pin = '';
      if (pinAlan) pinAlan.value = '';
      if (dugme) dugme.disabled = false;
    }

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
      yaz(hata, (cevap && cevap.hata) || 'Kaydedilemedi.');
      return;
    }

    formuKapat();
    bildir(mevcut ? 'Pazarlamacı güncellendi.' : 'Pazarlamacı tanımlandı.', 'ok');
    listeyiGetir();
  }

  function yaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  /* ------------------------------------------------------------------ *
   *  BAYİ ATAMA
   * ------------------------------------------------------------------ */

  async function bayiPerdesiniAc(plasiyerId) {
    var p = kayit.plasiyerler.find(function (x) { return Number(x.id) === Number(plasiyerId); });

    if (!p) return;

    var perde = el('plasiyerFormPerde');
    var form = el('plasiyerForm');

    if (!perde || !form) return;

    form.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div><div class="text-xl font-extrabold">Bayi Ataması</div>' +
        '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' + kacis(p.ad) + (p.bolge ? ' — ' + kacis(p.bolge) : '') + '</div></div>' +
        '<button type="button" id="plasiyerFormKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +
      '<div class="mt-5 text-slate-600 dark:text-slate-300">Bayiler yükleniyor…</div>';

    perde.hidden = false;
    el('plasiyerFormKapat').addEventListener('click', formuKapat);

    /* Bayi listesi B2B üye listesinden gelir (mevcut uç). */
    var cevap = await b2b('/dealers', { sorgu: { per_page: 200 } });

    var bayiler = (cevap && cevap.ok && cevap.veri && (cevap.veri.dealers || cevap.veri.users || cevap.veri)) || [];

    if (!Array.isArray(bayiler) || !bayiler.length) {
      form.insertAdjacentHTML('beforeend',
        '<p class="mt-4 text-amber-700 dark:text-amber-400 font-semibold text-sm">' +
        'Bayi listesi alınamadı. Atamayı WordPress kullanıcı profilinden de yapabilirsiniz ' +
        '(Kullanıcılar ▸ Profil ▸ BYOM Plasiyer).</p>');
      return;
    }

    var satirlar = bayiler.map(function (b) {
      var id = Number(b.id || b.ID || 0);
      var ad = b.unvan || b.company || b.name || b.display_name || ('#' + id);
      var bagliMi = Number(b.plasiyerId || b.assigned_plasiyer_id || 0) === Number(plasiyerId);

      return '<label class="flex items-center gap-3 py-2 border-b border-slate-100 dark:border-slate-700">' +
        '<input type="checkbox" class="bayi-sec w-5 h-5" data-id="' + id + '"' + (bagliMi ? ' checked' : '') + ' />' +
        '<span class="font-semibold">' + kacis(ad) + '</span>' +
      '</label>';
    }).join('');

    form.querySelector('div:last-child').outerHTML =
      '<div class="mt-5 max-h-72 overflow-y-auto">' + satirlar + '</div>' +
      '<p id="pfHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +
      '<button type="button" id="pfAta" class="mt-5 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">Atamayı Kaydet</button>';

    el('pfAta').addEventListener('click', function () { atamayiKaydet(plasiyerId); });
  }

  async function atamayiKaydet(plasiyerId) {
    var dugme = el('pfAta');
    var secimler = Array.prototype.slice.call(document.querySelectorAll('.bayi-sec'));

    if (dugme) dugme.disabled = true;

    var hataSayisi = 0;

    for (var i = 0; i < secimler.length; i++) {
      var kutu = secimler[i];
      var id = Number(kutu.dataset.id) || 0;

      if (!id) continue;

      var cevap = await b2b('/admin/plasiyer/ata', {
        metod: 'POST',
        govde: { dealer_id: id, plasiyer_id: kutu.checked ? Number(plasiyerId) : 0 }
      });

      if (!cevap || !cevap.ok) hataSayisi++;
    }

    if (dugme) dugme.disabled = false;

    if (hataSayisi) {
      yaz(el('pfHata'), hataSayisi + ' bayi atanamadı.');
      return;
    }

    formuKapat();
    bildir('Bayi ataması kaydedildi.', 'ok');
    listeyiGetir();
  }

  /* ------------------------------------------------------------------ *
   *  OLAY BAĞLAMA
   * ------------------------------------------------------------------ */

  function olaylariBagla() {
    if (bagli) return;   // sekme her açılışta çağrılır; ikinci bağlanma YOK
    bagli = true;

    var yenile = el('plasiyerYenile');
    if (yenile) yenile.addEventListener('click', listeyiGetir);

    var yeni = el('plasiyerYeni');
    if (yeni) yeni.addEventListener('click', function () { formuAc(null); });

    /* Satır düğmeleri tabloyla birlikte yeniden çizildiği için OLAY
       DELEGASYONU kullanılır; her çizimde yeniden bağlamak çift tetiklemeye
       yol açardı. */
    var kap = el('plasiyerTablo');

    if (kap) {
      kap.addEventListener('click', function (olay) {
        var duzenle = olay.target.closest('.plasiyer-duzenle');

        if (duzenle) {
          var id = Number(duzenle.dataset.id);
          formuAc(kayit.plasiyerler.find(function (p) { return Number(p.id) === id; }) || null);
          return;
        }

        var bayiler = olay.target.closest('.plasiyer-bayiler');
        if (bayiler) bayiPerdesiniAc(Number(bayiler.dataset.id));
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  MEVCUT AKIŞA BAĞLANMA
   * ------------------------------------------------------------------ */

  /*
   * `sekmeAc` SARILIR, değiştirilmez: önce özgün davranış çalışır, sonra
   * sekme bizimse veriyi getiririz. renderer.js'e tek satır eklemeden
   * özellik kazanmanın yolu bu (aynı kalıp renderer-excel.js ve
   * renderer-byom.js'te de kullanılır).
   */
  function akisaBaglan() {
    if ('function' !== typeof window.sekmeAc) return;

    var ozgun = window.sekmeAc;

    window.sekmeAc = function (ad) {
      var sonuc = ozgun.apply(this, arguments);

      if ('plasiyerler' === ad) {
        olaylariBagla();
        if (!kayit.plasiyerler.length) listeyiGetir();
      }

      return sonuc;
    };
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', akisaBaglan);
  } else {
    akisaBaglan();
  }

  window.PlasiyerYonetimi = {
    listeyiGetir: listeyiGetir,
    tabloyuCiz: tabloyuCiz,
    formuAc: formuAc,
    formuKapat: formuKapat,
    kayit: kayit
  };
})();
