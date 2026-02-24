/**
 * Roundtable Dashboard — Main Module
 *
 * Manages live discussions, polling, history browsing, and transcript download.
 * Uses PollingController for tab-aware polling and apiClient for API calls.
 */

import { apiClient } from '../utils/api-client.js';
import { PollingController } from '../utils/polling-controller.js';
import { initCompareView } from './compareView.js';
import { initQualityScores } from './qualityScores.js';
import { initNotifications } from './notifications.js';
import { initRendering } from './rendering.js';

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
const PRESETS_STORAGE_KEY = 'roundtablePresets';

// Built-in presets (not editable, not deletable)
const BUILTIN_PRESETS = {
  default: {
    label: 'Default',
    agents: {
      'devils-advocate': { role: "Devil's Advocate", systemPrompt: '' },
      'pragmatist': { role: 'Pragmatist', systemPrompt: '' },
      'visionary': { role: 'Visionary', systemPrompt: '' },
      'synthesizer': { role: 'Synthesizer', systemPrompt: '' }
    }
  },
  technical: {
    label: 'Technical Review',
    agents: {
      'devils-advocate': { role: 'Security Auditor', systemPrompt: 'You are a Security Auditor in a roundtable discussion. Your job is to identify vulnerabilities, attack vectors, and security risks.\n\nRules:\n- Focus on OWASP top 10, supply chain risks, and data exposure\n- Assess both technical and operational security\n- Suggest concrete mitigations\n- Keep your response under 400 words' },
      'pragmatist': { role: 'Senior Engineer', systemPrompt: 'You are a Senior Engineer in a roundtable discussion. Your job is to evaluate technical feasibility, maintainability, and engineering trade-offs.\n\nRules:\n- Focus on complexity, scalability, and tech debt\n- Consider team capacity and existing infrastructure\n- Suggest concrete implementation approaches\n- Keep your response under 400 words' },
      'visionary': { role: 'Architect', systemPrompt: 'You are a Software Architect in a roundtable discussion. Your job is to evaluate system design, patterns, and long-term technical strategy.\n\nRules:\n- Consider extensibility, modularity, and integration points\n- Identify architectural anti-patterns\n- Propose clean, composable designs\n- Keep your response under 400 words' },
      'synthesizer': { role: 'Synthesizer', systemPrompt: '' }
    }
  },
  business: {
    label: 'Business Analysis',
    agents: {
      'devils-advocate': { role: 'Risk Analyst', systemPrompt: 'You are a Risk Analyst in a roundtable discussion. Your job is to identify business risks, market threats, and potential failures.\n\nRules:\n- Assess financial, operational, and reputational risks\n- Consider competitive dynamics and market timing\n- Quantify impact where possible\n- Keep your response under 400 words' },
      'pragmatist': { role: 'Operations Lead', systemPrompt: 'You are an Operations Lead in a roundtable discussion. Your job is to evaluate execution feasibility, resource requirements, and operational constraints.\n\nRules:\n- Focus on timelines, budgets, and team capacity\n- Consider dependencies and bottlenecks\n- Suggest phased rollout approaches\n- Keep your response under 400 words' },
      'visionary': { role: 'Strategist', systemPrompt: 'You are a Business Strategist in a roundtable discussion. Your job is to see market opportunities, competitive advantages, and long-term value.\n\nRules:\n- Consider market trends and positioning\n- Identify strategic leverage points\n- Think about network effects and moats\n- Keep your response under 400 words' },
      'synthesizer': { role: 'Synthesizer', systemPrompt: '' }
    }
  }
};

// ── State ────────────────────────────────────────────────────────────

let activeRoundtableId = null;
let activeRoundtable = null;
let previousTurnCount = 0;
let historyPage = 0;
let historyTotal = 0;
let isStarting = false;
let poller = null;
let availableModels = [];
let eventSource = null;
let streamingBuffers = {}; // agentId-round → accumulated content
let notificationSent = false; // Guard against repeated browser notifications
let qualityPollingStarted = false; // Guard against restarting quality poll
// Feature modules (initialized after DOM ready)
let compareView = null;
let qualityModule = null;
let notifyModule = null;
let renderModule = null;

// ── DOM Refs (populated in init) ─────────────────────────────────────

const $ = {};

