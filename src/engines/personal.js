/**
 * PERSONAL TRIP ENGINE
 *
 * PERSONAL mode asks a much smaller question than the fleet does — one person,
 * one vehicle, one journey — but it answers it with exactly the same physics.
 * The energy curve, the well-to-wheel emission factors and the hourly grid
 * intensity used here are the ones the fleet optimiser uses, so "lowest
 * emissions" means the same thing in both halves of the product.
 *
 * What it does NOT do is invent choices. The road alternatives come from the
 * routing service; if there is genuinely only one sensible way to get there,
 * all four options point at that one road and say so. Presenting four
 * different-looking cards over identical geometry would be a lie told with
 * layout.
 */

import { APP, ENERGY, PERSONAL_VEHICLES, PERSONAL_OPTIONS } from '../config.js';
import { speedFactor } from './energy.js';
import { intensityAt } from './emissions.js';
import { clamp } from '../util/math.js';

/**
 * Cost and emissions for one candidate road route.
 *
 * @param {{id:string, km:number, minutes:number, points:object[], estimated:boolean}} alt
 * @param {{vehicleKey:string, departMinutes:number, consumption?:number}} opts
 */
export function evaluateTrip(alt, { vehicleKey = 'CAR', departMinutes = 9 * 60, consumption } = {}) {
  const type = PERSONAL_VEHICLES[vehicleKey] || PERSONAL_VEHICLES.CAR;
  // The public routing service models a car. A bicycle covers the same roads
  // far more slowly, and a motorcycle marginally faster in traffic, so the
  // duration is scaled rather than pretended to be measured.
  const minutes = alt.minutes / (type.avgSpeedFactor || 1);
  const km = alt.km;
  const speedKmh = minutes > 0 ? (km / (minutes / 60)) : 0;

  const rate = Number.isFinite(consumption) ? consumption : type.consumption;
  const sf = type.energyType === 'human' ? 1 : speedFactor(speedKmh);
  const units = (rate / 100) * km * sf;

  // A journey that crosses hours is charged at the grid intensity of its
  // midpoint, which matters for an electric car and for nothing else.
  const midMinutes = departMinutes + minutes / 2;
  const intensity = intensityAt(type.energyType, midMinutes);
  const co2 = units * intensity;

  const energyCost = units * (ENERGY.pricePerUnit[type.energyType] ?? 0);
  const runningCost = km * (type.costPerKm || 0);

  return {
    id: alt.id,
    points: alt.points,
    estimated: !!alt.estimated,
    via: !!alt.via,
    km,
    minutes,
    arriveMinutes: departMinutes + minutes,
    speedKmh,
    units,
    unitLabel: ENERGY.unitLabel[type.energyType] || '',
    intensity,
    co2,
    energyCost,
    runningCost,
    cost: energyCost + runningCost,
    vehicleKey: type.key,
    factors: { speed: sf },
  };
}

/**
 * Turn a set of road alternatives into the four labelled choices.
 *
 * Each option is the candidate that minimises its own weighted objective. Two
 * options frequently land on the same road — that is a real finding about the
 * journey, not a defect, and `shared` records it so the interface can say it
 * out loud.
 */
