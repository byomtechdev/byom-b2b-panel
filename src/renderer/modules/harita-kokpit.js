/* ============================================================================
 *  TÜRKİYE HARİTA KOKPİTİ — YÖNETİCİ + SAHA (iki kabuk, tek motor)
 *  src/renderer/modules/harita-kokpit.js
 *  ---------------------------------------------------------------------------
 *  İnternet/Google Maps GEREKTİRMEYEN, harici bağımlılığı SIFIR yerel SVG
 *  harita. 81 il; hover vurgusu, ipucu kartı, bölünmüş ekran (split view),
 *  yakınlaştırma, çözülmemiş ziyaret notu uyarısı, gün/tarih filtresi.
 *
 *  FAZ 12 — FABRİKA: `olustur(ayar)` aynı çizim motorundan iki bağımsız
 *  örnek üretir. Durum ÖRNEĞE aittir (modül seviyesinde paylaşılmaz):
 *
 *    · window.HaritaKokpit  — YÖNETİCİ: /admin/harita (81 il, bütün şirket),
 *      iller sorumlu plasiyerin RENGİNE boyanır, lejant şeridi, zengin bayi
 *      kartları (arama / WhatsApp köprüsü, açık bakiye risk rozeti).
 *    · window.SahaHarita    — PLASİYER: plasiyer:harita IPC (yalnızca KENDİ
 *      sorumlu illeri + KENDİ bayileri), bayi kartından tek tıkla sipariş /
 *      ziyaret notu, "bu ay ziyaret edildi / ziyaret bekliyor" rozetleri.
 *
 *  Neden iki ayrı dosya değil: hover, ipucu, zoom, gerçek sınırlar, tarih
 *  süzgeci ve not paneli bire bir aynı. Kopyalamak, bir düzeltmenin diğer
 *  kabukta unutulması demekti (bu depoda "iki depo, tek bilgi" hata sınıfı).
 *
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │ GEOMETRİ                                                             │
 *  │ Gerçek il sınırları src/renderer/harita-yollar.js (Natural Earth,    │
 *  │ kamu malı) ile beslenir (yollariBesle). Dosya yoksa her il gerçeğe   │
 *  │ yakın konumunda kutu olarak çizilir (kartogram) — `il.yol` varsa     │
 *  │ <path>, yoksa <rect>.                                                │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 *  GPU: yalnızca `transform` ve `opacity` animasyonlanır; bölünmüş ekranda
 *  il `viewBox` DEĞİŞTİRİLMEDEN `transform: scale/translate` ile büyür.
 *
 *  Veri TEK istekten gelir: 81 il için ayrı istek atmak haritayı
 *  kullanılamaz yapardı. Yeniden çizim (ölçüt, lejant vurgusu) ağa ÇIKMAZ.
 * ==========================================================================*/

'use strict';

