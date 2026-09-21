/**
 * ANALYTICS PAGE
 *
 * The honest comparison: the naive baseline against the optimised plan, both
 * evaluated on the same road matrix and the same traffic model, with every
 * difference labelled as a calculated difference rather than a claim.
 */

import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1 } from '../../util/dom.js';
import { clock, dur, kg as fkg, km as fkm, money, num, pct, signedPct } from '../../util/format.js';
import { comparePlans } from '../../engines/explain.js';
import { icon } from '../icons.js';
import { page, card, kv, empty, statTile, dataTable, chip } from '../components.js';

export function analyticsPage(store, map) {
  const root = el('div.page-root');

  const render = raf1(() => {
    const plan = store.plan;
    if (!plan) {
      mount(root, page('Analytics', 'Baseline versus optimised, measured under identical conditions.',
        empty('No plan yet.', 'Run the optimiser and this page will compare it against a naive baseline.')));
      return;
    }
    const cf = store.counterfactual
      || (store.baseline ? comparePlans(store.baseline, plan, { labelBefore: 'Baseline dispatch', labelAfter: 'CarbonRoute' }) : null);

    mount(root, page('Analytics', 'Baseline versus optimised, measured under identical conditions.',
      el('div.stack', null,
        summary(plan),
        cf ? counterfactual(cf, store.baseline, plan) : null,
        routeLedger(plan))));
  });

  function summary(plan) {
    const m = plan.metrics;
    return el('div.tile-row', null,
      statTile('CO₂e planned', num(m.co2, 1), { sub: 'kg', tone: 'green' }),
      statTile('Distance', num(m.km, 0), { sub: 'km' }),
      statTile('Fleet time', dur(m.minutes, { compact: true })),
      statTile('Operating cost', money(m.cost), { tone: 'amber' }),
      statTile('On-time rate', pct(m.onTimeRate, 1), { tone: m.onTimeRate < 1 ? 'amber' : 'green' }),
      statTile('Utilisation', pct(m.utilization, 0)));
  }

  function counterfactual(cf, baseline, plan) {
    return card('Counterfactual — baseline vs CarbonRoute',
      el('span.eyebrow', { text: 'CALCULATED DIFFERENCE' }),
      el('div.stack', null,
        el('div.grid-2', null,
          planPanel('Baseline dispatch', baseline,
            'Nearest depot, booking order, no sequencing and no carbon awareness — what dispatch does without a system like this.', false),
          planPanel('CarbonRoute', plan, plan.label, true)),
        el('div.delta-grid', null, ...cf.rows.map(deltaCell)),
        el('div.explain', null,
          el('div.why-title', { text: 'What changed' }),
          el('p', { text: cf.verdict }),
          el('p.basis', { text: cf.basis }))));
  }

  function planPanel(title, plan, sub, accent) {
    const m = plan.metrics;
    return el('div.panel', { class: accent ? 'panel--accent' : '' },
      el('div.panel-head', null, el('h3', { text: title })),
      el('div.panel-body', null,
        el('dl.kv', null,
          ...kv('CO₂e', fkg(m.co2, 1)),
          ...kv('Distance', fkm(m.km, 0)),
          ...kv('Fleet time', dur(m.minutes)),
          ...kv('Cost', money(m.cost)),
          ...kv('Vehicles', num(m.vehiclesUsed)),
          ...kv('Stops', num(m.stops)),
          ...kv('On-time', pct(m.onTimeRate, 1)),
          ...kv('Utilisation', pct(m.utilization, 0))),
        el('p.basis', { text: sub })));
  }

  function deltaCell(r) {
    const dir = r.improved ? 'good' : r.worsened ? 'bad' : 'flat';
    return el('div.delta-cell', { dataset: { dir } },
      el('span.k', { text: r.label }),
      el('span.vals', null,
        el('span.before', { text: r.fmt(r.before) }),
        el('span.after', { text: r.fmt(r.after) })),
      el('span.chg', {
        text: Math.abs(r.rel) < 0.0001 ? 'no material change'
          : `${signedPct(r.rel, 1)} · ${r.improved ? 'improvement' : 'regression'}`,
      }),
      el('div.delta-bar', null, el('i', { style: { width: `${Math.round(Math.min(1, Math.abs(r.rel) * 3) * 100)}%` } })));
  }

  function routeLedger(plan) {
    const routes = plan.routes.filter((r) => r.orderIds.length);
    if (!routes.length) return card('Route ledger', null, empty('No routes in the current plan.'));
    return card('Route ledger', el('span.eyebrow', { text: `${routes.length} ACTIVE` }),
      dataTable(routes, [
        { key: 'id', label: 'Route', name: true, get: (r) => r.id },
        { key: 'vehicle', label: 'Vehicle', name: true, get: (r) => store.vehiclesById.get(r.vehicleId)?.callsign ?? '—' },
        { key: 'depot', label: 'Depot', name: true, get: (r) => store.depotsById.get(r.depotId)?.name ?? '—' },
        { key: 'stops', label: 'Stops', right: true, get: (r) => num(r.stops.length) },
        { key: 'km', label: 'Distance', right: true, get: (r) => num(r.km, 1) },
        { key: 'time', label: 'Time', right: true, get: (r) => dur(r.minutes, { compact: true }) },
        { key: 'load', label: 'Load', right: true, get: (r) => pct(r.capacityPct, 0) },
        { key: 'energy', label: 'Energy', right: true, get: (r) => num(r.units, 1) },
        { key: 'co2', label: 'CO₂e', right: true, render: (r) => el('span', { style: { color: 'var(--success)' }, text: num(r.co2, 2) }) },
        { key: 'cost', label: 'Cost', right: true, get: (r) => money(r.cost) },
        { key: 'back', label: 'Back at', right: true, get: (r) => clock(r.endMinutes) },
        {
          key: 'ontime', label: 'On-time', right: true,
          render: (r) => el('span', { style: { color: (r.onTime ?? 1) < 1 ? 'var(--gold-deep)' : undefined }, text: pct(r.onTime ?? 1, 0) }),
        },
      ], {
        caption: 'Route ledger',
        onRowClick: (r) => {
          store.select('route', r.id, { force: true });
          if (r.path?.length) map.fit(r.path, { padding: 110 });
          emit(EV.VIEW_CHANGED, 'map');
        },
        selectedId: store.selection.kind === 'route' ? store.selection.id : null,
      }));
  }

  on(EV.PLAN_CHANGED, render);
  on(EV.OPT_DONE, render);
  on(EV.SELECT, render);
  render();
  return root;
}
