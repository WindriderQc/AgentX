'use strict';
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const Alert = require('../../models/Alert');
const queue = require('../../src/services/heavyWorkQueueService');
const notices = require('../../src/services/heavyWorkQueueNotifications');
const nestor = require('../../src/services/nestorWorkQueue');
const A = 'http://127.0.0.1:11434';
const fixture = key => ({ key, title: 'Synthetic coding qualification', kind: 'diagnostic', hosts: [A], estimatedMinutes: 5,
  source: { type: 'coding', ref: 'synthetic-fixture', taskId: 'synthetic-task', issueUrl: 'https://github.com/example/project/issues/1' },
  executor: { mode: 'operator', receiptRef: 'synthetic-receipt.json' } });
const ready = async key => {
  const job = await queue.submit(fixture(key), 'fixture');
  const slot = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'fixture');
  return queue.begin(slot.id, { expectedRevision: slot.revision }, 'fixture');
};
const finish = job => ({ expectedRevision: job.revision, dispatchId: job.dispatchId, state: 'completed',
  receiptRef: 'synthetic-receipt.json', receiptSha256: 'a'.repeat(64), confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED' });
beforeEach(async () => { await Promise.all([Queue, Archive, Runtime, Alert].map(model => model.deleteMany({}))); });
test('operator attestation requires the exact dispatch and refuses held inference, including UNKNOWN', async () => {
  const job = await ready('operator');
  await expect(queue.operatorFinish(job.id, { ...finish(job), dispatchId: 'another' }, 'fixture')).rejects.toMatchObject({ statusCode: 409 });
  await expect(queue.operatorFinish(job.id, { ...finish(job), receiptRef: 'different' }, 'fixture')).rejects.toMatchObject({ statusCode: 409 });
  await Runtime.collection.insertOne({ _id: 'runtime', inferences: [{ host: A, state: 'UNKNOWN' }] });
  await expect(queue.operatorFinish(job.id, finish(job), 'fixture')).rejects.toMatchObject({ statusCode: 409 });
  expect((await queue.get(job.id)).state).toBe('dispatching');
  await Runtime.deleteMany({});
  const done = await queue.operatorFinish(job.id, finish(job), 'fixture');
  expect(done.releaseReceipt.authority).toBe('operator-attestation');
  expect(done.releaseReceipt.receiptSha256).toBe('a'.repeat(64));
});
test('notifications survive archive and acknowledgment without duplicate resurrection', async () => {
  const job = await ready('notice');
  await queue.record(job.id, { dispatchId: job.dispatchId, state: 'uncertain', reason: 'Synthetic lost response' }, 'fixture');
  const unknown = await queue.get(job.id);
  await Promise.all([notices.publishJobs([unknown]), notices.publishJobs([unknown])]);
  expect((await notices.inbox()).count).toBe(1);
  const done = await queue.operatorFinish(job.id, finish(unknown), 'fixture');
  // archive materializes the outbox before removing the active request.
  await queue.archive('fixture');
  const inbox = await notices.inbox();
  expect(inbox.count).toBe(1); expect(await Alert.countDocuments()).toBe(2);
  const terminal = inbox.notifications.find(item => item.state === 'completed');
  expect(terminal.source.taskId).toBe('synthetic-task');
  await notices.acknowledge(terminal.id, 'nestor');
  await notices.publishJobs([done]);
  expect((await notices.inbox()).count).toBe(0);
  expect((await nestor.operate({ action: 'show', id: job.id })).archived).toBe(true);
  await expect(notices.acknowledge('b'.repeat(24), 'nestor')).rejects.toMatchObject({ statusCode: 404 });
});
test('one-off queue results stay pending until acknowledgment instead of expiring as stale incidents', async () => {
  const job = await ready('stale');
  const done = await queue.operatorFinish(job.id, finish(job), 'fixture');
  await notices.publishJobs([done]);
  await Alert.updateMany({ ruleId: notices.RULE }, { $set: { lastOccurrence: new Date('2000-01-01') } });
  await require('../../src/services/alertIncidentRecovery').resolveStaleAlerts(1000);
  expect((await notices.inbox()).count).toBe(1);
});
test('Nestor planning keeps complete counts and cannot dispatch or use an executor', async () => {
  const request = { ...fixture('nestor'), source: { type: 'nestor', ref: 'synthetic-native-session' } };
  await expect(nestor.operate({ action: 'request', request })).rejects.toMatchObject({ statusCode: 400 });
  delete request.executor;
  const one = await nestor.operate({ action: 'request', request });
  await nestor.operate({ action: 'request', request: { ...request, key: 'two' } });
  const page = await nestor.operate({ action: 'list', limit: 1 });
  expect(page.count).toBe(2); expect(page.jobs).toHaveLength(1); expect(page.counts.requested).toBe(2);
  await expect(nestor.operate({ action: 'begin', id: one.id })).rejects.toMatchObject({ statusCode: 400 });
  await nestor.operate({ action: 'cancel', id: one.id, expectedRevision: one.revision });
  expect((await notices.inbox()).count).toBe(0);
  expect(await Runtime.countDocuments()).toBe(0);
});
