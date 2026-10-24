'use strict';
const { randomUUID } = require('node:crypto');
const express = require('express'), request = require('supertest');
const Task = require('../../models/PipelineTask');
const service = require('../../src/services/pipelineWorkReferences');
const admission = require('../../src/services/pipelineWorkAdmission');
const policy = require('../../src/services/pipelineWorkReferencePolicy');
const intake = require('../../src/services/taskIntakePolicy');
const app = express().use(express.json()).use('/api/pipeline', require('../../routes/pipeline'));
const report = { kind: 'github_issue', repository: 'example/project', number: 42 };
const conversation = { kind: 'conversation', runtime: 'codex', id: 'synthetic-conversation-1' };
const create = async (extra = {}) => require('../../src/services/pipelineTaskService').createTaskInMongo({
  title: 'Synthetic requested outcome', spec: 'Inspect and fix a bounded synthetic fixture.', service: 'core', ...extra });
const stored = id => Task.findOne({ pipelineId: id }).lean();
function decision(task, extra = {}) {
  return { operation: 'add', reference: report, relation: 'report', reason: 'Inspected the source and existing work before linking.',
    by: 'fixture-operator', requestId: randomUUID(), expectedRevision: task.workLinks?.revision || 0,
    expectedScopeFingerprint: intake.scopeFingerprint(task), confirm: true, ...extra };
}
function proposed(extra = {}) {
  return { reference: report, scopeKey: 'implementation', task: { title: 'Synthetic report follow-up',
    spec: 'Implement one bounded synthetic behavior.', service: 'core' }, by: 'fixture-operator',
  reason: 'Inspected existing work and selected this separate scope.', requestId: randomUUID(), confirm: true, ...extra };
}
beforeAll(async () => { await Task.createIndexes(); });
beforeEach(async () => { await Task.deleteMany({}); });
afterEach(() => jest.restoreAllMocks());

test('qualified source links retain rationale without accepting or starting work', async () => {
  const created = await create(), before = await stored(created.pipelineId);
  const response = await request(app).post(`/api/pipeline/tasks/${created.pipelineId}/relationships`).send(decision(before)).expect(200);
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.body.data.workView).toMatchObject({ revision: 1, authorization: 'none', statusSynchronization: 'none',
    entries: [{ label: 'example/project#42', href: 'https://github.com/example/project/issues/42', scopeCurrent: true }] });
  const after = await stored(created.pipelineId);
  for (const field of ['status', 'assignee', 'intake', 'automationAttemptCount', 'automationAttempts', 'sourceKey']) expect(after[field]).toEqual(before[field]);
  expect(after.workLinks.history).toHaveLength(1);
  const detail = await request(app).get(`/api/pipeline/tasks/${created.pipelineId}`).expect(200);
  expect(detail.body.data.task.workView.entries[0].reference).toEqual(report);
  const list = await request(app).get('/api/pipeline/tasks?view=summary').expect(200);
  expect(list.body.data.tasks[0].workView.revision).toBe(1);
  expect(list.body.data.tasks[0].workView.entryCount).toBe(1);
  expect(list.body.data.tasks[0].workView.entries[0]).not.toHaveProperty('reason');
  expect(list.body.data.tasks[0]).not.toHaveProperty('workLinks');
  expect(list.body.data.tasks[0]).not.toHaveProperty('spec');
});

test('many reports can share work and one report can require multiple tasks, counted before pagination', async () => {
  const one = await create(), two = await create({ title: 'Another explicit scope' });
  await service.decide(one.pipelineId, decision(await stored(one.pipelineId)));
  await service.decide(one.pipelineId, decision(await stored(one.pipelineId), { reference: { ...report, number: 43 }, relation: 'duplicate_report' }));
  await service.decide(two.pipelineId, decision(await stored(two.pipelineId)));
  const lookup = await request(app).get('/api/pipeline/work-references?kind=github_issue&repository=Example/Project&number=42&limit=1').expect(200);
  expect(lookup.body.data).toMatchObject({ matchedCount: 2, truncated: true, reference: report, titleSimilarityIsIdentity: false });
  expect(lookup.body.data.tasks).toHaveLength(1);
  expect((await service.lookup({ ...report, repository: 'other/project' })).matchedCount).toBe(0);
  expect((await service.lookup({ ...report, number: 43 })).tasks[0].pipelineId).toBe(one.pipelineId);
});

test('conversation provenance is exact and does not import a transcript or infer a task from its title', async () => {
  const one = await create(); await create();
  await service.decide(one.pipelineId, decision(await stored(one.pipelineId), { reference: conversation }));
  const lookup = await service.lookup(conversation);
  expect(lookup.matchedCount).toBe(1); expect(lookup.tasks[0].pipelineId).toBe(one.pipelineId);
  expect((await service.lookup({ ...conversation, runtime: 'hermes' })).matchedCount).toBe(0);
  expect(JSON.stringify(lookup)).not.toContain('transcript');
});

