// src/schedule.js — pure scheduling helpers for routes.
export const REPEATS = {
  once: "Once",
  daily: "Every day",
  weekdays: "Weekdays (Mon–Fri)",
  weekly: "Every week",
};
export const REMIND_OPTIONS = [
  { v: 0, label: "At start time" },
  { v: 5, label: "5 min before" },
  { v: 15, label: "15 min before" },
  { v: 30, label: "30 min before" },
  { v: 60, label: "1 hour before" },
];
export const GRACE_MS = 2 * 60 * 1000; // a start time still counts as "now" for 2 minutes

export function startOf(route) {
  const [y, m, d] = route.date.split("-").map(Number);
  const [hh, mm] = route.time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** Next start time (ms) at or after `from`. For one-off routes it is always the chosen time. */
export function nextOccurrence(route, from = Date.now()) {
  const start = startOf(route);
  if (route.repeat === "once") return start.getTime();
  const [hh, mm] = route.time.split(":").map(Number);
  const base = Math.max(from, start.getTime());
  for (let i = 0; i < 15; i++) {
    const c = new Date(base);
    c.setDate(c.getDate() + i);
    c.setHours(hh, mm, 0, 0);
    if (c.getTime() < base) continue;
    const dow = c.getDay();
    if (route.repeat === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (route.repeat === "weekly" && dow !== start.getDay()) continue;
    return c.getTime();
  }
  return start.getTime();
}

/** { kind: paused | past | soon | upcoming, occ } */
export function routeStatus(route, now = Date.now()) {
  if (!route.enabled) return { kind: "paused", occ: null };
  const occ = nextOccurrence(route, now - GRACE_MS);
  if (route.repeat === "once" && now > occ + GRACE_MS) return { kind: "past", occ };
  const lead = (route.remindMin ?? 0) * 60000;
  return { kind: now >= occ - lead ? "soon" : "upcoming", occ };
}

export function fmtWhen(ms, now = Date.now()) {
  const diffMin = Math.round((ms - now) / 60000);
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffMin <= 0 && diffMin > -3) return "now";
  if (diffMin > 0 && diffMin < 60) return `in ${diffMin} min (${time})`;
  const sameDay = d.toDateString() === new Date(now).toDateString();
  if (sameDay) return `today ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}
export function fmtMins(s) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`;
}
