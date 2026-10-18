// Retain the processor id so saved policies and historical attempts still resolve.
// The user retired Medium and routine repeated vision reads on 2026-10-18.
import { defineProcessor, RECOVERY_KIND } from '../registry.js';
export const VISION_MEDIUM_PROCESSOR_ID = 'vision-medium';
export const RECOVERY_VISION_MODEL = 'ministral-14b-2512';
export default defineProcessor({
  id: VISION_MEDIUM_PROCESSOR_ID,
  label: 'Legacy vision recovery (retired)',
  description: 'Retired under the 14B-only policy. No automatic image reread.',
  kind: RECOVERY_KIND.MACHINE,
  addresses: [],
  costHint: { per:'offer', requests:0 },
  supports: () => false,
  run: async () => ({ declined:true, error:'Legacy Medium recovery is retired; routine vision rereads are disabled.' }),
});
