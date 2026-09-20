import './harness.mjs';
import { suite, test, run, assert, equal, close, greater, atMost } from './harness.mjs';

import { buildWorld, worldStats, pointInPolygon } from '../src/data/world.js';
import { buildDataset, makeUrgentOrder } from '../src/data/seed.js';
import { TrafficEngine } from '../src/engines/traffic.js';
import { RouteEngine, normaliseWeights } from '../src/engines/route.js';
import { PlanEngine, scorePlan, referenceFrom } from '../src/engines/plan.js';
import { Optimizer, paretoFront, sampleWeights } from '../src/engines/optimizer.js';
import { comparePlans, explainRoute, planDiff, explainCarbon } from '../src/engines/explain.js';
import { edgeEnergy, speedFactor, gradeFactor } from '../src/engines/energy.js';
import { intensityAt, co2e, cleanestHour } from '../src/engines/emissions.js';
import { PRESETS, VEHICLE_TYPES, SIM, SEED } from '../src/config.js';
import { rng, pointAtLength, polylineLength, normalize } from '../src/util/math.js';
import { dur, clock, num } from '../src/util/format.js';

/* ------------------------------------------------------------------ */

const world = buildWorld(SEED);
const stats = worldStats(world);
const { depots, vehicles, orders } = buildDataset(world, SEED);
const ctx = {
  depots,
  depotsById: new Map(depots.map((d) => [d.id, d])),
  vehiclesById: new Map(vehicles.map((v) => [v.id, v])),
  ordersById: new Map(orders.map((o) => [o.id, o])),
};
const traffic = new TrafficEngine(world);
traffic.update(9 * 60);
const router = new RouteEngine(world, traffic);
const planEngine = new PlanEngine(world, router, ctx);
const optimizer = new Optimizer(planEngine, ctx);

/* ------------------------------------------------------------------ */

suite('World', () => {
  test('is deterministic across builds', () => {
    const a = buildWorld(SEED);
    const b = buildWorld(SEED);
    equal(a.nodes.length, b.nodes.length, 'node count');
    equal(a.edges.length, b.edges.length, 'edge count');
    close(a.nodes[100].x, b.nodes[100].x, 1e-12, 'node position');
  });

  test('a different seed produces a different world', () => {
    const other = buildWorld(SEED + 1);
    assert(other.nodes.length !== world.nodes.length || other.nodes[50].x !== world.nodes[50].x,
      'seed change should alter geography');
  });

  test('has a substantial road network', () => {
    greater(stats.nodes, 400, 'nodes');
    greater(stats.edges, 700, 'edges');
    greater(stats.totalKm, 900, 'total km');
  });

  test('graph is fully connected (single component)', () => {
    const seen = new Uint8Array(world.nodes.length);
    const stack = [0];
    seen[0] = 1;
    let count = 1;
    while (stack.length) {
      const id = stack.pop();
      for (const link of world.adj[id]) {
        if (!seen[link.to]) { seen[link.to] = 1; count++; stack.push(link.to); }
      }
    }
    equal(count, world.nodes.length, 'reachable nodes');
  });

  test('every edge references valid nodes and has positive length', () => {
    for (const e of world.edges) {
      assert(e.a >= 0 && e.a < world.nodes.length, `edge ${e.id} node a`);
      assert(e.b >= 0 && e.b < world.nodes.length, `edge ${e.id} node b`);
      greater(e.lengthKm, 0, `edge ${e.id} length`);
      assert(Number.isFinite(e.baseSpeed) && e.baseSpeed > 1, `edge ${e.id} speed`);
    }
  });

  test('nearest-node lookup returns a genuinely near node', () => {
    const rand = rng(99);
    for (let i = 0; i < 50; i++) {
      const x = (rand() * 2 - 1) * 34, y = (rand() * 2 - 1) * 24;
      const id = world.index.nearestNode(x, y);
      assert(id >= 0, 'found a node');
      const n = world.nodes[id];
      // Brute-force check against the true nearest.
      let best = Infinity;
      for (const m of world.nodes) best = Math.min(best, Math.hypot(m.x - x, m.y - y));
      close(Math.hypot(n.x - x, n.y - y), best, 1e-9, 'returns the true nearest node');
    }
  });

  test('point-in-polygon agrees with an obvious case', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert(pointInPolygon(5, 5, square), 'inside');
    assert(!pointInPolygon(15, 5, square), 'outside');
  });
});

