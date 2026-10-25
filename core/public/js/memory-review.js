// Dreaming Review — confidence-tiered, policy-automatic, and intentionally calm.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    runs: [], insights: null, selectedRunId: null, run: null,
    filter: 'all', runFilter: 'all', runSearch: '', applyEnabled: false, safeAutomationEnabled: false,
    pendingAction: null, returnFocus: null, focusAfter: null,
  };
  const labels = {
    ready_for_review: 'Ready for review', partially_reviewed: 'Partially reviewed', completed: 'Complete',
    failed: 'Needs attention', collecting: 'Collecting', synthesizing: 'Reflecting',
    proposed: 'Pending', approved: 'Approved', auto_approved: 'Policy approved', rejected: 'Rejected', deferred: 'Deferred',
    parked: 'Parked', shadowed: 'Shadowed', applied: 'Applied', apply_failed: 'Apply failed', applying: 'Applying',
    supersedes: 'Replaces a fact', rolling_back: 'Restoring previous fact', rolled_back: 'Previous fact restored', rollback_failed: 'Rollback needs attention',
    shared_fact: 'Memory note', soft_memory: 'Working memory', artifact: 'Knowledge artifact', runtime_local: 'Runtime-local proposal',
    skill_draft: 'Skill draft', pipeline_task: 'Follow-up task', git_change: 'Source change', ignore: 'No action',
    agentx: 'AgentX', 'claude-code': 'Claude Code', codex: 'Codex', external: 'External',
  };
  const { trustHelp, targetHelp, actionCopy } = window.MemoryReviewCopy;

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* non-JSON error */ }
    if (!response.ok || payload.status === 'error') throw new Error(payload.message || `HTTP ${response.status}`);
    return payload.data !== undefined ? payload.data : payload;
  }

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function label(value) {
    return labels[value] || String(value || 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function shortDate(value) {
    if (!value) return 'Unknown time';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value).slice(0, 16) : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function friendlyRunTitle(run) {
    const date = new Date(run.completedAt || run.createdAt);
    if (Number.isNaN(date.valueOf())) return 'Dreaming review';
    const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${time} review`;
  }

  function relativeDate(value) {
    if (!value) return 'not seen yet';
    const delta = Date.now() - new Date(value).valueOf();
    if (!Number.isFinite(delta)) return shortDate(value);
    const minutes = Math.max(0, Math.round(delta / 60000));
    if (minutes < 2) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function evidenceWindow(windowValue) {
    const from = new Date(windowValue?.from);
    const to = new Date(windowValue?.to);
    const days = Math.round((to - from) / 86400000);
    if (Number.isFinite(days) && days > 0) return `${days}-day evidence window`;
    return `${shortDate(windowValue?.from)} → ${shortDate(windowValue?.to)}`;
  }

  function toast(message, type = 'info') {
    $('mrLiveStatus').textContent = message;
    if (window.AgentXUtils && typeof window.AgentXUtils.showToast === 'function') {
      window.AgentXUtils.showToast(message, type);
    }
  }

  async function copyText(text, success) {
    try {
      await navigator.clipboard.writeText(text);
      toast(success, 'success');
    } catch { toast('Could not copy to the clipboard.', 'error'); }
  }

  async function loadConfig() {
    try {
      const config = await apiJson('/api/memory-review/config');
      state.applyEnabled = !!config.applyEnabled;
      state.safeAutomationEnabled = !!config.safeAutomationEnabled;
      const badge = $('mrModeBadge');
      badge.textContent = config.safeAutomationEnabled
        ? `Safe automation · ${config.reviewExceptionBudget} exceptions max`
        : config.automationMode === 'shadow' ? 'Standing policy · shadow evaluation' : 'Manual compatibility mode';
      badge.classList.toggle('mr-mode-apply', config.mode === 'apply');
      return true;
    } catch (error) {
      $('mrModeBadge').textContent = 'Configuration unavailable';
      toast(`Dreaming configuration unavailable: ${error.message}`, 'error');
      return false;
    }
  }

  function renderOverview() {
    const insight = state.insights;
    if (!insight) {
      const latest = state.runs.find((run) => ['ready_for_review', 'partially_reviewed', 'completed'].includes(run.status)) || state.runs[0];
      const counts = state.runs.reduce((totals, run) => {
        const review = run.reviewCounts || {};
        totals.pending += (review.proposed || 0) + (review.deferred || 0);
        totals.applied += review.applied || 0;
        return totals;
      }, { pending: 0, applied: 0 });
      $('mrStatRuns').textContent = !latest ? 'Waiting' : counts.pending ? `${counts.pending} ready` : latest.summary?.noEligibleObservations ? 'Quiet' : label(latest.status);
      $('mrStatPending').textContent = counts.pending;
      $('mrStatApplied').textContent = counts.applied;
      const errors = latest?.collectorSummary?.errors || 0;
      const overdue = state.runs.filter((run) => run.reconciliation?.overdue).length;
      $('mrStatHealth').textContent = errors ? `${errors} issue${errors === 1 ? '' : 's'}` : overdue ? `${overdue} overdue` : latest ? 'Healthy' : 'Waiting';
      $('mrStatHealth').classList.toggle('mr-stat-warning', !!errors || !!overdue);
      $('mrStatHealth').title = errors ? 'Current collector errors' : overdue ? 'An unfinished cross-host reconciliation passed its recovery window' : 'Summary unavailable; derived from run history';
      return;
    }
    const latest = insight.latest;
    $('mrStatRuns').textContent = !latest ? 'Waiting' : latest.pending ? `${latest.pending} ready` : latest.quiet ? 'Quiet' : label(latest.status);
    $('mrStatPending').textContent = insight.totals.pending;
    $('mrStatApplied').textContent = insight.totals.applied;
    const healthLabel = insight.health.errors
      ? `${insight.health.errors} collector issue${insight.health.errors === 1 ? '' : 's'}`
      : insight.health.overdue
        ? `${insight.health.overdue} overdue`
        : insight.health.stale
          ? `${insight.health.stale} stale collector${insight.health.stale === 1 ? '' : 's'}`
          : insight.health.missing
            ? `${insight.health.missing} collector${insight.health.missing === 1 ? '' : 's'} not observed`
            : 'Healthy';
    $('mrStatHealth').textContent = !latest ? 'Waiting' : healthLabel;
    $('mrStatHealth').classList.toggle('mr-stat-warning', insight.health.state === 'attention');
    $('mrStatHealth').title = insight.health.errors ? 'Current collector errors'
      : insight.health.overdue ? 'An unfinished cross-host reconciliation passed its recovery window'
        : insight.health.stale ? `${insight.health.staleRuntimes.map(label).join(', ')} ${insight.health.stale === 1 ? 'has' : 'have'} not contributed within the freshness window`
        : insight.health.missing ? `${insight.health.missingRuntimes.map(label).join(', ')} ${insight.health.missing === 1 ? 'has' : 'have'} not supplied evidence in this window`
        : insight.health.advisories ? `${insight.health.advisories} non-blocking advisories` : 'No current collector errors';
  }

  function renderPulse() {
    const insight = state.insights;
    const pulse = $('mrPulse');
    if (!insight?.latest) {
      pulse.className = 'mr-pulse mr-pulse-quiet';
      $('mrPulseIcon').className = 'fas fa-moon';
      $('mrPulseTitle').textContent = 'The first dream is still ahead';
      $('mrPulseText').textContent = 'Scheduled collection will appear here without moving raw sessions off their hosts.';
      $('mrPulseFacts').innerHTML = '';
      return;
    }
    const { latest, totals, health } = insight;
    let tone = 'healthy';
    let icon = 'fa-wand-magic-sparkles';
    let title = 'The ecosystem is calm';
    let text = 'Recent evidence was reviewed safely and there is nothing requiring your attention.';
    if (health.errors) {
      tone = 'attention'; icon = 'fa-triangle-exclamation'; title = 'A collector needs attention';
      text = `${health.errors} current collector issue${health.errors === 1 ? '' : 's'} should be inspected before trusting coverage.`;
    } else if (health.overdue) {
      const missing = health.activeRun?.reconciliation?.missingRuntimes || [];
      tone = 'attention'; icon = 'fa-clock-rotate-left'; title = 'A Dreaming handoff is overdue';
      text = `${health.activeRun?.runId || 'The active run'} is safely holding accepted evidence${missing.length ? ` while waiting for ${missing.map(label).join(' and ')}` : ''}. The next reconciliation automatically recovers it.`;
    } else if (health.stale) {
      tone = 'attention'; icon = 'fa-clock'; title = `${health.stale} collector${health.stale === 1 ? '' : 's'} ${health.stale === 1 ? 'is' : 'are'} stale`;
      text = `${health.staleRuntimes.map(label).join(', ')} ${health.stale === 1 ? 'has' : 'have'} not supplied evidence within the expected freshness window.`;
    } else if (health.missing) {
      tone = 'attention'; icon = 'fa-circle-minus'; title = 'Collector coverage is incomplete';
      text = `${health.missingRuntimes.map(label).join(', ')} ${health.missing === 1 ? 'has' : 'have'} not supplied evidence, so quality metrics remain unknown.`;
    } else if (totals.pending) {
      tone = 'ready'; icon = 'fa-inbox'; title = `${totals.pending} memor${totals.pending === 1 ? 'y is' : 'ies are'} waiting for you`;
      text = 'Each proposal is evidence-backed and remains inert until you review it individually.';
    } else if (health.collecting) {
      tone = 'collecting'; icon = 'fa-satellite-dish'; title = 'Agents are gathering tonight’s signal';
      text = 'A partial host submission is open. The completed dream below remains the best current summary.';
    } else if (latest.quiet && state.collectingAlert) {
      // The same phenomenon must not read "healthy" here while Nerve Center
      // holds an active alert on it. The governance sweep is the authority on
      // whether the runtimes that must contribute actually did.
      const quiet = state.collectingAlert.context?.additionalData?.quietRuntimes || [];
      const names = quiet.map((entry) => label(entry.runtime || entry.evidenceClass || 'runtime')).filter(Boolean);
      tone = 'attention'; icon = 'fa-triangle-exclamation'; title = 'Quiet—and Nerve Center says that is not healthy';
      text = `An active "collecting nothing" alert reports that${names.length ? ` ${names.join(', ')}` : ' the expected runtimes'} produced no eligible evidence over the sweep window. A quiet run is healthy only when the collectors that must contribute did.`;
    } else if (latest.quiet && latest.overdueRun) {
      tone = 'attention'; icon = 'fa-clock'; title = 'Quiet—and the next dream is overdue';
      text = `The last run completed ${relativeDate(latest.lastRunAt)} and a new one was expected within ${durationLabel(latest.expectedWithinMs)}.`;
    } else if (latest.quiet) {
      tone = 'quiet'; icon = 'fa-moon'; title = 'Quiet night—nothing trustworthy new';
      text = 'Noise was filtered locally, no proposal was needed, and the review model was not called. No active collecting alert contradicts this.';
    } else if (latest.candidates) {
      title = `${latest.candidates} proposal${latest.candidates === 1 ? '' : 's'} processed safely`;
      text = 'The latest completed dream is fully reflected in the review history below.';
    }
    pulse.className = `mr-pulse mr-pulse-${tone}`;
    $('mrPulseIcon').className = `fas ${icon}`;
    $('mrPulseTitle').textContent = title;
    $('mrPulseText').textContent = text;
    $('mrPulseFacts').innerHTML = [
      `<span title="Last run"><i class="fas fa-clock"></i> ${esc(relativeDate(latest.completedAt || latest.createdAt))}</span>`,
      `<span title="Last completed run"><i class="fas fa-circle-check"></i> ${latest.lastSuccessfulRunAt ? `completed ${esc(relativeDate(latest.lastSuccessfulRunAt))}` : 'no completed run'}</span>`,
      `<span title="Last run in which a collector produced eligible evidence"><i class="fas fa-seedling"></i> ${latest.lastEligibleEvidenceAt ? `eligible evidence ${esc(relativeDate(latest.lastEligibleEvidenceAt))}` : 'no eligible evidence in this window'}</span>`,
      `<span title="Expected cadence"><i class="fas fa-calendar-check"></i> ${latest.nextDueAt ? `${latest.overdueRun ? 'was due' : 'next due'} ${esc(relativeDate(latest.nextDueAt))} (every ${esc(durationLabel(latest.expectedWithinMs))})` : 'cadence not observed'}</span>`,
      state.collectingAlert
        ? `<span class="mr-fact-alert" title="Active Nerve Center alert"><i class="fas fa-bell"></i> <a href="/nerve-center#alerts">collecting-nothing alert active</a> since ${esc(relativeDate(state.collectingAlert.firstOccurrence || state.collectingAlert.createdAt))}</span>`
        : '<span title="No active Nerve Center alert on this signal"><i class="fas fa-bell-slash"></i> no collecting alert</span>',
      `<span><i class="fas fa-filter"></i> ${totals.filteredObservations} filtered</span>`,
      `<span><i class="fas fa-leaf"></i> ${totals.modelSkips} review-model call${totals.modelSkips === 1 ? '' : 's'} avoided</span>`,
      health.advisories ? `<span title="Non-blocking schema or identity drift"><i class="fas fa-circle-info"></i> ${health.advisories} ${health.advisories === 1 ? 'advisory' : 'advisories'}</span>` : '<span><i class="fas fa-shield"></i> No semantic automation</span>',
    ].join('');
  }

  function metric(metricEvidence, name, detail, { suffix = '', historicalValue = null } = {}) {
    const evidence = metricEvidence || {};
    const current = evidence.state === 'current' && evidence.value != null;
    const value = current ? `${evidence.value}${suffix}` : '—';
    const state = evidence.state || 'unavailable';
    let evidenceDetail = detail;
    if (!current) {
      const lastValue = evidence.lastValue == null ? historicalValue : evidence.lastValue;
      const measured = lastValue == null ? '' : ` Historical result: ${lastValue}${suffix}.`;
      const lastSeen = evidence.observedAt ? ` Last evidence ${relativeDate(evidence.observedAt)}.` : '';
      const reasons = {
        stale: 'Collector coverage is stale.',
        partial: 'Collector coverage is incomplete.',
        attention: 'Collector or reconciliation evidence needs attention.',
        insufficient: 'No measured denominator is available.',
        unavailable: 'Evidence is unavailable.',
      };
      evidenceDetail = `${reasons[state] || reasons.unavailable}${lastSeen}${measured}`;
    }
    return `<div class="mr-quality-metric mr-metric-${esc(state)}"><strong>${esc(value)}</strong><span>${esc(name)}</span><small>${esc(evidenceDetail)}</small></div>`;
  }

  function distributionBars(values, emptyText) {
    const entries = Object.entries(values || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!entries.length) return `<div class="mr-mini-empty">${esc(emptyText)}</div>`;
    const max = entries[0][1];
    return entries.map(([name, count]) => `<div class="mr-atlas-row"><span>${esc(label(name))}</span><i><i style="width:${Math.max(8, Math.round(count / max * 100))}%"></i></i><b>${count}</b></div>`).join('');
  }

  function renderInsights() {
    const insight = state.insights;
    if (!insight) return;
    $('mrInsightsState').hidden = true;
    $('mrInsightsGrid').hidden = false;
    $('mrRuntimeGrid').innerHTML = insight.runtimes.map((runtime) => `<div class="mr-runtime-tile mr-runtime-${esc(runtime.health)}">
      <div><i class="fas ${runtime.health === 'attention' ? 'fa-triangle-exclamation' : runtime.health === 'stale' ? 'fa-clock' : runtime.health === 'not_seen' ? 'fa-circle-minus' : 'fa-circle-check'}"></i><strong>${esc(label(runtime.runtime))}</strong></div>
      <span>${runtime.eligible} ${runtime.eligible === 1 ? 'signal' : 'signals'} · ${runtime.filtered} filtered</span>
      <small>${runtime.lastSeen ? `Seen ${esc(relativeDate(runtime.lastSeen))}` : runtime.expected === false ? 'Not collected on this instance' : 'No recent contribution'}${runtime.currentAdvisories ? ` · ${runtime.currentAdvisories} ${runtime.currentAdvisories === 1 ? 'advisory' : 'advisories'}` : ''}</small>
    </div>`).join('');
    const metrics = insight.quality.metrics || {};
    $('mrQualityGrid').innerHTML = [
      metric(metrics.filterRate, 'Noise filtered', `${insight.totals.filteredObservations} of ${metrics.filterRate?.denominator || 0} observations stopped before synthesis`, { suffix: '%', historicalValue: insight.quality.filterRate }),
      metric(metrics.approvalPrecision, 'Approval precision', `${metrics.approvalPrecision?.denominator || 0} approve/reject decisions measured`, { suffix: '%', historicalValue: insight.quality.approvalPrecision }),
      metric(metrics.modelSkips, 'Review-model calls saved', 'Empty evidence windows stay deterministic', { historicalValue: insight.totals.modelSkips }),
      metric(metrics.crossRuntime, 'Cross-agent consensus', 'Candidates confirmed by multiple runtimes', { historicalValue: insight.quality.crossRuntime }),
      metric(metrics.conflicts, 'Conflicts surfaced', 'Never resolved silently', { historicalValue: insight.quality.conflicts }),
      metric(metrics.riskFlags, 'Risk flags', 'Privacy, governance, staleness, or injection', { historicalValue: insight.quality.riskFlags }),
    ].join('');
    $('mrAtlas').innerHTML = `<div><h4>Candidate types</h4>${distributionBars(insight.distributions.candidateTypes, 'The atlas will grow with the first trustworthy proposal.')}</div>
      <div><h4>Destinations</h4>${distributionBars(insight.distributions.targets, 'No semantic destination has been proposed yet.')}</div>`;
  }

  function durationLabel(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return 'an unknown interval';
    const hours = Math.round(value / 3600000);
    if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  /**
   * Cross-check with Nerve Center: an active alert on
   * `memory_review_no_eligible_evidence` is the governance sweep's verdict
   * that a quiet loop is not healthy. Read-only; an unavailable alert feed
   * leaves the verdict unknown rather than assumed absent.
   */
  async function loadCollectingAlert() {
    try {
      const data = await apiJson('/api/alerts?status=active&limit=100');
      const rows = Array.isArray(data) ? data : (data?.alerts || data?.items || []);
      return rows.find((alert) => alert?.context?.metric === 'memory_review_no_eligible_evidence') || null;
    } catch {
      return null;
    }
  }

  async function loadInsights() {
    try {
      [state.insights, state.collectingAlert] = await Promise.all([
        apiJson('/api/memory-review/insights?limit=30'),
        loadCollectingAlert(),
      ]);
      renderOverview(); renderPulse(); renderInsights();
      return true;
    } catch (error) {
      $('mrInsightsState').hidden = false;
      $('mrInsightsState').textContent = `Insight summary unavailable: ${error.message}`;
      $('mrPulse').className = 'mr-pulse mr-pulse-attention';
      $('mrPulseIcon').className = 'fas fa-triangle-exclamation';
      $('mrPulseTitle').textContent = 'Run history is still available';
      $('mrPulseText').textContent = 'The optional aggregate summary could not load. Candidate review remains unaffected.';
      renderOverview();
      return false;
    }
  }

  function visibleRuns() {
    const search = state.runSearch.toLowerCase();
    return state.runs.filter((run) => {
      if (search && !`${run.runId} ${(run.collectorSummary?.runtimes || []).join(' ')}`.toLowerCase().includes(search)) return false;
      if (state.runFilter === 'attention') return run.status === 'failed' || (run.collectorSummary?.errors || 0) > 0 || run.reconciliation?.overdue;
      if (state.runFilter === 'active') return ['collecting', 'synthesizing'].includes(run.status);
      if (state.runFilter === 'completed') return run.status === 'completed';
      return true;
    });
  }

  function renderRuns() {
    const list = $('mrRunList');
    const visible = visibleRuns();
    $('mrRunsMeta').textContent = `${visible.length} of ${state.runs.length}`;
    if (!visible.length) {
      list.innerHTML = '<li class="mr-mini-empty">No runs match this view.</li>';
      return;
    }
    list.innerHTML = visible.map((run) => {
      const review = run.reviewCounts || {};
      const pending = (review.proposed || 0) + (review.deferred || 0);
      const runtimes = run.collectorSummary?.runtimes || [];
      const hasError = run.status === 'failed' || (run.collectorSummary?.errors || 0) > 0;
      const quiet = run.summary?.noEligibleObservations;
      const total = Object.values(review).reduce((sum, count) => sum + (Number(count) || 0), 0);
      const active = ['collecting', 'synthesizing'].includes(run.status);
      const overdue = !!run.reconciliation?.overdue;
      const toWrite = (review.approved || 0) + (review.apply_failed || 0);
      const outcome = toWrite ? `<b class="mr-run-towrite">${toWrite}</b> accepted, not written${pending ? ` · <b>${pending}</b> awaiting` : ''}`
        : pending ? `<b>${pending}</b> awaiting review`
        : overdue ? 'Handoff overdue'
          : active ? 'Collection in progress'
          : quiet ? 'Quiet · no reviewer call'
            : total ? 'Review complete' : 'No review candidates';
      const selected = run.runId === state.selectedRunId;
      return `<li><button type="button" class="mr-run-item ${selected ? 'active' : ''}" ${selected ? 'aria-current="true"' : ''} data-run-id="${esc(run.runId)}">
        <span class="mr-run-title">${esc(friendlyRunTitle(run))}</span><span class="mr-chip mr-status-${esc(hasError || overdue ? 'failed' : run.status)}">${esc(label(hasError || overdue ? 'failed' : run.status))}</span>
        <small class="mr-run-id" title="${esc(run.runId)}">${esc(run.runId)}</small>
        <span class="mr-run-foot"><span>${outcome}</span><span>${esc(runtimes.map(label).join(' · ') || 'No collectors')}</span></span>
      </button></li>`;
    }).join('');
    list.querySelectorAll('[data-run-id]').forEach((button) => button.addEventListener('click', () => selectRun(button.dataset.runId)));
  }

  async function loadRuns({ select = true } = {}) {
    const message = $('mrRunsState');
    message.hidden = false;
    message.textContent = 'Loading dreams…';
    $('mrRunList').hidden = true;
    try {
      const data = await apiJson('/api/memory-review/runs?limit=30');
      state.runs = data.runs || [];
      renderOverview();
      if (!state.runs.length) {
        message.innerHTML = '<strong>No dreams yet.</strong><br>The first scheduled reconciliation will appear here.';
        return true;
      }
      renderRuns();
      $('mrRunList').hidden = false;
      message.hidden = true;
      if (select) {
        const requested = new URLSearchParams(window.location.search).get('run');
        // A linked run may be older than the 30 listed; it still loads by id.
        const target = requested
          || state.selectedRunId
          // A run holding accepted candidates that are not written yet comes
          // before a newer run that only has proposals: its owner already
          // decided, and that decision is what waits.
          || state.runs.find(acceptedNotWritten)?.runId
          || state.runs.find((run) => run.status === 'ready_for_review' || run.status === 'partially_reviewed')?.runId
          || state.runs.find((run) => run.status === 'completed')?.runId
          || state.runs[0].runId;
        await selectRun(target);
      }
      return true;
    } catch (error) {
      message.textContent = `Could not load Dreaming runs: ${error.message}`;
      toast(message.textContent, 'error');
      return false;
    }
  }

  const acceptedNotWritten = (run) => ((run.reviewCounts?.approved || 0) + (run.reviewCounts?.apply_failed || 0)) > 0;

  async function selectRun(runId) {
    // Drop the previous run first: its Authorize button and link must not
    // stay usable while another run is selected.
    state.selectedRunId = runId;
    state.run = null;
    ['mrRunNarrative', 'mrRunFacts', 'mrCollectors', 'mrAuditList'].forEach((id) => { $(id).innerHTML = ''; });
    $('mrRunTitle').textContent = 'Loading…';
    $('mrCandidateFilters').hidden = true;
    $('mrDetailEmpty').hidden = true;
    $('mrDetail').hidden = false;
    $('mrCandidatesState').hidden = false;
    $('mrCandidatesState').textContent = 'Loading this dream…';
    $('mrCandidateList').innerHTML = '';
    renderRuns();
    try {
      const run = await apiJson(`/api/memory-review/runs/${encodeURIComponent(runId)}`);
      if (state.selectedRunId !== runId) return; // a later click won
      state.run = run;
      const url = new URL(window.location.href);
      url.searchParams.set('run', runId);
      window.history.replaceState({}, '', url);
      renderRun();
      if (state.focusAfter) {
        document.querySelector(`[data-candidate-id="${CSS.escape(state.focusAfter)}"]`)?.focus();
        state.focusAfter = null;
      }
    } catch (error) {
      if (state.selectedRunId !== runId) return;
      $('mrRunTitle').textContent = 'Run unavailable';
      $('mrCandidatesState').textContent = `Could not load this run: ${error.message}`;
      toast($('mrCandidatesState').textContent, 'error');
    }
  }

  function runNarrative(run) {
    const collectors = run.collectors || [];
    const eligible = collectors.reduce((sum, item) => sum + (item.eligibleObservations || 0), 0);
    const filtered = collectors.reduce((sum, item) => sum + (item.rejectedObservations || 0), 0);
    const currentCoverageNeedsAttention = Boolean(
      state.collectingAlert
      || state.insights?.health?.errors
      || state.insights?.health?.overdue
      || state.insights?.health?.stale
      || state.insights?.health?.missing
    );
    if (['collecting', 'synthesizing'].includes(run.status)) {
      const missing = run.reconciliation?.missingRuntimes || ['agentx', 'claude-code', 'codex', 'external'].filter((runtime) => !collectors.some((item) => item.runtime === runtime));
      if (run.reconciliation?.overdue) {
        return `<i class="fas fa-clock-rotate-left"></i><div><strong>Reconciliation handoff overdue</strong><span>Accepted evidence is preserved safely${missing.length ? ` while waiting for ${missing.map(label).join(' and ')}` : ''}. The next reconciliation run will recover this automatically; no memory change can occur meanwhile.</span></div>`;
      }
      const reflecting = run.status === 'synthesizing';
      return `<i class="fas ${reflecting ? 'fa-wand-magic-sparkles' : 'fa-satellite-dish'}"></i><div><strong>${reflecting ? 'Review in progress' : 'Collection in progress'}</strong><span>${reflecting ? 'Sanitized evidence is being turned into bounded proposals.' : missing.length ? `Waiting for ${missing.map(label).join(' and ')}.` : 'All contributors have checked in; finalization is next.'} The most recent completed run remains selected by default.</span></div>`;
    }
    if (run.status === 'failed') return `<i class="fas fa-triangle-exclamation"></i><div><strong>This dream needs attention</strong><span>Accepted observations are preserved and the failure is retryable. No apply path is available.</span></div>`;
    if (!(run.candidates || []).length) return `<i class="fas ${currentCoverageNeedsAttention ? 'fa-triangle-exclamation' : 'fa-moon'}"></i><div><strong>${currentCoverageNeedsAttention ? 'Quiet run; current collector coverage needs attention' : 'Quiet, healthy reconciliation'}</strong><span>${filtered} noisy or ineligible item${filtered === 1 ? '' : 's'} filtered; ${eligible ? `${eligible} eligible observation${eligible === 1 ? '' : 's'} produced no durable proposal.` : 'the review model was not needed.'}${currentCoverageNeedsAttention ? ' This historical run does not override the current coverage warning above.' : ''}</span></div>`;
    const auto = (run.candidates || []).filter((item) => item.apply?.automated && item.status === 'applied').length;
    const exceptions = (run.candidates || []).filter((item) => ['proposed', 'deferred', 'apply_failed'].includes(item.status)).length;
    return `<i class="fas fa-wand-magic-sparkles"></i><div><strong>${auto} automatic update${auto === 1 ? '' : 's'} · ${exceptions} exception${exceptions === 1 ? '' : 's'}</strong><span>Safe reversible context flows automatically; only exceptions ask for judgment.</span></div>`;
  }

  function renderRun() {
    const run = state.run;
    const model = run.model || {};
    const hasApproved = (run.candidates || []).some((candidate) => ['approved', 'apply_failed'].includes(candidate.status));
    $('mrRunTitle').textContent = friendlyRunTitle(run);
    $('mrRunNarrative').innerHTML = runNarrative(run);
    $('mrRunFacts').innerHTML = [
      `<span class="mr-chip mr-status-${esc(run.status)}">${esc(label(run.status))}</span>`,
      `<span class="mr-chip">${run.mode === 'apply' ? 'Human-authorized apply' : 'Proposal-only run'}</span>`,
      run.summary?.automation ? `<span class="mr-chip">Policy ${esc(run.summary.automation.mode)} · budget ${esc(run.summary.automation.exceptionBudget)}</span>` : '',
      `<span title="${esc(shortDate(run.window?.from))} → ${esc(shortDate(run.window?.to))}"><i class="fas fa-calendar"></i> ${esc(evidenceWindow(run.window))}</span>`,
      `<span class="mr-run-id" title="Technical run id"><i class="fas fa-fingerprint"></i> ${esc(run.runId)}</span>`,
      `<span><i class="fas fa-microchip"></i> ${run.summary?.modelCalled ? `Review model · ${esc(model.model || 'model recorded')}` : run.status === 'synthesizing' ? 'Review model reflecting' : run.status === 'collecting' ? 'Review model pending' : 'Review model not called'}</span>`,
      run.dedupContext?.degraded ? '<span class="mr-chip mr-warn">Duplicate search degraded</span>' : '',
      run.failure?.stage ? `<span class="mr-chip mr-warn">Failed at ${esc(label(run.failure.stage))}</span>` : '',
      state.applyEnabled && run.mode !== 'apply' && hasApproved ? '<button type="button" class="mr-btn mr-btn-apply" id="mrAuthorizeApply"><i class="fas fa-key"></i> Authorize reviewed writes</button>' : '',
    ].filter(Boolean).join(' ');
    $('mrAuthorizeApply')?.addEventListener('click', (event) => openAction('authorize', null, event.currentTarget));
    $('mrCollectors').innerHTML = (run.collectors || []).map(renderCollector).join('') || '<div class="mr-collector">No collector reports.</div>';
    renderProgress(); renderNext();
    updateFilterCounts(); renderCandidates(); renderAudit();
  }

  // What the owner still has to do in this run, counted once for the progress
  // bar, the next-step bar and the candidate order.
  function reviewWork(run = state.run) {
    const candidates = run?.candidates || [];
    const count = (...statuses) => candidates.filter((candidate) => statuses.includes(candidate.status)).length;
    const pending = count('proposed', 'deferred');
    const toApply = count('approved', 'apply_failed');
    const written = count('applied');
    const restoring = count('rolling_back', 'rollback_failed');
    return { total: candidates.length, pending, toApply, written, restoring,
      settled: candidates.length - pending - toApply - written - restoring, authorized: run?.mode === 'apply' };
  }

  function renderProgress() {
    const work = reviewWork();
    const bar = $('mrRunProgress');
    bar.hidden = !work.total;
    if (!work.total) return;
    const part = (value, tone, text) => (value
      ? `<i class="mr-progress-${tone}" style="flex:${value}" title="${value} ${text}"></i>` : '');
    const decided = work.total - work.pending;
    bar.innerHTML = `<div class="mr-progress-track" role="img" aria-label="${decided} of ${work.total} candidates decided">
        ${part(work.written, 'written', 'written')}${part(work.toApply, 'apply', 'accepted, not written yet')}${part(work.restoring, 'pending', 'unfinished restores')}${part(work.settled, 'settled', 'rejected or needing no action')}${part(work.pending, 'pending', 'awaiting your decision')}</div>
      <span><b>${decided}</b> of ${work.total} decided${work.toApply ? ` · <b>${work.toApply}</b> accepted, not written yet` : ''}${work.written ? ` · <b>${work.written}</b> written` : ''}</span>`;
  }

  function showCandidates(filter) {
    state.filter = filter;
    document.querySelectorAll('[data-status-filter]').forEach((item) => item.classList.toggle('active', item.dataset.statusFilter === filter));
    renderCandidates();
    const first = document.querySelector('.mr-candidate');
    (first || $('mrCandidateFilters')).scrollIntoView({ behavior: 'smooth', block: 'start' });
    first?.focus({ preventScroll: true });
  }

  // One sentence and one button for whatever is blocking this run. It stays in
  // view while the list scrolls, so the step that unlocks writing is never a
  // screen away from the candidate it concerns.
  function renderNext() {
    const work = reviewWork();
    const bar = $('mrNext');
    const set = (icon, title, text, primary, secondary) => {
      $('mrNextIcon').className = `fas ${icon}`;
      $('mrNextTitle').textContent = title;
      $('mrNextText').textContent = text;
      for (const [id, action] of [['mrNextPrimary', primary], ['mrNextSecondary', secondary]]) {
        const button = $(id);
        button.hidden = !action;
        if (!action) continue;
        button.textContent = action[0];
        button.onclick = action[1];
      }
      bar.hidden = false;
    };
    const plural = (value, one, many) => `${value} ${value === 1 ? one : many}`;
    const reviewNext = work.pending ? [`Review ${plural(work.pending, 'pending candidate', 'pending candidates')}`, () => showCandidates('proposed')] : null;
    if (!work.total || (!work.pending && !work.toApply)) { bar.hidden = true; return; }
    bar.dataset.tone = work.toApply ? 'apply' : 'review';
    if (work.toApply && !state.applyEnabled) {
      set('fa-lock', `${plural(work.toApply, 'accepted candidate', 'accepted candidates')} · this server only proposes`,
        'Writing is switched off on this instance, so accepted candidates stay as decisions.', reviewNext || ['Show them', () => showCandidates('approved')]);
    } else if (work.toApply && !work.authorized) {
      set('fa-key', `${plural(work.toApply, 'accepted candidate is', 'accepted candidates are')} not written yet`,
        'Accepting records your decision. Authorize this run once, then apply each accepted candidate.',
        ['Authorize reviewed writes', (event) => openAction('authorize', null, event.currentTarget)], ['Show them', () => showCandidates('approved')]);
    } else if (work.toApply) {
      set('fa-route', `${plural(work.toApply, 'accepted candidate is', 'accepted candidates are')} ready to write`,
        'This run is authorized. Each candidate is written by its own Apply to owner button.',
        [`Show the ${work.toApply} to apply`, () => showCandidates('approved')], reviewNext);
    } else {
      set('fa-inbox', `${plural(work.pending, 'candidate awaits', 'candidates await')} your decision`,
        'Approve, reject, defer or reword each one. Nothing is written by a decision alone.', reviewNext);
    }
  }

  function renderCollector(collector) {
    const errors = (collector.errors || []).length;
    const advisories = (collector.drift || []).length;
    const eligible = collector.eligibleObservations || 0;
    const sources = collector.sourceFilesSeen || 0;
    return `<details class="mr-collector ${errors ? 'mr-collector-error' : ''}" ${errors ? 'open' : ''}><summary>
      <span class="mr-runtime-icon"><i class="fas ${errors ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i></span>
      <strong>${esc(label(collector.runtime))}</strong><span>${esc(collector.host)}${collector.agentOrProfile ? ` · ${esc(collector.agentOrProfile)}` : ''}</span>
      <span class="mr-collector-counts"><b>${eligible}</b> signal${eligible === 1 ? '' : 's'} · ${collector.rejectedObservations || 0} filtered${advisories ? ` · ${advisories} ${advisories === 1 ? 'advisory' : 'advisories'}` : ''}</span>
    </summary><div class="mr-collector-detail">${sources} source${sources === 1 ? '' : 's'} · ${collector.sourceEventsSeen || 0} new events
      ${(collector.errors || []).map((value) => `<p class="mr-warn-text"><b>Error:</b> ${esc(value)}</p>`).join('')}
      ${(collector.drift || []).map((value) => `<p class="mr-advisory-text"><b>Advisory:</b> ${esc(value)}</p>`).join('')}
    </div></details>`;
  }

  function updateFilterCounts() {
    const candidates = state.run?.candidates || [];
    $('mrCandidateFilters').hidden = !candidates.length;
    document.querySelectorAll('[data-filter-count]').forEach((badge) => {
      badge.textContent = badge.dataset.filterCount === 'all' ? candidates.length : candidates.filter((candidate) => candidate.status === badge.dataset.filterCount).length;
    });
  }

  function candidateActions(candidate) {
    if (candidate.type === 'supersedes' && ['applied', 'rollback_failed'].includes(candidate.status)
        && state.applyEnabled && state.run?.mode === 'apply') return `<div class="mr-candidate-actions">
      <button type="button" class="mr-btn mr-btn-secondary" data-action="rollback"><i class="fas fa-rotate-left"></i>
      ${candidate.status === 'rollback_failed' ? 'Retry restoring previous fact' : 'Restore previous fact'}</button></div>`;
    if (['proposed', 'deferred'].includes(candidate.status)) return `<div class="mr-candidate-actions">
      <button type="button" class="mr-btn mr-btn-approve" data-action="approve" aria-keyshortcuts="A"><i class="fas fa-check"></i> Approve</button>
      <button type="button" class="mr-btn mr-btn-reject" data-action="reject" aria-keyshortcuts="R"><i class="fas fa-xmark"></i> Reject</button>
      <button type="button" class="mr-btn mr-btn-secondary" data-action="defer" aria-keyshortcuts="D"><i class="fas fa-clock"></i> Defer</button>
      <button type="button" class="mr-btn mr-btn-secondary" data-action="edit_approve" aria-keyshortcuts="E"><i class="fas fa-pen"></i> Edit & approve</button>
    </div>`;
    if (['approved', 'apply_failed'].includes(candidate.status)) {
      const allowed = state.applyEnabled && state.run?.mode === 'apply';
      const title = state.applyEnabled ? 'Authorize this reviewed run before applying' : 'Server is in proposal-only protection';
      // The step that unlocks writing sits on the candidate that waits for it.
      const unlock = state.applyEnabled && !allowed
        ? `<button type="button" class="mr-btn mr-btn-apply" data-action="authorize"><i class="fas fa-key"></i> Authorize reviewed writes</button>
           <span class="mr-action-hint">Accepted, not written yet. Authorize this run once, then apply.</span>` : '';
      return `<div class="mr-candidate-actions">${unlock}<button type="button" class="mr-btn ${allowed ? 'mr-btn-apply' : 'mr-btn-secondary'}" data-action="apply" ${allowed ? '' : `disabled title="${title}"`}>
        <i class="fas fa-route"></i> ${candidate.status === 'apply_failed' ? 'Retry apply' : 'Apply to owner'}</button></div>`;
    }
    return candidate.status === 'parked' ? '<div class="mr-candidate-actions"><span class="mr-action-hint">Parked: this run had already reached its limit of review exceptions. Nothing is written for it, and it cannot be decided here.</span></div>' : '';
  }

  function renderCandidates() {
    const all = state.run?.candidates || [];
    // In the full list, what waits for the owner comes first: accepted and not
    // written, then undecided. Numbers stay those of the run.
    const rank = (status) => (['approved', 'apply_failed', 'rolling_back', 'rollback_failed'].includes(status) ? 0 : ['proposed', 'deferred'].includes(status) ? 1 : 2);
    const visible = all.map((candidate, index) => ({ candidate, number: index + 1 }))
      .filter(({ candidate }) => state.filter === 'all' || candidate.status === state.filter
        || (state.filter === 'approved' && candidate.status === 'apply_failed')
        || (state.filter === 'proposed' && candidate.status === 'deferred'))
      .sort((a, b) => rank(a.candidate.status) - rank(b.candidate.status) || a.number - b.number);
    const message = $('mrCandidatesState');
    if (!all.length) {
      const currentCoverageNeedsAttention = Boolean(
        state.collectingAlert
        || state.insights?.health?.errors
        || state.insights?.health?.overdue
        || state.insights?.health?.stale
        || state.insights?.health?.missing
      );
      message.hidden = false;
      message.innerHTML = ['collecting', 'synthesizing'].includes(state.run?.status)
        ? '<div class="mr-quiet-state mr-waiting-state"><i class="fas fa-hourglass-half"></i><strong>Waiting for reconciliation</strong><span>No candidate exists yet. Accepted evidence remains inert until collection and bounded review finish.</span></div>'
        : state.run?.summary?.noEligibleObservations
        ? currentCoverageNeedsAttention
          ? '<div class="mr-quiet-state"><i class="fas fa-triangle-exclamation"></i><strong>Nothing new in this run; current coverage needs attention.</strong><span>No trustworthy durable observation reached synthesis. The current collector warning above still applies.</span></div>'
          : '<div class="mr-quiet-state"><i class="fas fa-moon"></i><strong>Nothing new—and that is healthy.</strong><span>No trustworthy durable observation reached synthesis, so the review model was not called.</span></div>'
        : '<div class="mr-quiet-state"><i class="fas fa-circle-check"></i><strong>No candidate was needed.</strong><span>This run remains part of the audit history.</span></div>';
      $('mrCandidateList').innerHTML = '';
      return;
    }
    if (!visible.length) {
      message.hidden = false;
      message.textContent = `No ${label(state.filter).toLowerCase()} candidates in this run.`;
      $('mrCandidateList').innerHTML = '';
      return;
    }
    message.hidden = true;
    $('mrCandidateList').innerHTML = visible.map(({ candidate, number }) => renderCandidate(candidate, number)).join('');
    $('mrCandidateList').querySelectorAll('.mr-candidate').forEach((item) => {
      item.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => openAction(
        button.dataset.action, button.dataset.action === 'authorize' ? null : item.dataset.candidateId, button)));
      item.querySelector('[data-clarify]')?.addEventListener('click', () => copyClarification(item.dataset.candidateId));
    });
  }

  function targetPreview(candidate) {
    const target = candidate.target || {};
    const info = targetHelp[target.kind] || targetHelp.ignore;
    const prefix = candidate.apply?.automated ? 'Standing policy destination' : 'Exception destination';
    return `<div class="mr-destination"><i class="fas fa-route"></i><div><span>${prefix}</span><strong>${esc(info[0])}${target.runtime ? ` · ${esc(label(target.runtime))}` : ''}</strong><small>${esc(info[1])} ${esc(info[2])}</small></div></div>`;
  }

  function renderCandidate(candidate, number) {
    const target = candidate.target || {};
    const recurrence = candidate.recurrence || {};
    const risks = [];
    if (candidate.risk?.secret) risks.push('Secret risk');
    if (candidate.risk?.promptInjection) risks.push('Prompt injection');
    ['privacy', 'governance', 'staleness'].forEach((key) => {
      if (candidate.risk?.[key] && candidate.risk[key] !== 'none') risks.push(`${label(key)}: ${candidate.risk[key]}`);
    });
    const confidence = Math.round(Math.max(0, Math.min(1, Number(candidate.confidence) || 0)) * 100);
    const consensus = recurrence.independentRuntimes > 1
      ? `<span class="mr-chip mr-consensus"><i class="fas fa-people-arrows"></i> ${recurrence.independentRuntimes}-agent consensus</span>` : '';
    return `<li tabindex="-1" class="mr-candidate mr-candidate-${esc(candidate.status)}" data-candidate-id="${esc(candidate.candidateId)}">
      <span class="mr-candidate-number">${number}</span>
      <div class="mr-candidate-head"><span class="mr-chip">${esc(label(candidate.type))}</span><span class="mr-chip"><i class="fas fa-arrow-right"></i> ${esc(label(target.kind))}${target.runtime ? ` · ${esc(label(target.runtime))}` : ''}</span>
        <span class="mr-chip mr-status-${esc(candidate.status)}">${esc(label(candidate.status))}</span><span class="mr-chip">${esc(label(candidate.scope || 'project'))} · ${esc(label(candidate.sensitivity || 'normal'))}</span>${consensus}${risks.map((risk) => `<span class="mr-chip mr-warn">${esc(risk)}</span>`).join('')}</div>
      <p class="mr-statement">${esc(candidate.statement)}</p>
      ${candidate.review?.editedStatement ? `<p class="mr-edited"><i class="fas fa-pen"></i> Approved wording: ${esc(candidate.review.editedStatement)}</p>` : ''}
      ${candidate.rationale ? `<p class="mr-rationale">${esc(candidate.rationale)}</p>` : ''}
      ${candidate.supersedes ? `<p class="mr-rationale">Replaces memory note ${esc(candidate.supersedes.ref)}. The previous wording stays in owner history.</p>` : ''}
      ${candidate.supersessionPreview?.text ? `<blockquote class="mr-rationale"><b>Previous fact:</b> ${esc(candidate.supersessionPreview.text)}${candidate.supersessionPreview.validFrom ? ` · valid from ${esc(shortDate(candidate.supersessionPreview.validFrom))}` : ''}</blockquote>` : ''}
      ${candidate.supersessionPreview?.unavailable ? '<p class="mr-rationale">The previous fact is no longer available. Refresh before applying a change.</p>' : ''}
      ${candidate.automation?.reason ? `<p class="mr-rationale"><b>${esc(label(candidate.automation.disposition))}:</b> ${esc(candidate.automation.reason)}</p>` : ''}
      <div class="mr-signal-grid"><span><b>${(candidate.evidence || []).length}</b> evidence</span><span><b>${recurrence.independentSessions || 0}</b> ${recurrence.independentSessions === 1 ? 'session' : 'sessions'}</span><span><b>${recurrence.independentRuntimes || 0}</b> ${recurrence.independentRuntimes === 1 ? 'runtime' : 'runtimes'}</span>
        <span class="mr-confidence"><span>Confidence <b>${confidence}%</b></span><i><i style="width:${confidence}%"></i></i></span></div>
      ${targetPreview(candidate)}
      ${(candidate.conflicts || []).map((conflict) => `<div class="mr-conflict"><div><i class="fas fa-triangle-exclamation"></i> <b>${esc(label(conflict.authority))} disagrees</b><span>${esc(conflict.summary)}</span></div><button type="button" class="mr-btn mr-btn-secondary" data-clarify><i class="fas fa-comment-dots"></i> Copy clarification question</button></div>`).join('')}
      <details class="mr-evidence"><summary><i class="fas fa-magnifying-glass"></i> Why AgentX trusts this (${(candidate.evidence || []).length})</summary>
        ${(candidate.evidence || []).map((evidence) => `<div class="mr-evidence-item"><span class="mr-chip">${esc(label(evidence.runtime))}</span><span class="mr-chip">${esc(label(evidence.trust))}</span><time>${esc(shortDate(evidence.observedAt))}</time><p>${esc(trustHelp[evidence.trust] || 'This evidence passed the bounded provenance policy.')}</p><blockquote>${esc(evidence.redactedExcerpt || '(No excerpt retained)')}</blockquote></div>`).join('')}</details>
      ${candidate.apply?.attemptedAt ? `<div class="mr-apply-result"><b>Apply result:</b> ${esc(candidate.type === 'supersedes' && ['applied', 'rolling_back', 'rollback_failed', 'rolled_back'].includes(candidate.status) ? 'Replacement recorded; previous wording kept in your history.' : candidate.apply.result || 'In progress')}${candidate.type !== 'supersedes' && candidate.apply.rollbackRef ? ` · rollback ${esc(candidate.apply.rollbackRef)}` : ''}</div>` : ''}
      ${candidate.rollback?.at ? `<div class="mr-apply-result"><b>Restore result:</b> ${esc(candidate.status === 'rolled_back' ? 'Previous fact restored.' : candidate.rollback.result || 'In progress')}</div>` : ''}
      ${candidate.review?.by ? `<p class="mr-reviewed">Reviewed by ${esc(candidate.review.by)} · ${esc(shortDate(candidate.review.at))}</p>` : ''}
      ${candidateActions(candidate)}</li>`;
  }

  function copyClarification(candidateId) {
    const candidate = (state.run?.candidates || []).find((item) => item.candidateId === candidateId);
    const conflict = candidate?.conflicts?.[0];
    if (!candidate || !conflict) return;
    copyText(`Dreaming Review needs clarification: should our agents treat “${candidate.statement}” as current, or preserve the existing ${label(conflict.authority).toLowerCase()} evidence described as “${conflict.summary}”?`, 'Clarification question copied.');
  }

  function renderAudit() {
    $('mrAuditList').innerHTML = (state.run?.audit || []).slice().reverse().map((entry) => `<li class="mr-audit-${esc(entry.level)}"><time>${esc(shortDate(entry.at))}</time><strong>${esc(label(entry.event))}</strong><span>by ${esc(entry.by)}</span>${entry.detail ? `<em>${esc(entry.detail)}</em>` : ''}</li>`).join('') || '<li>No audit entries.</li>';
  }

  function openAction(action, candidateId, trigger) {
    const copy = actionCopy[action];
    if (!copy) return;
    const candidate = (state.run?.candidates || []).find((item) => item.candidateId === candidateId);
    state.pendingAction = { action, candidateId };
    state.returnFocus = trigger || document.activeElement;
    $('mrActionTitle').textContent = copy[0];
    $('mrActionDescription').textContent = copy[1];
    $('mrActionSubmit').textContent = copy[2];
    $('mrActionSubmit').className = `mr-btn ${copy[4]}`;
    $('mrActionIcon').className = `fas ${copy[3]}`;
    $('mrStatementField').hidden = action !== 'edit_approve';
    $('mrNoteField').hidden = !['approve', 'reject', 'defer', 'edit_approve'].includes(action);
    $('mrActionStatement').value = action === 'edit_approve' ? candidate?.statement || '' : '';
    $('mrActionNote').value = '';
    if (candidate) {
      const number = state.run.candidates.indexOf(candidate) + 1;
      $('mrActionPreview').hidden = false;
      $('mrActionPreview').innerHTML = `<p class="mr-action-candidate"><b>#${number}</b> ${esc(candidate.statement)}</p>`
        + (['approve', 'edit_approve', 'apply'].includes(action) ? targetPreview(candidate) : '');
    } else {
      $('mrActionPreview').hidden = true;
      $('mrActionPreview').innerHTML = '';
    }
    $('mrActionBackdrop').hidden = false;
    document.body.classList.add('mr-modal-open');
    setTimeout(() => (action === 'edit_approve' ? $('mrActionStatement') : $('mrActionSubmit')).focus(), 0);
  }

  function closeAction() {
    $('mrActionBackdrop').hidden = true;
    document.body.classList.remove('mr-modal-open');
    state.pendingAction = null;
    state.returnFocus?.focus();
  }

  async function submitAction(event) {
    event.preventDefault();
    const pending = state.pendingAction;
    if (!pending || !state.run) return;
    const body = {};
    let url;
    if (pending.action === 'authorize') {
      url = `/api/memory-review/runs/${encodeURIComponent(state.run.runId)}/authorize-apply`;
    } else if (['apply', 'rollback'].includes(pending.action)) {
      url = `/api/memory-review/runs/${encodeURIComponent(state.run.runId)}/candidates/${encodeURIComponent(pending.candidateId)}/${pending.action}`;
    } else {
      url = `/api/memory-review/runs/${encodeURIComponent(state.run.runId)}/candidates/${encodeURIComponent(pending.candidateId)}/review`;
      body.action = pending.action;
      const note = $('mrActionNote').value.trim();
      if (note) body.note = note;
      if (pending.action === 'edit_approve') {
        body.editedStatement = $('mrActionStatement').value.trim();
        if (!body.editedStatement) return toast('Approved wording cannot be empty.', 'error');
      }
    }
    const pendingCandidates = (state.run.candidates || []).filter((item) => ['proposed', 'deferred'].includes(item.status));
    const index = pendingCandidates.findIndex((item) => item.candidateId === pending.candidateId);
    state.focusAfter = pendingCandidates[index + 1]?.candidateId || pendingCandidates[index - 1]?.candidateId || null;
    const submit = $('mrActionSubmit');
    submit.disabled = true;
    try {
      const result = await apiJson(url, { method: 'POST', body });
      if (['apply_failed', 'rollback_failed'].includes(result.status)) throw new Error(result.result || 'The operation needs reconciliation. Refresh before retrying.');
      const actionLabel = pending.action === 'rollback' ? 'Previous fact restored' : pending.action === 'authorize' ? 'Run authorized' : pending.action === 'apply' ? 'Candidate applied' : 'Review saved';
      closeAction(); toast(actionLabel, 'success');
      await Promise.all([loadInsights(), loadRuns({ select: false })]);
      await selectRun(state.selectedRunId);
      if (pending.action === 'authorize') showCandidates('approved');
      if (['apply', 'rollback'].includes(pending.action)) showCandidates('all');
    } catch (error) {
      state.focusAfter = null;
      toast(`Action failed: ${error.message}`, 'error');
    } finally { submit.disabled = false; }
  }

  document.querySelectorAll('[data-status-filter]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-status-filter]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    state.filter = button.dataset.statusFilter; renderCandidates();
  }));
  $('mrRunSearch').addEventListener('input', (event) => { state.runSearch = event.target.value.trim(); renderRuns(); });
  $('mrRunStatus').addEventListener('change', (event) => { state.runFilter = event.target.value; renderRuns(); });
  $('mrRefreshBtn').addEventListener('click', async () => {
    const loaded = await Promise.all([loadConfig(), loadInsights(), loadRuns()]);
    if (loaded.every(Boolean)) toast('Dreaming Review refreshed.', 'success');
  });
  $('mrShareBtn').addEventListener('click', () => copyText(state.insights?.safeDigest || 'Dreaming Review status is unavailable.', 'Statement-free digest copied.'));
  $('mrCopyLink').addEventListener('click', () => (state.run ? copyText(window.location.href, 'Link to this run copied.') : toast('This run has not loaded.', 'error')));
  $('mrActionForm').addEventListener('submit', submitAction);
  $('mrActionClose').addEventListener('click', closeAction);
  $('mrActionCancel').addEventListener('click', closeAction);
  $('mrActionBackdrop').addEventListener('click', (event) => { if (event.target === $('mrActionBackdrop')) closeAction(); });
  document.addEventListener('keydown', (event) => {
    if (!$('mrActionBackdrop').hidden) {
      if (event.key === 'Escape') return closeAction();
      return MemoryReviewKeys.trapTab(event, $('mrActionModal'));
    }
    if (/INPUT|TEXTAREA|SELECT|SUMMARY/.test(document.activeElement?.tagName || '') || event.ctrlKey || event.metaKey || event.altKey) return;
    const items = [...document.querySelectorAll('.mr-candidate')];
    const index = items.indexOf(document.activeElement?.closest?.('.mr-candidate'));
    const shortcut = MemoryReviewKeys.resolveShortcut(event.key, { count: items.length, index });
    if (shortcut?.move !== undefined) { event.preventDefault(); items[shortcut.move].focus(); }
    if (shortcut?.action) items[index].querySelector(`[data-action="${shortcut.action}"]`)?.click();
  });

  // The statistics panel stays out of the way while a run waits for the
  // owner, and opens by itself when there is nothing to decide. A choice made
  // by hand is kept.
  const INTELLIGENCE_KEY = 'agentx.memoryReview.intelligenceOpen';
  function placeIntelligence() {
    const panel = $('mrIntelligence');
    let stored = null;
    try { stored = window.localStorage.getItem(INTELLIGENCE_KEY); } catch { stored = null; }
    const work = reviewWork();
    panel.dataset.auto = '1';
    panel.open = stored === null ? !(work.pending || work.toApply) : stored === '1';
    delete panel.dataset.auto;
  }
  $('mrIntelligence').addEventListener('toggle', (event) => {
    if (event.target.dataset.auto) return;
    try { window.localStorage.setItem(INTELLIGENCE_KEY, event.target.open ? '1' : '0'); } catch { /* private mode */ }
  });

  // Config decides whether Authorize and Apply are offered, so it loads first.
  (async () => { await loadConfig(); await Promise.all([loadInsights(), loadRuns()]); placeIntelligence(); })();
})();
