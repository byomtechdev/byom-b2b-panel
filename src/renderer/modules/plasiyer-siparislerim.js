/* ============================================================================
 *  KENDİ SİPARİŞLERİM — SAHA ŞABLONU (src/renderer/modules/plasiyer-siparislerim.js)
 *  ---------------------------------------------------------------------------
 *  Plasiyer kabuğunun sipariş ekranı. Yöneticinin "Siparişler & Depo Fişi"
 *  gövdesinden (#sekme-siparisler) TAMAMEN AYRIDIR — Faz 10.
 *
 *  NEDEN AYRI ŞABLON: Faz 6-9'da iki rol aynı gövdeyi paylaşıyor, plasiyer
 *  listesi panelde süzülüyordu. Görsel 5: "Kendi Siparişlerim"e basan plasiyer
 *  yöneticinin ekranını (bütün şirket siparişleri, [Siparişi Hazırla] /
 *  [Kargoya Verildi] / [Revize Et]) görüyordu. Paylaşılan gövdede rol kapısı
 *  eklemek belirtiyi kapatır, sebebi kapatmaz: liste zaten cihaza iniyordu.
 *
 *  İKİ KAYNAK, TEK LİSTE:
 *    1) Çevrimdışı kuyruk (ayarlar.json → plasiyerSiparisKuyrugu) — üstte
 *       şerit olarak (PlasiyerMusteri.kuyrukSeridiniCiz).
 *    2) Sunucudaki kendi siparişleri — GET /plasiyer/siparislerim, JETONLA
 *       daraltılır (_b2b_plasiyer_id = oturumdaki plasiyer). Ana süreç
 *       `plasiyer:get-orders` kimliği OTURUMDAN okur; arayüz söyleyemez.
 *
 *  TEK EYLEM: [📄 Sipariş / Fiş Detayı] — kalem dökümü açılır/kapanır. Depo
 *  düğmeleri burada YOKTUR ve olmayacaktır; plasiyer depo işi yapmaz.
 * ==========================================================================*/

'use strict';