/* ------------------------------------------------------------------ */

suite('Energy & emissions', () => {
  test('speed factor is minimised near the optimal speed', () => {
    const atOpt = speedFactor(62);
    greater(speedFactor(12), atOpt, 'stop-and-go costs more');
    greater(speedFactor(110), atOpt, 'high speed costs more');
    close(atOpt, 1, 0.02, 'normalised at optimum');
  });

  test('climbing costs energy and descending recovers it', () => {
    greater(gradeFactor(0.05, 0.6), 1, 'uphill');
    atMost(gradeFactor(-0.05, 0.6), 1, 'downhill');
    greater(gradeFactor(-0.05, 0.18), gradeFactor(-0.05, 0.62), 'better regen recovers more');
  });

  test('payload raises consumption monotonically', () => {
    const edge = world.edges[10];
    const empty = edgeEnergy('diesel_truck', edge, 60, 0).units;
    const half = edgeEnergy('diesel_truck', edge, 60, 0.5).units;
    const full = edgeEnergy('diesel_truck', edge, 60, 1).units;
    greater(half, empty, 'half > empty');
    greater(full, half, 'full > half');
  });

  test('grid intensity varies by hour and midday is cleanest', () => {
    const best = cleanestHour(8, 20);
    greater(intensityAt('bev', 19 * 60), intensityAt('bev', best.hour * 60), 'evening dirtier than the cleanest hour');
    equal(intensityAt('diesel', 3 * 60), intensityAt('diesel', 18 * 60), 'diesel is time-invariant');
  });

  test('CO2e scales linearly with energy', () => {
    close(co2e('diesel_van', 10, 600), co2e('diesel_van', 5, 600) * 2, 1e-9, 'linearity');
  });
});

/* ------------------------------------------------------------------ */

suite('Traffic engine', () => {
  test('rush hour is more congested than the small hours', () => {
    traffic.update(3 * 60);
    const quiet = traffic.networkIndex();
    traffic.update(18 * 60);
    const rush = traffic.networkIndex();
    greater(rush, quiet, 'rush > quiet');
    traffic.update(9 * 60);
  });

  test('a global multiplier raises congestion everywhere', () => {
    traffic.update(9 * 60);
    const before = traffic.networkIndex();
    traffic.setGlobalMultiplier(1.6);
    traffic.update(9 * 60);
    const after = traffic.networkIndex();
    greater(after, before, 'multiplier raises the index');
    traffic.setGlobalMultiplier(1);
    traffic.update(9 * 60);
  });

  test('closing an edge makes it untraversable', () => {
    const id = world.edges.findIndex((e) => e.cls === 'arterial');
    traffic.closeEdge(id);
    traffic.update(9 * 60);
    equal(traffic.speedFactor[id], 0, 'speed factor zero');
    assert(!Number.isFinite(traffic.timeOn(id)), 'infinite travel time');
    traffic.openEdge(id);
    traffic.update(9 * 60);
    greater(traffic.speedFactor[id], 0, 'reopened');
  });

  test('incidents are local, not global', () => {
    traffic.update(9 * 60);
    const far = world.edges.findIndex((e) => Math.hypot(e.mid.x - 0, e.mid.y - 0) > 20);
    const near = world.edges.findIndex((e) => Math.hypot(e.mid.x - 0, e.mid.y - 0) < 3);
    const farBefore = traffic.congestion[far];
    const nearBefore = traffic.congestion[near];
    traffic.addIncident({ x: 0, y: 0, radiusKm: 8, severity: 1.2 });
    traffic.update(9 * 60);
    greater(traffic.congestion[near], nearBefore, 'near edge affected');
    close(traffic.congestion[far], farBefore, 1e-6, 'far edge untouched');
    traffic.clearIncidents();
    traffic.update(9 * 60);
  });
});

/* ------------------------------------------------------------------ */

