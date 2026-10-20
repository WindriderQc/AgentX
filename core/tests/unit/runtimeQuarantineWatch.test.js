'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Alert = require('../../models/Alert');
const HostPreference = require('../../models/HostPreference');
const Runtime = require('../../models/RuntimeCoordination');
const alertService = require('../../src/services/alertService');
const watch = require('../../src/services/runtimeQuarantineWatch');

const HOST = 'http://quarantine-host:11434';
const NOW = Date.parse('2026-10-20T03:10:00Z');
const RULE = require('../../config/default-alert-rules.json').find(rule => rule.id === 'runtime-recovery-quarantine');

beforeEach(async () => {
  alertService.loadRules([RULE]);
  await Promise.all([Alert.deleteMany({ ruleId: RULE.id }), HostPreference.deleteMany({}), Runtime.deleteMany({})]);
});

describe('runtimeQuarantineWatch.findQuarantines', () => {
  it('stays quiet for live owners and ordinary claims', () => {
    const runtime = {
      workloads: [{ workloadId: 'live', hosts: [HOST], kind: 'profiler', recoveryState: 'PREPARED', expiresAt: new Date(NOW + 30_000) }],
      inferences: [{ requestId: 'chat', host: HOST, kind: 'chat', state: 'ACTIVE', expiresAt: new Date(NOW + 30_000) }]
    };
    const prefs = [{ hostUrl: HOST, status: 'benchmarking', benchmarkClaim: { batchId: 'live' } }];
    expect(watch.findQuarantines(runtime, prefs, NOW)).toEqual([]);
  });

  it('names the 2026-10-20 UGAlien state: UNKNOWN workload and a claim under status idle', () => {
    const runtime = { workloads: [{ workloadId: 'profiler-queue-38b4', hosts: [HOST], kind: 'profiler',
      recoveryState: 'UNKNOWN', recoveryReceipt: { reason: 'BENCHMARK_CLAIM_LOST' },
      expiresAt: new Date(NOW - 10_000), recoveryArmedAt: new Date(NOW - 600_000) }] };
    const prefs = [{ hostUrl: HOST, hostKey: 'primary', status: 'idle', benchmarkClaim: { batchId: 'profiler-queue-38b4', source: 'profiler' } }];
    expect(watch.findQuarantines(runtime, prefs, NOW)).toEqual([
      expect.objectContaining({ host: HOST, holder: 'profiler-queue-38b4', failureCode: 'workload_recovery_unknown', reason: 'BENCHMARK_CLAIM_LOST' }),
      expect.objectContaining({ host: HOST, holder: 'profiler-queue-38b4', failureCode: 'claim_status_overwritten', reason: 'host status idle' })
    ]);
  });

  it('waits a grace minute before calling an expired owner gone', () => {
    const late = { workloads: [{ workloadId: 'late', hosts: [HOST], kind: 'benchmark', expiresAt: new Date(NOW - 5_000) }] };
    expect(watch.findQuarantines(late, [], NOW)).toEqual([]);
    const gone = { workloads: [{ workloadId: 'gone', hosts: [HOST], kind: 'benchmark', expiresAt: new Date(NOW - watch.EXPIRED_GRACE_MS - 1) }] };
    expect(watch.findQuarantines(gone, [], NOW)).toEqual([expect.objectContaining({ failureCode: 'workload_owner_gone' })]);
  });

  it('reports an UNKNOWN inference and an UNKNOWN maintenance lease', () => {
    const runtime = {
      maintenance: { requestId: 'deploy-1', scope: 'deploy', state: 'UNKNOWN', unknownReason: 'restart outcome unknown' },
      inferences: [{ requestId: 'chat-1', host: HOST, kind: 'chat', model: 'm', state: 'UNKNOWN', expiresAt: new Date(NOW + 1000) }]
    };
    expect(watch.findQuarantines(runtime, [], NOW).map(item => item.failureCode))
      .toEqual(['maintenance_unknown', 'inference_recovery_unknown']);
  });
});

describe('runtimeQuarantineWatch.scan', () => {
  it('raises one critical incident per holder and deduplicates repeats', async () => {
    await HostPreference.create({ hostUrl: HOST, hostKey: 'primary', status: 'idle',
      benchmarkClaim: { batchId: 'profiler-queue-38b4', prevStatus: 'ready', claimedAt: new Date(NOW - 60_000), source: 'profiler' } });
    await watch.scan(NOW);
    await watch.scan(NOW);
    const alerts = await Alert.find({ ruleId: RULE.id }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', occurrenceCount: 2 });
    expect(alerts[0].title).toContain(HOST);
    expect(alerts[0].message).toContain('profiler-queue-38b4');
  });
});
