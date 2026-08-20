/* ============================================================================
 *  BYOM LİSANS EKRANI — ARAYÜZ MANTIĞI
 *  ---------------------------------------------------------------------------
 *  Üç ekran tek pencerede yönetilir:
 *     kontrol    → açılış kontrolü (splash)
 *     aktivasyon → lisans anahtarı / firma / domain girişi
 *     kilit      → süresi dolmuş, askıya alınmış, HWID uyuşmayan lisans
 *
 *  Ana süreç hangi ekranın gösterileceğini 'byom:ekran' olayıyla bildirir.
 * ==========================================================================*/

'use strict';

const { ipcRenderer } = require('electron');

const $ = function (secici) { return document.querySelector(secici); };
const $$ = function (secici) { return Array.prototype.slice.call(document.querySelectorAll(secici)); };

/* ==========================================================================
 *  YARDIMCILAR
 * ========================================================================*/

function kacis(metin) {
  return String(metin === null || metin === undefined ? '' : metin).replace(/[&<>"']/g, function (k) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k];
  });
}

function goster(oge, gorunsun) {
  if (!oge) return;
  oge.classList.toggle('gizli', !gorunsun);
}

/** Bir kutuya mesaj yazar. tur: hata | uyari | bilgi | basari */
function mesajYaz(oge, metin, tur) {
  if (!oge) return;
  if (!metin) {
    goster(oge, false);
    oge.textContent = '';
    return;
  }
  oge.className = 'kutu kutu-' + (tur || 'bilgi');
  oge.textContent = metin;
  goster(oge, true);
}

function tarihYaz(ham) {
  if (!ham) return '—';
  const t = new Date(String(ham).length <= 10 ? ham + 'T00:00:00' : ham);
  if (isNaN(t.getTime())) return String(ham);
  return new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(t);
}

/* ==========================================================================
 *  EKRAN GEÇİŞİ
 * ========================================================================*/

const durum = { mod: 'kontrol', ozet: null, hwid: '' };

function ekraniAc(mod) {
  durum.mod = mod;
  goster($('#ekranKontrol'), mod === 'kontrol');
  goster($('#ekranAktivasyon'), mod === 'aktivasyon');
  goster($('#ekranKilit'), mod === 'kilit');
  // İletişim kartı yalnızca kilit ekranında anlamlı.
  goster($('#iletisimKart'), mod === 'kilit');
}

/** Donanım kimliğini ekranlardaki kutulara yazar. */
function hwidYaz(ozet) {
  const hwid = (ozet && ozet.hwid) || durum.hwid || '';
  durum.hwid = hwid;

  const aktivasyonKutu = $('#hwidAktivasyon');
  const kilitKutu = $('#hwidKilit');
  if (aktivasyonKutu) aktivasyonKutu.textContent = hwid || 'hesaplanıyor…';
  if (kilitKutu) kilitKutu.textContent = hwid || '—';

  const uyari = $('#hwidUyari');
  if (uyari) {
    uyari.textContent = (ozet && ozet.hwid && ozet.hwidGuclu === false)
      ? 'Not: Bu bilgisayarda donanım seri numaraları okunamadı; kimlik sistem bilgilerinden üretildi. ' +
        'Ana kart veya ağ kartı değişirse lisansın yeniden tanımlanması gerekebilir.'
      : '';
  }
}

/** Aktivasyon ekranındaki alanları önceki bilgilerle doldurur. */
function aktivasyonuHazirla(ozet) {
  if (!ozet) return;
  const lisans = ozet.lisans || {};
  if (lisans.firmaAdi && !$('#firmaAdi').value) $('#firmaAdi').value = lisans.firmaAdi;
  if (lisans.domain && !$('#domain').value) $('#domain').value = lisans.domain;
  setTimeout(function () { $('#lisansAnahtari').focus(); }, 120);
}

