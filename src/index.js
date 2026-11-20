'use strict';
/**
 * MODÜL 6 — Ana Orkestratör
 * CLI:
 *   node src/index.js --count=5        → 5 ürün üret + Etsy'ye yükle (günlük limit kontrollü)
 *   node src/index.js --dry-run        → 1 tam paket üret, Etsy'ye yükleme yok, API ücreti yok
 *   node src/index.js --count=3 --no-publish
 *   node src/index.js --publish-id=<urun_id>
 * Panel (Electron) bu dosyayı "--ipc" ile ayrı bir Node süreci olarak başlatır; loglar/ilerleme IPC ile akar.
 */
const fs = require('fs');
const path = require('path');
const core = require('./lib/core');
const { loadConfig, loadEnv, log, logError, progress, retry, control, checkStop, StopError, newProductId, PATHS, bus } = core;
const db = require('./lib/db');
const { findTrend } = require('./01_trend_scout');
const { generateAssets } = require('./02_asset_generator');
const { createMockups } = require('./03_mockup_engine');
const { generateSeo } = require('./04_seo_engine');

const STEPS = ['Trend', 'Tasarım', 'SEO', 'Mockup & Video', 'Kalite kontrol', 'Etsy'];

async function produceOne(index, total, { dryRun, publish, exclude }) {
  const step = (k, msg) => {
    const pct = Math.round((((index - 1) + (k + 1) / STEPS.length) / total) * 100);
    progress({ current: index, total, step: STEPS[k], pct, msg });
  };
  let product = null;
  try {
    step(0, 'Trend aranıyor');
    const trend = await retry(() => findTrend({ dryRun, exclude }), { label: 'Trend tarama' });
    exclude.add(trend.keyword);
    const id = newProductId(trend.keyword) + (dryRun ? '-dry' : '');
    const dir = path.join(PATHS.output, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trend.json'), JSON.stringify(trend, null, 2));
    product = { id, folder: dir, niche: trend.niche, keyword: trend.keyword, status: 'Üretiliyor', dry_run: dryRun, cost: 0 };
    db.saveProduct(product);
    if (!dryRun) db.markKeywordUsed(trend.keyword, trend.niche, id);

    checkStop();
    step(1, 'Tasarımlar üretiliyor');
    const assets = await generateAssets(trend, { productId: id, dir, dryRun });
    product.cost += assets.cost;

    checkStop();
    step(2, 'SEO yazılıyor');
    const seo = generateSeo(trend, { dir, n: assets.pngs.length, delivery: assets.delivery });
    product.title = seo.title;
    product.tags = seo.tags;

    checkStop();
    step(3, 'Mockup ve video');
    const mockCosts = [];
    const mock = await retry(() => createMockups({ pngs: assets.pngs, trend, dir, title: seo.title, costs: mockCosts, dryRun }), { label: 'Mockup/video üretimi' });
    product.cost += mockCosts.reduce((a, b) => a + b, 0);
    product.thumbnail = mock.thumbnail;

    step(4, 'Kalite kontrol');
    const { runFinalQC } = require('./06_quality_check');
    const qcCosts = [];
    const qc = await runFinalQC({ dir, meta: seo, trend, designReport: assets.designReport, dryRun, costs: qcCosts });
    product.cost += qcCosts.reduce((a, b) => a + b, 0);
    product.status = qc.pass ? 'Hazır' : 'İnceleme';
    product.error = qc.pass ? null : `QC: ${qc.issues.slice(0, 3).join(' | ')}`.slice(0, 500);
    db.saveProduct(product);
    log(`Ürün hazır: ${id} (maliyet $${product.cost.toFixed(3)})`, 'success');

    if (!dryRun && publish && !qc.pass && loadConfig().qc_block_on_fail !== false) {
      log('Kalite kontrolden geçmediği için Etsy\'ye yüklenmedi. Panelde ürünü inceleyip "Onayla ve Yükle" diyebilirsiniz.', 'warn');
    } else if (!dryRun && publish && loadConfig().require_approval !== false) {
      step(5, 'Onayınız bekleniyor');
      log('Onaylı mod: ürün Etsy\'ye yüklenmedi. Ürünler sekmesinden inceleyip "Etsy\'ye yükle" diyebilirsiniz.');
    } else if (!dryRun && publish) {
      checkStop();
      step(5, 'Etsy\'ye yükleniyor');
      const { publishProduct } = require('./05_etsy_publisher');
      const res = await retry(() => publishProduct(product), { label: 'Etsy yükleme', baseDelay: 5000 });
      product.status = res.status;
      product.listing_id = res.listing_id;
      product.listing_url = res.listing_url;
      product.cost += res.fee || 0;
      db.saveProduct(product);
    } else {
      step(5, dryRun ? 'Dry-run: Etsy yüklemesi atlandı' : 'Yükleme kapalı');
      log(dryRun ? 'Dry-run: Etsy\'ye yükleme yapılmadı' : 'Yükleme atlandı (--no-publish)');
    }
    return product;
  } catch (err) {
    if (err instanceof StopError) {
      if (product) db.updateProduct(product.id, { status: 'Hata', error: 'Durduruldu' });
      throw err;
    }
    logError(`Ürün ${index}/${total} başarısız`, err);
    if (product) {
      // Üretim tamamlandıysa ama yükleme başarısızsa ürün "Hazır" kalır, panelden tekrar yüklenebilir
      const ready = product.thumbnail && fs.existsSync(path.join(product.folder, 'seo_metadata.json'));
      product.status = ready ? 'Hazır' : 'Hata';
      product.error = String(err.message || err).slice(0, 500);
      db.saveProduct(product);
    }
    if (err.fatal) throw err; // ör. Replicate kredisi bitti → kalan ürünleri boşuna deneme
    return null;
  }
}

const LOCK = path.join(PATHS.data, 'run.lock');
function acquireLock(label) {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { process.kill(cur.pid, 0); alive = true; } catch { alive = false; }
    const stale = Date.now() - (cur.at || 0) > 3 * 3600 * 1000;
    if (alive && !stale && cur.pid !== process.pid) return cur;
  } catch { /* kilit yok */ }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), label }));
  return null;
}
function releaseLock() {
  try { const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(LOCK); } catch { /* yok say */ }
}

async function runPipeline({ count, dryRun = false, publish = true, source = 'manual' } = {}) {
  loadEnv();
  control.stopRequested = false;
  const busy = acquireLock(source);
  if (busy) {
    log(`Başka bir üretim zaten çalışıyor (${busy.label || 'bilinmiyor'}, pid ${busy.pid}). Bu çalıştırma atlandı.`, 'warn');
    return { produced: 0, failed: 0, products: [], skipped: true };
  }
  try {
    return await runPipelineInner({ count, dryRun, publish, source });
  } finally { releaseLock(); }
}

async function runPipelineInner({ count, dryRun = false, publish = true, source = 'manual' } = {}) {
  const cfg = loadConfig();
  let n = Math.max(1, Number(count || (dryRun ? 1 : cfg.default_count)));
  if (!dryRun) {
    const done = db.countToday();
    const remaining = Math.max(0, cfg.daily_limit - done);
    if (remaining === 0) {
      log(`Günlük limit doldu (${cfg.daily_limit}/${cfg.daily_limit}). Yarın tekrar deneyin veya Ayarlar'dan limiti artırın.`, 'warn');
      return { produced: 0, failed: 0, products: [] };
    }
    if (n > remaining) { log(`Günlük limit nedeniyle ${n} yerine ${remaining} ürün üretilecek`, 'warn'); n = remaining; }
  }
  // Zamanlanmış üretim: ücretli Replicate yerine ücretsiz Gemini (karışık mod) + vitrin otomatik oluşturulur.
  // Ürünler "Hazır" kalır; Etsy'ye yükleme kullanıcı kontrolünden sonra yapılır.
  if (!dryRun && source !== 'manual' && cfg.schedule_engine !== 'replicate') {
    try { await runPendingFromCli(); } catch (e) { logError('Bekleyen istekler', e); }
    log(`⏰ Zamanlanmış üretim başladı (ücretsiz Gemini, karışık): ${n} ürün`, 'success');
    const products = []; let failed = 0;
    for (let i = 1; i <= n; i++) {
      try {
        checkStop();
        log(`──── Ürün ${i}/${n} ────`);
        const r = await autoGeminiProduct({ mode: 'mix' });
        if (r && r.id) {
          try { await rebuildMedia(r.id); } catch (e) { logError(`Vitrin oluşturma ${r.id}`, e); }
          const p = db.getProduct(r.id); if (p) products.push(p);
        } else failed++;
      } catch (e) {
        if (e instanceof StopError) { log('İşlem güvenli şekilde durduruldu', 'warn'); break; }
        failed++; logError(`Zamanlanmış ürün ${i}`, e);
      }
    }
    progress({ current: n, total: n, step: 'Bitti', pct: 100 });
    log(`Tamamlandı: ${products.length} başarılı, ${failed} başarısız`, products.length ? 'success' : 'warn');
    bus.emit('done', { produced: products.length, failed, review: 0, source, dryRun, uploaded: 0 });
    return { produced: products.length, failed, review: 0, products };
  }
  if (!fs.existsSync(path.join(PATHS.mockups, 'mockups.json'))) {
    log('Mockup şablonları yok, oluşturuluyor (ilk kurulum, birkaç dakika sürebilir)...');
    await require('./setup_mockups').setupMockups();
  }
  log(`${dryRun ? '🧪 Dry-run' : source === 'manual' ? '🚀 Otonom üretim' : '⏰ Zamanlanmış üretim'} başladı: ${n} ürün`, 'success');
  const products = [];
  let failed = 0;
  const exclude = new Set();
  try {
    for (let i = 1; i <= n; i++) {
      checkStop();
      log(`──── Ürün ${i}/${n} ────`);
      const p = await produceOne(i, n, { dryRun, publish, exclude });
      if (p) products.push(p); else failed++;
    }
  } catch (err) {
    if (err instanceof StopError) log('İşlem güvenli şekilde durduruldu', 'warn');
    else if (err.fatal) { failed++; log(`Üretim durduruldu: ${err.message}`, 'error'); }
    else logError('Pipeline', err);
  }
  progress({ current: n, total: n, step: 'Bitti', pct: 100 });
  const review = products.filter((p) => p.status === 'İnceleme').length;
  log(`Tamamlandı: ${products.length} başarılı${review ? ` (${review} tanesi incelemede)` : ''}, ${failed} başarısız`, products.length ? 'success' : 'warn');
  bus.emit('done', { produced: products.length, failed, review, source, dryRun, uploaded: products.filter((p) => ['Taslak', 'Yayında'].includes(p.status)).length });
  return { produced: products.length, failed, review, products };
}

