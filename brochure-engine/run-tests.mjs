// run-tests.mjs — the whole unit suite, one command. `npm test`, and `npm run
// deploy` runs it first (the `predeploy` hook).
//
// WHY THIS EXISTS. Every `*.test.mjs` under src/ is a standalone Node script
// that exits non-zero on failure, which is a good shape — but it meant the only
// way to run "the tests" was to remember all of them. A suite nobody can run in
// one command is a suite that gets partially run, and a deploy path that never
// runs it is not a gate. Discovery is by glob rather than by list so a new test
// file is included by existing, not by someone remembering to register it.
//
// `dev.mjs selftest` is deliberately NOT included: it performs live network
// fetches against real retailer endpoints and is an integration check an
// operator runs on purpose, not something a deploy should depend on.

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const src = join(root, 'src');

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (entry.endsWith('.test.mjs')) out.push(full);
  }
  return out.sort();
}

const files = findTests(src);
if (!files.length) {
  console.error('No test files found under src/ — refusing to report success.');
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const name = relative(root, file).replace(/\\/g, '/');
  console.log(`\n──── ${name}`);
  // cwd is the package root: tests read schema.sql and the migration files by
  // relative path.
  const res = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) failed.push(name);
}

console.log(`\n${'─'.repeat(60)}`);
if (failed.length) {
  console.error(`${failed.length} of ${files.length} test files FAILED:`);
  for (const name of failed) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`✅ ${files.length} test files passed`);
