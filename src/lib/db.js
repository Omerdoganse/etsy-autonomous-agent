'use strict';
/**
 * SQLite katmanı. better-sqlite3 varsa onu, yoksa Node'un dahili node:sqlite modülünü kullanır.
 * Tablolar: products (üretimler), keywords (kullanılmış anahtar kelimeler/nişler).
 */
const { PATHS } = require('./core');

let _db = null;

function openDb() {
  if (_db) return _db;
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(PATHS.db);
    db.pragma('journal_mode = WAL');
  } catch {
    const origEmit = process.emitWarning;
    process.emitWarning = () => {};
    const { DatabaseSync } = require('node:sqlite');
    process.emitWarning = origEmit;
    db = new DatabaseSync(PATHS.db);
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      niche TEXT,
      keyword TEXT,
      title TEXT,
      tags TEXT,
      status TEXT,
      cost REAL DEFAULT 0,
      folder TEXT,
      thumbnail TEXT,
      listing_id TEXT,
      listing_url TEXT,
      dry_run INTEGER DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS keywords (
      keyword TEXT PRIMARY KEY,
      niche TEXT,
      used_at TEXT NOT NULL,
      product_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);
  `);
  _db = db;
  return db;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function isKeywordUsed(keyword) {
  const db = openDb();
  const k = norm(keyword);
  const a = db.prepare('SELECT 1 AS x FROM keywords WHERE keyword = ?').get(k);
  if (a) return true;
  const b = db.prepare('SELECT 1 AS x FROM products WHERE dry_run = 0 AND (lower(keyword) = ? OR lower(niche) = ?)').get(k, k);
  return !!b;
}

function usedKeywords() {
  const db = openDb();
  const rows = db.prepare('SELECT keyword FROM keywords').all();
  const rows2 = db.prepare('SELECT keyword, niche FROM products WHERE dry_run = 0').all();
  const set = new Set(rows.map((r) => norm(r.keyword)));
  for (const r of rows2) { if (r.keyword) set.add(norm(r.keyword)); if (r.niche) set.add(norm(r.niche)); }
  return set;
}

function markKeywordUsed(keyword, niche, productId) {
  openDb().prepare('INSERT OR IGNORE INTO keywords (keyword, niche, used_at, product_id) VALUES (?, ?, ?, ?)')
    .run(norm(keyword), niche || null, new Date().toISOString(), productId || null);
}

function saveProduct(p) {
  const db = openDb();
  const row = {
    id: p.id,
    created_at: p.created_at || new Date().toISOString(),
    niche: p.niche || null,
    keyword: p.keyword || null,
    title: p.title || null,
    tags: JSON.stringify(p.tags || []),
    status: p.status || 'Hazır',
    cost: Number(p.cost || 0),
    folder: p.folder || null,
    thumbnail: p.thumbnail || null,
    listing_id: p.listing_id ? String(p.listing_id) : null,
    listing_url: p.listing_url || null,
    dry_run: p.dry_run ? 1 : 0,
    error: p.error || null,
  };
  db.prepare(`INSERT INTO products (id, created_at, niche, keyword, title, tags, status, cost, folder, thumbnail, listing_id, listing_url, dry_run, error)
    VALUES (@id, @created_at, @niche, @keyword, @title, @tags, @status, @cost, @folder, @thumbnail, @listing_id, @listing_url, @dry_run, @error)
    ON CONFLICT(id) DO UPDATE SET niche=excluded.niche, keyword=excluded.keyword, title=excluded.title, tags=excluded.tags,
      status=excluded.status, cost=excluded.cost, folder=excluded.folder, thumbnail=excluded.thumbnail,
      listing_id=excluded.listing_id, listing_url=excluded.listing_url, dry_run=excluded.dry_run, error=excluded.error`)
    .run(row);
}

function updateProduct(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id };
  for (const k of keys) params[k] = k === 'tags' ? JSON.stringify(fields[k]) : fields[k];
  openDb().prepare(`UPDATE products SET ${sets} WHERE id = @id`).run(params);
}

function getProduct(id) {
  const r = openDb().prepare('SELECT * FROM products WHERE id = ?').get(id);
  return r ? { ...r, tags: safeJson(r.tags) } : null;
}

function listProducts(limit = 200) {
  return openDb().prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, tags: safeJson(r.tags) }));
}

function todayStart() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
}
function countToday() {
  const r = openDb().prepare("SELECT COUNT(*) AS c FROM products WHERE dry_run = 0 AND created_at >= ? AND status NOT IN ('Hata','Arşiv')").get(todayStart());
  return Number(r.c || 0);
}

function stats(dailyLimit) {
  const db = openDb();
  const total = Number(db.prepare("SELECT COUNT(*) AS c FROM products WHERE status NOT IN ('Hata','Arşiv')").get().c || 0);
  const review = Number(db.prepare("SELECT COUNT(*) AS c FROM products WHERE status = 'İnceleme'").get().c || 0);
  const uploaded = Number(db.prepare("SELECT COUNT(*) AS c FROM products WHERE status IN ('Taslak','Yayında')").get().c || 0);
  const cost = Number(db.prepare('SELECT COALESCE(SUM(cost),0) AS s FROM products').get().s || 0);
  const today = countToday();
  return { total, uploaded, review, today, remaining: Math.max(0, (dailyLimit || 0) - today), cost: Math.round(cost * 1000) / 1000 };
}

function safeJson(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

function deleteProduct(id) { openDb().prepare('DELETE FROM products WHERE id = ?').run(id); }

module.exports = { deleteProduct, openDb, isKeywordUsed, usedKeywords, markKeywordUsed, saveProduct, updateProduct, getProduct, listProducts, countToday, stats };
