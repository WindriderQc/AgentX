'use strict';

const policy = require('./policy');
const { MemoryReviewError, LIMITS } = policy;
const contentGuard = require('./contentGuard');
const dedupService = require('./dedupService');

module.exports = ({ getRunOrThrow, audit, configureAutomation, refreshRunReviewStatus, scoreFor, temporalFor, riskFor }) => async function submitCandidates(runId, candidatesInput, { promptVersion, model } = {}) {
  const run = await getRunOrThrow(runId);
  if (run.status !== 'synthesizing') {
    throw new MemoryReviewError(`run ${runId} is ${run.status}; candidates are only accepted while synthesizing`, {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }
  if (!Array.isArray(candidatesInput)) throw new MemoryReviewError('candidates must be an array');
  if (candidatesInput.length > LIMITS.MAX_CANDIDATES_PER_RUN) {
    throw new MemoryReviewError(`too many candidates (max ${LIMITS.MAX_CANDIDATES_PER_RUN})`);
  }

  const observationsById = new Map(run.observations.map((obs) => [obs.observationId, obs]));
  const knownIds = new Set(observationsById.keys());

  let accepted = 0;
  let suppressed = 0;
  const dropped = [];
  const validated = [];

  candidatesInput.forEach((raw, index) => {
    try {
      const clean = policy.validateCandidateInput(raw, index, knownIds);
      contentGuard.assertReviewSafe(`${clean.statement}\n${clean.rationale}`, `candidates[${index}]`);
      validated.push({ clean, index, candidateId: policy.candidateId(clean.type,
        clean.type === 'supersedes' ? `${clean.statement}\n${clean.supersedes.ref}` : clean.statement) });
    } catch (err) {
      dropped.push({ index, code: err.code || 'MEMORY_REVIEW_ERROR', message: contentGuard.redact(String(err.message)).slice(0, 200) });
      audit(run, 'candidate_dropped', { level: 'warn', detail: `index=${index} ${err.code || ''}` });
    }
  });
  const priorById = await dedupService.loadPriorCandidatesByIds(
    validated.map((item) => item.candidateId),
    run.runId
  ).catch(() => new Map());
  const candidateRag = await dedupService.searchCandidateDuplicates(
    validated.map(({ clean, candidateId }) => ({ statement: clean.statement, candidateId }))
  ).catch(() => ({ byId: new Map(), degraded: true, failures: 1, attempted: 1 }));
  if (candidateRag.degraded) {
    run.dedupContext.degraded = true;
    run.dedupContext.degradedReason = [
      run.dedupContext.degradedReason,
      `candidate RAG dedup incomplete (${candidateRag.failures}/${candidateRag.attempted})`,
    ].filter(Boolean).join('; ').slice(0, 400);
    audit(run, 'candidate_dedup_degraded', { level: 'warn', detail: run.dedupContext.degradedReason });
  }

  for (const item of validated.filter(item => item.clean.type === 'supersedes')) {
    try {
      const observed = dedupService.duplicateConflictsFor({ evidence: item.clean.evidenceRefs.map(observationId => ({ observationId })) }, run.dedupContext?.ragMatches);
      const known = [...observed, ...(candidateRag.byId.get(item.candidateId) || [])];
      if (!known.some(ref => ref.authority === 'local_memory' && ref.sourceRef === item.clean.supersedes.ref)) {
        throw new MemoryReviewError('The replacement reference was not found by Core in this run');
      }
      item.supersedes = await require('../memoryNoteService').personal().replacementSource(item.clean.supersedes.ref);
    } catch (error) {
      item.refused = true;
      dropped.push({ index: item.index, code: error.code || 'MEMORY_REVIEW_SUPERSESSION_INVALID',
        message: contentGuard.redact(String(error.message)).slice(0, 200) });
      audit(run, 'candidate_dropped', { level: 'warn', detail: `index=${item.index} supersession source unavailable` });
    }
  }
  validated.forEach(({ clean, candidateId, supersedes, refused }) => {
    if (refused) return;
    const evidence = clean.evidenceRefs.map((ref) => {
      const obs = observationsById.get(ref);
      return {
        observationId: ref,
        runtime: obs.runtime,
        host: obs.host,
        agentOrProfile: obs.agentOrProfile,
        project: obs.project,
        sessionId: obs.sessionId,
        eventId: obs.eventId,
        observedAt: obs.observedAt,
        trust: obs.trust,
        sourceRef: obs.sourceRef,
        contentHash: obs.contentHash,
        redactedExcerpt: contentGuard.redact(obs.text).slice(0, LIMITS.EXCERPT_MAX),
      };
    });
    const evidenceHashes = evidence.map((e) => e.contentHash);

    // Prior-disposition policy: a rejection stands until materially new
    // evidence appears; applied candidates are never re-proposed.
    const prior = priorById.get(candidateId);
    if (prior) {
      if (prior.status === 'rejected') {
        const priorHashes = new Set(prior.evidenceHashes || []);
        const hasNewEvidence = evidenceHashes.some((h) => !priorHashes.has(h));
        if (!hasNewEvidence) {
          suppressed += 1;
          audit(run, 'candidate_suppressed', { candidateId, detail: `previously rejected in ${prior.runId}, no new evidence` });
          return;
        }
        clean.conflicts.push({
          authority: 'prior_review',
          sourceRef: prior.runId,
          summary: 'previously rejected; re-proposed because materially new evidence exists',
        });
      } else if (prior.status === 'applied') {
        suppressed += 1;
        audit(run, 'candidate_suppressed', { candidateId, detail: `already applied in ${prior.runId}` });
        return;
      } else if (prior.status === 'deferred') {
        clean.conflicts.push({
          authority: 'prior_review',
          sourceRef: prior.runId,
          summary: 'deferred in a previous run; recurrence is accumulating',
        });
      }
    }

    const sessions = new Set();
    const runtimes = new Set();
    let observationCount = 0;
    for (const ref of clean.evidenceRefs) {
      const obs = observationsById.get(ref);
      observationCount += obs.recurrence?.observationCount || 1;
      (obs.recurrence?.sessions || []).forEach((s) => sessions.add(s));
      (obs.recurrence?.runtimes || []).forEach((r) => runtimes.add(r));
    }
    const recurrence = {
      observationCount,
      independentSessions: sessions.size,
      independentRuntimes: runtimes.size,
    };

    const conflicts = [
      ...clean.conflicts,
      ...dedupService.duplicateConflictsFor({ evidence }, run.dedupContext?.ragMatches),
      ...(candidateRag.byId.get(candidateId) || []),
    ].slice(0, 8);

    const existingIndex = run.candidates.findIndex((c) => c.candidateId === candidateId);
    const candidateDoc = {
      candidateId,
      type: clean.type,
      statement: clean.statement,
      rationale: clean.rationale,
      target: clean.target,
      evidence,
      recurrence,
      confidence: clean.confidence,
      score: 0,
      memoryKey: clean.memoryKey || `${clean.scope}:${clean.target.topic || clean.type}:${candidateId.slice(0, 12)}`,
      scope: clean.scope,
      sensitivity: clean.sensitivity,
      impact: clean.impact,
      stability: clean.stability,
      temporal: temporalFor(clean),
      conflicts,
      ...(supersedes && { supersedes }),
      risk: riskFor(clean),
      status: 'proposed',
      review: {}, apply: {},
    };
    candidateDoc.score = scoreFor(clean, recurrence);
    if (existingIndex >= 0) {
      const existing = run.candidates[existingIndex];
      if (existing.status !== 'proposed') return; // reviewed candidates are immutable to resubmission
      run.candidates[existingIndex] = candidateDoc; // idempotent upsert
    } else {
      run.candidates.push(candidateDoc);
    }
    accepted += 1;
  });

  if (promptVersion) run.promptVersion = String(promptVersion).slice(0, 80);
  if (model && typeof model === 'object') {
    run.model = {
      provider: String(model.provider || run.model.provider).slice(0, 64),
      model: String(model.model || run.model.model).slice(0, 128),
      temperature: Number(model.temperature) || 0,
    };
  }
  run.candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const automation = configureAutomation(run);
  run.candidateCounts = run.candidates.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {});
  const pending = run.candidates.filter((candidate) => ['proposed', 'deferred'].includes(candidate.status)).length;
  const autoReady = run.candidates.filter((candidate) => candidate.status === 'auto_approved').length;
  run.status = pending || autoReady ? 'ready_for_review' : 'completed';
  if (run.status === 'completed') run.completedAt = new Date();
  run.summary = {
    ...(run.summary || {}),
    modelCalled: true,
    candidateCount: run.candidates.length,
    automation: {
      policyVersion: policy.POLICY_VERSION,
      mode: automation.mode,
      safeWritesEnabled: automation.safeWritesEnabled,
      exceptionBudget: automation.exceptionBudget,
      ...automation.counts,
    },
  };
  audit(run, 'candidates_submitted', {
    detail: `accepted=${accepted} suppressed=${suppressed} dropped=${dropped.length} total=${run.candidates.length}`,
  });
  await run.save();
  const automationFailures = [];
  if (automation.safeWritesEnabled) {
    const applyService = require('./applyService'); // lazy: keep lifecycle/apply modules acyclic at load time
    const autoCandidates = run.candidates.filter((candidate) => candidate.status === 'auto_approved');
    for (const candidate of autoCandidates) {
      try {
        await applyService.applyCandidate(runId, candidate.candidateId, {
          by: policy.POLICY_VERSION,
          automation: true,
        });
      } catch (err) {
        automationFailures.push({
          candidateId: candidate.candidateId,
          code: err.code || 'MEMORY_REVIEW_AUTO_APPLY_FAILED',
          message: contentGuard.redact(String(err.message)).slice(0, 200),
        });
      }
    }
  }
  const finalized = await getRunOrThrow(runId);
  refreshRunReviewStatus(finalized);
  finalized.summary = {
    ...(finalized.summary || {}),
    automationFailures: automationFailures.length,
  };
  await finalized.save();
  return {
    runId,
    status: finalized.status,
    accepted,
    suppressed,
    dropped,
    total: finalized.candidates.length,
    automation: finalized.summary.automation,
    automationFailures,
  };
};
