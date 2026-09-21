/**
 * TILE MAP ENGINE — a real slippy map, drawn on canvas, with no dependencies.
 *
 * Consumes standard XYZ raster tiles from OpenStreetMap-based providers, so the
 * basemap is genuine cartography: real roads, real rivers, real place names.
 *
 * Why hand-rolled instead of a mapping library:
 *  - The overlay (routes, vehicles, heatmaps) is already canvas work, and
 *    compositing it into the same context as the tiles avoids a second
 *    rendering stack and the DOM-marker cost that comes with it.
 *  - It keeps the application dependency-free and offline-installable.
 *
 * Tile handling:
 *  - LRU image cache keyed by z/x/y, capped, with in-flight de-duplication.
 *  - While a tile is loading, the equivalent region of an already-loaded parent
 *    tile is drawn scaled up, so zooming never flashes empty grey.
 *  - Failed tiles are remembered and not retried in a loop.
 */

import { EV, emit, on } from '../core/bus.js';
import { prefersReducedMotion } from '../util/dom.js';
import {
  TILE_SIZE, lonLatToWorld, worldToLonLat, metresPerPixel, boundsOf, haversineKm,
} from './mercator.js';

const MIN_ZOOM = 2;
const MAX_ZOOM = 19;

export class TileMap {
  constructor(canvas, { provider }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.provider = provider;
    this.dpr = 1;

    // View state: centre in lon/lat plus a fractional zoom.
    this.centre = { lon: 0, lat: 20 };
    this.zoom = 3;

    this.tiles = new Map();      // "z/x/y" -> { img, loaded, failed }
    this.pending = new Set();
    this.maxTiles = 700;
    this.failedTiles = new Set();

    this.overlays = [];          // draw(ctx, view) callbacks, in order
    this.pickers = [];           // (screenX, screenY, view) => hit | null

    this.running = false;
    this.time = 0;
    this.lastFrame = 0;
    this.fps = 60;
    this.frameTimes = [];
    this.reducedMotion = prefersReducedMotion();
    this.needsRedraw = true;

    this.pointer = { x: 0, y: 0, inside: false, down: false, dragged: false };
    this.hover = null;
    this.anim = null;

    this._bindEvents();
  }

  /* ---------------------------------------------------------------- */
  /* View helpers                                                      */
  /* ---------------------------------------------------------------- */

  get view() {
    return {
      centre: this.centre,
      zoom: this.zoom,
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: this.dpr,
      toScreen: (lon, lat) => this.toScreen(lon, lat),
      toLonLat: (x, y) => this.toLonLat(x, y),
      time: this.time,
      reducedMotion: this.reducedMotion,
    };
  }

  /** lon/lat -> device pixels on this canvas. */
  toScreen(lon, lat) {
    const c = lonLatToWorld(this.centre.lon, this.centre.lat, this.zoom);
    const p = lonLatToWorld(lon, lat, this.zoom);
    return {
      x: (p.x - c.x) * this.dpr + this.canvas.width / 2,
      y: (p.y - c.y) * this.dpr + this.canvas.height / 2,
    };
  }

  /** device pixels -> lon/lat. */
  toLonLat(x, y) {
    const c = lonLatToWorld(this.centre.lon, this.centre.lat, this.zoom);
    return worldToLonLat(
      c.x + (x - this.canvas.width / 2) / this.dpr,
      c.y + (y - this.canvas.height / 2) / this.dpr,
      this.zoom,
    );
  }

  /** Kilometres per device pixel — used for hit-test tolerances. */
  kmPerPixel() {
    return (metresPerPixel(this.centre.lat, this.zoom) / 1000) / this.dpr;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.needsRedraw = true;
  }

