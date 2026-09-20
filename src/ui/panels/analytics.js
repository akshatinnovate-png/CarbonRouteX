/**
 * ANALYTICS / COUNTERFACTUAL
 *
 * The honest-comparison view. Two plans, evaluated on identical conditions,
 * with every difference labelled as a calculated difference rather than a
 * claim. Also carries the optimiser's own convergence trace and run statistics,
 * because an optimisation you cannot inspect is an optimisation you cannot
 * trust.
 */

import { EV, on, emit } from '../../core/bus.js';
import { el, mount, raf1 } from '../../util/dom.js';
import { dur, kg as fkg, km as fkm, money, num, pct, signedPct } from '../../util/format.js';
import { comparePlans } from '../../engines/explain.js';
import { lineChart } from '../charts.js';
import { C } from '../../render/palette.js';
import { icon } from '../icons.js';

export function analyticsPanel(store) {
  const root = el('div.stack');

  const render = raf1(() => {
    const plan = store.plan;
    if (!plan) { mount(root, empty('Run OPTIMIZE FLEET to generate a plan.')); return; }

    const baseline = store.baseline;
    const cf = baseline && baseline !== plan
      ? comparePlans(baseline, plan, { labelBefore: 'Baseline dispatch', labelAfter: 'CarbonRoute X' })
      : null;

    mount(root,
      el('div.grid-auto', null,
        counterfactualCard(cf, baseline, plan),
        convergenceCard(store),
        routeTableCard(store)));
  });

  function counterfactualCard(cf, baseline, plan) {
    if (!cf) {
      return panel('Counterfactual', null, empty(
        'The live plan is the naive baseline. Run OPTIMIZE FLEET and this panel will compare the two, metric by metric.',
      ));
    }
    return panel('Counterfactual — baseline vs CarbonRoute X',
      el('span.eyebrow', { text: 'CALCULATED DIFFERENCE' }),
      el('div.stack', null,
        el('div.grid-2', null,
          planCard('Baseline dispatch', baseline, 'Nearest depot, booking order, no sequencing or carbon awareness.', false),
          planCard('CarbonRoute X', plan, plan.label, true)),
        el('div.delta-grid', null, ...cf.rows.map(deltaCell)),
        el('div.explain', null,
          el('div.why-title', { text: 'What changed' }),
          el('p', { text: cf.verdict }),
          el('p.basis', { text: cf.basis }))));
  }

  function planCard(title, plan, sub, accent) {
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
    const magnitude = Math.min(1, Math.abs(r.rel) * 3);
    return el('div.delta-cell', { dataset: { dir } },
      el('span.k', { text: r.label }),
      el('span.vals', null,
        el('span.before', { text: r.fmt(r.before) }),
        el('span.after', { text: r.fmt(r.after) })),
      el('span.chg', {
        text: Math.abs(r.rel) < 0.0001
          ? 'no material change'
          : `${signedPct(r.rel, 1)} · ${r.improved ? 'improvement' : 'regression'}`,
      }),
      el('div.delta-bar', null, el('i', { style: { width: `${Math.round(magnitude * 100)}%` } })));
  }

  function convergenceCard(store) {
    const history = store.optimizeHistory || [];
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const stats = store.optimizeStats;
    requestAnimationFrame(() => {
      lineChart(canvas, [
        { points: history.map((h) => ({ x: h.iteration, y: h.score })), color: C.cyan, width: 1.2, label: 'current' },
        { points: history.map((h) => ({ x: h.iteration, y: h.best })), color: C.green, width: 2, fill: true, label: 'best' },
      ], {
        height: 172,
        xLabel: 'Search iteration',
        yLabel: 'Objective score',
        yFormat: (v) => v.toFixed(2),
        xFormat: (v) => num(v, 0),
        empty: 'No search has run yet',
      });
    });

    return panel('Optimiser convergence', el('span.eyebrow', { text: 'SIMULATED ANNEALING' }),
      el('div.stack-sm', null,
        el('div.chart-wrap', null, canvas),
        el('div.chart-legend', null,
          el('span', null, el('i', { style: { background: C.cyan } }), 'Accepted state'),
          el('span', null, el('i', { style: { background: C.green } }), 'Best found')),
        stats ? el('dl.kv', null,
          ...kv('Elapsed', `${num(stats.elapsedMs)} ms`),
          ...kv('Iterations', num(stats.iterations)),
          ...kv('Route evaluations', num(stats.routeEvaluations)),
          ...kv('Path queries', num(stats.pathQueries)),
          ...kv('Path cache hit rate', pct(stats.cacheHitRate, 1)),
          ...kv('Objective improvement', pct(Math.max(0, stats.improvement), 1), 'var(--green)')) : null,
        el('p.basis', {
          text: 'The search accepts worsening states early (high temperature) to escape local optima, then tightens. The green line is the best feasible plan found; it is the one that was published.',
        })));
  }

  function routeTableCard(store) {
    const routes = (store.plan?.routes || []).filter((r) => r.orderIds.length);
    if (!routes.length) return panel('Routes', null, empty('No routes in the current plan.'));
    return panel('Route ledger', el('span.eyebrow', { text: `${routes.length} ACTIVE` }),
      el('div', { style: { overflowX: 'auto', maxHeight: '320px' } },
        el('table.tbl', null,
          el('thead', null, el('tr', null,
            el('th', { text: 'Route' }), el('th', { text: 'Vehicle' }),
            el('th.r', { text: 'Stops' }), el('th.r', { text: 'Dist' }),
            el('th.r', { text: 'Time' }), el('th.r', { text: 'Load' }),
            el('th.r', { text: 'Energy' }), el('th.r', { text: 'CO₂e' }),
            el('th.r', { text: 'Cost' }), el('th.r', { text: 'On-time' }))),
          el('tbody', null, ...routes.map((r) => {
            const v = store.vehiclesById.get(r.vehicleId);
            return el('tr', {
              'aria-selected': String(store.selection.kind === 'route' && store.selection.id === r.id),
              style: { cursor: 'pointer' },
              onclick: () => {
                store.select('route', r.id, { force: true });
                emit(EV.FOCUS_MAP, { points: r.polyline, padding: 120 });
              },
            },
            el('td', null, el('strong', { text: r.id })),
            el('td.name', { text: v?.callsign ?? '—' }),
            el('td.r', { text: num(r.stops.length) }),
            el('td.r', { text: num(r.km, 1) }),
            el('td.r', { text: dur(r.minutes, { compact: true }) }),
            el('td.r', { text: pct(r.capacityPct, 0) }),
            el('td.r', { text: num(r.units, 1) }),
            el('td.r', { text: num(r.co2, 2), style: { color: 'var(--green)' } }),
            el('td.r', { text: money(r.cost) }),
            el('td.r', {
              text: pct(r.onTime ?? 1, 0),
              style: { color: (r.onTime ?? 1) < 1 ? 'var(--amber)' : undefined },
            }));
          })))));
  }

  on(EV.PLAN_CHANGED, render);
  on(EV.OPT_DONE, render);
  on(EV.SELECT, render);
  render();
  return root;
}

/* ------------------------------------------------------------------ */

export const kv = (k, v, color) => [el('dt', { text: k }), el('dd', { text: v, style: color ? { color } : null })];

export const panel = (title, extra, ...body) => el('section.panel', null,
  el('div.panel-head', null, el('h3', { text: title }), el('span.spacer'), extra || null),
  el('div.panel-body', null, ...body));

export const empty = (message, hint) => el('div.empty-state', null,
  el('span', { html: icon('info', 24) }),
  el('p', { text: message }),
  hint ? el('span.hint', { text: hint }) : null);
