// recovery/processors/index.js — THE REGISTRY LINE.
//
// This file is the entire cost of adding a recovery processor (C-9): write the
// module, add it to the array below. No queue change, no schema change, no
// migration, no new status value, no runner change. If adding a processor ever
// requires touching anything else, the platform property has been broken and
// the tests in recovery.test.mjs / recoveryQueue.test.mjs should have said so.
//
// ORDER IS MEANINGFUL ONLY AS A DEFAULT PRESENTATION. It is not an escalation
// ladder — C-8 withdrew automatic progression, and nothing here advances from
// one processor to the next. An Auto policy runs exactly the processors an
// operator armed, in the order that policy names them.
//
// S7 LANDED 2026-07-27, and cost exactly what C-9 said it would: one module plus
// the one line below. No queue change, no schema change, no migration, no new
// status value, no runner change. The human rung differs from a machine rung
// only on the C-7 axis the runner already read.

import { createRecoveryRegistry } from '../registry.js';
import human from './human.js';
import ocr from './ocr.js';
import visionMedium from './visionMedium.js';

// Cheapest first — a presentation default, NOT an escalation ladder. Human is
// last because it is the terminal rung and the only one that spends a person's
// time rather than an API budget.
//
// `vision-medium` LANDED 2026-07-30 and cost exactly the one line below plus its
// module — no queue change, no schema, no migration, no new status value, no
// runner change, and (because it reuses the existing `vision` credential) no
// console change either. Ordered after `ocr` because it is dearer per offer, not
// because anything escalates from one to the other.
export const RECOVERY_PROCESSORS = [ocr, visionMedium, human];

export const recoveryRegistry = createRecoveryRegistry(RECOVERY_PROCESSORS);
