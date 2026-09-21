/**
 * PLAN / CONSTRAINT ENGINE
 *
 * Turns an assignment (which vehicle visits which orders, in what sequence)
 * into a fully costed, constraint-checked fleet plan, using real road distances
 * and durations from the network matrix.
 *
 * This is the only place that knows how a route is actually *executed*:
 *
 *   depot -> load -> leg -> service -> leg -> ... -> return to depot
 *
 * Payload decreases as the vehicle delivers, and the energy engine sees that
 * declining payload leg by leg. That single detail is what makes visit order
 * matter for emissions and not just for time — drop the heavy freight early and
 * the rest of the route is cheaper to move.
 *
 * Constraints checked:
 *   - payload vs. vehicle capacity          (hard)
 *   - energy required vs. usable range      (hard, with a reserve)
 *   - delivery deadline                     (soft, penalised per minute late)
 *   - depot operating window                (soft)
 *   - vehicle availability                  (hard)
 */

import { OPTIMIZER, SIM, VEHICLE_TYPES } from '../config.js';
import { clamp } from '../util/math.js';
import { unitsToFraction, stopEnergy } from './energy.js';

const ENERGY_RESERVE = 0.10; // never plan to arrive below 10% charge/fuel

export class PlanEngine {
  /**
   * @param matrix NetworkMatrix
   * @param ctx    { depotsById, ordersById, vehiclesById, depots }
   */
  constructor(matrix, ctx) {
    this.matrix = matrix;
    this.ctx = ctx;
    this.routeCache = new Map();
    this.cacheCap = 12000;
    this.evaluations = 0;
  }

  invalidate() { this.routeCache.clear(); }

  depotFor(vehicle) { return this.ctx.depotsById.get(vehicle.depotId); }

  /**
   * Evaluate one vehicle serving an ordered list of orders.
   * Always returns a route object — an infeasible one carries `feasible:false`
   * and a populated `violations` array, because the optimiser needs to be able
   * to *score* infeasibility rather than have it thrown at it.
   */
  evaluateRoute(vehicle, orderIds, weights, startMinutes = SIM.dayStartMinutes) {
    const key = `${vehicle.id}|${orderIds.join(',')}|${this.matrix.revision}|`
      + `${this.matrix.trafficMultiplier}|${this.matrix.incidents.length}|${Math.round(startMinutes / 15)}`;
    const cached = this.routeCache.get(key);
    if (cached) return cached;
    const route = this._evaluate(vehicle, orderIds, startMinutes);
    if (this.routeCache.size >= this.cacheCap) {
      let drop = Math.floor(this.cacheCap / 4);
      for (const k of this.routeCache.keys()) { this.routeCache.delete(k); if (--drop <= 0) break; }
    }
    this.routeCache.set(key, route);
    return route;
  }

