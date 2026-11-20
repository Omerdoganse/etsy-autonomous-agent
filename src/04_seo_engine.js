'use strict';
/**
 * MODÜL 4 — Kesin Kurallı Etsy SEO Motoru → seo_metadata.json
 * Başlık ≤140 karakter, ana kelime ilk 40 karakterde, gruplar "," ile, hiçbir kelime 2'den fazla değil.
 * Tam 13 etiket, her biri ≤20 karakter, çok kelimeli, tekrar yok, Etsy karakter kurallarına uygun.
 * Açıklama: ilk 160 karakterde ana kelime, madde işaretli özellikler, BÜYÜK HARF dijital uyarısı, lisans.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, titleCase, log } = require('./lib/core');

const TITLE_MAX = 140, TAG_MAX = 20, TAG_COUNT = 13;
const STOP = new Set(['a', 'an', 'and', 'or', 'the', 'for', 'of', 'in', 'on', 'to', 'with', '&', '-', '|']);
const FILLER = ['png', 'design', 'shirt', 'file', 'digital', 'download', 'the', 'for', 'and', 'with', 'sublimation'];

const words = (s) => s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);

/* ---------------- Başlık ---------------- */
function wordCounts(text) {
  const m = new Map();
  for (const w of words(text)) if (!STOP.has(w)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}
function fitsRepeatRule(current, addition) {
  const c = wordCounts(`${current} ${addition}`);
  for (const v of c.values()) if (v > 2) return false;
  return true;
}

/** SEO ana ifadesi: "family christmas sublimation designs png" → "family christmas png" */
function cleanKeyword(k) {
  return String(k).toLowerCase().replace(/\b(sublimation|bundle|dtf|designs?|clipart|files?|digital|download|svg|shirts?|t-?shirts?|tees?)\b/g, ' ')
    .replace(/\s+/g, ' ').trim() || String(k);
}
/** İlgili arama, ana ifadeye en fazla `max` yeni anlamlı kelime ekliyorsa kabul (tasarımla ilgisiz sözler girmesin) */
const GENERIC_OK = new Set(['png', 'shirt', 'shirts', 'design', 'designs', 'sublimation', 'dtf', 'svg', 'tshirt', 'tee', 'gift', 'gifts', 'matching', 'cute', 'holiday', 'xmas', 'merry']);
const JUNK = /\b(holy|jesus|god|religious|church|disney|grinch|snoopy|nfl|nba|bible|memories|together|quotes?|sayings?|ideas?|pictures?|images?|names?|jokes?|memes?)\b/;
let IP_LIST = null;
function hasIP(phrase) {
  if (!IP_LIST) {
    try { IP_LIST = [...require('./06_quality_check').IP_TERMS, ...((loadConfig().blocked_terms) || [])]; } catch { IP_LIST = []; }
    IP_LIST.push('griswold', 'lampoon', 'elf on the shelf', 'peanuts', 'charlie brown', 'rudolph', 'frosty');
  }
  const p = ` ${String(phrase).toLowerCase()} `;
  return IP_LIST.some((t) => t && p.includes(` ${String(t).toLowerCase()} `));
}
const PAST_YEAR = (t) => (String(t).match(/\b20\d\d\b/g) || []).some((y) => +y < new Date().getFullYear());
function closeEnough(phrase, base, max = 1) {
  if (JUNK.test(phrase) || hasIP(phrase) || PAST_YEAR(phrase)) return false;
  const have = new Set(words(base));
  const fresh = words(phrase).filter((w) => !have.has(w) && !STOP.has(w) && !GENERIC_OK.has(w));
  // Tasarımda olmayan bir hedef kitle (granny, teacher, nurse…) ekleyen ifadeler yanıltıcıdır
  if (fresh.some((w) => /^(granny|grandma|nana|gigi|grandpa|teachers?|nurses?|nicu|mama|mom|moms|mommy|dad|daddy|dog|cat|kids|toddler|baby|boys?|girls?|womens?|mens|cowgirl|cowboy|couples?|wife|husband|sister|brother)$/.test(w))) return false;
  return fresh.length <= max;
}

function primaryPhrase(trend) {
  let p = cleanKeyword(trend.keyword);
  if (!/\bpng\b/.test(p)) p = `${p} png`;
  let t = titleCase(p).replace(/\b(Nicu|Icu|Er|Usa|Nye)\b/g, (m) => m.toUpperCase());
  if (t.length > 40) { // ilk 40 karakter kuralı: güçlü çekirdeği kısalt
    const ws = t.split(' ');
    while (ws.join(' ').length > 40 && ws.length > 2) ws.splice(ws.length - 2, 1);
    t = ws.join(' ');
  }
  return t;
}

const SEASON_ALT = {
  Thanksgiving: 'Fall', Christmas: 'Holiday', Halloween: 'Spooky Season', Hanukkah: 'Holiday', 'Black Friday / Holiday Shopping': 'Holiday Gift',
  "Valentine's Day": 'Valentine', "Mother's Day": 'Mom Gift', "Father's Day": 'Dad Gift', '4th of July': 'Patriotic', 'Back to School': 'Teacher',
  'New Year': 'NYE', Summer: 'Beach', 'Fall / Autumn': 'Autumn', Easter: 'Spring', "St. Patrick's Day": 'Lucky',
};

/** İlgili anahtar kelimelerden başlıkta henüz geçmeyen kelimeleri en çok getiren ifadeyi seçer. */
function freshPhrase(title, related) {
  const have = new Set(words(title));
  let best = null, bestNew = 0;
  for (const r of related || []) {
    const core = r.replace(/\b(png|sublimation|svg|dtf|bundle|shirts?|t-?shirts?|tees?|designs?)\b/g, '').replace(/\s+/g, ' ').trim();
    if (!core || core.split(' ').length < 2) continue;
    if (!closeEnough(core, title, 1)) continue;
    const fresh = words(core).filter((w) => !have.has(w) && !STOP.has(w)).length;
    if (fresh > bestNew) { best = titleCase(core); bestNew = fresh; }
  }
  return best;
}

function buildTitle(trend, n) {
  if (isIllu(trend)) return buildIlluTitle(trend, n);
  const primary = primaryPhrase(trend);
  const alt = SEASON_ALT[trend.season] || '';
  const extra = freshPhrase(primary, trend.related_keywords);
  const groups = [
    n > 1 ? `${n} Sublimation Designs Bundle` : 'Sublimation Design',
    extra ? `${extra} Shirt Design` : null,
    alt ? `${alt} T-Shirt Graphic` : 'T-Shirt Graphic',
    'DTF Transfer PNG',
    'Digital Download 300 DPI',
    'Transparent Clipart',
    'Instant Download',
    'Shirt Design for Cricut',
  ];
  let title = primary;
  for (const g of groups.filter(Boolean)) {
    const candidate = `${title}, ${g}`;
    if (candidate.length > TITLE_MAX) continue;
    if (!fitsRepeatRule(title, g)) continue;
    if (capsCount(candidate) > CAPS_MAX) continue;
    title = candidate;
  }
  return validateTitle(title);
}

// Etsy: başlıkta en fazla 3 tamamı büyük harf kelime (PNG, DTF, DPI, NICU...)
const CAPS_MAX = 3;
function capsCount(t) { return (String(t).match(/\b[A-Z]{2,}\b/g) || []).length; }
function limitCaps(t) {
  let seen = 0;
  // önce PNG/DTF gibi kalıp kısaltmaları korunur; fazlası "Dpi" yerine tamamen atılır ya da Title Case olur
  return t.replace(/\b[A-Z]{2,}\b/g, (m) => (++seen <= CAPS_MAX ? m : m[0] + m.slice(1).toLowerCase()));
}

function validateTitle(title) {
  let t = title.replace(/\s+/g, ' ').replace(/[^\w\s,|&'\-.]/g, '').trim();
  if (capsCount(t) > CAPS_MAX) t = limitCaps(t.replace(/,\s*Digital Download 300 DPI/i, ', Digital Download'));
  while (t.length > TITLE_MAX) t = t.slice(0, t.lastIndexOf(',')).trim();
  const counts = wordCounts(t);
  for (const [w, c] of counts) if (c > 2) throw new Error(`Başlık kuralı ihlali: "${w}" ${c} kez geçiyor`);
  if (t.length > TITLE_MAX) throw new Error('Başlık 140 karakteri aşıyor');
  return t;
}

/* ---------------- Etiketler ---------------- */
function normalizeTag(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9 '\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 20 karakteri aşan etiketi kırpar: önce dolgu kelimeleri atar, sonra kelime sınırından keser. */
function shortenTag(tag) {
  let t = normalizeTag(tag);
  if (t.length <= TAG_MAX) return t;
  let ws = t.split(' ');
  for (const f of FILLER) {
    if (ws.join(' ').length <= TAG_MAX || ws.length <= 2) break;
    const i = ws.indexOf(f);
    if (i >= 0) ws.splice(i, 1);
  }
  t = ws.join(' ');
  while (t.length > TAG_MAX && ws.length > 2) { ws = ws.slice(0, -1); t = ws.join(' '); }
  if (t.length > TAG_MAX) t = t.slice(0, TAG_MAX).replace(/\s+\S*$/, '').trim();
  return t;
}

function validTag(t) {
  return t.length >= 3 && t.length <= TAG_MAX && t.split(' ').length >= 2 && /^[a-z0-9 '\-]+$/.test(t);
}

function buildTags(trend) {
  if (isIllu(trend)) return buildIlluTags(trend);
  return buildTagsGeneric(trend);
}
function buildTagsGeneric(trend) {
  const niche = normalizeTag(trend.niche);
  const nicheWords = niche.split(' ');
  // Kitle kelimesini (nurse, dog mom…) düşüren kısaltmalar yanıltıcı olur → o durumda kısaltma kullanma
  const dropped = nicheWords.slice(0, -2).join(' ');
  const core = /\b(teachers?|nurses?|nicu|mama|mom|dad|grandma|nana|dog|cat|family|kids|cowgirl|cowboy|friendsgiving)\b/.test(dropped) ? niche : nicheWords.slice(-2).join(' ');
  const season = trend.season && trend.season !== 'Evergreen' ? normalizeTag(trend.season.split('/')[0].replace(/'s/i, 's')) : '';
  const styleWord = (trend.style.match(/\b(retro|vintage|western|boho|groovy|coquette|funny|minimalist|watercolor|kawaii|cute)\b/i) || [])[0];
  // Kova kotaları: niş (3) + sezon (2) + stil (1) + ilgili aramalar (4) + dijital alıcı niyeti (kalan)
  const base = (t) => t.replace(/\b(png|shirt|sublimation|design|svg|dtf)\b/g, '').replace(/\s+/g, ' ').trim();
  const buckets = [
    { max: 3, items: [`${niche} png`, niche, `${core} shirt`, `${core} png`, `${core} sublimation`] },
    { max: 2, items: season ? [`${season} png`, `${season} shirt`, `${season} gift`] : [] },
    { max: 1, items: styleWord ? [`${styleWord.toLowerCase()} ${nicheWords[nicheWords.length - 1]}`, `${styleWord.toLowerCase()} shirt png`] : [] },
    { max: 4, items: (trend.related_keywords || []).filter((r) => closeEnough(r, `${trend.niche} ${trend.season || ''}`, 1)), uniqueBase: true },
    { max: 13, items: ['sublimation png', 'tank top png', 'shirt design png', 'png bundle', 'dtf transfer png', 'digital download', 'clipart png', 'transparent png', 'cricut design', 'tshirt design', 'print on demand', 'sublimation design', 'commercial use png'] },
  ];
  const tags = [];
  const seen = new Set();
  const bases = new Set();
  for (const b of buckets) {
    let taken = 0;
    for (const raw of b.items) {
      if (taken >= b.max || tags.length === TAG_COUNT) break;
      const t = shortenTag(raw);
      if (!validTag(t)) continue;
      const key = t.replace(/\s/g, '');
      if (seen.has(key)) continue;
      if (b.uniqueBase && bases.has(base(t))) continue;
      seen.add(key); bases.add(base(t));
      tags.push(t); taken++;
    }
  }
  if (tags.length !== TAG_COUNT) throw new Error(`Etiket üretimi: ${tags.length}/13`);
  for (const t of tags) if (t.length > TAG_MAX) throw new Error(`Etiket 20 karakteri aşıyor: "${t}"`);
  return tags;
}

/* ---------------- Resimli (yazısız) tasarımlar: konu adlarıyla SEO ---------------- */
const isIllu = (trend) => trend && trend.mode === 'illustration' && Array.isArray(trend.subjects) && trend.subjects.length > 0;
const capWord = (w) => w.split(' ').map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(' ');
function illuSeasonWord(trend) { return /thanksgiving|fall|autumn/i.test(trend.season || '') ? 'fall' : /christmas|holiday|winter/i.test(`${trend.season} ${trend.keyword}`) ? 'christmas' : 'vintage'; }
const ANIMAL_RE = /deer|reindeer|fox|owl|bunny|rabbit|bear|cardinal|robin|bird|squirrel|hedgehog|turkey|cow|dog|puppy|dachshund|retriever|corgi|cat|penguin|horse|lamb|sloth|raccoon|mouse|chicken|pig|donkey|moose|otter|frog|dinosaur|unicorn|chickadee|jay|animal/;
const hasAnimals = (trend) => { const sb = trend.subjects || []; return sb.length > 0 && sb.filter((x) => ANIMAL_RE.test(String(x))).length * 2 >= sb.length; };
function buildIlluTitle(trend, n) {
  const primary = primaryPhrase(trend);
  const subj = [...new Set(trend.subjects)].slice(0, 4).map(capWord).join(' ');
  const sw = illuSeasonWord(trend);
  const groups = [
    `${subj} Sublimation`,
    trend.retro_effect ? 'Retro Halftone Design' : null,
    n > 1 ? `${n} Designs Bundle` : null,
    sw === 'vintage' ? (hasAnimals(trend) ? 'Vintage Animal Shirt Design' : 'Vintage Shirt Design') : !hasAnimals(trend) ? (sw === 'fall' ? 'Fall Shirt Design' : 'Vintage Christmas Shirt Design') : sw === 'fall' ? 'Autumn Animal Shirt Design' : 'Winter Animal Shirt Design',
    'DTF Transfer PNG',
    sw === 'christmas' ? 'Xmas Clipart' : 'Clipart',
    'Instant Download',
  ];
  let title = primary;
  for (const g of groups.filter(Boolean)) {
    const c = `${title}, ${g}`;
    if (c.length > TITLE_MAX || !fitsRepeatRule(title, g) || capsCount(c) > CAPS_MAX) continue;
    title = c;
  }
  return validateTitle(title);
}
function buildIlluTags(trend) {
  const sw = illuSeasonWord(trend);
  const niche = normalizeTag(trend.niche);
  const nw = niche.split(' ');
  const subs = [...new Set(trend.subjects)];
  const items = [
    ...subs.map((sub) => { const pre = sw === 'vintage' && /funny/.test(niche) ? 'funny' : sw; return `${pre} ${sub} png`.length <= 20 ? `${pre} ${sub} png` : `${pre} ${sub}`.length <= 20 ? `${pre} ${sub}` : `${sub} png`; }),                  // konu + sezon (en çok aranan)
    ...subs.slice(0, 2).map((sub) => `${sub} png`),            // ilk iki konunun kısa hâli
    ...(trend.retro_effect ? ['halftone png', 'distressed png'] : []),
    `${nw.slice(-2).join(' ')} png`, sw === 'vintage' ? 'vintage shirt png' : `vintage ${sw}`, sw === 'vintage' ? (hasAnimals(trend) ? 'animal lover gift' : 'retro shirt png') : !hasAnimals(trend) ? `retro ${sw} png` : sw === 'fall' ? 'autumn animals png' : 'winter animals png',
    `${sw} png`, `${sw === 'christmas' ? 'xmas' : sw} sublimation`, 'tank top png', hasAnimals(trend) ? 'vintage animal shirt' : sw === 'vintage' ? 'graphic tee png' : `vintage ${sw} shirt`, `${sw} clipart`, 'dtf transfer png',
    ...subs.slice(2).map((sub) => `${sub} png`), nw.slice(-2).join(' '), `vintage ${subs[0]}`, `${sw} shirt png`, ...(sw === 'vintage' ? ['everyday shirt png', 'gift for her'] : ['winter shirt png', 'holiday sublimation']),
    'sublimation png', 'png bundle', 'transparent png',
  ];
  const tags = []; const seen = new Set();
  for (const raw of items) {
    if (tags.length === TAG_COUNT) break;
    const t = shortenTag(raw);
    if (!validTag(t)) continue;
    const key = t.replace(/\s/g, '');
    if (seen.has(key)) continue;
    seen.add(key); tags.push(t);
  }
  if (tags.length !== TAG_COUNT) return buildTagsGeneric(trend);
  return tags;
}

/* ---------------- Açıklama ---------------- */
function buildDescription(trend, { n, cfg, delivery }) {
  const kw = cleanKeyword(trend.keyword).replace(/\bpng\b/i, '').replace(/\s+/g, ' ').trim();
  const fileLine = delivery && delivery.mode === 'cloud'
    ? '• 1 PDF File with your secure download link (ZIP inside)'
    : delivery && delivery.mode === 'split'
      ? `• ${delivery.files.length} ZIP Files (one per design)`
      : '• 1 ZIP File';
  const seasonLabel = trend.season === 'Evergreen' ? '' : /\//.test(trend.season) ? 'holiday' : trend.season;
  const opener = `Bring your ${seasonLabel ? `${seasonLabel} ` : ''}projects to life with this ${kw} PNG ${n > 1 ? `bundle of ${n} designs` : 'design'}, made for sublimation, DTF and t-shirt printing.`;
  const lines = [
    opener,
    '',
    isIllu(trend) ? (illuSeasonWord(trend) === 'vintage' ? 'Illustrations perfect for everyday shirts, tank tops, sweatshirts, mugs, tote bags, stickers and wall art, all year round.' : 'Text-free vintage illustrations: perfect for cozy holiday shirts, tank tops, sweatshirts, mugs, tote bags, cards and ornaments.') : `Perfect for ${trend.audience}. Print it on shirts, tank tops, sweatshirts, mugs, tote bags and more.`,
    '',
    ...(isIllu(trend) && Array.isArray(trend.design_notes) && trend.design_notes.length ? ['★ DESIGNS INCLUDED ★', ...trend.design_notes.slice(0, n).map((d) => `• ${d}`), ''] : []),
    '★ WHAT YOU GET ★',
    fileLine,
    `• ${n} PNG Design${n > 1 ? 's' : ''}`,
    `• ${cfg.dpi} DPI High Resolution`,
    `• ${cfg.output_width}x${cfg.output_height} px`,
    '• Transparent Background PNG',
    '',
    '⚠ THIS IS A DIGITAL DOWNLOAD. NO PHYSICAL PRODUCT WILL BE SHIPPED. ⚠',
    'YOUR FILES ARE AVAILABLE INSTANTLY AFTER PURCHASE IN YOUR ETSY ACCOUNT (PURCHASES AND REVIEWS).',
    'Mockups are for display purposes only — no shirt, mug or frame is included.',
    '',
    '★ HOW TO DOWNLOAD ★',
    '1. Complete your purchase.',
    '2. Go to You → Purchases and reviews.',
    '3. Click "Download files" and unzip on a computer.',
    '',
    '★ TERMS OF USE ★',
    '✔ Personal use: unlimited.',
    '✔ Small business commercial use: print on physical products (shirts, mugs, totes, DTF/sublimation transfers, print on demand) — up to 500 physical items per design.',
    '✘ You may NOT resell, share or redistribute the digital files in any digital form.',
    '',
    'Colors may vary slightly depending on your screen, printer and material.',
    'Due to the digital nature of this item, returns and refunds are not accepted — but please message us if anything is wrong, we are happy to help!',
  ];
  if (cfg.ai_disclosure) lines.push('', 'Designed by our shop with the help of AI image tools and finished by hand (cleanup, transparency, print preparation).');
  const description = lines.join('\n');
  if (!description.slice(0, 160).toLowerCase().includes(kw.toLowerCase().split(' ')[0])) throw new Error('Ana anahtar kelime ilk 160 karakterde değil');
  return description;
}

/* ---------------- Ana fonksiyon ---------------- */
/* ---------------- Son denetim: Etsy'ye gidecek yazılar ---------------- */
const STYLE_OK = new Set(['halftone', 'retro', 'vintage', 'boho', 'groovy', 'funny', 'cute', 'minimalist', 'western', 'coquette', 'watercolor', 'classic', 'modern', 'kawaii', 'distressed']);
const TEMPLATE_WORDS = new Set(['sublimation', 'designs', 'design', 'bundle', 'graphic', 't', 'shirt', 'shirts', 'tshirt', 'dtf', 'transfer', 'png', 'digital', 'download', '300', 'dpi',
  'transparent', 'clipart', 'instant', 'cricut', 'print', 'demand', 'commercial', 'use', 'file', 'files', 'svg', 'holiday', 'gift', 'fall', 'spooky', 'season', 'spring', 'valentine',
  'patriotic', 'teacher', 'beach', 'tank', 'top', 'tops', 'autumn', 'lucky', 'nye', 'mom', 'dad', 'tee', 'single', 'png', '1', '2', '3', '4', '5']);
const root = (w) => w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1');

/** Etsy'ye gidecek başlık/etiket/açıklamada sorun listesi (boşsa temiz). */
function validateSeo(meta, trend) {
  const problems = [];
  const allowed = new Set([...words(`${trend.niche} ${trend.keyword} ${trend.season || ''} ${isIllu(trend) ? `${trend.subjects.join(' ')} winter autumn animal animals christmas xmas vintage woodland everyday lover her retro` : ''}`).map(root), ...[...STYLE_OK].map(root), ...[...TEMPLATE_WORDS].map(root), ...[...GENERIC_OK].map(root), ...[...STOP]]);
  const all = `${meta.title} ${meta.tags.join(' ')}`;
  // 1) telif / marka / anlamsız kelime
  if (hasIP(all) || hasIP(meta.description)) problems.push('marka/telifli isim');
  const junk = all.toLowerCase().match(JUNK);
  if (junk) problems.push(`uygunsuz kelime: ${junk[0]}`);
  // 2) başlıkta aynı kökten kelime 2'den fazla (shirt/shirts dahil) ve art arda tekrar ("Shirts Shirt")
  const cnt = new Map();
  for (const w of words(meta.title)) if (!STOP.has(w)) cnt.set(root(w), (cnt.get(root(w)) || 0) + 1);
  for (const [w, c] of cnt) if (c > 2 && !['png', 'design', 'shirt'].includes(w)) problems.push(`başlıkta "${w}" ${c} kez`);
  const tw = words(meta.title);
  for (let i = 1; i < tw.length; i++) if (root(tw[i]) === root(tw[i - 1])) problems.push(`başlıkta art arda tekrar: "${tw[i - 1]} ${tw[i]}"`);
  // 3) tasarımla ilgisiz kelime (konu, sezon, stil ve kalıp kelimeleri dışında)
  const stray = [...new Set(words(all).filter((w) => !allowed.has(root(w)) && !allowed.has(w) && !/^\d+$/.test(w)))];
  if (stray.length) problems.push(`konu dışı kelime: ${stray.slice(0, 4).join(', ')}`);
  // 4) biçim kuralları
  if (meta.title.length > TITLE_MAX) problems.push('başlık 140 karakteri aşıyor');
  if (capsCount(meta.title) > CAPS_MAX) problems.push(`başlıkta ${capsCount(meta.title)} büyük harf kelime (Etsy en fazla 3)`);
  if (meta.tags.length !== TAG_COUNT) problems.push(`etiket sayısı ${meta.tags.length}`);
  if (meta.tags.some((t) => t.length > TAG_MAX)) problems.push('20 karakteri aşan etiket');
  if (new Set(meta.tags).size !== meta.tags.length) problems.push('tekrarlanan etiket');
  return problems;
}

function generateSeo(trend, { dir, n = 4, delivery } = {}) {
  const cfg = loadConfig();
  let title = buildTitle(trend, n);
  let tags = buildTags(trend);
  let description = buildDescription(trend, { n, cfg, delivery });
  // Otomatik düzeltme: sorun varsa Google önerilerini kullanmadan, yalnızca güvenli kalıplarla yeniden yaz
  let problems = validateSeo({ title, tags, description }, trend);
  if (problems.length) {
    log(`SEO otomatik düzeltildi (${problems.join('; ')})`, 'warn');
    const safe = { ...trend, related_keywords: [] };
    title = buildTitle(safe, n); tags = buildTags(safe); description = buildDescription(safe, { n, cfg, delivery });
    problems = validateSeo({ title, tags, description }, trend);
  }
  const meta = {
    title,
    tags,
    description,
    price: Number(cfg.price),
    currency: cfg.currency,
    quantity: Number(cfg.quantity),
    who_made: 'i_did',
    is_supply: false,
    when_made: '2020_2026',
    type: 'download',
    materials: ['digital file', 'png'],
    primary_keyword: trend.keyword,
    validation: {
      title_length: title.length,
      title_first_40: title.slice(0, 40),
      tag_count: tags.length,
      tag_lengths: tags.map((t) => t.length),
      all_tags_le_20: tags.every((t) => t.length <= TAG_MAX),
      description_first_160: description.slice(0, 160),
      problems,
    },
  };
  if (dir) fs.writeFileSync(path.join(dir, 'seo_metadata.json'), JSON.stringify(meta, null, 2));
  if (problems.length) log(`SEO'da hâlâ sorun var: ${problems.join('; ')} — ürün incelemeye alınacak`, 'warn');
  else log(`SEO hazır: "${title.slice(0, 60)}…" (${title.length} kr, 13 etiket ✓, denetim temiz)`, 'success');
  return meta;
}

module.exports = { capsCount, validateSeo, generateSeo, buildTitle, buildTags, buildDescription, shortenTag, validateTitle };
