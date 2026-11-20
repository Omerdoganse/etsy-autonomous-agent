'use strict';
/**
 * Tasarım talimatları (prompt) — tek kaynak.
 * Hem otomatik üretim (Recraft) hem Gemini talimatları buradan çıkar; böylece kurallar her yerde aynıdır.
 *
 *  - designText(): SEO kelimesinden tasarımda yazacak kısa, temiz metni çıkarır
 *      "minimalist family christmas pajamas png" → "Family Christmas Pajamas"
 *  - pickConcepts(): her ürün için farklı yerleşim + yazı + palet + doku + konu objesi seçer,
 *      son kullanılanları data/variety.json'da tutup tekrar etmez
 *  - geminiPrompts(): Gemini'ye yapıştırılacak kısa, net, maddeli talimatlar
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./core');
// İçerik/strateji verileri (promptlar, temalar, başlıklar) ayrı dosyada: design_presets.local.js varsa o, yoksa örnek dosya kullanılır
const { LAYOUTS, LETTERING, PALETTES, ART_STYLES, OPENERS, TEXTURES, THEMES, DEFAULT_THEME, AUDIENCES, NAMES, RULES, STYLE_NAMES, ILLU_BG, ILLU_STYLES, ILLU_SCENES, ILLU_SUBJECTS, ILLU_TOPICS, ILLU_COLLECTIONS, ILLU_SUBJECT_RE, ILLU_RULES, ILLU_NAMES, SUBJECT_SHORT, SCENE_NOTE, VINTAGE_STYLES, VINTAGE_PACKS, TITLES, DENSE_COMPOSITION, EMBLEM_COMPOSITION, VINTAGE_NAMES, EVERYDAY_STYLES, EVERYDAY_PACKS, EVERYDAY_NAMES } = require('./design_presets');

/* ---------------- Tasarım metni ---------------- */
const STYLE_WORDS = /\b(minimalist|minimal|retro|vintage|boho|groovy|funny|cute|aesthetic|modern|trendy|simple|coquette|kawaii|watercolor|distressed|preppy|y2k|70s|80s|90s|cool|best|new|custom|personalized|matching)\b/gi;
const PRODUCT_WORDS = /\b(png|svg|jpe?g|sublimation|dtf|bundle|designs?|clipart|clip art|digital|download|files?|graphics?|transparent|shirts?|t-?shirts?|tees?|sweatshirts?|hoodies?|sweaters?|jumpers?|outfits?|apparel|cricut|printable|images?|pictures?|ideas?)\b/gi;
const SMALL = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'on', 'with']);

