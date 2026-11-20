'use strict';
/**
 * MODÜL 6 — Kalite ve Etsy Politika Kontrolü (QC)
 *
 * Etsy'ye yüklemeden önce üç katmanlı denetim yapar; sorun varsa ürün yüklenmez, "İnceleme" durumunda bekler.
 *  1) Teknik    : PNG boyut/DPI/şeffaflık, boş görsel, teslim dosyası boyut/sayı, ZIP bütünlüğü, görsel ve video sınırları
 *  2) Metin/IP  : marka-telif terimleri, yanıltıcı ifadeler, başlık/etiket kuralları, dijital ürün ve AI beyanı
 *  3) Yapay zekâ: GPT-4o mini (Replicate) her tasarıma ve vitrin görseline bakar: yazım hatası, tişört/mockup çizimi,
 *                 marka/logo, ünlü kişi, telifli karakter, uygunsuz içerik, bozuk/deforme çizim
 *
 * checkDesigns() tasarım üretiminin hemen ardından çalışır (hatalı tasarım otomatik yeniden üretilir).
 * runFinalQC()  yüklemeden hemen önce tüm paketi denetler ve qc_report.json yazar.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadConfig, log, fileSize, PATHS } = require('./lib/core');
const { replicateRun } = require('./lib/replicate');
const { describeError } = require('./lib/http');

/* Marka, telifli karakter ve ünlü adları (Etsy fikri mülkiyet şikâyetlerinin en sık sebepleri) */
const IP_TERMS = [
  'griswold', 'national lampoon', 'elf on the shelf', 'disney', 'marvel', 'pixar', 'mickey', 'minnie', 'grinch', 'stitch', 'lilo', 'harry potter', 'hogwarts', 'star wars', 'mandalorian',
  'baby yoda', 'pokemon', 'pikachu', 'nintendo', 'mario', 'zelda', 'barbie', 'taylor swift', 'swiftie', 'eras tour', 'beyonce',
  'nfl', 'nba', 'mlb', 'nhl', 'ncaa', 'super bowl', 'starbucks', 'stanley cup', 'stanley tumbler', 'nike', 'adidas', 'chanel',
  'gucci', 'louis vuitton', 'lv ', 'coca cola', 'pepsi', 'peanuts', 'snoopy', 'charlie brown', 'bluey', 'sanrio', 'hello kitty',
  'looney', 'bugs bunny', 'scooby', 'friends tv', 'yellowstone', 'beetlejuice', 'jack skellington', 'nightmare before', 'hocus pocus',
  'sanderson', 'stranger things', 'squid game', 'wednesday addams', 'addams family', 'spongebob', 'paw patrol', 'cocomelon',
  'sesame street', 'muppet', 'garfield', 'simpsons', 'family guy', 'rick and morty', 'dragon ball', 'naruto', 'one piece',
  'hallmark', 'grateful dead', 'rolling stones', 'beatles', 'elvis', 'marilyn', 'trump', 'biden', 'harris', 'kanye', 'drake',
  'olympic', 'fifa', 'world cup', 'jeep', 'harley', 'ford', 'chevy', 'john deere', 'mcdonald', 'yeti', 'crocs', 'lego', 'hot wheels',
  'care bears', 'smurf', 'shrek', 'minion', 'frozen', 'elsa', 'moana', 'encanto', 'toy story', 'cars movie', 'lightning mcqueen',
  'bad bunny', 'labubu', 'pop mart', 'sonic', 'kirby', 'minecraft', 'fortnite', 'roblox', 'among us', 'deadpool', 'spiderman', 'spider-man',
  'batman', 'superman', 'wonder woman', 'joker', 'harley quinn', 'avengers', 'hulk', 'thor', 'iron man', 'captain america', 'tinkerbell',
];
/* Etsy'nin yasakladığı/riskli içerik ve yanıltıcı satış ifadeleri */
const POLICY_TERMS = ['nazi', 'swastika', 'kkk', 'white power', 'porn', 'nsfw', 'nude', 'naked', 'cocaine', 'terror', 'suicide', 'ak47', 'ar15'];
/* Etsy'de yasak değil ama dikkat isteyen (uyarı) terimler */
const SENSITIVE_TERMS = ['confederate', 'sexy', 'drug', 'weed', 'marijuana', 'cannabis', 'gun', 'rifle', 'ammo', 'kill', 'blood', 'gore'];
const MISLEADING_TERMS = ['best seller', 'bestseller', '#1', 'number one', 'official', 'licensed', 'authentic', 'free shipping', 'etsy', 'guaranteed sales'];

