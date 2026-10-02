'use strict';

const mongoose = require('mongoose');
const Alert = require('../../models/Alert');
const PipelineTask = require('../../models/PipelineTask');
const { readTaskDiagnosis } = require('../../src/services/pipelineTaskDiagnosisReadService');
const { RULE_ID, reconcilePipelineTaskEscalations } = require('../../src/services/pipelineTaskEscalationService');
const { resolveStaleAlerts } = require('../../src/services/alertIncidentRecovery');

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test');
  }
  await Alert.createIndexes();
});
beforeEach(async () => {
  await Promise.all([Alert.deleteMany({}), PipelineTask.deleteMany({})]);
});

const stalled = pipelineId => ({ pipelineId, title: 'Synthetic worker task', service: 'core',
  status: 'in_progress', assignee: 'interactive-worker', heartbeatAt: null });

test('diagnosis GET stays read-only while the sweep records one alert for an episode', async () => {
  await PipelineTask.create(stalled('9001'));
  const diagnosis = await readTaskDiagnosis('9001');
  expect(diagnosis).toMatchObject({ code: 'heartbeat_absent', escalation: { key: expect.stringMatching(/^esc-/) } });
  expect(await Alert.countDocuments({})).toBe(0);

  expect(await reconcilePipelineTaskEscalations()).toMatchObject({ observed: 1, created: 1 });
  const first = await Alert.findOne({ ruleId: RULE_ID }).lean();
  expect(first).toMatchObject({ fingerprint: diagnosis.escalation.key, status: 'active',
    context: { additionalData: { pipelineId: '9001', diagnosisCode: 'heartbeat_absent' } } });
  expect(first.message).not.toContain('interactive-worker');
  expect(await reconcilePipelineTaskEscalations()).toMatchObject({ observed: 1, created: 0 });
  const second = await Alert.findOne({ ruleId: RULE_ID }).lean();
  expect(second.updatedAt).toEqual(first.updatedAt);
  expect(await Alert.countDocuments({ ruleId: RULE_ID })).toBe(1);
});

test('a cleared diagnosis leaves the durable alert for operator resolution; the key is never emitted again', async () => {
  await PipelineTask.create(stalled('9002'));
  await reconcilePipelineTaskEscalations();
  await PipelineTask.updateOne({ pipelineId: '9002' }, { $set: { status: 'done' } });
  expect(await reconcilePipelineTaskEscalations()).toMatchObject({ observed: 0, created: 0 });
  expect((await Alert.findOne({ ruleId: RULE_ID }).lean()).status).toBe('active');
  await Alert.updateOne({ ruleId: RULE_ID }, { $set: { status: 'resolved' } });
  await PipelineTask.updateOne({ pipelineId: '9002' }, { $set: { status: 'in_progress' } });
  expect(await reconcilePipelineTaskEscalations()).toMatchObject({ observed: 1, created: 0 });
  expect(await Alert.countDocuments({ ruleId: RULE_ID })).toBe(1);
  expect((await Alert.findOne({ ruleId: RULE_ID }).lean()).status).toBe('resolved');
});

test('parallel sweeps and the generic stale resolver do not duplicate or clear a live episode', async () => {
  await PipelineTask.create(stalled('9003'));
  await Promise.all([reconcilePipelineTaskEscalations(), reconcilePipelineTaskEscalations()]);
  expect(await Alert.countDocuments({ ruleId: RULE_ID })).toBe(1);
  await Alert.updateOne({ ruleId: RULE_ID }, { $set: { lastOccurrence: new Date(0) } });
  await resolveStaleAlerts(1);
  expect((await Alert.findOne({ ruleId: RULE_ID }).lean()).status).toBe('active');
});

test('cursor scan reaches past 500 tasks and excludes the private lane', async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    pipelineId: String(1000 + index), title: 'Synthetic queued task', service: 'core', status: 'queued',
  }));
  rows[0] = stalled('1000');
  rows[500] = stalled('1500');
  rows.push({ ...stalled('1501'), service: 'family' });
  await PipelineTask.insertMany(rows);
  expect(await reconcilePipelineTaskEscalations()).toMatchObject({ observed: 2, created: 2 });
  const alerts = await Alert.find({ ruleId: RULE_ID }).sort({ fingerprint: 1 }).lean();
  expect(alerts.map(alert => alert.context.additionalData.pipelineId).sort()).toEqual(['1000', '1500']);
});
