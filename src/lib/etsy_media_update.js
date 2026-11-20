'use strict';
/**
 * Etsy ilanının fotoğraflarını yeniden üretilmiş vitrin görselleriyle değiştirir (video ve diğer alanlar kalır).
 * Sıra: eski fotoğrafların ilki hariç hepsi silinir → yeniler yüklenir → eski ilk fotoğraf silinir (ilan hiçbir an fotoğrafsız kalmaz).
 * Kayıt: data/media_updates.json
 */
const fs = require('fs');
const path = require('path');
const { log, PATHS, checkStop, loadConfig, titleCase } = require('./core');

const DONE = path.join(PATHS.data, 'media_updates.json');

async function buildMedia(folder) {
  const dir = path.join(PATHS.output, folder);
  const trend = JSON.parse(fs.readFileSync(path.join(dir, 'trend.json'), 'utf8'));
  const seo = JSON.parse(fs.readFileSync(path.join(dir, 'seo_metadata.json'), 'utf8'));
  const dd = path.join(dir, 'designs');
  const pngs = fs.readdirSync(dd).filter((x) => /\.png$/i.test(x)).sort().map((x) => path.join(dd, x));
  const { createMockups } = require('../03_mockup_engine');
  const res = await createMockups({ pngs, trend, dir, title: seo.title || titleCase(trend.niche) });
  return res.images;
}

const imageIds = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-roledescription="sortable"]')]
  .filter((e) => e.id && e.querySelector('img') && /listing image/i.test(e.querySelector('img').alt || '')).map((e) => e.id));

async function deleteImage(page, id, expectLeft = null) {
  // Etsy düğmeyi (clg-icon-button) fotoğraf görünür olunca/üzerine gelince çiziyor: kaydır, üzerine gel, bekle, tıkla
  const sel = `[id="${id}"] [data-testid="image-delete-button"]`;
  let ok = false;
  for (let k = 0; k < 12 && !ok; k++) {
    await page.evaluate((iid) => { const el = document.getElementById(iid); if (el) el.scrollIntoView({ block: 'center' }); }, id).catch(() => {});
    await page.hover(`[id="${id}"]`, { timeout: 2000 }).catch(() => {});
    // Önce sayfa içinden (gölge DOM'daki gerçek düğme) tıkla — Etsy'nin yeni clg düğmesinde en güvenilir yol
    ok = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return false; (b.shadowRoot && b.shadowRoot.querySelector('button') || b).click(); return true; }, sel).catch(() => false);
    if (!ok) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) ok = await loc.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    }
    if (!ok) await page.waitForTimeout(500);
  }
  if (!ok) {
    await page.screenshot({ path: path.join(PATHS.logs, `media_fail_${id}.png`), fullPage: true }).catch(() => {});
    const info = await page.evaluate((iid) => { const el = document.getElementById(iid); return el ? el.outerHTML.slice(0, 400) : 'YOK: ' + [...document.querySelectorAll('[aria-roledescription="sortable"]')].map((e) => e.id).join(','); }, id).catch(() => '');
    log(`Silme düğmesi teşhis: ${String(info).replace(/\s+/g, ' ').slice(0, 400)}`, 'warn');
    throw new Error(`fotoğraf silme düğmesi bulunamadı (${id})`);
  }
  await page.waitForTimeout(700);
  // Onay penceresi varsa YALNIZCA görünür diyalogun içindeki düğmeye bas (Etsy'nin yeni fotoğraf düğmeleri de "Delete" adlı;
  // sayfa genelinde aramak başka bir fotoğrafı sildiriyordu)
  const dlg = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').filter({ hasText: /delete|remove|sil/i });
  if (await dlg.count().catch(() => 0)) {
    const confirm = dlg.last().getByRole('button', { name: /^(delete|remove|yes, delete|sil)$/i });
    if (await confirm.count().catch(() => 0)) await confirm.last().click().catch(() => {});
  }
  for (let k = 0; k < 10 && (await imageIds(page)).includes(id); k++) await page.waitForTimeout(500);
  if (expectLeft != null) { const n = (await imageIds(page)).length; if (n !== expectLeft) throw new Error(`silme sonrası fotoğraf sayısı beklenmedik (${n}/${expectLeft}) — kaydedilmeden bırakıldı`); }
}

