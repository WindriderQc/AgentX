'use strict';
const Task = require('../../models/PipelineTask');
const policy = require('./pipelineWorkReferencePolicy');
const intake = require('./taskIntakePolicy');
const WC = { w: 1, j: true };

async function taskFor(id) {
  const task = await Task.findOne({ pipelineId: id }).lean();
  policy.assertTask(task);
  return task;
}
async function assertTarget(ref, id) {
  if (ref.kind !== 'pipeline_task') return;
  if (ref.pipelineId === id) throw policy.fail('A task cannot link itself.');
  await taskFor(ref.pipelineId);
}
async function decide(id, body) {
  const input = policy.command(body), intentHash = policy.hash(input);
  const task = await taskFor(id);
  const previous = task.workLinks?.history?.find(row => row.requestId === input.requestId);
  if (previous) {
    if (previous.intentHash !== intentHash) throw policy.fail('This relationship request already has another intent.', 'WORK_REFERENCE_KEY_CONFLICT', 409);
    return { workView: policy.view(task), receipt: previous, replayed: true };
  }
  if ((task.workLinks?.revision || 0) !== input.expectedRevision || intake.scopeFingerprint(task) !== input.expectedScopeFingerprint)
    throw policy.fail('Read the current request and relationships before deciding.', 'WORK_REFERENCE_CONFLICT', 409);
  if (input.operation !== 'remove') await assertTarget(input.reference, id);
  const entries = task.workLinks?.entries || [], history = task.workLinks?.history || [];
  const refKey = policy.key(input.reference), current = entries.find(row => row.key === refKey);
  if ((input.operation === 'add') === Boolean(current))
    throw policy.fail(current ? 'This reference is already linked; review or remove its existing decision.' : 'The reference is not linked.', 'WORK_REFERENCE_EXISTS', 409);
  if (input.operation !== 'add' && current.relation !== input.relation)
    throw policy.fail('Review the recorded relationship before changing it.', 'WORK_REFERENCE_CONFLICT', 409);
  if (history.length >= policy.MAX_HISTORY || (!current && entries.length >= policy.MAX_LINKS))
    throw policy.fail('The bounded relationship history is full; preserve its evidence.', 'WORK_REFERENCE_FULL', 409);
  const revision = (task.workLinks?.revision || 0) + 1;
  const row = policy.entry(input.reference, input.relation, task,
    { declared: input.by, authenticated: null, channel: 'operator_api' }, input.reason);
  const receipt = { revision, requestId: input.requestId, intentHash, operation: input.operation, entry: row };
  const workLinks = { revision, entries: [...entries.filter(item => item.key !== refKey), ...(input.operation === 'remove' ? [] : [row])],
    history: [...history, receipt] };
  const updated = await Task.findOneAndUpdate({ pipelineId: id, 'workLinks.revision': task.workLinks?.revision ?? null,
    title: task.title, spec: task.spec ?? null, service: task.service ?? null, source: task.source ?? null,
    profileId: task.profileId ?? null, origin: task.origin ?? null }, { $set: { workLinks }, $inc: { __v: 1 } },
  { new: true, runValidators: true, writeConcern: WC }).lean();
  if (!updated) {
    const now = await taskFor(id), saved = now.workLinks?.history?.find(item => item.requestId === input.requestId);
    if (saved?.intentHash === intentHash) return { workView: policy.view(now), receipt: saved, replayed: true };
    throw policy.fail('Relationships or scope changed while recording the decision.', 'WORK_REFERENCE_CONFLICT', 409);
  }
  return { workView: policy.view(updated), receipt, replayed: false };
}

async function lookup(ref, limit = 20) {
  ref = policy.reference(ref);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw policy.fail('limit must be between 1 and 50.');
  if (ref.kind === 'pipeline_task') await taskFor(ref.pipelineId);
  const query = { ...policy.engineeringQuery(), $or: [{ 'workLinks.entries.key': policy.key(ref) }, { 'workAdmission.referenceKey': policy.key(ref) }] };
  const [matchedCount, tasks] = await Promise.all([Task.countDocuments(query), Task.find(query)
    .select('pipelineId title status intake spec service source origin profileId workLinks.entries workAdmission.referenceKey workAdmission.scopeFingerprint').sort({ pipelineId: 1 }).limit(limit).lean()]);
  return { schema: 'agentx.work-reference-lookup/v1', reference: ref, ...policy.describe(ref), matchedCount,
    tasks: tasks.map(task => ({ pipelineId: task.pipelineId, title: task.title, status: task.status,
      href: `/pipeline?task=${task.pipelineId}`, intakeView: intake.view(task), association: (() => {
        const row = task.workLinks?.entries?.find(item => item.key === policy.key(ref));
        return { relation: row?.relation || 'origin_admission', active: Boolean(row),
          scopeCurrent: (row?.scopeFingerprint || task.workAdmission?.scopeFingerprint) === intake.scopeFingerprint(task) };
      })() })), truncated: tasks.length < matchedCount,
    observedAt: new Date().toISOString(), consistency: 'Several bounded reads, not a transaction. Mutations revalidate.',
    authorization: 'none', externalWrites: 'none', titleSimilarityIsIdentity: false };
}
async function read(id, { limit = 10, offset = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > policy.MAX_HISTORY)
    throw policy.fail('Use a history limit of 1–50 and offset of 0–64.');
  const task = await taskFor(id), workView = policy.view(task);
  // A task moved into a private domain is not exposed through an older link.
  const safe = [];
  for (const row of workView.entries) {
    if (row.reference.kind === 'pipeline_task') {
      const target = await Task.findOne({ pipelineId: row.reference.pipelineId, ...policy.engineeringQuery() }).select('pipelineId').lean();
      if (!target) { safe.push({ key: row.key, relation: row.relation, unavailable: true, label: 'Related work unavailable', href: null }); continue; }
    }
    safe.push(row);
  }
  const history = task.workLinks?.history || [], next = offset + limit;
  return { ...workView, entries: safe,
    outcomes: require('./pipelineWorkOutcomeView').view(task),
    history: history.slice().reverse().slice(offset, next), historyCount: history.length, historyOffset: offset,
    historyTruncated: next < history.length, nextHistoryOffset: next < history.length ? next : null,
    sourceAdmission: task.workAdmission || null };
}
module.exports = { decide, lookup, read, taskFor };
