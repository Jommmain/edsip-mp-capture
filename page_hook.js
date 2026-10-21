// EDSIP MP Capture — runs in the page (MAIN world). Only COPIES responses the page itself requested.
// Never reads request headers/cookies; never makes its own requests.
(() => {
  if (window.__edsipHook) return;
  window.__edsipHook = true;

  // ---- private channel to content.js ----
  // content.js (isolated world) sends {__edsip_init, nonce} with a MessagePort. This listener is registered before any
  // page script runs (document_start, MAIN world), takes the FIRST init only and stops it from reaching page listeners.
  // Records go only through that port and carry the nonce; nothing is posted to window.
  let port = null, nonce = null;
  const queue = [];
  function send(rec) {
    if (port) port.postMessage({ nonce, record: rec });
    else if (queue.length < 200) queue.push(rec);
  }
  window.addEventListener("message", function onInit(ev) {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.__edsip_init !== 1) return;
    ev.stopImmediatePropagation();
    if (port || !ev.ports || !ev.ports[0] || typeof ev.data.nonce !== "string") return;
    port = ev.ports[0]; nonce = ev.data.nonce;
    window.removeEventListener("message", onInit, true);
    for (const r of queue.splice(0)) send(r);
  }, true);
  window.postMessage({ __edsip_hello: 1 }, location.origin); // in case content.js started first

  // WB: real endpoints (HAR 19-20.10.2026). Ozon: known public page API (NOT verified live yet).
  const RULES = [
    [/\/__internal\/u-search\/exactmatch\/(ru|sng)\/common\/v\d+\/search\?/, "wb", "search"],
    // Category pages and brand zones (catalog listing APIs). NOT verified on a live HAR (pattern by known WB routes).
    [/\/__internal\/u-catalog\/catalog\/[^?]+\/v\d+\/(catalog|filters)\?/, "wb", "category"],
    [/catalog\.wb\.ru\/catalog\/[^?]+\/v\d+\/(catalog|filters)\?/, "wb", "category"],
    [/\/__internal\/u-(catalog|brands?)\/brands\/v\d+\/(catalog|filters)\?/, "wb", "brand_zone"],
    [/catalog\.wb\.ru\/brands\/v\d+\/(catalog|filters)\?/, "wb", "brand_zone"],
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
    "category_was_predicted", "url", "cat", "subject", "supplier"]);
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
  // Counters over the reviews this response actually contains (texts/names/photos are dropped right here).
  // reviews_2026 = reviews with createdDate in 2026; with_answer = reviews with a seller answer.
  function reviewCounters(list) {
    if (!Array.isArray(list)) return { reviews_loaded: 0, reviews_2026: null, with_answer: null, reviews_by_year: {} };
    const byYear = {}; let withAnswer = 0;
    for (const f of list) {
      const y = String((f && (f.createdDate || f.created_date || f.date)) || "").slice(0, 4);
      if (/^\d{4}$/.test(y)) byYear[y] = (byYear[y] || 0) + 1;
      const a = f && f.answer;
      const at = a && (typeof a === "string" ? a : (a.text ?? a.answer ?? ""));
      if (typeof at === "string" && at.trim()) withAnswer++;
    }
    return { reviews_loaded: list.length, reviews_2026: byYear["2026"] || 0, with_answer: withAnswer, reviews_by_year: byYear };
  }
  // Reviews/questions contain personal data -> reduce to counts in the browser.
  // ---- ALLOWLIST per response type: only listed fields survive (personal data / unknown fields are dropped). ----
  // Schema: key -> 1 (keep value as-is, scrubbed) | {..} (object schema) | [{..}] (array of object schema).
  function pick(o, sch) {
    if (Array.isArray(sch)) return Array.isArray(o) ? o.map((x) => pick(x, sch[0])) : undefined;
    if (sch === 1) return scrub(o);
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    const r = {};
    for (const [k, s] of Object.entries(sch)) if (o[k] !== undefined) { const v = pick(o[k], s); if (v !== undefined) r[k] = v; }
    return r;
  }
  // Prices are collected RAW (contract §7a): no recalculation here; the backend normalizes.
  const PRICE = { basic: 1, product: 1, total: 1, wallet: 1, logistics: 1, return: 1, cashback: 1 };
  const WB_PRODUCT = { id: 1, root: 1, kindId: 1, brand: 1, brandId: 1, siteBrandId: 1, subjectId: 1, subjectParentId: 1, name: 1,
    entity: 1, supplier: 1, supplierId: 1, supplierRating: 1, supplierFlags: 1, promotions: 1, rating: 1, reviewRating: 1, nmReviewRating: 1, feedbacks: 1,
    nmFeedbacks: 1, pics: 1, volume: 1, viewFlags: 1, panelPromoId: 1, promoTextCard: 1, promoTextCat: 1, totalQuantity: 1,
    time1: 1, time2: 1, wh: 1, dtype: 1, dist: 1, isNew: 1, dupId: 1, matchId: 1, colors: [{ id: 1, name: 1 }],
    priceU: 1, salePriceU: 1, sale: 1,
    sizes: [{ name: 1, origName: 1, rank: 1, optionId: 1, wh: 1, dtype: 1, time1: 1, time2: 1, price: PRICE, saleConditions: 1,
      stocks: [{ wh: 1, dtype: 1, qty: 1, priority: 1, time1: 1, time2: 1 }] }] };
  const WB_LISTING = { metadata: { name: 1, normquery: 1, catalog_type: 1, catalog_value: 1, rmi: 1, title: 1 }, total: 1, version: 1,
    products: [WB_PRODUCT],
    data: { total: 1, products: [WB_PRODUCT], filters: [{ key: 1, name: 1, multiple: 1, maxPriceU: 1, minPriceU: 1,
      items: [{ id: 1, name: 1, count: 1 }] }] } };
  const WB_CARD_INFO = { imt_id: 1, nm_id: 1, imt_name: 1, slug: 1, subj_name: 1, subj_root_name: 1, vendor_code: 1, description: 1,
    options: [{ name: 1, value: 1, charc_type: 1 }], grouped_options: [{ group_name: 1, options: [{ name: 1, value: 1 }] }],
    compositions: [{ name: 1 }], nm_colors_names: 1, colors: 1, contents: 1, kinds: 1, has_rich: 1, need_kiz: 1,
    selling: { brand_name: 1, brand_hash: 1, supplier_id: 1 }, media: { has_video: 1, photo_count: 1 }, data: { subject_id: 1, subject_root_id: 1 } };
  const IMG_URL = /^https:\/\/[^\s"']+\.(webp|jpe?g|png|avif)(\?[^\s"']*)?$/i;
  function imageUrls(o, out = new Set(), depth = 0) {
    if (out.size >= 50 || depth > 10 || o == null) return out;
    if (typeof o === "string") { if (IMG_URL.test(o)) out.add(o); return out; }
    if (typeof o === "object") for (const v of Object.values(o)) imageUrls(v, out, depth + 1);
    return out;
  }
  // Ozon: keep only content widgets (prefix allowlist); seller/user/tracking widgets are dropped. Inside a widget the
  // structure is not fixed -> secret-key scrub still applies there (format not verified live).
  const OZON_WIDGETS = /^(searchResults|tileGrid|skuGrid|megaPaginator|paginator|webProductHeading|webPrice|webSale|webDescription|webCharacteristics|webGallery|webReviewProductScore|webSingleProductScore|webBrand|breadCrumbs|webAspects|filtersDesktop|searchResultsSort|catalogResultsHeader|webCategoryHeader|resultsHeader)/;
  function reduce(kind, data) {
    if (!data || typeof data !== "object") return null;
    if (kind === "feedbacks") {
      return { feedback_count: data.feedbackCount ?? null, valuation: data.valuation ?? null,
        with_photo: data.feedbackCountWithPhoto ?? null, with_text: data.feedbackCountWithText ?? null,
        with_video: data.feedbackCountWithVideo ?? null, distribution: data.valuationDistribution ?? null,
        reviews_total: data.feedbackCount ?? null, ...reviewCounters(data.feedbacks) };
    }
    if (kind === "questions") return { question_count: data.count ?? null };
    if (kind === "search" || kind === "category" || kind === "brand_zone" || kind === "card") {
      // `logs` = encrypted ad-tracking blob: never stored; only is_ad_logs (bool). viewFlags is kept whole.
      const out = pick(data, WB_LISTING);
      const mark = (src, dst) => { if (Array.isArray(src) && Array.isArray(dst)) src.forEach((p, i) => { if (dst[i]) dst[i].is_ad_logs = !!(p && p.logs); }); };
      mark(data.products, out.products); if (data.data && out.data) mark(data.data.products, out.data.products);
      return out;
    }
    if (kind === "card_info") return pick(data, WB_CARD_INFO);
    // rich_v1.json: structure not parsed -> presence, block count, image URLs only.
    if (kind === "card_rich") {
      const blocks = Array.isArray(data) ? data.length : (Array.isArray(data.blocks) ? data.blocks.length : (Array.isArray(data.content) ? data.content.length : null));
      return { rich_present: true, blocks, images: [...imageUrls(data)] };
    }
    if (kind === "ozon_page") {
      const keep = {};
      if (data.widgetStates && typeof data.widgetStates === "object") {
        keep.widgetStates = {};
        for (const [k, v] of Object.entries(data.widgetStates)) {
          if (!OZON_WIDGETS.test(k)) continue;
          if (typeof v === "string") { try { keep.widgetStates[k] = JSON.stringify(scrub(JSON.parse(v))); } catch (e) { /* drop */ } }
          else keep.widgetStates[k] = scrub(v);
        }
      }
      for (const k of ["nextPage", "prevPage"]) if (typeof data[k] === "string") keep[k] = data[k];
      if (data.pageInfo && typeof data.pageInfo === "object") keep.pageInfo = pick(data.pageInfo, { pageType: 1, url: 1, layoutId: 1 });
      return keep;
    }
    return null; // unknown kind -> nothing
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
    send({ url: clean, marketplace: rule[0], kind: rule[1], status, redirected: !!redirected, ts: new Date().toISOString(), body });
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
