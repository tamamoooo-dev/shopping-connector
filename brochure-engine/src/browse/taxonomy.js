// browse/taxonomy.js — the CANONICAL Browse taxonomy: Super Search's own
// supermarket vocabulary (BROWSE-DESIGN.md §5, KB #1). Departments and aisles
// are OURS — provider-agnostic by design. No provider category slug ever
// appears in this file; providers map INTO these ids via browse/mapping.js
// (the Provider → Mapping → Canonical Knowledge → Browse boundary).
//
// SCOPE — intentionally small and stable (~11 departments, ~70 aisles). This
// is editorial vocabulary, not a product ontology: an aisle exists because a
// Saudi supermarket shopper thinks in it ("أجبان وقشطة"), not because a data
// source has a slug for it. Expect changes a couple of times a year at most.
//
// Every aisle belongs to exactly ONE department. The `other` aisle (department
// `more`) is the visible landing zone for provider categories no mapping
// covers yet — nothing is ever hidden by an unmapped slug.

export const OTHER_AISLE = 'other';
export const OTHER_DEPT = 'more';

// Departments in display order (the market-floor tiles).
export const DEPARTMENTS = [
  { id: 'fresh', en: 'Fresh Food', ar: 'الطازج' },
  { id: 'dairy-eggs', en: 'Dairy & Eggs', ar: 'الألبان والبيض' },
  { id: 'beverages', en: 'Beverages', ar: 'المشروبات' },
  { id: 'pantry', en: 'Food Cupboard', ar: 'البقالة' },
  { id: 'snacks-sweets', en: 'Snacks & Sweets', ar: 'الحلويات والتسالي' },
  { id: 'bakery', en: 'Bakery', ar: 'المخبوزات' },
  { id: 'frozen', en: 'Frozen', ar: 'المجمدات' },
  { id: 'baby', en: 'Baby', ar: 'الطفل' },
  { id: 'beauty-health', en: 'Beauty & Health', ar: 'الجمال والصحة' },
  { id: 'household', en: 'Household', ar: 'المنزل والتنظيف' },
  { id: 'home-electronics', en: 'Home, Electronics & More', ar: 'الأجهزة والمزيد' },
  { id: OTHER_DEPT, en: 'More', ar: 'المزيد' },
];

