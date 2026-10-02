'use strict';

const {
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  outboundError,
} = require('./outboundHttpErrors');
const { headerValue } = require('./outboundHttpPolicy');

function captureBlobIntrinsics() {
  try {
    const BlobConstructor = globalThis.Blob;
    const prototype = BlobConstructor?.prototype;
    const sizeGetter = Object.getOwnPropertyDescriptor(prototype, 'size')?.get;
    const typeGetter = Object.getOwnPropertyDescriptor(prototype, 'type')?.get;
    const arrayBuffer = prototype?.arrayBuffer;
    if (typeof BlobConstructor !== 'function'
      || typeof sizeGetter !== 'function'
      || typeof typeGetter !== 'function'
      || typeof arrayBuffer !== 'function') {
      return null;
    }
    return Object.freeze({ BlobConstructor, arrayBuffer, sizeGetter, typeGetter });
  } catch {
    return null;
  }
}

// Capture the platform intrinsics once. Calling these functions directly
// avoids trusting shadowable instance properties such as blob.size,
// blob.arrayBuffer(), or blob.stream().
const BLOB_INTRINSICS = captureBlobIntrinsics();

function knownRequestBodyLength(body) {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return null;
}

function addIntrinsicBlobContentType(fetchInit, type) {
  if (!type || headerValue(fetchInit.headers, 'content-type') !== null) return fetchInit;
  const normalized = Object.assign(Object.create(null), fetchInit.headers || {});
  normalized['content-type'] = type;
  return { ...fetchInit, headers: Object.freeze(normalized) };
}

async function snapshotRequestBody(fetchInit, policy, lifecycle) {
  let body;
  try {
    body = fetchInit.body;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (body === undefined || body === null || typeof body === 'string') return fetchInit;
  try {
    if (Buffer.isBuffer(body)) return { ...fetchInit, body: Buffer.from(body) };
    if (ArrayBuffer.isView(body)) {
      return {
        ...fetchInit,
        body: Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      };
    }
    if (body instanceof ArrayBuffer) {
      return { ...fetchInit, body: Buffer.from(new Uint8Array(body)) };
    }
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }

  let isPlatformBlob = false;
  try {
    isPlatformBlob = BLOB_INTRINSICS !== null
      && body instanceof BLOB_INTRINSICS.BlobConstructor;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (!isPlatformBlob) return fetchInit;

  let intrinsicSize;
  let intrinsicType;
  try {
    intrinsicSize = Reflect.apply(BLOB_INTRINSICS.sizeGetter, body, []);
    intrinsicType = Reflect.apply(BLOB_INTRINSICS.typeGetter, body, []);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (!Number.isSafeInteger(intrinsicSize) || intrinsicSize < 0
    || typeof intrinsicType !== 'string') {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (intrinsicSize > policy.maxRequestBytes) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE, policy.sinkId);
  }
  const declaredLength = declaredRequestLength(fetchInit, policy.sinkId);
  if (declaredLength !== null && declaredLength !== BigInt(intrinsicSize)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, policy.sinkId);
  }

  let arrayBuffer;
  try {
    const snapshotPromise = Promise.resolve().then(
      () => Reflect.apply(BLOB_INTRINSICS.arrayBuffer, body, [])
    );
    arrayBuffer = await lifecycle.race(snapshotPromise);
  } catch (error) {
    if (error instanceof OutboundHttpError) throw error;
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength !== intrinsicSize) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  const ownedBody = Buffer.from(new Uint8Array(arrayBuffer));
  return addIntrinsicBlobContentType({ ...fetchInit, body: ownedBody }, intrinsicType);
}

function declaredRequestLength(fetchInit, sinkId) {
  let value;
  try {
    value = headerValue(fetchInit.headers, 'content-length');
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, sinkId);
  }
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, sinkId);
  }
  try {
    return BigInt(normalized);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, sinkId);
  }
}

function validateRequestBody(fetchInit, policy) {
  let body;
  try {
    body = fetchInit.body;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  let measuredLength;
  try {
    measuredLength = knownRequestBodyLength(body);
  } catch {
    measuredLength = null;
  }
  if (measuredLength === null) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (measuredLength > policy.maxRequestBytes) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE, policy.sinkId);
  }

  const declaredLength = declaredRequestLength(fetchInit, policy.sinkId);
  if (declaredLength !== null && declaredLength !== BigInt(measuredLength)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, policy.sinkId);
  }
  return measuredLength;
}

function ownRequestContentLength(fetchInit, measuredLength) {
  const normalized = Object.assign(Object.create(null), fetchInit.headers || {});
  delete normalized['content-length'];
  if (fetchInit.body !== undefined && fetchInit.body !== null) {
    normalized['content-length'] = String(measuredLength);
  }
  if (Object.keys(normalized).length === 0) {
    const { headers: _headers, ...withoutHeaders } = fetchInit;
    return withoutHeaders;
  }
  return { ...fetchInit, headers: Object.freeze(normalized) };
}

module.exports = {
  ownRequestContentLength,
  snapshotRequestBody,
  validateRequestBody,
};
