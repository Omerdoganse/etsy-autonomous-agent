'use strict';
/**
 * MODÜL 5 — Çift Kanallı Yükleyici
 *  Mod A (playwright): Kalıcı tarayıcı profili (data/browser_session) ile Shop Manager → Add a listing formunu doldurur.
 *  Mod B (api): Etsy Open API v3 — OAuth2 PKCE → createDraftListing → uploadListingImage/Video/File → (ops.) aktif et.
 *
 * CLI:  node src/05_etsy_publisher.js --login   → görünür tarayıcıda 1 kez Etsy girişi (çerezler kaydedilir)
 *       node src/05_etsy_publisher.js --oauth   → API modu için OAuth2 PKCE yetkilendirmesi
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const httpServer = require('http');
const { exec } = require('child_process');
const { loadConfig, log, logError, PATHS, randomDelay, checkStop, retry, sleep } = require('./lib/core');
const { http, describeError } = require('./lib/http');

const LISTING_CREATE_URL = 'https://www.etsy.com/your/shops/me/listing-editor/create';
const LOGIN_URL = 'https://www.etsy.com/signin';
const API = 'https://api.etsy.com/v3/application';

/* =========================================================================
 * MOD A — PLAYWRIGHT
 * ========================================================================= */
async function launchBrowser(headless, cfg) {
  const { chromium } = require('playwright');
  const opts = {
    headless,
    viewport: { width: 1440, height: 920 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launchPersistentContext(PATHS.session, { ...opts, channel: cfg.browser_channel || undefined });
  } catch (e) {
    log(`"${cfg.browser_channel}" tarayıcısı açılamadı, Playwright Chromium deneniyor`, 'warn');
    return chromium.launchPersistentContext(PATHS.session, opts);
  }
}

const isLoginPage = (url) => /signin|login|\/join/.test(url);

/** Etsy giriş çerezleri (sekme/pencere değişse de güvenilir). */
async function hasEtsySession(ctx) {
  const cookies = await ctx.cookies('https://www.etsy.com').catch(() => []);
  const names = new Set(cookies.map((c) => c.name));
  return names.has('sign_in_method') && (names.has('session-key-www') || names.has('session-key-apex'));
}

/** Giriş yapılmamışsa kullanıcı giriş yapana kadar (en fazla 10 dk) bekler. */
async function ensureLoggedIn(ctx, page, { waitMinutes = 10 } = {}) {
  if (page.isClosed()) page = await ctx.newPage();
  await page.goto(LISTING_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  if (!isLoginPage(page.url()) && !(await page.locator('input[type="password"]').count())) return page;
  log('Etsy oturumu yok — açılan tarayıcı penceresinde Etsy hesabına giriş yapın (en fazla 10 dk beklenir)', 'warn');
  const deadline = Date.now() + waitMinutes * 60000;
  while (Date.now() < deadline) {
    checkStop();
    await sleep(3000);
    if (await hasEtsySession(ctx)) {
      log('Etsy girişi algılandı, oturum kaydedildi', 'success');
      if (page.isClosed()) page = await ctx.newPage();
      await page.goto(LISTING_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return page;
    }
    if (ctx.pages().length === 0) throw Object.assign(new Error('Tarayıcı kapatıldı, giriş tamamlanmadı'), { noRetry: true });
  }
  throw Object.assign(new Error('Etsy girişi 10 dakika içinde tamamlanmadı'), { noRetry: true });
}

/** Panelden "Etsy Oturumu Aç" butonu: görünür tarayıcıda giriş ekranını açar. */
async function loginInteractive() {
  const cfg = loadConfig();
  const ctx = await launchBrowser(false, cfg);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Tarayıcı açıldı. Etsy hesabınıza giriş yapın; giriş algılanınca pencere otomatik kapanır.');
    const deadline = Date.now() + 15 * 60000;
    while (Date.now() < deadline) {
      checkStop();
      await sleep(2500);
      // Giriş yeni sekme/pencerede (Google/Apple ile giriş) yapılsa da çerezler aynı profile yazılır
      if (await hasEtsySession(ctx)) {
        await sleep(2000); // çerezlerin diske yazılması için
        log('Etsy oturumu başarıyla kaydedildi ✓', 'success');
        return true;
      }
      if (ctx.pages().length === 0) break;
    }
    if (await hasEtsySession(ctx)) { log('Etsy oturumu başarıyla kaydedildi ✓', 'success'); return true; }
    throw new Error('Giriş tamamlanmadı (pencere kapandı ya da süre doldu)');
  } finally { await ctx.close().catch(() => {}); }
}

/* --- Dayanıklı form yardımcıları (Etsy arayüzü değiştikçe birden çok seçici dener) --- */
async function firstVisible(locators, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const l of locators) {
      const loc = l.first();
      if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return loc;
    }
    await sleep(250);
  }
  return null;
}

