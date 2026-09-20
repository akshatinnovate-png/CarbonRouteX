/**
 * COMMAND CENTRE (left rail)
 *
 * The controls that change what the optimiser is trying to achieve:
 * the OPTIMIZE FLEET action, the multi-objective weights, the presets,
 * search, and the map layer stack.
 */

import { OBJECTIVES, PRESETS, LAYERS, APP } from '../config.js';
import { EV, emit, on } from '../core/bus.js';
import { el, mount, setText, debounce, announce, raf1, focusInto } from '../util/dom.js';
import { num, pct, km as fkm, kg as fkg, money, dur, esc } from '../util/format.js';
import { topObjective } from '../engines/explain.js';
import { icon } from './icons.js';

const PRESET_LABELS = {
  fastest: 'Fastest', cheapest: 'Lowest cost', greenest: 'Lowest carbon', balanced: 'Balanced',
};

export function initCommandCenter(store, map) {
  const host = document.getElementById('command-scroll');

  /* ------------------------------------------------------- optimise */

  const optimizeBtn = el('button.btn-optimize', {
    type: 'button', id: 'optimize-btn',
    onclick: () => runOptimize(),
  }, el('span.obtn-icon', { html: icon('bolt', 15) }), el('span.obtn-label', { text: 'Optimize Fleet' }));

  const progressBar = el('i', { style: { width: '0%' } });
  const progressLabel = el('span', { text: 'Idle' });
  const progressWrap = el('div.stack-sm', { hidden: true },
    el('div.progress-label', null, progressLabel, el('span.mono', { id: 'opt-elapsed', text: '' })),
    el('div.progress', null, progressBar));

  async function runOptimize() {
    if (store.optimizing) return;
    await store.optimizeFleet({ trigger: 'Operator requested optimisation' });
  }

  const optimizePanel = el('div.panel.panel--accent', null,
    el('div.panel-body', null,
      el('div.stack-sm', null,
        optimizeBtn,
        progressWrap,
        el('div.row-between', null,
          el('span.eyebrow', { text: 'Objective' }),
          el('span.chip.chip--green', { id: 'dominant-objective' }, el('i.dot'), 'Balanced')),
        el('div.kv', { id: 'plan-score' })),
    ));

  /* ------------------------------------------------- objectives */

  const sliders = new Map();
  const objectiveRows = OBJECTIVES.map((o) => {
    const value = el('span.val.num', { text: pct(store.weights[o.key] ?? 0, 0) });
    const input = el('input', {
      type: 'range', min: '0', max: '100', step: '1',
      value: String(Math.round((store.weights[o.key] ?? 0) * 100)),
      'aria-label': `${o.label} weight`,
      style: { '--track-color': o.accent },
      oninput: (e) => {
        const v = Number(e.target.value) / 100;
        store.setWeight(o.key, v);
      },
    });
    sliders.set(o.key, { input, value, spec: o });
    return el('div.objective', null,
      el('span.name', { text: o.label, style: { color: o.accent } }),
      input, value);
  });

  const presetRow = el('div.segmented', { role: 'group', 'aria-label': 'Objective presets' },
    ...Object.keys(PRESETS).map((key) => el('button', {
      type: 'button', dataset: { preset: key },
      'aria-pressed': String(store.preset === key),
      text: PRESET_LABELS[key],
      onclick: () => {
        store.applyPreset(key);
        announce(`${PRESET_LABELS[key]} objective preset applied`);
      },
    })),
    el('button', {
      type: 'button', dataset: { preset: 'custom' }, 'aria-pressed': String(store.preset === 'custom'),
      text: 'Custom', title: 'Set automatically when you move a slider',
      onclick: () => { /* custom is a state, not an action */ },
    }));

  const weightsHint = el('p.basis', {
    style: { marginTop: '10px' },
    text: 'Weights are normalised to sum to 1 and feed directly into the router’s edge cost and the plan objective function. Re-run OPTIMIZE FLEET to apply them.',
  });

  const objectivesPanel = el('section.panel', null,
    el('div.panel-head', null, el('h2', { text: 'Optimisation objectives' }),
      el('span.spacer'),
      el('span.eyebrow', { id: 'weights-dirty', text: '' })),
    el('div.panel-body', null,
      presetRow,
      el('div', { style: { marginTop: '10px' } }, ...objectiveRows),
      weightsHint));

  /* ----------------------------------------------------- search */

  const searchInput = el('input', {
    type: 'search', id: 'entity-search', placeholder: 'Search orders, vehicles, districts…',
    'aria-label': 'Search orders, vehicles and districts',
    autocomplete: 'off', spellcheck: 'false',
    style: {
      width: '100%', padding: '7px 9px 7px 28px', background: 'var(--deep)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
      color: 'var(--text)', fontSize: '12px',
    },
  });
  const results = el('div.stack-sm', { id: 'search-results', style: { marginTop: '8px' } });

  const doSearch = debounce(() => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 1) { mount(results); return; }
    const hits = [];
    for (const o of store.orders) {
      if (hits.length >= 24) break;
      if (o.id.toLowerCase().includes(q) || o.consignee.toLowerCase().includes(q)
        || o.district.toLowerCase().includes(q) || o.goods.toLowerCase().includes(q)) {
        hits.push({ kind: 'order', id: o.id, title: o.id, sub: `${o.consignee} · ${o.district}`, x: o.x, y: o.y });
      }
    }
    for (const v of store.vehicles) {
      if (hits.length >= 30) break;
      if (v.id.toLowerCase().includes(q) || v.callsign.toLowerCase().includes(q)
        || v.driver.toLowerCase().includes(q) || v.typeLabel.toLowerCase().includes(q)) {
        hits.push({ kind: 'vehicle', id: v.id, title: v.callsign, sub: `${v.typeLabel} · ${v.driver}`, x: v.x, y: v.y });
      }
    }
    for (const d of store.world.districts) {
      if (hits.length >= 36) break;
      if (d.name.toLowerCase().includes(q)) {
        hits.push({ kind: 'district', id: d.id, title: d.name, sub: d.typeLabel, x: d.x, y: d.y });
      }
    }
    for (const d of store.depots) {
      if (d.name.toLowerCase().includes(q)) {
        hits.push({ kind: 'depot', id: d.id, title: d.name, sub: `Depot · ${d.district}`, x: d.x, y: d.y });
      }
    }

    if (!hits.length) {
      mount(results, el('p.basis', { style: { marginTop: 0 }, text: `Nothing matches “${searchInput.value.trim()}”.` }));
      announce('No matches');
      return;
    }
    mount(results, hits.slice(0, 8).map((h) => el('button.alert', {
      type: 'button',
      onclick: () => {
        store.select(h.kind, h.id, { force: true });
        emit(EV.FOCUS_MAP, { x: h.x, y: h.y, zoom: 3.0 });
      },
    },
    el('span.sev', { style: { background: h.kind === 'vehicle' ? 'var(--cyan)' : h.kind === 'order' ? 'var(--green)' : 'var(--violet)' } }),
    el('span', null, el('span.title', { text: h.title }), el('span.detail', { text: h.sub })),
    el('span.sev-tag', { text: h.kind }))));
    announce(`${hits.length} match${hits.length === 1 ? '' : 'es'}`);
  }, 180);

  searchInput.addEventListener('input', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; mount(results); searchInput.blur(); }
  });

  const searchPanel = el('section.panel', null,
    el('div.panel-head', null, el('h2', { text: 'Find' })),
    el('div.panel-body', null,
      el('div', { style: { position: 'relative' } },
        el('span', {
          html: icon('search', 13),
          style: { position: 'absolute', left: '8px', top: '8px', color: 'var(--faint)', pointerEvents: 'none' },
        }),
        searchInput),
      results));

  /* ----------------------------------------------------- layers */

  const LAYER_SWATCH = {
    roads: 'var(--line-strong)', regions: 'var(--violet)', traffic: 'var(--orange)',
    routes: 'var(--green)', alternates: 'var(--cyan)', vehicles: 'var(--cyan)',
    deliveries: 'var(--green)', warehouses: 'var(--cyan)', emissions: 'var(--red)',
    energy: 'var(--cyan)', risk: 'var(--amber)',
  };

  const layerRows = LAYERS.map((l) => {
    const input = el('input', {
      type: 'checkbox', checked: store.layers[l.key],
      onchange: (e) => {
        store.toggleLayer(l.key, e.target.checked);
        announce(`${l.label} layer ${e.target.checked ? 'on' : 'off'}`);
      },
    });
    return el('label.layer-row', { dataset: { layer: l.key } },
      input,
      el('span.box', { html: icon('check', 9) }),
      el('span.txt', { text: l.label }),
      el('span.swatch', { style: { background: LAYER_SWATCH[l.key] || 'var(--line-strong)' } }));
  });

  const layersPanel = el('section.panel', null,
    el('div.panel-head', null, el('h2', { text: 'Map layers' }), el('span.spacer'),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button', text: 'Reset',
        onclick: () => {
          for (const l of LAYERS) store.toggleLayer(l.key, l.on);
          announce('Layers reset to defaults');
        },
      })),
    el('div.panel-body.tight', null, ...layerRows));

  /* -------------------------------------------------- network card */

  const networkPanel = el('section.panel', null,
    el('div.panel-head', null, el('h2', { text: 'Network' })),
    el('div.panel-body', null, el('dl.kv', { id: 'network-kv' })));

  /* ------------------------------------------------------ mount */

  mount(host, optimizePanel, objectivesPanel, searchPanel, layersPanel, networkPanel);

  /* ------------------------------------------------------ render */

  const refreshSliders = () => {
    for (const [key, s] of sliders) {
      const v = store.weights[key] ?? 0;
      const rounded = Math.round(v * 100);
      if (document.activeElement !== s.input) s.input.value = String(rounded);
      s.input.style.setProperty('--fill', `${rounded}%`);
      setText(s.value, pct(v, 0));
    }
    for (const b of presetRow.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.preset === store.preset));
    }
    const dom = topObjective(store.weights);
    const chip = document.getElementById('dominant-objective');
    if (chip) mount(chip, el('i.dot'), dom.label);
    // Tell the operator the weights no longer match the live plan.
    const dirty = store.plan && JSON.stringify(roundW(store.plan.weights)) !== JSON.stringify(roundW(store.weights));
    setText(document.getElementById('weights-dirty'), dirty ? 'CHANGED — RE-RUN' : '');
    document.getElementById('weights-dirty').style.color = dirty ? 'var(--amber)' : 'var(--faint)';
  };

  const roundW = (w) => Object.fromEntries(Object.entries(w || {}).map(([k, v]) => [k, Math.round(v * 100)]));

  const refreshScore = raf1(() => {
    const kv = document.getElementById('plan-score');
    if (!kv) return;
    const p = store.plan;
    if (!p) { mount(kv); return; }
    const m = p.metrics;
    mount(kv,
      row('Plan', p.label),
      row('Stops planned', `${num(m.stops)} of ${num(m.stops + m.unserved)} open`),
      row('Fleet time', dur(m.minutes)),
      row('Distance', fkm(m.km, 0)),
      row('CO₂e', fkg(m.co2, 1)),
      row('Cost', money(m.cost)),
      m.unserved ? row('Unserved', num(m.unserved), 'var(--red)') : null,
      p.score != null ? el('div.kv-divider') : null,
      p.score != null ? row('Objective score', num(p.score, 3), 'var(--green)') : null);
  });

  const row = (k, v, color) => [
    el('dt', { text: k }),
    el('dd', { text: v, style: color ? { color } : null }),
  ];

  const refreshNetwork = () => {
    const kv = document.getElementById('network-kv');
    if (!kv || !store.worldStats) return;
    const s = store.worldStats;
    mount(kv,
      row('Region', `${num(s.districts)} districts`),
      row('Road links', num(s.edges)),
      row('Junctions', num(s.nodes)),
      row('Road length', fkm(s.totalKm, 0)),
      row('Depots', num(store.depots.length)),
      row('Fleet', num(store.vehicles.length)),
      row('Order book', num(store.orders.length)));
  };

  const refreshProgress = (p) => {
    if (!p) { progressWrap.hidden = true; return; }
    progressWrap.hidden = false;
    const ratio = p.total ? p.done / p.total : 0;
    progressBar.style.width = `${Math.round(ratio * 100)}%`;
    setText(progressLabel,
      p.phase === 'construct' ? `Generating candidate routes · ${p.done}/${p.total}`
        : p.phase === 'anneal' ? `Searching · ${Math.round(ratio * 100)}%`
          : p.phase === 'pareto' ? `Frontier sample ${p.done + 1}/${p.total}`
            : p.message || 'Analysing constraints');
    const el2 = document.getElementById('opt-elapsed');
    if (el2 && p.best != null) setText(el2, `best ${num(p.best, 3)}`);
  };

  /* ------------------------------------------------------ events */

  on(EV.WEIGHTS_CHANGED, refreshSliders);
  on(EV.PLAN_CHANGED, () => { refreshSliders(); refreshScore(); });
  on(EV.LAYERS_CHANGED, () => {
    for (const row2 of layersPanel.querySelectorAll('.layer-row')) {
      const input = row2.querySelector('input');
      input.checked = !!store.layers[row2.dataset.layer];
    }
  });
  on(EV.OPT_START, () => {
    optimizeBtn.disabled = true;
    mount(optimizeBtn.querySelector('.obtn-icon'), el('span.spin', { html: icon('refresh', 15), style: { display: 'block' } }));
    setText(optimizeBtn.querySelector('.obtn-label'), 'Optimising…');
    refreshProgress({ phase: 'analyse', done: 0, total: 1 });
  });
  on(EV.OPT_PROGRESS, refreshProgress);
  on(EV.OPT_DONE, () => {
    optimizeBtn.disabled = false;
    mount(optimizeBtn.querySelector('.obtn-icon'), el('span', { html: icon('bolt', 15), style: { display: 'block' } }));
    setText(optimizeBtn.querySelector('.obtn-label'), 'Optimize Fleet');
    refreshProgress(null);
    refreshSliders();
  });
  on(EV.OPT_FAILED, () => {
    optimizeBtn.disabled = false;
    setText(optimizeBtn.querySelector('.obtn-label'), 'Optimize Fleet');
    refreshProgress(null);
  });

  refreshSliders(); refreshScore(); refreshNetwork();

  return {
    runOptimize,
    focusSearch: () => focusInto(searchInput),
  };
}
