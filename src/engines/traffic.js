/**
 * TRAFFIC MODEL
 *
 * One curve, used by both halves of the product. The fleet optimiser and the
 * personal journey planner have to agree about what 18:00 means, or "leave at
 * noon instead" would be advice one of them could not honour.
 *
 * This is modelled, not observed: a deterministic time-of-day demand curve
 * applied to free-flow road durations. It is plausible and consistent, and the
 * interface says so wherever it is shown. It is not a live feed.
 */

import { TRAFFIC } from '../config.js';
import { clamp } from '../util/math.js';

/**
 * Relative demand at a clock time, interpolated between hourly samples.
 * Wraps across midnight, so a plan that runs for days keeps working.
 */
export function demandAt(minutes) {
  const h = (((minutes ?? 0) / 60) % 24 + 24) % 24;
  const i = Math.floor(h);
  const f = h - i;
  const a = TRAFFIC.diurnal[i % 24];
  const b = TRAFFIC.diurnal[(i + 1) % 24];
  return a + (b - a) * f;
}

/**
 * Demand to a travel-time multiplier.
 *
 * Superlinear, the way real volume/delay curves behave: the last ten percent
 * of capacity costs far more than the first.
 */
export const congestionFrom = (demand) => 1 + 0.62 * (clamp(demand, 0, 3.2) ** 1.9);

/** Travel-time multiplier at a clock time. Always >= 1. */
export const congestionAt = (minutes, multiplier = 1) =>
  congestionFrom(clamp(demandAt(minutes) * multiplier, 0, 2.6));

/** The quietest departure hour in a window, for the "when should I leave" sweep. */
export function quietestHour(fromMinutes, hours = 12) {
  let best = fromMinutes;
  let bestC = Infinity;
  for (let i = 0; i <= hours; i++) {
    const m = fromMinutes + i * 60;
    const c = congestionAt(m);
    if (c < bestC) { bestC = c; best = m; }
  }
  return { minutes: best, congestion: bestC };
}
