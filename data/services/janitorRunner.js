/**
 * janitorRunner.js — orchestrates a profile run.
 *
 * Lifecycle: load profile → guard concurrency → create run doc →
 *   scan (Scanner) → optional dedup (dedupScanner) → optional AI triage →
 *   build proposed_actions from policies → finalize run doc.
 *
 * Contract: scan + persist must succeed. Dedup and AI triage are best-effort
 * enrichments — neither failure causes the run to fail.
 *
 * Deviation from plan: Scanner is imported as a module object (`scannerMod`)
 * rather than destructured, so tests can rebind `scannerMod.Scanner` to a
 * failure class after the module loads.
 */
const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const scannerMod = require('./scanner');
const dedupScanner = require('./dedupScanner');
const janitorService = require('./janitorService');
const janitorApprovalEvidence = require('./janitorApprovalEvidence');
const janitorAI = require('./janitorAI');
const janitorProfiles = require('./janitorProfiles');
const janitorStrategy = require('./janitorStrategy');
const { log } = require('../utils/logger');

const COLLECTION = 'janitor_runs';
const AI_SAMPLE_SIZE = 50;
const PROFILE_APPLY_CONFIRMATION = 'DELETE_APPROVED_FILES';
const RESTORE_SOURCE_CONFIRMATION = 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE';
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
// Proposed actions stay inside the run document, where approval addresses them
// by index, so a run stores a bounded prefix: at most this many actions and
// this many serialized bytes, well under MongoDB's 16 MB document limit. The
// rest is counted in `proposed_actions_omitted` and only appears in a later
// run, once the duplicates of the stored actions have been removed.
const MAX_PROPOSED_ACTIONS = 2000;
const MAX_PROPOSED_ACTIONS_BYTES = 8 * 1024 * 1024;

// In-memory concurrency guard: profile ids currently running
const running = new Set();

function _reset() { running.clear(); }

