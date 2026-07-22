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

# Production authentication preflight. Local developer credentials are never
# consulted; the deployment secret store is the only authority and must inject
# this distinct variable because Cloudflare never returns secret values.
$productionIngestSecret = [Environment]::GetEnvironmentVariable('PRODUCTION_INGEST_SECRET')
if ([string]::IsNullOrWhiteSpace($productionIngestSecret)) {
  Write-Error 'Configuration error: PRODUCTION_INGEST_SECRET is required from the production deployment secret store. No deployment or authenticated request was attempted.'
  exit 2
}

# Validate the credential on a protected read-only endpoint before any schema
# write or Worker deployment. Stale credentials therefore fail safely before
# production changes.
try {
  $authProbe = Invoke-WebRequest -Uri "$engine/registry/review?limit=1" -Method Get -Headers @{ 'X-Ingest-Secret' = $productionIngestSecret } -TimeoutSec 30 -UseBasicParsing
  if ($authProbe.StatusCode -ne 200) {
    Write-Error "Configuration error: production authentication preflight returned HTTP $($authProbe.StatusCode). No deployment was attempted."
    exit 2
  }
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401 -or $status -eq 403) {
    Write-Error 'Configuration error: PRODUCTION_INGEST_SECRET was rejected by production. Refresh the deployment secret-store value. No deployment was attempted.'
    exit 2
  }
  Write-Error "Configuration error: production authentication preflight could not complete: $($_.Exception.Message). No deployment was attempted."
  exit 2
}

Write-Host '== 0/4 production authentication preflight passed'

Write-Host "== 1/4 offer_enrichments columns (ALTERs; 'duplicate column' = already done)"
npx wrangler d1 execute brochure-engine --remote --command "ALTER TABLE offer_enrichments ADD COLUMN match_text TEXT"
npx wrangler d1 execute brochure-engine --remote --command "ALTER TABLE offer_enrichments ADD COLUMN mint_verdict TEXT"

Write-Host "== 2/4 registry tables (IF NOT EXISTS)"
npx wrangler d1 execute brochure-engine --remote --file ./migrate-2026-07-registry.sql
if (-not $?) { Write-Host 'registry migration FAILED — stopping before deploy'; exit 1 }

Write-Host "== 3/4 verify schema"
npx wrangler d1 execute brochure-engine --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('products','product_tokens','product_sightings')"

Write-Host "== 4/4 wrangler deploy (explicit top-level production target)"
npx wrangler deploy --env=""
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
