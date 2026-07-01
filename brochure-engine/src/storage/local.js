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
      for (const r of rows.values()) {
        if (r.store === row.store && r.region === row.region && r.id !== row.id) r.is_current = 0;
      }
      rows.set(row.id, { ...row, is_current: 1 });
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
