/**
 * Shared API response helpers — canonical AgentX envelope for agentx-data.
 *
 * Canonical envelope:
 *   success: { ok: true,  data, ...extra }
 *   error:   { ok: false, error, ...extra }
 *
 * Transition note: agentx-data historically emitted `{ status: 'success'|'error',
 * message, data }`. During the migration these helpers (and the
 * `responseEnvelope` middleware) emit BOTH the canonical `ok`/`error` fields and
 * the legacy `status`/`message` fields so existing consumers (core data-proxy +
 * frontend, e.g. live-data-dashboard.js) keep working. New code should read `ok`.
 */

function sendOk(res, data, extra = {}) {
  return res.json({ ok: true, status: 'success', data, ...extra });
}

function sendError(res, statusCode, message, extra = {}) {
  return res
    .status(statusCode)
    .json({ ok: false, status: 'error', error: message, message, ...extra });
}

module.exports = { sendOk, sendError };
