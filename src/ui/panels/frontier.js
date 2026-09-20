/**
 * OPTIMISATION FRONTIER
 *
 * Each point is a real, fully-costed plan produced by running the optimiser
 * under a different weight vector. The non-dominated subset is the Pareto
 * front. Selecting a point adopts that plan as the live fleet plan and tells
 * the operator, in computed numbers, what they just traded away.
 */

import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { dur, kg as fkg, km as fkm, money, num, pct, signedPct } from '../../util/format.js';
import { comparePlans } from '../../engines/explain.js';
import { paretoFront } from '../../engines/optimizer.js';
import { scatterChart } from '../charts.js';
import { panel, empty, kv } from './analytics.js';
import { icon } from '../icons.js';

const AXES = [
  { key: 'cost_co2', x: 'cost', y: 'co2', xLabel: 'Operating cost (₹)', yLabel: 'Estimated CO₂e (kg)', label: 'Cost ↔ CO₂e' },
  { key: 'time_co2', x: 'minutes', y: 'co2', xLabel: 'Fleet time (min)', yLabel: 'Estimated CO₂e (kg)', label: 'Time ↔ CO₂e' },
  { key: 'cost_time', x: 'cost', y: 'minutes', xLabel: 'Operating cost (₹)', yLabel: 'Fleet time (min)', label: 'Cost ↔ Time' },
];

