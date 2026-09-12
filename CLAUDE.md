# CLAUDE.md — BYOM B2B Panel (Electron) · Bağlam Haritası

> **Bu dosyanın amacı token tasarrufudur.** `renderer.js` 330 KB, `index.html`
> 233 KB, `renderer-ek.js` 136 KB'dır. **Bu dosyaları baştan sona OKUMA.**
> Aşağıdaki bölüm haritalarından satır aralığını bul ve yalnızca onu oku:
> ```bash
> sed -n '5558,6377p' renderer.js        # Bölüm 10 — Depo fişi
> grep -n "function fisiOlustur" renderer.js
> ```
>
> Ekosistem geneli (eklenti + tema + kurallar) için: **`../CLAUDE.md`**.
> Davranış sözleşmesi: **`../BYOM-REGISTRY.md`**.

---

## 0. Bu depo nedir

`byomtechdev/byom-b2b-panel` — BYOM ekosisteminin kök deposuna **git submodule**
olarak bağlı masaüstü yönetim paneli. Sürüm: `package.json` → **2.0.0**.

- Toptancı/hırdavatçı için WooCommerce B2B yönetimi: sipariş takibi, ürün &
  stok ızgarası, Excel içe/dışa aktarma, bayi onayları, depo fişi, **BYOM 2.0
  Vitrin Editörü**, BYOM Brain lisans + destek masası.
- Çalıştırma: `npm start` (electron). Paketleme: `npm run build` (electron-builder,
  NSIS tek-tık kurulum; macOS için `build:mac`).
- **Commit sırası:** önce bu submodule, sonra kök depo. **Push kendi
  inisiyatifinle yapılmaz** — yalnızca kullanıcı o turda açıkça isterse, ve
  yine önce bu submodule sonra kök.

### Süreç modeli (bilmek zorunlu)
```
main.js  (ANA SÜREÇ · Node)                 index.html + renderer*.js (ARAYÜZ)
  · Woo/B2B REST istekleri                    · nodeIntegration: true
  · ayarlar.json okuma/yazma                  · contextIsolation: false
  · dosya/yazdır/PDF/Excel                    → require() ARAYÜZDE DE ÇALIŞIR
  · lisans akışı (byom.js)                    · ama ağ isteği ARAYÜZDEN ATILMAZ
  · telemetri gönderimi                 ipcRenderer.invoke/send ⇄ ipcMain.handle/on
```
**Neden istekler ana süreçte?** WooCommerce sunucusu CORS başlığı göndermez;
arayüzden `fetch` atılsa tarayıcı motoru engeller. Node'da CORS yoktur. Ayrıca
lisans anahtarı ve Woo anahtarları arayüz katmanında dolaşmaz.

---

## 1. Dosya sorumluluk matrisi

### 1.1 Ana süreç
| Dosya | Sorumluluk | İç bölüm haritası (satır) |
|---|---|---|
| `main.js` (46 KB) | Pencere yaşam döngüsü, REST köprüsü, ayar dosyası, fiş/Excel/PDF, otomatik güncelleme, küresel hata kancaları | `0.5)` platform ayrımı **49** · `0)` SSL esnekliği **144** · `1)` ayar dosyası **211** · `2)` Woo REST köprüsü **296** · `3)` depo fişi **559** · `3.4)` Excel **681** · `3.5)` oto güncelleme **780** · `4)` pencere & yaşam döngüsü **923** |
| `src/main/byom.js` | **BYOM Brain entegrasyon çekirdeği.** Lisans durumu (`durum.lisans`), aktivasyon/yeniden doğrulama akışı, `lisansOzeti()`, 18 `byom:*` IPC kanalı | — |
| `src/main/byom-lisans-servisi.js` | Lisans doğrulama/aktivasyon motoru, durum yorumlama (`acikMi`) | 🔒 kilitli alan |
| `src/main/byom-lisans-deposu.js` | Yerel lisans deposu — safeStorage (DPAPI) şifreleme, yoksa HWID HMAC imzası, taşınma tespiti | 🔒 kilitli alan |
| `src/utils/hwid.js` | **Donanım kimliği üreticisi.** Her açılışta donanımdan yeniden hesaplanır, saklanmaz; ham seri no asla gönderilmez (SHA-256 özeti) | 🔒 kilitli alan |
| `src/main/byom-yapilandirma.js` | Hub adresi çözümü (`BYOM_API_URL` → kayıtlı → varsayılan), adres temizleme/birleştirme, süre aşımı ve çevrimdışı izin sıkıştırması | 🔒 `cevrimdisiIzinGunu()` |
| `src/main/byom-api.js` | BYOM Brain HTTP istemcisi. Node `fetch` takılırsa Chromium `net.fetch`'e düşer; hataları Türkçeleştirir, **`agSorunu` bayrağı** ile "ulaşılamıyor" ≠ "hayır dedi" ayrımını kurar | Bu ayrım kritik: internet yokken lisans **SİLİNMEZ** |
| `src/main/byom-destek-servisi.js` | Destek masası (ticket) servisi |
| `src/main/byom-excel.js` | Excel motoru — `.xlsx` yazar, `.xlsx/.xls/.csv` okur. **Harici bağımlılık yok** |
| **`src/main/byom-telemetri.js`** | **Telemetri (sessiz hata avcısı) · ana süreç.** Bkz. §4 |
| **`src/main/byom-katalog-depo.js`** | **Çevrimdışı katalog deposu** (Faz 2). `<userData>/byom-data/katalog.json` + bellekte SKU/barkod/ad/kategori indeksleri. SQLite DEĞİL — gerekçe dosya başlığında. `kur({ dizin })` ile test edilebilir | — |
| **`src/main/byom-gorsel-onbellek.js`** | **Görsel indirme kuyruğu** (Faz 2). `<userData>/byom-gorseller/`, SHA-256 dosya adı ile tekrar indirme yok, en çok 3 eşzamanlı | — |

