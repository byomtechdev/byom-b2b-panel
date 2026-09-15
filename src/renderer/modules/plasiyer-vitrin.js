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
 *  GÖRÜNÜM KİPLERİ: üst bardaki "Vitrin Görünümü" düğmesi KALDIRILDI (Faz 13,
 *  ürün sahibinin kararı). Matris kipi duruyor ve iki yoldan açılıyor:
 *    · arama kutusunda Enter  · alan dışında Tab
 *    vitrin → büyük kart, yerel diskten net görsel, koli + liste fiyatı
 *    matris → kompakt satır, küçük resim, [Enter → Adet → Enter] akışı
 *  Düğme gidince kısayol keşfedilemez olmasın diye filtre barına KALICI bir
 *  ipucu basılır (`kipIpucu`) — yoksa matrise geçen kullanıcı vitrine
 *  dönemez.
 *
 *  PERFORMANS: liste `EN_COK_KART` ile kırpılır ve "Daha Göster" ile büyür.
 *  5.000 kartı birden basmak Electron'da ilk boyamayı saniyelere çıkarırdı.
 *
 *  SAYFALAMA (Faz 13): `katalog:ara` en çok `SAYFA` (500) kayıt döner ama
 *  `toplam` alanıyla kaç kalem olduğunu da söyler. "Daha Göster" ekrandaki
 *  sınırı büyütür; sınır yüklü kayıtları aşarsa SONRAKİ SAYFA çekilir (yine
 *  yerel indeksten, AĞA ÇIKMADAN). Eskiden dizi 500'de bittiği için alfabetik
 *  501. ürüne filtresiz gezinmeyle asla ulaşılamıyordu.
 * ==========================================================================*/

'use strict';

