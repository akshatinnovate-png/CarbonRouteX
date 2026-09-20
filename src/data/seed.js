/**
 * DEMO DATASET
 *
 * Deterministic warehouses, fleet and order book. Seeded from the same value as
 * the world, so the entire scenario — geography, fleet, demand — reproduces
 * exactly on every load. This is DEMO data; see README "Data & Privacy".
 */

import { SEED, VEHICLE_TYPES, PRIORITY, SIM } from '../config.js';
import { rng, clamp, dist, pick, gauss } from '../util/math.js';

const CONSIGNEES = [
  'Vantiq Retail', 'Norlund Foods', 'Astra Pharma', 'Kessel Components', 'Bluehaven Grocers',
  'Prakash Textiles', 'Ironline Tools', 'Meridian Clinic', 'Solace Interiors', 'Corvid Electronics',
  'Highgate Cafe Group', 'Sundara Ceramics', 'Halcyon Labs', 'Tallow & Co.', 'Ridgeback Auto',
  'Nimbus Print', 'Ferris Cold Store', 'Ocelot Sports', 'Arbor Garden Centre', 'Kite Stationers',
  'Vesper Bakery', 'Dunmore Hardware', 'Selkie Seafood', 'Pallas Optics', 'Rowan Brewing',
  'Castellan Books', 'Quill Paper Co.', 'Vermillion Paints', 'Tanager Toys', 'Brightwater Dairy',
];

const DRIVERS = [
  'A. Rahman', 'S. Iyer', 'M. Okonkwo', 'P. Varga', 'L. Chen', 'D. Mbeki', 'R. Kaur',
  'T. Novak', 'J. Alvarez', 'N. Haddad', 'K. Tanaka', 'E. Lindqvist',
];

const GOODS = [
  'Ambient palletised', 'Chilled 2-8°C', 'Fragile electronics', 'Bulk hardware',
  'Pharma (temp-logged)', 'Mixed retail', 'Documents & small parcels', 'Beverages',
];

/* ------------------------------------------------------------------ */

export function buildDepots(world, seed = SEED) {
  const rand = rng(seed ^ 0xd3);
  // Prefer logistics/industrial districts, spread apart, and always snap to the
  // graph so a depot is guaranteed routable.
  const candidates = world.districts
    .filter((d) => d.type === 'logistics' || d.type === 'industrial')
    .concat(world.districts.filter((d) => d.type === 'commercial'));
  const chosen = [];
  for (const d of candidates) {
    if (chosen.length >= 3) break;
    if (chosen.some((c) => dist(c.x, c.y, d.x, d.y) < 15)) continue;
    chosen.push(d);
  }
  while (chosen.length < 3) {
    const d = pick(world.districts, rand);
    if (!chosen.includes(d)) chosen.push(d);
  }
  const names = ['Northgate DC', 'Riverside Hub', 'Southline Depot'];
  return chosen.map((d, i) => {
    const nodeId = world.index.nearestNode(d.x, d.y);
    const node = world.nodes[nodeId];
    return {
      id: `W${i + 1}`,
      name: names[i] || `Depot ${i + 1}`,
      district: d.name,
      x: node.x, y: node.y,
      nodeId,
      dockCount: 4 + Math.floor(rand() * 5),
      openMinutes: SIM.dayStartMinutes - 60,
      closeMinutes: SIM.dayEndMinutes + 60,
    };
  });
}

export function buildFleet(world, depots, seed = SEED) {
  const rand = rng(seed ^ 0xf1ee7);
  const mix = [
    'ev_van', 'ev_van', 'ev_truck', 'diesel_truck', 'diesel_truck',
    'cng_truck', 'diesel_van', 'ev_truck', 'diesel_van', 'cng_truck',
  ];
  return mix.map((typeKey, i) => {
    const type = VEHICLE_TYPES[typeKey];
    const depot = depots[i % depots.length];
    const label = type.icon === 'truck' ? 'TRUCK' : 'VAN';
    return {
      id: `V${String(i + 1).padStart(2, '0')}`,
      callsign: `${label} ${String(i + 1).padStart(2, '0')}`,
      type: typeKey,
      typeLabel: type.label,
      driver: DRIVERS[i % DRIVERS.length],
      capacityKg: type.capacityKg,
      energyType: type.energyType,
      energyLevel: clamp(0.62 + rand() * 0.36, 0, 1),
      depotId: depot.id,
      homeNode: depot.nodeId,
      x: depot.x, y: depot.y,
      heading: 0,
      status: 'idle',          // idle|moving|delivering|charging|returning|delayed|disabled
      available: true,
      assignedOrders: [],
      routeId: null,
      progressKm: 0,
      telemetry: { odometerKm: Math.round(28000 + rand() * 90000), lastServiceKm: 0, tyreHealth: 0.7 + rand() * 0.3 },
    };
  });
}

