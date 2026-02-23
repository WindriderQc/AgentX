/**
 * Roundtable Dashboard — Main Module
 *
 * Manages live discussions, polling, history browsing, and transcript download.
 * Uses PollingController for tab-aware polling and apiClient for API calls.
 */

import { apiClient } from '../utils/api-client.js';
import { PollingController } from '../utils/polling-controller.js';

// ── Constants ────────────────────────────────────────────────────────

const POLL_INTERVAL_ACTIVE = 2500;
const HISTORY_PAGE_SIZE = 15;

const AGENT_CONFIG = {
  'devils-advocate': { icon: 'fa-fire',   label: "Devil's Advocate", color: '#f87171' },
  'pragmatist':      { icon: 'fa-wrench', label: 'Pragmatist',       color: '#fbbf24' },
  'visionary':       { icon: 'fa-eye',    label: 'Visionary',        color: '#7cf0ff' }
};

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   icon: 'fa-clock',            color: '#fbbf24' },
  running:   { label: 'Running',   icon: 'fa-spinner fa-spin',  color: '#7cf0ff' },
  completed: { label: 'Completed', icon: 'fa-circle-check',     color: '#4ade80' },
  failed:    { label: 'Failed',    icon: 'fa-circle-xmark',     color: '#f87171' },
  timeout:   { label: 'Timeout',   icon: 'fa-hourglass-end',    color: '#f87171' }
};

// Default model assignments (matching defaults.js)
const DEFAULT_MODELS = {
  'devils-advocate': 'qwen2.5:7b-instruct-q4_0',
  'pragmatist': 'deepseek-r1:8b',
  'visionary': 'qwen32b:perf',
  'synthesizer': 'qwen32b:perf'
};

const PANEL_CONFIG_STORAGE_KEY = 'roundtablePanelConfig';

// ── State ────────────────────────────────────────────────────────────

let activeRoundtableId = null;
let activeRoundtable = null;
let previousTurnCount = 0;
let historyPage = 0;
let historyTotal = 0;
let isStarting = false;
let poller = null;
let availableModels = [];

// ── DOM Refs (populated in init) ─────────────────────────────────────

const $ = {};

// ── Init ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  cacheDOM();
  wireEvents();
  loadAvailableModels();

  // Deep link: ?id=abc123
  const params = new URLSearchParams(window.location.search);
  const deepId = params.get('id');
  if (deepId) {
    loadRoundtable(deepId);
  }

  loadHistory();
});

function cacheDOM() {
  const ids = [
    'rtQuestionInput', 'rtRoundsSelect', 'rtStartBtn', 'rtInputStatus',
    'rtHostDA', 'rtHostPrag', 'rtHostVis', 'rtHostSynth',
    'rtModelDA', 'rtModelPrag', 'rtModelVis', 'rtModelSynth',
    'rtStatsRow', 'rtStatDuration', 'rtStatTurns', 'rtStatAvgTps', 'rtStatStatus',
    'rtDiscussionPanel', 'rtDiscussionTitle', 'rtDiscussionMeta',
    'rtTurnsContainer', 'rtSynthesisContainer', 'rtTranscriptActions',
    'rtDownloadTranscript', 'rtNewDiscussion',
    'rtHistoryList', 'rtPagination', 'rtRefreshHistory'
  ];
  for (const id of ids) {
    $[id] = document.getElementById(id);
  }
}

function wireEvents() {
  $.rtStartBtn.addEventListener('click', handleStart);
  $.rtDownloadTranscript.addEventListener('click', handleDownloadTranscript);
  $.rtNewDiscussion.addEventListener('click', handleNewDiscussion);
  $.rtRefreshHistory.addEventListener('click', () => loadHistory());

  // Enter to start (only when not shift+enter)
  $.rtQuestionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleStart();
    }
  });
}

// ── Model & Host Loading ─────────────────────────────────────────────

let hostsData = []; // [{ id, name, url, available, models: [] }]

