'use strict';
/**
 * MODÜL 1 — Trend ve Niş Avcısı
 * 1) Bugünden itibaren önümüzdeki N gün (varsayılan 60) içindeki sezon/etkinlikleri bulur.
 * 2) Etsy arama otomatik tamamlama (axios → olmazsa Playwright oturumu) ve Google Suggest ile
 *    uzun kuyruklu anahtar kelimeler toplar.
 * 3) Daha önce kullanılan niş/anahtar kelimeleri ve marka/telifli terimleri eler.
 * 4) Puanlayıp en iyi nişi { keyword, niche, season, audience, style, ... } olarak döndürür.
 */
const fs = require('fs');
const { loadConfig, log, logError, PATHS, checkStop } = require('./lib/core');
const { http, describeError } = require('./lib/http');
const db = require('./lib/db');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/* ---------- Takvim ---------- */
function nthWeekday(year, month, weekday, n) { // month 0-11, weekday 0=Pazar
  const d = new Date(year, month, 1);
  const offset = (weekday - d.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}
function lastWeekday(year, month, weekday) {
  const d = new Date(year, month + 1, 0);
  const offset = (d.getDay() - weekday + 7) % 7;
  return new Date(year, month, d.getDate() - offset);
}

const EVENTS = [
  { name: 'Valentine\'s Day', date: (y) => new Date(y, 1, 14), seeds: ['valentines', 'galentines', 'anti valentines'], audience: 'couples, teachers, gift buyers', styles: ['retro groovy', 'coquette bow', 'hand lettered'] },
  { name: 'St. Patrick\'s Day', date: (y) => new Date(y, 2, 17), seeds: ['st patricks day', 'lucky'], audience: 'party goers, teachers, moms', styles: ['retro', 'distressed vintage', 'cute kawaii'] },
  { name: 'Easter', date: (y) => easter(y), seeds: ['easter', 'easter bunny'], audience: 'moms, kids, church groups', styles: ['pastel watercolor', 'retro groovy', 'boho floral'] },
  { name: 'Mother\'s Day', date: (y) => nthWeekday(y, 4, 0, 2), seeds: ['mothers day', 'mama', 'mom life'], audience: 'moms and gift buyers', styles: ['boho floral', 'retro wavy', 'minimalist script'] },
  { name: 'Father\'s Day', date: (y) => nthWeekday(y, 5, 0, 3), seeds: ['fathers day', 'dad', 'girl dad'], audience: 'dads and gift buyers', styles: ['vintage distressed', 'retro sunset', 'funny typography'] },
  { name: '4th of July', date: (y) => new Date(y, 6, 4), seeds: ['4th of july', 'america', 'usa'], audience: 'american families, party hosts', styles: ['retro americana', 'distressed vintage', 'coquette'] },
  { name: 'Summer', date: (y) => new Date(y, 5, 21), seeds: ['summer', 'beach', 'lake life', 'summer vibes'], audience: 'vacationers, families, beach lovers', styles: ['retro sunset', 'tropical', 'groovy'] },
  { name: 'Back to School', date: (y) => new Date(y, 7, 15), seeds: ['back to school', 'teacher', 'first day of school'], audience: 'teachers and parents', styles: ['retro groovy', 'doodle', 'checkered'] },
  { name: 'Fall / Autumn', date: (y) => new Date(y, 8, 22), seeds: ['fall', 'pumpkin spice', 'autumn'], audience: 'cozy season lovers, moms', styles: ['retro', 'boho', 'western'] },
  { name: 'Halloween', date: (y) => new Date(y, 9, 31), seeds: ['halloween', 'spooky', 'ghost'], audience: 'party goers, moms, teachers', styles: ['retro spooky', 'cute ghost', 'vintage horror'] },
  { name: 'Thanksgiving', date: (y) => nthWeekday(y, 10, 4, 4), seeds: ['thanksgiving', 'thankful', 'turkey'], audience: 'families, hosts, teachers', styles: ['retro', 'boho autumn', 'funny'] },
  { name: 'Black Friday / Holiday Shopping', date: (y) => new Date(nthWeekday(y, 10, 4, 4).getTime() + 86400000), seeds: ['christmas shirt', 'holiday season', 'christmas family'], audience: 'gift shoppers', styles: ['minimalist', 'retro', 'vintage'] },
  { name: 'Hanukkah', date: (y) => new Date(y, 11, 14), seeds: ['hanukkah'], audience: 'jewish families', styles: ['modern minimalist', 'retro'] },
  { name: 'Christmas', date: (y) => new Date(y, 11, 25), seeds: ['christmas', 'santa', 'christmas tree', 'merry christmas', 'western christmas', 'ugly christmas'], audience: 'families, gift buyers, matching pajamas crowd', styles: ['retro western', 'vintage', 'coquette bow', 'funny', 'watercolor'] },
  { name: 'New Year', date: (y) => new Date(y + 1, 0, 1), seeds: ['new year', 'nye', 'hello 2027'], audience: 'party goers', styles: ['disco retro', 'gold glitter look', 'minimalist'] },
  { name: 'Teacher Appreciation', date: (y) => lastWeekday(y, 4, 1), seeds: ['teacher appreciation', 'teacher life'], audience: 'teachers and parents', styles: ['retro groovy', 'doodle'] },
  { name: 'Graduation', date: (y) => new Date(y, 4, 25), seeds: ['graduation', 'class of 2027', 'senior'], audience: 'graduates and families', styles: ['retro', 'varsity'] },
];
const EVERGREEN = [
  { seeds: ['dog mom', 'cat mom', 'plant lady'], audience: 'pet & plant lovers', styles: ['boho', 'retro', 'minimalist line art'] },
  { seeds: ['nurse', 'teacher', 'developer', 'gamer'], audience: 'professionals & hobbyists', styles: ['funny typography', 'retro', 'minimalist'] },
  { seeds: ['mental health', 'self love', 'bookish'], audience: 'women 18-45', styles: ['groovy retro', 'boho floral', 'hand lettered'] },
];
const MODIFIERS = ['png', 'sublimation png', 'shirt png', 'png bundle', 'shirt design', 'dtf png', 'svg png'];
// Alıcıların gerçekten aradığı hedef kitleler (Etsy'de en çok satan PNG nişleri)
const AUDIENCE_SEEDS = {
  default: ['teacher', 'nurse', 'mama', 'dog mom', 'family', 'grandma', 'kids'],
  Christmas: ['teacher', 'nurse', 'mama', 'dog mom', 'cat mom', 'family matching', 'grandma', 'nicu nurse', 'cowgirl', 'kids'],
  Thanksgiving: ['teacher', 'mama', 'family', 'grandma', 'nurse', 'kids', 'friendsgiving'],
  Halloween: ['teacher', 'nurse', 'mama', 'dog mom', 'kids'],
  "Valentine's Day": ['teacher', 'nurse', 'mama', 'dog mom', 'kids'],
};
// Tişört/PNG alıcısı olmayan aramalar (tarif, hediye etiketi, paketleme, isim listesi, resim/meme…)
const NON_BUYER = /\b(pictures?|images?|photos?|memes?|gifs?|jokes?|names?|recipes?|packing|tags?|wrapping|paper|cards?|decor|decorations?|ideas?|crafts?|coloring|wallpaper|background|outfits?|costumes?|songs?|movies?|games?|activities|nails?|cakes?|cookies?|door|ornaments?|wreath|quotes? for|tree topper|emoji|clip ?art free|drawing|easy|transparent background free|cartoon images|gift guide|for him ideas)\b/;
const AUDIENCE_RE = /\b(teachers?|nurses?|nicu|mama|mom|moms|mommy|dad|daddy|grandma|nana|gigi|dog|cat|family|matching|squad|crew|kids|toddler|womens?|mens|boys?|girls?|cowgirl|cowboy|friendsgiving|coworkers?|besties?)\b/;

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1, day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month, day);
}

