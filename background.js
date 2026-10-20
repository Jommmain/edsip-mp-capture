// Service worker: records in chrome.storage.local; auto-scroll scheduler + anti-block safety.
importScripts("parsers.js", "lib/updater.js");
const UPD = self.EdsipUpdater;
const P = self.EdsipParsers;
const KEY = "records";
const MAX_RECORDS = 3000;
const MPS = ["wb", "ozon"];
const MPN = { wb: "WB", ozon: "Ozon" };
const MAX_SCROLL_TABS = 3;               // simultaneous auto-scroll tabs per marketplace
const BLOCK_STATUS = new Set([403, 429, 498]);
const MAX_RUN_MS = 20 * 60 * 1000;
// Pauses (ms) [min, max, longMin, longMax]. Ozon is stricter: even "fast" keeps modest pauses.
const PACE = {
  wb: { normal: [900, 2200, 3500, 7000], fast: [450, 1000, 1500, 3000] },
  ozon: { normal: [1400, 3000, 4500, 9000], fast: [1100, 2000, 3000, 5500] },
};
const TAB_URL = { wb: ["https://www.wildberries.ru/*", "https://www.wildberries.by/*"],
  ozon: ["https://www.ozon.ru/*", "https://ozon.ru/*", "https://www.ozon.by/*", "https://ozon.by/*"] };

// ---- state (mirrored to storage.session so a restarted worker resumes) ----
let jobs = {};      // tabId -> {tabId, mp, query, target, speed, maxStall, steps, products, stall, lastH, running, reason, startedAt, nextAt}
let alerts = {};    // mp -> {reason, status, url, tabId, ts}
let settings = { pauseAll: true };
const tabQuery = {}; // tabId -> last search query seen on that tab
const timers = {};
const ready = (async () => {
  const d = await chrome.storage.session.get(["jobs", "alerts", "tabQuery"]);
  jobs = d.jobs || {}; alerts = d.alerts || {}; Object.assign(tabQuery, d.tabQuery || {});
  settings = { ...settings, ...((await chrome.storage.local.get("settings")).settings || {}) };
  for (const j of Object.values(jobs)) if (j.running) schedule(j, Math.max(0, (j.nextAt || 0) - Date.now()));
})();
const persist = () => chrome.storage.session.set({ jobs, alerts, tabQuery });

// Serialize read-modify-write: parallel "record" messages used to overwrite each other.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));
const load = async () => (await chrome.storage.local.get(KEY))[KEY] || [];
const sig = (r) => `${r.tab}|${r.url}|${r.status}|${r.body ? r.body.length : 0}|${r.body ? r.body.slice(0, 64) : ""}`;
const rnd = (a, b) => a + Math.random() * (b - a);
const running = (mp) => Object.values(jobs).filter((j) => j.running && (!mp || j.mp === mp));

function badge(recs) {
  if (Object.keys(alerts).length) {
    chrome.action.setBadgeText({ text: "!" }); chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }); return;
  }
  const n = MPS.reduce((a, mp) => a + P.statsFor(recs, mp).products, 0);
  if (!n && updateNewer) { chrome.action.setBadgeText({ text: "↑" }); chrome.action.setBadgeBackgroundColor({ color: "#16a34a" }); return; }
  chrome.action.setBadgeText({ text: n ? (n > 9999 ? "9k+" : String(n)) : "" });
  chrome.action.setBadgeBackgroundColor({ color: running().length ? "#d97706" : "#4f46e5" });
}

