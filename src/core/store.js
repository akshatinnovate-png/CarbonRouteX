/**
 * STATE / EVENT ENGINE
 *
 * The single owner of application state. Views read from it and call its
 * methods; they never mutate it. Every meaningful change emits on the bus.
 *
 * Unlike the earlier synthetic build, everything here is real: depots, vehicles
 * and orders are entered by the operator, positions are genuine coordinates,
 * distances and durations come from a live routing service over OpenStreetMap
 * road geometry, and the workspace persists locally between sessions.
 */

import { SIM, PRESETS, LAYERS, VEHICLE_TYPES, OPTIMIZER, PRIORITY } from '../config.js';
import { EV, emit } from './bus.js';
import {
  loadWorkspace, saveWorkspace, emptyWorkspace, loadSession, saveSession,
  clearSession, clearWorkspace, storageAvailable, exportWorkspace, importWorkspace,
} from './storage.js';
import { OsrmService } from '../services/osrm.js';
import { GeocodeService, fallbackLabel } from '../services/geocode.js';
import { NetworkMatrix } from '../engines/matrix.js';
import { PlanEngine, normaliseWeights } from '../engines/plan.js';
import { Optimizer } from '../engines/optimizer.js';
import { explainReplan, explainRoute, comparePlans } from '../engines/explain.js';
import { clamp } from '../util/math.js';
import { clock, clockSeconds, dur, kg, num, pct } from '../util/format.js';
import { haversineKm, pointAtFraction, polylineKm } from '../render/mercator.js';