`main.js` bölüm haritasına eklenenler:
**`3.6)` Plasiyer kimlik ve veri kapısı** (`plasiyer:*` IPC, oturum belleği → §5) ·
**`3.7)` Çevrimdışı katalog ve görsel önbelleği** (`katalog:*` / `gorsel:*` IPC → §4.6).

### 1.2 Arayüz
| Dosya | Sorumluluk | İç bölüm haritası (satır) |
|---|---|---|
| `index.html` (233 KB) | Tüm işaretleme + Tailwind yapılandırması + 4 satır içi betik. **Betik yükleme sırası dosyanın sonundadır ve kritiktir** (→ §2) | — |
| `renderer.js` (330 KB) | **Arayüz çekirdeği.** Diğer tüm dosyalar buradaki `durum`, `$`, `bildir`, `api/woo/b2b`, `sekmeAc`, `kacis`, `ikon` yardımcılarını kullanır | `1` yardımcılar **14** · `2` demo veri **337** · `3` durum/sabitler **555** · `4` REST köprüsü **1214** · `5` üst çubuk **2083** · `6` sekme yönetimi **2293** · `7` siparişler **2343** (revize **2944**) · `8` ürün & stok **3644** · `9` üye onayları **4613** · `10` depo fişi **5558** · `11` ayarlar **6377** · `12` tema/zoom **7033** · `13` olay bağlama + başlangıç **7096** |
| `renderer-ek.js` (136 KB) | Ek modül — `renderer.js`'ten **SONRA** yüklenir, onun fonksiyonlarını sarar | `0` yardımcılar **23** · `A` ödeme matrisi **100** (kalıcılık **274**, min. sipariş **977**) · `B` sipariş rozeti **1103** · `C` ürün düzenle **1160** · `D` sürükle-bırak sıralama **1956** · `E` ürün silme **2832** · `F` sipariş iptali **2903** · `F2` kalıcı silme **3193** · `G` bayi silme **3272** · `H` olay bağlama **3351** |
| `renderer-izgara.js` (115 KB) | Excel tipi ürün veri ızgarası. `renderer.js` + `renderer-ek.js`'e bağımlı | `0` durum **32** · `A` sanallaştırılmış ızgara **224** · `B` hücre içi düzenleme **663** · `C` kısmi güncelleme **845** · `D` seçim/toplu işlem **958** · `E` kategori ağacı **1725** · `F` görünüm + olay bağlama **2062** · `G` mevcut akışlara bağlanma **2270** · `H` yapışkan haplar/kısayollar **2329** · `I` domino sıralama + 60 FPS **2472** |
| `renderer-excel.js` (41 KB) | Excel dökümü + sütun eşleştirmeli içe aktarma. Izgaranın `izgOlaylariBagla`'sını sarar → ondan **SONRA** | `0` durum **30** · `A` dışa aktarma **90** · `B` eşleştirme sihirbazı **198** · `C` içe aktarma motoru **592** · `D` olay bağlama **1050** · `E` mevcut akışa bağlanma **1125** |
| `renderer-byom.js` (53 KB) | BYOM Brain arayüzü: lisans rozeti + Destek sekmesi. `sekmeAc`/`bildir`'i sarar | — |
| `renderer-vitrin.js` (112 KB) | **Vitrin Editörü arayüzü.** Sürükle-bırak, ayar formları, canlı önizleme iframe'i. EN SONA yüklenir | — |
| `src/renderer/vitrin-motor.js` | **DOM'suz** vitrin motoru: indirgeyici (reorder/toggle/updateSettings/undo/redo), `buildPutBody`, **çevrimdışı outbox**, `demoRegistry()` (**registry'nin 3. kopyası**) | `node --test` altında doğrudan koşar |
| `src/renderer/sira-motor.js` | **DOM'suz** kademeli (domino) taşıma motoru | Izgaradan **ÖNCE** yüklenir |
| **`src/renderer/telemetry.js`** | **Telemetri · arayüz.** EN ÖNCE yüklenir (→ §4) | — |
| **`renderer-plasiyer.js`** | **Çift kapılı giriş + rol kısıtlaması.** Kapı kaplaması, `durum.oturum`, menü daraltma, üst bar, çıkış. EN SONA yüklenir (→ §5) | — |
| **`src/renderer/modules/plasiyer-yonetimi.js`** | **Yöneticinin "Pazarlamacılar" sekmesi:** tanımlama, PIN, bayi atama, performans tablosu + ciro çubuğu. `sekmeAc`'ı SARAR (→ §5) | — |
| **`src/renderer/plasiyer-siparis-motor.js`** | **DOM'suz sipariş motoru** (Faz 2): koli matematiği, sepet indirgeyici, "son siparişi kopyala", geçici müşteri UUID, iskonto tavanı, sipariş gövdesi. `node --test` altında koşar (→ §4.6) | — |
| **`src/renderer/modules/plasiyer-vitrin.js`** | **Satış vitrini** (Faz 2): daraltılabilir kategori kenar çubuğu, filtre barı, çift görünüm (Vitrin/Matris), SPOT rozeti, ürün detay penceresi, sepet. `sekmeAc`'ı SARAR | — |
| **`src/renderer/modules/plasiyer-musteri.js`** | **Müşteri ve sipariş akışı** (Faz 2): seçim/arama, cari risk uyarısı, çevrimdışı müşteri, son siparişi kopyala, üç ödeme yöntemi + notlar | — |
| `lisans/lisans.html` + `lisans/lisans.js` | Lisans/aktivasyon penceresi — ana pencereden bağımsız | — |
| `vendor/tailwind.js` | Yerel Tailwind kopyası (internetsiz sunum). Bulunamazsa CDN, o da olmazsa yedek CSS | — |

