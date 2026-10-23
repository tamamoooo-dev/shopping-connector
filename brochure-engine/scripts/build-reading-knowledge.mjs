// Reading knowledge from historical brochure readings (2026-10-23).
//
// The archive holds tens of thousands of saved Vision readings: an English
// name, an Arabic name and a typed brand per product. Where the dictionary
// understands the English name, the Arabic reading can be checked word by word,
// and what went wrong in it is learned once, with its support:
//
//   term_corrections  an observed Arabic word that is a misreading of the
//                     dictionary word the English names (شافوره -> شابورة,
//                     supported by "rusk")
//   brand_variants    misread Arabic spellings of a known brand (ناديك -> نادك)
//   term_candidates   Arabic words that travel with English words the
//                     dictionary does not know yet (review only)
//   brand_proposals   an Arabic spelling for a brand that has none (review only)
//
// Saved-image replays (the Panda test set) are never learned from, so a replay
// of them remains a held-out measurement.
//
// Usage:
//   node scripts/build-reading-knowledge.mjs <product-knowledge.sqlite> <out-dir> [--compile]
// --compile also writes src/knowledge/readingVariants.js (the runtime subset).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '../src/matching.js';
import { dictionaryProductTitle } from '../src/lexicon/productTitle.js';
import { SHOPPING_CATEGORIES, SHOPPING_DESCRIPTORS, SHOPPING_PACKAGE_TYPES } from '../src/lexicon/shopping.js';
import { TITLE_TERMS, TITLE_DETAILS, TITLE_VARIANTS } from '../src/lexicon/productTitleDictionary.js';
import { ARCHIVE_PRODUCT_TYPES } from '../src/knowledge/archiveProductTypes.js';
import { BRAND_BY_ID, BRAND_LEXICON } from '../src/lexicon/brands.js';

const [archive, outDir, ...flags] = process.argv.slice(2);
if (!archive || !outDir) {
  console.error('usage: node scripts/build-reading-knowledge.mjs <product-knowledge.sqlite> <out-dir> [--compile]');
  process.exit(2);
}
const compile = flags.includes('--compile');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- text --------------------------------------------------------------------
const fold = s => normalizeText(s);
const ARABIC = /\p{Script=Arabic}/u;
const words = s => fold(s).split(' ').filter(Boolean);
const bare = w => w.replace(/^(وال|بال|فال|لل|ال)/u, '');
const UNITS = new Set(['كجم', 'كغ', 'كيلو', 'كيلوجرام', 'جم', 'جرام', 'غرام', 'غ', 'جr', 'مل', 'ملي', 'لتر', 'ل', 'لترات', 'حبه', 'حبات',
  'قطعه', 'قطع', 'عبوه', 'عبوات', 'علبه', 'علب', 'كيس', 'اكياس', 'رول', 'لفه', 'لفات', 'سم', 'متر', 'مم', 'وات', 'x', 'في', 'من', 'مع',
  'او', 'و', 'على', 'الى', 'بدون', 'عرض', 'حجم', 'وزن', 'صافي', 'الوزن', 'الحجم', 'جديد', 'مجانا', 'مجاني', 'فقط', 'ريال']);
const isNumberish = w => /\d/u.test(w);

// Every Arabic word the dictionaries already use is a real word, never a
// misreading — even where it sits one letter away from another entry.
const VOCAB = new Set([
  ...SHOPPING_CATEGORIES, ...SHOPPING_DESCRIPTORS, ...SHOPPING_PACKAGE_TYPES, ...ARCHIVE_PRODUCT_TYPES,
].flatMap(e => words(e.ar || '')).concat(
  [...TITLE_TERMS, ...TITLE_DETAILS, ...TITLE_VARIANTS.flatMap(g => [...g.terms, ...g.heads.map(h => [h, h])])].flatMap(([, ar]) => words(ar)),
).flatMap(w => [w, bare(w)]));
const BRAND_WORDS = new Set(BRAND_LEXICON.flatMap(b => b.aliases.filter(a => ARABIC.test(a))).flatMap(a => words(a)).flatMap(w => [w, bare(w)]));

