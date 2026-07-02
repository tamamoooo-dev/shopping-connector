// storage/local.js — zero-dependency local implementations of the storage
// interfaces, used ONLY by dev.mjs to run the full pipeline end-to-end without
// provisioning any cloud resources. They implement the exact same interfaces as
// the R2/D1 backends, so the engine, pipeline and collectors run unchanged.
//
// Not part of the deployed Worker.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// --- ObjectStore: files under a data directory --------------------------------
export function createFsObjectStore(rootDir) {
  const metaExt = '.ct'; // side-car storing the content-type
  return {
    async put(key, bytes, { contentType } = {}) {
      const path = join(rootDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(bytes));
      await writeFile(path + metaExt, contentType || 'application/octet-stream');
    },
    async get(key) {
      const path = join(rootDir, key);
      if (!existsSync(path)) return null;
      const bytes = new Uint8Array(await readFile(path));
      let contentType = 'application/octet-stream';
      if (existsSync(path + metaExt)) contentType = (await readFile(path + metaExt, 'utf8')).trim();
      return { bytes, contentType };
    },
  };
}

// --- MetadataStore: an in-memory table with the same semantics as D1 ----------
export function createMemoryMetadataStore() {
  const rows = new Map(); // id -> row
  return {
    async existsByChecksum(checksum) {
      for (const r of rows.values()) if (r.checksum === checksum) return true;
      return false;
    },
    async upsert(row) {
      // Same semantics as D1: insert-or-refresh one row as current; superseding
      // prior rows is the ingest run's job via setCurrent() (a store may hold
      // several concurrent current flyers).
      rows.set(row.id, { ...row, is_current: 1 });
    },
    async setCurrent(store, region, checksums, { supersedeOthers = true } = {}) {
      if (!checksums || !checksums.length) return;
      const keep = new Set(checksums);
      for (const r of rows.values()) {
        if (r.store !== store || r.region !== region) continue;
        if (keep.has(r.checksum)) r.is_current = 1;
        else if (supersedeOthers) r.is_current = 0;
      }
    },
    async getBySourceUrl(store, region, sourceUrl) {
      if (!sourceUrl) return null;
      const hits = [...rows.values()]
        .filter((r) => r.store === store && r.region === region && r.source_url === sourceUrl)
        .sort((a, b) => (b.detected_at || '').localeCompare(a.detected_at || ''));
      return hits[0] || null;
    },
    async getCurrent(store, region) {
      return [...rows.values()].filter((r) => r.store === store && r.region === region && r.is_current);
    },
    async listCurrent() {
      return [...rows.values()]
        .filter((r) => r.is_current)
        .sort((a, b) => (a.store + a.region).localeCompare(b.store + b.region));
    },
    async getHistory(store, region) {
      return [...rows.values()]
        .filter((r) => r.store === store && r.region === region)
        .sort((a, b) => b.edition.localeCompare(a.edition));
    },
  };
}

// --- PriceStore: an in-memory table with the same semantics as the D1 impl ----
export function createMemoryPriceStore() {
  const rows = new Map(); // id -> point
  return {
    async record(point) {
      if (rows.has(point.id)) return { status: 'deduped' };
      rows.set(point.id, { ...point });
      return { status: 'new' };
    },
    async getHistory(product) {
      return [...rows.values()]
        .filter((p) => p.product === product)
        .sort((a, b) => b.edition.localeCompare(a.edition) || a.store.localeCompare(b.store));
    },
    async getLowest(product) {
      const points = [...rows.values()].filter((p) => p.product === product);
      if (!points.length) return null;
      // Lowest price; ties keep the earliest observation (first time it hit the low).
      return points.sort((a, b) => a.price - b.price || a.observedAt.localeCompare(b.observedAt))[0];
    },
    async listProducts() {
      return [...new Set([...rows.values()].map((p) => p.product))].sort();
    },
  };
}
