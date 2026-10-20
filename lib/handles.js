// IndexedDB store for FileSystemDirectoryHandle objects (extension pages only).
(function (root) {
  const DB = "edsip-fs", STORE = "handles";
  const open = () => new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((ok, bad) => { const t = db.transaction(STORE, mode); const q = fn(t.objectStore(STORE)); t.oncomplete = () => ok(q && q.result); t.onerror = () => bad(t.error); });
  }
  const get = (k) => tx("readonly", (s) => s.get(k));
  const set = (k, v) => tx("readwrite", (s) => s.put(v, k));
  const del = (k) => tx("readwrite", (s) => s.delete(k));
  // "granted" | "prompt" | "denied"; request=true needs a user gesture.
  async function permission(h, request) {
    const o = { mode: "readwrite" };
    let p = await h.queryPermission(o);
    if (p !== "granted" && request) p = await h.requestPermission(o);
    return p;
  }
  root.EdsipHandles = { get, set, del, permission };
})(typeof self !== "undefined" ? self : this);
