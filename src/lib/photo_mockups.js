'use strict';
/**
 * Gerçekçi fotoğraf mockup'ları.
 * İlk kullanımda Replicate ile boş (baskısız) ürün fotoğrafları bir kez üretilir (~$0.30 toplam),
 * arka plan silici ile ürün maskesi çıkarılır, göğüs baskı alanı maskeden hesaplanır ve
 * data/base_mockups/photo/ altına kaydedilir. Sonraki tüm ürünler bu fotoğrafları ücretsiz kullanır.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { log, PATHS } = require('./core');
const { replicateRun } = require('./replicate');
const { download, describeError } = require('./http');

const DIR = path.join(PATHS.mockups, 'photo');
const MANIFEST = path.join(DIR, 'photo_mockups.json');
const BLANK = 'completely blank garment with no print, no logo, no text, no graphics, no label visible on the front';
const LOOK = 'professional ecommerce product photography, photorealistic, high resolution, sharp focus, natural soft daylight, realistic cotton fabric texture and gentle natural wrinkles';

const SPECS = [
  { key: 'tshirt_white', type: 'tshirt', color: 'White', dark: false,
    prompt: `Top-down flat lay photo of a single plain white cotton crew neck t-shirt, front side up, perfectly centered and symmetrical, sleeves spread out, laid on a light natural oak wooden table, a small eucalyptus sprig and a ceramic coffee cup near the corners, ${BLANK}, ${LOOK}` },
  { key: 'tshirt_black', type: 'tshirt', color: 'Black', dark: true,
    prompt: `Top-down flat lay photo of a single plain black cotton crew neck t-shirt, front side up, perfectly centered and symmetrical, sleeves spread out, laid on a white marble surface, a few dried flowers near the corners, ${BLANK}, ${LOOK}` },
  { key: 'tshirt_sand', type: 'tshirt', color: 'Sand', dark: false,
    prompt: `Top-down flat lay photo of a single plain sand beige natural cotton crew neck t-shirt, front side up, perfectly centered and symmetrical, sleeves spread out, laid on a soft cream linen cloth, autumn leaves and pine cones near the corners, ${BLANK}, ${LOOK}` },
  { key: 'sweatshirt_heather', type: 'sweatshirt', color: 'Heather Grey', dark: false,
    prompt: `Top-down flat lay photo of a single plain heather grey crew neck sweatshirt, front side up, perfectly centered and symmetrical, long sleeves folded neatly at the sides, laid on a light wooden floor, a cozy knit blanket corner and a mug near the edges, ${BLANK}, ${LOOK}` },
];

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).filter((m) => fs.existsSync(path.join(PATHS.mockups, m.file))); } catch { return []; }
}

/** Ürün maskesinden göğüs baskı alanını bulur (görsel koordinatlarında). */
async function printAreaFromMask(maskBuf, W, H, type) {
  const S = 600; // analiz çözünürlüğü
  const sh = Math.round(S * H / W);
  const a = await sharp(maskBuf).ensureAlpha().extractChannel(3).resize(S, sh, { fit: 'fill' }).raw().toBuffer();
  // Gürültüye dayanıklı sınırlar: en az %4 dolu satır/sütunlar
  const rows = new Array(sh).fill(0), cols = new Array(S).fill(0);
  let area = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < S; x++) if (a[y * S + x] > 128) { area++; rows[y]++; cols[x]++; }
  if (area < S * sh * 0.12 || area > S * sh * 0.85) throw new Error('ürün maskesi bulunamadı');
  const rT = S * 0.04, cT = sh * 0.04;
  let y0 = rows.findIndex((v) => v > rT), y1 = sh - 1 - [...rows].reverse().findIndex((v) => v > rT);
  let x0 = cols.findIndex((v) => v > cT), x1 = S - 1 - [...cols].reverse().findIndex((v) => v > cT);
  if (y0 < 0 || x0 < 0) throw new Error('ürün maskesi bulunamadı');
  const hs = y1 - y0;
  // Gövde genişliği: yüksekliğin %55'indeki satırda merkezi içeren dolu bölüm
  const cxApprox = Math.round((x0 + x1) / 2);
  const row = Math.round(y0 + hs * 0.55);
  let l = cxApprox, r = cxApprox;
  while (l > 0 && a[row * S + l - 1] > 128) l--;
  while (r < S - 1 && a[row * S + r + 1] > 128) r++;
  const torso = r - l;
  if (torso < (x1 - x0) * 0.35) throw new Error('gövde genişliği ölçülemedi');
  const cx = (l + r) / 2;
  // Yaka: merkez sütunda üstten ilk dolu piksel (yaka çukuru)
  let collar = y0;
  for (let y = y0; y < y1; y++) if (a[y * S + Math.round(cx)] > 128) { collar = y; break; }
  const top = Math.max(collar + hs * 0.07, y0 + hs * (type === 'sweatshirt' ? 0.2 : 0.17));
  const w = torso * (type === 'sweatshirt' ? 0.55 : 0.6);
  const h = Math.min(w * 1.2, y1 - top - hs * 0.12);
  // Baskı kutusu tamamen kumaşın üzerinde olmalı
  let inside = 0, tot = 0;
  for (let y = Math.round(top); y < Math.round(top + h); y += 2) for (let x = Math.round(cx - w / 2); x < Math.round(cx + w / 2); x += 2) { tot++; if (a[y * S + x] > 128) inside++; }
  if (!tot || inside / tot < 0.95) throw new Error(`baskı alanı kumaş dışına taşıyor (%${Math.round(100 * inside / Math.max(1, tot))})`);
  const k = W / S;
  return { x: Math.round((cx - w / 2) * k), y: Math.round(top * k), w: Math.round(w * k), h: Math.round(h * k) };
}

