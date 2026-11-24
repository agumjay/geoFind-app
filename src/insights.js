// src/insights.js — statistics derived from every saved location, plus export helpers.
import * as turf from "@turf/turf";

const CELL_DEG = 0.003;      // ~330 m grid used to group "areas"
const MAX_GAP_S = 300;       // gaps longer than this aren't counted as time spent
const MAX_SANE_MPS = 120;    // ignore GPS spikes faster than ~430 km/h

export function computeInsights(points) {
  const pts = points.filter((p) => p.sourceHint !== "ip"); // IP guesses are not real movement
  if (!pts.length) return null;
  let maxSpeed = null, movingDist = 0, movingTime = 0, activeTime = 0;
  const cells = new Map();
  const first = pts[0];
  let farthest = { km: 0, point: first };
  let prevCell = null;
  const keyOf = (p) => `${Math.round(p.lat / CELL_DEG)}:${Math.round(p.lng / CELL_DEG)}`;

  pts.forEach((p, i) => {
    const key = keyOf(p);
    let c = cells.get(key);
    if (!c) { c = { key, n: 0, visits: 0, dwell: 0, lat: 0, lng: 0, last: 0, names: new Map() }; cells.set(key, c); }
    c.n++; c.lat += p.lat; c.lng += p.lng; c.last = p.timestamp;
    if (key !== prevCell) c.visits++;
    prevCell = key;
    if (p.place) c.names.set(p.place, (c.names.get(p.place) ?? 0) + 1);

    const d0 = turf.distance(turf.point([first.lng, first.lat]), turf.point([p.lng, p.lat]), { units: "kilometers" });
    if (d0 > farthest.km) farthest = { km: d0, point: p };

    if (i === 0) return;
    const q = pts[i - 1];
    const dt = (p.timestamp - q.timestamp) / 1000;
    if (dt <= 0 || dt > MAX_GAP_S) return;
    activeTime += dt;
    cells.get(keyOf(q)).dwell += dt;

    const dKm = turf.distance(turf.point([q.lng, q.lat]), turf.point([p.lng, p.lat]), { units: "kilometers" });
    let v = Number.isFinite(p.speed) ? p.speed : null;           // m/s reported by the device
    if (v == null && dt >= 1 && (p.accuracy ?? 99) <= 50 && (q.accuracy ?? 99) <= 50) v = (dKm * 1000) / dt;
    if (v != null && v <= MAX_SANE_MPS) {
      if (!maxSpeed || v > maxSpeed.mps) maxSpeed = { mps: v, point: p };
      if (v > 0.5) { movingTime += dt; movingDist += dKm; }
    }
  });

  const areas = [...cells.values()]
    .map((c) => ({
      ...c, lat: c.lat / c.n, lng: c.lng / c.n,
      name: [...c.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, // most common place name
    }))
    .sort((a, b) => b.visits - a.visits || b.dwell - a.dwell)
    .slice(0, 5);
  const days = new Set(pts.map((p) => new Date(p.timestamp).toDateString())).size;
  const placesCount = new Set(pts.map((p) => p.place).filter(Boolean)).size;

  return {
    maxSpeed,
    avgMovingKmh: movingTime > 0 ? movingDist / (movingTime / 3600) : null,
    activeTime, days, areas, farthest, placesCount,
    totalPoints: pts.length,
  };
}

export function fmtDuration(sec) {
  if (!sec || sec < 60) return `${Math.round(sec || 0)} s`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} m` : `${m} min`;
}

// ---- Export ----------------------------------------------------------------
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function exportCsv(points) {
  const head = ["timestamp_iso", "lat", "lng", "place", "address", "accuracy_m", "speed_mps", "source"];
  const rows = points.map((p) => [
    new Date(p.timestamp).toISOString(), p.lat, p.lng, csvCell(p.place), csvCell(p.address),
    Math.round(p.accuracy ?? 0), p.speed ?? "", p.sourceHint ?? "",
  ].join(","));
  download("geofind-locations.csv", [head.join(","), ...rows].join("\n"), "text/csv");
}

export function exportGeoJson(points) {
  const fc = {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        time: new Date(p.timestamp).toISOString(), place: p.place, address: p.address,
        accuracy: p.accuracy, speed: p.speed, source: p.sourceHint,
      },
    })),
  };
  download("geofind-locations.geojson", JSON.stringify(fc), "application/geo+json");
}
