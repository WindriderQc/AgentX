'use strict';

const OUTBOUND_ERROR_CODES = Object.freeze({
  POLICY_INVALID: 'OUTBOUND_POLICY_INVALID',
  OPERATION_UNKNOWN: 'OUTBOUND_OPERATION_UNKNOWN',
  TARGET_REJECTED: 'OUTBOUND_TARGET_REJECTED',
  AUTHORITY_ADAPTER_REQUIRED: 'OUTBOUND_AUTHORITY_ADAPTER_REQUIRED',
  ADMISSION_INVALID: 'OUTBOUND_ADMISSION_INVALID',
  TRANSPORT_ADAPTER_REQUIRED: 'OUTBOUND_TRANSPORT_ADAPTER_REQUIRED',
  PEER_UNVERIFIED: 'OUTBOUND_PEER_UNVERIFIED',
  CALLER_ABORTED: 'OUTBOUND_CALLER_ABORTED',
  DEADLINE_EXCEEDED: 'OUTBOUND_DEADLINE_EXCEEDED',
  REQUEST_FAILED: 'OUTBOUND_REQUEST_FAILED',
  INVALID_RESPONSE: 'OUTBOUND_INVALID_RESPONSE',
  REDIRECT_REJECTED: 'OUTBOUND_REDIRECT_REJECTED',
  REQUEST_TOO_LARGE: 'OUTBOUND_REQUEST_TOO_LARGE',
  REQUEST_BODY_UNBOUNDED: 'OUTBOUND_REQUEST_BODY_UNBOUNDED',
  REQUEST_LENGTH_MISMATCH: 'OUTBOUND_REQUEST_LENGTH_MISMATCH',
  RESPONSE_TOO_LARGE: 'OUTBOUND_RESPONSE_TOO_LARGE',
  RESPONSE_UNREADABLE: 'OUTBOUND_RESPONSE_UNREADABLE',
  INVALID_JSON: 'OUTBOUND_INVALID_JSON',
  BODY_ALREADY_USED: 'OUTBOUND_BODY_ALREADY_USED',
  RESPONSE_CANCELLED: 'OUTBOUND_RESPONSE_CANCELLED',
});

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  [OUTBOUND_ERROR_CODES.POLICY_INVALID]: 'The outbound request policy is invalid.',
  [OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN]: 'The outbound operation is not registered.',
  [OUTBOUND_ERROR_CODES.TARGET_REJECTED]: 'The outbound request target was rejected.',
  [OUTBOUND_ERROR_CODES.AUTHORITY_ADAPTER_REQUIRED]: 'An outbound authority admission adapter is required.',
  [OUTBOUND_ERROR_CODES.ADMISSION_INVALID]: 'The outbound target admission is invalid or already used.',
  [OUTBOUND_ERROR_CODES.TRANSPORT_ADAPTER_REQUIRED]: 'A peer-verifying outbound transport is required.',
  [OUTBOUND_ERROR_CODES.PEER_UNVERIFIED]: 'The outbound transport could not verify the connected peer.',
  [OUTBOUND_ERROR_CODES.CALLER_ABORTED]: 'The outbound request was cancelled.',
  [OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED]: 'The outbound request exceeded its deadline.',
  [OUTBOUND_ERROR_CODES.REQUEST_FAILED]: 'The outbound request failed.',
  [OUTBOUND_ERROR_CODES.INVALID_RESPONSE]: 'The outbound service returned an invalid response.',
  [OUTBOUND_ERROR_CODES.REDIRECT_REJECTED]: 'The outbound service returned a redirect.',
  [OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE]: 'The outbound request exceeded its byte limit.',
  [OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED]: 'The outbound request body must be pre-sized.',
  [OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH]: 'The outbound request body length is inconsistent.',
  [OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE]: 'The outbound response exceeded its byte limit.',
  [OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE]: 'The outbound response could not be read.',
  [OUTBOUND_ERROR_CODES.INVALID_JSON]: 'The outbound service returned invalid JSON.',
  [OUTBOUND_ERROR_CODES.BODY_ALREADY_USED]: 'The outbound response body was already consumed.',
  [OUTBOUND_ERROR_CODES.RESPONSE_CANCELLED]: 'The outbound response was cancelled.',
});

const ERROR_CODE_SET = new Set(Object.values(OUTBOUND_ERROR_CODES));

const SINK_ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

class OutboundHttpError extends Error {
  constructor(code, { sinkId, status } = {}) {
    const safeCode = ERROR_CODE_SET.has(code) ? code : OUTBOUND_ERROR_CODES.REQUEST_FAILED;
    super(PUBLIC_ERROR_MESSAGES[safeCode]);
    this.name = 'OutboundHttpError';
    this.code = safeCode;
    if (isSafeSinkId(sinkId)) this.sinkId = sinkId;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    Error.captureStackTrace?.(this, OutboundHttpError);
  }

  toJSON() {
    return toPublicOutboundError(this);
  }
}

function isSafeSinkId(value) {
  return typeof value === 'string'
    && value.length <= 160
    && SINK_ID_PATTERN.test(value);
}

function outboundError(code, sinkId, status) {
  return new OutboundHttpError(code, { sinkId, status });
}

function toPublicOutboundError(error) {
  const code = error instanceof OutboundHttpError && ERROR_CODE_SET.has(error.code)
    ? error.code
    : OUTBOUND_ERROR_CODES.REQUEST_FAILED;
  return Object.freeze({
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
  });
}

module.exports = {
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  isSafeSinkId,
  outboundError,
  toPublicOutboundError,
};
