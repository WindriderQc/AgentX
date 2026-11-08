'use strict';

const { projectInferenceLog } = require('../../src/services/routing/inferenceLogReadProjection');
const fingerprint = 'a1'.repeat(32);

test.each([
  ['openclaw', 'model'], ['openclaw', 'agent'], ['local', 'model'], ['local', 'agent']
])('preserves recorded execution %s/%s independently of the Core runtime', (executionSource, executionMode) => {
  expect(projectInferenceLog({ runtime: 'agentx', executionSource, executionMode,
    executionReceiptFingerprint: fingerprint })).toEqual({
    runtime: 'agentx', executionSource, executionMode, executionReceiptFingerprint: fingerprint
  });
});

test('legacy missing execution metadata stays absent rather than inferring local from runtime or host', () => {
  const row = projectInferenceLog({ runtime: 'agentx', host: 'http://local.example.test:11434', status: 'success' });
  for (const field of ['executionSource', 'executionMode', 'executionReceiptFingerprint']) {
    expect(row).not.toHaveProperty(field);
  }
  expect(projectInferenceLog({ executionSource: 'openclaw' })).toEqual({ executionSource: 'openclaw' });
  expect(projectInferenceLog({ executionReceiptFingerprint: fingerprint })).toEqual({ executionReceiptFingerprint: fingerprint });
});

test.each([null, '', 'PRIVATE_PROVIDER_TEXT', 'https://user:secret@example.test/private?token=secret',
  'openclaw\n', 1, true, {}, ['openclaw']])(
  'rejects invalid metadata without coercing or guessing an execution identity (%j)', value => {
    expect(projectInferenceLog({ executionSource: value, executionMode: value,
      executionReceiptFingerprint: value })).toEqual({
      executionSource: null, executionMode: null, executionReceiptFingerprint: null
    });
  }
);

test.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `sha256:${fingerprint}`, `${fingerprint}\n`])(
  'rejects fingerprints outside the persisted lower-case SHA256 format (%s)', value => {
    expect(projectInferenceLog({ executionReceiptFingerprint: value }).executionReceiptFingerprint).toBeNull();
  }
);

test('does not coerce a receipt-like object or expose raw receipts and native run identities', () => {
  const toString = jest.fn(() => fingerprint);
  const secret = 'PRIVATE_NATIVE_RECEIPT';
  const row = { executionSource: 'openclaw', executionMode: 'agent',
    executionReceiptFingerprint: { toString },
    executionReceipt: { messages: [secret], sessionId: secret, usage: { input: 10 } },
    sessionId: secret, runId: secret, payload: secret };
  const before = { ...row };
  expect(projectInferenceLog(row)).toEqual({ executionSource: 'openclaw', executionMode: 'agent',
    executionReceiptFingerprint: null });
  expect(toString).not.toHaveBeenCalled();
  expect(row).toEqual(before);
  expect(JSON.stringify(projectInferenceLog(row))).not.toContain(secret);
});
