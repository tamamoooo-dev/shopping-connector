// minimartCategory.js — the group of a Mini marts offer (2026-11-15). The
// owner: "under each mini market add for main categories frozen food .. food
// ( all food except frozen and snacks ) drinks , and snacks".
//
// The PC reader asks Haiku once per offer, with the offer's picture and the
// name read from it (GET/POST /minimarts/reader/categories); the app groups a
// shop's cards by it. Word lists were measured first and not used: on the 391
// live offers of 2026-11-15 the Browse classifier (knowledge/classification.js)
// left 90 unplaced, put Ruffles chips in vegetables and frozen nuggets and
// spring rolls in fresh chicken (their names don't say مجمد), and 14 offers
// have no name at all.
//
// Measured on those 391 (benchmarks/minimart-category-2026-11-15): v1, 25 a
// call, put chilled chicken and Q's fresh meat in frozen; v2 fixed that but a
// few answers slid onto the next picture (pickles "drinks"); v3 (this one)
// names the product it sees in each answer, 15 a call: every frozen offer a
// freezer product, every offer answered, 27 calls.
//
//   frozen   sold frozen, from the freezer (ice cream too)
//   food     every other food
//   drinks   drinks, liquid milk and laban included
//   snacks   chips, chocolate, sweets, biscuits, nuts …
//   other    not food or drink (cleaning, tissues, phones …): the owner named
//            four food groups; these stay under "All" and "Other"
//   unknown  the picture and name don't show the product
export const CATEGORIES = ['frozen', 'food', 'drinks', 'snacks', 'other', 'unknown'];

export const CATEGORY_PROMPT = `Each picture above is the picture of one offer from a shop's Snapchat story, labelled "Picture 1", "Picture 2", and so on. The label also gives the product the offer was read as (it may be empty or wrong; the picture decides). Some pictures show several products: the offer is the product the label names.

Put each offer's product in ONE group:
- "frozen": kept in the freezer. The word مجمد, مجمدة or Frozen in the label always means frozen. Also: ice cream; frozen fries, hash browns, vegetables and fruit; nuggets, burgers, strips, breaded or coated chicken and shrimp, samosa, spring rolls, corn dogs, puff pastry and frozen dough, frozen pizza (Dr. Oetker pizzas are frozen); and chicken, meat or fish whose pack, name or picture shows it is frozen (the word مجمد or Frozen, frost or ice on it, a frozen chicken brand pack such as Sadia, Seara, Doux or Americana).
- "food": every other food. Fresh or chilled chicken, meat and fish are food: the word مبرد, طازج, Chilled or Fresh, a butcher's cut, meat on a tray, a whole carcass, smoked or cold-cut slices. Also fruit and vegetables, cheese of every kind (slices too), yoghurt, labneh, cream, butter, eggs, bread, tortillas and taco shells, rice, pasta, noodles, flour, sugar, salt, oil, ghee, canned food, olives and pickles, sauces, spreads, honey, jam, dates, spices, breakfast cereals, powdered and condensed milk, baby formula and baby cereal.
- "drinks": water, juice, soft drinks, energy drinks, malt drinks, liquid milk, laban and flavoured milk, tea, coffee, drink powders and syrups.
- "snacks": chips, chocolate, sweets and candy, gum, biscuits, cookies, wafers, packaged cakes, croissants and rolls sold as a snack, popcorn, nuts and seeds, crackers, snack bars.
- "other": not food or drink: cleaning, laundry, dishwashing, tissues, plates, cups and other disposables, personal care, diapers, phones (an iPhone) and electronics, kitchenware.
- "unknown": only when neither the picture nor the label shows any product.

Look at each picture on its own. Answer with JSON only, one entry per picture in picture order, giving the product you see in a few words and its group:
{"offers":[{"picture":1,"product":"Lay's chips","group":"snacks"},{"picture":2,"product":"chilled whole chicken","group":"food"}]}`;

// A stored or posted group, or null.
export function categoryOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return CATEGORIES.includes(v) ? v : null;
}

// A reply -> Map picture number -> group (unknown groups left out).
export function parseCategories(raw) {
  const found = new Map();
  let parsed = null;
  try {
    parsed = JSON.parse(/\{[\s\S]*\}/.exec(String(raw ?? ''))[0]);
  } catch {
    return found;
  }
  const list = Array.isArray(parsed?.offers) ? parsed.offers : Array.isArray(parsed?.pictures) ? parsed.pictures : [];
  for (const entry of list) {
    const n = Number(entry?.picture);
    const group = categoryOf(entry?.group ?? entry?.category);
    if (Number.isInteger(n) && n > 0 && group && !found.has(n)) found.set(n, group);
  }
  return found;
}

// The label under each picture: the name, brand and size the offer was read as.
export function categoryLabel(n, offer) {
  const parts = [offer?.name, offer?.brand, offer?.size].map((v) => String(v ?? '').trim()).filter(Boolean);
  return `Picture ${n} — the offer: ${parts.join(' · ') || '(no name)'}`;
}
