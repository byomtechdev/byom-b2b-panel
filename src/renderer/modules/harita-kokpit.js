/* ============================================================================
 *  TÜRKİYE HARİTA KOKPİTİ — YÖNETİCİ
 *  src/renderer/modules/harita-kokpit.js
 *  ---------------------------------------------------------------------------
 *  İnternet/Google Maps GEREKTİRMEYEN, harici bağımlılığı SIFIR yerel SVG
 *  harita. 81 il; hover vurgusu, ipucu kartı, bölünmüş ekran (split view),
 *  yakınlaştırma, çözülmemiş ziyaret notu uyarısı ve tarih filtresi.
 *
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │ GEOMETRİ — DÜRÜST NOT                                                │
 *  │ İl sınır poligonları ŞEMATİKTİR: her il, gerçeğe yakın coğrafi        │
 *  │ konumunda yuvarlatılmış bir kutu olarak çizilir (kartogram üslubu).   │
 *  │ Gerçek sınır yolları ölçülmüş coğrafi veridir ve bu depoda yoktur.    │
 *  │ Beslemek için: HaritaVeri.yollariYukle({ 35: 'M…', … }) — bu modülde  │
 *  │ HİÇBİR ŞEY değişmez, `il.yol` varsa <path>, yoksa <rect> basılır.     │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 *  GPU: yalnızca `transform` ve `opacity` animasyonlanır. Bölünmüş ekrana
 *  geçişte Türkiye haritası `scale`+`opacity` ile kararıp küçülür, seçilen il
 *  `viewBox` DEĞİŞTİRİLMEDEN `transform: scale/translate` ile büyür. viewBox
 *  animasyonlamak her karede yeniden düzen hesabı demektir; transform
 *  kompozitörde kalır.
 *
 *  Veri TEK istekten gelir (`/admin/harita`): 81 il için ayrı istek atmak
 *  haritayı kullanılamaz yapardı.
 * ==========================================================================*/

'use strict';