export function frontierPanel(store) {
  const root = el('div.stack');
  let axis = AXES[0];
  let hovered = null;
  let inspected = null;

  const render = raf1(() => {
    const data = store.pareto;
    if (!data) {
      mount(root, panel('Optimisation frontier', null,
        empty('The frontier samples the weight simplex, optimises at each sample and keeps the non-dominated solutions. Every point is a real plan you can adopt.',
          'This runs the optimiser ~22 times and takes a few seconds.'),
        el('div.row', { style: { justifyContent: 'center' } },
          el('button.btn.btn--primary', {
            type: 'button', html: `${icon('scatter', 13)}<span>Compute frontier</span>`,
            disabled: store.optimizing,
            onclick: () => store.computeFrontier(),
          }))));
      return;
    }

    // Dominance is recomputed for the *displayed* pair of axes. The stored
    // `onFrontier` flag is three-dimensional (cost, time, CO2e), and plotting a
    // 3-D frontier on 2-D axes shows points that look dominated but are not —
    // which reads as a bug rather than as a third objective the viewer cannot
    // see. The global frontier is still reported separately below the chart.
    const front2d = new Set(paretoFront(data.candidates, [
      (c) => metric(c, axis.x), (c) => metric(c, axis.y),
    ]).map((c) => c.id));

    const points = data.candidates.map((c) => ({
      id: c.id,
      plan: c,
      x: metric(c, axis.x),
      y: metric(c, axis.y),
      onFrontier: front2d.has(c.id),
      onGlobalFrontier: !!c.onFrontier,
      selected: store.plan?.id === c.id || inspected === c.id,
      hovered: hovered === c.id,
    }));
    const current = store.plan
      ? { x: metric(store.plan, axis.x), y: metric(store.plan, axis.y) }
      : null;

    const canvas = el('canvas', { 'aria-hidden': 'true', style: { cursor: 'crosshair' } });
    const tip = el('div.scatter-tip', { hidden: true });
    const wrap = el('div.chart-wrap', null, canvas, tip);

    let pick = null;
    requestAnimationFrame(() => {
      pick = scatterChart(canvas, points, {
        height: 300,
        xLabel: axis.xLabel, yLabel: axis.yLabel,
        xFormat: (v) => num(v, 0), yFormat: (v) => num(v, axis.y === 'co2' ? 0 : 0),
        current,
      });
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pick) return;
      const hit = pick(e.clientX, e.clientY);
      if (!hit) { tip.hidden = true; hovered = null; return; }
      const c = hit.point.plan;
      hovered = c.id;
      mount(tip,
        el('div', null, el('b', { text: c.id }),
          ` · ${hit.point.onFrontier ? 'on this frontier' : 'dominated here'}`
          + `${c.onFrontier ? ' · globally non-dominated' : ''}`),
        el('div', { text: `CO₂e ${fkg(c.metrics.co2, 1)}` }),
        el('div', { text: `Cost ${money(c.metrics.cost)}` }),
        el('div', { text: `Time ${dur(c.metrics.minutes)}` }),
        el('div', { text: `${c.metrics.vehiclesUsed} vehicles · ${c.metrics.unserved} unserved` }));
      tip.hidden = false;
      tip.style.left = `${Math.min(hit.x + 14, canvas.clientWidth - 190)}px`;
      tip.style.top = `${Math.max(4, hit.y - 60)}px`;
    });
    canvas.addEventListener('pointerleave', () => { tip.hidden = true; hovered = null; });
    canvas.addEventListener('click', (e) => {
      if (!pick) return;
      const hit = pick(e.clientX, e.clientY);
      if (!hit) return;
      inspected = hit.point.plan.id;
      render();
    });

    const cand = inspected ? data.candidates.find((c) => c.id === inspected) : null;

    mount(root,
      el('div.grid-auto', null,
        panel('Optimisation frontier',
          el('div.segmented', { role: 'group', 'aria-label': 'Frontier axes' },
            ...AXES.map((a) => el('button', {
              type: 'button', text: a.label, 'aria-pressed': String(a.key === axis.key),
              onclick: () => { axis = a; render(); },
            }))),
          el('div.stack-sm', null,
            wrap,
            el('div.chart-legend', null,
              el('span', null, el('i', { style: { background: 'var(--green)' } }), `Non-dominated on these axes (${front2d.size})`),
              el('span', null, el('i', { style: { background: 'var(--muted)' } }), `Dominated (${data.candidates.length - front2d.size})`),
              el('span', null, el('i', { style: { background: 'var(--amber)' } }), 'Live plan')),
            el('p.basis', {
              text: `${data.candidates.length} weight vectors were sampled across the objective simplex. `
                + 'Each was optimised independently and costed on the same road graph, traffic field and order book. '
                + 'A point is highlighted when no other candidate beats it on both displayed axes. '
                + `Across all three objectives at once — cost, time and CO₂e — ${data.frontier.length} of the ${data.candidates.length} candidates are non-dominated.`,
            }),
            el('div.row', null,
              el('button.btn.btn--sm', {
                type: 'button', html: `${icon('refresh', 12)}<span>Recompute</span>`,
                disabled: store.optimizing,
                onclick: () => store.computeFrontier(),
              })))),

        cand ? candidateCard(cand) : panel('Candidate', null,
          empty('Click any point on the frontier to inspect that solution and see what adopting it would trade.'))));
  });

  function candidateCard(c) {
    const cmp = store.plan ? comparePlans(store.plan, c, { labelBefore: 'Live plan', labelAfter: c.id }) : null;
    const weights = Object.entries(c.weights).sort((a, b) => b[1] - a[1]);
    const isLive = store.plan?.id === c.id;

    return panel(`Candidate ${c.id}`,
      el('span.chip', { class: c.onFrontier ? 'chip--green' : '' }, el('i.dot'),
        c.onFrontier ? 'Non-dominated (cost / time / CO\u2082e)' : 'Dominated'),
      el('div.stack', null,
        el('div.stack-sm', null,
          el('span.eyebrow', { text: 'Objective weights' }),
          el('div.row.wrap', null, ...weights.map(([k, v]) => el('span.chip', {
            class: v > 0.4 ? 'chip--green' : v > 0.22 ? 'chip--cyan' : '',
          }, el('i.dot'), `${k} ${pct(v, 0)}`)))),

        el('dl.kv', null,
          ...kv('CO₂e', fkg(c.metrics.co2, 1)),
          ...kv('Cost', money(c.metrics.cost)),
          ...kv('Fleet time', dur(c.metrics.minutes)),
          ...kv('Distance', fkm(c.metrics.km, 0)),
          ...kv('Vehicles', num(c.metrics.vehiclesUsed)),
          ...kv('On-time', pct(c.metrics.onTimeRate, 1)),
          ...kv('Unserved', num(c.metrics.unserved), c.metrics.unserved ? 'var(--red)' : undefined)),

        cmp && !isLive ? el('div.explain', null,
          el('div.why-title', { text: 'Selecting this solution' }),
          el('p', { text: tradeSentence(cmp, c) }),
          el('ul.drivers', null,
            ...cmp.rows.filter((r) => r.material).slice(0, 5).map((r) => el('li', { dataset: { sign: r.improved ? '+' : '-' } },
              el('span.sign', { text: r.improved ? '+' : '−' }),
              el('span', null,
                el('span.d-label', { text: `${r.label} ${r.improved ? 'improves' : 'worsens'} by ${signedPct(Math.abs(r.rel), 1)}` }),
                el('span.d-detail', { text: `${r.fmt(r.before)} → ${r.fmt(r.after)}` })))))) : null,

        el('button.btn.btn--primary.btn--block', {
          type: 'button',
          disabled: isLive || store.optimizing,
          text: isLive ? 'This is the live plan' : `Adopt ${c.id} as the fleet plan`,
          onclick: () => {
            store.selectCandidate(c.id);
            emit(EV.TOAST, { message: `${c.id} adopted — weights and fleet plan updated.`, tone: 'good' });
            announce(`Candidate ${c.id} adopted as the live fleet plan`);
            render();
          },
        })));
  }

  function tradeSentence(cmp, c) {
    const gains = cmp.gains.map((g) => `${g.label.toLowerCase()} ${signedPct(Math.abs(g.rel), 1)} better`);
    const losses = cmp.losses.map((l) => `${l.label.toLowerCase()} ${signedPct(Math.abs(l.rel), 1)} worse`);
    if (!gains.length && !losses.length) return `${c.id} is materially equivalent to the live plan on every tracked metric.`;
    if (!losses.length) return `Selecting ${c.id} improves ${gains.join(', ')} with no measured regression.`;
    if (!gains.length) return `Selecting ${c.id} makes ${losses.join(', ')} with no measured improvement — it is dominated by the live plan.`;
    return `Selecting ${c.id} makes ${gains.join(', ')}, at the cost of ${losses.join(', ')}.`;
  }

  const metric = (plan, key) => (key === 'co2' ? plan.metrics.co2 : key === 'cost' ? plan.metrics.cost : key === 'minutes' ? plan.metrics.minutes : plan.metrics.km);

  on(EV.PARETO_READY, render);
  on(EV.PLAN_CHANGED, render);
  on(EV.OPT_START, render);
  on(EV.OPT_PROGRESS, raf1(() => { if (!store.pareto) render(); }));
  render();
  return root;
}
