/**
 * STATE / EVENT ENGINE
 *
 * The single owner of application state. Views read from it and call its
 * methods; they never mutate it. Every meaningful change emits on the bus.
 *
 * It also owns the simulation clock: vehicles advance along their assigned
 * route polylines, stops complete, energy drains, and the traffic field is
 * recomputed as the modelled day progresses.
 */

import { APP, SIM, PRESETS, LAYERS, VEHICLE_TYPES, SEED, OPTIMIZER } from '../config.js';
import { EV, emit } from './bus.js';
import { buildWorld, worldStats } from '../data/world.js';
import { buildDataset, makeUrgentOrder } from '../data/seed.js';
import { TrafficEngine, corridorName } from '../engines/traffic.js';
import { RouteEngine, normaliseWeights } from '../engines/route.js';
import { PlanEngine } from '../engines/plan.js';
import { Optimizer } from '../engines/optimizer.js';
import { explainReplan, explainRoute, comparePlans } from '../engines/explain.js';
import { unitsToFraction } from '../engines/energy.js';
import { clamp, pointAtLength, polylineLength, rng } from '../util/math.js';
import { clock, clockSeconds, dur, kg, num, pct } from '../util/format.js';
import { loadPrefs, savePrefs } from './storage.js';

export class Store {
  constructor() {
    this.ready = false;
    this.error = null;

    this.view = 'map';              // map | frontier | carbon | compare | simulation
    this.selection = { kind: null, id: null };
    this.hover = { kind: null, id: null };
    this.layers = Object.fromEntries(LAYERS.map((l) => [l.key, l.on]));

    this.weights = { ...PRESETS.balanced };
    this.preset = 'balanced';

    this.plan = null;
    this.baseline = null;
    this.previousPlan = null;
    this.lastExplanation = null;
    this.optimizeHistory = [];
    this.optimizeStats = null;
    this.optimizing = false;
    this.optimizeProgress = null;

    this.pareto = null;
    this.alternativesCache = new Map();

    this.clockMinutes = SIM.dayStartMinutes;
    this.speedMultiplier = 0;       // starts paused; the intro starts it
    this.playing = false;

    this.scenario = this.defaultScenario();
    this.pendingScenario = this.defaultScenario();
    this.scenarioComparison = null;

    this.alerts = [];
    this.log = [];
    this.logCap = 240;
    this.alertCap = 60;

    this.counters = { urgent: 0 };
  }

