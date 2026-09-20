/**
 * OPTIMIZATION ENGINE
 *
 *   INPUT -> CONSTRAINTS -> CANDIDATE GENERATION -> ROUTE EVALUATION
 *         -> OBJECTIVE FUNCTION -> OPTIMIZATION -> VALIDATION -> SELECTED PLAN
 *
 * Two phases:
 *
 * 1. CONSTRUCTION — regret-2 insertion. Orders are inserted one at a time into
 *    the (vehicle, position) slot that costs least, but processed in order of
 *    *regret*: the order whose second-best option is much worse than its best
 *    goes first, because that is the one we would most regret leaving late.
 *    This produces a feasible, sensible plan in a fraction of a second.
 *
 * 2. IMPROVEMENT — simulated annealing over relocate / swap / reverse /
 *    eject-and-reinsert moves, scored by the full objective function. Only the
 *    one or two routes a move touches are re-evaluated, so an iteration is
 *    cheap even though the plan score is global.
 *
 * The whole run is cooperative: it yields to the browser every few
 * milliseconds so the map keeps animating at 60fps while the fleet is being
 * re-planned. That is deliberate — an optimiser that freezes the command centre
 * is useless in an operations room.
 */

import { OPTIMIZER, SIM, VEHICLE_TYPES, PRESETS } from '../config.js';
import { clamp, rng, shuffle, dist } from '../util/math.js';
import { finalisePlan, referenceFrom, scorePlan } from './plan.js';
import { normaliseWeights } from './route.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export class Optimizer {
  constructor(planEngine, ctx) {
    this.plan = planEngine;
    this.ctx = ctx;
    this.running = false;
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  /* ---------------------------------------------------------------- */
  /* Baseline — deliberately naive, for honest counterfactuals         */
  /* ---------------------------------------------------------------- */

  /**
   * "What dispatch does without us": assign each order to the nearest depot's
   * next available vehicle round-robin, and visit stops in the order they were
   * booked. No sequencing, no load balancing, no carbon awareness.
   */
  buildBaseline(vehicles, orders, weights, startMinutes = SIM.dayStartMinutes) {
    const usable = vehicles.filter((v) => v.available);
    const assignment = new Map(usable.map((v) => [v.id, []]));
    if (!usable.length) return finalisePlan([], orders.map((o) => o.id), weights, this.ctx, { label: 'Baseline', baseline: true });

    const loads = new Map(usable.map((v) => [v.id, 0]));
    for (const o of orders) {
      // Nearest depot, then the least-loaded vehicle at that depot with room.
      let bestDepot = null, bestD = Infinity;
      for (const d of this.ctx.depots) {
        const dd = dist(d.x, d.y, o.x, o.y);
        if (dd < bestD) { bestD = dd; bestDepot = d; }
      }
      const pool = usable.filter((v) => v.depotId === bestDepot.id);
      const candidates = (pool.length ? pool : usable)
        .filter((v) => loads.get(v.id) + o.weightKg <= VEHICLE_TYPES[v.type].capacityKg)
        .sort((a, b) => loads.get(a.id) - loads.get(b.id));
      const chosen = candidates[0] || usable.slice().sort((a, b) => loads.get(a.id) - loads.get(b.id))[0];
      if (!chosen) continue;
      assignment.get(chosen.id).push(o.id);
      loads.set(chosen.id, loads.get(chosen.id) + o.weightKg);
    }
    const plan = this.plan.buildPlan(assignment, weights, { label: 'Baseline dispatch', baseline: true, startMinutes });
    plan.id = 'PLAN-BASELINE';
    return plan;
  }

  /* ---------------------------------------------------------------- */
  /* Phase 1 — regret-2 insertion                                      */
  /* ---------------------------------------------------------------- */

  async construct({ vehicles, orders, weights, startMinutes, ref, onProgress, rand }) {
    const usable = vehicles.filter((v) => v.available);
    const assignment = new Map(usable.map((v) => [v.id, []]));
    const routes = new Map(usable.map((v) => [v.id, this.plan.evaluateRoute(v, [], weights, startMinutes)]));
    const pending = orders.slice();
    const unserved = [];

    // Priority first: a critical order should claim the good slots.
    const priorityRank = { critical: 0, high: 1, standard: 2, economy: 3 };
    pending.sort((a, b) => (priorityRank[a.priority] - priorityRank[b.priority]) || (a.deadline - b.deadline));

    let processed = 0;
    let sliceStart = performance.now();

    while (pending.length) {
      if (this.cancelled) break;
      // Evaluate the best and second-best insertion for every pending order.
      let bestOrderIdx = -1, bestRegret = -Infinity, bestMove = null;
      for (let i = 0; i < pending.length; i++) {
        const order = pending[i];
        const options = this._insertionOptions(order, usable, assignment, routes, weights, startMinutes, ref);
        if (!options.length) continue;
        options.sort((a, b) => a.delta - b.delta);
        const regret = options.length > 1 ? options[1].delta - options[0].delta : options[0].delta * 0.5;
        // Scale regret by priority so urgent freight wins ties.
        const scaled = regret * (1 + (3 - priorityRank[order.priority]) * 0.22);
        if (scaled > bestRegret) { bestRegret = scaled; bestOrderIdx = i; bestMove = options[0]; }
      }
      if (bestOrderIdx === -1) {
        // Nothing can be inserted anywhere without a hard violation.
        unserved.push(...pending.map((o) => o.id));
        break;
      }
      const order = pending.splice(bestOrderIdx, 1)[0];
      const list = assignment.get(bestMove.vehicleId);
      list.splice(bestMove.position, 0, order.id);
      routes.set(bestMove.vehicleId, bestMove.route);
      processed++;

      if (performance.now() - sliceStart > OPTIMIZER.timeSliceMs) {
        onProgress?.({ phase: 'construct', done: processed, total: orders.length });
        await nextFrame();
        sliceStart = performance.now();
      }
    }
    return { assignment, routes, unserved };
  }

  /** All feasible (vehicle, position) insertions for one order, with deltas. */
  _insertionOptions(order, vehicles, assignment, routes, weights, startMinutes, ref) {
    const options = [];
    // Restrict to the nearest few vehicles by depot proximity — full O(V*P)
    // enumeration is wasted effort when a depot is 60 km away.
    const ranked = vehicles
      .map((v) => {
        const d = this.ctx.depotsById.get(v.depotId);
        return { v, d: dist(d.x, d.y, order.x, order.y) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map((r) => r.v);

    for (const vehicle of ranked) {
      const current = assignment.get(vehicle.id);
      const type = VEHICLE_TYPES[vehicle.type];
      const load = current.reduce((a, id) => a + this.ctx.ordersById.get(id).weightKg, 0);
      if (load + order.weightKg > type.capacityKg) continue;       // hard capacity gate
      const before = routes.get(vehicle.id);
      const beforeCost = this._routeCost(before, weights, ref);
      const limit = Math.min(current.length + 1, 12);
      for (let pos = 0; pos <= current.length && pos < limit; pos++) {
        const next = current.slice();
        next.splice(pos, 0, order.id);
        const route = this.plan.evaluateRoute(vehicle, next, weights, startMinutes);
        if (route.violations.some((v) => v.severity === 'hard')) continue;
        options.push({
          vehicleId: vehicle.id, position: pos, route,
          delta: this._routeCost(route, weights, ref) - beforeCost,
        });
      }
    }
    return options;
  }

  /** Route-level scalarisation, consistent with the global objective. */
  _routeCost(route, weights, ref) {
    if (!route) return 0;
    return weights.time * (route.minutes / ref.minutes)
      + weights.cost * (route.cost / ref.cost)
      + weights.emissions * (route.co2 / ref.co2)
      + weights.distance * (route.km / ref.km)
      + weights.reliability * (1 - route.reliability)
      + (route.lateMinutes / ref.minutes) * OPTIMIZER.lateMinutePenalty;
  }

  /* ---------------------------------------------------------------- */
  /* Phase 2 — simulated annealing                                     */
  /* ---------------------------------------------------------------- */

  async improve({ assignment, routes, unserved, vehicles, weights, startMinutes, ref, iterations, onProgress, rand, label }) {
    const usable = vehicles.filter((v) => v.available);
    if (usable.length === 0) return { assignment, routes, unserved, history: [] };

    const evalPlan = () => finalisePlan([...routes.values()], [...unserved], weights, this.ctx, { label, startMinutes });
    let currentPlan = evalPlan();
    let current = scorePlan(currentPlan, weights, ref).score;
    let best = current;
    let bestAssignment = cloneAssignment(assignment);
    let bestUnserved = [...unserved];
    const history = [{ iteration: 0, score: current, best }];

    let sliceStart = performance.now();
    const total = iterations;
    for (let it = 0; it < total; it++) {
      if (this.cancelled) break;
      const t = it / total;
      const temp = OPTIMIZER.startTemp * Math.pow(OPTIMIZER.endTemp / OPTIMIZER.startTemp, t);

      const move = this._proposeMove(assignment, unserved, usable, rand);
      if (move) {
        const touched = move.apply();
        // Re-evaluate only the routes the move touched.
        const restore = [];
        for (const vid of touched) {
          restore.push([vid, routes.get(vid)]);
          routes.set(vid, this.plan.evaluateRoute(this.ctx.vehiclesById.get(vid), assignment.get(vid), weights, startMinutes));
        }
        const candidatePlan = evalPlan();
        const candidate = scorePlan(candidatePlan, weights, ref).score;
        const delta = candidate - current;
        const accept = delta < 0 || rand() < Math.exp(-delta / Math.max(temp, 1e-6));
        if (accept) {
          current = candidate;
          if (candidate < best - 1e-9) {
            best = candidate;
            bestAssignment = cloneAssignment(assignment);
            bestUnserved = [...unserved];
          }
        } else {
          move.revert();
          for (const [vid, r] of restore) routes.set(vid, r);
        }
      }

      if ((it & 63) === 0) history.push({ iteration: it, score: current, best, temp });

      if (performance.now() - sliceStart > OPTIMIZER.timeSliceMs) {
        onProgress?.({ phase: 'anneal', done: it, total, score: current, best, temp });
        await nextFrame();
        sliceStart = performance.now();
      }
    }

    // Rebuild the routes from the best assignment found.
    const finalRoutes = new Map();
    for (const [vid, orderIds] of bestAssignment) {
      finalRoutes.set(vid, this.plan.evaluateRoute(this.ctx.vehiclesById.get(vid), orderIds, weights, startMinutes));
    }
    history.push({ iteration: total, score: best, best });
    return { assignment: bestAssignment, routes: finalRoutes, unserved: bestUnserved, history };
  }

  /** Pick a random neighbourhood move, returning apply/revert closures. */
  _proposeMove(assignment, unserved, vehicles, rand) {
    const ids = vehicles.map((v) => v.id);
    const nonEmpty = ids.filter((id) => assignment.get(id).length > 0);
    const roll = rand();

    // Reinsert an unserved order — always worth trying when the pool is non-empty.
    if (unserved.length && roll < 0.18) {
      const ui = Math.floor(rand() * unserved.length);
      const orderId = unserved[ui];
      const vid = ids[Math.floor(rand() * ids.length)];
      const list = assignment.get(vid);
      const pos = Math.floor(rand() * (list.length + 1));
      return {
        apply() { unserved.splice(ui, 1); list.splice(pos, 0, orderId); return [vid]; },
        revert() { list.splice(pos, 1); unserved.splice(ui, 0, orderId); },
      };
    }
    if (!nonEmpty.length) return null;

    if (roll < 0.46) {
      // RELOCATE: move one order to another vehicle / another position.
      const fromId = nonEmpty[Math.floor(rand() * nonEmpty.length)];
      const toId = ids[Math.floor(rand() * ids.length)];
      const from = assignment.get(fromId), to = assignment.get(toId);
      const i = Math.floor(rand() * from.length);
      const j = Math.floor(rand() * (to.length + (fromId === toId ? 0 : 1)));
      if (fromId === toId && i === j) return null;
      // Splicing out of `from` first and back in last keeps the indices valid
      // even when `from` and `to` are the same array.
      return {
        apply() {
          const [orderId] = from.splice(i, 1);
          to.splice(j, 0, orderId);
          return fromId === toId ? [fromId] : [fromId, toId];
        },
        revert() {
          const [orderId] = to.splice(j, 1);
          from.splice(i, 0, orderId);
        },
      };
    }

    if (roll < 0.72 && nonEmpty.length > 1) {
      // SWAP: exchange one order between two vehicles.
      const aId = nonEmpty[Math.floor(rand() * nonEmpty.length)];
      let bId = nonEmpty[Math.floor(rand() * nonEmpty.length)];
      if (aId === bId) return null;
      const a = assignment.get(aId), b = assignment.get(bId);
      const i = Math.floor(rand() * a.length), j = Math.floor(rand() * b.length);
      return {
        apply() { const tmp = a[i]; a[i] = b[j]; b[j] = tmp; return [aId, bId]; },
        revert() { const tmp = a[i]; a[i] = b[j]; b[j] = tmp; },
      };
    }

    if (roll < 0.94) {
      // 2-OPT style: reverse a contiguous run inside one route.
      const vid = nonEmpty[Math.floor(rand() * nonEmpty.length)];
      const list = assignment.get(vid);
      if (list.length < 3) return null;
      let i = Math.floor(rand() * (list.length - 1));
      let j = i + 1 + Math.floor(rand() * (list.length - i - 1));
      return {
        apply() { reverseRange(list, i, j); return [vid]; },
        revert() { reverseRange(list, i, j); },
      };
    }

    // EJECT: drop an order to the unserved pool. Almost always rejected, but it
    // is the escape hatch that lets the search cross infeasible valleys.
    const vid = nonEmpty[Math.floor(rand() * nonEmpty.length)];
    const list = assignment.get(vid);
    const i = Math.floor(rand() * list.length);
    return {
      apply() { const [orderId] = list.splice(i, 1); unserved.push(orderId); return [vid]; },
      revert() { const orderId = unserved.pop(); list.splice(i, 0, orderId); },
    };
  }

  /* ---------------------------------------------------------------- */
  /* VALIDATION                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The annealer is allowed to *visit* infeasible states — that freedom is how
   * it escapes local optima — so the plan it hands back must be validated and,
   * if necessary, repaired before it can be published.
   *
   * Repair strategy: while a route breaks a hard constraint, eject its least
   * valuable stop (lowest priority, latest deadline) and try to reinsert it
   * elsewhere. Anything that cannot be placed lands in `unserved`, where the
   * alert system will surface it rather than it disappearing quietly.
   */
  validate({ assignment, routes, unserved }, weights, startMinutes) {
    const repairs = [];
    const priorityRank = { critical: 0, high: 1, standard: 2, economy: 3 };
    const out = [...unserved];

    for (const [vehicleId, orderIds] of assignment) {
      const vehicle = this.ctx.vehiclesById.get(vehicleId);
      if (!vehicle) continue;
      let list = [...orderIds];
      let route = routes.get(vehicleId) || this.plan.evaluateRoute(vehicle, list, weights, startMinutes);
      let guard = list.length + 2;
      while (list.length && route.violations.some((v) => v.severity === 'hard') && guard-- > 0) {
        // Eject the stop we would least regret losing.
        const ranked = list
          .map((id) => this.ctx.ordersById.get(id))
          .filter(Boolean)
          .sort((a, b) => (priorityRank[b.priority] - priorityRank[a.priority]) || (b.deadline - a.deadline));
        const victim = ranked[0];
        if (!victim) break;
        list = list.filter((id) => id !== victim.id);
        route = this.plan.evaluateRoute(vehicle, list, weights, startMinutes);
        repairs.push({ orderId: victim.id, from: vehicleId, reason: 'hard constraint violation' });
        out.push(victim.id);
      }
      assignment.set(vehicleId, list);
      routes.set(vehicleId, route);
    }

    // Try to place everything ejected somewhere legal before giving up on it.
    for (let i = out.length - 1; i >= 0; i--) {
      const order = this.ctx.ordersById.get(out[i]);
      if (!order) { out.splice(i, 1); continue; }
      let placed = false;
      for (const [vehicleId, list] of assignment) {
        const vehicle = this.ctx.vehiclesById.get(vehicleId);
        if (!vehicle || !vehicle.available) continue;
        const load = list.reduce((a, id) => a + (this.ctx.ordersById.get(id)?.weightKg || 0), 0);
        if (load + order.weightKg > VEHICLE_TYPES[vehicle.type].capacityKg) continue;
        for (let pos = 0; pos <= list.length; pos++) {
          const trial = list.slice();
          trial.splice(pos, 0, order.id);
          const r = this.plan.evaluateRoute(vehicle, trial, weights, startMinutes);
          if (r.violations.some((v) => v.severity === 'hard')) continue;
          assignment.set(vehicleId, trial);
          routes.set(vehicleId, r);
          out.splice(i, 1);
          placed = true;
          break;
        }
        if (placed) break;
      }
    }

    return { assignment, routes, unserved: out, repairs };
  }

  /* ---------------------------------------------------------------- */
  /* Public entry point                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Full optimisation run.
   * @returns {{ plan, baseline, history, stats }}
   */
  async optimize({
    vehicles, orders, weights, startMinutes = SIM.dayStartMinutes,
    iterations = OPTIMIZER.maxIterations, onProgress, label = 'Optimised plan',
    baseline = null, seed = 7,
  }) {
    this.cancelled = false;
    this.running = true;
    const t0 = performance.now();
    const w = normaliseWeights(weights);
    const rand = rng(seed);
    try {
      const openOrders = orders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
      const base = baseline || this.buildBaseline(vehicles, openOrders, w, startMinutes);
      const ref = referenceFrom(base);

      onProgress?.({ phase: 'analyse', done: 0, total: 1, message: `Analysing ${openOrders.length} orders across ${vehicles.filter((v) => v.available).length} vehicles` });
      await nextFrame();

      const built = await this.construct({ vehicles, orders: openOrders, weights: w, startMinutes, ref, onProgress, rand });
      if (this.cancelled) return null;

      const improved = await this.improve({
        ...built, vehicles, weights: w, startMinutes, ref, iterations, onProgress, rand, label,
      });
      if (this.cancelled) return null;

      const repaired = this.validate(improved, w, startMinutes);
      const plan = finalisePlan([...repaired.routes.values()], repaired.unserved, w, this.ctx, { label, startMinutes });
      plan.repairs = repaired.repairs;
      const scored = scorePlan(plan, w, ref);
      plan.score = scored.score;
      plan.scoreBreakdown = scored;
      plan.reference = ref;

      const baseScored = scorePlan(base, w, ref);
      base.score = baseScored.score;
      base.scoreBreakdown = baseScored;
      base.reference = ref;

      const stats = {
        elapsedMs: Math.round(performance.now() - t0),
        routeEvaluations: this.plan.evaluations,
        pathQueries: this.plan.router.stats.queries,
        cacheHitRate: this.plan.router.stats.queries
          ? this.plan.router.stats.hits / this.plan.router.stats.queries : 0,
        iterations,
        improvement: base.score > 0 ? (base.score - plan.score) / base.score : 0,
      };
      return { plan, baseline: base, history: improved.history, stats, reference: ref };
    } finally {
      this.running = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* PARETO ENGINE                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Sample the weight simplex, optimise at each sample, and return the
   * non-dominated set across (cost, time, CO2e). These are real solutions —
   * each one can be selected and becomes the live fleet plan.
   */
  async frontier({ vehicles, orders, startMinutes, onProgress, samples = OPTIMIZER.paretoSamples, baseline }) {
    this.cancelled = false;
    const weightVectors = sampleWeights(samples);
    const candidates = [];
    const openOrders = orders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
    const base = baseline || this.buildBaseline(vehicles, openOrders, PRESETS.balanced, startMinutes);
    const ref = referenceFrom(base);

    for (let i = 0; i < weightVectors.length; i++) {
      if (this.cancelled) break;
      const w = weightVectors[i];
      onProgress?.({ phase: 'pareto', done: i, total: weightVectors.length, weights: w });
      const built = await this.construct({ vehicles, orders: openOrders, weights: w, startMinutes, ref, rand: rng(11 + i) });
      // Short anneal per sample — the frontier needs breadth, not depth.
      const improved = await this.improve({
        ...built, vehicles, weights: w, startMinutes, ref,
        iterations: Math.round(OPTIMIZER.maxIterations * 0.22), rand: rng(101 + i), label: `Candidate ${i + 1}`,
      });
      const repaired = this.validate(improved, w, startMinutes);
      const plan = finalisePlan([...repaired.routes.values()], repaired.unserved, w, this.ctx, { label: `Candidate ${i + 1}`, startMinutes });
      plan.id = `CAND-${String(i + 1).padStart(2, '0')}`;
      plan.weights = w;
      plan.reference = ref;
      candidates.push(plan);
    }

    const front = paretoFront(candidates, [
      (p) => p.metrics.cost,
      (p) => p.metrics.minutes,
      (p) => p.metrics.co2,
    ]);
    for (const c of candidates) c.onFrontier = front.includes(c);
    return { candidates, frontier: front, baseline: base, reference: ref };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function cloneAssignment(map) {
  const out = new Map();
  for (const [k, v] of map) out.set(k, v.slice());
  return out;
}

function reverseRange(arr, i, j) {
  while (i < j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; i++; j--; }
}

/** Evenly-ish spread weight vectors over the 5-objective simplex. */
export function sampleWeights(n) {
  const out = [];
  // Always include the named presets so the frontier contains recognisable
  // anchors the user can reason about.
  for (const p of Object.values(PRESETS)) out.push(normaliseWeights(p));
  const rand = rng(4242);
  const keys = ['time', 'cost', 'emissions', 'distance', 'reliability'];
  // Corner-biased Dirichlet-ish sampling: most useful trade-offs live near
  // the edges of the simplex, not in the middle.
  while (out.length < n) {
    const dominant = keys[Math.floor(rand() * keys.length)];
    const w = {};
    let total = 0;
    for (const k of keys) {
      const v = k === dominant ? 0.35 + rand() * 0.55 : rand() * 0.3;
      w[k] = v; total += v;
    }
    for (const k of keys) w[k] /= total;
    out.push(w);
  }
  return out.slice(0, n);
}

/** Non-dominated subset under "smaller is better" on every accessor. */
export function paretoFront(items, accessors) {
  const front = [];
  for (const a of items) {
    let dominated = false;
    for (const b of items) {
      if (a === b) continue;
      let allLE = true, anyLT = false;
      for (const f of accessors) {
        const fa = f(a), fb = f(b);
        if (fb > fa + 1e-9) { allLE = false; break; }
        if (fb < fa - 1e-9) anyLT = true;
      }
      if (allLE && anyLT) { dominated = true; break; }
    }
    if (!dominated) front.push(a);
  }
  return front;
}

export { clamp, shuffle };
