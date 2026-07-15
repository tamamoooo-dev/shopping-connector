// browse/brands.js — BRAND KNOWLEDGE for Browse (BROWSE-DESIGN.md §5 KB #2,
// §6): the canonical home of Super Search's brand vocabulary, plus the OCR
// normalization that repairs a noisy flyer token into a canonical brand.
//
// Two layers in one module, same proven split as the viewer's
// brandKnowledge.js / brandNormalize.js (which seeded this list):
//   • BRANDS — the TRUTH: canonical names only, bilingual, with a stable slug.
//     No OCR variants, no misspellings, ever.
//   • the repair index + detectBrand() — folds/repairs input tokens so a
//     mangled OCR word can still reach the truth. Conservative and bounded:
//     an unknown brand returns null, never a wrong brand.
//
// SCOPE — deliberately small (~100 entries): major brands that recur across
// Saudi grocery flyers. This is bilingual identity ("Almarai" ↔ "المراعي"),
// NOT a product catalog. It never enters the frontend/engine matching mirrors
// (HANDOFF rule 2 stays two-file). Add an entry only when a brand recurs in
// flyers and unifying it improves Browse; ordinary-word names (e.g. Arabic
// "الكبير") must be guarded in AMBIGUOUS below, or left out.
//
// Detection failure mode (the project rule): "no brand", never "wrong brand".

import { normalizeText } from '../matching.js';

