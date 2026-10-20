// node tests/saving_update.test.js — naming/paths, unzip, version compare, GitHub release check, self-update on a mock FS.
const assert = require("assert"), path = require("path"), fs = require("fs");
const S = require(path.join(__dirname, "..", "lib", "saving.js"));
const { unzip } = require(path.join(__dirname, "..", "lib", "unzip.js"));
const U = require(path.join(__dirname, "..", "lib", "updater.js"));

// ---- in-memory File System Access API ----
class FFile { constructor(d) { this.d = d; } async text() { return Buffer.from(this.d).toString("utf8"); } async arrayBuffer() { return this.d; } }
class FH { constructor(n, p) { this.kind = "file"; this.name = n; this.p = p; }
  async getFile() { return new FFile(this.p.files.get(this.name)); }
  async createWritable() { const c = []; return { write: async (x) => c.push(typeof x === "string" ? Buffer.from(x) : Buffer.from(x instanceof ArrayBuffer ? new Uint8Array(x) : x)),
    close: async () => this.p.files.set(this.name, new Uint8Array(Buffer.concat(c))) }; } }
class DH { constructor(n) { this.kind = "directory"; this.name = n; this.files = new Map(); this.dirs = new Map(); }
  async getFileHandle(n, o = {}) { if (!this.files.has(n)) { if (!o.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); this.files.set(n, new Uint8Array()); } return new FH(n, this); }
  async getDirectoryHandle(n, o = {}) { if (!this.dirs.has(n)) { if (!o.create) throw new Error("nf"); this.dirs.set(n, new DH(n)); } return this.dirs.get(n); }
  async removeEntry(n) { if (!this.files.delete(n) && !this.dirs.delete(n)) throw new Error("nf"); }
  async *entries() { for (const n of this.files.keys()) yield [n, new FH(n, this)]; for (const [n, d] of this.dirs) yield [n, d]; } }
const put = (d, n, t) => d.files.set(n, new Uint8Array(Buffer.from(t)));
const txt = (d, n) => Buffer.from(d.files.get(n)).toString("utf8");

(async () => {
  // naming
  const d = new Date(2026, 9, 20, 13, 7, 9);
  assert.strictEqual(S.fileName("wb", "Корм для кошек!", d, 1), "wb_корм_для_кошек_2026-10-20_13-07-09.json");
  assert.strictEqual(S.fileName("ozon", "", d, 2), "ozon_noquery_2026-10-20_13-07-09_run2.json");
  assert.strictEqual(S.cleanSubfolder(" /../EDSIP\\\\inbox/./x:y "), "EDSIP/inbox/x_y");
  assert.strictEqual(S.subPath({ subfolder: "EDSIP/inbox", perMarketplace: true }, "ozon"), "EDSIP/inbox/ozon");
  assert.strictEqual(S.subPath({ subfolder: "", perMarketplace: false }, "wb"), "");
  const taken = new Set([S.fileName("wb", "a", d, 1), S.fileName("wb", "a", d, 2)]);
  assert.strictEqual(await S.freeName("wb", "a", d, (n) => taken.has(n)), "wb_a_2026-10-20_13-07-09_run3.json");

  // unzip (stored + deflate)
  const files = await unzip(fs.readFileSync(path.join(__dirname, "fixture-update.zip")));
  assert.deepStrictEqual(Object.keys(files).sort(), ["icons/icon16.png", "manifest.json", "popup.js"]);
  assert.ok(Buffer.from(files["popup.js"]).toString().startsWith("console.log('новый');"));
  assert.strictEqual(files["icons/icon16.png"].length, 4 + 256 * 20);

  // versions + release API
  assert.strictEqual(U.cmpVersions("0.5.0", "0.4.12"), 1); assert.strictEqual(U.cmpVersions("v0.5", "0.5.0"), 0); assert.strictEqual(U.cmpVersions("0.4.2", "0.5.0"), -1);
  let seen;
  const fakeFetch = async (url, o) => { seen = { url, o };
    if (url.endsWith("/releases/latest")) return !fakeFetch.limited ? { ok: true, status: 200, json: async () => ({ tag_name: "v0.6.0", html_url: "h",
      assets: [{ name: "notes.txt" }, { name: "edsip-mp-capture-0.6.0.zip", url: "https://api.github.com/repos/x/releases/assets/1", size: 5 }] }) } : { ok: false, status: 403 };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }; };
  const anon = await U.latestRelease(null, fakeFetch); // public repo: no token needed
  assert.strictEqual(anon.version, "0.6.0"); assert.strictEqual(seen.o.headers.Authorization, undefined);
  fakeFetch.limited = true;
  await assert.rejects(U.latestRelease(null, fakeFetch), /лимит GitHub API/);
  fakeFetch.limited = false;
  const rel = await U.latestRelease("tok", fakeFetch);
  assert.strictEqual(rel.version, "0.6.0"); assert.strictEqual(rel.asset.name, "edsip-mp-capture-0.6.0.zip");
  assert.strictEqual(seen.o.headers.Authorization, "Bearer tok");
  await U.downloadAsset(rel.asset, "tok", fakeFetch);
  assert.strictEqual(seen.o.headers.Accept, "application/octet-stream");

  // self-update into the extension folder
  const ext = new DH("edsip-mp-capture");
  assert.strictEqual((await U.verifyExtDir(ext)).ok, false);
  put(ext, "manifest.json", JSON.stringify({ manifest_version: 3, name: "Other", version: "1" }));
  assert.match((await U.verifyExtDir(ext)).reason, /не папка/);
  put(ext, "manifest.json", JSON.stringify({ manifest_version: 3, name: "EDSIP MP Capture", version: "0.5.0" }));
  put(ext, "popup.js", "old"); put(ext, "obsolete.js", "gone");
  (await ext.getDirectoryHandle("tests", { create: true })); put(ext.dirs.get("tests"), "t.js", "keep");
  const v = await U.verifyExtDir(ext);
  assert.deepStrictEqual([v.ok, v.version, v.git], [true, "0.5.0", false]);
  const r = await U.applyUpdate(ext, files);
  assert.strictEqual(r.version, "9.9.9"); assert.deepStrictEqual(r.removed, ["obsolete.js"]);
  assert.ok(txt(ext, "popup.js").startsWith("console.log('новый')"));
  assert.ok(ext.dirs.get("icons").files.has("icon16.png"));
  const prev = ext.dirs.get(".prev");
  assert.strictEqual(txt(prev, "popup.js"), "old"); assert.strictEqual(txt(prev, "obsolete.js"), "gone"); assert.ok(!prev.dirs.has("tests"));
  assert.ok(ext.dirs.get("tests").files.has("t.js")); // dev folders untouched
  // second update replaces the backup, not nests it
  await U.applyUpdate(ext, files);
  assert.ok(!ext.dirs.get(".prev").dirs.has(".prev"));
  // reject foreign archive
  await assert.rejects(U.applyUpdate(ext, { "manifest.json": Buffer.from(JSON.stringify({ manifest_version: 2, name: "x" })) }), /не похож/);
  ext.dirs.set(".git", new DH(".git"));
  assert.strictEqual((await U.verifyExtDir(ext)).git, true);
  console.log("saving_update.test.js: OK");
})().catch((e) => { console.error(e); process.exit(1); });