### 1.3 Yerel dosyalar (`<userData>`)
| Dosya | İçerik |
|---|---|
| `ayarlar.json` | Woo adresi + CK/CS, tema, zoom, panel tercihleri (`main.js:215`) |
| `byom-ayarlar.json` | Hub adresi, çevrimdışı izin günü, oto kontrol saati, süre aşımı |
| `byom-lisans.json` | Lisans kaydı — safeStorage ile şifreli ya da HWID HMAC imzalı |
| `byom-telemetri-kuyruk.json` | Gönderilemeyen telemetri kayıtları (en çok 50) |
| `byom-data/katalog.json` | **Çevrimdışı ürün kataloğu** (Faz 2). Şema sürümü uyuşmazsa yok sayılır; geçici dosya + rename ile yazılır |
| `byom-gorseller/<sha256>.jpg` | İndirilmiş ürün görselleri. Dosya adı ADRESİN özetidir — aynı görsel tek kez iner |
| `ayarlar.json → plasiyerYerelMusteriler` | Çevrimdışı eklenen müşteriler (`temp_musteri_<uuid>`) |
| `ayarlar.json → plasiyerSiparisKuyrugu` | Yazılmış ama sunucuya gönderilmemiş siparişler (Faz 3 eşitleyecek) |

---

## 2. Betik yükleme sırası (index.html sonu) — bozulmaz

```
src/renderer/telemetry.js   ← <head>, EN ÖNCE: sonraki her betiğin hatasını yakalar
vendor/tailwind.js
renderer.js                 ← çekirdek: durum, $, bildir, api/woo/b2b, sekmeAc
renderer-ek.js              ← renderer.js'i sarar
src/renderer/sira-motor.js  ← ızgaradan ÖNCE (DOM'suz motor)
renderer-izgara.js
renderer-excel.js           ← ızgaranın olay bağlamasını sarar
renderer-byom.js
src/renderer/vitrin-motor.js
renderer-vitrin.js
renderer-plasiyer.js        ← kapı + rol kısıtlaması (durum, $, bildir, sekmeAc, kacis)
src/renderer/modules/plasiyer-yonetimi.js  ← EN SON: sekmeAc'ı SARAR
```

