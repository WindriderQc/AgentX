'use strict';

// Only an authenticated, same-run Responses terminal event is a receipt.
// Network errors, EOF and missing agent_end hooks remain uncertain. Retain no
// provider error text: it can contain private URLs or credential diagnostics.
function nativeResponseFailure(event, sessionKey, runId) {
  if (!/^resp_[a-f0-9-]{36}$/.test(runId || '') || event.response?.id !== runId
      || !['response.failed', 'response.incomplete'].includes(event.type)) return null;
  const detail = event.response?.error?.message || '';
  if (/cannot be represented as an append-only response stream/i.test(detail)) return null;
  return { source: 'openclaw/responses', sessionKey, runId, event: event.type,
    reason: /\b(?:auth(?:entication)? (?:failed|issue)|token has expired|re-authenticate)\b/i.test(detail)
      ? 'native_authentication_failed' : event.type === 'response.incomplete' ? 'native_response_incomplete' : 'native_response_failed' };
}

module.exports = { nativeResponseFailure };
