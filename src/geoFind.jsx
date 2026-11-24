// src/geoFind.jsx  —  geoFind: real-time hybrid-positioning tracker
// Everything (hook, components, styles, icons fix) lives in this one file.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Circle,
  Popup,
  useMap,
} from "react-leaflet";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";
import * as turf from "@turf/turf";

// ---- Leaflet default-icon fix for bundlers (Vite) --------------------------
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

// ---- Constants -------------------------------------------------------------
const STORAGE_KEY = "geofind_points_v1";
const MAX_POINTS = 5000;
const DEFAULT_CENTER = [0.3476, 32.5825]; // Kampala
const MODE_KEY = "geofind_mode_v1";
const IP_ACCURACY_M = 5000; // IP geolocation is typically city-level
const IP_POLL_MS = 60000;
const GPS_RETRY_MS = 20000;

// Free, key-less IP geolocation services (HTTPS + CORS). Tried in order.
async function fetchIpLocation() {
  const providers = [
    async () => {
      const r = await fetch("https://ipwho.is/");
      const d = await r.json();
      if (!d.success) throw new Error("ipwho.is failed");
      return { lat: d.latitude, lng: d.longitude, ip: d.ip, place: [d.city, d.country].filter(Boolean).join(", ") };
    },
    async () => {
      const r = await fetch("https://ipapi.co/json/");
      const d = await r.json();
      if (d.error || d.latitude == null) throw new Error("ipapi.co failed");
      return { lat: d.latitude, lng: d.longitude, ip: d.ip, place: [d.city, d.country_name].filter(Boolean).join(", ") };
    },
  ];
  let lastErr;
  for (const p of providers) {
    try {
      const loc = await p();
      if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return loc;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("IP lookup failed");
}

// ===========================================================================
// 1) Custom hook — hybrid-positioning tracker
//    Wraps navigator.geolocation.watchPosition. On modern phones the OS
//    fuses GPS + Wi-Fi + cell → "hybrid" fixes; we surface the accuracy and
//    a source hint so users understand which source likely dominated.
// ===========================================================================
function useHybridTracking() {
  const [tracking, setTracking] = useState(false);
  const [points, setPoints] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [error, setError] = useState(null);
  const [distanceKm, setDistanceKm] = useState(0);

  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(MODE_KEY) === "ip" ? "ip" : "gps"; } catch { return "gps"; }
  });

  const watchIdRef = useRef(null);
  const ipTimerRef = useRef(null);
  const gpsRetryRef = useRef(null);
  const startRef = useRef(null);
  const wakeLockRef = useRef(null);

  // Keep the screen awake while tracking (browsers pause GPS when the screen locks).
  useEffect(() => {
    if (!tracking || !("wakeLock" in navigator)) return;
    let cancelled = false;
    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) { lock.release(); return; }
        wakeLockRef.current = lock;
      } catch { /* not permitted — ignore */ }
    };
    acquire();
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [tracking]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(points)); } catch {}
  }, [points]);

  useEffect(() => {
    if (points.length < 2) { setDistanceKm(0); return; }
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = turf.point([points[i - 1].lng, points[i - 1].lat]);
      const b = turf.point([points[i].lng, points[i].lat]);
      total += turf.distance(a, b, { units: "kilometers" });
    }
    setDistanceKm(total);
  }, [points]);

  const addPoint = useCallback((newPt) => {
    setPoints((prev) => {
      const last = prev[prev.length - 1];
      // IP lookups often return the same spot: refresh the timestamp instead of piling up points.
      if (newPt.sourceHint === "ip" && last && last.sourceHint === "ip" &&
          last.lat === newPt.lat && last.lng === newPt.lng) {
        return [...prev.slice(0, -1), { ...last, timestamp: newPt.timestamp }];
      }
      // A real GPS/network fix supersedes trailing IP guesses (avoids a bogus long jump in the trail/distance).
      let base = prev;
      if (newPt.sourceHint !== "ip") {
        let n = base.length;
        while (n > 0 && base[n - 1].sourceHint === "ip") n--;
        base = base.slice(0, n);
      }
      const next = [...base, newPt];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });
  }, []);

  const stop = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (ipTimerRef.current != null) {
      clearInterval(ipTimerRef.current);
      ipTimerRef.current = null;
    }
    if (gpsRetryRef.current != null) {
      clearInterval(gpsRetryRef.current);
      gpsRetryRef.current = null;
    }
    setTracking(false);
  }, []);

  // ---- IP-address tracking (city-level, works without GPS permission) ------
  const startIp = useCallback((notice, retryGps = false) => {
    if (ipTimerRef.current != null) return;
    // When IP is only a fallback, keep probing GPS and upgrade as soon as it works.
    if (retryGps && "geolocation" in navigator) {
      gpsRetryRef.current = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
          () => { stop(); startRef.current?.(); },
          () => {},
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      }, GPS_RETRY_MS);
    }
    setError(notice ?? null);
    setTracking(true);
    const poll = async () => {
      try {
        const loc = await fetchIpLocation();
        addPoint({
          id: crypto.randomUUID?.() ?? String(Date.now()),
          lat: loc.lat,
          lng: loc.lng,
          accuracy: IP_ACCURACY_M,
          speed: null,
          timestamp: Date.now(),
          sourceHint: "ip",
          place: loc.place,
          ip: loc.ip,
        });
        setError((e) => (e && e.startsWith("Couldn't look up") ? null : e));
      } catch {
        setError("Couldn't look up your location from your IP address. Check your connection or disable ad-blockers for this site.");
      }
    };
    poll();
    ipTimerRef.current = setInterval(poll, IP_POLL_MS);
  }, [addPoint, stop]);

  const changeMode = useCallback((m) => {
    stop();
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  }, [stop]);

  const start = useCallback(() => {
    if (watchIdRef.current != null || ipTimerRef.current != null) return; // already running
    if (mode === "ip") { startIp(); return; }
    if (!("geolocation" in navigator)) {
      startIp("GPS isn't supported here — using your IP address (approximate).");
      return;
    }
    if (!window.isSecureContext) {
      startIp("GPS needs HTTPS — using your IP address instead (approximate).");
      return;
    }    setError(null);
    setTracking(true);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const speed = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null;
        const newPt = {
          id: (crypto.randomUUID?.() ?? String(Date.now())),
          lat: latitude,
          lng: longitude,
          accuracy,
          speed,
          timestamp: pos.timestamp,
          sourceHint:
            accuracy <= 20 ? "gps" : accuracy <= 50 ? "hybrid" : "network",
        };
        addPoint(newPt);
      },
      (err) => {
        if (err.code === 1 || err.code === 2) {
          // Permission denied / no GPS: fall back to IP-based location.
          stop();
          startIp(
            err.code === 1
              ? "Location permission denied — showing an approximate IP location (often the wrong city). Allow location for this site and it will switch to GPS automatically."
              : "Device location unavailable — showing an approximate IP location (often the wrong city). Turn on Location in your device settings; it will switch to GPS automatically.",
            true
          );
          return;
        }
        setError(err.code === 3 ? "Timed out getting location. Retrying…" : err.message || "Geolocation error");
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }, [stop, startIp, addPoint, mode]);
  useEffect(() => { startRef.current = start; }, [start]);

  const clear = useCallback(() => {
    stop();
    setPoints([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  const latest = points.length ? points[points.length - 1] : null;
  return { tracking, start, stop, clear, points, latest, distanceKm, error, mode, changeMode };
}

// ---- PWA install hook ------------------------------------------------------
function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true
  );

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => { setInstalled(true); setDeferred(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
      return null;
    }
    // Browsers without beforeinstallprompt (iOS Safari, Firefox, etc.)
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return ios
      ? "On iPhone/iPad: tap the Share button, then “Add to Home Screen”."
      : "Use your browser menu (⋮) and choose “Install app” / “Add to Home screen”.";
  }, [deferred]);

  return { installed, canPrompt: !!deferred, install };
}

