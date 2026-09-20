/**
 * ROUTE ENGINE
 *
 * Weighted A* over the road graph, where the edge cost is a *generalised
 * minute*: a scalarisation of time, distance, money, CO2e and risk using the
 * weights coming straight out of the optimisation panel.
 *
 *   gen(e) = w_time  * minutes
 *          + w_dist  * (km * 60 / REF_SPEED)
 *          + w_cost  * (rupees / COST_PER_MIN)
 *          + w_co2   * (kgCO2e / CO2_PER_MIN)
 *          + w_rel   * riskMinutes
 *
 * Because every term is converted into the same unit, the weights are directly
 * comparable and the search stays a single-objective shortest path — which is
 * what makes it fast enough to run thousands of times inside the VRP loop.
 *
 * The heuristic is a strict lower bound (best-case generalised cost per km on
 * the fastest, flattest, emptiest road), so A* remains admissible and the paths
 * it returns are genuinely optimal for the given weights.
 */

import { VEHICLE_TYPES } from '../config.js';
import { clamp, dist } from '../util/math.js';
import { edgeEnergy } from './energy.js';
import { intensityAt } from './emissions.js';

const REF_SPEED = 45;      // km/h — converts distance into minute-equivalents
const COST_PER_MIN = 6.0;  // rupees a minute of fleet time is worth
const CO2_PER_MIN = 0.02;  // kg CO2e a minute is worth, at the reference blend

/* ------------------------------------------------------------------ */
/* Binary heap keyed by f-score                                        */
/* ------------------------------------------------------------------ */

