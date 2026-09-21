/**
 * EVENTS PAGE — the operational timeline and the alert centre.
 *
 * Every entry corresponds to something the application actually did. Nothing
 * is written here for atmosphere.
 */

import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1 } from '../../util/dom.js';
import { clock, num } from '../../util/format.js';
import { icon } from '../icons.js';
import { page, card, empty, statTile } from '../components.js';

const KIND_LABELS = {
  system: 'System', optimize: 'Optimisation', plan: 'Plan', detect: 'Detection',
  delivery: 'Delivery', exception: 'Exception', scenario: 'Scenario',
  order: 'Order', depot: 'Depot', fleet: 'Fleet', error: 'Error',
};

export function eventsPage(store, map) {
  const root = el('div.page-root');
  let filter = 'all';

  const render = raf1(() => {
    const kinds = ['all', ...new Set(store.log.map((e) => e.kind))];
    const entries = filter === 'all' ? store.log : store.log.filter((e) => e.kind === filter);
    const active = store.activeAlerts();

    mount(root, page('Events', 'What the system did, and what needs attention.',
      el('div.stack', null,
        el('div.tile-row', null,
          statTile('Log entries', num(store.log.length)),
          statTile('Active alerts', num(active.length), { tone: active.length ? 'amber' : 'green' }),
          statTile('High severity', num(active.filter((a) => a.severity === 'high').length),
            { tone: active.some((a) => a.severity === 'high') ? 'red' : '' })),
        el('div.grid-2', null, feedCard(kinds, entries), alertCard(active)))));
  });

  function feedCard(kinds, entries) {
    return card('Event stream',
      el('div.segmented', { role: 'group', 'aria-label': 'Filter events' },
        ...kinds.slice(0, 7).map((k) => el('button', {
          type: 'button', text: k === 'all' ? 'All' : KIND_LABELS[k] || k,
          'aria-pressed': String(filter === k),
          onclick: () => { filter = k; render(); },
        }))),
      entries.length
        ? el('div.feed', { style: { maxHeight: '440px', overflowY: 'auto' } },
          ...entries.slice(0, 120).map((e) => el('div.feed-item', { dataset: { kind: e.kind } },
            el('span.t', { text: e.stamp }),
            el('span.g'),
            el('span.m', null,
              e.message,
              el('small', { text: ` · ${e.wall}` })))))
        : empty('Nothing logged under this filter.'));
  }

  function alertCard(active) {
    if (!active.length) {
      return card('Alert centre', null,
        empty('No active alerts. Every route is feasible and every order is assigned.'));
    }
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...active].sort((a, b) => order[a.severity] - order[b.severity] || b.at - a.at);
    const alertRow = (a) => el('div.alert', { dataset: { sev: a.severity } },
      el('span.sev'),
      el('button', {
        type: 'button',
        style: { textAlign: 'left', minWidth: '0' },
        onclick: () => navigate(a.target),
      },
      el('span.title', { text: a.title }),
      el('span.detail', { text: a.detail }),
      el('span.detail', { style: { color: 'var(--faint)' }, text: `raised ${clock(a.at)}` })),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button', 'aria-label': `Dismiss ${a.title}`, html: icon('close', 11),
        onclick: () => store.dismissAlert(a.id),
      }));

    return card('Alert centre', el('span.eyebrow', { text: `${active.length} ACTIVE` }),
      el('div.alert-list', { style: { maxHeight: '440px', overflowY: 'auto' } },
        ...sorted.map(alertRow)));
  }

  function navigate(target) {
    if (!target) return;
    store.select(target.kind, target.id, { force: true });
    if (target.kind === 'vehicle') {
      const v = store.vehiclesById.get(target.id);
      if (v?.lon != null) map.setView(v.lon, v.lat, 14);
    } else if (target.kind === 'order') {
      const o = store.ordersById.get(target.id);
      if (o) map.setView(o.lon, o.lat, 15);
    } else if (target.kind === 'route') {
      const r = store.routesById.get(target.id);
      if (r?.path?.length) map.fit(r.path, { padding: 110 });
    }
    emit(EV.VIEW_CHANGED, 'map');
  }

  on(EV.LOG, render);
  on(EV.ALERTS_CHANGED, render);
  render();
  return root;
}
