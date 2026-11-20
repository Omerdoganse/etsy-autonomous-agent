'use strict';
/* Kontrol paneli: canlı loglar, üretim, ürün galerisi + detay, kalite raporu, zamanlayıcılar, etkinlik ve ayarlar. */
// `api`, preload.js tarafından (contextBridge) global olarak tanımlanır: window.api
const $ = (id) => document.getElementById(id);
const STEPS = ['Trend', 'Tasarım', 'SEO', 'Mockup & Video', 'Kalite kontrol', 'Etsy'];
const STATUSES = ['İnceleme', 'Hazır', 'Taslak', 'Yayında', 'Hata', 'Arşiv'];
const DAY_NAMES = [['Pzt', 1], ['Sal', 2], ['Çar', 3], ['Per', 4], ['Cum', 5], ['Cmt', 6], ['Paz', 0]];
const JOB_LABEL = { run: 'otonom üretim', 'dry-run': 'test üretimi', publish: 'Etsy yükleme', login: 'Etsy girişi', oauth: 'API yetkilendirme', setup: 'mockup kurulumu', schedule: 'planlı üretim', qc: 'kalite kontrol', repair: 'tasarım onarımı', drop: 'ücretsiz düzeltme', gemini: 'Gemini otomatik üretim', prices: 'fiyat güncelleme', sale: 'indirim başlatma', rebuild: 'vitrin oluşturma', import: 'içe aktarma' };
const state = { busy: false, job: null, ready: false, products: [], config: {}, env: {}, filter: '', search: '', stats: null, sched: null, wt: null, session: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (s) => { try { return new Date(s).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
function toast(msg, ms = 3000) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
/** Teknik hata mesajlarını anlaşılır Türkçeye çevirir. */
function friendlyError(m) {
  const s = String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (/402|insufficient credit|kredisi bitti/i.test(s)) return 'Replicate kredisi bitti. replicate.com → Billing\'den kredi yükleyin ya da "Yeni ürün yap" (Gemini, ücretsiz) yolunu kullanın.';
  if (/REPLICATE_API_TOKEN/.test(s)) return 'Replicate anahtarı yok. Ayarlar → API anahtarları bölümüne ekleyin ya da "Yeni ürün yap" (Gemini) yolunu kullanın.';
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo/i.test(s)) return 'İnternet bağlantısı sorunu. Bağlantıyı kontrol edip tekrar deneyin.';
  if (/oturum|login|sign.?in/i.test(s) && /etsy/i.test(s)) return 'Etsy oturumu kapalı görünüyor. Ana sayfa → Diğer seçenekler → "Etsy oturumu" ile giriş yapın.';
  if (/Timeout \d+ms exceeded/i.test(s)) return 'Etsy sayfası zamanında yanıt vermedi. Biraz sonra tekrar deneyin.';
  if (/başka bir işlem|already running|run\.lock/i.test(s)) return 'Şu an başka bir işlem çalışıyor. Bitmesini bekleyin.';
  return s;
}
async function safe(fn, errPrefix = '') { try { return await fn(); } catch (e) { toast(`${errPrefix}${friendlyError(e.message || e)}`, 7000); return null; } }

/* ---------------- sekmeler ---------------- */
function showTab(name) {
  document.querySelectorAll('.nav-i').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const s of ['dashboard', 'products', 'schedule', 'pricing', 'activity', 'settings']) $(`tab-${s}`).classList.toggle('hidden', s !== name);
  if (name === 'pricing') loadPricing();
  if (name === 'products') loadProducts();
  if (name === 'settings') loadSettings();
  if (name === 'schedule') loadSchedule();
  if (name === 'activity') loadActivity();
}
document.querySelectorAll('.nav-i').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
$('stReviewBtn').addEventListener('click', () => { state.filter = 'İnceleme'; showTab('products'); });

/* ---------------- terminal ---------------- */
function logLine(e, box = $('logBox')) {
  const line = document.createElement('div');
  line.className = `ll lv-${e.level || 'info'}`;
  const icon = { success: '✔', warn: '⚠', error: '✖' }[e.level] || '›';
  line.innerHTML = `<span class="t">${esc((e.ts || '').slice(11, 19))}</span> ${icon} ${esc(e.msg)}`;
  box.appendChild(line);
  while (box.childElementCount > 1500) box.firstChild.remove();
  if (box !== $('logBox') || $('autoScroll').checked) box.scrollTop = box.scrollHeight;
}
$('btnClearLog').addEventListener('click', () => { $('logBox').innerHTML = ''; });
$('btnOpenLogs').addEventListener('click', async () => { const p = await api.paths(); safe(() => api.openFolder(p.logs)); });

/* ---------------- ilerleme ---------------- */
function renderSteps(active, done = false) {
  const idx = STEPS.indexOf(active);
  $('stepPills').innerHTML = STEPS.map((s, i) => {
    const st = done ? 'done' : idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'now' : '';
    return `<span class="pill ${st}">${st === 'done' ? '✓ ' : ''}${s}</span>`;
  }).join('');
}
function setProgress(p) {
  $('progressBar').style.width = `${p.pct || 0}%`;
  $('progressPct').textContent = `${p.pct || 0}%`;
  $('progressLabel').textContent = p.step === 'Bitti' ? 'Tamamlandı' : `Ürün ${p.current}/${p.total} — ${p.msg || p.step}`;
  renderSteps(p.step === 'Bitti' ? null : p.step, p.step === 'Bitti');
}
renderSteps(null);

/* ---------------- motor durumu ---------------- */
function setEngineStatus() {
  const dot = $('statusDot'), txt = $('statusText');
  if (!state.ready) { dot.style.background = '#a8a29e'; txt.textContent = 'Başlatılıyor…'; }
  else if (state.busy) { dot.style.background = '#b45309'; txt.textContent = `Çalışıyor: ${JOB_LABEL[state.job] || state.job || ''}`; }
  else { dot.style.background = '#15803d'; txt.textContent = 'Hazır'; }
  for (const id of ['btnMake', 'btnStart', 'btnDry', 'btnLogin', 'btnOauth', 'btnImport', 'btnIllu', 'btnAutoText', 'btnAutoIllu', 'btnAutoMix']) $(id).disabled = state.busy || !state.ready;
  $('btnStop').disabled = !state.busy;
  document.querySelectorAll('[data-needs-idle]').forEach((b) => { b.disabled = state.busy || !state.ready; });
}

api.onEvent(({ event, data }) => {
  if (event === 'log') logLine(data);
  else if (event === 'progress') setProgress(data);
  else if (event === 'ready') onReady();
  else if (event === 'busy') {
    const was = state.busy;
    state.busy = data.busy; state.job = data.job || null;
    setEngineStatus();
    if (was && !data.busy) refreshAll();
  } else if (event === 'schedule') renderNext(data.next);
});
function onReady() {
  if (state.ready) return;
  state.ready = true; setEngineStatus(); refreshAll();
  logLine({ level: 'success', msg: 'Hazır.', ts: new Date().toISOString() });
}

/* ---------------- veri ---------------- */
const thumbCache = new Map();
async function thumb(p, w = 420) {
  if (!p) return null;
  const k = `${p}|${w}`;
  if (!thumbCache.has(k)) thumbCache.set(k, await api.thumb(p, w).catch(() => null));
  return thumbCache.get(k);
}

async function loadStats() {
  const s = await api.call('stats').catch(() => null);
  if (!s) return;
  state.stats = s;
  $('stTotal').textContent = s.total;
  $('stUploaded').textContent = s.uploaded;
  $('stReview').textContent = s.review || 0;
  $('stRemaining').textContent = s.remaining;
  $('stLimit').textContent = `/ ${s.remaining + s.today}`;
  $('stCost').textContent = `$${Number(s.cost).toFixed(2)}`;
  $('navReview').textContent = s.review || 0;
  $('navReview').classList.toggle('hidden', !s.review);
}

function qcBadge(p) {
  if (p.qc_pass === false) return '<span class="pc-qc bad">Sorun var</span>';
  if (p.qc_pass === true) return '<span class="pc-qc ok">Kontrol ✓</span>';
  return '';
}

/* ---------------- toplu yükleme (seç → sırayla yükle) ---------------- */
const bulkOk = (p) => ['Hazır', 'İnceleme'].includes(p.status) && p.thumbnail && !p.dry_run;
state.bulk = false; state.sel = new Set();
function bulkBar() {
  const bar = $('bulkBar'); if (!bar) return;
  bar.classList.toggle('hidden', !state.bulk);
  $('bulkCount').textContent = `${state.sel.size} ürün seçildi`;
  $('bulkGo').disabled = !state.sel.size;
  $('btnBulk').textContent = state.bulk ? 'Seçimi kapat' : 'Toplu yükle';
}
async function cardHtml(p, mini = false) {
  const url = await thumb(p.thumbnail, mini ? 360 : 520);
  const err = p.error && ['Hata', 'İnceleme'].includes(p.status) ? `<div class="pc-e">⚠ ${esc(p.error)}</div>` : '';
  const selCls = !mini && state.bulk ? (bulkOk(p) ? (state.sel.has(p.id) ? ' sel' : ' selable') : ' dim') : '';
  return `<div class="pc${selCls}" data-id="${esc(p.id)}">
    <div class="pc-img" style="${url ? `background-image:url('${url}')` : ''}"><span class="badge st-${esc(p.status)}">${esc(p.status)}</span>${qcBadge(p)}</div>
    <div class="pc-b"><div class="pc-t">${esc(p.title || p.keyword || p.id)}</div>
    <div class="pc-m">${fmtDate(p.created_at)} · ${esc(p.keyword || '')}${p.dry_run ? ' · test' : ''} · $${Number(p.cost || 0).toFixed(3)}</div>${mini ? '' : err}
    ${!mini && state.bulk && bulkOk(p) ? `<div class="pc-sel">${state.sel.has(p.id) ? [...state.sel].indexOf(p.id) + 1 : ''}</div>` : ''}
    ${!mini && !state.bulk && p.status === 'Hazır' && p.thumbnail && !p.dry_run ? `<div class="pc-act"><button class="btn xs primary" data-quick-upload="${esc(p.id)}" data-needs-idle>Etsy'ye yükle</button><button class="btn xs ghost" data-quick-view="${esc(p.id)}">İncele</button></div>` : ''}</div></div>`;
}

async function loadProducts() {
  const list = await api.call('products').catch(() => null);
  if (!list) return;
  state.products = list;
  // Üst sekmeler: Etsy'ye yüklenmedi / yüklendi
  const UP = ['Taslak', 'Yayında'];
  const inGroup = (p, g) => (g === 'up' ? UP.includes(p.status) : !UP.includes(p.status));
  if (state.filter) state.group = UP.includes(state.filter) ? 'up' : 'pending';
  const g = state.group || 'pending';
  const cntPending = list.filter((p) => inGroup(p, 'pending') && p.status !== 'Arşiv').length;
  const cntUp = list.filter((p) => inGroup(p, 'up')).length;
  $('groupTabs').innerHTML = `<button class="seg-b ${g === 'pending' ? 'on' : ''}" data-g="pending">Etsy'ye yüklenmedi<i>${cntPending}</i></button>`
    + `<button class="seg-b ${g === 'up' ? 'on' : ''}" data-g="up">Etsy'ye yüklendi<i>${cntUp}</i></button>`;
  document.querySelectorAll('#groupTabs .seg-b').forEach((b) => b.addEventListener('click', () => { state.group = b.dataset.g; state.filter = ''; loadProducts(); }));
  // durum çipleri (seçili sekme içinde)
  const glist = list.filter((p) => inGroup(p, g));
  const counts = {}; for (const p of glist) counts[p.status] = (counts[p.status] || 0) + 1;
  const active = glist.filter((p) => p.status !== 'Arşiv').length;
  $('statusChips').innerHTML = [`<button class="chip ${state.filter === '' ? 'on' : ''}" data-f="">Tümü<i>${active}</i></button>`,
    ...STATUSES.filter((s) => counts[s]).map((s) => `<button class="chip ${state.filter === s ? 'on' : ''}" data-f="${s}">${s}<i>${counts[s]}</i></button>`)].join('');
  document.querySelectorAll('#statusChips .chip').forEach((c) => c.addEventListener('click', () => { state.filter = c.dataset.f; loadProducts(); }));
  const q = state.search.toLowerCase();
  const shown = glist.filter((p) => (state.filter ? p.status === state.filter : p.status !== 'Arşiv'))
    .filter((p) => !q || `${p.title} ${p.keyword} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q));
  $('productGrid').innerHTML = shown.length ? (await Promise.all(shown.map((p) => cardHtml(p)))).join('')
    : '<div class="empty">Bu filtrede ürün yok.</div>';
  const recent = list.filter((p) => p.status !== 'Arşiv').slice(0, 4);
  $('recentGrid').innerHTML = recent.length ? (await Promise.all(recent.map((p) => cardHtml(p, true)))).join('')
    : '<div class="empty">Henüz ürün yok — <b>Test</b> ile ilk paketi oluşturun.</div>';
}
$('searchBox').addEventListener('input', (e) => { state.search = e.target.value; clearTimeout(loadProducts._t); loadProducts._t = setTimeout(loadProducts, 200); });
$('btnRefresh').addEventListener('click', () => { thumbCache.clear(); refreshAll(); });
document.addEventListener('click', (e) => {
  const qu = e.target.closest('[data-quick-upload]');
  if (qu) {
    e.stopPropagation();
    const id = qu.dataset.quickUpload;
    if (!confirm(`Ürün Etsy'ye ${state.config.auto_publish ? 'YAYINLANACAK' : 'taslak olarak yüklenecek'}. Devam edilsin mi?`)) return;
    showTab('dashboard');
    safe(() => api.call('publishOne', { id }), 'Yükleme başarısız: ').then((r) => { if (r) { toast('Etsy\'ye yüklendi ✓'); refreshAll(); } });
    return;
  }
  const c = e.target.closest('.pc');
  if (c && state.bulk && c.closest('#productGrid')) {
    const p = state.products.find((x) => x.id === c.dataset.id);
    if (!p || !bulkOk(p)) return;
    if (state.sel.has(p.id)) state.sel.delete(p.id); else state.sel.add(p.id);
    c.classList.toggle('sel', state.sel.has(p.id)); c.classList.toggle('selable', !state.sel.has(p.id));
    const mark = c.querySelector('.pc-sel'); if (mark) mark.textContent = '';
    // sıra numaralarını tazele
    document.querySelectorAll('#productGrid .pc.sel').forEach((el) => { const m = el.querySelector('.pc-sel'); if (m) m.textContent = [...state.sel].indexOf(el.dataset.id) + 1; });
    bulkBar();
    return;
  }
  if (c) openDetail(c.dataset.id);
});

