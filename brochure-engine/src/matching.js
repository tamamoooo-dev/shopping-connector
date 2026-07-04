// matching.js — the engine's PURE bilingual text-matching module. One home for
// "does this text actually match the user's query", shared by BOTH consumers
// that must agree on relevance:
//   • the /offers read API (offers/contract.js offerRelevance), and
//   • the Price Monitoring watch evaluation (monitor.js), which must never
//     alert on an irrelevant product ("milk" -> a milk-chocolate biscuit).
//
// It deliberately mirrors the frontend's src/match.js ideas (normalization,
// synonym bridge, word-boundary tiers, compound-noun demotion) so what the
// engine matches server-side is what the user sees client-side. Kept
// dependency-free and unit-tested by dev.mjs.
//
// WHY word boundaries matter here (the bug this module fixes): the old offers
// relevance used raw substring matching, so the Arabic query "بيض" (eggs)
// matched every offer whose OCR text contained "بيضاء"/"ابيض" (white) — a
// search for eggs returned white onions. Tokens now only match as whole words,
// word-start prefixes (long tokens only), or long substrings, each at a
// different score tier.

// --- normalization (matching-only fold, Arabic + English) ----------------------
// Lowercase, strip Arabic diacritics/tatweel, unify alef/hamza/taa-marbuta/
// alef-maqsura, fold Arabic-Indic digits to ASCII, drop punctuation.
const AR_DIACRITICS = /[ً-ٰٟـ]/g; // harakat + superscript alef + tatweel
const AR_INDIC = /[٠-٩]/g;
const PUNCT = /[^\p{L}\p{N}\s]/gu;

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(AR_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryTokens(q) {
  return normalizeText(q).split(' ').filter(Boolean).slice(0, 6);
}

// --- bilingual synonym bridge --------------------------------------------------
// Small by design: it lets an Arabic query match English OCR/product text (and
// vice versa) for the staples a shopper actually watches. Mirrors the frontend
// match.js table — keep the two in sync when adding entries.
const SYNONYMS = [
  ['milk', 'حليب', 'لبن'],
  ['eggs', 'egg', 'بيض', 'بيضه'],
  ['chicken', 'دجاج', 'فراخ'],
  ['rice', 'رز', 'ارز'],
  ['sugar', 'سكر'],
  ['water', 'ماء', 'مياه', 'مويه'],
  ['oil', 'زيت'],
  ['bread', 'خبز', 'عيش'],
  ['cheese', 'جبن', 'جبنه'],
  ['tea', 'شاي'],
  ['coffee', 'قهوه'],
  ['yogurt', 'yoghurt', 'زبادي', 'روب'],
  ['juice', 'عصير'],
  ['butter', 'زبده'],
  // fat-content descriptors: "منزوع الدسم" and "خالي الدسم" both mean skimmed
  ['skimmed', 'skim', 'منزوع', 'خالي'],
  ['squares', 'مربعات'],
  // household + personal-care staples that flyer shoppers actually search
  ['tuna', 'تونه', 'تن'],
  ['shampoo', 'شامبو'],
  ['tissue', 'tissues', 'مناديل', 'محارم'],
  ['chocolate', 'شوكولاته', 'شوكولا'],
  ['diapers', 'حفاضات', 'حفايض'],
  // common brand transliterations (Saudi shoppers search brands in Arabic;
  // flyer OCR often carries only the English brand line, and vice versa)
  ['pepsi', 'بيبسي'],
  ['cola', 'كولا'],
  ['tide', 'تايد'],
  ['nutella', 'نوتيلا'],
  // fresh produce (bilingual bridges so an Arabic produce query reaches
  // English-named catalogue items and flyer OCR, and vice versa). English
  // words that double as colours/scents ("orange") are deliberately left out.
  ['tomato', 'tomatoes', 'طماطم'],
  ['potato', 'potatoes', 'بطاطس', 'بطاطا'],
  ['onion', 'onions', 'بصل'],
  ['garlic', 'ثوم'],
  ['cucumber', 'خيار'],
  ['carrot', 'carrots', 'جزر'],
  ['lemon', 'ليمون'],
  ['strawberry', 'strawberries', 'فراوله'],
  ['banana', 'bananas', 'موز'],
  ['apple', 'apples', 'تفاح'],
  ['grape', 'grapes', 'عنب'],
  ['mango', 'مانجو', 'مانجا'],
  ['watermelon', 'بطيخ', 'حبحب'],
  ['pineapple', 'اناناس'],
  ['pomegranate', 'رمان'],
  ['avocado', 'افوكادو'],
  ['peach', 'خوخ'],
  ['apricot', 'مشمش'],
  ['kiwi', 'كيوي'],
  ['guava', 'جوافه'],
  ['eggplant', 'aubergine', 'باذنجان'],
  ['zucchini', 'courgette', 'كوسه'],
  ['cabbage', 'ملفوف'],
  ['cauliflower', 'قرنبيط'],
  ['broccoli', 'بروكلي'],
  ['spinach', 'سبانخ'],
  ['okra', 'باميه'],
];
const SYN_INDEX = (() => {
  const m = new Map();
  for (const group of SYNONYMS) {
    const norm = group.map(normalizeText);
    for (const t of norm) m.set(t, norm);
  }
  return m;
})();

// A query token plus its cross-language synonyms (all normalized).
export function expandToken(tok) {
  return SYN_INDEX.get(tok) || [tok];
}

// --- product families ---------------------------------------------------------
// A coarse, bilingual product-family classifier — MIRRORS the frontend's
// src/match.js (keep the two in sync). Products from DIFFERENT families must
// never compete or satisfy each other's watches, however similar their names:
// an egg-pastry offer is pastry, not eggs; "milk chocolate" is chocolate.
//
// Three tiers: any DERIVED-family keyword (compound products) outranks every
// BASE-family keyword; within a tier the EARLIEST keyword in the name wins.
// Whole-word matches only, with the Arabic definite article (ال/وال) stripped
// but بال/لل left attached ("بالبيض" = "with egg" marks an ingredient).
//
// PRODUCE is the third, LOWEST tier: fresh fruit/vegetable nouns are the
// prototypical flavour/ingredient modifiers in BOTH word orders ("حليب فراولة"
// and "Strawberry Milk" are milk; "معجون طماطم" and "tomato paste" are sauce),
// so any base- or derived-family keyword anywhere in the name outranks a
// produce keyword regardless of position. A name whose ONLY family signal is
// the produce noun ("طماطم طازجة", "Fresh Tomatoes 1kg") IS the produce.
const BASE_FAMILIES = {
  milk: ['milk', 'حليب'],
  laban: ['laban', 'لبن'],
  yogurt: ['yogurt', 'yoghurt', 'زبادي', 'روب'],
  cheese: ['cheese', 'جبن', 'جبنه', 'موزاريلا', 'mozzarella', 'شيدر', 'cheddar', 'حلوم', 'halloumi', 'فيتا', 'feta', 'قشقوان'],
  cream: ['cream', 'قشطه', 'قشده', 'كريمه'],
  butter: ['butter', 'زبده'],
  eggs: ['egg', 'eggs', 'بيض'],
  chicken: ['chicken', 'دجاج', 'فراخ'],
  meat: ['meat', 'beef', 'لحم', 'لحوم', 'بقري', 'غنم', 'mutton'],
  fish: ['fish', 'tuna', 'سمك', 'تونه', 'سلمون', 'salmon', 'سردين', 'sardine', 'sardines'],
  rice: ['rice', 'رز', 'ارز'],
  pasta: ['pasta', 'spaghetti', 'مكرونه', 'معكرونه', 'سباغيتي', 'نودلز', 'noodles', 'شعيريه'],
  bread: ['bread', 'toast', 'خبز', 'توست', 'صامولي'],
  oil: ['oil', 'زيت', 'زيوت'],
  water: ['water', 'ماء', 'مياه', 'مويه'],
  juice: ['juice', 'عصير'],
  tea: ['tea', 'شاي'],
  coffee: ['coffee', 'قهوه', 'نسكافيه', 'nescafe'],
  sugar: ['sugar', 'سكر'],
  flour: ['flour', 'دقيق', 'طحين'],
  dates: ['dates', 'تمر', 'تمور'],
  honey: ['honey', 'عسل'],
  vinegar: ['vinegar', 'خل'],
};
const DERIVED_FAMILIES = {
  // incl. confectionery brands that ARE the product name on shelves ("جالكسي
  // الفراولة" carries no word for chocolate) — same precedent as نسكافيه/coffee
  chocolate: ['chocolate', 'cocoa', 'شوكولاته', 'شيكولاته', 'شوكلاته', 'شكولاته', 'شوكلت', 'شوكولا', 'كاكاو', 'جالكسي', 'كيندر', 'kinder', 'اوريو', 'oreo', 'سنيكرز', 'snickers', 'تويكس', 'twix', 'كيتكات', 'kitkat'],
  biscuit: ['biscuit', 'biscuits', 'cookie', 'cookies', 'wafer', 'cracker', 'crackers', 'بسكويت', 'كوكيز', 'ويفر'],
  cake: ['cake', 'cakes', 'muffin', 'croissant', 'كيك', 'كيكه', 'كعك', 'مافن', 'كرواسون'],
  pastry: ['pastry', 'pastries', 'puff', 'dough', 'عجينه', 'عجين', 'فطاير', 'فطيره', 'سمبوسه', 'سمبوسك', 'بف', 'باف', 'donut', 'donuts', 'دونات'],
  icecream: ['icecream', 'gelato', 'ايس', 'بوظه'],
  powder: ['powder', 'بودره', 'مسحوق', 'مجفف', 'مجففه'],
  cereal: ['cereal', 'cereals', 'flakes', 'oats', 'granola', 'muesli', 'كورن', 'فليكس', 'شوفان', 'جرانولا'],
  candy: ['candy', 'gum', 'marshmallow', 'lollipop', 'chupa', 'chups', 'حلوى', 'حلاوه', 'جيلي', 'علكه', 'لولي', 'مصاص', 'مصاصه', 'مصاصات', 'شوبا', 'شوبس'],
  chips: ['chips', 'crisps', 'شيبس'],
  sauce: ['sauce', 'ketchup', 'mayonnaise', 'paste', 'puree', 'صوص', 'صلصه', 'كاتشب', 'مايونيز', 'مسطرده', 'معجون', 'بيوريه'],
  dessert: ['dessert', 'custard', 'pudding', 'حلا', 'مهلبيه', 'كاسترد', 'بودينج'],
  // prepared dishes: an "egg curry chappati" or "egg dosa" is a meal, not eggs
  prepared: ['curry', 'كاري', 'chappati', 'شاباتي', 'dosa', 'دوسا', 'sandwich', 'ساندويتش', 'burger', 'برجر', 'pizza', 'بيتزا', 'شاورما', 'shawarma', 'combo', 'كومبو', 'وجبه', 'meal'],
  // produce-derived shelf products: what turns "طماطم"/"فراولة" into paste,
  // jam, syrup drinks, soda, soup, pickles — the very look-alikes that were
  // drowning fresh produce in the grid.
  soup: ['soup', 'شوربه', 'شوربات'],
  jam: ['jam', 'marmalade', 'مربي'],
  syrup: ['syrup', 'nectar', 'cocktail', 'mojito', 'smoothie', 'shake', 'milkshake', 'سيرب', 'شراب', 'مشروب', 'مشروبات', 'نكتار', 'كوكتيل', 'موهيتو', 'سموذي', 'شيك', 'ميلكشيك', 'تانج', 'tang'],
  soda: ['soda', 'cola', 'pepsi', 'fanta', 'mirinda', 'sprite', '7up', 'cocacola', 'صودا', 'كولا', 'بيبسي', 'فانتا', 'ميرندا', 'سبرايت', 'سفن', 'كوكاكولا', 'غازي', 'غازيه', 'malt', 'شعير', 'هولستن', 'holsten', 'بربيكان', 'barbican', 'موسي', 'moussy'],
  pickle: ['pickle', 'pickles', 'مخلل', 'مخللات', 'طرشي'],
  // produce-shaped non-food ("لعبة على شكل فراولة" squeeze toys from Amazon)
  toy: ['toy', 'toys', 'لعبه', 'العاب'],
  // personal/household care: strawberry SOAP and lemon DISHWASHING liquid are
  // care products, not produce (scented look-alikes under produce queries).
  care: ['shampoo', 'soap', 'lotion', 'conditioner', 'detergent', 'dishwashing', 'شامبو', 'صابون', 'لوشن', 'بلسم', 'معطر', 'منظف', 'مطهر', 'غسول', 'ملمع'],
};
// Fresh fruit & vegetables — the LOWEST family tier (see the tier note above).
// Curated to common Saudi grocery produce with unambiguous words; ambiguous
// English colour/flavour words ("orange", "cherry") are deliberately Arabic-only
// so "Tide Orange" and "Cherry Tomatoes" never classify as fruit.
const PRODUCE_FAMILIES = {
  tomato: ['tomato', 'tomatoes', 'طماطم', 'طماط', 'بندوره'],
  potato: ['potato', 'potatoes', 'بطاطس', 'بطاطا'],
  onion: ['onion', 'onions', 'بصل'],
  garlic: ['garlic', 'ثوم'],
  cucumber: ['cucumber', 'cucumbers', 'خيار'],
  carrot: ['carrot', 'carrots', 'جزر'],
  lettuce: ['lettuce', 'خس'],
  zucchini: ['zucchini', 'courgette', 'كوسه'],
  eggplant: ['eggplant', 'aubergine', 'باذنجان'],
  cabbage: ['cabbage', 'ملفوف', 'كرنب'],
  cauliflower: ['cauliflower', 'broccoli', 'قرنبيط', 'بروكلي'],
  spinach: ['spinach', 'سبانخ'],
  okra: ['okra', 'باميه'],
  corn: ['corn', 'ذره'],
  lemon: ['lemon', 'lemons', 'ليمون'],
  ginger: ['ginger', 'زنجبيل'],
  mint: ['mint', 'نعناع'],
  coriander: ['coriander', 'cilantro', 'كزبره'],
  parsley: ['parsley', 'بقدونس'],
  strawberry: ['strawberry', 'strawberries', 'فراوله'],
  banana: ['banana', 'bananas', 'موز'],
  apple: ['apple', 'apples', 'تفاح', 'تفاحه'],
  orange: ['برتقال'],
  grapes: ['grape', 'grapes', 'عنب'],
  mango: ['mango', 'مانجو', 'مانجا'],
  watermelon: ['watermelon', 'بطيخ', 'حبحب'],
  melon: ['melon', 'cantaloupe', 'شمام'],
  pineapple: ['pineapple', 'اناناس'],
  peach: ['peach', 'خوخ'],
  apricot: ['apricot', 'مشمش'],
  plum: ['plum', 'برقوق'],
  pear: ['pear', 'pears', 'كمثري', 'اجاص'],
  kiwi: ['kiwi', 'كيوي'],
  pomegranate: ['pomegranate', 'رمان'],
  guava: ['guava', 'جوافه'],
  cherry: ['كرز'],
  berries: ['blueberry', 'blueberries', 'raspberry', 'raspberries', 'blackberry', 'توت', 'بلوبيري'],
  fig: ['fig', 'figs', 'تين'],
};
// A produce word right next to one of these names a FLAVOUR/SCENT, not the
// produce itself ("حليب بنكهة الفراولة", "strawberry flavoured", "برائحة
// الليمون") — such a hit must not classify the product as produce.
const FLAVOR_MARKERS = new Set(
  ['بنكهه', 'نكهه', 'نكهات', 'بطعم', 'طعم', 'برائحه', 'رائحه',
   'flavor', 'flavour', 'flavored', 'flavoured', 'flavors', 'flavours', 'scented'].map(normalizeText),
);
const FAMILY_INDEX = (() => {
  const m = new Map(); // keyword -> { family, derived, produce }
  for (const [family, words] of Object.entries(DERIVED_FAMILIES)) {
    for (const w of words) m.set(normalizeText(w), { family, derived: true });
  }
  for (const [family, words] of Object.entries(BASE_FAMILIES)) {
    for (const w of words) {
      const k = normalizeText(w);
      if (!m.has(k)) m.set(k, { family, derived: false });
    }
  }
  for (const [family, words] of Object.entries(PRODUCE_FAMILIES)) {
    for (const w of words) {
      const k = normalizeText(w);
      if (!m.has(k)) m.set(k, { family, derived: false, produce: true });
    }
  }
  return m;
})();

// Strips the definite article only. بال/لل stay attached (ingredient/purpose
// markers) — and so does a bare conjunction waw: "سردين وصلصة الطماطم" is
// sardines WITH sauce, an accompaniment; stripping و would let the derived
// keyword hijack the family.
function familyKey(word) {
  if (FAMILY_INDEX.has(word)) return word;
  const stripped = word.replace(/^(وال|ال)/, '');
  return stripped !== word && FAMILY_INDEX.has(stripped) ? stripped : null;
}

// The product family of a name (or any text), or null.
// Tier order: derived > base > produce (see the tier note above).
export function productFamily(name) {
  const words = normalizeText(name).split(' ');
  let base = null;
  let produce = null;
  for (let i = 0; i < words.length; i++) {
    const key = familyKey(words[i]);
    if (!key) continue;
    const hit = FAMILY_INDEX.get(key);
    if (hit.derived) return hit.family;
    if (hit.produce) {
      // a produce word next to a flavour/scent marker names a flavour, not the
      // product ("بنكهة الفراولة", "strawberry flavoured")
      if (!produce && !FLAVOR_MARKERS.has(words[i - 1]) && !FLAVOR_MARKERS.has(words[i + 1])) {
        produce = hit.family;
      }
    } else if (!base) {
      base = hit.family;
    }
  }
  return base || produce;
}

// The family the QUERY names ("حليب نادك" -> milk), or null (brand-only query).
export function queryFamily(query) {
  return productFamily(query);
}

// --- product types (a FORM attribute, orthogonal to family) ---------------------
// MIRRORS the frontend's src/match.js (keep the two in sync). A product's FAMILY
// answers "what is it / which aisle" (chicken); its TYPE answers "what form is
// it" (nuggets vs roll vs breast). Two listings can share a brand AND a family
// and still be different products — "chicken nuggets" is not "chicken roll" — so
// a watch/comparison must not treat a different KNOWN form as the same product.
// Narrow by design; a name with no type keyword has type null (nothing gated).
const PRODUCT_TYPES = {
  nuggets: ['nugget', 'nuggets', 'ناجتس', 'ناغتس', 'نجتس', 'نجت'],
  burger: ['burger', 'burgers', 'hamburger', 'برجر', 'برغر', 'همبرجر', 'هامبرجر', 'همبرغر'],
  sausage: ['sausage', 'sausages', 'frankfurter', 'hotdog', 'سجق', 'سوسيس', 'نقانق'],
  roll: ['roll', 'rolls', 'رول', 'رولات'],
  mince: ['mince', 'minced', 'مفروم', 'مفرومه'],
  fillet: ['fillet', 'fillets', 'filet', 'فيليه', 'فيليت'],
  breast: ['breast', 'breasts', 'صدر', 'صدور'],
  strips: ['strip', 'strips', 'ستربس', 'شرائح'],
  wings: ['wing', 'wings', 'جناح', 'اجنحه', 'جوانح'],
  kofta: ['kofta', 'kufta', 'kabab', 'kebab', 'كفته', 'كباب'],
  luncheon: ['luncheon', 'mortadella', 'لانشون', 'مرتديلا'],
};
const TYPE_INDEX = (() => {
  const m = new Map();
  for (const [type, words] of Object.entries(PRODUCT_TYPES)) {
    for (const w of words) m.set(normalizeText(w), type);
  }
  return m;
})();

function typeKey(word) {
  if (TYPE_INDEX.has(word)) return word;
  const stripped = word.replace(/^(وال|ال)/, '');
  return stripped !== word && TYPE_INDEX.has(stripped) ? stripped : null;
}

// The product type/form named by a text, or null when none appears.
export function productType(name) {
  const words = normalizeText(name).split(' ');
  for (const w of words) {
    const key = typeKey(w);
    if (key) return TYPE_INDEX.get(key);
  }
  return null;
}

// The type the QUERY names ("chicken nuggets" -> nuggets), or null.
export function queryType(query) {
  return productType(query);
}

// --- fresh-produce intent (mirrors frontend match.js) ------------------------
// A bare produce query ("فراولة", "طماطم") names the FRESH product: if the
// shopper wanted the frozen/canned/formed variant they would have said so
// ("فراولة مجمدة"). Consumers (/offers famRank) demote same-family offers that
// are processed or carry a FORM word — produce has no forms, so a typed
// same-family name ("رول فراولة") is really a different product the family
// lexicon couldn't see. Naming the processing/form in the query disables it.
const PROCESSED_MARKERS = new Set(
  [
    'مجمد', 'مجمده', 'مجمدات', 'frozen',
    'معلب', 'معلبه', 'معلبات', 'canned', 'tinned',
    'مقشر', 'مقشره', 'peeled',
    'مجروش', 'مجروشه', 'crushed',
    'مطبوخ', 'مطبوخه', 'cooked',
    'chopped', 'diced', 'sliced',
    'مغطي', 'مغطاه', 'coated', // chocolate-COATED strawberries etc.
    'dried', // freeze-dried fruit (Arabic مجفف already classifies as powder)
    // frozen-food BRANDS whose produce bags never say "frozen" on the name
    // line ("مونتانا فراولة 1 كجم" is a frozen kilo bag). Only consulted for
    // fresh-produce-intent demotion, so "صدور ساديا" etc. are unaffected.
    'مونتانا', 'montana', 'داري', 'dari', 'الكبير', 'alkabeer', 'kabeer', 'ساديا', 'sadia', 'سيارا', 'seara', 'سنبله', 'sunbulah', 'sunbula',
  ].map(normalizeText),
);

// Does a name carry a processing marker (frozen/canned/peeled/…)? Article and
// conjunction-waw prefixes are stripped like family keywords ("المجمدة").
export function isProcessedProduce(text) {
  for (const w of normalizeText(text).split(' ')) {
    if (PROCESSED_MARKERS.has(w)) return true;
    const stripped = w.replace(/^(وال|ال|و)/, '');
    if (stripped !== w && PROCESSED_MARKERS.has(stripped)) return true;
  }
  return false;
}

// Is this family one of the fresh-produce (lowest-tier) families?
export function isProduceFamily(family) {
  return !!family && Object.prototype.hasOwnProperty.call(PRODUCE_FAMILIES, family);
}

// The produce family a query names with FRESH intent, or null: the query must
// resolve to a produce family and itself carry no form/processing words.
export function freshProduceIntent(query) {
  const fam = queryFamily(query);
  if (!isProduceFamily(fam)) return null;
  if (queryType(query) || isProcessedProduce(query)) return null;
  return fam;
}

const PRODUCE_KEYWORDS = (() => {
  const m = new Map(); // family -> Set of normalized keywords
  for (const [family, words] of Object.entries(PRODUCE_FAMILIES)) {
    m.set(family, new Set(words.map(normalizeText)));
  }
  return m;
})();

// How a produce family appears in a text: as the PRODUCT itself ('product' —
// a standalone word, definite article allowed), as a FLAVOUR/ingredient only
// ('flavored' — بال/لل attached, or next to a flavour marker), or not at all
// (null). "مصاصات بالفراولة" is a flavoured product even though no candy
// keyword survived OCR; "فراولة طازجة" is the product. A standalone mention
// anywhere wins over a flavoured one.
export function producePresence(text, family) {
  const keys = PRODUCE_KEYWORDS.get(family);
  if (!keys) return null;
  const words = normalizeText(text).split(' ');
  let flavored = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const plain = w.replace(/^(وال|ال)/, '');
    if (keys.has(plain)) {
      if (FLAVOR_MARKERS.has(words[i - 1]) || FLAVOR_MARKERS.has(words[i + 1])) {
        flavored = true;
        continue;
      }
      return 'product';
    }
    const attached = w.replace(/^(بال|لل)/, '');
    if (attached !== w && keys.has(attached)) flavored = true;
  }
  return flavored ? 'flavored' : null;
}

