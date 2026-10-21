// Builds the file envelope "edsip-mp-capture/2" (contract_v2.md §2). Pure; used by background.js and tests.
(function (root) {
  const P = root.EdsipParsers || (typeof require === "function" ? require("../parsers.js") : null);
  const SCHEMA = "edsip-mp-capture/2";
  const LISTING = new Set(["search", "category", "brand_zone", "card", "ozon_page"]);

  const uuid4 = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  async function sha256Hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function pageOf(r) {
    try {
      const u = new URL(r.url);
      if (r.kind === "ozon_page") { const i = u.searchParams.get("url"); return i ? +(new URL(i, "https://www.ozon.ru").searchParams.get("page") || 1) : null; }
      if (u.searchParams.get("resultset") === "filters") return null;
      return +(u.searchParams.get("page") || 1);
    } catch (e) { return null; }
  }
  // context: site_host + region_hint (contract) and query/zone/pages (requested: site, dest, curr, query, page).
  function buildContext(records, query, zone) {
    let host = null, dest = null, curr = null, spp = null, snap = null;
    const pages = new Set();
    for (const r of records) {
      if (!LISTING.has(r.kind) || r.status !== 200) continue;
      try {
        const u = new URL(r.url);
        host = r.page_host || u.host;
        if (u.searchParams.get("dest")) dest = u.searchParams.get("dest");
        if (u.searchParams.get("curr")) curr = u.searchParams.get("curr");
        if (u.searchParams.get("spp")) spp = u.searchParams.get("spp");
        if (r.ts && (!snap || r.ts > snap)) snap = r.ts;
      } catch (e) { continue; }
      const p = pageOf(r); if (p) pages.add(p);
    }
    if (!host) { const r = records.find((x) => x.page_host); if (r) host = r.page_host; }
    // Raw values from the page's own request URLs (no normalization). snapshot_at = ts of the last listing response.
    return { site_host: host, region_hint: { dest, curr }, curr, dest, spp, snapshot_at: snap, query: query || null, zone: zone || null,
      pages: [...pages].sort((a, b) => a - b), page: pages.size ? Math.max(...pages) : null };
  }
  async function buildEnvelope({ marketplace, query, zone, records, version, now, captureId }) {
    const ts = records.map((r) => r.ts).filter(Boolean).sort();
    const out = [];
    for (const r of records) {
      const rec = { ...r };
      let body = rec.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      rec.body = body ?? null;
      rec.body_sha256 = rec.body == null ? null : await sha256Hex(JSON.stringify(rec.body));
      delete rec.page_host;
      out.push(rec);
    }
    const savedAt = (now || new Date()).toISOString();
    const context = buildContext(records, query, zone);
    if (!context.snapshot_at) context.snapshot_at = ts[ts.length - 1] || savedAt;
    const st = P.statsFor(records, marketplace);
    if (query) st.query = query;
    return { schema: SCHEMA, capture_id: captureId || uuid4(), marketplace, extension_version: version,
      saved_at: savedAt, run_started_at: ts[0] || null, run_ended_at: ts[ts.length - 1] || null,
      query: query || null, zone: zone || null, tabs: [...new Set(records.map((r) => r.tab).filter((t) => t != null))],
      context, stats: st, records: out };
  }
  const api = { SCHEMA, buildEnvelope, buildContext, sha256Hex, uuid4 };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipEnvelope = api;
})(typeof self !== "undefined" ? self : this);
