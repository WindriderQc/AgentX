'use strict';

const CONTRACT = 'agentx.queue-launch/v1';
const UUID = /^[a-f0-9-]{36}$/;
const line = (value, fallback, max) => String(value || fallback).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) || fallback;

// Produced only at an executor boundary that proves no native work started.
// An HTTP status, timeout or missing lookup by itself is not this proof.
function refusal(requestId, kind, error) {
  if (!UUID.test(requestId || '') || error?.notStarted !== true) return null;
  return { contract: CONTRACT, requestId, kind, outcome: 'not-started',
    code: line(error.code, 'LAUNCH_REFUSED', 100), reason: line(error.message, 'Launch refused', 1000) };
}
function readRefusal(body, job) {
  const receipt = body?.launchReceipt;
  return receipt?.contract === CONTRACT && receipt.requestId === job.id && receipt.kind === job.kind
    && receipt.outcome === 'not-started' && typeof receipt.code === 'string' && receipt.code.trim().length > 0
    && receipt.code.length <= 100 && typeof receipt.reason === 'string' && receipt.reason.length > 0
    && receipt.reason.trim().length > 0 && receipt.reason.length <= 1000 && !/[\x00-\x1f\x7f]/.test(receipt.code + receipt.reason) ? receipt : null;
}
// Producer-side transport: persist before returning the refusal, so losing
// the native HTTP reply does not lose the verdict. No native effect is retried.
async function publishRefusal(receipt, dispatchId, post) {
  if (!receipt || !UUID.test(dispatchId || '')) return;
  return post(`/api/cluster/schedule/work-queue/${receipt.requestId}/refused`, {
    dispatchId, code: receipt.code, reason: receipt.reason
  });
}
module.exports = { CONTRACT, refusal, readRefusal, publishRefusal };
