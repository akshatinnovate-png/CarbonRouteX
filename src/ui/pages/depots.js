/**
 * DEPOTS PAGE — add, edit and remove the sites routes start and end from.
 */

import { SIM } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { clock, num, kg as fkg, km as fkm } from '../../util/format.js';
import { icon } from '../icons.js';
import {
  pageWithActions, card, dataTable, empty, field, fieldRow, textInput,
  numberInput, timeInput, locationPicker, confirmButton, statTile,
  deferWhileEditing,
} from '../components.js';

export function depotsPage(store, map) {
  const root = el('div.page-root');
  let editing = null;   // depot id being edited, or null for the add form
  let formOpen = false;

  const render = raf1(() => {
    const depots = store.depots;
    mount(root, pageWithActions(
      'Depots',
      'Every route begins and ends at a depot. Vehicles are based at one.',
      [
        el('button.btn.btn--primary', {
          type: 'button', html: `${icon('plus', 13)}<span>Add depot</span>`,
          onclick: () => { editing = null; formOpen = true; render(); },
        }),
      ],
      el('div.stack', null,
        el('div.tile-row', null,
          statTile('Depots', num(depots.length)),
          statTile('Vehicles based', num(store.vehicles.filter((v) => v.depotId).length)),
          statTile('Unassigned vehicles', num(store.vehicles.filter((v) => !v.depotId).length),
            { tone: store.vehicles.some((v) => !v.depotId) ? 'red' : '' })),
        formOpen ? formCard() : null,
        card('All depots', null, depots.length ? table() : empty(
          'No depots yet.',
          'Add one to start planning. You can search an address or drop a pin on the map.',
          el('button.btn.btn--primary', {
            type: 'button', text: 'Add your first depot',
            onclick: () => { editing = null; formOpen = true; render(); },
          }),
        )))));
  });

  function table() {
    return dataTable(store.depots, [
      { key: 'name', label: 'Name', name: true, get: (d) => d.name },
      { key: 'address', label: 'Address', name: true, get: (d) => d.short },
      { key: 'docks', label: 'Docks', right: true, get: (d) => num(d.dockCount) },
      { key: 'hours', label: 'Hours', right: true, get: (d) => `${clock(d.openMinutes)}–${clock(d.closeMinutes)}` },
      {
        key: 'fleet', label: 'Vehicles', right: true,
        get: (d) => num(store.vehicles.filter((v) => v.depotId === d.id).length),
      },
      {
        key: 'co2', label: 'Planned CO₂e', right: true,
        get: (d) => {
          const rs = store.plan?.routes.filter((r) => r.depotId === d.id && r.orderIds.length) || [];
          return rs.length ? fkg(rs.reduce((a, r) => a + r.co2, 0), 1) : '—';
        },
      },
      {
        key: 'actions', label: '', right: true,
        render: (d) => el('div.row-actions', null,
          el('button.btn.btn--ghost.btn--sm', {
            type: 'button', title: 'Show on the map', html: icon('target', 12),
            onclick: () => { store.select('depot', d.id, { force: true }); map.setView(d.lon, d.lat, 14); emit(EV.VIEW_CHANGED, 'map'); },
          }),
          el('button.btn.btn--sm', {
            type: 'button', text: 'Edit',
            onclick: () => { editing = d.id; formOpen = true; render(); },
          }),
          confirmButton('Remove', 'Confirm?', () => {
            store.removeDepot(d.id);
            announce('Depot removed');
            render();
          })),
      },
    ], {
      caption: 'Depots',
      onRowClick: (d) => { store.select('depot', d.id, { force: true }); },
      selectedId: store.selection.kind === 'depot' ? store.selection.id : null,
    });
  }

  function formCard() {
    const existing = editing ? store.depotsById.get(editing) : null;
    const name = textInput({ value: existing?.name || '', placeholder: 'Northgate DC' });
    const picker = locationPicker(store, {
      value: existing ? { lon: existing.lon, lat: existing.lat, label: existing.label, short: existing.short } : null,
      placeholder: 'Search the depot address…',
    });
    const docks = numberInput({ value: existing?.dockCount ?? 4, min: 1, max: 60 });
    const opens = timeInput({ minutes: existing?.openMinutes ?? SIM.dayStartMinutes - 60 });
    const closes = timeInput({ minutes: existing?.closeMinutes ?? SIM.dayEndMinutes + 60 });

    const save = () => {
      const loc = picker.getValue();
      if (!loc) {
        emit(EV.TOAST, { message: 'Choose the depot location first.', tone: 'bad' });
        return;
      }
      if (closes.getMinutes() <= opens.getMinutes()) {
        emit(EV.TOAST, { message: 'Closing time must be after opening time.', tone: 'bad' });
        return;
      }
      const patch = {
        name: name.value.trim() || 'Depot',
        lon: loc.lon, lat: loc.lat, label: loc.label, short: loc.short,
        dockCount: Number(docks.input?.value ?? 4) || 4,
        openMinutes: opens.getMinutes(),
        closeMinutes: closes.getMinutes(),
      };
      if (existing) { store.updateDepot(existing.id, patch); announce('Depot updated'); }
      else { store.addDepot(patch); announce('Depot added'); }
      formOpen = false; editing = null;
      render();
    };

    return card(existing ? `Edit ${existing.name}` : 'New depot', null,
      el('div.form-grid', null,
        field('Depot name', name),
        field('Location', picker, { required: true, hint: 'Search an address, or press "Pick on map" and click the exact gate.' }),
        fieldRow(field('Loading docks', docks), field('Opens', opens), field('Closes', closes))),
      el('div.form-actions', null,
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => { formOpen = false; editing = null; render(); } }),
        el('button.btn.btn--primary', { type: 'button', text: existing ? 'Save changes' : 'Add depot', onclick: save })));
  }

  const background = deferWhileEditing(root, render, () => formOpen);
  on(EV.ENTITIES_CHANGED, (e) => { if (!e || e.kind === 'depot' || e.kind === 'import') background(); });
  on(EV.PLAN_CHANGED, background);
  render();
  return root;
}
