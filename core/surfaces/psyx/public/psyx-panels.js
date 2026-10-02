'use strict';

// PsyX panels: conversation restore, PsyX state items, routing, sessions list
// and the state/experiments panels. Classic script loaded before app.js; it only
// declares functions, which read app.js's shared constants when called.

async function restoreConversation(conversationId = state.conversationId) {
  if (!conversationId) return;
  try {
    const conversation = await api(`/api/psyx/sessions/${encodeURIComponent(conversationId)}`);
    if (conversation.promptName && conversation.promptName !== 'psyx') throw new Error('Saved conversation is not a PsyX session');
    if (conversation.lifecycle?.status === 'archived') {
      startNewSession(false);
      return;
    }
    state.conversationId = String(conversationId);
    localStorage.setItem(STORAGE_KEY, state.conversationId);
    state.history = normalizeConversationMessages(conversation.messages);
    clearRenderedConversation();
    for (const item of state.history) addMessage(item.role, item.content);
    updateContextStatus();
    sessionLabel.textContent = conversation.title || `Session ${state.conversationId.slice(-8)}`;
    highlightActiveSession();
  } catch (error) {
    if (error.code !== 'PSYX_LOCKED') console.warn('PsyX session restore skipped', error);
    if (state.unlocked) startNewSession(false);
  }
}

async function loadPsyXState() {
  state.psyxState = await api('/api/psyx/state');
  renderPsyXState();
}

async function addStateItem(key, text, extra = {}) {
  stateSaveStatus.textContent = 'saving…';
  try {
    const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify({ text, ...extra })
    });
    state.psyxState = result.state;
    renderPsyXState();
    stateSaveStatus.textContent = `synced · r${state.psyxState.revision ?? 0}`;
  } catch (error) {
    stateSaveStatus.textContent = 'save failed';
    throw error;
  }
}

async function removeStateItem(key, id) {
  stateSaveStatus.textContent = 'saving…';
  const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.psyxState = result.state;
  renderPsyXState();
  stateSaveStatus.textContent = `synced · r${state.psyxState.revision ?? 0}`;
}

async function loadRouting() {
  try {
    state.routing = await api('/api/psyx/routing');
    renderRoutingDetails();
    updateBrainRouting();
  } catch (error) {
    console.warn('Routing config unavailable', error);
    $('routingDetails').textContent = 'Inference routing details are unavailable.';
  }
}

function getLaneConfig(depth = state.depth) {
  const taskType = depth === 'deep' ? 'deep_reasoning' : 'analysis';
  const entry = state.routing?.taskConfigState?.[taskType]?.effective || state.routing?.taskModels?.[taskType] || null;
  return { taskType, entry };
}

function updateBrainRouting(lastResult = null) {
  const { taskType, entry } = getLaneConfig();
  const routing = lastResult?.routing || {};
  const model = routing.routedModel || lastResult?.model || entry?.model || 'model unresolved';
  const host = routing.routedHost || entry?.host || 'host unresolved';
  brainRoute.textContent = `${model} @ ${host}`;
  brainModel.textContent = model;
  brainHost.textContent = String(host).toUpperCase();
  routeLabel.textContent = `${currentDepthInfo().title || state.depth} · ${model}${host ? ` @ ${host}` : ''}`;
  brainRoute.dataset.taskType = taskType;
}

function renderRoutingDetails() {
  const normal = getLaneConfig('normal');
  const deep = getLaneConfig('deep');
  $('routingDetails').innerHTML = `
    <div class="route-row"><span>Normal</span><strong>${escapeHtml(normal.entry?.model || '—')}</strong><em>${escapeHtml(normal.entry?.host || '—')}</em><small>technical lane: analysis</small></div>
    <div class="route-row"><span>Deep</span><strong>${escapeHtml(deep.entry?.model || '—')}</strong><em>${escapeHtml(deep.entry?.host || '—')}</em><small>technical lane: deep_reasoning</small></div>
    <p class="state-help">Mode controls the psychological stance. These technical lanes only choose the inference substrate.</p>
  `;
}

function selectSessionStatus(status) {
  state.sessionStatus = status === 'archived' ? 'archived' : 'active';
  for (const item of document.querySelectorAll('[data-session-status]')) {
    item.setAttribute('aria-pressed', String(item.dataset.sessionStatus === state.sessionStatus));
  }
}

