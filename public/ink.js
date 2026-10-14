'use strict';

// Drawing, the same on a board and in the player: the colours ink comes in, the shape of a line (a
// pen stroke whose width follows the pressure, or an arrow), a stroke made from what was drawn, and how
// near a point is to it. Text with its web addresses made into links is here too. Loaded after
// common.js, before viewer.js and board.js.
const WBInk = (() => {
  const { el, clamp } = WB;
  const INK = ['ink', '#e5484d', '#f59e0b', '#16a34a', '#2f7df6', '#8b5cf6'];
  const LASER_LIFE = 450;
  // 'ink' stands for the theme's own text colour, so a drawing reads well in either theme.
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const inkColor = (c) => (c === 'ink' ? (isLight() ? '#171717' : '#ededed') : c);

  function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  function fillText(node, text) {
    node.replaceChildren();
    if (!text) return;
    text.split(URL_RE).forEach((part, i) => {
      if (!part) return;
      node.append(i % 2 ? el('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }) : part);
    });
  }

  // ---------------------------------------------------------------- ink: the shape of a line

  function pathData(pts, sx, sy, arrow, size) {
    const n = pts.length / 2;
    const X = (i) => pts[i * 2] * sx;
    const Y = (i) => pts[i * 2 + 1] * sy;
    const f = (v) => v.toFixed(1);
    let d = `M${f(X(0))} ${f(Y(0))}`;
    if (n === 1) return `${d}h0.01`;
    if (n === 2) {
      d += `L${f(X(1))} ${f(Y(1))}`;
    } else {
      for (let i = 1; i < n - 1; i++) {
        d += `Q${f(X(i))} ${f(Y(i))} ${f((X(i) + X(i + 1)) / 2)} ${f((Y(i) + Y(i + 1)) / 2)}`;
      }
      d += `L${f(X(n - 1))} ${f(Y(n - 1))}`;
    }
    if (arrow) {
      const tx = X(n - 1);
      const ty = Y(n - 1);
      const ang = Math.atan2(ty - Y(0), tx - X(0));
      const len = size * 4.5;
      d += `M${f(tx - len * Math.cos(ang - 0.45))} ${f(ty - len * Math.sin(ang - 0.45))}L${f(tx)} ${f(ty)}`;
      d += `L${f(tx - len * Math.cos(ang + 0.45))} ${f(ty - len * Math.sin(ang + 0.45))}`;
    }
    return d;
  }

  // Outline of a brush stroke whose width follows `ws` (a 0..1 multiplier of `size` per point).
  function outlinePath(pts, ws, sx, sy, size) {
    const n = pts.length / 2;
    if (!n) return '';
    const f = (v) => v.toFixed(2);
    const P = [];
    const R = [];
    for (let i = 0; i < n; i++) {
      P.push([pts[i * 2] * sx, pts[i * 2 + 1] * sy]);
      R.push(Math.max(0.15, size * (ws[i] ?? 1)) / 2);
    }
    if (n === 1) {
      const [x, y] = P[0];
      return `M${f(x - R[0])} ${f(y)}a${f(R[0])} ${f(R[0])} 0 1 0 ${f(2 * R[0])} 0a${f(R[0])} ${f(R[0])} 0 1 0 ${f(-2 * R[0])} 0z`;
    }
    const A = [];
    const B = [];
    let tx = 1;
    let ty = 0;
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)];
      const b = P[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 1e-6) {
        tx = (b[0] - a[0]) / len;
        ty = (b[1] - a[1]) / len;
      }
      A.push([P[i][0] - ty * R[i], P[i][1] + tx * R[i]]);
      B.push([P[i][0] + ty * R[i], P[i][1] - tx * R[i]]);
    }
    const side = (S) => {
      let d = '';
      for (let i = 1; i < S.length - 1; i++) {
        d += `Q${f(S[i][0])} ${f(S[i][1])} ${f((S[i][0] + S[i + 1][0]) / 2)} ${f((S[i][1] + S[i + 1][1]) / 2)}`;
      }
      return `${d}L${f(S[S.length - 1][0])} ${f(S[S.length - 1][1])}`;
    };
    const last = n - 1;
    let d = `M${f(A[0][0])} ${f(A[0][1])}${side(A)}`;
    d += `A${f(R[last])} ${f(R[last])} 0 0 0 ${f(B[last][0])} ${f(B[last][1])}`;
    d += side(B.slice().reverse());
    d += `A${f(R[0])} ${f(R[0])} 0 0 0 ${f(A[0][0])} ${f(A[0][1])}Z`;
    return d;
  }

  // A stroke drawn as SVG, in whatever units its numbers are in.
  function strokeNode(s) {
    const g = svgEl('g', { transform: `translate(${s.x} ${s.y})` });
    const color = inkColor(s.color);
    if (s.ws && !s.arrow) {
      g.append(svgEl('path', { d: outlinePath(s.pts, s.ws, s.w, s.h, s.size), fill: color }));
    } else {
      g.append(svgEl('path', { d: pathData(s.pts, s.w, s.h, !!s.arrow, s.size), fill: 'none', stroke: color, 'stroke-width': s.size, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return g;
  }

  // A line as it was drawn (absolute points and widths) made into a stroke: its box, and its points within it.
  function makeStroke(pts, ws, size, color, arrow) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    const w = Math.max(x1 - x0, 0.01);
    const h = Math.max(y1 - y0, 0.01);
    const r = (v, k = 100) => Math.round(v * k) / k;
    const stroke = { x: r(x0), y: r(y0), w: r(w), h: r(h), pts: pts.map((v, i) => r(i % 2 ? (v - y0) / h : (v - x0) / w, 10000)), size: r(size), color };
    if (arrow) stroke.arrow = true;
    else stroke.ws = ws.map((v) => r(v));
    return stroke;
  }

  // Where along a stroke its points are, absolutely.
  function strokePoints(s) {
    const out = [];
    for (let i = 0; i < s.pts.length; i += 2) out.push({ x: s.x + s.pts[i] * s.w, y: s.y + s.pts[i + 1] * s.h });
    return out;
  }

  function pointSegDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const k = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
  }

  return { INK, LASER_LIFE, isLight, inkColor, svgEl, fillText, URL_RE, pathData, outlinePath, strokeNode, makeStroke, strokePoints, pointSegDist };
})();