// ── Init ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  cacheDOM();
  wireEvents();
  loadAvailableModels();
  compareView = initCompareView({ $, AGENT_CONFIG, escapeHtml });
  qualityModule = initQualityScores({ $ });
  notifyModule = initNotifications({ $ });
  renderModule = initRendering({ $, AGENT_CONFIG, AGENT_SELECTS, escapeHtml, formatDuration });
  populatePresetSelect();
  restoreRolesAndPrompts();
  restoreWebSearchToggles();
  notifyModule.restoreNotifyConfig();

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
    'rtRoleDA', 'rtRolePrag', 'rtRoleVis', 'rtRoleSynth',
    'rtPromptDA', 'rtPromptPrag', 'rtPromptVis', 'rtPromptSynth',
    'rtWebSearchDA', 'rtWebSearchPrag', 'rtWebSearchVis',
    'rtPresetSelect', 'rtSavePreset', 'rtDeletePreset',
    'rtStatsRow', 'rtStatDuration', 'rtStatTurns', 'rtStatAvgTps', 'rtStatStatus',
    'rtDiscussionPanel', 'rtDiscussionTitle', 'rtDiscussionMeta',
    'rtNotifyBrowser', 'rtNotifySlack', 'rtNotifyWebhook',
    'rtViewToggle', 'rtTurnsContainer', 'rtCompareContainer', 'rtSynthesisContainer', 'rtTranscriptActions',
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

  // Preset events
  $.rtPresetSelect.addEventListener('change', handlePresetChange);
  $.rtSavePreset.addEventListener('click', handleSavePreset);
  $.rtDeletePreset.addEventListener('click', handleDeletePreset);

  // View toggle
  for (const btn of document.querySelectorAll('.rt-view-btn')) {
    btn.addEventListener('click', () => compareView?.handleViewToggle(btn.dataset.view));
  }

  // Auto-save role/prompt/web-search changes
  for (const el of document.querySelectorAll('.rt-role-input, .rt-prompt-input')) {
    el.addEventListener('change', savePanelConfig);
  }
  for (const el of document.querySelectorAll('.rt-websearch-checkbox')) {
    el.addEventListener('change', savePanelConfig);
  }

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
  'devils-advocate': { host: 'rtHostDA',    model: 'rtModelDA',    role: 'rtRoleDA',    prompt: 'rtPromptDA',    webSearch: 'rtWebSearchDA' },
  'pragmatist':      { host: 'rtHostPrag',  model: 'rtModelPrag',  role: 'rtRolePrag',  prompt: 'rtPromptPrag',  webSearch: 'rtWebSearchPrag' },
  'visionary':       { host: 'rtHostVis',   model: 'rtModelVis',   role: 'rtRoleVis',   prompt: 'rtPromptVis',   webSearch: 'rtWebSearchVis' },
  'synthesizer':     { host: 'rtHostSynth', model: 'rtModelSynth', role: 'rtRoleSynth', prompt: 'rtPromptSynth' }
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
    // Also store host, role, prompt, web search selections
    for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
      config[agentId + '_host'] = $[ids.host]?.value || '';
      config[agentId + '_role'] = $[ids.role]?.value || '';
      config[agentId + '_prompt'] = $[ids.prompt]?.value || '';
      if (ids.webSearch) config[agentId + '_webSearch'] = $[ids.webSearch]?.checked || false;
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

// ── Presets ───────────────────────────────────────────────────────────

function getCustomPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCustomPresets(presets) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

function populatePresetSelect() {
  const custom = getCustomPresets();
  const sel = $.rtPresetSelect;
  sel.innerHTML = '';
  // Built-in presets
  for (const [key, preset] of Object.entries(BUILTIN_PRESETS)) {
    sel.innerHTML += `<option value="${key}">${escapeHtml(preset.label)}</option>`;
  }
  // Custom presets
  for (const [key, preset] of Object.entries(custom)) {
    sel.innerHTML += `<option value="custom:${escapeHtml(key)}">${escapeHtml(preset.label)}</option>`;
  }
  // Restore last selected
  const stored = loadStoredPanelConfig();
  if (stored._preset) sel.value = stored._preset;
  updateDeleteBtnVisibility();
}

