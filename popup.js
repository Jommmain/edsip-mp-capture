const $ = (id) => document.getElementById(id);
const hasChrome = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
const send = (m) => new Promise((ok) => chrome.runtime.sendMessage(m, ok));

// Legacy helper kept for tests/compat: new naming lives in lib/saving.js.
function fileName(query, marketplace, d = new Date(), run = 1) {
  const S = typeof self !== "undefined" && self.EdsipSaving ? self.EdsipSaving : require("./lib/saving.js");
  return S.fileName(marketplace, query, d, run);
}

// Readable, line-based file: bodies are embedded as JSON objects (not escaped strings), 1-space indent.
function toPrettyJson(data) {
  const records = data.records.map((r) => {
    let body = r.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { /* keep string */ } }
    return { ...r, body };
  });
  return JSON.stringify({ ...data, format: "pretty-1", records }, null, 1) + "\n";
}
if (typeof module !== "undefined") module.exports = { toPrettyJson, fileName };

const msg = (t) => { $("msg").textContent = t; };
let tabId = null, tabMp = null;
const REASONS = { target: "цель достигнута", no_new: "новых товаров нет", user: "остановлено", timeout: "лимит 20 мин",
  blocked: "блокировка", cap: "лимит вкладок", no_script: "обновите вкладку (F5)", tab_gone: "вкладка закрыта" };
