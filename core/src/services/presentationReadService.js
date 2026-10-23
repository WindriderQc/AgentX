'use strict';

const { createHash } = require('node:crypto');

// A short-lived read receipt for the exact data returned to a view. This cache
// is not conversation storage: a miss never re-runs a query, tool or model.
// Restart/eviction is an explicit unavailable read; canonical replies stay in
// the existing conversation store. No DOM, credentials or host inventories.
const CONTRACT = 'agentx.presentation-read/v1';
const TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 32768;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const units = Object.freeze({ calls: 'calls', errors: 'calls', cancellations: 'calls', nonSuccesses: 'calls',
  errorRate: 'percent', fallbackCalls: 'calls', fallbackRate: 'percent', tokensIn: 'tokens', tokensOut: 'tokens',
  avgLatencyMs: 'ms', timedCalls: 'calls', inferenceHours: 'hours', inferenceSeconds: 'seconds', estimatedCostUsd: 'USD' });
const metrics = (source, keys = Object.keys(units)) => Object.fromEntries(keys.map(key => [key, number(source?.[key])]));
const rowMetrics = ['calls', 'errors', 'cancellations', 'tokensOut', 'avgLatencyMs', 'inferenceSeconds'];

function analyticsSnapshot(data) {
  if (data?.source !== 'inferencelogs' || !['24h', '7d', '30d', '90d'].includes(data.window?.key)) return null;
  const from = new Date(data.window.from), to = new Date(data.window.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return null;
  const models = (data.byModel || []).slice(0, 40);
  const buckets = (data.byBucket || []).slice(0, 96);
  return { contract: CONTRACT, source: 'analytics.inference.summary', page: 'analytics',
    observedAt: to.toISOString(), expiresAt: new Date(to.getTime() + TTL_MS).toISOString(),
    filters: { window: data.window.key }, period: { from: from.toISOString(), to: to.toISOString(), timezone: 'UTC' },
    units, totals: metrics(data.totals), local: metrics(data.local), cloud: metrics(data.cloud),
    byModel: models.map(row => ({ model: clean(row.model), ...metrics(row, rowMetrics) })),
    byConsumerContract: (data.byConsumerContract || []).slice(0, 12).map(row => ({ consumerContract: clean(row.consumerContract), ...metrics(row, rowMetrics) })),
    topErrors: (data.topErrors || []).slice(0, 12).map(row => ({ reason: clean(row.reason), consumerContract: clean(row.consumerContract),
      model: clean(row.model), calls: number(row.calls), avgLatencyMs: number(row.avgLatencyMs) })),
    timing: require('./inferenceTimingSummary').projectTiming(data.timing),
    attribution: data.attribution ? {
      ...metrics(data.attribution, ['calls', 'identifiedCalls', 'missingCalls', 'identifiedPct']),
      missingByCaller: (data.attribution.missingByCaller || []).slice(0, 7).map(row => ({
        caller: ['chat', 'council', 'benchmark', 'embedding', 'classification', 'proxy'].includes(row.caller) ? row.caller : 'unknown',
        calls: number(row.calls)
      }))
    } : null,
    failureAnalysis: { admissionRefusals: number(data.failureAnalysis?.admissionRefusals),
      unclassified: number(data.failureAnalysis?.unclassified) },
    bucketHours: number(data.bucketHours),
    byBucket: buckets.map(row => ({ at: clean(row.date), ...metrics(row, ['calls', 'errors', 'tokensOut', 'avgLatencyMs']) })),
    coverage: { modelsListed: models.length, modelCount: number(data.coverage?.modelCount),
      bucketCount: (data.byBucket || []).length, bucketsListed: buckets.length,
      retentionDays: number(data.coverage?.retentionDays), unpricedModels: (data.cloud?.unpricedModels || []).length },
    limits: ['Recorded attempts, including admission refusals; retries may repeat a user request.',
      'Attempt error rates do not establish service reliability or the success rate of user requests.',
      'Consumer identity requires a server-attested contract. Runtime, caller and task type do not identify the application; missing historical contracts are not inferred.',
      'Calls bypassing Core are absent. Tokens are reported usage only. Null means unobserved.',
      'Elapsed call time includes waits; it is not GPU busy time. USD uses configured prices; unpriced models are excluded.',
      'This receipt covers the inference overview, comparisons (up to 40 models, 12 consumers/errors) and UTC trend (96 buckets) only. Live runtime, GPUs and other detail panels are not read.'] };
}

function createPresentationReader({ now = Date.now, capacity = 128 } = {}) {
  const snapshots = new Map();
  const prune = () => {
    for (const [id, row] of snapshots) if (Date.parse(row.expiresAt) <= now()) snapshots.delete(id);
    while (snapshots.size >= capacity) snapshots.delete(snapshots.keys().next().value);
  };
  function publish(snapshot) {
    if (!snapshot) return null;
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json) > MAX_BYTES) return null;
    const revision = createHash('sha256').update(json).digest('hex');
    const id = 'view_' + revision;
    prune();
    snapshots.set(id, JSON.parse(json));
    return { contract: CONTRACT, id, revision, source: snapshot.source,
      filters: snapshot.filters, observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt };
  }
  return {
    publishAnalytics: data => publish(analyticsSnapshot(data)),
    publishRuntime: data => publish(require('./analyticsLivePresentation').runtimeSnapshot(data, now())),
    publishGpus: data => publish(require('./analyticsLivePresentation').gpuSnapshot(data, now())),
    read({ id, revision } = {}) {
      const missing = reason => ({ contract: CONTRACT, status: 'unavailable', reason });
      if (!/^view_[a-f0-9]{64}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(revision || '')) return missing('invalid_reference');
      const snapshot = snapshots.get(id);
      if (!snapshot) return missing('expired_or_not_retained');
      if (id !== 'view_' + revision) return missing('revision_mismatch');
      if (Date.parse(snapshot.expiresAt) <= now()) return missing('expired');
      return { ...JSON.parse(JSON.stringify(snapshot)), id, revision, status: 'available' };
    }
  };
}

const presentationReader = createPresentationReader();
const PRESENTATION_TOOLS = [{ name: 'read_presentation', title: 'Read Presented Content',
  description: 'Read the exact Core Analytics summary or live runtime/GPU snapshot referenced by the current screen context. Requires its id and revision. Each source has its own freshness and scope; live data is independent of historical filters. Never fetches a URL or re-executes a tool. A receipt does not prove browser display; unavailable requires refreshing the view.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: {
    id: { type: 'string', pattern: '^view_[a-f0-9]{64}$' }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }];
const PRESENTATION_TOOL_HANDLERS = { read_presentation: (args, deps = {}) => (deps.presentationReader || presentationReader).read(args) };

module.exports = { CONTRACT, TTL_MS, analyticsSnapshot, createPresentationReader, presentationReader, PRESENTATION_TOOLS, PRESENTATION_TOOL_HANDLERS };