function titleWords(s) {
  return String(s).split(' ').filter(Boolean).map((w, i) => {
    const lw = w.toLowerCase();
    if (i > 0 && SMALL.has(lw)) return lw;
    if (/^(nicu|er|icu|usa|nye)$/i.test(w)) return w.toUpperCase();
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

/** SEO kelimesinden tasarıma yazılacak kısa metin (en fazla 4 kelime). */
function designText(subject) {
  let t = String(subject || '').toLowerCase().replace(/[^a-z0-9' &-]/g, ' ');
  // "family matching" gibi kalıplar anlamlı → "matching" sadece tek başına stil sayılır
  const hadFamilyMatching = /\bmatching\b/.test(t) && /\bfamily\b/.test(t);
  t = t.replace(STYLE_WORDS, ' ').replace(PRODUCT_WORDS, ' ').replace(/\s+/g, ' ').trim();
  let words = t.split(' ').filter((w) => w && !SMALL.has(w) || false);
  if (!words.length) words = String(subject || 'Holiday').split(/\s+/).slice(0, 3);
  // Tekrarlanan kelimeleri at ("friendsgiving thanksgiving" gibi sezon ikilemeleri dahil)
  const seen = new Set();
  words = words.filter((w) => !seen.has(w) && seen.add(w));
  if (words.includes('friendsgiving')) words = words.filter((w) => w !== 'thanksgiving');
  if (words.length > 4) {
    // öncelik: kitle + sezon kelimeleri
    const KEY = /^(nurse|nicu|teacher|teachers|dog|cat|mom|mama|dad|grandma|nana|family|kids|cowgirl|cowboy|howdy|christmas|xmas|thanksgiving|friendsgiving|halloween|easter|valentines?|crew|squad|pajamas|20\d\d)$/;
    const key = words.filter((w) => KEY.test(w));
    words = (key.length >= 2 ? key : words).slice(0, 4);
  }
  if (hadFamilyMatching && !words.includes('matching') && words.length < 4) words.splice(words.indexOf('family') + 1, 0, 'matching');
  if (words.length < 2) {
    // Tek kelime kaldıysa stil kelimesini geri al ("funny turkey" → "Funny Turkey")
    const keep = String(subject || '').toLowerCase().replace(/[^a-z0-9' &-]/g, ' ').replace(PRODUCT_WORDS, ' ').replace(/\b(minimalist|minimal|aesthetic|trendy|best|new|custom|personalized)\b/g, ' ')
      .split(/\s+/).filter((w) => w && !SMALL.has(w));
    const seen2 = new Set();
    const k2 = keep.filter((w) => !seen2.has(w) && seen2.add(w)).filter((w) => !(w === 'thanksgiving' && keep.includes('friendsgiving')));
    if (k2.length >= 2) words = k2.slice(-3);
  }
  return titleWords(words.join(' '));
}

/* ---------------- Havuzlar ---------------- */
// S = konu objeleri ("a stethoscope and a santa hat"), H = sevimli karakter, D = süsleme (sezona uygun)
const FILE = () => path.join(PATHS.data, 'variety.json');
function readRecent() { try { const r = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return { layouts: r.layouts || [], palettes: r.palettes || [], styles: r.styles || [], illu: r.illu || [], illuStyles: r.illuStyles || [], illuTopics: r.illuTopics || [], vintStyles: r.vintStyles || [], vintTopics: r.vintTopics || [], dayStyles: r.dayStyles || [], dayTopics: r.dayTopics || [] }; } catch { return { layouts: [], palettes: [], styles: [], illu: [], illuStyles: [] }; } }
function writeRecent(r) { try { fs.writeFileSync(FILE(), JSON.stringify(r)); } catch {} }
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

function joinObjs(list) {
  const u = [...new Set(list.filter(Boolean))].slice(0, 2);
  return u.length === 2 ? `${u[0]} and ${u[1]}` : u[0] || '';
}

/** n adet farklı konsept: [{ id, text, concept, lettering, palette, texture }] */
function pickConcepts(subject, n = 4, { remember = true } = {}) {
  const s = String(subject || '').toLowerCase();
  const theme = THEMES.find((t) => t.re.test(s)) || DEFAULT_THEME;
  const aud = AUDIENCES.find((a) => a.re.test(s)) || null;
  const T = designText(subject);
  const recent = readRecent();
  const avoidL = new Set(recent.layouts.slice(-12)), avoidP = new Set(recent.palettes.slice(-8));
  const usable = LAYOUTS.filter(([, , o]) => !(o && o.only) || o.only.test(s));
  const layouts = [...shuffle(usable.filter(([id]) => !avoidL.has(id))), ...shuffle(usable.filter(([id]) => avoidL.has(id)))].slice(0, n);
  const pals = [...shuffle(PALETTES.filter((p) => !avoidP.has(p))), ...shuffle(PALETTES.filter((p) => avoidP.has(p)))];
  const avoidS = new Set(recent.styles.slice(-10));
  const styles = [...shuffle(ART_STYLES.filter(([id]) => !avoidS.has(id))), ...shuffle(ART_STYLES.filter(([id]) => avoidS.has(id)))];
  const letters = shuffle(LETTERING), tex = shuffle(TEXTURES), deco = shuffle(theme.deco), heroes = shuffle(theme.heroes);
  const A = shuffle(aud ? aud.objs : []), Th = shuffle(theme.objs);
  // Metin çeşitliliği: ilk iki tasarım ana metin; diğerleri sezon selamı + kitle (ör. "Holly Jolly Nurse")
  const greets = aud ? shuffle(theme.greetA || []).map((g) => g.replace('{A}', aud.label)) : shuffle(theme.greet);
  const texts = [T, T];
  for (const v of greets) {
    if (texts.length >= n) break;
    if (v.split(' ').length <= 5 && !texts.includes(v)) texts.push(v);
  }
  while (texts.length < n) texts.push(T);

  const out = layouts.map(([id, fn, opt], i) => {
    let objs = aud ? [A[i % A.length], Th[i % Th.length]] : [Th[i % Th.length], Th[(i + 1) % Th.length]];
    if (id === 'pie') objs = objs.map((o) => (o && /pie/.test(o) ? 'autumn leaves' : o));
    const S = joinObjs(objs) || `small illustrations that match "${T}"`;
    const H = `${heroes[i % heroes.length]}${aud ? ` ${aud.acc}` : ''}`;
    const D = deco[i % deco.length];
    return {
      id, text: texts[i], concept: fn(T, S, H, D),
      lettering: opt && opt.own ? null : letters[i % letters.length],
      palette: pals[i % pals.length], texture: tex[i % tex.length],
      styleId: styles[i % styles.length][0], style: styles[i % styles.length][1],
    };
  });
  if (remember) writeRecent({ ...recent, layouts: [...recent.layouts, ...out.map((c) => c.id)].slice(-40), palettes: [...recent.palettes, ...out.map((c) => c.palette)].slice(-40), styles: [...recent.styles, ...out.map((c) => c.styleId)].slice(-40) });
  return out;
}

/** Otomatik üretim (Recraft) için tek cümlelik konsept — buildPrompt kalan kuralları ekler. */
function conceptSentence(c) {
  return `a print design in ${c.style}, with the text "${c.text}" in thick bold letters: ${c.concept}${c.lettering ? `, ${c.lettering}` : ''}, ${c.palette} color palette, ${c.texture}`;
}

function geminiPrompts(subject, n = 4) {
  const op = shuffle(OPENERS);
  return pickConcepts(subject, n).map((c, i) => [`${NAMES[c.id] || c.id} · ${STYLE_NAMES[c.styleId] || c.styleId}`, [
    op[i % op.length],
    `Art style (most important): ${c.style}.`,
    `Text (spell exactly, nothing else): "${c.text}"`,
    `Layout: ${c.concept}.`,
    `Colors: ${c.palette}${c.lettering ? `; lettering: ${c.lettering}` : ''}; ${c.texture}.`,
    'This is a completely new design: do not reuse the style, characters, colors or layout of any earlier image in this chat.',
    `Rules: ${RULES.join(' ')}`,
  ].join('\n')]);
}

function subjectMeta(S, sceneId) {
  const m = SUBJECT_SHORT.find(([re]) => re.test(S));
  return m ? { subject: m[1], note: `${m[2]} ${SCENE_NOTE[sceneId] || ''}`.trim() } : null;
}

function illustrationPrompts(subject, n = 4) {
  const s = String(subject || '').toLowerCase();
  const season = /thanksgiving|turkey|fall|autumn/.test(s) ? 'thanksgiving' : /christmas|xmas|winter|holiday|snow|santa/.test(s) ? 'christmas' : 'default';
  const fixed = ILLU_SUBJECT_RE.find(([re]) => re.test(s));
  const pool = shuffle(ILLU_SUBJECTS[season]);
  // Konu belirli bir hayvansa hepsi o hayvan (farklı sahne/tarz); "animals" gibi genelse 4 farklı hayvan
  const coll = Object.entries(ILLU_COLLECTIONS).find(([k]) => s.includes(k));
  const subs = coll ? shuffle(coll[1]).slice(0, n)
    : fixed && !/animals|woodland|friends/.test(s) ? Array(n).fill(fixed[1]) : pool.slice(0, n);
  const recent = readRecent();
  const avoid = new Set((recent.illu || []).slice(-8));
  const avoidSt = new Set((recent.illuStyles || []).slice(-6));
  const scenes = [...shuffle(ILLU_SCENES.filter(([id]) => !avoid.has(id))), ...shuffle(ILLU_SCENES.filter(([id]) => avoid.has(id)))];
  const styles = [...shuffle(ILLU_STYLES.filter(([id]) => !avoidSt.has(id))), ...shuffle(ILLU_STYLES.filter(([id]) => avoidSt.has(id)))];
  const isObject = (S) => /angel|nativity|tree farm|velvet bow|lantern|steam train|teddy|rocking horse|mittens|golden christmas bells|knitted christmas stocking|ice skates|lighthouse|camper|tractor|bicycle|toadstool|cowboy boots|coquette|pink vintage christmas tree|coffee|vintage books|gramophone|champagne|striking midnight|house|village|cabin|truck|cocoa|cookies|ornament|poinsettia|globe|nutcracker|wagon|pie|cider|pumpkins/.test(S) && !/puppy|\bcow\b|\bcat\b|fox|owl|bear cub|polar bear|deer/.test(S);
  const usedSc = [];
  const out = subs.map((S, i) => {
    // atkılı/kulübe sahneleri sadece hayvanlara uygun; bir pakette aynı sahne iki kez gelmesin
    const okScenes = scenes.filter(([id]) => !(isObject(S) && ['scarf', 'cabin'].includes(id)) && !(/champagne|midnight/.test(S) && ['sled', 'gifts'].includes(id)));
    const sc = okScenes.find(([id]) => !usedSc.includes(id)) || okScenes[i % okScenes.length];
    usedSc.push(sc[0]);
    const [sid, fn] = sc; const [tid, st] = styles[i % styles.length];
    return [`${ILLU_NAMES[sid]} · ${ILLU_NAMES[tid]}`, [
      'Create a text-free vintage illustration for a t-shirt print.',
      `Art style (most important): ${st}.`,
      `Scene: ${fn(S)}.`,
      `Background: ${ILLU_BG}.`,
      'This is a completely new image: do not reuse anything from earlier images in this chat.',
      `Rules: ${ILLU_RULES.join(' ')}`,
    ].join('\n'), subjectMeta(S, sid)];
  });
  writeRecent({ ...recent, illu: [...(recent.illu || []), ...usedSc].slice(-30), illuStyles: [...(recent.illuStyles || []), ...styles.slice(0, n).map((x) => x[0])].slice(-30) });
  return out;
}
const topicKey = (t) => t.replace(/vintage|christmas|cozy|snowman christmas/g, '').trim();
function illustrationTopic(exclude = []) {
  const recent = readRecent();
  const last = (recent.illuTopics || []).slice(-12); // son 12 konu tekrar gelmesin (tilki/baykuş üst üste olmasın)
  const ex = new Set([...exclude, ...last]);
  const keys = new Set(last.map(topicKey));
  let left = ILLU_TOPICS.filter((t) => !ex.has(t) && !keys.has(topicKey(t)));
  if (!left.length) left = ILLU_TOPICS.filter((t) => !ex.has(t));
  const t = shuffle(left.length ? left : ILLU_TOPICS)[0];
  writeRecent({ ...readRecent(), illuTopics: [...last, t].slice(-30) });
  return t;
}


/* ---------- Vintage Noel (gerçekçi, ressam işi Noel Baba / ren geyiği — Etsy'de çok satan tarz) ---------- */
// Retro halftone/eskitme efekti (config.retro_effect: false ile kapatılır)
const RETRO = () => { try { return require('./core').loadConfig().retro_effect !== false; } catch { return true; } };
const VINTAGE_TOPICS = Object.keys(VINTAGE_PACKS);

/* ---------- Çok satan kalitesi: yoğun sahne + amblem (kavisli başlık) düzeni ----------
 * Etsy'de çok satan premium tasarımlar: baskı göğsü doldurur, tek figür değil dolu/katmanlı sahne,
 * ya da büyük kavisli başlık + ortada çizim + altta küçük alt yazı (amblem). config.design_premium:false ile kapanır. */
const PREMIUM = () => { try { return require('./core').loadConfig().design_premium !== false; } catch { return true; } };
// Telifsiz, genel geçer kısa başlıklar (marka/film/şarkı adı yok)
function premiumPlan(key, n) {
  const titles = shuffle(TITLES[key] || [['Good Vibes', 'Est. 2024'], ['Stay Wild', 'Since 1990']]);
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? titles[(i / 2) % titles.length] : null));
}
function vintagePrompts(topic, n = 4) {
  const t = String(topic || '').toLowerCase();
  const key = VINTAGE_TOPICS.find((k) => t.includes(k)) || VINTAGE_TOPICS.find((k) => k.split(' ').filter((w) => w !== 'vintage' && w !== 'christmas').some((w) => t.includes(w))) || 'vintage santa claus';
  const subs = shuffle(VINTAGE_PACKS[key]).slice(0, n);
  const recent = readRecent();
  const avoid = new Set((recent.vintStyles || []).slice(-4));
  const styles = [...shuffle(VINTAGE_STYLES.filter(([id]) => !avoid.has(id))), ...shuffle(VINTAGE_STYLES.filter(([id]) => avoid.has(id)))];
  const plan = PREMIUM() ? premiumPlan(key, subs.length) : [];
  const out = subs.map(([short, S], i) => {
    const [sid, st] = styles[i % styles.length];
    const tt = plan[i];
    const comp = !PREMIUM() ? 'Composition: FREE-FORM cut-out design with NO frame, NO arch, NO circle, NO rectangle and NO background panel behind it. Only the main subject plus a few connected scene elements (for example a patch of snowy ground under it and one or two snowy pine trees beside it) forming one organic, irregular silhouette. The space around this silhouette is pure magenta. Crisp clean outer edges with NO white outline, NO sticker border and NO contour line around the silhouette (the artwork itself touches the magenta directly), no glow or purple tint at the edges, no loose floating snowflakes or specks outside the silhouette.'
      : tt ? EMBLEM_COMPOSITION(tt[0], tt[1]) : DENSE_COMPOSITION;
    const rules = ILLU_RULES.filter((r) => !/vignette shape/.test(r) && !(tt && /^NO text/.test(r))).join(' ');
    return [`${short} · ${tt ? `Amblem "${tt[0]}"` : VINTAGE_NAMES[sid]}`, [
      tt ? `Create a vintage Christmas t-shirt design with a title (a best-selling realistic vintage Santa/winter style).` : 'Create a text-free vintage Christmas artwork for a t-shirt print (a best-selling realistic vintage Santa/winter style).',
      `Art style (most important): ${st}.`,
      `Scene: ${S}.`,
      comp,
      `Background: ${ILLU_BG}.`,
      'This is a completely new image: do not reuse anything from earlier images in this chat.',
      `Rules: ${rules}${tt ? ` The only text in the image is "${tt[0]}" and "${tt[1]}"; no signature, no watermark.` : ''}`,
    ].join('\n'), { subject: short, note: (tt ? `"${tt[0]}" emblem with ${S.replace(/^an? /, '')}` : S.replace(/^an? /, '').replace(/^(.)/, (c) => c.toUpperCase())).slice(0, 90), text: tt ? tt[0] : null, effect: RETRO() ? (tt ? 'retro_text' : 'retro') : null }];
  });
  writeRecent({ ...readRecent(), vintStyles: [...(recent.vintStyles || []), ...styles.slice(0, n).map((x) => x[0])].slice(-20) });
  return out;
}

function vintageTopic(exclude = []) {
  const recent = readRecent();
  const last = (recent.vintTopics || []).slice(-3);
  const ex = new Set([...exclude, ...last]);
  const left = VINTAGE_TOPICS.filter((x) => !ex.has(x));
  const t = shuffle(left.length ? left : VINTAGE_TOPICS)[0];
  writeRecent({ ...readRecent(), vintTopics: [...last, t].slice(-10) });
  return t;
}

/* ---------- Günlük / her mevsim (yıl boyu satan, sezon dışı) ---------- */
const EVERYDAY_TOPICS = Object.keys(EVERYDAY_PACKS);
function everydayPrompts(topic, n = 4) {
  const t = String(topic || '').toLowerCase();
  const key = EVERYDAY_TOPICS.find((k) => t.includes(k)) || EVERYDAY_TOPICS.find((k) => k.split(' ').some((w) => w.length > 3 && w !== 'vintage' && t.includes(w))) || EVERYDAY_TOPICS[0];
  const subs = shuffle(EVERYDAY_PACKS[key]).slice(0, n);
  const recent = readRecent();
  const avoid = new Set((recent.dayStyles || []).slice(-4));
  const styles = [...shuffle(EVERYDAY_STYLES.filter(([id]) => !avoid.has(id))), ...shuffle(EVERYDAY_STYLES.filter(([id]) => avoid.has(id)))];
  const isTextPack = subs.some((x) => x[2]);
  const plan = PREMIUM() && !isTextPack ? premiumPlan(key, subs.length) : [];
  const out = subs.map(([short, S, text0], i) => {
    const tt = plan[i];
    const text = text0 || null;
    const [sid, st] = text ? ['retro70', 'cute retro cartoon illustration with bold clean shapes and a warm 70s palette'] : styles[i % styles.length];
    const comp = tt ? EMBLEM_COMPOSITION(tt[0], tt[1]) : PREMIUM() && !text ? DENSE_COMPOSITION
      : 'Composition: FREE-FORM cut-out design with NO frame, NO arch, NO circle, NO rectangle and NO background panel behind it. Only the main subject plus a few connected scene elements (for example a patch of ground, grass, flowers or rocks under it) forming one organic, irregular silhouette. The space around this silhouette is pure magenta. Crisp clean outer edges with NO white outline, NO sticker border and NO contour line around the silhouette (the artwork itself touches the magenta directly), no glow or purple tint at the edges, no loose floating specks outside the silhouette.';
    const anyText = text || (tt && tt[0]);
    return [`${short} · ${tt ? `Amblem "${tt[0]}"` : text ? 'Yazılı' : EVERYDAY_NAMES[sid]}`, [
      text ? `Create a funny everyday t-shirt design with the text "${text}" (spelled exactly like this, in a bold retro rounded font, perfectly legible) together with an illustration. Not holiday themed.`
        : tt ? 'Create an everyday vintage t-shirt design with a title (not holiday themed: no Christmas, no snow decorations, no Santa).'
          : 'Create a text-free artwork for an everyday t-shirt print (not holiday themed: no Christmas, no snow decorations, no Santa).',
      `Art style (most important): ${st}.${tt ? ' Use a harmonious muted vintage palette (for example sage, cream, terracotta, mustard and faded navy).' : ''}`,
      `Scene: ${S}.`,
      comp,
      `Background: ${ILLU_BG}.`,
      'This is a completely new image: do not reuse anything from earlier images in this chat.',
      `Rules: ${ILLU_RULES.filter((r) => !/vignette shape|Rudolph/.test(r) && !(anyText && /^NO text/.test(r))).join(' ')}${text ? ` The only text in the image is "${text}"; no other words, no signature, no watermark.` : tt ? ` The only text in the image is "${tt[0]}" and "${tt[1]}"; no signature, no watermark.` : ''} Original design only: no famous or copyrighted characters, no logos or brand names.`,
    ].join('\n'), { subject: short, note: (text ? `"${text}" with ${S.replace(/^an? /, '')}` : tt ? `"${tt[0]}" emblem with ${S.replace(/^an? /, '')}` : S.replace(/^an? /, '').replace(/^(.)/, (c) => c.toUpperCase())).slice(0, 90), text: text || (tt ? tt[0] : null), effect: RETRO() ? (text || tt ? 'retro_text' : 'retro') : null }];
  });
  writeRecent({ ...readRecent(), dayStyles: [...(recent.dayStyles || []), ...styles.slice(0, n).map((x) => x[0])].slice(-20) });
  return out;
}

function everydayTopic(exclude = []) {
  const recent = readRecent();
  const last = (recent.dayTopics || []).slice(-5);
  const ex = new Set([...exclude, ...last]);
  const left = EVERYDAY_TOPICS.filter((x) => !ex.has(x));
  const t = shuffle(left.length ? left : EVERYDAY_TOPICS)[0];
  writeRecent({ ...readRecent(), dayTopics: [...last, t].slice(-12) });
  return t;
}

module.exports = { everydayPrompts, everydayTopic, EVERYDAY_TOPICS, vintagePrompts, vintageTopic, VINTAGE_TOPICS, pickConcepts, geminiPrompts, designText, conceptSentence, RULES, illustrationPrompts, illustrationTopic };