/* ---------------- ürün detayı ---------------- */
const DZ_BGS = [['checker', 'Ekose (saydamlık)'], ['black', 'Siyah tişört'], ['white', 'Beyaz'], ['red', 'Kırmızı'], ['navy', 'Lacivert']];
let dzBg = 'checker';
try { dzBg = localStorage.getItem('dzBg') || 'checker'; } catch {}
async function openDetail(id) {
  const d = await safe(() => api.call('productDetail', { id }));
  if (!d) return;
  const p = d.product;
  $('mStatus').className = `badge st-${p.status}`; $('mStatus').textContent = p.status;
  $('mTitle').textContent = p.title || p.keyword || p.id;
  const qc = d.qc;
  const designQc = new Map((qc && qc.designs || []).map((x) => [x.file, x]));
  const editable = ['Hazır', 'İnceleme', 'Hata'].includes(p.status) && !!d.trend;

  const mock = await Promise.all(d.mockups.map(async (m, i) => `<div class="g ${i === 0 ? 'main' : ''}" data-open="${esc(m)}" style="background-image:url('${await thumb(m, i === 0 ? 900 : 380)}')"></div>`));
  const des = await Promise.all(d.designs.map(async (m) => {
    const name = m.split(/[\\/]/).pop(); const r = designQc.get(name);
    const ok = r ? !(r.issues && r.issues.length) && !(r.warnings && r.warnings.length) && !(r.vision && r.vision.pass === false) : null;
    const lbl = r ? (ok ? `<div class="gl ok">✓ ${esc((r.vision && r.vision.text_found) || 'geçti')}</div>` : `<div class="gl bad">✗ ${esc((r.vision && r.vision.pass === false && r.vision.reason) || [...(r.issues || []), ...(r.warnings || [])].join(', '))}</div>`) : '';
    const rm = editable ? `<div class="g-acts"><button class="g-x" data-erase="${esc(m)}" title="Tasarımda kalan beyaz alanları tıklayarak sil (ücretsiz)">🧽 Beyaz sil</button><button class="g-x g-re" data-regen="${esc(name)}" title="Bu tasarımı Gemini ile yeniden çizdir (ücretsiz)">↻ Yeniden üret</button>${d.designs.length > 1 ? `<button class="g-x" data-remove="${esc(name)}" title="Bu tasarımı paketten çıkar (ücretsiz)">✕ Çıkar</button>` : ''}</div>` : '';
    return `<div class="g dz" data-open="${esc(m)}" data-design="1"><div class="gi" style="background-image:url('${await thumb(m, 480)}')"></div>${lbl}${rm}</div>`;
  }));
  const rej = await Promise.all(d.rejected.map(async (m) => `<div class="g" data-open="${esc(m)}" style="background-image:url('${await thumb(m, 300)}');background-size:contain;background-color:#e9e9e9;opacity:.7"><div class="gl bad">✗ paketten çıkarıldı</div></div>`));

  const qcHtml = !qc ? '<div class="qc none"><b>Kalite raporu yok</b><span class="small muted">Bu ürün kalite kontrol eklenmeden önce üretilmiş. "Kalite kontrolü çalıştır" ile denetleyebilirsiniz.</span></div>'
    : `<div class="qc ${qc.pass ? 'pass' : 'fail'}"><b>${qc.pass ? '✓ Kalite kontrolden geçti' : `✗ ${qc.issues.length} sorun bulundu`}</b>
      ${qc.issues.length ? `<ul>${qc.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${qc.warnings.length ? `<ul>${qc.warnings.map((i) => `<li class="w">${esc(i)}</li>`).join('')}</ul>` : ''}
      ${qc.mockup ? `<span class="small">Vitrin görseli: ${qc.mockup.pass ? '✓ uygun' : `✗ ${esc(qc.mockup.reason || '')}`}</span>` : ''}
      <span class="small muted">Kontrol: ${fmtDate(qc.checked_at)}</span></div>`;
  const seo = d.seo || {};
  $('mBody').innerHTML = `
    <div class="sec"><div class="dz-head"><h4>Saydam PNG tasarımlar (${d.designs.length})</h4>
        <div class="dz-bg" title="Arka planı değiştirerek saydamlığı kontrol et">${DZ_BGS.map(([k, t]) => `<button class="sw sw-${k} ${k === dzBg ? 'on' : ''}" data-bg="${k}" title="${t}"></button>`).join('')}
        ${d.designs.length ? `<button class="btn xs ghost" data-pngdir="${esc(d.designs[0])}">PNG klasörü</button>` : ''}</div></div>
      ${d.stale ? `<div class="qc fail" style="margin-bottom:8px"><b>${d.mockups.length ? 'Tasarımlar düzenlendi — vitrin eski hâlinde' : 'Son adım: vitrini oluştur'}</b><span class="small">1) Aşağıdaki tasarımlara bak; beyaz kalan yer varsa üstündeki <b>🧽 Beyaz sil</b> ile tıklayıp sil.<br>2) Hepsi temizse <b>Vitrini oluştur</b>'a bas: tişört görselleri, kapak, video ve ZIP'ler son hâlinden hazırlanır.</span><div><button class="btn primary xs" data-rebuild="1" data-needs-idle>Vitrini oluştur</button></div></div>` : ''}
      <div class="gal designs bg-${dzBg}" id="dzGal">${des.join('') || '<span class="small muted">Tasarım yok</span>'}</div>
      ${d.designs.length ? '<span class="small muted">Satılan dosyalar bunlar (4500×5400, 300 DPI). Ekose/renkli zeminde boşluk veya beyaz kenar görünmemeli.</span>' : ''}
      <h4>Vitrin görselleri (${d.mockups.length})${d.video ? ' + video' : ''}</h4><div class="gal">${mock.join('')}</div>
      ${rej.length ? `<h4>Elenen tasarımlar</h4><div class="gal designs">${rej.join('')}</div>` : ''}</div>
    <div class="sec"><h4>Kalite ve politika kontrolü</h4>${qcHtml}
      <h4>Başlık</h4><div class="kv"><button class="btn xs ghost cp" data-copy="title">Kopyala</button><pre>${esc(seo.title || p.title || '')}</pre></div>
      <h4>Etiketler (${(seo.tags || p.tags || []).length})</h4><div class="tags">${(seo.tags || p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <h4>Fiyat</h4><div class="kv">${esc(seo.price ?? '')} ${esc(state.config.currency || '')} · stok ${esc(seo.quantity ?? '')}</div>
      <h4>Açıklama</h4><div class="kv"><button class="btn xs ghost cp" data-copy="description">Kopyala</button><pre>${esc(seo.description || '')}</pre></div>
      <h4>Trend</h4><div class="kv">${esc(d.trend ? `${d.trend.keyword} · ${d.trend.season} · ${d.trend.style}` : '–')}</div></div>`;
  const canUpload = ['Hazır', 'İnceleme', 'Hata'].includes(p.status) && p.thumbnail;
  const canRepair = ['Hazır', 'İnceleme', 'Hata'].includes(p.status) && d.designs.length > 0 && !!d.trend;
  const badCount = qc ? new Set([...(qc.designs || []).filter((r) => (r.issues && r.issues.length) || (r.warnings && r.warnings.length) || (r.vision && r.vision.pass === false)).map((r) => r.file),
    ...((qc.mockup && qc.mockup.garment_inside_design) ? [d.designs[0] && d.designs[0].split(/[\\/]/).pop()] : [])].filter(Boolean)).size : 0;
  const canDrop = canRepair && p.status === 'İnceleme' && badCount > 0 && badCount < d.designs.length;
  $('mFoot').innerHTML = `
    <div class="mf-left">
      <button class="btn xs ghost" data-act="folder">Klasörü aç</button>
      ${d.video ? '<button class="btn xs ghost" data-act="video">Videoyu aç</button>' : ''}
      ${p.listing_url ? '<button class="btn xs ghost" data-act="etsy">Etsy\'de aç</button>' : ''}
      <button class="btn xs ghost" data-act="qc" data-needs-idle title="Kalite ve Etsy kuralları kontrolünü tekrar çalıştırır">Tekrar kontrol et</button>
      ${p.status !== 'Arşiv' ? '<button class="btn xs ghost" data-act="archive">Arşivle</button>' : ''}
      <button class="btn xs ghost danger-text" data-act="delete" data-needs-idle title="Ürünü panelden siler">Sil</button>
    </div>
    <div class="mf-right">
      ${canDrop ? '<button class="btn ghost" data-act="drop" data-needs-idle title="Sorunlu tasarımları paketten çıkarır; görseller ve paket yeniden hazırlanır. Ücretsiz.">Sorunluları çıkar (ücretsiz)</button>' : ''}
      ${canRepair && p.status === 'İnceleme' ? '<button class="btn ghost" data-act="repair" data-needs-idle title="Sorunlu tasarımları yapay zekâ ile yeniden çizer (Replicate kredisi gerekir)">Sorunluları yeniden çiz (~$0.06/adet)</button>' : ''}
      ${d.stale ? '<button class="btn primary" data-act="rebuild" data-needs-idle>Vitrini oluştur</button>' : canUpload ? (p.status === 'İnceleme'
        ? '<button class="btn ghost danger-text" data-act="upload" data-needs-idle>Yine de yükle…</button>'
        : '<button class="btn primary" data-act="upload" data-needs-idle>Etsy\'ye yükle</button>') : ''}
    </div>`;
  setEngineStatus();
  $('mFoot').onclick = async (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'rebuild') {
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('rebuildMedia', { id }), 'Vitrin oluşturulamadı: ');
      if (r) { toast(r.pass ? '✓ Vitrin hazır — kontrol edip Etsy\'ye yükleyebilirsin' : `${r.issues.length} sorun var`, 5000); thumbCache.clear(); refreshAll(); openDetail(id); }
      return;
    }
    if (act === 'folder') safe(() => api.openFolder(p.folder));
    if (act === 'video') safe(() => api.openFile(d.video));
    if (act === 'etsy') safe(() => api.openExternal(p.listing_url));
    if (act === 'archive') { await safe(() => api.call('archive', { id })); closeModal(); refreshAll(); toast('Ürün arşivlendi'); }
    if (act === 'delete') {
      const onEtsy = ['Taslak', 'Yayında'].includes(p.status);
      if (!confirm(`"${p.title || p.keyword}" panelden silinecek.\n\nDosyaları output/_silinenler klasörüne taşınır (gerekirse geri alınabilir).${onEtsy ? '\n\n⚠ Bu ürün Etsy\'ye yüklenmiş: Etsy\'deki ilan SİLİNMEZ, onu Etsy → Listings\'ten ayrıca silmeniz gerekir.' : ''}\n\nDevam edilsin mi?`)) return;
      const r = await safe(() => api.call('deleteProduct', { id }), 'Silinemedi: ');
      if (r) { closeModal(); refreshAll(); toast('Ürün silindi'); }
    }
    if (act === 'drop') {
      if (!confirm(`Hatalı ${badCount} tasarım paketten çıkarılacak; kalan ${d.designs.length - badCount} tasarımla vitrin görselleri, video ve ZIP yeniden hazırlanacak.\n\nÜcretsizdir (yapay zekâ kullanılmaz). Etsy'ye otomatik yüklenmez. Devam edilsin mi?`)) return;
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('dropBad', { id }), 'Düzeltme başarısız: ');
      if (r) { toast(r.pass ? `✓ ${r.remaining}'lü paket hazır` : `${r.issues.length} sorun kaldı`, 5000); thumbCache.clear(); refreshAll(); openDetail(id); }
    }
    if (act === 'repair') {
      const est = (/recraft/.test(state.config.replicate_model || '') ? 0.06 : 0.02);
      if (!confirm(`Sorunlu tasarımlar yeniden üretilecek (tasarım başına ~$${est.toFixed(2)}), vitrin görselleri, video ve paket yenilenip kalite kontrol tekrar çalışacak.\n\nEtsy'ye otomatik YÜKLENMEZ; sonuç temizse "Etsy'ye yükle" ile siz gönderirsiniz. Devam edilsin mi?`)) return;
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('repair', { id }), 'Onarım başarısız: ');
      if (r) { toast(r.pass ? 'Onarıldı ✓ Kalite kontrolden geçti' : `Onarım sonrası ${r.issues.length} sorun kaldı`, 5000); thumbCache.clear(); refreshAll(); openDetail(id); }
    }
    if (act === 'qc') { closeModal(); showTab('dashboard'); const r = await safe(() => api.call('qcRecheck', { id })); if (r) { toast(r.pass ? 'Kalite kontrolden geçti ✓' : `${r.issues.length} sorun bulundu`, 4000); openDetail(id); } }
    if (act === 'upload') {
      const warn = p.status === 'İnceleme' ? 'Bu ürün kalite kontrolden GEÇEMEDİ. Görselleri kendiniz kontrol ettiyseniz devam edin.\n\n' : '';
      if (!confirm(`${warn}Ürün Etsy'ye ${state.config.auto_publish ? 'YAYINLANACAK' : 'taslak olarak yüklenecek'}. Devam edilsin mi?`)) return;
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('publishOne', { id }), 'Yükleme başarısız: ');
      if (r) toast('Etsy\'ye yüklendi ✓');
    }
  };
  $('mBody').onclick = async (e) => {
    const er = e.target.closest('[data-erase]');
    if (er) { e.stopPropagation(); openEraser(id, er.dataset.erase, d.edited.includes(er.dataset.erase.split(/[\\/]/).pop())); return; }
    const rbb = e.target.closest('[data-rebuild]');
    if (rbb) {
      if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('rebuildMedia', { id }), 'Yenileme başarısız: ');
      if (r) { toast(r.pass ? '✓ Vitrin hazır — kontrol edip Etsy\'ye yükleyebilirsin' : `${r.issues.length} sorun var`, 5000); thumbCache.clear(); refreshAll(); openDetail(id); }
      return;
    }
    const rgb = e.target.closest('[data-regen]');
    if (rgb) {
      e.stopPropagation();
      if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
      if (!confirm(`"${rgb.dataset.regen}" Gemini ile yeniden çizdirilecek (ücretsiz, ~1 dk). Eskisi "Elenen tasarımlar"a taşınır. Sonra kontrol edip "Vitrini oluştur"a basarsın. Devam?`)) return;
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('regenGemini', { id, file: rgb.dataset.regen }), 'Yeniden çizim başarısız: ');
      if (r) { toast('✓ Tasarım yenilendi — kontrol et, sonra "Vitrini oluştur"', 6000); thumbCache.clear(); refreshAll(); openDetail(id); }
      return;
    }
    const rmb = e.target.closest('[data-remove]');
    if (rmb) {
      e.stopPropagation();
      if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
      if (!confirm(`"${rmb.dataset.remove}" paketten çıkarılacak; vitrin görselleri, video ve ZIP kalan tasarımlarla yeniden hazırlanacak. Ücretsizdir. Devam edilsin mi?`)) return;
      closeModal(); showTab('dashboard');
      const r = await safe(() => api.call('removeDesigns', { id, files: [rmb.dataset.remove] }), 'Çıkarma başarısız: ');
      if (r) { toast(`✓ ${r.remaining}'lü paket hazır`, 4000); thumbCache.clear(); refreshAll(); openDetail(id); }
      return;
    }
    const bgb = e.target.closest('[data-bg]');
    if (bgb) {
      dzBg = bgb.dataset.bg; try { localStorage.setItem('dzBg', dzBg); } catch {}
      $('dzGal').className = `gal designs bg-${dzBg}`;
      $('mBody').querySelectorAll('[data-bg]').forEach((b) => b.classList.toggle('on', b === bgb));
      return;
    }
    const pd = e.target.closest('[data-pngdir]');
    if (pd) { safe(() => api.openFolder(pd.dataset.pngdir.replace(/[\\/][^\\/]+$/, ''))); return; }
    const g = e.target.closest('[data-open]');
    if (g) { const gi = g.querySelector('.gi') || g; $('lightbox').className = g.dataset.design ? `lightbox dz-lb bg-${dzBg}` : 'lightbox'; $('lbImg').src = gi.style.backgroundImage.slice(5, -2); thumb(g.dataset.open, 1600).then((u) => { if (u) $('lbImg').src = u; }); $('lightbox').classList.remove('hidden'); }
    const cp = e.target.closest('[data-copy]');
    if (cp) { navigator.clipboard.writeText(seo[cp.dataset.copy] || '').then(() => toast('Kopyalandı')); }
  };
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
$('mClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
const ER = { id: null, path: null, changed: false, busy: false, queue: [] };
const HINT = 'Beyaz kalan yere tıkla → silinir. Çok yer varsa <b>Ctrl</b> basılı tutup hepsine tıkla, Ctrl\'yi bırakınca hepsi birden silinir.';
function drawMarks() {
  $('lbMarks').innerHTML = ER.queue.map((q, i) => `<div class="lb-mark" style="left:${q.fx * 100}%;top:${q.fy * 100}%">${i + 1}</div>`).join('');
  const n = ER.queue.length;
  $('lbRun').classList.toggle('hidden', !n); $('lbClear').classList.toggle('hidden', !n);
  $('lbRun').textContent = `Seçilenleri sil (${n})`;
}
function closeLightbox() {
  $('lightbox').classList.add('hidden'); $('lbBar').classList.add('hidden'); $('lightbox').classList.remove('erasing');
  ER.queue = []; $('lbMarks').innerHTML = '';
  if (ER.id && ER.changed) { const id = ER.id; ER.id = null; ER.changed = false; thumbCache.clear(); openDetail(id); }
  ER.id = null;
}
async function lbReload() {
  for (const k of [...thumbCache.keys()]) if (k.startsWith(`${ER.path}|`)) thumbCache.delete(k);
  const u = await thumb(ER.path, 1600); if (u) $('lbImg').src = u;
}
function openEraser(id, p, hasUndo) {
  Object.assign(ER, { id, path: p, changed: false, busy: false, queue: [] });
  $('lightbox').className = `lightbox dz-lb bg-${dzBg} erasing`;
  $('lbBar').classList.remove('hidden'); $('lbHint').innerHTML = HINT; drawMarks();
  $('lbUndo').disabled = !hasUndo; $('lbReset').disabled = !hasUndo;
  $('lbImg').src = ''; lbReload();
}
async function eraseNow(points) {
  if (ER.busy || !points.length) return;
  ER.busy = true; $('lbHint').textContent = points.length > 1 ? `${points.length} bölge siliniyor…` : 'Siliniyor…';
  const r = await safe(() => api.call('eraseWhite', { id: ER.id, file: ER.path.split(/[\\/]/).pop(), points }), '');
  ER.busy = false; ER.queue = []; drawMarks(); $('lbHint').innerHTML = HINT;
  if (r) { ER.changed = true; $('lbUndo').disabled = false; $('lbReset').disabled = false; await lbReload(); toast(`Silindi: ${r.done} bölge${r.missed ? ` (${r.missed} noktada beyaz yoktu)` : ''}`); }
}
$('lightbox').addEventListener('click', async (e) => {
  if (!ER.id) return closeLightbox();
  if (e.target.id === 'lbDone') return closeLightbox();
  if (e.target.id === 'lbRun') return eraseNow(ER.queue.slice());
  if (e.target.id === 'lbClear') { ER.queue = []; drawMarks(); return; }
  if (e.target.id === 'lbUndo' || e.target.id === 'lbReset') {
    const all = e.target.id === 'lbReset';
    if (all && !confirm('Bu tasarımdaki bütün silmeler geri alınacak. Emin misin?')) return;
    const r = await safe(() => api.call('undoErase', { id: ER.id, file: ER.path.split(/[\\/]/).pop(), all }), 'Geri alınamadı: ');
    if (r) { ER.changed = true; ER.queue = []; drawMarks(); const none = !r.left; $('lbUndo').disabled = none; $('lbReset').disabled = none; lbReload(); toast(all ? 'Tasarım ilk hâline döndü' : 'Son silme geri alındı'); }
    return;
  }
  if (e.target.id !== 'lbImg') { if (!e.target.closest('#lbBar')) closeLightbox(); return; }
  if (ER.busy) return;
  const img = $('lbImg'); const pt = { fx: e.offsetX / img.clientWidth, fy: e.offsetY / img.clientHeight };
  if (e.ctrlKey || e.metaKey) { ER.queue.push(pt); drawMarks(); return; }
  eraseNow([...ER.queue, pt]);
});
document.addEventListener('keyup', (e) => {
  if ((e.key === 'Control' || e.key === 'Meta') && ER.id && ER.queue.length && !ER.busy) eraseNow(ER.queue.slice());
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('lightbox').classList.contains('hidden')) closeLightbox(); else closeModal(); } });

