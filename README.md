# CarbonRoute

### Optimize the Network. Not Just the Route.

**Route intelligence over real satellite imagery and real roads, optimising time,
cost and carbon at the same time — for one journey, or for an entire fleet.**

No API keys. No build step. No dependencies. No backend. Open `index.html` behind
any static server and you get real satellite imagery, real road routing, a
constrained vehicle-routing optimiser, a digital twin and a carbon model — all
running in the browser, with your data staying in your browser.

CarbonRoute runs in one of **two modes**, chosen on first use and switchable at
any time from Settings:

| | **PERSONAL** | **LOGISTICS** |
|---|---|---|
| | Cars · Bikes · Trips | Fleets · Orders · Depots |
| **The question** | Which road should I take? | How should the whole network run today? |
| **Scope** | One person, one vehicle, one journey | Many vehicles, many orders, many depots |
| **You compare** | Fastest · Lowest cost · Lowest emissions · Balanced | A Pareto frontier across five objectives |
| **Tabs** | Journey, Garage, Settings | Map, Optimise, Simulation, Depots, Fleet, Orders, Analytics, Carbon, Events, Settings |

The mode is a real fork, not a label: it changes the tab set, the optimiser that
runs and the vocabulary. Both halves share the same physics — the same energy
curve, the same well-to-wheel emission factors, the same hourly grid intensity —
so "lowest emissions" means the same thing on both sides.

---

## Contents