// --- category-as-family (a retailer-taxonomy semantic signal) -------------------
// The aggregator tags every flyer offer with its OWN product category (D4D's
// global taxonomy, e.g. "eggs", "yogurt-labneh", "chocolates-candies"). That is
// a structured, human-curated signal we get for free — a semantic COMPLEMENT to
// the keyword family classifier, not a replacement. We map only the categories
// that resolve to exactly ONE of our families (ambiguous ones like "milk-laban",
// "tea-coffee" or "cheese-creame" are deliberately left unmapped), and we use it
// only as a FALLBACK: a name keyword always wins, so precision is unchanged and
// the failure mode stays "no family", never "wrong family". The payoff is
// recovering offers whose OCR name is debris ("casc 18 200ml") into their true
// family — sharpening both the /offers family ranking and the watch gate.
const CATEGORY_FAMILY = {
  eggs: 'eggs',
  rice: 'rice',
  water: 'water',
  'juices-drinks': 'juice',
  'oil-ghee': 'oil',
  'sugar-sweetener': 'sugar',
  'pasta-noodles': 'pasta',
  'bread-buns': 'bread',
  biscuits: 'biscuit',
  'chocolates-candies': 'chocolate',
  'yogurt-labneh': 'yogurt',
  'butter-margarine': 'butter',
  'fresh-chicken-poultry': 'chicken',
  'frozen-chicken-poultry': 'chicken',
  'meat-fresh-chilled': 'meat',
  'fresh-fish': 'fish',
  'frozen-fish': 'fish',
  'cereals-bars': 'cereal',
};