/* ---------------- üretim aksiyonları ---------------- */
document.querySelectorAll('.sb').forEach((b) => b.addEventListener('click', () => {
  const i = $('countInput'); i.value = Math.max(1, Math.min(20, (Number(i.value) || 1) + Number(b.dataset.step)));
}));
$('btnMake').addEventListener('click', () => {
  const count = Math.max(1, Math.min(20, Number($('countInput').value) || 1));
  const est = (count * (/recraft/.test(state.config.replicate_model || '') ? 0.2 : 0.09)).toFixed(2);
  if (!confirm(`${count} ürün üretilecek ve kalite kontrolden geçirilecek. Etsy'ye YÜKLENMEZ; beğendiklerinizi "Ürünler" sekmesinden siz yüklersiniz.\nTahmini API maliyeti: ~$${est}\n\nBaşlatılsın mı?`)) return;
  setProgress({ pct: 0, current: 0, total: count, step: 'Trend', msg: 'Başlatılıyor' });
  api.call('run', { count, dryRun: false, publish: false })
    .then((r) => { if (r && r.produced) { toast(`${r.produced} ürün hazır — Ürünler sekmesinden inceleyip yükleyin`, 6000); state.filter = ''; } })
    .catch((e) => toast(e.message, 5000));
});
$('btnStart').addEventListener('click', () => {
  if (state.config.require_approval ?? true) {
    if (!confirm('Onaylı mod açık: ürünler üretilecek ama Etsy\'ye otomatik yüklenmeyecek.\n(Doğrudan yükleme için Ayarlar → "Onaylı mod"u kapatın.)\n\nYine de üretilsin mi?')) return;
  }
  const count = Math.max(1, Math.min(20, Number($('countInput').value) || 1));
  const est = (count * (/recraft/.test(state.config.replicate_model || '') ? 0.2 : 0.09)).toFixed(2);
  if (!confirm(`${count} ürün üretilip kalite kontrolden geçenler Etsy'ye ${state.config.auto_publish ? 'doğrudan YAYINLANACAK' : 'taslak olarak kaydedilecek'}.\nTahmini API maliyeti: ~$${est}\n\nBaşlatılsın mı?`)) return;
  setProgress({ pct: 0, current: 0, total: count, step: 'Trend', msg: 'Başlatılıyor' });
  api.call('run', { count, dryRun: false, publish: true }).catch((e) => toast(e.message, 5000));
});
$('btnDry').addEventListener('click', () => {
  setProgress({ pct: 0, current: 0, total: 1, step: 'Trend', msg: 'Test başlatılıyor' });
  api.call('run', { count: 1, dryRun: true }).then((r) => toast(r && r.produced ? 'Test paketi hazır ✓' : 'Test tamamlanamadı, terminale bakın', 4000)).catch((e) => toast(e.message, 5000));
});
$('btnStop').addEventListener('click', () => api.call('stop').then(() => toast('Durdurma isteği gönderildi')));
$('btnLogin').addEventListener('click', () => {
  toast('Tarayıcı açılıyor — Etsy hesabınıza giriş yapın', 4000);
  api.call('login').then(() => { toast('Etsy oturumu kaydedildi ✓'); refreshSetup(); }).catch((e) => toast(e.message, 5000));
});
$('btnOauth').addEventListener('click', () => api.call('oauth').then(() => toast('Etsy API yetkisi kaydedildi ✓')).catch((e) => toast(e.message, 5000)));

