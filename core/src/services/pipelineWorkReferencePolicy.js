'use strict';
const { createHash } = require('node:crypto');
const intake = require('./taskIntakePolicy');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUNTIMES = ['agentx', 'codex', 'claude', 'openclaw', 'hermes', 'chatgpt'];
const MAX_LINKS = 32, MAX_HISTORY = 64;
const fail = (message, code = 'INVALID_WORK_REFERENCE', status = 400) => Object.assign(new Error(message), { code, status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function only(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
    throw fail('Use only the documented reference or command fields.');
}
function text(value, field, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max
    || (field === 'reason' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value))
    throw fail(`${field} must contain ${min}–${max} characters without control characters.`);
  return value.trim();
}
function reference(value) {
  let ref;
  if (value?.kind === 'github_issue') {
    only(value, ['kind', 'repository', 'number']);
    const repository = text(value.repository, 'repository', 3, 201).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(repository)
      || ['.', '..'].includes(repository.split('/')[1]) || !Number.isSafeInteger(value.number) || value.number < 1)
      throw fail('Name a qualified owner/repository and positive issue number.');
    ref = { kind: value.kind, repository, number: value.number };
  } else if (value?.kind === 'conversation') {
    only(value, ['kind', 'runtime', 'namespace', 'id']);
    if (!RUNTIMES.includes(value.runtime) || typeof value.namespace !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value.namespace)
      || typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value.id))
      throw fail('Name the conversation runtime, originating account/instance namespace and opaque identity; never paste transcript text or a credential.');
    ref = { kind: value.kind, runtime: value.runtime, namespace: value.namespace, id: value.id };
  } else if (value?.kind === 'pipeline_task') {
    only(value, ['kind', 'pipelineId']);
    if (typeof value.pipelineId !== 'string' || !/^\d{3,4}$/.test(value.pipelineId)) throw fail('Use an exact Core Pipeline task ID.');
    ref = { kind: value.kind, pipelineId: value.pipelineId };
  } else throw fail('Use a GitHub issue, a declared conversation reference or a Core task.');
  return ref;
}
const key = ref => hash(reference(ref));
const engineeringQuery = () => ({ ...require('../helpers/workerTaskScope')(), profileId: null, origin: { $ne: 'family' } });
function assertTask(task) {
  if (!task) throw fail('Engineering task unavailable.', 'WORK_TASK_UNAVAILABLE', 404);
  if (!intake.applicable(task)) throw fail('Keep personal and family relationships in their native domain.', 'WORK_REFERENCE_PRIVATE', 409);
}
function command(input) {
  only(input, ['operation', 'reference', 'relation', 'reason', 'by', 'requestId', 'expectedRevision', 'expectedScopeFingerprint', 'confirm']);
  if (!['add', 'review', 'remove'].includes(input.operation) || input.confirm !== true || !UUID.test(input.requestId || '')
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.expectedScopeFingerprint || ''))
    throw fail('Confirm one operation with its stable UUID, observed revision and current scope fingerprint.');
  const ref = reference(input.reference);
  if (!(ref.kind === 'pipeline_task' ? ['related_work'] : ['report', 'duplicate_report']).includes(input.relation))
    throw fail('Reports can be source or duplicate reports; Core task links identify related work, never closure or supersession.');
  return { operation: input.operation, reference: ref, relation: input.relation,
    reason: text(input.reason, 'reason', 8, 1000), by: text(input.by, 'by', 1, 120), requestId: input.requestId.toLowerCase(),
    expectedRevision: input.expectedRevision, expectedScopeFingerprint: input.expectedScopeFingerprint, confirm: true };
}
function entry(ref, relation, task, actor, reason, at = new Date()) {
  return { key: key(ref), reference: ref, relation, scopeFingerprint: intake.scopeFingerprint(task), actor, reason, at };
}
function describe(ref) {
  if (ref.kind === 'github_issue') return { label: `${ref.repository}#${ref.number}`, href: `https://github.com/${ref.repository}/issues/${ref.number}` };
  if (ref.kind === 'pipeline_task') return { label: `Core #${ref.pipelineId}`, href: `/pipeline?task=${ref.pipelineId}` };
  return { label: `${ref.runtime}/${ref.namespace} · ${ref.id}`, href: null };
}
function view(task, { outcomes = false, summary = false } = {}) {
  if (!intake.applicable(task)) return null;
  const fingerprint = intake.scopeFingerprint(task);
  return { schema: 'agentx.work-relationships/v1', revision: task.workLinks?.revision || 0, scopeFingerprint: fingerprint,
    entryCount: task.workLinks?.entries?.length || 0,
    entries: (task.workLinks?.entries || []).map(row => ({ ...(summary ? {
      key: row.key, reference: row.reference, relation: row.relation } : row), ...describe(row.reference),
      scopeCurrent: row.scopeFingerprint === fingerprint, referenceObservation: 'operator_declared' })),
    ...(outcomes && { outcomes: require('./pipelineWorkOutcomeView').view(task), authorityView: require('./pipelineWorkAuthorityView').view(task) }),
    authorization: 'none', externalWrites: 'none', statusSynchronization: 'none' };
}
module.exports = { UUID, RUNTIMES, MAX_LINKS, MAX_HISTORY, fail, hash, only, text, reference, key,
  engineeringQuery, assertTask, command, entry, describe, view };
