// Super Search: my browser — the owner's own Chrome answers a search the
// owner started in the app, for a store that refuses the server (src/relay.js
// in the connector is the other end).
//
// It holds one connection to the connector, opened with this browser's
// 12-character code. Only a request that carries the same code reaches it.
// For each request it runs ONE search on the store, as this browser, and
// hands back the products. Rules it keeps:
//   - only the stores listed in STORES, only their search;
//   - at most MAX_SEARCHES in WINDOW_MS;
//   - a refusal (401, 403, 429, or a page instead of data) stops that store
//     for STOP_MS. It is never retried around;
//   - Pause in the options page closes the connection.

const SERVER = 'wss://shopping-connector.tamamoooo.workers.dev/relay/connect';
const PROTOCOL = 'lsa-relay';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_SEARCHES = 30;
const WINDOW_MS = 10 * 60 * 1000;
const STOP_MS = 60 * 60 * 1000;
const PING_MS = 20 * 1000;

const STORES = {
  lulu: { label: 'Lulu', read: readLulu },
};

let socket = null;
let pingTimer = null;

// --- what is kept (chrome.storage.local) --------------------------------------------
// key: the code · paused: bool · stopped: { [store]: ms } · recent: [ms] ·
// lastSearchAt: ms · lastRefusal: { store, status, at }
const load = (names) => chrome.storage.local.get(names);
const save = (values) => chrome.storage.local.set(values);

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

async function getKey() {
  const { key } = await load('key');
  if (typeof key === 'string' && /^[A-Z2-7]{12}$/.test(key)) return key;
  const made = newKey();
  await save({ key: made });
  return made;
}

// --- the connection -----------------------------------------------------------------------
function closeSocket() {
  clearInterval(pingTimer);
  pingTimer = null;
  if (socket) {
    try {
      socket.close(1000, 'closed');
    } catch {
      // already closed
    }
  }
  socket = null;
}

async function connect() {
  const { paused } = await load('paused');
  if (paused) return closeSocket();
  if (socket && socket.readyState <= 1) return;
  const key = await getKey();
  let ws;
  try {
    // The code travels as a sub-protocol, never in the address.
    ws = new WebSocket(SERVER, [PROTOCOL, key]);
  } catch {
    return;
  }
  socket = ws;
  ws.onopen = () => {
    clearInterval(pingTimer);
    // Keeps the connection, and this worker, awake between searches.
    pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.send('ping');
    }, PING_MS);
  };
  ws.onmessage = (event) => {
    if (event.data !== 'pong') onAsk(ws, event.data);
  };
  ws.onclose = () => {
    if (socket === ws) {
      clearInterval(pingTimer);
      pingTimer = null;
      socket = null;
    }
  };
  ws.onerror = () => {};
}

// --- one search ----------------------------------------------------------------------------
async function readLulu(query) {
  const res = await fetch(`https://gcc.luluhypermarket.com/ar-sa/list?search_text=${encodeURIComponent(query)}&format=json&page_size=50`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  const type = res.headers.get('content-type') || '';
  if ([401, 403, 429].includes(res.status) || (res.ok && !type.includes('json'))) return { refused: true, status: res.status };
  if (!res.ok) return { error: `Lulu answered HTTP ${res.status}` };
  const body = await res.json();
  const list = Array.isArray(body.products) ? body.products : [];
  // Only what the connector's Lulu reader uses.
  return {
    locale: 'ar-sa',
    products: list.slice(0, 50).map((p) => ({
      pk: p.pk,
      name: typeof p.name === 'string' ? p.name.slice(0, 200) : '',
      price: p.price,
      retail_price: p.retail_price,
      currency_type: p.currency_type,
      absolute_url: typeof p.absolute_url === 'string' ? p.absolute_url.slice(0, 300) : '',
      productimage_set: Array.isArray(p.productimage_set) && p.productimage_set[0] ? [{ image: p.productimage_set[0].image }] : [],
      attributes: { brand: p.attributes && typeof p.attributes.brand === 'string' ? p.attributes.brand.slice(0, 80) : '' },
    })),
  };
}

async function onAsk(ws, raw) {
  let ask;
  try {
    ask = JSON.parse(raw);
  } catch {
    return;
  }
  if (!ask || typeof ask.id !== 'string') return;
  const reply = (answer) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ id: ask.id, ...answer }));
  };
  const store = STORES[ask.store];
  if (!store || typeof ask.query !== 'string' || !ask.query.trim()) return reply({ error: 'unknown store or empty search' });

  const now = Date.now();
  const kept = await load(['paused', 'stopped', 'recent']);
  if (kept.paused) return reply({ paused: true });
  const stopped = kept.stopped || {};
  if (stopped[ask.store] > now) return reply({ stopped: true, until: new Date(stopped[ask.store]).toISOString() });
  const recent = (Array.isArray(kept.recent) ? kept.recent : []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_SEARCHES) return reply({ busy: true });
  recent.push(now);
  await save({ recent, lastSearchAt: now });

  let answer;
  try {
    answer = await store.read(ask.query.trim().slice(0, 200));
  } catch (err) {
    answer = { error: String(err && err.message ? err.message : err) };
  }
  if (answer.refused) {
    stopped[ask.store] = now + STOP_MS;
    await save({ stopped, lastRefusal: { store: ask.store, status: answer.status, at: now } });
  }
  reply({ ...answer, ms: Date.now() - now });
}

// --- the options page asks ---------------------------------------------------------------
async function status() {
  const now = Date.now();
  const kept = await load(['paused', 'stopped', 'recent', 'lastSearchAt', 'lastRefusal']);
  const stopped = Object.entries(kept.stopped || {})
    .filter(([, until]) => until > now)
    .map(([store, until]) => ({ store, label: STORES[store] ? STORES[store].label : store, until }));
  return {
    key: await getKey(),
    paused: Boolean(kept.paused),
    connected: Boolean(socket && socket.readyState === 1),
    stopped,
    searches: (Array.isArray(kept.recent) ? kept.recent : []).filter((at) => now - at < WINDOW_MS).length,
    maxSearches: MAX_SEARCHES,
    lastSearchAt: kept.lastSearchAt || null,
    stores: Object.values(STORES).map((s) => s.label),
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (message && message.type === 'pause') {
      await save({ paused: Boolean(message.paused) });
      if (message.paused) closeSocket();
    }
    if (message && message.type === 'new-key') {
      await save({ key: newKey() });
      closeSocket();
    }
    await connect();
    // Give a fresh connection a moment, so the page shows the true state.
    if (socket && socket.readyState === 0) await new Promise((r) => setTimeout(r, 1200));
    respond(await status());
  })();
  return true;
});

// The browser puts this worker to sleep when idle; an alarm wakes it to reconnect.
chrome.alarms.create('relay', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
