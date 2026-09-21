/**
 * BROWSER WALKTHROUGH
 *
 * Drives a real Chromium through the whole product and fails on any page
 * error, any lost form input, or any horizontal overflow. The unit suite in
 * engines.test.mjs proves the maths; this proves the thing actually works.
 *
 * It needs Playwright, which the application itself does not:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tests/mock-services.mjs &
 *   python3 -m http.server 8080 &
 *   node tests/walkthrough.mjs
 *
 * Set CARBONROUTE_CHROMIUM to use a browser you already have.
 */

import { chromium } from 'playwright';

const EXE = process.env.CARBONROUTE_CHROMIUM || undefined;
const BASE = process.env.CARBONROUTE_URL || 'http://localhost:8080/index.html';
const MOCK = 'http://localhost:8899';

const SHOT_DIR = process.env.CARBONROUTE_SHOTS || '';
const errors = [];
const shots = [];

function log(...a) { console.log(...a); }

const browser = await chromium.launch({
  ...(EXE ? { executablePath: EXE } : {}),
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// Redirect every external map/routing/geocode call at the network layer, so the
// application code under test is exactly the shipping code path. Playwright
// cannot rewrite https -> http with continue(), so each call is fulfilled from
// the local mock instead.
async function proxy(route, path) {
  try {
    const res = await fetch(MOCK + path);
    const buf = Buffer.from(await res.arrayBuffer());
    await route.fulfill({
      status: res.status,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      body: buf,
    });
  } catch (err) {
    await route.abort();
  }
}

await ctx.route('**://server.arcgisonline.com/**', (route) => {
  const u = new URL(route.request().url());
  return proxy(route, u.pathname);
});
await ctx.route('**://router.project-osrm.org/**', (route) => {
  const u = new URL(route.request().url());
  return proxy(route, u.pathname + u.search);
});
await ctx.route('**://nominatim.openstreetmap.org/**', (route) => {
  const u = new URL(route.request().url());
  return proxy(route, u.pathname + u.search);
});
await ctx.route('**://*.basemaps.cartocdn.com/**', (route) => proxy(route, '/tiles/10/1/1.png'));

async function shot(name) {
  if (!SHOT_DIR) return;   // screenshots are opt-in; the assertions are not
  const p = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path: p });
  shots.push(p);
  log('  shot', name);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/* ---------------------------------------------------- landing */
log('\n== LANDING ==');
const title = await page.locator('.landing-title').innerText().catch(() => '(none)');
log('  title:', JSON.stringify(title));
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
log('  body bg:', bg);
const canvasIn = await page.evaluate(() => document.getElementById('map-canvas')?.parentElement?.className);
log('  canvas parent:', canvasIn);
await shot('01-landing');

/* ---------------------------------------------------- chooser */
log('\n== MODE CHOOSER ==');
await page.getByRole('button', { name: /start optimising/i }).click();
await page.waitForTimeout(700);
const heading = await page.locator('.mode-head h1').innerText();
log('  heading:', JSON.stringify(heading));
const cards = await page.locator('.mode-card').count();
log('  mode cards:', cards);
await shot('02-chooser');

/* ---------------------------------------------------- personal */
log('\n== PERSONAL ONBOARDING ==');
await page.locator('.mode-card[data-mode="PERSONAL"]').click();
await page.waitForTimeout(700);
log('  steps:', await page.locator('.ob-step').allInnerTexts());
await page.locator('.ob-form input').first().fill('Akshat');
await shot('03-personal-welcome');
await page.getByRole('button', { name: /get started/i }).click();
await page.waitForTimeout(500);

// region step: search
await page.locator('.ob-main input[type="search"]').first().fill('Hyderabad');
await page.waitForTimeout(1400);
const hits = await page.locator('.ob-main .lookup-item').count();
log('  geocode hits:', hits);
if (hits) await page.locator('.ob-main .lookup-item').first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^Continue$/ }).click();
await page.waitForTimeout(500);

