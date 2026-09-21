/**
 * GEOCODING — Nominatim (OpenStreetMap), no API key.
 *
 * Nominatim's usage policy caps this at roughly one request per second and
 * asks for a descriptive identifier, so every lookup here goes through a
 * serialised queue with a minimum gap, and results are cached.
 *
 * Forward geocoding turns "12 Banjara Hills, Hyderabad" into a coordinate when
 * the operator adds a depot or a delivery address. Reverse geocoding turns a
 * click on the map into a readable address so pinned stops are not bare
 * coordinates.
 */

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org';
const MIN_GAP_MS = 1100; // Nominatim asks for <= 1 request per second

class RequestQueue {
  constructor(gapMs) { this.gapMs = gapMs; this.last = 0; this.chain = Promise.resolve(); }
  run(task) {
    this.chain = this.chain.then(async () => {
      const wait = this.gapMs - (Date.now() - this.last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return task();
    }, async () => {
      // A previous failure must not poison the queue for later callers.
      this.last = Date.now();
      return task();
    });
    return this.chain;
  }
}

export class GeocodeService {
  constructor({ endpoint = DEFAULT_ENDPOINT } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.queue = new RequestQueue(MIN_GAP_MS);
    this.searchCache = new Map();
    this.reverseCache = new Map();
    this.lastError = null;
    this.stats = { searches: 0, reverses: 0, cacheHits: 0, failures: 0 };
  }

  setEndpoint(endpoint) {
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.searchCache.clear();
    this.reverseCache.clear();
  }

  async _json(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`address lookup returned ${res.status}`);
      this.lastError = null;
      return await res.json();
    } catch (err) {
      this.stats.failures++;
      this.lastError = err.name === 'AbortError'
        ? 'The address service timed out.'
        : 'The address service could not be reached.';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Forward search. `near` biases results toward the operating region, which
   * matters a great deal for short queries like "depot road".
   * @returns {Promise<{label:string, short:string, lon:number, lat:number, type:string}[]>}
   */
  async search(query, { near = null, limit = 6 } = {}) {
    const q = query.trim();
    if (q.length < 3) return [];
    const key = `${q}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ''}`;
    if (this.searchCache.has(key)) { this.stats.cacheHits++; return this.searchCache.get(key); }

    const params = new URLSearchParams({
      q, format: 'jsonv2', limit: String(limit), addressdetails: '1',
    });
    if (near) {
      // A viewbox around the operating centre, biased but not bounded, so a
      // legitimate out-of-region address still resolves.
      const d = 1.2;
      params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
    }

    try {
      const json = await this.queue.run(() => {
        this.stats.searches++;
        return this._json(`${this.endpoint}/search?${params}`);
      });
      const results = (json || []).map((r) => ({
        label: r.display_name,
        short: shortLabel(r),
        lon: Number(r.lon),
        lat: Number(r.lat),
        type: r.type || r.category || 'place',
      })).filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat));
      this.searchCache.set(key, results);
      return results;
    } catch {
      return [];
    }
  }

  /** Reverse geocode a map click into an address. Never throws. */
  async reverse(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (this.reverseCache.has(key)) { this.stats.cacheHits++; return this.reverseCache.get(key); }
    const params = new URLSearchParams({
      lon: String(lon), lat: String(lat), format: 'jsonv2', zoom: '18', addressdetails: '1',
    });
    try {
      const json = await this.queue.run(() => {
        this.stats.reverses++;
        return this._json(`${this.endpoint}/reverse?${params}`);
      });
      const result = json && json.display_name
        ? { label: json.display_name, short: shortLabel(json), lon, lat }
        : { label: fallbackLabel(lon, lat), short: fallbackLabel(lon, lat), lon, lat, unresolved: true };
      this.reverseCache.set(key, result);
      return result;
    } catch {
      // A pin without an address is still a perfectly valid stop.
      return { label: fallbackLabel(lon, lat), short: fallbackLabel(lon, lat), lon, lat, unresolved: true };
    }
  }

  async probe() {
    try {
      await this.queue.run(() => this._json(`${this.endpoint}/search?q=london&format=jsonv2&limit=1`, 9000));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: this.lastError || err.message };
    }
  }
}

/* ------------------------------------------------------------------ */

function shortLabel(r) {
  const a = r.address || {};
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ')
    || a.neighbourhood || a.suburb || a.hamlet || r.name || '';
  const line2 = a.suburb && line1 !== a.suburb ? a.suburb
    : a.city || a.town || a.village || a.county || '';
  const joined = [line1, line2].filter(Boolean).join(', ');
  return joined || (r.display_name ? r.display_name.split(',').slice(0, 2).join(',') : 'Unnamed location');
}

export function fallbackLabel(lon, lat) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}

export const GEOCODE_ATTRIBUTION = 'Address search by Nominatim / OpenStreetMap contributors';
export const GEOCODE_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