/* ---------------- kurulum kontrol listesi ---------------- */
async function refreshSetup() {
  const session = await api.call('etsySession').catch(() => null);
  state.session = session;
  const hasKey = !!(state.env.REPLICATE_API_TOKEN || '').trim();
  const tested = state.products.some((p) => p.dry_run) || state.products.length > 0;
  const sched = (state.sched && state.sched.schedule.enabled) || (state.wt && state.wt.installed);
  const items = [
    { ok: hasKey, t: 'Replicate anahtarı', d: hasKey ? 'Kayıtlı' : 'Ayarlar\'a yapıştırın', btn: hasKey ? '' : '<button class="btn xs ghost" data-goto2="settings">Ayarlar</button>' },
    { ok: !!(session && session.ok), t: 'Etsy oturumu', d: session && session.ok ? `Geçerli${session.expires ? ` · ${new Date(session.expires).toLocaleDateString('tr-TR')} tarihine kadar` : ''}` : 'Bir kez giriş yapın', btn: session && session.ok ? '' : '<button class="btn xs ghost" data-act2="login">Giriş yap</button>' },
    { ok: tested, t: 'İlk üretim', d: tested ? 'Yapıldı' : 'Ücretsiz test üretimi yapın', btn: tested ? '' : '<button class="btn xs ghost" data-act2="dry">Test et</button>' },
    { ok: !!sched, t: 'Zamanlayıcı', d: sched ? 'Kurulu' : 'Otomatik üretim için kurun', btn: sched ? '' : '<button class="btn xs ghost" data-goto2="schedule">Kur</button>' },
  ];
  $('setupList').innerHTML = items.map((i) => `<div class="setup-i ${i.ok ? 'ok' : ''}"><span class="ck">${i.ok ? '✓' : '•'}</span><div><b>${i.t}</b><span>${esc(i.d)}</span>${i.btn ? `<div>${i.btn}</div>` : ''}</div></div>`).join('');
  $('setupCard').classList.toggle('hidden', items.every((i) => i.ok));
}
$('setupList').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto2]'); if (g) showTab(g.dataset.goto2);
  const a = e.target.closest('[data-act2]'); if (a) $(a.dataset.act2 === 'login' ? 'btnLogin' : 'btnDry').click();
});

