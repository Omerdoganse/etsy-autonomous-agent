'use strict';
/**
 * MODÜL 3 — Otomatik Mockup ve Video Motoru
 * 01_main_mockup.jpg      2700x2025 vitrin + "INSTANT DOWNLOAD | 300 DPI PNG" rozeti
 * 02/03_*_mockup.jpg      farklı renk/model (siyah sweatshirt, kupa vb.)
 * 04_bundle_info.jpg      paket içeriği + 4500x5400 / 300 DPI / şeffaf arka plan infografiği
 * 05_how_to_download.jpg  "Dijital ürün — kargo yok" bilgi görseli
 * listing_video.mp4       6 sn, 1920x1080, sessiz Ken Burns yakınlaştırma
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { loadConfig, log, PATHS, escapeXml, titleCase, checkStop } = require('./lib/core');
const { ensurePhotoMockups, readPhotoManifest } = require('./lib/photo_mockups');
const { readModelManifest } = require('./lib/model_mockups');

const CW = 2700, CH = 2025;
const FONT = 'Arial, Helvetica, DejaVu Sans, sans-serif';
const SERIF = 'Georgia, DejaVu Serif, serif';

function loadManifest() {
  const p = path.join(PATHS.mockups, 'mockups.json');
  if (!fs.existsSync(p)) throw Object.assign(new Error('data/base_mockups/mockups.json yok — önce "node src/setup_mockups.js" çalıştırın'), { noRetry: true });
  return JSON.parse(fs.readFileSync(p, 'utf8')).filter((m) => fs.existsSync(path.join(PATHS.mockups, m.file)));
}

/**
 * Fotoğraf mockup: tasarımı kumaşa "basılmış" gibi yerleştirir.
 * Kumaşın büyük ölçekli ışığı/kırışıkları (bulanık parlaklık) mürekkebi aydınlatıp karartır,
 * ince doku (yüksek frekans) mürekkebin üstüne geri eklenir.
 */
