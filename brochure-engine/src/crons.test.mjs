// crons.test.mjs — the cron list in code must match what Cloudflare fires.
// Run: node src/crons.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CRONS, CRON_TRIGGERS } from './crons.js';
import { CRON_SOURCE, cronNext } from './ops/status.js';
import { isD1RetentionTick } from './retention.js';
import { isBackupStartTick } from './backup.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

// The [triggers] crons array of wrangler.toml: quoted strings, comments dropped.
function wranglerTriggers() {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = toml.indexOf('\n[triggers]\n');
  assert.ok(start >= 0, 'wrangler.toml has a [triggers] block');
  const open = toml.indexOf('crons = [', start);
  const close = toml.indexOf('\n]', open);
  assert.ok(open > start && close > open, 'the crons array is found');
  return toml
    .slice(open, close)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => line.slice(1, line.indexOf('"', 1)));
}

test('the physical triggers are exactly wrangler.toml [triggers]', () => {
  assert.deepEqual([...wranglerTriggers()].sort(), Object.values(CRON_TRIGGERS).sort());
});

test('no two triggers share an expression (scheduled() tells them apart by it)', () => {
  const exprs = Object.values(CRON_TRIGGERS);
  assert.equal(new Set(exprs).size, exprs.length);
});

test('weekdays are written as names (Cloudflare counts Sunday = 1)', () => {
  for (const [name, expr] of Object.entries({ ...CRON_TRIGGERS, ...CRONS })) {
    const dow = expr.trim().split(/\s+/)[4];
    assert.ok(!/\d/.test(dow), `${name}: "${expr}" uses a weekday number`);
  }
});

test('every listed schedule parses and has a next fire', () => {
  const from = new Date('2026-11-12T00:00:00Z');
  for (const [name, expr] of Object.entries(CRONS)) {
    assert.ok(cronNext(expr, from) instanceof Date, `${name}: "${expr}" has no next fire`);
  }
});

test('every listed schedule has a Cron Monitor source', () => {
  for (const name of Object.keys(CRONS)) {
    assert.ok(CRON_SOURCE[name], `${name} has no CRON_SOURCE entry in ops/status.js`);
  }
});

test('the listed retention and backup times are the ticks that run them', () => {
  const retention = cronNext(CRONS.retention, new Date('2026-11-12T00:00:00Z'));
  assert.equal(retention.toISOString(), '2026-11-12T03:00:00.000Z');
  assert.equal(isD1RetentionTick(retention.getTime()), true);
  const backup = cronNext(CRONS.backup, new Date('2026-11-12T00:00:00Z'));
  assert.equal(backup.toISOString(), '2026-11-15T02:00:00.000Z');
  assert.equal(isBackupStartTick(backup.getTime()), true);
});

console.log(`\ncrons: ${passed} passed`);
