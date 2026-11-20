'use strict';
/**
 * Etsy dükkân araçları (tarayıcı otomasyonu, panelden):
 *  - updateAllPrices: yayındaki ve taslaktaki paket ilanlarının fiyatını topluca değiştirir
 *  - createSale: tüm dükkânda yüzdelik indirim kampanyası başlatır (Etsy "Run a sale")
 */
const path = require('path');
const { loadConfig, log, PATHS, checkStop } = require('./core');

const LISTINGS = (state) => `https://www.etsy.com/your/shops/me/tools/listings?state=${state}`;

async function withEtsy(fn) {
  const { launchBrowser, ensureLoggedIn } = require('../05_etsy_publisher');
  const cfg = loadConfig();
  const ctx = await launchBrowser(false, cfg);
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    page = await ensureLoggedIn(ctx, page);
    return await fn(page, cfg);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function listingIds(page, state) {
  await page.goto(LISTINGS(state), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(800); } // tüm ilanlar yüklensin
  return page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="listing-editor/edit/"]')].map((a) => (a.href.match(/edit\/(\d+)/) || [])[1]).filter(Boolean))]);
}

/**
 * @param {number} newPrice  KDV hariç Etsy fiyatı (TL)
 * @param {{onlyBundles?:boolean}} opts  true: sadece "Bundle/Designs" paket ilanları (tek tasarımlık eski ilanlara dokunmaz)
 */
async function updateAllPrices(newPrice, { onlyBundles = true } = {}) {
  const target = Number(newPrice).toFixed(2);
  return withEtsy(async (page) => {
    const ids = [...await listingIds(page, 'active'), ...await listingIds(page, 'draft')];
    log(`Fiyat güncelleme: ${ids.length} ilan kontrol ediliyor → ${target} TL`);
    let changed = 0, skipped = 0, failed = 0;
    for (const id of ids) {
      checkStop();
      try {
        await page.goto(`https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const price = page.locator('#listing-price-input');
        await price.waitFor({ timeout: 30000 });
        const title = await page.locator('#listing-title-input').inputValue().catch(() => '');
        const cur = await price.inputValue();
        if (cur === target || (onlyBundles && !/bundle|designs/i.test(title))) { skipped++; continue; }
        await price.fill(target);
        await price.blur();
        await page.waitForTimeout(800);
        const btn = page.getByRole('button', { name: /^(publish changes|save draft)$/i }).first();
        await btn.click();
        await page.waitForURL((u) => !/listing-editor\/edit/.test(u.toString()), { timeout: 30000 });
        changed++;
        log(`Fiyat: ${title.slice(0, 50)}… ${cur} → ${target} TL`);
      } catch (e) {
        failed++;
        log(`Fiyat güncellenemedi (ilan ${id}): ${String(e.message).slice(0, 100)}`, 'warn');
      }
    }
    log(`Fiyat güncelleme bitti: ${changed} değişti, ${skipped} atlandı${failed ? `, ${failed} hata` : ''}`, failed ? 'warn' : 'success');
    return { changed, skipped, failed, total: ids.length };
  });
}

// Yerel tarih (toISOString UTC verir: Türkiye'de gece yarısından sonra "dün" çıkıyordu → Etsy "geçmiş tarih" hatası)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Tüm dükkânda yüzdelik indirim (Etsy "Run a sale").
 * @param {number} pct   yüzde (5–75)
 * @param {number} days  kaç gün sürsün (en fazla 30 gün sonrası başlangıç, Etsy kuralları geçerli)
 */
async function createSale(pct, days = 14, name = null) {
  pct = Math.round(Number(pct));
  if (!(pct >= 5 && pct <= 75)) throw new Error('İndirim %5 ile %75 arasında olmalı');
  const start = new Date(); const end = new Date(Date.now() + Math.max(1, Number(days) || 14) * 86400000);
  const saleName = (name || `SALE${pct}${String(end.getMonth() + 1).padStart(2, '0')}${String(end.getDate()).padStart(2, '0')}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const shot = (f) => async (page) => page.screenshot({ path: path.join(PATHS.logs, f), fullPage: true }).catch(() => {});
  return withEtsy(async (page) => {
    log(`İndirim: %${pct}, ${ymd(start)} → ${ymd(end)}, adı ${saleName}`);
    await page.goto('https://www.etsy.com/your/shops/me/sales-discounts/step/createSale', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('#reward-percentage').waitFor({ timeout: 30000 });
    await page.locator('#what-discount').selectOption('percent').catch(() => {});
    const preset = ['25', '30', '35', '40', '45', '50'];
    if (preset.includes(String(pct))) await page.locator('#reward-percentage').selectOption(String(pct));
    else {
      await page.locator('#reward-percentage').selectOption('1');
      await page.locator('input[name="reward_type_percent_input"]').fill(String(pct));
    }
    await page.locator('#sales-and-coupons--start-date').fill(ymd(start));
    await page.locator('#sales-and-coupons--end-date').fill(ymd(end));
    await page.locator('#name-your-coupon').fill(saleName);
    await page.locator('#name-your-coupon').blur().catch(() => {});
    await page.waitForTimeout(800);
    if (await page.getByText(/must not be in the past/i).count().catch(() => 0)) {
      // Etsy'nin saat dilimi farklıysa bugünü geçmiş sayabilir → yarından başlat
      const t = new Date(Date.now() + 86400000);
      await page.locator('#sales-and-coupons--start-date').fill(ymd(t));
      log('İndirim başlangıcı Etsy saat dilimi yüzünden yarına alındı', 'warn');
    }
    await shot('sale_step1.png')(page);
    await page.getByRole('button', { name: /^continue$/i }).first().click();
    await page.waitForTimeout(4000);
    // 2. adım: hangi ürünler → "tüm dükkân" seçeneği varsa seç, sonra onayla
    const allShop = page.getByText(/^all listings$|whole shop|entire shop|all items/i).first();
    if (await allShop.count().catch(() => 0)) await allShop.click().catch(() => {});
    await shot('sale_step2.png')(page);
    for (let i = 0; i < 5; i++) {
      await shot(`sale_step${i + 3}.png`)(page);
      const btn = page.getByRole('button', { name: /^(continue|review and confirm|confirm and create sale|review|confirm|confirm sale|create sale|start sale|confirm and start|run sale|launch sale|done)$/i }).last();
      if (!(await btn.count().catch(() => 0))) break;
      await btn.click().catch(() => {});
      await page.waitForTimeout(3500);
      if (/sales-discounts\/?(\?|$)/.test(page.url())) break;
    }
    await shot('sale_after.png')(page);
    // Başarı: kurulum penceresi kapandı (inceleme/kurulum ekranı artık görünmüyor)
    await page.waitForTimeout(2000);
    const stillOpen = await page.getByText(/Review your sale details|Set up a sale|Customize your sale|Which listings are included/i).first().isVisible().catch(() => false);
    const ok = !stillOpen;
    if (!ok) throw Object.assign(new Error('İndirim oluşturma tamamlanamadı — logs/sale_after.png ekranına bakın ya da Etsy → Marketing → Sales and discounts bölümünden kontrol edin'), { noRetry: true });
    log(`İndirim başlatıldı: %${pct} (${ymd(end)} tarihine kadar)`, 'success');
    return { pct, start: ymd(start), end: ymd(end), name: saleName };
  });
}

module.exports = { updateAllPrices, createSale };
