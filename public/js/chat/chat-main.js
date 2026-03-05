/**
 * Chat main — Init, state, event wiring, DOMContentLoaded
 * Entry point for the chat page module system.
 */
import { DEFAULTS } from './chat-constants.js';
import {
  loadSettings, hydrateForm, persistSettings as _persistSettings,
  updateRangeDisplays, updateConfigSummary, toggleRagOptions,
  checkRagAvailability, loadServerConfig, loadOllamaHosts, targetHost
} from './chat-config.js';
import {
  renderMessage, appendMessage as _appendMessage, renderLogList as _renderLogList,
  sendMessage as _sendMessage, sendMessageStreamFetch, fetchModels as _fetchModels,
  setStatus as _setStatus, setFeedback as _setFeedback, sanitizeHTML
} from './chat-messaging.js';
import {
  loadHistoryList as _loadHistoryList, loadConversation as _loadConversation,
  wireHistoryTabs
} from './chat-history.js';
import {
  toggleVoiceInput, speakText as _speakText, checkVoiceHealth,
  updateVoiceFieldVisibility
} from './chat-voice.js';
import { initAgentSystem, reapplyAgentModel, updateHeaderBar } from './chat-agents.js';
import {
  loadProfile as _loadProfile, saveProfile as _saveProfile,
  loadActivePrompt, loadPromptSelector, showPromptInfo
} from './chat-profile.js';

