'use strict';
const STATUSES = new Set([400, 401, 402, 403, 404, 422, 429]);
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
// The authenticated native boundary returns this bounded transport receipt.
// It carries neither provider error bodies nor user/model content.
function nativeRefusal(value) {
  if (value?.schema !== 'agentx.openclaw-refusal-receipt/v1' || !STATUSES.has(value.httpStatus)
    || value.executionState !== 'not-dispatched' || value.modelHttpRequests !== 1
    || typeof value.requestId !== 'string' || value.requestId.length > 160
    || typeof value.model !== 'string' || value.model.length > 160
    || !Number.isFinite(Date.parse(value.observedAt)) || !/^[a-f0-9]{64}$/.test(value.targetFingerprint || '')
    || value.cost?.nanodollars !== 0 || value.cost?.source !== 'native-http-refusal' || value.cost?.currency !== 'USD') return null;
  const diagnostic = value.diagnostic || {};
  return { schema: value.schema, requestId: value.requestId, model: value.model,
    runtimeVersion: typeof value.runtimeVersion === 'string' ? value.runtimeVersion.slice(0, 40) : null,
    targetFingerprint: value.targetFingerprint, httpStatus: value.httpStatus, observedAt: value.observedAt,
    modelHttpRequests: 1, executionState: 'not-dispatched', cost: { nanodollars: 0, source: 'native-http-refusal', currency: 'USD' },
    diagnostic: { code: safeCode(diagnostic.code), type: safeCode(diagnostic.type), parameter: safeCode(diagnostic.parameter),
      category: ['billing', 'request'].includes(diagnostic.category) ? diagnostic.category : null } };
}
module.exports = { nativeRefusal };
