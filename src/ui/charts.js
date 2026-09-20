/**
 * CHART PRIMITIVES
 *
 * Small canvas renderers shared by the analytics, frontier and carbon panels.
 * They are deliberately plain: axes, gridlines, one mark type each. Every chart
 * draws only data the engines computed — none of them smooth, extrapolate or
 * invent points.
 */

import { RENDER } from '../config.js';
import { clamp, extent, normalize } from '../util/math.js';
import { C, withAlpha } from '../render/palette.js';

function prep(canvas, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, RENDER.maxDpr);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(80, rect.width || canvas.clientWidth || 300);
  const h = height || rect.height || 160;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

function axes(ctx, box, { xTicks = [], yTicks = [], xLabel, yLabel }) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillStyle = C.faint;

  for (const t of yTicks) {
    const y = Math.round(box.y + box.h - t.p * box.h) + 0.5;
    ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(t.label, box.x - 6, y);
  }
  for (const t of xTicks) {
    const x = Math.round(box.x + t.p * box.w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(t.label, x, box.y + box.h + 6);
  }
  if (xLabel) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = C.muted;
    ctx.fillText(xLabel, box.x + box.w / 2, box.y + box.h + 30);
  }
  if (yLabel) {
    ctx.save();
    ctx.translate(12, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = C.muted;
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

const ticks = (lo, hi, n, fmt) => Array.from({ length: n + 1 }, (_, i) => {
  const v = lo + ((hi - lo) * i) / n;
  return { p: i / n, label: fmt(v), value: v };
});

/* ------------------------------------------------------------------ */

/**
 * Convergence / time-series line chart.
 * `series` = [{ points: [{x, y}], color, label, fill }]
 */
export function lineChart(canvas, series, opts = {}) {
  const { ctx, w, h } = prep(canvas, opts.height);
  const pad = { l: 46, r: 12, t: 12, b: opts.xLabel ? 38 : 22 };
  const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
  if (box.w <= 0 || box.h <= 0) return;

  const all = series.flatMap((s) => s.points);
  if (!all.length) { emptyChart(ctx, box, opts.empty); return; }
  const xr = opts.xDomain || extent(all.map((p) => p.x));
  const yr = opts.yDomain || extent(all.map((p) => p.y));
  const fy = opts.yFormat || ((v) => v.toFixed(2));
  const fx = opts.xFormat || ((v) => Math.round(v));

  axes(ctx, box, {
    yTicks: ticks(yr[0], yr[1], 4, fy),
    xTicks: ticks(xr[0], xr[1], 4, fx),
    xLabel: opts.xLabel, yLabel: opts.yLabel,
  });

  for (const s of series) {
    if (!s.points.length) continue;
    const px = (p) => box.x + normalize(p.x, xr) * box.w;
    const py = (p) => box.y + box.h - normalize(p.y, yr) * box.h;
    if (s.fill) {
      ctx.beginPath();
      ctx.moveTo(px(s.points[0]), box.y + box.h);
      for (const p of s.points) ctx.lineTo(px(p), py(p));
      ctx.lineTo(px(s.points[s.points.length - 1]), box.y + box.h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
      g.addColorStop(0, withAlpha(s.color, 0.28));
      g.addColorStop(1, withAlpha(s.color, 0));
      ctx.fillStyle = g; ctx.fill();
    }
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.8;
    ctx.lineJoin = 'round';
    if (s.dashed) ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * Pareto scatter. Returns a picker: given client coordinates it reports the
 * nearest point, so the panel can wire hover and click without re-deriving the
 * projection.
 */
export function scatterChart(canvas, points, opts = {}) {
  const { ctx, w, h } = prep(canvas, opts.height);
  const pad = { l: 52, r: 16, t: 14, b: 40 };
  const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
  if (box.w <= 0 || box.h <= 0 || !points.length) { emptyChart(ctx, box, opts.empty); return () => null; }

  const xr = extent(points.map((p) => p.x));
  const yr = extent(points.map((p) => p.y));
  // Pad the domain so marks never sit on the axis line.
  const padX = (xr[1] - xr[0]) * 0.08, padY = (yr[1] - yr[0]) * 0.1;
  const XD = [xr[0] - padX, xr[1] + padX];
  const YD = [yr[0] - padY, yr[1] + padY];

  axes(ctx, box, {
    yTicks: ticks(YD[0], YD[1], 4, opts.yFormat || ((v) => v.toFixed(0))),
    xTicks: ticks(XD[0], XD[1], 4, opts.xFormat || ((v) => v.toFixed(0))),
    xLabel: opts.xLabel, yLabel: opts.yLabel,
  });

  const px = (p) => box.x + normalize(p.x, XD) * box.w;
  const py = (p) => box.y + box.h - normalize(p.y, YD) * box.h;

  // The frontier itself, drawn as a staircase through the non-dominated set.
  const front = points.filter((p) => p.onFrontier).sort((a, b) => a.x - b.x);
  if (front.length > 1) {
    ctx.beginPath();
    front.forEach((p, i) => (i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p))));
    ctx.strokeStyle = withAlpha(C.green, 0.4);
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const p of points) {
    const x = px(p), y = py(p);
    const isSel = p.selected;
    const r = isSel ? 7 : p.onFrontier ? 5 : 3.4;
    if (isSel || p.hovered) {
      ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(isSel ? '#ffffff' : C.cyan, 0.16); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? '#ffffff' : p.onFrontier ? C.green : withAlpha(C.muted, 0.55);
    ctx.fill();
    if (p.onFrontier) {
      ctx.strokeStyle = withAlpha('#04070b', 0.8); ctx.lineWidth = 1.2; ctx.stroke();
    }
  }

  // Current-plan marker, so the user can see where they stand on the frontier.
  if (opts.current) {
    const x = px(opts.current), y = py(opts.current);
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 13, y); ctx.lineTo(x - 9, y); ctx.moveTo(x + 9, y); ctx.lineTo(x + 13, y); ctx.stroke();
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = C.amber; ctx.textAlign = 'center';
    ctx.fillText('LIVE', x, y - 14);
  }

  return function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    let best = null, bestD = 22;
    for (const p of points) {
      const d = Math.hypot(px(p) - mx, py(p) - my);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { point: best, x: px(best), y: py(best) } : null;
  };
}

/** Stacked horizontal contribution bar — used for carbon attribution. */
export function stackBar(canvas, parts, opts = {}) {
  const { ctx, w, h } = prep(canvas, opts.height || 26);
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  let x = 0;
  const r = 4;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(0, 0, w, h, r) : ctx.rect(0, 0, w, h);
  ctx.clip();
  for (const p of parts) {
    const pw = (Math.max(0, p.value) / total) * w;
    ctx.fillStyle = p.color;
    ctx.fillRect(x, 0, pw, h);
    if (pw > 34) {
      ctx.fillStyle = 'rgba(4,8,12,.8)';
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round((p.value / total) * 100)}%`, x + pw / 2, h / 2 + 0.5);
    }
    x += pw;
  }
  ctx.restore();
}

/** Radial gauge, 0..1. */
export function gauge(canvas, value, opts = {}) {
  const size = opts.size || 92;
  canvas.style.width = `${size}px`;
  const { ctx, w, h } = prep(canvas, size);
  const cx = w / 2, cy = h / 2 + 4, r = Math.min(w, h) * 0.38;
  const start = Math.PI * 0.78, end = Math.PI * 2.22;
  ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.beginPath(); ctx.arc(cx, cy, r, start, end); ctx.stroke();
  ctx.strokeStyle = opts.color || C.green;
  ctx.beginPath(); ctx.arc(cx, cy, r, start, start + (end - start) * clamp(value, 0, 1)); ctx.stroke();
  ctx.fillStyle = C.text;
  ctx.font = '600 17px ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(opts.label ?? `${Math.round(value * 100)}%`, cx, cy - 1);
  if (opts.caption) {
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.fillStyle = C.faint;
    ctx.fillText(opts.caption.toUpperCase(), cx, cy + 16);
  }
}

/**
 * Sparkline with no axes — for a hero stat's trend. Draws nothing if given
 * fewer than two points, rather than faking a flat line.
 */
export function sparkline(canvas, values, opts = {}) {
  const { ctx, w, h } = prep(canvas, opts.height || 28);
  if (values.length < 2) return;
  const yr = extent(values);
  const px = (i) => (i / (values.length - 1)) * w;
  const py = (v) => h - 2 - normalize(v, yr) * (h - 4);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = opts.color || C.cyan;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, withAlpha(opts.color || C.cyan, 0.22));
  g.addColorStop(1, withAlpha(opts.color || C.cyan, 0));
  ctx.fillStyle = g; ctx.fill();
}

function emptyChart(ctx, box, message) {
  ctx.save();
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = C.faint;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(message || 'No data yet', box.x + box.w / 2, box.y + box.h / 2);
  ctx.restore();
}
