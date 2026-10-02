/**
 * Pure trend and non-destructive work-plan helpers for shared-drive strategy.
 * No database or filesystem access belongs in this module.
 */
const MAX_WORK_ITEMS = 12;
const HOTSPOT_LIMIT = 12;
const CANDIDATE_TYPES_PER_ROOT = 5;
const CANONICAL_ROOT_COUNT = 2;
const MAX_CANDIDATE_ITEMS = HOTSPOT_LIMIT * CANDIDATE_TYPES_PER_ROOT * CANONICAL_ROOT_COUNT;
const MAX_ORGANIZATION_CHANGES = 12;
const CANDIDATE_INDEX_VERSION = 1;
const MIB = 1024 * 1024;

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function idString(value) {
  if (value == null) return null;
  return typeof value.toHexString === 'function' ? value.toHexString() : String(value);
}

function canonicalRoots(report) {
  return Array.isArray(report?.scope?.canonicalRoots)
    ? [...report.scope.canonicalRoots].map(String).sort()
    : [];
}

function rootEvidence(report) {
  const rows = Array.isArray(report?.evidence?.perRoot) ? report.evidence.perRoot : [];
  return new Map(rows.filter(row => row?.root).map(row => [String(row.root), row]));
}

function compatibility(current, previous) {
  if (!previous) return { compatible: false, reason: 'no_previous_report' };
  if (previous.mode !== current.mode) return { compatible: false, reason: 'mode_changed' };
  const currentRoots = canonicalRoots(current);
  const previousRoots = canonicalRoots(previous);
  if (
    currentRoots.length === 0
    || currentRoots.length !== previousRoots.length
    || currentRoots.some((root, idx) => root !== previousRoots[idx])
  ) {
    return { compatible: false, reason: 'canonical_scope_changed' };
  }
  const required = [
    'verifiedDuplicateGroups',
    'verifiedDuplicateFiles',
    'provenSavingsBytes'
  ];
  if (required.some(key => numeric(previous?.evidence?.[key]) == null)) {
    return { compatible: false, reason: 'previous_duplicate_metrics_unavailable' };
  }
  const requiredCandidates = ['groups', 'files', 'candidateBytes'];
  if (
    requiredCandidates.some(
      key => numeric(previous?.evidence?.duplicateCandidates?.[key]) == null
    )
  ) {
    return { compatible: false, reason: 'previous_candidate_metrics_unavailable' };
  }
  const previousByRoot = rootEvidence(previous);
  if (currentRoots.some(root => !previousByRoot.has(root))) {
    return { compatible: false, reason: 'previous_root_metrics_unavailable' };
  }
  const requiredRootMetrics = [
    'totalFiles',
    'totalBytes',
    'unclassifiedFiles',
    'extensionlessByDesignFiles',
    'missingExtensionUnresolvedFiles',
    'timestampReviewFiles'
  ];
  if (
    currentRoots.some(root => requiredRootMetrics.some(
      key => numeric(previousByRoot.get(root)?.[key]) == null
    ))
  ) {
    return { compatible: false, reason: 'previous_root_metrics_unavailable' };
  }
  return { compatible: true, reason: null };
}

function delta(current, previous) {
  const a = numeric(current);
  const b = numeric(previous);
  return a == null || b == null ? null : a - b;
}

function organizationBaseline(reason, currentItems = null, previousItems = null) {
  return {
    status: 'baseline',
    reason,
    counts: null,
    totals: {
      current: currentItems,
      previous: previousItems,
      union: null,
      currentAccountedFor: null,
      previousAccountedFor: null
    },
    maxChanges: MAX_ORGANIZATION_CHANGES,
    topChanges: [],
    changesTruncated: false,
    note: 'Organization progress is unavailable; no work-item improvement, regression, or resolution is inferred.'
  };
}