async function placePhoto(mock, designPath, W = CW, H = CH) {
  const k = W / mock.size.w;
  const P = { x: Math.round(mock.print.x * k), y: Math.round(mock.print.y * k), w: Math.round(mock.print.w * k), h: Math.round(mock.print.h * k) };
  const baseBuf = await sharp(path.join(PATHS.mockups, mock.file)).resize(W, H, { fit: 'cover' }).removeAlpha().png().toBuffer();
  const design = await sharp(designPath).resize(P.w, P.h, { fit: 'inside', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const dw = design.info.width, dh = design.info.height;
  const left = P.x + Math.round((P.w - dw) / 2), top = P.y;
  const regionImg = sharp(baseBuf).extract({ left, top, width: dw, height: dh });
  const B = await regionImg.clone().raw().toBuffer();
  const L = await regionImg.clone().greyscale().raw().toBuffer();
  const Lb = await regionImg.clone().greyscale().blur(Math.max(4, dw / 60)).raw().toBuffer();
  const D = design.data;
  let sum = 0, n = 0;
  for (let i = 0; i < dw * dh; i++) if (D[i * 4 + 3] > 20) { sum += Lb[i]; n++; }
  const mean = n ? sum / n : 128;
  const out = Buffer.from(B);
  for (let i = 0; i < dw * dh; i++) {
    const a = (D[i * 4 + 3] / 255) * 0.97;
    if (a <= 0) continue;
    const f = Math.min(1.18, Math.max(0.55, (Lb[i] + 8) / (mean + 8)));
    const grain = (L[i] - Lb[i]) * 0.7;
    for (let c = 0; c < 3; c++) {
      let ink = D[i * 4 + c] * f + grain;
      if (!mock.dark) ink = ink * (0.78 + 0.22 * B[i * 3 + c] / 255); // açık kumaşta hafif kumaş rengi geçişi
      ink = Math.max(0, Math.min(255, ink));
      out[i * 3 + c] = Math.round(B[i * 3 + c] * (1 - a) + ink * a);
    }
  }
  const printed = await sharp(out, { raw: { width: dw, height: dh, channels: 3 } }).png().toBuffer();
  return sharp(baseBuf).composite([{ input: printed, left, top }]).png().toBuffer();
}

/**
 * Gerçekçi baskı (modelli fotoğraflar): kumaş kıvrımlarına göre bükme (displacement), gövde kavisi,
 * kumaşın ışık/gölgesi ve dokusu mürekkebe işlenir, kenarlar hafif yumuşatılır → "üstüne yapıştırılmış" değil "basılmış" görünür.
 */
async function placePhotoReal(mock, designPath, W = CW, H = CH) {
  const k = W / mock.size.w;
  // Modelli (oversize tişört) fotoğraflarda baskı alanı çok satanlar gibi biraz daha büyük: üst kenar sabit, genişlik/yükseklik ×PS
  const PS = mock.model && /^(tee|sweat)_/.test(mock.key || '') ? 1.14 : 1;
  const pw = mock.print.w * PS, ph = mock.print.h * PS;
  const P = { x: Math.round((mock.print.x - (pw - mock.print.w) / 2) * k), y: Math.round(mock.print.y * k), w: Math.round(pw * k), h: Math.round(ph * k) };
  const baseBuf = await sharp(path.join(PATHS.mockups, mock.file)).resize(W, H, { fit: 'cover' }).removeAlpha().png().toBuffer();
  // Tasarımın etrafındaki şeffaf boşluk kırpılır → çizim baskı alanını gerçekten doldurur (küçük görünmez)
  let srcBuf = fs.readFileSync(designPath);
  try { const tr = await sharp(srcBuf).trim({ threshold: 10 }).png().toBuffer({ resolveWithObject: true }); if (tr.info.width > 200 && tr.info.height > 200) srcBuf = tr.data; } catch { /* kırpılamazsa olduğu gibi */ }
  const des = await sharp(srcBuf).resize(P.w, P.h, { fit: 'inside', kernel: 'lanczos3' }).ensureAlpha().blur(0.6).raw().toBuffer({ resolveWithObject: true });
  const dw = des.info.width, dh = des.info.height, D = des.data;
  const m = Math.round(Math.max(8, dw * 0.03));
  const left = Math.max(0, P.x + Math.round((P.w - dw) / 2) - m), top = Math.max(0, P.y - m);
  const rw = Math.min(W - left, dw + 2 * m), rh = Math.min(H - top, dh + 2 * m);
  const reg = sharp(baseBuf).extract({ left, top, width: rw, height: rh });
  const B = await reg.clone().raw().toBuffer();
  const L = await reg.clone().greyscale().raw().toBuffer();
  const Lb = await reg.clone().greyscale().blur(Math.max(2.5, dw / 110)).raw().toBuffer();
  const Ld = await reg.clone().greyscale().blur(Math.max(5, dw / 35)).raw().toBuffer();
  const sorted = Array.from(Lb).sort((a, b) => a - b);
  const hi = Math.max(60, sorted[Math.floor(sorted.length * 0.96)]);
  let mean = 0; for (let i = 0; i < Ld.length; i++) mean += Ld[i]; mean /= Ld.length;
  const S = dw * 0.022;               // kıvrım bükme gücü (px)
  const a = 0.55, sa = Math.sin(a);   // gövde kavisi
  const ox = left - (P.x + Math.round((P.w - dw) / 2) - m), oy = top - (P.y - m); // kenara kırpılma telafisi
  const samp = (x, y, c) => {
    if (x < 0 || y < 0 || x > dw - 1 || y > dh - 1) return c === 3 ? 0 : 255;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(dw - 1, x0 + 1), y1 = Math.min(dh - 1, y0 + 1), fx = x - x0, fy = y - y0;
    const g = (xx, yy) => D[(yy * dw + xx) * 4 + c];
    return (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
  };
  const out = Buffer.from(B);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const i = ry * rw + rx;
      const xo = rx + ox - m, yo = ry + oy - m; // tasarım koordinatı (bükmeden önce)
      const u = (xo - dw / 2) / (dw / 2);
      const t = Math.abs(u) < 1 ? Math.asin(Math.max(-1, Math.min(1, u * sa))) / a : u;
      const d = (Ld[i] - mean) / 128 * S;
      const sx = dw / 2 + t * dw / 2 + d * 0.6, sy = yo + d;
      // Gerçek DTF/serigrafi baskıda yarı saydam sis olmaz: alfa sertleştirilir (kenarlar net, soluk hale yok)
      const a0 = samp(sx, sy, 3) / 255;
      const al = Math.max(0, Math.min(1, (a0 - 0.22) / 0.56)) * 0.97;
      if (al <= 0.003) continue;
      const shade = Math.min(1.05, Math.max(0.55, Lb[i] / hi));
      const grain = (L[i] - Lb[i]) * 0.9;
      for (let c = 0; c < 3; c++) {
        let ink = samp(sx, sy, c) * 0.97 + 3;
        ink = mock.dark ? ink * Math.pow(shade, 0.9) + grain * 1.1   // koyu kumaş: mürekkep kumaş rengine karışmaz, doku daha belirgin
          : ink * Math.pow(shade, 1.1) * (0.9 + 0.1 * B[i * 3 + c] / 255) + grain;
        ink = Math.max(0, Math.min(255, ink));
        out[i * 3 + c] = Math.round(B[i * 3 + c] * (1 - al) + ink * al);
      }
    }
  }
  const printed = await sharp(out, { raw: { width: rw, height: rh, channels: 3 } }).png().toBuffer();
  return sharp(baseBuf).composite([{ input: printed, left, top }]).png().toBuffer();
}

/** Tasarımı mockup'ın baskı alanına giydirir; kumaş gölgelerini tasarım üzerine yansıtır. */
async function placeDesign(mock, designPath) {
  if (mock.photo) return placePhoto(mock, designPath);
  const base = sharp(path.join(PATHS.mockups, mock.file)).resize(CW, CH, { fit: 'cover' });
  const baseBuf = await base.png().toBuffer();
  const { x, y, w, h } = mock.print;
  const design = await sharp(designPath).resize(w, h, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
  const dm = await sharp(design).metadata();
  const left = x + Math.round((w - dm.width) / 2);
  const top = y + Math.round((h - dm.height) / 2);

  // Kumaş gölge haritası: baskı bölgesinin parlaklığı → tasarımın alfasıyla kırpılır → soft-light
  // (gri ton + tasarım alfası, ham RGBA olarak elle birleştirilir; yalnızca tasarım piksellerini etkiler)
  const region = await sharp(baseBuf).extract({ left, top, width: dm.width, height: dm.height })
    .greyscale().normalise().toColourspace('srgb').removeAlpha().raw().toBuffer();
  const alpha = await sharp(design).ensureAlpha().extractChannel(3).raw().toBuffer();
  const px = dm.width * dm.height;
  const rgba = Buffer.alloc(px * 4);
  for (let i = 0; i < px; i++) {
    const g = region[i * 3];
    rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = Math.round(alpha[i] * 0.7);
  }
  const shade = await sharp(rgba, { raw: { width: dm.width, height: dm.height, channels: 4 } }).png().toBuffer();
  // Açık kumaşta multiply (doku görünür), koyu kumaşta normal baskı + gölge haritası
  const ink = design;
  return sharp(baseBuf)
    .composite([
      { input: ink, left, top, blend: mock.blend === 'multiply' ? 'multiply' : 'over' },
      { input: shade, left, top, blend: 'soft-light' },
    ])
    .png().toBuffer();
}

function badgeSvg() {
  const bw = 1060, bh = 150;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${bw + 40}" height="${bh + 40}">
    <defs><filter id="s" x="-10%" y="-10%" width="130%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-opacity="0.35"/></filter>
    <linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#111827"/></linearGradient></defs>
    <rect x="20" y="14" width="${bw}" height="${bh}" rx="${bh / 2}" fill="url(#g)" filter="url(#s)"/>
    <circle cx="${20 + bh / 2}" cy="${14 + bh / 2}" r="52" fill="#f97316"/>
    <path d="M${20 + bh / 2},${14 + bh / 2 - 26} v40 m-20,-18 l20,22 l20,-22" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${20 + bh + 20}" y="${14 + bh / 2 + 16}" font-family="${FONT}" font-weight="bold" font-size="44" fill="#ffffff" textLength="${bw - bh - 60}" lengthAdjust="spacingAndGlyphs">INSTANT DOWNLOAD <tspan fill="#9ca3af" font-weight="normal">|</tspan> <tspan fill="#fdba74">300 DPI PNG</tspan></text>
  </svg>`);
}

function titleRibbon(text) {
  const t = escapeXml(text.length > 46 ? `${text.slice(0, 44)}…` : text);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="200">
    <rect x="0" y="0" width="${CW}" height="160" fill="#ffffff" fill-opacity="0.82"/>
    <text x="${CW / 2}" y="105" text-anchor="middle" font-family="${SERIF}" font-weight="bold" font-size="76" fill="#1f2937">${t}</text>
  </svg>`);
}

async function mainMockup(mock, designPath, outPath, label) {
  const placed = await placeDesign(mock, designPath);
  const badge = badgeSvg();
  const bm = await sharp(badge).metadata();
  const layers = [{ input: badge, left: CW - bm.width - 50, top: CH - bm.height - 50 }];
  if (label) layers.push({ input: titleRibbon(label), left: 0, top: 0 });
  await sharp(placed).composite(layers).jpeg({ quality: 92, mozjpeg: true }).withMetadata({ density: 300 }).toFile(outPath);
  return outPath;
}

async function variantMockup(mock, designPath, outPath, prefix = '') {
  const placed = await placeDesign(mock, designPath);
  const txt = `${prefix ? `${prefix} · ` : ''}${mock.color} ${titleCase(mock.type)}`;
  const tw = Math.max(500, Math.round(txt.length * 26 + 120));
  const tag = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="130">
    <rect x="0" y="0" width="${tw}" height="110" rx="55" fill="#111827" fill-opacity="0.85"/>
    <text x="${tw / 2}" y="72" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="44" fill="#fff">${escapeXml(txt)}</text></svg>`);
  await sharp(placed).composite([{ input: tag, left: 60, top: CH - 190 }]).jpeg({ quality: 92, mozjpeg: true }).toFile(outPath);
  return outPath;
}

async function checkerboard(w, h, cell = 40) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
      <rect width="${cell * 2}" height="${cell * 2}" fill="#ffffff"/><rect width="${cell}" height="${cell}" fill="#e5e7eb"/>
      <rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#e5e7eb"/></pattern></defs>
    <rect width="${w}" height="${h}" rx="40" fill="url(#c)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function bundleInfo(pngs, cfg, title, outPath) {
  const n = pngs.length;
  const gridW = 1500, gridH = 1700, gx = 110, gy = 220;
  const cols = n === 1 ? 1 : 2, rows = Math.ceil(n / cols);
  const cellW = Math.floor((gridW - (cols + 1) * 30) / cols), cellH = Math.floor((gridH - (rows + 1) * 30) / rows);
  const layers = [{ input: await checkerboard(gridW, gridH), left: gx, top: gy }];
  for (let i = 0; i < n; i++) {
    const thumb = await sharp(pngs[i]).resize(cellW, cellH, { fit: 'inside' }).png().toBuffer();
    const tm = await sharp(thumb).metadata();
    const cx = gx + 30 + (i % cols) * (cellW + 30) + Math.floor((cellW - tm.width) / 2);
    const cy = gy + 30 + Math.floor(i / cols) * (cellH + 30) + Math.floor((cellH - tm.height) / 2);
    layers.push({ input: thumb, left: cx, top: cy });
  }
  const chips = [
    ['📦', `${n} PNG DESIGN${n > 1 ? 'S' : ''}`, n > 1 ? 'Bundle in one ZIP file' : 'Single design ZIP file'],
    ['📐', `${cfg.output_width} x ${cfg.output_height} PX`, 'Perfect 15" x 18" print size'],
    ['🖨', `${cfg.dpi} DPI`, 'High resolution, print ready'],
    ['◻', 'TRANSPARENT', 'Background removed PNG'],
    ['⚡', 'INSTANT DOWNLOAD', 'No physical item shipped'],
  ];
  const chipSvg = chips.map(([, h1, h2], i) => {
    const y = 260 + i * 330;
    return `<g transform="translate(1720,${y})">
      <rect width="880" height="280" rx="36" fill="#ffffff" stroke="#e5e7eb" stroke-width="4"/>
      <circle cx="140" cy="140" r="86" fill="${['#fde68a', '#bfdbfe', '#c7f9cc', '#e9d5ff', '#fed7aa'][i]}"/>
      <text x="140" y="168" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="70" fill="#111827">${['#', '↔', 'DPI', '◇', '↓'][i]}</text>
      <text x="270" y="130" font-family="${FONT}" font-weight="bold" font-size="${h1.length > 13 ? 50 : 60}" fill="#111827">${escapeXml(h1)}</text>
      <text x="270" y="200" font-family="${FONT}" font-size="40" fill="#6b7280">${escapeXml(h2)}</text></g>`;
  }).join('');
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
    <rect width="${CW}" height="${CH}" fill="#f8f5f0"/>
    <text x="110" y="150" font-family="${SERIF}" font-weight="bold" font-size="92" fill="#111827">WHAT YOU GET</text>
    <text x="${CW - 100}" y="150" text-anchor="end" font-family="${FONT}" font-size="46" fill="#9a3412">${escapeXml(title.split(',')[0].slice(0, 48))}</text>
    ${chipSvg}</svg>`);
  await sharp(bg).composite(layers).jpeg({ quality: 92, mozjpeg: true }).toFile(outPath);
  return outPath;
}