// Letters that differ only by their dots are the commonest misreading; they
// cost half a substitution.
const DOT_FAMILIES = ['بتثني', 'جحخ', 'دذ', 'رز', 'سش', 'صض', 'طظ', 'عغ', 'فق'];
const family = new Map(DOT_FAMILIES.flatMap((f, i) => [...f].map(ch => [ch, i])));
function readingDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return Infinity;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const x = a[i - 1], y = b[j - 1];
      const sub = x === y ? 0 : family.has(x) && family.get(x) === family.get(y) ? 0.5 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    prev = cur;
  }
  return prev[n];
}
const allowed = (len) => len <= 3 ? 0.5 : len <= 5 ? 1 : 1.5;
// The same word in another form (gender, plural, adjective, a clitic) is a
// variant, not a misreading: مبشورة/مبشور, برتقالي/برتقال, وزعتر/زعتر.
const stem = w => w.replace(/(?:ات|يه|ه|ي|ا)$/u, '');
const sameWord = (o, c) => stem(o) === stem(c) || o === stem(c) || stem(o) === c || /^[وبل]/u.test(o) && o.slice(1) === c;
// Real words that sit one letter from a dictionary word. منوع is how shoppers
// write "assorted"; البطاطا is sweet potato; the rest are names and nouns.
const NOT_MISREADINGS = new Set(['منوع', 'محمد', 'شباب', 'بطاطا', 'ميلا', 'مصحف', 'نعمه', 'حجاج']);

// --- Latin -> Arabic consonant skeleton (brand proposals) ---------------------
const AR_CLASS = new Map(Object.entries({ ب: 'B', ت: 'T', ط: 'T', ث: 'S', ج: 'J', ح: 'H', ه: 'H', خ: 'K', د: 'D', ذ: 'D', ض: 'D',
  ر: 'R', ز: 'Z', س: 'S', ص: 'S', ش: 'S', ظ: 'Z', غ: 'G', ق: 'K', ك: 'K', ف: 'F', ل: 'L', م: 'M', ن: 'N', ڤ: 'F', پ: 'B', گ: 'G' }));
const arSkeleton = s => [...fold(s).replace(/\s+/gu, '')].map(ch => AR_CLASS.get(ch) || '').join('').replace(/(.)\1+/gu, '$1');
function latinSkeleton(s) {
  const t = String(s).toLowerCase().replace(/[^a-z]/gu, '')
    .replace(/ph/gu, 'f').replace(/sh|ch/gu, 's').replace(/th/gu, 't').replace(/kh/gu, 'k').replace(/gh/gu, 'g').replace(/ck|q/gu, 'k')
    .replace(/c(?=[eiy])/gu, 's').replace(/c/gu, 'k').replace(/x/gu, 'ks');
  const map = { b: 'B', p: 'B', t: 'T', d: 'D', j: 'J', g: 'G', k: 'K', s: 'S', z: 'Z', h: 'H', l: 'L', m: 'M', n: 'N', r: 'R', f: 'F', v: 'F' };
  return [...t].map(ch => map[ch] || '').join('').replace(/(.)\1+/gu, '$1');
}
// G and J and K and Z/S are written interchangeably for Latin brands.
const loose = s => s.replace(/[GJ]/gu, 'K').replace(/Z/gu, 'S');
function skeletonSimilarity(latin, arabic) {
  const a = loose(latinSkeleton(latin)), b = loose(arSkeleton(arabic));
  if (!a || !b) return 0;
  return 1 - readingDistance(a, b) / Math.max(a.length, b.length);
}

// --- read the archive ---------------------------------------------------------
const db = new DatabaseSync(archive, { readOnly: true });
const rows = db.prepare(`SELECT o.id, o.name_en, o.name_ar, o.brand_observed, o.store, o.source_kind, c.department
  FROM observations o JOIN products p ON p.id = o.product_id LEFT JOIN classifications c ON c.id = p.aisle
  WHERE o.name_en IS NOT NULL AND o.name_ar IS NOT NULL AND o.source_kind <> 'saved_image_replay'`).all();
