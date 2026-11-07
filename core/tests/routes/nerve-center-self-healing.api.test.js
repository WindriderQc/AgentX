'use strict';

jest.mock('../../src/services/ollamaWatchdogService', () => ({
  getStats: jest.fn(() => ({ isRunning: false, hosts: [], history: [], config: { reloadAfterUnjam: false } })),
  runNow: jest.fn(), forceUnjam: jest.fn(), start: jest.fn()
}));
jest.mock('../../src/services/routing/taskFallbackLadder', () => ({
  getTaskFallbackConfigurationForRead: () => ({ configuredTasks: [], configurationErrors: [] })
}));
jest.mock('../../src/services/opsWatchService', () => ({
  watchIntervalMs: () => 0,
  getOpsWatch: () => ({ state: () => ({ scheduled: false }), latest: () => null })
}));

const express = require('express');
const request = require('supertest');
const Alert = require('../../models/Alert');
const AlertRule = require('../../models/AlertRule');
const HostPreference = require('../../models/HostPreference');
const InferenceLog = require('../../models/InferenceLog');
const Settings = require('../../models/OpsWatchSettings');
const alertService = require('../../src/services/alertService');
const watchdog = require('../../src/services/ollamaWatchdogService');
const { getSelfHealingStatus, MAX_CONFIG_ROWS } = require('../../src/services/selfHealingStatusService');
const app = express();
app.use('/api/nerve-center', require('../../routes/nerve-center-self-healing'));
const endpoint = '/api/nerve-center/self-healing';

beforeEach(async () => {
  await Promise.all([Alert, AlertRule, HostPreference, InferenceLog, Settings].map(Model => Model.deleteMany({})));
  alertService.loadRules([]);
  jest.clearAllMocks();
});

test('a synthetic detector event and delivery retain date and provenance after configuration is disabled', async () => {
  const rule = { id: 'synthetic-detector', name: 'Synthetic detector', enabled: true, severity: 'warning',
    conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'synthetic_fault' }] }, channels: ['local_log'] };
  await AlertRule.create({ ...rule, ruleId: rule.id });
  alertService.loadRules([rule]);
  const triggered = await alertService.evaluateEvent({ component: 'synthetic', metric: 'synthetic_fault', value: 1, source: 'synthetic-test' });
  expect(triggered).toHaveLength(1);
  await AlertRule.updateOne({ ruleId: rule.id }, { $set: { enabled: false } });
  alertService.loadRules([]);
  await HostPreference.create({ hostKey: 'synthetic', hostUrl: 'http://synthetic.test:11434',
    pinnedModels: [{ model: 'synthetic-pin', autoRestore: false }] });
  await Settings.create({ key: 'ops-watch', enabled: false, intervalMs: 900000, language: 'English' });
  const snapshots = await Promise.all([Alert, AlertRule, HostPreference, Settings].map(Model => Model.find().lean()));
  const evaluate = jest.spyOn(alertService, 'evaluateEvent');
  const notify = jest.spyOn(alertService, '_sendNotifications');
  const response = await request(app).get(endpoint).expect(200);
  await request(app).get(endpoint).expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const rows = response.body.data.rows;
  expect(rows.find(row => row.id === 'rule:synthetic-detector')).toMatchObject({ enabled: false, running: false,
    mode: 'detection', last: { id: String(triggered[0]._id), outcome: 'detected', event: 'synthetic_fault', source: 'Alert' } });
  expect(rows.find(row => row.id === 'rule:synthetic-detector').last.timestamp).toBeTruthy();
  expect(rows.find(row => row.id === 'local-notification')).toMatchObject({ enabled: false, last: { outcome: 'logged' } });
  expect(rows.find(row => row.id === 'pin:synthetic:0')).toMatchObject({ enabled: false, last: { outcome: 'unknown' } });
  expect(rows.find(row => row.id === 'ops-watch').enabled).toBe(false);
  expect(await Promise.all([Alert, AlertRule, HostPreference, Settings].map(Model => Model.find().lean()))).toEqual(snapshots);
  expect(evaluate).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(watchdog.runNow).not.toHaveBeenCalled();
  expect(watchdog.forceUnjam).not.toHaveBeenCalled();
  expect(watchdog.start).not.toHaveBeenCalled();
  evaluate.mockRestore(); notify.mockRestore();
});

