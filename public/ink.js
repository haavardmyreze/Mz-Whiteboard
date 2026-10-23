'use strict';

// Drawing, the same on a board and in the player: the colours ink comes in, the shape of a line (a pen stroke
// whose width follows the pressure, or an arrow), a stroke made from what was drawn, and how near a point is to
// it. The painter's colours people pick (for a board's frames and blocks, and an animatic's clips) are here
// too, and so is text with its web addresses made into links. Loaded after common.js, before viewer.js and
// board.js.
const WBInk = (() => {
  const { el, clamp } = WB;
  const INK = ['ink', '#e5484d', '#f59e0b', '#16a34a', '#2f7df6', '#8b5cf6'];
  const LASER_LIFE = 450;
  // 'ink' stands for the theme's own text colour, so a drawing reads well in either theme.
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const inkColor = (c) => (c === 'ink' ? (isLight() ? '#171717' : '#ededed') : c);

  // Colours are stored as they were picked and shown through OKLCH, where equal numbers look equally
  // light. Every block is set to one lightness, every frame header to another and every note to a
  // third, so a row of colours reads as one family, white headings are as legible on yellow as on
  // blue, and nothing shouts over the artwork. Only the hue, and how grey it is, comes from the
  // stored colour.
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  function oklchOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return { l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, c: Math.hypot(A, B), h: Math.atan2(B, A) };
  }
  function linearRgb(L, C, h) {
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }
  const toneCache = new Map();
  // The stored colour's hue at the given lightness, with its chroma capped. Greys keep to a range of
  // lightness instead, so black stays darker than grey.
  function tone(hex, L, maxC, grey) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return hex;
    const key = `${hex}|${L}|${maxC}|${grey}`;
    if (toneCache.has(key)) return toneCache.get(key);
    const from = oklchOf(hex);
    let l = L;
    let c = Math.min(from.c, maxC);
    let h = from.h;
    if (from.c < 0.03) {
      c = 0;
      l = Math.min(grey[1], Math.max(grey[0], from.l));
    } else if (L < 0.7 && h > 1.4 && h < 1.92) {
      // A yellow turned down this far goes olive; leaning it towards orange keeps it golden.
      h -= 0.19;
    }
    let rgb = linearRgb(l, c, h);
    // Step the chroma down until the colour fits in sRGB, rather than clipping it to a different hue.
    while (c > 0 && rgb.some((v) => v < -0.0005 || v > 1.0005)) {
      c = Math.max(0, c - 0.004);
      rgb = linearRgb(l, c, h);
    }
    const out = `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0')).join('')}`;
    toneCache.set(key, out);
    return out;
  }
  // Heading blocks: mid-toned, so a white heading always reads.
  const mute = (hex) => (isLight() ? tone(hex, 0.57, 0.16, [0.22, 0.52]) : tone(hex, 0.53, 0.135, [0.27, 0.46]));
  // Frames sit a rung below blocks in the hierarchy: the same hues, set deeper.
  const deepen = (hex) => (isLight() ? tone(hex, 0.47, 0.13, [0.2, 0.42]) : tone(hex, 0.4, 0.1, [0.24, 0.36]));

  // The colours people pick on a board (its frames and free-standing heading blocks) and for an animatic's
  // clips: a painter's box rather than a highlighter set, each named for its pigment, and set through `mute` and `deepen` so every one carries white type.
  // A new block starts in graphite: a heading, not a shout.
  const PIGMENTS = [
    ['#3d3d40', 'Graphite'], ['#c0392b', 'Cadmium red'], ['#c8952c', 'Yellow ochre'], ['#a65a3a', 'Burnt sienna'],
    ['#2e7d67', 'Viridian'], ['#3f4fb0', 'Ultramarine'], ['#7d4b8e', 'Quinacridone violet'], ['#4a5d73', "Payne's grey"],
    ['#17171a', 'Ivory black'],
  ];

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

  return { INK, LASER_LIFE, isLight, inkColor, tone, mute, deepen, PIGMENTS, svgEl, fillText, URL_RE, pathData, outlinePath, strokeNode, makeStroke, strokePoints, pointSegDist };
})();