async function clickChoice(page, patterns, { roles = ['radio', 'button', 'option', 'checkbox', 'link', 'menuitem'], timeout = 5000, required = true, what = '' } = {}) {
  const locs = [];
  for (const p of patterns) {
    for (const r of roles) locs.push(page.getByRole(r, { name: p }));
    locs.push(page.getByLabel(p));
    locs.push(page.getByText(p, { exact: false }));
  }
  const el = await firstVisible(locs, timeout);
  if (!el) { if (required) throw new Error(`Seçenek bulunamadı: ${what || patterns.join(' / ')}`); return false; }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 5000 }).catch(async () => el.check({ force: true }));
  return true;
}

async function fillField(page, labels, value, { selectors = [], what = '', type = false } = {}) {
  const locs = [];
  for (const l of labels) { locs.push(page.getByLabel(l)); locs.push(page.getByRole('textbox', { name: l })); locs.push(page.getByPlaceholder(l)); }
  for (const s of selectors) locs.push(page.locator(s));
  const el = await firstVisible(locs, 6000);
  if (!el) throw new Error(`Alan bulunamadı: ${what || labels.join(' / ')}`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click();
  await el.fill('');
  if (type) await el.type(String(value), { delay: 25 }); else await el.fill(String(value));
  return el;
}

async function selectWhenMade(page) {
  const re = /2020\s*[-–]\s*2026/;
  const selects = page.locator('select');
  const n = await selects.count();
  for (let i = 0; i < n; i++) {
    const s = selects.nth(i);
    const options = await s.locator('option').allInnerTexts().catch(() => []);
    const opt = options.find((o) => re.test(o));
    if (opt) { await s.selectOption({ label: opt }); return true; }
  }
  // Özel açılır menü
  const opener = await firstVisible([page.getByRole('combobox', { name: /when.*made/i }), page.getByLabel(/when.*made/i), page.getByText(/when did you make it/i)], 3000);
  if (opener) { await opener.click(); await randomDelay(600, 1200); return clickChoice(page, [re], { what: '2020-2026' }); }
  throw new Error('"When was it made? 2020-2026" alanı bulunamadı');
}

/** Dosya inputunu "accept" niteliğine göre bulur ve dosyaları yükler. */
async function uploadByAccept(page, acceptRe, files, what) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const inp = inputs.nth(i);
    const accept = (await inp.getAttribute('accept').catch(() => '')) || '';
    const name = `${(await inp.getAttribute('name').catch(() => '')) || ''} ${(await inp.getAttribute('id').catch(() => '')) || ''}`;
    if (acceptRe.test(accept) || acceptRe.test(name)) {
      const multiple = (await inp.getAttribute('multiple')) !== null;
      if (multiple) await inp.setInputFiles(files);
      else for (const f of files) { await inp.setInputFiles(f); await randomDelay(1500, 3000); }
      return true;
    }
  }
  throw new Error(`Yükleme alanı bulunamadı: ${what}`);
}

async function addTags(page, tags) {
  const el = await firstVisible([
    page.getByLabel(/^tags/i), page.getByRole('textbox', { name: /tags?/i }), page.getByPlaceholder(/shape, color, style/i),
    page.locator('input#listing-tags-input'), page.locator('input[name*="tag" i]'),
  ], 6000);
  if (!el) throw new Error('Etiket alanı bulunamadı');
  for (const t of tags) {
    checkStop();
    await el.click();
    await el.type(t, { delay: 30 });
    await el.press('Enter');
    await randomDelay(400, 900);
  }
}

/** Etiket alanındaki mevcut (otomatik doldurulmuş) etiketleri temizler. */
async function clearExistingTags(page) {
  for (let i = 0; i < 20; i++) {
    const btn = page.locator('fieldset:has(legend:has-text("Tags")) button[aria-label*="Remove" i], fieldset:has(legend:has-text("Tags")) button[aria-label*="Delete" i]').first();
    if (!(await btn.count().catch(() => 0))) break;
    await btn.click().catch(() => {});
    await sleep(250);
  }
}

