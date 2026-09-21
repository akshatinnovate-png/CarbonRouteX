/**
 * Application event bus.
 *
 * Every engine publishes here; every view subscribes here. Nothing in the
 * engines layer may import a view, and nothing in the view layer may mutate
 * state directly — that one-way rule is what keeps the map, the panels and the
 * analytics in sync without a framework.
 */

const listeners = new Map();
let depth = 0;

export const EV = {
  // lifecycle
  READY: 'ready',
  WORLD_BUILT: 'world:built',
  // data
  STATE_CHANGED: 'state:changed',        // coarse — any store mutation
  PLAN_CHANGED: 'plan:changed',          // a new fleet plan is live
  FLEET_TICK: 'fleet:tick',              // simulation clock advanced
  ORDERS_CHANGED: 'orders:changed',
  VEHICLES_CHANGED: 'vehicles:changed',
  // optimisation
  OPT_START: 'opt:start',
  OPT_PROGRESS: 'opt:progress',
  OPT_DONE: 'opt:done',
  OPT_FAILED: 'opt:failed',
  PARETO_READY: 'pareto:ready',
  // selection & focus
  SELECT: 'select',                      // { kind, id }
  HOVER: 'hover',
  MAP_CLICK: 'map:click',                // { hit, lon, lat }
  MAP_READY: 'map:ready',
  PICK_MODE: 'map:pickmode',             // placing a depot/order by clicking
  FOCUS_MAP: 'map:focus',                // { bounds } | { x, y, zoom }
  LAYERS_CHANGED: 'layers:changed',
  // ops
  LOG: 'log',                            // operational event stream entry
  ALERT: 'alert',
  ALERTS_CHANGED: 'alerts:changed',
  SCENARIO_CHANGED: 'scenario:changed',
  WEIGHTS_CHANGED: 'weights:changed',
  TOAST: 'toast',
  VIEW_CHANGED: 'view:changed',          // the active tab
  ENTITIES_CHANGED: 'entities:changed',  // depots/vehicles/orders added or edited
  MATRIX_CHANGED: 'matrix:changed',      // the road matrix was re-fetched
  SERVICE_STATUS: 'service:status',      // routing/geocoding reachability
  ONBOARDED: 'onboarded',
  SETTINGS_CHANGED: 'settings:changed',
};

export function on(type, handler) {
  let set = listeners.get(type);
  if (!set) { set = new Set(); listeners.set(type, set); }
  set.add(handler);
  return () => set.delete(handler);
}

export function once(type, handler) {
  const off = on(type, (payload) => { off(); handler(payload); });
  return off;
}

export function emit(type, payload) {
  const set = listeners.get(type);
  if (!set || set.size === 0) return;
  if (depth > 24) {
    console.warn('[bus] emit depth exceeded, dropping', type);
    return;
  }
  depth++;
  // Copy so handlers may unsubscribe during dispatch.
  for (const handler of Array.from(set)) {
    try { handler(payload); }
    catch (err) { console.error(`[bus] handler for "${type}" threw`, err); }
  }
  depth--;
}