**`src/renderer/` alt dizin anlamı — karıştırma:**
- `src/renderer/*.js` → **DOM'suz** motorlar; `node --test` altında doğrudan
  `require` edilir (`sira-motor`, `vitrin-motor`, `telemetry`).
- `src/renderer/modules/*.js` → **DOM'a bağlı** özellik modülleri; yalnızca
  `<script src>` ile çalışır, require edilemez.

**`check-all.js` artık panel kökünü TARAR** (eskiden sabit liste vardı):
kök dizine eklenen yeni bir `renderer-*.js` kendiliğinden `node --check`
kapsamına girer. `package.json → build.files` de `renderer*.js` deseni
kullanır, yani yeni dosya pakete elle eklenmez.
**Kural:** bir dosya başka bir dosyanın fonksiyonunu **sarıyorsa** (wrap) ondan
sonra gelir. Sırayı değiştirmek "fonksiyon tanımsız" yerine **sessizce
sarılmamış davranış** üretir — test yakalamaz, kullanıcı yakalar.

`electron-builder` paketine giren dosyalar `package.json → build.files`
listesindedir. `src/**/*` kalıbı sayesinde `src/` altına eklenen yeni dosya
**otomatik** pakete girer; kök dizine yeni bir `renderer-*.js` eklersen
listeye **elle** eklemen gerekir.

---

## 3. IPC kanalları

**Adlandırma:** `alan:eylem` — iki nokta ile. Yeni kanal eklerken mevcut öneki kullan.

| Önek | Nerede kurulur | Kanallar |
|---|---|---|
| `ayar:` | `main.js` | `ayar:oku`, `ayar:yaz` |
| `woo:` / `api:` | `main.js` | `woo:istek` (wc/v3), `api:istek` (wc-b2b/v1) |
| `fis:` | `main.js` | `fis:onizleme`, `fis:yazdir`, `fis:pdf`, `fis:kapat` |
| `excel:` | `main.js` | `excel:disaAktar`, `excel:dosyaSec`, `excel:tabloOku` |
| `uygulama:` | `main.js` | `uygulama:bilgi` (gerçek paket sürümü) |
| `byom:` | `src/main/byom.js` | `byom:hwid`, `byom:durum`, `byom:aktive`, `byom:yeniden-dogrula`, `byom:lisans-sil`, `byom:hwid-yenile`, `byom:api-url:oku/yaz`, `byom:baglanti-testi`, `byom:uygulamayi-ac`, `byom:cikis`, `byom:panoya-kopyala`, `byom:dis-baglanti`, `byom:destek:liste/detay/olustur/yanit/secenekler` |
| `byom:telemetri` | `src/main/byom-telemetri.js` | **Tek yönlü** (`ipcMain.on` + `ipcRenderer.send`) — cevap beklenmez |
| `plasiyer:` | `main.js` § 3.6 | `plasiyer:auth` (PIN → oturum), `plasiyer:session` (etkin oturumu sor), `plasiyer:save-session` (SIR OLMAYAN kısmı ayarlara yaz), `plasiyer:get-dealers` (kendi bayileri), `plasiyer:logout` |
| `katalog:` | `main.js` § 3.7 | `katalog:guncelle` (sunucudan eşitle + görsel kuyruğu), `katalog:ara` (**AĞA ÇIKMAZ**, yerel indeks), `katalog:kategoriler`, `katalog:urun`, `katalog:barkod`, `katalog:durum` |
| `gorsel:` | `main.js` § 3.7 | `gorsel:onbellege-al` (indirmeyi tetikle), `gorsel:yol` (yerel `file://` ya da uzak adres — **base64 DÖNMEZ**) |

**Kural:** veri isteyen kanal `handle`/`invoke` (Promise), ateşle-ve-unut olan
kanal `on`/`send`. Telemetri bilinçli olarak `on`/`send`'dir: arayüz beklemez.

---

## 4. Telemetri — sessiz hata avcısı

