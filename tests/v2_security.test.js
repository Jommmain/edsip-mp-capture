// node tests/v2_security.test.js — contract v2 envelope, field allowlist, review counters, category/brand zones,
// private channel (nonce), release signature, update path allowlist, stage-2 POST stub. Writes tests/fixtures/sample_v2.json.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const { loadHook } = require("./hook_harness.js");
const P = require("../parsers.js");
global.EdsipParsers = P;
const ENV = require("../lib/envelope.js");
const U = require("../lib/updater.js");
const T = require("../lib/transport_post.js");
const WB = "https://www.wildberries.by/__internal/u-search/exactmatch/sng/common/v18/search?appType=1&curr=byn&dest=-59208&lang=ru&locale=by&query=%D0%BA%D0%BE%D1%80%D0%BC&resultset=catalog&sort=popular&spp=30";

(async () => {
  const h = loadHook("https://www.wildberries.by");
  // --- search: raw prices + seller + saleConditions kept; unknown/personal fields dropped; logs -> <opaque> ---
  await h.get(WB + "&uid=7&x_wbaas_token=ZZ", { metadata: { normquery: "корм", catalog_type: "preset", tracking: { u: 1 } }, total: 7521, secretBlob: 1,
    products: [{ id: 380913287, brand: "Royal canin", brandId: 41830, supplier: "Ezoo", supplierId: 1304374, supplierRating: 4.9, name: "Oral Care",
      totalQuantity: 35, viewFlags: 64, logs: "AD-TRACKING-BLOB", sellerPhone: "+375…", ownerFio: "Иванов",
      sizes: [{ price: { basic: 2610, product: 2134, logistics: 0, return: 0, cashback: 0, wallet: 0, secretX: 1 }, saleConditions: 402653184,
        payload: "x", stocks: [{ wh: 1, qty: 3, buyerId: 9 }] }], promotions: [123] }] });
  const s = JSON.parse(h.records[0].body);
  const p = s.products[0];
  assert.deepStrictEqual(p.sizes[0].price, { basic: 2610, product: 2134, wallet: 0, logistics: 0, return: 0, cashback: 0 });
  assert.strictEqual(p.sizes[0].saleConditions, 402653184);
  assert.deepStrictEqual(p.sizes[0].stocks, [{ wh: 1, qty: 3 }]);
  assert.deepStrictEqual([p.supplier, p.supplierId, p.supplierRating, p.logs], ["Ezoo", 1304374, 4.9, "<opaque>"]);
  assert.deepStrictEqual(p.promotions, [123]);
  assert.ok(!("sellerPhone" in p) && !("ownerFio" in p) && !("payload" in p.sizes[0]) && !("secretBlob" in s) && !("tracking" in s.metadata));
  assert.ok(!h.records[0].url.includes("uid=") && !h.records[0].url.includes("wbaas"));
  assert.ok(P.isWbAd(p));

  // --- detail card: stocks + promotions ---
  await h.get("https://www.wildberries.by/__internal/u-card/cards/v4/detail?appType=1&curr=byn&dest=-59208&spp=30&nm=380913287",
    { products: [{ id: 380913287, promotions: [1, 2], sizes: [{ price: { basic: 2610, product: 2134 }, stocks: [{ wh: 507, qty: 12 }] }] }] });
  const d = JSON.parse(h.records[1].body).products[0];
  assert.deepStrictEqual([d.promotions, d.sizes[0].stocks], [[1, 2], [{ wh: 507, qty: 12 }]]);

  // --- card.json allowlist ---
  await h.get("https://basket-12.wbbasket.ru/vol1899/part189961/189961044/info/ru/card.json",
    { nm_id: 189961044, imt_name: "Sterilised", description: "d", options: [{ name: "Вес", value: "1.2" }], media: { photo_count: 10, has_video: true },
      selling: { brand_name: "Royal Canin", supplier_id: 5, supplier_inn: "1234567890" }, contacts: { phone: "1" } });
  const ci = JSON.parse(h.records[2].body);
  assert.deepStrictEqual(ci.media, { has_video: true, photo_count: 10 });
  assert.ok(!("contacts" in ci) && !("supplier_inn" in ci.selling));

  // --- reviews: counters only (reviews_2026, with_answer), no texts ---
  await h.get("https://feedback-view-02.wb.ru/feedbacks/v2/222478386", { feedbackCount: 4, valuation: "4.9", feedbackCountWithPhoto: 1,
    feedbacks: [{ createdDate: "2026-03-01T10:00:00Z", text: "Отлично", answer: { text: "Спасибо" }, wbUserDetails: { name: "Иван" } },
      { createdDate: "2026-09-10T10:00:00Z", text: "ok", answer: null }, { createdDate: "2025-12-31T23:00:00Z", text: "x", answer: { text: "" } },
      { createdDate: "2024-01-01T00:00:00Z", pros: "y" }] });
  const fb = JSON.parse(h.records[3].body);
  assert.deepStrictEqual([fb.feedback_count, fb.reviews_loaded, fb.reviews_2026, fb.with_answer], [4, 4, 2, 1]);
  assert.deepStrictEqual(fb.reviews_by_year, { 2026: 2, 2025: 1, 2024: 1 });
  assert.ok(!JSON.stringify(fb).includes("Отлично") && !JSON.stringify(fb).includes("Иван"));

  // --- rich: presence + image URLs only ---
  await h.get("https://basket-12.wbbasket.ru/vol1899/part189961/189961044/info/ru/rich_v1.json",
    [{ type: "img", src: "https://basket-12.wbbasket.ru/vol1899/part189961/189961044/rich/1.webp", text: "длинный текст" }, { type: "text", text: "t" }]);
  assert.deepStrictEqual(JSON.parse(h.records[4].body), { rich_present: true, blocks: 2,
    images: ["https://basket-12.wbbasket.ru/vol1899/part189961/189961044/rich/1.webp"] });

  // --- category page + brand zone ---
  await h.get("https://www.wildberries.by/__internal/u-catalog/catalog/pet_food/v4/catalog?appType=1&cat=9002&curr=byn&dest=-59208&spp=30&page=2&sort=popular",
    { data: { products: [{ id: 5, sizes: [{ price: { basic: 100, product: 90 } }] }], total: 1 } });
  await h.get("https://www.wildberries.by/__internal/u-catalog/brands/v4/catalog?appType=1&brand=41830&curr=byn&dest=-59208&spp=30",
    { products: [{ id: 6, brandId: 41830 }] });
  assert.deepStrictEqual(h.records.slice(5).map((r) => r.kind), ["category", "brand_zone"]);
  assert.strictEqual(P.zoneOf(h.records[5]), "category:9002"); assert.strictEqual(P.zoneOf(h.records[6]), "brand:41830");
  assert.strictEqual(JSON.parse(h.records[5].body).data.products[0].sizes[0].price.product, 90);
  assert.strictEqual(P.zoneOf({ url: "https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fbrand%2Froyal-canin-1234%2F", marketplace: "ozon" }), "brand:royal-canin-1234");

  // --- private channel: forged init / window messages cannot inject or hijack ---
  const before = h.records.length;
  const ch = new MessageChannel(); let hijacked = 0; ch.port1.onmessage = () => hijacked++;
  h.dispatch({ __edsip_init: 1, nonce: "evil" }, [ch.port2]);                     // second init ignored
  h.dispatch({ __edsip: 1, record: { url: WB, kind: "search", status: 200 } });   // old-style forged record: no effect
  await h.get(WB + "&page=3", { products: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(hijacked, 0); assert.strictEqual(h.records.length, before + 1);
  assert.strictEqual(h.dispatch({ __edsip_init: 1, nonce: "x" }, [], {}, "https://evil.example"), false); // foreign source/origin not even consumed
  h.close();

  // --- content.js: accepts records only with its own nonce, only via the port ---
  const sent = [], wl = [];
  let initMsg = null;
  const cwin = { addEventListener: (t, f) => wl.push(f), postMessage: (data, origin, ports) => { initMsg = { data, origin, ports }; } };
  const cctx = { window: cwin, location: { host: "www.wildberries.by", origin: "https://www.wildberries.by", href: "https://www.wildberries.by/" },
    crypto, MessageChannel, URL, document: { visibilityState: "visible", addEventListener() {} }, setTimeout,
    chrome: { runtime: { sendMessage: (m) => sent.push(m), onMessage: { addListener() {} } } } };
  vm.createContext(cctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), cctx);
  assert.strictEqual(initMsg.data.__edsip_init, 1); assert.strictEqual(initMsg.origin, "https://www.wildberries.by");
  const port = initMsg.ports[0];
  port.postMessage({ nonce: "wrong", record: { url: WB, kind: "search", status: 200, body: "{}" } });
  port.postMessage({ nonce: initMsg.data.nonce, record: { url: WB, kind: "search", status: 200, body: "{}", extra: "dropped" } });
  for (const f of wl) f({ source: cwin, origin: "https://www.wildberries.by", data: { __edsip: 1, record: { url: "forged" } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 1); assert.ok(!("extra" in sent[0].record)); assert.strictEqual(sent[0].record.page_host, "www.wildberries.by");
  port.close();

  // --- envelope v2 + sample fixture ---
  const recs = [
    { ...JSON.parse(JSON.stringify(h.records[0])), tab: 1, query: "корм", ts: "2026-10-20T06:35:00.323Z", page_host: "www.wildberries.by" },
    { ...JSON.parse(JSON.stringify(h.records[3])), tab: 1, query: "корм", ts: "2026-10-20T06:36:10.000Z" },
  ];
  const env = await ENV.buildEnvelope({ marketplace: "wb", query: "корм", records: recs, version: "0.6.0",
    now: new Date("2026-10-20T06:38:10.161Z"), captureId: "3f1c2a8e-4b7d-4c1e-9a2b-5d6e7f8a9b0c" });
  assert.strictEqual(env.schema, "edsip-mp-capture/2");
  assert.deepStrictEqual(env.context, { site_host: "www.wildberries.by", region_hint: { dest: "-59208", curr: "byn" }, curr: "byn", dest: "-59208", spp: "30",
    snapshot_at: "2026-10-20T06:35:00.323Z", query: "корм", zone: null, pages: [1], page: 1 });
  assert.match(env.records[0].body_sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(env.records[0].body.products[0].sizes[0].price.product, 2134); // raw, not recalculated
  assert.ok(!("prices" in env.records[0]) && !("page_host" in env.records[0]));
  assert.match((await ENV.buildEnvelope({ marketplace: "wb", records: [], version: "x" })).capture_id, /^[0-9a-f-]{36}$/);
  const { toPrettyJson } = require("../popup.js");
  const sample = toPrettyJson(env);
  const fx = path.join(__dirname, "fixtures", "sample_v2.json");
  if (process.env.UPDATE_FIXTURES || !fs.existsSync(fx)) fs.writeFileSync(fx, sample);
  assert.strictEqual(fs.readFileSync(fx, "utf8"), sample, "sample_v2.json is stale (UPDATE_FIXTURES=1 to regenerate)");

  // --- release signature (ed25519 over SHA256SUMS) + sha256 of the zip ---
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const zip = Buffer.from("PK-fake-zip-bytes");
  const sums = Buffer.from(`${crypto.createHash("sha256").update(zip).digest("hex")}  edsip-mp-capture-0.6.0.zip\n`);
  const sig = crypto.sign(null, sums, privateKey);
  assert.match((await U.verifyRelease(zip, "edsip-mp-capture-0.6.0.zip", sums, sig, pub)).sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(U.verifyRelease(Buffer.from("tampered"), "edsip-mp-capture-0.6.0.zip", sums, sig, pub), /sha256/);
  const badSums = Buffer.from(sums.toString().replace(/^./, "0"));
  await assert.rejects(U.verifyRelease(zip, "edsip-mp-capture-0.6.0.zip", badSums, sig, pub), /подпись/);
  await assert.rejects(U.verifyRelease(zip, "edsip-mp-capture-0.6.0.zip", sums, sig), /подпись/); // pinned key != test key
  await assert.rejects(U.verifyRelease(zip, "x.zip", null, null, pub), /SHA256SUMS/);
  assert.ok(U.ALLOWED_PATH.test("lib/envelope.js") && U.ALLOWED_PATH.test("icons/icon48.png"));
  assert.ok(!U.ALLOWED_PATH.test("evil.sh") && !U.ALLOWED_PATH.test("lib/x/y.js") && !U.ALLOWED_PATH.test("_metadata/x"));

  // --- stage-2 POST stub: off by default; when enabled sends X-EDSIP-Extension-Token, no cookies ---
  assert.strictEqual(T.ENABLED, false);
  assert.strictEqual((await T.postCapture(env, { endpoint: "https://edsip.example", token: "t" })).skipped, true);
  let req; const ff = async (u, o) => { req = { u, o }; return { ok: true, status: 200, json: async () => ({ accepted: 2 }) }; };
  const r = await T.postCapture(env, { endpoint: "https://edsip.example", token: "tok", fetchFn: ff, enabled: true });
  assert.strictEqual(req.u, "https://edsip.example/api/marketplaces/captures");
  assert.deepStrictEqual([req.o.headers["X-EDSIP-Extension-Token"], req.o.credentials, r.response.accepted], ["tok", "omit", 2]);
  console.log("v2_security.test.js: OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
