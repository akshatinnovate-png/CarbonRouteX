/**
 * SETTINGS PAGE — basemap, routing service, account and workspace data.
 */

import { APP } from '../../config.js';
import { EV, emit, on } from '../../core/bus.js';
import { el, mount, raf1, announce } from '../../util/dom.js';
import { num } from '../../util/format.js';
import { TILE_PROVIDERS, makeProvider, customProvider } from '../../services/tiles.js';
import { OSRM_DEFAULT_ENDPOINT } from '../../services/osrm.js';
import { GEOCODE_ATTRIBUTION, GEOCODE_DEFAULT_ENDPOINT } from '../../services/geocode.js';
import { storageAvailable } from '../../core/storage.js';
import { icon } from '../icons.js';
import { page, card, kv, field, textInput, chip, confirmButton, statTile } from '../components.js';

export function settingsPage(store, map) {
  const root = el('div.page-root');

  const render = raf1(() => {
    mount(root, page('Settings', 'Basemap, routing service, workspace data and account.',
      el('div.stack', null,
        modeCard(),
        el('div.grid-2', null, basemapCard(), routingCard()),
        el('div.grid-2', null, accountCard(), dataCard()),
        aboutCard())));
  });

  /* --------------------------------------------------------- mode */

  /**
   * Switching mode is not destructive: the fleet workspace and the personal
   * garage are stored separately, so going one way and back leaves both
   * exactly as they were.
   */
  function modeCard() {
    const MODES = [
      { key: 'PERSONAL', label: 'Personal mobility', sub: 'Cars · Bikes · Trips',
        blurb: 'One person, one vehicle, one journey compared four ways.' },
      { key: 'LOGISTICS', label: 'Logistics operations', sub: 'Fleets · Orders · Depots',
        blurb: 'Depots, an order book, constrained routing and scenario simulation.' },
    ];
    return card('Mode',
      chip(store.mode || 'unset', store.mode === 'PERSONAL' ? '' : 'gold'),
      el('div.mode-switch', null, ...MODES.map((m) => el('button.mode-switch-card', {
        type: 'button',
        'aria-pressed': String(store.mode === m.key),
        disabled: store.mode === m.key,
        onclick: () => {
          store.setMode(m.key);
          announce(`${m.label} mode`);
          render();
        },
      },
      el('span.msc-badge', { text: m.key }),
      el('strong', { text: m.label }),
      el('small', { text: m.sub }),
      el('p', { text: m.blurb })))),
      el('p.basis', {
        text: 'Your fleet workspace and your personal garage are stored separately. '
          + 'Switching between modes never discards either.',
      }));
  }

  /* ------------------------------------------------------ basemap */

  function basemapCard() {
    const s = store.settings;
    const customUrl = textInput({
      value: s.customTileUrl || '',
      placeholder: 'https://tiles.example.com/{z}/{x}/{y}.png',
    });
    return card('Basemap', null,
      el('div.stack-sm', null,
        el('div.provider-grid', null, ...Object.values(TILE_PROVIDERS).map((p) => el('button.provider', {
          type: 'button',
          'aria-pressed': String(s.tileProvider === p.key),
          onclick: () => {
            store.updateSettings({ tileProvider: p.key, customTileUrl: '' });
            map.setProvider(makeProvider(p.key));
            render();
          },
        },
        el('span.provider-swatch', { dataset: { theme: p.theme } }),
        el('span', null, el('strong', { text: p.label }), el('small', { text: p.attribution }))))),
        field('Custom XYZ tile template', customUrl, {
          hint: 'For a self-hosted tile server. Supports {z}/{x}/{y} and optional {s} subdomain.',
        }),
        el('div.row', null,
          el('button.btn.btn--sm', {
            type: 'button', text: 'Use custom tiles',
            onclick: () => {
              const url = customUrl.value.trim();
              if (!/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url)) {
                emit(EV.TOAST, { message: 'A tile template must contain {z}, {x} and {y}.', tone: 'bad' });
                return;
              }
              store.updateSettings({ customTileUrl: url, tileProvider: 'custom' });
              map.setProvider(customProvider(url));
              emit(EV.TOAST, { message: 'Custom tile source applied.', tone: 'good' });
              render();
            },
          })),
        el('p.basis', {
          text: 'Map data is © OpenStreetMap contributors, used under the Open Database License. '
            + 'Attribution is shown permanently on the map and must stay there.',
        })));
  }

  /* ------------------------------------------------------ routing */

  function routingCard() {
    const s = store.settings;
    const endpoint = textInput({
      value: s.osrmEndpoint || '',
      placeholder: OSRM_DEFAULT_ENDPOINT,
    });
    const geocodeEndpoint = textInput({
      value: s.geocodeEndpoint || '',
      placeholder: GEOCODE_DEFAULT_ENDPOINT,
    });
    const status = store.serviceStatus;
    return card('Routing service',
      chip(status.routing === 'ok' ? 'Reachable' : status.routing === 'unknown' ? 'Checking' : 'Unreachable',
        status.routing === 'ok' ? 'green' : status.routing === 'unknown' ? '' : 'red'),
      el('div.stack-sm', null,
        el('dl.kv', null,
          ...kv('Road matrix', store.matrix.ready ? `${store.matrix.size} × ${store.matrix.size}` : 'not built'),
          ...kv('Distance source', store.matrix.ready ? (store.matrix.estimated ? 'straight-line estimates' : 'real road routing') : '—'),
          ...kv('Table requests', num(store.osrm.stats.tableRequests)),
          ...kv('Route requests', num(store.osrm.stats.routeRequests)),
          ...kv('Geometry cache hits', num(store.osrm.stats.cacheHits)),
          ...kv('Failures', num(store.osrm.stats.failures), store.osrm.stats.failures ? 'var(--gold-deep)' : undefined)),
        status.message ? el('p.basis', { style: { color: 'var(--gold-deep)' }, text: status.message }) : null,
        field('OSRM endpoint', endpoint, {
          hint: 'Leave blank to use the free public demo server. Point this at your own OSRM instance for production volumes.',
        }),
        field('Geocoding endpoint', geocodeEndpoint, {
          hint: 'Leave blank to use the public Nominatim instance, which asks for at most one request per second.',
        }),
        el('div.row.wrap', null,
          el('button.btn.btn--sm', {
            type: 'button', text: 'Apply endpoints',
            onclick: () => {
              store.updateSettings({ osrmEndpoint: endpoint.value.trim() });
              emit(EV.TOAST, { message: 'Routing endpoint updated — re-checking availability.', tone: 'info' });
            },
          }),
          el('button.btn.btn--sm', {
            type: 'button', text: 'Re-check services',
            onclick: async () => {
              await store.probeServices();
              render();
            },
          }),
          el('button.btn.btn--sm', {
            type: 'button', text: 'Rebuild road matrix',
            disabled: store.optimizing,
            onclick: async () => {
              await store.buildMatrix({ force: true });
              emit(EV.TOAST, { message: 'Road matrix rebuilt.', tone: 'good' });
              render();
            },
          })),
        el('p.basis', {
          text: 'The public OSRM demo server is rate-limited and offers no uptime guarantee. '
            + 'When it is unreachable, CarbonRoute falls back to straight-line estimates and labels every affected figure.',
        })));
  }

  /* ------------------------------------------------------ account */

  function accountCard() {
    const a = store.workspace.account;
    const name = textInput({ value: a?.name || '', placeholder: 'Your name' });
    const org = textInput({ value: a?.org || '', placeholder: 'Organisation' });
    return card('Account', null,
      el('div.stack-sm', null,
        field('Name', name),
        field('Organisation', org),
        el('div.row.wrap', null,
          el('button.btn.btn--sm.btn--primary', {
            type: 'button', text: 'Save',
            onclick: () => {
              if (!name.value.trim()) { emit(EV.TOAST, { message: 'A name is required.', tone: 'bad' }); return; }
              store.signIn({ name: name.value, org: org.value });
              emit(EV.TOAST, { message: 'Account updated.', tone: 'good' });
              render();
            },
          }),
          el('button.btn.btn--sm', {
            type: 'button', text: 'Sign out',
            onclick: () => { store.signOut(); location.reload(); },
          })),
        el('p.basis', {
          text: 'This is a local sign-in with no password, because there is no account server to check one against. '
            + 'It labels this workspace on a shared machine; it is not a security boundary.',
        })));
  }

  /* --------------------------------------------------------- data */

  function dataCard() {
    return card('Workspace data',
      chip(storageAvailable ? 'Saved locally' : 'Not persisted', storageAvailable ? 'green' : 'red'),
      el('div.stack-sm', null,
        el('div.tile-row', null,
          statTile('Depots', num(store.depots.length)),
          statTile('Vehicles', num(store.vehicles.length)),
          statTile('Orders', num(store.orders.length))),
        el('div.row.wrap', null,
          el('button.btn.btn--sm', {
            type: 'button', html: `${icon('chevron', 12)}<span>Export workspace</span>`,
            onclick: () => {
              const blob = new Blob([store.exportJson()], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = el('a', { href: url, download: `carbonroute-workspace-${new Date().toISOString().slice(0, 10)}.json` });
              document.body.append(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              announce('Workspace exported');
            },
          }),
          el('label.btn.btn--sm', { style: { cursor: 'pointer' } },
            'Import workspace',
            el('input', {
              type: 'file', accept: 'application/json', style: { display: 'none' },
              onchange: async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  store.importJson(await file.text());
                  emit(EV.TOAST, { message: 'Workspace imported.', tone: 'good' });
                  render();
                } catch (err) {
                  emit(EV.TOAST, { message: `Import failed: ${err.message}`, tone: 'bad' });
                }
                e.target.value = '';
              },
            })),
          confirmButton('Delete everything', 'Really delete?', () => {
            store.resetWorkspace();
            location.reload();
          })),
        el('p.basis', {
          text: storageAvailable
            ? 'Depots, fleet, orders and settings are stored in this browser only. Nothing is uploaded. Export to move a workspace between machines.'
            : 'Browser storage is blocked or full, so this workspace will be lost when the tab closes. Export it to keep a copy.',
        })));
  }

  function aboutCard() {
    return card('About', null,
      el('dl.kv', null,
        ...kv('Version', APP.version),
        ...kv('Basemap', 'OpenStreetMap contributors'),
        ...kv('Routing', 'OSRM — Open Source Routing Machine'),
        ...kv('Addresses', GEOCODE_ATTRIBUTION),
        ...kv('Dependencies', 'none')),
      el('p.basis', {
        text: 'Road distances and travel times come from real OpenStreetMap geometry. '
          + 'Traffic, energy consumption and emissions are MODELLED from published factors and time of day — '
          + 'they are estimates, never live measurements, and the interface labels them as such.',
      }));
  }

  on(EV.SERVICE_STATUS, render);
  on(EV.MATRIX_CHANGED, render);
  on(EV.ENTITIES_CHANGED, render);
  render();
  return root;
}
