/**
 * HUD — the furniture that sits on top of the map.
 *
 * Hero statistics, map tools, the legend, the hover tooltip, the ops clock and
 * the AI status pip. Everything here is read-only with respect to the domain:
 * it reflects the store, and routes user intent back through store methods.
 */

import { APP, SIM, LAYERS } from '../config.js';
import { EV, on } from '../core/bus.js';
import { el, mount, setText, setClass, raf1, announce } from '../util/dom.js';
import { clock, km as fkm, kg as fkg, money, num, pct } from '../util/format.js';
import { icon } from './icons.js';
import { congestionColor, C } from '../render/palette.js';

export function initHud(store, map) {
  const heroHost = document.getElementById('hero-stats');
  const toolsHost = document.getElementById('map-tools');
  const legendHost = document.getElementById('map-legend');
  const statusHost = document.getElementById('map-status');
  const tip = document.getElementById('map-tip');
  const clockEl = document.getElementById('sim-clock');
  const aiStatus = document.getElementById('ai-status');
  const speedHost = document.getElementById('speed-control');

  /* ---------------------------------------------------------------- */
  /* Hero statistics                                                   */
  /* ---------------------------------------------------------------- */

  const HERO = [
    { key: 'activeVehicles', label: 'Active vehicles', tone: 'cyan', fmt: (m) => num(m.activeVehicles).padStart(2, '0'), sub: (m) => `/ ${m.totalVehicles}` },
    { key: 'deliveries', label: 'Deliveries', tone: '', fmt: (m) => num(m.deliveries), sub: (m) => `\u00b7 ${m.delivered} delivered` },
    { key: 'onTimeRate', label: 'On-time rate', tone: 'green', fmt: (m) => pct(m.onTimeRate, 1) },
    { key: 'co2', label: 'CO₂e planned', tone: 'green', fmt: (m) => num(m.co2, 1), sub: () => 'kg' },
    { key: 'km', label: 'Distance', tone: '', fmt: (m) => num(m.km, 0), sub: () => 'km' },
    { key: 'utilization', label: 'Fleet utilisation', tone: 'amber', fmt: (m) => pct(m.utilization, 0) },
  ];

  const heroNodes = new Map();
  mount(heroHost, HERO.map((spec) => {
    const v = el('span.v.num');
    const node = el('div.hero-stat', { dataset: { tone: spec.tone }, role: 'group', 'aria-label': spec.label },
      el('span.k', { text: spec.label }), v);
    heroNodes.set(spec.key, { node, v, spec, last: null });
    return node;
  }));

  const renderHero = raf1(() => {
    const m = store.heroMetrics();
    for (const [key, entry] of heroNodes) {
      const text = entry.spec.fmt(m);
      const sub = entry.spec.sub ? entry.spec.sub(m) : null;
      const composed = text + (sub ? `\u0000${sub}` : '');
      if (composed === entry.last) continue;
      // Flash only on a real change — animating every frame would be noise.
      const isFirst = entry.last === null;
      entry.last = composed;
      mount(entry.v, text, sub ? el('small', { text: sub }) : null);
      if (!isFirst) {
        entry.v.classList.remove('flash');
        void entry.v.offsetWidth;   // restart the animation
        entry.v.classList.add('flash');
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /* Map tools                                                         */
  /* ---------------------------------------------------------------- */

  const toolBtn = (name, label, onClick, pressed = null) => {
    const b = el('button.tool-btn', {
      type: 'button', title: label, 'aria-label': label, html: icon(name),
      onclick: onClick,
    });
    if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
    return b;
  };

  mount(toolsHost,
    el('div.tool-group', null,
      toolBtn('plus', 'Zoom in (+)', () => map.zoomBy(1.4)),
      toolBtn('minus', 'Zoom out (−)', () => map.zoomBy(1 / 1.4)),
      toolBtn('target', 'Reset view (0)', () => { map.fitWorld(); announce('View reset to the whole network'); })),
    el('div.tool-group', null,
      toolBtn('fleet', 'Fit fleet (F)', () => { map.fitFleet(); announce('View fitted to the fleet'); }),
      toolBtn('route', 'Fit routes (R)', () => { map.fitRoutes(); announce('View fitted to all routes'); })),
  );

  /* ---------------------------------------------------------------- */
  /* Legend                                                            */
  /* ---------------------------------------------------------------- */

  const renderLegend = () => {
    const showTraffic = store.layers.traffic;
    const showHeat = store.layers.emissions || store.layers.energy;
    mount(legendHost,
      el('div.panel', { style: { backdropFilter: 'var(--blur)', background: 'var(--glass)' } },
        el('div.panel-body.tight', null,
          el('div.stack-sm', null,
            el('div.row.wrap', { style: { gap: '10px' } },
              legendItem(C.cyan, 'Depot'),
              legendItem(C.red, 'Critical'),
              legendItem(C.green, 'Delivered'),
              legendItem('#ffffff', 'Selected route')),
            showTraffic ? el('div.row.wrap', { style: { gap: '10px' } },
              el('span.eyebrow', { text: 'Traffic' }),
              legendItem(congestionColor(0.2), 'Clear'),
              legendItem(congestionColor(0.75), 'Busy'),
              legendItem(congestionColor(1.1), 'Heavy'),
              legendItem(congestionColor(2.0), 'Severe')) : null,
            showHeat ? el('div.row.wrap', { style: { gap: '10px' } },
              el('span.eyebrow', { text: store.layers.emissions ? 'CO₂e density' : 'Energy density' }),
              el('span', {
                style: {
                  width: '96px', height: '8px', borderRadius: '99px',
                  background: store.layers.emissions
                    ? 'linear-gradient(90deg,#0a1814,#187854,#dcc45a,#e8763a,#e23e54)'
                    : 'linear-gradient(90deg,#08141f,#1e5c96,#5aaadc,#b4d6f6,#ecf6ff)',
                },
              }),
              el('span.eyebrow', { text: 'low → high' })) : null))));
  };

  const legendItem = (color, label) => el('span.row', { style: { gap: '5px' } },
    el('i', { style: { width: '8px', height: '8px', borderRadius: '99px', background: color, display: 'block' } }),
    el('span', { style: { fontSize: '10px', color: 'var(--muted)' }, text: label }));

  /* ---------------------------------------------------------------- */
  /* Map status readout                                                */
  /* ---------------------------------------------------------------- */

  const renderStatus = raf1(() => {
    const cong = store.traffic ? store.traffic.networkIndex() : 0;
    const closures = store.traffic ? store.traffic.closures.size : 0;
    const level = cong < 0.3 ? 'Clear' : cong < 0.5 ? 'Normal' : cong < 0.68 ? 'Busy' : cong < 0.84 ? 'Heavy' : 'Severe';
    mount(statusHost,
      el('div.panel', { style: { backdropFilter: 'var(--blur)', background: 'var(--glass)' } },
        el('div.panel-body.tight', null,
          el('div.row', { style: { gap: '14px' } },
            el('span.row', { style: { gap: '6px' } },
              el('span.eyebrow', { text: 'Network' }),
              el('span.chip', {
                class: cong > 0.68 ? 'chip--red' : cong > 0.5 ? 'chip--amber' : 'chip--green',
              }, el('i.dot'), level)),
            el('span.row', { style: { gap: '6px' } },
              el('span.eyebrow', { text: 'Congestion' }),
              el('span.num', { style: { fontSize: '12px' }, text: pct(cong, 0) })),
            closures ? el('span.chip.chip--red', null, el('i.dot'), `${closures} closed`) : null,
            el('span.row', { style: { gap: '6px' } },
              el('span.eyebrow', { text: 'FPS' }),
              el('span.num', { style: { fontSize: '12px', color: 'var(--muted)' }, text: num(map.fps, 0) }))))));
  });

  /* ---------------------------------------------------------------- */
  /* Hover tooltip                                                     */
  /* ---------------------------------------------------------------- */

  function renderTip() {
    const h = store.hover;
    if (!h.kind || !map.pointer.inside) { tip.hidden = true; return; }
    let title = '', main = '', sub = '';
    if (h.kind === 'vehicle') {
      const v = store.vehiclesById.get(h.id);
      if (!v) { tip.hidden = true; return; }
      const route = store.routeByVehicle?.get(v.id);
      title = v.callsign;
      main = `${v.typeLabel} · ${v.status}`;
      sub = route && route.orderIds.length
        ? `${route.orderIds.length} stops · ${fkm(route.km)} · ${fkg(route.co2, 1)} CO₂e · ${pct(v.energyLevel, 0)} energy`
        : `Idle at depot · ${pct(v.energyLevel, 0)} energy`;
    } else if (h.kind === 'order') {
      const o = store.ordersById.get(h.id);
      if (!o) { tip.hidden = true; return; }
      title = o.id;
      main = `${o.consignee} · ${o.district}`;
      sub = `${o.priority} · ${num(o.weightKg)} kg · due ${clock(o.deadline)}`
        + (o.etaMinutes != null ? ` · ETA ${clock(o.etaMinutes)}` : '');
    } else if (h.kind === 'depot') {
      const d = store.depotsById.get(h.id);
      if (!d) { tip.hidden = true; return; }
      title = d.name; main = d.district; sub = `${d.dockCount} docks · opens ${clock(d.openMinutes)}`;
    } else if (h.kind === 'route') {
      const r = store.routesById?.get(h.id);
      if (!r) { tip.hidden = true; return; }
      title = r.id;
      main = `${r.orderIds.length} stops · ${store.vehiclesById.get(r.vehicleId)?.callsign ?? ''}`;
      sub = `${fkm(r.km)} · ${fkg(r.co2, 1)} CO₂e · ${money(r.cost)}`;
    } else if (h.kind === 'district') {
      const d = store.world.districts.find((x) => x.id === h.id);
      if (!d) { tip.hidden = true; return; }
      const orders = store.orders.filter((o) => o.districtId === d.id);
      title = d.name; main = d.typeLabel;
      sub = `${orders.length} order${orders.length === 1 ? '' : 's'} in this district`;
    } else { tip.hidden = true; return; }

    mount(tip,
      el('div.tt', { text: title }),
      el('div.tm', { text: main }),
      el('div.ts', { text: sub }));
    tip.hidden = false;

    // Keep the tooltip inside the stage.
    const stage = document.getElementById('stage').getBoundingClientRect();
    const px = map.pointer.x / map.dpr, py = map.pointer.y / map.dpr;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = px + 16, y = py + 16;
    if (x + tw > stage.width - 8) x = px - tw - 16;
    if (y + th > stage.height - 8) y = py - th - 16;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  /* ---------------------------------------------------------------- */
  /* Clock, speed, AI status                                           */
  /* ---------------------------------------------------------------- */

  const renderClock = raf1(() => {
    setText(clockEl.querySelector('.t'), clock(store.clockMinutes));
    const past = store.clockMinutes >= SIM.dayEndMinutes;
    setText(clockEl.querySelector('.d'), past ? 'WINDOW CLOSED' : store.playing ? 'OPS CLOCK' : 'PAUSED');
  });

  const SPEED_LABELS = ['‖', '0.25×', '1×', '4×', '15×'];
  mount(speedHost, SIM.speeds.map((s, i) => el('button', {
    type: 'button',
    title: s === 0 ? 'Pause the operations clock' : `Run at ${SPEED_LABELS[i]} speed`,
    'aria-pressed': String(store.speedMultiplier === s),
    dataset: { speed: String(s) },
    text: SPEED_LABELS[i],
    onclick: () => {
      store.setSpeed(s);
      announce(s === 0 ? 'Operations clock paused' : `Operations clock running at ${SPEED_LABELS[i]}`);
    },
  })));

  const renderSpeed = () => {
    for (const b of speedHost.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === store.speedMultiplier));
    }
  };

  function setAiStatus(state, text) {
    aiStatus.dataset.state = state;
    setText(aiStatus.querySelector('.txt'), text);
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  on(EV.FLEET_TICK, () => { renderClock(); renderStatus(); renderTip(); });
  on(EV.HOVER, renderTip);
  on(EV.PLAN_CHANGED, () => { renderHero(); renderLegend(); });
  on(EV.ORDERS_CHANGED, renderHero);
  on(EV.STATE_CHANGED, () => { renderHero(); renderSpeed(); renderClock(); });
  on(EV.LAYERS_CHANGED, renderLegend);

  on(EV.OPT_START, ({ trigger }) => setAiStatus('working', trigger || 'Optimising'));
  on(EV.OPT_PROGRESS, (p) => {
    const label = p.phase === 'construct' ? `Building routes ${p.done}/${p.total}`
      : p.phase === 'anneal' ? `Optimising ${Math.round((p.done / p.total) * 100)}%`
        : p.phase === 'pareto' ? `Frontier ${p.done}/${p.total}`
          : p.message || 'Analysing';
    setAiStatus('working', label);
  });
  on(EV.OPT_DONE, () => {
    const alerts = store.activeAlerts().filter((a) => a.severity === 'high').length;
    setAiStatus(alerts ? 'alert' : 'idle', alerts ? `${alerts} high alert${alerts > 1 ? 's' : ''}` : 'Plan optimal');
  });
  on(EV.OPT_FAILED, ({ message }) => setAiStatus('alert', 'Optimisation failed'));
  on(EV.ALERTS_CHANGED, () => {
    if (store.optimizing) return;
    const high = store.activeAlerts().filter((a) => a.severity === 'high').length;
    setAiStatus(high ? 'alert' : 'idle', high ? `${high} high alert${high > 1 ? 's' : ''}` : 'System nominal');
  });

  renderHero(); renderLegend(); renderStatus(); renderClock(); renderSpeed();

  return { renderHero, renderLegend, setAiStatus };
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function initToasts() {
  const host = document.getElementById('toast-stack');
  on(EV.TOAST, ({ message, tone = 'info', duration = 4200 }) => {
    const node = el('div.toast', { dataset: { tone } },
      el('span', { html: icon(tone === 'bad' ? 'alert' : tone === 'good' ? 'check' : 'info') }),
      el('span', { text: message }));
    host.append(node);
    announce(message, tone === 'bad');
    setTimeout(() => {
      node.style.transition = 'opacity 260ms, transform 260ms';
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(() => node.remove(), 280);
    }, duration);
  });
}
