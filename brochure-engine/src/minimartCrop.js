// minimartCrop.js — Mini marts: a shop whose offers are presented by a person
// (2026-11-14). The owner added Q (كيو, m7.omar1) in place of عروض البركة: "q
// is not mini market but their marketing style is similar to them", and its
// story is short videos of a presenter holding each product. Owner: "since
// there is a person grabbing the products .. i want you to find a solution for
// it either you eliminate him from the photo or find another way".
//
// THE WAY: such a shop has the style PRESENTER (minimart_shops.style), and
// its offer cards show a crop of the product instead of the frame the price
// was read from (its reading rule, the last price shown, is minimarts.js
// lastRevealed). Nobody is painted out (a hand holding a package can't be removed
// without inventing pixels); the picture is cut around the product so the
// person is not in it. Tapping the card opens the same crop, so the frame
// with him is not shown anywhere.
//
// HOW (pc-reader/crop.mjs on the owner's PC, Claude Haiku 5.5 + sharp):
//   1. Haiku boxes each package of the offer's product in the offer's frame
//      (BOX_PROMPT). Measured 2026-11-14 on 25 of Q's frames: product boxes
//      mostly right; FACE boxes were not (on a bottle, on the price caption,
//      above the face), so the crop never relies on a face box.
//   2. Crops are cut around every package together, then around each one
//      alone (packageBoxes: two packs held apart with the face between them).
//      For each box (cropCandidates): a 3:4 window with room around the
//      product, a closer 3:4 window, and the box itself on a 3:4 card filled
//      with its own blurred copy.
//   3. Haiku looks at every crop twice (CHECK_PROMPT, the second copy in
//      reverse order): a crop stands only when BOTH copies say no part of a
//      head or face is in it and the product is shown (chooseCrop). The
//      widest crop that stands is used. A box refused for a chin or mouth at
//      one edge is tried again with that edge cut (trimCandidates). None
//      standing = no picture.
//   4. The engine keeps the crop next to the frame (cropKeyFor) and serves it
//      as the card's picture. Until a crop exists the card has no picture.
//   Bench (benchmarks/minimart-crop-2026-11-14, all 113 frames of Q's 25
//   videos, as if each were an offer's frame): 88 cropped, no face in any
//   (eye-checked); 24 of 25 videos have a crop (the 25th shows no product).
// Pure rules here: used by the engine (keys, modes) and by the PC reader.

// The shop style: a person presents the offers.
export const PRESENTER = 'presenter';
// The card's picture box (styles.css .mm-pic): 3 wide, 4 high.
export const CARD_ASPECT = 3 / 4;
// Room around the product box on every side, as a share of its larger side.
export const CROP_PAD = 0.06;
// The 3:4 windows, widest first: the product's larger side takes this share
// of the window.
export const WINDOWS = [
  { kind: 'wide', fill: 0.5 },
  { kind: 'close', fill: 0.75 },
];
// A box smaller than this (pixels a side) is not a product box.
export const MIN_BOX_SIDE = 12;
// Pictures go to the model no larger than the reader reads them.
export const CROP_LONG_EDGE = 1092;
// The crops are sent to the check and stored at least this wide (a small
// product is enlarged, the card shows ~190 px at twice the pixel density).
export const CROP_MIN_WIDTH = 360;

export const BOX_PROMPT = `Each picture above is one frame of a shop's Snapchat video or a photo from its story, labelled "Picture n (width×height px)" and the offer it was read for. A presenter usually shows the product on offer, holding it in his hands.
For every picture give "packages": one box for EACH package of that offer's product that is shown: the packages the presenter holds up or points at (if he holds none, the main product shown in front). A box covers its whole package, tightly, including any part his hand covers, and not the shelves behind him. [] when no such product is clearly visible.
Boxes are [left, top, right, bottom] in pixels of that picture, (0, 0) at its top-left corner.
Return JSON only: {"pictures":[{"picture":1,"packages":[[l,t,r,b]]}]}`;

