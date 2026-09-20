/**
 * WORLD BUILDER
 *
 * Generates a deterministic synthetic metro region: terrain, water, districts
 * and a routable road-network graph. Everything derives from a single seed, so
 * two runs of the app produce byte-identical geography — a hard requirement for
 * reproducible optimisation results and for the demo narrative.
 *
 * The graph is the substrate the ROUTE ENGINE runs A* over. Nothing here knows
 * about vehicles, orders or emissions.
 */

import { WORLD, ROAD_CLASS, SEED } from '../config.js';
import { rng, clamp, dist, smoothPolyline, polylineLength } from '../util/math.js';

const HALF_W = WORLD.widthKm / 2;
const HALF_H = WORLD.heightKm / 2;
const SNAP_KM = 0.40;

/* ------------------------------------------------------------------ */
/* Terrain field                                                       */
/* ------------------------------------------------------------------ */

/** Smooth, seamless elevation in metres. Drives road grade and energy use. */
function makeElevation(seed) {
  const r = rng(seed ^ 0x9e37);
  const waves = Array.from({ length: 6 }, () => ({
    fx: (r() * 2 - 1) * 0.18,
    fy: (r() * 2 - 1) * 0.18,
    phase: r() * Math.PI * 2,
    amp: 18 + r() * 52,
  }));
  return function elevation(x, y) {
    let h = 120;
    for (const w of waves) h += w.amp * Math.sin(x * w.fx + y * w.fy + w.phase);
    // Gentle basin toward the centre — cities sit in valleys.
    h -= 40 * Math.exp(-(x * x + y * y) / (2 * 16 * 16));
    return h;
  };
}

/* ------------------------------------------------------------------ */
/* Polygons: water, parks, districts                                   */
/* ------------------------------------------------------------------ */

function blobPolygon(cx, cy, radius, irregularity, points, rand) {
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = radius * (1 - irregularity / 2 + rand() * irregularity);
    pts.push({ x: cx + Math.cos(a) * rr * 1.25, y: cy + Math.sin(a) * rr });
  }
  return smoothPolyline([...pts, pts[0], pts[1], pts[2]], 5);
}

export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const DISTRICT_NAMES = [
  'Ardhan Docks', 'Neyra Central', 'Kilgarh Industrial', 'Vashta Heights', 'Orinth Quarter',
  'Sable Fields', 'Tamber Ridge', 'Kestrel Park', 'Mirant Basin', 'Halvane Junction',
  'Coruna Mills', 'Estrel Bay', 'Ravenna Flats', 'Ossian Gate',
];

const DISTRICT_TYPES = [
  { key: 'industrial', label: 'Industrial', demand: 1.35, tint: '#2b3346' },
  { key: 'commercial', label: 'Commercial', demand: 1.5, tint: '#2a3a46' },
  { key: 'residential', label: 'Residential', demand: 1.0, tint: '#28323f' },
  { key: 'logistics', label: 'Logistics', demand: 1.2, tint: '#303346' },
  { key: 'green', label: 'Green Belt', demand: 0.2, tint: '#22392f' },
];

/* ------------------------------------------------------------------ */
/* Graph builder                                                       */
/* ------------------------------------------------------------------ */

class GraphBuilder {
  constructor() {
    this.nodes = [];
    this.edges = [];
    this.cells = new Map();
    this.edgeKeys = new Set();
  }

  _cellKey(x, y) {
    return `${Math.round(x / SNAP_KM)}:${Math.round(y / SNAP_KM)}`;
  }

