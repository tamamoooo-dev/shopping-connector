// humanReview.test.mjs — S7: the Human Review processor and its review surface.
//
// WHAT THESE TESTS DEFEND:
//
//  1. THE PLATFORM PROPERTY WAS REAL. `human` reaches production through the
//     same runner, queue and commit boundary as every machine processor, with
//     no queue change, no schema change and no migration behind it (C-9).
//  2. THE AUTO FAIL-SAFE. `human` is safe to arm in an unattended policy: with
//     no submitted decision it DECLINES, which spends nothing and — critically —
//     consumes no attempt, so an armed drain cannot walk reviewable items into
//     `exhausted` while nobody is looking.
//  3. THE UX CONTRACT. The review plan shows what is BLOCKING and nothing else,
//     and `price` is never offered as an editable field, because M1 reads the
//     offer row and §44 keeps extracted prices out of the commerce path.
//  4. ONLY S4 CLOSES. An approval that does not clear the gate leaves the item
//     queued and says so, rather than flattering the reviewer.

import assert from 'node:assert/strict';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { createRecoveryQueue, RECOVERY_STATUS } from '../storage/recoveryQueue.js';
import { createSqliteD1, insertOffers } from '../storage/testSqliteD1.mjs';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import { evaluateLegacyBusinessAcceptance as evaluateBusinessAcceptance } from '../offers/businessAcceptance.js';
import { recoveryAdmission, servable } from '../offers/enrich.js';
import { EXTRACTION_PROVENANCE } from '../offers/smartExtraction.js';
import { REVIEW_DECISION } from './registry.js';
import { recoveryRegistry } from './processors/index.js';
import human, { buildReviewPlan, HUMAN_PROCESSOR_ID } from './processors/human.js';
import { runRecovery } from './runner.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S7 Human Review processor (C-7, C-8, C-9):');

const SCHEMA = [
  'schema.sql',
  'migrate-2026-07-vision-first-queue.sql',
  'migrate-2026-07-26-acceptance-verdicts.sql',
  'migrate-2026-07-27-recovery-queue.sql',
];
const AT = '2026-07-20T01:00:00.000Z';
const TODAY = '2026-07-20';
const OFFER = 'a:r:d4d:1';

const sizeless = buildStructuredProduct({
  name_en: 'Arwa Bottled Water', name_ar: 'مياه أروى', brand: 'Arwa',
});

// A primary Vision attempt that ACCEPTED name_en — the field C-7 protects.
//
// `acceptedFields` MUST agree with the per-field statuses below: production
// derives it from exactly them (`EXTRACTION_FIELDS.filter(status === 'Accepted')`),
// and `mergeValidatedExtractions` only promotes an Accepted field into `final`.
// A fixture that disagrees builds a merge whose values have no matching verdict,
// which makes corroboration null and the row silently non-servable — a bug in
// the test, not in the gate.
const priorValidation = {
  acceptedFields: ['name_en', 'name_ar', 'brand'],
  fields: {
    name_en: { status: 'Accepted', value: 'Arwa Bottled Water' },
    name_ar: { status: 'Accepted', value: 'مياه أروى' },
    brand: { status: 'Accepted', value: 'Arwa' },
    size: { status: 'Missing', value: null },
    pack_count: { status: 'Missing', value: null },
  },
  triggerReasons: [],
};

// One offer, queued because comparable_quantity is missing — the exact shape a
// reviewer meets in production.
async function seedQueued(offerOverrides = {}) {
  const { db, raw, close } = createSqliteD1(SCHEMA);
  insertOffers(raw, [{ id: OFFER, ...offerOverrides }]);
  const store = createD1EnrichStore(db);
  const queue = createRecoveryQueue(db);
  const offer = { price: 5.99, currency: 'SAR', ...offerOverrides };
  const verdict = evaluateBusinessAcceptance({
    offer, acceptedFields: ['name_en'], structured: sizeless,
  });
  const canonicalRow = {
    id: OFFER, name: 'Arwa Bottled Water', name_ar: 'مياه أروى',
    corroboration: 1, enriched_at: AT, structured_product: sizeless,
  };
  await store.saveVisionOutcome({
    attempt: {
      offerId: OFFER, source: 'vision', output: { name_en: 'Arwa Bottled Water' },
      validation: priorValidation, confidence: null, model: 'primary',
      cropUrl: 'https://cdn.example/crop.jpg', accepted: 1, attemptedAt: AT,
    },
    canonicalRow,
    acceptance: verdict,
    recovery: recoveryAdmission({ canonicalRow, acceptance: verdict }),
  });
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.QUEUED, 'seed precondition');
  return { store, queue, raw, close };
}

