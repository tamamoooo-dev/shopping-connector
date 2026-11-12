// readerLimits.js — the Mini marts PC reader's Claude accounts and their
// limits (2026-11-11). Pure rules, used by pc-reader/reader.mjs and tested in
// the suite; nothing in the Worker imports this.
//
// The reader runs on the owner's Claude plan, so its calls count against the
// plan's limits. Measured 2026-11-06 23:19 → 2026-11-07 00:22 UTC: the
// session limit was hit, and the reader asked 468 more times in an hour, each
// one refused ("You've hit your session limit · resets 4:10am (Asia/Riyadh)").
// Owner, 2026-11-12: "i have two claude accounts i want it to use the back up
// account if the waiting period for both accounts + 2 hours it could use
// mistral instead". So:
//   • an account at its limit is not asked again before its reset time;
//   • the other account is used meanwhile (the main one first);
//   • with every account at its limit the reader asks no model, and tells the
//     engine when the first one resets: the engine keeps the snaps for the
//     reader when that is at most 2 h away, and gives them to Mistral when it
//     is further (minimarts.js READER_HOLD_MAX_MS).

export const HOLD_MAX_MS = 2 * 60 * 60 * 1000; // minimarts.js READER_HOLD_MAX_MS
// A limit whose reset time could not be read: asked again after this long.
export const UNKNOWN_RETRY_MS = 60 * 60 * 1000;
// An account that is not signed in: looked at again after this long.
export const SIGNIN_RETRY_MS = 6 * 60 * 60 * 1000;
// The reset time is a minute's precision: asked again this long after it.
export const RESET_MARGIN_MS = 60 * 1000;

const LIMIT = /hit your (?:[\w-]+ )*limit|(?:session|weekly|usage|5-hour|five-hour|plan) limit (?:was )?reached|limit will reset|limit\b[^.\n]{0,40}\bresets?\b/i;
const SIGNIN = /not logged in|please run \/login|invalid api key|oauth token (?:has )?(?:expired|been revoked)|authentication_error|no credentials/i;
const RESET = /\bresets?(?: at| on)?\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The wall clock of `zone` at `ms` -> { y, m, d, h, mi } (m is 1–12).
function wallClock(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms));
  const n = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour') % 24, mi: n('minute') };
}

// The instant `zone`'s wall clock shows y-m-d h:mi (days past a month's end roll over).
function instantOf({ y, m, d, h, mi }, zone) {
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let ms = wanted;
  for (let i = 0; i < 2; i += 1) {
    const c = wallClock(ms, zone);
    ms -= Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi) - wanted;
  }
  return ms;
}

function usableZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch {
    return null;
  }
}

// "resets 4:10am (Asia/Riyadh)", "resets Nov 14, 3pm", "will reset at 3pm":
// the next time the clock of that zone (the PC's when none is written) shows
// it -> ms, or null when no time is written.
export function resetTime(text, atMs, zone = undefined) {
  const m = RESET.exec(String(text));
  if (!m) return null;
  const [, month, day, hourText, minuteText, half, zoneText] = m;
  let h = Number(hourText);
  const mi = Number(minuteText || 0);
  if (h > 23 || mi > 59 || (half && (h < 1 || h > 12))) return null;
  if (half) h = (h % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
  const tz = usableZone(zoneText?.trim()) || usableZone(zone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = wallClock(atMs, tz);
  if (month) {
    const at = { y: today.y, m: MONTHS.indexOf(month.toLowerCase()) + 1, d: Number(day), h, mi };
    const ms = instantOf(at, tz);
    return ms > atMs ? ms : instantOf({ ...at, y: at.y + 1 }, tz);
  }
  const ms = instantOf({ ...today, h, mi }, tz);
  return ms > atMs ? ms : instantOf({ ...today, d: today.d + 1, h, mi }, tz);
}

// What a failed call says about the account it was made on:
//   { kind: 'limit', until }    at its limit until the written reset time
//   { kind: 'unknown', until }  at its limit, no reset time readable: asked again in an hour
//   { kind: 'signin', until }   not signed in: looked at again in 6 hours
//   null                        anything else (the call is simply tried again)
// `until` is an ISO time.
export function limitOf(message, at = new Date(), zone = undefined) {
  const text = String(message || '');
  const ms = at.getTime();
  if (LIMIT.test(text)) {
    const reset = resetTime(text, ms, zone);
    return reset
      ? { kind: 'limit', until: new Date(reset + RESET_MARGIN_MS).toISOString() }
      : { kind: 'unknown', until: new Date(ms + UNKNOWN_RETRY_MS).toISOString() };
  }
  if (SIGNIN.test(text)) return { kind: 'signin', until: new Date(ms + SIGNIN_RETRY_MS).toISOString() };
  return null;
}

// The first account (in order) that may be asked now -> its name, or null
// when every one is at its limit. state: { [name]: { until, kind, since } }.
export function usableAccount(names, state, atMs) {
  return names.find((name) => !(Date.parse(state?.[name]?.until) > atMs)) ?? null;
}

// One account found at its limit: what to remember. `since` is when this
// stretch began (kept while the account stays limited without a break).
export function limitedEntry(previous, limit, at = new Date()) {
  const ms = at.getTime();
  const ongoing = previous?.since && Date.parse(previous.until) > ms - 5 * 60 * 1000;
  return { until: limit.until, kind: limit.kind, since: ongoing ? previous.since : at.toISOString() };
}

// Every account is at its limit: the time to tell the engine (ISO), the first
// real reset. An account that is only signed out does not make the others'
// reset later. A limit with no readable reset time is waited for at most
// HOLD_MAX_MS in all; after that the time told is too far to wait, so Mistral
// reads while the account is still asked every hour.
export function reportUntil(entries, atMs) {
  const limits = entries.filter((e) => e?.kind !== 'signin');
  const pool = limits.length ? limits : entries;
  const first = pool.reduce((a, b) => (Date.parse(a.until) <= Date.parse(b.until) ? a : b));
  if (first.kind === 'unknown' && atMs - Date.parse(first.since) >= HOLD_MAX_MS) {
    return new Date(atMs + HOLD_MAX_MS + UNKNOWN_RETRY_MS).toISOString();
  }
  return first.until;
}
