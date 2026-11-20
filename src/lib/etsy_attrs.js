'use strict';
/** Etsy düzenleyicide fotoğraf/dosya değişince sıfırlanabilen etiket ve "Craft type" alanlarını okur ve geri yükler. */
const tagsOf = (page) => page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Delete tag "]')].map((b) => b.getAttribute('aria-label').replace(/^Delete tag /, '')));
const craftOf = (page) => page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Remove value "]')].map((b) => b.getAttribute('aria-label')).filter((t) => / for attribute Craft type$/.test(t)).map((t) => t.replace(/^Remove value /, '').replace(/ for attribute Craft type$/, '')));
const snapshot = async (page) => ({ tags: await tagsOf(page), craft: await craftOf(page) });

async function restore(page, snap) {
  const craft1 = await craftOf(page);
  for (const c of snap.craft.filter((x) => !craft1.includes(x))) {
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
  const tags1 = await tagsOf(page);
  for (const t of snap.tags.filter((x) => !tags1.includes(x))) {
    const inp = page.locator('#listing-tags-input'); await inp.scrollIntoViewIfNeeded().catch(() => {});
    await inp.click(); await inp.type(t, { delay: 20 }); await inp.press('Enter'); await page.waitForTimeout(500);
  }
  const after = await snapshot(page);
  const lostT = snap.tags.filter((x) => !after.tags.includes(x));
  const lostC = snap.craft.filter((x) => !after.craft.includes(x));
  if (lostT.length || lostC.length) throw new Error(`etiket/zanaat geri yüklenemedi (${[...lostT, ...lostC].join(', ')})`);
  return after;
}

/** Kaydettikten sonra yeniden açılan ilanda etiket ve zanaat türü eksiksiz mi? */
async function verify(page, snap) {
  const now = await snapshot(page);
  const lost = [...snap.tags.filter((x) => !now.tags.includes(x)), ...snap.craft.filter((x) => !now.craft.includes(x))];
  return { ok: !lost.length && now.craft.length > 0, lost, now };
}

module.exports = { tagsOf, craftOf, snapshot, restore, verify };