export function buildOrders(world, depots, seed = SEED, count = 26) {
  const rand = rng(seed ^ 0x0de5);
  const weighted = [];
  for (const d of world.districts) {
    if (d.type === 'green') continue;
    const n = Math.max(1, Math.round(d.demand * 4));
    for (let i = 0; i < n; i++) weighted.push(d);
  }
  const orders = [];
  for (let i = 0; i < count; i++) {
    const d = pick(weighted, rand);
    // Sample inside the district, then snap to the nearest routable node.
    let x, y, nodeId, tries = 0;
    do {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * d.radiusKm * 0.9;
      x = d.x + Math.cos(a) * rr;
      y = d.y + Math.sin(a) * rr;
      nodeId = world.index.nearestNode(x, y);
      tries++;
    } while (nodeId < 0 && tries < 20);
    if (nodeId < 0) continue;
    const node = world.nodes[nodeId];

    const pr = rand();
    const priority = pr < 0.12 ? PRIORITY.critical
      : pr < 0.34 ? PRIORITY.high
        : pr < 0.84 ? PRIORITY.standard : PRIORITY.economy;

    // Heavier freight goes to industrial/logistics zones; retail gets parcels.
    const heavy = d.type === 'industrial' || d.type === 'logistics';
    const weightKg = Math.round(clamp(
      (heavy ? 320 + gauss(rand) * 1500 : 40 + gauss(rand) * 420) * (0.6 + rand()), 15, 2600,
    ));

    // Deadlines: critical orders get tight windows, economy gets the whole day.
    const openEarly = SIM.dayStartMinutes + Math.floor(rand() * 90);
    const span = priority.key === 'critical' ? 150 + rand() * 90
      : priority.key === 'high' ? 240 + rand() * 120
        : priority.key === 'standard' ? 380 + rand() * 160 : 560 + rand() * 120;

    orders.push({
      id: `ORD-${String(101 + i)}`,
      consignee: CONSIGNEES[i % CONSIGNEES.length],
      goods: pick(GOODS, rand),
      districtId: d.id,
      district: d.name,
      x: node.x, y: node.y,
      nodeId,
      priority: priority.key,
      weightKg,
      volumeM3: Math.round((weightKg / 180) * 10) / 10,
      windowOpen: openEarly,
      deadline: Math.min(SIM.dayEndMinutes, Math.round(openEarly + span)),
      serviceMinutes: Math.round(4 + (weightKg / 300) + rand() * 5),
      status: 'pending',        // pending|assigned|enroute|delivered|failed|unserved
      assignedVehicle: null,
      routeId: null,
      etaMinutes: null,
      deliveredAt: null,
      createdAt: SIM.dayStartMinutes,
      origin: depots[Math.floor(rand() * depots.length)].id,
      notes: null,
    });
  }
  return orders;
}

/** Build the whole demo dataset in one call. */
export function buildDataset(world, seed = SEED) {
  const depots = buildDepots(world, seed);
  const vehicles = buildFleet(world, depots, seed);
  const orders = buildOrders(world, depots, seed);
  return { depots, vehicles, orders };
}

/** A fresh urgent order near the network core — used by Simulation Mode. */
export function makeUrgentOrder(world, depots, index, rand = Math.random) {
  const d = pick(world.districts.filter((x) => x.type !== 'green'), rand);
  const a = rand() * Math.PI * 2;
  const rr = Math.sqrt(rand()) * d.radiusKm * 0.8;
  const nodeId = world.index.nearestNode(d.x + Math.cos(a) * rr, d.y + Math.sin(a) * rr);
  const node = world.nodes[nodeId];
  return {
    id: `ORD-${String(900 + index)}`,
    consignee: pick(CONSIGNEES, rand),
    goods: 'Expedited parcel',
    districtId: d.id,
    district: d.name,
    x: node.x, y: node.y,
    nodeId,
    priority: 'critical',
    weightKg: Math.round(40 + rand() * 260),
    volumeM3: 0.6,
    windowOpen: SIM.dayStartMinutes,
    deadline: SIM.dayStartMinutes + 210,
    serviceMinutes: 5,
    status: 'pending',
    assignedVehicle: null,
    routeId: null,
    etaMinutes: null,
    deliveredAt: null,
    createdAt: SIM.dayStartMinutes,
    origin: depots[0].id,
    notes: 'Injected by Simulation Mode',
    injected: true,
  };
}