/** Kilit ekranını doldurur. */
function kilidiCiz(veri) {
  const ozet = veri.ozet || durum.ozet || {};
  const lisans = ozet.lisans || {};

  const simgeler = {
    expired: '⌛', suspended: '⛔', invalid_hwid: '🖥️',
    not_found: '❓', baglanti: '📡', bilinmiyor: '⚠️'
  };
  $('#kilitSimge').textContent = simgeler[veri.sebep] || '🔒';
  $('#kilitBaslik').textContent = veri.baslik || 'Lisans doğrulanamadı';
  $('#kilitAciklama').textContent = veri.aciklama || '';

  const rozet = $('#kilitRozet');
  if (veri.sebep === 'baglanti') {
    rozet.textContent = 'BAĞLANTI YOK';
    rozet.className = 'rozet rozet-sari';
  } else {
    rozet.textContent = 'UYGULAMA KİLİTLİ';
    rozet.className = 'rozet rozet-kirmizi';
  }

  mesajYaz($('#kilitEkMesaj'), veri.ekMesaj || '', veri.sebep === 'baglanti' ? 'uyari' : 'hata');

  const satirlar = [];
  if (lisans.anahtarMaskeli) satirlar.push(['Lisans Anahtarı', lisans.anahtarMaskeli]);
  if (lisans.firmaAdi) satirlar.push(['Firma', lisans.firmaAdi]);
  if (lisans.domain) satirlar.push(['Domain', lisans.domain]);
  if (lisans.bitisTarihi) satirlar.push(['Bitiş Tarihi', tarihYaz(lisans.bitisTarihi)]);
  if (lisans.sonDogrulama) satirlar.push(['Son Başarılı Doğrulama', tarihYaz(lisans.sonDogrulama)]);
  satirlar.push(['Sunucu', ozet.apiUrl || '—']);

  $('#kilitDetay').innerHTML = satirlar.map(function (s) {
    return '<div class="satir"><span class="ad">' + kacis(s[0]) + '</span>' +
           '<span class="deger">' + kacis(s[1]) + '</span></div>';
  }).join('');

  // Bağlantı hatasında "farklı lisans gir" yanıltıcı olur; gizlenir.
  goster($('#lisansDegistirBtn'), veri.sebep !== 'baglanti');

  /* Destek formunun konusunu kilit sebebine göre hazır doldur. Sunucuya
     ulaşılamıyorsa talep de gönderilemeyeceği için form gizlenir. */
  const konular = {
    expired: 'Lisans yenileme talebi',
    suspended: 'Lisansım donduruldu — bilgi talebi',
    revoked: 'Lisansım iptal edilmiş — bilgi talebi',
    invalid_hwid: 'Lisansın yeni bilgisayara taşınması talebi',
    not_found: 'Lisans anahtarım tanınmıyor'
  };
  const konuKutu = $('#kilitDestekBaslik');
  if (konuKutu && !konuKutu.value) konuKutu.value = konular[veri.sebep] || 'Lisans sorunu';

  const destekBaslik = document.querySelector('[data-gelismis="kilitDestekGovde"]');
  const destekGovde = $('#kilitDestekGovde');
  const gonderilebilir = veri.sebep !== 'baglanti';
  goster(destekBaslik, gonderilebilir);
  if (!gonderilebilir) goster(destekGovde, false);
}

/* ==========================================================================
 *  ANA SÜREÇTEN GELEN EKRAN BİLDİRİMLERİ
 * ========================================================================*/

