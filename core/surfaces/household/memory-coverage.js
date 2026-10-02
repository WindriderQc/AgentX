'use strict';

const MEMORY_REVIEW_JOB_ID = String(process.env.MEMORY_REVIEW_JOB_ID || '').trim();
const MEMORY_REVIEW_JOB_NAME = 'memory-review-shadow';

function boundedIso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function lastRunAt(job = {}) {
  const direct = boundedIso(job.lastRun || job.lastRunAt);
  if (direct) return direct;
  const millis = Number(job.lastRunAtMs);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function issue(id, runtime, severity, detail) {
  return { id, runtime, severity, detail };
}

function memoryReviewCollectorPosture(automations = []) {
  const rows = Array.isArray(automations) ? automations : [];
  const matches = rows.filter((row) => row?.name === MEMORY_REVIEW_JOB_NAME
    && (!MEMORY_REVIEW_JOB_ID || row?.id === MEMORY_REVIEW_JOB_ID));
  const job = matches.length === 1 ? matches[0] : null;
  if (!job) return {
    status: 'unavailable',
    authority: 'official-openclaw-cli',
    scope: 'openclaw-hermes-owner-provenance',
    lastRunAt: null,
    receiptAvailable: false,
    issues: [issue(
      'receipt-unavailable',
      'openclaw-hermes',
      'warning',
      'The scheduled Memory Review collector receipt is unavailable.'
    )]
  };

  const enabled = job.enabled !== false;
  const normalizedHealth = String(job.health || '').trim().toLowerCase();
  const lastStatus = String(job.lastRunStatus || job.lastStatus || normalizedHealth).trim().toLowerCase();
  const healthy = enabled && (normalizedHealth === 'healthy' || ['ok', 'success'].includes(lastStatus));
  const observedLastRunAt = lastRunAt(job);
  const diagnostic = String(job.lastDiagnosticSummary || job.lastError || '').slice(0, 8000);
  const issues = [];

  if (/legacy-session-unregistered/i.test(diagnostic)) issues.push(issue(
    'openclaw-legacy-session',
    'openclaw',
    'info',
    'Unregistered legacy OpenClaw sessions stayed local and ineligible; current registered-session provenance remains authoritative.'
  ));
  if (/owner-identity-unavailable/i.test(diagnostic)) issues.push(issue(
    'openclaw-owner-provenance',
    'openclaw',
    'warning',
    'Some legacy OpenClaw events lack owner provenance; they stayed local and ineligible for shared memory.'
  ));
  if (/owner-identity-unconfigured/i.test(diagnostic)) issues.push(issue(
    'hermes-owner-provenance',
    'hermes',
    'warning',
    'Hermès owner provenance is not configured; direct-session content stayed local and ineligible.'
  ));
  if (/owner-session-unavailable/i.test(diagnostic)) issues.push(issue(
    'hermes-owner-session',
    'hermes',
    'info',
    'No recent Hermès direct session matched the configured owner evidence; session content stayed local.'
  ));
  if (/\bdrift\s*:/i.test(diagnostic) && issues.length === 0) issues.push(issue(
    'collector-drift',
    'openclaw-hermes',
    'warning',
    'The scheduled Memory Review collector reported bounded drift; inspect Memory Review before calling coverage clear.'
  ));
  if (!enabled || !healthy) issues.unshift(issue(
    'collector-health',
    'openclaw-hermes',
    'warning',
    enabled
      ? 'The scheduled Memory Review collector did not finish successfully.'
      : 'The scheduled Memory Review collector is disabled.'
  ));

  // Agent Ops deliberately strips successful diagnostic prose at its privacy
  // boundary. The exact job identity plus a bounded run timestamp is enough to
  // prove a receipt; a retained sanitized diagnostic can still prove one when
  // a legacy timestamp is invalid or absent.
  const receiptAvailable = Boolean(observedLastRunAt || diagnostic.length);
  const warning = issues.some((row) => row.severity === 'warning');
  const status = warning
    ? 'attention'
    : !receiptAvailable
      ? 'unavailable'
      : issues.length
        ? 'limited'
        : 'ready';
  return {
    status,
    authority: 'official-openclaw-cli',
    scope: 'openclaw-hermes-owner-provenance',
    lastRunAt: observedLastRunAt,
    receiptAvailable,
    issues
  };
}

module.exports = {
  MEMORY_REVIEW_JOB_ID,
  MEMORY_REVIEW_JOB_NAME,
  memoryReviewCollectorPosture
};