test('relationship replay and concurrent delivery retain one immutable receipt', async () => {
  const task = await create(), command = decision(await stored(task.pipelineId));
  const [one, two] = await Promise.all([service.decide(task.pipelineId, command), service.decide(task.pipelineId, command)]);
  expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
  expect((await stored(task.pipelineId)).workLinks.history).toHaveLength(1);
  await expect(service.decide(task.pipelineId, { ...command, reason: 'Changed decision under the old identity.' })).rejects.toMatchObject({ code: 'WORK_REFERENCE_KEY_CONFLICT' });
});

test('scope amendments retain the original links and require explicit review of their meaning', async () => {
  const task = await create(); await service.decide(task.pipelineId, decision(await stored(task.pipelineId)));
  const original = await stored(task.pipelineId), old = decision(original, { operation: 'review' });
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { spec: 'A different requested outcome.' } });
  await expect(service.decide(task.pipelineId, old)).rejects.toMatchObject({ code: 'WORK_REFERENCE_CONFLICT' });
  expect((await service.read(task.pipelineId)).entries[0].scopeCurrent).toBe(false);
  expect((await service.lookup(report)).tasks[0].association.scopeCurrent).toBe(false);
  const reviewed = await service.decide(task.pipelineId, decision(await stored(task.pipelineId), { operation: 'review' }));
  expect(reviewed.workView.entries[0].scopeCurrent).toBe(true);
  expect((await stored(task.pipelineId)).workLinks.history[0]).toEqual(original.workLinks.history[0]);
  expect((await stored(task.pipelineId)).intake.state).toBe('proposed');
});

test('a scope edit racing a link decision cannot be overwritten', async () => {
  const task = await create(), command = decision(await stored(task.pipelineId));
  const original = Task.findOneAndUpdate;
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
    await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { spec: 'Changed while linking.' } });
    return original.call(Task, ...args).lean();
  } }));
  await expect(service.decide(task.pipelineId, command)).rejects.toMatchObject({ code: 'WORK_REFERENCE_CONFLICT' });
  expect((await stored(task.pipelineId)).workLinks).toBeUndefined();
});

test('removing a link retains its rationale and exact retry even after later decisions', async () => {
  const task = await create(), add = decision(await stored(task.pipelineId));
  await service.decide(task.pipelineId, add);
  await service.decide(task.pipelineId, decision(await stored(task.pipelineId), { operation: 'remove' }));
  const replay = await service.decide(task.pipelineId, add);
  expect(replay.replayed).toBe(true); expect(replay.workView.entries).toHaveLength(0);
  expect(replay.receipt.operation).toBe('add'); expect((await stored(task.pipelineId)).workLinks.history).toHaveLength(2);
  const first = await service.read(task.pipelineId, { limit: 1 });
  expect(first).toMatchObject({ historyCount: 2, historyTruncated: true, nextHistoryOffset: 1, history: [{ operation: 'remove' }] });
  const next = await service.read(task.pipelineId, { limit: 1, offset: first.nextHistoryOffset });
  expect(next).toMatchObject({ historyTruncated: false, history: [{ operation: 'add' }] });
});

test('native task links do not close or supersede work and private targets remain outside the engineering capability', async () => {
  const task = await create(), target = await create(), privateTask = await create({ service: 'personal' });
  const reference = { kind: 'pipeline_task', pipelineId: target.pipelineId };
  await service.decide(task.pipelineId, decision(await stored(task.pipelineId), { reference, relation: 'related_work' }));
  expect((await stored(task.pipelineId)).status).toBe('queued'); expect((await stored(target.pipelineId)).resolution).toBeUndefined();
  await expect(service.decide(task.pipelineId, decision(await stored(task.pipelineId), {
    reference: { ...reference, pipelineId: privateTask.pipelineId }, relation: 'related_work' }))).rejects.toMatchObject({ code: 'WORK_REFERENCE_PRIVATE' });
  await expect(service.read(privateTask.pipelineId)).rejects.toMatchObject({ code: 'WORK_REFERENCE_PRIVATE' });
  await Task.updateOne({ pipelineId: target.pipelineId }, { $set: { service: 'personal', title: 'Private target text must not be copied' } });
  const read = await service.read(task.pipelineId);
  expect(read.entries[0]).toMatchObject({ unavailable: true, href: null });
  expect(JSON.stringify(read)).not.toContain('Private target text');
  await service.decide(task.pipelineId, decision(await stored(task.pipelineId), { operation: 'remove', reference, relation: 'related_work' }));
});

test('adding provenance preserves active and uncertain native execution identities and budgets', async () => {
  const task = await create();
  const fields = { status: 'in_progress', assignee: 'native-owner', automationLease: { leaseId: 'synthetic-original-lease' },
    codingReportAuthority: { revision: 2, grants: [{ key: 'synthetic-original-grant' }] } };
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: fields });
  const before = await stored(task.pipelineId);
  await service.decide(task.pipelineId, decision(before));
  const after = await stored(task.pipelineId);
  for (const field of Object.keys(fields)) expect(after[field]).toEqual(before[field]);
});

