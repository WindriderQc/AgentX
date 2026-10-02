/**
 * responseEnvelope — normalize agentx-data API responses to the canonical
 * AgentX envelope while preserving the legacy shape during transition.
 *
 * Canonical:
 *   success: { ok: true,  data,  ... }
 *   error:   { ok: false, error, ... }
 *
 * Legacy (still emitted for back-compat with core data-proxy + frontend):
 *   success: { status: 'success', message?, data? }
 *   error:   { status: 'error',   message }
 *
 * This middleware wraps res.json so EVERY route gets both vocabularies without
 * touching ~171 inline call sites. It is purely additive: the data payload is
 * never altered, only envelope-level companion fields are filled in.
 *
 * Rules (only applied to plain-object bodies that look like an API envelope):
 *   - body.status === 'success'  -> ensure body.ok = true
 *   - body.status === 'error'    -> ensure body.ok = false; mirror message -> error
 *   - body.ok === true  (no status) -> ensure body.status = 'success'
 *   - body.ok === false (no status) -> ensure body.status = 'error';
 *                                       mirror error -> message
 * Bodies that are arrays, null, or carry neither `status` nor `ok` are passed
 * through unchanged (raw payloads, health, etc.).
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeEnvelope(body) {
  if (!isPlainObject(body)) return body;

  const hasStatus = typeof body.status === 'string';
  const hasOk = typeof body.ok === 'boolean';

  // Only touch bodies that already express success/failure as an envelope.
  if (!hasStatus && !hasOk) return body;

  if (hasStatus) {
    if (body.status === 'success' && body.ok === undefined) body.ok = true;
    if (body.status === 'error') {
      if (body.ok === undefined) body.ok = false;
      if (body.error === undefined && typeof body.message === 'string') {
        body.error = body.message;
      }
    }
  } else if (hasOk) {
    if (body.ok === true && body.status === undefined) body.status = 'success';
    if (body.ok === false) {
      if (body.status === undefined) body.status = 'error';
      if (body.message === undefined && typeof body.error === 'string') {
        body.message = body.error;
      }
    }
  }

  return body;
}

function responseEnvelope(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(normalizeEnvelope(body));
  next();
}

module.exports = responseEnvelope;
module.exports.normalizeEnvelope = normalizeEnvelope;
