'use strict';
/**
 * Dev paket ("160 Christmas PNG Mega Bundle"): mevcut ürünlerin Noel tasarımlarını tek ilanda toplar.
 * Dosyalar Etsy'nin 5×20 MB sınırına sığmadığı için Google Drive'a yüklenir (Gemini'de giriş yapılmış Google hesabı),
 * klasör "bağlantıya sahip herkes görüntüleyebilir" yapılır ve alıcıya linkli Download_Instructions.pdf teslim edilir.
 *
 * Adımlar (data/mega_request.json):
 *   { step: 'prepare' }  → output/<id>/ altında kategori ZIP'leri, kapak/önizleme görselleri, SEO; ürün "İnceleme"
 *   { step: 'drive', id } → ZIP'leri Drive'a yükler, paylaşır, PDF'i üretir; ürün "Hazır"
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { log, PATHS, loadConfig, escapeXml } = require('./core');
const db = require('./db');

const XMAS = /christmas|xmas|santa|snow|reindeer|holiday|cocoa|winter|sleigh|otter/i;
const EXCLUDE = /e97fc9|21b135/; // bulanık woodland, kaldırılan Family Christmas kopyası
const CATS = [
  ['Vintage Santa and Reindeer', /santa|reindeer|sleigh/i],
  ['Winter Animals and Snowmen', /snowman|owl|fox|woodland|otter|dachshund|barnyard|moose|cocoa|animal/i],
  ['Family and Kids Christmas', /family|kids|grandma|mom|teacher|pajam|matching|stocking|photoshoot|books|jumper|sweater/i],
  ['Minimalist and Retro Holiday', /./],
];
const CW = 2700, CH = 2025;

function collect() {
  const rows = db.listProducts(1000).filter((p) => ['Taslak', 'Yayında', 'Hazır'].includes(p.status) && !/mega-bundle/.test(p.id));
  const groups = CATS.map(([name]) => ({ name, files: [] }));
  for (const p of rows) {
    if (!XMAS.test(`${p.niche || ''} ${p.id}`) || EXCLUDE.test(p.id)) continue;
    const d = path.join(p.folder || path.join(PATHS.output, p.id), 'designs');
    if (!fs.existsSync(d)) continue;
    const pngs = fs.readdirSync(d).filter((f) => /\.png$/i.test(f)).sort().map((f) => path.join(d, f));
    const key = `${p.niche || ''} ${p.id}`;
    const gi = CATS.findIndex(([, re]) => re.test(key));
    groups[gi].files.push(...pngs);
  }
  return groups.filter((g) => g.files.length);
}

async function thumb(file, w, h, bg) {
  const t = await sharp(file).trim({ threshold: 10 }).resize(Math.round(w * 0.9), Math.round(h * 0.9), { fit: 'inside' }).png().toBuffer().catch(() => sharp(file).resize(Math.round(w * 0.9), Math.round(h * 0.9), { fit: 'inside' }).png().toBuffer());
  const m = await sharp(t).metadata();
  return sharp({ create: { width: w, height: h, channels: 4, background: bg } })
    .composite([{ input: t, left: Math.round((w - m.width) / 2), top: Math.round((h - m.height) / 2) }]).png().toBuffer();
}

const roundRect = (w, h, r, fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="${fill}"/></svg>`);

/** Kapak: tüm tasarımlardan sık bir kolaj + ortada büyük başlık bandı (çok satan dev paketler gibi) */
async function coverImage(all, total, out) {
  const cols = 12, rows = 8, cw = Math.floor(CW / cols), ch = Math.floor(CH / rows);
  const pick = [];
  for (let i = 0; i < cols * rows; i++) pick.push(all[(i * 7) % all.length]);
  const layers = [];
  for (let i = 0; i < pick.length; i++) {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    layers.push({ input: await thumb(pick[i], cw - 8, ch - 8, i % 2 ? '#f6efe3' : '#efe6d6'), left: x + 4, top: y + 4 });
  }
  const bw = 1700, bh = 760, bx = Math.round((CW - bw) / 2), by = Math.round((CH - bh) / 2);
  const band = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}">
    <rect x="0" y="0" width="${bw}" height="${bh}" rx="60" fill="#7a1f1f" stroke="#f3d9a4" stroke-width="14"/>
    <text x="50%" y="230" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="250" fill="#f6efe3">${total}+</text>
    <text x="50%" y="400" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="140" fill="#f6efe3">Christmas PNG</text>
    <text x="50%" y="545" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="120" fill="#f3d9a4">Mega Bundle</text>
    <text x="50%" y="660" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="54" fill="#f6efe3">Vintage · Retro · Sublimation · DTF · 300 DPI</text>
  </svg>`);
  layers.push({ input: band, left: bx, top: by });
  await sharp({ create: { width: CW, height: CH, channels: 3, background: '#1f3a2e' } }).composite(layers).jpeg({ quality: 90 }).toFile(out);
  return out;
}

/** Kategori önizleme sayfası */
async function categorySheet(g, out) {
  const head = 300;
  const n = Math.min(g.files.length, 40);
  const cols = n > 24 ? 8 : n > 12 ? 6 : 4, rows = Math.ceil(n / cols);
  const cw = Math.floor((CW - 80) / cols), ch = Math.floor((CH - head - 60) / rows);
  const layers = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${head}">
    <text x="60" y="150" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="120" fill="#f6efe3">${escapeXml(g.name)}</text>
    <text x="60" y="245" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="64" fill="#f3d9a4">${g.files.length} PNG designs included · transparent · 300 DPI</text>
  </svg>`), left: 0, top: 0 }];
  for (let i = 0; i < n; i++) {
    const x = 40 + (i % cols) * cw, y = head + 20 + Math.floor(i / cols) * ch;
    const t = await thumb(g.files[i], cw - 16, ch - 16, '#f6efe3');
    layers.push({ input: await sharp(t).composite([{ input: roundRect(cw - 16, ch - 16, 24, '#fff'), blend: 'dest-in' }]).png().toBuffer(), left: x + 8, top: y + 8 });
  }
  await sharp({ create: { width: CW, height: CH, channels: 3, background: '#1f3a2e' } }).composite(layers).jpeg({ quality: 90 }).toFile(out);
  return out;
}

