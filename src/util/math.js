/** Small deterministic math / geometry helpers. No dependencies. */

/** Mulberry32 — fast, deterministic, decent distribution. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const round = (v, d = 0) => { const p = 10 ** d; return Math.round(v * p) / p; };

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };

/** Shortest distance from point p to segment ab, in the same units. */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Total length of a polyline [{x,y}, ...]. */
export function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}

/** Point at arc-length `s` along a polyline; returns {x, y, heading, index}. */
export function pointAtLength(pts, s) {
  if (!pts.length) return { x: 0, y: 0, heading: 0, index: 0 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, heading: 0, index: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= s || i === pts.length - 1) {
      const t = seg === 0 ? 0 : clamp((s - acc) / seg, 0, 1);
      return {
        x: lerp(pts[i - 1].x, pts[i].x, t),
        y: lerp(pts[i - 1].y, pts[i].y, t),
        heading: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x),
        index: i - 1,
      };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y, heading: 0, index: pts.length - 1 };
}

/** Catmull-Rom smoothing of a polyline — used to make roads look drawn, not plotted. */
export function smoothPolyline(pts, segmentsPerSpan = 6) {
  if (pts.length < 3) return pts.slice();
  const out = [];
  const get = (i) => pts[clamp(i, 0, pts.length - 1)];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let j = 0; j < segmentsPerSpan; j++) {
      const t = j / segmentsPerSpan, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Min/max of a numeric array; returns [min, max] with a guard for empties. */
export function extent(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === Infinity) return [0, 1];
  if (lo === hi) return [lo, lo + 1e-9];
  return [lo, hi];
}

/** Normalise v into 0..1 given an extent, guarding against degenerate ranges. */
export function normalize(v, [lo, hi]) {
  if (hi - lo < 1e-9) return 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/** Fisher-Yates using a supplied rng. Mutates and returns the array. */
export function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

/** Gaussian-ish value in [0,1] via the mean of 3 uniforms. */
export const gauss = (rand) => (rand() + rand() + rand()) / 3;

export const sum = (arr, f = (x) => x) => arr.reduce((a, b) => a + f(b), 0);
export const mean = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);