document.addEventListener('DOMContentLoaded', () => {

  const elements = {
    chatWindow: document.getElementById('chatWindow'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    clearBtn: document.getElementById('clearBtn'),
    analyzeQualityBtn: document.getElementById('analyzeQualityBtn'),
    hostInput: document.getElementById('hostInput'),
    modelSelect: document.getElementById('modelSelect'),
    systemPrompt: document.getElementById('systemPrompt'),
    temperature: document.getElementById('temperature'),
    topP: document.getElementById('topP'),
    topK: document.getElementById('topK'),
    numCtx: document.getElementById('numCtx'),
    repeatPenalty: document.getElementById('repeatPenalty'),
    presencePenalty: document.getElementById('presencePenalty'),
    frequencyPenalty: document.getElementById('frequencyPenalty'),
    numPredict: document.getElementById('numPredict'),
    seed: document.getElementById('seed'),
    stopSequences: document.getElementById('stopSequences'),
    keepAlive: document.getElementById('keepAlive'),
    statusChip: document.getElementById('statusChip'),
    statMessages: document.getElementById('statMessages'),
    refreshModels: document.getElementById('refreshModels'),
    saveDefaults: document.getElementById('saveDefaults'),
    feedback: document.getElementById('feedback'),
    quickActions: document.querySelectorAll('[data-quick]'),
    streamToggle: document.getElementById('streamToggle'),
    ragToggle: document.getElementById('ragToggle'),
    webSearchToggle: document.getElementById('webSearchToggle'),
    ragOptionsPanel: document.getElementById('ragOptionsPanel'),
    ragOptionsContent: document.getElementById('ragOptionsContent'),
    ragPanelHeader: document.getElementById('ragPanelHeader'),
    ragChevron: document.getElementById('ragChevron'),
    ragExpandQuery: document.getElementById('ragExpandQuery'),
    ragHybridSearch: document.getElementById('ragHybridSearch'),
    ragRerankResults: document.getElementById('ragRerankResults'),
    ragCompress: document.getElementById('ragCompress'),
    ragTopK: document.getElementById('ragTopK'),
    ragTopKValue: document.getElementById('ragTopKValue'),
    statsToggle: document.getElementById('statsToggle'),
    logWindow: document.getElementById('logWindow'),
    threadId: document.getElementById('threadId'),
    memoryLanguage: document.getElementById('memoryLanguage'),
    memoryRole: document.getElementById('memoryRole'),
    memoryStyle: document.getElementById('memoryStyle'),
    logPanel: document.querySelector('.log-panel'),
    toggleLogBtn: document.getElementById('toggleLogBtn'),
    toggleHistoryBtn: document.getElementById('toggleHistoryBtn'),
    closeHistoryBtn: document.getElementById('closeHistoryBtn'),
    page: document.querySelector('.page'),
    micBtn: document.getElementById('micBtn'),
    ttsToggle: document.getElementById('ttsToggle'),
    sttProviderSelect: document.getElementById('sttProviderSelect'),
    sttLanguageSelect: document.getElementById('sttLanguageSelect'),
    whisperModelSelect: document.getElementById('whisperModelSelect'),
    whisperModelField: document.getElementById('whisperModelField'),
    voiceAutoSend: document.getElementById('voiceAutoSend'),
    claudeCodeToggle: document.getElementById('claudeCodeToggle'),
    ttsVoiceSelect: document.getElementById('ttsVoiceSelect'),
    ttsVoiceField: document.getElementById('ttsVoiceField'),
    testVoiceBtn: document.getElementById('testVoiceBtn'),
    sttHealthDot: document.getElementById('sttHealthDot'),
    sttHealthDotInner: document.getElementById('sttHealthDotInner'),
    ttsHealthDot: document.getElementById('ttsHealthDot'),
    historyList: document.getElementById('historyList'),
    resetProfileBtn: document.getElementById('resetProfileBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    profileBtn: document.getElementById('profileBtn'),
    profileModal: document.getElementById('profileModal'),
    closeProfileBtn: document.getElementById('closeProfileBtn'),
    saveProfileBtn: document.getElementById('saveProfileBtn'),
    userAbout: document.getElementById('userAbout'),
    userInstructions: document.getElementById('userInstructions'),
    promptSelect: document.getElementById('promptSelect'),
    promptInfoBtn: document.getElementById('promptInfoBtn'),
    // Config drawer
    configDrawer: document.getElementById('configDrawer'),
    configDrawerBackdrop: document.getElementById('configDrawerBackdrop'),
    configDrawerClose: document.getElementById('configDrawerClose'),
    toggleConfigBtn: document.getElementById('toggleConfigBtn'),
  };

  // Copy defaults so server config can mutate them
  const defaults = { ...DEFAULTS, options: { ...DEFAULTS.options } };

  const state = {
    history: [],
    sending: false,
    stats: { messages: 0, replies: 0 },
    settings: { ...DEFAULTS, options: { ...DEFAULTS.options } },
    threadId: `t-${Date.now().toString(36)}`,
    profile: { language: '', role: '', style: '' },
    conversationId: null,
    agentId: null,
    agent: null,
    showStats: true,
    eventSource: null,
    streamAbortController: null,
    config: null,
    voiceProvider: 'browser',
    _helpers: null,
  };

  // Helper functions that close over elements/state for modules
  const helpers = {
    setStatus: (text, tone) => _setStatus(elements, text, tone),
    setFeedback: (text, tone) => _setFeedback(elements, text, tone),
    appendMessage: (msgOrRole, opts) => {
      _appendMessage(msgOrRole, opts, state, elements,
        (msgs) => _renderLogList(elements, msgs),
        updateAnalyzeButtonVisibility
      );
    },
    sendMessage: () => _sendMessage({ elements, state, defaults, helpers }),
    loadHistoryList: () => _loadHistoryList(elements, state),
    loadConversation: (id, preserve) => _loadConversation(id, state, elements, helpers, preserve),
    speakText: (text) => _speakText(state, text),
    refreshStats: (id) => refreshStats(id),
    updateConversationStats: (conv) => updateConversationStats(conv),
    displayQualityAssessment: (assessment) => displayQualityAssessment(assessment),
    clearChat: () => clearChat(),
    persistSettings: () => _persistSettings(elements, state, defaults, refreshMessages, (msg, tone) => _setFeedback(elements, msg, tone)),
  };

  // Store helpers reference so history module can call back
  state._helpers = helpers;

  function refreshMessages() {
    elements.chatWindow.innerHTML = '';
    state.stats = { messages: 0, replies: 0 };
    state.history.forEach((msg) => helpers.appendMessage(msg, { persist: false }));
  }

  function clearChat() {
    state.history = [];
    state.conversationId = null;
    state.stats = { messages: 0, replies: 0 };
    elements.chatWindow.innerHTML = '';
    state.threadId = `t-${Date.now().toString(36)}`;
    elements.threadId.textContent = state.threadId;
    helpers.appendMessage(
      { role: 'assistant', id: 'a-welcome', content: 'Chat cleared. Choose a model and say hi!', createdAt: new Date().toISOString() },
      { persist: false, count: false }
    );
    _renderLogList(elements, []);
    updateAnalyzeButtonVisibility();
    if (typeof Toast !== 'undefined') Toast.success('New conversation started');
  }

  function updateAnalyzeButtonVisibility() {
    if (state.conversationId && state.history.length >= 2) {
      elements.analyzeQualityBtn.style.display = 'inline-flex';
    } else {
      elements.analyzeQualityBtn.style.display = 'none';
    }
  }

  // Quality assessment
  async function analyzeConversationQuality() {
    if (!state.conversationId) {
      if (typeof Toast !== 'undefined') Toast.error('No conversation to analyze.');
      return;
    }
    if (state.history.length < 2) {
      if (typeof Toast !== 'undefined') Toast.error('Need at least 2 messages.');
      return;
    }
    elements.analyzeQualityBtn.disabled = true;
    elements.analyzeQualityBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
    try {
      const fetchOptions = { method: 'POST', credentials: 'include' };
      const res = await fetch(`/api/conversations/${state.conversationId}/judge`,
        window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Quality analysis failed');
      displayQualityAssessment(data.data.quality_assessment);
      if (typeof Toast !== 'undefined') Toast.success('Quality analysis complete!');
    } catch (err) {
      console.error('Quality analysis failed:', err);
      if (typeof Toast !== 'undefined') Toast.error(`Analysis failed: ${err.message}`);
    } finally {
      elements.analyzeQualityBtn.disabled = false;
      elements.analyzeQualityBtn.innerHTML = '<i class="fas fa-star"></i> Analyze Quality';
    }
  }

  function displayQualityAssessment(assessment) {
    if (!assessment) return;
    const dimensionLabels = {
      accuracy: 'Accuracy', relevance: 'Relevance', coherence: 'Coherence',
      helpfulness: 'Helpfulness', engagement: 'Engagement',
      context_retention: 'Context Retention', instruction_following: 'Instruction Following',
      response_quality: 'Response Quality', efficiency: 'Efficiency', safety: 'Safety'
    };
    let dimensionHTML = '';
    if (assessment.dimensions) {
      for (const [key, value] of Object.entries(assessment.dimensions)) {
        const label = dimensionLabels[key] || key;
        const percentage = (value / 10) * 100;
        const color = value >= 8 ? '#22c55e' : value >= 6 ? '#eab308' : value >= 4 ? '#f59e0b' : '#ef4444';
        dimensionHTML += `
          <div class="quality-dimension">
            <div class="quality-dimension-label">${label}</div>
            <div class="quality-dimension-bar">
              <div class="quality-dimension-fill" style="width: ${percentage}%; background-color: ${color};"></div>
              <span class="quality-dimension-value">${value.toFixed(1)}/10</span>
            </div>
          </div>`;
      }
    }
    const overallColor = assessment.overall_score >= 80 ? '#22c55e' : assessment.overall_score >= 60 ? '#eab308' : assessment.overall_score >= 40 ? '#f59e0b' : '#ef4444';
    const resultHTML = `
      <div class="bubble assistant quality-assessment">
        <div class="meta">Quality Assessment</div>
        <div class="quality-overall">
          <h3>Overall Score</h3>
          <div class="quality-score-circle" style="border-color: ${overallColor}; color: ${overallColor};">
            ${assessment.overall_score}<span class="quality-score-max">/100</span>
          </div>
        </div>
        <div class="quality-dimensions">${dimensionHTML}</div>
        <div class="quality-explanation">
          <p><strong>Analysis:</strong> ${sanitizeHTML(assessment.explanation || '')}</p>
          <p class="quality-meta">
            Judged by ${sanitizeHTML(assessment.judge_model || '')} \u2022
            ${Number(assessment.conversation_length) || 0} turns \u2022
            Avg latency: ${Number(assessment.avg_latency_ms) || 0}ms
          </p>
        </div>
      </div>`;
    elements.chatWindow.insertAdjacentHTML('beforeend', resultHTML);
    elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
  }

  // Stats
  function updateConversationStats(conversation) {
    if (conversation && conversation.usage) {
      const tokensEl = document.getElementById('conversationTokens');
      const costEl = document.getElementById('conversationCost');
      if (tokensEl) {
        tokensEl.style.display = 'inline-flex';
        const tokenCount = document.getElementById('tokenCount');
        const tokenLimit = document.getElementById('tokenLimit');
        const contextPercentage = document.getElementById('contextPercentage');
        const contextProgressFill = document.getElementById('contextProgressFill');
        const currentTokens = conversation.usage.totalTokens || 0;
        const maxTokens = Number(elements.numCtx?.value) || state.config?.options?.num_ctx || 4096;
        const percentage = Math.min(100, Math.round((currentTokens / maxTokens) * 100));
        if (tokenCount) tokenCount.textContent = currentTokens.toLocaleString();
        if (tokenLimit) tokenLimit.textContent = maxTokens.toLocaleString();
        if (contextPercentage) contextPercentage.textContent = `${percentage}%`;
        if (contextProgressFill) {
          contextProgressFill.style.width = `${percentage}%`;
          contextProgressFill.classList.remove('warning', 'danger');
          if (percentage >= 90) contextProgressFill.classList.add('danger');
          else if (percentage >= 70) contextProgressFill.classList.add('warning');
        }
      }
      if (costEl) {
        costEl.style.display = 'inline-flex';
        const costAmount = document.getElementById('costAmount');
        if (costAmount) costAmount.textContent = '$' + (conversation.usage.estimatedCost || 0).toFixed(4);
      }
    } else {
      const tokensEl = document.getElementById('conversationTokens');
      const costEl = document.getElementById('conversationCost');
      if (tokensEl) tokensEl.style.display = 'none';
      if (costEl) costEl.style.display = 'none';
    }
  }

  async function refreshStats(conversationId) {
    if (!conversationId) return;
    try {
      const url = window.WorkspaceManager
        ? WorkspaceManager.addWorkspaceParam(`/api/history/${conversationId}`)
        : `/api/history/${conversationId}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const responseData = await res.json();
      const data = responseData.data || responseData;
      if (data) updateConversationStats(data);
    } catch (e) {
      console.error('Failed to refresh stats', e);
    }
  }

  // Panel toggles
  function toggleHistoryPanel() {
    if (!elements.page) return;
    elements.page.classList.toggle('history-hidden');
    setHistoryToggleLabels();
  }

  function setHistoryToggleLabels() {
    if (!elements.page) return;
    const isHidden = elements.page.classList.contains('history-hidden');
    if (elements.toggleHistoryBtn) {
      elements.toggleHistoryBtn.title = isHidden ? 'Show history' : 'Hide history';
    }
  }

  function toggleLogPanel() {
    if (!elements.logPanel || !elements.toggleLogBtn) return;
    const isCollapsed = elements.logPanel.classList.toggle('collapsed');
    elements.toggleLogBtn.textContent = isCollapsed ? 'Show session log' : 'Hide session log';
  }

  // Config drawer toggle
  function toggleConfigDrawer() {
    if (!elements.configDrawer) return;
    const isOpen = elements.configDrawer.classList.toggle('open');
    if (elements.configDrawerBackdrop) {
      elements.configDrawerBackdrop.classList.toggle('visible', isOpen);
    }
  }

  function closeConfigDrawer() {
    if (elements.configDrawer) elements.configDrawer.classList.remove('open');
    if (elements.configDrawerBackdrop) elements.configDrawerBackdrop.classList.remove('visible');
  }

  // Auto-resize textarea
  function autoResizeTextarea() {
    const textarea = elements.messageInput;
    textarea.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(textarea).lineHeight) * 6 || 144;
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
  }

  // Character count
  function updateCharCount() {
    const countEl = document.getElementById('charCount');
    if (countEl) {
      const len = elements.messageInput.value.length;
      countEl.textContent = len > 0 ? len.toLocaleString() : '';
    }
  }

  // Event wiring
  function attachEvents() {
    if (elements.micBtn) elements.micBtn.addEventListener('click', () => toggleVoiceInput(elements, state, helpers));
    elements.ttsToggle.addEventListener('change', () => { updateVoiceFieldVisibility(elements); helpers.persistSettings(); });
    const ttsProviderSelect = document.getElementById('ttsProviderSelect');
    if (ttsProviderSelect) ttsProviderSelect.addEventListener('change', () => { updateVoiceFieldVisibility(elements); helpers.persistSettings(); });

    const voiceHeader = document.getElementById('voiceHeader');
    const voiceContent = document.getElementById('voiceContent');
    if (voiceHeader && voiceContent) {
      voiceHeader.addEventListener('click', () => { voiceContent.classList.toggle('hidden'); voiceHeader.classList.toggle('expanded'); });
    }

    if (elements.sttProviderSelect) {
      elements.sttProviderSelect.addEventListener('change', () => { updateVoiceFieldVisibility(elements); helpers.persistSettings(); checkVoiceHealth(elements, state); });
    }
    if (elements.sttLanguageSelect) elements.sttLanguageSelect.addEventListener('change', () => helpers.persistSettings());
    if (elements.whisperModelSelect) elements.whisperModelSelect.addEventListener('change', () => helpers.persistSettings());
    if (elements.voiceAutoSend) elements.voiceAutoSend.addEventListener('change', () => helpers.persistSettings());
    if (elements.claudeCodeToggle) elements.claudeCodeToggle.addEventListener('change', () => helpers.persistSettings());
    if (elements.ttsVoiceSelect) elements.ttsVoiceSelect.addEventListener('change', () => helpers.persistSettings());
    if (elements.testVoiceBtn) elements.testVoiceBtn.addEventListener('click', () => _speakText(state, 'Hello, this is your voice assistant.'));

    elements.sendBtn.addEventListener('click', () => helpers.sendMessage());
    elements.clearBtn.addEventListener('click', clearChat);
    elements.analyzeQualityBtn.addEventListener('click', analyzeConversationQuality);
    elements.refreshModels.addEventListener('click', () => _fetchModels({ elements, state, defaults, helpers }, true));
    elements.saveDefaults.addEventListener('click', () => helpers.persistSettings());

    if (elements.ragPanelHeader) elements.ragPanelHeader.addEventListener('click', () => toggleRagOptions(elements));
    if (elements.ragTopK) {
      elements.ragTopK.addEventListener('input', () => { if (elements.ragTopKValue) elements.ragTopKValue.textContent = elements.ragTopK.value; });
    }

    if (elements.promptInfoBtn) elements.promptInfoBtn.addEventListener('click', showPromptInfo);

    const tuningHeader = document.getElementById('tuningHeader');
    const tuningContent = document.getElementById('tuningContent');
    if (tuningHeader && tuningContent) {
      tuningHeader.addEventListener('click', () => { tuningContent.classList.toggle('hidden'); tuningHeader.classList.toggle('expanded'); });
    }

    // Config drawer
    if (elements.toggleConfigBtn) elements.toggleConfigBtn.addEventListener('click', toggleConfigDrawer);
    if (elements.configDrawerClose) elements.configDrawerClose.addEventListener('click', closeConfigDrawer);
    if (elements.configDrawerBackdrop) elements.configDrawerBackdrop.addEventListener('click', closeConfigDrawer);

    // Keyboard: Enter to send, Shift+Enter for newline
    elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        helpers.sendMessage();
      }
    });

    // Auto-resize textarea
    elements.messageInput.addEventListener('input', () => {
      autoResizeTextarea();
      updateCharCount();
    });

    ['temperature', 'topP'].forEach((key) => {
      elements[key].addEventListener('input', updateRangeDisplays.bind(null, elements));
    });

    elements.modelSelect.addEventListener('change', () => {
      state.settings.model = elements.modelSelect.value;
      helpers.persistSettings();
      updateConfigSummary(elements);
      // Update header bar model badge
      const modelBadgeEl = document.getElementById('headerModelBadge');
      if (modelBadgeEl && !state.agent) modelBadgeEl.textContent = elements.modelSelect.value || '';
    });

    elements.streamToggle.addEventListener('change', () => { helpers.persistSettings(); updateConfigSummary(elements); });
    elements.ragToggle.addEventListener('change', () => {
      helpers.persistSettings();
      updateConfigSummary(elements);
      if (window.checkSetupProgress && elements.ragToggle.checked) setTimeout(() => window.checkSetupProgress(), 500);
    });
    if (elements.webSearchToggle) elements.webSearchToggle.addEventListener('change', () => { helpers.persistSettings(); updateConfigSummary(elements); });
    if (elements.statsToggle) elements.statsToggle.addEventListener('change', () => helpers.persistSettings());

    if (elements.ragExpandQuery) elements.ragExpandQuery.addEventListener('change', () => helpers.persistSettings());
    if (elements.ragHybridSearch) elements.ragHybridSearch.addEventListener('change', () => helpers.persistSettings());
    if (elements.ragRerankResults) elements.ragRerankResults.addEventListener('change', () => helpers.persistSettings());
    if (elements.ragCompress) elements.ragCompress.addEventListener('change', () => helpers.persistSettings());

    elements.hostInput.addEventListener('change', () => { helpers.persistSettings(); _fetchModels({ elements, state, defaults, helpers }, false); });

    elements.quickActions.forEach((btn) => btn.addEventListener('click', () => {
      elements.messageInput.value = btn.dataset.quick;
      elements.messageInput.focus();
      autoResizeTextarea();
      updateCharCount();
    }));

    elements.newChatBtn.addEventListener('click', clearChat);
    elements.profileBtn.addEventListener('click', () => { _loadProfile(elements); elements.profileModal.classList.remove('hidden'); });
    elements.closeProfileBtn.addEventListener('click', () => elements.profileModal.classList.add('hidden'));
    elements.saveProfileBtn.addEventListener('click', () => _saveProfile(elements, (msg, tone) => _setFeedback(elements, msg, tone)));
    elements.resetProfileBtn.addEventListener('click', () => _loadProfile(elements));

    if (elements.toggleHistoryBtn) elements.toggleHistoryBtn.addEventListener('click', toggleHistoryPanel);
    if (elements.closeHistoryBtn) elements.closeHistoryBtn.addEventListener('click', toggleHistoryPanel);
    if (elements.toggleLogBtn) elements.toggleLogBtn.addEventListener('click', toggleLogPanel);
  }

  // Init
  async function init() {
    state.settings = loadSettings(defaults);

    const urlParams = new URLSearchParams(window.location.search);
    const modelParam = urlParams.get('model');
    if (modelParam) state.settings.model = decodeURIComponent(modelParam);

    elements.threadId.textContent = state.threadId;
    hydrateForm(elements, state, defaults);
    updateVoiceFieldVisibility(elements);
    attachEvents();
    clearChat();
    _loadProfile(elements);
    loadActivePrompt();
    loadPromptSelector();
    await loadOllamaHosts(elements, state);
    await _fetchModels({ elements, state, defaults, helpers });

    checkRagAvailability(elements);
    checkVoiceHealth(elements, state);

    reapplyAgentModel(elements, state);

    if (elements.toggleLogBtn) {
      const isCollapsed = elements.logPanel?.classList.contains('collapsed');
      elements.toggleLogBtn.textContent = isCollapsed ? 'Show session log' : 'Hide session log';
    }
    setHistoryToggleLabels();

    document.addEventListener('input', (e) => {
      if (e.target.type === 'range' || e.target.id === 'temperature') updateConfigSummary(elements);
      if (e.target.id === 'numCtx') {
        const tokenLimit = document.getElementById('tokenLimit');
        if (tokenLimit) tokenLimit.textContent = Number(e.target.value).toLocaleString();
        if (state.conversationId) refreshStats(state.conversationId);
      }
    });

    updateConfigSummary(elements);

    const tokenLimit = document.getElementById('tokenLimit');
    if (tokenLimit) tokenLimit.textContent = (state.config?.options?.num_ctx || 4096).toLocaleString();

    wireHistoryTabs(elements, state, helpers);

    const history = await _loadHistoryList(elements, state);
    if (history && history.length > 0) {
      let loaded = false;
      const candidates = history.slice(0, 5);
      for (const item of candidates) {
        loaded = await _loadConversation(item.id, state, elements, helpers);
        if (loaded) break;
      }
      if (!loaded) {
        helpers.setStatus('Ready');
        helpers.setFeedback('Set host/model, then start chatting.');
      }
    } else {
      helpers.setStatus('Ready');
      helpers.setFeedback('Set host/model, then start chatting.');
    }
  }

  loadServerConfig(defaults).then((config) => {
    state.config = config;
    init();
  }).catch(err => {
    console.warn('Server config load failed, using defaults:', err);
    init();
  });

  // Agent system init (parallel, non-blocking)
  initAgentSystem(elements, state, helpers);
});
