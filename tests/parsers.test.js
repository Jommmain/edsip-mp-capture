// node tests/parsers.test.js — Ozon/WB stats parsers + page_hook URL cleaning (synthetic Ozon data).
const assert = require("assert"), path = require("path"), fs = require("fs"), vm = require("vm");
const P = require(path.join(__dirname, "..", "parsers.js"));
const { fileName, toPrettyJson } = require(path.join(__dirname, "..", "popup.js"));

const ozUrl = (inner) => "https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=" + encodeURIComponent(inner);
const item = (sku, ad) => ({ action: { link: `/product/korm-${sku}/?at=x` }, mainState: ad ? [{ atom: { textAtom: { text: "Реклама" } } }] : [] });
const page = (items) => JSON.stringify({ widgetStates: { "searchResultsV2-3547909-default-1": JSON.stringify({ items }) } });
const recs = [
  { url: ozUrl("/search/?text=корм для кошек&page=1"), marketplace: "ozon", kind: "ozon_page", status: 200, body: page([item(111111, true), item(222222), item(333333)]) },
  { url: ozUrl("/search/?text=корм для кошек&page=2"), marketplace: "ozon", kind: "ozon_page", status: 200, body: page([item(333333), { sku: 444444, isAdv: true }]) },
  { url: ozUrl("/product/korm-555555/"), marketplace: "ozon", kind: "ozon_page", status: 200, body: JSON.stringify({ widgetStates: { "webProductHeading-1-default-1": JSON.stringify({ title: "Корм" }) } }) },
  { url: ozUrl("/search/?text=x"), marketplace: "ozon", kind: "ozon_page", status: 403, body: null },
  { url: "https://www.wildberries.by/__internal/u-search/exactmatch/sng/common/v18/search?query=a&dest=-1&page=1", kind: "search", status: 200,
    body: JSON.stringify({ products: [{ id: 1, viewFlags: 64 }, { id: 2 }] }) },
];
const oz = P.statsFor(recs, "ozon");
assert.deepStrictEqual([oz.products, oz.ads, oz.pages, oz.cards, oz.blocked, oz.query, oz.total], [4, 2, 2, 1, 1, "x", 4]);
const wb = P.statsFor(recs, "wb");
assert.deepStrictEqual([wb.products, wb.ads, wb.pages, wb.query], [2, 1, 1, "a"]);
assert.strictEqual(P.ozonItemId({ action: { link: "https://www.ozon.ru/product/abc-1234567/" } }), "1234567");
assert.strictEqual(P.marketplaceOf({ url: ozUrl("/") }), "ozon");
assert.strictEqual(fileName("корм для кошек", "ozon", new Date(2026, 9, 20, 9, 5, 7)), "ozon_корм_для_кошек_2026-10-20_09-05-07.json");
assert.strictEqual(fileName(null, "wb", new Date(2026, 0, 2, 3, 4, 5), 3), "wb_noquery_2026-01-02_03-04-05_run3.json");
const pj = JSON.parse(toPrettyJson({ schema: "edsip-mp-capture/1", marketplace: "ozon", stats: oz, records: recs.slice(0, 1) }));
assert.strictEqual(pj.marketplace, "ozon"); assert.ok(pj.records[0].body.widgetStates);

// page_hook: Ozon response captured, inner url cleaned, tracking + tokens dropped.
const posted = [];
const ctx = { window: { postMessage: (m) => posted.push(m) }, location: { href: "https://www.ozon.ru/search/", origin: "https://www.ozon.ru" },
  URL, JSON, Date, XMLHttpRequest: function () {} };
ctx.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
let next;
ctx.window.fetch = async (url) => ({ url, status: 200, redirected: false, clone() { return this; }, text: async () => next });
vm.createContext(ctx); ctx.fetch = ctx.window.fetch;
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "page_hook.js"), "utf8").replace(/window\.fetch/g, "fetch"), ctx);
(async () => {
  next = JSON.stringify({ widgetStates: { a: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig" }, trackingPayloads: { x: 1 }, userToken: "t" });
  await ctx.fetch(ozUrl("/search/?text=корм&page=2&sh=SECRET&tf_state=zzz") + "&__rr=1&abt_att=1");
  next = "{}"; await ctx.fetch("https://xapi.ozon.ru/dlte/multi");
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(posted.length, 1);
  const r = posted[0].record, u = new URL(r.url);
  assert.strictEqual(r.marketplace, "ozon"); assert.strictEqual(r.kind, "ozon_page");
  assert.strictEqual(u.searchParams.get("url"), "/search/?text=%D0%BA%D0%BE%D1%80%D0%BC&page=2");
  assert.ok(!r.url.includes("__rr") && !r.url.includes("SECRET"));
  const b = JSON.parse(r.body);
  assert.deepStrictEqual(Object.keys(b), ["widgetStates"]); assert.strictEqual(b.widgetStates.a, "<redacted>");
  console.log("parsers.test.js: OK");
})().catch((e) => { console.error(e); process.exit(1); });
