// searchClient.js — thin clients for the search connector (the live-price
// source). Used by Price Monitoring (monitor.js) to evaluate watches across
// the online stores. Production reaches the deployed shopping-connector Worker
// through a CONNECTOR service binding (same account, Free plan, $0).

// `wide`: the store searches every way it knows at once (Price Monitoring's
// index must reach a listing even when the first wording finds something else).
function searchUrl(root, provider, query, limit, { wide = false } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 50, 50));
  return `${root}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}&limit=${n}${wide ? '&wide=1' : ''}`;
}

export function createServiceBindingSearchClient({
  connector,
  origin = 'https://shopping-connector.internal',
}) {
  if (!connector || typeof connector.fetch !== 'function') {
    throw new Error('search client: a CONNECTOR service binding (env.CONNECTOR) is required');
  }
  return {
    async search(provider, query, limit = 50, options = {}) {
      const res = await connector.fetch(searchUrl(origin, provider, query, limit, options));
      if (!res.ok) throw new Error(`search ${provider} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.results || [];
    },
    async lookupExact(provider, productId) {
      const res = await connector.fetch(
        `${origin}/product?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(productId)}`,
      );
      if (!res.ok) throw new Error(`exact product ${provider}:${productId} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.product || null;
    },
  };
}

// Dev/optional: hit a connector base URL over HTTP (e.g. the local connector or
// the production URL). Same interface as the service-binding client.
export function createHttpSearchClient(base) {
  const root = base.replace(/\/$/, '');
  return {
    async search(provider, query, limit = 50, options = {}) {
      const res = await fetch(searchUrl(root, provider, query, limit, options));
      if (!res.ok) throw new Error(`search ${provider} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.results || [];
    },
    async lookupExact(provider, productId) {
      const res = await fetch(
        `${root}/product?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(productId)}`,
      );
      if (!res.ok) throw new Error(`exact product ${provider}:${productId} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.product || null;
    },
  };
}