/* ---------------- zamanlayıcılar ---------------- */
function scheduleFormHtml(prefix, s) {
  return `<div class="f"><span>Günler</span><div class="days" id="${prefix}Days">${DAY_NAMES.map(([n, d]) => `<button class="day ${s.days.includes(d) ? 'on' : ''}" data-d="${d}">${n}</button>`).join('')}</div></div>
    <div class="f"><span>Saatler</span><div class="times" id="${prefix}Times">${s.times.map((t) => `<span class="time-i"><input type="time" value="${t}" /><button title="Kaldır">✕</button></span>`).join('')}<button class="btn xs ghost" data-addtime>+ Saat ekle</button></div></div>
    <label class="f"><span>Her çalıştırmada üretilecek ürün</span><input class="input" type="number" min="1" max="20" id="${prefix}Count" value="${s.count}" style="width:120px" /></label>`;
}
function bindScheduleForm(prefix) {
  const root = $(`${prefix}Form`);
  root.onclick = (e) => {
    const d = e.target.closest('.day'); if (d) d.classList.toggle('on');
    if (e.target.closest('[data-addtime]')) {
      const span = document.createElement('span'); span.className = 'time-i'; span.innerHTML = '<input type="time" value="18:00" /><button title="Kaldır">✕</button>';
      e.target.closest('[data-addtime]').before(span);
    }
    const x = e.target.closest('.time-i button'); if (x) x.parentElement.remove();
  };
}
function readScheduleForm(prefix) {
  return {
    days: [...document.querySelectorAll(`#${prefix}Days .day.on`)].map((b) => Number(b.dataset.d)),
    times: [...document.querySelectorAll(`#${prefix}Times input`)].map((i) => i.value).filter(Boolean),
    count: Number($(`${prefix}Count`).value) || 1,
  };
}
function renderNext(next) {
  const txt = next ? `Sonraki planlı üretim: ${next.label}` : 'Panel zamanlayıcısı kapalı';
  $('sideNext').textContent = txt;
  $('nextRunInline').textContent = next ? `${next.label}` : '';
  $('navSched').classList.toggle('hidden', !next);
  if ($('schedNext')) $('schedNext').textContent = next ? `${txt}` : 'Zamanlayıcı kapalı. Açmak için sağ üstteki anahtarı kullanın.';
}
async function loadSchedule() {
  const r = await api.getSchedule();
  state.sched = r;
  $('schedForm').innerHTML = scheduleFormHtml('sched', r.schedule);
  bindScheduleForm('sched');
  $('schedSwitch').classList.toggle('on', !!r.schedule.enabled);
  renderNext(r.next);
  await loadWinTask();
}
$('schedSwitch').addEventListener('click', () => $('schedSwitch').classList.toggle('on'));
$('btnSchedSave').addEventListener('click', async () => {
  const f = readScheduleForm('sched');
  if (!f.days.length || !f.times.length) return toast('En az bir gün ve bir saat seçin');
  const r = await safe(() => api.saveSchedule({ ...f, enabled: $('schedSwitch').classList.contains('on') }));
  if (r) { state.sched = r; renderNext(r.next); toast(r.schedule.enabled ? 'Panel zamanlayıcısı açık ✓' : 'Panel zamanlayıcısı kapatıldı'); refreshSetup(); }
});