| Dosya | Kancalar |
|---|---|
| `src/renderer/telemetry.js` | `addEventListener('error')` = *window.onerror karşılığı*, `addEventListener('unhandledrejection')`, kaynak (script/img) yüklenemedi |
| `src/main/byom-telemetri.js` | `byom:telemetri` IPC alıcısı + POST + disk kuyruğu |
| `main.js` | **Mevcut** `process.on('uncaughtException')` / `process.on('unhandledRejection')` kancalarının içine eklenen `telemetri.bildir(...)` satırları + yeni `app.on('render-process-gone')` gözlemcisi |

Uç: `<yapilandirma.apiTabani()>/api/telemetry` → geliştirmede
`http://localhost:3000`, kurulu sürümde `https://hub.byomtech.com`.

**Değiştirirken bozmaman gereken sözler:**
- **Arayüz asla beklemez.** 3000 ms süre aşımı (`AbortController`), zamanlayıcı
  `unref`'li, tek deneme, her hata sessizce yutulur. Hiçbir dalda `await` yok.
- **`window.onerror = …` ATAMASI YAPILMAZ**, dinleyici eklenir — başka bir
  betiğin kurduğu `onerror` ezilmez. `preventDefault()` çağrılmaz: hata
  DevTools konsoluna da basılmaya devam eder. Telemetri **gözlemcidir, filtre değil**.
- **Önce diske, sonra ağa.** `main.js`'teki `dialog.showErrorBox` ana süreci
  **senkron kilitler**; kayıt o kilide girmeden `byom-telemetri-kuyruk.json`'a
  yazılır. Kullanıcı uygulamayı kapatsa bile hata kaybolmaz, sonraki açılışta
  (4 sn gecikmeli) kuyruk boşaltılır.
- **Çökme davranışı değişmedi.** Yeni `process.on` kancası kurulmaz; hata
  diyaloğu, günlük satırları ve uygulamanın ayakta kalma biçimi 2.0.0 ile aynı.
- **Gizlilik:** lisans anahtarı **maskeli** (son 4 hane), künye alanlarını ana
  süreç kendi belleğinden ekler — anahtar arayüz katmanında hiç dolaşmaz.
  Ayar dosyası, müşteri verisi ve Woo anahtarları gitmez.
- Aynı parmak izi 60 sn susturulur; kuyruk 50 kayıtla sınırlı.

Elle bildirim gerekirse: `Telemetri.bildir({ tip: 'elle', mesaj: '…' })`
(arayüz) · `telemetri.bildir('tip', hata, 'panel-main')` (ana süreç).

---

## 4.5 Plasiyer (saha satış) Faz 1 — çift kapılı giriş

Eklenti tarafı (rol, meta, REST, PIN kuralları): **`../CLAUDE.md` §10**.

### Akış
```
lisans doğrulandı → index.html açıldı
   #girisKapisi (kaplama)
      👑 Yönetici   → kaplama kalkar, panel 2.0.0'daki gibi devam eder
      💼 Pazarlamacı → #pinPerde → plasiyer seç + PIN
                       → plasiyer:auth → durum.oturum kurulur
                       → menü daralır, üst barda ad + bölge
```

### Bozmaman gereken sözler
- **MEVCUT AKIŞ DEĞİŞMEDİ.** `baslat()` ve sekme akışına dokunulmaz; kapı bir
  **kaplamadır**. Yönetici kapıyı seçince kaplama kalkar, panel aynen devam
  eder. `sifir-kurulum.test.js`'in kilitlediği açılış dalı korunur.
- **SIFIR KURULUMDA KAPI GÖSTERİLMEZ.** Bağlantı (adres + iki anahtar) yoksa
  pazarlamacı girişi çalışamaz; kapı açmak tıklayınca hata veren bir düğme
  demek olurdu. O durumda doğrudan yönetici akışına geçilir.
- **DURUM ADI TEK:** `durum.oturum = { rol: 'admin'|'plasiyer', id, ad, bolge }`.
  Şartname `appState.currentUser` diyordu; aynı bilgi için iki ad tutmak bu
  depoda iki kez canımızı yakmış hata sınıfıdır (`../BYOM-REGISTRY.md §5.13`).
- **PIN HİÇBİR YERDE SAKLANMAZ.** Arayüz okur → IPC'ye verir → hem değişkeni
  hem input'u temizler. Perde kapanırken de alan silinir.
- **JETON ARAYÜZE GELMEZ.** `plasiyer:auth` yanıtında token alanı yoktur;
  `plasiyer:get-dealers` jetonu ana süreç belleğinden okur. Jeton diske
  **yazılmaz** — uygulama kapanınca oturum düşer.
