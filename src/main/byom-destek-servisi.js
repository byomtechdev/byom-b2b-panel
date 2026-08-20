/* ============================================================================
 *  BYOM BRAIN — DESTEK MASASI (TICKETS) SERVİSİ
 *  ---------------------------------------------------------------------------
 *  BYOM Brain uçları:
 *    GET  /api/v1/tickets?license_key=&hardware_id=
 *         → { success, tickets: [ …, messages:[…] ], count }
 *    GET  /api/v1/tickets?…&ticket_id=<id>        → tek talep (ayrı /:id ucu YOK)
 *    POST /api/v1/tickets                          → { license_key, hardware_id,
 *                                                      subject, message, priority }
 *    POST /api/v1/tickets/:id/messages             → { license_key, hardware_id, message }
 *
 *  İZOLASYON: Her istekte lisans anahtarı hem başlıkta (X-License-Key /
 *  Authorization) hem sorgu/gövdede gider. Sunucu talepleri license_id'ye göre
 *  süzer; burada ayrıca gelen listede lisansı uymayan kayıt varsa elenir
 *  (ikinci savunma katmanı).
 *
 *  Alan adları sunucu sürümleri arasında değişebildiği için bütün yanıtlar
 *  sabit bir iç biçime çevrilir (talebiCoz / mesajiCoz).
 * ==========================================================================*/

'use strict';

const api = require('./byom-api');

/** Uygulamanın kullandığı öncelik kodları ve etiketleri. */
const ONCELIKLER = [
  { kod: 'low', etiket: 'Düşük', simge: '🟢' },
  { kod: 'normal', etiket: 'Normal', simge: '🔵' },
  { kod: 'high', etiket: 'Yüksek', simge: '🟠' },
  { kod: 'urgent', etiket: 'Acil', simge: '🔴' }
];

/**
 * Talep durumları. BYOM Brain'in kendi kümesi: open | in_progress | resolved | closed
 * (diğerleri eski/farklı sunucu sürümlerinden gelirse diye tanınır).
 */
const DURUMLAR = {
  open: { etiket: 'Açık', simge: '🟡' },
  pending: { etiket: 'Yanıt Bekliyor', simge: '🟡' },
  answered: { etiket: 'Yanıtlandı', simge: '🟢' },
  in_progress: { etiket: 'İnceleniyor', simge: '🔵' },
  closed: { etiket: 'Kapatıldı', simge: '⚪' },
  resolved: { etiket: 'Çözüldü', simge: '✅' }
};

function alan(kaynak, adlar, varsayilan) {
  if (!kaynak || typeof kaynak !== 'object') return varsayilan === undefined ? '' : varsayilan;
  for (let i = 0; i < adlar.length; i++) {
    const deger = kaynak[adlar[i]];
    if (deger !== undefined && deger !== null && deger !== '') return deger;
  }
  return varsayilan === undefined ? '' : varsayilan;
}

/** Yanıtın içindeki dizi/nesneyi bulur (data, tickets, items, results…). */
function icerikCikar(veri, anahtarlar) {
  if (!veri) return null;
  if (Array.isArray(veri)) return veri;
  if (typeof veri !== 'object') return null;

  const adaylar = (anahtarlar || []).concat(['data', 'items', 'results', 'records', 'veri']);
  for (let i = 0; i < adaylar.length; i++) {
    const deger = veri[adaylar[i]];
    if (Array.isArray(deger)) return deger;
    if (deger && typeof deger === 'object') {
      // {data:{tickets:[…]}} gibi iç içe biçimler
      const ic = icerikCikar(deger, anahtarlar);
      if (ic) return ic;
    }
  }
  return null;
}

function durumuNormalize(ham) {
  const durum = String(ham || 'open').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const esler = {
    acik: 'open', yeni: 'open', new: 'open', waiting: 'pending',
    customer_reply: 'pending', bekliyor: 'pending',
    replied: 'answered', yanitlandi: 'answered', answered_by_admin: 'answered',
    processing: 'in_progress', inceleniyor: 'in_progress',
    kapali: 'closed', kapandi: 'closed', close: 'closed',
    cozuldu: 'resolved', done: 'resolved', completed: 'resolved'
  };
  const sonuc = esler[durum] || durum;
  return DURUMLAR[sonuc] ? sonuc : 'open';
}