// ---- auto-scroll scheduler ----
// Timers live here, not in the page: hidden tabs throttle page timers (1/s, then 1/min), the worker does not.
// An alarm every 30 s re-arms overdue jobs if the worker was restarted.
function schedule(j, ms) {
  clearTimeout(timers[j.tabId]);
  j.nextAt = Date.now() + ms;
  timers[j.tabId] = setTimeout(() => tick(j.tabId), ms);
}
// Keep scrolling tabs from being discarded by Memory Saver (the setting itself is user-only).
const setDiscardable = (tabId, v) => chrome.tabs.update(tabId, { autoDiscardable: v }).catch(() => {});
// Move a tab into its own normal (not minimized) window; bounds optional (tiling).
async function detach(tabId, bounds) {
  try {
    const t = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(t.windowId, { populate: true });
    if (w.tabs.length === 1) { // already alone -> just place/restore it
      await chrome.windows.update(w.id, { state: "normal", ...(bounds || {}) });
      return { tabId, ok: true, windowId: w.id };
    }
    const nw = await chrome.windows.create({ tabId, type: "normal", state: "normal", focused: false, ...(bounds || {}) });
    return { tabId, ok: true, windowId: nw.id };
  } catch (e) { return { tabId, ok: false, error: String(e && e.message || e) }; }
}
// Side-by-side tiles over the available screen area (passed by the popup: screen.avail*).
function tiles(n, scr) {
  if (!scr || !scr.width) return Array(n).fill(null);
  const cols = Math.min(n, 3), rows = Math.ceil(n / cols);
  const w = Math.max(500, Math.floor(scr.width / cols)), h = Math.max(400, Math.floor(scr.height / rows));
  return [...Array(n)].map((_, i) => ({ left: (scr.left || 0) + (i % cols) * w, top: (scr.top || 0) + Math.floor(i / cols) * h, width: w, height: h }));
}
async function detachMany(ids, scr) {
  const b = tiles(ids.length, scr), out = [];
  for (let i = 0; i < ids.length; i++) out.push(await detach(ids[i], b[i]));
  return out;
}

function stopJob(tabId, reason) {
  const j = jobs[tabId];
  clearTimeout(timers[tabId]);
  if (!j) return;
  if (j.running) setDiscardable(tabId, true);
  if (j.running) { j.running = false; j.reason = reason; j.endedAt = Date.now(); }
  persist();
}
const toTab = (tabId, m) => new Promise((ok) => {
  chrome.tabs.sendMessage(tabId, m, (r) => { void chrome.runtime.lastError; ok(r || null); });
});
async function tabProducts(tabId, mp) {
  const recs = (await load()).filter((r) => r.tab === tabId);
  return P.statsFor(recs, mp).products;
}
async function tick(tabId) {
  const j = jobs[tabId];
  if (!j || !j.running) return;
  const al = alerts[j.mp];
  if (al && (settings.pauseAll || al.tabId === tabId)) { stopJob(tabId, "blocked"); return; }
  const r = await toTab(tabId, { type: "scroll_step", hidden_ok: true });
  if (!r) { stopJob(tabId, "tab_gone"); return; }
  if (r.block) { raiseBlock(j.mp, { reason: r.block, url: r.path, tabId }); return; }
  j.steps++;
  j.hidden = !!r.hidden;
  // let the site load: if at bottom and nothing grew yet, wait a bit longer before deciding
  const p = await tabProducts(tabId, j.mp);
  const grew = r.height > j.lastH || p > j.products;
  if (grew) j.stall = 0; else if (r.atBottom) j.stall++;
  j.lastH = r.height; j.products = p;
  if (r.query) j.query = r.query;
  if (j.target && p >= j.target) return stopJob(tabId, "target");
  if (j.stall >= j.maxStall) return stopJob(tabId, "no_new");
  if (Date.now() - j.startedAt > MAX_RUN_MS) return stopJob(tabId, "timeout");
  const [a, b, la, lb] = PACE[j.mp][j.speed === "fast" ? "fast" : "normal"];
  const wait = (r.atBottom && !grew ? rnd(900, 1500) : 0) + (Math.random() < 0.12 ? rnd(la, lb) : rnd(a, b));
  schedule(j, wait);
  persist();
}
async function startJob(tabId, mp, opts) {
  if (alerts[mp]) return { tabId, ok: false, reason: "blocked" };
  if (jobs[tabId] && jobs[tabId].running) return { tabId, ok: true, already: true };
  if (running(mp).length >= MAX_SCROLL_TABS) return { tabId, ok: false, reason: "cap" };
  const ping = await toTab(tabId, { type: "scroll_ping" });
  if (!ping) return { tabId, ok: false, reason: "no_script" };
  jobs[tabId] = { tabId, mp, query: ping.query || tabQuery[tabId] || null, target: opts.target || 0, speed: opts.speed || "normal",
    maxStall: 4, steps: 0, products: await tabProducts(tabId, mp), stall: 0, lastH: ping.height || 0, running: true,
    reason: null, startedAt: Date.now(), title: ping.title || "" };
  setDiscardable(tabId, false);
  schedule(jobs[tabId], rnd(300, 900));
  persist();
  return { tabId, ok: true };
}
function raiseBlock(mp, info) {
  alerts[mp] = { ...info, ts: new Date().toISOString() };
  for (const j of running(mp)) if (settings.pauseAll || j.tabId === info.tabId) stopJob(j.tabId, "blocked");
  persist();
  serial(async () => badge(await load()));
}
chrome.tabs.onRemoved.addListener((id) => { stopJob(id, "tab_gone"); delete tabQuery[id]; persist(); });
chrome.alarms.create("edsip-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "edsip-keepalive") return;
  await ready;
  for (const j of running()) if (!timers[j.tabId] || (j.nextAt || 0) < Date.now() - 2000) schedule(j, 0);
});

