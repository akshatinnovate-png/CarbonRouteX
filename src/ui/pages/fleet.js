/**
 * FLEET PAGE — the vehicle register plus live telemetry.
 *
 * Vehicle type is not cosmetic: it sets capacity, consumption, usable range and
 * running cost, all of which the optimiser enforces as hard constraints.
 */

import { VEHICLE_TYPES } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, throttle, announce } from '../../util/dom.js';
import { clock, dur, kg as fkg, km as fkm, money, num, pct } from '../../util/format.js';
import { vehicleColor } from '../../render/palette.js';
import { energyUnitLabel } from '../../engines/energy.js';
import { icon } from '../icons.js';
import {
  pageWithActions, card, dataTable, empty, field, fieldRow, textInput,
  numberInput, selectInput, confirmButton, statTile, chip,
} from '../components.js';

export function fleetPage(store, map) {
  const root = el('div.page-root');
  let editing = null;
  let formOpen = false;

  const render = raf1(() => {
    const vehicles = store.vehicles;
    const totalCapacity = vehicles.reduce((a, v) => a + (VEHICLE_TYPES[v.type]?.capacityKg || 0), 0);
    const bookedLoad = store.openOrders().reduce((a, o) => a + o.weightKg, 0);

    mount(root, pageWithActions(
      'Fleet',
      'Capacity, consumption and range come from the vehicle type and are enforced as hard constraints.',
      [
        el('button.btn.btn--primary', {
          type: 'button', html: `${icon('plus', 13)}<span>Add vehicle</span>`,
          disabled: !store.depots.length,
          title: store.depots.length ? '' : 'Add a depot first — every vehicle needs a home base.',
          onclick: () => { editing = null; formOpen = true; render(); },
        }),
      ],
      el('div.stack', null,
        el('div.tile-row', null,
          statTile('Vehicles', num(vehicles.length)),
          statTile('Available', num(vehicles.filter((v) => v.available).length),
            { tone: vehicles.some((v) => !v.available) ? 'amber' : '' }),
          statTile('Fleet capacity', `${num(totalCapacity)}`, { sub: 'kg' }),
          statTile('Booked load', `${num(bookedLoad)}`, {
            sub: 'kg', tone: bookedLoad > totalCapacity ? 'red' : '',
          })),
        bookedLoad > totalCapacity ? el('div.notice.notice--bad', null,
          el('span', { html: icon('alert', 15) }),
          el('p', {
            text: `Booked load (${num(bookedLoad)} kg) exceeds total fleet capacity (${num(totalCapacity)} kg). `
              + 'Some orders cannot be served until you add capacity or remove work.',
          })) : null,
        !store.depots.length ? el('div.notice', null,
          el('span', { html: icon('info', 15) }),
          el('p', { text: 'Add a depot before adding vehicles — every vehicle is based at one.' })) : null,
        formOpen ? formCard() : null,
        card('Register', null, vehicles.length ? table() : empty(
          'No vehicles yet.',
          'Add at least one to build a plan.',
        )))));
  });

  function table() {
    return dataTable(store.vehicles, [
      {
        key: 'callsign', label: 'Callsign', name: true,
        render: (v) => el('span.row-lead', null,
          el('i.row-swatch', { style: { background: v.available ? vehicleColor(store.vehicles.indexOf(v)) : 'var(--red)' } }),
          el('span', null, el('strong', { text: v.callsign }),
            el('small', { text: v.registration || v.driver }))),
      },
      { key: 'type', label: 'Type', name: true, get: (v) => v.typeLabel },
      { key: 'depot', label: 'Depot', name: true, get: (v) => store.depotsById.get(v.depotId)?.name || '—' },
      { key: 'capacity', label: 'Capacity', right: true, get: (v) => `${num(VEHICLE_TYPES[v.type]?.capacityKg ?? 0)} kg` },
      {
        key: 'energy', label: 'Energy', right: true,
        render: (v) => el('span.meter-cell', null,
          el('span.num', { text: pct(v.energyLevel, 0) }),
          el('span.meter', { style: { '--meter-color': v.energyLevel < 0.2 ? 'var(--red)' : v.energyLevel < 0.35 ? 'var(--amber)' : 'var(--green)' } },
            el('i', { style: { width: `${Math.round(v.energyLevel * 100)}%` } }))),
      },
      {
        key: 'status', label: 'Status',
        render: (v) => chip(v.available ? v.status : 'out of service', statusTone(v)),
      },
      {
        key: 'route', label: 'Assignment', right: true,
        get: (v) => {
          const r = store.routeByVehicle.get(v.id);
          return r && r.orderIds.length ? `${r.stops.length} stops` : '—';
        },
      },
      {
        key: 'co2', label: 'CO₂e', right: true,
        get: (v) => {
          const r = store.routeByVehicle.get(v.id);
          return r && r.orderIds.length ? fkg(r.co2, 1) : '—';
        },
      },
      {
        key: 'actions', label: '', right: true,
        render: (v) => el('div.row-actions', null,
          el('button.btn.btn--ghost.btn--sm', {
            type: 'button', title: 'Show on the map', html: icon('target', 12),
            onclick: () => {
              store.select('vehicle', v.id, { force: true });
              const r = store.routeByVehicle.get(v.id);
              if (r?.path?.length) map.fit(r.path, { padding: 110 });
              else if (v.lon != null) map.setView(v.lon, v.lat, 14);
              emit(EV.VIEW_CHANGED, 'map');
            },
          }),
          el('button.btn.btn--sm', {
            type: 'button', text: v.available ? 'Take off road' : 'Return to service',
            onclick: () => {
              store.updateVehicle(v.id, { available: !v.available, status: v.available ? 'disabled' : 'idle' });
              announce(`${v.callsign} ${v.available ? 'returned to service' : 'taken off road'}`);
              render();
            },
          }),
          el('button.btn.btn--sm', {
            type: 'button', text: 'Edit',
            onclick: () => { editing = v.id; formOpen = true; render(); },
          }),
          confirmButton('Remove', 'Confirm?', () => { store.removeVehicle(v.id); render(); })),
      },
    ], {
      caption: 'Fleet register',
      onRowClick: (v) => store.select('vehicle', v.id, { force: true }),
      selectedId: store.selection.kind === 'vehicle' ? store.selection.id : null,
    });
  }

  function formCard() {
    const existing = editing ? store.vehiclesById.get(editing) : null;
    const typeOptions = Object.values(VEHICLE_TYPES).map((t) => ({
      value: t.key,
      label: `${t.label} — ${num(t.capacityKg)} kg, ${t.rangeKm} km, ${t.consumption} ${t.unit}`,
    }));
    const type = selectInput(typeOptions, { value: existing?.type || 'diesel_van' });
    const callsign = textInput({ value: existing?.callsign || '', placeholder: 'Auto-generated if blank' });
    const reg = textInput({ value: existing?.registration || '', placeholder: 'Registration' });
    const driver = textInput({ value: existing?.driver || '', placeholder: 'Driver name' });
    const depot = selectInput(store.depots.map((d) => ({ value: d.id, label: d.name })), {
      value: existing?.depotId || store.depots[0]?.id,
    });
    const energy = numberInput({ value: Math.round((existing?.energyLevel ?? 0.9) * 100), min: 5, max: 100, suffix: '%' });

    const specNote = el('p.basis');
    const updateNote = () => {
      const t = VEHICLE_TYPES[type.value];
      specNote.textContent = `${t.label}: ${num(t.capacityKg)} kg payload, ${t.rangeKm} km usable range, `
        + `${t.consumption} ${t.unit} at reference load, ${t.costPerKm} per km running cost plus energy. `
        + `Carrier: ${({ diesel: 'diesel', cng: 'CNG', bev: 'grid electricity' })[t.energyType]}.`;
    };
    type.addEventListener('change', updateNote);
    updateNote();

    const save = () => {
      const patch = {
        type: type.value,
        callsign: callsign.value.trim() || undefined,
        registration: reg.value.trim(),
        driver: driver.value.trim() || 'Unassigned',
        depotId: depot.value,
        energyLevel: Math.min(1, Math.max(0.05, (Number(energy.input.value) || 90) / 100)),
      };
      if (existing) { store.updateVehicle(existing.id, patch); announce('Vehicle updated'); }
      else { store.addVehicle(patch); announce('Vehicle added'); }
      formOpen = false; editing = null;
      render();
    };

    return card(existing ? `Edit ${existing.callsign}` : 'New vehicle', null,
      el('div.form-grid', null,
        field('Vehicle type', type, { required: true }),
        specNote,
        fieldRow(field('Callsign', callsign), field('Registration', reg)),
        fieldRow(field('Driver', driver), field('Home depot', depot)),
        field('Fuel / charge now', energy, { hint: 'The optimiser will not plan a route that would finish below a 10% reserve.' })),
      el('div.form-actions', null,
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => { formOpen = false; editing = null; render(); } }),
        el('button.btn.btn--primary', { type: 'button', text: existing ? 'Save changes' : 'Add vehicle', onclick: save })));
  }

  const statusTone = (v) => {
    if (!v.available) return 'red';
    return ({
      moving: 'cyan', delivering: 'green', returning: 'violet',
      delayed: 'orange', charging: 'amber',
    })[v.status] || '';
  };

  on(EV.ENTITIES_CHANGED, render);
  on(EV.PLAN_CHANGED, render);
  on(EV.SELECT, render);
  on(EV.FLEET_TICK, throttle(render, 1500));
  render();
  return root;
}
