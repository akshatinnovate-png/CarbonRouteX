/**
 * MAP OVERLAYS
 *
 * Everything the application knows, drawn on top of the real basemap: planned
 * routes with directional flow, delivery stops, depots, live vehicles, incident
 * zones and the emissions heatmap.
 *
 * Drawn on the same canvas as the tiles rather than as DOM markers — a hundred
 * absolutely-positioned elements re-laid-out on every pan is exactly the cost
 * this avoids.
 */

import { RENDER } from '../config.js';
import {
  C, withAlpha, vehicleColor, onImagery, PRIORITY_COLOR, STATUS_COLOR, CARBON_RAMP,
} from './palette.js';
import { haversineKm } from './mercator.js';
import { clamp } from '../util/math.js';

const frac = (v) => v - Math.floor(v);

export function installOverlays(map, store) {
  /**
   * Satellite imagery is an unpredictable background: one route can cross dark
   * water, bright rooftops and pale desert inside a single frame. Rather than
   * pick a colour and hope, every mark is drawn against a contrast pair chosen
   * from the basemap in use.
   */
  const ink = () => onImagery(map.provider?.theme ?? 'imagery');
  const on = (key) => !!store.layers[key];

  /* ---------------------------------------------------------- routes */

  map.addOverlay((ctx, view) => {
    if (!on('routes') || !store.plan) return;
    const sel = store.selection;
    const routes = store.plan.routes.filter((r) => r.orderIds.length);
    const focusOf = (r) => (sel.kind === 'route' && sel.id === r.id)
      || (sel.kind === 'vehicle' && sel.id === r.vehicleId)
      || (sel.kind === 'order' && r.orderIds.includes(sel.id));
    const anyFocus = routes.some(focusOf);

    // Unfocused first so the selected route always sits on top.
    for (const pass of [0, 1]) {
      for (const r of routes) {
        const focused = focusOf(r);
        if ((pass === 0) === focused) continue;
        drawRoute(ctx, view, r, {
          focused,
          dimmed: anyFocus && !focused,
          index: store.vehicles.findIndex((v) => v.id === r.vehicleId),
          ik: ink(),
        });
      }
    }
  });

  function drawRoute(ctx, view, route, { focused, dimmed, index, ik }) {
    const path = route.path && route.path.length > 1
      ? route.path
      : routeWaypoints(route, store);
    if (path.length < 2) return;

    const pts = [];
    let visible = false;
    for (const p of path) {
      const s = view.toScreen(p.lon, p.lat);
      pts.push(s);
      if (!visible && s.x > -200 && s.y > -200 && s.x < view.width + 200 && s.y < view.height + 200) visible = true;
    }
    if (!visible) return;

    // The selected route is gold. Everything else is a member of the teal
    // fleet ramp: one system, distinguishable members.
    const colour = focused ? C.gold : vehicleColor(index < 0 ? 0 : index);
    // A route the motion layer has just flagged as changed: see
    // animateRouteChange() in ui/motion.js. Presentation only — the plan is
    // already published and readable in the tables before this runs.
    const flagged = map.highlight?.ids?.has(route.id)
      ? clamp((map.highlight.until - performance.now()) / map.highlight.duration, 0, 1)
      : 0;
    const w = clamp(view.zoom - 7, 1, 5) * view.dpr;
    const alpha = dimmed ? 0.2 : focused ? 1 : 0.82;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // A casing keeps the line readable over busy cartography and over imagery.
    trace(ctx, pts);
    ctx.strokeStyle = ik.dark ? 'rgba(6,22,32,.5)' : 'rgba(255,255,255,.78)';
    ctx.lineWidth = w * (focused ? 3.6 : 2.7);
    ctx.stroke();

    if (flagged > 0) {
      trace(ctx, pts);
      ctx.strokeStyle = withAlpha(C.goldBright, 0.55 * flagged);
      ctx.lineWidth = w * (3 + 5 * flagged);
      ctx.stroke();
    }

    if (focused) {
      // A second, softer gold halo: the selected route should be findable at a
      // glance without being the only thing you can see.
      trace(ctx, pts);
      ctx.strokeStyle = withAlpha(C.goldBright, 0.3);
      ctx.lineWidth = w * 5.2;
      ctx.stroke();
    }

    trace(ctx, pts);
    ctx.strokeStyle = withAlpha(colour, alpha);
    ctx.lineWidth = w * (focused ? 2.1 : 1.5);
    ctx.stroke();

    // Directional flow — the one animation that carries information.
    if (!dimmed && !view.reducedMotion && !route.allDelivered) {
      trace(ctx, pts);
      const dash = Math.max(9, w * 6);
      ctx.setLineDash([dash * 0.4, dash * 1.7]);
      ctx.lineDashOffset = -(view.time * 60 * RENDER.flowSpeed * 14) % (dash * 2.1);
      ctx.strokeStyle = withAlpha(focused ? '#ffffff' : (ik.dark ? '#ffffff' : C.ink), focused ? 0.95 : 0.5);
      ctx.lineWidth = w * 0.8;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // A dashed line means the geometry is a straight-line estimate, not a
    // real road path — the map should never imply precision it does not have.
    if (route.geometryEstimated && !route.path) {
      trace(ctx, pts);
      ctx.setLineDash([4 * view.dpr, 5 * view.dpr]);
      ctx.strokeStyle = withAlpha(C.gold, 0.8);
      ctx.lineWidth = w * 0.7;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------- heatmap */

  const heat = document.createElement('canvas');
  const heatCtx = heat.getContext('2d');
  let heatKey = null;

  map.addOverlay((ctx, view) => {
    if (!on('emissions') || !store.plan) return;
    const key = `${view.centre.lon.toFixed(4)}|${view.centre.lat.toFixed(4)}|${view.zoom.toFixed(3)}|${store.plan.id}|${view.width}`;
    if (key !== heatKey) {
      heatKey = key;
      const DS = 5;
      heat.width = Math.max(2, Math.ceil(view.width / DS));
      heat.height = Math.max(2, Math.ceil(view.height / DS));
      heatCtx.clearRect(0, 0, heat.width, heat.height);
      heatCtx.globalCompositeOperation = 'lighter';

      // Accumulate each leg's CO2e density along the straight line between its
      // endpoints — the hot cells are where the fleet emits, not merely where
      // it drives.
      const blobs = [];
      let peak = 1e-9;
      for (const r of store.plan.routes) {
        for (const leg of r.legs || []) {
          if (!leg.km) continue;
          const a = store.matrix.points[leg.fromIdx];
          const b = store.matrix.points[leg.toIdx];
          if (!a || !b) continue;
          const density = leg.co2 / Math.max(leg.km, 0.05);
          if (density > peak) peak = density;
          const steps = clamp(Math.round(leg.km / 1.5), 1, 24);
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            blobs.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, v: density });
          }
        }
      }
      const radius = clamp(view.zoom * 2.2, 8, 34);
      for (const b of blobs) {
        const s = view.toScreen(b.lon, b.lat);
        const x = s.x / DS, y = s.y / DS;
        if (x < -radius || y < -radius || x > heat.width + radius || y > heat.height + radius) continue;
        const a = clamp(b.v / peak, 0, 1) ** 0.6;
        const g = heatCtx.createRadialGradient(x, y, 0, x, y, radius);
        g.addColorStop(0, `rgba(255,255,255,${0.3 * a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        heatCtx.fillStyle = g;
        heatCtx.beginPath(); heatCtx.arc(x, y, radius, 0, Math.PI * 2); heatCtx.fill();
      }
      recolour(heatCtx, heat.width, heat.height);
      heatCtx.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(heat, 0, 0, view.width, view.height);
    ctx.restore();
  });

  /* ------------------------------------------------------ incidents */

  map.addOverlay((ctx, view) => {
    if (!on('incidents')) return;
    const incidents = [...store.matrix.incidents, ...store.pendingScenario.incidents];
    for (const inc of incidents) {
      const s = view.toScreen(inc.lon, inc.lat);
      // Convert the radius from km into pixels at this latitude.
      const edge = view.toScreen(inc.lon + inc.radiusKm / (111.32 * Math.cos(inc.lat * Math.PI / 180)), inc.lat);
      const r = Math.abs(edge.x - s.x);
      if (r < 2) continue;
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, withAlpha(C.danger, 0.26));
      g.addColorStop(0.65, withAlpha(C.warn, 0.12));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      const pulse = view.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(view.time * 2.2);
      ctx.strokeStyle = withAlpha(C.danger, 0.22 + pulse * 0.28);
      ctx.lineWidth = 1.6 * view.dpr;
      ctx.beginPath(); ctx.arc(s.x, s.y, r * (0.62 + pulse * 0.34), 0, Math.PI * 2); ctx.stroke();
    }
  });

  /* --------------------------------------------------------- depots */

  map.addOverlay((ctx, view) => {
    if (!on('depots')) return;
    const ik = ink();
    for (const d of store.depots) {
      const s = view.toScreen(d.lon, d.lat);
      if (offscreen(s, view, 60)) continue;
      const selected = store.selection.kind === 'depot' && store.selection.id === d.id;
      const r = 9 * view.dpr;

      ctx.save();
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3.4);
      g.addColorStop(0, withAlpha(C.teal, 0.3));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, r * 3.4, 0, Math.PI * 2); ctx.fill();

      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = selected ? C.gold : C.teal;
      ctx.lineWidth = (selected ? 3 : 2) * view.dpr;
      ctx.beginPath(); ctx.rect(-r * 0.72, -r * 0.72, r * 1.44, r * 1.44); ctx.fill(); ctx.stroke();
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = C.teal;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      if (on('labels') && view.zoom > 10.5) {
        label(ctx, view, s.x, s.y + r * 2.4, d.name.toUpperCase(), ik, 'center');
      }
    }
  });

  /* ---------------------------------------------------------- stops */

  map.addOverlay((ctx, view) => {
    if (!on('deliveries')) return;
    const ik = ink();
    const sel = store.selection;
    const r = clamp((view.zoom - 8) * 1.6, 3.5, 8) * view.dpr;

    for (const o of store.orders) {
      const s = view.toScreen(o.lon, o.lat);
      if (offscreen(s, view, 40)) continue;
      const delivered = o.status === 'delivered';
      const unserved = o.status === 'unserved';
      const selected = sel.kind === 'order' && sel.id === o.id;
      const hovered = store.hover.kind === 'order' && store.hover.id === o.id;
      const colour = unserved ? C.danger : delivered ? C.success : (PRIORITY_COLOR[o.priority] || C.teal);

      ctx.save();
      if (selected || hovered) {
        ctx.beginPath(); ctx.arc(s.x, s.y, r * 3, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(colour, 0.2); ctx.fill();
      }
      if (o.priority === 'critical' && !delivered && !view.reducedMotion) {
        const pulse = frac(view.time * 1.3 + o.lon * 0.4);
        ctx.beginPath(); ctx.arc(s.x, s.y, r * (1 + pulse * 2.2), 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(C.danger, 0.4 * (1 - pulse));
        ctx.lineWidth = 1.6 * view.dpr; ctx.stroke();
      }

      // A pin with a white ring reads against any basemap.
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(colour, delivered ? 0.55 : 1);
      ctx.fill();
      ctx.strokeStyle = selected ? C.gold : ik.pinStroke;
      ctx.lineWidth = (selected ? 3 : 2) * view.dpr;
      ctx.stroke();

      if (delivered) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.8 * view.dpr;
        ctx.beginPath();
        ctx.moveTo(s.x - r * 0.45, s.y);
        ctx.lineTo(s.x - r * 0.1, s.y + r * 0.4);
        ctx.lineTo(s.x + r * 0.5, s.y - r * 0.42);
        ctx.stroke();
      }
      ctx.restore();

      if (on('labels') && (view.zoom > 13 || selected)) {
        label(ctx, view, s.x + r * 1.8, s.y + 3.5 * view.dpr, o.ref, ik, 'left');
      }
    }
  });

  /* ------------------------------------------------------- vehicles */

  map.addOverlay((ctx, view) => {
    if (!on('vehicles')) return;
    const ik = ink();
    const sel = store.selection;
    const size = clamp((view.zoom - 7) * 2.2, 7, 16) * view.dpr;

    store.vehicles.forEach((v, i) => {
      if (v.lon == null || v.lat == null) return;
      const s = view.toScreen(v.lon, v.lat);
      if (offscreen(s, view, 60)) return;
      const selected = sel.kind === 'vehicle' && sel.id === v.id;
      const colour = v.available ? vehicleColor(i) : C.danger;
      const statusColour = STATUS_COLOR[v.status] || C.faint;

      ctx.save();
      const halo = size * (selected ? 3.6 : 2.4);
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, halo);
      g.addColorStop(0, withAlpha(statusColour, selected ? 0.38 : 0.2));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, halo, 0, Math.PI * 2); ctx.fill();

      if ((v.status === 'delayed' || !v.available) && !view.reducedMotion) {
        const pulse = frac(view.time * 1.1 + i * 0.3);
        ctx.beginPath(); ctx.arc(s.x, s.y, size * (1.3 + pulse * 2.4), 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(C.danger, 0.45 * (1 - pulse));
        ctx.lineWidth = 1.8 * view.dpr; ctx.stroke();
      }

      ctx.translate(s.x, s.y);
      // Heading is a compass bearing; canvas rotation is from the +x axis.
      ctx.rotate((v.heading || 0) - Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(size * 1.1, 0);
      ctx.lineTo(-size * 0.72, size * 0.74);
      ctx.lineTo(-size * 0.3, 0);
      ctx.lineTo(-size * 0.72, -size * 0.74);
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.strokeStyle = selected ? C.gold : ik.pinStroke;
      ctx.lineWidth = (selected ? 2.6 : 1.6) * view.dpr;
      ctx.stroke();
      ctx.restore();

      if (on('labels') && (view.zoom > 11 || selected)) {
        label(ctx, view, s.x, s.y - size * 2.1, v.callsign, ik, 'center');
      }
    });
  });

  /* ------------------------------------------------------ personal trip */

  /**
   * PERSONAL mode draws one journey rather than a fleet: the alternatives the
   * routing service actually returned, in teal, with the chosen one in gold on
   * top. Unselected alternatives stay visible because the comparison is the
   * whole point — hiding them would leave the numbers unexplained.
   */
  map.addOverlay((ctx, view) => {
    const trip = store.trip;
    if (!trip || !store.isPersonal) return;
    const ik = ink();
    const chosenId = trip.chosen?.trip?.id;
    const w = clamp(view.zoom - 7, 1, 5) * view.dpr;

    for (const pass of [0, 1]) {
      for (const t of trip.trips) {
        const isChosen = t.id === chosenId;
        if ((pass === 0) === isChosen) continue;
        const pts = t.points.map((p) => view.toScreen(p.lon, p.lat));
        if (pts.length < 2) continue;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        trace(ctx, pts);
        ctx.strokeStyle = ik.dark ? 'rgba(6,22,32,.5)' : 'rgba(255,255,255,.8)';
        ctx.lineWidth = w * (isChosen ? 3.8 : 2.6);
        ctx.stroke();

        if (isChosen) {
          trace(ctx, pts);
          ctx.strokeStyle = withAlpha(C.goldBright, 0.28);
          ctx.lineWidth = w * 5.6;
          ctx.stroke();
        }

        trace(ctx, pts);
        ctx.strokeStyle = isChosen ? C.gold : withAlpha(C.teal, 0.55);
        ctx.lineWidth = w * (isChosen ? 2.2 : 1.3);
        if (t.estimated) ctx.setLineDash([5 * view.dpr, 5 * view.dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Start and end. A ring for where you are, a filled pin for where you are
    // going: the same shape language the fleet map uses for depots and stops.
    const r = 8 * view.dpr;
    for (const [point, kind] of [[trip.from, 'start'], [trip.to, 'end']]) {
      if (!point) continue;
      const sc = view.toScreen(point.lon, point.lat);
      ctx.save();
      ctx.beginPath(); ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = kind === 'end' ? C.gold : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = kind === 'end' ? '#ffffff' : C.teal;
      ctx.lineWidth = 3 * view.dpr;
      ctx.stroke();
      ctx.restore();
      if (on('labels')) {
        label(ctx, view, sc.x, sc.y - r * 1.9,
          kind === 'end' ? 'DESTINATION' : 'START', ik, 'center');
      }
    }
  });

  /* ---------------------------------------------------- replan sweep */

  /**
   * The network-replan sweep. A single band of light crossing the map in the
   * direction of the plan, raised by animateNetworkReplan(). It draws nothing
   * at all when no sweep is in flight, which is also the case whenever the
   * operator has asked for reduced motion.
   */
  map.addOverlay((ctx, view) => {
    const sw = map.sweep;
    if (!sw) return;
    const t = (performance.now() - sw.start) / sw.duration;
    if (t >= 1 || t < 0) return;
    const eased = 1 - (1 - t) ** 3;
    const x = -view.width * 0.3 + eased * view.width * 1.6;
    const band = view.width * 0.26;

    ctx.save();
    const g = ctx.createLinearGradient(x - band, 0, x + band, 0);
    const fade = Math.sin(Math.PI * t) ** 0.7;
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.44, withAlpha(C.tealSoft, 0.1 * fade));
    g.addColorStop(0.5, withAlpha(C.goldSoft, 0.3 * fade));
    g.addColorStop(0.56, withAlpha(C.tealSoft, 0.1 * fade));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();
  });

  /* --------------------------------------------------- pick handler */

  map.addPicker((x, y, view) => {
    const tolPx = 18 * view.dpr;
    const near = (lon, lat) => {
      const s = view.toScreen(lon, lat);
      return Math.hypot(s.x - x, s.y - y) <= tolPx;
    };
    if (on('vehicles')) {
      for (const v of store.vehicles) if (v.lon != null && near(v.lon, v.lat)) return { kind: 'vehicle', id: v.id };
    }
    if (on('deliveries')) {
      for (const o of store.orders) if (near(o.lon, o.lat)) return { kind: 'order', id: o.id };
    }
    if (on('depots')) {
      for (const d of store.depots) if (near(d.lon, d.lat)) return { kind: 'depot', id: d.id };
    }
    if (on('routes') && store.plan) {
      // Route picking uses a geographic tolerance so it behaves the same at
      // every zoom level.
      const tolKm = map.kmPerPixel() * tolPx * 0.8;
      for (const r of store.plan.routes) {
        const path = r.path || routeWaypoints(r, store);
        for (let i = 1; i < path.length; i++) {
          const a = view.toScreen(path[i - 1].lon, path[i - 1].lat);
          const b = view.toScreen(path[i].lon, path[i].lat);
          if (segmentDistance(x, y, a.x, a.y, b.x, b.y) <= tolPx * 0.7) return { kind: 'route', id: r.id };
        }
      }
    }
    return null;
  });
}

/* ------------------------------------------------------------------ */

function routeWaypoints(route, store) {
  const depot = store.depotsById.get(route.depotId);
  if (!depot) return route.stops.map((s) => ({ lon: s.lon, lat: s.lat }));
  return [
    { lon: depot.lon, lat: depot.lat },
    ...route.stops.map((s) => ({ lon: s.lon, lat: s.lat })),
    { lon: depot.lon, lat: depot.lat },
  ];
}

function trace(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

const offscreen = (s, view, pad) =>
  s.x < -pad || s.y < -pad || s.x > view.width + pad || s.y > view.height + pad;

/** Halo text so labels stay legible over any cartography. */
function label(ctx, view, x, y, text, ik, align) {
  ctx.save();
  ctx.font = `600 ${10.5 * view.dpr}px ui-monospace, monospace`;
  ctx.textAlign = align;
  ctx.lineWidth = 3.4 * view.dpr;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ik.labelHalo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = ik.label;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function recolour(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const ramp = CARBON_RAMP;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a <= 0.004) { d[i + 3] = 0; continue; }
    const t = clamp(a * 1.4, 0, 1) * (ramp.length - 1);
    const i0 = Math.floor(t), i1 = Math.min(ramp.length - 1, i0 + 1), f = t - i0;
    d[i] = ramp[i0][0] + (ramp[i1][0] - ramp[i0][0]) * f;
    d[i + 1] = ramp[i0][1] + (ramp[i1][1] - ramp[i0][1]) * f;
    d[i + 2] = ramp[i0][2] + (ramp[i1][2] - ramp[i0][2]) * f;
    d[i + 3] = Math.min(255, a * 420);
  }
  ctx.putImageData(img, 0, 0);
}

export { haversineKm };
