import './harness.mjs';
import { suite, test, run, assert, equal, close, greater, atMost } from './harness.mjs';

import {
  project, unproject, lonLatToWorld, worldToLonLat, haversineKm, bearing,
  decodePolyline, polylineKm, pointAtFraction, boundsOf, metresPerPixel,
} from '../src/render/mercator.js';
import {
  straightLineMatrix, straightLineKm, DETOUR_FACTOR, OsrmService,
  viaCandidates, geometrySignature, overlapRatio,
} from '../src/services/osrm.js';
import { makeProvider, TILE_PROVIDERS, customProvider, DEFAULT_PROVIDER } from '../src/services/tiles.js';
import { NetworkMatrix } from '../src/engines/matrix.js';
import { PlanEngine, scorePlan, referenceFrom, normaliseWeights } from '../src/engines/plan.js';
import { Optimizer, paretoFront, sampleWeights } from '../src/engines/optimizer.js';
import { comparePlans, explainRoute, planDiff, explainCarbon } from '../src/engines/explain.js';
import { edgeEnergy, speedFactor, gradeFactor, unitsToFraction } from '../src/engines/energy.js';
import { intensityAt, co2e, cleanestHour } from '../src/engines/emissions.js';
import { buildTripOptions, evaluateTrip, compareTrips, explainTrip } from '../src/engines/personal.js';
import { emptyWorkspace, importWorkspace, exportWorkspace } from '../src/core/storage.js';
import { PRESETS, VEHICLE_TYPES, SIM, PERSONAL_VEHICLES } from '../src/config.js';
import { rng, normalize } from '../src/util/math.js';
import { dur, clock, num } from '../src/util/format.js';

/* ------------------------------------------------------------------ */
/* Fixtures — a small, deterministic operation around a real city       */
/* ------------------------------------------------------------------ */

const CENTRE = { lon: 78.4867, lat: 17.385 };

function makeFixture({ orderCount = 12, vehicleCount = 4 } = {}) {
  const rand = rng(4242);
  const depots = [
    { id: 'W1', name: 'North DC', lon: CENTRE.lon + 0.04, lat: CENTRE.lat + 0.05, short: 'North DC', openMinutes: 420, closeMinutes: 1260 },
    { id: 'W2', name: 'South Hub', lon: CENTRE.lon - 0.05, lat: CENTRE.lat - 0.04, short: 'South Hub', openMinutes: 420, closeMinutes: 1260 },
  ];
  const types = ['diesel_van', 'ev_van', 'diesel_truck', 'cng_truck', 'ev_truck'];
  const vehicles = Array.from({ length: vehicleCount }, (_, i) => {
    const type = VEHICLE_TYPES[types[i % types.length]];
    const depot = depots[i % depots.length];
    return {
      id: `V${i + 1}`, callsign: `VEH ${i + 1}`, type: type.key, typeLabel: type.label,
      driver: `Driver ${i + 1}`, capacityKg: type.capacityKg, energyType: type.energyType,
      energyLevel: 0.95, depotId: depot.id, lon: depot.lon, lat: depot.lat,
      available: true, status: 'idle', assignedOrders: [], routeId: null,
    };
  });
  const orders = Array.from({ length: orderCount }, (_, i) => ({
    id: `O${i + 1}`, ref: `ORD-${100 + i}`, consignee: `Consignee ${i + 1}`,
    lon: CENTRE.lon + (rand() - 0.5) * 0.18,
    lat: CENTRE.lat + (rand() - 0.5) * 0.16,
    short: `Stop ${i + 1}`, label: `Stop ${i + 1}`,
    priority: i % 7 === 0 ? 'critical' : i % 3 === 0 ? 'high' : 'standard',
    weightKg: Math.round(40 + rand() * 420),
    windowOpen: SIM.dayStartMinutes,
    deadline: SIM.dayStartMinutes + 240 + Math.round(rand() * 360),
    serviceMinutes: 5, status: 'pending',
    assignedVehicle: null, routeId: null, etaMinutes: null,
  }));
  return { depots, vehicles, orders };
}

/**
 * Build the engine stack against a matrix of straight-line estimates. Forcing
 * the OSRM client's transport to fail exercises the documented fallback path,
 * which keeps the suite deterministic and completely offline.
 */
async function buildContext(fixture) {
  const { depots, vehicles, orders } = fixture;
  const ctx = {
    depots,
    depotsById: new Map(depots.map((d) => [d.id, d])),
    vehiclesById: new Map(vehicles.map((v) => [v.id, v])),
    ordersById: new Map(orders.map((o) => [o.id, o])),
  };
  const matrix = new NetworkMatrix();
  const points = [
    ...depots.map((d) => ({ id: d.id, kind: 'depot', lon: d.lon, lat: d.lat })),
    ...orders.map((o) => ({ id: o.id, kind: 'order', lon: o.lon, lat: o.lat })),
  ];
  const offline = new OsrmService({ endpoint: 'http://127.0.0.1:1' });
  offline._fetch = async () => { throw new Error('offline by design'); };
  await matrix.build(points, offline);
  const plan = new PlanEngine(matrix, ctx);
  const optimizer = new Optimizer(plan, ctx);
  return { ctx, matrix, plan, optimizer, ...fixture };
}

const env = await buildContext(makeFixture());

/* ------------------------------------------------------------------ */