suite('Route engine', () => {
  const profile = router.profile({ vehicleType: 'diesel_van', payload: 0.5, weights: PRESETS.balanced, clockMinutes: 540 });
  // Pick well-separated real node ids rather than hard-coding indices, so the
  // suite keeps testing long-haul routing if the generator's density changes.
  const NODE_A = world.index.nearestNode(-34, -22);
  const NODE_B = world.index.nearestNode(33, 21);
  const NODE_C = world.index.nearestNode(2, -18);

  test('finds a path between arbitrary node pairs', () => {
    const rand = rng(5);
    for (let i = 0; i < 30; i++) {
      const a = Math.floor(rand() * world.nodes.length);
      const b = Math.floor(rand() * world.nodes.length);
      const p = router.path(a, b, profile);
      assert(p !== null, `path ${a}->${b}`);
      if (a !== b) greater(p.km, 0, 'positive distance');
    }
  });

  test('path geometry is continuous and matches the node sequence', () => {
    const p = router.path(NODE_A, NODE_B, profile);
    assert(p, 'path exists');
    equal(p.edges.length, p.nodes.length - 1, 'edge/node count');
    for (let i = 1; i < p.polyline.length; i++) {
      const step = Math.hypot(p.polyline[i].x - p.polyline[i - 1].x, p.polyline[i].y - p.polyline[i - 1].y);
      atMost(step, 12, 'no geometry jumps');
    }
    close(polylineLength(p.polyline), p.km, p.km * 0.02 + 0.2, 'polyline length matches reported km');
  });

  test('A* returns the true optimum (verified against Dijkstra)', () => {
    // Exhaustive Dijkstra on the same cost function, for a handful of pairs.
    const dijkstra = (from, to) => {
      const d = new Float64Array(world.nodes.length).fill(Infinity);
      const done = new Uint8Array(world.nodes.length);
      d[from] = 0;
      for (;;) {
        let u = -1, bestD = Infinity;
        for (let i = 0; i < d.length; i++) if (!done[i] && d[i] < bestD) { bestD = d[i]; u = i; }
        if (u === -1 || u === to) break;
        done[u] = 1;
        for (const link of world.adj[u]) {
          const c = router.edgeGen(link.edge, profile);
          if (!Number.isFinite(c)) continue;
          if (d[u] + c < d[link.to]) d[link.to] = d[u] + c;
        }
      }
      return d[to];
    };
    const rand = rng(17);
    for (let i = 0; i < 6; i++) {
      const a = Math.floor(rand() * world.nodes.length);
      const b = Math.floor(rand() * world.nodes.length);
      if (a === b) continue;
      const astar = router.search(a, b, profile);
      const truth = dijkstra(a, b);
      assert(astar, 'A* found a path');
      close(astar.gen, truth, Math.max(1e-6, truth * 1e-9), `optimality ${a}->${b}`);
    }
  });

  test('weights change the chosen path', () => {
    const fast = router.profile({ vehicleType: 'diesel_truck', payload: 0.8, weights: PRESETS.fastest, clockMinutes: 540 });
    const green = router.profile({ vehicleType: 'diesel_truck', payload: 0.8, weights: PRESETS.greenest, clockMinutes: 540 });
    let differing = 0;
    const rand = rng(31);
    for (let i = 0; i < 25; i++) {
      const a = Math.floor(rand() * world.nodes.length);
      const b = Math.floor(rand() * world.nodes.length);
      const pf = router.path(a, b, fast), pg = router.path(a, b, green);
      if (pf && pg && pf.edges.join() !== pg.edges.join()) differing++;
    }
    greater(differing, 0, 'at least some paths differ between objectives');
  });

  test('the fastest profile really is fastest, the greenest really is greenest', () => {
    const a = NODE_A, b = NODE_B;
    const fast = router.path(a, b, router.profile({ vehicleType: 'diesel_truck', payload: 0.6, weights: { time: 1, cost: 0, emissions: 0, distance: 0, reliability: 0 }, clockMinutes: 540 }));
    const green = router.path(a, b, router.profile({ vehicleType: 'diesel_truck', payload: 0.6, weights: { time: 0, cost: 0, emissions: 1, distance: 0, reliability: 0 }, clockMinutes: 540 }));
    assert(fast && green, 'both paths exist');
    atMost(fast.minutes, green.minutes + 1e-6, 'time-optimal is not slower');
    atMost(green.co2, fast.co2 + 1e-9, 'emissions-optimal is not dirtier');
  });

  test('a closed corridor is routed around', () => {
    const p1 = router.path(NODE_C, NODE_B, profile);
    assert(p1, 'baseline path');
    const toClose = p1.edges.slice(Math.floor(p1.edges.length / 2), Math.floor(p1.edges.length / 2) + 2);
    for (const id of toClose) traffic.closeEdge(id);
    traffic.update(540);
    router.invalidate();
    const p2 = router.path(NODE_C, NODE_B, profile);
    if (p2) {
      for (const id of toClose) assert(!p2.edges.includes(id), 'closed edge avoided');
    }
    for (const id of toClose) traffic.openEdge(id);
    traffic.update(540);
    router.invalidate();
  });

  test('alternatives are distinct corridors', () => {
    const alts = router.alternatives(NODE_A, NODE_C, profile, 3);
    greater(alts.length, 1, 'more than one alternative');
    const sigs = new Set(alts.map((a) => a.edges.join()));
    equal(sigs.size, alts.length, 'all distinct');
    for (let i = 1; i < alts.length; i++) atMost(alts[0].gen, alts[i].gen + 1e-6, 'first is the cheapest');
  });

  test('the cache returns identical results', () => {
    router.invalidate();
    const a = router.path(NODE_A, NODE_C, profile);
    const b = router.path(NODE_A, NODE_C, profile);
    equal(a, b, 'same object from cache');
    greater(router.stats.hits, 0, 'cache recorded a hit');
  });

  test('weights are normalised and degenerate input is handled', () => {
    const w = normaliseWeights({ time: 2, cost: 2, emissions: 0, distance: 0, reliability: 0 });
    close(w.time + w.cost + w.emissions + w.distance + w.reliability, 1, 1e-9, 'sums to 1');
    const z = normaliseWeights({ time: 0, cost: 0, emissions: 0, distance: 0, reliability: 0 });
    close(z.time, 0.2, 1e-9, 'degenerate falls back to balanced');
  });
});

