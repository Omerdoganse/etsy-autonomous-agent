'use strict';
/**
 * Temalı büyük paketler: mevcut ürünlerin tasarımlarından konuya göre 15–25'lik paket ilanı üretir
 * (ör. "20 Christmas Family PNG Bundle"). Dosyalar Etsy'nin 5×20 MB sınırına sığmadığı için Google Drive'a yüklenir;
 * alıcıya linkli Download_Instructions.pdf teslim edilir (mega_bundle.js ile aynı teslimat yolu).
 *
 * İstek (data/bundle_request.json):
 *   { "build": ["family", ...] }          → hazırla (kapak, önizleme, ZIP, SEO) + Drive'a yükle; ürün "İnceleme"
 *   { "shared": ["<ürün id>", ...] }      → Drive klasörü elle "bağlantıya sahip herkes" yapıldı → ürün "Hazır"
 * Tema tanımları (hangi ürünler, başlık, etiketler, fiyat) bundle_themes.local.js'te (yoksa örnek dosya).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { log, PATHS, loadConfig, escapeXml } = require('./core');
const db = require('./db');

const CW = 2700, CH = 2025;
const STATUSES = ['Taslak', 'Yayında', 'Hazır', 'İnceleme'];

function themes() {
  try { return require('./bundle_themes.local').THEMES; } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || !/bundle_themes\.local/.test(e.message)) throw e;
    return require('./bundle_themes.example').THEMES;
  }
}

/** Temaya uyan ürünlerden, en yeniden başlayıp her üründen sırayla birer tasarım alarak (çeşitlilik) en fazla max tasarım seçer */
function pickDesigns(T) {
  const rows = db.listProducts(2000)
    .filter((p) => STATUSES.includes(p.status) && !/bundle/.test(p.id) && !(T.exclude && T.exclude.test(p.id)))
    .filter((p) => T.match.test(`${p.niche || ''} ${p.id}`) && (!T.season || T.season.test(`${p.niche || ''} ${p.id}`)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const lists = rows.map((p) => {
    const d = path.join(p.folder || path.join(PATHS.output, p.id), 'designs');
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.png$/i.test(f)).sort().map((f) => path.join(d, f)) : [];
  }).filter((l) => l.length);
  const out = [];
  for (let round = 0; out.length < T.max && lists.some((l) => l[round]); round++) {
    for (const l of lists) { if (l[round] && out.length < T.max) out.push(l[round]); }
  }
  return out;
}

async function thumb(file, w, h, bg) {
  const t = await sharp(file).trim({ threshold: 10 }).resize(Math.round(w * 0.9), Math.round(h * 0.9), { fit: 'inside' }).png().toBuffer()
    .catch(() => sharp(file).resize(Math.round(w * 0.9), Math.round(h * 0.9), { fit: 'inside' }).png().toBuffer());
  const m = await sharp(t).metadata();
  return sharp({ create: { width: w, height: h, channels: 4, background: bg } })
    .composite([{ input: t, left: Math.round((w - m.width) / 2), top: Math.round((h - m.height) / 2) }]).png().toBuffer();
}
const roundRect = (w, h, r) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="#fff"/></svg>`);

/** Kapak: tasarımların sık kolajı + ortada sayı ve tema bandı */
async function cover(files, T, out) {
  const n = files.length;
  const cols = 6, rows = 4, cw = Math.floor(CW / cols), ch = Math.floor(CH / rows);
  const layers = [];
  for (let i = 0; i < cols * rows; i++) {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    layers.push({ input: await thumb(files[i % n], cw - 10, ch - 10, i % 2 ? T.colors.light : T.colors.light2), left: x + 5, top: y + 5 });
  }
  const bw = 1750, bh = 760, bx = Math.round((CW - bw) / 2), by = Math.round((CH - bh) / 2);
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}">
    <rect width="${bw}" height="${bh}" rx="60" fill="${T.colors.band}" stroke="${T.colors.accent}" stroke-width="14"/>
    <text x="50%" y="250" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="250" fill="${T.colors.light}">${n} PNG</text>
    <text x="50%" y="420" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${T.cover[0].length > 18 ? 110 : 135}" fill="${T.colors.light}">${escapeXml(T.cover[0])}</text>
    <text x="50%" y="560" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="115" fill="${T.colors.accent}">${escapeXml(T.cover[1])}</text>
    <text x="50%" y="670" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="54" fill="${T.colors.light}">Sublimation · DTF · 300 DPI · Transparent</text>
  </svg>`), left: bx, top: by });
  await sharp({ create: { width: CW, height: CH, channels: 3, background: T.colors.bg } }).composite(layers).jpeg({ quality: 90 }).toFile(out);
}

