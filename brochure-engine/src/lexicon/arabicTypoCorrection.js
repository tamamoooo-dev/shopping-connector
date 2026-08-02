// Deterministic Arabic typo correction for canonical product names.
//
// This is intentionally an allow-list, not a fuzzy spell-checker. A correction
// is possible only when an exact, reviewed misspelling is absent from the
// production Arabic lexicon and an exact English retail concept confirms the
// intended replacement. The function refuses ambiguity and proves after the
// edit that exactly one word changed while word order, numbers and every other
// character remain untouched.

import {
  SHOPPING_CATEGORIES,
  SHOPPING_DESCRIPTORS,
  SHOPPING_PACKAGE_TYPES,
} from './shopping.js';
import { BRAND_LEXICON } from './brands.js';

const ARABIC_TOKEN_RE = /[\u0621-\u063A\u0641-\u064A\u066E-\u06D3\u06FA-\u06FC]+/gu;
const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
const NUMBER_RE = /\p{N}+/gu;
const ARABIC_MARKS_RE = /[\u0640\u064B-\u065F\u0670]/gu;

function normalizeArabicToken(value) {
  return String(value ?? '').normalize('NFKC').replace(ARABIC_MARKS_RE, '');
}

function normalizeEnglish(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function exactEnglishPhrase(name, phrases) {
  const haystack = ` ${normalizeEnglish(name)} `;
  return phrases.some((phrase) => haystack.includes(` ${normalizeEnglish(phrase)} `));
}

function tokens(value, pattern) {
  return [...String(value ?? '').matchAll(pattern)].map((match) => match[0]);
}

function arabicTokens(value) {
  return [...String(value ?? '').matchAll(ARABIC_TOKEN_RE)].map((match) => ({
    raw: match[0],
    normalized: normalizeArabicToken(match[0]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

// Canonical retail spellings not yet emitted by the English Arabic Builder but
// approved for observed Arabic names. These entries are part of the production
// Arabic lexicon used by this stage, not generated suggestions.
export const ARABIC_TYPO_LEXICON_ADDITIONS = Object.freeze([
  'جبنة', 'شبيه', 'سادة', 'مكسرات', 'أسنان', 'جينز', 'بندق', 'بالعظم',
  'كاتشب', 'بسكويت', 'عطر', 'حار', 'ستربس', 'كبير', 'جرانيت', 'ماكسي',
]);

function buildArabicLexicon() {
  const out = new Set();
  const addPhrase = (phrase) => {
    for (const token of arabicTokens(phrase)) out.add(token.normalized);
  };
  for (const entry of [
    ...SHOPPING_CATEGORIES,
    ...SHOPPING_DESCRIPTORS,
    ...SHOPPING_PACKAGE_TYPES,
  ]) addPhrase(entry.ar);
  for (const brand of BRAND_LEXICON) addPhrase(brand.display_ar);
  for (const phrase of ARABIC_TYPO_LEXICON_ADDITIONS) addPhrase(phrase);
  return out;
}

const ARABIC_PRODUCT_LEXICON = buildArabicLexicon();

const rule = (id, from, to, english, options = {}) => Object.freeze({
  id,
  from: Object.freeze(from),
  to,
  english: Object.freeze(english),
  englishScope: Object.freeze(options.englishScope ?? []),
  arabicFollowing: Object.freeze(options.arabicFollowing ?? []),
});

// Every pair below was manually validated. Adding a rule requires an exact
// before/after token and deterministic English evidence; similarity alone is
// never a production rule.
export const ARABIC_TYPO_RULES = Object.freeze([
  rule('cheese-jeena', ['جينة'], 'جبنة', [
    'cheese', 'cream cheese', 'cheddar', 'mozzarella', 'halloumi', 'haloumi',
    'feta', 'emmental', 'roumy cheese', 'nabulsi cheese', 'cheese spread',
  ]),
  rule('analogue-shibiya', ['شيبية', 'شبيهه', 'شيبقة'], 'شبيه', [
    'analogue', 'analog', 'analogue cheese', 'analog cheese',
  ], { englishScope: ['cheese', 'feta', 'mozzarella', 'cream'] }),
  rule('foul-medammes', ['مدامس', 'مدمماس'], 'مدمس', [
    'foul medammes', 'foul medames', 'foul medammas', 'fou medammes',
  ]),
  rule('tomato-paste-majoon', ['مجون'], 'معجون', ['tomato paste']),
  rule('deodorant-remover', ['مزل', 'مزلج'], 'مزيل', [
    'deodorant', 'deo', 'antiperspirant',
  ], { arabicFollowing: ['عرق'] }),
  rule('lotion-loseen', ['لوسين'], 'لوشن', ['lotion', 'body lotion']),
  rule('plain-sada', ['صادة'], 'سادة', ['plain', 'original']),
  rule('butter-zayda', ['زيدة'], 'زبدة', ['butter', 'cocoa butter', 'peanut butter']),
  rule('peanut-butter-context', ['وجبة', 'جدة', 'زيادة'], 'زبدة', ['peanut butter'], {
    arabicFollowing: ['الفول', 'السوداني'],
  }),
  rule('air-fryer-qalaya', ['قلابة'], 'قلاية', ['air fryer'], {
    arabicFollowing: ['هوائية'],
  }),
  rule('nuts-mokassarat', ['مكسورات', 'مخسرات'], 'مكسرات', ['nuts', 'mixed nuts']),
  rule('dental-asnan', ['إستان', 'استن'], 'أسنان', ['toothpaste', 'tooth paste', 'toothbrush']),
  rule('jeans', ['جنز'], 'جينز', ['jeans']),
  rule('hazelnut', ['بنديق'], 'بندق', ['hazelnut']),
  rule('bone-in', ['بالظم', 'بالقظم'], 'بالعظم', ['bone in', 'bone-in', 'bone inn']),
  rule('rice', ['أريز', 'از'], 'أرز', ['rice', 'basmati rice', 'egyptian rice']),
  rule('fried', ['مقلبي'], 'مقلي', ['fried']),
  rule('evaporated', ['مبهر'], 'مبخر', ['evaporated milk']),
  rule('large', ['كيبر'], 'كبير', ['large']),
  rule('ketchup', ['كتشب', 'كيتشب'], 'كاتشب', ['ketchup', 'tomato ketchup']),
  rule('biscuit', ['بسكت'], 'بسكويت', ['biscuit', 'biscuits']),
  rule('maamoul', ['مامول'], 'معمول', ['maamoul', 'mamoul']),
  rule('wafer', ['وافير', 'فيفر'], 'ويفر', ['wafer', 'wafers']),
  rule('spicy', ['حات'], 'حار', ['spicy']),
  rule('chicken-strips', ['سبرسس', 'ستريبس'], 'ستربس', ['chicken strips']),
  rule('granite', ['نيجرانيت'], 'جرانيت', ['granite']),
  rule('iron', ['مكوي'], 'مكواة', ['steam iron', 'dry iron']),
  rule('cardamom', ['هل'], 'هيل', ['cardamom']),
  rule('maxi', ['مكسى'], 'ماكسي', ['maxi']),
  rule('mango', ['مانشو'], 'مانجو', ['mango', 'mangoes']),
  rule('malt', ['شير'], 'شعير', ['malt drink', 'malt beverage', 'non alcoholic malt']),
  rule('whole', ['خامل'], 'كامل', ['whole']),
  rule('beef', ['يقري'], 'بقري', ['beef']),
  rule('frozen', ['أجمد'], 'مجمد', ['frozen']),
  rule('stainless', ['استنلس', 'إستنلس'], 'ستانلس', ['stainless steel']),
]);

function followsAt(arabic, index, expected) {
  if (!expected.length) return true;
  return expected.every((token, offset) => (
    arabic[index + offset + 1]?.normalized === normalizeArabicToken(token)
  ));
}

function structuralProof(before, after) {
  const beforeWords = tokens(before, WORD_RE);
  const afterWords = tokens(after, WORD_RE);
  if (beforeWords.length !== afterWords.length) return false;
  const differences = [];
  for (let index = 0; index < beforeWords.length; index += 1) {
    if (beforeWords[index] !== afterWords[index]) differences.push(index);
  }
  if (differences.length !== 1) return false;
  return JSON.stringify(tokens(before, NUMBER_RE)) === JSON.stringify(tokens(after, NUMBER_RE));
}

export function proposeArabicTypoCorrection({ englishName, arabicName } = {}) {
  if (typeof englishName !== 'string' || typeof arabicName !== 'string') return null;
  if (!normalizeEnglish(englishName) || !arabicName.trim()) return null;

  const arabic = arabicTokens(arabicName);
  const candidates = [];
  for (const candidateRule of ARABIC_TYPO_RULES) {
    if (!exactEnglishPhrase(englishName, candidateRule.english)) continue;
    if (candidateRule.englishScope.length
        && !exactEnglishPhrase(englishName, candidateRule.englishScope)) continue;
    const sourceTokens = new Set(candidateRule.from.map(normalizeArabicToken));
    for (let index = 0; index < arabic.length; index += 1) {
      const source = arabic[index];
      if (!sourceTokens.has(source.normalized)) continue;
      // A known token is never a typo candidate, even when English suggests a
      // different word. This is the hard boundary between correction and rewrite.
      if (ARABIC_PRODUCT_LEXICON.has(source.normalized)) continue;
      if (!ARABIC_PRODUCT_LEXICON.has(normalizeArabicToken(candidateRule.to))) continue;
      if (!followsAt(arabic, index, candidateRule.arabicFollowing)) continue;
      candidates.push({ rule: candidateRule, source, wordIndex: index });
    }
  }

  // More than one matching position or rule is insufficient confidence. Never
  // pick a winner by score because that would make the stage a fuzzy rewriter.
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const corrected = arabicName.slice(0, candidate.source.start)
    + candidate.rule.to
    + arabicName.slice(candidate.source.end);
  if (!structuralProof(arabicName, corrected)) return null;

  return Object.freeze({
    name: corrected,
    ruleId: candidate.rule.id,
    originalToken: candidate.source.raw,
    replacementToken: candidate.rule.to,
  });
}

export function correctArabicProductName({ englishName, arabicName } = {}) {
  return proposeArabicTypoCorrection({ englishName, arabicName })?.name ?? arabicName;
}
