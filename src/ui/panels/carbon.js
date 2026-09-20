/**
 * CARBON INTELLIGENCE
 *
 * Where the emissions come from, broken down along whichever dimension the
 * operator wants, plus a causal attribution that separates the unavoidable
 * physics from the part routing can actually change.
 */

import { ENERGY, VEHICLE_TYPES } from '../../config.js';
import { EV, on, emit } from '../../core/bus.js';
import { el, mount, raf1 } from '../../util/dom.js';
import { kg as fkg, km as fkm, money, num, pct } from '../../util/format.js';
import { explainCarbon } from '../../engines/explain.js';
import { cleanestHour, intensityAt, CARRIER_LABEL } from '../../engines/emissions.js';
import { lineChart, stackBar, gauge } from '../charts.js';
import { C, withAlpha } from '../../render/palette.js';
import { panel, empty, kv } from './analytics.js';
import { icon } from '../icons.js';

const DIMENSIONS = [
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'route', label: 'Route' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'region', label: 'Region' },
  { key: 'vehicleType', label: 'Vehicle type' },
  { key: 'energySource', label: 'Energy source' },
  { key: 'distance', label: 'Distance band' },
  { key: 'traffic', label: 'Traffic level' },
];

const ATTRIBUTION_COLORS = {
  baseline: '#2d4a5e', payload: '#3ee08f', congestion: '#ffc861', terrain: '#b78bff',
};

