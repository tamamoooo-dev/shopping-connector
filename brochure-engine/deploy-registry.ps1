# deploy-registry.ps1 — one-command deploy of the Vision+Registry milestone
# (HANDOFF §11 TODO 0, steps 1–3 + verification). Run from brochure-engine/:
#   powershell -ExecutionPolicy Bypass -File .\deploy-registry.ps1
#
# Idempotent: the ALTERs error harmlessly when the column exists; the registry
# migration is IF NOT EXISTS throughout; deploy is deploy.
# AFTER this script: (4) $env:MISTRAL_API_KEY='<key>'; node backfill-enrich.mjs
# and (5) hammer POST /resolve (X-Ingest-Secret) until /registry/stats shows
# unresolved≈0 — both need secrets this script deliberately does not touch.

$ErrorActionPreference = 'Continue'
$engine = 'https://brochure-engine.tamamoooo.workers.dev'

Write-Host "== 1/4 offer_enrichments columns (ALTERs; 'duplicate column' = already done)"
npx wrangler d1 execute brochure-engine --remote --command "ALTER TABLE offer_enrichments ADD COLUMN match_text TEXT"
npx wrangler d1 execute brochure-engine --remote --command "ALTER TABLE offer_enrichments ADD COLUMN mint_verdict TEXT"

Write-Host "== 2/4 registry tables (IF NOT EXISTS)"
npx wrangler d1 execute brochure-engine --remote --file ./migrate-2026-07-registry.sql
if (-not $?) { Write-Host 'registry migration FAILED — stopping before deploy'; exit 1 }

Write-Host "== 3/4 verify schema"
npx wrangler d1 execute brochure-engine --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('products','product_tokens','product_sightings')"

Write-Host "== 4/4 wrangler deploy"
npx wrangler deploy
if (-not $?) { Write-Host 'deploy FAILED'; exit 1 }

Write-Host "== production checks (public reads)"
Write-Host '--- /registry/stats (expect pipelineDefault ocr, zeroed products/bands)'
curl.exe -s "$engine/registry/stats"
Write-Host ''
Write-Host '--- /offers?q=water&pipeline=vision (expect pipeline:"vision" top-level)'
curl.exe -s "$engine/offers?q=water&pipeline=vision&limit=1" | Select-Object -First 1
Write-Host ''
Write-Host '--- /prices?q=water&pipeline=vision (expect pipeline:"vision", empty until resolution runs)'
curl.exe -s "$engine/prices?q=water&pipeline=vision"
Write-Host ''
Write-Host 'DONE. Next: backfill-enrich.mjs (needs MISTRAL_API_KEY), then POST /resolve (needs INGEST_SECRET).'
