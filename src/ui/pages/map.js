/**
 * MAP PAGE
 *
 * The live picture: real cartography, the planned routes on it, and an
 * inspector for whatever is selected. Deliberately sparse — fleet maintenance,
 * order entry and analysis each have their own tab, so this screen can stay
 * about watching the network.
 */

import { LAYERS, VEHICLE_TYPES, PRIORITY } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, throttle, announce, setText } from '../../util/dom.js';
import { clock, dur, kg as fkg, km as fkm, money, num, pct, stamp } from '../../util/format.js';
import { vehicleColor } from '../../render/palette.js';
import { icon } from '../icons.js';
import { card, kv, empty, chip, statTile } from '../components.js';
import { countTo, flashDelta, revealRoute } from '../motion.js';
import { energyUnitLabel } from '../../engines/energy.js';

export function mapPage(store, map) {
  const canvas = document.getElementById('map-canvas');
  const root = el('div.map-page');

  const hero = el('div.hero-strip', { id: 'hero-strip' });
  const layerMenu = el('div.layer-menu', { hidden: true });
  const inspector = el('aside.inspector', { id: 'map-inspector' });
  const tip = el('div.map-tip', { hidden: true });
  const pickBanner = el('div.pick-banner', { hidden: true });

  const stage = el('div.map-stage', null,
    canvas,
    el('div.map-overlay', null,
      el('div.map-overlay-top', null, hero, el('span.spacer'), tools()),
      pickBanner,
      el('div.map-overlay-bottom', null,
        el('div.map-attrib', { id: 'map-attrib' }),
        el('span.spacer'),
        el('div.map-status', { id: 'map-status' }))),
    tip,
    layerMenu);

  mount(root, stage, inspector);

  /** This page and the PERSONAL journey page share one canvas. */
  root.adoptCanvas = () => { if (canvas.parentElement !== stage) stage.prepend(canvas); };

  /* ------------------------------------------------------- tools */

  function tools() {
    const toolBtn = (name, label, fn) => el('button.tool-btn', {
      type: 'button', title: label, 'aria-label': label, html: icon(name), onclick: fn,
    });
    const layersBtn = el('button.tool-btn', {
      type: 'button', title: 'Map layers', 'aria-label': 'Map layers',
      'aria-expanded': 'false', html: icon('layers'),
      onclick: () => {
        layerMenu.hidden = !layerMenu.hidden;
        layersBtn.setAttribute('aria-expanded', String(!layerMenu.hidden));
        if (!layerMenu.hidden) renderLayerMenu();
      },
    });
    return el('div.map-tools', null,
      el('div.tool-group', null,
        toolBtn('plus', 'Zoom in', () => map.zoomBy(1)),
        toolBtn('minus', 'Zoom out', () => map.zoomBy(-1)),
        toolBtn('target', 'Fit everything', () => fitAll())),
      el('div.tool-group', null,
        toolBtn('fleet', 'Fit the fleet', () => fitFleet()),
        toolBtn('route', 'Fit the planned routes', () => fitRoutes())),
      el('div.tool-group', null, layersBtn));
  }

  function renderLayerMenu() {
    mount(layerMenu,
      el('div.layer-menu-head', null, el('span.eyebrow', { text: 'Layers' })),
      ...LAYERS.map((l) => el('label.layer-row', null,
        el('input', {
          type: 'checkbox', checked: store.layers[l.key],
          onchange: (e) => { store.toggleLayer(l.key, e.target.checked); map.invalidate(); },
        }),
        el('span.box', { html: icon('check', 9) }),
        el('span.txt', { text: l.label }))));
  }

  /* ------------------------------------------------------ framing */

  const allPoints = () => [
    ...store.depots.map((d) => ({ lon: d.lon, lat: d.lat })),
    ...store.orders.map((o) => ({ lon: o.lon, lat: o.lat })),
  ];

  function fitAll() {
    const pts = allPoints();
    if (pts.length) map.fit(pts, { padding: 90 });
    else {
      const r = store.workspace.region || { lon: 78.4867, lat: 17.385 };
      map.setView(r.lon, r.lat, 11);
    }
    announce('Map fitted to all locations');
  }

  function fitFleet() {
    const pts = store.vehicles.filter((v) => v.lon != null).map((v) => ({ lon: v.lon, lat: v.lat }));
    if (pts.length) map.fit(pts, { padding: 120 });
    else fitAll();
  }

  function fitRoutes() {
    const pts = [];
    for (const r of store.plan?.routes || []) {
      const path = r.path || [];
      for (let i = 0; i < path.length; i += Math.max(1, Math.floor(path.length / 60))) pts.push(path[i]);
      for (const s of r.stops) pts.push({ lon: s.lon, lat: s.lat });
    }
    if (pts.length) map.fit(pts, { padding: 110 });
    else fitAll();
  }

  /* -------------------------------------------------- hero strip */

  // `raw` and `fmt` are split so the readout can travel from its old value to
  // its new one rather than snapping: after a re-plan, seeing cost fall is the
  // information, and a figure that simply replaces itself does not show that.
  const HERO = [
    { key: 'vehicles', label: 'Active', tone: 'cyan', raw: (m) => m.activeVehicles, fmt: (v) => String(Math.round(v)), sub: (m) => `/ ${m.totalVehicles}` },
    { key: 'deliveries', label: 'Deliveries', raw: (m) => m.deliveries, fmt: (v) => num(v), sub: (m) => `· ${m.delivered} done` },
    { key: 'onTime', label: 'On-time', tone: 'green', raw: (m) => m.onTimeRate, fmt: (v) => pct(v, 1) },
    { key: 'co2', label: 'CO₂e', tone: 'green', raw: (m) => m.co2, fmt: (v) => num(v, 1), sub: () => 'kg' },
    { key: 'km', label: 'Distance', raw: (m) => m.km, fmt: (v) => num(v, 0), sub: () => 'km' },
    { key: 'cost', label: 'Cost', tone: 'amber', raw: (m) => m.cost, fmt: (v) => money(v) },
  ];

  /** Live value nodes, kept across renders so their numbers can be tweened. */
  let heroCells = null;

  const renderHero = raf1(() => {
    if (!store.plan) {
      mount(hero, el('div.hero-empty', null,
        el('span', { html: icon('info', 14) }),
        el('span', { text: 'No plan yet — open Optimise and run the optimiser.' })));
      heroCells = null;
      return;
    }
    const m = store.heroMetrics();

    if (!heroCells || hero.childElementCount !== HERO.length) {
      const cells = HERO.map((h) => el('div.hero-stat', { dataset: { tone: h.tone || '' } },
        el('span.k', { text: h.label }),
        el('span.v.num', null,
          el('span.val', { text: h.fmt(h.raw(m)) }),
          h.sub ? el('small', { text: h.sub(m) }) : null)));
      mount(hero, ...cells);
      heroCells = HERO.map((h, i) => ({
        spec: h,
        val: cells[i].querySelector('.val'),
        sub: cells[i].querySelector('small'),
      }));
      return;
    }

    for (const cell of heroCells) {
      const next = cell.spec.raw(m);
      const changed = Math.abs((cell.val._countValue ?? next) - next) > 1e-9;
      countTo(cell.val, next, cell.spec.fmt);
      if (cell.sub && cell.spec.sub) setText(cell.sub, cell.spec.sub(m));
      if (changed) flashDelta(cell.val);
    }
  });

  /* ----------------------------------------------------- status */

  const renderStatus = raf1(() => {
    const host = document.getElementById('map-status');
    if (!host) return;
    const cong = store.matrix.networkIndex(store.clockMinutes);
    const level = cong < 0.3 ? 'Clear' : cong < 0.5 ? 'Normal' : cong < 0.68 ? 'Busy' : cong < 0.84 ? 'Heavy' : 'Severe';
    mount(host,
      el('div.glass-bar', null,
        el('span.row', null, el('span.eyebrow', { text: 'Traffic model' }),
          chip(level, cong > 0.68 ? 'red' : cong > 0.5 ? 'amber' : 'green')),
        el('span.row', null, el('span.eyebrow', { text: 'Zoom' }),
          el('span.num', { text: map.zoom.toFixed(1) })),
        el('span.row', null, el('span.eyebrow', { text: 'FPS' }),
          el('span.num', { text: num(map.fps, 0) }))));
  });

  const renderAttrib = () => {
    const host = document.getElementById('map-attrib');
    if (!host) return;
    mount(host, el('div.attrib-bar', null,
      el('span', { text: map.provider?.attribution || '' }),
      store.matrix.ready && !store.matrix.estimated
        ? el('span', { text: ' · Routing by OSRM' })
        : el('span.attrib-warn', { text: ' · straight-line estimates' })));
  };

  /* ----------------------------------------------- pick-on-map */

  let pickHandler = null;
  on(EV.PICK_MODE, ({ active, onPick }) => {
    pickHandler = active ? onPick : null;
    pickBanner.hidden = !active;
    if (active) {
      mount(pickBanner,
        el('span', { html: icon('target', 14) }),
        el('span', { text: 'Click the map to place this location.' }),
        el('button.btn.btn--sm', {
          type: 'button', text: 'Cancel',
          onclick: () => { pickHandler = null; pickBanner.hidden = true; },
        }));
      emit(EV.VIEW_CHANGED, 'map');
      announce('Pick a location on the map');
    }
  });

  on(EV.MAP_CLICK, ({ hit, lon, lat }) => {
    if (pickHandler) {
      const fn = pickHandler;
      pickHandler = null;
      pickBanner.hidden = true;
      fn({ lon, lat });
      return;
    }
    if (hit) store.select(hit.kind, hit.id, { force: true });
    else store.clearSelection();
  });

  /* ------------------------------------------------------ tooltip */

  const renderTip = () => {
    const h = store.hover;
    if (!h.kind || !map.pointer.inside) { tip.hidden = true; return; }
    let title = '', main = '', sub = '';
    if (h.kind === 'vehicle') {
      const v = store.vehiclesById.get(h.id);
      if (!v) return;
      const r = store.routeByVehicle.get(v.id);
      title = v.callsign;
      main = `${v.typeLabel} · ${v.status}`;
      sub = r && r.orderIds.length
        ? `${r.stops.length} stops · ${fkm(r.km)} · ${fkg(r.co2, 1)} CO₂e`
        : `Idle · ${pct(v.energyLevel, 0)} energy`;
    } else if (h.kind === 'order') {
      const o = store.ordersById.get(h.id);
      if (!o) return;
      title = o.ref; main = `${o.consignee}`;
      sub = `${o.short} · ${num(o.weightKg)} kg · due ${clock(o.deadline)}`;
    } else if (h.kind === 'depot') {
      const d = store.depotsById.get(h.id);
      if (!d) return;
      title = d.name; main = d.short; sub = `${d.dockCount} docks`;
    } else if (h.kind === 'route') {
      const r = store.routesById.get(h.id);
      if (!r) return;
      title = r.id;
      main = `${store.vehiclesById.get(r.vehicleId)?.callsign ?? ''} · ${r.stops.length} stops`;
      sub = `${fkm(r.km)} · ${dur(r.minutes)} · ${fkg(r.co2, 1)} CO₂e`;
    } else { tip.hidden = true; return; }

    mount(tip, el('div.tt', { text: title }), el('div.tm', { text: main }), el('div.ts', { text: sub }));
    tip.hidden = false;
    const rect = stage.getBoundingClientRect();
    const px = map.pointer.x / map.dpr, py = map.pointer.y / map.dpr;
    const x = px + 16 + tip.offsetWidth > rect.width ? px - tip.offsetWidth - 16 : px + 16;
    const y = py + 16 + tip.offsetHeight > rect.height ? py - tip.offsetHeight - 16 : py + 16;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };

  /* ---------------------------------------------------- inspector */

  const renderInspector = raf1(() => {
    const sel = store.selection;
    if (!sel.kind) { mount(inspector, inspectorIdle()); return; }
    if (sel.kind === 'vehicle') mount(inspector, vehicleCard(sel.id));
    else if (sel.kind === 'order') mount(inspector, orderCard(sel.id));
    else if (sel.kind === 'depot') mount(inspector, depotCard(sel.id));
    else if (sel.kind === 'route') mount(inspector, routeCard(sel.id));
    else mount(inspector, inspectorIdle());
  });

  function inspectorIdle() {
    const plan = store.plan;
    return el('div.inspector-inner', null,
      card('Network', null,
        el('div.tile-row', null,
          statTile('Depots', num(store.depots.length)),
          statTile('Vehicles', num(store.vehicles.length)),
          statTile('Orders', num(store.orders.length))),
        plan
          ? el('dl.kv', { style: { marginTop: '12px' } },
            ...kv('Routes', num(plan.routes.filter((r) => r.orderIds.length).length)),
            ...kv('Distance', fkm(plan.metrics.km, 0)),
            ...kv('Fleet time', dur(plan.metrics.minutes)),
            ...kv('CO₂e', fkg(plan.metrics.co2, 1), 'var(--success)'),
            ...kv('Cost', money(plan.metrics.cost)),
            ...kv('Unserved', num(plan.metrics.unserved), plan.metrics.unserved ? 'var(--danger)' : undefined))
          : empty('No plan yet.', 'Open the Optimise tab and run the optimiser.')),
      card('Selection', null, empty('Click a vehicle, stop, depot or route on the map to inspect it.')));
  }

  const head = (title, sub, extra) => el('div.panel-head', null,
    el('h3', { text: title }),
    sub ? el('span.eyebrow', { text: sub }) : null,
    el('span.spacer'),
    extra || null,
    el('button.btn.btn--ghost.btn--sm', {
      type: 'button', 'aria-label': 'Close', html: icon('close', 11),
      onclick: () => store.clearSelection(),
    }));

  function vehicleCard(id) {
    const v = store.vehiclesById.get(id);
    if (!v) return inspectorIdle();
    const type = VEHICLE_TYPES[v.type];
    const route = store.routeByVehicle.get(v.id);
    return el('div.inspector-inner', null,
      el('section.panel', null,
        head(v.callsign, type.label, chip(v.status, statusTone(v.status))),
        el('div.panel-body', null,
          el('dl.kv', null,
            ...kv('Driver', v.driver),
            ...kv('Registration', v.registration || '—'),
            ...kv('Depot', store.depotsById.get(v.depotId)?.name || '—'),
            ...kv('Capacity', `${num(type.capacityKg)} kg`),
            ...kv('Energy', pct(v.energyLevel, 0), v.energyLevel < 0.2 ? 'var(--danger)' : undefined),
            ...kv('Range left', fkm(type.rangeKm * v.energyLevel, 0))),
          route && route.orderIds.length
            ? el('div.stack-sm', { style: { marginTop: '12px' } },
              el('span.eyebrow', { text: `Route ${route.id}` }),
              el('dl.kv', null,
                ...kv('Stops', num(route.stops.length)),
                ...kv('Distance', fkm(route.km)),
                ...kv('Duration', dur(route.minutes)),
                ...kv('Energy', `${num(route.units, 1)} ${energyUnitLabel(v.type)}`),
                ...kv('CO₂e', fkg(route.co2, 2), 'var(--success)'),
            ...(route.refuelStops
              ? kv(VEHICLE_TYPES[route.vehicleType]?.energyType === 'bev' ? 'Charging stops' : 'Fuel stops',
                `${route.refuelStops} · +${dur(route.refuelMinutes, { compact: true })}`, 'var(--gold-deep)')
              : []),
            ...(route.restStops
              ? kv('Driver rests', `${route.restStops} · +${dur(route.restMinutes, { compact: true })}`, 'var(--gold-deep)')
              : []),
                ...kv('Cost', money(route.cost)),
                ...kv('Payload', `${num(route.capacityUsedKg)} kg · ${pct(route.capacityPct, 0)}`),
                ...kv('Back at', clock(route.endMinutes))),
              el('button.btn.btn--sm.btn--info.btn--block', {
                type: 'button', text: 'Route intelligence',
                onclick: () => store.select('route', route.id, { force: true }),
              }),
              el('div.stack-sm', null,
                el('span.eyebrow', { text: 'Manifest' }),
                ...route.stops.map((s, i) => stopRow(s, i))))
            : el('p.basis', { text: v.available ? 'No assignment in the current plan.' : 'Out of service in the active scenario.' }),
          el('button.btn.btn--sm.btn--block', {
            type: 'button', html: `${icon('target', 12)}<span>Focus on map</span>`,
            style: { marginTop: '10px' },
            onclick: () => {
              if (route?.path?.length) map.fit(route.path, { padding: 110 });
              else if (v.lon != null) map.setView(v.lon, v.lat, 14);
            },
          }))));
  }

  function stopRow(s, i) {
    const o = store.ordersById.get(s.orderId);
    const late = s.late > 0;
    const delivered = o?.status === 'delivered';
    return el('button.mini-row', {
      type: 'button',
      onclick: () => { store.select('order', s.orderId, { force: true }); map.setView(s.lon, s.lat, 15); },
    },
    el('span.mini-bar', { style: { background: late ? 'var(--danger)' : delivered ? 'var(--success)' : PRIORITY[s.priority]?.color || 'var(--teal)' } }),
    el('span.mini-text', null,
      el('strong', { text: `${i + 1}. ${o?.ref || s.orderId} · ${s.consignee}` }),
      el('small', { text: `${clock(s.serviceStart)} · ${num(s.weightKg)} kg${late ? ` · ${dur(s.late)} late` : ''}` })));
  }

  function routeCard(id) {
    const r = store.routesById.get(id);
    if (!r) return inspectorIdle();
    const v = store.vehiclesById.get(r.vehicleId);
    const ex = store.explainRouteById(id);
    return el('div.inspector-inner', null,
      el('section.panel.panel--accent', null,
        head(r.id, v?.callsign || ''),
        el('div.panel-body', null,
          el('dl.kv', null,
            ...kv('Distance', fkm(r.km)),
            ...kv('Duration', dur(r.minutes)),
            ...kv('Driving / service', `${dur(r.drivingMinutes)} / ${dur(r.serviceMinutes)}`),
            ...kv('Energy', `${num(r.units, 1)} ${energyUnitLabel(r.vehicleType)}`),
            ...kv('CO₂e', fkg(r.co2, 2), 'var(--success)'),
            ...kv('Cost', money(r.cost)),
            ...kv('Stops', num(r.stops.length)),
            ...kv('Utilisation', pct(r.capacityPct, 0)),
            ...kv('On-time', pct(r.onTime ?? 1, 0), (r.onTime ?? 1) < 1 ? 'var(--gold-deep)' : undefined)),
          ex ? el('div.explain', { style: { marginTop: '12px' } },
            el('div.why-title', { text: 'Why this route?' }),
            el('p', { text: ex.summary }),
            el('ul.drivers', null, ...ex.drivers.slice(0, 5).map((d) => el('li', { dataset: { sign: d.sign } },
              el('span.sign', { text: d.sign }),
              el('span', null,
                el('span.d-label', { text: d.label }),
                el('span.d-detail', { text: d.detail }))))),
            el('p.basis', { text: ex.basis })) : null,
          r.geometryEstimated ? el('p.basis', {
            style: { color: 'var(--gold-deep)' },
            text: 'The line drawn for this route is a straight-line estimate — the routing service did not return road geometry.',
          }) : null,
          el('button.btn.btn--sm.btn--block', {
            type: 'button', text: 'Fit this route', style: { marginTop: '10px' },
            onclick: () => { if (r.path?.length) map.fit(r.path, { padding: 100 }); },
          }))));
  }

  function orderCard(id) {
    const o = store.ordersById.get(id);
    if (!o) return inspectorIdle();
    const route = o.routeId ? store.routesById.get(o.routeId) : null;
    const stop = route?.stops.find((s) => s.orderId === o.id);
    return el('div.inspector-inner', null,
      el('section.panel', null,
        head(o.ref, o.consignee, chip(o.status, o.status === 'delivered' ? 'green' : o.status === 'unserved' ? 'red' : 'cyan')),
        el('div.panel-body', null,
          el('dl.kv', null,
            ...kv('Address', o.short),
            ...kv('Goods', o.goods || '—'),
            ...kv('Priority', PRIORITY[o.priority].label, PRIORITY[o.priority].color),
            ...kv('Weight', `${num(o.weightKg)} kg`),
            ...kv('Window', `${clock(o.windowOpen)} – ${clock(o.deadline)}`),
            ...kv('ETA', o.etaMinutes != null ? clock(o.etaMinutes) : '—', stop?.late > 0 ? 'var(--danger)' : undefined),
            ...kv('Slack', stop ? dur(stop.deadline - stop.serviceStart) : '—'),
            ...kv('Vehicle', o.assignedVehicle ? store.vehiclesById.get(o.assignedVehicle)?.callsign : 'Unassigned',
              o.assignedVehicle ? undefined : 'var(--danger)')),
          o.notes ? el('p.basis', { text: o.notes }) : null,
          el('button.btn.btn--sm.btn--block', {
            type: 'button', html: `${icon('target', 12)}<span>Focus on map</span>`,
            style: { marginTop: '10px' },
            onclick: () => map.setView(o.lon, o.lat, 15),
          }))));
  }

  function depotCard(id) {
    const d = store.depotsById.get(id);
    if (!d) return inspectorIdle();
    const fleet = store.vehicles.filter((v) => v.depotId === d.id);
    const routes = store.plan?.routes.filter((r) => r.depotId === d.id && r.orderIds.length) || [];
    return el('div.inspector-inner', null,
      el('section.panel', null,
        head(d.name, 'Depot'),
        el('div.panel-body', null,
          el('dl.kv', null,
            ...kv('Address', d.short),
            ...kv('Docks', num(d.dockCount)),
            ...kv('Opens', clock(d.openMinutes)),
            ...kv('Closes', clock(d.closeMinutes)),
            ...kv('Vehicles based here', num(fleet.length)),
            ...kv('Active routes', num(routes.length)),
            ...kv('Planned CO₂e', fkg(routes.reduce((a, r) => a + r.co2, 0), 1), 'var(--success)')),
          el('button.btn.btn--sm.btn--block', {
            type: 'button', html: `${icon('target', 12)}<span>Focus on map</span>`,
            style: { marginTop: '10px' },
            onclick: () => map.setView(d.lon, d.lat, 14),
          }))));
  }

  const statusTone = (s) => ({
    moving: 'cyan', delivering: 'green', returning: 'violet',
    delayed: 'orange', charging: 'amber', disabled: 'red',
  }[s] || '');

  /* ------------------------------------------------------ wiring */

  on(EV.PLAN_CHANGED, () => { renderHero(); renderInspector(); renderAttrib(); map.invalidate(); });
  on(EV.ENTITIES_CHANGED, () => { renderHero(); renderInspector(); map.invalidate(); });
  on(EV.ORDERS_CHANGED, renderHero);
  on(EV.SELECT, renderInspector);
  on(EV.HOVER, renderTip);
  on(EV.MATRIX_CHANGED, renderAttrib);
  on(EV.SETTINGS_CHANGED, renderAttrib);
  on(EV.FLEET_TICK, throttle(() => { renderStatus(); renderTip(); }, 250));
  on(EV.FLEET_TICK, throttle(renderInspector, 1000));

  renderHero(); renderStatus(); renderInspector(); renderAttrib();

  root.fitAll = fitAll;
  root.fitFleet = fitFleet;
  root.fitRoutes = fitRoutes;
  return root;
}
