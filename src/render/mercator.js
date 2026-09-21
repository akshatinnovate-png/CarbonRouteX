/**
 * WEB MERCATOR PROJECTION (EPSG:3857)
 *
 * The coordinate system every slippy-map tile server uses. Converting here
 * rather than depending on a mapping library keeps the whole application
 * dependency-free while still consuming real OpenStreetMap tiles.
 *
 * "World pixels" are the projection at a reference zoom: the whole earth is
 * TILE_SIZE * 2^zoom pixels square. Working in world pixels at a fixed
 * reference zoom and scaling for display means pan/zoom is plain arithmetic.
 */

export const TILE_SIZE = 256;
export const MAX_LAT = 85.05112878; // the latitude where Mercator is cut off

export const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** lon/lat -> normalised 0..1 square. */
export function project(lon, lat) {
  const x = (lon + 180) / 360;
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

/** normalised 0..1 square -> lon/lat. */
export function unproject(x, y) {
  const lon = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

/** lon/lat -> world pixels at a given zoom. */
export function lonLatToWorld(lon, lat, zoom) {
  const p = project(lon, lat);
  const scale = TILE_SIZE * Math.pow(2, zoom);
  return { x: p.x * scale, y: p.y * scale };
}

/** world pixels at a given zoom -> lon/lat. */
export function worldToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  return unproject(x / scale, y / scale);
}

/** Metres per pixel at a latitude and zoom — used for the scale bar. */
export function metresPerPixel(lat, zoom) {
  return (156543.03392804097 * Math.cos((clampLat(lat) * Math.PI) / 180)) / Math.pow(2, zoom);
}

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometres. */
export function haversineKm(aLon, aLat, bLon, bLat) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing in radians, for orienting a vehicle marker. */
export function bearing(aLon, aLat, bLon, bLat) {
  const toRad = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * toRad) * Math.cos(bLat * toRad);
  const x = Math.cos(aLat * toRad) * Math.sin(bLat * toRad)
    - Math.sin(aLat * toRad) * Math.cos(bLat * toRad) * Math.cos((bLon - aLon) * toRad);
  return Math.atan2(y, x);
}

/** Bounding box of a set of {lon, lat} points, padded by a fraction. */
export function boundsOf(points, padFraction = 0.12) {
  if (!points.length) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const dLon = Math.max(maxLon - minLon, 0.004) * padFraction;
  const dLat = Math.max(maxLat - minLat, 0.004) * padFraction;
  return {
    minLon: minLon - dLon, maxLon: maxLon + dLon,
    minLat: minLat - dLat, maxLat: maxLat + dLat,
  };
}

/**
 * Decode an encoded polyline (Google/OSRM format) into {lon, lat} points.
 * OSRM returns precision 5 by default and 6 for the `polyline6` geometry type.
 */
export function decodePolyline(str, precision = 5) {
  const factor = Math.pow(10, precision);
  const coords = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1; shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ lon: lon / factor, lat: lat / factor });
  }
  return coords;
}

/** Total great-circle length of a {lon,lat} polyline, in km. */
export function polylineKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat);
  }
  return total;
}

/** Point at a given fraction of the way along a {lon,lat} polyline. */
export function pointAtFraction(points, t) {
  if (!points.length) return null;
  if (points.length === 1) return { ...points[0], heading: 0 };
  const target = Math.max(0, Math.min(1, t)) * polylineKm(points);
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = haversineKm(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat);
    if (acc + seg >= target || i === points.length - 1) {
      const f = seg === 0 ? 0 : (target - acc) / seg;
      return {
        lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * f,
        lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * f,
        heading: bearing(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat),
      };
    }
    acc += seg;
  }
  const last = points[points.length - 1];
  return { ...last, heading: 0 };
}
