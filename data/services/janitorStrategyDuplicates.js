/**
 * Verified-duplicate survivor selection and review proposals.
 */
const { decisionsRequired } = require('./janitorStrategyPolicy');
const { roles: pathRoles } = require('../utils/fileMetadataRoles');
const CACHE_SEGMENTS = /(?:^|[\\/])(?:library|packagecache|node_modules|\.venv|__pycache__|cache)(?:[\\/]|$)/i;

function fileContext(file) {
  const value = String(file?.path || '');
  return {
    backup: file?.storageRole === 'backup_copy' || pathRoles().BACKUP_DIR.test(value),
    generatedCache: file?.storageRole === 'generated_cache' || CACHE_SEGMENTS.test(value)
  };
}

function comparePath(a, b) {
  return String(a.path || '').localeCompare(String(b.path || ''), 'en', { sensitivity: 'base' });
}

function canonicalScore(file) {
  const context = fileContext(file);
  const normalized = String(file.path || '').replace(/\\/g, '/');
  return [
    context.backup ? 1 : 0,
    context.generatedCache ? 1 : 0,
    normalized.split('/').filter(Boolean).length,
    normalized.length,
    normalized.toLowerCase()
  ];
}

function compareScore(a, b) {
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx] < b[idx]) return -1;
    if (a[idx] > b[idx]) return 1;
  }
  return 0;
}

function selectSurvivor(files, rule) {
  const sorted = [...files];
  if (rule === 'newest') {
    sorted.sort((a, b) => (Number(b.mtime || 0) - Number(a.mtime || 0)) || comparePath(a, b));
  } else if (rule === 'oldest') {
    sorted.sort((a, b) => (Number(a.mtime || 0) - Number(b.mtime || 0)) || comparePath(a, b));
  } else {
    sorted.sort((a, b) => compareScore(canonicalScore(a), canonicalScore(b)) || comparePath(a, b));
  }
  return sorted[0] || null;
}

function buildDuplicatePlan(groups, policy) {
  const missing = decisionsRequired(policy);
  if (missing.length) {
    return {
      status: 'awaiting_policy',
      decisions_required: missing,
      proposals: [],
      omitted: { backupPolicy: 0, generatedCachePolicy: 0 }
    };
  }

  const proposals = [];
  const omitted = { backupPolicy: 0, generatedCachePolicy: 0 };
  for (const group of groups || []) {
    const members = (group.files || []).filter(file => file?.path);
    if (members.length < 2) continue;
    const contexts = members.map(fileContext);
    if (
      contexts.some(context => context.backup)
      && policy.backupRetention !== 'staging'
    ) {
      omitted.backupPolicy += 1;
      continue;
    }
    if (
      contexts.some(context => context.generatedCache)
      && policy.generatedCache === 'preserve'
    ) {
      omitted.generatedCachePolicy += 1;
      continue;
    }

    const keep = selectSurvivor(members, policy.duplicateSurvivor);
    const remove = members.filter(file => file.path !== keep.path).sort(comparePath);
    if (!remove.length) continue;
    const size = Number(group.size ?? group.file_size ?? 0);
    proposals.push({
      type: 'verified_duplicate_review',
      policy: 'delete_duplicates',
      sha256: group._id || group.hash,
      evidence: 'sha256-current-metadata',
      survivorRule: policy.duplicateSurvivor,
      keep: { path: keep.path, mtime: keep.mtime ?? null },
      candidatesToRemove: remove.map(file => ({ path: file.path, mtime: file.mtime ?? null })),
      files: remove.map(file => file.path),
      reason: `Current SHA-256 duplicate of ${keep.path}; survivor rule ${policy.duplicateSurvivor}`,
      space_saved: size * remove.length,
      approval_required: true,
      execution_authorized: false,
      status: 'pending_review',
      executed_at: null,
      result: null
    });
  }

  return { status: 'ready_for_review', decisions_required: [], proposals, omitted };
}

module.exports = {
  fileContext,
  selectSurvivor,
  buildDuplicatePlan
};
