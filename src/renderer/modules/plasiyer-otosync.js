/* ============================================================================
 *  OTOMATİK EŞİTLEME TETİKLEYİCİSİ (Faz 4)
 *  src/renderer/modules/plasiyer-otosync.js
 *  ---------------------------------------------------------------------------
 *  Faz 3'te kuyruk boşaltma vardı ama tetiği KULLANICI çekiyordu. Bu modül onu
 *  kendiliğinden çalışır hâle getirir: internet geldiği anda ya da 60 saniyelik
 *  hafif yoklamada bekleyen kayıt varsa `sync:esitle` arka planda koşar.
 *
 *  ÜÇ TETİK:
 *   1) `window.addEventListener('online')` — anlık. Modem açıldığında, Wi-Fi'ye
 *      girildiğinde, mobil veri geldiğinde hemen denenir.
 *   2) 60 saniyelik yoklama — `online` olayı her durumda güvenilir değildir
 *      (otel/AVM portalları, VPN, "bağlı ama internet yok" hâli). Yoklama bu
 *      boşluğu kapatır.
 *   3) `visibilitychange` — plasiyer uygulamaya geri döndüğünde. Uyku/kilit
 *      sonrası zamanlayıcılar kısılmış olabilir.
 *
 *  AĞA BOŞA ÇIKILMAZ: her turda önce `sync:durum` okunur ve kararı
 *  `PlasiyerSyncMotor.esitlemeGerekliMi()` verir (DOM'suz, test edilebilir).
 *  Yapacak iş yoksa istek ATILMAZ — dakikada bir boşa istek müşterinin
 *  sitesini yorar ve sahada veri kotasını yakar.
 *
 *  KULLANICIYI RAHATSIZ ETMEZ: bildirim YALNIZCA gerçekten kayıt gittiğinde
 *  çıkar (`ozetMesaji` boşsa susar). "0 sipariş iletildi" gürültüdür.
 *
 *  YALNIZCA PLASİYER OTURUMUNDA: yönetici oturumunda kuyruk zaten dolmaz ve
 *  jeton yoktur; `sync:esitle` 401 döner. Boşa tur atmamak için baştan
 *  kontrol edilir.
 * ==========================================================================*/

'use strict';

(function () {

  /** Yoklama aralığı (ms). */
  var YOKLAMA_MS = 60000;

  /** `online` olayından sonra bu kadar beklenir (DNS/ağ oturması için). */
  var ONLINE_GECIKME_MS = 1500;

  /** Aynı tur iki kez başlamasın. */
  var suruyor = false;

  var zamanlayici = null;
  var kuruldu = false;

  function M() {
    return window.PlasiyerSyncMotor;
  }

  function plasiyerMi() {
    var o = (window.durum && window.durum.oturum) || {};
    return 'plasiyer' === o.rol;
  }

  /**
   * Bir tur dener.
   *
   * @param {string} sebep Tetiğin adı (teşhis için).
   */
  async function dene(sebep) {
    if (suruyor) return;
    if (!plasiyerMi()) return;
    if (!M()) return;

    suruyor = true;

    try {
      var durumCevap = await ipcRenderer.invoke('sync:durum');

      if (!M().esitlemeGerekliMi(durumCevap)) return;

      var sonuc = await ipcRenderer.invoke('sync:esitle');

      if (!sonuc || !sonuc.ok) return;

      var mesaj = sonuc.mesaj || (sonuc.ozet ? M().ozetMesaji(sonuc.ozet) : '');

      /* Bildirim yalnızca gerçekten iş yapıldıysa. */
      if (mesaj) {
        bildir(mesaj, 'ok');

        /* Kuyruk göstergesi ve patron yanıtları tazelenir. */
        if (window.PlasiyerZiyaret && 'function' === typeof window.PlasiyerZiyaret.notlariGetir) {
          window.PlasiyerZiyaret.notlariGetir().catch(function () { /* sessiz */ });
        }
      }
    } catch (e) {
      /*
       * Otomatik tetik SESSİZDİR. Arka planda kendi kendine çalışan bir iş,
       * başarısız olduğunda kullanıcının ekranına hata basmamalı; kayıtlar
       * kuyrukta bekler ve sıradaki tur yeniden dener.
       */
    } finally {
      suruyor = false;
    }
  }

  /* ------------------------------------------------------------------ *
   *  KURULUM
   * ------------------------------------------------------------------ */

  function kur() {
    if (kuruldu) return;
    kuruldu = true;

    /* 1) Ağ geldi. */
    window.addEventListener('online', function () {
      window.setTimeout(function () { dene('online'); }, ONLINE_GECIKME_MS);
    });

    /* 2) Hafif yoklama. */
    zamanlayici = window.setInterval(function () { dene('yoklama'); }, YOKLAMA_MS);

    /* 3) Uygulamaya geri dönüldü. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) dene('gorunurluk');
    });

    /* Açılışta bir kez — önceki oturumdan kalan kuyruk hemen boşalsın.
       8 saniye: lisans akışı ve ilk çizim bitsin, açılış yavaşlamasın. */
    window.setTimeout(function () { dene('acilis'); }, 8000);

    window.addEventListener('beforeunload', function () {
      if (zamanlayici) window.clearInterval(zamanlayici);
    });
  }

  if ('loading' === document.readyState) {
    document.addEventListener('DOMContentLoaded', kur);
  } else {
    kur();
  }

  window.PlasiyerOtoSync = {
    dene: dene,
    kur: kur,
    YOKLAMA_MS: YOKLAMA_MS,
    ONLINE_GECIKME_MS: ONLINE_GECIKME_MS
  };
})();
