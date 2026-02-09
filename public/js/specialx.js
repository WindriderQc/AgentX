(function () {
  const REFRESH_MS = 15000;
  const MAX_BACKOFF_MS = 120000;

  const els = {
    runnerDot: document.getElementById('runnerDot'),
    runnerStatusText: document.getElementById('runnerStatusText'),
    runnerMeta: document.getElementById('runnerMeta'),
    metricQueued: document.getElementById('metricQueued'),
    metricRunning: document.getElementById('metricRunning'),
    metricSuccessRate: document.getElementById('metricSuccessRate'),
    metricLocalRatio: document.getElementById('metricLocalRatio'),
    tasksTableBody: document.getElementById('tasksTableBody'),
    tasksEmpty: document.getElementById('tasksEmpty'),
    tasksMeta: document.getElementById('tasksMeta'),
    runsTableBody: document.getElementById('runsTableBody'),
    runsEmpty: document.getElementById('runsEmpty'),
    runsMeta: document.getElementById('runsMeta'),
    runDetail: document.getElementById('runDetail'),
    hostSelect: document.getElementById('hostSelect'),
    setHostBtn: document.getElementById('setHostBtn'),
    activeHostText: document.getElementById('activeHostText'),
    taskTypeSelect: document.getElementById('taskTypeSelect'),
    taskPriority: document.getElementById('taskPriority'),
    taskPayload: document.getElementById('taskPayload'),
    enqueueTaskBtn: document.getElementById('enqueueTaskBtn'),
    startRunnerBtn: document.getElementById('startRunnerBtn'),
    stopRunnerBtn: document.getElementById('stopRunnerBtn'),
    tickRunnerBtn: document.getElementById('tickRunnerBtn')
  };

  const state = {
    tasks: [],
    runs: [],
    refreshInFlight: false,
    pollTimer: null,
    pollMs: REFRESH_MS,
    rateLimitedNotified: false
  };

  function notify(message, type = 'info') {
    if (window.toast && typeof window.toast[type] === 'function') {
      window.toast[type](message);
      return;
    }
    console[type === 'error' ? 'error' : 'log'](`[SpecialX] ${message}`);
  }

  function statusChip(status) {
    const safe = String(status || 'unknown');
    return `<span class="status-chip ${safe}">${safe.replace('_', ' ')}</span>`;
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  }

  function formatDuration(ms) {
    if (!ms || ms < 1) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    if (response.status === 401) {
      throw new Error('Authentication required. Please log in.');
    }

    let data = null;
    try {
      data = await response.json();
    } catch (_err) {
      throw new Error(`Invalid response from ${path}`);
    }

    if (!response.ok || data.status === 'error') {
      const error = new Error(data.message || `Request failed: ${response.status}`);
      error.status = response.status;
      error.retryAfter = data.retryAfter || response.headers.get('retry-after') || null;
      throw error;
    }

    return data;
  }

  function parseRetryAfterMs(value) {
    if (value == null) return null;

    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1e12) return Math.max(1000, value - Date.now()); // epoch ms
      if (value > 1e9) return Math.max(1000, (value * 1000) - Date.now()); // epoch sec
      return Math.max(1000, value * 1000); // seconds
    }

    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
      return parseRetryAfterMs(asNumber);
    }

    const parsedDate = Date.parse(value);
    if (!Number.isNaN(parsedDate)) {
      return Math.max(1000, parsedDate - Date.now());
    }

    return null;
  }

  function renderRunner(statusPayload) {
    const runner = statusPayload.runner || {};
    const active = Boolean(runner.active);

    els.runnerDot.classList.toggle('online', active);
    els.runnerStatusText.textContent = active ? 'Runner active' : 'Runner stopped';
    els.runnerMeta.textContent = `instance: ${runner.instanceId || '-'} • poll: ${runner.pollMs || '-'}ms`;
  }

  function renderRouting(routingPayload) {
    const options = routingPayload.hostOptions || [];
    const activeHost = routingPayload.activeHost || '-';
    const currentValue = els.hostSelect.value;

    els.hostSelect.innerHTML = '';
    options.forEach((host) => {
      const option = document.createElement('option');
      option.value = host.id;
      option.textContent = `${host.label} • ${host.url}`;
      els.hostSelect.appendChild(option);
    });

    if (!options.length) {
      const fallback = document.createElement('option');
      fallback.value = 'primary';
      fallback.textContent = 'Primary';
      els.hostSelect.appendChild(fallback);
    } else {
      const previousStillExists = options.some((host) => host.id === currentValue);
      if (previousStillExists) {
        els.hostSelect.value = currentValue;
      }
    }

    els.activeHostText.textContent = `active: ${activeHost}`;
  }

  function renderMetrics(statusPayload) {
    const queue = statusPayload.queue || {};
    const runs = statusPayload.runs || {};

    els.metricQueued.textContent = String(queue.queued || 0);
    els.metricRunning.textContent = String((queue.running || 0) + (queue.leased || 0));
    els.metricSuccessRate.textContent = `${runs.successRate || 0}%`;
    els.metricLocalRatio.textContent = `${runs.localFirstRatio || 0}%`;
  }

  function renderTasks(tasks) {
    state.tasks = tasks;
    els.tasksTableBody.innerHTML = '';
    els.tasksMeta.textContent = `${tasks.length} loaded`;

    if (!tasks.length) {
      els.tasksEmpty.hidden = false;
      return;
    }
    els.tasksEmpty.hidden = true;

    const rows = tasks.map((task) => `
      <tr>
        <td>${statusChip(task.status)}</td>
        <td>${task.type}</td>
        <td>${task.priority}</td>
        <td class="mono">${formatDate(task.createdAt)}</td>
      </tr>
    `).join('');

    els.tasksTableBody.innerHTML = rows;
  }

  function runDetailText(run) {
    return JSON.stringify({
      id: run._id,
      status: run.status,
      taskType: run.taskId?.type,
      specialX: run.specialXId?.name || null,
      summary: run.summary,
      execution: run.execution,
      metrics: run.metrics,
      output: run.output,
      artifacts: run.artifacts,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    }, null, 2);
  }

  async function loadRunDetail(runId) {
    if (!runId) return null;
    const detailRes = await api(`/api/specialx/runs/${encodeURIComponent(runId)}`);
    return detailRes.data || null;
  }

  function renderRuns(runs) {
    state.runs = runs;
    els.runsTableBody.innerHTML = '';
    els.runsMeta.textContent = `${runs.length} loaded`;

    if (!runs.length) {
      els.runsEmpty.hidden = false;
      return;
    }
    els.runsEmpty.hidden = true;

    const rows = runs.map((run, index) => `
      <tr data-run-index="${index}">
        <td>${statusChip(run.status)}</td>
        <td>${run.taskId?.type || '-'}</td>
        <td>${(run.summary || '-').slice(0, 120)}</td>
        <td class="mono">${formatDuration(run.metrics?.durationMs)}</td>
      </tr>
    `).join('');

    els.runsTableBody.innerHTML = rows;

    els.runsTableBody.querySelectorAll('tr[data-run-index]').forEach((row) => {
      row.addEventListener('click', async () => {
        const index = Number(row.getAttribute('data-run-index'));
        const run = state.runs[index];
        if (!run) return;
        els.runDetail.textContent = 'Loading run detail...';
        try {
          const fullRun = await loadRunDetail(run._id);
          els.runDetail.textContent = runDetailText(fullRun || run);
        } catch (_err) {
          els.runDetail.textContent = runDetailText(run);
        }
      });
    });
  }

  async function refreshDashboard() {
    const dashboardRes = await api('/api/specialx/dashboard?limit=15');
    const payload = dashboardRes.data || {};

    renderRunner(payload);
    renderRouting(payload.routing || {});
    renderMetrics(payload);
    renderTasks(payload.tasks?.tasks || []);
    renderRuns(payload.runs?.runs || []);
  }

  function scheduleRefresh(delayMs = state.pollMs) {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
    }

    state.pollTimer = setTimeout(() => {
      refreshLoop().catch((err) => {
        notify(err.message, 'error');
      });
    }, Math.max(500, delayMs));
  }

  async function refreshLoop() {
    if (state.refreshInFlight) {
      scheduleRefresh(state.pollMs);
      return;
    }

    state.refreshInFlight = true;
    try {
      await refreshDashboard();
      state.pollMs = REFRESH_MS;
      state.rateLimitedNotified = false;
    } catch (error) {
      if (error.status === 429) {
        const retryMs = parseRetryAfterMs(error.retryAfter) || Math.min(state.pollMs * 2, MAX_BACKOFF_MS);
        state.pollMs = Math.min(retryMs, MAX_BACKOFF_MS);
        if (!state.rateLimitedNotified) {
          notify('Rate-limited by API. Backing off polling temporarily.', 'error');
          state.rateLimitedNotified = true;
        }
      } else {
        notify(error.message, 'error');
      }
    } finally {
      state.refreshInFlight = false;
      scheduleRefresh(state.pollMs);
    }
  }

  async function enqueueTask(type, payload = {}) {
    const body = {
      type,
      priority: Number(els.taskPriority.value) || 5,
      input: payload
    };

    await api('/api/specialx/tasks', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async function enqueueFromComposer() {
    const type = els.taskTypeSelect.value;
    let payload = {};

    if (els.taskPayload.value.trim()) {
      try {
        payload = JSON.parse(els.taskPayload.value);
      } catch (_err) {
        notify('Payload must be valid JSON', 'error');
        return;
      }
    }

    await enqueueTask(type, payload);
    notify(`Task queued: ${type}`, 'info');
    await refreshDashboard();
  }

  async function callRunnerControl(path) {
    await api(path, { method: 'POST', body: JSON.stringify({}) });
    await refreshDashboard();
  }

  async function setActiveHost() {
    const host = els.hostSelect.value;
    await api('/api/specialx/routing/active-host', {
      method: 'POST',
      body: JSON.stringify({ host })
    });
    notify(`Active host switched to ${host}`, 'info');
    await refreshDashboard();
  }

  function wireEvents() {
    els.enqueueTaskBtn.addEventListener('click', () => {
      enqueueFromComposer().catch((err) => notify(err.message, 'error'));
    });

    document.querySelectorAll('.quick-enqueue').forEach((button) => {
      button.addEventListener('click', () => {
        const type = button.getAttribute('data-type');
        enqueueTask(type, {}).then(() => {
          notify(`Task queued: ${type}`);
          return refreshDashboard();
        }).catch((err) => notify(err.message, 'error'));
      });
    });

    els.startRunnerBtn.addEventListener('click', () => {
      callRunnerControl('/api/specialx/runner/start').catch((err) => notify(err.message, 'error'));
    });
    els.stopRunnerBtn.addEventListener('click', () => {
      callRunnerControl('/api/specialx/runner/stop').catch((err) => notify(err.message, 'error'));
    });
    els.tickRunnerBtn.addEventListener('click', () => {
      callRunnerControl('/api/specialx/runner/tick').catch((err) => notify(err.message, 'error'));
    });
    els.setHostBtn.addEventListener('click', () => {
      setActiveHost().catch((err) => notify(err.message, 'error'));
    });
  }

  async function init() {
    wireEvents();
    await refreshLoop();
  }

  init().catch((err) => {
    notify(err.message, 'error');
  });
})();
