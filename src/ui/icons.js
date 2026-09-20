/** Inline SVG icons. Returned as strings so they can be interpolated safely. */

const svg = (body, size = 16) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  minus: svg('<path d="M3 8h10"/>'),
  target: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>'),
  fleet: svg('<rect x="1.5" y="5" width="8" height="6" rx="1"/><path d="M9.5 7h2.6l2.4 2.2V11h-5z"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="11.5" cy="12" r="1.3"/>'),
  route: svg('<circle cx="3.5" cy="12.5" r="1.8"/><circle cx="12.5" cy="3.5" r="1.8"/><path d="M5 11.4C7 9 6 7 8 5.6c1-.7 2-.9 3-1"/>'),
  layers: svg('<path d="M8 1.8 14.5 5 8 8.2 1.5 5z"/><path d="m1.5 8 6.5 3.2L14.5 8"/><path d="m1.5 11 6.5 3.2L14.5 11"/>'),
  bolt: svg('<path d="M9 1.5 3.5 9H7l-.8 5.5L12.5 7H9z"/>'),
  leaf: svg('<path d="M13.5 2.5c0 6-3.5 9.5-8 9.5-1.4 0-2.5-.4-2.5-.4"/><path d="M3 13.5C3 8 6.5 4.5 13.5 2.5"/>'),
  chart: svg('<path d="M2 14V2"/><path d="M2 14h12"/><path d="M4.5 11.5V8M7.5 11.5V5M10.5 11.5V9M13 11.5V6.5"/>'),
  scatter: svg('<path d="M2 14V2M2 14h12"/><circle cx="5" cy="10" r="1.1"/><circle cx="8" cy="6.5" r="1.1"/><circle cx="11" cy="8.5" r="1.1"/><circle cx="12.8" cy="4.6" r="1.1"/>'),
  sim: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.4v3.6l2.5 1.6"/>'),
  alert: svg('<path d="M8 2.2 14.3 13H1.7z"/><path d="M8 6.4v3"/><circle cx="8" cy="11.2" r=".6" fill="currentColor" stroke="none"/>'),
  feed: svg('<path d="M2 8h2.4l1.6-4 2.6 9 1.8-5h3.6"/>'),
  play: svg('<path d="M4.5 2.8 12.8 8l-8.3 5.2z"/>'),
  pause: svg('<path d="M5.5 3v10M10.5 3v10"/>'),
  search: svg('<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.2 3.2"/>'),
  check: svg('<path d="m3 8.4 3.2 3.2L13 4.6"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  chevron: svg('<path d="m6 3.5 5 4.5-5 4.5"/>'),
  expand: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>'),
  collapse: svg('<path d="M13 6.5H9.5v-3.5M3 9.5h3.5v3.5M9.5 6.5 13.5 2.5M6.5 9.5 2.5 13.5"/>'),
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.8 2v3.2h-3.2"/>'),
  warehouse: svg('<path d="M1.8 6.5 8 2.8l6.2 3.7V13H1.8z"/><path d="M5.6 13V9h4.8v4"/>'),
  truck: svg('<rect x="1" y="4.5" width="8" height="6" rx="1"/><path d="M9 6.5h2.8L14.8 9v1.5H9z"/><circle cx="4" cy="12" r="1.4"/><circle cx="11.6" cy="12" r="1.4"/>'),
  clock: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.5"/>'),
  scale: svg('<path d="M8 2v12M4 5h8"/><path d="M2 10.5 4 5l2 5.5a2.2 2.2 0 0 1-4 0Z"/><path d="M10 10.5 12 5l2 5.5a2.2 2.2 0 0 1-4 0Z"/>'),
  swap: svg('<path d="M3 5.5h9l-2.5-2.5M13 10.5H4l2.5 2.5"/>'),
  info: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v4"/><circle cx="8" cy="5" r=".7" fill="currentColor" stroke="none"/>'),
  grid: svg('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
  map: svg('<path d="M1.8 4.2 6 2.5v9.3l-4.2 1.7z"/><path d="M6 2.5 10 4.2v9.3L6 11.8z"/><path d="m10 4.2 4.2-1.7v9.3L10 13.5z"/>'),
};

export const icon = (name, size) => {
  const raw = ICON[name] || ICON.info;
  return size ? raw.replace(/width="16" height="16"/, `width="${size}" height="${size}"`) : raw;
};
