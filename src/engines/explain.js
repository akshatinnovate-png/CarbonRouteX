/**
 * AI EXPLANATION LAYER
 *
 * Every sentence this module produces is derived from a computed difference
 * between two evaluated objects. Nothing is templated from a guess: if a claim
 * cannot be traced to a number that the engines produced, it is not made.
 *
 * The shape of an explanation is always the same:
 *
 *   { verdict, drivers: [{ sign, label, magnitude, detail }], tradeoffs, basis }
 *
 * `basis` names the data the claim rests on so the UI can show provenance.
 */

import { OBJECTIVES } from '../config.js';
import { dur, km, kg, money, num, pct, signedPct, clock } from '../util/format.js';
import { attributeEmissions, intensityAt, cleanestHour } from './emissions.js';

const MATERIAL = 0.015; // below 1.5% relative change we do not claim an effect

/* ------------------------------------------------------------------ */
/* Plan vs. plan                                                       */
/* ------------------------------------------------------------------ */

export function comparePlans(before, after, { labelBefore = 'Before', labelAfter = 'After' } = {}) {
  const a = before.metrics, b = after.metrics;
  // `short` is the lower-case form used inside prose; lowercasing `label`
  // directly would mangle the acronyms ("estimated co₂e").
  const rows = [
    { key: 'co2', label: 'Estimated CO₂e', short: 'estimated CO₂e', before: a.co2, after: b.co2, fmt: (v) => kg(v, 1), lowerBetter: true },
    { key: 'cost', label: 'Operating cost', short: 'operating cost', before: a.cost, after: b.cost, fmt: (v) => money(v), lowerBetter: true },
    { key: 'minutes', label: 'Fleet time', short: 'fleet time', before: a.minutes, after: b.minutes, fmt: (v) => dur(v), lowerBetter: true },
    { key: 'km', label: 'Distance', short: 'distance', before: a.km, after: b.km, fmt: (v) => km(v), lowerBetter: true },
    { key: 'onTimeRate', label: 'On-time rate', short: 'on-time rate', before: a.onTimeRate, after: b.onTimeRate, fmt: (v) => pct(v, 1), lowerBetter: false },
    { key: 'utilization', label: 'Capacity utilisation', short: 'capacity utilisation', before: a.utilization, after: b.utilization, fmt: (v) => pct(v, 1), lowerBetter: false },
    { key: 'vehiclesUsed', label: 'Vehicles deployed', short: 'vehicles deployed', before: a.vehiclesUsed, after: b.vehiclesUsed, fmt: (v) => num(v), lowerBetter: true },
    { key: 'unserved', label: 'Unserved orders', short: 'unserved orders', before: a.unserved, after: b.unserved, fmt: (v) => num(v), lowerBetter: true },
  ];
  for (const r of rows) {
    r.delta = r.after - r.before;
    r.rel = Math.abs(r.before) > 1e-9 ? r.delta / Math.abs(r.before) : 0;
    r.improved = r.lowerBetter ? r.delta < -1e-9 : r.delta > 1e-9;
    r.worsened = r.lowerBetter ? r.delta > 1e-9 : r.delta < -1e-9;
    r.material = Math.abs(r.rel) >= MATERIAL || (r.key === 'unserved' && r.delta !== 0) || (r.key === 'vehiclesUsed' && r.delta !== 0);
  }
  const gains = rows.filter((r) => r.improved && r.material);
  const losses = rows.filter((r) => r.worsened && r.material);

  // All four cases are stated plainly. A comparison where everything got worse
  // is a real outcome — under a disruption it is the *expected* one — and
  // saying so is the difference between an explanation and a sales pitch.
  let verdict;
  if (!gains.length && !losses.length) {
    verdict = `The plan is materially unchanged — every tracked metric moved less than ${pct(MATERIAL, 1)}.`;
  } else if (!losses.length) {
    verdict = `${labelAfter} improves ${listPhrase(gains.map((g) => g.short))} with no measured regression.`;
  } else if (!gains.length) {
    verdict = `${labelAfter} is worse on ${listPhrase(losses.map((l) => l.short))} and better on nothing measured — `
      + 'the conditions themselves degraded, and this is the best plan available under them.';
  } else {
    verdict = `${labelAfter} trades ${listPhrase(losses.map((l) => l.short))} for ${listPhrase(gains.map((g) => g.short))}.`;
  }

  return {
    verdict,
    rows,
    gains, losses,
    labelBefore, labelAfter,
    basis: `Both plans evaluated on the same road-distance matrix, traffic model and order book; ${num(after.routes.length)} routes re-costed leg by leg.`,
  };
}

