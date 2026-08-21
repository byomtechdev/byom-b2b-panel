/* ============================================================================
 *  BYOM BRAIN ENTEGRASYONU — ARAYÜZ (renderer-byom.js)
 *  ---------------------------------------------------------------------------
 *  İki iş yapar:
 *
 *   1) LİSANS ROZETİ
 *      Üst çubuktaki lisans rozetini ve Ayarlar sekmesindeki "BYOM Brain
 *      Lisansı" kartını merkezî sunucudan gelen GERÇEK veriyle doldurur.
 *      renderer.js'in ustCubuguTazele fonksiyonu sarmalanır; böylece o dosyada
 *      değişiklik yapmadan rozet BYOM verisiyle güncellenir.
 *
 *   2) BYOM DESTEK SEKMESİ
 *      Müşteri masaüstünden destek talebi açar, adminin cevaplarını sohbet
 *      görünümünde okur ve yanıt yazar. Yalnızca KENDİ talepleri listelenir
 *      (istekler lisans anahtarına bağlı olarak ana süreçten gider).
 *
 *  renderer.js ve renderer-ek.js'ten SONRA yüklenir.
 * ==========================================================================*/

(function () {
  'use strict';

  const { ipcRenderer } = require('electron');

  /* renderer.js'teki genel yardımcılar. Yüklenme sırası bozulursa uygulama
     çökmesin diye hepsinin yedeği var. */
  const secDeg = function (secici) { return document.querySelector(secici); };
  const kac = typeof kacis === 'function' ? kacis : function (m) {
    return String(m === null || m === undefined ? '' : m).replace(/[&<>"']/g, function (k) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k];
    });
  };
  const uyar = function (mesaj, tur) {
    if (typeof bildir === 'function') bildir(mesaj, tur);
    else console.log('[BYOM]', tur || 'bilgi', mesaj);
  };

  /* ==========================================================================
   *  DURUM
   * ========================================================================*/

  const BYOM = window.BYOM = {
    ozet: null,              // { mod, hwid, apiUrl, lisans:{…} }
    lisans: null,            // Kısayol: ozet.lisans
    hwid: '',
    talepler: [],
    secilenTalepId: '',
    secilenTalep: null,
    suzgec: 'acik',          // acik | kapali | hepsi
    yeniOncelik: 'normal',
    oncelikler: [
      { kod: 'low', etiket: 'Düşük', simge: ikon('nokta', 'ik-nokta text-slate-400') },
      { kod: 'normal', etiket: 'Normal', simge: ikon('nokta', 'ik-nokta text-sky-500') },
      { kod: 'high', etiket: 'Yüksek', simge: ikon('nokta', 'ik-nokta text-amber-500') },
      { kod: 'urgent', etiket: 'Acil', simge: ikon('nokta', 'ik-nokta text-red-500') }
    ],
    /* Bu oturumda açılıp okunan talepler: { talepId: sonMesajZamani }.
       Liste sunucudan tazelendiğinde "yeni cevap" işareti geri gelmesin diye. */
    okunanlar: {},
    yukleniyor: false,
    detayYukleniyor: false,     // Aynı anda iki ayrıntı isteği gitmesin
    formAcik: false,
    listeYuklendi: false,
    tazelemeZaman: null,
    tazelemeAralik: 0,          // Yürürlükteki tazeleme periyodu (ms); 0 = döngü kapalı
    hizliTur: 0,                // Hızlı turlarda tam listeyi seyrek çekmek için sayaç
    sohbetImzasi: '',           // Ekranda çizili sohbetin parmak izi (gereksiz çizimi önler)
    listeImzasi: '',            // Aynısı sol talep listesi için
    suzgecImzasi: '',           // Aynısı süzgeç düğmeleri için
    sayacZaman: null
  };

  /* Sohbet tazeleme periyotları:
     – Destek sekmesi açık ama talep seçili değilse NORMAL,
     – Bir talep ekranda açıkken HIZLI (adminin cevabı canlı gibi düşsün),
     – Başka sekmedeyken döngü tamamen durur (yalnız 3 dakikalık sayaç yoklaması sürer). */
  const TAZELEME_NORMAL = 45000;
  const TAZELEME_HIZLI = 5000;
  /** Hızlı turda kaç turda bir tam liste çekilsin (5 sn × 9 ≈ 45 sn). */
  const HIZLI_TUR_LISTE = Math.max(1, Math.round(TAZELEME_NORMAL / TAZELEME_HIZLI));

  /** Talep durumlarının Türkçe karşılıkları ve renkleri. */
  const DURUM_GORUNUM = {
    open: { etiket: 'Açık', simge: ikon('nokta', 'ik-nokta'), sinif: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
    pending: { etiket: 'Yanıt Bekliyor', simge: ikon('nokta', 'ik-nokta'), sinif: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
    in_progress: { etiket: 'İnceleniyor', simge: ikon('nokta', 'ik-nokta'), sinif: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300' },
    answered: { etiket: 'Yanıtlandı', simge: ikon('nokta', 'ik-nokta'), sinif: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' },
    resolved: { etiket: 'Çözüldü', simge: ikon('onay', 'ik-sm'), sinif: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' },
    closed: { etiket: 'Kapatıldı', simge: ikon('nokta', 'ik-nokta'), sinif: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300' }
  };

  const KAPALI_DURUMLAR = ['closed', 'resolved'];

  function durumGorunumu(kod) {
    return DURUM_GORUNUM[kod] || DURUM_GORUNUM.open;
  }

  /** Talepte müşterinin görmediği yeni bir BYOM cevabı var mı? */
  function yeniCevapVarMi(talep) {
    if (!talep) return false;
    if (Number(talep.okunmamis) > 0) return true;
    if (!talep.yeniCevap) return false;
    // Aynı son mesajı bu oturumda zaten açtıysak yeni sayılmaz.
    return BYOM.okunanlar[talep.id] !== (talep.guncelleme || '');
  }

  function oncelikGorunumu(kod) {
    for (let i = 0; i < BYOM.oncelikler.length; i++) {
      if (BYOM.oncelikler[i].kod === kod) return BYOM.oncelikler[i];
    }
    return BYOM.oncelikler[1];
  }

  /* renderer.js'teki `durum` nesnesi top-level `const` ile tanımlı; window'a
     yazılmaz ama global sözlüksel kapsamda paylaşılır. Yine de dosya yüklenmemiş
     olma ihtimaline karşı güvenli erişim: */
  function aktifSekme() {
    try {
      return (typeof durum !== 'undefined' && durum) ? durum.aktifSekme : '';
    } catch (e) {
      return '';
    }
  }

  /* Destek ekranı gerçekten görünür mü? Önce DOM'a bakarız (renderer.js sekme
     gövdesine `acik` sınıfını koyar); `durum` nesnesine erişemesek bile doğru
     sonuç verir. */
  function destekEkraniAcikMi() {
    const bolum = secDeg('#sekme-destek');
    if (bolum) return bolum.classList.contains('acik');
    return aktifSekme() === 'destek';
  }

  function tarih(ham, saatli) {
    if (typeof tarihYaz === 'function') return tarihYaz(ham, saatli);
    if (!ham) return '—';
    const t = new Date(ham);
    return isNaN(t.getTime()) ? String(ham) : t.toLocaleString('tr-TR');
  }

  /* ==========================================================================
   *  BÖLÜM 1 — LİSANS ROZETİ VE AYARLAR KARTI
   * ========================================================================*/

  /** Üst çubuktaki rozeti BYOM verisiyle çizer. Veri yoksa dokunmaz. */
  function rozetiCiz() {
    const rozet = secDeg('#lisansRozet');
    if (!rozet || !BYOM.lisans || !BYOM.lisans.durum) return false;

    const l = BYOM.lisans;
    const gun = (l.kalanGun === null || l.kalanGun === undefined) ? null : Number(l.kalanGun);

    let metin;
    let sinif;

    if (l.cevrimdisi) {
      metin = 'Çevrimdışı Lisans' + (l.cevrimdisiKalanGun !== undefined ? ' — ' + l.cevrimdisiKalanGun + ' Gün' : '');
      sinif = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30';
    } else if (l.durum === 'expiring_soon' || (gun !== null && gun <= 30 && gun > 0)) {
      metin = 'BYOM Lisans — ' + (gun === null ? 'Bitmek Üzere' : gun + ' Gün Kaldı');
      sinif = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30';
    } else if (l.durum === 'active') {
      metin = 'BYOM Lisans Aktif' + (gun === null ? '' : ' — ' + gun + ' Gün');
      sinif = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30';
    } else {
      metin = 'BYOM Lisans Sorunlu';
      sinif = 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30';
    }

    rozet.innerHTML = ikon('nokta', 'ik-nokta') + ' ' + kac(metin);
    rozet.className = 'hidden sm:flex items-center gap-2 h-12 px-4 rounded-xl font-bold text-base border-2 ' + sinif;
    rozet.title = 'BYOM Brain lisansı' +
      (l.bitisTarihi ? '\nBitiş: ' + tarih(l.bitisTarihi) : '') +
      (l.sonDogrulama ? '\nSon doğrulama: ' + tarih(l.sonDogrulama, true) : '') +
      '\nDetay için Ayarlar sekmesine bakın.';
    return true;
  }

  /* renderer.js'teki ustCubuguTazele her çağrıldığında rozeti kendi yerel
     "yıllık bakım" hesabıyla yeniden yazıyor. Sarmalayıp BYOM verisini
     üstüne yazıyoruz — böylece renderer.js'e dokunmaya gerek kalmıyor. */
  if (typeof window.ustCubuguTazele === 'function') {
    const asilUstCubuguTazele = window.ustCubuguTazele;
    window.ustCubuguTazele = function () {
      const sonuc = asilUstCubuguTazele.apply(this, arguments);
      try { rozetiCiz(); } catch (e) { console.error('[BYOM] Rozet çizilemedi:', e); }
      return sonuc;
    };
  }

  /** Ayarlar sekmesindeki BYOM kartını doldurur. */
  function ayarKartiniCiz() {
    const detay = secDeg('#byomLisansDetay');
    const rozet = secDeg('#byomDurumRozeti');
    if (!detay) return;

    const l = BYOM.lisans || {};
    const durumMetni = {
      active: [ikon('nokta', 'ik-nokta') + ' Aktif', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'],
      expiring_soon: [ikon('nokta', 'ik-nokta') + ' Yakında Bitiyor', 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'],
      expired: [ikon('nokta', 'ik-nokta') + ' Süresi Doldu', 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300'],
      suspended: [ikon('yasak', 'ik-sm') + ' Askıya Alındı', 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300'],
      invalid_hwid: [ikon('ekran', 'ik-sm') + ' Donanım Uyuşmuyor', 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300'],
      not_found: [ikon('soru', 'ik-sm') + ' Bulunamadı', 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300']
    };
    const gorunum = durumMetni[l.durum] || ['Bilinmiyor', 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'];

    if (rozet) {
      rozet.innerHTML = l.cevrimdisi ? (ikon('anten', 'ik-sm') + ' Çevrimdışı') : gorunum[0];
      rozet.className = 'ml-auto text-sm font-extrabold px-3 py-1 rounded-lg ' +
        (l.cevrimdisi ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : gorunum[1]);
    }

    const satir = function (ad, deger) {
      return '<div class="flex justify-between gap-4 border-b border-slate-200 dark:border-slate-700 py-2">' +
             '<span class="font-bold shrink-0">' + kac(ad) + '</span>' +
             '<span class="text-right break-words">' + kac(deger) + '</span></div>';
    };

    let html = '';
    html += satir('Lisans Anahtarı', l.anahtarMaskeli || '—');
    html += satir('Firma', l.firmaAdi || '—');
    if (l.domain) html += satir('Domain', l.domain);
    if (l.plan) html += satir('Paket', l.plan);
    html += satir('Bitiş Tarihi', l.bitisTarihi ? tarih(l.bitisTarihi) : '—');
    html += satir('Kalan Süre', (l.kalanGun === null || l.kalanGun === undefined) ? '—' : Math.max(0, l.kalanGun) + ' gün');
    html += satir('Son Doğrulama', l.sonDogrulama ? tarih(l.sonDogrulama, true) : '—');
    if (l.cevrimdisi) {
      html += '<div class="mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 ' +
              'text-sm font-bold leading-relaxed">' + ikon('anten', 'ik-sm') +
              ' Sunucuya ulaşılamadığı için çevrimdışı izinle çalışıyorsunuz' +
              (l.cevrimdisiKalanGun !== undefined ? ' (kalan: ' + l.cevrimdisiKalanGun + ' gün)' : '') + '.</div>';
    }

    detay.innerHTML = html;

    const hwidKutu = secDeg('#byomHwid');
    if (hwidKutu) hwidKutu.textContent = BYOM.hwid || (BYOM.ozet && BYOM.ozet.hwid) || 'hesaplanıyor…';
  }

  /** BYOM Brain sunucu adresi bilgisini Ayarlar kartına yazar. */
  async function apiBilgisiniCiz() {
    const kutu = secDeg('#byomApiUrl');
    const bilgi = secDeg('#byomApiBilgi');
    if (!kutu) return;

    try {
      const veri = await ipcRenderer.invoke('byom:api-url:oku');
      if (!veri || !veri.ok) return;

      kutu.value = veri.kayitliUrl || '';
      kutu.placeholder = veri.apiUrl || '';
      kutu.disabled = veri.kaynak === 'ortam';

      const kaynakMetni = {
        ortam: 'BYOM_API_URL ortam değişkeninden geliyor; buradan değiştirilemez.',
        kullanici: 'Elle kaydedilmiş adres kullanılıyor.',
        'varsayilan-gelistirme': 'Geliştirme ortamı varsayılanı.',
        'varsayilan-uretim': 'Üretim ortamı varsayılanı.'
      };
      if (bilgi) {
        bilgi.textContent = 'Kullanılan adres: ' + (veri.apiUrl || '—') + '\n' +
          (kaynakMetni[veri.kaynak] || '') +
          ' Boş bırakılırsa ' + (veri.paketlenmis ? veri.varsayilanUretim : veri.varsayilanGelistirme) + ' kullanılır.';
      }
    } catch (e) { /* önemli değil */ }
  }

  /** Ana süreçten güncel lisans özetini çeker ve arayüzü tazeler. */
  async function lisansiTazele() {
    try {
      const ozet = await ipcRenderer.invoke('byom:durum');
      if (!ozet) return;
      BYOM.ozet = ozet;
      BYOM.lisans = ozet.lisans || {};
      BYOM.hwid = ozet.hwid || BYOM.hwid;
      ustCubuguYenidenCiz();
      ayarKartiniCiz();
      destekBasligiCiz();
    } catch (e) {
      console.error('[BYOM] Lisans durumu alınamadı:', e);
    }
  }

  /* Üst çubuğu ve Ayarlar'daki eski "Lisans & Bakım" kartını birlikte tazeler:
     kalan gün artık BYOM Brain'den geldiği için ikisi de aynı sayıyı göstermeli.
     renderer.js henüz ayarları okumadıysa (durum.ayarlar null) yalnız rozet çizilir. */
  function ustCubuguYenidenCiz() {
    try {
      if (typeof window.ustCubuguTazele === 'function' &&
          typeof durum !== 'undefined' && durum && durum.ayarlar) {
        window.ustCubuguTazele();   // Sarmalayıcı zaten rozetiCiz'i de çağırır
        return;
      }
    } catch (e) {
      console.error('[BYOM] Üst çubuk tazelenemedi:', e);
    }
    rozetiCiz();
  }

  /* --- Ana süreçten gelen bildirimler --- */

  ipcRenderer.on('byom:lisans-guncellendi', function (olay, ozet) {
    if (!ozet) return;
    BYOM.ozet = ozet;
    BYOM.lisans = ozet.lisans || {};
    BYOM.hwid = ozet.hwid || BYOM.hwid;
    ustCubuguYenidenCiz();
    ayarKartiniCiz();
    destekBasligiCiz();
  });

  ipcRenderer.on('byom:uyari', function (olay, veri) {
    if (!veri || !veri.mesaj) return;
    uyar(veri.mesaj, veri.tur || 'uyari');
  });

  /* ==========================================================================
   *  BÖLÜM 2 — BYOM DESTEK SEKMESİ
   * ========================================================================*/

  /** Sekme üstündeki lisans/firma bilgisi. */
  function destekBasligiCiz() {
    const kutu = secDeg('#destekLisansBilgi');
    if (!kutu) return;
    const l = BYOM.lisans || {};
    kutu.textContent = (l.firmaAdi ? l.firmaAdi + ' · ' : '') + (l.anahtarMaskeli || 'Lisans yok');
  }

  /** Üstteki hata/uyarı şeridi. */
  function destekUyarisi(mesaj, tur) {
    const kutu = secDeg('#destekUyari');
    if (!kutu) return;
    if (!mesaj) {
      kutu.classList.add('hidden');
      kutu.textContent = '';
      return;
    }
    const sinifiar = {
      hata: 'bg-red-50 text-red-800 border-2 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30',
      uyari: 'bg-amber-50 text-amber-800 border-2 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30',
      bilgi: 'bg-marka-50 text-marka-800 border-2 border-marka-200 dark:bg-marka-900/20 dark:text-marka-200 dark:border-marka-800'
    };
    kutu.className = 'mb-4 p-4 rounded-2xl text-lg font-bold whitespace-pre-line ' + (sinifiar[tur] || sinifiar.bilgi);
    kutu.textContent = mesaj;
    kutu.classList.remove('hidden');
  }

  /* --- Süzgeçler --- */

  const SUZGECLER = [
    { kod: 'acik', etiket: 'Açık' },
    { kod: 'kapali', etiket: 'Kapanan' },
    { kod: 'hepsi', etiket: 'Tümü' }
  ];

  function suzgecleriCiz() {
    const kap = secDeg('#destekSuzgecler');
    if (!kap) return;

    /* 5 saniyelik hızlı yoklamada düğmeler boşuna yeniden çizilmesin
       (tıklama/hover durumu ve odak bozulmasın). */
    const imza = BYOM.suzgec + '|' + SUZGECLER.map(function (s) {
      return taleplerSuzulmus(s.kod).length;
    }).join(',');
    if (imza === BYOM.suzgecImzasi) return;
    BYOM.suzgecImzasi = imza;

    kap.innerHTML = SUZGECLER.map(function (s) {
      const sayi = taleplerSuzulmus(s.kod).length;
      const aktif = s.kod === BYOM.suzgec;
      return '<button data-destek-suzgec="' + kac(s.kod) + '" ' +
        'class="h-12 rounded-xl border-2 text-base font-extrabold transition active:scale-95 ' +
        (aktif
          ? 'bg-marka-700 text-white border-marka-700 shadow'
          : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100 ' +
            'dark:bg-slate-900 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700') +
        '">' + kac(s.etiket) + ' (' + sayi + ')</button>';
    }).join('');
  }

  function taleplerSuzulmus(suzgec) {
    const kod = suzgec || BYOM.suzgec;
    return BYOM.talepler.filter(function (t) {
      const kapali = KAPALI_DURUMLAR.indexOf(t.durum) !== -1;
      if (kod === 'acik') return !kapali;
      if (kod === 'kapali') return kapali;
      return true;
    });
  }

  /* --- Talep listesi --- */

  /** Listenin parmak izi: değişmediyse DOM'a dokunulmaz. */
  function listeImzasiUret() {
    return [
      BYOM.suzgec,
      BYOM.secilenTalepId,
      (BYOM.yukleniyor && !BYOM.talepler.length) ? 'Y' : '',
      taleplerSuzulmus().map(function (t) {
        return [t.id, t.durum, t.oncelik, t.guncelleme, yeniCevapVarMi(t) ? 1 : 0].join('|');
      }).join(';')
    ].join('~');
  }

  function listeyiCiz() {
    const kap = secDeg('#destekListe');
    if (!kap) return;

    /* Arka plan tazelemesi listeyi boşuna yeniden kurmasın: içerik aynıysa
       (imza değişmediyse) kaydırma yeri ve tıklama hedefleri korunur. */
    const imza = listeImzasiUret();
    if (imza === BYOM.listeImzasi) return;
    BYOM.listeImzasi = imza;

    if (BYOM.yukleniyor && !BYOM.talepler.length) {
      kap.innerHTML = '<div class="p-6 text-center text-lg font-bold text-slate-400">' +
                      '<span class="donuyor inline-block">' + ikon('donen') + '</span><br>Talepler yükleniyor…</div>';
      return;
    }

    const liste = taleplerSuzulmus();

    if (!liste.length) {
      kap.innerHTML = '<div class="p-6 text-center text-base leading-relaxed text-slate-400">' +
        (BYOM.talepler.length
          ? 'Bu süzgeçte talep yok.'
          : 'Henüz destek talebiniz yok.<br><br>Bir sorunuz veya sorununuz olduğunda<br>' +
            '<b>YENİ DESTEK TALEBİ</b> düğmesine basın.') +
        '</div>';
      return;
    }

    kap.innerHTML = liste.map(function (t) {
      const d = durumGorunumu(t.durum);
      const o = oncelikGorunumu(t.oncelik);
      const secili = t.id === BYOM.secilenTalepId;
      const okunmamis = yeniCevapVarMi(t);

      return '<button data-talep-id="' + kac(t.id) + '" ' +
        'class="w-full text-left p-4 rounded-xl border-2 transition ' +
        (secili
          ? 'bg-marka-50 border-marka-500 dark:bg-marka-900/30 dark:border-marka-600'
          : 'bg-slate-50 border-slate-200 hover:bg-slate-100 dark:bg-slate-900/40 dark:border-slate-700 dark:hover:bg-slate-700') +
        '">' +
          '<div class="flex items-start gap-2">' +
            '<span class="text-lg shrink-0" title="' + kac(o.etiket) + ' öncelik">' + o.simge + '</span>' +
            '<span class="flex-1 font-extrabold text-base leading-snug break-words">' + kac(t.baslik) + '</span>' +
            (okunmamis ? '<span class="w-3 h-3 rounded-full bg-red-500 mt-1.5 shrink-0" title="Yeni cevap"></span>' : '') +
          '</div>' +
          '<div class="flex items-center gap-2 mt-2 flex-wrap">' +
            '<span class="text-xs font-extrabold px-2 py-1 rounded-lg ' + d.sinif + '">' + d.simge + ' ' + kac(d.etiket) + '</span>' +
            '<span class="text-xs font-bold text-slate-400">' + kac(tarih(t.guncelleme || t.olusturma, true)) + '</span>' +
            (t.numara ? '<span class="text-xs font-bold text-slate-400 ml-auto">#' + kac(t.numara) + '</span>' : '') +
          '</div>' +
        '</button>';
    }).join('');
  }

  /* --- Sohbet görünümü --- */

  /** Kullanıcı sohbetin dibine yakın mı? (Kendi eliyle yukarı kaydırdıysa yerini bozmayalım.) */
  function sohbetDipteMi(kutu) {
    if (!kutu) return true;
    return (kutu.scrollHeight - kutu.scrollTop - kutu.clientHeight) < 80;
  }

  /** Sohbeti en alta indirir. `purussuz` ise yumuşak kaydırma kullanılır. */
  function sohbetiEnAltaKaydir(purussuz) {
    const kutu = secDeg('#destekSohbet');
    if (!kutu) return;
    /* Yeni balonlar ölçülsün diye bir çizim karesi bekleriz; yoksa scrollHeight
       eski değeri döndürür ve kaydırma yarım kalır. */
    const uygula = function () {
      try {
        if (purussuz && typeof kutu.scrollTo === 'function') {
          kutu.scrollTo({ top: kutu.scrollHeight, behavior: 'smooth' });
          return;
        }
      } catch (e) { /* eski motorlarda smooth yoksa aşağıya düşer */ }
      kutu.scrollTop = kutu.scrollHeight;
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(uygula);
    else setTimeout(uygula, 0);
  }

  /** Sohbetin parmak izi: değişmediyse yeniden çizip kaydırmayı bozmaya gerek yok. */
  function sohbetImzasiUret(talep) {
    if (!talep) return '';
    const m = talep.mesajlar || [];
    const son = m.length ? m[m.length - 1] : null;
    return [
      talep.id || '',
      talep.durum || '',
      talep.guncelleme || '',
      m.length,
      son ? (son.id || '') + '|' + (son.tarih || '') + '|' + String(son.mesaj || '').length : ''
    ].join('~');
  }

  /** İmzadaki talep kimliği (talep değişimini anlamak için). */
  function imzadakiTalep(imza) {
    return String(imza || '').split('~')[0];
  }

  /**
   * Sohbet ekranını çizer.
   *   secenekler.zorlaKaydir → içerik değişmese de en alta in (talep açma, mesaj gönderme)
   *   secenekler.purussuz    → yumuşak kaydırma kullan (arka planda düşen yeni mesaj)
   */
  function sohbetiCiz(secenekler) {
    secenekler = secenekler || {};
    const baslikKutu = secDeg('#destekSohbetBaslik');
    const sohbet = secDeg('#destekSohbet');
    const yanitAlani = secDeg('#destekYanitAlani');
    if (!sohbet) return;

    // Yeni talep formu açıksa sohbet gizlenir.
    if (BYOM.formAcik) {
      if (baslikKutu) baslikKutu.classList.add('hidden');
      sohbet.classList.add('hidden');
      if (yanitAlani) yanitAlani.classList.add('hidden');
      BYOM.sohbetImzasi = '';
      return;
    }
    sohbet.classList.remove('hidden');

    const t = BYOM.secilenTalep;

    if (!t) {
      if (baslikKutu) baslikKutu.classList.add('hidden');
      if (yanitAlani) yanitAlani.classList.add('hidden');
      BYOM.sohbetImzasi = '';
      sohbet.innerHTML =
        '<div class="m-auto text-center max-w-md">' +
          '<div class="text-6xl mb-4">' + ikon('kulaklik', 'ik-xxl') + '</div>' +
          '<div class="text-2xl font-black mb-3">BYOM Destek Masası</div>' +
          '<p class="text-lg leading-relaxed text-slate-500 dark:text-slate-400">' +
            'Sol taraftan bir talep seçin ya da <b>YENİ DESTEK TALEBİ</b> ile bize yazın.<br><br>' +
            'Talepleriniz doğrudan BYOM Brain sistemine düşer; cevaplar yine bu ekranda görünür.' +
          '</p>' +
        '</div>';
      return;
    }

    const d = durumGorunumu(t.durum);
    const o = oncelikGorunumu(t.oncelik);
    const kapali = KAPALI_DURUMLAR.indexOf(t.durum) !== -1;

    if (baslikKutu) {
      baslikKutu.classList.remove('hidden');
      baslikKutu.innerHTML =
        '<div class="flex items-start gap-3 flex-wrap">' +
          '<div class="min-w-0 flex-1">' +
            '<div class="text-xl font-black break-words">' + kac(t.baslik) + '</div>' +
            '<div class="mt-2 flex items-center gap-2 flex-wrap text-sm">' +
              '<span class="font-extrabold px-2 py-1 rounded-lg ' + d.sinif + '">' + d.simge + ' ' + kac(d.etiket) + '</span>' +
              '<span class="font-bold text-slate-500 dark:text-slate-400">' + o.simge + ' ' + kac(o.etiket) + ' öncelik</span>' +
              (t.numara ? '<span class="font-bold text-slate-400">· Talep #' + kac(t.numara) + '</span>' : '') +
              '<span class="font-bold text-slate-400">· ' + kac(tarih(t.olusturma, true)) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    /* Kapatılmış talepte de yanıt kutusu açık kalır: BYOM Brain, müşteri mesaj
       yazınca talebi otomatik olarak yeniden açar (reopened). */
    if (yanitAlani) {
      yanitAlani.classList.remove('hidden');
      const ipucu = yanitAlani.querySelector('[data-yanit-ipucu]');
      if (ipucu) {
        ipucu.textContent = kapali
          ? 'Bu talep kapatıldı — yazarsanız talep yeniden açılır. (Ctrl + Enter ile de gönderebilirsiniz.)'
          : 'Ctrl + Enter ile de gönderebilirsiniz.';
      }
    }

    /* Arka plan tazelemesi ekranı boşuna yeniden çizmesin: içerik aynıysa
       (imza değişmediyse) DOM'a dokunmayız — kullanıcının kaydırma yeri,
       metin seçimi ve yumuşak kaydırma animasyonu bozulmaz. */
    const oncekiImza = BYOM.sohbetImzasi;
    const yeniImza = sohbetImzasiUret(t);
    const talepDegisti = imzadakiTalep(oncekiImza) !== String(t.id || '');
    const icerikDegisti = yeniImza !== oncekiImza;
    const dipteydi = sohbetDipteMi(sohbet);
    const eskiKaydirma = sohbet.scrollTop;

    if (!icerikDegisti && !secenekler.zorlaKaydir) return;

    const mesajlar = t.mesajlar || [];
    if (!mesajlar.length) {
      sohbet.innerHTML = '<div class="m-auto text-lg text-slate-400">Bu talepte henüz mesaj yok.</div>';
      BYOM.sohbetImzasi = yeniImza;
    } else {
      sohbet.innerHTML = mesajlar.map(function (m) {
        const adminMi = m.gonderen === 'admin';
        const balon = adminMi
          ? 'bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-tl-sm'
          : 'bg-marka-700 text-white rounded-tr-sm';
        const hiza = adminMi ? 'items-start' : 'items-end';
        const adSimgesi = adminMi ? ikon('kulaklik', 'ik-sm') : ikon('kisi', 'ik-sm');
        const ad = adminMi ? (m.ad || 'BYOM Destek') : (m.ad || 'Siz');

        return '<div class="flex flex-col ' + hiza + ' gap-1">' +
          '<div class="text-xs font-extrabold text-slate-500 dark:text-slate-400 px-1">' +
            adSimgesi + ' ' + kac(ad) + '</div>' +
          '<div class="max-w-[85%] px-5 py-4 rounded-2xl text-lg leading-relaxed whitespace-pre-line break-words shadow-sm ' + balon + '">' +
            kac(m.mesaj) +
          '</div>' +
          '<div class="text-xs text-slate-400 px-1">' + kac(tarih(m.tarih, true)) + '</div>' +
        '</div>';
      }).join('');
      BYOM.sohbetImzasi = yeniImza;

      /* AKILLI KAYDIRMA
         – Talep yeni açıldıysa / kullanıcı mesaj gönderdiyse: anında en alta.
         – Arka planda yeni mesaj düştüyse ve kullanıcı zaten dipteyse: pürüzsüzce en alta.
         – Kullanıcı geçmişi okumak için yukarı kaydırmışsa: yerini koru, sadece haber ver. */
      if (secenekler.zorlaKaydir || talepDegisti || !oncekiImza) {
        sohbetiEnAltaKaydir(false);
      } else if (dipteydi) {
        sohbetiEnAltaKaydir(secenekler.purussuz !== false);
      } else {
        sohbet.scrollTop = eskiKaydirma;
        const son = mesajlar[mesajlar.length - 1];
        if (son && son.gonderen === 'admin') uyar('Bu talebe yeni bir cevap düştü.', 'bilgi');
      }
    }
  }

  /* --- Yeni talep formu --- */

  function oncelikleriCiz() {
    const kap = secDeg('#destekOncelikler');
    if (!kap) return;
    kap.innerHTML = BYOM.oncelikler.map(function (o) {
      const aktif = o.kod === BYOM.yeniOncelik;
      return '<button type="button" data-oncelik="' + kac(o.kod) + '" ' +
        'class="h-14 rounded-xl border-2 text-base font-extrabold transition active:scale-95 ' +
        (aktif
          ? 'bg-marka-700 text-white border-marka-700 shadow'
          : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100 ' +
            'dark:bg-slate-900 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700') +
        '">' + o.simge + ' ' + kac(o.etiket) + '</button>';
    }).join('');
  }

  function formuAc() {
    BYOM.formAcik = true;
    BYOM.secilenTalepId = '';
    BYOM.secilenTalep = null;
    oncelikleriCiz();
    const form = secDeg('#destekYeniForm');
    if (form) form.classList.remove('hidden');
    sohbetiCiz();
    listeyiCiz();
    tazelemeDongusunuAyarla();   // Sohbet kapandı: hızlı yoklamaya gerek yok
    setTimeout(function () {
      const baslik = secDeg('#destekBaslik');
      if (baslik) baslik.focus();
    }, 60);
  }

  function formuKapat(temizle) {
    BYOM.formAcik = false;
    const form = secDeg('#destekYeniForm');
    if (form) form.classList.add('hidden');
    if (temizle) {
      const b = secDeg('#destekBaslik');
      const m = secDeg('#destekMesaj');
      if (b) b.value = '';
      if (m) m.value = '';
      BYOM.yeniOncelik = 'normal';
    }
    sohbetiCiz({ zorlaKaydir: true });
    tazelemeDongusunuAyarla();
  }

  /* --- Sunucu işlemleri --- */

  /** Talep listesini çeker. */
  async function taleplariYukle(sessiz) {
    if (BYOM.yukleniyor) return;
    BYOM.yukleniyor = true;
    if (!sessiz) listeyiCiz();

    try {
      const sonuc = await ipcRenderer.invoke('byom:destek:liste');

      if (!sonuc || !sonuc.ok) {
        if (!sessiz) {
          destekUyarisi((sonuc && sonuc.hata) || 'Destek talepleri alınamadı.', sonuc && sonuc.agSorunu ? 'uyari' : 'hata');
        }
        return;
      }

      destekUyarisi('');
      BYOM.talepler = sonuc.talepler || [];
      BYOM.listeYuklendi = true;

      // Seçili talep listeden düştüyse seçimi bırak
      if (BYOM.secilenTalepId && !BYOM.talepler.some(function (t) { return t.id === BYOM.secilenTalepId; })) {
        BYOM.secilenTalepId = '';
        BYOM.secilenTalep = null;
        tazelemeDongusunuAyarla();   // Açık talep kalmadı: hızlı moddan çık
      }

      suzgecleriCiz();
      listeyiCiz();
      sayaciTazele();

      /* Açık talepte hareket varsa sohbeti de arka planda tazele. */
      if (acikTalepteYenilikVarMi()) sohbetiTazele({ sessiz: true });
    } catch (e) {
      if (!sessiz) destekUyarisi('Destek talepleri alınamadı: ' + ((e && e.message) || e), 'hata');
    } finally {
      BYOM.yukleniyor = false;
      if (!sessiz) listeyiCiz();
    }
  }

  /**
   * AÇIK TALEBİN MESAJ GEÇMİŞİNİ TAZELER.
   *
   * Hem kullanıcı soldan bir talebe tıkladığında, hem de arka plandaki yoklama
   * çalıştığında aynı yol kullanılır. `sessiz` modda ekranda "Yükleniyor…" gibi
   * bir şey görünmez; sohbet yalnızca gerçekten değiştiyse yeniden çizilir.
   *
   *   secenekler.id           → tazelenecek talep (yoksa açık olan talep)
   *   secenekler.sessiz       → arka plan tazelemesi: yükleniyor ekranı ve hata şeridi yok
   *   secenekler.zorlaKaydir  → çizimden sonra koşulsuz en alta in
   */
  async function sohbetiTazele(secenekler) {
    secenekler = secenekler || {};
    const id = String(secenekler.id || BYOM.secilenTalepId || '');
    if (!id) return false;

    /* Arka plan yoklamaları üst üste binmesin; kullanıcının kendi isteği
       (talebe tıklama, mesaj gönderme) ise beklemeden geçer. */
    if (BYOM.detayYukleniyor && secenekler.sessiz) return false;
    BYOM.detayYukleniyor = true;

    try {
      const sonuc = await ipcRenderer.invoke('byom:destek:detay', { id: id });

      // Cevap gelene kadar kullanıcı başka talebe/forma geçtiyse ekranı bozma.
      if (BYOM.secilenTalepId !== id || BYOM.formAcik) return false;

      if (!sonuc || !sonuc.ok) {
        if (!secenekler.sessiz) {
          destekUyarisi((sonuc && sonuc.hata) || 'Talep açılamadı.', sonuc && sonuc.agSorunu ? 'uyari' : 'hata');
          // Ayrıntı gelmezse hiç değilse listedeki özet gösterilsin
          BYOM.secilenTalep = BYOM.talepler.filter(function (t) { return t.id === id; })[0] || null;
          sohbetiCiz({ zorlaKaydir: true });
        }
        return false;
      }

      if (!secenekler.sessiz) destekUyarisi('');
      BYOM.secilenTalep = sonuc.talep;

      // Talep okundu: bu son mesaja kadar "yeni cevap" işareti gösterilmesin.
      BYOM.okunanlar[id] = sonuc.talep.guncelleme || '';

      // Listedeki kaydı da tazele (talep okundu: sayaç ve "yeni cevap" işareti sıfırlanır)
      BYOM.talepler = BYOM.talepler.map(function (t) {
        return t.id === id
          ? Object.assign({}, t, {
              durum: sonuc.talep.durum,
              guncelleme: sonuc.talep.guncelleme || t.guncelleme,
              okunmamis: 0,
              yeniCevap: false
            })
          : t;
      });

      suzgecleriCiz();
      listeyiCiz();
      sohbetiCiz({ zorlaKaydir: !!secenekler.zorlaKaydir, purussuz: true });
      sayaciTazele();
      return true;
    } catch (e) {
      if (!secenekler.sessiz) destekUyarisi('Talep açılamadı: ' + ((e && e.message) || e), 'hata');
      return false;
    } finally {
      BYOM.detayYukleniyor = false;
    }
  }

  /** Bir talebin ayrıntısını (mesaj geçmişiyle) açar. */
  async function talebiAc(id, sessiz) {
    if (!id) return;
    const degisti = BYOM.secilenTalepId !== id;
    BYOM.secilenTalepId = id;
    BYOM.formAcik = false;
    const form = secDeg('#destekYeniForm');
    if (form) form.classList.add('hidden');

    if (!sessiz) {
      const sohbet = secDeg('#destekSohbet');
      if (sohbet) {
        sohbet.classList.remove('hidden');
        sohbet.innerHTML = '<div class="m-auto text-lg font-bold text-slate-400">' +
                           '<span class="donuyor inline-block">' + ikon('donen') + '</span> Yükleniyor…</div>';
        // Ekrandaki içerik artık sohbet değil: imzayı sıfırla ki yeniden çizilsin.
        BYOM.sohbetImzasi = '';
      }
      listeyiCiz();
    }

    /* Talep ekranda açıldı: yoklama hızlı moda geçsin. */
    if (degisti) tazelemeDongusunuAyarla();

    await sohbetiTazele({ id: id, sessiz: !!sessiz, zorlaKaydir: !sessiz });
  }

  /** Yeni talep gönderir. */
  async function talepGonder() {
    const btn = secDeg('#destekGonderBtn');
    const baslik = (secDeg('#destekBaslik') || {}).value || '';
    const mesaj = (secDeg('#destekMesaj') || {}).value || '';

    if (baslik.trim().length < 3) {
      uyar('Lütfen bir konu başlığı yazın (en az 3 karakter).', 'uyari');
      const b = secDeg('#destekBaslik'); if (b) b.focus();
      return;
    }
    if (mesaj.trim().length < 10) {
      uyar('Sorununuzu biraz daha ayrıntılı anlatın (en az 10 karakter).', 'uyari');
      const m = secDeg('#destekMesaj'); if (m) m.focus();
      return;
    }

    const eskiMetin = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'GÖNDERİLİYOR…'; }

    try {
      const sonuc = await ipcRenderer.invoke('byom:destek:olustur', {
        baslik: baslik.trim(),
        mesaj: mesaj.trim(),
        oncelik: BYOM.yeniOncelik
      });

      if (!sonuc || !sonuc.ok) {
        uyar((sonuc && sonuc.hata) || 'Destek talebi gönderilemedi.', 'hata');
        return;
      }

      uyar('Destek talebiniz BYOM ekibine iletildi.\nCevap geldiğinde bu ekranda görebileceksiniz.', 'basari');
      formuKapat(true);
      await taleplariYukle(true);

      const yeniId = sonuc.talep && sonuc.talep.id;
      if (yeniId) await talebiAc(yeniId);
      else { suzgecleriCiz(); listeyiCiz(); }
    } catch (e) {
      uyar('Destek talebi gönderilemedi: ' + ((e && e.message) || e), 'hata');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = eskiMetin || 'TALEBİ GÖNDER'; }
    }
  }

  /** Açık talebe yanıt yazar. */
  async function yanitGonder() {
    const kutu = secDeg('#destekYanitMetni');
    const btn = secDeg('#destekYanitGonderBtn');
    const metin = kutu ? kutu.value.trim() : '';

    if (!BYOM.secilenTalepId) return;
    if (metin.length < 2) {
      uyar('Mesaj boş olamaz.', 'uyari');
      if (kutu) kutu.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = ''; }

    try {
      const sonuc = await ipcRenderer.invoke('byom:destek:yanit', { id: BYOM.secilenTalepId, mesaj: metin });

      if (!sonuc || !sonuc.ok) {
        uyar((sonuc && sonuc.hata) || 'Mesaj gönderilemedi.', 'hata');
        return;
      }

      if (kutu) kutu.value = '';
      // Kendi mesajımız: sohbeti tazele ve koşulsuz en alta in.
      await sohbetiTazele({ id: BYOM.secilenTalepId, sessiz: true, zorlaKaydir: true });
      uyar('Mesajınız iletildi.', 'basari');
    } catch (e) {
      uyar('Mesaj gönderilemedi: ' + ((e && e.message) || e), 'hata');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'GÖNDER'; }
    }
  }

  /* Talebi KAPATMA müşteride değil, BYOM ekibindedir (sunucuda müşteriye açık
     bir kapatma ucu yoktur). Müşteri kapalı bir talebe yazarsa sunucu talebi
     kendiliğinden yeniden açar. */

  /** Sol menüdeki kırmızı sayaç: BYOM'un cevap yazdığı, henüz okunmamış talepler. */
  function sayaciTazele() {
    const sayac = secDeg('#destekSayaci');
    if (!sayac) return;

    const adet = BYOM.talepler.filter(yeniCevapVarMi).length;

    sayac.textContent = String(adet);
    sayac.classList.toggle('hidden', adet === 0);
  }

  /** Açık talebin listedeki kaydı, ekrandaki sohbetten daha yeni mi? */
  function acikTalepteYenilikVarMi() {
    if (!BYOM.secilenTalepId || BYOM.formAcik) return false;
    const listedeki = BYOM.talepler.filter(function (t) { return t.id === BYOM.secilenTalepId; })[0];
    if (!listedeki) return false;
    const ekrandaki = BYOM.secilenTalep || {};
    return String(listedeki.guncelleme || '') !== String(ekrandaki.guncelleme || '') ||
           String(listedeki.durum || '') !== String(ekrandaki.durum || '') ||
           yeniCevapVarMi(listedeki);
  }

  /** Arka planda (sekme kapalıyken de) yeni cevap var mı diye bakar. */
  async function sayacIcinYokla() {
    if (!BYOM.lisans || !BYOM.lisans.lisansAnahtari) return;
    try {
      const sonuc = await ipcRenderer.invoke('byom:destek:liste');
      if (sonuc && sonuc.ok) {
        BYOM.talepler = sonuc.talepler || [];
        BYOM.listeYuklendi = true;
        sayaciTazele();
        if (destekEkraniAcikMi()) {
          suzgecleriCiz();
          listeyiCiz();
        }
        /* Kullanıcı bir talebi açık tutuyorsa ve o talepte hareket varsa,
           soldan yeniden tıklamasını beklemeden sohbeti tazele. */
        if (acikTalepteYenilikVarMi()) {
          sohbetiTazele({ sessiz: true });
        }
      }
    } catch (e) { /* sessiz */ }
  }

  /* ==========================================================================
   *  BÖLÜM 3 — OLAY BAĞLANTILARI
   * ========================================================================*/

  function destekOlaylariniBagla() {
    const yenileBtn = secDeg('#destekYenileBtn');
    if (yenileBtn) {
      yenileBtn.addEventListener('click', async function () {
        await taleplariYukle(false);
        // Elle yenilemede açık sohbet de koşulsuz tazelensin.
        if (BYOM.secilenTalepId && !BYOM.formAcik) await sohbetiTazele({ sessiz: true });
      });
    }

    const yeniBtn = secDeg('#destekYeniBtn');
    if (yeniBtn) yeniBtn.addEventListener('click', formuAc);

    const vazgecBtn = secDeg('#destekVazgecBtn');
    if (vazgecBtn) vazgecBtn.addEventListener('click', function () { formuKapat(false); });

    const gonderBtn = secDeg('#destekGonderBtn');
    if (gonderBtn) gonderBtn.addEventListener('click', talepGonder);

    const yanitBtn = secDeg('#destekYanitGonderBtn');
    if (yanitBtn) yanitBtn.addEventListener('click', yanitGonder);

    const yanitKutu = secDeg('#destekYanitMetni');
    if (yanitKutu) {
      yanitKutu.addEventListener('keydown', function (o) {
        if (o.key === 'Enter' && (o.ctrlKey || o.metaKey)) {
          o.preventDefault();
          yanitGonder();
        }
      });
    }

    const liste = secDeg('#destekListe');
    if (liste) {
      liste.addEventListener('click', function (o) {
        const btn = o.target.closest('[data-talep-id]');
        if (btn) talebiAc(btn.dataset.talepId);
      });
    }

    const suzgecKap = secDeg('#destekSuzgecler');
    if (suzgecKap) {
      suzgecKap.addEventListener('click', function (o) {
        const btn = o.target.closest('[data-destek-suzgec]');
        if (!btn) return;
        BYOM.suzgec = btn.dataset.destekSuzgec;
        suzgecleriCiz();
        listeyiCiz();
      });
    }

    const oncelikKap = secDeg('#destekOncelikler');
    if (oncelikKap) {
      oncelikKap.addEventListener('click', function (o) {
        const btn = o.target.closest('[data-oncelik]');
        if (!btn) return;
        BYOM.yeniOncelik = btn.dataset.oncelik;
        oncelikleriCiz();
      });
    }
  }

  function ayarOlaylariniBagla() {
    const kopyaBtn = secDeg('#byomHwidKopyaBtn');
    if (kopyaBtn) {
      kopyaBtn.addEventListener('click', async function () {
        const hwid = BYOM.hwid || '';
        if (!hwid) return;
        await ipcRenderer.invoke('byom:panoya-kopyala', hwid);
        uyar('Donanım kimliği panoya kopyalandı.\nDestek ekibiyle paylaşabilirsiniz.', 'basari');
      });
    }

    const kontrolBtn = secDeg('#byomKontrolBtn');
    if (kontrolBtn) {
      kontrolBtn.addEventListener('click', async function () {
        kontrolBtn.disabled = true;
        const eski = kontrolBtn.textContent;
        kontrolBtn.textContent = 'KONTROL EDİLİYOR…';
        try {
          const sonuc = await ipcRenderer.invoke('byom:yeniden-dogrula', { sessiz: true });
          await lisansiTazele();
          if (sonuc && sonuc.ok) {
            uyar('Lisansınız BYOM Brain üzerinde doğrulandı.', 'basari');
          } else {
            uyar((sonuc && sonuc.hata) || 'Lisans kontrolü tamamlanamadı.', 'uyari');
          }
        } finally {
          kontrolBtn.disabled = false;
          kontrolBtn.textContent = eski;
        }
      });
    }

    const kaydetBtn = secDeg('#byomApiKaydetBtn');
    if (kaydetBtn) {
      kaydetBtn.addEventListener('click', async function () {
        const kutu = secDeg('#byomApiUrl');
        const sonuc = await ipcRenderer.invoke('byom:api-url:yaz', { apiUrl: kutu ? kutu.value.trim() : '' });
        if (sonuc && sonuc.ok) {
          uyar('BYOM Brain adresi kaydedildi:\n' + sonuc.apiUrl, 'basari');
          apiBilgisiniCiz();
        } else {
          uyar((sonuc && sonuc.hata) || 'Adres kaydedilemedi.', 'hata');
        }
      });
    }

    const testBtn = secDeg('#byomApiTestBtn');
    if (testBtn) {
      testBtn.addEventListener('click', async function () {
        testBtn.disabled = true;
        const eski = testBtn.textContent;
        testBtn.textContent = 'TEST EDİLİYOR…';
        try {
          const sonuc = await ipcRenderer.invoke('byom:baglanti-testi');
          if (sonuc && sonuc.ok) uyar(sonuc.mesaj + '\n' + sonuc.apiUrl, 'basari');
          else uyar(((sonuc && sonuc.hata) || 'Bağlanılamadı.'), 'hata');
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = eski;
        }
      });
    }

    const destekGitBtn = secDeg('#byomDestekGitBtn');
    if (destekGitBtn) {
      destekGitBtn.addEventListener('click', function () {
        if (typeof window.sekmeAc === 'function') window.sekmeAc('destek');
        setTimeout(formuAc, 200);
      });
    }
  }

  /* ==========================================================================
   *  BÖLÜM 4 — SEKME KANCASI VE BAŞLANGIÇ
   * ========================================================================*/

  /* --- Tazeleme döngüsü (uyarlanabilir hız) ------------------------------- */

  /** Şu anki duruma göre olması gereken yoklama periyodu (0 = döngü kapalı). */
  function istenenTazelemeAraligi() {
    if (!destekEkraniAcikMi()) return 0;                  // Başka sekmede: yalnız 3 dk'lık sayaç yoklaması
    if (BYOM.formAcik) return TAZELEME_NORMAL;            // Yeni talep yazılıyor
    if (BYOM.secilenTalepId) return TAZELEME_HIZLI;       // Sohbet ekranda: canlı gibi
    return TAZELEME_NORMAL;
  }

  /** Bir yoklama turu. */
  async function tazelemeTuru() {
    if (!destekEkraniAcikMi()) { tazelemeDongusunuAyarla(); return; }
    if (typeof document.hidden === 'boolean' && document.hidden) return;  // Pencere gizliyken istek atma
    if (BYOM.formAcik) return;                                            // Yazarken ekran altından kaymasın

    if (BYOM.secilenTalepId) {
      // Hızlı tur: önce sohbet. Tam liste her turda değil, ~45 saniyede bir.
      await sohbetiTazele({ sessiz: true });
      BYOM.hizliTur = (BYOM.hizliTur + 1) % HIZLI_TUR_LISTE;
      if (BYOM.hizliTur === 0) taleplariYukle(true);
    } else {
      BYOM.hizliTur = 0;
      taleplariYukle(true);
    }
  }

  /**
   * Yoklama periyodunu duruma göre kurar/değiştirir.
   * Aynı periyot zaten yürürlükteyse zamanlayıcıya dokunmaz (sayaç sıfırlanmasın).
   */
  function tazelemeDongusunuAyarla() {
    const istenen = istenenTazelemeAraligi();
    if (istenen === BYOM.tazelemeAralik) return;

    BYOM.tazelemeAralik = istenen;
    if (BYOM.tazelemeZaman) { clearInterval(BYOM.tazelemeZaman); BYOM.tazelemeZaman = null; }
    if (!istenen) return;

    BYOM.hizliTur = 0;
    BYOM.tazelemeZaman = setInterval(function () {
      tazelemeTuru().catch(function () { /* sessiz */ });
    }, istenen);
  }

  /** Destek sekmesi açıldığında ilk yükleme + tazeleme döngüsü. */
  function destekSekmesiAcildi() {
    destekBasligiCiz();
    suzgecleriCiz();
    listeyiCiz();
    sohbetiCiz({ zorlaKaydir: true });
    oncelikleriCiz();

    if (!BYOM.listeYuklendi) taleplariYukle(false);
    else taleplariYukle(true);

    // Sekmeye dönüldüğünde açık sohbet hemen tazelensin (beklemeden).
    if (BYOM.secilenTalepId && !BYOM.formAcik) sohbetiTazele({ sessiz: true });

    tazelemeDongusunuAyarla();
  }

  /* sekmeAc renderer.js'te tanımlı; sarmalayıp 'destek' sekmesini ekliyoruz. */
  if (typeof window.sekmeAc === 'function') {
    const asilSekmeAc = window.sekmeAc;
    window.sekmeAc = function (ad) {
      const sonuc = asilSekmeAc.apply(this, arguments);
      try {
        if (ad === 'destek') destekSekmesiAcildi();
        else tazelemeDongusunuAyarla();   // Başka sekmeye geçildi: hızlı yoklamayı durdur
      } catch (e) {
        console.error('[BYOM] Destek sekmesi açılamadı:', e);
      }
      return sonuc;
    };
  }

  /* Pencere arka plana atılınca boşuna istek atmayalım; öne gelince açık
     sohbeti ve listeyi hemen tazeleyelim (5 sn'lik turu beklemeden). */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (!destekEkraniAcikMi()) return;
    tazelemeDongusunuAyarla();
    if (BYOM.formAcik) return;
    taleplariYukle(true);
    if (BYOM.secilenTalepId) sohbetiTazele({ sessiz: true });
  });

  /* Ana süreç ileride "yeni mesaj var" sinyali gönderirse (webContents.send),
     yoklamayı beklemeden anında tazeleriz. Sinyal yoksa da bir şey bozulmaz. */
  ['byom:destek:yeni-mesaj', 'byom:destek:guncellendi'].forEach(function (kanal) {
    ipcRenderer.on(kanal, function (olay, veri) {
      const id = veri && (veri.talepId || veri.id);
      taleplariYukle(true);
      if (BYOM.formAcik) return;
      // Sinyal açık talebe aitse (ya da hangi talep olduğu belirtilmemişse) sohbeti tazele.
      if (BYOM.secilenTalepId && (!id || String(id) === BYOM.secilenTalepId)) {
        sohbetiTazele({ sessiz: true });
      }
    });
  });

  /** Alt+6 → BYOM Destek (renderer.js Alt+1..5'i kullanıyor). */
  document.addEventListener('keydown', function (o) {
    if (o.altKey && o.key === '6') {
      if (typeof window.sekmeAc === 'function') window.sekmeAc('destek');
    }
  });

  /** Açılış. renderer.js'in baslat() akışından SONRA çalışsın diye küçük gecikme. */
  async function baslatBYOM() {
    destekOlaylariniBagla();
    ayarOlaylariniBagla();
    oncelikleriCiz();
    suzgecleriCiz();
    listeyiCiz();
    sohbetiCiz();

    await lisansiTazele();
    apiBilgisiniCiz();

    // Donanım kimliği ana süreçten gelmediyse doğrudan iste.
    if (!BYOM.hwid) {
      try {
        const bilgi = await ipcRenderer.invoke('byom:hwid');
        if (bilgi && bilgi.ok) {
          BYOM.hwid = bilgi.hwid;
          ayarKartiniCiz();
        }
      } catch (e) { /* önemli değil */ }
    }

    // Sol menüdeki cevap sayacı için ilk yoklama ve 3 dakikalık döngü.
    sayacIcinYokla();
    if (BYOM.sayacZaman) clearInterval(BYOM.sayacZaman);
    BYOM.sayacZaman = setInterval(sayacIcinYokla, 180000);

    // Uygulama doğrudan destek sekmesinde açıldıysa döngü hemen kurulsun.
    tazelemeDongusunuAyarla();
  }

  document.addEventListener('DOMContentLoaded', function () {
    // renderer.js'in baslat() işi bitsin, ondan sonra rozeti/ekranı tazeleyelim.
    setTimeout(function () {
      baslatBYOM().catch(function (e) { console.error('[BYOM] Başlatma hatası:', e); });
    }, 300);
  });

  // Dışarıdan (Ayarlar kartındaki düğme gibi) çağrılabilsin.
  window.byomDestekSekmesiniAc = function () {
    if (typeof window.sekmeAc === 'function') window.sekmeAc('destek');
  };
  window.byomLisansiTazele = lisansiTazele;
})();
