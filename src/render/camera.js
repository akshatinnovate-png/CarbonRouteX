/**
 * CAMERA
 *
 * Maps world kilometres onto screen pixels, with inertial-free but eased
 * transitions. All view state lives here so the renderer can stay stateless
 * with respect to navigation.
 */

import { RENDER } from '../config.js';
import { clamp, lerp, easeInOutCubic } from '../util/math.js';

export class Camera {
  constructor() {
    this.x = 0; this.y = 0;      // world centre
    this.zoom = 1;               // multiplier on baseScale
    this.baseScale = 10;         // px per km at zoom 1
    this.width = 1; this.height = 1;
    this.target = null;          // in-flight transition
    this.reducedMotion = false;
  }

  resize(width, height) {
    this.width = width; this.height = height;
  }

  get scale() { return this.baseScale * this.zoom; }

  /** Choose a base scale such that `bounds` fits the viewport at zoom 1. */
  calibrate(bounds, padding = 40) {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    this.baseScale = Math.min(
      (this.width - padding * 2) / Math.max(w, 1e-6),
      (this.height - padding * 2) / Math.max(h, 1e-6),
    );
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
    this.zoom = 1;
  }

  toScreen(wx, wy) {
    const s = this.scale;
    return { x: (wx - this.x) * s + this.width / 2, y: (wy - this.y) * s + this.height / 2 };
  }

  toWorld(sx, sy) {
    const s = this.scale;
    return { x: (sx - this.width / 2) / s + this.x, y: (sy - this.height / 2) / s + this.y };
  }

  /** Visible world rectangle, with an optional margin in km. */
  viewBounds(marginKm = 0) {
    const s = this.scale;
    const halfW = this.width / 2 / s + marginKm;
    const halfH = this.height / 2 / s + marginKm;
    return { minX: this.x - halfW, maxX: this.x + halfW, minY: this.y - halfH, maxY: this.y + halfH };
  }

  panBy(dxPx, dyPx) {
    const s = this.scale;
    this.x -= dxPx / s;
    this.y -= dyPx / s;
    this.target = null;
    this.clampToWorld();
  }

  /** Zoom keeping the world point under (sx, sy) fixed on screen. */
  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, RENDER.minZoom, RENDER.maxZoom);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.target = null;
    this.clampToWorld();
  }

  setWorldBounds(bounds) { this.worldBounds = bounds; }

  /** Keep at least part of the world on screen so the user cannot get lost. */
  clampToWorld() {
    if (!this.worldBounds) return;
    const b = this.worldBounds;
    const marginKm = 6;
    this.x = clamp(this.x, b.minX - marginKm, b.maxX + marginKm);
    this.y = clamp(this.y, b.minY - marginKm, b.maxY + marginKm);
  }

  /** Animate to a centre + zoom. Duration is ignored under reduced motion. */
  flyTo(x, y, zoom, duration = 620) {
    const targetZoom = clamp(zoom ?? this.zoom, RENDER.minZoom, RENDER.maxZoom);
    if (this.reducedMotion || duration <= 0) {
      this.x = x; this.y = y; this.zoom = targetZoom; this.target = null;
      this.clampToWorld();
      return;
    }
    this.target = {
      fromX: this.x, fromY: this.y, fromZoom: this.zoom,
      toX: x, toY: y, toZoom: targetZoom,
      start: performance.now(), duration,
    };
  }

  /** Fit a world-space bounding box, with pixel padding. */
  fitBounds(bounds, padding = 90, duration = 620) {
    const w = Math.max(bounds.maxX - bounds.minX, 0.6);
    const h = Math.max(bounds.maxY - bounds.minY, 0.6);
    const scale = Math.min((this.width - padding * 2) / w, (this.height - padding * 2) / h);
    this.flyTo((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, scale / this.baseScale, duration);
  }

  fitPoints(points, padding = 90, duration = 620) {
    if (!points || !points.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    this.fitBounds({ minX, minY, maxX, maxY }, padding, duration);
  }

  /** Advance any in-flight transition. Returns true while still animating. */
  update(now = performance.now()) {
    if (!this.target) return false;
    const t = clamp((now - this.target.start) / this.target.duration, 0, 1);
    const e = easeInOutCubic(t);
    this.x = lerp(this.target.fromX, this.target.toX, e);
    this.y = lerp(this.target.fromY, this.target.toY, e);
    // Interpolating zoom logarithmically keeps the apparent speed constant.
    this.zoom = Math.exp(lerp(Math.log(this.target.fromZoom), Math.log(this.target.toZoom), e));
    if (t >= 1) { this.target = null; this.clampToWorld(); return false; }
    return true;
  }

  reset(bounds) { this.fitBounds(bounds, 60); }
}
