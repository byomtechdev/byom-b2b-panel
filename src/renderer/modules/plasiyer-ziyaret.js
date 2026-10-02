/* ============================================================================
 *  SAHA ZİYARET NOTU — PLASİYER TARAFI
 *  src/renderer/modules/plasiyer-ziyaret.js
 *  ---------------------------------------------------------------------------
 *  Plasiyerin müşteri ziyaretinden sonra patrona not bıraktığı ekran + patron
 *  yanıtlarının düştüğü bildirim zili.
 *
 *  KESİNLİKLE ZORUNLU DEĞİL — tasarımın merkezinde bu var:
 *   · Not bırakmak tamamen plasiyerin inisiyatifindedir. Sipariş akışının
 *     hiçbir adımı nota bağlı değildir; düğme görünür, baskı yapmaz.
 *   · Serbest metin de zorunlu değil: tek bir hızlı etiket (tek dokunuş)
 *     yeter. Sahada telefonla uzun yazı yazmak gerçekçi değil.
 *   · BOŞ not kabul edilmez (ne etiket ne metin) — haritada sebepsiz bir
 *     kırmızı uyarı yakmak patronun güvenini boşa harcar.
 *
 *  ÇEVRİMDIŞI: not her zaman ÖNCE yerel kuyruğa yazılır
 *  (`ayarlar.json → plasiyerZiyaretKuyrugu`), sonra ağ denenir. Diske yazmak
 *  ilk adım olduğu için uygulama kapansa bile not kaybolmaz — telemetri ve
 *  sipariş kuyruğuyla aynı ilke.
 *
 *  Kurallar (etiket listesi, durum sırası) `src/renderer/harita-veri.js`
 *  içindedir; burada tekrar yazılmaz.
 * ==========================================================================*/

'use strict';

