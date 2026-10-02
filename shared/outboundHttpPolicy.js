'use strict';

const {
  OUTBOUND_ERROR_CODES,
  isSafeSinkId,
  outboundError,
} = require('./outboundHttpErrors');

const OPERATION_POLICY_FIELDS = Object.freeze([
  'authoritySource',
  'deadlineMs',
  'maxRequestBytes',
  'maxResponseBytes',
]);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const AUTHORITY_SOURCES = new Set(['canonical', 'configured', 'request-admitted']);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  ':authority',
  'connection',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseExpectedOrigin(value, sinkId) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }
  return parsed.origin;
}

function normalizeOperationPolicy(sinkId, policy) {
  if (!isSafeSinkId(sinkId) || !sameKeys(policy, OPERATION_POLICY_FIELDS)) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  const { authoritySource, deadlineMs, maxRequestBytes, maxResponseBytes } = policy;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_TIMER_DELAY_MS
    || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 0
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0
    || !AUTHORITY_SOURCES.has(authoritySource)) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  return Object.freeze({
    sinkId,
    authoritySource,
    deadlineMs,
    maxRequestBytes,
    maxResponseBytes,
  });
}

function normalizeOperations(operations) {
  let entries;
  try {
    if (operations instanceof Map) entries = [...operations.entries()];
    else if (isPlainObject(operations)) entries = Object.entries(operations);
    else throw new TypeError('invalid operations');
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID);
  }
  if (entries.length === 0) throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID);

  const normalized = new Map();
  for (const [sinkId, policy] of entries) {
    if (normalized.has(sinkId)) throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    normalized.set(sinkId, normalizeOperationPolicy(sinkId, policy));
  }
  return normalized;
}

function parseCandidateTarget(target, sinkId) {
  let parsed;
  try {
    parsed = target instanceof URL ? new URL(target.href) : new URL(target);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }
  return parsed;
}

function isAbortSignal(value) {
  try {
    return value === undefined
      || value === null
      || (typeof value === 'object'
        && typeof value.aborted === 'boolean'
        && typeof value.addEventListener === 'function'
        && typeof value.removeEventListener === 'function');
  } catch {
    return false;
  }
}

function normalizeRequestHeaders(headers, sinkId) {
  if (headers === undefined || headers === null) return undefined;

  let entries;
  try {
    if (Array.isArray(headers)) {
      entries = headers;
    } else if (typeof headers?.[Symbol.iterator] === 'function') {
      entries = [...headers];
    } else if (isPlainObject(headers)) {
      entries = Object.entries(headers);
    } else {
      throw new TypeError('invalid headers');
    }
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  const normalized = Object.create(null);
  try {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('invalid header');
      const name = String(entry[0]).trim().toLowerCase();
      const value = Array.isArray(entry[1])
        ? entry[1].map((item) => String(item)).join(', ')
        : String(entry[1]);
      if (!HEADER_NAME_PATTERN.test(name)
        || FORBIDDEN_REQUEST_HEADERS.has(name)
        || /[\0\r\n]/.test(value)) {
        throw new TypeError('unsafe header');
      }
      normalized[name] = Object.hasOwn(normalized, name)
        ? `${normalized[name]}, ${value}`
        : value;
    }
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }
  return Object.freeze(normalized);
}

function sanitizeFetchInit(options, sinkId) {
  let plain;
  try {
    plain = isPlainObject(options);
  } catch {
    plain = false;
  }
  if (!plain) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  let callerSignal;
  let fetchInit;
  try {
    const {
      signal,
      redirect: _redirect,
      agent: _agent,
      dispatcher: _dispatcher,
      headers,
      ...rest
    } = options;
    callerSignal = signal;
    const normalizedHeaders = normalizeRequestHeaders(headers, sinkId);
    fetchInit = normalizedHeaders === undefined
      ? rest
      : { ...rest, headers: normalizedHeaders };
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  if (!isAbortSignal(callerSignal)) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }
  if (Object.hasOwn(options, 'policy')
    || Object.hasOwn(options, 'expectedOrigin')
    || Object.hasOwn(options, 'admittedTarget')) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }
  return { callerSignal, fetchInit };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (typeof headers !== 'object') return null;
  if (Array.isArray(headers)) {
    const entry = headers.find((candidate) => Array.isArray(candidate)
      && String(candidate[0]).toLowerCase() === name);
    return entry ? entry[1] : null;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? null : headers[key];
  return Array.isArray(value) ? value.join(',') : value;
}

module.exports = {
  headerValue,
  isAbortSignal,
  isPlainObject,
  normalizeOperations,
  parseCandidateTarget,
  parseExpectedOrigin,
  sameKeys,
  sanitizeFetchInit,
};
