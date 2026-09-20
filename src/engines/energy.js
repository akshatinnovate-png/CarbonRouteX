/**
 * ENERGY ENGINE
 *
 * Converts (vehicle, edge, speed, payload) into energy consumed in the
 * vehicle's own carrier units — litres of diesel, kg of CNG, or kWh.
 *
 * The model is intentionally simple but physically motivated:
 *
 *   units = base(length) x loadFactor x speedFactor x gradeFactor
 *
 *   loadFactor  — payload raises rolling resistance and inertia.
 *   speedFactor — a U-curve: stop-and-go wastes energy, so does high-speed drag.
 *   gradeFactor — climbing costs; descending recovers (fully for BEV regen,
 *                 only as coasting for combustion).
 *
 * Every factor is exposed so the explanation layer can attribute consumption
 * back to a cause instead of asserting one.
 */

import { ENERGY, VEHICLE_TYPES } from '../config.js';
import { clamp } from '../util/math.js';

/** U-shaped specific-consumption curve, normalised to 1.0 at the optimum. */
export function speedFactor(speedKmh) {
  const v = clamp(speedKmh, 4, 130);
  const opt = ENERGY.optimalSpeed;
  if (v >= opt) {
    // Aerodynamic drag dominates: grows with the square of the overspeed.
    const over = (v - opt) / opt;
    return 1 + 0.58 * over * over;
  }
  // Below the optimum, idling and transient losses dominate and grow sharply.
  const under = (opt - v) / opt;
  return 1 + 1.35 * under * under + 0.45 * under;
}

/** Grade factor. `regen` is the fraction of downhill energy recovered. */
export function gradeFactor(grade, regen) {
  if (grade >= 0) return 1 + grade * 11.5;
  return clamp(1 + grade * 11.5 * regen, 0.32, 1);
}

export function loadFactor(type, payloadFraction) {
  return 1 + type.loadSensitivity * clamp(payloadFraction, 0, 1.2);
}

/**
 * Energy for one edge traversal, in the vehicle's carrier units.
 * @returns {{ units:number, factors:{load:number,speed:number,grade:number} }}
 */
export function edgeEnergy(vehicleType, edge, speedKmh, payloadFraction) {
  const type = typeof vehicleType === 'string' ? VEHICLE_TYPES[vehicleType] : vehicleType;
  const regen = type.energyType === 'bev' ? 0.62 : 0.18;
  const f = {
    load: loadFactor(type, payloadFraction),
    speed: speedFactor(speedKmh),
    grade: gradeFactor(edge.grade, regen),
  };
  const base = (type.consumption / 100) * edge.lengthKm;
  return { units: base * f.load * f.speed * f.grade, factors: f };
}

/** Energy burnt while stationary at a stop (engine idling / HVAC / liftgate). */
export function stopEnergy(vehicleType, minutes) {
  const type = typeof vehicleType === 'string' ? VEHICLE_TYPES[vehicleType] : vehicleType;
  // BEVs have essentially no idle burn; combustion vehicles do.
  const idleRate = type.energyType === 'bev' ? 0.9 : 2.4; // units per hour
  return (minutes / 60) * idleRate * ENERGY.idlePenaltyPerStop * 60;
}

/** Cost of the energy itself. */
export function energyCost(vehicleType, units) {
  const type = typeof vehicleType === 'string' ? VEHICLE_TYPES[vehicleType] : vehicleType;
  return units * ENERGY.pricePerUnit[type.energyType];
}

/** Remaining range in km at the current state of charge/fuel, empty-ish load. */
export function remainingRange(vehicle) {
  const type = VEHICLE_TYPES[vehicle.type];
  return type.rangeKm * clamp(vehicle.energyLevel, 0, 1);
}

/** Fraction of a full tank/charge that `units` represents. */
export function unitsToFraction(vehicleType, units) {
  const type = typeof vehicleType === 'string' ? VEHICLE_TYPES[vehicleType] : vehicleType;
  const fullUnits = (type.consumption / 100) * type.rangeKm;
  return fullUnits > 0 ? units / fullUnits : 0;
}

export const energyUnitLabel = (typeKey) => ENERGY.unitLabel[VEHICLE_TYPES[typeKey].energyType];