test('report admission records one proposal and source link atomically, reconciling its exact retry', async () => {
  const command = proposed();
  const response = await request(app).post('/api/pipeline/report-intake').send(command).expect(200);
  const { pipelineId, receipt } = response.body.data;
  expect(receipt.reference).toEqual(report);
  const task = await stored(pipelineId);
  expect(task).toMatchObject({ status: 'queued', automationAttemptCount: 0, intake: { state: 'proposed' },
    workLinks: { revision: 1, entries: [{ reference: report }] } });
  await Task.updateOne({ pipelineId }, { $set: { title: 'Later local task edit' } });
  const replay = await admission.admit(command);
  expect(replay).toMatchObject({ pipelineId, replayed: true }); expect(replay.receipt).toEqual(task.workAdmission);
  expect(await Task.countDocuments()).toBe(1);
  await expect(admission.admit({ ...command, task: { ...command.task, spec: 'A changed source request.' } })).rejects.toMatchObject({ code: 'WORK_ADMISSION_CONFLICT' });
  await service.decide(pipelineId, decision(await stored(pipelineId), { operation: 'remove' }));
  expect((await service.lookup(report)).tasks[0]).toMatchObject({ pipelineId, association: { relation: 'origin_admission', active: false } });
});

test('concurrent admission deduplicates exact scope while explicit decomposition keeps separate identities', async () => {
  const command = proposed();
  const [one, two] = await Promise.all([admission.admit(command), admission.admit(command)]);
  expect(one.pipelineId).toBe(two.pipelineId); expect(await Task.countDocuments()).toBe(1);
  await expect(admission.admit({ ...command, requestId: randomUUID() })).rejects.toMatchObject({ code: 'WORK_ADMISSION_CONFLICT' });
  await expect(admission.admit({ ...command, scopeKey: 'acceptance' })).rejects.toMatchObject({ code: 'WORK_ADMISSION_CONFLICT' });
  const other = await admission.admit(proposed({ scopeKey: 'acceptance' }));
  expect(other.pipelineId).not.toBe(one.pipelineId); expect((await service.lookup(report)).matchedCount).toBe(2);
});

test('a lost admission reply is reconciled by the original identity without creating another task', async () => {
  const tasks = require('../../src/services/pipelineTaskService'), native = tasks.createTaskInMongo;
  jest.spyOn(tasks, 'createTaskInMongo').mockImplementationOnce(async (...args) => { await native(...args); throw new Error('Synthetic lost database reply'); });
  const command = proposed({ reference: conversation });
  await expect(admission.admit(command)).rejects.toMatchObject({ code: 'WORK_ADMISSION_UNCERTAIN' });
  const replay = await admission.admit(command);
  expect(replay.replayed).toBe(true); expect(await Task.countDocuments()).toBe(1);
});

test('missing identity indexes refuse new admissions while exact existing receipts remain readable', async () => {
  const command = proposed(), admitted = await admission.admit(command);
  await Task.collection.dropIndex('workAdmission.requestId_1');
  try {
    await expect(admission.admit(proposed({ scopeKey: 'other' }))).rejects.toMatchObject({ code: 'WORK_ADMISSION_NOT_READY' });
    expect((await admission.admit(command)).pipelineId).toBe(admitted.pipelineId);
    expect(await Task.countDocuments()).toBe(1);
  } finally { await Task.createIndexes(); }
});

test('unstructured creation cannot forge a report-admission receipt or its reserved source', async () => {
  await request(app).post('/api/pipeline/tasks').send({ title: 'Forged origin', source: admission.SOURCE,
    workAdmission: proposed() }).expect(400);
  const normal = await create({ workAdmission: proposed(), workLinks: { revision: 9 } });
  expect((await stored(normal.pipelineId)).workAdmission).toBeUndefined();
  expect((await stored(normal.pipelineId)).workLinks).toBeUndefined();
});

test('full relationship histories refuse new decisions without dropping previous receipts', async () => {
  const task = await create(); await service.decide(task.pipelineId, decision(await stored(task.pipelineId)));
  const current = await stored(task.pipelineId), first = current.workLinks.history[0];
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { 'workLinks.history': Array.from({ length: 64 }, () => first) } });
  await expect(service.decide(task.pipelineId, decision(current, { operation: 'remove' }))).rejects.toMatchObject({ code: 'WORK_REFERENCE_FULL' });
  expect((await stored(task.pipelineId)).workLinks.history).toHaveLength(64);
});

test.each([
  { kind: 'github_issue', repository: 'example/project', number: 42, url: 'https://untrusted.invalid' },
  { kind: 'github_issue', repository: '../private', number: 42 },
  { kind: 'github_issue', repository: 'example/project', number: -1 },
  { kind: 'conversation', runtime: 'codex', id: 'pasted private transcript with spaces' },
  { kind: 'pipeline_task', pipelineId: '../secret' },
])('invalid or overbroad references refuse before mutation %#', async reference => {
  const task = await create();
  await expect(service.decide(task.pipelineId, decision(await stored(task.pipelineId), { reference }))).rejects.toMatchObject({ code: 'INVALID_WORK_REFERENCE' });
  expect((await stored(task.pipelineId)).workLinks).toBeUndefined();
});
