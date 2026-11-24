import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "leaflet/dist/leaflet.css";

// Capture the install prompt as early as possible; the button in the navbar uses it.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__gfInstallEvent = e;
  window.dispatchEvent(new Event("gf-install-ready"));
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);