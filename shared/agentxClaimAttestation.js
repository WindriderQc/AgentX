'use strict';

const crypto = require('node:crypto');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_READ_TIMEOUT_MS = 10_000;
const MAX_CLAIM_RESPONSE_BYTES = 1024 * 1024;

function normalizeOrigin(value, label = 'claim host') {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} must be an HTTP(S) origin`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password
      || !['', '/'].includes(parsed.pathname)
      || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTP(S) origin`);
  }
  return parsed.origin;
}

function claimedHosts(env = process.env) {
  return String(env.AGENTX_CLAIM_HOSTS || env.AGENTX_CLAIM_HOST || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizeOrigin(value));
}

function assertAgentXClaim(expectedHosts, { env = process.env } = {}) {
  const expected = [...new Set((Array.isArray(expectedHosts) ? expectedHosts : [expectedHosts])
    .map((host) => normalizeOrigin(host)))];
  const actual = claimedHosts(env);
  const batchId = String(env.AGENTX_CLAIM_BATCH_ID || '').trim();
  const claimGeneration = String(env.AGENTX_CLAIM_GENERATION || '').trim();
  let reason = null;
  if (env.AGENTX_CLAIM_ACTIVE !== '1') reason = 'claim attestation is not active';
  else if (!batchId) reason = 'claim batch identity is missing';
  else if (!UUID_V4.test(claimGeneration)) reason = 'claim generation is missing or invalid';
  else if (expected.some((host) => !actual.includes(host))) reason = 'claim does not cover every expected host';
  if (reason) {
    const error = new Error(`${reason}; obtain an admitted Benchmark host claim for ${expected.join(', ')}`);
    error.code = 'AGENTX_HOST_CLAIM_REQUIRED';
    throw error;
  }
  return { batchId, claimGeneration, hosts: actual };
}

async function readActiveClaims(coreUrl, { env = process.env, fetchImpl = fetch } = {}) {
  const core = normalizeOrigin(coreUrl, 'claim authority');
  const response = await fetchImpl(`${core}/api/nerve-center/host-preferences/benchmark-claims/active`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(CLAIM_READ_TIMEOUT_MS)
  });
  if (!response?.ok) throw new Error(`claim authority returned HTTP ${response?.status || 'unavailable'}`);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLAIM_RESPONSE_BYTES) {
    throw new Error('claim authority response exceeded the limit');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_CLAIM_RESPONSE_BYTES) {
    throw new Error('claim authority response exceeded the limit');
  }
  const payload = JSON.parse(text);
  const claims = payload?.status === 'success' && Array.isArray(payload?.data?.claims)
    ? payload.data.claims
    : null;
  if (!claims || (payload.data.count !== undefined && Number(payload.data.count) !== claims.length)) {
    throw new Error('claim authority returned malformed active claims');
  }
  return claims;
}

async function verifyAgentXClaim(expectedHosts, {
  env = process.env,
  fetchImpl = fetch,
  coreUrl = env.AGENTX_CLAIM_CORE_URL || env.AGENTX_CORE_URL
} = {}) {
  const attestation = assertAgentXClaim(expectedHosts, { env });
  if (!coreUrl) throw new Error('live claim authority URL is missing');
  const expected = [...new Set((Array.isArray(expectedHosts) ? expectedHosts : [expectedHosts])
    .map((host) => normalizeOrigin(host)))];
  const claims = await readActiveClaims(coreUrl, { env, fetchImpl });
  for (const host of expected) {
    const matches = claims.filter((claim) => {
      try { return normalizeOrigin(claim?.hostUrl) === host; } catch { return false; }
    });
    if (matches.length !== 1
        || matches[0]?.batchId !== attestation.batchId
        || matches[0]?.claimGeneration !== attestation.claimGeneration) {
      const error = new Error(`live claim generation does not own ${host}`);
      error.code = 'AGENTX_HOST_CLAIM_OWNERSHIP_MISMATCH';
      throw error;
    }
  }
  return { ...attestation, coreUrl: normalizeOrigin(coreUrl, 'claim authority') };
}

function claimEnvironment({ hosts, batchId, claimGeneration, coreUrl, baseEnv }, fallbackBase = process.env) {
  const normalizedHosts = [...new Set(hosts.map((host) => normalizeOrigin(host)))];
  return {
    ...(baseEnv || fallbackBase),
    AGENTX_CLAIM_ACTIVE: '1',
    AGENTX_CLAIM_HOSTS: normalizedHosts.join(','),
    AGENTX_CLAIM_HOST: normalizedHosts[0],
    AGENTX_CLAIM_BATCH_ID: batchId,
    AGENTX_CLAIM_GENERATION: claimGeneration,
    AGENTX_CLAIM_CORE_URL: normalizeOrigin(coreUrl, 'claim authority'),
  };
}

function newClaimGeneration() {
  return crypto.randomUUID();
}

module.exports = {
  UUID_V4,
  CLAIM_READ_TIMEOUT_MS,
  MAX_CLAIM_RESPONSE_BYTES,
  assertAgentXClaim,
  claimEnvironment,
  claimedHosts,
  newClaimGeneration,
  normalizeOrigin,
  readActiveClaims,
  verifyAgentXClaim,
};
