/**
 * CarbonRoute — Global configuration.
 *
 * Every physical constant used by the energy, emissions and cost engines lives
 * here so the model is auditable in one place. Geography, roads and travel
 * times are NOT configured here: those come from real OpenStreetMap data via
 * the routing service (see src/services/).
 */

export const APP = {
  name: 'CarbonRoute',
  tagline: 'AI Logistics Intelligence',
  version: '2.0.0',
  currency: '₹', // INR
  /** Where the map opens before the operator has chosen an operating region. */
  defaultRegion: { label: 'Hyderabad, India', lon: 78.4867, lat: 17.385, zoom: 11 },
};

/* ------------------------------------------------------------------ */
/* Fleet                                                               */
/* ------------------------------------------------------------------ */

/**
 * Vehicle archetypes.
 *  - capacityKg      : payload limit
 *  - energyType      : diesel | cng | bev
 *  - kwhPer100 / lPer100 : baseline consumption at reference speed, empty
 *  - loadSensitivity : extra fraction of consumption at 100% payload
 *  - rangeKm         : usable range on a full tank/charge
 *  - costPerKm       : maintenance + tyres + depreciation (excl. energy)
 *  - driverCostPerHr : crew cost
 */
export const VEHICLE_TYPES = {
  ev_van: {
    key: 'ev_van', label: 'e-Van', energyType: 'bev', capacityKg: 900,
    consumption: 21.5, unit: 'kWh/100km', loadSensitivity: 0.30, rangeKm: 240,
    costPerKm: 4.1, driverCostPerHr: 210, maxSpeed: 95, icon: 'van',
  },
  ev_truck: {
    key: 'ev_truck', label: 'e-Truck', energyType: 'bev', capacityKg: 4200,
    consumption: 78, unit: 'kWh/100km', loadSensitivity: 0.38, rangeKm: 210,
    costPerKm: 9.4, driverCostPerHr: 280, maxSpeed: 85, icon: 'truck',
  },
  diesel_truck: {
    key: 'diesel_truck', label: 'Diesel Truck', energyType: 'diesel', capacityKg: 7500,
    consumption: 28.5, unit: 'L/100km', loadSensitivity: 0.42, rangeKm: 620,
    costPerKm: 7.2, driverCostPerHr: 280, maxSpeed: 90, icon: 'truck',
  },
  diesel_van: {
    key: 'diesel_van', label: 'Diesel Van', energyType: 'diesel', capacityKg: 1400,
    consumption: 11.2, unit: 'L/100km', loadSensitivity: 0.33, rangeKm: 540,
    costPerKm: 4.6, driverCostPerHr: 210, maxSpeed: 100, icon: 'van',
  },
  cng_truck: {
    key: 'cng_truck', label: 'CNG Truck', energyType: 'cng', capacityKg: 5200,
    consumption: 32.0, unit: 'kg/100km', loadSensitivity: 0.40, rangeKm: 380,
    costPerKm: 6.4, driverCostPerHr: 280, maxSpeed: 85, icon: 'truck',
  },
};

/* ------------------------------------------------------------------ */
/* Personal mobility                                                   */
/* ------------------------------------------------------------------ */

/**
 * Personal vehicle archetypes for PERSONAL mode.
 *
 * These are ordinary road vehicles, not fleet assets: no payload, no depot, no
 * duty cycle. Consumption figures are per 100 km at a typical urban-mixed
 * speed, and the emissions maths is the same well-to-wheel model the fleet
 * uses — an electric car's CO2e still depends on the grid at the hour you
 * drive, because that is true.
 */