async function publishExisting(id) {
  loadEnv();
  control.stopRequested = false;
  const busy = acquireLock('publish');
  if (busy) throw new Error(`Başka bir işlem çalışıyor (${busy.label})`);
  try { return await publishExistingInner(id); } finally { releaseLock(); }
}

async function publishExistingInner(id) {
  const p = db.getProduct(id);
  if (!p) throw new Error(`Ürün bulunamadı: ${id}`);
  if (p.dry_run) log('Not: bu bir dry-run ürünü; yine de Etsy\'ye yükleniyor', 'warn');
  if (fs.existsSync(path.join(p.folder, '.media_stale'))) throw Object.assign(new Error('Vitrin görselleri tasarımların son hâliyle hazırlanmadı — önce ürün sayfasında "Vitrini oluştur"a basın'), { noRetry: true });
  // Yüklemeden hemen önce Etsy'ye gidecek yazıları son kez denetle; sorun varsa güncel kurallarla yeniden yaz
  try {
    const seoPath = path.join(p.folder, 'seo_metadata.json');
    const trend = JSON.parse(fs.readFileSync(path.join(p.folder, 'trend.json'), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(seoPath, 'utf8'));
    const { validateSeo } = require('./04_seo_engine');
    if (!trend.mega && !trend.seo_locked && validateSeo(meta, trend).length) {
      const n = fs.readdirSync(path.join(p.folder, 'designs')).filter((f) => /\.png$/i.test(f)).length;
      const parts = fs.readdirSync(p.folder).filter((f) => /^deliverable_part\d+\.zip$/.test(f));
      const fresh = generateSeo(trend, { dir: p.folder, n, delivery: parts.length ? { mode: 'split', files: parts } : (meta.delivery || { mode: 'zip', files: ['deliverable.zip'] }) });
      if (fresh.validation.problems.length) throw Object.assign(new Error(`Başlık/etiketlerde düzeltilemeyen sorun: ${fresh.validation.problems.join('; ')}`), { noRetry: true });
      db.updateProduct(id, { title: fresh.title, tags: fresh.tags });
      log('Yükleme öncesi: başlık ve etiketler yeni kurallarla düzeltildi', 'warn');
    }
  } catch (e) { if (e.noRetry) throw e; }
  const { publishProduct } = require('./05_etsy_publisher');
  const res = await retry(() => publishProduct(p), { label: 'Etsy yükleme', baseDelay: 5000 });
  db.updateProduct(id, { status: res.status, listing_id: res.listing_id, listing_url: res.listing_url, cost: Number(p.cost || 0) + (res.fee || 0), error: null });
  return res;
}

/* ---------------- Ürün detayı ve yeniden denetim ---------------- */
function listImages(dir, sub) {
  const d = path.join(dir, sub);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => path.join(d, f)) : [];
}
function productDetail(id) {
  const p = db.getProduct(id);
  if (!p) throw new Error('Ürün bulunamadı');
  const dir = p.folder;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  return {
    product: p,
    seo: read('seo_metadata.json'),
    trend: read('trend.json'),
    qc: read('qc_report.json'),
    mockups: listImages(dir, 'mockups'),
    designs: listImages(dir, 'designs'),
    stale: fs.existsSync(path.join(dir, '.media_stale')),
    edited: fs.existsSync(path.join(dir, 'designs_backup')) ? fs.readdirSync(path.join(dir, 'designs_backup')).filter((f) => /\.png$/i.test(f)) : [],
    rejected: listImages(dir, 'rejected'),
    video: fs.existsSync(path.join(dir, 'listing_video.mp4')) ? path.join(dir, 'listing_video.mp4') : null,
  };
}
async function recheckProduct(id) {
  const d = productDetail(id);
  if (!d.seo || !d.trend) throw new Error('Ürün dosyaları eksik');
  const { checkDesigns, runFinalQC } = require('./06_quality_check');
  const costs = [];
  const dq = await checkDesigns(d.designs, d.trend, { costs });
  const qc = await runFinalQC({ dir: d.product.folder, meta: d.seo, trend: d.trend, designReport: dq.report, costs });
  if (['Hazır', 'İnceleme', 'Hata'].includes(d.product.status)) {
    db.updateProduct(id, { status: qc.pass ? 'Hazır' : 'İnceleme', error: qc.pass ? null : `QC: ${qc.issues.slice(0, 3).join(' | ')}`.slice(0, 500), cost: Number(d.product.cost || 0) + costs.reduce((a, b) => a + b, 0) });
  }
  return qc;
}

/** Hatalı tasarımları güncel kurallarla yeniden üretir; SEO, mockup, video ve kalite kontrolünü yeniler. */
async function repairProduct(id, files = null) {
  loadEnv();
  control.stopRequested = false;
  const busyLock = acquireLock('repair');
  if (busyLock) throw new Error(`Başka bir işlem çalışıyor (${busyLock.label})`);
  try {
    const d = productDetail(id);
    if (!d.trend) throw new Error('trend.json eksik, bu ürün onarılamaz');
    if (['Taslak', 'Yayında'].includes(d.product.status)) throw new Error('Etsy\'ye yüklenmiş ürün onarılamaz; Etsy\'deki ilanı silip yeniden üretin');
    const dir = d.product.folder;
    const { checkDesigns, runFinalQC } = require('./06_quality_check');
    const { repairDesigns } = require('./02_asset_generator');
    const costs = [];
    progress({ current: 1, total: 1, step: 'Tasarım', pct: 10, msg: 'Tasarımlar yeniden denetleniyor' });
    log(`Onarım başladı: ${d.product.title || id}`);
    const bad = new Set();
    if (Array.isArray(files) && files.length) {
      for (const f of files) { const i = d.designs.findIndex((p) => path.basename(p) === f); if (i >= 0) bad.add(i); }
      if (!bad.size) throw new Error('Seçilen tasarım bulunamadı');
    } else {
      const dq = await checkDesigns(d.designs, d.trend, { costs });
      for (const i of dq.failed) bad.add(i);
    }
    // Vitrin görseli 1. tasarımdan oluşur: vitrinde "tişört içinde tişört" bulunduysa 1. tasarım da yenilenir
    if (!(Array.isArray(files) && files.length) && d.qc && d.qc.mockup && (d.qc.mockup.garment_inside_design || (d.qc.mockup.text_errors && String(d.qc.mockup.text_errors).trim()))) bad.add(0);
    if (!bad.size) log('Tasarımlarda sorun bulunmadı; yalnızca paket ve kalite kontrol yenileniyor');
    const fixed = await repairDesigns({ trend: d.trend, dir, productId: id, indices: [...bad] });
    progress({ current: 1, total: 1, step: 'SEO', pct: 55, msg: 'SEO yenileniyor' });
    const seo = generateSeo(d.trend, { dir, n: fixed.pngs.length, delivery: fixed.delivery });
    progress({ current: 1, total: 1, step: 'Mockup & Video', pct: 70, msg: 'Mockup ve video yenileniyor' });
    const mdir = path.join(dir, 'mockups');
    if (fs.existsSync(mdir)) for (const f of fs.readdirSync(mdir)) fs.unlinkSync(path.join(mdir, f));
    const mock = await retry(() => createMockups({ pngs: fixed.pngs, trend: d.trend, dir, title: seo.title }), { label: 'Mockup/video üretimi' });
    progress({ current: 1, total: 1, step: 'Kalite kontrol', pct: 90, msg: 'Son kalite kontrol' });
    const dq2 = await checkDesigns(fixed.pngs, d.trend, { costs });
    const qc = await runFinalQC({ dir, meta: seo, trend: d.trend, designReport: dq2.report, costs });
    const cost = Number(d.product.cost || 0) + fixed.cost + costs.reduce((a, b) => a + b, 0);
    db.updateProduct(id, {
      status: qc.pass ? 'Hazır' : 'İnceleme', title: seo.title, tags: seo.tags, thumbnail: mock.thumbnail, cost,
      error: qc.pass ? null : `QC: ${qc.issues.slice(0, 3).join(' | ')}`.slice(0, 500),
    });
    progress({ current: 1, total: 1, step: 'Bitti', pct: 100 });
    log(qc.pass ? `Onarım tamam ✓ Ürün kalite kontrolden geçti, Etsy'ye yüklenmeye hazır (ek maliyet $${(cost - Number(d.product.cost || 0)).toFixed(3)})`
      : `Onarım sonrası hâlâ ${qc.issues.length} sorun var — ürün incelemede kaldı`, qc.pass ? 'success' : 'warn');
    return { pass: qc.pass, issues: qc.issues };
  } finally { releaseLock(); }
}

