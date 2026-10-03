'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { createOpsWatch, collectFindings, watchIntervalMs, RULE_ID } = require('../../src/services/opsWatchService');

const snapshot = ({ issues = [], alerts = [] } = {}) => ({ operationalAttention: { issues }, alerts });
const offline = { code: 'host_preference_offline', severity: 'critical', message: 'Host B default is offline', hostKey: 'host-b' };
const spill = { ruleId: 'pin-vram-spill', severity: 'warning', title: 'Pinned model off GPU', message: 'embedder partly on CPU',
  context: { additionalData: { host: 'http://host-b:11434' } } };

function harness(snapshots, answer = { ok: true, body: { response: 'Host B is offline: restart it.' }, headers: { 'X-Resolved-Model': 'cpu-model' } }) {
  const queue = [...snapshots];
  const execute = jest.fn(async () => (typeof answer === 'function' ? answer() : answer));
  const evaluateEvent = jest.fn(async () => ({ emitted: 1 }));
  const watch = createOpsWatch({
    buildSnapshot: async () => (queue.length > 1 ? queue.shift() : queue[0]),
    execute, evaluateEvent, language: 'French', now: () => new Date('2030-01-01T00:00:00Z')
  });
  return { watch, execute, evaluateEvent };
}

describe('operations watch', () => {
  it('is opt-in and never runs more often than every five minutes', () => {
    expect(watchIntervalMs({})).toBe(0);
    expect(watchIntervalMs({ OPS_WATCH_MS: '1000' })).toBe(300000);
    expect(watchIntervalMs({ OPS_WATCH_MS: '900000' })).toBe(900000);
  });

  it('collects rule findings, critical first, without the alert count or its own report', () => {
    const findings = collectFindings(snapshot({
      issues: [{ code: 'active_alerts', severity: 'attention', message: '2 active alerts' }, offline],
      alerts: [spill, { ruleId: RULE_ID, severity: 'warning', title: 'Operations watch — 1 finding(s)', message: 'old report' }]
    }));
    expect(findings.map(finding => [finding.severity, finding.key])).toEqual([
      ['critical', 'issue:host_preference_offline:host-b'],
      ['attention', 'alert:pin-vram-spill:http://host-b:11434']
    ]);
  });

  it('keeps every incident of one rule as its own finding', () => {
    const task = (id, fingerprint) => ({ ruleId: 'pipeline-task-escalation', severity: 'warning', fingerprint,
      title: `Pipeline task ${id} needs inspection`, message: 'heartbeat_stale' });
    const findings = collectFindings(snapshot({ alerts: [task('0001', 'aaa'), task('0002', 'bbb'), task('0001', 'aaa')] }));
    expect(findings.map(finding => finding.key)).toEqual([
      'alert:pipeline-task-escalation:aaa', 'alert:pipeline-task-escalation:bbb']);
  });

  it('stays silent and calls no model when rules flag nothing', async () => {
    const { watch, execute, evaluateEvent } = harness([snapshot()]);
    await expect(watch.check()).resolves.toEqual({ findingCount: 0, summarized: false, emitted: false });
    expect(execute).not.toHaveBeenCalled();
    expect(evaluateEvent).not.toHaveBeenCalled();
    expect(watch.latest()).toMatchObject({ findingCount: 0, source: 'rules' });
  });

  it('asks the ops_watch model once per finding set and reports through the alert engine', async () => {
    const { watch, execute, evaluateEvent } = harness([snapshot({ issues: [offline] })]);
    await watch.check();
    await watch.check();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ taskType: 'ops_watch', think: false, stream: false, callerDetail: 'ops-watch' });
    expect(execute.mock.calls[0][0].system).toContain('Write in French.');
    expect(execute.mock.calls[0][0].prompt).toContain('[critical] Host B default is offline');
    expect(evaluateEvent).toHaveBeenCalledTimes(2);
    const event = evaluateEvent.mock.calls[0][0];
    expect(event).toMatchObject({ metric: 'ops_watch_report', value: 1,
      additionalData: { findingCount: 1, summary: 'Host B is offline: restart it.', reportSource: 'model' } });
    expect(evaluateEvent.mock.calls[1][0].additionalData.incidentKey).toBe(event.additionalData.incidentKey);
    expect(watch.latest()).toMatchObject({ source: 'model', model: 'cpu-model' });
  });

  it('opens a new incident and asks again when the findings change', async () => {
    const { watch, execute, evaluateEvent } = harness([snapshot({ issues: [offline] }), snapshot({ issues: [offline], alerts: [spill] })]);
    await watch.check();
    await watch.check();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(evaluateEvent.mock.calls[1][0].additionalData.incidentKey)
      .not.toBe(evaluateEvent.mock.calls[0][0].additionalData.incidentKey);
    expect(evaluateEvent.mock.calls[1][0].additionalData.findingCount).toBe(2);
  });

  it('never hides findings when the model is busy, and retries it on the next check', async () => {
    let busy = true;
    const { watch, execute, evaluateEvent } = harness([snapshot({ issues: [offline] })],
      () => (busy ? { ok: false, status: 503, body: { code: 'BENCHMARK_CLAIM_ACTIVE' } }
        : { ok: true, body: { response: 'Restart host B.' }, headers: {} }));
    await watch.check();
    expect(evaluateEvent.mock.calls[0][0].additionalData).toMatchObject({
      reportSource: 'rules', summary: '- [critical] Host B default is offline' });
    expect(watch.latest().modelUnavailable).toBe('BENCHMARK_CLAIM_ACTIVE');
    busy = false;
    await watch.check();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(evaluateEvent.mock.calls[1][0].additionalData).toMatchObject({ reportSource: 'model', summary: 'Restart host B.' });
  });
});

describe('operations watch report delivery', () => {
  const Alert = require('../../models/Alert');
  const alertService = require('../../src/services/alertService');
  const rule = require('../../config/default-alert-rules.json').find(item => item.id === RULE_ID);

  beforeEach(async () => {
    await Alert.deleteMany({});
    alertService.loadRules([rule]);
  });

  it('renders the report as one telegram-targeted incident per finding set', async () => {
    expect(rule.channels).toEqual(['local_log', 'telegram']);
    const watch = createOpsWatch({
      buildSnapshot: async () => snapshot({ issues: [offline] }),
      execute: async () => ({ ok: true, body: { response: '1. Host B offline: restart it.' }, headers: {} }),
      evaluateEvent: event => alertService.evaluateEvent(event)
    });
    await watch.check();
    await watch.check();
    const alerts = await Alert.find({ ruleId: RULE_ID }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe('Operations watch — 1 finding(s)');
    expect(alerts[0].message).toBe('1. Host B offline: restart it.');
    expect(alerts[0].occurrenceCount).toBe(2);
  });
});