export const PERSONAL_VEHICLES = {
  CAR: {
    key: 'CAR', label: 'Car', icon: 'car', energyType: 'petrol',
    consumption: 7.4, unit: 'L/100km', avgSpeedFactor: 1.0, occupancy: 1.6,
    costPerKm: 1.9, note: 'Petrol hatchback or sedan',
  },
  EV: {
    key: 'EV', label: 'Electric car', icon: 'ev', energyType: 'bev',
    consumption: 16.5, unit: 'kWh/100km', avgSpeedFactor: 1.0, occupancy: 1.6,
    costPerKm: 1.1, note: 'Battery electric — grid intensity applies',
  },
  MOTORCYCLE: {
    key: 'MOTORCYCLE', label: 'Motorcycle', icon: 'moto', energyType: 'petrol',
    consumption: 3.1, unit: 'L/100km', avgSpeedFactor: 1.06, occupancy: 1.1,
    costPerKm: 0.7, note: 'Filters through traffic; slightly faster in town',
  },
  BIKE: {
    key: 'BIKE', label: 'Bicycle', icon: 'bike', energyType: 'human',
    consumption: 0, unit: '—', avgSpeedFactor: 0.32, occupancy: 1,
    costPerKm: 0, note: 'Zero tailpipe emissions; speed modelled on the road network',
  },
  OTHER: {
    key: 'OTHER', label: 'Other', icon: 'grid', energyType: 'petrol',
    consumption: 6.0, unit: 'L/100km', avgSpeedFactor: 1.0, occupancy: 1.5,
    costPerKm: 1.6, note: 'Generic road vehicle — adjust consumption to match yours',
  },
};

/**
 * The four route choices offered in PERSONAL mode.
 *
 * Three of these are superlatives about one number, so they are decided by
 * that number alone: an option labelled "Lowest emissions" that returned
 * anything other than the lowest-emission road would be lying in its own
 * title. Only BALANCED is a weighted trade-off, and it is the only one whose
 * label admits to being one.
 */
export const PERSONAL_OPTIONS = [
  { key: 'FASTEST', label: 'Fastest', blurb: 'Least time on the road',
    metric: 'minutes' },
  { key: 'CHEAPEST', label: 'Lowest cost', blurb: 'Least money spent getting there',
    metric: 'cost' },
  { key: 'GREENEST', label: 'Lowest emissions', blurb: 'Least CO\u2082e released',
    metric: 'co2' },
  { key: 'BALANCED', label: 'Balanced', blurb: 'A weighted trade-off across all four',
    weights: { time: 0.32, cost: 0.24, emissions: 0.28, distance: 0.16 } },
];

/* ------------------------------------------------------------------ */
/* Energy & emissions factors                                          */
/* ------------------------------------------------------------------ */

export const ENERGY = {
  // Well-to-wheel CO2e intensity per unit of energy carrier.
  co2ePerUnit: {
    diesel: 3.17,  // kg CO2e per litre (combustion + upstream)
    petrol: 2.86,  // kg CO2e per litre (combustion + upstream)
    human: 0,      // a bicycle has no tailpipe and no fuel chain to account for
    cng: 2.98,     // kg CO2e per kg
    bev: 0.71,     // kg CO2e per kWh — grid intensity, see gridIntensity below
  },
  // Price per unit of energy carrier.
  pricePerUnit: { diesel: 94.5, cng: 78.0, bev: 9.8, petrol: 106.0, human: 0 },
  unitLabel: { diesel: 'L', cng: 'kg', bev: 'kWh', petrol: 'L', human: '' },
  /**
   * Grid carbon intensity by hour-of-day (kg CO2e / kWh). Solar-heavy midday.
   * Used only for BEV vehicles — this is what makes "when you drive" matter.
   */
  gridIntensity: [
    0.78, 0.78, 0.77, 0.77, 0.76, 0.74, 0.68, 0.60, 0.52, 0.45, 0.40, 0.37,
    0.36, 0.37, 0.41, 0.48, 0.58, 0.70, 0.82, 0.86, 0.85, 0.83, 0.81, 0.79,
  ],
  /**
   * Speed-consumption curve. Real vehicles are most efficient near 60 km/h;
   * stop-and-go and high-speed drag both cost more. Returns a multiplier.
   */
  optimalSpeed: 62,
  idlePenaltyPerStop: 0.018, // fraction of an hour of idling per stop
};

/* ------------------------------------------------------------------ */
/* Optimisation                                                        */
/* ------------------------------------------------------------------ */