const review = (fields, actor = 'dev@example') => ({
  review: { decision: REVIEW_DECISION.APPROVE, fields, actor },
});

// --- 1. it is a first-class processor ---------------------------------------

await test('human is registered alongside the machine rungs, and costs no provider call', () => {
  const ids = recoveryRegistry.ids();
  // NOT a fixed list: machine rungs are expected to be added (C-9's whole
  // point), and a literal array would make every future plug-in look like a
  // regression here. What must hold is the ORDER PROPERTY — human is the
  // terminal rung and stays last — plus at least one machine rung before it.
  assert.equal(ids.at(-1), HUMAN_PROCESSOR_ID, 'the terminal rung stays last');
  assert.ok(ids.includes('ocr'));
  assert.ok(ids.length > 1, 'at least one machine rung precedes the human one');
  const described = recoveryRegistry.describe().find((p) => p.id === HUMAN_PROCESSOR_ID);
  assert.equal(described.kind, 'human');
  assert.equal(described.credential, null, 'needs no provider, so it is handed no key chain');
  assert.equal(described.costHint.requests, 0);
  assert.equal(described.interactive, true, 'declares a review surface');
  // A machine rung must NOT advertise one, or the console would offer a review
  // screen for a processor that has nothing to review. Asserted over ALL of
  // them, so a future plug-in that wrongly declares `reviewPlan` is caught.
  for (const p of recoveryRegistry.describe()) {
    if (p.id === HUMAN_PROCESSOR_ID) continue;
    assert.equal(p.interactive, false, `${p.id} must not advertise a review surface`);
    assert.equal(p.kind, 'machine', `${p.id} must be bound by C-7`);
  }
});

// --- 2. the Auto fail-safe ---------------------------------------------------

await test('AUTO-SAFE: with no submitted decision it declines and consumes NO attempt', async () => {
  const { store, queue, close } = await seedQueued();
  const report = await runRecovery(
    { queue, processor: human, enrichStore: store },
    { currentOn: TODAY },
  );
  assert.equal(report.declined, 1);
  assert.equal(report.attempted, 0);
  assert.equal(report.failed, 0, 'a missing decision is a state, never an error');
  const item = await queue.get(OFFER);
  assert.equal(item.attempts, 0, 'an unattended drain must not spend the review budget');
  assert.equal(item.status, RECOVERY_STATUS.QUEUED);
  close();
});

await test('an approval carrying no field edits is declined, not committed', async () => {
  const { store, queue, close } = await seedQueued();
  const report = await runRecovery(
    { queue, processor: human, enrichStore: store, ctx: review({}) },
    { currentOn: TODAY },
  );
  assert.equal(report.declined, 1);
  assert.equal((await queue.get(OFFER)).attempts, 0);
  close();
});

// --- 3. the UX contract: only what blocks -----------------------------------

await test('the review plan offers ONLY the blocking fields; the rest is Advanced', async () => {
  const { queue, close } = await seedQueued();
  const plan = buildReviewPlan(await queue.get(OFFER));
  assert.deepEqual(plan.blocking, ['comparable_quantity']);
  assert.deepEqual(plan.fields.map((f) => f.field), ['size', 'pack_count'],
    'exactly the fields that can move the blocking condition');
  // Brand is the worked example: the Quality Gate cares, S4 does not, so editing
  // it cannot close the item and it must not compete for the reviewer's eye.
  assert.ok(plan.advanced.some((f) => f.field === 'brand'));
  assert.ok(!plan.fields.some((f) => f.field === 'brand'));
  assert.ok(plan.advanced.every((f) => !plan.fields.some((b) => b.field === f.field)),
    'a field is never in both lists');
  assert.equal(plan.imageUrl, 'https://cdn.example/crop.jpg', 'the evidence is in the payload');
  assert.equal(plan.resolvable, true);
  close();
});