/* ------------------------------------------------------------------ */

suite('Plan & constraints', () => {
  const weights = normaliseWeights(PRESETS.balanced);

  test('an empty route is feasible and costs nothing', () => {
    const r = planEngine.evaluateRoute(vehicles[0], [], weights);
    equal(r.km, 0, 'no distance');
    assert(r.empty, 'flagged empty');
    assert(r.feasible, 'feasible');
  });

  test('a route visits every assigned stop and returns to the depot', () => {
    const ids = orders.slice(0, 4).map((o) => o.id);
    const r = planEngine.evaluateRoute(vehicles[3], ids, weights);
    equal(r.stops.length, 4, 'stop count');
    equal(r.legs.length, 5, 'four legs out plus the return leg');
    greater(r.km, 0, 'distance');
    const depot = ctx.depotsById.get(vehicles[3].depotId);
    const last = r.polyline[r.polyline.length - 1];
    close(Math.hypot(last.x - depot.x, last.y - depot.y), 0, 0.6, 'ends at the depot');
  });

  test('capacity overload is reported as a hard violation', () => {
    const small = vehicles.find((v) => VEHICLE_TYPES[v.type].capacityKg < 1000);
    const heavy = orders.slice().sort((a, b) => b.weightKg - a.weightKg).slice(0, 6).map((o) => o.id);
    const r = planEngine.evaluateRoute(small, heavy, weights);
    assert(!r.feasible, 'infeasible');
    assert(r.violations.some((v) => v.code === 'capacity' && v.severity === 'hard'), 'capacity violation raised');
  });

  test('payload declines along the route and is charged leg by leg', () => {
    const ids = orders.slice(0, 3).map((o) => o.id);
    const r = planEngine.evaluateRoute(vehicles[3], ids, weights);
    for (let i = 1; i < r.stops.length; i++) {
      atMost(r.stops[i].loadBeforeKg, r.stops[i - 1].loadBeforeKg, 'load decreases');
    }
  });

  test('stop times are monotonic and respect service duration', () => {
    const ids = orders.slice(2, 7).map((o) => o.id);
    const r = planEngine.evaluateRoute(vehicles[2], ids, weights);
    for (let i = 0; i < r.stops.length; i++) {
      const s = r.stops[i];
      greater(s.departure, s.arrival - 1e-9, 'departure after arrival');
      if (i > 0) greater(s.arrival, r.stops[i - 1].departure - 1e-9, 'sequential');
      assert(s.serviceStart >= s.windowOpen - 1e-6, 'never serviced before the window opens');
    }
    greater(r.endMinutes, r.startMinutes, 'route takes time');
  });

  test('lateness is detected against the deadline', () => {
    const late = orders.slice().sort((a, b) => a.deadline - b.deadline).slice(0, 8).map((o) => o.id);
    const big = vehicles.find((v) => VEHICLE_TYPES[v.type].capacityKg > 6000);
    const r = planEngine.evaluateRoute(big, late, weights, SIM.dayEndMinutes - 30);
    greater(r.lateOrders, 0, 'starting half an hour before close must run late');
    assert(r.violations.some((v) => v.code === 'deadline'), 'deadline violation reported');
  });

  test('an unavailable vehicle cannot carry a route', () => {
    const v = { ...vehicles[1], available: false };
    const r = planEngine.evaluateRoute(v, [orders[0].id], weights);
    assert(!r.feasible, 'infeasible');
    assert(r.violations.some((x) => x.code === 'vehicle_unavailable'), 'availability violation');
  });

  test('plan aggregation sums its routes exactly', () => {
    const assignment = new Map([
      [vehicles[0].id, orders.slice(0, 2).map((o) => o.id)],
      [vehicles[1].id, orders.slice(2, 4).map((o) => o.id)],
    ]);
    const plan = planEngine.buildPlan(assignment, weights);
    const sumKm = plan.routes.reduce((a, r) => a + r.km, 0);
    close(plan.metrics.km, sumKm, 1e-9, 'km');
    equal(plan.metrics.stops, 4, 'stops');
    equal(plan.metrics.unserved, orders.length - 4, 'unserved remainder');
  });

  test('the objective function responds to its weights', () => {
    const assignment = new Map([[vehicles[0].id, orders.slice(0, 3).map((o) => o.id)]]);
    const plan = planEngine.buildPlan(assignment, weights);
    const ref = referenceFrom(plan);
    const timeHeavy = scorePlan(plan, normaliseWeights({ time: 1, cost: 0, emissions: 0, distance: 0, reliability: 0 }), ref);
    const co2Heavy = scorePlan(plan, normaliseWeights({ time: 0, cost: 0, emissions: 1, distance: 0, reliability: 0 }), ref);
    greater(timeHeavy.terms.time, 0, 'time term active');
    equal(co2Heavy.terms.time, 0, 'time term zeroed when unweighted');
    greater(co2Heavy.terms.emissions, 0, 'emissions term active');
  });
});

