/**
 * Minimal test harness — no dependencies, runs on bare Node.
 *
 * The engines are pure ES modules with no DOM access except for two browser
 * globals used for cooperative scheduling and timing, which are shimmed here.
 */

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
}
if (typeof globalThis.performance !== 'object') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.localStorage !== 'object') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

const tests = [];
let currentSuite = '';

export function suite(name, fn) { currentSuite = name; fn(); currentSuite = ''; }
export function test(name, fn) { tests.push({ name, suite: currentSuite, fn }); }

export function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}
export function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'equal'}: expected ${expected}, got ${actual}`);
}
export function close(actual, expected, tol, message) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${message || 'close'}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}
export function greater(a, b, message) {
  if (!(a > b)) throw new Error(`${message || 'greater'}: expected ${a} > ${b}`);
}
export function atMost(a, b, message) {
  if (!(a <= b)) throw new Error(`${message || 'atMost'}: expected ${a} <= ${b}`);
}

export async function run() {
  let passed = 0;
  const failures = [];
  let lastSuite = null;
  for (const t of tests) {
    if (t.suite !== lastSuite) {
      process.stdout.write(`\n── ${t.suite}\n`);
      lastSuite = t.suite;
    }
    const started = performance.now();
    try {
      await t.fn();
      const ms = Math.round(performance.now() - started);
      process.stdout.write(`  ✓ ${t.name}${ms > 40 ? ` (${ms}ms)` : ''}\n`);
      passed++;
    } catch (err) {
      process.stdout.write(`  ✗ ${t.name}\n      ${err.message}\n`);
      failures.push({ t, err });
    }
  }
  process.stdout.write(`\n${passed}/${tests.length} passed\n`);
  if (failures.length) {
    process.stdout.write(`\n${failures.length} failing:\n`);
    for (const f of failures) process.stdout.write(`  ${f.t.suite} › ${f.t.name}\n    ${f.err.stack?.split('\n').slice(0, 3).join('\n    ')}\n`);
    process.exitCode = 1;
  }
}
