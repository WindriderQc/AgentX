'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const personal = require('../../src/services/personalTaskService');
const ID = 'd48e901a-0083-4780-ad53-cc93a2351de3';
const OTHER = 'e951b86e-f0b1-438e-8f99-a6f789d67e72';
const capture = (extra = {}) => personal.createPersonalTask({ title: 'Synthetic owner action', requestId: ID, ...extra });
const lookup = (extra = {}) => personal.listPersonalTasks({ requestId: ID, ...extra });
const stored = async () => ({ tasks: await PipelineTask.find({}).lean(), counters: await Counter.find({}).lean() });

beforeAll(() => PipelineTask.createIndexes());
beforeEach(async () => { await PipelineTask.deleteMany({}); await Counter.deleteMany({}); });

test('lost creation acknowledgment is recovered by repeated reads of the existing identity without writes', async () => {
  await capture({ note: 'Synthetic original context', dueAt: '2030-01-01' }); // Deliberately discard the response.
  const before = await stored();
  const first = await lookup();
  expect(first).toMatchObject({ authority: 'core.personal-tasks', selection: 'exact_personal_capture',
    requestId: ID, captureStatus: 'recorded', taskObservation: 'current_state', count: 1, totalCount: 1,
    hasMore: false, nextOffset: null, captureReceipt: {
      contract: 'agentx.personal-task-capture/v1', requestId: ID, taskId: before.tasks[0].pipelineId,
      fingerprint: before.tasks[0].personalCaptureFingerprint, createdAt: before.tasks[0].createdAt.toISOString()
    } });
  expect(first.tasks[0]).toMatchObject({ id: first.captureReceipt.taskId, title: 'Synthetic owner action' });
  expect(first.tasks[0]).not.toHaveProperty('personalCaptureFingerprint');
  expect(await lookup({ requestId: ID.toUpperCase(), expectedCaptureFingerprint: first.captureReceipt.fingerprint })).toEqual(first);
  expect(await stored()).toEqual(before);
});

test('the original receipt survives edits and completion; current state is separate and ordinary list filtering stays intact', async () => {
  const task = await capture({ dueAt: '2030-01-01' });
  const original = await lookup();
  await personal.updatePersonalTask({ ref: task.id, dueAt: '2030-02-02', priority: 1 });
  await personal.completePersonalTask({ ref: task.id });
  expect((await personal.listPersonalTasks()).tasks).toEqual([]);
  const before = await stored();
  const found = await lookup();
  expect(found.captureReceipt).toEqual(original.captureReceipt);
  expect(found.tasks[0]).toMatchObject({ id: task.id, status: 'done', priority: 1, dueDate: '2030-02-02' });
  expect(found.tasks[0].dueAt).not.toBe(original.tasks[0].dueAt);
  expect(found.taskObservation).toBe('current_state');
  expect(await stored()).toEqual(before);
});

test('mail-derived proposals stay pending and cannot acquire approval by reading a capture receipt', async () => {
  const task = await capture({ title: 'Synthetic email request', origin: 'email' });
  const before = await stored();
  const found = await lookup();
  expect(found.tasks[0]).toMatchObject({ needsReview: true, category: 'email', personalReview: { state: 'pending' } });
  expect(await stored()).toEqual(before);
  await expect(personal.completePersonalTask({ ref: task.id })).rejects.toMatchObject({ code: 'SECRETARY_REVIEW_REQUIRED' });
  await personal.reviewPersonalTask({ ref: task.id, decision: 'dismiss', revision: found.tasks[0].revision });
  const dismissed = await lookup();
  expect(dismissed.captureReceipt).toEqual(found.captureReceipt);
  expect(dismissed.tasks[0]).toMatchObject({ lane: 'dismissed', personalReview: { state: 'dismissed' } });
});

test.each([
  { requestId: 'not-a-uuid' }, { requestId: null }, { requestId: { $ne: null } },
  { requestId: ID, expectedCaptureFingerprint: 'wrong' }, { requestId: ID, expectedCaptureFingerprint: null },
  { expectedCaptureFingerprint: 'a'.repeat(64) },
  ...['includeDone', 'includeNotes', 'scope', 'category', 'offset', 'limit', 'approved', 'service', 'ref', 'title']
    .map(key => ({ requestId: ID, [key]: key === 'scope' ? 'active' : true }))
])('incompatible lookup arguments fail closed: %j', async input => {
  await expect(personal.listPersonalTasks(input)).rejects.toMatchObject({ code: 'PERSONAL_CAPTURE_INVALID', status: 400 });
  expect(await stored()).toEqual({ tasks: [], counters: [] });
});

test('a mismatched expected fingerprint or reused creation UUID is refused without changing the record', async () => {
  await capture();
  const before = await stored();
  await expect(lookup({ expectedCaptureFingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'PERSONAL_CAPTURE_CONFLICT', status: 409 });
  await expect(personal.createPersonalTask({ title: 'Different intent', requestId: ID })).rejects.toMatchObject({ code: 'PERSONAL_CAPTURE_CONFLICT', status: 409 });
  expect(await stored()).toEqual(before);
});

test('missing, erased and incomplete evidence stays unknown and never allocates or restores a task', async () => {
  const unknown = { selection: 'exact_personal_capture', captureStatus: 'unknown', captureReceipt: null,
    taskObservation: 'unavailable', tasks: [], count: 0, totalCount: 0, hasMore: false };
  expect(await lookup()).toMatchObject(unknown);
  expect(await stored()).toEqual({ tasks: [], counters: [] });
  await capture();
  await PipelineTask.updateOne({ personalCaptureId: ID }, { $unset: { personalCaptureFingerprint: 1 } });
  const incomplete = await stored();
  expect(await lookup()).toMatchObject(unknown);
  expect(await stored()).toEqual(incomplete);
  await PipelineTask.deleteMany({});
  const erased = await stored();
  expect(await lookup({ expectedCaptureFingerprint: 'a'.repeat(64) })).toMatchObject(unknown);
  expect(await stored()).toEqual(erased);
});

test('identity lookup does not fall back to similar titles or another service', async () => {
  const personalTask = await capture();
  const before = await stored();
  expect(await lookup({ requestId: OTHER })).toMatchObject({ captureStatus: 'unknown', tasks: [] });
  expect((await personal.listPersonalTasks()).tasks[0].id).toBe(personalTask.id);
  await PipelineTask.updateOne({ personalCaptureId: ID }, { $set: { service: 'engineering' } });
  expect(await lookup()).toMatchObject({ captureStatus: 'unknown', tasks: [] });
  expect((await Counter.find({}).lean())).toEqual(before.counters);
  expect(await PipelineTask.countDocuments({})).toBe(1);
});
