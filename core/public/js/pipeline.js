/* global Toast */
(function () {
  'use strict';

  const STATUS_ORDER = ['queued', 'in_progress', 'review', 'blocked', 'done'];
  const OPEN_ORDER = { blocked: 0, review: 1, in_progress: 2, queued: 3, done: 4 };
  const STALE_HEARTBEAT_MS = 60 * 60 * 1000;
  const AUTO_REFRESH_MS = 10 * 1000;
  const STORAGE_AUTO = 'agentx.pipeline.autoRefresh';
  const STORAGE_REVIEWER = 'agentx.pipeline.reviewer';

  const STATUS_META = {
    queued: { label: 'Queued', icon: 'fa-inbox' },
    in_progress: { label: 'In progress', icon: 'fa-bolt' },
    review: { label: 'Review', icon: 'fa-magnifying-glass' },
    blocked: { label: 'Blocked', icon: 'fa-hand' },
    done: { label: 'Done', icon: 'fa-check' }
  };

  const DELIVERY_STAGE_META = {
    review_ready: { label: 'Ready for review', icon: 'fa-magnifying-glass', tone: 'human' },
    correction_requested: { label: 'Correction requested', icon: 'fa-rotate-left', tone: 'running' },
    accepted_waiting_pr: { label: 'Accepted · waiting for PR', icon: 'fa-code-pull-request', tone: 'running' },
    product_review: { label: 'Product review and release', icon: 'fa-code-pull-request', tone: 'human' },
    delivery_unavailable: { label: 'Delivery evidence unavailable', icon: 'fa-link-slash', tone: 'failed' },
    receipt_mismatch: { label: 'Receipt mismatch', icon: 'fa-shield-halved', tone: 'failed' },
    ci_pending: { label: 'CI pending', icon: 'fa-hourglass-start', tone: 'running' },
    ci_running: { label: 'CI running', icon: 'fa-spinner fa-spin', tone: 'running' },
    ci_failed: { label: 'CI failed', icon: 'fa-circle-xmark', tone: 'failed' },
    merge_blocked: { label: 'Merge blocked', icon: 'fa-ban', tone: 'failed' },
    pr_ready_to_merge: { label: 'PR green · ready to merge', icon: 'fa-code-merge', tone: 'human' },
    deployment_pending: { label: 'Deployment pending', icon: 'fa-hourglass-start', tone: 'running' },
    deployment_in_progress: { label: 'Deployment in progress', icon: 'fa-rocket fa-beat-fade', tone: 'running' },
    deployed: { label: 'Deployed · production proven', icon: 'fa-circle-check', tone: 'success' },
    deployment_verification_failed: { label: 'Production proof failed', icon: 'fa-triangle-exclamation', tone: 'failed' },
    deployment_rolled_back: { label: 'Deployment rolled back', icon: 'fa-rotate-left', tone: 'failed' },
    deployment_failed: { label: 'Deployment failed', icon: 'fa-circle-xmark', tone: 'failed' }
  };

  const state = {
    tasks: [],
    summary: null,
    evidence: null,
    performance: null,
    performanceError: null,
    performanceWindow: '30d',
    launchController: null,
    taskReadVersion: 0,
    delivery: null,
    deliveryError: null,
    deliveryMerging: null,
    deliveryLoading: false,
    requests: {},
    taskError: null,
    view: 'board',
    includeDone: true,
    expandedStages: new Set(),
    timelineLimit: 60,
    loading: false,
    context: readContext(),
    deepLinkedTask: readDeepLinkedTask(),
    filters: { status: null, search: '', service: '', lane: '', epic: '' },
    sort: 'urgency',
    autoTimer: null,
    drawer: { open: false, pipelineId: null, opener: null, task: null },
    attention: null
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function toast(kind, message) {
    if (typeof Toast !== 'undefined' && Toast && typeof Toast[kind] === 'function') {
      Toast[kind](message);
    }
  }

  function readStorage(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
  }

  // ---------------------------------------------------------------------------
  // Agent Ops handoff context (bounded, read-only focus — never pipeline truth)
  // ---------------------------------------------------------------------------

  function boundedParam(params, key, pattern, maxLength = 160) {
    const value = String(params.get(key) || '').trim();
    if (!value || value.length > maxLength || (pattern && !pattern.test(value))) return '';
    return value;
  }

  function readContext() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('from') !== 'agent-ops') return null;
    const status = boundedParam(params, 'status', /^(queued|in_progress|review|blocked|done)$/);
    const task = boundedParam(params, 'task', /^[a-z0-9._-]+$/i, 64);
    const assignee = boundedParam(params, 'assignee', /^[a-z0-9][a-z0-9 ._@-]*$/i, 80);
    const alias = boundedParam(params, 'alias', /^[a-z0-9][a-z0-9 ._@-]*$/i, 80);
    return task || assignee || status ? { task, assignee, alias, status } : null;
  }

  // Fold accents and case for search without rewriting literal punctuation
  // through compatibility normalization. Display text remains unchanged.
  function foldDiacritics(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function normalizedIdentity(value) {
    return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  function matchesContext(task) {
    const context = state.context;
    if (!context) return true;
    if (context.task && String(task.pipelineId) !== context.task) return false;
    if (context.assignee) {
      const acceptedOwners = new Set([context.assignee, context.alias].map(normalizedIdentity).filter(Boolean));
      if (!acceptedOwners.has(normalizedIdentity(task.assignee))) return false;
    }
    if (context.status && task.status !== context.status) return false;
    return true;
  }

  function contextDescription() {
    const context = state.context;
    if (!context) return '';
    const parts = [];
    if (context.task) parts.push(`task ${context.task}`);
    if (context.assignee) parts.push(`owner ${context.assignee}${context.alias && normalizedIdentity(context.alias) !== normalizedIdentity(context.assignee) ? ` / ${context.alias}` : ''}`);
    if (context.status) parts.push(`status ${formatStatus(context.status)}`);
    return parts.join(' · ');
  }

  function renderContext() {
    const banner = $('pipelineHandoffContext');
    if (!banner || !state.context) return;
    banner.hidden = false;
    $('pipelineContextTitle').textContent = `Focused from Agent Ops · ${contextDescription()}`;
    $('pipelineContextDetail').textContent = 'Counts remain global; the progression, work table and attention list show only this bounded context.';
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function formatStatus(value) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

  function statusBadge(status) {
    const safeStatus = String(status || 'unknown');
    const meta = STATUS_META[safeStatus] || { label: formatStatus(safeStatus), icon: 'fa-circle-question' };
    return `<span class="pipeline-status pipeline-status-${escapeHtml(safeStatus)}"><i class="fas ${escapeHtml(meta.icon)}" aria-hidden="true"></i>${escapeHtml(meta.label)}</span>`;
  }

  function priorityChip(priority) {
    const value = Number(priority);
    if (!Number.isFinite(value) || value < 1 || value > 5) return '<span class="pipeline-subtle">--</span>';
    return `<span class="pipeline-priority pipeline-priority-${value}" title="Priority ${value} of 5 (1 is most urgent)">P${value}</span>`;
  }

  function riskChip(risk) {
    const value = String(risk || '').toLowerCase();
    if (!['low', 'medium', 'high', 'critical'].includes(value)) return '';
    return `<span class="pipeline-risk pipeline-risk-${value}" title="Declared risk"><i class="fas fa-shield-halved" aria-hidden="true"></i>${escapeHtml(value)}</span>`;
  }

  function formatDate(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString([], {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function relativeTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    const abs = Math.abs(minutes);
    const suffix = minutes >= 0 ? 'ago' : 'from now';
    if (abs < 1) return 'just now';
    if (abs < 60) return `${abs}m ${suffix}`;
    const hours = Math.floor(abs / 60);
    if (hours < 48) return `${hours}h ${suffix}`;
    return `${Math.floor(hours / 24)}d ${suffix}`;
  }

  function durationLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unknown';
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  function percentLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const ratio = Number(value);
    return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : 'Unknown';
  }

  function costLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const nanodollars = Number(value);
    if (!Number.isFinite(nanodollars) || nanodollars < 0) return 'Unknown';
    const dollars = nanodollars / 1_000_000_000;
    return dollars < 0.01 && dollars > 0 ? '<$0.01' : `$${dollars.toFixed(2)}`;
  }

  function costEvidencePresentation(usage = {}) {
    const amount = costLabel(usage.costNanodollars);
    if (amount === 'Unknown') return { amount, detail: 'Monetary telemetry unavailable; execution is evaluated separately' };
    if (usage.costStatus === 'partial') return { amount: `${amount} observed so far`,
      detail: 'Partial session usage; this is not a complete cost total' };
    if (usage.costKind === 'provider-spend') {
      const local = usage.costSource === 'openclaw-local-provider-spend/v1';
      return {
        amount: `${amount} provider spend`,
        detail: local ? 'Local compute unpriced' : 'Provider spend receipt',
      };
    }
    if (usage.costKind === 'session-estimate') {
      return {
        amount: `${amount} session estimate`,
        detail: 'Billing unverified · OpenClaw session receipt',
      };
    }
    return { amount: 'Unknown', detail: 'Cost nature or provenance missing' };
  }

  function readDeepLinkedTask() {
    const value = String(new URLSearchParams(window.location.search).get('task') || '').trim();
    return /^\d{3,4}$/.test(value) ? value : null;
  }

  function energyLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const millijoules = Number(value);
    if (!Number.isFinite(millijoules) || millijoules < 0) return 'Unknown';
    const wattHours = millijoules / 3_600_000;
    if (wattHours > 0 && wattHours < 0.01) return '<0.01 Wh';
    return `${wattHours.toFixed(2)} Wh`;
  }

  function nanoCurrencyLabel(value, currency) {
    if (value == null || value === '' || !/^[A-Z]{3}$/.test(String(currency || ''))) return 'Unknown';
    const nanoUnits = Number(value);
    if (!Number.isFinite(nanoUnits) || nanoUnits < 0) return 'Unknown';
    const amount = nanoUnits / 1_000_000_000;
    if (amount > 0 && amount < 0.01) return `<0.01 ${currency}`;
    return `${amount.toFixed(2)} ${currency}`;
  }

  function localEnergyPresentation(localEnergy) {
    if (!localEnergy || localEnergy.measurementScope !== 'gpu-incremental-lower-bound') {
      return { energy: 'Unknown', cost: 'Unknown', detail: 'No measured local-energy evidence' };
    }
    const tariff = localEnergy.tariff || null;
    return {
      energy: energyLabel(localEnergy.energyMillijoules),
      cost: nanoCurrencyLabel(tariff?.estimatedCostNanoCurrencyUnits, tariff?.currency),
      detail: tariff
        ? 'GPU incremental lower bound · operator-configured tariff'
        : 'GPU incremental lower bound · electricity tariff not configured',
    };
  }

  function dueCell(task) {
    if (task.status === 'done' || !task.dueAt) return '<span class="pipeline-subtle">--</span>';
    const date = new Date(task.dueAt);
    if (Number.isNaN(date.getTime())) return '<span class="pipeline-subtle">--</span>';
    const days = Math.round((date.getTime() - Date.now()) / 86400000);
    const label = date.toLocaleDateString([], { month: 'short', day: '2-digit' });
    if (days < 0) return `<span class="pipeline-due overdue" title="Due ${escapeHtml(label)}"><i class="fas fa-circle-exclamation" aria-hidden="true"></i>${Math.abs(days)}d overdue</span>`;
    if (days === 0) return `<span class="pipeline-due today" title="Due ${escapeHtml(label)}"><i class="fas fa-hourglass-half" aria-hidden="true"></i>today</span>`;
    return `<span class="pipeline-due" title="Due ${escapeHtml(label)}">in ${days}d</span>`;
  }

  function heartbeatText(task) {
    if (task.status !== 'in_progress') return '';
    if (!task.heartbeatAt) return 'No heartbeat';
    const date = new Date(task.heartbeatAt);
    if (Number.isNaN(date.getTime())) return 'Invalid heartbeat';
    return `Heartbeat ${relativeTime(task.heartbeatAt)}`;
  }

  function isStale(task) {
    if (task.status !== 'in_progress') return false;
    if (!task.heartbeatAt) return true;
    const date = new Date(task.heartbeatAt);
    return Number.isNaN(date.getTime()) || Date.now() - date.getTime() > STALE_HEARTBEAT_MS;
  }

  function isOverdue(task) {
    if (task.status === 'done' || !task.dueAt) return false;
    const date = new Date(task.dueAt);
    return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
  }

  function activityCell(task) {
    if (task.status === 'in_progress') {
      const cls = isStale(task) ? 'pipeline-error' : 'pipeline-subtle';
      return `<span class="${cls}">${escapeHtml(heartbeatText(task))}</span>`;
    }
    const rel = relativeTime(task.updatedAt);
    return rel ? `<span class="pipeline-subtle">Updated ${escapeHtml(rel)}</span>` : '<span class="pipeline-subtle">--</span>';
  }

  function unmetDependencies(task, byId) {
    if (!Array.isArray(task.dependsOn) || !task.dependsOn.length) return [];
    return task.dependsOn.filter((dep) => {
      const found = byId.get(String(dep));
      return !found || found.status !== 'done';
    });
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  function normalizePayload(payload) {
    const data = payload && payload.data ? payload.data : payload;
    const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
    return {
      tasks: tasks.map((task) => ({
        pipelineId: task.pipelineId || '',
        title: task.title || '',
        service: task.service || '',
        status: task.status || 'queued',
        assignee: task.assignee || '',
        heartbeatAt: task.heartbeatAt || null,
        epic: task.epic || '',
        source: task.source || '',
        priority: task.priority,
        risk: task.risk || '',
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
        notBefore: task.notBefore || null,
        automation: task.automation && typeof task.automation === 'object' ? task.automation : null,
        automationAttemptCount: Number(task.automationAttemptCount) || 0,
        dueAt: task.dueAt || null,
        createdAt: task.createdAt || null,
        updatedAt: task.updatedAt || task.createdAt || null,
        timeline: Array.isArray(task.timeline) ? task.timeline : [],
        nextAction: task.nextAction || null,
        resolution: task.resolution || null
      })),
      summary: data?.summary || null,
      evidence: data?.evidence || null
    };
  }

  async function fetchJson(url, options) {
    const init = Object.assign({ headers: { Accept: 'application/json' } }, options || {});
    if (init.body && !init.headers['Content-Type']) {
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return body;
  }

  // Independent reads are cancellable and bounded. Mutations keep their existing
  // exact-identity contracts and are never silently retried.
  async function readProjection(key, url, timeoutMs = 15000) {
    state.requests[key]?.abort();
    const controller = new AbortController();
    state.requests[key] = controller;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = await fetchJson(url, { signal: controller.signal });
      return state.requests[key] === controller ? payload : null;
    } catch (error) {
      if (state.requests[key] !== controller) return null;
      throw new Error(controller.signal.aborted ? 'Request timed out. Refresh to try again.' : error.message);
    } finally {
      window.clearTimeout(timer);
    }
  }

  const { loadDeliveryStatus, mergeDeliveryItem, renderDispatchControl, loadDispatchControlStatus, launchOneTask } = window.PipelineDelivery.create({ escapeHtml: (...args) => escapeHtml(...args), $, state, formatDate: (...args) => formatDate(...args), DELIVERY_STAGE_META, readProjection: (...args) => readProjection(...args), fetchJson: (...args) => fetchJson(...args), toast: (...args) => toast(...args), loadTasks: (...args) => loadTasks(...args), formatStatus: (...args) => formatStatus(...args), inferenceSummary: (...args) => inferenceSummary(...args) });

  function setPageState(tone, icon, title, detail) {
    const stateEl = $('pipelineState');
    if (!stateEl) return;
    stateEl.dataset.tone = tone;
    const iconEl = $('pipelineStateIcon');
    if (iconEl) iconEl.className = `fas ${icon}`;
    const titleEl = $('pipelineStateTitle');
    if (titleEl) titleEl.textContent = title;
    const detailEl = $('pipelineStateDetail');
    if (detailEl) detailEl.textContent = detail;
    const updated = $('pipelineStateUpdated');
    if (updated) {
      updated.dateTime = new Date().toISOString();
      updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
  }

  function summarizeState() {
    if (state.taskError) return;
    const banner = window.PipelineAttention?.bannerState?.(state.attention?.engineeringCoverage());
    if (banner) setPageState(banner.tone, banner.icon, banner.title, banner.detail);
  }

  function countByStatus(tasks) {
    const counts = {};
    STATUS_ORDER.forEach((status) => { counts[status] = 0; });
    tasks.forEach((task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
    });
    return counts;
  }

  function hasExactCountEvidence() {
    const summary = state.summary;
    const evidence = state.evidence;
    const byStatus = summary?.byStatus;
    if (!summary || !byStatus || evidence?.authority !== 'core.pipeline' || evidence?.source?.store !== 'mongodb') return false;
    if (evidence.scope?.includesDone !== true || evidence.scope?.timeWindow?.kind !== 'all_time') return false;
    const scopedStatuses = Array.isArray(evidence.scope?.statuses) ? evidence.scope.statuses : [];
    if (!STATUS_ORDER.every((status) => scopedStatuses.includes(status))) return false;
    const counts = STATUS_ORDER.map((status) => Number(byStatus[status]));
    if (counts.some((count) => !Number.isFinite(count) || count < 0)) return false;
    const matched = counts.reduce((sum, count) => sum + count, 0);
    const open = counts.slice(0, 4).reduce((sum, count) => sum + count, 0);
    return matched === Number(summary.matchedCount)
      && open === Number(summary.openCount)
      && counts[4] === Number(summary.doneCount)
      && matched === Number(evidence.rows?.matchedCount);
  }

  function summaryCount(key, fallback) {
    if (!hasExactCountEvidence()) return fallback;
    const value = Number(state.summary?.[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function statusCounts() {
    const loaded = countByStatus(state.tasks);
    if (!hasExactCountEvidence()) return loaded;
    const summary = state.summary?.byStatus;
    const counts = {};
    STATUS_ORDER.forEach((status) => {
      const value = Number(summary[status]);
      counts[status] = Number.isFinite(value) && value >= 0 ? value : loaded[status];
    });
    return counts;
  }

  function renderCounts() {
    const counts = statusCounts();
    const map = {
      queued: 'pipelineCountQueued',
      in_progress: 'pipelineCountProgress',
      review: 'pipelineCountReview',
      blocked: 'pipelineCountBlocked',
      done: 'pipelineCountDone'
    };
    Object.entries(map).forEach(([status, id]) => {
      const el = $(id);
      if (el) el.textContent = String(counts[status] || 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Filters + work table
  // ---------------------------------------------------------------------------

  function matchesFilters(task) {
    const { status, search, service, lane, epic } = state.filters;
    if (epic && (task.epic || 'ungrouped') !== epic) return false;
    if (status && task.status !== status) return false;
    if (service && (task.service || 'unspecified') !== service) return false;
    if (lane && (task.source || 'unspecified') !== lane) return false;
    if (search) {
      const haystack = [task.pipelineId, task.title, task.assignee, task.epic, task.service, task.source]
        .map((v) => foldDiacritics(String(v || ''))).join(' ');
      if (!haystack.includes(foldDiacritics(search))) return false;
    }
    return true;
  }

  function urgencyScore(task) {
    let score = (OPEN_ORDER[task.status] ?? 9) * 100;
    if (isOverdue(task)) score -= 55;
    if (isStale(task)) score -= 40;
    const priority = Number(task.priority);
    score += Number.isFinite(priority) ? priority : 3;
    return score;
  }

  function sortTasks(tasks) {
    const byId = (a, b) => String(a.pipelineId).localeCompare(String(b.pipelineId));
    const sorted = tasks.slice();
    if (state.sort === 'priority') {
      sorted.sort((a, b) => (Number(a.priority) || 3) - (Number(b.priority) || 3) || byId(a, b));
    } else if (state.sort === 'recent') {
      sorted.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0) || byId(a, b));
    } else if (state.sort === 'id') {
      sorted.sort(byId);
    } else {
      sorted.sort((a, b) => urgencyScore(a) - urgencyScore(b) || byId(a, b));
    }
    return sorted;
  }

  function hasActiveFilters() {
    return Boolean(state.filters.status || state.filters.search || state.filters.service || state.filters.lane || state.filters.epic);
  }

  function renderFilterControls() {
    document.querySelectorAll('.pipeline-metric[data-status-filter]').forEach((btn) => {
      const active = btn.dataset.statusFilter === state.filters.status;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const clear = $('pipelineClearFilters');
    if (clear) clear.hidden = !hasActiveFilters();
  }

  function optionLabel(value) {
    return String(value || 'unspecified').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function populateFilter(id, values, current, allLabel) {
    const select = $(id);
    if (!select) return '';
    const available = [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    if (current && !available.includes(current)) available.push(current);
    const selected = current;
    select.innerHTML = [`<option value="">${escapeHtml(allLabel)}</option>`]
      .concat(available.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(optionLabel(value))}</option>`))
      .join('');
    return selected;
  }

  function renderFilterOptions() {
    state.filters.epic = populateFilter('pipelineEpicFilter', state.tasks.map((task) => task.epic || 'ungrouped'), state.filters.epic, 'All groups');
    state.filters.service = populateFilter(
      'pipelineServiceFilter', state.tasks.map((task) => task.service || 'unspecified'), state.filters.service, 'All services'
    );
    state.filters.lane = populateFilter(
      'pipelineLaneFilter', state.tasks.map((task) => task.source || 'unspecified'), state.filters.lane, 'All lanes / sources'
    );
  }

  const { renderEvidence, renderProgression, renderOpenWork, reviewContext, renderAttention, renderRecentlyDone, attemptOutcome, loadTeamPerformance } = window.PipelineBoard.create({ $, state, hasExactCountEvidence: (...args) => hasExactCountEvidence(...args), formatDate: (...args) => formatDate(...args), sortTasks: (...args) => sortTasks(...args), matchesContext: (...args) => matchesContext(...args), matchesFilters: (...args) => matchesFilters(...args), formatStatus: (...args) => formatStatus(...args), escapeHtml: (...args) => escapeHtml(...args), statusBadge: (...args) => statusBadge(...args), STATUS_ORDER, priorityChip: (...args) => priorityChip(...args), isStale: (...args) => isStale(...args), summaryCount: (...args) => summaryCount(...args), hasActiveFilters: (...args) => hasActiveFilters(...args), contextDescription: (...args) => contextDescription(...args), unmetDependencies: (...args) => unmetDependencies(...args), riskChip: (...args) => riskChip(...args), dueCell: (...args) => dueCell(...args), activityCell: (...args) => activityCell(...args), relativeTime: (...args) => relativeTime(...args), percentLabel: (...args) => percentLabel(...args), durationLabel: (...args) => durationLabel(...args), costLabel: (...args) => costLabel(...args), energyLabel: (...args) => energyLabel(...args), nanoCurrencyLabel: (...args) => nanoCurrencyLabel(...args), costEvidencePresentation: (...args) => costEvidencePresentation(...args), localEnergyPresentation: (...args) => localEnergyPresentation(...args), readProjection: (...args) => readProjection(...args) });

  function drawerEls() {
    return {
      shell: $('pipelineDrawerShell'),
      title: $('pipelineDrawerTitle'),
      id: $('pipelineDrawerId'),
      body: $('pipelineDrawerBody')
    };
  }

  function closeDrawer() {
    const { shell } = drawerEls();
    if (!shell || shell.hidden) return;
    shell.hidden = true;
    document.body.classList.remove('pipeline-drawer-open');
    const opener = state.drawer.opener;
    state.drawer = { open: false, pipelineId: null, opener: null, task: null };
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
    else $('pipelineProgression')?.focus({ preventScroll: true });
  }

  async function openDrawer(pipelineId, opener) {
    const { shell, title, id, body } = drawerEls();
    if (!shell || !body) return;
    state.drawer = { open: true, pipelineId, opener: opener || document.activeElement, task: null };
    shell.hidden = false;
    document.body.classList.add('pipeline-drawer-open');
    if (title) title.textContent = 'Loading task…';
    if (id) id.textContent = pipelineId;
    body.innerHTML = '<div class="pipeline-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading the full task record…</div>';
    const closeBtn = shell.querySelector('.pipeline-drawer-close');
    if (closeBtn) closeBtn.focus();
    try {
      const payload = await readProjection('dossier', `/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      if (!payload) return;
      const task = payload && payload.data ? payload.data.task : null;
      if (!task || state.drawer.pipelineId !== pipelineId) return;
      state.drawer.task = task;
      renderDrawer(task);
    } catch (error) {
      if (!state.drawer.open || state.drawer.pipelineId !== pipelineId) return;
      body.innerHTML = `<div class="pipeline-error"><i class="fas fa-circle-exclamation" aria-hidden="true"></i> ${escapeHtml(error.message || error)}</div>`;
    }
  }

  function metaRow(label, value) {
    return `<div class="pipeline-drawer-meta-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  async function copyTaskLink(pipelineId) {
    const url = new URL('/pipeline', window.location.origin);
    url.searchParams.set('task', String(pipelineId));
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      toast('error', 'Clipboard unavailable: your browser refused access to copy the task link.');
      return;
    }
    try {
      await navigator.clipboard.writeText(url.href);
      toast('success', 'Copied');
    } catch (error) {
      toast('error', `Could not copy the task link${error && error.name === 'NotAllowedError' ? ' (clipboard access was refused by the browser)' : ''}. You can open it directly: ${url.href}`);
    }
  }

  const { inferenceSummary, renderAttemptDossier } = window.PipelineAttemptDossier.create({ escapeHtml: (...args) => escapeHtml(...args), formatDate: (...args) => formatDate(...args), costEvidencePresentation: (...args) => costEvidencePresentation(...args), localEnergyPresentation: (...args) => localEnergyPresentation(...args), formatStatus: (...args) => formatStatus(...args), attemptOutcome: (...args) => attemptOutcome(...args), metaRow: (...args) => metaRow(...args), durationLabel: (...args) => durationLabel(...args) });

  function preserveDrawerDraft(body) {
    const fields = Array.from(body.querySelectorAll('input[name], textarea[name], select[name]'));
    return {
      scrollTop: body.scrollTop,
      fields: fields.map(el => ({ key: `${el.closest('form')?.dataset.drawerAction}:${el.name}`, value: el.value,
        checked: el.checked, focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd })),
      details: Array.from(body.querySelectorAll('details')).map(el => el.open)
    };
  }

  function latestTeamUpdate(task) {
    const entries = Array.isArray(task.feedback) ? task.feedback : [];
    const latest = task.status === 'blocked'
      ? entries.slice().reverse().find(entry => ['coding-team', 'guarded-dispatch', task.assignee].includes(entry.by)) || entries.at(-1)
      : entries.at(-1);
    const text = String(latest?.text || '');
    if (task.status === 'review' && text.startsWith('Dispatcher independent verification: PASS')) {
      return 'The worker submitted a change and the independent verification command passed. Review the implementation and its behavior before accepting. The full receipt is in the audit trail below.';
    }
    const question = text.match(/Worker question or problem \(not verification evidence\):\s*([\s\S]*?)\n\nThe worker feedback/);
    const message = (question ? question[1] : text).trim();
    return message.length > 1600 ? `${message.slice(0, 1600)}… Full details are in the audit trail below.` : message;
  }

  function restoreDrawerDraft(body, draft) {
    for (const el of body.querySelectorAll('input[name], textarea[name], select[name]')) {
      const saved = draft.fields.find(item => item.key === `${el.closest('form')?.dataset.drawerAction}:${el.name}`);
      if (!saved) continue;
      el.value = saved.value;
      if (typeof saved.checked === 'boolean') el.checked = saved.checked;
      if (saved.focused) {
        el.focus({ preventScroll: true });
        if (typeof saved.start === 'number' && typeof el.setSelectionRange === 'function') el.setSelectionRange(saved.start, saved.end);
      }
    }
    Array.from(body.querySelectorAll('details')).forEach((el, index) => { el.open = draft.details[index] || false; });
    body.scrollTop = draft.scrollTop;
  }

  const { renderDrawer } = window.PipelineDrawer.create({ drawerEls: (...args) => drawerEls(...args), preserveDrawerDraft: (...args) => preserveDrawerDraft(...args), state, readStorage: (...args) => readStorage(...args), STORAGE_REVIEWER, reviewContext: (...args) => reviewContext(...args), escapeHtml: (...args) => escapeHtml(...args), renderSupersedePreview: (...args) => renderSupersedePreview(...args), statusBadge: (...args) => statusBadge(...args), priorityChip: (...args) => priorityChip(...args), riskChip: (...args) => riskChip(...args), latestTeamUpdate: (...args) => latestTeamUpdate(...args), formatDate: (...args) => formatDate(...args), metaRow: (...args) => metaRow(...args), relativeTime: (...args) => relativeTime(...args), renderAttemptDossier: (...args) => renderAttemptDossier(...args), restoreDrawerDraft: (...args) => restoreDrawerDraft(...args) });

  async function refreshDrawerTask({ preserveDraft = false } = {}) {
    const pipelineId = state.drawer.pipelineId;
    if (!pipelineId || (preserveDraft && state.drawer.mutating)) return;
    try {
      const payload = await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      const task = payload && payload.data ? payload.data.task : null;
      if (task && state.drawer.pipelineId === pipelineId && !(preserveDraft && state.drawer.mutating)) {
        state.drawer.task = task;
        renderDrawer(task, { preserveDraft });
      }
    } catch { /* the list refresh below still reflects truth */ }
  }

  /**
   * Preview panel for a pending supersede decision: the exact transition,
   * every server-side check, and explicit confirm / cancel controls. Rendered
   * only while a preview is held in drawer state; nothing has been applied.
   */
  function renderSupersedePreview(task) {
    const preview = state.drawer.supersede?.preview;
    if (!preview || state.drawer.supersede.pipelineId !== task.pipelineId) return '';
    const t = preview.transition || {};
    const checks = Array.isArray(preview.checks) ? preview.checks : [];
    return `
      <div class="pipeline-drawer-action pipeline-supersede-preview" data-supersede-preview="${preview.ok ? 'ok' : 'blocked'}">
        <p><strong>Preview</strong> — nothing has changed yet.</p>
        <p><code>#${escapeHtml(t.pipelineId || task.pipelineId)}</code> ${escapeHtml(t.from || task.status)} → <strong>${escapeHtml(t.to || 'done')}</strong> · superseded by <code>#${escapeHtml(t.resolution?.supersededBy || '')}</code> · decided by ${escapeHtml(t.resolution?.by || '')}<br>
        ${t.keepsAssignee ? `Owner ${escapeHtml(t.keepsAssignee)} stays on record. ` : ''}${t.clearsHeartbeat ? 'The heartbeat is cleared. ' : ''}No re-queue. Reopen ${escapeHtml(t.reopen || 'only deliberately')}.</p>
        <ul class="pipeline-supersede-checks">
          ${checks.map((check) => `<li data-check="${escapeHtml(check.id)}" data-ok="${check.ok ? 'true' : 'false'}"><i class="fas ${check.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i> ${escapeHtml(check.id.replace(/_/g, ' '))}: ${escapeHtml(check.detail || '')}</li>`).join('')}
        </ul>
        <div class="pipeline-drawer-action-row">
          <form data-drawer-action="supersede-confirm" style="display:inline">
            <button type="submit" class="pipeline-btn primary compact" ${preview.ok ? '' : 'disabled'}><i class="fas fa-check"></i><span>Confirm supersede</span></button>
          </form>
          <button type="button" class="pipeline-btn compact" data-drawer-action="supersede-cancel"><i class="fas fa-xmark"></i><span>Cancel</span></button>
        </div>
      </div>`;
  }

  async function handleDrawerAction(action, form) {
    const pipelineId = state.drawer.pipelineId;
    if (!pipelineId || state.drawer.mutating) return;
    state.drawer.mutating = true;
    const submit = form?.querySelector('button[type="submit"]');
    const submitLabel = submit?.innerHTML;
    if (submit) submit.disabled = true;
    try {
      if (action === 'give-to-team' || action === 'reply-resume') {
        if (submit) submit.textContent = 'Handing task to the team…';
        const answer = action === 'reply-resume' ? String(new FormData(form).get('answer') || '').trim() : '';
        await giveTaskToTeam(pipelineId, answer);
      } else if (action === 'supersede-preview') {
        const data = new FormData(form);
        const supersededBy = String(data.get('supersededBy') || '').trim();
        const reason = String(data.get('reason') || '').trim();
        const by = String(data.get('by') || '').trim();
        if (!supersededBy || !reason || !by) return;
        writeStorage(STORAGE_REVIEWER, by);
        const payload = await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/supersede`, {
          method: 'POST',
          body: JSON.stringify({ supersededBy, reason, by })
        });
        const preview = payload && payload.data ? payload.data : null;
        state.drawer.supersede = { pipelineId, supersededBy, reason, by, preview };
        if (state.drawer.task) renderDrawer(state.drawer.task);
        toast(preview?.ok ? 'info' : 'error', preview?.ok
          ? `Preview ready for task ${pipelineId}; confirm or cancel.`
          : `Supersede blocked: ${(preview?.blocked || []).join(', ') || 'checks failed'}.`);
        return;
      } else if (action === 'supersede-cancel') {
        state.drawer.supersede = null;
        if (state.drawer.task) renderDrawer(state.drawer.task);
        return;
      } else if (action === 'supersede-confirm') {
        const pending = state.drawer.supersede;
        if (!pending || pending.pipelineId !== pipelineId || !pending.preview?.ok) return;
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/supersede`, {
          method: 'POST',
          body: JSON.stringify({ supersededBy: pending.supersededBy, reason: pending.reason, by: pending.by, confirm: true })
        });
        state.drawer.supersede = null;
        toast('success', `Task ${pipelineId} superseded by ${pending.supersededBy}.`);
      } else if (action === 'confirm-done') {
        const by = String(new FormData(form).get('by') || '').trim();
        if (!by) return;
        writeStorage(STORAGE_REVIEWER, by);
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'done', by })
        });
        toast('success', `Task ${pipelineId} confirmed done by ${by}.`);
      } else if (action === 'request-correction') {
        const data = new FormData(form);
        const by = String(data.get('by') || '').trim();
        const reason = String(data.get('reason') || '').trim();
        if (!by || !reason) return;
        if (normalizedIdentity(by) === normalizedIdentity(state.drawer.task?.assignee)) {
          throw new Error('The reviewer identity must differ from the worker.');
        }
        writeStorage(STORAGE_REVIEWER, by);
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/feedback`, {
          method: 'POST',
          body: JSON.stringify({ text: `Correction requested: ${reason}`, by })
        });
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'queued', by })
        });
        toast('success', `Correction requested for task ${pipelineId}; it is back in the guarded queue.`);
        if (state.drawer.task?.automation?.mode === 'review_only') await giveTaskToTeam(pipelineId);
      } else if (action === 'requeue') {
        const ok = window.confirm(`Release task ${pipelineId} back to the queue? Its worker claim and heartbeat will be cleared.`);
        if (!ok) return;
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'queued' })
        });
        toast('success', `Task ${pipelineId} released back to the queue.`);
      } else if (action === 'add-note') {
        const text = String(new FormData(form).get('text') || '').trim();
        if (!text) return;
        const by = readStorage(STORAGE_REVIEWER) || 'pipeline-ui';
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/feedback`, {
          method: 'POST',
          body: JSON.stringify({ text, by })
        });
        toast('success', `Note added to task ${pipelineId}.`);
      }
      await refreshDrawerTask();
      await loadTasks({ silent: true });
    } catch (error) {
      toast('error', error.message || String(error));
    } finally {
      state.drawer.mutating = false;
      if (submit?.isConnected) { submit.disabled = false; submit.innerHTML = submitLabel; }
    }
  }

  async function giveTaskToTeam(pipelineId, answer = '') {
    toast('info', 'Preparing this task for the team…');
    const payload = await fetchJson('/api/runtime-bridges/coding-dispatch/prepare', {
      method: 'POST', body: JSON.stringify({ pipelineId, answer })
    });
    if (!payload?.data?.ready) {
      toast('info', payload?.data?.question || 'The team left an update on this ticket.');
      return;
    }
    await state.launchController.refresh();
    if (!await state.launchController.launch(pipelineId)) throw new Error('The task is prepared. The worker is busy or admission changed; use Run one task when available.');
    toast('success', `Task ${pipelineId} handed to the team.`);
  }

  // ---------------------------------------------------------------------------
  // Loading + auto refresh
  // ---------------------------------------------------------------------------

  function setLoading(loading) {
    state.loading = loading;
    const btn = $('pipelineRefreshBtn');
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<i class="fas fa-spinner fa-spin"></i><span>Loading</span>'
      : '<i class="fas fa-rotate"></i><span>Refresh</span>';
  }

  function renderError(error) {
    setPageState('blocked', 'fa-circle-exclamation', state.tasks.length ? 'Task refresh failed · last observation retained' : 'Pipeline unreachable', String(error.message || error));
    if (state.tasks.length) return;
    $('pipelineProgression').innerHTML = '<div class="pipeline-empty">Task evidence unavailable. <button class="pipeline-btn compact" data-retry-load>Retry tasks</button></div>';
    const rows = $('pipelineOpenRows');
    if (rows) {
      rows.innerHTML = `<tr><td colspan="8" class="pipeline-error">${escapeHtml(error.message || error)} <button type="button" class="pipeline-btn compact" data-retry-load><i class="fas fa-rotate"></i><span>Retry</span></button></td></tr>`;
    }
    const done = $('pipelineDoneList');
    if (done) {
      done.innerHTML = `<div class="pipeline-error">${escapeHtml(error.message || error)}</div>`;
    }
  }

  function renderAll() {
    renderContext();
    renderCounts();
    if (state.taskError) renderError(state.taskError); else summarizeState();
    renderEvidence();
    renderFilterOptions();
    renderFilterControls();
    renderOpenWork();
    renderProgression();
    renderAttention();
    renderRecentlyDone();
    renderDispatchControl();
  }

  async function loadTasks({ auxiliary = true } = {}) {
    const version = ++state.taskReadVersion;
    setLoading(true);
    state.attention?.refresh();
    if (auxiliary) {
      loadTeamPerformance();
      loadDeliveryStatus();
      loadDispatchControlStatus();
    }
    try {
      const payload = await readProjection('tasks', '/api/pipeline/tasks?limit=1000&view=summary&includeDone=true');
      if (!payload) return;
      const normalized = normalizePayload(payload);
      state.tasks = normalized.tasks;
      state.summary = normalized.summary;
      state.evidence = normalized.evidence;
      state.taskError = null;
      renderAll();
      await refreshDrawerTask({ preserveDraft: true });
      if (state.deepLinkedTask) {
        const pipelineId = state.deepLinkedTask;
        state.deepLinkedTask = null;
        openDrawer(pipelineId, null);
      }
    } catch (error) {
      if (version === state.taskReadVersion) { state.taskError = error; renderError(error); }
    } finally {
      if (version === state.taskReadVersion) setLoading(false);
    }
  }

  function setAutoRefresh(enabled) {
    const btn = $('pipelineAutoBtn');
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    if (enabled) {
      state.autoTimer = window.setInterval(() => { if (!document.hidden) loadTasks({ silent: true }); }, AUTO_REFRESH_MS);
    }
    if (btn) {
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.classList.toggle('active', enabled);
    }
    writeStorage(STORAGE_AUTO, enabled ? '1' : '0');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function clearFilters() {
    state.filters = { status: null, search: '', service: '', lane: '', epic: '' };
    if ($('pipelineEpicFilter')) $('pipelineEpicFilter').value = '';
    const search = $('pipelineSearch');
    if (search) search.value = '';
    const service = $('pipelineServiceFilter');
    if (service) service.value = '';
    const lane = $('pipelineLaneFilter');
    if (lane) lane.value = '';
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', () => {
    let storage;
    try { storage = window.localStorage; } catch { /* Host receipts support reload recovery without storage. */ }
    state.attention = window.PipelineAttention && new window.PipelineAttention.Controller({
      fetchJson: url => readProjection('attention', url), filters: { filters: state.filters, context: state.context },
      onChange: summarizeState,
      elements: Object.fromEntries(['list', 'meta', 'pager', 'scopes', 'notes', 'live'].map(key => [key, $(`pipelineAttention${key[0].toUpperCase()}${key.slice(1)}`)])),
    });
    state.launchController = new window.PipelineLaunchController({
      request: fetchJson, storage, onChange: renderDispatchControl,
      refreshTasks: () => loadTasks({ auxiliary: false })
    });
    $('pipelineTeamLaunchRefresh')?.addEventListener('click', () => {
      loadDispatchControlStatus();
      loadTasks({ auxiliary: false });
    });
    $('pipelineTeamLaunchRetry')?.addEventListener('click', () => state.launchController.retry());
    window.addEventListener('pagehide', event => { if (!event.persisted) state.launchController.dispose(); });
    const refresh = $('pipelineRefreshBtn');
    if (refresh) refresh.addEventListener('click', () => loadTasks());

    const autoBtn = $('pipelineAutoBtn');
    if (autoBtn) {
      autoBtn.addEventListener('click', () => {
        setAutoRefresh(autoBtn.getAttribute('aria-pressed') !== 'true');
      });
    }

    const teamWindow = $('pipelineTeamWindow');
    if (teamWindow) {
      teamWindow.value = state.performanceWindow;
      teamWindow.addEventListener('change', () => {
        state.performanceWindow = teamWindow.value;
        loadTeamPerformance();
      });
    }

    const launchSelect = $('pipelineTeamLaunchTask');
    const launchConfirm = $('pipelineTeamLaunchConfirm');
    const launchForm = $('pipelineTeamLaunchForm');
    if (launchSelect) launchSelect.addEventListener('change', () => {
      if (launchConfirm) launchConfirm.checked = false;
      renderDispatchControl();
    });
    if (launchConfirm) launchConfirm.addEventListener('change', renderDispatchControl);
    if (launchForm) launchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      launchOneTask();
    });

    document.querySelectorAll('.pipeline-metric[data-status-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.statusFilter;
        state.filters.status = state.filters.status === status ? null : status;
        renderAll();
        $('pipelineOverview').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        $('pipelineProgression').focus({ preventScroll: true });
      });
    });

    const search = $('pipelineSearch');
    if (search) {
      search.addEventListener('input', () => {
        state.filters.search = search.value.trim();
        renderAll();
      });
    }

    const service = $('pipelineServiceFilter');
    if (service) {
      service.addEventListener('change', () => {
        state.filters.service = service.value;
        renderAll();
      });
    }

    const lane = $('pipelineLaneFilter');
    if (lane) {
      lane.addEventListener('change', () => {
        state.filters.lane = lane.value;
        renderAll();
      });
    }

    const sort = $('pipelineSort');
    if (sort) {
      sort.addEventListener('change', () => {
        state.sort = sort.value;
        renderAll();
      });
    }

    $('pipelineEpicFilter')?.addEventListener('change', (event) => { state.filters.epic = event.target.value; state.expandedStages.clear(); renderAll(); });
    $('pipelineIncludeDone')?.addEventListener('change', (event) => { state.includeDone = event.target.checked; renderProgression(); });
    document.querySelectorAll('[data-pipeline-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.pipelineView; renderProgression(); }));
    $('pipelineProgression')?.addEventListener('click', (event) => {
      const more = event.target.closest('[data-more-stage]');
      if (more) { state.expandedStages.add(more.dataset.moreStage); renderProgression(); }
      if (event.target.closest('[data-more-events]')) { state.timelineLimit += 60; renderProgression(); }
    });
    const clear = $('pipelineClearFilters');
    if (clear) clear.addEventListener('click', clearFilters);

    document.addEventListener('click', (event) => {
      const copyLink = event.target.closest('[data-copy-task-link]');
      if (copyLink) { copyTaskLink(copyLink.dataset.copyTaskLink); return; }
      const edit = event.target.closest('[data-edit-pipeline-task]');
      if (edit) { window.PipelineTaskEditor.open(edit.dataset.editPipelineTask, state.tasks); return; }
      if (event.target.closest('#pipelineNewTask, [data-pipeline-new-task]')) { window.PipelineTaskEditor.open(null, state.tasks); return; }
      if (event.target.closest('[data-retry-delivery]')) { loadDeliveryStatus(); return; }
      const retry = event.target.closest('[data-retry-load]');
      if (retry) { loadTasks(); return; }
      const clearBtn = event.target.closest('[data-clear-filters]');
      if (clearBtn) { clearFilters(); return; }
      const closer = event.target.closest('[data-close-pipeline-drawer]');
      if (closer) { closeDrawer(); return; }
      const requeue = event.target.closest('button[data-drawer-action="requeue"]');
      if (requeue) { handleDrawerAction('requeue', null); return; }
      const cancelSupersede = event.target.closest('button[data-drawer-action="supersede-cancel"]');
      if (cancelSupersede) { handleDrawerAction('supersede-cancel', null); return; }
      const merge = event.target.closest('button[data-delivery-merge]');
      if (merge) { mergeDeliveryItem(merge); return; }
      const taskEl = event.target.closest('[data-pipeline-task]');
      if (taskEl) openDrawer(taskEl.dataset.pipelineTask, taskEl);
    });

    document.addEventListener('keydown', (event) => {
      if ($('pipelineTaskEditor')?.open) return;
      if (event.key === 'Escape' && state.drawer.open) {
        closeDrawer();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const row = event.target.closest && event.target.closest('tr[data-pipeline-task]');
        if (row) {
          event.preventDefault();
          openDrawer(row.dataset.pipelineTask, row);
        }
      }
    });

    document.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-drawer-action]');
      if (!form) return;
      event.preventDefault();
      handleDrawerAction(form.dataset.drawerAction, form);
    });

    document.addEventListener('pipeline-task-saved', async (event) => {
      await loadTasks();
      openDrawer(event.detail.pipelineId, $('pipelineNewTask'));
    });
    if (readStorage(STORAGE_AUTO) !== '0') setAutoRefresh(true);
    loadTasks();
  });
})();