class MinHeap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  clear() { this.ids.length = 0; this.keys.length = 0; }
  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [ids[p], ids[i]] = [ids[i], ids[p]];
      [keys[p], keys[i]] = [keys[i], keys[p]];
      i = p;
    }
  }
  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop(), lastKey = keys.pop();
    if (ids.length) {
      ids[0] = lastId; keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < keys.length && keys[l] < keys[s]) s = l;
        if (r < keys.length && keys[r] < keys[s]) s = r;
        if (s === i) break;
        [ids[s], ids[i]] = [ids[i], ids[s]];
        [keys[s], keys[i]] = [keys[i], keys[s]];
        i = s;
      }
    }
    return top;
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class RouteEngine {
  constructor(world, traffic) {
    this.world = world;
    this.traffic = traffic;
    const n = world.nodes.length;
    // Reusable scratch buffers — allocating these per query would dominate the
    // VRP inner loop, which calls path() tens of thousands of times.
    this.gScore = new Float64Array(n);
    this.fMark = new Int32Array(n);      // search generation stamp
    this.cameFromNode = new Int32Array(n);
    this.cameFromEdge = new Int32Array(n);
    // Int32, not Uint8: these hold the search *generation* counter, and a
    // wrapping 8-bit stamp would make searches 256 apart alias each other and
    // silently return "no path" for perfectly reachable pairs.
    this.closed = new Int32Array(n);
    this.generation = 0;
    this.heap = new MinHeap();
    this.cache = new Map();
    this.cacheCap = 24000;
    this.stats = { queries: 0, hits: 0, expansions: 0 };
    this.penalties = null; // optional Float32Array for alternative generation
  }

  invalidate() { this.cache.clear(); }

  /* --- cost model ------------------------------------------------- */

  /**
   * Full metric bundle for traversing one edge under a profile.
   * Kept allocation-light: returns a plain object reused only by callers that
   * need the breakdown (route materialisation), while the search itself uses
   * `edgeGen` below which returns a single number.
   */
  edgeMetrics(edgeId, profile) {
    const e = this.world.edges[edgeId];
    const sf = this.traffic.speedFactor[edgeId];
    if (e.closed || sf <= 0.001) return null;
    const type = profile.type;
    const speed = Math.min(e.baseSpeed * sf, type.maxSpeed);
    const minutes = (e.lengthKm / speed) * 60;
    const { units, factors } = edgeEnergy(type, e, speed, profile.payload);
    const co2 = units * profile.intensity;
    const cost = units * profile.price
      + e.lengthKm * type.costPerKm
      + e.lengthKm * e.tollPerKm
      + (minutes / 60) * type.driverCostPerHr;
    // Risk = expected variance of the travel time. Congested links are not just
    // slower, they are less predictable, and reliability weighting targets that.
    const risk = minutes * clamp(this.traffic.congestion[edgeId], 0, 2.6) * 0.42;
    return { edgeId, minutes, km: e.lengthKm, units, co2, cost, risk, speed, factors, toll: e.lengthKm * e.tollPerKm };
  }

  edgeGen(edgeId, profile) {
    const e = this.world.edges[edgeId];
    const sf = this.traffic.speedFactor[edgeId];
    if (e.closed || sf <= 0.001) return Infinity;
    const type = profile.type;
    const speed = Math.min(e.baseSpeed * sf, type.maxSpeed);
    const minutes = (e.lengthKm / speed) * 60;
    const { units } = edgeEnergy(type, e, speed, profile.payload);
    const co2 = units * profile.intensity;
    const cost = units * profile.price
      + e.lengthKm * (type.costPerKm + e.tollPerKm)
      + (minutes / 60) * type.driverCostPerHr;
    const risk = minutes * clamp(this.traffic.congestion[edgeId], 0, 2.6) * 0.42;
    const w = profile.w;
    let gen = w.time * minutes
      + w.distance * (e.lengthKm * 60 / REF_SPEED)
      + w.cost * (cost / COST_PER_MIN)
      + w.emissions * (co2 / CO2_PER_MIN)
      + w.reliability * risk;
    if (this.penalties) gen *= this.penalties[edgeId];
    return gen;
  }

  /**
   * Build a resolved profile once per query batch. Resolving the vehicle type,
   * energy price and grid intensity up front keeps the inner loop branch-free.
   */
  profile({ vehicleType, payload = 0.5, weights, clockMinutes = 9 * 60 }) {
    const type = VEHICLE_TYPES[vehicleType] || VEHICLE_TYPES.diesel_van;
    const w = normaliseWeights(weights);
    const intensity = intensityAt(type.energyType, clockMinutes);
    const price = ({ diesel: 94.5, cng: 78.0, bev: 9.8 })[type.energyType];
    const p = { type, payload, w, intensity, price, clockMinutes };
    p.key = `${type.key}|${Math.round(payload * 4)}|${Math.round(clockMinutes / 30)}|`
      + `${w.time.toFixed(2)},${w.cost.toFixed(2)},${w.emissions.toFixed(2)},${w.distance.toFixed(2)},${w.reliability.toFixed(2)}`;
    p.minGenPerKm = this._minGenPerKm(p);
    return p;
  }

  /** Strict lower bound on generalised cost per km — keeps A* admissible. */
  _minGenPerKm(p) {
    const type = p.type;
    const bestSpeed = Math.min(type.maxSpeed, 95);
    const minMinutes = 60 / bestSpeed;
    // Best case energy: flat-out downhill, empty, at the optimal speed.
    const minUnits = (type.consumption / 100) * 0.32;
    const minCost = minUnits * p.price + type.costPerKm + (minMinutes / 60) * type.driverCostPerHr;
    const minCo2 = minUnits * p.intensity;
    const w = p.w;
    return Math.max(0, w.time * minMinutes
      + w.distance * (60 / REF_SPEED)
      + w.cost * (minCost / COST_PER_MIN)
      + w.emissions * (minCo2 / CO2_PER_MIN)) * 0.98; // 2% slack for float safety
  }

  /* --- search ----------------------------------------------------- */

  /**
   * Shortest generalised-cost path between two graph nodes.
   * @returns {null | { nodes:number[], edges:number[], gen:number }}
   */
  search(fromNode, toNode, profile) {
    const { world, gScore, fMark, cameFromNode, cameFromEdge, closed, heap } = this;
    // Defensive: a caller with a stale or unsnapped node id must get null, not
    // a crash deep inside the heuristic.
    if (!Number.isInteger(fromNode) || !Number.isInteger(toNode)
      || fromNode < 0 || toNode < 0
      || fromNode >= world.nodes.length || toNode >= world.nodes.length) return null;
    if (fromNode === toNode) return { nodes: [fromNode], edges: [], gen: 0 };
    const gen = ++this.generation;
    heap.clear();
    const target = world.nodes[toNode];
    const h = (id) => {
      const n = world.nodes[id];
      return dist(n.x, n.y, target.x, target.y) * profile.minGenPerKm;
    };
    gScore[fromNode] = 0;
    fMark[fromNode] = gen;
    closed[fromNode] = 0;
    cameFromNode[fromNode] = -1;
    heap.push(fromNode, h(fromNode));

    let expansions = 0;
    while (heap.size) {
      const current = heap.pop();
      if (fMark[current] !== gen) continue;
      if (closed[current] === gen) continue;
      closed[current] = gen;
      if (current === toNode) break;
      expansions++;
      if (expansions > 60000) break; // hard guard against pathological graphs
      const g0 = gScore[current];
      for (const link of world.adj[current]) {
        const next = link.to;
        if (closed[next] === gen) continue;
        const stepCost = this.edgeGen(link.edge, profile);
        if (!Number.isFinite(stepCost)) continue;
        const tentative = g0 + stepCost;
        if (fMark[next] === gen && tentative >= gScore[next]) continue;
        fMark[next] = gen;
        gScore[next] = tentative;
        cameFromNode[next] = current;
        cameFromEdge[next] = link.edge;
        heap.push(next, tentative + h(next));
      }
    }
    this.stats.expansions += expansions;
    if (fMark[toNode] !== gen || closed[toNode] !== gen) return null;

    const nodes = [toNode];
    const edges = [];
    let cur = toNode;
    while (cur !== fromNode) {
      edges.push(cameFromEdge[cur]);
      cur = cameFromNode[cur];
      if (cur === -1 || nodes.length > world.nodes.length) return null;
      nodes.push(cur);
    }
    nodes.reverse(); edges.reverse();
    return { nodes, edges, gen: gScore[toNode] };
  }

  /** Cached, fully-materialised path with all metrics rolled up. */
  path(fromNode, toNode, profile) {
    this.stats.queries++;
    const key = `${fromNode}>${toNode}|${profile.key}|${this.traffic.revision}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) { this.stats.hits++; return hit; }
    const raw = this.search(fromNode, toNode, profile);
    const result = raw ? this.materialise(raw, profile) : null;
    if (this.cache.size >= this.cacheCap) {
      // Cheap eviction: drop the oldest quarter. Insertion order is preserved
      // by Map, so this approximates LRU without per-hit bookkeeping.
      let drop = Math.floor(this.cacheCap / 4);
      for (const k of this.cache.keys()) { this.cache.delete(k); if (--drop <= 0) break; }
    }
    this.cache.set(key, result);
    return result;
  }

  /** Roll a node/edge path up into a metric bundle plus a drawable polyline. */
  materialise(raw, profile) {
    const legs = [];
    let km = 0, minutes = 0, units = 0, co2 = 0, cost = 0, risk = 0, toll = 0;
    let worstCongestion = 0;
    for (const edgeId of raw.edges) {
      const m = this.edgeMetrics(edgeId, profile);
      if (!m) return null;
      legs.push(m);
      km += m.km; minutes += m.minutes; units += m.units;
      co2 += m.co2; cost += m.cost; risk += m.risk; toll += m.toll;
      const c = this.traffic.congestion[edgeId];
      if (c > worstCongestion) worstCongestion = c;
    }
    return {
      nodes: raw.nodes, edges: raw.edges, legs,
      km, minutes, units, co2, cost, risk, toll,
      worstCongestion,
      gen: raw.gen,
      reliability: clamp(1 - risk / Math.max(minutes, 1) / 1.1, 0, 1),
      polyline: this.polylineFor(raw.nodes, raw.edges),
    };
  }

  /** Concatenate edge geometries in travel order, respecting edge direction. */
  polylineFor(nodes, edges) {
    const pts = [];
    for (let i = 0; i < edges.length; i++) {
      const e = this.world.edges[edges[i]];
      const forward = e.a === nodes[i];
      const seg = forward ? e.pts : e.pts.slice().reverse();
      for (let j = i === 0 ? 0 : 1; j < seg.length; j++) pts.push(seg[j]);
    }
    if (!pts.length && nodes.length) {
      const n = this.world.nodes[nodes[0]];
      pts.push({ x: n.x, y: n.y });
    }
    return pts;
  }

  /**
   * K alternative paths via iterative edge penalisation: find the best path,
   * make its edges progressively more expensive, search again. Produces
   * genuinely different corridors rather than near-duplicates of one path.
   */
  alternatives(fromNode, toNode, profile, k = 3, penaltyStrength = 1.55) {
    const out = [];
    const seen = new Set();
    const saved = this.penalties;
    this.penalties = new Float32Array(this.world.edges.length).fill(1);
    try {
      for (let i = 0; i < k + 2 && out.length < k; i++) {
        const raw = this.search(fromNode, toNode, profile);
        if (!raw) break;
        const sig = raw.edges.length ? `${raw.edges[0]}:${raw.edges[Math.floor(raw.edges.length / 2)]}:${raw.edges[raw.edges.length - 1]}:${raw.edges.length}` : 'empty';
        if (!seen.has(sig)) {
          const mat = this.materialise(raw, profile);
          if (mat) { out.push(mat); seen.add(sig); }
        }
        for (const eid of raw.edges) this.penalties[eid] *= penaltyStrength;
      }
    } finally {
      this.penalties = saved;
    }
    return out;
  }

  /** Nearest routable graph node to a world position. */
  snap(x, y) { return this.world.index.nearestNode(x, y); }
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

export const ROUTE_CONSTANTS = { REF_SPEED, COST_PER_MIN, CO2_PER_MIN };
