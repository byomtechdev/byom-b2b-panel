'use strict';
/* ============================================================================
 *  PERFORMANSIM — plasiyerin kendi analitik sekmesi (Faz 11)
 *  ---------------------------------------------------------------------------
 *  Saha kabuğunun 4. sekmesi (#sekme-performansim). Veri TEK IPC turuyla gelir:
 *  plasiyer:performans → GET /plasiyer/performans (jeton ana süreç belleğinde).
 *
 *    · Günlük / haftalık / aylık sipariş adedi ve NET ciro kartları
 *    · Bağlı bayilerin ciro katkısı (yüzde çubuğuyla)
 *    · Mesul olunan illerdeki müşteri dağılımı
 *
 *  Yönetici uçları (/admin/plasiyerler, /admin/harita) plasiyer jetonuyla
 *  AÇILMAZ ve bütün şirketin verisini taşır; bu sekme yalnızca kendi damgalı
 *  siparişleri görür (sunucu ikinci kez doğrular). Çizim yalnızca burada —
 *  index.html'de kaplar durur (#performansimKartlar / #performansimBayiler /
 *  #performansimIller).
 *
 *  `sekmeAc` SARILIR (plasiyer-siparislerim.js ile aynı kalıp); `bagli`
 *  bayrağı çift sarmayı engeller (çift sarma = çift istek, bkz. §4.10).
 * ==========================================================================*/