/** Önizleme sayfası: verilen tasarımlar ızgarada, numaralı */
async function sheet(files, title, sub, T, out) {
  const head = 300, n = files.length;
  const cols = n > 12 ? 5 : 4, rows = Math.ceil(n / cols);
  const cw = Math.floor((CW - 80) / cols), ch = Math.floor((CH - head - 60) / rows);
  const layers = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${head}">
    <text x="60" y="150" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="115" fill="${T.colors.light}">${escapeXml(title)}</text>
    <text x="60" y="245" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="62" fill="${T.colors.accent}">${escapeXml(sub)}</text>
  </svg>`), left: 0, top: 0 }];
  for (let i = 0; i < n; i++) {
    const x = 40 + (i % cols) * cw, y = head + 20 + Math.floor(i / cols) * ch;
    const t = await thumb(files[i], cw - 16, ch - 16, T.colors.light);
    layers.push({ input: await sharp(t).composite([{ input: roundRect(cw - 16, ch - 16, 24), blend: 'dest-in' }]).png().toBuffer(), left: x + 8, top: y + 8 });
  }
  await sharp({ create: { width: CW, height: CH, channels: 3, background: T.colors.bg } }).composite(layers).jpeg({ quality: 90 }).toFile(out);
}

async function included(n, T, out) {
  const rows = [
    `${n} high resolution PNG files`,
    '4500 x 5400 px · 300 DPI',
    'Transparent background',
    'Sublimation, DTF, shirts, sweatshirts, mugs, totes',
    'Instant download: PDF with Google Drive link',
    'Small business commercial use (500 items / design)',
  ].map((t, i) => `<text x="180" y="${620 + i * 150}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="76" fill="${T.colors.light}">✓ ${escapeXml(t)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}"><rect width="100%" height="100%" fill="${T.colors.bg}"/>
    <text x="180" y="300" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="150" fill="${T.colors.accent}">What's included</text>
    <text x="180" y="440" font-family="Georgia, 'Times New Roman', serif" font-size="90" fill="${T.colors.light}">${escapeXml(`${n} ${T.cover[0]} ${T.cover[1]}`)}</text>
    ${rows}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(out);
}

function seo(n, T) {
  const cfg = loadConfig();
  const title = T.title(n).slice(0, 140);
  const description = [
    T.intro(n),
    '',
    "WHAT'S INCLUDED",
    `- ${n} high resolution PNG files, 4500 x 5400 px, 300 DPI, transparent background`,
    '- All designs are shown in the listing photos',
    '',
    'HOW YOU GET THE FILES',
    '- Instant digital download: after purchase you receive a PDF with a Google Drive link.',
    '- Open the link on a computer and download the ZIP files.',
    '',
    'PERFECT FOR',
    '- Sublimation and DTF transfers, t-shirts, sweatshirts, hoodies, mugs, tote bags, stickers and print on demand.',
    '',
    'LICENSE',
    '- Personal use and small business commercial use: you may sell up to 500 physical items per design.',
    '- Reselling or sharing the digital files is not allowed.',
    '',
    'This is a digital product. No physical item will be shipped. Colors may vary slightly between screens and printers.',
  ].join('\n');
  return { title, tags: T.tags, description, price: Number(T.price || cfg.bundle_price || 119.99), price_fixed: true, currency: cfg.currency, quantity: Number(cfg.quantity || 999), who_made: 'i_did', is_supply: false, when_made: '2020_2026', type: 'download', materials: ['digital file', 'png'], primary_keyword: T.keyword, delivery: { mode: 'cloud' } };
}