- **KISITLAMA ÇİFT KATLI:** düğme hem `plasiyer-gizli` ile gizlenir hem
  `disabled` yapılır hem `aria-hidden` alır. Yalnızca CSS ile gizlemek
  klavyeyle (Tab) erişimi açık bırakırdı.
- **GPU DOSTU GEÇİŞLER:** yalnızca `transform` + `opacity` animasyonlanır
  (`#girisKapisi`, `.kapi-kart`, `.ciro-cubuk`). `width/height/top/left` ile
  animasyon her karede reflow tetikler ve eski saha tabletlerinde takılır.
  `prefers-reduced-motion` saygı görür.
- **ÇİFT BAĞLANMA KORUMASI:** `renderer-plasiyer.js → kuruldu` bayrağı ve
  `plasiyer-yonetimi.js → bagli` bayrağı. Olmasa tek tıklama PIN denemesini
  iki kez gönderir ve kaba kuvvet sayacı boşuna ilerlerdi.

### Plasiyer oturumunda açık kalan sekmeler
`PLASIYER_SEKMELERI = ['urunler', 'siparisler']` · kapananlar:
`KISITLI_SEKMELER = ['ayarlar','iskonto','vitrin-editor','uyeler','destek','plasiyerler']`
(ikisi de `renderer-plasiyer.js` başında; değiştirirsen
`plasiyer-kapi.dom.test.js` içindeki `IZINLI`/`KISITLI` listelerini de güncelle).

---

## 4.6 Plasiyer Faz 2 — çevrimdışı katalog ve satış vitrini

Eklenti tarafı (`byom` REST eki, iskonto tavanı): **`../CLAUDE.md` §10**.

### Veri akışı
```
[Kataloğu Eşitle]  → katalog:guncelle → wc/v3/products (100'lük sayfalar)
                      → byom-data/katalog.json + indeksler
                      → görsel kuyruğu (3 eşzamanlı, SHA-256 dedupe)
[Arama / filtre]   → katalog:ara  →  YEREL indeks   (AĞA ÇIKMAZ)
[Sipariş yaz]      → ayarlar.json → plasiyerSiparisKuyrugu  (Faz 3 gönderir)
```

### Bozmaman gereken sözler
- **BOŞ YANIT KATALOĞU SİLMEZ.** Sunucu yetki sorunu yüzünden boş liste
  döndürürse eşitleme BAŞARISIZ sayılır ve mevcut katalog korunur. Aksi hâlde
  internetsiz kalan plasiyer elinde hiçbir ürün olmadan müşterinin karşısında
  kalırdı. (`katalog-depo.test.js` bunu kilitler.)
- **YEREL GÖRSEL YOLLARI EŞİTLEMEDE KORUNUR** — yoksa her eşitlemede bütün
  görseller yeniden inerdi.
- **ŞEMA SÜRÜMÜ UYUŞMAZSA dosya yok sayılır.** Yarı okunmuş bir kayıtla yanlış
  fiyat göstermek, boş başlayıp eşitlemekten kötüdür.
- **KOLİ MATEMATİĞİ YUKARI TAMAMLAR:** 25 adet isteyen bayiye 24 göndermek
  eksik sevkiyattır. `koli_ici_adet ≤ 1` ise tekil adet.
- **SON SİPARİŞ KOPYALANIRKEN BUGÜNÜN FİYATI kullanılır.** Siparişteki fiyat
  geçmişe aittir; onu kopyalamak zam görmüş ürünü zararına satmaktır.
  Katalogda bulunamayan kalem ATLANIR ve kullanıcıya **söylenir**.
- **İSKONTO TAVANI İKİ YERDE:** motor arayüzde anında kırpar,
  `B2B_Plasiyer::iskonto_gecerli_mi` sunucuda son sözü söyler. Bilinçli tekrar:
  biri hız, diğeri güvenlik. Tavan **tanımsızsa SIFIRDIR**, sınırsız değil.
- **GEÇİCİ MÜŞTERİ KİMLİĞİ METİNDİR:** `temp_musteri_<uuid v4>`. Sayısal
  WordPress kimliğiyle karışmaz; eşitleme bu öneke bakar.
- **GPU DOSTU:** kenar çubuğu `translateX` ile kayar (grid sütunu
  animasyonlanmaz), ciro/ilerleme çubukları `scaleX`, kartlar `translateY`.
  Liste `EN_COK_KART` (60) ile kırpılır — 5.000 kartı birden basmak ilk
  boyamayı saniyelere çıkarırdı.