(function () {

  /** Tek seferde basılan en çok kart/satır. */
  var EN_COK_KART = 60;

  /** Tek IPC turunda istenen en çok kayıt (depo tarafındaki kırpma sınırı). */
  var SAYFA = 500;

  /** Görünüm modları. */
  var VITRIN = 'vitrin';
  var MATRIS = 'matris';

  var durumV = {
    mod: VITRIN,
    kategori: '',
    sorgu: '',
    sinir: EN_COK_KART,
    urunler: [],
    /* Süzgeçten geçen KIRPILMAMIŞ kalem sayısı — "1111 kalem" bundan yazılır. */
    toplam: 0,
    /* Son çekilen sayfanın başlangıcı (tanı ve sonraki sayfa isteği için). */
    ofset: 0,
    /* Katalogdaki toplam ürün (`katalog:durum`) — "1111 kaleminde 37 sonuç". */
    katalogToplam: 0,
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

  /**
   * Sayıyı güvenli okur; geçersizse yedeğe düşer.
   *
   * Eski bir ana süreçle (yanıtta `toplam` alanı yok) çalışıldığında liste
   * "0 kalem" demesin diye: bilinmiyorsa elimizdeki uzunluk doğrudur.
   */
  function sayiOku(deger, yedek) {
    var n = Number(deger);

    return isFinite(n) && n >= 0 ? n : yedek;
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

  /**
   * İLK SAYFAYI çeker (süzgeç değiştiğinde). AĞA ÇIKMAZ — `katalog:ara`
   * ana süreçteki yerel indekse gider.
   */
  async function urunleriGetir() {
    var cevap = await ipcRenderer.invoke('katalog:ara', {
      sorgu: durumV.sorgu,
      kategori: durumV.kategori,
      adet: SAYFA,
      ofset: 0
    });

    durumV.urunler = (cevap && cevap.urunler) || [];
    durumV.ofset = 0;
    durumV.toplam = sayiOku(cevap && cevap.toplam, durumV.urunler.length);
    durumV.sinir = EN_COK_KART;

    vitriniCiz();
    filtreEtiketiniCiz();
  }

  /**
   * SONRAKİ SAYFAYI ekler (yine yerel indeksten).
   *
   * "Daha Göster" sınırı yüklü kayıtların ötesine taşıdığında çağrılır.
   * Boş yanıt gelirse `toplam` elimizdekine çekilir: aksi hâlde düğme
   * sonsuza kadar "N ürün daha göster" der ve hiçbir şey gelmezdi.
   */
  async function sonrakiSayfa() {
    var cevap = await ipcRenderer.invoke('katalog:ara', {
      sorgu: durumV.sorgu,
      kategori: durumV.kategori,
      adet: SAYFA,
      ofset: durumV.urunler.length
    });

    var gelen = (cevap && cevap.urunler) || [];

    if (!gelen.length) {
      durumV.toplam = durumV.urunler.length;
      filtreEtiketiniCiz();
      return;
    }

    durumV.ofset = durumV.urunler.length;
    durumV.urunler = durumV.urunler.concat(gelen);
    durumV.toplam = sayiOku(cevap && cevap.toplam, durumV.urunler.length);

    filtreEtiketiniCiz();
  }

  async function kunyeyiTazele() {
    var cevap = await ipcRenderer.invoke('katalog:durum');

    var k = (cevap && cevap.durum) || {};
    var g = (cevap && cevap.gorsel) || {};

    /* Katalogdaki GERÇEK kalem sayısı. Filtre etiketi "1111 kaleminde 37
       sonuç" derken bunu kullanır; ekrandaki dizi kırpılmış olabilir ve
       kullanıcının "sistem yarım mı çekiyor?" sorusu tam buradan doğmuştu. */
    durumV.katalogToplam = Number(k.urun) || 0;

    filtreEtiketiniCiz();

    var kutu = el('katalogKunye');

    if (!kutu) return;

    var zaman = k.sonGuncelleme
      ? 'son eşitleme ' + new Date(k.sonGuncelleme).toLocaleString('tr-TR')
      : 'hiç eşitlenmedi';

    kutu.textContent = 'Katalogda ' + (k.urun || 0) + ' ürün · ' + zaman +
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

  /**
   * KİP İPUCU — "Vitrin Görünümü" düğmesi kaldırıldığı için (Faz 13) matris
   * kipinin klavye kısayolu keşfedilemez olmasın diye filtre barında KALICI
   * olarak durur. Matristeyken metin geri dönüş yolunu söyler; yoksa kullanıcı
   * hızlı listeye geçtikten sonra vitrine dönemez.
   */
  function kipIpucu() {
    return '<span class="ml-3 text-xs font-semibold text-slate-400 dark:text-slate-500" ' +
                 'title="Hızlı liste (matris) kipi: arama kutusunda Enter, alan dışında Tab">' +
      (MATRIS === durumV.mod ? '⌨️ Hızlı liste · Tab: vitrine dön' : 'Tab: hızlı liste') +
    '</span>';
  }

  /**
   * Aktif filtreyi gösteren dinamik etiket.
   *
   * SAYILAR KIRPILMAMIŞ OLANDIR (Faz 13): ekrandaki dizi 500'de bitse bile
   * etiket gerçek kalem sayısını yazar. Ürün sahibinin şikâyeti tam buydu —
   * solda "500 kalem", sağ üstte "1111 ürün" yazınca sistem yarım çekiyor
   * sanılıyordu. Kırpma varsa ikinci satır bunu AÇIKÇA söyler.
   */
  function filtreEtiketiniCiz() {
    var kutu = el('filtreEtiket');

    if (!kutu) return;

    var yuklu = durumV.urunler.length;
    var toplam = Math.max(sayiOku(durumV.toplam, yuklu), yuklu);
    var katalog = durumV.katalogToplam || toplam;

    /* Elimizdeki dizi süzgeç sonucunun tamamı değilse kullanıcı uyarılır. */
    var uyari = yuklu < toplam
      ? '<div class="w-full text-xs font-semibold text-amber-600 dark:text-amber-400">ilk ' + yuklu +
        ' gösteriliyor — arama ile daraltın</div>'
      : '';

    var parcalar = [];

    if (durumV.kategori) parcalar.push(kacis(durumV.kategori));
    if (durumV.sorgu) parcalar.push('“' + kacis(durumV.sorgu) + '”');

    if (!parcalar.length) {
      kutu.innerHTML = '<span class="text-slate-500 dark:text-slate-400">Tüm ürünler · ' +
        toplam + ' kalem</span>' + kipIpucu() + uyari;
      return;
    }

    kutu.innerHTML =
      '<span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-marka-700 text-white font-bold">' +
        'Filtre: ' + parcalar.join(' &gt; ') +
        '<button type="button" id="filtreTemizle" class="ml-1 px-2 rounded-lg bg-white/20 hover:bg-white/30 font-black" ' +
                'title="Filtreyi temizle">✕ Temizle</button>' +
      '</span>' +
      '<span class="ml-3 text-slate-500 dark:text-slate-400">' + katalog + ' kaleminde ' + toplam + ' sonuç</span>' +
      kipIpucu() + uyari;

    var temizle = el('filtreTemizle');

    if (temizle) {
      temizle.addEventListener('click', function () {
        durumV.kategori = '';
        durumV.sorgu = '';

        var arama = el('satisArama');
        if (arama) arama.value = '';

        kategorileriCiz();
        urunleriGetir();
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  GÖRÜNÜM
   * ------------------------------------------------------------------ */

  /**
   * Vitrin ↔ matris kipi.
   *
   * Tetikleyiciler: arama kutusunda Enter, alan dışında Tab. Üst bardaki
   * "Vitrin Görünümü" düğmesi kaldırıldığı için (Faz 13) burada artık düğme
   * etiketi güncellenmez; kullanıcıya kipi ve dönüş yolunu filtre barındaki
   * kalıcı ipucu söyler — bu yüzden etiket de yeniden çizilir.
   */
  function modAnahtarla() {
    durumV.mod = (VITRIN === durumV.mod) ? MATRIS : VITRIN;

    vitriniCiz();
    filtreEtiketiniCiz();
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

  /**
   * FİYAT ETİKETİ (Faz 9) — müşteri seçiliyse BİLEŞİK NET fiyat.
   *
   * Net = Liste × (1 − bayi/100) × (1 − ödeme/100) — formül motorda
   * (`PlasiyerSiparisMotor.netFiyat`), burada yalnızca basılır. Müşteri
   * seçili değilken liste fiyatı gösterilir: müşterisiz "net" diye bir şey
   * yoktur. Liste fiyatı çizili küçük yazıyla kalır ki plasiyer sahada
   * "listede şu, size şu" diyebilsin.
   */
  function netFiyati(u) {
    var s = sepet();

    if (!s.musteri) return null;

    return M().netFiyat(u.price, s.iskonto, s.odemeIskonto);
  }

  /**
   * ÜRÜN KOD/BARKOD — tek kaynak.
   *
   * Kart, matris satırı ve ürün detay penceresi bu fonksiyonu çağırır; kalıp
   * eskiden üç yerde tekrarlanıyordu ve kart yalnızca SKU basıyordu: SKU'su
   * olmayan üründe ekranda BOŞ BİR SATIR kalıyor, barkod hiç görünmüyordu.
   * Sahada ürün çoğu kez barkodundan okunur.
   *
   * @param {object} u Ürün kaydı.
   * @returns {string} 'SKU', 'barkod', 'SKU · barkod' ya da '-'.
   */
  function kodBarkod(u) {
    var sku = String((u && u.sku) || '').trim();
    var barkod = String((u && u.barcode) || '').trim();

    if (sku && barkod) return sku + ' · ' + barkod;

    return sku || barkod || '-';
  }

  /**
   * Fiyat etiketi.
   *
   * "onek" verilirse metin "Fiyat : " ile başlar (ürün sahibinin istediği kart
   * düzeni). NET/liste MANTIĞI DEĞİŞMEDİ: müşteri seçiliyken yeşil net fiyat
   * ve üstü çizili liste fiyatı aynen basılır (bileşik iskonto sözü).
   */
  function fiyatHtml(u, sinif, onek) {
    var net = netFiyati(u);
    var bas = onek ? 'Fiyat : ' : '';

    if (null === net || net === (Number(u.price) || 0)) {
      return '<div class="' + sinif + '">' + bas + kacis(paraYaz(u.price)) + '</div>';
    }

    return '<div class="' + sinif + ' text-emerald-700 dark:text-emerald-400">' + bas + kacis(paraYaz(net)) +
      ' <span class="ml-1 text-xs font-bold text-slate-400 line-through">' + kacis(paraYaz(u.price)) + '</span></div>';
  }

  function spotRozeti(u) {
    return u.is_spot ? '<span class="spot-rozet">🔥 SPOT / FIRSAT</span>' : '';
  }

  /**
   * Satış birimi rozeti.
   *
   * "yalniz_koli" sunucudan gelir (_byom_only_box) ve depo kaydında artık
   * saklanıyor. "Koli: 24 adet" ile "Sadece koli: 24 adet" farklı sözlerdir:
   * ikincisinde bayi tekil alamaz ve plasiyerin bunu müşterinin karşısında
   * bilmesi gerekir.
   */
  function koliEtiketi(u) {
    var koli = M().koliIci(u);
    var yalniz = !!(u && u.yalniz_koli);
    var vurgu = 'px-2 py-1 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-xs font-extrabold';

    if (koli > 1) {
      return '<span class="' + vurgu + '">' + (yalniz ? 'Sadece koli: ' : 'Koli: ') + koli + ' adet</span>';
    }

    if (yalniz) return '<span class="' + vurgu + '">Sadece koli</span>';

    return '<span class="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300 text-xs font-bold">Tekil satış</span>';
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
            /* ÜRÜN SAHİBİNİN İSTEDİĞİ SIRA: görsel → ad → kod/barkod →
               (rozet + fiyat aynı satırda). */
            '<div class="mt-3 font-extrabold leading-snug line-clamp-2" title="' + kacis(u.name) + '">' + kacis(u.name) + '</div>' +
            '<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">Ürün Kod/Barkod : ' + kacis(kodBarkod(u)) + '</div>' +
            '<div class="mt-2 flex items-center justify-between gap-2 flex-wrap">' +
              koliEtiketi(u) +
              fiyatHtml(u, 'text-lg font-black', true) +
            '</div>' +
            /* HIZLI ADET (Faz 10 — Görsel 4): kartta doğrudan sayı yazılır;
               −/+ koli katlarında ilerler, Enter ya da "Sepete Ekle" yazılan
               adedi sepete koyar (motor koli katına YUKARI tamamlar). */
            '<div class="mt-3 flex items-center gap-1">' +
              '<button type="button" class="hizli-eksi w-9 h-9 shrink-0 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-black" data-id="' + u.id + '" aria-label="Azalt">−</button>' +
              '<input type="number" min="1" step="' + M().koliIci(u) + '" value="' + M().koliIci(u) + '" data-id="' + u.id + '" ' +
                     'class="hizli-adet-input flex-1 min-w-0 px-2 py-2 rounded-lg border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 font-black text-center" ' +
                     'aria-label="Adet" title="Adet yazın; koli katına tamamlanır" />' +
              '<button type="button" class="hizli-arti w-9 h-9 shrink-0 rounded-lg border-2 border-slate-200 dark:border-slate-600 font-black" data-id="' + u.id + '" aria-label="Artır">+</button>' +
            '</div>' +
            '<button type="button" class="urun-ekle mt-2 w-full px-4 py-3 rounded-xl bg-marka-700 text-white font-extrabold hover:bg-marka-600 transition" ' +
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
                    '<div class="text-xs text-slate-500 dark:text-slate-400">' + kacis(kodBarkod(u)) + '</div>' +
                  '</div>' +
                '</div>' +
              '</td>' +
              '<td class="p-3 text-sm font-bold">' + (koli > 1 ? koli : '—') + '</td>' +
              '<td class="p-3 text-right whitespace-nowrap">' + fiyatHtml(u, 'font-black') + '</td>' +
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

  /**
   * "Daha Göster" düğmesi.
   *
   * Kalan sayısı EKRANDAKİ diziye değil SÜZGECİN TOPLAMINA göre hesaplanır:
   * yüklü kayıtlar bittiğinde düğme sonraki sayfayı çeker (yerel indeks, ağ
   * yok). Eskiden sınır büyüse de dizi 500'de bittiği için 501. ürün
   * erişilemezdi.
   */
  function dahaDugmesiniCiz() {
    var kap = el('vitrinDaha');

    if (!kap) return;

    var yuklu = durumV.urunler.length;
    var toplam = Math.max(sayiOku(durumV.toplam, yuklu), yuklu);
    var kalan = toplam - Math.min(durumV.sinir, yuklu);

    kap.innerHTML = kalan > 0
      ? '<button type="button" id="dahaGoster" class="px-6 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 transition">' +
        kalan + ' ürün daha göster</button>'
      : '';

    var daha = el('dahaGoster');

    if (daha) {
      daha.addEventListener('click', async function () {
        daha.disabled = true;
        durumV.sinir += EN_COK_KART;

        /* Sınır yüklü kayıtları aştıysa sıradaki sayfa gerekir. */
        if (durumV.sinir > durumV.urunler.length && durumV.urunler.length < durumV.toplam) {
          await sonrakiSayfa();
        }

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
          '<div class="text-sm text-slate-500 dark:text-slate-400">Ürün Kod/Barkod : ' + kacis(kodBarkod(u)) + '</div>' +
          fiyatHtml(u, 'mt-3 text-3xl font-black', true) +
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

  /** Karttaki hızlı adet kutusu (varsa). */
  function hizliKutu(id) {
    var vit = el('urunVitrin');

    return vit ? vit.querySelector('.hizli-adet-input[data-id="' + String(id) + '"]') : null;
  }

  /** Kutudaki değer — boş/geçersizse undefined (motor bir koli/adet varsayar). */
  function hizliAdet(id) {
    var kutu = hizliKutu(id);
    var n = kutu ? Number(kutu.value) : NaN;

    return isFinite(n) && n > 0 ? n : undefined;
  }

  function sepeteEkle(id, adet) {
    var u = urunBul(id);

    if (!u) return;

    var oncekiSatir = M().satirBul(sepet(), u.id);
    var onceki = -1 === oncekiSatir ? 0 : Number(sepet().satirlar[oncekiSatir].adet) || 0;

    M().ekle(sepet(), u, adet);

    var yeniSatir = M().satirBul(sepet(), u.id);
    var eklenen = (-1 === yeniSatir ? 0 : Number(sepet().satirlar[yeniSatir].adet) || 0) - onceki;

    /* Kutu bir sonraki ürün için birime döner. */
    var kutu = hizliKutu(u.id);
    if (kutu) kutu.value = M().koliIci(u);

    sepetiCiz();
    bildir(kacis(u.name) + ' sepete eklendi: ' + kacis(M().adetEtiketi(u, eklenen)) + '.', 'ok');
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
          '<div class="mt-1 text-right font-bold">' +
            kacis(paraYaz(M().netFiyat(r.price, s.iskonto, s.odemeIskonto) * M().adediOturt(r, r.adet))) +
          '</div>' +
        '</div>';
      }).join('') +
      '<div class="mt-4 pt-3 border-t-2 border-slate-200 dark:border-slate-600 space-y-1">' +
        '<div class="flex justify-between text-sm"><span>Ara toplam</span><span class="font-bold">' + kacis(paraYaz(t.araToplam)) + '</span></div>' +
        (t.indirim > 0
          ? '<div class="flex justify-between text-sm text-emerald-700 dark:text-emerald-400"><span>Bayi iskontosu %' + t.iskontoOrani + '</span><span class="font-bold">−' + kacis(paraYaz(t.indirim)) + '</span></div>'
          : '') +
        (t.odemeIndirim > 0
          ? '<div class="flex justify-between text-sm text-emerald-700 dark:text-emerald-400"><span>' + kacis(M().ODEME_ETIKET[s.odeme] || 'Ödeme') + ' iskontosu %' + t.odemeIskontoOrani + '</span><span class="font-bold">−' + kacis(paraYaz(t.odemeIndirim)) + '</span></div>'
          : '') +
        '<div class="flex justify-between text-lg font-black"><span>Net</span><span>' + kacis(paraYaz(t.genelToplam)) + '</span></div>' +
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

    /* "Vitrin Görünümü" düğmesi işaretlemeden kaldırıldı (Faz 13); bağlanacak
       düğüm yok. Kip değişimi Enter ve Tab ile yapılır (aşağıda). */

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
    var arama = el('satisArama');

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

        if (ekle) { sepeteEkle(ekle.dataset.id, hizliAdet(ekle.dataset.id)); return; }

        /* −/+ : karttaki adet kutusunu koli katlarında ilerletir (sepete eklemez). */
        var adim = olay.target.closest('.hizli-arti, .hizli-eksi');

        if (adim) {
          var kutu = hizliKutu(adim.dataset.id);
          var urun = urunBul(adim.dataset.id);

          if (kutu && urun) {
            kutu.value = M().adimla(urun, kutu.value, adim.classList.contains('hizli-arti') ? 1 : -1);
          }

          return;
        }

        var buyut = olay.target.closest('.urun-buyut');
        if (buyut) urunuBuyut(buyut.dataset.id);
      });

      /* Adet kutusunda Enter → sepete ekle (klavye akışı). */
      vit.addEventListener('keydown', function (olay) {
        if ('Enter' !== olay.key) return;

        var kutu = olay.target.closest('.hizli-adet-input');

        if (!kutu) return;

        olay.preventDefault();
        sepeteEkle(kutu.dataset.id, kutu.value || undefined);
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

        var arama2 = el('satisArama');

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

  /**
   * Verilen ürün kimliklerini YEREL KATALOGDAN çözer (Faz 12-B).
   *
   * `urunBul` yalnızca ekranda duran `durumV.urunler` dizisine bakar; o dizi
   * Katalog & Satış sekmesi hiç açılmadıysa BOŞTUR, açıldıysa da o anki
   * arama/kategori süzgeciyle ve 500 kayıtla sınırlıdır. "Tekrar Sipariş"
   * bu diziden çözdüğü için katalog yüklenmeden basıldığında bütün kalemler
   * "katalogda bulunamadı" oluyor ve sepete SIFIR kalem giriyordu.
   *
   * `katalog:urun` ekrandan bağımsız, AĞA ÇIKMAYAN yerel indeksi okur.
   *
   * @param {Array<number>} idler Ürün kimlikleri.
   * @returns {Promise<Object>} kimlik -> ürün eşlemesi.
   */
  async function urunleriCoz(idler) {
    var harita = {};

    for (var i = 0; i < (idler || []).length; i++) {
      var id = Number(idler[i]) || 0;

      if (!id || harita[id]) continue;

      var u = urunBul(id);

      if (u) { harita[id] = u; continue; }

      var cevap = null;

      try { cevap = await ipcRenderer.invoke('katalog:urun', { id: id }); } catch (e) { cevap = null; }

      if (cevap && cevap.urun) harita[id] = cevap.urun;
    }

    return harita;
  }

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
    kodBarkod: kodBarkod,
    urunleriGetir: urunleriGetir,
    filtreEtiketiniCiz: filtreEtiketiniCiz,
    sepetAl: sepetAl,
    sepetiCiz: sepetiCiz,
    vitriniCiz: vitriniCiz,
    netFiyati: netFiyati,
    sepeteEkle: sepeteEkle,
    hizliAdet: hizliAdet,
    urunBul: urunBul,
    urunleriCoz: urunleriCoz,
    tavanAl: tavanAl,
    durum: durumV,
    VITRIN: VITRIN,
    MATRIS: MATRIS,
    EN_COK_KART: EN_COK_KART
  };
})();
