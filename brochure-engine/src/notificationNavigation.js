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

export function notificationDestination(watch = {}, observation = {}) {
  const store = clean(observation.store || watch.lastStore || watch.provider).toLowerCase();
  const observedLink = observation.link || watch.lastLink || watch.link;
  const amazonLink = store === 'amazon' ? amazonProductUrl(observedLink) : null;
  if (amazonLink) return amazonLink;

  const productId = clean(watch.productId);
  const registry = watch.kind === 'registry' && /^pr_[a-z0-9]+$/i.test(productId);
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
