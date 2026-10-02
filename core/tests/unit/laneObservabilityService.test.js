'use strict';

const express = require('express');
const request = require('supertest');
const Alert = require('../../models/Alert');
const AlertRule = require('../../models/AlertRule');
const InferenceLog = require('../../models/InferenceLog');
const alertService = require('../../src/services/alertService');
const laneObservability = require('../../src/services/laneObservabilityService');

const RULES = [
  ['lane-context-mismatch', laneObservability.METRICS.CONTEXT_MISMATCH],
  ['lane-output-contract-failure', laneObservability.METRICS.OUTPUT_CONTRACT_FAILURE],
  ['benchmark-claim-release-failure', laneObservability.METRICS.CLAIM_RELEASE_FAILURE],
  ['pin-restore-failure', laneObservability.METRICS.PIN_RESTORE_FAILURE],
  ['pin-vram-spill', laneObservability.METRICS.PIN_VRAM_SPILL],
  ['lane-latency-drift', laneObservability.METRICS.LATENCY_DRIFT],
].map(([id, metric]) => ({
  id,
  name: id,
  enabled: true,
  severity: 'warning',
  conditions: { all: [{ fact: 'metric', operator: 'equal', value: metric }] },
  channels: ['local_log'],
  title: `${id} — {{model}} on {{host}}`,
  message: '{{failureKind}} {{failureCode}} {{remediation}}',
}));

function contract(overrides = {}) {
  return {
    version: 'agentx.inference-contract.v1',
    artifact: {
      model: 'ax/gemma4:31b-it-qat',
      digest: 'sha256:artifact-digest',
      host: 'http://primary:11434',
      hostId: 'gpu-node-a',
    },
    qualification: { state: 'benchmarked', qualified: true },
    capabilities: {
      thinking: { supported: true, visibleFinalAnswer: { qualified: true } },
    },
    contextBudget: {
      windowTokens: 8192,
      validatedWindowTokens: 4096,
      resolvedWindowTokens: 4096,
      source: 'caller',
      resolvedSource: 'context_test',
      input: { overflowTokens: 128 },
      output: { reservedTokens: 4096 },
      transformations: {
        truncation: { applied: false },
        upstreamTruncationRisk: true,
      },
      enforcement: 'ollama_num_predict',
      ...overrides,
    },
  };
}

function inferenceInput(overrides = {}) {
  return {
    host: 'http://primary:11434',
    hostKey: 'primary',
    model: 'ax/gemma4:31b-it-qat',
    caller: 'proxy',
    taskType: 'master_brain',
    lane: 'automated',
    campaignId: 'campaign-0465',
    correlationId: 'correlation-0465',
    status: 'success',
    contract: contract(),
    outcome: {
      visibleFinal: false,
      thinkingOnly: true,
      completed: true,
      truncated: true,
      finishReason: 'length',
    },
    ...overrides,
  };
}

