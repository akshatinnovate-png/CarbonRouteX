/**
 * APPLICATION SHELL
 *
 * The tab bar and the page host. Each tab is a self-contained page mounted
 * lazily on first visit and then kept alive, so switching is instant and each
 * page manages its own bus subscriptions.
 *
 * Splitting the old single-screen command centre into tabs is deliberate: an
 * operations tool has several genuinely different jobs — watching the map,
 * maintaining the fleet, entering orders, tuning the optimiser, reading the
 * analysis — and cramming them into one screen made none of them comfortable.
 */

import { APP } from '../config.js';
import { EV, emit, on } from '../core/bus.js';
import { el, mount, setText, announce, raf1 } from '../util/dom.js';
import { clock, num, pct } from '../util/format.js';
import { icon } from './icons.js';

import { mapPage } from './pages/map.js';
import { depotsPage } from './pages/depots.js';
import { fleetPage } from './pages/fleet.js';
import { ordersPage } from './pages/orders.js';
import { optimizePage } from './pages/optimize.js';
import { analyticsPage } from './pages/analytics.js';
import { carbonPage } from './pages/carbon.js';
import { simulationPage } from './pages/simulation.js';
import { eventsPage } from './pages/events.js';
import { settingsPage } from './pages/settings.js';
import { tripPage } from './pages/trip.js';
import { garagePage } from './pages/garage.js';
import { transitionToView, transitionMode } from './motion.js';

/**
 * The tab set is a function of the mode, not a filter applied to one list.
 *
 * PERSONAL is not LOGISTICS with panels hidden: somebody planning their own
 * commute has no depots, no order book and no dispatch, and offering those
 * tabs greyed out would be worse than not offering them. The two lists are
 * separate because the two products are.
 */
export const LOGISTICS_TABS = [
  { key: 'map', label: 'Map', icon: 'map', build: mapPage, group: 'operate' },
  { key: 'optimize', label: 'Optimise', icon: 'bolt', build: optimizePage, group: 'operate' },
  { key: 'simulation', label: 'Simulation', icon: 'sim', build: simulationPage, group: 'operate' },
  { key: 'depots', label: 'Depots', icon: 'warehouse', build: depotsPage, group: 'manage' },
  { key: 'fleet', label: 'Fleet', icon: 'fleet', build: fleetPage, group: 'manage' },
  { key: 'orders', label: 'Orders', icon: 'grid', build: ordersPage, group: 'manage' },
  { key: 'analytics', label: 'Analytics', icon: 'chart', build: analyticsPage, group: 'analyse' },
  { key: 'carbon', label: 'Carbon', icon: 'leaf', build: carbonPage, group: 'analyse' },
  { key: 'events', label: 'Events', icon: 'feed', build: eventsPage, group: 'analyse' },
  { key: 'settings', label: 'Settings', icon: 'layers', build: settingsPage, group: 'system' },
];

export const PERSONAL_TABS = [
  { key: 'trip', label: 'Journey', icon: 'route', build: tripPage, group: 'operate' },
  { key: 'garage', label: 'Garage', icon: 'fleet', build: garagePage, group: 'manage' },
  { key: 'settings', label: 'Settings', icon: 'layers', build: settingsPage, group: 'system' },
];

export const tabsFor = (mode) => (mode === 'PERSONAL' ? PERSONAL_TABS : LOGISTICS_TABS);

/** Kept for callers that only need the full logistics set. */
export const TABS = LOGISTICS_TABS;

