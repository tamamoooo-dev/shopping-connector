// Use a separate Vision count only when the retailer text corroborates the
// same bounded, explicit piece count. This is evidence selection, not a new
// package parser; all arithmetic stays in comparableQuantity/packageSize.
export function corroboratedPackCount(value, text) {
  if (typeof value !== 'string') return null;
  const compact = value.toUpperCase().replaceAll(' ', '');
  if (!/^[2-9]PCS?$/.test(compact)) return null;
  // A package may state its internal piece count beside its TOTAL net weight
  // (the reviewed Herfy 6-piece / 550g box). Require the retailer's bilingual
  // sale-count badge wording, rather than a package-only "pieces/قطعة" label.
  if (!/حبات|حبة|حبه|حبتين/.test(String(text || ''))) return null;
  const count = compact[0];
  return new RegExp(`[^0-9٠-٩۰-۹]${count} ?pcs?[^a-z]`, 'i').test(` ${text || ''} `)
    ? `${count} PCS` : null;
}

// The exact SQLite twin keeps Browse's projection small: one nullable scalar,
// without carrying the full retailer OCR text into its 10,000-row scan.
export function corroboratedPackCountSql(e = 'e', o = 'o') {
  const value = `REPLACE(UPPER(TRIM(json_extract(${e}.extraction_json, '$.quantity'))), ' ', '')`;
  const count = `substr(${value}, 1, 1)`;
  const text = `(' ' || LOWER(COALESCE(${o}.search_text, '')) || ' ')`;
  const evidence = [' pc', ' pcs', 'pc', 'pcs'].map(word =>
    `${text} GLOB ('*[^0-9٠-٩۰-۹]' || ${count} || '${word}[^a-z]*')`).join(' OR ');
  return `CASE WHEN json_valid(${e}.extraction_json) THEN CASE WHEN
    (${value} GLOB '[2-9]PC' OR ${value} GLOB '[2-9]PCS') AND (${evidence})
    AND (${['حبات','حبة','حبه','حبتين'].map(word=>`${text} LIKE '%${word}%'`).join(' OR ')})
    THEN ${count} || ' PCS' END END`;
}