const MPN = { wb: "WB", ozon: "Ozon" };
const scr = () => (typeof screen !== "undefined" ? { left: screen.availLeft || 0, top: screen.availTop || 0, width: screen.availWidth, height: screen.availHeight } : null);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t || !t.url) return;
  tabId = t.id;
  if (/^https:\/\/www\.wildberries\.(ru|by)\//.test(t.url)) tabMp = "wb";
  else if (/^https:\/\/(www\.)?ozon\.(ru|by)\//.test(t.url)) tabMp = "ozon";
}

function renderJobs(list) {
  $("jobs").innerHTML = list.map((j) => {
    const pct = j.target ? Math.min(100, (100 * j.products) / j.target) : (j.running ? 50 : 100);
    const st = j.running ? `шагов ${j.steps}` : (REASONS[j.reason] || j.reason || "");
    return `<div class="job ${j.running ? "" : "done"} ${j.reason === "blocked" ? "blk" : ""}">
      <div class="row"><span class="badge ${j.mp}">${MPN[j.mp]}</span><span class="q">${esc(j.query || j.title || "вкладка " + j.tabId)}</span>
      ${j.running ? `<button class="ghost" data-stop="${j.tabId}">Стоп</button>` : ""}</div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="muted">товаров ${j.products}${j.target ? " из " + j.target : ""} · ${esc(st)}${j.speed === "fast" ? " · быстро" : ""}${j.tabId === tabId ? " · эта вкладка" : ""}</div>
      ${j.running && j.hidden ? `<div class="hidwarn">⚠ Вкладка скрыта — сайт может не догружать товары <button class="ghost" data-detach="${j.tabId}">Вынести в окно</button></div>` : ""}</div>`;
  }).join("");
  $("jobs").querySelectorAll("[data-detach]").forEach((b) => { b.onclick = async () => {
    const r = await send({ type: "detach", tabId: +b.dataset.detach });
    msg(r && r.ok ? "Вкладка вынесена в отдельное окно" : `Не удалось: ${r && r.error}`); refresh(); }; });
  $("jobs").querySelectorAll("[data-stop]").forEach((b) => { b.onclick = async () => { await send({ type: "scroll_stop", tabId: +b.dataset.stop }); refresh(); }; });
}

async function refresh() {
  const s = await send({ type: "stats" });
  if (!s) return;
  for (const mp of ["wb", "ozon"]) {
    const card = $(`card-${mp}`), st = s[mp];
    const set = (k, v) => card.querySelectorAll(`[data-k="${k}"]`).forEach((e) => { e.textContent = v; });
    for (const k of ["query", "host", "products", "pages", "cards", "total", "dest", "curr"]) set(k, st[k] ?? "—");
    set("ads", st.products ? `${st.ads} · ${Math.round((100 * st.ads) / st.products)}%` : st.ads);
    set("blk", `${st.blocked}/${st.redirects}`);
    set("nq", (st.queries || []).length);
    card.querySelector(".save").disabled = !st.total;
    card.querySelector(".save").textContent = (st.queries || []).length > 1 ? `Сохранить (${st.queries.length} файла)` : "Сохранить";
    card.classList.toggle("active", tabMp === mp);
    card.classList.toggle("dim", !st.total && tabMp !== mp);
  }
  if (s.full) msg("Достигнут лимит 3000 записей — сохраните и очистите.");
  const sf = await send({ type: "safety" });
  const jb = await send({ type: "jobs" });
  const al = Object.entries(sf.alerts || {});
  $("alert").hidden = !al.length;
  $("alert-txt").textContent = al.map(([mp, a]) => `${MPN[mp]}: ${a.reason} (${new Date(a.ts).toLocaleTimeString("ru-RU")}). Автопрокрутка остановлена. Сделайте паузу, пройдите проверку вручную, если она есть.`).join(" ");
  $("alert-ok").dataset.mps = al.map(([mp]) => mp).join(",");
  $("sc-all").checked = sf.settings.pauseAll !== false;
  const total = sf.active.wb + sf.active.ozon;
  $("sc-cap").textContent = `WB ${sf.active.wb}/${sf.cap} · Ozon ${sf.active.ozon}/${sf.cap}`;
  $("sc-cap").className = "small " + (tabMp && sf.active[tabMp] >= sf.cap ? "warn" : "muted");
  const mine = jb.jobs.find((j) => j.tabId === tabId && j.running);
  $("sc-start").disabled = !tabMp || !!mine || (tabMp && sf.active[tabMp] >= sf.cap && !$("sc-alltabs").checked) || !!sf.alerts[tabMp];
  $("sc-stopall").disabled = !total;
  $("win-cur").disabled = tabId == null;
  $("win-tile").disabled = !tabMp || !sf.active[tabMp];
  renderJobs(jb.jobs);
  const pill = $("state");
  if (al.length) { pill.className = "pill run"; pill.textContent = "⚠ Блокировка"; }
  else if (!tabMp) { pill.className = "pill idle"; pill.textContent = total ? `Прокрутка: ${total}` : "Не WB/Ozon"; }
  else if (mine) { pill.className = "pill run"; pill.textContent = "Автопрокрутка"; }
  else { pill.className = "pill on"; pill.textContent = `Захват ${MPN[tabMp]}`; }
}

const SV = typeof self !== "undefined" ? self.EdsipSaving : null;
const HS = typeof self !== "undefined" ? self.EdsipHandles : null;
async function saveSettings() { return { ...SV.DEFAULTS, ...((await chrome.storage.local.get("saveSettings")).saveSettings || {}) }; }
async function pushHistory(items) {
  const h = (await chrome.storage.local.get("saveHistory")).saveHistory || [];
  await chrome.storage.local.set({ saveHistory: [...items, ...h].slice(0, 30) });
}
const dlSearch = (id) => new Promise((ok) => chrome.downloads.search({ id }, (r) => ok((r && r[0]) || null)));
async function waitDownload(id) {
  for (let i = 0; i < 40; i++) {
    const d = await dlSearch(id);
    if (d && d.state !== "in_progress") return d;
    await new Promise((r) => setTimeout(r, 150));
  }
  return dlSearch(id);
}
async function saveViaFs(dirRoot, f, mp, st, now) {
  let dir = dirRoot;
  if (st.perMarketplace) dir = await dir.getDirectoryHandle(mp, { create: true });
  const exists = async (n) => { try { await dir.getFileHandle(n); return true; } catch (e) { return false; } };
  const name = await SV.freeName(mp, f.query || f.stats.query, now, exists);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(toPrettyJson(f)); await w.close();
  return { name, path: `${dirRoot.name}/${st.perMarketplace ? mp + "/" : ""}${name}`, mode: "fs" };
}
async function saveViaDownloads(f, mp, st, now, hist) {
  const sub = SV.subPath(st, mp);
  const taken = new Set(hist.map((h) => h.rel));
  const name = await SV.freeName(mp, f.query || f.stats.query, now, (n) => taken.has((sub ? sub + "/" : "") + n));
  const rel = (sub ? sub + "/" : "") + name;
  const url = URL.createObjectURL(new Blob([toPrettyJson(f)], { type: "application/json" }));
  try {
    const id = await new Promise((ok, bad) => chrome.downloads.download({ url, filename: rel, saveAs: false, conflictAction: "uniquify" },
      (i) => (chrome.runtime.lastError ? bad(new Error(chrome.runtime.lastError.message)) : ok(i))));
    const d = await waitDownload(id);
    const full = (d && d.filename) || rel;
    return { name: full.split(/[\\/]/).pop(), path: full, rel, mode: "downloads" };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
async function save(mp) {
  const data = await send({ type: "export", marketplace: mp });
  const files = (data && data.files || []).filter((f) => f.records.length);
  if (!files.length) { msg("Нечего сохранять"); return; }
  const st = await saveSettings();
  const hist = (await chrome.storage.local.get("saveHistory")).saveHistory || [];
  let dir = null, note = "";
  if (st.mode === "fs") {
    dir = await HS.get("saveDir").catch(() => null);
    if (dir && (await HS.permission(dir, true).catch(() => "denied")) !== "granted") { dir = null; note = " (нет доступа к папке — сохранено в «Загрузки»)"; }
    if (!dir && !note) note = " (папка не выбрана — сохранено в «Загрузки»)";
  }
  const done = [];
  for (const f of files) {
    const now = new Date();
    f.saved_at = now.toISOString();
    try {
      const r = dir ? await saveViaFs(dir, f, mp, st, now) : await saveViaDownloads(f, mp, st, now, [...hist, ...done]);
      done.push({ ...r, mp, query: f.query, records: f.records.length, ts: now.toISOString() });
    } catch (e) { msg(`Ошибка сохранения: ${e.message}`); }
  }
  await pushHistory(done.slice().reverse());
  if (done.length) msg(`Сохранено: ${done.map((d) => d.name).join(", ")}${note}`);
  renderHistory();
}
async function renderHistory() {
  const h = (await chrome.storage.local.get("saveHistory")).saveHistory || [];
  $("hist").innerHTML = h.slice(0, 8).map((x) => `<li title="${esc(x.path)}"><b>${esc(x.name)}</b><span>${new Date(x.ts).toLocaleString("ru-RU")} · ${x.records} зап. · ${esc(x.mode === "fs" ? x.path : "Загрузки: " + x.path)}</span></li>`).join("")
    || '<li class="muted">Пока ничего не сохранено</li>';
}
async function checkUpdates(manual) {
  const U = self.EdsipUpdater, v = chrome.runtime.getManifest().version;
  const { ghToken } = await chrome.storage.local.get("ghToken");
  if (!ghToken) { $("upd-msg").innerHTML = `Нужен токен в <a href="#" id="go-opt">настройках</a> или в Терминале: <code>${U.TERMINAL_CMD}</code>`; bindOpt(); return; }
  $("upd-msg").textContent = "Проверяю…";
  try {
    const r = await U.latestRelease(ghToken);
    const newer = U.cmpVersions(r.version, v) > 0;
    await chrome.storage.local.set({ updateInfo: { latest: r.version, url: r.url, checkedAt: Date.now(), newer } });
    send({ type: "update_badge" });
    showUpdate(newer, r.version, v);
  } catch (e) { $("upd-msg").innerHTML = `Ошибка: ${esc(e.message)}. Терминал: <code>${U.TERMINAL_CMD}</code>`; }
}
function showUpdate(newer, latestV, v) {
  $("upd-go").hidden = !newer;
  if (newer) { $("upd-go").textContent = `Обновить до v${latestV}`; $("upd-msg").textContent = `Доступна v${latestV} (у вас v${v})`; }
  else $("upd-msg").textContent = `Последняя версия: v${v}`;
}
function bindOpt() { const a = $("go-opt"); if (a) a.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); }; }

if (hasChrome && typeof document !== "undefined" && $("card-wb")) {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  for (const mp of ["wb", "ozon"]) {
    const card = $(`card-${mp}`);
    card.querySelector(".save").onclick = () => save(mp);
    card.querySelector(".clear").onclick = async () => {
      if (!confirm(`Удалить собранные данные ${MPN[mp]}?`)) return;
      await send({ type: "clear", marketplace: mp }); msg("Очищено"); refresh();
    };
  }
  $("sc-target").value = localStorage.getItem("edsipTarget") || "300";
  $("sc-speed").value = localStorage.getItem("edsipSpeed") || "normal";
  $("sc-alltabs").checked = localStorage.getItem("edsipAllTabs") === "1";
  $("sc-alltabs").onchange = (e) => { localStorage.setItem("edsipAllTabs", e.target.checked ? "1" : "0"); refresh(); };
  $("sc-all").onchange = (e) => send({ type: "settings", settings: { pauseAll: e.target.checked } });
  $("alert-ok").onclick = async () => {
    for (const mp of ($("alert-ok").dataset.mps || "").split(",").filter(Boolean)) await send({ type: "ack_alert", marketplace: mp });
    refresh();
  };
  $("sc-start").onclick = async () => {
    const target = Math.max(0, parseInt($("sc-target").value, 10) || 0), speed = $("sc-speed").value;
    localStorage.setItem("edsipTarget", String(target)); localStorage.setItem("edsipSpeed", speed);
    const r = await send({ type: "scroll_start", tabId, marketplace: tabMp, target, speed, allTabs: $("sc-alltabs").checked,
      detach: $("sc-detach").checked, screen: scr() });
    const ok = r.results.filter((x) => x.ok && !x.already).length;
    const bad = r.results.filter((x) => !x.ok);
    const why = [...new Set(bad.map((x) => REASONS[x.reason] || x.reason))].join(", ");
    msg(`Запущено вкладок: ${ok}` + (bad.length ? `; пропущено ${bad.length} (${why})` : "")
      + (bad.some((x) => x.reason === "cap") ? ` — не больше ${r.cap} вкладок на маркетплейс` : ""));
    refresh();
  };
  $("sc-detach").checked = localStorage.getItem("edsipDetach") === "1";
  $("sc-detach").onchange = (e) => localStorage.setItem("edsipDetach", e.target.checked ? "1" : "0");
  $("win-cur").onclick = async () => {
    const r = await send({ type: "detach", tabId });
    msg(r && r.ok ? "Вкладка открыта в отдельном окне" : `Не удалось: ${r && r.error}`);
  };
  $("win-tile").onclick = async () => {
    const r = await send({ type: "tile_running", marketplace: tabMp, screen: scr() });
    msg(r && r.length ? `Разложено окон: ${r.filter((x) => x.ok).length}` : "Нет прокручиваемых вкладок этого маркетплейса");
  };
  const reload = () => {
    if (!confirm("Перезагрузить расширение? Собранные данные сохранятся, автопрокрутка остановится. После — F5 на вкладках WB/Ozon.")) return;
    chrome.runtime.reload();
  };
  $("reload").onclick = reload; $("reload2").onclick = reload;
  $("open-opt").onclick = () => chrome.runtime.openOptionsPage();
  $("upd-check").onclick = () => checkUpdates(true);
  $("upd-go").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#update") });
  chrome.storage.local.get("updateInfo").then(({ updateInfo: u }) => { if (u && u.latest) showUpdate(u.newer, u.latest, chrome.runtime.getManifest().version); });
  renderHistory();
  $("open-perf").onclick = () => chrome.tabs.create({ url: "chrome://settings/performance" });
  $("sc-stopall").onclick = async () => { await send({ type: "scroll_stop_all" }); msg("Все прокрутки остановлены"); refresh(); };
  activeTab().then(refresh);
  setInterval(refresh, 1000);
}
