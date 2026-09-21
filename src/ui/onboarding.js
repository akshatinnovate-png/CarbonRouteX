/**
 * SIGN-IN AND SETUP
 *
 * A new operator arrives at an empty workspace, so the first run walks them
 * through the four things the optimiser cannot run without: a region, at least
 * one depot, at least one vehicle, and at least one delivery.
 *
 * Every step is skippable and everything added here can equally be added,
 * edited or removed later from the Depots, Fleet and Orders tabs — the wizard
 * is a convenience, never the only path.
 *
 * "Sign in" is local. There is no server, so there is no password: the name
 * identifies whose workspace this is on a shared machine and nothing more,
 * and the UI says so rather than implying a security property it lacks.
 */

import { VEHICLE_TYPES, PRIORITY, SIM, APP } from '../config.js';
import { EV, emit, on } from '../core/bus.js';
import { el, mount, announce, focusInto } from '../util/dom.js';
import { clock, num } from '../util/format.js';
import { icon } from './icons.js';
import {
  field, textInput, numberInput, selectInput, timeInput, fieldRow,
  locationPicker, chip, empty,
} from './components.js';

const STEPS = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'region', label: 'Region' },
  { key: 'depots', label: 'Depots' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'orders', label: 'Deliveries' },
  { key: 'done', label: 'Ready' },
];