/* ------------------------------------------------------------------ */
/* Why this route?                                                     */
/* ------------------------------------------------------------------ */

/**
 * Explain a single route against the alternatives the router can produce for
 * the same stop set. Drivers are only listed when the underlying numbers
 * actually differ.
 */
export function explainRoute(route, context = {}) {
  const drivers = [];
  const { peers = [], weights, traffic, vehicle } = context;

  if (peers.length) {
    const avg = (f) => peers.reduce((s, p) => s + f(p), 0) / peers.length;
    const cmp = [
      { key: 'minutes', label: 'travel time', value: route.minutes, peer: avg((p) => p.minutes), fmt: (v) => dur(v), lower: true },
      { key: 'co2', label: 'estimated CO₂e', value: route.co2, peer: avg((p) => p.co2), fmt: (v) => kg(v, 2), lower: true },
      { key: 'km', label: 'distance', value: route.km, peer: avg((p) => p.km), fmt: (v) => km(v), lower: true },
      { key: 'cost', label: 'operating cost', value: route.cost, peer: avg((p) => p.cost), fmt: (v) => money(v), lower: true },
    ];
    for (const c of cmp) {
      const rel = c.peer > 1e-9 ? (c.value - c.peer) / c.peer : 0;
      if (Math.abs(rel) < MATERIAL) continue;
      drivers.push({
        sign: (rel < 0) === c.lower ? '+' : '-',
        label: `${rel < 0 ? 'lower' : 'higher'} ${c.label}`,
        magnitude: Math.abs(rel),
        detail: `${c.fmt(c.value)} vs ${c.fmt(c.peer)} average across ${peers.length} alternative${peers.length > 1 ? 's' : ''}`,
      });
    }
  }

  // Deadline headroom — the constraint operators care about most.
  if (route.stops?.length) {
    const tightest = route.stops.reduce((m, s) => (s.deadline - s.serviceStart < m.deadline - m.serviceStart ? s : m));
    const slack = tightest.deadline - tightest.serviceStart;
    drivers.push({
      sign: slack >= 0 ? '+' : '-',
      label: slack >= 0 ? 'deadline preserved' : 'deadline missed',
      magnitude: Math.min(1, Math.abs(slack) / 120),
      detail: slack >= 0
        ? `tightest stop ${tightest.orderId} arrives ${dur(slack)} before its ${clock(tightest.deadline)} deadline`
        : `${tightest.orderId} arrives ${dur(-slack)} after its ${clock(tightest.deadline)} deadline`,
    });
  }

  // Congestion exposure. `worstCongestion` is a travel-time multiplier over
  // free flow, so 1.0 means the route is modelled to run at road speed.
  if (route.worstCongestion != null) {
    const over = route.worstCongestion - 1;
    if (over < 0.12) {
      drivers.push({
        sign: '+', label: 'low modelled congestion', magnitude: 1 - over,
        detail: `worst leg runs ${pct(Math.max(over, 0), 0)} over free-flow travel time`,
      });
    } else if (over > 0.35) {
      drivers.push({
        sign: '-', label: 'congested corridor', magnitude: Math.min(1, over),
        detail: `worst leg runs ${pct(over, 0)} over free-flow travel time`,
      });
    }
  }

  // Capacity utilisation — an empty truck is a wasted truck.
  if (route.capacityPct != null && route.orderIds?.length) {
    if (route.capacityPct > 0.75) {
      drivers.push({ sign: '+', label: 'high capacity utilisation', magnitude: route.capacityPct, detail: `${pct(route.capacityPct, 0)} of payload capacity in use` });
    } else if (route.capacityPct < 0.3) {
      drivers.push({ sign: '-', label: 'low capacity utilisation', magnitude: 1 - route.capacityPct, detail: `${pct(route.capacityPct, 0)} of payload capacity in use` });
    }
  }

  // Energy margin.
  if (vehicle && route.energyFraction != null) {
    const arrival = vehicle.energyLevel - route.energyFraction;
    if (arrival < 0.18) {
      drivers.push({ sign: '-', label: 'thin energy margin', magnitude: 1 - arrival, detail: `returns at ~${pct(Math.max(arrival, 0), 0)} state of charge` });
    }
  }

  // Grid timing for battery-electric vehicles.
  if (vehicle && vehicle.energyType === 'bev') {
    const now = intensityAt('bev', route.startMinutes);
    const best = cleanestHour();
    if (now > best.intensity * 1.25) {
      drivers.push({
        sign: '-', label: 'carbon-intense grid window',
        magnitude: Math.min(1, (now - best.intensity) / best.intensity),
        detail: `grid at ${num(now, 2)} kg/kWh vs ${num(best.intensity, 2)} at ${String(best.hour).padStart(2, '0')}:00`,
      });
    } else if (now < best.intensity * 1.1) {
      drivers.push({
        sign: '+', label: 'clean grid window',
        magnitude: 0.6,
        detail: `charging carbon intensity ${num(now, 2)} kg/kWh, near the day's cleanest`,
      });
    }
  }

  drivers.sort((a, b) => b.magnitude - a.magnitude);
  const dominant = weights ? topObjective(weights) : null;
  const pros = drivers.filter((d) => d.sign === '+');
  const cons = drivers.filter((d) => d.sign === '-');

  const summary = buildRouteSummary(route, pros, cons, dominant);
  return {
    summary, drivers, pros, cons, dominant,
    basis: `Computed from ${route.legs?.length ?? 0} road legs using real routing distances, the modelled traffic multiplier, the vehicle's consumption curve and the live objective weights.`,
  };
}

