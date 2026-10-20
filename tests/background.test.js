// node tests/background.test.js — scheduler (per-tab jobs, cap 3, all-tabs start), safety (429/captcha, pause-all),
// per-tab/query tagging and per-query export. Chrome APIs are mocked; worker timers are sped up.
const assert = require("assert"), fs = require("fs"), vm = require("vm"), path = require("path");
const store = {}, sess = {}, sent = [], wins = [], wupd = [], upd = [];
let listener;
const area = (o) => ({ get: async (k) => { const r = {}; for (const x of [].concat(k)) if (x in o) r[x] = o[x]; return r; }, set: async (v) => Object.assign(o, v) });
const page = {}; // tabId -> {height, block, query}
const chrome = { storage: { local: area(store), session: area(sess) },
  runtime: { onMessage: { addListener: (f) => { listener = f; } }, getManifest: () => ({ version: "0.4.0" }), lastError: null },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  windows: { create: async (o) => { wins.push(o); return { id: 900 + wins.length }; },
    get: async (id) => ({ id, tabs: id === 1 ? [{}, {}] : [{}] }), update: async (id, o) => { wupd.push([id, o]); return {}; } },
  tabs: { onRemoved: { addListener() {} }, get: async (id) => ({ id, windowId: id === 99 ? 2 : 1 }),
    update: (id, o) => { upd.push([id, o.autoDiscardable]); return Promise.resolve(); },
    query: async () => [11, 14, 12, 13, 15].map((id) => ({ id })),
    sendMessage: (t, m, cb) => { sent.push([t, m.type]); const pg = page[t];
      if (!pg) return cb(null);
      if (m.type === "scroll_ping") return cb({ query: pg.query, height: pg.height });
      if (m.type === "scroll_step") { pg.height += 500; return cb({ height: pg.height, atBottom: false, block: pg.block || null, query: pg.query }); }
      cb(null); } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} } };
const ctx = { chrome, URL, JSON, Date, Promise, console, Math, self: {}, setTimeout: (f) => setTimeout(f, 5), clearTimeout };
ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx);
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx);
const call = (msg, tab) => new Promise((ok) => listener(msg, { tab: tab == null ? undefined : { id: tab } }, ok));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ozUrl = (inner) => "https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=" + encodeURIComponent(inner);
let tsn = 0;
const ozRec = (q, skus, status = 200) => ({ ts: `2026-10-20T10:00:0${tsn++}Z`, url: ozUrl(`/search/?text=${q}`), kind: "ozon_page", status,
  body: status === 200 ? JSON.stringify({ widgetStates: { "searchResultsV2-1": JSON.stringify({ items: skus.map((sku) => ({ sku })) }) } }) : null });