export function carbonPanel(store) {
  const root = el('div.stack');
  let dimension = 'vehicle';

  const render = raf1(() => {
    const plan = store.plan;
    if (!plan) { mount(root, panel('Carbon intelligence', null, empty('No plan yet.'))); return; }

    const groups = store.emissionsBy(dimension);
    const total = plan.metrics.co2;
    const attribution = explainCarbon(plan);

    mount(root,
      el('div.grid-auto', null,
        breakdownCard(groups, total),
        attributionCard(attribution, plan),
        gridTimingCard(store, plan),
        heatmapCard(store)));
  });

  function breakdownCard(groups, total) {
    const max = groups.length ? groups[0].value : 1;
    return panel('Emissions breakdown',
      el('select', {
        'aria-label': 'Break emissions down by',
        style: {
          background: 'var(--deep)', border: '1px solid var(--line)', color: 'var(--text)',
          borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: '11px',
        },
        onchange: (e) => { dimension = e.target.value; render(); },
      }, ...DIMENSIONS.map((d) => el('option', { value: d.key, selected: d.key === dimension, text: d.label }))),
      el('div.stack-sm', null,
        el('div.row-between', null,
          el('span.eyebrow', { text: 'Total planned' }),
          el('span.num', { style: { fontSize: '18px', color: 'var(--green)' }, text: fkg(total, 1) })),
        groups.length ? el('div.bar-rows', { style: { maxHeight: '260px', overflowY: 'auto' } },
          ...groups.slice(0, 14).map((g) => el('div.bar-row', null,
            el('span.bl', null, g.label, g.sub ? el('small', { text: g.sub }) : null),
            el('span.bt', null, el('i', { style: { width: `${Math.round((g.value / max) * 100)}%` } })),
            el('span.bv', { text: `${num(g.value, 2)} kg` })))) : empty('No emissions in this plan.'),
        el('p.basis', {
          text: 'Every figure is the sum of per-link energy × carrier intensity computed during route evaluation. Nothing here is apportioned by heuristic.',
        })));
  }

  function attributionCard(a, plan) {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const parts = a.parts.map((p) => ({ ...p, color: ATTRIBUTION_COLORS[p.key] }));
    requestAnimationFrame(() => stackBar(canvas, parts, { height: 26 }));

    return panel('Causal attribution', el('span.eyebrow', { text: 'WHY THIS NUMBER' }),
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

  function gridTimingCard(store, plan) {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const best = cleanestHour(6, 22);
    requestAnimationFrame(() => {
      lineChart(canvas, [{
        points: ENERGY.gridIntensity.map((v, h) => ({ x: h, y: v })),
        color: C.green, width: 2, fill: true,
      }], {
        height: 150,
        xLabel: 'Hour of day',
        yLabel: 'kg CO₂e / kWh',
        xFormat: (v) => `${String(Math.round(v)).padStart(2, '0')}:00`,
        yFormat: (v) => v.toFixed(2),
        xDomain: [0, 23],
      });
    });

    const evRoutes = (plan.routes || []).filter((r) => r.orderIds.length && VEHICLE_TYPES[r.vehicleType].energyType === 'bev');
    const evEnergy = evRoutes.reduce((a, r) => a + r.units, 0);
    const evCo2 = evRoutes.reduce((a, r) => a + r.co2, 0);
    const nowIntensity = intensityAt('bev', store.clockMinutes);
    const potential = evEnergy * (nowIntensity - best.intensity);

    return panel('Grid carbon window', el('span.eyebrow', { text: 'ENERGY SOURCE' }),
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
              ? `Shifting the ${num(evEnergy, 0)} kWh of electric duty from the current grid window to ${String(best.hour).padStart(2, '0')}:00 would avoid an estimated ${fkg(potential, 2)} of CO₂e — the same kilometres, a cleaner electron mix.`
              : 'The electric fleet is already drawing from a near-cleanest grid window; time-shifting would not materially reduce emissions.',
          }),
          el('p.basis', { text: 'Computed as grid energy × (current intensity − cleanest-hour intensity). Diesel and CNG carriers are time-invariant and excluded.' })) : null));
  }

  function heatmapCard(store) {
    const on = store.layers.emissions;
    return panel('Carbon heatmap', el('span.eyebrow', { text: 'MAP LAYER' }),
      el('div.stack-sm', null,
        el('p', {
          style: { fontSize: '12px', color: 'var(--text-dim)', margin: 0, lineHeight: '1.55' },
          text: 'The heatmap accumulates per-link CO₂e density along every planned route, so the hot cells are the corridors where the fleet actually emits — not simply where it drives most.',
        }),
        el('div.row.wrap', null,
          el('button.btn.btn--sm', {
            type: 'button',
            class: on ? 'btn--primary' : '',
            text: on ? 'Emissions heatmap on' : 'Show emissions heatmap',
            onclick: () => { store.toggleLayer('emissions', !store.layers.emissions); if (store.layers.emissions) store.toggleLayer('energy', false); render(); },
          }),
          el('button.btn.btn--sm', {
            type: 'button',
            class: store.layers.energy ? 'btn--info' : '',
            text: store.layers.energy ? 'Energy heatmap on' : 'Show energy demand',
            onclick: () => { store.toggleLayer('energy', !store.layers.energy); if (store.layers.energy) store.toggleLayer('emissions', false); render(); },
          })),
        el('div.hr'),
        el('span.eyebrow', { text: 'Fleet carbon intensity' }),
        intensityRows(store)));
  }

  function intensityRows(store) {
    const rows = (store.plan?.routes || []).filter((r) => r.orderIds.length).map((r) => {
      const v = store.vehiclesById.get(r.vehicleId);
      const type = VEHICLE_TYPES[r.vehicleType];
      return { label: v?.callsign ?? r.id, sub: `${type.label} · ${CARRIER_LABEL[type.energyType]}`, value: r.km ? r.co2 / r.km : 0 };
    }).sort((a, b) => b.value - a.value);
    if (!rows.length) return empty('No active routes.');
    const max = rows[0].value || 1;
    return el('div.bar-rows', null, ...rows.map((r) => el('div.bar-row', null,
      el('span.bl', null, r.label, el('small', { text: r.sub })),
      el('span.bt', null, el('i', { style: { width: `${Math.round((r.value / max) * 100)}%` } })),
      el('span.bv', { text: `${num(r.value, 3)} kg/km` }))));
  }

  on(EV.PLAN_CHANGED, render);
  on(EV.LAYERS_CHANGED, render);
  render();
  return root;
}
