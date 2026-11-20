'use strict';
/**
 * Modelli tişört mockup'ları (kapak görseli için).
 * Gemini'ye (ücretsiz tarayıcı yolu) bir kez BOŞ beyaz tişörtlü yetişkin model fotoğrafları çizdirilir,
 * yerel yapay zekâ büyütücüyle netleştirilir, beyaz tişört alanı bulunur ve göğüs baskı alanı hesaplanır.
 * Tasarımı Gemini çizmez: bizim gerçek PNG'miz program tarafından kumaşa yerleştirilir (ilan = ürün).
 * Kayıt: data/base_mockups/model/model_mockups.json
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { log, PATHS } = require('./core');

const DIR = path.join(PATHS.mockups, 'model');
const MANIFEST = path.join(DIR, 'model_mockups.json');
const MUG_MANIFEST = path.join(DIR, 'mug_mockups.json'); // kupa fotoğrafları ayrı tutulur (tişört kapaklarına karışmasın)

const BASE = 'Photorealistic fashion lifestyle product photo, vertical 3:4 portrait. NO FACE: the photo is cropped just below her chin, so only her neck, shoulders and body are visible. '
  + 'An adult woman with a slim, fit figure wearing a fitted, flattering COMPLETELY BLANK plain white sleeveless cotton tank top with shoulder straps and a smooth (not ribbed) fabric front (no print, no logo, no text, no graphics, nothing on the top), '
  + 'loosely front-tucked into high-waisted light blue denim shorts (short shorts, legs visible). Stylish, confident, tasteful Instagram-influencer look. Her torso faces the camera straight on, shoulders square; '
  + 'her arms stay at her sides or one hand rests in a back pocket, nothing in front of the shirt (no hands, no hair, no jacket, no bag, no mug). Long hair falls behind her shoulders. '
  + 'The top front is smooth and evenly lit with only soft natural fabric wrinkles. Sharp focus on the shirt, softly blurred background, professional ecommerce mockup photo.';

const MODEL_SPECS = [
  { key: 'model_tree', scene: 'Framed from below the chin down to mid-thigh. Background: a cozy living room with a decorated christmas tree and warm string lights, softly blurred.' },
  { key: 'model_cafe', scene: 'Framed from below the chin down to mid-thigh. Background: a warm cafe interior with christmas garlands and soft bokeh lights, softly blurred.' },
  { key: 'model_cabin', scene: 'Framed from below the chin down to the hips. Background: a rustic wooden cabin wall with a fireplace glow, softly blurred.' },
  { key: 'model_studio', scene: 'Framed from below the chin down to mid-thigh. Background: a plain muted sage green studio backdrop.' },
  { key: 'model_street', scene: 'Framed from below the chin down to mid-thigh. Background: a city street with warm golden-hour sunlight and autumn trees, softly blurred.' },
  { key: 'model_bedroom', scene: 'Framed from below the chin down to mid-thigh. Background: a bright minimalist bedroom with white linen and a plant, softly blurred.' },
];

// Çok satan dükkânların tarzı: bol kesim, "garment-dyed" (solgun, yıkanmış) ağır pamuk tişörtler, renkli/koyu kumaş
const TEE = (color, scene, garment = 'oversized heavyweight garment-dyed cotton t-shirt') => 'Photorealistic lifestyle product photo, vertical 3:4 portrait. NO FACE: the photo is cropped just below her chin, so only her neck, shoulders and body are visible. '
  + `An adult woman wearing an ${garment} in a faded vintage ${color} color, COMPLETELY BLANK (no print, no logo, no text, no tag or label visible, nothing on the shirt), `
  + 'loosely front-tucked into high-waisted light blue denim shorts. Relaxed, stylish, tasteful influencer look. Her torso faces the camera straight on, shoulders square; arms relaxed at her sides or one hand in a pocket; '
  + 'nothing in front of the shirt (no hands, no hair, no jacket, no bag, no mug); long hair behind her shoulders. Realistic soft washed cotton texture with natural relaxed wrinkles, the front of the shirt evenly lit. '
  + `Framed from below the chin down to mid-thigh. Background: ${scene}, softly blurred. Sharp focus on the shirt. Professional ecommerce mockup photo.`;
// Boş beyaz kupa fotoğrafları (kupa sargısı / mug wrap ürünleri için)
const MUG = (scene) => 'Photorealistic lifestyle product photo, landscape 4:3. A COMPLETELY BLANK plain glossy white 11oz ceramic coffee mug (no print, no logo, no text, no pattern, nothing on the mug), '
  + 'photographed straight from the front at eye level, the handle on the RIGHT side in profile, the mug body large and centered taking about half of the image height, evenly lit with soft natural light and a gentle highlight, sharp focus on the mug. '
  + `Setting: ${scene}, softly blurred background. Nothing in front of the mug. Professional ecommerce mockup photo.`;
const MUG_SPECS = [
  { key: 'mug_cozy', prompt: MUG('on a rustic wooden table with a knitted blanket, pine branches and warm christmas string lights bokeh behind'), xmas: true },
  { key: 'mug_kitchen', prompt: MUG('on a bright white marble kitchen counter with a small green plant and morning window light') },
  { key: 'mug_cafe', prompt: MUG('on a cafe table next to an open book and a croissant, warm cozy cafe interior') },
];
const TEE_SPECS = [
  { key: 'tee_ivory', color: 'Ivory', dark: false, prompt: TEE('ivory cream', 'a bright minimalist bedroom with white linen and a green plant') },
  { key: 'tee_black', color: 'Black', dark: true, xmas: true, prompt: TEE('washed black', 'a cozy living room with a decorated christmas tree and warm string lights') },
  { key: 'tee_pepper', color: 'Pepper', dark: true, prompt: TEE('pepper charcoal gray', 'a rustic wooden cabin wall with a warm fireplace glow') },
  { key: 'tee_sage', color: 'Sage', dark: false, prompt: TEE('sage green', 'a city street with warm golden-hour sunlight and autumn trees') },
  { key: 'tee_denim', color: 'Denim', dark: true, xmas: true, prompt: TEE('faded denim blue', 'a warm cafe interior with christmas garlands and soft bokeh lights') },
  { key: 'sweat_sand', color: 'Sand', dark: false, prompt: TEE('sand beige', 'a plain warm cream studio backdrop', 'oversized cozy crewneck sweatshirt') },
];

function readModelManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).filter((m) => m.print && fs.existsSync(path.join(PATHS.mockups, m.file))); } catch { return []; }
}

/** Fotoğraftaki beyaz tişörtü bulur → alfa maskesi (PNG) */
async function shirtMask(buf, W, H, colorSeed = false) {
  const S = 600, sh = Math.round(S * H / W);
  const { data } = await sharp(buf).resize(S, sh, { fit: 'fill' }).blur(colorSeed ? 1.5 : 0.3).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ok = new Uint8Array(S * sh);
  if (colorSeed) {
    // Renkli/koyu kumaş: göğüs ortasındaki renge yakın pikseller (aydınlık farkına toleranslı)
    const px = (x, y) => { const o = (y * S + x) * 3; return [data[o], data[o + 1], data[o + 2]]; };
    const cs = []; for (let y = Math.round(sh * 0.5); y < sh * 0.62; y += 2) for (let x = Math.round(S * 0.44); x < S * 0.56; x += 2) cs.push(px(x, y));
    const med = [0, 1, 2].map((c) => cs.map((v) => v[c]).sort((a, b) => a - b)[cs.length >> 1]);
    const lm = (v) => 0.3 * v[0] + 0.59 * v[1] + 0.11 * v[2];
    const L0 = lm(med), ch0 = [med[0] - L0, med[1] - L0, med[2] - L0];
    for (let i = 0; i < S * sh; i++) {
      const v = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]; const L = lm(v);
      const dch = Math.max(Math.abs(v[0] - L - ch0[0]), Math.abs(v[1] - L - ch0[1]), Math.abs(v[2] - L - ch0[2]));
      if (Math.abs(L - L0) < 55 && dch < 22) ok[i] = 1;
    }
  } else for (let i = 0; i < S * sh; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 150 && (mx - mn) / mx < 0.2) ok[i] = 1;
  }
  // Tohum: ortadaki dikey bantta en çok beyaz pikseli olan noktaya yakın beyaz piksel
  let seed = -1;
  for (const fy of [0.62, 0.7, 0.55, 0.78, 0.48]) {
    const y = Math.round(sh * fy);
    for (let dx = 0; dx < S * 0.15 && seed < 0; dx++) for (const sx of [1, -1]) {
      const x = Math.round(S / 2 + sx * dx);
      if (ok[y * S + x]) { seed = y * S + x; break; }
    }
    if (seed >= 0) break;
  }
  if (seed < 0) throw new Error('beyaz tişört bulunamadı');
  const comp = new Uint8Array(S * sh);
  const st = [seed]; comp[seed] = 1;
  while (st.length) {
    const p = st.pop(); const x = p % S, y = (p - x) / S;
    for (const q of [x > 0 ? p - 1 : -1, x < S - 1 ? p + 1 : -1, y > 0 ? p - S : -1, y < sh - 1 ? p + S : -1]) {
      if (q >= 0 && ok[q] && !comp[q]) { comp[q] = 1; st.push(q); }
    }
  }
  const rgba = Buffer.alloc(S * sh * 4);
  for (let i = 0; i < S * sh; i++) rgba[i * 4 + 3] = comp[i] ? 255 : 0;
  // küçük delikleri (kırışık gölgeleri) kapat
  const closed = await sharp(rgba, { raw: { width: S, height: sh, channels: 4 } }).blur(2.5).raw().toBuffer();
  for (let i = 0; i < S * sh; i++) closed[i * 4 + 3] = closed[i * 4 + 3] > 70 ? 255 : 0;
  return sharp(closed, { raw: { width: S, height: sh, channels: 4 } }).png().toBuffer();
}

