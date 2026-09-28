'use strict';
/* ============================================================================
 *  SAĞ TIK MENÜSÜ (Faz 16-C)
 *  ---------------------------------------------------------------------------
 *  Saha isteği: "sağ tık yapıldığında standart Kopyala / Yapıştır / Kes /
 *  Tümünü Seç menüsü eklensin." Ürün sahibinin vurgusu: **işlevsel olsun —
 *  kopyalanacağı zaman gerçekten kopyalansın.**
 *
 *  NEDEN AYRI MODÜL: üç ayrı pencere bu menüyü ister ve ikisi ayrı dosyada
 *  yaşar — ana pencere + fiş penceresi (`main.js`) ve lisans penceresi
 *  (`src/main/byom.js`). Menüyü main.js'te bırakıp byom.js'e vermek dairesel
 *  bağımlılık olurdu; kopyalamak ise aynı kural için iki depo demekti.
 *
 *  NEDEN `role` DEĞİL, açık `click`: `role` odaktaki pencereye göre davranır.
 *  Fiş ve lisans pencerelerinde odak beklenmedik yerde olabilir ve menü
 *  sessizce yanlış belgeye iş yapardı. Açık çağrı ayrıca TEST EDİLEBİLİR:
 *  tıklayıp `copy()` çağrıldı mı diye bakabiliyoruz. Etiketi doğru olup
 *  hiçbir şey yapmayan bir menü, menü olmamasından kötüdür.
 *
 *  ELECTRON TEPE SEVİYESİNDE İSTENMEZ: `Menu` yalnızca `bagla()` içinde,
 *  çağrıldığı anda alınır. Böylece bu dosya `node --test` altında doğrudan
 *  `require` edilebilir ve şablon gerçek üretim kodu olarak sınanır.
 * ==========================================================================*/

/**
 * Sağ tık menüsünün şablonunu üretir.
 *
 * YAPAMAYACAĞINI VAAT ETMEZ: yapılamayan madde gizlenmez, **devre dışı**
 * bırakılır. Gizlemek menüyü her sağ tıkta farklı boyda gösterir ve kullanıcı
 * "bu sefer neden yok?" diye düşünür; gri bir madde sebebi kendisi söyler.
 *
 * @param {object} p  `context-menu` olayının parametreleri.
 * @param {object} wc Komutun uygulanacağı webContents.
 * @returns {Array} Menu.buildFromTemplate şablonu.
 */
function sablon(p, wc) {
  p = p || {};

  var secim = String(p.selectionText || '').trim();

  /*
   * `editFlags` Electron'un hesapladığı en doğru kaynaktır; gelmediği
   * durumlarda (eski sürüm, sentetik olay) seçim metninden türetilir —
   * menünün hiç çıkmaması yerine makul bir menü çıkar.
   */
  var f = p.editFlags || {
    canUndo: !!p.isEditable,
    canRedo: !!p.isEditable,
    canCut: !!p.isEditable && '' !== secim,
    canCopy: '' !== secim,
    canPaste: !!p.isEditable,
    canSelectAll: true
  };

  var calistir = function (komut) {
    return function () {
      if (wc && 'function' === typeof wc[komut]) wc[komut]();
    };
  };

  return [
    { label: 'Geri Al', accelerator: 'CmdOrCtrl+Z', enabled: !!f.canUndo, click: calistir('undo') },
    { label: 'Yinele', accelerator: 'CmdOrCtrl+Shift+Z', enabled: !!f.canRedo, click: calistir('redo') },
    { type: 'separator' },
    { label: 'Kes', accelerator: 'CmdOrCtrl+X', enabled: !!f.canCut, click: calistir('cut') },
    { label: 'Kopyala', accelerator: 'CmdOrCtrl+C', enabled: !!f.canCopy, click: calistir('copy') },
    { label: 'Yapıştır', accelerator: 'CmdOrCtrl+V', enabled: !!f.canPaste, click: calistir('paste') },
    { type: 'separator' },
    { label: 'Tümünü Seç', accelerator: 'CmdOrCtrl+A', enabled: false !== f.canSelectAll, click: calistir('selectAll') }
  ];
}

/**
 * Bir pencereye sağ tık menüsünü bağlar.
 *
 * HER YENİ PENCERE İÇİN ÇAĞRILMALIDIR — ana pencere, fiş penceresi ve lisans
 * penceresi ayrı `webContents`'lerdir; birine bağlamak diğerini kapsamaz.
 *
 * @param {object} pencere BrowserWindow.
 * @returns {boolean} Bağlandı mı?
 */
function bagla(pencere) {
  if (!pencere || !pencere.webContents) return false;

  var Menu;

  try {
    Menu = require('electron').Menu;
  } catch (e) {
    return false;   // Electron dışı ortam (test): şablon yine sınanabilir.
  }

  if (!Menu || 'function' !== typeof Menu.buildFromTemplate) return false;

  var wc = pencere.webContents;

  wc.on('context-menu', function (olay, p) {
    try {
      Menu.buildFromTemplate(sablon(p, wc)).popup({ window: pencere });
    } catch (e) {
      /* Menü açılamazsa uygulama akışı durmaz; sağ tık işlevsiz kalır. */
    }
  });

  return true;
}

module.exports = { sablon: sablon, bagla: bagla };
