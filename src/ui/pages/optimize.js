/**
 * OPTIMISE PAGE
 *
 * Where the operator says what "best" means, runs the solve, and inspects the
 * trade-off surface. The weights set here drive the plan objective directly.
 */

import { OBJECTIVES, PRESETS, OPTIMIZER } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce, setText } from '../../util/dom.js';
import { dur, kg as fkg, km as fkm, money, num, pct, signedPct } from '../../util/format.js';
import { topObjective, comparePlans } from '../../engines/explain.js';
import { paretoFront } from '../../engines/optimizer.js';
import { lineChart, scatterChart } from '../charts.js';
import { C } from '../../render/palette.js';
import { icon } from '../icons.js';
import { pageWithActions, card, kv, empty, statTile, chip } from '../components.js';

const PRESET_LABELS = { fastest: 'Fastest', cheapest: 'Lowest cost', greenest: 'Lowest carbon', balanced: 'Balanced' };

const AXES = [
  { key: 'cost_co2', x: 'cost', y: 'co2', xLabel: 'Operating cost', yLabel: 'Estimated CO₂e (kg)', label: 'Cost ↔ CO₂e' },
  { key: 'time_co2', x: 'minutes', y: 'co2', xLabel: 'Fleet time (min)', yLabel: 'Estimated CO₂e (kg)', label: 'Time ↔ CO₂e' },
  { key: 'cost_time', x: 'cost', y: 'minutes', xLabel: 'Operating cost', yLabel: 'Fleet time (min)', label: 'Cost ↔ Time' },
];

