'use strict';
/**
 * Etsy ilanındaki satılan dosyaları (ZIP) yenileriyle değiştirir.
 * Ürün klasöründeki güncel deliverable ZIP'leri yüklenir, eskileri ilandan kaldırılır; fiyat/başlık/görseller aynı kalır.
 * Kayıt: data/files_updates.json
 */
const fs = require('fs');
const path = require('path');
const { log, PATHS, checkStop, loadConfig } = require('./core');

const DONE = path.join(PATHS.data, 'files_updates.json');

function deliveryFiles(dir) {
  const parts = fs.readdirSync(dir).filter((f) => /^deliverable_part\d+\.zip$/.test(f)).sort();
  const list = parts.length ? parts : (fs.existsSync(path.join(dir, 'deliverable.zip')) ? ['deliverable.zip'] : []);
  return list.map((f) => path.join(dir, f));
}

async function replaceOne(page, id, folder) {
  const pub = require('../05_etsy_publisher');
  const dir = path.join(PATHS.output, folder);
  // Yeni dosyalar farklı adla yüklenir (ör. vintage-christmas-fox_part1.zip): Etsy'de eskisiyle karışmaz, doğrulama ada göre yapılır
  const src = deliveryFiles(dir);
  const slug = folder.replace(/^\d{8}-/, '').replace(/-[0-9a-f]{6}$/, '').replace(/-png.*$/, '').slice(0, 40) || 'designs';
  const up = path.join(dir, '_upload'); fs.mkdirSync(up, { recursive: true });
  const files = src.map((f, k) => { const n = path.join(up, src.length > 1 ? `${slug}_part${k + 1}.zip` : `${slug}.zip`); fs.copyFileSync(f, n); return n; });
  if (!files.length || files.length > 5) throw new Error(`teslim dosyası sayısı uygun değil (${files.length})`);
  for (const f of files) if (fs.statSync(f).size > 20 * 1024 * 1024) throw new Error(`${path.basename(f)} 20 MB'tan büyük`);
  await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const rm = page.locator('[data-testid="digital_file_action_remove"]');
  const before = await rm.count();
  const tagsOf = () => page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Delete tag "]')].map((b) => b.getAttribute('aria-label').replace(/^Delete tag /, '')));
  const craftOf = () => page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Remove value "]')].map((b) => b.getAttribute('aria-label')).filter((t) => / for attribute Craft type$/.test(t)).map((t) => t.replace(/^Remove value /, '').replace(/ for attribute Craft type$/, '')));
  const rowNames = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="digital_file_action_remove"]')].map((b) => { let r = b; for (let i = 0; i < 4 && r; i++) { r = r.parentElement; const m = r && r.innerText.match(/([\w.-]+\.zip)/i); if (m && r.querySelectorAll('[data-testid="digital_file_action_remove"]').length === 1) return m[1]; } return null; }));
  const tags0 = await tagsOf(), craft0 = await craftOf();
  const newNames = files.map((f) => path.basename(f));
  // Sırayla değiştir: önce bir eskiyi kaldır, sonra bir yeniyi ekle (ilan hiçbir an dosyasız kalmaz; Etsy sınırı 5 dosya)
  for (const f of files) {
    const names = await rowNames();
    if (names.includes(path.basename(f))) continue;
    if (names.length >= 5 || names.some((n) => n && !newNames.includes(n))) {
      const idx = names.findIndex((n) => !n || !newNames.includes(n));
      if (idx >= 0) {
        await rm.nth(idx).scrollIntoViewIfNeeded().catch(() => {});
        await rm.nth(idx).click();
        await page.waitForTimeout(900);
        const confirm = page.getByRole('button', { name: /^(remove|delete|yes, remove)$/i });
        if (await confirm.count().catch(() => 0)) await confirm.last().click().catch(() => {});
      }
    }
    const n0 = await rm.count();
    await page.locator('input[type="file"]').last().setInputFiles(f);
    for (let k = 0; k < 60 && (await rm.count()) <= n0; k++) await page.waitForTimeout(2000);
    await pub.waitUploadsDone(page, 90000);
  }
  // Kalan eskileri kaldır
  for (let k = 0; k < 6; k++) {
    const names = await rowNames(); const idx = names.findIndex((n) => !n || !newNames.includes(n));
    if (idx < 0) break;
    await rm.nth(idx).click(); await page.waitForTimeout(900);
  }
  const fin = await rowNames();
  if (fin.length !== files.length || !newNames.every((n) => fin.includes(n))) throw new Error(`dosya listesi beklenen gibi değil: ${fin.join(', ')}`);
  // Etsy dosya değişikliğinde bazı alanları sıfırlayabiliyor: zanaat türü ve etiketleri geri koy
  const craft1 = await craftOf();
  for (const c of craft0.filter((x) => !craft1.includes(x))) {
    await page.evaluate(() => {
      const lab = [...document.querySelectorAll('*')].find((e) => e.childElementCount <= 1 && /^Craft type\*?$/.test(e.textContent.trim()));
      let p = lab; for (let i = 0; i < 6 && p; i++) { p = p.parentElement; if (p && p.querySelector('input[placeholder^="Type to search"]')) break; }
      const inp = p && p.querySelector('input[placeholder^="Type to search"]'); if (inp) inp.setAttribute('data-craft', '1');
    });
    const inp = page.locator('[data-craft="1"]').first();
    await inp.scrollIntoViewIfNeeded().catch(() => {}); await inp.click(); await inp.type(c.slice(0, 6), { delay: 40 }); await page.waitForTimeout(1500);
    await page.locator('label').filter({ hasText: new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first().click();
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape').catch(() => {});
  }
  const tags1 = await tagsOf();
  for (const t of tags0.filter((x) => !tags1.includes(x))) {
    const inp = page.locator('#listing-tags-input'); await inp.scrollIntoViewIfNeeded().catch(() => {});
    await inp.click(); await inp.type(t, { delay: 20 }); await inp.press('Enter'); await page.waitForTimeout(500);
  }
  if ((await craftOf()).length === 0 && craft0.length) throw new Error('zanaat türü geri konamadı');
  const names = fin;
  await page.screenshot({ path: path.join(PATHS.logs, `files_update_${id}.png`) }).catch(() => {});
  await page.getByRole('button', { name: /^(publish changes|save draft)$/i }).first().click();
  await page.waitForURL((u) => !/listing-editor\/edit/.test(u.toString()), { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  // Doğrulama: ilanı yeniden aç, dosya adları ve boyutları yereldekiyle aynı mı?
  await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const txt = await page.evaluate(() => { const b = document.querySelector('[data-testid="digital_file_action_remove"]'); let r = b; for (let i = 0; i < 5 && r; i++) r = r.parentElement; return r ? r.innerText.replace(/\s+/g, ' ') : ''; });
  const shown = [...txt.matchAll(/([\w.-]+\.zip)\s+([\d.]+)\s*mb/gi)].map((m) => [m[1], Number(m[2])]);
  const miss = files.filter((f) => !shown.some(([n, mb]) => n === path.basename(f) && Math.abs(mb - fs.statSync(f).size / 1e6) <= 0.02));
  if (shown.length !== files.length) miss.push('sayı');
  const tagsV = await tagsOf(), craftV = await craftOf();
  if (tagsV.length < tags0.length) miss.push(`etiket ${tagsV.length}/${tags0.length}`);
  if (craft0.length && !craftV.length) miss.push('zanaat türü boş');
  if (miss.length) throw new Error(`kayıt doğrulanamadı [${miss.map((m) => (typeof m === 'string' ? m : path.basename(m))).join(', ')}] (Etsy'de görünen: ${txt.slice(0, 160)})`);
  return { before, after: files.length, names: [...new Set(names)] };
}

/** @param {string[]} items "ilanNo:klasör" */
async function replaceFiles(items) {
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
        const r = await replaceOne(page, id, folder);
        done[id] = { folder, at: new Date().toISOString(), ...r };
        fs.writeFileSync(DONE, JSON.stringify(done, null, 2));
        ok++; log(`Satış dosyaları yenilendi: ilan ${id} (${r.before} eski → ${r.after} yeni ZIP)`, 'success');
      } catch (e) { fail++; log(`Satış dosyaları yenilenemedi (ilan ${id}): ${String(e.message).slice(0, 160)}`, 'warn'); }
    }
  } finally { await ctx.close().catch(() => {}); }
  log(`Dosya yenileme bitti: ${ok} başarılı${fail ? `, ${fail} hata` : ''}`, fail ? 'warn' : 'success');
  return { ok, fail };
}

module.exports = { replaceFiles };
