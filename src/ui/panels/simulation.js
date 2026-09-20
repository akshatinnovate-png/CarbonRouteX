/**
 * DIGITAL TWIN / SIMULATION MODE
 *
 * Stage disruptions against the modelled world, then commit them and watch the
 * pipeline run: EVENT -> DETECTION -> OPTIMIZATION -> NEW PLAN.
 *
 * The before/after comparison deliberately re-costs the *existing* plan under
 * the new conditions before comparing. Comparing the new plan against the old
 * plan's old numbers would credit the optimiser with avoiding a disruption it
 * did not cause, which would be a lie dressed up as a metric.
 *
 * The WHAT-IF engine goes further: it mutates the world, optimises, measures,
 * and then restores everything, so a question can be asked without committing
 * the answer.
 */

import { SIM } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { clock, dur, kg as fkg, km as fkm, money, num, pct, signedPct } from '../../util/format.js';
import { panel, empty, kv } from './analytics.js';
import { icon } from '../icons.js';

const TRAFFIC_LEVELS = [
  { key: 'normal', label: 'Normal' },
  { key: 'plus10', label: '+10%' },
  { key: 'plus30', label: '+30%' },
  { key: 'plus60', label: '+60%' },
  { key: 'severe', label: 'Severe' },
];

const STAGES = ['Event', 'Detection', 'Optimisation', 'New plan'];

