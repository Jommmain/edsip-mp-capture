// ============================================================================================
//  STAGE 2 TRANSPORT — upload to the local EDSIP API (POST /api/marketplaces/captures).
//  Stage 1 (file in inbox) stays the fallback: a failed upload still leaves the file on disk.
//  Settings (url + token) live in chrome.storage.local.apiSettings; nothing is sent anywhere
//  except the configured EDSIP endpoint. credentials: "omit" — no cookies, no auth.
// ============================================================================================
(function (root) {
  const ENABLED = true;
  const DEFAULT_PATH = "/api/marketplaces/captures"; // contract §4 (synonym: /api/marketplaces/ingest)
  const MAX_BYTES = 20 * 1024 * 1024, MAX_RECORDS = 5000;
  async function postCapture(envelope, { endpoint, token, fetchFn = fetch, enabled = ENABLED } = {}) {
    if (!enabled) return { ok: false, skipped: true, reason: "stage 2 POST disabled" };
    if (!endpoint || !token) return { ok: false, reason: "no endpoint/token" };
    const body = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
    const records = typeof envelope === "string" ? null : (envelope.records || []);
    if (records && records.length > MAX_RECORDS) return { ok: false, reason: "too many records (split by query)" };
    if (body.length > MAX_BYTES) return { ok: false, reason: "body > 20 MB (split by query)" };
    let r;
    try {
      r = await fetchFn(new URL(DEFAULT_PATH, endpoint).toString(), { method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", "X-EDSIP-Extension-Token": token }, body });
    } catch (e) {
      return { ok: false, reason: "network: " + (e && e.message ? e.message : String(e)) };
    }
    let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
    return { ok: r.ok, status: r.status, response: j };
  }
  const api = { ENABLED, DEFAULT_PATH, postCapture };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipTransportPost = api;
})(typeof self !== "undefined" ? self : this);
