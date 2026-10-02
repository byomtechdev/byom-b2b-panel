/* ============================================================================
 *  GEÇMİŞ SİPARİŞ İSKONTO DENETİMİ — Ayarlar kartı (Faz 19)
 *  ---------------------------------------------------------------------------
 *  Depo Fişi 6501: kalemler sonradan 32.863,90'a çıktı, Nakit %12 iskonto
 *  3.520,92'de ÇAKILI kaldı (doğrusu 3.943,67). Eklentinin ücret motoru
 *  bundan sonraki her hesapta satırları günceller; bu kart motor devreye
 *  girmeden ÖNCE bozulmuş geçmiş siparişleri bulup düzeltir.
 *
 *    GET  /wc-b2b/v1/maintenance/fee-audit   → KURU denetim (HİÇBİR ŞEY yazmaz)
 *    POST /wc-b2b/v1/maintenance/fee-audit   → YALNIZCA seçilen siparişler
 *
 *  Kurallar:
 *   · Önce liste, sonra karar: "hepsini düzelt" düğmesi YOK; yönetici neyin
 *     değişeceğini (eski → yeni iskonto ve toplam) görüp seçer.
 *   · Varsayılan seçim yalnızca "düzeltilecek" satırlar. Belirsiz / iadeli /
 *     hatalı siparişler SEÇİLEMEZ (sunucu da dokunmaz).
 *   · Tutarı değiştiren işlem ONAY ister ve toplam farkı söyler.
 *   · Formül panelde YOK: hesap eklentidedir (B2B_Ucret_Onarim → motor).
 *
 *  Bağımlılık: renderer.js'in b2b / bildir / kacis / para / onayla / durum
 *  yardımcıları (çağrı anında okunur).
 * ==========================================================================*/

