// connector.js — the Connector framework (provider-agnostic).
//
// This is the server-side mirror of the frontend Core. It knows NOTHING about
// any specific store. It:
//   1. handles CORS (so a static GitHub Pages site can call it),
//   2. routes requests,
//   3. dispatches to a registered provider,
//   4. runs that provider's strategies until one returns results,
//   5. wraps the result in a small envelope around the SAME normalized objects
//      the frozen frontend already uses.
//
// It is intentionally STATELESS: no database, no auth, no sessions, no cache.
// Every request does a live fetch. It is a thin proxy + normalizer.
//
// Provider contract (identical to the frontend's):
//   { id, label, strategies: [ { name, run(query) -> Promise<NormalizedResult[]> } ] }
//
// NormalizedResult (identical to the frozen Panda contract):
//   { id, name, image, price, oldPrice, currency, link, size, brand, discountLabel }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });
}

// Stateless adaptive strategy runner.
//
// The frontend remembers the last-good strategy in localStorage. The connector
// must stay stateless, so instead it simply tries strategies in their declared
// order on every request. Providers declare their best/most-reliable strategy
// first, so ranking is preserved without any stored state.
async function runProvider(provider, query) {
  const failures = [];
  for (const strategy of provider.strategies) {
    try {
      const results = await strategy.run(query);
      if (results && results.length) {
        return { strategy: strategy.name, results };
      }
      failures.push(`${strategy.name}: no results`);
    } catch (err) {
      failures.push(`${strategy.name}: ${err.message}`);
    }
  }
  const error = new Error('No strategy returned results.');
  error.failures = failures;
  throw error;
}

// Main entry. `registry` is a plain object: { [providerId]: provider }.
export async function handleRequest(request, registry) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);

  // Health / discovery
  if (url.pathname === '/' || url.pathname === '/health') {
    return json({
      service: 'shopping-connector',
      status: 'ok',
      stateless: true,
      providers: Object.keys(registry),
      usage: '/search?provider=<id>&q=<query>',
    });
  }

  if (url.pathname !== '/search') {
    return json({ error: 'Not found' }, 404);
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const providerId = (url.searchParams.get('provider') || '').trim();
  const query = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();

  if (!providerId) return json({ error: "Missing required parameter 'provider'." }, 400);
  if (!query) return json({ error: "Missing required parameter 'q'." }, 400);

  const provider = registry[providerId];
  if (!provider) {
    return json(
      { error: `Unknown provider '${providerId}'.`, providers: Object.keys(registry) },
      404,
    );
  }

  try {
    const { strategy, results } = await runProvider(provider, query);
    // Envelope wraps the SAME normalized result objects the frontend expects.
    return json({ provider: provider.id, query, strategy, count: results.length, results });
  } catch (err) {
    return json(
      { provider: providerId, query, error: err.message, failures: err.failures || [] },
      502,
    );
  }
}