async function loadWinTask() {
  const st = await api.winTaskStatus().catch((e) => ({ installed: false, error: e.message }));
  state.wt = st;
  const base = st.config || (state.sched && state.sched.schedule) || { days: [1, 2, 3, 4, 5, 6, 0], times: ['10:00'], count: 3 };
  $('wtForm').innerHTML = scheduleFormHtml('wt', { days: base.days, times: base.times, count: base.count });
  bindScheduleForm('wt');
  $('wtBadge').className = `badge ${st.installed ? 'b-ok' : 'b-off'}`;
  $('wtBadge').textContent = st.supported === false ? 'Desteklenmiyor' : st.installed ? 'Kurulu' : 'Kurulu değil';
  $('wtInfo').innerHTML = st.installed
    ? `Sonraki çalışma: <b>${esc(st.next || '–')}</b><br>Son çalışma: ${esc(st.last || '–')} · Sonuç: ${esc(st.lastResult || '–')}<br><span class="small muted">Çıktılar: logs\\scheduled.log</span>`
    : 'Görev kurulu değil. Gün, saat ve adet seçip "Görevi kur" deyin.';
  $('btnWtRemove').disabled = !st.installed; $('btnWtRun').disabled = !st.installed;
}
$('btnWtInstall').addEventListener('click', async () => {
  const f = readScheduleForm('wt');
  if (!f.days.length || !f.times.length) return toast('En az bir gün ve bir saat seçin');
  const r = await safe(() => api.winTaskInstall(f), 'Görev kurulamadı: ');
  if (r) { toast('Windows görevi kuruldu ✓'); loadWinTask(); refreshSetup(); }
});
$('btnWtRemove').addEventListener('click', async () => {
  if (!confirm('Windows görevi kaldırılsın mı?')) return;
  if (await safe(() => api.winTaskRemove())) { toast('Görev kaldırıldı'); loadWinTask(); refreshSetup(); }
});
$('btnWtRun').addEventListener('click', async () => {
  if (!confirm('Windows görevi şimdi çalıştırılsın mı? (Ürünler üretilip Etsy\'ye yüklenir)')) return;
  if (await safe(() => api.winTaskRun())) toast('Görev başlatıldı — ilerlemeyi Etkinlik sekmesinden izleyin', 5000);
});

/* ---------------- etkinlik ---------------- */
async function loadActivity() {
  const rows = await api.activity(400);
  const f = $('actFilter').value;
  const box = $('actList'); box.innerHTML = '';
  const shown = rows.filter((r) => !f || r.level === f);
  if (!shown.length) { box.innerHTML = '<div class="muted">Kayıt yok.</div>'; return; }
  for (const r of shown) {
    const line = document.createElement('div');
    line.className = `ll lv-${r.level || 'info'}`;
    line.innerHTML = `<span class="t">${esc(fmtDate(r.ts))}</span> ${esc(r.msg)}`;
    box.appendChild(line);
  }
  box.scrollTop = box.scrollHeight;
}
$('btnActRefresh').addEventListener('click', loadActivity);
$('actFilter').addEventListener('change', loadActivity);

/* ---------------- ayarlar ---------------- */
async function loadConfigInfo() {
  const { config, env } = await api.getSettings();
  state.config = config; state.env = env;
  $('modeInfo').textContent = config.publish_mode === 'api' ? 'Yükleme: Etsy API' : 'Yükleme: tarayıcı';
  $('publishInfo').textContent = config.auto_publish ? 'Etsy\'de direkt yayınlanır' : 'Etsy\'ye taslak olarak gider';
  $('modelInfo').textContent = /recraft/.test(config.replicate_model || '') ? 'Model: Recraft V3' : 'Model: Flux Schnell';
  $('btnOauth').classList.toggle('hidden', config.publish_mode !== 'api');
}
const CFG_DEFAULTS = { require_approval: true, qc_enabled: true, qc_vision: true, qc_block_on_fail: true, qc_drop_failed: true, close_to_tray: true, ai_disclosure: true, qc_max_regenerate: 2 };
async function loadSettings() {
  const { env, config } = await api.getSettings();
  document.querySelectorAll('[data-env]').forEach((el) => { el.value = env[el.dataset.env] || ''; });
  document.querySelectorAll('[data-cfg]').forEach((el) => { el.value = config[el.dataset.cfg] ?? CFG_DEFAULTS[el.dataset.cfg] ?? ''; });
  document.querySelectorAll('[data-cfg-switch]').forEach((el) => { const k = el.dataset.cfgSwitch; el.classList.toggle('on', !!(config[k] ?? CFG_DEFAULTS[k])); });
}
document.querySelectorAll('[data-cfg-switch]').forEach((el) => el.addEventListener('click', () => el.classList.toggle('on')));
$('showKeys').addEventListener('change', (e) => document.querySelectorAll('[data-env]').forEach((el) => {
  if (/TOKEN|KEY|SECRET/.test(el.dataset.env)) el.type = e.target.checked ? 'text' : 'password';
}));
$('btnReloadSettings').addEventListener('click', loadSettings);
$('btnSaveSettings').addEventListener('click', async () => {
  const env = {}, config = {};
  document.querySelectorAll('[data-env]').forEach((el) => { env[el.dataset.env] = el.value.trim(); });
  document.querySelectorAll('[data-cfg]').forEach((el) => { config[el.dataset.cfg] = el.dataset.type === 'number' ? Number(el.value) : el.value; });
  document.querySelectorAll('[data-cfg-switch]').forEach((el) => { config[el.dataset.cfgSwitch] = el.classList.contains('on'); });
  if (!(config.price >= 1)) return toast('Fiyat geçersiz');
  if (!(config.daily_limit >= 1)) return toast('Günlük limit en az 1 olmalı');
  await api.saveSettings({ env, config });
  toast('Ayarlar kaydedildi ✓');
  refreshAll();
});

/* ---------------- genel yenileme ---------------- */
async function refreshAll() {
  await loadConfigInfo().catch(() => {});
  await Promise.all([loadStats(), loadProducts()]);
  state.sched = await api.getSchedule().catch(() => state.sched);
  if (state.sched) renderNext(state.sched.next);
  if (!state.wt) state.wt = await api.winTaskStatus().catch(() => null);
  refreshSetup();
}

setEngineStatus();
setInterval(() => { if (state.ready) { loadStats(); api.getSchedule().then((r) => { state.sched = r; renderNext(r.next); }).catch(() => {}); } }, 30000);
// Motor pencereden önce hazır olduysa "ready" olayı kaçmış olabilir: durumu doğrudan sor
(async function syncStatus(tries = 0) {
  if (state.ready) return;
  try {
    const st = await api.status();
    if (st.ready) { state.busy = !!st.busy; state.job = st.job || null; onReady(); return; }
  } catch { /* motor henüz başlamadı */ }
  if (tries < 60) setTimeout(() => syncStatus(tries + 1), 1000);
}());

