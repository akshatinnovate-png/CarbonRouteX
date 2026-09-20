/**
 * STORAGE
 *
 * Only UI preferences are persisted — objective weights, layer visibility and
 * the chosen preset. Operational data is deliberately NOT persisted: the demo
 * dataset is regenerated deterministically from the seed on every load, so a
 * stale cached fleet can never be mistaken for live state.
 *
 * Every access is guarded: private-browsing modes and blocked site data make
 * localStorage throw rather than return null.
 */

import { APP } from '../config.js';

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(APP.storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(APP.storageKey, JSON.stringify({ version: 1, ...prefs }));
    return true;
  } catch {
    return false;
  }
}

export function clearPrefs() {
  try { localStorage.removeItem(APP.storageKey); return true; } catch { return false; }
}

export const storageAvailable = (() => {
  try {
    const k = `${APP.storageKey}:probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
})();
