// pc-reader/vision.mjs — the Vision PC reader (2026-11-19, owner: "make two
// vision pipeline the default is haiku if it works and the mistral become a
// backup .. one time reading .. price / and name is a must .. size and brand
// are next .. if we can hire more works to finish faster it is fine").
//
// Claude Haiku 5.5 reads the flyer crops Stage-1 Vision has not read yet, on
// the owner's PC, through the Claude Agent SDK on the owner's Claude plan (no
// API key, no money per call). The engine decides what is read and saves
// each reading through its Stage-1 path (src/offers/visionReader.js); this
// script only asks, reads and posts:
//
//   GET  /vision/reader/queue?crops=200   the next unread offers (also the heartbeat)
//   POST /vision/reader/readings          { readings: [{ id, reading }] } after each call
//   POST /vision/reader/limit             every Claude account at its limit until …
//
// ONE READING a crop. Ten crops a call, eight calls at once (measured
// 2026-11-19 on 74 + 425 live crops: prices never contradicted D4D, names on
// 495/499, ~0.4 s a crop, ~$0.00037 a crop of plan usage). A run reads until
// the queue is empty or RUN_MAX_MS, then ends; Task Scheduler starts it every
// 5 minutes (install-vision-task.ps1), and a run still going is left alone.
//
// Numbered pictures, each picture once (2026-11-19, owner: "build it and
// re-read the bad ones"). With only a text "Crop k" before each image, a call
// of look-alike crops (Nesto's olive oil / mixer / olive oil …, offers sharing
// one picture) put readings on the neighbouring offer: 29–30% of 140 replayed
// bad live calls. Now each crop carries its number INSIDE the picture (a black
// "CROP k" band on top, drawn when the engine's prompt describes it), and a
// call holds up to ten DIFFERENT pictures; offers sharing a picture get that
// picture's reading. Measured: 0 of 1,100 readings moved, $0.24–0.30 per
// 1,000 crops (was $0.32).
//
// Accounts: the PC's own Claude login first, then the backup sign-in
// (%USERPROFILE%\.claude-backup, login-backup.cmd), sharing logs/accounts.json
// with the Mini marts reader so a limit one finds the other knows. With every
// account at its limit nothing is asked: the engine is told when the first
// resets, and Mistral reads meanwhile when that is more than 2 h away.
//
//   node vision.mjs                    read until the queue is empty
//   node vision.mjs --once             one queue's worth, then stop
//   node vision.mjs --reread list.json re-read these offers ([{id, imageUrl}])
//                                      and REPLACE their saved reading; done
//                                      ids go to logs/reread-done.txt, so a
//                                      second start carries on where it stopped
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import sharp from 'sharp';
import { loadIngestSecret } from '../local-secrets.mjs';
import { limitOf, limitedEntry, reportUntil, usableAccount } from '../src/readerLimits.js';

const ENGINE = process.env.ENGINE_URL || 'https://brochure-engine.tamamoooo.workers.dev';
const PER_CALL = 10;
const WORKERS = 8;
const MIN_WORKERS = 2;
const QUEUE_ASK = 200;
const CROP_EDGE = 768;
const MAX_TRIES = 2;
const ONCE = process.argv.includes('--once');
const REREAD = process.argv.includes('--reread') ? process.argv[process.argv.indexOf('--reread') + 1] : null;
const POST_MAX = 50; // the engine saves at most 50 readings a post
const BAND = 64; // px: the black "CROP k" band drawn above each crop
const RUN_MAX_MS = 50 * 60 * 1000;
const CALL_TIMEOUT_MS = 4 * 60 * 1000;
const LOG_DIR = process.env.VISION_LOG_DIR || fileURLToPath(new URL('./logs/', import.meta.url));
const LOG_FILE = `${LOG_DIR}vision.log`;
const REREAD_DONE = `${LOG_DIR}reread-done.txt`;
const LOG_MAX_BYTES = 1024 * 1024;
const STATE_FILE = `${LOG_DIR}accounts.json`;
const BACKUP_DIR = process.env.READER_BACKUP_DIR || join(homedir(), '.claude-backup');
const ACCOUNTS = [
  { name: 'main', configDir: null },
  ...(existsSync(join(BACKUP_DIR, '.credentials.json')) ? [{ name: 'backup', configDir: BACKUP_DIR }] : []),
];
const NAMES = ACCOUNTS.map((a) => a.name);