/**
 * ÜCRETSİZ onarım: hatalı tasarımları (kayıtlı kalite raporuna göre) paketten çıkarır; paket, SEO, mockup ve video
 * yerel olarak yeniden oluşturulur. Hiçbir ücretli API çağrılmaz.
 */
/** Kullanıcının kendi (ör. Gemini ile) ürettiği görsellerden ürün oluşturur. Tasarım çizimine para harcanmaz. */
/** Gemini'yi tarayıcıdan otomatik kullanarak ürün yapar: konu → 4 talimat → Gemini görselleri → ürün (vitrin kullanıcı kontrolünden sonra). */
async function autoGeminiProduct({ mode = 'illustration', keyword = null, n = 4 } = {}) {
  const dv = require('./lib/design_variety');
  if (mode === 'mix') {
    // Karışık: bir yazılı, bir resimli sırayla (dükkânda çeşitlilik)
    const f = path.join(PATHS.data, 'auto_mode.json');
    // Sıra: yazılı → günlük → vintage Noel → günlük → resimli (günlük konular daha sık, Noel'e boğulmasın)
    const CYCLE = ['text', 'everyday', 'vintage', 'everyday', 'illustration'];
    let i0 = -1; try { i0 = Number(JSON.parse(fs.readFileSync(f, 'utf8')).i); } catch { /* ilk sefer */ }
    const i1 = Number.isFinite(i0) ? (i0 + 1) % CYCLE.length : 0;
    mode = CYCLE[i1];
    try { fs.writeFileSync(f, JSON.stringify({ i: i1, last: mode })); } catch { /* yok say */ }
    log(`Karışık mod: bu sefer ${{ text: 'yazılı', everyday: 'günlük (her mevsim)', vintage: 'vintage Noel', illustration: 'resimli Noel' }[mode]} ürün`);
  }
  let kw = keyword, suggested = null;
  if (!kw) {
    // Çeşitlilik: son ürünlerle aynı kitle/konu kelimelerini (kids, pajamas, family…) taşıyan konuları atla
    const recent = db.listProducts(15).map((p) => String(p.niche || p.keyword || '').toLowerCase());
    const GENERIC = new Set(['christmas', 'xmas', 'thanksgiving', 'png', 'retro', 'vintage', 'funny', 'minimalist', 'cute', 'holiday', 'shirt', 'shirts', 'sublimation', 'design', 'designs', 'boho', 'groovy']);
    const core = (t) => String(t).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
    const tooClose = (t) => recent.some((r) => { const a = new Set(core(r)); const b = core(t); return b.length && b.filter((w) => a.has(w)).length >= Math.min(2, b.length); });
    if (mode === 'everyday') {
      for (let i = 0; i < 4 && !kw; i++) { const t = dv.everydayTopic(); if (!recent.some((r) => r.includes(t)) || i === 3) kw = t; }
    } else if (mode === 'vintage') {
      for (let i = 0; i < 4 && !kw; i++) { const t = dv.vintageTopic(); if (!recent.some((r) => r.includes(t)) || i === 3) kw = t; }
    } else if (mode === 'illustration') {
      const seen = recent.slice();
      for (let i = 0; i < 8 && !kw; i++) { const t = dv.illustrationTopic(seen); seen.push(t); if (!tooClose(t) || i === 7) kw = t; }
    } else {
      const exclude = new Set(recent);
      for (let i = 0; i < 5 && !kw; i++) {
        const t = await findTrend({ fast: true, exclude });
        exclude.add(t.keyword); exclude.add(t.niche);
        if (!tooClose(t.niche) || i === 4) { suggested = t; kw = t.niche; }
        else log(`Konu atlandı (son ürünlere çok benziyor): ${t.niche}`);
      }
    }
  }
  const vintage = mode === 'vintage', everyday = mode === 'everyday';
  const ps = everyday ? dv.everydayPrompts(kw, n) : vintage ? dv.vintagePrompts(kw, n) : mode === 'illustration' ? dv.illustrationPrompts(kw, n) : dv.geminiPrompts(kw, n);
  log(`🤖 Otomatik Gemini üretimi: "${kw}" (${ps.length} görsel, ${everyday ? 'günlük (her mevsim)' : vintage ? 'vintage Noel' : mode === 'illustration' ? 'resimli' : 'yazılı'})`, 'success');
  if (vintage || everyday) mode = 'illustration'; // aynı pembe zemin + şeffaf kesim + resimli SEO hattı
  progress({ current: 1, total: 1, step: 'Tasarım', pct: 5, msg: 'Gemini açılıyor' });
  const outDir = path.join(PATHS.data, 'imports', `gemini_${Date.now()}`);
  const { generateImages } = require('./lib/gemini_browser');
  const got = await generateImages(ps.map((p) => p[1]), { outDir, mode });
  if (got.length < 2) throw Object.assign(new Error(`Gemini'den yeterli görsel alınamadı (${got.length}/${ps.length})`), { noRetry: true });
  const designs = got.map((g) => ps[g.index][2]).filter(Boolean);
  return importProduct({ files: got.map((g) => g.file), keyword: kw, trend: suggested, mode, designs: mode === 'illustration' ? got.map((g) => ps[g.index][2]) : null, gen: everyday ? 'everyday' : vintage ? 'vintage' : null });
}