(function () {

  /** İl kutusunun yarı genişliği/yüksekliği (şematik mod). */
  var KUTU = { w: 22, h: 13 };

  /**
   * PLASİYER RENK PALETİ — PHP `B2B_Plasiyer::PALET` ikizi. Anahtar sunucuda
   * saklanır (meta), hex burada ve sunucuda aynı; ikisi ayrışırsa harita ile
   * pazarlamacı formu farklı renk gösterir → test iki listeyi karşılaştırır.
   */
  var PALET = {
    mor: '#7c3aed', safir: '#2563eb', zumrut: '#059669', amber: '#d97706', gul: '#e11d48',
    turkuaz: '#0891b2', indigo: '#4f46e5', kiremit: '#c2410c', zeytin: '#4d7c0f', fuchsia: '#c026d3'
  };

  var PALET_ADLARI = {
    mor: 'Mor', safir: 'Safir Mavi', zumrut: 'Zümrüt', amber: 'Amber', gul: 'Gül',
    turkuaz: 'Turkuaz', indigo: 'İndigo', kiremit: 'Kiremit', zeytin: 'Zeytin', fuchsia: 'Fuşya'
  };

  function V() {
    return window.HaritaVeri;
  }

  /**
   * GERÇEK İL SINIRLARI (Faz 10): src/renderer/harita-yollar.js yüklüyse il
   * kütüğüne beslenir — kokpit <rect> yerine <path> basar. İdempotent.
   */
  function yollariBesle() {
    var Y = window.HaritaYollar;

    if (!Y || !V() || 'function' !== typeof V().yollariYukle) return 0;
    if (V().yolluIlSayisi() > 0) return V().yolluIlSayisi();

    return V().yollariYukle(Y.YOLLAR, Y.MERKEZLER, Y.SINIRLAR);
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

  /** Harita etiketi için kısa para: 12.400 → "12,4K", 1.250.000 → "1,25M". */
  function kisaPara(n) {
    var s = Number(n) || 0;

    if (s >= 1000000) return (Math.round(s / 100000) / 10).toString().replace('.', ',') + 'M';
    if (s >= 1000) return (Math.round(s / 100) / 10).toString().replace('.', ',') + 'K';

    return String(Math.round(s));
  }

  /** '#7c3aed' + 0.5 → 'rgba(124,58,237,0.5)'. Bozuk hex → marka lacivert. */
  function hexRgba(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));

    if (!m) return 'rgba(29,78,216,' + a.toFixed(3) + ')';

    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a.toFixed(3) + ')';
  }

  function renkHex(anahtar, yedek) {
    return PALET[String(anahtar || '')] || yedek || '';
  }

  /* ====================================================================
   *  FABRİKA
   * ==================================================================== */

  function olustur(ayar) {
    ayar = ayar || {};

    var KIP = 'plasiyer' === ayar.kip ? 'plasiyer' : 'admin';
    var ADMIN = 'admin' === KIP;
    var KAP_ID = ayar.kapId || (ADMIN ? 'haritaKab' : 'sahaHaritaKab');
    var ONEK = ayar.onek || (ADMIN ? 'harita' : 'sahaHarita');

    /** Örneğe özel kimlik: yönetici 'haritaSvg', saha 'sahaHaritaSvg'. */
    function kimlik(ad) {
      return ONEK + ad;
    }

    var durumH = {
      kip: KIP,
      iller: [],
      tanimsiz: [],
      enCokCiro: 0,
      toplam: null,
      notlar: [],
      gun: 0,              // 0 = tümü, 1 = günlük, 7 = haftalık
      tarih: '',           // 'YYYY-MM-DD' — doluysa gun yok sayılır (Faz 11; iki süzgeç üst üste sessizce boş verirdi)
      olcut: 'ciro',       // ciro | siparis | bayi
      secili: null,        // bölünmüş ekranda açık il
      yukleniyor: false,
      hata: '',
      /* Faz 12 — sorumlu il / renk katmanı */
      plasiyerler: [],     // yönetici: [{ id, ad, renk, renkHex, iller[] }]
      plasiyerRenk: {},    // id → { ad, renk, renkHex, iller }
      vurgu: 0,            // lejantta tıklanan plasiyer (0 = hepsi)
      sorumlu: {},         // saha: plaka → true
      renkHex: '',         // saha: kendi rengi
      palet: PALET
    };

    var bagli = false;

    function kap() {
      return el(KAP_ID);
    }

    /* ------------------------------------------------------------------ *
     *  VERİ
     * ------------------------------------------------------------------ */

    async function hamVeri() {
      if (ADMIN) {
        /* Boş tarih main.js apiIstek süzgecinde düşer → eski istek birebir korunur. */
        return b2b('/admin/harita', { sorgu: { gun: durumH.gun, tarih: durumH.tarih } });
      }

      /* Saha: kimlik + jeton ana süreç belleğinden; arayüz kim olduğunu söyleyemez. */
      try {
        return await ipcRenderer.invoke('plasiyer:harita', { gun: durumH.gun, tarih: durumH.tarih });
      } catch (e) {
        return { ok: false, hata: (e && e.message) || 'Ağ hatası.' };
      }
    }

    async function veriyiGetir() {
      durumH.yukleniyor = true;
      durumH.hata = '';

      ciz();

      var cevap = await hamVeri();

      durumH.yukleniyor = false;

      if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
        durumH.hata = (cevap && cevap.hata) || 'Harita verisi alınamadı.';

        var k = kap();

        if (k) {
          k.innerHTML = '<div class="py-16 text-center text-red-600 dark:text-red-400 font-semibold">' +
            kacis(durumH.hata) + '</div>';
        }

        return;
      }

      var veri = cevap.veri;
      var sonuc = V().haritayiKur(veri);

      durumH.iller = sonuc.iller;
      durumH.tanimsiz = sonuc.tanimsiz;
      durumH.enCokCiro = sonuc.enCokCiro;
      durumH.toplam = sonuc.toplam;

      plasiyerKatmaniniKur(veri);

      await notlariGetir();

      ciz();
      rozetiTazele();
    }

    /**
     * Sorumlu il / renk katmanı (Faz 12).
     *  yönetici: veri.plasiyerler[] → renk sözlüğü; il.plasiyer (haritayiKur taşır)
     *  saha    : veri.sorumluIller[] + veri.renkHex → il.sorumlu
     */
    function plasiyerKatmaniniKur(veri) {
      durumH.plasiyerler = Array.isArray(veri.plasiyerler) ? veri.plasiyerler : [];
      durumH.plasiyerRenk = {};

      durumH.plasiyerler.forEach(function (p) {
        var id = Number(p && p.id) || 0;

        if (!id) return;

        durumH.plasiyerRenk[id] = {
          id: id,
          ad: String(p.ad || ('#' + id)),
          renk: String(p.renk || ''),
          renkHex: String(p.renkHex || renkHex(p.renk) || ''),
          iller: Array.isArray(p.iller) ? p.iller.map(Number) : []
        };
      });

      /* Yönetici: il.plasiyer sunucudan gelmemişse plasiyer listesinden türet. */
      if (ADMIN) {
        var ilSahibi = {};

        durumH.plasiyerler.forEach(function (p) {
          (Array.isArray(p.iller) ? p.iller : []).forEach(function (plaka) {
            if (!ilSahibi[Number(plaka)]) ilSahibi[Number(plaka)] = Number(p.id) || 0;
          });
        });

        durumH.iller.forEach(function (il) {
          if (!il.plasiyer && ilSahibi[il.plaka]) il.plasiyer = ilSahibi[il.plaka];
        });
      }

      durumH.sorumlu = {};
      (Array.isArray(veri.sorumluIller) ? veri.sorumluIller : []).forEach(function (plaka) {
        durumH.sorumlu[Number(plaka)] = true;
      });

      durumH.renkHex = String(veri.renkHex || renkHex(veri.renk) || '');

      durumH.iller.forEach(function (il) {
        il.sorumlu = !!durumH.sorumlu[il.plaka];
      });
    }

    async function notlariGetir() {
      if (ADMIN) {
        var cevap = await b2b('/admin/ziyaret', { sorgu: { gun: durumH.gun, tarih: durumH.tarih } });

        durumH.notlar = (cevap && cevap.ok && cevap.veri && cevap.veri.notlar) || [];
        return;
      }

      /* Saha: notlar "Saha Notlarım" belleğinden okunur (plasiyer-ziyaret.js),
         ikinci bir istek atılmaz. AMA o bellek yalnızca Müşterilerim/Notlarım
         sekmesi açılınca dolar: PIN'den sonra doğrudan Saha Haritam'a giden
         plasiyer, haritada kırmızı ünlemi görüp panelde "Bu ilde not yok"
         yazısıyla karşılaşıyordu. Bellek boşsa bir kez doldurulur. */
      var Z = window.PlasiyerZiyaret;
      var bellek = (Z && Z.durum && Array.isArray(Z.durum.notlar)) ? Z.durum.notlar : null;

      if (Z && !(bellek && bellek.length) && 'function' === typeof Z.notlariGetir) {
        try { await Z.notlariGetir(); } catch (e) { /* sessiz: harita yine çizilir */ }

        bellek = (Z.durum && Array.isArray(Z.durum.notlar)) ? Z.durum.notlar : null;
      }

      durumH.notlar = bellek || [];
    }

    /** Sol menüdeki "Pazarlamacılar" rozetini tazeler (yalnızca yönetici). */
    function rozetiTazele() {
      if (!ADMIN) return;

      var sayi = V().cozulmemisSayisi(durumH.notlar);

      if (window.PlasiyerYonetimi && 'function' === typeof window.PlasiyerYonetimi.haritaRozetiYaz) {
        window.PlasiyerYonetimi.haritaRozetiYaz(sayi);
      }

      var dugme = document.querySelector('[data-sekme="plasiyerler"]');

      if (!dugme) return;

      var rozet = el('plasiyerNotRozeti');

      if (!sayi) {
        if (rozet) rozet.remove();
        return;
      }

      if (!rozet) {
        rozet = document.createElement('span');
        rozet.id = 'plasiyerNotRozeti';
        rozet.className = 'absolute top-3 right-3 min-w-8 h-8 px-2 rounded-full bg-red-600 text-white ' +
                          'text-base font-black grid place-items-center shadow-lg';

        dugme.classList.add('relative');
        dugme.appendChild(rozet);
      }

      rozet.textContent = String(sayi);
      rozet.title = sayi + ' okunmamış/çözülmemiş ziyaret notu';
    }

    /* ------------------------------------------------------------------ *
     *  ÇİZİM — ÜST BAR + LEJANT
     * ------------------------------------------------------------------ */

    function ustBar() {
      var t = durumH.toplam || { bayi: 0, siparis: 0, ciro: 0, cozulmemis: 0 };

      var gunSecenek = [
        { d: 1, ad: 'Bugün' },
        { d: 7, ad: 'Bu hafta' },
        { d: 30, ad: 'Bu ay' },
        { d: 0, ad: 'Tümü' }
      ];

      var olcutSecenek = [
        { o: 'ciro', ad: 'Ciro' },
        { o: 'siparis', ad: 'Sipariş' },
        { o: 'bayi', ad: 'Bayi' }
      ];

      var sorumluSayisi = Object.keys(durumH.sorumlu).length;

      return '' +
        '<div class="flex items-center gap-3 flex-wrap mb-4">' +
          '<div class="flex rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-600">' +
            gunSecenek.map(function (g) {
              return '<button type="button" class="harita-gun px-4 py-2.5 font-bold transition ' +
                (!durumH.tarih && durumH.gun === g.d ? 'bg-marka-700 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-700') +
                '" data-gun="' + g.d + '">' + g.ad + '</button>';
            }).join('') +
          '</div>' +

          /* Belirli gün (Faz 11): HTML5 tarih seçici. Bağlama 'change' ile —
             'input' olsaydı yeniden çizimde value ataması istek üretebilirdi. */
          '<label class="flex items-center gap-2 font-bold" title="Belirli bir günün sipariş, ciro ve notlarını göster">' +
            '<span class="text-sm text-slate-500">Gün</span>' +
            '<input type="date" id="' + kimlik('Tarih') + '" value="' + kacis(durumH.tarih) + '" ' +
                   'class="px-3 py-2 rounded-xl border-2 ' + (durumH.tarih ? 'border-marka-700' : 'border-slate-200 dark:border-slate-600') +
                   ' bg-white dark:bg-slate-900 font-bold" />' +
            (durumH.tarih
              ? '<button type="button" id="' + kimlik('TarihSil') + '" class="px-2 py-2 rounded-lg font-black hover:bg-slate-100 dark:hover:bg-slate-700" title="Tarihi temizle">✕</button>'
              : '') +
          '</label>' +

          '<div class="flex rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-600">' +
            olcutSecenek.map(function (o) {
              return '<button type="button" class="harita-olcut px-4 py-2.5 font-bold transition ' +
                (durumH.olcut === o.o ? 'bg-slate-700 text-white dark:bg-slate-600' : 'hover:bg-slate-100 dark:hover:bg-slate-700') +
                '" data-olcut="' + o.o + '">' + o.ad + '</button>';
            }).join('') +
          '</div>' +

          '<div class="ml-auto flex items-center gap-4 text-sm font-bold">' +
            (ADMIN ? '' : '<span class="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-700" title="Sorumlu olduğunuz iller">' + sorumluSayisi + ' sorumlu il</span>') +
            '<span>' + t.bayi + ' bayi</span>' +
            '<span>' + t.siparis + ' sipariş</span>' +
            '<span>' + kacis(paraYaz(t.ciro)) + '</span>' +
            (ADMIN
              ? (t.cozulmemis
                  ? '<span class="px-3 py-1.5 rounded-xl bg-red-600 text-white">' + t.cozulmemis + ' açık not</span>'
                  : '<span class="px-3 py-1.5 rounded-xl bg-emerald-600 text-white">Açık not yok</span>')
              : '') +
          '</div>' +

          '<button type="button" id="' + kimlik('Yenile') + '" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition" title="Yenile">⟳</button>' +
        '</div>' +
        lejant();
    }

    /**
     * LEJANT ŞERİDİ (Faz 12).
     *  yönetici: [● Ahmet (Mor) · 4 il] [● Mehmet (Safir Mavi) · 6 il] — tıklanınca
     *            o plasiyerin illeri vurgulanır (yeniden çizim, ağa çıkmaz).
     *  saha    : kendi rengi + ziyaret rozeti açıklaması.
     */
    function lejant() {
      if (ADMIN) {
        var liste = durumH.plasiyerler.filter(function (p) { return p && (p.renk || (p.iller && p.iller.length)); });

        if (!liste.length) {
          return '<div class="harita-lejant mb-3 px-4 py-3 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 text-sm text-slate-600 dark:text-slate-300">' +
            '🎨 Henüz hiçbir pazarlamacıya <b>il ve renk</b> atanmamış. ' +
            '<b>Pazarlamacılar → Düzenle</b> ile renk seçip sorumlu illeri işaretleyin; harita o renklere boyanır.' +
          '</div>';
        }

        return '<div class="harita-lejant flex items-center gap-2 flex-wrap mb-3" role="group" aria-label="Plasiyer lejantı">' +
          '<button type="button" class="lejant-plasiyer px-3 py-1.5 rounded-xl border-2 text-sm font-bold transition ' +
            (durumH.vurgu ? 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700' : 'border-slate-800 dark:border-slate-200') +
            '" data-plasiyer="0" aria-pressed="' + (durumH.vurgu ? 'false' : 'true') + '">Tümü</button>' +
          liste.map(function (p) {
            var hex = String(p.renkHex || renkHex(p.renk) || '#64748b');
            var aktif = Number(durumH.vurgu) === Number(p.id);
            var ilSayisi = Array.isArray(p.iller) ? p.iller.length : 0;

            return '<button type="button" class="lejant-plasiyer inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 text-sm font-bold transition ' +
              (aktif ? 'border-slate-800 dark:border-slate-200 bg-slate-100 dark:bg-slate-700' : 'border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700') +
              '" data-plasiyer="' + Number(p.id) + '" aria-pressed="' + (aktif ? 'true' : 'false') + '" title="' + kacis(p.ad) + ' — sorumlu illeri vurgula">' +
              '<span class="inline-block w-3.5 h-3.5 rounded-full ring-2 ring-white dark:ring-slate-800" style="background:' + kacis(hex) + '"></span>' +
              kacis(p.ad) + ' <span class="opacity-60">(' + kacis(PALET_ADLARI[p.renk] || p.renk || '—') + ')</span>' +
              '<span class="opacity-70">· ' + ilSayisi + ' il</span>' +
            '</button>';
          }).join('') +
        '</div>';
      }

      /* Saha lejantı: rozetlerin anlamı. */
      return '<div class="harita-lejant flex items-center gap-3 flex-wrap mb-3 text-xs font-bold text-slate-600 dark:text-slate-300">' +
        '<span class="inline-flex items-center gap-1.5"><span class="inline-block w-3.5 h-3.5 rounded ring-2 ring-white dark:ring-slate-800" style="background:' + kacis(durumH.renkHex || '#1d4ed8') + '"></span> Sorumlu illerim</span>' +
        '<span class="inline-flex items-center gap-1.5"><span class="inline-block w-3.5 h-3.5 rounded bg-slate-300 dark:bg-slate-600"></span> Diğer iller</span>' +
        '<span class="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">✓ Bu ay ziyaret edildi</span>' +
        '<span class="px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">⏳ Ziyaret bekliyor</span>' +
      '</div>';
    }

    /* ------------------------------------------------------------------ *
     *  ÇİZİM — SVG HARİTA
     * ------------------------------------------------------------------ */

    /** İl saha kabuğunda etkileşimli mi? Sorumlu il ya da bayisi olan il. */
    function ilEtkin(il) {
      if (ADMIN) return true;

      return !!(il.sorumlu || il.bayiSayisi > 0);
    }

    /**
     * İlin dolgu rengi.
     *  yönetici: sorumlu plasiyer varsa ONUN rengi (yoğunlukla koyulaşır; lejant
     *            vurgusu diğerlerini soluklaştırır), yoksa marka laciverti.
     *  saha    : sorumlu il → kendi rengi; diğer iller soluk gri.
     */
    function dolgu(il) {
      var ton = V().yogunluk(il, olcutTavani(), durumH.olcut);

      if (!ADMIN) {
        if (!ilEtkin(il)) return 'rgba(148,163,184,0.10)';

        return hexRgba(durumH.renkHex || '#1d4ed8', 0.35 + ton * 0.55);
      }

      var p = il.plasiyer ? durumH.plasiyerRenk[il.plasiyer] : null;

      if (p && p.renkHex) {
        if (durumH.vurgu && Number(durumH.vurgu) !== Number(il.plasiyer)) return 'rgba(148,163,184,0.12)';

        return hexRgba(p.renkHex, 0.38 + ton * 0.52);
      }

      if (durumH.vurgu) return 'rgba(148,163,184,0.10)';
      if (ton <= 0) return 'rgba(148,163,184,0.18)';   // slate-400 @ düşük

      /* Marka rengi yerine sabit bir lacivert: tema değişkeni SVG içinde
         güvenilir okunmuyor, harita iki temada da aynı okunmalı. */
      return 'rgba(29,78,216,' + (0.18 + ton * 0.72).toFixed(3) + ')';
    }

    function olcutTavani() {
      if ('siparis' === durumH.olcut) {
        return durumH.iller.reduce(function (m, il) { return Math.max(m, il.siparis); }, 0);
      }

      if ('bayi' === durumH.olcut) {
        return durumH.iller.reduce(function (m, il) { return Math.max(m, il.bayiSayisi); }, 0);
      }

      return durumH.enCokCiro;
    }

    /** Metin etiket rengi: koyu dolguda beyaz. */
    function etiketRengi(il) {
      var ton = V().yogunluk(il, olcutTavani(), durumH.olcut);
      var renkli = ADMIN ? !!(il.plasiyer && durumH.plasiyerRenk[il.plasiyer]) : !!(il.sorumlu && ilEtkin(il));

      return (ton > 0.55 || (renkli && ton > 0.2)) ? '#fff' : 'rgba(51,65,85,0.85)';
    }

    /**
     * Tek ilin SVG parçası. `yol` varsa gerçek sınır, yoksa şematik kutu.
     *
     * İSİM KÜNYESİ (Faz 12): geniş ve "dolu" illerde (bayisi, sorumlusu ya da
     * cirosu olan) plaka yerine "İzmir (35)" + "3 bayi · 12,4K" yazılır. Dar
     * illerde plaka kalır — 81 ilin adını birden yazmak haritayı okunmaz
     * yapardı; ipucu kartı zaten tam künyeyi taşır.
     */
    function ilSvg(il) {
      var etkin = ilEtkin(il);
      var ortak = 'class="harita-il' + (etkin ? '' : ' harita-il-pasif') + '" data-plaka="' + il.plaka + '" ' +
                  'fill="' + dolgu(il) + '" stroke="rgba(100,116,139,0.55)" stroke-width="1" ' +
                  (etkin ? 'tabindex="0" role="button" ' : '') +
                  'aria-label="' + kacis(il.ad) + '"';

      var sekil = il.yol
        ? '<path ' + ortak + ' d="' + kacis(il.yol) + '"></path>'
        : '<rect ' + ortak + ' x="' + (il.x - KUTU.w / 2) + '" y="' + (il.y - KUTU.h / 2) +
          '" width="' + KUTU.w + '" height="' + KUTU.h + '" rx="3"></rect>';

      var renk = etiketRengi(il);
      var dolu = il.bayiSayisi > 0 || il.ciro > 0 || (ADMIN ? !!il.plasiyer : !!il.sorumlu);
      var genis = !!(il.sinir && il.sinir.w >= 48 && il.sinir.h >= 22);
      var etiket;

      if (dolu && genis) {
        etiket =
          '<text class="harita-etiket harita-etiket-ad" x="' + il.x + '" y="' + (il.y - 1) +
            '" text-anchor="middle" font-size="6.5" font-weight="800" fill="' + renk + '" pointer-events="none">' +
            kacis(il.ad) + ' (' + il.plaka + ')</text>' +
          '<text class="harita-etiket harita-etiket-ozet" x="' + il.x + '" y="' + (il.y + 6.5) +
            '" text-anchor="middle" font-size="5.5" font-weight="700" fill="' + renk + '" pointer-events="none">' +
            il.bayiSayisi + ' bayi' + (il.ciro > 0 ? ' · ' + kisaPara(il.ciro) : '') + '</text>';
      } else {
        /* Plaka numarası — küçük ama harita okunurluğunu çok artırıyor. */
        etiket = '<text class="harita-etiket" x="' + il.x + '" y="' + (il.y + 3.5) +
          '" text-anchor="middle" font-size="8" font-weight="700" fill="' + renk + '" pointer-events="none">' + il.plaka + '</text>';
      }

      /* Çözülmemiş not uyarısı: ilin TAM MERKEZİNDE yanıp sönen kırmızı ünlem. */
      var uyari = il.uyari
        ? '<g class="harita-uyari" pointer-events="none">' +
            '<circle cx="' + il.x + '" cy="' + (il.y - KUTU.h / 2 - 5) + '" r="5.5" fill="#dc2626"></circle>' +
            '<text x="' + il.x + '" y="' + (il.y - KUTU.h / 2 - 2.2) + '" text-anchor="middle" ' +
                  'font-size="8" font-weight="900" fill="#fff">!</text>' +
          '</g>'
        : '';

      return '<g class="harita-il-grup">' + sekil + etiket + uyari + '</g>';
    }

    function haritaSvg() {
      var tuval = V().TUVAL;

      return '' +
        '<svg id="' + kimlik('Svg') + '" viewBox="0 0 ' + tuval.w + ' ' + tuval.h + '" ' +
             'class="w-full h-auto select-none" role="img" aria-label="' + (ADMIN ? 'Türkiye bayi haritası' : 'Saha haritam') + '">' +
          '<g id="' + kimlik('Katman') + '">' +
            durumH.iller.map(ilSvg).join('') +
          '</g>' +
        '</svg>';
    }

    /* ------------------------------------------------------------------ *
     *  ÇİZİM — ANA KAP
     * ------------------------------------------------------------------ */

    /** Saha boş durumu: ne sorumlu il ne bayi — yol gösteren metin. */
    function sahaBosDurumu() {
      var t = durumH.toplam || { bayi: 0 };

      if (ADMIN || Object.keys(durumH.sorumlu).length || t.bayi > 0) return '';

      return '<div class="mb-4 p-5 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800">' +
        '<div class="text-3xl mb-2" aria-hidden="true">🗺️</div>' +
        '<div class="text-lg font-extrabold">Haritanız henüz boş</div>' +
        '<p class="mt-1 text-slate-600 dark:text-slate-300">Yöneticiniz <b>Pazarlamacılar → Düzenle</b> ekranından size sorumlu iller ve bir renk atadığında iller burada boyanır. ' +
          '<b>Müşterilerim</b>\'den eklediğiniz her bayi de otomatik olarak haritaya düşer.</p>' +
      '</div>';
    }

    function ciz() {
      var k = kap();

      if (!k) return;

      if (durumH.yukleniyor && !durumH.iller.length) {
        k.innerHTML = '<div class="py-16 text-center text-slate-500">Harita yükleniyor…</div>';
        return;
      }

      if (durumH.secili) {
        bolunmusCiz();
        return;
      }

      k.innerHTML =
        ustBar() +
        sahaBosDurumu() +
        '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
          haritaSvg() +
          (V().yolluIlSayisi() === 0
            ? '<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">' +
              'Şematik görünüm: iller gerçek coğrafi konumlarında kutu olarak çizilir. ' +
              'Gerçek il sınırları <code>HaritaVeri.yollariYukle()</code> ile beslenebilir.</p>'
            : '<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">' +
              'İl sınırları: Natural Earth 1:10m (kamu malı) · ' + V().yolluIlSayisi() + ' il.</p>') +
          (durumH.tanimsiz.length
            ? '<p class="mt-3 text-xs text-amber-700 dark:text-amber-400">' +
              durumH.tanimsiz.length + ' kayıt bir ile eşlenemedi (il alanı boş ya da tanınmayan): ' +
              kacis(durumH.tanimsiz.map(function (x) { return x.ad; }).join(', ')) + '</p>'
            : '') +
        '</div>' +
        '<div id="' + kimlik('Ipucu') + '" hidden class="fixed z-[75] pointer-events-none max-w-xs ' +
             'bg-slate-900 text-white text-sm rounded-xl shadow-2xl p-3"></div>';

      baglaHarita();
    }

    /* ------------------------------------------------------------------ *
     *  İPUCU KARTI
     * ------------------------------------------------------------------ */

    function ipucuGoster(il, olay) {
      var kutu = el(kimlik('Ipucu'));

      if (!kutu) return;

      var bayiListe = (il.bayiler || []).slice(0, 6).map(function (b) {
        return '<li class="truncate">• ' + kacis(b.unvan || ('#' + b.id)) + '</li>';
      }).join('');

      var sorumlu = ADMIN && il.plasiyer && durumH.plasiyerRenk[il.plasiyer]
        ? '<div class="mt-1 text-xs flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:' + kacis(durumH.plasiyerRenk[il.plasiyer].renkHex) + '"></span>Sorumlu: <b>' + kacis(durumH.plasiyerRenk[il.plasiyer].ad) + '</b></div>'
        : (ADMIN ? '<div class="mt-1 text-xs opacity-60">Sorumlu plasiyer atanmamış</div>' : '');

      kutu.innerHTML =
        '<div class="font-extrabold text-base">' + kacis(il.ad) + ' <span class="opacity-60 font-bold">(' + il.plaka + ')</span></div>' +
        '<div class="opacity-70 text-xs">' + kacis(il.bolge) + '</div>' +
        sorumlu +
        '<div class="mt-2 grid grid-cols-3 gap-2 text-xs">' +
          '<div><div class="opacity-60">Bayi</div><div class="font-bold">' + il.bayiSayisi + '</div></div>' +
          '<div><div class="opacity-60">Sipariş</div><div class="font-bold">' + il.siparis + '</div></div>' +
          '<div><div class="opacity-60">Ciro</div><div class="font-bold">' + kacis(paraYaz(il.ciro)) + '</div></div>' +
        '</div>' +
        (bayiListe
          ? '<ul class="mt-2 text-xs space-y-0.5">' + bayiListe +
            (il.bayiSayisi > 6 ? '<li class="opacity-60">+ ' + (il.bayiSayisi - 6) + ' bayi daha</li>' : '') +
            '</ul>'
          : '<div class="mt-2 text-xs opacity-60">Kayıtlı bayi yok</div>') +
        (il.uyari
          ? '<div class="mt-2 px-2 py-1 rounded-lg bg-red-600 text-xs font-bold">! ' + il.not.cozulmemis + ' açık ziyaret notu</div>'
          : '');

      kutu.hidden = false;

      /* Konum: imlecin yanı, ekran dışına taşmayacak şekilde. */
      var g = kutu.getBoundingClientRect();
      var x = Math.min(olay.clientX + 16, window.innerWidth - g.width - 12);
      var y = Math.min(olay.clientY + 16, window.innerHeight - g.height - 12);

      kutu.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      kutu.style.left = '0';
      kutu.style.top = '0';
    }

    function ipucuGizle() {
      var kutu = el(kimlik('Ipucu'));

      if (kutu) kutu.hidden = true;
    }

    /* ------------------------------------------------------------------ *
     *  BÖLÜNMÜŞ EKRAN (SPLIT VIEW)
     * ------------------------------------------------------------------ */

    function ilSec(plaka) {
      var il = durumH.iller.find(function (x) { return Number(x.plaka) === Number(plaka); });

      if (!il || !ilEtkin(il)) return;

      durumH.secili = il;

      ipucuGizle();
      bolunmusCiz();
    }

    function geriDon() {
      durumH.secili = null;
      ciz();
    }

    function bolunmusCiz() {
      var k = kap();
      var il = durumH.secili;

      if (!k || !il) return;

      var notlar = V().notlariSuz(durumH.notlar, { il: il.ad, gun: durumH.gun, tarih: durumH.tarih });

      /* Bayi kartındaki "son ziyaret notu": müşteri → en yeni not (liste DESC
         geldiği için ilk eşleşme). Tarih süzgeci UYGULANMAZ — kart her zaman
         son notu göstermeli. */
      var sonNotlar = {};

      V().notlariSuz(durumH.notlar, { il: il.ad }).forEach(function (n) {
        var mid = Number(n && n.musteriId) || 0;

        if (mid && !sonNotlar[mid]) sonNotlar[mid] = n;
      });

      var sahip = ADMIN && il.plasiyer && durumH.plasiyerRenk[il.plasiyer]
        ? ' <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-sm font-bold" style="background:' + kacis(hexRgba(durumH.plasiyerRenk[il.plasiyer].renkHex, 0.15)) + '"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:' + kacis(durumH.plasiyerRenk[il.plasiyer].renkHex) + '"></span>' + kacis(durumH.plasiyerRenk[il.plasiyer].ad) + '</span>'
        : '';

      k.innerHTML =
        '<div class="flex items-center gap-3 mb-4 flex-wrap">' +
          '<button type="button" id="' + kimlik('Geri') + '" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
            '← Türkiye Haritasına Dön' +
          '</button>' +
          '<div class="text-2xl font-black">' + kacis(il.ad) + ' (' + il.plaka + ')' +
            ' <span class="text-base font-bold text-slate-500">' + kacis(il.bolge) + '</span>' + sahip +
          '</div>' +
        '</div>' +

        '<div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start">' +

          /* SOL: ilin büyütülmüş şekli */
          '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
            tekIlSvg(il) +
            '<div class="mt-4 grid grid-cols-3 gap-3 text-center">' +
              kutucuk('Bayi', il.bayiSayisi) +
              kutucuk('Sipariş', il.siparis) +
              kutucuk('Ciro', paraYaz(il.ciro)) +
            '</div>' +
          '</div>' +

          /* SAĞ: bayiler + notlar */
          '<div class="space-y-5">' +
            bayiPaneli(il, sonNotlar) +
            notPaneli(notlar) +
          '</div>' +
        '</div>';

      var geri = el(kimlik('Geri'));
      if (geri) geri.addEventListener('click', geriDon);

      baglaNotlar();
    }

    function kutucuk(etiket, deger) {
      return '<div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50">' +
        '<div class="text-xs text-slate-500 dark:text-slate-400">' + etiket + '</div>' +
        '<div class="font-black text-lg">' + kacis(String(deger)) + '</div>' +
      '</div>';
    }

    /** Seçili ilin dolgu rengi (zoom): sorumlu plasiyer / kendi rengi. */
    function seciliRenk(il) {
      if (ADMIN) {
        var p = il.plasiyer ? durumH.plasiyerRenk[il.plasiyer] : null;
        return p && p.renkHex ? hexRgba(p.renkHex, 0.85) : 'rgba(29,78,216,0.85)';
      }

      return hexRgba(durumH.renkHex || '#1d4ed8', 0.85);
    }

    /**
     * Seçili ilin büyütülmüş çizimi.
     *
     * ZOOM `transform` İLE: viewBox animasyonlamak her karede düzen hesabı
     * tetikler; scale+translate kompozitörde kalır ve 60 FPS korunur.
     */
    function tekIlSvg(il) {
      var tuval = V().TUVAL;
      var k = 3.2;   // yakınlaştırma katsayısı (şematik kutu)
      var mx = il.x;
      var my = il.y;

      /* Gerçek geometri: ilin sınır kutusu tuvale %72 doluluğa oturur (Faz 10). */
      if (il.sinir && il.sinir.w > 0 && il.sinir.h > 0) {
        k = Math.max(1.2, Math.min(6, 0.72 * Math.min(tuval.w / il.sinir.w, tuval.h / il.sinir.h)));
        mx = il.sinir.x + il.sinir.w / 2;
        my = il.sinir.y + il.sinir.h / 2;
      }

      /* İl merkezini tuvalin ortasına taşıyan öteleme. */
      var dx = (tuval.w / 2) - mx * k;
      var dy = (tuval.h / 2) - my * k;

      return '<svg viewBox="0 0 ' + tuval.w + ' ' + tuval.h + '" class="w-full h-auto">' +
        '<g class="harita-zoom" style="transform: translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + k + ');">' +
          /* Komşular soluk arka plan olarak kalır: il tek başına havada durmasın. */
          durumH.iller.map(function (x) {
            if (Number(x.plaka) === Number(il.plaka)) return '';

            /* Gerçek sınır varsa komşu da gerçek şekliyle (soluk) çizilir. */
            if (x.yol) {
              return '<path d="' + kacis(x.yol) + '" fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.35)" stroke-width="0.4"></path>';
            }

            return '<rect x="' + (x.x - KUTU.w / 2) + '" y="' + (x.y - KUTU.h / 2) +
              '" width="' + KUTU.w + '" height="' + KUTU.h + '" rx="3" ' +
              'fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.25)" stroke-width="0.6"></rect>';
          }).join('') +

          (il.yol
            ? '<path d="' + kacis(il.yol) + '" fill="' + seciliRenk(il) + '" stroke="#1e3a8a" stroke-width="1.2"></path>'
            : '<rect x="' + (il.x - KUTU.w / 2) + '" y="' + (il.y - KUTU.h / 2) +
              '" width="' + KUTU.w + '" height="' + KUTU.h + '" rx="3" ' +
              'fill="' + seciliRenk(il) + '" stroke="#1e3a8a" stroke-width="1.2"></rect>') +

          '<text x="' + il.x + '" y="' + (il.y + 3.5) + '" text-anchor="middle" font-size="7" font-weight="800" fill="#fff">' +
            il.plaka +
          '</text>' +
        '</g>' +
      '</svg>';
    }

    /* ------------------------------------------------------------------ *
     *  BAYİ KARTI
     * ------------------------------------------------------------------ */

    /** WhatsApp için telefon (SiparisFisi motoru varsa ondan, yoksa yerel). */
    function waTel(ham) {
      if (window.SiparisFisi && 'function' === typeof window.SiparisFisi.waTelefon) return window.SiparisFisi.waTelefon(ham);

      var r = String(ham || '').replace(/[^0-9]/g, '');

      if (r.indexOf('00') === 0) r = r.slice(2);
      if (r.length === 11 && r.charAt(0) === '0') r = r.slice(1);
      if (r.length === 10) r = '90' + r;

      return (r.length >= 11 && r.length <= 15) ? r : '';
    }

    /** Ziyaret durumu: sunucu alanı varsa o, yoksa son nottan türetilir (30 gün). */
    function ziyaretDurumu(b, not) {
      if (b.ziyaretDurumu) return 'bu_ay' === b.ziyaretDurumu ? 'bu_ay' : 'bekliyor';

      var z = b.sonZiyaret || (not && not.zaman) || '';
      var t = Date.parse(z || '');

      if (isNaN(t)) return '';

      return (Date.now() - t) <= 30 * 86400000 ? 'bu_ay' : 'bekliyor';
    }

    /**
     * ZENGİN BAYİ KARTI (Faz 11 + Faz 12): unvan, yetkili, telefon (arama /
     * WhatsApp köprüsü), tanımlı iskonto, açık bakiye risk rozeti, son sipariş
     * tarihi/tutarı, son ziyaret notu etiketi, ziyaret durumu; saha kabuğunda
     * [🛍️ Bu Bayiye Sipariş Aç] [📝 Ziyaret Notu Bırak].
     * HER ALAN VARLIK KONTROLÜYLE basılır: eski eklenti yalnızca {id, unvan}
     * gönderir; 'undefined' / 'NaN%' ekrana düşmemeli.
     */
    function bayiKarti(b, sonNotlar) {
      sonNotlar = sonNotlar || {};

      var telefon = String(b.telefon || '').trim();
      var yetkili = String(b.yetkili || b.ad || '').trim();
      var iskonto = (b.iskonto !== undefined && b.iskonto !== null && b.iskonto !== '') ? Number(b.iskonto) : NaN;
      var sonTarih = b.sonSiparisTarihi ? new Date(b.sonSiparisTarihi) : null;
      var sonTarihYazi = sonTarih && !isNaN(sonTarih.getTime()) ? sonTarih.toLocaleDateString('tr-TR') : '';
      var sonTutar = Number(b.sonSiparisTutari) || 0;
      var not = sonNotlar[Number(b.id)] || null;
      var notEtiket = '';
      var bakiye = (b.acikBakiye !== undefined && b.acikBakiye !== null && b.acikBakiye !== '') ? Number(b.acikBakiye) : NaN;
      var wa = waTel(telefon);
      var zd = ziyaretDurumu(b, not);

      if (not) {
        var e = Array.isArray(not.etiketler) && not.etiketler.length ? not.etiketler[0] : '';
        notEtiket = e ? V().etiketAdi(e) : String(not.not || '').slice(0, 40);
      } else if (b.sonZiyaretEtiket) {
        notEtiket = V().etiketAdi(b.sonZiyaretEtiket);
      }

      return '<div class="bayi-kart p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50 border-2 border-slate-100 dark:border-slate-700" data-bayi="' + kacis(String(b.id || '')) + '">' +
        '<div class="flex items-start gap-2">' +
          '<div class="font-extrabold truncate min-w-0 flex-1">' + kacis(b.unvan || ('#' + b.id)) + '</div>' +
          (!isNaN(iskonto)
            ? '<span class="shrink-0 px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs font-black" title="Tanımlı bayi iskontosu">%' + kacis(String(Math.round(iskonto * 10) / 10)) + '</span>'
            : '') +
          (!isNaN(bakiye)
            ? (bakiye > 0
                ? '<span class="bayi-risk shrink-0 px-2 py-0.5 rounded-md bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 text-xs font-black" title="Açık bakiye — cari risk">⚠ ' + kacis(paraYaz(bakiye)) + '</span>'
                : '<span class="bayi-risk shrink-0 px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs font-black" title="Açık bakiye yok">✓ Temiz</span>')
            : '') +
        '</div>' +
        ((yetkili || telefon)
          ? '<div class="text-sm text-slate-600 dark:text-slate-300 mt-1 flex items-center gap-2 flex-wrap">' +
              (yetkili ? '<span class="truncate">' + kacis(yetkili) + '</span>' : '') +
              (telefon
                ? '<span class="font-semibold">' + kacis(telefon) + '</span>' +
                  '<button type="button" class="bk-ara px-2 py-0.5 rounded-md border border-slate-300 dark:border-slate-600 text-xs font-bold hover:bg-white dark:hover:bg-slate-800" data-tel="' + kacis(telefon) + '" title="Numarayı ara / kopyala">📞 Ara</button>' +
                  (wa ? '<button type="button" class="bk-wa px-2 py-0.5 rounded-md bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700" data-wa="' + kacis(wa) + '" data-unvan="' + kacis(b.unvan || '') + '" title="WhatsApp ile yaz">📲 WhatsApp</button>' : '')
                : '') +
            '</div>'
          : '') +
        '<div class="text-xs font-bold text-slate-500 dark:text-slate-400 mt-1">' +
          (sonTarihYazi
            ? 'Son sipariş: ' + kacis(sonTarihYazi) + ' · ' + kacis(paraYaz(sonTutar))
            : 'Bu pencerede sipariş yok') +
        '</div>' +
        ((notEtiket || zd)
          ? '<div class="mt-1 flex items-center gap-1.5 flex-wrap">' +
              (zd
                ? ('bu_ay' === zd
                    ? '<span class="bayi-ziyaret px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs font-bold" data-ziyaret="bu_ay">✓ Bu ay ziyaret edildi</span>'
                    : '<span class="bayi-ziyaret px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-xs font-bold" data-ziyaret="bekliyor">⏳ Ziyaret bekliyor</span>')
                : '') +
              (notEtiket ? '<span class="inline-block px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700 text-xs font-bold" title="Son ziyaret notu">📝 ' + kacis(notEtiket) + '</span>' : '') +
            '</div>'
          : '') +
        (ADMIN
          ? ''
          : '<div class="mt-2 flex gap-2 flex-wrap">' +
              '<button type="button" class="bk-siparis px-3 py-2 rounded-lg bg-marka-700 text-white font-bold text-sm hover:bg-marka-600" data-bayi="' + kacis(String(b.id || '')) + '">🛍️ Bu Bayiye Sipariş Aç</button>' +
              '<button type="button" class="bk-not px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-bayi="' + kacis(String(b.id || '')) + '">📝 Ziyaret Notu Bırak</button>' +
            '</div>') +
      '</div>';
    }

    function bayiPaneli(il, sonNotlar) {
      var liste = il.bayiler || [];

      sonNotlar = sonNotlar || {};

      return '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
        '<div class="font-extrabold mb-3">' + (ADMIN ? 'Bayiler' : 'Bayilerim') + ' <span class="text-sm font-bold text-slate-500">' + il.bayiSayisi + '</span></div>' +
        (liste.length
          ? '<div class="space-y-2 max-h-96 overflow-y-auto">' +
            liste.map(function (b) { return bayiKarti(b, sonNotlar); }).join('') +
            (il.bayiSayisi > liste.length
              ? '<div class="px-3 py-2 text-sm text-slate-500">+ ' + (il.bayiSayisi - liste.length) + ' bayi daha</div>'
              : '') +
            '</div>'
          : (ADMIN
              ? '<div class="text-slate-500 dark:text-slate-400">Bu ilde kayıtlı bayi yok.</div>'
              : '<div class="text-slate-500 dark:text-slate-400">Bu ilde henüz bayiniz yok. <b>Müşterilerim → + Yeni Müşteri</b> ile ekleyin; harita kendiliğinden dolar.</div>')) +
      '</div>';
    }

    function notPaneli(notlar) {
      if (!notlar.length) {
        return '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
          '<div class="font-extrabold mb-2">Saha Ziyaret Notları</div>' +
          '<div class="text-slate-500 dark:text-slate-400">Bu ilde not yok.</div>' +
        '</div>';
      }

      return '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
        '<div class="font-extrabold mb-3">Saha Ziyaret Notları <span class="text-sm font-bold text-slate-500">' + notlar.length + '</span></div>' +
        '<div class="space-y-3 max-h-96 overflow-y-auto">' +
          notlar.map(notKarti).join('') +
        '</div>' +
      '</div>';
    }

    function durumRozeti(durum) {
      if ('cozuldu' === durum) {
        return '<span class="px-2 py-1 rounded-lg bg-emerald-600 text-white text-xs font-black">✓ Çözüldü</span>';
      }

      if ('gorundu' === durum) {
        return '<span class="px-2 py-1 rounded-lg bg-amber-500 text-white text-xs font-black">👁 İşleme Alındı</span>';
      }

      return '<span class="px-2 py-1 rounded-lg bg-red-600 text-white text-xs font-black">! Bekliyor</span>';
    }

    function notKarti(n) {
      var etiketler = (n.etiketler || []).map(function (e) {
        return '<span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-xs font-bold">' +
          kacis(V().etiketAdi(e)) + '</span>';
      }).join(' ');

      var zaman = '';

      try {
        zaman = new Date(n.zaman).toLocaleString('tr-TR');
      } catch (e) {
        zaman = String(n.zaman || '');
      }

      var sonraki = ADMIN ? V().sonrakiDurum(n.durum) : '';

      return '<div class="p-3 rounded-xl border-2 border-slate-100 dark:border-slate-700">' +
        '<div class="flex items-start justify-between gap-3 flex-wrap">' +
          '<div>' +
            '<div class="font-extrabold">' + kacis(n.musteriAdi || '—') + '</div>' +
            '<div class="text-xs text-slate-500 dark:text-slate-400">' +
              kacis(n.plasiyerAdi || '—') + ' · ' + kacis(zaman) +
            '</div>' +
          '</div>' +
          durumRozeti(n.durum) +
        '</div>' +

        (etiketler ? '<div class="mt-2 flex gap-1 flex-wrap">' + etiketler + '</div>' : '') +
        (n.not ? '<p class="mt-2 whitespace-pre-wrap">' + kacis(n.not) + '</p>' : '') +
        (n.gorsel ? '<a href="#" class="not-gorsel mt-2 inline-block text-sm font-bold underline" data-adres="' + kacis(n.gorsel) + '">Eki görüntüle</a>' : '') +

        (n.yanit
          ? '<div class="mt-2 p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-sm">' +
            '<span class="font-bold">Yönetici yanıtı:</span> ' + kacis(n.yanit) + '</div>'
          : '') +

        (ADMIN
          ? '<div class="mt-3 flex gap-2 flex-wrap">' +
              (sonraki
                ? '<button type="button" class="not-durum px-3 py-2 rounded-lg bg-marka-700 text-white font-bold text-sm hover:bg-marka-600 transition" ' +
                  'data-id="' + n.id + '" data-durum="' + sonraki + '">' +
                  ('gorundu' === sonraki ? 'Gördüm / İşleme Aldım' : 'Çözüme Kavuştu') +
                  '</button>'
                : '') +
              '<button type="button" class="not-yanit px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700 transition" ' +
                'data-id="' + n.id + '">Yanıt Yaz</button>' +
            '</div>'
          : '') +
      '</div>';
    }

    /* ------------------------------------------------------------------ *
     *  NOT İŞLEMLERİ (yönetici)
     * ------------------------------------------------------------------ */

    async function durumGonder(id, durum, yanit) {
      var govde = { id: Number(id), durum: String(durum) };

      if (undefined !== yanit && null !== yanit) govde.yanit = String(yanit);

      var cevap = await b2b('/admin/ziyaret/durum', { metod: 'POST', govde: govde });

      if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
        bildir((cevap && cevap.hata) || 'Durum güncellenemedi.', 'hata');
        return;
      }

      /* Yerel listeyi yerinde güncelle — tüm haritayı yeniden çekmeye gerek yok. */
      var yeni = cevap.veri.not;

      durumH.notlar = durumH.notlar.map(function (n) {
        return Number(n.id) === Number(id) ? yeni : n;
      });

      /* İlin uyarı bayrağını tazele: kırmızı ünlem yeşile dönsün/kaybolsun. */
      var il = durumH.iller.find(function (x) { return V().normalize(x.ad) === V().normalize(yeni.il); });

      if (il) {
        il.not.cozulmemis = V().cozulmemisSayisi(durumH.notlar, { il: il.ad });
        il.uyari = il.not.cozulmemis > 0;
      }

      if (durumH.toplam) {
        durumH.toplam.cozulmemis = V().cozulmemisSayisi(durumH.notlar);
      }

      rozetiTazele();
      bolunmusCiz();

      bildir('cozuldu' === durum ? 'Not çözüldü olarak işaretlendi.' : 'Not işleme alındı.', 'ok');
    }

    async function yanitSor(id) {
      var n = durumH.notlar.find(function (x) { return Number(x.id) === Number(id); });

      if (!n) return;

      var metin = window.prompt('Pazarlamacıya yanıt (örn: "İskonto onaylandı, yazabilirsin."):', n.yanit || '');

      if (null === metin) return;

      /* Yanıt yazmak durumu EN AZ "görüldü" yapar: patron cevap yazdıysa
         notu görmüştür. Çözülmüş bir notta durum korunur. */
      var hedef = 'cozuldu' === n.durum ? 'cozuldu' : 'gorundu';

      await durumGonder(id, hedef, metin);
    }

    /* ------------------------------------------------------------------ *
     *  BAYİ KARTI EYLEMLERİ (arama / WhatsApp / saha kısayolları)
     * ------------------------------------------------------------------ */

    function bayiBul(id) {
      var il = durumH.secili;

      if (!il) return null;

      return (il.bayiler || []).find(function (b) { return String(b.id) === String(id); }) || null;
    }

    function araKopyala(tel) {
      /* Masaüstünde "arama" = numarayı panoya kopyala + tel: bağlantısını dene. */
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tel);
      } catch (e) { /* pano yoksa sessiz */ }

      try {
        if ('undefined' !== typeof ipcRenderer) ipcRenderer.invoke('byom:dis-baglanti', 'tel:' + String(tel).replace(/[^0-9+]/g, ''));
      } catch (e) { /* sessiz */ }

      bildir('Numara panoya kopyalandı: ' + tel, 'bilgi');
    }

    function whatsappAc(wa, unvan) {
      var metin = 'Merhaba' + (unvan ? ' ' + unvan : '') + ',';

      window.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(metin));
    }

    /* ------------------------------------------------------------------ *
     *  OLAY BAĞLAMA
     * ------------------------------------------------------------------ */

    function baglaHarita() {
      var k = kap();

      if (!k) return;

      var yenile = el(kimlik('Yenile'));
      if (yenile) yenile.addEventListener('click', veriyiGetir);

      k.querySelectorAll('.harita-gun').forEach(function (d) {
        d.addEventListener('click', function () {
          durumH.gun = Number(d.dataset.gun) || 0;
          durumH.tarih = '';   // gün düğmesi belirli tarihi iptal eder
          veriyiGetir();
        });
      });

      var tarihG = el(kimlik('Tarih'));
      if (tarihG) {
        tarihG.addEventListener('change', function () {
          tarihSec(tarihG.value);
        });
      }

      var tarihSil = el(kimlik('TarihSil'));
      if (tarihSil) tarihSil.addEventListener('click', function () { tarihSec(''); });

      k.querySelectorAll('.harita-olcut').forEach(function (d) {
        d.addEventListener('click', function () {
          durumH.olcut = String(d.dataset.olcut || 'ciro');
          ciz();
        });
      });

      /* Lejant: plasiyer vurgusu — yeniden çizim, ağa çıkmaz. */
      k.querySelectorAll('.lejant-plasiyer').forEach(function (d) {
        d.addEventListener('click', function () {
          var id = Number(d.dataset.plasiyer) || 0;

          durumH.vurgu = (id && durumH.vurgu !== id) ? id : 0;
          ciz();
        });
      });

      var svg = el(kimlik('Svg'));

      if (!svg) return;

      /* Delegasyon: 81 il için ayrı dinleyici bağlamak gereksiz. */
      svg.addEventListener('mousemove', function (olay) {
        var hedef = olay.target.closest('.harita-il');

        if (!hedef) { ipucuGizle(); return; }

        var il = durumH.iller.find(function (x) { return Number(x.plaka) === Number(hedef.dataset.plaka); });

        if (il && ilEtkin(il)) ipucuGoster(il, olay);
        else ipucuGizle();
      });

      svg.addEventListener('mouseleave', ipucuGizle);

      svg.addEventListener('click', function (olay) {
        var hedef = olay.target.closest('.harita-il');

        if (hedef) ilSec(hedef.dataset.plaka);
      });

      /* Klavye: Enter/Space ile il açılır (tabindex verildi). */
      svg.addEventListener('keydown', function (olay) {
        if ('Enter' !== olay.key && ' ' !== olay.key) return;

        var hedef = olay.target.closest('.harita-il');

        if (hedef) {
          olay.preventDefault();
          ilSec(hedef.dataset.plaka);
        }
      });
    }

    function baglaNotlar() {
      var k = kap();

      if (!k) return;

      /* Tek dinleyici, delegasyon: kartlar her çizimde yenilenir. */
      k.onclick = function (olay) {
        var ara = olay.target.closest('.bk-ara');

        if (ara) { araKopyala(ara.dataset.tel); return; }

        var wa = olay.target.closest('.bk-wa');

        if (wa) { whatsappAc(wa.dataset.wa, wa.dataset.unvan); return; }

        if (!ADMIN) {
          var sip = olay.target.closest('.bk-siparis');

          if (sip) {
            var b1 = bayiBul(sip.dataset.bayi);

            if (b1 && window.PlasiyerMusteri && 'function' === typeof window.PlasiyerMusteri.siparisYazmayaGec) {
              window.PlasiyerMusteri.siparisYazmayaGec(b1);
            }
            return;
          }

          var notD = olay.target.closest('.bk-not');

          if (notD) {
            var b2 = bayiBul(notD.dataset.bayi);

            if (b2 && window.PlasiyerMusteri && 'function' === typeof window.PlasiyerMusteri.ziyaretNotuAc) {
              window.PlasiyerMusteri.ziyaretNotuAc(b2);
            }
            return;
          }
        }

        var durumD = olay.target.closest('.not-durum');

        if (durumD && ADMIN) {
          durumGonder(durumD.dataset.id, durumD.dataset.durum);
          return;
        }

        var yanitD = olay.target.closest('.not-yanit');

        if (yanitD && ADMIN) {
          yanitSor(yanitD.dataset.id);
          return;
        }

        var gorsel = olay.target.closest('.not-gorsel');

        if (gorsel) {
          olay.preventDefault();

          var adres = gorsel.dataset.adres;

          if (adres) ipcRenderer.invoke('byom:dis-baglanti', adres);
        }
      };
    }

    /* ------------------------------------------------------------------ *
     *  MEVCUT AKIŞA BAĞLANMA
     * ------------------------------------------------------------------ */

    async function sekmeyiAc() {
      yollariBesle();

      if (bagli && durumH.iller.length) {
        ciz();
        return;
      }

      bagli = true;

      await veriyiGetir();
    }

    /** Belirli günü seçer ('' = temizle); gün düğmesi sıfırlanır, veri yeniden çekilir. */
    function tarihSec(tarih) {
      var metin = String(tarih || '');
      var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(metin);
      var dt = p ? new Date(Number(p[1]), Number(p[2]) - 1, Number(p[3])) : null;

      /* Takvimde olmayan gün ('2026-13-99') sunucuda da reddedilir (tarih_normalle);
         burada da düşürülür ki panel ile sunucu ayrışmasın. */
      var gecerli = !!dt && dt.getFullYear() === Number(p[1]) && dt.getMonth() === Number(p[2]) - 1 && dt.getDate() === Number(p[3]);

      durumH.tarih = gecerli ? metin : '';

      if (durumH.tarih) durumH.gun = 0;

      return veriyiGetir();
    }

    return {
      kip: KIP,
      yollariBesle: yollariBesle,
      sekmeyiAc: sekmeyiAc,
      veriyiGetir: veriyiGetir,
      notlariGetir: notlariGetir,
      tarihSec: tarihSec,
      bayiKarti: bayiKarti,
      ilSec: ilSec,
      geriDon: geriDon,
      rozetiTazele: rozetiTazele,
      durum: durumH
    };
  }

  /* ====================================================================
   *  ÖRNEKLER
   * ==================================================================== */

  /** YÖNETİCİ kokpiti — geriye dönük aynı ad ve aynı yüzey. */
  var yonetici = olustur({ kip: 'admin', kapId: 'haritaKab', onek: 'harita' });

  /** SAHA haritası — #sekme-sahaharitam içindeki #sahaHaritaKab'a çizer. */
  var saha = olustur({ kip: 'plasiyer', kapId: 'sahaHaritaKab', onek: 'sahaHarita' });

  /**
   * FAZ 6'DA `sekmeAc` SARMALI KALDIRILDI — okumadan geri ekleme.
   *
   * Yönetici haritası "Pazarlamacılar" sekmesinin alt sekmesidir; açma kararını
   * `plasiyer-yonetimi.js → altSekmeAc()` verir ve `HaritaKokpit.sekmeyiAc()`
   * çağırır. Buradaki bir sarmal `sekmeyiAc()`i İKİ KEZ çalıştırır ve her
   * açılışta çift `/admin/harita` isteği atardı (test istek SAYISIYLA kilitler).
   *
   * SAHA haritası ise BAĞIMSIZ bir ana sekmedir (`sahaharitam`) — onun için
   * sarmal gerekli ve TEK'tir (`bagliS` bayrağı).
   */
  var bagliS = false;
  var rozetBir = false;

  /** Açık not rozeti — yalnızca yönetici oturumunda ve yalnızca bir kez. */
  function rozetiDene() {
    if (rozetBir) return;

    var o = window.durum && window.durum.oturum;

    if (!o || 'admin' !== o.rol) return;

    rozetBir = true;

    yonetici.notlariGetir().then(yonetici.rozetiTazele).catch(function () { /* sessiz */ });
  }

  function akisaBaglan() {
    yollariBesle();

    /*
     * Rozet açılışta da dolsun: patron haritayı açmadan da açık not sayısını
     * görmeli. AMA yalnızca YÖNETİCİ oturumunda: eski koşul "plasiyer değilse"
     * diyordu ve açılışta oturum henüz `null` olduğu için saha terminali dahil
     * HER açılışta /admin/ziyaret isteği atılıyor, kim olduğu bilinmeden bütün
     * şirketin ziyaret notları cihaza iniyordu. Artık oturum KURULUNCA tetiklenir
     * (renderer-plasiyer.js `byom:oturum` yayar); 2,5 sn'lik yedek yalnızca
     * olayı kaçıran sıfır kurulum dalı içindir. `rozetBir` ikisini de tek sefere
     * indirir.
     */
    window.addEventListener('byom:oturum', rozetiDene);
    window.setTimeout(rozetiDene, 2500);

    if (!bagliS && 'function' === typeof window.sekmeAc) {
      bagliS = true;

      var ozgun = window.sekmeAc;

      window.sekmeAc = function (ad) {
        var sonuc = ozgun.apply(this, arguments);

        if ('sahaharitam' === ad) saha.sekmeyiAc();

        return sonuc;
      };
    }
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', akisaBaglan);
  } else {
    akisaBaglan();
  }

  yonetici.olustur = olustur;
  yonetici.PALET = PALET;
  yonetici.PALET_ADLARI = PALET_ADLARI;
  yonetici.hexRgba = hexRgba;
  yonetici.kisaPara = kisaPara;

  window.HaritaKokpit = yonetici;
  window.SahaHarita = saha;
})();