async function _createRunDoc(db, profile) {
  const doc = {
    profile_id: profile._id,
    profile_name: profile.name,
    scan_id: null,
    started_at: new Date(),
    finished_at: null,
    status: 'running',
    counts: {},
    dedup_report_id: null,
    dedup_error: null,
    ai_triage: null,
    strategy_status: null,
    decisions_required: [],
    proposed_actions: [],
    proposed_actions_omitted: 0,
    error: null
  };
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

async function _patchRun(db, runId, patch) {
  await db.collection(COLLECTION).updateOne({ _id: runId }, { $set: patch });
}

async function _runScan(db, profile) {
  // Use scannerMod.Scanner (not destructured) so tests can rebind after module load.
  const scanner = new scannerMod.Scanner(db);
  const scanId = new ObjectId().toHexString();
  return new Promise((resolve, reject) => {
    scanner.once('done', (result) => resolve({ scanId, ...result }));
    scanner.run({
      roots: profile.roots,
      includeExt: profile.extensions?.include || [],
      excludeExt: profile.extensions?.exclude || [],
      computeHashes: profile.computeHashes !== false,
      hashMode: profile.hashMode || (profile.computeHashes !== false ? 'all' : 'none'),
      hashMaxFiles: profile.hashBudget?.maxFiles,
      hashMaxBytes: profile.hashBudget?.maxBytes,
      batchSize: 1000,
      scanId
    }).catch(reject);
  });
}

async function _runDedup(db, profile) {
  // dedupScanner.buildDedupReport takes a single rootPath; iterate roots and merge.
  const merged = {
    groups: [],
    summary: {
      total_duplicate_groups: 0,
      total_duplicate_files: 0,
      total_wasted_space: 0
    }
  };
  // Honor the profile's include filter on the dedup step too — otherwise a
  // profile scoped to e.g. .mp4 would still propose deletes across all
  // extensions under the root (silent scope widening for a destructive step).
  const includeExt = profile.extensions?.include || [];
  for (const root of profile.roots) {
    const report = await dedupScanner.buildDedupReport(db, { rootPath: root, extensions: includeExt });
    merged.groups.push(...report.groups);
    merged.summary.total_duplicate_groups += report.summary.total_duplicate_groups || 0;
    merged.summary.total_duplicate_files += report.summary.total_duplicate_files || 0;
    merged.summary.total_wasted_space += report.summary.total_wasted_space || 0;
  }
  const reportId = await dedupScanner.saveReport(db, {
    created_at: new Date(),
    status: 'complete',
    config: { roots: profile.roots, extensions: includeExt },
    summary: merged.summary,
    groups: merged.groups
  });
  return { reportId, merged };
}

function _buildProposedActions(profile, dedupMerged, sharedDrivePolicy) {
  // v1: only delete_duplicates is supported in runner-driven profile runs.
  // Other policies (remove_temp_files, remove_large_files) are accepted by
  // janitorProfiles.validate() for forward compatibility but produce no
  // actions here — they require the full scan _fileMap that buildSuggestions
  // expects, which the runner does not assemble. Use the disk janitor's
  // /janitor/suggest endpoint for those policies in v1.
  if (!profile.policies.includes('delete_duplicates') || !dedupMerged) {
    return { status: 'not_requested', decisions_required: [], actions: [] };
  }

  // There is intentionally no fallback survivor rule. Missing policy yields
  // zero executable profile actions and a visible decision request.
  const plan = janitorStrategy.buildDuplicatePlan(dedupMerged.groups, sharedDrivePolicy);
  return {
    status: plan.status,
    decisions_required: plan.decisions_required,
    actions: plan.proposals.map(proposal => ({
      ...proposal,
      // Profile approval operates on `pending`; strategy reports use the more
      // descriptive `pending_review` because they are not executable records.
      status: 'pending'
    }))
  };
}

function _boundProposedActions(actions) {
  let bytes = 0;
  let kept = 0;
  for (const action of actions) {
    if (kept >= MAX_PROPOSED_ACTIONS) break;
    bytes += Buffer.byteLength(JSON.stringify(action), 'utf8');
    if (bytes > MAX_PROPOSED_ACTIONS_BYTES) break;
    kept += 1;
  }
  return { actions: actions.slice(0, kept), omitted: actions.length - kept };
}

async function _runAiTriage(profile, runDoc, proposedActions, scanCounts) {
  const sample = proposedActions.slice(0, AI_SAMPLE_SIZE).map(a => ({
    policy: a.policy,
    files: (a.files || []).slice(0, 5),
    space_saved: a.space_saved
  }));
  const includedFiles = sample.reduce((n, a) => n + a.files.length, 0);
  const availableFiles = proposedActions.reduce((n, a) => n + (a.files || []).length, 0);
  const coverage = {
    scope: 'advisory_metadata_sample',
    actions: { included: sample.length, available: proposedActions.length },
    fileEntries: { included: includedFiles, available: availableFiles },
    complete: sample.length === proposedActions.length && includedFiles === availableFiles,
    selection: `First ${AI_SAMPLE_SIZE} proposed actions; first 5 file entries per action.`
  };
  try {
    const aiResult = await janitorAI.callAI('triage', {
      files: sample,
      coverage,
      stats: { ...scanCounts, total_proposed_actions: proposedActions.length }
    });
    return { verdict: aiResult.result, model: aiResult.model, duration_ms: aiResult.duration_ms, coverage, outcome: 'completed' };
  } catch (err) {
    return { error: err.message, coverage, outcome: 'failed' };
  }
}

async function _prepareRun(db, profileId) {
  const profile = await janitorProfiles.get(db, profileId);
  if (!profile) return { ok: false, notFound: true };

  const key = String(profile._id);
  if (running.has(key)) return { ok: false, alreadyRunning: true };
  running.add(key);

  try {
    const runDoc = await _createRunDoc(db, profile);
    return { ok: true, profile, key, runDoc };
  } catch (err) {
    running.delete(key);
    throw err;
  }
}

async function _executePreparedRun(db, prepared) {
  const { profile, key, runDoc } = prepared;
  try {
    // Step 1: scan
    let scanResult;
    try {
      scanResult = await _runScan(db, profile);
      await _patchRun(db, runDoc._id, { scan_id: scanResult.scanId, counts: scanResult.counts });
    } catch (err) {
      await _patchRun(db, runDoc._id, {
        status: 'failed',
        error: `scan: ${err.message}`,
        finished_at: new Date()
      });
      return { ok: false, run_id: runDoc._id, error: err.message };
    }

    // Step 2: dedup (best-effort — only when delete_duplicates policy is active)
    let dedupMerged = null;
    if (profile.policies && profile.policies.includes('delete_duplicates')) {
      try {
        const { reportId, merged } = await _runDedup(db, profile);
        dedupMerged = merged;
        await _patchRun(db, runDoc._id, { dedup_report_id: reportId });
      } catch (err) {
        await _patchRun(db, runDoc._id, { dedup_error: err.message });
        log(`[janitorRunner] Dedup failed for profile ${profile.name}: ${err.message}`, 'warn');
      }
    }

    // Step 3: build policy-gated proposed actions. The policy defaults to
    // incomplete, so a fresh installation fails closed instead of keep-oldest.
    const sharedDrivePolicy = await janitorStrategy.getPolicy(db);
    const actionPlan = _buildProposedActions(profile, dedupMerged, sharedDrivePolicy);
    const { actions: proposedActions, omitted: proposedActionsOmitted } = _boundProposedActions(actionPlan.actions);

    // Step 4: AI triage (best-effort)
    let aiTriage = null;
    if (profile.aiTriage === true) {
      aiTriage = await _runAiTriage(profile, runDoc, proposedActions, scanResult.counts);
    }

    // Step 5: finalize
    await _patchRun(db, runDoc._id, {
      status: 'complete',
      finished_at: new Date(),
      proposed_actions: proposedActions,
      proposed_actions_omitted: proposedActionsOmitted,
      strategy_status: actionPlan.status,
      decisions_required: actionPlan.decisions_required,
      strategy_policy: janitorStrategy.publicPolicy(sharedDrivePolicy),
      ai_triage: aiTriage
    });

    return { ok: true, run_id: runDoc._id };
  } catch (err) {
    log(`[janitorRunner] Unexpected error in profile ${key}: ${err.message}`, 'error');
    try {
      await _patchRun(db, runDoc._id, {
        status: 'failed',
        error: err.message,
        finished_at: new Date()
      });
    } catch (_) { /* swallow */ }
    return { ok: false, error: err.message, run_id: runDoc._id };
  } finally {
    running.delete(key);
  }
}

async function runProfile(db, profileId) {
  const prepared = await _prepareRun(db, profileId);
  if (!prepared.ok) return prepared;
  return _executePreparedRun(db, prepared);
}

async function startProfileRun(db, profileId) {
  const prepared = await _prepareRun(db, profileId);
  if (!prepared.ok) return prepared;

  setImmediate(() => {
    _executePreparedRun(db, prepared).catch(err => {
      log(`[janitorRunner] Background profile ${prepared.key} failed: ${err.message}`, 'error');
    });
  });
  return { ok: true, run_id: prepared.runDoc._id };
}

async function listRunsForProfile(db, profileId, { page = 1, limit = 20 } = {}) {
  if (!ObjectId.isValid(profileId)) return { runs: [], total: 0 };
  const filter = { profile_id: new ObjectId(profileId) };
  const skip = Math.max(0, (page - 1) * limit);
  const [total, runs] = await Promise.all([
    db.collection(COLLECTION).countDocuments(filter),
    db.collection(COLLECTION).find(filter).sort({ started_at: -1 }).skip(skip).limit(limit).toArray()
  ]);
  return { runs, total, page, limit };
}

async function getRun(db, runId) {
  if (!ObjectId.isValid(runId)) return null;
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(runId) });
}

