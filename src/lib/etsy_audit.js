'use strict';
/** Sadece okuma: ilanların etiket sayısı, zanaat türü, fiyat, fotoğraf ve dosya listesini toplar → data/etsy_audit.json */
const fs = require('fs');
const path = require('path');
const { log, PATHS, checkStop, loadConfig } = require('./core');

async function audit(ids) {
  const { launchBrowser, ensureLoggedIn } = require('../05_etsy_publisher');
  const attrs = require('./etsy_attrs');
  const ctx = await launchBrowser(false, loadConfig());
  const out = {};
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    page = await ensureLoggedIn(ctx, page);
    for (const id of ids) {
      checkStop();
      try {
        await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('#listing-title-input').waitFor({ timeout: 30000 });
        await page.waitForTimeout(3000);
        const s = await attrs.snapshot(page);
        const info = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="digital_file_action_remove"]'); let r = b; for (let i = 0; i < 5 && r; i++) r = r.parentElement;
          return {
            title: document.querySelector('#listing-title-input')?.value || '',
            price: document.querySelector('#listing-price-input')?.value || '',
            photos: [...document.querySelectorAll('[aria-roledescription="sortable"]')].filter((e) => e.id && e.querySelector('img') && /listing image/i.test(e.querySelector('img').alt || '')).length,
            files: r ? (r.innerText.match(/[\w.-]+\.zip\s+[\d.]+\s*mb/gi) || []) : [],
          };
        });
        out[id] = { ...info, tags: s.tags, craft: s.craft };
        log(`Denetim: ${id} — ${s.tags.length} etiket, zanaat: ${s.craft.join('/') || 'YOK'}, ${info.photos} foto, ${info.files.length} dosya`);
      } catch (e) { out[id] = { error: String(e.message).slice(0, 150) }; }
      fs.writeFileSync(path.join(PATHS.data, 'etsy_audit.json'), JSON.stringify(out, null, 2));
    }
  } finally { await ctx.close().catch(() => {}); }
  log(`Etsy denetimi bitti: ${Object.keys(out).length} ilan`, 'success');
  return out;
}
module.exports = { audit };
