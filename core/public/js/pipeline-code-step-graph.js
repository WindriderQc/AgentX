(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../../shared/codeStepGraphSummary'));
  else root.PipelineCodeStepGraph = factory(root.AgentXCodeStepGraphSummary);
})(typeof window === 'undefined' ? globalThis : window, function (contract) {
  'use strict';

  const STATE = { pending: 'Pending', waiting: 'Waiting', running: 'Running', passed: 'Verified', failed: 'Failed',
    uncertain: 'Outcome uncertain', blocked: 'Blocked' };
  const ASSEMBLY = { pending: 'Pending', assembling: 'Assembling', verifying: 'Final verification', publishing: 'Publishing',
    published: 'Draft PR published', failed: 'Failed', blocked: 'Blocked' };
  const escDefault = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const durationDefault = value => Number.isSafeInteger(value) ? `${value.toLocaleString()} ms` : 'duration unknown';

  function safe(value) {
    if (!value || !contract?.normalize) return null;
    try { return contract.normalize(value); } catch { return null; }
  }
  function executor(value) { return `${value.label} (${value.id}) · ${value.harness}`; }
  function budget(value) {
    return `${value.workSeconds}s work · ${value.testSeconds}s tests · ${value.modelSeconds}s model · ${value.modelCalls} calls · ${value.ciSeconds}s CI`;
  }
  function summaryText(value) {
    const graph = safe(value);
    if (!graph) return null;
    const active = graph.activeSteps.length ? graph.activeSteps.join(', ') : 'none';
    return `${graph.steps.length} steps · ${graph.counts.passed} verified · ${graph.counts.running} running · `
      + `${graph.counts.waiting} waiting · ${graph.counts.uncertain} uncertain · active ${active}`;
  }

  function render(value, { escapeHtml = escDefault, durationLabel = durationDefault, compact = false } = {}) {
    if (value == null) return '';
    const graph = safe(value);
    if (!graph) return '<p class="pipeline-code-graph-invalid">Code-step graph unavailable; malformed evidence was not displayed.</p>';
    const items = graph.steps.map((step, index) => {
      const dependencies = step.dependsOn.length ? step.dependsOn.map(value => `<code>${escapeHtml(value)}</code>`).join(', ') : 'None';
      const tests = step.tests.length ? `<ul class="pipeline-code-step-tests">${step.tests.map(test =>
        `<li><code>${escapeHtml(test.profile)}</code> · ${escapeHtml(test.outcome)}${test.durationMs == null ? '' : ` · ${escapeHtml(durationLabel(test.durationMs))}`}</li>`).join('')}</ul>`
        : '<span class="pipeline-code-step-tests-empty">Focused tests not recorded</span>';
      const commit = step.commit ? `<code title="${escapeHtml(step.commit)}">${escapeHtml(step.commit.slice(0, 12))}</code>` : 'No verified commit';
      const adoption = step.adoption ? step.adoption.state === 'adopted'
        ? `Adopted as <code title="${escapeHtml(step.adoption.assemblyCommit)}">${escapeHtml(step.adoption.assemblyCommit.slice(0, 12))}</code>`
        : step.adoption.state === 'conflict' ? 'Assembly conflict recorded' : 'Awaiting adoption' : 'No adoption receipt';
      return `<li data-code-graph-step="${escapeHtml(step.id)}" data-code-graph-state="${escapeHtml(step.state)}">
        <div><span class="pipeline-code-step-index">${index + 1}</span><strong>${escapeHtml(step.title)}</strong><span class="pipeline-code-step-state">${escapeHtml(STATE[step.state])}</span></div>
        <dl class="pipeline-code-graph-meta">
          <div><dt>Dependencies</dt><dd>${dependencies}</dd></div>
          <div><dt>Executor</dt><dd>${step.executor ? escapeHtml(executor(step.executor)) : 'Not selected'} · attempt ${step.attempt}</dd></div>
          <div><dt>Commit</dt><dd>${commit}</dd></div>
          ${step.waitCode ? `<div><dt>Wait</dt><dd><code>${escapeHtml(step.waitCode)}</code></dd></div>` : ''}
          ${step.failureCode ? `<div><dt>Failure</dt><dd><code>${escapeHtml(step.failureCode)}</code></dd></div>` : ''}
          <div><dt>Assembly</dt><dd>${adoption}</dd></div>
        </dl>${tests}</li>`;
    }).join('');
    const assembly = graph.assembly;
    const publication = assembly.publication?.state === 'published'
      ? `<a href="${escapeHtml(assembly.publication.url)}" rel="noopener">Draft PR #${assembly.publication.prNumber}</a> · <code>${escapeHtml(assembly.publication.headCommit.slice(0, 12))}</code>`
      : escapeHtml(assembly.publication?.state || 'not started');
    const body = `<p class="pipeline-code-steps-facts">${escapeHtml(summaryText(graph))}</p>
      <p class="pipeline-code-graph-budget">Reserved: ${escapeHtml(budget(graph.budget.reserved))}<br>Spent: ${escapeHtml(budget(graph.budget.spent))}</p>
      <ol class="pipeline-code-steps-list pipeline-code-graph-list">${items}</ol>
      <section class="pipeline-code-graph-assembly" aria-label="Final assembly receipt"><h5>Final assembly</h5>
        <dl class="pipeline-code-graph-meta">
          <div><dt>State</dt><dd>${escapeHtml(ASSEMBLY[assembly.state])}</dd></div>
          <div><dt>Executor</dt><dd>${assembly.executor ? escapeHtml(executor(assembly.executor)) : 'Not selected'}</dd></div>
          <div><dt>Adoption</dt><dd>${assembly.adoptedSteps}/${graph.steps.length} steps</dd></div>
          <div><dt>Head</dt><dd>${assembly.headCommit ? `<code title="${escapeHtml(assembly.headCommit)}">${escapeHtml(assembly.headCommit.slice(0, 12))}</code>` : 'Not assembled'}</dd></div>
          <div><dt>Verification</dt><dd>${assembly.verification ? `<code>${escapeHtml(assembly.verification.profile)}</code> · ${escapeHtml(assembly.verification.outcome)}${assembly.verification.durationMs == null ? '' : ` · ${escapeHtml(durationLabel(assembly.verification.durationMs))}`}` : 'Not recorded'}</dd></div>
          <div><dt>Publication</dt><dd>${publication}</dd></div>
        </dl></section>`;
    return compact ? body : `<section class="pipeline-code-steps pipeline-code-graph" aria-label="Core-owned code-step graph"><h4>Core-owned code-step graph</h4>${body}</section>`;
  }

  return { safe, summaryText, render };
});
