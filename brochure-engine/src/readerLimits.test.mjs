// The PC reader's Claude accounts and their limits (readerLimits.js).
import assert from 'node:assert/strict';
import {
  limitOf, resetTime, usableAccount, limitedEntry, reportUntil,
  HOLD_MAX_MS, UNKNOWN_RETRY_MS, SIGNIN_RETRY_MS, RESET_MARGIN_MS,
} from './readerLimits.js';

const at = (iso) => new Date(iso);
const iso = (ms) => new Date(ms).toISOString();

// The message measured on 2026-11-06 (02:19 in Riyadh): the limit resets at 04:10 there.
{
  const text = "Claude Code returned an error result: You've hit your session limit · resets 4:10am (Asia/Riyadh)";
  assert.deepEqual(limitOf(text, at('2026-11-06T23:19:25Z')), { kind: 'limit', until: '2026-11-07T01:11:00.000Z' });
  // Read after 04:10 the same day: it means tomorrow's.
  assert.equal(limitOf(text, at('2026-11-07T02:00:00Z')).until, '2026-11-08T01:11:00.000Z');
}

// Other ways the reset is written.
const reset = (text, now, zone) => iso(resetTime(text, Date.parse(now), zone));
assert.equal(reset("You've hit your weekly limit · resets Nov 14, 3pm (Asia/Riyadh)", '2026-11-12T08:00:00Z'), '2026-11-14T12:00:00.000Z');
assert.equal(reset('Weekly limit reached ∙ resets Jan 2, 9am (Asia/Riyadh)', '2026-12-30T08:00:00Z'), '2027-01-02T06:00:00.000Z'); // next year
assert.equal(reset('5-hour limit reached ∙ resets 12am (America/New_York)', '2026-11-06T23:00:00Z'), '2026-11-07T05:00:00.000Z');
assert.equal(reset('limit resets 12:30pm (Asia/Riyadh)', '2026-11-06T05:00:00Z'), '2026-11-06T09:30:00.000Z');
assert.equal(reset('Claude usage limit reached. Your limit will reset at 3pm (Europe/London).', '2026-07-01T10:00:00Z'), '2026-07-01T14:00:00.000Z'); // summer time
assert.equal(reset('session limit · resets 18:45', '2026-11-06T10:00:00Z', 'UTC'), '2026-11-06T18:45:00.000Z'); // no zone written: the PC's
assert.equal(reset('resets 4am (Not/AZone)', '2026-11-06T10:00:00Z', 'UTC'), '2026-11-07T04:00:00.000Z');
assert.equal(resetTime('session limit', Date.now()), null);
assert.equal(resetTime('resets 25pm', Date.now()), null);
assert.equal(limitOf('Usage limit reached. Your limit will reset at 3pm (Asia/Riyadh).', at('2026-11-06T05:00:00Z')).until, iso(Date.parse('2026-11-06T12:00:00Z') + RESET_MARGIN_MS));

// A limit with no time written is asked again in an hour; a signed-out account in six.
{
  const now = at('2026-11-06T10:00:00Z');
  assert.deepEqual(limitOf("You've hit your session limit", now), { kind: 'unknown', until: iso(now.getTime() + UNKNOWN_RETRY_MS) });
  assert.deepEqual(limitOf('Invalid API key · Please run /login', now), { kind: 'signin', until: iso(now.getTime() + SIGNIN_RETRY_MS) });
  assert.equal(limitOf('Not logged in · Please run /login', now).kind, 'signin');
}
// Anything else is not about the account.
for (const text of ['fetch failed', 'haiku error_max_turns: ', 'The operation was aborted', 'API Error: 529 overloaded', '', null]) {
  assert.equal(limitOf(text, new Date()), null, String(text));
}

// The main account first; the backup while the main one is at its limit.
{
  const now = Date.parse('2026-11-06T23:20:00Z');
  const names = ['main', 'backup'];
  assert.equal(usableAccount(names, {}, now), 'main');
  assert.equal(usableAccount(names, { main: { until: '2026-11-07T01:11:00.000Z' } }, now), 'backup');
  assert.equal(usableAccount(names, { main: { until: '2026-11-07T01:11:00.000Z' } }, Date.parse('2026-11-07T01:12:00Z')), 'main'); // reset
  assert.equal(usableAccount(names, { main: { until: '2026-11-07T01:11:00.000Z' }, backup: { until: '2026-11-07T03:00:00.000Z' } }, now), null);
  assert.equal(usableAccount(['main'], { main: { until: '2026-11-07T01:11:00.000Z' } }, now), null);
}

// What the engine is told when every account is at its limit.
{
  const now = Date.parse('2026-11-06T23:20:00Z');
  const main = { kind: 'limit', until: '2026-11-07T01:11:00.000Z', since: '2026-11-06T23:19:00.000Z' };
  const backup = { kind: 'limit', until: '2026-11-07T03:30:00.000Z', since: '2026-11-06T23:20:00.000Z' };
  assert.equal(reportUntil([main, backup], now), main.until); // the first reset
  assert.equal(reportUntil([backup, main], now), main.until);
  // A signed-out backup does not hide the main account's reset…
  const signedOut = { kind: 'signin', until: '2026-11-07T00:00:00.000Z', since: '2026-11-06T23:20:00.000Z' };
  assert.equal(reportUntil([main, signedOut], now), main.until);
  // …and alone it is simply far away.
  assert.equal(reportUntil([signedOut], now), signedOut.until);

  // No reset time readable: waited for an hour at a time, 2 hours in all.
  const unknown = (since) => ({ kind: 'unknown', until: iso(now + UNKNOWN_RETRY_MS), since });
  assert.equal(reportUntil([unknown(iso(now))], now), iso(now + UNKNOWN_RETRY_MS));
  assert.equal(reportUntil([unknown(iso(now - HOLD_MAX_MS))], now), iso(now + HOLD_MAX_MS + UNKNOWN_RETRY_MS));
  assert.ok(Date.parse(reportUntil([unknown(iso(now - HOLD_MAX_MS))], now)) - now > HOLD_MAX_MS); // too far to wait: Mistral reads

  // `since` is kept while the account stays at its limit without a break.
  const first = limitedEntry(null, { kind: 'unknown', until: iso(now + UNKNOWN_RETRY_MS) }, new Date(now));
  assert.equal(first.since, iso(now));
  const again = limitedEntry(first, { kind: 'unknown', until: iso(now + 2 * UNKNOWN_RETRY_MS) }, new Date(now + UNKNOWN_RETRY_MS + 1000));
  assert.equal(again.since, iso(now));
  const later = limitedEntry(first, { kind: 'limit', until: iso(now + 9 * UNKNOWN_RETRY_MS) }, new Date(now + 5 * UNKNOWN_RETRY_MS));
  assert.equal(later.since, iso(now + 5 * UNKNOWN_RETRY_MS));
}

console.log('readerLimits.test.mjs OK');