  setProvider(provider) {
    this.provider = provider;
    this.tiles.clear();
    this.failedTiles.clear();
    this.needsRedraw = true;
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  setView(lon, lat, zoom, { animate = true } = {}) {
    const z = clamp(zoom ?? this.zoom, MIN_ZOOM, MAX_ZOOM);
    if (!animate || this.reducedMotion) {
      this.centre = { lon, lat };
      this.zoom = z;
      this.anim = null;
      this.needsRedraw = true;
      return;
    }
    this.anim = {
      from: { ...this.centre, zoom: this.zoom },
      to: { lon, lat, zoom: z },
      start: performance.now(),
      duration: 620,
    };
  }

  /** Fit a set of {lon, lat} points with pixel padding. */
  fit(points, { padding = 70, animate = true, maxZoom = 16 } = {}) {
    const b = boundsOf(points ?? [], 0.16);
    if (!b) return;
    const w = Math.max(this.canvas.width / this.dpr - padding * 2, 80);
    const h = Math.max(this.canvas.height / this.dpr - padding * 2, 80);
    // Find the largest integer-ish zoom at which the bounds still fit.
    let best = MIN_ZOOM;
    for (let z = MAX_ZOOM; z >= MIN_ZOOM; z -= 0.25) {
      const a = lonLatToWorld(b.minLon, b.maxLat, z);
      const c = lonLatToWorld(b.maxLon, b.minLat, z);
      if (Math.abs(c.x - a.x) <= w && Math.abs(c.y - a.y) <= h) { best = z; break; }
    }
    this.setView((b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2, Math.min(best, maxZoom), { animate });
  }

  zoomBy(delta, anchorX, anchorY) {
    const ax = anchorX ?? this.canvas.width / 2;
    const ay = anchorY ?? this.canvas.height / 2;
    const before = this.toLonLat(ax, ay);
    this.zoom = clamp(this.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    const after = this.toLonLat(ax, ay);
    this.centre = {
      lon: this.centre.lon + (before.lon - after.lon),
      lat: clamp(this.centre.lat + (before.lat - after.lat), -85, 85),
    };
    this.anim = null;
    this.needsRedraw = true;
  }

  panByPixels(dx, dy) {
    const c = lonLatToWorld(this.centre.lon, this.centre.lat, this.zoom);
    const next = worldToLonLat(c.x - dx / this.dpr, c.y - dy / this.dpr, this.zoom);
    this.centre = { lon: wrapLon(next.lon), lat: clamp(next.lat, -85, 85) };
    this.anim = null;
    this.needsRedraw = true;
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  _bindEvents() {
    const cv = this.canvas;
    let last = null;
    const pointers = new Map();
    let pinch = 0;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pointer.down = true;
      this.pointer.dragged = false;
      last = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
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
        if (pinch > 0 && d > 0) {
          const midX = ((a.x + b.x) / 2 - rect.left) * this.dpr;
          const midY = ((a.y + b.y) / 2 - rect.top) * this.dpr;
          this.zoomBy(Math.log2(d / pinch), midX, midY);
        }
        pinch = d;
        this.pointer.dragged = true;
        return;
      }

      if (this.pointer.down && last) {
        const dx = (e.clientX - last.x) * this.dpr;
        const dy = (e.clientY - last.y) * this.dpr;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.pointer.dragged = true;
        this.panByPixels(dx, dy);
        last = { x: e.clientX, y: e.clientY };
        cv.style.cursor = 'grabbing';
      } else {
        const hit = this.pick(this.pointer.x, this.pointer.y);
        const key = hit ? `${hit.kind}:${hit.id}` : null;
        if (key !== this._hoverKey) {
          this._hoverKey = key;
          this.hover = hit;
          cv.style.cursor = hit ? 'pointer' : 'grab';
          emit(EV.HOVER, hit || { kind: null, id: null });
          this.needsRedraw = true;
        }
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (pointers.size === 0) {
        this.pointer.down = false;
        last = null;
        cv.style.cursor = this.hover ? 'pointer' : 'grab';
      }
    };
    cv.addEventListener('pointerup', (e) => {
      if (!this.pointer.dragged && pointers.size === 1) {
        const hit = this.pick(this.pointer.x, this.pointer.y);
        const ll = this.toLonLat(this.pointer.x, this.pointer.y);
        emit(EV.MAP_CLICK, { hit, lon: ll.lon, lat: ll.lat });
      }
      end(e);
    });
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.hover = null;
      this._hoverKey = null;
      emit(EV.HOVER, { kind: null, id: null });
    });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      this.zoomBy(
        clamp(-e.deltaY * unit * 0.0022, -1.2, 1.2),
        (e.clientX - rect.left) * this.dpr,
        (e.clientY - rect.top) * this.dpr,
      );
    }, { passive: false });