- **GÖRSELLER base64 OLARAK IPC'DEN GEÇMEZ.** Renderer `file://` yolunu
  doğrudan kullanır.

### Klavye akışı (matris modu)
Arama kutusunda **Enter** → matris moduna geç + ilk adet kutusuna odak →
adet yaz → **Enter** → sepete eklenir, odak aramaya döner.
Alan dışında **Tab** görünümü değiştirir; **Esc** ürün/satış penceresini kapatır.

### Faz 2 sınırı — açıkça
Sipariş **yerel kuyruğa** yazılır (`ayarlar.json → plasiyerSiparisKuyrugu`).
Sunucuya gönderen uç (`POST /plasiyer/siparis`) ve eşitleme **Faz 3'tedir**.
Yarım bir gönderim denemek, plasiyerin "kaydettim" sanıp siparişin kaybolmasına
yol açardı; bu yüzden kuyruk açıkça yerel ve görünür tutuluyor.

---

## 5. Hızlı test komutları

İki test kökü var:

- **`test/`** (bu submodule) — panelin kendi birim testleri. `npm test` ile koşar.
- **`../scripts/tests/`** (kök depo) — üç katmanın entegrasyon/DOM/PHP testleri.

İkisini birden `../scripts/check-all.js` koşar (233 test).

```bash
# Bu submodule'un kendi birim testleri (59 test) — Electron GEREKMEZ
npm test
node --test test/telemetri.test.js
node --test test/katalog-depo.test.js       # cevrimdisi katalog: arama, indeks, disk, esitleme
node --test test/plasiyer-siparis.test.js   # koli matematigi, sepet, son siparis, UUID, tavan
node --test --test-name-pattern="AbortSignal" test/telemetri.test.js
```

`test/telemetri.test.js` üretim kodunu değiştirmeden koşar: modül yüklenmeden
önce `require.cache` içine sahte bir `electron` konur (`app.getPath` her teste
taze bir geçici dizin verir, `ipcMain.on` kanalı yakalar) ve küresel `fetch`
testte değiştirilir. `electron` çözülemezse (panelde `npm install`
yapılmamışsa) suite **atlanır**, kırılmaz. Paketlemeye girmez:
`build.files` listesinde `test/` yoktur.

Kök depodaki testler:

```bash
cd ..

# Panelle ilgili TEK testler
node --test scripts/tests/sira-motor.test.js          # domino sıralama motoru
node --test scripts/tests/vitrin-motor.test.js        # vitrin indirgeyici + outbox
node --test scripts/tests/vitrin-editor.dom.test.js   # gerçek index.html + jsdom
node --test scripts/tests/urun-siralama.dom.test.js   # ızgara sürükle-bırak
node --test scripts/tests/depo-fisi.test.js           # fiş muhasebe dökümü
node --test scripts/tests/odeme-matrisi.dom.test.js   # matris arayüzü
node --test scripts/tests/checkout-masasi.dom.test.js
node --test scripts/tests/sifre-goz.dom.test.js
node --test scripts/tests/plasiyer-kapi.dom.test.js   # çift kapılı giriş + rol kısıtlaması
node --test scripts/tests/php-plasiyer-role.test.js   # plasiyer rolü + veri izolasyonu (PHP)
node --test scripts/tests/sifir-kurulum.test.js       # "0 KM" kuralları
node --test scripts/tests/registry-parity.test.js     # 3 registry kopyası eşit mi

# Tek test adı
node --test --test-name-pattern="outbox" scripts/tests/vitrin-motor.test.js

# Sözdizimi (hızlı)
node --check "B2B Yönetim Paneli Klasör/renderer.js"

# Bitirirken: üç katmanın tamamı (233 test)
node scripts/check-all.js
```

**DOM testleri hakkında:** `jsdom` **harici betikleri indirmez** —
`<script src>` etiketleri çalıştırılmaz, yalnızca satır içi betikler çalışır.
Testler ihtiyaç duydukları dosyayı `fs.readFileSync` + `new Function` ile
kendileri enjekte eder. Bu yüzden `index.html`'e yeni bir `<script src>`
eklemek DOM testlerini **etkilemez**; satır içi betik eklemek **etkiler**.

**Test edilebilir kod yazma kalıbı:** saf mantığı `src/renderer/` altına
DOM'suz bir motor olarak koy ve çift modlu dışa ver (`sira-motor.js`,
`vitrin-motor.js`, `telemetry.js` böyle). Böylece aynı dosya hem `<script src>`
hem `node --test` ile çalışır:
```js
if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') module.exports = X;
if (typeof window !== 'undefined') window.X = X;
```

