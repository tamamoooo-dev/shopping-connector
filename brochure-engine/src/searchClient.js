// searchClient.js — thin clients for the search connector (the live-price
// source). Used by Price Monitoring (monitor.js) to evaluate watches across
// the online stores. Production reaches the deployed shopping-connector Worker
// through a CONNECTOR service binding (same account, Free plan, $0).

export function createServiceBindingSearchClient({
  connector,
  origin = 'https://shopping-connector.internal',
}) {
  if (!connector || typeof connector.fetch !== 'function') {
    throw new Error('search client: a CONNECTOR service binding (env.CONNECTOR) is required');
  }
  return {
    async search(provider, query) {
      const res = await connector.fetch(
        `${origin}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) throw new Error(`search ${provider} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.results || [];
    },
  };
}

// Dev/optional: hit a connector base URL over HTTP (e.g. the local connector or
// the production URL). Same interface as the service-binding client.
export function createHttpSearchClient(base) {
  const root = base.replace(/\/$/, '');
  return {
    async search(provider, query) {
      const res = await fetch(
        `${root}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) throw new Error(`search ${provider} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.results || [];
    },
  };
}
