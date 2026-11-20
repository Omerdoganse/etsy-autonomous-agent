'use strict';
/**
 * Mevcut Etsy ilanlarının başlık ve etiketlerini günceller (fotoğraf/dosyaya dokunmaz).
 * data/seo_request.json: { items: { "<ilan no>": { title, tags[13] } } }
 * Her ilan: düzenleyiciyi aç → başlığı yaz → tüm etiketleri sil → yenilerini ekle → Craft type korunur →
 * kaydet → yeniden aç ve doğrula. Sonuç data/seo_updates.json'a yazılır; yerel seo_metadata.json da güncellenir.
 */
const fs = require('fs');
const path = require('path');
const { log, PATHS, checkStop, loadConfig } = require('./core');

const DONE = path.join(PATHS.data, 'seo_updates.json');

async function updateOne(page, id, title, tags) {
  const attrs = require('./etsy_attrs');
  const url = `https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const ti = page.locator('#listing-title-input');
  await ti.waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const snap = await attrs.snapshot(page);
  if (!snap.craft.length) throw new Error('ilanda zanaat türü boş, elle kontrol edin');
  // Başlık
  await ti.scrollIntoViewIfNeeded().catch(() => {});
  await ti.click();
  await ti.fill('');
  await ti.fill(title);
  await page.waitForTimeout(500);
  // Etiketler: hepsini sil
  for (let k = 0; k < 20; k++) {
    const del = page.locator('button[aria-label^="Delete tag "]').first();
    if (!(await del.count().catch(() => 0))) break;
    await del.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  if ((await attrs.tagsOf(page)).length) throw new Error('eski etiketler silinemedi');
  // Yenilerini ekle (+ zanaat türü korunur)
  await attrs.restore(page, { tags, craft: snap.craft });
  const now = await attrs.snapshot(page);
  if (now.tags.length !== tags.length) throw new Error(`etiket sayısı tutmuyor (${now.tags.length}/${tags.length})`);
  await page.getByRole('button', { name: /^(publish changes|save draft)$/i }).first().click();
  await page.waitForURL((u) => !/listing-editor\/edit/.test(u.toString()), { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  // Doğrula
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const t2 = await page.locator('#listing-title-input').inputValue();
  const v = await attrs.verify(page, { tags, craft: snap.craft });
  if (t2.trim() !== title.trim() || !v.ok) throw new Error(`kayıt doğrulanamadı (başlık ${t2.trim() === title.trim()}, eksik: ${v.lost.join(', ')})`);
  return { oldTags: snap.tags };
}

async function updateSeo(itemsObj) {
  const { launchBrowser, ensureLoggedIn } = require('../05_etsy_publisher');
  let done = {}; try { done = JSON.parse(fs.readFileSync(DONE, 'utf8')); } catch {}
  let media = {}; try { media = JSON.parse(fs.readFileSync(path.join(PATHS.data, 'media_updates.json'), 'utf8')); } catch {}
  const ids = Object.keys(itemsObj).filter((id) => !done[id] || done[id].title !== itemsObj[id].title);
  log(`SEO yenileme: ${ids.length} ilan (başlık + 13 etiket)`);
  const ctx = await launchBrowser(false, loadConfig());
  let ok = 0, fail = 0;
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    page = await ensureLoggedIn(ctx, page);
    for (const id of ids) {
      checkStop();
      const { title, tags } = itemsObj[id];
      try {
        const r = await updateOne(page, id, title, tags);
        done[id] = { title, tags, oldTags: r.oldTags, at: new Date().toISOString() };
        fs.writeFileSync(DONE, JSON.stringify(done, null, 2));
        // yerel kayıt da güncel kalsın
        const folder = media[id] && media[id].folder;
        if (folder) {
          const f = path.join(PATHS.output, folder, 'seo_metadata.json');
          try { const m = JSON.parse(fs.readFileSync(f, 'utf8')); m.title = title; m.tags = tags; fs.writeFileSync(f, JSON.stringify(m, null, 2)); } catch { /* yok say */ }
        }
        ok++; log(`SEO yenilendi: ilan ${id}`, 'success');
      } catch (e) { fail++; log(`SEO yenilenemedi (ilan ${id}): ${String(e.message).slice(0, 160)}`, 'warn'); }
    }
  } finally { await ctx.close().catch(() => {}); }
  log(`SEO yenileme bitti: ${ok} başarılı${fail ? `, ${fail} hata` : ''}`, fail ? 'warn' : 'success');
  return { ok, fail };
}

module.exports = { updateSeo };
