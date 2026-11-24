// src/storage.js — IndexedDB persistence for geoFind.
// Stores: points (every location), places (reverse-geocode cache), routes (scheduled routes).
const DB_NAME = "geofind";
const DB_VERSION = 2;

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("points")) {
          db.createObjectStore("points", { keyPath: "id" }).createIndex("timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains("places")) db.createObjectStore("places", { keyPath: "key" });
        if (!db.objectStoreNames.contains("routes")) db.createObjectStore("routes", { keyPath: "id" });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (store) => tx(store, "readonly", (s) => s.getAll()),
  put: (store, value) => tx(store, "readwrite", (s) => s.put(value)).catch(() => {}),
  putMany: (store, values) => tx(store, "readwrite", (s) => { values.forEach((v) => s.put(v)); }).catch(() => {}),
  del: (store, id) => tx(store, "readwrite", (s) => s.delete(id)).catch(() => {}),
  clear: (store) => tx(store, "readwrite", (s) => s.clear()).catch(() => {}),
};