const secret = loadIngestSecret();
if (!secret) throw new Error('no ingest secret (.ingest.secret)');

function log(entry) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_DIR}vision.old.log`);
    } catch {
      /* no log yet */
    }
    appendFileSync(LOG_FILE, line);
  } catch {
    /* logging never stops a run */
  }
}

async function engine(path, init = {}) {
  const res = await fetch(`${ENGINE}${path}`, {
    ...init,
    headers: { 'X-Ingest-Secret': secret, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`engine ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- accounts (shared with reader.mjs through logs/accounts.json) ---------------
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
let state = readState();
function usable() {
  state = { ...state, ...readState() };
  return ACCOUNTS.find((a) => a.name === usableAccount(NAMES, state, Date.now())) || null;
}
function markLimited(account, limit, said) {
  const fresh = readState();
  fresh[account.name] = { ...limitedEntry(fresh[account.name], limit), said: said.slice(0, 160) };
  state = { ...state, ...fresh };
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
  } catch {
    /* the next call finds the limit again */
  }
  log({ account: account.name, limit: limit.kind, until: limit.until, said: said.slice(0, 160) });
}
async function reportLimit() {
  const until = reportUntil(NAMES.map((name) => state[name]), Date.now());
  const accounts = Object.fromEntries(NAMES.map((name) => [name, { until: state[name]?.until, kind: state[name]?.kind }]));
  const out = await engine('/vision/reader/limit', { method: 'POST', body: JSON.stringify({ until, accounts }) });
  log({ limited: true, until, reads: out.reads, accounts });
}

// --- one Haiku call ---------------------------------------------------------------
const usage = { calls: 0, failed: 0, input: 0, output: 0, thinking: 0, costUSD: 0, by: {} };

async function askOnce(content, account, model) {
  async function* message() {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), CALL_TIMEOUT_MS);
  let reply = null;
  try {
    for await (const m of query({
      prompt: message(),
      options: {
        model,
        systemPrompt: 'You read retail flyer crops and answer with JSON only.',
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        maxTurns: 1,
        persistSession: false,
        effort: 'low',
        thinking: { type: 'disabled' },
        abortController,
        env: {
          ...process.env, DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_DISABLE_THINKING: '1',
          ...(account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {}),
        },
      },
    })) {
      if (m.type !== 'result') continue;
      const u = m.modelUsage?.[model] || Object.values(m.modelUsage || {})[0] || {};
      usage.calls += 1;
      usage.input += u.inputTokens || 0;
      usage.output += u.outputTokens || 0;
      usage.thinking += u.thinkingTokens || 0;
      usage.costUSD += m.total_cost_usd || 0;
      if (m.subtype !== 'success' || m.is_error) throw new Error(`haiku ${m.subtype}: ${String(m.result || '').slice(0, 160)}`);
      if (!String(m.result || '').includes('{') && limitOf(m.result)) throw new Error(String(m.result).slice(0, 200));
      usage.by[account.name] = (usage.by[account.name] || 0) + 1;
      reply = m.result;
    }
  } finally {
    clearTimeout(timer);
  }
  return reply;
}

// -> the reply, or null (every account at its limit, or three failures).
async function ask(content, model, errors) {
  for (let failures = 0; failures < 3;) {
    const account = usable();
    if (!account) return null;
    try {
      return await askOnce(content, account, model);
    } catch (err) {
      const said = String(err?.message || err);
      const limit = limitOf(said);
      if (limit) {
        markLimited(account, limit, said);
        continue;
      }
      failures += 1;
      usage.failed += 1;
      if (errors.length < 10) errors.push(said.slice(0, 200));
      await new Promise((r) => setTimeout(r, 5000 * failures));
    }
  }
  return null;
}

function parse(raw) {
  try {
    return JSON.parse(/\{[\s\S]*\}/.exec(String(raw))[0]);
  } catch {
    return null;
  }
}