// Aisles in display order within their department.
export const AISLES = [
  // --- fresh -----------------------------------------------------------------
  { id: 'fruits', dept: 'fresh', en: 'Fresh Fruits', ar: 'فواكه طازجة' },
  { id: 'vegetables', dept: 'fresh', en: 'Fresh Vegetables', ar: 'خضروات طازجة' },
  { id: 'chicken-poultry', dept: 'fresh', en: 'Chicken & Poultry', ar: 'دجاج وطيور' },
  { id: 'meat', dept: 'fresh', en: 'Fresh Meat', ar: 'لحوم طازجة' },
  { id: 'fish', dept: 'fresh', en: 'Fish & Seafood', ar: 'أسماك ومأكولات بحرية' },
  { id: 'deli', dept: 'fresh', en: 'Deli & Cold Cuts', ar: 'لحوم باردة' },

  // --- dairy & eggs ------------------------------------------------------------
  { id: 'milk-laban', dept: 'dairy-eggs', en: 'Milk & Laban', ar: 'حليب ولبن' },
  { id: 'yogurt-labneh', dept: 'dairy-eggs', en: 'Yogurt & Labneh', ar: 'زبادي ولبنة' },
  { id: 'cheese-cream', dept: 'dairy-eggs', en: 'Cheese & Cream', ar: 'أجبان وقشطة' },
  { id: 'butter-margarine', dept: 'dairy-eggs', en: 'Butter & Margarine', ar: 'زبدة وسمن' },
  { id: 'eggs', dept: 'dairy-eggs', en: 'Eggs', ar: 'بيض' },
  { id: 'milk-powder', dept: 'dairy-eggs', en: 'Powdered & Condensed Milk', ar: 'حليب مجفف ومكثف' },

  // --- beverages ---------------------------------------------------------------
  { id: 'water', dept: 'beverages', en: 'Water', ar: 'مياه' },
  { id: 'juices', dept: 'beverages', en: 'Juices & Drinks', ar: 'عصائر ومشروبات' },
  { id: 'soft-drinks', dept: 'beverages', en: 'Soft Drinks', ar: 'مشروبات غازية' },
  { id: 'malt-drinks', dept: 'beverages', en: 'Malt Beverages', ar: 'شعير' },
  { id: 'tea-coffee', dept: 'beverages', en: 'Tea & Coffee', ar: 'شاي وقهوة' },
  { id: 'drink-mixes', dept: 'beverages', en: 'Powdered Drinks & Syrups', ar: 'مشروبات بودرة وشراب' },

  // --- pantry --------------------------------------------------------------------
  { id: 'rice', dept: 'pantry', en: 'Rice', ar: 'أرز' },
  { id: 'pasta-noodles', dept: 'pantry', en: 'Pasta & Noodles', ar: 'مكرونة ونودلز' },
  { id: 'oil-ghee', dept: 'pantry', en: 'Oil & Ghee', ar: 'زيوت وسمن' },
  { id: 'flour-baking', dept: 'pantry', en: 'Flour & Baking', ar: 'دقيق ومستلزمات الخبز' },
  { id: 'canned-food', dept: 'pantry', en: 'Canned & Packaged Food', ar: 'معلبات وأغذية معبأة' },
  { id: 'sauces-spreads', dept: 'pantry', en: 'Sauces & Spreads', ar: 'صلصات ومربيات' },
  { id: 'spices', dept: 'pantry', en: 'Salt, Spices & Pastes', ar: 'ملح وبهارات ومعجون' },
  { id: 'pulses-grains', dept: 'pantry', en: 'Pulses, Beans & Grains', ar: 'بقوليات وحبوب' },
  { id: 'sugar', dept: 'pantry', en: 'Sugar & Sweeteners', ar: 'سكر ومحليات' },
  { id: 'ready-meals', dept: 'pantry', en: 'Ready to Eat', ar: 'وجبات جاهزة' },

  // --- snacks & sweets --------------------------------------------------------------
  { id: 'chocolates-candies', dept: 'snacks-sweets', en: 'Chocolates & Candies', ar: 'شوكولاتة وحلويات' },
  { id: 'biscuits', dept: 'snacks-sweets', en: 'Biscuits & Cookies', ar: 'بسكويت' },
  { id: 'chips-snacks', dept: 'snacks-sweets', en: 'Chips & Snacks', ar: 'شيبس وتسالي' },
  { id: 'cereals', dept: 'snacks-sweets', en: 'Cereals & Bars', ar: 'حبوب الإفطار' },
  { id: 'dates-dried-fruits', dept: 'snacks-sweets', en: 'Dates & Dried Fruits', ar: 'تمور وفواكه مجففة' },
  { id: 'desserts', dept: 'snacks-sweets', en: 'Puddings & Desserts', ar: 'حلويات جاهزة' },
  { id: 'ice-cream', dept: 'snacks-sweets', en: 'Ice Cream', ar: 'آيس كريم' },

  // --- bakery -------------------------------------------------------------------------
  { id: 'bread', dept: 'bakery', en: 'Bread & Buns', ar: 'خبز وصامولي' },
  { id: 'cakes-pastry', dept: 'bakery', en: 'Cakes & Pastry', ar: 'كيك ومعجنات' },

  // --- frozen -------------------------------------------------------------------------
  { id: 'frozen-poultry', dept: 'frozen', en: 'Frozen Chicken & Poultry', ar: 'دجاج مجمد' },
  { id: 'frozen-meat', dept: 'frozen', en: 'Frozen Meat', ar: 'لحوم مجمدة' },
  { id: 'frozen-fish', dept: 'frozen', en: 'Frozen Fish & Seafood', ar: 'أسماك مجمدة' },
  { id: 'frozen-fruits-veg', dept: 'frozen', en: 'Frozen Fruits & Vegetables', ar: 'خضار وفواكه مجمدة' },
  { id: 'frozen-food', dept: 'frozen', en: 'Other Frozen Food', ar: 'مجمدات أخرى' },

  // --- baby ---------------------------------------------------------------------------
  { id: 'baby-care', dept: 'baby', en: 'Baby Care', ar: 'العناية بالطفل' },
  { id: 'diapers', dept: 'baby', en: 'Diapers', ar: 'حفاضات' },
  { id: 'baby-feeding', dept: 'baby', en: 'Baby Feeding', ar: 'تغذية الطفل' },
  { id: 'baby-toys', dept: 'baby', en: 'Baby Toys & Accessories', ar: 'ألعاب ومستلزمات الطفل' },

  // --- beauty & health ------------------------------------------------------------------
  { id: 'skin-face', dept: 'beauty-health', en: 'Skin & Face Care', ar: 'العناية بالبشرة' },
  { id: 'hair-care', dept: 'beauty-health', en: 'Hair Care', ar: 'العناية بالشعر' },
  { id: 'bath-body', dept: 'beauty-health', en: 'Bath & Body', ar: 'الاستحمام والجسم' },
  { id: 'dental', dept: 'beauty-health', en: 'Dental Care', ar: 'العناية بالأسنان' },
  { id: 'fragrance', dept: 'beauty-health', en: 'Fragrance', ar: 'عطور' },
  { id: 'shaving', dept: 'beauty-health', en: 'Shaving & Hair Removal', ar: 'حلاقة وإزالة الشعر' },
  { id: 'feminine-care', dept: 'beauty-health', en: 'Feminine Care', ar: 'العناية النسائية' },
  { id: 'health', dept: 'beauty-health', en: 'Health Care', ar: 'العناية الصحية' },
  { id: 'cosmetics', dept: 'beauty-health', en: 'Cosmetics', ar: 'مكياج' },

  // --- household ---------------------------------------------------------------------------
  { id: 'laundry', dept: 'household', en: 'Laundry', ar: 'غسيل الملابس' },
  { id: 'cleaning', dept: 'household', en: 'Cleaning', ar: 'منظفات' },
  { id: 'dishwashing', dept: 'household', en: 'Dishwashing', ar: 'غسيل الصحون' },
  { id: 'tissues', dept: 'household', en: 'Tissues & Toilet Paper', ar: 'مناديل وورق تواليت' },
  { id: 'wraps-foils', dept: 'household', en: 'Foils & Cling Wrap', ar: 'قصدير وأغلفة' },
  { id: 'disposables', dept: 'household', en: 'Disposables', ar: 'أدوات مائدة ورقية' },
  { id: 'home-essentials', dept: 'household', en: 'Household Essentials', ar: 'مستلزمات منزلية' },
  { id: 'pets', dept: 'household', en: 'Pet Supplies', ar: 'مستلزمات الحيوانات' },

  // --- home, electronics & more -----------------------------------------------------------------
  { id: 'appliances', dept: 'home-electronics', en: 'Home Appliances', ar: 'أجهزة منزلية' },
  { id: 'electronics', dept: 'home-electronics', en: 'Electronics', ar: 'إلكترونيات' },
  { id: 'kitchen-dining', dept: 'home-electronics', en: 'Cookware & Dining', ar: 'أواني الطبخ والسفرة' },
  { id: 'home-decor', dept: 'home-electronics', en: 'Home & Decor', ar: 'المفروشات والديكور' },
  { id: 'fashion', dept: 'home-electronics', en: 'Clothing & Footwear', ar: 'ملابس وأحذية' },
  { id: 'toys-stationery', dept: 'home-electronics', en: 'Toys & Stationery', ar: 'ألعاب وقرطاسية' },
  { id: 'outdoors-tools', dept: 'home-electronics', en: 'Outdoors & Tools', ar: 'العدد والحدائق' },
  { id: 'travel', dept: 'home-electronics', en: 'Luggage & Travel', ar: 'حقائب وسفر' },

  // --- the visible landing zone for unmapped provider categories --------------------------------
  { id: OTHER_AISLE, dept: OTHER_DEPT, en: 'Everything Else', ar: 'تشكيلة متنوعة' },
];

export const DEPARTMENT_BY_ID = new Map(DEPARTMENTS.map((d) => [d.id, d]));
export const AISLE_BY_ID = new Map(AISLES.map((a) => [a.id, a]));

// The aisles of one department, in display order.
export function aislesOf(deptId) {
  return AISLES.filter((a) => a.dept === deptId);
}