suite('Mercator projection', () => {
  test('project and unproject round-trip', () => {
    for (const [lon, lat] of [[0, 0], [78.4867, 17.385], [-122.4, 37.8], [13.4, 52.5], [151.2, -33.87]]) {
      const p = project(lon, lat);
      const back = unproject(p.x, p.y);
      close(back.lon, lon, 1e-9, 'longitude');
      close(back.lat, lat, 1e-9, 'latitude');
    }
  });

  test('world pixels round-trip at every zoom', () => {
    for (let z = 2; z <= 19; z++) {
      const w = lonLatToWorld(78.4867, 17.385, z);
      const back = worldToLonLat(w.x, w.y, z);
      close(back.lon, 78.4867, 1e-7, `lon at z${z}`);
      close(back.lat, 17.385, 1e-7, `lat at z${z}`);
    }
  });

  test('the projection is clamped at the poles instead of diverging', () => {
    const p = project(0, 89.9);
    assert(Number.isFinite(p.y), 'finite near the north pole');
    assert(p.y >= -0.001 && p.y <= 1.001, 'inside the unit square');
  });

  test('haversine matches known distances', () => {
    close(haversineKm(13.377704, 52.516275, 13.413215, 52.521918), 2.4, 0.3, 'Berlin landmarks');
    close(haversineKm(-0.1278, 51.5074, 2.3522, 48.8566), 343.6, 3, 'London to Paris');
    equal(haversineKm(10, 10, 10, 10), 0, 'zero distance');
  });

  test('bearing points the right way', () => {
    close(bearing(0, 0, 0, 1), 0, 1e-6, 'due north');
    close(bearing(0, 0, 1, 0), Math.PI / 2, 1e-3, 'due east');
  });

  test('metres per pixel halves each zoom level', () => {
    close(metresPerPixel(0, 10) / metresPerPixel(0, 11), 2, 1e-9, 'halving');
    close(metresPerPixel(0, 0), 156543, 1, 'equator at zoom 0');
  });

  test('decodePolyline reproduces the specification example', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    equal(pts.length, 3, 'three points');
    close(pts[0].lat, 38.5, 1e-5, 'first lat');
    close(pts[0].lon, -120.2, 1e-5, 'first lon');
    close(pts[2].lat, 43.252, 1e-5, 'last lat');
    close(pts[2].lon, -126.453, 1e-5, 'last lon');
  });

  test('polyline length and interpolation agree', () => {
    const line = [{ lon: 0, lat: 0 }, { lon: 0, lat: 1 }, { lon: 0, lat: 2 }];
    close(polylineKm(line), 222.4, 1, 'two degrees of latitude');
    close(pointAtFraction(line, 0.5).lat, 1, 1e-6, 'midpoint');
    close(pointAtFraction(line, 0).lat, 0, 1e-9, 'start');
    close(pointAtFraction(line, 1).lat, 2, 1e-9, 'end');
    close(pointAtFraction(line, 5).lat, 2, 1e-9, 'clamped past the end');
  });

  test('boundsOf pads and never inverts', () => {
    const b = boundsOf([{ lon: 1, lat: 1 }, { lon: 2, lat: 3 }]);
    assert(b.minLon < 1 && b.maxLon > 2, 'longitude padded outward');
    assert(b.minLat < 1 && b.maxLat > 3, 'latitude padded outward');
    const single = boundsOf([{ lon: 5, lat: 5 }]);
    greater(single.maxLon, single.minLon, 'a single point still yields a box');
    equal(boundsOf([]), null, 'empty input');
  });
});

/* ------------------------------------------------------------------ */

suite('Routing service', () => {
  test('the straight-line fallback is symmetric with a zero diagonal', () => {
    const pts = [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 0, lat: 1 }];
    const { durations, distances } = straightLineMatrix(pts);
    for (let i = 0; i < 3; i++) {
      equal(distances[i][i], 0, 'zero diagonal');
      for (let j = 0; j < 3; j++) {
        close(distances[i][j], distances[j][i], 1e-9, 'symmetric distance');
        close(durations[i][j], durations[j][i], 1e-9, 'symmetric duration');
      }
    }
  });

  test('the fallback applies a detour factor rather than pretending roads are straight', () => {
    const a = { lon: 0, lat: 0 }, b = { lon: 0, lat: 0.1 };
    const crow = haversineKm(a.lon, a.lat, b.lon, b.lat);
    close(straightLineKm([a, b]), crow * DETOUR_FACTOR, 1e-9, 'detour applied');
    greater(DETOUR_FACTOR, 1, 'real roads are longer than the crow flies');
  });

  test('a matrix request with fewer than two points is handled', async () => {
    const m = await new OsrmService().matrix([{ lon: 0, lat: 0 }]);
    equal(m.durations.length, 1, 'trivial matrix');
    equal(m.estimated, false, 'nothing to estimate');
  });

  test('an unreachable service degrades to a labelled estimate, not an exception', async () => {
    const svc = new OsrmService({ endpoint: 'http://127.0.0.1:1' });
    svc._fetch = async () => { throw new Error('connection refused'); };
    const m = await svc.matrix([{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }]);
    equal(m.estimated, true, 'flagged as estimated');
    assert(m.note && m.note.length > 10, 'explains why');
    greater(m.distances[0][1], 0, 'still produces usable numbers');

    const r = await svc.route([{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }]);
    equal(r.estimated, true, 'route flagged as estimated');
    equal(r.points.length, 2, 'falls back to the waypoints themselves');
  });

  test('too many stops for one request is reported, not silently truncated', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ lon: i * 0.01, lat: 10 }));
    const m = await new OsrmService().matrix(many);
    equal(m.estimated, true, 'flagged');
    assert(/\b200\b/.test(m.note), 'names the actual stop count');
    equal(m.durations.length, 200, 'still covers every stop');
  });
});

/* ------------------------------------------------------------------ */