export const OBJECTIVES = [
  { key: 'time', label: 'Time', unit: 'min', accent: '#0d8f8f' },
  { key: 'cost', label: 'Cost', unit: APP.currency, accent: '#b08423' },
  { key: 'emissions', label: 'Emissions', unit: 'kg', accent: '#0f8a6a' },
  { key: 'distance', label: 'Distance', unit: 'km', accent: '#04434b' },
  { key: 'reliability', label: 'Reliability', unit: '%', accent: '#c2742a' },
];

export const PRESETS = {
  fastest:      { time: 0.62, cost: 0.10, emissions: 0.06, distance: 0.10, reliability: 0.12 },
  cheapest:     { time: 0.10, cost: 0.60, emissions: 0.08, distance: 0.14, reliability: 0.08 },
  greenest:     { time: 0.08, cost: 0.10, emissions: 0.62, distance: 0.12, reliability: 0.08 },
  balanced:     { time: 0.22, cost: 0.22, emissions: 0.24, distance: 0.14, reliability: 0.18 },
};

export const OPTIMIZER = {
  // Simulated-annealing local search budget.
  maxIterations: 9000,
  timeSliceMs: 12,          // work per animation frame — keeps UI at 60fps
  startTemp: 1.0,
  endTemp: 0.0035,
  restarts: 2,
  serviceMinutesPerStop: 6,
  serviceMinutesPerKg: 0.0016,   // extra dock-loading minutes per kg
  depotLoadMinutes: 12,
  lateMinutePenalty: 4.2,   // objective units per minute late (soft constraint)
  unservedPenalty: 900,     // objective units for dropping an order
  paretoSamples: 22,        // weight vectors sampled for the frontier
};

export const TRAFFIC = {
  levels: [
    { key: 'clear',  label: 'Clear',    mult: 0.86, color: '#14b8a6' },
    { key: 'normal', label: 'Normal',   mult: 1.00, color: '#0d8f8f' },
    { key: 'busy',   label: 'Busy',     mult: 1.22, color: '#d4a843' },
    { key: 'heavy',  label: 'Heavy',    mult: 1.58, color: '#c2742a' },
    { key: 'severe', label: 'Severe',   mult: 2.15, color: '#b4342f' },
  ],
  // Time-of-day demand curve driving the base congestion (index = hour).
  diurnal: [
    0.20, 0.15, 0.12, 0.12, 0.16, 0.28, 0.48, 0.72, 0.92, 0.85, 0.66, 0.58,
    0.60, 0.62, 0.64, 0.70, 0.84, 0.97, 1.00, 0.88, 0.66, 0.48, 0.34, 0.26,
  ],
};

export const SIM = {
  dayStartMinutes: 8 * 60,     // 08:00 operational window open
  dayEndMinutes: 20 * 60,      // 20:00 close
  tickMs: 1000 / 30,
  defaultSpeedMultiplier: 60,  // 1 real second = 60 simulated seconds
  speeds: [0, 15, 60, 240, 900],
};

export const RENDER = {
  maxDpr: 2,
  flowSpeed: 0.055,
};

export const LAYERS = [
  { key: 'routes',     label: 'Planned routes',    on: true },
  { key: 'vehicles',   label: 'Vehicles',          on: true },
  { key: 'deliveries', label: 'Deliveries',        on: true },
  { key: 'depots',     label: 'Depots',            on: true },
  { key: 'labels',     label: 'Stop labels',       on: true },
  { key: 'emissions',  label: 'Emissions heatmap', on: false },
  { key: 'incidents',  label: 'Incidents',         on: true },
  { key: 'risk',       label: 'Risk / exceptions', on: false },
];

export const PRIORITY = {
  critical: { key: 'critical', label: 'Critical', weight: 3.2, color: '#b4342f' },
  high:     { key: 'high',     label: 'High',     weight: 2.0, color: '#c2742a' },
  standard: { key: 'standard', label: 'Standard', weight: 1.0, color: '#0d8f8f' },
  economy:  { key: 'economy',  label: 'Economy',  weight: 0.6, color: '#8aa1ab' },
};
