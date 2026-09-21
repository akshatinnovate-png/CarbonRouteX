/** Presentation-layer formatting. Pure functions, no DOM. */
import { APP } from '../config.js';

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

/**
 * Which day of the plan a timestamp falls on. Day 1 is the operating day the
 * plan starts on, so `dayOf(0)` is 1, not 0 — operators count from one.
 */
export const dayOf = (minutes) => Math.floor((minutes ?? 0) / 1440) + 1;

/**
 * A plan timestamp, shown with its day only when there is a day to show.
 *
 * Times in this model are minutes from the start of the planning horizon, not
 * minutes past midnight, because long haul does not fit in a day. Printing
 * "14:00" for something two days out would be a lie of omission.
 */
export function stamp(minutes, { long = false } = {}) {
  if (!Number.isFinite(minutes)) return '--:--';
  const day = dayOf(minutes);
  const hhmm = clock(minutes);
  if (day <= 1) return hhmm;
  return long ? `Day ${day}, ${hhmm}` : `D${day} ${hhmm}`;
}

/** The real calendar date a plan minute falls on, given the plan's start. */
export function planDate(minutes, startISO) {
  const base = startISO ? new Date(`${startISO}T00:00:00`) : new Date();
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + Math.floor((minutes ?? 0) / 1440));
  return base;
}

export const isoDate = (d) => {
  const t = new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** "Tue 23 Sep" — a date somebody can act on without counting days. */
export const dateLabel = (d) => new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short',
}).format(new Date(d));

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

/** Real coordinates → a readable N/S, E/W string. */
export function geo(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '—';
  return `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? 'E' : 'W'}`;
}

export const titleCase = (s) => s.replace(/(^|[\s_-])(\w)/g, (_, a, b) => (a === '_' || a === '-' ? ' ' : a) + b.toUpperCase());

/** Escape for safe interpolation into innerHTML. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
