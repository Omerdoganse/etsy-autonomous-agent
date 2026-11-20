'use strict';
/**
 * Ortak çekirdek: yollar, config/.env yükleme, olay veriyolu (log/progress),
 * hata günlüğü, retry (exponential backoff), yardımcılar.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');
const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  db: path.join(ROOT, 'data', 'database.sqlite'),
  session: path.join(ROOT, 'data', 'browser_session'),
  mockups: path.join(ROOT, 'data', 'base_mockups'),
  deliveryTemplate: path.join(ROOT, 'data', 'delivery_template.pdf'),
  tokens: path.join(ROOT, 'data', 'etsy_tokens.json'),
  logs: path.join(ROOT, 'logs'),
  errorLog: path.join(ROOT, 'logs', 'error.log'),
  output: path.join(ROOT, 'output'),
  config: path.join(ROOT, 'config.json'),
  env: path.join(ROOT, '.env'),
};
for (const d of [PATHS.data, PATHS.session, PATHS.mockups, PATHS.logs, PATHS.output]) {
  fs.mkdirSync(d, { recursive: true });
}

/* ---------------- .env ---------------- */
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
function loadEnv() {
  if (!fs.existsSync(PATHS.env)) return;
  try {
    require('dotenv').config({ path: PATHS.env, override: true, quiet: true });
  } catch {
    const vars = parseEnv(fs.readFileSync(PATHS.env, 'utf8'));
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  }
}
loadEnv();

/* ---------------- config.json ---------------- */
const DEFAULT_CONFIG = {
  price: 199.99,
  quantity: 999,
  currency: 'TRY',
  daily_limit: 8,
  default_count: 5,
  publish_mode: 'playwright',
  auto_publish: false,
  custom_niche: '',
  bundle_size: 4,
  lookahead_days: 60,
  min_lead_days: 7,
  image_provider: 'replicate',
  replicate_model: 'black-forest-labs/flux-schnell',
  openai_image_model: 'gpt-image-1',
  openai_text_model: 'gpt-4.1-mini',
  bg_removal: 'replicate',
  replicate_bg_model: 'bria/remove-background',
  ai_upscale: false,
  replicate_upscale_model: 'nightmareai/real-esrgan',
  output_width: 4500,
  output_height: 5400,
  dpi: 300,
  zip_limit_mb: 19,
  large_file_strategy: 'cloud',
  cloud_link_expiry_days: 7,
  ai_disclosure: true,
  browser_channel: 'msedge',
  headless_publish: false,
  etsy_category_query: 'clip art',
  check_competition: false,
  trend_sources: ['etsy', 'google'],
  etsy_taxonomy_id: null,
  etsy_redirect_uri: 'http://localhost:3003/callback',
  costs: {
    replicate_flux_schnell: 0.003,
    replicate_recraft_v3: 0.04,
    replicate_bg_removal: 0.002,
    replicate_upscale: 0.004,
    openai_image: 0.06,
    openai_text: 0.002,
    etsy_listing_fee: 0.2,
    qc_vision: 0.002,
  },
  qc_enabled: true,
  qc_vision: true,
  qc_vision_model: 'openai/gpt-4o-mini',
  qc_max_regenerate: 2,
  qc_drop_failed: true,
  qc_block_on_fail: true,
  schedule: { enabled: false, times: ['10:00'], days: [1, 2, 3, 4, 5, 6, 0], count: 3 },
  close_to_tray: true,
  blocked_terms: [
    'disney', 'marvel', 'pixar', 'mickey', 'minnie', 'grinch', 'stitch', 'harry potter', 'hogwarts',
    'star wars', 'pokemon', 'nintendo', 'mario', 'barbie', 'taylor swift', 'swiftie', 'eras tour',
    'nfl', 'nba', 'mlb', 'nhl', 'starbucks', 'stanley', 'nike', 'adidas', 'chanel', 'gucci', 'louis vuitton',
    'coca cola', 'peanuts', 'snoopy', 'bluey', 'sanrio', 'hello kitty', 'looney', 'scooby', 'friends tv',
    'yellowstone', 'beetlejuice', 'jack skellington', 'nightmare before', 'hocus pocus', 'sanderson',
  ],
};