  _evaluate(vehicle, orderIds, startMinutes) {
    this.evaluations++;
    const type = VEHICLE_TYPES[vehicle.type];
    const depot = this.depotFor(vehicle);
    const orders = orderIds.map((id) => this.ctx.ordersById.get(id)).filter(Boolean);

    const route = {
      id: `R-${vehicle.id}`,
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      depotId: depot?.id ?? null,
      orderIds: orders.map((o) => o.id),
      stops: [],
      legs: [],
      path: null,              // real road geometry, attached later by the store
      geometryEstimated: true,
      km: 0, minutes: 0, drivingMinutes: 0, serviceMinutes: 0,
      units: 0, co2: 0, cost: 0, risk: 0,
      startMinutes, endMinutes: startMinutes,
      capacityUsedKg: 0, capacityPct: 0,
      energyFraction: 0, reliability: 1,
      lateMinutes: 0, lateOrders: 0,
      feasible: true, violations: [],
      worstCongestion: 1,
    };

    if (!depot) {
      route.feasible = false;
      route.violations.push({ code: 'no_depot', severity: 'hard', label: `${vehicle.callsign} has no depot assigned` });
      return route;
    }
    if (!vehicle.available) {
      route.feasible = false;
      route.violations.push({ code: 'vehicle_unavailable', severity: 'hard', label: `${vehicle.callsign} is not available` });
    }
    if (!orders.length) { route.empty = true; return route; }

    const totalWeight = orders.reduce((a, o) => a + o.weightKg, 0);
    route.capacityUsedKg = totalWeight;
    route.capacityPct = totalWeight / type.capacityKg;
    if (totalWeight > type.capacityKg) {
      route.feasible = false;
      route.violations.push({
        code: 'capacity', severity: 'hard',
        label: `Payload ${Math.round(totalWeight)} kg exceeds ${type.capacityKg} kg capacity`,
      });
    }

    const depotIdx = this.matrix.idx(depot.id);
    if (depotIdx < 0) {
      route.feasible = false;
      route.violations.push({ code: 'not_in_matrix', severity: 'hard', label: 'Depot is missing from the routing matrix' });
      return route;
    }

    let clock = startMinutes + OPTIMIZER.depotLoadMinutes + totalWeight * OPTIMIZER.serviceMinutesPerKg;
    let remainingKg = totalWeight;
    let fromIdx = depotIdx;

    const sequence = [...orders.map((o) => ({ kind: 'order', order: o })), { kind: 'depot' }];
    for (const step of sequence) {
      const payload = clamp(remainingKg / type.capacityKg, 0, 1.2);
      const profile = this.matrix.profile({ vehicleType: vehicle.type, payload, clockMinutes: clock });
      const toIdx = step.kind === 'order' ? this.matrix.idx(step.order.id) : depotIdx;
      const leg = toIdx < 0 ? null : this.matrix.leg(fromIdx, toIdx, profile);
      if (!leg) {
        route.feasible = false;
        route.violations.push({
          code: 'unreachable', severity: 'hard',
          label: step.kind === 'order'
            ? `No open road to ${step.order.id} (${step.order.short || step.order.label || ''})`.trim()
            : 'No open road back to the depot',
        });
        break;
      }
      route.legs.push({ ...leg, fromIdx, toIdx, orderId: step.kind === 'order' ? step.order.id : null });
      route.km += leg.km;
      route.drivingMinutes += leg.minutes;
      route.units += leg.units;
      route.co2 += leg.co2;
      route.cost += leg.cost;
      route.risk += leg.risk;
      route.worstCongestion = Math.max(route.worstCongestion, leg.congestion);
      clock += leg.minutes;
      fromIdx = toIdx;

      if (step.kind === 'order') {
        const o = step.order;
        const arrival = clock;
        // Arriving before the window opens means waiting, not an early delivery.
        const waited = Math.max(0, (o.windowOpen ?? 0) - arrival);
        const serviceStart = arrival + waited;
        const service = OPTIMIZER.serviceMinutesPerStop + (o.serviceMinutes || 0);
        const departure = serviceStart + service;
        const late = Math.max(0, serviceStart - o.deadline);
        const idleUnits = stopEnergy(type, service + waited);
        route.units += idleUnits;
        route.co2 += idleUnits * profile.intensity;
        route.cost += idleUnits * profile.price;
        route.serviceMinutes += service + waited;
        if (late > 0) { route.lateMinutes += late; route.lateOrders++; }
        route.stops.push({
          orderId: o.id, consignee: o.consignee, address: o.short || o.label,
          lon: o.lon, lat: o.lat,
          arrival, waited, serviceStart, departure, late,
          deadline: o.deadline, windowOpen: o.windowOpen,
          loadBeforeKg: remainingKg, weightKg: o.weightKg, priority: o.priority,
          legKm: leg.km, legMinutes: leg.minutes, legCo2: leg.co2,
        });
        remainingKg -= o.weightKg;
        clock = departure;
      }
    }

    route.endMinutes = clock;
    route.minutes = route.endMinutes - route.startMinutes;
    route.energyFraction = unitsToFraction(type, route.units);

    const usable = Math.max(0, vehicle.energyLevel - ENERGY_RESERVE);
    if (route.energyFraction > usable) {
      route.feasible = false;
      route.violations.push({
        code: 'range', severity: 'hard',
        label: `Needs ${Math.round(route.energyFraction * 100)}% of range; ${Math.round(usable * 100)}% usable remains`,
      });
    } else if (route.energyFraction > usable * 0.86) {
      route.violations.push({
        code: 'range_margin', severity: 'soft',
        label: `Thin energy margin — arrives near ${Math.round((vehicle.energyLevel - route.energyFraction) * 100)}%`,
      });
    }

    if (route.lateOrders > 0) {
      route.violations.push({
        code: 'deadline', severity: 'soft',
        label: `${route.lateOrders} stop${route.lateOrders > 1 ? 's' : ''} past deadline (${Math.round(route.lateMinutes)} min total)`,
      });
    }
    if (depot.closeMinutes != null && route.endMinutes > depot.closeMinutes) {
      route.violations.push({ code: 'depot_close', severity: 'soft', label: 'Returns after depot closing time' });
    }

    route.reliability = clamp(1 - route.risk / Math.max(route.drivingMinutes, 1) / 1.1, 0, 1);
    route.onTime = route.stops.length ? (route.stops.length - route.lateOrders) / route.stops.length : 1;
    return route;
  }