---

## 6. Kodlama standartları

- `'use strict';` her dosyada. Türkçe adlandırma (`bildir`, `durum`, `kaydet`,
  `sureAsimi`) — **yeni kod da Türkçe**.
- Yorumlar **"neden"** anlatır. Sıra/öncelik bağımlılığı varsa yoruma yazılır.
- Dosya başına **kutu başlık** (`/* ===== BAŞLIK ===== */`) + görev listesi;
  uzun dosyada `BÖLÜM n — AD` ayırıcıları. **Bu dosyadaki satır haritası onlardan
  üretildi; yeni bölüm eklersen buradaki tabloyu da tazele.**
- Yol daima `path.join` (Windows + macOS eşit desteklenir), adres daima `URL` /
  `yapilandirma.adresBirlestir` — string birleştirme yok.
- **Üretim günlüğü sessizdir:** `main.js` içinde doğrudan `console.log` **yasaktır**
  (`sifir-kurulum.test.js` bunu kilitler). Akış izi için `gunluk()` kullan —
  paketlenmiş sürümde susar. `console.error` / `console.warn` süzgeçten geçmez
  (destek isteyen kullanıcıdan günlük istenebilmeli).
- **Gömülü müşteri verisi yasak:** mağaza adresi varsayılanı `''`, kaynakta
  serbest posta adresi (`@gmail.`, `@hotmail.`, `@yandex.`) ve geliştirme alanı
  bulunamaz. Demo VKN'ler Maliye kontrol toplamından **geçer**.
- Tekrar çağrılabilen `init()` fonksiyonları **bağlama bayrağı** ile korunur
  (`bagli`, `dataset.izgBagli`) — çift bağlanma tek tıkta iki kez çalışmak demektir.

---

## 7. 🔒 Dokunulmaması gereken kilit alanlar

| Alan | Neden |
|---|---|
| `src/utils/hwid.js` | Kimlik **her açılışta donanımdan yeniden hesaplanır**, hiçbir dosyada saklanmaz. `ÖZETE_GIRENLER` listesine alan eklemek/çıkarmak **sahadaki tüm lisansları geçersiz kılar** ve müşterileri lisans kilidine düşürür. Disk seri no bilerek dışarıdadır (disk değişimi yaygın) |
| `src/main/byom-lisans-deposu.js` | safeStorage/DPAPI şifreleme + HWID HMAC imzası + taşınma tespiti. Dosyayı kopyalamak lisansı taşımaya yetmemeli |
| `src/main/byom-lisans-servisi.js` | Doğrulama/aktivasyon akışı ve durum yorumlama |
| `byom-yapilandirma.js → cevrimdisiIzinGunu()` | 1–30 güne **bilerek** sıkıştırılmış. Sınır kalkarsa ayar dosyasına `99999` yazan biri lisansı süresiz kullanır |
| `byom-api.js → agSorunu` bayrağı | "Sunucuya ulaşılamıyor" ile "sunucu hayır dedi" ayrımı. Karıştırılırsa internet yokken lisans **silinir** |
| Betik yükleme sırası (`index.html`) | → §2 |
| `vitrin-motor.js → demoRegistry()` | Registry'nin 3. kopyası; eklenti ve tema kopyalarıyla **birebir** eşit olmalı (`registry-parity.test.js`) |
| Geliştirici kilidi şifresi (tuzsuz SHA-256, `renderer.js`) | **Kabul edilmiş risk** (`../BYOM-REGISTRY.md §5.20 madde 18`): yerel kaza önleyici, saldırı savunması değil. Değiştirmek mevcut kurulumların şifresini geçersiz kılar |
| `main.js` içindeki küresel hata kancaları | Davranışları (diyalog + günlük) müşteri deneyiminin parçası. Telemetri bunlara **satır ekler**, davranışı değiştirmez |

---

## 8. Bitirme kontrol listesi

```bash
cd .. && node scripts/check-all.js     # 0 hata / 154 php / 60 js / 233 test
```
1. `check-all.js` sıfır hata mı? PHP atlandıysa **söyle**, gizleme.
2. Yeni bölüm/dosya eklediysen bu `CLAUDE.md`'deki satır haritasını tazele.
3. Sürüm artışı `package.json`'da; `BYOM-REGISTRY.md §0` sürüm tablosu da tazelenir.
4. **Önce bu submodule, sonra kök depo** commit edilir. `git push` **yok**.