(function () {
  'use strict';

  var SAYFA_BOYUTU = 50;
  var EN_COK_SAYFA = 60;   // 3.000 sipariş — tek oturumda makul üst sınır

  var SONUC = {
    duzeltilecek: { etiket: 'Düzeltilecek', sinif: 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200', secilebilir: true, varsayilan: true },
    /* Faz 21 (canlı #6512): bayi oranı hem satır fiyatında hem ayrı satırda —
       onarım ayrı satırı kaldırır, ödeme iskontosunu güncel kalemlerden kurar. */
    cift_bayi: { etiket: 'Bayi iskontosu iki kez düşüyor', sinif: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200', secilebilir: true, varsayilan: true },
    isaret_eksik: { etiket: 'Tutar doğru · işaret eksik', sinif: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200', secilebilir: true, varsayilan: false },
    tamam: { etiket: 'Tamam', sinif: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200', secilebilir: false },
    iskonto_yok: { etiket: 'İskonto yok', sinif: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300', secilebilir: false },
    belirsiz: { etiket: 'Elle bakılmalı', sinif: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200', secilebilir: false },
    atlandi: { etiket: 'Atlandı (iade var)', sinif: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300', secilebilir: false },
    hata: { etiket: 'Okunamadı', sinif: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200', secilebilir: false },
    duzeltildi: { etiket: 'Düzeltildi', sinif: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200', secilebilir: false }
  };

  var SEBEP = {
    iade_var: 'siparişte iade var — iade tutarları eski toplama göre verildi',
    ayni_turden_iki_satir: 'aynı türden iki iskonto satırı',
    oran_cozulemedi: 'iskonto oranı çözülemedi',
    motor_yok: 'eklentide ücret motoru yok',
    bayi_iskontosu_iki_yerde: 'bayi iskontosu hem satır fiyatında hem ayrı satırda — müşteri indirimi iki kez almış'
  };

  var durumD = { satirlar: [], secili: {}, calisiyor: false, ozet: null };

  function $(sec) { return document.querySelector(sec); }

  function k(x) {
    return ('function' === typeof window.kacis) ? window.kacis(x) : String(x === null || x === undefined ? '' : x);
  }

  function p(n) {
    return ('function' === typeof window.para) ? window.para(n) : (Number(n) || 0).toFixed(2);
  }

  function bildir(m, t) {
    if ('function' === typeof window.bildir) window.bildir(m, t);
  }

  function ayarlar() {
    return (window.durum && window.durum.ayarlar) || {};
  }

  /** Bir rapor satırı seçilebilir mi? (künye eksikse "tamam" da düzeltilebilir) */
  function secilebilir(r) {
    var tanim = SONUC[r.sonuc] || {};
    return !!tanim.secilebilir || (!!r.kunye_eksik && ('tamam' === r.sonuc || 'iskonto_yok' === r.sonuc));
  }

  /** Tek satırın işaretlemesi. */
  function satirHtml(r) {
    var tanim = SONUC[r.sonuc] || { etiket: r.sonuc, sinif: 'bg-slate-100' };
    var id = Number(r.id) || 0;
    var sec = secilebilir(r);
    var degisim = (Array.isArray(r.satirlar) ? r.satirlar : []).filter(function (s) {
      return Math.abs(Number(s.fark) || 0) >= 0.005;
    }).map(function (s) {
      return k(('bayi' === s.tur ? 'Bayi' : 'Ödeme') + ' %' + String(s.oran).replace('.', ',') + ': ') +
        '<span class="text-red-700 dark:text-red-300 line-through">' + k(p(s.eski)) + '</span> → ' +
        '<span class="text-emerald-700 dark:text-emerald-300 font-black">' + k(p(s.yeni)) + '</span>';
    }).join(' · ');

    var fark = Number(r.fark) || 0;

    return '<label data-denetim-satir="' + id + '" class="flex flex-wrap items-center gap-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 p-3 ' + (sec ? 'cursor-pointer' : 'opacity-80') + '">' +
      (sec
        ? '<input type="checkbox" data-denetim-sec="' + id + '" ' + (durumD.secili[id] ? 'checked ' : '') + 'class="w-6 h-6 accent-emerald-600 shrink-0" />'
        : '<span class="w-6 shrink-0"></span>') +
      '<span class="font-black">#' + k(r.numara || id) + '</span>' +
      '<span class="text-sm font-bold text-slate-500 dark:text-slate-400">' + k(r.tarih || '') + (r.musteri ? ' · ' + k(r.musteri) : '') + '</span>' +
      '<span class="px-2 py-0.5 rounded-lg text-xs font-black ' + tanim.sinif + '" data-denetim-sonuc="' + k(r.sonuc) + '">' + k(tanim.etiket) + '</span>' +
      (r.kunye_eksik ? '<span class="px-2 py-0.5 rounded-lg text-xs font-black bg-slate-100 dark:bg-slate-700">ödeme tipi künyesi eksik</span>' : '') +
      (degisim ? '<span class="w-full text-sm font-bold">' + degisim + '</span>' : '') +
      ('duzeltilecek' === r.sonuc || 'cift_bayi' === r.sonuc || 'duzeltildi' === r.sonuc
        ? '<span class="w-full text-sm font-bold">Toplam: ' + k(p(r.toplam_eski)) + ' → <b>' + k(p(r.toplam_yeni)) + '</b>' +
            ' <span class="' + (fark < 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300') + '">(' + (fark > 0 ? '+' : '') + k(p(fark)) + ')</span></span>'
        : '') +
      (r.sebep ? '<span class="w-full text-sm text-slate-500 dark:text-slate-400">' + k(SEBEP[r.sebep] || r.sebep) + '</span>' : '') +
    '</label>';
  }

  function listeyiCiz() {
    var kap = $('#iskontoDenetimListe');
    if (!kap) return;

    kap.innerHTML = durumD.satirlar.length
      ? durumD.satirlar.map(satirHtml).join('')
      : '';

    dugmeyiTazele();
  }

  function seciliKimlikler() {
    return Object.keys(durumD.secili).filter(function (id) { return durumD.secili[id]; }).map(Number);
  }

  function dugmeyiTazele() {
    var d = $('#iskontoDuzelt');
    if (!d) return;

    var n = seciliKimlikler().length;

    d.disabled = durumD.calisiyor || 0 === n;
    d.textContent = n ? 'Seçilenleri Düzelt (' + n + ')' : 'Seçilenleri Düzelt';
  }

  function ozetYaz(metin, tip) {
    var kutu = $('#iskontoDenetimOzet');
    if (!kutu) return;

    kutu.textContent = metin || '';
    kutu.className = 'mt-3 text-base font-bold ' +
      ('hata' === tip ? 'text-red-700 dark:text-red-300'
        : 'basari' === tip ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-slate-600 dark:text-slate-300');
  }

  function sonucuOku(cevap) {
    if (!cevap || !cevap.ok) {
      var kod = String((cevap && cevap.kod) || '');
      var yok = 'rest_no_route' === kod || 404 === Number(cevap && cevap.durum);

      return {
        hata: yok
          ? 'Sitenizdeki B2B Core eklentisi bu denetimi desteklemiyor (2.28.0 ve üstü gerekir).'
          : 'Denetim yapılamadı: ' + ((cevap && cevap.hata) || 'Bilinmeyen hata.')
      };
    }

    return cevap.veri || {};
  }

  /** KURU denetim — bütün sayfalar. Hiçbir şey yazılmaz. */
  async function denetle() {
    if (durumD.calisiyor) return;

    if (ayarlar().demoModu) {
      ozetYaz('Demo Modunda denetim yapılmaz — canlı bağlantıda sitenizdeki siparişler taranır.');
      return;
    }

    if (!(window.durum && window.durum.b2bVar)) {
      ozetYaz('Bu araç için sitenizde "B2B Core" eklentisi kurulu ve etkin olmalıdır.', 'hata');
      return;
    }

    durumD.calisiyor = true;
    durumD.satirlar = [];
    durumD.secili = {};
    listeyiCiz();

    var dugme = $('#iskontoDenetle');
    if (dugme) dugme.disabled = true;

    var toplamTaranan = 0;
    var sayac = {};
    var farkToplami = 0;

    try {
      for (var sayfa = 1; sayfa <= EN_COK_SAYFA; sayfa++) {
        ozetYaz('Taranıyor… ' + toplamTaranan + ' sipariş');

        var veri = sonucuOku(await window.b2b('maintenance/fee-audit', {
          sorgu: { sayfa: sayfa, sayfa_boyutu: SAYFA_BOYUTU },
          sureAsimi: 60000
        }));

        if (veri.hata) {
          ozetYaz(veri.hata, 'hata');
          return;
        }

        toplamTaranan += Number(veri.taranan) || 0;
        farkToplami += Number(veri.fark_toplami) || 0;

        Object.keys(veri.sayac || {}).forEach(function (a) { sayac[a] = (sayac[a] || 0) + (Number(veri.sayac[a]) || 0); });

        (Array.isArray(veri.satirlar) ? veri.satirlar : []).forEach(function (r) {
          durumD.satirlar.push(r);

          if ((SONUC[r.sonuc] || {}).varsayilan) durumD.secili[Number(r.id)] = true;
        });

        listeyiCiz();

        if (!(Number(veri.taranan) > 0) || sayfa >= (Number(veri.sayfa_sayisi) || 0)) break;
      }

      durumD.ozet = { taranan: toplamTaranan, sayac: sayac, fark: Math.round(farkToplami * 100) / 100 };

      /* Düzeltme bekleyen = tutarı yanlış olanlar + bayi iskontosu iki kez düşenler. */
      var bekleyen = (sayac.duzeltilecek || 0) + (sayac.cift_bayi || 0);

      ozetYaz(
        toplamTaranan + ' sipariş tarandı · düzeltilecek ' + (sayac.duzeltilecek || 0) +
        ((sayac.cift_bayi || 0) ? ' · çift bayi iskontosu ' + sayac.cift_bayi : '') +
        ' · elle bakılmalı ' + (sayac.belirsiz || 0) +
        ' · iade nedeniyle atlanan ' + (sayac.atlandi || 0) +
        ((sayac.kunye_eksik || 0) ? ' · künyesi eksik ' + sayac.kunye_eksik : '') +
        ((sayac.hata || 0) ? ' · okunamayan ' + sayac.hata : '') +
        (bekleyen ? ' · toplam fark ' + p(durumD.ozet.fark) : '') +
        '. Hiçbir sipariş değiştirilmedi.',
        bekleyen ? '' : 'basari'
      );
    } finally {
      durumD.calisiyor = false;
      if (dugme) dugme.disabled = false;
      dugmeyiTazele();
    }
  }

  /** Seçilenleri düzeltir — onaylı, 100'lük paketlerle. */
  async function duzelt() {
    var kimlikler = seciliKimlikler();

    if (!kimlikler.length || durumD.calisiyor) return;

    var secilenler = durumD.satirlar.filter(function (r) { return durumD.secili[Number(r.id)]; });
    var fark = secilenler.reduce(function (t, r) { return t + (Number(r.fark) || 0); }, 0);
    var cift = secilenler.filter(function (r) { return 'cift_bayi' === r.sonuc; }).length;

    var onay = ('function' === typeof window.onayla)
      ? await window.onayla(
          'Geçmiş Siparişler Düzeltilecek',
          kimlikler.length + ' siparişin iskonto satırları GÜNCEL kalemlerden yeniden hesaplanacak.\n' +
          (cift ? cift + ' siparişte iki kez düşen bayi iskontosu satırı kaldırılacak (oran satır fiyatlarında kalır).\n' : '') +
          '\n' +
          'Toplam tutar farkı: ' + p(Math.round(fark * 100) / 100) + '\n\n' +
          'Her siparişe not ve revize geçmişi kaydı düşülür. İadeli siparişlere dokunulmaz.\n' +
          'Devam edilsin mi?',
          'EVET, DÜZELT',
          false
        )
      : false;

    if (!onay) return;

    durumD.calisiyor = true;
    dugmeyiTazele();

    var duzeltilen = 0;
    var hatali = 0;

    try {
      for (var i = 0; i < kimlikler.length; i += 100) {
        var paket = kimlikler.slice(i, i + 100);
        var veri = sonucuOku(await window.b2b('maintenance/fee-audit', {
          metod: 'POST',
          govde: { siparisler: paket },
          sureAsimi: 120000
        }));

        if (veri.hata) {
          ozetYaz(veri.hata, 'hata');
          hatali += paket.length;
          continue;
        }

        (Array.isArray(veri.satirlar) ? veri.satirlar : []).forEach(function (r) {
          var sira = durumD.satirlar.map(function (x) { return Number(x.id); }).indexOf(Number(r.id));

          if (sira !== -1) durumD.satirlar[sira] = r;
          if ('duzeltildi' === r.sonuc || r.yapildi) duzeltilen++;
          if ('hata' === r.sonuc) hatali++;

          durumD.secili[Number(r.id)] = false;
        });
      }
    } finally {
      durumD.calisiyor = false;
      listeyiCiz();
    }

    ozetYaz(duzeltilen + ' sipariş düzeltildi' + (hatali ? ' · ' + hatali + ' sipariş düzeltilemedi (ayrıntı: WooCommerce › Durum › Günlükler, b2b-ucret-onarim)' : '') + '.',
            hatali ? 'hata' : 'basari');

    bildir(duzeltilen + ' geçmiş siparişin iskontosu güncel kalemlere göre düzeltildi.', hatali ? 'uyari' : 'basari');
  }

  var bagli = false;

  function bagla() {
    if (bagli) return;

    var denetleBtn = $('#iskontoDenetle');
    var duzeltBtn = $('#iskontoDuzelt');
    var liste = $('#iskontoDenetimListe');

    if (!denetleBtn || !duzeltBtn || !liste) return;

    bagli = true;

    denetleBtn.addEventListener('click', function () { denetle(); });
    duzeltBtn.addEventListener('click', function () { duzelt(); });

    liste.addEventListener('change', function (o) {
      var kutu = o.target && o.target.closest ? o.target.closest('[data-denetim-sec]') : null;
      if (!kutu) return;

      durumD.secili[Number(kutu.getAttribute('data-denetim-sec'))] = !!kutu.checked;
      dugmeyiTazele();
    });
  }

  if ('loading' === document.readyState) document.addEventListener('DOMContentLoaded', bagla);
  else bagla();

  window.IskontoDenetimi = {
    durum: durumD,
    denetle: denetle,
    duzelt: duzelt,
    satirHtml: satirHtml,
    bagla: bagla
  };
})();
