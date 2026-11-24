// src/places.js — place names (reverse geocoding + search) and routing.
// Uses free, key-less OpenStreetMap services:
//   * Nominatim (nominatim.openstreetmap.org) — names/addresses. Policy: max 1 request/second.
//   * FOSSGIS routing (routing.openstreetmap.de) — car / bike / foot routes.
const NOMINATIM = "https://nominatim.openstreetmap.org";
const lang = () => (typeof navigator !== "undefined" && navigator.language) || "en";

// ---- 1 request / second queue (Nominatim usage policy) --------------------
let chain = Promise.resolve();
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function throttled(fn, gapMs = 1100) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCall + gapMs - Date.now());
    if (wait) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

/** ~110 m grid cell; every point in a cell shares one place lookup. */
export const cellKey = (lat, lng) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

function buildPlace(d) {
  const a = d.address || {};
  const name = d.name || a.amenity || a.leisure || a.shop || a.tourism || a.building || a.office || "";
  const road = a.road || a.pedestrian || a.footway || "";
  const area = a.neighbourhood || a.suburb || a.quarter || a.village || a.hamlet || "";
  const city = a.city || a.town || a.municipality || a.county || "";
  const region = a.state || a.region || "";
  const country = a.country || "";
  const parts = [name || road, area, city].filter(Boolean);
  const label = parts.filter((p, i) => p !== parts[i - 1]).join(", ")
    || (d.display_name ? d.display_name.split(",").slice(0, 3).join(",").trim() : "");
  return { name, road, area, city, region, country, label, address: d.display_name || label };
}

/** Name + address for a coordinate, or null when OSM knows nothing there. */
export function reverseGeocode(lat, lng) {
  return throttled(async () => {
    const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=${encodeURIComponent(lang())}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Nominatim ${r.status}`);
    const d = await r.json();
    if (d.error) return null;
    return { key: cellKey(lat, lng), ...buildPlace(d) };
  });
}

/** Free-text place search (call on submit, never as-you-type). */
export function searchPlaces(query) {
  return throttled(async () => {
    const url = `${NOMINATIM}/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=6&addressdetails=1&accept-language=${encodeURIComponent(lang())}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Search failed (${r.status})`);
    const list = await r.json();
    return list.map((d) => {
      const p = buildPlace(d);
      return { label: p.label || d.display_name, address: d.display_name, lat: +d.lat, lng: +d.lon };
    });
  });
}

const PROFILES = { driving: "routed-car", cycling: "routed-bike", walking: "routed-foot" };
export const MODES = { driving: "Driving", cycling: "Cycling", walking: "Walking" };

/** Route geometry + distance/duration between two {lat,lng} points. */
export async function fetchRoute(from, to, mode = "driving") {
  const prof = PROFILES[mode] ?? PROFILES.driving;
  const url = `https://routing.openstreetmap.de/${prof}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Routing failed (${r.status})`);
  const d = await r.json();
  if (d.code !== "Ok" || !d.routes?.length) throw new Error("No route found between these places.");
  const route = d.routes[0];
  return {
    coords: route.geometry.coordinates.map(([x, y]) => [y, x]),
    distanceM: route.distance,
    durationS: route.duration,
  };
}
