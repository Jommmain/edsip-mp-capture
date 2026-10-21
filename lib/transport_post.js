// ============================================================================================
//  STAGE 2 TRANSPORT STUB — DISABLED. Stage 1 = file in inbox (popup "Сохранить").
//  Not loaded by any page, no host_permissions for an EDSIP domain, nothing calls it.
//  To enable later: set ENABLED=true, add the EDSIP domain to host_permissions, load this file in
//  popup.html and call postCapture() after a successful save (file stays the fallback).
// ============================================================================================
(function (root) {
  const ENABLED = false;
  const DEFAULT_PATH = "/api/marketplaces/captures"; // contract §4 (synonym: /api/marketplaces/ingest)
  const MAX_BYTES = 20 * 1024 * 1024, MAX_RECORDS = 5000;
  async function postCapture(envelope, { endpoint, token, fetchFn = fetch, enabled = ENABLED } = {}) {
    if (!enabled) return { ok: false, skipped: true, reason: "stage 2 POST disabled" };
    if (!endpoint || !token) return { ok: false, reason: "no endpoint/token" };
    if ((envelope.records || []).length > MAX_RECORDS) return { ok: false, reason: "too many records (split by query)" };
    const body = JSON.stringify(envelope);
    if (body.length > MAX_BYTES) return { ok: false, reason: "body > 20 MB (split by query)" };
    const r = await fetchFn(new URL(DEFAULT_PATH, endpoint).toString(), { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", "X-EDSIP-Extension-Token": token }, body });
    let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
    return { ok: r.ok, status: r.status, response: j };
  }
  const api = { ENABLED, DEFAULT_PATH, postCapture };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipTransportPost = api;
})(typeof self !== "undefined" ? self : this);