[What it does](#what-it-does) · [Real map, real roads](#real-map-real-roads) ·
[Getting started](#getting-started) · [The two modes](#the-two-modes) ·
[The tabs](#the-tabs) · [Brand and motion](#brand-and-motion) ·
[Architecture](#architecture) · [Optimisation model](#optimisation-model) ·
[Carbon model](#carbon-model) · [Data model](#data-model) ·
[Performance](#performance) · [Accessibility](#accessibility) ·
[Installation](#installation) · [Configuration](#configuration) ·
[Deployment](#deployment) · [Testing](#testing) · [Limitations](#limitations) ·
[Roadmap](#roadmap) · [Responsible AI](#responsible-ai) ·
[Data & privacy](#data--privacy) · [Technical decisions](#technical-decisions) ·
[Attribution & licensing](#attribution--licensing)

---

## What it does

You sign in, add your depots, your vehicles and today's deliveries. CarbonRoute
fetches the real road distance and travel time between every pair of stops, then
solves a capacity-, range- and deadline-constrained vehicle routing problem
against an objective *you* weight across five axes. Then it explains itself, lets
you break the world on purpose, and re-solves.

| | |
|---|---|
| **Real basemap** | OpenStreetMap cartography, rendered on canvas. Four built-in styles plus your own tile server. |
| **Real routing** | Road distances and durations from OSRM over OSM geometry — one matrix request for the whole problem. |
| **Real addresses** | Nominatim geocoding, plus "pick on map" for gates and sites with no postal address. |
| **Guided setup** | A five-step wizard on first run; everything is equally addable and editable later from its own tab. |
| **Multi-objective optimiser** | Time, cost, emissions, distance and reliability, weighted by you, feeding one scalar objective. |
| **Route intelligence** | Select any route for a full cost breakdown and a **Why this route?** panel where every bullet cites its number. |
| **Optimisation frontier** | 22 independent optimiser runs across the weight simplex, plotted as a Pareto scatter. Click a point to adopt that plan. |
| **Digital twin** | Traffic multipliers, vehicle failures, link closures, deadline changes — then **Replan**. |
| **What-if engine** | Ask a hypothetical, measure it, and restore the world untouched. |
| **Carbon intelligence** | Emissions across eight dimensions, causally attributed, with grid-carbon timing for the electric fleet. |
| **Counterfactual** | A naive baseline against the optimised plan, metric by metric, labelled as calculated differences. |

## Real map, real roads

Nothing here is a simulation of geography.

- **Basemap** — real **satellite imagery** by default: Esri World Imagery as the
  base, with transparent road-network and place-name layers composited on top.
  A satellite base alone has no road names, and a road map alone has no ground
  truth; that hybrid is what makes imagery usable for logistics rather than
  merely pretty. Street-map styles (CARTO Light / Voyager / Dark, OpenTopoMap)
  and your own tile server are also available in Settings.

  All of it is drawn by a hand-written slippy-map renderer in
  `src/render/tileMap.js`: Web Mercator projection, per-layer LRU tile cache,
  in-flight de-duplication, and parent-tile upscaling so zooming never flashes
  empty grey. Marks drawn over imagery carry halos and casings chosen from the
  basemap in use (`onImagery()` in `src/render/palette.js`), because a route can
  cross dark water and bright rooftops inside a single frame.
- **Routing** — [OSRM](https://project-osrm.org/) over real OSM road geometry.
  The whole problem's travel times and distances arrive in **one** `/table`
  request; the drawn path for each route comes from `/route`.
- **Finding different roads** — OSRM's `alternatives` parameter is far more
  conservative than people expect: it only returns candidates that pass its
  sharing, stretch and detour filters, and the usual answer to "give me three
  roads" is one road. That is a property of the question, not of the world. So
  when the direct request comes back thin, CarbonRoute asks better questions —
  it routes again through via points offset sideways from the straight line,
  which is how a genuinely different corridor (the ring road, the coastal road,
  the one over the bridge) gets found. Results are de-duplicated by how much
  ground they actually share, so the same motorway never appears twice.
  Every road shown is one the routing service returned; nothing is invented.
- **Geocoding** — [Nominatim](https://nominatim.openstreetmap.org/), rate-limited
  to the one-request-per-second its usage policy asks for, with results cached.

**None of these need an account or an API key.** All three are configurable in
Settings, so you can point at your own OSRM instance or tile server for
production volumes.

When the routing service is unreachable, the app does not break and does not
pretend: it falls back to great-circle distances with a detour factor, flags the
matrix `estimated`, raises an alert, dashes the affected route lines, and writes
"straight-line estimates" into the map attribution bar.

## Getting started

```bash
git clone https://github.com/akshatinnovate-png/CarbonRouteX.git
cd CarbonRouteX
python3 -m http.server 8000     # or: npx serve .
```

Open <http://localhost:8000>. ES modules need an HTTP origin, so opening the file
directly will not work.

On first run you land on the homepage, where the satellite map is already live —
it is the same canvas the application uses, so signing in reframes a running
network rather than loading one. Then you are asked one question:

> ### What are you optimising?
> **Personal mobility** — Cars · Bikes · Trips  
> **Logistics operations** — Fleets · Orders · Depots

**PERSONAL** then asks for three things, because three is all it needs:

1. **Welcome** — a local sign-in (see [Data & privacy](#data--privacy)).
2. **Where you are** — centres the map and makes address search find the right place first.
3. **Your vehicle** — car, electric car, motorcycle, bicycle or other, with your own consumption figure if you know it.

**LOGISTICS** walks through the four things the fleet optimiser cannot run without:

1. **Welcome** — the same local sign-in.
2. **Region** — your operating city.
3. **Depots** — at least one; routes start and end here.
4. **Fleet** — vehicle type sets capacity, consumption, range and running cost.
5. **Deliveries** — address, weight, priority and a time window.

Every step is editable afterwards from the Garage, or from the Depots, Fleet and
Orders tabs. The wizard is a convenience, never the only path.

## The two modes

### PERSONAL — one journey, compared four ways

Set a start and a destination. CarbonRoute asks the routing service for the road
alternatives that genuinely exist between them, then costs each one through the
same energy and emissions model the fleet uses:

| Option | How it is decided |
|---|---|
| **Fastest** | The lowest-duration road, full stop |
| **Lowest cost** | The lowest total of fuel/energy plus per-km running cost |
| **Lowest emissions** | The lowest estimated CO₂e |
| **Balanced** | A weighted trade-off across time, cost, emissions and distance |

Three of those are superlatives about a single number, so they are decided by
that number alone. An option labelled *Lowest emissions* that returned anything
other than the lowest-emission road would be lying in its own title; only
*Balanced* is a trade-off, and it is the only one whose label admits to being one.

Every option shows **ETA, distance, energy, cost and CO₂e**, with the best value
on each measure marked. When two options resolve to the same road — which happens
often, and is a real finding about the journey — the card says *same road* rather
than dressing one road up as four.

**Roads found and roads chosen are two different numbers, and conflating them
would be a lie.** When the quickest way is also the shortest, it wins on time,
cost and carbon at once, and all four objectives land on it. That does not mean
there was only one way to go. So the panel reports both — *"7 different roads
compared — one wins on every measure"* — draws every road it found on the map,
and lists the ones no objective picked as **Other roads found**, each costed and
selectable. Somebody who knows the route has reasons the objective function does
not model; a bridge they would rather not cross again is a perfectly good one.

An electric car is charged the **grid intensity of the hour it travels**, so the
explanation can tell you that leaving at noon instead would be measurably cleaner
for exactly the same distance.

### LOGISTICS — the full command centre

Depots, a vehicle register, an order book, capacity/range/time-window constrained
routing, a Pareto frontier across five objectives, a digital twin with a what-if
engine, and a carbon ledger. This is the mode the rest of this README describes.

## The tabs

The interface is split by job, because an operations tool has several genuinely
different ones and cramming them onto one screen made none of them comfortable.

**PERSONAL mode** has three tabs — Journey, Garage and Settings — because a
person planning their own commute has no depots, no order book and no dispatch,
and offering those tabs greyed out would be worse than not offering them.

**LOGISTICS mode** has ten, grouped by job:

| Group | Tab | For |
|---|---|---|
| **Operate** | Map | Watching the live network; an inspector for whatever is selected |
| | Optimise | Objective weights, the solve, convergence, and the Pareto frontier |
| | Simulation | The digital twin and the what-if engine |
| **Manage** | Depots | Sites routes start and end from |
| | Fleet | The vehicle register plus live telemetry |
| | Orders | The delivery book — and the complete text equivalent of the map |
| **Analyse** | Analytics | Baseline vs optimised, plus the route ledger |
| | Carbon | Emissions breakdown, causal attribution, grid timing |
| | Events | Operational timeline and the alert centre |
| **System** | Settings | Basemap, routing endpoints, account, import/export |

Number keys jump between whatever tabs the current mode actually has; `O`
optimises (or opens the journey planner in PERSONAL); `Space` plays the plan
clock; `?` shows the rest. Shortcuts are ignored while you are typing.

## Brand and motion

**White, teal and gold.** White carries the product. Teal means the system
working — active states, primary actions, live routes. Gold is the colour of
significance and is deliberately rare: the selected route, the winning number in
a comparison, the optimised result. If gold were everywhere it would mean
nothing. Deep navy appears only as type, as contrast, and over imagery. The
tokens live in `styles/tokens.css` and are mirrored for canvas drawing in
`src/render/palette.js`.

**Every animation is declared in one place.** `src/ui/motion.js` exports the
complete set of named primitives — `transitionToView`, `focusEntity`,
`animateRouteChange`, `animateNetworkReplan`, `enterCommandCenter`,
`exitCommandCenter`, `openPanel`, `closePanel`, `transitionMode`,
`revealStagger`, `frameNetwork`, `pulseValue` — and views call those rather than
writing their own keyframes. Two rules hold throughout:

1. **Motion carries meaning or it does not happen.** A camera moving to the thing
   you selected, a route redrawing, the network re-planning: each tells you
   something. Decoration does not qualify.
2. **Business logic is never inside an animation.** The optimiser, the store and
   the engines do not know `motion.js` exists. Every primitive is safe to make a
   no-op, which is exactly what `prefers-reduced-motion` does — it skips to the
   end state rather than animating faster. The interface is designed to look
   right with every animation disabled.

## Architecture

```text
                                USER
                                  |
                         SHELL (tabs, pages)
                                  |
                       STATE / EVENT ENGINE (core/)
                                  |
   +--------------+---------------+---------------+--------------+
   |              |               |               |              |
 OSRM          NOMINATIM      TILE SERVER    NETWORK MATRIX   WORKSPACE
 (distances)   (addresses)    (basemap)      (+ traffic)      (localStorage)
                                                  |
                                            PLAN ENGINE
                                       (constraints, costing)
                                                  |
                            +---------------------+--------------------+
                            |                     |                    |
                     ENERGY ENGINE        EMISSIONS ENGINE        COST MODEL
                            |                     |                    |
                            +----------+----------+--------------------+
                                       |
                             OPTIMIZATION ENGINE
                            (construct + anneal + repair)
                                       |
                    +------------------+------------------+
                    |                  |                  |
              PARETO ENGINE     SCENARIO ENGINE    EXPLANATION LAYER
                    |                  |                  |
                    +---------+--------+------------------+
                              |
                   TILE MAP + OVERLAYS + PAGES
```

**The one-way rule.** Engines never import a view. Views never mutate state; they
call store methods and subscribe to the bus. That single constraint is what keeps
the map, the tables and the screen-reader announcements in sync without a framework.

```text
src/
├── config.js                  every physical constant, in one auditable place
├── main.js                    boot order, map wiring, fatal error surface
├── core/
│   ├── bus.js                 pub/sub event bus (the only cross-layer channel)
│   ├── store.js               single owner of state; owns the plan clock
│   └── storage.js             the local workspace, guarded against blocked storage
├── services/
│   ├── osrm.js                road matrix + route geometry, cached and retried
│   ├── geocode.js             Nominatim, rate-limited and cached
│   └── tiles.js               basemap providers and attribution
├── engines/
│   ├── matrix.js              the road matrix + the traffic model on top of it
│   ├── energy.js              load / speed U-curve / gradient consumption model
│   ├── emissions.js           carrier intensity, incl. hourly grid carbon
│   ├── plan.js                route execution, constraints, objective function
│   ├── optimizer.js           regret-2 insertion, annealing, validation, Pareto
│   ├── personal.js            PERSONAL mode: one journey, four honest comparisons
│   └── explain.js             every narrative in the product
├── render/
│   ├── mercator.js            Web Mercator, haversine, polyline codec
│   ├── tileMap.js             the slippy map: tiles, pan/zoom, picking
│   ├── overlays.js            routes, stops, depots, vehicles, heatmap
│   └── palette.js             single source of truth for colour
├── ui/
│   ├── landing.js             the homepage and the PERSONAL/LOGISTICS chooser
│   ├── motion.js              every animation in the product, as named primitives
│   ├── shell.js               mode-aware tab set and page host
│   ├── onboarding.js  components.js  charts.js  icons.js
│   └── pages/  trip · garage                            (PERSONAL)
│                map · optimize · simulation · depots · fleet · orders
│                · analytics · carbon · events           (LOGISTICS)
│                settings                                (both)
├── input/keyboard.js
└── util/  math.js  format.js  dom.js
```

## Optimisation model

```text
INPUT            depots, vehicles, orders, weights, clock
  ↓
ROAD MATRIX      one OSRM /table request for every stop pair
  ↓
CONSTRAINTS      capacity (hard) · energy range (hard) · availability (hard)
                 deadlines (soft) · depot window (soft)
  ↓
CANDIDATE GEN    regret-2 insertion over the 5 nearest depots per order
  ↓
ROUTE EVAL       depot → load → leg → service → … → return, costed leg by leg
  ↓
OBJECTIVE        scalarised, normalised against a naive baseline
  ↓
OPTIMISATION     simulated annealing: relocate · swap · 2-opt · eject/reinsert
  ↓
VALIDATION       repair pass: eject the least valuable stop until feasible, reinsert
  ↓
SELECTED PLAN    published; real road geometry fetched afterwards for drawing
```

### The objective function

Defined in `engines/plan.js` → `scorePlan()`. **Lower is better**; 1.0 means "as
good as the baseline".

```text
score = w_time  × (fleet_minutes / ref_minutes)
      + w_cost  × (operating_cost / ref_cost)
      + w_co2   × (kg_CO2e       / ref_co2)
      + w_dist  × (distance_km   / ref_km)
      + w_rel   × (1 − reliability × on_time_rate)
      + (late_minutes / ref_minutes) × LATE_PENALTY        // soft constraint
      + (unserved × UNSERVED_PENALTY) / ref_minutes        // dropping an order
      + hard_violations × 2.5                              // never published
```

Weights come straight from the Optimise sliders, normalised to sum to 1.

**Construction — regret-2 insertion.** Orders are inserted into the cheapest
feasible slot, but processed in order of *regret*: the order whose second-best
option is much worse than its best goes first, because that is the one we would
most regret leaving until the good slots are gone. Regret is scaled by priority.

**Improvement — simulated annealing.** Relocate, swap, 2-opt and eject moves, with
temperature falling geometrically over 9,000 iterations. A move re-evaluates only
the one or two routes it touched.

**Validation.** The annealer is *allowed* to visit infeasible states — that
freedom is how it escapes local optima — so its result goes through an explicit
repair pass before publication. Anything that still cannot be placed lands in
`unserved`, where the alert system surfaces it rather than it disappearing.

**Cooperative scheduling.** The run yields to the browser every ~12 ms, so the map
keeps animating at 60 fps while the fleet is re-planned. An optimiser that freezes
the command centre is useless in an operations room.

### Traffic

OSRM's public service returns free-flow durations, so congestion is applied on top
as a transparent, deterministic multiplier from time of day plus scenario
overrides (`engines/matrix.js`). It is clearly a **model**, not an observation —
and it is the same model on both sides of every comparison, which is what makes
before/after honest.

## Carbon model

```text
units  = (consumption/100 × km) × f_load × f_speed × f_grade
CO2e   = units × carrier_intensity(hour)
```

- **`f_load`** — payload raises rolling resistance and inertia. Because payload
  *declines* as the vehicle delivers, and the energy engine sees that decline leg
  by leg, **visit order changes emissions, not just time**. There is a test for
  exactly this.
- **`f_speed`** — a U-curve minimised near 62 km/h. Stop-and-go wastes energy; so
  does high-speed drag. This is what makes congestion avoidance a *carbon* lever.
- **`f_grade`** — neutral in this build; see [Limitations](#limitations).
- **`carrier_intensity`** — constant for diesel and CNG; for battery-electric it
  is the **grid intensity at the hour of travel**, so the same e-truck on the same
  route at 11:00 and 19:00 emits very differently.

`explain.explainCarbon()` decomposes each leg's multipliers to separate the
unavoidable physics from the part routing can actually change.

## Data model

```js
depot   = { id, name, lon, lat, label, short, dockCount, openMinutes, closeMinutes }

vehicle = { id, callsign, registration, type, typeLabel, driver,
            capacityKg, energyType, energyLevel, depotId,
            lon, lat, heading, status, available, assignedOrders, routeId, progress }

order   = { id, ref, consignee, goods, notes, lon, lat, label, short,
            priority, weightKg, windowOpen, deadline, serviceMinutes,
            status, assignedVehicle, routeId, etaMinutes, deliveredAt }

route   = { id, vehicleId, depotId, orderIds,
            stops: [{ orderId, lon, lat, arrival, waited, serviceStart,
                      departure, late, deadline, loadBeforeKg, legKm, legCo2 }],
            legs, path, geometryEstimated,
            km, minutes, drivingMinutes, serviceMinutes,
            units, co2, cost, risk,
            capacityUsedKg, capacityPct, energyFraction, reliability, onTime,
            lateMinutes, lateOrders, feasible, violations }

plan    = { id, label, createdAt, weights, routes, unserved,
            metrics: { km, minutes, co2, cost, stops, vehiclesUsed,
                       utilization, onTimeRate, unserved, hardViolations, feasible },
            score, scoreBreakdown }
```

PERSONAL mode adds a much smaller shape of its own:

```js
personal = { vehicleKey, vehicles: [{ id, key, label, consumption }],
             origin, destination, departMinutes, optionKey, history }

trip     = { id, at, from, to, departMinutes, vehicleKey,
             trips:   [{ id, points, km, minutes, arriveMinutes, speedKmh,
                         units, unitLabel, intensity, co2,
                         energyCost, runningCost, cost, estimated, via, factors }],
             options: [{ key, label, blurb, trip, score, sharedWith }],
             best, worst, estimated,
             roadsFound,        // distinct roads discovered
             chosenRoads,       // how many of them the four objectives land on
             chosen, chosenRoadId, drivers, versusFastest }
```

## Performance

- One `requestAnimationFrame` loop; the store's clock is advanced by it.
- **One** routing request for the entire distance matrix, not N².
- LRU tile cache with in-flight de-duplication and parent-tile fallback.
- Route-evaluation cache keyed to the matrix revision and traffic state.
- Route geometry cached and de-duplicated; fetched *after* the plan publishes, so
  the plan appears instantly and the real road path fills in as it arrives.
- Debounced address search (420 ms), throttled tables, `raf1`-coalesced renders.
- Reduced-motion support in both CSS and the render loop.

## Accessibility

**The map is never the only way to understand the system.** The Orders tab is a
complete, sortable, keyboard-navigable text equivalent of every stop on it.

- Two ARIA live regions; selections, tab changes, optimisation results and errors
  are all announced.
- Full keyboard model (`1`–`9`, `O`, `S`, `M`, `+`/`−`, `Space`, `Esc`, `?`).
  Shortcuts never fire while typing, and chords with Ctrl/Meta/Alt are left alone.
- Semantic tablist/tabpanel wiring, `aria-sort` on sortable headers, `aria-pressed`,
  `aria-current`, visible focus rings, a skip link.
- `prefers-contrast: more` strengthens every border and lifts text contrast.
- `prefers-reduced-motion: reduce` is honoured in CSS *and* in the render loop.

## Installation

Nothing to install. Node is needed only to run the test suite.

## Configuration

`src/config.js` holds every tunable physical constant — vehicle archetypes, energy
carrier factors, hourly grid intensity, objective presets, optimiser budget, the
diurnal traffic curve, the operating window. Geography and roads are *not*
configured here; they come from real OSM data.

Runtime settings live in the Settings tab and persist locally: basemap provider
(or a custom XYZ template), OSRM endpoint, Nominatim endpoint, and workspace
import/export.

## Deployment

Any static host. No server component, no API key, no build step.

```bash
# GitHub Pages: push this directory to a gh-pages branch
# Netlify / Vercel / Cloudflare Pages: build command (none), publish directory .
```

For production volumes, run your own OSRM and tile server and point Settings at
them — the public instances are rate-limited and offer no uptime guarantee.

## Testing

```bash
node tests/engines.test.mjs
```

82 tests, no dependencies, fully offline (the routing client's transport is stubbed
to exercise the documented fallback path).

**Projection** — `project`/`unproject` round-trip, world-pixel round-trip at every
zoom, pole clamping, haversine against known city distances, bearing, metres-per-pixel
halving, polyline decoding against the specification example.

**Routing client** — fallback matrix symmetry and zero diagonal, detour factor,
unreachable service degrades to a *labelled* estimate rather than an exception,
over-limit stop counts reported rather than silently truncated.

**Tile providers** — every provider yields a well-formed HTTPS URL with no
unsubstituted tokens and credits its actual source; subdomains rotate; the
default basemap is real imagery and carries its road-and-label overlay.

**Matrix & traffic** — rush hour costs more time than the small hours, a multiplier
slows every leg, congestion costs *energy* as well as time, incidents are local
rather than global, closures are impassable in both directions.

**Plan & constraints** — capacity and range enforced as hard violations, payload
declines leg by leg, **visit order changes emissions**, stop times monotonic and
window-respecting, lateness detected, aggregation sums its routes exactly.

**Optimizer** — beats the baseline, respects every hard constraint, serves no order
twice and loses none, different weights produce different plans, empty fleet and
empty order book handled, disabling a vehicle moves its work.

**Finding different roads** — via candidates land off the direct line on both
sides of it and never collapse onto the start; a zero-length journey yields no
candidates rather than NaN; the same road is recognised however densely its
geometry is drawn, while a road a few streets over is not; a router offering one
road is probed until it offers several; a generous router is not probed at all;
duplicates are never offered twice; an absurd detour is not presented as a
choice; a failing service stops the probe storm after the first batch; an
unreachable router still degrades to a labelled estimate.

**Personal trip engine** — a bicycle emits and costs nothing; the fastest road is
not automatically the greenest, and neither is the shortest; one road in means one
road out, flagged as the same road rather than dressed up as four; an electric car
burns the same energy at noon and at 19:00 but emits more in the evening; a custom
consumption figure scales the estimate linearly; comparison prose never dangles
when nothing is worse; an unreachable routing service is reported, not disguised; and **four roads found
with one winner is reported as exactly that**, never as "there is one sensible
road".

**Explanation layer** — tested for *honesty*: every driver must cite a number, an
identical plan must claim no change, **a strictly worse plan must be described as
worse rather than spun**, `planDiff` reassignments verified against both plans,
carbon attribution must sum to the reported total.

The UI is verified in Chromium end to end — the landing page and its live map, the
mode chooser, both onboarding paths with live geocoding, a PERSONAL journey
compared four ways, switching modes from Settings, the LOGISTICS optimise run and
all ten of its tabs, a 390 px phone viewport, and the whole thing again under
`prefers-reduced-motion` — against a local mock of the tile, routing and geocoding
services, checking for zero page errors and no horizontal overflow.

## Limitations

Stated plainly, because a system that hides its limits cannot be trusted with real
freight.

- **Traffic is modelled, not observed.** A deterministic time-of-day multiplier over
  OSRM's free-flow durations. It is plausible and consistent; it is not a live feed.
- **Gradient is neutral.** Without an elevation service the energy model leaves
  `f_grade` at 1.0 rather than inventing terrain. Hilly regions will be
  underestimated.
- **Emissions are estimates**, not measurements — published factors applied to
  modelled energy. Real fleets need on-board telematics.
- **The VRP solve is heuristic.** Simulated annealing gives good solutions, not
  provably optimal ones.
- **The public routing service caps a matrix at ~90 stops.** Beyond that the app
  says so and estimates. Run your own OSRM to lift the cap.
- **Single-depot-return routes.** No multi-trip, no trailer swaps, no driver hours
  regulations, no cross-docking, no pickup-and-delivery pairing.
- **Time windows are single and soft.** No multi-window customers.
- **Charging is not scheduled** — range is a constraint, not a mid-route activity.
- **PERSONAL mode routes on the car network.** The public routing service models a
  car. A bicycle's and a motorcycle's durations are scaled from that, not routed on
  a cycle network, and the interface says so rather than implying otherwise.
- **Road discovery is opportunistic, not exhaustive.** Up to eight via-point
  probes are spent per journey, in batches, and probing stops early once enough
  distinct roads are in hand or the service starts refusing. It finds the
  corridors that matter; it does not enumerate every lane. If the router and the
  probes all come back on one road, all four options point at it and say so —
  CarbonRoute will not manufacture variety that does not exist.
- **Probing costs requests.** A journey plan is one request plus up to eight more
  against a free public service. Results are cached per origin–destination pair.
  Point Settings at your own OSRM instance if you are planning at volume.
- **Satellite imagery is a basemap, not a data source.** Nothing is derived from the
  pixels; roads, distances and durations all come from OpenStreetMap geometry.
- **Sign-in is not authentication.** See below.

## Roadmap

- Elevation service for real gradient-aware energy modelling
- Live traffic and grid-intensity adapters behind the existing service interfaces
- Driver hours-of-service and multi-trip constraints
- Charging as a routable activity with a charger network
- Pickup-and-delivery pairing and backhaul
- Stochastic optimisation over travel-time distributions
- A Web Worker for the optimiser, freeing the main thread entirely
- Plan export (CSV / GeoJSON) and a shareable plan link

## Responsible AI

This product makes claims about time, money and carbon. The rules it holds itself to:

1. **No fabricated reasoning.** Every sentence in the explanation layer is derived
   from a computed difference between two evaluated objects. Drivers below a 1.5%
   relative change are suppressed rather than dressed up.
2. **No flattering comparisons.** Both sides of every before/after are evaluated
   under identical conditions. In the digital twin, the "before" column is the
   previous assignment *re-costed under the new conditions* — comparing against its
   original figures would credit the optimiser with avoiding a disruption it did
   not cause. Under disruption the honest verdict is often "this is worse on
   everything, and it is the best available", and that is what it says.
3. **Estimates are labelled as estimates.** "Estimated CO₂e", never "CO₂e measured".
4. **Modelled data is labelled as modelled** — the traffic chip says "Traffic model",
   and straight-line fallbacks are flagged in the attribution bar, on the route
   lines, and in an alert.
5. **Uncertainty is not hidden.** Infeasible plans, unserved orders and constraint
   violations surface as alerts, not quiet drops.
6. **The model is auditable.** Constants live in one file; the objective function is
   documented above and in the source; convergence, iteration count, evaluation
   count and matrix provenance are all on screen.

## Data & privacy

- **Nothing is uploaded.** Your depots, fleet, orders and settings live in this
  browser's `localStorage` and nowhere else. There is no backend and no analytics.
- **Outbound requests go only to** the tile provider, the routing service and the
  geocoder you configured — and they receive only what they need: tile coordinates,
  stop coordinates, and search text.
- **Sign-in is local and has no password**, because there is no account server to
  check one against. It labels whose workspace this is on a shared machine; it is
  **not** a security boundary, and the UI says so rather than implying otherwise.
- Every storage access is wrapped in `try/catch`; the app stays usable with site
  data blocked and says so once.
- Export your workspace to move it between machines.

## Technical decisions

**Why no mapping library?** The overlay — routes, vehicles, heatmap — is already
canvas work, and compositing it into the same context as the tiles avoids a second
rendering stack and the DOM-marker cost that comes with it. It also keeps the app
dependency-free and installable offline. `tileMap.js` is ~450 lines.

**Why no framework?** The hot path is a 60 fps canvas renderer next to an optimiser
doing tens of thousands of route evaluations. A virtual DOM buys nothing there and
costs a build step, a dependency tree and a supply chain.

**Why one matrix request instead of per-leg routing?** The optimiser evaluates a
route thousands of times a second; it cannot make a network call per leg. Fetching
the whole N×N table once turns every subsequent evaluation into an array lookup —
the difference between one request and several hundred.

**Why is route geometry fetched after publishing?** It is presentation, not
optimisation: the plan is already fully costed from the matrix. Fetching it off the
critical path means the plan appears instantly and the real road path fills in as
it arrives — and a geometry failure degrades the drawing, never the answer.

**Why regret-2 insertion before annealing?** A random start wastes most of the
annealing budget climbing out of nonsense. Regret insertion lands a feasible,
sensible plan in a fraction of a second, so the whole budget goes into improving it.

**Why is the baseline deliberately naive?** Nearest depot, booking order, no
sequencing, no carbon awareness — because that is what dispatch does without a
system like this. Benchmarking against an already-good plan would understate the gap
and mislead the operator.

## Attribution & licensing

Map data © OpenStreetMap contributors, used under the
[Open Database License](https://www.openstreetmap.org/copyright). Attribution is
rendered permanently on the map and must stay there.

- Basemap tiles: CARTO / OpenStreetMap / OpenTopoMap (CC-BY-SA), per provider
- Routing: [OSRM](https://project-osrm.org/)
- Geocoding: [Nominatim](https://nominatim.openstreetmap.org/) — please respect its
  [usage policy](https://operations.osmfoundation.org/policies/nominatim/)

Application code: see [LICENSE](LICENSE).

---

*CarbonRoute — optimise the network, not just the route.*
