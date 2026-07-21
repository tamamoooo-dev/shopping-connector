// local-secrets.mjs — Node-only secret loader for the LOCAL scripts
// (backfill-enrich.mjs, calibrate-registry.mjs, deploy verification). Kept OUT
// of src/ so the `node:fs` import never reaches the Workers bundle — the Worker
// gets its secrets from env bindings, never from files.
//
// Files may live in brochure-engine/, the repo root, or the workspace root
// above it (all gitignored): .mistral.key (primary), .mistral.key.backup
// (cold standby), .ingest.secret. The loader walks UP from this file so the
// exact placement doesn't matter. An env var of the same name overrides the
// file, so a one-off `$env:MISTRAL_API_KEY=...` still wins.

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

// The ordered Mistral key list for createKeyChain: primary then cold standby.
// Duplicates/blanks are dropped by the chain, so a missing backup is fine.
export function loadMistralKeys() {
  return [
    readSecret('MISTRAL_API_KEY', '.mistral.key'),
    readSecret('MISTRAL_API_KEY_BACKUP', '.mistral.key.backup'),
  ].filter(Boolean);
}

export function loadIngestSecret() {
  return readSecret('INGEST_SECRET', '.ingest.secret');
}
