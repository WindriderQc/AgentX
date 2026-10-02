'use strict';

/**
 * Shared, policy-driven outbound HTTP execution primitives.
 *
 * Fetch does not expose the connected socket peer in a portable way.  This
 * module therefore requires a transport adapter for dispatch.  The adapter is
 * responsible for DNS policy and connect-time peer enforcement (for example,
 * through a pinned node-fetch Agent or an Undici Dispatcher) and must return
 * the explicit CONNECT_TIME_PEER_VERIFICATION attestation.  A DNS lookup made
 * before an ordinary fetch is not sufficient because it introduces a TOCTOU
 * window.
 */

const {
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  isSafeSinkId,
  outboundError,
  toPublicOutboundError,
} = require('./outboundHttpErrors');
const {
  isAbortSignal,
  isPlainObject,
  normalizeOperations,
  parseCandidateTarget,
  parseExpectedOrigin,
  sameKeys,
  sanitizeFetchInit,
} = require('./outboundHttpPolicy');
const { createLifecycle } = require('./outboundHttpLifecycle');
const {
  ownRequestContentLength,
  snapshotRequestBody,
  validateRequestBody,
} = require('./outboundHttpRequestBody');
const {
  MANAGED_RESPONSE_CONSTRUCTOR_TOKEN,
  ManagedOutboundResponse,
  cancelRawResponse,
  discardBoundedResponse,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
  validateResponse,
} = require('./outboundHttpResponse');

const CONNECT_TIME_PEER_VERIFICATION = 'connect-time';

function createOutboundHttpExecutor({
  authorityAdapter,
  fetchImpl = globalThis.fetch,
  operations,
  transportAdapter,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Outbound HTTP execution requires a Fetch-compatible function.');
  }
  const operationPolicies = normalizeOperations(operations);
  const admissions = new WeakMap();

  const admitTarget = async (sinkId, target, options = {}) => {
    if (!isSafeSinkId(sinkId)) {
      throw outboundError(OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN);
    }
    const policy = operationPolicies.get(sinkId);
    if (!policy) throw outboundError(OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN, sinkId);
    if (typeof authorityAdapter !== 'function') {
      throw outboundError(OUTBOUND_ERROR_CODES.AUTHORITY_ADAPTER_REQUIRED, sinkId);
    }

    let callerSignal;
    try {
      if (!isPlainObject(options)
        || Object.keys(options).some((key) => key !== 'signal')) {
        throw new TypeError('invalid admission options');
      }
      callerSignal = options.signal;
    } catch {
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    }
    if (!isAbortSignal(callerSignal)) {
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    }

    const requestedUrl = parseCandidateTarget(target, sinkId);
    let lifecycle;
    try {
      lifecycle = createLifecycle(policy, callerSignal);
    } catch (error) {
      if (error instanceof OutboundHttpError) throw error;
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    }
    lifecycle.setAbortCleanup(() => lifecycle.close());

    try {
      lifecycle.throwIfAborted();
      let admission;
      try {
        admission = await lifecycle.race(Promise.resolve().then(() => authorityAdapter(Object.freeze({
          authoritySource: policy.authoritySource,
          signal: lifecycle.signal,
          sinkId,
          target: requestedUrl.href,
        }))));
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
      }

      let expectedOrigin;
      try {
        if (!sameKeys(admission, ['expectedOrigin'])) {
          throw new TypeError('invalid admission');
        }
        expectedOrigin = parseExpectedOrigin(admission.expectedOrigin, sinkId);
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
      }
      if (requestedUrl.origin !== expectedOrigin) {
        throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
      }

      lifecycle.throwIfAborted();
      const receipt = Object.freeze(Object.create(null));
      admissions.set(receipt, Object.freeze({
        expectedOrigin,
        lifecycle,
        policy,
        requestedUrl,
      }));
      return receipt;
    } catch (error) {
      lifecycle.close();
      if (error instanceof OutboundHttpError) throw error;
      throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
    }
  };

  const request = async (receipt, options = {}) => {
    const admission = receipt && typeof receipt === 'object' ? admissions.get(receipt) : null;
    if (!admission) throw outboundError(OUTBOUND_ERROR_CODES.ADMISSION_INVALID);
    // Receipts are capabilities for one dispatch only.  Consume before any
    // validation or await so concurrent/retry paths cannot replay them.
    admissions.delete(receipt);
    const {
      expectedOrigin,
      lifecycle,
      policy,
      requestedUrl,
    } = admission;

    try {
      const { callerSignal, fetchInit: sanitizedFetchInit } = sanitizeFetchInit(options, policy.sinkId);
      lifecycle.addCallerSignal(callerSignal);
      const snapshottedFetchInit = await snapshotRequestBody(
        sanitizedFetchInit,
        policy,
        lifecycle
      );
      const measuredLength = validateRequestBody(snapshottedFetchInit, policy);
      const fetchInit = ownRequestContentLength(snapshottedFetchInit, measuredLength);

      if (typeof transportAdapter !== 'function') {
        throw outboundError(OUTBOUND_ERROR_CODES.TRANSPORT_ADAPTER_REQUIRED, policy.sinkId);
      }

      lifecycle.throwIfAborted();
      const init = Object.freeze({
        ...fetchInit,
        redirect: 'manual',
        signal: lifecycle.signal,
      });
      const authority = Object.freeze({
        authoritySource: policy.authoritySource,
        expectedOrigin,
        hostname: requestedUrl.hostname,
        port: requestedUrl.port || (requestedUrl.protocol === 'https:' ? '443' : '80'),
        protocol: requestedUrl.protocol,
        sinkId: policy.sinkId,
      });

      const dispatchPromise = Promise.resolve().then(() => transportAdapter(Object.freeze({
        authority,
        fetchImpl,
        init,
        target: requestedUrl.href,
      })));

      // If a non-conforming adapter ignores the AbortSignal and resolves after
      // the deadline, cancel its late body rather than orphaning the socket.
      dispatchPromise.then(
        (result) => {
          try {
            if (lifecycle.aborted || lifecycle.closed) {
              void cancelRawResponse(result?.response);
            }
          } catch {
            // A malformed late adapter result must not create an unhandled
            // rejection after the request has already timed out.
          }
        },
        () => {}
      ).catch(() => {});

      let result;
      try {
        result = await lifecycle.race(dispatchPromise);
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_FAILED, policy.sinkId);
      }

      if (!result || typeof result !== 'object'
        || result.peerVerification !== CONNECT_TIME_PEER_VERIFICATION) {
        await cancelRawResponse(result?.response);
        throw outboundError(OUTBOUND_ERROR_CODES.PEER_UNVERIFIED, policy.sinkId);
      }

      const response = result.response;
      let status;
      try {
        status = validateResponse(response, policy, requestedUrl, expectedOrigin);
      } catch (error) {
        await cancelRawResponse(response);
        throw error instanceof OutboundHttpError
          ? error
          : outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId);
      }

      lifecycle.throwIfAborted();
      const managed = new ManagedOutboundResponse(
        MANAGED_RESPONSE_CONSTRUCTOR_TOKEN,
        { response, policy, lifecycle, status }
      );
      lifecycle.throwIfAborted();
      return managed;
    } catch (error) {
      lifecycle.close();
      if (error instanceof OutboundHttpError) throw error;
      throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_FAILED, policy.sinkId);
    }
  };

  return Object.freeze({ admitTarget, request });
}

module.exports = {
  CONNECT_TIME_PEER_VERIFICATION,
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  createOutboundHttpExecutor,
  discardBoundedResponse,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
  toPublicOutboundError,
};
