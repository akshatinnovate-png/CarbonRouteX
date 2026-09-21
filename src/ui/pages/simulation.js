/**
 * SIMULATION PAGE — the digital twin.
 *
 * Stage disruptions against the modelled world, commit them, and watch the
 * pipeline run: EVENT -> DETECTION -> OPTIMISATION -> NEW PLAN.
 *
 * The before/after deliberately re-costs the EXISTING plan under the NEW
 * conditions before comparing. Comparing the new plan against the old plan's
 * old numbers would credit the optimiser with avoiding a disruption it did not
 * cause, which is the difference between an explanation and a sales pitch.
 */

import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { clock, dur, kg as fkg, money, num, pct, signedPct } from '../../util/format.js';
import { icon } from '../icons.js';
import { page, card, kv, empty, chip, statTile, selectInput } from '../components.js';

const TRAFFIC_LEVELS = [
  { key: 'normal', label: 'Normal' },
  { key: 'plus10', label: '+10%' },
  { key: 'plus30', label: '+30%' },
  { key: 'plus60', label: '+60%' },
  { key: 'severe', label: 'Severe' },
];
const STAGES = ['Event', 'Detection', 'Optimisation', 'New plan'];

export function simulationPage(store, map) {
  const root = el('div.page-root');
  let stage = -1;
  let whatIfResult = null;
  let whatIfBusy = false;

  const render = raf1(() => {
    mount(root, page('Simulation',
      'Break the world on purpose, then let the optimiser recover from it.',
      el('div.stack', null,
        el('div.grid-2', null, controls(), pipeline()),
        store.scenarioComparison ? outcome() : null,
        whatIf())));
  });

  /* ----------------------------------------------------- controls */

  function controls() {
    const s = store.pendingScenario;
    return card('Staged disruptions', store.scenarioIsEmpty() ? null : chip('Staged', 'amber'),
      el('div.stack', null,
        group('1', 'Traffic', el('div.segmented', { role: 'group', 'aria-label': 'Traffic level' },
          ...TRAFFIC_LEVELS.map((t) => el('button', {
            type: 'button', text: t.label,
            'aria-pressed': String(s.trafficLevel === t.key),
            onclick: () => { store.setScenarioTraffic(t.key); render(); },
          })))),

        group('2', 'Vehicle failure', store.vehicles.length
          ? el('div.row.wrap', null, ...store.vehicles.map((v) => el('button.chip', {
            type: 'button',
            class: s.disabledVehicles.includes(v.id) ? 'chip--red' : '',
            style: { cursor: 'pointer' },
            'aria-pressed': String(s.disabledVehicles.includes(v.id)),
            onclick: () => { store.toggleScenarioVehicle(v.id); render(); },
          }, el('i.dot'), v.callsign)))
          : el('p.basis', { text: 'No vehicles in the fleet yet.' })),

        group('3', 'Deadline change', deadlineControl()),

        group('4', 'Road closure', el('div.row.wrap', null,
          ...(store.plan?.routes || []).filter((r) => r.stops.length > 1).slice(0, 8).map((r) => el('button.chip', {
            type: 'button', style: { cursor: 'pointer' },
            title: `Close a link in the middle of ${r.id}`,
            onclick: () => {
              const n = store.closeRouteCorridor(r.id);
              emit(EV.TOAST, {
                message: n ? `A link on ${r.id} staged for closure` : `${r.id} has no closable link`,
                tone: n ? 'info' : 'bad',
              });
              render();
            },
          }, el('i.dot'), `Close a link on ${r.id}`)),
          el('button.chip.chip--orange', {
            type: 'button', style: { cursor: 'pointer' },
            title: 'Add a congestion incident at the map centre',
            onclick: () => {
              store.addIncidentNear(map.centre.lon, map.centre.lat, 1.2, 5);
              emit(EV.TOAST, { message: 'Congestion incident staged at the current map centre', tone: 'info' });
              map.invalidate();
              render();
            },
          }, el('i.dot'), 'Incident here'))),

        el('div.hr'),
        el('span.eyebrow', { text: 'Staged changes' }),
        el('div.staged', null, ...stagedChips()),
        el('div.row.wrap', null,
          el('button.btn.btn--primary', {
            type: 'button', style: { flex: '1' },
            disabled: store.optimizing || store.scenarioIsEmpty(),
            html: `${icon('bolt', 13)}<span>Replan</span>`,
            onclick: runReplan,
          }),
          el('button.btn', {
            type: 'button', text: 'Clear', disabled: store.scenarioIsEmpty(),
            onclick: () => { store.resetScenario(); render(); },
          }),
          el('button.btn', {
            type: 'button', text: 'Reset world', disabled: store.optimizing, onclick: resetWorld,
          }))));
  }

  const group = (n, title, body) => el('div.sc-group', null,
    el('span.sc-title', null, el('span.n', { text: n }), title), body);

  function stagedChips() {
    const s = store.pendingScenario;
    const out = [];
    if (s.trafficMultiplier !== 1) out.push(chip(`Traffic ${signedPct(s.trafficMultiplier - 1, 0)}`, 'amber'));
    for (const id of s.disabledVehicles) out.push(chip(`${store.vehiclesById.get(id)?.callsign || id} disabled`, 'red'));
    if (s.closedRoutes.length) out.push(chip(`${s.closedRoutes.length} link(s) closed`, 'red'));
    for (const [id, d] of Object.entries(s.deadlineShifts)) {
      out.push(chip(`${store.ordersById.get(id)?.ref || id} ${d > 0 ? '+' : ''}${d}min`, 'violet'));
    }
    for (const i of s.incidents) out.push(chip(`Incident ${i.id}`, 'orange'));
    return out;
  }

  function deadlineControl() {
    const open = store.orders.filter((o) => o.status !== 'delivered').sort((a, b) => a.deadline - b.deadline).slice(0, 60);
    if (!open.length) return el('p.basis', { text: 'No open orders.' });
    const select = selectInput(open.map((o) => ({
      value: o.id, label: `${o.ref} · ${o.consignee} · due ${clock(o.deadline)}`,
    })), { style: { flex: '1', minWidth: '0' } });
    return el('div.stack-sm', null,
      select,
      el('div.row.wrap', null, ...[-120, -60, -30, 30, 60, 120].map((d) => el('button.btn.btn--sm', {
        type: 'button', text: `${d > 0 ? '+' : ''}${d}m`,
        onclick: () => {
          store.setScenarioDeadline(select.value, d);
          emit(EV.TOAST, { message: `Deadline staged ${d > 0 ? 'later' : 'earlier'} by ${Math.abs(d)} minutes`, tone: 'info' });
          render();
        },
      }))));
  }

  /* ----------------------------------------------------- pipeline */

  function pipeline() {
    return card('Replan pipeline', stage >= 0 ? chip('Running', 'cyan') : null,
      el('div.stack-sm', null,
        el('div.replan-stages', null, ...STAGES.map((label, i) => el('div.replan-stage', {
          dataset: { state: stage > i ? 'done' : stage === i ? 'active' : 'idle' },
          text: label,
        }))),
        el('p', {
          style: { fontSize: '12.5px', color: 'var(--text-dim)', lineHeight: '1.6', margin: 0 },
          text: store.scenarioTrigger
            ? `Last committed scenario: ${store.scenarioTrigger}.`
            : 'Stage one or more disruptions, then press REPLAN. The world changes, the impact on the existing plan is measured, and the optimiser re-runs against the new conditions.',
        }),
        store.scenarioImpacted ? el('dl.kv', null,
          ...kv('Stops now at risk', num(store.scenarioImpacted.metrics.lateOrders),
            store.scenarioImpacted.metrics.lateOrders ? 'var(--gold-deep)' : undefined),
          ...kv('Unservable', num(store.scenarioImpacted.metrics.unserved),
            store.scenarioImpacted.metrics.unserved ? 'var(--danger)' : undefined),
          ...kv('Old plan, new conditions', fkg(store.scenarioImpacted.metrics.co2, 1))) : null,
        el('p.basis', {
          text: 'Committed changes persist until you reset the world. The traffic multiplier, closures and vehicle availability all feed the cost model directly, so a replan is a genuine re-solve, not a re-label.',
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
    emit(EV.TOAST, plan
      ? { message: `Fleet replanned around ${label}.`, tone: 'good' }
      : { message: 'Replan failed — see the Events tab.', tone: 'bad' });
  }

  async function resetWorld() {
    store.resetScenario();
    store.matrix.setTrafficMultiplier(1);
    store.matrix.clearIncidents();
    store.matrix.clearClosures();
    store.planEngine.invalidate();
    for (const v of store.vehicles) v.available = true;
    for (const o of store.orders) {
      if (o.originalDeadline != null) { o.deadline = o.originalDeadline; o.originalDeadline = null; }
    }
    store.scenarioComparison = null;
    store.scenarioImpacted = null;
    store.scenarioTrigger = null;
    store.logEvent('scenario', 'World reset — all disruptions lifted');
    map.invalidate();
    await store.optimizeFleet({ trigger: 'World reset', label: 'Clean-conditions plan' });
    emit(EV.TOAST, { message: 'World reset and fleet re-optimised.', tone: 'good' });
    render();
  }

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------ what-if */

  function whatIf() {
    const scenarios = buildScenarios();
    return card('What-if engine', el('span.eyebrow', { text: 'NON-DESTRUCTIVE' }),
      el('div.stack-sm', null,
        el('p', {
          style: { fontSize: '12.5px', color: 'var(--text-dim)', lineHeight: '1.6', margin: 0 },
          text: 'Ask a question without committing the answer. The world is changed, re-optimised, measured, and then restored exactly as it was.',
        }),
        scenarios.length
          ? el('div.row.wrap', null, ...scenarios.map((sc) => el('button.btn.btn--sm', {
            type: 'button', disabled: whatIfBusy || store.optimizing, text: sc.question,
            onclick: () => runWhatIf(sc),
          })))
          : empty('Build a plan first — what-if questions are asked against a live plan.'),
        whatIfBusy ? el('div.progress', null, el('i', { style: { width: '60%' } })) : null,
        whatIfResult ? whatIfOutput(whatIfResult) : null));
  }

  function buildScenarios() {
    if (!store.plan) return [];
    const out = [];
    const busiest = store.plan.routes.filter((r) => r.orderIds.length)
      .sort((a, b) => b.orderIds.length - a.orderIds.length)[0];
    if (busiest) {
      const v = store.vehiclesById.get(busiest.vehicleId);
      if (v) {
        out.push({
          question: `What if ${v.callsign} becomes unavailable?`,
          label: `${v.callsign} unavailable`,
          mutate: (s) => { const veh = s.vehiclesById.get(v.id); if (veh) veh.available = false; },
        });
      }
    }
    out.push({
      question: 'What if traffic rises 60%?',
      label: 'Traffic +60%',
      mutate: (s) => s.matrix.setTrafficMultiplier(1.6),
    });
    out.push({
      question: 'What if every deadline tightened by an hour?',
      label: 'All deadlines −60 min',
      mutate: (s) => { for (const o of s.orders) o.deadline = Math.max(o.windowOpen + 20, o.deadline - 60); },
    });
    const ev = store.vehicles.filter((v) => v.energyType === 'bev');
    if (ev.length) {
      out.push({
        question: `What if the ${ev.length} electric vehicle${ev.length > 1 ? 's were' : ' was'} grounded?`,
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
      if (!result) emit(EV.TOAST, { message: 'That what-if produced no feasible plan.', tone: 'bad' });
    } catch (err) {
      emit(EV.TOAST, { message: `What-if failed: ${err.message}`, tone: 'bad' });
    } finally {
      whatIfBusy = false; render();
    }
  }

  function whatIfOutput(r) {
    const b = r.before.metrics, a = r.after.metrics;
    return el('div.stack-sm', { style: { marginTop: '10px' } },
      el('span.eyebrow', { text: r.question }),
      el('div.grid-2', null,
        el('div.panel', null,
          el('div.panel-head', null, el('h3', { text: 'Before' })),
          el('div.panel-body', null, el('dl.kv', null,
            ...kv('Vehicles', num(b.vehiclesUsed)),
            ...kv('Deliveries', num(b.stops)),
            ...kv('CO₂e', fkg(b.co2, 1)),
            ...kv('Fleet time', dur(b.minutes)),
            ...kv('Cost', money(b.cost)),
            ...kv('Unserved', num(b.unserved))))),
        el('div.panel.panel--warn', null,
          el('div.panel-head', null, el('h3', { text: 'After' })),
          el('div.panel-body', null, el('dl.kv', null,
            ...kv('Vehicles', num(a.vehiclesUsed)),
            ...kv('Deliveries', num(a.stops)),
            ...kv('CO₂e', fkg(a.co2, 1), a.co2 > b.co2 ? 'var(--danger)' : 'var(--success)'),
            ...kv('Fleet time', dur(a.minutes), a.minutes > b.minutes ? 'var(--gold-deep)' : 'var(--success)'),
            ...kv('Cost', money(a.cost), a.cost > b.cost ? 'var(--gold-deep)' : 'var(--success)'),
            ...kv('Unserved', num(a.unserved), a.unserved > b.unserved ? 'var(--danger)' : undefined))))),
      el('div.explain', null,
        el('div.why-title', { text: 'Recovery strategy' }),
        el('p', { text: r.comparison.verdict }),
        r.explanation ? el('ul.drivers', null, ...r.explanation.actions.map((x) => el('li', { dataset: { sign: '+' } },
          el('span.sign', { text: '→' }),
          el('span', null, el('span.d-label', { text: x }))))) : null,
        el('p.basis', { text: `${r.comparison.basis} The world was restored immediately after measurement; the live plan is unchanged.` })));
  }

  /* ------------------------------------------------------ outcome */

  function outcome() {
    const cmp = store.scenarioComparison;
    return card('Replan outcome', el('span.eyebrow', { text: 'BEFORE → AFTER' }),
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
          el('p.basis', {
            text: `${cmp.basis} The "before" column is the previous assignment re-costed under the new conditions, `
              + 'not its original figures — otherwise the disruption itself would be credited to the optimiser.',
          })) : null));
  }

  on(EV.SCENARIO_CHANGED, render);
  on(EV.PLAN_CHANGED, render);
  on(EV.OPT_DONE, render);
  on(EV.ENTITIES_CHANGED, render);
  render();
  return root;
}
