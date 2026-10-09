/* Pipeline board sections: evidence, progression, open work, attention,
   recently done and team performance. pipeline.js creates it with its
   shared state and helpers. */
(function () {
  'use strict';
  let $, state, hasExactCountEvidence, formatDate, sortTasks, matchesContext, matchesFilters, formatStatus, escapeHtml, statusBadge, STATUS_ORDER, priorityChip, isStale, summaryCount, hasActiveFilters, contextDescription, unmetDependencies, riskChip, dueCell, activityCell, relativeTime, percentLabel, durationLabel, costLabel, energyLabel, nanoCurrencyLabel, costEvidencePresentation, localEnergyPresentation, readProjection;

  function renderEvidence() {
    const el = $('pipelineCountEvidence');
    if (!el) return;
    const evidence = state.evidence;
    const summary = state.summary;
    if (!hasExactCountEvidence()) {
      el.textContent = 'Count evidence unavailable; cards reflect only the rows loaded in this browser.';
      el.classList.add('pipeline-evidence-warning');
      return;
    }
    const statusScope = evidence.scope?.includesDone ? 'all statuses, including done' : 'open statuses only';
    const returned = Number(evidence.rows?.returnedCount) || 0;
    const matched = Number(evidence.rows?.matchedCount) || 0;
    const rowWindow = evidence.rows?.truncated
      ? `rows show ${returned} of ${matched}`
      : `rows show all ${returned} matched records`;
    const observed = formatDate(evidence.observedAt);
    el.textContent = `MongoDB task authority · exact full-scope totals (${statusScope}) · all-time, no date filter · ${rowWindow} · sampled ${observed}`;
    el.classList.remove('pipeline-evidence-warning');
  }

  function visibleTasks() {
    // Without an explicit status filter the table shows open work only; a
    // status filter (including "done") widens or narrows it deliberately.
    return sortTasks(
      state.tasks.filter(matchesContext)
        .filter(matchesFilters)
        .filter((task) => (state.filters.status ? true : task.status !== 'done'))
    );
  }

  function renderProgression() {
    const target = $('pipelineProgression');
    if (!target) return;
    const scoped = state.tasks.filter(matchesContext).filter(matchesFilters);
    const tasks = sortTasks(scoped.filter((task) => state.filters.status || state.includeDone || task.status !== 'done'));
    const done = scoped.filter((task) => task.status === 'done').length;
    const superseded = scoped.filter((task) => task.resolution?.kind === 'superseded').length;
    const scope = state.filters.epic ? `Group: ${state.filters.epic}` : 'All groups';
    $('pipelineOverviewMeta').textContent = `${scope} · ${tasks.length} matching loaded tasks · ${done}/${scoped.length} closed${superseded ? ` (${superseded} superseded)` : ''}${state.filters.status ? ` · ${formatStatus(state.filters.status)}` : ''}. Counts above remain global.${state.evidence?.rows?.truncated ? ' Loaded sample is incomplete; see count scope above.' : ''}`;
    $('pipelineIncludeDone').disabled = Boolean(state.filters.status);
    document.querySelectorAll('[data-pipeline-view]').forEach((button) => {
      const selected = button.dataset.pipelineView === state.view;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (!tasks.length) {
      target.innerHTML = '<div class="pipeline-empty">No tasks match this view. <button type="button" class="pipeline-btn compact" data-clear-filters>Clear filters</button></div>';
      return;
    }
    if (state.view === 'timeline') {
      const events = tasks.flatMap((task) => task.timeline.map((entry) => ({ task, ...entry })))
        .filter((entry) => entry.at && Number.isFinite(new Date(entry.at).getTime()))
        .sort((a, b) => new Date(b.at) - new Date(a.at) || a.task.pipelineId.localeCompare(b.task.pipelineId));
      target.innerHTML = `<p class="pipeline-timeline-note">Recorded events · newest first. Status badges show current status. Unrecorded transitions and completion dates remain unknown; a record update does not prove delivery.</p>
        <ol class="pipeline-timeline">${events.slice(0, state.timelineLimit).map((entry) => `<li>
          <time datetime="${escapeHtml(entry.at)}">${escapeHtml(formatDate(entry.at))}</time>
          <button type="button" class="pipeline-task-card" data-pipeline-task="${escapeHtml(entry.task.pipelineId)}">
            <span class="pipeline-card-top"><strong>${escapeHtml(entry.task.pipelineId)}</strong>${statusBadge(entry.task.status)}</span>
            <span class="pipeline-card-title">${escapeHtml(entry.task.title)}</span>
            <span class="pipeline-card-event">${escapeHtml(entry.label)}${entry.attempt ? ` · attempt ${escapeHtml(entry.attempt)}` : ''}</span>
          </button></li>`).join('')}</ol>
        ${events.length > state.timelineLimit ? `<button type="button" class="pipeline-btn compact" data-more-events>Show more events (${events.length - state.timelineLimit} remaining)</button>` : ''}
        <p class="pipeline-timeline-note">${Math.min(events.length, state.timelineLimit)} of ${events.length} recorded events · ${tasks.filter((task) => !task.timeline.length).length} tasks without recorded event dates. Full feedback remains in each dossier.</p>`;
      return;
    }
    const stages = state.filters.status ? [state.filters.status] : STATUS_ORDER.filter((status) => state.includeDone || status !== 'done');
    target.innerHTML = `<div class="pipeline-board${stages.length === 1 ? ' pipeline-board-focused' : ''}">${stages.map((status) => {
      const items = tasks.filter((task) => task.status === status);
      if (status === 'done') items.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const shown = state.expandedStages.has(status) ? items : items.slice(0, 8);
      return `<section class="pipeline-board-column stage-${escapeHtml(status)}" aria-label="${escapeHtml(formatStatus(status))} tasks">
        <h3>${statusBadge(status)}<span>${items.length}</span></h3>
        <div class="pipeline-board-cards">${shown.map((task) => `<button type="button" class="pipeline-task-card" data-pipeline-task="${escapeHtml(task.pipelineId)}" aria-label="Open task ${escapeHtml(task.pipelineId)}: ${escapeHtml(task.title)}">
          <span class="pipeline-card-top"><strong>${escapeHtml(task.pipelineId)}</strong>${priorityChip(task.priority)}</span>
          <span class="pipeline-card-title">${escapeHtml(task.title || 'Untitled task')}</span>
          <span class="pipeline-card-meta">${escapeHtml(task.assignee || 'Unassigned')} · ${escapeHtml(task.service || 'No service')}</span>
          ${task.epic ? `<span class="pipeline-card-group">${escapeHtml(task.epic)}</span>` : ''}
          ${task.resolution?.kind === 'superseded' ? '<span class="pipeline-card-event">Closed by supersession</span>' : ''}
          ${isStale(task) ? '<span class="pipeline-card-alert">Stale heartbeat</span>' : ''}
          ${task.dependsOn.length ? `<span class="pipeline-card-meta">Depends on ${escapeHtml(task.dependsOn.join(', '))}</span>` : ''}
          ${task.dueAt ? `<span class="pipeline-card-meta">Due ${escapeHtml(formatDate(task.dueAt))}</span>` : ''}
        </button>`).join('') || '<p class="pipeline-column-empty">No matching tasks</p>'}</div>
        ${shown.length < items.length ? `<button class="pipeline-btn compact pipeline-more" type="button" data-more-stage="${escapeHtml(status)}">Show all ${items.length}</button>` : ''}
      </section>`;
    }).join('')}</div>`;
  }

  function renderOpenWork() {
    const rows = $('pipelineOpenRows');
    const meta = $('pipelineOpenMeta');
    if (!rows) return;

    const tasks = visibleTasks();
    const loadedOpen = state.tasks.filter((task) => task.status !== 'done').length;
    const exactOpen = summaryCount('openCount', loadedOpen);
    const exactMatched = summaryCount('matchedCount', state.tasks.length);

    if (meta) {
      const scope = state.filters.status ? `${formatStatus(state.filters.status)} tasks` : 'open tasks';
      const filtered = hasActiveFilters() || state.context;
      meta.textContent = filtered
        ? `${tasks.length} matching loaded ${scope} · ${exactOpen} open overall across ${exactMatched} exact records`
        : `${exactOpen} open task${exactOpen === 1 ? '' : 's'} across ${exactMatched} exact all-time record${exactMatched === 1 ? '' : 's'} · ${state.tasks.length} rows loaded`;
    }

    if (!tasks.length) {
      const reason = state.context
        ? `No work matches ${escapeHtml(contextDescription())}.`
        : hasActiveFilters()
          ? 'No tasks match the current filters.'
          : 'No open pipeline work in the loaded task window.';
      const action = hasActiveFilters()
        ? '<button type="button" class="pipeline-btn compact" data-clear-filters><i class="fas fa-filter-circle-xmark"></i><span>Clear filters</span></button>'
        : '';
      rows.innerHTML = `<tr><td colspan="8" class="pipeline-empty">${reason} ${action}</td></tr>`;
      return;
    }

    const byId = new Map(state.tasks.map((t) => [String(t.pipelineId), t]));
    rows.innerHTML = tasks.map((task) => {
      const deps = unmetDependencies(task, byId);
      const depsChip = deps.length && task.status !== 'done'
        ? `<span class="pipeline-deps" title="Waiting on ${escapeHtml(deps.join(', '))}"><i class="fas fa-link" aria-hidden="true"></i>waits on ${escapeHtml(deps.slice(0, 3).join(', '))}${deps.length > 3 ? '…' : ''}</span>`
        : '';
      return `
        <tr class="${state.context ? 'pipeline-row-context' : ''}" data-pipeline-task="${escapeHtml(task.pipelineId)}" tabindex="0"
            aria-label="Open task ${escapeHtml(task.pipelineId)} details">
          <td class="pipeline-id">${escapeHtml(task.pipelineId)}</td>
          <td>
            <div class="pipeline-title" title="${escapeHtml(task.title || 'Untitled task')}">${escapeHtml(task.title || 'Untitled task')}</div>
            <div class="pipeline-title-meta">
              ${task.epic ? `<span class="pipeline-subtle">${escapeHtml(task.epic)}</span>` : ''}
              ${riskChip(task.risk)}
              ${depsChip}
            </div>
          </td>
          <td>${priorityChip(task.priority)}</td>
          <td>${statusBadge(task.status)}</td>
          <td>${escapeHtml(task.assignee || 'unassigned')}</td>
          <td>${escapeHtml(task.service || '--')}</td>
          <td>${dueCell(task)}</td>
          <td>${activityCell(task)}</td>
        </tr>
      `;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Attention + recently done
  // ---------------------------------------------------------------------------

  function reviewContext(task) {
    return task.nextAction || { label: 'Task projection unavailable',
      detail: 'Current task evidence is unavailable.', action: 'Refresh the authoritative task before deciding.' };
  }

  // Paginated, scoped queue: public/js/pipeline-attention.js (Core /api/pipeline/attention).
  function renderAttention() {
    state.attention?.setFilters({ filters: state.filters, context: state.context });
  }

  function renderRecentlyDone() {
    const list = $('pipelineDoneList');
    const meta = $('pipelineDoneMeta');
    if (!list) return;
    const done = state.tasks
      .filter((task) => task.status === 'done')
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 8);
    if (meta) meta.textContent = done.length ? `Latest ${done.length} closed records by update time · all loaded tasks` : 'No closed tasks loaded';
    if (!done.length) {
      list.innerHTML = '<div class="pipeline-empty">No closed tasks in the loaded window yet.</div>';
      return;
    }
    list.innerHTML = done.map((task) => `
      <button type="button" class="pipeline-done-item" data-pipeline-task="${escapeHtml(task.pipelineId)}">
        <i class="fas fa-check" aria-hidden="true"></i>
        <span class="pipeline-done-copy">
          <strong>${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title || 'Untitled task')}</strong>
          <span>${escapeHtml([task.service, relativeTime(task.updatedAt) ? `updated ${relativeTime(task.updatedAt)}` : ''].filter(Boolean).join(' · ') || '--')}</span>
        </span>
      </button>
    `).join('');
  }

  function teamMetric(id, value, detailId, detail) {
    const valueEl = $(id), detailEl = $(detailId);
    if (valueEl) valueEl.textContent = value;
    if (detailEl) detailEl.textContent = detail;
  }

  function attemptOutcome(attempt) {
    if (attempt.reviewOutcome && attempt.reviewOutcome !== 'pending') return attempt.reviewOutcome;
    return attempt.finalState || 'active';
  }

  function renderTeamPerformance() {
    const stateEl = $('pipelineTeamState'), rowsEl = $('pipelineTeamAttemptRows');
    const metaEl = $('pipelineTeamAttemptMeta');
    const performance = state.performance;
    const phasesEl = $('pipelineTeamPhases');
    if (state.performanceError) {
      if (phasesEl) phasesEl.innerHTML = window.PipelinePhaseDurations?.stateMarkup('unavailable', 'Phase durations are unavailable because the performance read failed.') || '';
      if (stateEl) {
        stateEl.dataset.tone = 'unavailable';
        stateEl.innerHTML = `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>Performance unavailable: ${escapeHtml(state.performanceError)}</span>`;
      }
      if (rowsEl) rowsEl.innerHTML = '<tr><td colspan="7" class="pipeline-error">Attempt evidence could not be loaded.</td></tr>';
      return;
    }
    if (!performance) return;
    if (phasesEl) phasesEl.innerHTML = window.PipelinePhaseDurations?.summaryMarkup(performance) || '';
    const total = Number(performance.coverage?.total) || 0;
    const evidence = Number(performance.coverage?.attemptEvidence) || 0;
    const costKnown = Number(performance.coverage?.cost) || 0;
    const accepted = Number(performance.counts?.accepted) || 0;
    const interventions = Number(performance.autonomy?.correctiveHumanInterventions) || 0;
    const attempts = Array.isArray(performance.attempts) ? performance.attempts : [];
    if (stateEl) {
      const tone = performance.state === 'observed' ? 'healthy' : (performance.state === 'no_data' ? 'empty' : 'partial');
      const label = performance.state === 'no_data'
        ? 'No autonomous attempts in this window.'
        : `${total} autonomous attempt${total === 1 ? '' : 's'} · ${evidence}/${total} structured receipt${evidence === 1 ? '' : 's'} · missing fields remain unknown.`;
      stateEl.dataset.tone = tone;
      stateEl.innerHTML = `<i class="fas ${tone === 'healthy' ? 'fa-circle-check' : tone === 'empty' ? 'fa-circle-minus' : 'fa-circle-half-stroke'}" aria-hidden="true"></i><span>${escapeHtml(label)}</span>`;
    }

    teamMetric(
      'pipelineTeamAccepted',
      String(accepted),
      'pipelineTeamAcceptedDetail',
      `${accepted}/${Number(performance.quality?.decided) || 0} decided attempts · ${percentLabel(performance.quality?.acceptanceRate)} acceptance · ${Number(performance.counts?.awaitingReview) || 0} awaiting review · ${Number(performance.counts?.blocked) || 0} blocked`
    );
    teamMetric(
      'pipelineTeamFirstPass',
      percentLabel(performance.quality?.firstPassShare),
      'pipelineTeamFirstPassDetail',
      performance.quality?.firstPassShare == null
        ? 'No accepted attempt to measure yet'
        : `${Number(performance.quality?.firstPassAccepted) || 0}/${accepted} accepted attempts were attempt 1`
    );
    teamMetric(
      'pipelineTeamCycle',
      durationLabel(performance.timing?.cycleMs?.p50),
      'pipelineTeamCycleDetail',
      `Task creation → human decision · ${Number(performance.timing?.cycleMs?.observed) || 0}/${total} observed · p95 ${durationLabel(performance.timing?.cycleMs?.p95)}`
    );
    teamMetric(
      'pipelineTeamInterventions',
      String(interventions),
      'pipelineTeamInterventionsDetail',
      `${Number(performance.counts?.requeued) || 0} requeued · ${Number(performance.counts?.rejected) || 0} rejected`
    );
    const providerSpend = performance.usage?.observedProviderSpendNanodollars;
    const sessionEstimate = performance.usage?.observedSessionEstimateNanodollars;
    const localEnergy = performance.usage?.observedEnergyMillijoules;
    const electricityByCurrency = Array.isArray(performance.usage?.electricityByCurrency)
      ? performance.usage.electricityByCurrency
      : [];
    const costHeadline = providerSpend != null && sessionEstimate != null
      ? 'Mixed evidence'
      : (providerSpend != null
        ? `${costLabel(providerSpend)} provider spend`
        : (sessionEstimate != null ? `${costLabel(sessionEstimate)} session est.` : 'Unknown'));
    const costDetails = [`${costKnown}/${total} evidenced`];
    if (providerSpend != null) costDetails.push(`${costLabel(providerSpend)} provider spend`);
    if (sessionEstimate != null) costDetails.push(`${costLabel(sessionEstimate)} session estimate, billing unverified`);
    if (localEnergy != null) costDetails.push(`${energyLabel(localEnergy)} measured local GPU energy`);
    for (const electricity of electricityByCurrency) {
      costDetails.push(`${nanoCurrencyLabel(electricity.costNanoCurrencyUnits, electricity.currency)} electricity estimate`);
    }
    if (localEnergy != null && electricityByCurrency.length === 0) {
      costDetails.push('electricity tariff not configured');
    }
    teamMetric(
      'pipelineTeamCost',
      costHeadline,
      'pipelineTeamCostDetail',
      total === 0 ? 'No attempt to measure yet' : costDetails.join(' · ')
    );
    teamMetric(
      'pipelineTeamCoverage',
      total ? `${Math.round((evidence / total) * 100)}%` : '--',
      'pipelineTeamCoverageDetail',
      `${evidence}/${total} receipts · verification ${Number(performance.coverage?.verification) || 0}/${total}`
    );

    if (metaEl) metaEl.textContent = `${attempts.length}/${total} attempts shown · ${Number(performance.counts?.tasks) || 0} tasks · started ${formatDate(performance.window?.from)} – ${formatDate(performance.window?.to)} (${performance.window?.days || '--'} days)`;
    if (!rowsEl) return;
    if (!attempts.length) {
      rowsEl.innerHTML = '<tr><td colspan="7" class="pipeline-empty">No autonomous attempt evidence in this window.</td></tr>';
      return;
    }
    rowsEl.innerHTML = attempts.map((attempt) => {
      const outcome = attemptOutcome(attempt);
      const verification = attempt.verification?.status || 'unknown';
      const files = attempt.changes?.filesChanged;
      const bytes = attempt.changes?.bytesChanged;
      const change = files == null || bytes == null
        ? 'Unknown'
        : `${files} file${files === 1 ? '' : 's'} · ${Number(bytes).toLocaleString()} B`;
      const costEvidence = costEvidencePresentation(attempt.usage);
      const energyEvidence = localEnergyPresentation(attempt.usage?.localEnergy);
      return `
        <tr data-pipeline-task="${escapeHtml(attempt.pipelineId)}" tabindex="0" aria-label="Open task ${escapeHtml(attempt.pipelineId)} attempt ${escapeHtml(attempt.attempt)}">
          <td><strong class="pipeline-id">${escapeHtml(attempt.pipelineId)}</strong><span class="pipeline-team-subtle">Attempt ${escapeHtml(attempt.attempt)}</span></td>
          <td>${escapeHtml(attempt.assignee || 'unknown')}</td>
          <td><span class="pipeline-team-outcome outcome-${escapeHtml(outcome)}">${escapeHtml(formatStatus(outcome))}</span></td>
          <td>${escapeHtml(formatStatus(verification))}</td>
          <td>${escapeHtml(change)}</td>
          <td>${window.PipelinePhaseDurations?.attemptMarkup(attempt) || 'Unknown'}</td>
          <td>${escapeHtml(costEvidence.amount)}<span class="pipeline-team-subtle">${escapeHtml(costEvidence.detail)} · ${escapeHtml(energyEvidence.energy)} local energy · ${escapeHtml(energyEvidence.cost)} electricity</span></td>
        </tr>`;
    }).join('');
  }

  async function loadTeamPerformance() {
    state.performance = state.performanceError = null;
    ['Accepted', 'FirstPass', 'Cycle', 'Interventions', 'Cost', 'Coverage'].forEach((name) => {
      teamMetric(`pipelineTeam${name}`, '--', `pipelineTeam${name}Detail`, 'Loading selected period…');
    });
    $('pipelineTeamState').innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Loading selected attempt period…</span>';
    $('pipelineTeamPhases').innerHTML = '<p class="pipeline-phase-state" data-tone="loading">Loading phase durations…</p>';
    $('pipelineTeamAttemptRows').innerHTML = '<tr><td colspan="7" class="pipeline-empty">Loading selected attempt period…</td></tr>';
    $('pipelineTeamAttemptMeta').textContent = 'Loading selected period…';
    try {
      const payload = await readProjection('performance', `/api/pipeline/performance?window=${encodeURIComponent(state.performanceWindow)}`);
      if (!payload) return;
      state.performance = payload?.data?.performance || null;
      if (!state.performance) throw new Error('performance response is missing data.performance');
    } catch (error) {
      state.performance = null;
      state.performanceError = String(error.message || error);
    }
    renderTeamPerformance();
  }

  // ---------------------------------------------------------------------------
  // Task dossier drawer
  // ---------------------------------------------------------------------------

  window.PipelineBoard = {
    create(deps) {
      ({ $, state, hasExactCountEvidence, formatDate, sortTasks, matchesContext, matchesFilters, formatStatus, escapeHtml, statusBadge, STATUS_ORDER, priorityChip, isStale, summaryCount, hasActiveFilters, contextDescription, unmetDependencies, riskChip, dueCell, activityCell, relativeTime, percentLabel, durationLabel, costLabel, energyLabel, nanoCurrencyLabel, costEvidencePresentation, localEnergyPresentation, readProjection } = deps);
      return { renderEvidence, renderProgression, renderOpenWork, reviewContext, renderAttention, renderRecentlyDone, attemptOutcome, loadTeamPerformance };
    }
  };
})();