function upcomingEvents(now = new Date(), days = 60, minLead = 7) {
  const out = [];
  for (const ev of EVENTS) {
    for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
      const d = ev.date(y);
      const diff = Math.round((d - now) / 86400000);
      if (diff >= minLead && diff <= days) out.push({ ...ev, eventDate: d, daysUntil: diff });
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil);
}

/* ---------- Anahtar kelime kaynakları ---------- */
async function etsySuggestHttp(q) {
  const res = await http.get('https://www.etsy.com/suggestions_ajax.php', {
    params: { search_query: q, search_type: 'all', version: 10_2_1 },
    headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.etsy.com/' },
    timeout: 12000,
  });
  const d = res.data;
  const list = Array.isArray(d && d.results) ? d.results : Array.isArray(d) ? d : [];
  return list.map((r) => (typeof r === 'string' ? r : r.query || r.text || r.label)).filter(Boolean);
}

async function googleSuggest(q) {
  const res = await http.get('https://suggestqueries.google.com/complete/search', {
    params: { client: 'firefox', hl: 'en', gl: 'us', q }, headers: { 'User-Agent': UA }, timeout: 10000,
  });
  const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  return Array.isArray(d && d[1]) ? d[1] : [];
}

/** Etsy engellerse: kaydedilmiş tarayıcı oturumunda arama kutusuna yazıp öneri listesini okur. */
async function etsySuggestBrowser(queries, cfg) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return {}; }
  if (!fs.existsSync(PATHS.session) || fs.readdirSync(PATHS.session).length === 0) return {};
  const ctx = await chromium.launchPersistentContext(PATHS.session, {
    headless: true, channel: cfg.browser_channel || undefined, viewport: { width: 1366, height: 900 },
  }).catch(() => chromium.launchPersistentContext(PATHS.session, { headless: true }));
  const out = {};
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.etsy.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    for (const q of queries) {
      checkStop();
      const box = page.locator('input[name="search_query"]').first();
      await box.fill('');
      await box.type(q, { delay: 60 });
      await page.waitForTimeout(1500);
      out[q] = (await page.locator('[role="listbox"] [role="option"], ul#global-enhancements-search-suggestions li')
        .allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    }
  } finally { await ctx.close(); }
  return out;
}