// ---- daily update check (token from options; nothing is sent except the GitHub API request) ----
let updateNewer = false;
chrome.storage.local.get("updateInfo").then((d) => { updateNewer = !!(d.updateInfo && d.updateInfo.newer); });
async function scheduleUpdateCheck() {
  const s = (await chrome.storage.local.get("saveSettings")).saveSettings || {};
  if (s.autoCheck === false) chrome.alarms.clear("edsip-update-check");
  else chrome.alarms.create("edsip-update-check", { delayInMinutes: 1, periodInMinutes: 24 * 60 });
}
async function checkUpdate() {
  const { ghToken } = await chrome.storage.local.get("ghToken");
  if (!ghToken) return;
  try {
    const rel = await UPD.latestRelease(ghToken);
    const newer = UPD.cmpVersions(rel.version, chrome.runtime.getManifest().version) > 0;
    updateNewer = newer;
    await chrome.storage.local.set({ updateInfo: { latest: rel.version, url: rel.url, checkedAt: Date.now(), newer } });
    chrome.action.setTitle({ title: newer ? `EDSIP MP Capture — доступна v${rel.version}` : "EDSIP MP Capture" });
    serial(async () => badge(await load()));
  } catch (e) { await chrome.storage.local.set({ updateInfo: { error: String(e.message || e), checkedAt: Date.now() } }); }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "edsip-update-check") checkUpdate(); });
scheduleUpdateCheck();