await test('existing values are PREFILLED from the attempt journal', async () => {
  const { queue, close } = await seedQueued();
  const plan = buildReviewPlan(await queue.get(OFFER));
  const byField = Object.fromEntries(
    [...plan.fields, ...plan.advanced].map((f) => [f.field, f.value]),
  );
  assert.equal(byField.name_en, 'Arwa Bottled Water');
  assert.equal(byField.brand, 'Arwa', 'read out of the journal, which the canonical row does not carry');
  assert.equal(byField.size, null, 'the missing one is genuinely empty');
  close();
});

await test('PRICE is blocking-but-unfixable, never an editable field (C-2, §44)', async () => {
  // An offer with no usable price: M1 tests `price > 0`, and `offers.price` is
  // NOT NULL, so 0 is what "the feed gave us nothing" actually looks like in the
  // table. No amount of reviewing can fix it — price comes from the retailer
  // feed, and extracted prices are quarantined (§44).
  const { queue, close } = await seedQueued({ price: 0 });
  const plan = buildReviewPlan(await queue.get(OFFER));
  assert.ok(plan.blocking.includes('price'));
  assert.ok(!plan.fields.some((f) => f.field === 'price'));
  assert.ok(!plan.advanced.some((f) => f.field === 'price'));
  const stop = plan.readOnly.find((b) => b.condition === 'price');
  assert.ok(stop, 'and the reviewer is TOLD why, rather than left hunting for the field');
  assert.match(stop.why, /retailer feed/);
  assert.equal(plan.resolvable, false, 'so the UI can steer to send-back or reject');
  close();
});

// --- 4. approve: S4 decides, never the reviewer -----------------------------

await test('APPROVE: a human-supplied size makes it servable and S4 closes the item', async () => {
  const { store, queue, raw, close } = await seedQueued();
  const report = await runRecovery(
    { queue, processor: human, enrichStore: store, ctx: review({ size: '330 ml' }) },
    { currentOn: TODAY },
  );
  assert.equal(report.recovered, 1);
  assert.equal(report.failed, 0);

  const item = await queue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.RESOLVED);
  assert.equal(item.verdict.accepted, true, 'the re-judged verdict is persisted');

  // The canonical row is genuinely servable — the R1 bug was that it was not.
  const row = raw.prepare('SELECT name, name_ar, corroboration FROM offer_enrichments WHERE id = ?').get(OFFER);
  assert.ok(servable({ name: row.name, name_ar: row.name_ar, corroboration: row.corroboration }));

  // Journalled under the opaque processor id, side by side with the primary
  // read — only possible because S5.0 removed the `source` CHECK.
  const sources = raw.prepare('SELECT source FROM offer_extraction_attempts WHERE offer_id = ? ORDER BY source').all(OFFER);
  assert.deepEqual(sources.map((r) => r.source), ['human', 'vision']);

  const [attempt] = await queue.history(OFFER);
  assert.equal(attempt.processor, HUMAN_PROCESSOR_ID);
  assert.equal(attempt.actor, 'dev@example', 'who reviewed it is recorded');
  assert.deepEqual(attempt.missingBefore, ['comparable_quantity']);
  assert.deepEqual(attempt.missingAfter, []);
  close();
});

await test('ONLY S4 CLOSES: an approval that does not clear the gate leaves it queued', async () => {
  const { store, queue, close } = await seedQueued();
  // A real edit, but not of the blocking condition — size is still missing.
  const report = await runRecovery(
    { queue, processor: human, enrichStore: store, ctx: review({ name_ar: 'مياه أروى الطبيعية' }) },
    { currentOn: TODAY },
  );
  assert.equal(report.recovered, 0);
  assert.equal(report.noChange, 1, 'honest: the reviewer edited something, it did not resolve');
  const item = await queue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.QUEUED, 'a reviewer cannot declare an item resolved');
  assert.deepEqual(item.verdict.missing, ['comparable_quantity']);
  close();
});

// --- 5. C-7: the human rung is the exception --------------------------------

