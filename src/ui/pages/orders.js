/**
 * ORDERS PAGE — the delivery book.
 *
 * Also the accessible, non-map view of the network: every geospatial fact the
 * map conveys is available here as sortable, keyboard-navigable text.
 */

import { PRIORITY, SIM } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, throttle, announce, debounce } from '../../util/dom.js';
import { clock, dur, num, stamp, dayOf } from '../../util/format.js';
import { icon } from '../icons.js';
import {
  pageWithActions, card, dataTable, empty, field, fieldRow, textInput,
  numberInput, selectInput, timeInput, dateTimeInput, locationPicker, confirmButton, statTile, chip,
  deferWhileEditing,
} from '../components.js';

export function ordersPage(store, map) {
  const root = el('div.page-root');
  let editing = null;
  let formOpen = false;
  let statusFilter = 'all';
  let query = '';
  let sortKey = 'deadline';
  let sortDir = 1;

  const COLUMNS = [
    { key: 'ref', label: 'Ref', name: true, get: (o) => o.ref, cmp: (a, b) => a.ref.localeCompare(b.ref) },
    { key: 'consignee', label: 'Consignee', name: true, get: (o) => o.consignee, cmp: (a, b) => a.consignee.localeCompare(b.consignee) },
    { key: 'address', label: 'Address', name: true, get: (o) => o.short, cmp: (a, b) => a.short.localeCompare(b.short) },
    {
      key: 'priority', label: 'Priority',
      render: (o) => chip(PRIORITY[o.priority].label, priorityTone(o.priority)),
      cmp: (a, b) => PRIORITY[b.priority].weight - PRIORITY[a.priority].weight,
    },
    { key: 'weight', label: 'Weight', right: true, get: (o) => `${num(o.weightKg)} kg`, cmp: (a, b) => b.weightKg - a.weightKg },
    { key: 'window', label: 'Window', right: true, get: (o) => `${stamp(o.windowOpen)}–${stamp(o.deadline)}`, cmp: (a, b) => a.deadline - b.deadline },
    { key: 'deadline', label: 'Due', right: true, get: (o) => stamp(o.deadline), cmp: (a, b) => a.deadline - b.deadline },
    {
      key: 'eta', label: 'ETA', right: true,
      get: (o) => (o.etaMinutes != null ? stamp(o.etaMinutes) : '—'),
      cmp: (a, b) => (a.etaMinutes ?? 1e9) - (b.etaMinutes ?? 1e9),
    },
    {
      key: 'slack', label: 'Slack', right: true,
      render: (o) => {
        if (o.etaMinutes == null) return '—';
        const slack = o.deadline - o.etaMinutes;
        return el('span', { style: { color: slack < 0 ? 'var(--danger)' : slack < 30 ? 'var(--gold-deep)' : undefined } },
          dur(slack));
      },
      cmp: (a, b) => (a.deadline - (a.etaMinutes ?? 0)) - (b.deadline - (b.etaMinutes ?? 0)),
    },
    {
      key: 'vehicle', label: 'Vehicle', name: true,
      get: (o) => (o.assignedVehicle ? store.vehiclesById.get(o.assignedVehicle)?.callsign ?? '—' : 'Unassigned'),
      cmp: (a, b) => String(a.assignedVehicle).localeCompare(String(b.assignedVehicle)),
    },
    {
      key: 'status', label: 'Status',
      render: (o) => chip(o.status, o.status === 'delivered' ? 'green' : o.status === 'unserved' ? 'red' : o.status === 'enroute' ? 'cyan' : ''),
      cmp: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'actions', label: '', right: true,
      render: (o) => el('div.row-actions', null,
        el('button.btn.btn--ghost.btn--sm', {
          type: 'button', title: 'Show on the map', html: icon('target', 12),
          onclick: () => {
            store.select('order', o.id, { force: true });
            map.setView(o.lon, o.lat, 15);
            emit(EV.VIEW_CHANGED, 'map');
          },
        }),
        el('button.btn.btn--sm', { type: 'button', text: 'Edit', onclick: () => { editing = o.id; formOpen = true; render(); } }),
        confirmButton('Remove', 'Confirm?', () => { store.removeOrder(o.id); render(); })),
    },
  ];

  const render = raf1(() => {
    const all = store.orders;
    let rows = all;
    if (statusFilter !== 'all') rows = rows.filter((o) => o.status === statusFilter);
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((o) => o.ref.toLowerCase().includes(q)
        || o.consignee.toLowerCase().includes(q)
        || o.short.toLowerCase().includes(q)
        || (o.goods || '').toLowerCase().includes(q));
    }
    const col = COLUMNS.find((c) => c.key === sortKey);
    if (col?.cmp) rows = [...rows].sort((a, b) => col.cmp(a, b) * sortDir);

    const statuses = ['all', ...new Set(all.map((o) => o.status))];
    const search = textInput({
      type: 'search', value: query, placeholder: 'Search reference, consignee, address…',
      oninput: debounce((e) => { query = e.target.value; render(); }, 200),
    });

    mount(root, pageWithActions(
      'Orders',
      'The delivery book. This table is also the complete text equivalent of the map.',
      [
        el('button.btn.btn--primary', {
          type: 'button', html: `${icon('plus', 13)}<span>Add delivery</span>`,
          onclick: () => { editing = null; formOpen = true; render(); },
        }),
      ],
      el('div.stack', null,
        el('div.tile-row', null,
          statTile('Orders', num(all.length)),
          statTile('Delivered', num(all.filter((o) => o.status === 'delivered').length), { tone: 'green' }),
          statTile('Unserved', num(all.filter((o) => o.status === 'unserved').length),
            { tone: all.some((o) => o.status === 'unserved') ? 'red' : '' }),
          statTile('At risk', num(all.filter((o) => o.plannedLate > 0).length),
            { tone: all.some((o) => o.plannedLate > 0) ? 'amber' : '' }),
          statTile('Total load', num(all.reduce((a, o) => a + o.weightKg, 0)), { sub: 'kg' }),
          statTile('Plan spans', num(all.length ? Math.max(...all.map((o) => dayOf(o.deadline))) : 1),
            { sub: 'days', tone: all.some((o) => dayOf(o.deadline) > 1) ? 'gold' : '' })),
        formOpen ? formCard() : null,
        card('Delivery book',
          el('div.row', null,
            el('div.segmented', { role: 'group', 'aria-label': 'Filter by status' },
              ...statuses.map((s) => el('button', {
                type: 'button', text: s === 'all' ? 'All' : s,
                'aria-pressed': String(statusFilter === s),
                onclick: () => { statusFilter = s; render(); },
              }))),
            search),
          rows.length
            ? dataTable(rows, COLUMNS, {
              caption: `Orders, ${rows.length} rows sorted by ${col?.label ?? sortKey}`,
              sortKey, sortDir,
              onSort: (key) => {
                if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
                render();
              },
              onRowClick: (o) => store.select('order', o.id, { force: true }),
              selectedId: store.selection.kind === 'order' ? store.selection.id : null,
            })
            : empty(all.length ? 'No orders match this filter.' : 'No deliveries yet.',
              all.length ? null : 'Add one to start planning.')),
        el('p.basis', {
          text: 'Column headers sort. Rows are focusable and open the same inspector the map does.',
        }))));
  });

  function formCard() {
    const existing = editing ? store.ordersById.get(editing) : null;
    const consignee = textInput({ value: existing?.consignee || '', placeholder: 'Customer or site name' });
    const picker = locationPicker(store, {
      value: existing ? { lon: existing.lon, lat: existing.lat, label: existing.label, short: existing.short } : null,
      placeholder: 'Search the delivery address…',
    });
    const weight = numberInput({ value: existing?.weightKg ?? 120, min: 1, max: 40000, suffix: 'kg' });
    const priority = selectInput(
      Object.values(PRIORITY).map((p) => ({ value: p.key, label: p.label })),
      { value: existing?.priority || 'standard' },
    );
    const from = dateTimeInput({
      minutes: existing?.windowOpen ?? SIM.dayStartMinutes, planStart: store.planStart,
    });
    const to = dateTimeInput({
      minutes: existing?.deadline ?? SIM.dayEndMinutes, planStart: store.planStart,
    });
    const service = numberInput({ value: existing?.serviceMinutes ?? 6, min: 0, max: 240, suffix: 'min' });
    const goods = textInput({ value: existing?.goods || '', placeholder: 'Goods description' });
    const notes = textInput({ value: existing?.notes || '', placeholder: 'Delivery notes' });

    const save = () => {
      const loc = picker.getValue();
      if (!loc) { emit(EV.TOAST, { message: 'Choose the delivery location first.', tone: 'bad' }); return; }
      if (to.getMinutes() <= from.getMinutes()) {
        emit(EV.TOAST, { message: 'The deadline must be after the window opens.', tone: 'bad' });
        return;
      }
      const patch = {
        consignee: consignee.value.trim() || 'Consignee',
        lon: loc.lon, lat: loc.lat, label: loc.label, short: loc.short,
        weightKg: Number(weight.input.value) || 1,
        priority: priority.value,
        windowOpen: from.getMinutes(),
        deadline: to.getMinutes(),
        serviceMinutes: Number(service.input.value) || 0,
        goods: goods.value.trim(),
        notes: notes.value.trim(),
      };
      if (existing) { store.updateOrder(existing.id, patch); announce('Order updated'); }
      else { store.addOrder(patch); announce('Order added'); }
      formOpen = false; editing = null;
      render();
    };

    return card(existing ? `Edit ${existing.ref}` : 'New delivery', null,
      el('div.form-grid', null,
        fieldRow(field('Consignee', consignee), field('Goods', goods)),
        field('Delivery address', picker, { required: true }),
        fieldRow(field('Weight', weight), field('Priority', priority), field('Service time', service)),
        fieldRow(
          field('Window opens', from, { hint: 'Nothing can be delivered before this.' }),
          field('Deadline', to, { hint: 'Pick a later date for long-haul freight — this is not limited to today.' })),
        field('Notes', notes)),
      el('div.form-actions', null,
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => { formOpen = false; editing = null; render(); } }),
        el('button.btn.btn--primary', { type: 'button', text: existing ? 'Save changes' : 'Add delivery', onclick: save })));
  }

  const priorityTone = (p) => ({ critical: 'red', high: 'orange', standard: 'cyan', economy: '' }[p] || '');

  // Anything the operator did not just do themselves has to wait until they
  // are not typing into this page.
  const background = deferWhileEditing(root, render, () => formOpen);
  on(EV.ENTITIES_CHANGED, background);
  on(EV.PLAN_CHANGED, background);
  on(EV.SELECT, background);
  on(EV.FLEET_TICK, throttle(background, 2500));
  render();
  return root;
}