function candidateIndex(strategy, side) {
  if (
    strategy?.candidateIndexVersion !== CANDIDATE_INDEX_VERSION
    || !Array.isArray(strategy?.candidateIndex)
  ) {
    return { available: false, reason: `${side}_candidate_index_unavailable` };
  }
  if (strategy.candidateIndexComplete !== true) {
    return { available: false, reason: `${side}_candidate_index_incomplete` };
  }
  if (
    strategy.candidateIndexMaxItems !== MAX_CANDIDATE_ITEMS
    || numeric(strategy.totalCandidateItems) !== strategy.candidateIndex.length
    || strategy.candidateIndex.length > MAX_CANDIDATE_ITEMS
  ) {
    return { available: false, reason: `${side}_candidate_index_invalid` };
  }
  const rows = [];
  const ids = new Set();
  for (const item of strategy.candidateIndex) {
    const id = String(item?.id || '').trim();
    const files = item?.evidence?.files;
    const bytes = item?.evidence?.bytes;
    if (
      !id
      || ids.has(id)
      || !Number.isInteger(files)
      || !Number.isFinite(bytes)
      || files <= 0
      || bytes < 0
      || item?.filesystemMutationAllowed !== false
    ) {
      return { available: false, reason: `${side}_candidate_index_invalid` };
    }
    ids.add(id);
    rows.push({
      id,
      type: String(item.type || ''),
      root: String(item.root || ''),
      title: String(item.title || id),
      evidence: { files, bytes }
    });
  }
  return { available: true, rows };
}

function evidenceChange(current, previous) {
  if (!previous) return 'new';
  if (!current) return 'resolved';
  const filesDelta = current.evidence.files - previous.evidence.files;
  const bytesDelta = current.evidence.bytes - previous.evidence.bytes;
  if (filesDelta < 0 || (filesDelta === 0 && bytesDelta < 0)) return 'improved';
  if (filesDelta > 0 || (filesDelta === 0 && bytesDelta > 0)) return 'worsened';
  return 'unchanged';
}

function changeDetail(id, current, previous) {
  const source = current || previous;
  const currentEvidence = current?.evidence || { files: 0, bytes: 0 };
  const previousEvidence = previous?.evidence || { files: 0, bytes: 0 };
  return {
    id,
    change: evidenceChange(current, previous),
    type: source.type,
    root: source.root,
    title: source.title,
    previousEvidence,
    currentEvidence,
    filesDelta: currentEvidence.files - previousEvidence.files,
    bytesDelta: currentEvidence.bytes - previousEvidence.bytes,
    filesystemMutationAllowed: false
  };
}

function compareOrganization(currentStrategy, previousStrategy, compatibilityReason = null) {
  const current = candidateIndex(currentStrategy, 'current');
  if (!current.available) return organizationBaseline(current.reason);
  if (compatibilityReason) {
    return organizationBaseline(compatibilityReason, current.rows.length, null);
  }
  const previous = candidateIndex(previousStrategy, 'previous');
  if (!previous.available) {
    return organizationBaseline(previous.reason, current.rows.length, null);
  }

  const currentById = new Map(current.rows.map(item => [item.id, item]));
  const previousById = new Map(previous.rows.map(item => [item.id, item]));
  const allIds = [...new Set([...currentById.keys(), ...previousById.keys()])].sort();
  const changes = allIds.map(id => changeDetail(
    id,
    currentById.get(id),
    previousById.get(id)
  ));
  const counts = { new: 0, improved: 0, worsened: 0, unchanged: 0, resolved: 0 };
  changes.forEach(item => { counts[item.change] += 1; });
  const changed = changes
    .filter(item => item.change !== 'unchanged')
    .sort((a, b) => (
      Math.abs(b.filesDelta) - Math.abs(a.filesDelta)
      || Math.abs(b.bytesDelta) - Math.abs(a.bytesDelta)
      || a.change.localeCompare(b.change)
      || a.id.localeCompare(b.id)
    ));
  return {
    status: 'compared',
    reason: null,
    counts,
    totals: {
      current: current.rows.length,
      previous: previous.rows.length,
      union: changes.length,
      currentAccountedFor: counts.new + counts.improved + counts.worsened + counts.unchanged,
      previousAccountedFor: counts.resolved + counts.improved + counts.worsened + counts.unchanged
    },
    maxChanges: MAX_ORGANIZATION_CHANGES,
    topChanges: changed.slice(0, MAX_ORGANIZATION_CHANGES),
    changesTruncated: changed.length > MAX_ORGANIZATION_CHANGES,
    note: 'Labels describe aggregate indexed-evidence changes only. File count is compared first, then bytes; no cleanup causation or maintenance authority is inferred.'
  };
}

