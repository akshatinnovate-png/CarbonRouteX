/**
 * GARAGE — PERSONAL mode.
 *
 * The vehicles one person actually owns. Deliberately small: a label, a type
 * and, for anyone who knows it, their real consumption figure. That last field
 * is the one that matters — a manufacturer's number and a ten-year-old car's
 * real number are not the same, and the emissions estimate is only as good as
 * the figure it is given.
 */

import { PERSONAL_VEHICLES, ENERGY } from '../../config.js';
import { EV, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { num } from '../../util/format.js';
import { icon } from '../icons.js';
import {
  pageWithActions, card, empty, field, fieldRow, textInput,
  numberInput, selectInput, confirmButton, statTile,
  deferWhileEditing,
} from '../components.js';
import { revealStagger } from '../motion.js';

export function garagePage(store) {
  const root = el('div.page-root');
  let formOpen = false;
  let editing = null;

  const render = raf1(() => {
    const p = store.personal;
    const list = p.vehicles;

    mount(root, pageWithActions(
      'Garage',
      'Your vehicles. The one selected here is the one every journey is costed against.',
      [
        el('button.btn.btn--primary', {
          type: 'button', html: `${icon('plus', 13)}<span>Add a vehicle</span>`,
          onclick: () => { editing = null; formOpen = true; render(); },
        }),
      ],
      el('div.stack', null,
        el('div.tile-row', null,
          statTile('Vehicles', num(list.length)),
          statTile('In use', PERSONAL_VEHICLES[p.vehicleKey]?.label || '—', { tone: 'gold' }),
          statTile('Journeys planned', num(p.history.length))),

        formOpen ? formCard() : null,

        card('Your vehicles', null,
          list.length
            ? el('div.stack-sm.garage-list', null, ...list.map((v) => vehicleRow(v)))
            : empty('No vehicles saved yet.',
              'You can plan journeys without saving one — the defaults for each vehicle type are used instead.')),

        card('Vehicle type defaults', null,
          el('div.grid-auto', null, ...Object.values(PERSONAL_VEHICLES).map((t) => el('div.type-card', {
            'aria-current': String(p.vehicleKey === t.key),
          },
          el('div.row', null,
            el('span.tc-icon', { html: icon(t.icon, 15) }),
            el('strong', { text: t.label })),
          el('p.dim', { text: t.note }),
          el('dl.kv', null,
            ...kvRow('Consumption', t.consumption ? `${t.consumption} ${t.unit}` : 'None'),
            ...kvRow('Carrier', ENERGY.unitLabel[t.energyType] ? t.energyType : 'human power'),
            ...kvRow('Running cost', t.costPerKm ? `₹${t.costPerKm.toFixed(2)}/km` : 'None')),
          el('button.btn.btn--sm.btn--block', {
            type: 'button',
            text: p.vehicleKey === t.key ? 'In use' : 'Use this vehicle',
            disabled: p.vehicleKey === t.key,
            onclick: () => { store.setPersonal({ vehicleKey: t.key }); announce(`${t.label} selected`); render(); },
          }))))),

        el('p.basis', {
          text: 'Consumption figures are typical values, not measurements of your vehicle. '
            + 'Enter your own figure on a saved vehicle and every estimate uses it instead.',
        }))));
    revealStagger(root.querySelectorAll('.type-card'));
  });

  const kvRow = (k, v) => [el('dt', { text: k }), el('dd', { text: v })];

  function vehicleRow(v) {
    const type = PERSONAL_VEHICLES[v.key] || PERSONAL_VEHICLES.CAR;
    return el('div.mini-row', { 'aria-current': String(store.personal.vehicleKey === v.key) },
      el('span.mini-bar', { style: { background: 'var(--teal)' } }),
      el('span.mini-text', null,
        el('strong', { text: v.label }),
        el('small', {
          text: `${type.label} · ${Number.isFinite(v.consumption) ? `${v.consumption} ${type.unit}` : `default ${type.consumption} ${type.unit}`}`,
        })),
      el('span.row-actions', null,
        el('button.btn.btn--sm', {
          type: 'button', text: 'Use',
          disabled: store.personal.vehicleKey === v.key,
          onclick: () => { store.setPersonal({ vehicleKey: v.key }); render(); },
        }),
        confirmButton('Remove', 'Confirm?', () => { store.removePersonalVehicle(v.id); render(); })));
  }

  function formCard() {
    const label = textInput({ value: editing?.label || '', placeholder: 'My car' });
    const type = selectInput(
      Object.values(PERSONAL_VEHICLES).map((t) => ({ value: t.key, label: t.label })),
      { value: editing?.key || store.personal.vehicleKey || 'CAR' },
    );
    const consumption = numberInput({
      value: editing?.consumption ?? PERSONAL_VEHICLES[store.personal.vehicleKey]?.consumption ?? 7.4,
      min: 0, max: 400, step: 0.1,
    });

    return card('Add a vehicle', null,
      el('div.form-grid', null,
        fieldRow(
          field('Name', label, { hint: 'Whatever you call it.' }),
          field('Type', type)),
        field('Consumption per 100 km', consumption, {
          hint: 'Litres, kWh or kg per 100 km. Leave the default if you do not know yours — a bicycle ignores this.',
        })),
      el('div.form-actions', null,
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => { formOpen = false; render(); } }),
        el('button.btn.btn--primary', {
          type: 'button', text: 'Save vehicle',
          onclick: () => {
            store.addPersonalVehicle({
              key: type.value,
              label: label.value,
              consumption: Number(consumption.input.value),
            });
            formOpen = false;
            announce('Vehicle saved');
            render();
          },
        })));
  }

  const background = deferWhileEditing(root, render, () => formOpen);
  on(EV.ENTITIES_CHANGED, background);
  on(EV.STATE_CHANGED, background);
  render();
  return root;
}
