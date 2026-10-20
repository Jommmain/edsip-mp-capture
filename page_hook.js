// EDSIP MP Capture — runs in the page (MAIN world). Only COPIES responses the page itself requested.
// Never reads request headers/cookies; never makes its own requests.
(() => {
  if (window.__edsipHook) return;
  window.__edsipHook = true;

  // WB: real endpoints (HAR 19-20.10.2026). Ozon: known public page API (NOT verified live yet).
  const RULES = [
    [/\/__internal\/u-search\/exactmatch\/(ru|sng)\/common\/v\d+\/search\?/, "wb", "search"],
    [/\/__internal\/u-card\/cards\/v\d+\/(detail|list)\?/, "wb", "card"],
    [/(wbbasket\.ru|geobasket\.net)\/vol\d+\/part\d+\/\d+\/info\/(ru\/)?card\.json/, "wb", "card_info"],
    [/(wbbasket\.ru|geobasket\.net)\/vol\d+\/part\d+\/\d+\/info\/(ru\/)?rich_v\d+\.json/, "wb", "card_rich"],
    [/feedback-view-\d+\.wb\.ru\/feedbacks\/v\d+\/\d+/, "wb", "feedbacks"],
    [/feedbacks\d?\.wb\.ru\/feedbacks\/v\d+\/\d+/, "wb", "feedbacks"],
    [/questions\.(wildberries|wb)\.ru\/api\/v\d+\/questions/, "wb", "questions"],
    [/ozon\.(ru|by)\/api\/(entrypoint-api\.bx|composer-api\.bx)\/page\/json\/v\d+(\?|$)/, "ozon", "ozon_page"],
  ];
  const IGNORE = /a\.wb\.ru|__wbaas|\/antibot\/|sentry|journal-bt|data-checker|\/abt\/|xapi\.ozon|tracker|\/auth\//;
  const ALLOWED = new Set(["query", "search", "text", "dest", "curr", "page", "priceU", "resultset", "sort", "spp", "lang",
    "locale", "appType", "nm", "brand", "xsubject", "fbrand", "fsupplier", "seller", "currency_price", "from_global",
    "category_was_predicted", "url"]);
  // Inner Ozon page url (?url=/search/?text=...): keep only harmless params.
  const OZON_INNER = new Set(["text", "page", "brand", "seller", "currency_price", "from_global", "sorting", "category_was_predicted"]);
  const SECRET_KEY = /(token|cookie|authorization|auth|session|password|userdata|user_?id|device_?id|phone|email|x_wbaas|wbx|_wbauid|validation|wbuserdetails|^payload$|abt_data|__rr)/i;
  const TOKEN_VAL = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?|1\.1000\.[0-9a-f]{20,}\S*/g;

  function ruleOf(url) {
    if (!url || IGNORE.test(url)) return null;
    for (const [re, mp, k] of RULES) if (re.test(url)) return [mp, k];
    return null;
  }
  function cleanInner(path) {
    try {
      const u = new URL(path, "https://www.ozon.ru");
      for (const k of [...u.searchParams.keys()]) if (!OZON_INNER.has(k)) u.searchParams.delete(k);
      return u.pathname + (u.search || "");
    } catch (e) { return null; }
  }
  function cleanUrl(url) {
    try {
      const u = new URL(url, location.href);
      for (const k of [...u.searchParams.keys()]) if (!ALLOWED.has(k)) u.searchParams.delete(k);
      if (u.searchParams.has("url")) {
        const inner = cleanInner(u.searchParams.get("url"));
        if (inner) u.searchParams.set("url", inner); else u.searchParams.delete("url");
      }
      u.hash = "";
      return u.toString();
    } catch (e) { return null; }
  }
  function scrub(o) {
    if (Array.isArray(o)) return o.map(scrub);
    if (o && typeof o === "object") {
      const r = {};
      for (const [k, v] of Object.entries(o)) if (!SECRET_KEY.test(k)) r[k] = scrub(v);
      return r;
    }
    return typeof o === "string" ? o.replace(TOKEN_VAL, "<redacted>") : o;
  }
  // Reviews/questions contain personal data -> reduce to counts in the browser.
  function reduce(kind, data) {
    if (kind === "feedbacks" && data && typeof data === "object") {
      return { feedback_count: data.feedbackCount ?? null, valuation: data.valuation ?? null,
        with_photo: data.feedbackCountWithPhoto ?? null, with_text: data.feedbackCountWithText ?? null,
        with_video: data.feedbackCountWithVideo ?? null, distribution: data.valuationDistribution ?? null };
    }
    if (kind === "questions" && data && typeof data === "object") return { question_count: data.count ?? null };
    if (kind === "ozon_page" && data && typeof data === "object") {
      // Ozon: keep only page content (widgetStates/layout/paging); drop tracking/analytics blobs.
      const keep = {};
      for (const k of ["widgetStates", "layout", "nextPage", "prevPage", "pageInfo", "shared"]) if (k in data) keep[k] = data[k];
      return scrub(keep);
    }
    return scrub(data);
  }
  function emit(url, status, redirected, text) {
    const rule = ruleOf(url);
    if (!rule) return;
    const clean = cleanUrl(url);
    if (!clean) return;
    let body = null;
    if (text && status === 200) {
      // Body is JSON even when content-type is text/plain (WB search) -> parse regardless of type.
      try { body = JSON.stringify(reduce(rule[1], JSON.parse(text))); } catch (e) { body = null; }
    }
    window.postMessage({ __edsip: 1, record: { url: clean, marketplace: rule[0], kind: rule[1], status,
      redirected: !!redirected, ts: new Date().toISOString(), body } }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = res.url || (args[0] && args[0].url) || String(args[0]);
      if (ruleOf(url)) res.clone().text().then((t) => emit(url, res.status, res.redirected, t), () => emit(url, res.status, res.redirected, null));
    } catch (e) { /* never break the page */ }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__edsipUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      try {
        const url = this.responseURL || (this.__edsipUrl && new URL(this.__edsipUrl, location.href).toString());
        if (!ruleOf(url)) return;
        const t = (this.responseType === "" || this.responseType === "text") ? this.responseText
          : (this.responseType === "json" ? JSON.stringify(this.response) : null);
        emit(url, this.status, false, t);
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, args);
  };
})();