async function importProduct({ files, keyword, style, trend: suggested, mode = 'text', designs = null, gen = null }) {
  loadEnv();
  control.stopRequested = false;
  const busyLock = acquireLock('import');
  if (busyLock) throw new Error(`Başka bir işlem çalışıyor (${busyLock.label})`);
  const P = (pct, stepName, msg) => progress({ current: 1, total: 1, step: stepName, pct, msg });
  let product = null;
  try {
    const list = (files || []).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && fs.existsSync(f));
    if (!list.length) throw new Error('Görsel seçilmedi (PNG/JPG)');
    const kw0 = String(keyword || '').toLowerCase().replace(/[^a-z0-9' &-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (kw0.length < 3) throw new Error('Konu adı yazın (İngilizce, ör. "teacher christmas")');
    const { EVENTS, upcomingEvents, describeNiche } = require('./01_trend_scout');
    const evs = upcomingEvents(new Date(), 400, 0);
    const ev = evs.find((e) => kw0.includes(e.name.toLowerCase().split(/[ ']/)[0]))
      || evs.find((e) => e.seeds.some((sd) => kw0.includes(sd))) || null;
    const g = ev ? EVENTS.find((e) => e.name === ev.name) : null;
    const keyword1 = /\b(png|sublimation)\b/.test(kw0) ? kw0 : `${kw0} png`;
    const trend = {
      ...describeNiche(keyword1, ev, style || (g ? g.styles[0] : 'retro'), g ? g.audience : null),
      score: null, sources: ['manual'], competition: null, related_keywords: [], picked_at: new Date().toISOString(), imported: true,
    };
    if (style) trend.style = style;
    // Panelin önerdiği trend kullanıldıysa (aynı konu) onun ilgili kelimelerini/sezonunu koru
    if (suggested && suggested.niche && suggested.niche.toLowerCase() === kw0) Object.assign(trend, { ...suggested, sources: ['suggest+manual'], imported: true, picked_at: trend.picked_at });
    // Görsellerin stili bilinmiyor: başlığa yanlış stil sıfatı (funny, boho…) taşıyabilecek ilgili aramaları çıkar
    trend.related_keywords = (trend.related_keywords || []).filter((k) => !/\b(funny|sarcastic|humor|boho|western|coquette|watercolor|kawaii|ugly)\b/.test(k) || kw0.match(/\b(funny|sarcastic|humor|boho|western|coquette|watercolor|kawaii|ugly)\b/));
    if (mode === 'illustration') {
      trend.mode = 'illustration'; if (!style) trend.style = 'vintage';
      // Gemini'ye verilen talimatlardaki konular (tilki, geyik…) başlık/etiket/açıklamaya girer
      const ds = (Array.isArray(designs) ? designs : []).filter((d) => d && d.subject).slice(0, list.length);
      if (ds.length) { trend.subjects = [...new Set(ds.map((d) => String(d.subject).toLowerCase()))]; trend.design_notes = ds.map((d) => String(d.note || '')).filter(Boolean); }
    }
    if (gen) trend.gen = gen;
    if (Array.isArray(designs) && designs.some((d) => d && /^retro/.test(d.effect || ''))) trend.retro_effect = true;
    const id = newProductId(trend.keyword);
    const dir = path.join(PATHS.output, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trend.json'), JSON.stringify(trend, null, 2));
    product = { id, folder: dir, niche: trend.niche, keyword: trend.keyword, status: 'Üretiliyor', dry_run: false, cost: 0 };
    db.saveProduct(product);
    db.markKeywordUsed(trend.keyword, trend.niche, id);
    log(`📥 Kendi tasarımlarından ürün: "${trend.keyword}" (${list.length} görsel, sezon: ${trend.season})`, 'success');
    P(10, 'Tasarım', 'Görseller hazırlanıyor');
    const { importAssets } = require('./02_asset_generator');
    const effects = Array.isArray(designs) ? designs.slice(0, list.length).map((d) => (d && d.effect) || null) : null;
    const assets = await importAssets(trend, { productId: id, dir, files: list, mode, effects });
    product.cost += assets.cost;
    P(45, 'SEO', 'SEO yazılıyor');
    const seo = generateSeo(trend, { dir, n: assets.pngs.length, delivery: assets.delivery });
    product.title = seo.title; product.tags = seo.tags;
    if (loadConfig().import_review_first !== false) {
      // Önce kullanıcı tasarımları kontrol etsin (gerekirse 🧽 Beyaz sil), vitrin sonra "Vitrini oluştur" ile yapılır
      const qcPath = path.join(dir, 'qc_report.json');
      fs.writeFileSync(qcPath, JSON.stringify({ pass: false, issues: ['Vitrin görselleri henüz oluşturulmadı'], warnings: [], designs: assets.designReport || [], checked_at: new Date().toISOString() }, null, 2));
      fs.writeFileSync(path.join(dir, '.media_stale'), 'new');
      product.thumbnail = assets.pngs[0];
      product.status = 'İnceleme';
      product.error = 'Tasarımları kontrol edip "Vitrini oluştur"a basın';
      db.saveProduct(product);
      P(100, 'Bitti');
      log('Tasarımlar hazır ✓ Şimdi kontrol et: beyaz kalan yer varsa "🧽 Beyaz sil", sonra "Vitrini oluştur"', 'success');
      return { id, review: true, pass: false, issues: [], cost: product.cost };
    }
    P(60, 'Mockup & Video', 'Kapak, mockup ve video');
    const mockCosts = [];
    const mock = await retry(() => createMockups({ pngs: assets.pngs, trend, dir, title: seo.title, costs: mockCosts }), { label: 'Mockup/video üretimi' });
    product.cost += mockCosts.reduce((a, b) => a + b, 0);
    product.thumbnail = mock.thumbnail;
    P(85, 'Kalite kontrol', 'Son kontrol');
    const { runFinalQC } = require('./06_quality_check');
    const qcCosts = [];
    const qc = await runFinalQC({ dir, meta: seo, trend, designReport: assets.designReport, costs: qcCosts });
    product.cost += qcCosts.reduce((a, b) => a + b, 0);
    product.status = qc.pass ? 'Hazır' : 'İnceleme';
    product.error = qc.pass ? null : `QC: ${qc.issues.slice(0, 3).join(' | ')}`.slice(0, 500);
    db.saveProduct(product);
    P(100, 'Bitti');
    log(`Ürün hazır: ${id} (maliyet $${product.cost.toFixed(3)}) — Ürünler sekmesinden kontrol edip "Etsy'ye yükle" deyin`, 'success');
    return { id, pass: qc.pass, issues: qc.issues, cost: product.cost };
  } catch (err) {
    if (product) { product.status = 'Hata'; product.error = String(err.message || err).slice(0, 500); db.saveProduct(product); }
    throw err;
  } finally { releaseLock(); }
}

/** Tasarım dosyaları değişince paket, SEO, mockup/video ve (ücretsiz) kalite kontrolünü yeniler. */
async function rebuildFromDesigns(id, d, pngs) {
  const dir = d.product.folder;
  const qc = d.qc;
  progress({ current: 1, total: 1, step: 'Tasarım', pct: 30, msg: 'Paket yeniden oluşturuluyor' });
  const cfg = loadConfig();
  for (const f of fs.readdirSync(dir)) if (/^(deliverable(_part\d+)?\.zip|Download_Instructions\.pdf)$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const { packageDeliverables } = require('./02_asset_generator');
  const title0 = `${d.trend.keyword} - ${pngs.length > 1 ? `${pngs.length} Design Bundle` : 'Design'}`;
  const delivery = await packageDeliverables(dir, pngs, title0, cfg, id);
  progress({ current: 1, total: 1, step: 'SEO', pct: 50, msg: 'SEO yenileniyor' });
  const seo = generateSeo(d.trend, { dir, n: pngs.length, delivery });
  progress({ current: 1, total: 1, step: 'Mockup & Video', pct: 70, msg: 'Mockup ve video yenileniyor' });
  const mdir = path.join(dir, 'mockups');
  if (fs.existsSync(mdir)) for (const f of fs.readdirSync(mdir)) fs.unlinkSync(path.join(mdir, f));
  const mock = await retry(() => createMockups({ pngs, trend: d.trend, dir, title: seo.title }), { label: 'Mockup/video üretimi' });
  const keep = ((qc && qc.designs) || []).filter((r) => pngs.some((p) => path.basename(p) === r.file));
  const { runFinalQC } = require('./06_quality_check');
  process.env.QC_SKIP_VISION = '1';
  let fq;
  try { fq = await runFinalQC({ dir, meta: seo, trend: d.trend, designReport: keep }); } finally { delete process.env.QC_SKIP_VISION; }
  db.updateProduct(id, {
    status: fq.pass ? 'Hazır' : 'İnceleme', title: seo.title, tags: seo.tags, thumbnail: mock.thumbnail,
    error: fq.pass ? null : `QC: ${fq.issues.slice(0, 3).join(' | ')}`.slice(0, 500),
  });
  progress({ current: 1, total: 1, step: 'Bitti', pct: 100 });
  return fq;
}

/** Tasarımda tıklanan noktadaki beyaz alanı (ve ona bitişik beyazı) şeffaf yapar. fx, fy: 0..1 */
async function eraseWhiteAt(id, file, fx, fy, points = null) {
  const d = productDetail(id);
  if (['Taslak', 'Yayında'].includes(d.product.status)) throw new Error('Etsy\'ye yüklenmiş ürün düzenlenemez');
  const src = d.designs.find((p) => path.basename(p) === file);
  if (!src) throw new Error('Tasarım bulunamadı');
  const sharp = require('sharp');
  const bdir = path.join(d.product.folder, 'designs_backup');
  fs.mkdirSync(bdir, { recursive: true });
  const bak = path.join(bdir, file);
  if (!fs.existsSync(bak)) fs.copyFileSync(src, bak);
  // Adım adım geri alma için her silmeden önceki hâli sakla (en fazla 15 adım)
  const hdir = path.join(bdir, 'history', file);
  fs.mkdirSync(hdir, { recursive: true });
  const prevStep = path.join(hdir, `${Date.now()}.png`);
  fs.copyFileSync(src, prevStep);
  const steps = fs.readdirSync(hdir).filter((f) => /\.png$/.test(f)).sort();
  for (const f of steps.slice(0, Math.max(0, steps.length - 15))) fs.unlinkSync(path.join(hdir, f));
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = w * h;
  const isW = (i) => data[i * 4 + 3] > 0 && Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= 215;
  const pts = Array.isArray(points) && points.length ? points : [{ fx, fy }];
  let opaque = 0; for (let i = 0; i < N; i++) if (data[i * 4 + 3] > 0) opaque++;
  const seen = new Uint8Array(N); const stack = new Int32Array(N);
  let n = 0, done = 0, missed = 0;
  for (const pt of pts) {
    // Tıklanan noktaya çok yakın beyaz piksel (ekranda ~4-5 px) — uzaktaki beyaz çizimlere atlamasın
    const cx = Math.round(pt.fx * (w - 1)), cy = Math.round(pt.fy * (h - 1));
    let seed = -1;
    for (let r = 0; r <= 3 * Math.ceil(w / 1000) && seed < 0; r++) {
      for (let dy = -r; dy <= r && seed < 0; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (isW(y * w + x)) { seed = y * w + x; break; }
      }
    }
    if (seed < 0) { missed++; continue; }
    let sp = 0;
    seen[seed] = 1; stack[sp++] = seed;
    while (sp) {
      const i = stack[--sp]; n++; data[i * 4 + 3] = 0;
      const x = i % w;
      if (x > 0 && !seen[i - 1] && isW(i - 1)) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && isW(i + 1)) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= w && !seen[i - w] && isW(i - w)) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (i + w < N && !seen[i + w] && isW(i + w)) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    done++;
  }
  const dropStep = () => { try { fs.unlinkSync(prevStep); } catch {} };
  if (!done) { dropStep(); throw new Error(pts.length > 1 ? 'Seçilen noktalarda beyaz alan yok' : 'Tıkladığın yerde beyaz alan yok'); }
  if (n > opaque * 0.3) { dropStep(); throw new Error('Bu beyaz alan tasarımın çok büyük bir kısmı — yanlışlıkla silinmesin diye yapılmadı'); }
  let out = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  const { decontaminateEdges } = require('./02_asset_generator');
  const de = await decontaminateEdges(out); if (de.changed) out = de.buffer;
  const cfg = loadConfig();
  const tmp = `${src}.tmp`;
  await sharp(out).withMetadata({ density: cfg.dpi }).png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toFile(tmp);
  fs.renameSync(tmp, src);
  fs.writeFileSync(path.join(d.product.folder, '.media_stale'), '1');
  log(`Beyaz alan silindi: ${file} — ${done} bölge${missed ? ` (${missed} noktada beyaz yoktu)` : ''} (%${(n / N * 100).toFixed(2)}) — bitince "Vitrini oluştur"a basın`);
  return { erased: n, pct: +(n / N * 100).toFixed(2), done, missed };
}

async function undoErase(id, file, all = false) {
  const d = productDetail(id);
  const src = path.join(d.product.folder, 'designs', file);
  const bdir = path.join(d.product.folder, 'designs_backup');
  const bak = path.join(bdir, file);
  const hdir = path.join(bdir, 'history', file);
  const steps = fs.existsSync(hdir) ? fs.readdirSync(hdir).filter((f) => /\.png$/.test(f)).sort() : [];
  if (!all && steps.length) {
    const last = path.join(hdir, steps[steps.length - 1]);
    fs.copyFileSync(last, src); fs.unlinkSync(last);
    if (steps.length === 1 && fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.writeFileSync(path.join(d.product.folder, '.media_stale'), '1');
    log(`${file}: son silme geri alındı`);
    return { left: steps.length - 1 };
  }
  if (!fs.existsSync(bak)) throw new Error('Geri alınacak değişiklik yok');
  fs.copyFileSync(bak, src);
  fs.unlinkSync(bak);
  for (const f of steps) { try { fs.unlinkSync(path.join(hdir, f)); } catch {} }
  fs.writeFileSync(path.join(d.product.folder, '.media_stale'), '1');
  log(`${file}: ilk hâline döndürüldü`);
  return { left: 0 };
}

/** Tek bir tasarımı Gemini ile (ücretsiz) yeniden çizdirir; eskisi rejected/ klasörüne taşınır, vitrin sonra yenilenir. */
async function regenWithGemini(id, file) {
  const d = productDetail(id);
  if (['Taslak', 'Yayında'].includes(d.product.status)) throw new Error('Etsy\'ye yüklenmiş ürün düzenlenemez');
  if (!d.trend) throw new Error('trend.json eksik');
  const target = d.designs.find((p) => path.basename(p) === file);
  if (!target) throw new Error('Tasarım bulunamadı');
  const mode = d.trend.mode === 'illustration' ? 'illustration' : 'text';
  const dv = require('./lib/design_variety');
  const kw = d.trend.niche || d.trend.keyword;
  const ps = d.trend.gen === 'everyday' ? dv.everydayPrompts(kw, 1) : d.trend.gen === 'vintage' ? dv.vintagePrompts(kw, 1) : mode === 'illustration' ? dv.illustrationPrompts(kw, 1) : dv.geminiPrompts(kw, 1);
  log(`🤖 ${file} Gemini ile yeniden çiziliyor (${ps[0][0]})`);
  const tmp = path.join(d.product.folder, `_regen_${Date.now()}`);
  const { generateImages } = require('./lib/gemini_browser');
  const got = await generateImages([ps[0][1]], { outDir: path.join(tmp, 'gemini'), mode });
  if (!got.length) throw Object.assign(new Error('Gemini görsel vermedi, tekrar deneyin'), { noRetry: true });
  const { importAssets } = require('./02_asset_generator');
  const res = await importAssets({ ...d.trend }, { productId: id, dir: tmp, files: [got[0].file], mode, effects: d.trend.retro_effect ? ['retro'] : null });
  const fresh = res.pngs[0];
  // eskisini sakla, yenisini aynı adla koy
  const rejDir = path.join(d.product.folder, 'rejected');
  fs.mkdirSync(rejDir, { recursive: true });
  fs.renameSync(target, path.join(rejDir, `${Date.now()}_${file}`));
  fs.copyFileSync(fresh, target);
  const rawDir = path.join(d.product.folder, 'designs_raw');
  const rawNew = path.join(tmp, 'designs_raw', path.basename(fresh));
  if (fs.existsSync(rawNew)) { fs.mkdirSync(rawDir, { recursive: true }); fs.copyFileSync(rawNew, path.join(rawDir, file)); }
  // resimli üründe konu/açıklama satırını güncelle
  if (mode === 'illustration' && ps[0][2]) {
    const tr = { ...d.trend };
    const idx = d.designs.findIndex((p) => path.basename(p) === file);
    tr.design_notes = Array.isArray(tr.design_notes) ? [...tr.design_notes] : [];
    if (idx >= 0) tr.design_notes[idx] = ps[0][2].note;
    tr.subjects = [...new Set([...(tr.subjects || []), ps[0][2].subject])];
    fs.writeFileSync(path.join(d.product.folder, 'trend.json'), JSON.stringify(tr, null, 2));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* yok say */ }
  fs.writeFileSync(path.join(d.product.folder, '.media_stale'), '1');
  log(`${file} yenilendi ✓ Kontrol edip "Vitrini oluştur"a basın`, 'success');
  return { file };
}


/** Modelli kapak: boş tişörtlü model fotoğraflarını üret (Gemini), istenirse örnek kapaklar çıkar (output/_model_preview) */
async function modelMockupJob({ generate = true, force = false, preview = [], set = 'tank' } = {}) {
  const mm = require('./lib/model_mockups');
  if (generate) await mm.generateModelBases({ force, set });
  const models = mm.readModelManifest();
  if (!models.length) throw new Error('Modelli mockup fotoğrafı yok');
  const { modelCover } = require('./03_mockup_engine');
  const outDir = path.join(PATHS.output, '_model_preview');
  fs.mkdirSync(outDir, { recursive: true });
  for (const id of preview) {
    try {
      const dir = path.join(PATHS.output, id);
      const trend = JSON.parse(fs.readFileSync(path.join(dir, 'trend.json'), 'utf8'));
      const dd = path.join(dir, 'designs');
      const pngs = fs.readdirSync(dd).filter((x) => /\.png$/i.test(x)).sort().map((x) => path.join(dd, x));
      await modelCover(models, pngs, trend, path.join(outDir, `${id}.jpg`));
      log(`Örnek modelli kapak: _model_preview/${id}.jpg`, 'success');
    } catch (e) { log(`Örnek kapak yapılamadı (${id}): ${e.message}`, 'warn'); }
  }
  return { models: models.length };
}

/** Pembe zemin artığı onarımı (resimli ürünler): tasarımlar temizlenir, ZIP paketleri yeniden oluşturulur. */
async function fixMagentaJob({ ids = null } = {}) {
  const sharp = require('sharp');
  const { killMagenta, packageDeliverables } = require('./02_asset_generator');
  const cfg = require('./lib/core').loadConfig();
  const all = fs.readdirSync(PATHS.output).filter((d) => /^\d{8}-/.test(d));
  const report = [];
  for (const id of (ids && ids.length ? ids : all)) {
    const dir = path.join(PATHS.output, id);
    let trend = null; try { trend = JSON.parse(fs.readFileSync(path.join(dir, 'trend.json'), 'utf8')); } catch { continue; }
    if (trend.mode !== 'illustration') continue;
    const dd = path.join(dir, 'designs'); if (!fs.existsSync(dd)) continue;
    const pngs = fs.readdirSync(dd).filter((x) => /\.png$/i.test(x)).sort().map((x) => path.join(dd, x));
    let changed = 0;
    for (const p of pngs) {
      const km = await killMagenta(fs.readFileSync(p));
      if (km.removed + km.softened < 50) continue;
      const bak = path.join(dir, 'designs_backup'); fs.mkdirSync(bak, { recursive: true });
      const bk = path.join(bak, `premagenta_${path.basename(p)}`); if (!fs.existsSync(bk)) fs.copyFileSync(p, bk);
      let out = await sharp(km.buffer).withMetadata({ density: cfg.dpi }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      if (out.length > 18.5 * 1048576) out = await sharp(km.buffer).withMetadata({ density: cfg.dpi }).png({ palette: true, quality: 100, colours: 256, dither: 1.0, effort: 10, compressionLevel: 9 }).toBuffer();
      fs.writeFileSync(p, out); changed++;
      log(`${id}/${path.basename(p)}: pembe artık temizlendi (${km.removed}+${km.softened} piksel)`);
    }
    if (changed) {
      const nn = pngs.length;
      await packageDeliverables(dir, pngs, `${require('./lib/core').titleCase(trend.keyword)} - ${nn > 1 ? `${nn} Design Bundle` : 'Design'}`, cfg, id);
      report.push({ id, changed });
    }
  }
  fs.writeFileSync(path.join(PATHS.data, 'fix_report.json'), JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
  log(`Pembe artık onarımı bitti: ${report.length} ürün düzeltildi`, 'success');
  return report;
}

/** Çok satan setlerini üretir (panel: job ile; zamanlanmış CLI: doğrudan). */
async function runBsSets(r, wrap = (_n, fn) => fn()) {
  const { SETS } = require('./lib/bestseller_sets');
  const made = [];
  for (const fx of r.fix || []) if (SETS[fx.set] && SETS[fx.set].seo) applyLockedSeo(fx.id, SETS[fx.set].seo);
  for (const key of r.sets || []) {
    const S = SETS[key]; if (!S) { log(`Bilinmeyen set: ${key}`, 'warn'); continue; }
    try {
      const res = await wrap('gemini', async () => {
        log(`⭐ Çok satan kalıbı seti: ${key} (${S.items.length} görsel)`, 'success');
        const outDir = path.join(PATHS.data, 'imports', `bs_${key}_${Date.now()}`);
        const { generateImages } = require('./lib/gemini_browser');
        const got = await generateImages(S.items.map((p) => p[1]), { outDir, mode: 'illustration' });
        if (got.length < 2) throw new Error(`Gemini'den yeterli görsel alınamadı (${got.length}/${S.items.length})`);
        return importProduct({ files: got.map((g) => g.file), keyword: S.keyword, mode: 'illustration', designs: got.map((g) => S.items[g.index][2]) });
      });
      const id = res && res.id;
      if (!id) continue;
      await wrap('rebuild', () => rebuildMedia(id));
      if (S.seo) applyLockedSeo(id, S.seo);
      made.push({ set: key, id });
      log(`⭐ Set hazır: ${key} → ${id}`, 'success');
    } catch (e) { logError(`Çok satan seti ${key}`, e); }
  }
  let prev = { made: [] }; try { prev = JSON.parse(fs.readFileSync(path.join(PATHS.data, 'bs_done.json'), 'utf8')); } catch { /* yok */ }
  fs.writeFileSync(path.join(PATHS.data, 'bs_done.json'), JSON.stringify({ at: new Date().toISOString(), made, previous: prev.made }, null, 2));
  return made;
}

/** Panel kapalıyken bırakılan istekleri zamanlanmış (Windows görevi) çalıştırmada işler: önce yükleme, sonra çok satan setleri. */
async function runPendingFromCli() {
  const f = path.join(PATHS.data, 'publish_request.txt');
  if (fs.existsSync(f)) {
    const ids = fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean);
    fs.unlinkSync(f);
    log(`Bekleyen yükleme isteği: ${ids.length} ürün (panel kapalıyken bırakılmış)`, 'success');
    for (const id of ids) { try { await publishExistingInner(id); log(`Yüklendi: ${id}`, 'success'); } catch (e) { logError(`Bekleyen yükleme ${id}`, e); } }
  }
  const fbs = path.join(PATHS.data, 'bs_request.json');
  if (fs.existsSync(fbs)) {
    const r = JSON.parse(fs.readFileSync(fbs, 'utf8'));
    fs.unlinkSync(fbs);
    await runBsSets(r);
  }
}

/** Elle yazılmış (araştırmaya dayalı) başlık/etiketi ürüne yazar ve kilitler: yayın öncesi otomatik SEO yeniden yazımı atlanır. */
function applyLockedSeo(id, seo) {
  const dir = path.join(PATHS.output, id);
  try {
    const f = path.join(dir, 'seo_metadata.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    const oldTitle = m.title;
    m.title = seo.title; m.tags = seo.tags;
    if (m.description && oldTitle) m.description = String(m.description).split(oldTitle).join(seo.title);
    fs.writeFileSync(f, JSON.stringify(m, null, 2));
    const tf = path.join(dir, 'trend.json');
    const t = JSON.parse(fs.readFileSync(tf, 'utf8')); t.seo_locked = true; fs.writeFileSync(tf, JSON.stringify(t, null, 2));
    db.updateProduct(id, { title: seo.title, tags: seo.tags });
    log(`Araştırmaya dayalı başlık/etiket yazıldı: ${id}`, 'success');
  } catch (e) { logError(`SEO yazma ${id}`, e); }
}

async function rebuildMedia(id) {
  loadEnv();
  control.stopRequested = false;
  const busyLock = acquireLock('rebuild');
  if (busyLock) throw new Error(`Başka bir işlem çalışıyor (${busyLock.label})`);
  try {
    const d = productDetail(id);
    if (!d.trend) throw new Error('trend.json eksik');
    if (['Taslak', 'Yayında'].includes(d.product.status)) throw new Error('Etsy\'ye yüklenmiş ürün düzenlenemez');
    const fq = await rebuildFromDesigns(id, d, d.designs);
    try { fs.unlinkSync(path.join(d.product.folder, '.media_stale')); } catch {}
    log(fq.pass ? 'Görseller ve paket güncellendi ✓' : `Güncellendi; ${fq.issues.length} sorun var`, fq.pass ? 'success' : 'warn');
    return { pass: fq.pass, issues: fq.issues };
  } finally { releaseLock(); }
}

async function dropBadDesigns(id, files = null) {
  loadEnv();
  control.stopRequested = false;
  const busyLock = acquireLock('drop');
  if (busyLock) throw new Error(`Başka bir işlem çalışıyor (${busyLock.label})`);
  try {
    const d = productDetail(id);
    if (!d.trend) throw new Error('trend.json eksik, bu ürün düzenlenemez');
    if (['Taslak', 'Yayında'].includes(d.product.status)) throw new Error('Etsy\'ye yüklenmiş ürün düzenlenemez; Etsy\'deki ilanı silin');
    const dir = d.product.folder;
    const qc = d.qc;
    if (!qc && !(Array.isArray(files) && files.length)) throw new Error('Kalite raporu yok; önce "Kalite kontrolü çalıştır"');
    const bad = new Set();
    if (Array.isArray(files) && files.length) {
      // Kullanıcının elle seçtiği tasarımlar
      for (const f of files) { const i = d.designs.findIndex((p) => path.basename(p) === f); if (i >= 0) bad.add(i); }
    } else for (const r of qc.designs || []) {
      if ((r.issues && r.issues.length) || (r.warnings && r.warnings.length) || (r.vision && r.vision.pass === false)) {
        const i = d.designs.findIndex((p) => path.basename(p) === r.file);
        if (i >= 0) bad.add(i);
      }
    }
    if (!(Array.isArray(files) && files.length) && qc.mockup && (qc.mockup.garment_inside_design || (qc.mockup.text_errors && String(qc.mockup.text_errors).trim()))) bad.add(0);
    if (!bad.size) throw new Error('Çıkarılacak tasarım bulunamadı');
    if (bad.size >= d.designs.length) throw new Error('Tüm tasarımlar hatalı; ücretsiz çıkarma yapılamaz, "Hatalı tasarımları düzelt" kullanın');
    const rejDir = path.join(dir, 'rejected');
    fs.mkdirSync(rejDir, { recursive: true });
    const removed = [];
    for (const i of [...bad].sort((a, b) => b - a)) {
      fs.renameSync(d.designs[i], path.join(rejDir, `${Date.now()}_${path.basename(d.designs[i])}`));
      removed.push(path.basename(d.designs[i]));
    }
    const pngs = d.designs.filter((_, i) => !bad.has(i));
    log(`Ücretsiz düzeltme: ${removed.join(', ')} paketten çıkarıldı → ${pngs.length}'lü paket`, 'warn');
    const fq = await rebuildFromDesigns(id, d, pngs);
    return { pass: fq.pass, issues: fq.issues, removed, remaining: pngs.length };
  } finally { releaseLock(); }
}

/** Kalıcı tarayıcı profilinde Etsy giriş çerezlerini (yalnızca ad ve süre) kontrol eder. */
function etsySessionInfo() {
  const src = path.join(PATHS.session, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(src)) return { ok: false };
  const tmp = path.join(PATHS.data, '.cookies_check.db');
  try {
    fs.copyFileSync(src, tmp);
    let rows;
    try {
      const Database = require('better-sqlite3');
      const d = new Database(tmp, { readonly: true });
      rows = d.prepare("SELECT name, expires_utc FROM cookies WHERE host_key LIKE '%etsy.com'").all();
      d.close();
    } catch {
      const origEmit = process.emitWarning; process.emitWarning = () => {};
      const { DatabaseSync } = require('node:sqlite');
      process.emitWarning = origEmit;
      const d = new DatabaseSync(tmp, { readOnly: true });
      rows = d.prepare("SELECT name, expires_utc FROM cookies WHERE host_key LIKE '%etsy.com'").all();
      d.close();
    }
    const names = new Set(rows.map((r) => r.name));
    const key = rows.find((r) => r.name === 'session-key-www') || rows.find((r) => r.name === 'session-key-apex');
    const expires = key ? new Date(Number(key.expires_utc) / 1000 - 11644473600000).toISOString() : null;
    const ok = names.has('sign_in_method') && !!key && (!expires || new Date(expires) > new Date());
    return { ok, expires };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { try { fs.unlinkSync(tmp); } catch { /* yok say */ } }
}

/* ---------------- IPC işçi modu (Electron paneli için) ---------------- */
function startIpcWorker() {
  let busy = false;
  let publishLoop = false;
  const send = (m) => { try { process.send(m); } catch { /* panel kapandı */ } };
  bus.on('log', (e) => send({ event: 'log', data: e }));
  bus.on('progress', (p) => send({ event: 'progress', data: p }));
  bus.on('done', (d) => send({ event: 'done', data: d }));

  const job = async (name, fn) => {
    if (busy) throw new Error('Şu anda başka bir işlem çalışıyor');
    busy = true; send({ event: 'busy', data: { busy: true, job: name } });
    try { return await fn(); } finally { busy = false; send({ event: 'busy', data: { busy: false } }); }
  };

  const handlers = {
    stats: () => db.stats(loadConfig().daily_limit),
    products: () => {
      const { readReport } = require('./06_quality_check');
      return db.listProducts(300).map((p) => { const r = p.folder ? readReport(p.folder) : null; return { ...p, qc_pass: r ? r.pass : null }; });
    },
    etsySession: () => etsySessionInfo(),
    run: ({ count, dryRun, publish, source }) => job(dryRun ? 'dry-run' : (source === 'schedule' ? 'schedule' : 'run'), () => runPipeline({ count, dryRun, publish, source: source || 'manual' })),
    productDetail: ({ id }) => productDetail(id),
    archive: ({ id }) => { db.updateProduct(id, { status: 'Arşiv' }); return true; },
    deleteProduct: ({ id }) => {
      if (busy) throw new Error('Şu anda başka bir işlem çalışıyor');
      const p = db.getProduct(id);
      if (!p) throw new Error('Ürün bulunamadı');
      // Klasör kalıcı silinmez: output/_silinenler altına taşınır (geri almak için oradan geri taşıyabilirsiniz)
      let moved = null;
      if (p.folder && fs.existsSync(p.folder)) {
        const trash = path.join(PATHS.output, '_silinenler');
        fs.mkdirSync(trash, { recursive: true });
        moved = path.join(trash, path.basename(p.folder));
        if (fs.existsSync(moved)) moved = `${moved}_${Date.now()}`;
        fs.renameSync(p.folder, moved);
      }
      db.deleteProduct(id);
      log(`Ürün silindi: ${p.title || p.keyword || id}${moved ? ' (dosyalar output/_silinenler klasörüne taşındı)' : ''}`, 'warn');
      return { moved };
    },
    qcRecheck: ({ id }) => job('qc', () => recheckProduct(id)),
    repair: ({ id, files }) => job('repair', () => repairProduct(id, files)),
    dropBad: ({ id }) => job('drop', () => dropBadDesigns(id)),
    removeDesigns: ({ id, files }) => job('drop', () => dropBadDesigns(id, files)),
    eraseWhite: ({ id, file, fx, fy, points }) => eraseWhiteAt(id, file, fx, fy, points),
    undoErase: ({ id, file, all }) => undoErase(id, file, !!all),
    rebuildMedia: ({ id }) => job('rebuild', () => rebuildMedia(id)),
    stop: () => { control.stopRequested = true; log('Durdurma isteği alındı — mevcut adım bitince durulacak', 'warn'); return true; },
    publishOne: ({ id }) => job('publish', () => publishExisting(id)),
    // Toplu yükleme: seçilen ürünler sırayla (tek iş olarak; arada durdurulabilir)
    publishMany: ({ ids }) => job('publish', async () => {
      const list = (ids || []).filter(Boolean);
      let ok = 0, fail = 0; const failed = [];
      log(`📦 Toplu yükleme başladı: ${list.length} ürün`, 'success');
      for (const [i, id] of list.entries()) {
        if (control.stopRequested) { log('Toplu yükleme durduruldu', 'warn'); break; }
        const p = db.getProduct(id);
        log(`📦 ${i + 1}/${list.length}: ${(p && p.title) || id}`);
        progress({ current: i, total: list.length, step: `Etsy'ye yükleniyor ${i + 1}/${list.length}`, pct: Math.round((i / list.length) * 100) });
        try { await publishExisting(id); ok++; } catch (e) { fail++; failed.push(id); logError(`Toplu yükleme ${id}`, e); }
      }
      control.stopRequested = false;
      progress({ current: list.length, total: list.length, step: 'Bitti', pct: 100 });
      log(`📦 Toplu yükleme bitti: ${ok} başarılı${fail ? `, ${fail} başarısız` : ''}`, fail ? 'warn' : 'success');
      return { ok, fail, failed };
    }),
    login: () => job('login', () => require('./05_etsy_publisher').loginInteractive()),
    oauth: () => job('oauth', () => require('./05_etsy_publisher').runOAuth()),
    setup: () => job('setup', () => require('./setup_mockups').setupMockups()),
    importDesigns: ({ files, keyword, style, trend, mode, designs }) => job('import', () => importProduct({ files, keyword, style, trend, mode, designs })),
    priceCalc: ({ price, discount }) => require('./lib/pricing').calcProfit(price, discount, loadConfig()),
    updatePrices: ({ price, onlyBundles }) => job('prices', () => require('./lib/etsy_shop_tools').updateAllPrices(price, { onlyBundles: onlyBundles !== false })),
    createSale: ({ pct, days }) => job('sale', () => require('./lib/etsy_shop_tools').createSale(pct, days)),
    regenGemini: ({ id, file }) => job('gemini', () => regenWithGemini(id, file)),
    autoGemini: ({ mode, keyword, n }) => job('gemini', () => autoGeminiProduct({ mode, keyword, n })),
    // Ücretsiz Gemini ile art arda birkaç ürün (her biri: çizim → ürün → vitrin). Arada "Durdur" ile kesilebilir.
    autoGeminiBatch: ({ mode = 'mix', count = 3 }) => job('gemini', async () => {
      const n = Math.max(1, Math.min(10, Number(count) || 1));
      const m = ['text', 'mix', 'vintage', 'everyday', 'illustration'].includes(mode) ? mode : 'mix';
      log(`🔁 Toplu ücretsiz üretim başladı: ${n} ürün (${m})`, 'success');
      const made = []; let failed = 0;
      for (let i = 1; i <= n; i++) {
        if (control.stopRequested) { log('Toplu üretim durduruldu', 'warn'); break; }
        log(`──── Ürün ${i}/${n} ────`);
        progress({ current: i - 1, total: n, step: `Ürün ${i}/${n} çiziliyor`, pct: Math.round(((i - 1) / n) * 100) });
        try {
          const r = await autoGeminiProduct({ mode: m });
          if (r && r.id) {
            try { await rebuildMedia(r.id); } catch (e) { logError(`Vitrin oluşturma ${r.id}`, e); }
            made.push(r.id);
          } else failed++;
        } catch (e) {
          if (e instanceof StopError) { log('Toplu üretim güvenli şekilde durduruldu', 'warn'); break; }
          failed++; logError(`Toplu üretim ${i}`, e);
        }
      }
      control.stopRequested = false;
      progress({ current: n, total: n, step: 'Bitti', pct: 100 });
      log(`🔁 Toplu üretim bitti: ${made.length} hazır${failed ? `, ${failed} başarısız` : ''} — kontrol edip "Toplu yükle" ile gönderebilirsin`, made.length ? 'success' : 'warn');
      return { made, failed };
    }),
    illuPrompts: ({ subject, n }) => require('./lib/design_variety').illustrationPrompts(subject || 'vintage christmas animals', n || 4),
    illuTopic: ({ exclude }) => require('./lib/design_variety').illustrationTopic(exclude || []),
    suggestTopic: async ({ exclude }) => {
      const t = await findTrend({ fast: true, exclude: new Set(exclude || []) });
      return t;
    },
    designPrompts: ({ subject, n }) => require('./lib/design_variety').geminiPrompts(subject || 'Your Topic', n || 4),
    ping: () => 'pong',
  };

  process.on('message', async (msg) => {
    const { id, type, payload } = msg || {};
    try {
      if (!handlers[type]) throw new Error(`Bilinmeyen komut: ${type}`);
      const data = await handlers[type](payload || {});
      send({ id, ok: true, data });
    } catch (err) {
      if (!(err instanceof StopError)) logError(`Komut "${type}"`, err);
      send({ id, ok: false, error: err.message || String(err) });
    }
  });
  process.on('disconnect', () => process.exit(0));
  send({ event: 'ready' });
  // Uzaktan istek: data/publish_request.txt içinde ürün kimliği varsa (panel ekranı kapalıyken) o ürün Etsy'ye taslak olarak yüklenir
  setTimeout(() => {
    try {
      // data/auto_request.txt: "illustration [konu]" ya da "text [konu]" → Gemini ile otomatik ürün
      const fa = path.join(PATHS.data, 'auto_request.txt');
      if (fs.existsSync(fa)) {
        const [mode, ...rest] = fs.readFileSync(fa, 'utf8').trim().split(/\s+/);
        fs.unlinkSync(fa);
        job('gemini', () => autoGeminiProduct({ mode: ['text', 'mix', 'vintage', 'everyday'].includes(mode) ? mode : 'illustration', keyword: rest.join(' ') || null }))
          .catch((e) => logError('Uzaktan Gemini üretimi', e));
      }
      // data/import_request.json: [{ dir, keyword, mode }] → klasördeki görsellerden ürün (Gemini'yi yeniden çağırmadan)
      const fi = path.join(PATHS.data, 'import_request.json');
      if (fs.existsSync(fi)) {
        const reqs = JSON.parse(fs.readFileSync(fi, 'utf8'));
        fs.unlinkSync(fi);
        (async () => {
          for (const r of reqs) {
            const files = fs.readdirSync(r.dir).filter((x) => /\.(png|jpe?g)$/i.test(x)).sort().map((x) => path.join(r.dir, x));
            try { await job('import', () => importProduct({ files, keyword: r.keyword, mode: r.mode || 'text', designs: r.designs || null, gen: r.gen || null })); } catch (e) { logError('Uzaktan içe aktarma', e); }
          }
        })();
      }
      // data/bs_request.json: { sets:["mama_patchwork",…] } → çok satan kalıplı özgün setler (Gemini → ürün → vitrin; yayınlanmaz)
      const fbs = path.join(PATHS.data, 'bs_request.json');
      if (fs.existsSync(fbs) && !busy && !publishLoop && !fs.existsSync(path.join(PATHS.data, 'publish_request.txt'))) {
        const r = JSON.parse(fs.readFileSync(fbs, 'utf8'));
        fs.unlinkSync(fbs);
        runBsSets(r, job).catch((e) => logError('Çok satan setleri', e));
      }
      // data/model_request.json: { generate:true, force:false, preview:[ürün id] } → modelli kapak fotoğrafları + örnek kapaklar
      const fm = path.join(PATHS.data, 'model_request.json');
      if (fs.existsSync(fm)) {
        const r = JSON.parse(fs.readFileSync(fm, 'utf8'));
        fs.unlinkSync(fm);
        job('gemini', () => modelMockupJob(r)).catch((e) => logError('Modelli mockup', e));
      }
      // data/cover_request.json: { ids:[Etsy ilan no] } → mevcut ilanlara modelli kapak + "tank top png" etiketi
      const fc = path.join(PATHS.data, 'cover_request.json');
      if (fs.existsSync(fc)) {
        const r = JSON.parse(fs.readFileSync(fc, 'utf8'));
        fs.unlinkSync(fc);
        job('publish', () => require('./lib/etsy_cover_update').updateCovers((r.ids || []).map(String))).catch((e) => logError('Kapak güncelleme', e));
      }
      const fau = path.join(PATHS.data, 'audit_request.json');
      if (fs.existsSync(fau)) {
        const r = JSON.parse(fs.readFileSync(fau, 'utf8'));
        fs.unlinkSync(fau);
        job('publish', () => require('./lib/etsy_audit').audit(r.ids || [])).catch((e) => logError('Etsy denetimi', e));
      }
      const fmd = path.join(PATHS.data, 'media_request.json');
      if (fs.existsSync(fmd)) {
        const r = JSON.parse(fs.readFileSync(fmd, 'utf8'));
        fs.unlinkSync(fmd);
        job('publish', () => require('./lib/etsy_media_update').updateMedia(r.items || [])).catch((e) => logError('Vitrin yenileme', e));
      }
      const fr = path.join(PATHS.data, 'files_request.json');
      if (fs.existsSync(fr)) {
        const r = JSON.parse(fs.readFileSync(fr, 'utf8'));
        fs.unlinkSync(fr);
        job('publish', () => require('./lib/etsy_files_update').replaceFiles(r.items || [])).catch((e) => logError('Dosya yenileme', e));
      }
      // data/rebuild_request.json: { ids?:[ürün id] } → "Vitrini oluştur" (ids yoksa .media_stale olan tüm ürünler), sırayla
      const frb = path.join(PATHS.data, 'rebuild_request.json');
      if (fs.existsSync(frb)) {
        const r = JSON.parse(fs.readFileSync(frb, 'utf8'));
        fs.unlinkSync(frb);
        (async () => {
          const ids = r.ids && r.ids.length ? r.ids : db.listProducts(1000).filter((p) => p.folder && fs.existsSync(path.join(p.folder, '.media_stale')) && !['Taslak', 'Yayında'].includes(p.status)).map((p) => p.id);
          log(`Toplu vitrin oluşturma: ${ids.length} ürün`);
          let ok = 0;
          for (const id of ids) {
            try { await rebuildMedia(id); ok++; log(`Vitrin oluşturuldu: ${id}`, 'success'); } catch (e) { logError(`Vitrin oluşturma ${id}`, e); }
          }
          log(`Toplu vitrin bitti: ${ok}/${ids.length} başarılı`, ok === ids.length ? 'success' : 'warn');
        })();
      }
      // data/mega_request.json: { step:'prepare' } | { step:'drive', id } | { step:'all' } → dev paket
      const fmg = path.join(PATHS.data, 'mega_request.json');
      if (fs.existsSync(fmg)) {
        const r = JSON.parse(fs.readFileSync(fmg, 'utf8'));
        fs.unlinkSync(fmg);
        job('import', async () => {
          const mb = require('./lib/mega_bundle');
          let id = r.id;
          if (r.step === 'video') { await mb.addVideo(r.id, r.listing); return; }
          if (r.step !== 'drive') id = (await mb.prepare()).id;
          if (r.step !== 'prepare') await mb.driveUpload(id);
        }).catch((e) => logError('Dev paket', e));
      }
      // data/seo_request.json: { items: { "<ilan no>": { title, tags } } } → başlık/etiket yenileme
      const fso = path.join(PATHS.data, 'seo_request.json');
      if (fs.existsSync(fso)) {
        const r = JSON.parse(fs.readFileSync(fso, 'utf8'));
        fs.unlinkSync(fso);
        job('publish', () => require('./lib/etsy_seo_update').updateSeo(r.items || {})).catch((e) => logError('SEO yenileme', e));
      }
      const ff = path.join(PATHS.data, 'fix_request.json');
      if (fs.existsSync(ff)) {
        const r = JSON.parse(fs.readFileSync(ff, 'utf8'));
        fs.unlinkSync(ff);
        job('repair', () => fixMagentaJob(r)).catch((e) => logError('Pembe artık onarımı', e));
      }
      const f = path.join(PATHS.data, 'publish_request.txt');
      if (!fs.existsSync(f)) return;
      const ids = fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean);
      fs.unlinkSync(f);
      publishLoop = true;
      (async () => {
        for (const id of ids) {
          log(`Uzaktan istek: ${id} Etsy'ye yükleniyor`);
          try { await job('publish', () => publishExisting(id)); } catch (e) { logError('Uzaktan yükleme', e); }
        }
        log(`Uzaktan yükleme bitti: ${ids.length} ürün işlendi`, 'success');
        // Sırada bekleyen vitrin yenileme varsa yüklemeden sonra başlat
        const nx = path.join(PATHS.data, '_media_next.json');
        if (fs.existsSync(nx)) {
          const r = JSON.parse(fs.readFileSync(nx, 'utf8'));
          fs.unlinkSync(nx);
          try { await job('publish', () => require('./lib/etsy_media_update').updateMedia(r.items || [])); } catch (e) { logError('Vitrin yenileme', e); }
        }
      })().finally(() => { publishLoop = false; });
    } catch (e) { logError('Uzaktan istek', e); }
  }, 3000);
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const a = { dryRun: false, publish: true, count: null, publishId: null, ipc: false, source: 'manual' };
  for (const arg of argv) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--no-publish') a.publish = false;
    else if (arg === '--ipc') a.ipc = true;
    else if (arg === '--scheduled') a.source = 'windows-task';
    else if (arg.startsWith('--count=')) a.count = Number(arg.split('=')[1]);
    else if (arg.startsWith('--publish-id=')) a.publishId = arg.split('=')[1];
  }
  return a;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
  if (args.ipc) {
    startIpcWorker();
  } else {
    const colors = { info: '\x1b[37m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
    bus.on('log', (e) => console.log(`${colors[e.level] || ''}[${e.ts.slice(11, 19)}] ${e.msg}\x1b[0m`));
    process.on('SIGINT', () => { control.stopRequested = true; console.log('\nDurduruluyor...'); });
    const p = args.publishId ? publishExisting(args.publishId) : runPipeline(args);
    p.then((r) => { if (r && r.products) console.log(JSON.stringify(r.products.map((x) => ({ id: x.id, status: x.status, title: x.title, folder: x.folder })), null, 2)); process.exit(0); })
      .catch((e) => { logError('CLI', e); process.exit(1); });
  }
}

module.exports = { runPipeline, publishExisting, startIpcWorker, repairProduct, dropBadDesigns, productDetail, importProduct };
