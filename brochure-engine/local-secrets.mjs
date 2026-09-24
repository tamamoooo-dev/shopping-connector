// local-secrets.mjs — Node-only secret loader for the LOCAL scripts
// (backfill-enrich.mjs, calibrate-registry.mjs, deploy verification). Kept OUT
// of src/ so the `node:fs` import never reaches the Workers bundle — the Worker
// gets its secrets from env bindings, never from files.
//
// Files may live in brochure-engine/, the repo root, or the workspace root
// above it (all gitignored). The current model-scoped names are:
//   .mistral medium.key[.backup|.backup2.txt] — three balanced Medium slots
//   .mistral small.key / .mistral small 2.key / .mistral small 3.key
//                                            — three Small slots (failover)
//   .mistral ocr.key                         — OCR only
// Legacy .mistral.key[.backup] remains readable during rotation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Candidate dirs: this dir, then each parent up to 3 levels (brochure-engine/
// -> serverless-connector/ -> workspace root). First readable match wins.
const CANDIDATE_DIRS = (() => {
  const dirs = [];
  let d = HERE;
  for (let i = 0; i < 4; i += 1) {
    dirs.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs;
})();

function readFile(name) {
  for (const dir of CANDIDATE_DIRS) {
    try {
      const v = readFileSync(join(dir, name), 'utf8').trim();
      if (v) return v;
    } catch {
      /* try the next candidate dir */
    }
  }
  return null;
}

// Env override first (explicit beats stored), then the file.
export function readSecret(envName, fileName) {
  return process.env[envName] || readFile(fileName);
}

export function loadMistralPools() {
  return {
    medium: [
      readSecret('MISTRAL_MEDIUM_API_KEY_1', '.mistral medium.key')
        || readSecret('MISTRAL_API_KEY', '.mistral.key'),
      readSecret('MISTRAL_MEDIUM_API_KEY_2', '.mistral medium.key.backup')
        || readSecret('MISTRAL_API_KEY_BACKUP', '.mistral.key.backup'),
      readSecret('MISTRAL_MEDIUM_API_KEY_3', '.mistral medium.key.backup2.txt'),
    ].filter(Boolean),
    small: [
      readSecret('MISTRAL_SMALL_API_KEY', '.mistral small.key'),
      readSecret('MISTRAL_SMALL_API_KEY_BACKUP', '.mistral small 2.key'),
      readSecret('MISTRAL_SMALL_API_KEY_BACKUP_2', '.mistral small 3.key'),
    ].filter(Boolean),
    ocr: [readSecret('MISTRAL_OCR_API_KEY', '.mistral ocr.key')].filter(Boolean),
  };
}

// Backward-compatible helper used by the Medium backfill/validation scripts.
export function loadMistralKeys(pool = 'medium') {
  return loadMistralPools()[pool] || [];
}

export function loadIngestSecret() {
  return readSecret('INGEST_SECRET', '.ingest.secret');
}
