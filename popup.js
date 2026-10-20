const $ = (id) => document.getElementById(id);
const hasChrome = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
const send = (m) => new Promise((ok) => chrome.runtime.sendMessage(m, ok));

function fileName(query, marketplace) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const q = (query || "noquery").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  const prefix = marketplace === "ozon" ? "ozon" : "wb";
  return `${prefix}_capture_${q}_${date}.json`;
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

async function save(mp) {
  const data = await send({ type: "export", marketplace: mp });
  const files = (data && data.files || []).filter((f) => f.records.length);
  if (!files.length) { msg("Нечего сохранять"); return; }
  const names = [];
  for (const f of files) {
    const url = URL.createObjectURL(new Blob([toPrettyJson(f)], { type: "application/json" }));
    const fn = fileName(f.query || f.stats.query, mp);
    await new Promise((ok) => chrome.downloads.download({ url, filename: fn, saveAs: false, conflictAction: "uniquify" }, () => {
      if (chrome.runtime.lastError) names.push("ошибка: " + chrome.runtime.lastError.message); else names.push(fn);
      setTimeout(() => URL.revokeObjectURL(url), 60000); ok();
    }));
  }
  msg(`Сохранено в «Загрузки»: ${names.join(", ")}`);
}

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
  $("open-perf").onclick = () => chrome.tabs.create({ url: "chrome://settings/performance" });
  $("sc-stopall").onclick = async () => { await send({ type: "scroll_stop_all" }); msg("Все прокрутки остановлены"); refresh(); };
  activeTab().then(refresh);
  setInterval(refresh, 1000);
}
