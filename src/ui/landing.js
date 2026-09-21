/**
 * LANDING + MODE CHOOSER
 *
 * The first screen. It is not a dashboard and it is not an admin console: it
 * is white, spacious and mostly typography, with one live thing on it — the
 * real satellite map, already running.
 *
 * That last detail is deliberate. The same canvas that the application uses is
 * adopted into the hero here, so signing in does not "load" a map; the frame
 * around a network that was already moving simply opens out. Continuity is
 * cheaper and more convincing than a loading animation.
 *
 * The mode chooser that follows is a real fork. PERSONAL and LOGISTICS get
 * different tab sets, different optimisers and different vocabulary, so the
 * question is asked once, plainly, before anything else is configured.
 */

import { APP } from '../config.js';
import { el, mount, announce, focusInto } from '../util/dom.js';
import { icon } from './icons.js';
import { revealStagger } from './motion.js';

export function initLanding(store, { onChoose } = {}) {
  const root = document.getElementById('landing');
  const canvas = document.getElementById('map-canvas');
  let phase = 'hero'; // hero -> choose

  function show() {
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.getElementById('app').setAttribute('aria-hidden', 'true');
    phase = store.mode ? 'choose' : 'hero';
    render();
  }

  function hide() {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
  }

  function render() {
    mount(root, phase === 'hero' ? hero() : chooser());
    if (phase === 'hero') {
      const frame = root.querySelector('.landing-map');
      if (frame && canvas.parentElement !== frame) frame.prepend(canvas);
      revealStagger(root.querySelectorAll('.landing-fact'), { step: 70 });
    } else {
      revealStagger(root.querySelectorAll('.mode-card'), { step: 110, distance: 14 });
      const first = root.querySelector('.mode-card');
      if (first) setTimeout(() => focusInto(first), 60);
    }
  }

  /* ------------------------------------------------------------ hero */

  function hero() {
    return el('div.landing', null,
      el('header.landing-bar', null,
        el('span.landing-brand', null,
          el('span.landing-mark', { html: brandMark() }),
          el('span', null,
            el('strong', { text: 'CarbonRoute' }),
            el('small', { text: APP.tagline }))),
        el('span.spacer'),
        el('span.landing-version', { text: `v${APP.version}` })),

      el('section.landing-hero', null,
        el('div.landing-copy', null,
          el('p.landing-eyebrow', { text: 'CarbonRoute · Logistics Intelligence' }),
          el('h1.landing-title', null,
            el('span', { text: 'Optimize the Network.' }),
            el('span.gold-line', { text: 'Not Just the Route.' })),
          el('p.landing-lede', {
            text: 'Time, cost and carbon are three different answers to the same journey. '
              + 'CarbonRoute plans across real roads and shows you what each choice actually costs — '
              + 'for one commute, or for an entire fleet.',
          }),
          el('div.landing-cta', null,
            el('button.btn.btn--primary.btn--lg', {
              type: 'button',
              html: `${icon('bolt', 15)}<span>Start optimising</span>`,
              onclick: () => { phase = 'choose'; render(); announce('Choose what you are optimising'); },
            }),
            el('a.landing-link', {
              href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener',
              text: 'Built on open map data',
            }))),

        el('div.landing-map-frame', null,
          el('div.landing-map', null,
            el('div.landing-map-scrim')),
          el('div.landing-map-caption', null,
            el('span.dot-live'),
            el('span', { text: 'Live satellite basemap · Esri World Imagery' })))),

      el('section.landing-facts', null,
        landFact('map', 'Real satellite imagery',
          'A hybrid basemap: satellite underneath, roads and place names on top, so the map is usable and not merely pretty.'),
        landFact('route', 'Real road routing',
          'Distances and durations come from OpenStreetMap road geometry, not from straight lines drawn between pins.'),
        landFact('leaf', 'Carbon as an objective',
          'Emissions are optimised alongside time and cost — including the grid intensity at the hour you actually travel.'),
        landFact('chart', 'Every number explained',
          'Each result carries the calculation that produced it. Nothing is asserted that cannot be traced.')),

      el('footer.landing-foot', null,
        el('p', {
          text: 'Your data stays in this browser. The only network requests are to public map-tile, '
            + 'routing and address services.',
        })));
  }

  const landFact = (ic, title, body) => el('article.landing-fact', null,
    el('span.lf-icon', { html: icon(ic, 16) }),
    el('h3', { text: title }),
    el('p', { text: body }));

  /* --------------------------------------------------------- chooser */

  function chooser() {
    const node = el('div.landing.landing--choose', null,
      el('header.landing-bar', null,
        el('button.btn.btn--ghost.btn--sm', {
          type: 'button', text: '← Back', onclick: () => { phase = 'hero'; render(); },
        }),
        el('span.spacer'),
        el('span.landing-version', { text: `v${APP.version}` })),

      el('div.mode-shell', null,
        el('div.mode-head', null,
          el('p.landing-eyebrow', { text: 'One question before we begin' }),
          el('h1', { text: 'What are you optimising?' }),
          el('p.mode-lede', {
            text: 'This changes the application, not just the wording: different tabs, a different '
              + 'optimiser and a different set of questions. You can switch at any time from Settings.',
          })),

        el('div.mode-grid', { role: 'group', 'aria-label': 'Choose a mode' },
          modeCard({
            key: 'PERSONAL',
            title: 'Personal mobility',
            tags: ['Cars', 'Bikes', 'Trips'],
            blurb: 'One person, one vehicle, one journey. Compare the real roads between where you are and where you are going — by time, cost, energy and CO₂e.',
            points: [
              'Current location to destination',
              'Car, bike, EV, motorcycle or other',
              'Fastest · Lowest cost · Lowest emissions · Balanced',
            ],
          }),
          modeCard({
            key: 'LOGISTICS',
            title: 'Logistics operations',
            tags: ['Fleets', 'Orders', 'Depots'],
            blurb: 'A full fleet intelligence environment: depots, vehicles, an order book, constrained vehicle routing, scenario simulation and a carbon ledger.',
            points: [
              'Capacity, range and time-window constrained routing',
              'Pareto frontier across five objectives',
              'What-if simulation against the published plan',
            ],
          })),

        el('p.mode-foot', {
          text: 'Both modes use the same physics: the same energy curve, the same well-to-wheel '
            + 'emission factors and the same hourly grid intensity.',
        })));
    return node;
  }

  function modeCard({ key, title, tags, blurb, points }) {
    return el('button.mode-card', {
      type: 'button',
      dataset: { mode: key },
      'aria-label': `${title} mode`,
      onclick: () => choose(key),
    },
    el('div.mc-top', null,
      el('span.mc-badge', { text: key }),
      el('span.mc-arrow', { html: icon('chevron', 15) })),
    el('h2', { text: title }),
    el('div.mc-tags', null, ...tags.map((t) => el('span', { text: t }))),
    el('p', { text: blurb }),
    el('ul.mc-points', null, ...points.map((p) => el('li', null,
      el('span', { html: icon('check', 11) }),
      el('span', { text: p })))));
  }

  function choose(mode) {
    store.setMode(mode, { silent: true });
    announce(mode === 'PERSONAL' ? 'Personal mobility selected' : 'Logistics operations selected');
    const card = root.querySelector(`.mode-card[data-mode="${mode}"]`);
    if (card) card.dataset.chosen = 'true';
    // Let the choice register visually before the screen changes under them.
    setTimeout(() => { hide(); onChoose?.(mode); }, 240);
  }

  return { show, hide, isOpen: () => !root.hidden, get phase() { return phase; } };
}

export function brandMark() {
  return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M6 22c4-10 16-10 20 0" stroke="#0d8f8f" stroke-width="2.9" stroke-linecap="round"/>
    <circle cx="6" cy="22" r="3.2" fill="#07636a"/>
    <circle cx="26" cy="22" r="3.2" fill="#b08423"/>
    <circle cx="16" cy="13.2" r="2.3" fill="#d4a843"/>
  </svg>`;
}