// The family implied by an aggregator category slug, or null (unmapped/ambiguous).
export function categoryFamily(slug) {
  if (!slug) return null;
  return CATEGORY_FAMILY[String(slug).toLowerCase()] || null;
}

// The family of a flyer OFFER: its name-derived family (most specific), falling
// back to its aggregator category. Name always wins, so "milk chocolate" in the
// chocolates category is chocolate, and an "egg curry" is a prepared dish — the
// category only fills the gap when the name yields nothing.
export function offerFamily(offer) {
  if (!offer) return null;
  const nameFam = productFamily(`${offer.name || ''} ${offer.nameAr || ''}`);
  if (nameFam) return nameFam;
  return categoryFamily(offer.category);
}

// --- token-in-text scoring ------------------------------------------------------
// How strongly one (already normalized) token variant appears in a normalized
// text. Tiers: whole word (best) > word-start prefix (long tokens only — short
// Arabic stems like "بيض" prefix-match unrelated words like "بيضاء") > long
// substring (compound words like "cornflakes"). 0 = no usable match.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function tokenScore(variant, text, words) {
  if (!variant || !text) return 0;
  if (words.has(variant)) return 100;
  if (variant.length >= 4 && new RegExp(`(^| )${escapeRe(variant)}`).test(text)) return 70;
  if (variant.length >= 5 && text.includes(variant)) return 40;
  return 0;
}