function _previewTtlMs() {
  const configured = Number(process.env.JANITOR_PREVIEW_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PREVIEW_TTL_MS;
}

function isLiveExecutionEnabled() {
  return String(process.env.JANITOR_EXECUTION_ENABLED || '').toLowerCase() === 'true';
}

function _selectPreviewSurvivor(action, keepPath) {
  if (keepPath === undefined || keepPath === null || keepPath === '') {
    return { ok: true, action };
  }
  if (typeof keepPath !== 'string') {
    return { ok: false, badRequest: true, error: 'keep_path must be a duplicate member path' };
  }
  const members = [action?.keep, ...(action?.candidatesToRemove || [])]
    .filter(member => typeof member?.path === 'string' && member.path);
  if (members.length < 2 || new Set(members.map(member => member.path)).size !== members.length) {
    return { ok: false, badRequest: true, error: 'duplicate action members are incomplete' };
  }
  const keep = members.find(member => member.path === keepPath);
  if (!keep) {
    return { ok: false, badRequest: true, error: 'keep_path is not a member of this duplicate action' };
  }
  const remove = members.filter(member => member.path !== keepPath);
  return {
    ok: true,
    action: {
      ...action,
      keep: { ...keep },
      candidatesToRemove: remove.map(member => ({ ...member })),
      files: remove.map(member => member.path),
      reason: `Operator-selected survivor ${keepPath}; complete SHA-256 preview required`,
      survivorRule: 'operator_selected',
      execution_authorized: false,
      approval_preview: undefined
    }
  };
}

function _modified(result) {
  return Number(result?.modifiedCount || 0) === 1;
}

async function _recordPreview(db, run, actionIdx, action) {
  const evidence = await janitorApprovalEvidence.verifyDuplicateAction(action);
  if (!evidence.ok) return evidence;

  const targetDigest = janitorService.generateCleanupDigest(action.files);
  const token = janitorService.generateCleanupToken(action.files);
  const result = await janitorService.executeCleanup(action.files, token, true, {
    atomicPreflight: true,
    expectedTargets: evidence.targets,
    requiredEvidenceTargets: [evidence.survivor]
  });
  if (result.ok === false) {
    return { ok: false, error: result.error, result };
  }

  const now = new Date();
  const targetEvidence = new Map(evidence.targets.map(target => [target.file, target]));
  const restoreSource = {
    ...evidence.survivor,
    verified_at: evidence.verified_at
  };
  const preview = {
    id: crypto.randomUUID(),
    status: 'ready',
    target_digest: targetDigest,
    created_at: now,
    expires_at: new Date(now.getTime() + _previewTtlMs()),
    live_apply_available: isLiveExecutionEnabled(),
    duplicate_proof: evidence.proof,
    sha256: evidence.sha256,
    verified_at: evidence.verified_at,
    restore_source: restoreSource,
    targets: (result.deleted || []).map(target => ({
      file: target.file,
      real_path: target.real_path,
      size: target.size,
      mtime_ms: target.mtime_ms,
      sha256: targetEvidence.get(target.file)?.sha256
    })),
    summary: {
      total_files: result.total_files,
      eligible_files: result.deleted?.length || 0,
      affected_bytes: result.space_freed || 0
    }
  };
  preview.evidence_digest = janitorApprovalEvidence.generateEvidenceDigest({
    proof: preview.duplicate_proof,
    sha256: preview.sha256,
    verified_at: preview.verified_at,
    survivor: preview.restore_source,
    targets: preview.targets
  });
  const updatedAction = {
    ...action,
    approval_preview: preview,
    execution_authorized: false
  };
  const write = await db.collection(COLLECTION).updateOne(
    {
      _id: run._id,
      [`proposed_actions.${actionIdx}.status`]: 'pending'
    },
    { $set: { [`proposed_actions.${actionIdx}`]: updatedAction } }
  );
  if (!_modified(write)) {
    return { ok: false, error: 'action changed while preview was being recorded' };
  }

  return { ok: true, preview: true, action: updatedAction, result };
}

function _validateRecordedPreview(action, options) {
  if (typeof options.previewId !== 'string' || !options.previewId) {
    return { ok: false, badRequest: true, error: 'preview_id is required for live apply' };
  }
  if (options.applyConfirmation !== PROFILE_APPLY_CONFIRMATION) {
    return {
      ok: false,
      badRequest: true,
      error: `apply_confirm must equal ${PROFILE_APPLY_CONFIRMATION}`
    };
  }
  if (options.restoreConfirmation !== RESTORE_SOURCE_CONFIRMATION) {
    return {
      ok: false,
      badRequest: true,
      error: `restore_confirm must equal ${RESTORE_SOURCE_CONFIRMATION}`
    };
  }

  const preview = action.approval_preview;
  if (!preview || preview.status !== 'ready') {
    return { ok: false, error: 'a recorded dry-run preview is required before live apply' };
  }
  if (preview.id !== options.previewId) {
    return { ok: false, error: 'preview_id does not match the recorded preview' };
  }
  const expiresAt = new Date(preview.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, error: 'recorded preview expired; generate a new preview' };
  }
  const shape = janitorApprovalEvidence.validateDuplicateAction(action);
  if (!shape.ok) return shape;
  const targetDigest = janitorService.generateCleanupDigest(action.files);
  if (preview.target_digest !== targetDigest) {
    return { ok: false, error: 'action targets changed after preview; generate a new preview' };
  }
  if (!Array.isArray(preview.targets) || preview.targets.length !== action.files.length) {
    return { ok: false, error: 'recorded preview target snapshot is incomplete' };
  }
  const restoreSource = preview.restore_source;
  const verifiedAt = new Date(preview.verified_at).getTime();
  const restoreVerifiedAt = new Date(restoreSource?.verified_at).getTime();
  if (
    preview.duplicate_proof !== 'complete-sha256-all-members'
    || preview.sha256 !== shape.sha256
    || restoreSource?.file !== shape.survivorPath
    || restoreSource?.sha256 !== shape.sha256
    || typeof restoreSource?.real_path !== 'string'
    || !Number.isFinite(Number(restoreSource?.size))
    || restoreSource?.mtime_ms == null
    || !Number.isFinite(Number(restoreSource.mtime_ms))
    || !Number.isFinite(verifiedAt)
    || restoreVerifiedAt !== verifiedAt
  ) {
    return { ok: false, error: 'recorded preview restore-source proof is incomplete' };
  }
  const targetFiles = new Set();
  for (const target of preview.targets) {
    if (
      !shape.targetPaths.includes(target?.file)
      || targetFiles.has(target.file)
      || target.sha256 !== shape.sha256
      || typeof target.real_path !== 'string'
      || !Number.isFinite(Number(target.size))
      || target.mtime_ms == null
      || !Number.isFinite(Number(target.mtime_ms))
    ) {
      return { ok: false, error: 'recorded preview target proof is incomplete' };
    }
    targetFiles.add(target.file);
  }
  const evidenceDigest = janitorApprovalEvidence.generateEvidenceDigest({
    proof: preview.duplicate_proof,
    sha256: preview.sha256,
    verified_at: preview.verified_at,
    survivor: restoreSource,
    targets: preview.targets
  });
  if (preview.evidence_digest !== evidenceDigest) {
    return { ok: false, error: 'recorded preview evidence changed; generate a new preview' };
  }
  return { ok: true, preview, targetDigest, evidenceDigest };
}