ipcRenderer.on('byom:ekran', function (olay, veri) {
  veri = veri || {};
  if (veri.ozet) {
    durum.ozet = veri.ozet;
    hwidYaz(veri.ozet);
  }

  if (veri.mod === 'kontrol') {
    $('#kontrolAdim').textContent = veri.adim || 'Kontrol ediliyor…';
    ekraniAc('kontrol');
    return;
  }

  if (veri.mod === 'aktivasyon') {
    ekraniAc('aktivasyon');
    aktivasyonuHazirla(veri.ozet || durum.ozet);

    /* Lisans kayıtlı ama cihaza mühürlenmemişse (status: not_activated)
       anahtar hazır gelir; kullanıcının tek yapacağı onaylamaktır. */
    if (veri.acikAnahtar) $('#lisansAnahtari').value = veri.acikAnahtar;

    if (veri.bilgiMesaji) {
      mesajYaz($('#aktivasyonMesaj'), veri.bilgiMesaji, 'bilgi');
    } else if (veri.bozukKayit) {
      mesajYaz($('#aktivasyonMesaj'),
        'Kayıtlı lisans dosyası okunamadı (bozulmuş ya da başka bir bilgisayardan kopyalanmış).\n' +
        'Lütfen lisans anahtarınızı yeniden girin.', 'uyari');
    }
    hwidBilgisiniGetir();
    apiBilgisiniGetir();
    return;
  }

  if (veri.mod === 'kilit') {
    ekraniAc('kilit');
    kilidiCiz(veri);
    hwidBilgisiniGetir();
  }
});

/* ==========================================================================
 *  ANA SÜREÇTEN VERİ ÇEKME
 * ========================================================================*/

async function hwidBilgisiniGetir() {
  try {
    const sonuc = await ipcRenderer.invoke('byom:hwid');
    if (sonuc && sonuc.ok) {
      hwidYaz({ hwid: sonuc.hwid, hwidGuclu: sonuc.guclu });
    }
  } catch (e) { /* kimliği ana süreç zaten ekran verisiyle göndermiş olabilir */ }
}

async function apiBilgisiniGetir() {
  try {
    const bilgi = await ipcRenderer.invoke('byom:api-url:oku');
    if (!bilgi || !bilgi.ok) return;

    $('#apiUrl').value = bilgi.kayitliUrl || '';
    $('#apiUrl').placeholder = bilgi.apiUrl || '';

    const kaynakMetni = {
      ortam: 'BYOM_API_URL ortam değişkeninden geliyor (elle değiştirilemez).',
      kullanici: 'Elle kaydedilmiş adres kullanılıyor.',
      'varsayilan-gelistirme': 'Geliştirme ortamı varsayılanı kullanılıyor.',
      'varsayilan-uretim': 'Üretim ortamı varsayılanı kullanılıyor.'
    };
    $('#apiUrlBilgi').textContent =
      'Şu an kullanılan: ' + (bilgi.apiUrl || '—') + '\n' +
      (kaynakMetni[bilgi.kaynak] || '') +
      ' Boş bırakırsanız ' + (bilgi.paketlenmis ? bilgi.varsayilanUretim : bilgi.varsayilanGelistirme) + ' kullanılır.';

    $('#apiUrl').disabled = bilgi.kaynak === 'ortam';
    $('#apiKaydetBtn').disabled = bilgi.kaynak === 'ortam';
  } catch (e) { /* önemli değil */ }
}

/* ==========================================================================
 *  OLAYLAR
 * ========================================================================*/

/** Kopyala düğmeleri (data-kopyala="hedefId"). */
$$('[data-kopyala]').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    const hedef = document.getElementById(btn.dataset.kopyala);
    const metin = hedef ? hedef.textContent.trim() : '';
    if (!metin || metin === '—' || metin === 'hesaplanıyor…') return;

    await ipcRenderer.invoke('byom:panoya-kopyala', metin);
    const eski = btn.textContent;
    btn.textContent = '✅ KOPYALANDI';
    setTimeout(function () { btn.textContent = eski; }, 1600);
  });
});

/** Katlanır bölümleri aç/kapa (gelişmiş ayarlar, kilit ekranı destek formu…). */
$$('[data-gelismis]').forEach(function (baslik) {
  baslik.addEventListener('click', function () {
    const govde = document.getElementById(baslik.dataset.gelismis);
    if (!govde) return;
    const acik = govde.classList.contains('gizli');
    goster(govde, acik);
    const ok = baslik.querySelector('[data-ok]');
    if (ok) ok.textContent = acik ? '▾' : '▸';
  });
});

