(function () {
  'use strict';
  // Read-only view of agentx.pipeline-task-diagnosis/v1: why an active task is
  // not advancing, who owns the next step and which evidence is missing. It
  // offers no repair control. An escalation key is announced once per browser
  // session; later refreshes show it as already escalated.
  const TASK_SCHEMA = 'agentx.pipeline-task-diagnosis/v1';
  const LIST_SCHEMA = 'agentx.pipeline-task-diagnoses/v1';
  const STALE_MS = 120000;
  const PANEL_REFRESH_MS = 60000;
  const SEEN_KEY = 'agentx.pipeline.escalationsSeen';
  const CATEGORY = {
    execution_observed: ['Execution observed', 'fa-person-running', 'ok'],
    planned_wait: ['Planned wait', 'fa-hourglass-half', 'wait'],
    human_decision: ['Human decision', 'fa-user-check', 'human'],
    dependency: ['Dependency', 'fa-link', 'wait'],
    recovery_required: ['Recovery required', 'fa-life-ring', 'recovery'],
    unknown: ['State unknown', 'fa-circle-question', 'unknown'],
    closed: ['Closed', 'fa-circle-check', 'ok'],
  };
  const OWNER = { worker: 'Worker', human: 'Human', operator: 'Operator', dependency_owner: 'Dependency owners', none: 'Nobody' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const human = value => String(value || 'unknown').replace(/_/g, ' ');
  const when = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : ''; };

  let seen;
  function seenKeys() {
    if (seen) return seen;
    try { seen = new Set(JSON.parse(window.sessionStorage.getItem(SEEN_KEY) || '[]')); } catch { seen = new Set(); }
    return seen;
  }
  // Returns true only the first time this browser session sees the key.
  function firstSighting(key) {
    const keys = seenKeys();
    if (!key || keys.has(key)) return false;
    keys.add(key);
    try { window.sessionStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-200))); } catch { /* per-page memory still dedupes */ }
    return true;
  }

  function validTask(value, id) {
    return value?.schema === TASK_SCHEMA && (!id || value.pipelineId === id) && CATEGORY[value.category]
      && typeof value.code === 'string' && Array.isArray(value.missingEvidence);
  }

  function escalationLine(diagnosis, fresh) {
    if (!diagnosis.escalation?.key) return '';
    const since = diagnosis.escalation.since ? ` since ${esc(when(diagnosis.escalation.since))}` : '';
    return `<p class="pipeline-stall-escalation" data-escalation-key="${esc(diagnosis.escalation.key)}"><i class="fas fa-bell" aria-hidden="true"></i> ${fresh ? 'New escalation' : 'Escalated earlier — not repeated'}${since} · <code>${esc(diagnosis.escalation.key)}</code></p>`;
  }

  function body(diagnosis, { fresh = false } = {}) {
    const [label, icon, tone] = CATEGORY[diagnosis.category];
    const worker = diagnosis.worker ? `<div><dt>Worker</dt><dd>Heartbeat ${esc(human(diagnosis.worker.heartbeat))}${diagnosis.worker.heartbeatAt ? ` (${esc(when(diagnosis.worker.heartbeatAt))})` : ''} · state ${esc(human(diagnosis.worker.state))}</dd></div>` : '';
    const lease = diagnosis.lease ? `<div><dt>Lease</dt><dd>${esc(human(diagnosis.lease.state))}${diagnosis.lease.expiresAt ? ` · expiry ${esc(when(diagnosis.lease.expiresAt))}` : ''}${diagnosis.lease.ref ? ` · <code>${esc(diagnosis.lease.ref)}</code>` : ''}</dd></div>` : '';
    const deps = Array.isArray(diagnosis.dependencies) && diagnosis.dependencies.length
      ? `<div><dt>Dependencies</dt><dd>${diagnosis.dependencies.map(row => `<code>${esc(row.pipelineId)}</code> ${esc(human(row.status))}`).join(' · ')}</dd></div>` : '';
    const missing = diagnosis.missingEvidence.length
      ? `<ul class="pipeline-stall-missing">${diagnosis.missingEvidence.map(item => `<li>${esc(item.label || human(item.code))}</li>`).join('')}</ul>` : '<p class="pipeline-muted">No missing evidence is named.</p>';
    return `<div class="pipeline-stall-result tone-${tone}">
      <p class="pipeline-stall-head"><i class="fas ${icon}" aria-hidden="true"></i> <strong>${esc(label)}</strong> · ${esc(human(diagnosis.code))}</p>
      <p>${esc(diagnosis.summary)}</p>
      ${escalationLine(diagnosis, fresh)}
      <dl class="pipeline-stall-facts">
        <div><dt>Owner</dt><dd>${esc(OWNER[diagnosis.owner] || human(diagnosis.owner))}</dd></div>
        <div><dt>Next step</dt><dd>${esc(diagnosis.action)}</dd></div>
        ${worker}${lease}${deps}
        ${diagnosis.overdueSince ? `<div><dt>Overdue</dt><dd>Since ${esc(when(diagnosis.overdueSince))}</dd></div>` : ''}
      </dl>
      <p class="pipeline-stall-subhead">Missing evidence</p>${missing}
      <p class="pipeline-muted">${esc(diagnosis.runtime?.boundary || '')} This diagnosis changes nothing; corrections use the guarded task actions.</p>
    </div>`;
  }

  async function fetchJson(url, signal) {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'This task no longer exists.' : 'The diagnosis could not be read. Refresh to try again.');
    return (await response.json())?.data;
  }
  function stamp(value) {
    const time = Date.parse(value?.observedAt);
    const stale = !Number.isFinite(time) || Date.now() - time > STALE_MS;
    return `<small class="pipeline-stall-stamp">${stale ? 'Observation may be outdated — refresh.' : `Observed ${esc(when(value.observedAt))}`}</small>`;
  }

  // ---- Dossier panel -------------------------------------------------------
  const requests = new WeakMap();
  function markup(task) {
    if (!/^\d{3,4}$/.test(String(task?.pipelineId || '')) || task.status === 'done') return '';
    // Private lanes keep their own workflow; the engineering diagnosis does not apply.
    if (/^\s*(personal|family|household|secretary)\s*$/i.test(String(task.service || ''))
      || /^\s*(idea-drop\s*$|household-)/i.test(String(task.source || ''))) return '';
    return `<details class="pipeline-stall-task" data-stall-task="${esc(task.pipelineId)}"><summary>Why is this task not advancing?</summary>
      <div data-stall-result role="status" aria-live="polite"><p class="pipeline-muted">Open to read the current diagnosis.</p></div>
      <button type="button" class="pipeline-btn compact" data-refresh-stall>Refresh diagnosis</button></details>`;
  }
  async function refreshTask(panel) {
    requests.get(panel)?.abort();
    const controller = new AbortController(); requests.set(panel, controller);
    const result = panel.querySelector('[data-stall-result]'), button = panel.querySelector('[data-refresh-stall]');
    const previous = result.querySelector('.pipeline-stall-result');
    result.setAttribute('aria-busy', 'true'); button.disabled = true;
    if (!previous) result.innerHTML = '<p class="pipeline-muted">Reading the diagnosis…</p>';
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const diagnosis = (await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(panel.dataset.stallTask)}/diagnosis`, controller.signal))?.diagnosis;
      if (requests.get(panel) !== controller || !panel.isConnected) return;
      if (!validTask(diagnosis, panel.dataset.stallTask)) throw new Error('The diagnosis has an unknown shape; the task state stays unknown.');
      result.innerHTML = body(diagnosis, { fresh: firstSighting(diagnosis.escalation?.key) }) + stamp(diagnosis);
    } catch (error) {
      if (requests.get(panel) !== controller) return;
      const message = controller.signal.aborted ? 'The diagnosis timed out. Refresh to try again.' : error.message;
      result.innerHTML = `<p class="pipeline-stall-error">${esc(message)}${previous ? ' The last observation is kept below.' : ''}</p>${previous ? previous.outerHTML : ''}`;
    } finally {
      clearTimeout(timer);
      if (requests.get(panel) === controller) { result.removeAttribute('aria-busy'); button.disabled = false; }
    }
  }

  // ---- Page panel ----------------------------------------------------------
  let listRequest = null;
  let listTimer = null;
  function row(diagnosis, fresh) {
    const [label, icon, tone] = CATEGORY[diagnosis.category];
    return `<li class="pipeline-stall-item tone-${tone}">
      <button type="button" class="pipeline-stall-open" data-pipeline-task="${esc(diagnosis.pipelineId)}" aria-label="Open task ${esc(diagnosis.pipelineId)} dossier: ${esc(label)}">
        <i class="fas ${icon}" aria-hidden="true"></i><span><strong>#${esc(diagnosis.pipelineId)} · ${esc(label)}</strong> ${esc(diagnosis.summary)}</span></button>
      <p><span class="pipeline-stall-owner">${esc(OWNER[diagnosis.owner] || human(diagnosis.owner))}</span> ${esc(diagnosis.action)}</p>
      ${diagnosis.missingEvidence.length ? `<p class="pipeline-muted">Missing: ${diagnosis.missingEvidence.map(item => esc(item.label || human(item.code))).join('; ')}</p>` : ''}
      ${escalationLine(diagnosis, fresh)}
    </li>`;
  }
  async function refreshList() {
    const panel = document.getElementById('pipelineStallDiagnosis');
    if (!panel) return;
    listRequest?.abort();
    const controller = new AbortController(); listRequest = controller;
    const list = panel.querySelector('[data-stall-list]'), meta = panel.querySelector('[data-stall-meta]'), live = panel.querySelector('[data-stall-live]');
    list.setAttribute('aria-busy', 'true');
    if (!list.querySelector('li')) list.innerHTML = '<p class="pipeline-empty">Reading task diagnoses…</p>';
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const value = (await fetchJson('/api/pipeline/diagnosis?limit=25', controller.signal))?.diagnoses;
      if (listRequest !== controller) return;
      if (value?.schema !== LIST_SCHEMA || !Array.isArray(value.items) || !value.counts) throw new Error('The diagnosis list has an unknown shape.');
      const items = value.items.filter(item => validTask(item));
      const newKeys = items.filter(item => firstSighting(item.escalation?.key)).map(item => item.escalation.key);
      const counts = Object.entries(value.counts).filter(([, count]) => count > 0).map(([category, count]) => `${count} ${CATEGORY[category]?.[0].toLowerCase() || human(category)}`);
      meta.innerHTML = `${esc(counts.join(' · ') || 'No active task')}${value.truncated || value.scope?.scanTruncated ? ' · list truncated' : ''} · ${stamp(value)}`;
      list.innerHTML = items.length ? `<ul>${items.map(item => row(item, newKeys.includes(item.escalation?.key))).join('')}</ul>`
        : '<p class="pipeline-empty"><i class="fas fa-circle-check" aria-hidden="true"></i> No active task waits on a decision, a dependency or a recovery.</p>';
      if (newKeys.length) live.textContent = `${newKeys.length} new escalation${newKeys.length === 1 ? '' : 's'} to inspect.`;
      if (items.length !== value.items.length) list.insertAdjacentHTML('afterbegin', '<p class="pipeline-stall-error">Some diagnoses have an unknown shape and are not shown.</p>');
    } catch (error) {
      if (listRequest !== controller) return;
      const kept = list.querySelector('ul');
      const message = controller.signal.aborted ? 'The diagnosis read timed out.' : error.message;
      list.querySelector('.pipeline-stall-error')?.remove();
      list.insertAdjacentHTML('afterbegin', `<p class="pipeline-stall-error">${esc(message)}${kept ? ' Last observation retained.' : ''}</p>`);
      if (!kept) { list.querySelector('.pipeline-empty')?.remove(); meta.textContent = 'Current diagnosis unavailable.'; }
    } finally {
      clearTimeout(timer);
      if (listRequest === controller) list.removeAttribute('aria-busy');
    }
  }
  function scheduleList() {
    const panel = document.getElementById('pipelineStallDiagnosis');
    if (!panel?.open) { clearInterval(listTimer); listTimer = null; return; }
    if (listTimer) return;
    refreshList();
    listTimer = setInterval(() => { if (!document.hidden && panel.open) refreshList(); }, PANEL_REFRESH_MS);
  }

  document.addEventListener('toggle', event => {
    if (event.target.matches?.('[data-stall-task]') && event.target.open) refreshTask(event.target);
    if (event.target.id === 'pipelineStallDiagnosis') scheduleList();
  }, true);
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-refresh-stall]');
    if (button) refreshTask(button.closest('[data-stall-task]'));
    if (event.target.closest?.('[data-refresh-stall-list], #pipelineRefreshBtn') && document.getElementById('pipelineStallDiagnosis')?.open) refreshList();
  });
  document.addEventListener('DOMContentLoaded', scheduleList);
  window.PipelineStallDiagnosis = { markup, refreshList };
})();