suite('Tile providers', () => {
  test('every provider yields a well-formed tile URL', () => {
    for (const key of Object.keys(TILE_PROVIDERS)) {
      const p = makeProvider(key, { retina: false });
      const url = p.url(10, 512, 340);
      assert(url.startsWith('https://'), `${key} is https`);
      assert(!url.includes('{'), `${key} has no unsubstituted tokens: ${url}`);
      assert(url.includes('/10/'), `${key} includes the zoom`);
      // Every provider must credit its actual source. Satellite imagery is
      // not OpenStreetMap data, so requiring that specific credit everywhere
      // would be asserting a falsehood; what matters is that a credit exists
      // and names a real source.
      assert(p.attribution && p.attribution.length > 8, `${key} carries an attribution`);
      assert(/OpenStreetMap|Esri|CARTO|OpenTopoMap/.test(p.attribution),
        `${key} names its source: ${p.attribution}`);
    }
  });

  test('subdomains rotate so one host is not saturated', () => {
    const p = makeProvider('light', { retina: false });
    const hosts = new Set(Array.from({ length: 6 }, (_, i) => new URL(p.url(10, i, 10)).host));
    greater(hosts.size, 1, 'more than one subdomain used');
  });

  test('the default provider is a hybrid satellite basemap', () => {
    const p = makeProvider(DEFAULT_PROVIDER, { retina: false });
    assert(p.isImagery, 'the default basemap is real imagery');
    assert(p.overlayLayers.length > 0, 'imagery carries a road and label overlay');
    for (const layer of p.overlayLayers) {
      const url = layer.url(10, 512, 340);
      assert(url.startsWith('https://'), 'overlay tiles are https');
      assert(!url.includes('{'), `overlay has no unsubstituted tokens: ${url}`);
    }
  });

  test('a custom template is accepted and substituted', () => {
    const p = customProvider('https://tiles.example.com/{z}/{x}/{y}.png');
    equal(p.url(5, 1, 2), 'https://tiles.example.com/5/1/2.png', 'substituted');
  });
});

/* ------------------------------------------------------------------ */

suite('Energy & emissions', () => {
  test('speed factor is minimised near the optimal speed', () => {
    const atOpt = speedFactor(62);
    greater(speedFactor(12), atOpt, 'stop-and-go costs more');
    greater(speedFactor(110), atOpt, 'high speed costs more');
    close(atOpt, 1, 0.02, 'normalised at the optimum');
  });

  test('climbing costs energy and descending recovers it', () => {
    greater(gradeFactor(0.05, 0.6), 1, 'uphill');
    atMost(gradeFactor(-0.05, 0.6), 1, 'downhill');
    greater(gradeFactor(-0.05, 0.18), gradeFactor(-0.05, 0.62), 'better regen recovers more');
  });

  test('payload raises consumption monotonically', () => {
    const edge = { lengthKm: 10, grade: 0 };
    const empty = edgeEnergy('diesel_truck', edge, 60, 0).units;
    const half = edgeEnergy('diesel_truck', edge, 60, 0.5).units;
    const full = edgeEnergy('diesel_truck', edge, 60, 1).units;
    greater(half, empty, 'half > empty');
    greater(full, half, 'full > half');
  });

  test('grid intensity varies by hour; liquid fuels do not', () => {
    const best = cleanestHour(8, 20);
    greater(intensityAt('bev', 19 * 60), intensityAt('bev', best.hour * 60), 'evening is dirtier');
    equal(intensityAt('diesel', 3 * 60), intensityAt('diesel', 18 * 60), 'diesel is time-invariant');
  });

  test('CO2e scales linearly with energy', () => {
    close(co2e('diesel_van', 10, 600), co2e('diesel_van', 5, 600) * 2, 1e-9, 'linearity');
  });

  test('range fraction is consistent with the type spec', () => {
    const t = VEHICLE_TYPES.diesel_van;
    close(unitsToFraction('diesel_van', (t.consumption / 100) * t.rangeKm), 1, 1e-9, 'a full tank is 100% of range');
  });
});

/* ------------------------------------------------------------------ */

suite('Network matrix', () => {
  const prof = (clockMinutes, type = 'diesel_van', payload = 0.5) =>
    env.matrix.profile({ vehicleType: type, payload, clockMinutes });

  test('is built for every depot and order', () => {
    equal(env.matrix.size, env.depots.length + env.orders.length, 'covers all stops');
    assert(env.matrix.ready, 'ready');
    for (const d of env.depots) greater(env.matrix.idx(d.id), -1, `${d.id} indexed`);
    for (const o of env.orders) greater(env.matrix.idx(o.id), -1, `${o.id} indexed`);
    equal(env.matrix.idx('nope'), -1, 'unknown ids report -1');
  });

  test('rush hour costs more travel time than the small hours', () => {
    const quiet = env.matrix.leg(0, 3, prof(3 * 60));
    const rush = env.matrix.leg(0, 3, prof(18 * 60));
    greater(rush.minutes, quiet.minutes, 'rush hour is slower');
    close(rush.km, quiet.km, 1e-9, 'the road is the same length either way');
  });

  test('a traffic multiplier slows every leg', () => {
    const before = env.matrix.leg(0, 4, prof(10 * 60)).minutes;
    env.matrix.setTrafficMultiplier(1.8);
    const after = env.matrix.leg(0, 4, prof(10 * 60)).minutes;
    env.matrix.setTrafficMultiplier(1);
    greater(after, before, 'slower under heavier traffic');
  });

  test('congestion costs energy as well as time', () => {
    const free = env.matrix.leg(0, 5, prof(10 * 60, 'diesel_truck', 0.8));
    env.matrix.setTrafficMultiplier(2.2);
    const jam = env.matrix.leg(0, 5, prof(10 * 60, 'diesel_truck', 0.8));
    env.matrix.setTrafficMultiplier(1);
    greater(jam.units, free.units, 'more fuel burnt in traffic');
    greater(jam.co2, free.co2, 'more CO2e emitted in traffic');
  });

  test('an incident is local, not global', () => {
    const near = env.matrix.points[2];
    const farIdx = env.matrix.points.findIndex((pt) => haversineKm(pt.lon, pt.lat, near.lon, near.lat) > 8);
    const baselineNear = env.matrix.leg(2, 3, prof(10 * 60)).minutes;
    const baselineFar = farIdx > 0 ? env.matrix.leg(farIdx, 0, prof(10 * 60)).minutes : null;
    env.matrix.addIncident({ id: 'X', lon: near.lon, lat: near.lat, radiusKm: 2, severity: 1.4 });
    greater(env.matrix.leg(2, 3, prof(10 * 60)).minutes, baselineNear, 'the nearby leg slows');
    if (baselineFar != null) {
      close(env.matrix.leg(farIdx, 0, prof(10 * 60)).minutes, baselineFar, 1e-9, 'a distant leg is untouched');
    }
    env.matrix.clearIncidents();
  });

  test('a closed link is impassable in both directions', () => {
    assert(env.matrix.leg(0, 2, prof(600)), 'open before');
    env.matrix.closeLink(env.matrix.points[0].id, env.matrix.points[2].id);
    equal(env.matrix.leg(0, 2, prof(600)), null, 'closed forward');
    equal(env.matrix.leg(2, 0, prof(600)), null, 'closed backward');
    env.matrix.clearClosures();
    assert(env.matrix.leg(0, 2, prof(600)), 'open again');
  });

  test('a leg to itself costs nothing', () => {
    const leg = env.matrix.leg(3, 3, prof(600));
    equal(leg.km, 0, 'no distance');
    equal(leg.co2, 0, 'no emissions');
  });
});