async function checkRadio(page, nameRe, what) {
  const r = page.getByRole('radio', { name: nameRe }).first();
  if (!(await r.count().catch(() => 0))) throw new Error(`Seçenek bulunamadı: ${what}`);
  await r.scrollIntoViewIfNeeded().catch(() => {});
  await r.check({ force: true }).catch(async () => r.click({ force: true }));
}

/**
 * Etsy'nin 2026 ilan formu: create sayfası önce "Quick list" açar → "Switch to standard list" ile
 * tek sayfalık standart forma geçilir. Dijital ürün, "Clip Art & Image Files (Digital)" kategorisi
 * seçilince ortaya çıkan "Digital files" alanıyla belirlenir (ayrı bir fiziksel/dijital seçimi yok).
 */
/** Etsy'nin fotoğraf/video/dijital dosya yüklemeleri bitene kadar bekler ("Loading", "Uploading", ilerleme çubukları). */
async function waitUploadsDone(page, maxMs) {
  const t0 = Date.now();
  let calm = 0;
  while (Date.now() - t0 < maxMs) {
    const busy = await page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      let n = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length || el.closest('button, [role="button"], .wt-screen-reader-only')) continue;
        const t = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        if (/^(loading|uploading|processing)\b/i.test(t) && t.length < 40 && r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden') n++;
      }
      n += [...document.querySelectorAll('[role="progressbar"], progress')].filter(vis).length;
      return n;
    }).catch(() => 0);
    if (!busy) { if (++calm >= 3) return true; } else calm = 0;
    await page.waitForTimeout(2000);
  }
  log('Etsy: yüklemeler uzun sürdü, yine de kaydetmeye çalışılıyor', 'warn');
  return false;
}

/** Formdaki gerçek hata mesajları ("Loading" vb. hariç). */
async function formErrors(page) {
  const out = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const texts = [];
    for (const el of document.querySelectorAll('[role="alert"], .wt-alert--error, .wt-validation__message, [class*="error" i], [class*="invalid" i]')) {
      if (!vis(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 300 && !/^(loading|uploading|processing)/i.test(t)) texts.push(t);
    }
    return texts;
  }).catch(() => []);
  return [...new Set(out)].filter((t) => !out.some((o) => o !== t && o.includes(t) && o.length < 300));
}

