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
| **`src/main/byom-yonetici-kilit.js`** | **Yönetici Master PIN + cihaz (saha terminali) kilidi** (Faz 5). Tuzlu scrypt özeti, 3 deneme/60 sn kilit, cihaz rolü geçişleri, **ayar maskeleme/süzme**. DOM'suz + Electron'suz → `node --test` altında koşar. Bkz. §4.9 | — |

`main.js` bölüm haritasına eklenenler:
**`3.6)` Plasiyer kimlik ve veri kapısı** (`plasiyer:*` IPC, oturum belleği → §5) ·
**`3.7)` Çevrimdışı katalog ve görsel önbelleği** (`katalog:*` / `gorsel:*` IPC → §4.6) ·
**`3.8)` Çevrimdışı eşitleme dağıtıcısı** (`sync:*` / `ziyaret:kuyruga` IPC → §4.7).

### 1.2 Arayüz
| Dosya | Sorumluluk | İç bölüm haritası (satır) |
|---|---|---|
| `index.html` (233 KB) | Tüm işaretleme + Tailwind yapılandırması + 4 satır içi betik. **Betik yükleme sırası dosyanın sonundadır ve kritiktir** (→ §2). **Faz 13:** saha perdeleri (`#satisPerde`/`#ziyaretPerde`/`#urunPerde`) `<body>` altındaki `#sahaPerdeleri` kapsayıcısında — **asla bir `.sekme-govde` içine konmaz** (→ §4.17.1); `--logo-height` değişkeni ve `header.h-20 { min-height }` | — |
| `renderer.js` (330 KB) | **Arayüz çekirdeği.** **Faz 13:** `logoGenisligiUygula` `--logo-height` DE yazar (dönüş değeri hâlâ genişlik), Üye Onayları `UYE_ALT_SEKMELER` üç sekme + `sahaMusterileriYukle`/`uyeIletisimHtml` (→ §4.17.6/§4.17.9). Diğer tüm dosyalar buradaki `durum`, `$`, `bildir`, `api/woo/b2b`, `sekmeAc`, `kacis`, `ikon` yardımcılarını kullanır | `1` yardımcılar **14** · `2` demo veri **337** · `3` durum/sabitler **555** · `4` REST köprüsü **1214** · `5` üst çubuk **2083** · `6` sekme yönetimi **2293** · `7` siparişler **2343** (revize **2944**) · `8` ürün & stok **3644** · `9` üye onayları **4613** · `10` depo fişi **5558** · `11` ayarlar **6377** · `12` tema/zoom **7033** · `13` olay bağlama + başlangıç **7096** |
| `renderer-ek.js` (136 KB) | Ek modül — `renderer.js`'ten **SONRA** yüklenir, onun fonksiyonlarını sarar | `0` yardımcılar **23** · `A` ödeme matrisi **100** (kalıcılık **274**, min. sipariş **977**) · `B` sipariş rozeti **1103** · `C` ürün düzenle **1160** · `D` sürükle-bırak sıralama **1956** · `E` ürün silme **2832** · `F` sipariş iptali **2903** · `F2` kalıcı silme **3193** · `G` bayi silme **3272** · `H` olay bağlama **3351** |
| `renderer-izgara.js` (115 KB) | Excel tipi ürün veri ızgarası. `renderer.js` + `renderer-ek.js`'e bağımlı | `0` durum **32** · `A` sanallaştırılmış ızgara **224** · `B` hücre içi düzenleme **663** · `C` kısmi güncelleme **845** · `D` seçim/toplu işlem **958** · `E` kategori ağacı **1725** · `F` görünüm + olay bağlama **2062** · `G` mevcut akışlara bağlanma **2270** · `H` yapışkan haplar/kısayollar **2329** · `I` domino sıralama + 60 FPS **2472** |
| `renderer-excel.js` (41 KB) | Excel dökümü + sütun eşleştirmeli içe aktarma. Izgaranın `izgOlaylariBagla`'sını sarar → ondan **SONRA** | `0` durum **30** · `A` dışa aktarma **90** · `B` eşleştirme sihirbazı **198** · `C` içe aktarma motoru **592** · `D` olay bağlama **1050** · `E` mevcut akışa bağlanma **1125** |
| `renderer-byom.js` (53 KB) | BYOM Brain arayüzü: lisans rozeti + Destek sekmesi. `sekmeAc`/`bildir`'i sarar | — |
| `renderer-vitrin.js` (112 KB) | **Vitrin Editörü arayüzü.** Sürükle-bırak, ayar formları, canlı önizleme iframe'i. EN SONA yüklenir. **Faz 13:** logo boyutu kaydırıcısı Firma Logosu kutusunun altına taşındı + `logoSeridiCiz()` canlı önizleme şeridi (→ §4.17.6) | — |
| `src/renderer/vitrin-motor.js` | **DOM'suz** vitrin motoru: indirgeyici (reorder/toggle/updateSettings/undo/redo), `buildPutBody`, **çevrimdışı outbox**, `demoRegistry()` (**registry'nin 3. kopyası**) | `node --test` altında doğrudan koşar |
| `src/renderer/sira-motor.js` | **DOM'suz** kademeli (domino) taşıma motoru | Izgaradan **ÖNCE** yüklenir |
| **`src/renderer/telemetry.js`** | **Telemetri · arayüz.** EN ÖNCE yüklenir (→ §4) | — |
| **`renderer-plasiyer.js`** | **Çift kapılı giriş + rol kısıtlaması.** Kapı kaplaması, `durum.oturum`, menü daraltma, üst bar, çıkış. EN SONA yüklenir (→ §5) | — |
| **`src/renderer/modules/plasiyer-yonetimi.js`** | **Yöneticinin "Pazarlamacılar" sekmesi:** tanımlama, PIN, bayi atama, performans tablosu + ciro çubuğu, **cihaz tahsis düğmesi** (→ §4.9), **alt sekme denetleyicisi** (Ciro / Harita → §4.10). **Faz 13:** `DONEMLER` sözlüğü + `[Bu Ay][Bu Yıl][Tümü]` çipleri — **tıklamak ağa çıkmaz** (→ §4.17.7). `sekmeAc`'ı SARAR | — |
| **`src/renderer/plasiyer-siparis-motor.js`** | **DOM'suz sipariş motoru** (Faz 2): koli matematiği, sepet indirgeyici, "son siparişi kopyala", geçici müşteri UUID, iskonto tavanı, sipariş gövdesi. **Faz 13:** `kdvOrani(urun)` + sepet `kdvDahil` bayrağı (gövdede `false !== sepet.kdvDahil` — `undefined` KDV dahil sayılır, kuyruktaki eski siparişler kip değiştirmez). `node --test` altında koşar (→ §4.6, §4.17.4) | — |
| **`src/renderer/modules/plasiyer-vitrin.js`** | **Satış vitrini** (Faz 2): daraltılabilir kategori kenar çubuğu, filtre barı, çift görünüm (Vitrin/Matris), SPOT rozeti, ürün detay penceresi, sepet. **Faz 13:** `sonrakiSayfa()` sayfalama + gerçek sayaç metinleri, tek `kodBarkod()` yardımcısı (kart/matris/detay), `Fiyat : ` öneki, `#gorunumAnahtar` **silindi** → `kipIpucu()` (→ §4.17.2/§4.17.3). `sekmeAc`'ı SARAR | — |
| **`src/renderer/modules/plasiyer-musteri.js`** | **Müşteri ve sipariş akışı** (Faz 2): seçim/arama, cari risk uyarısı, çevrimdışı müşteri, son siparişi kopyala, üç ödeme yöntemi + notlar. **Faz 13:** `KDV Tercihi` seçimi + `kdvTahmini`/`kdvOzetBlogu` (ekranda "tahmini" yazar), **müşteri bilgilerini düzenleme** (tek form iki kip: `musteri:kuyrukta-guncelle` / `musteri:guncelle`), `epostaGoster()` `.invalid` yer tutucuyu forma doldurmaz (→ §4.17.4/§4.17.5) | — |
| **`src/renderer/plasiyer-sync-motor.js`** | **DOM'suz eşitleme motoru** (Faz 3): outbox dağıtıcı, kimlik köprüsü, hata toleransı. Ana süreç de `require` eder (→ §4.7) | — |
| **`src/renderer/harita-veri.js`** | **DOM'suz 81 il kütüğü + ziyaret notu mantığı** (Faz 3): plaka/ad/bölge/konum, durum geçişleri, filtreler, yoğunluk. **Gerçek sınır yolları YOK** — gerekçe dosya başlığında (→ §4.8) | — |
| **`src/renderer/harita-yollar.js`** | **81 ilin GERÇEK sınır yolları** (Faz 10, üretilmiş dosya, 58 KB): Natural Earth 1:10m Admin-1 (kamu malı), ISO 3166-2 = plaka, `YOLLAR/MERKEZLER/SINIRLAR/ADLAR`, 1000×420 tuval. **Elle düzenlenmez**; `scratchpad/geo-donustur.js` yeniden üretir. Kokpit açılışta `yollariBesle()` ile `HaritaVeri`ye besler (→ §4.14) | — |
| **`src/renderer/modules/harita-kokpit.js`** | **Faz 13:** yönetici kartı tıklanınca **mevcut** `window.bayiDetayiAc` profil modalı açılır (ikinci kopya yok); saha kabuğunda **bilerek** tıklanamaz (→ §4.17.8). **Türkiye harita kokpiti** (Faz 3): yerel SVG, hover + ipucu, bölünmüş ekran + zoom, uyarı ikonu, tarih/ölçüt filtreleri, not işlemleri. **Faz 10:** `yollariBesle()` — gerçek `<path>` sınırlar. **Faz 12: FABRİKA** `olustur({kip, kapId, onek})` → `window.HaritaKokpit` (yönetici, renk hâkimiyeti + lejant + zengin kartlar) ve `window.SahaHarita` (plasiyer, `plasiyer:harita`, kendi illeri/bayileri, kart kısayolları). `sekmeAc` sarmalı yalnızca saha örneği için (→ §4.16) | — |
| **`src/renderer/modules/plasiyer-ziyaret.js`** | **Saha ziyaret notu** (Faz 3): plasiyerin not girişi (İSTEĞE BAĞLI) + patron yanıtlarının düştüğü bildirim zili. `PlasiyerMusteri.seridiCiz`'i SARAR | — |
| **`src/renderer/modules/plasiyer-siparislerim.js`** | **Kendi Siparişlerim — bağımsız saha şablonu** (Faz 10): `plasiyer:get-orders` ile **sunucudan daraltılmış** liste (`GET /plasiyer/siparislerim`), kartta TEK eylem `[📄 Sipariş / Fiş Detayı]`, kuyruk şeridi (`PlasiyerMusteri.kuyrukSeridiniCiz`). Yönetici sipariş isteği **hiç atılmaz**. `sekmeAc`'ı SARAR (→ §4.14) | — |
| **`src/renderer/siparis-fisi.js`** | **Kurumsal sipariş fişi motoru** (Faz 12, DOM'suz, çift modlu): `normalle` (yönetici / plasiyer / ham `prepare_order`), `html` (A4 / 80 mm termal, inline CSS), `whatsappMetni` (kalın başlıklar, koli×adet, iskontolar, net, ≤ 1800 kr), `waTelefon`, `waAdresi`, `paraYaz`. **Faz 13:** KDV sütunları + `KDV UYGULANMADI` bloğu; **KDV yeniden HESAPLANMAZ**, sunucudan geleni basar (→ §4.17.4). İki kabuk aynı fişi basar (→ §4.16.4) | `node --test` altında koşar |
| **`src/renderer/modules/plasiyer-performansim.js`** | **Performansım** (Faz 11): saha 4. sekmesi — TEK IPC `plasiyer:performans` ile gün/7 gün/30 gün sipariş + net ciro kartları, bayi katkı çubukları (`scaleX`), il dağılımı; yönetici uçlarına gidilmez; `sekmeAc`'ı SARAR (→ §4.15) | — |
| **`src/renderer/modules/plasiyer-otosync.js`** | **Otomatik eşitleme tetikleyicisi** (Faz 4): `online` olayı + 60 sn hafif yoklama + `visibilitychange`. Kuyruk boşsa **ağa çıkmaz**, hata sessizdir (→ §4.7) | — |
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
| `ayarlar.json → plasiyerSiparisKuyrugu` | Yazılmış siparişler. Faz 3 eşitler; **KALICI HATALI kayıt kuyrukta KALIR** (kullanıcı sebebini görsün) |
| `ayarlar.json → plasiyerZiyaretKuyrugu` | Gönderilmemiş saha ziyaret notları (Faz 3) |
| `ayarlar.json → yoneticiPinHash` | **Yönetici Master PIN'in tuzlu scrypt özeti** (Faz 5). Arayüze **hiç gitmez** (`maskele`), `ayar:yaz`'dan **yazılamaz** (`suz`) → §4.9 |
| `ayarlar.json → yoneticiPinDeneme` / `yoneticiPinKilitBitis` | Kaba kuvvet sayacı ve 60 sn kilidin bitiş anı. **Diskte** tutulması bilinçli: bellekte olsa uygulamayı kapatıp açmak sayacı sıfırlardı |
| `ayarlar.json → cihazRolu` | `standart` veya `plasiyer_kilitli` (saha terminali modu) |
| `ayarlar.json → tahsisliPlasiyerId` / `tahsisliPlasiyerAd` | Cihazın tahsis edildiği plasiyer. İkisi de dolu olmadıkça kilit **uygulanmaz** |
| `ayarlar.json → pinKurtarmaDeneme` / `pinKurtarmaKilitBitis` | Sıfırlama kodu için yerel deneme sayacı ve 15 dk kilit (Faz 8). **Korumalı alan** |
| `ayarlar.json → yoneticiPinSifirlamaZamani` | **Denetim izi:** PIN en son ne zaman merkez onayıyla sıfırlandı. Korumalı alan — arayüzden silinemez (→ §4.12) |

---

## 2. Betik yükleme sırası (index.html sonu) — bozulmaz

```
src/renderer/telemetry.js   ← <head>:16, EN ÖNCE: sonraki her betiğin hatasını yakalar
vendor/tailwind.js                                    (49)
renderer.js                 ← çekirdek: durum, $, bildir, api/woo/b2b, sekmeAc   (4190)
renderer-ek.js              ← renderer.js'i sarar     (4193)
src/renderer/sira-motor.js  ← ızgaradan ÖNCE (DOM'suz motor)   (4201)
renderer-izgara.js                                    (4202)
renderer-excel.js           ← ızgaranın olay bağlamasını sarar  (4207)
renderer-byom.js                                      (4209)
src/renderer/vitrin-motor.js                          (4214)
renderer-vitrin.js                                    (4215)
─── Plasiyer Faz 1 ────────────────────────────────────────────
renderer-plasiyer.js        ← kapı + rol kısıtlaması (durum, $, bildir, sekmeAc, kacis)  (4225)
modules/plasiyer-yonetimi.js   ← sekmeAc'ı SARAR      (4226)
─── Plasiyer Faz 2 ────────────────────────────────────────────
src/renderer/plasiyer-siparis-motor.js  ← DOM'suz; vitrinden ÖNCE  (4233)
src/renderer/siparis-fisi.js            ← Faz 12: DOM'suz fiş motoru; modüllerden ÖNCE
modules/plasiyer-vitrin.js  ← sekmeAc'ı SARAR         (4234)
modules/plasiyer-musteri.js ← vitrinin sepetini okur → ondan SONRA (4235)
modules/plasiyer-siparislerim.js ← Faz 10: musteri'nin kuyruk şeridini çağırır → ondan SONRA
modules/plasiyer-performansim.js ← Faz 11: sekmeAc'ı SARAR (renderer.js'ten sonra), siparislerim'in hemen ardından
─── Plasiyer Faz 3 ────────────────────────────────────────────
src/renderer/plasiyer-sync-motor.js  ← DOM'suz        (4245)
src/renderer/harita-veri.js          ← DOM'suz; kokpitten ÖNCE (4246)
src/renderer/harita-yollar.js        ← Faz 10: DOM'suz üretilmiş geometri; harita-veri'den SONRA, kokpitten ÖNCE
modules/harita-kokpit.js    ← sekmeAc'ı SARAR         (4247)
modules/plasiyer-ziyaret.js ← PlasiyerMusteri.seridiCiz'i SARAR → musteri'den SONRA (4248)
─── Plasiyer Faz 4 ────────────────────────────────────────────
modules/plasiyer-otosync.js ← EN SON: sync-motor + durum.oturum hazır olmalı  (4252)
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
| `ayar:` | `main.js` | `ayar:oku` (**maskeli** — PIN özeti gelmez), `ayar:yaz` (**süzgeçli** — korumalı alanlar geçmez → §4.9) |
| `auth:` | `main.js` § 3.9 | `auth:yonetici-pin-durum`, `auth:yonetici-pin-kur`, `auth:yonetici-pin-dogrula`, `auth:yonetici-pin-degistir`, **`auth:pin-kurtarma-talep`**, **`auth:pin-kurtarma-dogrula`** (→ §4.12) |
| `cihaz:` | `main.js` § 3.9 | `cihaz:durum`, `cihaz:kilitle` (plasiyere tahsis), `cihaz:ac` (Master PIN ile kilidi kaldır) |
| `woo:` / `api:` | `main.js` | `woo:istek` (wc/v3), `api:istek` (wc-b2b/v1) |
| `fis:` | `main.js` | `fis:onizleme`, `fis:yazdir`, `fis:pdf`, `fis:kapat` |
| `excel:` | `main.js` | `excel:disaAktar`, `excel:dosyaSec`, `excel:tabloOku` |
| `uygulama:` | `main.js` | `uygulama:bilgi` (gerçek paket sürümü) |
| `byom:` | `src/main/byom.js` | `byom:hwid`, `byom:durum`, `byom:aktive`, `byom:yeniden-dogrula`, `byom:lisans-sil`, `byom:hwid-yenile`, `byom:api-url:oku/yaz`, `byom:baglanti-testi`, `byom:uygulamayi-ac`, `byom:cikis`, `byom:panoya-kopyala`, `byom:dis-baglanti`, `byom:destek:liste/detay/olustur/yanit/secenekler` |
| `byom:telemetri` | `src/main/byom-telemetri.js` | **Tek yönlü** (`ipcMain.on` + `ipcRenderer.send`) — cevap beklenmez |
| `plasiyer:` | `main.js` § 3.6 | `plasiyer:auth` (PIN → oturum), `plasiyer:session` (etkin oturumu sor), `plasiyer:save-session` (SIR OLMAYAN kısmı ayarlara yaz), `plasiyer:get-dealers` (kendi bayileri), `plasiyer:logout`, **`plasiyer:get-orders`** (Faz 10: `GET /plasiyer/siparislerim`, jeton bellekten — kendi siparişleri **sunucuda** daraltılır), **`plasiyer:performans`** (Faz 11: `GET /plasiyer/performans`, kimlik + jeton oturumdan), **`plasiyer:harita`** (Faz 12: `GET /plasiyer/harita` — kendi sorumlu illeri + kendi bayileri; `gun`/`tarih` arayüzden) |
| `katalog:` | `main.js` § 3.7 | `katalog:guncelle` (sunucudan eşitle + görsel kuyruğu), `katalog:ara` (**AĞA ÇIKMAZ**, yerel indeks; **Faz 13:** yanıt `toplam` + `ofset` taşır → §4.17.2), `katalog:kategoriler`, `katalog:urun`, `katalog:barkod`, `katalog:durum` |
| `gorsel:` | `main.js` § 3.7 | `gorsel:onbellege-al` (indirmeyi tetikle), `gorsel:yol` (yerel `file://` ya da uzak adres — **base64 DÖNMEZ**) |
| `sync:` | `main.js` § 3.8 | `sync:esitle` (kuyruğu boşalt — **sıra: müşteri → köprü → sipariş → not**), `sync:durum` (bekleyen/hatalı sayıları) |
| `ziyaret:` | `main.js` § 3.8 | `ziyaret:kuyruga` (notu **önce diske** yaz) |
| `siparis:` / `musteri:` | `main.js` § 3.8 | `siparis:kuyruga`, `musteri:kuyruga` (Faz 9: kuyruğa ekleme ana süreçte, oku-değiştir-yaz yarışı yok), **`musteri:esitle-tek`** (Faz 10: çevrimiçiyken tek müşteriyi hemen `POST /plasiyer/musteri-esitle`; başarıda `senkron/gercekId` işaretlenir, kayıt bir sonraki turda köprülenir/temizlenir), **`musteri:kuyruktan-sil`** (Faz 11: yalnızca `temp_musteri_` + eşitlenmemiş kayıt; bekleyen sipariş/not varsa RET), **`musteri:kuyrukta-guncelle`** (Faz 13: ÇEVRİMDIŞI kaydı cihazda düzenler — kimlik `GECICI_ONEK` ile başlamalı ve kayıt eşitlenmemiş olmalı; **beyaz listeli alanlar**, `id`/`gecici`/`senkron`/`gercekId` gövdeden ALINMAZ, mevcut kayıttan geri yazılır), **`musteri:guncelle`** (Faz 13: sunucudaki bayi → `POST /plasiyer/musteri-guncelle`; `plasiyerId`/`token` ana süreç belleğinden EZİLİR) |

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
**→ FAZ 6'DA DEĞİŞTİ, tam liste §4.10'da.** Özet:
`ROL_SEKMELERI.plasiyer = ['satis','siparisler','notlarim']` (3 sekme) ·
`ROL_SEKMELERI.admin` 8 sekme. Yasak liste artık **DOM'dan türetilir**,
elle tutulan ikinci bir liste YOK. Değiştirirsen `plasiyer-kapi.dom.test.js`
içindeki `IZINLI`/`KISITLI`/`YONETICI_IZINLI`/`YONETICI_KISITLI` listelerini de
güncelle.

**`urunler` Faz 2'de KISITLIYA GEÇTİ:** plasiyer artık yönetici ürün ızgarasını
değil `satis` (Satış Vitrini) sekmesini görür. Izgarada fiyat/stok **yazma**
yetkisi var; plasiyerin işi satmak, katalog düzenlemek değil. `harita` Faz 3'te
eklendi — kokpit bütün illerin cirosunu gösterir, yani **diğer plasiyerlerin
verisi**.

### 4.5.1 Giriş kapısı hata düzeltmesi (Faz 4) — OKUMADAN DEĞİŞTİRME

`npm start` ile gerçek Electron'da panel **açılışta kilitleniyordu**: altı
kaplama (`girisKapisi`, `pinPerde`, `urunPerde`, `satisPerde`, `ziyaretPerde`,
`plasiyerFormPerde`) üst üste görünüyordu.

**Sebep — Tailwind özgüllük tuzağı:**
```
Tailwind preflight:  [hidden] { display: none }      ← (0,1,0), ÖNCE gelir
Tailwind utility:    .grid   { display: grid }       ← (0,1,0), SONRA gelir
```
Özgüllükler **eşit**; kaynak sırası gereği utility kazanır. Yani
`<div hidden class="… grid …">` **görünür**. Aynı tuzağa bu depoda daha önce de
düşülmüş (`index.html:2573`, vitrin editörü).

**Çözüm (`index.html`, satır içi `<style>`):**
```css
[hidden] { display: none !important; }
```
Tek satır, bütün kaplamaları birden kurtarır. **KALDIRMA.** `hidden` özniteliği
ile `display` utility'sini aynı etikete koyan her yeni kaplama bu satır olmadan
açılışta ekranda patlar.

**jsdom bunu NEDEN yakalamadı:** `el.hidden` değeri doğruydu; yanlış olan
yalnızca hesaplanmış CSS'ti ve jsdom basamaklı stili (cascade) tam
uygulamaz. Bu yüzden test artık **kaynak düzeyinde** denetliyor: kuralın
`index.html` içinde bulunduğunu ve `hidden` ile başlayan her kaplamayı
(`plasiyer-kapi.dom.test.js`).

**Modalın kapalı başlaması + çıkışlar:**
- Pazarlamacı modalı (`#pinPerde`) açılışta **`display:none`**; ekranda yalnızca
  iki büyük kart vardır.
- **`[👑 Yönetici Girişi]` HİÇBİR İSTEK ATMAZ.** Kaplama anında kalkar; plasiyer
  listesi/ağ beklenmez. Test bunu `rest.asla` ile kilitler — sunucusu kapalı
  bir mağazada yönetici paneli açamamak kabul edilemezdi.
- Modalın **üç çıkışı** var: sağ üst `[✕]`, altta
  `[← Geri Dön / Yönetici Girişi]` (`#pinGeri`), perdeye (backdrop) tıklama ve
  **ESC**. Backdrop denetimi `if (olay.target === pinPerde)` — karta tıklayınca
  kapanmaz.
- **Kapanışta alanlar sıfırlanır** (seçim, PIN, hata metni); yarım kalmış bir
  PIN denemesi bir sonraki açılışa taşınmaz.
- **3 SANİYE SÜRE AŞIMI:** `LISTE_SURE_ASIMI_MS = 3000`, `sureAsimiyla()` ile
  `Promise.race`. Sunucu yanıt vermezse **veya kayıtlı plasiyer yoksa** tek
  mesaj gösterilir: *"Henüz kayıtlı pazarlamacı bulunamadı. Lütfen Yönetici
  Girişi yaparak plasiyer tanımlayın."* Modal **asılı kalmaz**.
  Süre aşımı yarışını kaldıran mutasyon testte **donma** ürettiği için
  (kullanıcının bildirdiği belirtinin aynısı) bu yarış korunmalıdır.
- **PIN'i olmayan plasiyer listede gösterilmez** — seçilse giriş yapamazdı.

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

## 4.7 Plasiyer Faz 3 — çevrimdışı eşitleme (Outbox Dispatcher)

Eklenti tarafı (`/plasiyer/siparis`, `/plasiyer/musteri-esitle`): **`../CLAUDE.md` §10**.

### SIRA DEĞİŞTİRİLEMEZ
```
1) MÜŞTERİLER   temp_musteri_<uuid> → gerçek user_id
2) KİMLİK KÖPRÜSÜ  bekleyen siparişlerdeki geçici kimlikler DEĞİŞTİRİLİR
3) SİPARİŞLER   ancak şimdi gönderilebilir
4) NOTLAR       sıradan bağımsız, en az acil
```
Sunucu geçici kimlikli siparişi **409 ile reddeder**
(`B2B_REST_Plasiyer::siparis_olustur`). Yani sıra yanlışsa siparişler sessizce
değil **görünür** biçimde başarısız olur.

### Hata toleransı
- **Ağ hatası / 5xx → kayıt BEKLER**, sonraki turda tekrar denenir; kullanıcıya
  gürültü yapılmaz.
- **4xx → KALICI HATA.** 50 kez aynı 400'ü almanın anlamı yok; kayıt kuyrukta
  kalır ama bir daha denenmez ve sebebi gösterilir. **409 İSTİSNA**: "önce
  müşteriyi eşitle" demektir, sıradaki turda düzelebilir.
- `EN_COK_DENEME` (5) dolunca da kalıcı hata.
- **Bir kaydın patlaması turu DURDURMAZ** — sıradakine geçilir.
- **Müşterisi hâlâ geçici olan sipariş GÖNDERİLMEZ** (deneme sayacı boşa yanmaz).
- **KALICI HATALI KAYIT KUYRUKTA KALIR.** Sessizce silmek, plasiyerin yazdığı
  siparişin kaybolduğunu kimsenin fark etmemesi olurdu.

### Otomatik eşitleme (Faz 4) — `modules/plasiyer-otosync.js`
Plasiyerin "Eşitle" düğmesine basmayı hatırlaması gerekmez. **Dört tetik:**
```
1) window 'online' olayı   → 1500 ms gecikmeyle (ONLINE_GECIKME_MS)
2) 60 sn hafif yoklama      → YOKLAMA_MS
3) 'visibilitychange'       → uygulamaya geri dönünce (uyku/kilit sonrası)
4) açılıştan 8 sn sonra     → tek sefer
```
- **`online` olayına 1500 ms GECİKME bilinçlidir.** Windows olayı ateşlediğinde
  DNS/yönlendirici henüz hazır olmayabilir; anında denemek ilk turu boşa yakar.
- **Yoklama HAFİFTİR, AĞA ÇIKMAZ:** `sync:durum` yerel kuyruk sayılarını okur;
  `PlasiyerSyncMotor.esitlemeGerekliMi()` bekleyen kayıt yoksa **hiç istek
  atılmaz**. Boş kuyrukta 60 saniyede bir sunucuyu dürtmek sahadaki mobil
  bağlantıyı bedava tüketirdi.
- **SESSİZ BAŞARISIZLIK.** Eşitleme patlarsa kullanıcıya bildirim **çıkmaz**;
  bildirim yalnızca `ozetMesaji` doluyken gösterilir
  (*"X adet bekleyen sipariş merkeze iletildi"*). Ağı olmayan plasiyere her
  dakika kırmızı uyarı basmak paneli kullanılamaz hâle getirirdi.
- **Yalnızca plasiyer oturumunda çalışır** — yönetici oturumunda kuyruk yoktur.

### Kuyruklar (`ayarlar.json`)
`plasiyerYerelMusteriler` · `plasiyerSiparisKuyrugu` · `plasiyerZiyaretKuyrugu`
Diskte olmaları bilinçli: uygulama kapanırsa sahada yazılmış sipariş kaybolmaz.
Jeton ise **belleğe** bağlıdır (§5) — oturum düşmüşse eşitleme "PIN gerekiyor"
der ve kuyruğa **dokunmaz**.

---

## 4.8 Türkiye Harita Kokpiti (Faz 3)

### ⚠️ GEOMETRİ — DÜRÜST NOT, OKUMADAN DEĞİŞTİRME
`harita-veri.js` **gerçek il sınır poligonları İÇERMEZ.** 81 ilin sınır yolu
(~100 KB ölçülmüş coğrafi veri) bellekten üretilemez; üretilse harita tanınmaz
bir karalamaya döner. Onun yerine her il **gerçeğe yakın coğrafi konumunda bir
kutu** olarak çizilir (kartogram / tile-map üslubu) — konum ilişkisi doğru,
sınır şekli şematiktir. Test bu ilişkiyi denetler (İzmir Van'ın batısında,
Sinop Antalya'nın kuzeyinde…).

**Gerçek sınırlara geçiş — TEK KAPI:**
```js
HaritaVeri.yollariYukle({ 35: 'M180,230 L…', 'Ankara': 'M…' });
```
`il.yol` dolu olduğunda kokpit `<rect>` yerine `<path>` basar. **Başka hiçbir
yer değişmez**: hover, ipucu, bölünmüş ekran, zoom, uyarı ikonu, filtreler iki
kaynakta da aynı çalışır. Yol **beslenmediği sürece** kokpit ekranda
*"Şematik görünüm"* notu gösterir — kullanıcı gerçek sınır sanmasın.

### Kutu boyutu (Faz 4) — ÇAKIŞMA DÜZELTMESİ
`harita-kokpit.js → var KUTU = { w: 22, h: 13 }` (önce 26×15'ti).
26×15'te **7 il çifti üst üste biniyordu** (Ağrı/Iğdır, Bingöl/Tunceli,
Kastamonu/Karabük, Kocaeli/Yalova, Nevşehir/Aksaray, Siirt/Batman,
Zonguldak/Bartın) — haritada iller birbirini yiyordu. Kutu küçültüldü ve kalan
üç çakışma için konum düzeltildi:
`Tunceli → 752,203` · `Yalova → 262,136` · `Aksaray → 494,236`.

**`KUTU`'yu büyütürsen çakışmayı geri getirirsin.** `harita-kokpit.dom.test.js`
81 kutunun hepsini çiftler hâlinde karşılaştırır (`cakisan kutu YOK`) ve
kaynaktan `KUTU` sabitini okur — sabiti değiştirmek testi kandırmaz, çakışan
çifti **adıyla** yüzüne söyler. Aynı test kutuların `1000×420` tuvalin içinde
kaldığını da kilitler.

### Davranış
- **Harici bağımlılık SIFIR.** İnternet ya da Google Maps gerekmez; SVG yerel.
- **Hover** → il marka rengine boyanır + hafif `scale`. **İpucu kartı** il adı,
  bölge, bayi sayısı/adları, sipariş, ciro ve açık not sayısını gösterir.
- **Bölünmüş ekran:** ile tıklanınca sol tarafa o il `transform: scale/translate`
  ile büyür (komşular soluk arka plan), sağ tarafa bayiler + ziyaret notları
  gelir. Sol üstte "← Türkiye Haritasına Dön".
- **Çözülmemiş not** olan ilin merkezinde **yanıp sönen kırmızı `!`**; sol
  menüdeki "Pazarlamacılar" düğmesinde kırmızı sayaç rozeti.
- **Filtreler:** Bugün / Bu hafta / Bu ay / Tümü · ölçüt Ciro / Sipariş / Bayi.
- **GPU:** yalnızca `transform`, `opacity`, `fill` animasyonlanır. **`viewBox`
  animasyonlanMAZ** — her karede düzen hesabı tetiklerdi.
- Klavye: il kutuları `tabindex` alır, Enter/Space ile açılır.

### Ziyaret notu döngüsü
```
plasiyer [📝 Saha Ziyaret Notu]  (İSTEĞE BAĞLI, zorunlu değil)
   → ziyaret:kuyruga (ÖNCE DİSKE) → sync:esitle
patron  harita → il → not → [Gördüm] / [Çözüldü] / [Yanıt Yaz]
   → kırmızı ! yeşile döner / kaybolur
plasiyer 🔔 bildirim zili → patron yanıtını okur
```
- **Durum ILERI gider, GERİYE GİTMEZ** (`beklemede → gorundu → cozuldu`).
  Çözülmüş notu geri almak haritadaki uyarıyı yeniden yakardı. Kural **iki
  yerde**: `harita-veri.js → ilerleyebilirMi` (arayüz düğmeyi göstermez) ve
  `B2B_Ziyaret::durum_ilerlet` (sunucu reddeder).
- **"gorundu" DA ÇÖZÜLMEMİŞTİR:** patron okudu ama iş bitmedi; sayaç düşmez.
- **BOŞ not kabul edilmez** (ne etiket ne metin) — haritada sebepsiz kırmızı
  uyarı yakmak patronun güvenini boşa harcar.

---

## 4.9 Yönetici Master PIN ve Cihaz Kilidi (Faz 5)

Sahaya verilen laptopta plasiyerin yönetici ekranına geçmesini engeller.
Motor: **`src/main/byom-yonetici-kilit.js`** · IPC: **`main.js` § 3.9**.

### Akış
```
PIN YOK      → 👑 Yönetici Girişi → "Yönetici Master PIN Belirleyin (6 Haneli)"
                                    (PIN + TEKRAR kutusu) → kaydet → panel
PIN VAR      → 👑 Yönetici Girişi → 6 hane sor → doğru → panel
                                              → 3 hatalı → 60 sn kilit
CİHAZ KİLİTLİ → iki kart YOK, yönetici kapısı YOK
                "[Ad] — Saha Satış Terminali" + doğrudan PIN ekranı
                sağ üstte discreet 🔓 → Master PIN → standart moda dön
```

Kilitleme: yönetici → **Pazarlamacılar** → satırdaki
`[🔒 Bu Cihazı Tahsis Et]` → onay → `cihaz:kilitle`.

### ⚠️ DÜRÜST SINIR — "güvenli" demeden önce oku
`ayarlar.json` **düz metin** bir dosyadır. Bu kilit, cihazı eline alan
plasiyerin **arayüzden** yönetici ekranına geçmesini engeller; **dosya
sistemine erişen birine karşı mutlak değildir** — dosyayı elle düzenleyip
`cihazRolu`'nü değiştiren ya da `yoneticiPinHash`'i silip PIN'i yeniden kuran
biri kilidi aşar. 6 hane (10⁶) dosyayı kopyalayan için çevrimdışı denemeye de
açıktır; scrypt yavaşlatır, imkânsız kılmaz.

Bu, lisans deposundan (`byom-lisans-deposu.js`) **bilinçli olarak farklı** bir
tehdit modelidir: orada korunan şey firmanın parasıdır ve safeStorage/HWID
imzası kullanılır. Burada korunan şey *"çalışan yanlış ekranı açmasın"*dır.
Daha güçlüsü isteniyorsa ayar dosyasını HWID-HMAC ile imzalamak gerekir —
**ayrı bir görev**, çünkü ayar dosyasını elle düzeltebilmek şu anda destek
sürecinin parçası.

### Bozmaman gereken sözler
- **DOĞRULAMA ARAYÜZDE YAPILMAZ.** `nodeIntegration: true` olduğu için
  renderer'da yazılan her karşılaştırma aynı konsoldan atlatılabilir. PIN
  `auth:*` / `cihaz:*` kanallarıyla ana sürece gider, arayüz yalnızca
  "oldu/olmadı" alır.
- **PIN ÖZETİ ARAYÜZE HİÇ GELMEZ.** `ayar:oku` → `maskele()`: `yoneticiPinHash`
  silinir, yerine `yoneticiPinKurulu` bool'u konur. Yanıtlarda da `yazilacak`
  alanı arayüze gönderilmez (içinde özet olabilir).
- **KORUMALI ALANLAR `ayar:yaz`'DAN GEÇMEZ** (`suz()`): `yoneticiPinHash`,
  `yoneticiPinDeneme`, `yoneticiPinKilitBitis`, `cihazRolu`,
  `tahsisliPlasiyerId`, `tahsisliPlasiyerAd`. **Kilidin tamamı buna dayanıyor:**
  `ayar:yaz` genel amaçlı bir kanal, açık kalsaydı kilitli cihazdaki biri tek
  satırla `{ cihazRolu: 'standart' }` yazıp yönetici kapısını geri açardı.
  Süzgeç **IPC sınırında** durur; içerideki `ayarlariYaz()` çağrıları süzülmez
  (kilidi yazan kod onları kullanıyor).
- **TUZLU scrypt**, tuzsuz SHA-256 değil. Depodaki geliştirici kilidi tuzsuz
  SHA-256 kullanıyor ve bu "kabul edilmiş risk" olarak kayıtlı
  (`../BYOM-REGISTRY.md §5.20 madde 18`); **yeni** bir güvenlik kontrolünde o
  kalıp tekrar edilmez. `N=16384, r=8, p=1` → ~16 MB / ~60 ms. **DÜŞÜRME.**
- **DENEME SAYACI DİSKE YAZILIR**, belleğe değil. Bellekte tutulsa uygulamayı
  kapatıp açmak sayacı sıfırlardı; saha laptopunda bu "kilit yok" demektir.
- **KİLİT, PIN KONTROLÜNDEN ÖNCE BAKILIR.** Sonra bakılsaydı doğru PIN'i bulan
  biri 60 saniye kuralını hiç görmeden geçerdi.
- **PIN'SİZ CİHAZ KİLİTLENEMEZ.** Kilidi açmanın tek yolu Master PIN; PIN'siz
  kilitlemek cihazı geri dönüşsüz kilitlerdi (uygulamayı silmekten başka çıkış
  kalmazdı). Aynı sebeple ilk kurulumda **TEKRAR kutusu zorunlu**.
- **KİLİTLİ CİHAZDA PIN PENCERESİ KAPANMAZ.** `pinPerdesiniKapat()` başındaki
  tek `if (cihaz.kilitli) return;` satırı üç kaçışı birden kapatır: ✕,
  perdeye tıklama, ESC. Kapanabilseydi plasiyer PIN girmeden arkadaki panele
  düşerdi. Ayrıca kapı kaplaması opak olarak **ayakta kalır** (iki katman).
- **KİLİTLİ CİHAZDA AĞA ÇIKILMAZ.** Tahsisli plasiyer ayarlardan bilinir;
  `/admin/plasiyerler` çağrılmaz — internetsiz sahada da açılmalı.
- **TAHSİS BİLGİSİ EKSİKSE KİLİT UYGULANMAZ.** Adı/kimliği olmayan bir kilit,
  kimsenin giremediği bir cihaz demekti.
- **KİLİT AÇMA EKRANI SAYAÇTAN MUAF DEĞİL** — `cihaz:ac` de `pinDene`'den geçer.
- **Kilit açılınca plasiyer jetonu düşürülür** (`plasiyerOturumu = null`): cihaz
  artık o kişiye tahsisli değil, açık jetonla veri çekmeye devam etmemeli.

### 4.9.1 AÇILIŞ SIRASI HATASI — kapı gerçek uygulamada görünmüyordu
`renderer.js` ayarları `await ipcRenderer.invoke('ayar:oku')` ile çeker ve
`durum.ayarlar` o iş bitene kadar **null**'dır. Her iki dosya da
`DOMContentLoaded`'a bağlı olduğu için `renderer-plasiyer.js` ayarlar gelmeden
çalışıyor, `baglantiVar()` boş nesne görüp `false` dönüyor ve kapı kendini
gizliyordu — **çift kapı üretimde hiç görünmüyordu.**

Testler yakalamıyordu çünkü `durum.ayarlar`'ı **önceden dolduruyorlar**. Faz
4'e kadar `[hidden]` CSS hatası kapıyı zorla görünür tuttuğu için belirti de
maskeliydi; o hata düzeltilince ortaya çıktı.

**Çözüm (`baslat`):** ayarlar hazırsa **senkron** devam (hızlı yol ve test yolu
aynı kalır), değilse `ayar:oku`'yu kendisi okuyup bekler (3 sn süre aşımıyla).
Cihaz kilidi de aynı nesneden geldiği için **tek IPC turu üç soruyu birden**
cevaplar. `ortamKurAyarsiz()` yardımcısı artık üretim sırasını test eder.

---

## 4.10 Menü hiyerarşisi, rol izolasyonu ve çıkış (Faz 6)

### İKİ FARKLI DÜNYA
> **FAZ 7'DE TAŞINDI:** izin listesi artık JS'te değil **DOM özniteliğinde**
> (`data-rol-izin`). Sebebi ve tam kural **§4.11.1**'de — önce onu oku.

```html
<!-- index.html, sol menü -->
<button data-sekme="siparisler" data-rol-izin="admin plasiyer">  <!-- ikisine de -->
<button data-sekme="urunler"    data-rol-izin="admin">           <!-- 8 yönetici -->
<button data-sekme="satis"      data-rol-izin="plasiyer">        <!-- 3 saha -->
```
Yönetici 8 sekme · Plasiyer 3 sekme. İzinli/yasak iki ayrı liste **yok**;
ikisi de DOM'dan türetilir (`rolSekmeleri` / `kisitliSekmeler`), yani asla
birbirinden ayrışamaz.

**YÖNETİCİ DE KISITLANIR** (Faz 6'nın asıl değişikliği): `satis` yöneticiden
gizlenir. O ekran plasiyerin saha dünyasıdır; yöneticinin depo/onay dünyasında
durması iki dünyayı iç içe geçiriyordu.

Plasiyer dünyasında ayrıca:
- **Etiket:** `siparisler` → "Kendi Siparişlerim" (`PLASIYER_ETIKET`). Çıkışta
  geri alınır (`ozgunEtiketler` bir kez saklanır).
- **Sıra:** flex `order` ile Katalog başa alınır (`PLASIYER_SIRA`). DOM'u
  taşımak yöneticinin sırasını bozardı.
- **Giriş sekmesi:** başarılı PIN'den sonra `sekmeAc('satis')`. Karar
  `pinGirisDene` içinde verilir, `kisitlamayiUygula` içinde **değil** — o
  fonksiyon her yeniden çizimde çalışır ve gereksiz sekme değişimi veri yükleme
  turu tetiklerdi.
- **`data-rol` iki yönlü:** `data-rol="admin"` ve `data-rol="plasiyer"` artık
  ikisi de var; işaretli düğüm YALNIZCA kendi rolünde görünür. Oturum yokken
  ikisi de gizlenir.

### Saha Haritası → alt sekme
Sol menüdeki bağımsız "Saha Haritası" düğmesi **kaldırıldı**; harita
"Pazarlamacılar" sekmesinin alt sekmesi oldu:
`[👥 Pazarlamacılar & Ciro] | [🗺️ Saha Ziyaret Haritası]`.

- Denetleyici: `plasiyer-yonetimi.js → altSekmeAc()`. Düğmeler `menu-btn`
  **değil** (`plasiyer-alt`) — `sekmeAc` yalnızca `.menu-btn` düğümlerini boyar.
- Durum **`aria-selected`** ile taşınır, CSS onu izler. Sınıf ve öznitelik ayrı
  yönetilseydi ekran doğru görünürken ekran okuyucu yanlış söylerdi.
- **`sekmeAc('harita')` GERİYE DÖNÜK ÇALIŞIR:** `plasiyerler`'e yönlendirir ve
  harita alt sekmesini açar. Eski bir çağrının sessizce hiçbir şey yapmaması en
  kötü hata türüdür.
- **`harita-kokpit.js`'teki `sekmeAc` sarmalı KALDIRILDI — geri ekleme.** Bu
  dosya `plasiyer-yonetimi.js`'ten **sonra** yüklendiği için zincir
  `harita-kokpit → plasiyer-yonetimi → özgün` olur; alt sekme denetleyicisi bir
  kez, sarmal ikinci kez çağırırdı → her açılışta **çift `/admin/harita`
  isteği**. Test bunu istek SAYISIYLA kilitler.
- Haritada "Yenile / + Yeni Pazarlamacı" **gizlenir**: görünür ama işlevsiz
  düğme kullanıcıya yalan söyler.
- Çözülmemiş not rozeti **iki yerde, tek sayıdan**: sol menüdeki "Pazarlamacılar"
  rozeti ("bu sekmede acil bir şey var") + alt sekme rozeti ("hangisinde").

### Çıkış Yap — tek kanonik çıkış
`#cikisYapDugme`, sol menünün altında, **her iki rolde aynı yerde**, oturum
yokken de DOM'da.

- **`menu-btn` DEĞİL:** sekme değil bir eylem. `menu-btn` olsaydı `sekmeAc` onu
  da boyamaya çalışır ve rol süzgeci onu bir sekme sanıp gizleyebilirdi.
- **`mt-auto` bilinçli olarak iki yerde** (ayarlar + çıkış): yönetici
  oturumunda "API & Sistem Ayarları" boşluğu yutar ve çıkış onun altına oturur;
  plasiyerde o düğme `display:none` olduğu için flex düzenine girmez ve boşluğu
  çıkış yutar. Tek kural, iki rol.
- **Üst bardaki ikinci çıkış düğmesi KALDIRILDI.** Faz 1'de üst bara bir "Çıkış
  Yap" konmuştu; aynı eylemin iki yerde durması kullanıcıyı "hangisi gerçek?"
  diye düşündürüyordu. Üst barda kalan şey **bilgi** (ad + bölge), eylem değil.
- `cikisYap()` sırası: jeton iptali → `durum.oturum = null` → kısıtlamayı
  yeniden uygula (etiket/sıra/üst bar geri alınır) → `ypinKapat()` → kapı.
- **Kilitli cihazda kapı terminal biçiminde açılır** (o plasiyerin PIN ekranı),
  çift kapı **değil** — çift kapıya dönmek kilidi delmek olurdu.

### "Kendi Siparişlerim" süzgeci
`renderer.js → siparisleriSuz()` → `PlasiyerSiparisMotor.kendiSiparisleri()`.

`siparisleriYukle()` Faz 6'ya kadar **hiçbir rol süzgeci uygulamıyordu**:
plasiyer "Siparişler"e basınca bütün şirketin siparişlerini görüyordu. Artık
`_b2b_plasiyer_id` damgasına göre süzülür (panele eklentinin `plasiyer_id`
alanıyla gelir — **eklenti 2.15.0**; `prepare_order` daha önce `meta_data`
döndürmediği için panel bu bilgiyi hiçbir yerden öğrenemiyordu).

- Süzgeç `siparisleriCiz()` içinde **EN ÖNCE** uygulanır: özet kartlar, sayaçlar
  ve boş durum metni de ekranda GÖRÜNEN listeyi anlatmalı.
- **Kimlik bilinmiyorsa BOŞ liste** döner. "Bilmiyorum" hâlinde her şeyi
  göstermek, tam olarak engellemeye çalıştığımız sızıntı olurdu. Motor
  yüklenmemişse de boş döner (güvenli taraf).
- Bayinin kendi sitesinden verdiği sipariş bu listede **yoktur** — aynı kural
  ciro istatistiğinde de geçerli (`B2B_Plasiyer::get_plasiyer_stats`). İki yerde
  iki farklı "benim siparişim" tanımı üretmemek için bilinçli olarak aynı damga.

> ### ⚠️ BU BİR GÖRÜNÜM SÜZGECİDİR, YETKİ SINIRI DEĞİLDİR
> Panel mağaza anahtarlarını (CK/CS) taşır; veri cihaza zaten iniyor ve mimari
> bunu baştan kabul ediyor (`../CLAUDE.md §10` — "PIN bir yetki aracı
> DEĞİLDİR"). Çözülen sorun: plasiyer **ekranında** patronun siparişlerinin
> görünmesi. Sızıntıyı tamamen kapatmak için sunucuda plasiyere daraltılmış bir
> uç gerekir (`/plasiyer/siparislerim`) — **ayrı iş**, `../BYOM-REGISTRY.md
> §5.29`'da açık kalem olarak kayıtlı. **→ FAZ 10'DA KAPANDI:** `GET /plasiyer/siparislerim`
> + bağımsız `#sekme-siparislerim` şablonu; yönetici sipariş listesi sahada hiç istenmez (§4.14).

---

## 4.11 Faz 7 — canlı hata düzeltmeleri (REST adres, kart düzeni, rol özniteliği, PIN)

### 4.11.1 🔴 `sekmeAc` rol gizlemesini SİLİYORDU — en önemli düzeltme
Kullanıcı yönetici girişinde sol menüde "Katalog & Sipariş Yazma" ve
"Saha Notlarım / CRM" görüyordu. Sebep:

```js
renderer.js → sekmeAc():
    btn.className = 'menu-btn text-left px-5 py-6 ...'   ← ATAMA
```
**`className` ataması bütün sınıf listesini değiştirir.** Faz 6'da gizleme
`plasiyer-gizli` SINIFI ile yapılıyordu; kullanıcı herhangi bir menüye
tıkladığı anda sınıf siliniyor ve gizli sekmeler geri geliyordu. `disabled`
(özellik) sağ kaldığı için sekmeler "görünür ama tıklanamaz" oluyordu.

**Çözüm — izin ve gizleme ÖZNİTELİKTE** (öznitelikler atamadan sağ kalır):
```
izin    : <button data-rol-izin="admin">           ← işaretleme, TEK KAYNAK
          <button data-rol-izin="admin plasiyer">  ← boşlukla ayrılmış liste
gizleme : <button data-rol-gizli="1">              ← çalışma zamanı
CSS     : [data-rol-gizli="1"] { display:none !important }
```
- **TEK DOĞRULUK KAYNAĞI DOM'DUR.** JS'te ikinci bir izin listesi tutulmaz
  (`ROL_SEKMELERI` kaldırıldı); `rolSekmeleri()` / `kisitliSekmeler()` DOM'dan
  türetir. İşaretlenmemiş düğme **KAPALI** sayılır ve bir test her `.menu-btn`'de
  özniteliğin varlığını kilitler — unutulan öznitelik commit'te görünür.
- **TEK KURAL, ÜÇ DURUM** (`dugumIzinli`): rol bilinirse izin listesi o rolü
  içermeli; **rol bilinmiyorsa yalnızca bütün rollere açık olanlar görünür**;
  izin listesi boşsa görünmez. Faz 1'in "oturum yoksa kısıtlama kalkar" sözü
  bilinçli olarak daraltıldı — role özel bir sekmenin belirsiz bir durumda
  arkada görünür kalması, kapı kaplamasının her zaman üstte olduğuna güvenmek
  olurdu.
- Eski `data-rol` şeması **kaldırıldı**; iki şema tutmak sıradaki geliştiriciyi
  yanıltırdı.

**Testler neden görmüyordu:** DOM harness'ı kendi `sekmeAc` taklidini kuruyordu
ve o taklit `className`'i yeniden kurmuyordu. Artık **üretime sadık** tek bir
taklit var: `../scripts/tests/yardimci/sekme-ac-taklidi.js`. **Yeni DOM testi
yazarken `w.sekmeAc`'ı elle kurma, onu kullan.**

### 4.11.2 Rozet konumu — `data-sayacli`
`sekmeAc`, `relative` sınıfını da yeniden kuruyor ve eskiden listeyi **elle**
yazıyordu (`'uyeler' || 'destek'`). Sonradan eklenen rozetli düğmeler
(`notlarim`, ve çalışma zamanında rozet alan `plasiyerler`) listeye girmediği
için rozetleri `<nav>`'ın köşesine kaçıyordu. Artık işaretleme kendini söylüyor:
rozet taşıyan düğme **`data-sayacli="1"`** alır.

### 4.11.3 REST adresi — çift bölü çizgisi ve bozuk taban
Kullanıcının gördüğü `/wp-json/wc-b2b/v1//admin/plasiyerler` **yalnızca hata
mesajındaydı**; gerçek istek zaten temizdi. Mesaj ile istek adresi İKİ AYRI
yerde kuruluyordu, biri temizliyordu diğeri temizlemiyordu — ve bu bir hata
ayıklama turunu yanlış ize soktu. Artık tek kaynak: **`restYoluKur(alan, yol)`**.

`tabanAdresiTemizle()` de **güçlendirildi** (gerçek iki hata):
| Girdi | Eski | Yeni |
|---|---|---|
| `https://site.com//shop` | aynen kalıyordu → `new URL` normalize etmez, path `//shop/...` → 404 | `https://site.com/shop` |
| `https:/site.com` | `https://https:/site.com` → **host literal olarak `https`**, kullanıcı "adres hatalı" yerine "ulaşılamıyor" görüyordu | `https://site.com` |

Kalıp, bu depoda **zaten doğru yazılmış** kardeş temizleyiciden alındı:
`src/main/byom-yapilandirma.js → adresiTemizle()`. İkisi artık aynı kuralla
çalışıyor (ikisi de kullanıcının ELLE yazdığı alan).

**Şartnamenin `([^:]\/)\/+` regex'i** `restYoluKur` içinde son süzgeç olarak
duruyor. `https://` zarar görmez (bölüden önce iki nokta şartı). **Ama TAM URL
üzerinde koşturulmamalı:** `?search=a//b` → `a/b` olur ve sorgu değeri bozulur.
Bu yüzden sıkıştırma yalnızca YOL üzerinde, sorgu `url.searchParams` ile
eklenmeden önce yapılıyor. Bir test bu sırayı kilitliyor.

**"Eklenti bulunamadı" mesajı üç olasılığı birden söylüyor** artık: etkin değil /
**sürümü eski** / **WooCommerce devre dışı**. Üçüncüsü gerçek bir tuzak: plasiyer
uçları `B2B_Core::include_wc_dependent()` içinde, yani WooCommerce kapalıysa hiç
kaydedilmiyor ve kullanıcı "eklenti etkin zaten" deyip mesaja güvenini
kaybediyordu.

> **Canlı hatanın ASIL sebebi paketti:** `b2b-core.zip` 2.12.0'da kalmış ve
> içinde hiç plasiyer dosyası yoktu. Site o sürümü çalıştırdığı için
> `/admin/plasiyerler` rotası gerçekten yoktu. Zip `scripts/zip-theme.js` ile
> 2.15.0'dan yeniden üretildi. **Zip'ler `.gitignore`dadır** (izlenmez) —
> yeni sürüm yayınlarken YENİDEN ÜRETİLMELİDİR.

### 4.11.4 Giriş kartlarında metin taşması
Kartlar `<button>` ve yoğunluk katmanında **koşulsuz** bir global kural var:
```css
button { display: inline-flex; align-items: center;
         justify-content: center; white-space: nowrap; }
```
Üç etki birden: çocuklar yan yana dizilir, ortalanır ve **metin hiç sarmaz**.
`.kapi-kart` üçünü de ezer (`flex-direction: column`, `align-items: flex-start`,
**`white-space: normal`**) + `min-width: 0` (grid öğesi küçülebilsin) +
`overflow-wrap: anywhere`. `.kapi-kart` (0,1,0) global `button` (0,0,1)'den
özgül olduğu için `!important` gerekmiyor.

**`white-space: normal` en kritik ezme:** yalnızca `flex-direction: column`
vermek yetmez, metin yine sarmaz ve taşar.

Ayrıca kart içindeki `<div>`/`<p>` → `<span>`: `<button>` içerik modeli yalnızca
**phrasing content** kabul eder, blok etiket geçersiz HTML'di.

**Şartnamenin `text-white` / `text-slate-400` önerisi uyarlandı:** kart zemini
`bg-white dark:bg-slate-800`, yani düz `text-white` **açık temada beyaz üzerine
beyaz** olurdu. Tema duyarlı çiftler kullanıldı (`text-slate-900 dark:text-white`
/ `text-slate-500 dark:text-slate-400`). Bir test `text-white`ın geri dönmesini
engelliyor.

### 4.11.5 Yönetici PIN değiştirme
| Parça | Yer |
|---|---|
| Kart işaretlemesi | `index.html` → Ayarlar sağ sütunu, "🔑 Yönetici Master PIN" |
| Kart mantığı | `src/renderer/modules/yonetici-pin.js` (`sekmeAc`'ı SARAR) |
| Doğrulama | `auth:yonetici-pin-degistir` → `byom-yonetici-kilit.js → pinDegistir` |
| PIN kurtarma | → **§4.12** (tek kullanımlık sıfırlama kodu; düz metin PIN senkronu kaldırıldı) |

- **PIN kurulu değilse kart kapalı** ve kullanıcıya ilk PIN'i **giriş kapısında**
  kuracağı söylenir. Aynı işi iki yerde yapmak "PIN zaten tanımlı" hatasını
  kullanıcıya gösteren bir yol açardı.
- Biçim/eşitlik/aynılık denetimi **yerel** (ana sürece gürültü gitmez); son söz
  ana süreçte.
- PIN alanları **her denemeden sonra** (başarılı ya da değil) temizlenir.

---

## 4.12 PIN KURTARMA — tek kullanımlık sıfırlama kodu (Faz 8)

> ### ⛔ DÜZ METİN PIN SENKRONU KALDIRILDI — GERİ EKLEME
> Faz 7'de PIN, lisans anahtarıyla birlikte `/api/v1/license/pin-sync` ucuna
> yazılıyordu. Hub onu **okuyabildiği** için bir hub sızıntısı bütün
> müşterilerin yönetici PIN'ini açığa çıkarıyor ve hub erişimi olan personel
> kilitli her cihazı açabiliyordu. O uç artık **çağrılmıyor**; `pinSenkronla`,
> `pinKurtarmaSenkronu` ve `pinSenkron` ayarı **silindi**. Bir test kaynakta
> geri dönmediğini kilitliyor.

### Akış — hub PIN'i HİÇ GÖRMEZ
```
1) Patron PIN'i unuttu → panel TALEP KODU gösterir   (N192-7GQG-KBZX)
     · lisans anahtarı + HWID'den TÜRETİLİR → o cihaza özgü, DETERMİNİST
     · SIR DEĞİL, kimliktir: telefonda okunmak için var
2) Panel talebi hub'a bildirmeyi DENER (en iyi gayret)
3) Merkez TEK KULLANIMLIK bir kod üretir (güç/teklik/süre HUB'da)
4) Patron kodu panele yazar → panel hub'a DOĞRULATIR
5) PIN yerel olarak SİLİNİR → hemen yeni PIN kurulumuna geçilir
```

| Dosya | Sorumluluk |
|---|---|
| `src/main/byom-yonetici-kilit.js` | `talepKodu`, `kurtarmaKodunuNormalle`, `kurtarmaKoduBicimi`, `kurtarmaDenemesiHazirla`, `kurtarmaBasarisiz`, `pinSifirla` — **DOM'suz, test edilebilir** |
| `src/main/byom.js` | `pinSifirlamaTalebi` / `pinSifirlamaDogrula` — hub uçları. **Lisans anahtarı bu modülden çıkmaz** |
| `main.js` § 3.9 | `auth:pin-kurtarma-talep` · `auth:pin-kurtarma-dogrula` |
| `renderer-plasiyer.js` | Master PIN penceresinin **`kurtarma` modu** + `ypinUnuttum` |
| `src/renderer/modules/yonetici-pin.js` | Ayarlar kartındaki `ypinSifirlaBtn` → aynı pencereyi açar |

### Bozmaman gereken sözler
- **KURTARMA GİRİŞİ KAPIDA OLMAK ZORUNDA.** PIN'i unutan kişi yönetici
  paneline giremez, yani Ayarlar sekmesindeki karta da **ulaşamaz**.
  `ypinUnuttum` bağlantısı `dogrula` ve `kilit-ac` modlarında görünür; `kur`
  modunda gizli (sıfırlanacak PIN yok). Ayarlar kartındaki düğme **aynı
  pencereyi** açar — iki ayrı kurtarma arayüzü bakmak zorunda kalmamak için.
- **TALEP KODU DETERMİNİST.** Merkez onu lisans kaydından yeniden hesaplayıp
  arayanın gerçekten o cihazın başında olduğunu doğrular. Rastgele olsaydı her
  talebin hub'a kaydedilmesi **zorunlu** olurdu ve internetsiz bir ofiste akış
  tamamen tıkanırdı. Tekliği talep değil, merkezin verdiği **kod** sağlar.
- **MERKEZE BİLDİRİM "EN İYİ GAYRET".** Başarısız olursa kod yine gösterilir ve
  kullanıcıya "telefonda okuyun" denir. Akış internete bağımlı kılınmaz.
- **ALFABEDE KARIŞTIRILAN HARF YOK** (`I L O U` çıkarıldı) ve girdi
  normalleştirmesi `O→0`, `I/L→1`, `U→V` çevirir. Bu bir kolaylık değil **hata
  önlemedir**: telefonda okunan bir kodda "O" ile "0"ı ayırmak imkânsızdır ve
  her yazım hatası merkeze ikinci bir çağrı demektir.
- **DEĞİŞMEZ KURAL: «kilitli cihaz ⇒ tanımlı PIN vardır».** `cihazKilitle` PIN
  olmadan kilitlemeyi zaten reddediyor; bu yüzden `pinSifirla` PIN'i silerken
  **cihaz kilidini de kaldırır**. Kilit bırakılsaydı cihaz **tuğlaya** dönerdi:
  kilidi açmak PIN ister, PIN yok, yeni PIN kurmak kilidi açmaz.
- **AĞ HATASI SAYAÇ İLERLETMEZ.** "Ulaşamadım" ile "kod yanlış" ayrı şeylerdir;
  karıştırılırsa internet kesikken kullanıcı hiç yapmadığı bir hata için 15
  dakika kilitlenir. Aynı ayrım `byom-api.js → agSorunu`'nda da var.
- **5 hatalı kodda 15 dakika yerel kilit** (`pinKurtarmaDeneme` /
  `pinKurtarmaKilitBitis`, ikisi de **korumalı alan**). Gerçek kısıtlama hub'da;
  yereli merkezi gereksiz yere dövmemek için.
- **Sıfırlama yönetici girişi DEĞİLDİR:** oturum açılmaz, yalnızca yeni PIN
  kurulum ekranına geçilir. Kullanıcı PIN'siz de bırakılmaz.
- **Sıfırlamada plasiyer jetonu düşürülür** — cihazın tahsisi kalktı.

> ### ⚠️ KALAN RİSK — DÜRÜST NOT
> Her kurtarma yolu **sosyal mühendisliğe** açıktır: kötü niyetli biri merkezi
> arayıp patron gibi davranabilir. Bunu panel çözemez; çözüm merkezin **kimlik
> doğrulamasıdır**. Panel tarafındaki tek gerçek karşı önlem
> **denetlenebilirliktir**: her sıfırlama `yoneticiPinSifirlamaZamani` olarak
> damgalanır (korumalı alan, arayüzden silinemez) ve Ayarlar kartında
> "⚠ Bu PIN en son … tarihinde merkez onayıyla sıfırlandı" olarak gösterilir.
>
> Bu risk eski düz metin tasarımında da **aynen** vardı — üstelik merkez PIN'i
> söylediği için hiç iz kalmıyordu. Yeni tasarım riski ortadan kaldırmıyor,
> **görünür** kılıyor ve merkezin ayrıcalığını "sırrı bilmek"ten "yetki
> vermek"e indiriyor.
>
> **İNTERNET GEREKİR:** doğrulama hub'da yapıldığı için sıfırlama çevrimdışı
> çalışmaz. Bilinçli: çevrimdışı doğrulama ya panele gömülü bir sır (paketten
> çıkarılıp herkesin cihazı için kod üretmeye yarar) ya da açık anahtar +
> telefonda okunamayacak uzunlukta bir imza gerektirirdi.

---

## 4.13 Faz 9 — Clean Shell Router, doğrulama motoru, bileşik iskonto, Müşterilerim

**Şartname:** "Saha Satış (Plasiyer) & Yönetici Mimarisi Tam İzolasyon ve
Yeniden İnşa" (`BYOM-REGISTRY.md §5.32`). Eklenti 2.16.0 ile birlikte.

### 4.13.1 Kabuk yönlendiricisi — `src/renderer/kabuk-yonlendirici.js`

Üç kesin kabuk: `durum.kabuk ∈ { kapi, admin, plasiyer }`. Faz 6-7'nin CSS/öznitelik
gizlemesi **kemer-askı** olarak kaldı; asıl ayrım artık **SÖKME**: karşı rolün
menü düğmeleri, sekme gövdeleri ve gövde seviyesi modalları belgede **hiç
yoktur** (`getElementById` null döner). Yönetici kabuğu **8** düğme, saha
kabuğu **3** düğme `[Katalog & Satış] [Kendi Siparişlerim] [Müşterilerim]`,
kapı kabuğu yalnızca ortak düğme.

**Neden şablondan klonlama DEĞİL, aynı düğümü park etme:** renderer.js olay
dinleyicilerini açılışta belirli kimliklere tek sefer bağlar ve dinleyici
düğümün üzerinde yaşar. `cloneNode` dinleyiciyi kopyalamaz ama
`dataset.izgBagli` gibi "bağlandım" bayraklarını kopyalar → klon "bağlıyım"
der, hiçbir tıklamaya cevap vermez (sessiz ölü arayüz). `replaceChild(yorumDüğümü, düğüm)`
ile park edilen düğüm geri takıldığında dinleyicisi ve sırası aynıdır — test
bunu aynı düğüm referansı ve tıklama sayacıyla kilitler.

**İşaretleme sözleşmesi (index.html):** `data-kabuk="admin"` · `"plasiyer"` ·
`"admin plasiyer"` (= ORTAK, **hiç sökülmez**, kapıda da durur). İşaretsiz düğüm
iskelettir. `#sekme-siparisler` ortaktır: renderer.js'in otomatik yenileme
zamanlayıcısı `#siparisListesi`'ne koşulsuz yazar; sökülü olsa her tik TypeError
üretirdi. Yeni menü düğmesi eklerken **`data-rol-izin` ile `data-kabuk` aynı
olmalı** (test kilitler).

**⚠️ Zamanlama kilidi — okumadan değiştirme:** renderer.js `olaylariBagla()`
null korumasızdır ve iki IPC turu sonra çalışır. Boot bitmeden bir yönetici
düğümü sökülürse `$('#…').addEventListener` patlar, `sekmeAc` hiç çağrılmaz,
uygulama ölü ekranda kalır. Bu yüzden renderer.js en başta
`window.__byomHazir = false` yazar, `olaylariBagla()` bitince `true` yapıp
`byom:hazir` yayar; yönlendirici hazır değilken gelen geçişi **erteler**.
Test ortamında (renderer.js yüklenmez) bayrak tanımsız = hazır.

**Yetki deliği kapatıldı:** eski `sekmeIzinli` "menüde olmayan düğme izinlidir"
diyordu — sökme ile ters çalışır (plasiyer kabuğunda `ayarlar` düğmesi yok →
izinli sayılır). İzin artık açılışta DOM'dan bir kez okunan **izin tablosundan**
okunur; düğme belgede olmasa da cevap doğru.

**Sipariş kartı rol kapısı (renderer.js):** plasiyer görünümünde kartta yalnızca
ürün dökümü kalır; revize/durum/fiş/bayi/iptal/sil düğmeleri basılmaz — modalları
saha kabuğunda belgede de yoktur. `uyeSayaciTazele`, `uyeSuzgecleriCiz` ve
otomatik yenileme modal denetimi null korumalı yapıldı (yönetici zamanlayıcısı
plasiyer oturumunda çalışmaya devam edebilir).

Çift kimlik giderildi: satış arama kutusu `#urunArama` → **`#satisArama`**
(plasiyer-vitrin.js yanlış — yönetici — kutuya bağlanıyordu).

### 4.13.2 Doğrulama motoru — `src/shared/dogrulama.js`

Çift modlu, DOM'suz. `tcknGecerli`, `vknGecerli`, `kimlikNoCoz` (10 → vkn, 11 →
tckn), `gsmNormalle` (→ `05XXXXXXXXX`), `musteriFormuDenetle(form, {iskontoTavani})`
→ **tüm hataları birden** + `temiz` kayıt. PHP ikizi `class-b2b-dogrulama.php`
aynı vektörlerle test edilir. **Şartnamenin GSM deseni** ülke kodundan sonra
boşluk kabul etmez (`+90 532…` reddedilir; `+905321112233` geçer) — desen
birebir uygulandı, sonucu belgelendi.

### 4.13.3 Müşteri odaklı satış ve bileşik iskonto

- **Müşteri açılır menüsü** Katalog & Satış'ın tepesinde (`#musteriSecim`,
  "Ünvan — %X İskonto"); `🔍 Ara` modal araması kaldı.
- Müşteri seçilince `PlasiyerSiparisMotor.musteriIskontosuUygula` bayi
  iskontosunu (tavana kırparak) sepete yazar ve **vitrin yeniden çizilir**:
  kart/matris/modal fiyatı NET, liste fiyatı çizili.
- **Bileşik formül tek yerde** (`netFiyat`): `Net = Liste × (1 − bayi/100) × (1 − ödeme/100)`.
  `sepet.iskonto` = bayi (tavana tabi), `sepet.odemeIskonto` = ödeme yöntemi
  (`odemeSec` müşterinin `odemeIskontolari` tablosundan okur; **tavana tabi
  değil** — şirket kuralıdır). Sunucu aynı sırayla iki ücret satırı yazar.
- **Yeni müşteri formu:** Ünvan*, Yetkili*, Kimlik No* (VKN/TCKN), GSM*,
  E-posta, İl*, İlçe, Bayi iskontosu (≤ tavan). Hatalar alan altında **hepsi
  birden**. **Yerel mükerrer uyarısı** (kimlik/telefon eldeki listede varsa
  "Onu seç" düğmesi) — zorunlu engel değil, sunucu son sözü söyler.
- Kayıt `musteri:kuyruga` IPC'siyle ana süreçte eklenir; sipariş
  `siparis:kuyruga` ile. **Renderer artık oku-değiştir-yaz yapmaz** (eşitleme
  ile yarış gönderilmiş siparişi diriltebiliyordu). Gövde `yerelKimlik`
  (`sip-<uuid>`) taşır → sunucunun çift gönderim koruması artık besleniyor.
- **Müşterilerim** sekmesi: portföy kartları (kimlik, telefon, il, bayi %,
  bakiye), `[🛍️ Sipariş Yaz] [📝 Ziyaret Notu] [Profil]`; profilde son
  siparişler + bu müşterinin notları. **Saha Notlarım** bölümü bu sekmenin
  altında (kimlikler `#notlarimKab/#notlarimOzet/#notlarimYenile` korundu,
  rozet `#notlarimSayaci` Müşterilerim düğmesinde). `sekmeAc('notlarim')` geriye
  dönük çalışır.
- **Kendi Siparişlerim** tepesinde çevrimdışı **kuyruk şeridi**
  (`#plasiyerKuyrukKab`, yalnızca saha kabuğunda): bekleyen / KİLİTLİ
  (sebebiyle) + `[⟳ Şimdi Eşitle]`.
- Not köprüsü: çevrimdışı müşteriye yazılan ziyaret notu `temp_musteri_`
  metniyle bekler, `notKoprusuKur` müşteri eşitlenince gerçek kimliğe çevirir
  (eskiden 0 gidiyor, not sahipsiz kalıyordu).
- Yönetici → Pazarlamacılar formuna **İskonto tavanı (%)** alanı ve tabloya
  "Tavan" sütunu eklendi (sunucu `maxIskonto`'yu zaten okuyordu, form
  göndermiyordu).

**Yükleme sırası (index.html):** … renderer-vitrin → **dogrulama.js →
kabuk-yonlendirici.js** → renderer-plasiyer → plasiyer-yonetimi → … (yönlendirici
ve doğrulama, renderer-plasiyer'den ÖNCE).

### Bozmaman gereken sözler (Faz 9)
- Kabuk sökme **boot bitmeden** çalışmaz (`__byomHazir`); `byom:hazir`
  renderer.js'te `olaylariBagla()`'dan hemen sonra yayılır.
- `data-kabuk="admin plasiyer"` düğümler **hiç sökülmez** (`#sekme-siparisler`).
- Her yeni `.menu-btn` ve `.sekme-govde` `data-kabuk` taşır; menü düğmesinde
  `data-kabuk === data-rol-izin`.
- Ödeme iskontosu **tavana tabi değildir**; bayi iskontosu **tavana kırpılır**.
- `geciciMusteri` doğrulama YAPMAZ (form doğrular); `yerelKimlik` her gövdede
  benzersizdir.

---

## 4.14 Faz 10 — Saha denetimi sonrası kritik düzeltmeler

**Şartname:** "Saha Denetimi Sonrası Kritik Düzeltmeler — Portföy Sızıntısı,
Sipariş İzolasyonu, Harita ve Arayüz Düzenlemeleri" (`../BYOM-REGISTRY.md §5.33`).
Eklenti 2.16.1 ile birlikte. Canlı `npm start` ortamından 7 ekran görüntüsü.

### 4.14.1 🔴 KÖK SEBEP — `window.durum` hiç yoktu (OKUMADAN DEĞİŞTİRME)

`renderer.js` en tepede `const durum = {…}` yazar. Bu bir **betik-düzeyi
sözcüksel bağ**dır: klasik `<script>` içinde `const` **`window` özelliği
OLUŞTURMAZ** (`var` ve `function` oluşturur). Faz 6-9'un bütün modülleri
(`plasiyer-musteri.js`, `plasiyer-vitrin.js`, `plasiyer-otosync.js`,
`plasiyer-siparislerim.js`…) `window.durum.oturum` üzerinden `plasiyerMi()`
soruyordu → üretimde `window.durum === undefined` → **her modül "plasiyer
değil" diyordu**:

| Belirti (görsel) | Zincir |
|---|---|
| Müşterilerim'de sitenin bütün perakende müşterileri | `plasiyerMi()` false → yönetici yolu → `wc/v3/customers` |
| İskonto tavanı %0 | oturum okunamadı → tavan yok → 0 |
| Oto-eşitleme hiç çalışmadı | "yalnızca plasiyer oturumunda" kapısı hiç açılmadı |
| Ziyaret Notu düğmesi yok | aynı kapı |

**Testler neden görmedi:** her DOM harness'ı `w.durum = {…}`'u **kendisi
kuruyor** (renderer.js jsdom'da yüklenmiyor). Yani test dünyasında `window.durum`
hep vardı. Düzeltme tek satır (`window.durum = durum;`, Bölüm 4'ten hemen önce,
uzun gerekçe yorumu ile) + `kabuk-yonlendirici.dom.test.js` kaynak denetimi
(`^window\.durum = durum;`). **Bu satırı kaldırırsan dört fazın rol izolasyonu
sessizce çöker ve hiçbir test kırılmaz** — o yüzden kaynak denetimi var.

### 4.14.2 Kendi Siparişlerim — bağımsız şablon, sunucu ucu

| Parça | Yer |
|---|---|
| Sunucu ucu | `GET /plasiyer/siparislerim` (jeton; `_b2b_plasiyer_id` daraltması) |
| IPC | `main.js → plasiyer:get-orders` (oturum kimliği + jeton bellekten) |
| Modül | `src/renderer/modules/plasiyer-siparislerim.js` (`sekmeAc('siparislerim')` sarar) |
| Gövde | `#sekme-siparislerim` (`data-kabuk="plasiyer"`), `#siparislerimListe`, `#siparislerimOzet`, `#plasiyerKuyrukKab` (buraya taşındı) |

- **Yönetici sipariş listesi isteği HİÇ atılmaz** — sızıntı cihaza inmeden
  kapanır; §4.10'daki "görünüm süzgeci" uyarısı **kapandı**. Faz 6'nın
  `siparisleriSuz()` süzgeci yönetici gövdesinde durur (zararsız).
- **`#sekme-siparisler` artık YALNIZCA yönetici** (`data-kabuk="admin"`);
  saha kabuğunda belgede yok. `siparisleriCiz`/`siparisleriYukle` kabı yoksa
  sessizce döner (yönetici zamanlayıcısı plasiyerde TypeError üretmez).
- Kartta **tek eylem** `[📄 Sipariş / Fiş Detayı]` (`.siparis-detay-ac`,
  `aria-expanded`); revize/iptal/fiş/durum/bayi düğmeleri **yok** — test
  `data-eylem` yokluğunu kilitler.
- Sunucu hatasında liste kapıya düşmez: hata + "kuyrukta durur" açıklaması.
- Yönetici tarafında kaynak süzgeci `#kaynakSuzgecler`:
  `[Tümü] [🌐 Web Sitesi] [💼 Saha / Plasiyer]` (`sahaSiparisiMi`).

### 4.14.3 Diğer düzeltmeler

| Ne | Not |
|---|---|
| **Portföy** | `musterileriGetir`: rol `admin` değilse yönetici yoluna gidilmez; rol yoksa `{ok:false}`. Sunucu tarafı da yalnızca onaylı bayi rolleri (→ `../CLAUDE.md` §10 Faz 10) |
| **Üye Onayları alt sekmeleri** | `#uyeAltSekmeler .uye-alt[data-alt="bayi\|perakende"]`, `uyeAltSekmeAc`, `perakendeMusterileriYukle` (`wc/v3/customers?role=customer`), kartta `[🏢 BAYİYE DÖNÜŞTÜR]` (→ `/dealers/{id}/approve`). **Sınıf `uye-alt`, `plasiyer-alt` DEĞİL:** `altSekmeAc` `.plasiyer-alt`ı yönetir; aynı sınıf olsa her harita tıklaması üye sekmesini bozardı (test) |
| **Menü sırası** | `PLASIYER_SIRA`/`PLASIYER_ETIKET`/flex `order` **kaldırıldı**; DOM sırası tek doğru (`satis → siparislerim → musterilerim`), `#cikisYapDugme` `<nav>`'ın son çocuğu |
| **Hızlı adet** | Kartta `[−] [input.hizli-adet-input type=number min=1 step=koli] [+] [Sepete Ekle]`. Yazılan adet `sepeteEkle(id, hizliAdet(id))` → motor koli katına **yukarı** tamamlar (25 → 48). −/+ sepete dokunmaz; Enter ekler; eklendikten sonra kutu birime döner |
| **Anında eşitleme** | `anindaEsitle()`: kayıt **önce diske** (`musteri:kuyruga`), sonra `navigator.onLine && plasiyerMi()` ise `musteri:esitle-tek` → `POST /plasiyer/musteri-esitle`. `user_id` gelince geçici kayıt `{id:user_id, gecici:false, senkron:true, gercekId}` olur, seçim korunur, rozet kalkar. Başarısızsa kuyrukta bekler; sync motoru sonraki turda köprüler/temizler |
| **Bayi atama modalı** | `bayiKunyesi(b)` → `Firma (Yetkili) — İl/İlçe` + alt satır; `#pfBayiAra` arama, `.bayi-satir[data-arama]`, mevcut atama `assigned_plasiyer_id` ile işaretli, başkasının bayisi söylenir. Liste `tumSayfalariGetir('b2b','dealers',{status:'all'})`; hata sebebiyle yazılır, "yükleniyor" asılı kalmaz |
| **Harita** | `ilBul` TR kodu (`TR-35`/`TR35`/`tr 35`/`035` → 35); `notlariSuz` plaka üzerinden; `yollariYukle(harita, merkezler, sinirlar)` merkez + sınır kutusu yazar; **`src/renderer/harita-yollar.js`** (Natural Earth 1:10m, kamu malı; 81 il, 4317 nokta) kokpit açılışında `yollariBesle()` ile beslenir → `<path>`, zoom sınır kutusuna, komşular soluk gerçek şekil. Dosya yoksa şematik kutu. §4.8'deki "gerçek sınır yok" notu **tarihsel**: kapı aynı, artık besleniyor |

### Bozmaman gereken sözler (Faz 10)
- `window.durum = durum;` renderer.js'te durur (kaynak denetimi).
- Plasiyer siparişleri **yalnızca** `plasiyer:get-orders` ile gelir; saha
  kabuğunda `api:istek`/`woo:istek` sipariş listesi çağrısı yok (test).
- `.uye-alt` ile `.plasiyer-alt` ayrı sınıflar; CSS iki sınıfı birden kapsar.
- Menü sırası DOM'dur; `btn.style.order` yazılmaz.
- `harita-yollar.js` **elle düzenlenmez**; `scratchpad/geo-donustur.js` ile
  Natural Earth'ten yeniden üretilir.

---

## 4.15 Faz 11 — Saha geri bildirimleri: sipariş UI, Performansım, silme, logo, üç görsel yuvası

**Şartname:** "Saha Geri Bildirimleri, Sipariş UI/UX Sadeleştirme, Plasiyer
Analitikleri, Önbellek Temizleme ve Silme Yetkileri Revizyonu"
(`../BYOM-REGISTRY.md §5.34`). Eklenti 2.17.0, tema 2.10.0 ile birlikte.

### 4.15.1 Kendi Siparişlerim — "0 çeşit / 0 adet" (Görsel 6)
`prepare_order` kalemleri **`items`** altında verir; `normalle()` yalnızca
`line_items/kalemler` okuyordu → üretimde her sipariş boş görünüyordu (PHP testi
ölü `ince_siparis_yuku` dalını test ettiği için görünmez). Artık
`kalemler ‖ line_items ‖ items` üçü de okunur; sunucu 2.17.0 üçünü birden
doldurur. Detay tablosuna **koli** (`24 adet (2 koli × 12)` — "24 adet" bitişik
kalır, test kilidi) ve **birim fiyat** sütunu eklendi. `urunId` taşınır
("son siparişi kopyala" ürün bulur).

### 4.15.2 Yönetici sipariş sekmesi — iki seviye + Filtrele (Görsel 3-4)
| Parça | Yer |
|---|---|
| Seviye 1 kaynak switcher (`#kaynakSuzgecler`, segmented; sekmelerin ÜSTÜNDE) | `index.html`, `kaynakSuzgecleriCiz` |
| Seviye 2 durum sekmeleri `[Hazırlanacaklar (X)] [Kargoda / Yolda (Y)] [Tamamlananlar (Z)] [İptal / İadeler]` — kodlar `active/shipped/delivered/cancelled` **DEĞİŞMEDİ** (sunucu `group` sözleşmesi); iptal sekmesi `refunded` da çeker | `SIPARIS_SEKMELERI` |
| Rozetler: `sekmeSayaclariniYukle()` → `GET /stats → orders[slug]` TEK istek, `siparisleriYukle` içinde **await edilmeden**; `durum.sekmeSayaclari` | `renderer.js` |
| `<details id="siparisFiltreMenu">` "Filtrele" — `#siparisSuzgecler` + `#teslimSuzgecler` içinde (kimlikler KORUNDU: `$('#siparisSuzgecler').addEventListener` null korumasız), `filtreOzetiniTazele` etkin süzgeç sayısı | `index.html`, `renderer.js` |
| Kart künyesi `[Plasiyer: Ad] ➔ Müşteri` (`plasiyerAd`, yoksa `#id`) ve `[📲 WHATSAPP FİŞİ]` — yalnızca `yoneticiEylemleri && sahaSiparisiMi && waTelefon` | `siparisleriCiz` |
| `waTelefon` (`0532…` → `90532…`), `whatsAppFisiMetni` (no/müşteri/tutar/ilk 15 kalem), `whatsAppFisiAdresi` → `wa.me/{tel}?text=` `encodeURIComponent`; `window.open` → main.js `setWindowOpenHandler → shell.openExternal` (**yeni IPC gerekmedi**) | `renderer.js` |
| `[ÇÖPE TAŞI]` (`siparis-cope`, `force:false`, iptal/iade) + `[SİPARİŞİ KALICI SİL]` yan yana; `siparisCopeTasi` | `renderer-ek.js` |

**⚠️ Rozet ≠ liste adedi:** `/stats` mağaza geneli sayaçtır; kaynak (web/saha)
süzgeci uygulanmış liste ile ayrışabilir.

### 4.15.3 Performansım — `modules/plasiyer-performansim.js`
Saha 4. sekmesi (`performansim`, Müşterilerim'den SONRA → DOM sırası korunur).
TEK IPC `plasiyer:performans` → `GET /plasiyer/performans` (kimlik + jeton ana
süreç belleğinden). Kartlar gün / 7 gün / 30 gün (sipariş + net ciro), bayi
katkısı (`scaleX` çubuk, siparişsiz bayi de listede), il dağılımı. Hata kapıya
düşürmez; `normalle` eksik alanları sıfırlar. `sekmeAc` sarmalı `bagli` bayraklı
(çift sarma = çift istek, §4.10). Yönetici uçlarına (`/admin/*`) HİÇ gidilmez.

### 4.15.4 Harita — gün seçici + kompakt bayi kartı (Görsel 1-2)
- `<input type="date" id="haritaTarih">` gün düğmelerinin yanında; `durumH.tarih`
  `/admin/harita` ve `/admin/ziyaret`e `tarih` olarak gider (boşsa main.js süzgecinde
  düşer → eski istek birebir). Tarih seçiliyken `gun=0` ve hiçbir gün düğmesi aktif
  değil; gün düğmesi tarihi iptal eder. Bağlama **`change`** — `input` olsaydı
  yeniden çizimde `value` ataması istek üretebilirdi ("ölçüt değişimi ağa çıkmaz" sözü).
- `HaritaVeri.notlariSuz` `tarih` (yerel gün; tarih doluysa `gun` yok sayılır;
  okunamayan zaman yine süzülmez).
- `bayiKarti(b, sonNotlar)`: unvan, yetkili, telefon, iskonto rozeti, son sipariş
  tarihi/tutarı, son ziyaret notu etiketi (arayüzde `/admin/ziyaret` listesinden,
  DESC → ilk eşleşme, tarih süzgeçsiz). **Her alan varlık kontrollü** — eski eklenti
  yalnızca `{id, unvan}` verir; `undefined`/`NaN%`/`Invalid Date` ekrana düşmez.

### 4.15.5 Silme yetkileri
- Bayi: `uyeSil` önce `DELETE /wc-b2b/v1/dealers/{id}` (meta + hesap birlikte,
  yönetici korumalı), `rest_no_route` ise `wc/v3/customers` yedeği. Etiket
  `🗑️ BAYİYİ KALICI OLARAK SİL`, modal "Bayiyi Kalıcı Olarak Sil".
- Plasiyer çevrimdışı müşteri: kartta `[🗑️ Sil]` yalnızca `gecici` kayıtta
  (metinde "ÇEVRİMDIŞI" geçmez — eşitleme testi rozeti o sözcükle ölçer);
  `yerelMusteriSil` → `musteri:kuyruktan-sil`. Ana süreç: yalnızca
  `temp_musteri_` + `senkron` olmayan; **bekleyen sipariş/not varsa RET** (sebep
  söylenir) — kaydı silmek siparişi sonsuza dek "Müşteri henüz eşitlenmedi"de
  bırakırdı. Seçili müşteriyse sepet bırakılır.

### 4.15.6 Logo genişliği ve üç görsel yuvası (Orhan Bey)
- **Masaüstü logo genişliği (Eksen 2):** kaydırıcı Vitrin Editörü › "Marka Görselleri"
  panelinde, `#markaLogoKutusu`nun hemen altında (`#veLogoGenislik` 100–320 px, adım 10;
  `#veLogoGenislikDeger`; `[Kaydet]` = `#veLogoGenislikKaydet`; kap `#veLogoGenislikKutu`).
  API sekmesinde ayar kartı **yok** (ürün sahibi reddi). `ayarlar.json → masaustuLogoGenislik`
  (varsayılan 220; eski `logoGenislik` main.js → `ayarlariOku()` göçüyle devralınır, dosyaya
  dokunulmaz). Ortak uygulayıcı `renderer.js → logoGenisligiUygula()` → `--logo-width`
  (`#firmaLogo max-width`); `renderer-vitrin.js → logoGenislikOlaylariBagla`: `input` yalnızca
  CSS (IPC yok), `[Kaydet]` → `ayar:yaz`; sekmeden kaydetmeden ayrılınca (`sekmeAc` sarmalı) ve
  yeniden açılışta kaydedilmiş değer geri gelir. **Siteye/temaya gitmez:** theme-config
  branding ve storefront-layout yüklerine girmez (kaynak testi kilitler).
  `firmaLogosunuUygula()` her çağrıda genişliği de uygular.
- Ürün düzenleme: `durum.duzenleYuvalari = [ana, görsel2, görsel3]`
  (`{id, onizleme, url, mevcut?}` | null). `urunDuzenleAc` → `duzenleYuvalariniKur(urun)`
  mevcut görselleri doldurur (`urunNormalle → galeri`, eskiden düşürülüyordu ve
  `replace_images` kayıtta galeriyi SİLİYORDU — veri kaybı önlendi). Yuvaya tıkla →
  `duzenleHedefYuva` → dosya seçici o yuva için; sürükle-bırak boş yuvaları soldan
  sağa doldurur; fazlası **söylenerek** atlanır. **Dokunulmadıysa `images`
  gönderilmez**; hepsi boşaltıldıysa `[]` (sunucu `replace + boş = kaldır`).
  `duzenleGorselKaldir(yuvaIndeksi)` — imza değişti (eskiden medya id'si).

### Bozmaman gereken sözler (Faz 11)
- `SIPARIS_SEKMELERI[].kod` sunucu sözleşmesidir; etiket serbest, kod değil.
- `#siparisSuzgecler` / `#teslimSuzgecler` kimlikleri belgede kalır.
- WhatsApp düğmesi `yoneticiEylemleri` kapısının içinde; saha modülüne kopyalanmaz.
- Harita tarih girdisi `change` ile bağlanır; `ciz()` istek üretmez.
- `plasiyer:performans` kimliği oturumdan alır; `veri`den asla.
- `musteri:kuyruktan-sil` bekleyen sipariş/not varsa reddeder.
- Yuvalara dokunulmadıkça kayıt yükünde `images` yoktur.

---

## 4.16 Faz 12 — İki rol iki harita, logo ölçeği, kurumsal fiş, saha kısayolları

**Görev:** "Baş Ürün Mimarı — 1 istedik 10 katını ver" (`../BYOM-REGISTRY.md §5.35`).
Eklenti 2.18.2 ile birlikte (inceleme turu düzeltmeleri: `BYOM-REGISTRY.md §5.35-G`; canlı `maxIskonto` hatası: `§5.35-H`).

### 4.16.1 Harita kokpiti FABRİKA oldu — `HaritaKokpit.olustur(ayar)`
`harita-kokpit.js` artık iki örnek üretir; durum modül seviyesinde DEĞİL, örneğe aittir:

| Örnek | Kap | Veri | Kim |
|---|---|---|---|
| `window.HaritaKokpit` (`kip:'admin'`, önek `harita`) | `#haritaKab` (Pazarlamacılar alt sekmesi) | `b2b('/admin/harita')` + `/admin/ziyaret` | yönetici |
| `window.SahaHarita` (`kip:'plasiyer'`, önek `sahaHarita`) | `#sahaHaritaKab` (`#sekme-sahaharitam`, 5. saha sekmesi) | `ipcRenderer.invoke('plasiyer:harita')`; notlar `PlasiyerZiyaret.durum.notlar` belleğinden | plasiyer |

- Kimlikler öneklidir (`haritaSvg`/`sahaHaritaSvg`, `haritaTarih`/`sahaHaritaTarih`…); olay
  bağlama `kap.querySelectorAll` ile kapla sınırlı → iki örnek birbirinin düğmesini görmez.
- **Yönetici**: il, sorumlu plasiyerin rengine boyanır (`dolgu` → `hexRgba(renkHex, 0.38 + yoğunluk·0.52)`);
  lejant `[● Ahmet (Mor) · 4 il]` → `durumH.vurgu` (yeniden çizim, ağa çıkmaz); geniş ve dolu ilde
  `"İzmir (35)"` + `"3 bayi · 12,4K"` (`kisaPara`); ipucu "Sorumlu: …".
- **Saha**: `ilEtkin(il)` = sorumlu il ya da bayisi olan il; diğerleri `harita-il-pasif`
  (tabindex yok, tıklama/ipucu yok, soluk gri); kartta `[🛍️ Bu Bayiye Sipariş Aç]`
  (`PlasiyerMusteri.siparisYazmayaGec`) / `[📝 Ziyaret Notu Bırak]` (`ziyaretNotuAc`) —
  ikisi de artık `PlasiyerMusteri`'den DIŞA VERİLİR (ikinci kopya yok).
- Zengin bayi kartı iki kabukta ortak (`bayiKarti`): risk rozeti (`acikBakiye` varsa),
  `[📞 Ara]` (pano + `tel:` via `byom:dis-baglanti`), `[📲 WhatsApp]` (`wa.me`), ziyaret
  rozeti (`ziyaretDurumu` sunucudan; yoksa son nottan 30 gün). **Her alan varlık kontrollü.**
- `sekmeAc` sarmalı YALNIZCA saha örneği için (`sahaharitam`), tek ve `bagliS` bayraklı;
  yönetici haritası yine `plasiyer-yonetimi.js → altSekmeAc` ile açılır (çift istek tuzağı, §4.10).
- `akisaBaglan` 2,5 sn rozet turu **yönetici oturumunda** çalışır (plasiyerde `/admin/ziyaret` yetkisiz).

### 4.16.2 Pazarlamacı formu — renk + sorumlu iller
`plasiyer-yonetimi.js → formuAc`: `#pfRenkPaleti .pf-renk[data-renk]` (radiogroup, tekrar tık =
kaldır, gizli `#pfRenk`), `#pfIlListe .pf-il-kutu[value=plaka]` (81 il `HaritaVeri.ILLER`'den),
`#pfIlAra` arama, `.pf-bolge-sec` bölge kısayolu (yalnızca kilitsiz iller), `#pfIlTemizle`,
`#pfIlSayac`. Başka plasiyerdeki il **disabled** + sahibi yazılı (`ilSahipleri`); sunucu da
çakışmayı reddeder (`b2b_plasiyer_il_cakisma`). Kayıt yükü `renk` + `iller`. Palet tek kaynak:
`HaritaKokpit.PALET` (PHP `B2B_Plasiyer::PALET` ikizi — test karşılaştırır).

### 4.16.3 Logo ölçeği — Vitrin Editörü (Eksen 2)
→ §4.15.6 güncellendi: kaydırıcı `#veMarkaPanel` içinde (`#veLogoGenislik` 100–320, `[Kaydet]`),
anahtar `masaustuLogoGenislik`, yalnızca masaüstü `--logo-width`; tema PUT yüküne girmez.

### 4.16.4 Kurumsal fiş + WhatsApp — `src/renderer/siparis-fisi.js` (Eksen 3)
DOM'suz, çift modlu motor: `normalle(kaynak, baglam)` (yönetici normalizasyonu / plasiyer
normalizasyonu / ham `prepare_order`), `html(fis, {kagit:'a4'|'termal'})`, `whatsappMetni(fis)`
(kalın başlıklar, koli×adet, iskontolar, NET; ≤ 1800 karakter), `waTelefon`, `waAdresi`, `paraYaz`.
- Plasiyer: Kendi Siparişlerim detayında `.sk-fis[data-kagit]` / `.sk-wa` / `.sk-tekrar`
  (kartın dışında yine TEK birincil düğme). Fiş `fis:onizleme` IPC ile ayrı pencerede.
- Yönetici: kartta `[📄 SİPARİŞ FİŞİ]` (`data-eylem="siparis-fisi"`, depo fişinden ayrı);
  `whatsAppFisiAc` motor varsa zengin şablon, yoksa Faz 11 sade şablon (test sade yolu kilitler).

### 4.16.5 Proaktif dokunuşlar (Eksen 4)
- **Tekrar sipariş**: Müşterilerim `.mk-tekrar` (`tekrarSiparisGec`: seç → `sonSiparisiKopyala`
  → satış); Kendi Siparişlerim `.sk-tekrar` (`PlasiyerSiparisMotor.sonSiparisiKopyala` +
  `PlasiyerVitrin.urunBul` — **bugünün fiyatı**, geçmiş fiyat asla).
- **Akıllı süzgeç** Kendi Siparişlerim: `#siparislerimAra` + `.siparislerim-cip[data-suzgec]`
  (`DURUM_CIPLERI`), `suz()` yerel; imleç konumu yeniden çizimde korunur.
- Boş durumlar: saha haritası, lejant, il bayi paneli, süzgeç sonucu.

### Bozmaman gereken sözler (Faz 12)
- Yönetici kokpiti yüzeyi (`durum/ilSec/geriDon/veriyiGetir/tarihSec/bayiKarti/yollariBesle/sekmeyiAc/rozetiTazele`) ve kimlikleri (`haritaSvg`, `haritaTarih`…) DEĞİŞMEZ.
- Saha haritası yalnızca `plasiyer:harita` ile beslenir; `/admin/*` uçları plasiyer kabuğunda çağrılmaz.
- Lejant/ölçüt/vurgu yeniden çizimi ağa çıkmaz.
- Palet anahtarları panel ↔ PHP birebir.
- Kendi Siparişlerim kartının dışında tek birincil düğme; depo eylemleri sahada yoktur.
- `masaustuLogoGenislik` tema yüküne girmez.

---

## 4.17 Faz 13 — Saha testi turu: ölü perdeler, katalog sayfalama, KDV, müşteri düzenleme, logo ölçeği

Tetikleyici: ürün sahibinin canlı panelde yaptığı saha testi (13 madde).
Eklenti tarafı **2.19.0** → `../BYOM-REGISTRY.md §5.36`, kök `CLAUDE.md §10 Faz 13`.

### 4.17.1 🔴 ÜÇ ÖLÜ DÜĞME — perdeler gizli sekme gövdesinin içindeydi (OKUMADAN DEĞİŞTİRME)

`#satisPerde`, `#ziyaretPerde`, `#urunPerde` Faz 2-3'ten beri
`<section id="sekme-satis" class="sekme-govde">` **içindeydi**.

```
.sekme-govde { display: none }      ← ata
  └─ #satisPerde { position: fixed; z-50 }   ← çocuk, hidden kaldırılsa BİLE görünmez
```

**Bir atanın `display:none` olması alt ağacın tamamını render dışı bırakır.**
`position: fixed` bunu kurtarmaz; çocuk elemana yazılabilecek **hiçbir CSS**
bunu geri alamaz (kaplama açılırken `hidden` kalkıyor, sınıflar doğru,
konsol temiz — ekranda hiçbir şey yok).

Canlıdaki karşılığı **üç ölü düğme**, üçü de sessiz:

| Düğme | Nerede | Neden ölüydü |
|---|---|---|
| `[+ Yeni Müşteri]` | Müşterilerim sekmesi | `#satisPerde` gizli `#sekme-satis` içinde |
| `[📝 Ziyaret Notu]` | Müşterilerim + Saha Haritam kartları | `#ziyaretPerde` aynı yerde |
| 🔔 bildirim zili | üst bar (her sekmede görünür) | `#ziyaretPerde` — satış sekmesi dışında çalışmıyordu |

**Düzeltme:** üçü `<body>` altına, tek kapsayıcıya taşındı:

```html
<div id="sahaPerdeleri" data-kabuk="plasiyer">
  … #urunPerde · #ziyaretPerde · #satisPerde (z-index'ler değişmedi) …
</div>
```

`data-kabuk="plasiyer"` **zorunludur** — Clean Shell Router (§4.13.1) kabuğa ait
olmayan düğümleri söker; işaret konmasaydı saha perdeleri yönetici kabuğunda da
belgede kalır ve "karşı rolün modalları belgede YOK" sözü kırılırdı.

**⚠️ jsdom bunu GÖREMEZ.** jsdom ata zincirinin `display`'ini hesaplamaz;
`getComputedStyle(perde).display` perdenin *kendi* kuralını döndürür. Bu,
§4.5.1'in `[hidden]` özgüllük tuzağı ve §4.14.1'in `window.durum`'u ile **aynı
kör nokta sınıfıdır**: jsdom'da yeşil, Electron'da ölü. Üstelik testler bugüne
kadar `yeniPerdesiniAc()`'ı **elle çağırıyordu**, yani düğmenin ölü olduğu
ölçüm alanına hiç girmemişti.

**Yeni sözler** (`../scripts/tests/saha-perde.dom.test.js`, 6 test):
1. Perdenin **hiçbir atası** `.sekme-govde` olmayacak — hesaplanmış stile değil
   **ata zincirine** bakılır.
2. Düğme **gerçekten tıklanır** (`dispatchEvent(click)`), fonksiyon elle
   çağrılmaz.

> **Kural:** yeni bir tam ekran kaplama eklerken onu bir `.sekme-govde` içine
> **koyma**. Yeri `#sahaPerdeleri` (saha) ya da `<body>` altındaki kabuk işaretli
> bir kapsayıcıdır.

### 4.17.2 Katalog sayfalama — "500 kalem" yanılgısı

Solda *"Tüm ürünler · 500 kalem"*, sağ üstte *"1111 ürün"*. Eşitleme 1111'in
**tamamını** diske yazıyor; 500 yalnızca arama sonucu kırpmasıydı
(`EN_COK_SONUC`). Ama sorun yalnız metin değildi: **filtresiz gezinmede
alfabetik 501. üründen sonrası erişilemezdi.**

| Ne | Nerede |
|---|---|
| `araSayfali(sorgu, secenek)` → `{ urunler, toplam, ofset }`; `toplam` **kırpmadan önceki** sayı, kırpma **süzgeçten sonra** | `src/main/byom-katalog-depo.js` |
| `ara()` hâlâ **dizi** döner — gövdesi `araSayfali(...).urunler`; iki süzgeç uygulaması olmasın | aynı |
| `katalog:ara` yanıtı `toplam` + `ofset` taşır (`urunler` anahtarı korundu) | `main.js § 3.7` |
| `SEMA` **artırılmadı** (1) | aynı — şemayı artırmak sahadaki katalog dosyalarını geçersiz kılar ve çevrimdışı terminal internet bulana kadar **boş katalogla** kalırdı. Yeni alanlar (`yalniz_koli`, `kdv_orani`) eksikse varsayılana düşer |
| `sonrakiSayfa()` — "Daha Göster" `ofset: durumV.urunler.length` ile bir sonraki sayfayı çeker; boş yanıtta `durumV.toplam` kırpılır (düğme yalan söylemesin) | `modules/plasiyer-vitrin.js` |
| `sayiOku(deger, yedek)` — `toplam` göndermeyen eski ana sürece dayanıklı | aynı |

**Metinler gerçeği söylüyor:** `Tüm ürünler · 1111 kalem` · kırpma varsa
`ilk 500 gösteriliyor — arama ile daraltın` · filtreliyken
`1111 kaleminde 37 sonuç`. **Hâlâ ağa çıkılmaz** — hepsi yerel indeks.

### 4.17.3 Ürün kartı ve "Vitrin görünümü" düğmesi

Kart sırası (ürün sahibinin istediği): görsel → ad →
**`Ürün Kod/Barkod : xxxx`** → tek satırda `koliEtiketi(u)` + **`Fiyat : xxxx ₺`**
→ hızlı adet satırı. Önce rozet ve fiyat **iki ayrı satırdaydı**.

- **`kodBarkod(u)`** tek yardımcı: SKU + ` · ` + barkod, yoksa biri, ikisi de
  yoksa `-`. **Üç yerde** kullanılır: kart, matris satırı, ürün detay penceresi.
  Aynı kuralı üç kez yazmak bu depoda tekrarlayan hata sınıfı.
- `fiyatHtml(u, sinif, onek)` üçüncü parametre aldı (`Fiyat : ` öneki).
  **NET/liste fiyatı mantığı DEĞİŞMEDİ** (müşteri seçiliyken NET, liste üstü
  çizili — test bunu regresyon olarak kilitliyor).
- `koliEtiketi(u)` artık `u.yalniz_koli` okur → `Sadece koli` rozeti.
  Alan katalog deposunda **saklanıyor** (çevrimdışı da doğru).
- **`#gorunumAnahtar` silindi** — "Vitrin görünümü" düğmesi ürün sahibinin
  kararıyla kaldırıldı (yarım kalmış, olmayan bir özelliği vaat ediyordu).
  **Matris kipi duruyor**: arama kutusunda Enter, alan dışında Tab. Kısayol
  keşfedilemez kalmasın diye filtre barına kalıcı ipucu (`kipIpucu()`):
  vitrinde `Tab: hızlı liste`, matriste `⌨️ Hızlı liste · Tab: vitrine dön`.

### 4.17.4 KDV seçimi ve fiş dökümü

**Sipariş gövdesi alanı: `kdvDahil` (boolean, varsayılan `true`).**
`siparisGovdesi` onu `false !== sepet.kdvDahil` ile yazar — `undefined` KDV dahil
sayılır, yani **kuyrukta bekleyen eski siparişler kipini değiştirmez**.

| Ne | Nerede |
|---|---|
| `kdvOrani(urun)` — `kdv_orani` → `kdvOrani` → `byom.kdvOrani`, 0-100 kırpma, bilinmiyorsa 0. Panel **kendi oran listesini tutmaz**, oran sunucudan gelir | `plasiyer-siparis-motor.js` |
| `KDV Tercihi *` — `[✅ KDV İSTİYORUM]` / `[🚫 KDV İSTEMİYORUM]`, `aria-pressed`; seçim **raf fiyatlarını değiştirmez**, başarılı siparişten sonra `true`ya döner (karar sipariş başınadır) | `modules/plasiyer-musteri.js` |
| `kdvTahmini(s)` — KDV **fiyatın içindedir**: `kdv += tutar * oran / (100 + oran)`. Oranı bilinmeyen kalem `bilinmeyen` sayılır, **sayı uydurulmaz** | aynı |
| `kdvOzetBlogu(g)` — ekranda açıkça **"Tahmini"**: `Tahmini KDV düşümü (%20)` / `(karışık oran)`, `Tahmini net (KDV hariç)`, ve `Kesin tutar sunucuda, ürün başına KDV oranıyla hesaplanır.` Oran hiç yoksa yalnızca "sunucuda hesaplanacak" der | aynı |

**Fiş (`src/renderer/siparis-fisi.js`) — KDV'yi YENİDEN HESAPLAMAZ**, sunucudan
geleni basar. Tek yedek: tutar hiç gelmemişse orandan türetir ve **kipi bilmek
zorundadır** — `kdvHaric ? tutar*o/100 : tutar*o/(100+o)`. Sunucunun verdiği
tutar her zaman kazanır.

- **A4 sütunları (7):** `Ürün · Kod / Barkod · KDV · Koli × Adet · Birim · KDV Tutarı · Tutar`
  (eski `SKU` başlığı `Kod / Barkod` oldu). KDV künyesi hiç yoksa 5 sütun.
- **Toplam bloğu sırası:** Ara toplam → Bayi iskontosu → Ödeme iskontosu →
  `KDV (%20)` / `KDV (karışık oran)` → **NET ÖDENECEK**.
- **KDV istenmediğinde:** toplam KDV satırı yerine `KDV → UYGULANMADI`, tabloya
  ek olarak amber blok: *"Bu siparişte KDV uygulanmamıştır (düşülen KDV: …).
  Tutarlar, ürünlerin tekil KDV oranları düşüldükten sonraki değerlerdir."*
  **NET ikinci kez düşürülmez** — sunucu zaten satır fiyatlarını dönüştürdü.
- **Termal 80 mm:** tek sütunluk kâğıtta KDV **sütun değil**, kalemin altında
  ikinci satır (`KDV %20 · 342,00 TL`). Tek çizici, iki bayrak
  (`kdvSutun` / `kdvAltSatir`) — ikinci kod yolu yok.
- **WhatsApp:** net satırından hemen önce tek satır
  (`*KDV (%20):* …` ya da `*KDV UYGULANMADI* (düşülen: …)`).

### 4.17.5 Müşteri bilgilerini düzenleme — tek form, iki kip, iki IPC

Yoktu; ürün sahibi istedi. `yeniPerdesiniAc(mevcut)` düzenleme kipine geçer
(`duzenle = !!(mevcut && mevcut.id)`); alan listesi ve doğrulayıcı
(`musteriFormuDenetle`) **oluşturma yoluyla ortak**.

| Kip | IPC | Arka uç |
|---|---|---|
| Çevrimdışı, henüz eşitlenmemiş kayıt | **`musteri:kuyrukta-guncelle`** | Cihazdaki `ayarlar.json → plasiyerYerelMusteriler` — **ağa çıkılmaz** |
| Sunucudaki bayi | **`musteri:guncelle`** | `POST /plasiyer/musteri-guncelle` (jeton + portföy daraltması sunucuda) |

**Kimlik alanları gövdeden ASLA okunmaz.** `musteri:kuyrukta-guncelle` beyaz
listesi yalnızca veri alanlarını alır; ardından
`guncel.id / gecici / senkron / gercekId` **mevcut kayıttan** geri yazılır.
Aksi hâlde formdan gelen bir `gercekId` kuyruktaki başka bir kaydı ezebilir ya
da eşitlenmiş bir kaydı "eşitlenmemiş" gösterebilirdi. Kanal ayrıca kimliğin
`GECICI_ONEK` ile başlamasını ve kaydın `senkron` olmamasını şart koşar;
eşitlenmiş kayıt için mesaj yol gösterir ("bilgileri sunucu üzerinden
güncellenir"). `musteri:guncelle` `plasiyerId`/`token` alanlarını **ana süreç
belleğinden** ezer — renderer'ın gönderdiği kimlik dikkate alınmaz.

**E-posta:** alan artık `E-posta (isteğe bağlı)` ve altında
*"Boş bırakabilirsiniz — müşteriye e-posta gönderilmez, iletişim telefondan
kurulur."* `epostaGoster(v)` sunucunun ürettiği yer tutucu adresi
(`…@<host>.invalid`, RFC 6761) **forma doldurmaz** — doldursaydı kullanıcı onu
gerçek adres sanıp geri gönderir ve yer tutucu kalıcı olurdu.

**Giriş noktaları:** portföy kartında `.mk-duzenle` (`✏️`) ve profil panelinde
`#profilDuzenle`. Başarıda `durumM.yereller/musteriler/secili/profil` yamanır ve
seçim korunur; `iskontoKirpildi` gelirse oranın **tavana kırpıldığı** söylenir
(kayıt reddedilmez).

### 4.17.6 Logo ölçeği — kaydırıcı çalışıyordu, kısıt yanlış eksendeydi

`logoGenisligiUygula` yalnızca `--logo-width` yazıyordu; gerçek boyutu
`max-height: 40px !important` tutuyordu. **Kare ya da 3:1 bir logoda 220→320
hareketi matematiksel olarak etkisizdi**; yalnızca 5,5:1'den geniş logolarda
işe yarıyordu. Kullanıcının "çalışmıyor" demesi doğruydu — düğme ölü değildi.

| Ne | Nerede |
|---|---|
| **`--logo-height`** değişkeni (varsayılan 40px); `#firmaLogoKutu` **ve** `#firmaLogo` ikisi de okur (eskiden ikisinde de `40px` gömülüydü) | `index.html` |
| `header.h-20` sabit `height: 52px` yerine `height:auto` + `min-height: 52px` — 58px'lik logoyu sabit bar **kırpardı** ve kaydırıcı yine bozuk görünürdü | `index.html` |
| `ORAN = 40 / 220` → **100 ≈ 18px · 220 = 40px · 320 ≈ 58px**. Kırpma (100–320) ve **dönüş değeri (genişlik) DEĞİŞMEDİ** | `renderer.js → logoGenisligiUygula` |
| Kaydırıcı **Firma Logosu kutusunun hemen altına** taşındı (eskiden panelin dibinde, favicon bloğundan sonra — kaydırmadan görünmüyordu) | `index.html`, `renderer-vitrin.js` |
| **Canlı önizleme şeridi** `#veLogoOnizleme` — üst bardaki **aynı iki CSS kısıtını** okur, yani temsilî değil birebir. `logoSeridiCiz()` kaynağı `markaLogosu()` (yerel logo önce); logo yüklenince `markaGorseliDegisti()` tazeler | `renderer-vitrin.js`, `renderer.js` |
| Etiket `220px · %100` biçiminde; sürüklerken **IPC/ağ yok**, `ayar:yaz` yalnızca `[Kaydet]` ile | aynı |
| Yanlış mesaj düzeltildi: logo yüklenince basılan *"sitenizin logosu öncelikli gösterilir"* **tam tersini söylüyordu** — kod yerel logoyu önce okuyor | `renderer.js → yerelLogoYukle` |

### 4.17.7 Dönem çipleri — ölçüt değişimi ağa çıkmaz

Tek sözlük (tek doğruluk kaynağı):

```js
var DONEMLER = {
  ay:   { ciro: 'ciroAy',  siparis: 'siparisAy',  genel: 'genelCiroAy' },
  yil:  { ciro: 'ciroYil', siparis: 'siparisYil', genel: 'genelCiroYil' },
  tumu: { ciro: 'ciro',    siparis: 'siparis',    genel: 'genelCiro' }
};
```

`[📅 Bu Ay] [🗓️ Bu Yıl] [Σ Tümü]` — `role="tab"`, durum `aria-selected`'te,
varsayılan `ay`. **`donemSec()` yalnızca `tabloyuCiz()` + `ozetiTazele()` çağırır;
`listeyiGetir()` bilinçli olarak çağrılmaz** (§4.10 "ölçüt değişimi ağa çıkmaz").
Sıralama, çubuk ölçeği, sütun başlıkları (`Ciro · Eylül`) ve özet aktif dönemi
izler; satırın ikinci satırı ay ve yılı birlikte gösterir.

**Eski eklenti yükü:** `donemDestekli()` false dönerse dönem `tumu`ya sabitlenir,
çipler `disabled` + açıklayıcı `title`, amber not *"Aylık/yıllık ciro için
eklentiyi güncelleyin"*. Sayı alanları **tüm zamanlar** değerine düşer —
ekranda `undefined ₺` ya da `NaN` **basılmaz**. (Alanlar `0` ile değil **`null`**
ile başlatılıyor: 0 "veri geldi, sıfır" demektir, `null` "hiç gelmedi".)

### 4.17.8 Harita bayi kartı → mevcut yönetici profil modalı

Yönetici kokpitinde `.bayi-kart` tıklanabilir oldu (`role="button"`,
`tabindex="0"`, Enter/Space) ve **`window.bayiDetayiAc(id)`** çağrılıyor — yani
`renderer.js`'teki **mevcut** zengin profil modalı: künye, sipariş geçmişi, her
siparişin fişi, toplam ciro, bekleyen sepet. **İkinci bir kopya yazılmadı.**
Kart içindeki `.bk-ara` / `.bk-wa` / `.bk-siparis` / `.bk-not` düğmeleri
`closest('button')` kontrolüyle profili **açmaz**.

**Saha kabuğunda bilerek tıklanabilir değil:** `#bayiModalKatman`
`data-kabuk="admin"` taşır ve Clean Shell Router onu saha kabuğunda **belgeden
söker** — orada tıklanır göstermek boş ekran vaat etmek olurdu. Ayrıca saha
kartının kendi gerçek düğmeleri var (`🛍️ Bu Bayiye Sipariş Aç`,
`📝 Ziyaret Notu Bırak`) ve gerçek düğmeleri bir `role="button"` kabın içine
yuvalamak erişilebilirlik hatasıdır.

Kartta iki yeni satır: `Sorumlu: <ad>` (yalnızca yönetici; ad çözülemezse satır
**hiç basılmaz**) ve `💼 Sahada açıldı` rozeti (`kaynak` damgasından).

### 4.17.9 Üye Onayları üçüncü alt sekme

`UYE_ALT_SEKMELER = ['bayi', 'perakende', 'saha']` (tek doğruluk kaynağı,
işaretlemedeki `data-alt` ile aynı). Üçüncü düğme
`🚚 Saha / Pazarlamacı Müşterileri`, sınıfı **`uye-alt`** — `plasiyer-alt`
**DEĞİL**, yoksa `plasiyer-yonetimi.js → altSekmeAc` her harita tıklamasında ona
da dokunurdu (§4.14).

Liste `tumSayfalariGetir('b2b','dealers',{ status:'all', kaynak:'saha', … })`
ile **sunucuda** süzülür — panel tarafında ayıklamak 100'lük sayfalamayı
bozardı. Kartta `İl: … / …` ve `Sorumlu Pazarlamacı: …` künyesi; ad eksikse
`plasiyerAdlariniCoz()` **tek** `/admin/plasiyerler` isteğiyle çözer ve oturum
boyunca önbelleğe alır (başarısızlıkta boş nesne yazılır ki her çizimde tekrar
denenmesin). E-posta yoksa ya da `.invalid` ise e-posta satırı yerine
`[📲 WhatsApp]` (`uyeIletisimHtml`); telefon da yoksa **hiçbir satır basılmaz**.

### Bozmaman gereken sözler (Faz 13)
- **Saha perdeleri hiçbir `.sekme-govde` içine konulamaz** — ata `display:none`
  onları öldürür ve hata vermez.
- `data-kabuk="plasiyer"` işareti `#sahaPerdeleri` üzerinde kalmalı.
- `ara()` dizi döndürmeye devam eder; `SEMA` sahadaki katalog dosyaları için
  sabittir.
- Fiş KDV'yi **hesaplamaz**, sunucudan geleni basar; tutar yoksa sayı uydurmaz.
- Dönem çipleri ağa çıkmaz; eksik alanlarda `undefined`/`NaN` basılmaz.
- `musteri:kuyrukta-guncelle` kimlik/eşitleme alanlarını gövdeden almaz.
- Yer tutucu `.invalid` e-posta forma doldurulmaz.
- `logoGenisligiUygula` **genişliği** döndürmeye devam eder (çağıranlar buna bağlı).

---

## 5. Hızlı test komutları

İki test kökü var:

- **`test/`** (bu submodule) — panelin kendi birim testleri. `npm test` ile koşar.
- **`../scripts/tests/`** (kök depo) — üç katmanın entegrasyon/DOM/PHP testleri.

İkisini birden `../scripts/check-all.js` koşar (**681 test**: panel 310 + kök 371).

```bash
# Bu submodule'un kendi birim testleri (310 test) — Electron GEREKMEZ
npm test
node --test test/telemetri.test.js          # 31 — sessiz hata avcisi, 3 sn sure asimi
node --test test/katalog-depo.test.js       # 25 — cevrimdisi katalog: arama, indeks, disk, esitleme
node --test test/plasiyer-siparis.test.js   # 47 — koli matematigi, sepet, son siparis, UUID, tavan,
                                            #      kendiSiparisleri ("Kendi Siparislerim" suzgeci)
node --test test/plasiyer-sync.test.js      # 30 — outbox: sira, kimlik koprusu, hata toleransi,
                                            #      esitlemeGerekliMi (Faz 4 oto-esitleme karari)
node --test test/harita-notlar.test.js      # 46 — 81 il kutugu, TR il kodlari, tarih (belirli gun) suzgeci, durum gecisleri, filtreler,
                                            #      harita-yollar.js (81 gercek sinir, Natural Earth)
node --test test/cihaz-kilidi.test.js       # 52 — Master PIN hash/kilit, cihaz tahsisi, PIN SIFIRLAMA, KAYNAK denetimi
node --test test/rest-adres.test.js         # 13 — restYoluKur, tabanAdresiTemizle, sorgu korunmasi
node --test test/siparis-fisi.test.js       # 20 — kurumsal fis motoru: normalle (3 kaynak), A4/termal HTML, WhatsApp metni
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
node --test scripts/tests/plasiyer-kapi.dom.test.js   # 79 — çift kapı, Master PIN, cihaz kilidi, ÇIKIŞ, rol dayanıklılığı, PIN SIFIRLAMA
node --test scripts/tests/saha-perde.dom.test.js      # 6  — Faz 13: perde ATA ZİNCİRİ (ölü düğme), müşteri düzenleme iki kip
node --test scripts/tests/plasiyer-menu.dom.test.js   # 19 — menü hiyerarşisi, alt sekmeler, Saha Notlarım, dönem çipleri
node --test scripts/tests/yonetici-pin.dom.test.js    # 17 — PIN değiştirme kartı + giriş kartı düzeni
node --test scripts/tests/harita-kokpit.dom.test.js   # 18 — 81 il çizimi, KUTU ÇAKIŞMASI, bölünmüş ekran, bayi profili
node --test scripts/tests/saha-denetim.dom.test.js    # 27 — Faz 10-13: hızlı adet, Saha Siparişlerim, üç üye alt sekmesi, katalog sayfalama, ürün kartı
node --test scripts/tests/saha-analitik.dom.test.js   # 11 — Faz 11: Performansım, kalem dökümü üç şekil, harita tarih + bayi kartı, çevrimdışı müşteri silme
node --test scripts/tests/yonetici-arayuz.dom.test.js # 18 — Faz 11-13: sipariş sekmesi iki seviye, WhatsApp fişi, logo ÖLÇEĞİ (--logo-height, önizleme şeridi), üç görsel yuvası
node --test scripts/tests/saha-harita.dom.test.js     # 21 — Faz 12-13: iki rol iki harita, renk/il formu, saha kısayolları, bayi profili kapısı
node --test scripts/tests/php-plasiyer-role.test.js   # plasiyer rolü + veri izolasyonu (PHP)
node --test scripts/tests/sifir-kurulum.test.js       # "0 KM" kuralları
node --test scripts/tests/registry-parity.test.js     # 3 registry kopyası eşit mi

# Tek test adı
node --test --test-name-pattern="outbox" scripts/tests/vitrin-motor.test.js

# Sözdizimi (hızlı)
node --check "B2B Yönetim Paneli Klasör/renderer.js"

# Bitirirken: üç katmanın tamamı (681 test)
node scripts/check-all.js
```

**DOM testleri hakkında:** `jsdom` **harici betikleri indirmez** —
`<script src>` etiketleri çalıştırılmaz, yalnızca satır içi betikler çalışır.
Testler ihtiyaç duydukları dosyayı `fs.readFileSync` + `new Function` ile
kendileri enjekte eder. Bu yüzden `index.html`'e yeni bir `<script src>`
eklemek DOM testlerini **etkilemez**; satır içi betik eklemek **etkiler**.

**⚠️ jsdom'un GÖRMEDİĞİ şey — pahalıya öğrenildi:** jsdom basamaklı stili
(CSS cascade) tam uygulamaz; Tailwind'in `[hidden]` ile `.grid` arasındaki
özgüllük yarışı jsdom'da **doğru** görünür, gerçek Chromium'da **yanlış**
(→ §4.5.1). Yani `el.hidden === true` geçen bir test, ekranda görünen bir
kaplamayı ispatlamaz. **Görünürlük sözünü sınıf/stil kuralı üzerinden değil,
kaynak metni üzerinden denetle** (`plasiyer-kapi.dom.test.js` `[hidden]`
kuralının `index.html` içinde var olduğunu regex ile doğrular). Düzen/geometri
sözleri de aynı şekilde hesaplanmış CSS'e değil **özniteliklere** bakmalı —
`harita-kokpit.dom.test.js` çakışmayı `x/y/width/height` üzerinden ölçer.

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
| **`ayar:oku` → `maskele()` / `ayar:yaz` → `suz()`** | **Cihaz kilidinin tamamı bu iki çağrıya dayanıyor.** Biri kaldırılırsa kilit sessizce işlevsiz kalır: PIN özeti arayüze sızar ya da kilitli cihazdaki biri `ayar:yaz` ile `cihazRolu`'nü kendisi değiştirir. Davranış testleri bunu YAKALAMAZ (main.js Electron gerektirir, `node --test` altında yüklenmez) — bu yüzden `cihaz-kilidi.test.js` **kaynak metnini** denetler. → §4.9 |
| **Saha perdelerinin YERİ (`#sahaPerdeleri`, index.html)** | `#satisPerde`/`#ziyaretPerde`/`#urunPerde` bir `.sekme-govde` içine **geri konulamaz**. Ata `display:none` olduğunda alt ağacın tamamı render dışı kalır; `position:fixed` ve çocuğa yazılacak hiçbir CSS bunu geri almaz. Faz 2-3'ten Faz 13'e kadar **üç düğme sessizce ölüydü** (`[+ Yeni Müşteri]`, `[Ziyaret Notu]`, bildirim zili) — ne hata ne uyarı. **jsdom bunu göremez** (ata zincirinin `display`'ini hesaplamaz), bu yüzden `saha-perde.dom.test.js` hesaplanmış stile değil **ATA ZİNCİRİNE** bakar ve düğmeye **gerçekten basar**. `data-kabuk="plasiyer"` işareti de kalmalı, yoksa perdeler yönetici kabuğunda da belgede kalır (→ §4.17.1) |
| **`[data-rol-gizli="1"] { display:none !important }` (index.html)** | Rol izolasyonunun TAMAMI bu kurala dayanıyor. Kural kalkarsa öznitelik bir şey ifade etmez ve her iki rol birbirinin sekmelerini görür. Sınıf tabanlı gizleme DENENDİ ve `sekmeAc` tarafından siliniyordu (→ §4.11.1) |
| **`.kapi-kart` düzen ezmeleri (index.html)** | Global `button { display:inline-flex; white-space:nowrap }` kuralını ezer. Biri (özellikle `white-space: normal`) kalkarsa giriş kartlarındaki metin tek satıra sıkışıp taşar (→ §4.11.4) |
| **`scripts/tests/yardimci/sekme-ac-taklidi.js`** | DOM testlerinin `sekmeAc` taklidi. Üretimdeki `className` ATAMASINI birebir yapar; bu satır kaldırılırsa rol gizlemesi regresyonları yeniden görünmez olur (411 test bir kez böyle kaçırdı) |
| **«kilitli cihaz ⇒ tanımlı PIN vardır» değişmezi** | `pinSifirla` PIN'i silerken cihaz kilidini DE kaldırır. Kilit bırakılırsa cihaz tuğlaya döner: kilidi açmak PIN ister, PIN yok, yeni PIN kurmak kilidi açmaz (→ §4.12) |
| **`byom-yonetici-kilit.js` scrypt parametreleri** | `N=16384, r=8, p=1`. Düşürmenin tek kazancı ölçülemeyecek bir hız, bedeli 6 haneli PIN'e kaba kuvvetin kolaylaşması. Parametreler özetin **içinde** saklanır, yani ileride artırmak sahadaki PIN'leri geçersiz kılmaz |

---

## 8. Bitirme kontrol listesi

```bash
cd .. && node scripts/check-all.js     # 0 hata / 160 php / 93 js / 681 test
```
1. `check-all.js` sıfır hata mı? PHP atlandıysa **söyle**, gizleme.
2. Yeni bölüm/dosya eklediysen bu `CLAUDE.md`'deki satır haritasını tazele.
3. Sürüm artışı `package.json`'da; `BYOM-REGISTRY.md §0` sürüm tablosu da tazelenir.
4. **Önce bu submodule, sonra kök depo** commit edilir. `git push` **yok**.