async function howToDownload(outPath) {
  const steps = [
    ['1', 'PURCHASE', 'Complete your order on Etsy'],
    ['2', 'GO TO PURCHASES', 'Profile → Purchases and reviews'],
    ['3', 'DOWNLOAD FILES', 'Click "Download files" and save the ZIP'],
    ['4', 'UNZIP & PRINT', 'Extract and use your PNG files'],
  ];
  const stepSvg = steps.map(([n, h1, h2], i) => {
    const x = 120 + i * 630;
    return `<g transform="translate(${x},700)">
      <rect width="580" height="720" rx="40" fill="#ffffff" stroke="#e5e7eb" stroke-width="4"/>
      <circle cx="290" cy="190" r="110" fill="#f97316"/>
      <text x="290" y="228" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="110" fill="#fff">${n}</text>
      <text x="290" y="420" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="50" fill="#111827">${escapeXml(h1)}</text>
      <text x="290" y="500" text-anchor="middle" font-family="${FONT}" font-size="34" fill="#4b5563">${escapeXml(h2)}</text></g>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
    <rect width="${CW}" height="${CH}" fill="#f8f5f0"/>
    <text x="${CW / 2}" y="250" text-anchor="middle" font-family="${SERIF}" font-weight="bold" font-size="120" fill="#111827">HOW TO DOWNLOAD</text>
    <rect x="${CW / 2 - 1050}" y="350" width="2100" height="220" rx="30" fill="#fee2e2" stroke="#ef4444" stroke-width="6"/>
    <text x="${CW / 2}" y="445" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="72" fill="#b91c1c">THIS IS A DIGITAL PRODUCT</text>
    <text x="${CW / 2}" y="525" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="52" fill="#7f1d1d">NO PHYSICAL ITEM WILL BE SHIPPED</text>
    ${stepSvg}
    <text x="${CW / 2}" y="1620" text-anchor="middle" font-family="${FONT}" font-size="46" fill="#374151">Files are available instantly after payment. Mockups are for display only.</text>
    <text x="${CW / 2}" y="1700" text-anchor="middle" font-family="${FONT}" font-size="46" fill="#374151">Tip: download on a computer for the easiest unzipping.</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 92, mozjpeg: true }).toFile(outPath);
  return outPath;
}

/* ---------------- Video ---------------- */
function ffmpegPath() {
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch { /* yok */ }
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

async function kenBurnsVideo(imagePath, outPath, seconds = 6) {
  const frame = path.join(path.dirname(outPath), '.video_frame.png');
  // 4K tuval (bulanık arka plan + ortada görsel) → zoompan titremesini azaltır
  const bg = await sharp(imagePath).resize(3840, 2160, { fit: 'cover' }).blur(40).modulate({ brightness: 0.85 }).toBuffer();
  const fg = await sharp(imagePath).resize(3840, 2160, { fit: 'inside' }).toBuffer();
  const fm = await sharp(fg).metadata();
  await sharp(bg).composite([{ input: fg, left: Math.floor((3840 - fm.width) / 2), top: Math.floor((2160 - fm.height) / 2) }]).png().toFile(frame);
  const fps = 30, frames = seconds * fps;
  const vf = `zoompan=z='min(1+0.18*on/${frames},1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${fps},format=yuv420p`;
  const args = ['-y', '-loop', '1', '-i', frame, '-vf', vf, '-t', String(seconds), '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-an', outPath];

  let ff = null;
  try { ff = require('fluent-ffmpeg'); } catch { /* yedek: doğrudan spawn */ }
  try {
    if (ff) {
      ff.setFfmpegPath(ffmpegPath());
      await new Promise((resolve, reject) => {
        ff(frame).inputOptions(['-loop 1']).videoFilters(vf).outputOptions(['-t', String(seconds), '-r', String(fps), '-c:v libx264', '-preset veryfast', '-crf 20', '-movflags +faststart', '-an'])
          .on('end', resolve).on('error', reject).save(outPath);
      });
    } else {
      await new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg çıkış kodu ${code}: ${err.slice(-400)}`))));
      });
    }
  } finally { if (fs.existsSync(frame)) fs.unlinkSync(frame); }
  return outPath;
}


/* ---------------- Paket kapak görseli (tüm PNG'ler birlikte) ---------------- */
function coverPalette(trend) {
  const t = `${trend.season || ''} ${trend.keyword || ''} ${trend.niche || ''}`.toLowerCase();
  if (/christmas|xmas|holiday|santa|winter|hanukkah|new year/.test(t)) return { bg1: '#1f3b2d', bg2: '#2f5a43', panel: '#fdf8ef', accent: '#c0392b', text: '#fdf8ef', sub: '#f3d9a4' };
  if (/thanksgiving|turkey|fall|autumn|pumpkin|harvest/.test(t)) return { bg1: '#7a3e1d', bg2: '#b5652b', panel: '#fff7ec', accent: '#7a3e1d', text: '#fff7ec', sub: '#ffd9a8' };
  if (/halloween|spooky|witch|ghost/.test(t)) return { bg1: '#1d1630', bg2: '#3a2858', panel: '#fbf6ff', accent: '#f97316', text: '#fbf6ff', sub: '#fdba74' };
  if (/valentine|love|heart/.test(t)) return { bg1: '#8e2147', bg2: '#c23b65', panel: '#fff5f8', accent: '#8e2147', text: '#fff5f8', sub: '#ffd0de' };
  if (/easter|spring/.test(t)) return { bg1: '#4f6d5a', bg2: '#7fa287', panel: '#fbfff8', accent: '#4f6d5a', text: '#fbfff8', sub: '#e6f2d9' };
  return { bg1: '#2b2f3a', bg2: '#454b5c', panel: '#faf8f4', accent: '#b45309', text: '#faf8f4', sub: '#fcd9a8' };
}

function wrapWords(text, max) {
  const lines = []; let cur = '';
  for (const w of text.split(/\s+/)) {
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= max) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function bundleCover(pngs, trend, cfg, outPath, label) {
  const n = Math.min(pngs.length, 4);
  const pal = coverPalette(trend);
  // Kart yerleşimi (sol ~%58): 1 → tek büyük, 2 → yan yana, 3–4 → 2x2
  const CARD_W = n === 1 ? 1180 : 700, CARD_H = Math.round(CARD_W * 1.2);
  const cols = n === 1 ? 1 : 2, rows = n <= 2 ? 1 : 2, gap = 44;
  const gridW = cols * CARD_W + (cols - 1) * gap, gridH = rows * CARD_H + (rows - 1) * gap;
  const gx = 90 + Math.round((1500 - gridW) / 2), gy = Math.round((CH - gridH) / 2);
  const cards = [];
  for (let i = 0; i < n; i++) {
    let c = i % cols, r = Math.floor(i / cols);
    let x = gx + c * (CARD_W + gap);
    if (n === 3 && i === 2) x = gx + Math.round((gridW - CARD_W) / 2); // son kart ortada
    cards.push({ x, y: gy + r * (CARD_H + gap) });
  }
  const shadows = cards.map((k) => `<rect x="${k.x + 6}" y="${k.y + 18}" width="${CARD_W}" height="${CARD_H}" rx="34" fill="#000" fill-opacity=".28" filter="url(#b)"/><rect x="${k.x}" y="${k.y}" width="${CARD_W}" height="${CARD_H}" rx="34" fill="${pal.panel}"/>`).join('');
  // Sağ panel metinleri
  const name = titleCase(label || trend.niche || 'Design Bundle');
  const tx = 1640, tw = CW - tx - 90;
  let lines = wrapWords(name, 12);
  if (lines.length > 3) lines = wrapWords(name, 17).slice(0, 4);
  const longest = Math.max(...lines.map((l) => l.length));
  const fs = Math.min(132, Math.floor(tw / (longest * 0.64)));
  const titleY = 430 - (lines.length - 2) * fs * 0.5;
  const titleSvg = lines.map((l, i) => `<text x="${tx}" y="${Math.round(titleY + i * fs * 1.08)}" font-family="${SERIF}" font-weight="bold" font-size="${fs}" fill="${pal.text}">${escapeXml(l)}</text>`).join('');
  const afterTitle = Math.round(titleY + (lines.length - 1) * fs * 1.08 + 90);
  const countTxt = `${pngs.length} PNG DESIGN${pngs.length > 1 ? 'S' : ''}${pngs.length > 1 ? ' BUNDLE' : ''}`;
  const feats = ['300 DPI · High Resolution', `${cfg.output_width || 4500} x ${cfg.output_height || 5400} px`, 'Transparent Background', 'Sublimation · DTF · Print'];
  const featSvg = feats.map((f, i) => `<g transform="translate(${tx},${afterTitle + 200 + i * 92})"><circle cx="22" cy="-16" r="15" fill="${pal.sub}"/><path d="M14,-16 l6,7 l12,-14" stroke="${pal.bg1}" stroke-width="5" fill="none" stroke-linecap="round"/><text x="60" y="0" font-family="${FONT}" font-size="50" fill="${pal.text}">${escapeXml(f)}</text></g>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal.bg1}"/><stop offset="1" stop-color="${pal.bg2}"/></linearGradient>
    <filter id="b" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="18"/></filter></defs>
    <rect width="${CW}" height="${CH}" fill="url(#g)"/>
    ${shadows}
    ${titleSvg}
    <rect x="${tx}" y="${afterTitle}" width="${Math.min(tw, countTxt.length * 34 + 90)}" height="112" rx="56" fill="${pal.sub}"/>
    <text x="${tx + 45}" y="${afterTitle + 74}" font-family="${FONT}" font-weight="bold" font-size="56" fill="${pal.bg1}">${escapeXml(countTxt)}</text>
    ${featSvg}
  </svg>`;
  const layers = [];
  for (let i = 0; i < n; i++) {
    const pad = 48;
    const src = await sharp(pngs[i]).trim({ threshold: 1 }).png().toBuffer().catch(() => pngs[i]);
    const t = await sharp(src).resize(CARD_W - pad * 2, CARD_H - pad * 2, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
    const m = await sharp(t).metadata();
    layers.push({ input: t, left: cards[i].x + Math.round((CARD_W - m.width) / 2), top: cards[i].y + Math.round((CARD_H - m.height) / 2) });
  }
  const badge = badgeSvg();
  const bm = await sharp(badge).metadata();
  layers.push({ input: badge, left: CW - bm.width - 50, top: CH - bm.height - 50 });
  await sharp(Buffer.from(svg)).composite(layers).jpeg({ quality: 92, mozjpeg: true }).withMetadata({ density: 300 }).toFile(outPath);
  return outPath;
}


/** Modelin üzerinde (kendi oranında) baskılı fotoğraf; genişlik W */
async function placeOnModel(mock, designPath, W) {
  const H = Math.round(W * mock.size.h / mock.size.w);
  return { buf: await placePhotoReal(mock, designPath, W, H), W, H, k: W / mock.size.w };
}

const roundMask = (w, h, r) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="#fff"/></svg>`);

/**
 * Kapak: solda büyük model fotoğrafı (1. tasarım), sağda diğer tasarımlar küçük model fotoğraflarında.
 * Yazı yok (sadece küçük "instant download" rozeti).
 */
async function modelCover(models, pngs, trend, outPath) {
  models = [...models];
  const G = 34;
  const pal = coverPalette(trend);
  // Çok satanlar gibi tek büyük fotoğraf (kolaj yok); eski düzen için config.cover_layout = 'collage'
  const single = loadConfig().cover_layout !== 'collage';
  const thumbs = single ? [] : pngs.slice(1, 4);
  const leftW = thumbs.length ? 1560 : CW;
  const layers = [];
  // Mevsime uygun ana model (Noel ağaçlı/kafe yalnızca Noel ürünlerinde), ürüne göre değişsin (hepsi aynı görünmesin)
  const t = `${trend.season || ''} ${trend.keyword || ''} ${trend.niche || ''}`.toLowerCase();
  const xmas = /christmas|xmas|holiday|santa|winter|snow|new year/.test(t);
  // Tasarım koyuysa koyu kumaşa koyma (çok satanlar: açık tasarım koyu tişörtte, koyu tasarım açık tişörtte)
  const lum = await sharp(pngs[0]).resize(48, 48, { fit: 'inside' }).ensureAlpha().raw().toBuffer().then((b) => { let s = 0, n = 0; for (let i = 0; i < b.length; i += 4) if (b[i + 3] > 128) { s += 0.3 * b[i] + 0.59 * b[i + 1] + 0.11 * b[i + 2]; n++; } return n ? s / n : 128; }).catch(() => 128);
  const fits = models.filter((m) => (xmas || !(m.xmas || /tree|cafe/.test(m.key || m.file))) && !(m.dark && lum < 95));
  const pool = fits.length ? fits : models;
  let h = 0; for (const ch of `${trend.niche || ''}${trend.keyword || ''}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Ana fotoğraf: çok satanlar gibi bol kesim renkli tişört/sweatshirt (varsa); atletler küçük karelerde çeşitlilik için
  const tees = pool.filter((m) => /^(tee|sweat)_/.test(m.key || ''));
  const m0 = (tees.length ? tees : pool)[h % (tees.length || pool.length)];
  const rest = pool.length > 1 ? pool.filter((m) => m !== m0) : models.filter((m) => m !== m0); // Noel dışı ürünlerde küçük karelerde de Noel ağacı çıkmasın
  models = [m0, ...(rest.length ? rest : [m0])];
  const used = [];
  // Sol büyük fotoğraf: 1. tasarım; yüz görünsün diye kırpma biraz yukarıdan
  // Yakın plan (çok satanlar gibi): baskı alanı panel yüksekliğinin ~%40'ını kaplasın
  // Tek fotoğrafta baskı daha yakından: baskı alanı yüksekliğin ~%52'si (göğüs kadrajı, baskı net seçilir)
  const frac = single ? 0.52 : 0.40;
  const bigW = Math.round(Math.max(leftW + 100, Math.min(m0.size.w * 2.6, (frac * CH / m0.print.h) * m0.size.w)));
  const big = await placeOnModel(m0, pngs[0], bigW);
  const pcx = (m0.print.x + m0.print.w / 2) * big.k, pcy = (m0.print.y + m0.print.h / 2) * big.k;
  const cropH = Math.min(big.H, CH), cropW = Math.min(big.W, leftW);
  const cl = Math.round(Math.max(0, Math.min(big.W - cropW, pcx - cropW / 2)));
  const ct = Math.round(Math.max(0, Math.min(big.H - cropH, pcy - cropH * 0.5)));
  let leftImg = await sharp(big.buf).extract({ left: cl, top: ct, width: cropW, height: cropH }).resize(leftW, CH, { fit: 'cover' }).png().toBuffer();
  layers.push({ input: leftImg, left: 0, top: 0 });
  // Sağ sütun: diğer tasarımlar diğer modellerde, göğüs bölgesi yakın plan
  if (thumbs.length) {
    const tw = CW - leftW - 2 * G;
    const th = Math.floor((CH - (thumbs.length + 1) * G) / thumbs.length);
    for (let i = 0; i < thumbs.length; i++) {
      // Küçük kareler de renkli tişörtlerde (çok satanlar gibi); koyu tasarım koyu kumaşa konmaz
      const tl = await sharp(thumbs[i]).resize(48, 48, { fit: 'inside' }).ensureAlpha().raw().toBuffer().then((b) => { let s2 = 0, n = 0; for (let j = 0; j < b.length; j += 4) if (b[j + 3] > 128) { s2 += 0.3 * b[j] + 0.59 * b[j + 1] + 0.11 * b[j + 2]; n++; } return n ? s2 / n : 128; }).catch(() => 128);
      const cand = (tees.length > 2 ? tees : models).filter((x) => x !== m0 && !used.includes(x) && !(x.dark && tl < 95) && (xmas || !(x.xmas || /tree|cafe/.test(x.key || ''))));
      const m = cand[(h + i) % Math.max(1, cand.length)] || models[(i + 1) % models.length];
      used.push(m);
      const zoom = (th * 0.82) / (m.print.h * (tw / m.size.w) * 1.0); // baskı alanı kutunun ~%82'si
      const W = Math.round(Math.max(tw, tw * zoom));
      const ph = await placeOnModel(m, thumbs[i], W);
      const cx = (m.print.x + m.print.w / 2) * ph.k, cy = (m.print.y + m.print.h / 2) * ph.k;
      const L = Math.round(Math.max(0, Math.min(ph.W - tw, cx - tw / 2)));
      const T = Math.round(Math.max(0, Math.min(ph.H - th, cy - th / 2)));
      const cell = await sharp(ph.buf).extract({ left: L, top: T, width: Math.min(tw, ph.W), height: Math.min(th, ph.H) })
        .resize(tw, th, { fit: 'cover' }).composite([{ input: roundMask(tw, th, 36), blend: 'dest-in' }]).png().toBuffer();
      layers.push({ input: cell, left: leftW + G, top: G + i * (th + G) });
    }
  }
  const badge = badgeSvg();
  const bm = await sharp(badge).metadata();
  const bscale = 0.72;
  const badgeSm = await sharp(badge).resize(Math.round(bm.width * bscale)).png().toBuffer();
  layers.push({ input: badgeSm, left: 40, top: CH - Math.round(bm.height * bscale) - 40 });
  await sharp({ create: { width: CW, height: CH, channels: 3, background: pal.bg1 || '#2b2f3a' } })
    .composite(layers).jpeg({ quality: 92, mozjpeg: true }).withMetadata({ density: 300 }).toFile(outPath);
  return outPath;
}

/* ---------------- Ana fonksiyon ---------------- */
async function createMockups({ pngs, trend, dir, title, costs = [], dryRun = false }) {
  const cfg = loadConfig();
  let manifest = loadManifest();
  // Gerçekçi fotoğraf mockup'ları varsa (veya bir kez üretilebiliyorsa) onları kullan
  try {
    const photos = dryRun ? readPhotoManifest() : await ensurePhotoMockups(cfg, costs);
    if (photos.some((m) => !m.dark && m.type === 'tshirt')) manifest = photos;
  } catch (e) { log(`Fotoğraf mockup kullanılamadı, çizim mockup'a dönülüyor: ${String(e.message || e).slice(0, 100)}`, 'warn'); }
  if (!manifest.length) throw Object.assign(new Error('data/base_mockups içinde mockup bulunamadı'), { noRetry: true });
  const mdir = path.join(dir, 'mockups');
  fs.mkdirSync(mdir, { recursive: true });

  const garments = manifest.filter((m) => m.type !== 'mug');
  const lightTee = garments.find((m) => !m.dark && m.type === 'tshirt') || manifest[0];
  const dark = manifest.find((m) => m.dark && m !== lightTee);
  const mug = manifest.find((m) => m.type === 'mug');
  const others = manifest.filter((m) => m !== lightTee);
  const v2 = dark || others[0] || lightTee;
  const v3 = (mug && mug !== v2) ? mug : (others.find((m) => m !== v2 && m.type !== lightTee.type) || others.find((m) => m !== v2) || lightTee);

  const label = titleCase(trend.niche);
  const images = [];
  checkStop();
  // Önceki çalıştırmadan kalan vitrin görsellerini temizle (sıra/isim değişmiş olabilir)
  for (const f of fs.readdirSync(mdir)) if (/\.(jpe?g|png)$/i.test(f)) { try { fs.unlinkSync(path.join(mdir, f)); } catch {} }
  const nm = (i, name) => path.join(mdir, `${String(i).padStart(2, '0')}_${name}.jpg`);
  let idx = 1;
  const models = cfg.model_cover === false ? [] : readModelManifest();
  if (cfg.cover_style !== 'mockup' && pngs.length > 1) {
    // 1) Kapak: modelli (varsa) — 1. tasarım büyük, diğerleri sağda küçük model fotoğraflarında; 2) tüm PNG'ler bir arada
    let extra = 0;
    if (models.length) {
      try {
        images.push(await modelCover(models, pngs, trend, nm(idx++, 'main_model')));
        log('Kapak görseli hazır: modelli tişört kapağı', 'success');
        images.push(await bundleCover(pngs, trend, cfg, nm(idx++, 'all_designs'), label));
        extra = 1;
      } catch (e) {
        log(`Modelli kapak yapılamadı, kolaj kapak kullanılıyor: ${String(e.message).slice(0, 100)}`, 'warn');
        images.length = 0; idx = 1;
      }
    }
    if (!images.length) images.push(await bundleCover(pngs, trend, cfg, nm(idx++, 'main_mockup'), label));
    log(`Kapak görseli hazır: ${pngs.length} tasarım bir arada (2700x2025)`, 'success');
    // 2) Her tasarım ayrı ayrı tişörtte (renkler sırayla), 3) boş kalan yerlere diğer renklerde tekrar
    const tees = [lightTee, ...others.filter((m) => m.type !== 'mug')];
    const maxMock = Math.max(1, Math.min(cfg.max_images || 10, 10) - 3 - extra); // kapak + bilgi + indirme dışında kalan
    const plan = [];
    for (let i = 0; i < pngs.length; i++) plan.push([i, tees[i % tees.length]]);
    for (let r = 1; plan.length < maxMock && r < tees.length + 1; r++) {
      for (let i = 0; i < pngs.length && plan.length < maxMock; i++) {
        const t = tees[(i + r) % tees.length];
        if (!plan.some(([j, m]) => j === i && m === t)) plan.push([i, t]);
      }
      if (tees.length < 2) break;
    }
    for (const [i, t] of plan.slice(0, maxMock)) {
      checkStop();
      images.push(i === 0 && t === lightTee
        ? await mainMockup(t, pngs[i], nm(idx++, `design${i + 1}_${t.color.replace(/\s+/g, '').toLowerCase()}`), label)
        : await variantMockup(t, pngs[i], nm(idx++, `design${i + 1}_${t.color.replace(/\s+/g, '').toLowerCase()}`), `Design ${i + 1}`));
    }
    log(`Mockup giydirildi: ${plan.slice(0, maxMock).length} tişört görseli`, 'success');
  } else {
    images.push(await mainMockup(lightTee, pngs[0], nm(idx++, 'main_mockup'), label));
    log('Mockup giydirildi: ana vitrin görseli (2700x2025)', 'success');
    checkStop();
    images.push(await variantMockup(v2, pngs[Math.min(1, pngs.length - 1)], nm(idx++, 'variant_mockup')));
    checkStop();
    images.push(await variantMockup(v3, pngs[Math.min(2, pngs.length - 1)], nm(idx++, 'variant_mockup')));
    log('Mockup giydirildi: renk/model varyasyonları', 'success');
  }
  checkStop();
  images.push(await bundleInfo(pngs, cfg, title || label, nm(idx++, 'bundle_info')));
  images.push(await howToDownload(nm(idx++, 'how_to_download')));
  log('İnfografik ve indirme bilgi görseli hazır');
  checkStop();
  log('Listeleme videosu üretiliyor (6 sn, 1080p Ken Burns)...');
  const video = await kenBurnsVideo(images[0], path.join(dir, 'listing_video.mp4'));
  log('Video hazır: listing_video.mp4', 'success');
  return { images, video, thumbnail: images[0] };
}

module.exports = { createMockups, bundleCover, modelCover, placeDesign, kenBurnsVideo, ffmpegPath };
