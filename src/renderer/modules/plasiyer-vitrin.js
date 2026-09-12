/* ============================================================================
 *  PLASİYER SATIŞ VİTRİNİ (src/renderer/modules/plasiyer-vitrin.js)
 *  ---------------------------------------------------------------------------
 *  Saha satış ekranının katalog yarısı: daraltılabilir kategori kenar çubuğu,
 *  filtre barı, ÇİFT GÖRÜNÜM (Vitrin / Hızlı Liste), koli matematiği, SPOT
 *  rozeti, ürün detay penceresi ve sepet.
 *
 *  KURALLARI YAZMAZ, ÇAĞIRIR. Koli katları, sepet indirgeyici ve toplamlar
 *  `src/renderer/plasiyer-siparis-motor.js` içindedir; o dosya DOM'suz olduğu
 *  için `node --test` altında ölçülebiliyor. Aynı matematiği burada tekrar
 *  yazmak, para hesabını test edilemeyen bir katmana taşımak olurdu.
 *
 *  VERİ AĞDAN DEĞİL DİSKTEN GELİR. Arama `katalog:ara` IPC'si ile ana
 *  süreçteki yerel depoya gider (bkz. main.js § 3.7). Plasiyer internetsizken
 *  de tam hızda çalışır; ağ yalnızca "Kataloğu Eşitle" anında konuşulur.
 *
 *  GÖRÜNÜM ANAHTARI: üst bardaki düğme ya da Tab tuşu. İki mod:
 *    vitrin → büyük kart, yerel diskten net görsel, koli + liste fiyatı
 *    matris → kompakt satır, küçük resim, [Enter → Adet → Enter] akışı
 *
 *  PERFORMANS: liste `EN_COK_KART` ile kırpılır ve "Daha Göster" ile büyür.
 *  5.000 kartı birden basmak Electron'da ilk boyamayı saniyelere çıkarırdı.
 * ==========================================================================*/

'use strict';