/* ------------------------------------------------------------------ */

suite('Optimizer', () => {
  const weights = normaliseWeights(PRESETS.balanced);
  let baseline, optimised;

  test('builds a naive baseline covering every order it can', () => {
    baseline = optimizer.buildBaseline(vehicles, orders, weights);
    greater(baseline.metrics.km, 0, 'baseline has distance');
    greater(baseline.metrics.stops, orders.length * 0.8, 'baseline serves most orders');
  });

  test('optimisation improves on the baseline objective', async () => {
    const result = await optimizer.optimize({
      vehicles, orders, weights, iterations: 2500, seed: 3, baseline,
    });
    assert(result, 'produced a result');
    optimised = result.plan;
    atMost(optimised.score, baseline.score, 'score improved or matched');
    greater(result.stats.routeEvaluations, 0, 'evaluated routes');
  });

  test('the optimised plan respects every hard constraint', () => {
    equal(optimised.metrics.hardViolations, 0, 'no hard violations');
    for (const r of optimised.routes) {
      const cap = VEHICLE_TYPES[r.vehicleType].capacityKg;
      atMost(r.capacityUsedKg, cap, `capacity on ${r.id}`);
      const v = ctx.vehiclesById.get(r.vehicleId);
      atMost(r.energyFraction, Math.max(0, v.energyLevel - 0.10) + 1e-9, `range on ${r.id}`);
    }
  });

  test('no order is served twice and none is silently lost', () => {
    const seen = new Set();
    for (const r of optimised.routes) {
      for (const id of r.orderIds) {
        assert(!seen.has(id), `duplicate assignment of ${id}`);
        seen.add(id);
      }
    }
    equal(seen.size + optimised.unserved.length, orders.length, 'every order accounted for');
  });

  test('changing the weights changes the plan', async () => {
    const green = await optimizer.optimize({
      vehicles, orders, weights: normaliseWeights(PRESETS.greenest), iterations: 2500, seed: 3, baseline,
    });
    const fast = await optimizer.optimize({
      vehicles, orders, weights: normaliseWeights(PRESETS.fastest), iterations: 2500, seed: 3, baseline,
    });
    assert(green && fast, 'both plans produced');
    const differs = green.plan.metrics.co2 !== fast.plan.metrics.co2
      || green.plan.metrics.minutes !== fast.plan.metrics.minutes;
    assert(differs, 'objectives produce materially different plans');
    atMost(green.plan.metrics.co2, fast.plan.metrics.co2 * 1.02, 'the green plan is not dirtier than the fast one');
  });

  test('an empty fleet is handled without throwing', async () => {
    const none = vehicles.map((v) => ({ ...v, available: false }));
    const noneCtx = { ...ctx, vehiclesById: new Map(none.map((v) => [v.id, v])) };
    const opt = new Optimizer(new PlanEngine(world, router, noneCtx), noneCtx);
    const result = await opt.optimize({ vehicles: none, orders, weights, iterations: 200 });
    assert(result, 'returned a result rather than throwing');
    equal(result.plan.metrics.unserved, orders.length, 'everything unserved');
    equal(result.plan.metrics.vehiclesUsed, 0, 'no vehicles used');
  });

  test('an empty order book produces an empty but valid plan', async () => {
    const result = await optimizer.optimize({ vehicles, orders: [], weights, iterations: 200 });
    assert(result, 'returned a result');
    equal(result.plan.metrics.stops, 0, 'no stops');
    equal(result.plan.metrics.km, 0, 'no distance');
    assert(result.plan.metrics.feasible, 'trivially feasible');
  });

  test('disabling a vehicle forces its work elsewhere', async () => {
    const victim = optimised.routes.find((r) => r.orderIds.length >= 2);
    assert(victim, 'found a loaded route');
    const modified = vehicles.map((v) => (v.id === victim.vehicleId ? { ...v, available: false } : v));
    const modCtx = { ...ctx, vehiclesById: new Map(modified.map((v) => [v.id, v])) };
    const opt = new Optimizer(new PlanEngine(world, router, modCtx), modCtx);
    const result = await opt.optimize({ vehicles: modified, orders, weights, iterations: 2500, seed: 9 });
    assert(result, 'replanned');
    const stillUsed = result.plan.routes.find((r) => r.vehicleId === victim.vehicleId);
    equal(stillUsed ? stillUsed.orderIds.length : 0, 0, 'disabled vehicle carries nothing');
  });

  test('pareto front keeps only non-dominated points', () => {
    const items = [
      { c: 1, t: 5 }, { c: 2, t: 4 }, { c: 3, t: 3 },
      { c: 4, t: 9 },                       // dominated by every one of the above
      { c: 2, t: 4 },                       // duplicate, not dominated
    ];
    const front = paretoFront(items, [(i) => i.c, (i) => i.t]);
    assert(!front.includes(items[3]), 'dominated point excluded');
    greater(front.length, 2, 'front retains the trade-off curve');
  });

  test('weight sampling covers the simplex and includes the presets', () => {
    const ws = sampleWeights(20);
    equal(ws.length, 20, 'requested count');
    for (const w of ws) {
      close(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-9, 'normalised');
    }
    const hasGreen = ws.some((w) => Math.abs(w.emissions - normaliseWeights(PRESETS.greenest).emissions) < 1e-9);
    assert(hasGreen, 'presets included as anchors');
  });
});