function loadConfig() {
  let user = {};
  if (fs.existsSync(PATHS.config)) {
    try { user = JSON.parse(fs.readFileSync(PATHS.config, 'utf8')); } catch (e) {
      logError('config.json okunamadı, varsayılanlar kullanılıyor', e);
    }
  }
  return { ...DEFAULT_CONFIG, ...user, costs: { ...DEFAULT_CONFIG.costs, ...(user.costs || {}) } };
}

/* ---------------- olay veriyolu ---------------- */
const bus = new EventEmitter();
bus.setMaxListeners(50);

function ts() { return new Date().toISOString(); }

const ACTIVITY_LOG = path.join(PATHS.logs, 'activity.log');
function log(msg, level = 'info', extra = {}) {
  const entry = { ts: ts(), level, msg, ...extra };
  bus.emit('log', entry);
  try {
    if (fileSize(ACTIVITY_LOG) > 2 * 1048576) fs.renameSync(ACTIVITY_LOG, `${ACTIVITY_LOG}.1`);
    fs.appendFileSync(ACTIVITY_LOG, `${JSON.stringify(entry)}\n`);
  } catch { /* günlük yazılamazsa önemli değil */ }
  return entry;
}
/** GUI'ye canlı log gönderir (IPC modunda index.js bunu process.send'e bağlar). */
function sendLogToGUI(msg, level = 'info') { return log(msg, level); }

function progress(data) { bus.emit('progress', data); }

function logError(context, err) {
  const line = `[${ts()}] ${context}: ${err && err.stack ? err.stack : String(err)}\n`;
  try { fs.appendFileSync(PATHS.errorLog, line); } catch { /* yok say */ }
  log(`${context}: ${err && err.message ? err.message : String(err)}`, 'error');
}

/* ---------------- durdurma ---------------- */
const control = { stopRequested: false };
class StopError extends Error { constructor() { super('Kullanıcı tarafından durduruldu'); this.name = 'StopError'; } }
function checkStop() { if (control.stopRequested) throw new StopError(); }

/* ---------------- retry ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { retries = 3, baseDelay = 2000, label = 'işlem' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    checkStop();
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof StopError || err.noRetry) throw err;
      lastErr = err;
      logError(`${label} (deneme ${attempt + 1}/${retries + 1})`, err);
      if (attempt < retries) {
        const wait = baseDelay * 2 ** attempt + Math.floor(Math.random() * 500);
        log(`${label} tekrar denenecek: ${Math.round(wait / 1000)} sn sonra`, 'warn');
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/* ---------------- yardımcılar ---------------- */
function randomDelay(min = 1500, max = 4500) {
  return sleep(Math.floor(min + Math.random() * (max - min)));
}
function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 40);
}
function newProductId(keyword) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${stamp}-${slugify(keyword).slice(0, 28)}-${crypto.randomBytes(3).toString('hex')}`;
}
function titleCase(s) {
  const small = new Set(['a', 'an', 'and', 'or', 'the', 'for', 'of', 'in', 'on', 'to', 'with']);
  return String(s).split(/\s+/).filter(Boolean).map((w, i) => {
    const lw = w.toLowerCase();
    if (['png', 'svg', 'dtf', 'dpi', 'pod', 'diy'].includes(lw)) return lw.toUpperCase();
    if (i > 0 && small.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

module.exports = {
  ROOT, PATHS, DEFAULT_CONFIG, ACTIVITY_LOG, loadConfig, loadEnv, parseEnv,
  bus, log, sendLogToGUI, progress, logError,
  control, StopError, checkStop,
  sleep, retry, randomDelay, slugify, newProductId, titleCase, escapeXml, fileSize,
};
