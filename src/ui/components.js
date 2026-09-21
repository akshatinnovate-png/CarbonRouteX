/**
 * SHARED UI COMPONENTS
 *
 * Form controls, tables, cards and the location picker that every entity page
 * builds on. Keeping these here is what stops the Fleet, Orders and Depots
 * pages drifting into three different-looking forms.
 */

import { EV, emit } from '../core/bus.js';
import { el, mount, debounce, announce, isTypingTarget, setText } from '../util/dom.js';
import { clock, num, isoDate } from '../util/format.js';
import { icon } from './icons.js';

/* ------------------------------------------------------------------ */
/* Layout primitives                                                   */
/* ------------------------------------------------------------------ */

export const page = (title, subtitle, ...body) => el('div.page', null,
  el('header.page-head', null,
    el('div', null,
      el('h1.page-title', { text: title }),
      subtitle ? el('p.page-sub', { text: subtitle }) : null)),
  el('div.page-body', null, ...body));

export const pageWithActions = (title, subtitle, actions, ...body) => el('div.page', null,
  el('header.page-head', null,
    el('div', null,
      el('h1.page-title', { text: title }),
      subtitle ? el('p.page-sub', { text: subtitle }) : null),
    el('div.page-actions', null, ...(actions || []))),
  el('div.page-body', null, ...body));

export const card = (title, extra, ...body) => el('section.panel', null,
  title ? el('div.panel-head', null,
    el('h3', { text: title }), el('span.spacer'), extra || null) : null,
  el('div.panel-body', null, ...body));

export const kv = (k, v, color) => [el('dt', { text: k }), el('dd', { text: v, style: color ? { color } : null })];

export const empty = (message, hint, action) => el('div.empty-state', null,
  el('span', { html: icon('info', 26) }),
  el('p', { text: message }),
  hint ? el('span.hint', { text: hint }) : null,
  action || null);

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

let fieldSeq = 0;

export function field(label, control, { hint = null, required = false } = {}) {
  const id = control.id || `f${++fieldSeq}`;
  control.id = id;
  if (required) control.required = true;
  return el('div.field', null,
    el('label.field-label', { for: id }, label, required ? el('span.req', { text: '*' }) : null),
    control,
    hint ? el('span.field-hint', { text: hint }) : null);
}

export function textInput({ value = '', placeholder = '', type = 'text', ...rest } = {}) {
  return el('input.input', { type, value, placeholder, autocomplete: 'off', ...rest });
}

export function numberInput({ value = 0, min, max, step = 1, suffix, ...rest } = {}) {
  const input = el('input.input.input--num', {
    type: 'number', value: String(value), step: String(step),
    ...(min != null ? { min: String(min) } : {}),
    ...(max != null ? { max: String(max) } : {}),
    ...rest,
  });
  // Callers always read `.input`, whether or not a suffix wrapped the field.
  // Without this the bare-input case silently has no `.input` and the caller
  // throws at the moment it tries to read the value back.
  input.input = input;
  if (!suffix) return input;
  const wrap = el('div.input-suffix', null, input, el('span.suffix', { text: suffix }));
  // The caller wires up `wrap.input`, so the suffix is purely presentational.
  wrap.input = input;
  return wrap;
}

export function selectInput(options, { value, ...rest } = {}) {
  return el('select.input', rest, ...options.map((o) => el('option', {
    value: o.value, selected: o.value === value, text: o.label,
  })));
}