    cv.addEventListener('dblclick', (e) => {
      const rect = cv.getBoundingClientRect();
      this.zoomBy(1, (e.clientX - rect.left) * this.dpr, (e.clientY - rect.top) * this.dpr);
    });

    window.addEventListener('resize', () => this.resize());
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener?.('change', () => { this.reducedMotion = mq.matches; });
  }

  pick(x, y) {
    for (let i = this.pickers.length - 1; i >= 0; i--) {
      const hit = this.pickers[i](x, y, this.view);
      if (hit) return hit;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Tiles                                                             */
  /* ---------------------------------------------------------------- */

  _tileKey(z, x, y) { return `${z}/${x}/${y}`; }

  _getTile(z, x, y) {
    const key = this._tileKey(z, x, y);
    const existing = this.tiles.get(key);
    if (existing) return existing;
    if (this.failedTiles.has(key) || this.pending.has(key)) return null;

    const n = 1 << z;
    if (y < 0 || y >= n) return null;
    const wrappedX = ((x % n) + n) % n;

    const entry = { img: new Image(), loaded: false, failed: false, z, x: wrappedX, y };
    entry.img.crossOrigin = 'anonymous';
    entry.img.decoding = 'async';
    this.pending.add(key);
    entry.img.onload = () => {
      entry.loaded = true;
      this.pending.delete(key);
      this.tiles.set(key, entry);
      this._evictTiles();
      this.needsRedraw = true;
    };
    entry.img.onerror = () => {
      entry.failed = true;
      this.pending.delete(key);
      this.failedTiles.add(key);
      this.tilesFailing = (this.tilesFailing || 0) + 1;
      this.needsRedraw = true;
    };
    entry.img.src = this.provider.url(z, wrappedX, y);
    return null;
  }

  _evictTiles() {
    if (this.tiles.size <= this.maxTiles) return;
    // Map preserves insertion order, so the oldest fetched tiles go first.
    let drop = this.tiles.size - this.maxTiles;
    for (const k of this.tiles.keys()) {
      this.tiles.delete(k);
      if (--drop <= 0) break;
    }
  }

  /**
   * Draw the basemap. Fractional zoom is handled by rendering the nearest
   * integer zoom level's tiles scaled to fit, which is what every slippy map
   * does and keeps label sizes stable while zooming.
   */
  _drawTiles() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = this.provider.background || '#111a28';
    ctx.fillRect(0, 0, W, H);

    const z = clamp(Math.round(this.zoom), MIN_ZOOM, Math.min(MAX_ZOOM, this.provider.maxZoom ?? MAX_ZOOM));
    const scale = Math.pow(2, this.zoom - z) * this.dpr;
    const tilePx = TILE_SIZE * scale;

    const c = lonLatToWorld(this.centre.lon, this.centre.lat, z);
    const originX = W / 2 - c.x * scale;
    const originY = H / 2 - c.y * scale;

    const minX = Math.floor(-originX / tilePx);
    const maxX = Math.ceil((W - originX) / tilePx);
    const minY = Math.max(0, Math.floor(-originY / tilePx));
    const maxY = Math.min((1 << z) - 1, Math.ceil((H - originY) / tilePx));

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    let drawn = 0, missing = 0;
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const dx = originX + x * tilePx;
        const dy = originY + y * tilePx;
        const tile = this._getTile(z, x, y);
        if (tile && tile.loaded) {
          // +1px covers sub-pixel seams between adjacent tiles.
          ctx.drawImage(tile.img, dx, dy, tilePx + 1, tilePx + 1);
          drawn++;
        } else {
          missing++;
          this._drawParentTile(ctx, z, x, y, dx, dy, tilePx);
        }
      }
    }
    this.tilesDrawn = drawn;
    this.tilesMissing = missing;
  }

  /** Scale up an ancestor tile so zooming never flashes empty background. */
  _drawParentTile(ctx, z, x, y, dx, dy, tilePx) {
    for (let up = 1; up <= 4; up++) {
      const pz = z - up;
      if (pz < MIN_ZOOM) return;
      const f = 1 << up;
      const px = Math.floor(x / f), py = Math.floor(y / f);
      const parent = this.tiles.get(this._tileKey(pz, ((px % (1 << pz)) + (1 << pz)) % (1 << pz), py));
      if (!parent || !parent.loaded) continue;
      const sub = TILE_SIZE / f;
      const sx = (x - px * f) * sub;
      const sy = (y - py * f) * sub;
      ctx.drawImage(parent.img, sx, sy, sub, sub, dx, dy, tilePx + 1, tilePx + 1);
      return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Loop                                                              */
  /* ---------------------------------------------------------------- */

  addOverlay(fn) { this.overlays.push(fn); return () => { this.overlays = this.overlays.filter((o) => o !== fn); }; }
  addPicker(fn) { this.pickers.push(fn); return () => { this.pickers = this.pickers.filter((p) => p !== fn); }; }
  invalidate() { this.needsRedraw = true; }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._frame(now);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _frame(now) {
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.time += dt;

    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) {
      this.frameTimes.shift();
      this.fps = 1 / Math.max(this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length, 1e-6);
    }

    if (this.anim) {
      const t = clamp((now - this.anim.start) / this.anim.duration, 0, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.centre = {
        lon: lerp(this.anim.from.lon, this.anim.to.lon, e),
        lat: lerp(this.anim.from.lat, this.anim.to.lat, e),
      };
      this.zoom = lerp(this.anim.from.zoom, this.anim.to.zoom, e);
      if (t >= 1) this.anim = null;
      this.needsRedraw = true;
    }

    this.draw();
  }

  draw() {
    if (!this.canvas.width) return;
    this._drawTiles();
    const view = this.view;
    for (const overlay of this.overlays) {
      try { overlay(this.ctx, view); }
      catch (err) { console.error('[map] overlay failed', err); }
    }
    this._drawScaleBar();
    this.needsRedraw = false;
  }

  _drawScaleBar() {
    const ctx = this.ctx;
    const mpp = metresPerPixel(this.centre.lat, this.zoom);
    const targetPx = 110;
    const rawM = mpp * targetPx;
    const pow = Math.pow(10, Math.floor(Math.log10(rawM)));
    const niceM = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rawM) || pow * 10;
    const px = (niceM / mpp) * this.dpr;
    const x = 16 * this.dpr;
    const y = this.canvas.height - 20 * this.dpr;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 3.4 * this.dpr;
    barPath(ctx, x, y, px, this.dpr);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.4 * this.dpr;
    barPath(ctx, x, y, px, this.dpr);
    ctx.stroke();
    const label = niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`;
    ctx.font = `${10 * this.dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3 * this.dpr;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.strokeText(label, x, y - 8 * this.dpr);
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fillText(label, x, y - 8 * this.dpr);
    ctx.restore();
  }
}

function barPath(ctx, x, y, px, dpr) {
  ctx.beginPath();
  ctx.moveTo(x, y - 5 * dpr);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 5 * dpr);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

export { MIN_ZOOM, MAX_ZOOM };