/* ------------------------------------------------------------------ */

suite('Plan & constraints', () => {
  const weights = normaliseWeights(PRESETS.balanced);

  test('an empty route is feasible and costs nothing', () => {
    const r = env.plan.evaluateRoute(env.vehicles[0], [], weights);
    equal(r.km, 0, 'no distance');
    assert(r.empty, 'flagged empty');
    assert(r.feasible, 'feasible');
  });

  test('a route visits every stop and returns to its depot', () => {
    const ids = env.orders.slice(0, 4).map((o) => o.id);
    const r = env.plan.evaluateRoute(env.vehicles[0], ids, weights);
    equal(r.stops.length, 4, 'stop count');
    equal(r.legs.length, 5, 'four outbound legs plus the return');
    equal(r.legs[r.legs.length - 1].toIdx, env.matrix.idx(env.vehicles[0].depotId), 'final leg ends at the depot');
    greater(r.km, 0, 'positive distance');
  });

  test('capacity overload is a hard violation', () => {
    const small = env.vehicles.find((v) => VEHICLE_TYPES[v.type].capacityKg < 1500);
    assert(small, 'the fixture includes a small vehicle');
    const heavy = [...env.orders].sort((a, b) => b.weightKg - a.weightKg).slice(0, 8).map((o) => o.id);
    const r = env.plan.evaluateRoute(small, heavy, weights);
    assert(!r.feasible, 'infeasible');
    assert(r.violations.some((v) => v.code === 'capacity' && v.severity === 'hard'), 'capacity violation raised');
  });

  test('payload declines along the route and is charged leg by leg', () => {
    const ids = env.orders.slice(0, 4).map((o) => o.id);
    const r = env.plan.evaluateRoute(env.vehicles[2], ids, weights);
    for (let i = 1; i < r.stops.length; i++) {
      atMost(r.stops[i].loadBeforeKg, r.stops[i - 1].loadBeforeKg, 'load decreases');
    }
  });

  test('visit order changes emissions, not just time', () => {
    const ids = env.orders.slice(0, 5).map((o) => o.id);
    const forward = env.plan.evaluateRoute(env.vehicles[2], ids, weights);
    const reverse = env.plan.evaluateRoute(env.vehicles[2], [...ids].reverse(), weights);
    assert(Math.abs(forward.co2 - reverse.co2) > 1e-9,
      'reversing the sequence changes CO2e, because payload is carried differently');
  });

  test('stop times are monotonic and respect the window', () => {
    const ids = env.orders.slice(1, 6).map((o) => o.id);
    const r = env.plan.evaluateRoute(env.vehicles[2], ids, weights);
    for (let i = 0; i < r.stops.length; i++) {
      const s = r.stops[i];
      greater(s.departure, s.arrival - 1e-9, 'departure after arrival');
      if (i > 0) greater(s.arrival, r.stops[i - 1].departure - 1e-9, 'sequential');
      assert(s.serviceStart >= s.windowOpen - 1e-6, 'never serviced before the window opens');
    }
    greater(r.endMinutes, r.startMinutes, 'the route takes time');
  });

  test('lateness is detected against the deadline', () => {
    const big = env.vehicles.find((v) => VEHICLE_TYPES[v.type].capacityKg > 4000) || env.vehicles[2];
    const ids = [...env.orders].sort((a, b) => a.deadline - b.deadline).slice(0, 6).map((o) => o.id);
    const r = env.plan.evaluateRoute(big, ids, weights, SIM.dayEndMinutes - 20);
    greater(r.lateOrders, 0, 'starting minutes before close must run late');
    assert(r.violations.some((v) => v.code === 'deadline'), 'deadline violation reported');
  });

  test('an unavailable vehicle cannot carry a route', () => {
    const r = env.plan.evaluateRoute({ ...env.vehicles[1], available: false }, [env.orders[0].id], weights);
    assert(!r.feasible, 'infeasible');
    assert(r.violations.some((x) => x.code === 'vehicle_unavailable'), 'availability violation');
  });

  test('a vehicle with no depot cannot be routed', () => {
    const v = { ...env.vehicles[0], id: 'VX', depotId: null };
    env.ctx.vehiclesById.set('VX', v);
    const r = env.plan.evaluateRoute(v, [env.orders[0].id], weights);
    assert(!r.feasible, 'infeasible');
    assert(r.violations.some((x) => x.code === 'no_depot'), 'reports the missing depot');
    env.ctx.vehiclesById.delete('VX');
  });

  test('plan aggregation sums its routes exactly', () => {
    const assignment = new Map([
      [env.vehicles[0].id, env.orders.slice(0, 2).map((o) => o.id)],
      [env.vehicles[1].id, env.orders.slice(2, 4).map((o) => o.id)],
    ]);
    const plan = env.plan.buildPlan(assignment, weights);
    close(plan.metrics.km, plan.routes.reduce((a, r) => a + r.km, 0), 1e-9, 'km');
    close(plan.metrics.co2, plan.routes.reduce((a, r) => a + r.co2, 0), 1e-9, 'CO2e');
    equal(plan.metrics.stops, 4, 'stops');
    equal(plan.metrics.unserved, env.orders.length - 4, 'unserved remainder');
  });

  test('the objective function responds to its weights', () => {
    const plan = env.plan.buildPlan(new Map([[env.vehicles[0].id, env.orders.slice(0, 3).map((o) => o.id)]]), weights);
    const ref = referenceFrom(plan);
    const timeOnly = scorePlan(plan, normaliseWeights({ time: 1 }), ref);
    const co2Only = scorePlan(plan, normaliseWeights({ emissions: 1 }), ref);
    greater(timeOnly.terms.time, 0, 'time term active');
    equal(co2Only.terms.time, 0, 'time term zeroed when unweighted');
    greater(co2Only.terms.emissions, 0, 'emissions term active');
  });

  test('weights are normalised and degenerate input is handled', () => {
    const w = normaliseWeights({ time: 2, cost: 2 });
    close(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-9, 'sums to 1');
    close(normaliseWeights({}).time, 0.2, 1e-9, 'degenerate falls back to balanced');
  });
});

