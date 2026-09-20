/**
 * KEYBOARD
 *
 * Global shortcuts. Every handler bails out when the event originates from a
 * text-entry context, and none of them intercept a browser or assistive-tech
 * chord (anything with Ctrl, Meta or Alt is left alone).
 *
 * Arrow-key panning is scoped to the map: it only fires when the canvas itself
 * has focus, so arrow keys keep working normally everywhere else.
 */

import { isTypingTarget, announce } from '../util/dom.js';
import { EV, emit } from '../core/bus.js';

export function initKeyboard(store, { map, dock, command, help }) {
  const held = new Set();
  let panRaf = 0;

  function panLoop() {
    const step = 22 * (held.has('Shift') ? 3 : 1);
    let dx = 0, dy = 0;
    if (held.has('ArrowLeft')) dx += step;
    if (held.has('ArrowRight')) dx -= step;
    if (held.has('ArrowUp')) dy += step;
    if (held.has('ArrowDown')) dy -= step;
    if (dx || dy) {
      map.camera.panBy(dx * map.dpr, dy * map.dpr);
      map.staticKey = null;
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

    const mapFocused = document.activeElement === map.canvas;
    if (mapFocused && e.key.startsWith('Arrow')) {
      e.preventDefault();
      held.add(e.key);
      if (e.shiftKey) held.add('Shift');
      if (!panRaf) panRaf = requestAnimationFrame(panLoop);
      return;
    }

    switch (e.key) {
      case 'o': case 'O':
        e.preventDefault();
        command.runOptimize();
        break;
      case 's': case 'S':
        e.preventDefault();
        dock.show('simulation');
        announce('Simulation mode');
        break;
      case 'r': case 'R':
        e.preventDefault();
        map.fitRoutes();
        announce('View fitted to all routes');
        break;
      case 'f': case 'F':
        e.preventDefault();
        map.fitFleet();
        announce('View fitted to the fleet');
        break;
      case '0':
        e.preventDefault();
        map.fitWorld();
        announce('View reset');
        break;
      case '+': case '=':
        e.preventDefault();
        map.zoomBy(1.4);
        break;
      case '-': case '_':
        e.preventDefault();
        map.zoomBy(1 / 1.4);
        break;
      case ' ':
        e.preventDefault();
        store.togglePlay();
        announce(store.playing ? 'Operations clock running' : 'Operations clock paused');
        break;
      case '/':
        e.preventDefault();
        command.focusSearch();
        break;
      case '?':
        e.preventDefault();
        help.toggle();
        break;
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