  defaultScenario() {
    return {
      trafficLevel: 'normal',       // key into the traffic presets below
      trafficMultiplier: 1,
      disabledVehicles: [],
      closedEdges: [],
      deadlineShifts: {},           // orderId -> minutes delta
      injectedOrders: [],
      incidents: [],
    };
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async init() {
    try {
      this.world = buildWorld(SEED);
      this.worldStats = worldStats(this.world);

      const { depots, vehicles, orders } = buildDataset(this.world, SEED);
      this.depots = depots;
      this.vehicles = vehicles;
      this.orders = orders;
      this.reindex();

      this.traffic = new TrafficEngine(this.world);
      this.traffic.update(this.clockMinutes);
      this.router = new RouteEngine(this.world, this.traffic);
      this.ctx = {
        depots: this.depots,
        depotsById: this.depotsById,
        ordersById: this.ordersById,
        vehiclesById: this.vehiclesById,
      };
      this.planEngine = new PlanEngine(this.world, this.router, this.ctx);
      this.optimizer = new Optimizer(this.planEngine, this.ctx);

      const prefs = loadPrefs();
      if (prefs?.weights) { this.weights = normaliseWeights(prefs.weights); this.preset = prefs.preset || 'custom'; }
      if (prefs?.layers) Object.assign(this.layers, prefs.layers);

      emit(EV.WORLD_BUILT, { world: this.world, stats: this.worldStats });
      this.logEvent('system', `World built — ${num(this.worldStats.nodes)} nodes, ${num(this.worldStats.edges)} links, ${num(this.worldStats.totalKm, 0)} km of road`);
      this.logEvent('system', `Fleet online — ${this.vehicles.length} vehicles, ${this.orders.length} orders booked`);

      // Build the naive baseline immediately so the command centre has real
      // numbers on screen before the optimiser has ever run.
      this.baseline = this.optimizer.buildBaseline(this.vehicles, this.openOrders(), this.weights, this.clockMinutes);
      this.applyPlan(this.baseline, { silent: true, isBaseline: true });

      this.ready = true;
      emit(EV.READY, this);
      return this;
    } catch (err) {
      this.error = err;
      console.error('[store] init failed', err);
      emit(EV.OPT_FAILED, { message: err.message, fatal: true });
      throw err;
    }
  }

  reindex() {
    this.depotsById = new Map(this.depots.map((d) => [d.id, d]));
    this.vehiclesById = new Map(this.vehicles.map((v) => [v.id, v]));
    this.ordersById = new Map(this.orders.map((o) => [o.id, o]));
    if (this.ctx) {
      this.ctx.depotsById = this.depotsById;
      this.ctx.vehiclesById = this.vehiclesById;
      this.ctx.ordersById = this.ordersById;
      this.ctx.depots = this.depots;
    }
  }

  openOrders() {
    return this.orders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
  }

  /* ---------------------------------------------------------------- */
  /* Plans                                                             */
  /* ---------------------------------------------------------------- */

  applyPlan(plan, { silent = false, isBaseline = false, trigger = null } = {}) {
    this.previousPlan = isBaseline ? null : this.plan;
    this.plan = plan;
    this.routesById = new Map(plan.routes.map((r) => [r.id, r]));
    this.routeByVehicle = new Map(plan.routes.map((r) => [r.vehicleId, r]));
    this.alternativesCache.clear();

    // Reflect the plan onto the entities the UI reads.
    for (const v of this.vehicles) {
      const route = this.routeByVehicle.get(v.id);
      v.routeId = route && route.orderIds.length ? route.id : null;
      v.assignedOrders = route ? [...route.orderIds] : [];
      if (!v.available) v.status = 'disabled';
      else if (!v.routeId) v.status = 'idle';
      else if (v.status === 'idle' || v.status === 'disabled') v.status = 'moving';
      v.progressKm = 0;
      v.routeLengthKm = route ? polylineLength(route.polyline) : 0;
      v.plannedEnergyFraction = route ? route.energyFraction : 0;
      v.startEnergyLevel = v.energyLevel;
    }
    for (const o of this.orders) {
      if (o.status === 'delivered') continue;
      o.assignedVehicle = null; o.routeId = null; o.etaMinutes = null; o.status = 'pending';
    }
    for (const r of plan.routes) {
      for (const s of r.stops) {
        const o = this.ordersById.get(s.orderId);
        if (!o || o.status === 'delivered') continue;
        o.assignedVehicle = r.vehicleId;
        o.routeId = r.id;
        o.etaMinutes = s.serviceStart;
        o.status = 'assigned';
        o.plannedLate = s.late;
      }
    }
    for (const id of plan.unserved) {
      const o = this.ordersById.get(id);
      if (o && o.status !== 'delivered') o.status = 'unserved';
    }

    this.refreshAlerts();
    if (!silent) {
      emit(EV.PLAN_CHANGED, { plan, previous: this.previousPlan, trigger });
    }
    emit(EV.STATE_CHANGED, this);
  }

  /** Run the optimiser end to end. */
  async optimizeFleet({ label = 'Optimised plan', trigger = 'Manual optimisation', iterations } = {}) {
    if (this.optimizing) return null;
    this.optimizing = true;
    this.optimizeProgress = { phase: 'analyse', done: 0, total: 1 };
    emit(EV.OPT_START, { trigger });
    this.logEvent('optimize', `Optimization initiated — ${trigger}`);

    const before = this.plan;
    try {
      const result = await this.optimizer.optimize({
        vehicles: this.vehicles,
        orders: this.openOrders(),
        weights: this.weights,
        startMinutes: this.clockMinutes,
        iterations,
        label,
        baseline: this.baseline,
        seed: 7 + this.log.length,
        onProgress: (p) => {
          this.optimizeProgress = p;
          emit(EV.OPT_PROGRESS, p);
        },
      });
      if (!result) { this.optimizing = false; return null; }

      this.optimizeHistory = result.history;
      this.optimizeStats = result.stats;
      this.baseline = result.baseline;
      this.reference = result.reference;

      const plan = result.plan;
      this.applyPlan(plan, { trigger });

      if (before) {
        this.lastExplanation = explainReplan(before, plan, { trigger, weights: this.weights });
        const c = this.lastExplanation.comparison;
        const co2 = c.rows.find((r) => r.key === 'co2');
        this.logEvent('optimize', `${plan.routes.filter((r) => r.orderIds.length).length} routes recalculated`);
        this.logEvent('plan', `Fleet plan updated — CO₂e ${co2.delta <= 0 ? 'down' : 'up'} ${kg(Math.abs(co2.delta), 2)}`);
      } else {
        this.logEvent('plan', 'Initial fleet plan generated');
      }
      this.counterfactual = comparePlans(this.baseline, plan, { labelBefore: 'Baseline dispatch', labelAfter: 'CarbonRoute X' });

      emit(EV.OPT_DONE, { plan, stats: result.stats, explanation: this.lastExplanation });
      return plan;
    } catch (err) {
      console.error('[store] optimize failed', err);
      this.logEvent('error', `Optimization failed: ${err.message}`);
      emit(EV.OPT_FAILED, { message: err.message });
      return null;
    } finally {
      this.optimizing = false;
      this.optimizeProgress = null;
    }
  }

  /** Compute the Pareto frontier across sampled weight vectors. */
  async computeFrontier() {
    if (this.optimizing) return null;
    this.optimizing = true;
    emit(EV.OPT_START, { trigger: 'Frontier exploration' });
    this.logEvent('optimize', `Exploring optimisation frontier — ${OPTIMIZER.paretoSamples} weight vectors`);
    try {
      const result = await this.optimizer.frontier({
        vehicles: this.vehicles,
        orders: this.openOrders(),
        startMinutes: this.clockMinutes,
        baseline: this.baseline,
        onProgress: (p) => { this.optimizeProgress = p; emit(EV.OPT_PROGRESS, p); },
      });
      this.pareto = result;
      this.logEvent('optimize', `Frontier ready — ${result.frontier.length} non-dominated of ${result.candidates.length} candidates`);
      emit(EV.PARETO_READY, result);
      return result;
    } catch (err) {
      console.error('[store] frontier failed', err);
      emit(EV.OPT_FAILED, { message: err.message });
      return null;
    } finally {
      this.optimizing = false;
      this.optimizeProgress = null;
    }
  }

  /** Adopt a frontier candidate as the live plan. */
  selectCandidate(candidateId) {
    const cand = this.pareto?.candidates.find((c) => c.id === candidateId);
    if (!cand) return null;
    const before = this.plan;
    this.weights = normaliseWeights(cand.weights);
    this.preset = 'custom';
    savePrefs({ weights: this.weights, preset: this.preset, layers: this.layers });
    emit(EV.WEIGHTS_CHANGED, this.weights);
    this.applyPlan(cand, { trigger: `Frontier candidate ${cand.id}` });
    this.lastExplanation = explainReplan(before, cand, { trigger: `Frontier candidate ${cand.id} selected`, weights: this.weights });
    this.logEvent('plan', `Adopted ${cand.id} from the optimisation frontier`);
    return cand;
  }

  /* ---------------------------------------------------------------- */
  /* Route alternatives for a single delivery                          */
  /* ---------------------------------------------------------------- */

  /**
   * Four genuinely different paths to one delivery, each optimised under a
   * different weight vector, all evaluated with the same cost model.
   */
  routeOptionsFor(orderId) {
    if (this.alternativesCache.has(orderId)) return this.alternativesCache.get(orderId);
    const order = this.ordersById.get(orderId);
    if (!order) return [];
    const route = order.routeId ? this.routesById.get(order.routeId) : null;
    const vehicle = route ? this.vehiclesById.get(route.vehicleId) : this.vehicles.find((v) => v.available);
    if (!vehicle) return [];

    // Start from the stop preceding this one, so the comparison is about the
    // leg the operator can actually change.
    let fromNode = this.depotsById.get(vehicle.depotId).nodeId;
    let payload = 0.6;
    if (route) {
      const idx = route.orderIds.indexOf(orderId);
      if (idx > 0) fromNode = this.ordersById.get(route.orderIds[idx - 1]).nodeId;
      const remaining = route.orderIds.slice(idx).reduce((a, id) => a + (this.ordersById.get(id)?.weightKg || 0), 0);
      payload = clamp(remaining / VEHICLE_TYPES[vehicle.type].capacityKg, 0, 1.2);
    }

    const specs = [
      { key: 'fastest', label: 'Fastest', weights: PRESETS.fastest },
      { key: 'greenest', label: 'Lowest emissions', weights: PRESETS.greenest },
      { key: 'cheapest', label: 'Lowest cost', weights: PRESETS.cheapest },
      { key: 'balanced', label: 'Balanced', weights: PRESETS.balanced },
    ];
    const seen = new Map();
    const options = [];
    for (const spec of specs) {
      const profile = this.router.profile({
        vehicleType: vehicle.type, payload, weights: spec.weights, clockMinutes: this.clockMinutes,
      });
      const path = this.router.path(fromNode, order.nodeId, profile);
      if (!path) continue;
      const sig = path.edges.join(',');
      const existing = seen.get(sig);
      if (existing) { existing.alsoKnownAs.push(spec.label); continue; }
      const opt = {
        key: spec.key, label: spec.label, letter: String.fromCharCode(65 + options.length),
        weights: spec.weights, path, alsoKnownAs: [],
        minutes: path.minutes, km: path.km, co2: path.co2, cost: path.cost,
        reliability: path.reliability, worstCongestion: path.worstCongestion,
      };
      seen.set(sig, opt);
      options.push(opt);
    }
    // Mark which option wins on each axis — this is what the table highlights.
    for (const [axis, lower] of [['minutes', true], ['co2', true], ['cost', true], ['km', true], ['reliability', false]]) {
      if (!options.length) break;
      const best = options.reduce((a, b) => ((lower ? b[axis] < a[axis] : b[axis] > a[axis]) ? b : a));
      best.bestAt = best.bestAt || [];
      best.bestAt.push(axis);
    }
    this.alternativesCache.set(orderId, options);
    return options;
  }

  /** Adopt one of the alternatives above as the live leg for that delivery. */
  selectRouteOption(orderId, optionKey) {
    const options = this.routeOptionsFor(orderId);
    const chosen = options.find((o) => o.key === optionKey);
    const order = this.ordersById.get(orderId);
    if (!chosen || !order) return null;
    order.preferredRouting = optionKey;
    // Re-optimise with this leg's weights nudged in, so the change propagates
    // through the whole plan rather than being a cosmetic override.
    this.weights = normaliseWeights({
      ...this.weights,
      ...Object.fromEntries(Object.entries(chosen.weights).map(([k, v]) => [k, (this.weights[k] + v * 2) / 3])),
    });
    this.preset = 'custom';
    emit(EV.WEIGHTS_CHANGED, this.weights);
    this.logEvent('plan', `${orderId} switched to the ${chosen.label.toLowerCase()} routing`);
    return this.optimizeFleet({ trigger: `Route ${chosen.letter} selected for ${orderId}`, label: 'Re-planned for selected routing' });
  }

  explainRouteById(routeId) {
    const route = this.routesById.get(routeId);
    if (!route) return null;
    const vehicle = this.vehiclesById.get(route.vehicleId);
    // Peers: the same stop set flown by the same vehicle under the other presets.
    const peers = [];
    for (const [key, w] of Object.entries(PRESETS)) {
      if (key === this.preset) continue;
      const alt = this.planEngine.evaluateRoute(vehicle, route.orderIds, normaliseWeights(w), route.startMinutes);
      if (alt && alt.legs.length) peers.push(alt);
    }
    return explainRoute(route, { peers, weights: this.weights, vehicle: { ...vehicle, energyType: VEHICLE_TYPES[vehicle.type].energyType } });
  }

  /* ---------------------------------------------------------------- */
  /* Weights & layers                                                  */
  /* ---------------------------------------------------------------- */

  setWeight(key, value) {
    this.weights = { ...this.weights, [key]: clamp(value, 0, 1) };
    this.preset = 'custom';
    savePrefs({ weights: this.weights, preset: this.preset, layers: this.layers });
    emit(EV.WEIGHTS_CHANGED, this.weights);
  }

  applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    this.weights = normaliseWeights(p);
    this.preset = key;
    savePrefs({ weights: this.weights, preset: this.preset, layers: this.layers });
    emit(EV.WEIGHTS_CHANGED, this.weights);
  }