function onceligiNormalize(ham) {
  const oncelik = String(ham || 'normal').trim().toLowerCase();
  const esler = {
    dusuk: 'low', düşük: 'low', minor: 'low',
    orta: 'normal', medium: 'normal', standart: 'normal',
    yuksek: 'high', yüksek: 'high', major: 'high',
    acil: 'urgent', critical: 'urgent', kritik: 'urgent'
  };
  const sonuc = esler[oncelik] || oncelik;
  return ONCELIKLER.some(function (o) { return o.kod === sonuc; }) ? sonuc : 'normal';
}

/** Mesajı kimin yazdığını belirler: 'admin' (BYOM) veya 'musteri'. */
function gonderenTipi(ham) {
  const isaretler = [
    alan(ham, ['sender_type', 'author_type', 'sender', 'author', 'from', 'role', 'user_type', 'gonderen']),
    alan(ham, ['is_admin', 'is_staff', 'admin']) === true ? 'admin' : '',
    alan(ham, ['is_customer', 'from_customer']) === true ? 'customer' : ''
  ].join(' ').toLowerCase();

  if (/admin|staff|agent|support|byom|operator|destek|yonetici/.test(isaretler)) return 'admin';
  return 'musteri';
}

function tarihNormalize(ham) {
  if (!ham) return '';
  const t = new Date(ham);
  return isNaN(t.getTime()) ? String(ham) : t.toISOString();
}

/** Sunucudan gelen bir mesajı sabit biçime çevirir. */
function mesajiCoz(ham) {
  if (!ham || typeof ham !== 'object') return null;
  return {
    id: String(alan(ham, ['id', 'message_id', 'uuid'], '')),
    gonderen: gonderenTipi(ham),
    ad: String(alan(ham, ['sender_name', 'author_name', 'user_name', 'name', 'gonderen_adi'], '')),
    mesaj: String(alan(ham, ['message', 'body', 'content', 'text', 'mesaj'], '')),
    tarih: tarihNormalize(alan(ham, ['created_at', 'date', 'sent_at', 'timestamp', 'tarih'], ''))
  };
}

/** Sunucudan gelen bir talebi sabit biçime çevirir. */
function talebiCoz(ham) {
  if (!ham || typeof ham !== 'object') return null;

  const mesajlarHam = icerikCikar(
    ham.messages || ham.replies || ham.comments || ham.mesajlar || null,
    ['messages', 'replies', 'comments']
  ) || [];

  const mesajlar = mesajlarHam.map(mesajiCoz).filter(Boolean);
  const durum = durumuNormalize(alan(ham, ['status', 'state', 'durum'], 'open'));

  /* BYOM Brain "okunmadı" sayacı tutmuyor. Müşteri için anlamlı olan bilgi
     şudur: son sözü BYOM ekibi söylediyse ve talep kapanmadıysa yeni cevap
     var demektir. Sol menüdeki kırmızı rozet bunu kullanır. */
  const sonMesaj = mesajlar.length ? mesajlar[mesajlar.length - 1] : null;
  const kapali = durum === 'closed' || durum === 'resolved';
  const yeniCevap = !!(sonMesaj && sonMesaj.gonderen === 'admin' && !kapali);

  return {
    id: String(alan(ham, ['id', 'ticket_id', 'uuid', 'number'], '')),
    numara: String(alan(ham, ['ticket_number', 'number', 'reference', 'kod'], '')),
    baslik: String(alan(ham, ['subject', 'title', 'baslik'], '(Başlıksız talep)')),
    durum: durum,
    oncelik: onceligiNormalize(alan(ham, ['priority', 'oncelik', 'urgency'], 'normal')),
    ilkMesaj: String(alan(ham, ['message', 'body', 'description', 'content', 'mesaj'], '')),
    olusturma: tarihNormalize(alan(ham, ['created_at', 'date_created', 'created', 'tarih'], '')),
    guncelleme: tarihNormalize(alan(ham, ['last_message_at', 'updated_at', 'last_reply_at', 'modified', 'guncelleme'], '')),
    okunmamis: Number(alan(ham, ['unread_count', 'unread', 'new_replies'], 0)) || 0,
    yeniCevap: yeniCevap,
    lisansAnahtari: String(alan(ham, ['license_key', 'lisans_anahtari'], '')),
    mesajlar: mesajlar
  };
}