/* ------------------------------------------------------------------ */

suite('Explanation layer', () => {
  const weights = normaliseWeights(PRESETS.balanced);
  let planA, planB;

  test('comparePlans reports real, signed differences', async () => {
    planA = optimizer.buildBaseline(vehicles, orders, weights);
    const r = await optimizer.optimize({ vehicles, orders, weights, iterations: 2000, seed: 5, baseline: planA });
    planB = r.plan;
    const cmp = comparePlans(planA, planB);
    for (const row of cmp.rows) {
      close(row.delta, row.after - row.before, 1e-9, `${row.key} delta is arithmetic`);
      equal(row.improved && row.worsened, false, 'never both improved and worsened');
    }
    assert(cmp.verdict.length > 20, 'produced a verdict sentence');
  });

  test('a strictly worse plan is described as worse, not spun', () => {
    // Build a comparison where every metric degrades, as it does under a
    // disruption, and check the verdict says so instead of inventing a win.
    const worse = JSON.parse(JSON.stringify({ metrics: planB.metrics, routes: [] }));
    worse.metrics.co2 *= 1.4; worse.metrics.cost *= 1.3; worse.metrics.minutes *= 1.25;
    worse.metrics.km *= 1.2; worse.metrics.onTimeRate *= 0.8; worse.metrics.utilization *= 0.7;
    const cmp = comparePlans(planB, worse);
    equal(cmp.gains.length, 0, 'no gains');
    greater(cmp.losses.length, 0, 'losses reported');
    assert(cmp.verdict.includes('worse on'), 'verdict states the regression plainly');
    assert(!/\bfor \./.test(cmp.verdict), 'no dangling clause');
  });

  test('an identical plan yields no claimed change', () => {
    const cmp = comparePlans(planB, planB);
    equal(cmp.gains.length, 0, 'no gains claimed');
    equal(cmp.losses.length, 0, 'no losses claimed');
    assert(cmp.verdict.includes('unchanged'), 'says so plainly');
  });

  test('route explanations only cite drivers backed by numbers', () => {
    const route = planB.routes.find((r) => r.orderIds.length >= 2);
    const peers = [planEngine.evaluateRoute(ctx.vehiclesById.get(route.vehicleId), route.orderIds, normaliseWeights(PRESETS.fastest), route.startMinutes)];
    const ex = explainRoute(route, { peers, weights, vehicle: ctx.vehiclesById.get(route.vehicleId) });
    assert(ex.summary.length > 10, 'has a summary');
    for (const d of ex.drivers) {
      assert(d.detail && /\d/.test(d.detail), `driver "${d.label}" cites a number`);
      assert(d.sign === '+' || d.sign === '-', 'signed');
    }
  });

  test('planDiff identifies reassignments exactly', () => {
    const diff = planDiff(planA, planB);
    const beforeOwner = new Map();
    for (const r of planA.routes) for (const id of r.orderIds) beforeOwner.set(id, r.vehicleId);
    for (const move of diff.reassigned) {
      equal(beforeOwner.get(move.orderId), move.from, 'source vehicle correct');
      const target = planB.routes.find((r) => r.vehicleId === move.to);
      assert(target.orderIds.includes(move.orderId), 'target vehicle really has it');
    }
  });

  test('carbon attribution sums to the plan total', () => {
    const ex = explainCarbon(planB);
    const attributed = ex.parts.reduce((a, p) => a + p.value, 0);
    // Stop-idle emissions sit outside the per-link attribution, so allow slack.
    close(attributed, ex.total, ex.total * 1e-6 + 1e-9, 'parts sum to the reported total');
    greater(ex.total, 0, 'non-zero');
  });
});