async function publishPlaywright({ product, meta, images, video, deliveryFiles, dir }) {
  const cfg = loadConfig();
  const ctx = await launchBrowser(!!cfg.headless_publish, cfg);
  let page = ctx.pages()[0] || await ctx.newPage();
  const shot = async (name) => page.screenshot({ path: path.join(dir, name), fullPage: true }).catch(() => {});
  try {
    page = await ensureLoggedIn(ctx, page);
    if (!/listing-editor\/create/.test(page.url())) await page.goto(LISTING_CREATE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 0) Quick list → standart form
    const sw = page.getByRole('button', { name: /switch to standard list/i }).first();
    if (await sw.count().catch(() => 0)) {
      log('Etsy: standart ilan formuna geçiliyor');
      await sw.click();
    }
    await page.locator('#listing-title-input').waitFor({ state: 'attached', timeout: 30000 });
    await randomDelay();

    // 1) Görseller + video (ilk dosya alanı: fotoğraf ve video)
    const media = [...images, ...(video && fs.existsSync(video) ? [video] : [])];
    log(`Etsy: ${images.length} görsel${media.length > images.length ? ' + video' : ''} yükleniyor`);
    await page.locator('input[type="file"]').first().setInputFiles(media);
    await page.waitForTimeout(8000 + media.length * 2500);
    await randomDelay();

    // 2) Kategori → Clip Art & Image Files (Digital)
    log('Etsy: kategori "Clip Art & Image Files (Digital)" seçiliyor');
    const digitalReady = () => page.getByText(/Buyers can download these files/i).first().isVisible().catch(() => false);
    if (!(await digitalReady())) {
      const quick = page.locator('#inline-category-6844').first();
      if (await quick.count().catch(() => 0)) {
        await quick.scrollIntoViewIfNeeded().catch(() => {});
        await quick.evaluate((el) => (el.closest('label') || el).click());
      } else {
        const cat = page.locator('#listing-editor_category-search-typeahead');
        await cat.scrollIntoViewIfNeeded().catch(() => {});
        await cat.click(); await cat.fill('');
        await cat.type(cfg.etsy_category_query || 'Clip Art & Image Files', { delay: 50 });
        await page.waitForTimeout(2500);
        await page.getByRole('option', { name: /clip art & image files/i }).first().click()
          .catch(() => page.getByRole('option').first().click());
      }
    }
    await page.getByText(/Buyers can download these files/i).first().waitFor({ timeout: 20000 })
      .catch(() => { throw new Error('Dijital kategori seçilemedi ("Digital files" alanı çıkmadı)'); });
    await page.waitForTimeout(2000);
    await randomDelay();

    // 3) Başlık
    log('Etsy: başlık ve açıklama yazılıyor');
    const title = page.locator('#listing-title-input');
    await title.scrollIntoViewIfNeeded().catch(() => {});
    await title.fill(meta.title);
    await randomDelay();

    // 4) Dijital teslim dosyası (son dosya alanı = "Digital files")
    log(`Etsy: teslimat dosyası yükleniyor (${deliveryFiles.map((f) => path.basename(f)).join(', ')})`);
    const inputs = page.locator('input[type="file"]');
    const n = await inputs.count();
    if (n < 2) throw new Error('"Digital files" yükleme alanı bulunamadı');
    await inputs.nth(n - 1).setInputFiles(deliveryFiles);
    await page.waitForTimeout(6000 + deliveryFiles.length * 3000);
    await randomDelay();

    // 5) Açıklama
    const desc = page.locator('#listing-description-textarea');
    await desc.scrollIntoViewIfNeeded().catch(() => {});
    await desc.fill(meta.description);
    await randomDelay();

    // 6) Etiketler
    log('Etsy: 13 etiket ekleniyor');
    await clearExistingTags(page);
    const tagInput = page.locator('#listing-tags-input');
    await tagInput.scrollIntoViewIfNeeded().catch(() => {});
    for (const t of meta.tags) {
      checkStop();
      await tagInput.click();
      await tagInput.fill(t);
      await tagInput.press('Enter');
      await randomDelay(500, 1100);
    }
    await randomDelay();

    // 6b) Zorunlu "Craft type" niteliği (Clip Art kategorisi)
    const craftWanted = cfg.etsy_craft_type || 'Scrapbooking';
    const craftInput = page.locator('xpath=//*[normalize-space(text())="Craft type"]/following::input[1]').first();
    if (await craftInput.count().catch(() => 0)) {
      log(`Etsy: Craft type = ${craftWanted}`);
      await craftInput.scrollIntoViewIfNeeded().catch(() => {});
      await craftInput.click();
      await page.waitForTimeout(1200);
      const opt = page.getByRole('checkbox', { name: new RegExp(`^${craftWanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
      if (await opt.count().catch(() => 0)) await opt.check({ force: true }).catch(() => opt.click({ force: true }));
      else await page.getByText(craftWanted, { exact: true }).first().click().catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await randomDelay();
    }

    // 7) Fiyat ve stok
    log(`Etsy: fiyat ${meta.price} ${cfg.currency || ''}, stok ${meta.quantity}`);
    const price = page.locator('#listing-price-input');
    await price.scrollIntoViewIfNeeded().catch(() => {});
    await price.fill(Number(meta.price).toFixed(2));
    await randomDelay();
    await page.locator('#listing-quantity-input').fill(String(meta.quantity));
    await randomDelay();

    // 8) Nasıl yapıldı: I did → A finished product → (AI beyanı) → 2020-2026
    log('Etsy: "I did → A finished product" işaretleniyor');
    await checkRadio(page, /^I did/i, 'Who made it: I did');
    await randomDelay(600, 1400);
    await checkRadio(page, /^A finished product/i, 'What is it: A finished product');
    await randomDelay(600, 1400);
    const aiRadio = page.getByRole('radio', { name: cfg.ai_disclosure ? /with an ai generator/i : /^created by me/i }).first();
    if (await aiRadio.count().catch(() => 0)) {
      await aiRadio.check({ force: true }).catch(() => {});
      log(cfg.ai_disclosure ? 'Etsy: "With an AI generator" beyanı işaretlendi' : 'Etsy: "Created by me" işaretlendi');
    }
    const when = page.locator('#when-made-select');
    if (await when.count().catch(() => 0)) await when.selectOption({ label: '2020 - 2026' }).catch(() => {});
    // Dükkân bölümü: sezona göre Christmas / Thanksgiving / Other Designs
    try {
      let season = '';
      try { const t = JSON.parse(fs.readFileSync(path.join(dir, 'trend.json'), 'utf8')); season = `${t.season || ''} ${t.keyword || ''}`.toLowerCase(); } catch {}
      const want = /thanksgiving|turkey|fall|autumn/.test(season) ? /thanksgiving/i : /christmas|xmas|holiday|black friday|winter|santa/.test(season) ? /christmas/i : /other/i;
      const sec = page.locator('#shop-section-select');
      if (await sec.count().catch(() => 0)) {
        const opts = await sec.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
        const hit = opts.find((o) => want.test(o.t)) || opts.find((o) => /other/i.test(o.t));
        if (hit) { await sec.selectOption(hit.v); log(`Etsy: bölüm = ${hit.t}`); }
      }
    } catch (e) { log(`Etsy: bölüm seçilemedi (${e.message.slice(0, 80)})`, 'warn'); }
    await randomDelay();

    // 9) Kaydet / Yayınla — önce tüm görsel/dosya yüklemelerinin bitmesini bekle
    await waitUploadsDone(page, 6 * 60000);
    await shot('publish_before_submit.png');
    const publish = !!cfg.auto_publish;
    log(publish ? 'Etsy: "Publish" butonuna basılıyor' : 'Etsy: "Save as draft" butonuna basılıyor');
    let url = page.url();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.getByRole('button', { name: publish ? /^publish$/i : /^save as draft$/i }).first().click();
      if (publish) {
        await randomDelay(1500, 2500);
        await clickChoice(page, [/^publish$/i, /^confirm$/i], { roles: ['button'], required: false, timeout: 4000 });
      }
      await page.waitForURL((u) => !/listing-editor\/create/.test(u.toString()), { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(4000);
      url = page.url();
      if (!/listing-editor\/create/.test(url)) break;
      const errs = await formErrors(page);
      if (errs.length) {
        throw Object.assign(new Error(`Etsy formu kaydetmedi: ${errs.join(' | ').slice(0, 300)}`), { noRetry: true });
      }
      if (attempt < 3) { log(`Etsy henüz kaydetmedi (yüklemeler sürüyor olabilir) — bekleyip tekrar deneniyor (${attempt}/3)`, 'warn'); await waitUploadsDone(page, 3 * 60000); }
    }
    if (/listing-editor\/create/.test(url)) throw Object.assign(new Error('Etsy formu kaydetmedi: dosya yüklemesi bitmedi ya da Etsy cevap vermedi (internet yavaş olabilir)'), { noRetry: true });
    const id = (url.match(/(?:edit|listing)\/(\d{6,})/) || url.match(/(\d{8,})/) || [])[1] || null;
    await shot('publish_after_submit.png');
    return { listing_id: id, listing_url: id ? `https://www.etsy.com/listing/${id}` : url, status: publish ? 'Yayında' : 'Taslak' };
  } catch (e) {
    await shot('publish_error.png');
    throw e;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* =========================================================================
 * MOD B — ETSY OPEN API v3 (OAuth2 PKCE)
 * ========================================================================= */
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function apiKeyHeader() {
  const key = process.env.ETSY_API_KEY;
  if (!key) throw Object.assign(new Error('ETSY_API_KEY .env içinde tanımlı değil'), { noRetry: true });
  const secret = process.env.ETSY_SHARED_SECRET;
  return secret ? `${key}:${secret}` : key;
}

function openExternal(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

function saveTokens(t) {
  const user_id = String(t.access_token).split('.')[0];
  const data = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000, user_id };
  fs.writeFileSync(PATHS.tokens, JSON.stringify(data, null, 2));
  return data;
}

async function runOAuth() {
  const cfg = loadConfig();
  const clientId = process.env.ETSY_API_KEY;
  if (!clientId) throw new Error('ETSY_API_KEY (keystring) .env içinde tanımlı değil');
  const redirect = new URL(cfg.etsy_redirect_uri);
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = `https://www.etsy.com/oauth/connect?${new URLSearchParams({
    response_type: 'code', redirect_uri: cfg.etsy_redirect_uri, scope: 'listings_r listings_w shops_r',
    client_id: clientId, state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`;
  const code = await new Promise((resolve, reject) => {
    const srv = httpServer.createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      if (u.pathname !== redirect.pathname) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.end('<h2>Yetkilendirme başarısız.</h2>'); srv.close(); return reject(new Error(u.searchParams.get('error') || 'state uyuşmadı'));
      }
      res.end('<h2 style="font-family:sans-serif">Etsy bağlantısı tamam ✓ Bu pencereyi kapatabilirsiniz.</h2>');
      srv.close(); resolve(u.searchParams.get('code'));
    });
    srv.listen(Number(redirect.port || 80), redirect.hostname, () => {
      log('Etsy yetkilendirme sayfası tarayıcıda açılıyor...');
      openExternal(authUrl);
    });
    setTimeout(() => { srv.close(); reject(new Error('OAuth 10 dakika içinde tamamlanmadı')); }, 10 * 60000);
  });
  const res = await http.post('https://api.etsy.com/v3/public/oauth/token', new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: cfg.etsy_redirect_uri, code, code_verifier: verifier,
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  saveTokens(res.data);
  log('Etsy API token kaydedildi (data/etsy_tokens.json)', 'success');
  return true;
}

async function accessToken() {
  if (!fs.existsSync(PATHS.tokens)) throw Object.assign(new Error('Etsy API yetkisi yok — panelde "Etsy API Yetkilendir" ya da "npm run auth" çalıştırın'), { noRetry: true });
  let t = JSON.parse(fs.readFileSync(PATHS.tokens, 'utf8'));
  if (Date.now() >= t.expires_at) {
    const res = await http.post('https://api.etsy.com/v3/public/oauth/token', new URLSearchParams({
      grant_type: 'refresh_token', client_id: process.env.ETSY_API_KEY, refresh_token: t.refresh_token,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
    t = saveTokens(res.data);
  }
  return t.access_token;
}

async function apiHeaders(extra = {}) {
  return { 'x-api-key': apiKeyHeader(), Authorization: `Bearer ${await accessToken()}`, ...extra };
}

async function getShopId() {
  if (process.env.ETSY_SHOP_ID) return process.env.ETSY_SHOP_ID;
  const res = await http.get(`${API}/users/me`, { headers: await apiHeaders(), timeout: 30000 });
  if (!res.data.shop_id) throw new Error('Bu hesapta Etsy mağazası bulunamadı');
  return String(res.data.shop_id);
}

async function findTaxonomyId(cfg) {
  if (cfg.etsy_taxonomy_id) return Number(cfg.etsy_taxonomy_id);
  const res = await http.get(`${API}/seller-taxonomy/nodes`, { headers: { 'x-api-key': apiKeyHeader() }, timeout: 30000 });
  const want = new RegExp(cfg.etsy_category_query || 'clip art', 'i');
  const stack = [...(res.data.results || [])];
  while (stack.length) {
    const n = stack.shift();
    if (want.test(n.name)) return n.id;
    if (n.children) stack.push(...n.children);
  }
  throw new Error(`Etsy kategorisi bulunamadı ("${cfg.etsy_category_query}") — config.json'da etsy_taxonomy_id girin`);
}

function fileForm(field, filePath, extra = {}) {
  const fd = new FormData();
  const mime = /\.mp4$/i.test(filePath) ? 'video/mp4' : /\.zip$/i.test(filePath) ? 'application/zip' : /\.pdf$/i.test(filePath) ? 'application/pdf' : /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
  fd.append(field, new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  return fd;
}

async function publishApi({ meta, images, video, deliveryFiles }) {
  const cfg = loadConfig();
  const shopId = await getShopId();
  const taxonomyId = await findTaxonomyId(cfg);
  const body = new URLSearchParams({
    quantity: String(meta.quantity), title: meta.title, description: meta.description, price: meta.price.toFixed(2),
    who_made: 'i_did', when_made: '2020_2026', is_supply: 'false', taxonomy_id: String(taxonomyId), type: 'download',
    tags: meta.tags.join(','), materials: (meta.materials || []).join(','),
  });
  log('Etsy API: createDraftListing');
  const res = await http.post(`${API}/shops/${shopId}/listings`, body.toString(), {
    headers: await apiHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }), timeout: 60000,
  });
  const listingId = res.data.listing_id;
  const base = `${API}/shops/${shopId}/listings/${listingId}`;
  for (let i = 0; i < images.length; i++) {
    checkStop();
    log(`Etsy API: uploadListingImage ${i + 1}/${images.length}`);
    await retry(async () => http.post(`${base}/images`, fileForm('image', images[i], { rank: i + 1 }), { headers: await apiHeaders(), timeout: 120000 }), { label: 'uploadListingImage' });
  }
  if (video && fs.existsSync(video)) {
    log('Etsy API: uploadListingVideo');
    await retry(async () => http.post(`${base}/videos`, fileForm('video', video, { name: 'listing_video.mp4' }), { headers: await apiHeaders(), timeout: 300000 }), { label: 'uploadListingVideo' })
      .catch((e) => log(`Video yüklenemedi: ${describeError(e)}`, 'warn'));
  }
  for (let i = 0; i < deliveryFiles.length; i++) {
    log(`Etsy API: uploadListingFile ${path.basename(deliveryFiles[i])}`);
    await retry(async () => http.post(`${base}/files`, fileForm('file', deliveryFiles[i], { name: path.basename(deliveryFiles[i]), rank: i + 1 }), { headers: await apiHeaders(), timeout: 300000 }), { label: 'uploadListingFile' });
  }
  let status = 'Taslak';
  if (cfg.auto_publish) {
    log('Etsy API: ilan aktif ediliyor');
    await http.patch(base, new URLSearchParams({ state: 'active' }).toString(), { headers: await apiHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }), timeout: 60000 });
    status = 'Yayında';
  }
  return { listing_id: String(listingId), listing_url: `https://www.etsy.com/listing/${listingId}`, status };
}

/* =========================================================================
 * Ortak giriş noktası
 * ========================================================================= */
function collectFiles(dir) {
  const mdir = path.join(dir, 'mockups');
  const images = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => path.join(mdir, f)).slice(0, 10) : [];
  const video = path.join(dir, 'listing_video.mp4');
  const deliv = [];
  if (fs.existsSync(path.join(dir, 'Download_Instructions.pdf'))) deliv.push(path.join(dir, 'Download_Instructions.pdf'));
  else {
    const parts = fs.readdirSync(dir).filter((f) => /^deliverable_part\d+\.zip$/.test(f)).sort();
    if (parts.length) deliv.push(...parts.map((f) => path.join(dir, f)));
    else if (fs.existsSync(path.join(dir, 'deliverable.zip'))) deliv.push(path.join(dir, 'deliverable.zip'));
  }
  const metaPath = path.join(dir, 'seo_metadata.json');
  if (!fs.existsSync(metaPath)) throw new Error('seo_metadata.json bulunamadı');
  return { images, video: fs.existsSync(video) ? video : null, deliveryFiles: deliv, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
}

async function publishProduct(product) {
  const cfg = loadConfig();
  const dir = product.folder;
  const files = collectFiles(dir);
  if (!files.images.length) throw new Error('Yüklenecek görsel yok');
  if (!files.deliveryFiles.length) throw new Error('Teslimat dosyası (ZIP/PDF) yok');
  // Fiyat her zaman panelin güncel fiyatından (Fiyat & Kâr bölümü) alınır; üretim anındaki eski fiyat kullanılmaz
  if (Number(cfg.price) > 0 && !files.meta.price_fixed) files.meta.price = Number(cfg.price); // dev paket gibi özel fiyatlı ürünler hariç
  const mode = cfg.publish_mode === 'api' ? 'api' : 'playwright';
  log(`Etsy'ye yükleniyor (${mode === 'api' ? 'Resmi API v3' : 'Tarayıcı otomasyonu'}, ${cfg.auto_publish ? 'direkt yayın' : 'taslak'})`);
  const result = mode === 'api'
    ? await publishApi({ ...files, product, dir })
    : await publishPlaywright({ ...files, product, dir });
  log(`Etsy'ye yüklendi! ${result.status} — ${result.listing_url}`, 'success');
  return { ...result, fee: result.status === 'Yayında' ? cfg.costs.etsy_listing_fee : 0 };
}

module.exports = { publishProduct, loginInteractive, runOAuth, publishPlaywright, publishApi, collectFiles, launchBrowser, ensureLoggedIn, waitUploadsDone, formErrors };

if (require.main === module) {
  require('./lib/core').bus.on('log', (e) => console.log(`[${e.level}] ${e.msg}`));
  const run = process.argv.includes('--oauth') ? runOAuth : loginInteractive;
  run().then(() => process.exit(0)).catch((e) => { logError('Yükleyici', e); process.exit(1); });
}
