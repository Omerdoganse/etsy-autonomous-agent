'use strict';
/**
 * Yayındaki/taslaktaki Etsy ilanlarına modelli kapak ekler:
 *  - ürün klasöründeki tasarımlarla modelli kapak üretilir (mockups/00_model_cover.jpg)
 *  - ilan düzenleyicide yüklenir ve 1. sıraya taşınır (eski kapak 2. sıraya kayar, hiçbir fotoğraf silinmez)
 *  - "tank top png" etiketi eklenir (13 etiket doluysa en zayıf genel etiketin yerine)
 *  - Yayındaki ilan "Publish changes", taslak "Save draft" ile kaydedilir
 * Yapılanlar data/cover_updates.json'a yazılır; tekrar çalıştırılınca atlanır.
 */
const fs = require('fs');
const path = require('path');
const { log, PATHS, checkStop, loadConfig } = require('./core');

const DONE = path.join(PATHS.data, 'cover_updates.json');
const readDone = () => { try { return JSON.parse(fs.readFileSync(DONE, 'utf8')); } catch { return {}; } };
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TAG = 'tank top png';
const WEAK = ['transparent png', 'clipart png', 'winter shirt png', 'holiday sublimation', 'commercial use png', 'print on demand', 'cricut design', 'digital download', 'png bundle'];

function productIndex() {
  const idx = {};
  for (const d of fs.readdirSync(PATHS.output)) {
    const f = path.join(PATHS.output, d, 'seo_metadata.json');
    if (!fs.existsSync(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      const dir = path.join(PATHS.output, d);
      if (m.title) {
        idx[norm(m.title)] = dir;
        // Başlık sonradan düzeltilmiş olabilir: ilk bölüm ("Retro Thanksgiving PNG") ile de eşle (tekse)
        const head = `#${norm(String(m.title).split(',')[0])}`;
        idx[head] = idx[head] && idx[head] !== dir ? 'AMBIGUOUS' : dir;
      }
    } catch {}
  }
  return idx;
}

async function buildCover(dir) {
  const { modelCover } = require('../03_mockup_engine');
  const { readModelManifest } = require('./model_mockups');
  const models = readModelManifest();
  if (!models.length) throw new Error('modelli mockup fotoğrafı yok');
  const trend = JSON.parse(fs.readFileSync(path.join(dir, 'trend.json'), 'utf8'));
  const dd = path.join(dir, 'designs');
  const pngs = fs.readdirSync(dd).filter((x) => /\.png$/i.test(x)).sort().map((x) => path.join(dd, x));
  if (!pngs.length) throw new Error('tasarım bulunamadı');
  const out = path.join(dir, 'mockups', '00_model_cover.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await modelCover(models, pngs, trend, out);
  return out;
}

const imageIds = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-roledescription="sortable"]')]
  .filter((e) => e.id && e.querySelector('img') && /listing image/i.test(e.querySelector('img').alt || '')).map((e) => e.id));

