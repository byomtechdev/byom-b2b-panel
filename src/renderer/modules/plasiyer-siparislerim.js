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
  /** "TR35" → "İzmir". Çözülemeyen değer olduğu gibi kalır. */
  function ilAdi(ham) {
    var s = String(ham || '').trim();

    if (!s) return '';

    var V = window.HaritaVeri;

    if (V && 'function' === typeof V.ilBul) {
      var il = null;

      try { il = V.ilBul(s); } catch (e) { il = null; }

      if (il && il.ad) return String(il.ad);
    }

    return s;
  }

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
      musteriId: Number(bayi.id || s.customer_id || 0) || 0,
      telefon: String(bayi.phone || fatura.phone || ''),
      yetkili: String(bayi.contact_name || [fatura.first_name, fatura.last_name].filter(Boolean).join(' ') || ''),
      /* WooCommerce ili "TR35" gibi bir KOD olarak saklar; fişte ve
         WhatsApp metninde koda değil ADA ihtiyaç var. */
      il: ilAdi(bayi.il || bayi.city || fatura.state || fatura.city || ''),
      vergiNo: String(bayi.tax_number || ''),
      plasiyerAd: String(s.plasiyer_ad || ''),
      toplam: Number(s.total || 0),
      araToplam: Number(s.subtotal || 0) || 0,
      odemeIskonto: Number(s.odeme_iskonto || (s.pricing && s.pricing.odeme_iskonto) || 0) || 0,
      odeme: String(s.payment_method_title || s.payment_title || s.odeme_tipi || ''),
      /*
       * KDV KÜNYESİ (2.18.3) — BELGEDE dökülür, panelde HESAPLANMAZ.
       * Oran ürün başına sunucudan gelir (`_byom_kdv_rate` → `vat_rate`);
       * panel kendi oran listesini tutmaz. "KDV istemiyorum" seçilen siparişte
       * sunucu satırları netleştirir (`_b2b_vat_excluded` / `_b2b_vat_removed`)
       * ve fiş bunu AÇIKÇA yazar — panel ikinci kez KDV düşmez.
       */
      kdvIstenmedi: !!(true === s.vat_excluded || 'yes' === s.vat_excluded),
      kdvDusulen: Number(s.vat_removed || 0) || 0,
      kdvToplam: Number(s.vat_total || s.total_tax || 0) || 0,
      /*
       * ÜCRET SATIRLARI (eklenti 2.18.1): plasiyer iskontosu ve ödeme
       * yöntemi iskontosu satır fiyatına değil NEGATİF ÜCRET SATIRINA
       * yazılır (Registry §0 madde 1). Fiş motoru tutarı buradan okur;
       * alan gelmezse "Ara toplam" ile "NET" arasındaki fark fişte
       * açıklamasız kalıyordu.
       */
      ucretler: (Array.isArray(s.fee_lines) ? s.fee_lines : []).map(function (u) {
        return { ad: String((u && u.name) || ''), tutar: Number((u && u.total) || 0) || 0 };
      }),
      iskonto: Number(s.plasiyer_iskonto || 0) || 0,
      /* ÜÇ ŞEKİL (Faz 11 — Görsel 6 "0 çeşit / 0 adet"): sunucu 2.17.0
         `kalemler` verir; eski eklenti `line_items` (ince yük) ya da
         prepare_order'ın `items`ı. Panel ve eklenti ayrı yayınlanır — üçü de
         okunur ki hangisi eski kalırsa kalsın döküm boş görünmesin. */
      kalemler: (s.kalemler || s.line_items || s.items || []).map(function (k) {
        var adet = Number(k.quantity || k.adet || 0);
        var tutar = Number(k.total || k.tutar || k.satir_toplami || 0);
        var birim = Number(k.birim_fiyat || k.unit_price || 0) || (adet > 0 ? tutar / adet : 0);

        return {
          urunId: Number(k.product_id || 0) || 0,
          ad: String(k.name || k.ad || ''),
          adet: adet,
          koliIci: Number(k.koli_ici_adet || k.box_quantity || 0) || 0,
          koli: Number(k.koli || k.boxes || 0) || 0,
          birim: birim,
          tutar: tutar,
          /* Satır KDV'si SUNUCUDAN gelir (prepare_order / kalem_dokumu iki
             dilde birden verir); panel oran × tutar çarpmaz. */
          kdvOrani: Number(k.vat_rate || k.kdvOrani || k.kdv_orani || 0) || 0,
          kdvTutar: Number(k.vat_amount || k.kdvTutar || k.kdv_tutari || 0) || 0
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

  /* ------------------------------------------------------------------ *
   *  ÇIKTI KANALLARI (Faz 12): fiş / yazdır, WhatsApp, tekrar sipariş
   * ------------------------------------------------------------------ */

  function F() {
    return window.SiparisFisi || null;
  }

  /** Oturumdaki plasiyer künyesi + firma logosu (fiş başlığı). */
  function fisBaglami() {
    var o = oturum() || {};
    var a = (window.durum && window.durum.ayarlar) || {};

    return {
      firmaAdi: String(a.firmaAdi || (window.durum && window.durum.lisans && window.durum.lisans.firmaAdi) || ''),
      logo: String(a.yerelLogo || a.siteLogosu || ''),
      plasiyerAd: String(o.ad || ''),
      plasiyerId: Number(o.id) || 0,
      kagit: 'a4'
    };
  }

  function siparisBul(id) {
    return durumS.siparisler.find(function (x) { return String(x.id) === String(id); }) || null;
  }

  /** [📄 Fiş / Yazdır] — kurumsal sipariş fişi ayrı pencerede (fis:onizleme). */
  async function fisAc(id, kagit) {
    var sip = siparisBul(id);

    if (!sip) return;

    if (!F()) { bildir('Fiş motoru yüklenemedi (siparis-fisi.js).', 'hata'); return; }

    var baglam = fisBaglami();
    baglam.kagit = 'termal' === kagit ? 'termal' : 'a4';

    var fis = F().normalle(sip, baglam);
    var cevap;

    try {
      /* pencere(): belge + araç çubuğu (Yazdır · PDF · WhatsApp · Kapat) —
         yönetici fişiyle AYNI pencere (Faz 14). */
      cevap = await ipcRenderer.invoke('fis:onizleme', { html: F().pencere(fis, { kagit: baglam.kagit }), baslik: 'Sipariş Fişi #' + fis.numara });
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Fiş penceresi açılamadı.' };
    }

    if (!cevap || !cevap.ok) bildir((cevap && cevap.hata) || 'Fiş penceresi açılamadı.', 'hata');
  }

  /** [📲 WhatsApp] — müşterinin telefonu normalize edilir, formatlı özet wa.me ile açılır. */
  function whatsappAc(id) {
    var sip = siparisBul(id);

    if (!sip || !F()) return;

    var fis = F().normalle(sip, fisBaglami());
    var adres = F().waAdresi(fis);

    if (!adres) { bildir('Bu siparişte müşteri telefonu yok; WhatsApp fişi gönderilemez.', 'uyari'); return; }

    window.open(adres);
  }

  /**
   * [🔁 Tekrar Sipariş] — bu siparişin kalemleri BUGÜNÜN fiyatıyla sepete
   * doldurulur (motor: sonSiparisiKopyala; geçmiş fiyat asla kopyalanmaz),
   * müşteri seçilir ve Katalog & Satış açılır.
   */
  async function tekrarSiparis(id) {
    var sip = siparisBul(id);
    var M = window.PlasiyerSiparisMotor;
    var Vt = window.PlasiyerVitrin;
    var Mu = window.PlasiyerMusteri;

    if (!sip || !M || !Vt) return;

    var sepet = Vt.sepetAl ? Vt.sepetAl() : null;

    if (!sepet) return;

    /*
     * Müşteri PORTFÖYDEN alınır (Faz 12-B). Sipariş yükünden kurulan sentetik
     * nesnede `odemeIskontolari` ve `acikBakiye` yoktur; sepet ödeme yöntemi
     * iskontosunu 0 sayıyor, sunucu ise siparişi yazarken matristen okuyup
     * uyguluyordu — plasiyer ekranda gördüğünden farklı bir fiyat kaydediyordu.
     */
    if (Mu && sip.musteriId && 'function' === typeof Mu.musteriSec) {
      var kayit = ('function' === typeof Mu.musteriBul && Mu.musteriBul(sip.musteriId)) ||
        { id: sip.musteriId, unvan: sip.musteri, iskonto: sip.iskonto, telefon: sip.telefon || '' };

      Mu.musteriSec(kayit, { sessiz: true });
    }

    /* Katalog ekranda süzülü ya da hiç yüklenmemiş olabilir; kimlikler yerel
       indeksten çözülür (ağa çıkmaz). */
    var idler = sip.kalemler.map(function (k) { return k.urunId; });
    var harita = ('function' === typeof Vt.urunleriCoz) ? await Vt.urunleriCoz(idler) : {};

    var sonuc = M.sonSiparisiKopyala({ kalemler: sip.kalemler.map(function (k) { return { product_id: k.urunId, quantity: k.adet, name: k.ad }; }) },
      function (pid) { return harita[pid] || (Vt.urunBul ? Vt.urunBul(pid) : null); }, sepet);

    if (Vt.sepetiCiz) Vt.sepetiCiz();

    var mesaj = sonuc.eklenen + ' kalem bugünün fiyatıyla sepete eklendi.';

    if (sonuc.atlanan && sonuc.atlanan.length) {
      mesaj += ' ' + sonuc.atlanan.length + ' kalem katalogda bulunamadı: ' + sonuc.atlanan.map(function (a) { return a.ad; }).join(', ');
    }

    bildir(mesaj, sonuc.atlanan && sonuc.atlanan.length ? 'uyari' : 'ok');

    if ('function' === typeof window.sekmeAc) window.sekmeAc('satis');
  }

  /* ------------------------------------------------------------------ *
   *  AKILLI SÜZGEÇ (Faz 12): arama + durum çipleri — yerel, ağa çıkmaz
   * ------------------------------------------------------------------ */

  var DURUM_CIPLERI = [
    { kod: '', ad: 'Tümü' },
    { kod: 'acik', ad: 'Açık', durumlar: ['pending', 'on-hold', 'processing', 'order-ready', 'b2b-received', 'b2b-preparing', 'b2b-ready'] },
    { kod: 'yolda', ad: 'Yolda', durumlar: ['shipped', 'b2b-shipped'] },
    { kod: 'tamam', ad: 'Tamamlandı', durumlar: ['completed', 'delivered'] },
    { kod: 'iptal', ad: 'İptal / İade', durumlar: ['cancelled', 'refunded', 'failed'] }
  ];

  function suz(liste) {
    var q = String(durumS.arama || '').toLocaleLowerCase('tr-TR').trim();
    var cip = DURUM_CIPLERI.find(function (c) { return c.kod === durumS.suzgec; });

    return liste.filter(function (x) {
      if (cip && cip.durumlar && cip.durumlar.indexOf(String(x.durum).replace(/^wc-/, '')) === -1) return false;

      if (!q) return true;

      var metin = [x.numara, x.musteri, x.odeme, x.durumEtiketi].concat(x.kalemler.map(function (k) { return k.ad; })).join(' ').toLocaleLowerCase('tr-TR');

      return metin.indexOf(q) !== -1;
    });
  }

  function suzgecBari(toplam, gorunen) {
    return '<div class="siparislerim-suzgec flex items-center gap-2 flex-wrap mb-4">' +
      '<input type="search" id="siparislerimAra" value="' + kacis(durumS.arama || '') + '" placeholder="Sipariş no, müşteri, ürün…" ' +
             'class="flex-1 min-w-48 h-11 px-4 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-semibold" aria-label="Siparişlerde ara" />' +
      '<div class="flex rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-600" role="group" aria-label="Durum">' +
        DURUM_CIPLERI.map(function (c) {
          var aktif = c.kod === durumS.suzgec;
          return '<button type="button" class="siparislerim-cip px-3 py-2 text-sm font-bold transition ' +
            (aktif ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'hover:bg-slate-100 dark:hover:bg-slate-700') +
            '" data-suzgec="' + c.kod + '" aria-pressed="' + (aktif ? 'true' : 'false') + '">' + c.ad + '</button>';
        }).join('') +
      '</div>' +
      (gorunen !== toplam ? '<span class="text-sm font-bold text-slate-500">' + gorunen + ' / ' + toplam + '</span>' : '') +
    '</div>';
  }

  /* ------------------------------------------------------------------ *
   *  İPTAL / SİL (Faz 14) — plasiyerin KENDİ siparişi üzerindeki kararlar
   *
   *  İki kapı: arayüz düğmeyi yalnızca uygun durumda gösterir (hız), sunucu
   *  aynı kuralı yeniden uygular (güvenlik: 403 başkasının siparişi, 409
   *  durum uygun değil). Kimlik ve jeton ANA SÜREÇ belleğinden gider.
   * ------------------------------------------------------------------ */

  /** Kargoya çıkmamış sipariş iptal edilebilir (sunucu: get_revisable_statuses). */
  var IPTAL_EDILEBILIR = ['pending', 'on-hold', 'processing', 'order-ready', 'b2b-received', 'b2b-preparing', 'b2b-ready'];

  function durumKodu(s) {
    return String((s && s.durum) || '').replace(/^wc-/, '');
  }

  function iptalEdilebilirMi(s) {
    return IPTAL_EDILEBILIR.indexOf(durumKodu(s)) !== -1;
  }

  /** Yalnızca iptal edilmiş (ya da başarısız) sipariş silinebilir — iki adım bilinçli. */
  function silinebilirMi(s) {
    return ['cancelled', 'failed'].indexOf(durumKodu(s)) !== -1;
  }

  /** Onay penceresi: yönetici kabuğundaki `onayla` her kabukta vardır (#modalKatman ortak). */
  async function onaylat(baslik, mesaj, dugme, tehlikeli) {
    if ('function' === typeof window.onayla) return window.onayla(baslik, mesaj, dugme, tehlikeli);

    return window.confirm(baslik + '\n\n' + mesaj);
  }

  async function siparisIptal(id) {
    var sip = siparisBul(id);

    if (!sip) return;

    if (!iptalEdilebilirMi(sip)) {
      bildir('Bu sipariş iptal edilemez (kargoya verilmiş ya da tamamlanmış).', 'uyari');
      return;
    }

    var eminMi = await onaylat(
      'Siparişi İptal Et',
      '#' + sip.numara + '  ·  ' + sip.musteri + '  ·  ' + paraYaz(sip.tutar) + '\n\n' +
      'Sipariş "İptal Edildi" durumuna alınacak. Bu işlem müşteriye e-posta göndermez.\n' +
      'İptal ettikten sonra siparişi tamamen silebilirsiniz.',
      'EVET, İPTAL ET',
      true
    );

    if (!eminMi) return;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('plasiyer:siparis-iptal', { siparisId: sip.id, sebep: 'Saha satış panelinden iptal edildi.' });
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Ağ hatası.' };
    }

    /* apiIstek yanıtı { ok, veri } sarar; ana süreç doğrudan geçirir. */
    var veri = (cevap && cevap.veri) || cevap || {};

    if (!cevap || !cevap.ok || false === veri.ok) {
      bildir('Sipariş iptal edilemedi:\n' + ((cevap && cevap.hata) || (veri && veri.message) || 'Bilinmeyen hata.'), 'hata');
      return;
    }

    /* Yerel kart anında güncellenir; sunucu yanıtındaki sipariş varsa o kazanır. */
    if (veri.order && 'object' === typeof veri.order) {
      var yeni = normalle(veri.order);
      var yer = durumS.siparisler.indexOf(sip);
      if (yer !== -1) durumS.siparisler[yer] = yeni;
    } else {
      sip.durum = 'cancelled';
      sip.durumEtiketi = 'İptal Edildi';
    }

    durumS.acik[id] = true;
    ciz();
    bildir('#' + sip.numara + ' iptal edildi.' + (veri.tekrar ? ' (Zaten iptal edilmişti.)' : ''), 'ok');
  }

  async function siparisSil(id) {
    var sip = siparisBul(id);

    if (!sip) return;

    if (!silinebilirMi(sip)) {
      bildir('Yalnızca iptal edilmiş siparişler silinebilir. Önce siparişi iptal edin.', 'uyari');
      return;
    }

    var eminMi = await onaylat(
      'Siparişi Sil',
      '#' + sip.numara + '  ·  ' + sip.musteri + '  ·  ' + paraYaz(sip.tutar) + '\n\n' +
      'Sipariş sunucudan KALICI olarak silinecek; bu işlem geri alınamaz.\n' +
      'Müşteri web sitesinden verdiyse Siparişlerim ekranında "silindi" notu görür.',
      'EVET, KALICI SİL',
      true
    );

    if (!eminMi) return;

    var cevap;

    try {
      cevap = await ipcRenderer.invoke('plasiyer:siparis-sil', { siparisId: sip.id });
    } catch (e) {
      cevap = { ok: false, hata: (e && e.message) || 'Ağ hatası.' };
    }

    var veri = (cevap && cevap.veri) || cevap || {};

    if (!cevap || !cevap.ok || false === veri.ok) {
      bildir('Sipariş silinemedi:\n' + ((cevap && cevap.hata) || (veri && veri.message) || 'Bilinmeyen hata.'), 'hata');
      return;
    }

    durumS.siparisler = durumS.siparisler.filter(function (x) { return String(x.id) !== String(id); });
    delete durumS.acik[id];
    ciz();
    bildir('#' + sip.numara + ' kalıcı olarak silindi.', 'ok');
  }

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
                  /* "24 adet" bitişik kalır (test kilidi); koli parantez içinde. */
                  '<td class="py-2 pr-3 text-right font-bold whitespace-nowrap">' + k.adet + ' adet' +
                    (k.koli > 0 && k.koliIci > 1 ? ' <span class="text-xs text-slate-500">(' + k.koli + ' koli × ' + k.koliIci + ')</span>' : '') + '</td>' +
                  /* KDV sütunu YALNIZCA künye geldiğinde: "%0" yazmak
                     "KDV'siz aldım" diye YANLIŞ okunur (bkz. siparis-fisi.js). */
                  '<td class="py-2 pr-3 text-right text-slate-500 whitespace-nowrap">' +
                    (k.kdvOrani > 0 || k.kdvTutar > 0
                      ? 'KDV %' + kacis(String(Math.round(k.kdvOrani * 100) / 100).replace('.', ',')) +
                        (k.kdvTutar > 0 ? ' <span class="text-xs">· ' + kacis(paraYaz(k.kdvTutar)) + '</span>' : '')
                      : '') + '</td>' +
                  '<td class="py-2 pr-3 text-right text-slate-500 whitespace-nowrap">' + kacis(paraYaz(k.birim)) + '</td>' +
                  '<td class="py-2 text-right font-black whitespace-nowrap">' + kacis(paraYaz(k.tutar)) + '</td>' +
                '</tr>';
              }).join('') +
              '</tbody></table>' +
              /* KDV'siz sipariş kartta da AÇIKÇA söylenir; plasiyer müşteriye
                 "KDV'siz yazmıştım" diyebilmeli, fişi açmaya gerek kalmasın. */
              (s.kdvIstenmedi
                ? '<div class="mt-2 text-sm font-bold text-amber-700 dark:text-amber-400">🚫 KDV uygulanmadı' +
                  (s.kdvDusulen > 0 ? ' — düşülen KDV: ' + kacis(paraYaz(s.kdvDusulen)) : '') + '</div>'
                : '')
            : '<div class="text-sm text-slate-500">Kalem dökümü yok.</div>') +
          (s.notlar ? '<div class="mt-3 text-sm rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3"><b>Not:</b> ' + kacis(s.notlar) + '</div>' : '') +
          /* ÇIKTI KANALLARI (Faz 12) — detay açılınca: kurumsal fiş, WhatsApp özeti,
             tekrar sipariş. Kartın dışında TEK birincil düğme durur (saha ekranı
             sade kalır); depo eylemleri (revize/iptal/durum) burada da YOKTUR. */
          '<div class="siparis-kanallar mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 flex gap-2 flex-wrap">' +
            '<button type="button" class="sk-fis px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + s.id + '" data-kagit="a4" title="Yazdır · PDF olarak kaydet · WhatsApp\'tan gönder">📄 Profesyonel Fiş / Yazdır / PDF</button>' +
            '<button type="button" class="sk-fis px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-id="' + s.id + '" data-kagit="termal" title="80 mm termal yazıcı">🧾 Termal</button>' +
            '<button type="button" class="sk-wa px-3 py-2 rounded-lg bg-emerald-600 text-white font-bold text-sm hover:bg-emerald-700" data-id="' + s.id + '">📲 WhatsApp Sipariş Fişi</button>' +
            '<button type="button" class="sk-tekrar px-3 py-2 rounded-lg bg-marka-700 text-white font-bold text-sm hover:bg-marka-600" data-id="' + s.id + '" title="Kalemleri bugünün fiyatıyla sepete doldur">🔁 Tekrar Sipariş</button>' +
            /* İPTAL / SİL (Faz 14): depo eylemi DEĞİL, plasiyerin kendi siparişi
               üzerindeki iki kararı. Detayın içinde (kartın dışında yine TEK
               birincil düğme). İptal yalnızca kargoya çıkmamış siparişte, silme
               yalnızca iptal edilmiş siparişte görünür — sunucu da aynı kuralı
               uygular (409); düğme yalnızca yol gösterir. */
            (iptalEdilebilirMi(s)
              ? '<button type="button" class="sk-iptal px-3 py-2 rounded-lg border-2 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 font-bold text-sm hover:bg-red-100 dark:hover:bg-red-500/20" data-id="' + s.id + '" title="Siparişi iptal et (durum: İptal Edildi)">🚫 Siparişi İptal Et</button>'
              : '') +
            (silinebilirMi(s)
              ? '<button type="button" class="sk-sil px-3 py-2 rounded-lg bg-red-700 text-white font-bold text-sm hover:bg-red-800" data-id="' + s.id + '" title="İptal edilmiş siparişi sunucudan kalıcı olarak sil">🗑️ Siparişi Sil</button>'
              : '') +
          '</div>' +
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

    var gorunen = suz(durumS.siparisler);

    kap.innerHTML = suzgecBari(durumS.siparisler.length, gorunen.length) +
      (gorunen.length
        ? gorunen.map(kartHtml).join('')
        : '<div class="py-10 text-center bg-white dark:bg-slate-800 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-600">' +
            '<div class="text-3xl mb-2" aria-hidden="true">🔍</div>' +
            '<div class="font-bold">Bu arama / süzgeçle eşleşen sipariş yok</div>' +
            '<p class="mt-1 text-sm text-slate-500">Arama kutusunu temizleyin ya da "Tümü"nü seçin.</p>' +
          '</div>');

    var ara = el('siparislerimAra');

    if (ara) {
      ara.addEventListener('input', function () {
        durumS.arama = ara.value;
        var imlec = ara.selectionStart;
        ciz();
        var yeni = el('siparislerimAra');
        if (yeni) { yeni.focus(); try { yeni.setSelectionRange(imlec, imlec); } catch (e) { /* sayı alanı */ } }
      });
    }

    kap.querySelectorAll('.siparislerim-cip').forEach(function (b) {
      b.addEventListener('click', function () {
        durumS.suzgec = String(b.dataset.suzgec || '');
        ciz();
      });
    });
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

    /* Çıktı kanalları (Faz 12) — tek delegasyon. */
    var liste = el('siparislerimListe');
    if (liste) {
      liste.addEventListener('click', function (olay) {
        var fis = olay.target.closest('.sk-fis');
        if (fis) { fisAc(fis.dataset.id, fis.dataset.kagit); return; }

        var wa = olay.target.closest('.sk-wa');
        if (wa) { whatsappAc(wa.dataset.id); return; }

        var tekrar = olay.target.closest('.sk-tekrar');
        if (tekrar) { tekrarSiparis(tekrar.dataset.id); return; }

        /* İptal / sil (Faz 14) */
        var iptal = olay.target.closest('.sk-iptal');
        if (iptal) { siparisIptal(iptal.dataset.id); return; }

        var sil = olay.target.closest('.sk-sil');
        if (sil) { siparisSil(sil.dataset.id); }
      });
    }

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

  durumS.arama = '';
  durumS.suzgec = '';

  window.PlasiyerSiparislerim = {
    yenile: yenile,
    sekmeyiAc: sekmeyiAc,
    ciz: ciz,
    normalle: normalle,
    suz: suz,
    fisAc: fisAc,
    whatsappAc: whatsappAc,
    tekrarSiparis: tekrarSiparis,
    /* Faz 14 */
    siparisIptal: siparisIptal,
    siparisSil: siparisSil,
    iptalEdilebilirMi: iptalEdilebilirMi,
    silinebilirMi: silinebilirMi,
    DURUM_CIPLERI: DURUM_CIPLERI,
    durum: durumS
  };
})();