(function () {

  /** İl kutusunun yarı genişliği/yüksekliği (şematik mod). */
  var KUTU = { w: 26, h: 15 };

  var durumH = {
    iller: [],
    tanimsiz: [],
    enCokCiro: 0,
    toplam: null,
    notlar: [],
    gun: 0,              // 0 = tümü, 1 = günlük, 7 = haftalık
    olcut: 'ciro',       // ciro | siparis | bayi
    secili: null,        // bölünmüş ekranda açık il
    yukleniyor: false
  };

  var bagli = false;

  function V() {
    return window.HaritaVeri;
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

  /* ------------------------------------------------------------------ *
   *  VERİ
   * ------------------------------------------------------------------ */

  async function veriyiGetir() {
    durumH.yukleniyor = true;

    ciz();

    var cevap = await b2b('/admin/harita', { sorgu: { gun: durumH.gun } });

    durumH.yukleniyor = false;

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) {
      var kap = el('haritaKab');

      if (kap) {
        kap.innerHTML = '<div class="py-16 text-center text-red-600 dark:text-red-400 font-semibold">' +
          kacis((cevap && cevap.hata) || 'Harita verisi alınamadı.') + '</div>';
      }

      return;
    }

    var sonuc = V().haritayiKur(cevap.veri);

    durumH.iller = sonuc.iller;
    durumH.tanimsiz = sonuc.tanimsiz;
    durumH.enCokCiro = sonuc.enCokCiro;
    durumH.toplam = sonuc.toplam;

    await notlariGetir();

    ciz();
    rozetiTazele();
  }

  async function notlariGetir() {
    var cevap = await b2b('/admin/ziyaret', { sorgu: { gun: durumH.gun } });

    durumH.notlar = (cevap && cevap.ok && cevap.veri && cevap.veri.notlar) || [];
  }

  /** Sol menüdeki "Pazarlamacılar" rozetini tazeler. */
  function rozetiTazele() {
    var sayi = V().cozulmemisSayisi(durumH.notlar);
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
   *  ÇİZİM — ÜST BAR
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

    return '' +
      '<div class="flex items-center gap-3 flex-wrap mb-4">' +
        '<div class="flex rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-600">' +
          gunSecenek.map(function (g) {
            return '<button type="button" class="harita-gun px-4 py-2.5 font-bold transition ' +
              (durumH.gun === g.d ? 'bg-marka-700 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-700') +
              '" data-gun="' + g.d + '">' + g.ad + '</button>';
          }).join('') +
        '</div>' +

        '<div class="flex rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-600">' +
          olcutSecenek.map(function (o) {
            return '<button type="button" class="harita-olcut px-4 py-2.5 font-bold transition ' +
              (durumH.olcut === o.o ? 'bg-slate-700 text-white dark:bg-slate-600' : 'hover:bg-slate-100 dark:hover:bg-slate-700') +
              '" data-olcut="' + o.o + '">' + o.ad + '</button>';
          }).join('') +
        '</div>' +

        '<div class="ml-auto flex items-center gap-4 text-sm font-bold">' +
          '<span>' + t.bayi + ' bayi</span>' +
          '<span>' + t.siparis + ' sipariş</span>' +
          '<span>' + kacis(paraYaz(t.ciro)) + '</span>' +
          (t.cozulmemis
            ? '<span class="px-3 py-1.5 rounded-xl bg-red-600 text-white">' + t.cozulmemis + ' açık not</span>'
            : '<span class="px-3 py-1.5 rounded-xl bg-emerald-600 text-white">Açık not yok</span>') +
        '</div>' +

        '<button type="button" id="haritaYenile" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">⟳</button>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   *  ÇİZİM — SVG HARİTA
   * ------------------------------------------------------------------ */

  /** İlin dolgu rengi — yoğunluğa göre marka tonunun şeffaflığı. */
  function dolgu(il) {
    var ton = V().yogunluk(il, olcutTavani(), durumH.olcut);

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

  /** Tek ilin SVG parçası. `yol` varsa gerçek sınır, yoksa şematik kutu. */
  function ilSvg(il) {
    var ortak = 'class="harita-il" data-plaka="' + il.plaka + '" ' +
                'fill="' + dolgu(il) + '" stroke="rgba(100,116,139,0.55)" stroke-width="1" ' +
                'tabindex="0" role="button" aria-label="' + kacis(il.ad) + '"';

    var sekil = il.yol
      ? '<path ' + ortak + ' d="' + kacis(il.yol) + '"></path>'
      : '<rect ' + ortak + ' x="' + (il.x - KUTU.w / 2) + '" y="' + (il.y - KUTU.h / 2) +
        '" width="' + KUTU.w + '" height="' + KUTU.h + '" rx="3"></rect>';

    /* Plaka numarası — küçük ama harita okunurluğunu çok artırıyor. */
    var etiket = '<text class="harita-etiket" x="' + il.x + '" y="' + (il.y + 3.5) +
      '" text-anchor="middle" font-size="8" font-weight="700" ' +
      'fill="' + (V().yogunluk(il, olcutTavani(), durumH.olcut) > 0.55 ? '#fff' : 'rgba(51,65,85,0.85)') + '" ' +
      'pointer-events="none">' + il.plaka + '</text>';

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
      '<svg id="haritaSvg" viewBox="0 0 ' + tuval.w + ' ' + tuval.h + '" ' +
           'class="w-full h-auto select-none" role="img" aria-label="Türkiye bayi haritası">' +
        '<g id="haritaKatman">' +
          durumH.iller.map(ilSvg).join('') +
        '</g>' +
      '</svg>';
  }

  /* ------------------------------------------------------------------ *
   *  ÇİZİM — ANA KAP
   * ------------------------------------------------------------------ */

  function ciz() {
    var kap = el('haritaKab');

    if (!kap) return;

    if (durumH.yukleniyor && !durumH.iller.length) {
      kap.innerHTML = '<div class="py-16 text-center text-slate-500">Harita yükleniyor…</div>';
      return;
    }

    if (durumH.secili) {
      bolunmusCiz();
      return;
    }

    kap.innerHTML =
      ustBar() +
      '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
        haritaSvg() +
        (V().yolluIlSayisi() === 0
          ? '<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">' +
            'Şematik görünüm: iller gerçek coğrafi konumlarında kutu olarak çizilir. ' +
            'Gerçek il sınırları <code>HaritaVeri.yollariYukle()</code> ile beslenebilir.</p>'
          : '') +
        (durumH.tanimsiz.length
          ? '<p class="mt-3 text-xs text-amber-700 dark:text-amber-400">' +
            durumH.tanimsiz.length + ' kayıt bir ile eşlenemedi (il alanı boş ya da tanınmayan): ' +
            kacis(durumH.tanimsiz.map(function (x) { return x.ad; }).join(', ')) + '</p>'
          : '') +
      '</div>' +
      '<div id="haritaIpucu" hidden class="fixed z-[75] pointer-events-none max-w-xs ' +
           'bg-slate-900 text-white text-sm rounded-xl shadow-2xl p-3"></div>';

    baglaHarita();
  }

  /* ------------------------------------------------------------------ *
   *  İPUCU KARTI
   * ------------------------------------------------------------------ */

  function ipucuGoster(il, olay) {
    var kutu = el('haritaIpucu');

    if (!kutu) return;

    var bayiListe = (il.bayiler || []).slice(0, 6).map(function (b) {
      return '<li class="truncate">• ' + kacis(b.unvan || ('#' + b.id)) + '</li>';
    }).join('');

    kutu.innerHTML =
      '<div class="font-extrabold text-base">' + kacis(il.ad) + ' <span class="opacity-60 font-bold">' + il.plaka + '</span></div>' +
      '<div class="opacity-70 text-xs">' + kacis(il.bolge) + '</div>' +
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
    var kutu = el('haritaIpucu');

    if (kutu) kutu.hidden = true;
  }

  /* ------------------------------------------------------------------ *
   *  BÖLÜNMÜŞ EKRAN (SPLIT VIEW)
   * ------------------------------------------------------------------ */

  function ilSec(plaka) {
    var il = durumH.iller.find(function (x) { return Number(x.plaka) === Number(plaka); });

    if (!il) return;

    durumH.secili = il;

    ipucuGizle();
    bolunmusCiz();
  }

  function geriDon() {
    durumH.secili = null;
    ciz();
  }

  function bolunmusCiz() {
    var kap = el('haritaKab');
    var il = durumH.secili;

    if (!kap || !il) return;

    var notlar = V().notlariSuz(durumH.notlar, { il: il.ad, gun: durumH.gun });

    kap.innerHTML =
      '<div class="flex items-center gap-3 mb-4 flex-wrap">' +
        '<button type="button" id="haritaGeri" class="px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
          '← Türkiye Haritasına Dön' +
        '</button>' +
        '<div class="text-2xl font-black">' + kacis(il.ad) +
          ' <span class="text-base font-bold text-slate-500">' + il.plaka + ' · ' + kacis(il.bolge) + '</span>' +
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
          bayiPaneli(il) +
          notPaneli(notlar) +
        '</div>' +
      '</div>';

    var geri = el('haritaGeri');
    if (geri) geri.addEventListener('click', geriDon);

    baglaNotlar();
  }

  function kutucuk(etiket, deger) {
    return '<div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50">' +
      '<div class="text-xs text-slate-500 dark:text-slate-400">' + etiket + '</div>' +
      '<div class="font-black text-lg">' + kacis(String(deger)) + '</div>' +
    '</div>';
  }

  /**
   * Seçili ilin büyütülmüş çizimi.
   *
   * ZOOM `transform` İLE: viewBox animasyonlamak her karede düzen hesabı
   * tetikler; scale+translate kompozitörde kalır ve 60 FPS korunur.
   */
  function tekIlSvg(il) {
    var tuval = V().TUVAL;
    var k = 3.2;   // yakınlaştırma katsayısı

    /* İl merkezini tuvalin ortasına taşıyan öteleme. */
    var dx = (tuval.w / 2) - il.x * k;
    var dy = (tuval.h / 2) - il.y * k;

    return '<svg viewBox="0 0 ' + tuval.w + ' ' + tuval.h + '" class="w-full h-auto">' +
      '<g class="harita-zoom" style="transform: translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + k + ');">' +
        /* Komşular soluk arka plan olarak kalır: il tek başına havada durmasın. */
        durumH.iller.map(function (x) {
          if (Number(x.plaka) === Number(il.plaka)) return '';

          return '<rect x="' + (x.x - KUTU.w / 2) + '" y="' + (x.y - KUTU.h / 2) +
            '" width="' + KUTU.w + '" height="' + KUTU.h + '" rx="3" ' +
            'fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.25)" stroke-width="0.6"></rect>';
        }).join('') +

        (il.yol
          ? '<path d="' + kacis(il.yol) + '" fill="rgba(29,78,216,0.85)" stroke="#1e3a8a" stroke-width="1.2"></path>'
          : '<rect x="' + (il.x - KUTU.w / 2) + '" y="' + (il.y - KUTU.h / 2) +
            '" width="' + KUTU.w + '" height="' + KUTU.h + '" rx="3" ' +
            'fill="rgba(29,78,216,0.85)" stroke="#1e3a8a" stroke-width="1.2"></rect>') +

        '<text x="' + il.x + '" y="' + (il.y + 3.5) + '" text-anchor="middle" font-size="7" font-weight="800" fill="#fff">' +
          il.plaka +
        '</text>' +
      '</g>' +
    '</svg>';
  }

  function bayiPaneli(il) {
    var liste = il.bayiler || [];

    return '<div class="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4">' +
      '<div class="font-extrabold mb-3">Bayiler <span class="text-sm font-bold text-slate-500">' + il.bayiSayisi + '</span></div>' +
      (liste.length
        ? '<ul class="space-y-1 max-h-48 overflow-y-auto">' +
          liste.map(function (b) {
            return '<li class="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/50 font-semibold truncate">' +
              kacis(b.unvan || ('#' + b.id)) + '</li>';
          }).join('') +
          (il.bayiSayisi > liste.length
            ? '<li class="px-3 py-2 text-sm text-slate-500">+ ' + (il.bayiSayisi - liste.length) + ' bayi daha</li>'
            : '') +
          '</ul>'
        : '<div class="text-slate-500 dark:text-slate-400">Bu ilde kayıtlı bayi yok.</div>') +
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

    var sonraki = V().sonrakiDurum(n.durum);

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

      '<div class="mt-3 flex gap-2 flex-wrap">' +
        (sonraki
          ? '<button type="button" class="not-durum px-3 py-2 rounded-lg bg-marka-700 text-white font-bold text-sm hover:bg-marka-600 transition" ' +
            'data-id="' + n.id + '" data-durum="' + sonraki + '">' +
            ('gorundu' === sonraki ? 'Gördüm / İşleme Aldım' : 'Çözüme Kavuştu') +
            '</button>'
          : '') +
        '<button type="button" class="not-yanit px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700 transition" ' +
          'data-id="' + n.id + '">Yanıt Yaz</button>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------------------ *
   *  NOT İŞLEMLERİ
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
   *  OLAY BAĞLAMA
   * ------------------------------------------------------------------ */

  function baglaHarita() {
    var yenile = el('haritaYenile');
    if (yenile) yenile.addEventListener('click', veriyiGetir);

    document.querySelectorAll('.harita-gun').forEach(function (d) {
      d.addEventListener('click', function () {
        durumH.gun = Number(d.dataset.gun) || 0;
        veriyiGetir();
      });
    });

    document.querySelectorAll('.harita-olcut').forEach(function (d) {
      d.addEventListener('click', function () {
        durumH.olcut = String(d.dataset.olcut || 'ciro');
        ciz();
      });
    });

    var svg = el('haritaSvg');

    if (!svg) return;

    /* Delegasyon: 81 il için ayrı dinleyici bağlamak gereksiz. */
    svg.addEventListener('mousemove', function (olay) {
      var hedef = olay.target.closest('.harita-il');

      if (!hedef) { ipucuGizle(); return; }

      var il = durumH.iller.find(function (x) { return Number(x.plaka) === Number(hedef.dataset.plaka); });

      if (il) ipucuGoster(il, olay);
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
    var kap = el('haritaKab');

    if (!kap) return;

    /* Tek dinleyici, delegasyon: not kartları her çizimde yenilenir. */
    kap.onclick = function (olay) {
      var durumD = olay.target.closest('.not-durum');

      if (durumD) {
        durumGonder(durumD.dataset.id, durumD.dataset.durum);
        return;
      }

      var yanitD = olay.target.closest('.not-yanit');

      if (yanitD) {
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
    if (bagli && durumH.iller.length) {
      ciz();
      return;
    }

    bagli = true;

    await veriyiGetir();
  }

  function akisaBaglan() {
    if ('function' !== typeof window.sekmeAc) return;

    var ozgun = window.sekmeAc;

    window.sekmeAc = function (ad) {
      var sonuc = ozgun.apply(this, arguments);

      if ('harita' === ad) sekmeyiAc();

      return sonuc;
    };

    /* Rozet açılışta da dolsun: patron haritayı açmadan da açık not sayısını
       görmeli. Sessiz, tek istek. */
    window.setTimeout(function () {
      notlariGetir().then(rozetiTazele).catch(function () { /* sessiz */ });
    }, 2500);
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', akisaBaglan);
  } else {
    akisaBaglan();
  }

  window.HaritaKokpit = {
    sekmeyiAc: sekmeyiAc,
    veriyiGetir: veriyiGetir,
    ilSec: ilSec,
    geriDon: geriDon,
    rozetiTazele: rozetiTazele,
    durum: durumH
  };
})();
