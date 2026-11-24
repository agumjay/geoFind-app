// src/HistoryPage.jsx — all saved locations (with place names) + insights.
import { useMemo, useState } from "react";
import { computeInsights, fmtDuration, exportCsv, exportGeoJson } from "./insights";

const PAGE = 100;

export default function HistoryPage({ points, loaded, distanceKm, pendingNames, onShow, onClear }) {
  const ins = useMemo(() => computeInsights(points), [points]);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? points.filter((p) => `${p.place ?? ""} ${p.address ?? ""}`.toLowerCase().includes(needle))
      : points;
    return [...list].reverse(); // newest first
  }, [points, q]);

  const top = ins?.maxSpeed;
  return (
    <div className="gf-page">
      <div className="gf-page-inner">
        <header className="gf-page-head">
          <div>
            <h2>History</h2>
            <p>Every location collected, with the name of the place, saved on this device.</p>
          </div>
          <div className="gf-page-actions">
            <button disabled={!points.length} onClick={() => exportCsv(points)}>Export CSV</button>
            <button disabled={!points.length} onClick={() => exportGeoJson(points)}>Export GeoJSON</button>
            <button className="warn" disabled={!points.length}
                    onClick={() => { if (window.confirm(`Permanently delete all ${points.length} saved locations?`)) onClear(); }}>
              Delete all
            </button>
          </div>
        </header>

        {!ins ? (
          <div className="gf-empty">
            <p style={{ fontSize: 30, margin: 0 }}>🗺️</p>
            <b>{loaded ? "No locations saved yet" : "Loading…"}</b>
            <span>Start tracking on the Map tab — every point is saved here automatically.</span>
          </div>
        ) : (
          <>
            <section className="gf-card">
              <h3>Insights</h3>
              <div className="gf-tiles gf-tiles-4">
                <button className="gf-tile gf-tile-btn" disabled={!top} onClick={() => top && onShow(top.point.lat, top.point.lng)} title="Show on map">
                  <span>Top speed</span>
                  <b>{top ? (top.mps * 3.6).toFixed(1) : "—"}</b>
                  <small>km/h{top ? ` · ${new Date(top.point.timestamp).toLocaleDateString()}` : ""}</small>
                  {top?.point.place && <small className="gf-tile-place">{top.point.place}</small>}
                </button>
                <div className="gf-tile"><span>Avg moving speed</span><b>{ins.avgMovingKmh != null ? ins.avgMovingKmh.toFixed(1) : "—"}</b><small>km/h</small></div>
                <div className="gf-tile"><span>Total distance</span><b>{distanceKm.toFixed(2)}</b><small>km</small></div>
                <div className="gf-tile"><span>Time tracked</span><b>{fmtDuration(ins.activeTime)}</b><small>{ins.days} day{ins.days === 1 ? "" : "s"}</small></div>
                <button className="gf-tile gf-tile-btn" onClick={() => onShow(ins.farthest.point.lat, ins.farthest.point.lng)} title="Show on map">
                  <span>Farthest from start</span><b>{ins.farthest.km.toFixed(2)}</b><small>km</small>
                  {ins.farthest.point.place && <small className="gf-tile-place">{ins.farthest.point.place}</small>}
                </button>
                <div className="gf-tile"><span>Places visited</span><b>{ins.placesCount}</b><small>distinct names</small></div>
                <div className="gf-tile"><span>GPS points</span><b>{ins.totalPoints.toLocaleString()}</b><small>recorded</small></div>
                <div className="gf-tile"><span>All saved</span><b>{loaded ? points.length.toLocaleString() : "…"}</b><small>incl. IP guesses</small></div>
              </div>
            </section>

            <section className="gf-card">
              <h3>Most visited areas</h3>
              <div className="gf-areas">
                {ins.areas.map((a, i) => (
                  <button key={a.key} className="gf-area" onClick={() => onShow(a.lat, a.lng)}>
                    <i>{i + 1}</i>
                    <span className="gf-area-main">
                      <b>{a.name ?? `${a.lat.toFixed(4)}, ${a.lng.toFixed(4)}`}</b>
                      <small>
                        {a.visits} visit{a.visits === 1 ? "" : "s"} · {fmtDuration(a.dwell)} spent · last {new Date(a.last).toLocaleDateString()}
                        {a.name ? ` · ${a.lat.toFixed(4)}, ${a.lng.toFixed(4)}` : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        <section className="gf-card">
          <div className="gf-card-head">
            <h3>Saved locations <span className="gf-pill">{rows.length.toLocaleString()}</span></h3>
            <input className="gf-input gf-search" placeholder="Filter by place name…" value={q}
                   onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
          </div>
          {pendingNames > 0 && (
            <div className="gf-note">Looking up place names for {pendingNames.toLocaleString()} location{pendingNames === 1 ? "" : "s"}… (one per second, runs in the background)</div>
          )}
          {rows.length === 0 ? (
            <div className="gf-empty small"><span>{points.length ? "No locations match that filter." : "Nothing recorded yet."}</span></div>
          ) : (
            <ul className="gf-loclist">
              {rows.slice(0, shown).map((p) => (
                <li key={p.id}>
                  <button className="gf-loc" onClick={() => onShow(p.lat, p.lng)} title="Show on map">
                    <span className="gf-loc-main">
                      <b>{p.place ?? (p.sourceHint === "ip" ? "IP location" : "Looking up place…")}</b>
                      <small>{p.address && p.address !== p.place ? p.address : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}</small>
                    </span>
                    <span className="gf-loc-meta">
                      <time>{new Date(p.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
                      <small>
                        <span className={`gf-src ${p.sourceHint}`}>{p.sourceHint}</span> ±{Math.round(p.accuracy ?? 0)} m
                        {p.speed != null ? ` · ${(p.speed * 3.6).toFixed(1)} km/h` : ""}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rows.length > shown && (
            <button className="gf-more" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>
          )}
        </section>

        <p className="gf-fine">
          Place names come from OpenStreetMap (Nominatim): the coordinates of each new ~100 m area are sent to it once and the answer is cached on this device.
        </p>
      </div>
    </div>
  );
}