function handlePresetChange() {
  const key = $.rtPresetSelect.value;
  let preset;

  if (key.startsWith('custom:')) {
    const customKey = key.slice(7);
    preset = getCustomPresets()[customKey];
  } else {
    preset = BUILTIN_PRESETS[key];
  }

  if (!preset) return;

  // Apply preset to role names, prompts, and web search
  for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
    const agentPreset = preset.agents?.[agentId];
    if (agentPreset) {
      if ($[ids.role]) $[ids.role].value = agentPreset.role || '';
      if ($[ids.prompt]) $[ids.prompt].value = agentPreset.systemPrompt || '';
      if (ids.webSearch && $[ids.webSearch]) $[ids.webSearch].checked = agentPreset.enableWebSearch || false;
    }
  }

  savePanelConfig();
  // Persist selected preset key
  try {
    const config = JSON.parse(localStorage.getItem(PANEL_CONFIG_STORAGE_KEY) || '{}');
    config._preset = key;
    localStorage.setItem(PANEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore */ }

  updateDeleteBtnVisibility();
}

function handleSavePreset() {
  const name = prompt('Preset name:');
  if (!name || !name.trim()) return;

  const key = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const presets = getCustomPresets();
  presets[key] = {
    label: name.trim(),
    agents: {}
  };

  for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
    presets[key].agents[agentId] = {
      role: $[ids.role]?.value || '',
      systemPrompt: $[ids.prompt]?.value || '',
      ...(ids.webSearch ? { enableWebSearch: $[ids.webSearch]?.checked || false } : {})
    };
  }

  saveCustomPresets(presets);
  populatePresetSelect();
  $.rtPresetSelect.value = `custom:${key}`;
  updateDeleteBtnVisibility();
}

function handleDeletePreset() {
  const key = $.rtPresetSelect.value;
  if (!key.startsWith('custom:')) return;

  const customKey = key.slice(7);
  const presets = getCustomPresets();
  delete presets[customKey];
  saveCustomPresets(presets);
  populatePresetSelect();
  $.rtPresetSelect.value = 'default';
  handlePresetChange();
}

function updateDeleteBtnVisibility() {
  $.rtDeletePreset.style.display = $.rtPresetSelect.value.startsWith('custom:') ? '' : 'none';
}

function restoreRolesAndPrompts() {
  const stored = loadStoredPanelConfig();
  for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
    if ($[ids.role] && stored[agentId + '_role']) {
      $[ids.role].value = stored[agentId + '_role'];
    }
    if ($[ids.prompt] && stored[agentId + '_prompt']) {
      $[ids.prompt].value = stored[agentId + '_prompt'];
    }
  }
}

function restoreWebSearchToggles() {
  const stored = loadStoredPanelConfig();
  for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
    if (ids.webSearch && $[ids.webSearch]) {
      $[ids.webSearch].checked = stored[agentId + '_webSearch'] || false;
    }
  }
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

    // Gather custom roles and prompts
    const roles = {};
    const prompts = {};
    for (const [agentId, ids] of Object.entries(AGENT_SELECTS)) {
      roles[agentId] = $[ids.role]?.value?.trim() || '';
      prompts[agentId] = $[ids.prompt]?.value?.trim() || '';
    }

    // Always send panel config — may have custom roles/prompts even with default models
    body.panel = [
      { agentId: 'devils-advocate', role: roles['devils-advocate'] || "Devil's Advocate", model: models['devils-advocate'], enableWebSearch: $.rtWebSearchDA?.checked || false, ...(prompts['devils-advocate'] ? { systemPrompt: prompts['devils-advocate'] } : {}) },
      { agentId: 'pragmatist', role: roles['pragmatist'] || 'Pragmatist', model: models['pragmatist'], enableWebSearch: $.rtWebSearchPrag?.checked || false, ...(prompts['pragmatist'] ? { systemPrompt: prompts['pragmatist'] } : {}) },
      { agentId: 'visionary', role: roles['visionary'] || 'Visionary', model: models['visionary'], enableWebSearch: $.rtWebSearchVis?.checked || false, ...(prompts['visionary'] ? { systemPrompt: prompts['visionary'] } : {}) }
    ];
    body.synthesizer = {
      model: models['synthesizer'],
      ...(prompts['synthesizer'] ? { systemPrompt: prompts['synthesizer'] } : {})
    };

    // Add webhook notification config
    const notifyPayload = notifyModule?.getNotifyPayload();
    if (notifyPayload) body.notify = notifyPayload;

    // Request browser notification permission on first use
    notifyModule?.requestBrowserNotificationPermission();

    const result = await apiClient.post('roundtable', body);

    activeRoundtableId = result._id;
    previousTurnCount = 0;
    activeRoundtable = null;
    notificationSent = false;
    qualityPollingStarted = false;

    setInputStatus('');
    renderDiscussionStart({ _id: result._id, question, rounds, status: 'pending' });
    startStreaming(); // SSE first, falls back to polling on error

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

