'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertAgentXClaim,
  claimEnvironment,
  normalizeOrigin,
  verifyAgentXClaim
} = require('./agentxClaimAttestation');

const GENERATION = '123e4567-e89b-42d3-a456-426614174000';

test('claim attestation binds one generation to every expected host', () => {
  const env = claimEnvironment({
    hosts: ['http://candidate:11434/', 'http://judge:11434'],
    batchId: 'campaign-1',
    claimGeneration: GENERATION,
    coreUrl: 'http://core:3080',
    baseEnv: { KEEP_ME: 'yes', AGENTX_OPERATOR_TOKEN: 'private' }
  });
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.AGENTX_OPERATOR_TOKEN, 'private');
  assert.deepEqual(
    assertAgentXClaim(['http://candidate:11434', 'http://judge:11434/'], { env }),
    {
      batchId: 'campaign-1',
      claimGeneration: GENERATION,
      hosts: ['http://candidate:11434', 'http://judge:11434']
    }
  );
});

test('claim attestation fails closed on absence, malformed generations, or missing hosts', () => {
  assert.throws(() => assertAgentXClaim('http://candidate:11434', { env: {} }), /not active/);
  assert.throws(() => assertAgentXClaim('http://candidate:11434', {
    env: {
      AGENTX_CLAIM_ACTIVE: '1',
      AGENTX_CLAIM_BATCH_ID: 'campaign-1',
      AGENTX_CLAIM_GENERATION: 'not-a-uuid',
      AGENTX_CLAIM_HOSTS: 'http://candidate:11434'
    }
  }), /generation/);
  assert.throws(() => assertAgentXClaim('http://judge:11434', { env: claimEnvironment({
    hosts: ['http://candidate:11434'],
    batchId: 'campaign-1',
    claimGeneration: GENERATION,
    coreUrl: 'http://core:3080',
    baseEnv: {}
  }) }), /does not cover/);
  assert.throws(() => normalizeOrigin('http://candidate:11434/path'), /must be an HTTP\(S\) origin/);
});

test('live claim verification requires one exact Core-owned batch and generation per host', async () => {
  const env = claimEnvironment({
    hosts: ['http://candidate:11434', 'http://judge:11434'],
    batchId: 'campaign-1',
    claimGeneration: GENERATION,
    coreUrl: 'http://core:3080',
    baseEnv: { AGENTX_OPERATOR_TOKEN: 'private' }
  });
  const claims = [
    { hostUrl: 'http://candidate:11434', batchId: 'campaign-1', claimGeneration: GENERATION },
    { hostUrl: 'http://judge:11434', batchId: 'campaign-1', claimGeneration: GENERATION }
  ];
  const fetchImpl = async (url, options) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ status: 'success', data: { claims, count: claims.length } }),
    observed: { url, options }
  });
  const verified = await verifyAgentXClaim(['http://candidate:11434', 'http://judge:11434'], { env, fetchImpl });
  assert.equal(verified.coreUrl, 'http://core:3080');

  claims[1] = { ...claims[1], claimGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  await assert.rejects(
    verifyAgentXClaim(['http://candidate:11434', 'http://judge:11434'], { env, fetchImpl }),
    (error) => error.code === 'AGENTX_HOST_CLAIM_OWNERSHIP_MISMATCH'
  );
});