async function updateOne(page, id, idx, forced = null) {
  const pub = require('../05_etsy_publisher');
  await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const title = await page.locator('#listing-title-input').inputValue();
  let dir = forced ? path.join(PATHS.output, forced) : idx[norm(title)];
  if (!dir) { const h = idx[`#${norm(title.split(',')[0])}`]; if (h && h !== 'AMBIGUOUS') dir = h; }
  if (!dir) throw new Error(`ürün klasörü bulunamadı ("${title.slice(0, 50)}")`);
  const cover = await buildCover(dir);
  // 1) Yükle
  const before = await imageIds(page);
  await page.locator('input[type="file"]').first().setInputFiles(cover);
  let after = before;
  for (let i = 0; i < 30 && after.length <= before.length; i++) { await page.waitForTimeout(1500); after = await imageIds(page); }
  if (after.length <= before.length) throw new Error('kapak yüklenmedi');
  await pub.waitUploadsDone(page, 60000);
  await page.waitForTimeout(1500);
  after = await imageIds(page);
  const newId = after.find((x) => !before.includes(x)) || after[after.length - 1];
  // 2) Başa taşı (klavye ile sürükle-bırak)
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate((nid) => { const el = document.getElementById(nid); el.scrollIntoView({ block: 'center' }); el.focus(); }, newId);
    await page.keyboard.press('Space'); await page.waitForTimeout(400);
    for (let k = 0; k < 4; k++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(120); }
    for (let k = 0; k < 16; k++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
    await page.waitForTimeout(400); await page.keyboard.press('Space'); await page.waitForTimeout(1200);
    if ((await imageIds(page))[0] === newId) break;
  }
  if ((await imageIds(page))[0] !== newId) throw new Error('yeni kapak 1. sıraya taşınamadı');
  // 3) Etiket
  const tags = await page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Delete tag "]')].map((b) => b.getAttribute('aria-label').replace(/^Delete tag /, '')));
  if (!tags.map((t) => t.toLowerCase()).includes(TAG)) {
    if (tags.length >= 13) {
      const victim = WEAK.find((w) => tags.map((t) => t.toLowerCase()).includes(w)) || tags[tags.length - 1];
      const real = tags.find((t) => t.toLowerCase() === victim.toLowerCase()) || victim;
      await page.locator(`button[aria-label="Delete tag ${real}"]`).first().click();
      await page.waitForTimeout(600);
    }
    const inp = page.locator('#listing-tags-input');
    await inp.scrollIntoViewIfNeeded().catch(() => {});
    await inp.click(); await inp.type(TAG, { delay: 30 }); await inp.press('Enter'); await page.waitForTimeout(900);
    const has = await page.locator(`button[aria-label="Delete tag ${TAG}"]`).count().catch(() => 0);
    if (!has) log(`ilan ${id}: "${TAG}" etiketi eklenemedi (kapak yine de güncelleniyor)`, 'warn');
  }
  // 4) Kaydet
  await page.screenshot({ path: path.join(PATHS.logs, `cover_update_${id}.png`), fullPage: false }).catch(() => {});
  const btn = page.getByRole('button', { name: /^(publish changes|save draft)$/i }).first();
  await btn.click();
  await page.waitForURL((u) => !/listing-editor\/edit/.test(u.toString()), { timeout: 45000 }).catch(async () => {
    const errs = await pub.formErrors(page).catch(() => []);
    throw new Error(`kaydedilemedi${errs && errs.length ? `: ${[].concat(errs).join(' | ').slice(0, 150)}` : ''}`);
  });
  return path.basename(dir);
}

/** @param {string[]} ids Etsy ilan numaraları */
async function updateCovers(ids) {
  const { launchBrowser, ensureLoggedIn } = require('../05_etsy_publisher');
  const cfg = loadConfig();
  const idx = productIndex();
  const done = readDone();
  // "ilanNo:klasör" biçimi elle eşleme sağlar
  const forced = {}; ids = ids.map((x) => { const [i, f] = String(x).split(':'); if (f) forced[i] = f; return i; });
  const todo = ids.filter((id) => !done[id]);
  log(`Modelli kapak güncelleme: ${todo.length} ilan (${ids.length - todo.length} zaten yapılmış)`);
  const ctx = await launchBrowser(false, cfg);
  let ok = 0, fail = 0;
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    page = await ensureLoggedIn(ctx, page);
    for (const id of todo) {
      checkStop();
      try {
        const prod = await updateOne(page, id, idx, forced[id]);
        done[id] = { product: prod, at: new Date().toISOString() };
        fs.writeFileSync(DONE, JSON.stringify(done, null, 2));
        ok++;
        log(`Kapak güncellendi: ilan ${id} (${prod})`, 'success');
      } catch (e) {
        fail++;
        log(`Kapak güncellenemedi (ilan ${id}): ${String(e.message).slice(0, 160)}`, 'warn');
      }
    }
  } finally { await ctx.close().catch(() => {}); }
  log(`Kapak güncelleme bitti: ${ok} başarılı${fail ? `, ${fail} hata` : ''}`, fail ? 'warn' : 'success');
  return { ok, fail };
}

module.exports = { updateCovers };
