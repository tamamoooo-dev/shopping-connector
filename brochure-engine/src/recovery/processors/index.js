// recovery/processors/index.js — the recovery processor registry.
//
// Adding a processor remains one module plus one registry line: the queue,
// schema and runner stay processor-agnostic. Order is also the production Auto
// escalation order. A recovered item leaves the queue; a no-change journal
// entry excludes only that rung and lets the next configured rung see it.

import { createRecoveryRegistry } from '../registry.js';
import human from './human.js';
import ocr from './ocr.js';
import visionSmallRetry from './visionSmallRetry.js';
import visionMedium from './visionMedium.js';

// Requested ladder: retry the exact same Small model once, then Medium, then
// OCR. Human remains a manual terminal rung.
export const RECOVERY_PROCESSORS = [visionSmallRetry, visionMedium, ocr, human];

export const recoveryRegistry = createRecoveryRegistry(RECOVERY_PROCESSORS);