async function _applyRecordedPreview(db, run, actionIdx, action, options) {
  const validation = _validateRecordedPreview(action, options);
  if (!validation.ok) return validation;
  if (!isLiveExecutionEnabled()) {
    return {
      ok: false,
      notCommissioned: true,
      error: 'live janitor maintenance is not commissioned; JANITOR_EXECUTION_ENABLED is not true'
    };
  }

  const { preview, targetDigest, evidenceDigest } = validation;
  const startedAt = new Date();
  const claim = await db.collection(COLLECTION).updateOne(
    {
      _id: run._id,
      [`proposed_actions.${actionIdx}.status`]: 'pending',
      [`proposed_actions.${actionIdx}.approval_preview.id`]: preview.id,
      [`proposed_actions.${actionIdx}.approval_preview.status`]: 'ready',
      [`proposed_actions.${actionIdx}.approval_preview.target_digest`]: targetDigest,
      [`proposed_actions.${actionIdx}.approval_preview.evidence_digest`]: evidenceDigest,
      [`proposed_actions.${actionIdx}.approval_preview.expires_at`]: { $gt: startedAt }
    },
    {
      $set: {
        [`proposed_actions.${actionIdx}.status`]: 'executing',
        [`proposed_actions.${actionIdx}.execution_authorized`]: true,
        [`proposed_actions.${actionIdx}.restore_source_confirmation`]: RESTORE_SOURCE_CONFIRMATION,
        [`proposed_actions.${actionIdx}.restore_source_confirmed_at`]: startedAt,
        [`proposed_actions.${actionIdx}.execution_started_at`]: startedAt
      }
    }
  );
  if (!_modified(claim)) {
    return { ok: false, error: 'action changed, expired, or was already claimed' };
  }

  const token = janitorService.generateCleanupToken(action.files);
  let result;
  try {
    result = await janitorService.executeCleanup(action.files, token, false, {
      atomicPreflight: true,
      expectedTargets: preview.targets,
      requiredEvidenceTargets: [preview.restore_source]
    });
  } catch (err) {
    result = {
      ok: false,
      error: err.message,
      deleted: [],
      skipped: [],
      failed: [{ file: null, reason: err.message }],
      space_freed: 0
    };
  }
  const deletedCount = result.deleted?.length || 0;
  const completed = result.ok !== false && deletedCount === action.files.length;
  const preflightRejected = result.preflight_failed === true && deletedCount === 0;
  const finishedAt = new Date();
  const newStatus = completed ? 'executed' : (preflightRejected ? 'pending' : 'execution_failed');
  const updatedAction = {
    ...action,
    status: newStatus,
    execution_authorized: completed,
    restore_source_confirmation: RESTORE_SOURCE_CONFIRMATION,
    restore_source_confirmed_at: startedAt,
    execution_started_at: startedAt,
    execution_finished_at: finishedAt,
    executed_at: completed ? finishedAt : null,
    approval_preview: {
      ...preview,
      status: completed || !preflightRejected ? 'consumed' : 'invalidated',
      consumed_at: completed || !preflightRejected ? finishedAt : null,
      invalidated_at: preflightRejected ? finishedAt : null
    },
    result: {
      deleted: result.deleted || [],
      skipped: result.skipped || [],
      failed: result.failed || [],
      space_freed: result.space_freed || 0,
      note: completed
        ? null
        : (preflightRejected
          ? 'No files deleted; a target or the restore source changed or failed preflight. Generate a new preview.'
          : 'Execution did not delete every approved target; review the recorded result before any follow-up.')
    }
  };

  const finalized = await db.collection(COLLECTION).updateOne(
    {
      _id: run._id,
      [`proposed_actions.${actionIdx}.status`]: 'executing',
      [`proposed_actions.${actionIdx}.approval_preview.id`]: preview.id
    },
    { $set: { [`proposed_actions.${actionIdx}`]: updatedAction } }
  );
  if (!_modified(finalized)) {
    return {
      ok: false,
      auditFailure: true,
      error: 'cleanup finished but its action result could not be recorded',
      result
    };
  }

  return { ok: true, action: updatedAction, result, executionFailed: !completed };
}

