// relay.js — "search with my own browser" (2026-11-12).
//
// Some stores refuse this Worker but answer a person's browser (Lulu's
// firewall, 2026-11-03). The owner's rule: a search the owner starts may be
// run in the owner's own Chrome and shown back in the owner's app. Nothing
// else comes through here: no timed work, no engine rounds.
//
// How it works:
//   - The owner's Chrome runs a small extension (browser-relay/). It holds
//     one WebSocket open to /relay/connect and knows a 12-character code.
//   - The owner types that code into the app once. The app sends it as the
//     X-Relay-Key header with its own searches.
//   - When a store refuses this Worker and the request carries a code, the
//     search is handed to the browser holding the same code; its answer is
//     normalized by the store's provider like any other answer.
// The code is the lock: without it nobody reaches that browser. One Durable
// Object per code is the meeting point. It stores nothing; it only holds the
// socket (hibernated between searches).
//
// A refusal from the store is passed on as it is. It is never retried around.

export const RELAY_HEADER = 'X-Relay-Key';
export const RELAY_PROTOCOL = 'lsa-relay';
const ASK_TIMEOUT_MS = 9000;
const ASKS_PER_WINDOW = 40;
const WINDOW_MS = 10 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 40;

// The code as people type it: any case, with dashes or spaces, 0 for O and
// 1 for I. Returns the 12 clean characters, or null.
export function cleanKey(raw) {
  const key = String(raw || '')
    .toUpperCase()
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/[^A-Z2-7]/g, '');
  return /^[A-Z2-7]{12}$/.test(key) ? key : null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': `Content-Type, ${RELAY_HEADER}`,
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

function stubFor(env, key) {
  return env.RELAY.get(env.RELAY.idFromName(key));
}

// (key, { store, query }) -> { state: 'ok', ...the browser's answer } or
// { state: 'offline' | 'timeout' | 'busy' | 'refused' | 'stopped' | 'paused' | 'error' }.
export function makeRelay(env) {
  if (!env || !env.RELAY) return null;
  return async (key, ask) => {
    try {
      const res = await stubFor(env, key).fetch('https://relay/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: ask.store, query: ask.query }),
      });
      return await res.json();
    } catch (err) {
      return { state: 'error', error: String(err && err.message ? err.message : err) };
    }
  };
}

// /relay/connect (the extension's socket) and /relay/status (the app asks
// "is my browser connected?"). Returns null for any other path.
export async function relayRoutes(request, env, url) {
  if (!url.pathname.startsWith('/relay/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env || !env.RELAY) return json({ error: 'The browser relay is not set up.' }, 503);

  if (url.pathname === '/relay/connect') {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426);
    // The code travels as the second sub-protocol, never in the address.
    const offered = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
    const key = offered[0] === RELAY_PROTOCOL ? cleanKey(offered[1]) : null;
    if (!key) return json({ error: 'Missing or malformed code.' }, 401);
    return stubFor(env, key).fetch(new Request('https://relay/connect', request));
  }

  if (url.pathname === '/relay/status') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const key = cleanKey(request.headers.get(RELAY_HEADER));
    if (!key) return json({ error: 'Missing or malformed code.' }, 401);
    const res = await stubFor(env, key).fetch('https://relay/status');
    return json(await res.json());
  }

  return json({ error: 'Not found' }, 404);
}

// The meeting point for one code.
export class BrowserRelay {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    this.asked = [];
    this.cache = new Map();
    // The extension's keep-alive is answered without waking this object.
    if (typeof WebSocketRequestResponsePair !== 'undefined' && state.setWebSocketAutoResponse) {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  sockets() {
    return this.state.getWebSockets().filter((ws) => ws.readyState === 1);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      const pair = new WebSocketPair();
      // One browser per code: the newest connection replaces an older one.
      for (const old of this.state.getWebSockets()) {
        try {
          old.close(4000, 'replaced by a newer connection');
        } catch {
          // already closed
        }
      }
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': RELAY_PROTOCOL } });
    }

    if (url.pathname === '/status') {
      return Response.json({ connected: this.sockets().length > 0 });
    }

    if (url.pathname === '/ask' && request.method === 'POST') {
      const ask = await request.json().catch(() => null);
      if (!ask || typeof ask.store !== 'string' || typeof ask.query !== 'string') return Response.json({ state: 'error', error: 'bad ask' });
      return Response.json(await this.ask(ask.store, ask.query.slice(0, 200)));
    }

    return new Response('Not found', { status: 404 });
  }

  async ask(store, query, now = Date.now()) {
    const cacheKey = `${store}\n${query}`;
    const kept = this.cache.get(cacheKey);
    if (kept && now - kept.at < CACHE_MS) return { ...kept.answer, cached: true };

    const [ws] = this.sockets();
    if (!ws) return { state: 'offline' };
    this.asked = this.asked.filter((at) => now - at < WINDOW_MS);
    if (this.asked.length >= ASKS_PER_WINDOW) return { state: 'busy' };
    this.asked.push(now);

    const id = crypto.randomUUID();
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ state: 'timeout' });
      }, ASK_TIMEOUT_MS);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      try {
        ws.send(JSON.stringify({ id, store, query }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ state: 'offline' });
      }
    });
    if (answer.state) return answer;
    const out = relayAnswer(answer);
    if (out.state === 'ok') {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(cacheKey, { at: now, answer: out });
    }
    return out;
  }

  webSocketMessage(ws, data) {
    if (typeof data !== 'string') return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const done = message && typeof message.id === 'string' ? this.pending.get(message.id) : null;
    if (!done) return;
    this.pending.delete(message.id);
    done(message);
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
  }

  webSocketError() {
    // the socket is gone; the next search answers "offline"
  }
}

// What the browser said -> one state the connector understands.
export function relayAnswer(message) {
  if (!message || typeof message !== 'object') return { state: 'error', error: 'no answer' };
  if (message.paused) return { state: 'paused' };
  if (message.stopped) return { state: 'stopped', until: typeof message.until === 'string' ? message.until : null };
  if (message.refused) return { state: 'refused', status: Number(message.status) || null };
  if (message.busy) return { state: 'busy' };
  if (message.error) return { state: 'error', error: String(message.error).slice(0, 200) };
  if (!Array.isArray(message.products)) return { state: 'error', error: 'no products in the answer' };
  return {
    state: 'ok',
    locale: typeof message.locale === 'string' ? message.locale : null,
    products: message.products.slice(0, 60),
    ms: Number(message.ms) || null,
  };
}