/** Gemini'de boş tişörtlü model fotoğraflarını üretir (bir kez). */
async function generateModelBases({ force = false, set = 'tank' } = {}) {
  const SPECS = set === 'tee' ? TEE_SPECS : set === 'mug' ? MUG_SPECS : MODEL_SPECS;
  const MAN = set === 'mug' ? MUG_MANIFEST : MANIFEST;
  const { generateImages } = require('./gemini_browser');
  const { aiUpscale } = require('../02_asset_generator');
  const { printAreaFromMask } = require('./photo_mockups');
  fs.mkdirSync(DIR, { recursive: true });
  let manifest = []; try { manifest = JSON.parse(fs.readFileSync(MAN, 'utf8')); } catch {}
  const todo = SPECS.filter((s) => force || !manifest.some((m) => m.key === s.key && m.print));
  if (!todo.length) { log('Modelli mockup fotoğrafları zaten hazır'); return manifest; }
  log(`Modelli mockup: ${todo.length} boş tişörtlü model fotoğrafı Gemini'de çiziliyor…`);
  const tmp = path.join(DIR, '_gemini');
  const got = await generateImages(todo.map((s) => s.prompt || `${BASE} ${s.scene}`), { outDir: tmp, mode: 'text' });
  for (const g of got) {
    const spec = todo[g.index];
    try {
      let buf = fs.readFileSync(g.file);
      const up = await aiUpscale(buf, 'illustration').catch(() => null);
      if (up) buf = up.buffer;
      buf = await sharp(buf).resize({ width: 1800, kernel: 'lanczos3' }).jpeg({ quality: 93 }).toBuffer();
      const meta = await sharp(buf).metadata();
      const file = `model/${spec.key}.jpg`;
      fs.writeFileSync(path.join(PATHS.mockups, file), buf);
      let print = null;
      try {
        if (set !== 'mug') {
          const mask = await shirtMask(buf, meta.width, meta.height, !!spec.color);
          print = await printAreaFromMask(mask, meta.width, meta.height, 'tshirt');
        }
      } catch (e) { log(`${spec.key}: baskı alanı otomatik bulunamadı (${e.message})`, 'warn'); }
      manifest = manifest.filter((m) => m.key !== spec.key);
      manifest.push({ key: spec.key, file, type: set === 'mug' ? 'mug' : 'tshirt', color: spec.color || 'White', dark: !!spec.dark, xmas: !!spec.xmas || /tree|cafe/.test(spec.key), photo: true, model: true, size: { w: meta.width, h: meta.height }, print });
      fs.writeFileSync(MAN, JSON.stringify(manifest, null, 2));
      log(`Modelli mockup hazır: ${spec.key}${print ? '' : ' (baskı alanı elle ayarlanmalı)'}`, print ? 'success' : 'warn');
    } catch (e) { log(`${spec.key} işlenemedi: ${e.message}`, 'warn'); }
  }
  return manifest;
}

module.exports = { generateModelBases, readModelManifest, shirtMask, MODEL_SPECS, TEE_SPECS, MUG_SPECS, MANIFEST, MUG_MANIFEST };
