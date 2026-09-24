// One-time production migration: archive the legacy D1 verification journal in
// R2, verify the uploaded bytes, then retain only compact fingerprint hashes in
// D1. Run with --execute; without it this script performs a read-only dry run.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseVisionVerificationFingerprintHashes,
  visionVerificationFingerprint,
  visionVerificationFingerprintHash,
} from './src/storage/visionVerificationStore.js';

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
    maxBuffer: 128 * 1024 * 1024,
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

async function paged(table, columns, orderBy) {
  const rows = [];
  const pageSize = 4000;
  for (let offset = 0; ; offset += pageSize) {
    const page = d1Rows(
      `SELECT ${columns} FROM ${table} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`,
    );
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseCandidate(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

const timeTravel = wrangler(['d1', 'time-travel', 'info', DATABASE, '--json'], { json: true });
console.log(`D1 Time Travel: ${JSON.stringify(timeTravel)}`);

const queueRows = await paged(
  'offer_vision_verification_queue',
  '*',
  'offer_id',
);
const attemptRows = await paged(
  'offer_vision_verification_attempts',
  '*',
  'offer_id, attempt_no',
);

const attemptsByOffer = new Map();
const archivedAttempts = [];
for (const row of attemptRows) {
  const candidate = parseCandidate(row.candidate_json);
  const fingerprint = row.fingerprint || visionVerificationFingerprint(candidate);
  const fingerprintHash = await visionVerificationFingerprintHash(fingerprint);
  const archived = { ...row, fingerprint, fingerprint_hash: fingerprintHash };
  archivedAttempts.push(archived);
  if (!attemptsByOffer.has(row.offer_id)) attemptsByOffer.set(row.offer_id, []);
  if (fingerprintHash) attemptsByOffer.get(row.offer_id).push(fingerprintHash);
}

const compactRows = [];
for (const row of queueRows) {
  let hashes = attemptsByOffer.get(row.offer_id) || [];
  if (!hashes.length) {
    hashes = parseVisionVerificationFingerprintHashes(row.matched_fingerprint);
  }
  if (!hashes.length && row.matched_fingerprint) {
    const hash = await visionVerificationFingerprintHash(row.matched_fingerprint);
    if (hash) {
      const occurrences = row.status === 'verified'
        ? Math.max(2, Number(row.match_count) || 2)
        : Math.max(1, Number(row.match_count) || 1);
      hashes = Array.from({ length: occurrences }, () => hash);
    }
  }
  const counts = new Map();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) || 0) + 1);
  compactRows.push({
    offerId: row.offer_id,
    hashes,
    bestCount: Math.max(0, ...counts.values()),
  });
}

const generatedAt = new Date().toISOString();
const lines = [JSON.stringify({
  record_type: 'migration_manifest',
  version: 1,
  generated_at: generatedAt,
  database: DATABASE,
  queue_rows: queueRows.length,
  attempt_rows: attemptRows.length,
})];
for (const row of queueRows) lines.push(JSON.stringify({ record_type: 'queue_state', ...row }));
for (const row of archivedAttempts) lines.push(JSON.stringify({ record_type: 'attempt', ...row }));
const archive = `${lines.join('\n')}\n`;
const sha256 = createHash('sha256').update(archive).digest('hex');
const objectKey = `vision-verification/migrations/2026-08-11-legacy-attempts-${sha256.slice(0, 16)}.ndjson`;
console.log(JSON.stringify({
  mode: execute ? 'execute' : 'dry-run',
  queueRows: queueRows.length,
  attemptRows: attemptRows.length,
  archiveBytes: Buffer.byteLength(archive),
  sha256,
  objectKey,
}, null, 2));

if (!execute) process.exit(0);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-verification-r2-'));
try {
  const archivePath = path.join(tempDir, 'legacy-attempts.ndjson');
  const verifyPath = path.join(tempDir, 'downloaded.ndjson');
  const updatesPath = path.join(tempDir, 'compact-queue.sql');
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

  wrangler([
    'd1', 'execute', DATABASE, '--remote',
    '--command', 'DROP INDEX IF EXISTS ix_vision_verification_attempts_fingerprint; DROP TABLE IF EXISTS offer_vision_verification_attempts;',
  ]);

  const statements = [];
  const chunkSize = 200;
  for (let index = 0; index < compactRows.length; index += chunkSize) {
    const chunk = compactRows.slice(index, index + chunkSize);
    const hashCases = chunk.map((row) =>
      `WHEN ${sqlText(row.offerId)} THEN ${sqlText(JSON.stringify(row.hashes))}`).join(' ');
    const countCases = chunk.map((row) =>
      `WHEN ${sqlText(row.offerId)} THEN ${row.bestCount}`).join(' ');
    const ids = chunk.map((row) => sqlText(row.offerId)).join(',');
    statements.push(
      `UPDATE offer_vision_verification_queue
          SET matched_fingerprint=CASE offer_id ${hashCases} ELSE matched_fingerprint END,
              match_count=CASE offer_id ${countCases} ELSE match_count END
        WHERE offer_id IN (${ids});`,
    );
  }
  statements.push(
    `UPDATE offer_vision_verification_queue
        SET status='queued', claimed_by=NULL, claim_until=NULL, claim_token=NULL,
            last_error=COALESCE(last_error, 'claim reset during R2 history migration'),
            updated_at=${sqlText(generatedAt)}
      WHERE status='claimed';`,
  );
  fs.writeFileSync(updatesPath, `${statements.join('\n')}\n`);
  console.log(wrangler([
    'd1', 'execute', DATABASE, '--remote', '--file', updatesPath,
  ]));

  const verification = d1Rows(
    `SELECT
       (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='offer_vision_verification_attempts') AS legacy_tables,
       (SELECT COUNT(*) FROM offer_vision_verification_queue) AS queue_rows,
       (SELECT COUNT(*) FROM offer_vision_verification_queue WHERE matched_fingerprint IS NULL OR json_valid(matched_fingerprint)=0 OR json_type(matched_fingerprint)<>'array') AS invalid_hash_rows,
       (SELECT COUNT(*) FROM offer_vision_verification_queue WHERE status='claimed') AS claimed_rows`,
  )[0];
  if (Number(verification?.legacy_tables) !== 0
      || Number(verification?.invalid_hash_rows) !== 0
      || Number(verification?.claimed_rows) !== 0) {
    throw new Error(`D1 post-migration verification failed: ${JSON.stringify(verification)}`);
  }
  console.log(`D1 compact-state migration verified: ${JSON.stringify(verification)}`);
} finally {
  const resolved = path.resolve(tempDir);
  const safeRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(safeRoot) && path.basename(resolved).startsWith('vision-verification-r2-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
