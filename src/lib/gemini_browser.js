'use strict';
/**
 * Gemini otomasyonu (ücretsiz, kullanıcının kendi Gemini hesabıyla, tarayıcı üzerinden).
 * Talimatı gemini.google.com'a yapıştırır, görseli bekler, PNG olarak kaydeder.
 * Her talimat yeni sohbette çalışır (tasarımlar birbirine benzemesin).
 * İlk kullanımda açılan pencerede Google hesabına bir kez giriş yapılır; oturum data/gemini_session'da saklanır.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, log, PATHS, sleep, checkStop } = require('./core');

const GEMINI_URL = 'https://gemini.google.com/app';
const EDITOR = 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]';

async function launch(cfg) {
  const { chromium } = require('playwright');
  const dir = path.join(PATHS.data, 'gemini_session');
  fs.mkdirSync(dir, { recursive: true });
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  try {
    return await chromium.launchPersistentContext(dir, { ...opts, channel: cfg.browser_channel || 'msedge' });
  } catch (e) {
    log(`Gemini için "${cfg.browser_channel || 'msedge'}" açılamadı, Playwright Chromium deneniyor`, 'warn');
    return chromium.launchPersistentContext(dir, opts);
  }
}

async function editorReady(page) {
  return (await page.locator(EDITOR).count().catch(() => 0)) > 0;
}

/** Giriş yoksa kullanıcının açılan pencerede Google'a giriş yapmasını bekler (en fazla 10 dk). */
async function ensureLogin(page) {
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const signInBtn = await page.locator('a[href*="accounts.google.com"], a:has-text("Sign in"), a:has-text("Oturum aç")').count().catch(() => 0);
  if (await editorReady(page) && !signInBtn) return;
  log('Gemini: Google oturumu yok — açılan pencerede Google hesabınla giriş yap (bir kez gerekir, en fazla 10 dk beklenir)', 'warn');
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    checkStop();
    await sleep(4000);
    if (/gemini\.google\.com\/app/.test(page.url()) && await editorReady(page)) {
      const still = await page.locator('a[href*="accounts.google.com/ServiceLogin"], a:has-text("Sign in"), a:has-text("Oturum aç")').count().catch(() => 0);
      if (!still) { log('Gemini girişi algılandı, oturum kaydedildi', 'success'); return; }
    }
  }
  throw Object.assign(new Error('Gemini girişi 10 dakika içinde tamamlanmadı'), { noRetry: true });
}

/** Sayfadaki üretilmiş görsel sayısı (yalnızca büyük görseller). */
async function imageCount(page) {
  return page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 300 && i.complete).length).catch(() => 0);
}

/** Son üretilen görseli tam boyutunda PNG olarak alır. */
async function grabLastImage(page) {
  const dataUrl = await page.evaluate(() => {
    const img = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 300 && i.complete).pop();
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  });
  if (!dataUrl) return null;
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function send(page, text) {
  const ed = page.locator(EDITOR).first();
  await ed.click();
  await page.keyboard.insertText(text.replace(/\s*\n+\s*/g, ' '));
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
}

/** Yeni görsel gelene kadar bekler; gelirse PNG buffer döner. */
async function waitImage(page, before, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkStop();
    await page.waitForTimeout(2500);
    if (await imageCount(page) > before) {
      await page.waitForTimeout(2500); // tam yüklensin
      return grabLastImage(page);
    }
  }
  return null;
}

/** Görselin zemini renkli (magenta) mi? Köşelerden bakar. */
async function hasColoredBackground(buf) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buf).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => { const o = (y * info.width + x) * 3; return [data[o], data[o + 1], data[o + 2]]; };
  const corners = [at(1, 1), at(62, 1), at(1, 62), at(62, 62)];
  return corners.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 90 && g < 120).length >= 3;
}

/**
 * Talimat listesini sırayla Gemini'de çalıştırır.
 * @returns {Promise<Array<{file:string, index:number}>>} kaydedilen görseller
 */
async function generateImages(prompts, { outDir, mode = 'text' } = {}) {
  const cfg = loadConfig();
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = await launch(cfg);
  const results = [];
  try {
    let page = ctx.pages()[0] || await ctx.newPage();
    await ensureLogin(page);
    for (let i = 0; i < prompts.length; i++) {
      checkStop();
      log(`Gemini: görsel ${i + 1}/${prompts.length} çiziliyor…`);
      let buf = null;
      for (let attempt = 1; attempt <= 2 && !buf; attempt++) {
        await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); // her talimat yeni sohbet
        await page.waitForSelector(EDITOR, { timeout: 30000 });
        await page.waitForTimeout(1500 + Math.random() * 1500);
        await send(page, prompts[i]);
        buf = await waitImage(page, 0);
        if (!buf && attempt === 1) {
          // Bazen görsel yerine yazı döner: aynı sohbette açıkça iste
          log('Gemini görsel yerine yazı döndü, tekrar isteniyor', 'warn');
          const n0 = await imageCount(page);
          await send(page, 'Please generate this image now.');
          buf = await waitImage(page, n0);
        }
      }
      if (!buf) { log(`Gemini: görsel ${i + 1} alınamadı, atlanıyor`, 'warn'); continue; }
      if (mode === 'illustration' && !(await hasColoredBackground(buf))) {
        log('Gemini zemini pembe yapmadı, düzeltmesi isteniyor', 'warn');
        const n0 = await imageCount(page);
        await send(page, 'Make the background a perfectly flat, solid magenta (#FF00FF) color edge to edge. Keep the artwork exactly the same.');
        const fixed = await waitImage(page, n0);
        if (fixed && await hasColoredBackground(fixed)) buf = fixed;
      }
      const file = path.join(outDir, `gemini_${i + 1}.png`);
      fs.writeFileSync(file, buf);
      results.push({ file, index: i });
      log(`Gemini: görsel ${i + 1} alındı`, 'success');
      if (i < prompts.length - 1) await sleep(4000 + Math.random() * 6000); // insan gibi ara
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return results;
}

module.exports = { generateImages };
