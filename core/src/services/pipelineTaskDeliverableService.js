'use strict';
const mongoose = require('mongoose');
const PipelineTask = require('../../models/PipelineTask');
const Deliverable = require('../../models/PipelineTaskDeliverable');
const workerTaskScope = require('../helpers/workerTaskScope');
const content = require('../helpers/fileContentChecks');
const { leaseReference } = require('./pipelineEvidenceReferences');

// Registry of files a pipeline task produced. Core owns the task, so it owns
// the record: the scope comes from the task, never from the request body, and
// a read recomputes the SHA-256 before it calls a file available. A receipt
// keeps three facts apart: storage (bytes written to Core's MongoDB),
// availability (bytes present and matching now) and external delivery (none:
// this registry never sends a file anywhere and never indexes it as memory).
const RECEIPT_SCHEMA = 'agentx.pipeline-task-deliverable-receipt/v1';
const STORE = 'mongodb:pipeline_task_deliverables';
const MAX_PER_TASK = 20;
const MAX_BYTES = 2 * 1024 * 1024; // the same per-file cap as conversation attachments
const SHA_RE = /^[a-f0-9]{64}$/;
const EXTERNAL_DELIVERY = Object.freeze({
  status: 'none',
  detail: 'Core stores and serves this file inside the task scope only. No third-party delivery is performed or recorded here.',
});

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const taskRef = pipelineId => `task-${pipelineId}`;

function laneFor(task) {
  return workerTaskScope.contains(task) ? 'engineering' : 'private';
}

function availability(row, storedBytes, verifiedSha) {
  const checkedAt = new Date().toISOString();
  if (storedBytes == null) return { status: 'missing', hashVerified: false, checkedAt };
  if (storedBytes !== row.size) return { status: 'corrupt', hashVerified: false, checkedAt };
  if (verifiedSha === undefined) return { status: 'present_unverified', hashVerified: false, checkedAt };
  return verifiedSha === row.sha256
    ? { status: 'available', hashVerified: true, checkedAt }
    : { status: 'corrupt', hashVerified: false, checkedAt };
}

function receipt(row, state) {
  const id = String(row._id);
  return {
    schema: RECEIPT_SCHEMA,
    id,
    ref: `${taskRef(row.pipelineId)}/deliverable-${id}`,
    pipelineId: row.pipelineId,
    attempt: row.attempt ?? null,
    attemptRef: row.attempt ? `${taskRef(row.pipelineId)}/attempt-${row.attempt}` : null,
    name: row.name,
    mimeType: row.mimeType,
    kind: row.kind,
    size: row.size,
    sha256: row.sha256,
    owner: { kind: 'pipeline_task', ref: taskRef(row.pipelineId) },
    scope: { lane: row.scope?.lane || null, service: row.scope?.service || '', taskRef: taskRef(row.pipelineId) },
    producer: { declared: row.producer?.declared || null, authenticated: null,
      channel: row.producer?.channel || null, leaseRef: row.producer?.leaseRef || null,
      permitSeq: row.producer?.permitSeq || null },
    retention: { policy: row.retention || 'task_lifetime', expiresAt: null },
    storage: { status: 'stored', store: STORE, storedAt: row.storedAt },
    availability: state,
    externalDelivery: EXTERNAL_DELIVERY,
    memory: { status: 'not_indexed' },
  };
}