/* ------------------------------------------------------------------ */

suite('Optimizer', () => {
  const weights = normaliseWeights(PRESETS.balanced);
  let baseline, optimised;

  test('builds a naive baseline covering the order book', () => {
    baseline = env.optimizer.buildBaseline(env.vehicles, env.orders, weights);
    greater(baseline.metrics.km, 0, 'baseline has distance');
    greater(baseline.metrics.stops, 0, 'baseline serves orders');
  });

  test('optimisation improves on the baseline objective', async () => {
    const result = await env.optimizer.optimize({
      vehicles: env.vehicles, orders: env.orders, weights, iterations: 2200, seed: 3, baseline,
    });
    assert(result, 'produced a result');
    optimised = result.plan;
    atMost(optimised.score, baseline.score, 'score improved or matched');
    greater(result.stats.routeEvaluations, 0, 'evaluated routes');
    equal(result.stats.matrixSize, env.matrix.size, 'reports the matrix it solved against');
  });

  test('the published plan respects every hard constraint', () => {
    equal(optimised.metrics.hardViolations, 0, 'no hard violations');
    for (const r of optimised.routes) {
      atMost(r.capacityUsedKg, VEHICLE_TYPES[r.vehicleType].capacityKg, `capacity on ${r.id}`);
      const v = env.ctx.vehiclesById.get(r.vehicleId);
      atMost(r.energyFraction, Math.max(0, v.energyLevel - 0.10) + 1e-9, `range reserve on ${r.id}`);
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
    equal(seen.size + optimised.unserved.length, env.orders.length, 'every order accounted for');
  });

  test('changing the weights changes the plan', async () => {
    const green = await env.optimizer.optimize({
      vehicles: env.vehicles, orders: env.orders,
      weights: normaliseWeights(PRESETS.greenest), iterations: 2200, seed: 5, baseline,
    });
    const fast = await env.optimizer.optimize({
      vehicles: env.vehicles, orders: env.orders,
      weights: normaliseWeights(PRESETS.fastest), iterations: 2200, seed: 5, baseline,
    });
    assert(green && fast, 'both plans produced');
    assert(green.plan.metrics.co2 !== fast.plan.metrics.co2 || green.plan.metrics.minutes !== fast.plan.metrics.minutes,
      'different objectives produce materially different plans');
    atMost(green.plan.metrics.co2, fast.plan.metrics.co2 * 1.02, 'the green plan is not dirtier than the fast one');
  });

  test('an empty fleet is handled without throwing', async () => {
    const none = env.vehicles.map((v) => ({ ...v, available: false }));
    const ctx = { ...env.ctx, vehiclesById: new Map(none.map((v) => [v.id, v])) };
    const opt = new Optimizer(new PlanEngine(env.matrix, ctx), ctx);
    const result = await opt.optimize({ vehicles: none, orders: env.orders, weights, iterations: 200 });
    assert(result, 'returned a result rather than throwing');
    equal(result.plan.metrics.unserved, env.orders.length, 'everything unserved');
    equal(result.plan.metrics.vehiclesUsed, 0, 'no vehicles used');
  });

  test('an empty order book produces an empty but valid plan', async () => {
    const result = await env.optimizer.optimize({ vehicles: env.vehicles, orders: [], weights, iterations: 200 });
    assert(result, 'returned a result');
    equal(result.plan.metrics.stops, 0, 'no stops');
    equal(result.plan.metrics.km, 0, 'no distance');
    assert(result.plan.metrics.feasible, 'trivially feasible');
  });

  test('disabling a vehicle moves its work elsewhere', async () => {
    const victim = optimised.routes.find((r) => r.orderIds.length >= 2);
    assert(victim, 'found a loaded route');
    const modified = env.vehicles.map((v) => (v.id === victim.vehicleId ? { ...v, available: false } : v));
    const ctx = { ...env.ctx, vehiclesById: new Map(modified.map((v) => [v.id, v])) };
    const opt = new Optimizer(new PlanEngine(env.matrix, ctx), ctx);
    const result = await opt.optimize({ vehicles: modified, orders: env.orders, weights, iterations: 2200, seed: 9 });
    const still = result.plan.routes.find((r) => r.vehicleId === victim.vehicleId);
    equal(still ? still.orderIds.length : 0, 0, 'the disabled vehicle carries nothing');
  });

  test('pareto front keeps only non-dominated points', () => {
    const items = [{ c: 1, t: 5 }, { c: 2, t: 4 }, { c: 3, t: 3 }, { c: 4, t: 9 }];
    const front = paretoFront(items, [(i) => i.c, (i) => i.t]);
    assert(!front.includes(items[3]), 'the dominated point is excluded');
    equal(front.length, 3, 'the trade-off curve is retained');
  });

  test('weight sampling covers the simplex and anchors on the presets', () => {
    const ws = sampleWeights(18);
    equal(ws.length, 18, 'requested count');
    for (const w of ws) close(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-9, 'normalised');
    assert(ws.some((w) => Math.abs(w.emissions - normaliseWeights(PRESETS.greenest).emissions) < 1e-9),
      'presets included as anchors');
  });
});

/* ------------------------------------------------------------------ */

suite('Explanation layer', () => {
  const weights = normaliseWeights(PRESETS.balanced);
  let planA, planB;

  test('comparePlans reports real, signed differences', async () => {
    planA = env.optimizer.buildBaseline(env.vehicles, env.orders, weights);
    const r = await env.optimizer.optimize({
      vehicles: env.vehicles, orders: env.orders, weights, iterations: 1800, seed: 11, baseline: planA,
    });
    planB = r.plan;
    const cmp = comparePlans(planA, planB);
    for (const row of cmp.rows) {
      close(row.delta, row.after - row.before, 1e-9, `${row.key} delta is arithmetic`);
      equal(row.improved && row.worsened, false, 'never both improved and worsened');
      assert(typeof row.short === 'string' && row.short.length > 0, `${row.key} has a prose form`);
    }
    greater(cmp.verdict.length, 20, 'produced a verdict sentence');
  });

  test('an identical plan yields no claimed change', () => {
    const cmp = comparePlans(planB, planB);
    equal(cmp.gains.length, 0, 'no gains claimed');
    equal(cmp.losses.length, 0, 'no losses claimed');
    assert(cmp.verdict.includes('unchanged'), 'says so plainly');
  });

  test('a strictly worse plan is described as worse, not spun', () => {
    const worse = { metrics: { ...planB.metrics }, routes: [] };
    worse.metrics.co2 *= 1.4; worse.metrics.cost *= 1.3; worse.metrics.minutes *= 1.25;
    worse.metrics.km *= 1.2; worse.metrics.onTimeRate *= 0.8; worse.metrics.utilization *= 0.7;
    const cmp = comparePlans(planB, worse);
    equal(cmp.gains.length, 0, 'no gains');
    greater(cmp.losses.length, 0, 'losses reported');
    assert(cmp.verdict.includes('worse on'), 'the verdict states the regression plainly');
    assert(!/\bfor \./.test(cmp.verdict), 'no dangling clause');
  });

  test('route explanations only cite drivers backed by numbers', () => {
    const route = planB.routes.find((r) => r.orderIds.length >= 2);
    assert(route, 'found a loaded route');
    const vehicle = env.ctx.vehiclesById.get(route.vehicleId);
    const peers = [env.plan.evaluateRoute(vehicle, [...route.orderIds].reverse(), weights, route.startMinutes)];
    const ex = explainRoute(route, { peers, weights, vehicle });
    greater(ex.summary.length, 10, 'has a summary');
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
      assert(target.orderIds.includes(move.orderId), 'the target vehicle really has it');
    }
  });

  test('carbon attribution sums to the plan total', () => {
    const ex = explainCarbon(planB);
    const attributed = ex.parts.reduce((a, p) => a + p.value, 0);
    close(attributed, ex.total, ex.total * 1e-6 + 1e-9, 'parts sum to the reported total');
    greater(ex.total, 0, 'non-zero');
  });
});