/** Paketi hazırlar: tasarım seçimi, ZIP'ler, görseller, video, SEO; ürün "İnceleme" (Drive bekleniyor) */
async function prepare(key) {
  const T = themes()[key];
  if (!T) throw new Error(`Bilinmeyen paket teması: ${key}`);
  const files = pickDesigns(T);
  if (files.length < (T.min || 12)) throw new Error(`${key}: yeterli tasarım yok (${files.length})`);
  const n = files.length;
  const d = new Date();
  const id = `${d.toISOString().slice(0, 10).replace(/-/g, '')}-${key}-png-bundle-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(PATHS.output, id);
  for (const s of ['mockups', 'zips', 'designs']) fs.mkdirSync(path.join(dir, s), { recursive: true });
  log(`📦 Paket "${key}": ${n} tasarım seçildi — dosyalar hazırlanıyor`);
  // Tasarımlar (ürün klasöründe de dursun: ön izleme / kalite kontrol için)
  const names = files.map((f, i) => `${key}_${String(i + 1).padStart(2, '0')}.png`);
  files.forEach((f, i) => fs.copyFileSync(f, path.join(dir, 'designs', names[i])));
  // ZIP'ler (Drive'a gidecek): 10'arlı
  const { createZip } = require('./zip');
  const readme = path.join(dir, 'README_LICENSE.txt');
  fs.writeFileSync(readme, `${n} ${T.cover[0]} ${T.cover[1]}\n\nThank you for your purchase!\n\n- ${n} PNG files, 4500 x 5400 px, 300 DPI, transparent background\n- Personal use and small business commercial use (up to 500 physical items per design)\n- Reselling or sharing the digital files is not allowed.\n`);
  for (let z = 0; z * 10 < n; z++) {
    const part = names.slice(z * 10, z * 10 + 10);
    const zp = path.join(dir, 'zips', `${key}_part${z + 1}.zip`);
    await createZip(zp, [...part.map((nm) => ({ path: path.join(dir, 'designs', nm), name: nm })), { path: readme, name: 'README_LICENSE.txt' }]);
  }
  // Görseller
  const M = (f) => path.join(dir, 'mockups', f);
  await cover(files, T, M('01_cover.jpg'));
  try {
    const { modelCover } = require('../03_mockup_engine');
    const { readModelManifest } = require('./model_mockups');
    await modelCover(readModelManifest(), [files[0]], { niche: T.keyword, keyword: T.keyword, season: 'Christmas' }, M('02_model.jpg'));
  } catch (e) { log(`Paket modelli görsel atlandı: ${e.message}`, 'warn'); }
  const half = Math.ceil(n / 2);
  await sheet(files.slice(0, half), `${T.cover[0]} ${T.cover[1]}`, `Designs 1-${half} of ${n} · transparent PNG · 300 DPI`, T, M('03_designs_a.jpg'));
  if (n > half) await sheet(files.slice(half), `${T.cover[0]} ${T.cover[1]}`, `Designs ${half + 1}-${n} of ${n} · transparent PNG · 300 DPI`, T, M('04_designs_b.jpg'));
  await included(n, T, M('05_included.jpg'));
  try { await require('./mega_bundle').makeVideo(dir); } catch (e) { log(`Paket videosu atlandı: ${e.message}`, 'warn'); }
  const meta = seo(n, T);
  fs.writeFileSync(path.join(dir, 'seo_metadata.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'trend.json'), JSON.stringify({ keyword: T.keyword, niche: `${key} png bundle`, season: 'Christmas', mode: 'illustration', subjects: T.subjects || [], mega: true, bundle: true, seo_locked: true, total: n, drive_title: `${n} ${T.cover[0]} ${T.cover[1]}` }, null, 2));
  db.saveProduct({ id, niche: `${key} png bundle`, keyword: T.keyword, title: meta.title, tags: meta.tags, status: 'İnceleme', folder: dir, thumbnail: M('01_cover.jpg'), error: 'Drive linki bekleniyor' });
  log(`📦 Paket hazır: ${id} (${n} tasarım) — sırada Drive yüklemesi`, 'success');
  return { id, n };
}

/** Drive klasörü elle paylaşıldı → ürünü "Hazır" yap */
function markShared(id) {
  const p = db.getProduct(id);
  if (!p) throw new Error(`Ürün yok: ${id}`);
  const f = path.join(p.folder, 'drive.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.shared = true; j.shared_at = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
  db.updateProduct(id, { status: 'Hazır', error: null });
  log(`📦 Paket paylaşıldı, yüklemeye hazır: ${id}`, 'success');
}

module.exports = { prepare, markShared, pickDesigns, themes };
