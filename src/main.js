/**
 * INIT
 *
 * Boot order:
 *   1. Show the landing immediately (it draws nothing until the world exists).
 *   2. Build the world, dataset and engines; publish a baseline plan.
 *   3. Mount the command centre, map, inspector and dock.
 *   4. Hand control over — and optionally run the disruption demo.
 *
 * The application is usable the moment the store is ready; nothing waits on an
 * animation.
 */

import { APP, SIM } from './config.js';
import { EV, emit, on } from './core/bus.js';
import { store } from './core/store.js';
import { storageAvailable } from './core/storage.js';
import { MapEngine } from './render/mapEngine.js';
import { initHud, initToasts } from './ui/hud.js';
import { initCommandCenter } from './ui/commandCenter.js';
import { initInspector } from './ui/inspector.js';
import { initDock } from './ui/dock.js';
import { initIntro } from './ui/intro.js';
import { initKeyboard } from './input/keyboard.js';
import { el, mount, announce, prefersReducedMotion } from './util/dom.js';
import { icon } from './ui/icons.js';
import { dur, kg as fkg, pct } from './util/format.js';

const boot = async () => {
  let map = null;
  let dock = null;
  let command = null;

  const intro = initIntro(store, (runDemo) => {
    map?.resize();
    map?.start();
    // Start the operations clock only once the user is actually watching it.
    store.setSpeed(SIM.defaultSpeedMultiplier);
    document.getElementById('map-canvas')?.focus({ preventScroll: true });
    if (runDemo) setTimeout(() => runKillerDemo(), 700);
  });

  initToasts();

  try {
    await store.init();
  } catch (err) {
    showFatal(err);
    return;
  }

  /* ------------------------------------------------------------ map */

  const canvas = document.getElementById('map-canvas');
  map = new MapEngine(canvas, store);
  map.resize();
  // Render one frame behind the intro so the command centre is never blank.
  map.draw();

  /* ------------------------------------------------------------ ui */

  const hud = initHud(store, map);
  command = initCommandCenter(store, map);
  const inspector = initInspector(store, map);
  dock = initDock(store);
  const help = initHelp();
  initKeyboard(store, { map, dock, command, help });
  initMobileNav(dock);

  if (!storageAvailable) {
    emit(EV.TOAST, {
      message: 'Browser storage is unavailable, so objective weights and layer choices will not persist between visits.',
      tone: 'info', duration: 6000,
    });
  }

  // First real optimisation, so the command centre opens on an optimised plan
  // rather than the naive baseline. The baseline is retained for comparison.
  await store.optimizeFleet({ trigger: 'Initial network optimisation', label: 'Optimised plan' });
  map.fitRoutes();

  /* ----------------------------------------------------- demo script */

  /**
   * THE KILLER DEMO
   * Traffic disruption -> impact calculated -> fleet re-optimised -> the
   * measured difference, and the reasons behind it. Every step is a real call
   * into the engines; the only thing scripted is the timing.
   */
  async function runKillerDemo() {
    if (store.optimizing) return;
    dock.show('simulation');
    emit(EV.TOAST, { message: 'Demo: traffic disruption detected on the network.', tone: 'bad', duration: 3600 });
    announce('Demo running: traffic disruption detected');

    store.setScenarioTraffic('plus60');
    store.addIncidentNear(0, 0, 1.25, 10);
    const busiest = store.plan.routes
      .filter((r) => r.orderIds.length)
      .sort((a, b) => b.orderIds.length - a.orderIds.length)[0];
    if (busiest) store.closeRouteCorridor(busiest.id);

    await wait(1100);
    const before = store.plan;
    const plan = await store.replan({ trigger: 'Demo — traffic disruption' });
    if (!plan) return;

    map.fitRoutes();
    dock.show('simulation');
    const cmp = store.scenarioComparison;
    if (cmp) {
      const co2 = cmp.rows.find((r) => r.key === 'co2');
      const time = cmp.rows.find((r) => r.key === 'minutes');
      emit(EV.TOAST, {
        message: `Replanned: CO₂e ${co2.improved ? 'down' : 'up'} ${fkg(Math.abs(co2.delta), 2)}, `
          + `fleet time ${time.improved ? 'down' : 'up'} ${dur(Math.abs(time.delta))}, `
          + `on-time ${pct(plan.metrics.onTimeRate, 1)}.`,
        tone: co2.improved ? 'good' : 'info',
        duration: 8000,
      });
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Expose a small surface for debugging and for the README's console recipes.
  window.CarbonRoute = { store, map, dock, command, runKillerDemo, version: APP.version };
};

/* ------------------------------------------------------------------ */
/* Help dialog                                                         */
/* ------------------------------------------------------------------ */

function initHelp() {
  const sheet = document.getElementById('help-sheet');
  const open = () => { if (!sheet.open) sheet.showModal(); };
  const close = () => { if (sheet.open) sheet.close(); };
  document.getElementById('help-btn').addEventListener('click', open);
  document.getElementById('help-close').addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  return { open, close, toggle: () => (sheet.open ? close() : open()), isOpen: () => sheet.open };
}

/* ------------------------------------------------------------------ */
/* Mobile navigation                                                   */
/* ------------------------------------------------------------------ */

function initMobileNav(dock) {
  const nav = document.getElementById('mobile-nav');
  const commandRail = document.getElementById('command-center');
  const inspectorRail = document.getElementById('inspector');
  const dockEl = document.getElementById('dock');

  const VIEWS = [
    { key: 'map', label: 'Map', icon: 'map' },
    { key: 'command', label: 'Optimise', icon: 'bolt' },
    { key: 'fleet', label: 'Fleet', icon: 'fleet' },
    { key: 'analysis', label: 'Analysis', icon: 'chart' },
  ];

  let current = 'map';
  const buttons = VIEWS.map((v) => el('button', {
    type: 'button', 'aria-current': String(current === v.key),
    dataset: { view: v.key },
    onclick: () => setView(v.key),
  }, el('span', { html: icon(v.icon, 17), style: { display: 'flex' } }), el('span', { text: v.label })));
  mount(nav, ...buttons);

  function setView(key) {
    current = key;
    commandRail.classList.toggle('mobile-active', key === 'command');
    inspectorRail.classList.toggle('mobile-active', key === 'fleet');
    dockEl.classList.toggle('mobile-active', key === 'analysis');
    for (const b of buttons) b.setAttribute('aria-current', String(b.dataset.view === key));
    announce(`${VIEWS.find((v) => v.key === key).label} view`);
  }

  // Selecting something on the map should surface its detail on small screens.
  on(EV.SELECT, ({ kind }) => {
    if (window.innerWidth > 860 || !kind) return;
    // Give the map a beat to animate its focus before covering it.
    setTimeout(() => setView('fleet'), 420);
  });

  return { setView };
}

/* ------------------------------------------------------------------ */
/* Fatal error surface                                                 */
/* ------------------------------------------------------------------ */

function showFatal(err) {
  console.error('[CarbonRoute X] fatal', err);
  const intro = document.getElementById('intro');
  const note = document.getElementById('intro-note');
  if (note) {
    note.innerHTML = '';
    note.append(el('strong', { text: 'The simulation failed to start.' }),
      el('br'),
      el('span', { text: err?.message || 'Unknown error.' }),
      el('br'),
      el('span', { text: 'Reload to try again. If it persists, your browser may not support the Canvas or ES module features this application needs.' }));
    note.style.color = 'var(--red)';
  }
  const enter = document.getElementById('intro-enter');
  const demo = document.getElementById('intro-demo');
  if (enter) { enter.disabled = true; enter.textContent = 'Unavailable'; }
  if (demo) demo.hidden = true;
}

/* ------------------------------------------------------------------ */

window.addEventListener('error', (e) => {
  // Surface engine errors instead of letting the app fail silently.
  if (!store.ready) return;
  emit(EV.TOAST, { message: `Something went wrong: ${e.message}`, tone: 'bad', duration: 6000 });
});
window.addEventListener('unhandledrejection', (e) => {
  if (!store.ready) return;
  emit(EV.TOAST, { message: `Operation failed: ${e.reason?.message || e.reason}`, tone: 'bad', duration: 6000 });
});

boot();