export const CHECK_PROMPT = `Each picture above is a crop made for a shop's offer card, labelled "Picture n" and the offer it shows. For every picture answer:
- "face": true when ANY part of a person's head or face is visible: hair, forehead, eyes, eyebrows, nose, mouth, lips, chin, beard, mustache or an ear, however small, blurred or cut off at the edge. A person's photo on a poster or sign counts too. A drawing or photo printed on a product's own package does not count. Hands, arms and clothes do not count.
- "edge": when "face" is true, the edge of the picture the head or face part is at: "top", "bottom", "left" or "right", or "middle" when it is not at an edge; null otherwise.
- "product": true when the offer's product is clearly shown, whole or nearly whole.
Return JSON only: {"pictures":[{"picture":1,"face":true or false,"edge":"top" or "bottom" or "left" or "right" or "middle" or null,"product":true or false}]}`;

// The model's reply -> its "pictures" entries ([] when unreadable).
export function pictureEntries(raw) {
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(String(raw))[0]);
    return Array.isArray(parsed?.pictures) ? parsed.pictures : [];
  } catch {
    return [];
  }
}

// A box the model gave, in the pixels of a picture of `size` -> [l, t, r, b]
// whole pixels inside the picture, or null.
export function parseBox(box, size) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const n = box.map(Number);
  if (!n.every(Number.isFinite)) return null;
  const [l, r] = [Math.min(n[0], n[2]), Math.max(n[0], n[2])];
  const [t, b] = [Math.min(n[1], n[3]), Math.max(n[1], n[3])];
  const out = [
    Math.max(0, Math.floor(l)), Math.max(0, Math.floor(t)),
    Math.min(size.width, Math.ceil(r)), Math.min(size.height, Math.ceil(b)),
  ];
  if (out[2] - out[0] < MIN_BOX_SIDE || out[3] - out[1] < MIN_BOX_SIDE) return null;
  return out;
}

// The boxes the model gave for one picture -> the boxes to crop around, in
// the order to try: every package together, then each package alone, the
// largest first (two packs held apart with the face between them: only one
// pack at a time leaves the face out). Each [l, t, r, b] inside `size`.
export function packageBoxes(entry, size) {
  const raw = Array.isArray(entry?.packages) ? entry.packages : entry?.product ? [entry.product] : [];
  const boxes = raw.map((b) => parseBox(b, size)).filter(Boolean);
  if (!boxes.length) return [];
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  const singles = [...boxes].sort((a, b) => area(b) - area(a));
  if (singles.length === 1) return singles;
  const union = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  return [union, ...singles];
}

