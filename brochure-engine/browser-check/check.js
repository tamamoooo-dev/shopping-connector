// browser-check/check.js — Value Watch "check with my browser" (PRICE-WATCH.md A2).
//
// Run ONLY when the owner asks, by Claude in Chrome (javascript_tool), in a tab
// of the store being checked:
//   Lulu       https://gcc.luluhypermarket.com/ar-sa/
//   Carrefour  https://www.carrefourksa.com/mafsau/ar/
// Paste this whole file, then:
//   lsaCheck({ store: 'lulu' | 'carrefour', profile: '<profile id>', ids: ['<watch id>'] })
//   await lsaCheckResult()          // repeat until it returns { done: true, … }
//
// It reads the same search data the store's own pages read (same origin, the
// owner's own session), one request per search phrase and language at a
// polite pace, and hands the listings to the engine, which judges them like
// every other store. A challenge or block page STOPS the check: it is never
// retried around, and the owner is told.
//
// Lulu's page policy lets Lulu pages connect only to Lulu's own and partner
// hosts, so on Lulu the script adds a "Send to Price Watch" button: its click
// opens the engine's hand-off window (watchObserve.js relayPage), and every
// request to the engine goes through that window. Carrefour posts directly.

(() => {
  const ENGINE = 'https://brochure-engine.tamamoooo.workers.dev';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hasArabic = (s) => /[؀-ۿ]/.test(s || '');
  const hasLatin = (s) => /[a-z]/i.test(s || '');
  const enc = encodeURIComponent;

  class Stop extends Error {}
  const looksBlocked = (text) => /attention required|just a moment|cf-chl|captcha|access denied/i.test(text || '');

  // --- store readers: one search phrase -> listings ---------------------------------

  async function readLulu(query) {
    const res = await fetch(`/ar-sa/list?search_text=${enc(query)}&format=json&page_size=50`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('json')) throw new Stop(`Lulu answered HTTP ${res.status} (${type.split(';')[0] || 'no type'})`);
    const body = await res.json();
    return (Array.isArray(body.products) ? body.products : []).map((p) => {
      const a = p.attributes || {};
      const names = [p.name, a.l_name, a.product_name].filter((s) => typeof s === 'string' && s.trim());
      const image = Array.isArray(p.productimage_set) && p.productimage_set[0] ? p.productimage_set[0].image : null;
      return {
        id: String(p.pk),
        name: names.find(hasArabic) || names[0] || '',
        nameEn: names.find((s) => hasLatin(s) && !hasArabic(s)) || null,
        brand: typeof a.brand === 'string' ? a.brand : null,
        size: typeof a.content === 'string' ? a.content : null,
        price: p.price,
        oldPrice: p.retail_price,
        currency: String(p.currency_type || 'sar').toUpperCase(),
        inStock: typeof p.in_stock === 'boolean' ? p.in_stock && !(Number(p.stock) <= 0) : null,
        barcodes: [...String(a.ean || '').split(','), a.main_ean].map((s) => String(s || '').trim()).filter(Boolean),
        link: p.absolute_url ? `https://gcc.luluhypermarket.com/ar-sa${p.absolute_url}` : null,
        image,
        query,
      };
    });
  }

  // Carrefour's search page carries its products in the Next.js payload
  // (self.__next_f); each product card is one object with a productId.
  function carrefourProducts(html) {
    const parts = [];
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let m;
    while ((m = re.exec(html))) { try { parts.push(JSON.parse(m[1])); } catch { /* not a string chunk */ } }
    const text = parts.join('');
    const found = new Map();
    let from = 0;
    for (;;) {
      const k = text.indexOf('"productId":', from);
      if (k < 0) break;
      from = k + 1;
      let depth = 0;
      let start = -1;
      for (let i = k; i >= 0; i -= 1) {
        const c = text[i];
        if (c === '}') depth += 1;
        else if (c === '{') { if (depth === 0) { start = i; break; } depth -= 1; }
      }
      if (start < 0) continue;
      let d = 0;
      let end = -1;
      let inString = false;
      for (let i = start; i < text.length; i += 1) {
        const c = text[i];
        if (inString) { if (c === '\\') i += 1; else if (c === '"') inString = false; continue; }
        if (c === '"') inString = true;
        else if (c === '{') d += 1;
        else if (c === '}') { d -= 1; if (d === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      try {
        const o = JSON.parse(text.slice(start, end + 1));
        if (o.productId != null && o.productName && o.sellingPrice != null && !found.has(String(o.productId))) found.set(String(o.productId), o);
      } catch { /* a fragment, not a card */ }
    }
    return { cards: [...found.values()], payload: parts.length };
  }

  async function carrefourPage(lang, query) {
    const res = await fetch(`/mafsau/${lang}/search?keyword=${enc(query)}`, { credentials: 'include' });
    const html = await res.text();
    if (!res.ok || looksBlocked(html.slice(0, 4000))) throw new Stop(`Carrefour answered HTTP ${res.status}${looksBlocked(html.slice(0, 4000)) ? ' with a challenge page' : ''}`);
    const { cards, payload } = carrefourProducts(html);
    if (!payload) throw new Stop('Carrefour sent a page without its product data (a challenge or a new page format)');
    return cards;
  }

  async function readCarrefour(query) {
    const ar = await carrefourPage('ar', query);
    await sleep(500);
    const en = await carrefourPage('en', query);
    const english = new Map(en.map((o) => [String(o.productId), o]));
    const byId = new Map();
    for (const o of [...ar, ...en]) {
      const id = String(o.productId);
      if (byId.has(id) || o.isSoldByWeight) continue; // a per-kg price has no pack size
      const arName = ar.find((x) => String(x.productId) === id)?.productName || null;
      const enName = english.get(id)?.productName || null;
      byId.set(id, {
        id,
        name: arName || enName,
        nameEn: enName && enName !== arName ? enName : null,
        brand: null,
        size: null,
        price: o.sellingPrice,
        oldPrice: o.markedPrice,
        currency: String(o.currency || 'SAR').toUpperCase(),
        inStock: o.stock?.stockLevelStatus ? o.stock.stockLevelStatus !== 'outOfStock' : null,
        barcodes: [],
        link: o.productUrl ? `https://www.carrefourksa.com${String(o.productUrl).replace('/mafsau/en/', '/mafsau/ar/')}` : null,
        image: o.imageUrl || null,
        query,
      });
    }
    return [...byId.values()];
  }

  const STORES = {
    lulu: { host: 'gcc.luluhypermarket.com', read: readLulu, relay: true, pauseMs: 400 },
    carrefour: { host: 'www.carrefourksa.com', read: readCarrefour, relay: false, pauseMs: 700 },
  };

  // --- the way to the engine ------------------------------------------------------

  function directTransport(engine) {
    return {
      async request(method, path, body) {
        const res = await fetch(`${engine}${path}`, method === 'POST'
          ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {});
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      close() {},
    };
  }

  // Opened from the button's click handler, synchronously: the click is what
  // lets the page open a window.
  function relayTransport(engine) {
    const origin = new URL(engine).origin;
    const win = window.open(`${engine}/watches/observe/relay`, 'lsa-relay', 'popup,width=440,height=260');
    if (!win) throw new Stop('the browser blocked the hand-off window');
    let seq = 0;
    const waiting = new Map();
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const onMessage = (event) => {
      if (event.origin !== origin || event.source !== win) return;
      const msg = event.data || {};
      if (msg.type === 'lsa-relay-ready') markReady();
      else if (msg.type === 'lsa-relay-reply' && waiting.has(msg.seq)) {
        waiting.get(msg.seq)(msg.out);
        waiting.delete(msg.seq);
      }
    };
    addEventListener('message', onMessage);
    return {
      async request(method, path, body, label) {
        const loaded = await Promise.race([ready.then(() => true), sleep(20000).then(() => false)]);
        if (!loaded) throw new Stop('the hand-off window did not load');
        seq += 1;
        const id = seq;
        return new Promise((resolve, reject) => {
          waiting.set(id, resolve);
          win.postMessage({ type: 'lsa-relay-request', seq: id, method, path, body, label }, origin);
          setTimeout(() => {
            if (!waiting.has(id)) return;
            waiting.delete(id);
            reject(new Stop('the hand-off window did not answer within 3 minutes'));
          }, 180000);
        });
      },
      close() {
        removeEventListener('message', onMessage);
        try { win.close(); } catch { /* already closed */ }
      },
    };
  }

  // --- the check --------------------------------------------------------------------

  async function run(state, storeId, transport, { profile, ids }) {
    const store = STORES[storeId];
    state.progress = 'reading the watch plan';
    const plan = await transport.request('GET', `/watches/observe?profile=${enc(profile)}`);
    if (plan.status !== 200) throw new Stop(`engine plan: HTTP ${plan.status} ${plan.body?.error || ''}`.trim());
    const watches = plan.body.watches.filter((w) => !ids || ids.includes(w.id));
    if (!watches.length) throw new Stop('no matching Value Watch on this profile');
    const cache = new Map();
    const report = [];
    for (const [n, watch] of watches.entries()) {
      const byId = new Map();
      let answered = 0;
      for (const query of watch.queries) {
        state.progress = `watch ${n + 1}/${watches.length} (${watch.label}): reading "${query}"`;
        if (!cache.has(query)) {
          await sleep(store.pauseMs);
          try {
            cache.set(query, await store.read(query));
          } catch (err) {
            if (err instanceof Stop) throw err;
            cache.set(query, null); // a broken answer for this phrase: the check is incomplete
          }
        }
        const listings = cache.get(query);
        if (!listings) continue;
        answered += 1;
        for (const l of listings) if (!byId.has(l.id)) byId.set(l.id, l);
      }
      const body = {
        store: storeId,
        complete: answered === watch.queries.length,
        listings: [...byId.values()].slice(0, plan.body.max || 300),
      };
      const path = `/watches/observe?profile=${enc(profile)}&id=${enc(watch.id)}`;
      let out = null;
      // While the checker still owes answers (its per-check budget), the same
      // listings are posted again, at most twice, so every one gets judged.
      for (let pass = 0; pass < 3; pass += 1) {
        state.progress = `watch ${n + 1}/${watches.length} (${watch.label}): checking ${body.listings.length} listings`;
        out = await transport.request('POST', path, body, watch.label);
        const o = out.body?.observed;
        if (out.status !== 200 || !o || !(o.waiting > 0) || !(o.judged > 0)) break;
      }
      const r = out.body || {};
      const best = r.value?.best;
      report.push({
        id: watch.id,
        label: watch.label,
        sent: body.listings.length,
        complete: body.complete,
        error: out.status === 200 ? null : (r.error || `HTTP ${out.status}`),
        status: r.status || null,
        alerted: r.alerted ? r.alertType : false,
        best: best ? `${best.value} per item at ${best.store}${best.source === 'browser' ? ' (browser)' : ''}` : null,
        matched: r.observed?.matched ?? null,
        unsure: r.observed?.pending ?? null,
        rejected: r.observed?.rejected ?? null,
        waiting: r.observed?.waiting ?? null,
        matches: (r.observed?.matches || []).slice(0, 3)
          .map((m) => `${m.price} SAR${m.pack > 1 ? ` for ${m.pack}` : ''} = ${m.value}/item${m.inStock === false ? ' (out of stock)' : ''}: ${m.name}`),
        unsureNames: (r.observed?.unsure || []).slice(0, 3).map((u) => `${u.price} SAR: ${u.name}`),
      });
    }
    return { store: storeId, checked: report.length, storeRequests: cache.size, report };
  }

  window.lsaCheck = function lsaCheck({ store, profile, ids = null, engine = ENGINE } = {}) {
    const config = STORES[store];
    if (!config) return { stopped: `store must be one of ${Object.keys(STORES).join(', ')}` };
    if (location.hostname !== config.host) return { stopped: `open a ${config.host} tab first (this is ${location.hostname})` };
    if (!profile) return { stopped: 'profile is required' };
    if (looksBlocked(document.title)) return { stopped: `the store shows a challenge page ("${document.title}"); stopping` };
    const state = { store, started: new Date().toISOString(), progress: 'starting', result: null };
    window.__lsaCheck = state;
    const start = (transport) => {
      state.promise = run(state, store, transport, { profile, ids })
        .then((result) => { state.result = { done: true, ...result }; })
        .catch((err) => { state.result = { done: true, stopped: err?.message || String(err), stopReason: err instanceof Stop ? 'stop' : 'error' }; })
        .finally(() => transport.close());
    };
    if (!config.relay) {
      start(directTransport(engine));
      return { started: true, store };
    }
    document.getElementById('lsa-check-button')?.remove();
    const button = document.createElement('button');
    button.id = 'lsa-check-button';
    button.type = 'button';
    button.textContent = 'Send to Price Watch';
    button.style.cssText = 'position:fixed;z-index:2147483647;top:14px;left:50%;transform:translateX(-50%);'
      + 'padding:12px 20px;background:#0a7d4f;color:#fff;border:0;border-radius:10px;'
      + 'font:600 16px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer';
    button.addEventListener('click', () => {
      button.remove();
      try {
        start(relayTransport(engine));
      } catch (err) {
        state.result = { done: true, stopped: err?.message || String(err), stopReason: 'stop' };
      }
    }, { once: true });
    document.body.appendChild(button);
    state.progress = 'waiting for the "Send to Price Watch" click';
    return { started: false, store, click: '#lsa-check-button ("Send to Price Watch")' };
  };

  window.lsaCheckResult = async function lsaCheckResult(waitMs = 25000) {
    const state = window.__lsaCheck;
    if (!state) return { done: false, error: 'no check started on this page' };
    if (!state.result && state.promise) await Promise.race([state.promise, sleep(waitMs)]);
    return state.result || { done: false, progress: state.progress };
  };
})();
