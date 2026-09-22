/**
 * TRIP PAGE — PERSONAL mode.
 *
 * One person, one vehicle, one journey. Where am I, where am I going, and
 * which of the real roads between the two should I take?
 *
 * Everything the fleet side offers that does not apply to a single trip is
 * absent here on purpose: no depots, no capacity, no duty cycle, no dispatch.
 * What remains is the comparison that matters — time against cost against
 * carbon — on real road geometry.
 */

import { PERSONAL_VEHICLES, PERSONAL_OPTIONS, APP } from '../../config.js';
import { departureSweep, tripLedger } from '../../engines/personal.js';
import { viaLabel } from '../../services/osrm.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { clock, dur, kg as fkg, money, num } from '../../util/format.js';
import { icon } from '../icons.js';
import { card, kv, empty, locationPicker, timeInput, chip, statTile } from '../components.js';
import {
  focusEntity, frameNetwork, revealStagger, openPanel, reducedMotion,
  countTo, flashDelta, revealRoute, focusStep,
} from '../motion.js';

export function tripPage(store, map) {
  const canvas = document.getElementById('map-canvas');
  const root = el('div.trip-page');

  const panel = el('aside.trip-panel');
  const stage = el('div.map-stage', null,
    canvas,
    el('div.map-overlay', null,
      el('div.map-overlay-top', null, el('div.trip-hero', { id: 'trip-hero' }), el('span.spacer'), tools()),
      el('span'),
      el('div.map-overlay-bottom', null,
        el('div.map-attrib', { id: 'trip-attrib' }), el('span.spacer'))));

  mount(root, panel, stage);

  /** The map page and this page share one canvas; whoever is visible owns it. */
  root.adoptCanvas = () => { if (canvas.parentElement !== stage) stage.prepend(canvas); };

  function tools() {
    const toolBtn = (name, label, fn) => el('button.tool-btn', {
      type: 'button', title: label, 'aria-label': label, html: icon(name), onclick: fn,
    });
    return el('div.map-tools', null,
      el('div.tool-group', null,
        toolBtn('plus', 'Zoom in', () => map.zoomBy(1)),
        toolBtn('minus', 'Zoom out', () => map.zoomBy(-1))),
      el('div.tool-group', null,
        toolBtn('route', 'Frame the journey', () => frameTrip()),
        toolBtn('target', 'Go to my start point', () => {
          const o = store.personal.origin;
          if (o) focusEntity(map, o, { zoom: 15 });
        })));
  }

  function frameTrip() {
    const t = store.trip;
    const pts = t?.chosen?.trip?.points?.length
      ? t.chosen.trip.points
      : [store.personal.origin, store.personal.destination].filter(Boolean);
    if (pts.length) frameNetwork(map, pts, { padding: 120 });
  }

  /* ---------------------------------------------------------- form */

  let originPicker = null;
  let destPicker = null;
  let departAt = null;
  let leaveNow = store.personal.departMinutes == null;

  function buildForm() {
    const p = store.personal;

    originPicker = locationPicker(store, {
      value: p.origin, placeholder: 'Where are you starting from?',
    });
    destPicker = locationPicker(store, {
      value: p.destination, placeholder: 'Where are you going?',
    });
    departAt = timeInput({ minutes: p.departMinutes ?? nowMinutes() });

    const useMyLocation = el('button.btn.btn--sm.btn--block', {
      type: 'button', html: `${icon('target', 12)}<span>Use my current location</span>`,
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Locating…';
        const place = await currentLocation(store);
        btn.disabled = false;
        mount(btn, el('span', { html: `${icon('target', 12)}<span>Use my current location</span>` }));
        if (!place) {
          emit(EV.TOAST, {
            message: 'Your browser would not share a location. Search for your starting point instead.',
            tone: 'bad',
          });
          return;
        }
        originPicker.setValue(place);
        announce(`Start set to ${place.short}`);
        focusEntity(map, place, { zoom: 14 });
      },
    });

    const swap = el('button.btn.btn--ghost.btn--sm.trip-swap', {
      type: 'button', title: 'Swap start and destination', 'aria-label': 'Swap start and destination',
      html: icon('swap', 13),
      onclick: () => {
        const a = originPicker.getValue();
        const b = destPicker.getValue();
        originPicker.setValue(b);
        destPicker.setValue(a);
        announce('Start and destination swapped');
      },
    });

    return el('div.trip-form', null,
      el('div.trip-endpoints', null,
        el('div.trip-endpoint', null,
          el('span.trip-dot', { dataset: { kind: 'start' } }),
          el('div.trip-endpoint-body', null,
            el('span.label', { text: 'Start' }),
            originPicker,
            useMyLocation)),
        swap,
        el('div.trip-endpoint', null,
          el('span.trip-dot', { dataset: { kind: 'end' } }),
          el('div.trip-endpoint-body', null,
            el('span.label', { text: 'Destination' }),
            destPicker))),

      el('div.trip-field', null,
        el('span.label', { text: 'Vehicle' }),
        el('div.vehicle-picker', { role: 'radiogroup', 'aria-label': 'Vehicle type' },
          ...Object.values(PERSONAL_VEHICLES).map((v) => el('button.vehicle-chip', {
            type: 'button', role: 'radio',
            'aria-checked': String(store.personal.vehicleKey === v.key),
            title: v.note,
            onclick: () => { store.setPersonal({ vehicleKey: v.key }); render(); recompute(); },
          },
          el('span.vc-icon', { html: icon(v.icon, 15) }),
          el('span.vc-label', { text: v.label }))))),

      el('div.trip-field', null,
        el('span.label', { text: 'Departure' }),
        el('div.row.wrap', null,
          el('div.segmented', { role: 'group', 'aria-label': 'Departure time' },
            el('button', {
              type: 'button', text: 'Leave now', 'aria-pressed': String(leaveNow),
              onclick: () => { leaveNow = true; render(); },
            }),
            el('button', {
              type: 'button', text: 'At a set time', 'aria-pressed': String(!leaveNow),
              onclick: () => { leaveNow = false; render(); },
            })),
          leaveNow ? null : departAt)),

      el('button.btn-optimize', {
        type: 'button',
        disabled: store.tripPending,
        html: store.tripPending
          ? `<span class="spin">${icon('refresh', 15)}</span><span>Finding routes…</span>`
          : `${icon('bolt', 15)}<span>Compare routes</span>`,
        onclick: () => recompute(),
      }));
  }

  async function recompute() {
    const origin = originPicker?.getValue() || store.personal.origin;
    const destination = destPicker?.getValue() || store.personal.destination;
    if (!origin || !destination) {
      emit(EV.TOAST, { message: 'Set both a start and a destination first.', tone: 'bad' });
      return;
    }
    const departMinutes = leaveNow ? null : departAt?.getMinutes();
    const trip = await store.planTrip({ origin, destination, departMinutes });
    if (trip) {
      // Frame first, then draw the line into the frame we just settled on.
      await frameNetwork(map, trip.chosen?.trip?.points || [origin, destination], { padding: 130 });
      revealRoute(map, { duration: 1000 });
      announce(`${trip.options.length} route options compared`);
      // The answer is below the form, so bring it into view rather than
      // leaving somebody to wonder whether anything happened.
      requestAnimationFrame(() => {
        panel.querySelector('.route-options')?.scrollIntoView({
          behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start',
        });
      });
    }
  }

  /* -------------------------------------------------------- results */

  function resultsBlock() {
    if (store.tripError) {
      return el('div.notice.notice--bad', null,
        el('span', { html: icon('alert', 15) }),
        el('p', { text: store.tripError }));
    }
    if (store.tripPending) {
      // Skeletons in the shape of the answer, not a spinner: the layout does
      // not jump when the real cards arrive, and the wait tells you what is
      // being waited for.
      return el('div.stack', null,
        el('p.field-hint', { text: 'Asking the routing service for real road alternatives…' }),
        el('div.route-options', null, ...PERSONAL_OPTIONS.map((o, i) => el('div.route-option.is-skeleton', {
          style: { '--skeleton-delay': `${i * 90}ms` }, 'aria-hidden': 'true',
        },
        el('div.ro-head', null, el('span.sk.sk-title'), el('span.spacer'), el('span.sk.sk-pill')),
        el('span.sk.sk-line'),
        el('div.ro-metrics', null, ...Array.from({ length: 5 }, () => el('span.sk.sk-metric')))))),
        el('span.sr-only', { role: 'status', text: 'Comparing routes' }));
    }
    const trip = store.trip;
    if (!trip) {
      return empty('No journey compared yet.',
        'Set a start and a destination, then compare routes.');
    }

    const chosenId = trip.chosen?.trip?.id;
    const cards = trip.options.map((o) => {
      const t = o.trip;
      const isBest = {
        time: Math.abs(t.minutes - trip.best.minutes) < 0.01,
        cost: Math.abs(t.cost - trip.best.cost) < 0.01,
        co2: Math.abs(t.co2 - trip.best.co2) < 1e-4,
      };
      const isChosen = o.key === store.personal.optionKey;
      const onChosenRoad = t.id === trip.chosenRoadId;
      return el('button.route-option', {
        type: 'button',
        'aria-pressed': String(isChosen),
        // Gold marks the one option you have chosen. Other options that
        // resolved to the same road are marked as such, but not highlighted:
        // two gold cards would leave it unclear which one the map is drawing.
        dataset: { selected: String(isChosen), sameroad: String(!isChosen && onChosenRoad) },
        onclick: () => {
          store.selectTripOption(o.key);
          // Re-trace: the new choice draws itself over the old one.
          revealRoute(map, { duration: 760 });
        },
      },
      el('div.ro-head', null,
        el('strong', { text: o.label }),
        el('span.ro-time', { text: dur(t.minutes, { compact: true }) }),
        el('span.spacer'),
        o.sharedWith ? chip('same road', '') : null),
      // What a person would call this route, when the router told us.
      viaLabel(t.roads) ? el('p.ro-via', null,
        el('span', { html: icon('route', 11) }),
        el('span', { text: `via ${viaLabel(t.roads)}` })) : null,
      el('p.ro-blurb', { text: o.blurb }),
      el('div.ro-metrics', null,
        metric('ETA', clock(Math.round(t.arriveMinutes)), '', isBest.time),
        metric('Distance', `${t.km.toFixed(1)}`, 'km', false),
        metric('Energy', t.units > 0 ? t.units.toFixed(2) : '0', t.unitLabel || 'none', false),
        metric('Cost', money(t.cost, 0), APP.currency, isBest.cost),
        metric('CO₂e', fkg(t.co2, 2), '', isBest.co2)));
    });

    // Roads that exist, were costed, and that no objective happened to pick.
    // They are on the map either way; leaving them unclickable would be a
    // strange kind of half-honesty.
    const optionRoads = new Set(trip.options.map((o) => o.trip.id));
    const others = trip.trips.filter((t) => !optionRoads.has(t.id));

    const chosen = trip.chosen;
    return el('div.stack', null,
      el('div.route-options', null, ...cards),
      others.length ? card(`Other roads found (${others.length})`,
        chip(`${trip.roadsFound} compared`, ''),
        el('p.field-hint', {
          text: 'No objective picked these, but they are real roads between the same two points — '
            + 'drawn in teal on the map. Choose one if you know something the maths does not.',
        }),
        el('div.stack-sm', null, ...others.map((t) => el('button.mini-row.road-row', {
          type: 'button',
          'aria-current': String(t.id === trip.chosenRoadId),
          onclick: () => {
            store.selectTripRoad(t.id);
            revealRoute(map, { duration: 760 });
          },
        },
        el('span.mini-bar', { style: { background: 'var(--teal)' } }),
        el('span.mini-text', null,
          el('strong', { text: viaLabel(t.roads) || `${t.km.toFixed(1)} km route` }),
          el('small', {
            text: `${t.km.toFixed(1)} km · ${dur(t.minutes, { compact: true })} · `
              + `arrives ${clock(Math.round(t.arriveMinutes))} · ${money(t.cost, 0)} · ${fkg(t.co2, 2)} CO₂e`,
          })))))) : null,
      departureCard(trip),
      directionsCard(trip),
      chosen ? card('Why this route',
        chip(chosen.label, 'gold'),
        el('div.explain', null,
          el('div.why-title', { text: 'What produced this answer' }),
          trip.versusFastest ? el('p', { text: trip.versusFastest }) : null,
          el('ul.drivers', null, ...trip.drivers.map((d) => el('li', { dataset: { sign: d.sign } },
            el('span.sign', { text: d.sign }),
            el('span', null,
              el('span.d-label', { text: d.label }),
              el('span.d-detail', { text: d.detail })))))),
        el('p.basis', {
          text: trip.estimated
            ? 'Road geometry unavailable — distances are straight-line estimates. Energy, cost and CO₂e are modelled from published factors, not measured.'
            : 'Roads and durations come from live OpenStreetMap routing. Where the router offers few '
              + 'alternatives, further routes are found by asking it to pass through points either side of '
              + 'the direct line — every road shown is one the routing service returned. Energy, cost and '
              + 'CO₂e are estimates from published factors applied to that geometry, not measurements from '
              + 'your vehicle.',
        })) : null,
      ledgerCard());
  }

  /**
   * The carbon ledger.
   *
   * A product named CarbonRoute that forgets every journey the moment you
   * close it is not really keeping an account of anything. Two numbers here,
   * deliberately kept apart: what these journeys actually emitted, which is a
   * real total, and how much less that was than the worst road on offer at the
   * time — a counterfactual, labelled as one. Driving a cleaner route than you
   * might have is not the same as not driving, and the wording says so.
   */
  function ledgerCard() {
    const ledger = tripLedger(store.personal.history);
    if (!ledger.trips) return null;

    const peak = Math.max(...ledger.recent.map((h) => h.co2), 1e-9);

    return card(`Your carbon ledger (${ledger.trips} journey${ledger.trips === 1 ? '' : 's'})`,
      ledger.comparable
        ? chip(`cleanest road ${ledger.cleanestPicks}/${ledger.comparable}`, ledger.cleanestPicks === ledger.comparable ? 'gold' : '')
        : null,
      el('div.tile-row', null,
        statTile('Emitted', fkg(ledger.emitted, 1), { sub: 'total' }),
        statTile('Travelled', num(ledger.km, 0), { sub: 'km' }),
        statTile('Per km', ledger.perKm.toFixed(3), { sub: 'kg CO₂e' }),
        ledger.avoided > 0.005
          ? statTile('Avoided', fkg(ledger.avoided, 2), { sub: 'vs worst road', tone: 'gold' })
          : null),

      // A bar per journey, newest last, so a run of heavy trips is visible as
      // a shape rather than only as a total.
      ledger.recent.length > 1
        ? el('div.ledger-strip', { 'aria-hidden': 'true' },
          ...[...ledger.recent].reverse().map((h) => el('span.ledger-bar', {
            style: { height: `${18 + 82 * (h.co2 / peak)}%` },
            title: `${h.from} → ${h.to} · ${fkg(h.co2, 2)}`,
          })))
        : null,

      el('div.stack-sm', null, ...ledger.recent.slice(0, 5).map((h) => el('div.mini-row', null,
        el('span.mini-bar', { style: { background: 'var(--teal)' } }),
        el('span.mini-text', null,
          el('strong', { text: `${h.from} → ${h.to}` }),
          el('small', {
            text: [
              h.km != null ? `${h.km.toFixed(1)} km` : null,
              h.co2 != null ? `${h.co2.toFixed(2)} kg CO₂e` : null,
              h.option ? optionLabel(h.option) : null,
              PERSONAL_VEHICLES[h.vehicleKey]?.label,
            ].filter(Boolean).join(' · '),
          }))))),

      el('p.basis', {
        text: ledger.avoided > 0.005
          ? '“Avoided” compares each journey with the dirtiest road that was offered for it. '
            + 'It is a comparison against a road not taken, not a reduction in absolute terms — '
            + 'a cleaner drive is still a drive.'
          : 'Totals are estimates from published factors applied to real road geometry, not measurements.',
      }));
  }

  /**
   * Turn-by-turn directions.
   *
   * The manoeuvre data arrives with the road names we already ask for, so not
   * showing it would be withholding the one thing somebody needs in order to
   * actually drive the route. It doubles as the text equivalent of the map:
   * an ordered list that a screen reader can read straight through.
   *
   * Hovering or focusing a step holds that junction on the map, because
   * "turn left onto NH-33" is only useful once you can see where.
   */
  function directionsCard(trip) {
    const steps = trip.chosen?.trip?.steps || [];
    if (!steps.length) return null;

    const rows = steps.map((step, i) => el('li.dir-step', {
      tabindex: '0',
      onmouseenter: () => focusStep(map, step),
      onmouseleave: () => focusStep(map, null),
      onfocus: () => {
        focusStep(map, step);
        if (Number.isFinite(step.lon)) focusEntity(map, step, { zoom: 15, pullback: false });
      },
      onblur: () => focusStep(map, null),
      onclick: () => {
        if (Number.isFinite(step.lon)) focusEntity(map, step, { zoom: 16, pullback: false });
      },
    },
    el('span.dir-index', { text: String(i + 1) }),
    el('span.dir-body', null,
      el('span.dir-text', { text: step.text }),
      step.km > 0.01
        ? el('span.dir-dist', { text: `${step.km < 1 ? `${Math.round(step.km * 1000)} m` : `${step.km.toFixed(1)} km`}` })
        : null)));

    return card(`Directions (${steps.length})`,
      chip(`${trip.chosen.trip.km.toFixed(1)} km`, ''),
      el('ol.dir-list', { 'aria-label': 'Turn by turn directions' }, ...rows),
      el('p.basis', {
        text: 'Hover or tab through a step to hold that junction on the map. '
          + 'Directions come from the routing service; check signage against reality.',
      }));
  }

  /**
   * "When should I leave?"
   *
   * The explanation layer could already observe that another hour would be
   * cleaner. This is what turns that from a remark into a control: every
   * departure slot is costed, the quiet one is marked, and choosing it
   * re-plans the journey at that time.
   */
  function departureCard(trip) {
    const road = trip.chosen?.trip;
    if (!road) return null;
    const custom = store.personal.vehicles.find(
      (v) => v.key === store.personal.vehicleKey && Number.isFinite(v.consumption),
    );
    const sweep = departureSweep(road, {
      vehicleKey: store.personal.vehicleKey,
      fromMinutes: trip.departMinutes,
      hours: 12,
      consumption: custom?.consumption,
    });
    if (!sweep.slots.length) return null;

    const peak = Math.max(...sweep.slots.map((s) => s.co2));
    const floor = Math.min(...sweep.slots.map((s) => s.co2));
    const span = Math.max(peak - floor, 1e-9);

    const bars = sweep.slots.map((slot) => {
      const isBest = slot.departMinutes === sweep.best.departMinutes;
      const isNow = slot.departMinutes === sweep.now.departMinutes;
      // Height encodes CO2e against the range of the day, floored so that the
      // cleanest hour is still a visible bar rather than nothing at all.
      const h = 22 + 78 * ((slot.co2 - floor) / span);
      return el('button.dep-slot', {
        type: 'button',
        dataset: { best: String(isBest), now: String(isNow) },
        'aria-label': `Leave at ${clock(slot.departMinutes)}: `
          + `${fkg(slot.co2, 2)} CO₂e, ${Math.round(slot.minutes)} minutes, `
          + `arriving ${clock(Math.round(slot.arriveMinutes))}`,
        title: `${clock(slot.departMinutes)} — ${fkg(slot.co2, 2)} · ${dur(slot.minutes, { compact: true })}`,
        onclick: () => {
          leaveNow = false;
          store.planTrip({ departMinutes: slot.departMinutes });
          announce(`Departure set to ${clock(slot.departMinutes)}`);
        },
      },
      el('span.dep-bar', { style: { height: `${h}%` } }),
      el('span.dep-time', { text: clock(slot.departMinutes).slice(0, 2) }));
    });

    return card('When should I leave?',
      sweep.worthWaiting ? chip('a cleaner hour exists', 'gold') : chip('now is fine', ''),
      el('p.field-hint', {
        text: 'Every hour costed for this road and this vehicle. Taller means dirtier — '
          + 'traffic burns fuel, and an electric vehicle also tracks the grid.',
      }),
      el('div.dep-strip', { role: 'group', 'aria-label': 'Departure times' }, ...bars),
      sweep.worthWaiting
        ? el('div.explain', null,
          el('div.why-title', { text: 'Worth waiting for' }),
          el('p', {
            text: `Leaving at ${clock(sweep.best.departMinutes)} instead of `
              + `${clock(sweep.now.departMinutes)} saves ${fkg(sweep.co2Saved, 2)} of CO₂e`
              + (sweep.minutesSaved > 1
                ? ` and ${Math.round(sweep.minutesSaved)} minutes of driving.`
                : ' on the same road.'),
          }))
        : el('p.basis', {
          text: 'Nothing meaningful to gain by waiting — this is already a good time to travel.',
        }));
  }

  const metric = (label, value, unit, best) => el('div.ro-metric', { dataset: { best: String(!!best) } },
    el('span.k', { text: label }),
    el('span.v', null, el('span.num', { text: String(value) }), unit ? el('small', { text: unit }) : null));

  /* ---------------------------------------------------------- render */

  const render = raf1(() => {
    mount(panel,
      el('div.trip-panel-inner', null,
        el('header.trip-head', null,
          el('span.eyebrow', { text: 'Personal mobility' }),
          el('h1', { text: 'Plan a journey' }),
          el('p', { text: 'Real roads, compared four ways. Time, cost and carbon are not the same route.' })),
        buildForm(),
        el('div.hr'),
        resultsBlock()));
    renderHero();
    openPanel(panel, { from: 'left' });
    revealStagger(panel.querySelectorAll('.route-option'));
  });

  /** Hero figures are rebuilt only once; after that their values travel. */
  let heroCells = null;

  function renderHero() {
    const host = document.getElementById('trip-hero');
    if (!host) return;
    const t = store.trip?.chosen?.trip;
    if (!t) { mount(host); host.className = 'trip-hero'; heroCells = null; return; }

    if (!heroCells || host.childElementCount === 0) {
      host.className = 'trip-hero hero-strip';
      const cells = {
        eta: stat('ETA', '--:--', '', 'gold'),
        journey: stat('Journey', '0m', ''),
        km: stat('Distance', '0', 'km'),
        co2: stat('CO₂e', '0.00', 'kg', 'green'),
      };
      mount(host, cells.eta, cells.journey, cells.km, cells.co2);
      heroCells = Object.fromEntries(
        Object.entries(cells).map(([k, node]) => [k, node.querySelector('.v .val')]),
      );
    }

    // Counting these tells you the plan changed and roughly by how much —
    // which is exactly what you are looking for after picking a new road.
    countTo(heroCells.eta, t.arriveMinutes, (v) => clock(Math.round(v)));
    countTo(heroCells.journey, t.minutes, (v) => dur(v, { compact: true }));
    countTo(heroCells.km, t.km, (v) => v.toFixed(1));
    countTo(heroCells.co2, t.co2, (v) => v.toFixed(2));
    for (const node of Object.values(heroCells)) flashDelta(node);
    const attrib = document.getElementById('trip-attrib');
    if (attrib) {
      attrib.className = 'map-attrib attrib-bar';
      mount(attrib, el('span', {
        text: store.trip.estimated
          ? 'Straight-line estimate — routing service unreachable'
          : 'Roads © OpenStreetMap contributors · Imagery © Esri',
      }));
    }
  }

  const stat = (k, v, sub, tone = '') => el('div.hero-stat', { dataset: { tone } },
    el('span.k', { text: k }),
    el('span.v', null, el('span.val', { text: v }), sub ? el('small', { text: sub }) : null));

  on(EV.TRIP_CHANGED, render);
  on(EV.ENTITIES_CHANGED, render);
  render();
  return root;
}

/* ------------------------------------------------------------------ */

const optionLabel = (key) => PERSONAL_OPTIONS.find((o) => o.key === key)?.label || key;

const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * The browser's own geolocation, reverse-geocoded to a readable place.
 * Resolves to null rather than throwing when permission is refused, because a
 * refused location is an ordinary answer and not an error state.
 */
function currentLocation(store) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { longitude: lon, latitude: lat } = pos.coords;
        try {
          resolve(await store.geocode.reverse(lon, lat));
        } catch {
          resolve({ lon, lat, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, short: 'My location' });
        }
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 },
    );
  });
}
