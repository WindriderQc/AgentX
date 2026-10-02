'use strict';

const {
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  outboundError,
} = require('./outboundHttpErrors');
const { headerValue } = require('./outboundHttpPolicy');

function responseBody(response) {
  try {
    return response?.body ?? null;
  } catch {
    return null;
  }
}

async function cancelRawBody(body) {
  if (!body) return;
  try {
    if (typeof body.cancel === 'function') {
      await body.cancel();
    } else if (typeof body.destroy === 'function') {
      body.destroy();
    } else if (typeof body.return === 'function') {
      await body.return();
    }
  } catch {
    // Cancellation is best-effort.  The composed AbortSignal remains the
    // authoritative way to terminate a conforming transport.
  }
}

async function cancelRawResponse(response) {
  await cancelRawBody(responseBody(response));
}

function declaredContentLength(response, sinkId) {
  let value;
  try {
    value = headerValue(response.headers, 'content-length');
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, sinkId);
  }
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, sinkId);
  }
  try {
    return BigInt(normalized);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, sinkId);
  }
}

function validateResponse(response, policy, requestedUrl, expectedOrigin) {
  let status;
  let redirected;
  let responseUrl;
  try {
    status = response?.status;
    redirected = response?.redirected;
    responseUrl = response?.url;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId);
  }

  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId);
  }
  if (redirected === true || (status >= 300 && status <= 399)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REDIRECT_REJECTED, policy.sinkId, status);
  }

  if (responseUrl) {
    let parsed;
    try {
      parsed = new URL(responseUrl);
    } catch {
      throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId, status);
    }
    if (parsed.origin !== expectedOrigin || parsed.href !== requestedUrl.href) {
      throw outboundError(OUTBOUND_ERROR_CODES.REDIRECT_REJECTED, policy.sinkId, status);
    }
  }

  const length = declaredContentLength(response, policy.sinkId);
  if (length !== null && length > BigInt(policy.maxResponseBytes)) {
    throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE, policy.sinkId, status);
  }
  return status;
}

function createBodySource(body) {
  let webReader = null;
  let nodeIterator = null;
  let ended = false;
  let cancellation = null;

  const next = async () => {
    if (ended || !body) return { done: true, value: undefined };
    if (typeof body.getReader === 'function') {
      webReader ||= body.getReader();
      const result = await webReader.read();
      if (result.done) ended = true;
      return result;
    }
    if (typeof body[Symbol.asyncIterator] === 'function') {
      nodeIterator ||= body[Symbol.asyncIterator]();
      const result = await nodeIterator.next();
      if (result.done) ended = true;
      return result;
    }
    throw new TypeError('unreadable response body');
  };

  const release = () => {
    try {
      webReader?.releaseLock?.();
    } catch {
      // The stream may already have released its lock while being cancelled.
    }
  };

  const cancel = () => {
    if (cancellation) return cancellation;
    ended = true;
    cancellation = (async () => {
      try {
        if (webReader?.cancel) await webReader.cancel();
        else if (webReader === null && typeof body?.cancel === 'function') await body.cancel();
        else if (nodeIterator?.return) await nodeIterator.return();
        else if (typeof body?.destroy === 'function') body.destroy();
      } catch {
        // Best-effort cancellation; request abort remains authoritative.
      } finally {
        release();
      }
    })();
    return cancellation;
  };

  const finish = () => {
    ended = true;
    release();
  };

  return Object.freeze({ cancel, finish, next });
}

function chunkBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value);
  throw new TypeError('unsupported response chunk');
}

const managedResponseState = new WeakMap();
const MANAGED_RESPONSE_CONSTRUCTOR_TOKEN = Object.freeze(Object.create(null));

function getManagedResponseState(response) {
  const state = response && typeof response === 'object'
    ? managedResponseState.get(response)
    : null;
  if (!state) throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE);
  return state;
}

function claimManagedBody(response) {
  const state = getManagedResponseState(response);
  if (state.bodyUsed) {
    throw outboundError(
      OUTBOUND_ERROR_CODES.BODY_ALREADY_USED,
      state.policy.sinkId,
      state.status
    );
  }
  state.lifecycle.throwIfAborted();
  state.bodyUsed = true;
  return state;
}