const GROCERY = new Set(['fresh', 'dairy-eggs', 'beverages', 'pantry', 'snacks-sweets', 'bakery', 'frozen']);

const termPairs = new Map();      // observed|canonical -> {count, display, english: Map}
const tokenSeen = new Map();      // folded token -> occurrences anywhere
const brandForms = new Map();     // brandId|form -> {count, exact}
const brandSeen = new Map();      // brandId -> observations
const unresolved = new Map();     // folded en -> {en, n, windows: Map}
const cooc = new Map(), englishCount = new Map(), arabicCount = new Map();
let understood = 0, fallback = 0;

for (const row of rows) {
  const title = dictionaryProductTitle({ nameEn: row.name_en, nameAr: row.name_ar, brand: row.brand_observed });
  // Folded words for matching, each with the spelling the reading printed
  // (hamza and ة kept) for anything shown to a reviewer.
  const printed = String(row.name_ar).split(/\s+/u).flatMap(token => {
    const parts = words(token).filter(w => ARABIC.test(w));
    return parts.length === 1 ? [[parts[0], token.replace(/[^\p{L}]|ـ/gu, '')]] : parts.map(p => [p, p]);
  });
  const raw = printed.map(([w]) => w), shown = printed.map(([, s]) => s);
  for (const w of new Set(raw.map(bare))) tokenSeen.set(w, (tokenSeen.get(w) || 0) + 1);
  const english = new Set(words(row.name_en).filter(w => /^[a-z][a-z'&-]+$/u.test(w) && w.length > 2));

  // Brands this reading names, with every Arabic spelling already known for them.
  const brandAr = new Set();
  for (const b of title.brands || []) {
    const known = new Set([b.ar, ...(BRAND_BY_ID.get(b.id)?.aliases || [])].filter(a => a && ARABIC.test(a)).map(a => fold(a).replace(/\s+/gu, '')));
    for (const w of known) for (const part of words(w)) brandAr.add(part);
    if (b.id && known.size) {
      brandSeen.set(b.id, (brandSeen.get(b.id) || 0) + 1);
      const seen = new Set();
      for (let i = 0; i < raw.length; i++) for (let width = 1; width <= 3 && i + width <= raw.length; width++) {
        const form = raw.slice(i, i + width).join('');
        const formBare = bare(form);
        if (seen.has(formBare) || VOCAB.has(formBare) || formBare.length < 3) continue;
        if (raw.slice(i, i + width).some(w => UNITS.has(w) || isNumberish(w))) continue;
        let best = Infinity;
        for (const k of known) best = Math.min(best, readingDistance(formBare, bare(k)));
        if (best > allowed(formBare.length) || (width > 1 && best > 0 && raw.slice(i, i + width).some(w => VOCAB.has(bare(w))))) continue;
        seen.add(formBare);
        raw.slice(i, i + width).forEach(w => brandAr.add(bare(w)));
        const key = `${b.id}|${formBare}`;
        const entry = brandForms.get(key) || { brand: b.id, en: b.en, ar: b.ar, form: formBare, display: shown.slice(i, i + width).join(' '), count: 0, exact: best === 0 };
        entry.count++;
        brandForms.set(key, entry);
      }
    } else if (!b.ar && b.en) {
      const k = fold(b.en);
      const entry = unresolved.get(k) || { en: b.en, n: 0, grocery: 0, windows: new Map() };
      entry.n++;
      if (GROCERY.has(row.department)) entry.grocery++;
      const titleWords = new Set(words(title.name || '').map(bare));
      const free = raw.map((w, i) => [bare(w), shown[i]]).filter(([w]) => w.length > 1 && !VOCAB.has(w) && !UNITS.has(w) && !isNumberish(w) && !titleWords.has(w));
      const windows = new Map();
      for (let i = 0; i < free.length; i++) for (let width = 1; width <= 2 && i + width <= free.length; width++) {
        const part = free.slice(i, i + width);
        windows.set(part.map(([w]) => w).join(' '), part.map(([, s]) => s).join(' '));
      }
      for (const [w, display] of windows) {
        const seen = entry.windows.get(w) || { n: 0, shown: new Map() };
        seen.n++;
        seen.shown.set(display, (seen.shown.get(display) || 0) + 1);
        entry.windows.set(w, seen);
      }
      unresolved.set(k, entry);
    }
  }

  if (title.source === 'dictionary') {
    understood++;
    const canonical = [...new Set(words(title.name).filter(w => ARABIC.test(w)))];
    const canonicalSet = new Set(canonical.flatMap(w => [w, bare(w)]));
    for (const token of raw) {
      const t = bare(token);
      if (t.length < 3 || canonicalSet.has(t) || VOCAB.has(t) || BRAND_WORDS.has(t) || brandAr.has(t) || UNITS.has(t) || isNumberish(t)) continue;
      let best = null;
      for (const c of canonical) {
        const cb = bare(c);
        if (cb.length < 3) continue;
        const d = readingDistance(t, cb);
        if (d > 0 && d <= allowed(Math.min(t.length, cb.length)) && (!best || d < best.d)) best = { c, cb, d };
      }
      if (!best) continue;
      // Spelling the same word with or without a long vowel is a variant, not
      // a misreading, unless a dotted letter also changed.
      const key = `${t}|${best.cb}`;
      const display = words(title.name).includes(best.c) ? title.name.split(/\s+/u).find(w => bare(fold(w)) === best.cb) || best.c : best.c;
      const entry = termPairs.get(key) || { observed: t, observedDisplay: token, canonical: best.cb, canonicalDisplay: display, distance: best.d, count: 0, english: new Map(), examples: [] };
      entry.count++;
      for (const e of english) entry.english.set(e, (entry.english.get(e) || 0) + 1);
      if (entry.examples.length < 3) entry.examples.push({ en: row.name_en, ar: row.name_ar, title: title.name });
      termPairs.set(key, entry);
    }
  } else fallback++;

  // English words the dictionary left unexplained, against the Arabic words
  // the reading has left over.
  const unknownEnglish = new Set((title.unknown || []).flatMap(u => words(u)).filter(w => /^[a-z]{3,}$/u.test(w)));
  if (unknownEnglish.size) {
    const titleWords = new Set(words(title.name || '').map(bare));
    const leftover = new Set(raw.map(bare).filter(w => w.length > 1 && !UNITS.has(w) && !isNumberish(w) && !brandAr.has(w) && !BRAND_WORDS.has(w)
      && !(title.source === 'dictionary' && titleWords.has(w))));
    for (const e of unknownEnglish) {
      englishCount.set(e, (englishCount.get(e) || 0) + 1);
      for (const a of leftover) {
        const key = `${e}|${a}`;
        cooc.set(key, (cooc.get(key) || 0) + 1);
      }
    }
    for (const a of leftover) arabicCount.set(a, (arabicCount.get(a) || 0) + 1);
  }
}

// --- judge ---------------------------------------------------------------------
// A correction is usable at runtime when the misreading is consistent (most
// of the times the observed word appears, the English names the canonical
// word) and the English evidence for it is consistent too.
// At runtime every `required` English word must be in the offer's name.
const corrections = [...termPairs.values()].map(p => {
  const seen = tokenSeen.get(p.observed) || p.count;
  const ranked = [...p.english].filter(([, n]) => n / p.count >= 0.6 && n >= 2).sort((a, b) => b[1] - a[1]);
  const support = ranked.map(([e]) => e).slice(0, 4);
  const required = ranked.filter(([, n]) => n / p.count >= 0.9).map(([e]) => e).slice(0, 3);
  const variant = sameWord(p.observed, p.canonical);
  return { ...p, seen, share: p.count / seen, support, required: required.length ? required : support.slice(0, 1), variant,
    realWord: NOT_MISREADINGS.has(p.observed), english: undefined };
}).sort((a, b) => b.count - a.count);
const runtimeCorrections = corrections.filter(c => c.count >= 2 && c.share >= 0.6 && c.support.length && !c.variant && !c.realWord);

const brandVariants = [...brandForms.values()].filter(f => !f.exact).map(f => ({ ...f, share: f.count / (brandSeen.get(f.brand) || f.count) }))
  .sort((a, b) => b.count - a.count);
const runtimeBrandVariants = brandVariants.filter(v => v.count >= 2 && v.form.length >= 3);

const N = [...arabicCount.values()].reduce((a, b) => a + b, 0) || 1;
const candidates = [];
for (const [e, ne] of englishCount) {
  if (ne < 3) continue;
  const best = [...cooc].filter(([k]) => k.startsWith(`${e}|`)).map(([k, n]) => {
    const a = k.slice(e.length + 1), na = arabicCount.get(a) || n;
    return { english: e, arabic: a, together: n, english_seen: ne, arabic_seen: na, share: n / ne, lift: (n * N) / (ne * na) };
  }).filter(c => c.together >= 2 && c.share >= 0.3).sort((a, b) => b.together * Math.log(1 + b.lift) - a.together * Math.log(1 + a.lift)).slice(0, 3);
  candidates.push(...best);
}
candidates.sort((a, b) => b.english_seen - a.english_seen || b.together - a.together);

const proposals = [...unresolved.values()].filter(u => u.n >= 1).map(u => {
  const ranked = [...u.windows].map(([ar, { n, shown }]) => ({ ar: [...shown].sort((a, b) => b[1] - a[1])[0][0], n, similarity: skeletonSimilarity(u.en, ar) }))
    .filter(c => c.similarity >= 0.5).sort((a, b) => b.n * b.similarity - a.n * a.similarity);
  const top = ranked[0];
  const grocery = u.grocery / u.n >= 0.5;
  return top ? { en: u.en, observations: u.n, grocery, arabic: top.ar, support: top.n, share: top.n / u.n, similarity: Number(top.similarity.toFixed(2)) }
    : { en: u.en, observations: u.n, grocery, arabic: null, support: 0, share: 0, similarity: 0 };
}).sort((a, b) => b.observations - a.observations);

// --- write ---------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const dbPath = path.join(outDir, 'reading-knowledge.sqlite');
fs.rmSync(dbPath, { force: true });
const out = new DatabaseSync(dbPath);
out.exec(`
  CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE term_corrections(observed TEXT, observed_display TEXT, canonical TEXT, canonical_display TEXT, distance REAL,
    count INTEGER, seen INTEGER, share REAL, english_support TEXT, english_required TEXT, word_variant INTEGER, real_word INTEGER,
    runtime INTEGER, examples TEXT, PRIMARY KEY(observed, canonical));
  CREATE TABLE brand_variants(brand_id TEXT, brand_en TEXT, brand_ar TEXT, observed TEXT, observed_display TEXT, count INTEGER,
    share REAL, runtime INTEGER, PRIMARY KEY(brand_id, observed));
  CREATE TABLE term_candidates(english TEXT, arabic TEXT, together INTEGER, english_seen INTEGER, arabic_seen INTEGER, share REAL, lift REAL);
  CREATE TABLE brand_proposals(brand_en TEXT PRIMARY KEY, observations INTEGER, grocery INTEGER, arabic TEXT, support INTEGER, share REAL, similarity REAL);
`);
const summary = { builtAt: new Date().toISOString(), archive: path.basename(archive), learnedFrom: rows.length, heldOut: 'saved_image_replay',
  understood, fallback, termCorrections: corrections.length, runtimeCorrections: runtimeCorrections.length,
  brandVariants: brandVariants.length, runtimeBrandVariants: runtimeBrandVariants.length, termCandidates: candidates.length,
  brandProposals: proposals.length, brandProposalsWithArabic: proposals.filter(p => p.arabic).length };
out.prepare('INSERT INTO metadata VALUES (?, ?)').run('summary', JSON.stringify(summary));
const runtimeKeys = new Set(runtimeCorrections.map(c => `${c.observed}|${c.canonical}`));
const insertTerm = out.prepare('INSERT INTO term_corrections VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for (const c of corrections) insertTerm.run(c.observed, c.observedDisplay, c.canonical, c.canonicalDisplay, c.distance, c.count, c.seen,
  c.share, c.support.join(' '), c.required.join(' '), c.variant ? 1 : 0, c.realWord ? 1 : 0,
  runtimeKeys.has(`${c.observed}|${c.canonical}`) ? 1 : 0, JSON.stringify(c.examples));
const runtimeVariantKeys = new Set(runtimeBrandVariants.map(v => `${v.brand}|${v.form}`));
const insertBrand = out.prepare('INSERT INTO brand_variants VALUES (?,?,?,?,?,?,?,?)');
for (const v of brandVariants) insertBrand.run(v.brand, v.en, v.ar, v.form, v.display, v.count, v.share, runtimeVariantKeys.has(`${v.brand}|${v.form}`) ? 1 : 0);
const insertCandidate = out.prepare('INSERT INTO term_candidates VALUES (?,?,?,?,?,?,?)');
for (const c of candidates) insertCandidate.run(c.english, c.arabic, c.together, c.english_seen, c.arabic_seen, c.share, c.lift);
const insertProposal = out.prepare('INSERT OR IGNORE INTO brand_proposals VALUES (?,?,?,?,?,?,?)');
for (const p of proposals) insertProposal.run(p.en, p.observations, p.grocery ? 1 : 0, p.arabic, p.support, p.share, p.similarity);
out.close();

const csv = (file, header, list) => fs.writeFileSync(path.join(outDir, file), '﻿' + [header.join(','),
  ...list.map(r => header.map(h => `"${String(r[h] ?? '').replace(/"/gu, '""')}"`).join(','))].join('\n'));
csv('term-corrections.csv', ['observedDisplay', 'canonicalDisplay', 'count', 'seen', 'share', 'support', 'required', 'distance', 'runtime'],
  corrections.map(c => ({ ...c, support: c.support.join(' '), required: c.required.join(' '), runtime: runtimeKeys.has(`${c.observed}|${c.canonical}`) ? 'yes' : '' })));
csv('brand-variants.csv', ['en', 'ar', 'display', 'count', 'share'], brandVariants);
csv('term-candidates.csv', ['english', 'arabic', 'together', 'english_seen', 'arabic_seen', 'share', 'lift'], candidates);
csv('brand-proposals.csv', ['en', 'observations', 'grocery', 'arabic', 'support', 'share', 'similarity'], proposals);
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

if (compile) {
  const terms = runtimeCorrections.map(c => [c.observed, c.canonicalDisplay, c.required]).sort((a, b) => a[0].localeCompare(b[0]));
  const variants = {};
  for (const v of runtimeBrandVariants) (variants[v.brand] ||= []).push(v.form);
  const sorted = Object.fromEntries(Object.entries(variants).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.sort()]));
  fs.writeFileSync(path.join(root, 'src/knowledge/readingVariants.js'), `// GENERATED by scripts/build-reading-knowledge.mjs from ${path.basename(archive)}
// (${rows.length} historical readings; saved-image replays held out). Do not edit by hand.
//
// READING_TERM_CORRECTIONS: [observed (folded), dictionary word, English words that must be in the name]
// READING_BRAND_VARIANTS:   brand id -> misread Arabic spellings (folded, no spaces)
export const READING_TERM_CORRECTIONS = ${JSON.stringify(terms)};
export const READING_BRAND_VARIANTS = ${JSON.stringify(sorted)};
`);
}
console.log(JSON.stringify(summary, null, 2));
