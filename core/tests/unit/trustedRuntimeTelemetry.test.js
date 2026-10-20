'use strict';

const { telemetryEntry } = require('../../src/services/routing/trustedRuntimeTelemetry');
const { decisionForTelemetry } = require('../../src/services/routing/inferenceTelemetry');
const { projectInferenceLog } = require('../../src/services/routing/inferenceLogReadProjection');

test('trusted runtime outcome survives the persisted decision and public projection', () => {
  const entry = telemetryEntry({ mode: 'chat' }, { model: 'local/brain', hostUrl: 'http://192.0.2.1:11434',
    failure: { cause: 'workload_reserved', safeToRetry: true, holder: { principal: 'PRIVATE_OWNER' } },
  }, Date.now(), 'error');
  const row = projectInferenceLog({ ...entry, routeDecision: decisionForTelemetry(entry) });
  expect(row.routeDecision.outcome).toEqual({ stage: 'admission', code: 'pre_dispatch_error', reasonCode: 'workload_reserved' });
  expect(JSON.stringify(row)).not.toContain('PRIVATE_OWNER');
});

test.each([
  ['success', null, {}, 'execution', 'execution_succeeded', null],
  ['success', null, { failure: { cause: 'workload_reserved' } }, 'execution', 'execution_succeeded', null],
  ['error', 'cancelled', { failure: { cause: 'workload_reserved' } }, 'execution', 'caller_disconnected', 'caller_disconnected'],
  ['timeout', 'timeout_600000ms', {}, 'execution', 'upstream_timeout', 'upstream_timeout'],
  ['error', 'upstream_http_503', {}, 'execution', 'upstream_error', 'upstream_error'],
  ['error', 'PRIVATE_BODY', { failure: { cause: 'PRIVATE_CAUSE' } }, 'unknown', 'unknown', null],
])('classifies status=%s error=%s using closed evidence', (status, error, metadata, stage, code, reasonCode) => {
  const entry = telemetryEntry({ mode: 'chat' }, metadata, Date.now(), status, null, error);
  expect(decisionForTelemetry(entry).outcome).toEqual({ stage, code, reasonCode });
});