function buildComparison(current, previous) {
  const check = compatibility(current, previous);
  if (!check.compatible) {
    return {
      status: 'baseline',
      reason: check.reason,
      previousReportId: idString(previous?._id),
      previousGeneratedAt: previous?.generatedAt || null,
      deltas: null,
      organization: compareOrganization(
        current?.organizationStrategy,
        previous?.organizationStrategy,
        check.reason
      ),
      note: 'No compatible prior strategy exists; current values are a baseline, not an improvement or regression.'
    };
  }

  const currentByRoot = rootEvidence(current);
  const previousByRoot = rootEvidence(previous);
  return {
    status: 'compared',
    reason: null,
    previousReportId: idString(previous._id),
    previousGeneratedAt: previous.generatedAt || null,
    organization: compareOrganization(
      current.organizationStrategy,
      previous.organizationStrategy
    ),
    deltas: {
      duplicates: {
        verifiedGroups: delta(
          current.evidence.verifiedDuplicateGroups,
          previous.evidence.verifiedDuplicateGroups
        ),
        verifiedFiles: delta(
          current.evidence.verifiedDuplicateFiles,
          previous.evidence.verifiedDuplicateFiles
        ),
        provenSavingsBytes: delta(
          current.evidence.provenSavingsBytes,
          previous.evidence.provenSavingsBytes
        )
      },
      candidates: {
        groups: delta(
          current.evidence.duplicateCandidates?.groups,
          previous.evidence.duplicateCandidates?.groups
        ),
        files: delta(
          current.evidence.duplicateCandidates?.files,
          previous.evidence.duplicateCandidates?.files
        ),
        candidateBytes: delta(
          current.evidence.duplicateCandidates?.candidateBytes,
          previous.evidence.duplicateCandidates?.candidateBytes
        )
      },
      perRoot: canonicalRoots(current).map(root => {
        const now = currentByRoot.get(root) || {};
        const before = previousByRoot.get(root) || {};
        return {
          root,
          totalFiles: delta(now.totalFiles, before.totalFiles),
          totalBytes: delta(now.totalBytes, before.totalBytes),
          unclassifiedFiles: delta(now.unclassifiedFiles, before.unclassifiedFiles),
          extensionlessByDesignFiles: delta(
            now.extensionlessByDesignFiles,
            before.extensionlessByDesignFiles
          ),
          missingExtensionUnresolvedFiles: delta(
            now.missingExtensionUnresolvedFiles,
            before.missingExtensionUnresolvedFiles
          ),
          timestampReviewFiles: delta(now.timestampReviewFiles, before.timestampReviewFiles)
        };
      })
    },
    note: 'Signed deltas are descriptive indexed-evidence changes; they do not authorize maintenance or imply causation.'
  };
}

function segment(value, fallback) {
  const normalized = String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}

function displayExtension(value) {
  const extension = String(value || '').trim();
  return extension ? `.${extension}` : 'extensionless unresolved';
}

function priority(files, bytes) {
  if (files >= 500 || bytes >= 500 * MIB) return 'high';
  if (files >= 100 || bytes >= 100 * MIB) return 'medium';
  return 'review';
}

function score(files, bytes, typeWeight) {
  return Number(typeWeight || 0) + files * 100 + Math.ceil(bytes / MIB);
}

function workItem({
  root, type, key, title, rationale, files, bytes, typeWeight, evidenceDetails,
  disposition = 'review_metadata_or_classification_rule'
}) {
  const boundedFiles = Math.max(0, Number(files || 0));
  const boundedBytes = Math.max(0, Number(bytes || 0));
  return {
    id: `${segment(type)}:${segment(root)}:${segment(key)}`,
    type,
    root,
    title,
    priority: priority(boundedFiles, boundedBytes),
    evidence: {
      files: boundedFiles,
      bytes: boundedBytes,
      ...(evidenceDetails && typeof evidenceDetails === 'object' ? evidenceDetails : {})
    },
    rationale,
    disposition,
    filesystemMutationAllowed: false,
    _score: score(boundedFiles, boundedBytes, typeWeight)
  };
}

