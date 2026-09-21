/**
 * KEYBOARD
 *
 * Global shortcuts. Every handler bails out when the event originates from a
 * text-entry context, and none of them intercept a browser or assistive-tech
 * chord (anything with Ctrl, Meta or Alt is left alone).
 *
 * Arrow-key panning is scoped to the map canvas, so arrow keys keep working
 * normally in tables and forms.
 */

import { isTypingTarget, announce } from '../util/dom.js';
import { EV, emit } from '../core/bus.js';

const TAB_KEYS = {
  1: 'map', 2: 'optimize', 3: 'simulation', 4: 'depots',
  5: 'fleet', 6: 'orders', 7: 'analytics', 8: 'carbon', 9: 'events',
};

export function initKeyboard(store, { map, shell, help }) {
  const held = new Set();
  let panRaf = 0;

  function panLoop() {
    const step = 26 * (held.has('Shift') ? 3 : 1) * map.dpr;
    let dx = 0, dy = 0;
    if (held.has('ArrowLeft')) dx += step;
    if (held.has('ArrowRight')) dx -= step;
    if (held.has('ArrowUp')) dy += step;
    if (held.has('ArrowDown')) dy -= step;
    if (dx || dy) {
      map.panByPixels(dx, dy);
      panRaf = requestAnimationFrame(panLoop);
    } else {
      panRaf = 0;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    if (document.activeElement === map.canvas && e.key.startsWith('Arrow')) {
      e.preventDefault();
      held.add(e.key);
      if (e.shiftKey) held.add('Shift');
      if (!panRaf) panRaf = requestAnimationFrame(panLoop);
      return;
    }

    if (TAB_KEYS[e.key]) {
      e.preventDefault();
      shell.show(TAB_KEYS[e.key]);
      return;
    }

    switch (e.key) {
      case 'o': case 'O':
        e.preventDefault();
        store.optimizeFleet({ trigger: 'Keyboard shortcut' });
        break;
      case 's': case 'S':
        e.preventDefault();
        shell.show('simulation');
        break;
      case 'm': case 'M':
        e.preventDefault();
        shell.show('map');
        break;
      case '+': case '=':
        e.preventDefault(); map.zoomBy(1); break;
      case '-': case '_':
        e.preventDefault(); map.zoomBy(-1); break;
      case ' ':
        e.preventDefault();
        store.togglePlay();
        announce(store.playing ? 'Clock running' : 'Clock paused');
        break;
      case '?':
        e.preventDefault(); help.toggle(); break;
      case 'Escape':
        if (help.isOpen()) help.close();
        else if (store.selection.kind) { store.clearSelection(); announce('Selection cleared'); }
        break;
      default:
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    held.delete(e.key);
    if (!e.shiftKey) held.delete('Shift');
  });
  window.addEventListener('blur', () => held.clear());
}
