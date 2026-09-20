/**
 * EVENT STREAM
 *
 * An operational timeline. Every entry corresponds to an action the
 * application actually took — a plan published, a constraint detected, a
 * delivery completed, a scenario committed. Nothing is written here for
 * atmosphere.
 */

import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1 } from '../../util/dom.js';
import { clock, num } from '../../util/format.js';
import { panel, empty } from './analytics.js';
import { icon } from '../icons.js';

const KIND_LABELS = {
  system: 'System', optimize: 'Optimisation', plan: 'Plan', detect: 'Detection',
  delivery: 'Delivery', exception: 'Exception', scenario: 'Scenario', order: 'Order', error: 'Error',
};

export function eventsPanel(store) {
  const root = el('div.stack');
  let filter = 'all';

  const render = raf1(() => {
    const entries = filter === 'all' ? store.log : store.log.filter((e) => e.kind === filter);
    const kinds = ['all', ...new Set(store.log.map((e) => e.kind))];

    mount(root,
      el('div.grid-auto', null,
        panel('Event stream',
          el('div.segmented', { role: 'group', 'aria-label': 'Filter events' },
            ...kinds.slice(0, 6).map((k) => el('button', {
              type: 'button', text: k === 'all' ? 'All' : KIND_LABELS[k] || k,
              'aria-pressed': String(filter === k),
              onclick: () => { filter = k; render(); },
            }))),
          entries.length
            ? el('div.feed', { style: { maxHeight: '340px', overflowY: 'auto' } },
              ...entries.slice(0, 80).map((e) => el('div.feed-item', { dataset: { kind: e.kind } },
                el('span.t', { text: e.stamp }),
                el('span.g'),
                el('span.m', { text: e.message }))))
            : empty('Nothing logged under this filter.')),

        panel('Alert centre', el('span.eyebrow', { text: `${store.activeAlerts().length} ACTIVE` }),
          alertList())));
  });

  function alertList() {
    const active = store.activeAlerts();
    if (!active.length) return empty('No active alerts. Every route is feasible and every order is assigned.');
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...active].sort((a, b) => order[a.severity] - order[b.severity] || b.at - a.at);
    return el('div.alert-list', { style: { maxHeight: '340px', overflowY: 'auto' } },
      ...sorted.map((a) => el('div.alert', { dataset: { sev: a.severity } },
        el('span.sev'),
        el('button', {
          type: 'button',
          style: { textAlign: 'left', minWidth: '0' },
          onclick: () => {
            if (!a.target) return;
            store.select(a.target.kind, a.target.id, { force: true });
            const t = a.target;
            if (t.kind === 'vehicle') { const v = store.vehiclesById.get(t.id); if (v) emit(EV.FOCUS_MAP, { x: v.x, y: v.y, zoom: 2.6 }); }
            else if (t.kind === 'order') { const o = store.ordersById.get(t.id); if (o) emit(EV.FOCUS_MAP, { x: o.x, y: o.y, zoom: 3.2 }); }
            else if (t.kind === 'route') { const r = store.routesById?.get(t.id); if (r?.polyline.length) emit(EV.FOCUS_MAP, { points: r.polyline }); }
            else if (t.kind === 'edge') { const e = store.world.edges[t.id]; if (e) emit(EV.FOCUS_MAP, { x: e.mid.x, y: e.mid.y, zoom: 3.2 }); }
          },
        },
        el('span.title', { text: a.title }),
        el('span.detail', { text: a.detail }),
        el('span.detail', { style: { color: 'var(--faint)' }, text: `raised ${clock(a.at)}` })),
        el('button.btn.btn--ghost.btn--sm', {
          type: 'button', 'aria-label': `Dismiss ${a.title}`, html: icon('close', 11),
          onclick: () => store.dismissAlert(a.id),
        }))));
  }

  on(EV.LOG, render);
  on(EV.ALERTS_CHANGED, render);
  render();
  return root;
}
