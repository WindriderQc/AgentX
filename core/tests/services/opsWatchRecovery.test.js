'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Alert = require('../../models/Alert');
const PipelineTask = require('../../models/PipelineTask');
const { createOpsWatch, RULE_ID } = require('../../src/services/opsWatchService');
const { reconcileReports, publishReport } = require('../../src/services/opsWatchReportLifecycle');
const { listOpenAlerts } = require('../../src/services/opsWatchObservations');

const report = (fingerprint, extra = {}) => ({ ruleId: RULE_ID, ruleName: 'Watch',
  source: 'ops-watch', severity: 'warning', title: 'Synthetic report', message: 'Synthetic findings',
  status: 'active', fingerprint, lastOccurrence: new Date(0),
  context: { additionalData: { incidentKey: fingerprint } }, ...extra });
const escalation = id => ({ ruleId: 'pipeline-task-escalation', ruleName: 'Task inspection',
  source: 'agentx-core', severity: 'warning', title: 'Synthetic task inspection', message: 'heartbeat_stale',
  fingerprint: `task-${id}`, context: { additionalData: { pipelineId: id } } });
const clearSnapshot = () => ({ operationalAttention: { issues: [] }, alerts: [] });

beforeEach(async () => {
  await Promise.all([Alert.deleteMany({}), PipelineTask.deleteMany({})]);
});

test('closed task escalations stay durable but do not cause current heartbeat warnings or model calls', async () => {
  await PipelineTask.create({ pipelineId: '9101', title: 'Synthetic closed task', service: 'core',
    status: 'done', assignee: 'synthetic-worker', heartbeatAt: new Date(0) });
  const old = await Alert.create(escalation('9101'));
  const summary = await Alert.create(report('legacy'));
  const execute = jest.fn();
  const watch = createOpsWatch({ buildSnapshot: clearSnapshot, listAlerts: listOpenAlerts, execute });
  expect(await watch.check()).toMatchObject({ findingCount: 0, emitted: false });
  expect(execute).not.toHaveBeenCalled();
  expect((await Alert.findById(old._id)).status).toBe('active');
  expect((await Alert.findById(summary._id)).resolution.resolutionMethod).toBe('ops-watch-clear');
});

test.each(['missing', 'failed', 'unknown'])('a %s task diagnosis keeps the unresolved finding visible', async state => {
  const execute = jest.fn(async () => ({ ok: false, status: 503 }));
  const watch = createOpsWatch({ buildSnapshot: () => ({ ...clearSnapshot(), alerts: [escalation('9102')] }),
    readDiagnosis: async () => {
      if (state === 'failed') throw new Error('unavailable');
      return state === 'missing' ? null : { category: 'unknown' };
    }, execute, evaluateEvent: jest.fn(), reconcileReports: jest.fn() });
  expect(await watch.check()).toMatchObject({ findingCount: 1 });
  expect(watch.latest().findings[0].text).toContain('heartbeat_stale');
});

test('failed or incomplete observations never resolve an open report', async () => {
  const old = await Alert.create(report('legacy'));
  for (const buildSnapshot of [async () => { throw new Error('unavailable'); }, async () => ({})]) {
    const watch = createOpsWatch({ buildSnapshot, execute: jest.fn() });
    await expect(watch.check()).rejects.toThrow();
  }
  const watch = createOpsWatch({ buildSnapshot: clearSnapshot,
    listAlerts: async () => { throw new Error('alerts unavailable'); }, execute: jest.fn() });
  await expect(watch.check()).rejects.toThrow('alerts unavailable');
  expect((await Alert.findById(old._id)).status).toBe('active');
});

test('legacy report retirement requires a recorded replacement and preserves newer observations', async () => {
  const checkedAt = new Date();
  const old = await Alert.create(report('legacy'));
  const newer = await Alert.create(report('newer', { lastOccurrence: new Date(checkedAt.getTime() + 1000) }));
  expect(await reconcileReports({ checkedAt, incidentKey: 'ops-watch:current' })).toBe(0);
  const current = await Alert.create(report('ops-watch:current'));
  expect(await reconcileReports({ checkedAt, incidentKey: 'ops-watch:current' })).toBe(0);
  await Alert.updateOne({ _id: current._id }, { $set: { lastOccurrence: checkedAt } });
  expect(await reconcileReports({ checkedAt, incidentKey: 'ops-watch:current' })).toBe(1);
  expect((await Alert.findById(old._id)).resolution.resolutionMethod).toBe('ops-watch-superseded');
  expect((await Alert.findById(newer._id)).status).toBe('active');
  expect((await Alert.findById(current._id)).status).toBe('active');
  await reconcileReports({ checkedAt, incidentKey: null });
  expect((await Alert.findById(current._id)).resolution.resolutionMethod).toBe('ops-watch-clear');
  expect((await Alert.findById(newer._id)).status).toBe('active');
});

test('new findings notify the same incident once, while unchanged and acknowledged reports keep native silence', async () => {
  const service = require('../../src/services/alertService');
  const rule = require('../../config/default-alert-rules.json').find(item => item.id === RULE_ID);
  service.loadRules([rule]);
  const notify = jest.spyOn(service, '_sendNotifications').mockResolvedValue();
  const event = findingFingerprint => ({ component: 'operations', metric: 'ops_watch_report', value: 1,
    threshold: 0, source: 'ops-watch', additionalData: { detector: 'ops_watch_report',
      incidentKey: 'ops-watch:current', findingFingerprint, findingCount: 1, summary: 'Synthetic finding' } });
  try {
    await publishReport(event('first'));
    await publishReport(event('first'));
    expect(notify).toHaveBeenCalledTimes(1);
    await publishReport(event('changed'));
    await publishReport(event('changed'));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await Alert.countDocuments({ ruleId: RULE_ID })).toBe(1);
    const current = await Alert.findOne({ ruleId: RULE_ID });
    expect(current.notificationCount).toBe(2);
    await service.acknowledgeAlert(current._id, 'synthetic-operator');
    await publishReport(event('third'));
    expect(notify).toHaveBeenCalledTimes(2);
  } finally { notify.mockRestore(); }
});

test('the bounded cursor scan includes acknowledged findings beyond the first page and excludes own reports', async () => {
  await Alert.insertMany(Array.from({ length: 102 }, (_, i) => ({ ...escalation(String(9200 + i)), status: 'acknowledged' })));
  await Alert.create(report('legacy'));
  const alerts = await listOpenAlerts();
  expect(alerts).toHaveLength(102);
  expect(alerts.every(alert => alert.status === 'acknowledged' && alert.ruleId !== RULE_ID)).toBe(true);
  await Alert.insertMany(Array.from({ length: 400 }, (_, i) => escalation(String(9400 + i))));
  await expect(listOpenAlerts()).rejects.toThrow('scan is incomplete');
});
