/* ============================================================================
 *  REVİZE GEÇMİŞİ ÇİZİCİSİ — DOM'suz, çift modlu (Faz 19)
 *  ---------------------------------------------------------------------------
 *  Kaynak: GET /wc-b2b/v1/orders/{id}/revision-history
 *          (b2b-core › B2B_Revizyon_Gecmisi::listele)
 *
 *  Her kayıt: { id, zaman, kullanici_ad, kaynak, not, once, sonra, fark }
 *  `fark` SUNUCUDA hesaplanır (eklenen / silinen / degisen / ucretler /
 *  alanlar); panel ikinci bir fark motoru TUTMAZ — iki kopya bir gün ayrışır.
 *
 *  GÖRSEL DİL (diff geleneği): ÖNCE sütununda değişen değer KIRMIZI ve üstü
 *  çizili, SONRA sütununda yeni değer YEŞİL. Eklenen ürün yalnızca sağda
 *  (yeşil), silinen yalnızca solda (kırmızı). Değişmeyen satırlar soluk.
 *
 *  Tüm metin kaçışlanır (sunucudan gelen ürün adı / not).
 * ==========================================================================*/

(function (kok) {
  'use strict';

  var KAYNAK_ETIKETI = {
    panel: 'Masaüstü Panel',
    'wp-admin': 'WordPress Yönetim',
    'wc-rest': 'WooCommerce API',
    onarim: 'Geçmiş Sipariş Onarımı',
    sistem: 'Sistem'
  };

  var ALAN_ETIKETI = {
    kdv_haric: 'KDV',
    bayi_orani: 'Bayi iskonto oranı',
    odeme_tipi: 'Ödeme tipi',
    odeme_orani: 'Ödeme iskonto oranı',
    ara_toplam: 'Kalemler toplamı',
    toplam: 'Genel toplam',
    durum: 'Durum'
  };

  function kacis(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (k) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k];
    });
  }

  function sayi(n) {
    var x = Number(n);
    return isFinite(x) ? x : 0;
  }

  /** 1234.5 → "1.234,50 ₺" (Türkçe biçim, motor bağımsız). */
  function para(n) {
    var x = Math.round(sayi(n) * 100) / 100;
    var isaret = x < 0 ? '−' : '';
    var parca = Math.abs(x).toFixed(2).split('.');

    return isaret + parca[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + parca[1] + ' ₺';
  }

  function adetYaz(n) {
    var x = sayi(n);
    return (Math.abs(x - Math.round(x)) < 0.0001 ? String(Math.round(x)) : String(x).replace('.', ',')) + ' adet';
  }

  function yuzde(n) {
    var x = Math.round(sayi(n) * 100) / 100;
    return '%' + String(x).replace('.', ',');
  }

  function tarih(z) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(z || ''));
    return m ? (m[3] + '.' + m[2] + '.' + m[1] + ' ' + m[4] + ':' + m[5]) : String(z || '');
  }

  function alanDegeri(alan, v) {
    if ('kdv_haric' === alan) return v ? 'Hariç' : 'Dâhil';
    if ('ara_toplam' === alan || 'toplam' === alan) return para(v);
    if ('bayi_orani' === alan || 'odeme_orani' === alan) return yuzde(v);
    return (null === v || undefined === v || '' === v) ? '—' : String(v);
  }

  /** Eski (kırmızı, üstü çizili) / yeni (yeşil) hücre içerikleri. */
  function eski(m) {
    return '<span class="rg-eski text-red-700 dark:text-red-300 line-through decoration-2">' + m + '</span>';
  }

  function yeni(m) {
    return '<span class="rg-yeni text-emerald-700 dark:text-emerald-300 font-black">' + m + '</span>';
  }

  /**
   * Kalem satırları — ÖNCE / SONRA yan yana.
   *
   * @param {object} k Kayıt.
   * @returns {string}
   */
  function kalemTablosu(k) {
    var once = (k.once && Array.isArray(k.once.kalemler)) ? k.once.kalemler : [];
    var sonra = (k.sonra && Array.isArray(k.sonra.kalemler)) ? k.sonra.kalemler : [];
    var f = k.fark || {};

    var degisen = {};
    (f.degisen || []).forEach(function (d) { degisen[String(d.id)] = d; });

    var sonraIndeks = {};
    sonra.forEach(function (x) { sonraIndeks[String(x.id)] = x; });

    var satirlar = [];

    /* Önceki sıradaki kalemler: değişen / silinen / aynı. */
    once.forEach(function (e) {
      var id = String(e.id);
      var y = sonraIndeks[id];
      var d = degisen[id];

      if (!y) {
        satirlar.push(
          '<tr class="rg-silinen bg-red-50 dark:bg-red-500/10" data-rg-durum="silinen">' +
            '<td class="p-2">' + eski(kacis(e.ad)) + ' <span class="text-xs font-black text-red-700 dark:text-red-300">SİLİNDİ</span></td>' +
            '<td class="p-2 text-right">' + eski(kacis(adetYaz(e.adet))) + '</td>' +
            '<td class="p-2 text-right">' + eski(kacis(para(e.tutar))) + '</td>' +
            '<td class="p-2 border-l-2 border-slate-200 dark:border-slate-700 text-slate-400" colspan="3">—</td>' +
          '</tr>'
        );
        return;
      }

      if (d) {
        var adetFark = Math.abs(sayi(d.eski.adet) - sayi(y.adet)) > 0.0001;
        var birimFark = Math.abs(sayi(d.eski.birim) - sayi(y.birim)) > 0.0001;
        var tutarFark = Math.abs(sayi(d.eski.tutar) - sayi(y.tutar)) >= 0.005;

        satirlar.push(
          '<tr class="rg-degisen bg-amber-50 dark:bg-amber-500/10" data-rg-durum="degisen">' +
            '<td class="p-2 font-bold">' + kacis(y.ad || e.ad) +
              (birimFark ? '<div class="text-xs">Birim: ' + eski(kacis(para(d.eski.birim))) + ' → ' + yeni(kacis(para(y.birim))) + '</div>' : '') +
            '</td>' +
            '<td class="p-2 text-right">' + (adetFark ? eski(kacis(adetYaz(d.eski.adet))) : kacis(adetYaz(d.eski.adet))) + '</td>' +
            '<td class="p-2 text-right">' + (tutarFark ? eski(kacis(para(d.eski.tutar))) : kacis(para(d.eski.tutar))) + '</td>' +
            '<td class="p-2 border-l-2 border-slate-200 dark:border-slate-700 font-bold">' + kacis(y.ad || e.ad) + '</td>' +
            '<td class="p-2 text-right">' + (adetFark ? yeni(kacis(adetYaz(y.adet))) : kacis(adetYaz(y.adet))) + '</td>' +
            '<td class="p-2 text-right">' + (tutarFark ? yeni(kacis(para(y.tutar))) : kacis(para(y.tutar))) + '</td>' +
          '</tr>'
        );
        return;
      }

      satirlar.push(
        '<tr class="rg-ayni text-slate-500 dark:text-slate-400" data-rg-durum="ayni">' +
          '<td class="p-2">' + kacis(e.ad) + '</td>' +
          '<td class="p-2 text-right">' + kacis(adetYaz(e.adet)) + '</td>' +
          '<td class="p-2 text-right">' + kacis(para(e.tutar)) + '</td>' +
          '<td class="p-2 border-l-2 border-slate-200 dark:border-slate-700">' + kacis(y.ad) + '</td>' +
          '<td class="p-2 text-right">' + kacis(adetYaz(y.adet)) + '</td>' +
          '<td class="p-2 text-right">' + kacis(para(y.tutar)) + '</td>' +
        '</tr>'
      );
    });

    /* Eklenen kalemler — yalnızca SONRA sütununda. */
    (f.eklenen || []).forEach(function (y) {
      satirlar.push(
        '<tr class="rg-eklenen bg-emerald-50 dark:bg-emerald-500/10" data-rg-durum="eklenen">' +
          '<td class="p-2 text-slate-400" colspan="3">—</td>' +
          '<td class="p-2 border-l-2 border-slate-200 dark:border-slate-700">' + yeni(kacis(y.ad)) + ' <span class="text-xs font-black text-emerald-700 dark:text-emerald-300">EKLENDİ</span></td>' +
          '<td class="p-2 text-right">' + yeni(kacis(adetYaz(y.adet))) + '</td>' +
          '<td class="p-2 text-right">' + yeni(kacis(para(y.tutar))) + '</td>' +
        '</tr>'
      );
    });

    return '<table class="w-full text-sm">' +
      '<thead><tr class="text-left text-xs font-black text-slate-500 dark:text-slate-400">' +
        '<th class="p-2">ÖNCE · Ürün</th><th class="p-2 text-right">Adet</th><th class="p-2 text-right">Tutar</th>' +
        '<th class="p-2 border-l-2 border-slate-200 dark:border-slate-700">SONRA · Ürün</th><th class="p-2 text-right">Adet</th><th class="p-2 text-right">Tutar</th>' +
      '</tr></thead>' +
      '<tbody>' + satirlar.join('') + '</tbody>' +
    '</table>';
  }

  /** İskonto satırları + sipariş alanları (KDV, ödeme, toplam). */
  function ozetTablosu(k) {
    var f = k.fark || {};
    var satirlar = [];

    (f.ucretler || []).forEach(function (u) {
      var ad = kacis(u.ad || ('dealer' === u.tur ? 'Bayi İskontosu' : 'Ödeme Yöntemi İskontosu'));

      satirlar.push(
        '<tr data-rg-ucret="' + kacis(u.durum || '') + '">' +
          '<td class="p-2 font-bold">' + ad + '</td>' +
          '<td class="p-2 text-right">' + ('eklendi' === u.durum ? '—' : eski(kacis(para(u.eski)))) + '</td>' +
          '<td class="p-2 text-right border-l-2 border-slate-200 dark:border-slate-700">' + ('silindi' === u.durum ? eski('kaldırıldı') : yeni(kacis(para(u.yeni)))) + '</td>' +
        '</tr>'
      );
    });

    var alanlar = f.alanlar || {};

    Object.keys(ALAN_ETIKETI).forEach(function (alan) {
      if (!Object.prototype.hasOwnProperty.call(alanlar, alan)) return;

      var cift = alanlar[alan] || [];
      var a = alanDegeri(alan, cift[0]);
      var b = alanDegeri(alan, cift[1]);
      var fark = '';

      if ('toplam' === alan || 'ara_toplam' === alan) {
        var d = Math.round((sayi(cift[1]) - sayi(cift[0])) * 100) / 100;
        fark = ' <span class="text-xs font-black ' + (d < 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300') + '">(' + (d > 0 ? '+' : '') + kacis(para(d)) + ')</span>';
      }

      satirlar.push(
        '<tr data-rg-alan="' + kacis(alan) + '">' +
          '<td class="p-2 font-bold">' + kacis(ALAN_ETIKETI[alan]) + '</td>' +
          '<td class="p-2 text-right">' + eski(kacis(a)) + '</td>' +
          '<td class="p-2 text-right border-l-2 border-slate-200 dark:border-slate-700">' + yeni(kacis(b)) + fark + '</td>' +
        '</tr>'
      );
    });

    if (!satirlar.length) return '';

    return '<table class="w-full text-sm mt-3">' +
      '<thead><tr class="text-left text-xs font-black text-slate-500 dark:text-slate-400">' +
        '<th class="p-2">Sipariş</th><th class="p-2 text-right">Önce</th><th class="p-2 text-right border-l-2 border-slate-200 dark:border-slate-700">Sonra</th>' +
      '</tr></thead>' +
      '<tbody>' + satirlar.join('') + '</tbody>' +
    '</table>';
  }

  /**
   * Tek kaydın kartı.
   *
   * @param {object} k Kayıt.
   * @returns {string}
   */
  function kayitHtml(k) {
    if (!k || 'object' !== typeof k) return '';

    var kaynak = KAYNAK_ETIKETI[k.kaynak] || String(k.kaynak || 'Sistem');

    return '<article class="rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4" data-rg-kayit="' + kacis(k.id || '') + '">' +
      '<header class="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">' +
        '<span class="text-lg font-black">' + kacis(tarih(k.zaman)) + '</span>' +
        '<span class="px-2 py-0.5 rounded-lg text-xs font-black bg-slate-100 dark:bg-slate-700" data-rg-kaynak>' + kacis(kaynak) + '</span>' +
        (k.kullanici_ad ? '<span class="text-sm font-bold text-slate-600 dark:text-slate-300">' + kacis(k.kullanici_ad) + '</span>' : '') +
        (k.not ? '<span class="w-full text-sm text-slate-500 dark:text-slate-400 whitespace-pre-line" data-rg-not>' + kacis(k.not) + '</span>' : '') +
      '</header>' +
      '<div class="overflow-x-auto">' + kalemTablosu(k) + ozetTablosu(k) + '</div>' +
    '</article>';
  }

  /**
   * Bütün geçmiş — EN YENİ ÜSTTE.
   *
   * @param {Array} kayitlar Sunucu listesi (eskiden yeniye).
   * @returns {string}
   */
  function html(kayitlar) {
    var liste = Array.isArray(kayitlar) ? kayitlar.slice() : [];

    if (!liste.length) {
      return '<div class="py-10 text-center text-lg font-bold text-slate-500 dark:text-slate-400" data-rg-bos>' +
             'Bu siparişte henüz revize kaydı yok.</div>';
    }

    liste.reverse();

    return '<div class="flex flex-col gap-4">' + liste.map(kayitHtml).join('') + '</div>';
  }

  var RevizyonGecmisi = {
    html: html,
    kayitHtml: kayitHtml,
    para: para,
    KAYNAK_ETIKETI: KAYNAK_ETIKETI
  };

  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = RevizyonGecmisi;
  }

  if (typeof window !== 'undefined') {
    window.RevizyonGecmisi = RevizyonGecmisi;
  }
})(typeof window !== 'undefined' ? window : this);
