// gtin.test.mjs — one barcode key for the same pack in every store. The codes
// are real ones read from the stores' search APIs on 2026-11-03. Run:
//   node src/providers/gtin.test.mjs

import { gtinKey, gtinKeys, gtinsFromUrls } from './gtin.js';
import { normalizeProduct as panda } from './panda.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};

// Goody Tenderina in sunflower oil 80 g: Danube/Tamimi print the full EAN-13,
// Panda the 12-digit body + 0.
ok(gtinKey('6281014620208') === '628101462020', 'a valid EAN-13 keys to its 12-digit body');
ok(gtinKey('6281014620200') === '628101462020', "Panda's zeroed check digit keys to the same body");
ok(gtinKey('6281014620200', { trusted: false }) === null, '… but only from a barcode field, never from free text');
ok(gtinKey('6281014620205') === null, 'a wrong non-zero check digit is not a barcode');
ok(gtinKey(' 6281057500000') === '628105750000', 'whitespace is ignored');
ok(gtinKey('2800001855979') === null, 'in-store (restricted 2x) codes are dropped');
ok(gtinKey('2810') === null, 'short store codes are dropped');
ok(gtinKey('036000291452') === '003600029145', 'UPC-A becomes an EAN-13 body');
ok(gtinKey('00036000291452') === '003600029145', 'GTIN-14 with indicator 0 is the same item');
ok(gtinKey('10036000291459') === 'g14:1003600029145', 'a case GTIN-14 keeps its own identity');
ok(gtinKey('96385074') === 'e8:9638507', 'EAN-8 keeps its own space');
ok(gtinKeys(['6281014800471', ' 6281014620215', '6281014800471']).length === 2, 'keys are de-duplicated');

ok(gtinsFromUrls([
  'https://d1c124wpoew66.cloudfront.net/spree/images/attachments/000/116/260/large/6281014620208.01.jpg?1791731086',
])[0] === '628101462020', 'Danube photo file name carries the barcode');
ok(gtinsFromUrls(['https://img.ananinja.com/media/ninja-catalog-42/Banmaly/B84/6281057007332_2.png'])[0] === '628105700733',
  'Ninja photo file name carries the barcode');
ok(gtinsFromUrls(['https://cdn.example/1791731086123.jpg']).length === 0, 'a millisecond timestamp is not a barcode');
ok(gtinsFromUrls(['https://d1c124wpoew66.cloudfront.net/x/large/628101480047.01.jpg'])[0] === '628101480047',
  "Danube's 12-digit body (no check digit) keys like the full code");
ok(gtinsFromUrls(['https://cdn.example/036000291452.jpg'])[0] === '003600029145', 'a valid UPC-A stays a UPC-A');
// Nadec long-life 125 ml at Danube: "628105700726" is the EAN-13 body of
// 6281057007264 and ALSO passes the UPC-A check by chance.
const nadec = gtinsFromUrls(['https://d1c124wpoew66.cloudfront.net/x/large/628105700726.01.jpg']);
ok(nadec[0] === '628105700726', 'a Saudi body that also passes the UPC-A check is read as the EAN-13 body first');
ok(nadec.length === 2 && nadec.includes('062810570072'), '… and keeps the UPC-A reading as a spare key');
ok(gtinsFromUrls(['https://cdn.example/uuid-531a5d39_321.webp']).length === 0, 'no digits, no barcode');

const p = panda({
  id: 12469,
  name: 'قودي تونة تندرينا في زيت دوار الشمس، 80غ',
  brand: { name: 'قودي' },
  varieties: [{ id: 21028, price: '3.66', undiscounted_price: '6.25', size: '80', unit: 'جرام', barcode: '6281014620200' }],
}, 'ar');
ok(p.barcodes.length === 1 && p.barcodes[0] === '628101462020', 'Panda results carry the barcode key');

console.log(`✅ gtin.test: ${passed} passed`);