const AGENT_SELECTS = {
  'devils-advocate': { host: 'rtHostDA',    model: 'rtModelDA' },
  'pragmatist':      { host: 'rtHostPrag',  model: 'rtModelPrag' },
  'visionary':       { host: 'rtHostVis',   model: 'rtModelVis' },
  'synthesizer':     { host: 'rtHostSynth', model: 'rtModelSynth' }
};

async function loadAvailableModels() {
  try {
    const res = await apiClient.get('ollama-hosts');
    hostsData = (res.data?.hosts || []).filter(h => h.available);
  } catch (err) {
    console.error('Failed to load hosts:', err);
    hostsData = [];
  }

  // Deduplicate all models across hosts
  const modelSet = new Set();
  for (const h of hostsData) {
    for (const m of (h.models || [])) modelSet.add(m);
  }
  availableModels = [...modelSet].sort();

  populateHostSelects();
  populateAllModelSelects();
}

function populateHostSelects() {
  const stored = loadStoredPanelConfig();

  for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
    const hostEl = $[ids.host];
    if (!hostEl) continue;

    const storedHost = stored[agentId + '_host'] || '';
    // Default to first host if nothing stored
    const defaultHost = storedHost || (hostsData[0]?.url || '');

    hostEl.innerHTML = hostsData.map(h =>
      `<option value="${escapeHtml(h.url)}" ${h.url === defaultHost ? 'selected' : ''}>${escapeHtml(h.name || h.id)} — ${h.url.replace(/^https?:\/\//, '')} (${(h.models || []).length} models)</option>`
    ).join('');

    hostEl.addEventListener('change', () => {
      populateModelSelect(agentId);
      savePanelConfig();
    });
  }
}

function populateAllModelSelects() {
  for (const agentId of Object.keys(AGENT_SELECTS)) {
    populateModelSelect(agentId);
  }
}

function populateModelSelect(agentId) {
  const ids = AGENT_SELECTS[agentId];
  const hostEl = $[ids.host];
  const modelEl = $[ids.model];
  if (!modelEl) return;

  const stored = loadStoredPanelConfig();
  const selectedHost = hostEl?.value || '';
  const storedModel = stored[agentId] || DEFAULT_MODELS[agentId] || '';

  // Filter models to selected host
  const host = hostsData.find(h => h.url === selectedHost);
  const models = (host?.models || availableModels).slice().sort();

  modelEl.innerHTML = models.map(m =>
    `<option value="${escapeHtml(m)}" ${m === storedModel ? 'selected' : ''}>${escapeHtml(m)}</option>`
  ).join('');

  // If stored model not in current list, prepend it
  if (storedModel && !models.includes(storedModel)) {
    modelEl.insertAdjacentHTML('afterbegin',
      `<option value="${escapeHtml(storedModel)}" selected>${escapeHtml(storedModel)} (not on host)</option>`
    );
  }

  // Persist on model change
  modelEl.removeEventListener('change', savePanelConfig);
  modelEl.addEventListener('change', savePanelConfig);
}

function getSelectedPanelConfig() {
  return {
    'devils-advocate': $.rtModelDA?.value || DEFAULT_MODELS['devils-advocate'],
    'pragmatist': $.rtModelPrag?.value || DEFAULT_MODELS['pragmatist'],
    'visionary': $.rtModelVis?.value || DEFAULT_MODELS['visionary'],
    'synthesizer': $.rtModelSynth?.value || DEFAULT_MODELS['synthesizer']
  };
}

