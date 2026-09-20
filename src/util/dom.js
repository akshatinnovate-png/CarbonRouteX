/** Tiny DOM helpers — enough structure to avoid a framework, no more. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * el('div.card#id', { attrs }, ...children)
 * Children may be nodes, strings, arrays, or null (skipped).
 */
export function el(spec, props = null, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const tag = (m && m[1]) || 'div';
  const node = document.createElement(tag);
  if (m && m[2]) {
    for (const token of m[2].match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') node.classList.add(token.slice(1));
      else node.id = token.slice(1);
    }
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className += (node.className ? ' ' : '') + v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendAll(node, c);
    else node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

/** Replace a container's children in one pass. */
export function mount(container, ...children) {
  container.replaceChildren();
  appendAll(container, children);
  return container;
}

/** Set textContent only when it actually differs — avoids needless layout. */
export function setText(node, value) {
  if (!node) return;
  const s = String(value);
  if (node.textContent !== s) node.textContent = s;
}

export function setClass(node, name, on) {
  if (!node) return;
  node.classList.toggle(name, !!on);
}

/** Debounce with a trailing call. */
export function debounce(fn, ms = 160) {
  let t = 0;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Coalesce many calls into one per animation frame. */
export function raf1(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}

/**
 * Rate-limit a function to at most one call per `ms`, always running a
 * trailing call so the final state is never lost. Used for views driven by the
 * 60fps simulation tick, where rebuilding DOM every frame would be waste.
 */
export function throttle(fn, ms = 400) {
  let last = 0, timer = 0, pending = null;
  const invoke = (args) => { last = performance.now(); pending = null; fn(...args); };
  const wrapped = (...args) => {
    const now = performance.now();
    if (now - last >= ms) { clearTimeout(timer); invoke(args); return; }
    pending = args;
    if (!timer) {
      timer = setTimeout(() => { timer = 0; if (pending) invoke(pending); }, ms - (now - last));
    }
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = 0; pending = null; };
  return wrapped;
}

/** True when the user has asked the OS for less motion. */
export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Announce a message to screen readers via the shared live region. */
export function announce(message, assertive = false) {
  const id = assertive ? 'sr-alert' : 'sr-status';
  const region = document.getElementById(id);
  if (!region) return;
  // Toggle the text so repeated identical messages are still announced.
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = message; });
}

/** Trap-free focus move that also scrolls the element into view politely. */
export function focusInto(node) {
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** True when the keyboard event originated from a text-entry context. */
export function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
