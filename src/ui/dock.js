/**
 * DOCK — the tabbed analysis surface beneath the map.
 *
 * Panels are built lazily on first activation and then kept alive, so switching
 * tabs is instant and each panel manages its own bus subscriptions.
 */

import { EV, emit, on } from '../core/bus.js';
import { el, mount, setText, announce } from '../util/dom.js';
import { icon } from './icons.js';
import { analyticsPanel } from './panels/analytics.js';
import { frontierPanel } from './panels/frontier.js';
import { carbonPanel } from './panels/carbon.js';
import { simulationPanel } from './panels/simulation.js';
import { eventsPanel } from './panels/events.js';
import { ordersPanel } from './panels/orders.js';

const TABS = [
  { key: 'analytics', label: 'Analytics', icon: 'chart', build: analyticsPanel },
  { key: 'frontier', label: 'Frontier', icon: 'scatter', build: frontierPanel },
  { key: 'carbon', label: 'Carbon', icon: 'leaf', build: carbonPanel },
  { key: 'simulation', label: 'Simulation', icon: 'sim', build: simulationPanel },
  { key: 'orders', label: 'Order book', icon: 'grid', build: ordersPanel },
  { key: 'events', label: 'Events', icon: 'feed', build: eventsPanel },
];

export function initDock(store) {
  const dock = document.getElementById('dock');
  const tabsHost = document.getElementById('dock-tabs');
  const body = document.getElementById('dock-body');
  const built = new Map();
  let active = 'analytics';

  const tabButtons = new Map();
  for (const t of TABS) {
    const count = el('span.count', { hidden: true });
    const btn = el('button.dock-tab', {
      type: 'button', role: 'tab', id: `tab-${t.key}`,
      'aria-selected': String(active === t.key),
      'aria-controls': `panel-${t.key}`,
      onclick: () => show(t.key),
      onkeydown: (e) => {
        const i = TABS.findIndex((x) => x.key === t.key);
        if (e.key === 'ArrowRight') { e.preventDefault(); show(TABS[(i + 1) % TABS.length].key, true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); show(TABS[(i - 1 + TABS.length) % TABS.length].key, true); }
      },
    }, el('span', { html: icon(t.icon, 13), style: { display: 'flex' } }), t.label, count);
    tabButtons.set(t.key, { btn, count });
    tabsHost.append(btn);
  }

  const sizeBtn = el('button.btn.btn--ghost.btn--sm', {
    type: 'button', 'aria-label': 'Expand analysis panel', title: 'Expand / collapse',
    html: icon('expand', 12),
    onclick: () => cycleSize(),
  });
  tabsHost.append(el('span.dock-spacer'), el('span.dock-actions', null, sizeBtn));

  function cycleSize() {
    const order = ['collapsed', 'normal', 'tall'];
    const i = order.indexOf(dock.dataset.size || 'normal');
    const next = order[(i + 1) % order.length];
    dock.dataset.size = next;
    sizeBtn.innerHTML = next === 'tall' ? icon('collapse', 12) : icon('expand', 12);
    sizeBtn.setAttribute('aria-label', next === 'tall' ? 'Collapse analysis panel' : 'Expand analysis panel');
    announce(`Analysis panel ${next}`);
  }

  function show(key, focus = false) {
    active = key;
    for (const [k, { btn }] of tabButtons) btn.setAttribute('aria-selected', String(k === key));
    if (!built.has(key)) {
      const spec = TABS.find((t) => t.key === key);
      const wrapper = el('div.dock-panel', {
        id: `panel-${key}`, role: 'tabpanel', 'aria-labelledby': `tab-${key}`, tabindex: '0',
      }, spec.build(store));
      body.append(wrapper);
      built.set(key, wrapper);
    }
    for (const [k, node] of built) node.dataset.active = String(k === key);
    if (dock.dataset.size === 'collapsed') dock.dataset.size = 'normal';
    if (focus) tabButtons.get(key).btn.focus();
    emit(EV.VIEW_CHANGED, key);
  }

  function updateCounts() {
    const alerts = store.activeAlerts().length;
    const ev = tabButtons.get('events');
    ev.count.hidden = alerts === 0;
    setText(ev.count, String(alerts));
    ev.btn.dataset.tone = store.activeAlerts().some((a) => a.severity === 'high') ? 'alert' : '';

    const unserved = store.plan?.metrics.unserved ?? 0;
    const ord = tabButtons.get('orders');
    ord.count.hidden = unserved === 0;
    setText(ord.count, String(unserved));
    ord.btn.dataset.tone = unserved ? 'alert' : '';

    const staged = store.scenarioIsEmpty() ? 0 : 1;
    const sim = tabButtons.get('simulation');
    sim.count.hidden = !staged;
    setText(sim.count, 'staged');
  }

  on(EV.ALERTS_CHANGED, updateCounts);
  on(EV.PLAN_CHANGED, updateCounts);
  on(EV.SCENARIO_CHANGED, updateCounts);

  show('analytics');
  updateCounts();

  return { show, cycleSize, get active() { return active; } };
}