(function () {

  /** Tek seferde basılan en çok kart/satır. */
  var EN_COK_KART = 60;

  /** Görünüm modları. */
  var VITRIN = 'vitrin';
  var MATRIS = 'matris';

  var durumV = {
    mod: VITRIN,
    kategori: '',
    sorgu: '',
    sinir: EN_COK_KART,
    urunler: [],
    kategoriler: [],
    sepet: null,
    tavan: 0,
    menuAcik: true,
    acikUrun: null
  };

  var bagli = false;
  var aramaSaat = null;

  /** Sipariş motoru — window üzerinden (betik sırası: motor ÖNCE yüklenir). */
  function M() {
    return window.PlasiyerSiparisMotor;
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
   *  SEPET — motordan
   * ------------------------------------------------------------------ */

  function sepet() {
    if (!durumV.sepet) durumV.sepet = M().sepetKur();
    return durumV.sepet;
  }

  /** Müşteri modülü sepete erişir (ödeme ekranı aynı sepeti kullanır). */
  function sepetAl() {
    return sepet();
  }

  function tavanAl() {
    var o = window.durum && window.durum.oturum;
    return Number((o && o.maxIskonto) || durumV.tavan || 0);
  }

  /* ------------------------------------------------------------------ *
   *  VERİ
   * ------------------------------------------------------------------ */

  async function kategorileriGetir() {
    var cevap = await ipcRenderer.invoke('katalog:kategoriler');

    durumV.kategoriler = (cevap && cevap.kategoriler) || [];

    kategorileriCiz();
  }

  async function urunleriGetir() {
    var cevap = await ipcRenderer.invoke('katalog:ara', {
      sorgu: durumV.sorgu,
      kategori: durumV.kategori,
      adet: 500
    });

    durumV.urunler = (cevap && cevap.urunler) || [];
    durumV.sinir = EN_COK_KART;

    vitriniCiz();
    filtreEtiketiniCiz();
  }

  async function kunyeyiTazele() {
    var cevap = await ipcRenderer.invoke('katalog:durum');

    var k = (cevap && cevap.durum) || {};
    var g = (cevap && cevap.gorsel) || {};
    var kutu = el('katalogKunye');

    if (!kutu) return;

    var zaman = k.sonGuncelleme ? new Date(k.sonGuncelleme).toLocaleString('tr-TR') : 'hiç eşitlenmedi';

    kutu.textContent = (k.urun || 0) + ' ürün · ' + zaman +
      (g.bekleyen ? ' · ' + g.bekleyen + ' görsel iniyor' : '');
  }

  async function kataloguEsitle() {
    var dugme = el('katalogEsitle');

    if (dugme) { dugme.disabled = true; dugme.textContent = '⟳ Eşitleniyor…'; }

    var cevap = await ipcRenderer.invoke('katalog:guncelle', {});

    if (dugme) { dugme.disabled = false; dugme.textContent = '⟳ Kataloğu Eşitle'; }

    if (!cevap || !cevap.ok) {
      bildir((cevap && cevap.hata) || 'Katalog eşitlenemedi.', 'hata');
    } else {
      bildir(cevap.urun + ' ürün eşitlendi.', 'ok');
    }

    await kategorileriGetir();
    await urunleriGetir();
    await kunyeyiTazele();
  }

  /* ------------------------------------------------------------------ *
   *  KATEGORİ KENAR ÇUBUĞU
   * ------------------------------------------------------------------ */

  function kategorileriCiz() {
    var kap = el('katListe');

    if (!kap) return;

    if (!durumV.kategoriler.length) {
      kap.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">' +
        'Kategori yok. "Kataloğu Eşitle" ile başlayın.</div>';
      return;
    }

    kap.innerHTML = durumV.kategoriler.map(function (k) {
      var aktif = k.ad === durumV.kategori;

      return '<button type="button" class="kat-dugme text-left px-4 py-2.5 rounded-xl font-bold transition ' +
        (aktif ? 'bg-marka-700 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-700') + '" ' +
        'data-kat="' + kacis(k.ad) + '">' +
          kacis(k.ad) +
          '<span class="ml-2 text-xs font-semibold opacity-70">' + k.adet + '</span>' +
        '</button>';
    }).join('');
  }

  function menuyuAnahtarla() {
    durumV.menuAcik = !durumV.menuAcik;

    var kenar = el('katKenar');
    var kab = el('vitrinKab');
    var dugme = el('katMenuAnahtar');

    if (kenar) kenar.classList.toggle('kapali', !durumV.menuAcik);
    if (kab) kab.classList.toggle('genis', !durumV.menuAcik);
    if (dugme) dugme.setAttribute('aria-expanded', durumV.menuAcik ? 'true' : 'false');
  }

  /** Aktif filtreyi gösteren dinamik etiket. */
  function filtreEtiketiniCiz() {
    var kutu = el('filtreEtiket');

    if (!kutu) return;

    var parcalar = [];

    if (durumV.kategori) parcalar.push(kacis(durumV.kategori));
    if (durumV.sorgu) parcalar.push('“' + kacis(durumV.sorgu) + '”');

    if (!parcalar.length) {
      kutu.innerHTML = '<span class="text-slate-500 dark:text-slate-400">Tüm ürünler · ' +
        durumV.urunler.length + ' kalem</span>';
      return;
    }

    kutu.innerHTML =
      '<span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-marka-700 text-white font-bold">' +
        'Filtre: ' + parcalar.join(' &gt; ') +
        '<button type="button" id="filtreTemizle" class="ml-1 px-2 rounded-lg bg-white/20 hover:bg-white/30 font-black" ' +
                'title="Filtreyi temizle">✕ Temizle</button>' +
      '</span>' +
      '<span class="ml-3 text-slate-500 dark:text-slate-400">' + durumV.urunler.length + ' kalem</span>';

    var temizle = el('filtreTemizle');

    if (temizle) {
      temizle.addEventListener('click', function () {
        durumV.kategori = '';
        durumV.sorgu = '';

        var arama = el('urunArama');
        if (arama) arama.value = '';

        kategorileriCiz();
        urunleriGetir();
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  GÖRÜNÜM
   * ------------------------------------------------------------------ */

  function modAnahtarla() {
    durumV.mod = (VITRIN === durumV.mod) ? MATRIS : VITRIN;

    var dugme = el('gorunumAnahtar');

    if (dugme) dugme.textContent = (VITRIN === durumV.mod) ? '🛍️ Vitrin' : '⌨️ Hızlı Liste';

    vitriniCiz();
  }

  function gosterilenler() {
    return durumV.urunler.slice(0, durumV.sinir);
  }

  function vitriniCiz() {
    var kap = el('urunVitrin');

    if (!kap) return;

    if (!durumV.urunler.length) {
      kap.innerHTML =
        '<div class="py-16 text-center">' +
          '<div class="text-5xl mb-4" aria-hidden="true">📦</div>' +
          '<div class="text-xl font-bold">Ürün bulunamadı</div>' +
          '<p class="mt-2 text-slate-500 dark:text-slate-400">Filtreyi temizleyin ya da kataloğu eşitleyin.</p>' +
        '</div>';

      dahaDugmesiniCiz();
      return;
    }

    kap.innerHTML = (VITRIN === durumV.mod) ? kartlariCiz() : matrisCiz();

    dahaDugmesiniCiz();
    sepetiCiz();
  }

  /** Ürün görseli: yerel dosya varsa ondan, yoksa uzak adres, yoksa yer tutucu. */
  function gorselEtiketi(u) {
    var adres = u.local_image_path
      ? ('file://' + String(u.local_image_path).replace(/\\/g, '/'))
      : String(u.image_url || '');

    if (!adres) {
      return '<div class="gorsel-kutu grid place-items-center text-3xl text-slate-300 dark:text-slate-600">📦</div>';
    }

    /* loading="lazy": ekran dışındaki görseller hiç okunmaz. */
    return '<div class="gorsel-kutu rounded-xl">' +
      '<img src="' + kacis(adres) + '" alt="" loading="lazy" decoding="async" />' +
    '</div>';
  }

  function spotRozeti(u) {
    return u.is_spot ? '<span class="spot-rozet">🔥 SPOT / FIRSAT</span>' : '';
  }

  function koliEtiketi(u) {
    var koli = M().koliIci(u);

    return koli > 1
      ? '<span class="px-2 py-1 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-xs font-extrabold">Koli: ' + koli + ' adet</span>'
      : '<span class="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300 text-xs font-bold">Tekil satış</span>';
  }

  /** VİTRİN (sunum) modu — büyük kartlar. */
  function kartlariCiz() {
    return '<div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">' +
      gosterilenler().map(function (u) {
        return '' +
          '<div class="urun-kart relative bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-3">' +
            spotRozeti(u) +
            '<button type="button" class="urun-buyut w-full" data-id="' + u.id + '" title="Büyüt">' +
              gorselEtiketi(u) +
            '</button>' +
            '<div class="mt-3 font-extrabold leading-snug line-clamp-2" title="' + kacis(u.name) + '">' + kacis(u.name) + '</div>' +
            '<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">' + kacis(u.sku || '') + '</div>' +
            '<div class="mt-2 flex items-center gap-2 flex-wrap">' + koliEtiketi(u) + '</div>' +
            '<div class="mt-2 text-lg font-black">' + kacis(paraYaz(u.price)) + '</div>' +
            '<button type="button" class="urun-ekle mt-3 w-full px-4 py-3 rounded-xl bg-marka-700 text-white font-extrabold hover:bg-marka-600 transition" ' +
                    'data-id="' + u.id + '">Sepete Ekle</button>' +
          '</div>';
      }).join('') +
    '</div>';
  }

  /**
   * MATRİS (hızlı liste) modu.
   *
   * Klavye akışı: arama kutusunda Enter → ilk satırın adet kutusuna odak →
   * adet yaz → Enter → sepete eklenir ve odak aramaya döner. Böylece
   * plasiyer fareye hiç dokunmadan sipariş yazabilir.
   */
  function matrisCiz() {
    return '<div class="overflow-x-auto bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-200 dark:border-slate-700">' +
      '<table class="w-full text-left">' +
        '<thead class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">' +
          '<tr>' +
            '<th class="p-3">Ürün</th>' +
            '<th class="p-3">Koli</th>' +
            '<th class="p-3 text-right">Fiyat</th>' +
            '<th class="p-3 w-40">Adet</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' +
          gosterilenler().map(function (u, i) {
            var koli = M().koliIci(u);

            return '<tr class="matris-satir border-t border-slate-100 dark:border-slate-700">' +
              '<td class="p-3">' +
                '<div class="flex items-center gap-3">' +
                  '<div class="w-10 h-10 shrink-0 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-900 grid place-items-center">' +
                    (u.local_image_path || u.image_url
                      ? '<img src="' + kacis(u.local_image_path ? ('file://' + String(u.local_image_path).replace(/\\/g, '/')) : u.image_url) + '" alt="" loading="lazy" class="w-full h-full object-contain" />'
                      : '<span class="text-slate-300">📦</span>') +
                  '</div>' +
                  '<div class="min-w-0">' +
                    '<div class="font-bold truncate">' + (u.is_spot ? '🔥 ' : '') + kacis(u.name) + '</div>' +
                    '<div class="text-xs text-slate-500 dark:text-slate-400">' + kacis(u.sku || '') + (u.barcode ? ' · ' + kacis(u.barcode) : '') + '</div>' +
                  '</div>' +
                '</div>' +
              '</td>' +
              '<td class="p-3 text-sm font-bold">' + (koli > 1 ? koli : '—') + '</td>' +
              '<td class="p-3 text-right font-black whitespace-nowrap">' + kacis(paraYaz(u.price)) + '</td>' +
              '<td class="p-3">' +
                '<input type="number" min="1" step="' + koli + '" class="matris-adet w-28 px-3 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold text-center" ' +
                       'data-id="' + u.id + '" data-sira="' + i + '" placeholder="' + koli + '" />' +
              '</td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>' +
    '</div>';
  }

  function dahaDugmesiniCiz() {
    var kap = el('vitrinDaha');

    if (!kap) return;

    var kalan = durumV.urunler.length - durumV.sinir;

    kap.innerHTML = kalan > 0
      ? '<button type="button" id="dahaGoster" class="px-6 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
        kalan + ' ürün daha göster</button>'
      : '';

    var daha = el('dahaGoster');

    if (daha) {
      daha.addEventListener('click', function () {
        durumV.sinir += EN_COK_KART;
        vitriniCiz();
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  ÜRÜN DETAY PENCERESİ
   * ------------------------------------------------------------------ */

  function urunuBuyut(id) {
    var u = durumV.urunler.find(function (x) { return Number(x.id) === Number(id); });

    if (!u) return;

    durumV.acikUrun = u;

    var perde = el('urunPerde');
    var modal = el('urunModal');

    if (!perde || !modal) return;

    var koli = M().koliIci(u);

    modal.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div class="text-xl font-extrabold pr-2">' + (u.is_spot ? '🔥 ' : '') + kacis(u.name) + '</div>' +
        '<button type="button" id="urunKapat" class="shrink-0 w-10 h-10 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 font-bold">×</button>' +
      '</div>' +
      '<div class="mt-4 grid gap-5 sm:grid-cols-2">' +
        '<div class="relative">' + spotRozeti(u) + gorselEtiketi(u) + '</div>' +
        '<div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400">' + kacis(u.sku || '') + (u.barcode ? ' · ' + kacis(u.barcode) : '') + '</div>' +
          '<div class="mt-3 text-3xl font-black">' + kacis(paraYaz(u.price)) + '</div>' +
          '<div class="mt-3">' + koliEtiketi(u) + '</div>' +
          (null === u.stock_quantity
            ? ''
            : '<div class="mt-3 text-sm font-bold ' + (u.stock_quantity > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600') + '">Stok: ' + u.stock_quantity + '</div>') +
          (u.categories && u.categories.length
            ? '<div class="mt-3 text-sm text-slate-500 dark:text-slate-400">' + kacis(u.categories.join(', ')) + '</div>'
            : '') +
          '<div class="mt-5 flex items-center gap-2">' +
            '<button type="button" id="modalEksi" class="w-12 h-12 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-2xl font-black hover:bg-slate-100 dark:hover:bg-slate-700">−</button>' +
            '<input id="modalAdet" type="number" min="1" step="' + koli + '" value="' + koli + '" class="w-24 px-3 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-black text-center text-lg" />' +
            '<button type="button" id="modalArti" class="w-12 h-12 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-2xl font-black hover:bg-slate-100 dark:hover:bg-slate-700">+</button>' +
          '</div>' +
          '<div id="modalEtiket" class="mt-2 text-sm font-bold text-slate-600 dark:text-slate-300"></div>' +
          '<button type="button" id="modalEkle" class="mt-4 w-full px-6 py-4 rounded-xl bg-marka-700 text-white text-lg font-extrabold hover:bg-marka-600 transition">Sepete Ekle</button>' +
        '</div>' +
      '</div>';

    perde.hidden = false;
    modal.classList.remove('kapali');

    function etiketiTazele() {
      var alan = el('modalAdet');
      var etiket = el('modalEtiket');

      if (etiket && alan) etiket.textContent = M().adetEtiketi(u, alan.value);
    }

    el('urunKapat').addEventListener('click', urunuKapat);

    el('modalArti').addEventListener('click', function () {
      var alan = el('modalAdet');
      alan.value = M().adimla(u, alan.value, 1);
      etiketiTazele();
    });

    el('modalEksi').addEventListener('click', function () {
      var alan = el('modalAdet');
      alan.value = M().adimla(u, alan.value, -1);
      etiketiTazele();
    });

    el('modalAdet').addEventListener('change', etiketiTazele);

    el('modalEkle').addEventListener('click', function () {
      sepeteEkle(u.id, el('modalAdet').value);
      urunuKapat();
    });

    etiketiTazele();
  }

  function urunuKapat() {
    var perde = el('urunPerde');
    var modal = el('urunModal');

    if (modal) modal.classList.add('kapali');

    window.setTimeout(function () {
      if (perde) perde.hidden = true;
      if (modal) modal.innerHTML = '';
    }, 190);

    durumV.acikUrun = null;
  }

  /* ------------------------------------------------------------------ *
   *  SEPET
   * ------------------------------------------------------------------ */

  function urunBul(id) {
    return durumV.urunler.find(function (x) { return Number(x.id) === Number(id); }) || null;
  }

  function sepeteEkle(id, adet) {
    var u = urunBul(id);

    if (!u) return;

    M().ekle(sepet(), u, adet);

    sepetiCiz();
    bildir(kacis(u.name) + ' sepete eklendi.', 'ok');
  }

  function sepetiCiz() {
    var kap = el('sepetKutu');

    if (!kap) return;

    var s = sepet();
    var t = M().toplamlar(s, tavanAl());

    if (!s.satirlar.length) {
      kap.innerHTML =
        '<div class="text-center py-8">' +
          '<div class="text-4xl mb-3" aria-hidden="true">🧺</div>' +
          '<div class="font-bold">Sepet boş</div>' +
          '<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Ürün seçerek başlayın.</p>' +
        '</div>';
      return;
    }

    kap.innerHTML =
      '<div class="font-extrabold text-lg mb-3">Sepet <span class="text-sm font-bold text-slate-500">' + t.satir + ' kalem</span></div>' +
      s.satirlar.map(function (r) {
        return '<div class="py-3 border-t border-slate-100 dark:border-slate-700">' +
          '<div class="font-bold leading-snug">' + kacis(r.name) + '</div>' +
          '<div class="text-xs text-slate-500 dark:text-slate-400">' + kacis(r.sku || '') + '</div>' +
          '<div class="mt-2 flex items-center gap-2">' +
            '<button type="button" class="sepet-eksi w-9 h-9 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-black" data-id="' + r.id + '">−</button>' +
            '<span class="flex-1 text-center font-extrabold text-sm">' + kacis(M().adetEtiketi(r, r.adet)) + '</span>' +
            '<button type="button" class="sepet-arti w-9 h-9 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-black" data-id="' + r.id + '">+</button>' +
            '<button type="button" class="sepet-sil w-9 h-9 rounded-lg border-2 border-red-200 text-red-600 font-black" data-id="' + r.id + '" title="Kaldır">🗑</button>' +
          '</div>' +
          '<div class="mt-1 text-right font-bold">' + kacis(paraYaz(r.price * M().adediOturt(r, r.adet))) + '</div>' +
        '</div>';
      }).join('') +
      '<div class="mt-4 pt-3 border-t-2 border-slate-200 dark:border-slate-600 space-y-1">' +
        '<div class="flex justify-between text-sm"><span>Ara toplam</span><span class="font-bold">' + kacis(paraYaz(t.araToplam)) + '</span></div>' +
        (t.indirim > 0
          ? '<div class="flex justify-between text-sm text-emerald-700 dark:text-emerald-400"><span>İskonto %' + t.iskontoOrani + '</span><span class="font-bold">−' + kacis(paraYaz(t.indirim)) + '</span></div>'
          : '') +
        '<div class="flex justify-between text-lg font-black"><span>Genel</span><span>' + kacis(paraYaz(t.genelToplam)) + '</span></div>' +
        (t.koli ? '<div class="text-xs text-slate-500 dark:text-slate-400">' + t.kalem + ' adet · ' + t.koli + ' koli</div>' : '<div class="text-xs text-slate-500 dark:text-slate-400">' + t.kalem + ' adet</div>') +
      '</div>' +
      '<button type="button" id="sepetTamamla" class="mt-4 w-full px-5 py-4 rounded-xl bg-marka-700 text-white font-extrabold hover:bg-marka-600 transition">Siparişi Tamamla</button>' +
      '<button type="button" id="sepetBosalt" class="mt-2 w-full px-5 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">Sepeti Boşalt</button>';

    var tamamla = el('sepetTamamla');

    if (tamamla) {
      tamamla.addEventListener('click', function () {
        if (window.PlasiyerMusteri) window.PlasiyerMusteri.tamamlamaAc();
        else bildir('Sipariş tamamlama modülü yüklenmedi.', 'hata');
      });
    }

    var bosalt = el('sepetBosalt');

    if (bosalt) {
      bosalt.addEventListener('click', async function () {
        if ('function' === typeof window.onayla) {
          var ok = await window.onayla('Sepeti boşaltmak istediğinize emin misiniz?');
          if (!ok) return;
        }

        M().bosalt(sepet());
        sepetiCiz();
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  OLAY BAĞLAMA
   * ------------------------------------------------------------------ */

  function olaylariBagla() {
    if (bagli) return;   // sekme her açılışta çağrılır
    bagli = true;

    var menu = el('katMenuAnahtar');
    if (menu) menu.addEventListener('click', menuyuAnahtarla);

    var gorunum = el('gorunumAnahtar');
    if (gorunum) gorunum.addEventListener('click', modAnahtarla);

    var esitle = el('katalogEsitle');
    if (esitle) esitle.addEventListener('click', kataloguEsitle);

    var tum = el('tumUrunler');

    if (tum) {
      tum.addEventListener('click', function () {
        durumV.kategori = '';
        kategorileriCiz();
        urunleriGetir();
      });
    }

    /* Kategori düğmeleri her çizimde yenilendiği için DELEGASYON. */
    var katKap = el('katListe');

    if (katKap) {
      katKap.addEventListener('click', function (olay) {
        var d = olay.target.closest('.kat-dugme');

        if (!d) return;

        durumV.kategori = d.dataset.kat === durumV.kategori ? '' : d.dataset.kat;

        kategorileriCiz();
        urunleriGetir();
      });
    }

    /* Arama — 140 ms geciktirilir: her harfte IPC turu atmak gereksiz. */
    var arama = el('urunArama');

    if (arama) {
      arama.addEventListener('input', function () {
        if (aramaSaat) window.clearTimeout(aramaSaat);

        aramaSaat = window.setTimeout(function () {
          durumV.sorgu = arama.value;
          urunleriGetir();
        }, 140);
      });

      /* Enter: matris modunda ilk adet kutusuna atla (klavye akışı). */
      arama.addEventListener('keydown', function (olay) {
        if ('Enter' !== olay.key) return;

        olay.preventDefault();

        if (MATRIS !== durumV.mod) modAnahtarla();

        var ilk = document.querySelector('.matris-adet');
        if (ilk) ilk.focus();
      });
    }

    /* Vitrin delegasyonu: kart düğmeleri + matris adet kutuları. */
    var vit = el('urunVitrin');

    if (vit) {
      vit.addEventListener('click', function (olay) {
        var ekle = olay.target.closest('.urun-ekle');

        if (ekle) { sepeteEkle(ekle.dataset.id); return; }

        var buyut = olay.target.closest('.urun-buyut');
        if (buyut) urunuBuyut(buyut.dataset.id);
      });

      /* [Enter → Adet → Enter] akışı: adet kutusunda Enter sepete ekler ve
         odak aramaya döner, böylece sıradaki ürün hemen yazılabilir. */
      vit.addEventListener('keydown', function (olay) {
        if ('Enter' !== olay.key) return;

        var alan = olay.target.closest('.matris-adet');

        if (!alan) return;

        olay.preventDefault();

        sepeteEkle(alan.dataset.id, alan.value || undefined);

        alan.value = '';

        var arama2 = el('urunArama');

        if (arama2) { arama2.select(); arama2.focus(); }
      });
    }

    /* Sepet delegasyonu. */
    var sep = el('sepetKutu');

    if (sep) {
      sep.addEventListener('click', function (olay) {
        var arti = olay.target.closest('.sepet-arti');
        if (arti) { M().adimlaSatir(sepet(), arti.dataset.id, 1); sepetiCiz(); return; }

        var eksi = olay.target.closest('.sepet-eksi');
        if (eksi) { M().adimlaSatir(sepet(), eksi.dataset.id, -1); sepetiCiz(); return; }

        var sil = olay.target.closest('.sepet-sil');
        if (sil) { M().sil(sepet(), sil.dataset.id); sepetiCiz(); }
      });
    }

    /* Esc: ürün penceresini kapat. Tab: görünüm değiştir (alan dışında). */
    document.addEventListener('keydown', function (olay) {
      var perde = el('urunPerde');

      if ('Escape' === olay.key && perde && !perde.hidden) { urunuKapat(); return; }

      if ('Tab' === olay.key && 'satis' === (window.durum && window.durum.aktifSekme)) {
        var odak = document.activeElement;
        var yazilabilir = odak && /^(INPUT|TEXTAREA|SELECT)$/.test(odak.tagName);

        if (!yazilabilir && !olay.shiftKey) {
          olay.preventDefault();
          modAnahtarla();
        }
      }
    });
  }

  /* ------------------------------------------------------------------ *
   *  MEVCUT AKIŞA BAĞLANMA
   * ------------------------------------------------------------------ */

  async function sekmeyiAc() {
    olaylariBagla();

    if (!durumV.kategoriler.length) await kategorileriGetir();
    if (!durumV.urunler.length) await urunleriGetir();

    await kunyeyiTazele();

    sepetiCiz();

    if (window.PlasiyerMusteri) window.PlasiyerMusteri.seridiCiz();
  }

  function akisaBaglan() {
    if ('function' !== typeof window.sekmeAc) return;

    var ozgun = window.sekmeAc;

    window.sekmeAc = function (ad) {
      var sonuc = ozgun.apply(this, arguments);

      if ('satis' === ad) sekmeyiAc();

      return sonuc;
    };
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', akisaBaglan);
  } else {
    akisaBaglan();
  }

  window.PlasiyerVitrin = {
    sekmeyiAc: sekmeyiAc,
    sepetAl: sepetAl,
    sepetiCiz: sepetiCiz,
    urunBul: urunBul,
    tavanAl: tavanAl,
    durum: durumV,
    VITRIN: VITRIN,
    MATRIS: MATRIS,
    EN_COK_KART: EN_COK_KART
  };
})();
