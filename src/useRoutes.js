// src/useRoutes.js — scheduled routes: storage + reminder engine.
// Reminders fire while geoFind is open (a web app can't wake itself when fully closed
// without a push server). They show as an in-app banner and, if allowed, a system notification.
import { useCallback, useEffect, useRef, useState } from "react";
import { db } from "./storage";
import { fetchRoute } from "./places";
import { nextOccurrence, GRACE_MS, fmtDist, fmtMins } from "./schedule";

async function systemNotify(title, body) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) await reg.showNotification(title, { body, icon: "/icons/icon-192.png", tag: "geofind-route" });
    else new Notification(title, { body, icon: "/icons/icon-192.png" });
  } catch { /* notifications are optional */ }
}

export function useRoutes() {
  const [routes, setRoutes] = useState([]);
  const [reminders, setReminders] = useState([]); // [{ id, routeId, text }]
  const routesRef = useRef([]);

  const commit = useCallback((next) => { routesRef.current = next; setRoutes(next); }, []);

  useEffect(() => {
    let alive = true;
    db.all("routes").then((r) => { if (alive) commit((r ?? []).sort((a, b) => a.createdAt - b.createdAt)); }).catch(() => {});
    return () => { alive = false; };
  }, [commit]);

  const create = useCallback(async (draft) => {
    const geo = await fetchRoute(draft.from, draft.to, draft.mode);
    const route = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      createdAt: Date.now(),
      enabled: true, notifiedFor: null, runs: [],
      ...draft, ...geo,
    };
    commit([...routesRef.current, route]);
    db.put("routes", route);
    return route;
  }, [commit]);

  const update = useCallback((id, patch) => {
    const next = routesRef.current.map((r) => (r.id === id ? { ...r, ...patch } : r));
    commit(next);
    const changed = next.find((r) => r.id === id);
    if (changed) db.put("routes", changed);
  }, [commit]);

  const remove = useCallback((id) => {
    commit(routesRef.current.filter((r) => r.id !== id));
    db.del("routes", id);
  }, [commit]);

  const recordRun = useCallback((id, run) => {
    const r = routesRef.current.find((x) => x.id === id);
    if (r) update(id, { runs: [...(r.runs ?? []), run] });
  }, [update]);

  const dismiss = useCallback((id) => setReminders((list) => list.filter((x) => x.id !== id)), []);

  // Reminder engine: check every 15 s.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const r of routesRef.current) {
        if (!r.enabled) continue;
        const occ = nextOccurrence(r, now - GRACE_MS);
        if (r.repeat === "once" && now > occ + GRACE_MS) continue;
        const lead = (r.remindMin ?? 0) * 60000;
        if (now >= occ - lead && r.notifiedFor !== occ) {
          const mins = Math.max(0, Math.round((occ - now) / 60000));
          const when = mins === 0 ? "now" : `in ${mins} min`;
          const text = `“${r.name}” starts ${when} · ${r.from.label.split(",")[0]} → ${r.to.label.split(",")[0]} · ${fmtDist(r.distanceM)}, ${fmtMins(r.durationS)}`;
          setReminders((list) => [...list.filter((x) => x.routeId !== r.id), { id: `${r.id}-${occ}`, routeId: r.id, text }]);
          systemNotify("geoFind route reminder", text);
          update(r.id, { notifiedFor: occ });
        }
      }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [update]);

  return { routes, create, update, remove, recordRun, reminders, dismiss };
}
