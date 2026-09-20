/**
 * EMISSIONS ENGINE
 *
 * Converts energy (in carrier units) into estimated CO2e, well-to-wheel.
 *
 * For combustion carriers the intensity is a constant. For battery-electric
 * vehicles it is the *grid* intensity at the hour of travel, which is the
 * interesting case: the same e-Truck driving the same route at 11:00 and at
 * 19:00 emits very differently, so time-shifting becomes a real lever the
 * optimiser can pull.
 *
 * All values are estimates from published factors applied to simulated
 * telemetry. They are never presented as measurements.
 */

import { ENERGY, VEHICLE_TYPES } from '../config.js';

/** kg CO2e per carrier unit at a given clock time (minutes since midnight). */
export function intensityAt(energyType, minutes) {
  if (energyType !== 'bev') return ENERGY.co2ePerUnit[energyType];
  const h = ((minutes / 60) % 24 + 24) % 24;
  const i = Math.floor(h), f = h - i;
  const a = ENERGY.gridIntensity[i % 24];
  const b = ENERGY.gridIntensity[(i + 1) % 24];
  return a + (b - a) * f;
}

/** kg CO2e for `units` of carrier consumed at `minutes`. */
export function co2e(vehicleTypeKey, units, minutes) {
  const type = typeof vehicleTypeKey === 'string' ? VEHICLE_TYPES[vehicleTypeKey] : vehicleTypeKey;
  return units * intensityAt(type.energyType, minutes);
}

/** The cleanest hour in the operating window — used by the explanation layer. */
export function cleanestHour(fromHour = 8, toHour = 20) {
  let best = fromHour, bestV = Infinity;
  for (let h = fromHour; h <= toHour; h++) {
    const v = ENERGY.gridIntensity[h % 24];
    if (v < bestV) { bestV = v; best = h; }
  }
  return { hour: best, intensity: bestV };
}

/**
 * Attribute a route's emissions across causal buckets so the carbon panel can
 * say *why* a number is what it is rather than only what it is.
 */
export function attributeEmissions(legs) {
  const buckets = { baseline: 0, payload: 0, congestion: 0, terrain: 0 };
  for (const leg of legs) {
    const { factors, emissions } = leg;
    if (!factors) { buckets.baseline += emissions; continue; }
    const total = factors.load * factors.speed * factors.grade;
    if (total <= 0) { buckets.baseline += emissions; continue; }
    const base = emissions / total;
    buckets.baseline += base;
    buckets.payload += base * (factors.load - 1);
    buckets.congestion += base * factors.load * (factors.speed - 1);
    buckets.terrain += base * factors.load * factors.speed * (factors.grade - 1);
  }
  return buckets;
}

export const CARRIER_LABEL = {
  diesel: 'Diesel', cng: 'CNG', bev: 'Grid electricity',
};
