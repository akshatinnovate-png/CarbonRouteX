/**
 * TRAFFIC ENGINE
 *
 * Produces a per-edge congestion field as a function of (time of day, road
 * class, centrality, scenario overrides). It is deterministic: the same clock
 * and the same scenario always yield the same field, which is what lets the
 * optimiser's results be reproducible and the "before/after" comparison honest.
 *
 * Output is a Float32Array indexed by edge id:
 *   congestion[e]  in 0..1+     0 = free flow, 1 = at capacity, >1 = jam
 *   speedFactor[e] in 0..1      multiply base speed by this
 */

import { TRAFFIC, WORLD } from '../config.js';
import { clamp, rng } from '../util/math.js';

export class TrafficEngine {
  constructor(world) {
    this.world = world;
    this.congestion = new Float32Array(world.edges.length);
    this.speedFactor = new Float32Array(world.edges.length).fill(1);
    this.incidents = [];       // { x, y, radiusKm, severity, label, id }
    this.globalMultiplier = 1; // scenario "traffic +30%" etc.
    this.closures = new Set(); // edge ids closed by scenario
    this.revision = 0;
    // A fixed spatial noise field so congestion has texture instead of being
    // a smooth function of radius alone.
    const r = rng(world.seed ^ 0x5eed);
    this.noise = Array.from({ length: 5 }, () => ({
      fx: (r() * 2 - 1) * 0.26, fy: (r() * 2 - 1) * 0.26, ph: r() * 6.28, amp: 0.5 + r() * 0.5,
    }));
    this.update(9 * 60);
  }

  /** Diurnal demand 0..1 with smooth interpolation between hours. */
  demandAt(minutes) {
    const h = ((minutes / 60) % 24 + 24) % 24;
    const i = Math.floor(h), f = h - i;
    const a = TRAFFIC.diurnal[i % 24], b = TRAFFIC.diurnal[(i + 1) % 24];
    return a + (b - a) * f;
  }

  spatialNoise(x, y) {
    let v = 0;
    for (const n of this.noise) v += n.amp * Math.sin(x * n.fx + y * n.fy + n.ph);
    return v / this.noise.length; // -1..1
  }

  setGlobalMultiplier(m) {
    if (this.globalMultiplier === m) return;
    this.globalMultiplier = m;
    this.dirty = true;
  }

  addIncident(incident) {
    this.incidents.push(incident);
    this.dirty = true;
  }

  clearIncidents() {
    if (!this.incidents.length) return;
    this.incidents = [];
    this.dirty = true;
  }

  closeEdge(edgeId) { this.closures.add(edgeId); this.world.edges[edgeId].closed = true; this.dirty = true; }
  openEdge(edgeId) { this.closures.delete(edgeId); this.world.edges[edgeId].closed = false; this.dirty = true; }
  clearClosures() {
    for (const id of this.closures) this.world.edges[id].closed = false;
    this.closures.clear();
    this.dirty = true;
  }

  /** Recompute the field for a given clock time (minutes since midnight). */
  update(minutes) {
    const demand = this.demandAt(minutes);
    const { edges } = this.world;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      let c = demand * e.congestionBias * this.globalMultiplier;
      c *= 1 + this.spatialNoise(e.mid.x, e.mid.y) * 0.28;
      // Highways absorb load better than local streets at the same demand.
      const absorb = e.cls === 'highway' ? 0.62 : e.cls === 'arterial' ? 0.88 : e.cls === 'collector' ? 1.0 : 1.18;
      c *= absorb;
      for (const inc of this.incidents) {
        const d = Math.hypot(e.mid.x - inc.x, e.mid.y - inc.y);
        if (d < inc.radiusKm) {
          // Smooth falloff so the incident reads as a zone, not a hard disc.
          c += inc.severity * (1 - d / inc.radiusKm) ** 1.5;
        }
      }
      c = clamp(c, 0, 2.6);
      this.congestion[i] = c;
      // BPR-style volume/delay: travel time grows superlinearly near capacity.
      this.speedFactor[i] = e.closed ? 0 : 1 / (1 + 0.62 * Math.pow(c, 2.1));
    }
    this.lastMinutes = minutes;
    this.dirty = false;
    this.revision++;
  }

  /** Effective speed on an edge in km/h (0 when closed). */
  speedOn(edgeId) {
    const e = this.world.edges[edgeId];
    return e.baseSpeed * this.speedFactor[edgeId];
  }

  /** Travel time in minutes across an edge under current conditions. */
  timeOn(edgeId) {
    const s = this.speedOn(edgeId);
    if (s < 0.5) return Infinity;
    return (this.world.edges[edgeId].lengthKm / s) * 60;
  }

  levelFor(edgeId) {
    const c = this.congestion[edgeId];
    if (this.world.edges[edgeId].closed) return { key: 'closed', label: 'Closed', color: '#6b7280', mult: Infinity };
    if (c < 0.35) return TRAFFIC.levels[0];
    if (c < 0.62) return TRAFFIC.levels[1];
    if (c < 0.92) return TRAFFIC.levels[2];
    if (c < 1.35) return TRAFFIC.levels[3];
    return TRAFFIC.levels[4];
  }

  /** Network-wide congestion index 0..1, length-weighted. */
  networkIndex() {
    let num = 0, den = 0;
    for (let i = 0; i < this.world.edges.length; i++) {
      const w = this.world.edges[i].lengthKm;
      num += this.congestion[i] * w;
      den += w;
    }
    return den ? clamp(num / den / 1.6, 0, 1) : 0;
  }

  /** The N most congested corridors, for the alert system. */
  hotspots(limit = 5) {
    const scored = [];
    for (let i = 0; i < this.world.edges.length; i++) {
      const e = this.world.edges[i];
      if (e.cls === 'local') continue;
      scored.push({ edgeId: i, score: this.congestion[i] * Math.sqrt(e.lengthKm), edge: e });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

/** Human-readable corridor name for an edge, used in alerts and the log. */
export function corridorName(world, edgeId) {
  const e = world.edges[edgeId];
  const angle = Math.atan2(e.mid.y, e.mid.x);
  const dir = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][Math.round(((angle + Math.PI) / (Math.PI * 2)) * 8) % 8];
  const prefix = e.cls === 'highway' ? 'NH' : e.cls === 'arterial' ? 'AR' : e.cls === 'collector' ? 'CL' : 'LC';
  return `${prefix}-${dir}${String(edgeId % 97).padStart(2, '0')}`;
}

export const WORLD_REF = WORLD;