(function () {

  var durumZ = {
    notlar: [],          // plasiyerin kendi notları + patron yanıtları
    okunan: {},          // id -> true (zil sayacı için)
    acikMusteri: null
  };

  var bagli = false;

  function V() {
    return window.HaritaVeri;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function yaz(dugum, mesaj) {
    if (!dugum) return;

    dugum.textContent = String(mesaj || '');
    dugum.classList.toggle('hidden', !mesaj);
  }

  function oturum() {
    return (window.durum && window.durum.oturum) || {};
  }

  function plasiyerMi() {
    return 'plasiyer' === oturum().rol;
  }

  /* ------------------------------------------------------------------ *
   *  NOT GİRİŞ PENCERESİ
   * ------------------------------------------------------------------ */

  /** Müşteri şeridindeki "Saha Ziyaret Notu" düğmesini ekler. */
  function dugmeyiEkle() {
    if (!plasiyerMi()) return;

    var serit = el('musteriSerit');

    if (!serit) return;

    /* Müşteri seçili değilse düğme anlamsız. */
    var musteri = secilenMusteri();

    if (!musteri) return;

    if (el('ziyaretNotuAc')) return;   // zaten var

    var kutu = serit.querySelector('.flex');

    if (!kutu) return;

    var dugme = document.createElement('button');

    dugme.type = 'button';
    dugme.id = 'ziyaretNotuAc';
    /* Faz 20: müşteri şeridindeki öteki ikincil düğmelerle aynı aile ve boy. */
    dugme.className = 'dg dg-ikincil';
    dugme.innerHTML = ('function' === typeof window.ikon ? window.ikon('not') + ' ' : '') + 'Saha Ziyaret Notu / Talep Gir';
    dugme.title = 'İsteğe bağlı — patrona not bırakın';

    dugme.addEventListener('click', formuAc);

    kutu.appendChild(dugme);
  }

  function secilenMusteri() {
    return (window.PlasiyerMusteri && window.PlasiyerMusteri.durum && window.PlasiyerMusteri.durum.secili) || null;
  }

  function formuAc() {
    var musteri = secilenMusteri();

    if (!musteri) {
      bildir('Önce müşteri seçin.', 'uyari');
      return;
    }

    durumZ.acikMusteri = musteri;

    var perde = el('ziyaretPerde');
    var modal = el('ziyaretModal');

    if (!perde || !modal) return;

    var etiketler = Object.keys(V().ETIKETLER);

    modal.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div>' +
          '<div class="text-xl font-extrabold">Saha Ziyaret Notu</div>' +
          '<div class="text-sm text-slate-500 dark:text-slate-400 mt-1">' + kacis(musteri.unvan || '—') + '</div>' +
        '</div>' +
        '<button type="button" id="ziyaretKapat" class="dg dg-sessiz dg-kare dg-k shrink-0" aria-label="Kapat">' + (window.ikon ? window.ikon('carpi') : '×') + '</button>' +
      '</div>' +

      '<p class="mt-3 text-sm text-slate-500 dark:text-slate-400">' +
        'Bu alan <strong>isteğe bağlıdır</strong>. Tek bir etiket seçmek yeterli; ' +
        'istersen hiç not bırakmadan da devam edebilirsin.' +
      '</p>' +

      '<div class="mt-5 text-sm font-bold text-slate-600 dark:text-slate-300">Hızlı Etiket</div>' +
      '<div class="mt-2 grid grid-cols-2 gap-2">' +
        etiketler.map(function (a) {
          return '<button type="button" class="zy-etiket px-3 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 font-bold text-sm text-left hover:bg-slate-100 dark:hover:bg-slate-700 transition" ' +
            'data-etiket="' + a + '" aria-pressed="false">' + kacis(V().ETIKETLER[a]) + '</button>';
        }).join('') +
      '</div>' +

      '<label class="block mt-5 text-sm font-bold text-slate-600 dark:text-slate-300" for="zyNot">' +
        'Patrona mesaj <span class="font-normal opacity-70">(isteğe bağlı)</span>' +
      '</label>' +
      '<textarea id="zyNot" rows="3" placeholder="Örn: Rakip %15 iskonto veriyor, özel fiyat isteniyor." ' +
                'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900"></textarea>' +

      '<label class="block mt-4 text-sm font-bold text-slate-600 dark:text-slate-300" for="zyGorsel">' +
        'Görsel bağlantısı <span class="font-normal opacity-70">(isteğe bağlı)</span>' +
      '</label>' +
      '<input id="zyGorsel" type="url" placeholder="https://…" autocomplete="off" ' +
             'class="mt-2 w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900" />' +

      '<p id="zyHata" class="hidden mt-4 text-red-600 dark:text-red-400 font-semibold text-sm"></p>' +

      '<div class="mt-6 flex gap-2">' +
        '<button type="button" id="zyKaydet" class="dg dg-birincil dg-b flex-1">Notu Gönder</button>' +
        '<button type="button" id="zyVazgec" class="dg dg-ikincil dg-b">Vazgeç</button>' +
      '</div>';

    perde.hidden = false;

    el('ziyaretKapat').addEventListener('click', formuKapat);
    el('zyVazgec').addEventListener('click', formuKapat);
    el('zyKaydet').addEventListener('click', kaydet);

    /* Etiketler çoktan seçmeli — aria-pressed ile durum taşınır. */
    modal.querySelectorAll('.zy-etiket').forEach(function (d) {
      d.addEventListener('click', function () {
        var secili = 'true' === d.getAttribute('aria-pressed');

        d.setAttribute('aria-pressed', secili ? 'false' : 'true');
        d.classList.toggle('bg-marka-700', !secili);
        d.classList.toggle('text-white', !secili);
        d.classList.toggle('border-marka-700', !secili);
      });
    });
  }

  function formuKapat() {
    var perde = el('ziyaretPerde');
    var modal = el('ziyaretModal');

    if (perde) perde.hidden = true;
    if (modal) modal.innerHTML = '';

    durumZ.acikMusteri = null;
  }

  function secilenEtiketler() {
    var modal = el('ziyaretModal');

    if (!modal) return [];

    return Array.prototype.slice
      .call(modal.querySelectorAll('.zy-etiket[aria-pressed="true"]'))
      .map(function (d) { return d.dataset.etiket; });
  }

  async function kaydet() {
    var etiketler = secilenEtiketler();
    var metin = String((el('zyNot') || {}).value || '').trim();
    var gorsel = String((el('zyGorsel') || {}).value || '').trim();

    /* BOŞ not kabul edilmez: haritada sebepsiz kırmızı uyarı yakmamalı. */
    if (!etiketler.length && !metin) {
      yaz(el('zyHata'), 'En az bir etiket seçin ya da kısa bir not yazın.');
      return;
    }

    var musteri = durumZ.acikMusteri || secilenMusteri();
    var dugme = el('zyKaydet');

    if (dugme) dugme.disabled = true;

    var yuk = {
      /* Sayısal kimlik → sayı; çevrimdışı müşteri → temp_musteri_<uuid> METNİ
         (Faz 9). Eskiden 0 gidiyordu ve not sunucuda sahipsiz kalıyordu;
         artık eşitleme köprüsü (sync-motor → notKoprusuKur) notu müşteri
         eşitlendikten sonra gerçek kimliğe bağlar. */
      musteriId: musteri
        ? (!isNaN(Number(musteri.id)) ? Number(musteri.id) : String(musteri.id))
        : 0,
      il: String((musteri && musteri.il) || ''),
      etiketler: etiketler,
      not: metin,
      gorsel: gorsel
    };

    /* 1) ÖNCE DİSKE — uygulama kapansa bile not kaybolmaz. */
    var kuyruk = await ipcRenderer.invoke('ziyaret:kuyruga', yuk);

    if (dugme) dugme.disabled = false;

    if (!kuyruk || !kuyruk.ok) {
      yaz(el('zyHata'), 'Not yerel olarak kaydedilemedi.');
      return;
    }

    formuKapat();

    /* 2) SONRA AĞ — başarısızlık akışı durdurmaz, kuyrukta bekler. */
    var esit = await ipcRenderer.invoke('sync:esitle');

    if (esit && esit.ok && esit.ozet && esit.ozet.not && esit.ozet.not.gonderilen) {
      bildir('Ziyaret notu merkeze iletildi.', 'ok');
    } else {
      bildir('Not kaydedildi. İnternet geldiğinde merkeze iletilecek.', 'ok');
    }

    notlariGetir();
  }

  /* ------------------------------------------------------------------ *
   *  BİLDİRİM ZİLİ — patron yanıtları
   * ------------------------------------------------------------------ */

  async function notlariGetir() {
    if (!plasiyerMi()) return;

    var cevap = await b2b('/plasiyer/notlarim', {
      sorgu: { plasiyerId: Number(oturum().id) || 0, gun: 30 }
    });

    if (!cevap || !cevap.ok || !cevap.veri || !cevap.veri.ok) return;

    durumZ.notlar = cevap.veri.notlar || [];

    ziliTazele();
  }

  /** Okunmamış yanıt sayısı: patron yanıt yazmış ya da durumu ilerletmiş. */
  function okunmamisSayisi() {
    return durumZ.notlar.filter(function (n) {
      if (durumZ.okunan[n.id]) return false;

      return ('' !== String(n.yanit || '')) || ('beklemede' !== n.durum);
    }).length;
  }

  function ziliTazele() {
    if (!plasiyerMi()) {
      var eski = el('ziyaretZil');
      if (eski) eski.remove();
      return;
    }

    var kutu = el('plasiyerUstBar');

    if (!kutu) return;

    var zil = el('ziyaretZil');

    if (!zil) {
      zil = document.createElement('button');
      zil.type = 'button';
      zil.id = 'ziyaretZil';
      /* Faz 20: ikon düğmesi KAREDİR (38px); sayaç rozeti köşede. */
      zil.className = 'dg dg-ikincil dg-kare relative';
      zil.setAttribute('aria-label', 'Yönetici yanıtları');
      zil.title = 'Yönetici yanıtları';

      zil.addEventListener('click', zilPerdesiniAc);

      /* Çıkış düğmesinden ÖNCE: en sağda "Çıkış" kalsın. */
      var cikis = el('plasiyerCikis');

      if (cikis) kutu.insertBefore(zil, cikis);
      else kutu.appendChild(zil);
    }

    var sayi = okunmamisSayisi();

    zil.innerHTML = (window.ikon ? window.ikon('zil') : '') + (sayi
      ? '<span class="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white ' +
        'text-xs font-black grid place-items-center">' + sayi + '</span>'
      : '');
  }

  function zilPerdesiniAc() {
    var perde = el('ziyaretPerde');
    var modal = el('ziyaretModal');

    if (!perde || !modal) return;

    var liste = durumZ.notlar.slice();

    modal.innerHTML =
      '<div class="flex items-start justify-between gap-4">' +
        '<div class="text-xl font-extrabold">Notlarım ve Yönetici Yanıtları</div>' +
        '<button type="button" id="ziyaretKapat" class="dg dg-sessiz dg-kare dg-k shrink-0" aria-label="Kapat">' + (window.ikon ? window.ikon('carpi') : '×') + '</button>' +
      '</div>' +

      (liste.length
        ? '<div class="mt-5 space-y-3 max-h-96 overflow-y-auto">' + liste.map(zilKarti).join('') + '</div>'
        : '<div class="mt-6 py-8 text-center text-slate-500 dark:text-slate-400">Henüz not bırakmadınız.</div>');

    perde.hidden = false;

    el('ziyaretKapat').addEventListener('click', formuKapat);

    /* Perde açıldı = yanıtlar okundu. */
    liste.forEach(function (n) { durumZ.okunan[n.id] = true; });

    ziliTazele();
  }

  function zilKarti(n) {
    var durumMetni = {
      beklemede: '<span class="px-2 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 text-xs font-black">Merkeze iletildi</span>',
      gorundu: '<span class="px-2 py-1 rounded-lg bg-amber-500 text-white text-xs font-black">👁 İşleme alındı</span>',
      cozuldu: '<span class="px-2 py-1 rounded-lg bg-emerald-600 text-white text-xs font-black">✓ Çözüldü</span>'
    };

    var zaman = '';

    try {
      zaman = new Date(n.zaman).toLocaleString('tr-TR');
    } catch (e) {
      zaman = String(n.zaman || '');
    }

    var etiketler = (n.etiketler || []).map(function (e) {
      return '<span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-xs font-bold">' +
        kacis(V().etiketAdi(e)) + '</span>';
    }).join(' ');

    return '<div class="p-3 rounded-xl border-2 border-slate-100 dark:border-slate-700">' +
      '<div class="flex items-start justify-between gap-3 flex-wrap">' +
        '<div>' +
          '<div class="font-extrabold">' + kacis(n.musteriAdi || '—') + '</div>' +
          '<div class="text-xs text-slate-500 dark:text-slate-400">' + kacis(zaman) + '</div>' +
        '</div>' +
        (durumMetni[n.durum] || durumMetni.beklemede) +
      '</div>' +
      (etiketler ? '<div class="mt-2 flex gap-1 flex-wrap">' + etiketler + '</div>' : '') +
      (n.not ? '<p class="mt-2 text-sm whitespace-pre-wrap">' + kacis(n.not) + '</p>' : '') +
      (n.yanit
        ? '<div class="mt-2 p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-sm">' +
          '<span class="font-bold">Yönetici:</span> ' + kacis(n.yanit) + '</div>'
        : '') +
    '</div>';
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   *  "SAHA NOTLARIM / CRM" SEKMESİ (Faz 6)
   *  ---------------------------------------------------------------
   *  Plasiyerin üçüncü sekmesi. Kartlar bildirim zilindeki `zilKarti` ile
   *  AYNI çiziciden gelir: iki ayrı kart tasarımı bakmak zorunda kalmayalım.
   *  Yöneticinin karşılığı Pazarlamacılar › Saha Ziyaret Haritası'dır.
   * ------------------------------------------------------------------ */

  function notlarimiCiz() {
    var kap = el('notlarimKab');

    if (!kap) return;

    var ozet = el('notlarimOzet');
    var notlar = durumZ.notlar || [];

    if (ozet) {
      ozet.textContent = notlar.length
        ? (notlar.length + ' not · ' + okunmamisSayisi() + ' yeni yanıt')
        : 'Son 30 günde not yok';
    }

    /* Menü düğmesindeki kırmızı sayaç: okunmamış patron yanıtı sayısı. */
    var sayac = el('notlarimSayaci');

    if (sayac) {
      var yeni = okunmamisSayisi();

      sayac.textContent = yeni > 99 ? '99+' : String(yeni);
      sayac.classList.toggle('hidden', yeni <= 0);
    }

    if (!notlar.length) {
      kap.innerHTML =
        '<div class="py-12 text-center">' +
          '<div class="text-5xl mb-4" aria-hidden="true">' + (window.ikon ? window.ikon('not') : '') + '</div>' +
          '<div class="text-base font-bold">Henüz saha notu yok</div>' +
          '<p class="mt-2 metin-ikincil">' +
            'Not girmek ZORUNLU DEĞİLDİR. Bir müşteri seçip ' +
            '"Saha Ziyaret Notu" düğmesiyle istediğinizde ekleyebilirsiniz.</p>' +
        '</div>';
      return;
    }

    /* En yenisi üstte: sahada en son ne olduğu en çok ilgilendiren şeydir. */
    var sirali = notlar.slice().sort(function (a, b) {
      return String(b.zaman || '').localeCompare(String(a.zaman || ''));
    });

    kap.innerHTML = '<div class="grid gap-3">' + sirali.map(zilKarti).join('') + '</div>';

    /* Sekme görüldüyse yanıtlar okunmuş sayılır — zil de sussun. */
    notlar.forEach(function (n) { durumZ.okunan[n.id] = true; });
    ziliTazele();
  }

  /** Sekme açıldığında tazeler (ağ yoksa elde olanı çizer). */
  function sekmeyiAc() {
    notlarimiCiz();

    /* Söz döner: Yenile düğmesi meşgul görünümünü bu bitene kadar tutar (Faz 20). */
    return notlariGetir().then(notlarimiCiz).catch(function () { /* sessiz: eldeki liste duruyor */ });
  }

  function kur() {
    if (bagli) return;
    bagli = true;

    /* "Saha Notlarım" artık Müşterilerim sekmesinin alt bölümü (Faz 9):
       sekmeAc'ı SARAR (renderer.js'e dokunmadan). Eski 'notlarim' adı da
       geriye dönük çalışır. */
    if ('function' === typeof window.sekmeAc) {
      var ozgunSekme = window.sekmeAc;

      window.sekmeAc = function (ad) {
        var sonuc = ozgunSekme.apply(this, arguments);

        if ('musterilerim' === ad || 'notlarim' === ad) sekmeyiAc();

        return sonuc;
      };
    }

    var yenile = el('notlarimYenile');
    /* Meşgul durumuyla (Faz 20): iş bitene kadar ikon döner, ikinci basış yeni tur açmaz.
       Modül yoksa düz tıklama (zarif düşüş). */
    if (yenile && window.ArayuzDugme && 'function' === typeof window.ArayuzDugme.bagla) window.ArayuzDugme.bagla(yenile, sekmeyiAc);
    else if (yenile) yenile.addEventListener('click', sekmeyiAc);

    document.addEventListener('keydown', function (olay) {
      var perde = el('ziyaretPerde');

      if ('Escape' === olay.key && perde && !perde.hidden) formuKapat();
    });

    /*
     * Müşteri şeridi her seçimde yeniden çizildiği için düğmeyi oraya
     * SARARAK ekliyoruz: PlasiyerMusteri.seridiCiz çağrıldıktan sonra
     * düğme yeniden konur. Şeridin içine girmek yerine sarmak, iki modülün
     * birbirinin işaretlemesini bilmek zorunda kalmamasını sağlar.
     */
    if (window.PlasiyerMusteri && 'function' === typeof window.PlasiyerMusteri.seridiCiz) {
      var ozgun = window.PlasiyerMusteri.seridiCiz;

      window.PlasiyerMusteri.seridiCiz = function () {
        var sonuc = ozgun.apply(this, arguments);

        dugmeyiEkle();
        ziliTazele();

        return sonuc;
      };
    }

    /* Açılışta ve sonra 5 dakikada bir patron yanıtlarını yokla. */
    window.setTimeout(function () {
      notlariGetir().catch(function () { /* sessiz */ });
    }, 3000);

    var saat = window.setInterval(function () {
      notlariGetir().catch(function () { /* sessiz */ });
    }, 5 * 60 * 1000);

    /* Pencere kapanırken zamanlayıcı kalmasın. */
    window.addEventListener('beforeunload', function () { window.clearInterval(saat); });
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.PlasiyerZiyaret = {
    formuAc: formuAc,
    formuKapat: formuKapat,
    notlariGetir: notlariGetir,
    ziliTazele: ziliTazele,
    okunmamisSayisi: okunmamisSayisi,
    dugmeyiEkle: dugmeyiEkle,
    notlarimiCiz: notlarimiCiz,
    sekmeyiAc: sekmeyiAc,
    zilKarti: zilKarti,
    durum: durumZ
  };
})();
