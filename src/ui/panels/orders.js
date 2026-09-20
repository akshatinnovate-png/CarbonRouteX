/**
 * ORDER BOOK — the non-map view of the network.
 *
 * Accessibility requirement, not an afterthought: every geospatial fact the map
 * conveys (what is where, who is carrying it, when it arrives, how far, how
 * much carbon) is available here as sortable, keyboard-navigable text. The map
 * is a faster way to understand the network, never the only way.
 */

import { PRIORITY } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, throttle } from '../../util/dom.js';
import { clock, dur, km as fkm, num, pct, geo } from '../../util/format.js';
import { panel, empty } from './analytics.js';

const COLUMNS = [
  { key: 'id', label: 'Order', get: (o) => o.id, cmp: (a, b) => a.id.localeCompare(b.id) },
  { key: 'consignee', label: 'Consignee', get: (o) => o.consignee, cmp: (a, b) => a.consignee.localeCompare(b.consignee), name: true },
  { key: 'district', label: 'District', get: (o) => o.district, cmp: (a, b) => a.district.localeCompare(b.district), name: true },
  { key: 'priority', label: 'Priority', get: (o) => PRIORITY[o.priority].label, cmp: (a, b) => PRIORITY[b.priority].weight - PRIORITY[a.priority].weight },
  { key: 'weightKg', label: 'Weight', get: (o) => `${num(o.weightKg)} kg`, cmp: (a, b) => b.weightKg - a.weightKg, right: true },
  { key: 'deadline', label: 'Deadline', get: (o) => clock(o.deadline), cmp: (a, b) => a.deadline - b.deadline, right: true },
  { key: 'eta', label: 'ETA', get: (o) => (o.etaMinutes != null ? clock(o.etaMinutes) : '—'), cmp: (a, b) => (a.etaMinutes ?? 1e9) - (b.etaMinutes ?? 1e9), right: true },
  { key: 'slack', label: 'Slack', get: (o) => (o.etaMinutes != null ? dur(o.deadline - o.etaMinutes) : '—'), cmp: (a, b) => (a.deadline - (a.etaMinutes ?? 0)) - (b.deadline - (b.etaMinutes ?? 0)), right: true },
  { key: 'vehicle', label: 'Vehicle', get: (o, s) => (o.assignedVehicle ? s.vehiclesById.get(o.assignedVehicle)?.callsign ?? o.assignedVehicle : 'Unassigned'), cmp: (a, b) => String(a.assignedVehicle).localeCompare(String(b.assignedVehicle)) },
  { key: 'status', label: 'Status', get: (o) => o.status, cmp: (a, b) => a.status.localeCompare(b.status) },
  { key: 'where', label: 'Location', get: (o) => geo(o.x, o.y), cmp: (a, b) => a.x - b.x },
];

export function ordersPanel(store) {
  const root = el('div.stack');
  let sortKey = 'deadline';
  let sortDir = 1;
  let statusFilter = 'all';

  const render = raf1(() => {
    const col = COLUMNS.find((c) => c.key === sortKey) || COLUMNS[5];
    let rows = store.orders.slice();
    if (statusFilter !== 'all') rows = rows.filter((o) => o.status === statusFilter);
    rows.sort((a, b) => col.cmp(a, b) * sortDir);

    const statuses = ['all', ...new Set(store.orders.map((o) => o.status))];
    const summary = summarise(store);

    const filterBar = el('div.segmented', { role: 'group', 'aria-label': 'Filter by status' },
      ...statuses.map((s) => el('button', {
        type: 'button', text: s === 'all' ? 'All' : s,
        'aria-pressed': String(statusFilter === s),
        onclick: () => { statusFilter = s; render(); },
      })));

    const headCell = (c) => el('th', {
      class: c.right ? 'r' : '',
      scope: 'col',
      'aria-sort': sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none',
    }, el('button', {
      type: 'button',
      style: { color: 'inherit', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' },
      text: c.label + (sortKey === c.key ? (sortDir === 1 ? ' ↑' : ' ↓') : ''),
      onclick: () => {
        if (sortKey === c.key) sortDir = -sortDir;
        else { sortKey = c.key; sortDir = 1; }
        render();
      },
    }));

    const bodyCell = (c, o) => el('td', {
      class: `${c.right ? 'r' : ''} ${c.name ? 'name' : ''}`.trim(),
      text: c.get(o, store),
      style: c.key === 'status' && o.status === 'unserved' ? { color: 'var(--red)' }
        : c.key === 'priority' ? { color: PRIORITY[o.priority].color } : null,
    });

    const bodyRow = (o) => el('tr', {
      tabindex: '0',
      'aria-selected': String(store.selection.kind === 'order' && store.selection.id === o.id),
      style: { cursor: 'pointer' },
      onclick: () => selectOrder(o),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectOrder(o); }
      },
    }, ...COLUMNS.map((c) => bodyCell(c, o)));

    const table = el('table.tbl', null,
      el('caption.sr-only', { text: `Order book, ${rows.length} rows, sorted by ${col.label}` }),
      el('thead', null, el('tr', null, ...COLUMNS.map(headCell))),
      el('tbody', null, ...rows.map(bodyRow)));

    mount(root, panel('Order book — text equivalent of the map', filterBar,
      el('div.stack-sm', null,
        el('dl.kv', { style: { gridTemplateColumns: 'repeat(4, auto 1fr)' } }, ...summary),
        el('div', { style: { overflow: 'auto', maxHeight: '340px' } }, table),
        rows.length ? null : empty('No orders match this filter.'),
        el('p.basis', {
          text: 'Column headers sort. Rows are focusable and open the same inspector the map does. Coordinates are synthetic, derived from the demo world’s local metric plane.',
        }))));
  });

  function selectOrder(o) {
    store.select('order', o.id, { force: true });
    emit(EV.FOCUS_MAP, { x: o.x, y: o.y, zoom: 3.4 });
  }

  function summarise(store) {
    const total = store.orders.length;
    const delivered = store.orders.filter((o) => o.status === 'delivered').length;
    const unserved = store.orders.filter((o) => o.status === 'unserved').length;
    const late = store.orders.filter((o) => o.plannedLate > 0).length;
    const weight = store.orders.reduce((a, o) => a + o.weightKg, 0);
    const pair = (k, v, color) => [el('dt', { text: k }), el('dd', { text: v, style: color ? { color } : null })];
    return [
      ...pair('Orders', num(total)),
      ...pair('Delivered', num(delivered), 'var(--green)'),
      ...pair('Unserved', num(unserved), unserved ? 'var(--red)' : undefined),
      ...pair('At risk', num(late), late ? 'var(--amber)' : undefined),
      ...pair('Total weight', `${num(weight)} kg`),
      ...pair('Fleet distance', fkm(store.plan?.metrics.km ?? 0, 0)),
      ...pair('On-time rate', pct(store.plan?.metrics.onTimeRate ?? 1, 1)),
      ...pair('Clock', clock(store.clockMinutes)),
    ];
  }

  on(EV.PLAN_CHANGED, render);
  on(EV.ORDERS_CHANGED, render);
  on(EV.SELECT, render);
  on(EV.FLEET_TICK, throttle(render, 2000));
  render();
  return root;
}