  toggleLayer(key, force) {
    this.layers[key] = force != null ? force : !this.layers[key];
    savePrefs({ weights: this.weights, preset: this.preset, layers: this.layers });
    emit(EV.LAYERS_CHANGED, this.layers);
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  select(kind, id, opts = {}) {
    if (this.selection.kind === kind && this.selection.id === id && !opts.force) {
      if (opts.toggle) return this.select(null, null);
      return;
    }
    this.selection = { kind, id };
    emit(EV.SELECT, { ...this.selection, ...opts });
  }

  clearSelection() { this.select(null, null); }

  setHover(kind, id) {
    if (this.hover.kind === kind && this.hover.id === id) return;
    this.hover = { kind, id };
    emit(EV.HOVER, this.hover);
  }

  setView(view) {
    if (this.view === view) return;
    this.view = view;
    emit(EV.VIEW_CHANGED, view);
  }

  /* ---------------------------------------------------------------- */
  /* Simulation clock                                                  */
  /* ---------------------------------------------------------------- */

  setSpeed(multiplier) {
    this.speedMultiplier = multiplier;
    this.playing = multiplier > 0;
    emit(EV.STATE_CHANGED, this);
  }

  togglePlay() {
    this.setSpeed(this.playing ? 0 : SIM.defaultSpeedMultiplier);
  }

  /** Advance the modelled world by `realSeconds` of wall clock. */
  tick(realSeconds) {
    if (!this.ready) return;
    const simMinutes = (realSeconds * this.speedMultiplier) / 60;
    if (simMinutes > 0) {
      this.clockMinutes = Math.min(SIM.dayEndMinutes + 120, this.clockMinutes + simMinutes);
      // Recompute traffic on a coarse cadence — it is a slow-moving field and
      // rebuilding it every frame would be pure waste.
      if (!this._lastTrafficMinutes || Math.abs(this.clockMinutes - this._lastTrafficMinutes) > 6 || this.traffic.dirty) {
        this.traffic.update(this.clockMinutes);
        this._lastTrafficMinutes = this.clockMinutes;
        this.router.invalidate();
      }
      this.advanceVehicles(simMinutes);
    }
    emit(EV.FLEET_TICK, { minutes: this.clockMinutes, simMinutes });
  }

  advanceVehicles(simMinutes) {
    let delivered = 0;
    for (const v of this.vehicles) {
      const route = this.routeByVehicle.get(v.id);
      if (!v.available) { v.status = 'disabled'; continue; }
      if (!route || !route.orderIds.length || !route.polyline.length) {
        v.status = v.status === 'charging' ? 'charging' : 'idle';
        continue;
      }
      if (this.clockMinutes < route.startMinutes) { v.status = 'idle'; continue; }

      const totalKm = v.routeLengthKm || polylineLength(route.polyline);
      v.routeLengthKm = totalKm;
      // Progress is driven by the route's own modelled speed profile so that
      // what you see on the map matches the ETA the optimiser committed to.
      const avgSpeed = route.drivingMinutes > 0 ? route.km / (route.drivingMinutes / 60) : 30;
      const stepKm = (simMinutes / 60) * avgSpeed;
      const prevKm = v.progressKm;
      v.progressKm = Math.min(totalKm, v.progressKm + stepKm);

      const at = pointAtLength(route.polyline, v.progressKm);
      v.x = at.x; v.y = at.y; v.heading = at.heading;

      // Energy drain proportional to distance covered.
      if (totalKm > 0) {
        const fractionDone = v.progressKm / totalKm;
        v.energyLevel = clamp((v.startEnergyLevel ?? v.energyLevel) - route.energyFraction * fractionDone, 0, 1);
      }

      // Complete stops whose scheduled service time has passed.
      for (const s of route.stops) {
        const o = this.ordersById.get(s.orderId);
        if (!o || o.status === 'delivered') continue;
        if (this.clockMinutes >= s.departure) {
          o.status = 'delivered';
          o.deliveredAt = s.departure;
          o.lateBy = s.late;
          delivered++;
          this.logEvent(s.late > 0 ? 'exception' : 'delivery',
            s.late > 0
              ? `${o.id} delivered ${dur(s.late)} late to ${o.consignee}`
              : `${o.id} delivered to ${o.consignee} — ${o.district}`);
        } else if (this.clockMinutes >= s.arrival) {
          o.status = 'enroute';
          v.status = 'delivering';
        }
      }

      const remaining = route.stops.filter((s) => this.ordersById.get(s.orderId)?.status !== 'delivered');
      if (v.progressKm >= totalKm - 1e-6) {
        v.status = v.energyLevel < 0.2 ? 'charging' : 'idle';
      } else if (remaining.length === 0) {
        v.status = 'returning';
      } else if (v.status !== 'delivering') {
        // Late against the current schedule?
        const next = remaining[0];
        v.status = this.clockMinutes > next.serviceStart + 4 ? 'delayed' : 'moving';
      }
      v.nextStop = remaining[0] || null;
      v.etaMinutes = remaining.length ? remaining[0].serviceStart : route.endMinutes;
    }
    if (delivered) {
      this.refreshAlerts();
      emit(EV.ORDERS_CHANGED, { delivered });
    }
  }

  /* ---------------------------------------------------------------- */
  /* SCENARIO / DIGITAL TWIN                                           */
  /* ---------------------------------------------------------------- */

  setScenarioTraffic(levelKey) {
    const table = { normal: 1, plus10: 1.10, plus30: 1.30, plus60: 1.60, severe: 2.05 };
    this.pendingScenario.trafficLevel = levelKey;
    this.pendingScenario.trafficMultiplier = table[levelKey] ?? 1;
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
  }

  toggleScenarioVehicle(vehicleId) {
    const list = this.pendingScenario.disabledVehicles;
    const i = list.indexOf(vehicleId);
    if (i >= 0) list.splice(i, 1); else list.push(vehicleId);
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
  }

  setScenarioDeadline(orderId, deltaMinutes) {
    if (deltaMinutes === 0) delete this.pendingScenario.deadlineShifts[orderId];
    else this.pendingScenario.deadlineShifts[orderId] = deltaMinutes;
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
  }

  queueUrgentOrder() {
    this.counters.urgent++;
    const rand = rng(SEED + this.counters.urgent * 7919);
    const order = makeUrgentOrder(this.world, this.depots, this.counters.urgent, rand);
    this.pendingScenario.injectedOrders.push(order);
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return order;
  }

  /** Close the road corridor nearest a world point. */
  closeRoadNear(x, y, radiusKm = 2.2) {
    const closed = [];
    for (const e of this.world.edges) {
      if (Math.hypot(e.mid.x - x, e.mid.y - y) <= radiusKm && e.cls !== 'local') closed.push(e.id);
    }
    for (const id of closed) {
      if (!this.pendingScenario.closedEdges.includes(id)) this.pendingScenario.closedEdges.push(id);
    }
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return closed;
  }

  /** Close every non-local link a given route uses — "this corridor is gone". */
  closeRouteCorridor(routeId) {
    const route = this.routesById.get(routeId);
    if (!route) return [];
    const ids = new Set();
    for (const leg of route.legs) {
      for (const e of leg.edges) if (this.world.edges[e].cls !== 'local') ids.add(e);
    }
    // Close a representative mid-section rather than the whole path, which
    // would make the destination unreachable rather than merely inconvenient.
    const list = [...ids];
    const slice = list.slice(Math.floor(list.length * 0.35), Math.floor(list.length * 0.55));
    for (const id of slice) if (!this.pendingScenario.closedEdges.includes(id)) this.pendingScenario.closedEdges.push(id);
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return slice;
  }

  addIncidentNear(x, y, severity = 1.1, radiusKm = 9) {
    const inc = {
      id: `INC-${this.pendingScenario.incidents.length + 1}`,
      x, y, radiusKm, severity,
      label: 'Congestion event',
    };
    this.pendingScenario.incidents.push(inc);
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return inc;
  }

  resetScenario() {
    this.pendingScenario = this.defaultScenario();
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
  }

  scenarioIsEmpty(s = this.pendingScenario) {
    return s.trafficMultiplier === 1 && !s.disabledVehicles.length && !s.closedEdges.length
      && !Object.keys(s.deadlineShifts).length && !s.injectedOrders.length && !s.incidents.length;
  }

  /** Describe the pending scenario in one human sentence. */
  describeScenario(s = this.pendingScenario) {
    const parts = [];
    if (s.trafficMultiplier !== 1) parts.push(`traffic ${s.trafficMultiplier > 1 ? '+' : ''}${Math.round((s.trafficMultiplier - 1) * 100)}%`);
    if (s.disabledVehicles.length) parts.push(`${s.disabledVehicles.join(', ')} out of service`);
    if (s.closedEdges.length) parts.push(`${s.closedEdges.length} road links closed`);
    if (s.injectedOrders.length) parts.push(`${s.injectedOrders.length} urgent order${s.injectedOrders.length > 1 ? 's' : ''} injected`);
    const dl = Object.keys(s.deadlineShifts).length;
    if (dl) parts.push(`${dl} deadline${dl > 1 ? 's' : ''} moved`);
    if (s.incidents.length) parts.push(`${s.incidents.length} incident zone${s.incidents.length > 1 ? 's' : ''}`);
    return parts.length ? parts.join(', ') : 'no changes staged';
  }

  /**
   * COMMIT + REPLAN: apply the staged scenario to the world, re-optimise, and
   * produce a before/after comparison from the two evaluated plans.
   */
  async replan({ trigger } = {}) {
    if (this.optimizing) return null;
    const s = this.pendingScenario;
    const beforePlan = this.plan;
    const label = this.describeScenario(s);

    this.logEvent('scenario', `Scenario committed — ${label}`);

    // 1. World mutation.
    this.traffic.setGlobalMultiplier(s.trafficMultiplier);
    this.traffic.clearIncidents();
    for (const inc of s.incidents) this.traffic.addIncident(inc);
    this.traffic.clearClosures();
    for (const id of s.closedEdges) this.traffic.closeEdge(id);
    this.traffic.update(this.clockMinutes);
    this.router.invalidate();
    this.planEngine.invalidate();

    for (const v of this.vehicles) {
      const wasAvailable = v.available;
      v.available = !s.disabledVehicles.includes(v.id);
      if (wasAvailable && !v.available) {
        this.logEvent('exception', `${v.callsign} taken out of service`);
        this.raiseAlert('high', `${v.callsign} disabled`, `Vehicle removed from the plan; its ${v.assignedOrders.length} orders need reassignment.`, { kind: 'vehicle', id: v.id });
      }
    }
    for (const [orderId, deltaMin] of Object.entries(s.deadlineShifts)) {
      const o = this.ordersById.get(orderId);
      if (!o) continue;
      if (o.originalDeadline == null) o.originalDeadline = o.deadline;
      o.deadline = clamp(o.originalDeadline + deltaMin, o.windowOpen + 20, SIM.dayEndMinutes + 180);
    }
    for (const o of s.injectedOrders) {
      if (!this.ordersById.has(o.id)) {
        this.orders.push(o);
        this.logEvent('order', `Urgent order ${o.id} booked — ${o.consignee}, deadline ${clock(o.deadline)}`);
      }
    }
    s.injectedOrders = [];
    this.reindex();
    this.scenario = JSON.parse(JSON.stringify({ ...s, injectedOrders: [] }));

    // 2. Detection → impact.
    this.logEvent('detect', `Network conditions changed — congestion index ${pct(this.traffic.networkIndex(), 0)}`);
    const impacted = beforePlan
      ? this.planEngine.buildPlan(
        new Map(beforePlan.routes.map((r) => [r.vehicleId, r.orderIds])),
        this.weights,
        { label: 'Existing plan under new conditions', startMinutes: this.clockMinutes },
      )
      : null;
    if (impacted) {
      this.logEvent('detect', `Route impact calculated — ${impacted.metrics.lateOrders} stop(s) now at risk, ${dur(impacted.metrics.minutes - beforePlan.metrics.minutes)} added fleet time`);
    }

    // 3. Re-optimise.
    this.baseline = this.optimizer.buildBaseline(this.vehicles, this.openOrders(), this.weights, this.clockMinutes);
    const plan = await this.optimizeFleet({
      trigger: trigger || `Replan — ${label}`,
      label: 'Recovery plan',
    });
    if (!plan) return null;

    // 4. Honest before/after: the *old plan under new conditions* versus the
    //    re-optimised plan. Comparing against the old plan's old numbers would
    //    flatter the optimiser by attributing the disruption to it.
    this.scenarioComparison = impacted
      ? comparePlans(impacted, plan, { labelBefore: 'Existing plan, new conditions', labelAfter: 'Re-optimised plan' })
      : null;
    this.scenarioImpacted = impacted;
    this.scenarioTrigger = label;
    this.pendingScenario = this.defaultScenario();
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return plan;
  }

  /**
   * WHAT-IF: evaluate a hypothetical without committing it. The world is
   * mutated, measured, and restored — the live plan is never touched.
   */
  async whatIf(mutator, label) {
    const snapshot = {
      multiplier: this.traffic.globalMultiplier,
      incidents: [...this.traffic.incidents],
      closures: new Set(this.traffic.closures),
      availability: this.vehicles.map((v) => [v.id, v.available]),
      deadlines: this.orders.map((o) => [o.id, o.deadline]),
      orderCount: this.orders.length,
    };
    const before = this.plan;
    try {
      mutator(this);
      this.traffic.update(this.clockMinutes);
      this.router.invalidate();
      this.planEngine.invalidate();
      this.reindex();
      const result = await this.optimizer.optimize({
        vehicles: this.vehicles,
        orders: this.openOrders(),
        weights: this.weights,
        startMinutes: this.clockMinutes,
        iterations: Math.round(OPTIMIZER.maxIterations * 0.55),
        label: label || 'What-if plan',
        seed: 23,
      });
      if (!result) return null;
      // Re-cost the *current* plan under the hypothetical world too, so both
      // sides of the comparison see the same conditions.
      const beforeUnderHypothesis = before
        ? this.planEngine.buildPlan(
          new Map(before.routes.filter((r) => this.vehiclesById.get(r.vehicleId)?.available).map((r) => [r.vehicleId, r.orderIds])),
          this.weights, { label: 'Current plan', startMinutes: this.clockMinutes },
        )
        : null;
      return {
        label,
        before: before,
        beforeUnderHypothesis,
        after: result.plan,
        comparison: comparePlans(before, result.plan, { labelBefore: 'Current plan', labelAfter: label || 'What-if' }),
        explanation: before ? explainReplan(before, result.plan, { trigger: label, weights: this.weights }) : null,
      };
    } finally {
      // Restore. Order matters: availability and deadlines before re-indexing.
      this.traffic.setGlobalMultiplier(snapshot.multiplier);
      this.traffic.clearIncidents();
      for (const i of snapshot.incidents) this.traffic.addIncident(i);
      this.traffic.clearClosures();
      for (const id of snapshot.closures) this.traffic.closeEdge(id);
      this.traffic.update(this.clockMinutes);
      for (const [id, avail] of snapshot.availability) {
        const v = this.vehiclesById.get(id); if (v) v.available = avail;
      }
      for (const [id, dl] of snapshot.deadlines) {
        const o = this.ordersById.get(id); if (o) o.deadline = dl;
      }
      this.orders.length = snapshot.orderCount;
      this.reindex();
      this.router.invalidate();
      this.planEngine.invalidate();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Alerts & event log                                                */
  /* ---------------------------------------------------------------- */

  logEvent(kind, message, meta = null) {
    const entry = {
      id: `E${this.log.length + 1}`,
      at: this.clockMinutes,
      stamp: clockSeconds(this.clockMinutes + (this.log.length % 60) / 60),
      kind, message, meta,
      wallClock: Date.now(),
    };
    this.log.unshift(entry);
    if (this.log.length > this.logCap) this.log.length = this.logCap;
    emit(EV.LOG, entry);
    return entry;
  }

  raiseAlert(severity, title, detail, target = null) {
    const existing = this.alerts.find((a) => a.title === title && !a.dismissed);
    if (existing) { existing.detail = detail; existing.at = this.clockMinutes; return existing; }
    const alert = {
      id: `A${Date.now().toString(36)}${this.alerts.length}`,
      severity, title, detail, target,
      at: this.clockMinutes, dismissed: false,
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > this.alertCap) this.alerts.length = this.alertCap;
    emit(EV.ALERT, alert);
    emit(EV.ALERTS_CHANGED, this.alerts);
    return alert;
  }

  dismissAlert(id) {
    const a = this.alerts.find((x) => x.id === id);
    if (a) { a.dismissed = true; emit(EV.ALERTS_CHANGED, this.alerts); }
  }

  /** Derive the alert set from the current plan and world — no fabrication. */
  refreshAlerts() {
    if (!this.plan) return;
    const keep = this.alerts.filter((a) => a.sticky || a.dismissed);
    this.alerts = keep;

    for (const v of this.vehicles) {
      const route = this.routeByVehicle.get(v.id);
      if (!v.available) continue;
      const need = route ? route.energyFraction : 0;
      const arrival = v.energyLevel - need;
      if (route && route.orderIds.length && arrival < 0.12) {
        this.raiseAlert('high', `${v.callsign} approaching range threshold`,
          `Plan consumes ${pct(need, 0)} of range; vehicle would arrive at ${pct(Math.max(arrival, 0), 0)}.`,
          { kind: 'vehicle', id: v.id });
      }
      if (v.status === 'delayed') {
        this.raiseAlert('medium', `${v.callsign} running behind schedule`,
          `Next stop was scheduled for ${clock(v.etaMinutes)}.`, { kind: 'vehicle', id: v.id });
      }
    }

    for (const r of this.plan.routes) {
      for (const violation of r.violations) {
        if (violation.severity !== 'hard') continue;
        this.raiseAlert('high', `${r.id} infeasible`, violation.label, { kind: 'route', id: r.id });
      }
      if (r.worstCongestion > 1.25 && r.orderIds.length) {
        this.raiseAlert('medium', `${r.id} congestion increasing`,
          `Peak link load ${pct(r.worstCongestion / 2.6, 0)} of the modelled jam threshold.`, { kind: 'route', id: r.id });
      }
    }

    for (const id of this.plan.unserved) {
      const o = this.ordersById.get(id);
      if (!o) continue;
      this.raiseAlert('high', `${o.id} unassigned`,
        `No vehicle can serve ${o.consignee} (${o.weightKg} kg, deadline ${clock(o.deadline)}) within constraints.`,
        { kind: 'order', id: o.id });
    }

    for (const o of this.orders) {
      if (o.status === 'delivered' && o.lateBy === 0 && o.etaMinutes != null && o.deliveredAt < o.deadline - 45) {
        this.raiseAlert('low', `${o.id} ahead of schedule`,
          `Delivered ${dur(o.deadline - o.deliveredAt)} before its deadline.`, { kind: 'order', id: o.id });
      }
    }

    const hot = this.traffic.hotspots(2);
    for (const h of hot) {
      if (h.score < 1.6) continue;
      this.raiseAlert('medium', `Congestion on ${corridorName(this.world, h.edgeId)}`,
        `Link load ${pct(this.traffic.congestion[h.edgeId] / 2.6, 0)} of the modelled jam threshold.`,
        { kind: 'edge', id: h.edgeId });
    }

    emit(EV.ALERTS_CHANGED, this.alerts);
  }

  activeAlerts() { return this.alerts.filter((a) => !a.dismissed); }

  /* ---------------------------------------------------------------- */
  /* Derived metrics for the HUD                                       */
  /* ---------------------------------------------------------------- */

  heroMetrics() {
    const m = this.plan?.metrics;
    const active = this.vehicles.filter((v) => v.available && v.routeId).length;
    const delivered = this.orders.filter((o) => o.status === 'delivered').length;
    return {
      activeVehicles: active,
      totalVehicles: this.vehicles.filter((v) => v.available).length,
      deliveries: this.orders.filter((o) => o.status !== 'cancelled').length,
      delivered,
      onTimeRate: m ? m.onTimeRate : 1,
      co2: m ? m.co2 : 0,
      km: m ? m.km : 0,
      cost: m ? m.cost : 0,
      utilization: m ? m.utilization : 0,
      fleetUtilization: m ? m.fleetUtilization : 0,
      unserved: m ? m.unserved : 0,
      congestion: this.traffic ? this.traffic.networkIndex() : 0,
      clock: clock(this.clockMinutes),
    };
  }

  /** Emissions grouped by an arbitrary key — feeds the carbon panel. */
  emissionsBy(dimension) {
    if (!this.plan) return [];
    const groups = new Map();
    const add = (key, label, value, extra = {}) => {
      if (!groups.has(key)) groups.set(key, { key, label, value: 0, ...extra });
      groups.get(key).value += value;
    };
    for (const r of this.plan.routes) {
      if (!r.orderIds.length) continue;
      const v = this.vehiclesById.get(r.vehicleId);
      const type = VEHICLE_TYPES[r.vehicleType];
      if (dimension === 'vehicle') add(v.id, v.callsign, r.co2, { sub: type.label });
      else if (dimension === 'route') add(r.id, r.id, r.co2, { sub: `${r.stops.length} stops` });
      else if (dimension === 'vehicleType') add(type.key, type.label, r.co2, { sub: type.unit });
      else if (dimension === 'energySource') add(type.energyType, { diesel: 'Diesel', cng: 'CNG', bev: 'Grid electricity' }[type.energyType], r.co2);
      else if (dimension === 'delivery') for (const s of r.stops) add(s.orderId, s.orderId, s.legCo2, { sub: s.consignee });
      else if (dimension === 'region') for (const s of r.stops) add(s.district, s.district, s.legCo2);
      else if (dimension === 'distance') {
        const band = r.km < 40 ? '0–40 km' : r.km < 80 ? '40–80 km' : r.km < 130 ? '80–130 km' : '130+ km';
        add(band, band, r.co2);
      } else if (dimension === 'traffic') {
        const band = r.worstCongestion < 0.6 ? 'Free flow' : r.worstCongestion < 1.0 ? 'Busy' : r.worstCongestion < 1.4 ? 'Heavy' : 'Severe';
        add(band, band, r.co2);
      }
    }
    return [...groups.values()].sort((a, b) => b.value - a.value);
  }
}

export const store = new Store();
export { APP };
