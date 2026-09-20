/** Presentation-layer formatting. Pure functions, no DOM. */
import { APP, WORLD } from '../config.js';

const nf = (d) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const cache = new Map();
function numfmt(d) {
  if (!cache.has(d)) cache.set(d, nf(d));
  return cache.get(d);
}

export const num = (v, d = 0) => (Number.isFinite(v) ? numfmt(d).format(v) : '—');
export const km = (v, d = 1) => `${num(v, d)} km`;
export const kg = (v, d = 1) => `${num(v, d)} kg`;
export const pct = (v, d = 1) => `${num(v * 100, d)}%`;
export const pctRaw = (v, d = 1) => `${num(v, d)}%`;
export const money = (v, d = 0) => `${APP.currency}${num(v, d)}`;

/** Minutes (can exceed a day) → "2h 14m" / "46m". */
export function dur(mins, opts = {}) {
  if (!Number.isFinite(mins)) return '—';
  const sign = mins < 0 ? '-' : '';
  const m = Math.round(Math.abs(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${sign}${r}m`;
  if (opts.compact) return `${sign}${h}h${r ? ` ${r}m` : ''}`;
  return `${sign}${h}h ${String(r).padStart(2, '0')}m`;
}

/** Minutes-since-midnight → "14:42". */
export function clock(minutes) {
  if (!Number.isFinite(minutes)) return '--:--';
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes-since-midnight → "19:42:08" using the fractional part as seconds. */
export function clockSeconds(minutes) {
  const total = Math.max(0, Math.round(minutes * 60));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Signed delta with explicit sign, e.g. "+3.4" / "-12". */
export const signed = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), d)}`;
export const signedPct = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v) * 100, d)}%`;

/** Relative change b vs a, guarded against a == 0. */
export const delta = (a, b) => (Math.abs(a) < 1e-9 ? 0 : (b - a) / Math.abs(a));

/** World km coordinates → pseudo lat/lon string, for the coordinate readout. */
export function geo(x, y) {
  const lat = WORLD.anchor.lat + (-y) / WORLD.kmPerDegLat;
  const lon = WORLD.anchor.lon + x / WORLD.kmPerDegLon;
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
}

export const titleCase = (s) => s.replace(/(^|[\s_-])(\w)/g, (_, a, b) => (a === '_' || a === '-' ? ' ' : a) + b.toUpperCase());

/** Escape for safe interpolation into innerHTML. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