export const BRANDS = [
  // --- dairy, cheese, milk, juice ---
  { slug: 'almarai', en: 'Almarai', ar: 'المراعي' },
  { slug: 'nadec', en: 'Nadec', ar: 'نادك' },
  { slug: 'alsafi', en: 'Al Safi', ar: 'الصافي' },
  { slug: 'nada', en: 'Nada', ar: 'ندى' },
  { slug: 'puck', en: 'Puck', ar: 'بوك' },
  { slug: 'kiri', en: 'Kiri', ar: 'كيري' },
  { slug: 'luna', en: 'Luna', ar: 'لونا' },
  { slug: 'lurpak', en: 'Lurpak', ar: 'لورباك' },
  { slug: 'president', en: 'President', ar: 'بريزيدنت' },
  { slug: 'nestle', en: 'Nestle', ar: 'نستله' },
  { slug: 'anchor', en: 'Anchor', ar: 'أنكور' },
  { slug: 'rainbow', en: 'Rainbow', ar: 'راينبو' },
  { slug: 'nido', en: 'Nido', ar: 'نيدو' },
  { slug: 'kdd', en: 'KDD', ar: 'كي دي دي' },
  { slug: 'lacnor', en: 'Lacnor', ar: 'لاكنور' },
  // --- poultry, frozen, meat ---
  { slug: 'sadia', en: 'Sadia', ar: 'ساديا' },
  { slug: 'seara', en: 'Seara', ar: 'سيارا' },
  { slug: 'doux', en: 'Doux', ar: 'دوكس' },
  { slug: 'alwatania', en: 'Al Watania', ar: 'الوطنية' },
  { slug: 'tanmiah', en: 'Tanmiah', ar: 'التنمية' },
  { slug: 'americana', en: 'Americana', ar: 'أمريكانا' },
  { slug: 'sunbulah', en: 'Sunbulah', ar: 'سنبلة' },
  { slug: 'alkabeer', en: 'Al Kabeer', ar: 'الكبير' },
  { slug: 'herfy', en: 'Herfy', ar: 'هرفي' },
  { slug: 'montana', en: 'Montana', ar: 'مونتانا' },
  // --- pantry: oil, grains, canned, bakery ---
  { slug: 'goody', en: 'Goody', ar: 'قودي' },
  { slug: 'afia', en: 'Afia', ar: 'عافية' },
  { slug: 'alalali', en: 'Al Alali', ar: 'العلالي' },
  { slug: 'california-garden', en: 'California Garden', ar: 'كاليفورنيا' },
  { slug: 'halwani', en: 'Halwani', ar: 'حلواني' },
  { slug: 'deemah', en: 'Deemah', ar: 'ديمة' },
  { slug: 'quaker', en: 'Quaker', ar: 'كواكر' },
  { slug: 'maggi', en: 'Maggi', ar: 'ماجي' },
  { slug: 'knorr', en: 'Knorr', ar: 'كنور' },
  { slug: 'heinz', en: 'Heinz', ar: 'هاينز' },
  { slug: 'foster-clarks', en: "Foster Clark's", ar: 'فوستر كلاركس' },
  { slug: 'indomie', en: 'Indomie', ar: 'اندومي' },
  // --- beverages, coffee, tea ---
  { slug: 'pepsi', en: 'Pepsi', ar: 'بيبسي' },
  { slug: 'nescafe', en: 'Nescafe', ar: 'نسكافيه' },
  { slug: 'lipton', en: 'Lipton', ar: 'ليبتون' },
  { slug: 'rani', en: 'Rani', ar: 'راني' },
  { slug: 'vimto', en: 'Vimto', ar: 'فيمتو' },
  { slug: 'tang', en: 'Tang', ar: 'تانج' },
  { slug: 'barbican', en: 'Barbican', ar: 'باربيكان' },
  { slug: 'moussy', en: 'Moussy', ar: 'موسي' },
  { slug: 'aquafina', en: 'Aquafina', ar: 'أكوافينا' },
  { slug: 'nova', en: 'Nova', ar: 'نوفا' },
  { slug: 'berain', en: 'Berain', ar: 'برين' },
  { slug: 'hana', en: 'Hana', ar: 'هنا' },
  { slug: 'alrabie', en: 'Al Rabie', ar: 'الربيع' },
  // --- snacks, chocolate, biscuits ---
  { slug: 'nutella', en: 'Nutella', ar: 'نوتيلا' },
  { slug: 'galaxy', en: 'Galaxy', ar: 'جالكسي' },
  { slug: 'kinder', en: 'Kinder', ar: 'كيندر' },
  { slug: 'oreo', en: 'Oreo', ar: 'أوريو' },
  { slug: 'kitkat', en: 'KitKat', ar: 'كيتكات' },
  { slug: 'ulker', en: 'Ulker', ar: 'أولكر' },
  { slug: 'loacker', en: 'Loacker', ar: 'لواكر' },
  { slug: 'lays', en: 'Lays', ar: 'ليز' },
  { slug: 'snickers', en: 'Snickers', ar: 'سنيكرز' },
  { slug: 'twix', en: 'Twix', ar: 'تويكس' },
  // --- personal care ---
  { slug: 'nivea', en: 'Nivea', ar: 'نيفيا' },
  { slug: 'garnier', en: 'Garnier', ar: 'غارنييه' },
  { slug: 'dove', en: 'Dove', ar: 'دوف' },
  { slug: 'lux', en: 'Lux', ar: 'لكس' },
  { slug: 'sunsilk', en: 'Sunsilk', ar: 'سنسيلك' },
  { slug: 'pantene', en: 'Pantene', ar: 'بانتين' },
  { slug: 'head-shoulders', en: 'Head & Shoulders', ar: 'هيد اند شولدرز' },
  { slug: 'vaseline', en: 'Vaseline', ar: 'فازلين' },
  { slug: 'johnsons', en: "Johnson's", ar: 'جونسون' },
  { slug: 'gillette', en: 'Gillette', ar: 'جيليت' },
  { slug: 'veet', en: 'Veet', ar: 'فيت' },
  { slug: 'himalaya', en: 'Himalaya', ar: 'هيمالايا' },
  { slug: 'enchanteur', en: 'Enchanteur', ar: 'انشانتير' },
  { slug: 'colgate', en: 'Colgate', ar: 'كولجيت' },
  { slug: 'signal', en: 'Signal', ar: 'سيجنال' },
  { slug: 'sensodyne', en: 'Sensodyne', ar: 'سنسوداين' },
  { slug: 'closeup', en: 'Closeup', ar: 'كلوس اب' },
  { slug: 'lifebuoy', en: 'Lifebuoy', ar: 'لايفبوي' },
  { slug: 'dettol', en: 'Dettol', ar: 'ديتول' },
  // --- household ---
  { slug: 'tide', en: 'Tide', ar: 'تايد' },
  { slug: 'ariel', en: 'Ariel', ar: 'أريال' },
  { slug: 'persil', en: 'Persil', ar: 'برسيل' },
  { slug: 'clorox', en: 'Clorox', ar: 'كلوروكس' },
  { slug: 'fairy', en: 'Fairy', ar: 'فيري' },
  { slug: 'comfort', en: 'Comfort', ar: 'كمفورت' },
  { slug: 'downy', en: 'Downy', ar: 'داوني' },
  { slug: 'harpic', en: 'Harpic', ar: 'هاربيك' },
  { slug: 'fine', en: 'Fine', ar: 'فاين' },
  { slug: 'sanita', en: 'Sanita', ar: 'سانيتا' },
  { slug: 'kleenex', en: 'Kleenex', ar: 'كلينكس' },
  { slug: 'pampers', en: 'Pampers', ar: 'بامبرز' },
  { slug: 'huggies', en: 'Huggies', ar: 'هجيز' },
  // --- appliances (heavy flyer presence in the big hypers) ---
  { slug: 'geepas', en: 'Geepas', ar: 'جيباس' },
  { slug: 'krypton', en: 'Krypton', ar: 'كريبتون' },
  { slug: 'orinex', en: 'Orinex', ar: 'اورينكس' },
];

