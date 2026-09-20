/** Single source of truth for colour. Mirrors the CSS custom properties. */

export const C = {
  void: '#0d1420',
  deep: '#111a28',
  ink: '#152031',
  surface: '#1a2638',
  line: '#2c3c54',
  lineSoft: '#243246',
  text: '#f2f6fb',
  muted: '#a3b1c4',
  faint: '#7d8ca3',

  green: '#34d99a',
  greenDim: '#1f6f4a',
  cyan: '#62c8f8',
  cyanDim: '#1d5878',
  amber: '#f5c661',
  orange: '#ff9a4d',
  red: '#ff5f6d',
  violet: '#b78bff',
  pink: '#ff7a93',

  water: '#132638',
  waterEdge: '#1d4661',
  park: '#162b24',

  // Casing (the dark outline) and core (the lit surface). The gap between the
  // two per class is what makes the hierarchy readable at a glance: a highway
  // is bright and wide, a local street is barely more than a hairline.
  road: {
    highway: '#35465e',
    arterial: '#2a3648',
    collector: '#222c3c',
    local: '#1d2634',
  },
  roadCore: {
    highway: '#9db4cd',
    arterial: '#5b6e8a',
    collector: '#3c4b61',
    local: '#313f53',
  },
};

/** Congestion 0..2.6 → colour. Deliberately perceptual, not a rainbow. */
export function congestionColor(c) {
  if (c < 0.35) return '#2f8f66';
  if (c < 0.62) return '#4fae74';
  if (c < 0.92) return '#c9a94e';
  if (c < 1.35) return '#e07a3a';
  return '#e0475a';
}

/** Route state → stroke colour. */
export const ROUTE_STATE = {
  active: '#3ee08f',
  optimized: '#5ec8ff',
  alternative: '#6c7a90',
  congested: '#ff9a4d',
  high_emission: '#ff5f6d',
  delivered: '#41525f',
  selected: '#ffffff',
};

/** A stable, distinguishable hue per vehicle index. */
export function vehicleColor(index) {
  const hues = [152, 196, 42, 268, 12, 174, 220, 320, 92, 240];
  return `hsl(${hues[index % hues.length]} 72% 62%)`;
}

export function withAlpha(hex, alpha) {
  if (hex.startsWith('hsl')) return hex.replace(')', ` / ${alpha})`).replace('hsl(', 'hsl(');
  const n = hex.replace('#', '');
  const v = n.length === 3
    ? n.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  return `rgba(${v[0]},${v[1]},${v[2]},${alpha})`;
}

export const PRIORITY_COLOR = {
  critical: C.red,
  high: C.orange,
  standard: C.cyan,
  economy: C.faint,
};

export const STATUS_COLOR = {
  moving: C.cyan,
  delivering: C.green,
  idle: C.faint,
  returning: C.violet,
  delayed: C.orange,
  charging: C.amber,
  disabled: C.red,
  exception: C.red,
};