// ---- Theme (light / dark) --------------------------------------------------
const THEME_KEY = "geofind_theme_v1";
function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* ignore */ }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b1220" : "#2563eb");
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}

function Navbar({ installed, onInstall, tracking, theme, onToggleTheme }) {
  return (
    <nav className="gf-nav">
      <div className="gf-nav-brand">
        <img src="/icons/icon-192.png" alt="" width="28" height="28" />
        <span>geoFind</span>
      </div>
      <div className="gf-nav-right">
        <span className={`gf-live ${tracking ? "on" : ""}`}>{tracking ? "Live" : "Idle"}</span>
        <button className="gf-theme" onClick={onToggleTheme}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                title={theme === "dark" ? "Light mode" : "Dark mode"}>
          {theme === "dark" ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
          )}
        </button>
      {!installed && (
        <button className="gf-install" onClick={onInstall}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          <span className="gf-install-label">Download app</span>
        </button>
      )}
      </div>
    </nav>
  );
}

// ===========================================================================
// 2) Map sub-components
// ===========================================================================
function FlyToLatest({ latest, follow, recenterKey }) {
  const map = useMap();
  useEffect(() => {
    if (latest && follow) {
      // IP fixes are city-level: don't sit zoomed in on a street.
      const zoom = latest.sourceHint === "ip" ? Math.min(map.getZoom(), 12) : map.getZoom();
      map.setView([latest.lat, latest.lng], zoom, { animate: true });
    }
  }, [latest, follow, map]);
  useEffect(() => {
    if (latest && recenterKey) map.flyTo([latest.lat, latest.lng], Math.max(map.getZoom(), 16));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterKey]);
  return null;
}

// ---- Map styles ------------------------------------------------------------
const MAP_STYLES = {
  street: {
    label: "Street", swatch: "#a7d3a0",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
  },
  satellite: {
    label: "Satellite", swatch: "#2f4a3a",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri", maxZoom: 19,
  },
  terrain: {
    label: "Terrain", swatch: "#c9b88a",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenTopoMap, OpenStreetMap contributors", maxZoom: 17,
  },
  light: {
    label: "Light", swatch: "#e5e7eb",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri", maxZoom: 16,
  },
  dark: {
    label: "Dark", swatch: "#1f2937",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri", maxZoom: 16,
  },
};
const STYLE_KEY = "geofind_map_style_v1";

