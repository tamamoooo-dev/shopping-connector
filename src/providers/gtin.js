// providers/gtin.js — product barcodes (GS1 GTIN / EAN / UPC) as one
// comparable key, so the same pack is recognised across stores.
//
// Stores spell the same barcode differently:
//   • Danube / Tamimi / Ninja: the full EAN-13 with its check digit
//     (6281014620208);
//   • Panda: the first 12 digits followed by a 0 instead of the check digit
//     (6281014620200) — verified 2026-11-03 on every Panda code sampled.
// The key is therefore the 12-digit BODY of the EAN-13 (the check digit is a
// function of it): UPC-A gains its leading 0, a GTIN-14 with indicator 0 drops
// it, EAN-8 keeps its own space.
//
// Store-internal codes (GS1 "restricted circulation": prefixes 02, 04, 2x) are
// not global identities and are dropped. Codes read out of free text (image
// file names) must also pass the check digit and sit in an assigned range, so
// a timestamp in a URL is never taken for a barcode.

function checkDigit(body) {
  let sum = 0;
  const n = body.length;
  for (let i = 0; i < n; i++) sum += Number(body[n - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

// One raw code -> its key, or null. `trusted` = a store's barcode FIELD
// (Panda's zeroed check digit is accepted there); untrusted = scraped text.
export function gtinKey(raw, { trusted = true } = {}) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 8) {
    if (checkDigit(digits.slice(0, 7)) !== Number(digits[7])) return null;
    return `e8:${digits.slice(0, 7)}`;
  }
  let ean13 = null;
  if (digits.length === 12) ean13 = `0${digits}`;
  else if (digits.length === 13) ean13 = digits;
  else if (digits.length === 14) {
    if (digits[0] !== '0') {
      // A case/outer-pack GTIN-14 (indicator 1-8): its own identity.
      return checkDigit(digits.slice(0, 13)) === Number(digits[13]) ? `g14:${digits.slice(0, 13)}` : null;
    }
    ean13 = digits.slice(1);
  } else return null;
  const body = ean13.slice(0, 12);
  if (/^0{12}$/.test(body)) return null;
  // Restricted circulation (in-store / variable-weight) and coupon ranges.
  if (/^(02|04|05|2)/.test(ean13)) return null;
  const valid = checkDigit(body) === Number(ean13[12]);
  if (!valid) {
    if (!(trusted && ean13[12] === '0')) return null;
  }
  // Free text must also be in an assigned GS1 range (140-199 is unassigned;
  // millisecond timestamps live there).
  if (!trusted && /^1[4-9]/.test(ean13)) return null;
  return body;
}

export function gtinKeys(values, options) {
  const out = [];
  for (const v of values || []) {
    const key = gtinKey(v, options);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

// Barcodes printed in image file names ("…/6281014620208.01.jpg",
// "…/Banmaly/6281057007332_2.png"): a whole 8/12/13/14-digit run that starts
// the file name.
export function gtinsFromUrls(urls) {
  const found = [];
  for (const url of urls || []) {
    const file = String(url || '').split('?')[0].split('/').pop() || '';
    const m = /^(\d{8}|\d{12,14})(?=[._-]|$)/.exec(file);
    if (!m) continue;
    const code = m[1];
    // Danube also names photos by the 12-digit EAN-13 BODY, without its
    // check digit (…/628101480047.01.jpg for 6281014800471). A 12-digit run
    // starting 3-9 is read as that body; when it also happens to pass the
    // UPC-A check (1 in 10 by chance — 628105700726 is Nadec's 125 ml carton,
    // not an American UPC) both readings are kept. A key only ever matches
    // the same key, so the spare reading costs nothing.
    if (code.length === 12 && /^[3-9]/.test(code)) {
      found.push(code + String(checkDigit(code)));
      if (gtinKey(code, { trusted: false }) != null) found.push(code);
    } else {
      found.push(code);
    }
  }
  return gtinKeys(found, { trusted: false });
}
