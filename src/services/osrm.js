/**
 * OSRM ROUTING CLIENT — real road routing, no API key.
 *
 * Uses the public Open Source Routing Machine service, which routes over real
 * OpenStreetMap road geometry. Two endpoints matter:
 *
 *   /table  — an N x N duration and distance matrix in ONE request. This is
 *             what the vehicle-routing optimiser runs against, and requesting
 *             it as a single call instead of N^2 route lookups is the
 *             difference between one request and eight hundred.
 *   /route  — the real road polyline for a specific sequence of stops, used
 *             to draw what the fleet will actually drive.
 *
 * The public demo server is rate-limited and offers no uptime guarantee, so
 * everything here is cached, de-duplicated, retried with backoff, and fails
 * into a clearly-labelled straight-line estimate rather than breaking the app.
 */

import { decodePolyline, haversineKm } from '../render/mercator.js';

const DEFAULT_ENDPOINT = 'https://router.project-osrm.org';
/** The demo server accepts at most 100 coordinates in one table request. */
const MAX_TABLE_COORDS = 90;

/* --- Finding genuinely different roads ------------------------------------
 *
 * OSRM's `alternatives` parameter is far more conservative than people expect.
 * It only returns a candidate that passes its sharing, stretch and detour
 * filters, and on the public demo server the usual answer to "give me three
 * roads" is one road. That is a property of the request, not of the world:
 * between most real pairs of places there are several sensible ways to go.
 *
 * So when the direct request comes back thin, we ask better questions instead
 * of accepting the first answer: route again through via points offset
 * sideways from the straight line. The router snaps each via point to the
 * nearest real road and returns a real road route through it, which is how a
 * genuinely different corridor — the ring road, the coastal road, the one over
 * the bridge — gets discovered. Nothing here invents geometry; every road
 * returned is one the routing service produced.
 */

/** How many via-point probes to spend before giving up. */
const VIA_PROBES = 8;
/** Probes are fired in small batches: a free public service, not a load test. */
const PROBE_BATCH = 3;
/** Stop probing once this many genuinely distinct roads are in hand. */
const TARGET_ROUTES = 5;
/** Two roads overlapping more than this fraction of their length are one road. */
const SAME_ROAD_OVERLAP = 0.8;
/** A road this much slower than the fastest is a detour, not a choice. */
const MAX_STRETCH = 1.9;

export class OsrmService {
  constructor({ endpoint = DEFAULT_ENDPOINT, profile = 'driving' } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.profile = profile;
    this.routeCache = new Map();
    this.inFlight = new Map();
    this.stats = { tableRequests: 0, routeRequests: 0, failures: 0, cacheHits: 0 };
    this.lastError = null;
    this.available = null; // null = untested, true/false once we know
  }

  setEndpoint(endpoint) {
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.routeCache.clear();
    this.available = null;
  }

  /* ---------------------------------------------------------------- */

  async _fetch(url, { timeoutMs = 20000, retries = 2 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        clearTimeout(timer);
        if (res.status === 429) {
          // Rate limited: back off rather than hammering a free service.
          await sleep(900 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(`routing service returned ${res.status}`);
        const json = await res.json();
        if (json.code && json.code !== 'Ok') throw new Error(`routing service: ${json.code}`);
        this.available = true;
        this.lastError = null;
        return json;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < retries) await sleep(600 * (attempt + 1));
      }
    }
    this.stats.failures++;
    this.available = false;
    this.lastError = lastErr?.name === 'AbortError'
      ? 'The routing service timed out.'
      : lastErr?.message || 'The routing service could not be reached.';
    throw lastErr || new Error(this.lastError);
  }