function MapControls({ styleId, setStyleId, follow, setFollow, onRecenter, canRecenter }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gf-mapctl">
      <div className="gf-ctl-stack">
        <button className={`gf-ctl ${open ? "active" : ""}`} onClick={() => setOpen((v) => !v)}
                aria-label="Map style" aria-expanded={open} title="Map style">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3 2 8l10 5 10-5-10-5z" /><path d="m2 13 10 5 10-5" /><path d="m2 17.5 10 5 10-5" />
          </svg>
        </button>
        <button className="gf-ctl" onClick={onRecenter} disabled={!canRecenter} aria-label="Center on my location" title="Center on me">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" />
          </svg>
        </button>
        <button className={`gf-ctl ${follow ? "active" : ""}`} onClick={() => setFollow((v) => !v)}
                aria-pressed={follow} aria-label="Follow my location" title={follow ? "Following: on" : "Following: off"}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m3 11 19-9-9 19-2-8-8-2z" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="gf-styles" role="menu">
          {Object.entries(MAP_STYLES).map(([id, st]) => (
            <button key={id} role="menuitemradio" aria-checked={styleId === id}
                    className={`gf-style ${styleId === id ? "sel" : ""}`}
                    onClick={() => { setStyleId(id); setOpen(false); }}>
              <i style={{ background: st.swatch }} />
              {st.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HeatLayer({ points, show }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    // 1. If toggled off, or no points exist, don't even try to render
    if (!show || points.length === 0) {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      return;
    }

    // 2. Wait for the map to be ready before adding the layer
    const timer = setTimeout(() => {
      try {
        const data = points.map((p) => [p.lat, p.lng, 0.6]);
        
        // Remove old layer if it exists
        if (layerRef.current) {
          map.removeLayer(layerRef.current);
        }

        // Create and add new layer
        layerRef.current = L.heatLayer(data, { radius: 25, blur: 15, maxZoom: 17 });
        layerRef.current.addTo(map);
      } catch (err) {
        console.error("Heatmap failed to load:", err);
      }
    }, 100); // slight delay ensures Leaflet is ready

    return () => {
      clearTimeout(timer);
      if (layerRef.current && map) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [points, show, map]);

  return null;
}

function MapView({ points, latest, geofence, insideGeofence, playbackPoint, showHeatmap, styleId, follow, recenterKey }) {
  const trail = points.map((p) => [p.lat, p.lng]);
  const center = latest ? [latest.lat, latest.lng] : DEFAULT_CENTER;
  const st = MAP_STYLES[styleId] ?? MAP_STYLES.street;

  return (
    <MapContainer center={center} zoom={16} maxZoom={20} style={{ height: "100%", width: "100%" }}>
      <TileLayer
        key={styleId}
        attribution={st.attribution}
        url={st.url}
        maxZoom={20}
        maxNativeZoom={st.maxZoom}
      />
      <FlyToLatest latest={latest} follow={follow} recenterKey={recenterKey} />

      {trail.length > 1 && (
        <Polyline positions={trail} pathOptions={{ color: "#2563eb", weight: 4 }} />
      )}

      {latest && (
        <Marker position={[latest.lat, latest.lng]}>
          <Popup>
            <strong>You are here</strong><br />
            Accuracy: ±{Math.round(latest.accuracy)} m<br />
            Source: {latest.sourceHint}<br />
            {latest.place && <>Near: {latest.place}<br /></>}
            Time: {new Date(latest.timestamp).toLocaleTimeString()}
          </Popup>
        </Marker>
      )}

      {latest?.sourceHint === "ip" && (
        <Circle
          center={[latest.lat, latest.lng]}
          radius={latest.accuracy}
          pathOptions={{ color: "#8b5cf6", fillColor: "#8b5cf6", fillOpacity: 0.1, weight: 1, dashArray: "6 6" }}
        />
      )}

      {playbackPoint && (
        <Circle
          center={[playbackPoint.lat, playbackPoint.lng]}
          radius={6}
          pathOptions={{ color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.9 }}
        />
      )}

      {geofence && (
        <Circle
          center={[geofence.lat, geofence.lng]}
          radius={geofence.radius}
          pathOptions={{
            color: insideGeofence ? "#16a34a" : "#dc2626",
            fillColor: insideGeofence ? "#16a34a" : "#dc2626",
            fillOpacity: 0.15,
          }}
        />
      )}

      <HeatLayer points={points} show={showHeatmap} />
    </MapContainer>
  );
}

// ===========================================================================
// 3) Panels
// ===========================================================================
function ControlBar({
  mode, onModeChange,
  tracking, onStart, onStop, onClear,
  geofenceOn, onToggleGeofence,
  showHeatmap, onToggleHeatmap,
}) {
  return (
    <div className="gf-controlbar">
      <div className="gf-seg" role="radiogroup" aria-label="Tracking source">
        <button type="button" role="radio" aria-checked={mode === "gps"}
                className={mode === "gps" ? "sel" : ""} onClick={() => onModeChange("gps")}>
          📡 GPS / Device
        </button>
        <button type="button" role="radio" aria-checked={mode === "ip"}
                className={mode === "ip" ? "sel" : ""} onClick={() => onModeChange("ip")}>
          🌐 IP address
        </button>
      </div>
      <div className={`gf-badge ${tracking ? "on" : "off"}`}>
        {tracking ? "● Tracking ON" : "○ Tracking OFF"}
      </div>
      {!tracking ? (
        <button className="primary" onClick={onStart}>Start tracking</button>
      ) : (
        <button className="danger" onClick={onStop}>Stop</button>
      )}
      <button onClick={onClear}>Clear data</button>
      <label className="gf-toggle">
        <input type="checkbox" checked={geofenceOn} onChange={onToggleGeofence} /> Geofence
      </label>
      <label className="gf-toggle">
        <input type="checkbox" checked={showHeatmap} onChange={onToggleHeatmap} /> Heatmap
      </label>
    </div>
  );
}

function StatsPanel({ latest, distanceKm, points, error, geofenceStatus }) {
  const chartData = points.slice(-60).map((p, i) => ({
    i,
    speed: p.speed != null ? +(p.speed * 3.6).toFixed(1) : 0,
  }));

  return (
    <div className="gf-stats">
      {error && <div className="gf-error">⚠ {error}</div>}
      {latest ? (
        <>
          <div className="gf-tiles">
            <div className="gf-tile"><span>Latitude</span><b>{latest.lat.toFixed(5)}</b></div>
            <div className="gf-tile"><span>Longitude</span><b>{latest.lng.toFixed(5)}</b></div>
            <div className="gf-tile"><span>Accuracy</span><b>±{Math.round(latest.accuracy)} m</b><small>{latest.sourceHint}</small></div>
            <div className="gf-tile"><span>Speed</span><b>{latest.speed != null ? (latest.speed * 3.6).toFixed(1) : "—"}</b><small>km/h</small></div>
            <div className="gf-tile"><span>Distance</span><b>{distanceKm.toFixed(2)}</b><small>km</small></div>
            <div className="gf-tile"><span>Points</span><b>{points.length}</b><small>{new Date(latest.timestamp).toLocaleTimeString()}</small></div>
          </div>

          {geofenceStatus && (
            <div className={`gf-row gf-geofence ${geofenceStatus === "inside" ? "in" : "out"}`}>
              <span>Geofence</span>
              <b>{geofenceStatus === "inside" ? "INSIDE" : "OUTSIDE"}</b>
            </div>
          )}
          
          {latest.accuracy > 50 && (
            <div className="gf-warn">
              {latest.sourceHint === "ip"
                ? `⚠ Approximate location from your IP address${latest.place ? ` (near ${latest.place})` : ""} — typically city-level, can be several km off.`
                : "⚠ Coarse accuracy — hybrid fallback (Wi‑Fi/cell) likely in use."}
            </div>
          )}
          
          <div className="gf-spark">
            <ResponsiveContainer width="100%" height={70}>
              <LineChart data={chartData}>
                <XAxis dataKey="i" hide />
                <YAxis hide domain={[0, "auto"]} />
                <Tooltip />
                <Line type="monotone" dataKey="speed" stroke="#3b82f6" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
            <small style={{ color: "#6b7280" }}>Speed (km/h) — last 60 samples</small>
          </div>
        </>
      ) : (
        <div style={{ textAlign: "center", padding: "20px 0", color: "#6b7280" }}>
          <p style={{ fontSize: "24px", margin: "0 0 10px 0" }}>🛰️</p>
          <p>Ready to track. Press <b>Start tracking</b>.</p>
        </div>
      )}
    </div>
  );
}

function PlaybackControls({ points, index, setIndex, onReset }) {
  if (points.length < 2) return null;
  const p = points[index];
  return (
    <div className="gf-playback">
      <span>Playback</span>
      <input
        type="range" min={0} max={points.length - 1}
        value={index} onChange={(e) => setIndex(+e.target.value)}
      />
      <span>{new Date(p.timestamp).toLocaleTimeString()}</span>
      <button onClick={onReset}>Latest</button>
    </div>
  );
}

// ===========================================================================
// 4) Root component
// ===========================================================================
export default function GeoFind() {
  const { tracking, start, stop, clear, points, latest, distanceKm, error, mode, changeMode } = useHybridTracking();

  const [geofenceOn, setGeofenceOn] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [geofenceCenter, setGeofenceCenter] = useState(null);
  const [geofenceRadius, setGeofenceRadius] = useState(150);
  const [insideGeofence, setInsideGeofence] = useState(false);
  const [alert, setAlert] = useState(null);
  const [playbackIdx, setPlaybackIdx] = useState(0);
  const { installed, install } = useInstallPrompt();
  const { theme, toggle: toggleTheme } = useTheme();
  const [sheetOpen, setSheetOpen] = useState(true);
  const [styleId, setStyleId] = useState(() => {
    try {
      const v = localStorage.getItem(STYLE_KEY);
      return v && MAP_STYLES[v] ? v : "street";
    } catch { return "street"; }
  });
  const [follow, setFollow] = useState(true);
  const [recenterKey, setRecenterKey] = useState(0);
  useEffect(() => {
    try { localStorage.setItem(STYLE_KEY, styleId); } catch {}
  }, [styleId]);

  const handleInstall = async () => {
    const hint = await install();
    if (hint) {
      setAlert(hint);
      setTimeout(() => setAlert(null), 6000);
    }
  };

  useEffect(() => {
    setPlaybackIdx(Math.max(0, points.length - 1));
  }, [points.length]);

   useEffect(() => {
    if (geofenceOn && !geofenceCenter && latest) {
      setGeofenceCenter({ lat: latest.lat, lng: latest.lng }); // Removed the hardcoded radius from here
    }
  }, [geofenceOn, geofenceCenter, latest]);

  useEffect(() => {
    if (!geofenceOn || !geofenceCenter || !latest) return;
    const fence = turf.circle(
      [geofenceCenter.lng, geofenceCenter.lat],
      geofenceRadius, // <-- This is the fix: uses the slider state
      { units: "meters" }
    );
    const inside = turf.booleanPointInPolygon(turf.point([latest.lng, latest.lat]), fence);
    if (inside !== insideGeofence) {
      setInsideGeofence(inside);
      setAlert(inside ? "Entered geofence" : "Left geofence");
      setTimeout(() => setAlert(null), 3500);
    }
  }, [latest, geofenceOn, geofenceCenter, insideGeofence, geofenceRadius]); // <-- Added geofenceRadius here

  const playbackPoint = useMemo(() => {
    if (!points.length) return null;
    const p = points[Math.min(playbackIdx, points.length - 1)];
    return p ? { lat: p.lat, lng: p.lng } : null;
  }, [points, playbackIdx]);

  const geofenceStatus =
    geofenceOn && geofenceCenter ? (insideGeofence ? "inside" : "outside") : null;

  return (
    <>
      <style>{STYLES}</style>
      <Navbar installed={installed} onInstall={handleInstall} tracking={tracking} theme={theme} onToggleTheme={toggleTheme} />
      <div className="gf-shell">
        <div className="gf-map-wrap">
                   <MapView
            points={points}
            latest={latest}
            geofence={geofenceOn && geofenceCenter ? { ...geofenceCenter, radius: geofenceRadius } : null} 
            insideGeofence={insideGeofence}
            playbackPoint={playbackPoint}
            showHeatmap={showHeatmap}
            styleId={styleId}
            follow={follow}
            recenterKey={recenterKey}
          />
          <MapControls
            styleId={styleId}
            setStyleId={setStyleId}
            follow={follow}
            setFollow={setFollow}
            onRecenter={() => setRecenterKey((k) => k + 1)}
            canRecenter={!!latest}
          />
          {alert && (
            <div className={`gf-toast ${/^(Entered|Left)/.test(alert) ? (insideGeofence ? "ok" : "bad") : "info"}`}>{alert}</div>
          )}
        </div>

        <aside className={`gf-side ${sheetOpen ? "open" : "closed"}`}>
          <button className="gf-handle" onClick={() => setSheetOpen((v) => !v)}
                  aria-label={sheetOpen ? "Collapse panel" : "Expand panel"} aria-expanded={sheetOpen}>
            <i />
          </button>
          <h1>Hybrid positioning <span>GPS + Wi‑Fi + cell</span></h1>
          <ControlBar
            mode={mode}
            onModeChange={changeMode}
            tracking={tracking}
            onStart={start}
            onStop={stop}
            onClear={clear}
            geofenceOn={geofenceOn}
            onToggleGeofence={() => setGeofenceOn((v) => !v)}
            showHeatmap={showHeatmap}
            onToggleHeatmap={() => setShowHeatmap((v) => !v)}
          />
                    {geofenceOn && (
            <div className="gf-playback" style={{ marginTop: "-4px", marginBottom: "16px" }}>
              <span>Radius</span>
              <input
                type="range"
                min="50"
                max="1000"
                step="50"
                value={geofenceRadius}
                onChange={(e) => setGeofenceRadius(Number(e.target.value))}
              />
              <span>{geofenceRadius}m</span>
            </div>
          )}
          <StatsPanel
            latest={latest}
            distanceKm={distanceKm}
            points={points}
            error={error}
            geofenceStatus={geofenceStatus}
          />
          <PlaybackControls
            points={points}
            index={playbackIdx}
            setIndex={setPlaybackIdx}
            onReset={() => setPlaybackIdx(Math.max(0, points.length - 1))}
          />
          <div className="gf-privacy">
            <strong>Privacy</strong>
            <ul>
              <li>Data stored only in this browser.</li>
              <li>IP mode sends a request to a public IP-lookup service (ipwho.is / ipapi.co), which sees your IP address.</li>
              <li>Press <b>Stop</b> any time; <b>Clear data</b> deletes all points.</li>
              <li>Geofence only watches your own device.</li>
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}

// ===========================================================================
// 5) Styles (injected with the component — keeps the app to one file)
// ===========================================================================
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  :root {
    --nav-h: 56px; --primary:#2563eb; --primary-d:#1d4ed8; --ink:#0f172a; --muted:#64748b;
    --line:#e2e8f0; --card:#f8fafc; --radius:14px;
  }
  .gf-shell, .gf-nav, .gf-side { font-family: 'Inter', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }

  /* ---------- Navbar ---------- */
  .gf-nav {
    box-sizing: border-box; padding: 0 20px;
    padding-top: env(safe-area-inset-top);
    height: calc(var(--nav-h) + env(safe-area-inset-top));
    display:flex; align-items:center; justify-content:space-between;
    background: rgba(255,255,255,.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line); position: relative; z-index: 2000;
  }
  .gf-nav-brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; color:var(--ink); letter-spacing:-.3px; }
  .gf-nav-brand img { border-radius:8px; }
  .gf-nav-right { display:flex; align-items:center; gap:12px; }
  .gf-live { font-size:12px; font-weight:600; color:var(--muted); background:#f1f5f9; padding:5px 10px 5px 22px; border-radius:999px; position:relative; }
  .gf-live::before { content:""; position:absolute; left:9px; top:50%; width:8px; height:8px; margin-top:-4px; border-radius:50%; background:#94a3b8; }
  .gf-live.on { color:#166534; background:#dcfce7; }
  .gf-live.on::before { background:#16a34a; animation: gfPulse 1.4s infinite; }
  @keyframes gfPulse { 0%{box-shadow:0 0 0 0 rgba(22,163,74,.55)} 100%{box-shadow:0 0 0 8px rgba(22,163,74,0)} }
  .gf-install {
    display:inline-flex; align-items:center; gap:8px; min-height:40px; padding:0 16px; border:none; border-radius:10px;
    background:var(--primary); color:#fff; font:600 13px 'Inter',system-ui,sans-serif; cursor:pointer;
    box-shadow:0 4px 12px rgba(37,99,235,.3); transition: background .2s, transform .1s;
  }
  .gf-install:hover { background:var(--primary-d); }
  .gf-install:active { transform: scale(.97); }

  /* ---------- Layout ---------- */
  .gf-shell {
    display:grid; grid-template-columns: 1fr 400px; background:#f1f5f9;
    height: calc(100vh - var(--nav-h)); height: calc(100dvh - var(--nav-h) - env(safe-area-inset-top));
  }
  .gf-map-wrap { position:relative; height:100%; min-height:0; }
  .gf-side {
    background:#fff; padding:22px; overflow-y:auto; z-index:1000; position:relative;
    box-shadow:-8px 0 30px rgba(15,23,42,.06);
  }
  .gf-side h1 { font-size:15px; font-weight:700; margin:0 0 16px; color:var(--ink); display:flex; align-items:baseline; gap:8px; }
  .gf-side h1 span { color:var(--muted); font-size:12px; font-weight:500; }
  .gf-handle { display:none; }

  /* ---------- Controls ---------- */
  .gf-controlbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:16px; }
  .gf-seg { display:flex; width:100%; padding:4px; gap:4px; background:#f1f5f9; border-radius:12px; }
  .gf-controlbar .gf-seg button { flex:1; min-height:38px; padding:0 10px; border-radius:9px; background:transparent; color:#64748b; box-shadow:none; }
  .gf-controlbar .gf-seg button:hover { background:#e2e8f0; }
  .gf-controlbar .gf-seg button.sel { background:#fff; color:var(--primary-d); box-shadow:0 1px 4px rgba(15,23,42,.15); }
  [data-theme="dark"] .gf-seg { background:#1e293b; }
  [data-theme="dark"] .gf-controlbar .gf-seg button { background:transparent; color:#94a3b8; }
  [data-theme="dark"] .gf-controlbar .gf-seg button:hover { background:#273449; }
  [data-theme="dark"] .gf-controlbar .gf-seg button.sel { background:#0f172a; color:#93c5fd; }
  .gf-badge { padding:7px 12px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:.3px; }
  .gf-badge.on { background:#dcfce7; color:#166534; }
  .gf-badge.off { background:#f1f5f9; color:#475569; }
  .gf-controlbar button {
    min-height:42px; padding:0 16px; border-radius:10px; border:none; background:#f1f5f9; color:#334155;
    font:600 13px 'Inter',system-ui,sans-serif; cursor:pointer; transition: background .2s, transform .1s;
  }
  .gf-controlbar button:hover { background:#e2e8f0; }
  .gf-controlbar button:active { transform:scale(.97); }
  .gf-controlbar button.primary { background:var(--primary); color:#fff; box-shadow:0 4px 12px rgba(37,99,235,.3); }
  .gf-controlbar button.primary:hover { background:var(--primary-d); }
  .gf-controlbar button.danger { background:#ef4444; color:#fff; box-shadow:0 4px 12px rgba(239,68,68,.3); }
  .gf-controlbar button.danger:hover { background:#dc2626; }
  .gf-toggle { display:flex; align-items:center; gap:8px; min-height:42px; padding:0 12px; border:1px solid var(--line); border-radius:10px;
    font-size:13px; font-weight:500; color:#475569; cursor:pointer; user-select:none; }
  .gf-toggle input { accent-color:var(--primary); width:18px; height:18px; cursor:pointer; margin:0; }

  /* ---------- Stats ---------- */
  .gf-stats { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:14px; margin-bottom:16px; }
  .gf-tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .gf-tile { background:#fff; border:1px solid var(--line); border-radius:12px; padding:10px 10px 9px; min-width:0; }
  .gf-tile span { display:block; font-size:11px; font-weight:500; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; }
  .gf-tile b { display:block; font-size:16px; font-weight:700; color:var(--ink); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric: tabular-nums; }
  .gf-tile small { display:block; font-size:11px; color:var(--muted); margin-top:1px; }
  .gf-row { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; margin-top:10px; font-size:13px; border-radius:10px; background:#fff; border:1px solid var(--line); }
  .gf-row span { color:var(--muted); font-weight:500; }
  .gf-row b { font-weight:700; }
  .gf-geofence.in { background:#f0fdf4; border-color:#bbf7d0; } .gf-geofence.in b { color:#16a34a; }
  .gf-geofence.out { background:#fef2f2; border-color:#fecaca; } .gf-geofence.out b { color:#dc2626; }
  .gf-warn { background:#fef3c7; color:#92400e; padding:10px 12px; border-radius:10px; font-size:12px; margin-top:10px; font-weight:500; }
  .gf-error { background:#fee2e2; color:#991b1b; padding:10px 12px; border-radius:10px; font-size:12px; margin-bottom:10px; font-weight:500; }
  .gf-spark { margin-top:12px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:10px 10px 6px; }

  .gf-playback { display:flex; gap:10px; align-items:center; font-size:12px; font-weight:500; color:#475569; margin-bottom:16px; }
  .gf-playback input[type=range] { flex:1; accent-color:var(--primary); min-width:0; height:28px; }
  .gf-playback button { border:none; background:#e2e8f0; min-height:32px; padding:0 12px; border-radius:8px; cursor:pointer; font-weight:600; color:#334155; }

  .gf-theme {
    width:40px; height:40px; display:flex; align-items:center; justify-content:center; border:1px solid var(--line);
    border-radius:10px; background:transparent; color:#334155; cursor:pointer; transition: background .2s;
  }
  .gf-theme:hover { background:#f1f5f9; }

  /* ---------- Dark theme ---------- */
  :root[data-theme="dark"] body { background:#0b1220; }
  :root[data-theme="dark"] {
    --ink:#f1f5f9; --muted:#94a3b8; --line:#273449; --card:#111a2c; color-scheme: dark;
  }
  [data-theme="dark"] .gf-shell { background:#0b1220; }
  [data-theme="dark"] .gf-nav { background:rgba(15,23,42,.92); }
  [data-theme="dark"] .gf-side { background:#0f172a; box-shadow:-8px 0 30px rgba(0,0,0,.4); }
  [data-theme="dark"] .gf-handle { background:#0f172a; }
  [data-theme="dark"] .gf-handle i { background:#475569; }
  [data-theme="dark"] .gf-live, [data-theme="dark"] .gf-badge.off { background:#1e293b; color:#94a3b8; }
  [data-theme="dark"] .gf-live.on, [data-theme="dark"] .gf-badge.on { background:#14532d; color:#bbf7d0; }
  [data-theme="dark"] .gf-theme { color:#e2e8f0; }
  [data-theme="dark"] .gf-theme:hover { background:#1e293b; }
  [data-theme="dark"] .gf-controlbar button { background:#1e293b; color:#e2e8f0; }
  [data-theme="dark"] .gf-controlbar button:hover { background:#273449; }
  [data-theme="dark"] .gf-controlbar button.primary { background:var(--primary); color:#fff; }
  [data-theme="dark"] .gf-controlbar button.danger { background:#ef4444; color:#fff; }
  [data-theme="dark"] .gf-toggle { color:#cbd5e1; }
  [data-theme="dark"] .gf-tile, [data-theme="dark"] .gf-row, [data-theme="dark"] .gf-spark { background:#0f172a; }
  [data-theme="dark"] .gf-geofence.in { background:#052e16; border-color:#166534; }
  [data-theme="dark"] .gf-geofence.out { background:#450a0a; border-color:#991b1b; }
  [data-theme="dark"] .gf-warn { background:#422006; color:#fde68a; }
  [data-theme="dark"] .gf-error { background:#450a0a; color:#fecaca; }
  [data-theme="dark"] .gf-playback { color:#cbd5e1; }
  [data-theme="dark"] .gf-playback button { background:#273449; color:#e2e8f0; }
  [data-theme="dark"] .gf-privacy { background:#0c1a33; border-color:#1e3a8a; color:#cbd5e1; }
  [data-theme="dark"] .gf-privacy strong { color:#93c5fd; }
  [data-theme="dark"] .gf-ctl, [data-theme="dark"] .gf-styles { background:#1e293b; color:#e2e8f0; }
  [data-theme="dark"] .gf-ctl:hover:not(:disabled) { background:#273449; }
  [data-theme="dark"] .gf-ctl.active { background:var(--primary); color:#fff; }
  [data-theme="dark"] .gf-style { color:#e2e8f0; }
  [data-theme="dark"] .gf-style:hover { background:#273449; }
  [data-theme="dark"] .gf-style.sel { background:#1e3a8a; color:#dbeafe; }
  [data-theme="dark"] .gf-style i { border-color:#1e293b; box-shadow:0 0 0 1px #475569; }
  [data-theme="dark"] .gf-nav-brand, [data-theme="dark"] .gf-side h1 { color:#f1f5f9; }
  [data-theme="dark"] .leaflet-popup-content-wrapper, [data-theme="dark"] .leaflet-popup-tip { background:#1e293b; color:#e2e8f0; }
  [data-theme="dark"] .leaflet-control-zoom a { background:#1e293b; color:#e2e8f0; border-color:#334155; }
  [data-theme="dark"] .leaflet-control-attribution { background:rgba(15,23,42,.8); color:#94a3b8; }
  [data-theme="dark"] .leaflet-control-attribution a { color:#93c5fd; }
  [data-theme="dark"] .recharts-default-tooltip { background:#1e293b !important; border-color:#334155 !important; }
  [data-theme="dark"] .gf-spark small { color:#94a3b8 !important; }

  /* ---------- Map controls ---------- */
  .gf-mapctl { position:absolute; top:12px; right:12px; z-index:1000; display:flex; flex-direction:row-reverse; gap:8px; align-items:flex-start; }
  .gf-ctl-stack { display:flex; flex-direction:column; gap:8px; }
  .gf-ctl {
    width:44px; height:44px; display:flex; align-items:center; justify-content:center; border:none; border-radius:12px;
    background:#fff; color:#334155; cursor:pointer; box-shadow:0 2px 10px rgba(15,23,42,.2); transition: background .2s, color .2s, transform .1s;
  }
  .gf-ctl:hover:not(:disabled) { background:#f1f5f9; }
  .gf-ctl:active:not(:disabled) { transform:scale(.95); }
  .gf-ctl:disabled { opacity:.45; cursor:not-allowed; }
  .gf-ctl.active { background:var(--primary); color:#fff; }
  .gf-styles { background:#fff; border-radius:14px; padding:6px; box-shadow:0 8px 30px rgba(15,23,42,.25); display:flex; flex-direction:column; gap:2px; min-width:150px; }
  .gf-style { display:flex; align-items:center; gap:10px; min-height:42px; padding:0 10px; border:none; border-radius:10px; background:none;
    font:600 13px 'Inter',system-ui,sans-serif; color:#334155; cursor:pointer; text-align:left; }
  .gf-style:hover { background:#f1f5f9; }
  .gf-style.sel { background:#eff6ff; color:var(--primary-d); }
  .gf-style i { width:26px; height:26px; border-radius:8px; border:2px solid #fff; box-shadow:0 0 0 1px #cbd5e1; flex:none; }
  .gf-style.sel i { box-shadow:0 0 0 2px var(--primary); }
  .leaflet-top.leaflet-left { margin-top: 4px; }

  .gf-toast {
    position:absolute; top:20px; left:50%; transform:translateX(-50%); padding:12px 22px; border-radius:12px; color:#fff;
    font-weight:600; font-size:14px; box-shadow:0 10px 25px rgba(0,0,0,.2); z-index:1000; animation: gfFade 3.5s ease-in-out;
  }
  .gf-toast.ok { background:#16a34a; } .gf-toast.bad { background:#dc2626; }
  .gf-toast.info { background:#1e293b; width:max-content; max-width:88%; text-align:center; animation-duration:6s; }
  @keyframes gfFade { 0%{opacity:0;top:8px} 8%{opacity:1;top:20px} 92%{opacity:1;top:20px} 100%{opacity:0;top:8px} }

  .gf-privacy { font-size:12px; color:#475569; background:#eff6ff; padding:14px 16px; border-radius:var(--radius); border:1px solid #dbeafe; line-height:1.5; }
  .gf-privacy strong { color:#1e3a8a; display:block; margin-bottom:6px; font-size:13px; }
  .gf-privacy ul { padding-left:16px; margin:0; } .gf-privacy li { margin-bottom:3px; }

  .leaflet-popup-content-wrapper { border-radius:12px !important; box-shadow:0 4px 20px rgba(0,0,0,.15) !important; }
  .leaflet-popup-content { font-family:'Inter',sans-serif !important; font-size:13px !important; line-height:1.5 !important; }

  /* ---------- Mobile: map fills screen, panel is a bottom sheet ---------- */
  @media (max-width: 800px) {
    .gf-nav { padding-left:14px; padding-right:14px; }
    .gf-install-label { display:none; }
    .gf-install { width:40px; padding:0; justify-content:center; }
    .gf-shell { display:block; position:relative; }
    .gf-map-wrap { position:absolute; inset:0; }
    .gf-side {
      position:absolute; left:0; right:0; bottom:0; height:auto; max-height:62%;
      padding:0 16px calc(16px + env(safe-area-inset-bottom)); border-radius:22px 22px 0 0;
      box-shadow:0 -10px 40px rgba(15,23,42,.18); transition: max-height .3s cubic-bezier(.32,.72,0,1);
    }
    .gf-side.closed { max-height:150px; overflow:hidden; }
    .gf-handle { display:flex; justify-content:center; align-items:center; width:100%; height:28px; border:none; background:#fff; cursor:pointer; position:sticky; top:0; z-index:1; padding:0; }
    .gf-handle i { width:40px; height:5px; border-radius:3px; background:#cbd5e1; }
    .gf-side h1 { display:none; }
    .gf-controlbar { gap:8px; }
    .gf-controlbar button.primary, .gf-controlbar button.danger { flex:1; }
    .gf-tile b { font-size:15px; }
    .gf-toast { top:14px; font-size:13px; padding:10px 16px; }
  }
  @media (max-width: 380px) { .gf-tiles { grid-template-columns:repeat(2,1fr); } }
  @media (prefers-reduced-motion: reduce) { .gf-side, .gf-live::before, .gf-toast { transition:none; animation:none; } }
`;