/* ------------------------------------------------------------------ */

suite('Utilities', () => {
  test('pointAtLength walks a polyline correctly', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    close(pointAtLength(pts, 0).x, 0, 1e-9, 'start');
    close(pointAtLength(pts, 5).x, 5, 1e-9, 'midway on the first span');
    close(pointAtLength(pts, 15).y, 5, 1e-9, 'midway on the second span');
    close(pointAtLength(pts, 999).y, 10, 1e-9, 'clamped to the end');
    close(polylineLength(pts), 20, 1e-9, 'total length');
  });

  test('normalize is clamped and degenerate-safe', () => {
    close(normalize(5, [0, 10]), 0.5, 1e-9, 'midpoint');
    close(normalize(-5, [0, 10]), 0, 1e-9, 'clamped low');
    close(normalize(50, [0, 10]), 1, 1e-9, 'clamped high');
    close(normalize(3, [3, 3]), 0, 1e-9, 'zero-width range');
  });

  test('formatters handle edge cases', () => {
    equal(dur(0), '0m', 'zero');
    equal(dur(90), '1h 30m', 'hours and minutes');
    equal(clock(0), '00:00', 'midnight');
    equal(clock(1440 + 90), '01:30', 'wraps past a day');
    equal(num(NaN), '—', 'non-finite');
  });

  test('injected urgent orders are valid and routable', () => {
    const o = makeUrgentOrder(world, depots, 1, rng(5));
    equal(o.priority, 'critical', 'critical');
    assert(o.nodeId >= 0 && o.nodeId < world.nodes.length, 'snapped to the graph');
    greater(o.deadline, o.windowOpen, 'positive window');
  });
});

await run();