/** A 24-hour time control that stores minutes-since-midnight. */
export function timeInput({ minutes = 8 * 60, ...rest } = {}) {
  const input = el('input.input', {
    type: 'time',
    value: `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.round(minutes) % 60).padStart(2, '0')}`,
    ...rest,
  });
  input.getMinutes = () => {
    const [h, m] = (input.value || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  return input;
}

/**
 * A date and a time, stored as minutes from the start of the plan.
 *
 * A bare time control cannot express "Thursday afternoon", which is exactly
 * what a long-haul deadline is: Ranchi to Delhi is not a today problem. The
 * date half maps onto day offsets from the plan's first day, so the engine
 * keeps working in plain minutes and only the operator deals in dates.
 *
 * Returns a node with `.getMinutes()`.
 */
export function dateTimeInput({ minutes = 8 * 60, planStart, max = 30, ...rest } = {}) {
  const start = planStart ? new Date(`${planStart}T00:00:00`) : new Date();
  start.setHours(0, 0, 0, 0);

  const dayOffset = Math.max(0, Math.floor(minutes / 1440));
  const atDay = new Date(start);
  atDay.setDate(atDay.getDate() + dayOffset);

  const date = el('input.input.input--date', {
    type: 'date',
    value: isoDate(atDay),
    min: isoDate(start),
    ...rest,
  });
  const time = el('input.input.input--time', {
    type: 'time',
    value: `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`,
  });

  const dayNote = el('span.field-hint.day-note');
  const refresh = () => {
    const d = dayIndex();
    setText(dayNote, d === 0 ? 'Day 1 — the first day of the plan' : `Day ${d + 1} of the plan`);
  };

  function dayIndex() {
    if (!date.value) return 0;
    const picked = new Date(`${date.value}T00:00:00`);
    const diff = Math.round((picked - start) / 86400000);
    return Math.max(0, Math.min(max, diff));
  }

  date.addEventListener('change', refresh);
  refresh();

  const node = el('div.datetime', null, el('div.row', null, date, time), dayNote);
  node.getMinutes = () => {
    const [h, m] = (time.value || '00:00').split(':').map(Number);
    return dayIndex() * 1440 + (h || 0) * 60 + (m || 0);
  };
  return node;
}

export const fieldRow = (...fields) => el('div.field-row', null, ...fields);

/**
 * Wrap a page re-render so that background events never interrupt data entry.
 *
 * Pages rebuild themselves wholesale, which is simple and fast and completely
 * unacceptable while somebody is halfway through typing an address into one of
 * them. A table that is two seconds stale is a non-event; a form that empties
 * itself mid-sentence ends the task.
 *
 * Use this for anything driven by the clock, the optimiser or another page.
 * Direct responses to the operator's own action should call `render` itself —
 * they are the reason the view needs to change.
 *
 * @param {HTMLElement} root   the page root, to scope the focus test
 * @param {Function} render    the page's normal render
 * @param {Function} [isBusy]  extra "do not disturb" test, e.g. () => formOpen
 */
export function deferWhileEditing(root, render, isBusy = () => false) {
  return (...args) => {
    if (isBusy()) return;
    const active = document.activeElement;
    if (active && root.contains(active) && isTypingTarget(active)) return;
    return render(...args);
  };
}

/* ------------------------------------------------------------------ */
/* Location picker                                                     */
/* ------------------------------------------------------------------ */

/**
 * Address search backed by real OpenStreetMap geocoding, with "pick on map" as
 * the fallback for anywhere without a searchable address — a warehouse gate, a
 * building entrance, a site with no postal address at all.
 *
 * Returns a node with `.getValue()` -> { lon, lat, label, short } | null.
 */
export function locationPicker(store, { value = null, placeholder = 'Search an address or place…', onPick = null } = {}) {
  let picked = value;

  const input = textInput({ placeholder, type: 'search' });
  const results = el('div.lookup-results', { hidden: true });
  const chosen = el('div.lookup-chosen', { hidden: !picked });
  const status = el('span.field-hint');

  const renderChosen = () => {
    chosen.hidden = !picked;
    if (!picked) return;
    mount(chosen,
      el('span', { html: icon('target', 13) }),
      el('span.lookup-chosen-text', null,
        el('strong', { text: picked.short || picked.label }),
        el('small', { text: `${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)}` })),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button', 'aria-label': 'Clear the selected location', html: icon('close', 11),
        onclick: () => { picked = null; renderChosen(); input.value = ''; },
      }));
  };

  const runSearch = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) { results.hidden = true; mount(results); return; }
    status.textContent = 'Searching…';
    const near = store.workspace.region || null;
    const hits = await store.geocode.search(q, { near });
    status.textContent = '';
    if (!hits.length) {
      results.hidden = false;
      mount(results, el('div.lookup-empty', {
        text: store.serviceStatus.geocoding === 'down'
          ? 'The address service is unreachable. Use “Pick on map” instead.'
          : `No match for “${q}”. Try a broader search, or pick the point on the map.`,
      }));
      return;
    }
    results.hidden = false;
    mount(results, hits.map((h) => el('button.lookup-item', {
      type: 'button',
      onclick: () => {
        picked = h;
        input.value = '';
        results.hidden = true;
        renderChosen();
        onPick?.(h);
      },
    },
    el('span.lookup-title', { text: h.short }),
    el('span.lookup-sub', { text: h.label }))));
    announce(`${hits.length} location${hits.length === 1 ? '' : 's'} found`);
  }, 420);

  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { results.hidden = true; input.value = ''; }
    if (e.key === 'Enter') e.preventDefault();
  });

  const pickBtn = el('button.btn.btn--sm', {
    type: 'button',
    html: `${icon('target', 12)}<span>Pick on map</span>`,
    onclick: () => {
      emit(EV.PICK_MODE, {
        active: true,
        onPick: async ({ lon, lat }) => {
          status.textContent = 'Looking up that address…';
          const place = await store.geocode.reverse(lon, lat);
          picked = place;
          status.textContent = place.unresolved ? 'No street address found — the coordinate will be used.' : '';
          renderChosen();
          onPick?.(place);
        },
      });
    },
  });

  const node = el('div.lookup', null,
    el('div.lookup-row', null, input, pickBtn),
    results, chosen, status);
  node.getValue = () => picked;
  node.setValue = (v) => { picked = v; renderChosen(); };
  renderChosen();
  return node;
}

