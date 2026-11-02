'use strict';

const Alert = require('../../models/Alert');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const queue = require('../../src/services/heavyWorkQueueService');
const notices = require('../../src/services/heavyWorkQueueNotifications');
const { unstartedExpiry } = require('../../src/services/heavyWorkQueueExpiry');
const relay = require('../../../integrations/operations/alert-telegram-relay');
const past = () => new Date(Date.now() - 60000).toISOString();
const future = () => new Date(Date.now() + 60000).toISOString();
const job = (extra = {}) => ({ id: 'synthetic-request', title: 'Synthetic queue task', state: 'requested',
  updatedAt: new Date().toISOString(), source: { type: 'coding', ref: 'synthetic' }, ...extra });
const request = key => ({ key, title: 'Synthetic planning task', kind: 'diagnostic',
  hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 5, source: { type: 'coding', ref: 'synthetic' } });

beforeEach(async () => { await Promise.all([Alert, Queue, Archive].map(model => model.deleteMany({}))); });

test.each(['requested', 'reserved'])('a missed %s start bound is reported without dispatch, state changes or duplicate alerts', async state => {
  const expired = job({ state, startBefore: past() });
  await Promise.all([notices.publishJobs([expired]), notices.publishJobs([expired])]);
  const [alert] = await Alert.find().lean();
  expect(await Alert.countDocuments()).toBe(1);
  expect(alert).toMatchObject({ severity: 'warning', channels: ['telegram'],
    context: { additionalData: { state: 'expired', queueState: state } } });
  expect(relay.selectDue([alert]).map(row => String(row._id))).toEqual([String(alert._id)]);
  expect(expired.state).toBe(state);
  expect(await Queue.countDocuments()).toBe(0);
});

test('reservation end is a deadline; running, uncertain, finished and timely requests never become unstarted expirations', async () => {
  const end = past();
  await notices.publishJobs([job({ state: 'reserved', reservation: { end } })]);
  expect((await notices.inbox()).notifications[0].expiry).toMatchObject({ bound: 'reservation.end', at: end });
  for (const state of ['running', 'dispatching', 'uncertain', 'completed', 'failed']) {
    expect(unstartedExpiry(job({ state, startBefore: past() }))).toBeNull();
  }
  expect(unstartedExpiry(job({ startBefore: future() }))).toBeNull();
  expect(unstartedExpiry(job())).toBeNull();
  expect(unstartedExpiry(job({ startBefore: 'invalid' }))).toBeNull();
  expect(unstartedExpiry(job({ startBefore: past(), dispatchId: 'persisted-dispatch' }))).toBeNull();
});

test('failures request Telegram even without a dispatch; completions and ordinary cancellations do not', async () => {
  await notices.publishJobs([
    job({ id: 'failed', state: 'failed' }),
    job({ id: 'cancelled-before-start', state: 'cancelled', startBefore: past() }),
    job({ id: 'cancelled-native', state: 'cancelled', executor: { mode: 'image-operation' } }),
    job({ id: 'cancelled-running', state: 'cancelled', dispatchedAt: past() }),
    job({ id: 'completed', state: 'completed', dispatchedAt: past() }),
  ]);
  const alerts = await Alert.find().lean();
  expect(relay.selectDue(alerts).map(row => row.context.additionalData.queueRequestId)).toEqual(['failed']);
  expect(alerts.some(row => row.context.additionalData.queueRequestId === 'cancelled-before-start')).toBe(false);
});

test('cancelling an already expired request retains its missed window through archive and acknowledgment', async () => {
  const original = await queue.submit({ ...request('expires'), startBefore: future() }, 'fixture');
  const deadline = past();
  await Queue.updateOne({ 'jobs.id': original.id }, { $set: { 'jobs.$.startBefore': deadline } });
  const expired = await queue.get(original.id);
  await notices.publishJobs([expired]);
  const cancelled = await queue.cancel(original.id, { expectedRevision: original.revision }, 'fixture');
  expect(cancelled.cancellationReason).toMatchObject({ code: 'window_expired_before_start', at: deadline });
  await queue.archive('fixture');
  expect(await Alert.countDocuments()).toBe(1);
  const alert = (await notices.inbox()).notifications[0];
  await notices.acknowledge(alert.id, 'fixture');
  await notices.publishJobs([await queue.get(original.id)]);
  expect(await Alert.countDocuments()).toBe(1);
  expect((await notices.inbox()).count).toBe(0);
});

test('a timely planning handoff stays silent even when observed after its former deadline', async () => {
  const original = await queue.submit({ ...request('handoff'), startBefore: future() }, 'fixture');
  const cancelled = await queue.cancel(original.id, { expectedRevision: original.revision }, 'fixture');
  expect(cancelled.cancellationReason).toBeUndefined();
  await notices.publishJobs([{ ...cancelled, startBefore: past() }]);
  expect(await Alert.countDocuments()).toBe(0);
});

test('a new missed reservation has its own event; old terminal notifications are not retrospectively enabled', async () => {
  const failed = job({ state: 'failed' });
  await notices.publishJobs([failed]);
  await Alert.updateMany({}, { $set: { channels: [], 'delivery.telegram.sent': true } });
  await notices.publishJobs([failed]);
  expect((await Alert.findOne().lean()).channels).toEqual([]);
  const one = job({ id: 'rescheduled', state: 'reserved', reservation: { end: past() } });
  await notices.publishJobs([one]);
  await notices.publishJobs([{ ...one, reservation: { end: new Date(Date.now() - 1000).toISOString() } }]);
  expect(await Alert.countDocuments()).toBe(3);
});
