'use strict';

// Smart snapping, the geometry of it: where a moved or placed thing lines up with what is near it (an edge,
// a centre, or the same gap as two neighbours have between them), and the guides that show why. No DOM, no
// board: board.js gives the rects and draws the guides. Also loaded by the tests.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.WBSnap = make();
})(typeof self !== 'undefined' ? self : this, () => {
  const spanOverlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  const spanMid = (a0, a1, b0, b1) => (Math.max(a0, b0) + Math.min(a1, b1)) / 2;

  // Nearest alignment or equal-spacing position along one axis. Rects arrive as
  // { p, s, q, c }: position and size along the axis, position and size across it.
  function snapAxis(m, ts, thr, spacing) {
    const cands = [];
    const lines = (t) => [t.p, t.p + t.s / 2, t.p + t.s];
    const mLines = lines(m);
    const across = (a, b) => spanMid(a.q, a.q + a.c, b.q, b.q + b.c);
    const seg = (p0, p1, q) => ({ p0, p1, q });
    for (const t of ts) {
      for (const a of lines(t)) {
        for (const b of mLines) {
          const d = a - b;
          if (Math.abs(d) <= thr) cands.push({ d, draw: (f) => [{ p: a, q0: Math.min(f.q, t.q), q1: Math.max(f.q + f.c, t.q + t.c) }] });
        }
      }
    }
    if (spacing && ts.length <= 120) {
      for (const A of ts) {
        for (const B of ts) {
          const gap = B.p - (A.p + A.s);
          if (A === B || gap < 1 || !spanOverlap(A.q, A.q + A.c, B.q, B.q + B.c)) continue;
          const ab = seg(A.p + A.s, B.p, across(A, B));
          const nearA = spanOverlap(m.q, m.q + m.c, A.q, A.q + A.c);
          const nearB = spanOverlap(m.q, m.q + m.c, B.q, B.q + B.c);
          let d = B.p + B.s + gap - m.p;
          if (nearB && Math.abs(d) <= thr) cands.push({ d, draw: (f) => [ab, seg(B.p + B.s, f.p, across(B, f))] });
          d = A.p - gap - m.s - m.p;
          if (nearA && Math.abs(d) <= thr) cands.push({ d, draw: (f) => [ab, seg(f.p + f.s, A.p, across(f, A))] });
          d = A.p + A.s + (gap - m.s) / 2 - m.p;
          if (nearA && nearB && gap > m.s && Math.abs(d) <= thr) {
            cands.push({ d, draw: (f) => [seg(A.p + A.s, f.p, across(A, f)), seg(f.p + f.s, B.p, across(f, B))] });
          }
        }
      }
    }
    if (!cands.length) return null;
    let d = 0;
    let best = Infinity;
    for (const c of cands) {
      if (Math.abs(c.d) < best) {
        best = Math.abs(c.d);
        d = c.d;
      }
    }
    const fin = { ...m, p: m.p + d };
    return { d, guides: cands.filter((c) => Math.abs(c.d - d) < 0.01).flatMap((c) => c.draw(fin)) };
  }

  // Nudges a rect onto nearby edges, centres and equal gaps of the targets, each { x, y, w, h, kind }, within
  // `thr` (board units). Each axis takes the first kind in `order` that has anything to snap to. Returns the
  // offset and the guides to draw, in board units.
  function move(r, targets, thr, spacing = true, order = ['content', 'block', 'frame']) {
    const ax = (t) => ({ p: t.x, s: t.w, q: t.y, c: t.h });
    const ay = (t) => ({ p: t.y, s: t.h, q: t.x, c: t.w });
    // Each axis takes the first kind in priority order that has anything to snap to.
    const groups = order.map((kind) => targets.filter((t) => t.kind === kind)).filter((g) => g.length);
    const first = (axis, convert) => {
      for (const g of groups) {
        const found = snapAxis(convert(r), g.map(convert), thr, spacing);
        if (found) return found;
      }
      return null;
    };
    const sx = first('x', ax);
    const sy = first('y', ay);
    const guides = [];
    for (const g of sx ? sx.guides : []) {
      guides.push('q0' in g ? { x1: g.p, y1: g.q0, x2: g.p, y2: g.q1 } : { x1: g.p0, y1: g.q, x2: g.p1, y2: g.q, gap: true });
    }
    for (const g of sy ? sy.guides : []) {
      guides.push('q0' in g ? { x1: g.q0, y1: g.p, x2: g.q1, y2: g.p } : { x1: g.q, y1: g.p0, x2: g.q, y2: g.p1, gap: true });
    }
    return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0, guides };
  }

  return { move, axis: snapAxis };
});