/* ==========================================================================
 *  SUNUCU ÇAĞRILARI
 * ========================================================================*/

/** Bu lisansa ait talepleri listeler. */
async function listele(kimlik) {
  const yanit = await api.istekAt({
    yol: '/api/v1/tickets',
    metod: 'GET',
    sorgu: { license_key: kimlik.lisansAnahtari, hardware_id: kimlik.hardwareId, per_page: 100 },
    lisansAnahtari: kimlik.lisansAnahtari,
    hardwareId: kimlik.hardwareId
  });

  if (!yanit.ok) return { ok: false, hata: yanit.hata, agSorunu: !!yanit.agSorunu };

  const liste = icerikCikar(yanit.veri, ['tickets', 'talepler']) || [];
  const talepler = liste
    .map(talebiCoz)
    .filter(Boolean)
    /* Savunma katmanı: sunucu yanlışlıkla başka lisansın kaydını döndürürse
       müşteriye gösterilmez. */
    .filter(function (t) {
      return !t.lisansAnahtari || !kimlik.lisansAnahtari || t.lisansAnahtari === kimlik.lisansAnahtari;
    })
    .sort(function (a, b) {
      return String(b.guncelleme || b.olusturma).localeCompare(String(a.guncelleme || a.olusturma));
    });

  return { ok: true, talepler: talepler };
}

/**
 * Tek bir talebin ayrıntısı + mesaj geçmişi.
 *
 * BYOM Brain'de ayrı bir `/tickets/:id` ucu YOKTUR; tek talep, liste ucuna
 * `ticket_id` sorgusu verilerek alınır.
 */
async function detay(kimlik, talepId) {
  const id = String(talepId || '').trim();
  if (!id) return { ok: false, hata: 'Talep numarası belirtilmedi.' };

  const yanit = await api.istekAt({
    yol: '/api/v1/tickets',
    metod: 'GET',
    sorgu: {
      license_key: kimlik.lisansAnahtari,
      hardware_id: kimlik.hardwareId,
      ticket_id: id
    },
    lisansAnahtari: kimlik.lisansAnahtari,
    hardwareId: kimlik.hardwareId
  });

  if (!yanit.ok) return { ok: false, hata: yanit.hata, agSorunu: !!yanit.agSorunu };

  const liste = icerikCikar(yanit.veri, ['tickets', 'talepler']) || [];
  const govde = liste.length
    ? liste.filter(function (t) { return String(t && t.id) === id; })[0] || liste[0]
    : ((yanit.veri && (yanit.veri.ticket || yanit.veri.talep)) || null);

  const talep = talebiCoz(govde);

  if (!talep) return { ok: false, hata: 'Talep bulunamadı ya da ayrıntısı okunamadı.' };

  /* Bazı sunucular ilk mesajı messages dizisine koymaz; koymadıysa listenin
     başına ekleriz ki sohbet eksiksiz görünsün. */
  if (talep.ilkMesaj && !talep.mesajlar.some(function (m) { return m.mesaj === talep.ilkMesaj; })) {
    talep.mesajlar.unshift({
      id: 'ilk',
      gonderen: 'musteri',
      ad: '',
      mesaj: talep.ilkMesaj,
      tarih: talep.olusturma
    });
  }

  return { ok: true, talep: talep };
}