async function updateOne(page, id, folder) {
  const pub = require('../05_etsy_publisher');
  const images = await buildMedia(folder);
  if (!images.length || images.length > 19) throw new Error(`görsel sayısı uygun değil (${images.length})`);
  await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const attrs = require('./etsy_attrs');
  const snap = await attrs.snapshot(page);
  if (!snap.craft.length) throw new Error('ilanda zanaat türü zaten boş, elle kontrol edin');
  const old = await imageIds(page);
  if (!old.length) throw new Error('ilanda fotoğraf bulunamadı');
  for (const [j, iid] of old.slice(1).entries()) { checkStop(); await deleteImage(page, iid, old.length - 1 - j); }
  if ((await imageIds(page)).length !== 1) throw new Error('eski fotoğraflar silinemedi');
  await page.locator('input[type="file"]').first().setInputFiles(images);
  for (let k = 0; k < 60 && (await imageIds(page)).length < images.length + 1; k++) await page.waitForTimeout(2000);
  await pub.waitUploadsDone(page, 120000);
  // Etsy birincil (öne çıkan) fotoğrafın silinmesini kaydetmeyebiliyor: önce yeni kapağı başa taşı, sonra eskiyi sil
  const fresh = (await imageIds(page)).filter((x) => x !== old[0]);
  const newId = fresh[0];
  for (let attempt = 0; attempt < 2 && (await imageIds(page))[0] !== newId; attempt++) {
    await page.evaluate((nid) => { const el = document.getElementById(nid); el.scrollIntoView({ block: 'center' }); el.focus(); }, newId);
    await page.keyboard.press('Space'); await page.waitForTimeout(400);
    for (let k = 0; k < 4; k++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(120); }
    for (let k = 0; k < 16; k++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
    await page.waitForTimeout(400); await page.keyboard.press('Space'); await page.waitForTimeout(1200);
  }
  if ((await imageIds(page))[0] !== newId) throw new Error('yeni kapak başa taşınamadı');
  await deleteImage(page, old[0]);
  const now = await imageIds(page);
  if (now.length !== images.length || now.includes(old[0])) throw new Error(`fotoğraf sayısı tutmuyor (${now.length}/${images.length})`);
  await attrs.restore(page, snap);
  await page.screenshot({ path: path.join(PATHS.logs, `media_update_${id}.png`) }).catch(() => {});
  await page.getByRole('button', { name: /^(publish changes|save draft)$/i }).first().click();
  await page.waitForURL((u) => !/listing-editor\/edit/.test(u.toString()), { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const after = await imageIds(page);
  if (after.length !== images.length || after.some((x) => old.includes(x))) throw new Error(`kayıt doğrulanamadı (fotoğraf ${after.length}/${images.length})`);
  const v = await attrs.verify(page, snap);
  if (!v.ok) throw new Error(`kayıttan sonra etiket/zanaat eksik: ${v.lost.join(', ') || 'zanaat türü boş'}`);
  return { before: old.length, after: after.length };
}

async function updateMedia(items) {
  const { launchBrowser, ensureLoggedIn } = require('../05_etsy_publisher');
  const cfg = loadConfig();
  let done = {}; try { done = JSON.parse(fs.readFileSync(DONE, 'utf8')); } catch {}
  const ctx = await launchBrowser(false, cfg);
  let ok = 0, fail = 0;
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    page = await ensureLoggedIn(ctx, page);
    for (const it of items) {
      checkStop();
      const [id, folder] = String(it).split(':');
      try {
        const r = await updateOne(page, id, folder);
        done[id] = { folder, at: new Date().toISOString(), ...r };
        fs.writeFileSync(DONE, JSON.stringify(done, null, 2));
        ok++; log(`Vitrin yenilendi: ilan ${id} (${r.before} eski → ${r.after} yeni fotoğraf)`, 'success');
      } catch (e) { fail++; log(`Vitrin yenilenemedi (ilan ${id}): ${String(e.message).slice(0, 160)}`, 'warn'); }
    }
  } finally { await ctx.close().catch(() => {}); }
  log(`Vitrin yenileme bitti: ${ok} başarılı${fail ? `, ${fail} hata` : ''}`, fail ? 'warn' : 'success');
  return { ok, fail };
}

module.exports = { updateMedia };
