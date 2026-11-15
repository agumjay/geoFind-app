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

### Try it on your phone (same Wi-Fi)

```bash
npm run dev -- --host
```

Open the printed `Network` URL on your phone. Note: browsers block geolocation on plain `http://` addresses other than localhost, so for real phone testing use the HTTPS deployment below.

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
- Points are stored only in your browser (`localStorage`). **Clear data** deletes them.

## Troubleshooting

- **"Location permission denied"**: allow location for the site in browser settings, then press Start again.
- **"Location needs HTTPS"**: open the app via `https://` or `localhost`.
- **No Download button**: it is hidden once installed; in dev mode install is unavailable, use `npm run build && npm run preview`. On iOS/Firefox the button shows manual install instructions.
- **Stale version after an update**: unregister the service worker in DevTools → Application, or hard-refresh.
