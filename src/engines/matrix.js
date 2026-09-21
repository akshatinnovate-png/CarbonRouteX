/**
 * NETWORK MATRIX
 *
 * The bridge between the real routing service and the optimiser.
 *
 * The optimiser needs to evaluate a route thousands of times per second; it
 * cannot make a network call per leg. So the whole problem's travel times and
 * distances are fetched ONCE, as a single OSRM `/table` request covering every
 * depot and every stop, and every subsequent evaluation is an array lookup.
 *
 * On top of that fixed road geometry sits a traffic model. OSRM's public
 * service returns free-flow durations, so congestion is applied here as a
 * transparent, deterministic multiplier derived from time of day plus any
 * scenario overrides. That multiplier is clearly a MODEL, not an observation,
 * and the UI says so — but it is the same model on both sides of every
 * comparison, which is what makes before/after honest.
 */

import { TRAFFIC, VEHICLE_TYPES } from '../config.js';
import { clamp } from '../util/math.js';
import { edgeEnergy } from './energy.js';
import { intensityAt } from './emissions.js';
import { ENERGY } from '../config.js';

export class NetworkMatrix {
  constructor() {
    this.points = [];          // [{ id, kind, lon, lat }]
    this.indexById = new Map();
    this.durations = null;     // seconds, free flow
    this.distances = null;     // metres
    this.estimated = true;
    this.note = null;
    this.builtAt = null;
    this.revision = 0;

    // Traffic model state.
    this.trafficMultiplier = 1;
    this.incidents = [];       // { lon, lat, radiusKm, severity, id, label }
    this.closedPairs = new Set(); // "i>j" pairs made impassable by a closure
  }

  get size() { return this.points.length; }
  get ready() { return !!this.durations; }

  /**
   * Fetch (or re-fetch) the matrix for the current depots and orders.
   * @param {OsrmService} osrm
   */
  async build(points, osrm) {
    this.points = points;
    this.indexById = new Map(points.map((p, i) => [p.id, i]));
    if (points.length < 2) {
      this.durations = [[0]];
      this.distances = [[0]];
      this.estimated = false;
      this.note = null;
      this.revision++;
      return this;
    }
    const result = await osrm.matrix(points);
    this.durations = result.durations;
    this.distances = result.distances;
    this.estimated = result.estimated;
    this.note = result.note || null;
    this.builtAt = Date.now();
    this.revision++;
    return this;
  }

  idx(id) {
    const i = this.indexById.get(id);
    return i === undefined ? -1 : i;
  }

  /* ---------------------------------------------------------------- */
  /* Traffic                                                           */
  /* ---------------------------------------------------------------- */

  /** Smoothly-interpolated diurnal demand, 0..1. */
  demandAt(minutes) {
    const h = ((minutes / 60) % 24 + 24) % 24;
    const i = Math.floor(h), f = h - i;
    const a = TRAFFIC.diurnal[i % 24], b = TRAFFIC.diurnal[(i + 1) % 24];
    return a + (b - a) * f;
  }

  /**
   * Travel-time multiplier for a leg at a given clock time.
   * Superlinear in demand, the way real volume/delay curves behave.
   */
  congestionFactor(i, j, clockMinutes) {
    const demand = this.demandAt(clockMinutes) * this.trafficMultiplier;
    let c = clamp(demand, 0, 2.6);
    // Incidents affect legs whose endpoints fall inside the zone.
    for (const inc of this.incidents) {
      const near = this._nearIncident(i, inc) || this._nearIncident(j, inc);
      if (near > 0) c = clamp(c + inc.severity * near, 0, 3.2);
    }
    return 1 + 0.62 * Math.pow(c, 1.9);
  }

  _nearIncident(index, inc) {
    const p = this.points[index];
    if (!p) return 0;
    const dLat = (p.lat - inc.lat) * 111.32;
    const dLon = (p.lon - inc.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const d = Math.hypot(dLat, dLon);
    return d >= inc.radiusKm ? 0 : (1 - d / inc.radiusKm) ** 1.5;
  }

  /** Network-wide congestion index, 0..1, for the HUD. */
  networkIndex(clockMinutes) {
    const base = clamp(this.demandAt(clockMinutes) * this.trafficMultiplier, 0, 2.6);
    const incidentLoad = this.incidents.reduce((a, i) => a + i.severity * 0.12, 0);
    return clamp((base + incidentLoad) / 1.9, 0, 1);
  }

  setTrafficMultiplier(m) { this.trafficMultiplier = m; }
  addIncident(inc) { this.incidents.push(inc); }
  clearIncidents() { this.incidents = []; }

  /** Mark a directed pair impassable — the matrix equivalent of a road closure. */
  closeLink(fromId, toId) {
    const i = this.idx(fromId), j = this.idx(toId);
    if (i >= 0 && j >= 0) { this.closedPairs.add(`${i}>${j}`); this.closedPairs.add(`${j}>${i}`); }
  }
  clearClosures() { this.closedPairs.clear(); }
  isClosed(i, j) { return this.closedPairs.has(`${i}>${j}`); }

  /* ---------------------------------------------------------------- */
  /* Leg costing                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Full metric bundle for travelling between two stops.
   *
   * @param profile { type, payload, price, intensity, clockMinutes }
   * @returns {null | { km, minutes, units, co2, cost, risk, speed, factors }}
   */
  leg(i, j, profile) {
    if (!this.durations || i < 0 || j < 0) return null;
    if (i === j) {
      return { km: 0, minutes: 0, units: 0, co2: 0, cost: 0, risk: 0, speed: 0, factors: null, congestion: 1 };
    }
    if (this.isClosed(i, j)) return null;

    const km = (this.distances?.[i]?.[j] ?? 0) / 1000;
    const freeFlowMin = (this.durations[i][j] ?? 0) / 60;
    if (!Number.isFinite(km) || !Number.isFinite(freeFlowMin)) return null;

    const congestion = this.congestionFactor(i, j, profile.clockMinutes);
    const minutes = freeFlowMin * congestion;
    const type = profile.type;
    // Average speed over the leg drives the consumption curve, so congestion
    // costs energy as well as time — which is the whole point.
    const speed = minutes > 0 ? clamp((km / (minutes / 60)), 3, type.maxSpeed) : type.maxSpeed;

    // Gradient is unknown without an elevation service, so it is left neutral
    // rather than invented. See README "Limitations".
    const { units, factors } = edgeEnergy(type, { lengthKm: km, grade: 0 }, speed, profile.payload);
    const co2 = units * profile.intensity;
    const cost = units * profile.price
      + km * type.costPerKm
      + (minutes / 60) * type.driverCostPerHr;
    // Congested links are not just slower, they are less predictable.
    const risk = minutes * clamp(congestion - 1, 0, 2) * 0.55;

    return { km, minutes, units, co2, cost, risk, speed, factors, congestion, freeFlowMin };
  }

  /** Resolve a routing profile once per evaluation batch. */
  profile({ vehicleType, payload = 0.5, clockMinutes = 9 * 60 }) {
    const type = VEHICLE_TYPES[vehicleType] || Object.values(VEHICLE_TYPES)[0];
    return {
      type,
      payload,
      clockMinutes,
      intensity: intensityAt(type.energyType, clockMinutes),
      price: ENERGY.pricePerUnit[type.energyType],
    };
  }
}