// The best score any synonym variant of `tok` achieves in `text`.
export function bestVariantScore(tok, text, words) {
  let best = 0;
  for (const v of expandToken(tok)) {
    const s = tokenScore(v, text, words);
    if (s > best) best = s;
  }
  return best;
}

// --- compound-noun demotion -----------------------------------------------------
// Words that, when they FOLLOW the query token, usually change the product into
// a different category ("milk" vs "milk chocolate/powder/biscuit"). Matching
// items are demoted, never boosted. Mirrors the frontend match.js table.
const COMPOUND_SHIFTERS = new Set(
  [
    'chocolate', 'biscuit', 'biscuits', 'cookie', 'cookies', 'powder', 'bar', 'candy',
    'cereal', 'cake', 'shake', 'flavour', 'flavoured', 'flavored', 'drink', 'jam',
    'شوكولاته', 'شوكولا', 'بسكويت', 'بودره', 'حلوى', 'كيك',
  ].map(normalizeText),
);

export function compoundPenalty(nameNorm, qTokens) {
  const words = nameNorm.split(' ');
  for (const qt of qTokens) {
    const variants = expandToken(qt);
    for (let i = 0; i < words.length - 1; i++) {
      if (variants.includes(words[i]) && COMPOUND_SHIFTERS.has(words[i + 1])) return 0.45;
    }
  }
  return 1;
}

