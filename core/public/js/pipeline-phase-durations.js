(function () {
  'use strict';
  // Phase durations of the Coding Team performance view. Core projects them
  // (agentx.pipeline-attempt-phases/v1) from recorded values only; this view
  // renders them and never fills a missing phase from another value.
  const SCHEMA = 'agentx.pipeline-attempt-phases/v1';
  const CLOCKS = { core: 'Core clock', worker: 'Worker clock' };
  const SHORT = { before_claim: 'Before claim', worker: 'Worker', verification: 'Verification', decision: 'Decision' };
  const STATUS = {
    pending: 'pending',
    missing: 'unknown',
    inconsistent: 'clock mismatch',
    not_applicable: 'not applicable',
    not_instrumented: 'not instrumented',
  };
  const REASONS = {
    queue_entry_not_recorded: 'No recorded queue entry for this attempt',
    no_receipt: 'No worker receipt',
    not_recorded: 'The worker did not record this duration',
    receipt_source_semantics_unknown: 'The receipt source does not define this split',
    verification_duration_not_recorded: 'Verification ran without a recorded duration',
    decision_time_not_recorded: 'The decision time was not recorded',
    no_decision_yet: 'Waiting for a human decision',
    attempt_active: 'The attempt is still running',
    no_decision_expected: 'No human decision is expected for this ending',
    end_before_start: 'The recorded end precedes the recorded start',
    attempt_end_before_start: 'The attempt end precedes its start',
    worker_duration_exceeds_core_attempt: 'The worker duration exceeds the Core attempt window',
    verification_exceeds_worker_run: 'Verification exceeds the whole worker run',
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

  function duration(value) {
    if (value == null) return '--';
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '--';
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  }

  function coverageText(coverage = {}) {
    const total = count(coverage.total);
    const parts = [`${count(coverage.observed)}/${total} observed`];
    for (const key of ['pending', 'missing', 'inconsistent', 'not_applicable']) {
      if (count(coverage[key])) parts.push(`${count(coverage[key])} ${STATUS[key]}`);
    }
    return parts.join(' · ');
  }

  function phaseCard(phase) {
    const values = phase.durationMs || {};
    const observed = count(phase.coverage?.observed);
    const instrumented = phase.instrumented !== false;
    const headline = !instrumented ? 'Not measured' : (observed ? duration(values.p50) : 'Unknown');
    const spread = !instrumented
      ? 'No recorded source; shown empty rather than estimated.'
      : (observed ? `median · p95 ${duration(values.p95)} · range ${duration(values.min)}–${duration(values.max)}` : 'No observed attempt in this window');
    return `<article class="pipeline-phase" data-phase="${esc(phase.id)}" data-instrumented="${instrumented}">
      <header><span>${esc(phase.label || phase.id)}</span><em>${esc(CLOCKS[phase.clock] || 'Not instrumented')}</em></header>
      <strong>${esc(headline)}</strong>
      <small>${esc(spread)}</small>
      ${instrumented ? `<small class="pipeline-phase-coverage">${esc(coverageText(phase.coverage))}</small>` : ''}
      <p>${esc(phase.measures || '')} ${esc(phase.note || '')}</p>
    </article>`;
  }

  function summaryMarkup(performance) {
    const summary = performance?.phaseDurations;
    if (!summary || summary.schema !== SCHEMA || !Array.isArray(summary.phases)) {
      return '<p class="pipeline-phase-state" data-tone="unknown">Phase durations are unknown: this response carries no phase projection.</p>';
    }
    const total = count(summary.phases[0]?.coverage?.total);
    if (!total) return '<p class="pipeline-phase-state" data-tone="empty">No attempt in this window, so no phase duration to show.</p>';
    const inconsistent = count(summary.inconsistentAttempts);
    return `<div class="pipeline-phase-head">
        <strong>Where attempt time goes</strong>
        <span>${esc(`${total} attempt${total === 1 ? '' : 's'} · ${SCHEMA} · Core and worker clocks are never subtracted from each other`)}</span>
      </div>
      ${inconsistent ? `<p class="pipeline-phase-state" data-tone="inconsistent">${esc(`${inconsistent} attempt${inconsistent === 1 ? ' has' : 's have'} incoherent clocks; those phases are excluded, not corrected (worker tolerance ${duration(summary.clockToleranceMs)}).`)}</p>` : ''}
      <div class="pipeline-phase-grid">${summary.phases.map(phaseCard).join('')}</div>`;
  }

  function stateMarkup(tone, text) {
    return `<p class="pipeline-phase-state" data-tone="${esc(tone)}">${esc(text)}</p>`;
  }

  function attemptMarkup(attempt) {
    const phases = attempt?.phases;
    if (!phases || typeof phases !== 'object') return '<span class="pipeline-phase-chips"><span data-status="missing">Phases unknown</span></span>';
    const chips = Object.keys(SHORT).map((id) => {
      const phase = phases[id] || { status: 'missing' };
      if (phase.status === 'not_applicable') return '';
      const value = phase.status === 'observed' ? duration(phase.durationMs) : (STATUS[phase.status] || 'unknown');
      const title = phase.status === 'observed' ? '' : ` title="${esc(REASONS[phase.reason] || 'Not recorded')}"`;
      return `<span data-status="${esc(phase.status)}"${title}>${esc(SHORT[id])} <b>${esc(value)}</b></span>`;
    }).join('');
    return `<span class="pipeline-phase-chips">${chips}</span>`;
  }

  window.PipelinePhaseDurations = { summaryMarkup, stateMarkup, attemptMarkup };
})();