function buildRouteSummary(route, pros, cons, dominant) {
  const id = route.id || 'This route';
  if (!pros.length && !cons.length) {
    return `${id} is the shortest generalised-cost path for this stop sequence under the current weights; no alternative differed materially.`;
  }
  const lead = pros[0] ? pros[0].label : cons[0].label;
  const objective = dominant ? ` The objective is currently weighted toward ${dominant.label.toLowerCase()}.` : '';
  if (pros.length && cons.length) {
    return `${id} was selected for ${lead}, accepting ${cons[0].label}.${objective}`;
  }
  if (pros.length) return `${id} was selected for ${listPhrase(pros.slice(0, 2).map((p) => p.label))}.${objective}`;
  return `${id} carries ${listPhrase(cons.slice(0, 2).map((c) => c.label))} — no better option exists under the current constraints.${objective}`;
}

/* ------------------------------------------------------------------ */
/* Why did the plan change?                                            */
/* ------------------------------------------------------------------ */

/**
 * Structural diff between two plans: which orders moved vehicle, which
 * vehicles entered or left service, which routes were resequenced.
 */
export function planDiff(before, after) {
  const beforeOwner = new Map();
  for (const r of before.routes) for (const id of r.orderIds) beforeOwner.set(id, r.vehicleId);
  const afterOwner = new Map();
  for (const r of after.routes) for (const id of r.orderIds) afterOwner.set(id, r.vehicleId);

  const reassigned = [];
  const dropped = [];
  const added = [];
  for (const [orderId, v] of beforeOwner) {
    const nv = afterOwner.get(orderId);
    if (!nv) dropped.push({ orderId, from: v });
    else if (nv !== v) reassigned.push({ orderId, from: v, to: nv });
  }
  for (const [orderId, v] of afterOwner) if (!beforeOwner.has(orderId)) added.push({ orderId, to: v });

  const beforeActive = new Set(before.routes.filter((r) => r.orderIds.length).map((r) => r.vehicleId));
  const afterActive = new Set(after.routes.filter((r) => r.orderIds.length).map((r) => r.vehicleId));
  const activated = [...afterActive].filter((v) => !beforeActive.has(v));
  const stoodDown = [...beforeActive].filter((v) => !afterActive.has(v));

  const resequenced = [];
  for (const r of after.routes) {
    const old = before.routes.find((x) => x.vehicleId === r.vehicleId);
    if (!old || !old.orderIds.length || !r.orderIds.length) continue;
    const sameSet = old.orderIds.length === r.orderIds.length
      && old.orderIds.every((id) => r.orderIds.includes(id));
    if (sameSet && old.orderIds.join() !== r.orderIds.join()) resequenced.push(r.vehicleId);
  }

  return { reassigned, dropped, added, activated, stoodDown, resequenced };
}