(async () => {
  for (const [id, q] of [[11, "корм"], [12, "наполнитель"], [13, "лакомство"], [15, "игрушка"]]) page[id] = { height: 1000, query: q };
  // records from two tabs at once: tagged by tab + query, not mixed
  await call({ type: "record", record: ozRec("корм", [1, 2, 3]) }, 11);
  await call({ type: "record", record: ozRec("наполнитель", [7, 8]) }, 12);
  await call({ type: "record", record: { url: ozUrl("/product/x-123456/"), kind: "ozon_page", status: 200, body: "{}" } }, 11);
  const ex = await call({ type: "export", marketplace: "ozon" });
  const byQ = Object.fromEntries(ex.files.map((f) => [f.query, f]));
  assert.deepStrictEqual(Object.keys(byQ).sort(), ["корм", "наполнитель"]);
  assert.strictEqual(byQ["корм"].run_started_at, "2026-10-20T10:00:00Z");
  assert.strictEqual(byQ["наполнитель"].run_ended_at, "2026-10-20T10:00:01Z");
  assert.strictEqual(byQ["корм"].extension_version, "0.4.0");
  assert.strictEqual(byQ["корм"].records.length, 2); // product page inherits the tab's query
  assert.strictEqual(byQ["корм"].stats.products, 3); assert.strictEqual(byQ["наполнитель"].stats.products, 2);
  assert.strictEqual(JSON.stringify(byQ["корм"].tabs), "[11]");
  assert.ok(byQ["корм"].records.every((r) => r.tab === 11 && r.query === "корм"));

  // start in all Ozon tabs: 14 has no content script, cap 3 leaves 15 out
  const st = await call({ type: "scroll_start", tabId: 11, marketplace: "ozon", target: 0, speed: "fast", allTabs: true });
  const res = Object.fromEntries(st.results.map((r) => [r.tabId, r.ok ? "ok" : r.reason]));
  assert.deepStrictEqual(res, { 11: "ok", 12: "ok", 13: "ok", 14: "no_script", 15: "cap" });
  await wait(60);
  let jobs = (await call({ type: "jobs" })).jobs;
  assert.strictEqual(jobs.filter((j) => j.running).length, 3);
  assert.ok(jobs.every((j) => j.steps > 0)); // independent progress per tab, driven by worker timers
  assert.strictEqual(jobs.find((j) => j.tabId === 12).query, "наполнитель");
  // per-tab stop frees a slot
  await call({ type: "scroll_stop", tabId: 13 });
  assert.ok((await call({ type: "scroll_start", tabId: 15, marketplace: "ozon" })).results[0].ok);
  // WB has its own cap
  page[21] = { height: 1000, query: "a" };
  assert.ok((await call({ type: "scroll_start", tabId: 21, marketplace: "wb" })).results[0].ok);

  // 429 on Ozon -> all Ozon tabs stop (pause-all), WB keeps going; restart refused until acknowledged
  await call({ type: "record", record: ozRec("корм", [], 429) }, 12);
  await wait(30);
  let sf = await call({ type: "safety" });
  assert.strictEqual(sf.alerts.ozon.reason, "HTTP 429"); assert.strictEqual(sf.active.ozon, 0); assert.strictEqual(sf.active.wb, 1);
  assert.strictEqual((await call({ type: "scroll_start", tabId: 11, marketplace: "ozon" })).results[0].reason, "blocked");
  await call({ type: "ack_alert", marketplace: "ozon" });
  assert.ok((await call({ type: "scroll_start", tabId: 11, marketplace: "ozon" })).results[0].ok);

  // captcha detected by the page step, pause-all off -> only that tab stops
  await call({ type: "settings", settings: { pauseAll: false } });
  await call({ type: "scroll_start", tabId: 12, marketplace: "ozon" });
  page[12].block = "капча";
  await wait(40);
  jobs = (await call({ type: "jobs" })).jobs;
  assert.strictEqual(jobs.find((j) => j.tabId === 12).reason, "blocked");
  assert.ok(jobs.find((j) => j.tabId === 11).running, JSON.stringify(jobs.find((j) => j.tabId === 11)));
  await call({ type: "ack_alert", marketplace: "ozon" });

  // stop all
  await call({ type: "scroll_stop_all" });
  sf = await call({ type: "safety" });
  assert.strictEqual(sf.active.ozon + sf.active.wb, 0);

  // target reached stops the job
  await call({ type: "scroll_start", tabId: 11, marketplace: "ozon", target: 3 });
  await wait(40);
  assert.strictEqual((await call({ type: "jobs" })).jobs.find((j) => j.tabId === 11).reason, "target");
  // autoDiscardable: false while scrolling, true after stop
  assert.ok(upd.some(([id, v]) => id === 11 && v === false) && upd.some(([id, v]) => id === 11 && v === true));
  // start in all tabs + detach into tiled windows (3 columns over 1920x1040)
  await call({ type: "scroll_stop_all" });
  const d = await call({ type: "scroll_start", tabId: 11, marketplace: "ozon", allTabs: true, detach: true,
    screen: { left: 0, top: 0, width: 1920, height: 1040 } });
  assert.strictEqual(d.windows.length, 3);
  assert.strictEqual(JSON.stringify(wins.map((w) => [w.tabId, w.left, w.width, w.state, w.focused])),
    JSON.stringify([[11, 0, 640, "normal", false], [12, 640, 640, "normal", false], [13, 1280, 640, "normal", false]]));
  // single detach; a tab already alone in its window is only restored/moved
  assert.ok((await call({ type: "detach", tabId: 99 })).ok);
  assert.strictEqual(wupd[0][0], 2); assert.strictEqual(wupd[0][1].state, "normal");
  // visibility flag reaches the job list
  await call({ type: "visibility", hidden: true }, 12);
  assert.strictEqual((await call({ type: "jobs" })).jobs.find((j) => j.tabId === 12).hidden, true);
  console.log("background.test.js: OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
