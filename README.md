# geoFind

A real-time device location tracker built with React + Vite. It shows your position on a map, draws your trail, and includes a speed chart, geofence alerts, a heatmap and trail playback. It is an installable PWA (use the **Download app** button in the navbar).

## Requirements

- [Node.js](https://nodejs.org) 20.19+ (or 22+) and npm
- A browser with Geolocation support (Chrome, Edge, Firefox, Safari)

## Run locally (development)

```bash
npm install
npm run dev
```

Open http://localhost:5173 and press **Start tracking**. Allow the location permission when the browser asks.

> `localhost` counts as a secure context, so location works. The service worker / install button are only active in production builds (see below).

### Try it on your phone

GPS only works on a secure page (`https://` or `http://localhost`). Opening the dev server by its LAN address (`http://192.168.x.x:5173`) is **not** secure, so the phone will refuse to give a location there. Use one of these instead:

- **Deploy** the `dist/` folder to an HTTPS host (see below) and open that URL on the phone. This is the most reliable option.
- **Temporary HTTPS tunnel** to the dev server, e.g. `npx cloudflared tunnel --url http://localhost:5173` (or `npx localtunnel --port 5173`), then open the `https://` URL it prints on the phone.

## Run as a production build (PWA install works here)

```bash
npm run build
npm run preview
```

Open the URL shown (http://localhost:4173). The service worker registers and the **Download app** button installs the app.

## Deploy (HTTPS, needed for phone tracking and install)

Deploy the `dist/` folder to any static HTTPS host (Netlify, Vercel, GitHub Pages, Cloudflare Pages):

```bash
npm run build
```

- Build command: `npm run build`
- Output directory: `dist`

Then open the site on your phone, allow location, and tap **Download app** (iOS Safari: Share → *Add to Home Screen*).

## Scripts

| Command           | What it does                      |
| ----------------- | --------------------------------- |
| `npm run dev`     | Start the dev server              |
| `npm run build`   | Production build into `dist/`     |
| `npm run preview` | Serve the production build        |
| `npm run lint`    | Lint with Oxlint                  |

## How tracking works

- Uses `navigator.geolocation.watchPosition` with high accuracy; modern phones fuse GPS + Wi-Fi + cell.
- The screen is kept awake while tracking (Wake Lock), because browsers pause GPS when the screen locks. Web apps cannot track in the background.
- **GPS / Device mode** uses only the device's location and never falls back to IP. Browsers don't say whether a fix came from GPS, Wi-Fi or cell towers, so with **GPS only** ticked (default) fixes coarser than ±50 m are ignored and the panel says it is still waiting for a real GPS fix. Untick it to also accept Wi-Fi/cell-tower positions (usually accurate to tens–hundreds of metres, and correct city). Laptops have no GPS chip, so they need it unticked.
- **IP address mode** is a separate, manual choice: it locates the device from its public IP via ipwho.is (fallback ipapi.co). It needs no permission but is only city-level and often shows the ISP hub (for example Kampala instead of Mbarara). A dashed purple circle shows the uncertainty; it refreshes every 60 s. This sends a request to those third-party services, which see your IP.
- **Every location is saved** (IndexedDB, no point limit) and survives reloads. Old localStorage data is migrated automatically. Use **Export CSV / GeoJSON** to back it up; **Delete all** / **Clear data** (with confirmation) removes it.
- **Insights** are computed from all saved GPS points: top speed (and where), average moving speed, total distance, time tracked, farthest point from the start, and the five most visited areas (~330 m grid, with visit count and time spent). Tap an item to jump to it on the map. IP-based guesses are excluded.

## Troubleshooting

- **"Location permission denied"**: allow location for the site in browser settings, then press Start again.
- **"Location needs HTTPS"**: open the app via `https://` or `localhost`.
- **No Download button**: it is hidden once installed; in dev mode install is unavailable, use `npm run build && npm run preview`. On iOS/Firefox the button shows manual install instructions.
- **Stale version after an update**: unregister the service worker in DevTools → Application, or hard-refresh.