/** "Neler var" bilgi görseli */
async function includedImage(groups, total, out) {
  const lines = groups.map((g, i) => `<text x="160" y="${640 + i * 150}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="78" fill="#f6efe3">✓ ${escapeXml(g.name)}  —  ${g.files.length} designs</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}"><rect width="100%" height="100%" fill="#1f3a2e"/>
    <text x="160" y="260" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="150" fill="#f3d9a4">What's included</text>
    <text x="160" y="420" font-family="Arial, Helvetica, sans-serif" font-size="70" fill="#f6efe3">${total} high resolution transparent PNG files · 4500 x 5400 px · 300 DPI</text>
    ${lines}
    <text x="160" y="${700 + groups.length * 150}" font-family="Arial, Helvetica, sans-serif" font-size="62" fill="#f3d9a4">Instant download: PDF with your Google Drive download link</text>
    <text x="160" y="${800 + groups.length * 150}" font-family="Arial, Helvetica, sans-serif" font-size="58" fill="#f6efe3">Perfect for sublimation, DTF transfers, t-shirts, sweatshirts, mugs and tote bags</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(out);
  return out;
}

function seoFor(total, groups) {
  const cfg = loadConfig();
  const title = `${total} Christmas PNG Mega Bundle, Vintage Santa Sublimation, Retro Christmas Shirt Design, Xmas DTF Transfer PNG, Holiday Clipart`.slice(0, 140);
  const tags = ['christmas png bundle', 'christmas png', 'mega bundle png', 'vintage santa png', 'retro christmas png', 'xmas sublimation', 'christmas shirt png', 'dtf transfer png', 'sublimation png', 'holiday png', 'christmas clipart', 'snowman png', 'reindeer png'];
  const description = [
    `${total} Christmas PNG designs in one mega bundle: vintage Santa, reindeer, snowmen, winter animals, family and kids Christmas, minimalist and retro holiday designs.`,
    '',
    "WHAT'S INCLUDED",
    ...groups.map((g) => `- ${g.name}: ${g.files.length} designs`),
    `- ${total} high resolution PNG files, 4500 x 5400 px, 300 DPI, transparent background`,
    '',
    'HOW YOU GET THE FILES',
    '- This is an instant digital download. After purchase you receive a PDF with a Google Drive link.',
    '- Open the link on a computer and download the ZIP files (the full bundle is about 1.9 GB).',
    '',
    'PERFECT FOR',
    '- Sublimation and DTF transfers, t-shirts, sweatshirts, tank tops, hoodies, mugs, tote bags, stickers and print on demand.',
    '',
    'LICENSE',
    '- Personal use and small business commercial use: you may sell up to 500 physical items per design.',
    '- Reselling or sharing the digital files is not allowed.',
    '',
    'This is a digital product. No physical item will be shipped. Colors may vary slightly between screens and printers.',
  ].join('\n');
  return { title, tags, description, price: Number(cfg.mega_price || 129.99), price_fixed: true, currency: cfg.currency, quantity: Number(cfg.quantity || 999), who_made: 'i_did', is_supply: false, when_made: '2020_2026', type: 'download', materials: ['digital file', 'png'], primary_keyword: 'christmas png bundle', delivery: { mode: 'cloud' } };
}

async function prepare(reuseId = null) {
  const groups = collect();
  const total = groups.reduce((s, g) => s + g.files.length, 0);
  if (total < 40) throw new Error(`yeterli Noel tasarımı yok (${total})`);
  const d = new Date();
  // Önceki yarım kalmış hazırlık varsa (ZIP'ler duruyor) onu kullan
  const prev = reuseId || (fs.readdirSync(PATHS.output).filter((x) => /christmas-png-mega-bundle-/.test(x) && fs.existsSync(path.join(PATHS.output, x, 'zips'))).sort().pop());
  const id = prev || `${d.toISOString().slice(0, 10).replace(/-/g, '')}-christmas-png-mega-bundle-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(PATHS.output, id);
  fs.mkdirSync(path.join(dir, 'mockups'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'zips'), { recursive: true });
  log(`Dev paket: ${total} tasarım, ${groups.length} kategori — ZIP'ler hazırlanıyor (birkaç dakika)…`);
  const { createZip } = require('./zip');
  const readme = path.join(dir, 'README_LICENSE.txt');
  fs.writeFileSync(readme, `${total} Christmas PNG Mega Bundle\n\nThank you for your purchase!\n\n- ${total} PNG files, 4500 x 5400 px, 300 DPI, transparent background\n- Personal use and small business commercial use (up to 500 physical items per design)\n- Reselling or sharing the digital files is not allowed.\n`);
  for (const [gi, g] of groups.entries()) {
    const zp = path.join(dir, 'zips', `${gi + 1}_${g.name.replace(/[^A-Za-z0-9]+/g, '_')}.zip`);
    if (fs.existsSync(zp) && fs.statSync(zp).size > 50e6) { log(`Dev paket ZIP zaten var: ${path.basename(zp)}`); continue; }
    await createZip(zp, [...g.files.map((f, i) => ({ path: f, name: `${g.name}/${String(i + 1).padStart(3, '0')}_${path.basename(f)}` })), { path: readme, name: 'README_LICENSE.txt' }]);
    log(`Dev paket ZIP: ${path.basename(zp)} (${(fs.statSync(zp).size / 1e6).toFixed(0)} MB)`);
  }
  const all = groups.flatMap((g) => g.files);
  await coverImage(all, total, path.join(dir, 'mockups', '01_cover.jpg'));
  // 2. görsel: en iyi tasarım modelli tişörtte (kapakla aynı gerçekçi tarz)
  try {
    const { modelCover } = require('../03_mockup_engine');
    const { readModelManifest } = require('./model_mockups');
    const best = (groups.find((g) => /Santa/.test(g.name)) || groups[0]).files[0];
    await modelCover(readModelManifest(), [best], { niche: 'vintage santa christmas', keyword: 'christmas png bundle', season: 'Christmas' }, path.join(dir, 'mockups', '02_model.jpg'));
  } catch (e) { log(`Dev paket modelli görsel atlandı: ${e.message}`, 'warn'); }
  for (const [gi, g] of groups.entries()) await categorySheet(g, path.join(dir, 'mockups', `0${gi + 3}_${g.name.split(' ')[0].toLowerCase()}.jpg`));
  await includedImage(groups, total, path.join(dir, 'mockups', `0${groups.length + 3}_included.jpg`));
  fs.writeFileSync(path.join(dir, 'seo_metadata.json'), JSON.stringify(seoFor(total, groups), null, 2));
  fs.writeFileSync(path.join(dir, 'trend.json'), JSON.stringify({ keyword: 'christmas png bundle', niche: 'christmas png mega bundle', season: 'Christmas', style: 'vintage', mode: 'illustration', subjects: ['santa', 'reindeer', 'snowman'], mega: true, total }, null, 2));
  const seo = seoFor(total, groups);
  db.saveProduct({ id, niche: 'christmas png mega bundle', keyword: 'christmas png bundle', title: seo.title, tags: seo.tags, status: 'İnceleme', folder: dir, thumbnail: path.join(dir, 'mockups', '01_cover.jpg'), error: 'Drive linki bekleniyor' });
  log(`Dev paket hazırlandı: ${id} (${total} tasarım) — sıradaki adım: Drive'a yükleme`, 'success');
  return { id, total };
}

/* ---------------- Google Drive (Gemini oturumundaki Google hesabı) ---------------- */
async function shot(page, name) { await page.screenshot({ path: path.join(PATHS.logs, `drive_${name}.png`) }).catch(() => {}); }
const btnRe = (tr, en) => new RegExp(`^\\s*(${tr}|${en})\\s*$`, 'i');

async function driveUpload(id) {
  const p = db.getProduct(id);
  if (!p) throw new Error('dev paket ürünü bulunamadı');
  const dir = p.folder;
  const zips = fs.readdirSync(path.join(dir, 'zips')).filter((f) => /\.zip$/.test(f)).sort().map((f) => path.join(dir, 'zips', f));
  const SHOP = loadConfig().shop_name || 'Shop';
  const tr = JSON.parse(fs.readFileSync(path.join(dir, 'trend.json'), 'utf8'));
  const folderName = `${SHOP} - ${tr.drive_title || `${tr.total} Christmas PNG Mega Bundle`}`;
  const { chromium } = require('playwright');
  const cfg = loadConfig();
  const sess = path.join(PATHS.data, 'gemini_session');
  const opts = { headless: false, viewport: { width: 1400, height: 900 }, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(sess, { ...opts, channel: cfg.browser_channel || 'msedge' }); } catch { ctx = await chromium.launchPersistentContext(sess, opts); }
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://drive.google.com/drive/my-drive', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(6000);
    if (/accounts\.google\.com/.test(page.url())) { await shot(page, 'login'); throw new Error('Drive için Google oturumu yok — Gemini penceresinde Google girişi gerekli'); }
    await shot(page, '1_mydrive');
    // Yeni klasör
    const newBtn = page.getByRole('button', { name: /^(new|yeni)$/i }).first();
    await newBtn.click({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.getByRole('menuitem', { name: /new folder|yeni klasör|klasör/i }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const inp = page.locator('input[type="text"]:visible').last();
    await inp.fill(folderName);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await shot(page, '2_folder');
    // Klasörü aç
    await page.getByText(folderName, { exact: true }).first().dblclick({ timeout: 20000 });
    await page.waitForURL(/\/folders\//, { timeout: 30000 });
    const folderId = (page.url().match(/folders\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!folderId) throw new Error('Drive klasör kimliği alınamadı');
    await page.waitForTimeout(3000);
    // Dosya yükle
    await page.getByRole('button', { name: /^(new|yeni)$/i }).first().click({ timeout: 20000 });
    await page.waitForTimeout(1200);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20000 }),
      page.getByRole('menuitem', { name: /file upload|dosya yükle/i }).first().click(),
    ]);
    await chooser.setFiles(zips);
    log(`Drive: ${zips.length} ZIP yükleniyor (toplam ${(zips.reduce((s, z) => s + fs.statSync(z).size, 0) / 1e9).toFixed(2)} GB) — internet hızına göre uzun sürebilir`);
    // Yükleme bitişini bekle (en fazla 3 saat)
    const t0 = Date.now();
    for (;;) {
      await page.waitForTimeout(20000);
      const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (/(\d+)\s*(upload|yükleme)[^\n]*(complete|tamamlandı)/i.test(txt) && !/(uploading|yükleniyor)\s+\d/i.test(txt)) break;
      if (Date.now() - t0 > 3 * 3600 * 1000) { await shot(page, 'upload_timeout'); throw new Error('Drive yüklemesi 3 saatte bitmedi'); }
      if ((Date.now() - t0) % 300000 < 21000) log(`Drive: yükleme sürüyor (${Math.round((Date.now() - t0) / 60000)} dk)`);
    }
    await shot(page, '3_uploaded');
    // Paylaş: "bağlantıya sahip herkes görüntüleyebilir"
    let shared = false;
    try {
      await page.goto('https://drive.google.com/drive/my-drive', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(5000);
      await page.getByText(folderName, { exact: true }).first().click({ timeout: 20000 });
      await page.waitForTimeout(800);
      await page.keyboard.press('.'); // Drive kısayolu: seçili öğeyi paylaş
      await page.waitForTimeout(5000);
      await shot(page, '4_share');
      const frames = [page, ...page.frames()];
      for (const f of frames) {
        const gen = f.getByRole('button', { name: /restricted|kısıtlanmış|kısıtlı/i }).first();
        if (await gen.count().catch(() => 0)) {
          await gen.click({ timeout: 8000 });
          await page.waitForTimeout(1200);
          await f.getByRole('option', { name: /anyone with the link|bağlantıya sahip olan herkes/i }).first().click({ timeout: 8000 })
            .catch(() => f.getByText(/anyone with the link|bağlantıya sahip olan herkes/i).first().click({ timeout: 8000 }));
          await page.waitForTimeout(2500);
          await shot(page, '5_anyone');
          const done = f.getByRole('button', { name: btnRe('bitti|tamam', 'done') }).first();
          if (await done.count().catch(() => 0)) await done.click().catch(() => {});
          shared = true;
          break;
        }
        if (await f.getByText(/anyone with the link|bağlantıya sahip olan herkes/i).count().catch(() => 0)) { shared = true; break; }
      }
    } catch (e) { log(`Drive paylaşım ayarı otomatik yapılamadı: ${e.message}`, 'warn'); }
    const link = `https://drive.google.com/drive/folders/${folderId}?usp=sharing`;
    fs.writeFileSync(path.join(dir, 'drive.json'), JSON.stringify({ folderId, link, shared, at: new Date().toISOString() }, null, 2));
    // Alıcı PDF'i
    const { buildInstructionsPdf } = require('../02_asset_generator');
    await buildInstructionsPdf(path.join(dir, 'Download_Instructions.pdf'), { title: `${folderName.replace(`${SHOP} - `, '')} - Download your files from Google Drive`, link, expiresNote: null });
    db.updateProduct(id, shared ? { status: 'Hazır', error: null } : { status: 'İnceleme', error: 'Drive klasörü paylaşıma açılmalı (bağlantıya sahip herkes)' });
    log(shared ? `Drive hazır ve paylaşıldı: ${link}` : `Drive'a yüklendi ama paylaşım ayarı doğrulanamadı: ${link}`, shared ? 'success' : 'warn');
    return { link, shared };
  } finally { await ctx.close().catch(() => {}); }
}


/* ---------------- Dev paket videosu (kapak + kategori sayfaları, Ken Burns) ve ilana ekleme ---------------- */
async function makeVideo(dir) {
  const { kenBurnsVideo, ffmpegPath } = require('../03_mockup_engine');
  const { spawn } = require('child_process');
  const mdir = path.join(dir, 'mockups');
  const imgs = fs.readdirSync(mdir).filter((f) => /^(01|03|04|05)_.*\.jpg$/.test(f)).sort().map((f) => path.join(mdir, f));
  const clips = [];
  for (const [i, im] of imgs.entries()) { const c = path.join(dir, `.clip${i}.mp4`); await kenBurnsVideo(im, c, 3); clips.push(c); }
  const list = path.join(dir, '.clips.txt');
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const out = path.join(dir, 'listing_video.mp4');
  await new Promise((resolve, reject) => {
    const pr = spawn(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; pr.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    pr.on('error', reject); pr.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg birleştirme hatası: ${err.slice(-300)}`))));
  });
  for (const c of [...clips, list]) { try { fs.unlinkSync(c); } catch { /* yok say */ } }
  log(`Dev paket videosu hazır (${imgs.length * 3} sn)`, 'success');
  return out;
}

async function addVideo(id, listingId) {
  const p = db.getProduct(id);
  const dir = p.folder;
  const video = await makeVideo(dir);
  const pub = require('../05_etsy_publisher');
  const attrs = require('./etsy_attrs');
  const ctx = await pub.launchBrowser(false, loadConfig());
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    page = await pub.ensureLoggedIn(ctx, page);
    const url = `https://www.etsy.com/your/shops/me/listing-editor/edit/${listingId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000);
    const hasVideo = () => page.evaluate(() => !!document.querySelector('[aria-label="Primary video"], video'));
    if (await hasVideo()) { log('Dev paket ilanında zaten video var'); return { already: true }; }
    const snap = await attrs.snapshot(page);
    const photos = await page.evaluate(() => [...document.querySelectorAll('[aria-roledescription="sortable"] img')].length);
    await page.locator('input[type="file"]').first().setInputFiles([video]);
    for (let k = 0; k < 60 && !(await hasVideo()); k++) await page.waitForTimeout(2000);
    await pub.waitUploadsDone(page, 180000);
    if (!(await hasVideo())) throw new Error('video yüklenemedi');
    await attrs.restore(page, snap);
    await page.screenshot({ path: path.join(PATHS.logs, `video_add_${listingId}.png`) }).catch(() => {});
    await page.getByRole('button', { name: /^(publish changes|save draft)$/i }).first().click();
    await page.waitForURL((u) => !/listing-editor\/edit/.test(u.toString()), { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
    await page.waitForTimeout(4000);
    const okV = await hasVideo();
    const photos2 = await page.evaluate(() => [...document.querySelectorAll('[aria-roledescription="sortable"] img')].length);
    const v = await attrs.verify(page, snap);
    if (!okV || photos2 < photos || !v.ok) throw new Error(`kayıt doğrulanamadı (video ${okV}, foto ${photos2}/${photos}, etiket/zanaat ${v.ok})`);
    log(`Dev paket ilanına video eklendi ✓ (ilan ${listingId})`, 'success');
    return { ok: true };
  } finally { await ctx.close().catch(() => {}); }
}

module.exports = { prepare, driveUpload, collect, makeVideo, addVideo };
