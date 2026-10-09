/* Pipeline attempt dossier: repository paths, inference and attempt
   summaries for the task drawer. pipeline.js creates it with its shared
   state and helpers. */
(function () {
  'use strict';
  let escapeHtml, formatDate, costEvidencePresentation, localEnergyPresentation, formatStatus, attemptOutcome, metaRow, durationLabel;

  function repositoryPathList(paths) {
    const values = Array.isArray(paths) ? paths.filter((value) => typeof value === 'string' && value) : [];
    return values.length
      ? `<ul class="pipeline-drawer-paths">${values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`
      : '<span class="pipeline-subtle">Not declared</span>';
  }

  function inferenceSummary(progress) {
    const causes = {
      workload_reserved: 'the host is reserved by another workload',
      maintenance_active: 'host maintenance is active',
      inference_active: 'another inference holds the host',
      inference_residency_active: 'another active inference uses incompatible model settings',
      inference_recovery_required: 'a previous inference has an unknown terminal state',
      maintenance_recovery_required: 'maintenance requires recovery',
      workload_proof_invalid: 'the workload reservation is invalid or expired',
      workload_recovery_required: 'the reserved workload requires recovery',
      admission_conflict_unclassified: 'the admission conflict could not be classified safely',
      connection_unavailable: 'the connection failed before the request was sent',
      provider_temporarily_unavailable: 'the local provider is temporarily unavailable',
      provider_rejected: 'the provider rejected the request',
      stream_interrupted: 'the response stream was interrupted',
      stream_completion_unverified: 'the response did not complete with a verified release',
    };
    const cause = causes[progress.cause] || progress.cause || '';
    const states = { waiting: 'Waiting to retry inference', streaming: 'Receiving model response',
      completed: 'Model call completed', exhausted: 'Inference retry limit reached',
      failed: 'Inference failed', cancelled: 'Inference cancelled', recovery_required: 'Explicit recovery required' };
    return `${states[progress.state] || 'Inference in progress'}${cause ? `: ${cause}` : ''}${progress.attempts ? ` (call attempt ${progress.attempts}/6)` : ''}${progress.nextRetryAt ? ` · next try ${formatDate(progress.nextRetryAt)}` : ''}`;
  }

  function attemptHumanSummary(attempt, evidence) {
    const codes = new Set(Array.isArray(evidence.failureCodes) ? evidence.failureCodes : []);
    const verification = evidence.verification || {};
    const happened = [];
    const next = [];
    const attributionFailed = codes.has('attribution_request_count_mismatch')
      || codes.has('attribution_session_model_mismatch');

    if (codes.has('worker_process_failed')) {
      happened.push(evidence.inference ? inferenceSummary(evidence.inference)
        : 'The worker stopped with an execution error before post-run verification.');
      next.push('Inspect the execution cause. No task or tool replay was performed automatically.');
    }

    if (codes.has('independent_verification_failed')) {
      happened.push('The exact changed checkout failed its independent verification profile.');
      next.push('Correct only the failing verification or implementation evidence, deploy the guard, then rerun this task.');
    }
    if (codes.has('attribution_request_count_mismatch')) {
      happened.push('The server request count and the OpenClaw session call count did not agree.');
    }
    if (codes.has('attribution_session_model_mismatch')) {
      happened.push('The OpenClaw session model did not match the model requested for the attested run.');
    }
    if (codes.has('cost_evidence_unavailable')) {
      happened.push('The provider-spend receipt was unavailable; the dossier does not treat unknown cost as zero.');
    }
    if (attributionFailed) {
      next.push('Inspect the session receipt and model binding before accepting another result.');
    }
    if (codes.size > 0 && happened.length === 0) {
      happened.push('One or more mandatory guarded-dispatch gates failed; the machine codes and audit trail identify the exact controls.');
      next.push('Resolve the recorded gate failure, then rerun under the same reviewed scope.');
    }

    if (codes.size > 0) {
      return {
        stage: codes.has('worker_process_failed') ? 'Worker execution'
          : codes.has('independent_verification_failed') && attributionFailed
          ? 'Independent verification and attribution'
          : codes.has('independent_verification_failed')
            ? 'Independent verification'
            : attributionFailed
              ? 'Session attribution'
              : 'Guarded dispatch',
        happened: happened.join(' '),
        impact: 'The attempt is blocked and cannot become completion evidence or a PR candidate.',
        next: Array.from(new Set(next)).join(' '),
      };
    }
    if (verification.status === 'passed') {
      return {
        stage: 'Human review handoff',
        happened: 'The worker stopped and the exact changed checkout passed its independent verification profile.',
        impact: 'The result is a review candidate only; it has not been approved, merged, or deployed.',
        next: attempt.reviewedAt ? 'Follow the recorded human review outcome.' : 'A human reviewer must accept or reject the result.',
      };
    }
    return {
      stage: 'Worker attempt',
      happened: attempt.completedAt ? 'The attempt ended without complete verification evidence.' : 'The bounded worker attempt is still active.',
      impact: 'No completion or promotion may be inferred from this state.',
      next: 'Wait for a terminal guarded result or inspect the audit trail if progress stops.',
    };
  }

  function renderAttemptDossier(task) {
    const attempts = Array.isArray(task.automationAttempts) ? task.automationAttempts.slice().reverse() : [];
    if (!task.automation && attempts.length === 0) return '';
    const automation = task.automation || {};
    const cards = attempts.map((attempt) => {
      const evidence = attempt.evidence || {};
      const verification = evidence.verification || {};
      const changes = evidence.changes || {};
      const usage = evidence.usage || {};
      const cost = costEvidencePresentation(usage);
      const energy = localEnergyPresentation(usage.localEnergy);
      const failureCodes = Array.isArray(evidence.failureCodes) ? evidence.failureCodes : [];
      const humanSummary = attemptHumanSummary(attempt, evidence);
      const tests = verification.testsPassed == null && verification.testsFailed == null
        ? 'Unknown'
        : `${verification.testsPassed ?? '?'} passed · ${verification.testsFailed ?? '?'} failed`;
      const changed = changes.filesChanged == null && changes.bytesChanged == null
        ? 'Unknown'
        : `${changes.filesChanged ?? '?'} files · ${changes.bytesChanged == null ? '?' : Number(changes.bytesChanged).toLocaleString()} B`;
      return `
        <article class="pipeline-attempt-dossier" id="pipeline-attempt-${escapeHtml(attempt.attempt || 'unknown')}" tabindex="-1">
          <header>
            <strong>Attempt ${escapeHtml(attempt.attempt || '?')}</strong>
            <span class="pipeline-team-outcome">${escapeHtml(formatStatus(attemptOutcome(attempt)))}</span>
          </header>
          <dl class="pipeline-drawer-meta">
            ${metaRow('Worker', escapeHtml(attempt.assignee || 'unknown'))}
            ${metaRow('Lifecycle', escapeHtml(`${formatDate(attempt.acquiredAt)} → ${attempt.completedAt ? formatDate(attempt.completedAt) : 'active'}`))}
            ${metaRow('Review', escapeHtml(attempt.reviewedAt ? `${formatStatus(attempt.reviewOutcome)} · ${formatDate(attempt.reviewedAt)}` : formatStatus(attempt.reviewOutcome || 'pending')))}
            ${metaRow('Verification', escapeHtml(`${formatStatus(verification.status || 'unknown')} · ${durationLabel(verification.durationMs)}`))}
            ${metaRow('Tests', escapeHtml(tests))}
            ${metaRow('Change', escapeHtml(changed))}
            ${metaRow('Execution', escapeHtml(durationLabel(usage.durationMs)))}
            ${evidence.inference ? metaRow('Model call', escapeHtml(inferenceSummary(evidence.inference))) : ''}
            ${metaRow('Provider/session', `${escapeHtml(cost.amount)}<span class="pipeline-team-subtle">${escapeHtml(cost.detail)}</span>`)}
            ${metaRow('Local energy', `${escapeHtml(energy.energy)}<span class="pipeline-team-subtle">${escapeHtml(energy.detail)}</span>`)}
            ${metaRow('Electricity', escapeHtml(energy.cost))}
            ${metaRow('Step', escapeHtml(humanSummary.stage))}
            ${metaRow('What happened', escapeHtml(humanSummary.happened))}
            ${metaRow('Impact', escapeHtml(humanSummary.impact))}
            ${metaRow('Next action', escapeHtml(humanSummary.next))}
            ${failureCodes.length ? metaRow('Failure codes', failureCodes.map((code) => `<code>${escapeHtml(code)}</code>`).join(' ')) : ''}
          </dl>
        </article>`;
    }).join('');
    return `
      <section class="pipeline-drawer-section">
        <h3><i class="fas fa-magnifying-glass-chart" aria-hidden="true"></i> Operator attempt dossier <span class="pipeline-drawer-count">${attempts.length}</span></h3>
        <p class="pipeline-drawer-privacy">Prompts, inference transcripts, tool payloads, raw verifier output, secrets, hostnames, and absolute paths are intentionally not retained here.</p>
        <dl class="pipeline-drawer-meta">
          ${metaRow('Policy', escapeHtml(automation.policyRef || '--'))}
          ${metaRow('Profile', escapeHtml(automation.executionProfile || '--'))}
          ${metaRow('Editable scope', repositoryPathList(automation.scope))}
          ${metaRow('Authority sources', repositoryPathList(automation.sourceFiles))}
        </dl>
        ${cards || '<div class="pipeline-empty">No coding attempt recorded yet.</div>'}
      </section>`;
  }

  window.PipelineAttemptDossier = {
    create(deps) {
      ({ escapeHtml, formatDate, costEvidencePresentation, localEnergyPresentation, formatStatus, attemptOutcome, metaRow, durationLabel } = deps);
      return { inferenceSummary, renderAttemptDossier };
    }
  };
})();