// ---- messages ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab ? sender.tab.id : null;
  (async () => {
    await ready;
    switch (msg.type) {
      case "update_schedule": await scheduleUpdateCheck(); return reply({ ok: true });
      case "update_badge": {
        const d = (await chrome.storage.local.get("updateInfo")).updateInfo || {};
        updateNewer = !!d.newer; badge(await load()); return reply({ ok: true });
      }
      case "safety":
        return reply({ alerts, settings, cap: MAX_SCROLL_TABS, active: Object.fromEntries(MPS.map((mp) => [mp, running(mp).length])) });
      case "ack_alert": delete alerts[msg.marketplace]; persist(); badge(await load()); return reply({ ok: true });
      case "settings": settings = { ...settings, ...msg.settings }; chrome.storage.local.set({ settings }); return reply(settings);
      case "block": raiseBlock(msg.marketplace, { reason: msg.reason, url: msg.url || null, tabId }); return reply({ ok: true });
      case "jobs": {
        const list = Object.values(jobs).filter((j) => j.running || Date.now() - (j.endedAt || 0) < 10 * 60 * 1000)
          .sort((a, b) => b.startedAt - a.startedAt);
        return reply({ jobs: list, cap: MAX_SCROLL_TABS });
      }
      case "scroll_start": {
        const mp = msg.marketplace;
        let ids = [msg.tabId];
        if (msg.allTabs) {
          const tabs = await chrome.tabs.query({ url: TAB_URL[mp] });
          ids = [msg.tabId, ...tabs.map((t) => t.id).filter((id) => id !== msg.tabId)];
        }
        const results = [];
        for (const id of ids) results.push(await startJob(id, mp, msg));
        serial(async () => badge(await load()));
        let windows = null;
        if (msg.detach) windows = await detachMany(results.filter((r) => r.ok).map((r) => r.tabId), msg.screen);
        return reply({ results, windows, cap: MAX_SCROLL_TABS });
      }
      case "visibility": if (tabId != null && jobs[tabId]) { jobs[tabId].hidden = !!msg.hidden; persist(); } return reply({ ok: true });
      case "detach": return reply(await detach(msg.tabId, msg.bounds));
      case "tile_running": return reply(await detachMany(running(msg.marketplace).map((j) => j.tabId), msg.screen));
      case "scroll_stop": stopJob(msg.tabId, "user"); return reply({ ok: true });
      case "scroll_stop_all": for (const j of running()) stopJob(j.tabId, "user"); return reply({ ok: true });
    }
    serial(async () => {
      const recs = await load();
      if (msg.type === "record") {
        const r = msg.record;
        r.marketplace = P.marketplaceOf(r);
        r.tab = tabId;
        const q = P.queryOf(r);
        if (q && tabId != null) { tabQuery[tabId] = q; persist(); }
        r.query = q || (tabId != null ? tabQuery[tabId] || null : null);
        if (BLOCK_STATUS.has(r.status)) raiseBlock(r.marketplace, { reason: `HTTP ${r.status}`, status: r.status, url: r.url, tabId });
        const s = sig(r); // drop exact duplicates (SPA re-renders often refetch the same page)
        if (recs.slice(-200).some((x) => sig(x) === s)) return reply({ ok: true, dup: true });
        recs.push(r);
        if (recs.length > MAX_RECORDS) recs.splice(0, recs.length - MAX_RECORDS);
        await chrome.storage.local.set({ [KEY]: recs });
        badge(recs);
        reply({ ok: true });
      } else if (msg.type === "stats") {
        const out = {};
        for (const mp of MPS) {
          out[mp] = P.statsFor(recs, mp);
          out[mp].queries = [...new Set(recs.filter((r) => P.marketplaceOf(r) === mp && r.query).map((r) => r.query))];
        }
        out.full = recs.length >= MAX_RECORDS;
        reply(out);
      } else if (msg.type === "export") {
        // One file per (marketplace, query): simultaneous captures in different tabs never mix.
        const mp = MPS.includes(msg.marketplace) ? msg.marketplace : "wb";
        const own = recs.filter((r) => P.marketplaceOf(r) === mp);
        const groups = new Map();
        for (const r of own) { const k = r.query || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
        const files = [...groups.entries()].map(([q, rs]) => {
          const st = P.statsFor(rs, mp);
          if (q) st.query = q;
          const ts = rs.map((r) => r.ts).filter(Boolean).sort();
          return { schema: "edsip-mp-capture/1", marketplace: mp, query: q || null, extension_version: chrome.runtime.getManifest().version,
            captured_at: new Date().toISOString(), run_started_at: ts[0] || null, run_ended_at: ts[ts.length - 1] || null, tabs: [...new Set(rs.map((r) => r.tab).filter((t) => t != null))], stats: st, records: rs };
        });
        reply({ files });
      } else if (msg.type === "clear") {
        const left = msg.marketplace ? recs.filter((r) => P.marketplaceOf(r) !== msg.marketplace) : [];
        await chrome.storage.local.set({ [KEY]: left });
        badge(left);
        reply({ ok: true });
      } else reply({ ok: false });
    });
  })();
  return true;
});
