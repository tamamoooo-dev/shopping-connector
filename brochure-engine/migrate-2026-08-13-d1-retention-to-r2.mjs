// One-time production compaction. Archive every row that will be changed or
// deleted to R2, verify the uploaded bytes, then compact/delete in bounded D1
// batches. Without --execute this is a read-only inventory/archive build.

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

const DAY = 86400000;
const today = new Date().toISOString().slice(0, 10);
// The emergency pass deliberately stays inside the Free-plan 100k daily write
// allowance. It removes the oldest offer generation (28 days) and the runaway
// per-child Ops journal (2 days). The deployed rolling policy then converges
// offers to its tighter 14-day hot window in bounded batches.
const offerCutoff = new Date(Date.now() - 28 * DAY).toISOString().slice(0, 10);
const opsCutoff = new Date(Date.now() - 2 * DAY).toISOString();
const initialCompactionLimit = 5000;
// Large enough to avoid one Wrangler process per few hundred rows, while a
// worst-case page remains comfortably below the CLI buffer and Worker limits.
const pageSize = 2500;

function wrangler(args, { json = false, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const stdout = execFileSync(process.execPath, [wranglerBin, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return json ? JSON.parse(stdout) : stdout;
}

function d1Result(sql) {
  const payload = wrangler(
    ['d1', 'execute', DATABASE, '--remote', '--json', '--command', sql],
    { json: true },
  );
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (!result?.success) throw new Error(`D1 query failed: ${JSON.stringify(result)}`);
  return result;
}

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeLine(fd, hash, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  fs.writeSync(fd, bytes);
  hash.update(bytes);
}

const archiveSpecs = [
  {
    type: 'expired_enrichment',
    initial: '',
    query: (cursor) => `SELECT e.*, o.valid_to AS offer_valid_to
      FROM offer_enrichments e JOIN offers o ON o.id=e.id
     WHERE o.valid_to<${sqlText(today)} AND e.id>${sqlText(cursor)}
     ORDER BY e.id LIMIT ${pageSize}`,
    cursor: (row) => row.id,
  },
  {
    type: 'prunable_offer',
    initial: '',
    query: (cursor) => `SELECT * FROM offers
     WHERE valid_to<${sqlText(offerCutoff)} AND id>${sqlText(cursor)}
     ORDER BY id LIMIT ${pageSize}`,
    cursor: (row) => row.id,
  },
  ...[
    ['offer_extraction_attempt', 'offer_extraction_attempts'],
    ['offer_ocr_queue', 'offer_ocr_queue'],
    ['offer_recovery_queue', 'offer_recovery_queue'],
    ['offer_acceptance_verdict', 'offer_acceptance_verdicts'],
    ['offer_vision_verification_queue', 'offer_vision_verification_queue'],
  ].map(([type, table]) => ({
    type,
    initial: ['', ''],
    query: ([offerId, secondary]) => {
      const secondColumn = table === 'offer_extraction_attempts' ? 'source' : 'offer_id';
      const cursor = table === 'offer_extraction_attempts'
        ? `(x.offer_id>${sqlText(offerId)} OR (x.offer_id=${sqlText(offerId)} AND x.source>${sqlText(secondary)}))`
        : `x.offer_id>${sqlText(offerId)}`;
      return `SELECT x.* FROM ${table} x JOIN offers o ON o.id=x.offer_id
       WHERE o.valid_to<${sqlText(offerCutoff)} AND ${cursor}
       ORDER BY x.offer_id${secondColumn === 'source' ? ', x.source' : ''} LIMIT ${pageSize}`;
    },
    cursor: (row) => table === 'offer_extraction_attempts'
      ? [row.offer_id, row.source]
      : [row.offer_id, ''],
  })),
  {
    type: 'offer_recovery_attempt',
    initial: 0,
    query: (cursor) => `SELECT x.* FROM offer_recovery_attempts x
      JOIN offers o ON o.id=x.offer_id
     WHERE o.valid_to<${sqlText(offerCutoff)} AND x.id>${Number(cursor) || 0}
     ORDER BY x.id LIMIT ${pageSize}`,
    cursor: (row) => row.id,
  },
  {
    type: 'ops_run',
    initial: 0,
    query: (cursor) => `SELECT * FROM ops_runs
     WHERE ts<${sqlText(opsCutoff)} AND id>${Number(cursor) || 0}
     ORDER BY id LIMIT ${pageSize}`,
    cursor: (row) => row.id,
  },
];

const timeTravel = wrangler(['d1', 'time-travel', 'info', DATABASE, '--json'], { json: true });
console.log(`D1 Time Travel: ${JSON.stringify(timeTravel)}`);

const preservedBefore = d1Result(
  `SELECT
    (SELECT COUNT(*) FROM price_history) AS price_history,
    (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM product_sightings) AS product_sightings`,
).results[0];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-retention-r2-'));
const archivePath = path.join(tempDir, 'expired-evidence.ndjson');
const downloadedPath = path.join(tempDir, 'downloaded.ndjson');
let completed = false;

try {
  const fd = fs.openSync(archivePath, 'w');
  const hash = createHash('sha256');
  const counts = {};
  writeLine(fd, hash, {
    record_type: 'migration_manifest',
    version: 1,
    generated_at: new Date().toISOString(),
    database: DATABASE,
    expired_before: today,
    offer_delete_before: offerCutoff,
    ops_delete_before: opsCutoff,
    time_travel: timeTravel,
  });
  try {
    for (const spec of archiveSpecs) {
      let cursor = spec.initial;
      let count = 0;
      for (;;) {
        const rows = d1Result(spec.query(cursor)).results || [];
        for (const row of rows) writeLine(fd, hash, { record_type: spec.type, ...row });
        count += rows.length;
        if (rows.length < pageSize) break;
        cursor = spec.cursor(rows[rows.length - 1]);
        if (count % 5000 === 0) console.log(`archive ${spec.type}: ${count}`);
      }
      counts[spec.type] = count;
      console.log(`archive ${spec.type}: ${count} complete`);
    }
    writeLine(fd, hash, { record_type: 'migration_summary', counts });
  } finally {
    fs.closeSync(fd);
  }

  const sha256 = hash.digest('hex');
  const archiveBytes = fs.statSync(archivePath).size;
  const objectKey = `d1-retention/migrations/2026-08-13/expired-evidence-${sha256.slice(0, 16)}.ndjson`;
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'dry-run',
    today,
    offerCutoff,
    opsCutoff,
    counts,
    archiveBytes,
    sha256,
    objectKey,
    localArchive: archivePath,
  }, null, 2));
  if (!execute) {
    completed = true;
    process.exitCode = 0;
  } else {
    console.log(wrangler([
      'r2', 'object', 'put', `${BUCKET}/${objectKey}`,
      '--file', archivePath,
      '--content-type', 'application/x-ndjson',
    ]));
    console.log(wrangler([
      'r2', 'object', 'get', `${BUCKET}/${objectKey}`,
      '--file', downloadedPath,
    ]));
    const downloadedHash = createHash('sha256').update(fs.readFileSync(downloadedPath)).digest('hex');
    if (downloadedHash !== sha256) {
      throw new Error(`R2 verification failed: expected ${sha256}, received ${downloadedHash}`);
    }
    console.log(`R2 archive verified: key=${objectKey} sha256=${sha256}`);

    const deleteJoined = (table, batch = 2500) => {
      let deleted = 0;
      const offerColumn = table === 'offer_enrichments' ? 'id' : 'offer_id';
      for (;;) {
        const result = d1Result(
          `DELETE FROM ${table} WHERE rowid IN (
             SELECT x.rowid FROM ${table} x JOIN offers o ON o.id=x.${offerColumn}
              WHERE o.valid_to<${sqlText(offerCutoff)} LIMIT ${batch}
           )`,
        );
        const changed = result.meta?.changes || 0;
        deleted += changed;
        if (!changed) return deleted;
      }
    };

    // Delete archive-backed rows first. The database is already at its hard
    // size ceiling, so a rewrite-before-delete can itself fail for lack of a
    // free page even when the rewrite makes each logical value smaller.
    const deleted = {};
    for (const table of [
      'offer_recovery_attempts',
      'offer_recovery_queue',
      'offer_ocr_queue',
      'offer_extraction_attempts',
      'offer_acceptance_verdicts',
      'offer_vision_verification_queue',
      'offer_enrichments',
    ]) {
      deleted[table] = deleteJoined(table);
      console.log(`D1 deleted ${table}: ${deleted[table]}`);
    }

    deleted.ops_runs = 0;
    for (;;) {
      const result = d1Result(
        `DELETE FROM ops_runs WHERE id IN (
           SELECT id FROM ops_runs WHERE ts<${sqlText(opsCutoff)} ORDER BY id LIMIT 2500
         )`,
      );
      const changed = result.meta?.changes || 0;
      deleted.ops_runs += changed;
      if (!changed) break;
    }

    deleted.offers = 0;
    for (;;) {
      const result = d1Result(
        `DELETE FROM offers WHERE rowid IN (
           SELECT rowid FROM offers WHERE valid_to<${sqlText(offerCutoff)} LIMIT 2500
         )`,
      );
      const changed = result.meta?.changes || 0;
      deleted.offers += changed;
      if (!changed) break;
    }

    // Use only the remaining daily-write headroom for the first compacting
    // pass. Normal retention finishes the backlog in later bounded passes.
    const valid = 'json_valid(offer_enrichments.extraction_json)';
    const field = (jsonPath) => `CASE WHEN ${valid} THEN json_extract(offer_enrichments.extraction_json, '${jsonPath}') ELSE NULL END`;
    let compacted = 0;
    while (compacted < initialCompactionLimit) {
      const batch = Math.min(2500, initialCompactionLimit - compacted);
      const result = d1Result(
        `UPDATE offer_enrichments
            SET extraction_json=json_object(
                  '_d1_compact_version',1,
                  '_r2_archive',${sqlText(objectKey)},
                  'unit',${field('$.unit')},
                  'package_type',${field('$.package_type')},
                  '_arabic_builder',json_object(
                    'status',${field('$._arabic_builder.status')},
                    'built_arabic',${field('$._arabic_builder.built_arabic')},
                    'display_arabic',${field('$._arabic_builder.display_arabic')}
                  )
                ),
                identity_candidate=CASE WHEN EXISTS (
                  SELECT 1 FROM product_sightings s
                   WHERE s.offer_id=offer_enrichments.id
                ) THEN NULL ELSE identity_candidate END
          WHERE rowid IN (
            SELECT e.rowid FROM offer_enrichments e
            JOIN offers o ON o.id=e.id
            WHERE o.valid_to<${sqlText(today)}
              AND e.extraction_json IS NOT NULL
              AND (NOT json_valid(e.extraction_json)
                   OR COALESCE(json_extract(e.extraction_json,'$._d1_compact_version'),0)<1)
            ORDER BY o.valid_to,e.id LIMIT ${batch}
          )`,
      );
      const changed = result.meta?.changes || 0;
      compacted += changed;
      if (!changed) break;
      if (compacted % 5000 === 0) console.log(`D1 compacted: ${compacted}`);
    }

    const verification = d1Result(
      `SELECT
        (SELECT COUNT(*) FROM offers WHERE valid_to<${sqlText(offerCutoff)}) AS old_offers,
        (SELECT COUNT(*) FROM ops_runs WHERE ts<${sqlText(opsCutoff)}) AS old_ops,
        (SELECT COUNT(*) FROM offer_enrichments e JOIN offers o ON o.id=e.id
          WHERE o.valid_to<${sqlText(today)} AND e.extraction_json IS NOT NULL
            AND (NOT json_valid(e.extraction_json)
                 OR COALESCE(json_extract(e.extraction_json,'$._d1_compact_version'),0)<1)) AS verbose_expired,
        (SELECT COUNT(*) FROM price_history) AS price_history,
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM product_sightings) AS product_sightings`,
    ).results[0];
    if (Number(verification.old_offers) !== 0
        || Number(verification.old_ops) !== 0
        || Number(verification.verbose_expired)
             > Number(counts.expired_enrichment) - Number(deleted.offer_enrichments) - compacted
        || Number(verification.price_history) < Number(preservedBefore.price_history)
        || Number(verification.products) < Number(preservedBefore.products)
        || Number(verification.product_sightings) < Number(preservedBefore.product_sightings)) {
      throw new Error(`Post-migration verification failed: ${JSON.stringify({ preservedBefore, verification })}`);
    }
    console.log(JSON.stringify({ compacted, deleted, preservedBefore, verification }, null, 2));
    completed = true;
  }
} finally {
  if (completed) {
    const resolved = path.resolve(tempDir);
    const safeRoot = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(safeRoot) && path.basename(resolved).startsWith('d1-retention-r2-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } else {
    console.error(`Migration stopped; local archive retained at ${archivePath}`);
  }
}