let uid = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}${(uid++).toString(36)}`;

export class Store {
  constructor() {
    this.ready = false;
    this.workspace = emptyWorkspace();
    this.session = null;

    this.view = 'map';
    this.selection = { kind: null, id: null };
    this.hover = { kind: null, id: null };
    this.layers = Object.fromEntries(LAYERS.map((l) => [l.key, l.on]));

    this.weights = { ...PRESETS.balanced };
    this.preset = 'balanced';

    this.plan = null;
    this.baseline = null;
    this.previousPlan = null;
    this.lastExplanation = null;
    this.counterfactual = null;
    this.optimizeHistory = [];
    this.optimizeStats = null;
    this.optimizing = false;
    this.optimizeProgress = null;
    this.pareto = null;

    this.clockMinutes = SIM.dayStartMinutes;
    this.speedMultiplier = 0;
    this.playing = false;

    this.scenario = this.defaultScenario();
    this.pendingScenario = this.defaultScenario();
    this.scenarioComparison = null;

    this.alerts = [];
    this.log = [];
    this.logCap = 240;
    this.alertCap = 60;

    this.osrm = new OsrmService();
    this.geocode = new GeocodeService();
    this.matrix = new NetworkMatrix();
    this.serviceStatus = { routing: 'unknown', geocoding: 'unknown', message: null };

    this.routesById = new Map();
    this.routeByVehicle = new Map();
  }

  defaultScenario() {
    return {
      trafficLevel: 'normal',
      trafficMultiplier: 1,
      disabledVehicles: [],
      closedRoutes: [],
      deadlineShifts: {},
      injectedOrders: [],
      incidents: [],
    };
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async init() {
    this.workspace = loadWorkspace();
    this.session = loadSession();
    const s = this.workspace.settings;
    if (s.weights) { this.weights = normaliseWeights(s.weights); this.preset = s.preset || 'custom'; }
    if (s.layers) Object.assign(this.layers, s.layers);
    if (s.osrmEndpoint) this.osrm.setEndpoint(s.osrmEndpoint);
    if (s.geocodeEndpoint) this.geocode.setEndpoint(s.geocodeEndpoint);

    this.reindex();
    this.ctx = {
      depots: this.depots,
      depotsById: this.depotsById,
      ordersById: this.ordersById,
      vehiclesById: this.vehiclesById,
    };
    this.planEngine = new PlanEngine(this.matrix, this.ctx);
    this.optimizer = new Optimizer(this.planEngine, this.ctx);

    this.ready = true;
    this.logEvent('system', storageAvailable
      ? 'Workspace loaded from local storage'
      : 'Browser storage unavailable — this session will not be saved');
    emit(EV.READY, this);
    // Probe services in the background; the UI must not wait on them.
    this.probeServices();
    return this;
  }

  get depots() { return this.workspace.depots; }
  get vehicles() { return this.workspace.vehicles; }
  get orders() { return this.workspace.orders; }
  get settings() { return this.workspace.settings; }
  get onboarded() { return !!this.workspace.onboarded; }
  get signedIn() { return !!this.session; }

  reindex() {
    this.depotsById = new Map(this.depots.map((d) => [d.id, d]));
    this.vehiclesById = new Map(this.vehicles.map((v) => [v.id, v]));
    this.ordersById = new Map(this.orders.map((o) => [o.id, o]));
    if (this.ctx) {
      this.ctx.depots = this.depots;
      this.ctx.depotsById = this.depotsById;
      this.ctx.vehiclesById = this.vehiclesById;
      this.ctx.ordersById = this.ordersById;
    }
  }

  persist() {
    this.workspace.settings.weights = this.weights;
    this.workspace.settings.preset = this.preset;
    this.workspace.settings.layers = this.layers;
    const ok = saveWorkspace(this.workspace);
    if (!ok && !this._warnedStorage) {
      this._warnedStorage = true;
      emit(EV.TOAST, {
        message: 'Changes cannot be saved — browser storage is full or blocked. This session will still work.',
        tone: 'bad', duration: 7000,
      });
    }
    return ok;
  }

  async probeServices() {
    const [routing, geocoding] = await Promise.all([this.osrm.probe(), this.geocode.probe()]);
    this.serviceStatus = {
      routing: routing.ok ? 'ok' : 'down',
      geocoding: geocoding.ok ? 'ok' : 'down',
      message: routing.ok ? null : routing.message,
    };
    if (!routing.ok) {
      this.logEvent('error', `Routing service unreachable — ${routing.message}`);
    }
    emit(EV.SERVICE_STATUS, this.serviceStatus);
    return this.serviceStatus;
  }

  /* ---------------------------------------------------------------- */
  /* Account                                                           */
  /* ---------------------------------------------------------------- */

  signIn({ name, org }) {
    const account = this.workspace.account || { createdAt: Date.now() };
    this.workspace.account = { ...account, name: name.trim(), org: (org || '').trim() };
    this.session = { name: this.workspace.account.name, at: Date.now() };
    saveSession(this.session);
    this.persist();
    this.logEvent('system', `${this.workspace.account.name} signed in`);
    emit(EV.STATE_CHANGED, this);
    return this.session;
  }

  signOut() {
    this.session = null;
    clearSession();
    emit(EV.STATE_CHANGED, this);
  }

  setRegion(region) {
    this.workspace.region = region;
    this.persist();
    emit(EV.ENTITIES_CHANGED, { kind: 'region' });
  }

  completeOnboarding() {
    this.workspace.onboarded = true;
    this.persist();
    this.logEvent('system', `Setup complete — ${this.depots.length} depots, ${this.vehicles.length} vehicles, ${this.orders.length} orders`);
    emit(EV.ONBOARDED, this);
  }

  resetWorkspace() {
    clearWorkspace();
    clearSession();
    this.workspace = emptyWorkspace();
    this.session = null;
    this.plan = null; this.baseline = null; this.pareto = null;
    this.alerts = []; this.log = [];
    this.reindex();
    emit(EV.STATE_CHANGED, this);
  }

  exportJson() { return exportWorkspace(this.workspace); }

  importJson(text) {
    const ws = importWorkspace(text);
    this.workspace = ws;
    this.reindex();
    this.plan = null; this.baseline = null; this.pareto = null;
    this.persist();
    this.logEvent('system', `Workspace imported — ${ws.depots.length} depots, ${ws.vehicles.length} vehicles, ${ws.orders.length} orders`);
    emit(EV.ENTITIES_CHANGED, { kind: 'import' });
    return ws;
  }

  /* ---------------------------------------------------------------- */
  /* Entities                                                          */
  /* ---------------------------------------------------------------- */

  addDepot({ name, lon, lat, label, short, dockCount = 4, openMinutes = SIM.dayStartMinutes - 60, closeMinutes = SIM.dayEndMinutes + 60 }) {
    this.workspace.counters.depot++;
    const depot = {
      id: nextId('W'),
      name: name?.trim() || `Depot ${this.workspace.counters.depot}`,
      lon, lat,
      label: label || fallbackLabel(lon, lat),
      short: short || label || fallbackLabel(lon, lat),
      dockCount, openMinutes, closeMinutes,
      createdAt: Date.now(),
    };
    this.depots.push(depot);
    this.reindex();
    this.persist();
    this.invalidateNetwork();
    this.logEvent('depot', `Depot added — ${depot.name}`);
    emit(EV.ENTITIES_CHANGED, { kind: 'depot', id: depot.id });
    return depot;
  }

  updateDepot(id, patch) {
    const d = this.depotsById.get(id);
    if (!d) return null;
    const moved = patch.lon !== undefined && (patch.lon !== d.lon || patch.lat !== d.lat);
    Object.assign(d, patch);
    this.persist();
    if (moved) this.invalidateNetwork();
    emit(EV.ENTITIES_CHANGED, { kind: 'depot', id });
    return d;
  }

  removeDepot(id) {
    const i = this.depots.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const [removed] = this.depots.splice(i, 1);
    // Vehicles based here need a new home or they cannot be routed.
    const fallbackDepot = this.depots[0];
    for (const v of this.vehicles) {
      if (v.depotId === id) v.depotId = fallbackDepot ? fallbackDepot.id : null;
    }
    this.reindex();
    this.persist();
    this.invalidateNetwork();
    this.logEvent('depot', `Depot removed — ${removed.name}`);
    emit(EV.ENTITIES_CHANGED, { kind: 'depot', id });
    return true;
  }

  addVehicle({ type, callsign, driver, depotId, energyLevel = 0.9, registration = '' }) {
    this.workspace.counters.vehicle++;
    const spec = VEHICLE_TYPES[type] || Object.values(VEHICLE_TYPES)[0];
    const n = this.workspace.counters.vehicle;
    const vehicle = {
      id: nextId('V'),
      callsign: callsign?.trim() || `${spec.icon === 'truck' ? 'TRUCK' : 'VAN'} ${String(n).padStart(2, '0')}`,
      registration: registration.trim(),
      type: spec.key,
      typeLabel: spec.label,
      driver: driver?.trim() || 'Unassigned',
      capacityKg: spec.capacityKg,
      energyType: spec.energyType,
      energyLevel: clamp(energyLevel, 0.05, 1),
      depotId: depotId || this.depots[0]?.id || null,
      lon: null, lat: null, heading: 0,
      status: 'idle',
      available: true,
      assignedOrders: [],
      routeId: null,
      progress: 0,
      telemetry: { odometerKm: 0 },
      createdAt: Date.now(),
    };
    const depot = this.depotsById.get(vehicle.depotId);
    if (depot) { vehicle.lon = depot.lon; vehicle.lat = depot.lat; }
    this.vehicles.push(vehicle);
    this.reindex();
    this.persist();
    this.logEvent('fleet', `Vehicle added — ${vehicle.callsign} (${spec.label})`);
    emit(EV.ENTITIES_CHANGED, { kind: 'vehicle', id: vehicle.id });
    return vehicle;
  }

  updateVehicle(id, patch) {
    const v = this.vehiclesById.get(id);
    if (!v) return null;
    Object.assign(v, patch);
    if (patch.type) {
      const spec = VEHICLE_TYPES[patch.type];
      if (spec) {
        v.typeLabel = spec.label; v.capacityKg = spec.capacityKg; v.energyType = spec.energyType;
      }
    }
    if (patch.depotId) {
      const d = this.depotsById.get(patch.depotId);
      if (d && !v.routeId) { v.lon = d.lon; v.lat = d.lat; }
    }
    this.persist();
    emit(EV.ENTITIES_CHANGED, { kind: 'vehicle', id });
    return v;
  }

  removeVehicle(id) {
    const i = this.vehicles.findIndex((v) => v.id === id);
    if (i < 0) return false;
    const [removed] = this.vehicles.splice(i, 1);
    this.reindex();
    this.persist();
    this.logEvent('fleet', `Vehicle removed — ${removed.callsign}`);
    emit(EV.ENTITIES_CHANGED, { kind: 'vehicle', id });
    return true;
  }

  addOrder({ consignee, lon, lat, label, short, weightKg = 100, priority = 'standard', windowOpen, deadline, serviceMinutes = 6, goods = '', notes = '' }) {
    this.workspace.counters.order++;
    const order = {
      id: nextId('ORD'),
      ref: `ORD-${String(100 + this.workspace.counters.order)}`,
      consignee: consignee?.trim() || `Consignee ${this.workspace.counters.order}`,
      goods: goods.trim(),
      notes: notes.trim(),
      lon, lat,
      label: label || fallbackLabel(lon, lat),
      short: short || label || fallbackLabel(lon, lat),
      priority: PRIORITY[priority] ? priority : 'standard',
      weightKg: Math.max(1, Math.round(weightKg)),
      windowOpen: windowOpen ?? SIM.dayStartMinutes,
      deadline: deadline ?? SIM.dayEndMinutes,
      serviceMinutes: Math.max(0, Math.round(serviceMinutes)),
      status: 'pending',
      assignedVehicle: null,
      routeId: null,
      etaMinutes: null,
      deliveredAt: null,
      createdAt: Date.now(),
    };
    this.orders.push(order);
    this.reindex();
    this.persist();
    this.invalidateNetwork();
    emit(EV.ENTITIES_CHANGED, { kind: 'order', id: order.id });
    return order;
  }

  updateOrder(id, patch) {
    const o = this.ordersById.get(id);
    if (!o) return null;
    const moved = patch.lon !== undefined && (patch.lon !== o.lon || patch.lat !== o.lat);
    Object.assign(o, patch);
    this.persist();
    if (moved) this.invalidateNetwork();
    emit(EV.ENTITIES_CHANGED, { kind: 'order', id });
    return o;
  }

  removeOrder(id) {
    const i = this.orders.findIndex((o) => o.id === id);
    if (i < 0) return false;
    this.orders.splice(i, 1);
    this.reindex();
    this.persist();
    this.invalidateNetwork();
    emit(EV.ENTITIES_CHANGED, { kind: 'order', id });
    return true;
  }

  /** The matrix no longer matches the stop set, so it must be refetched. */
  invalidateNetwork() {
    this.matrixStale = true;
    this.planEngine?.invalidate();
    emit(EV.MATRIX_CHANGED, { stale: true });
  }

  openOrders() {
    return this.orders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
  }

  /* ---------------------------------------------------------------- */
  /* Road network matrix                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Fetch the real road distance/duration matrix covering every depot and
   * every open order — one request for the whole problem.
   */
  async buildMatrix({ force = false } = {}) {
    const points = [
      ...this.depots.map((d) => ({ id: d.id, kind: 'depot', lon: d.lon, lat: d.lat })),
      ...this.openOrders().map((o) => ({ id: o.id, kind: 'order', lon: o.lon, lat: o.lat })),
    ];
    if (points.length < 2) {
      this.matrixStale = false;
      return this.matrix;
    }
    const signature = points.map((p) => `${p.id}:${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join('|');
    if (!force && !this.matrixStale && signature === this._matrixSignature) return this.matrix;

    this.logEvent('system', `Requesting road distances for ${points.length} locations`);
    await this.matrix.build(points, this.osrm);
    this._matrixSignature = signature;
    this.matrixStale = false;
    this.planEngine.invalidate();

    if (this.matrix.estimated) {
      this.logEvent('error', 'Routing service unavailable — using straight-line estimates');
      this.raiseAlert('high', 'Road distances unavailable',
        this.matrix.note || 'The routing service could not be reached. Distances and times below are straight-line estimates, not road routes.',
        null, { sticky: true });
    } else {
      this.alerts = this.alerts.filter((a) => a.title !== 'Road distances unavailable');
      this.logEvent('system', `Road matrix ready — ${points.length}×${points.length} real road distances`);
    }
    emit(EV.MATRIX_CHANGED, { stale: false, estimated: this.matrix.estimated, note: this.matrix.note });
    return this.matrix;
  }

  /* ---------------------------------------------------------------- */
  /* Plans                                                             */
  /* ---------------------------------------------------------------- */

  applyPlan(plan, { silent = false, isBaseline = false, trigger = null } = {}) {
    this.previousPlan = isBaseline ? null : this.plan;
    this.plan = plan;
    this.routesById = new Map(plan.routes.map((r) => [r.id, r]));
    this.routeByVehicle = new Map(plan.routes.map((r) => [r.vehicleId, r]));

    for (const v of this.vehicles) {
      const route = this.routeByVehicle.get(v.id);
      v.routeId = route && route.orderIds.length ? route.id : null;
      v.assignedOrders = route ? [...route.orderIds] : [];
      if (!v.available) v.status = 'disabled';
      else if (!v.routeId) v.status = 'idle';
      else if (v.status === 'idle' || v.status === 'disabled') v.status = 'moving';
      v.progress = 0;
      const depot = this.depotsById.get(v.depotId);
      if (depot && !v.routeId) { v.lon = depot.lon; v.lat = depot.lat; }
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
    this.persist();
    if (!silent) emit(EV.PLAN_CHANGED, { plan, previous: this.previousPlan, trigger });
    emit(EV.STATE_CHANGED, this);
    // Real road geometry is fetched after publishing, so the plan appears
    // immediately and the map fills in the actual driven path as it arrives.
    this.fetchRouteGeometry(plan);
  }

  /**
   * Ask the routing service for the true road path through each route's stops.
   * This is presentation, not optimisation — the plan is already costed from
   * the matrix — so it happens off the critical path and degrades gracefully.
   */
  async fetchRouteGeometry(plan) {
    const active = plan.routes.filter((r) => r.orderIds.length);
    for (const route of active) {
      const depot = this.depotsById.get(route.depotId);
      if (!depot) continue;
      const waypoints = [
        { lon: depot.lon, lat: depot.lat },
        ...route.stops.map((s) => ({ lon: s.lon, lat: s.lat })),
        { lon: depot.lon, lat: depot.lat },
      ];
      try {
        const geo = await this.osrm.route(waypoints);
        if (this.plan !== plan) return; // a newer plan superseded this one
        route.path = geo.points;
        route.geometryEstimated = geo.estimated;
        route.pathKm = polylineKm(geo.points);
        emit(EV.PLAN_CHANGED, { plan, geometryOnly: true });
      } catch {
        route.path = waypoints;
        route.geometryEstimated = true;
      }
    }
  }

  async optimizeFleet({ label = 'Optimised plan', trigger = 'Manual optimisation', iterations } = {}) {
    if (this.optimizing) return null;
    if (!this.vehicles.length || !this.openOrders().length || !this.depots.length) {
      emit(EV.TOAST, {
        message: 'Add at least one depot, one vehicle and one order before optimising.',
        tone: 'bad',
      });
      return null;
    }
    this.optimizing = true;
    this.optimizeProgress = { phase: 'analyse', done: 0, total: 1, message: 'Fetching road distances' };
    emit(EV.OPT_START, { trigger });
    this.logEvent('optimize', `Optimization initiated — ${trigger}`);

    const before = this.plan;
    try {
      await this.buildMatrix();
      const result = await this.optimizer.optimize({
        vehicles: this.vehicles,
        orders: this.openOrders(),
        weights: this.weights,
        startMinutes: this.clockMinutes,
        iterations,
        label,
        baseline: null,
        seed: 7 + this.log.length,
        onProgress: (p) => { this.optimizeProgress = p; emit(EV.OPT_PROGRESS, p); },
      });
      if (!result) return null;

      this.optimizeHistory = result.history;
      this.optimizeStats = result.stats;
      this.baseline = result.baseline;
      this.applyPlan(result.plan, { trigger });

      if (before) {
        this.lastExplanation = explainReplan(before, result.plan, { trigger, weights: this.weights });
        const co2 = this.lastExplanation.comparison.rows.find((r) => r.key === 'co2');
        this.logEvent('optimize', `${result.plan.routes.filter((r) => r.orderIds.length).length} routes recalculated`);
        this.logEvent('plan', `Fleet plan updated — CO₂e ${co2.delta <= 0 ? 'down' : 'up'} ${kg(Math.abs(co2.delta), 2)}`);
      } else {
        this.logEvent('plan', 'Initial fleet plan generated');
      }
      this.counterfactual = comparePlans(this.baseline, result.plan, {
        labelBefore: 'Baseline dispatch', labelAfter: 'CarbonRoute',
      });
      emit(EV.OPT_DONE, { plan: result.plan, stats: result.stats, explanation: this.lastExplanation });
      return result.plan;
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

  async computeFrontier() {
    if (this.optimizing) return null;
    if (!this.vehicles.length || !this.openOrders().length) return null;
    this.optimizing = true;
    emit(EV.OPT_START, { trigger: 'Frontier exploration' });
    this.logEvent('optimize', `Exploring optimisation frontier — ${OPTIMIZER.paretoSamples} weight vectors`);
    try {
      await this.buildMatrix();
      const result = await this.optimizer.frontier({
        vehicles: this.vehicles,
        orders: this.openOrders(),
        startMinutes: this.clockMinutes,
        baseline: this.baseline,
        onProgress: (p) => { this.optimizeProgress = p; emit(EV.OPT_PROGRESS, p); },
      });
      this.pareto = result;
      this.logEvent('optimize', `Frontier ready — ${result.frontier.length} non-dominated of ${result.candidates.length}`);
      emit(EV.PARETO_READY, result);
      return result;
    } catch (err) {
      emit(EV.OPT_FAILED, { message: err.message });
      return null;
    } finally {
      this.optimizing = false;
      this.optimizeProgress = null;
    }
  }

  selectCandidate(candidateId) {
    const cand = this.pareto?.candidates.find((c) => c.id === candidateId);
    if (!cand) return null;
    const before = this.plan;
    this.weights = normaliseWeights(cand.weights);
    this.preset = 'custom';
    this.persist();
    emit(EV.WEIGHTS_CHANGED, this.weights);
    this.applyPlan(cand, { trigger: `Frontier candidate ${cand.id}` });
    if (before) {
      this.lastExplanation = explainReplan(before, cand, { trigger: `Frontier candidate ${cand.id}`, weights: this.weights });
    }
    this.logEvent('plan', `Adopted ${cand.id} from the optimisation frontier`);
    return cand;
  }

  explainRouteById(routeId) {
    const route = this.routesById.get(routeId);
    if (!route) return null;
    const vehicle = this.vehiclesById.get(route.vehicleId);
    if (!vehicle) return null;
    // Peers: the same stop set under alternative visit orders the optimiser
    // considered — reversed, and depot-nearest-first — costed identically.
    const peers = [];
    const reversed = [...route.orderIds].reverse();
    if (reversed.length > 1) {
      const alt = this.planEngine.evaluateRoute(vehicle, reversed, this.weights, route.startMinutes);
      if (alt.legs.length) peers.push(alt);
    }
    const depot = this.depotsById.get(route.depotId);
    if (depot && route.orderIds.length > 1) {
      const byDistance = [...route.orderIds].sort((a, b) => {
        const oa = this.ordersById.get(a), ob = this.ordersById.get(b);
        return haversineKm(depot.lon, depot.lat, oa.lon, oa.lat) - haversineKm(depot.lon, depot.lat, ob.lon, ob.lat);
      });
      const alt = this.planEngine.evaluateRoute(vehicle, byDistance, this.weights, route.startMinutes);
      if (alt.legs.length) peers.push(alt);
    }
    return explainRoute(route, {
      peers, weights: this.weights,
      vehicle: { ...vehicle, energyType: VEHICLE_TYPES[vehicle.type].energyType },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Weights, layers, selection, view                                  */
  /* ---------------------------------------------------------------- */

  setWeight(key, value) {
    this.weights = { ...this.weights, [key]: clamp(value, 0, 1) };
    this.preset = 'custom';
    this.persist();
    emit(EV.WEIGHTS_CHANGED, this.weights);
  }

  applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    this.weights = normaliseWeights(p);
    this.preset = key;
    this.persist();
    emit(EV.WEIGHTS_CHANGED, this.weights);
  }

  toggleLayer(key, force) {
    this.layers[key] = force != null ? force : !this.layers[key];
    this.persist();
    emit(EV.LAYERS_CHANGED, this.layers);
  }

  updateSettings(patch) {
    Object.assign(this.workspace.settings, patch);
    if (patch.osrmEndpoint !== undefined) {
      this.osrm.setEndpoint(patch.osrmEndpoint);
      this.invalidateNetwork();
      this.probeServices();
    }
    if (patch.geocodeEndpoint !== undefined) {
      this.geocode.setEndpoint(patch.geocodeEndpoint);
      this.probeServices();
    }
    this.persist();
    emit(EV.SETTINGS_CHANGED, this.workspace.settings);
  }

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

  togglePlay() { this.setSpeed(this.playing ? 0 : SIM.defaultSpeedMultiplier); }

  tick(realSeconds) {
    if (!this.ready) return;
    const simMinutes = (realSeconds * this.speedMultiplier) / 60;
    if (simMinutes > 0) {
      this.clockMinutes = Math.min(SIM.dayEndMinutes + 120, this.clockMinutes + simMinutes);
      this.advanceVehicles(simMinutes);
    }
    emit(EV.FLEET_TICK, { minutes: this.clockMinutes, simMinutes });
  }

  advanceVehicles(simMinutes) {
    let delivered = 0;
    for (const v of this.vehicles) {
      const route = this.routeByVehicle.get(v.id);
      if (!v.available) { v.status = 'disabled'; continue; }
      if (!route || !route.orderIds.length) {
        v.status = v.status === 'charging' ? 'charging' : 'idle';
        continue;
      }
      if (this.clockMinutes < route.startMinutes) { v.status = 'idle'; continue; }

      // Progress is driven by the route's own modelled schedule, so what the
      // map shows always agrees with the ETA the optimiser committed to.
      const elapsed = this.clockMinutes - route.startMinutes;
      v.progress = clamp(elapsed / Math.max(route.minutes, 1), 0, 1);

      const path = route.path && route.path.length > 1 ? route.path : null;
      if (path) {
        const at = pointAtFraction(path, v.progress);
        if (at) { v.lon = at.lon; v.lat = at.lat; v.heading = at.heading; }
      }
      v.energyLevel = clamp((v.startEnergyLevel ?? v.energyLevel) - route.energyFraction * v.progress, 0, 1);

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
              ? `${o.ref} delivered ${dur(s.late)} late to ${o.consignee}`
              : `${o.ref} delivered to ${o.consignee}`);
        } else if (this.clockMinutes >= s.arrival) {
          o.status = 'enroute';
          v.status = 'delivering';
        }
      }

      const remaining = route.stops.filter((s) => this.ordersById.get(s.orderId)?.status !== 'delivered');
      if (v.progress >= 1) v.status = v.energyLevel < 0.2 ? 'charging' : 'idle';
      else if (!remaining.length) v.status = 'returning';
      else if (v.status !== 'delivering') {
        v.status = this.clockMinutes > remaining[0].serviceStart + 4 ? 'delayed' : 'moving';
      }
      v.nextStop = remaining[0] || null;
      v.etaMinutes = remaining.length ? remaining[0].serviceStart : route.endMinutes;
    }
    if (delivered) {
      this.refreshAlerts();
      this.persist();
      emit(EV.ORDERS_CHANGED, { delivered });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scenario / digital twin                                           */
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

  /** Close the direct link between consecutive stops on a route. */
  closeRouteCorridor(routeId) {
    const route = this.routesById.get(routeId);
    if (!route || route.stops.length < 2) return 0;
    const mid = Math.floor(route.stops.length / 2);
    const a = route.stops[mid - 1], b = route.stops[mid];
    this.pendingScenario.closedRoutes.push({ from: a.orderId, to: b.orderId, routeId });
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return 1;
  }

  addIncidentNear(lon, lat, severity = 1.1, radiusKm = 6) {
    const inc = {
      id: `INC-${this.pendingScenario.incidents.length + 1}`,
      lon, lat, radiusKm, severity, label: 'Congestion event',
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
    return s.trafficMultiplier === 1 && !s.disabledVehicles.length && !s.closedRoutes.length
      && !Object.keys(s.deadlineShifts).length && !s.incidents.length;
  }

  describeScenario(s = this.pendingScenario) {
    const parts = [];
    if (s.trafficMultiplier !== 1) parts.push(`traffic ${s.trafficMultiplier > 1 ? '+' : ''}${Math.round((s.trafficMultiplier - 1) * 100)}%`);
    if (s.disabledVehicles.length) {
      parts.push(`${s.disabledVehicles.map((id) => this.vehiclesById.get(id)?.callsign || id).join(', ')} out of service`);
    }
    if (s.closedRoutes.length) parts.push(`${s.closedRoutes.length} link${s.closedRoutes.length > 1 ? 's' : ''} closed`);
    const dl = Object.keys(s.deadlineShifts).length;
    if (dl) parts.push(`${dl} deadline${dl > 1 ? 's' : ''} moved`);
    if (s.incidents.length) parts.push(`${s.incidents.length} incident zone${s.incidents.length > 1 ? 's' : ''}`);
    return parts.length ? parts.join(', ') : 'no changes staged';
  }

  async replan({ trigger } = {}) {
    if (this.optimizing) return null;
    const s = this.pendingScenario;
    const beforePlan = this.plan;
    const label = this.describeScenario(s);
    this.logEvent('scenario', `Scenario committed — ${label}`);

    this.matrix.setTrafficMultiplier(s.trafficMultiplier);
    this.matrix.clearIncidents();
    for (const inc of s.incidents) this.matrix.addIncident(inc);
    this.matrix.clearClosures();
    for (const c of s.closedRoutes) this.matrix.closeLink(c.from, c.to);
    this.planEngine.invalidate();

    for (const v of this.vehicles) {
      const was = v.available;
      v.available = !s.disabledVehicles.includes(v.id);
      if (was && !v.available) {
        this.logEvent('exception', `${v.callsign} taken out of service`);
        this.raiseAlert('high', `${v.callsign} disabled`,
          `Vehicle removed from the plan; its ${v.assignedOrders.length} orders need reassignment.`,
          { kind: 'vehicle', id: v.id });
      }
    }
    for (const [orderId, delta] of Object.entries(s.deadlineShifts)) {
      const o = this.ordersById.get(orderId);
      if (!o) continue;
      if (o.originalDeadline == null) o.originalDeadline = o.deadline;
      o.deadline = clamp(o.originalDeadline + delta, o.windowOpen + 20, SIM.dayEndMinutes + 180);
    }
    this.reindex();
    this.scenario = JSON.parse(JSON.stringify(s));

    this.logEvent('detect', `Network conditions changed — congestion index ${pct(this.matrix.networkIndex(this.clockMinutes), 0)}`);
    const impacted = beforePlan
      ? this.planEngine.buildPlan(
        new Map(beforePlan.routes.map((r) => [r.vehicleId, r.orderIds])),
        this.weights, { label: 'Existing plan under new conditions', startMinutes: this.clockMinutes },
      )
      : null;
    if (impacted) {
      this.logEvent('detect',
        `Route impact calculated — ${impacted.metrics.lateOrders} stop(s) now at risk, `
        + `${dur(impacted.metrics.minutes - beforePlan.metrics.minutes)} added fleet time`);
    }

    const plan = await this.optimizeFleet({ trigger: trigger || `Replan — ${label}`, label: 'Recovery plan' });
    if (!plan) return null;

    // Honest before/after: the OLD plan under the NEW conditions vs the new
    // plan. Comparing against the old plan's old numbers would credit the
    // optimiser with avoiding a disruption it did not cause.
    this.scenarioComparison = impacted
      ? comparePlans(impacted, plan, { labelBefore: 'Existing plan, new conditions', labelAfter: 'Re-optimised plan' })
      : null;
    this.scenarioImpacted = impacted;
    this.scenarioTrigger = label;
    this.pendingScenario = this.defaultScenario();
    emit(EV.SCENARIO_CHANGED, this.pendingScenario);
    return plan;
  }

  async whatIf(mutator, label) {
    const snapshot = {
      multiplier: this.matrix.trafficMultiplier,
      incidents: [...this.matrix.incidents],
      closures: new Set(this.matrix.closedPairs),
      availability: this.vehicles.map((v) => [v.id, v.available]),
      deadlines: this.orders.map((o) => [o.id, o.deadline]),
    };
    const before = this.plan;
    try {
      mutator(this);
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
      return {
        label,
        before,
        after: result.plan,
        comparison: comparePlans(before, result.plan, { labelBefore: 'Current plan', labelAfter: label || 'What-if' }),
        explanation: before ? explainReplan(before, result.plan, { trigger: label, weights: this.weights }) : null,
      };
    } finally {
      this.matrix.setTrafficMultiplier(snapshot.multiplier);
      this.matrix.clearIncidents();
      for (const i of snapshot.incidents) this.matrix.addIncident(i);
      this.matrix.closedPairs = snapshot.closures;
      for (const [id, avail] of snapshot.availability) {
        const v = this.vehiclesById.get(id); if (v) v.available = avail;
      }
      for (const [id, dl] of snapshot.deadlines) {
        const o = this.ordersById.get(id); if (o) o.deadline = dl;
      }
      this.reindex();
      this.planEngine.invalidate();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Alerts & log                                                      */
  /* ---------------------------------------------------------------- */

  logEvent(kind, message, meta = null) {
    const entry = {
      id: `E${this.log.length + 1}`,
      at: this.clockMinutes,
      stamp: clockSeconds(this.clockMinutes + (this.log.length % 60) / 60),
      wall: new Date().toLocaleTimeString(),
      kind, message, meta,
    };
    this.log.unshift(entry);
    if (this.log.length > this.logCap) this.log.length = this.logCap;
    emit(EV.LOG, entry);
    return entry;
  }

  raiseAlert(severity, title, detail, target = null, opts = {}) {
    const existing = this.alerts.find((a) => a.title === title && !a.dismissed);
    if (existing) { existing.detail = detail; existing.at = this.clockMinutes; return existing; }
    const alert = {
      id: `A${Date.now().toString(36)}${this.alerts.length}`,
      severity, title, detail, target,
      at: this.clockMinutes, dismissed: false, ...opts,
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

  refreshAlerts() {
    if (!this.plan) return;
    this.alerts = this.alerts.filter((a) => a.sticky || a.dismissed);

    for (const v of this.vehicles) {
      if (!v.available) continue;
      const route = this.routeByVehicle.get(v.id);
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
      if (r.worstCongestion > 1.7 && r.orderIds.length) {
        this.raiseAlert('medium', `${r.id} congestion increasing`,
          `Modelled travel times on this route are ${pct(r.worstCongestion - 1, 0)} above free flow.`,
          { kind: 'route', id: r.id });
      }
    }
    for (const id of this.plan.unserved) {
      const o = this.ordersById.get(id);
      if (!o) continue;
      this.raiseAlert('high', `${o.ref} unassigned`,
        `No vehicle can serve ${o.consignee} (${o.weightKg} kg, deadline ${clock(o.deadline)}) within constraints.`,
        { kind: 'order', id: o.id });
    }
    emit(EV.ALERTS_CHANGED, this.alerts);
  }

  activeAlerts() { return this.alerts.filter((a) => !a.dismissed); }

  /* ---------------------------------------------------------------- */
  /* Derived                                                           */
  /* ---------------------------------------------------------------- */

  heroMetrics() {
    const m = this.plan?.metrics;
    return {
      activeVehicles: this.vehicles.filter((v) => v.available && v.routeId).length,
      totalVehicles: this.vehicles.filter((v) => v.available).length,
      deliveries: this.orders.filter((o) => o.status !== 'cancelled').length,
      delivered: this.orders.filter((o) => o.status === 'delivered').length,
      onTimeRate: m ? m.onTimeRate : 1,
      co2: m ? m.co2 : 0,
      km: m ? m.km : 0,
      cost: m ? m.cost : 0,
      utilization: m ? m.utilization : 0,
      fleetUtilization: m ? m.fleetUtilization : 0,
      unserved: m ? m.unserved : 0,
      congestion: this.matrix.networkIndex(this.clockMinutes),
      clock: clock(this.clockMinutes),
    };
  }

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
      if (!v || !type) continue;
      if (dimension === 'vehicle') add(v.id, v.callsign, r.co2, { sub: type.label });
      else if (dimension === 'route') add(r.id, r.id, r.co2, { sub: `${r.stops.length} stops` });
      else if (dimension === 'vehicleType') add(type.key, type.label, r.co2, { sub: type.unit });
      else if (dimension === 'energySource') {
        add(type.energyType, { diesel: 'Diesel', cng: 'CNG', bev: 'Grid electricity' }[type.energyType], r.co2);
      } else if (dimension === 'delivery') {
        for (const s of r.stops) add(s.orderId, this.ordersById.get(s.orderId)?.ref || s.orderId, s.legCo2, { sub: s.consignee });
      } else if (dimension === 'depot') {
        add(r.depotId, this.depotsById.get(r.depotId)?.name || r.depotId, r.co2);
      } else if (dimension === 'distance') {
        const band = r.km < 25 ? '0–25 km' : r.km < 60 ? '25–60 km' : r.km < 120 ? '60–120 km' : '120+ km';
        add(band, band, r.co2);
      } else if (dimension === 'traffic') {
        const band = r.worstCongestion < 1.2 ? 'Free flow' : r.worstCongestion < 1.6 ? 'Busy' : r.worstCongestion < 2.2 ? 'Heavy' : 'Severe';
        add(band, band, r.co2);
      }
    }
    return [...groups.values()].sort((a, b) => b.value - a.value);
  }
}

export const store = new Store();