  /* ---------------------------------------------------------------- */
  /* Matrix                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Full travel-time and distance matrix between every pair of stops.
   *
   * @param {{lon:number, lat:number}[]} points
   * @returns {Promise<{ durations:number[][], distances:number[][], estimated:boolean, note?:string }>}
   *          durations in seconds, distances in metres.
   */
  async matrix(points) {
    if (points.length < 2) {
      return { durations: [[0]], distances: [[0]], estimated: false };
    }
    if (points.length > MAX_TABLE_COORDS) {
      // Beyond the public server's limit the honest thing is to say so rather
      // than silently returning a worse answer.
      return {
        ...straightLineMatrix(points),
        estimated: true,
        note: `This plan has ${points.length} stops; the free routing service accepts ${MAX_TABLE_COORDS} per request. `
          + 'Distances below are straight-line estimates. Reduce the stop count or point Settings at your own OSRM instance for real road distances.',
      };
    }

    const coords = points.map((p) => `${round6(p.lon)},${round6(p.lat)}`).join(';');
    const url = `${this.endpoint}/table/v1/${this.profile}/${coords}?annotations=duration,distance`;
    try {
      this.stats.tableRequests++;
      const json = await this._fetch(url, { timeoutMs: 30000 });
      if (!json.durations) throw new Error('routing service returned no durations');
      // OSRM returns null for unreachable pairs; fill those with an estimate so
      // the optimiser sees a finite (bad) cost rather than NaN.
      const fallback = straightLineMatrix(points);
      const durations = json.durations.map((row, i) => row.map((v, j) => (v == null ? fallback.durations[i][j] : v)));
      const distances = (json.distances || fallback.distances)
        .map((row, i) => row.map((v, j) => (v == null ? fallback.distances[i][j] : v)));
      return { durations, distances, estimated: false };
    } catch (err) {
      return {
        ...straightLineMatrix(points),
        estimated: true,
        note: `${this.lastError || err.message} Distances shown are straight-line estimates until the service responds.`,
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Route geometry                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Real road geometry through an ordered list of stops.
   * @returns {Promise<{ points:{lon,lat}[], km:number, minutes:number, legs:any[], estimated:boolean }>}
   */
  async route(points) {
    if (points.length < 2) return { points: points.slice(), km: 0, minutes: 0, legs: [], estimated: false };
    const key = points.map((p) => `${round6(p.lon)},${round6(p.lat)}`).join(';');
    const cached = this.routeCache.get(key);
    if (cached) { this.stats.cacheHits++; return cached; }
    // Collapse duplicate concurrent requests for the same geometry.
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const url = `${this.endpoint}/route/v1/${this.profile}/${key}`
      + '?overview=full&geometries=polyline6&steps=false&annotations=false';

    const task = (async () => {
      try {
        this.stats.routeRequests++;
        const json = await this._fetch(url);
        const r = json.routes?.[0];
        if (!r) throw new Error('routing service returned no route');
        const result = {
          points: decodePolyline(r.geometry, 6),
          km: r.distance / 1000,
          minutes: r.duration / 60,
          legs: (r.legs || []).map((l) => ({ km: l.distance / 1000, minutes: l.duration / 60 })),
          estimated: false,
        };
        if (this.routeCache.size > 600) {
          let drop = 150;
          for (const k of this.routeCache.keys()) { this.routeCache.delete(k); if (--drop <= 0) break; }
        }
        this.routeCache.set(key, result);
        return result;
      } catch {
        // Straight lines between stops, explicitly flagged as an estimate so
        // the UI can say the geometry is not a real road path.
        const km = straightLineKm(points);
        const result = {
          points: points.slice(),
          km,
          minutes: (km / assumedSpeedKmh(km)) * 60,
          legs: [],
          estimated: true,
        };
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Several genuinely different road routes between two points.
   *
   * OSRM returns alternatives only when they exist and are meaningfully
   * distinct, so this can legitimately come back with one route: two points a
   * kilometre apart on a single arterial have one sensible path, and inventing
   * three would be a lie. Callers must handle a short list.
   */
  /**
   * Several genuinely different road routes between two points.
   *
   * Strategy, in order: ask the router for alternatives; if it returns fewer
   * distinct roads than we want, probe with via points offset sideways from
   * the direct line until it does or until the probe budget runs out. Results
   * are de-duplicated by how much geometry they actually share, so two
   * near-identical roads never appear as two choices.
   *
   * This can still legitimately come back with one route — a village at the
   * end of a single valley road has one way in, and inventing a second would
   * be a lie. Callers must handle a short list.
   */
  async routeAlternatives(points, { alternatives = 3, probes = VIA_PROBES, want = TARGET_ROUTES } = {}) {
    if (points.length < 2) return [];
    const key = points.map((p) => `${round6(p.lon)},${round6(p.lat)}`).join(';');
    const cacheKey = `alt:${want}:${key}`;
    const cached = this.routeCache.get(cacheKey);
    if (cached) { this.stats.cacheHits++; return cached; }
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey);

    const task = (async () => {
      const kept = [];

      /** Keep a road only if it is not one we already have. */
      const keep = (raw, via) => {
        const pts = decodePolyline(raw.geometry, 6);
        if (pts.length < 2) return false;
        const sig = geometrySignature(pts);
        for (const k of kept) if (overlapRatio(sig, k.sig) > SAME_ROAD_OVERLAP) return false;
        kept.push({
          points: pts,
          sig,
          km: raw.distance / 1000,
          minutes: raw.duration / 60,
          estimated: false,
          via: !!via,
          roads: namedRoads(raw),
          steps: maneuvers(raw),
        });
        return true;
      };

      // `steps=true` costs a bigger response but buys the road names, which is
      // the difference between six anonymous rows of numbers and six routes
      // somebody recognises. The fleet's geometry request stays lean.
      const routeUrl = (coords, extra = '') => `${this.endpoint}/route/v1/${this.profile}/${coords}`
        + `?overview=full&geometries=polyline6&steps=true${extra}`;

      try {
        this.stats.routeRequests++;
        const json = await this._fetch(routeUrl(key, `&alternatives=${alternatives}`));
        for (const r of json.routes || []) keep(r, false);
      } catch {
        // The service is unreachable. One clearly-flagged straight-line
        // estimate, never a fabricated set of "alternatives" that do not exist.
        const km = straightLineKm(points);
        return [{
          id: 'alt-0', points: points.slice(), km,
          minutes: (km / assumedSpeedKmh(km)) * 60, estimated: true, via: false,
        }];
      } finally {
        this.inFlight.delete(cacheKey);
      }

      if (!kept.length) {
        const km = straightLineKm(points);
        return [{
          id: 'alt-0', points: points.slice(), km,
          minutes: (km / assumedSpeedKmh(km)) * 60, estimated: true, via: false,
        }];
      }

      // Probing only makes sense for a simple A-to-B journey; a multi-stop
      // sequence already has its shape fixed by its waypoints.
      if (points.length === 2 && kept.length < want && probes > 0) {
        const candidates = viaCandidates(points[0], points[1], probes);
        for (let i = 0; i < candidates.length && kept.length < want; i += PROBE_BATCH) {
          const batch = candidates.slice(i, i + PROBE_BATCH);
          const results = await Promise.all(batch.map(async (via) => {
            const coords = `${round6(points[0].lon)},${round6(points[0].lat)}`
              + `;${round6(via.lon)},${round6(via.lat)}`
              + `;${round6(points[1].lon)},${round6(points[1].lat)}`;
            try {
              this.stats.routeRequests++;
              // One attempt each: a probe is opportunistic, and retrying eight
              // of them against a free service would be rude and slow.
              const json = await this._fetch(routeUrl(coords), { retries: 0, timeoutMs: 12000 });
              return json.routes?.[0] || null;
            } catch {
              return null;
            }
          }));
          // Every probe in a batch failing means the service is unhappy with
          // us, not that these particular roads do not exist. Stop asking.
          if (results.every((r) => !r)) break;
          for (const r of results) if (r) keep(r, true);
        }
      }

      // A road far slower than the fastest is a detour somebody would regret,
      // not a choice they would weigh. The fastest is always kept.
      kept.sort((a, b) => a.minutes - b.minutes);
      const limit = kept[0].minutes * MAX_STRETCH;
      const routes = kept.filter((r, i) => i === 0 || r.minutes <= limit)
        .map((r, i) => ({
          id: `alt-${i}`,
          points: r.points,
          km: r.km,
          minutes: r.minutes,
          estimated: false,
          via: r.via,
          roads: r.roads,
          steps: r.steps,
        }));

      if (this.routeCache.size > 600) {
        let drop = 150;
        for (const k of this.routeCache.keys()) { this.routeCache.delete(k); if (--drop <= 0) break; }
      }
      this.routeCache.set(cacheKey, routes);
      return routes;
    })();

    this.inFlight.set(cacheKey, task);
    return task;
  }

  /** Cheap liveness probe used by Settings and the setup wizard. */
  async probe() {
    try {
      await this._fetch(`${this.endpoint}/route/v1/${this.profile}/13.388860,52.517037;13.397634,52.529407?overview=false`, {
        timeoutMs: 9000, retries: 0,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: this.lastError || err.message };
    }
  }
}

/* ------------------------------------------------------------------ */

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Straight-line fallback. Real road distance is typically 25-40% longer than
 * the great-circle distance in a built-up area, so the detour factor below is
 * applied to keep estimates in the right ballpark — and every consumer of this
 * data is told it is an estimate.
 */
export const DETOUR_FACTOR = 1.32;

/**
 * Assumed average speed for a leg of a given length, in km/h.
 *
 * A single constant cannot describe both a two-kilometre crawl across a city
 * and a thousand-kilometre motorway run. Using the urban figure for both was
 * why an estimated long haul used to take a preposterous number of days: at
 * 32 km/h, Ranchi to Delhi is forty-three hours of driving. Short legs are
 * mostly junctions and traffic lights; long ones are mostly highway.
 */
export function assumedSpeedKmh(km) {
  if (!(km > 0)) return URBAN_SPEED_KMH;
  if (km <= 5) return URBAN_SPEED_KMH;
  if (km >= 300) return HIGHWAY_SPEED_KMH;
  const t = (km - 5) / 295;
  return URBAN_SPEED_KMH + (HIGHWAY_SPEED_KMH - URBAN_SPEED_KMH) * Math.sqrt(t);
}

const URBAN_SPEED_KMH = 24;
const HIGHWAY_SPEED_KMH = 58;
/** Kept for the single-figure cases that genuinely are urban. */
const ASSUMED_SPEED_KMH = URBAN_SPEED_KMH;

export function straightLineKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat);
  }
  return total * DETOUR_FACTOR;
}

export function straightLineMatrix(points) {
  const n = points.length;
  const durations = Array.from({ length: n }, () => new Array(n).fill(0));
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const km = haversineKm(points[i].lon, points[i].lat, points[j].lon, points[j].lat) * DETOUR_FACTOR;
      distances[i][j] = km * 1000;
      durations[i][j] = (km / assumedSpeedKmh(km)) * 3600;
    }
  }
  return { durations, distances };
}

/* ------------------------------------------------------------------ */
/* Finding different roads                                             */
/* ------------------------------------------------------------------ */

/**
 * The roads a route actually spends its distance on, longest first.
 *
 * OSRM reports a name per manoeuvre, so a single highway arrives as dozens of
 * fragments. Summing distance per name and ranking by that gives the two or
 * three roads a person would use to describe the route — "via NH-33" rather
 * than a list of every slip road it touches. Unnamed segments (service roads,
 * roundabouts) are skipped rather than shown as blanks.
 */
export function namedRoads(raw, limit = 3) {
  const byName = new Map();
  for (const leg of raw.legs || []) {
    for (const step of leg.steps || []) {
      const name = (step.name || '').trim();
      if (!name || name === '-') continue;
      byName.set(name, (byName.get(name) || 0) + (step.distance || 0));
    }
  }
  const total = [...byName.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return [...byName.entries()]
    .sort((a, b) => b[1] - a[1])
    // A road carrying under 8% of the distance is a detail, not a description.
    .filter(([, m]) => m / total >= 0.08)
    .slice(0, limit)
    .map(([name, m]) => ({ name, km: m / 1000, share: m / total }));
}

/**
 * Turn-by-turn directions, from the manoeuvre data the route already carries.
 *
 * We ask for `steps` in order to name the roads; the instructions come free
 * with them. Throwing that away and then telling somebody "20.7 km, 43 min"
 * would be withholding the one thing they need to actually drive the route.
 *
 * Trivial zero-distance fragments are folded away, and consecutive steps along
 * the same road are merged, because "continue on NH-33" nine times in a row is
 * noise rather than instruction.
 */
export function maneuvers(raw) {
  const out = [];
  for (const leg of raw.legs || []) {
    for (const step of leg.steps || []) {
      const m = step.maneuver || {};
      const name = (step.name || '').trim();
      const entry = {
        type: m.type || 'continue',
        modifier: m.modifier || '',
        exit: m.exit,
        name: name && name !== '-' ? name : '',
        km: (step.distance || 0) / 1000,
        minutes: (step.duration || 0) / 60,
        lon: Array.isArray(m.location) ? m.location[0] : undefined,
        lat: Array.isArray(m.location) ? m.location[1] : undefined,
      };

      // Merge a run along one road into a single instruction.
      const prev = out[out.length - 1];
      if (prev && prev.name && prev.name === entry.name
        && (entry.type === 'continue' || entry.type === 'new name')) {
        prev.km += entry.km;
        prev.minutes += entry.minutes;
        continue;
      }
      out.push(entry);
    }
  }
  // A zero-length step that is not the arrival is a routing artefact.
  const cleaned = out.filter((e, i) => e.km > 0.005 || i === out.length - 1 || e.type === 'depart');
  return cleaned.map((e) => ({ ...e, text: maneuverText(e) }));
}

const TURNS = {
  left: 'Turn left', right: 'Turn right',
  'slight left': 'Bear left', 'slight right': 'Bear right',
  'sharp left': 'Sharp left', 'sharp right': 'Sharp right',
  straight: 'Continue straight', uturn: 'Make a U-turn',
};

/** One manoeuvre, in the words somebody would use out loud. */
export function maneuverText(step) {
  const onto = step.name ? ` onto ${step.name}` : '';
  const along = step.name ? ` on ${step.name}` : '';
  switch (step.type) {
    case 'depart': return step.name ? `Head out on ${step.name}` : 'Start the journey';
    case 'arrive': return 'Arrive at your destination';
    case 'roundabout': case 'rotary':
      return step.exit ? `At the roundabout, take exit ${step.exit}${onto}` : `Take the roundabout${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'on ramp': return `Take the slip road${onto}`;
    case 'off ramp': return `Take the exit${onto}`;
    case 'fork': return `${step.modifier === 'right' ? 'Keep right' : 'Keep left'} at the fork${onto}`;
    case 'end of road': return `${TURNS[step.modifier] || 'Turn'} at the end of the road${onto}`;
    case 'new name': return `Continue${along}`;
    case 'continue': return `Continue${along}`;
    default:
      return `${TURNS[step.modifier] || 'Continue'}${step.modifier ? onto : along}`;
  }
}

/** "via NH-33 · Ranchi Ring Road" — how a person names a route. */
export const viaLabel = (roads, limit = 2) => (roads?.length
  ? roads.slice(0, limit).map((r) => r.name).join(' · ')
  : '');

/**
 * Via points offset sideways from the straight line between two places.
 *
 * Each candidate is a nudge: "go from here to there, but pass somewhere over
 * in that direction." The router snaps it to the nearest real road, so a via
 * point dropped in a field or a river still yields a real route — just one
 * that leaves by a different corridor. Candidates are ordered so the gentlest
 * nudges are spent first, because they are the ones most likely to find a road
 * somebody would actually consider.
 *
 * @param {{lon:number, lat:number}} a  start
 * @param {{lon:number, lat:number}} b  destination
 * @param {number} n  how many candidates to generate
 */
export function viaCandidates(a, b, n = VIA_PROBES) {
  const midLat = (a.lat + b.lat) / 2;
  // Work in a locally isotropic space so a "sideways" offset is the same
  // number of metres regardless of latitude, then convert back at the end.
  const kx = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const dx = (b.lon - a.lon) * kx;
  const dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-7) return [];

  const px = -dy / len;
  const py = dx / len;
  // Lateral reach scales with the journey but is capped: on a cross-country
  // trip a 40% sideways offset would land in another country.
  const reach = Math.min(len * 0.6, 0.55);

  const plan = [
    { t: 0.5, off: 0.16 }, { t: 0.5, off: -0.16 },
    { t: 0.5, off: 0.34 }, { t: 0.5, off: -0.34 },
    { t: 0.32, off: 0.24 }, { t: 0.68, off: -0.24 },
    { t: 0.32, off: -0.24 }, { t: 0.68, off: 0.24 },
    { t: 0.5, off: 0.6 }, { t: 0.5, off: -0.6 },
  ];

  const out = [];
  for (const { t, off } of plan.slice(0, Math.max(0, n))) {
    const o = off * reach;
    out.push({
      lon: a.lon + (dx * t + px * o) / kx,
      lat: clampLat(a.lat + dy * t + py * o),
    });
  }
  return out;
}

const clampLat = (v) => Math.max(-85, Math.min(85, v));

/**
 * A coarse spatial fingerprint of a route: the set of ~160 m cells its
 * geometry passes through.
 *
 * Comparing polylines point by point is both expensive and wrong — two
 * renderings of the same road have different vertex counts. Comparing the
 * ground they cover is neither.
 */
export function geometrySignature(pts, cellMetres = 160) {
  const set = new Set();
  if (!pts.length) return set;
  const latCell = cellMetres / 111320;

  const stamp = (lon, lat) => {
    const lonCell = latCell / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    set.add(`${Math.round(lat / latCell)}:${Math.round(lon / lonCell)}`);
  };

  // Walk the path rather than stamping its vertices. Real road geometry is
  // dense through a town and sparse along a motorway, so a vertex-only
  // fingerprint describes how the line was drawn instead of where it goes —
  // and would then report the same motorway, drawn twice, as two roads.
  stamp(pts[0].lon, pts[0].lat);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const metres = haversineKm(a.lon, a.lat, b.lon, b.lat) * 1000;
    // Half a cell per step guarantees no cell along the segment is skipped.
    const steps = Math.min(2000, Math.max(1, Math.ceil(metres / (cellMetres * 0.5))));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      stamp(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t);
    }
  }
  return set;
}

/**
 * How much of the shorter route lies on top of the longer one, 0..1.
 *
 * Measured against the shorter of the two deliberately: a 5 km shortcut that
 * runs entirely inside a 40 km route is the same road for its whole length,
 * and should not look distinct merely because the other route is bigger.
 */
export function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let hits = 0;
  for (const cell of small) if (large.has(cell)) hits++;
  return hits / small.size;
}

export const OSRM_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
export const OSRM_MAX_COORDS = MAX_TABLE_COORDS;