function uniqueCandidates(candidates) {
  const byId = new Map();
  for (const item of candidates.filter(candidate => candidate.evidence.files > 0)) {
    const existing = byId.get(item.id);
    if (
      !existing
      || item._score > existing._score
      || (item._score === existing._score && item.evidence.files > existing.evidence.files)
      || (
        item._score === existing._score
        && item.evidence.files === existing.evidence.files
        && item.evidence.bytes > existing.evidence.bytes
      )
    ) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

function publicCandidate(item) {
  return {
    id: item.id,
    type: item.type,
    root: item.root,
    title: item.title,
    priority: item.priority,
    evidence: {
      files: item.evidence.files,
      bytes: item.evidence.bytes
    },
    filesystemMutationAllowed: false
  };
}

function buildOrganizationStrategy(evidence) {
  const candidates = [];
  const duplicateCandidates = evidence?.duplicateCandidates || {};
  const backlogFiles = Math.max(0, Number(duplicateCandidates.filesToHash || 0));
  const backlogBytes = Math.max(0, Number(duplicateCandidates.bytesToHash || 0));
  if (Number(duplicateCandidates.groups || 0) > 0 && backlogFiles > 0) {
    candidates.push(workItem({
      root: 'portfolio',
      type: 'hash_coverage',
      key: 'same-size-candidates',
      title: 'Raise duplicate hash coverage (verification backlog)',
      rationale: 'Read-only SHA-256 hashing of not-current same-size candidate members converts bounded workload into proven duplicate evidence. An operator may review cadence or per-run limits; file content is never modified.',
      files: backlogFiles,
      bytes: backlogBytes,
      typeWeight: 4000,
      disposition: 'plan_read_only_candidate_hashing',
      evidenceDetails: {
        candidateGroups: Math.max(0, Number(duplicateCandidates.groups || 0)),
        bytesAreHashingWorkloadNotSavings: true,
        basis: 'not-current candidate members only'
      }
    }));
  }
  for (const root of evidence?.roots || []) {
    for (const row of (root.unclassifiedByExtension || []).slice(0, HOTSPOT_LIMIT)) {
      const label = displayExtension(row.extension);
      candidates.push(workItem({
        root: root.root,
        type: 'metadata_extension_rule',
        key: row.extension || 'no-extension',
        title: `Classify ${label} records`,
        rationale: `Review bounded samples and add a deterministic metadata rule for ${label}; never rename source files merely to create an extension.`,
        files: row.files,
        bytes: row.bytes,
        typeWeight: 3000
      }));
    }
    const hasMissingExtensionSplit = Array.isArray(root.contentKnownMissingByTopLevel)
      || Array.isArray(root.contentUnknownMissingByTopLevel);
    const contentUnknownRows = hasMissingExtensionSplit
      ? (root.contentUnknownMissingByTopLevel || [])
      : (root.unresolvedByTopLevel || []);
    for (const row of contentUnknownRows.slice(0, HOTSPOT_LIMIT)) {
      const area = row.topLevel || '(root)';
      candidates.push(workItem({
        root: root.root,
        type: 'missing_extension_content_unknown_area',
        key: area,
        title: `Investigate unknown content evidence in ${area}`,
        rationale: 'Inspect bounded names and content-signature evidence to improve metadata; content is not yet proven, extensionless-by-design records are excluded, and no extension or rename may be inferred.',
        files: row.files,
        bytes: row.bytes,
        typeWeight: 2500
      }));
    }
    for (const row of (root.contentKnownMissingByTopLevel || []).slice(0, HOTSPOT_LIMIT)) {
      const area = row.topLevel || '(root)';
      candidates.push(workItem({
        root: root.root,
        type: 'missing_extension_content_known_area',
        key: area,
        title: `Review intentional extensionless naming in ${area}`,
        rationale: 'Matched content-signature evidence already proves the content type. Review whether extensionless naming is intentional or needs a future human naming policy; do not recommend or perform a rename.',
        files: row.files,
        bytes: row.bytes,
        typeWeight: 2400
      }));
    }
    for (const row of (root.unclassifiedByTopLevel || []).slice(0, HOTSPOT_LIMIT)) {
      const area = row.topLevel || '(root)';
      candidates.push(workItem({
        root: root.root,
        type: 'unclassified_area',
        key: area,
        title: `Reduce unclassified metadata in ${area}`,
        rationale: 'Prioritize deterministic classification coverage for this indexed area without moving its files.',
        files: row.files,
        bytes: row.bytes,
        typeWeight: 2000
      }));
    }
    for (const row of (root.timestampByTopLevel || []).slice(0, HOTSPOT_LIMIT)) {
      const area = row.topLevel || '(root)';
      const repeated = row.dominantRepeatedTimestamp;
      const repeatedFiles = Number(repeated?.files || 0);
      const repeatedSummary = repeatedFiles > 1
        ? ` The dominant repeated value ${repeated.mtimeUtc || repeated.mtimeSeconds} appears on ${repeatedFiles.toLocaleString('en-US')} ${repeated.storageRole || 'classified'} files; it may be preserved tool/build or source metadata and must be reviewed before any normalization.`
        : '';
      candidates.push(workItem({
        root: root.root,
        type: 'timestamp_review_area',
        key: area,
        title: `Review suspect timestamps in ${area}`,
        rationale: `Determine whether legacy/future timestamps are preserved facts or metadata anomalies.${repeatedSummary} Age is never deletion evidence.`,
        files: row.files,
        bytes: row.bytes,
        typeWeight: 1000,
        evidenceDetails: repeatedFiles > 1
          ? { dominantRepeatedTimestamp: { ...repeated } }
          : null
      }));
    }
  }

  const unique = uniqueCandidates(candidates);
  // Identical aggregate evidence signatures can be correlated areas (for
  // example a mirrored backup). They are never duplicate proof; link them so
  // a human can review the relationship once instead of treating it as N facts.
  const signatureGroups = new Map();
  for (const item of unique) {
    if (item.evidence.files <= 0 || item.type === 'hash_coverage') continue;
    const signature = `${item.type}|${item.root}|${item.evidence.files}|${item.evidence.bytes}`;
    if (!signatureGroups.has(signature)) signatureGroups.set(signature, []);
    signatureGroups.get(signature).push(item.id);
  }
  const mirrorsById = new Map();
  for (const ids of signatureGroups.values()) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    for (const id of sorted) {
      mirrorsById.set(id, sorted.filter(other => other !== id));
    }
  }
  const candidateIndexRows = unique
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_CANDIDATE_ITEMS)
    .map(publicCandidate);
  // The verification backlog is the portfolio's limiting evidence, so present
  // it before metadata review volume whenever it exists. The remaining work is
  // still ranked deterministically by evidence score.
  const ordered = [
    ...unique.filter(item => item.type === 'hash_coverage')
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...unique.filter(item => item.type !== 'hash_coverage')
      .sort((a, b) => (b._score - a._score) || a.id.localeCompare(b.id))
  ]
    .slice(0, MAX_WORK_ITEMS)
    .map((item, index) => {
      const { _score, ...publicItem } = item;
      const likelyMirrorOf = mirrorsById.get(item.id) || null;
      return {
        rank: index + 1,
        ...publicItem,
        ...(likelyMirrorOf ? {
          likelyMirrorOf,
          likelyMirrorEvidenceOnly: true
        } : {})
      };
    });
  return {
    status: ordered.length ? 'ready' : 'no_indexed_hotspots',
    mode: 'non-destructive-work-plan',
    generatedFrom: 'indexed-metadata-hotspots',
    totalCandidateItems: unique.length,
    maxItems: MAX_WORK_ITEMS,
    workItems: ordered,
    candidateIndexVersion: CANDIDATE_INDEX_VERSION,
    candidateIndexMaxItems: MAX_CANDIDATE_ITEMS,
    candidateIndexComplete: unique.length <= MAX_CANDIDATE_ITEMS,
    candidateIndex: candidateIndexRows,
    note: 'Work items improve metadata and organization knowledge only; they do not authorize file mutation.'
  };
}

module.exports = {
  MAX_WORK_ITEMS,
  HOTSPOT_LIMIT,
  MAX_CANDIDATE_ITEMS,
  MAX_ORGANIZATION_CHANGES,
  compatibility,
  compareOrganization,
  buildComparison,
  buildOrganizationStrategy
};