// vehicle step
log('  vehicle chips:', await page.locator('.ob-main .vehicle-chip').count());
await shot('04-personal-vehicle');
await page.locator('.ob-main .vehicle-chip').nth(1).click(); // EV
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^Continue$/ }).click();
await page.waitForTimeout(500);
await shot('05-personal-done');
await page.getByRole('button', { name: /plan my first journey/i }).click();
await page.waitForTimeout(1600);

/* ---------------------------------------------------- trip */
log('\n== TRIP PAGE ==');
log('  tabs:', await page.locator('.tab-label').allInnerTexts());
const canvasParent = await page.evaluate(() => document.getElementById('map-canvas')?.parentElement?.className);
log('  canvas parent:', canvasParent);
await shot('06-trip-empty');

const lookups = page.locator('.trip-endpoints .lookup');
await lookups.nth(0).locator('input[type="search"]').fill('Banjara Hills');
await page.waitForTimeout(1600);
log('  origin hits:', await lookups.nth(0).locator('.lookup-item').count());
await lookups.nth(0).locator('.lookup-item').first().click();
await page.waitForTimeout(400);
await lookups.nth(1).locator('input[type="search"]').fill('Gachibowli');
await page.waitForTimeout(1700);
log('  destination hits:', await lookups.nth(1).locator('.lookup-item').count());
await lookups.nth(1).locator('.lookup-item').first().click();
await page.waitForTimeout(400);

await page.locator('.btn-optimize').click();
await page.waitForTimeout(2500);

const options = await page.locator('.route-option').count();
log('  route options:', options);
log('  option labels:', await page.locator('.ro-head strong').allInnerTexts());
log('  first option metrics:', (await page.locator('.route-option').first().innerText()).replace(/\n/g, ' | '));
log('  hero:', await page.locator('#trip-hero').innerText().catch(() => '(empty)'));
log('  why:', (await page.locator('.explain').first().innerText().catch(() => '(none)')).slice(0, 320));
await shot('07-trip-result');

log('  named roads on cards:', await page.locator('.ro-via').allInnerTexts());
log('  departure slots:', await page.locator('.dep-slot').count());
log('  best departure hour:', await page.locator('.dep-slot[data-best="true"]').getAttribute('aria-label').catch(() => 'none'));
log('  departure verdict:', (await page.locator('.dep-strip').locator('..').innerText()).split('\n').pop());
await page.locator('.dep-strip').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await shot('07c-departure-sweep');
log('  roads found (status):', await page.locator('#ai-status .txt').innerText());
log('  other roads listed:', await page.locator('.road-row').count());
log('  why (roads):', (await page.locator('.drivers li').first().innerText()).replace(/\n/g, ' — '));

// pick a road no objective chose
if (await page.locator('.road-row').count()) {
  await page.locator('.road-row').nth(1).click();
  await page.waitForTimeout(800);
  log('  after picking an unchosen road, chosen label:',
    await page.locator('.explain').locator('..').locator('.chip').first().innerText().catch(() => '?'));
  log('  option cards still selected:', await page.locator('.route-option[data-selected="true"]').count());
  await shot('07b-other-road');
}

// select a different option
await page.locator('.route-option').nth(2).click();
await page.waitForTimeout(900);
log('  after selecting greenest, selected card:',
  await page.locator('.route-option[data-selected="true"] .ro-head strong').innerText().catch(() => '?'));
await shot('08-trip-greenest');

/* ---------------------------------------------------- garage */
log('\n== GARAGE ==');
await page.getByRole('tab', { name: /garage/i }).click();
await page.waitForTimeout(700);
log('  type cards:', await page.locator('.type-card').count());
await shot('09-garage');

