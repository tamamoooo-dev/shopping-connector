import { decodeProfile } from './registry/model.js';

function dimension(product, name) {
  const prefix = `${name}:`;
  return Object.entries(decodeProfile(product?.token_profile || '{}'))
    .filter(([token]) => token.startsWith(prefix) && token.length > prefix.length)
    .sort((a, b) => {
      const count = Number(b[1]?.count || 0) - Number(a[1]?.count || 0);
      return count || a[0].localeCompare(b[0]);
    })
    .map(([token]) => token.slice(prefix.length).replace(/[_|]+/g, ' ').trim())
    .find(Boolean) || null;
}

export function registryProductSearchIdentity(product) {
  if (!product) return null;
  const identity = {
    family: product.family || null,
    category: product.category || null,
    cut: dimension(product, 'cut'),
    processing: dimension(product, 'processing'),
    variety: dimension(product, 'variety'),
    brand: product.brand_text || product.brand_slug || null,
  };
  return Object.values(identity).some(Boolean) ? identity : null;
}

export async function watchesWithSearchIdentity(registryStore, watches = []) {
  if (!registryStore?.getProducts || !Array.isArray(watches) || !watches.length) return watches;
  const ids = [...new Set(watches
    .filter((watch) => !watch.sourceSnapshot && watch.registryProductId)
    .map((watch) => watch.registryProductId))];
  if (!ids.length) return watches;
  const products = new Map(
    (await registryStore.getProducts(ids)).map((product) => [product.id, product]),
  );
  return watches.map((watch) => {
    const searchIdentity = registryProductSearchIdentity(products.get(watch.registryProductId));
    return searchIdentity ? { ...watch, searchIdentity } : watch;
  });
}