const wordHit = (text, term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text);

/* ------------------------------------------------------------------ */
/* 1) TEKNİK KONTROLLER                                                */
/* ------------------------------------------------------------------ */
async function designTech(pngPath, cfg, trend = null) {
  const issues = [];
  const m = await sharp(pngPath).metadata();
  if (m.width !== cfg.output_width || m.height !== cfg.output_height) issues.push(`Boyut ${m.width}x${m.height} (beklenen ${cfg.output_width}x${cfg.output_height})`);
  if (Math.round(m.density || 0) !== cfg.dpi) issues.push(`DPI ${m.density} (beklenen ${cfg.dpi})`);
  if (!m.hasAlpha) issues.push('Şeffaflık kanalı yok');
  const { data, info } = await sharp(pngPath).ensureAlpha().extractChannel(3).resize(300, 360, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (const v of data) if (v > 16) opaque++;
  const cover = opaque / (info.width * info.height);
  if (cover < 0.03) issues.push('Tasarım neredeyse boş (görünür içerik %3 altında)');
  if (cover > 0.97) issues.push('Arka plan silinmemiş görünüyor (görsel tamamen dolu)');
  const corners = [0, info.width - 1, (info.height - 1) * info.width, info.height * info.width - 1];
  if (corners.filter((i) => data[i] > 16).length >= 3) issues.push('Köşeler opak: arka plan tam silinmemiş olabilir');
  const pr = await printReadiness(pngPath).catch(() => null);
  const warnings = [];
  // Resimli (yazısız) tasarımlarda yumuşak fırça dokusu ve kar gibi beyaz detaylar normaldir → bu uyarılar uygulanmaz
  if (pr && cfg.qc_print_checks !== false && !(trend && trend.mode === 'illustration')) {
    if (pr.inkThick < 0.65) warnings.push('İnce yazı/çizgi: baskıda (özellikle koyu tişörtte) zayıf ve okunaksız görünebilir');
    if (pr.edgeLight > 0.5) warnings.push('Tasarımın etrafında beyaz kenar/çıkartma zemini var: beyaz tişörtte kaybolur, koyu tişörtte beyaz leke yapar');
  }
  return { file: path.basename(pngPath), cover: Math.round(cover * 100), issues, warnings, print: pr };
}

/** Baskıya uygunluk (ücretsiz, yerel): renkli mürekkep kalınlığı ve beyaz kenar oranı. */
async function printReadiness(pngPath) {
  const W = 900, H = 1080, N = W * H;
  const { data } = await sharp(pngPath).ensureAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const A = new Uint8Array(N), C = new Uint8Array(N);
  let cn = 0;
  for (let i = 0; i < N; i++) {
    A[i] = data[i * 4 + 3] > 128 ? 1 : 0;
    if (A[i] && Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) < 190) { C[i] = 1; cn++; }
  }
  // 1 piksellik erozyondan (≈1.7 mm baskıda) sağ kalan renkli mürekkep oranı
  let cs = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (C[i] && C[i - 1] && C[i + 1] && C[i - W] && C[i + W] && C[i - W - 1] && C[i - W + 1] && C[i + W - 1] && C[i + W + 1]) cs++;
  }
  let bnd = 0, bl = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!A[i]) continue;
    if (!A[i - 1] || !A[i + 1] || !A[i - W] || !A[i + W]) { bnd++; if (Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) > 215) bl++; }
  }
  return { inkThick: Math.round((cs / Math.max(1, cn)) * 100) / 100, edgeLight: Math.round((bl / Math.max(1, bnd)) * 100) / 100 };
}

