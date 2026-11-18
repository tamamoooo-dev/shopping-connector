// offers/visionReader.js — WHO reads Stage-1 Vision (owner, 2026-11-19).
//
// "make two vision pipeline the default is haiku if it works and the mistral
// become a backup .. in engine ops i can toggle between the two .. one time
// reading .. price / and name is a must .. size and brand are next".
//
// Claude Haiku 5.5 reads flyer crops on the owner's PC, through the Claude
// Agent SDK on the owner's Claude plan (pc-reader/vision.mjs, the Mini marts
// reader's pattern: the Worker cannot run the SDK). The PC asks the engine for
// the offers Stage 1 has not read (GET /vision/reader/queue — also its
// heartbeat), reads ten crops a call with eight calls at once, and posts each
// crop's reading back (POST /vision/reader/readings). The engine saves a
// reading through the SAME Stage-1 path a Mistral reading takes
// (drainEnrichment with a ready observation: validation, Business
// Acceptance, publish, evidence), so a Haiku card and a Mistral card are made
// alike. Price stays D4D's: Vision never sets a card's price.
//
// ONE READING. Each crop is read once. A Haiku reading's Stage-2 queue row is
// closed at once (attempts = STAGE_TWO_MAX_ATTEMPTS), so the verification
// drain never pays Mistral to read it again; an operator flag
// (flagForReverification resets attempts) still sends one back.
//
// Mistral is the backup: it reads Stage 1 when the ops switch says Mistral,
// when the PC has not asked for work for VISION_READER_ON_MS, or when every
// Claude account is at its limit until more than VISION_READER_HOLD_MAX_MS
// from now (the owner's 2-hour rule from Mini marts, 2026-11-12). A limit that
// ends sooner holds Stage 1 for Haiku.
//
// Measured 2026-11-19 (74 + 425 live D4D crops, one read each): price 498/499
// equal to D4D's, never contradicted; names on 495/499; ten crops a call read
// as well as one, at half the plan usage (~$0.00037 a crop list-equivalent)
// and ~0.4 s a crop with eight calls at once.
//
// No migration: the switch is one small JSON object in the object store
// (beside ops/settings/vision-model.json) and the PC's heartbeat, limit and
// last run share the PC readers' table (minimart_reader, row 'vision').

import { ENRICHMENT_VISION_PROMPT } from './enrichmentPrompt.js';
import { visionObservationFromReply } from './enrich.js';
import { STAGE_TWO_MAX_ATTEMPTS } from '../storage/visionVerificationStore.js';

const enc = new TextEncoder();

export const HAIKU_VISION_MODEL = 'claude-haiku-5-5';
export const VISION_READER_KEY = 'ops/settings/vision-reader.json';
export const VISION_READER_MODES = Object.freeze(['haiku', 'mistral']);
// The owner's choice: Haiku unless the switch says otherwise.
export const DEFAULT_VISION_READER = 'haiku';
// The PC task starts every 5 minutes and asks for work at least once a
// minute while it reads; 10 minutes of silence means it is off.
export const VISION_READER_ON_MS = 10 * 60 * 1000;
export const VISION_READER_HOLD_MAX_MS = 2 * 60 * 60 * 1000;
// A limit further away than this is a bad clock, not a real limit.
export const VISION_READER_LIMIT_MAX_MS = 8 * 24 * 60 * 60 * 1000;
export const VISION_READER_ROW = 'vision';
// listDebris caps a scan at 200; listDebrisByIds at 50 ids.
export const VISION_READER_MAX_QUEUE = 200;
export const VISION_READER_MAX_READINGS = 50;

export function normalizeVisionReader(mode) {
  const m = String(mode == null ? '' : mode).trim().toLowerCase();
  return VISION_READER_MODES.includes(m) ? m : null;
}

// --- the ops switch -------------------------------------------------------------

export async function readVisionReaderSetting(objectStore) {
  const fallback = { mode: DEFAULT_VISION_READER, selectedAt: null, selectedBy: null, source: 'default' };
  if (!objectStore || typeof objectStore.get !== 'function') return fallback;
  const rec = await objectStore.get(VISION_READER_KEY).catch(() => null);
  if (!rec) return fallback;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rec.bytes));
    const mode = normalizeVisionReader(parsed?.mode);
    if (!mode) return fallback;
    return { mode, selectedAt: parsed.selectedAt || null, selectedBy: parsed.selectedBy || null, source: 'stored' };
  } catch {
    return fallback;
  }
}

export async function writeVisionReaderSetting(objectStore, mode, { by = 'ops', now = new Date() } = {}) {
  const resolved = normalizeVisionReader(mode);
  if (!resolved) throw new Error(`Unknown Vision reader '${mode}'.`);
  if (!objectStore || typeof objectStore.put !== 'function') {
    throw new Error('Vision reader setting is unavailable (no object store bound).');
  }
  const record = { mode: resolved, selectedAt: now.toISOString(), selectedBy: by };
  await objectStore.put(VISION_READER_KEY, enc.encode(JSON.stringify(record)), { contentType: 'application/json' });
  return { ...record, source: 'stored' };
}

// --- the PC reader's state (minimart_reader row 'vision') -----------------------

function parseJson(text) {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
}