async function loadSessions() {
  try {
    state.sessions = await api(`/api/psyx/sessions?limit=30&status=${encodeURIComponent(state.sessionStatus)}`);
    renderSessions();
  } catch (error) { if (error.code !== 'PSYX_LOCKED') throw error; }
}

function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.round(diff / 60000);
  if (minutes < 2) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString();
}

function renderSessions() {
  const list = $('sessionsList');
  if (!state.sessions.length) {
    list.innerHTML = `<div class="panel-empty">No ${escapeHtml(state.sessionStatus)} PsyX sessions.</div>`;
    return;
  }
  list.innerHTML = state.sessions.map((item) => `
    <article class="session-card ${String(item.id) === state.conversationId ? 'active' : ''}" data-session-id="${escapeHtml(item.id)}">
      <button class="session-open" type="button" ${state.sessionStatus === 'archived' ? `data-session-options="${escapeHtml(item.id)}"` : `data-session-open="${escapeHtml(item.id)}"`}>
        <strong>${escapeHtml(item.title || 'PsyX conversation')}</strong>
        <span>${escapeHtml(item.preview || 'No preview')}</span>
        <small>${state.sessionStatus === 'archived' ? 'Archived · ' : ''}${escapeHtml(relativeDate(item.updatedAt))}${item.model ? ` · ${escapeHtml(item.model)}` : ''}${item.promptVersion ? ` · prompt v${escapeHtml(item.promptVersion)}` : ''}</small>
      </button>
      <div class="session-actions">
        <button type="button" data-session-rename="${escapeHtml(item.id)}" aria-label="Rename session">✎</button>
        <button type="button" data-session-options="${escapeHtml(item.id)}" aria-label="Session options">•••</button>
      </div>
    </article>
  `).join('');
}

function highlightActiveSession() {
  for (const node of document.querySelectorAll('.session-card')) node.classList.toggle('active', node.dataset.sessionId === state.conversationId);
}

function stateItemMeta(item) {
  const bits = [];
  if (item.source) bits.push(item.source);
  if (Number.isFinite(item.confidence)) bits.push(`${Math.round(item.confidence * 100)}%`);
  if (item.status && item.status !== 'active') bits.push(item.status);
  return bits.join(' · ');
}

function renderStateItems(containerId, key) {
  const container = $(containerId);
  const values = state.psyxState?.[key] || [];
  if (!values.length) {
    container.innerHTML = '<div class="state-empty">Nothing captured yet.</div>';
    return;
  }
  container.innerHTML = values.map((item) => `
    <div class="state-item">
      <div><span>${escapeHtml(item.text)}</span>${stateItemMeta(item) ? `<small>${escapeHtml(stateItemMeta(item))}</small>` : ''}</div>
      <button type="button" data-state-remove="${escapeHtml(key)}" data-id="${escapeHtml(item.id)}" aria-label="Remove">×</button>
    </div>
  `).join('');
}

function renderExperiments() {
  const container = $('experimentsList');
  const experiments = state.psyxState?.experiments || [];
  if (!experiments.length) {
    container.innerHTML = '<div class="state-empty">No experiments yet. Create one when an insight is worth testing in real life.</div>';
    return;
  }
  container.innerHTML = experiments.slice().reverse().map((item) => `
    <article class="experiment-card">
      <div class="experiment-top">
        <span class="experiment-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
        <select data-experiment-status="${escapeHtml(item.id)}" aria-label="Experiment status">
          ${['planned', 'active', 'completed', 'abandoned'].map((status) => `<option value="${status}" ${status === item.status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
      </div>
      <strong>${escapeHtml(item.hypothesis || 'Experiment')}</strong>
      <p><b>Action:</b> ${escapeHtml(item.action || '—')}</p>
      ${item.expectedSignal ? `<p><b>Signal:</b> ${escapeHtml(item.expectedSignal)}</p>` : ''}
      <textarea data-experiment-result="${escapeHtml(item.id)}" rows="2" placeholder="What happened?">${escapeHtml(item.result || '')}</textarea>
      <button type="button" class="experiment-save" data-experiment-save="${escapeHtml(item.id)}">Save result</button>
    </article>
  `).join('');
}

function renderPsyXState() {
  renderStateItems('threadsList', 'activeThreads');
  renderStateItems('notesList', 'notes');
  renderStateItems('loopsList', 'openLoops');
  renderStateItems('patternsList', 'patterns');
  renderStateItems('hypothesesList', 'hypotheses');
  renderExperiments();
  stateSaveStatus.textContent = `synced · r${state.psyxState?.revision ?? 0}`;
}