async function packageTech(dir, cfg) {
  const issues = [];
  const warnings = [];
  const mdir = path.join(dir, 'mockups');
  const imgs = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
  if (imgs.length < 2) issues.push(`Listeleme görseli yetersiz (${imgs.length})`);
  if (imgs.length > 20) issues.push('Etsy en fazla 20 görsel kabul eder');
  for (const f of imgs) {
    const m = await sharp(path.join(mdir, f)).metadata();
    if (m.width < 2000) warnings.push(`${f}: genişlik ${m.width}px (Etsy en az 2000px önerir)`);
    if (fileSize(path.join(mdir, f)) > 20 * 1048576) issues.push(`${f}: 20 MB üstü`);
  }
  const video = path.join(dir, 'listing_video.mp4');
  if (fs.existsSync(video) && fileSize(video) > 100 * 1048576) issues.push('Video 100 MB üstü');
  const deliv = fs.readdirSync(dir).filter((f) => /^(deliverable(_part\d+)?\.zip|Download_Instructions\.pdf)$/.test(f));
  const upload = deliv.includes('Download_Instructions.pdf') ? ['Download_Instructions.pdf']
    : deliv.filter((f) => /_part\d+\.zip$/.test(f)).length ? deliv.filter((f) => /_part\d+\.zip$/.test(f)) : deliv.filter((f) => f === 'deliverable.zip');
  if (!upload.length) issues.push('Teslim dosyası yok');
  if (upload.length > 5) issues.push('Etsy en fazla 5 dijital dosya kabul eder');
  for (const f of upload) {
    const p = path.join(dir, f);
    if (fileSize(p) > 20 * 1048576) issues.push(`${f}: Etsy'nin 20 MB dosya sınırını aşıyor`);
    if (f.endsWith('.zip')) {
      const buf = fs.readFileSync(p);
      const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (eocd < 0 || buf.readUInt16LE(eocd + 10) < 1) issues.push(`${f}: ZIP bozuk ya da boş`);
    }
  }
  return { images: imgs.length, deliverables: upload, issues, warnings };
}

/* ------------------------------------------------------------------ */
/* 2) METİN / POLİTİKA KONTROLLERİ                                     */
/* ------------------------------------------------------------------ */
function textChecks(meta, trend, cfg) {
  const issues = [];
  const warnings = [];
  const all = `${meta.title}\n${meta.tags.join('\n')}\n${meta.description}\n${trend.keyword}`.toLowerCase();
  try { for (const pr of require('./04_seo_engine').validateSeo(meta, trend)) issues.push(`Başlık/etiket: ${pr}`); } catch { /* denetim yüklenemedi */ }
  const extra = (cfg.blocked_terms || []).map((t) => t.toLowerCase());
  for (const t of [...new Set([...IP_TERMS, ...extra])]) if (wordHit(all, t)) issues.push(`Marka/telif riski: "${t}"`);
  for (const t of POLICY_TERMS) if (wordHit(all, t)) issues.push(`Etsy politika riski (yasaklı içerik): "${t}"`);
  for (const t of SENSITIVE_TERMS) if (wordHit(all, t)) warnings.push(`Hassas terim, gözden geçirin: "${t}"`);
  const sales = `${meta.title}\n${meta.tags.join('\n')}`.toLowerCase();
  for (const t of MISLEADING_TERMS) if (sales.includes(t)) issues.push(`Yanıltıcı/izin verilmeyen ifade başlık veya etikette: "${t}"`);
  if (meta.title.length > 140) issues.push('Başlık 140 karakteri aşıyor');
  if (meta.title === meta.title.toUpperCase()) issues.push('Başlık tamamen büyük harf (Etsy önermez)');
  if (meta.tags.length !== 13) warnings.push(`Etiket sayısı ${meta.tags.length}/13`);
  for (const t of meta.tags) if (t.length > 20) issues.push(`Etiket 20 karakteri aşıyor: "${t}"`);
  if (!/DIGITAL DOWNLOAD|NO PHYSICAL/i.test(meta.description)) issues.push('Açıklamada "dijital ürün, kargo yok" uyarısı yok');
  if (cfg.ai_disclosure && !/AI/i.test(meta.description)) warnings.push('Açıklamada AI kullanım beyanı yok');
  if (!/Mockups are for display/i.test(meta.description)) warnings.push('Mockup\'ların sadece gösterim amaçlı olduğu belirtilmemiş');
  const words = meta.title.split(/\s+/).length;
  if (words > 22) warnings.push(`Başlık ${words} kelime: Etsy kısa ve okunur başlıkları öne çıkarıyor`);
  return { issues, warnings };
}

