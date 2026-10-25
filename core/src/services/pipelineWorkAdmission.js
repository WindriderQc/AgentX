'use strict';
const Task = require('../../models/PipelineTask');
const policy = require('./pipelineWorkReferencePolicy');
const intake = require('./taskIntakePolicy');
const SOURCE = 'work-report-intake';
function normalize(body) {
  policy.only(body, ['reference', 'scopeKey', 'task', 'by', 'reason', 'requestId', 'confirm']);
  policy.only(body.task, ['title', 'spec', 'service']);
  const reference = policy.reference(body.reference);
  if (reference.kind === 'pipeline_task' || body.confirm !== true || !policy.UUID.test(body.requestId || '')
    || typeof body.scopeKey !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.scopeKey))
    throw policy.fail('Confirm a report and one stable scopeKey with its original request UUID.');
  const task = { title: policy.text(body.task.title, 'title', 1, 120), spec: body.task.spec,
    service: body.task.service === undefined ? '' : policy.text(body.task.service, 'service', 0, 120) };
  task.spec = require('./todoAuthoringService').validateSpec(task.spec);
  if (typeof task.spec !== 'string' || !task.spec.trim()) throw policy.fail('Describe the bounded requested outcome.');
  policy.assertTask({ ...task, source: SOURCE });
  return { reference, scopeKey: body.scopeKey, task, by: policy.text(body.by, 'by', 1, 120),
    reason: policy.text(body.reason, 'reason', 8, 1000), requestId: body.requestId.toLowerCase(), confirm: true };
}
const sourceKey = input => policy.hash([input.reference, input.scopeKey]);
// Called only by the canonical creation service's internal option. The body of
// POST /tasks cannot supply this receipt or skip proposal triage.
function initial(raw, task) {
  const input = normalize(raw);
  if (task.title !== input.task.title || task.spec !== input.task.spec || task.service !== input.task.service
    || task.source !== SOURCE || task.sourceKey !== sourceKey(input)) throw policy.fail('Report admission does not match the exact task creation.');
  const actor = { declared: input.by, authenticated: null, channel: 'report_intake' };
  const row = policy.entry(input.reference, 'report', task, actor, input.reason);
  const receipt = { revision: 1, requestId: input.requestId, intentHash: policy.hash(input), operation: 'add', entry: row };
  return { workLinks: { revision: 1, entries: [row], history: [receipt] }, workAdmission: {
    requestId: input.requestId, intentHash: policy.hash(input), reference: input.reference, referenceKey: row.key, scopeKey: input.scopeKey,
    scopeFingerprint: intake.scopeFingerprint(task), actor, reason: input.reason, at: row.at } };
}
function result(task, input, replayed) {
  policy.assertTask(task);
  if (task.workAdmission?.requestId !== input.requestId || task.workAdmission?.intentHash !== policy.hash(input))
    throw policy.fail('This report scope or request identity already belongs to an existing task. Inspect its links before proposing other work.', 'WORK_ADMISSION_CONFLICT', 409);
  return { pipelineId: task.pipelineId, href: `/pipeline?task=${task.pipelineId}`, receipt: task.workAdmission,
    intakeView: intake.view(task), workView: policy.view(task), replayed, externalWrites: 'none', authorization: 'none' };
}
async function assertIndexes() {
  const indexes = await Task.collection.listIndexes().toArray().catch(() => []);
  if (!indexes.some(row => row.unique === true && Object.keys(row.key).length === 1 && row.key['workAdmission.requestId'] === 1
      && row.partialFilterExpression?.['workAdmission.requestId']?.$type === 'string')
    || !indexes.some(row => row.unique === true && Object.keys(row.key).length === 2 && row.key.source === 1 && row.key.sourceKey === 1
      && row.partialFilterExpression?.sourceKey?.$type === 'string'))
    throw policy.fail('Core report-admission identity indexes are not ready. Restore native model indexes before creating work; existing receipts remain readable.', 'WORK_ADMISSION_NOT_READY', 503);
}
async function admit(body) {
  const input = normalize(body);
  const existing = await Task.findOne({ $or: [{ 'workAdmission.requestId': input.requestId },
    { source: SOURCE, sourceKey: sourceKey(input) }] }).lean();
  if (existing) return result(existing, input, true);
  await assertIndexes();
  let created;
  try { created = await require('./pipelineTaskService').createTaskInMongo({ ...input.task,
    source: SOURCE, sourceKey: sourceKey(input) }, { reportAdmission: input }); }
  catch (error) {
    if (error.code === 11000) {
      const prior = await Task.findOne({ $or: [{ 'workAdmission.requestId': input.requestId }, { source: SOURCE, sourceKey: sourceKey(input) }] }).lean();
      if (prior) return result(prior, input, true);
    }
    if (error.status || error.statusCode) throw error;
    throw policy.fail('Admission result is uncertain. Read or retry this exact request identity before any replacement.', 'WORK_ADMISSION_UNCERTAIN', 503);
  }
  const task = await Task.findOne({ pipelineId: created.pipelineId }).lean();
  return result(task, input, Boolean(created.alreadyExisting));
}
module.exports = { SOURCE, normalize, sourceKey, initial, admit };