function savePanelConfig() {
  try {
    const config = getSelectedPanelConfig();
    // Also store host selections
    for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
      config[agentId + '_host'] = $[ids.host]?.value || '';
    }
    localStorage.setItem(PANEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

function loadStoredPanelConfig() {
  try {
    const raw = localStorage.getItem(PANEL_CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ── Start Discussion ─────────────────────────────────────────────────

async function handleStart() {
  const question = $.rtQuestionInput.value.trim();
  if (!question) {
    setInputStatus('Please enter a question.', true);
    $.rtQuestionInput.focus();
    return;
  }
  if (question.length > 5000) {
    setInputStatus('Question exceeds 5000 character limit.', true);
    return;
  }
  if (isStarting) return;

  isStarting = true;
  $.rtStartBtn.disabled = true;
  setInputStatus('Starting discussion...');

  try {
    const rounds = parseInt($.rtRoundsSelect.value) || 2;
    const models = getSelectedPanelConfig();

    const body = { question, rounds, source: 'dashboard' };

    // Only send panel/synthesizer overrides if user changed models from defaults
    const hasCustomModels = Object.entries(models).some(([k, v]) => v !== DEFAULT_MODELS[k]);
    if (hasCustomModels) {
      body.panel = [
        { agentId: 'devils-advocate', role: "Devil's Advocate", model: models['devils-advocate'] },
        { agentId: 'pragmatist', role: 'Pragmatist', model: models['pragmatist'] },
        { agentId: 'visionary', role: 'Visionary', model: models['visionary'] }
      ];
      body.synthesizer = { model: models['synthesizer'] };
    }

    const result = await apiClient.post('roundtable', body);

    activeRoundtableId = result._id;
    previousTurnCount = 0;
    activeRoundtable = null;

    setInputStatus('');
    renderDiscussionStart({ _id: result._id, question, rounds, status: 'pending' });
    startPolling();

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('id', result._id);
    window.history.replaceState({}, '', url);

  } catch (err) {
    setInputStatus(err.message || 'Failed to start discussion', true);
  } finally {
    isStarting = false;
    $.rtStartBtn.disabled = false;
  }
}

function setInputStatus(msg, isError = false) {
  $.rtInputStatus.textContent = msg;
  $.rtInputStatus.className = 'rt-input-status' + (isError ? ' error' : '');
}

// ── Polling ──────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  poller = new PollingController({
    onError: (err) => console.error('Roundtable poll error:', err)
  });
  poller.addTask('roundtable', pollRoundtable, POLL_INTERVAL_ACTIVE, {
    runOnStart: true,
    runOnResume: true,
    skipIfHidden: true
  });
  poller.start();
}

function stopPolling() {
  if (poller) {
    poller.destroy();
    poller = null;
  }
}

async function pollRoundtable() {
  if (!activeRoundtableId) return;

  const res = await apiClient.get(`roundtable/${activeRoundtableId}`);
  const doc = res.data || res;
  if (!doc || !doc._id) return;
  activeRoundtable = doc;

  // Render new turns incrementally
  const turns = doc.turns || [];
  if (turns.length > previousTurnCount) {
    const newTurns = turns.slice(previousTurnCount);
    for (const turn of newTurns) {
      renderTurnCard(turn, true);
    }
    previousTurnCount = turns.length;
  }

  // Update waiting/thinking states
  updateWaitingStates(doc);

  // Render stats
  renderStats(doc);

  // Synthesis
  if (doc.synthesis && doc.synthesis.response) {
    renderSynthesis(doc.synthesis);
  }

  // Completed / failed / timeout
  if (['completed', 'failed', 'timeout'].includes(doc.status)) {
    stopPolling();
    renderCompleted(doc);
  }
}

// ── Render: Discussion Start ─────────────────────────────────────────

function renderDiscussionStart(doc) {
  // Show panels
  $.rtStatsRow.style.display = '';
  $.rtDiscussionPanel.style.display = '';
  $.rtTranscriptActions.style.display = 'none';

  // Title & meta
  $.rtDiscussionTitle.textContent = doc.question;
  $.rtDiscussionMeta.innerHTML = `
    <span><i class="fas fa-hashtag"></i> ${escapeHtml(doc._id)}</span>
    <span><i class="fas fa-layer-group"></i> ${doc.rounds} round${doc.rounds > 1 ? 's' : ''}</span>
  `;

  // Clear previous content
  $.rtTurnsContainer.innerHTML = '';
  $.rtSynthesisContainer.innerHTML = '';

  // Render Round 1 divider + waiting cards
  renderRoundDivider(1);
  const agentIds = Object.keys(AGENT_CONFIG);
  for (const agentId of agentIds) {
    renderWaitingCard(agentId, 1);
  }

  // Initial stats
  renderStats({ status: 'running', turns: [], totalDurationMs: null });

  // Scroll to discussion
  $.rtDiscussionPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRoundDivider(roundNum) {
  const div = document.createElement('div');
  div.className = 'rt-round-divider';
  div.dataset.round = roundNum;
  const label = roundNum === 1 ? 'Round 1 — Initial Analysis' : `Round ${roundNum} — Rebuttal`;
  div.innerHTML = `<span class="rt-round-label">${label}</span>`;
  $.rtTurnsContainer.appendChild(div);
}

function renderWaitingCard(agentId, round) {
  const cfg = AGENT_CONFIG[agentId] || { icon: 'fa-robot', label: agentId, color: '#888' };
  const card = document.createElement('div');
  card.className = 'rt-turn-card waiting';
  card.dataset.role = agentId;
  card.dataset.round = round;
  card.dataset.agent = agentId;
  card.innerHTML = `
    <div class="rt-turn-header">
      <div class="rt-agent-icon ${agentId}"><i class="fas ${cfg.icon}"></i></div>
      <div>
        <div class="rt-turn-agent">${escapeHtml(cfg.label)}</div>
      </div>
    </div>
    <div class="rt-turn-body">
      <span class="rt-turn-waiting-text">Waiting...</span>
    </div>
  `;
  $.rtTurnsContainer.appendChild(card);
}

// ── Render: Turn Card (completed) ────────────────────────────────────

function renderTurnCard(turn, animate) {
  // Find and replace existing waiting card for this agent+round
  const existing = $.rtTurnsContainer.querySelector(
    `.rt-turn-card.waiting[data-agent="${turn.agentId}"][data-round="${turn.round}"]`
  );

  // If this turn's round > current max rendered round, add round divider + waiting cards
  const maxRenderedRound = getMaxRenderedRound();
  if (turn.round > maxRenderedRound) {
    renderRoundDivider(turn.round);
    for (const agentId of Object.keys(AGENT_CONFIG)) {
      renderWaitingCard(agentId, turn.round);
    }
  }

  const cfg = AGENT_CONFIG[turn.agentId] || { icon: 'fa-robot', label: turn.agentId, color: '#888' };
  const hasError = !!turn.error;
  const cardClass = hasError ? 'error' : (animate ? 'done' : '');

  const card = document.createElement('div');
  card.className = `rt-turn-card ${cardClass}`;
  card.dataset.role = turn.agentId;
  card.dataset.round = turn.round;
  card.dataset.agent = turn.agentId;

  const stats = turn.stats || {};
  const tps = stats.tokensPerSecond ? stats.tokensPerSecond.toFixed(1) : '—';
  const latency = stats.latencyMs ? formatDuration(stats.latencyMs) : '—';

  let thinkingHtml = '';
  if (turn.thinking) {
    thinkingHtml = `
      <div class="rt-turn-thinking">
        <div class="rt-turn-thinking-toggle" onclick="this.parentElement.classList.toggle('open')">
          <i class="fas fa-chevron-right"></i> Thinking
        </div>
        <div class="rt-turn-thinking-content">${escapeHtml(turn.thinking)}</div>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="rt-turn-header">
      <div class="rt-agent-icon ${turn.agentId}"><i class="fas ${cfg.icon}"></i></div>
      <div>
        <div class="rt-turn-agent">${escapeHtml(cfg.label)}</div>
        ${turn.model ? `<div class="rt-turn-model">${escapeHtml(turn.model)}</div>` : ''}
      </div>
      <div class="rt-turn-stats">
        <span><i class="fas fa-gauge-high"></i> ${tps} t/s</span>
        <span><i class="fas fa-clock"></i> ${latency}</span>
      </div>
    </div>
    <div class="rt-turn-body">${hasError ? `<span style="color:var(--danger)">${escapeHtml(turn.error)}</span>` : escapeHtml(turn.response || '')}</div>
    ${thinkingHtml}
  `;

  if (existing) {
    existing.replaceWith(card);
  } else {
    // Find the right waiting card (may have been created by round expansion)
    const waitingCard = $.rtTurnsContainer.querySelector(
      `.rt-turn-card.waiting[data-agent="${turn.agentId}"][data-round="${turn.round}"]`
    );
    if (waitingCard) {
      waitingCard.replaceWith(card);
    } else {
      $.rtTurnsContainer.appendChild(card);
    }
  }
}

function getMaxRenderedRound() {
  const dividers = $.rtTurnsContainer.querySelectorAll('.rt-round-divider');
  let max = 0;
  for (const d of dividers) {
    const r = parseInt(d.dataset.round);
    if (r > max) max = r;
  }
  return max;
}

// ── Render: Waiting / Thinking States ────────────────────────────────

function updateWaitingStates(doc) {
  if (doc.status !== 'running') return;

  const turns = doc.turns || [];
  const completedSet = new Set(turns.map(t => `${t.agentId}-${t.round}`));
  const agentIds = Object.keys(AGENT_CONFIG);

  // Determine current round from turns
  const currentRound = turns.length > 0
    ? Math.max(...turns.map(t => t.round))
    : 1;

  // Count completed in current round
  const completedInRound = turns.filter(t => t.round === currentRound).length;

  // The next agent to go is the one at index completedInRound (in agent order)
  const nextAgentIdx = completedInRound;

  // Update all waiting cards
  const waitingCards = $.rtTurnsContainer.querySelectorAll('.rt-turn-card.waiting');
  for (const card of waitingCards) {
    const agentId = card.dataset.agent;
    const round = parseInt(card.dataset.round);

    if (round === currentRound && agentIds.indexOf(agentId) === nextAgentIdx) {
      // This agent is currently thinking
      card.classList.remove('waiting');
      card.classList.add('thinking');
      const waitText = card.querySelector('.rt-turn-waiting-text');
      if (waitText) waitText.textContent = 'Thinking...';
    }
  }
}

// ── Render: Synthesis ────────────────────────────────────────────────

function renderSynthesis(synthesis) {
  if ($.rtSynthesisContainer.querySelector('.rt-synthesis-card')) return;

  const stats = synthesis.stats || {};
  const tps = stats.tokensPerSecond ? stats.tokensPerSecond.toFixed(1) : '—';
  const latency = stats.latencyMs ? formatDuration(stats.latencyMs) : '—';

  let thinkingHtml = '';
  if (synthesis.thinking) {
    thinkingHtml = `
      <div class="rt-turn-thinking">
        <div class="rt-turn-thinking-toggle" onclick="this.parentElement.classList.toggle('open')">
          <i class="fas fa-chevron-right"></i> Thinking
        </div>
        <div class="rt-turn-thinking-content">${escapeHtml(synthesis.thinking)}</div>
      </div>
    `;
  }

  const card = document.createElement('div');
  card.className = 'rt-synthesis-card done';
  card.innerHTML = `
    <div class="rt-turn-header">
      <div class="rt-agent-icon synthesizer"><i class="fas fa-gavel"></i></div>
      <div>
        <div class="rt-turn-agent">Synthesis</div>
        ${synthesis.model ? `<div class="rt-turn-model">${escapeHtml(synthesis.model)}</div>` : ''}
      </div>
      <div class="rt-turn-stats">
        <span><i class="fas fa-gauge-high"></i> ${tps} t/s</span>
        <span><i class="fas fa-clock"></i> ${latency}</span>
      </div>
    </div>
    <div class="rt-turn-body">${escapeHtml(synthesis.response || '')}</div>
    ${thinkingHtml}
  `;
  $.rtSynthesisContainer.appendChild(card);
}

// ── Render: Stats ────────────────────────────────────────────────────

function renderStats(doc) {
  const turns = doc.turns || [];
  const duration = doc.totalDurationMs || (doc.createdAt ? Date.now() - new Date(doc.createdAt).getTime() : 0);
  const turnsCount = turns.length;
  const tpsValues = turns.map(t => t.stats?.tokensPerSecond).filter(Boolean);
  const avgTps = tpsValues.length > 0 ? (tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length) : 0;

  $.rtStatDuration.textContent = formatDuration(duration);
  $.rtStatTurns.textContent = turnsCount;
  $.rtStatAvgTps.textContent = avgTps > 0 ? avgTps.toFixed(1) : '—';

  const statusCfg = STATUS_CONFIG[doc.status] || STATUS_CONFIG.pending;
  $.rtStatStatus.innerHTML = `<i class="fas ${statusCfg.icon}" style="margin-right:4px"></i> ${statusCfg.label}`;
  $.rtStatStatus.style.color = statusCfg.color;
}

// ── Render: Completed ────────────────────────────────────────────────

function renderCompleted(doc) {
  $.rtTranscriptActions.style.display = '';
  $.rtStartBtn.disabled = false;

  // Remove any remaining waiting/thinking cards
  const remaining = $.rtTurnsContainer.querySelectorAll('.rt-turn-card.waiting, .rt-turn-card.thinking');
  for (const card of remaining) {
    card.remove();
  }

  if (doc.status === 'failed' && doc.error) {
    setInputStatus(`Discussion failed: ${doc.error}`, true);
  }
}

// ── Load Existing Roundtable ─────────────────────────────────────────

async function loadRoundtable(id) {
  try {
    const res = await apiClient.get(`roundtable/${id}`);
    const doc = res.data || res;
    if (!doc || !doc._id) throw new Error('Roundtable not found');
    activeRoundtableId = doc._id;
    activeRoundtable = doc;
    previousTurnCount = 0;

    // Show panels
    $.rtStatsRow.style.display = '';
    $.rtDiscussionPanel.style.display = '';
    $.rtTurnsContainer.innerHTML = '';
    $.rtSynthesisContainer.innerHTML = '';
    $.rtTranscriptActions.style.display = 'none';

    // Title & meta
    $.rtDiscussionTitle.textContent = doc.question;
    $.rtDiscussionMeta.innerHTML = `
      <span><i class="fas fa-hashtag"></i> ${escapeHtml(doc._id)}</span>
      <span><i class="fas fa-layer-group"></i> ${doc.rounds} round${doc.rounds > 1 ? 's' : ''}</span>
      <span><i class="fas fa-calendar"></i> ${formatDate(doc.createdAt)}</span>
    `;

    // Render all turns grouped by round
    const turns = doc.turns || [];
    let currentRound = 0;
    for (const turn of turns) {
      if (turn.round > currentRound) {
        currentRound = turn.round;
        renderRoundDivider(currentRound);
      }
      renderTurnCard(turn, false);
    }
    previousTurnCount = turns.length;

    // Synthesis
    if (doc.synthesis && doc.synthesis.response) {
      renderSynthesis(doc.synthesis);
    }

    // Stats
    renderStats(doc);

    // If still running, start polling
    if (['pending', 'running'].includes(doc.status)) {
      startPolling();
    } else {
      renderCompleted(doc);
    }

    // Pre-fill question for reference
    $.rtQuestionInput.value = doc.question;

    // Update URL
    const url = new URL(window.location);
    url.searchParams.set('id', id);
    window.history.replaceState({}, '', url);

  } catch (err) {
    setInputStatus(`Failed to load roundtable: ${err.message}`, true);
    // Clear stale deep-link so user isn't stuck
    const url = new URL(window.location);
    url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
  }
}

// ── History ──────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const skip = historyPage * HISTORY_PAGE_SIZE;
    const res = await apiClient.get('roundtable', { limit: HISTORY_PAGE_SIZE, skip });
    const data = res.data || [];
    historyTotal = res.total || 0;
    renderHistory(data, historyTotal);
  } catch (err) {
    $.rtHistoryList.innerHTML = `<div class="rt-empty-state"><i class="fas fa-exclamation-triangle"></i><p>Failed to load history</p></div>`;
  }
}

function renderHistory(data, total) {
  if (data.length === 0) {
    $.rtHistoryList.innerHTML = `<div class="rt-empty-state"><i class="fas fa-inbox"></i><p>No discussions yet</p></div>`;
    $.rtPagination.innerHTML = '';
    return;
  }

  $.rtHistoryList.innerHTML = data.map(doc => {
    const statusCfg = STATUS_CONFIG[doc.status] || STATUS_CONFIG.pending;
    const turnsCount = doc.turnsCount ?? (doc.turns || []).length;
    return `
      <div class="rt-history-item" data-id="${doc._id}">
        <span class="rt-status-badge ${doc.status}">${statusCfg.label}</span>
        <span class="rt-history-question">${escapeHtml(doc.question)}</span>
        <div class="rt-history-meta">
          <span><i class="fas fa-layer-group"></i> ${doc.rounds}R</span>
          <span><i class="fas fa-comments"></i> ${turnsCount}</span>
          <span><i class="fas fa-calendar"></i> ${formatDate(doc.createdAt)}</span>
        </div>
      </div>
    `;
  }).join('');

  // Click handlers
  for (const item of $.rtHistoryList.querySelectorAll('.rt-history-item')) {
    item.addEventListener('click', () => {
      loadRoundtable(item.dataset.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Pagination
  const totalPages = Math.ceil(total / HISTORY_PAGE_SIZE);
  if (totalPages <= 1) {
    $.rtPagination.innerHTML = '';
    return;
  }

  $.rtPagination.innerHTML = `
    <button id="rtPrevPage" ${historyPage === 0 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i> Prev</button>
    <span class="rt-page-info">${historyPage + 1} / ${totalPages}</span>
    <button id="rtNextPage" ${historyPage >= totalPages - 1 ? 'disabled' : ''}>Next <i class="fas fa-chevron-right"></i></button>
  `;

  document.getElementById('rtPrevPage')?.addEventListener('click', () => {
    if (historyPage > 0) { historyPage--; loadHistory(); }
  });
  document.getElementById('rtNextPage')?.addEventListener('click', () => {
    if (historyPage < totalPages - 1) { historyPage++; loadHistory(); }
  });
}

// ── Transcript Download ──────────────────────────────────────────────

async function handleDownloadTranscript() {
  if (!activeRoundtableId) return;

  try {
    const response = await fetch(`/api/roundtable/${activeRoundtableId}/transcript`, {
      credentials: 'include'
    });
    if (!response.ok) throw new Error('Failed to fetch transcript');
    const text = await response.text();

    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roundtable-${activeRoundtableId}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    const toast = window.toast;
    if (toast) toast.error(err.message);
    else alert('Download failed: ' + err.message);
  }
}

// ── New Discussion ───────────────────────────────────────────────────

function handleNewDiscussion() {
  stopPolling();
  activeRoundtableId = null;
  activeRoundtable = null;
  previousTurnCount = 0;

  $.rtStatsRow.style.display = 'none';
  $.rtDiscussionPanel.style.display = 'none';
  $.rtTranscriptActions.style.display = 'none';
  $.rtTurnsContainer.innerHTML = '';
  $.rtSynthesisContainer.innerHTML = '';
  $.rtQuestionInput.value = '';
  setInputStatus('');

  // Clear URL param
  const url = new URL(window.location);
  url.searchParams.delete('id');
  window.history.replaceState({}, '', url);

  $.rtQuestionInput.focus();
  loadHistory();
}

// ── Utilities ────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m ${remSecs}s`;
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
