// Runs page_hook.js in a vm with a fake window; performs the content.js handshake (MessageChannel + nonce).
const fs = require("fs"), vm = require("vm"), path = require("path");
function loadHook(origin = "https://www.wildberries.by", { handshake = true } = {}) {
  const listeners = [], windowPosts = [], records = [];
  const win = {
    addEventListener: (t, f) => { if (t === "message") listeners.push(f); },
    removeEventListener: (t, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    postMessage: (data) => windowPosts.push(data),
  };
  const dispatch = (data, ports = [], src = win, org = origin) => {
    let stopped = false;
    const ev = { data, ports, source: src, origin: org, stopImmediatePropagation: () => { stopped = true; } };
    for (const f of listeners.slice()) { if (stopped) break; f(ev); }
    return stopped;
  };
  let next = { status: 200, text: "{}" };
  const fetchFn = async (url) => ({ url, status: next.status, redirected: false, clone() { return this; }, text: async () => next.text });
  win.fetch = fetchFn;
  const ctx = { window: win, location: { href: origin + "/", origin }, URL, JSON, Date, XMLHttpRequest: function () {} };
  ctx.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  ctx.fetch = fetchFn;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "page_hook.js"), "utf8").replace(/window\.fetch/g, "fetch"), ctx);
  const ch = new MessageChannel();
  const nonce = "n-" + Math.random();
  ch.port1.onmessage = (ev) => { if (ev.data.nonce === nonce) records.push(ev.data.record); };
  if (handshake) dispatch({ __edsip_init: 1, nonce }, [ch.port2]);
  return {
    records, windowPosts, dispatch, nonce, close: () => ch.port1.close(),
    async get(url, text, status = 200) { next = { text: typeof text === "string" ? text : JSON.stringify(text), status }; await ctx.fetch(url); await new Promise((r) => setTimeout(r, 15)); },
  };
}
module.exports = { loadHook };