function decodeUpload(body) {
  const { name, dataUrl, sha256 } = body;
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') {
    throw fail(400, 'DELIVERABLE_CONTENT_MISSING', 'dataUrl with the file content is required');
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\x00-\x1f\x7f\\/]/.test(name)) {
    throw fail(400, 'DELIVERABLE_NAME_INVALID', 'name must be a plain file name of at most 160 characters');
  }
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) {
    throw fail(400, 'DELIVERABLE_SHA256_REQUIRED', 'sha256 must be the 64-character lowercase hex digest of the file');
  }
  if (typeof dataUrl !== 'string' || dataUrl.length > content.maxDataUrlLength(MAX_BYTES)) {
    throw fail(413, 'DELIVERABLE_TOO_LARGE', `Each deliverable is at most ${MAX_BYTES} bytes`);
  }
  const parsed = content.parseDataUrl(dataUrl);
  if (!parsed || !content.MIME_TYPES.has(parsed.mimeType)) {
    throw fail(400, 'DELIVERABLE_TYPE_UNSUPPORTED', `Supported types: ${[...content.MIME_TYPES].join(', ')}`);
  }
  const { mimeType, data } = parsed;
  if (data.length > MAX_BYTES) throw fail(413, 'DELIVERABLE_TOO_LARGE', `Each deliverable is at most ${MAX_BYTES} bytes`);
  if (!data.length) throw fail(400, 'DELIVERABLE_CONTENT_MISSING', 'The file is empty');
  if (!parsed.canonical) throw fail(400, 'DELIVERABLE_CONTENT_INVALID', 'The base64 content is not canonical');
  const image = mimeType.startsWith('image/');
  if (!content.imageSignatureMatches(mimeType, data)) throw fail(400, 'DELIVERABLE_CONTENT_INVALID', 'The bytes do not match the image type');
  if (mimeType === 'application/pdf' && !content.isPdf(data)) throw fail(400, 'DELIVERABLE_CONTENT_INVALID', 'The bytes are not a PDF');
  if (!image && mimeType !== 'application/pdf') {
    const decoded = content.decodeText(data);
    if (decoded.error) throw fail(400, 'DELIVERABLE_CONTENT_INVALID', 'Text deliverables must be UTF-8 without binary data');
    if (mimeType === 'application/json' && !content.isJson(decoded.text)) throw fail(400, 'DELIVERABLE_CONTENT_INVALID', 'Invalid JSON');
  }
  const computed = content.sha256(data);
  if (computed !== sha256) {
    throw Object.assign(fail(422, 'DELIVERABLE_HASH_MISMATCH', 'The declared sha256 does not match the received bytes; nothing was stored'),
      { details: { declared: sha256, computed } });
  }
  return { name: name.trim(), mimeType, kind: image ? 'image' : 'document', size: data.length, sha256: computed, data };
}

function producerFor(body) {
  const by = typeof body.by === 'string' ? body.by.trim() : '';
  if (!by || by.length > 160) throw fail(400, 'INVALID_PRODUCER', 'by is required and must be at most 160 characters');
  const hasAttempt = body.attempt !== undefined && body.attempt !== null;
  const attempt = hasAttempt ? Number(body.attempt) : null;
  if (hasAttempt && (!Number.isInteger(attempt) || attempt < 1 || attempt > 10)) {
    throw fail(400, 'INVALID_ATTEMPT', 'attempt must be an integer from 1 through 10');
  }
  return { by, attempt };
}

async function loadTask(pipelineId) {
  const task = await PipelineTask.findOne({ pipelineId: String(pipelineId) })
    .select('pipelineId service source status assignee automation.mode automationLease automationAttempts.attempt automationAttempts.leaseId automationAttempts.assignee automationAttempts.finalState').lean();
  if (!task) throw fail(404, 'NOT_FOUND', 'Task not found');
  return task;
}

function workerLeaseReference(task, { attempt, by, leaseId }, now = new Date()) {
  if (typeof leaseId !== 'string' || !leaseId || leaseId.length > 128) {
    throw fail(400, 'DELIVERABLE_LEASE_REQUIRED', 'Worker deliverables require the exact active leaseId');
  }
  const row = (task.automationAttempts || []).find(item => item.attempt === attempt);
  if (!row) throw fail(404, 'ATTEMPT_NOT_FOUND', 'This task has no such attempt');
  const active = task.automationLease;
  if (task.status !== 'in_progress' || task.assignee !== by || row.finalState !== 'active'
    || row.leaseId !== leaseId || row.assignee !== by || active?.leaseId !== leaseId
    || active?.assignee !== by || active?.attempt !== attempt
    || !active.expiresAt || new Date(active.expiresAt).getTime() <= now.getTime()) {
    throw fail(409, 'DELIVERABLE_LEASE_INACTIVE', 'The worker attempt no longer has this active lease');
  }
  return leaseReference(leaseId);
}

async function authorizeWorkerDeposit(task, { attempt, by, leaseId }) {
  // The task write is the authorization point. A terminal transition that wins
  // first prevents this permit; one that follows cannot revoke a granted one.
  const authorized = await PipelineTask.findOneAndUpdate({
    ...workerTaskScope(), pipelineId: task.pipelineId, status: 'in_progress', assignee: by,
    'automationLease.leaseId': leaseId,
    'automationLease.assignee': by,
    'automationLease.attempt': attempt,
    'automationLease.expiresAt': { $gt: new Date() },
    automationAttempts: { $elemMatch: { attempt, leaseId, assignee: by, finalState: 'active' } },
  }, { $inc: { deliverablePermitSeq: 1 } }, {
    new: true, projection: { deliverablePermitSeq: 1 }, timestamps: false,
  }).lean();
  if (!authorized) throw fail(409, 'DELIVERABLE_LEASE_INACTIVE', 'The worker attempt no longer has this active lease');
  return authorized.deliverablePermitSeq;
}

const storedState = row => {
  const data = row.data ? Buffer.from(row.data.buffer || row.data) : null;
  return { data, state: availability(row, data ? data.length : null, data ? content.sha256(data) : undefined) };
};

