/* ============================================================================
 *  SOL MENÜ DARALTMA (Faz 22-D) — src/renderer/modules/menu-daralt.js
 *  ---------------------------------------------------------------------------
 *  Ürün sahibi: "Soldaki kategoriler (ürün, sipariş, B2B üyeleri, iskonto
 *  oranları…) kapanır açılır olsun; ekrandaki kalabalığı azaltıp sipariş
 *  panelini ve asıl paneli daha büyük sığdıralım."
 *
 *  Üst çubuktaki #menuDaraltAnahtar (ya da Ctrl+B) menüyü 288 px'ten 84 px'lik
 *  bir İKON ŞERİDİNE indirir; etiketler gizlenir, ikonlar ve rozetler kalır.
 *  Menü KAPANMAZ, daralır: sekmeler tek tıkla erişilebilir kalır.
 *
 *  NEDEN SINIF DEĞİL NİTELİK: renderer.js → sekmeAc() menü düğmelerinin
 *  className'ini ATAMAYLA yeniden kurar (Faz 7 dersi, CLAUDE.md §4.11.1);
 *  düğmeye eklenen sınıf ilk tıklamada silinirdi. Durum menünün KENDİSİNDE
 *  `data-dar="1"` olarak tutulur, CSS onu izler (index.html › arayuzSistemi).
 *
 *  ERİŞİLEBİLİRLİK: gizlenen etiket (display:none) erişilebilir addan düşer;
 *  daraltılınca her düğmeye aria-label + title (etiket metni) yazılır,
 *  genişletilince geri alınır (özgün title saklanır).
 *
 *  KALICILIK: ayarlar.json → `menuDar` (cihaz tercihi, ayar:yaz). Kayıt
 *  başarısız olursa menü yine daralır — tercih bir kolaylıktır, iş akışı
 *  beklemez. Yalnızca transform/opacity kuralına uyulur: genişlik ANİMASYONSUZ
 *  değişir (her karede yeniden yerleşim olmasın, CLAUDE.md §4.5).
 * ==========================================================================*/

(function () {
  'use strict';

  var bagli = false;

  function menu() {
    return document.getElementById('anaMenu');
  }

  function anahtar() {
    return document.getElementById('menuDaraltAnahtar');
  }

  /** Düğmenin görünen etiketi (rozet / kilit simgesi hariç). */
  function etiket(dugme) {
    var span = dugme.querySelector('.align-middle');

    return span ? String(span.textContent || '').trim() : '';
  }

  function darMi() {
    var n = menu();

    return !!(n && '1' === n.getAttribute('data-dar'));
  }

  /**
   * Görünümü uygular. Tekrar çağrılması zararsızdır (değerler YAZILIR,
   * özgün title yalnızca ilk daraltmada saklanır).
   */
  function uygula(dar) {
    var n = menu();

    if (!n) return false;

    if (dar) n.setAttribute('data-dar', '1');
    else n.removeAttribute('data-dar');

    Array.prototype.forEach.call(n.querySelectorAll('button'), function (b) {
      var e = etiket(b);

      if (!e) return;

      if (dar) {
        if (!b.hasAttribute('data-title-ozgun')) b.setAttribute('data-title-ozgun', b.getAttribute('title') || '');
        b.setAttribute('aria-label', e);
        b.setAttribute('title', e);
      } else {
        b.removeAttribute('aria-label');

        if (b.hasAttribute('data-title-ozgun')) {
          var ozgun = b.getAttribute('data-title-ozgun');

          if (ozgun) b.setAttribute('title', ozgun);
          else b.removeAttribute('title');

          b.removeAttribute('data-title-ozgun');
        }
      }
    });

    var a = anahtar();

    if (a) {
      a.setAttribute('aria-expanded', dar ? 'false' : 'true');
      a.setAttribute('aria-label', dar ? 'Menüyü genişlet' : 'Menüyü daralt');
      a.setAttribute('title', dar ? 'Menüyü genişlet (Ctrl+B)' : 'Menüyü daralt (Ctrl+B)');
    }

    return true;
  }

  /** Tercihi cihaza yazar (ayarlar.json). Hata sessizdir: görünüm zaten uygulandı. */
  async function kaydet(dar) {
    try {
      if ('undefined' === typeof ipcRenderer || !ipcRenderer || 'function' !== typeof ipcRenderer.invoke) return;

      var ayarlar = await ipcRenderer.invoke('ayar:yaz', { menuDar: !!dar });

      if (ayarlar && 'object' === typeof ayarlar && window.durum) window.durum.ayarlar = ayarlar;
    } catch (e) {
      /* tercih kaydedilemedi — menü yine de daraldı/genişledi */
    }
  }

  function degistir() {
    var yeni = !darMi();

    uygula(yeni);
    kaydet(yeni);

    return yeni;
  }

  /** Kayıtlı tercihi uygular (ayarlar açılışta geç gelebilir — byom:hazir'da tekrar). */
  function tercihiUygula() {
    var a = window.durum && window.durum.ayarlar;

    if (a && true === a.menuDar && !darMi()) uygula(true);
  }

  function kur() {
    if (bagli) return;
    bagli = true;

    var a = anahtar();

    if (a) a.addEventListener('click', degistir);

    /* Ctrl+B (macOS: ⌘B) — yaygın kenar çubuğu kısayolu. Yazı alanında da
       çalışır: panelde zengin metin yok, Ctrl+B'nin başka bir işi yok. */
    document.addEventListener('keydown', function (olay) {
      if (!(olay.ctrlKey || olay.metaKey) || olay.shiftKey || olay.altKey) return;
      if ('b' !== olay.key && 'B' !== olay.key) return;

      olay.preventDefault();
      degistir();
    });

    tercihiUygula();
    document.addEventListener('byom:hazir', tercihiUygula);
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.MenuDaralt = {
    uygula: uygula,
    degistir: degistir,
    darMi: darMi,
    tercihiUygula: tercihiUygula
  };
})();
