'use strict';
/**
 * Test için yüksek çözünürlüklü (2700x2025, 4:3) boş mockup şablonları üretir:
 * beyaz/siyah/kum tişört, siyah/gri sweatshirt, beyaz kupa.
 * Ayrıca data/base_mockups/mockups.json (baskı alanı koordinatları) ve data/delivery_template.pdf oluşturur.
 *
 * Gerçek ürün fotoğrafı kullanmak istersen: fotoğrafı data/base_mockups/ içine koy ve mockups.json'a
 * { "file", "type", "color", "dark", "print": {x,y,w,h}, "blend" } satırı ekle.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PATHS, log } = require('./lib/core');

const W = 2700;
const H = 2025;

const TEE_PATH = 'M1150,300 C1215,395 1485,395 1550,300 L1900,390 L2240,705 L2025,915 L1895,805 L1895,1895 Q1350,1930 805,1895 L805,805 L675,915 L460,705 L800,390 Z';
const SWEAT_PATH = 'M1170,300 C1250,392 1450,392 1530,300 L1885,382 C2060,455 2170,800 2270,1650 L2085,1705 C2030,1300 1965,1010 1905,870 L1905,1885 L795,1885 L795,870 C735,1010 670,1300 615,1705 L430,1650 C530,800 640,455 815,382 Z';

function backdrop(bgA, bgB) {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/>
    </linearGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.06"/></feComponentTransfer>
    </filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="28"/>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="fabric" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="3" seed="3"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.10"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)"/>
  ${leaves(220, 1750, -20)}${leaves(2480, 260, 160)}`;
}

function leaves(cx, cy, rot) {
  let s = `<g transform="translate(${cx},${cy}) rotate(${rot})" opacity="0.85">`;
  s += '<path d="M0,0 C80,-120 160,-260 260,-420" stroke="#6b7f5e" stroke-width="10" fill="none"/>';
  const pts = [[60, -90, 30], [110, -170, -35], [160, -250, 35], [205, -330, -30], [245, -400, 25]];
  for (const [x, y, a] of pts) {
    s += `<ellipse cx="${x + (a > 0 ? 55 : -55)}" cy="${y}" rx="70" ry="38" transform="rotate(${a} ${x} ${y})" fill="#8fa382"/>`;
  }
  return s + '</g>';
}

function garmentSvg({ shape, fill, dark, sweat }) {
  const highlight = dark ? '#ffffff' : '#ffffff';
  const fold = dark ? '#000000' : '#5b5248';
  const p = shape;
  const rib = sweat ? `
    <g opacity="${dark ? 0.35 : 0.25}" stroke="${fold}" stroke-width="4">
      ${Array.from({ length: 56 }, (_, i) => `<line x1="${800 + i * 20}" y1="1800" x2="${800 + i * 20}" y2="1880"/>`).join('')}
    </g>
    <line x1="795" y1="1798" x2="1905" y2="1798" stroke="${fold}" stroke-opacity="0.35" stroke-width="5"/>
    <path d="M430,1650 L615,1705" stroke="${fold}" stroke-opacity="0.3" stroke-width="5"/>
    <path d="M2085,1705 L2270,1650" stroke="${fold}" stroke-opacity="0.3" stroke-width="5"/>
    <path d="M455,1560 L635,1610" stroke="${fold}" stroke-opacity="0.3" stroke-width="5"/>
    <path d="M2065,1610 L2245,1560" stroke="${fold}" stroke-opacity="0.3" stroke-width="5"/>` : '';
  const collar = sweat
    ? `<path d="M1170,300 C1250,392 1450,392 1530,300" stroke="${fold}" stroke-opacity="0.35" stroke-width="40" fill="none"/>
       <path d="M1170,300 C1250,392 1450,392 1530,300" stroke="${highlight}" stroke-opacity="${dark ? 0.08 : 0.4}" stroke-width="6" fill="none"/>`
    : `<path d="M1150,300 C1215,395 1485,395 1550,300" stroke="${fold}" stroke-opacity="0.3" stroke-width="30" fill="none"/>
       <path d="M1170,312 C1230,388 1470,388 1530,312" stroke="${fold}" stroke-opacity="0.18" stroke-width="6" fill="none"/>`;
  return `
  <g transform="translate(18,30)" opacity="${dark ? 0.55 : 0.35}"><path d="${p}" fill="#2b241c" filter="url(#shadow)"/></g>
  <clipPath id="g"><path d="${p}"/></clipPath>
  <path d="${p}" fill="${fill}"/>
  <g clip-path="url(#g)">
    <radialGradient id="lit" cx="0.45" cy="0.35" r="0.75">
      <stop offset="0" stop-color="${highlight}" stop-opacity="${dark ? 0.10 : 0.25}"/>
      <stop offset="1" stop-color="#000" stop-opacity="${dark ? 0.25 : 0.12}"/>
    </radialGradient>
    <rect width="${W}" height="${H}" fill="url(#lit)"/>
    <g filter="url(#soft)" fill="none" stroke-linecap="round">
      <path d="M900,1450 C1050,1500 1150,1480 1250,1560" stroke="${fold}" stroke-opacity="0.22" stroke-width="40"/>
      <path d="M1500,1600 C1600,1560 1700,1620 1820,1580" stroke="${fold}" stroke-opacity="0.18" stroke-width="36"/>
      <path d="M860,600 C900,800 880,1000 900,1200" stroke="${fold}" stroke-opacity="0.12" stroke-width="50"/>
      <path d="M1840,620 C1800,820 1830,1010 1800,1220" stroke="${fold}" stroke-opacity="0.12" stroke-width="50"/>
      <path d="M1000,1320 C1200,1360 1450,1340 1700,1380" stroke="${highlight}" stroke-opacity="${dark ? 0.05 : 0.35}" stroke-width="30"/>
    </g>
    <rect width="${W}" height="${H}" filter="url(#fabric)"/>
  </g>
  ${collar}${rib}`;
}

function mugSvg() {
  return `
  <ellipse cx="1350" cy="1660" rx="560" ry="70" fill="#2b241c" opacity="0.35" filter="url(#shadow)"/>
  <path d="M1790,780 C2120,760 2160,1360 1790,1380" stroke="#e9e7e2" stroke-width="95" fill="none"/>
  <path d="M1790,780 C2120,760 2160,1360 1790,1380" stroke="#000" stroke-opacity="0.08" stroke-width="20" fill="none"/>
  <linearGradient id="cyl" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#c9c6bf"/><stop offset="0.18" stop-color="#f7f6f2"/>
    <stop offset="0.45" stop-color="#ffffff"/><stop offset="0.8" stop-color="#e6e3dc"/><stop offset="1" stop-color="#b9b5ad"/>
  </linearGradient>
  <path d="M880,520 L880,1560 C880,1660 1820,1660 1820,1560 L1820,520 Z" fill="url(#cyl)"/>
  <ellipse cx="1350" cy="520" rx="470" ry="80" fill="#f2f0eb" stroke="#d3d0c8" stroke-width="6"/>
  <ellipse cx="1350" cy="530" rx="430" ry="62" fill="#5a3d2b"/>
  <ellipse cx="1350" cy="535" rx="430" ry="58" fill="#3b2619" opacity="0.6"/>
  <rect x="1050" y="560" width="70" height="1000" fill="#fff" opacity="0.35" filter="url(#soft)"/>`;
}

const MOCKUPS = [
  { file: 'tshirt_white.png', type: 'tshirt', color: 'White', dark: false, bg: ['#efe7dc', '#dccfbd'], fill: '#f6f5f1', shape: TEE_PATH, print: { x: 1050, y: 520, w: 600, h: 720 }, blend: 'multiply' },
  { file: 'sweatshirt_black.png', type: 'sweatshirt', color: 'Black', dark: true, bg: ['#e9e4dc', '#cfc6b8'], fill: '#1f2023', shape: SWEAT_PATH, sweat: true, print: { x: 1050, y: 560, w: 600, h: 720 }, blend: 'over' },
  { file: 'mug_white.png', type: 'mug', color: 'White', dark: false, bg: ['#e6ece8', '#c9d4ce'], mug: true, print: { x: 1110, y: 760, w: 480, h: 576 }, blend: 'multiply' },
  { file: 'tshirt_sand.png', type: 'tshirt', color: 'Sand', dark: false, bg: ['#e8eef0', '#cdd8dc'], fill: '#d8c6a6', shape: TEE_PATH, print: { x: 1050, y: 520, w: 600, h: 720 }, blend: 'multiply' },
  { file: 'tshirt_black.png', type: 'tshirt', color: 'Black', dark: true, bg: ['#f1ebe2', '#d9cdbd'], fill: '#1c1c1e', shape: TEE_PATH, print: { x: 1050, y: 520, w: 600, h: 720 }, blend: 'over' },
  { file: 'sweatshirt_heather.png', type: 'sweatshirt', color: 'Heather Grey', dark: false, bg: ['#efe5da', '#d6c5b3'], fill: '#bdbcbb', shape: SWEAT_PATH, sweat: true, print: { x: 1050, y: 560, w: 600, h: 720 }, blend: 'multiply' },
];

async function buildDeliveryTemplate() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 642, width: 612, height: 150, color: rgb(0.11, 0.12, 0.16) });
  page.drawText('THANK YOU FOR YOUR PURCHASE!', { x: 56, y: 722, size: 24, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Your high-resolution files are ready to download.', { x: 56, y: 692, size: 13, font: reg, color: rgb(0.85, 0.86, 0.9) });
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 40, color: rgb(0.95, 0.95, 0.96) });
  page.drawText('Digital download - no physical item will be shipped.', { x: 56, y: 15, size: 9, font: reg, color: rgb(0.4, 0.4, 0.45) });
  pdf.setTitle('Download Instructions Template');
  fs.writeFileSync(PATHS.deliveryTemplate, await pdf.save());
}

async function main() {
  fs.mkdirSync(PATHS.mockups, { recursive: true });
  const manifest = [];
  for (const m of MOCKUPS) {
    const body = m.mug ? mugSvg() : garmentSvg({ shape: m.shape, fill: m.fill, dark: m.dark, sweat: m.sweat });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${backdrop(m.bg[0], m.bg[1])}${body}</svg>`;
    const out = path.join(PATHS.mockups, m.file);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
    manifest.push({ file: m.file, type: m.type, color: m.color, dark: m.dark, print: m.print, blend: m.blend });
    log(`Mockup şablonu oluşturuldu: ${m.file}`);
  }
  fs.writeFileSync(path.join(PATHS.mockups, 'mockups.json'), JSON.stringify(manifest, null, 2));
  await buildDeliveryTemplate();
  log('delivery_template.pdf oluşturuldu');
  return manifest;
}

if (require.main === module) {
  require('./lib/core').bus.on('log', (e) => console.log(`[${e.level}] ${e.msg}`));
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { setupMockups: main, MOCKUPS };
