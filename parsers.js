// Pure stats parsers (shared by background.js and node tests). No chrome.* here.
(function (root) {
  function isWbAd(p) { return !!p.logs || p.is_ad_logs === true || ((p.viewFlags || 0) & 64) !== 0 || (p.log && typeof p.log === "object"); }

  function emptyStats(marketplace) {
    return { total: 0, pages: 0, ads: 0, products: 0, query: null, dest: null, curr: null,
      host: null, cards: 0, blocked: 0, redirects: 0, marketplace };
  }

  function wbStats(records) {
    const out = { total: records.length, pages: 0, ads: 0, products: 0, query: null, dest: null, curr: null,
      host: null, cards: 0, blocked: 0, redirects: 0 };
    const pages = new Set(), ids = new Set();
    for (const r of records) {
      if (r.status === 498) out.blocked++;
      if (r.status === 307 || r.redirected) out.redirects++;
      if (r.kind === "card_info" && r.status === 200) out.cards++;
      if (r.kind === "category" || r.kind === "brand_zone") out.zones = (out.zones || 0) + (r.status === 200 ? 1 : 0);
      if (r.kind !== "search" && r.kind !== "category" && r.kind !== "brand_zone") continue;
      const u = new URL(r.url);
      if (u.searchParams.get("resultset") === "filters") continue;
      out.query = u.searchParams.get("query"); out.dest = u.searchParams.get("dest");
      out.curr = u.searchParams.get("curr"); out.host = u.host;
      if (r.status !== 200 || !r.body) continue;
      pages.add(`${out.query}|${out.dest}|${u.searchParams.get("page") || "1"}`);
      try {
        for (const p of JSON.parse(r.body).products || []) {
          if (ids.has(p.id)) continue;
          ids.add(p.id); out.products++;
          if (isWbAd(p)) out.ads++;
        }
      } catch (e) { /* ignore */ }
    }
    out.pages = pages.size;
    return out;
  }

  // ---- Ozon (format from public knowledge, not verified on a live HAR) ----
  function ozonInner(url) {
    try {
      const u = new URL(url);
      const inner = u.searchParams.get("url");
      return inner ? new URL(inner, "https://www.ozon.ru") : null;
    } catch (e) { return null; }
  }
  function ozonPageType(inner) {
    if (!inner) return "other";
    if (/^\/(search|category|brand|seller|highlight)\//.test(inner.pathname)) return "search";
    if (/^\/product\//.test(inner.pathname)) return "product";
    return "other";
  }
  function parseState(v) {
    if (typeof v !== "string") return v && typeof v === "object" ? v : null;
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  function ozonItemId(it) {
    const direct = it.sku ?? it.skuId ?? it.id ?? (it.trackingInfo && it.trackingInfo.click && it.trackingInfo.click.sku);
    if (direct != null && /^\d+$/.test(String(direct))) return String(direct);
    const link = (it.action && it.action.link) || it.link || "";
    const m = String(link).match(/\/product\/(?:[^/?]*-)?(\d{5,})/);
    return m ? m[1] : null;
  }
  const OZON_AD_TEXT = /^(Реклама|Спонсорский товар|Продвигается|Ad|Sponsored)$/i;
  function isOzonAd(it) {
    if (it.isAdv === true || it.isAdvert === true || it.isPromoted === true || it.adv === true) return true;
    let found = false;
    (function walk(o, depth) {
      if (found || depth > 8 || !o) return;
      if (typeof o === "string") { if (OZON_AD_TEXT.test(o.trim())) found = true; return; }
      if (typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (/^(isAdv|isAdvert|advert|isPromo(ted)?)$/i.test(k) && v === true) { found = true; return; }
        walk(v, depth + 1);
      }
    })(it, 0);
    return found;
  }
  // Products in search widgets: widgetStates["searchResultsV2-..."] = "{\"items\":[...]}" (also tileGrid*, skuGrid*).
  function ozonItemsFromBody(body) {
    const items = [];
    const ws = body && body.widgetStates;
    if (!ws || typeof ws !== "object") return items;
    for (const [key, raw] of Object.entries(ws)) {
      if (!/^(searchResults|tileGrid|skuGrid|megaPaginator)/i.test(key)) continue;
      const st = parseState(raw);
      if (st && Array.isArray(st.items)) for (const it of st.items) items.push(it);
    }
    return items;
  }
  function ozonProductFromBody(body) {
    const ws = body && body.widgetStates;
    if (!ws) return null;
    for (const [key, raw] of Object.entries(ws)) {
      if (/^webProductHeading/.test(key)) { const st = parseState(raw); if (st) return st.title || true; }
    }
    return null;
  }

  function ozonStats(records) {
    const out = { total: records.length, pages: 0, ads: 0, products: 0, query: null, dest: null, curr: null,
      host: null, cards: 0, blocked: 0, redirects: 0 };
    const pages = new Set(), ids = new Set();
    for (const r of records) {
      if (r.status === 403 || r.status === 429) out.blocked++;
      if (r.status === 307 || r.redirected) out.redirects++;
      if (r.kind !== "ozon_page") continue;
      const inner = ozonInner(r.url);
      const type = ozonPageType(inner);
      let body = null;
      if (r.status === 200 && r.body) { try { body = JSON.parse(r.body); } catch (e) { body = null; } }
      if (type === "product") { if (body && ozonProductFromBody(body)) out.cards++; continue; }
      if (type !== "search") continue;
      out.host = new URL(r.url).host;
      const q = inner.searchParams.get("text");
      if (q) out.query = q;
      if (!body) continue;
      const items = ozonItemsFromBody(body);
      if (!items.length) continue;
      pages.add(`${inner.pathname}|${q}|${inner.searchParams.get("page") || "1"}`);
      for (const it of items) {
        const id = ozonItemId(it);
        const key = id || JSON.stringify(it).slice(0, 200);
        if (ids.has(key)) continue;
        ids.add(key); out.products++;
        if (isOzonAd(it)) out.ads++;
      }
    }
    out.pages = pages.size;
    return out;
  }

  function marketplaceOf(r) {
    if (r.marketplace) return r.marketplace;
    return /ozon\.(ru|by)/.test(r.url || "") ? "ozon" : "wb";
  }
  // Search query a record belongs to (WB ?query=, Ozon inner url ?text=); null for cards etc.
  function queryOf(r) {
    try {
      const u = new URL(r.url);
      if (marketplaceOf(r) === "ozon") { const i = ozonInner(r.url); return (i && ozonPageType(i) === "search" && i.searchParams.get("text")) || null; }
      return r.kind === "search" ? (u.searchParams.get("query") || u.searchParams.get("search")) : null;
    } catch (e) { return null; }
  }
  // Listing zone for category pages / brand zones (no text query there): "category:<cat|path>" / "brand:<id|path>".
  function zoneOf(r) {
    try {
      const u = new URL(r.url);
      if (marketplaceOf(r) === "ozon") {
        const i = ozonInner(r.url); if (!i) return null;
        const m = i.pathname.match(/^\/(category|brand|seller|highlight)\/([^/]+)/);
        return m && !i.searchParams.get("text") ? `${m[1] === "category" ? "category" : "brand"}:${m[2]}` : null;
      }
      if (r.kind === "category") return `category:${u.searchParams.get("cat") || u.searchParams.get("subject") || u.pathname.split("/").slice(-3, -2)[0]}`;
      if (r.kind === "brand_zone") return `brand:${u.searchParams.get("brand") || "?"}`;
    } catch (e) { /* ignore */ }
    return null;
  }
  function statsFor(records, mp) {
    const recs = records.filter((r) => marketplaceOf(r) === mp);
    return mp === "ozon" ? ozonStats(recs) : wbStats(recs);
  }

  const api = { zoneOf, queryOf, isWbAd, wbStats, ozonStats, statsFor, marketplaceOf, isOzonAd, ozonItemId, ozonItemsFromBody, emptyStats };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EdsipParsers = api;
})(typeof self !== "undefined" ? self : this);
