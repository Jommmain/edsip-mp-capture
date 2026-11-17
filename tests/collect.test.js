// «Собрать витрину»: URL-list planning (lib/collect.js). Plain node, no Chrome.
const assert = require("assert");
const C = require("../lib/collect.js");

const WB = "https://www.wildberries.by/catalog/0/search.aspx?search=%D0%BA%D0%BE%D1%80%D0%BC%20royal%20canin";
const WBRU = "https://www.wildberries.ru/catalog/0/search.aspx?search=eukanuba";
const OZ = "https://www.ozon.ru/search/?text=royal%20canin&from_global=true";

const plan = C.parsePlan([WB, "# комментарий", WBRU, "", WB, "https://example.com/x", OZ].join("\n"), { dwell: 3 });
assert.deepStrictEqual(plan.urls.map((u) => u.marketplace), ["wb", "wb", "ozon"]);
assert.strictEqual(plan.urls.length, 3);
assert.deepStrictEqual(plan.rejected.map((r) => r.reason), ["дубликат", "не WB/Ozon"]);
assert.strictEqual(plan.dwell, 5, "dwell зажимается снизу до 5");

const clamp = C.parsePlan(WB, { dwell: 999 });
assert.strictEqual(clamp.dwell, 120, "dwell зажимается сверху до 120");
const def = C.parsePlan(WB);
assert.strictEqual(def.dwell, C.DEFAULT_DWELL_S);

const empty = C.parsePlan("только мусор\nhttps://google.com");
assert.strictEqual(empty.urls.length, 0);
assert.strictEqual(empty.rejected.length, 2);

assert.strictEqual(C.marketplaceOf("https://wildberries.by/x"), null, "без www не пропускаем (как в TAB_URL)");
assert.strictEqual(C.marketplaceOf("https://www.ozon.by/search/?text=x"), "ozon");

console.log("collect.test.js: OK");