// --- name relevance (the watch-evaluation gate) ----------------------------------
// Score how well a product NAME matches the query (0..100). Every query token
// must appear (AND semantics); the weakest token bounds the score; compound
// look-alikes are demoted. This is what keeps Price Monitoring honest: a watch
// only considers results whose NAME genuinely matches the watched query.
export function nameRelevance(name, query) {
  const qTokens = queryTokens(query);
  if (!qTokens.length) return 0;
  const text = normalizeText(name);
  if (!text) return 0;
  const words = new Set(text.split(' '));
  let sum = 0;
  for (const tok of qTokens) {
    const s = bestVariantScore(tok, text, words);
    if (!s) return 0; // AND: a token with no match anywhere -> irrelevant
    sum += s;
  }
  return (sum / qTokens.length) * compoundPenalty(text, qTokens);
}

// Is a product name relevant enough for the watch/monitor layer to trust?
// Requires at least a word-start-tier match on every token (substring-only
// matches are too weak to act on unattended).
export function isRelevantName(name, query, floor = 40) {
  return nameRelevance(name, query) >= floor;
}

// --- size / quantity parsing -----------------------------------------------------
// Ported from the frontend's match.js so the watch monitor can compare like with
// like: a grocery watch remembers the watched product's size, and a candidate
// price only counts when its size is comparable (a 200 ml milk must never
// trigger a 2 L milk watch). Returns { unit:'ml'|'g'|'pcs'|null, each, pack,
// total }. Keep in sync with the frontend module.
const B = '(?![\\p{L}\\p{N}])'; // unicode boundary — JS \b is ASCII-only
const UNIT_TO_BASE = [
  { re: new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(l|lt|ltr|liter|litre|litres|لتر|ليتر)${B}`, 'u'), base: 'ml', factor: 1000 },
  { re: new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(ml|مل|ميلي|مليلتر)${B}`, 'u'), base: 'ml', factor: 1 },
  { re: new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(kg|kgs|kilo|kilos|كجم|كيلو|كغ|كيلوجرام)${B}`, 'u'), base: 'g', factor: 1000 },
  { re: new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(g|gm|gr|grm|gram|grams|جم|جرام|غرام|غ)${B}`, 'u'), base: 'g', factor: 1 },
];
const UNITS = 'l|lt|ltr|liter|litre|ml|kg|g|gm|gr|gram|لتر|مل|كجم|جم|جرام';
const COUNT_WORDS = 'pcs|pc|pieces|piece|قطعه|قطعة|قطع|حبه|حبة|حبات|عبوات|عبوه|عبوة|اكياس|كيس';
const PACK_RE = [
  // "6 x 200 ml" and "24 قطعة × 125مل" (an optional count word between the
  // pack number and the ×) — pack first, size second.
  new RegExp(`(\\d+)\\s*(?:${COUNT_WORDS})?\\s*[x×*]\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNITS})${B}`, 'u'),
  new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNITS})${B}\\s*[x×*]\\s*(\\d+)`, 'u'), // 200 ml x 6
];
const COUNT_RE = new RegExp(`(\\d+)\\s*(pcs|pc|pieces|piece|ct|count|s|x|حبه|حبة|حبات|قطعه|قطعة|عبوات|عبوه|عبوة|اكياس|كيس)${B}`, 'u');

const num = (x) => parseFloat(String(x).replace(',', '.'));

// Size-specific normalization: unlike normalizeText it PRESERVES the decimal
// point inside numbers ("2.85L" must not become 85 L) and pack separators.
const AR_INDIC_MAP = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function normSize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => AR_INDIC_MAP[d] || d)
    .replace(AR_DIACRITICS, '')
    .replace(/٫/g, '.')
    .replace(/[^\p{L}\p{N}\s.,x×*]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unitFor(tok) {
  const t = normalizeText(tok);
  if (/^(l|lt|ltr|liter|litre|litres|لتر|ليتر)$/u.test(t)) return { unit: 'ml', factor: 1000 };
  if (/^(ml|مل|ميلي|مليلتر)$/u.test(t)) return { unit: 'ml', factor: 1 };
  if (/^(kg|kgs|kilo|kilos|كجم|كيلو|كغ|كيلوجرام)$/u.test(t)) return { unit: 'g', factor: 1000 };
  if (/^(g|gm|gr|grm|gram|grams|جم|جرام|غرام|غ)$/u.test(t)) return { unit: 'g', factor: 1 };
  return null;
}

export function parseSize(name, sizeField) {
  const hay = normSize(`${name || ''} ${sizeField || ''}`);
  const forms = [
    { re: PACK_RE[0], pack: 1, size: 2, unit: 3 },
    { re: PACK_RE[1], pack: 3, size: 1, unit: 2 },
  ];
  for (const f of forms) {
    const m = f.re.exec(hay);
    if (m) {
      const base = unitFor(m[f.unit]);
      if (base) {
        const each = num(m[f.size]) * base.factor;
        const pack = Math.max(1, Math.round(num(m[f.pack])) || 1);
        return { unit: base.unit, each, pack, total: each * pack };
      }
    }
  }
  for (const u of UNIT_TO_BASE) {
    const m = u.re.exec(hay);
    if (m) {
      const each = num(m[1]) * u.factor;
      // A trailing "x6" pack multiplier — but never the size's own "× 125ml"
      // digits (a unit right after the number means the × introduced the SIZE).
      const pm =
        new RegExp(`[x×*]\\s*(\\d+)(?!\\s*(?:${UNITS}))${B}`, 'u').exec(hay) ||
        /\b(\d+)\s*(?:pcs|pc|pack|s)\b/.exec(hay);
      const pack = pm ? Math.max(1, parseInt(pm[1], 10)) : 1;
      return { unit: u.base, each, pack, total: each * pack };
    }
  }
  const cm = COUNT_RE.exec(hay);
  if (cm) {
    const n = parseInt(cm[1], 10);
    if (n > 0 && n <= 500) return { unit: 'pcs', each: 1, pack: n, total: n };
  }
  return { unit: null, each: null, pack: 1, total: null };
}

// Are two parsed sizes comparable enough for one to satisfy a watch on the
// other? Same unit family and total within ±tolerance (default 25%).
export function sizeComparable(a, b, tolerance = 0.25) {
  if (!a || !b || !a.unit || !b.unit || a.unit !== b.unit) return false;
  if (a.total == null || b.total == null) return false;
  const hi = Math.max(a.total, b.total);
  const lo = Math.min(a.total, b.total);
  return hi > 0 && (hi - lo) / hi <= tolerance;
}
