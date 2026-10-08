#!/usr/bin/env node
// restore-d1-backup.mjs — turn one weekly R2 export (src/backup.js) back into SQL.
//
//   node restore-d1-backup.mjs <YYYY-MM-DD> <out-dir>
//
// Downloads the set's manifest and every part (their keys are deterministic:
// backups/d1/<id>/<table>/<00000>.jsonl) with the local wrangler, then writes
// <out-dir>/restore.sql: each table's original CREATE statement followed by
// its rows, rowids preserved. Load it into an EMPTY database:
//
//   npx wrangler d1 create brochure-engine-restore
//   npx wrangler d1 execute brochure-engine-restore --remote --file <out-dir>/restore.sql
//
// The FTS index is not in the export (it is derived). Rebuild it afterwards
// with migrate-2026-08-25-price-identity-fts-1.sql and -2.sql. Nothing here
// touches the production database.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [id, outDir] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(id || '') || !outDir) {
  console.error('usage: node restore-d1-backup.mjs <YYYY-MM-DD> <out-dir>');
  process.exit(2);
}
const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const fetchObject = (key, file) => {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync(process.execPath, [wrangler, 'r2', 'object', 'get', `brochure-engine/${key}`, '--file', file, '--remote'], { cwd: here, stdio: 'pipe' });
  return file;
};

const prefix = `backups/d1/${id}`;
const manifest = JSON.parse(readFileSync(fetchObject(`${prefix}/manifest.json`, join(outDir, 'manifest.json')), 'utf8'));
if (!manifest.done) console.warn(`warning: set ${id} did not finish; restoring the tables it completed`);

const sqlValue = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = createWriteStream(join(outDir, 'restore.sql'));
let rows = 0;
for (const table of manifest.tables) {
  out.write(`${table.sql};\n`);
  for (let part = 0; part < table.parts; part += 1) {
    const name = `${String(part).padStart(5, '0')}.jsonl`;
    const file = fetchObject(`${prefix}/${table.name}/${name}`, join(outDir, table.name, name));
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const { __rowid, ...row } = JSON.parse(line);
      const cols = Object.keys(row);
      out.write(`INSERT INTO "${table.name}" (rowid, ${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${[__rowid, ...cols.map((c) => row[c])].map(sqlValue).join(', ')});\n`);
      rows += 1;
    }
  }
  console.log(`${table.name}: ${table.rows} rows in ${table.parts} part(s)`);
}
for (const sql of manifest.indexes || []) out.write(`${sql};\n`);
out.end();
writeFileSync(join(outDir, 'RESTORE.txt'), `Set ${id}: ${rows} rows from ${manifest.tables.length} tables.\nLoad restore.sql into an EMPTY D1 database, then rebuild the FTS index (migrate-2026-08-25-price-identity-fts-1.sql, -2.sql).\n`);
console.log(`wrote ${join(outDir, 'restore.sql')} (${rows} rows)`);
