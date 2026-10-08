// backup.js — the WEEKLY D1 EXPORT to R2 (2026-10-08).
//
// WHY. The engine's whole state (offers, Vision reads, the Registry, price
// history, watches) lives in one 429 MB D1 database. D1 Time Travel restores
// any minute of the last 30 days, but nothing older, and nothing at all if the
// database itself is lost. The only copies were two hand-made desktop dumps
// from August. This writes a full logical copy to the engine's R2 bucket every
// Sunday and keeps the last BACKUP_KEEP weeks.
//
// HOW. A Worker has no D1 export call, so the export pages every table by
// rowid into JSONL parts (`backups/d1/<date>/<table>/<n>.jsonl`), a few parts
// per minute tick, resuming from a cursor manifest until done (~20 minutes for
// the whole database). The FTS tables are skipped: they are derived and
// rebuilt from price_identities. The manifest also keeps every table's
// CREATE statement, so restore-d1-backup.mjs can rebuild a database from a set.
//
// It is a rolling copy, not a point-in-time snapshot: rows written while the
// export runs may or may not be in it. For point-in-time recovery inside 30
// days, Time Travel stays the tool; this covers losing the database or
// needing something older.

export const BACKUP_PREFIX = 'backups/d1/';
export const BACKUP_KEEP = 8;
const ACTIVE_KEY = `${BACKUP_PREFIX}active.json`;
const ROWS_PER_PART = 2000;
const SKIP_TABLE = /^(sqlite_|_cf_|d1_)|_fts($|_)/;

// Sunday 02:00 UTC: after the Saturday flyers settle, before the Monday
// maintenance and the Tuesday ingest.
export function isBackupStartTick(value) {
  const at = new Date(value);
  return Number.isFinite(at.getTime())
    && at.getUTCDay() === 0 && at.getUTCHours() === 2 && at.getUTCMinutes() === 0;
}

const readJson = async (bucket, key) => {
  const object = await bucket.get(key);
  return object ? JSON.parse(await object.text()) : null;
};
const writeJson = (bucket, key, value) => bucket.put(key, JSON.stringify(value), {
  httpMetadata: { contentType: 'application/json' },
});

export async function startBackup(db, bucket, { now = new Date() } = {}) {
  const active = await readJson(bucket, ACTIVE_KEY);
  if (active && !active.done) return { started: false, reason: 'already-running', id: active.id };
  const id = now.toISOString().slice(0, 10);
  const { results } = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  const tables = (results || [])
    .filter((row) => !SKIP_TABLE.test(row.name))
    .map((row) => ({ name: row.name, sql: row.sql, cursor: 0, rows: 0, parts: 0, done: false }));
  const indexes = await db.prepare(
    "SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
  ).all();
  const kept = new Set(tables.map((table) => table.name));
  const manifest = {
    id, startedAt: now.toISOString(), finishedAt: null, done: false, tables,
    indexes: (indexes.results || []).filter((index) => kept.has(index.tableName)).map((index) => index.sql),
  };
  await writeJson(bucket, `${BACKUP_PREFIX}${id}/manifest.json`, manifest);
  await writeJson(bucket, ACTIVE_KEY, { id, done: false });
  return { started: true, id, tables: tables.length };
}

// Export up to `maxParts` parts, then save the cursor. Returns the progress.
export async function runBackupStep(db, bucket, { now = new Date(), maxParts = 12, rowsPerPart = ROWS_PER_PART } = {}) {
  const active = await readJson(bucket, ACTIVE_KEY);
  if (!active || active.done) return { idle: true };
  const manifestKey = `${BACKUP_PREFIX}${active.id}/manifest.json`;
  const manifest = await readJson(bucket, manifestKey);
  if (!manifest) return { idle: true, error: 'manifest missing' };
  let parts = 0;
  for (const table of manifest.tables) {
    while (!table.done && parts < maxParts) {
      const { results } = await db.prepare(
        `SELECT rowid AS __rowid, * FROM "${table.name.replace(/"/g, '""')}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      ).bind(table.cursor, rowsPerPart).all();
      const rows = results || [];
      if (rows.length) {
        const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        await bucket.put(`${BACKUP_PREFIX}${active.id}/${table.name}/${String(table.parts).padStart(5, '0')}.jsonl`, body);
        table.cursor = rows[rows.length - 1].__rowid;
        table.rows += rows.length;
        table.parts += 1;
        parts += 1;
      }
      if (rows.length < rowsPerPart) table.done = true;
    }
    if (parts >= maxParts) break;
  }
  manifest.done = manifest.tables.every((table) => table.done);
  if (manifest.done) manifest.finishedAt = now.toISOString();
  await writeJson(bucket, manifestKey, manifest);
  let rotated = [];
  if (manifest.done) {
    await writeJson(bucket, ACTIVE_KEY, { id: active.id, done: true });
    rotated = await rotateBackups(bucket);
  }
  return {
    id: active.id,
    parts,
    done: manifest.done,
    rows: manifest.tables.reduce((n, table) => n + table.rows, 0),
    tablesDone: manifest.tables.filter((table) => table.done).length,
    tables: manifest.tables.length,
    rotated,
  };
}

// Keep the newest BACKUP_KEEP COMPLETE sets. Only sets this module wrote
// (YYYY-MM-DD under BACKUP_PREFIX) are ever touched, and an unfinished set is
// never deleted.
export async function rotateBackups(bucket, { keep = BACKUP_KEEP } = {}) {
  const ids = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: '/', cursor });
    for (const prefix of page.delimitedPrefixes || []) {
      const id = prefix.slice(BACKUP_PREFIX.length).replace(/\/$/, '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(id)) ids.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const complete = [];
  for (const id of ids.sort().reverse()) {
    const manifest = await readJson(bucket, `${BACKUP_PREFIX}${id}/manifest.json`);
    if (manifest?.done) complete.push(id);
  }
  const expired = complete.slice(keep);
  for (const id of expired) {
    let listCursor;
    do {
      const page = await bucket.list({ prefix: `${BACKUP_PREFIX}${id}/`, cursor: listCursor });
      const keys = (page.objects || []).map((object) => object.key);
      if (keys.length) await bucket.delete(keys);
      listCursor = page.truncated ? page.cursor : undefined;
    } while (listCursor);
  }
  return expired;
}
