'use strict';

// Janitor keeps its native reports. This module only binds an observation to
// its report date and projects bounded, path-free data for the existing reader.
function reportDate(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function requireReport(actual, expected) {
  if (!reportDate(actual) || reportDate(actual) !== reportDate(expected)) {
    throw Object.assign(new Error('Le rapport Janitor a changé ou sa version ne peut pas être vérifiée. Relire le rapport.'),
      { code: 'JANITOR_REPORT_CHANGED', status: 409 });
  }
}

function janitorSnapshot(view, now) {
  const generatedAt = reportDate(view?.generatedAt);
  if (!view?.available || !generatedAt) return null;
  const count = value => Number.isFinite(value) && value >= 0 ? value : null;
  const group = view.group && /^[a-f0-9]{64}$/.test(view.group.sha256) ? {
    sha256: view.group.sha256, found: view.group.found === true,
    copies: count(view.group.copies), provenSavingsBytes: count(view.group.provenSavingsBytes)
  } : null;
  return { contract: 'agentx.presentation-read/v1', source: 'janitor.report', page: 'diskx',
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(),
    generatedAt, filters: { report: generatedAt, group: group?.sha256 || null },
    reportStatus: String(view.status).slice(0, 80),
    counts: Object.fromEntries(['verifiedGroups', 'verifiedFiles', 'candidateGroups', 'executableActions', 'decisionsRequired', 'sharedDriveMutations']
      .map(key => [key, count(view.counts?.[key])])),
    provenSavingsBytes: count(view.provenSavingsBytes), group,
    bytesKind: 'logical', physicalSpaceMeasured: false, survivorRuleAuthorizes: false,
    survivorRule: ['canonical_active', 'newest', 'oldest'].includes(view.survivorRule) ? view.survivorRule : null,
    limits: ['Read-only report, not authorization or execution evidence.', 'Logical bytes, not physically freed space.'] };
}

module.exports = { reportDate, requireReport, janitorSnapshot };
