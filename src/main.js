/**
 * INIT
 *
 * Boot order:
 *   1. Load the local workspace and start the services.
 *   2. Bring up the real map immediately, so there is never a blank screen.
 *   3. If this is a first run, show sign-in and the setup wizard.
 *   4. Otherwise mount the shell, fit the map to the network, and optimise.
 */

import { APP } from './config.js';
import { EV, emit, on } from './core/bus.js';
import { store } from './core/store.js';
import { TileMap } from './render/tileMap.js';
import { makeProvider, customProvider, DEFAULT_PROVIDER } from './services/tiles.js';
import { installOverlays } from './render/overlays.js';
import { initShell, initTopbar } from './ui/shell.js';
import { initOnboarding } from './ui/onboarding.js';
import { initKeyboard } from './input/keyboard.js';
import { el, mount, announce } from './util/dom.js';
import { icon } from './ui/icons.js';

async function boot() {
  initToasts();

  try {
    await store.init();
  } catch (err) {
    showFatal(err);
    return;
  }

  /* ------------------------------------------------------------ map */

  const canvas = document.getElementById('map-canvas');
  const settings = store.settings;
  const provider = settings.tileProvider === 'custom' && settings.customTileUrl
    ? customProvider(settings.customTileUrl)
    : makeProvider(settings.tileProvider || DEFAULT_PROVIDER);

  const map = new TileMap(canvas, { provider });
  installOverlays(map, store);

  const region = store.workspace.region || APP.defaultRegion;
  map.setView(region.lon, region.lat, region.zoom || 11, { animate: false });
  map.resize();
  map.start();

  // The map is a view: it must repaint whenever anything it draws changes.
  for (const evt of [EV.PLAN_CHANGED, EV.ENTITIES_CHANGED, EV.SELECT, EV.HOVER,
    EV.LAYERS_CHANGED, EV.SCENARIO_CHANGED, EV.ORDERS_CHANGED]) {
    on(evt, () => map.invalidate());
  }
  // The store owns the clock; the map loop is what advances it.
  let lastTick = performance.now();
  map.addOverlay(() => {
    const now = performance.now();
    store.tick(Math.min((now - lastTick) / 1000, 0.25));
    lastTick = now;
  });

  on(EV.SETTINGS_CHANGED, (s) => {
    const p = s.tileProvider === 'custom' && s.customTileUrl
      ? customProvider(s.customTileUrl)
      : makeProvider(s.tileProvider || DEFAULT_PROVIDER);
    map.setProvider(p);
  });

  /* ---------------------------------------------------------- shell */

  const shell = initShell(store, map);
  initTopbar(store, shell);
  initKeyboard(store, { map, shell, help: initHelp() });
  on(EV.VIEW_CHANGED, (key) => { if (shell.active !== key) shell.show(key); });

  /* ----------------------------------------------------- onboarding */

  const onboarding = initOnboarding(store, {
    onComplete: async () => {
      shell.show('map');
      fitEverything(map, store);
      await store.optimizeFleet({ trigger: 'First plan', label: 'Optimised plan' });
      fitRoutes(map, store);
    },
  });

  if (!store.signedIn || !store.onboarded) {
    onboarding.show();
  } else {
    document.getElementById('app').removeAttribute('aria-hidden');
    fitEverything(map, store);
    if (store.depots.length && store.vehicles.length && store.openOrders().length) {
      await store.optimizeFleet({ trigger: 'Session start', label: 'Optimised plan' });
      fitRoutes(map, store);
    }
    announce('Command centre ready');
  }

  window.CarbonRoute = { store, map, shell, version: APP.version };
}

/* ------------------------------------------------------------------ */

function fitEverything(map, store) {
  const pts = [
    ...store.depots.map((d) => ({ lon: d.lon, lat: d.lat })),
    ...store.orders.map((o) => ({ lon: o.lon, lat: o.lat })),
  ];
  if (pts.length) map.fit(pts, { padding: 90, animate: false });
}

function fitRoutes(map, store) {
  const pts = [];
  for (const r of store.plan?.routes || []) {
    for (const s of r.stops) pts.push({ lon: s.lon, lat: s.lat });
  }
  for (const d of store.depots) pts.push({ lon: d.lon, lat: d.lat });
  if (pts.length) map.fit(pts, { padding: 110 });
}

/* ------------------------------------------------------------------ */

function initHelp() {
  const sheet = document.getElementById('help-sheet');
  const open = () => { if (!sheet.open) sheet.showModal(); };
  const close = () => { if (sheet.open) sheet.close(); };
  document.getElementById('help-btn')?.addEventListener('click', open);
  document.getElementById('help-close')?.addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  return { open, close, toggle: () => (sheet.open ? close() : open()), isOpen: () => sheet.open };
}

function initToasts() {
  const host = document.getElementById('toast-stack');
  on(EV.TOAST, ({ message, tone = 'info', duration = 4500 }) => {
    const node = el('div.toast', { dataset: { tone } },
      el('span', { html: icon(tone === 'bad' ? 'alert' : tone === 'good' ? 'check' : 'info') }),
      el('span', { text: message }));
    host.append(node);
    announce(message, tone === 'bad');
    setTimeout(() => {
      node.style.transition = 'opacity 260ms, transform 260ms';
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(() => node.remove(), 280);
    }, duration);
  });
}

function showFatal(err) {
  console.error('[CarbonRoute] fatal', err);
  const host = document.getElementById('onboarding');
  host.hidden = false;
  mount(host, el('div.ob-shell', null,
    el('main.ob-main', null,
      el('div.ob-panel', null,
        el('div.ob-head', null,
          el('h1', { text: 'CarbonRoute could not start' }),
          el('p', { text: err?.message || 'An unknown error occurred while loading the workspace.' })),
        el('p.basis', {
          text: 'Reloading usually clears this. If it persists, your browser may not support the ES module or Canvas features this application needs.',
        }),
        el('button.btn.btn--primary', { type: 'button', text: 'Reload', onclick: () => location.reload() })))));
}

window.addEventListener('error', (e) => {
  if (!store.ready) return;
  emit(EV.TOAST, { message: `Something went wrong: ${e.message}`, tone: 'bad', duration: 6000 });
});
window.addEventListener('unhandledrejection', (e) => {
  if (!store.ready) return;
  emit(EV.TOAST, { message: `Operation failed: ${e.reason?.message || e.reason}`, tone: 'bad', duration: 6000 });
});

boot();