/* ------------------------------------------------------------------ */

suite('Workspace storage', () => {
  test('an empty workspace has the shape the store expects', () => {
    const ws = emptyWorkspace();
    equal(Array.isArray(ws.depots), true, 'depots array');
    equal(Array.isArray(ws.vehicles), true, 'vehicles array');
    equal(Array.isArray(ws.orders), true, 'orders array');
    equal(ws.onboarded, false, 'not yet onboarded');
    assert(ws.settings && ws.settings.tileProvider, 'default settings present');
  });

  test('export and import round-trip', () => {
    const ws = emptyWorkspace();
    ws.depots.push({ id: 'W1', name: 'Test', lon: 1, lat: 2 });
    ws.account = { name: 'Ops', org: 'Test Co' };
    const restored = importWorkspace(exportWorkspace(ws));
    equal(restored.depots.length, 1, 'depot survived');
    equal(restored.depots[0].name, 'Test', 'field survived');
    equal(restored.account.name, 'Ops', 'account survived');
  });

  test('a foreign schema is rejected rather than silently mangled', () => {
    let threw = false;
    try { importWorkspace(JSON.stringify({ schema: 99, depots: [] })); } catch { threw = true; }
    assert(threw, 'rejects an unknown schema');
    let threw2 = false;
    try { importWorkspace('"just a string"'); } catch { threw2 = true; }
    assert(threw2, 'rejects a non-object');
  });
});

/* ------------------------------------------------------------------ */

/**
 * Minimal polyline6 encoder, for building OSRM-shaped fixtures.
 *
 * The application only ever decodes, so this lives with the tests rather than
 * in the source: a round-trip through the real decoder is what makes these
 * fixtures worth anything.
 */
function encodePolyline6(points) {
  const chunk = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let out = '';
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return out + String.fromCharCode(n + 63);
  };
  let lat = 0, lon = 0, out = '';
  for (const p of points) {
    const la = Math.round(p.lat * 1e6);
    const lo = Math.round(p.lon * 1e6);
    out += chunk(la - lat) + chunk(lo - lon);
    lat = la; lon = lo;
  }
  return out;
}