/* ------------------------------------------------------------------ */
/* Data table                                                          */
/* ------------------------------------------------------------------ */

/**
 * Sortable, keyboard-navigable table.
 * @param columns [{ key, label, get, cmp, right, name, render }]
 */
export function dataTable(rows, columns, {
  onRowClick = null, selectedId = null, emptyMessage = 'Nothing here yet.', caption = '',
  sortKey = null, sortDir = 1, onSort = null,
} = {}) {
  if (!rows.length) return empty(emptyMessage);

  const head = el('tr', null, ...columns.map((c) => el('th', {
    class: c.right ? 'r' : '',
    scope: 'col',
    'aria-sort': sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none',
  }, c.cmp && onSort
    ? el('button.th-sort', {
      type: 'button',
      text: c.label + (sortKey === c.key ? (sortDir === 1 ? ' ↑' : ' ↓') : ''),
      onclick: () => onSort(c.key),
    })
    : c.label)));

  const body = el('tbody', null, ...rows.map((row) => {
    const tr = el('tr', {
      tabindex: onRowClick ? '0' : null,
      'aria-selected': selectedId != null ? String(row.id === selectedId) : null,
      style: onRowClick ? { cursor: 'pointer' } : null,
    }, ...columns.map((c) => {
      const content = c.render ? c.render(row) : c.get(row);
      return el('td', {
        class: `${c.right ? 'r' : ''} ${c.name ? 'name' : ''}`.trim(),
      }, typeof content === 'string' || typeof content === 'number' ? String(content) : content);
    }));
    if (onRowClick) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select')) return;
        onRowClick(row);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
      });
    }
    return tr;
  }));

  return el('div.table-wrap', null,
    el('table.tbl', null,
      caption ? el('caption.sr-only', { text: caption }) : null,
      el('thead', null, head),
      body));
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export const chip = (text, tone = '') => el('span.chip', { class: tone ? `chip--${tone}` : '' }, el('i.dot'), text);

export const statTile = (label, value, { sub = null, tone = '' } = {}) => el('div.stat-tile', { dataset: { tone } },
  el('span.stat-value.num', null, value, sub ? el('small', { text: sub }) : null),
  el('span.stat-label', { text: label }));

export function confirmButton(label, message, onConfirm, { tone = 'danger' } = {}) {
  let armed = false;
  let timer = 0;
  const btn = el('button.btn.btn--sm', {
    class: `btn--${tone}`, type: 'button', text: label,
    onclick: () => {
      if (!armed) {
        armed = true;
        btn.textContent = message;
        // Disarm on its own so a stray click later cannot destroy anything.
        timer = setTimeout(() => { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      btn.textContent = label;
      onConfirm();
    },
  });
  return btn;
}

export const windowLabel = (o) => `${clock(o.windowOpen)}–${clock(o.deadline)}`;
export const weightLabel = (kg) => `${num(kg)} kg`;
