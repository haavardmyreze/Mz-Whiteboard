'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const snap = require('../public/snap');

const box = (x, y, w, h, kind = 'content') => ({ x, y, w, h, kind });

test('snap: an edge near another edge lines up with it', () => {
  // The moved box's left edge is 3 off the target's left edge.
  const r = snap.move(box(103, 300, 50, 50), [box(100, 0, 80, 80)], 7);
  assert.equal(r.dx, -3);
  assert.equal(r.dy, 0);
  assert.ok(r.guides.some((g) => g.x1 === 100 && g.x2 === 100), 'a vertical guide at x = 100');
});

test('snap: nothing within reach leaves it where it is', () => {
  const r = snap.move(box(500, 500, 50, 50), [box(0, 0, 80, 80)], 7);
  assert.deepEqual([r.dx, r.dy, r.guides.length], [0, 0, 0]);
});

test('snap: centres line up too', () => {
  // The target's centre is x = 140; the moved box's is 117 + 25 = 142.
  const r = snap.move(box(117, 300, 50, 50), [box(100, 0, 80, 80)], 7);
  assert.equal(r.dx, -2); // 117 + 25 = 142 -> 140
});

test('snap: the same gap as two neighbours have', () => {
  // A at 0..100, B at 150..250 (gap 50), all on one row. A box near 300 goes to 250 + 50 = 300.
  const row = [box(0, 0, 100, 100), box(150, 0, 100, 100)];
  const r = snap.move(box(304, 0, 100, 100), row, 7);
  assert.equal(r.dx, -4);
  assert.ok(r.guides.some((g) => g.gap), 'gap guides are drawn');
  // Without spacing, only edges count: 304 is not within 7 of any edge or centre (250 is 54 away).
  assert.equal(snap.move(box(304, 0, 100, 100), row, 7, false).dx, 0);
});

test('snap: the first kind in order that has anything wins, even if another is nearer', () => {
  const targets = [box(101, 0, 80, 80, 'content'), box(105, 0, 80, 80, 'frame')];
  assert.equal(snap.move(box(103, 300, 50, 50), targets, 7, true, ['frame', 'block', 'content']).dx, 2);
  assert.equal(snap.move(box(103, 300, 50, 50), targets, 7, true, ['content', 'block', 'frame']).dx, -2);
});

test('snap: the reach is in board units, so it scales with the zoom', () => {
  const t = [box(100, 0, 80, 80)];
  // Its right edge, 132, is 8 from the target's centre, 140.
  assert.equal(snap.move(box(112, 300, 20, 20), t, 7).dx, 0);
  assert.equal(snap.move(box(112, 300, 20, 20), t, 14).dx, 8); // zoomed out 2x: 7px reaches 14 units
});