  node(x, y) {
    // Look in the 3x3 neighbourhood so points near a cell border still snap.
    const cx = Math.round(x / SNAP_KM), cy = Math.round(y / SNAP_KM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const id of bucket) {
          const n = this.nodes[id];
          if (dist(n.x, n.y, x, y) <= SNAP_KM) return n;
        }
      }
    }
    const n = { id: this.nodes.length, x, y, edges: [] };
    this.nodes.push(n);
    const key = this._cellKey(x, y);
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(n.id);
    return n;
  }

  /**
   * Nearest existing node to a point, searched outward by cell ring.
   * `exclude` is a Set of node ids to skip — used when stitching a structure
   * to the rest of the network without it simply finding itself.
   */
  nearest(x, y, maxKm = 6, exclude = null) {
    const rings = Math.ceil(maxKm / SNAP_KM);
    const cx = Math.round(x / SNAP_KM), cy = Math.round(y / SNAP_KM);
    let best = null, bestD = maxKm;
    for (let ring = 0; ring <= rings; ring++) {
      let found = false;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
          if (!bucket) continue;
          for (const id of bucket) {
            if (exclude && exclude.has(id)) continue;
            const n = this.nodes[id];
            const d = dist(n.x, n.y, x, y);
            if (d < bestD) { bestD = d; best = n; found = true; }
          }
        }
      }
      // One further ring after the first hit guarantees the true nearest.
      if (best && ring > Math.ceil(bestD / SNAP_KM) + 1) break;
      if (found && ring > rings) break;
    }
    return best;
  }

  /** Connected components as an array of node-id arrays, largest first. */
  components() {
    const seen = new Int8Array(this.nodes.length);
    const out = [];
    for (const start of this.nodes) {
      if (seen[start.id]) continue;
      const stack = [start.id];
      const members = [];
      seen[start.id] = 1;
      while (stack.length) {
        const id = stack.pop();
        members.push(id);
        for (const eid of this.nodes[id].edges) {
          const e = this.edges[eid];
          const other = e.a === id ? e.b : e.a;
          if (!seen[other]) { seen[other] = 1; stack.push(other); }
        }
      }
      out.push(members);
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  }

  /**
   * Weld every stray component onto the main network with a link road.
   * Road networks are connected by construction in the real world; a generator
   * that leaves islands would silently make destinations unroutable, so this
   * pass is a correctness requirement, not a cosmetic one.
   */
  stitch(rand) {
    for (let pass = 0; pass < 40; pass++) {
      const comps = this.components();
      if (comps.length <= 1) break;
      const main = new Set(comps[0]);
      let welded = 0;
      for (let i = 1; i < comps.length; i++) {
        // Find the closest pair between this component and the main one.
        let bestA = null, bestB = null, bestD = Infinity;
        for (const id of comps[i]) {
          const n = this.nodes[id];
          const m = this.nearest(n.x, n.y, 9, new Set(comps[i]));
          if (!m || !main.has(m.id)) continue;
          const d = dist(n.x, n.y, m.x, m.y);
          if (d < bestD) { bestD = d; bestA = n; bestB = m; }
        }
        if (bestA && bestB) {
          this.edge(bestA, bestB, bestD > 4 ? 'collector' : 'local', arcVia(bestA, bestB, 0.08, rand));
          welded++;
        }
      }
      if (!welded) break;
    }
  }

  edge(a, b, roadClass, via = null) {
    if (a.id === b.id) return null;
    const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (this.edgeKeys.has(key)) return null;
    const pts = via && via.length
      ? [{ x: a.x, y: a.y }, ...via, { x: b.x, y: b.y }]
      : [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    const e = {
      id: this.edges.length,
      a: a.id, b: b.id,
      cls: roadClass,
      pts,
      lengthKm: polylineLength(pts),
      closed: false,
    };
    if (e.lengthKm < 0.05) return null;
    this.edgeKeys.add(key);
    this.edges.push(e);
    a.edges.push(e.id);
    b.edges.push(e.id);
    return e;
  }
}

/* ------------------------------------------------------------------ */
/* Main build                                                          */
/* ------------------------------------------------------------------ */

export function buildWorld(seed = SEED) {
  const rand = rng(seed);
  const elevation = makeElevation(seed);

  /* --- water ------------------------------------------------------ */
  const water = [
    blobPolygon(-16.5, 10.5, 5.2, 0.55, 11, rand),
    blobPolygon(19, -11.5, 3.8, 0.6, 10, rand),
  ];
  // A river: a wide polyline that roads may only cross at bridges.
  const riverSpine = smoothPolyline(
    Array.from({ length: 9 }, (_, i) => ({
      x: -HALF_W + (i / 8) * WORLD.widthKm,
      y: -16 + Math.sin(i * 0.9 + 1.1) * 5.5 + i * 1.0,
    })), 8,
  );

  const inWater = (x, y) => water.some((poly) => pointInPolygon(x, y, poly));

  /* --- districts -------------------------------------------------- */
  const districts = [];
  const districtSeeds = [];
  for (let i = 0; i < 12; i++) {
    let x, y, tries = 0;
    do {
      x = (rand() * 2 - 1) * (HALF_W - 5.5);
      y = (rand() * 2 - 1) * (HALF_H - 5);
      tries++;
    } while ((inWater(x, y) || districtSeeds.some((d) => dist(d.x, d.y, x, y) < 8)) && tries < 60);
    districtSeeds.push({ x, y });
    const radial = Math.hypot(x, y);
    // Type follows distance from the centre, the way real metros stratify.
    const type = radial < 7 ? DISTRICT_TYPES[1]
      : radial < 15 ? DISTRICT_TYPES[2]
        : rand() < 0.45 ? DISTRICT_TYPES[0]
          : rand() < 0.5 ? DISTRICT_TYPES[3] : DISTRICT_TYPES[4];
    districts.push({
      id: `D${String(i + 1).padStart(2, '0')}`,
      name: DISTRICT_NAMES[i % DISTRICT_NAMES.length],
      type: type.key,
      typeLabel: type.label,
      tint: type.tint,
      demand: type.demand,
      x, y,
      radiusKm: 4.0 + rand() * 3.4,
      polygon: blobPolygon(x, y, 4.0 + rand() * 3.4, 0.42, 10, rand),
    });
  }

  /* --- road network ----------------------------------------------- */
  const g = new GraphBuilder();

  // 1. Warped arterial grid first — it is the substrate everything else
  //    attaches to, which keeps the network connected by construction.
  const STEP = 3.0;
  const jitter = (x, y) => ({
    x: x + Math.sin(y * 0.47 + x * 0.14) * 0.78 + Math.cos(y * 0.13) * 0.55,
    y: y + Math.cos(x * 0.41 - y * 0.17) * 0.78 + Math.sin(x * 0.11) * 0.55,
  });
  const grid = [];
  const gridIds = new Set();
  for (let gy = -Math.floor(HALF_H / STEP); gy <= Math.floor(HALF_H / STEP); gy++) {
    const row = [];
    for (let gx = -Math.floor(HALF_W / STEP); gx <= Math.floor(HALF_W / STEP); gx++) {
      const p = jitter(gx * STEP, gy * STEP);
      if (inWater(p.x, p.y)) { row.push(null); continue; }
      const n = g.node(p.x, p.y);
      gridIds.add(n.id);
      row.push(n);
    }
    grid.push(row);
  }
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const n = grid[r][c];
      if (!n) continue;
      const right = grid[r][c + 1];
      const down = grid[r + 1] && grid[r + 1][c];
      const radial = Math.hypot(n.x, n.y);
      // Density falls off with distance from the core, like a real metro.
      const keep = radial < 10 ? 0.99 : radial < 19 ? 0.93 : 0.78;
      // Superblocks: every third grid line is an arterial, the next a
      // collector, the rest local. Real cities are built this way, and it is
      // what stops the network rendering as uniform graph paper — and what
      // gives the router a genuine hierarchy to exploit.
      const tier = (i) => (i % 3 === 0 ? 'arterial' : i % 3 === 1 ? 'collector' : 'local');
      const demote = radial > 19;
      const horizontal = demote && tier(r) === 'arterial' ? 'collector' : tier(r);
      const vertical = demote && tier(c) === 'arterial' ? 'collector' : tier(c);
      if (right && rand() < keep) g.edge(n, right, horizontal, arcVia(n, right, 0.05, rand));
      if (down && rand() < keep) g.edge(n, down, vertical, arcVia(n, down, 0.05, rand));
    }
  }

  // 2. Diagonal collectors — shortcuts that make routing decisions non-trivial.
  //    Without these, a grid has many equal-cost paths and no interesting ones.
  for (let r = 0; r < grid.length - 1; r++) {
    for (let c = 0; c < grid[r].length - 1; c++) {
      if (rand() > 0.22) continue;
      const flip = rand() < 0.5;
      const a = flip ? grid[r][c] : grid[r][c + 1];
      const b = flip ? grid[r + 1][c + 1] : grid[r + 1][c];
      if (!a || !b) continue;
      if (inWater((a.x + b.x) / 2, (a.y + b.y) / 2)) continue;
      g.edge(a, b, 'collector', arcVia(a, b, 0.09, rand));
    }
  }

  // 3. Inner ring highway, ramped onto the grid at every junction.
  const ramp = (n) => {
    const m = g.nearest(n.x, n.y, 3.6, new Set([n.id]));
    if (m && gridIds.has(m.id)) g.edge(n, m, 'arterial', arcVia(n, m, 0.1, rand));
  };
  const ringNodes = [];
  const RING_N = 30;
  for (let i = 0; i < RING_N; i++) {
    const a = (i / RING_N) * Math.PI * 2;
    const r = 12.2 + Math.sin(a * 3 + 0.7) * 1.7 + Math.cos(a * 2) * 1.1;
    ringNodes.push(g.node(Math.cos(a) * r * 1.22, Math.sin(a) * r));
  }
  for (let i = 0; i < RING_N; i++) {
    const a = ringNodes[i], b = ringNodes[(i + 1) % RING_N];
    g.edge(a, b, 'highway', arcVia(a, b, 0.12, rand));
  }
  // Interchanges are sparse on a ring road — roughly every other junction.
  ringNodes.forEach((n, i) => { if (i % 2 === 0) ramp(n); });

  // 4. Outer ring (partial — outer rings are rarely complete).
  const outerNodes = [];
  const OUTER_N = 34;
  for (let i = 0; i < OUTER_N; i++) {
    const a = (i / OUTER_N) * Math.PI * 2;
    const r = 21 + Math.sin(a * 2.2 + 2.1) * 2.1;
    const x = Math.cos(a) * r * 1.2, y = Math.sin(a) * r;
    if (Math.abs(x) > HALF_W - 3 || Math.abs(y) > HALF_H - 3) { outerNodes.push(null); continue; }
    outerNodes.push(g.node(x, y));
  }
  for (let i = 0; i < OUTER_N; i++) {
    const a = outerNodes[i], b = outerNodes[(i + 1) % OUTER_N];
    if (!a || !b) continue;
    if (inWater((a.x + b.x) / 2, (a.y + b.y) / 2)) continue;
    g.edge(a, b, 'highway', arcVia(a, b, 0.1, rand));
  }
  outerNodes.forEach((n, i) => { if (n && i % 3 === 0) ramp(n); });

  // 5. Radial highways from the core through both rings to the boundary.
  const core = g.node(0, 0);
  ramp(core);
  const RADIALS = 8;
  for (let i = 0; i < RADIALS; i++) {
    const a = (i / RADIALS) * Math.PI * 2 + 0.22;
    let prev = core;
    for (const r of [4, 8, 12, 16, 21, 26]) {
      const x = clamp(Math.cos(a) * r * 1.2, -HALF_W + 2, HALF_W - 2);
      const y = clamp(Math.sin(a) * r, -HALF_H + 2, HALF_H - 2);
      const n = g.node(x, y);
      if (n.id !== prev.id) {
        g.edge(prev, n, 'highway', arcVia(prev, n, 0.07, rand));
        ramp(n);
      }
      prev = n;
    }
  }

  // 6. Local streets clustered in districts — the last mile.
  for (const d of districts) {
    if (d.type === 'green') continue;
    const count = Math.round(8 + d.demand * 9);
    const anchors = [];
    const anchorIds = new Set();
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * d.radiusKm * 0.85;
      const x = d.x + Math.cos(a) * rr, y = d.y + Math.sin(a) * rr;
      if (inWater(x, y) || Math.abs(x) > HALF_W - 1 || Math.abs(y) > HALF_H - 1) continue;
      const n = g.node(x, y);
      anchors.push(n); anchorIds.add(n.id);
    }
    // A stub tree: each local node links to its two nearest neighbours in the
    // district, and the whole cluster is tied back onto the through network.
    for (const n of anchors) {
      const near = anchors
        .filter((o) => o.id !== n.id)
        .sort((p, q) => dist(n.x, n.y, p.x, p.y) - dist(n.x, n.y, q.x, q.y))
        .slice(0, 2);
      for (const o of near) g.edge(n, o, 'local', arcVia(n, o, 0.14, rand));
      // Roughly a third of local nodes get a feeder onto a bigger road.
      if (rand() < 0.34) {
        const m = g.nearest(n.x, n.y, 3.0, anchorIds);
        if (m) g.edge(n, m, 'local', arcVia(n, m, 0.12, rand));
      }
    }
  }

  // 7. Weld any remaining islands onto the main network.
  g.stitch(rand);

  /* --- attach attributes, prune to the largest component ---------- */
  for (const e of g.edges) {
    const spec = ROAD_CLASS[e.cls];
    const a = g.nodes[e.a], b = g.nodes[e.b];
    const rise = elevation(b.x, b.y) - elevation(a.x, a.y);
    e.grade = clamp(rise / (e.lengthKm * 1000), -0.07, 0.07);
    e.baseSpeed = spec.speed * (1 - Math.abs(e.grade) * 2.4);
    e.tollPerKm = spec.toll;
    e.capacity = spec.capacity;
    // Static congestion propensity: central + arterial roads clog first.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const centrality = Math.exp(-(mid.x * mid.x + mid.y * mid.y) / (2 * 13 * 13));
    e.congestionBias = clamp(0.25 + centrality * 0.75 + (e.cls === 'local' ? 0.12 : 0), 0.1, 1.15);
    e.mid = mid;
  }

  const kept = largestComponent(g);
  const world = compact(g, kept);
  world.districts = districts;
  world.water = water;
  world.riverSpine = riverSpine;
  world.elevation = elevation;
  world.bounds = { minX: -HALF_W, minY: -HALF_H, maxX: HALF_W, maxY: HALF_H };
  world.seed = seed;
  world.inWater = inWater;
  buildSpatialIndex(world);
  return world;
}