/** Yeni destek talebi açar. */
async function olustur(kimlik, bilgi) {
  bilgi = bilgi || {};
  const baslik = String(bilgi.baslik || '').trim();
  const mesaj = String(bilgi.mesaj || '').trim();

  if (baslik.length < 3) return { ok: false, hata: 'Başlık en az 3 karakter olmalı.' };
  if (mesaj.length < 10) return { ok: false, hata: 'Mesaj en az 10 karakter olmalı. Sorununuzu biraz daha açıklayın.' };

  const yanit = await api.istekAt({
    yol: '/api/v1/tickets',
    metod: 'POST',
    govde: {
      license_key: kimlik.lisansAnahtari,
      hardware_id: kimlik.hardwareId,
      subject: baslik,
      title: baslik,
      priority: onceligiNormalize(bilgi.oncelik),
      message: mesaj,
      body: mesaj,
      company_name: kimlik.firmaAdi || '',
      domain: kimlik.domain || '',
      app_version: kimlik.surum || '',
      os: process.platform
    },
    lisansAnahtari: kimlik.lisansAnahtari,
    hardwareId: kimlik.hardwareId,
    sureAsimi: 30000
  });

  if (!yanit.ok) return { ok: false, hata: yanit.hata, agSorunu: !!yanit.agSorunu };

  const govde = (yanit.veri && (yanit.veri.ticket || yanit.veri.talep || yanit.veri.data)) || yanit.veri;
  const talep = talebiCoz(Array.isArray(govde) ? govde[0] : govde);

  return { ok: true, talep: talep };
}

/** Var olan talebe yanıt yazar. */
async function yanitla(kimlik, talepId, mesaj) {
  const id = String(talepId || '').trim();
  const metin = String(mesaj || '').trim();

  if (!id) return { ok: false, hata: 'Talep numarası belirtilmedi.' };
  if (metin.length < 2) return { ok: false, hata: 'Mesaj boş olamaz.' };

  const govde = {
    license_key: kimlik.lisansAnahtari,
    hardware_id: kimlik.hardwareId,
    message: metin,
    body: metin,
    sender_type: 'customer'
  };

  let yanit = await api.istekAt({
    yol: '/api/v1/tickets/' + encodeURIComponent(id) + '/messages',
    metod: 'POST',
    govde: govde,
    lisansAnahtari: kimlik.lisansAnahtari,
    hardwareId: kimlik.hardwareId,
    sureAsimi: 30000
  });

  /* Sunucuda mesaj ucu farklı adlandırılmışsa yedek yolu dene. BYOM Brain
     kendi hatalarını `code` ile bildirir (ör. ticket_not_found); kod varsa
     uç mevcut demektir, yeniden denemek anlamsız olur. */
  const kod = String((yanit.veri && yanit.veri.code) || '');
  if (!yanit.ok && !yanit.agSorunu && !kod && (yanit.durum === 404 || yanit.durum === 405)) {
    yanit = await api.istekAt({
      yol: '/api/v1/tickets/' + encodeURIComponent(id) + '/reply',
      metod: 'POST',
      govde: govde,
      lisansAnahtari: kimlik.lisansAnahtari,
      hardwareId: kimlik.hardwareId,
      sureAsimi: 30000
    });
  }

  if (!yanit.ok) return { ok: false, hata: yanit.hata, agSorunu: !!yanit.agSorunu };
  return { ok: true };
}

/* NOT: Talebi KAPATMA yetkisi müşteride değildir — BYOM Brain'de kapatma
   yalnızca yönetici uçlarında (/api/admin/tickets/:id) tanımlıdır. Müşteri
   tarafında kapatma düğmesi bilerek yoktur; talep çözüldüğünde durumu BYOM
   ekibi günceller ve müşteri listede "Çözüldü/Kapatıldı" olarak görür.
   Kapalı bir talebe müşteri yeni mesaj yazarsa sunucu talebi otomatik olarak
   yeniden açar (bkz. tickets/[id]/messages ucundaki `reopened`). */

module.exports = { ONCELIKLER, DURUMLAR, listele, detay, olustur, yanitla, talebiCoz };
