// Self-update from GitHub Releases (public repo; optional read-only token only to avoid API rate limits) into the unpacked folder.
(function (root) {
  const REPO = "Jommmain/edsip-mp-capture";
  const ASSET = /^edsip-mp-capture-[\d.]+\.zip$/;
  const EXT_NAME = "EDSIP MP Capture";
  const KEEP = new Set([".git", ".prev", ".DS_Store", "tests", "dist"]); // never touched in the folder
  // Release signing key (ed25519, public part only). The private key never enters the repo; releases publish
  // SHA256SUMS + SHA256SUMS.sig (raw 64-byte ed25519 signature over SHA256SUMS). Update is refused unless both verify.
  const PUBLIC_KEY_B64 = "wbfEmzJBhUR+4mXGf+27TS/gEq9B1ToB70rImmzTft4=";
  // Only these paths may be written by a self-update (anything else in the archive aborts the update).
  const ALLOWED_PATH = /^(manifest\.json|README\.md|[a-z_]+\.(js|html|css)|lib\/[a-z_]+\.js|icons\/icon(16|32|48|128)\.png)$/;

  function cmpVersions(a, b) {
    const x = String(a).replace(/^v/, "").split(".").map(Number), y = String(b).replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  }
  async function latestRelease(token, fetchFn = fetch) {
    const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: h, cache: "no-store" });
    if (r.status === 401) throw new Error("токен GitHub недействителен — удалите его в настройках (он не обязателен)");
    if ((r.status === 403 || r.status === 429) && !token) throw new Error("лимит GitHub API без авторизации исчерпан — подождите час или добавьте токен в настройках");
    if (r.status === 404) throw new Error("релиз не найден");
    if (!r.ok) throw new Error(`GitHub API: HTTP ${r.status}`);
    const j = await r.json();
    const pickA = (pred) => { const a = (j.assets || []).find(pred); return a ? { name: a.name, api_url: a.url, size: a.size } : null; };
    return { version: String(j.tag_name || "").replace(/^v/, ""), url: j.html_url, notes: j.body || "",
      asset: pickA((a) => ASSET.test(a.name)), sums: pickA((a) => a.name === "SHA256SUMS"), sig: pickA((a) => a.name === "SHA256SUMS.sig") };
  }
  async function downloadAsset(asset, token, fetchFn = fetch) {
    // asset API url + octet-stream -> 302 to a signed release-assets host; Authorization is not forwarded cross-origin.
    const r = await fetchFn(asset.api_url, { headers: { Accept: "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!r.ok) throw new Error(`скачивание: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
  // 1) ed25519 signature of SHA256SUMS with the pinned key; 2) sha256(zip) equals the line for the zip name.
  async function verifyRelease(zipBytes, zipName, sumsBytes, sigBytes, publicKeyB64 = PUBLIC_KEY_B64) {
    if (!sumsBytes || !sigBytes) throw new Error("в релизе нет SHA256SUMS/SHA256SUMS.sig — обновление отменено");
    let key;
    try { key = await crypto.subtle.importKey("raw", b64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]); }
    catch (e) { throw new Error("браузер не поддерживает Ed25519 (нужен Chrome 137+) — обновите через Терминал"); }
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, sumsBytes))) throw new Error("подпись SHA256SUMS неверна — обновление отменено");
    const line = new TextDecoder().decode(sumsBytes).split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/)).find((p) => p[1] === zipName);
    if (!line || !/^[0-9a-f]{64}$/.test(line[0])) throw new Error(`в SHA256SUMS нет строки для ${zipName}`);
    const got = hex(await crypto.subtle.digest("SHA-256", zipBytes));
    if (got !== line[0]) throw new Error("sha256 архива не совпадает с SHA256SUMS — обновление отменено");
    return { sha256: got };
  }
  async function readText(dir, name) {
    try { const fh = await dir.getFileHandle(name); return await (await fh.getFile()).text(); } catch (e) { return null; }
  }
  // The granted folder must be THIS extension: manifest.json with our name.
  async function verifyExtDir(dir) {
    const t = await readText(dir, "manifest.json");
    if (!t) return { ok: false, reason: "в папке нет manifest.json" };
    let m; try { m = JSON.parse(t); } catch (e) { return { ok: false, reason: "manifest.json повреждён" }; }
    if (m.name !== EXT_NAME) return { ok: false, reason: `это не папка «${EXT_NAME}» (name: ${m.name})` };
    let git = false; try { await dir.getDirectoryHandle(".git"); git = true; } catch (e) { /* none */ }
    return { ok: true, version: m.version, git };
  }
  async function writeFile(dir, path, data) {
    const parts = path.split("/"); let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(data); await w.close();
  }
  async function copyTree(src, dst, skip) {
    for await (const [name, h] of src.entries()) {
      if (skip.has(name)) continue;
      if (h.kind === "file") await writeFile(dst, name, await (await h.getFile()).arrayBuffer());
      else await copyTree(h, await dst.getDirectoryHandle(name, { create: true }), new Set());
    }
  }
  // Apply unzipped files: backup current -> .prev/, remove old entries absent in the new release, write new files.
  async function applyUpdate(dir, files) {
    const man = files["manifest.json"];
    if (!man) throw new Error("в архиве нет manifest.json");
    const m = JSON.parse(new TextDecoder().decode(man));
    if (m.manifest_version !== 3 || m.name !== EXT_NAME) throw new Error("архив не похож на EDSIP MP Capture (MV3)");
    const bad = Object.keys(files).filter((p) => !ALLOWED_PATH.test(p));
    if (bad.length) throw new Error("в архиве недопустимые файлы: " + bad.slice(0, 5).join(", "));
    try { await dir.removeEntry(".prev", { recursive: true }); } catch (e) { /* none */ }
    const prev = await dir.getDirectoryHandle(".prev", { create: true });
    await copyTree(dir, prev, KEEP);
    const top = new Set(Object.keys(files).map((p) => p.split("/")[0]));
    const old = [];
    for await (const [name] of dir.entries()) if (!KEEP.has(name) && !top.has(name)) old.push(name);
    for (const name of old) await dir.removeEntry(name, { recursive: true });
    for (const [p, data] of Object.entries(files)) await writeFile(dir, p, data);
    return { version: m.version, written: Object.keys(files).length, removed: old };
  }
  const TERMINAL_CMD = "bash ~/EDSIP/update-extension.sh";
  const api = { REPO, EXT_NAME, PUBLIC_KEY_B64, ALLOWED_PATH, verifyRelease, cmpVersions, latestRelease, downloadAsset, verifyExtDir, applyUpdate, writeFile, TERMINAL_CMD };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipUpdater = api;
})(typeof self !== "undefined" ? self : this);
