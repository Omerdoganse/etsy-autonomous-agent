'use strict';
/**
 * MODÜL 2 — Dijital Ürün ve Tasarım Üreticisi
 * Konsept → prompt → görsel (Replicate Flux/Recraft veya OpenAI) → (ops. AI upscale) → şeffaf arka plan
 * (Replicate bria / yerel rembg / yerleşik beyaz-zemin silici) → 4500x5400 @300 DPI PNG → teslim paketi
 * (≤19 MB ZIP; büyükse bulut + Download_Instructions.pdf, bulut yoksa çok parçalı ZIP).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
const { loadConfig, log, logError, retry, checkStop, slugify, titleCase, escapeXml, fileSize, PATHS, sleep } = require('./lib/core');
const { http, download, describeError } = require('./lib/http');
const { createZip } = require('./lib/zip');
const { replicateRun } = require('./lib/replicate');
const storage = require('./lib/storage');

// Not: eski sonek "t-shirt design graphic" idi; modeller bunu görünce grafiği tişört fotoğrafının içine çiziyordu
// (müşteriye "tişört resmi" gidiyordu). Bu yüzden kıyafet kelimesi geçmeyen, düz baskı grafiği isteyen ifade kullanılıyor.
const PROMPT_SUFFIX = 'isolated on a solid pure white background, vector style graphic, clean edges, no mockup, no drop shadow, standalone print-ready artwork with no sticker border, no white outline and no background shape behind it, the artwork itself fills the canvas, nothing else in the image';

/* ===================== Konseptler ===================== */
function templateConcepts(trend, n, cfg = {}) {
  const subject = trend.niche;
  if (textWeak(cfg)) {
    // Flux Schnell yazıyı bozuyor → yazısız, güçlü illüstrasyon konseptleri
    return [
      `a bold centered illustration of ${subject}, ${trend.style}`,
      `a circular vintage badge emblem illustration about ${subject} with decorative border, ${trend.style}`,
      `a cute character illustration celebrating ${subject}, ${trend.style}`,
      `a symmetrical decorative composition of ${subject} elements and small icons, ${trend.style}`,
      `a retro sunset scene themed around ${subject}, ${trend.style}`,
    ].slice(0, n);
  }
  try {
    // Her üründe farklı yerleşim/yazı/palet → mağazada birbirinin aynı tasarımlar olmasın
    const { pickConcepts, conceptSentence } = require('./lib/design_variety');
    return pickConcepts(subject, n).map(conceptSentence);
  } catch { /* yedek: sabit şablonlar */ }
  const base = [
    `a bold centered "${titleCase(subject)}" typography design with a matching illustration, ${trend.style}`,
    `a circular vintage badge emblem about ${subject} with banner text, ${trend.style}`,
    `a cute character illustration celebrating ${subject} with short catchy text, ${trend.style}`,
    `a stacked word-art quote design about ${subject} with small decorative icons, ${trend.style}`,
    `a retro sunset scene themed around ${subject} with arched lettering, ${trend.style}`,
  ];
  return base.slice(0, n);
}

async function aiConcepts(trend, n, cfg, costs) {
  if (!process.env.OPENAI_API_KEY) return null;
  const sys = (textWeak(cfg) ? 'Designs must contain NO text at all (illustration only). ' : '') + 'You are a senior print-on-demand designer. Return JSON: {"concepts":[{"name":string,"prompt":string,"text_on_design":string}]}. '
    + 'Each prompt is one vivid sentence describing a single standalone flat print graphic (subject, composition, typography, palette); never mention shirts, clothing or mockups. '
    + 'Never use trademarks, brands, celebrities or copyrighted characters. Short text only (max 5 words), spelled correctly.';
  const user = `Niche keyword: "${trend.keyword}". Season: ${trend.season}. Audience: ${trend.audience}. Visual style: ${trend.style}. `
    + `Create ${n} distinct but cohesive designs for one bundle.`;
  const res = await http.post('https://api.openai.com/v1/chat/completions', {
    model: cfg.openai_text_model,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.9,
  }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 60000 });
  costs.push(cfg.costs.openai_text);
  const parsed = JSON.parse(res.data.choices[0].message.content);
  const list = (parsed.concepts || []).filter((c) => c && c.prompt).slice(0, n);
  return list.length === n ? list.map((c) => (c.text_on_design && !textWeak(cfg)) ? `${c.prompt} The design reads "${c.text_on_design}".` : c.prompt) : null;
}

/** Yazı üretiminde zayıf modeller (Flux Schnell) için tasarımlar yazısız üretilir. */
function textWeak(cfg) {
  return cfg && cfg.image_provider !== 'openai' && /flux-schnell/.test(cfg.replicate_model || '');
}