async function* iterateManagedBody(response) {
  let completed = false;
  const state = getManagedResponseState(response);
  const {
    lifecycle, policy, source, status,
  } = state;
  try {
    while (true) {
      let result;
      try {
        result = await lifecycle.race(source.next());
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE, policy.sinkId, status);
      }
      if (!result || typeof result.done !== 'boolean') {
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE, policy.sinkId, status);
      }
      if (result.done) {
        completed = true;
        source.finish();
        return;
      }

      let chunk;
      try {
        chunk = chunkBuffer(result.value);
      } catch {
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE, policy.sinkId, status);
      }
      state.bytesConsumed += chunk.byteLength;
      if (state.bytesConsumed > policy.maxResponseBytes) {
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE, policy.sinkId, status);
      }
      yield chunk;
    }
  } finally {
    if (!completed) await source.cancel();
    lifecycle.close();
  }
}

async function consumeManagedBytes(response) {
  const state = claimManagedBody(response);
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateManagedBody(response)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  try {
    return Buffer.concat(chunks, total);
  } catch {
    throw outboundError(
      OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE,
      state.policy.sinkId,
      state.status
    );
  }
}

async function discardBoundedResponse(response) {
  claimManagedBody(response);
  for await (const _chunk of iterateManagedBody(response)) {
    // Drain incrementally. iterateManagedBody owns byte accounting, deadline
    // enforcement, and cancellation, so no aggregate response is retained.
  }
}

class ManagedOutboundResponse {
  constructor(constructorToken, { response, policy, lifecycle, status } = {}) {
    if (constructorToken !== MANAGED_RESPONSE_CONSTRUCTOR_TOKEN) {
      throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE);
    }
    const source = createBodySource(responseBody(response));
    this.ok = status >= 200 && status <= 299;
    this.status = status;
    this.headers = response.headers;
    managedResponseState.set(this, {
      bodyUsed: false,
      bytesConsumed: 0,
      lifecycle,
      policy,
      source,
      status,
    });

    Object.defineProperty(this, 'bodyUsed', {
      enumerable: true,
      get: () => getManagedResponseState(this).bodyUsed,
    });

    lifecycle.setAbortCleanup(async () => {
      await source.cancel();
      lifecycle.close();
    });
    Object.freeze(this);
  }

  stream() {
    const state = claimManagedBody(this);
    const iterator = iterateManagedBody(this);
    return Object.freeze({
      [Symbol.asyncIterator]() { return iterator; },
      cancel: async () => {
        state.lifecycle.abort(OUTBOUND_ERROR_CODES.RESPONSE_CANCELLED);
        await state.source.cancel();
        state.lifecycle.close();
      },
    });
  }

  async bytes() {
    return consumeManagedBytes(this);
  }

  async text() {
    return (await consumeManagedBytes(this)).toString('utf8');
  }

  async json() {
    const state = getManagedResponseState(this);
    const bytes = await consumeManagedBytes(this);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw outboundError(OUTBOUND_ERROR_CODES.INVALID_JSON, state.policy.sinkId, state.status);
    }
  }

  async cancel() {
    const state = getManagedResponseState(this);
    state.lifecycle.abort(OUTBOUND_ERROR_CODES.RESPONSE_CANCELLED);
    await state.source.cancel();
    state.lifecycle.close();
  }
}

Object.freeze(ManagedOutboundResponse.prototype);

async function readBoundedBytes(response) {
  return consumeManagedBytes(response);
}

async function readBoundedText(response) {
  return (await consumeManagedBytes(response)).toString('utf8');
}

async function readBoundedJson(response) {
  const state = getManagedResponseState(response);
  const bytes = await consumeManagedBytes(response);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_JSON, state.policy.sinkId, state.status);
  }
}

module.exports = {
  MANAGED_RESPONSE_CONSTRUCTOR_TOKEN,
  ManagedOutboundResponse,
  cancelRawResponse,
  discardBoundedResponse,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
  validateResponse,
};