/** İletişim bağlantıları varsayılan uygulamada açılır. */
$$('[data-baglanti]').forEach(function (bag) {
  bag.addEventListener('click', function (olay) {
    olay.preventDefault();
    ipcRenderer.invoke('byom:dis-baglanti', bag.dataset.baglanti);
  });
});

/* --- Aktivasyon --- */

async function aktivasyonuGonder() {
  const btn = $('#aktiveBtn');
  const anahtar = $('#lisansAnahtari').value.trim();
  const firmaAdi = $('#firmaAdi').value.trim();
  const domain = $('#domain').value.trim();

  if (!anahtar) {
    mesajYaz($('#aktivasyonMesaj'), 'Lisans anahtarını girin.', 'hata');
    $('#lisansAnahtari').focus();
    return;
  }
  if (!firmaAdi) {
    mesajYaz($('#aktivasyonMesaj'), 'Firma adını girin.', 'hata');
    $('#firmaAdi').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ DOĞRULANIYOR…';
  mesajYaz($('#aktivasyonMesaj'), '', 'bilgi');

  try {
    const sonuc = await ipcRenderer.invoke('byom:aktive', {
      lisansAnahtari: anahtar,
      firmaAdi: firmaAdi,
      domain: domain
    });

    if (sonuc && sonuc.ok) {
      mesajYaz($('#aktivasyonMesaj'), '✅ Lisansınız etkinleştirildi. Uygulama açılıyor…', 'basari');
      btn.textContent = '✅ ETKİNLEŞTİRİLDİ';
      setTimeout(function () { ipcRenderer.invoke('byom:uygulamayi-ac'); }, 900);
      return;
    }

    const baslik = sonuc && sonuc.baslik ? sonuc.baslik + '\n\n' : '';
    mesajYaz($('#aktivasyonMesaj'),
      baslik + ((sonuc && sonuc.hata) || 'Lisans etkinleştirilemedi.'),
      sonuc && sonuc.agSorunu ? 'uyari' : 'hata');
  } catch (e) {
    mesajYaz($('#aktivasyonMesaj'), 'Beklenmeyen hata: ' + ((e && e.message) || e), 'hata');
  } finally {
    if (btn.textContent !== '✅ ETKİNLEŞTİRİLDİ') {
      btn.disabled = false;
      btn.textContent = '🚀 LİSANSI ETKİNLEŞTİR';
    }
  }
}

$('#aktiveBtn').addEventListener('click', aktivasyonuGonder);

// Anahtar alanında Enter → doğrudan etkinleştir
$$('#lisansAnahtari, #firmaAdi, #domain').forEach(function (girdi) {
  girdi.addEventListener('keydown', function (olay) {
    if (olay.key === 'Enter') aktivasyonuGonder();
  });
});

// Anahtar okunaklı olsun: harfler büyütülür, baştaki/sondaki boşluk atılır
$('#lisansAnahtari').addEventListener('input', function () {
  const kutu = $('#lisansAnahtari');
  const konum = kutu.selectionStart;
  kutu.value = kutu.value.toUpperCase().replace(/\s+/g, '');
  kutu.setSelectionRange(konum, konum);
});

/* --- Sunucu adresi --- */

$('#apiKaydetBtn').addEventListener('click', async function () {
  const sonuc = await ipcRenderer.invoke('byom:api-url:yaz', { apiUrl: $('#apiUrl').value.trim() });
  if (sonuc && sonuc.ok) {
    mesajYaz($('#apiMesaj'), 'Adres kaydedildi: ' + sonuc.apiUrl, 'basari');
    apiBilgisiniGetir();
  } else {
    mesajYaz($('#apiMesaj'), (sonuc && sonuc.hata) || 'Adres kaydedilemedi.', 'hata');
  }
});

$('#apiTestBtn').addEventListener('click', async function () {
  const btn = $('#apiTestBtn');
  btn.disabled = true;
  btn.textContent = 'TEST EDİLİYOR…';
  mesajYaz($('#apiMesaj'), '', 'bilgi');

  try {
    const sonuc = await ipcRenderer.invoke('byom:baglanti-testi');
    mesajYaz($('#apiMesaj'),
      (sonuc && sonuc.ok ? '✅ ' + sonuc.mesaj : '❌ ' + ((sonuc && sonuc.hata) || 'Bağlanılamadı.')) +
      '\nAdres: ' + ((sonuc && sonuc.apiUrl) || '—'),
      sonuc && sonuc.ok ? 'basari' : 'hata');
  } finally {
    btn.disabled = false;
    btn.textContent = 'BAĞLANTIYI TEST ET';
  }
});

/* --- Kilit ekranı düğmeleri --- */

$('#tekrarDeneBtn').addEventListener('click', async function () {
  const btn = $('#tekrarDeneBtn');
  btn.disabled = true;
  btn.textContent = '⏳ KONTROL EDİLİYOR…';
  try {
    await ipcRenderer.invoke('byom:yeniden-dogrula', { sessiz: false });
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 TEKRAR DENE';
  }
});

$('#lisansDegistirBtn').addEventListener('click', async function () {
  await ipcRenderer.invoke('byom:lisans-sil');
  $('#lisansAnahtari').value = '';
  mesajYaz($('#aktivasyonMesaj'), '', 'bilgi');
});

/* --- Kilit ekranından destek talebi --- */

$('#kilitDestekGonderBtn').addEventListener('click', async function () {
  const btn = $('#kilitDestekGonderBtn');
  const baslik = $('#kilitDestekBaslik').value.trim();
  const metin = $('#kilitDestekMetni').value.trim();

  if (baslik.length < 3) {
    mesajYaz($('#kilitDestekMesaj'), 'Konu başlığı yazın (en az 3 karakter).', 'hata');
    $('#kilitDestekBaslik').focus();
    return;
  }
  if (metin.length < 10) {
    mesajYaz($('#kilitDestekMesaj'), 'Durumunuzu biraz daha ayrıntılı yazın (en az 10 karakter).', 'hata');
    $('#kilitDestekMetni').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ GÖNDERİLİYOR…';
  mesajYaz($('#kilitDestekMesaj'), '', 'bilgi');

  try {
    /* Kilit sebebi ve donanım kimliği mesaja eklenir; destek ekibi telefonda
       tekrar sormak zorunda kalmasın. */
    const ekBilgi = '\n\n---\nKilit sebebi: ' + (durum.mod === 'kilit' ? ($('#kilitBaslik').textContent || '-') : '-') +
                    '\nDonanım kimliği: ' + (durum.hwid || '-');

    const sonuc = await ipcRenderer.invoke('byom:destek:olustur', {
      baslik: baslik,
      mesaj: metin + ekBilgi,
      oncelik: 'high'
    });

    if (sonuc && sonuc.ok) {
      mesajYaz($('#kilitDestekMesaj'),
        '✅ Talebiniz BYOM ekibine iletildi. En kısa sürede dönüş yapılacaktır.', 'basari');
      $('#kilitDestekBaslik').value = '';
      $('#kilitDestekMetni').value = '';
    } else {
      mesajYaz($('#kilitDestekMesaj'),
        (sonuc && sonuc.hata) || 'Talep gönderilemedi.',
        sonuc && sonuc.agSorunu ? 'uyari' : 'hata');
    }
  } catch (e) {
    mesajYaz($('#kilitDestekMesaj'), 'Talep gönderilemedi: ' + ((e && e.message) || e), 'hata');
  } finally {
    btn.disabled = false;
    btn.textContent = '📨 TALEBİ GÖNDER';
  }
});

$('#cikisBtn1').addEventListener('click', function () { ipcRenderer.invoke('byom:cikis'); });
$('#cikisBtn2').addEventListener('click', function () { ipcRenderer.invoke('byom:cikis'); });

/* --- Açılış --- */

hwidBilgisiniGetir();
