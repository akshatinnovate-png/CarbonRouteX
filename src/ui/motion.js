/**
 * MOTION SYSTEM
 *
 * Every animation in CarbonRoute is declared here, as a named primitive with
 * a stated purpose. Views call these; they never write their own keyframes.
 *
 * Two rules hold everywhere:
 *
 *  1. Motion carries meaning or it does not happen. A route redrawing, a
 *     camera moving to the thing you selected, the network re-planning — each
 *     of these tells you something. Decoration does not qualify.
 *
 *  2. Business logic is never inside an animation. Every primitive here is
 *     safe to make a no-op: the optimiser, the store and the engines do not
 *     know this file exists, and the application is fully usable with every
 *     animation disabled. `prefers-reduced-motion` is honoured by skipping to
 *     the end state, not by animating faster.
 */

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const mq = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : null;

export const reducedMotion = () => !!mq?.matches;

/** Curves. Named for what they express, not for their control points. */
export const EASE = {
  /** Arrivals: fast out of the gate, settles gently. */
  settle: 'cubic-bezier(.16, 1, .3, 1)',
  /** Departures: eases in, leaves decisively. */
  leave: 'cubic-bezier(.55, 0, .85, .3)',
  /** Camera and cinematic transitions. */
  cinematic: 'cubic-bezier(.65, 0, .2, 1)',
  standard: 'cubic-bezier(.22, .61, .36, 1)',
};

export const DUR = {
  micro: 140,
  quick: 260,
  panel: 420,
  view: 520,
  cinematic: 1400,
};

/**
 * The single place an element is animated. Returns a promise that resolves
 * when the motion finishes — immediately, and without animating, when motion
 * is reduced or the element is not in the document.
 */
