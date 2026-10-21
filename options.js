const $ = (id) => document.getElementById(id);
const S = self.EdsipSaving, H = self.EdsipHandles, U = self.EdsipUpdater, Z = self.EdsipUnzip;
const log = (t, cls) => { const e = $("upd-log"); e.textContent += t + "\n"; e.className = cls || ""; };
const getSettings = async () => ({ ...S.DEFAULTS, ...((await chrome.storage.local.get("saveSettings")).saveSettings || {}) });
const version = chrome.runtime.getManifest().version;
let latest = null;

function example() {
  const sub = $("perMarketplace").checked ? "ozon/" : "";
  $("example").textContent = sub + S.fileName("ozon", "корм для кошек", new Date(), 1);
}
async function showDirs() {
  const sd = await H.get("saveDir"), ed = await H.get("extDir");
  $("save-dir").textContent = sd ? `📁 ${sd.name} (${await H.permission(sd, false)})` : "не выбрана";
  $("ext-dir").textContent = ed ? `📁 ${ed.name} (${await H.permission(ed, false)})` : "не указана";
}
async function init() {
  $("ver").textContent = "версия " + version;
  const s = await getSettings();
  document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  $("subfolder").value = s.subfolder; $("perMarketplace").checked = !!s.perMarketplace; $("autoCheck").checked = s.autoCheck !== false;
  const { ghToken } = await chrome.storage.local.get("ghToken");
  $("token").placeholder = ghToken ? "токен сохранён (••••)" : "необязательно: github_pat_…";
  example(); showDirs();
  if (location.hash === "#update") { $("update").scrollIntoView(); check(); }
}
$("perMarketplace").onchange = example;
$("save-settings").onclick = async () => {
  const mode = document.querySelector("input[name=mode]:checked").value;
  if (mode === "fs" && !(await H.get("saveDir"))) { $("save-msg").className = "err"; $("save-msg").textContent = "Сначала выберите папку"; return; }
  const s = { ...(await getSettings()), mode, subfolder: S.cleanSubfolder($("subfolder").value), perMarketplace: $("perMarketplace").checked,
    autoCheck: $("autoCheck").checked };
  $("subfolder").value = s.subfolder;
  await chrome.storage.local.set({ saveSettings: s });
  chrome.runtime.sendMessage({ type: "update_schedule" });
  $("save-msg").className = "ok"; $("save-msg").textContent = "Сохранено";
};
$("autoCheck").onchange = () => $("save-settings").click();
$("pick-save").onclick = async () => {
  try {
    const h = await showDirectoryPicker({ id: "edsip-save", mode: "readwrite" });
    await H.set("saveDir", h);
    document.querySelector("input[name=mode][value=fs]").checked = true;
    showDirs();
  } catch (e) { if (e.name !== "AbortError") alert(e.message); }
};
$("save-token").onclick = async () => {
  const t = $("token").value.trim();
  if (!t) return;
  await chrome.storage.local.set({ ghToken: t }); $("token").value = ""; $("token").placeholder = "токен сохранён (••••)";
};
$("del-token").onclick = async () => { await chrome.storage.local.remove("ghToken"); $("token").placeholder = "необязательно: github_pat_…"; };
$("pick-ext").onclick = async () => {
  try {
    const h = await showDirectoryPicker({ id: "edsip-ext", mode: "readwrite" });
    const v = await U.verifyExtDir(h);
    if (!v.ok) { alert("Не подходит: " + v.reason); return; }
    if (v.version !== version) alert(`В папке версия ${v.version}, а запущена ${version}. Проверьте, что это папка из chrome://extensions.`);
    if (v.git) alert("Это git-клон: обновляйте через git pull. Папка сохранена, но обновление из окна будет отключено.");
    await H.set("extDir", h); showDirs();
  } catch (e) { if (e.name !== "AbortError") alert(e.message); }
};

async function check() {
  $("upd-log").textContent = ""; $("apply").hidden = true;
  const { ghToken } = await chrome.storage.local.get("ghToken");
  try {
    latest = await U.latestRelease(ghToken);
    await chrome.storage.local.set({ updateInfo: { latest: latest.version, checkedAt: Date.now(), newer: U.cmpVersions(latest.version, version) > 0 } });
    chrome.runtime.sendMessage({ type: "update_badge" });
    if (U.cmpVersions(latest.version, version) <= 0) { log(`Установлена последняя версия ${version}.`, "ok"); return; }
    log(`Доступна версия ${latest.version} (у вас ${version}). ${latest.url}`);
    if (!latest.asset) { log("В релизе нет zip-файла.", "err"); return; }
    $("apply").hidden = false; $("apply").textContent = `Обновить до v${latest.version}`;
  } catch (e) { log(`Ошибка: ${e.message}\nОбновление из Терминала: ${U.TERMINAL_CMD}`, "err"); }
}
$("check").onclick = check;
$("apply").onclick = async () => {
  const { ghToken } = await chrome.storage.local.get("ghToken");
  const dir = await H.get("extDir");
  if (!dir) { log(`Не указана папка расширения. Укажите её выше или выполните: ${U.TERMINAL_CMD}`, "err"); return; }
  if ((await H.permission(dir, true)) !== "granted") { log("Нет доступа к папке — разрешите доступ или используйте Терминал.", "err"); return; }
  const v = await U.verifyExtDir(dir);
  if (!v.ok) { log("Папка не подходит: " + v.reason, "err"); return; }
  if (v.git) { log("Папка — git-клон: выполните git pull и нажмите ⟳.", "err"); return; }
  $("apply").disabled = true;
  try {
    log(`Скачиваю ${latest.asset.name}…`);
    const zip = await U.downloadAsset(latest.asset, ghToken);
    const sums = latest.sums ? await U.downloadAsset(latest.sums, ghToken) : null;
    const sig = latest.sig ? await U.downloadAsset(latest.sig, ghToken) : null;
    const v = await U.verifyRelease(zip, latest.asset.name, sums, sig);
    log(`Подпись и sha256 проверены (${v.sha256.slice(0, 12)}…).`, "ok");
    const files = await Z.unzip(zip);
    log(`Файлов в архиве: ${Object.keys(files).length}. Резервная копия → .prev/`);
    const r = await U.applyUpdate(dir, files);
    log(`Записано ${r.written} файлов${r.removed.length ? ", удалено устаревших: " + r.removed.join(", ") : ""}. Перезапуск…`, "ok");
    setTimeout(() => chrome.runtime.reload(), 800);
  } catch (e) {
    log(`Ошибка обновления: ${e.message}. Если файлы повреждены — восстановите из .prev/ или: ${U.TERMINAL_CMD}`, "err");
    $("apply").disabled = false;
  }
};
init();