/** İsteğe bağlı: Etsy arama sonuç sayısı (rekabet). Oturum gerekir; config.check_competition=true. */
async function competitionCounts(keywords, cfg) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return {}; }
  const ctx = await chromium.launchPersistentContext(PATHS.session, { headless: true, channel: cfg.browser_channel || undefined })
    .catch(() => chromium.launchPersistentContext(PATHS.session, { headless: true }));
  const out = {};
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    for (const k of keywords) {
      checkStop();
      await page.goto(`https://www.etsy.com/search?q=${encodeURIComponent(k)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1200 + Math.random() * 1500);
      const txt = await page.locator('body').innerText().catch(() => '');
      const m = txt.match(/([\d,.]+)\s+(?:results|sonuç)/i);
      if (m) out[k] = Number(m[1].replace(/[^\d]/g, ''));
    }
  } finally { await ctx.close(); }
  return out;
}

/* ---------- Filtreleme ve puanlama ---------- */
function clean(s) { return String(s).toLowerCase().replace(/[^a-z0-9' &-]/g, ' ').replace(/\s+/g, ' ').trim(); }
function isBlocked(k, cfg) { return cfg.blocked_terms.some((t) => k.includes(t)); }

function score(k, ctx) {
  const words = k.split(' ').length;
  let s = 0;
  s += words >= 3 && words <= 6 ? 3 : words === 7 ? 1 : -3;            // uzun kuyruk tatlı nokta
  if (/\b(png|sublimation|svg|dtf|clipart|design|bundle)\b/.test(k)) s += 2; // dijital alıcı niyeti
  if (/\b(retro|vintage|western|boho|groovy|coquette|funny|minimalist|watercolor|distressed)\b/.test(k)) s += 1.5; // niş stil
  if (AUDIENCE_RE.test(k)) s += 2.5;                                       // hedef kitle = alıcı niyeti yüksek
  if (/\b(shirts?|tee|sweatshirt|sublimation|dtf)\b/.test(k)) s += 1;    // ürün niyeti
  s += Math.max(0, 2 - (ctx.rank || 0) * 0.25);                          // öneri sırası = talep sinyali
  if (ctx.season) s += Math.max(0, 3 - ctx.season.daysUntil / 20);      // yaklaşan sezon önceliği
  if (ctx.sources > 1) s += 1.5;                                          // birden çok kaynakta görüldü
  if (ctx.competition) s += ctx.competition < 5000 ? 3 : ctx.competition < 20000 ? 1.5 : ctx.competition > 100000 ? -2 : 0;
  return Math.round(s * 100) / 100;
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STYLE_HINTS = [
  [/western|cowboy|cowgirl|howdy/, 'retro western, warm desert palette, distressed print texture'],
  [/retro|groovy|70s|wavy/, 'retro 70s groovy typography, warm sunset palette'],
  [/vintage|distressed/, 'vintage distressed screen-print look, muted palette'],
  [/boho|floral|wildflower/, 'boho floral illustration, earthy muted palette'],
  [/coquette|bow/, 'coquette pink bows, soft pastel palette, delicate line art'],
  [/watercolor/, 'soft watercolor illustration, pastel palette'],
  [/funny|sarcastic|humor/, 'bold funny typography with simple illustration, high contrast'],
  [/minimalist|line art/, 'minimalist line art, limited 2-3 color palette'],
  [/kawaii|cute/, 'cute kawaii illustration, bright playful palette'],
];

const AUDIENCE_TEXT = [
  [/\bnicu\b/, 'NICU nurses, nursing teams and their families'],
  [/\bnurses?\b/, 'nurses, nursing students and healthcare teams'],
  [/\bteachers?\b/, 'teachers, school staff, students and parents'],
  [/\bdog (mom|mama|dad)\b|\bdog\b/, 'dog moms, dog dads and pet lovers'],
  [/\bcat (mom|mama|dad)\b|\bcat\b/, 'cat moms, cat dads and pet lovers'],
  [/\b(mama|mom|mommy)\b/, 'moms, new moms and gift buyers for mom'],
  [/\b(grandma|nana|gigi)\b/, 'grandmas and grandkids shopping for a gift'],
  [/\b(dad|daddy)\b/, 'dads and gift buyers for dad'],
  [/\bfamily|matching\b/, 'families who love matching holiday shirts'],
  [/\bkids|toddler\b/, 'kids, toddlers and parents'],
  [/\bfriendsgiving\b/, 'friends hosting Friendsgiving'],
  [/\b(cowgirl|cowboy|howdy|western)\b/, 'country and western style lovers'],
];

function describeNiche(keyword, season, fallbackStyle, evAudience) {
  const hint = STYLE_HINTS.find(([re]) => re.test(keyword));
  const aud = AUDIENCE_TEXT.find(([re]) => re.test(keyword));
  if (aud) evAudience = aud[1];
  const base = keyword.replace(/\b(png|sublimation|svg|dtf|bundle|shirts?|t-?shirts?|tshirts?|tees?|hoodies?|sweatshirts?|jerseys?|designs?|clipart|digital|download|files?|pictures?|images?|photos?|posters?|frames?|wall art|mugs?|tumblers?)\b/g, '').replace(/\s+/g, ' ').trim();
  return {
    keyword,
    niche: base || keyword,
    season: season ? season.name : 'Evergreen',
    event_date: season ? localDate(season.eventDate) : null,
    days_until: season ? season.daysUntil : null,
    audience: evAudience || 'print-on-demand sellers, crafters, Cricut & sublimation hobbyists',
    style: hint ? hint[1] : `${fallbackStyle}, clean vector illustration`,
  };
}

/* ---------- Ana fonksiyon ---------- */
async function findTrend({ dryRun = false, exclude = new Set(), fast = false } = {}) {
  const cfg = loadConfig();
  const used = db.usedKeywords();
  for (const e of exclude) used.add(clean(e));

  // Kullanıcının özel niş kelimesi varsa onunla başla
  const now = new Date();
  const events = upcomingEvents(now, cfg.lookahead_days, cfg.min_lead_days);
  log(`Takvim: önümüzdeki ${cfg.lookahead_days} gün → ${events.map((e) => `${e.name} (${e.daysUntil}g)`).join(', ') || 'sezon yok, evergreen'}`);

  const seedGroups = [];
  if (cfg.custom_niche && cfg.custom_niche.trim()) {
    seedGroups.push({ seeds: cfg.custom_niche.split(',').map((s) => s.trim()).filter(Boolean), audience: null, styles: ['retro', 'vintage', 'minimalist'], season: events[0] || null });
  }
  for (const ev of events) {
    seedGroups.push({ seeds: ev.seeds, audience: ev.audience, styles: ev.styles, season: ev });
    // Hedef kitle × sezon: "teacher christmas", "nurse thanksgiving"…
    const aud = AUDIENCE_SEEDS[ev.name] || AUDIENCE_SEEDS.default;
    const main = ev.seeds[0].replace(/ shirt$/, '');
    const picks = [...aud].sort(() => Math.random() - 0.5).slice(0, 4);
    seedGroups.push({ seeds: picks.map((a) => `${a} ${main}`), audience: ev.audience, styles: ev.styles, season: ev });
  }
  for (const ev of EVERGREEN) seedGroups.push({ ...ev, season: null });

  // Sorgular: tohum + stil + dijital niyet
  const queries = [];
  for (const g of seedGroups) {
    for (const seed of g.seeds) {
      queries.push({ q: `${seed} png`, g });
      queries.push({ q: `${g.styles[Math.floor(Math.random() * g.styles.length)]} ${seed}`, g });
      queries.push({ q: `${seed} sublimation`, g });
    }
  }
  // Kitle sorgularını öne al, sonra karıştırılmış diğerleri
  const queryList = [...queries.filter((x) => AUDIENCE_RE.test(x.q)), ...queries.filter((x) => !AUDIENCE_RE.test(x.q))].slice(0, dryRun ? 12 : 48);

  const candidates = new Map(); // keyword -> {rank, sources:Set, g}
  const add = (k, rank, source, g) => {
    const key = clean(k);
    if (!key || key.length < 8) return;
    const cur = candidates.get(key) || { rank, sources: new Set(), g };
    cur.rank = Math.min(cur.rank, rank);
    cur.sources.add(source);
    candidates.set(key, cur);
  };

  let etsyBlocked = fast || !cfg.trend_sources.includes('etsy');
  const blockedQueries = [];
  for (const { q, g } of queryList) {
    checkStop();
    if (!etsyBlocked) {
      try {
        const s = await etsySuggestHttp(q);
        s.forEach((k, i) => add(k, i, 'etsy', g));
      } catch (e) {
        etsyBlocked = true;
        log(`Etsy öneri uç noktası yanıt vermedi (${describeError(e).slice(0, 80)}). Tarayıcı oturumu / Google ile devam.`, 'warn');
      }
    }
    if (etsyBlocked) blockedQueries.push({ q, g });
    if (cfg.trend_sources.includes('google')) {
      try {
        const s = await googleSuggest(q);
        s.forEach((k, i) => add(k, i, 'google', g));
      } catch (e) { /* tek sorgu hatası önemsiz */ }
    }
  }

  if (!fast && etsyBlocked && cfg.trend_sources.includes('etsy') && !dryRun && blockedQueries.length) {
    try {
      const res = await etsySuggestBrowser(blockedQueries.slice(0, 12).map((x) => x.q), cfg);
      for (const { q, g } of blockedQueries) (res[q] || []).forEach((k, i) => add(k, i, 'etsy-browser', g));
      if (Object.keys(res).length) log(`Etsy tarayıcı oturumundan ${Object.values(res).flat().length} öneri alındı`);
    } catch (e) { logError('Etsy tarayıcı önerileri alınamadı', e); }
  }

  // Ağ tamamen kapalıysa: kendi long-tail üreticimiz (tohum × stil × niyet)
  if (candidates.size === 0) {
    log('Canlı öneri alınamadı; yerleşik long-tail üreticisi kullanılıyor', 'warn');
    for (const g of seedGroups) {
      g.seeds.forEach((seed, si) => g.styles.forEach((st, ti) => MODIFIERS.slice(0, 3).forEach((m, mi) => add(`${st} ${seed} ${m}`, si + ti + mi, 'generator', g))));
    }
  }

  // Dijital niyet eklenmemiş önerilere "png" ekle, filtrele, puanla
  const scored = [];
  for (const [k0, info] of candidates) {
    const k = /\b(png|sublimation|svg|dtf|clipart|bundle)\b/.test(k0) ? k0 : `${k0} png`;
    if (used.has(k) || used.has(k0)) continue;
    if (isBlocked(k, cfg)) continue;
    if (/\b(free|cheap|near me|how to|template|font)\b/.test(k)) continue;
    if (NON_BUYER.test(k)) continue;
    scored.push({ k, info });
  }

  let comp = {};
  if (!fast && cfg.check_competition && !dryRun && scored.length) {
    const top = scored.map((x) => ({ ...x, s: score(x.k, { rank: x.info.rank, sources: x.info.sources.size, season: x.info.g.season }) }))
      .sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.k);
    try { comp = await competitionCounts(top, cfg); } catch (e) { logError('Rekabet ölçümü başarısız', e); }
  }

  const ranked = scored.map(({ k, info }) => ({
    k, info, s: score(k, { rank: info.rank, sources: info.sources.size, season: info.g.season, competition: comp[k] }),
  })).sort((a, b) => b.s - a.s);

  if (!ranked.length) throw Object.assign(new Error('Kullanılmamış uygun anahtar kelime bulunamadı (tüm adaylar daha önce kullanılmış ya da filtrelendi).'), { noRetry: true });

  // En iyi 5 içinden rastgele seç → her çalıştırmada çeşitlilik
  const pick = ranked[Math.floor(Math.random() * Math.min(5, ranked.length))];
  const g = pick.info.g;
  const style = g.styles[Math.floor(Math.random() * g.styles.length)];
  // İlgili aramalar: başka bir hedef kitleye (grandma, kids…) ait olanları alma — başlık/etiket tasarımla uyuşmalı
  const audOf = (k) => new Set((k.match(new RegExp(AUDIENCE_RE.source, 'g')) || []));
  const mine = audOf(pick.k);
  // Başka bir bayram/sezon adı geçen aramalar da alınmaz (ör. christmas ürününe "hanukkah")
  const EV_WORDS = /\b(christmas|xmas|hanukkah|thanksgiving|halloween|easter|valentines?|patricks|fourth|july|new year|nye|mothers|fathers|graduation|summer|fall|autumn|back to school)\b/g;
  const evOf = (k) => new Set(k.match(EV_WORDS) || []);
  const myEv = evOf(pick.k);
  const related = ranked.filter((r) => r.k !== pick.k && [...audOf(r.k)].every((a) => mine.has(a)) && [...evOf(r.k)].every((e) => myEv.has(e)))
    .sort((a, b) => (b.info.g === g) - (a.info.g === g)).slice(0, 15).map((r) => r.k);
  // "christmas…" kelimeleri Black Friday grubundan gelse bile sezon Noel sayılır
  let season = g.season;
  if (season && /^Black Friday/.test(season.name) && /\b(christmas|xmas|santa|holiday)\b/.test(pick.k)) season = events.find((e) => e.name === 'Christmas') || season;
  const result = {
    ...describeNiche(pick.k, season, style, g.audience),
    score: pick.s,
    sources: [...pick.info.sources],
    competition: comp[pick.k] ?? null,
    related_keywords: related,
    picked_at: new Date().toISOString(),
  };
  log(`Trend bulundu: "${result.keyword}" — ${result.season}, skor ${result.score}, kaynak: ${result.sources.join('+')}`, 'success');
  return result;
}

module.exports = { findTrend, upcomingEvents, EVENTS, describeNiche };

if (require.main === module) {
  require('./lib/core').bus.on('log', (e) => console.log(`[${e.level}] ${e.msg}`));
  findTrend({ dryRun: process.argv.includes('--dry-run') }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e.message); process.exit(1); });
}