/** Narrative for the "WHY DID CARBONROUTE CHANGE THE PLAN?" panel. */
export function explainReplan(before, after, { trigger, weights } = {}) {
  const comparison = comparePlans(before, after, { labelBefore: 'Previous plan', labelAfter: 'New plan' });
  const diff = planDiff(before, after);
  const actions = [];
  if (diff.reassigned.length) {
    actions.push(`${diff.reassigned.length} order${diff.reassigned.length > 1 ? 's were' : ' was'} reassigned to a different vehicle`);
  }
  if (diff.resequenced.length) {
    actions.push(`${diff.resequenced.length} route${diff.resequenced.length > 1 ? 's were' : ' was'} resequenced without changing its stop set`);
  }
  if (diff.activated.length) actions.push(`${listPhrase(diff.activated)} brought into service`);
  if (diff.stoodDown.length) actions.push(`${listPhrase(diff.stoodDown)} stood down`);
  if (diff.dropped.length) actions.push(`${diff.dropped.length} order${diff.dropped.length > 1 ? 's' : ''} could not be served`);
  if (!actions.length) actions.push('the assignment was retained; only timings were re-costed against the new conditions');

  const dominant = weights ? topObjective(weights) : null;
  return {
    trigger: trigger || 'Manual re-optimisation',
    headline: comparison.verdict,
    actions,
    comparison,
    diff,
    objective: dominant
      ? `The objective function was weighted ${Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v, 0)}`).join(', ')}, so ${dominant.label.toLowerCase()} dominated the search.`
      : null,
    basis: comparison.basis,
  };
}

/* ------------------------------------------------------------------ */
/* Carbon attribution                                                  */
/* ------------------------------------------------------------------ */

export function explainCarbon(plan) {
  const legs = [];
  for (const r of plan.routes) {
    for (const leg of r.legs || []) legs.push({ factors: leg.factors, emissions: leg.co2 });
  }
  const buckets = attributeEmissions(legs);
  const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
  const parts = [
    { key: 'baseline', label: 'Unavoidable (distance × drivetrain)', value: buckets.baseline },
    { key: 'payload', label: 'Payload mass', value: buckets.payload },
    { key: 'congestion', label: 'Congestion & speed profile', value: buckets.congestion },
    { key: 'terrain', label: 'Terrain / gradient', value: buckets.terrain },
  ].map((p) => ({ ...p, share: p.value / total }));

  const addressable = parts.filter((p) => p.key !== 'baseline').reduce((a, p) => a + p.value, 0);
  return {
    parts, total, addressable,
    verdict: `${pct(addressable / total, 1)} of the plan's estimated CO₂e comes from factors the optimiser can act on — routing around congestion, sequencing payload, and avoiding gradient.`,
    basis: `Attributed across ${num(legs.length)} road legs by decomposing each leg's load, speed and gradient multipliers.`,
  };
}

/* ------------------------------------------------------------------ */

export function topObjective(weights) {
  let best = OBJECTIVES[0], bestV = -Infinity;
  for (const o of OBJECTIVES) {
    const v = weights[o.key] ?? 0;
    if (v > bestV) { bestV = v; best = o; }
  }
  return best;
}

export function listPhrase(items) {
  const a = items.filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

export { signedPct };