// ── Streaming (SSE) + Polling Fallback ───────────────────────────────

function startStreaming() {
  stopStreaming();
  if (!activeRoundtableId) return;

  streamingBuffers = {};
  eventSource = new EventSource(`/api/roundtable/${activeRoundtableId}/stream`);

  eventSource.addEventListener('web-search-start', (e) => {
    const data = JSON.parse(e.data);
    // Show "Searching web..." on the waiting card
    const waitingCard = $.rtTurnsContainer.querySelector(
      `.rt-turn-card.waiting[data-agent="${data.agentId}"][data-round="${data.round}"],
       .rt-turn-card.thinking[data-agent="${data.agentId}"][data-round="${data.round}"]`
    );
    if (waitingCard) {
      const waitText = waitingCard.querySelector('.rt-turn-waiting-text');
      if (waitText) waitText.innerHTML = '<i class="fas fa-globe" style="margin-right:4px"></i> Searching web...';
    }
  });

  eventSource.addEventListener('web-search-done', (e) => {
    const data = JSON.parse(e.data);
    const waitingCard = $.rtTurnsContainer.querySelector(
      `.rt-turn-card[data-agent="${data.agentId}"][data-round="${data.round}"]`
    );
    if (waitingCard) {
      const waitText = waitingCard.querySelector('.rt-turn-waiting-text');
      if (waitText) waitText.textContent = data.resultCount > 0 ? `Found ${data.resultCount} results. Thinking...` : 'Thinking...';
    }
  });

  eventSource.addEventListener('turn-start', (e) => {
    const data = JSON.parse(e.data);
    const key = `${data.agentId}-${data.round}`;
    streamingBuffers[key] = '';

    // Ensure round divider + waiting cards exist
    const maxRendered = getMaxRenderedRound();
    if (data.round > maxRendered) {
      renderRoundDivider(data.round);
      for (const agentId of Object.keys(AGENT_CONFIG)) {
        renderWaitingCard(agentId, data.round);
      }
    }

    // Mark the card as thinking with streaming content area
    const waitingCard = $.rtTurnsContainer.querySelector(
      `.rt-turn-card[data-agent="${data.agentId}"][data-round="${data.round}"]`
    );
    if (waitingCard) {
      waitingCard.classList.remove('waiting');
      waitingCard.classList.add('thinking', 'streaming');
      const cfg = AGENT_CONFIG[data.agentId] || { icon: 'fa-robot', label: data.agentId };
      const displayLabel = data.role || cfg.label;
      waitingCard.innerHTML = `
        <div class="rt-turn-header">
          <div class="rt-agent-icon ${data.agentId}"><i class="fas ${cfg.icon}"></i></div>
          <div>
            <div class="rt-turn-agent">${escapeHtml(displayLabel)}</div>
            ${data.model ? `<div class="rt-turn-model">${escapeHtml(data.model)}</div>` : ''}
          </div>
          <div class="rt-turn-stats"><span class="rt-streaming-indicator"><i class="fas fa-circle" style="color:#4ade80;font-size:8px"></i> Streaming</span></div>
        </div>
        <div class="rt-turn-body rt-stream-body"></div>
      `;
    }
  });

  eventSource.addEventListener('turn-chunk', (e) => {
    const data = JSON.parse(e.data);
    const key = `${data.agentId}-${data.round}`;
    streamingBuffers[key] = (streamingBuffers[key] || '') + data.content;

    const card = $.rtTurnsContainer.querySelector(
      `.rt-turn-card.streaming[data-agent="${data.agentId}"][data-round="${data.round}"]`
    );
    if (card) {
      const body = card.querySelector('.rt-stream-body');
      if (body) body.textContent = streamingBuffers[key];
    }
  });

  eventSource.addEventListener('turn-done', (e) => {
    // Don't increment previousTurnCount here — let pollRoundtable handle it
    // so renderTurnCard replaces the streaming card with the final card
    pollRoundtable().catch(() => {});
  });

  eventSource.addEventListener('synthesis-start', (e) => {
    const data = JSON.parse(e.data);
    streamingBuffers['synthesis'] = '';
    // Create a streaming synthesis card
    $.rtSynthesisContainer.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'rt-synthesis-card streaming';
    card.innerHTML = `
      <div class="rt-turn-header">
        <div class="rt-agent-icon synthesizer"><i class="fas fa-gavel"></i></div>
        <div>
          <div class="rt-turn-agent">Synthesis</div>
          ${data.model ? `<div class="rt-turn-model">${escapeHtml(data.model)}</div>` : ''}
        </div>
        <div class="rt-turn-stats"><span class="rt-streaming-indicator"><i class="fas fa-circle" style="color:#4ade80;font-size:8px"></i> Streaming</span></div>
      </div>
      <div class="rt-turn-body rt-stream-body"></div>
    `;
    $.rtSynthesisContainer.appendChild(card);
  });

  eventSource.addEventListener('synthesis-chunk', (e) => {
    const data = JSON.parse(e.data);
    streamingBuffers['synthesis'] = (streamingBuffers['synthesis'] || '') + data.content;
    const body = $.rtSynthesisContainer.querySelector('.rt-stream-body');
    if (body) body.textContent = streamingBuffers['synthesis'];
  });

  eventSource.addEventListener('synthesis-done', () => {
    // Refresh to get final persisted synthesis
    pollRoundtable().catch(() => {});
  });

  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    stopStreaming();
    // Final poll to render completed state
    pollRoundtable().catch(() => {});
  });

  eventSource.onerror = () => {
    // SSE disconnected — fall back to polling
    stopStreaming();
    startPolling();
  };
}