const GARMENT_WORDS = /\b(t-?shirts?|tee-?shirts?|tees?|shirts?|tshirts?|hoodies?|sweatshirts?|sweaters?|jerseys?|tank tops?|apparel|clothing|onesies?|mockups?|pictures?|photos?|photographs?|posters?|frames?|framed|wall art|canvas(es)?|mugs?|tumblers?|cups?|phone cases?|tote bags?|pillows?|stickers? sheets?)\b/gi;
/** Konsept/niş metninden kıyafet kelimelerini çıkarır (modelin tişört çizmesini tetikliyorlar). */
function stripGarments(text) {
  // Tırnak içindeki tasarım metnine dokunma (ör. "Family Christmas Pajamas")
  return String(text).split(/("[^"]*")/).map((part) => (part.startsWith('"') ? part : part.replace(GARMENT_WORDS, '')))
    .join('').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

function buildPrompt(concept, cfg) {
  concept = stripGarments(concept);
  const noText = textWeak(cfg) ? ', no text, no letters, no words, no typography' : '';
  // Modeller "t-shirt design" görünce bazen tişört fotoğrafı çiziyor → yalnızca düz baskı grafiği iste
  const flat = ', flat 2D graphic only, not printed on anything, no garment, no fabric, no picture frame, no poster, no paper sheet, no wall, no product photo';
  return `${concept.replace(/[.\s]+$/, '')}${noText}${flat}, ${PROMPT_SUFFIX}`;
}

/* ===================== Görsel üretim ===================== */
async function generateImage(prompt, cfg, costs) {
  if (cfg.image_provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY .env içinde tanımlı değil'), { noRetry: true });
    const res = await http.post('https://api.openai.com/v1/images/generations', {
      model: cfg.openai_image_model, prompt, size: '1024x1536', quality: 'high', background: 'transparent', output_format: 'png', n: 1,
    }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 180000 });
    costs.push(cfg.costs.openai_image);
    const item = res.data.data[0];
    const buffer = item.b64_json ? Buffer.from(item.b64_json, 'base64') : await download(item.url);
    return { buffer, url: item.url || null, transparent: true };
  }
  const model = cfg.replicate_model;
  const input = /recraft/.test(model)
    ? { prompt, size: '1024x1280', style: 'digital_illustration' }
    : { prompt, aspect_ratio: '4:5', output_format: 'png', num_outputs: 1, megapixels: '1', go_fast: true };
  const url = await replicateRun(model, input, cfg);
  costs.push(/recraft/.test(model) ? cfg.costs.replicate_recraft_v3 : cfg.costs.replicate_flux_schnell);
  return { buffer: await download(url), url, transparent: false };
}

/* ===================== Arka plan silme ===================== */
/** Yerleşik: kenarlardan flood-fill ile beyaz zemini siler, kenar piksellerini yumuşatır (iç beyazlar korunur). */
async function localRemoveWhite(buffer, tolerance = 22) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const N = w * h;
  const minc = new Uint8Array(N);
  for (let i = 0; i < N; i++) minc[i] = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const thr = 255 - tolerance;
  const bg = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const push = (i) => { if (!bg[i] && minc[i] >= thr) { bg[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < N - w) push(i + w);
  }
  for (let i = 0; i < N; i++) {
    if (bg[i]) { data[i * 4 + 3] = 0; continue; }
    const x = i % w;
    const nearBg = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (i >= w && bg[i - w]) || (i < N - w && bg[i + w]);
    if (nearBg && minc[i] > 150) {
      // anti-alias kenar: beyaza yakınlık oranında saydamlık, rengi beyazdan arındır
      const a = Math.max(0, Math.min(1, (255 - minc[i]) / (255 - 150)));
      data[i * 4 + 3] = Math.round(255 * a);
      for (let c = 0; c < 3; c++) {
        const v = data[i * 4 + c];
        data[i * 4 + c] = a > 0.02 ? Math.max(0, Math.min(255, Math.round((v - 255 * (1 - a)) / a))) : v;
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

async function removeBackground(img, cfg, costs) {
  if (img.transparent) return img.buffer;
  const mode = cfg.bg_removal;
  if (mode === 'replicate' && img.url && process.env.REPLICATE_API_TOKEN) {
    try {
      const out = await replicateRun(cfg.replicate_bg_model, { image: img.url }, cfg);
      costs.push(cfg.costs.replicate_bg_removal);
      return await download(out);
    } catch (e) {
      log(`Replicate arka plan silme başarısız (${describeError(e).slice(0, 80)}), yerleşik silici kullanılıyor`, 'warn');
    }
  }
  if (mode === 'rembg') {
    const tmpIn = path.join(PATHS.output, `.rembg_in_${process.pid}.png`);
    const tmpOut = path.join(PATHS.output, `.rembg_out_${process.pid}.png`);
    fs.writeFileSync(tmpIn, img.buffer);
    const r = spawnSync('rembg', ['i', tmpIn, tmpOut], { encoding: 'utf8', shell: process.platform === 'win32' });
    try {
      if (r.status === 0 && fs.existsSync(tmpOut)) return fs.readFileSync(tmpOut);
      log('rembg çalıştırılamadı (pip install "rembg[cli]"), yerleşik silici kullanılıyor', 'warn');
    } finally { for (const f of [tmpIn, tmpOut]) if (fs.existsSync(f)) fs.unlinkSync(f); }
  }
  return localRemoveWhite(img.buffer);
}

/* ===================== Yapay zekâ ile büyütme (Real-ESRGAN, yerel ve ücretsiz) ===================== */
const ESRGAN_DIR = () => path.join(PATHS.root, 'tools', 'realesrgan');
const ESRGAN_EXE = () => path.join(ESRGAN_DIR(), process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan');
/**
 * Küçük kaynak görseli (ör. Gemini 687x1024) 4 kat büyütür; detayları yeniden oluşturur → baskıda net.
 * Araç yoksa ya da hata verirse null döner (eski yöntemle devam edilir).
 */
async function aiUpscale(buffer, mode = 'text') {
  const cfg = loadConfig();
  if (cfg.local_upscale === false) return null; // ücretsiz yerel büyütücü (ai_upscale = ücretli Replicate seçeneği, ayrı)
  const meta = await sharp(buffer).metadata();
  if (Math.max(meta.width, meta.height) >= 2400) return null; // zaten yeterince büyük
  if (!fs.existsSync(ESRGAN_EXE())) { log('Yapay zekâ büyütücü bulunamadı (tools/realesrgan) — normal büyütmeyle devam', 'warn'); return null; }
  const tmpIn = path.join(PATHS.output, `.esr_in_${process.pid}_${Date.now()}.png`);
  const tmpOut = tmpIn.replace('_in_', '_out_');
  fs.mkdirSync(PATHS.output, { recursive: true });
  fs.writeFileSync(tmpIn, await sharp(buffer).png().toBuffer());
  const model = mode === 'illustration' ? 'realesrgan-x4plus' : 'realesrgan-x4plus-anime';
  const t0 = Date.now();
  try {
    const { execFile } = require('child_process');
    const r = await new Promise((resolve) => {
      execFile(ESRGAN_EXE(), ['-i', tmpIn, '-o', tmpOut, '-n', model, '-s', '4', '-f', 'png'],
        { cwd: ESRGAN_DIR(), timeout: 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}${stderr || ''}` }));
    });
    if (r.err || !fs.existsSync(tmpOut)) {
      log(`Yapay zekâ büyütme çalışmadı (${String((r.err && r.err.message) || r.out).replace(/\s+/g, ' ').slice(-120)}) — normal büyütmeyle devam`, 'warn');
      return null;
    }
    let out = fs.readFileSync(tmpOut);
    let m2 = await sharp(out).metadata();
    if (Math.max(m2.width, m2.height) > 5400) { // işlem süresi/bellek için makul üst sınır (çıktı zaten 4500x5400)
      out = await sharp(out).resize(5400, 5400, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
      m2 = await sharp(out).metadata();
    }
    log(`Yapay zekâ ile büyütüldü: ${meta.width}x${meta.height} → ${m2.width}x${m2.height} (${((Date.now() - t0) / 1000).toFixed(0)} sn)`);
    return { buffer: out, width: m2.width, height: m2.height };
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch { /* yok say */ } }
  }
}

/* ===================== Renkli düz zemin silici (resimli/yazısız tasarımlar) ===================== */
/**
 * Gemini'den düz renkli (ör. magenta) zemin üzerinde gelen çizimin zeminini siler.
 * Beyaz kar/ışık detayları korunur; yumuşak kenarlar renk mesafesine göre yarı saydam olur ve zemin rengi kenarlardan arındırılır.
 * Zemin rengi beyaz/griye yakınsa null döner (beyaz silici kullanılmalı).
 */
/**
 * Pembe (magenta) zemin artığı temizliği: yaprak/sap aralarında kalan kapalı pembe cepler ve pembe kenar sızıntısı.
 * Sadece parlak magenta (#FF00FF civarı) hedeflenir; normal pembe/mor tonlara dokunmaz.
 */
async function killMagenta(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let removed = 0, softened = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < 150 || b < 150 || Math.abs(r - b) > 70) continue;
    const m = Math.min(r, b) - g;
    if (m >= 100 && r > 170 && b > 170) { data[i + 3] = 0; removed++; continue; }
    if (m > 60) {
      const t = Math.min(0.95, (m - 60) / 40);
      data[i + 3] = Math.round(data[i + 3] * (1 - t));
      // magenta katkısını çıkar (renk geri kazanımı)
      data[i] = Math.max(0, Math.min(255, Math.round((r - t * 255) / (1 - t))));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((b - t * 255) / (1 - t))));
      softened++;
    }
  }
  if (!removed && !softened) return { buffer, removed: 0, softened: 0 };
  return { buffer: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(), removed, softened };
}

async function removeSolidBackground(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info; const N = w * h;
  // 1) Zemin rengini kenar bandından bul (medyan)
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.015));
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x >= band && x < w - band && y >= band && y < h - band) continue;
    const o = (y * w + x) * 4; rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
  }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const bg = [med(rs), med(gs), med(bs)];
  const sat = Math.max(...bg) - Math.min(...bg);
  if (sat < 60) return null; // renkli değil
  const dist = (o) => { const dr = data[o] - bg[0], dg = data[o + 1] - bg[1], db = data[o + 2] - bg[2]; return Math.sqrt(dr * dr + dg * dg + db * db); };
  const T0 = 70, T1 = 150; // T0 altı: zemin; T1 üstü: tamamen çizim
  // 2) Kenardan bağlı zemin (taşma olmasın diye flood fill); kapalı ceplerde sadece çok yakın renkler
  const near = new Uint8Array(N);
  for (let i = 0; i < N; i++) near[i] = dist(i * 4) < T1 ? 1 : 0;
  const conn = new Uint8Array(N); const st = new Int32Array(N); let sp = 0;
  const push = (i) => { if (near[i] && !conn[i]) { conn[i] = 1; st[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  // Çelenk/halka içinde kapalı kalan zemin cepleri: neredeyse saf zemin renginden başlat (kenarları da yumuşak silinsin)
  for (let i = 0; i < N; i++) if (!conn[i] && dist(i * 4) < T0 * 0.6) push(i);
  while (sp) { const i = st[--sp]; const x = i % w; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (i >= w) push(i - w); if (i + w < N) push(i + w); }
  let cleared = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 4; const d = dist(o);
    let a;
    if (conn[i]) a = d <= T0 ? 0 : d >= T1 ? 1 : (d - T0) / (T1 - T0);
    else a = d <= T0 * 0.6 ? 0 : 1; // kapalı cepte zemin rengi kalmışsa
    if (a < 1) {
      cleared++;
      if (a <= 0.02) { data[o + 3] = 0; continue; }
      // zemin rengini kenardan arındır (color-to-alpha)
      for (let c = 0; c < 3; c++) data[o + c] = Math.max(0, Math.min(255, Math.round((data[o + c] - (1 - a) * bg[c]) / a)));
      data[o + 3] = Math.round(a * 255);
    }
  }
  // 3) Kenar bandında zemin tonu sızıntısını (spill) nötrle: saydam alana ~6 px yakın piksellerde zemin renginin baskın kanallarını düşür
  const R = Math.max(4, Math.round(Math.min(w, h) / 170));
  const dd = new Uint8Array(N).fill(255); let q = []; for (let i = 0; i < N; i++) if (data[i * 4 + 3] < 250) { dd[i] = 0; q.push(i); }
  for (let k = 1; k <= R; k++) { const nq = []; for (const i of q) { const x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && dd[j] === 255) { dd[j] = k; nq.push(j); } } q = nq; }
  const hi = [0, 1, 2].filter((c) => bg[c] >= Math.max(...bg) - 60); const lo = [0, 1, 2].filter((c) => !hi.includes(c));
  for (let i = 0; i < N; i++) {
    if (dd[i] === 255) continue; const o = i * 4; if (data[o + 3] === 0) continue;
    const hiMin = Math.min(...hi.map((c) => data[o + c])); const loMax = Math.max(...lo.map((c) => data[o + c]));
    const ex = hiMin - loMax; if (ex <= 0) continue;
    const f = dd[i] <= R / 2 ? 1 : 0.6;
    for (const c of hi) data[o + c] = Math.max(0, Math.round(data[o + c] - ex * f));
  }
  return { buffer: await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), bg, cleared };
}

/* ===================== İç boşluk onarımı ===================== */
/**
 * Arka plan silici (özellikle AI matting) tasarımın İÇİNDEKİ beyaz alanları (yüz, el, beyaz dolgular) da
 * silebiliyor; koyu tişörte basılınca "yüzsüz" karakterler çıkıyor. Bu fonksiyon: kenara bağlı OLMAYAN,
 * yeterince büyük ve orijinalde açık renkli şeffaf bölgeleri orijinal pikselleriyle geri doldurur.
 * Küçük iç boşluklar (harflerin içi vb.) şeffaf kalır.
 */
async function fillInteriorHoles(cutBuf, rawBuf, { minFrac = 0.002, lightMin = 200, minKept = 0.08 } = {}) {
  if (!rawBuf) return { buffer: cutBuf, filled: 0 };
  const cut = await sharp(cutBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = cut.info;
  const A = cut.data;
  const raw = await sharp(rawBuf).resize(w, h, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  const N = w * h;
  // Ham görselde açık renkli (beyaza yakın) pikseller
  const light = new Uint8Array(N);
  for (let i = 0; i < N; i++) light[i] = Math.min(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]) >= lightMin ? 1 : 0;
  // Kenardan açık piksellerle ulaşılabilen alan = gerçek arka plan
  const mark = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const pushOut = (i) => { if (light[i] && !mark[i]) { mark[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { pushOut(x); pushOut((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushOut(y * w); pushOut(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp]; const x = i % w;
    if (x > 0) pushOut(i - 1); if (x < w - 1) pushOut(i + 1); if (i >= w) pushOut(i - w); if (i < N - w) pushOut(i + w);
  }
  // Çizimin İÇİNDE kalan büyük açık bölgeler (göz akı, beyaz gövde, beyaz dolgular) → opak kalmalı.
  // Küçük olanlar (harflerin içi vb.) şeffaf kalır.
  const comp = new Int32Array(N);
  let filled = 0; let restored = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (!light[s0] || mark[s0]) continue;
    let len = 0; mark[s0] = 2; stack[0] = s0; sp = 1;
    while (sp) {
      const i = stack[--sp]; comp[len++] = i; const x = i % w;
      if (x > 0 && light[i - 1] && !mark[i - 1]) { mark[i - 1] = 2; stack[sp++] = i - 1; }
      if (x < w - 1 && light[i + 1] && !mark[i + 1]) { mark[i + 1] = 2; stack[sp++] = i + 1; }
      if (i >= w && light[i - w] && !mark[i - w]) { mark[i - w] = 2; stack[sp++] = i - w; }
      if (i < N - w && light[i + w] && !mark[i + w]) { mark[i + w] = 2; stack[sp++] = i + w; }
    }
    if (len < minFrac * N) continue;
    // Silici bölgenin bir kısmını TUTTUYSA bu çizimin parçasıdır (yüz, göz akı) → tamamla.
    // Tamamını sildiyse gerçek zemindir (bacak arası boşluk, harf içi) → şeffaf bırak.
    let kept = 0;
    for (let k = 0; k < len; k++) if (A[comp[k] * 4 + 3] >= 250) kept++;
    const keptFrac = kept / len;
    if (keptFrac < minKept || keptFrac > 0.97) continue;
    let changed = 0;
    for (let k = 0; k < len; k++) {
      const i = comp[k];
      if (A[i * 4 + 3] < 250) { A[i * 4] = raw[i * 3]; A[i * 4 + 1] = raw[i * 3 + 1]; A[i * 4 + 2] = raw[i * 3 + 2]; A[i * 4 + 3] = 255; changed++; }
    }
    if (changed > len * 0.05) { filled++; restored += changed; }
  }
  if (!filled) return { buffer: cutBuf, filled: 0 };
  return { buffer: await sharp(A, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), filled, pct: Math.round((restored / N) * 1000) / 10 };
}

/* ===================== Ölçekleme / 300 DPI ===================== */
async function finalizePng(buffer, cfg, outPath) {
  const W = cfg.output_width, H = cfg.output_height;
  let trimmed;
  try {
    trimmed = await sharp(buffer).ensureAlpha().trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 }).png().toBuffer();
  } catch { trimmed = buffer; }
  const fitted = await sharp(trimmed)
    .resize(Math.round(W * 0.94), Math.round(H * 0.94), { fit: 'inside', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const meta = await sharp(fitted).metadata();
  const left = Math.floor((W - meta.width) / 2), top = Math.floor((H - meta.height) / 2);
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted, left, top }])
    .withMetadata({ density: cfg.dpi })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toFile(outPath);
  // Etsy dosya sınırı 20 MB: çok detaylı (ör. yapay zekâ ile büyütülmüş) tasarım sınırı aşarsa
  // 256 renkli, titreşimli (dither) PNG'ye çevrilir — gözle fark edilmez, boyut ~3 kat küçülür
  let reduced = false;
  if (fs.statSync(outPath).size > 18.5 * 1024 * 1024) {
    const small = await sharp(outPath).withMetadata({ density: cfg.dpi }).png({ palette: true, quality: 100, colours: 256, dither: 1.0, effort: 10, compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(outPath, small);
    reduced = true;
    log(`${path.basename(outPath)}: dosya Etsy sınırı için küçültüldü (${(small.length / 1048576).toFixed(1)} MB)`);
  }
  const check = await sharp(outPath).metadata();
  if (check.width !== W || check.height !== H || !check.hasAlpha) throw new Error(`Görsel boyutu hatası: ${check.width}x${check.height}, alpha=${check.hasAlpha}`);
  if (!reduced && (check.paletteBitDepth || check.channels !== 4)) throw new Error('PNG tam renkli RGBA değil');
  if (Math.round(check.density || 0) !== cfg.dpi) throw new Error(`DPI metadata yazılamadı (${check.density})`);
  return outPath;
}

/* ===================== Dry-run tasarımları (API'siz, ücretsiz) ===================== */
const PALETTES = [
  ['#e85d3f', '#f4a259', '#5b8e7d', '#264653', '#f6e7c1'],
  ['#c9184a', '#ff758f', '#ffb3c1', '#590d22', '#fff0f3'],
  ['#bc6c25', '#dda15e', '#606c38', '#283618', '#fefae0'],
  ['#3d405b', '#e07a5f', '#81b29a', '#f2cc8f', '#f4f1de'],
];
function demoDesignSvg(trend, i) {
  const [a, b, c, d, e] = PALETTES[i % PALETTES.length];
  const words = titleCase(trend.niche).split(' ');
  const line1 = escapeXml(words.slice(0, Math.ceil(words.length / 2)).join(' ').toUpperCase());
  const line2 = escapeXml(words.slice(Math.ceil(words.length / 2)).join(' ').toUpperCase() || 'VIBES');
  const season = escapeXml(trend.season.toUpperCase());
  const W = 1024, H = 1280;
  const variants = [
    // 0: retro gün batımı
    `<circle cx="512" cy="560" r="340" fill="${b}"/>
     ${[0, 1, 2, 3, 4].map((k) => `<rect x="150" y="${600 + k * 52}" width="724" height="${22 - k * 3}" fill="#ffffff"/>`).join('')}
     <circle cx="512" cy="560" r="340" fill="none" stroke="${d}" stroke-width="18"/>
     <path d="M200,700 L360,520 L460,640 L560,480 L820,700 Z" fill="${c}"/>
     <text x="512" y="1010" font-family="Georgia, DejaVu Serif, serif" font-weight="bold" font-size="110" text-anchor="middle" fill="${a}" stroke="${d}" stroke-width="6" paint-order="stroke">${line1}</text>
     <text x="512" y="1125" font-family="Arial, Helvetica, DejaVu Sans, sans-serif" font-weight="bold" font-size="76" letter-spacing="10" text-anchor="middle" fill="${d}">${line2}</text>`,
    // 1: rozet amblem
    `<circle cx="512" cy="600" r="400" fill="${e}" stroke="${d}" stroke-width="22"/>
     <circle cx="512" cy="600" r="340" fill="none" stroke="${a}" stroke-width="10" stroke-dasharray="20 14"/>
     <path d="M512,330 L580,470 L735,490 L620,595 L650,750 L512,675 L374,750 L404,595 L289,490 L444,470 Z" fill="${b}" stroke="${d}" stroke-width="10"/>
     <rect x="170" y="800" width="684" height="150" rx="20" fill="${a}" stroke="${d}" stroke-width="12"/>
     <text x="512" y="905" font-family="Arial, Helvetica, DejaVu Sans, sans-serif" font-weight="bold" font-size="78" text-anchor="middle" fill="#fff">${line1}</text>
     <text x="512" y="1100" font-family="Georgia, DejaVu Serif, serif" font-style="italic" font-size="70" text-anchor="middle" fill="${d}">${line2}</text>`,
    // 2: yığılmış tipografi
    `<text x="512" y="380" font-family="Georgia, DejaVu Serif, serif" font-style="italic" font-size="90" text-anchor="middle" fill="${c}">${season}</text>
     <text x="512" y="600" font-family="Arial Black, Arial, DejaVu Sans, sans-serif" font-weight="900" font-size="${Math.min(170, Math.floor(1250 / Math.max(line1.length, 1)))}" text-anchor="middle" fill="${a}" stroke="${d}" stroke-width="10" paint-order="stroke">${line1}</text>
     <text x="512" y="790" font-family="Arial Black, Arial, DejaVu Sans, sans-serif" font-weight="900" font-size="${Math.min(170, Math.floor(1250 / Math.max(line2.length, 1)))}" text-anchor="middle" fill="${b}" stroke="${d}" stroke-width="10" paint-order="stroke">${line2}</text>
     ${[0, 1, 2, 3, 4, 5, 6].map((k) => `<circle cx="${212 + k * 100}" cy="920" r="22" fill="${[a, b, c][k % 3]}"/>`).join('')}`,
    // 3: dalgalı groovy
    `${[0, 1, 2, 3].map((k) => `<path d="M80,${420 + k * 110} C300,${330 + k * 110} 720,${510 + k * 110} 944,${420 + k * 110}" stroke="${[a, b, c, d][k]}" stroke-width="70" fill="none" stroke-linecap="round"/>`).join('')}
     <text x="512" y="1040" font-family="Georgia, DejaVu Serif, serif" font-weight="bold" font-size="104" text-anchor="middle" fill="${d}">${line1}</text>
     <text x="512" y="1150" font-family="Arial, Helvetica, DejaVu Sans, sans-serif" font-size="64" letter-spacing="14" text-anchor="middle" fill="${a}">${line2}</text>`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${variants[i % variants.length]}</svg>`;
}

/* ===================== Teslim dosyaları ===================== */
function licenseText(title) {
  return `${title}

THANK YOU FOR YOUR PURCHASE!

WHAT'S INCLUDED
- High resolution PNG files, 4500 x 5400 px, 300 DPI, transparent background

LICENSE / TERMS OF USE
- Personal use: unlimited.
- Small business commercial use: you may print these designs on physical products
  (t-shirts, sweatshirts, mugs, tote bags, stickers, DTF/sublimation transfers, print on demand)
  and sell up to 500 physical items per design.
- NOT allowed: reselling, sharing or redistributing the digital files themselves (as PNG, SVG,
  digital bundles, clipart packs or in any other digital form), or claiming them as your own.

This is a DIGITAL product. No physical item will be shipped.
`;
}

async function buildInstructionsPdf(outPath, { title, link, expiresNote }) {
  const pdf = fs.existsSync(PATHS.deliveryTemplate)
    ? await PDFDocument.load(fs.readFileSync(PATHS.deliveryTemplate))
    : await PDFDocument.create();
  const page = pdf.getPageCount() ? pdf.getPage(0) : pdf.addPage([612, 792]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  if (!fs.existsSync(PATHS.deliveryTemplate)) {
    page.drawRectangle({ x: 0, y: 642, width: 612, height: 150, color: rgb(0.11, 0.12, 0.16) });
    page.drawText('THANK YOU FOR YOUR PURCHASE!', { x: 56, y: 722, size: 24, font: bold, color: rgb(1, 1, 1) });
  }
  const wrap = (text, font, size, maxW) => {
    const words = text.split(' '); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (font.widthOfTextAtSize(t, size) > maxW) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  };
  let y = 600;
  for (const line of wrap(title, bold, 14, 500)) { page.drawText(line, { x: 56, y, size: 14, font: bold, color: rgb(0.13, 0.13, 0.18) }); y -= 20; }
  y -= 14;
  const steps = [
    '1. Click the DOWNLOAD button below (or copy the link into your browser).',
    '2. Save the ZIP file to your computer (a desktop/laptop is recommended).',
    '3. Right-click the ZIP and choose "Extract All" (Windows) or double-click it (Mac).',
    '4. Your 300 DPI transparent PNG files are inside, ready for printing.',
  ];
  for (const s of steps) { page.drawText(s, { x: 56, y, size: 11, font: reg, color: rgb(0.25, 0.25, 0.3) }); y -= 20; }
  y -= 26;
  // Buton
  const btn = { x: 56, y: y - 10, w: 300, h: 44 };
  page.drawRectangle({ x: btn.x, y: btn.y, width: btn.w, height: btn.h, color: rgb(0.85, 0.36, 0.22) });
  page.drawText('DOWNLOAD YOUR FILES', { x: btn.x + 58, y: btn.y + 16, size: 14, font: bold, color: rgb(1, 1, 1) });
  const linkAnnot = (x, yy, w, h) => pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [x, yy, x + w, yy + h], Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(link) },
  }));
  const annots = [linkAnnot(btn.x, btn.y, btn.w, btn.h)];
  y = btn.y - 34;
  page.drawText('Direct link:', { x: 56, y, size: 9, font: bold, color: rgb(0.3, 0.3, 0.35) });
  y -= 14;
  const chunks = link.match(/.{1,95}/g) || [link];
  for (const c of chunks.slice(0, 6)) { page.drawText(c, { x: 56, y, size: 8, font: reg, color: rgb(0.1, 0.35, 0.8) }); annots.push(linkAnnot(56, y - 2, 500, 10)); y -= 11; }
  if (expiresNote) { y -= 10; page.drawText(expiresNote, { x: 56, y, size: 9, font: reg, color: rgb(0.6, 0.2, 0.2) }); }
  y -= 30;
  page.drawText('Questions? Message us on Etsy - we reply within 24 hours.', { x: 56, y, size: 10, font: reg, color: rgb(0.3, 0.3, 0.35) });
  page.node.set(PDFName.of('Annots'), pdf.context.obj(annots));
  pdf.setTitle('Download Instructions');
  fs.writeFileSync(outPath, await pdf.save());
  return outPath;
}

async function packageDeliverables(dir, pngs, title, cfg, productId) {
  const limit = cfg.zip_limit_mb * 1024 * 1024;
  const readme = path.join(dir, 'README_LICENSE.txt');
  fs.writeFileSync(readme, licenseText(title));
  const zipPath = path.join(dir, 'deliverable.zip');
  await createZip(zipPath, [...pngs.map((p) => ({ path: p, name: path.basename(p) })), { path: readme, name: 'README_LICENSE.txt' }]);
  const size = fileSize(zipPath);
  log(`ZIP hazır: ${(size / 1048576).toFixed(1)} MB`);
  if (size <= limit) return { mode: 'zip', files: [zipPath], zipPath, sizeMB: size / 1048576 };

  log(`ZIP ${cfg.zip_limit_mb} MB sınırını aşıyor (Etsy limiti 20 MB)`, 'warn');
  if (cfg.large_file_strategy === 'cloud' && storage.cloudConfigured()) {
    const key = `${productId}/${slugify(title)}.zip`;
    const link = await retry(() => storage.uploadFile(zipPath, key), { label: 'Bulut yükleme' });
    const permanent = !!process.env.CLOUD_PUBLIC_BASE_URL;
    const pdfPath = path.join(dir, 'Download_Instructions.pdf');
    await buildInstructionsPdf(pdfPath, { title, link, expiresNote: permanent ? null : `Link valid for ${cfg.cloud_link_expiry_days} days - please download right away.` });
    log(`Bulut yüklemesi tamam, Download_Instructions.pdf üretildi${permanent ? '' : ' (süreli link — kalıcı link için CLOUD_PUBLIC_BASE_URL ayarla)'}`, 'success');
    return { mode: 'cloud', files: [pdfPath], zipPath, link, sizeMB: size / 1048576 };
  }
  // Bulut yoksa: Etsy en fazla 5 dosya kabul eder → her tasarım ayrı ZIP
  const parts = [];
  for (let i = 0; i < pngs.length; i++) {
    const p = path.join(dir, `deliverable_part${i + 1}.zip`);
    await createZip(p, [{ path: pngs[i], name: path.basename(pngs[i]) }, { path: readme, name: 'README_LICENSE.txt' }]);
    if (fileSize(p) > limit) throw new Error(`Parça ZIP bile ${cfg.zip_limit_mb} MB üstünde; .env'de CLOUD_* ayarlarını doldurun`);
    parts.push(p);
  }
  if (parts.length > 5) throw new Error('Etsy en fazla 5 dijital dosya kabul ediyor; bundle_size değerini düşürün veya bulutu yapılandırın');
  log(`Bulut tanımlı değil → ${parts.length} parçalı ZIP olarak bölündü`, 'warn');
  return { mode: 'split', files: parts, zipPath, sizeMB: size / 1048576 };
}

/* ===================== Ana fonksiyon ===================== */
async function generateAssets(trend, { productId, dir, dryRun = false } = {}) {
  const cfg = loadConfig();
  const costs = [];
  fs.mkdirSync(path.join(dir, 'designs'), { recursive: true });
  const n = Math.max(1, Math.min(5, Number(cfg.bundle_size) || 4));

  let concepts = null;
  if (!dryRun) {
    try { concepts = await aiConcepts(trend, n, cfg, costs); } catch (e) { log(`OpenAI konsept üretimi atlandı: ${describeError(e).slice(0, 100)}`, 'warn'); }
  }
  if (!concepts) concepts = templateConcepts(trend, n, cfg);
  const prompts = concepts.map((c) => buildPrompt(c, cfg));
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(prompts, null, 2));

  const makeDesign = async (i, out, attemptTag = '') => {
    await retry(async () => {
      let img;
      if (dryRun) {
        log(`Tasarım ${i + 1}/${n} çiziliyor (dry-run, API kullanılmıyor)`);
        img = { buffer: await sharp(Buffer.from(demoDesignSvg(trend, i))).png().toBuffer(), url: null, transparent: false };
      } else {
        log(`Tasarım ${i + 1}/${n} üretiliyor${attemptTag} (${cfg.image_provider === 'openai' ? cfg.openai_image_model : cfg.replicate_model})`);
        img = await generateImage(prompts[i], cfg, costs);
        if (cfg.ai_upscale && img.url && cfg.image_provider !== 'openai') {
          log('AI upscale (Real-ESRGAN) uygulanıyor');
          const up = await replicateRun(cfg.replicate_upscale_model, { image: img.url, scale: 4 }, cfg);
          costs.push(cfg.costs.replicate_upscale);
          img = { buffer: await download(up), url: up, transparent: false };
        }
      }
      log('Arka plan siliniyor...');
      let cut = await removeBackground(img, dryRun ? { ...cfg, bg_removal: 'local' } : cfg, costs);
      if (!img.transparent && cfg.fill_interior_holes !== false) {
        const fh = await fillInteriorHoles(cut, img.buffer);
        if (fh.filled) { cut = fh.buffer; log(`İç boşluk onarımı: ${fh.filled} bölge geri dolduruldu (%${fh.pct})`); }
      }
      if (!dryRun) {
        fs.mkdirSync(path.join(dir, 'designs_raw'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'designs_raw', path.basename(out)), img.buffer);
      }
      await finalizePng(cut, cfg, out);
      log(`Tasarım ${i + 1} hazır: ${cfg.output_width}x${cfg.output_height}px @${cfg.dpi} DPI şeffaf PNG`, 'success');
    }, { label: `Tasarım ${i + 1} üretimi` });
  };

  const pngs = [];
  for (let i = 0; i < prompts.length; i++) {
    checkStop();
    const out = path.join(dir, 'designs', `${slugify(trend.niche) || 'design'}_${i + 1}.png`);
    await makeDesign(i, out);
    pngs.push(out);
  }

  // Kalite kontrol + hatalı tasarımları otomatik yeniden üretme
  const { checkDesigns } = require('./06_quality_check');
  let qc = await checkDesigns(pngs, trend, { costs, dryRun });
  const maxRegen = dryRun ? 0 : Math.max(0, Number(cfg.qc_max_regenerate ?? 2));
  for (let round = 1; round <= maxRegen && qc.failed.length; round++) {
    checkStop();
    log(`Kalite kontrol: ${qc.failed.length} tasarım yeniden üretiliyor (tur ${round}/${maxRegen})`, 'warn');
    for (const i of qc.failed) await makeDesign(i, pngs[i], ` — yeniden deneme ${round}`);
    const again = await checkDesigns(qc.failed.map((i) => pngs[i]), trend, { costs, dryRun, labels: qc.failed.map((i) => i + 1) });
    const nextFailed = again.failed.map((k) => qc.failed[k]);
    qc.failed.forEach((i, k) => { qc.report[i] = again.report[k]; });
    qc.failed = nextFailed;
  }
  // Hâlâ başarısız olan tasarımlar paketten çıkarılır (en az 1 tasarım kalmalı)
  let finalPngs = pngs;
  if (qc.failed.length && qc.failed.length < pngs.length && cfg.qc_drop_failed !== false) {
    const dropped = qc.failed.map((i) => path.basename(pngs[i]));
    finalPngs = pngs.filter((_, i) => !qc.failed.includes(i));
    const rejDir = path.join(dir, 'rejected');
    fs.mkdirSync(rejDir, { recursive: true });
    for (const i of qc.failed) fs.renameSync(pngs[i], path.join(rejDir, path.basename(pngs[i])));
    qc.report = qc.report.filter((_, i) => !qc.failed.includes(i));
    qc.failed = [];
    log(`Kalite kontrol: ${dropped.length} hatalı tasarım paketten çıkarıldı (${dropped.join(', ')}) → ${finalPngs.length}'lü paket`, 'warn');
  }
  const designReport = qc.report;

  const nn = finalPngs.length;
  const title = `${titleCase(trend.keyword)} - ${nn > 1 ? `${nn} Design Bundle` : 'Design'}`;
  const delivery = await packageDeliverables(dir, finalPngs, title, cfg, productId);
  const cost = costs.reduce((s, c) => s + c, 0);
  return { pngs: finalPngs, prompts, delivery, cost, designReport };
}

module.exports = { generateAssets, buildPrompt, PROMPT_SUFFIX, localRemoveWhite, finalizePng, buildInstructionsPdf, packageDeliverables, demoDesignSvg };

/* ===================== Onarım: hatalı tasarımları yeniden üret ===================== */
/**
 * Mevcut bir ürünün belirtilen tasarımlarını GÜNCEL prompt kurallarıyla yeniden üretir, kalite kontrolden geçirir,
 * düzelmeyenleri paketten çıkarır ve teslim paketini yeniden oluşturur.
 */
async function repairDesigns({ trend, dir, productId, indices }) {
  const cfg = loadConfig();
  const costs = [];
  const ddir = path.join(dir, 'designs');
  const pngs = fs.readdirSync(ddir).filter((f) => /\.png$/i.test(f)).sort().map((f) => path.join(ddir, f));
  const n = pngs.length;
  const concepts = templateConcepts(trend, Math.max(n, 5), cfg);
  const promptFor = (i) => buildPrompt(concepts[i % concepts.length], cfg);
  const { checkDesigns } = require('./06_quality_check');

  const regen = async (i, tag) => retry(async () => {
    log(`Onarım: tasarım ${i + 1}/${n} yeniden üretiliyor${tag} (${cfg.replicate_model})`);
    const img = await generateImage(promptFor(i), cfg, costs);
    log('Arka plan siliniyor...');
    let cut = await removeBackground(img, cfg, costs);
    if (!img.transparent && cfg.fill_interior_holes !== false) {
      const fh = await fillInteriorHoles(cut, img.buffer);
      if (fh.filled) { cut = fh.buffer; log(`İç boşluk onarımı: ${fh.filled} bölge geri dolduruldu (%${fh.pct})`); }
    }
    fs.mkdirSync(path.join(dir, 'designs_raw'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'designs_raw', path.basename(pngs[i])), img.buffer);
    await finalizePng(cut, cfg, pngs[i]);
    log(`Tasarım ${i + 1} yenilendi`, 'success');
  }, { label: `Tasarım ${i + 1} onarımı` });

  let failed = [...new Set(indices)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const reports = new Map();
  const maxRounds = Math.max(1, Number(cfg.qc_max_regenerate ?? 2));
  for (let round = 1; round <= maxRounds && failed.length; round++) {
    checkStop();
    for (const i of failed) await regen(i, round > 1 ? ` — tekrar ${round}` : '');
    const again = await checkDesigns(failed.map((i) => pngs[i]), trend, { costs, labels: failed.map((i) => i + 1) });
    failed.forEach((i, k) => reports.set(i, again.report[k]));
    failed = again.failed.map((k) => failed[k]);
  }

  let finalPngs = pngs;
  if (failed.length && failed.length < n) {
    const rejDir = path.join(dir, 'rejected');
    fs.mkdirSync(rejDir, { recursive: true });
    for (const i of failed) fs.renameSync(pngs[i], path.join(rejDir, `${Date.now()}_${path.basename(pngs[i])}`));
    finalPngs = pngs.filter((_, i) => !failed.includes(i));
    log(`Onarım: ${failed.length} tasarım düzelmedi, paketten çıkarıldı → ${finalPngs.length}'lü paket`, 'warn');
  }

  // Eski teslim dosyalarını temizle ve yeniden paketle
  for (const f of fs.readdirSync(dir)) if (/^(deliverable(_part\d+)?\.zip|Download_Instructions\.pdf)$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const nn = finalPngs.length;
  const title = `${titleCase(trend.keyword)} - ${nn > 1 ? `${nn} Design Bundle` : 'Design'}`;
  const delivery = await packageDeliverables(dir, finalPngs, title, cfg, productId);
  return { pngs: finalPngs, delivery, cost: costs.reduce((s, c) => s + c, 0), stillFailed: failed.length };
}

module.exports.repairDesigns = repairDesigns;
module.exports.fillInteriorHoles = fillInteriorHoles;
module.exports.stripGarments = stripGarments;

/* ===================== Kendi tasarımlarından ürün (Gemini vb. ile elle üretilmiş görseller) ===================== */
/** Sağ alt köşedeki küçük, ana çizimden kopuk lekeleri (ör. Gemini ✦ filigranı) siler. */
async function removeCornerSpecks(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info; const N = w * h;
  const on = new Uint8Array(N);
  for (let i = 0; i < N; i++) on[i] = data[i * 4 + 3] > 40 ? 1 : 0;
  const seen = new Uint8Array(N); const stack = new Int32Array(N); const comp = new Int32Array(N);
  let removed = 0;
  const x0 = Math.floor(w * 0.82), y0 = Math.floor(h * 0.82);
  for (let s = 0; s < N; s++) {
    if (!on[s] || seen[s]) continue;
    const sx = s % w, sy = (s / w) | 0;
    if (sx < x0 || sy < y0) { // köşe dışında başlayan bileşenleri sadece işaretle
      let sp = 0; seen[s] = 1; stack[sp++] = s;
      while (sp) { const i = stack[--sp]; const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && on[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      continue;
    }
    let sp = 0, len = 0, inCorner = true; seen[s] = 1; stack[sp++] = s;
    while (sp) { const i = stack[--sp]; comp[len++] = i; const x = i % w;
      if (x < x0 || ((i / w) | 0) < y0) inCorner = false;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && on[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
    if (inCorner && len < N * 0.006) { for (let k = 0; k < len; k++) data[comp[k] * 4 + 3] = 0; removed++; }
  }
  return { buffer: removed ? await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() : buf, removed };
}

/** Yerleşik silici sonrası: harf içleri gibi küçük, kapalı, saf beyaz bölgeleri saydam yapar. */
async function clearEnclosedWhite(buf, { maxFrac = 0.004, minWhite = 244 } = {}) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info; const N = w * h;
  const wt = new Uint8Array(N);
  for (let i = 0; i < N; i++) wt[i] = data[i * 4 + 3] > 200 && Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= minWhite ? 1 : 0;
  const seen = new Uint8Array(N); const stack = new Int32Array(N); const comp = new Int32Array(N);
  let n = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (!wt[s0] || seen[s0]) continue;
    let sp = 0, len = 0; seen[s0] = 1; stack[sp++] = s0;
    while (sp) { const i = stack[--sp]; comp[len++] = i; const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && wt[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
    if (len >= 12 && len < N * maxFrac) {
      // Çevresi koyu kontur ise harf içi/boşluk → sil; çevresi renkli dolgu ise parlama/ışık vurgusu → koru
      let ring = 0, dark = 0;
      for (let k = 0; k < len; k++) {
        const i = comp[k], x = i % w;
        for (const j of [x > 1 ? i - 2 : -1, x < w - 2 ? i + 2 : -1, i - 2 * w, i + 2 * w]) {
          if (j < 0 || j >= N || wt[j]) continue;
          ring++;
          const o = j * 4;
          if (data[o + 3] > 128 && 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] < 120) dark++;
        }
      }
      if (ring && dark / ring >= 0.5) { for (let k = 0; k < len; k++) data[comp[k] * 4 + 3] = 0; n++; }
    }
  }
  return { buffer: n ? await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() : buf, cleared: n };
}

/**
 * Kenar arındırma ("color to alpha", beyaz): şeffaf alana R piksel mesafedeki açık renkli kenar piksellerini
 * beyazdan ayırır → ince yazılar ve çizgiler koyu tişörtte beyaz hale/kontur bırakmaz.
 */
async function decontaminateEdges(buf, R = 3) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info; const N = w * h;
  const dist = new Uint8Array(N).fill(255);
  let q = new Int32Array(N), qn = 0;
  for (let i = 0; i < N; i++) if (data[i * 4 + 3] < 8) { dist[i] = 0; q[qn++] = i; }
  for (let d = 1; d <= R; d++) {
    const nq = new Int32Array(qn * 4 + 4); let nn = 0;
    for (let k = 0; k < qn; k++) {
      const i = q[k], x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && dist[j] === 255) { dist[j] = d; nq[nn++] = j; }
    }
    q = nq; qn = nn;
  }
  let changed = 0;
  for (let i = 0; i < N; i++) {
    if (dist[i] === 0 || dist[i] === 255) continue;
    const o = i * 4, a0 = data[o + 3] / 255;
    if (a0 <= 0) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (Math.min(r, g, b) < 110) continue; // zaten koyu/doygun: dokunma
    const a = Math.max((255 - r) / 255, (255 - g) / 255, (255 - b) / 255);
    if (a >= 0.995) continue;
    if (a < 0.02) { data[o + 3] = 0; changed++; continue; }
    data[o] = Math.round(Math.max(0, Math.min(255, (r - 255 * (1 - a)) / a)));
    data[o + 1] = Math.round(Math.max(0, Math.min(255, (g - 255 * (1 - a)) / a)));
    data[o + 2] = Math.round(Math.max(0, Math.min(255, (b - 255 * (1 - a)) / a)));
    data[o + 3] = Math.round(255 * a * a0);
    changed++;
  }
  return { buffer: changed ? await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() : buf, changed };
}

async function importAssets(trend, { productId, dir, files, mode = 'text', effects = null }) {
  const cfg = loadConfig();
  const costs = [];
  fs.mkdirSync(path.join(dir, 'designs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'designs_raw'), { recursive: true });
  const list = files.slice(0, 5);
  const pngs = [];
  for (let i = 0; i < list.length; i++) {
    checkStop();
    log(`Tasarım ${i + 1}/${list.length} içe aktarılıyor: ${path.basename(list[i])}`);
    // Beyaz zemine düzleştir (saydam/ JPEG fark etmez), çok büyükse makul boyuta indir
    let raw = await sharp(list[i]).rotate().flatten({ background: '#ffffff' }).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    // Küçük görseller (Gemini kopyala-yapıştır ~1024 px) baskıda bulanık olmasın: yapay zekâ ile 4 kat büyüt
    const up = await aiUpscale(raw, mode);
    if (up) raw = up.buffer;
    fs.writeFileSync(path.join(dir, 'designs_raw', `${slugify(trend.niche) || 'design'}_${i + 1}.png`), raw);
    let url = null;
    if (cfg.bg_removal === 'replicate' && process.env.REPLICATE_API_TOKEN) {
      const small = await sharp(raw).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
      url = `data:image/jpeg;base64,${small.toString('base64')}`;
    }
    log('Arka plan siliniyor...');
    const before = costs.length;
    let cut = null;
    if (mode === 'illustration') {
      const sb = await removeSolidBackground(raw);
      if (sb) { cut = sb.buffer; url = 'solid'; log(`Renkli zemin silindi (zemin rgb ${sb.bg.join(',')})`); }
      else log('Görselin zemini renkli değil (beyaz?) — beyaz silici kullanılıyor. En iyi sonuç için talimattaki düz renkli zemini kullanın', 'warn');
    }
    if (!cut) cut = await removeBackground({ buffer: raw, url, transparent: false }, cfg, costs);
    if (url !== 'solid' && costs.length === before) url = null; // yapay zekâ silici çalışmadıysa yerleşik silici kullanıldı
    if (url && url !== 'solid' && cfg.fill_interior_holes !== false) {
      const fh = await fillInteriorHoles(cut, raw);
      if (fh.filled) { cut = fh.buffer; log(`İç boşluk onarımı: ${fh.filled} bölge geri dolduruldu (%${fh.pct})`); }
    }
    if (!url) {
      const ce = await clearEnclosedWhite(cut);
      if (ce.cleared) { cut = ce.buffer; log(`Harf içi beyazlar temizlendi (${ce.cleared} bölge)`); }
    }
    if (url !== 'solid') { const de = await decontaminateEdges(cut); if (de.changed) cut = de.buffer; }
    if (url === 'solid') {
      const km = await killMagenta(cut);
      if (km.removed + km.softened > 0) { cut = km.buffer; log(`Pembe zemin artığı temizlendi (${km.removed} piksel silindi, ${km.softened} kenar düzeltildi)`); }
    }
    const sp = await removeCornerSpecks(cut);
    if (sp.removed) { cut = sp.buffer; log('Köşedeki filigran/leke temizlendi'); }
    if (effects && /^retro/.test(effects[i] || '')) {
      // Yazılı (amblem) tasarımda alttan erime yazıyı okunmaz yapar → sadece hafif eskitme
      const txt = effects[i] === 'retro_text';
      cut = await require('./lib/retro_print').retroPrint(cut, txt ? { fade: 0, distress: 0.3 } : undefined);
      log(txt ? 'Retro eskitme uygulandı (yazılı tasarım, erime yok)' : 'Retro baskı efekti uygulandı (halftone erime + eskitme)');
    }
    const out = path.join(dir, 'designs', `${slugify(trend.niche) || 'design'}_${i + 1}.png`);
    await finalizePng(cut, cfg, out);
    log(`Tasarım ${i + 1} hazır: ${cfg.output_width}x${cfg.output_height}px @${cfg.dpi} DPI şeffaf PNG`, 'success');
    pngs.push(out);
  }
  const { checkDesigns } = require('./06_quality_check');
  const qc = await checkDesigns(pngs, trend, { costs });
  if (qc.failed.length) log(`Kalite kontrol: ${qc.failed.length} tasarımda sorun var — ürün incelemeye alınacak, panelden "✕ Çıkar" ile çıkarabilirsiniz`, 'warn');
  const nn = pngs.length;
  const title = `${titleCase(trend.keyword)} - ${nn > 1 ? `${nn} Design Bundle` : 'Design'}`;
  const delivery = await packageDeliverables(dir, pngs, title, cfg, productId);
  return { pngs, delivery, cost: costs.reduce((s, c) => s + c, 0), designReport: qc.report };
}
module.exports.importAssets = importAssets;
module.exports.decontaminateEdges = decontaminateEdges;
module.exports.clearEnclosedWhite = clearEnclosedWhite;
module.exports.removeCornerSpecks = removeCornerSpecks;
module.exports.removeSolidBackground = removeSolidBackground;
module.exports.killMagenta = killMagenta;
module.exports.aiUpscale = aiUpscale;
