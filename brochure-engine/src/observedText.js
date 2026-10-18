// Serialization sentinels are missing observations, never product names.
export function observedText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && !/^(?:null|undefined|none|n\/a)$/i.test(text) ? text : null;
}

// SQL twin for nullable stored names. Callers supply fixed table aliases.
export function observedNameSql(alias) {
  // Match String.trim(), including NBSP/BOM and Unicode space separators.
  const whitespace = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
  const usable = field => `(NULLIF(TRIM(${alias}.${field}, ${whitespace}), '') IS NOT NULL AND LOWER(TRIM(${alias}.${field}, ${whitespace})) NOT IN ('null','undefined','none','n/a'))`;
  return `(${usable('name')} OR ${usable('name_ar')})`;
}