test('reads the last fallback outcome with the existing safe projection; never exports legacy payloads', async () => {
  await InferenceLog.collection.insertOne({ timestamp: new Date('2026-10-01T00:00:00Z'), status: 'timeout',
    fallbackUsed: true, fallbackReason: 'connection_failure', host: 'http://synthetic.test:11434',
    prompt: 'PRIVATE_SYNTHETIC_PAYLOAD', response: 'PRIVATE_SYNTHETIC_PAYLOAD',
    routingTrace: { raw: 'PRIVATE_SYNTHETIC_PAYLOAD' } });
  const response = await request(app).get(endpoint).expect(200);
  expect(response.body.data.rows.find(row => row.id === 'routing-fallbacks').last).toMatchObject({
    source: 'InferenceLog', outcome: 'timeout', timestamp: '2026-10-01T00:00:00.000Z', reason: 'connection_failure'
  });
  expect(JSON.stringify(response.body)).not.toContain('PRIVATE_SYNTHETIC_PAYLOAD');
});

test('individual read failures become unknown while other sources remain usable', async () => {
  const data = await getSelfHealingStatus({ readers: {
    watchdog: () => { throw new Error('private error details'); },
    rules: () => ({ rows: [{ ruleId: 'disabled', enabled: false }] }),
    alerts: () => Promise.reject(new Error('private error details'))
  } });
  expect(data.sources.watchdog.status).toBe('unavailable');
  expect(data.rows.find(row => row.id === 'watchdog-reload').enabled).toBeNull();
  expect(data.rows.find(row => row.id === 'rule:disabled').enabled).toBe(false);
  expect(JSON.stringify(data)).not.toContain('private error details');
});

test.each([{ error: 'caller_disconnected' }, { routeDecision: { outcome: { code: 'caller_disconnected' } } }])(
  'does not turn retained cancellation evidence into a successful fallback: %j', async cancellation => {
    await InferenceLog.collection.insertOne({ timestamp: new Date(), status: 'success', fallbackUsed: true, ...cancellation });
    const response = await request(app).get(endpoint).expect(200);
    expect(response.body.data.rows.find(row => row.id === 'routing-fallbacks').last.outcome).toBe('cancelled');
  });

test('bounds configuration reads and reports partial coverage', async () => {
  await AlertRule.insertMany(Array.from({ length: MAX_CONFIG_ROWS + 1 }, (_, index) => ({
    ruleId: `synthetic-${String(index).padStart(3, '0')}`, name: 'Synthetic', enabled: false, severity: 'info'
  })));
  const response = await request(app).get(endpoint).expect(200);
  expect(response.body.data.sources.rules.truncated).toBe(true);
  expect(response.body.data.rows.filter(row => row.id.startsWith('rule:'))).toHaveLength(MAX_CONFIG_ROWS);
});

test('exposes no execution or configuration write endpoint', async () => {
  await request(app).post(endpoint).expect(404);
  await request(app).put(endpoint).expect(404);
  await request(app).delete(endpoint).expect(404);
});

test('retains the watchdog snapshot taken before other readers add later events', async () => {
  const timestamp = new Date(Date.now() - 1000).toISOString();
  const history = [{ type: 'jam_detected', timestamp, origin: 'autonomous', operationId: 'synthetic-operation',
    hostId: 'synthetic', hostUrl: 'http://synthetic.test:11434' }];
  watchdog.getStats.mockReturnValueOnce({ history, hosts: [], config: {} });
  const originalFindOne = Settings.findOne;
  const spy = jest.spyOn(Settings, 'findOne').mockImplementation(function (...args) {
    history.push({ ...history[0], type: 'unjam_success' });
    return originalFindOne.apply(this, args);
  });
  try {
    const response = await request(app).get(endpoint).expect(200);
    expect(history).toHaveLength(2);
    expect(response.body.data.rows.find(row => row.id === 'watchdog-unjam').last.outcome).toBe('unknown');
  } finally { spy.mockRestore(); }
});