export function initOnboarding(store, { onComplete }) {
  const root = document.getElementById('onboarding');
  let step = 0;

  function show() {
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.getElementById('app').setAttribute('aria-hidden', 'true');
    render();
  }

  function hide() {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.getElementById('app').removeAttribute('aria-hidden');
  }

  function goTo(index) {
    step = Math.max(0, Math.min(STEPS.length - 1, index));
    render();
    announce(`Step ${step + 1} of ${STEPS.length}: ${STEPS[step].label}`);
  }

  function finish() {
    store.completeOnboarding();
    hide();
    onComplete?.();
  }

  /* ---------------------------------------------------------------- */

  function render() {
    const current = STEPS[step];
    mount(root,
      el('div.ob-shell', null,
        el('aside.ob-rail', null,
          el('div.ob-brand', null,
            el('span.ob-mark', { html: brandMark() }),
            el('span', null,
              el('strong', { text: 'CarbonRoute' }),
              el('small', { text: APP.tagline }))),
          el('ol.ob-steps', null, ...STEPS.map((s, i) => el('li.ob-step', {
            dataset: { state: i < step ? 'done' : i === step ? 'active' : 'todo' },
          },
          el('span.ob-step-dot', { text: i < step ? '✓' : String(i + 1) }),
          el('span', { text: s.label })))),
          el('p.ob-note', {
            text: 'Everything you add here can be changed later from the Depots, Fleet and Orders tabs.',
          })),
        el('main.ob-main', { id: 'ob-main' }, renderStep(current.key))));
    const firstInput = root.querySelector('.ob-main input, .ob-main select, .ob-main button');
    if (firstInput && step > 0) setTimeout(() => focusInto(firstInput), 40);
  }

  function renderStep(key) {
    switch (key) {
      case 'welcome': return stepWelcome();
      case 'region': return stepRegion();
      case 'depots': return stepDepots();
      case 'fleet': return stepFleet();
      case 'orders': return stepOrders();
      default: return stepDone();
    }
  }

  const stepHead = (title, blurb) => el('div.ob-head', null,
    el('h1', { text: title }),
    el('p', { text: blurb }));

  const nav = ({ back = true, next = 'Continue', onNext, skip = null, nextDisabled = false } = {}) =>
    el('div.ob-nav', null,
      back ? el('button.btn', { type: 'button', text: 'Back', onclick: () => goTo(step - 1) }) : el('span'),
      el('span.spacer'),
      skip ? el('button.btn.btn--ghost', { type: 'button', text: skip, onclick: () => goTo(step + 1) }) : null,
      el('button.btn.btn--primary', {
        type: 'button', text: next, disabled: nextDisabled,
        onclick: onNext || (() => goTo(step + 1)),
      }));

  /* ------------------------------------------------------ welcome */

  function stepWelcome() {
    const name = textInput({
      value: store.workspace.account?.name || '',
      placeholder: 'Your name',
      onkeydown: (e) => { if (e.key === 'Enter') submit(); },
    });
    const org = textInput({
      value: store.workspace.account?.org || '',
      placeholder: 'Company or depot group (optional)',
    });

    const submit = () => {
      if (!name.value.trim()) { name.focus(); return; }
      store.signIn({ name: name.value, org: org.value });
      goTo(1);
    };

    return el('div.ob-panel', null,
      stepHead('Welcome to CarbonRoute',
        'A logistics command centre that plans your fleet across real roads, and optimises for time, cost and carbon at the same time.'),
      el('div.ob-form', null,
        field('Your name', name, { required: true }),
        field('Organisation', org, { hint: 'Shown in the header. Optional.' })),
      el('div.ob-callout', null,
        el('span', { html: icon('info', 15) }),
        el('p', {
          text: 'This is a local sign-in. There is no account server and no password: '
            + 'your name simply labels this workspace, and all of your data stays in this browser.',
        })),
      el('ul.ob-facts', null,
        fact('map', 'Real map, real roads', 'OpenStreetMap cartography with road routing from OSRM. No API key needed.'),
        fact('bolt', 'A real optimiser', 'Capacity, range and deadline constrained vehicle routing, not a nearest-neighbour toy.'),
        fact('leaf', 'Carbon as an objective', 'Emissions are optimised alongside time and cost, not reported after the fact.')),
      nav({ back: false, next: 'Get started', onNext: submit }));
  }

  const fact = (ic, title, body) => el('li', null,
    el('span.ob-fact-icon', { html: icon(ic, 15) }),
    el('span', null, el('strong', { text: title }), el('span', { text: body })));

  /* ------------------------------------------------------- region */

  function stepRegion() {
    const picker = locationPicker(store, {
      value: store.workspace.region,
      placeholder: 'Search your city or operating area…',
      onPick: () => render(),
    });
    const current = store.workspace.region;

    return el('div.ob-panel', null,
      stepHead('Where do you operate?',
        'This centres the map and biases address search. You can move outside it at any time.'),
      el('div.ob-form', null, field('Operating region', picker, {
        hint: 'A city or metro area works best. Pick on the map if your area has no obvious name.',
      })),
      current ? el('div.ob-callout', null,
        el('span', { html: icon('check', 15) }),
        el('p', { text: `Currently set to ${current.short || current.label}.` })) : null,
      nav({
        next: 'Continue',
        skip: current ? null : 'Skip for now',
        onNext: () => {
          const v = picker.getValue();
          if (v) store.setRegion(v);
          goTo(step + 1);
        },
      }));
  }

  /* ------------------------------------------------------- depots */

  function stepDepots() {
    const name = textInput({ placeholder: 'Northgate DC' });
    const picker = locationPicker(store, { placeholder: 'Search the depot address…' });
    const docks = numberInput({ value: 4, min: 1, max: 40 });
    const opens = timeInput({ minutes: SIM.dayStartMinutes - 60 });
    const closes = timeInput({ minutes: SIM.dayEndMinutes + 60 });

    const add = () => {
      const loc = picker.getValue();
      if (!loc) {
        emit(EV.TOAST, { message: 'Choose the depot location first — search an address or pick it on the map.', tone: 'bad' });
        return;
      }
      store.addDepot({
        name: name.value,
        lon: loc.lon, lat: loc.lat, label: loc.label, short: loc.short,
        dockCount: Number(docks.input?.value ?? docks.value) || 4,
        openMinutes: opens.getMinutes(),
        closeMinutes: closes.getMinutes(),
      });
      render();
    };

    return el('div.ob-panel', null,
      stepHead('Add your depots',
        'Every route starts and ends at a depot. Add at least one; add more if you run multiple sites.'),
      el('div.ob-split', null,
        el('div.ob-form', null,
          field('Depot name', name),
          field('Location', picker, { required: true }),
          fieldRow(
            field('Loading docks', docks),
            field('Opens', opens),
            field('Closes', closes)),
          el('button.btn.btn--primary', {
            type: 'button', html: `${icon('plus', 13)}<span>Add depot</span>`, onclick: add,
          })),
        el('div.ob-list', null,
          el('h3', { text: `Depots (${store.depots.length})` }),
          store.depots.length
            ? el('div.stack-sm', null, ...store.depots.map((d) => entityRow(
              d.name, `${d.short} · ${d.dockCount} docks · ${clock(d.openMinutes)}–${clock(d.closeMinutes)}`,
              () => { store.removeDepot(d.id); render(); },
            )))
            : empty('No depots yet.', 'You need at least one to plan routes.'))),
      nav({ next: 'Continue', nextDisabled: store.depots.length === 0 }));
  }

  /* -------------------------------------------------------- fleet */

  function stepFleet() {
    const typeOptions = Object.values(VEHICLE_TYPES).map((t) => ({
      value: t.key, label: `${t.label} — ${num(t.capacityKg)} kg, ${t.rangeKm} km range`,
    }));
    const type = selectInput(typeOptions, { value: 'diesel_van' });
    const callsign = textInput({ placeholder: 'Auto-generated if blank' });
    const driver = textInput({ placeholder: 'Driver name (optional)' });
    const reg = textInput({ placeholder: 'Registration (optional)' });
    const depot = selectInput(
      store.depots.map((d) => ({ value: d.id, label: d.name })),
      { value: store.depots[0]?.id },
    );
    const energy = numberInput({ value: 90, min: 5, max: 100, suffix: '%' });

    const add = () => {
      store.addVehicle({
        type: type.value,
        callsign: callsign.value,
        driver: driver.value,
        registration: reg.value,
        depotId: depot.value,
        energyLevel: (Number(energy.input.value) || 90) / 100,
      });
      callsign.value = ''; driver.value = ''; reg.value = '';
      render();
    };

    return el('div.ob-panel', null,
      stepHead('Add your vehicles',
        'Type determines capacity, consumption, range and running cost — all of which the optimiser treats as hard constraints.'),
      el('div.ob-split', null,
        el('div.ob-form', null,
          field('Vehicle type', type, { required: true }),
          fieldRow(field('Callsign', callsign), field('Registration', reg)),
          fieldRow(field('Driver', driver), field('Home depot', depot)),
          field('Starting fuel / charge', energy),
          el('button.btn.btn--primary', {
            type: 'button', html: `${icon('plus', 13)}<span>Add vehicle</span>`, onclick: add,
          })),
        el('div.ob-list', null,
          el('h3', { text: `Fleet (${store.vehicles.length})` }),
          store.vehicles.length
            ? el('div.stack-sm', null, ...store.vehicles.map((v) => entityRow(
              v.callsign,
              `${v.typeLabel} · ${num(v.capacityKg)} kg · ${Math.round(v.energyLevel * 100)}% · ${store.depotsById.get(v.depotId)?.name || 'No depot'}`,
              () => { store.removeVehicle(v.id); render(); },
            )))
            : empty('No vehicles yet.', 'Add at least one to plan a route.'))),
      nav({ next: 'Continue', nextDisabled: store.vehicles.length === 0 }));
  }

  /* ------------------------------------------------------- orders */

  function stepOrders() {
    const consignee = textInput({ placeholder: 'Customer or site name' });
    const picker = locationPicker(store, { placeholder: 'Search the delivery address…' });
    const weight = numberInput({ value: 120, min: 1, max: 30000, suffix: 'kg' });
    const priority = selectInput(
      Object.values(PRIORITY).map((p) => ({ value: p.key, label: p.label })),
      { value: 'standard' },
    );
    const from = timeInput({ minutes: SIM.dayStartMinutes });
    const to = timeInput({ minutes: SIM.dayEndMinutes });
    const goods = textInput({ placeholder: 'Goods description (optional)' });

    const add = () => {
      const loc = picker.getValue();
      if (!loc) {
        emit(EV.TOAST, { message: 'Choose the delivery location first.', tone: 'bad' });
        return;
      }
      if (to.getMinutes() <= from.getMinutes()) {
        emit(EV.TOAST, { message: 'The delivery deadline must be after the window opens.', tone: 'bad' });
        return;
      }
      store.addOrder({
        consignee: consignee.value,
        lon: loc.lon, lat: loc.lat, label: loc.label, short: loc.short,
        weightKg: Number(weight.input.value) || 1,
        priority: priority.value,
        windowOpen: from.getMinutes(),
        deadline: to.getMinutes(),
        goods: goods.value,
      });
      consignee.value = ''; goods.value = '';
      picker.setValue(null);
      render();
    };

    return el('div.ob-panel', null,
      stepHead('Add today’s deliveries',
        'Each delivery needs a location, a weight and a deadline. The optimiser treats capacity and deadlines as real constraints.'),
      el('div.ob-split', null,
        el('div.ob-form', null,
          field('Consignee', consignee),
          field('Delivery address', picker, { required: true }),
          fieldRow(field('Weight', weight), field('Priority', priority)),
          fieldRow(field('Window opens', from), field('Deadline', to)),
          field('Goods', goods),
          el('button.btn.btn--primary', {
            type: 'button', html: `${icon('plus', 13)}<span>Add delivery</span>`, onclick: add,
          })),
        el('div.ob-list', null,
          el('h3', { text: `Deliveries (${store.orders.length})` }),
          store.orders.length
            ? el('div.stack-sm', { style: { maxHeight: '420px', overflowY: 'auto' } },
              ...store.orders.map((o) => entityRow(
                `${o.ref} · ${o.consignee}`,
                `${o.short} · ${num(o.weightKg)} kg · due ${clock(o.deadline)}`,
                () => { store.removeOrder(o.id); render(); },
                PRIORITY[o.priority].color,
              )))
            : empty('No deliveries yet.', 'Add at least one to build a plan.'))),
      nav({ next: 'Continue', nextDisabled: store.orders.length === 0 }));
  }

  /* --------------------------------------------------------- done */

  function stepDone() {
    return el('div.ob-panel', null,
      stepHead('Your network is ready',
        'CarbonRoute will now fetch real road distances between every stop and build an optimised plan.'),
      el('div.ob-summary', null,
        summaryTile('Depots', store.depots.length),
        summaryTile('Vehicles', store.vehicles.length),
        summaryTile('Deliveries', store.orders.length),
        summaryTile('Total load', `${num(store.orders.reduce((a, o) => a + o.weightKg, 0))} kg`)),
      el('div.ob-callout', null,
        el('span', { html: icon('info', 15) }),
        el('p', {
          text: 'Road distances and travel times come from a free public routing service over OpenStreetMap data. '
            + 'Traffic is modelled from time of day, not observed live — the app labels every figure accordingly.',
        })),
      el('div.ob-nav', null,
        el('button.btn', { type: 'button', text: 'Back', onclick: () => goTo(step - 1) }),
        el('span.spacer'),
        el('button.btn.btn--primary.btn--lg', {
          type: 'button', html: `${icon('bolt', 14)}<span>Open the command centre</span>`,
          onclick: finish,
        })));
  }

  const summaryTile = (label, value) => el('div.ob-tile', null,
    el('strong.num', { text: String(value) }),
    el('span', { text: label }));

  function entityRow(title, sub, onRemove, accent) {
    return el('div.ob-row', null,
      el('span.ob-row-bar', { style: { background: accent || 'var(--cyan)' } }),
      el('span.ob-row-text', null,
        el('strong', { text: title }),
        el('small', { text: sub })),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button', 'aria-label': `Remove ${title}`, html: icon('close', 11), onclick: onRemove,
      }));
  }

  /* ---------------------------------------------------------------- */

  return { show, hide, goTo, isOpen: () => !root.hidden };
}

function brandMark() {
  return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M6 22c4-10 16-10 20 0" stroke="#34d99a" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="6" cy="22" r="3.2" fill="#62c8f8"/>
    <circle cx="26" cy="22" r="3.2" fill="#34d99a"/>
    <circle cx="16" cy="13.5" r="2.2" fill="#f2f6fb"/>
  </svg>`;
}
