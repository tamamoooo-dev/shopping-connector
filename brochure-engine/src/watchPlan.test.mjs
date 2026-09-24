import assert from 'node:assert/strict';
import {
  WATCH_TRACK,
  effectiveSearchQuery,
  generalSystemQuery,
  generalWatchSpec,
  isAmazonAsin,
  latestRiyadhSlot,
  nextRiyadhSlot,
  watchTrack,
} from './watchPlan.js';

assert.equal(isAmazonAsin('B012345678'), true);
assert.equal(isAmazonAsin('similar-product'), false);
assert.equal(watchTrack({ kind: 'product', provider: 'amazon', productId: 'B012345678' }), WATCH_TRACK.AMAZON_EXACT);
assert.equal(watchTrack({ watchTrack: WATCH_TRACK.MARKET_GENERAL }), WATCH_TRACK.MARKET_GENERAL);
assert.equal(watchTrack({ kind: 'grocery', provider: 'panda', productId: '123' }), null);

const milk = { name: 'Nadec Full Fat Milk 12 x 1 Liter', brand: 'Nadec' };
const spec = generalWatchSpec(milk);
assert.equal(spec.brand, 'nadec');
assert.equal(spec.family, 'milk');
assert.equal(spec.size, undefined);
assert.equal(spec.count, undefined);
assert.equal(effectiveSearchQuery({ watchTrack: WATCH_TRACK.MARKET_GENERAL, sourceSnapshot: JSON.stringify(milk) }), 'Milk Nadec');
assert.equal(effectiveSearchQuery({ customSearchQuery: '  حليب نادك  ' }), 'حليب نادك');
assert.equal(effectiveSearchQuery({ watchTrack: WATCH_TRACK.AMAZON_EXACT, productId: 'B012345678' }), 'B012345678');
assert.equal(
  generalSystemQuery({ name: 'تندرينا تونه ناعمه 185 جم', brand: 'Goody' }),
  'تندرينا تونه ناعمه goody',
  'fish-family watches keep the selected shelf product wording instead of inventing Fish + brand',
);

const beforeMorning = Date.parse('2026-08-25T03:59:00Z'); // 06:59 Riyadh
const morning = Date.parse('2026-08-25T04:00:00Z'); // 07:00 Riyadh
const evening = Date.parse('2026-08-25T16:00:00Z'); // 19:00 Riyadh
assert.deepEqual(latestRiyadhSlot(beforeMorning), {
  key: '2026-08-24-PM', period: 'PM', localHour: 19,
  scheduledAt: '2026-08-24T16:00:00.000Z', scheduledMs: Date.parse('2026-08-24T16:00:00Z'),
});
assert.equal(latestRiyadhSlot(morning).key, '2026-08-25-AM');
assert.equal(latestRiyadhSlot(evening).key, '2026-08-25-PM');
assert.equal(nextRiyadhSlot(morning).key, '2026-08-25-PM');
assert.equal(nextRiyadhSlot(evening).key, '2026-08-26-AM');

console.log('watchPlan.test: 19 passed, 0 failed');