function stopStreaming() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  streamingBuffers = {};
}

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
  compareView?.setActiveRoundtable(doc);

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

  // Quality scores (may arrive after completion)
  if (doc.qualityScores) {
    qualityModule?.renderQualityScores(doc);
  }

  // Completed / failed / timeout
  if (['completed', 'failed', 'timeout'].includes(doc.status)) {
    if (doc.qualityScores) {
      // Scores are in — stop polling entirely
      stopPolling();
      qualityPollingStarted = false;
    } else if (!qualityPollingStarted) {
      // Keep polling for quality scores to arrive (switch to slower interval)
      qualityPollingStarted = true;
      stopPolling();
      poller = new PollingController({ onError: (err) => console.error('Quality poll error:', err) });
      poller.addTask('roundtable', pollRoundtable, 5000, { runOnStart: false, runOnResume: true, skipIfHidden: true });
      poller.start();
    }
    renderCompleted(doc);
  }
}

// ── Render: Delegated to rendering.js ────────────────────────────────
// renderDiscussionStart, renderRoundDivider, renderWaitingCard,
// renderTurnCard, renderSynthesisCard, getMaxRenderedRound
// are all provided by the rendering module.

function renderDiscussionStart(doc) {
  renderModule.renderDiscussionStart(doc, renderStats);
}

function renderRoundDivider(roundNum) {
  renderModule.renderRoundDivider(roundNum);
}

function renderWaitingCard(agentId, round) {
  renderModule.renderWaitingCard(agentId, round);
}

function renderTurnCard(turn, animate) {
  renderModule.renderTurnCard(turn, animate);
}

function getMaxRenderedRound() {
  return renderModule.getMaxRenderedRound();
}

// ── Render: Waiting / Thinking States ────────────────────────────────

function updateWaitingStates(doc) {
  if (doc.status !== 'running') return;

  const turns = doc.turns || [];
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
  renderModule.renderSynthesisCard(synthesis);
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
  // Show view toggle when we have completed turns
  if ((doc.turns || []).length > 0) {
    $.rtViewToggle.style.display = '';
  }
  // Update compare view if active
  if (compareView?.getCurrentView() === 'compare') compareView.renderCompareView();

  // Browser notification (only once per discussion)
  if (!notificationSent) {
    notificationSent = true;
    notifyModule?.sendBrowserNotification(doc);
  }

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
    compareView?.setActiveRoundtable(doc);
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
      // Render quality scores if available
      if (doc.qualityScores) qualityModule?.renderQualityScores(doc);
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
  stopStreaming();
  stopPolling();
  activeRoundtableId = null;
  activeRoundtable = null;
  previousTurnCount = 0;
  notificationSent = false;
  qualityPollingStarted = false;

  $.rtStatsRow.style.display = 'none';
  $.rtDiscussionPanel.style.display = 'none';
  $.rtTranscriptActions.style.display = 'none';
  $.rtViewToggle.style.display = 'none';
  $.rtTurnsContainer.innerHTML = '';
  $.rtCompareContainer.innerHTML = '';
  $.rtCompareContainer.style.display = 'none';
  $.rtSynthesisContainer.innerHTML = '';
  $.rtQuestionInput.value = '';
  setInputStatus('');

  // Reset compare view to timeline mode
  if (compareView) compareView.handleViewToggle('timeline');

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