// The box scaled from the picture the model saw to the original.
export function scaleBox(box, factor) {
  return box.map((v) => v / factor);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The crops to try around a product box, widest first:
// [{ kind, rect: [l, t, r, b], letterbox }]. `letterbox`: the rect is the
// padded box itself, to be put on a 3:4 card (it is not 3:4).
export function cropCandidates(size, box) {
  const W = size.width;
  const H = size.height;
  const [l, t, r, b] = box;
  const pad = CROP_PAD * Math.max(r - l, b - t);
  const padded = [clamp(l - pad, 0, W), clamp(t - pad, 0, H), clamp(r + pad, 0, W), clamp(b + pad, 0, H)];
  const pw = padded[2] - padded[0];
  const ph = padded[3] - padded[1];
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;
  const out = [];
  const seen = new Set();
  const add = (kind, rect, letterbox) => {
    const whole = rect.map((v) => Math.round(v));
    whole[2] = Math.min(W, whole[2]);
    whole[3] = Math.min(H, whole[3]);
    const id = whole.join(',');
    if (seen.has(id) || whole[2] - whole[0] < MIN_BOX_SIDE || whole[3] - whole[1] < MIN_BOX_SIDE) return;
    seen.add(id);
    out.push({ kind, rect: whole, letterbox });
  };
  for (const { kind, fill } of WINDOWS) {
    let w = Math.max((r - l) / fill, ((b - t) / fill) * CARD_ASPECT);
    w = Math.min(w, W, H * CARD_ASPECT);
    const h = w / CARD_ASPECT;
    // The window must still hold the padded box.
    if (w + 0.5 < pw || h + 0.5 < ph) continue;
    const x = clamp(cx - w / 2, 0, W - w);
    const y = clamp(cy - h / 2, 0, H - h);
    add(kind, [x, y, x + w, y + h], false);
  }
  add('tight', padded, true);
  return out;
}

// A product held right under the chin: the box itself shows the chin or the
// mouth at one edge (measured 2026-11-14: every tight crop refused for a face
// in the bench showed a mouth, chin or beard at its edge). The box is tried
// again with that side cut by TRIM_SHARES of its length, letterboxed.
export const TRIM_SHARES = [0.15, 0.3];
const SIDES = new Set(['top', 'bottom', 'left', 'right']);

export function trimCandidates(size, rect, side) {
  if (!SIDES.has(side)) return [];
  const out = [];
  for (const share of TRIM_SHARES) {
    const [l, t, r, b] = rect;
    const cutX = Math.round((r - l) * share);
    const cutY = Math.round((b - t) * share);
    const trimmed = {
      top: [l, t + cutY, r, b], bottom: [l, t, r, b - cutY], left: [l + cutX, t, r, b], right: [l, t, r - cutX, b],
    }[side].map((v, i) => Math.min(i % 2 ? size.height : size.width, Math.max(0, v)));
    if (trimmed[2] - trimmed[0] < MIN_BOX_SIDE || trimmed[3] - trimmed[1] < MIN_BOX_SIDE) continue;
    out.push({ kind: `trim${Math.round(share * 100)}`, rect: trimmed, letterbox: true });
  }
  return out;
}

// A refused crop worth trimming: every copy saw the product and a face part
// at the same edge -> that edge, else null.
export function faceEdge(copies) {
  if (!copies?.length || copies.length < 2) return null;
  if (!copies.every((c) => c && c.face === true && c.product === true)) return null;
  const edge = copies[0].edge;
  return SIDES.has(edge) && copies.every((c) => c.edge === edge) ? edge : null;
}

// The 3:4 card a letterboxed crop is put on: { width, height, left, top },
// the crop centred, at least CROP_MIN_WIDTH wide (scaled up when smaller).
export function letterboxLayout(cropWidth, cropHeight) {
  let width = Math.max(cropWidth, cropHeight * CARD_ASPECT);
  const scale = width < CROP_MIN_WIDTH ? CROP_MIN_WIDTH / width : 1;
  width = Math.round(width * scale);
  const height = Math.round(width / CARD_ASPECT);
  const inner = { width: Math.min(width, Math.round(cropWidth * scale)), height: Math.min(height, Math.round(cropHeight * scale)) };
  return { width, height, inner, left: Math.floor((width - inner.width) / 2), top: Math.floor((height - inner.height) / 2) };
}

// The two checks of every candidate ([{ face, product }] per copy, in the
// candidates' order) -> the index of the crop to use, or -1. A crop stands
// only when every copy answered, none saw a face and every one saw the
// product; a missing answer counts as a face.
export function chooseCrop(checks) {
  return checks.findIndex((copies) => copies.length >= 2
    && copies.every((c) => c && c.face === false && c.product === true));
}

// Where an offer's crop lives in R2: next to the frame it was cut from, one
// per offer (two offers can share a frame).
export function cropKeyFor(imageKey, offerId) {
  const base = String(imageKey).replace(/\.jpg$/i, '');
  return `${base}.crop.${String(offerId).replace(/[^A-Za-z0-9._-]/g, '-')}.jpg`;
}

// The shop style as sent by the owner -> PRESENTER | null.
export function shopStyle(value) {
  return String(value ?? '').trim().toLowerCase() === PRESENTER ? PRESENTER : null;
}