/* ------------------------------------------------------------------ */
/* 3) YAPAY ZEKÂ GÖRSEL DENETİMİ                                        */
/* ------------------------------------------------------------------ */
async function toDataUri(p, width = 640, background = '#ffffff') {
  const buf = await sharp(p).flatten({ background }).resize(width, width, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function parseJson(output) {
  const text = Array.isArray(output) ? output.join('') : String(output || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Denetim modeli JSON döndürmedi: ${text.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

const DESIGN_SYSTEM = `You are a strict Etsy marketplace compliance and print-quality reviewer for DIGITAL t-shirt design PNG files.
Review each image independently and answer ONLY with JSON:
{"images":[{"index":1,"text_found":"exact text you can read or empty","spelling_ok":true,"is_flat_artwork":true,
"shows_clothing_or_mockup":false,"brand_logo_or_trademark":false,"real_person_or_celebrity":false,"copyrighted_character":false,
"offensive_or_adult":false,"deformed_or_garbled":false,"missing_fill":false,"print_quality_ok":true,"pass":true,"reason":"short reason in Turkish"}]}
The images are shown on a flat MEDIUM GRAY background: every gray area is TRANSPARENT in the real PNG.
missing_fill=true if parts that should be solid show the gray background through them: a character's face, skin, hands, eyes,
white clothing, white fills of objects or shapes look cut out / hollow / see-through (cut-out holes inside the artwork). Small
counters inside letters (O, A, e) being gray is normal.
Rules: shows_clothing_or_mockup=true if the artwork is drawn ON or INSIDE any physical product or object instead of being standalone: t-shirt, hoodie, garment, hanger, mannequin, PICTURE FRAME, framed print, poster on a wall, canvas, paper sheet with a visible edge/border, mug, tumbler, tote bag, pillow, phone case, sign board, or any product photo (the file must be the standalone artwork only).
spelling_ok=false if any word is misspelled, cut off, or contains nonsense letters. deformed_or_garbled=true for mangled anatomy, melted shapes or random glyphs.
Text is OPTIONAL: never fail a design because its text differs from the theme/keyword or omits some words; only real misspellings,
cut-off words or nonsense letters count (spelling_ok=false). is_flat_artwork=true means it is a standalone graphic (this is GOOD).
pass=false only if a problem flag (shows_clothing_or_mockup, brand_logo_or_trademark, real_person_or_celebrity, copyrighted_character,
offensive_or_adult, deformed_or_garbled, missing_fill) is true, or spelling_ok/print_quality_ok is false.`;

async function visionDesigns(pngs, trend, cfg, costs) {
  const images = [];
  for (const p of pngs) images.push(await toDataUri(p, 640, '#7f7f7f')); // gri zemin = şeffaf alanlar görünür
  const expected = (trend && trend.niche) ? `The intended theme is "${trend.niche}" (for context only; designs do not need to contain these words).` : '';
  const out = await replicateRun(cfg.qc_vision_model || 'openai/gpt-4o-mini', {
    system_prompt: DESIGN_SYSTEM,
    prompt: `Review these ${pngs.length} images in order (index 1..${pngs.length}). ${expected}`,
    image_input: images,
    temperature: 0,
    max_completion_tokens: 1500,
  }, { raw: true });
  costs.push(cfg.costs.qc_vision || 0.002);
  const res = parseJson(out);
  const list = res.images || [];
  // Model numaralandırmayı bazen karıştırıyor: adet eşleşiyorsa sıraya göre eşle
  const byOrder = list.length === pngs.length;
  return list.map((r, i) => {
    const idx = byOrder ? i + 1 : Math.min(Math.max(Number(r.index) || i + 1, 1), pngs.length);
    const flags = ['shows_clothing_or_mockup', 'brand_logo_or_trademark', 'real_person_or_celebrity', 'copyrighted_character',
      'offensive_or_adult', 'deformed_or_garbled', 'missing_fill'];
    const bad = flags.filter((f) => r[f] === true);
    if (r.spelling_ok === false) bad.push('spelling');
    if (r.print_quality_ok === false) bad.push('print_quality');
    return { ...r, model_pass: r.pass, pass: bad.length === 0, failed_flags: bad, index: idx, file: path.basename(pngs[idx - 1] || '') };
  });
}

const MOCKUP_SYSTEM = `You review the MAIN listing photo of an Etsy DIGITAL download product: PNG designs that buyers print themselves.
Showing the design on a t-shirt/sweatshirt/mug mockup is the normal, allowed Etsy practice for this product type; a badge such as
"INSTANT DOWNLOAD | 300 DPI PNG" or a digital-download note is the required disclosure.
Answer ONLY with JSON: {"design_visible":true,"has_digital_download_badge":true,"brand_logo_or_trademark":false,"real_person":false,
"offensive_or_adult":false,"text_errors":"","garment_inside_design":false,"reason":"short reason in Turkish"}.
garment_inside_design=true if the printed artwork itself contains a picture of a product or object such as a shirt, a picture frame, a framed poster, a canvas, a mug or a paper sheet (e.g. a shirt printed on a shirt, a framed poster printed on a shirt).
text_errors: list misspelled words visible in the artwork, or empty string.`;

async function visionMockup(mainImage, cfg, costs) {
  const out = await replicateRun(cfg.qc_vision_model || 'openai/gpt-4o-mini', {
    system_prompt: MOCKUP_SYSTEM,
    prompt: 'Review this main listing photo.',
    image_input: [await toDataUri(mainImage, 900)],
    temperature: 0,
    max_completion_tokens: 400,
  }, { raw: true });
  costs.push(cfg.costs.qc_vision || 0.002);
  return parseJson(out);
}

/* ------------------------------------------------------------------ */
/* Dış API                                                             */
/* ------------------------------------------------------------------ */

/** Tasarım üretiminden hemen sonra: başarısız tasarımların indekslerini (0 tabanlı) ve raporu döndürür. */
/* ---------- Tekrar eden tasarım kontrolü (aynı paket içinde ve daha önceki ürünlerle) ---------- */
async function designHash(png) {
  const g = await sharp(png).flatten({ background: '#ffffff' }).greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer();
  const v = await sharp(png).flatten({ background: '#ffffff' }).greyscale().resize(16, 17, { fit: 'fill' }).raw().toBuffer();
  let h = '';
  for (let r = 0; r < 16; r++) for (let x = 0; x < 16; x++) h += g[r * 17 + x] > g[r * 17 + x + 1] ? '1' : '0';
  for (let r = 0; r < 16; r++) for (let x = 0; x < 16; x++) h += v[r * 16 + x] > v[(r + 1) * 16 + x] ? '1' : '0';
  return h;
}
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
const HASH_DB = () => path.join(PATHS.data, 'design_hashes.json');
function readHashDb() { try { return JSON.parse(fs.readFileSync(HASH_DB(), 'utf8')); } catch { return []; } }
/** Aynı pakette birbirinin aynısı tasarım → hata; daha önce satılan bir ürünle aynı tasarım → uyarı */
async function duplicateChecks(pngs, report) {
  const hashes = [];
  for (const p of pngs) hashes.push(await designHash(p).catch(() => null));
  const productDir = path.dirname(path.dirname(pngs[0] || ''));
  const isTmp = /[\\/]_regen_\d+$/.test(productDir) || path.basename(productDir).startsWith('_regen_');
  const parent = isTmp ? path.dirname(productDir) : productDir;
  const prior = readHashDb().filter((e) => e.dir !== productDir && e.dir !== parent);
  hashes.forEach((h, i) => {
    if (!h) return;
    for (let j = 0; j < i; j++) if (hashes[j] && hamming(h, hashes[j]) < 40) report[i].issues.push(`Tasarım ${j + 1} ile aynı (tekrar eden tasarım)`);
    const twin = prior.find((e) => hamming(h, e.h) < 40);
    if (twin) report[i].warnings.push(`Daha önceki bir üründeki tasarımla neredeyse aynı (${twin.product})`);
  });
  // kaydet (aynı ürünün eski kayıtlarını değiştir); geçici yeniden çizim klasörü kaydedilmez
  if (isTmp) return;
  try {
    const keep = readHashDb().filter((e) => e.dir !== productDir);
    hashes.forEach((h, i) => { if (h) keep.push({ dir: productDir, product: path.basename(productDir), file: path.basename(pngs[i]), h }); });
    fs.writeFileSync(HASH_DB(), JSON.stringify(keep.slice(-2000)));
  } catch { /* yok say */ }
}

async function checkDesigns(pngs, trend, { costs = [], dryRun = false, labels = null } = {}) {
  const cfg = loadConfig();
  const report = [];
  for (const p of pngs) report.push({ ...(await designTech(p, cfg, trend)), vision: null });
  await duplicateChecks(pngs, report).catch((e) => log(`Tekrar kontrolü yapılamadı: ${e.message}`, 'warn'));
  if (cfg.qc_enabled !== false && cfg.qc_vision !== false && !dryRun && process.env.REPLICATE_API_TOKEN) {
    try {
      log('Kalite kontrol: tasarımlar yapay zekâ ile inceleniyor...');
      const v = await visionDesigns(pngs, trend, cfg, costs);
      v.forEach((r) => { const i = (r.index || 1) - 1; if (report[i]) report[i].vision = r; });
    } catch (e) {
      log(`Yapay zekâ görsel denetimi yapılamadı (${describeError(e).slice(0, 100)}); teknik kontrolle devam`, 'warn');
    }
  }
  report.forEach((r, i) => { for (const w of r.warnings || []) log(`Baskı kontrolü ⚠ Tasarım ${labels ? labels[i] : i + 1}: ${w}`, 'warn'); });
  const failed = [];
  report.forEach((r, i) => {
    const vFail = r.vision && r.vision.pass === false;
    if (r.issues.length || vFail) {
      failed.push(i);
      log(`Kalite kontrol ✗ Tasarım ${labels ? labels[i] : i + 1}: ${[...r.issues, vFail ? (r.vision.reason || 'görsel denetim başarısız') : ''].filter(Boolean).join('; ')}`, 'warn');
    }
  });
  if (!failed.length) log(`Kalite kontrol ✓ ${pngs.length} tasarımın hepsi geçti`, 'success');
  return { failed, report };
}

/** Yüklemeden hemen önce tüm paket denetimi → qc_report.json; { pass, issues, warnings } */
async function runFinalQC({ dir, meta, trend, designReport, dryRun = false, costs = [] }) {
  const cfg = loadConfig();
  const tech = await packageTech(dir, cfg);
  const text = textChecks(meta, trend, cfg);
  const issues = [...tech.issues, ...text.issues];
  const warnings = [...tech.warnings, ...text.warnings];
  for (const d of designReport || []) {
    for (const i of d.issues) issues.push(`${d.file}: ${i}`);
    for (const w of d.warnings || []) issues.push(`${d.file}: ${w}`);
    if (d.vision && d.vision.pass === false) issues.push(`${d.file}: ${d.vision.reason || 'görsel denetim başarısız'}`);
  }
  let mockup = null;
  const main = path.join(dir, 'mockups', '01_main_mockup.jpg');
  if (cfg.qc_enabled !== false && cfg.qc_vision !== false && !dryRun && !process.env.QC_SKIP_VISION && process.env.REPLICATE_API_TOKEN && fs.existsSync(main)) {
    try {
      mockup = await visionMockup(main, cfg, costs);
      const hard = [];
      if (mockup.brand_logo_or_trademark) hard.push('marka/logo görünüyor');
      if (mockup.real_person) hard.push('gerçek kişi görünüyor');
      if (mockup.offensive_or_adult) hard.push('uygunsuz içerik');
      if (mockup.garment_inside_design) {
        // Vitrindeki tişört mockup'ın kendisidir; model bunu sık sık "tasarımda tişört var" diye işaretliyor.
        // Ana tasarım tek başına incelenip temiz bulunduysa bunu yalnızca uyarı say.
        const first = (designReport || [])[0];
        const firstClean = first && first.vision && first.vision.pass !== false && first.vision.shows_clothing_or_mockup === false;
        if (firstClean) { mockup.garment_inside_design = false; mockup.garment_note = mockup.reason; warnings.push('Vitrin denetimi tasarımda ürün resmi gördüğünü söyledi, ama tasarımın kendisi temiz çıktı — gözle bakın'); }
        else hard.push('tasarımın içinde ürün resmi var (tişört/çerçeve/poster)');
      }
      if (mockup.text_errors && String(mockup.text_errors).trim()) hard.push(`yazım hatası: ${mockup.text_errors}`);
      if (hard.length) issues.push(`Vitrin görseli: ${hard.join(', ')}`);
      if (mockup.design_visible === false) warnings.push('Vitrin görselinde tasarım net görünmüyor');
      if (mockup.has_digital_download_badge === false) warnings.push('Vitrin görselinde "dijital indirme" ibaresi seçilemedi');
      mockup.pass = hard.length === 0;
    } catch (e) {
      warnings.push(`Vitrin görseli yapay zekâ denetimi yapılamadı: ${describeError(e).slice(0, 80)}`);
    }
  }
  const report = { checked_at: new Date().toISOString(), pass: issues.length === 0, issues, warnings, designs: designReport || [], mockup, package: tech };
  fs.writeFileSync(path.join(dir, 'qc_report.json'), JSON.stringify(report, null, 2));
  if (report.pass) log(`Kalite kontrol ✓ Paket Etsy'ye hazır${warnings.length ? ` (${warnings.length} uyarı)` : ''}`, 'success');
  else log(`Kalite kontrol ✗ ${issues.length} sorun bulundu — ürün yüklenmedi, panelde "İnceleme" durumunda`, 'warn');
  return report;
}

function readReport(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'qc_report.json'), 'utf8')); } catch { return null; }
}

module.exports = { checkDesigns, runFinalQC, readReport, textChecks, IP_TERMS };
