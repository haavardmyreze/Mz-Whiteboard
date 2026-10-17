'use strict';

// Which asset, set or shot a video is most likely a new version of, by the video itself. A new version of
// a shot is most often as long as the one before it, at the same frame rate and size, and looks much like
// it along its length: its colour strip (the colours of the top and bottom of its picture at 512 moments,
// made as it was brought in; see ingest.js) rises and falls in the same places. Nothing is decided here:
// what is found is only put first among the suggestions where the video is filed. Images are not
// matched: a picture's size alone says too little.

const COLS = 512;
const LUMA = [0.299, 0.587, 0.114];

// A strip as bytes (COLS columns of top and bottom RGB), or null when it is not one.
function strip(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const bytes = Buffer.from(b64, 'base64');
  return bytes.length === COLS * 6 ? bytes : null;
}

// The brightness of each column, top and bottom together.
function luma(s) {
  const out = new Float64Array(COLS);
  for (let i = 0; i < COLS; i++) {
    let v = 0;
    for (let c = 0; c < 3; c++) v += LUMA[c] * (s[i * 6 + c] + s[i * 6 + 3 + c]) / 2;
    out[i] = v;
  }
  return out;
}

// How alike two strips are, from 0 to 1: how close their colours are, and, when their picture changes
// along the way, whether it changes in the same places.
function pictureLikeness(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  // Two unrelated videos are seldom further apart than a fifth of the range on average; the same shot again is very close.
  const close = Math.max(0, Math.min(1, 1 - (diff / a.length / 255) / 0.2));
  const la = luma(a);
  const lb = luma(b);
  const mean = (l) => l.reduce((x, y) => x + y, 0) / l.length;
  const ma = mean(la);
  const mb = mean(lb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < COLS; i++) {
    cov += (la[i] - ma) * (lb[i] - mb);
    va += (la[i] - ma) ** 2;
    vb += (lb[i] - mb) ** 2;
  }
  // A picture that hardly changes says nothing by how it changes.
  const moving = Math.sqrt(va / COLS) > 6 && Math.sqrt(vb / COLS) > 6;
  if (!moving) return close;
  return 0.5 * close + 0.5 * Math.max(0, cov / Math.sqrt(va * vb));
}

// How like `head` (a version's look) the video `look` is: { score, why }, why being what was alike.
function likeness(look, head, headStrip, lookStrip) {
  const why = [];
  const fpsKnown = look.fps > 0 && head.fps > 0;
  const sameRate = fpsKnown && Math.abs(look.fps - head.fps) < 0.01;
  let length = 0;
  if (look.dur > 0 && head.dur > 0) {
    const fps = sameRate ? look.fps : 24;
    const frames = Math.abs(look.dur - head.dur) * fps;
    if (frames <= 1.01) length = 1;
    else if (frames <= fps / 2) length = 0.7;
    else if (Math.abs(look.dur - head.dur) / Math.max(look.dur, head.dur) < 0.05) length = 0.4;
  }
  if (length >= 0.7) why.push(length === 1 ? 'same length' : 'nearly the same length');
  const size = look.nw > 0 && look.nw === head.nw && look.nh === head.nh ? 1 : 0;
  const picture = lookStrip && headStrip ? pictureLikeness(lookStrip, headStrip) : 0;
  if (picture >= 0.6) why.push('looks alike');
  let score = 0.45 * length + 0.4 * picture + 0.15 * size;
  if (fpsKnown && !sameRate) score *= 0.5;
  return { score, why };
}

// The streams (an entity and task) of a project whose newest version a video most likely follows, best
// first: [{ head, score, why }] for those likely enough, at most `max`. `heads` are those newest
// versions; `stripOf(version)` gives a version's strip as bytes (so it can be kept between calls).
function likelyFor(look, heads, stripOf, max = 3) {
  if (!look || look.type !== 'video') return [];
  const mine = strip(look.wf);
  const found = [];
  for (const head of heads) {
    if (!head.look || head.look.type !== 'video') continue;
    const { score, why } = likeness(look, head.look, stripOf(head), mine);
    if (score >= 0.5 && why.length) found.push({ head, score: Math.round(score * 100) / 100, why });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, max);
}

module.exports = { strip, likeness, likelyFor };