async function makeOne(spec, cfg) {
  const model = cfg.photo_mockup_model || 'black-forest-labs/flux-1.1-pro-ultra';
  const url = await replicateRun(model, { prompt: spec.prompt, aspect_ratio: '4:3', output_format: 'jpg', safety_tolerance: 2, raw: true }, cfg);
  const photo = await download(url);
  const meta = await sharp(photo).metadata();
  const cut = await replicateRun(cfg.replicate_bg_model || 'bria/remove-background', { image: url }, cfg);
  const mask = await download(cut);
  const mm = await sharp(mask).metadata();
  const maskFit = (mm.width === meta.width && mm.height === meta.height) ? mask : await sharp(mask).resize(meta.width, meta.height, { fit: 'fill' }).png().toBuffer();
  const p = await printAreaFromMask(maskFit, meta.width, meta.height, spec.type);
  // Baskı alanı boş mu? (yapay zekâ yine de bir şey basmışsa bu fotoğrafı kullanma)
  const st = await sharp(photo).extract({ left: p.x, top: p.y, width: p.w, height: p.h }).greyscale().stats();
  if (st.channels[0].stdev > 28) throw new Error(`baskı alanı boş değil (σ=${st.channels[0].stdev.toFixed(0)})`);
  const file = `photo/${spec.key}.jpg`;
  fs.writeFileSync(path.join(PATHS.mockups, file), photo);
  return { file, type: spec.type, color: spec.color, dark: spec.dark, photo: true, size: { w: meta.width, h: meta.height }, print: p };
}

/** Fotoğraf mockup'ları yoksa bir kez üretir. Başarısız olursa boş dizi döner (çizim mockup'lar kullanılır). */
async function ensurePhotoMockups(cfg, costs = []) {
  if (cfg.photo_mockups === false) return [];
  const have = readManifest();
  const missing = SPECS.filter((s) => !have.some((m) => m.file === `photo/${s.key}.jpg`));
  if (!missing.length || !process.env.REPLICATE_API_TOKEN) return have;
  // Açık renk tişört + en az bir varyasyon varsa eksikleri otomatik yeniden deneme (para harcamasın)
  if (have.some((m) => !m.dark && m.type === 'tshirt') && have.length >= 2 && !cfg.photo_mockups_retry) return have;
  const failMark = path.join(DIR, '.last_fail');
  try { if (Date.now() - fs.statSync(failMark).mtimeMs < 6 * 3600e3 && have.length) return have; } catch {}
  fs.mkdirSync(DIR, { recursive: true });
  log(`Gerçekçi fotoğraf mockup'ları hazırlanıyor (${missing.length} adet, tek seferlik ~$${(missing.length * 0.08).toFixed(2)})...`);
  const out = [...have];
  let failed = 0;
  for (const spec of missing) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const m = await makeOne(spec, cfg);
        costs.push(0.06 + 0.018);
        out.push(m);
        fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2));
        log(`Fotoğraf mockup hazır: ${spec.color} ${spec.type}`, 'success');
        break;
      } catch (e) {
        costs.push(0.06);
        log(`Fotoğraf mockup (${spec.key}) deneme ${attempt}: ${describeError(e).slice(0, 120)}`, 'warn');
        if (e.fatal) { fs.writeFileSync(failMark, String(Date.now())); return out; }
        if (attempt === 2) failed++;
      }
    }
  }
  if (failed) fs.writeFileSync(failMark, String(Date.now()));
  return out;
}

module.exports = { ensurePhotoMockups, readPhotoManifest: readManifest, printAreaFromMask, SPECS };
