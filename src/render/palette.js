/**
 * MAP PALETTE — white, teal, gold.
 *
 * Mirrors styles/tokens.css. Two rules govern everything here:
 *
 *  1. TEAL means movement: active routes, live vehicles, the working network.
 *  2. GOLD is rare and earned: the selected object, the optimised result, the
 *     metric that matters. If gold is everywhere it means nothing.
 *
 * Over satellite imagery the background is unpredictable — a route may cross
 * dark water and bright desert in the same frame — so every mark carries a
 * light halo or casing. That is why `onImagery` exists.
 */

export const C = {
  canvas: '#f7f9f9',
  surface: '#ffffff',
  line: '#dde5e6',
  ink: '#0e2230',
  text: '#123040',
  muted: '#5f7c88',
  faint: '#8aa1ab',

  teal: '#0d8f8f',
  tealDeep: '#07636a',
  tealBright: '#14b8a6',
  tealSoft: '#d3ecec',

  gold: '#b08423',
  goldBright: '#d4a843',
  goldSoft: '#f4ead2',

  success: '#0f8a6a',
  warn: '#b08423',
  danger: '#b4342f',

  navy: '#0b1f2b',
  onDark: '#eef5f6',
};

/** Contrast pair for a given basemap: what to draw marks and halos with. */
export function onImagery(theme) {
  const dark = theme === 'imagery' || theme === 'dark';
  return {
    dark,
    halo: dark ? 'rgba(6, 22, 32, 0.62)' : 'rgba(255, 255, 255, 0.88)',
    casing: dark ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.9)',
    label: dark ? '#ffffff' : C.ink,
    labelHalo: dark ? 'rgba(6, 22, 32, 0.78)' : 'rgba(255, 255, 255, 0.92)',
    pinStroke: dark ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.98)',
  };
}

/**
 * Route colour by state. Teal for the working network; gold only when the
 * operator has selected it or the optimiser has just improved it.
 */
export const ROUTE_STATE = {
  active: C.teal,
  selected: C.gold,
  optimised: C.tealBright,
  delivered: '#8aa1ab',
  congested: '#c2742a',
  exception: C.danger,
  candidate: 'rgba(176, 132, 35, 0.55)',
};

/**
 * Vehicle hue ramp. Deliberately a narrow teal-to-blue band rather than a
 * rainbow: a fleet should read as one system with distinguishable members,
 * not as a bag of unrelated colours.
 */
export function vehicleColor(index) {
  const ramp = [
    '#0d8f8f', '#1b7f9e', '#0f9d76', '#2a6f8f',
    '#14b8a6', '#046b6b', '#3a8fa5', '#0c7a5c',
    '#1f6e86', '#17a394',
  ];
  return ramp[((index % ramp.length) + ramp.length) % ramp.length];
}

export function withAlpha(color, alpha) {
  if (color.startsWith('rgba')) return color.replace(/[\d.]+\)$/, `${alpha})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  if (color.startsWith('hsl')) return color.replace(')', ` / ${alpha})`);
  const n = color.replace('#', '');
  const v = n.length === 3
    ? n.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  return `rgba(${v[0]},${v[1]},${v[2]},${alpha})`;
}

/** Priority is communicated by shape and by these four steps only. */
export const PRIORITY_COLOR = {
  critical: C.danger,
  high: C.gold,
  standard: C.teal,
  economy: C.faint,
};

export const STATUS_COLOR = {
  moving: C.teal,
  delivering: C.success,
  idle: C.faint,
  returning: C.tealDeep,
  delayed: C.warn,
  charging: C.gold,
  disabled: C.danger,
  exception: C.danger,
};

/** Emissions heat ramp: teal (clean) through gold to red (intense). */
export const CARBON_RAMP = [
  [211, 236, 236], [20, 184, 166], [176, 132, 35], [196, 116, 42], [180, 52, 47],
];