suite('Finding different roads', () => {
  const A = { lon: 87.5089, lat: 21.6270 };   // Digha
  const B = { lon: 87.3119, lat: 22.3149 };   // inland, ~80 km north

  /** A polyline along the direct line, nudged sideways by `off` degrees. */
  const line = (off, n = 60) => Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { lon: A.lon + (B.lon - A.lon) * t + off, lat: A.lat + (B.lat - A.lat) * t };
  });

  test('via candidates sit off the direct line, on both sides of it', () => {
    const vias = viaCandidates(A, B, 6);
    equal(vias.length, 6, 'one candidate per probe');
    const side = (v) => Math.sign((B.lon - A.lon) * (v.lat - A.lat) - (B.lat - A.lat) * (v.lon - A.lon));
    assert(vias.some((v) => side(v) > 0), 'some candidates lie to one side');
    assert(vias.some((v) => side(v) < 0), 'and some to the other');
    for (const v of vias) {
      assert(Number.isFinite(v.lon) && Number.isFinite(v.lat), 'finite coordinates');
      assert(Math.abs(v.lat) <= 85, 'latitude stays projectable');
      greater(haversineKm(A.lon, A.lat, v.lon, v.lat), 1, 'and none collapses onto the start');
    }
  });

  test('two points in the same place yield no candidates rather than NaN', () => {
    equal(viaCandidates(A, { ...A }, 6).length, 0, 'no probes for a zero-length journey');
  });

  test('the same road is recognised however densely it is drawn', () => {
    const coarse = geometrySignature(line(0, 30));
    const dense = geometrySignature(line(0, 400));
    // Not 1.0, and it never will be: a line crossing a square grid at an angle
    // clips different corner cells depending on where its vertices fall. What
    // matters is the margin over the 0.8 same-road threshold, and over what a
    // genuinely different road scores in the next test.
    greater(overlapRatio(coarse, dense), 0.9, 'same ground covered');
  });

  test('a road a few streets over is a different road', () => {
    const here = geometrySignature(line(0));
    const there = geometrySignature(line(0.05)); // ~5 km to the side
    atMost(overlapRatio(here, there), 0.05, 'barely any shared ground');
  });

  /** An OSRM-shaped response for a polyline, at a given speed. */
  function osrmRoute(points, kmh) {
    const km = points.reduce((a, p, i) => (i ? a + haversineKm(points[i - 1].lon, points[i - 1].lat, p.lon, p.lat) : 0), 0);
    return { geometry: encodePolyline6(points), distance: km * 1000, duration: (km / kmh) * 3600 };
  }

  test('a router that offers one road is probed until it offers several', async () => {
    const svc = new OsrmService();
    let directCalls = 0;
    let probeCalls = 0;
    svc._fetch = async (url) => {
      if (url.includes('alternatives=')) {
        directCalls++;
        return { code: 'Ok', routes: [osrmRoute(line(0), 55)] };
      }
      // A via point produces a road offset toward it — a different corridor.
      probeCalls++;
      const off = 0.04 * (probeCalls % 2 === 0 ? 1 : -1) * Math.ceil(probeCalls / 2);
      return { code: 'Ok', routes: [osrmRoute(line(off), 48)] };
    };

    const routes = await svc.routeAlternatives([A, B]);
    equal(directCalls, 1, 'the router is asked for alternatives first');
    greater(probeCalls, 0, 'and probed when it returns only one road');
    greater(routes.length, 1, 'more than one road is found');
    for (const r of routes) assert(!r.estimated, 'every road is real routed geometry');
    // The fastest road must come first; the options layer relies on it.
    for (let i = 1; i < routes.length; i++) {
      assert(routes[i].minutes >= routes[i - 1].minutes - 1e-9, 'sorted by duration');
    }
  });

  test('probing stops once enough distinct roads are in hand', async () => {
    const svc = new OsrmService();
    let calls = 0;
    svc._fetch = async (url) => {
      calls++;
      if (url.includes('alternatives=')) {
        return { code: 'Ok', routes: [0, 0.05, -0.05, 0.1].map((o) => osrmRoute(line(o), 50)) };
      }
      return { code: 'Ok', routes: [osrmRoute(line(0.2 * calls), 50)] };
    };
    await svc.routeAlternatives([A, B], { want: 4 });
    equal(calls, 1, 'a generous router is not probed at all');
  });

  test('roads that are really the same road are not offered twice', async () => {
    const svc = new OsrmService();
    svc._fetch = async () => ({
      code: 'Ok',
      // The same road three times, drawn at different resolutions.
      routes: [osrmRoute(line(0, 40), 50), osrmRoute(line(0, 90), 50), osrmRoute(line(0, 200), 50)],
    });
    const routes = await svc.routeAlternatives([A, B], { probes: 0 });
    equal(routes.length, 1, 'de-duplicated to the one road it is');
  });

  test('an absurd detour is not presented as a choice', async () => {
    const svc = new OsrmService();
    svc._fetch = async (url) => {
      if (url.includes('alternatives=')) return { code: 'Ok', routes: [osrmRoute(line(0), 60)] };
      // Every probe finds a distinct road that takes four times as long.
      return { code: 'Ok', routes: [osrmRoute(line(0.3), 15)] };
    };
    const routes = await svc.routeAlternatives([A, B]);
    const fastest = routes[0].minutes;
    for (const r of routes) atMost(r.minutes / fastest, 1.9, 'nothing wildly slower survives');
  });

  test('a probe storm against a failing service stops rather than retrying', async () => {
    const svc = new OsrmService();
    let probeCalls = 0;
    svc._fetch = async (url) => {
      if (url.includes('alternatives=')) return { code: 'Ok', routes: [osrmRoute(line(0), 50)] };
      probeCalls++;
      throw new Error('rate limited');
    };
    const routes = await svc.routeAlternatives([A, B]);
    equal(routes.length, 1, 'the one road it did find is still returned');
    atMost(probeCalls, 3, 'and probing stops after the first failed batch');
  });

  test('an unreachable router still degrades to a labelled estimate', async () => {
    const svc = new OsrmService();
    svc._fetch = async () => { throw new Error('connection refused'); };
    const routes = await svc.routeAlternatives([A, B]);
    equal(routes.length, 1, 'one route');
    assert(routes[0].estimated, 'flagged as an estimate, not passed off as a road');
  });
});

