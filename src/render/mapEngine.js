/**
 * MAP ENGINE
 *
 * Canvas 2D renderer for the whole geospatial scene. Nothing here mutates
 * application state; it reads the store and draws it.
 *
 * Performance strategy:
 *  - Static geography (water, districts, road casing) is rendered once into an
 *    offscreen layer and only re-rendered when the camera settles or the world
 *    changes. During a pan or zoom the cached layer is blitted with a transform,
 *    which is why dragging stays smooth with a thousand road links on screen.
 *  - Dynamic content (routes, vehicles, traffic, selection) is drawn per frame,
 *    batched into as few paths as possible — one stroke per congestion bucket
 *    rather than one per edge.
 *  - Level of detail: local streets and labels disappear when zoomed out, so
 *    the cost of a frame is bounded by what is actually legible.
 *  - Everything animated is driven by a single requestAnimationFrame loop with
 *    a delta-time clock, and the loop idles itself when nothing is moving.
 */

import { LAYERS, RENDER, ROAD_CLASS, VEHICLE_TYPES } from '../config.js';
import { EV, emit, on } from '../core/bus.js';
import { clamp, dist, pointSegmentDistance } from '../util/math.js';
import { prefersReducedMotion } from '../util/dom.js';
import { Camera } from './camera.js';
import { C, congestionColor, withAlpha, PRIORITY_COLOR, STATUS_COLOR, vehicleColor } from './palette.js';

/** Fractional part wrapped into 0..1, unlike `%` which preserves sign. */
const frac = (v) => v - Math.floor(v);

export class MapEngine {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.store = store;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.camera = new Camera();
    this.dpr = 1;
    this.running = false;
    this.time = 0;
    this.lastFrame = 0;
    this.fps = 60;
    this.frameTimes = [];
    this.quality = 1;              // adaptive: drops to 0.6 if frames get slow
    this.reducedMotion = prefersReducedMotion();
    this.camera.reducedMotion = this.reducedMotion;

    this.staticLayer = document.createElement('canvas');
    this.staticCtx = this.staticLayer.getContext('2d');
    this.staticKey = null;
    this.staticView = null;

    this.heatLayer = document.createElement('canvas');
    this.heatCtx = this.heatLayer.getContext('2d');
    this.heatKey = null;

    this.pointer = { x: 0, y: 0, inside: false, down: false, dragged: false };
    this.hovered = null;
    this.pulse = new Map();        // entity key -> pulse start time
    this.routeReveal = 0;          // 0..1 animation when a plan lands

