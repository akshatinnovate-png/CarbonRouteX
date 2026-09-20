/**
 * INSPECTOR (right rail)
 *
 * Fleet telemetry plus a context panel for whatever is selected. Selecting a
 * vehicle focuses the map, highlights its route, opens its telemetry and lists
 * its deliveries — all from the same store selection, so nothing can drift out
 * of sync with the map.
 */

import { VEHICLE_TYPES, PRIORITY, ENERGY } from '../config.js';
import { EV, emit, on } from '../core/bus.js';
import { el, mount, announce, raf1, throttle } from '../util/dom.js';
import { clock, dur, kg as fkg, km as fkm, money, num, pct, signed, geo } from '../util/format.js';
import { energyUnitLabel } from '../engines/energy.js';
import { intensityAt } from '../engines/emissions.js';
import { vehicleColor } from '../render/palette.js';
import { icon } from './icons.js';
import { gauge } from './charts.js';

const STATUS_CHIP = {
  moving: 'chip--cyan', delivering: 'chip--green', idle: '', returning: 'chip--violet',
  delayed: 'chip--orange', charging: 'chip--amber', disabled: 'chip--red', exception: 'chip--red',
};

export function initInspector(store, map) {
  const host = document.getElementById('inspector-scroll');

  const alertsPanel = el('section.panel', null,
    el('div.panel-head', null,
      el('h2', { text: 'Alert centre' }), el('span.spacer'),
      el('span.chip', { id: 'alert-count' }, el('i.dot'), '0')),
    el('div.panel-body.tight', null, el('div.alert-list', { id: 'alert-list' })));

  const detailHost = el('div', { id: 'detail-host' });

  const fleetPanel = el('section.panel', null,
    el('div.panel-head', null,
      el('h2', { text: 'Fleet telemetry' }), el('span.spacer'),
      el('span.eyebrow', { id: 'fleet-summary', text: '' })),
    el('div.panel-body.tight', null, el('div.fleet-list', { id: 'fleet-list' })));

  mount(host, alertsPanel, detailHost, fleetPanel);

  /* ---------------------------------------------------------------- */
  /* Alerts                                                            */
  /* ---------------------------------------------------------------- */

  const renderAlerts = raf1(() => {
    const list = document.getElementById('alert-list');
    const active = store.activeAlerts();
    const order = { high: 0, medium: 1, low: 2 };
    active.sort((a, b) => order[a.severity] - order[b.severity] || b.at - a.at);
    const count = document.getElementById('alert-count');
    mount(count, el('i.dot'), String(active.length));
    count.className = `chip ${active.some((a) => a.severity === 'high') ? 'chip--red' : active.length ? 'chip--amber' : 'chip--green'}`;

    if (!active.length) {
      mount(list, el('div.empty-state', { style: { padding: '18px 8px' } },
        el('span', { html: icon('check', 22) }),
        el('p', { text: 'No active alerts. Every route is feasible and every order is assigned.' })));
      return;
    }
    mount(list, active.slice(0, 12).map((a) => el('button.alert', {
      type: 'button', dataset: { sev: a.severity },
      onclick: () => {
        if (a.target) {
          store.select(a.target.kind, a.target.id, { force: true });
          focusTarget(a.target);
        }
      },
    },
    el('span.sev'),
    el('span', null,
      el('span.title', { text: a.title }),
      el('span.detail', { text: a.detail })),
    el('span.sev-tag', { text: a.severity }))));
  });

  function focusTarget(target) {
    if (target.kind === 'vehicle') {
      const v = store.vehiclesById.get(target.id);
      if (v) emit(EV.FOCUS_MAP, { x: v.x, y: v.y, zoom: 2.6 });
    } else if (target.kind === 'order') {
      const o = store.ordersById.get(target.id);
      if (o) emit(EV.FOCUS_MAP, { x: o.x, y: o.y, zoom: 3.2 });
    } else if (target.kind === 'route') {
      const r = store.routesById?.get(target.id);
      if (r?.polyline.length) emit(EV.FOCUS_MAP, { points: r.polyline });
    } else if (target.kind === 'edge') {
      const e = store.world.edges[target.id];
      if (e) emit(EV.FOCUS_MAP, { x: e.mid.x, y: e.mid.y, zoom: 3.2 });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Fleet list                                                        */
  /* ---------------------------------------------------------------- */

  const renderFleet = raf1(() => {
    const list = document.getElementById('fleet-list');
    const sel = store.selection;
    mount(document.getElementById('fleet-summary'),
      `${store.vehicles.filter((v) => v.available && v.routeId).length} active / ${store.vehicles.length}`);

    mount(list, store.vehicles.map((v, i) => {
      const type = VEHICLE_TYPES[v.type];
      const route = store.routeByVehicle?.get(v.id);
      const cap = route ? route.capacityPct : 0;
      const isSel = (sel.kind === 'vehicle' && sel.id === v.id)
        || (sel.kind === 'route' && store.routesById?.get(sel.id)?.vehicleId === v.id);
      return el('button.vcard', {
        type: 'button',
        'aria-current': String(isSel),
        style: { '--vc': v.available ? vehicleColor(i) : 'var(--red)' },
        'aria-label': `${v.callsign}, ${type.label}, ${v.status}, energy ${Math.round(v.energyLevel * 100)} percent, `
          + (route && route.orderIds.length ? `${route.orderIds.length} stops, ${Math.round(route.co2)} kilograms CO2 equivalent` : 'no assignment'),
        onclick: () => selectVehicle(v.id),
      },
      el('span.bar'),
      el('span.main', null,
        el('span.row1', null,
          el('span.cs', { text: v.callsign }),
          el('span.chip', { class: STATUS_CHIP[v.status] || '' }, el('i.dot'), v.status),
          el('span.type', { text: type.label })),
        el('span.row2', null,
          el('span', null, 'ENERGY ', el('b', { text: pct(v.energyLevel, 0) })),
          el('span', null, 'LOAD ', el('b', { text: pct(cap, 0) })),
          el('span', null, 'CO₂e ', el('b', { text: route ? num(route.co2, 1) : '0' }))),
        el('span.meter', { style: { '--meter-color': energyColor(v) } },
          el('i', { style: { width: `${Math.round(v.energyLevel * 100)}%` } }))),
      el('span.right', null,
        el('span.eta', null,
          route && route.orderIds.length ? clock(v.etaMinutes ?? route.endMinutes) : '—',
          el('small', { text: route && route.orderIds.length ? `${route.orderIds.length} STOPS` : 'IDLE' })),
        route && route.orderIds.length ? el('span.type', { text: route.id }) : null));
    }));
  });

  const energyColor = (v) => (v.energyLevel < 0.15 ? 'var(--red)' : v.energyLevel < 0.3 ? 'var(--amber)' : 'var(--green)');

  function selectVehicle(id) {
    store.select('vehicle', id, { force: true });
    const v = store.vehiclesById.get(id);
    const route = store.routeByVehicle?.get(id);
    if (route?.polyline.length) emit(EV.FOCUS_MAP, { points: route.polyline, padding: 130 });
    else if (v) emit(EV.FOCUS_MAP, { x: v.x, y: v.y, zoom: 2.6 });
    announce(`${v.callsign} selected. ${route && route.orderIds.length ? `${route.orderIds.length} stops, route ${route.id}.` : 'No assignment.'}`);
  }

  /* ---------------------------------------------------------------- */
  /* Detail panel                                                      */
  /* ---------------------------------------------------------------- */

  const renderDetail = raf1(() => {
    const sel = store.selection;
    if (!sel.kind) {
      mount(detailHost, el('section.panel', null,
        el('div.panel-head', null, el('h2', { text: 'Inspector' })),
        el('div.panel-body', null,
          el('div.empty-state', { style: { padding: '20px 8px' } },
            el('span', { html: icon('target', 24) }),
            el('p', { text: 'Select a vehicle, route or delivery — on the map or in the lists — to open its intelligence panel.' }),
            el('span.hint', { text: 'Tip: press / to search' })))));
      return;
    }
    if (sel.kind === 'vehicle') mount(detailHost, vehicleDetail(sel.id));
    else if (sel.kind === 'route') mount(detailHost, routeDetail(sel.id));
    else if (sel.kind === 'order') mount(detailHost, orderDetail(sel.id));
    else if (sel.kind === 'depot') mount(detailHost, depotDetail(sel.id));
    else if (sel.kind === 'district') mount(detailHost, districtDetail(sel.id));
    else mount(detailHost);
  });

  const kvRow = (k, v, color) => [el('dt', { text: k }), el('dd', { text: v, style: color ? { color } : null })];

  const detailHead = (title, subtitle, extra) => el('div.panel-head', null,
    el('h2', { text: title }),
    subtitle ? el('span.eyebrow', { text: subtitle, style: { marginLeft: '6px' } }) : null,
    el('span.spacer'),
    extra || null,
    el('button.btn.btn--ghost.btn--sm', {
      type: 'button', 'aria-label': 'Close inspector', html: icon('close', 12),
      onclick: () => store.clearSelection(),
    }));

  /* --- vehicle ----------------------------------------------------- */

  function vehicleDetail(id) {
    const v = store.vehiclesById.get(id);
    if (!v) return el('div');
    const type = VEHICLE_TYPES[v.type];
    const route = store.routeByVehicle?.get(v.id);
    const unit = energyUnitLabel(v.type);
    const gaugeCanvas = el('canvas', { 'aria-hidden': 'true' });
    requestAnimationFrame(() => gauge(gaugeCanvas, v.energyLevel, {
      color: v.energyLevel < 0.2 ? 'var(--red)' : '#3ee08f',
      label: pct(v.energyLevel, 0), caption: type.energyType === 'bev' ? 'charge' : 'fuel', size: 92,
    }));

    return el('section.panel', null,
      detailHead(v.callsign, type.label,
        el('span.chip', { class: STATUS_CHIP[v.status] || '' }, el('i.dot'), v.status)),
      el('div.panel-body', null,
        el('div.stack', null,
          el('div.row', { style: { gap: '14px', alignItems: 'center' } },
            gaugeCanvas,
            el('dl.kv', { style: { flex: '1' } },
              ...kvRow('Driver', v.driver),
              ...kvRow('Depot', store.depotsById.get(v.depotId)?.name ?? '—'),
              ...kvRow('Capacity', `${num(type.capacityKg)} kg`),
              ...kvRow('Range left', fkm(type.rangeKm * v.energyLevel, 0)),
              ...kvRow('Odometer', fkm(v.telemetry.odometerKm, 0)))),

          route && route.orderIds.length ? el('div.stack-sm', null,
            el('div.row-between', null,
              el('span.eyebrow', { text: `Route ${route.id}` }),
              el('button.btn.btn--sm.btn--info', {
                type: 'button', text: 'Route intelligence',
                onclick: () => { store.select('route', route.id, { force: true }); },
              })),
            el('dl.kv', null,
              ...kvRow('Stops', num(route.stops.length)),
              ...kvRow('Distance', fkm(route.km)),
              ...kvRow('Duration', dur(route.minutes)),
              ...kvRow('Energy', `${num(route.units, 1)} ${unit}`),
              ...kvRow('CO₂e', fkg(route.co2, 2), 'var(--green)'),
              ...kvRow('Cost', money(route.cost)),
              ...kvRow('Payload', `${num(route.capacityUsedKg)} kg · ${pct(route.capacityPct, 0)}`),
              ...kvRow('Returns', clock(route.endMinutes)),
              ...kvRow('Energy needed', pct(route.energyFraction, 0),
                route.energyFraction > v.energyLevel - 0.1 ? 'var(--red)' : undefined)),
            el('div.meter-pair', null,
              meterBlock('Payload', route.capacityPct, route.capacityPct > 0.92 ? 'var(--amber)' : 'var(--cyan)'),
              meterBlock('Energy required', route.energyFraction, route.energyFraction > 0.8 ? 'var(--red)' : 'var(--green)')),
            route.violations.length ? el('div.stack-sm', null,
              el('span.eyebrow', { text: 'Constraints' }),
              ...route.violations.map((vio) => el('div.chip', {
                class: vio.severity === 'hard' ? 'chip--red' : 'chip--amber',
                style: { whiteSpace: 'normal', textTransform: 'none', letterSpacing: '0', fontSize: '10.5px' },
              }, el('i.dot'), vio.label))) : null,
            el('div.stack-sm', null,
              el('span.eyebrow', { text: 'Manifest' }),
              el('div.stack-sm', null, ...route.stops.map((s, i) => stopRow(s, i)))))
            : el('div.empty-state', { style: { padding: '14px 4px' } },
              el('p', { text: v.available ? 'No assignment in the current plan. Run OPTIMIZE FLEET or lower the objective’s cost weight to bring this vehicle into service.' : 'This vehicle is out of service in the active scenario.' })),

          el('div.row.wrap', null,
            el('button.btn.btn--sm', {
              type: 'button', text: 'Focus on map', html: `${icon('target', 12)}<span>Focus</span>`,
              onclick: () => selectVehicle(v.id),
            }),
            el('button.btn.btn--sm', {
              type: 'button',
              text: v.available ? 'Simulate failure' : 'Restore',
              onclick: () => {
                store.toggleScenarioVehicle(v.id);
                emit(EV.TOAST, {
                  message: `${v.callsign} staged as ${store.pendingScenario.disabledVehicles.includes(v.id) ? 'out of service' : 'available'}. Open Simulation and press REPLAN.`,
                  tone: 'info',
                });
              },
            })),
          el('p.basis', { text: `Position ${geo(v.x, v.y)} · telemetry simulated at ${clock(store.clockMinutes)}.` }))));
  }

  function meterBlock(label, value, color) {
    return el('div', null,
      el('div.meter-label', null, el('span', { text: label }), el('span', { text: pct(value, 0) })),
      el('div.meter', { style: { '--meter-color': color } },
        el('i', { style: { width: `${Math.min(100, Math.round(value * 100))}%` } })));
  }

  function stopRow(s, i) {
    const o = store.ordersById.get(s.orderId);
    const late = s.late > 0;
    const delivered = o?.status === 'delivered';
    return el('button.alert', {
      type: 'button', dataset: { sev: late ? 'high' : delivered ? 'low' : 'medium' },
      onclick: () => { store.select('order', s.orderId, { force: true }); emit(EV.FOCUS_MAP, { x: s.x, y: s.y, zoom: 3.4 }); },
    },
    el('span.sev', { style: { background: late ? 'var(--red)' : delivered ? 'var(--green)' : PRIORITY[s.priority]?.color || 'var(--cyan)' } }),
    el('span', null,
      el('span.title', { text: `${i + 1}. ${s.orderId} · ${s.consignee}` }),
      el('span.detail', {
        text: `${s.district} · ${num(s.weightKg)} kg · arrive ${clock(s.arrival)}`
          + (late ? ` · ${dur(s.late)} late` : ` · ${dur(s.deadline - s.serviceStart)} slack`),
      })),
    el('span.sev-tag', { text: delivered ? 'DONE' : clock(s.serviceStart) }));
  }

  /* --- route ------------------------------------------------------- */

  function routeDetail(id) {
    const r = store.routesById?.get(id);
    if (!r) return el('div');
    const v = store.vehiclesById.get(r.vehicleId);
    const type = VEHICLE_TYPES[r.vehicleType];
    const ex = store.explainRouteById(id);
    const unit = energyUnitLabel(r.vehicleType);

    return el('section.panel.panel--accent', null,
      detailHead(r.id.toUpperCase(), `${v?.callsign ?? ''} · ${type.label}`),
      el('div.panel-body', null,
        el('div.stack', null,
          el('dl.kv', null,
            ...kvRow('Distance', fkm(r.km)),
            ...kvRow('ETA at last stop', clock(r.stops.length ? r.stops[r.stops.length - 1].serviceStart : r.endMinutes)),
            ...kvRow('Duration', dur(r.minutes)),
            ...kvRow('Driving / service', `${dur(r.drivingMinutes)} / ${dur(r.serviceMinutes)}`),
            ...kvRow(`Energy (${unit})`, num(r.units, 1)),
            ...kvRow('Estimated CO₂e', fkg(r.co2, 2), 'var(--green)'),
            ...kvRow('Tolls', money(r.toll)),
            ...kvRow('Operating cost', money(r.cost)),
            el('div.kv-divider'),
            ...kvRow('Stops', num(r.stops.length)),
            ...kvRow('Vehicle', v?.callsign ?? '—'),
            ...kvRow('Capacity utilisation', pct(r.capacityPct, 0)),
            ...kvRow('Reliability', pct(r.reliability, 0)),
            ...kvRow('On-time', pct(r.onTime ?? 1, 0), (r.onTime ?? 1) < 1 ? 'var(--amber)' : undefined)),

          ex ? el('div.explain', null,
            el('div.why-title', { text: 'Why this route?' }),
            el('p', { text: ex.summary }),
            el('ul.drivers', null, ...ex.drivers.slice(0, 6).map((d) => el('li', { dataset: { sign: d.sign } },
              el('span.sign', { text: d.sign }),
              el('span', null,
                el('span.d-label', { text: d.label }),
                el('span.d-detail', { text: d.detail }))))),
            el('p.basis', { text: ex.basis })) : null,

          el('div.row.wrap', null,
            el('button.btn.btn--sm', {
              type: 'button', html: `${icon('route', 12)}<span>Fit route</span>`,
              onclick: () => emit(EV.FOCUS_MAP, { points: r.polyline, padding: 120 }),
            }),
            el('button.btn.btn--sm.btn--danger', {
              type: 'button', text: 'Close this corridor',
              onclick: () => {
                const closed = store.closeRouteCorridor(r.id);
                emit(EV.TOAST, {
                  message: closed.length
                    ? `${closed.length} links staged for closure. Open Simulation and press REPLAN.`
                    : 'No closable links on this route.',
                  tone: closed.length ? 'info' : 'bad',
                });
              },
            })))));
  }

  /* --- order ------------------------------------------------------- */

  function orderDetail(id) {
    const o = store.ordersById.get(id);
    if (!o) return el('div');
    const route = o.routeId ? store.routesById.get(o.routeId) : null;
    const stop = route?.stops.find((s) => s.orderId === o.id);
    const options = store.routeOptionsFor(o.id);
    const pr = PRIORITY[o.priority];

    return el('section.panel', null,
      detailHead(o.id, o.consignee,
        el('span.chip', {
          class: o.status === 'delivered' ? 'chip--green' : o.status === 'unserved' ? 'chip--red' : 'chip--cyan',
        }, el('i.dot'), o.status)),
      el('div.panel-body', null,
        el('div.stack', null,
          el('dl.kv', null,
            ...kvRow('Destination', o.district),
            ...kvRow('Goods', o.goods),
            ...kvRow('Priority', pr.label, pr.color),
            ...kvRow('Weight', `${num(o.weightKg)} kg`),
            ...kvRow('Window', `${clock(o.windowOpen)} – ${clock(o.deadline)}`),
            ...kvRow('ETA', o.etaMinutes != null ? clock(o.etaMinutes) : '—',
              stop?.late > 0 ? 'var(--red)' : undefined),
            ...kvRow('Slack', stop ? dur(stop.deadline - stop.serviceStart) : '—'),
            ...kvRow('Assigned to', o.assignedVehicle ? store.vehiclesById.get(o.assignedVehicle)?.callsign : 'Unassigned',
              o.assignedVehicle ? undefined : 'var(--red)'),
            ...kvRow('Route', o.routeId ?? '—')),

          options.length ? el('div.stack-sm', null,
            el('span.eyebrow', { text: 'Route comparison — approach leg' }),
            el('div', { style: { overflowX: 'auto' } },
              el('table.tbl', null,
                el('thead', null, el('tr', null,
                  el('th', { text: '' }),
                  el('th', { text: 'Route' }),
                  el('th.r', { text: 'Time' }),
                  el('th.r', { text: 'Cost' }),
                  el('th.r', { text: 'CO₂e' }),
                  el('th.r', { text: 'Dist' }))),
                el('tbody', null, ...options.map((opt) => el('tr', {
                  'aria-selected': String(o.preferredRouting === opt.key),
                  onmouseenter: () => store.toggleLayer('alternates', true),
                }, el('td', null, el('strong', { text: opt.letter })),
                el('td.name', { text: opt.label + (opt.alsoKnownAs.length ? ` (${opt.alsoKnownAs.join(', ')})` : '') }),
                el('td', { class: `r ${opt.bestAt?.includes('minutes') ? 'best' : ''}`, text: dur(opt.minutes) }),
                el('td', { class: `r ${opt.bestAt?.includes('cost') ? 'best' : ''}`, text: money(opt.cost) }),
                el('td', { class: `r ${opt.bestAt?.includes('co2') ? 'best' : ''}`, text: num(opt.co2, 2) }),
                el('td', { class: `r ${opt.bestAt?.includes('km') ? 'best' : ''}`, text: num(opt.km, 1) }))))) ),
            el('div.row.wrap', null, ...options.map((opt) => el('button.btn.btn--sm', {
              type: 'button', text: `Select ${opt.letter}`,
              title: `Re-plan the fleet biased toward the ${opt.label.toLowerCase()} routing`,
              onclick: async () => {
                emit(EV.TOAST, { message: `Re-planning the fleet around route ${opt.letter} — ${opt.label.toLowerCase()}…`, tone: 'info' });
                await store.selectRouteOption(o.id, opt.key);
              },
            }))),
            el('p.basis', {
              text: 'Each option is a real shortest-path solution for this leg under a different weight vector, costed with the same energy, emissions and traffic model. Selecting one re-runs the optimiser with those priorities blended into the live objective.',
            })) : el('p.basis', { text: 'No alternative approach exists for this delivery under the current road network.' }),

          el('button.btn.btn--sm.btn--block', {
            type: 'button', html: `${icon('target', 12)}<span>Focus on map</span>`,
            onclick: () => emit(EV.FOCUS_MAP, { x: o.x, y: o.y, zoom: 3.4 }),
          }))));
  }

  /* --- depot / district -------------------------------------------- */

  function depotDetail(id) {
    const d = store.depotsById.get(id);
    if (!d) return el('div');
    const fleet = store.vehicles.filter((v) => v.depotId === d.id);
    const routes = store.plan?.routes.filter((r) => r.depotId === d.id && r.orderIds.length) || [];
    const co2 = routes.reduce((a, r) => a + r.co2, 0);
    return el('section.panel', null,
      detailHead(d.name, 'Distribution centre'),
      el('div.panel-body', null,
        el('dl.kv', null,
          ...kvRow('District', d.district),
          ...kvRow('Docks', num(d.dockCount)),
          ...kvRow('Fleet based here', num(fleet.length)),
          ...kvRow('Active routes', num(routes.length)),
          ...kvRow('Planned CO₂e', fkg(co2, 1), 'var(--green)'),
          ...kvRow('Opens', clock(d.openMinutes)),
          ...kvRow('Closes', clock(d.closeMinutes)),
          ...kvRow('Coordinates', geo(d.x, d.y)))));
  }

  function districtDetail(id) {
    const d = store.world.districts.find((x) => x.id === id);
    if (!d) return el('div');
    const orders = store.orders.filter((o) => o.districtId === d.id);
    const delivered = orders.filter((o) => o.status === 'delivered').length;
    const weight = orders.reduce((a, o) => a + o.weightKg, 0);
    return el('section.panel', null,
      detailHead(d.name, d.typeLabel),
      el('div.panel-body', null,
        el('dl.kv', null,
          ...kvRow('Zone type', d.typeLabel),
          ...kvRow('Demand index', num(d.demand, 2)),
          ...kvRow('Orders', num(orders.length)),
          ...kvRow('Delivered', num(delivered)),
          ...kvRow('Total weight', `${num(weight)} kg`),
          ...kvRow('Radius', fkm(d.radiusKm, 1)),
          ...kvRow('Centre', geo(d.x, d.y)))));
  }

  /* ---------------------------------------------------------------- */

  on(EV.ALERTS_CHANGED, renderAlerts);
  on(EV.SELECT, renderDetail);
  on(EV.PLAN_CHANGED, () => { renderFleet(); renderDetail(); renderAlerts(); });
  on(EV.ORDERS_CHANGED, () => { renderFleet(); renderDetail(); });
  // The sim clock ticks at 60fps; the fleet cards only need to be legible,
  // so they refresh at 2.5Hz instead of rebuilding ten cards every frame.
  on(EV.FLEET_TICK, throttle(renderFleet, 400));
  on(EV.WEIGHTS_CHANGED, renderDetail);

  renderAlerts(); renderFleet(); renderDetail();

  return { selectVehicle };
}
