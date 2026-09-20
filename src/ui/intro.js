/**
 * LANDING / INTRO
 *
 * The transition WORLD -> NETWORK -> FLEET -> ROUTES -> OPTIMIZATION -> COMMAND
 * CENTRE is drawn from the *actual* generated world: the same road graph, the
 * same depots, the same fleet and the same baseline routes the command centre
 * is about to show. It is a reveal, not a loading screen — both buttons are
 * live from the first frame and the app is already usable behind it.
 */

import { EV, emit, on } from '../core/bus.js';
import { el, mount, prefersReducedMotion, announce } from '../util/dom.js';
import { clamp, easeOutCubic, easeInOutCubic } from '../util/math.js';
import { Camera } from '../render/camera.js';
import { C, withAlpha, vehicleColor } from '../render/palette.js';

const STEPS = ['World', 'Network', 'Fleet', 'Routes', 'Optimisation', 'Command'];
const STEP_DURATION = 620;

export function initIntro(store, onEnter) {
  const root = document.getElementById('intro');
  const canvas = document.getElementById('intro-canvas');
  const stepsHost = document.getElementById('intro-steps');
  const note = document.getElementById('intro-note');
  const enterBtn = document.getElementById('intro-enter');
  const demoBtn = document.getElementById('intro-demo');
  const ctx = canvas.getContext('2d');
  const camera = new Camera();
  const reduced = prefersReducedMotion();

  let running = true;
  let t0 = performance.now();
  let dismissed = false;

  mount(stepsHost, STEPS.flatMap((s, i) => [
    i ? el('i', { text: '›' }) : null,
    el('span', { dataset: { on: 'false' }, text: s }),
  ]).filter(Boolean));

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    camera.resize(canvas.width, canvas.height);
    if (store.world) camera.calibrate(store.world.bounds, 40 * dpr);
  }
  window.addEventListener('resize', resize);
  // The intro canvas is sized from its laid-out box, which is not final on the
  // first frame. A ResizeObserver is the only reliable signal for that, and
  // without it the backing store can stay sized for a stale layout, leaving a
  // visible seam down the side of the scene.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => resize()).observe(canvas);
  }

  function stageProgress(now) {
    if (reduced) return { stage: STEPS.length - 1, local: 1, elapsed: 1e9 };
    const elapsed = now - t0;
    const raw = elapsed / STEP_DURATION;
    const stage = Math.min(STEPS.length - 1, Math.floor(raw));
    return { stage, local: clamp(raw - stage, 0, 1), elapsed };
  }

  function draw(now) {
    if (!running) return;
    requestAnimationFrame(draw);
    if (!store.world || canvas.clientWidth < 2) return;
    const wantDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(canvas.clientWidth * wantDpr)
      || canvas.height !== Math.round(canvas.clientHeight * wantDpr)) resize();

    const { stage, local } = stageProgress(now);
    const time = (now - t0) / 1000;

    for (let i = 0; i < STEPS.length; i++) {
      const node = stepsHost.querySelectorAll('span')[i];
      if (node) node.dataset.on = String(i <= stage);
    }
    updateBoot(stage, local);

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Slow drift keeps the scene alive without demanding attention.
    if (!reduced) {
      camera.x = Math.sin(time * 0.09) * 3.2;
      camera.y = Math.cos(time * 0.07) * 2.2;
      camera.zoom = 1.04 + Math.sin(time * 0.06) * 0.03;
    }

    const world = store.world;
    const fade = (from, to = 1) => clamp((stage + local - from) / Math.max(to - from, 0.001), 0, 1);

    /* 1. WORLD — terrain, water, districts */
    const worldAlpha = easeOutCubic(fade(0, 0.9));
    if (worldAlpha > 0) {
      ctx.globalAlpha = worldAlpha * 0.8;
      for (const d of world.districts) {
        ctx.beginPath();
        d.polygon.forEach((p, i) => {
          const s = camera.toScreen(p.x, p.y);
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.fillStyle = withAlpha(d.tint, 0.75);
        ctx.fill();
      }
      for (const poly of world.water) {
        ctx.beginPath();
        poly.forEach((p, i) => {
          const s = camera.toScreen(p.x, p.y);
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.fillStyle = C.water; ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* 2. NETWORK — the road graph, drawn on progressively by road class */
    const netAlpha = fade(1, 2);
    if (netAlpha > 0) {
      const classes = [['highway', 0], ['arterial', 0.22], ['collector', 0.45], ['local', 0.68]];
      for (const [cls, start] of classes) {
        const a = easeOutCubic(clamp((netAlpha - start) / 0.32, 0, 1));
        if (a <= 0) continue;
        ctx.beginPath();
        for (const e of world.edges) {
          if (e.cls !== cls) continue;
          const p0 = camera.toScreen(e.pts[0].x, e.pts[0].y);
          ctx.moveTo(p0.x, p0.y);
          for (let i = 1; i < e.pts.length; i++) {
            const p = camera.toScreen(e.pts[i].x, e.pts[i].y);
            ctx.lineTo(p.x, p.y);
          }
        }
        ctx.strokeStyle = withAlpha(C.roadCore[cls], a * (cls === 'highway' ? 1 : cls === 'arterial' ? 0.8 : 0.55));
        ctx.lineWidth = cls === 'highway' ? 2.6 : cls === 'arterial' ? 1.5 : 0.9;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }

    /* 3. FLEET — depots first, then vehicles at their depots */
    const fleetAlpha = easeOutCubic(fade(2, 3));
    if (fleetAlpha > 0 && store.depots) {
      for (const d of store.depots) {
        const p = camera.toScreen(d.x, d.y);
        const r = 7 * fleetAlpha;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 5);
        g.addColorStop(0, withAlpha(C.cyan, 0.3 * fleetAlpha));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = withAlpha(C.cyan, fleetAlpha);
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.45, 0, Math.PI * 2); ctx.fill();
      }
      store.vehicles?.forEach((v, i) => {
        const p = camera.toScreen(v.x, v.y);
        ctx.fillStyle = withAlpha(vehicleColor(i), fleetAlpha);
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2); ctx.fill();
      });
    }

    /* 4. ROUTES — the real baseline plan, drawing itself on */
    const routeAlpha = fade(3, 4.4);
    if (routeAlpha > 0 && store.plan) {
      store.plan.routes.forEach((r, i) => {
        if (!r.polyline.length) return;
        const stagger = clamp((routeAlpha - (i / Math.max(store.plan.routes.length, 1)) * 0.5) / 0.5, 0, 1);
        if (stagger <= 0) return;
        const limit = Math.max(2, Math.floor(r.polyline.length * easeInOutCubic(stagger)));
        ctx.beginPath();
        for (let k = 0; k < limit; k++) {
          const p = camera.toScreen(r.polyline[k].x, r.polyline[k].y);
          if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        const col = vehicleColor(store.vehicles.findIndex((v) => v.id === r.vehicleId));
        ctx.strokeStyle = withAlpha(col, 0.22); ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.stroke();
        ctx.strokeStyle = withAlpha(col, 0.95); ctx.lineWidth = 2.2; ctx.stroke();
      });
    }

    /* 5. OPTIMISATION — delivery nodes resolve into place */
    const optAlpha = easeOutCubic(fade(4, 5));
    if (optAlpha > 0 && store.orders) {
      for (const o of store.orders) {
        const p = camera.toScreen(o.x, o.y);
        ctx.fillStyle = withAlpha(o.priority === 'critical' ? C.red : C.green, optAlpha * 0.9);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill();
      }
      // A sweep line reading the network, drawn once at the optimisation step.
      if (!reduced) {
        const sweep = (time * 0.42) % 1.6;
        if (sweep < 1) {
          const x = sweep * W;
          const g = ctx.createLinearGradient(x - 90, 0, x + 30, 0);
          g.addColorStop(0, 'rgba(62,224,143,0)');
          g.addColorStop(1, `rgba(62,224,143,${0.16 * optAlpha})`);
          ctx.fillStyle = g;
          ctx.fillRect(x - 90, 0, 120, H);
        }
      }
    }

    // Vignette so the copy stays legible over the scene.
    const vg = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(18,28,44,0.40)');
    vg.addColorStop(0.62, 'rgba(14,22,35,0.30)');
    vg.addColorStop(1, 'rgba(11,18,29,0.62)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  /* --------------------------------------------------------------- */
  /* Boot readout                                                     */
  /* --------------------------------------------------------------- */

  const barFill = document.getElementById('intro-bar-fill');
  const phaseEl = document.getElementById('intro-phase');
  const pctEl = document.getElementById('intro-pct');
  const statsHost = document.getElementById('intro-stats');

  const PHASES = [
    'Generating terrain and districts',
    'Building the road graph',
    'Welding network components',
    'Placing depots and fleet',
    'Booking the order book',
    'Costing the baseline plan',
    'Command centre ready',
  ];

  /**
   * The progress bar tracks the animation's own reveal stages, which are
   * themselves gated on the world actually existing. It never reports 100%
   * before the store is ready — a progress bar that lies is worse than none.
   */
  function updateBoot(stage, local) {
    const total = STEPS.length;
    const raw = store.ready ? clamp((stage + local) / total, 0, 1) : 0.12;
    const pctValue = Math.round(raw * 100);
    barFill.style.width = `${pctValue}%`;
    pctEl.textContent = `${pctValue}%`;
    const phaseIndex = store.ready
      ? Math.min(PHASES.length - 1, Math.floor(raw * PHASES.length))
      : 0;
    phaseEl.textContent = PHASES[phaseIndex];
  }

  /** Count a number up so the figures land rather than simply appear. */
  function countUp(node, target, duration = 900) {
    if (reduced) { node.textContent = target.toLocaleString('en-IN'); return; }
    const start = performance.now();
    const step = (now) => {
      const t = clamp((now - start) / duration, 0, 1);
      node.textContent = Math.round(target * easeOutCubic(t)).toLocaleString('en-IN');
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  let statsRendered = false;
  function renderStats() {
    if (statsRendered || !store.ready) return;
    statsRendered = true;
    const s = store.worldStats;
    const rows = [
      ['Junctions', s.nodes],
      ['Road links', s.edges],
      ['Vehicles', store.vehicles.length],
      ['Orders', store.orders.length],
    ];
    mount(statsHost, rows.map(([label, value], i) => {
      const dd = el('dd', { text: '0' });
      const cell = el('div', { style: { animationDelay: `${i * 90}ms` } }, dd, el('dt', { text: label }));
      setTimeout(() => countUp(dd, value), 120 + i * 90);
      return cell;
    }));
  }

  function updateNote() {
    if (!store.ready) { note.textContent = 'Building the network…'; return; }
    renderStats();
    note.innerHTML = 'Deterministic demo world, generated locally from a fixed seed. '
      + 'Every route, emission and telemetry figure is simulated — nothing leaves your browser, '
      + 'and nothing here is a live real-world measurement.';
    enterBtn.disabled = false;
    demoBtn.disabled = false;
  }

  function dismiss(runDemo) {
    if (dismissed) return;
    dismissed = true;
    running = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.getElementById('app').removeAttribute('aria-hidden');
    announce('Command centre ready');
    onEnter?.(runDemo);
  }

  enterBtn.disabled = true;
  demoBtn.disabled = true;
  enterBtn.addEventListener('click', () => dismiss(false));
  demoBtn.addEventListener('click', () => dismiss(true));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(false); });

  on(EV.READY, () => { t0 = performance.now(); updateNote(); resize(); });
  on(EV.PLAN_CHANGED, updateNote);

  resize();
  requestAnimationFrame(draw);
  setTimeout(() => enterBtn.focus(), 60);

  return { dismiss };
}
