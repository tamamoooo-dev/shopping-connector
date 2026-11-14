// Mini marts product crops (minimartCrop.js): a presenter shop's card shows
// a crop of the product, never the frame with the person in it.
import assert from 'node:assert/strict';
import {
  BOX_PROMPT, CHECK_PROMPT, CARD_ASPECT, CROP_MIN_WIDTH, PRESENTER,
  pictureEntries, parseBox, packageBoxes, scaleBox, cropCandidates, trimCandidates, faceEdge,
  letterboxLayout, chooseCrop, cropKeyFor, shopStyle,
} from './minimartCrop.js';

const frame = { width: 480, height: 854 };

assert.ok(BOX_PROMPT.includes('"packages"'));
assert.ok(CHECK_PROMPT.includes('"face"') && CHECK_PROMPT.includes('"edge"') && CHECK_PROMPT.includes('"product"'));
assert.deepEqual(pictureEntries('here {"pictures":[{"picture":1,"face":false}]} done'), [{ picture: 1, face: false }]);
assert.deepEqual(pictureEntries('no json'), []);

// Boxes: ordered, clamped to the picture, too small or malformed refused.
assert.deepEqual(parseBox([300, 500, 100, 200], frame), [100, 200, 300, 500]);
assert.deepEqual(parseBox([-20, 10.4, 500, 900], frame), [0, 10, 480, 854]);
assert.equal(parseBox([10, 10, 15, 200], frame), null);
assert.equal(parseBox([1, 2, 3], frame), null);
assert.equal(parseBox(['a', 2, 3, 4], frame), null);
assert.deepEqual(scaleBox([100, 200, 300, 400], 0.5), [200, 400, 600, 800]);

// Two packs held apart (the face between them): together first, then each
// alone, the larger first. One pack: just it. A one-box answer works too.
assert.deepEqual(packageBoxes({ packages: [[40, 300, 140, 420], [330, 280, 470, 440]] }, frame),
  [[40, 280, 470, 440], [330, 280, 470, 440], [40, 300, 140, 420]]);
assert.deepEqual(packageBoxes({ packages: [[100, 300, 200, 400]] }, frame), [[100, 300, 200, 400]]);
assert.deepEqual(packageBoxes({ product: [100, 300, 200, 400] }, frame), [[100, 300, 200, 400]]);
assert.deepEqual(packageBoxes({ packages: [] }, frame), []);

// Crops around a box: two 3:4 windows (widest first) and the padded box itself.
{
  const box = [200, 400, 280, 520]; // 80 × 120
  const c = cropCandidates(frame, box);
  assert.deepEqual(c.map((x) => x.kind), ['wide', 'close', 'tight']);
  for (const x of c.slice(0, 2)) {
    const [l, t, r, b] = x.rect;
    assert.ok(Math.abs((r - l) / (b - t) - CARD_ASPECT) < 0.02, `${x.kind} is 3:4`);
    assert.ok(l <= box[0] && t <= box[1] && r >= box[2] && b >= box[3], `${x.kind} holds the box`);
    assert.ok(l >= 0 && t >= 0 && r <= frame.width && b <= frame.height);
    assert.equal(x.letterbox, false);
  }
  assert.ok(c[0].rect[2] - c[0].rect[0] > c[1].rect[2] - c[1].rect[0], 'wide is wider');
  assert.deepEqual(c[2], { kind: 'tight', rect: [193, 393, 287, 527], letterbox: true });
  // A window is shifted to stay inside the picture.
  const edge = cropCandidates(frame, [0, 0, 60, 90]);
  assert.ok(edge.every((x) => x.rect[0] === 0 && x.rect[1] === 0));
  // A product filling the picture: no 3:4 window holds it, only the box.
  assert.deepEqual(cropCandidates(frame, [0, 0, 480, 854]).map((x) => x.kind), ['tight']);
}

// A box refused for a chin at its top: tried again with the top cut.
assert.deepEqual(trimCandidates(frame, [100, 200, 300, 500], 'top').map((x) => [x.kind, x.rect]),
  [['trim15', [100, 245, 300, 500]], ['trim30', [100, 290, 300, 500]]]);
assert.deepEqual(trimCandidates(frame, [100, 200, 300, 500], 'left')[0].rect, [130, 200, 300, 500]);
assert.deepEqual(trimCandidates(frame, [100, 200, 300, 500], 'middle'), []);
const seen = (face, edge, product = true) => ({ face, edge, product });
assert.equal(faceEdge([seen(true, 'top'), seen(true, 'top')]), 'top');
assert.equal(faceEdge([seen(true, 'top'), seen(true, 'left')]), null); // the copies disagree
assert.equal(faceEdge([seen(true, 'top', false), seen(true, 'top')]), null); // the product is not shown
assert.equal(faceEdge([seen(true, 'top')]), null);

// The letterbox card: 3:4, the crop centred, at least CROP_MIN_WIDTH wide.
{
  const bar = letterboxLayout(110, 40); // a chocolate bar
  assert.equal(bar.width, CROP_MIN_WIDTH);
  assert.equal(bar.height, 480);
  assert.deepEqual(bar.inner, { width: 360, height: 131 });
  assert.equal(bar.top, Math.floor((480 - 131) / 2));
  const tall = letterboxLayout(300, 800);
  assert.deepEqual([tall.width, tall.height, tall.left, tall.top], [600, 800, 150, 0]);
}

// A crop stands only when both copies saw no face and saw the product; a
// missing answer counts as a face.
const ok = { face: false, product: true };
assert.equal(chooseCrop([[{ face: true, product: true }, ok], [ok, ok]]), 1);
assert.equal(chooseCrop([[ok, ok], [ok, ok]]), 0);
assert.equal(chooseCrop([[ok, null]]), -1);
assert.equal(chooseCrop([[ok]]), -1);
assert.equal(chooseCrop([[ok, { face: false, product: false }]]), -1);
assert.equal(chooseCrop([[ok, { face: null, product: true }]]), -1);
assert.equal(chooseCrop([]), -1);

// Keys: next to the frame, one per offer, served by GET /minimarts/image.
const key = cropKeyFor('minimarts/m7.omar1/AbC_d-1-f93.jpg', 'AbC_d-1:1');
assert.equal(key, 'minimarts/m7.omar1/AbC_d-1-f93.crop.AbC_d-1-1.jpg');
assert.match(key, /^minimarts\/[a-z0-9._-]+\/[A-Za-z0-9._:-]+\.jpg$/);

assert.equal(shopStyle('Presenter '), PRESENTER);
assert.equal(shopStyle('product'), null);
assert.equal(shopStyle(null), null);

console.log('minimartCrop.test.mjs OK');