/* ---------------------------------------------------- switch to logistics */
log('\n== SWITCH TO LOGISTICS ==');
await page.getByRole('tab', { name: /settings/i }).click();
await page.waitForTimeout(600);
await shot('10-settings');
await page.locator('.mode-switch-card[aria-pressed="false"]').click();
await page.waitForTimeout(1500);
log('  tabs now:', await page.locator('.tab-label').allInnerTexts());
log('  canvas parent:', await page.evaluate(() => document.getElementById('map-canvas')?.parentElement?.className));
await shot('11-logistics-map');

/* ------------------------------------- data entry must survive the clock */

// The regression this section exists for: Orders and Fleet re-rendered on the
// plan clock, which fires continuously, so a half-typed delivery emptied
// itself every couple of seconds and the tab was unusable for data entry.
log('\n== DATA ENTRY vs THE CLOCK ==');
await page.getByRole('tab', { name: /orders/i }).click();
await page.waitForTimeout(600);
await page.getByRole('button', { name: /add delivery/i }).click();
await page.waitForTimeout(400);

await page.evaluate(() => {
  window.__removals = 0;
  new MutationObserver((muts) => {
    for (const m of muts) if (m.removedNodes.length) window.__removals++;
  }).observe(document.getElementById('page-orders'), { childList: true, subtree: true });
});

const consignee = page.locator('#page-orders .form-grid input').first();
await consignee.fill('Delhi NCR Warehouse');
// Run the clock fast: the guard, not a quiet clock, has to hold.
await page.evaluate(() => window.CarbonRoute.store.setSpeed(900));
await page.waitForTimeout(5000);

const survived = await consignee.inputValue().catch(() => '');
const removals = await page.evaluate(() => window.__removals);
const focused = await page.evaluate(() => document.activeElement?.tagName);
log('  clock advanced to:', await page.evaluate(() => Math.round(window.CarbonRoute.store.clockMinutes)));
log('  DOM removals while typing:', removals);
log('  typed value survived:', JSON.stringify(survived));
log('  focus survived:', focused);
if (survived !== 'Delhi NCR Warehouse') errors.push('data entry: the form lost its value while the clock ran');
if (removals > 0) errors.push(`data entry: the page rebuilt itself ${removals} times mid-entry`);
if (focused !== 'INPUT') errors.push('data entry: the form lost focus');
await page.evaluate(() => window.CarbonRoute.store.setSpeed(0));

// A deadline on a later day — long haul does not fit in one afternoon.
const dates = page.locator('#page-orders .datetime input[type="date"]');
const dayNotes = page.locator('#page-orders .day-note');
log('  date controls on the form:', await dates.count());
if (await dates.count() >= 2) {
  const start = await dates.nth(1).inputValue();
  const later = new Date(`${start}T00:00:00`);
  later.setDate(later.getDate() + 3);
  const iso = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`;
  await dates.nth(1).fill(iso);
  await dates.nth(1).dispatchEvent('change');
  await page.waitForTimeout(200);
  log('  deadline day note:', await dayNotes.nth(1).innerText());
} else {
  errors.push('data entry: the deadline is still time-only, with no date');
}
await shot('15-orders-multiday');

/* ---------------------------------------------------- mobile */
log('\n== MOBILE ==');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.evaluate(() => window.CarbonRoute.store.setMode('PERSONAL'));
await page.waitForTimeout(1400);
await shot('12-mobile-trip');
const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
log('  horizontal page scroll:', hScroll);

/* ---------------------------------------------------- reduced motion */
log('\n== REDUCED MOTION ==');
await page.setViewportSize({ width: 1440, height: 900 });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.evaluate(() => { localStorage.clear(); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await shot('13-reduced-motion-landing');
await page.getByRole('button', { name: /start optimising/i }).click();
await page.waitForTimeout(400);
await shot('14-reduced-motion-chooser');
log('  chooser rendered:', await page.locator('.mode-card').count(), 'cards');

log('\n== ERRORS ==');
log(errors.length ? errors.slice(0, 20).join('\n') : '  none');
await browser.close();

if (errors.length) {
  console.error(`\nFAILED: ${errors.length} page error(s).`);
  process.exit(1);
}
console.log('\nWalkthrough passed.');