/* ---------------- Kendi tasarımlarından ürün (Gemini) ---------------- */
const IMP = { files: [], mode: 'text' };
async function renderImpPrompts(force = false) {
  const kw = $('impKw').value.trim();
  if (!kw) { $('impPrompts').innerHTML = '<span class="small muted">Konu bekleniyor…</span>'; return; }
  if (force || !IMP.prompts || IMP.promptsFor !== `${IMP.mode}|${kw}`) {
    const ps = await safe(() => api.call(IMP.mode === 'illustration' ? 'illuPrompts' : 'designPrompts', { subject: kw, n: 4 }));
    if (!ps) return;
    IMP.prompts = ps; IMP.promptsFor = `${IMP.mode}|${kw}`; IMP.copied = new Set();
  }
  $('impPrompts').innerHTML = IMP.prompts.map(([n, p], i) => `<div class="imp-p"><div class="imp-ph"><b>${i + 1}. ${esc(n)}</b><button class="btn xs ghost" data-imp-copy="${i}">Kopyala</button></div><pre>${esc(p)}</pre></div>`).join('')
    + '<div class="imp-kwrow"><button class="btn xs ghost" id="impReshuffle">Farklı 4 talimat</button><button class="btn xs ghost" id="impOpenGemini">Gemini\'yi aç ↗</button></div>';
}
async function renderImpFiles() {
  const tiles = await Promise.all(IMP.files.map(async (f, i) => {
    const u = await api.thumbPicked(f, 300);
    return `<div class="g dz"><div class="gi" style="background-image:url('${u || ''}')"></div><div class="gl">${esc(f.split(/[\\/]/).pop())}</div><div class="g-acts"><button class="g-x" data-imp-rm="${i}">✕</button></div></div>`;
  }));
  $('impFiles').innerHTML = tiles.join('');
  $('impGo').disabled = !IMP.files.length || $('impKw').value.trim().length < 3 || state.busy;
}
IMP.seen = [];
async function suggestTopic() {
  if (IMP.mode === 'illustration') {
    const t = await safe(() => api.call('illuTopic', { exclude: IMP.seen }));
    if (t) { IMP.seen.push(t); IMP.trend = null; $('impKw').value = t; $('impKwInfo').textContent = 'Yazısız resimli tasarım konusu. Beğenmezsen "Başka konu" de ya da kendin yaz (ör. vintage christmas fox).'; }
    renderImpPrompts(); $('impGo').disabled = !IMP.files.length || $('impKw').value.trim().length < 3 || state.busy;
    return;
  }
  $('impSuggest').disabled = true; $('impKw').value = ''; $('impKw').placeholder = 'Satılabilir konu aranıyor… (10-20 sn)';
  $('impKwInfo').textContent = 'Google ve sezon takvimine bakılıyor…';
  const t = await safe(() => api.call('suggestTopic', { exclude: IMP.seen }), 'Konu bulunamadı: ');
  $('impSuggest').disabled = false; $('impKw').placeholder = 'ör. teacher christmas';
  if (t) {
    IMP.trend = t; IMP.seen.push(t.keyword);
    $('impKw').value = t.niche;
    $('impKwInfo').textContent = `Sezon: ${t.season}${t.days_until ? ` (${t.days_until} gün kaldı)` : ''} · Etsy araması: "${t.keyword}". Beğenmezsen "Başka konu" de ya da kendin yaz.`;
  } else $('impKwInfo').textContent = 'Konuyu kendin yaz (İngilizce).';
  renderImpPrompts(); $('impGo').disabled = !IMP.files.length || $('impKw').value.trim().length < 3 || state.busy;
}
const IMP_TIPS = {
  text: '<li>Arka plan düz beyaz olmalı; tişört/kâğıt/çerçeve çizilmiş görselleri seçme.</li><li>Yazılarda harf hatası olmamalı.</li><li>Marka, ünlü, çizgi film karakteri olmamalı (Etsy kapatır).</li>',
  illustration: '<li>Zemin düz pembe/magenta olmalı (talimat bunu ister). Gemini beyaz zemin verirse aynı sohbette "make the background solid magenta #FF00FF" yaz.</li><li>Görselde yazı/imza olmamalı.</li><li>Kırmızı burunlu geyik (Rudolph), çizgi film karakteri, marka olmamalı.</li>',
};
function setImpMode(mode) {
  if (IMP.mode !== mode) { IMP.mode = mode; IMP.prompts = null; IMP.trend = null; $('impKw').value = ''; IMP.files = []; }
  $('impTitle').textContent = mode === 'illustration' ? 'Resimli PNG yap (yazısız)' : 'Yeni ürün yap';
  $('impTips').innerHTML = IMP_TIPS[mode];
}
async function autoGemini(mode) {
  if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
  if (!confirm(`${mode === 'everyday' ? '🌿 GÜNLÜK / HER MEVSİM (Noel\'siz, yıl boyu satan konular, yazısız)' : mode === 'vintage' ? '🎅 VINTAGE NOEL (gerçekçi Noel Baba / ren geyiği, yazısız)' : mode === 'mix' ? '🔀 KARIŞIK sıradaki ürün (yazılı → günlük → vintage Noel → günlük → resimli)' : mode === 'illustration' ? '🖼 RESİMLİ (yazısız, hayvan/manzara)' : '🔤 YAZILI'}: 4 tasarım Gemini ile otomatik çizdirilecek (2-5 dk).\n\nİlk seferde açılan pencerede Google hesabına giriş yapman gerekir. Pencereyi kapatma. Devam?`)) return;
  showTab('dashboard');
  const r = await safe(() => api.call('autoGemini', { mode }), 'Otomatik üretim başarısız: ');
  if (r) { toast('Tasarımlar hazır — kontrol et, gerekirse 🧽 Beyaz sil, sonra "Vitrini oluştur"', 7000); refreshAll(); openDetail(r.id); }
}
$('btnAutoIllu').addEventListener('click', () => autoGemini('illustration'));
$('btnAutoText').addEventListener('click', () => autoGemini('text'));
$('btnAutoMix').addEventListener('click', () => autoGemini('mix'));
$('btnAutoVint').addEventListener('click', () => autoGemini('vintage'));
$('btnAutoDay').addEventListener('click', () => autoGemini('everyday'));
$('btnIllu').addEventListener('click', () => {
  setImpMode('illustration');
  renderImpPrompts(); renderImpFiles(); $('impModal').classList.remove('hidden');
  if (!$('impKw').value.trim()) suggestTopic();
});
$('btnImport').addEventListener('click', () => {
  setImpMode('text');
  renderImpPrompts(); renderImpFiles(); $('impModal').classList.remove('hidden');
  if (!$('impKw').value.trim()) suggestTopic();
});
$('impSuggest').addEventListener('click', () => suggestTopic());
async function pasteImage() {
  if (IMP.files.length >= 5) return toast('En fazla 5 görsel');
  const r = await safe(() => api.pasteImage());
  if (!r) return toast('Panoda görsel yok — Gemini\'de görsele sağ tık → "Görseli kopyala"', 4500);
  if (IMP.files.includes(r.path)) return toast('Bu görsel zaten eklendi — Gemini\'de bir sonraki görseli kopyalayın', 4000);
  if (Math.min(r.width, r.height) < 700) toast(`Uyarı: görsel küçük (${r.width}x${r.height}); baskı kalitesi düşebilir`, 4500);
  IMP.files.push(r.path); renderImpFiles(); toast(`Görsel eklendi (${IMP.files.length}/5)`);
}
$('impPaste').addEventListener('click', () => pasteImage());
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !$('impModal').classList.contains('hidden') && document.activeElement !== $('impKw')) { e.preventDefault(); pasteImage(); }
});
$('impClose').addEventListener('click', () => $('impModal').classList.add('hidden'));
$('impKw').addEventListener('input', () => { clearTimeout(IMP._t); IMP._t = setTimeout(() => renderImpPrompts(), 700); $('impGo').disabled = !IMP.files.length || $('impKw').value.trim().length < 3 || state.busy; });
$('impPick').addEventListener('click', async () => {
  const fs2 = await safe(() => api.pickImages());
  if (fs2 && fs2.length) { IMP.files = [...IMP.files, ...fs2.filter((f) => !IMP.files.includes(f))].slice(0, 5); renderImpFiles(); }
});
$('impModal').addEventListener('click', (e) => {
  const c = e.target.closest('[data-imp-copy]');
  if (c) { (IMP.copied = IMP.copied || new Set()).add(+c.dataset.impCopy); navigator.clipboard.writeText((IMP.prompts || [])[+c.dataset.impCopy][1]).then(() => { c.closest('.imp-p').classList.add('done'); toast('Kopyalandı — açılan yeni Gemini sohbetine yapıştırın (Ctrl+V)', 4500); safe(() => api.openExternal('https://gemini.google.com/app')); }); return; }
  if (e.target.id === 'impReshuffle') { renderImpPrompts(true); return; }
  const r = e.target.closest('[data-imp-rm]');
  if (r) { IMP.files.splice(+r.dataset.impRm, 1); renderImpFiles(); return; }
  if (e.target.id === 'impOpenGemini') safe(() => api.openExternal('https://gemini.google.com/app'));
});
$('impGo').addEventListener('click', async () => {
  const keyword = $('impKw').value.trim();
  if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
  $('impModal').classList.add('hidden'); showTab('dashboard');
  const used = (IMP.prompts || []).filter((_, i) => !IMP.copied || !IMP.copied.size || IMP.copied.has(i)).map((p) => p[2]).filter(Boolean);
  const r = await safe(() => api.call('importDesigns', { files: IMP.files, keyword, trend: IMP.trend || null, mode: IMP.mode, designs: IMP.mode === 'illustration' ? used : null }), 'İçe aktarma başarısız: ');
  if (r) {
    IMP.files = []; $('impKw').value = ''; IMP.trend = null;
    toast(r.review ? 'Tasarımlar hazır — kontrol et, gerekirse 🧽 Beyaz sil, sonra "Vitrini oluştur"' : r.pass ? '✓ Ürün hazır — Ürünler sekmesinden kontrol edip yükleyin' : `Ürün incelemede: ${r.issues.length} sorun`, 7000);
    refreshAll(); openDetail(r.id);
  }
});