export function buildTripOptions(alternatives, opts = {}) {
  const trips = (alternatives || []).map((a) => evaluateTrip(a, opts));
  if (!trips.length) return { trips: [], options: [], best: null, estimated: false };

  const best = {
    minutes: Math.min(...trips.map((t) => t.minutes)),
    cost: Math.min(...trips.map((t) => t.cost)),
    co2: Math.min(...trips.map((t) => t.co2)),
    km: Math.min(...trips.map((t) => t.km)),
  };
  const worst = {
    minutes: Math.max(...trips.map((t) => t.minutes)),
    cost: Math.max(...trips.map((t) => t.cost)),
    co2: Math.max(...trips.map((t) => t.co2)),
    km: Math.max(...trips.map((t) => t.km)),
  };

  // Normalise each metric to 0 (best in this set) .. 1 (worst in this set), so
  // the weights compare like with like rather than minutes against rupees.
  const norm = (v, lo, hi) => (hi - lo < 1e-9 ? 0 : (v - lo) / (hi - lo));
  const score = (t, w) =>
    (w.time ?? 0) * norm(t.minutes, best.minutes, worst.minutes)
    + (w.cost ?? 0) * norm(t.cost, best.cost, worst.cost)
    + (w.emissions ?? 0) * norm(t.co2, best.co2, worst.co2)
    + (w.distance ?? 0) * norm(t.km, best.km, worst.km);

  const options = PERSONAL_OPTIONS.map((opt) => {
    // A single-metric option is decided by that metric alone. Blending in a
    // little of the others would let "Lowest emissions" return a road that is
    // not the lowest — which is precisely the kind of quiet dishonesty this
    // product is trying not to commit.
    if (opt.metric) {
      let pick = trips[0];
      for (const t of trips) if (t[opt.metric] < pick[opt.metric] - 1e-9) pick = t;
      return { ...opt, trip: pick, score: pick[opt.metric] };
    }
    let pick = trips[0];
    let pickScore = Infinity;
    for (const t of trips) {
      const sc = score(t, opt.weights);
      if (sc < pickScore - 1e-9) { pickScore = sc; pick = t; }
    }
    return { ...opt, trip: pick, score: pickScore };
  });

  // Which options resolved to the same road as an earlier one.
  const seen = new Map();
  for (const o of options) {
    if (seen.has(o.trip.id)) o.sharedWith = seen.get(o.trip.id);
    else seen.set(o.trip.id, o.key);
  }

  return {
    trips,
    options,
    best,
    worst,
    /**
     * Two different counts, and conflating them tells a lie.
     *
     * `roadsFound` is how many genuinely different roads exist between these
     * two places, as far as the routing service could be persuaded to reveal.
     * `chosenRoads` is how many of them the four objectives actually land on,
     * which is often one: when the quickest way is also the shortest, it wins
     * on time, cost and carbon at once. That is a fact about this journey, not
     * evidence that there was only ever one way to go.
     */
    roadsFound: trips.length,
    chosenRoads: seen.size,
    estimated: trips.some((t) => t.estimated),
  };
}

/**
 * Plain-English comparison of one option against another.
 *
 * Only differences that survived the calculation are described: the text is
 * generated from the numbers, never alongside them.
 */
export function compareTrips(a, b, { labelA = 'This route', labelB = 'the fastest route' } = {}) {
  if (!a || !b || a.id === b.id) return null;
  const rows = [
    { key: 'time', short: 'of travel time', delta: a.minutes - b.minutes, fmt: (v) => `${Math.abs(Math.round(v))} min` },
    { key: 'cost', short: 'in fuel and running cost', delta: a.cost - b.cost, fmt: (v) => `${APP.currency}${Math.abs(v).toFixed(0)}` },
    { key: 'co2', short: 'CO₂e', delta: a.co2 - b.co2, fmt: (v) => `${Math.abs(v).toFixed(2)} kg` },
    { key: 'km', short: 'of driving', delta: a.km - b.km, fmt: (v) => `${Math.abs(v).toFixed(1)} km` },
  ];
  const better = rows.filter((r) => r.delta < -0.01);
  const worse = rows.filter((r) => r.delta > 0.01);

  const list = (xs) => xs.map((r) => `${r.fmt(r.delta)} ${r.short}`).join(', ');
  if (better.length && worse.length) {
    return `${labelA} saves ${list(better)} against ${labelB}, and costs ${list(worse)} more.`;
  }
  if (better.length) return `${labelA} is better than ${labelB} on ${list(better)} and worse on nothing measured.`;
  if (worse.length) return `${labelA} costs ${list(worse)} more than ${labelB} and is better on nothing measured.`;
  return `${labelA} and ${labelB} are within a rounding error of each other on every measure.`;
}

