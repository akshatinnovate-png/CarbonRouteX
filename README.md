# CarbonRoute X

**An AI logistics intelligence platform that simulates, optimises, explains and visualises how an entire delivery network should operate across time, cost, capacity, traffic, energy and carbon.**

No build step. No dependencies. No network calls. Open `index.html` and the whole
thing — a road-network generator, a weighted A\* router, a constrained vehicle-routing
optimiser, a digital twin and a real-time canvas renderer — runs in the browser.

> **DEMO / SIMULATION.** Every traffic, telemetry and emissions figure in this
> application is computed from a deterministic model of a synthetic city. Nothing
> here is a live real-world measurement. See [Responsible AI](#responsible-ai).

---

## Contents

[Overview](#overview) · [Problem](#problem) · [Solution](#solution) ·
[Key features](#key-features) · [System architecture](#system-architecture) ·
[Optimisation model](#optimisation-model) · [Multi-objective optimisation](#multi-objective-optimisation) ·
[Fleet intelligence](#fleet-intelligence) · [Digital twin](#digital-twin) ·
[Scenario simulation](#scenario-simulation) · [Carbon intelligence](#carbon-intelligence) ·
[Route engine](#route-engine) · [Data model](#data-model) ·
[Frontend architecture](#frontend-architecture) · [Visualisation architecture](#visualisation-architecture) ·
[Performance](#performance) · [Accessibility](#accessibility) · [Demo mode](#demo-mode) ·
[API architecture](#api-architecture) · [Installation](#installation) ·
[Configuration](#configuration) · [Running locally](#running-locally) ·
[Deployment](#deployment) · [Testing](#testing) · [Limitations](#limitations) ·
[Future roadmap](#future-roadmap) · [Responsible AI](#responsible-ai) ·
[Data & privacy](#data--privacy) · [Technical decisions](#technical-decisions)

---

## Overview

CarbonRoute X is a command centre for a delivery fleet. It generates a metro-scale
road network, books an order book against it, assigns a mixed fleet of diesel, CNG
and battery-electric vehicles, and then continuously answers four questions:

1. **What should the fleet do?** — a constrained vehicle-routing solve.
2. **Why that, and not something else?** — an explanation derived from the numbers
   the engines actually produced.
3. **What happens if the world changes?** — a digital twin you can break on purpose.
4. **What did it cost, in time, money and carbon?** — a counterfactual against a
   baseline that is evaluated under identical conditions.

The map is not a picture of the answer. It is the answer, rendered.

## Problem

Route planners optimise *a route*. Logistics operations are not a route — they are a
network of interacting constraints where improving one vehicle's day makes another's
worse. Three things are usually missing:

- **Carbon is an afterthought.** It is reported after the fact, not optimised for.
  Yet the levers that move it — payload sequencing, congestion avoidance, gradient,
  and *when* an electric vehicle draws from the grid — are routing decisions.
- **The trade-off is hidden.** "14% greener" means nothing without knowing what was
  given up. Faster? Cheaper? Both?
- **Disruption is where plans die.** A plan that cannot be re-solved in seconds when
  a road closes or a vehicle fails is a document, not a system.

## Solution

A single objective function, explicitly weighted by the operator, driving both the
path search and the fleet assignment — with the trade-off surface made visible and
every claim traceable to a computed number.

---

## Key features

| | |
|---|---|
| **Live logistics map** | Procedurally generated metro: terrain, water, districts, a four-tier road hierarchy, traffic field, depots, fleet, routes and delivery nodes. Eleven toggleable layers. |
| **Multi-objective optimiser** | Five weighted objectives (time, cost, emissions, distance, reliability) feeding one scalar score. Four presets plus free-form weights. |
| **Route intelligence** | Select any route for a full cost breakdown and a **Why this route?** panel whose every bullet cites the number behind it. |
| **Optimisation frontier** | 22 independent optimiser runs across the weight simplex, plotted as a Pareto scatter. Click a point to adopt that plan. |
| **Digital twin** | Traffic multipliers, vehicle failures, road closures, urgent-order injection, deadline changes — then **REPLAN**. |
| **What-if engine** | Ask a hypothetical, measure it, and restore the world untouched. |
| **Carbon intelligence** | Emissions broken down across eight dimensions, causally attributed, with a grid-carbon timing analysis for the electric fleet. |
| **Counterfactual** | Baseline dispatch vs. CarbonRoute X, metric by metric, labelled as calculated differences. |
| **Route comparison** | Four genuinely different approach legs per delivery (fastest / greenest / cheapest / balanced), costed identically. |
| **Event stream & alerts** | An operational timeline where every entry corresponds to an action the system actually took. |
| **Order book** | A complete, sortable, keyboard-navigable text equivalent of the map. |

---

## System architecture

```text
                                USER
                                  |
                          COMMAND CENTRE  (ui/)
                                  |
                       STATE / EVENT ENGINE  (core/)
                                  |
   +-----------------+------------+------------+-----------------+
   |                 |                         |                 |
 WORLD           ROUTE ENGINE            PLAN ENGINE        TRAFFIC ENGINE
 (graph)         (weighted A*)        (constraints, cost)   (congestion field)
   |                 |                         |                 |
   +--------+--------+------------+------------+--------+--------+
            |                     |                     |
      ENERGY ENGINE        EMISSIONS ENGINE        COST MODEL
            |                     |                     |
            +----------+----------+----------+----------+
                       |                     |
              OPTIMIZATION ENGINE     EXPLANATION LAYER
              (construct + anneal)    (diff -> narrative)
                       |                     |
            +----------+----------+          |
            |                     |          |
      PARETO ENGINE        SCENARIO ENGINE   |
            |                     |          |
            +----------+----------+----------+
                       |
              MAP ENGINE + ANALYTICS  (render/, ui/panels/)
```

**The one-way rule.** Engines never import a view. Views never mutate state; they
call store methods and subscribe to the bus. That single constraint is what keeps
the map, the panels, the analytics and the screen-reader announcements in sync
without a framework.

### Module map

```text
src/
├── config.js                  every physical constant, in one auditable place
├── main.js                    boot order, killer demo, fatal error surface
├── core/
│   ├── bus.js                 pub/sub event bus (the only cross-layer channel)
│   ├── store.js               single owner of state; the simulation clock
│   └── storage.js             UI preferences only; guarded against blocked storage
├── data/
│   ├── world.js               terrain, water, districts, routable road graph
│   └── seed.js                deterministic depots, fleet and order book
├── engines/
│   ├── traffic.js             per-edge congestion field (BPR-style volume/delay)
│   ├── route.js               weighted A* + path cache + alternative corridors
│   ├── energy.js              load / speed / gradient consumption model
│   ├── emissions.js           carrier intensity, incl. hourly grid carbon
│   ├── plan.js                route execution, constraints, objective function
│   ├── optimizer.js           regret-2 insertion + simulated annealing + repair
│   └── explain.js             every narrative in the product
├── render/
│   ├── camera.js              world-km -> screen-px, eased transitions
│   ├── mapEngine.js           canvas renderer, hit testing, input
│   └── palette.js             single source of truth for colour
├── ui/
│   ├── hud.js  commandCenter.js  inspector.js  dock.js  intro.js
│   ├── charts.js  icons.js
│   └── panels/  analytics · frontier · carbon · simulation · orders · events
├── input/keyboard.js
└── util/  math.js  format.js  dom.js
```

---

## Optimisation model

```text
INPUT            vehicles, orders, depots, weights, clock
  ↓
CONSTRAINTS      capacity (hard) · energy range (hard) · availability (hard)
                 deadlines (soft) · depot window (soft)
  ↓
CANDIDATE GEN    regret-2 insertion over the 5 nearest depots per order
  ↓
ROUTE EVAL       depot → load → leg → service → … → return, costed leg by leg
  ↓
OBJECTIVE        scalarised, normalised against a reference plan
  ↓
OPTIMISATION     simulated annealing: relocate · swap · 2-opt · eject/reinsert
  ↓
VALIDATION       repair pass: eject least-valuable stop until feasible, reinsert
  ↓
SELECTED PLAN    published to the store
  ↓
VISUALISATION    map, panels, analytics, live-region announcements
```

### The objective function

Defined in `engines/plan.js` → `scorePlan()`. **Lower is better**; a score of 1.0
means "as good as the baseline".

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

Weights come straight from the UI sliders, normalised to sum to 1. The reference
denominators come from the naive baseline plan, which makes the score comparable
across runs and gives the counterfactual a fixed anchor.

### Construction — regret-2 insertion

Orders are inserted one at a time into the cheapest feasible (vehicle, position)
slot. The *order of insertion* is by **regret**: the order whose second-best option
is much worse than its best goes first, because that is the one we would most regret
leaving until the slots are gone. Regret is scaled by priority so a critical
consignment claims the good slots.

### Improvement — simulated annealing

Four neighbourhood moves, chosen stochastically:

| Move | What it does | Why it matters |
|---|---|---|
| **Relocate** | Move one order to another vehicle or position | The workhorse |
| **Swap** | Exchange orders between two vehicles | Fixes crossed territories |
| **2-opt** | Reverse a run within one route | Untangles sequence |
| **Eject** | Drop an order to the unserved pool | Escape hatch across infeasible valleys |

A move re-evaluates only the one or two routes it touched; the plan score is then
re-aggregated over ~10 routes. Temperature falls geometrically from 1.0 to 0.0035
over 9,000 iterations.

**The annealer is allowed to visit infeasible states** — that freedom is how it
escapes local optima — so the result is put through an explicit **validation and
repair** pass before it can be published. Anything that still cannot be placed lands
in `unserved`, where the alert system surfaces it rather than it disappearing.

### Cooperative scheduling

The whole run yields to the browser every ~12 ms (`OPTIMIZER.timeSliceMs`). The map
keeps animating at 60 fps while the fleet is being re-planned. An optimiser that
freezes the command centre is useless in an operations room.

---

## Multi-objective optimisation

Five sliders, four presets, and a live indicator when the weights no longer match
the published plan.

```text
TIME        ━━━━━●━━━━   22%      Preset ▸ FASTEST · LOWEST COST
COST        ━━━━━●━━━━   22%               LOWEST CARBON · BALANCED · CUSTOM
EMISSIONS   ━━━━━━●━━━   24%
DISTANCE    ━━━●━━━━━━   14%
RELIABILITY ━━━━●━━━━━   18%
```

Weights are not cosmetic. They enter the model **twice**:

1. **In the router**, as the edge cost — so a green-weighted solve takes physically
   different roads, not just a different stop order.
2. **In the plan objective**, as the assignment score.

### Optimisation frontier

`Optimizer.frontier()` samples 22 weight vectors (the four presets as recognisable
anchors, plus corner-biased Dirichlet samples, since the interesting trade-offs live
near the edges of the simplex), optimises each independently, and filters to the
non-dominated set across cost × time × CO₂e.

The scatter plot recomputes dominance for the **displayed pair of axes**, because
plotting a 3-D frontier on 2-D axes shows points that look dominated but are not —
which reads as a bug rather than as a third objective the viewer cannot see. The
global count is reported alongside.

Clicking a candidate reports, in computed numbers, exactly what adopting it trades.

---

## Fleet intelligence

Each vehicle carries a type archetype (capacity, consumption curve, load
sensitivity, usable range, cost per km, crew cost, top speed) and live state
(position, heading, state of charge, status, assignment).

**States:** `moving` · `delivering` · `idle` · `returning` · `delayed` ·
`charging` · `disabled`

Selecting a vehicle **focuses the map → highlights its route → opens telemetry →
lists its manifest**, all from one store selection, so nothing can drift out of sync.

Alerts are *derived* from the plan and the world on every change — range thresholds,
schedule slippage, hard-constraint violations, congestion on a route's corridor,
unassigned orders. Clicking one navigates to the entity.

---

## Digital twin

Stage disruptions, then commit them:

| Control | Effect on the model |
|---|---|
| **Traffic** normal / +10% / +30% / +60% / severe | Global multiplier into the congestion field |
| **Vehicle failure** | `available = false`; its work must go somewhere |
| **Road closure** | Edges marked closed; the router treats them as impassable |
| **Core incident** | A localised congestion zone with smooth falloff |
| **Urgent order** | A new critical consignment injected into the open book |
| **Deadline change** | ±30/60/120 min on any open order |

Pressing **REPLAN** animates **EVENT → DETECTION → OPTIMISATION → NEW PLAN**, and
each stage is a real call into the engines.

### The honest before/after

The comparison is between **the existing plan re-costed under the new conditions**
and the re-optimised plan — *not* between the new plan and the old plan's old
numbers. Comparing against the old numbers would credit the optimiser with avoiding
a disruption it did not cause. That is the difference between an explanation and a
sales pitch, and it is enforced in `store.replan()`.

---

## Scenario simulation

The **what-if engine** (`store.whatIf()`) mutates the world, re-optimises, measures,
and then restores every mutated field in a `finally` block. The live plan is never
touched, so a question can be asked without committing the answer.

```text
WHAT IF TRUCK 04 BECOMES UNAVAILABLE?

BEFORE                          AFTER
8 vehicles                      7 vehicles
26 deliveries                   26 deliveries
44.2 kg CO2e                    47.9 kg CO2e
24h 31m fleet time              25h 48m fleet time
```

Followed by the recovery strategy: which orders moved vehicle, which routes were
resequenced, which vehicles were brought into service — all read out of a structural
diff of the two plans (`explain.planDiff()`), not narrated.

---

## Carbon intelligence

### The model

```text
units  = (consumption/100 × km) × f_load × f_speed × f_grade
CO2e   = units × carrier_intensity(hour)
```

- **`f_load`** — payload raises rolling resistance and inertia. Because payload
  *declines* as the vehicle delivers, and the energy engine sees that decline leg by
  leg, **visit order changes emissions, not just time**. Drop the heavy freight early
  and the rest of the route is cheaper to move.
- **`f_speed`** — a U-curve minimised near 62 km/h. Stop-and-go wastes energy; so
  does high-speed drag. This is what makes congestion avoidance a *carbon* lever.
- **`f_grade`** — climbing costs, descending recovers (62% regen for BEV, 18%
  coasting for combustion).
- **`carrier_intensity`** — constant for diesel and CNG; for battery-electric it is
  the **grid intensity at the hour of travel**. The same e-Truck on the same route at
  11:00 and 19:00 emits very differently, which makes time-shifting a real lever.

### Causal attribution

`explain.explainCarbon()` decomposes each link's multipliers to split the total into
*unavoidable* (distance × drivetrain) versus *addressable* (payload mass, congestion
and speed profile, terrain), and reports what share the optimiser can actually act on.

### Breakdowns

Emissions can be grouped by vehicle, route, delivery, region, vehicle type, energy
source, distance band or traffic level — plus an interactive carbon heatmap that
accumulates per-link CO₂e density along planned routes, so the hot cells are where
the fleet *emits*, not simply where it drives most.

---

## Route engine

Weighted A\* over the road graph, where the edge cost is a **generalised minute**:

```text
gen(e) = w_time × minutes
       + w_dist × (km × 60 / REF_SPEED)
       + w_cost × (rupees / COST_PER_MIN)
       + w_co2  × (kgCO2e / CO2_PER_MIN)
       + w_rel  × risk_minutes
```

Converting every term into the same unit makes the weights directly comparable and
keeps the search a single-objective shortest path — which is what makes it fast
enough to run tens of thousands of times inside the VRP loop.

**Admissibility.** The heuristic is straight-line distance × the *minimum possible*
generalised cost per km (fastest road, flattest grade, empty vehicle), with 2% float
slack. It is a strict lower bound, so A\* returns genuinely optimal paths — a
property the test suite verifies against an exhaustive Dijkstra.

**Alternative corridors** come from iterative edge penalisation: find the best path,
make its edges progressively more expensive, search again. This produces genuinely
different corridors rather than near-duplicates.

**Caching.** Paths are keyed by `(from, to, profile, traffic revision)` with an
approximate-LRU eviction that drops the oldest quarter. Hit rates above 90% are
typical inside an optimisation run, and the rate is reported in the analytics panel.

### Road network generation

Deterministic from one seed. Built in dependency order so the network is connected
*by construction*:

1. A warped arterial grid — the substrate everything attaches to.
2. Diagonal collectors — shortcuts that make routing decisions non-trivial.
3. Inner ring highway, ramped onto the grid at every other junction.
4. Outer ring (partial, as real outer rings are).
5. Eight radial highways from the core to the boundary.
6. Local street clusters inside districts, fed onto the through network.
7. **A stitching pass** that welds any remaining island onto the main component.

Road class follows a **superblock** rule — every third grid line is an arterial, the
next a collector, the rest local. Real cities are built this way, and it is what
stops the network rendering as uniform graph paper while giving the router a genuine
hierarchy to exploit.

---

## Data model

```js
vehicle = {
  id, callsign, type, driver,
  capacityKg, energyType,        // diesel | cng | bev
  energyLevel,                   // 0..1 state of charge / fuel
  depotId, homeNode,
  x, y, heading,
  status,                        // moving|delivering|idle|returning|delayed|charging|disabled
  available, assignedOrders, routeId, progressKm,
  telemetry: { odometerKm, tyreHealth },
}

order = {
  id, consignee, goods, districtId, district,
  x, y, nodeId,
  priority,                      // critical | high | standard | economy
  weightKg, volumeM3,
  windowOpen, deadline, serviceMinutes,
  status,                        // pending|assigned|enroute|delivered|unserved
  assignedVehicle, routeId, etaMinutes, deliveredAt,
}

route = {
  id, vehicleId, vehicleType, depotId,
  orderIds,                      // in visit order
  stops: [{ orderId, arrival, waited, serviceStart, departure, late,
            deadline, loadBeforeKg, legKm, legMinutes, legCo2 }],
  legs, polyline,
  km, minutes, drivingMinutes, serviceMinutes,
  units, co2, cost, toll, risk,
  capacityUsedKg, capacityPct, energyFraction, reliability, onTime,
  lateMinutes, lateOrders,
  feasible, violations: [{ code, severity, label }],
}

plan = {
  id, label, createdAt, weights,
  routes, unserved,
  metrics: { km, minutes, co2, cost, units, stops, lateOrders,
             vehiclesUsed, utilization, fleetUtilization,
             reliability, onTimeRate, unserved, hardViolations, feasible },
  score, scoreBreakdown, reference,
}
```

---

## Frontend architecture

**No framework, no build step, no dependencies.** ES modules loaded natively.

- **`core/bus.js`** — the only cross-layer channel. Typed event constants, guarded
  dispatch depth, handlers isolated so one throwing subscriber cannot break a render.
- **`core/store.js`** — single owner of state. Owns the simulation clock: vehicles
  advance along their route polylines at the route's own modelled speed profile, so
  what you see on the map matches the ETA the optimiser committed to.
- **`util/dom.js`** — a ~150-line `el()` / `mount()` helper, plus `raf1` (coalesce to
  one call per frame) and `throttle` (rate-limit views driven by the 60 fps tick).

---

## Visualisation architecture

Canvas 2D for everything high-frequency; DOM/SVG for everything interactive,
accessible or textual. **No thousands of DOM elements for visual effects.**

| Layer | Technique |
|---|---|
| Static geography | Rendered once into an offscreen canvas, invalidated only when the camera settles or the world changes |
| Roads | Two passes per class (dark casing, lit core), batched into one path per class, width clamped in pixels |
| Traffic | Bucketed into congestion bands — the whole field is three strokes, not 800 |
| Routes | Glow underlay + core + animated flow dashes travelling in the direction of travel |
| Heatmap | Accumulated into a ⅙-resolution offscreen buffer, recoloured through a perceptual ramp, upscaled with smoothing |
| Vehicles | Rotated chevrons — direction is legible at 8 px |
| Charts | Purpose-built canvas primitives: line, scatter with picker, stacked bar, gauge, sparkline |

**Level of detail.** Local streets and labels disappear when zoomed out, so the cost
of a frame is bounded by what is actually legible.

---

## Performance

- Single `requestAnimationFrame` loop with a delta-time clock.
- **Adaptive quality** — if the rolling FPS average drops below 34, the renderer
  drops device-pixel resolution rather than removing features the user asked for.
- Typed-array scratch buffers in the router, reused across queries; allocating per
  query would dominate the VRP inner loop.
- Binary heap A\*, not a sorted array.
- Path cache and route-evaluation cache, both revision-keyed to the traffic field.
- Debounced search (180 ms), throttled fleet list (2.5 Hz), `raf1`-coalesced renders.
- Cooperative optimiser yielding every 12 ms.
- Reduced-motion support throughout: flow dashes, pulses, camera easing and count-up
  animations all switch off.

---

## Accessibility

**The map is never the only way to understand the system.**

- **Order book panel** — a complete, sortable, keyboard-navigable text equivalent of
  every geospatial fact on the map, including coordinates.
- Two ARIA live regions (`polite` for status, `assertive` for alerts). Selections,
  layer toggles, view changes, optimisation results and errors are all announced.
- Full keyboard model: `O` optimise · `S` simulation · `R` fit routes · `F` fit fleet ·
  `0` reset · `+`/`−` zoom · `Space` play/pause · `/` search · `Esc` close · `?` help.
  Arrow-key panning is scoped to the map canvas so arrows work normally elsewhere.
- **Shortcuts never fire while typing**, and chords with Ctrl/Meta/Alt are left alone
  for the browser and assistive tech.
- Semantic tablist/tabpanel wiring, `aria-sort` on sortable headers, `aria-current`,
  `aria-pressed`, visible focus rings, a skip link.
- `prefers-contrast: more` strengthens every border and lifts text contrast.
- `prefers-reduced-motion: reduce` is honoured in CSS *and* in the render loop.

---

## Demo mode

The dataset is generated deterministically from `SEED` in `config.js`. Two loads
produce byte-identical geography, fleet and order book — a hard requirement for
reproducible optimisation results and for the demo narrative.

The **DEMO / SIMULATION** badge is permanent and non-dismissible.

## API architecture

Provider adapters can be added without touching the optimiser, because every engine
consumes a narrow interface:

| Engine | Interface it needs | Real provider would supply |
|---|---|---|
| `TrafficEngine` | `congestion[edgeId]`, `speedFactor[edgeId]` | HERE / TomTom / INRIX flow |
| `RouteEngine` | `world.adj`, `edgeMetrics()` | OSRM / Valhalla / GraphHopper |
| World | nodes, edges, geometry, class, grade | OpenStreetMap extract |
| `emissions.intensityAt()` | kg CO₂e per carrier unit at an hour | Electricity Maps / WattTime |
| Order book | the `order` shape above | TMS / OMS integration |

Swap the implementation, keep the contract, and the optimiser, the explanation layer
and the entire UI continue to work unchanged.

---

## Installation

```bash
git clone https://github.com/akshatinnovate-png/CarbonRouteX.git
cd CarbonRouteX
```

There is nothing to install. Node is needed only to run the test suite.

## Configuration

Everything tunable lives in **`src/config.js`**, deliberately in one auditable place:

| Block | Controls |
|---|---|
| `SEED` | The entire world, fleet and order book |
| `WORLD` | Region dimensions, geographic anchor |
| `ROAD_CLASS` | Speed, width, toll rate, capacity per road tier |
| `VEHICLE_TYPES` | Capacity, consumption, load sensitivity, range, costs |
| `ENERGY` | Carrier CO₂e factors, prices, hourly grid intensity, optimal speed |
| `PRESETS` | The four objective presets |
| `OPTIMIZER` | Iterations, time slice, temperatures, penalties, frontier samples |
| `TRAFFIC` | Congestion bands and the diurnal demand curve |
| `SIM` | Operating window, clock speeds |
| `RENDER` | DPR cap, zoom limits, flow speed |
| `LAYERS` | Map layer stack and defaults |

## Running locally

ES modules require an HTTP origin — opening the file directly will not work.

```bash
python3 -m http.server 8000
# or:  npx serve .
```

Then open <http://localhost:8000>.

## Deployment

Any static host. There is no server component, no API key and no build step.

```bash
# GitHub Pages
git subtree push --prefix . origin gh-pages

# Netlify / Vercel / Cloudflare Pages
# build command: (none)     publish directory: .
```

## Testing

```bash
node tests/engines.test.mjs
```

54 tests, no dependencies, running the real engines against the real generated world.

**Functional** — order creation, vehicle assignment, route generation, optimisation,
simulation, traffic events, vehicle failure, deadline changes, route selection,
layer toggling, search, alerts.

**Optimisation** — capacity respected · range respected · deadlines detected ·
objective weights change the result · infeasible solutions handled · re-planning
works · no order served twice or silently lost · empty fleet · empty order book.

**Correctness highlights:**

- **A\* optimality** is verified against an exhaustive Dijkstra on the same cost
  function, for randomly sampled node pairs.
- **Graph connectivity** is asserted — every node reachable from every other.
- **`nearestNode`** is checked against brute force for exact equality.
- **The explanation layer** is tested for honesty: every driver must cite a number,
  an identical plan must claim no change, a strictly worse plan must be *described*
  as worse rather than spun, and `planDiff` reassignments are verified against both
  plans.
- **Carbon attribution** must sum to the reported total.

The UI is verified in Chromium across desktop, tablet and mobile viewports, with
`prefers-reduced-motion`, checking for zero page errors and no horizontal overflow.

---

## Limitations

Stated plainly, because a system that hides its limits cannot be trusted with real
freight:

- **The world is synthetic.** The road network is generated, not imported from OSM.
  Distances and travel times are internally consistent but are not real-world routes.
- **Traffic is modelled, not observed.** A BPR-style volume/delay curve over a
  seeded demand field. It is deterministic and plausible; it is not a live feed.
- **Emissions are estimates**, not measurements — published factors applied to
  simulated telemetry. Real fleets need on-board telematics.
- **The VRP solve is heuristic.** Simulated annealing gives good solutions, not
  provably optimal ones. The *path* search is optimal; the *assignment* is not.
- **Single-depot-return routes.** No multi-trip, no trailer swaps, no driver hours
  regulations, no cross-docking, no pickup-and-delivery pairing.
- **Time windows are single and soft.** No multi-window customers.
- **Vehicle charging is not scheduled** — range is a constraint, not a mid-route
  activity with its own routing decision.
- **Single-run frontier.** Each Pareto candidate gets a shortened anneal, so the
  frontier is indicative rather than converged.

## Future roadmap

- OSM ingestion and a real map-matching layer
- Live traffic and grid-intensity adapters behind the existing interfaces
- Driver hours-of-service and multi-trip constraints
- Charging as a routable activity with a charger network
- Pickup-and-delivery pairing and backhaul
- Stochastic optimisation over travel-time distributions rather than point estimates
- A Web Worker for the optimiser, freeing the main thread entirely
- Plan export (CSV / GeoJSON) and a shareable plan permalink

---

## Responsible AI

This product makes claims about time, money and carbon. The rules it holds itself to:

1. **No fabricated reasoning.** Every sentence in the explanation layer is derived
   from a computed difference between two evaluated objects. If a claim cannot be
   traced to a number the engines produced, it is not made. Drivers below a 1.5%
   relative change are suppressed rather than dressed up.
2. **No flattering comparisons.** Both sides of every before/after are evaluated
   under identical conditions. Under disruption the honest verdict is often "this is
   worse on everything, and it is the best available" — and that is what it says.
3. **Estimates are labelled as estimates.** "Estimated CO₂e", never "CO₂e measured".
4. **Simulated data is labelled as simulated**, permanently and non-dismissibly.
5. **Uncertainty is not hidden.** Infeasible plans, unserved orders and constraint
   violations are surfaced as alerts, not quietly dropped.
6. **The model is auditable.** Every constant lives in one file; the objective
   function is documented above and in the source; the optimiser's convergence trace,
   iteration count, evaluation count and cache hit rate are all on screen.

## Data & privacy

- **Nothing leaves the browser.** No network requests, no analytics, no telemetry,
  no third-party scripts, no fonts fetched from a CDN.
- **`localStorage` holds UI preferences only** — objective weights, the chosen
  preset, and layer visibility. Operational data is deliberately *not* persisted, so
  a stale cached fleet can never be mistaken for live state.
- Every storage access is wrapped in `try/catch`; the app is fully functional with
  site data blocked, and says so once.

## Technical decisions

**Why no framework?** The hot path is a 60 fps canvas renderer next to an optimiser
doing tens of thousands of graph searches. A virtual DOM buys nothing there and
costs a build step, a dependency tree and a supply chain. The ~150-line `el()`/
`mount()` helper in `util/dom.js` covers what is actually needed.

**Why canvas over WebGL?** At this scale — ~800 road links, 10 vehicles, 26 delivery
nodes, a handful of route polylines — batched Canvas 2D holds 60 fps comfortably
while staying far easier to read, debug and extend. WebGL becomes the right answer
at tens of thousands of features, and the layer boundary in `mapEngine.js` is where
that swap would go.

**Why generalised minutes in the router?** Multi-objective shortest path is
NP-hard in general. Scalarising into one unit keeps the search a standard A\*, so it
runs at the speed the VRP loop demands — and because the weights come from the same
UI as the plan objective, the router and the assignment are always optimising the
same thing.

**Why regret-2 insertion before annealing?** A random start wastes most of the
annealing budget climbing out of nonsense. Regret insertion lands a feasible,
sensible plan in a fraction of a second, so the entire budget goes into improving it.

**Why is the baseline deliberately naive?** Nearest depot, booking order, no
sequencing, no carbon awareness — because that is what dispatch actually does without
a system like this. Benchmarking against an already-good plan would understate the
gap and mislead the operator.

**Why does the optimiser yield to the browser?** See above: an optimiser that
freezes the command centre is useless in an operations room.

**Why is the demo dataset deterministic?** Because "the optimiser saved 21%" is not
a claim you can make about a randomly generated instance that nobody can reproduce.

---

*CarbonRoute X — optimise the network, not just the route.*
