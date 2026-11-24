// src/RoutesPage.jsx — plan and schedule routes between named places.
import { useEffect, useMemo, useState } from "react";
import { searchPlaces, reverseGeocode, MODES } from "./places";
import { REPEATS, REMIND_OPTIONS, routeStatus, fmtWhen, fmtDist, fmtMins } from "./schedule";

const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nextHourStr = () => { const d = new Date(Date.now() + 3600000); return `${pad(d.getHours())}:00`; };

// ---- Place picker: search by name or use the current location ---------------
function PlaceInput({ label, value, onChange, latest }) {
  const [text, setText] = useState(value?.label ?? "");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { setText(value?.label ?? ""); }, [value]);

  const search = async () => {
    if (text.trim().length < 3) { setErr("Type at least 3 letters."); return; }
    setBusy(true); setErr(""); setResults(null);
    try {
      const r = await searchPlaces(text.trim());
      if (!r.length) setErr("No place found. Try a more specific name.");
      setResults(r);
    } catch { setErr("Search failed. Check your connection."); }
    setBusy(false);
  };

  const useHere = async () => {
    setErr(""); setBusy(true);
    try {
      let lat, lng, name = latest?.place;
      if (latest && latest.sourceHint !== "ip") { lat = latest.lat; lng = latest.lng; }
      else {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 }));
        lat = pos.coords.latitude; lng = pos.coords.longitude; name = null;
      }
      if (!name) name = (await reverseGeocode(lat, lng))?.label;
      onChange({ label: name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng });
      setResults(null);
    } catch { setErr("Couldn't get your current location (needs HTTPS and permission)."); }
    setBusy(false);
  };

  return (
    <div className="gf-field">
      <label>{label}</label>
      <div className="gf-place-row">
        <input className="gf-input" value={text} placeholder="Search a place, e.g. Mbarara Bus Park"
               onChange={(e) => { setText(e.target.value); if (value) onChange(null); }}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <button type="button" className="gf-btn" onClick={search} disabled={busy}>{busy ? "…" : "Search"}</button>
        <button type="button" className="gf-btn ghost" onClick={useHere} disabled={busy} title="Use my current location">📍</button>
      </div>
      {value && <small className="gf-ok">✓ {value.lat.toFixed(4)}, {value.lng.toFixed(4)}</small>}
      {err && <small className="gf-bad">{err}</small>}
      {results?.length > 0 && (
        <ul className="gf-results">
          {results.map((r, i) => (
            <li key={i}>
              <button type="button" onClick={() => { onChange(r); setResults(null); }}>
                <b>{r.label}</b><small>{r.address}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_TEXT = { paused: "Paused", past: "Finished", soon: "Starting soon", upcoming: "Scheduled" };

export default function RoutesPage({ routes, latest, activeId, onCreate, onUpdate, onDelete, onShow, onStart }) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [mode, setMode] = useState("driving");
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState(nextHourStr());
  const [repeat, setRepeat] = useState("once");
  const [remindMin, setRemindMin] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!from || !to) { setError("Choose both places from the search results (or use 📍 for your location)."); return; }
    if (!date || !time) { setError("Pick a date and time."); return; }
    setBusy(true);
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
      await onCreate({
        name: name.trim() || `${from.label.split(",")[0]} → ${to.label.split(",")[0]}`,
        from: { label: from.label, lat: from.lat, lng: from.lng },
        to: { label: to.label, lat: to.lat, lng: to.lng },
        mode, date, time, repeat, remindMin,
      });
      setName(""); setFrom(null); setTo(null);
    } catch (err) { setError(err.message || "Couldn't create the route."); }
    setBusy(false);
  };

  const sorted = useMemo(() => {
    return [...routes].map((r) => ({ r, st: routeStatus(r, now) })).sort((a, b) => {
      const rank = { soon: 0, upcoming: 1, paused: 2, past: 3 };
      return rank[a.st.kind] - rank[b.st.kind] || (a.st.occ ?? 0) - (b.st.occ ?? 0);
    });
  }, [routes, now]);

  const notifBlocked = typeof Notification !== "undefined" && Notification.permission === "denied";

  return (
    <div className="gf-page">
      <div className="gf-page-inner gf-routes">
        <header className="gf-page-head">
          <div>
            <h2>Routes</h2>
            <p>Plan a route between two places and schedule when you'll travel it.</p>
          </div>
        </header>

        <div className="gf-routes-grid">
          <form className="gf-card" onSubmit={submit}>
            <h3>New scheduled route</h3>
            <div className="gf-field">
              <label>Name <small>(optional)</small></label>
              <input className="gf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning commute" />
            </div>
            <PlaceInput label="From" value={from} onChange={setFrom} latest={latest} />
            <PlaceInput label="To" value={to} onChange={setTo} latest={latest} />
            <div className="gf-form-row">
              <div className="gf-field">
                <label>Travel by</label>
                <select className="gf-input" value={mode} onChange={(e) => setMode(e.target.value)}>
                  {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="gf-field">
                <label>Repeat</label>
                <select className="gf-input" value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                  {Object.entries(REPEATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className="gf-form-row">
              <div className="gf-field">
                <label>{repeat === "once" ? "Date" : "Starting"}</label>
                <input className="gf-input" type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="gf-field">
                <label>Time</label>
                <input className="gf-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>
            <div className="gf-field">
              <label>Remind me</label>
              <select className="gf-input" value={remindMin} onChange={(e) => setRemindMin(+e.target.value)}>
                {REMIND_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
              <small className="gf-fine-inline">
                Reminders appear while geoFind is open{notifBlocked ? " (system notifications are blocked in your browser settings)." : ", and as a system notification if you allow it."}
              </small>
            </div>
            {error && <div className="gf-error">⚠ {error}</div>}
            <button className="gf-btn primary wide" disabled={busy}>{busy ? "Finding route…" : "Save scheduled route"}</button>
          </form>

          <div className="gf-route-list">
            {sorted.length === 0 ? (
              <div className="gf-empty">
                <p style={{ fontSize: 30, margin: 0 }}>🧭</p>
                <b>No routes yet</b>
                <span>Create one and it will appear here with its distance, travel time and next start.</span>
              </div>
            ) : sorted.map(({ r, st }) => (
              <article key={r.id} className={`gf-card gf-route ${st.kind} ${activeId === r.id ? "active" : ""}`}>
                <div className="gf-route-top">
                  <h4>{r.name}</h4>
                  <span className={`gf-chip ${st.kind}`}>{activeId === r.id ? "In progress" : STATUS_TEXT[st.kind]}</span>
                </div>
                <div className="gf-route-path">
                  <span><i className="dot a" />{r.from.label}</span>
                  <span><i className="dot b" />{r.to.label}</span>
                </div>
                <div className="gf-route-facts">
                  <span>🛣 {fmtDist(r.distanceM)}</span>
                  <span>⏱ {fmtMins(r.durationS)}</span>
                  <span>{MODES[r.mode]}</span>
                  <span>🔁 {REPEATS[r.repeat]}</span>
                </div>
                <div className="gf-route-when">
                  {st.kind === "paused" ? "Paused" : st.kind === "past"
                    ? `Was ${new Date(st.occ).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                    : <>Next: <b>{fmtWhen(st.occ, now)}</b> · reminder {r.remindMin ? `${r.remindMin} min before` : "at start"}</>}
                  {r.runs?.length > 0 && <span className="gf-runs"> · completed {r.runs.length}×</span>}
                </div>
                <div className="gf-route-actions">
                  <button className="gf-btn primary" onClick={() => onStart(r)}>Start now</button>
                  <button className="gf-btn" onClick={() => onShow(r)}>Show on map</button>
                  <button className="gf-btn" onClick={() => onUpdate(r.id, { enabled: !r.enabled, notifiedFor: null })}>
                    {r.enabled ? "Pause" : "Resume"}
                  </button>
                  <button className="gf-btn danger" onClick={() => { if (window.confirm(`Delete “${r.name}”?`)) onDelete(r.id); }}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        </div>

        <p className="gf-fine">
          Routes come from OpenStreetMap-based services (routing.openstreetmap.de) and place search from Nominatim; the places you type are sent to them. Everything you save stays on this device.
        </p>
      </div>
    </div>
  );
}
