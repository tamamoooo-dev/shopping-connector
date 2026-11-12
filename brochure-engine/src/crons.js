// crons.js — every schedule the engine runs, in one place.
//
// The runtime cannot read its own wrangler.toml, so the schedules are written
// twice: there (what Cloudflare fires) and here (what scheduled() compares
// `event.cron` against, and what the Ops Console shows). crons.test.mjs reads
// wrangler.toml and fails when the two differ — the copies were kept in step
// by hand before, and a trigger string that matches nothing falls through to
// the pipeline branch of scheduled().

// The PHYSICAL triggers: exactly wrangler.toml [triggers] crons.
// Day NAMES, never numbers: Cloudflare counts Sunday = 1.
export const CRON_TRIGGERS = {
  pipeline: '0 6 * * MON,TUE,WED,THU', // brochure/offers fan-out
  maintenance: '45 5 * * *', // registry maintenance (acts on Mondays)
  enrich: '10,30,50 * * * *', // steady-state vision drain
  minute: '* * * * *', // shared background tick (multiplexed by the clock)
  brochureResume: '*/2 * * * *', // resumable brochure collection + sweeps
};

// The LOGICAL schedules the Ops Console lists (Home → Scheduler, More → Cron
// Monitor): the triggers above plus the jobs multiplexed onto the shared
// ticks. Each name has a source in ops/status.js CRON_SOURCE.
export const CRONS = {
  pipeline: CRON_TRIGGERS.pipeline,
  watches: CRON_TRIGGERS.minute, // durable 07:00/19:00 Riyadh rounds + minute retries
  maintenance: CRON_TRIGGERS.maintenance,
  enrich: CRON_TRIGGERS.enrich, // also on the minute tick at :00/:20/:40
  verification: '5,25,45 * * * *', // stage-two repeated Vision verification (minute tick)
  visionDrain: CRON_TRIGGERS.minute, // Background Manual Vision, while a job runs
  brochureResume: CRON_TRIGGERS.brochureResume, // one safe page batch per pending D4D store
  priceFallback: CRON_TRIGGERS.minute, // vision price lanes, while unpriced flyer items wait
  minimarts: CRON_TRIGGERS.brochureResume, // Mini marts: due shops + queued snaps
  retention: '0 3 * * *', // daily storage retention (retention.js isD1RetentionTick)
  digest: '0 5 * * *', // daily health digest (ops/digest.js DIGEST_HOUR_UTC)
  backup: '0 2 * * SUN', // weekly D1 export to R2 (backup.js isBackupStartTick)
};