function play(node, keyframes, options = {}) {
  if (!node || reducedMotion() || typeof node.animate !== 'function' || !node.isConnected) {
    return Promise.resolve();
  }
  try {
    const anim = node.animate(keyframes, {
      duration: options.duration ?? DUR.quick,
      easing: options.easing ?? EASE.settle,
      delay: options.delay ?? 0,
      fill: options.fill ?? 'both',
    });
    return anim.finished.then(() => { if (options.fill !== 'forwards') anim.cancel(); }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ */
/* View transitions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Move between two tabs of the application.
 *
 * Tabs are not separate products; they are angles on one logistics network.
 * So the outgoing view sinks slightly and the incoming one rises into place,
 * which reads as turning your attention rather than as loading a page.
 */
export function transitionToView(outgoing, incoming, { direction = 1 } = {}) {
  const shift = 10 * direction;
  if (outgoing && outgoing !== incoming) {
    play(outgoing, [
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: `translateY(${-shift * 0.5}px)` },
    ], { duration: DUR.micro, easing: EASE.leave, fill: 'none' });
  }
  return play(incoming, [
    { opacity: 0, transform: `translateY(${shift}px)` },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: DUR.view, easing: EASE.settle, fill: 'none' });
}

/**
 * Reveal a list or grid as a short cascade.
 *
 * The stagger is capped: past about a dozen items the delay stops growing, so
 * a fleet of two hundred vehicles does not take nine seconds to appear.
 */
export function revealStagger(nodes, { step = 34, max = 12, distance = 8 } = {}) {
  const list = Array.from(nodes || []);
  list.forEach((node, i) => {
    play(node, [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: DUR.panel, easing: EASE.settle, delay: Math.min(i, max) * step, fill: 'none' });
  });
}

/* ------------------------------------------------------------------ */
/* Panels                                                               */
/* ------------------------------------------------------------------ */

/** A panel arriving: it comes from the edge it is anchored to. */
export function openPanel(node, { from = 'right' } = {}) {
  const off = { right: 'translateX(14px)', left: 'translateX(-14px)', bottom: 'translateY(18px)', top: 'translateY(-14px)' }[from]
    || 'translateY(10px)';
  return play(node, [
    { opacity: 0, transform: `${off} scale(.99)` },
    { opacity: 1, transform: 'none' },
  ], { duration: DUR.panel, easing: EASE.settle, fill: 'none' });
}

/**
 * A panel leaving. Resolves after the motion so the caller can remove the
 * node — and resolves immediately under reduced motion, which is why callers
 * must always await rather than assume a delay.
 */
export function closePanel(node, { from = 'right' } = {}) {
  const off = { right: 'translateX(14px)', left: 'translateX(-14px)', bottom: 'translateY(18px)', top: 'translateY(-14px)' }[from]
    || 'translateY(10px)';
  return play(node, [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: off },
  ], { duration: DUR.quick, easing: EASE.leave, fill: 'forwards' });
}

/* ------------------------------------------------------------------ */
/* Map camera                                                           */
/* ------------------------------------------------------------------ */

/**
 * Move the camera to one entity.
 *
 * The camera pulls back before it moves in when the jump is long, the way a
 * person zooms out to get their bearings before zooming in somewhere else.
 * Short hops go directly, because the interruption would cost more than it
 * explains.
 */
export function focusEntity(map, entity, { zoom, pullback = true } = {}) {
  if (!map || !entity || entity.lon == null || entity.lat == null) return Promise.resolve();
  const target = zoom ?? Math.max(map.zoom ?? 12, 14.5);

  if (reducedMotion()) {
    map.setView(entity.lon, entity.lat, target, { animate: false });
    return Promise.resolve();
  }

  const far = distanceInScreens(map, entity) > 1.4;
  if (!pullback || !far) {
    map.setView(entity.lon, entity.lat, target, { duration: 620 });
    return wait(640);
  }

  const mid = {
    lon: ((map.centre?.lon ?? entity.lon) + entity.lon) / 2,
    lat: ((map.centre?.lat ?? entity.lat) + entity.lat) / 2,
  };
  map.setView(mid.lon, mid.lat, Math.max((map.zoom ?? 12) - 1.6, 4), { duration: 480 });
  return wait(470).then(() => {
    map.setView(entity.lon, entity.lat, target, { duration: 760 });
    return wait(780);
  });
}

/** Fit the camera to a set of points with a cinematic, unhurried easing. */
export function frameNetwork(map, points, { padding = 110 } = {}) {
  if (!map || !points?.length) return Promise.resolve();
  map.fit(points, { padding, animate: !reducedMotion() });
  return wait(reducedMotion() ? 0 : 660);
}

function distanceInScreens(map, entity) {
  try {
    const v = map.view;
    const s = v.toScreen(entity.lon, entity.lat);
    const dx = (s.x / v.dpr - v.width / (2 * v.dpr)) / (v.width / v.dpr);
    const dy = (s.y / v.dpr - v.height / (2 * v.dpr)) / (v.height / v.dpr);
    return Math.hypot(dx, dy) * 2;
  } catch {
    return 2;
  }
}

/* ------------------------------------------------------------------ */
/* Network storytelling                                                 */
/* ------------------------------------------------------------------ */

/**
 * A route has changed. The map is a canvas, so this does not animate DOM —
 * it raises a short-lived highlight that the overlay layer reads while
 * drawing, and asks for repaints until it expires.
 */
export function animateRouteChange(map, routeIds = [], { duration = 900 } = {}) {
  if (!map) return Promise.resolve();
  const ids = new Set(Array.isArray(routeIds) ? routeIds : [routeIds]);
  if (reducedMotion() || !ids.size) { map.invalidate?.(); return Promise.resolve(); }
  map.highlight = { ids, until: performance.now() + duration, duration };
  return pump(map, duration).then(() => { map.highlight = null; map.invalidate?.(); });
}

/**
 * The whole network has been re-planned.
 *
 * This is the one genuinely cinematic moment in the product, so it earns a
 * sweep: a band of light crosses the map in the direction of the plan, and
 * the routes settle behind it. It is purely presentational — the plan is
 * already published and readable in every table before this begins.
 */
export function animateNetworkReplan(map, { duration = 1200 } = {}) {
  if (!map) return Promise.resolve();
  if (reducedMotion()) { map.invalidate?.(); return Promise.resolve(); }
  map.sweep = { start: performance.now(), duration };
  return pump(map, duration).then(() => { map.sweep = null; map.invalidate?.(); });
}

function pump(map, duration) {
  return new Promise((resolve) => {
    const end = performance.now() + duration;
    const step = () => {
      map.invalidate?.();
      if (performance.now() < end) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/* ------------------------------------------------------------------ */
/* Entering and leaving the command centre                              */
/* ------------------------------------------------------------------ */

/**
 * Sign-in, and the move from the landing page into the application.
 *
 * The intent is continuity: the map is already live behind the overlay, so
 * the overlay lifts away and the chrome settles in around a network that was
 * running the whole time. Nothing "loads".
 */
export function enterCommandCenter({ overlay, app, topbar, tabbar, page } = {}) {
  if (reducedMotion()) {
    if (overlay) overlay.hidden = true;
    app?.removeAttribute('aria-hidden');
    return Promise.resolve();
  }

  const lift = overlay
    ? play(overlay, [
      { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
      { opacity: 0, transform: 'scale(1.035)', filter: 'blur(10px)' },
    ], { duration: 620, easing: EASE.leave, fill: 'forwards' })
    : Promise.resolve();

  app?.removeAttribute('aria-hidden');
  play(topbar, [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }],
    { duration: 620, easing: EASE.settle, delay: 180, fill: 'none' });
  play(tabbar, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
    { duration: 620, easing: EASE.settle, delay: 280, fill: 'none' });
  play(page, [{ opacity: 0 }, { opacity: 1 }],
    { duration: 700, easing: EASE.settle, delay: 220, fill: 'none' });

  return lift.then(() => { if (overlay) overlay.hidden = true; });
}

/** Signing out: the chrome recedes and the overlay returns. */
export function exitCommandCenter({ overlay, app } = {}) {
  if (reducedMotion()) {
    app?.setAttribute('aria-hidden', 'true');
    if (overlay) overlay.hidden = false;
    return Promise.resolve();
  }
  const out = play(app, [
    { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
    { opacity: 0, transform: 'scale(.985)', filter: 'blur(6px)' },
  ], { duration: 460, easing: EASE.leave, fill: 'forwards' });

  return out.then(() => {
    app?.setAttribute('aria-hidden', 'true');
    if (overlay) {
      overlay.hidden = false;
      play(overlay, [{ opacity: 0 }, { opacity: 1 }], { duration: 460, easing: EASE.settle, fill: 'none' });
    }
    if (app) { app.style.opacity = ''; app.style.transform = ''; app.style.filter = ''; }
  });
}

/**
 * Switching between PERSONAL and LOGISTICS.
 *
 * Both modes look at the same network from different altitudes, so the
 * transition is a single continuous move rather than two separate fades.
 */
export function transitionMode(host, { to } = {}) {
  if (!host || reducedMotion()) return Promise.resolve();
  const inward = to === 'PERSONAL';
  return play(host, [
    { opacity: 0, transform: inward ? 'scale(1.03)' : 'scale(.985)' },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: 760, easing: EASE.cinematic, fill: 'none' });
}

/** A value that has just changed draws the eye once, then stops. */
export function pulseValue(node) {
  return play(node, [
    { transform: 'scale(1)', color: 'var(--gold-deep)' },
    { transform: 'scale(1.06)', color: 'var(--gold-deep)', offset: 0.3 },
    { transform: 'scale(1)' },
  ], { duration: 620, easing: EASE.settle, fill: 'none' });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
