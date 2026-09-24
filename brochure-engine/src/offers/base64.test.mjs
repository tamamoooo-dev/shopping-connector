import assert from 'node:assert/strict';
import { toBase64 } from './enrich.js';

console.log('Vision crop base64 encoder:');

assert.equal(toBase64(new Uint8Array([1, 2, 3]).buffer), 'AQID');
console.log('  ok  chunked compatibility encoder preserves bytes');

const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
let nativeCalls = 0;
Object.defineProperty(Uint8Array.prototype, 'toBase64', {
  configurable: true,
  value() {
    nativeCalls += 1;
    return 'native-result';
  },
});
try {
  assert.equal(toBase64(new Uint8Array([9]).buffer), 'native-result');
  assert.equal(nativeCalls, 1);
  console.log('  ok  Workers native encoder is preferred over the CPU-heavy fallback');
} finally {
  if (descriptor) Object.defineProperty(Uint8Array.prototype, 'toBase64', descriptor);
  else delete Uint8Array.prototype.toBase64;
}

console.log('\nVision crop base64 encoder: 2 tests OK');
