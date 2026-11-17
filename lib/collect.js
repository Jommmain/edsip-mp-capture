// "Собрать витрину": URL list planning. Pure — background.js and tests use it without Chrome.
(function (root) {
  const HOSTS = {
    wb: [/^https:\/\/www\.wildberries\.(ru|by)\//],
    ozon: [/^https:\/\/(www\.)?ozon\.(ru|by)\//],
  };
  const DEFAULT_DWELL_S = 20;   // seconds a collect tab stays open (page loads + initial JSON)
  const PAUSE_S = [2, 5];       // pause between tabs, anti-bot pacing
  const MAX_URLS = 30;

  function marketplaceOf(url) {
    for (const [mp, res] of Object.entries(HOSTS)) if (res.some((re) => re.test(url))) return mp;
    return null;
  }
  // Textarea → run plan. One URL per line; "#" comments; unknown hosts are reported, not run.
  function parsePlan(text, { dwell = DEFAULT_DWELL_S, maxUrls = MAX_URLS } = {}) {
    const seen = new Set(), urls = [], rejected = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const mp = marketplaceOf(line);
      if (!mp) { rejected.push({ url: line, reason: "не WB/Ozon" }); continue; }
      if (seen.has(line)) { rejected.push({ url: line, reason: "дубликат" }); continue; }
      seen.add(line);
      urls.push({ url: line, marketplace: mp });
      if (urls.length >= maxUrls) break;
    }
    const d = Math.max(5, Math.min(120, Math.round(dwell) || DEFAULT_DWELL_S));
    return { urls, rejected, dwell: d, pause: PAUSE_S, total: urls.length };
  }
  const api = { parsePlan, marketplaceOf, DEFAULT_DWELL_S, MAX_URLS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipCollect = api;
})(typeof self !== "undefined" ? self : this);