export function createVisionReaderState(db) {
  const name = VISION_READER_ROW;
  return {
    // Asking for work is the heartbeat.
    async note(nowIso) {
      await db
        .prepare(
          `INSERT INTO minimart_reader (name, seen_at) VALUES (?1, ?2)
           ON CONFLICT(name) DO UPDATE SET seen_at = ?2`,
        )
        .bind(name, nowIso)
        .run();
    },
    async noteRun(nowIso, run) {
      await db
        .prepare(
          `INSERT INTO minimart_reader (name, seen_at, last_run_at, last_run) VALUES (?1, ?2, ?2, ?3)
           ON CONFLICT(name) DO UPDATE SET seen_at = ?2, last_run_at = ?2, last_run = ?3`,
        )
        .bind(name, nowIso, JSON.stringify(run ?? null).slice(0, 4000))
        .run();
    },
    async noteLimit(nowIso, untilIso, note = null) {
      await db
        .prepare(
          `INSERT INTO minimart_reader (name, seen_at, limited_until, limit_note) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(name) DO UPDATE SET seen_at = ?2, limited_until = ?3, limit_note = ?4`,
        )
        .bind(name, nowIso, untilIso, note == null ? null : JSON.stringify(note).slice(0, 1000))
        .run();
    },
    async get() {
      const row = await db.prepare('SELECT * FROM minimart_reader WHERE name = ?').bind(name).first();
      if (!row) return null;
      return {
        seen_at: row.seen_at ?? null,
        limited_until: row.limited_until ?? null,
        limit_note: parseJson(row.limit_note),
        last_run_at: row.last_run_at ?? null,
        last_run: parseJson(row.last_run),
      };
    },
  };
}

// POST /vision/reader/limit: every Claude account is at its limit until
// `until` (a time already past: it reads again). -> { limitedUntil, reads }.
export async function setVisionReaderLimit(state, { until, note = null, now = new Date() }) {
  const ms = Date.parse(until);
  if (!Number.isFinite(ms)) return null;
  const at = now.getTime();
  const limitedUntil = new Date(Math.min(ms, at + VISION_READER_LIMIT_MAX_MS)).toISOString();
  await state.noteLimit(now.toISOString(), limitedUntil, note);
  return { limitedUntil, reads: Date.parse(limitedUntil) - at > VISION_READER_HOLD_MAX_MS ? 'mistral' : 'haiku' };
}

// --- who reads now ----------------------------------------------------------------

// -> { reader: 'haiku' | 'mistral', why, until? }. Pure.
export function whoReadsVision({ mode, pc = null, now = new Date() }) {
  const at = now.getTime();
  if (normalizeVisionReader(mode) === 'mistral') return { reader: 'mistral', why: 'chosen' };
  const seen = Date.parse(pc?.seen_at ?? '');
  if (!Number.isFinite(seen) || at - seen > VISION_READER_ON_MS) return { reader: 'mistral', why: 'pc-off' };
  const until = Date.parse(pc?.limited_until ?? '');
  if (Number.isFinite(until) && until - at > VISION_READER_HOLD_MAX_MS) {
    return { reader: 'mistral', why: 'pc-limited', until: pc.limited_until };
  }
  if (Number.isFinite(until) && until > at) return { reader: 'haiku', why: 'pc-holding', until: pc.limited_until };
  return { reader: 'haiku', why: 'pc-on' };
}

// The switch + the PC's state + the decision. A read failure falls back to
// Mistral (the PC's state unreadable = treated as off), never to silence.
export async function visionReaderGate({ objectStore = null, db = null, now = new Date() } = {}) {
  const setting = await readVisionReaderSetting(objectStore);
  const pc = db ? await createVisionReaderState(db).get().catch(() => null) : null;
  return { setting, pc, ...whoReadsVision({ mode: setting.mode, pc, now }) };
}

// --- what the PC sends and gets ---------------------------------------------------

// The instruction for one call. One crop: the production prompt unchanged.
// Several: the same prompt, framed so each labelled crop is read on its own
// pixels and answered in order (the framing measured on 2026-11-19).
function framedPrompt(n) {
  return [
    `Above are ${n} separate flyer crops, each labelled "Crop n". Each crop is a different advertised product. Apply the instructions below to EACH crop independently, using only that crop's own pixels.`,
    '',
    ENRICHMENT_VISION_PROMPT,
    '',
    `Return exactly one JSON object {"crops":[...]} holding one entry per crop, in order: the JSON object described above for that crop, plus "crop": its number.`,
  ].join('\n');
}

export function visionReaderPrompt(count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  return n === 1 ? ENRICHMENT_VISION_PROMPT : framedPrompt(n);
}

// The several-crop instruction with "{n}" where the count goes; the PC
// fills it in per call. Sent with the queue so a prompt change ships with
// the engine, not with the PC.
export const VISION_READER_BATCH_TEMPLATE = framedPrompt('{n}');

// [{ id, reading: { name_en, ... } }] -> { [offerId]: observation }, the shape
// drainEnrichment's `observations` takes. The batch label is not a reading
// field and is dropped; anything that is not one reading object is skipped.
export function observationsFromReadings(readings, { model = HAIKU_VISION_MODEL, observedAt = null } = {}) {
  const out = {};
  for (const r of Array.isArray(readings) ? readings : []) {
    const id = typeof r?.id === 'string' && r.id.trim() ? r.id.trim() : null;
    const reading = r?.reading;
    if (!id || !reading || typeof reading !== 'object' || Array.isArray(reading)) continue;
    const { crop: _crop, ...entry } = reading;
    out[id] = visionObservationFromReply(JSON.stringify(entry), { model, observedAt });
  }
  return out;
}

// One reading: close each Haiku-read offer's Stage-2 queue row so the
// verification drain never re-reads it. An operator flag resets attempts.
export function oneReadingStatements(db, offerIds, nowIso) {
  const ids = [...new Set((offerIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return [
    db
      .prepare(
        `UPDATE offer_vision_verification_queue
            SET attempts = ?, updated_at = ?
          WHERE offer_id IN (${placeholders}) AND attempts < ?`,
      )
      .bind(STAGE_TWO_MAX_ATTEMPTS, nowIso, ...ids, STAGE_TWO_MAX_ATTEMPTS),
  ];
}
