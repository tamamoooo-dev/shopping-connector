// One-time migration for primary Vision evidence that pre-dates the R2
// journal. The active Worker writes this evidence directly to R2 before D1.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATABASE = 'brochure-engine';
const BUCKET = 'brochure-engine';
const execute = process.argv.includes('--execute');
const projectDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const wranglerBin = [
  path.join(projectDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  path.join(projectDir, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
].find((candidate) => fs.existsSync(candidate));
if (!wranglerBin) throw new Error('Wrangler was not found in the project or its parent workspace');

function wrangler(args, { json = false } = {}) {
  const stdout = execFileSync(process.execPath, [wranglerBin, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return json ? JSON.parse(stdout) : stdout;
}

function d1Rows(sql) {
  const payload = wrangler(
    ['d1', 'execute', DATABASE, '--remote', '--json', '--command', sql],
    { json: true },
  );
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (!result?.success) throw new Error(`D1 query failed: ${JSON.stringify(result)}`);
  return result.results || [];
}

const timeTravel = wrangler(['d1', 'time-travel', 'info', DATABASE, '--json'], { json: true });
console.log(`D1 Time Travel: ${JSON.stringify(timeTravel)}`);

const rows = [];
const pageSize = 3000;
for (let offset = 0; ; offset += pageSize) {
  const page = d1Rows(
    `SELECT * FROM offer_extraction_attempts
      WHERE source='vision'
      ORDER BY offer_id LIMIT ${pageSize} OFFSET ${offset}`,
  );
  rows.push(...page);
  if (page.length < pageSize) break;
}

const generatedAt = new Date().toISOString();
const lines = [JSON.stringify({
  record_type: 'migration_manifest',
  version: 1,
  generated_at: generatedAt,
  database: DATABASE,
  source: 'vision',
  rows: rows.length,
})];
for (const row of rows) lines.push(JSON.stringify({ record_type: 'primary_vision_attempt', ...row }));
const archive = `${lines.join('\n')}\n`;
const sha256 = createHash('sha256').update(archive).digest('hex');
const objectKey = `vision-verification/migrations/2026-08-11-primary-vision-${sha256.slice(0, 16)}.ndjson`;
console.log(JSON.stringify({
  mode: execute ? 'execute' : 'dry-run',
  rows: rows.length,
  archiveBytes: Buffer.byteLength(archive),
  sha256,
  objectKey,
}, null, 2));
if (!execute) process.exit(0);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-vision-r2-'));
try {
  const archivePath = path.join(tempDir, 'primary-vision.ndjson');
  const verifyPath = path.join(tempDir, 'downloaded.ndjson');
  fs.writeFileSync(archivePath, archive);
  console.log(wrangler([
    'r2', 'object', 'put', `${BUCKET}/${objectKey}`,
    '--file', archivePath,
    '--content-type', 'application/x-ndjson',
  ]));
  console.log(wrangler([
    'r2', 'object', 'get', `${BUCKET}/${objectKey}`,
    '--file', verifyPath,
  ]));
  const downloadedHash = createHash('sha256').update(fs.readFileSync(verifyPath)).digest('hex');
  if (downloadedHash !== sha256) {
    throw new Error(`R2 verification failed: expected ${sha256}, received ${downloadedHash}`);
  }
  console.log(`R2 archive verified: sha256=${sha256}`);
  console.log(wrangler([
    'd1', 'execute', DATABASE, '--remote',
    '--command', "DELETE FROM offer_extraction_attempts WHERE source='vision';",
  ]));
  const remaining = d1Rows(
    "SELECT COUNT(*) AS n FROM offer_extraction_attempts WHERE source='vision'",
  )[0];
  if (Number(remaining?.n) !== 0) {
    throw new Error(`D1 still contains primary Vision evidence: ${JSON.stringify(remaining)}`);
  }
  console.log('D1 primary Vision history migration verified: remaining=0');
} finally {
  const resolved = path.resolve(tempDir);
  const safeRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(safeRoot) && path.basename(resolved).startsWith('primary-vision-r2-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
