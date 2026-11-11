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
const GEOFENCE_RADIUS_M = 150;

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

  const watchIdRef = useRef(null);

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

  const stop = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setTracking(false);
  }, []);

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setError("Geolocation not supported by this browser.");
      return;
    }
    setError(null);
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
        setPoints((prev) => {
          const next = [...prev, newPt];
          return next.length > MAX_POINTS
            ? next.slice(next.length - MAX_POINTS)
            : next;
        });
      },
      (err) => setError(err.message || "Geolocation error"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }, []);

  const clear = useCallback(() => {
    stop();
    setPoints([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  const latest = points.length ? points[points.length - 1] : null;
  return { tracking, start, stop, clear, points, latest, distanceKm, error };
}

// ===========================================================================
// 2) Map sub-components
// ===========================================================================
function FlyToLatest({ latest }) {
  const map = useMap();
  useEffect(() => {
    if (latest) map.setView([latest.lat, latest.lng], map.getZoom(), { animate: true });
  }, [latest, map]);
  return null;
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

function MapView({ points, latest, geofence, insideGeofence, playbackPoint, showHeatmap }) {
  const trail = points.map((p) => [p.lat, p.lng]);
  const center = latest ? [latest.lat, latest.lng] : DEFAULT_CENTER;

  return (
    <MapContainer center={center} zoom={16} style={{ height: "100%", width: "100%" }}>
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FlyToLatest latest={latest} />

      {trail.length > 1 && (
        <Polyline positions={trail} pathOptions={{ color: "#2563eb", weight: 4 }} />
      )}

      {latest && (
        <Marker position={[latest.lat, latest.lng]}>
          <Popup>
            <strong>You are here</strong><br />
            Accuracy: ±{Math.round(latest.accuracy)} m<br />
            Source: {latest.sourceHint}<br />
            Time: {new Date(latest.timestamp).toLocaleTimeString()}
          </Popup>
        </Marker>
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
  tracking, onStart, onStop, onClear,
  geofenceOn, onToggleGeofence,
  showHeatmap, onToggleHeatmap,
}) {
  return (
    <div className="gf-controlbar">
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
          <div className="gf-row"><span>📍 Latitude</span><b>{latest.lat.toFixed(6)}</b></div>
          <div className="gf-row"><span>📍 Longitude</span><b>{latest.lng.toFixed(6)}</b></div>
          <div className="gf-row"><span>🎯 Accuracy</span><b>±{Math.round(latest.accuracy)} m ({latest.sourceHint})</b></div>
          <div className="gf-row"><span>🚀 Speed</span><b>{latest.speed != null ? (latest.speed * 3.6).toFixed(1) : "—"} km/h</b></div>
          <div className="gf-row"><span>📏 Distance</span><b>{distanceKm.toFixed(3)} km</b></div>
          <div className="gf-row"><span>⏱ Last update</span><b>{new Date(latest.timestamp).toLocaleTimeString()}</b></div>
          <div className="gf-row"><span>📌 Points</span><b>{points.length}</b></div>
          
          {geofenceStatus && (
            <div className={`gf-row gf-geofence ${geofenceStatus === "inside" ? "in" : "out"}`}>
              <span>🚧 Geofence</span>
              <b>{geofenceStatus === "inside" ? "INSIDE" : "OUTSIDE"}</b>
            </div>
          )}
          
          {latest.accuracy > 50 && (
            <div className="gf-warn">⚠ Coarse accuracy — hybrid fallback (Wi‑Fi/cell) likely in use.</div>
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
  const { tracking, start, stop, clear, points, latest, distanceKm, error } = useHybridTracking();

  const [geofenceOn, setGeofenceOn] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [geofenceCenter, setGeofenceCenter] = useState(null);
  const [geofenceRadius, setGeofenceRadius] = useState(150);
  const [insideGeofence, setInsideGeofence] = useState(false);
  const [alert, setAlert] = useState(null);
  const [playbackIdx, setPlaybackIdx] = useState(0);

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
      <div className="gf-shell">
        <div className="gf-map-wrap">
                   <MapView
            points={points}
            latest={latest}
            geofence={geofenceOn && geofenceCenter ? { ...geofenceCenter, radius: geofenceRadius } : null} 
            insideGeofence={insideGeofence}
            playbackPoint={playbackPoint}
            showHeatmap={showHeatmap}
          />
          {alert && (
            <div className={`gf-toast ${insideGeofence ? "ok" : "bad"}`}>{alert}</div>
          )}
        </div>

        <aside className="gf-side">
          <h1>geoFind <span>· hybrid positioning</span></h1>
          <ControlBar
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

  .gf-shell { 
    display: grid; 
    grid-template-columns: 1fr 380px; 
    height: 100vh; 
    font-family: 'Inter', system-ui, sans-serif;
    background: #f3f4f6;
  }
  @media (max-width:800px){ .gf-shell{ grid-template-columns: 1fr; grid-template-rows: 55vh 1fr; } }
  
  .gf-map-wrap { position:relative; height:100%; }
  
  .gf-side { 
    background: #ffffff; 
    padding: 24px; 
    overflow-y: auto; 
    box-shadow: -4px 0 24px rgba(0,0,0,0.05); 
    z-index: 1000;
  }
  
  .gf-side h1 { 
    font-size: 24px; 
    font-weight: 700;
    margin: 0 0 20px 0; 
    color: #111827;
    letter-spacing: -0.5px;
  }
  .gf-side h1 span { color: #6b7280; font-size: 13px; font-weight: 500; letter-spacing: 0; }

  .gf-controlbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:20px; }
  
  .gf-controlbar button { 
    padding: 10px 16px; 
    border-radius: 8px; 
    border: none; 
    background: #f3f4f6; 
    color: #374151;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer; 
    transition: all 0.2s ease;
  }
  .gf-controlbar button:hover { background: #e5e7eb; }
  
  .gf-controlbar button.primary { 
    background: #3b82f6; 
    color: #fff; 
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
  }
  .gf-controlbar button.primary:hover { background: #2563eb; }
  
  .gf-controlbar button.danger { 
    background: #ef4444; 
    color: #fff; 
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
  }
  .gf-controlbar button.danger:hover { background: #dc2626; }
  
  .gf-toggle { display:flex; align-items:center; gap:6px; font-size:13px; font-weight: 500; color: #4b5563; cursor: pointer; }
  .gf-toggle input { accent-color: #3b82f6; width: 16px; height: 16px; cursor: pointer; }

  .gf-badge { 
    padding: 6px 12px; 
    border-radius: 999px; 
    font-size: 12px; 
    font-weight: 700; 
    letter-spacing: 0.5px;
  }
  .gf-badge.on { background: #dcfce7; color: #166534; }
  .gf-badge.off { background: #f3f4f6; color: #4b5563; }

  .gf-stats { 
    background: #f9fafb;
    border: 1px solid #e5e7eb; 
    border-radius: 12px; 
    padding: 16px; 
    margin-bottom: 16px; 
  }
  .gf-row { 
    display:flex; 
    justify-content:space-between; 
    padding: 8px 0; 
    font-size: 13px; 
    border-bottom: 1px solid #f3f4f6;
  }
  .gf-row:last-child { border-bottom: none; }
  .gf-row span { color: #6b7280; font-weight: 500; }
  .gf-row b { color: #111827; font-weight: 600; }
  
  .gf-geofence.in b { color: #16a34a; }
  .gf-geofence.out b { color: #dc2626; }

  .gf-warn { background:#fef3c7; color:#92400e; padding:10px; border-radius:8px; font-size:12px; margin-top:12px; font-weight: 500; }
  .gf-error { background:#fee2e2; color:#991b1b; padding:10px; border-radius:8px; font-size:12px; margin-bottom:12px; font-weight: 500; }
  
  .gf-spark { margin-top: 16px; }
  
  .gf-playback { display:flex; gap:10px; align-items:center; font-size:12px; font-weight: 500; color: #4b5563; margin-bottom: 16px; }
  .gf-playback input[type=range] { flex:1; accent-color: #3b82f6; }
  .gf-playback button { border: none; background: #e5e7eb; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-weight: 600; color: #374151; }

  .gf-toast { 
    position:absolute; 
    top:24px; 
    left:50%; 
    transform:translateX(-50%);
    padding: 12px 24px; 
    border-radius: 8px; 
    color:#fff; 
    font-weight: 600;
    font-size: 14px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.2);
    z-index:1000; 
    animation: gfFade 3.5s ease-in-out; 
  }
  .gf-toast.ok { background:#16a34a; }
  .gf-toast.bad { background:#dc2626; }
  @keyframes gfFade { 0%{opacity:0; top: 10px;} 10%{opacity:1; top: 24px;} 90%{opacity:1; top: 24px;} 100%{opacity:0; top: 10px;} }

  .gf-privacy { 
    font-size: 12px; 
    color: #4b5563; 
    background: #eff6ff; 
    padding: 16px; 
    border-radius: 12px; 
    border: 1px solid #dbeafe;
    line-height: 1.5;
  }
  .gf-privacy strong { color: #1e3a8a; display: block; margin-bottom: 6px; font-size: 13px; }
  .gf-privacy ul { padding-left:16px; margin:0; }
  .gf-privacy li { margin-bottom: 4px; }
  
  /* Make Leaflet map popups look modern */
  .leaflet-popup-content-wrapper { border-radius: 12px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.15) !important; }
  .leaflet-popup-content { font-family: 'Inter', sans-serif !important; font-size: 13px !important; line-height: 1.5 !important; }
`;