/**
 * Why this route, in the terms the person actually chose.
 * Returns an array of short causal clauses, each traceable to a number above.
 */
export function explainTrip(option, set) {
  if (!option?.trip) return [];
  const t = option.trip;
  const type = PERSONAL_VEHICLES[t.vehicleKey] || PERSONAL_VEHICLES.CAR;
  const out = [];

  const found = set?.roadsFound ?? 0;
  const chosen = set?.chosenRoads ?? 0;

  if (found === 1) {
    out.push({
      sign: '=',
      label: 'There is one sensible road for this journey',
      detail: 'Alternatives were requested, and routes through via points either side of the '
        + 'direct line were tried as well. They all came back on this same road, so every option '
        + 'below is that road.',
    });
  } else if (found > 1 && chosen === 1) {
    // The interesting case, and the one an honest tool must not hide behind
    // four identical-looking cards.
    out.push({
      sign: '=',
      label: `${found} different roads compared — one wins on every measure`,
      detail: 'On this journey the quickest road is also the cheapest and the cleanest, so all '
        + 'four objectives pick it. The others are drawn on the map in teal if you want to see '
        + 'what you are giving up.',
    });
  } else if (found > 1) {
    out.push({
      sign: '=',
      label: `${found} different roads compared, ${chosen} worth choosing between`,
      detail: 'Roads overlapping for most of their length are counted once, so these are real '
        + 'alternatives rather than the same route drawn twice.',
    });
  }

  out.push({
    sign: '+',
    label: `${Math.round(t.minutes)} min over ${t.km.toFixed(1)} km`,
    detail: `Averaging ${Math.round(t.speedKmh)} km/h on real road geometry.`,
  });

  if (type.energyType === 'human') {
    out.push({ sign: '+', label: 'No fuel, no tailpipe', detail: 'A bicycle emits nothing and costs nothing to run.' });
  } else {
    out.push({
      sign: t.factors.speed > 1.25 ? '-' : '+',
      label: `${t.units.toFixed(2)} ${t.unitLabel} consumed`,
      detail: t.factors.speed > 1.25
        ? `Traffic speeds push consumption ${Math.round((t.factors.speed - 1) * 100)}% above this vehicle's best-case rate.`
        : `Close to this vehicle's efficient speed band, within ${Math.round(Math.abs(t.factors.speed - 1) * 100)}% of its best rate.`,
    });
  }

  if (type.energyType === 'bev') {
    const cleanest = cleanestNearby(t.arriveMinutes);
    out.push({
      sign: t.intensity <= cleanest.intensity * 1.08 ? '+' : '-',
      label: `Grid at ${t.intensity.toFixed(2)} kg CO₂e/kWh`,
      detail: t.intensity <= cleanest.intensity * 1.08
        ? 'You are charging into a relatively clean part of the day.'
        : `Charging around ${String(cleanest.hour).padStart(2, '0')}:00 would be roughly ${Math.round((1 - cleanest.intensity / t.intensity) * 100)}% cleaner for the same distance.`,
    });
  }

  if (t.estimated) {
    out.push({
      sign: '-',
      label: 'Straight-line estimate',
      detail: 'The routing service was unreachable, so this is a distance estimate, not a road route.',
    });
  }
  return out;
}

function cleanestNearby(minutes) {
  const from = Math.max(0, Math.floor(minutes / 60) - 6);
  let hour = from, intensity = Infinity;
  for (let h = from; h <= from + 12; h++) {
    const v = ENERGY.gridIntensity[((h % 24) + 24) % 24];
    if (v < intensity) { intensity = v; hour = ((h % 24) + 24) % 24; }
  }
  return { hour, intensity };
}

export const personalVehicle = (key) => PERSONAL_VEHICLES[key] || PERSONAL_VEHICLES.CAR;
export { clamp };