// --- crops ---------------------------------------------------------------------------
async function crop(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`crop HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const jpeg = await sharp(bytes).rotate()
    .resize({ width: CROP_EDGE, height: CROP_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 }).toBuffer();
  return jpeg.toString('base64');
}

// The crop with its number printed in a black band on top ("CROP k").
async function numbered(data, k) {
  const bytes = Buffer.from(data, 'base64');
  const { width } = await sharp(bytes).metadata();
  const label = Buffer.from(`<svg width="${width}" height="${BAND}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000"/><text x="12" y="48" font-family="Arial" font-weight="bold" font-size="44" fill="#fff">CROP ${k}</text></svg>`);
  const out = await sharp(bytes).extend({ top: BAND, background: '#000' })
    .composite([{ input: label, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
  return out.toString('base64');
}

function rereadDone() {
  try {
    return new Set(readFileSync(REREAD_DONE, 'utf8').split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set();
  }
}

// --- the run -------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const run = { reader: REREAD ? 'haiku-reread' : 'haiku', crops: 0, pictures: 0, calls: 0, readings: 0, published: 0, saved: 0, missing: 0, kept: 0, cropErrors: 0, postErrors: 0, workers: WORKERS, errors: [] };
  // --reread: the offers to read again, minus those a previous start finished.
  let rereadList = null;
  if (REREAD) {
    const done = rereadDone();
    rereadList = JSON.parse(readFileSync(REREAD, 'utf8')).filter((o) => o?.id && o.imageUrl && !done.has(o.id));
    log({ reread: REREAD, offers: rereadList.length, alreadyDone: done.size });
  }
  if (!usable()) {
    await reportLimit();
    return;
  }

  const seen = new Set(); // dispatched this run
  const tries = new Map(); // id -> calls it was in
  const pending = []; // [{ id, imageUrl, data? }]
  let prompts = null;
  let model = 'claude-haiku-5-5';
  let drained = false;
  let stopped = null;
  let fetching = null;
  let workers = WORKERS;
  let failStreak = 0;
  let failedCalls = 0;

  // Asks the engine for more work: the offers not dispatched yet this run.
  async function refill() {
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        // A re-read pass still asks the queue: for the prompts, and to stop
        // when the switch says Mistral. Its offers come from the list.
        const q = await engine(`/vision/reader/queue?crops=${REREAD ? 1 : QUEUE_ASK}`);
        if (q.mode !== 'haiku') {
          stopped = `switch: ${q.mode}`;
          return;
        }
        prompts = { single: q.prompt, batch: q.batchPrompt };
        model = q.model || model;
        const offered = REREAD ? rereadList.filter((o) => !seen.has(o.id)).slice(0, QUEUE_ASK) : (q.offers || []);
        const fresh = offered.filter((o) => o?.id && o.imageUrl && !seen.has(o.id));
        if (!fresh.length) {
          drained = true;
          return;
        }
        for (const o of fresh) seen.add(o.id);
        // Crops come straight from D4D's CDN, eight at a time; a picture
        // several offers share is downloaded once.
        const byPicture = new Map();
        for (const o of fresh) byPicture.set(o.imageUrl, [...(byPicture.get(o.imageUrl) || []), o]);
        const urls = [...byPicture.keys()];
        let next = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (next < urls.length) {
            const url = urls[next++];
            const offers = byPicture.get(url);
            try {
              const data = await crop(url);
              for (const o of offers) {
                o.data = data;
                pending.push(o);
              }
              run.crops += offers.length;
            } catch (err) {
              run.cropErrors += offers.length;
              if (run.errors.length < 10) run.errors.push(`${offers[0].id}: ${String(err?.message || err).slice(0, 100)}`);
            }
          }
        }));
        if (ONCE) drained = true;
      } catch (err) {
        stopped = `queue: ${String(err?.message || err).slice(0, 160)}`;
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  async function post(readings) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const out = await engine('/vision/reader/readings', { method: 'POST', body: JSON.stringify({ readings, ...(REREAD ? { reread: true } : {}) }) });
        run.saved += out.run?.saved || 0;
        run.published += out.run?.published || 0;
        if (REREAD) {
          try {
            appendFileSync(REREAD_DONE, readings.map((r) => `${r.id}\n`).join(''));
          } catch {
            /* a restart re-reads these few again */
          }
        }
        return;
      } catch (err) {
        if (attempt === 2) {
          run.postErrors += 1;
          if (run.errors.length < 10) run.errors.push(`post: ${String(err?.message || err).slice(0, 120)}`);
        } else {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  // Up to PER_CALL different pictures, with every waiting offer that shows one
  // of them: each picture is read once a call and its reading goes to each.
  const pictures = () => new Set(pending.map((o) => o.imageUrl)).size;
  function takeGroup() {
    const urls = [];
    for (const o of pending) {
      if (!urls.includes(o.imageUrl)) urls.push(o.imageUrl);
      if (urls.length === PER_CALL) break;
    }
    const take = new Set(urls);
    const group = pending.filter((o) => take.has(o.imageUrl));
    const rest = pending.filter((o) => !take.has(o.imageUrl));
    pending.length = 0;
    pending.push(...rest);
    return { urls, group };
  }

  async function worker(index) {
    while (!stopped) {
      if (index >= workers) return; // the run slowed down: fewer calls at once
      if (Date.now() - started > RUN_MAX_MS) {
        stopped = stopped || 'time';
        return;
      }
      if (pictures() < PER_CALL && !drained) await refill();
      const { urls, group } = takeGroup();
      if (!group.length) {
        if (drained || stopped) return;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const o of group) tries.set(o.id, (tries.get(o.id) || 0) + 1);
      const data = urls.map((u) => group.find((o) => o.imageUrl === u).data);
      // The band only when the engine's prompt says the number is printed in
      // one, so the PC and the engine can be updated in either order.
      const banded = urls.length > 1 && /black band/.test(prompts.batch);
      const images = banded ? await Promise.all(data.map((d, k) => numbered(d, k + 1))) : data;
      const content = urls.length === 1
        ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[0] } },
          { type: 'text', text: prompts.single },
        ]
        : [
          ...images.flatMap((d, k) => [
            { type: 'text', text: `Crop ${k + 1}` },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } },
          ]),
          { type: 'text', text: prompts.batch.replaceAll('{n}', String(urls.length)) },
        ];
      const raw = await ask(content, model, run.errors);
      run.calls += 1;
      if (raw == null) {
        // Every account at its limit (or three failures): the crops go back.
        pending.unshift(...group);
        for (const o of group) tries.set(o.id, (tries.get(o.id) || 1) - 1);
        if (!usable()) {
          stopped = 'limit';
          return;
        }
        // Calls failing (not a limit): fewer at once, and a run whose calls
        // keep failing ends instead of spending its 50 minutes on retries.
        failStreak += 1;
        failedCalls += 1;
        if (failedCalls >= 6) {
          stopped = 'failing';
          return;
        }
        if (failStreak >= 3 && workers > MIN_WORKERS) {
          workers = Math.max(MIN_WORKERS, Math.floor(workers / 2));
          run.workers = workers;
          log({ slowed: true, workers });
          failStreak = 0;
        }
        continue;
      }
      failStreak = 0;
      failedCalls = 0;
      run.pictures += urls.length;
      const obj = parse(raw);
      const entries = urls.length === 1 ? (obj ? [{ ...obj, crop: 1 }] : []) : (Array.isArray(obj?.crops) ? obj.crops : []);
      const readings = [];
      urls.forEach((url, k) => {
        const entry = entries.find((e) => Number(e?.crop) === k + 1);
        for (const o of group.filter((x) => x.imageUrl === url)) {
          if (entry && typeof entry === 'object') readings.push({ id: o.id, reading: entry });
          else if ((tries.get(o.id) || 0) < MAX_TRIES) pending.push(o); // read again in a later call
          else if (REREAD) run.kept += 1; // a re-read never replaces a reading with nothing
          else {
            // ONE READING: Haiku gave no answer twice; saved as an empty reading.
            readings.push({ id: o.id, reading: {} });
            run.missing += 1;
          }
        }
      });
      run.readings += readings.length;
      for (let i = 0; i < readings.length; i += POST_MAX) await post(readings.slice(i, i + POST_MAX));
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  if (stopped === 'limit' || !usable()) await reportLimit().catch((err) => run.errors.push(String(err?.message || err).slice(0, 120)));

  Object.assign(run, {
    ms: Date.now() - started,
    stopped: stopped || (drained ? 'empty' : null),
    model,
    usage: { ...usage, costUSD: Math.round(usage.costUSD * 10000) / 10000 },
  });
  if (run.calls || run.crops || run.errors.length) {
    log(run);
    await engine('/vision/reader/readings', { method: 'POST', body: JSON.stringify({ readings: [], final: true, run, ...(REREAD ? { reread: true } : {}) }) }).catch(() => {});
  }
}

await main();