await test('C-7: a human MAY overwrite a field an earlier machine rung accepted', async () => {
  const { store, queue, raw, close } = await seedQueued();
  // name_en was ACCEPTED by Vision. A machine processor doing this is refused at
  // the commit boundary (recovery.test.mjs); the human rung is the one exception,
  // and it exists for exactly this defect class: a confident, well-formed misread.
  const report = await runRecovery(
    {
      queue,
      processor: human,
      enrichStore: store,
      ctx: review({ name_en: 'Arwa Bottled Water 330 ml', size: '330 ml' }),
    },
    { currentOn: TODAY },
  );
  assert.equal(report.blockedByImmutability, 0, 'not refused');
  assert.equal(report.recovered, 1);
  const row = raw.prepare('SELECT name FROM offer_enrichments WHERE id = ?').get(OFFER);
  assert.equal(row.name, 'Arwa Bottled Water 330 ml', 'the correction actually landed');
  close();
});

await test('a human edit is SELF-EVIDENCING — no validator has to agree (R1)', async () => {
  const { store, queue, raw, close } = await seedQueued();
  await runRecovery(
    { queue, processor: human, enrichStore: store, ctx: review({ size: '330 ml' }) },
    { currentOn: TODAY },
  );
  const attempt = raw
    .prepare("SELECT validation FROM offer_extraction_attempts WHERE offer_id = ? AND source = 'human'")
    .get(OFFER);
  const validation = JSON.parse(attempt.validation);
  assert.ok(validation.acceptedFields.includes('size'), 'the reviewer vouched for it');
  assert.equal(validation.fields.size.provenance, EXTRACTION_PROVENANCE.HUMAN);
  // And a field the human did NOT touch keeps the machine verdict that admitted it.
  assert.ok(validation.acceptedFields.includes('name_en'));
  assert.equal(validation.fields.name_en.provenance, EXTRACTION_PROVENANCE.VISION);
  close();
});

// --- APPROVE IS ALWAYS REACHABLE ------------------------------------------
// The review workflow is Review -> Edit -> Approve -> S4. An item blocked ONLY
// on a condition review cannot fix (price) still hands the reviewer a form —
// `advanced` is never empty — so hiding Approve in that state produced a screen
// that could be edited and not submitted, and the edit could only be discarded.

await test('a price-only block still offers editable fields — so Approve must exist', () => {
  const plan = buildReviewPlan({
    offerId: OFFER,
    offer: { image_url: 'x.png', price: 9.5, currency: 'SAR' },
    verdict: { missing: ['price'] },
    // Identity already servable, so `english_name` is NOT auto-added and the
    // blocking list really does collapse to the one unfixable condition.
    enrichment: { name: 'Arwa Bottled Water 330 ml', name_ar: 'مياه أروى', corroboration: 1 },
    attemptsBySource: {},
  });
  assert.deepEqual(plan.blocking, ['price']);
  assert.equal(plan.fields.length, 0, 'nothing BLOCKING is editable');
  assert.equal(plan.resolvable, false);
  assert.ok(plan.readOnly.some((r) => r.condition === 'price'), 'and it says why');
  // THE POINT: the reviewer is still given a form.
  assert.ok(plan.advanced.length > 0, 'Advanced is editable in exactly this state');
});

await test('the console renders Approve UNCONDITIONALLY', async () => {
  const { CONSOLE_HTML } = await import('../ops/ui.js');
  const approve = CONSOLE_HTML.match(/id="rvApprove"/g) || [];
  assert.equal(approve.length, 1, 'exactly one Approve button');
  // It must not sit behind a render-time branch: the three primary actions are
  // emitted as one contiguous run, so no plan shape can drop Approve alone.
  assert.match(
    CONSOLE_HTML,
    /id="rvApprove">Approve<\/button>' \+\s*'<button class="ghost" id="rvSend">/,
    'Approve is emitted alongside Send back, not conditionally',
  );
  assert.doesNotMatch(
    CONSOLE_HTML,
    /Nothing here can make this servable/,
    'the old branch that replaced Approve with a dead-end note is gone',
  );
  for (const id of ['rvApprove', 'rvSend', 'rvReject']) {
    assert.ok(CONSOLE_HTML.includes(`id="${id}"`), `${id} is always present`);
  }
});

console.log(`\nS7 Human Review: ${tests} tests OK`);