suite('Personal trip engine', () => {
  /**
   * Three plausible roads between the same two points: an arterial, a short
   * congested route through town, and a longer, faster ring road.
   */
  const ALTS = [
    { id: 'arterial', km: 14.2, minutes: 24, points: [{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }], estimated: false },
    { id: 'town', km: 12.1, minutes: 31, points: [{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }], estimated: false },
    { id: 'ring', km: 26.0, minutes: 21, points: [{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }], estimated: false },
  ];

  test('a bicycle emits nothing and costs nothing to run', () => {
    const t = evaluateTrip(ALTS[0], { vehicleKey: 'BIKE', departMinutes: 540 });
    close(t.co2, 0, 1e-12, 'no emissions');
    close(t.cost, 0, 1e-12, 'no running cost');
    greater(t.minutes, ALTS[0].minutes, 'slower than the car the routing service modelled');
  });

  test('the fastest road is not automatically the greenest', () => {
    const set = buildTripOptions(ALTS, { vehicleKey: 'CAR', departMinutes: 540 });
    const fastest = set.options.find((o) => o.key === 'FASTEST').trip;
    const greenest = set.options.find((o) => o.key === 'GREENEST').trip;
    equal(fastest.id, 'ring', 'fastest picks the quickest road');
    for (const t of set.trips) assert(greenest.co2 <= t.co2 + 1e-9, 'the green option really is the lowest-emission one');
    assert(greenest.id !== fastest.id, 'and on this network it is not the fast one');
    // The shortest road is not the cleanest either: crawling through town
    // burns more per kilometre than the arterial does.
    const shortest = set.trips.reduce((a, b) => (a.km <= b.km ? a : b));
    greater(shortest.co2, greenest.co2, 'shortest is not the same as cleanest');
  });

  test('one road in means one road out, honestly labelled', () => {
    const set = buildTripOptions([ALTS[0]], { vehicleKey: 'CAR', departMinutes: 540 });
    equal(set.roadsFound, 1, 'only one road exists');
    equal(set.chosenRoads, 1, 'so only one road can be chosen');
    equal(set.options.length, 4, 'all four choices are still offered');
    for (const o of set.options) equal(o.trip.id, 'arterial', `${o.key} resolves to the only road`);
    const shared = set.options.filter((o) => o.sharedWith);
    equal(shared.length, 3, 'three of them are flagged as the same road as another');
    const drivers = explainTrip(set.options[0], set);
    assert(drivers.some((d) => /one sensible road/i.test(d.label)), 'and the explanation says so');
  });

  test('many roads found but one winner is reported as exactly that', () => {
    // The shortest road is also the quickest here, so it wins on time, cost
    // and carbon at once and all four options land on it. Claiming "one
    // sensible road" would be false: three others were found and compared.
    const roads = [
      { id: 'best', km: 12.0, minutes: 20, points: [], estimated: false },
      { id: 'b', km: 14.5, minutes: 26, points: [], estimated: false },
      { id: 'c', km: 17.2, minutes: 29, points: [], estimated: false },
      { id: 'd', km: 21.0, minutes: 31, points: [], estimated: false },
    ];
    const set = buildTripOptions(roads, { vehicleKey: 'CAR', departMinutes: 540 });
    equal(set.roadsFound, 4, 'four roads were compared');
    equal(set.chosenRoads, 1, 'and one of them wins on every measure');
    for (const o of set.options) equal(o.trip.id, 'best', `${o.key} picks the winner`);

    const drivers = explainTrip(set.options[0], set);
    const claim = drivers.find((d) => /road/i.test(d.label));
    assert(claim, 'the explanation addresses the roads');
    assert(/4 different roads/.test(claim.label), `it reports all four: ${claim.label}`);
    assert(!/there is one sensible road/i.test(claim.label),
      'and never claims only one road existed');
  });

  test('an electric car is charged the grid intensity of the hour it travels', () => {
    const noon = evaluateTrip(ALTS[0], { vehicleKey: 'EV', departMinutes: 12 * 60 });
    const evening = evaluateTrip(ALTS[0], { vehicleKey: 'EV', departMinutes: 19 * 60 });
    close(noon.units, evening.units, 1e-9, 'the same energy either way');
    greater(evening.co2, noon.co2, 'but the evening grid is dirtier');
  });

  test('a custom consumption figure overrides the archetype', () => {
    const stock = evaluateTrip(ALTS[0], { vehicleKey: 'CAR', departMinutes: 540 });
    const thirsty = evaluateTrip(ALTS[0], { vehicleKey: 'CAR', departMinutes: 540, consumption: 14.8 });
    close(thirsty.units / stock.units, 14.8 / PERSONAL_VEHICLES.CAR.consumption, 1e-9, 'scales linearly');
  });

  test('comparison prose never dangles when nothing is worse', () => {
    const a = evaluateTrip(ALTS[1], { vehicleKey: 'CAR', departMinutes: 540 });
    const b = evaluateTrip(ALTS[2], { vehicleKey: 'CAR', departMinutes: 540 });
    const text = compareTrips(a, b, { labelA: 'This route', labelB: 'the fastest route' });
    assert(typeof text === 'string' && text.length > 20, 'produced prose');
    assert(!/ on \.| for \./.test(text), `no dangling clause: ${text}`);
    equal(compareTrips(a, a), null, 'a route is not compared with itself');
  });

  test('an unreachable routing service is reported, not disguised', () => {
    const set = buildTripOptions(
      [{ id: 'est', km: 9, minutes: 17, points: [], estimated: true }],
      { vehicleKey: 'CAR', departMinutes: 540 },
    );
    assert(set.estimated, 'the set is flagged as estimated');
    const drivers = explainTrip(set.options[0], set);
    assert(drivers.some((d) => /straight-line estimate/i.test(d.label)), 'and said so in the explanation');
  });
});

suite('Utilities', () => {
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
});

await run();
