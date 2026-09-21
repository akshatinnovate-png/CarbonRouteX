/**
 * BASEMAP PROVIDERS — real satellite imagery and real cartography, no API key.
 *
 * Satellite is the product's default: CarbonRoute is about the real world, and
 * imagery carries most of the visual richness so the interface itself can stay
 * white and quiet.
 *
 * A satellite base alone has no road names, so imagery providers declare an
 * `overlay` — a transparent reference layer of roads, boundaries and labels
 * that the tile engine composites on top. That hybrid is what makes satellite
 * usable for logistics rather than merely pretty.
 *
 * Attribution requirements are non-negotiable and are rendered permanently in
 * the map's corner; see `attribution` on each entry.
 */

const OSM_ATTR = '© OpenStreetMap contributors';
const CARTO_ATTR = `${OSM_ATTR} · © CARTO`;
const ESRI_ATTR = 'Imagery © Esri, Maxar, Earthstar Geographics';

/** Transparent reference overlays composited above satellite imagery. */
export const OVERLAY_LAYERS = {
  'esri-reference': {
    key: 'esri-reference',
    maxZoom: 19,
    subdomains: [''],
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  },
  'esri-transport': {
    key: 'esri-transport',
    maxZoom: 19,
    subdomains: [''],
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  },
};

export const TILE_PROVIDERS = {
  satellite: {
    key: 'satellite',
    label: 'Satellite',
    detail: 'Real imagery with roads and labels',
    theme: 'imagery',
    background: '#0b1f2b',
    maxZoom: 19,
    attribution: `${ESRI_ATTR} · ${OSM_ATTR}`,
    subdomains: [''],
    // Esri tiles are {z}/{y}/{x}, not the more common {z}/{x}/{y}.
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    overlays: ['esri-transport', 'esri-reference'],
  },
  'satellite-clean': {
    key: 'satellite-clean',
    label: 'Satellite (clean)',
    detail: 'Imagery only, no labels',
    theme: 'imagery',
    background: '#0b1f2b',
    maxZoom: 19,
    attribution: ESRI_ATTR,
    subdomains: [''],
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  },
  light: {
    key: 'light',
    label: 'Light',
    detail: 'Minimal cartography, maximum contrast',
    theme: 'light',
    background: '#f2f6f6',
    maxZoom: 19,
    attribution: CARTO_ATTR,
    subdomains: ['a', 'b', 'c', 'd'],
    template: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  },
  voyager: {
    key: 'voyager',
    label: 'Voyager',
    detail: 'Warm streets and place names',
    theme: 'light',
    background: '#eee9e2',
    maxZoom: 19,
    attribution: CARTO_ATTR,
    subdomains: ['a', 'b', 'c', 'd'],
    template: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  },
  terrain: {
    key: 'terrain',
    label: 'Terrain',
    detail: 'Elevation and topography',
    theme: 'light',
    background: '#e6ecd8',
    maxZoom: 17,
    attribution: `${OSM_ATTR} · SRTM · © OpenTopoMap (CC-BY-SA)`,
    subdomains: ['a', 'b', 'c'],
    template: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  },
  dark: {
    key: 'dark',
    label: 'Dark',
    detail: 'For dim rooms and night operations',
    theme: 'dark',
    background: '#0e1621',
    maxZoom: 19,
    attribution: CARTO_ATTR,
    subdomains: ['a', 'b', 'c', 'd'],
    template: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  },
};

export const DEFAULT_PROVIDER = 'satellite';

/** Retina tiles only when the display benefits — and only in a browser. */
function defaultRetina() {
  return typeof window !== 'undefined' && (window.devicePixelRatio || 1) > 1.3;
}

function makeLayer(spec, retina) {
  const subs = spec.subdomains && spec.subdomains.length ? spec.subdomains : [''];
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

/**
 * Build a usable provider for the tile engine, including any transparent
 * reference layers it composites on top of the imagery.
 */
export function makeProvider(key, { retina = defaultRetina(), custom = null } = {}) {
  const spec = custom || TILE_PROVIDERS[key] || TILE_PROVIDERS[DEFAULT_PROVIDER];
  const layer = makeLayer(spec, retina);
  layer.overlayLayers = (spec.overlays || [])
    .map((k) => OVERLAY_LAYERS[k])
    .filter(Boolean)
    .map((o) => makeLayer(o, retina));
  layer.isImagery = spec.theme === 'imagery';
  return layer;
}

/** A custom XYZ template, for operators pointing at their own tile server. */
export function customProvider(template, {
  label = 'Custom tiles', theme = 'light', maxZoom = 19, attribution = '',
} = {}) {
  return makeProvider(null, {
    custom: {
      key: 'custom', label, theme, maxZoom,
      detail: 'Your own tile server',
      background: theme === 'imagery' ? '#0b1f2b' : theme === 'dark' ? '#0e1621' : '#f2f6f6',
      attribution: attribution || 'Custom tile source',
      subdomains: template.includes('{s}') ? ['a', 'b', 'c'] : [''],
      template,
    },
  });
}