/* ---------------- Fiyat & İndirim ---------------- */
const TL = (x) => `${Number(x).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
function calcHtml(c) {
  return `<span>Müşterinin gördüğü (KDV dahil)</span><b>${TL(c.buyerSees)}</b>
    <span>Satış fiyatı${c.discountPct ? ` (%${c.discountPct} indirimli)` : ''}</span><span>${TL(c.sale)}</span>
    <span class="muted">− İşlem ücreti</span><span class="neg">${TL(c.fees.transaction)}</span>
    <span class="muted">− Ödeme işleme</span><span class="neg">${TL(c.fees.processing)}</span>
    <span class="muted">− Düzenleyici ücret</span><span class="neg">${TL(c.fees.regulatory)}</span>
    <span class="muted">− Listeleme yenileme</span><span class="neg">${TL(c.fees.listing)}</span>
    <span class="muted">− Ücretlere KDV</span><span class="neg">${TL(c.fees.vat)}</span>
    <span class="tot">Satış başına eline geçen</span><span class="tot ${c.net > 0 ? 'pos' : 'neg'}">${TL(c.net)} (%${c.marginPct})</span>`;
}
async function refreshPricing() {
  const price = Number($('prPrice').value) || 0;
  const c = await safe(() => api.call('priceCalc', { price, discount: Number($('prDisc').value) || 0 }));
  if (c) {
    $('prCalc').innerHTML = calcHtml(c);
    const goal = Number($('prGoal').value) || 0;
    $('prNeed').textContent = c.net > 0 && goal > 0 ? `${Math.ceil(goal / c.net)} satış / ay (~${Math.ceil(goal / c.net / 30)} / gün)` : '–';
  }
  const s = await safe(() => api.call('priceCalc', { price, discount: Number($('saPct').value) || 0 }));
  if (s) $('saCalc').innerHTML = calcHtml(s);
}
async function loadPricing() {
  const { config } = await api.getSettings();
  if (!$('prPrice').value) $('prPrice').value = config.price || 109.99;
  refreshPricing();
}
for (const id of ['prPrice', 'prDisc', 'prGoal', 'saPct']) $(id).addEventListener('input', () => { clearTimeout(refreshPricing._t); refreshPricing._t = setTimeout(refreshPricing, 250); });
$('prSave').addEventListener('click', async () => {
  const price = Number($('prPrice').value);
  if (!(price > 0)) return toast('Geçerli bir fiyat yaz');
  await safe(() => api.saveSettings({ config: { price } }));
  toast(`Yeni ürünler ${TL(price)} ile yüklenecek`);
});
$('prApply').addEventListener('click', async () => {
  const price = Number($('prPrice').value);
  if (!(price > 0)) return toast('Geçerli bir fiyat yaz');
  if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
  if (!confirm(`Etsy'deki yayında ve taslaktaki tüm paket ilanlarının fiyatı ${TL(price)} yapılacak (tek tasarımlık eski ilanlara dokunulmaz). Yeni ürünler de bu fiyatla yüklenecek.\n\nBir tarayıcı penceresi açılıp ilanlar tek tek güncellenecek (ilan başına ~10 sn). Devam?`)) return;
  await safe(() => api.saveSettings({ config: { price } }));
  showTab('dashboard');
  const r = await safe(() => api.call('updatePrices', { price }), 'Fiyat güncelleme başarısız: ');
  if (r) toast(`✓ ${r.changed} ilanın fiyatı güncellendi${r.failed ? `, ${r.failed} hata` : ''}`, 6000);
});
$('saStart').addEventListener('click', async () => {
  const pct = Number($('saPct').value), days = Number($('saDays').value);
  if (!(pct >= 5 && pct <= 75)) return toast('İndirim %5–75 arasında olmalı');
  if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
  if (!confirm(`Etsy'de tüm dükkâna %${pct} indirim ${days} gün boyunca başlatılacak. Müşteriler hemen indirimli fiyatı görür. Devam?`)) return;
  showTab('dashboard');
  const r = await safe(() => api.call('createSale', { pct, days }), 'İndirim başlatılamadı: ');
  if (r) toast(`✓ %${r.pct} indirim başladı (${r.end} tarihine kadar)`, 6000);
});

/* toplu yükleme düğmeleri */
$('btnBulk').addEventListener('click', () => { state.bulk = !state.bulk; state.sel.clear(); if (state.bulk) { state.group = 'pending'; state.filter = ''; } bulkBar(); loadProducts(); });
$('bulkCancel').addEventListener('click', () => { state.bulk = false; state.sel.clear(); bulkBar(); loadProducts(); });
$('bulkAll').addEventListener('click', () => {
  const vis = [...document.querySelectorAll('#productGrid .pc')].map((el) => el.dataset.id);
  for (const id of vis) { const p = state.products.find((x) => x.id === id); if (p && bulkOk(p)) state.sel.add(id); }
  bulkBar(); loadProducts();
});
$('bulkGo').addEventListener('click', async () => {
  const ids = [...state.sel]; if (!ids.length) return;
  if (!confirm(`${ids.length} ürün seçtiğin sırayla Etsy'ye ${state.config.auto_publish ? 'YAYINLANACAK' : 'taslak olarak yüklenecek'}.\nHer biri birkaç dakika sürer; "Durdur" ile arada durdurabilirsin. Başlansın mı?`)) return;
  state.bulk = false; state.sel.clear(); bulkBar();
  showTab('dashboard');
  const r = await safe(() => api.call('publishMany', { ids }), 'Toplu yükleme başarısız: ');
  if (r) toast(`Toplu yükleme bitti: ${r.ok} başarılı${r.fail ? `, ${r.fail} başarısız` : ''}`);
  refreshAll();
});

/* ücretsiz toplu üretim */
$('btnBatch').addEventListener('click', async () => {
  if (state.busy) return toast('Şu an başka bir işlem çalışıyor');
  const mode = $('batchMode').value; const count = Number($('batchCount').value);
  const label = $('batchMode').selectedOptions[0].textContent;
  if (!confirm(`${label}: ${count} ürün art arda ücretsiz Gemini ile üretilecek (yaklaşık ${count * 5} dk).\nEtsy'ye otomatik yüklenmez. Google penceresi açılırsa kapatma. Başlansın mı?`)) return;
  showTab('dashboard');
  const r = await safe(() => api.call('autoGeminiBatch', { mode, count }), 'Toplu üretim başarısız: ');
  if (r) toast(`Toplu üretim bitti: ${r.made.length} ürün hazır${r.failed ? `, ${r.failed} başarısız` : ''}`, 7000);
  refreshAll();
});