export function simulationPanel(store) {
  const root = el('div.stack');
  let stage = -1;
  let whatIfResult = null;
  let whatIfBusy = false;

  const render = raf1(() => {
    mount(root,
      el('div.grid-auto', null,
        controlsCard(),
        pipelineCard(),
        whatIfCard()),
      store.scenarioComparison ? resultCard() : null);
  });

  /* ------------------------------------------------------ controls */

  function controlsCard() {
    const s = store.pendingScenario;
    return panel('Simulation controls', el('span.eyebrow', { text: 'DIGITAL TWIN' }),
      el('div.stack', null,

        el('div.sc-group', null,
          el('span.sc-title', null, el('span.n', { text: '1' }), 'Traffic'),
          el('div.segmented', { role: 'group', 'aria-label': 'Network traffic level' },
            ...TRAFFIC_LEVELS.map((t) => el('button', {
              type: 'button', text: t.label,
              'aria-pressed': String(s.trafficLevel === t.key),
              onclick: () => { store.setScenarioTraffic(t.key); render(); },
            })))),

        el('div.sc-group', null,
          el('span.sc-title', null, el('span.n', { text: '2' }), 'Vehicle failure'),
          el('div.row.wrap', null, ...store.vehicles.map((v) => el('button.chip', {
            type: 'button',
            class: s.disabledVehicles.includes(v.id) ? 'chip--red' : '',
            style: { cursor: 'pointer' },
            'aria-pressed': String(s.disabledVehicles.includes(v.id)),
            onclick: () => { store.toggleScenarioVehicle(v.id); render(); },
          }, el('i.dot'), v.id)))),

        el('div.sc-group', null,
          el('span.sc-title', null, el('span.n', { text: '3' }), 'Urgent order'),
          el('div.row.wrap', null,
            el('button.btn.btn--sm', {
              type: 'button', html: `${icon('plus', 12)}<span>Inject urgent delivery</span>`,
              onclick: () => {
                const o = store.queueUrgentOrder();
                emit(EV.TOAST, { message: `${o.id} staged — ${o.consignee}, ${o.weightKg} kg, due ${clock(o.deadline)}`, tone: 'info' });
                render();
              },
            }),
            s.injectedOrders.length ? el('span.chip.chip--amber', null, el('i.dot'), `${s.injectedOrders.length} queued`) : null)),

        el('div.sc-group', null,
          el('span.sc-title', null, el('span.n', { text: '4' }), 'Deadline change'),
          deadlineControl()),

        el('div.sc-group', null,
          el('span.sc-title', null, el('span.n', { text: '5' }), 'Road closure'),
          el('div.row.wrap', null,
            ...(store.plan?.routes || []).filter((r) => r.orderIds.length).slice(0, 8).map((r) => el('button.chip', {
              type: 'button', style: { cursor: 'pointer' },
              title: `Close the mid-section of ${r.id}`,
              onclick: () => {
                const closed = store.closeRouteCorridor(r.id);
                emit(EV.TOAST, {
                  message: closed.length ? `${closed.length} links on ${r.id} staged for closure` : `${r.id} has no closable links`,
                  tone: closed.length ? 'info' : 'bad',
                });
                render();
              },
            }, el('i.dot'), `Close ${r.id}`)),
            el('button.chip.chip--orange', {
              type: 'button', style: { cursor: 'pointer' },
              title: 'Add a congestion incident at the network core',
              onclick: () => { store.addIncidentNear(0, 0, 1.2, 9); emit(EV.TOAST, { message: 'Congestion incident staged at the network core', tone: 'info' }); render(); },
            }, el('i.dot'), 'Core incident'))),

        el('div.hr'),
        el('span.eyebrow', { text: 'Staged changes' }),
        el('div.staged', null, ...stagedChips()),

        el('div.row.wrap', null,
          el('button.btn.btn--primary', {
            type: 'button',
            style: { flex: '1' },
            disabled: store.optimizing || store.scenarioIsEmpty(),
            html: `${icon('bolt', 13)}<span>Replan</span>`,
            onclick: runReplan,
          }),
          el('button.btn', {
            type: 'button', text: 'Clear',
            disabled: store.scenarioIsEmpty(),
            onclick: () => { store.resetScenario(); render(); },
          }),
          el('button.btn', {
            type: 'button', text: 'Reset world',
            title: 'Lift every committed disruption and re-optimise from clean conditions',
            disabled: store.optimizing,
            onclick: resetWorld,
          }))));
  }

  function stagedChips() {
    const s = store.pendingScenario;
    const chips = [];
    if (s.trafficMultiplier !== 1) chips.push(chip('amber', `Traffic ${signedPct(s.trafficMultiplier - 1, 0)}`));
    for (const id of s.disabledVehicles) chips.push(chip('red', `${id} disabled`));
    if (s.closedEdges.length) chips.push(chip('red', `${s.closedEdges.length} links closed`));
    for (const o of s.injectedOrders) chips.push(chip('cyan', `${o.id} urgent`));
    for (const [id, d] of Object.entries(s.deadlineShifts)) chips.push(chip('violet', `${id} ${signed(d)}min`));
    for (const i of s.incidents) chips.push(chip('orange', `Incident ${i.id}`));
    return chips;
  }

  const signed = (v) => (v > 0 ? `+${v}` : String(v));
  const chip = (tone, text) => el('span.chip', { class: `chip--${tone}` }, el('i.dot'), text);

  function deadlineControl() {
    const candidates = store.orders
      .filter((o) => o.status !== 'delivered')
      .sort((a, b) => a.deadline - b.deadline)
      .slice(0, 40);
    if (!candidates.length) return el('p.basis', { style: { margin: 0 }, text: 'No open orders.' });

    const select = el('select', {
      'aria-label': 'Order whose deadline to move',
      style: {
        background: 'var(--deep)', border: '1px solid var(--line)', color: 'var(--text)',
        borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: '11px', flex: '1', minWidth: '0',
      },
    }, ...candidates.map((o) => el('option', {
      value: o.id, text: `${o.id} · ${o.consignee} · due ${clock(o.deadline)}`,
    })));

    return el('div.stack-sm', null,
      el('div.row', null, select),
      el('div.row.wrap', null, ...[-120, -60, -30, 30, 60, 120].map((d) => el('button.btn.btn--sm', {
        type: 'button', text: `${d > 0 ? '+' : ''}${d}m`,
        onclick: () => {
          store.setScenarioDeadline(select.value, d);
          emit(EV.TOAST, { message: `${select.value} deadline staged ${d > 0 ? 'later' : 'earlier'} by ${Math.abs(d)} minutes`, tone: 'info' });
          render();
        },
      }))));
  }

  /* ------------------------------------------------------ pipeline */

  function pipelineCard() {
    return panel('Replan pipeline', stage >= 0 ? el('span.chip.chip--cyan', null, el('i.dot'), 'Running') : null,
      el('div.stack-sm', null,
        el('div.replan-stages', null, ...STAGES.map((label, i) => el('div.replan-stage', {
          dataset: { state: stage > i ? 'done' : stage === i ? 'active' : 'idle' },
          text: label,
        }))),
        el('p', {
          style: { fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6', margin: '0' },
          text: store.scenarioTrigger
            ? `Last committed scenario: ${store.scenarioTrigger}.`
            : 'Stage one or more disruptions on the left, then press REPLAN. The world mutates, the impact on the existing plan is measured, and the optimiser re-runs against the new conditions.',
        }),
        store.scenarioImpacted ? el('dl.kv', null,
          ...kv('Stops now at risk', num(store.scenarioImpacted.metrics.lateOrders),
            store.scenarioImpacted.metrics.lateOrders ? 'var(--amber)' : undefined),
          ...kv('Unservable', num(store.scenarioImpacted.metrics.unserved),
            store.scenarioImpacted.metrics.unserved ? 'var(--red)' : undefined),
          ...kv('Old plan under new conditions', fkg(store.scenarioImpacted.metrics.co2, 1))) : null,
        el('p.basis', {
          text: 'Committed changes persist until you reset the world. Traffic multipliers, closures and vehicle availability all feed the router directly, so the re-plan is a genuine re-solve, not a re-label.',
        })));
  }

  async function runReplan() {
    if (store.optimizing) return;
    const label = store.describeScenario();
    stage = 0; render();
    announce(`Scenario committed: ${label}. Replanning.`);
    await pause(420); stage = 1; render();
    const plan = await store.replan();
    stage = 3; render();
    await pause(900); stage = -1; render();
    if (plan) {
      emit(EV.TOAST, { message: `Fleet replanned around ${label}.`, tone: 'good' });
    } else {
      emit(EV.TOAST, { message: 'Replan failed — see the event stream.', tone: 'bad' });
    }
  }

  async function resetWorld() {
    store.resetScenario();
    store.traffic.setGlobalMultiplier(1);
    store.traffic.clearIncidents();
    store.traffic.clearClosures();
    store.traffic.update(store.clockMinutes);
    store.router.invalidate();
    store.planEngine.invalidate();
    for (const v of store.vehicles) v.available = true;
    for (const o of store.orders) if (o.originalDeadline != null) { o.deadline = o.originalDeadline; o.originalDeadline = null; }
    store.scenarioComparison = null;
    store.scenarioImpacted = null;
    store.scenarioTrigger = null;
    store.logEvent('scenario', 'World reset — all disruptions lifted');
    await store.optimizeFleet({ trigger: 'World reset', label: 'Clean-conditions plan' });
    emit(EV.TOAST, { message: 'World reset and fleet re-optimised.', tone: 'good' });
    render();
  }

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  /* -------------------------------------------------------- what-if */

  function whatIfCard() {
    const scenarios = buildWhatIfScenarios(store);
    return panel('What-if engine', el('span.eyebrow', { text: 'NON-DESTRUCTIVE' }),
      el('div.stack-sm', null,
        el('p', {
          style: { fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6', margin: 0 },
          text: 'Ask a question without committing the answer. The world is mutated, re-optimised, measured, and then restored exactly as it was.',
        }),
        el('div.stack-sm', null, ...scenarios.map((sc) => el('button.btn.btn--sm.btn--block', {
          type: 'button', disabled: whatIfBusy || store.optimizing,
          style: { justifyContent: 'flex-start' },
          text: sc.question,
          onclick: () => runWhatIf(sc),
        }))),
        whatIfBusy ? el('div.progress', null, el('i', { style: { width: '60%' } })) : null,
        whatIfResult ? whatIfOutput(whatIfResult) : null));
  }

  function buildWhatIfScenarios(store) {
    const out = [];
    const busiest = (store.plan?.routes || [])
      .filter((r) => r.orderIds.length)
      .sort((a, b) => b.orderIds.length - a.orderIds.length)[0];
    if (busiest) {
      const v = store.vehiclesById.get(busiest.vehicleId);
      out.push({
        question: `What if ${v.callsign} becomes unavailable?`,
        label: `${v.callsign} unavailable`,
        mutate: (s) => { const veh = s.vehiclesById.get(v.id); if (veh) veh.available = false; },
      });
    }
    out.push({
      question: 'What if network traffic rises 60%?',
      label: 'Traffic +60%',
      mutate: (s) => s.traffic.setGlobalMultiplier(1.6),
    });
    out.push({
      question: 'What if every deadline tightened by an hour?',
      label: 'All deadlines −60 min',
      mutate: (s) => { for (const o of s.orders) o.deadline = Math.max(o.windowOpen + 20, o.deadline - 60); },
    });
    const ev = store.vehicles.filter((v) => v.energyType === 'bev');
    if (ev.length) {
      out.push({
        question: `What if the ${ev.length} electric vehicles were grounded?`,
        label: 'Electric fleet grounded',
        mutate: (s) => { for (const v of ev) { const veh = s.vehiclesById.get(v.id); if (veh) veh.available = false; } },
      });
    }
    return out;
  }

  async function runWhatIf(sc) {
    whatIfBusy = true; whatIfResult = null; render();
    announce(`Evaluating: ${sc.question}`);
    try {
      const result = await store.whatIf(sc.mutate, sc.label);
      whatIfResult = result ? { ...result, question: sc.question } : null;
      if (!result) emit(EV.TOAST, { message: 'What-if evaluation produced no feasible plan.', tone: 'bad' });
    } catch (err) {
      console.error(err);
      emit(EV.TOAST, { message: `What-if failed: ${err.message}`, tone: 'bad' });
    } finally {
      whatIfBusy = false; render();
    }
  }

  function whatIfOutput(r) {
    const before = r.before.metrics;
    const after = r.after.metrics;
    return el('div.stack-sm', { style: { marginTop: '10px' } },
      el('span.eyebrow', { text: r.question }),
      el('div.grid-2', null,
        el('div.panel', null,
          el('div.panel-head', null, el('h3', { text: 'Before' })),
          el('div.panel-body', null, el('dl.kv', null,
            ...kv('Vehicles', num(before.vehiclesUsed)),
            ...kv('Deliveries', num(before.stops)),
            ...kv('CO₂e', fkg(before.co2, 1)),
            ...kv('Fleet time', dur(before.minutes)),
            ...kv('Cost', money(before.cost)),
            ...kv('Unserved', num(before.unserved))))),
        el('div.panel.panel--warn', null,
          el('div.panel-head', null, el('h3', { text: 'After' })),
          el('div.panel-body', null, el('dl.kv', null,
            ...kv('Vehicles', num(after.vehiclesUsed)),
            ...kv('Deliveries', num(after.stops)),
            ...kv('CO₂e', fkg(after.co2, 1), after.co2 > before.co2 ? 'var(--red)' : 'var(--green)'),
            ...kv('Fleet time', dur(after.minutes), after.minutes > before.minutes ? 'var(--amber)' : 'var(--green)'),
            ...kv('Cost', money(after.cost), after.cost > before.cost ? 'var(--amber)' : 'var(--green)'),
            ...kv('Unserved', num(after.unserved), after.unserved > before.unserved ? 'var(--red)' : undefined))))),
      el('div.explain', null,
        el('div.why-title', { text: 'Recovery strategy' }),
        el('p', { text: r.comparison.verdict }),
        r.explanation ? el('ul.drivers', null, ...r.explanation.actions.map((a) => el('li', { dataset: { sign: '+' } },
          el('span.sign', { text: '→' }),
          el('span', null, el('span.d-label', { text: a }))))) : null,
        el('p.basis', { text: `${r.comparison.basis} The world was restored to its previous state immediately after measurement; the live plan is unchanged.` })));
  }

  /* --------------------------------------------------------- result */

  function resultCard() {
    const cmp = store.scenarioComparison;
    return panel('Replan outcome', el('span.eyebrow', { text: 'BEFORE → AFTER' }),
      el('div.stack', null,
        el('div.delta-grid', null, ...cmp.rows.map((r) => {
          const dir = r.improved ? 'good' : r.worsened ? 'bad' : 'flat';
          return el('div.delta-cell', { dataset: { dir } },
            el('span.k', { text: r.label }),
            el('span.vals', null,
              el('span.before', { text: r.fmt(r.before) }),
              el('span.after', { text: r.fmt(r.after) })),
            el('span.chg', { text: Math.abs(r.rel) < 0.0001 ? 'unchanged' : signedPct(r.rel, 1) }));
        })),
        store.lastExplanation ? el('div.explain', null,
          el('div.why-title', { text: 'Why did CarbonRoute change the plan?' }),
          el('p', { text: store.lastExplanation.headline }),
          el('ul.drivers', null, ...store.lastExplanation.actions.map((a) => el('li', { dataset: { sign: '+' } },
            el('span.sign', { text: '→' }),
            el('span', null, el('span.d-label', { text: a }))))),
          store.lastExplanation.objective ? el('p', { style: { marginTop: '8px' }, text: store.lastExplanation.objective }) : null,
          el('p.basis', { text: `${cmp.basis} The "before" column is the previous assignment re-costed under the new conditions, not its original figures — otherwise the disruption itself would be credited to the optimiser.` })) : null));
  }

  on(EV.SCENARIO_CHANGED, render);
  on(EV.PLAN_CHANGED, render);
  on(EV.OPT_DONE, render);
  render();
  return root;
}