describe('laneObservabilityService', () => {
  beforeEach(async () => {
    alertService.loadRules(RULES);
    await Promise.all([
      Alert.deleteMany({ ruleId: { $in: laneObservability.RULE_IDS } }),
      AlertRule.deleteMany({ ruleId: { $in: laneObservability.RULE_IDS } }),
      InferenceLog.deleteMany({ callerDetail: /^0465-test/ }),
    ]);
  });

  afterAll(async () => {
    laneObservability.stop();
    await Promise.all([
      Alert.deleteMany({ ruleId: { $in: laneObservability.RULE_IDS } }),
      AlertRule.deleteMany({ ruleId: { $in: laneObservability.RULE_IDS } }),
      InferenceLog.deleteMany({ callerDetail: /^0465-test/ }),
    ]);
  });

  test('all detector rules use the product-owned local log and opt into reminders', () => {
    const defaults = require('../../config/default-alert-rules.json');
    const rules = defaults.filter((rule) => laneObservability.RULE_IDS.includes(rule.id));
    expect(rules).toHaveLength(laneObservability.RULE_IDS.length);
    for (const rule of rules) {
      expect(rule.channels).toEqual(['local_log']);
      expect(rule.renotifyMs).toBeGreaterThan(0);
      expect(rule.message).toContain('{{remediation}}');
    }
  });

  test('normal qualified output emits no contract event', async () => {
    const safeContract = contract({
      windowTokens: 4096,
      validatedWindowTokens: 4096,
      resolvedWindowTokens: 4096,
      input: { overflowTokens: 0 },
      transformations: {
        truncation: { applied: false },
        upstreamTruncationRisk: false,
      },
    });
    const result = await laneObservability.observeInference(inferenceInput({
      contract: safeContract,
      outcome: {
        visibleFinal: true,
        thinkingOnly: false,
        completed: true,
        truncated: false,
        finishReason: 'stop',
      },
    }));

    expect(result).toEqual({ emitted: 0, matched: 0 });
    expect(await Alert.countDocuments({ ruleId: { $in: laneObservability.RULE_IDS } })).toBe(0);
  });

  test('context mismatch and truncation/no-final create safe deduplicated alerts', async () => {
    const input = inferenceInput({
      prompt: 'must never be persisted',
      error: 'Bearer must-never-appear',
    });

    expect(await laneObservability.observeInference(input)).toEqual({ emitted: 2, matched: 2 });
    expect(await laneObservability.observeInference(input)).toEqual({ emitted: 2, matched: 2 });

    const alerts = await Alert.find({
      ruleId: { $in: ['lane-context-mismatch', 'lane-output-contract-failure'] },
    }).sort({ ruleId: 1 }).lean();
    expect(alerts).toHaveLength(2);
    expect(alerts.every((alert) => alert.occurrenceCount === 2)).toBe(true);
    expect(alerts.every((alert) => alert.context.additionalData.schemaVersion
      === laneObservability.SCHEMA_VERSION)).toBe(true);
    expect(alerts.every((alert) => alert.context.additionalData.artifactDigest
      === 'sha256:artifact-digest')).toBe(true);
    expect(alerts.every((alert) => /^[a-f0-9]{64}$/.test(
      alert.context.additionalData.contractFingerprint
    ))).toBe(true);
    const serialized = JSON.stringify(alerts);
    expect(serialized).not.toContain('must never be persisted');
    expect(serialized).not.toContain('must-never-appear');
  });

  test('incidentKey separates contracts while preserving per-contract deduplication', async () => {
    const base = {
      component: 'primary',
      metric: laneObservability.METRICS.CONTEXT_MISMATCH,
      value: 8192,
      threshold: 4096,
      source: 'lane-observability',
    };
    await alertService.evaluateEvent({
      ...base,
      additionalData: { host: 'http://primary:11434', model: 'model-a', incidentKey: 'contract-a' },
    });
    await alertService.evaluateEvent({
      ...base,
      additionalData: { host: 'http://primary:11434', model: 'model-a', incidentKey: 'contract-b' },
    });

    const alerts = await Alert.find({ ruleId: 'lane-context-mismatch' }).lean();
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((alert) => alert.fingerprint)).size).toBe(2);
  });

  test('claim and pin failures store bounded codes instead of raw errors', async () => {
    await laneObservability.observeClaimReleaseFailure({
      host: 'http://primary:11434',
      batchId: 'batch-123',
      error: 'claim belongs to batch other; Bearer private-token',
      source: 'unit-test',
    });
    await laneObservability.observePinRestoreFailure({
      host: 'http://secondary:11434',
      models: ['ax/gemma4:26b-a4b-it-qat'],
      error: 'model not found; password=private',
      source: 'unit-test',
    });

    const alerts = await Alert.find({
      ruleId: { $in: ['benchmark-claim-release-failure', 'pin-restore-failure'] },
    }).lean();
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.context.additionalData.failureCode).sort())
      .toEqual(['artifact_missing', 'claim_owner_conflict']);
    const serialized = JSON.stringify(alerts);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('password=private');
  });

  test('a VRAM spill is one incident per host until every pin fits again', async () => {
    const defaults = require('../../config/default-alert-rules.json');
    alertService.loadRules([defaults.find((rule) => rule.id === 'pin-vram-spill')]);
    const host = 'http://primary:11434';
    await laneObservability.observePinVramSpill({
      host,
      hostKey: 'primary',
      spills: [{ model: 'qwen3.8:27b-mtp-q8_0', size: 30903852071, sizeVram: 0 }],
      source: 'unit-test',
    });
    await laneObservability.observePinVramSpill({
      host,
      hostKey: 'primary',
      spills: [
        { model: 'qwen3.8:27b-mtp-q8_0', size: 30903852071, sizeVram: 0 },
        { model: 'qllama/bge-m3:f16', size: 1000, sizeVram: 400 },
      ],
      source: 'unit-test',
    });

    const open = await Alert.find({ ruleId: 'pin-vram-spill' }).lean();
    expect(open).toHaveLength(1);
    expect(open[0].occurrenceCount).toBe(2);
    expect(open[0].context.additionalData.failureCode).toBe('pin_on_cpu');
    expect(open[0].context.additionalData.evidence.modelList)
      .toBe('qwen3.8:27b-mtp-q8_0, qllama/bge-m3:f16');
    expect(open[0].message).not.toContain('[missing:');

    expect(await laneObservability.resolvePinVramSpill({ host })).toBe(0);
    await Alert.updateMany({ ruleId: 'pin-vram-spill' }, { $set: { lastOccurrence: new Date(Date.now() - 3600000) } });
    await alertService.resolveStaleAlerts();
    expect(await Alert.countDocuments({ ruleId: 'pin-vram-spill', status: 'active' })).toBe(1);
    expect(await laneObservability.resolvePinVramSpill({ host, health: {
      host, status: 'unknown', checkedAt: new Date().toISOString(), entries: []
    } })).toBe(0);
    expect(await laneObservability.resolvePinVramSpill({ host, health: {
      host, status: 'healthy', checkedAt: new Date().toISOString(), entries: [{ loaded: true, status: 'full' }]
    } })).toBe(1);
    expect(await Alert.countDocuments({ ruleId: 'pin-vram-spill', status: 'active' })).toBe(0);
  });

  test('a partial spill is reported as such and an empty spill emits nothing', async () => {
    expect(await laneObservability.observePinVramSpill({ host: 'http://tertiary:11434', spills: [] }))
      .toEqual({ emitted: 0, matched: 0 });
    await laneObservability.observePinVramSpill({
      host: 'http://tertiary:11434',
      spills: [{ model: 'qllama/bge-m3:f16', size: 1263009790, sizeVram: 581980651 }],
    });
    const alert = await Alert.findOne({ ruleId: 'pin-vram-spill' }).lean();
    expect(alert.context.additionalData.failureCode).toBe('pin_partial_spill');
    expect(alert.context.currentValue).toBe(1263009790 - 581980651);
  });

  test('sample-gated latency drift compares recent median with prior window', async () => {
    const now = new Date('2026-08-12T21:00:00.000Z');
    const row = (hoursAgo, durationMs, workItemId = 'campaign-latency') => ({
      timestamp: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000),
      durationMs,
      status: 'success',
      host: 'http://primary:11434',
      hostKey: 'primary',
      model: 'ax/gemma4:31b-it-qat',
      caller: 'proxy',
      taskType: 'master_brain',
      workItemId,
      routeDecision: {
        decisionVersion: 1,
        intent: { taskType: 'master_brain' },
        optionsFingerprint: 'options-123',
      },
    });
    const baseline = Array.from({ length: 12 }, (_, index) => row(2 + index, 1000 + index));
    const recent = [row(0.2, 9000), row(0.4, 10000), row(0.6, 11000)];

    const pure = laneObservability.findLatencyDrifts([...baseline, ...recent], { now });
    expect(pure.drifts).toHaveLength(1);
    expect(pure.drifts[0]).toEqual(expect.objectContaining({
      recentMedianMs: 10000,
      baselineSamples: 12,
      recentSamples: 3,
      campaignId: 'campaign-latency',
    }));

    const scanned = await laneObservability.scanLatencyDrift({ rows: [...baseline, ...recent], now });
    expect(scanned).toEqual(expect.objectContaining({ status: 'ok', drifts: 1, alertsMatched: 1 }));
    const alert = await Alert.findOne({ ruleId: 'lane-latency-drift' }).lean();
    expect(alert.context.additionalData.evidence.recentMedianMs).toBe(10000);
    expect(alert.context.additionalData.evidence.baselineMedianMs).toBeGreaterThan(0);
  });

  test('read-only route exposes rules, coverage, and detector state without writes', async () => {
    await AlertRule.create({
      ruleId: 'lane-latency-drift',
      name: 'Lane latency drift',
      enabled: true,
      severity: 'warning',
      conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'lane_latency_drift' }] },
      channels: ['local_log'],
      builtIn: true,
    });
    await InferenceLog.create({
      host: 'http://primary:11434',
      hostKey: 'primary',
      model: 'ax/gemma4:31b-it-qat',
      caller: 'proxy',
      callerDetail: '0465-test-projection',
      status: 'success',
      durationMs: 1200,
      routeDecision: { decisionVersion: 1 },
      timestamp: new Date(),
    });
    const before = {
      alerts: await Alert.countDocuments({}),
      logs: await InferenceLog.countDocuments({ callerDetail: '0465-test-projection' }),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', require('../../routes/alerts'));

    const response = await request(app).get('/api/alerts/lane-observability').expect(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data).toEqual(expect.objectContaining({
      schemaVersion: laneObservability.SCHEMA_VERSION,
      mode: 'observe_only',
      mutationBoundary: 'alerts_only',
    }));
    expect(response.body.data.inferenceCoverage24h).toEqual(expect.objectContaining({
      total: expect.any(Number),
      attributed: expect.any(Number),
    }));
    expect(response.body.data.rules.some((rule) => rule.ruleId === 'lane-latency-drift')).toBe(true);
    expect(await Alert.countDocuments({})).toBe(before.alerts);
    expect(await InferenceLog.countDocuments({ callerDetail: '0465-test-projection' })).toBe(before.logs);
  });
});