    this.bindEvents();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.frame(now);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, RENDER.maxDpr) * this.quality;
    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.staticLayer.width = w; this.staticLayer.height = h;
      this.staticKey = null;
    }
    this.cssWidth = rect.width; this.cssHeight = rect.height;
    this.camera.resize(w, h);
    if (!this.calibrated && this.store.world) {
      this.camera.calibrate(this.store.world.bounds, 60 * this.dpr);
      this.camera.setWorldBounds(this.store.world.bounds);
      this.calibrated = true;
    }
    this.staticKey = null;
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  bindEvents() {
    const cv = this.canvas;
    let lastPointer = null;
    const pointers = new Map();
    let pinchDist = 0;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pointer.down = true;
      this.pointer.dragged = false;
      lastPointer = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const rect = cv.getBoundingClientRect();
      this.pointer.x = (e.clientX - rect.left) * this.dpr;
      this.pointer.y = (e.clientY - rect.top) * this.dpr;
      this.pointer.inside = true;

      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          const midX = ((a.x + b.x) / 2 - rect.left) * this.dpr;
          const midY = ((a.y + b.y) / 2 - rect.top) * this.dpr;
          this.camera.zoomAt(midX, midY, d / pinchDist);
          this.staticKey = null;
        }
        pinchDist = d;
        this.pointer.dragged = true;
        return;
      }

      if (this.pointer.down && lastPointer) {
        const dx = (e.clientX - lastPointer.x) * this.dpr;
        const dy = (e.clientY - lastPointer.y) * this.dpr;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.pointer.dragged = true;
        this.camera.panBy(dx, dy);
        this.staticKey = null;
        lastPointer = { x: e.clientX, y: e.clientY };
        cv.style.cursor = 'grabbing';
      } else {
        const hit = this.hitTest(this.pointer.x, this.pointer.y);
        const key = hit ? `${hit.kind}:${hit.id}` : null;
        if (key !== this.hoveredKey) {
          this.hoveredKey = key;
          this.hovered = hit;
          this.store.setHover(hit?.kind ?? null, hit?.id ?? null);
          cv.style.cursor = hit ? 'pointer' : 'grab';
        }
      }
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) {
        this.pointer.down = false;
        lastPointer = null;
        cv.style.cursor = this.hovered ? 'pointer' : 'grab';
      }
    };
    cv.addEventListener('pointerup', (e) => {
      if (!this.pointer.dragged && pointers.size === 1) {
        const hit = this.hitTest(this.pointer.x, this.pointer.y);
        if (hit) this.select(hit);
        else this.store.clearSelection();
      }
      endPointer(e);
    });
    cv.addEventListener('pointercancel', endPointer);
    cv.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.hovered = null; this.hoveredKey = null;
      this.store.setHover(null, null);
    });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * this.dpr;
      const sy = (e.clientY - rect.top) * this.dpr;
      // Normalise across deltaMode (lines vs pixels) so trackpads and wheels
      // feel the same rather than one being 30x the other.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0016);
      this.camera.zoomAt(sx, sy, factor);
      this.staticKey = null;
    }, { passive: false });

    cv.addEventListener('dblclick', (e) => {
      const rect = cv.getBoundingClientRect();
      this.camera.zoomAt((e.clientX - rect.left) * this.dpr, (e.clientY - rect.top) * this.dpr, 1.8);
      this.staticKey = null;
    });

    on(EV.PLAN_CHANGED, () => {
      this.routeReveal = this.reducedMotion ? 1 : 0;
      this.staticKey = null;
      this.heatKey = null;
    });
    on(EV.LAYERS_CHANGED, () => { this.staticKey = null; this.heatKey = null; });
    on(EV.FOCUS_MAP, (payload) => this.focus(payload));
    on(EV.SELECT, () => { this.heatKey = null; });

    window.addEventListener('resize', () => this.resize());
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener?.('change', () => {
      this.reducedMotion = mq.matches;
      this.camera.reducedMotion = this.reducedMotion;
    });
  }

  select(hit) {
    this.pulse.set(`${hit.kind}:${hit.id}`, this.time);
    this.store.select(hit.kind, hit.id);
  }

  focus(payload = {}) {
    if (payload.points) this.camera.fitPoints(payload.points, (payload.padding ?? 110) * this.dpr, payload.duration);
    else if (payload.bounds) this.camera.fitBounds(payload.bounds, (payload.padding ?? 110) * this.dpr, payload.duration);
    else if (payload.x != null) this.camera.flyTo(payload.x, payload.y, payload.zoom, payload.duration);
    this.staticKey = null;
  }

  fitWorld() {
    this.camera.fitBounds(this.store.world.bounds, 60 * this.dpr);
    this.staticKey = null;
  }

  fitFleet() {
    const pts = this.store.vehicles.filter((v) => v.available).map((v) => ({ x: v.x, y: v.y }));
    for (const d of this.store.depots) pts.push({ x: d.x, y: d.y });
    this.camera.fitPoints(pts, 140 * this.dpr);
    this.staticKey = null;
  }

  fitRoutes() {
    const pts = [];
    for (const r of this.store.plan?.routes || []) {
      for (let i = 0; i < r.polyline.length; i += 4) pts.push(r.polyline[i]);
    }
    if (pts.length) this.camera.fitPoints(pts, 120 * this.dpr);
    else this.fitWorld();
    this.staticKey = null;
  }

  zoomBy(factor) {
    this.camera.zoomAt(this.canvas.width / 2, this.canvas.height / 2, factor);
    this.staticKey = null;
  }

  /* ---------------------------------------------------------------- */
  /* Hit testing                                                       */
  /* ---------------------------------------------------------------- */

  hitTest(sx, sy) {
    const { store } = this;
    if (!store.ready) return null;
    const cam = this.camera;
    const w = cam.toWorld(sx, sy);
    const tolKm = (16 * this.dpr) / cam.scale;

    // Vehicles first — they are the smallest and the most often wanted.
    if (this.layerOn('vehicles')) {
      let best = null, bestD = tolKm;
      for (const v of store.vehicles) {
        const d = dist(v.x, v.y, w.x, w.y);
        if (d < bestD) { bestD = d; best = v; }
      }
      if (best) return { kind: 'vehicle', id: best.id };
    }
    if (this.layerOn('deliveries')) {
      let best = null, bestD = tolKm;
      for (const o of store.orders) {
        const d = dist(o.x, o.y, w.x, w.y);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best) return { kind: 'order', id: best.id };
    }
    if (this.layerOn('warehouses')) {
      for (const dp of store.depots) {
        if (dist(dp.x, dp.y, w.x, w.y) < tolKm * 1.2) return { kind: 'depot', id: dp.id };
      }
    }
    if (this.layerOn('routes') && store.plan) {
      let best = null, bestD = tolKm * 0.8;
      for (const r of store.plan.routes) {
        if (!r.polyline.length) continue;
        for (let i = 1; i < r.polyline.length; i++) {
          const a = r.polyline[i - 1], b = r.polyline[i];
          const d = pointSegmentDistance(w.x, w.y, a.x, a.y, b.x, b.y);
          if (d < bestD) { bestD = d; best = r; }
        }
      }
      if (best) return { kind: 'route', id: best.id };
    }
    // Districts are the fallback so a click always lands on something nameable.
    for (const d of store.world.districts) {
      if (dist(d.x, d.y, w.x, w.y) < d.radiusKm * 0.55) return { kind: 'district', id: d.id };
    }
    return null;
  }

  layerOn(key) { return !!this.store.layers[key]; }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  frame(now) {
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.time += dt;

    // Adaptive quality: if we are consistently missing frames, render fewer
    // device pixels rather than dropping features the user asked for.
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) {
      this.frameTimes.shift();
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.fps = 1 / Math.max(avg, 1e-6);
      if (this.fps < 34 && this.quality > 0.62) { this.quality = 0.62; this.resize(); this.frameTimes.length = 0; }
      else if (this.fps > 56 && this.quality < 1 && this.frameTimes.length === 60) { this.quality = 1; this.resize(); this.frameTimes.length = 0; }
    }

    const moving = this.camera.update(now);
    if (moving) this.staticKey = null;
    if (this.routeReveal < 1) this.routeReveal = Math.min(1, this.routeReveal + dt * 0.9);

    this.store.tick(dt);
    this.draw();
  }

  draw() {
    const { ctx, canvas, store } = this;
    if (!store.ready) return;
    const W = canvas.width, H = canvas.height;

    this.drawStatic();
    ctx.drawImage(this.staticLayer, 0, 0);

    if (this.layerOn('emissions') || this.layerOn('energy')) this.drawHeatmap();
    if (this.layerOn('traffic')) this.drawTraffic();
    if (this.layerOn('risk')) this.drawRisk();
    if (this.layerOn('alternates')) this.drawAlternates();
    if (this.layerOn('routes')) this.drawRoutes();
    if (this.layerOn('warehouses')) this.drawDepots();
    if (this.layerOn('deliveries')) this.drawOrders();
    if (this.layerOn('vehicles')) this.drawVehicles();
    this.drawSelection();
    this.drawScaleBar();
  }

  /* ---- static geography ------------------------------------------ */

  drawStatic() {
    const cam = this.camera;
    const key = `${cam.x.toFixed(3)}|${cam.y.toFixed(3)}|${cam.zoom.toFixed(4)}|${this.canvas.width}|${this.layersKey()}`;
    if (key === this.staticKey) return;
    this.staticKey = key;

    const ctx = this.staticCtx;
    const W = this.staticLayer.width, H = this.staticLayer.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // Background: a deep radial so the eye is drawn to the network core.
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, '#1a273a');
    g.addColorStop(0.55, '#141f30');
    g.addColorStop(1, '#0f1826');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    this.drawGraticule(ctx);
    if (this.layerOn('regions')) this.drawRegions(ctx);
    this.drawWater(ctx);
    if (this.layerOn('roads')) this.drawRoads(ctx);
    ctx.restore();
  }

  layersKey() {
    return LAYERS.map((l) => (this.store.layers[l.key] ? '1' : '0')).join('');
  }

  drawGraticule(ctx) {
    const cam = this.camera;
    const vb = cam.viewBounds();
    // Grid spacing in km chosen so lines stay ~90px apart at any zoom.
    const targetPx = 90 * this.dpr;
    const raw = targetPx / cam.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(122,206,255,0.055)';
    ctx.beginPath();
    for (let x = Math.ceil(vb.minX / step) * step; x <= vb.maxX; x += step) {
      const p = cam.toScreen(x, 0);
      ctx.moveTo(Math.round(p.x) + 0.5, 0); ctx.lineTo(Math.round(p.x) + 0.5, this.staticLayer.height);
    }
    for (let y = Math.ceil(vb.minY / step) * step; y <= vb.maxY; y += step) {
      const p = cam.toScreen(0, y);
      ctx.moveTo(0, Math.round(p.y) + 0.5); ctx.lineTo(this.staticLayer.width, Math.round(p.y) + 0.5);
    }
    ctx.stroke();
    this.gridStepKm = step;
  }

  drawRegions(ctx) {
    const cam = this.camera;
    for (const d of this.store.world.districts) {
      ctx.beginPath();
      const poly = d.polygon;
      for (let i = 0; i < poly.length; i++) {
        const p = cam.toScreen(poly[i].x, poly[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = withAlpha(d.tint, d.type === 'green' ? 0.34 : 0.22);
      ctx.fill();
      ctx.strokeStyle = withAlpha(d.type === 'green' ? C.green : C.cyan, 0.09);
      ctx.lineWidth = 1 * this.dpr;
      ctx.stroke();
    }
    // District labels only once there is room for them.
    if (cam.scale > 9 * this.dpr) {
      ctx.font = `${10 * this.dpr}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      for (const d of this.store.world.districts) {
        const p = cam.toScreen(d.x, d.y);
        ctx.fillStyle = withAlpha(C.muted, 0.3);
        ctx.fillText(d.name.toUpperCase(), p.x, p.y);
      }
    }
  }

  drawWater(ctx) {
    const cam = this.camera;
    const world = this.store.world;
    for (const poly of world.water) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const p = cam.toScreen(poly[i].x, poly[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = C.water;
      ctx.fill();
      ctx.strokeStyle = withAlpha(C.cyan, 0.12);
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.stroke();
    }
    // The river reads as a soft band rather than a hard shape.
    ctx.beginPath();
    for (let i = 0; i < world.riverSpine.length; i++) {
      const p = cam.toScreen(world.riverSpine[i].x, world.riverSpine[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = withAlpha(C.waterEdge, 0.85);
    ctx.lineWidth = Math.max(2, 0.55 * cam.scale) * 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
  }

  drawRoads(ctx) {
    const cam = this.camera;
    const world = this.store.world;
    const vb = cam.viewBounds(2);
    const scale = cam.scale;
    // Level of detail: below these scales the class is not legible anyway.
    const minScale = { highway: 0, arterial: 0, collector: 3.2 * this.dpr, local: 7.5 * this.dpr };

    const order = ['local', 'collector', 'arterial', 'highway'];
    // Two passes per class: a dark casing, then a lighter core. That is what
    // makes a flat vector network read as physical roads. Local streets get no
    // core pass — at their width the two strokes would cancel into mush.
    for (const pass of ['casing', 'core']) {
      for (const cls of order) {
        if (scale < minScale[cls]) continue;
        if (pass === 'core' && cls === 'local') continue;
        const spec = ROAD_CLASS[cls];
        const widthKm = spec.width * 0.09;
        // Roads are drawn at true ground width, but clamped: past a point a
        // wider ribbon carries no more information and swamps everything else.
        const maxPx = (cls === 'highway' ? 22 : cls === 'arterial' ? 14 : 9) * this.dpr;
        const px = clamp(widthKm * scale * (pass === 'casing' ? 1 : 0.5),
          pass === 'casing' ? 1.2 : 0.5, pass === 'casing' ? maxPx : maxPx * 0.55);
        ctx.beginPath();
        let drawn = 0;
        for (const e of world.edges) {
          if (e.cls !== cls) continue;
          if (e.mid.x < vb.minX || e.mid.x > vb.maxX || e.mid.y < vb.minY || e.mid.y > vb.maxY) continue;
          const pts = e.pts;
          const p0 = cam.toScreen(pts[0].x, pts[0].y);
          ctx.moveTo(p0.x, p0.y);
          for (let i = 1; i < pts.length; i++) {
            const p = cam.toScreen(pts[i].x, pts[i].y);
            ctx.lineTo(p.x, p.y);
          }
          drawn++;
        }
        if (!drawn) continue;
        ctx.strokeStyle = pass === 'casing' ? C.road[cls] : C.roadCore[cls];
        ctx.lineWidth = px;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }
  }

  /* ---- traffic ---------------------------------------------------- */

  drawTraffic() {
    const { ctx, camera: cam, store } = this;
    const vb = cam.viewBounds(2);
    const scale = cam.scale;
    // Bucket by congestion band so the whole field is five strokes, not 800.
    const buckets = [[], [], [], [], []];
    for (let i = 0; i < store.world.edges.length; i++) {
      const e = store.world.edges[i];
      // Congestion only means something on through-roads; painting it on
      // every residential stub turns the map into red noise.
      if (e.cls === 'local') continue;
      if (e.mid.x < vb.minX || e.mid.x > vb.maxX || e.mid.y < vb.minY || e.mid.y > vb.maxY) continue;
      const c = store.traffic.congestion[i];
      if (e.closed) continue;
      if (c < 0.62) continue;                 // free flow needs no ink
      const b = c < 0.92 ? 2 : c < 1.35 ? 3 : 4;
      buckets[b].push(e);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let b = 2; b < 5; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      ctx.beginPath();
      for (const e of list) {
        const p0 = cam.toScreen(e.pts[0].x, e.pts[0].y);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < e.pts.length; i++) {
          const p = cam.toScreen(e.pts[i].x, e.pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
      }
      const c = [0, 0, 0.8, 1.15, 1.7][b];
      ctx.strokeStyle = withAlpha(congestionColor(c), b === 4 ? 0.52 : b === 3 ? 0.38 : 0.26);
      ctx.lineWidth = clamp(ROAD_CLASS.arterial.width * 0.09 * scale * 0.7, 1.6, 11 * this.dpr);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();

    // Closed links get an unmistakable treatment — this is a hard constraint.
    const closed = [...store.traffic.closures];
    if (closed.length) {
      ctx.save();
      ctx.strokeStyle = C.red;
      ctx.lineWidth = Math.max(2, 2.6 * this.dpr);
      ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
      ctx.beginPath();
      for (const id of closed) {
        const e = store.world.edges[id];
        const p0 = cam.toScreen(e.pts[0].x, e.pts[0].y);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < e.pts.length; i++) {
          const p = cam.toScreen(e.pts[i].x, e.pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // Incident zones.
    for (const inc of store.traffic.incidents) {
      const p = cam.toScreen(inc.x, inc.y);
      const r = inc.radiusKm * cam.scale;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, withAlpha(C.red, 0.22));
      g.addColorStop(0.6, withAlpha(C.orange, 0.10));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.2);
      ctx.strokeStyle = withAlpha(C.red, 0.18 + pulse * 0.22);
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * (0.65 + pulse * 0.33), 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawRisk() {
    const { ctx, camera: cam, store } = this;
    if (!store.plan) return;
    for (const r of store.plan.routes) {
      for (const v of r.violations) {
        const stop = r.stops[0];
        if (!stop) continue;
        const p = cam.toScreen(stop.x, stop.y);
        ctx.strokeStyle = v.severity === 'hard' ? C.red : C.amber;
        ctx.lineWidth = 1.4 * this.dpr;
        ctx.setLineDash([3 * this.dpr, 3 * this.dpr]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 16 * this.dpr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (const o of store.orders) {
      if (o.status !== 'unserved' && !(o.plannedLate > 0)) continue;
      const p = cam.toScreen(o.x, o.y);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3 + o.x);
      ctx.strokeStyle = withAlpha(o.status === 'unserved' ? C.red : C.orange, 0.35 + pulse * 0.4);
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath(); ctx.arc(p.x, p.y, (10 + pulse * 8) * this.dpr, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* ---- heatmap ---------------------------------------------------- */

  /**
   * Emissions / energy density, accumulated along route polylines into a
   * low-resolution offscreen buffer and blurred by upscaling. Recomputed only
   * when the plan or the camera changes, never per frame.
   */
  drawHeatmap() {
    const cam = this.camera;
    const mode = this.layerOn('emissions') ? 'emissions' : 'energy';
    const key = `${mode}|${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.zoom.toFixed(3)}|${this.store.plan?.id}|${this.canvas.width}`;
    if (key !== this.heatKey) {
      this.heatKey = key;
      const DS = 6; // downsample factor
      const w = Math.max(2, Math.ceil(this.canvas.width / DS));
      const h = Math.max(2, Math.ceil(this.canvas.height / DS));
      this.heatLayer.width = w; this.heatLayer.height = h;
      const hctx = this.heatCtx;
      hctx.clearRect(0, 0, w, h);
      hctx.globalCompositeOperation = 'lighter';

      const routes = this.store.plan?.routes || [];
      let peak = 1e-9;
      const blobs = [];
      for (const r of routes) {
        if (!r.legs?.length) continue;
        for (const leg of r.legs) {
          for (const l of leg.legs || []) {
            const e = this.store.world.edges[l.edgeId];
            const value = mode === 'emissions' ? l.co2 : l.units;
            const density = value / Math.max(e.lengthKm, 0.05);
            if (density > peak) peak = density;
            blobs.push({ x: e.mid.x, y: e.mid.y, v: density });
          }
        }
      }
      const radius = Math.max(6, 1.6 * cam.scale / DS);
      for (const b of blobs) {
        const p = cam.toScreen(b.x, b.y);
        const sx = p.x / DS, sy = p.y / DS;
        if (sx < -radius || sy < -radius || sx > w + radius || sy > h + radius) continue;
        const a = clamp(b.v / peak, 0, 1) ** 0.65;
        const g = hctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
        g.addColorStop(0, `rgba(255,255,255,${0.42 * a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        hctx.fillStyle = g;
        hctx.beginPath(); hctx.arc(sx, sy, radius, 0, Math.PI * 2); hctx.fill();
      }
      // Recolour the accumulated luminance through a perceptual ramp.
      const img = hctx.getImageData(0, 0, w, h);
      const d = img.data;
      const ramp = mode === 'emissions'
        ? [[10, 24, 20], [24, 120, 84], [220, 196, 90], [232, 118, 58], [226, 62, 84]]
        : [[8, 20, 32], [30, 92, 150], [90, 170, 220], [180, 214, 246], [236, 246, 255]];
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        if (a <= 0.004) { d[i + 3] = 0; continue; }
        const t = clamp(a * 1.35, 0, 1) * (ramp.length - 1);
        const i0 = Math.floor(t), i1 = Math.min(ramp.length - 1, i0 + 1), f = t - i0;
        d[i] = ramp[i0][0] + (ramp[i1][0] - ramp[i0][0]) * f;
        d[i + 1] = ramp[i0][1] + (ramp[i1][1] - ramp[i0][1]) * f;
        d[i + 2] = ramp[i0][2] + (ramp[i1][2] - ramp[i0][2]) * f;
        d[i + 3] = Math.min(255, a * 420);
      }
      hctx.putImageData(img, 0, 0);
      hctx.globalCompositeOperation = 'source-over';
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.82;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.heatLayer, 0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  /* ---- routes ----------------------------------------------------- */

  routeState(route) {
    const store = this.store;
    if (!route.orderIds.length) return 'delivered';
    if (route.violations.some((v) => v.severity === 'hard')) return 'high_emission';
    if (route.worstCongestion > 1.2) return 'congested';
    const allDelivered = route.stops.every((s) => store.ordersById.get(s.orderId)?.status === 'delivered');
    if (allDelivered) return 'delivered';
    return store.plan?.meta?.baseline ? 'active' : 'optimized';
  }

  drawRoutes() {
    const { ctx, camera: cam, store } = this;
    if (!store.plan) return;
    const sel = store.selection;
    const hoverKey = store.hover;

    const routes = store.plan.routes.filter((r) => r.polyline.length > 1);
    // Draw unselected first so the selected route always sits on top.
    const isFocused = (r) =>
      (sel.kind === 'route' && sel.id === r.id)
      || (sel.kind === 'vehicle' && sel.id === r.vehicleId)
      || (sel.kind === 'order' && r.orderIds.includes(sel.id));
    const anyFocus = routes.some(isFocused);

    for (const pass of [0, 1]) {
      for (const r of routes) {
        const focused = isFocused(r);
        if ((pass === 0) === focused) continue;
        this.drawRoute(r, { focused, dimmed: anyFocus && !focused, hovered: hoverKey.kind === 'route' && hoverKey.id === r.id });
      }
    }
  }

  drawRoute(route, { focused, dimmed, hovered }) {
    const { ctx, camera: cam, store } = this;
    const idx = store.vehicles.findIndex((v) => v.id === route.vehicleId);
    const color = focused ? '#ffffff' : vehicleColor(idx < 0 ? 0 : idx);
    const state = this.routeState(route);
    const poly = route.polyline;

    // Reveal animation: the plan draws itself on when a new one lands.
    const revealTo = this.reducedMotion ? poly.length : Math.max(2, Math.floor(poly.length * this.routeReveal));

    const baseWidth = clamp(0.075 * cam.scale, 1.4, 6 * this.dpr);
    const alpha = dimmed ? 0.16 : focused ? 1 : hovered ? 0.92 : 0.66;

    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Glow underlay gives routes presence without a blur filter.
    if (!dimmed) {
      ctx.beginPath();
      this.tracePolyline(ctx, poly, revealTo);
      ctx.strokeStyle = withAlpha(color, focused ? 0.22 : 0.10);
      ctx.lineWidth = baseWidth * (focused ? 7 : 4.5);
      ctx.stroke();
    }

    ctx.beginPath();
    this.tracePolyline(ctx, poly, revealTo);
    ctx.strokeStyle = withAlpha(color, alpha);
    ctx.lineWidth = baseWidth * (focused ? 2.3 : 1.5);
    ctx.stroke();

    // Animated flow: dashes travelling in the direction of travel. This is the
    // one place motion carries information — which way the freight is going.
    if (!dimmed && !this.reducedMotion && state !== 'delivered') {
      ctx.beginPath();
      this.tracePolyline(ctx, poly, revealTo);
      const dash = Math.max(5, 0.5 * cam.scale);
      ctx.setLineDash([dash * 0.42, dash * 1.9]);
      ctx.lineDashOffset = -(this.time * cam.scale * RENDER.flowSpeed * 14) % (dash * 2.32);
      ctx.strokeStyle = withAlpha(state === 'congested' ? C.orange : state === 'high_emission' ? C.red : '#ffffff', focused ? 0.9 : 0.5);
      ctx.lineWidth = baseWidth * (focused ? 1.1 : 0.8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  tracePolyline(ctx, poly, limit = poly.length) {
    const cam = this.camera;
    const vb = cam.viewBounds(4);
    // Decimate when zoomed out: at low scale, adjacent vertices are sub-pixel.
    const step = cam.scale < 6 * this.dpr ? 2 : 1;
    let started = false;
    for (let i = 0; i < Math.min(limit, poly.length); i += step) {
      const q = poly[i];
      const p = cam.toScreen(q.x, q.y);
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    if (limit >= poly.length && poly.length) {
      const last = poly[poly.length - 1];
      const p = cam.toScreen(last.x, last.y);
      ctx.lineTo(p.x, p.y);
    }
  }

  drawAlternates() {
    const { ctx, store } = this;
    const sel = store.selection;
    if (sel.kind !== 'order') return;
    const options = store.routeOptionsFor(sel.id);
    ctx.save();
    ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
    const colors = [C.cyan, C.green, C.amber, C.violet];
    options.forEach((opt, i) => {
      ctx.beginPath();
      this.tracePolyline(ctx, opt.path.polyline);
      ctx.strokeStyle = withAlpha(colors[i % colors.length], 0.55);
      ctx.lineWidth = clamp(0.05 * this.camera.scale, 1.2, 4 * this.dpr);
      ctx.stroke();
    });
    ctx.restore();
  }

  /* ---- entities --------------------------------------------------- */

  drawDepots() {
    const { ctx, camera: cam, store } = this;
    const r = Math.max(6, 0.36 * cam.scale) * this.dpr * 0.6;
    for (const d of store.depots) {
      const p = cam.toScreen(d.x, d.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 3);
      g.addColorStop(0, withAlpha(C.cyan, 0.26));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r * 3, 0, Math.PI * 2); ctx.fill();

      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = C.ink;
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = 1.8 * this.dpr;
      ctx.beginPath(); ctx.rect(-r, -r, r * 2, r * 2); ctx.fill(); ctx.stroke();
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = C.cyan;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2); ctx.fill();

      if (cam.scale > 7 * this.dpr) {
        ctx.font = `600 ${10 * this.dpr}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = withAlpha(C.text, 0.8);
        ctx.fillText(d.name.toUpperCase(), 0, r * 2.6);
      }
      ctx.restore();
    }
  }

  drawOrders() {
    const { ctx, camera: cam, store } = this;
    const sel = store.selection;
    const scale = cam.scale;
    const r = clamp(0.14 * scale, 3.2, 9) * this.dpr * 0.75;
    const showLabels = scale > 16 * this.dpr;

    for (const o of store.orders) {
      const p = cam.toScreen(o.x, o.y);
      if (p.x < -30 || p.y < -30 || p.x > this.canvas.width + 30 || p.y > this.canvas.height + 30) continue;
      const delivered = o.status === 'delivered';
      const unserved = o.status === 'unserved';
      const selected = sel.kind === 'order' && sel.id === o.id;
      const color = unserved ? C.red : delivered ? C.greenDim : PRIORITY_COLOR[o.priority] || C.cyan;

      ctx.save();
      if (selected || (store.hover.kind === 'order' && store.hover.id === o.id)) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.1, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(color, 0.16); ctx.fill();
      }
      if (o.priority === 'critical' && !delivered && !this.reducedMotion) {
        // `%` keeps the sign of its left operand and world x can be negative,
        // so the phase offset must be wrapped into 0..1 explicitly.
        const pulse = frac(this.time * 1.4 + o.x * 0.1);
        ctx.beginPath(); ctx.arc(p.x, p.y, r * (1 + pulse * 2.4), 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(C.red, 0.34 * (1 - pulse));
        ctx.lineWidth = 1.5 * this.dpr; ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = delivered ? withAlpha(C.green, 0.22) : withAlpha(color, 0.9);
      ctx.fill();
      ctx.strokeStyle = delivered ? withAlpha(C.green, 0.5) : withAlpha('#06090e', 0.9);
      ctx.lineWidth = 1.2 * this.dpr;
      ctx.stroke();

      if (delivered) {
        // A tick, drawn at scale, is instantly readable at a glance.
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 1.6 * this.dpr;
        ctx.beginPath();
        ctx.moveTo(p.x - r * 0.5, p.y);
        ctx.lineTo(p.x - r * 0.1, p.y + r * 0.42);
        ctx.lineTo(p.x + r * 0.55, p.y - r * 0.45);
        ctx.stroke();
      }

      if (showLabels || selected) {
        ctx.font = `${9.5 * this.dpr}px ui-monospace, monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = withAlpha(C.text, selected ? 0.95 : 0.62);
        ctx.fillText(o.id, p.x + r * 1.8, p.y + 3 * this.dpr);
      }
      ctx.restore();
    }
  }

  drawVehicles() {
    const { ctx, camera: cam, store } = this;
    const sel = store.selection;
    const size = clamp(0.26 * cam.scale, 6, 20) * this.dpr * 0.72;

    store.vehicles.forEach((v, idx) => {
      const p = cam.toScreen(v.x, v.y);
      const selected = sel.kind === 'vehicle' && sel.id === v.id;
      const hovered = store.hover.kind === 'vehicle' && store.hover.id === v.id;
      const color = v.available ? vehicleColor(idx) : C.red;
      const statusColor = STATUS_COLOR[v.status] || C.faint;

      ctx.save();
      // Halo scaled by status so exceptions read across the whole map.
      const haloR = size * (selected ? 4.2 : 2.8);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
      g.addColorStop(0, withAlpha(statusColor, selected ? 0.34 : 0.16));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2); ctx.fill();

      if ((v.status === 'delayed' || !v.available) && !this.reducedMotion) {
        const pulse = frac(this.time * 1.1 + idx * 0.3);
        ctx.beginPath(); ctx.arc(p.x, p.y, size * (1.4 + pulse * 2.6), 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(C.red, 0.4 * (1 - pulse));
        ctx.lineWidth = 1.6 * this.dpr; ctx.stroke();
      }

      ctx.translate(p.x, p.y);
      ctx.rotate(v.heading || 0);
      // A chevron: direction is legible even at 8 pixels.
      ctx.beginPath();
      ctx.moveTo(size * 1.15, 0);
      ctx.lineTo(-size * 0.75, size * 0.78);
      ctx.lineTo(-size * 0.34, 0);
      ctx.lineTo(-size * 0.75, -size * 0.78);
      ctx.closePath();
      ctx.fillStyle = v.available ? color : withAlpha(C.red, 0.7);
      ctx.fill();
      ctx.strokeStyle = selected ? '#ffffff' : withAlpha('#04070b', 0.85);
      ctx.lineWidth = (selected ? 2 : 1.1) * this.dpr;
      ctx.stroke();
      ctx.rotate(-(v.heading || 0));

      if (cam.scale > 9 * this.dpr || selected || hovered) {
        ctx.font = `600 ${9.5 * this.dpr}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = withAlpha('#04070b', 0.72);
        const label = v.id;
        const tw = ctx.measureText(label).width;
        ctx.fillRect(-tw / 2 - 3 * this.dpr, -size * 2.6, tw + 6 * this.dpr, 12 * this.dpr);
        ctx.fillStyle = withAlpha(C.text, 0.92);
        ctx.fillText(label, 0, -size * 2.6 + 9 * this.dpr);
      }
      ctx.restore();
    });
  }

  drawSelection() {
    const { ctx, camera: cam, store } = this;
    const sel = store.selection;
    if (!sel.kind) return;
    let target = null;
    if (sel.kind === 'vehicle') target = store.vehiclesById.get(sel.id);
    else if (sel.kind === 'order') target = store.ordersById.get(sel.id);
    else if (sel.kind === 'depot') target = store.depotsById.get(sel.id);
    else if (sel.kind === 'route') {
      const r = store.routesById?.get(sel.id);
      target = r ? store.vehiclesById.get(r.vehicleId) : null;
    }
    if (!target) return;
    const p = cam.toScreen(target.x, target.y);
    const t = this.reducedMotion ? 0 : frac(this.time * 0.9);
    ctx.save();
    ctx.strokeStyle = withAlpha('#ffffff', 0.55 - t * 0.4);
    ctx.lineWidth = 1.4 * this.dpr;
    ctx.beginPath(); ctx.arc(p.x, p.y, (16 + t * 22) * this.dpr, 0, Math.PI * 2); ctx.stroke();
    // Corner brackets — a reticle, not a circle, so it reads as a selection.
    const s = 22 * this.dpr;
    ctx.strokeStyle = withAlpha('#ffffff', 0.8);
    ctx.lineWidth = 1.6 * this.dpr;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(p.x + sx * s, p.y + sy * s - sy * s * 0.42);
      ctx.lineTo(p.x + sx * s, p.y + sy * s);
      ctx.lineTo(p.x + sx * s - sx * s * 0.42, p.y + sy * s);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawScaleBar() {
    const { ctx, camera: cam } = this;
    const targetPx = 110 * this.dpr;
    const raw = targetPx / cam.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const km = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;
    const px = km * cam.scale;
    const x = 18 * this.dpr, y = this.canvas.height - 22 * this.dpr;
    ctx.save();
    ctx.strokeStyle = withAlpha(C.text, 0.42);
    ctx.lineWidth = 1.4 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(x, y - 5 * this.dpr); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5 * this.dpr);
    ctx.stroke();
    ctx.font = `${10 * this.dpr}px ui-monospace, monospace`;
    ctx.fillStyle = withAlpha(C.muted, 0.8);
    ctx.textAlign = 'left';
    ctx.fillText(`${km} km`, x, y - 9 * this.dpr);
    ctx.restore();
  }
}
