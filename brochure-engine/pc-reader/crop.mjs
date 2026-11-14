// pc-reader/crop.mjs — the product crop of a Mini marts offer picture, for a
// shop whose offers are presented by a person (src/minimartCrop.js has the
// rules and why). Used by reader.mjs after each round, and by the bench
// (benchmarks/minimart-crop-2026-11-14/run.mjs).
//
//   cropOffers(jobs, { ask }) — jobs: [{ id, name, bytes }] (the offer's frame)
//   -> Map id -> { image: Buffer (JPEG, 3:4), kind, rect } | { none: reason }
//   A job missing from the map was not answered (a failed or refused call):
//   it is asked again later.
import sharp from 'sharp';
import {
  BOX_PROMPT, CHECK_PROMPT, CROP_LONG_EDGE, CROP_MIN_WIDTH,
  chooseCrop, cropCandidates, faceEdge, letterboxLayout, packageBoxes, parseBox, pictureEntries, scaleBox, trimCandidates,
} from '../src/minimartCrop.js';

const BATCH = 28;

const label = (offer) => (offer ? ` — the offer: ${String(offer).slice(0, 80)}` : '');

// `items` [{ data (base64 JPEG), text }] in batches -> Map index -> entry, or
// null when a call got no answer (a limit, a failure).
async function askInBatches(items, prompt, ask) {
  const found = new Map();
  for (let start = 0; start < items.length; start += BATCH) {
    const group = items.slice(start, start + BATCH);
    const content = group.flatMap((item, i) => [
      { type: 'text', text: `Picture ${i + 1}${item.text}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: item.data } },
    ]);
    content.push({ type: 'text', text: prompt });
    const raw = await ask(content);
    if (raw == null) return null;
    const entries = pictureEntries(raw);
    group.forEach((_, i) => {
      const entry = entries.find((e) => Number(e?.picture) === i + 1);
      if (entry) found.set(start + i, entry);
    });
  }
  return found;
}

// One crop of the frame, as a 3:4 JPEG at least CROP_MIN_WIDTH wide.
export async function cutCrop(bytes, { rect, letterbox }) {
  const [l, t, r, b] = rect;
  const piece = await sharp(bytes).rotate().extract({ left: l, top: t, width: r - l, height: b - t }).toBuffer();
  if (!letterbox) {
    const width = Math.max(CROP_MIN_WIDTH, r - l);
    return sharp(piece).resize({ width, kernel: 'lanczos3' }).jpeg({ quality: 88 }).toBuffer();
  }
  // The box on a 3:4 card filled with its own blurred, dimmed copy: nothing
  // from outside the box is shown.
  const layout = letterboxLayout(r - l, b - t);
  const fill = await sharp(piece).resize({ width: layout.width, height: layout.height, fit: 'cover' })
    .blur(18).modulate({ brightness: 0.85 }).toBuffer();
  const inner = await sharp(piece).resize({ width: layout.inner.width, height: layout.inner.height, fit: 'fill', kernel: 'lanczos3' }).toBuffer();
  return sharp(fill).composite([{ input: inner, left: layout.left, top: layout.top }]).jpeg({ quality: 88 }).toBuffer();
}

export async function cropOffers(jobs, { ask, onStep = null }) {
  const result = new Map();
  if (!jobs.length) return result;

  // 1. The product box in each frame.
  const frames = [];
  for (const job of jobs) {
    try {
      const meta = await sharp(job.bytes).rotate().metadata();
      const size = meta.autoOrient ? { width: meta.autoOrient.width, height: meta.autoOrient.height } : { width: meta.width, height: meta.height };
      const factor = Math.min(1, CROP_LONG_EDGE / Math.max(size.width, size.height));
      const sent = { width: Math.round(size.width * factor), height: Math.round(size.height * factor) };
      const data = (factor < 1
        ? await sharp(job.bytes).rotate().resize({ width: sent.width, height: sent.height }).jpeg({ quality: 88 }).toBuffer()
        : await sharp(job.bytes).rotate().jpeg({ quality: 92 }).toBuffer()).toString('base64');
      frames.push({ job, size, sent, factor, data });
    } catch (err) {
      result.set(job.id, { none: `unreadable picture: ${String(err?.message || err).slice(0, 80)}` });
    }
  }
  const boxes = await askInBatches(
    frames.map((f) => ({ data: f.data, text: ` (${f.sent.width}×${f.sent.height} px)${label(f.job.name)}` })),
    BOX_PROMPT, ask,
  );
  if (!boxes) return result;
  onStep?.('boxes', boxes);

  // 2. The boxes to crop around: every package together, then each alone.
  for (const [i, f] of frames.entries()) {
    const entry = boxes.get(i);
    if (!entry) continue; // not answered: asked again later
    const found = packageBoxes(entry, f.sent)
      .map((b) => parseBox(scaleBox(b, f.factor), f.size))
      .filter(Boolean);
    f.steps = found.map((box) => ({ box }));
    f.tries = [];
    if (!found.length) result.set(f.job.id, { none: 'no product box' });
  }

  // 3. Step by step, the crops of every picture still without one are
  // checked twice, the second copy in reverse order; the widest crop that
  // stands is used. A step is a box (all packages first, then each alone),
  // or a box refused for a face part at one edge, trimmed on that edge.
  for (let stage = 0; ; stage += 1) {
    const open = frames.filter((f) => f.steps?.length && !result.has(f.job.id));
    if (!open.length) break;
    const candidates = [];
    for (const f of open) {
      const step = f.steps.shift();
      f.step = step;
      const made = step.trim ? trimCandidates(f.size, step.trim.rect, step.trim.edge) : cropCandidates(f.size, step.box);
      for (const c of made) {
        const cand = { ...c, stage, image: await cutCrop(f.job.bytes, c) };
        f.tries.push(cand);
        candidates.push({ frame: f, cand });
      }
    }
    if (!candidates.length) continue;
    const items = candidates.map((c) => ({ data: c.cand.image.toString('base64'), text: label(c.frame.job.name) }));
    const order = items.map((_, i) => i);
    const copies = [];
    for (const list of [order, [...order].reverse()]) {
      const found = await askInBatches(list.map((i) => items[i]), CHECK_PROMPT, ask);
      if (!found) return result;
      const byCandidate = new Map();
      list.forEach((i, k) => byCandidate.set(i, found.get(k)));
      copies.push(byCandidate);
    }
    candidates.forEach((c, i) => {
      c.cand.checks = copies.map((copy) => {
        const e = copy.get(i);
        if (!e) return null;
        return { face: e.face === true ? true : e.face === false ? false : null, edge: e.edge ?? null, product: e.product === true };
      });
    });
    onStep?.('checks', candidates);
    for (const f of open) {
      const mine = f.tries.filter((t) => t.stage === stage);
      const k = chooseCrop(mine.map((t) => t.checks || []));
      if (k >= 0) {
        const { image, kind, rect } = mine[k];
        result.set(f.job.id, { image, kind, rect, box: f.step.box || f.step.trim.rect, stage, tries: f.tries.map(({ image: _, ...t }) => t) });
        continue;
      }
      // The box itself showed a face part at one edge: that edge is cut next.
      const tight = f.step.box ? mine.find((t) => t.kind === 'tight') : null;
      const edge = tight ? faceEdge(tight.checks) : null;
      if (edge) f.steps.unshift({ trim: { rect: tight.rect, edge } });
    }
  }

  // 4. Nothing stood: no picture.
  for (const f of frames) {
    if (!f.steps || result.has(f.job.id)) continue;
    result.set(f.job.id, f.tries.length
      ? { none: 'every crop shows a face or misses the product', tries: f.tries.map(({ image, ...t }) => t) }
      : { none: 'no crop fits' });
  }
  return result;
}