async function approveAction(db, runId, actionIdx, options = {}) {
  if (options.confirm !== true) {
    return { ok: false, badRequest: true, error: 'explicit confirmation required' };
  }
  if (!ObjectId.isValid(runId)) return { ok: false, notFound: true };
  if (typeof actionIdx !== 'number' || !Number.isInteger(actionIdx) || actionIdx < 0) {
    return { ok: false, error: 'invalid action index' };
  }
  const run = await db.collection(COLLECTION).findOne({ _id: new ObjectId(runId) });
  if (!run) return { ok: false, notFound: true };

  const action = run.proposed_actions?.[actionIdx];
  if (!action) return { ok: false, notFound: true };
  if (action.status !== 'pending') return { ok: false, error: `action is ${action.status}` };

  const dryRun = options.dryRun !== false;
  const selection = dryRun ? _selectPreviewSurvivor(action, options.keepPath) : { ok: true, action };
  if (!selection.ok) return selection;
  return dryRun
    ? _recordPreview(db, run, actionIdx, selection.action)
    : _applyRecordedPreview(db, run, actionIdx, action, options);
}

async function rejectAction(db, runId, actionIdx) {
  if (!ObjectId.isValid(runId)) return { ok: false, notFound: true };
  if (typeof actionIdx !== 'number' || !Number.isInteger(actionIdx) || actionIdx < 0) {
    return { ok: false, error: 'invalid action index' };
  }
  const run = await db.collection(COLLECTION).findOne({ _id: new ObjectId(runId) });
  if (!run) return { ok: false, notFound: true };

  const action = run.proposed_actions?.[actionIdx];
  if (!action) return { ok: false, notFound: true };
  if (action.status !== 'pending') return { ok: false, error: `action is ${action.status}` };

  const updatedAction = { ...action, status: 'rejected', rejected_at: new Date() };
  const write = await db.collection(COLLECTION).updateOne(
    { _id: run._id, [`proposed_actions.${actionIdx}.status`]: 'pending' },
    { $set: { [`proposed_actions.${actionIdx}`]: updatedAction } }
  );
  if (!_modified(write)) return { ok: false, error: 'action changed or was already claimed' };
  return { ok: true, action: updatedAction };
}

async function sweepStaleRuns(db) {
  const result = await db.collection(COLLECTION).updateMany(
    { status: 'running' },
    { $set: { status: 'stopped', finished_at: new Date() } }
  );
  if (result.modifiedCount > 0) {
    log(`[janitorRunner] Swept ${result.modifiedCount} stale running run(s)`);
  }
  return result.modifiedCount;
}

module.exports = {
  COLLECTION,
  AI_SAMPLE_SIZE,
  PROFILE_APPLY_CONFIRMATION,
  RESTORE_SOURCE_CONFIRMATION,
  DEFAULT_PREVIEW_TTL_MS,
  MAX_PROPOSED_ACTIONS,
  MAX_PROPOSED_ACTIONS_BYTES,
  isLiveExecutionEnabled,
  runProfile,
  startProfileRun,
  listRunsForProfile,
  getRun,
  approveAction,
  rejectAction,
  sweepStaleRuns,
  _reset
};
