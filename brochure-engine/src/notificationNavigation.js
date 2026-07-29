// Notification click destinations must outlive retailer URLs and flyer
// editions. Super Search is the stable destination; an observed Amazon product
// URL is the sole direct-link exception.

export const SUPER_SEARCH_URL =
  'https://tamamoooo-dev.github.io/live-shopping-assistant/';

const clean = (value) =>
  String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

function amazonProductUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const amazonHost =
      host === 'amazon.sa' ||
      host.endsWith('.amazon.sa') ||
      host === 'amazon.com' ||
      host.endsWith('.amazon.com') ||
      host === 'amzn.to';
    return url.protocol === 'https:' && amazonHost ? url.href : null;
  } catch {
    return null;
  }
}

// The registry product a watch is anchored to, or ''. `registry_product_id` is
// the anchor for every watch now; a legacy `kind: 'registry'` row carried the
// same `pr_` id in `product_id`. Keying off `kind` alone would silently drop
// the deep link for every product-anchored watch. Mirrors the frontend's
// notificationNavigation.js — keep in sync.
function anchorProductId(watch = {}) {
  return clean(watch.registryProductId || (watch.kind === 'registry' ? watch.productId : ''));
}

export function notificationDestination(watch = {}, observation = {}) {
  const store = clean(observation.store || watch.lastStore || watch.provider).toLowerCase();
  const observedLink = observation.link || watch.lastLink || watch.link;
  const amazonLink = store === 'amazon' ? amazonProductUrl(observedLink) : null;
  if (amazonLink) return amazonLink;

  const productId = anchorProductId(watch);
  const registry = /^pr_[a-z0-9]+$/i.test(productId);
  const candidates = registry
    ? [watch.label, observation.name, watch.query]
    : [watch.query, watch.label, observation.name];
  const query = clean(candidates.find((value) => clean(value)));
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (registry) params.set('product', productId);
  const suffix = params.toString();
  return `${SUPER_SEARCH_URL}#/search${suffix ? `?${suffix}` : ''}`;
}
