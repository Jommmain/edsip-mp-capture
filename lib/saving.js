// Pure helpers for file naming / save paths (popup, options, node tests).
(function (root) {
  const pad = (n) => String(n).padStart(2, "0");
  function slug(s, max = 60) {
    return (s || "noquery").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, max) || "noquery";
  }
  // <marketplace>_<query>_<YYYY-MM-DD>_<HH-MM-SS>[_runN].json, local time
  function baseName(mp, query, d) {
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${mp === "ozon" ? "ozon" : "wb"}_${slug(query)}_${date}_${time}`;
  }
  function fileName(mp, query, d, run) { return `${baseName(mp, query, d)}${run > 1 ? "_run" + run : ""}.json`; }
  // Downloads subfolder: relative, no "..", no reserved chars. "" = Downloads root.
  function cleanSubfolder(s) {
    return String(s ?? "").replace(/\\/g, "/").split("/").map((p) => p.trim().replace(/[<>:"|?*\x00-\x1f]/g, "_"))
      .filter((p) => p && p !== "." && p !== "..").join("/");
  }
  function subPath(settings, mp) {
    const parts = [cleanSubfolder(settings.subfolder)];
    if (settings.perMarketplace) parts.push(mp === "ozon" ? "ozon" : "wb");
    return parts.filter(Boolean).join("/");
  }
  // First free name: existsFn(name) -> bool|Promise<bool>. Never overwrites.
  async function freeName(mp, query, d, existsFn, maxRuns = 99) {
    for (let run = 1; run <= maxRuns; run++) {
      const n = fileName(mp, query, d, run);
      if (!(await existsFn(n))) return n;
    }
    throw new Error("no free file name");
  }
  const DEFAULTS = { subfolder: "EDSIP/inbox", perMarketplace: false, mode: "downloads", autoCheck: true };
  const api = { slug, baseName, fileName, cleanSubfolder, subPath, freeName, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipSaving = api;
})(typeof self !== "undefined" ? self : this);
