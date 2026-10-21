// Isolated world: relay records from page_hook.js to the service worker; perform ONE scroll step on request.
// No DOM scraping of data, no own requests: scrolling only moves the viewport, the site loads its own data.
// Pacing lives in background.js (worker timers are not throttled in background tabs).
// Private channel with page_hook.js: per-document random nonce + MessageChannel (page scripts never see records).
// window messages are accepted only as a "hello" from this window/origin and only to (re)send the single init.
const NONCE = crypto.getRandomValues(new Uint32Array(4)).join("-");
const channel = new MessageChannel();
let initSent = false;
function sendInit() {
  if (initSent) return;
  initSent = true;
  window.postMessage({ __edsip_init: 1, nonce: NONCE }, location.origin, [channel.port2]);
}
channel.port1.onmessage = (ev) => {
  const d = ev.data;
  if (!d || d.nonce !== NONCE || !d.record || typeof d.record.url !== "string") return;
  const r = d.record;
  const rec = { url: r.url, marketplace: r.marketplace, kind: r.kind, status: r.status | 0, redirected: !!r.redirected,
    ts: String(r.ts || ""), body: typeof r.body === "string" ? r.body : null, page_host: location.host };
  try { chrome.runtime.sendMessage({ type: "record", record: rec }); } catch (e) { /* extension reloaded */ }
};
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.__edsip_hello !== 1) return;
  sendInit();
});
sendInit();

const MP = /ozon\./.test(location.host) ? "ozon" : "wb";
const rnd = (a, b) => a + Math.random() * (b - a);
const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 50;
function pageQuery() {
  const u = new URL(location.href);
  return u.searchParams.get(MP === "ozon" ? "text" : "search") || u.searchParams.get("query") || null;
}

// Captcha / antibot page detection (read-only look at the visible page; nothing is clicked or solved).
const BLOCK_TEXT = /(подтвердите, что вы не робот|я не робот|введите символы|доступ ограничен|подозрительн\w+ активност|проверка браузера|captcha|are you a robot|access denied|too many requests)/i;
function detectBlock() {
  if (/\/__wbaas|\/antibot|\/abt\/|captcha/i.test(location.pathname)) return "антибот-страница";
  if (document.querySelector('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], iframe[src*="challenge" i]')) return "капча";
  const t = document.title + " " + (document.body ? document.body.innerText.slice(0, 3000) : "");
  if (BLOCK_TEXT.test(t)) return "капча/антибот (текст страницы)";
  return null;
}

function step() {
  const block = detectBlock();
  if (!block) {
    // Human-like: varying step, occasional small scroll back. Hidden tabs do not animate -> instant scroll.
    const s = window.innerHeight * rnd(0.45, 0.95);
    window.scrollBy({ top: Math.random() < 0.08 ? -s * 0.3 : s, behavior: document.hidden ? "auto" : "smooth" });
    // Sites lazy-load on scroll events; in a hidden tab smooth-scroll is skipped, so make sure one fires.
    if (document.hidden) window.dispatchEvent(new Event("scroll"));
  }
  return { block, path: location.pathname, height: document.documentElement.scrollHeight, atBottom: atBottom(),
    query: pageQuery(), hidden: document.visibilityState === "hidden", marketplace: MP };
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === "visibility") reply({ hidden: document.visibilityState === "hidden" });
  else if (msg.type === "scroll_ping") reply({ marketplace: MP, query: pageQuery(), height: document.documentElement.scrollHeight, title: document.title });
  else if (msg.type === "scroll_step") reply(step());
});

document.addEventListener("visibilitychange", () => {
  try { chrome.runtime.sendMessage({ type: "visibility", hidden: document.visibilityState === "hidden" }); } catch (e) { /* ignore */ }
});
