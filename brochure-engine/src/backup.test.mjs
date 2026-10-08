// backup.test.mjs — the weekly D1 export, against real SQLite and a memory R2.
import assert from 'node:assert/strict';
import { createSqliteD1 } from './storage/testSqliteD1.mjs';
import { BACKUP_PREFIX, isBackupStartTick, rotateBackups, runBackupStep, startBackup } from './backup.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) { objects.set(key, String(body)); },
    async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
    async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
    async list({ prefix = '', delimiter, cursor } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const prefixes = new Set();
      const direct = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
        else direct.push({ key });
      }
      return { objects: direct, delimitedPrefixes: [...prefixes], truncated: false };
    },
  };
}

ok(isBackupStartTick(Date.UTC(2026, 9, 11, 2, 0)), 'Sunday 02:00 UTC starts the export');
ok(!isBackupStartTick(Date.UTC(2026, 9, 12, 2, 0)) && !isBackupStartTick(Date.UTC(2026, 9, 11, 2, 1)), 'no other minute does');

const { db, raw, close } = createSqliteD1();
raw.exec(`
  CREATE TABLE offers (id TEXT PRIMARY KEY, name TEXT, price REAL);
  CREATE TABLE watches (id TEXT PRIMARY KEY, query TEXT);
  CREATE VIRTUAL TABLE price_identities_fts USING fts5(text);
`);
for (let i = 0; i < 25; i += 1) raw.prepare('INSERT INTO offers VALUES (?, ?, ?)').run(`o${i}`, `حليب ${i}`, i + 0.5);
raw.prepare('INSERT INTO watches VALUES (?, ?)').run('w1', 'milk');

const bucket = memoryBucket();
const start = await startBackup(db, bucket, { now: new Date('2026-10-11T02:00:00Z') });
ok(start.started && start.id === '2026-10-11', 'a set is named by its date');
ok(start.tables === 2, 'derived FTS tables and their shadow tables are skipped');
ok(!(await startBackup(db, bucket)).started, 'a second start while one runs does nothing');

let step;
let ticks = 0;
do {
  step = await runBackupStep(db, bucket, { maxParts: 2, rowsPerPart: 10 });
  ticks += 1;
} while (!step.done && ticks < 10);
ok(step.done && ticks === 2, 'the export resumes from its cursor across ticks until done');
ok(step.rows === 26, 'every row of every table is exported');

const manifest = JSON.parse(bucket.objects.get(`${BACKUP_PREFIX}2026-10-11/manifest.json`));
ok(manifest.done && manifest.tables.find((t) => t.name === 'offers').sql.startsWith('CREATE TABLE offers'), 'the manifest keeps each CREATE statement for restore');
const lines = [0, 1, 2].flatMap((n) => (bucket.objects.get(`${BACKUP_PREFIX}2026-10-11/offers/0000${n}.jsonl`) || '').trim().split('\n').filter(Boolean));
ok(lines.length === 25 && JSON.parse(lines[24]).name === 'حليب 24', 'parts are ordered JSONL with Arabic text intact');
ok((await runBackupStep(db, bucket)).idle, 'a finished export goes idle');

// Rotation keeps the newest complete sets and never touches unfinished or
// foreign prefixes.
for (const id of ['2026-08-02', '2026-08-09', '2026-08-16']) {
  bucket.objects.set(`${BACKUP_PREFIX}${id}/manifest.json`, JSON.stringify({ id, done: true, tables: [] }));
  bucket.objects.set(`${BACKUP_PREFIX}${id}/offers/00000.jsonl`, '{}\n');
}
bucket.objects.set(`${BACKUP_PREFIX}2026-07-26/manifest.json`, JSON.stringify({ done: false, tables: [] }));
bucket.objects.set('brochures/lulu/meta.json', '{}');
const expired = await rotateBackups(bucket, { keep: 2 });
ok(JSON.stringify(expired) === JSON.stringify(['2026-08-09', '2026-08-02']), 'only the oldest complete sets beyond the limit expire');
ok(!bucket.objects.has(`${BACKUP_PREFIX}2026-08-02/offers/00000.jsonl`) && bucket.objects.has(`${BACKUP_PREFIX}2026-08-16/manifest.json`), 'an expired set is removed whole, a kept one stays');
ok(bucket.objects.has(`${BACKUP_PREFIX}2026-07-26/manifest.json`) && bucket.objects.has('brochures/lulu/meta.json'), 'unfinished sets and other data are never touched');

close();
console.log(`backup.test: ${passed} passed, 0 failed`);
