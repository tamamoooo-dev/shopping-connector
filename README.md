# Shopping Connector (Cloudflare Worker)

A **minimal, stateless serverless connector** for the Live Shopping Assistant.
It is a thin **proxy + normalizer**: it fetches a store's data server-side and
returns the **same normalized JSON** the frozen frontend already uses, with
permissive CORS so a static GitHub Pages site can call it directly.

It exists so providers that **cannot** be reached browser-direct (e.g. stores
with no CORS) can still be supported later — without changing the frozen
frontend, Core, or Panda provider. This repo currently ships **Panda only**, as
a proof of concept to validate the architecture.

## Design constraints (by requirement)

- **Stateless** — no database, no auth, no sessions, no cache. Every request
  does a live fetch.
- **Thin** — proxy + normalize, nothing more.
- **Multi-provider** — a provider registry; add one line to support a new store.
- **Same normalized format** — identical object shape to the frozen frontend.

## Architecture

Mirrors the frontend, one layer down:

```
Worker entry (src/index.js)
      ↓   registry { panda }
Connector framework (src/connector.js)   ← provider-agnostic: routing, CORS, dispatch
      ↓
Provider (src/providers/panda.js)        ← the only store-specific code
      ↓
Strategies (declared best-first)         ← products-v3, then suggestions-v3
      ↓
Normalized Result                        ← same 10-key object as the frontend
```

The framework knows nothing about any store. A provider is exactly the same
contract as on the frontend:

```js
{ id, label, strategies: [ { name, run(query) -> Promise<NormalizedResult[]> } ] }
```

## API

```
GET /                    -> health + provider list
GET /search?provider=<id>&q=<query>
```

Response envelope (wraps the unchanged normalized objects):

```json
{
  "provider": "panda",
  "query": "milk",
  "strategy": "products-v3",
  "count": 30,
  "results": [
    {
      "id": 44968,
      "name": "Nada Milk Full Fat 12x1l",
      "image": "https://images.todoorstep.com/product/786470/Ar.jpg?t=1744675200",
      "price": 44.99,
      "oldPrice": 72,
      "currency": "SAR",
      "link": "https://panda.sa/en/p/44968.nada-milk-full-fat-12x1l",
      "size": "1 L",
      "brand": "Nada",
      "discountLabel": "38% Off"
    }
  ]
}
```

`results[*]` is byte-for-byte the same shape the frozen frontend produces:
`{ id, name, image, price, oldPrice, currency, link, size, brand, discountLabel }`.

Errors: `400` (missing `provider`/`q`), `404` (unknown provider / route), `502`
(all strategies failed, with a `failures` list). Every response carries CORS
headers; `OPTIONS` preflight returns `204`.

## Statelessness note

The frontend remembers the last successful strategy in `localStorage`. The
connector cannot keep state, so it simply tries strategies in their declared
order on each request. Providers list their most reliable strategy first, so the
ranking is preserved with zero stored state.

## Run locally (no install needed)

Cloudflare Workers run on Web APIs that are global in Node 18+, so the Worker
runs as-is under Node via a tiny adapter:

```bash
node dev.mjs                 # -> http://localhost:8787
# then:
curl "http://localhost:8787/search?provider=panda&q=milk"
```

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler deploy          # -> https://shopping-connector.<subdomain>.workers.dev
```

No bindings, secrets, or services are required — it is pure compute.

## Connecting the frontend (NOT done here)

The frontend is frozen, so this repo does **not** touch it. When you choose to,
a future frontend provider would call:

```
https://<your-worker-url>/search?provider=panda&q=<query>
```

and use `json.results` directly — no other change, because the normalized shape
is identical. (For Panda specifically the frontend already works browser-direct;
the connector matters for stores that can't.)

## Providers

| Provider | Method | Durability |
|---|---|---|
| `panda` | Public JSON API (`api.panda.sa`) | **Stable.** Clean contract, used in production. |
| `amazon` | Search-HTML parsing (`amazon.sa/s`) | **Best-effort only.** See caveat below. |
| `tamimi` | Public ZopSmart JSON API (`shop.tamimimarkets.com/api/layout/search?q=`) | **Stable (experimental).** Clean JSON, no auth, EN/AR. |
| `danube` | Public Spree JSON API (`danube.sa/api/products.json?q[name_cont]=`) | **Stable (experimental).** Clean JSON, no auth, EN/AR, sale prices. |

### Amazon caveat (read before relying on it)

Amazon exposes no credential-free product API, so the `amazon` provider parses
the public search-results HTML. Verified live through the deployed Worker it
returns ~48–60 normalized products with correct titles, prices, images and
links. **But this is not durable:**

- Amazon serves an **anti-bot interstitial challenge** (`bm-verify`, a JS
  challenge posting to `/_sec/verify`) to a meaningful share of requests. The
  provider detects it and fails cleanly rather than guessing — but it means
  results are **not guaranteed** on any given call.
- Solving that challenge would require executing JavaScript (browser
  automation), which is out of scope by design.
- HTML scraping breaks whenever Amazon changes its markup, and scraping is
  against Amazon's Conditions of Use.

The **maintainable** long-term path is the official **Product Advertising API
(PA-API 5.0)** — a stable JSON contract called server-side with SigV4 signing.
It is **already implemented** as the `pa-api` strategy and is tried **before**
`search-html`; when unconfigured it skips instantly, so the scraper stays the
active path until you add keys. To activate it (Amazon Associate account with
PA-API access required), set three Worker secrets and redeploy — **no code
change**:

```bash
npx wrangler secret put PAAPI_ACCESS_KEY
npx wrangler secret put PAAPI_SECRET_KEY
npx wrangler secret put PAAPI_PARTNER_TAG
# optional overrides (defaults shown): PAAPI_HOST=webservices.amazon.sa,
# PAAPI_REGION=eu-west-1, PAAPI_MARKETPLACE=www.amazon.sa
```

Once set, `pa-api` runs first and returns durable results; `search-html` remains
only as a fallback.

## Adding a provider

1. Create `src/providers/<store>.js` exporting `{ id, label, strategies }`.
2. Import it in `src/index.js` and add it to the registry.

The framework (`src/connector.js`) and the Panda provider never change.
