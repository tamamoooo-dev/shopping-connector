// Brand words that are ALSO ordinary product words. They stay valid in a field
// the extractor typed as "brand", but a product NAME that merely contains one
// is no evidence of that company: "Golden Kiwi" is not Golden Chicken, "Crispy"
// nuggets are not the Crispy brand, «كريم» is cream before it is Creme 21.
//
// Measured 2026-10-23 on the 44,851 archive observations (name scan vs the
// typed brand field): every key below disagreed with a resolved brand field
// at least 3 times and was right at most as often as it was wrong, or names an
// adjective, origin, size or common noun. Folded spelling (lower case, Arabic
// letters normalised, no article for Arabic entries that list both forms).
// Evidence: grocery-brand-review-2026-10-23/evidence/key-conflicts.json.
export const NAME_SCAN_UNSAFE = new Set([
  // English adjectives, sizes and common nouns
  'golden', 'gold', 'crispy', 'freshly', 'fresh', 'delights', 'delight', 'original', 'extra', 'xl', 'xxl',
  'maxy', 'maxi', 'grand', 'star', 'city', 'fine', 'comfort', 'crystal', 'flora', 'oxi', 'sport',
  'herbal', 'american', 'junior', 'classic', 'family', 'farm', 'joy', 'baby', 'creme', 'cream', 'hb', 'tm',
  'premium', 'select', 'special', 'super', 'mega', 'jumbo', 'value', 'natural', 'pure', 'gourmet', 'brown',
  'red', 'sun', 'sunny', 'sea', 'nature', 'green', 'white', 'black', 'blue',
  // Arabic common words, places and adjectives
  'كريم', 'كريمه', 'شمس', 'الشمس', 'ماكسي', 'اكس', 'نباتي', 'جاردن', 'النخبه', 'نخبه', 'بيبي', 'اليومي',
  'يومي', 'جوي', 'ميزان', 'ديل', 'الوادي', 'وادي', 'الهيمالايا', 'الطيب', 'طيب', 'سان', 'سبورت', 'بحر',
  'ريد', 'المدينه', 'مدينه', 'دره', 'الذره', 'العملاق', 'بيك', 'براون', 'فلورا', 'امل', 'المزارع',
  'مزارع', 'ندي', 'كريسبي', 'ديلايتس', 'الاولي', 'النخيل', 'نخيل', 'الذهبي', 'ذهبي', 'فارم',
  'المزرعه', 'جراند', 'ستار', 'سيتي', 'اوريجينال', 'اكسترا', 'جونيور', 'هلا', 'لولو', 'جودا',
  'البركه', 'بركه', 'فرشلي', 'سني', 'نور',
  // 2026-10-23 reading-knowledge seeds whose Arabic is an ordinary word or name.
  'شمال', 'صحتين', 'نورا', 'زهراتي', 'نحول', 'صباحو', 'هيبا',
]);
