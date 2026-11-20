'use strict';
/**
 * Retro "halftone + eskitme baskı" efekti (Etsy'de en çok satan vintage tişört görünümü).
 *  - Alt kısım noktalarla (halftone) eriyerek kaybolur
 *  - Baskının içinde yer yer aşınmış/dökülmüş lekeler ve ince çizikler olur (eski tişörtten kalmış gibi)
 *  - Renkler hafifçe soldurulur
 * Girdi/çıktı: şeffaf PNG buffer.
 */
const sharp = require('sharp');

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }

async function noiseField(W, H, cell, seed, blur) {
  const w = Math.max(8, Math.round(W / cell)), h = Math.max(8, Math.round(H / cell));
  const b = Buffer.alloc(w * h);
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return sharp(b, { raw: { width: w, height: h, channels: 1 } }).resize(W, H, { kernel: 'cubic' }).blur(blur).extractChannel(0).raw().toBuffer();
}

/**
 * @param {Buffer} buf şeffaf PNG
 * @param {{fade?:number, distress?:number, seed?:number}} o fade: alttan erime oranı (0-0.5), distress: aşınma şiddeti (0-1)
 */
async function retroPrint(buf, { fade = 0.2, distress = 0.5, seed = Date.now() } = {}) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // Tasarımın dikey sınırları
  let y0 = H, y1 = 0;
  for (let y = 0; y < H; y++) { const row = y * W * 4; for (let x = 0; x < W; x += 4) if (data[row + x * 4 + 3] > 20) { if (y < y0) y0 = y; y1 = y; break; } }
  if (y1 <= y0) return buf;
  const hgt = y1 - y0;
  const fadeTop = y1 - hgt * fade;
  const cell = Math.max(9, Math.round(W / 120));          // nokta ızgarası
  const c45 = Math.SQRT1_2;
  // Aşınma dokuları: iri lekeler + ince çizik/benekler
  const big = await noiseField(W, H, Math.max(40, W / 25), seed, Math.max(8, W / 200));
  const fine = await noiseField(W, H, Math.max(3, W / 800), seed + 7, Math.max(0.8, W / 3000));
  // Eşikler yüzdelikten: iri lekeler alanın ~%9'u, ince benekler ~%6'sı (distress=0.6 için)
  const pct = (arr, q) => { const h = new Uint32Array(256); for (let i = 0; i < arr.length; i += 7) h[arr[i]]++; let tot = 0; for (const v of h) tot += v; let acc = 0; for (let v = 255; v >= 0; v--) { acc += h[v]; if (acc >= tot * q) return v; } return 255; };
  const tBig = pct(big, 0.45 * distress), tFine = pct(fine, 0.03 * distress);
  const spanB = Math.max(4, (255 - tBig) * 0.35);
  for (let y = y0; y <= y1; y++) {
    const inFade = y > fadeTop;
    const f = inFade ? Math.max(0, 1 - (y - fadeTop) / (y1 - fadeTop)) : 1; // 1 → 0
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      let a = data[o + 3];
      if (!a) continue;
      if (inFade) {
        // 45° döndürülmüş ızgarada noktalar: f küçüldükçe noktalar küçülür
        const u = (x + y) * c45, v = (x - y) * c45;
        const du = ((u % cell) + cell) % cell - cell / 2, dv = ((v % cell) + cell) % cell - cell / 2;
        const d = Math.sqrt(du * du + dv * dv) / (cell / 2);   // 0 merkez … 1.41 köşe
        const rr = Math.sqrt(f) * 1.45;
        const k = Math.max(0, Math.min(1, (rr - d) * cell / 2)); // yumuşak kenar
        a = Math.round(a * k);
      }
      // Eskitme: iri aşınma lekeleri ve ince benekler
      // iri alan "aşınmış bölge"leri belirler; orada ince benekler yoğunlaşır (delik açmaz, dokuyu aşındırır)
      const wear = big[i] > tBig ? Math.min(1, (big[i] - tBig) / spanB) : 0;
      const thr = tFine - wear * 70;
      if (fine[i] > thr) a = Math.round(a * 0.12);
      else if (wear > 0) a = Math.round(a * (1 - wear * 0.18));
      data[o + 3] = a;
      // Hafif soldurma (doygunluk −%12, siyahlar biraz açılır)
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const l = 0.3 * r + 0.59 * g + 0.11 * b;
      data[o] = Math.round((r * 0.88 + l * 0.12) * 0.96 + 8);
      data[o + 1] = Math.round((g * 0.88 + l * 0.12) * 0.96 + 8);
      data[o + 2] = Math.round((b * 0.88 + l * 0.12) * 0.96 + 8);
    }
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

module.exports = { retroPrint };
