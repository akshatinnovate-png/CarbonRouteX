/**
 * CARBON PAGE
 *
 * Where the emissions come from, attributed causally, and what part of them
 * routing can actually change.
 */

import { ENERGY, VEHICLE_TYPES } from '../../config.js';
import { EV, on } from '../../core/bus.js';
import { el, mount, raf1 } from '../../util/dom.js';
import { kg as fkg, num, pct } from '../../util/format.js';
import { explainCarbon } from '../../engines/explain.js';
import { cleanestHour, intensityAt, CARRIER_LABEL } from '../../engines/emissions.js';
import { lineChart, stackBar } from '../charts.js';
import { C } from '../../render/palette.js';
import { page, card, kv, empty, statTile } from '../components.js';

const DIMENSIONS = [
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'route', label: 'Route' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'depot', label: 'Depot' },
  { key: 'vehicleType', label: 'Vehicle type' },
  { key: 'energySource', label: 'Energy source' },
  { key: 'distance', label: 'Distance band' },
  { key: 'traffic', label: 'Traffic level' },
];

const ATTRIBUTION_COLORS = {
  baseline: '#3d5270', payload: '#34d99a', congestion: '#f5c661', terrain: '#b78bff',
};

export function carbonPage(store, map) {
  const root = el('div.page-root');
  let dimension = 'vehicle';

  const render = raf1(() => {
    const plan = store.plan;
    if (!plan) {
      mount(root, page('Carbon', 'Where the emissions come from, and which part of them is addressable.',
        empty('No plan yet.', 'Run the optimiser to see the carbon breakdown.')));
      return;
    }
    const groups = store.emissionsBy(dimension);
    const attribution = explainCarbon(plan);
    const m = plan.metrics;

    mount(root, page('Carbon', 'Where the emissions come from, and which part of them is addressable.',
      el('div.stack', null,
        el('div.tile-row', null,
          statTile('Total planned', num(m.co2, 1), { sub: 'kg CO₂e', tone: 'green' }),
          statTile('Per stop', num(m.co2PerStop, 2), { sub: 'kg' }),
          statTile('Per km', num(m.co2PerKm, 3), { sub: 'kg/km' }),
          statTile('Addressable', pct(attribution.addressable / Math.max(attribution.total, 1e-9), 0), { tone: 'amber' })),
        el('div.grid-2', null, breakdown(groups, m.co2), attributionCard(attribution)),
        el('div.grid-2', null, gridWindow(plan), intensityCard()))));
  });

  function breakdown(groups, total) {
    const max = groups.length ? groups[0].value : 1;
    return card('Emissions breakdown',
      el('select.input.input--inline', {
        'aria-label': 'Break emissions down by',
        onchange: (e) => { dimension = e.target.value; render(); },
      }, ...DIMENSIONS.map((d) => el('option', { value: d.key, selected: d.key === dimension, text: d.label }))),
      el('div.stack-sm', null,
        el('div.row-between', null,
          el('span.eyebrow', { text: 'Total planned' }),
          el('span.num', { style: { fontSize: '18px', color: 'var(--green)' }, text: fkg(total, 1) })),
        groups.length
          ? el('div.bar-rows', { style: { maxHeight: '320px', overflowY: 'auto' } },
            ...groups.slice(0, 16).map((g) => el('div.bar-row', null,
              el('span.bl', null, g.label, g.sub ? el('small', { text: g.sub }) : null),
              el('span.bt', null, el('i', { style: { width: `${Math.round((g.value / max) * 100)}%` } })),
              el('span.bv', { text: `${num(g.value, 2)} kg` }))))
          : empty('No emissions in this plan.'),
        el('p.basis', {
          text: 'Every figure is the sum of per-leg energy × carrier intensity computed during route evaluation, '
            + 'using real road distances. Nothing here is apportioned by heuristic.',
        })));
  }

  function attributionCard(a) {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const parts = a.parts.map((p) => ({ ...p, color: ATTRIBUTION_COLORS[p.key] }));
    requestAnimationFrame(() => stackBar(canvas, parts, { height: 26 }));
    return card('Causal attribution', el('span.eyebrow', { text: 'WHY THIS NUMBER' }),
      el('div.stack-sm', null,
        el('div.chart-wrap', null, canvas),
        el('div.chart-legend', null, ...parts.map((p) => el('span', null,
          el('i', { style: { background: p.color } }), `${p.label} ${pct(p.share, 1)}`))),
        el('div.explain', null,
          el('p', { text: a.verdict }),
          el('ul.drivers', null, ...parts.filter((p) => p.key !== 'baseline').map((p) => el('li', { dataset: { sign: '-' } },
            el('span.sign', { text: '•' }),
            el('span', null,
              el('span.d-label', { text: p.label }),
              el('span.d-detail', { text: `${num(p.value, 2)} kg CO₂e · ${pct(p.share, 1)} of the plan` }))))),
          el('p.basis', { text: a.basis }))));
  }

  function gridWindow(plan) {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const best = cleanestHour(6, 22);
    requestAnimationFrame(() => lineChart(canvas, [{
      points: ENERGY.gridIntensity.map((v, h) => ({ x: h, y: v })),
      color: C.green, width: 2, fill: true,
    }], {
      height: 160, xLabel: 'Hour of day', yLabel: 'kg CO₂e / kWh',
      xFormat: (v) => `${String(Math.round(v)).padStart(2, '0')}:00`,
      yFormat: (v) => v.toFixed(2), xDomain: [0, 23],
    }));

    const evRoutes = plan.routes.filter((r) => r.orderIds.length && VEHICLE_TYPES[r.vehicleType]?.energyType === 'bev');
    const evEnergy = evRoutes.reduce((a, r) => a + r.units, 0);
    const evCo2 = evRoutes.reduce((a, r) => a + r.co2, 0);
    const nowIntensity = intensityAt('bev', store.clockMinutes);
    const potential = evEnergy * (nowIntensity - best.intensity);

    return card('Grid carbon window', el('span.eyebrow', { text: 'ENERGY SOURCE' }),
      el('div.stack-sm', null,
        el('div.chart-wrap', null, canvas),
        el('dl.kv', null,
          ...kv('Battery-electric routes', num(evRoutes.length)),
          ...kv('Grid energy drawn', `${num(evEnergy, 1)} kWh`),
          ...kv('Electric CO₂e', fkg(evCo2, 2), 'var(--green)'),
          ...kv('Intensity now', `${num(nowIntensity, 2)} kg/kWh`),
          ...kv('Cleanest hour', `${String(best.hour).padStart(2, '0')}:00 · ${num(best.intensity, 2)} kg/kWh`)),
        evEnergy > 0 ? el('div.explain', null,
          el('p', {
            text: potential > 0.05
              ? `Shifting the ${num(evEnergy, 0)} kWh of electric duty to ${String(best.hour).padStart(2, '0')}:00 `
                + `would avoid an estimated ${fkg(potential, 2)} of CO₂e — the same kilometres, a cleaner electron mix.`
              : 'The electric fleet already draws from a near-cleanest grid window; time-shifting would not materially help.',
          }),
          el('p.basis', {
            text: 'Grid energy × (current intensity − cleanest-hour intensity). '
              + 'Diesel and CNG are time-invariant and excluded. The grid curve is a modelled profile, not a live feed.',
          }))
          : el('p.basis', { text: 'No battery-electric vehicles in the current plan, so grid timing does not apply.' })));
  }

  function intensityCard() {
    const rows = (store.plan?.routes || []).filter((r) => r.orderIds.length).map((r) => {
      const v = store.vehiclesById.get(r.vehicleId);
      const type = VEHICLE_TYPES[r.vehicleType];
      return {
        label: v?.callsign ?? r.id,
        sub: `${type?.label ?? ''} · ${CARRIER_LABEL[type?.energyType] ?? ''}`,
        value: r.km ? r.co2 / r.km : 0,
      };
    }).sort((a, b) => b.value - a.value);

    return card('Fleet carbon intensity', el('span.eyebrow', { text: 'KG CO₂e PER KM' }),
      el('div.stack-sm', null,
        rows.length ? el('div.bar-rows', null, ...rows.map((r) => el('div.bar-row', null,
          el('span.bl', null, r.label, el('small', { text: r.sub })),
          el('span.bt', null, el('i', { style: { width: `${Math.round((r.value / (rows[0].value || 1)) * 100)}%` } })),
          el('span.bv', { text: `${num(r.value, 3)}` })))) : empty('No active routes.'),
        el('div.row.wrap', { style: { marginTop: '8px' } },
          el('button.btn.btn--sm', {
            class: store.layers.emissions ? 'btn--primary' : '',
            type: 'button',
            text: store.layers.emissions ? 'Heatmap on' : 'Show emissions heatmap on the map',
            onclick: () => { store.toggleLayer('emissions', !store.layers.emissions); map.invalidate(); render(); },
          }))));
  }

  on(EV.PLAN_CHANGED, render);
  on(EV.LAYERS_CHANGED, render);
  render();
  return root;
}