(function () {

  var durumS = {
    siparisler: [],
    yukleniyor: false,
    hata: '',
    acik: {}          // siparisId → detay açık mı
  };

  var bagli = false;

  function el(id) {
    return document.getElementById(id);
  }

  function oturum() {
    return (window.durum && window.durum.oturum) || {};
  }

  function plasiyerMi() {
    return 'plasiyer' === oturum().rol;
  }

  function paraYaz(n) {
    if ('function' === typeof window.para) {
      try { return window.para(n); } catch (e) { /* yedek */ }
    }

    return (Number(n) || 0).toFixed(2) + ' ₺';
  }

  function tarihYaz(iso) {
    try {
      var t = new Date(iso);
      if (isNaN(t.getTime())) return '';
      return t.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  /** Sunucu yanıtındaki siparişi kart nesnesine indirger (sözleşme: prepare_order). */
  function normalle(s) {
    var fatura = s.billing || {};
    var bayi = s.dealer || {};

    return {
      id: Number(s.id) || 0,
      numara: String(s.number || s.id || ''),
      tarih: String(s.date_created || s.date || ''),
      durum: String(s.status || ''),
      durumEtiketi: String(s.status_label || s.status || ''),
      tutar: Number(s.total || 0),
      musteri: String(bayi.company_name || fatura.company || [fatura.first_name, fatura.last_name].filter(Boolean).join(' ') || 'Müşteri'),
      odeme: String(s.payment_method_title || s.odeme_tipi || ''),
      iskonto: Number(s.plasiyer_iskonto || 0) || 0,
      kalemler: (s.line_items || s.kalemler || []).map(function (k) {
        return {
          ad: String(k.name || k.ad || ''),
          adet: Number(k.quantity || k.adet || 0),
          tutar: Number(k.total || k.tutar || 0)
        };
      }),
      notlar: String(s.customer_note || '')
    };
  }

  var DURUM_RENK = {
    processing: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    'on-hold': 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    pending: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600',
    completed: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
    cancelled: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30',
    refunded: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30'
  };

  function durumSinifi(durum) {
    var kod = String(durum || '').replace(/^wc-/, '');
    return DURUM_RENK[kod] || 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30';
  }

  /* ------------------------------------------------------------------ *
   *  ÇİZİM
   * ------------------------------------------------------------------ */

  function kartHtml(s) {
    var acik = !!durumS.acik[s.id];
    var adetToplam = s.kalemler.reduce(function (t, k) { return t + k.adet; }, 0);

    return '' +
      '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 shadow-sm p-5 flex flex-col gap-3" data-siparis="' + s.id + '">' +
        '<div class="flex flex-col lg:flex-row lg:items-center gap-4">' +
          '<div class="shrink-0 w-full lg:w-32">' +
            '<div class="text-xs font-bold text-slate-400">SİPARİŞ NO</div>' +
            '<div class="text-2xl font-black">#' + kacis(s.numara) + '</div>' +
          '</div>' +
          '<div class="flex-1 min-w-0">' +
            '<div class="text-xl font-extrabold truncate">' + kacis(s.musteri) + '</div>' +
            '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' +
              kacis(tarihYaz(s.tarih)) + ' · ' + s.kalemler.length + ' çeşit / ' + adetToplam + ' adet' +
              (s.odeme ? ' · ' + kacis(s.odeme) : '') +
              (s.iskonto > 0 ? ' · iskonto %' + kacis(String(s.iskonto)) : '') +
            '</div>' +
          '</div>' +
          '<div class="shrink-0 lg:text-right">' +
            '<div class="text-2xl font-black text-emerald-600 dark:text-emerald-400">' + kacis(paraYaz(s.tutar)) + '</div>' +
            '<span class="inline-block mt-1 px-3 py-1 rounded-lg border-2 text-sm font-bold ' + durumSinifi(s.durum) + '">' + kacis(s.durumEtiketi) + '</span>' +
          '</div>' +
        '</div>' +
        /* TEK EYLEM: depo düğmeleri YOK. */
        '<div class="flex justify-end pt-3 border-t-2 border-dashed border-slate-200 dark:border-slate-700">' +
          '<button type="button" class="siparis-detay-ac h-12 px-5 rounded-2xl border-2 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 font-extrabold transition hover:bg-slate-100 dark:hover:bg-slate-700" ' +
                  'data-id="' + s.id + '" aria-expanded="' + (acik ? 'true' : 'false') + '">' +
            '📄 Sipariş / Fiş Detayı' +
          '</button>' +
        '</div>' +
        '<div class="siparis-detay"' + (acik ? '' : ' hidden') + '>' +
          (s.kalemler.length
            ? '<table class="w-full text-base"><tbody>' +
              s.kalemler.map(function (k) {
                return '<tr class="border-t border-slate-100 dark:border-slate-700">' +
                  '<td class="py-2 pr-3">' + kacis(k.ad) + '</td>' +
                  '<td class="py-2 pr-3 text-right font-bold whitespace-nowrap">' + k.adet + ' adet</td>' +
                  '<td class="py-2 text-right font-black whitespace-nowrap">' + kacis(paraYaz(k.tutar)) + '</td>' +
                '</tr>';
              }).join('') +
              '</tbody></table>'
            : '<div class="text-sm text-slate-500">Kalem dökümü yok.</div>') +
          (s.notlar ? '<div class="mt-3 text-sm rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3"><b>Not:</b> ' + kacis(s.notlar) + '</div>' : '') +
        '</div>' +
      '</div>';
  }

  function ciz() {
    var kap = el('siparislerimListe');
    var ozet = el('siparislerimOzet');

    if (!kap) return;

    if (ozet) {
      ozet.textContent = durumS.yukleniyor
        ? 'yükleniyor…'
        : (durumS.siparisler.length ? durumS.siparisler.length + ' sipariş' : 'sipariş yok');
    }

    if (durumS.yukleniyor && !durumS.siparisler.length) {
      kap.innerHTML = '<div class="py-12 text-center text-slate-500">Siparişleriniz getiriliyor…</div>';
      return;
    }

    if (durumS.hata && !durumS.siparisler.length) {
      kap.innerHTML =
        '<div class="py-12 text-center bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700">' +
          '<div class="text-xl font-bold text-amber-700 dark:text-amber-400">Siparişler alınamadı</div>' +
          '<p class="mt-2 text-slate-500 dark:text-slate-400">' + kacis(durumS.hata) + '</p>' +
          '<p class="mt-1 text-sm text-slate-500">Çevrimdışı yazdığınız siparişler yukarıdaki kuyrukta durur.</p>' +
        '</div>';
      return;
    }

    if (!durumS.siparisler.length) {
      kap.innerHTML =
        '<div class="py-12 text-center bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700">' +
          '<div class="text-5xl mb-4" aria-hidden="true">📦</div>' +
          '<div class="text-xl font-bold">Sunucuda henüz siparişiniz yok</div>' +
          '<p class="mt-2 text-slate-500 dark:text-slate-400">Katalog &amp; Satış\'tan yazdığınız siparişler eşitlenince burada listelenir.</p>' +
        '</div>';
      return;
    }

    kap.innerHTML = durumS.siparisler.map(kartHtml).join('');
  }

  /* ------------------------------------------------------------------ *
   *  VERİ
   * ------------------------------------------------------------------ */

  async function yenile() {
    if (!plasiyerMi()) {
      durumS.siparisler = [];
      durumS.hata = 'Plasiyer oturumu yok.';
      ciz();
      return;
    }

    durumS.yukleniyor = true;
    durumS.hata = '';
    ciz();

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('plasiyer:get-orders', { adet: 100 });
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Ağ hatası.' };
    }

    durumS.yukleniyor = false;

    if (!cevap || !cevap.ok) {
      durumS.hata = (cevap && cevap.hata) || 'Siparişler alınamadı.';
      ciz();
      return;
    }

    var liste = (cevap.veri && (cevap.veri.siparisler || cevap.veri.orders)) || [];

    durumS.siparisler = (Array.isArray(liste) ? liste : []).map(normalle);
    ciz();
  }

  /** Sekme açılınca: önce kuyruk şeridi (yerel, anında), sonra sunucu listesi. */
  function sekmeyiAc() {
    if (window.PlasiyerMusteri && 'function' === typeof window.PlasiyerMusteri.kuyrukSeridiniCiz) {
      window.PlasiyerMusteri.kuyrukSeridiniCiz();
    }

    yenile();
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function kur() {
    if (bagli) return;
    bagli = true;

    var kap = el('siparislerimListe');

    if (kap) {
      kap.addEventListener('click', function (olay) {
        var dugme = olay.target.closest('.siparis-detay-ac');

        if (!dugme) return;

        var id = dugme.dataset.id;
        var kart = dugme.closest('[data-siparis]');
        var detay = kart ? kart.querySelector('.siparis-detay') : null;

        durumS.acik[id] = !durumS.acik[id];

        if (detay) detay.hidden = !durumS.acik[id];
        dugme.setAttribute('aria-expanded', durumS.acik[id] ? 'true' : 'false');
      });
    }

    var yenileDugme = el('siparislerimYenile');
    if (yenileDugme) yenileDugme.addEventListener('click', sekmeyiAc);

    /* `sekmeAc` SARILIR (renderer.js'e dokunmadan). */
    if ('function' === typeof window.sekmeAc) {
      var ozgun = window.sekmeAc;

      window.sekmeAc = function (ad) {
        var sonuc = ozgun.apply(this, arguments);

        if ('siparislerim' === ad) sekmeyiAc();

        return sonuc;
      };
    }
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.PlasiyerSiparislerim = {
    yenile: yenile,
    sekmeyiAc: sekmeyiAc,
    ciz: ciz,
    normalle: normalle,
    durum: durumS
  };
})();