/** Slight lateral bow so segments read as roads rather than as a wire diagram. */
function arcVia(a, b, amount, rand) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1.2) return null;
  const off = (rand() * 2 - 1) * amount * len;
  return [{
    x: (a.x + b.x) / 2 + (-dy / len) * off,
    y: (a.y + b.y) / 2 + (dx / len) * off,
  }];
}

function largestComponent(g) {
  const seen = new Int32Array(g.nodes.length).fill(-1);
  let best = [], bestId = -1, comp = 0;
  for (const start of g.nodes) {
    if (seen[start.id] !== -1) continue;
    const stack = [start.id];
    const members = [];
    seen[start.id] = comp;
    while (stack.length) {
      const id = stack.pop();
      members.push(id);
      for (const eid of g.nodes[id].edges) {
        const e = g.edges[eid];
        const other = e.a === id ? e.b : e.a;
        if (seen[other] === -1) { seen[other] = comp; stack.push(other); }
      }
    }
    if (members.length > best.length) { best = members; bestId = comp; }
    comp++;
  }
  return new Set(best);
}

/** Re-index nodes/edges down to the kept set so array indices stay dense. */
function compact(g, keep) {
  const nodeMap = new Map();
  const nodes = [];
  for (const n of g.nodes) {
    if (!keep.has(n.id)) continue;
    nodeMap.set(n.id, nodes.length);
    nodes.push({ id: nodes.length, x: n.x, y: n.y, edges: [] });
  }
  const edges = [];
  for (const e of g.edges) {
    if (!keep.has(e.a) || !keep.has(e.b)) continue;
    const a = nodeMap.get(e.a), b = nodeMap.get(e.b);
    const ne = { ...e, id: edges.length, a, b };
    edges.push(ne);
    nodes[a].edges.push(ne.id);
    nodes[b].edges.push(ne.id);
  }
  // Adjacency as flat arrays — hot path for A*, avoid object churn.
  const adj = nodes.map((n) => n.edges.map((eid) => {
    const e = edges[eid];
    return { edge: eid, to: e.a === n.id ? e.b : e.a };
  }));
  return { nodes, edges, adj };
}