export const BRAND_BY_SLUG = new Map(BRANDS.map((b) => [b.slug, b]));

/* --- the OCR normalization / repair index (ported from viewer/brandNormalize) --- */

// Fold to a matching key: the engine's Arabic-aware normalizeText, then strip
// Latin combining diacritics so "Ülker" and "ulker" collapse to one form.
function fold(s) {
  return normalizeText(s).normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

const stripArticle = (w) => w.replace(/^(وال|ال)/, '');
const dedupe = (s) => s.replace(/(.)\1+/g, '$1');

// Canonical forms that are ALSO ordinary language — a bare occurrence must
// never be read as the brand ("الكبير" = "the big"; English "fine"; "هنا" =
// "here"; "اليوم" = "today"-class words stay out of the list entirely).
const AMBIGUOUS = new Set(['الكبير', 'كبير', 'fine', 'هنا'].map(fold));

// Sub-words too generic to identify a brand alone when a multi-word name is
// split ("California Garden" must not make every "garden" a brand).
const GENERIC = new Set(
  ['al', 'the', 'and', 'garden', 'gold', 'golden', 'family', 'farm', 'fresh',
   'food', 'house', 'home', 'star', 'royal', 'classic', 'head', 'shoulders',
   'اند'].map(fold),
);

const INDEX = new Map(); // folded key -> slug
const DEDUPE_INDEX = new Map(); // dedupe(key) -> slug
const FUZZY_KEYS = []; // keys length >= 4, trailing-junk repairable

function addKey(rawKey, slug) {
  const k = fold(rawKey);
  if (!k || k.length < 2 || AMBIGUOUS.has(k)) return;
  if (!INDEX.has(k)) {
    INDEX.set(k, slug);
    if (k.length >= 4) FUZZY_KEYS.push(k);
  }
  const d = dedupe(k);
  if (!DEDUPE_INDEX.has(d)) DEDUPE_INDEX.set(d, slug);
}

for (const { slug, en, ar } of BRANDS) {
  for (const name of [en, ar]) {
    if (!name) continue;
    const words = fold(name).split(' ').filter(Boolean);
    for (const w of words) {
      if (GENERIC.has(w)) continue;
      addKey(w, slug);
      const s = stripArticle(w);
      if (s !== w) addKey(s, slug);
    }
    if (words.length > 1) addKey(words.join(''), slug); // OCR-joined form
  }
}

// One token -> a brand slug, or null. Layered repair, cheapest first, bounded.
export function matchBrandToken(raw) {
  const n = fold(raw);
  if (!n) return null;
  const s = stripArticle(n);
  if (AMBIGUOUS.has(n) || AMBIGUOUS.has(s)) return null;
  if (INDEX.has(n)) return INDEX.get(n);
  if (s !== n && INDEX.has(s)) return INDEX.get(s);
  if (n.length < 4) return null;
  const hit = DEDUPE_INDEX.get(dedupe(n));
  if (hit) return hit;
  for (const k of FUZZY_KEYS) {
    if (n.length > k.length && n.length - k.length <= 2 && n.startsWith(k)) {
      return INDEX.get(k);
    }
  }
  return null;
}

// The brand of an offer's derived display names, or null. Scans BOTH language
// names word by word (retail names carry the brand as a standalone word in at
// least one script); the first hit wins — earliest word first, English name
// first (it OCRs cleaner). Never throws, never guesses.
export function detectBrand(offer) {
  for (const name of [offer.name, offer.nameAr]) {
    if (!name) continue;
    for (const word of String(name).split(/\s+/)) {
      const slug = matchBrandToken(word);
      if (slug) return slug;
    }
  }
  return null;
}
