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
/* Energy & emissions factors                                          */
/* ------------------------------------------------------------------ */

export const ENERGY = {
  // Well-to-wheel CO2e intensity per unit of energy carrier.
  co2ePerUnit: {
    diesel: 3.17,  // kg CO2e per litre (combustion + upstream)
    cng: 2.98,     // kg CO2e per kg
    bev: 0.71,     // kg CO2e per kWh — grid intensity, see gridIntensity below
  },
  // Price per unit of energy carrier.
  pricePerUnit: { diesel: 94.5, cng: 78.0, bev: 9.8 },
  unitLabel: { diesel: 'L', cng: 'kg', bev: 'kWh' },
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
  { key: 'time', label: 'Time', unit: 'min', accent: '#5ec8ff' },
  { key: 'cost', label: 'Cost', unit: APP.currency, accent: '#ffc861' },
  { key: 'emissions', label: 'Emissions', unit: 'kg', accent: '#3ee08f' },
  { key: 'distance', label: 'Distance', unit: 'km', accent: '#b78bff' },
  { key: 'reliability', label: 'Reliability', unit: '%', accent: '#ff7a93' },
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
    { key: 'clear',  label: 'Clear',    mult: 0.86, color: '#3ee08f' },
    { key: 'normal', label: 'Normal',   mult: 1.00, color: '#7fd4a8' },
    { key: 'busy',   label: 'Busy',     mult: 1.22, color: '#ffc861' },
    { key: 'heavy',  label: 'Heavy',    mult: 1.58, color: '#ff9a4d' },
    { key: 'severe', label: 'Severe',   mult: 2.15, color: '#ff5f6d' },
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
  critical: { key: 'critical', label: 'Critical', weight: 3.2, color: '#ff5f6d' },
  high:     { key: 'high',     label: 'High',     weight: 2.0, color: '#ff9a4d' },
  standard: { key: 'standard', label: 'Standard', weight: 1.0, color: '#5ec8ff' },
  economy:  { key: 'economy',  label: 'Economy',  weight: 0.6, color: '#8a94a6' },
};
