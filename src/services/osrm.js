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
          minutes: (km / 32) * 60,
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
  async routeAlternatives(points, { alternatives = 3 } = {}) {
    if (points.length < 2) return [];
    const key = points.map((p) => `${round6(p.lon)},${round6(p.lat)}`).join(';');
    const cacheKey = `alt:${alternatives}:${key}`;
    const cached = this.routeCache.get(cacheKey);
    if (cached) { this.stats.cacheHits++; return cached; }
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey);

    const url = `${this.endpoint}/route/v1/${this.profile}/${key}`
      + `?alternatives=${alternatives}&overview=full&geometries=polyline6&steps=false`;

    const task = (async () => {
      try {
        this.stats.routeRequests++;
        const json = await this._fetch(url);
        const routes = (json.routes || []).map((r, i) => ({
          id: `alt-${i}`,
          points: decodePolyline(r.geometry, 6),
          km: r.distance / 1000,
          minutes: r.duration / 60,
          estimated: false,
        }));
        if (!routes.length) throw new Error('routing service returned no route');
        this.routeCache.set(cacheKey, routes);
        return routes;
      } catch {
        // One clearly-flagged straight-line estimate, never a fabricated set
        // of "alternatives" that do not exist.
        const km = straightLineKm(points);
        return [{
          id: 'alt-0',
          points: points.slice(),
          km,
          minutes: (km / ASSUMED_SPEED_KMH) * 60,
          estimated: true,
        }];
      } finally {
        this.inFlight.delete(cacheKey);
      }
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
const ASSUMED_SPEED_KMH = 32;

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
      durations[i][j] = (km / ASSUMED_SPEED_KMH) * 3600;
    }
  }
  return { durations, distances };
}

export const OSRM_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
export const OSRM_MAX_COORDS = MAX_TABLE_COORDS;