  /** @param assignment Map<vehicleId, orderId[]> */
  buildPlan(assignment, weights, meta = {}) {
    const routes = [];
    const served = new Set();
    for (const [vehicleId, orderIds] of assignment) {
      const vehicle = this.ctx.vehiclesById.get(vehicleId);
      if (!vehicle) continue;
      routes.push(this.evaluateRoute(vehicle, orderIds, weights, meta.startMinutes ?? SIM.dayStartMinutes));
      for (const id of orderIds) served.add(id);
    }
    const unserved = [];
    for (const o of this.ctx.ordersById.values()) {
      if (o.status === 'delivered' || o.status === 'cancelled') continue;
      if (!served.has(o.id)) unserved.push(o.id);
    }
    return finalisePlan(routes, unserved, weights, this.ctx, meta);
  }
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export function finalisePlan(routes, unserved, weights, ctx, meta = {}) {
  const active = routes.filter((r) => r.orderIds.length > 0);
  const m = {
    km: 0, minutes: 0, drivingMinutes: 0, co2: 0, cost: 0, units: 0,
    stops: 0, lateMinutes: 0, lateOrders: 0,
    vehiclesUsed: active.length,
    vehiclesAvailable: routes.length,
    unserved: unserved.length,
    capacityKg: 0, payloadKg: 0,
    hardViolations: 0, softViolations: 0,
  };
  let reliabilitySum = 0;
  for (const r of routes) {
    m.km += r.km; m.minutes += r.minutes; m.drivingMinutes += r.drivingMinutes;
    m.co2 += r.co2; m.cost += r.cost; m.units += r.units;
    m.stops += r.stops.length;
    m.lateMinutes += r.lateMinutes; m.lateOrders += r.lateOrders;
    m.payloadKg += r.capacityUsedKg;
    m.capacityKg += VEHICLE_TYPES[r.vehicleType]?.capacityKg ?? 0;
    for (const v of r.violations) {
      if (v.severity === 'hard') m.hardViolations++; else m.softViolations++;
    }
    if (r.orderIds.length) reliabilitySum += r.reliability;
  }
  m.utilization = m.capacityKg > 0 ? m.payloadKg / m.capacityKg : 0;
  m.fleetUtilization = m.vehiclesAvailable ? m.vehiclesUsed / m.vehiclesAvailable : 0;
  m.reliability = active.length ? reliabilitySum / active.length : 1;
  m.onTimeRate = m.stops ? (m.stops - m.lateOrders) / m.stops : 1;
  m.co2PerStop = m.stops ? m.co2 / m.stops : 0;
  m.co2PerKm = m.km ? m.co2 / m.km : 0;
  m.costPerStop = m.stops ? m.cost / m.stops : 0;
  m.avgStopsPerRoute = active.length ? m.stops / active.length : 0;
  m.endMinutes = routes.reduce((a, r) => Math.max(a, r.endMinutes), SIM.dayStartMinutes);
  m.feasible = m.hardViolations === 0 && m.unserved === 0;

  return {
    id: meta.id || `PLAN-${Date.now().toString(36).toUpperCase()}`,
    label: meta.label || 'Fleet plan',
    createdAt: Date.now(),
    weights: { ...weights },
    routes,
    unserved,
    metrics: m,
    meta,
  };
}

/* ------------------------------------------------------------------ */
/* Objective function                                                  */
/* ------------------------------------------------------------------ */

export function referenceFrom(plan) {
  const m = plan.metrics;
  return {
    minutes: Math.max(m.minutes, 1),
    km: Math.max(m.km, 1),
    co2: Math.max(m.co2, 0.01),
    cost: Math.max(m.cost, 1),
  };
}

/**
 * THE OBJECTIVE FUNCTION. Lower is better; 1.0 means "as good as the baseline".
 * Every term is reported back in `terms` so the explanation layer can attribute
 * a decision to a term rather than invent one.
 */
export function scorePlan(plan, weights, ref) {
  const m = plan.metrics;
  const terms = {
    time: weights.time * (m.minutes / ref.minutes),
    cost: weights.cost * (m.cost / ref.cost),
    emissions: weights.emissions * (m.co2 / ref.co2),
    distance: weights.distance * (m.km / ref.km),
    reliability: weights.reliability * (1 - m.reliability * m.onTimeRate),
  };
  const penalties = {
    lateness: (m.lateMinutes / ref.minutes) * OPTIMIZER.lateMinutePenalty,
    unserved: (m.unserved * OPTIMIZER.unservedPenalty) / ref.minutes,
    infeasible: m.hardViolations * 2.5,
  };
  const base = terms.time + terms.cost + terms.emissions + terms.distance + terms.reliability;
  const penalty = penalties.lateness + penalties.unserved + penalties.infeasible;
  return { score: base + penalty, terms, penalties, base, penalty };
}

export function violatesHard(route) {
  return route.violations.some((v) => v.severity === 'hard');
}

/** Normalise a weight vector to sum 1, falling back to balanced if degenerate. */
export function normaliseWeights(weights) {
  const keys = ['time', 'cost', 'emissions', 'distance', 'reliability'];
  const raw = {};
  let total = 0;
  for (const k of keys) {
    const v = Math.max(0, Number(weights?.[k] ?? 0));
    raw[k] = v; total += v;
  }
  if (total < 1e-6) return { time: 0.2, cost: 0.2, emissions: 0.2, distance: 0.2, reliability: 0.2 };
  for (const k of keys) raw[k] /= total;
  return raw;
}
