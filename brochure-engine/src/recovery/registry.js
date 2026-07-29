// recovery/registry.js — the processor plug-in contract (VISION-PIPELINE.md C-9).
//
// THE ONE FILE ALLOWED TO NAME PROCESSORS. C-9's checkable property is that
// adding a processor is one new module plus one registry line, touching no queue
// code, no schema and no migration. This module is the "one registry line" half:
// the database stores opaque ids, the queue passes them through, and the mapping
// from an id to something runnable lives here and nowhere else.
//
// WHY THE REGISTRY AND NOT THE DATABASE IS THE AUTHORITY. A CHECK constraint
// enumerating processors makes the set of processors a schema fact, so adding
// one becomes a migration — and, on SQLite, a full table rebuild. Keeping the
// authority in code means a processor can be added, renamed or removed in a
// deploy, and an id that no longer resolves degrades to "unknown processor"
// instead of corrupting the queue.
//
// WHAT A PROCESSOR MAY NOT DO, enforced by the runner rather than by trust:
//   • it may not close its own item — only S4 does (C-9)
//   • it may not overwrite a field an earlier machine rung accepted (C-7)
//   • it may not decide whether recovery spend is authorised — that is the
//     execution policy, and the operator's call (C-8)
// A processor that gets any of those wrong is contained, because none of them
// are its decision to make.

// The verbs an interactive processor's surface offers. They live HERE, with the
// contract, and not in the human module: they describe what any review surface
// can do, so the ops layer can route a decision without importing — or naming —
// the processor that will handle it. `approve` is the only one that reaches a
// processor's run(); the other two are queue transitions the runner never sees.
export const REVIEW_DECISION = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
  SEND_BACK: 'sendback',
});

export const RECOVERY_KIND = Object.freeze({
  // MACHINE rungs are bound by accepted-field immutability (C-7).
  MACHINE: 'machine',
  // The HUMAN rung is the sole exception: a review stage that cannot correct a
  // confident misread cannot fix the defect class the ladder exists to catch.
  HUMAN: 'human',
});

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate and freeze a processor descriptor.
 *
 * Descriptor:
 *   id          opaque, stable, lower-kebab. STORED IN ROWS FOREVER — renaming
 *               one orphans its history, so it is validated strictly here.
 *   label       operator-facing name
 *   kind        RECOVERY_KIND — the C-7 axis, and the only behavioural flag
 *   provenance  EXTRACTION_PROVENANCE value written on the attempt journal
 *   addresses   S4 conditions this processor can plausibly fix. ADVISORY: used
 *               to order operator choices and to report effectiveness, never to
 *               gate a run. A processor that claims a condition it cannot fix
 *               is measured by missing_before/after, not blocked here.
 *   costHint    opaque to the queue; surfaced to the operator for forecasting
 *   credential  WHICH credential this processor needs ('ocr', 'vision', …), or
 *               null for one that needs no provider at all — the human rung.
 *               DECLARATIVE on purpose: the caller resolves the name to a key
 *               chain, so credential selection stays somewhere auditable
 *               instead of each processor reaching into the environment. A
 *               processor reusing an existing credential costs no caller change;
 *               only a genuinely new provider does.
 *   supports    (item) => boolean. Preconditions THE PROCESSOR knows about
 *               (needs a crop, needs a prior rung's output). Lives here rather
 *               than in the queue precisely so the queue stays agnostic; the
 *               runner over-fetches slightly and filters, which is the cost of
 *               that separation and is deliberately paid.
 *   run         async (item, ctx) => outcome. See runner.js for the contract.
 */
export function defineProcessor(descriptor) {
  const {
    id, label, kind = RECOVERY_KIND.MACHINE, provenance = null,
    addresses = [], costHint = null, credential = null, supports, run,
    description = null, reviewPlan = null,
  } = descriptor || {};

  if (!id || typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`Recovery processor id must be lower-kebab-case; got ${JSON.stringify(id)}`);
  }
  if (kind !== RECOVERY_KIND.MACHINE && kind !== RECOVERY_KIND.HUMAN) {
    throw new Error(`Recovery processor '${id}' has unknown kind '${kind}'`);
  }
  if (typeof run !== 'function') {
    throw new Error(`Recovery processor '${id}' must supply run()`);
  }
  if (supports != null && typeof supports !== 'function') {
    throw new Error(`Recovery processor '${id}' supports must be a function`);
  }
  if (reviewPlan != null && typeof reviewPlan !== 'function') {
    throw new Error(`Recovery processor '${id}' reviewPlan must be a function`);
  }

  return Object.freeze({
    id,
    label: label || id,
    description,
    kind,
    provenance,
    addresses: Object.freeze([...addresses]),
    costHint: costHint == null ? null : Object.freeze({ ...costHint }),
    credential,
    // Default: handle everything. A processor opts INTO being picky.
    supports: supports || (() => true),
    // OPTIONAL INTERACTIVE CAPABILITY (S7), declared exactly like `supports`.
    // `(item) => plan` — what an operator must be shown and may edit before this
    // processor can run. Null for every unattended processor, which is why the
    // console can ask any processor for one without knowing which exist: the
    // ops layer reads a capability, never a name (C-9). Without this the review
    // surface would have to import the human module directly, and the console
    // would start holding a copy of the field taxonomy it exists not to know.
    reviewPlan,
    run,
  });
}

export function createRecoveryRegistry(processors = []) {
  const byId = new Map();
  for (const processor of processors) {
    if (byId.has(processor.id)) {
      throw new Error(`Duplicate recovery processor id '${processor.id}'`);
    }
    byId.set(processor.id, processor);
  }
  return {
    /** null, never a throw: an id from a stale stored policy is a normal event. */
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
    ids: () => [...byId.keys()],
    list: () => [...byId.values()],
    /** Operator-facing catalogue. No run()/supports() — this crosses to a UI. */
    describe: () => [...byId.values()].map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      kind: p.kind,
      provenance: p.provenance,
      addresses: [...p.addresses],
      costHint: p.costHint,
      credential: p.credential,
      // Tells a UI to offer a review surface instead of a fire-and-forget
      // dispatch button, without naming the processor that has one.
      interactive: !!p.reviewPlan,
    })),
  };
}