// Same attempt + name + bytes is the same registration: return it unchanged,
// with the stored bytes re-verified rather than assumed.
function existingOutcome(row, payload) {
  if (row.sha256 !== payload.sha256) {
    throw fail(409, 'DELIVERABLE_CONFLICT', 'A different file is already registered under this name for this attempt; deliverables are immutable');
  }
  return { created: false, receipt: receipt(row, storedState(row).state) };
}

async function register(pipelineId, body = {}) {
  const { by, attempt } = producerFor(body);
  const payload = decodeUpload(body);
  const task = await loadTask(pipelineId);
  const lane = laneFor(task);
  let leaseRef = null;
  let permitSeq = null;
  if (attempt !== null) {
    if (lane !== 'engineering') throw fail(403, 'DELIVERABLE_SCOPE_DENIED', 'Worker deliverables exist only for worker-scope tasks');
    leaseRef = workerLeaseReference(task, { attempt, by, leaseId: body.leaseId });
  } else if (body.leaseId != null) {
    throw fail(400, 'DELIVERABLE_ATTEMPT_REQUIRED', 'A leaseId must name its worker attempt');
  } else if (task.automation?.mode === 'review_only' || (task.automationAttempts || []).length) {
    throw fail(403, 'DELIVERABLE_WORKER_ATTEMPT_REQUIRED', 'Automated tasks require a lease-bound worker attempt for uploads');
  }
  const key = { pipelineId: task.pipelineId, attempt, name: payload.name };
  const existing = await Deliverable.findOne(key).select('+data').lean();
  if (existing) return existingOutcome(existing, payload);
  if (await Deliverable.countDocuments({ pipelineId: task.pipelineId }) >= MAX_PER_TASK) {
    throw fail(409, 'DELIVERABLE_LIMIT', `A task keeps at most ${MAX_PER_TASK} deliverables`);
  }
  if (attempt !== null) permitSeq = await authorizeWorkerDeposit(task, { attempt, by, leaseId: body.leaseId });
  try {
    const row = await Deliverable.create({
      ...key, mimeType: payload.mimeType, kind: payload.kind, size: payload.size, sha256: payload.sha256, data: payload.data,
      scope: { lane, service: task.service || '' },
      producer: { declared: by, channel: attempt === null ? 'operator_api' : 'worker_api', leaseRef, permitSeq },
      storedAt: new Date(),
    });
    const stored = row.toObject();
    return { created: true, receipt: receipt(stored, availability(stored, payload.size, payload.sha256)) };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const raced = await Deliverable.findOne(key).select('+data').lean();
    if (!raced) throw error;
    return existingOutcome(raced, payload);
  }
}

// Listing reads sizes, not bytes: availability is `present_unverified` until a
// receipt or download recomputes the digest.
async function list(pipelineId) {
  const task = await loadTask(pipelineId);
  const rows = await Deliverable.aggregate([
    { $match: { pipelineId: task.pipelineId } },
    { $sort: { storedAt: 1, _id: 1 } },
    { $addFields: { storedBytes: { $cond: [{ $eq: [{ $type: '$data' }, 'binData'] }, { $binarySize: '$data' }, null] } } },
    { $project: { data: 0 } },
  ]);
  return rows.map(row => receipt(row, availability(row, row.storedBytes, undefined)));
}

async function loadWithBytes(pipelineId, deliverableId) {
  if (!mongoose.isValidObjectId(deliverableId) || !/^[a-f0-9]{24}$/.test(String(deliverableId))) {
    throw fail(400, 'INVALID_DELIVERABLE_ID', 'Invalid deliverable id');
  }
  const task = await loadTask(pipelineId);
  // The task is part of the key: an id from another task is simply absent.
  const row = await Deliverable.findOne({ _id: deliverableId, pipelineId: task.pipelineId }).select('+data').lean();
  if (!row) throw fail(404, 'DELIVERABLE_NOT_FOUND', 'No such deliverable in this task');
  return { row, ...storedState(row) };
}

async function verify(pipelineId, deliverableId) {
  const { row, state } = await loadWithBytes(pipelineId, deliverableId);
  return receipt(row, state);
}

async function download(pipelineId, deliverableId) {
  const { row, data, state } = await loadWithBytes(pipelineId, deliverableId);
  if (state.status === 'missing') throw fail(410, 'DELIVERABLE_MISSING', 'The stored bytes are missing; the file is not available');
  if (state.status !== 'available') throw fail(409, 'DELIVERABLE_INTEGRITY', 'The stored bytes no longer match the recorded sha256; the file is not served');
  return { receipt: receipt(row, state), data };
}

module.exports = { RECEIPT_SCHEMA, STORE, MAX_PER_TASK, MAX_BYTES, register, list, verify, download };