(function () {
  var durumP = {
    veri: null,        // sunucu yanıtı (normalize edilmiş)
    yukleniyor: false,
    hata: ''
  };

  var bagli = false;

  function el(id) { return document.getElementById(id); }

  function oturum() { return (window.durum && window.durum.oturum) || null; }

  function plasiyerMi() {
    var o = oturum();
    return !!(o && 'plasiyer' === o.rol);
  }

  function paraYaz(n) {
    if ('function' === typeof window.para) return window.para(n);
    return (Number(n) || 0).toFixed(2);
  }

  function kacisYaz(s) {
    return 'function' === typeof window.kacis ? window.kacis(s) : String(s === null || s === undefined ? '' : s);
  }

  /** Sunucu yanıtını sağlamlaştırır: eksik alan hiçbir zaman NaN/undefined basmaz. */
  function normalle(v) {
    v = v || {};

    function donem(d) {
      d = d || {};
      return { siparis: Number(d.siparis) || 0, ciro: Number(d.ciro) || 0 };
    }

    var bayiler = Array.isArray(v.bayiler) ? v.bayiler : [];
    var iller = v.iller && 'object' === typeof v.iller ? v.iller : {};

    return {
      gun: donem(v.gun),
      hafta: donem(v.hafta),
      ay: donem(v.ay),
      paraBirimi: String(v.paraBirimi || ''),
      wooCommerce: false !== v.wooCommerce,
      bayiler: bayiler.map(function (b) {
        return {
          id: Number(b && b.id) || 0,
          unvan: String((b && b.unvan) || ''),
          il: String((b && b.il) || '—'),
          siparis: Number(b && b.siparis) || 0,
          ciro: Number(b && b.ciro) || 0
        };
      }),
      iller: Object.keys(iller).map(function (ad) {
        var x = iller[ad] || {};
        return {
          ad: ad,
          musteri: Number(x.musteri) || 0,
          siparis: Number(x.siparis) || 0,
          ciro: Number(x.ciro) || 0
        };
      }).sort(function (a, b) { return b.musteri - a.musteri || b.ciro - a.ciro || a.ad.localeCompare(b.ad, 'tr'); })
    };
  }

  /* ------------------------------------------------------------------ *
   *  ÇİZİM
   * ------------------------------------------------------------------ */

  function kart(baslik, d, renk) {
    return '<div class="rounded-2xl border-2 ' + renk + ' p-5 bg-white dark:bg-slate-800" data-donem="' + baslik.kod + '">' +
      '<div class="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">' + kacisYaz(baslik.ad) + '</div>' +
      '<div class="mt-2 text-3xl font-black tabular-nums" data-alan="ciro">' + kacisYaz(paraYaz(d.ciro)) + '</div>' +
      '<div class="mt-1 text-base font-bold text-slate-600 dark:text-slate-300"><span data-alan="siparis">' + d.siparis + '</span> sipariş · net ciro</div>' +
    '</div>';
  }

  function kartlariCiz(v) {
    var kap = el('performansimKartlar');
    if (!kap) return;

    kap.innerHTML =
      kart({ kod: 'gun', ad: 'Bugün' }, v.gun, 'border-emerald-300 dark:border-emerald-500/40') +
      kart({ kod: 'hafta', ad: 'Son 7 gün' }, v.hafta, 'border-sky-300 dark:border-sky-500/40') +
      kart({ kod: 'ay', ad: 'Son 30 gün' }, v.ay, 'border-marka-300 dark:border-marka-500/40');
  }

  function bayileriCiz(v) {
    var kap = el('performansimBayiler');
    if (!kap) return;

    var toplam = v.bayiler.reduce(function (t, b) { return t + b.ciro; }, 0);

    if (!v.bayiler.length) {
      kap.innerHTML = '<div class="rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-600 p-6 text-center text-slate-500 dark:text-slate-400 font-semibold">' +
        'Size bağlı bayi yok. Müşterilerim sekmesinden yeni müşteri ekleyebilirsiniz.</div>';
      return;
    }

    kap.innerHTML =
      '<div class="rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">' +
        '<div class="flex items-center gap-3 mb-4 flex-wrap">' +
          '<div class="text-xl font-extrabold">Bayilerimin Ciro Katkısı</div>' +
          '<span class="text-sm font-bold text-slate-500 dark:text-slate-400">son 30 gün · ' + v.bayiler.length + ' bayi</span>' +
        '</div>' +
        '<div class="flex flex-col gap-3">' +
          v.bayiler.map(function (b) {
            var pay = toplam > 0 ? Math.round((b.ciro / toplam) * 100) : 0;

            return '<div class="perf-bayi flex flex-col gap-1" data-id="' + b.id + '">' +
              '<div class="flex items-center gap-2 flex-wrap">' +
                '<span class="font-extrabold truncate min-w-0 flex-1">' + kacisYaz(b.unvan || ('#' + b.id)) + '</span>' +
                '<span class="text-xs font-bold px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">' + kacisYaz(b.il) + '</span>' +
                '<span class="text-sm font-bold text-slate-500 dark:text-slate-400">' + b.siparis + ' sipariş</span>' +
                '<span class="font-black tabular-nums">' + kacisYaz(paraYaz(b.ciro)) + '</span>' +
                '<span class="text-sm font-bold w-12 text-right">%' + pay + '</span>' +
              '</div>' +
              /* GPU dostu: genişlik yerine scaleX (§4.6 kuralı). */
              '<div class="h-2 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">' +
                '<div class="ciro-cubuk h-full rounded-full bg-emerald-500 origin-left" style="transform: scaleX(' + (pay / 100) + ')"></div>' +
              '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function illeriCiz(v) {
    var kap = el('performansimIller');
    if (!kap) return;

    if (!v.iller.length) {
      kap.innerHTML = '';
      return;
    }

    kap.innerHTML =
      '<div class="rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">' +
        '<div class="text-xl font-extrabold mb-4">Müşteri Dağılımım (İl)</div>' +
        '<div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(12rem,1fr))]">' +
          v.iller.map(function (il) {
            return '<div class="perf-il rounded-xl border-2 border-slate-100 dark:border-slate-700 p-3" data-il="' + kacisYaz(il.ad) + '">' +
              '<div class="font-extrabold truncate">' + kacisYaz(il.ad) + '</div>' +
              '<div class="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">' +
                '<span data-alan="musteri">' + il.musteri + '</span> müşteri · ' + il.siparis + ' sipariş' +
              '</div>' +
              '<div class="text-base font-black tabular-nums mt-1">' + kacisYaz(paraYaz(il.ciro)) + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function ciz() {
    var ozet = el('performansimOzet');
    var kartlar = el('performansimKartlar');

    if (durumP.hata) {
      if (ozet) ozet.textContent = 'Veri alınamadı';
      if (kartlar) {
        kartlar.innerHTML = '<div class="col-span-full rounded-2xl border-2 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-5 text-red-700 dark:text-red-300 font-bold">' +
          kacisYaz(durumP.hata) + '<div class="text-sm font-semibold mt-1">İnternet gelince "Yenile" ile tekrar deneyin.</div></div>';
      }
      return;
    }

    if (!durumP.veri) {
      if (ozet) ozet.textContent = durumP.yukleniyor ? 'Yükleniyor…' : '';
      return;
    }

    var v = durumP.veri;

    if (ozet) {
      ozet.textContent = v.ay.siparis + ' sipariş / 30 gün' + (v.wooCommerce ? '' : ' · WooCommerce kapalı');
    }

    kartlariCiz(v);
    bayileriCiz(v);
    illeriCiz(v);
  }

  /* ------------------------------------------------------------------ *
   *  VERİ
   * ------------------------------------------------------------------ */

  async function yenile() {
    if (!plasiyerMi()) return;

    durumP.yukleniyor = true;
    durumP.hata = '';
    ciz();

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('plasiyer:performans', {});
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Ağ hatası.' };
    }

    durumP.yukleniyor = false;

    if (!cevap || !cevap.ok || !cevap.veri) {
      durumP.hata = (cevap && cevap.hata) || 'Performans verisi alınamadı.';
      ciz();
      return;
    }

    durumP.veri = normalle(cevap.veri);
    ciz();
  }

  function sekmeyiAc() {
    yenile();
  }

  function kur() {
    if (bagli) return;
    bagli = true;

    var yenileDugme = el('performansimYenile');
    /* Meşgul durumuyla (Faz 20): iş bitene kadar ikon döner, ikinci basış yeni tur açmaz.
       Modül yoksa düz tıklama (zarif düşüş). */
    if (yenileDugme && window.ArayuzDugme && 'function' === typeof window.ArayuzDugme.bagla) window.ArayuzDugme.bagla(yenileDugme, yenile);
    else if (yenileDugme) yenileDugme.addEventListener('click', yenile);

    /* `sekmeAc` SARILIR (renderer.js'e dokunmadan). */
    if ('function' === typeof window.sekmeAc) {
      var ozgun = window.sekmeAc;

      window.sekmeAc = function (ad) {
        var sonuc = ozgun.apply(this, arguments);

        if ('performansim' === ad) sekmeyiAc();

        return sonuc;
      };
    }
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.PlasiyerPerformansim = {
    yenile: yenile,
    sekmeyiAc: sekmeyiAc,
    ciz: ciz,
    normalle: normalle,
    durum: durumP
  };
})();
