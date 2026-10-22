(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../../shared/codeStepSummary'));
  else root.PipelineCodeSteps = factory(root.AgentXCodeStepSummary);
})(typeof window === 'undefined' ? globalThis : window, function (contract) {
  'use strict';

  const STATE = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed' };
  const OUTCOME = { passed: 'passed', failed: 'failed', unknown: 'unknown' };
  const SOURCE = { agent_workload: 'measured agent workload', speed_knee: 'measured speed knee', default: 'default sizing' };
  const defaultEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const defaultDuration = value => Number.isSafeInteger(value) ? `${value.toLocaleString()} ms` : 'duration unknown';

  function safe(value) {
    if (!value || !contract?.normalize) return null;
    try { return contract.normalize(value); } catch { return null; }
  }

  function render(value, { escapeHtml = defaultEscape, durationLabel = defaultDuration, compact = false } = {}) {
    if (value == null) return '';
    const summary = safe(value);
    if (!summary) return '<p class="pipeline-code-steps-invalid">Code-step summary unavailable; malformed evidence was not displayed.</p>';
    const counts = summary.counts;
    const facts = `${counts.passed}/${summary.steps.length} passed · ${counts.failed} failed · ${counts.running} running · ${counts.pending} pending`
      + ` · ${Math.round(summary.stepContext / 1024)}k-token steps (${SOURCE[summary.budgetSource]})`;
    const items = summary.steps.map((step, index) => {
      const tests = step.tests.length
        ? `<ul class="pipeline-code-step-tests">${step.tests.map(test => `<li><code>${escapeHtml(test.profile)}</code> · ${escapeHtml(OUTCOME[test.outcome])}${test.durationMs == null ? '' : ` · ${escapeHtml(durationLabel(test.durationMs))}`}</li>`).join('')}</ul>`
        : '<span class="pipeline-code-step-tests-empty">Focused tests not recorded</span>';
      const commit = step.commit ? `<code class="pipeline-code-step-commit" title="${escapeHtml(step.commit)}">${escapeHtml(step.commit.slice(0, 12))}</code>` : '<span class="pipeline-code-step-commit">No commit</span>';
      return `<li data-code-step="${escapeHtml(step.id)}" data-code-step-state="${escapeHtml(step.state)}">
        <div><span class="pipeline-code-step-index">${index + 1}</span><strong>${escapeHtml(step.title)}</strong><span class="pipeline-code-step-state">${escapeHtml(STATE[step.state])}</span></div>
        <div class="pipeline-code-step-evidence">${commit}${tests}</div>
      </li>`;
    }).join('');
    const body = `<p class="pipeline-code-steps-facts">${escapeHtml(facts)}</p><ol class="pipeline-code-steps-list">${items}</ol>`;
    return compact ? body : `<section class="pipeline-code-steps" aria-label="Runner-owned code steps"><h4>Runner-owned code steps</h4>${body}</section>`;
  }

  return { safe, render };
});