export function optimizePage(store, map) {
  const root = el('div.page-root');
  let axis = AXES[0];
  let inspected = null;

  const render = raf1(() => {
    const canRun = store.depots.length && store.vehicles.length && store.openOrders().length;
    mount(root, pageWithActions(
      'Optimise',
      'Set what "best" means, then solve. Weights feed the objective function directly.',
      [
        el('button.btn', {
          type: 'button', html: `${icon('scatter', 13)}<span>Explore frontier</span>`,
          disabled: !canRun || store.optimizing,
          onclick: () => store.computeFrontier(),
        }),
        el('button.btn.btn--primary.btn--lg', {
          type: 'button',
          disabled: !canRun || store.optimizing,
          html: `${icon(store.optimizing ? 'refresh' : 'bolt', 14)}<span>${store.optimizing ? 'Optimising…' : 'Optimise fleet'}</span>`,
          onclick: () => store.optimizeFleet({ trigger: 'Operator requested optimisation' }),
        }),
      ],
      el('div.stack', null,
        !canRun ? readiness() : null,
        store.optimizing ? progressCard() : null,
        el('div.grid-2', null, objectivesCard(), planCard()),
        convergenceCard(),
        frontierCard())));
  });

  function readiness() {
    const missing = [];
    if (!store.depots.length) missing.push('a depot');
    if (!store.vehicles.length) missing.push('a vehicle');
    if (!store.openOrders().length) missing.push('an open delivery');
    return el('div.notice', null,
      el('span', { html: icon('info', 15) }),
      el('p', { text: `Add ${missing.join(', ')} before the optimiser can run. Use the Depots, Fleet and Orders tabs.` }));
  }

  function progressCard() {
    const p = store.optimizeProgress || {};
    const ratio = p.total ? p.done / p.total : 0;
    return card('Solving', chip('Running', 'cyan'),
      el('div.stack-sm', null,
        el('div.progress-label', null,
          el('span', {
            text: p.phase === 'construct' ? `Generating candidate routes · ${p.done}/${p.total}`
              : p.phase === 'anneal' ? `Searching · ${Math.round(ratio * 100)}%`
                : p.phase === 'pareto' ? `Frontier sample ${p.done + 1}/${p.total}`
                  : p.message || 'Fetching road distances',
          }),
          el('span.mono', { text: p.best != null ? `best ${num(p.best, 3)}` : '' })),
        el('div.progress', null, el('i', { style: { width: `${Math.round(ratio * 100)}%` } }))));
  }

  /* --------------------------------------------------- objectives */

  function objectivesCard() {
    const rows = OBJECTIVES.map((o) => {
      const v = store.weights[o.key] ?? 0;
      const val = el('span.val.num', { text: pct(v, 0) });
      const input = el('input', {
        type: 'range', min: '0', max: '100', step: '1',
        value: String(Math.round(v * 100)),
        'aria-label': `${o.label} weight`,
        style: { '--track-color': o.accent, '--fill': `${Math.round(v * 100)}%` },
        oninput: (e) => {
          store.setWeight(o.key, Number(e.target.value) / 100);
          // Update in place: a full re-render would steal the slider's focus.
          for (const obj of OBJECTIVES) {
            const w = store.weights[obj.key] ?? 0;
            const row = root.querySelector(`[data-obj="${obj.key}"]`);
            if (!row) continue;
            row.querySelector('.val').textContent = pct(w, 0);
            const slider = row.querySelector('input');
            slider.style.setProperty('--fill', `${Math.round(w * 100)}%`);
            if (slider !== e.target) slider.value = String(Math.round(w * 100));
          }
          updateDirty();
        },
      });
      return el('div.objective', { dataset: { obj: o.key } },
        el('span.name', { text: o.label, style: { color: o.accent } }), input, val);
    });

    const dominant = topObjective(store.weights);

    return card('Objective weights',
      el('span.eyebrow', { id: 'weights-dirty' }),
      el('div.stack-sm', null,
        el('div.segmented', { role: 'group', 'aria-label': 'Objective presets' },
          ...Object.keys(PRESETS).map((key) => el('button', {
            type: 'button', text: PRESET_LABELS[key],
            'aria-pressed': String(store.preset === key),
            onclick: () => { store.applyPreset(key); announce(`${PRESET_LABELS[key]} preset applied`); render(); },
          })),
          el('button', {
            type: 'button', text: 'Custom', 'aria-pressed': String(store.preset === 'custom'),
            title: 'Set automatically when you move a slider', disabled: true,
          })),
        el('div', null, ...rows),
        el('div.row-between', null,
          el('span.eyebrow', { text: 'Dominant objective' }),
          chip(dominant.label, 'green')),
        el('p.basis', {
          text: 'Weights are normalised to sum to 1 and enter the objective function directly: '
            + 'score = Σ wₖ × (metricₖ / baselineₖ), plus lateness and unserved-order penalties. '
            + 'Re-run the optimiser to apply a change.',
        })));
  }

  function updateDirty() {
    const node = document.getElementById('weights-dirty');
    if (!node) return;
    const round = (w) => Object.fromEntries(Object.entries(w || {}).map(([k, v]) => [k, Math.round(v * 100)]));
    const dirty = store.plan && JSON.stringify(round(store.plan.weights)) !== JSON.stringify(round(store.weights));
    setText(node, dirty ? 'CHANGED — RE-RUN' : '');
    node.style.color = dirty ? 'var(--gold-deep)' : 'var(--faint)';
  }

  /* --------------------------------------------------- plan card */

  function planCard() {
    const plan = store.plan;
    if (!plan) {
      return card('Current plan', null, empty('No plan yet.', 'Press "Optimise fleet" to build one.'));
    }
    const m = plan.metrics;
    const s = store.optimizeStats;
    return card('Current plan', chip(plan.label, 'green'),
      el('div.stack-sm', null,
        el('div.tile-row', null,
          statTile('CO₂e', num(m.co2, 1), { sub: 'kg', tone: 'green' }),
          statTile('Distance', num(m.km, 0), { sub: 'km' }),
          statTile('Fleet time', dur(m.minutes, { compact: true })),
          statTile('Cost', money(m.cost), { tone: 'amber' })),
        el('dl.kv', null,
          ...kv('Routes', num(m.vehiclesUsed)),
          ...kv('Stops planned', `${num(m.stops)} of ${num(m.stops + m.unserved)}`),
          ...kv('Capacity utilisation', pct(m.utilization, 0)),
          ...kv('On-time rate', pct(m.onTimeRate, 1)),
          ...kv('Unserved', num(m.unserved), m.unserved ? 'var(--danger)' : undefined),
          ...kv('Objective score', plan.score != null ? num(plan.score, 3) : '—', 'var(--success)')),
        s ? el('p.basis', {
          text: `Solved in ${num(s.elapsedMs)} ms over ${num(s.iterations)} search iterations, `
            + `${num(s.routeEvaluations)} route evaluations against a ${s.matrixSize}×${s.matrixSize} road matrix`
            + `${s.matrixEstimated ? ' (straight-line estimates — routing service unavailable)' : ''}.`,
        }) : null));
  }

  /* ------------------------------------------------- convergence */

  function convergenceCard() {
    const history = store.optimizeHistory || [];
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    requestAnimationFrame(() => lineChart(canvas, [
      { points: history.map((h) => ({ x: h.iteration, y: h.score })), color: C.teal, width: 1.2 },
      { points: history.map((h) => ({ x: h.iteration, y: h.best })), color: C.success, width: 2, fill: true },
    ], {
      height: 190, xLabel: 'Search iteration', yLabel: 'Objective score',
      yFormat: (v) => v.toFixed(2), xFormat: (v) => num(v, 0),
      empty: 'No search has run yet',
    }));

    return card('Optimiser convergence', el('span.eyebrow', { text: 'SIMULATED ANNEALING' }),
      el('div.chart-wrap', null, canvas),
      el('div.chart-legend', null,
        el('span', null, el('i', { style: { background: C.teal } }), 'Accepted state'),
        el('span', null, el('i', { style: { background: C.success } }), 'Best found')),
      el('p.basis', {
        text: 'The search accepts worsening states early to escape local optima, then tightens. '
          + 'The green line is the best feasible plan found — the one that was published.',
      }));
  }

  /* ---------------------------------------------------- frontier */

  function frontierCard() {
    const data = store.pareto;
    if (!data) {
      return card('Optimisation frontier', null,
        empty('The frontier samples the weight simplex, optimises at each sample, and keeps the non-dominated solutions. Every point is a real plan you can adopt.',
          `This runs the optimiser ${OPTIMIZER.paretoSamples} times.`,
          el('button.btn.btn--primary', {
            type: 'button', text: 'Compute frontier',
            disabled: store.optimizing || !store.openOrders().length,
            onclick: () => store.computeFrontier(),
          })));
    }

    const metric = (p, key) => (key === 'co2' ? p.metrics.co2 : key === 'cost' ? p.metrics.cost : p.metrics.minutes);
    // Dominance is recomputed for the DISPLAYED axes: plotting a 3-D frontier
    // on 2-D axes shows points that look dominated but are not, which reads as
    // a bug rather than as a third objective the viewer cannot see.
    const front2d = new Set(paretoFront(data.candidates, [
      (c) => metric(c, axis.x), (c) => metric(c, axis.y),
    ]).map((c) => c.id));

    const points = data.candidates.map((c) => ({
      id: c.id, plan: c,
      x: metric(c, axis.x), y: metric(c, axis.y),
      onFrontier: front2d.has(c.id),
      selected: store.plan?.id === c.id || inspected === c.id,
    }));

    const canvas = el('canvas', { 'aria-hidden': 'true', style: { cursor: 'crosshair' } });
    let pick = null;
    requestAnimationFrame(() => {
      pick = scatterChart(canvas, points, {
        height: 300, xLabel: axis.xLabel, yLabel: axis.yLabel,
        xFormat: (v) => num(v, 0), yFormat: (v) => num(v, 0),
        current: store.plan ? { x: metric(store.plan, axis.x), y: metric(store.plan, axis.y) } : null,
      });
    });
    canvas.addEventListener('click', (e) => {
      if (!pick) return;
      const hit = pick(e.clientX, e.clientY);
      if (hit) { inspected = hit.point.plan.id; render(); }
    });

    const cand = inspected ? data.candidates.find((c) => c.id === inspected) : null;

    return card('Optimisation frontier',
      el('div.segmented', { role: 'group', 'aria-label': 'Frontier axes' },
        ...AXES.map((a) => el('button', {
          type: 'button', text: a.label, 'aria-pressed': String(a.key === axis.key),
          onclick: () => { axis = a; render(); },
        }))),
      el('div.grid-2', null,
        el('div.stack-sm', null,
          el('div.chart-wrap', null, canvas),
          el('div.chart-legend', null,
            el('span', null, el('i', { style: { background: C.success } }), `Non-dominated here (${front2d.size})`),
            el('span', null, el('i', { style: { background: C.muted } }), `Dominated (${data.candidates.length - front2d.size})`),
            el('span', null, el('i', { style: { background: C.gold } }), 'Live plan')),
          el('p.basis', {
            text: `${data.candidates.length} weight vectors were sampled and optimised independently on the same road matrix. `
              + `A point is highlighted when nothing beats it on both displayed axes. Across cost, time and CO₂e together, `
              + `${data.frontier.length} of ${data.candidates.length} are non-dominated.`,
          })),
        cand ? candidateCard(cand) : empty('Click any point to inspect that solution and see what adopting it would trade.')));
  }

  function candidateCard(c) {
    const cmp = store.plan ? comparePlans(store.plan, c, { labelBefore: 'Live plan', labelAfter: c.id }) : null;
    const isLive = store.plan?.id === c.id;
    return el('div.stack-sm', null,
      el('div.row-between', null,
        el('strong', { text: `Candidate ${c.id}` }),
        chip(c.onFrontier ? 'Non-dominated' : 'Dominated', c.onFrontier ? 'green' : '')),
      el('div.row.wrap', null, ...Object.entries(c.weights).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => chip(`${k} ${pct(v, 0)}`, v > 0.4 ? 'green' : v > 0.22 ? 'cyan' : ''))),
      el('dl.kv', null,
        ...kv('CO₂e', fkg(c.metrics.co2, 1)),
        ...kv('Cost', money(c.metrics.cost)),
        ...kv('Fleet time', dur(c.metrics.minutes)),
        ...kv('Distance', fkm(c.metrics.km, 0)),
        ...kv('Vehicles', num(c.metrics.vehiclesUsed)),
        ...kv('Unserved', num(c.metrics.unserved), c.metrics.unserved ? 'var(--danger)' : undefined)),
      cmp && !isLive ? el('div.explain', null,
        el('div.why-title', { text: 'Adopting this solution' }),
        el('p', { text: cmp.verdict }),
        el('ul.drivers', null, ...cmp.rows.filter((r) => r.material).slice(0, 5).map((r) => el('li', { dataset: { sign: r.improved ? '+' : '-' } },
          el('span.sign', { text: r.improved ? '+' : '−' }),
          el('span', null,
            el('span.d-label', { text: `${r.label} ${r.improved ? 'improves' : 'worsens'} ${signedPct(Math.abs(r.rel), 1)}` }),
            el('span.d-detail', { text: `${r.fmt(r.before)} → ${r.fmt(r.after)}` })))))) : null,
      el('button.btn.btn--primary.btn--block', {
        type: 'button',
        disabled: isLive || store.optimizing,
        text: isLive ? 'This is the live plan' : `Adopt ${c.id}`,
        onclick: () => {
          store.selectCandidate(c.id);
          emit(EV.TOAST, { message: `${c.id} adopted — weights and plan updated.`, tone: 'good' });
          render();
        },
      }));
  }

  on(EV.PLAN_CHANGED, render);
  on(EV.OPT_START, render);
  on(EV.OPT_DONE, render);
  on(EV.OPT_FAILED, render);
  on(EV.PARETO_READY, render);
  on(EV.OPT_PROGRESS, raf1(() => { if (store.optimizing) render(); }));
  on(EV.ENTITIES_CHANGED, render);
  render();
  return root;
}
