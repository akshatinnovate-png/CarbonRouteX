/**
 * BASEMAP PROVIDERS — real OpenStreetMap cartography, no API key.
 *
 * All of these serve standard XYZ raster tiles and require no account. Their
 * attribution requirements are non-negotiable and are rendered permanently in
 * the map's corner; see `attribution` on each entry.
 *
 * Tile usage policies ask for reasonable volumes and a real referrer. The map
 * engine caches aggressively and never re-requests a failed tile in a loop.
 */

const OSM_ATTR = '© OpenStreetMap contributors';
const CARTO_ATTR = `${OSM_ATTR} · © CARTO`;

export const TILE_PROVIDERS = {
  'carto-dark': {
    key: 'carto-dark',
    label: 'Dark (CARTO)',
    theme: 'dark',
    background: '#0e1621',
    maxZoom: 19,
    attribution: CARTO_ATTR,
    subdomains: ['a', 'b', 'c', 'd'],
    template: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  },
  'carto-light': {
    key: 'carto-light',
    label: 'Light (CARTO)',
    theme: 'light',
    background: '#eef2f6',
    maxZoom: 19,
    attribution: CARTO_ATTR,
    subdomains: ['a', 'b', 'c', 'd'],
    template: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  },
  'carto-voyager': {
    key: 'carto-voyager',
    label: 'Voyager (CARTO)',
    theme: 'light',
    background: '#e8e4dc',
    maxZoom: 19,
    attribution: CARTO_ATTR,
    subdomains: ['a', 'b', 'c', 'd'],
    template: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  },
  osm: {
    key: 'osm',
    label: 'Standard (OSM)',
    theme: 'light',
    background: '#e6e3dc',
    maxZoom: 19,
    attribution: OSM_ATTR,
    subdomains: ['a', 'b', 'c'],
    template: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  },
  'opentopo': {
    key: 'opentopo',
    label: 'Terrain (OpenTopoMap)',
    theme: 'light',
    background: '#e6ecd8',
    maxZoom: 17,
    attribution: `${OSM_ATTR} · SRTM · © OpenTopoMap (CC-BY-SA)`,
    subdomains: ['a', 'b', 'c'],
    template: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  },
};

export const DEFAULT_PROVIDER = 'carto-dark';

/** Retina tiles only when the display actually benefits — and only in a browser. */
function defaultRetina() {
  return typeof window !== 'undefined' && (window.devicePixelRatio || 1) > 1.3;
}

/**
 * Build a usable provider object for the tile engine.
 * `retina` requests @2x tiles where the provider supports them, which is what
 * keeps labels crisp on high-DPI screens.
 */
export function makeProvider(key, { retina = defaultRetina(), custom = null } = {}) {
  const spec = custom || TILE_PROVIDERS[key] || TILE_PROVIDERS[DEFAULT_PROVIDER];
  const subs = spec.subdomains || [''];
  let n = 0;
  return {
    ...spec,
    url(z, x, y) {
      // Round-robin across subdomains so the browser's per-host connection
      // limit does not throttle a screenful of tiles.
      const s = subs[(n++) % subs.length];
      return spec.template
        .replace('{s}', s)
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y))
        .replace('{r}', retina && spec.template.includes('{r}') ? '@2x' : '');
    },
  };
}

/** A custom XYZ template, for operators pointing at their own tile server. */
export function customProvider(template, { label = 'Custom tiles', theme = 'dark', maxZoom = 19, attribution = '' } = {}) {
  return makeProvider(null, {
    custom: {
      key: 'custom', label, theme, maxZoom,
      background: theme === 'light' ? '#eef2f6' : '#0e1621',
      attribution: attribution || 'Custom tile source',
      subdomains: template.includes('{s}') ? ['a', 'b', 'c'] : [''],
      template,
    },
  });
}