export function initShell(store, map) {
  const tabsHost = document.getElementById('tabbar');
  const pagesHost = document.getElementById('pages');
  const canvas = document.getElementById('map-canvas');

  let tabs = tabsFor(store.mode);
  let built = new Map();
  let buttons = new Map();
  let active = null;

  function buildTabBar() {
    buttons = new Map();
    mount(tabsHost);
    for (const tab of tabs) {
      const badge = el('span.tab-badge', { hidden: true });
      const btn = el('button.tab', {
        type: 'button', role: 'tab', id: `tab-${tab.key}`,
        'aria-selected': 'false', 'aria-controls': `page-${tab.key}`,
        dataset: { group: tab.group, tab: tab.key },
        onclick: () => show(tab.key),
        onkeydown: (e) => {
          const i = tabs.findIndex((t) => t.key === tab.key);
          if (e.key === 'ArrowRight') { e.preventDefault(); show(tabs[(i + 1) % tabs.length].key, true); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); show(tabs[(i - 1 + tabs.length) % tabs.length].key, true); }
        },
      },
      el('span.tab-icon', { html: icon(tab.icon, 15) }),
      el('span.tab-label', { text: tab.label }),
      badge);
      buttons.set(tab.key, { btn, badge });
      tabsHost.append(btn);
    }
  }

  function show(key, focus = false) {
    if (!tabs.some((t) => t.key === key)) key = tabs[0].key;
    const from = active;
    active = key;
    for (const [k, { btn }] of buttons) btn.setAttribute('aria-selected', String(k === key));

    if (!built.has(key)) {
      const spec = tabs.find((t) => t.key === key);
      const node = el('div.page-host', {
        id: `page-${key}`, role: 'tabpanel', 'aria-labelledby': `tab-${key}`, tabindex: '0',
      }, spec.build(store, map));
      pagesHost.append(node);
      built.set(key, node);
    }
    for (const [k, node] of built) node.dataset.active = String(k === key);

    // One canvas serves every map-bearing page; whichever page is showing
    // takes it, so the tile cache and drawing context survive tab changes.
    const page = built.get(key);
    page.firstElementChild?.adoptCanvas?.();

    // Tabs are angles on one network, so the change is a lift, not a load.
    const direction = tabs.findIndex((t) => t.key === key) >= tabs.findIndex((t) => t.key === from) ? 1 : -1;
    transitionToView(from && from !== key ? built.get(from) : null, page, { direction });

    // The map canvas is only correctly sized once its host is visible.
    if (key === 'map' || key === 'trip') requestAnimationFrame(() => { map.resize(); map.invalidate(); });
    if (focus) buttons.get(key).btn.focus();
    store.setView(key);
    try { history.replaceState(null, '', `#${key}`); } catch { /* file:// has no history */ }
    announce(`${tabs.find((t) => t.key === key).label} view`);
  }

  /**
   * Rebuild for a new mode.
   *
   * Pages are discarded rather than hidden: a stale Orders page subscribed to
   * the bus would keep rendering a fleet that PERSONAL mode is not showing.
   * The canvas is rescued first, because it is a singleton the next mode needs.
   */
  function applyMode() {
    tabs = tabsFor(store.mode);
    if (canvas && canvas.parentElement && canvas.parentElement !== document.body) {
      document.body.append(canvas);
    }
    for (const node of built.values()) node.remove();
    built = new Map();
    active = null;
    buildTabBar();
    show(tabs[0].key);
    transitionMode(pagesHost, { to: store.mode });
    updateBadges();
  }

  const updateBadges = raf1(() => {
    if (store.isPersonal) return;
    const alerts = store.activeAlerts().length;
    setBadge('events', alerts, store.activeAlerts().some((a) => a.severity === 'high') ? 'alert' : 'info');
    const unserved = store.plan?.metrics.unserved ?? 0;
    setBadge('orders', unserved, unserved ? 'alert' : 'info');
    setBadge('simulation', store.scenarioIsEmpty() ? 0 : '●', 'info');
    setBadge('fleet', store.vehicles.filter((v) => !v.available).length, 'alert');
  });

  function setBadge(key, value, tone) {
    const entry = buttons.get(key);
    if (!entry) return;
    const show2 = value !== 0 && value !== null && value !== undefined;
    entry.badge.hidden = !show2;
    entry.badge.dataset.tone = tone;
    setText(entry.badge, String(value));
  }

  on(EV.ALERTS_CHANGED, updateBadges);
  on(EV.PLAN_CHANGED, updateBadges);
  on(EV.SCENARIO_CHANGED, updateBadges);
  on(EV.ENTITIES_CHANGED, updateBadges);
  on(EV.MODE_CHANGED, applyMode);

  buildTabBar();
  const initial = (location.hash || '').replace('#', '');
  show(tabs.some((t) => t.key === initial) ? initial : tabs[0].key);
  updateBadges();

  return { show, applyMode, get active() { return active; }, get tabs() { return tabs; } };
}

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */

export function initTopbar(store, shell) {
  const clockEl = document.getElementById('sim-clock');
  const statusEl = document.getElementById('ai-status');
  const accountEl = document.getElementById('account-chip');
  const serviceEl = document.getElementById('service-chip');
  const speedHost = document.getElementById('speed-control');
  const brandSub = document.querySelector('.brand-sub');

  /**
   * The plan clock and its speed control belong to a published fleet schedule.
   * PERSONAL mode has no schedule to advance, so rather than show a dead
   * control they are removed from the header entirely.
   */
  let lastMode = null;
  const applyModeChrome = () => {
    const personal = store.isPersonal;
    clockEl.hidden = personal;
    speedHost.hidden = personal;
    if (brandSub) setText(brandSub, personal ? 'Personal Mobility' : 'Logistics Intelligence');
    // The status readout describes the mode it was written in, so carrying
    // "3 road options" across into the fleet view would be nonsense.
    if (store.mode && store.mode !== lastMode) {
      lastMode = store.mode;
      setStatus('idle', personal ? 'Ready to plan' : 'System nominal');
    }
  };
  on(EV.MODE_CHANGED, applyModeChrome);
  // The landing page sets the mode silently (it has its own transition), so
  // the header also follows the coarse state event rather than relying on
  // MODE_CHANGED alone.
  on(EV.STATE_CHANGED, applyModeChrome);

  const SPEEDS = [
    { v: 0, label: '‖', title: 'Pause the operations clock' },
    { v: 15, label: '0.25×', title: 'Quarter speed' },
    { v: 60, label: '1×', title: 'One minute of the plan per second' },
    { v: 240, label: '4×', title: 'Four times speed' },
    { v: 900, label: '15×', title: 'Fifteen times speed' },
  ];
  mount(speedHost, SPEEDS.map((s) => el('button', {
    type: 'button', title: s.title, text: s.label,
    dataset: { speed: String(s.v) },
    'aria-pressed': String(store.speedMultiplier === s.v),
    onclick: () => {
      store.setSpeed(s.v);
      announce(s.v === 0 ? 'Clock paused' : `Clock running at ${s.label}`);
    },
  })));

  const renderClock = raf1(() => {
    if (store.isPersonal) return;
    setText(clockEl.querySelector('.t'), clock(store.clockMinutes));
    setText(clockEl.querySelector('.d'), store.playing ? 'PLAN CLOCK' : 'PAUSED');
    for (const b of speedHost.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === store.speedMultiplier));
    }
  });

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    setText(statusEl.querySelector('.txt'), text);
  }

  const renderAccount = () => {
    const a = store.workspace.account;
    if (!a) { accountEl.hidden = true; return; }
    accountEl.hidden = false;
    mount(accountEl,
      el('span.av', { text: initials(a.name) }),
      el('span.who', null, a.name, el('small', { text: a.org || 'Local workspace' })));
  };

  const renderService = () => {
    const s = store.serviceStatus;
    const routingOk = s.routing === 'ok';
    const estimating = store.matrix.estimated && store.matrix.ready;
    serviceEl.className = `chip ${routingOk && !estimating ? 'chip--green' : s.routing === 'unknown' ? '' : 'chip--red'}`;
    serviceEl.title = routingOk
      ? 'Road distances come from the live routing service over OpenStreetMap data.'
      : (s.message || 'The routing service is unreachable; distances fall back to straight-line estimates.');
    mount(serviceEl, el('i.dot'),
      s.routing === 'unknown' ? 'Checking roads…'
        : routingOk ? (estimating ? 'Estimated distances' : 'Live road routing')
          : 'Routing offline');
  };

  on(EV.FLEET_TICK, renderClock);
  on(EV.STATE_CHANGED, () => { renderClock(); renderAccount(); });
  on(EV.SERVICE_STATUS, renderService);
  on(EV.MATRIX_CHANGED, renderService);
  on(EV.OPT_START, ({ trigger }) => setStatus('working', trigger || 'Optimising'));
  on(EV.OPT_PROGRESS, (p) => {
    setStatus('working',
      p.phase === 'construct' ? `Building routes ${p.done}/${p.total}`
        : p.phase === 'anneal' ? `Optimising ${Math.round((p.done / p.total) * 100)}%`
          : p.phase === 'pareto' ? `Frontier ${p.done}/${p.total}`
            : p.message || 'Analysing');
  });
  on(EV.TRIP_CHANGED, (trip) => {
    if (!store.isPersonal) return;
    if (store.tripPending) { setStatus('working', 'Finding routes'); return; }
    if (store.tripError) { setStatus('alert', 'Routing unavailable'); return; }
    setStatus('idle', trip ? `${trip.distinctRoutes} road option${trip.distinctRoutes === 1 ? '' : 's'}` : 'Ready');
  });
  on(EV.OPT_DONE, () => {
    const high = store.activeAlerts().filter((a) => a.severity === 'high').length;
    setStatus(high ? 'alert' : 'idle', high ? `${high} high alert${high > 1 ? 's' : ''}` : 'Plan optimal');
  });
  on(EV.OPT_FAILED, () => setStatus('alert', 'Optimisation failed'));
  on(EV.ALERTS_CHANGED, () => {
    if (store.optimizing) return;
    const high = store.activeAlerts().filter((a) => a.severity === 'high').length;
    setStatus(high ? 'alert' : 'idle', high ? `${high} high alert${high > 1 ? 's' : ''}` : 'System nominal');
  });

  renderClock(); renderAccount(); renderService(); applyModeChrome();
  return { setStatus, applyModeChrome };
}

const initials = (name) => (name || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
