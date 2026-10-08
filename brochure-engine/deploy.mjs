#!/usr/bin/env node
// deploy.mjs — the ONE way to deploy the brochure engine.
//
// Production was deployed twice from uncommitted working trees (2026-09-10,
// 2026-09-30), so nothing in git described what was running. This script
// refuses to deploy anything that is not a pushed commit on main, runs the
// full suite, and stamps the deployment with the commit, so
// `wrangler deployments list` always names the code that runs.
//
//   node deploy.mjs            # production (the default environment)
//   node deploy.mjs --staging  # brochure-engine-staging
//   node deploy.mjs --check    # run every gate, deploy nothing
//
// Escape hatch for an emergency rollback only: wrangler rollback <version>.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const staging = args.has('--staging');
const checkOnly = args.has('--check');

const git = (...a) => execFileSync('git', a, { cwd: here, encoding: 'utf8' }).trim();
function fail(message) {
  console.error(`deploy refused: ${message}`);
  process.exit(1);
}

// 1. A clean tree: tracked edits AND untracked files under brochure-engine/
//    (an untracked source file is exactly what the 2026-09-10 tree had).
const dirty = git('status', '--porcelain', '--untracked-files=all', '--', '.');
if (dirty) fail(`uncommitted changes in brochure-engine/:\n${dirty}`);

// 2. On main, and main is pushed.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (!staging && branch !== 'main') fail(`production deploys come from main (on ${branch})`);
git('fetch', '--quiet', 'origin');
const head = git('rev-parse', 'HEAD');
const upstream = git('rev-parse', staging ? 'HEAD@{upstream}' : 'origin/main');
if (head !== upstream) fail(`HEAD ${head.slice(0, 7)} is not the pushed ${staging ? 'upstream' : 'origin/main'} ${upstream.slice(0, 7)}`);

// 3. The full suite.
const tests = spawnSync(process.execPath, ['run-tests.mjs'], { cwd: here, stdio: 'inherit' });
if (tests.status !== 0) fail('tests failed');

// 4. A local wrangler (never one borrowed from another checkout).
const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!existsSync(wrangler)) fail('wrangler is not installed here — run `npm ci` in brochure-engine/');

const message = `${head.slice(0, 7)} ${git('log', '-1', '--format=%s')}`.slice(0, 100);
const deployArgs = [wrangler, 'deploy', staging ? '--env=staging' : '--env=', '--message', message];
if (checkOnly) {
  console.log(`\nall gates passed; would run: wrangler ${deployArgs.slice(1).join(' ')}`);
  process.exit(0);
}
const deployed = spawnSync(process.execPath, deployArgs, { cwd: here, stdio: 'inherit' });
process.exit(deployed.status ?? 1);