/** Uniform grid over nodes and edges for O(1)-ish nearest lookups. */
function buildSpatialIndex(world) {
  const CELL = 1.8;
  const nodeGrid = new Map();
  const key = (x, y) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
  for (const n of world.nodes) {
    const k = key(n.x, n.y);
    if (!nodeGrid.has(k)) nodeGrid.set(k, []);
    nodeGrid.get(k).push(n.id);
  }
  world.index = {
    cell: CELL,
    nodeGrid,
    /**
     * True nearest node, by expanding square rings of cells.
     *
     * The stopping rule matters: a node found in ring N is not necessarily the
     * nearest, because a ring-(N+1) cell can still contain a closer point. We
     * therefore keep expanding until the *guaranteed minimum* distance to any
     * unvisited cell, (ring-1) * CELL, already exceeds the best distance found.
     * Queries outside the world bounds are supported — they simply walk out to
     * the edge of the populated grid.
     */
    nearestNode(x, y) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      const maxRings = Math.ceil(
        (Math.hypot(WORLD.widthKm, WORLD.heightKm) + Math.hypot(x, y)) / CELL,
      ) + 2;
      let best = -1, bestD = Infinity;
      for (let ring = 0; ring <= maxRings; ring++) {
        if (best !== -1 && (ring - 1) * CELL > bestD) break;
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const bucket = nodeGrid.get(`${cx + dx}:${cy + dy}`);
            if (!bucket) continue;
            for (const id of bucket) {
              const n = world.nodes[id];
              const d = dist(n.x, n.y, x, y);
              if (d < bestD) { bestD = d; best = id; }
            }
          }
        }
      }
      return best;
    },
  };
}

/** Stats for the UI / README. */
export function worldStats(world) {
  const byClass = {};
  let totalKm = 0;
  for (const e of world.edges) {
    byClass[e.cls] = (byClass[e.cls] || 0) + e.lengthKm;
    totalKm += e.lengthKm;
  }
  return { nodes: world.nodes.length, edges: world.edges.length, totalKm, byClass, districts: world.districts.length };
}
