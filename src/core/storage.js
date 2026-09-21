/**
 * STORAGE — the local workspace.
 *
 * There is no backend. The operator's account, depots, fleet, order book and
 * settings live in this browser and nowhere else: nothing is uploaded, and the
 * only network traffic the application makes is to public map-tile, routing and
 * address services.
 *
 * Every access is guarded. Private-browsing modes and blocked site data make
 * localStorage throw rather than return null, and a workspace that cannot be
 * saved must still be usable for the session.
 */

const KEY = 'carbonroute:workspace:v2';
const SESSION_KEY = 'carbonroute:session:v2';
const SCHEMA = 2;

export const storageAvailable = (() => {
  try {
    const probe = `${KEY}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
})();

export function emptyWorkspace() {
  return {
    schema: SCHEMA,
    account: null,           // { name, org, email, createdAt }
    onboarded: false,
    region: null,            // { label, lon, lat } — the operating city
    depots: [],
    vehicles: [],
    orders: [],
    settings: {
      tileProvider: 'carto-dark',
      customTileUrl: '',
      osrmEndpoint: '',      // blank = the public demo server
      geocodeEndpoint: '',   // blank = the public Nominatim instance
      currency: '₹',
      preset: 'balanced',
      weights: null,
      layers: null,
    },
    counters: { vehicle: 0, order: 0, depot: 0 },
    updatedAt: null,
  };
}

export function loadWorkspace() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyWorkspace();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyWorkspace();
    if (parsed.schema !== SCHEMA) {
      // A future version of this app should migrate here. For now, starting
      // clean is safer than feeding the optimiser a shape it does not expect.
      return { ...emptyWorkspace(), migratedFrom: parsed.schema ?? 'unknown' };
    }
    const base = emptyWorkspace();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      counters: { ...base.counters, ...(parsed.counters || {}) },
      depots: Array.isArray(parsed.depots) ? parsed.depots : [],
      vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
    };
  } catch {
    return emptyWorkspace();
  }
}

export function saveWorkspace(ws) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...ws, schema: SCHEMA, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace() {
  try { localStorage.removeItem(KEY); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * "Sign in" is local only — it identifies whose workspace this is on a shared
 * machine and nothing more. There is no password, because there is no server to
 * check one against, and a fake password field would imply a security property
 * this application does not have.
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); return true; } catch { return false; }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

export function exportWorkspace(ws) {
  return JSON.stringify({ ...ws, schema: SCHEMA, exportedAt: new Date().toISOString() }, null, 2);
}

export function importWorkspace(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('That file is not a CarbonRoute workspace.');
  if (parsed.schema !== SCHEMA) throw new Error(`That workspace uses schema ${parsed.schema ?? 'unknown'}; this build expects ${SCHEMA}.`);
  const base = emptyWorkspace();
  return {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings || {}) },
    counters: { ...base.counters, ...(parsed.counters || {}) },
  };
}
