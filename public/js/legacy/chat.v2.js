/**
 * Sanitize HTML content to prevent XSS attacks
 * @param {string} dirty - Unsanitized HTML
 * @returns {string} - Sanitized HTML
 */
function sanitizeHTML(dirty) {
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify not loaded - XSS protection disabled!');
    return dirty; // Fallback (not ideal but prevents breaking)
  }

  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 'code', 'pre',
      'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2',
      'h3', 'h4', 'h5', 'h6', 'span', 'div', 'table',
      'thead', 'tbody', 'tr', 'th', 'td', 'img'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id'],
    ALLOW_DATA_ATTR: false
  });
}

// Authentication check
// Auth is now handled by nav.js (checkNavAuth + global window.AgentXAuth)

document.addEventListener('DOMContentLoaded', () => {

  const elements = {
    chatWindow: document.getElementById('chatWindow'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    clearBtn: document.getElementById('clearBtn'),
    analyzeQualityBtn: document.getElementById('analyzeQualityBtn'),
    hostInput: document.getElementById('hostInput'),
    portInput: document.getElementById('portInput'),
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
    // RAG Advanced Options
    ragOptionsPanel: document.getElementById('ragOptionsPanel'),
    ragOptionsContent: document.getElementById('ragOptionsContent'),
    ragPanelHeader: document.getElementById('ragPanelHeader'),
    ragChevron: document.getElementById('ragChevron'),
    ragExpandQuery: document.getElementById('ragExpandQuery'),
    ragHybridSearch: document.getElementById('ragHybridSearch'),
    ragRerankResults: document.getElementById('ragRerankResults'),
    ragCompress: document.getElementById('ragCompress'), // NEW
    ragTopK: document.getElementById('ragTopK'),
    ragTopKValue: document.getElementById('ragTopKValue'),
    statsToggle: document.getElementById('statsToggle'), // V4: New toggle
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
    // Voice Elements
    micBtn: document.getElementById('micBtn'),
    ttsToggle: document.getElementById('ttsToggle'),
    sttProviderSelect: document.getElementById('sttProviderSelect'),
    sttLanguageSelect: document.getElementById('sttLanguageSelect'),
    whisperModelSelect: document.getElementById('whisperModelSelect'),
    whisperModelField: document.getElementById('whisperModelField'),
    voiceAutoSend: document.getElementById('voiceAutoSend'),
    ttsVoiceSelect: document.getElementById('ttsVoiceSelect'),
    ttsVoiceField: document.getElementById('ttsVoiceField'),
    testVoiceBtn: document.getElementById('testVoiceBtn'),
    sttHealthDot: document.getElementById('sttHealthDot'),
    sttHealthDotInner: document.getElementById('sttHealthDotInner'),
    ttsHealthDot: document.getElementById('ttsHealthDot'),
    // New Elements
    historyList: document.getElementById('historyList'),
    resetProfileBtn: document.getElementById('resetProfileBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    profileBtn: document.getElementById('profileBtn'),
    profileModal: document.getElementById('profileModal'),
    closeProfileBtn: document.getElementById('closeProfileBtn'),
    saveProfileBtn: document.getElementById('saveProfileBtn'),
    userAbout: document.getElementById('userAbout'),
    userInstructions: document.getElementById('userInstructions'),
    // Prompt selection elements
    promptSelect: document.getElementById('promptSelect'),
    promptInfoBtn: document.getElementById('promptInfoBtn'),
  };

  // Fetch server config on load
  async function loadServerConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const config = await res.json();
        if (config.ollama) {
          // Add server's configured host to the dropdown if not already present
          const hostSelect = document.getElementById('hostInput');
          const existingOptions = Array.from(hostSelect.options).map(opt => opt.value);
          if (config.ollama.host && !existingOptions.includes(config.ollama.host)) {
            const option = document.createElement('option');
            option.value = config.ollama.host;
            option.textContent = config.ollama.host;
            hostSelect.insertBefore(option, hostSelect.firstChild);
          }
          // Update defaults with server config
          if (config.ollama.host) {
            defaults.host = config.ollama.host;
            defaults.port = config.ollama.port;
          }
          return config;
        }
      }
    } catch (err) {
      console.warn('Could not load server config:', err);
    }
    return null;
  }

  const defaults = {
    host: 'localhost',
    port: '11434',
    model: '',
    stream: true,  // Enable streaming by default for better UX and thinking model support
    tts: false,    // Disable TTS by default
    ttsProvider: 'browser', // 'browser', 'openai', 'local'
    useRag: true,  // Enable RAG by default
    system: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
    options: {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 64,
      num_ctx: 4096,
      repeat_penalty: 1.05,
      presence_penalty: 0,
      frequency_penalty: 0,
      num_predict: 256,
      seed: '',
      stop: '',
      keep_alive: '',
    },
  };

  const state = {
    history: [],
    sending: false,
    stats: { messages: 0, replies: 0 },
    settings: null, // Will be loaded after server config
    threadId: buildThreadId(),
    profile: { language: '', role: '', style: '' },
    conversationId: null, // Current conversation ID
    agentId: null, // V7: AgentX Integration
    agent: null, // V7: Selected Agent Object
    showStats: true, // V4: Toggle message stats
    eventSource: null,
    streamAbortController: null,
    config: null // Server configuration
  };

  const streamParams = new URLSearchParams(window.location.search);

  function resolveStreamEnabled() {
    const override = streamParams.get('stream');
    const fallback = elements.streamToggle ? elements.streamToggle.checked : false;
    if (override === null) return fallback;
    return !['0', 'false', 'off', 'disabled'].includes(override.toLowerCase());
  }

  function resolveStreamTransport() {
    return (streamParams.get('streamTransport') || 'fetch').toLowerCase();
  }

  function encodeStreamPayload(payload) {
    const json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)));
  }

  function buildThreadId() {
    return `t-${Date.now().toString(36)}`;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem('agentx-settings');
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      // If saved host is localhost but defaults have been updated with server config, use defaults
      if (parsed.host === 'localhost' && defaults.host !== 'localhost') {
        parsed.host = defaults.host;
        parsed.port = defaults.port;
      }
      return {
        ...defaults,
        ...parsed,
        options: { ...defaults.options, ...(parsed.options || {}) },
      };
    } catch (e) {
      console.warn('Failed to read saved settings', e);
      return { ...defaults };
    }
  }

  function persistSettings() {
    const payload = {
      host: elements.hostInput.value.trim() || defaults.host,
      port: elements.portInput.value.trim() || defaults.port,
      model: elements.modelSelect.value,
      stream: elements.streamToggle.checked,
      tts: elements.ttsToggle.checked,
      ttsProvider: document.getElementById('ttsProviderSelect')?.value || 'browser',
      ttsVoice: elements.ttsVoiceSelect?.value || 'alloy',
      sttProvider: elements.sttProviderSelect?.value || 'auto',
      sttLanguage: elements.sttLanguageSelect?.value || 'en',
      whisperModel: elements.whisperModelSelect?.value || '',
      voiceAutoSend: elements.voiceAutoSend?.checked || false,
      useRag: elements.ragToggle.checked,
      showStats: elements.statsToggle.checked, // V4: Save stats preference
      // RAG Advanced Options
      ragExpand: elements.ragExpandQuery?.checked || false,
      ragHybrid: elements.ragHybridSearch?.checked || false,
      ragRerank: elements.ragRerankResults?.checked || false,
      ragCompress: elements.ragCompress?.checked || false, // NEW
      ragTopK: parseInt(elements.ragTopK?.value || '5', 10),
      system: elements.systemPrompt.value.trim() || defaults.system,
      options: readOptions(),
    };
    localStorage.setItem('agentx-settings', JSON.stringify(payload));
    state.settings = payload;
    state.showStats = payload.showStats; // Update state immediately
    // Re-render chat to toggle stats visibility without refresh
    refreshMessages();
    setFeedback('Defaults saved locally.', 'success');
  }

  function readOptions() {
    return {
      temperature: Number(elements.temperature.value),
      top_p: Number(elements.topP.value),
      top_k: Number(elements.topK.value),
      num_ctx: Number(elements.numCtx.value),
      repeat_penalty: Number(elements.repeatPenalty.value),
      presence_penalty: Number(elements.presencePenalty.value),
      frequency_penalty: Number(elements.frequencyPenalty.value),
      num_predict: Number(elements.numPredict.value),
      seed: elements.seed.value || '',
      stop: elements.stopSequences.value,
      keep_alive: elements.keepAlive.value,
    };
  }

  // RAG Advanced Options Toggle
  function toggleRagOptions() {
    const content = elements.ragOptionsContent;
    const chevron = elements.ragChevron;
    if (!content || !chevron) return;

    const isOpen = content.style.display === 'block';
    content.style.display = isOpen ? 'none' : 'block';
    chevron.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
  }

  // Get RAG advanced options from UI
  function getRagOptions() {
    const useRag = elements.ragToggle?.checked;
    if (!useRag) {
      return { useRag: false };
    }

    return {
      useRag: true,
      ragExpand: elements.ragExpandQuery?.checked || false,
      ragHybrid: elements.ragHybridSearch?.checked || false,
      ragRerank: elements.ragRerankResults?.checked || false,
      ragCompress: elements.ragCompress?.checked || false, // NEW
      ragTopK: parseInt(elements.ragTopK?.value || '5', 10)
    };
  }

  // Check RAG availability and show/hide panel
  async function checkRagAvailability() {
    try {
      const response = await fetch('/api/rag/metrics', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'success' && data.stats?.totalDocuments > 0) {
          if (elements.ragOptionsPanel) {
            elements.ragOptionsPanel.style.display = 'block';
          }
        } else {
          if (elements.ragOptionsPanel) {
            elements.ragOptionsPanel.style.display = 'none';
          }
        }
      }
    } catch (error) {
      console.warn('RAG availability check failed:', error);
      if (elements.ragOptionsPanel) {
        elements.ragOptionsPanel.style.display = 'none';
      }
    }
  }

  function hydrateForm() {
    const cfg = state.settings;
    state.showStats = cfg.showStats !== undefined ? cfg.showStats : true; // Default true

    // Use saved settings if they exist, otherwise use defaults (which may include server config)
    elements.hostInput.value = cfg.host || defaults.host;
    elements.portInput.value = cfg.port || defaults.port;
    elements.modelSelect.value = cfg.model;
    elements.systemPrompt.value = cfg.system;
    elements.streamToggle.checked = cfg.stream;
    elements.ttsToggle.checked = cfg.tts || false;
    const ttsProviderSelect = document.getElementById('ttsProviderSelect');
    const ttsProviderField = document.getElementById('ttsProviderField');
    if (ttsProviderSelect) ttsProviderSelect.value = cfg.ttsProvider || 'browser';
    if (ttsProviderField) ttsProviderField.style.display = cfg.tts ? '' : 'none';
    // Voice I/O settings
    if (elements.sttProviderSelect) elements.sttProviderSelect.value = cfg.sttProvider || 'auto';
    if (elements.sttLanguageSelect) elements.sttLanguageSelect.value = cfg.sttLanguage || 'en';
    if (elements.whisperModelSelect) elements.whisperModelSelect.value = cfg.whisperModel || '';
    if (elements.voiceAutoSend) elements.voiceAutoSend.checked = cfg.voiceAutoSend || false;
    if (elements.ttsVoiceSelect) elements.ttsVoiceSelect.value = cfg.ttsVoice || 'alloy';
    updateVoiceFieldVisibility();
    elements.ragToggle.checked = cfg.useRag !== undefined ? cfg.useRag : true;
    elements.statsToggle.checked = state.showStats; // V4
    // RAG Advanced Options
    if (elements.ragExpandQuery) elements.ragExpandQuery.checked = cfg.ragExpand || false;
    if (elements.ragHybridSearch) elements.ragHybridSearch.checked = cfg.ragHybrid || false;
    if (elements.ragRerankResults) elements.ragRerankResults.checked = cfg.ragRerank || false;
    if (elements.ragCompress) elements.ragCompress.checked = cfg.ragCompress || false; // NEW
    if (elements.ragTopK) elements.ragTopK.value = cfg.ragTopK || 5;
    if (elements.ragTopKValue) elements.ragTopKValue.textContent = cfg.ragTopK || 5;
    elements.temperature.value = cfg.options.temperature;
    elements.topP.value = cfg.options.top_p;
    elements.topK.value = cfg.options.top_k;
    elements.numCtx.value = cfg.options.num_ctx;
    elements.repeatPenalty.value = cfg.options.repeat_penalty;
    elements.presencePenalty.value = cfg.options.presence_penalty;
    elements.frequencyPenalty.value = cfg.options.frequency_penalty;
    elements.numPredict.value = cfg.options.num_predict;
    elements.seed.value = cfg.options.seed || '';
    elements.stopSequences.value = cfg.options.stop || '';
    elements.keepAlive.value = cfg.options.keep_alive || '';
    updateRangeDisplays();
  }

  function updateRangeDisplays() {
    document.querySelectorAll('.value[data-for="temperature"]').forEach((el) => {
      el.textContent = elements.temperature.value;
    });
    document.querySelectorAll('.value[data-for="topP"]').forEach((el) => {
      el.textContent = elements.topP.value;
    });
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(text, tone = 'muted') {
    elements.statusChip.textContent = text;
    const color = tone === 'success' ? '#7cf0ff' : tone === 'error' ? '#ff9ca0' : '#93a0b5';
    elements.statusChip.style.color = color;
  }

  function setFeedback(text, tone = 'muted') {
    elements.feedback.textContent = text;
    elements.feedback.style.color = tone === 'success' ? '#9ff6ff' : tone === 'error' ? '#ffb3b8' : 'var(--muted)';
  }

  function renderMessage(message) {
    const role = message.role;
    const content = message.content;
    const messageId = message.id || message._id || null;
    const createdAt = message.createdAt || new Date().toISOString();
    
    // Check if this is a system message (welcome, etc.)
    const isSystemMessage = messageId && messageId.startsWith('a-');

    const bubble = document.createElement('div');
    bubble.className = `bubble ${role === 'user' ? 'user' : isSystemMessage ? 'system' : 'assistant'}`;
    if (messageId) bubble.dataset.id = messageId;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span>${role === 'user' ? 'You' : role === 'system' ? 'System' : 'AgentX'}</span>`;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(createdAt);
    meta.appendChild(document.createTextNode(' • '));
    meta.appendChild(time);

    const body = document.createElement('div');
    if (typeof marked !== 'undefined') {
      try {
          body.innerHTML = sanitizeHTML(marked.parse(content));
      } catch (err) {
          console.error('Markdown rendering failed:', err);
          body.textContent = content;
      }
    } else {
      body.textContent = content;
    }

    bubble.appendChild(meta);
    bubble.appendChild(body);
    
    // V6: RAG Citation Display (2026-01-07)
    if (role === 'assistant' && message.ragSources && Array.isArray(message.ragSources) && message.ragSources.length > 0) {
      const citationsDiv = document.createElement('details');
      citationsDiv.className = 'message-citations';
      
      const citationsTitle = document.createElement('summary');
      citationsTitle.className = 'citations-title';
      citationsTitle.style.cursor = 'pointer';
      citationsTitle.style.listStyle = 'none'; // Hide default marker
      citationsTitle.innerHTML = '<i class="fas fa-chevron-right" style="font-size: 0.8em; margin-right: 6px; transition: transform 0.2s;"></i><i class="fas fa-book"></i><span>Sources</span>';
      citationsDiv.appendChild(citationsTitle);
      
      // Add event listener for rotation effect
      citationsDiv.addEventListener('toggle', () => {
        const icon = citationsTitle.querySelector('.fa-chevron-right');
        if (citationsDiv.open) {
          icon.style.transform = 'rotate(90deg)';
        } else {
          icon.style.transform = 'rotate(0deg)';
        }
      });
      
      message.ragSources.forEach((source, idx) => {
        const sourceItem = document.createElement('div');
        sourceItem.className = 'citation-item';
        sourceItem.setAttribute('role', 'button');
        sourceItem.setAttribute('tabindex', '0');
        sourceItem.setAttribute('aria-label', `View source ${idx + 1}: ${source.metadata?.filename || 'Unknown Source'}`);
        
        const sourceHeader = document.createElement('div');
        
        const sourceNum = document.createElement('span');
        sourceNum.className = 'citation-number';
        sourceNum.textContent = `[${idx + 1}]`;
        
        const sourceTitle = document.createElement('span');
        sourceTitle.className = 'citation-title';
        sourceTitle.textContent = source.metadata?.filename || 'Unknown Source';
        
        const sourceScore = document.createElement('span');
        sourceScore.className = 'citation-score';
        if (source.score) {
          const scorePercent = (source.score * 100).toFixed(0);
          sourceScore.textContent = `${scorePercent}% match`;
        }
        
        sourceHeader.appendChild(sourceNum);
        sourceHeader.appendChild(sourceTitle);
        if (source.score) {
          sourceHeader.appendChild(sourceScore);
        }
        
        // NEW: Compression Badge
        if (source.wasCompressed) {
            const compressBadge = document.createElement('span');
            compressBadge.className = 'compression-badge';
            compressBadge.innerHTML = `<i class="fas fa-compress-arrows-alt"></i> ${source.compressionRatio}%`;
            compressBadge.title = 'Context compressed by ' + source.compressionRatio + '%';
            sourceHeader.appendChild(compressBadge);
        }

        sourceItem.appendChild(sourceHeader);
        
        if (source.excerpt) {
          const sourceExcerpt = document.createElement('div');
          sourceExcerpt.className = 'citation-excerpt';
          sourceExcerpt.textContent = `"${source.excerpt}${source.excerpt.length >= 200 ? '...' : ''}"`;
          sourceItem.appendChild(sourceExcerpt);
        }
        
        // Click and keyboard handler
        const viewSource = () => {
          console.log('View source:', source);
          // Future: Open document viewer modal
          setFeedback(`Viewing source: ${source.metadata?.filename || 'Unknown'}`, 'info');
        };
        
        sourceItem.addEventListener('click', viewSource);
        sourceItem.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            viewSource();
          }
        });
        
        citationsDiv.appendChild(sourceItem);
      });
      
      bubble.appendChild(citationsDiv);
    }

    // V4: Stats Footer + V5: Cost Display
    if (state.showStats && role === 'assistant' && (message.stats || message.cost)) {
      const statsDiv = document.createElement('div');
      statsDiv.className = 'message-stats';
      statsDiv.style.fontSize = '0.75rem';
      statsDiv.style.color = 'var(--muted)';
      statsDiv.style.marginTop = '0.5rem';
      statsDiv.style.paddingTop = '0.5rem';
      statsDiv.style.borderTop = '1px solid rgba(255,255,255,0.05)';

      const parts = [];

      if (message.stats) {
        const { usage, performance } = message.stats;
        if (usage) {
          parts.push(`${usage.totalTokens} tokens`);
        }
        if (performance) {
          const duration = (performance.totalDuration / 1e9).toFixed(2);
          const tps = performance.tokensPerSecond ? `(${performance.tokensPerSecond} t/s)` : '';
          parts.push(`${duration}s ${tps}`);
        }
      }

      if (message.cost && message.cost.totalCost > 0) {
        const cost = message.cost.totalCost;
        const costStr = cost < 0.01 ? `$${cost.toFixed(6)}` : `$${cost.toFixed(4)}`;
        parts.push(costStr);
      }

      if (parts.length > 0) {
        statsDiv.textContent = parts.join(' • ');
        bubble.appendChild(statsDiv);
      }
    }

    // Only render feedback controls for actual AI responses (exclude system messages like welcome)
    if (role === 'assistant' && messageId && !messageId.startsWith('a-')) {
      bubble.appendChild(buildFeedbackRow(messageId));
    }

    elements.chatWindow.appendChild(bubble);
    elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
  }

  function buildFeedbackRow(messageId) {
    const row = document.createElement('div');
    row.className = 'feedback-row';

    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = 'Feedback';
    row.appendChild(label);

    const comment = document.createElement('input');
    comment.type = 'text';
    comment.placeholder = 'Why? (optional)';
    comment.style.flex = '1';

    const status = document.createElement('span');
    status.className = 'muted';

    const send = async (rating) => {
      try {
        // Disable controls while sending
        up.disabled = true;
        down.disabled = true;
        comment.disabled = true;

        await sendFeedback(messageId, rating, comment.value);
        
        // Hide controls on success
        up.style.display = 'none';
        down.style.display = 'none';
        comment.style.display = 'none';
        label.style.display = 'none';

        status.textContent = rating > 0 ? 'Thanks! Marked helpful.' : 'Noted. Feedback saved.';
      } catch (err) {
        status.textContent = err.message;
        // Re-enable on error
        up.disabled = false;
        down.disabled = false;
        comment.disabled = false;
      }
    };

    const up = document.createElement('button');
    up.className = 'ghost';
    up.textContent = '👍';
    up.title = 'Good answer';
    up.addEventListener('click', () => send(1));

    const down = document.createElement('button');
    down.className = 'ghost';
    down.textContent = '👎';
    down.title = 'Needs work';
    down.addEventListener('click', () => send(-1));

    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(comment);
    row.appendChild(status);

    return row;
  }

  function appendMessage(messageOrRole, contentOrOptions = {}, maybeOptions = {}) {
    const isStringPayload = typeof messageOrRole === 'string';
    const options = isStringPayload ? maybeOptions : contentOrOptions || {};
    const persist = options.persist !== false;
    const count = options.count !== false;

    const message = isStringPayload
      ? {
          role: messageOrRole,
          content: contentOrOptions || '',
          createdAt: options.createdAt || new Date().toISOString(),
          id: options.messageId || `m-${Date.now()}`,
          feedback: options.feedback,
        }
      : {
          ...messageOrRole,
          createdAt: messageOrRole.createdAt || new Date().toISOString(),
        };

    renderMessage(message);

    if (persist) {
      state.history.push(message);
    }
    if (count) {
      if (message.role === 'user') {
        state.stats.messages += 1;
      }
      if (message.role === 'assistant') {
        state.stats.replies += 1;
      }
    }
    // Show only AI assistant message count
    elements.statMessages.textContent = state.stats.replies;
    renderLogList(state.history);
    updateAnalyzeButtonVisibility();
  }

  function renderLogList(messages) {
    if (!elements.logWindow) return;
    elements.logWindow.innerHTML = '';
    const recent = (messages || []).slice(-8).reverse();
    recent.forEach((msg) => {
      const item = document.createElement('div');
      item.className = 'log-item';
      const left = document.createElement('div');
      left.innerHTML = `<strong>${msg.role === 'user' ? 'User' : 'AgentX'}</strong><div class="log-meta">${formatTime(
        msg.createdAt,
      )}</div>`;
      const right = document.createElement('div');
      right.className = 'log-meta';
      right.textContent = `${msg.content.slice(0, 42)}${msg.content.length > 42 ? '…' : ''}`;
      item.appendChild(left);
      item.appendChild(right);
      elements.logWindow.appendChild(item);
    });
  }

  function clearChat() {
    state.history = [];
    state.conversationId = null;
    state.stats = { messages: 0, replies: 0 };
    elements.chatWindow.innerHTML = '';
    state.threadId = buildThreadId();
    elements.threadId.textContent = state.threadId;
    appendMessage(
      {
        role: 'assistant',
        id: 'a-welcome',
        content: 'Chat cleared. Choose a model and say hi!',
        createdAt: new Date().toISOString(),
      },
      { persist: false, count: false },
    );
    renderLogList([]);
    updateAnalyzeButtonVisibility();

    // User feedback
    if (typeof Toast !== 'undefined') {
      Toast.success('New conversation started');
    }
  }

  // Phase 3 Week 11: Conversation Quality Judging
  async function analyzeConversationQuality() {
    if (!state.conversationId) {
      if (typeof Toast !== 'undefined') {
        Toast.error('No conversation to analyze. Start a conversation first.');
      }
      return;
    }

    // Check if conversation has at least 2 messages (1 user + 1 assistant)
    if (state.history.length < 2) {
      if (typeof Toast !== 'undefined') {
        Toast.error('Conversation must have at least 2 messages to analyze.');
      }
      return;
    }

    // Show loading state
    elements.analyzeQualityBtn.disabled = true;
    elements.analyzeQualityBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';

    try {
      const fetchOptions = {
        method: 'POST',
        credentials: 'include'
      };

      const res = await fetch(
        `/api/conversations/${state.conversationId}/judge`,
        window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.status !== 'success') {
        throw new Error(data.message || 'Quality analysis failed');
      }

      // Display quality assessment
      displayQualityAssessment(data.data.quality_assessment);

      if (typeof Toast !== 'undefined') {
        Toast.success('Quality analysis complete!');
      }

    } catch (err) {
      console.error('Quality analysis failed:', err);
      if (typeof Toast !== 'undefined') {
        Toast.error(`Analysis failed: ${err.message}`);
      }
    } finally {
      // Restore button
      elements.analyzeQualityBtn.disabled = false;
      elements.analyzeQualityBtn.innerHTML = '<i class="fas fa-star"></i> Analyze Quality';
    }
  }

  function displayQualityAssessment(assessment) {
    if (!assessment) return;

    const dimensionLabels = {
      accuracy: 'Accuracy',
      relevance: 'Relevance',
      coherence: 'Coherence',
      helpfulness: 'Helpfulness',
      engagement: 'Engagement',
      context_retention: 'Context Retention',
      instruction_following: 'Instruction Following',
      response_quality: 'Response Quality',
      efficiency: 'Efficiency',
      safety: 'Safety'
    };

    // Build dimension bars
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
          </div>
        `;
      }
    }

    const overallColor = assessment.overall_score >= 80 ? '#22c55e' :
                         assessment.overall_score >= 60 ? '#eab308' :
                         assessment.overall_score >= 40 ? '#f59e0b' : '#ef4444';

    const resultHTML = `
      <div class="bubble assistant quality-assessment">
        <div class="meta">Quality Assessment</div>
        <div class="quality-overall">
          <h3>Overall Score</h3>
          <div class="quality-score-circle" style="border-color: ${overallColor}; color: ${overallColor};">
            ${assessment.overall_score}<span class="quality-score-max">/100</span>
          </div>
        </div>
        <div class="quality-dimensions">
          ${dimensionHTML}
        </div>
        <div class="quality-explanation">
          <p><strong>Analysis:</strong> ${sanitizeHTML(assessment.explanation || '')}</p>
          <p class="quality-meta">
            Judged by ${sanitizeHTML(assessment.judge_model || '')} •
            ${Number(assessment.conversation_length) || 0} turns •
            Avg latency: ${Number(assessment.avg_latency_ms) || 0}ms
          </p>
        </div>
      </div>
    `;

    // Append to chat window
    elements.chatWindow.insertAdjacentHTML('beforeend', resultHTML);
    elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
  }

  function updateAnalyzeButtonVisibility() {
    // Show button if conversation has at least 2 messages and conversationId exists
    if (state.conversationId && state.history.length >= 2) {
      elements.analyzeQualityBtn.style.display = 'inline-flex';
    } else {
      elements.analyzeQualityBtn.style.display = 'none';
    }
  }

  function targetHost() {
    const rawHost = elements.hostInput.value.trim() || defaults.host;
    const port = elements.portInput.value.trim() || defaults.port;
    if (/^https?:\/\//i.test(rawHost)) {
      return rawHost.replace(/\/+$/, '');
    }
    if (rawHost.includes(':')) return rawHost;
    return `${rawHost}:${port}`;
  }

  async function fetchModels(showStatus = true) {
    if (showStatus) setStatus('Connecting…');
    try {
      const fetchOptions = {};
      const res = await fetch(
        `/api/ollama/models?target=${encodeURIComponent(targetHost())}`,
        window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
      );
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const data = await res.json();
      if (data.status !== 'success') {
        throw new Error(data.message || 'Unable to load models');
      }
      elements.modelSelect.innerHTML = '';
      if (!data.data || data.data.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models found';
        elements.modelSelect.appendChild(opt);
      } else {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a model…';
        elements.modelSelect.appendChild(placeholder);
        data.data.forEach((model) => {
          const opt = document.createElement('option');
          opt.value = model.name;
          opt.textContent = model.name;
          elements.modelSelect.appendChild(opt);
        });
        if (state.settings.model) {
          elements.modelSelect.value = state.settings.model;
        }
      }
      setStatus(`Connected to ${targetHost()}`, 'success');
      setFeedback('Models refreshed from Ollama.', 'success');
      updateConfigSummary();
    } catch (err) {
      console.warn('Failed to fetch models:', err.message);
      setStatus('Connection failed', 'error');
      
      // Parse error message for better user feedback
      let userMessage = 'Unable to connect to Ollama.';
      if (err.message.includes('EHOSTUNREACH') || err.message.includes('ECONNREFUSED')) {
        userMessage = `Cannot reach ${targetHost()}. Check if Ollama is running and the host/port are correct.`;
      } else if (err.message.includes('ETIMEDOUT')) {
        userMessage = `Connection to ${targetHost()} timed out. Check network and firewall settings.`;
      } else if (err.message.includes('500')) {
        userMessage = err.message;
      }
      
      setFeedback(userMessage, 'error');
      // Add a default option so UI doesn't break
      elements.modelSelect.innerHTML = '<option value="">⚠️ Connection failed</option>';
    }
  }



  function readProfileInputs() {
    return {
      language: elements.memoryLanguage.value.trim(),
      role: elements.memoryRole.value.trim(),
      style: elements.memoryStyle.value.trim(),
    };
  }

  function refreshMessages() {
    elements.chatWindow.innerHTML = '';
    state.stats = { messages: 0, replies: 0 };
    state.history.forEach((msg) => appendMessage(msg, { persist: false }));
  }

  async function sendFeedback(messageId, rating, comment) {
    const payload = { conversationId: state.conversationId, messageId, rating, comment };
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
      throw new Error(data.message || 'Feedback failed');
    }
  }

  // Streaming message handler (SSE via fetch)
  async function sendMessageStreamFetch(msgInput, modelInput) {
    const message = msgInput || elements.messageInput.value.trim();
    const model = modelInput || elements.modelSelect.value;

    const ragOpts = getRagOptions();

    const payload = {
      target: targetHost(),
      model,
      system: elements.systemPrompt.value.trim(),
      options: {
        ...readOptions(),
        persona: elements.promptSelect?.value || 'default_chat',
        ragExpand: ragOpts.ragExpand,
        ragHybrid: ragOpts.ragHybrid,
        ragRerank: ragOpts.ragRerank,
        ragCompress: ragOpts.ragCompress
      },
      useRag: ragOpts.useRag,
      ragTopK: ragOpts.ragTopK,
      threadId: state.threadId,
      agentId: state.agentId, // V7: AgentX
      message,
      profile: readProfileInputs(),
      messages: state.history,
      conversationId: state.conversationId
    };

    // Create placeholder assistant message for progressive rendering
    const assistantMessageId = `a-${Date.now()}`;
    const assistantMessageDiv = document.createElement('div');
    assistantMessageDiv.className = 'message assistant';
    assistantMessageDiv.dataset.messageId = assistantMessageId;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    assistantMessageDiv.appendChild(contentDiv);

    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'thinking-content';
    thinkingDiv.style.display = 'none';
    thinkingDiv.innerHTML = '<strong>Thinking:</strong><br>';
    assistantMessageDiv.appendChild(thinkingDiv);

    elements.chatWindow.appendChild(assistantMessageDiv);
    elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;

    // Change button to "Stop"
    elements.sendBtn.textContent = 'Stop';
    elements.sendBtn.onclick = () => {
      if (state.streamAbortController) {
        state.streamAbortController.abort();
        state.streamAbortController = null;
      }
      state.sending = false;
      elements.sendBtn.textContent = 'Send';
      elements.sendBtn.onclick = () => sendMessage();
      setFeedback('Streaming stopped.', 'warning');
    };

    let fullContent = '';
    let thinkingContent = '';
    let doneReceived = false;

    const safeParseJson = (text, fallback) => {
      try {
        return JSON.parse(text);
      } catch {
        return fallback;
      }
    };

    const dispatchEvent = (eventName, rawData) => {
      if (eventName === 'token') {
        const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
        fullContent += data.content || '';
        try {
          contentDiv.innerHTML = sanitizeHTML(marked.parse(fullContent));
        } catch (e) {
          console.error('Fetch stream render failed:', e);
          contentDiv.textContent = fullContent;
        }
        elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
        return;
      }

      if (eventName === 'thinking') {
        const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
        thinkingContent += data.content || '';
        thinkingDiv.innerHTML = `<strong>Thinking:</strong><br>${marked.parse(thinkingContent)}`;
        thinkingDiv.style.display = 'block';
        elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
        return;
      }

      if (eventName === 'done') {
        const finalData = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
        state.conversationId = finalData.conversationId || state.conversationId;

        const assistantMessage = {
          role: 'assistant',
          content: fullContent,
          createdAt: new Date().toISOString(),
          id: finalData.messageId || null,
          stats: finalData.stats || null,
          thinking: thinkingContent || null
        };

        if (elements.chatWindow.contains(assistantMessageDiv)) {
          elements.chatWindow.removeChild(assistantMessageDiv);
        }
        appendMessage(assistantMessage);

        speakText(fullContent);
        setFeedback('Response received.', 'success');
        loadHistoryList();

        if (state.conversationId) {
          loadConversation(state.conversationId, true);
        }

        if (window.checkSetupProgress) {
          setTimeout(() => window.checkSetupProgress(), 500);
        }
        doneReceived = true;
        return;
      }

      if (eventName === 'error') {
        const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
        const message = data.message || 'Streaming failed.';
        throw new Error(message);
      }
    };

    const parseAndDispatchSse = (chunk, bufferState) => {
      bufferState.buffer += chunk;
      bufferState.buffer = bufferState.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      let sepIndex;
      while ((sepIndex = bufferState.buffer.indexOf('\n\n')) !== -1) {
        const frame = bufferState.buffer.slice(0, sepIndex);
        bufferState.buffer = bufferState.buffer.slice(sepIndex + 2);
        if (!frame.trim()) continue;

        const lines = frame.split('\n');
        let eventName = 'message';
        const dataLines = [];
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith(':')) continue; // heartbeat / comment
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim() || 'message';
            continue;
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
          }
        }
        const data = dataLines.join('\n');
        if (eventName !== 'message') {
          dispatchEvent(eventName, data);
        }
      }
    };

    try {
      const abortController = new AbortController();
      state.streamAbortController = abortController;

      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
        signal: abortController.signal
      };

      const res = await fetch('/api/chat/stream',
        window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Streaming failed (${res.status})`);
      }

      if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('Streaming not supported by this browser/proxy (no readable stream).');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const bufferState = { buffer: '' };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        parseAndDispatchSse(text, bufferState);
        if (doneReceived) {
          abortController.abort();
        }
      }

      // If stream ended without "done", finalize what we have
      if (!doneReceived) {
        if (elements.chatWindow.contains(assistantMessageDiv)) {
          elements.chatWindow.removeChild(assistantMessageDiv);
        }
        appendMessage({ role: 'assistant', content: fullContent || '(no content)', createdAt: new Date().toISOString() });
        setFeedback('Response received.', 'success');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (elements.chatWindow.contains(assistantMessageDiv)) {
          elements.chatWindow.removeChild(assistantMessageDiv);
        }
        if (fullContent || thinkingContent) {
          appendMessage(
            { role: 'assistant', content: fullContent || '(stopped)', createdAt: new Date().toISOString(), thinking: thinkingContent || null },
            { persist: false }
          );
        }
        return;
      }
      console.error('Fetch streaming error:', err);
      if (elements.chatWindow.contains(assistantMessageDiv)) {
        elements.chatWindow.removeChild(assistantMessageDiv);
      }
      appendMessage(
        { role: 'assistant', content: `⚠️ ${err.message || 'Streaming failed.'}`, createdAt: new Date().toISOString() },
        { persist: false }
      );
      setFeedback(err.message, 'error');
    } finally {
      state.streamAbortController = null;
      state.sending = false;
      elements.sendBtn.textContent = 'Send';
      elements.sendBtn.onclick = () => sendMessage();
    }
  }

  // OLD BROKEN IMPLEMENTATION (Disabled)
  // Streaming message handler (SSE via EventSource)
  async function sendMessageStreamEventSource(msgInput, modelInput) {
    const message = msgInput || elements.messageInput.value.trim();
    const model = modelInput || elements.modelSelect.value;
    const ragOpts = getRagOptions();

    const payload = {
      target: targetHost(),
      model,
      system: elements.systemPrompt.value.trim(),
      options: {
        ...readOptions(),
        persona: elements.promptSelect?.value || 'default_chat',
        ragExpand: ragOpts.ragExpand,
        ragHybrid: ragOpts.ragHybrid,
        ragRerank: ragOpts.ragRerank,
        ragCompress: ragOpts.ragCompress
      },
      useRag: ragOpts.useRag,
      ragTopK: ragOpts.ragTopK,
      threadId: state.threadId,
      agentId: state.agentId, // V7: AgentX
      message,
      profile: readProfileInputs(),
      messages: state.history,
      conversationId: state.conversationId
    };

    // EventSource is GET-only; keep URLs small to avoid 431/414 errors.
    // If the payload is large (history, RAG context, etc.), switch to fetch POST streaming.
    let encodedPayload = '';
    try {
      encodedPayload = encodeStreamPayload(payload);
      if (encodedPayload.length > 1500) {
        console.warn('EventSource payload too large; switching to fetch streaming transport.');
        return sendMessageStreamFetch(message, model);
      }
    } catch (e) {
      console.warn('Failed to encode EventSource payload; switching to fetch streaming transport.', e);
      return sendMessageStreamFetch(message, model);
    }

    // Create placeholder assistant message for progressive rendering
    const assistantMessageId = `a-${Date.now()}`;
    const assistantMessageDiv = document.createElement('div');
    assistantMessageDiv.className = 'message assistant';
    assistantMessageDiv.dataset.messageId = assistantMessageId;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    assistantMessageDiv.appendChild(contentDiv);

    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'thinking-content';
    thinkingDiv.style.display = 'none';
    thinkingDiv.innerHTML = '<strong>Thinking:</strong><br>';
    assistantMessageDiv.appendChild(thinkingDiv);

    elements.chatWindow.appendChild(assistantMessageDiv);
    elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;

    // Change button to "Stop"
    elements.sendBtn.textContent = 'Stop';
    elements.sendBtn.onclick = () => {
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      state.sending = false;
      elements.sendBtn.textContent = 'Send';
      elements.sendBtn.onclick = () => sendMessage();
      setFeedback('Streaming stopped.', 'warning');
    };

    let fullContent = '';
    let thinkingContent = '';

    try {
      let streamUrl = `/api/chat/stream?payload=${encodeURIComponent(encodedPayload)}`;
      if (window.WorkspaceManager) {
        streamUrl = WorkspaceManager.addWorkspaceParam(streamUrl);
      }

      const eventSource = new EventSource(streamUrl, { withCredentials: true });
      state.eventSource = eventSource;

      eventSource.addEventListener('token', (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        fullContent += data.content;

        try {
            contentDiv.innerHTML = sanitizeHTML(marked.parse(fullContent));
        } catch (e) {
            console.error('EventSource render failed:', e);
            contentDiv.textContent = fullContent;
        }

        elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      });

      eventSource.addEventListener('thinking', (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        thinkingContent += data.content;
        thinkingDiv.innerHTML = `<strong>Thinking:</strong><br>${sanitizeHTML(marked.parse(thinkingContent))}`;
        thinkingDiv.style.display = 'block';
        elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      });

      eventSource.addEventListener('done', (event) => {
        let finalData;
        try { finalData = JSON.parse(event.data); } catch { finalData = {}; }
        state.conversationId = finalData.conversationId || state.conversationId;

        const assistantMessage = {
          role: 'assistant',
          content: fullContent,
          createdAt: new Date().toISOString(),
          id: finalData.messageId || null,
          stats: finalData.stats || null,
          thinking: thinkingContent || null
        };

        if (elements.chatWindow.contains(assistantMessageDiv)) {
          elements.chatWindow.removeChild(assistantMessageDiv);
        }
        appendMessage(assistantMessage);

        if (state.eventSource) {
          state.eventSource.close();
          state.eventSource = null;
        }

        state.sending = false;
        elements.sendBtn.textContent = 'Send';
        elements.sendBtn.onclick = () => sendMessage();

        speakText(fullContent);
        setFeedback('Response received.', 'success');
        loadHistoryList();

        if (state.conversationId) {
          loadConversation(state.conversationId, true);
        }

        if (window.checkSetupProgress) {
          setTimeout(() => window.checkSetupProgress(), 500);
        }
      });

      eventSource.addEventListener('error', (event) => {
        if (state.eventSource) {
          state.eventSource.close();
          state.eventSource = null;
        }
        let data = { message: 'Streaming failed.' };
        if (event?.data) {
          try { data = JSON.parse(event.data); } catch { /* malformed SSE error data */ }
        }
        if (elements.chatWindow.contains(assistantMessageDiv)) {
          elements.chatWindow.removeChild(assistantMessageDiv);
        }
        appendMessage(
          { role: 'assistant', content: `⚠️ ${data.message || 'Streaming failed.'}`, createdAt: new Date().toISOString() },
          { persist: false }
        );
        setFeedback(data.message || 'Streaming failed.', 'error');
        state.sending = false;
        elements.sendBtn.textContent = 'Send';
        elements.sendBtn.onclick = () => sendMessage();
      });

    } catch (err) {
      console.error('Streaming error:', err);
      if (elements.chatWindow.contains(assistantMessageDiv)) {
        elements.chatWindow.removeChild(assistantMessageDiv);
      }
      appendMessage(
        { role: 'assistant', content: `⚠️ ${err.message || 'Streaming failed.'}`, createdAt: new Date().toISOString() },
        { persist: false }
      );
      setFeedback(err.message, 'error');
    }
    // Note: state cleanup is handled in the done/error EventSource handlers,
    // NOT in a finally block, because EventSource handlers fire asynchronously.
  }

  async function sendMessage() {
    if (state.sending) return;
    const message = elements.messageInput.value.trim();
    const model = elements.modelSelect.value;
    if (!message) return;
    if (!model) {
      setFeedback('Select a model first.', 'error');
      return;
    }

    const userMessage = { role: 'user', content: message, id: `u-${Date.now()}`, createdAt: new Date().toISOString() };
    appendMessage(userMessage);
    elements.messageInput.value = '';
    state.sending = true;
    elements.sendBtn.textContent = 'Sending…';

    // Check if streaming is enabled
    if (elements.streamToggle && resolveStreamEnabled()) {
      const transport = resolveStreamTransport();
      if (transport === 'eventsource') {
        await sendMessageStreamEventSource(message, model);
      } else {
        await sendMessageStreamFetch(message, model);
      }
      return;
    }

    try {
      // Get RAG options including advanced settings
      const ragOpts = getRagOptions();

      const payload = {
        target: targetHost(),
        model,
        system: elements.systemPrompt.value.trim(),
        options: {
          ...readOptions(),
          persona: elements.promptSelect?.value || 'default_chat',  // Phase 2.1: Include selected prompt
          // RAG advanced options (backend expects these in options object)
          ragExpand: ragOpts.ragExpand,
          ragHybrid: ragOpts.ragHybrid,
          ragRerank: ragOpts.ragRerank,
          ragCompress: ragOpts.ragCompress // NEW
        },
        stream: false,
        useRag: ragOpts.useRag,
        ragTopK: ragOpts.ragTopK,
        threadId: state.threadId,
        message,
        profile: readProfileInputs(),
        messages: state.history,
        conversationId: state.conversationId
      };

      // Week 4 Day 3: Add workspace context
      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      };

      const res = await fetch('/api/chat',
        window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
      );
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Chat failed');
      }

      state.profile = data.data?.profile || state.profile;
      state.conversationId = data.data?.conversationId || state.conversationId; // Update ID

      const responseText =
        data.data?.message?.content ||
        data.data?.response ||
        data.data?.output ||
        'No response from Ollama.';

      const assistantMessage = {
          role: 'assistant',
          content: responseText,
          createdAt: new Date().toISOString(),
          id: data.data?.messageId || null,
          stats: data.data?.stats || null // V4: Inject stats from response
      };

      appendMessage(assistantMessage);
      speakText(responseText);

      // Show warning for thinking models if present
      if (data.warning) {
        setFeedback(`⚠️ ${data.warning}`, 'warning');
        setTimeout(() => setFeedback('Response received.', 'success'), 3000);
      } else {
        setFeedback('Response received.', 'success');
      }
      loadHistoryList();
      
      // V8: Update stats
      if (state.conversationId) refreshStats(state.conversationId);

      // Reload conversation to sync message IDs for feedback
      if(state.conversationId) {
          // Preserve model selection - user may have changed it from what's saved in DB
          loadConversation(state.conversationId, true);
      }

      // Update setup checklist after successful message send
      if (window.checkSetupProgress) {
          setTimeout(() => window.checkSetupProgress(), 500);
      }

    } catch (err) {
      console.error(err);
      appendMessage(
        { role: 'assistant', content: `⚠️ ${err.message || 'Request failed.'}`, createdAt: new Date().toISOString() },
        { persist: false },
      );
      setFeedback(err.message, 'error');
      setStatus('Check host/model.', 'error');
    } finally {
      state.sending = false;
      elements.sendBtn.textContent = 'Send';
    }
  }

  // --- New Features ---

  async function loadHistoryList() {
      try {
          // Week 4 Day 3: Add workspace context
          const url = window.WorkspaceManager ?
            WorkspaceManager.addWorkspaceParam('/api/history') : '/api/history';
          const res = await fetch(url);
          const { data } = await res.json();
          elements.historyList.innerHTML = '';
          if (!Array.isArray(data)) return [];
          data.forEach(item => {
              const div = document.createElement('div');
              div.className = 'history-item';

              // Build score badge if judged
              let scoreBadge = '';
              if (item.qualityScore != null) {
                const color = item.qualityScore >= 80 ? '#22c55e' : item.qualityScore >= 60 ? '#eab308' : item.qualityScore >= 40 ? '#f59e0b' : '#ef4444';
                scoreBadge = `<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${item.qualityScore}/100">${item.qualityScore}</span>`;
              }

              div.innerHTML = `
                <div class="history-item-header">
                  <div class="title">${sanitizeHTML(item.title)}${scoreBadge}</div>
                  <button class="judge-btn ghost" title="Judge quality" data-id="${item.id}" style="padding:2px 6px;font-size:0.7rem;flex-shrink:0;">
                    <i class="fas fa-star"></i>
                  </button>
                </div>
                <div class="date">${new Date(item.date).toLocaleString()}</div>
              `;
              div.querySelector('.title').parentElement.addEventListener('click', (e) => {
                if (!e.target.closest('.judge-btn')) loadConversation(item.id);
              });
              div.querySelector('.judge-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                judgeConversationFromHistory(item.id, e.currentTarget);
              });
              elements.historyList.appendChild(div);
          });
          return data;
      } catch (err) {
          console.error('Failed to load history', err);
          return [];
      }
  }

  // --- Judged Conversations View ---
  async function loadJudgedConversations(minScore = 0) {
    try {
      const params = new URLSearchParams({ limit: '50', minScore: String(minScore) });
      let url = `/api/conversations/judged?${params}`;
      if (window.WorkspaceManager) url = WorkspaceManager.addWorkspaceParam(url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      elements.historyList.innerHTML = '';
      if (!data?.conversations?.length) {
        elements.historyList.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:0.8rem;text-align:center;">No judged conversations found.</div>';
        return;
      }
      data.conversations.forEach(conv => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const score = conv.quality_assessment?.overall_score ?? 0;
        const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : score >= 40 ? '#f59e0b' : '#ef4444';
        const judgedAt = conv.quality_assessment?.judged_at
          ? new Date(conv.quality_assessment.judged_at).toLocaleDateString()
          : '';
        div.innerHTML = `
          <div class="history-item-header">
            <div class="title">${sanitizeHTML(conv.title || 'Untitled')}<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${score}/100">${score}</span></div>
          </div>
          <div class="date">${conv.model || ''} ${judgedAt ? '· Judged ' + judgedAt : ''}</div>
        `;
        div.addEventListener('click', () => loadConversation(conv._id));
        elements.historyList.appendChild(div);
      });
    } catch (err) {
      console.error('Failed to load judged conversations', err);
      elements.historyList.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:0.8rem;">Failed to load judged conversations.</div>';
    }
  }

  // Wire up history view tabs
  const viewAllBtn = document.getElementById('viewAllBtn');
  const viewJudgedBtn = document.getElementById('viewJudgedBtn');
  const minScoreControl = document.getElementById('minScoreControl');
  const minScoreInput = document.getElementById('minScoreInput');

  if (viewAllBtn && viewJudgedBtn) {
    viewAllBtn.addEventListener('click', () => {
      viewAllBtn.classList.add('active');
      viewJudgedBtn.classList.remove('active');
      if (minScoreControl) minScoreControl.style.display = 'none';
      loadHistoryList();
    });
    viewJudgedBtn.addEventListener('click', () => {
      viewJudgedBtn.classList.add('active');
      viewAllBtn.classList.remove('active');
      if (minScoreControl) minScoreControl.style.display = '';
      loadJudgedConversations(parseInt(minScoreInput?.value) || 0);
    });
    if (minScoreInput) {
      minScoreInput.addEventListener('change', () => {
        if (viewJudgedBtn.classList.contains('active')) {
          loadJudgedConversations(parseInt(minScoreInput.value) || 0);
        }
      });
    }
  }

  async function judgeConversationFromHistory(conversationId, btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      const fetchOptions = { method: 'POST', credentials: 'include' };
      const res = await fetch(
        `/api/conversations/${conversationId}/judge`,
        window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === 'success' && data.data?.quality_assessment) {
        const score = data.data.quality_assessment.overall_score;
        const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : score >= 40 ? '#f59e0b' : '#ef4444';
        // Update badge in parent
        const titleEl = btn.parentElement.querySelector('.title');
        if (titleEl && !titleEl.querySelector('.quality-badge')) {
          titleEl.insertAdjacentHTML('beforeend', `<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${score}/100">${score}</span>`);
        }
        if (typeof Toast !== 'undefined') Toast.success(`Judged: ${score}/100`);
      }
    } catch (err) {
      console.error('Judge from history failed:', err);
      if (typeof Toast !== 'undefined') Toast.error(`Judge failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-star"></i>';
    }
  }

  async function loadConversation(id, preserveModelSelection = false) {
      try {
          // Week 4 Day 3: Add workspace context
          const url = window.WorkspaceManager ?
            WorkspaceManager.addWorkspaceParam(`/api/history/${id}`) : `/api/history/${id}`;
          const res = await fetch(url);

          if (!res.ok) {
            if (res.status === 404) {
                console.warn(`Conversation ${id} not found.`);
                state.conversationId = null;
                // Don't throw, just allow UI to be in "new chat" state or remain as is
                return false;
            }
            throw new Error(`Failed to load conversation: ${res.status}`);
          }

          const responseData = await res.json();
          const data = responseData.data || responseData;

          if (!data || !data._id) {
              throw new Error('Invalid conversation data received');
          }

          state.conversationId = data._id;
          state.history = []; // We will rebuild history from DB
          elements.chatWindow.innerHTML = '';

          state.stats.messages = 0;
          state.stats.replies = 0;

          // V8: Update stats
          updateConversationStats(data);

          if (!Array.isArray(data.messages)) return false;
            data.messages.forEach(msg => {
                // Manually construct message object to include stats and ragSources
                const messageObj = {
                    role: msg.role,
                    content: msg.content,
                    createdAt: msg.createdAt,
                    id: msg._id,
                    feedback: msg.feedback,
                    stats: msg.stats, // V4: Pass stats to rendering
                    cost: msg.cost,   // V5: Cost tracking
                    ragSources: msg.ragSources // V6: Pass RAG sources for citations
                };

                // Use the object form of appendMessage
                appendMessage(messageObj, {
                    persist: true,
                    count: true
                });
            });

          // Only set model if we're not preserving the current selection and it exists in dropdown
          if(!preserveModelSelection && data.model) {
              const modelExists = Array.from(elements.modelSelect.options).some(opt => opt.value === data.model);
              if(modelExists) {
                  elements.modelSelect.value = data.model;
              }
          }

          // Show quality assessment if conversation was previously judged
          if (data.quality_assessment?.overall_score != null) {
            displayQualityAssessment(data.quality_assessment);
          }

          return true;
      } catch (err) {
          console.error('Failed to load conversation', err);
          return false;
      }
  }

  async function loadProfile() {
      try {
          const res = await fetch('/api/profile');
          if (!res.ok) return;
          const responseData = await res.json();
          const data = responseData.data || responseData;
          if (!data) return;

          elements.userAbout.value = data.about || '';
          elements.userInstructions.value = data.preferences?.customInstructions || '';
      } catch (err) {
          console.error('Failed to load profile', err);
      }
  }

  async function saveProfile() {
      try {
          await fetch('/api/profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  about: elements.userAbout.value,
                  preferences: {
                      customInstructions: elements.userInstructions.value
                  }
              }),
              credentials: 'include'
          });
          elements.profileModal.classList.add('hidden');
          setFeedback('Profile saved.', 'success');

          // Update profile setup checks
          if (window.checkProfileSetup) {
              window.checkProfileSetup();
          }
          if (window.checkSetupProgress) {
              window.checkSetupProgress();
          }
      } catch (err) {
          console.error('Failed to save profile', err);
          setFeedback('Failed to save profile.', 'error');
      }
  }

  async function loadActivePrompt() {
      try {
          // Week 4 Day 3: Add workspace context
          const url = window.WorkspaceManager ?
            WorkspaceManager.addWorkspaceParam('/api/prompts/default_chat') : '/api/prompts/default_chat';
          const res = await fetch(url, { credentials: 'include' });
          if (res.ok) {
              const result = await res.json();
              const activePromptNameEl = document.getElementById('activePromptName');

              if (result.status === 'success' && result.data.length > 0) {
                  const activePrompts = result.data.filter(p => p.isActive);
                  if (activePrompts.length > 0) {
                      const promptName = `${activePrompts[0].name} v${activePrompts[0].version}`;
                      if (activePromptNameEl) {
                          activePromptNameEl.textContent = promptName;
                          activePromptNameEl.setAttribute('data-tooltip', `Active prompt: ${promptName}`);
                      }
                      return;
                  }
              }
          }

          // Fallback if no active prompt found
          const activePromptNameEl = document.getElementById('activePromptName');
          if (activePromptNameEl) {
              activePromptNameEl.textContent = 'default_chat';
          }
      } catch (err) {
          console.error('Failed to load active prompt:', err);
          const activePromptNameEl = document.getElementById('activePromptName');
          if (activePromptNameEl) {
              activePromptNameEl.textContent = 'default_chat';
          }
      }
  }

  // Load available prompts into selector dropdown
  async function loadPromptSelector() {
      try {
          const fetchOptions = { credentials: 'include' };
          const res = await fetch('/api/prompts',
             window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
          );
          if (!res.ok) {
              console.error('Failed to load prompts:', res.status);
              return;
          }

          const result = await res.json();
          if (result.status !== 'success') {
              console.error('Prompts API error:', result.message);
              return;
          }

          const promptSelect = document.getElementById('promptSelect');
          if (!promptSelect) return;

          // Clear existing options
          promptSelect.innerHTML = '';

          // Add options for each prompt with active versions
          const promptNames = Object.keys(result.data).sort();
          if (promptNames.length === 0) {
              promptSelect.innerHTML = '<option value="default_chat">default_chat (auto)</option>';
              return;
          }

          promptNames.forEach(name => {
              const versions = result.data[name];
              const activeVersions = versions.filter(v => v.isActive);

              if (activeVersions.length > 0) {
                  // Use the highest version active prompt
                  const latestActive = activeVersions[0];
                  const option = document.createElement('option');
                  option.value = name;
                  option.textContent = `${name} v${latestActive.version}`;

                  // Mark as selected if it's default_chat
                  if (name === 'default_chat') {
                      option.selected = true;
                  }

                  promptSelect.appendChild(option);
              }
          });

          // If no default_chat option exists, add fallback
          if (!promptSelect.querySelector('option[value="default_chat"]')) {
              const fallback = document.createElement('option');
              fallback.value = 'default_chat';
              fallback.textContent = 'default_chat (auto)';
              fallback.selected = true;
              promptSelect.insertBefore(fallback, promptSelect.firstChild);
          }

      } catch (err) {
          console.error('Failed to load prompt selector:', err);
      }
  }

  // Show prompt details modal
  async function showPromptInfo() {
      const promptSelect = document.getElementById('promptSelect');
      if (!promptSelect) return;

      const selectedPrompt = promptSelect.value;

      try {
          const fetchOptions = { credentials: 'include' };
          const res = await fetch(`/api/prompts/${selectedPrompt}`,
            window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
          );
          if (!res.ok) {
              if (typeof Toast !== 'undefined') {
                Toast.error('Failed to load prompt details. Please try again.');
              } else {
                alert('Failed to load prompt details');
              }
              return;
          }

          const result = await res.json();
          if (result.status !== 'success' || result.data.length === 0) {
              if (typeof Toast !== 'undefined') {
                Toast.warning('No prompt data found');
              } else {
                alert('No prompt data found');
              }
              return;
          }

          // Find active version
          const activeVersion = result.data.find(p => p.isActive) || result.data[0];

          // Create modal content
          const modalContent = `
              <h3>${activeVersion.name} v${activeVersion.version}</h3>
              <p><strong>Description:</strong> ${activeVersion.description || 'No description'}</p>
              <p><strong>System Prompt:</strong></p>
              <pre style="background: #000; padding: 10px; border-radius: 4px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word;">${activeVersion.systemPrompt}</pre>
              <p><strong>Stats:</strong></p>
              <ul>
                  <li>Impressions: ${activeVersion.stats?.impressions || 0}</li>
                  <li>Positive: ${activeVersion.stats?.positiveCount || 0}</li>
                  <li>Negative: ${activeVersion.stats?.negativeCount || 0}</li>
              </ul>
          `;

          // Use existing modal or create simple alert fallback
          // TODO: Integrate with proper modal component
          const confirmed = confirm(modalContent.replace(/<[^>]*>/g, '\n').replace(/\n+/g, '\n'));

      } catch (err) {
          console.error('Failed to show prompt info:', err);
          alert('Error loading prompt details');
      }
  }

  function setHistoryToggleLabels() {
    if (!elements.page) return;
    const isHidden = elements.page.classList.contains('history-hidden');
    if (elements.toggleHistoryBtn) {
      elements.toggleHistoryBtn.textContent = isHidden ? 'Show history' : 'Hide history';
      elements.toggleHistoryBtn.setAttribute('aria-pressed', String(!isHidden));
    }
    if (elements.closeHistoryBtn) {
      const label = isHidden ? 'Show history' : 'Hide history';
      elements.closeHistoryBtn.title = label;
      elements.closeHistoryBtn.setAttribute('aria-label', label);
    }
  }

  function toggleHistoryPanel() {
    if (!elements.page) return;
    elements.page.classList.toggle('history-hidden');
    setHistoryToggleLabels();
  }

  function toggleLogPanel() {
    if (!elements.logPanel || !elements.toggleLogBtn) return;
    const isCollapsed = elements.logPanel.classList.toggle('collapsed');
    elements.toggleLogBtn.textContent = isCollapsed ? 'Show session log' : 'Hide session log';
  }

  // --- Voice Functions ---

  let recognition = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let recordingStartTime = null;
  let recordingTimer = null;

  // Voice provider state: 'server' (Whisper) or 'browser' (Web Speech API)
  state.voiceProvider = 'browser';

  function updateVoiceFieldVisibility() {
    const sttProv = elements.sttProviderSelect?.value || 'auto';
    const ttsOn = elements.ttsToggle?.checked;
    const ttsProv = document.getElementById('ttsProviderSelect')?.value || 'browser';
    // Show whisper model only for auto/local STT
    if (elements.whisperModelField) {
      elements.whisperModelField.style.display = (sttProv === 'auto' || sttProv === 'local') ? '' : 'none';
    }
    // Show TTS provider when TTS enabled
    const ttsProviderField = document.getElementById('ttsProviderField');
    if (ttsProviderField) ttsProviderField.style.display = ttsOn ? '' : 'none';
    // Show TTS voice only when provider is openai
    if (elements.ttsVoiceField) {
      elements.ttsVoiceField.style.display = (ttsOn && ttsProv === 'openai') ? '' : 'none';
    }
  }

  function setHealthDot(el, status) {
    if (!el) return;
    el.className = 'voice-health-dot ' + status; // healthy | partial | unavailable
  }

  // Check voice service health on load
  async function checkVoiceHealth() {
    try {
      const res = await fetch('/api/voice/health?models=true');
      if (!res.ok) return;
      const { data } = await res.json();

      // Determine effective STT provider
      const sttPref = elements.sttProviderSelect?.value || state.settings?.sttProvider || 'auto';
      if (sttPref === 'browser') {
        state.voiceProvider = 'browser';
      } else if (sttPref === 'openai') {
        state.voiceProvider = data?.stt?.openai ? 'server' : 'browser';
      } else if (sttPref === 'local') {
        state.voiceProvider = data?.stt?.local ? 'server' : 'browser';
      } else {
        // auto: prefer local, fall back to openai server, then browser
        state.voiceProvider = (data?.stt?.local || data?.stt?.openai) ? 'server' : 'browser';
      }

      // Update health dots
      const sttStatus = data?.stt?.local ? 'healthy' : (data?.stt?.openai ? 'partial' : 'unavailable');
      setHealthDot(elements.sttHealthDot, sttStatus);
      setHealthDot(elements.sttHealthDotInner, sttStatus);
      const ttsStatus = (data?.tts?.openai || data?.tts?.local) ? 'healthy' : 'partial'; // browser always works
      setHealthDot(elements.ttsHealthDot, ttsStatus);

      // Populate Whisper models
      if (data?.models?.length && elements.whisperModelSelect) {
        const saved = state.settings?.whisperModel || '';
        elements.whisperModelSelect.innerHTML = '<option value="">Server default</option>';
        data.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m.replace('Systran/faster-whisper-', '');
          elements.whisperModelSelect.appendChild(opt);
        });
        if (saved) elements.whisperModelSelect.value = saved;
      }

      // Populate languages
      if (data?.languages?.length && elements.sttLanguageSelect) {
        const saved = state.settings?.sttLanguage || 'en';
        elements.sttLanguageSelect.innerHTML = '';
        data.languages.forEach(l => {
          const opt = document.createElement('option');
          opt.value = l.code;
          opt.textContent = l.name;
          elements.sttLanguageSelect.appendChild(opt);
        });
        elements.sttLanguageSelect.value = saved;
      }

      updateVoiceFieldVisibility();
      console.log(`Voice: STT=${state.voiceProvider}, local=${data?.stt?.local}, openai=${data?.stt?.openai}`);
    } catch (err) {
      console.warn('Voice health check failed:', err);
      state.voiceProvider = 'browser';
      setHealthDot(elements.sttHealthDot, 'unavailable');
      setHealthDot(elements.sttHealthDotInner, 'unavailable');
    }
  }

  function showVoiceStatus(text) {
    const el = document.getElementById('voiceStatus');
    if (el) { el.textContent = text; el.style.display = text ? 'inline' : 'none'; }
  }

  function updateRecordingTimer() {
    if (!recordingStartTime) return;
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    showVoiceStatus(`Recording... ${elapsed}s`);
  }

  // --- Server-side STT (MediaRecorder → /api/voice/transcribe) ---
  async function startServerVoiceInput() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg' });

      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(recordingTimer);
        showVoiceStatus('Transcribing...');
        setStatus('Transcribing...', 'success');

        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        try {
          const params = new URLSearchParams();
          const sttProv = elements.sttProviderSelect?.value || state.settings?.sttProvider || 'auto';
          // For auto mode, server-side transcribe() handles local→openai fallback
          params.set('provider', (sttProv === 'openai') ? 'openai' : 'local');
          const lang = elements.sttLanguageSelect?.value || 'en';
          if (lang) params.set('language', lang);
          const model = elements.whisperModelSelect?.value || '';
          if (model) params.set('model', model);
          const res = await fetch(`/api/voice/transcribe?${params}`, { method: 'POST', body: formData });
          if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
          const { data } = await res.json();
          if (data?.text) {
            elements.messageInput.value = data.text;
            setFeedback(`Transcribed (${data.provider}, ${data.duration}ms)`, 'success');
            if (state.settings?.voiceAutoSend) sendMessage();
          } else {
            setFeedback('No speech detected. Try again.', 'error');
          }
        } catch (err) {
          console.error('Server transcription error:', err);
          setFeedback(`Transcription error: ${err.message}`, 'error');
        }
        cleanupVoiceInput();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingStartTime = Date.now();
      recordingTimer = setInterval(updateRecordingTimer, 1000);
      elements.micBtn.classList.add('recording');
      elements.micBtn.setAttribute('aria-pressed', 'true');
      showVoiceStatus('Recording... 0s');
      setStatus('Recording...', 'success');
      window.speechSynthesis.cancel();
    } catch (err) {
      console.error('Microphone access error:', err);
      setFeedback(`Mic error: ${err.message}. Falling back to browser.`, 'error');
      startBrowserVoiceInput();
    }
  }

  function stopServerVoiceInput() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    } else {
      cleanupVoiceInput();
    }
  }

  // --- Browser-side STT (Web Speech API fallback) ---
  function startBrowserVoiceInput() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setFeedback('Speech recognition not supported in this browser.', 'error');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    const langCode = elements.sttLanguageSelect?.value || state.settings?.sttLanguage || 'en';
    recognition.lang = langCode.length === 2 ? `${langCode}-${langCode.toUpperCase()}` : langCode;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isRecording = true;
      elements.micBtn.classList.add('recording');
      elements.micBtn.setAttribute('aria-pressed', 'true');
      showVoiceStatus('Listening...');
      setStatus('Listening...', 'success');
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      elements.messageInput.value = transcript;
      if (state.settings?.voiceAutoSend) sendMessage();
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error', event.error);
      setFeedback(`Voice error: ${event.error}`, 'error');
      cleanupVoiceInput();
    };

    recognition.onend = () => {
      cleanupVoiceInput();
    };

    window.speechSynthesis.cancel();
    recognition.start();
  }

  function stopBrowserVoiceInput() {
    if (recognition) recognition.stop();
    else cleanupVoiceInput();
  }

  function cleanupVoiceInput() {
    recognition = null;
    mediaRecorder = null;
    audioChunks = [];
    isRecording = false;
    recordingStartTime = null;
    clearInterval(recordingTimer);
    recordingTimer = null;
    elements.micBtn.classList.remove('recording');
    elements.micBtn.setAttribute('aria-pressed', 'false');
    showVoiceStatus('');
    setStatus('Idle');
  }

  function toggleVoiceInput() {
    if (isRecording) {
      if (state.voiceProvider === 'server') stopServerVoiceInput();
      else stopBrowserVoiceInput();
    } else {
      if (state.voiceProvider === 'server') startServerVoiceInput();
      else startBrowserVoiceInput();
    }
  }

  // --- TTS (Text-to-Speech) ---
  async function speakText(text) {
    if (!state.settings.tts) return;

    const provider = state.settings.ttsProvider || 'browser';

    if (provider !== 'browser') {
      // Server-side TTS
      try {
        const voice = state.settings?.ttsVoice || 'alloy';
        const res = await fetch('/api/voice/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, provider, voice })
        });
        if (res.ok && res.headers.get('content-type')?.startsWith('audio/')) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
          audio.play();
          return;
        }
        // Fall through to browser TTS if server returned JSON (browser provider)
      } catch (err) {
        console.warn('Server TTS failed, falling back to browser:', err.message);
      }
    }

    // Browser TTS fallback
    const utterance = new SpeechSynthesisUtterance(text);

    const setVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.name.includes('Google US English')) ||
                        voices.find(v => v.lang === 'en-US') ||
                        voices[0];
      if (preferred) utterance.voice = preferred;
      window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.addEventListener('voiceschanged', setVoice, { once: true });
    } else {
      setVoice();
    }
  }

  // Update config summary display in both config panel and chat header
  function updateConfigSummary() {
    const modelName = elements.modelSelect.value || '—';
    const shortModel = modelName.length > 15 ? modelName.substring(0, 12) + '...' : modelName;
    
    // Update config panel summary
    const summaryModelEl = document.getElementById('summaryModel');
    if (summaryModelEl) summaryModelEl.textContent = shortModel;
    
    const summaryRagEl = document.getElementById('summaryRag');
    if (summaryRagEl) summaryRagEl.textContent = elements.ragToggle.checked ? 'On' : 'Off';
    
    const summaryStreamEl = document.getElementById('summaryStream');
    if (summaryStreamEl) summaryStreamEl.textContent = elements.streamToggle.checked ? 'On' : 'Off';
    
    const summaryTempEl = document.getElementById('summaryTemp');
    if (summaryTempEl) summaryTempEl.textContent = elements.temperature.value;
    
    // Update chat panel config summary
    const chatConfigEl = document.getElementById('chatConfigSummary');
    if (chatConfigEl) {
      const ragStatus = elements.ragToggle.checked ? '+RAG' : '';
      const streamStatus = elements.streamToggle.checked ? '' : 'No-Stream';
      const extras = [ragStatus, streamStatus].filter(s => s).join(', ');
      const summary = extras ? `${shortModel} (${extras})` : shortModel;
      chatConfigEl.textContent = summary;
      chatConfigEl.setAttribute('data-tooltip', `Model: ${modelName}\\nRAG: ${elements.ragToggle.checked ? 'Enabled' : 'Disabled'}\\nStreaming: ${elements.streamToggle.checked ? 'Enabled' : 'Disabled'}\\nTemperature: ${elements.temperature.value}`);
    }
  }

  function attachEvents() {
    if (elements.micBtn) elements.micBtn.addEventListener('click', toggleVoiceInput);
    elements.ttsToggle.addEventListener('change', () => {
      updateVoiceFieldVisibility();
      persistSettings();
    });
    const ttsProviderSelect = document.getElementById('ttsProviderSelect');
    if (ttsProviderSelect) ttsProviderSelect.addEventListener('change', () => { updateVoiceFieldVisibility(); persistSettings(); });
    // Voice I/O section toggle
    const voiceHeader = document.getElementById('voiceHeader');
    const voiceContent = document.getElementById('voiceContent');
    if (voiceHeader && voiceContent) {
      voiceHeader.addEventListener('click', () => {
        voiceContent.classList.toggle('hidden');
        voiceHeader.classList.toggle('expanded');
      });
    }
    // STT provider change → re-evaluate voice provider
    if (elements.sttProviderSelect) {
      elements.sttProviderSelect.addEventListener('change', () => {
        updateVoiceFieldVisibility();
        persistSettings();
        checkVoiceHealth();
      });
    }
    if (elements.sttLanguageSelect) elements.sttLanguageSelect.addEventListener('change', persistSettings);
    if (elements.whisperModelSelect) elements.whisperModelSelect.addEventListener('change', persistSettings);
    if (elements.voiceAutoSend) elements.voiceAutoSend.addEventListener('change', persistSettings);
    if (elements.ttsVoiceSelect) elements.ttsVoiceSelect.addEventListener('change', persistSettings);
    if (elements.testVoiceBtn) elements.testVoiceBtn.addEventListener('click', () => speakText('Hello, this is your voice assistant.'));
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.clearBtn.addEventListener('click', clearChat);
    elements.analyzeQualityBtn.addEventListener('click', analyzeConversationQuality);
    elements.refreshModels.addEventListener('click', () => fetchModels(true));
    elements.saveDefaults.addEventListener('click', persistSettings);
    
    // RAG Advanced Options Panel
    if (elements.ragPanelHeader) {
      elements.ragPanelHeader.addEventListener('click', toggleRagOptions);
    }
    if (elements.ragTopK) {
      elements.ragTopK.addEventListener('input', () => {
        if (elements.ragTopKValue) {
          elements.ragTopKValue.textContent = elements.ragTopK.value;
        }
      });
    }

    // Auth is handled by nav.js (centralized login/logout in nav bar)

    // Prompt selection events
    if (elements.promptInfoBtn) {
      elements.promptInfoBtn.addEventListener('click', showPromptInfo);
    }

    // Toggle tuning parameters section
    const tuningHeader = document.getElementById('tuningHeader');
    const tuningContent = document.getElementById('tuningContent');
    if (tuningHeader && tuningContent) {
      tuningHeader.addEventListener('click', () => {
        tuningContent.classList.toggle('hidden');
        tuningHeader.classList.toggle('expanded');
      });
    }

    // Toggle entire config panel (collapsible)
    const configPanel = document.getElementById('configPanel');
    const configPanelHeader = document.getElementById('configPanelHeader');
    const configBody = document.getElementById('configBody');
    const configSummary = document.getElementById('configSummary');

    if (configPanelHeader && configBody) {
      configPanelHeader.addEventListener('click', () => {
        configPanel.classList.toggle('collapsed');
        const isCollapsed = configPanel.classList.contains('collapsed');
        if (isCollapsed) {
          updateConfigSummary();
          configSummary.style.display = 'block';
        } else {
          configSummary.style.display = 'none';
        }
      });
    }

    elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        sendMessage();
      }
    });

    ['temperature', 'topP'].forEach((key) => {
      const input = elements[key];
      input.addEventListener('input', updateRangeDisplays);
    });

    elements.modelSelect.addEventListener('change', () => {
      state.settings.model = elements.modelSelect.value;
      persistSettings();
      updateConfigSummary();
    });

    elements.streamToggle.addEventListener('change', () => {
      persistSettings();
      updateConfigSummary();
    });
    
    elements.ragToggle.addEventListener('change', () => {
      persistSettings();
      updateConfigSummary();
      // Update checklist when RAG is toggled (may complete RAG task)
      if (window.checkSetupProgress && elements.ragToggle.checked) {
          setTimeout(() => window.checkSetupProgress(), 500);
      }
    });
    
    if (elements.statsToggle) elements.statsToggle.addEventListener('change', persistSettings);
    
    // RAG Advanced Options event listeners
    if (elements.ragExpandQuery) elements.ragExpandQuery.addEventListener('change', persistSettings);
    if (elements.ragHybridSearch) elements.ragHybridSearch.addEventListener('change', persistSettings);
    if (elements.ragRerankResults) elements.ragRerankResults.addEventListener('change', persistSettings);
    if (elements.ragCompress) elements.ragCompress.addEventListener('change', persistSettings); // NEW

    // Auto-refresh models when host or port changes
    elements.hostInput.addEventListener('change', () => {
      persistSettings();
      fetchModels(false);
    });
    
    elements.portInput.addEventListener('change', () => {
      persistSettings();
      fetchModels(false);
    });

    elements.quickActions.forEach((btn) =>
      btn.addEventListener('click', () => {
        elements.messageInput.value = btn.dataset.quick;
        elements.messageInput.focus();
      }),
    );

    // New Events
    elements.newChatBtn.addEventListener('click', clearChat);
    elements.profileBtn.addEventListener('click', () => {
        loadProfile();
        elements.profileModal.classList.remove('hidden');
    });
    elements.closeProfileBtn.addEventListener('click', () => elements.profileModal.classList.add('hidden'));
    elements.saveProfileBtn.addEventListener('click', saveProfile);
    elements.resetProfileBtn.addEventListener('click', () => {
        loadProfile();
    });

    if (elements.toggleHistoryBtn) {
      elements.toggleHistoryBtn.addEventListener('click', toggleHistoryPanel);
    }

    if (elements.closeHistoryBtn) {
      elements.closeHistoryBtn.addEventListener('click', toggleHistoryPanel);
    }

    if (elements.toggleLogBtn) {
      elements.toggleLogBtn.addEventListener('click', toggleLogPanel);
    }
  }

  async function init() {
    // Load settings after defaults are potentially updated by server config
    state.settings = loadSettings();
    
    // Check URL params for model override
    const urlParams = new URLSearchParams(window.location.search);
    const modelParam = urlParams.get('model');
    if (modelParam) {
      state.settings.model = decodeURIComponent(modelParam);
    }

    elements.threadId.textContent = state.threadId;
    hydrateForm();
    attachEvents();
    clearChat();
    loadProfile();
    loadActivePrompt();
    loadPromptSelector();
    await fetchModels();

    // Check RAG availability and show/hide advanced options panel
    checkRagAvailability();

    // Check voice service availability (async, non-blocking)
    checkVoiceHealth();
    
    // RE-EVALUATE AGENT SELECTION
    // Ensure that if an agent was selected during initAgentSystem (which runs largely in parallel or before fetchModels),
    // we re-apply the model constraint now that models are actually loaded.
    if (state.agent && state.agent.defaultModel) {
        console.log('Re-applying agent model after fetchModels:', state.agent.defaultModel);
        
         // If not found in select, maybe add it? 
          if (elements.modelSelect.querySelector(`option[value="${state.agent.defaultModel}"]`) === null) {
              const opt = document.createElement('option');
              opt.value = state.agent.defaultModel;
              opt.textContent = state.agent.defaultModel + ' (Agent)';
              elements.modelSelect.appendChild(opt);
          }
        
        elements.modelSelect.value = state.agent.defaultModel;
        state.settings.model = state.agent.defaultModel; // Ensure state is synced
        updateConfigSummary();
    }

    // Set initial UI toggle states
    if (elements.toggleLogBtn) {
      const isCollapsed = elements.logPanel?.classList.contains('collapsed');
      elements.toggleLogBtn.textContent = isCollapsed ? 'Show session log' : 'Hide session log';
    }

    setHistoryToggleLabels();
    
    // Update config summary on parameter changes (temperature, etc.)
    document.addEventListener('input', (e) => {
      if (e.target.type === 'range' || e.target.id === 'temperature') {
        updateConfigSummary();
      }
      // Update context limit display when num_ctx changes
      if (e.target.id === 'numCtx') {
        const tokenLimit = document.getElementById('tokenLimit');
        if (tokenLimit) {
          tokenLimit.textContent = Number(e.target.value).toLocaleString();
        }
        // Recalculate percentage if there's current conversation data
        if (state.conversationId) {
          refreshStats(state.conversationId);
        }
      }
    });

    // Initialize config summary
    updateConfigSummary();

    // Initialize context limit display
    const tokenLimit = document.getElementById('tokenLimit');
    if (tokenLimit) {
      tokenLimit.textContent = (state.config?.options?.num_ctx || 4096).toLocaleString();
    }

    // Load history and open latest conversation if available
    const history = await loadHistoryList();
    if (history && history.length > 0) {
        // Try to load conversations until one succeeds
        let loaded = false;
        // Check first few items to avoid infinite loop if all are bad 
        // (though loop breaks on first success)
        const candidates = history.slice(0, 5); 
        
        for (const item of candidates) {
            loaded = await loadConversation(item.id);
            if (loaded) break;
        }

        if (!loaded) {
            setStatus('Ready');
            setFeedback('Set host/model, then start chatting.');
        }
    } else {
        setStatus('Ready');
        setFeedback('Set host/model, then start chatting.');
    }
  }

  // Load server config first, then initialize
  loadServerConfig().then((config) => {
    state.config = config;
    init();
  }).catch(err => {
    console.warn('Server config load failed, using defaults:', err);
    init();
  });

  // ==========================================
  // V8: Stats & AgentX Integration (Continued Scope)
  // ==========================================

/**
 * Update conversation statistics (tokens, cost) in the UI
 * V8: Cost Tracking (2026-01-08)
 */
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

        // Color coding based on usage
        contextProgressFill.classList.remove('warning', 'danger');
        if (percentage >= 90) {
          contextProgressFill.classList.add('danger');
        } else if (percentage >= 70) {
          contextProgressFill.classList.add('warning');
        }
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
        const url = window.WorkspaceManager ?
          WorkspaceManager.addWorkspaceParam(`/api/history/${conversationId}`) : `/api/history/${conversationId}`;
        const res = await fetch(url);
        if (!res.ok) return; // Silent fail on 404/error during stats refresh
        
        const responseData = await res.json();
        const data = responseData.data || responseData;
        if (data) updateConversationStats(data);
    } catch (e) {
        console.error('Failed to refresh stats', e);
    }
}

  // ==========================================
  // V7: AgentX Integration Logic
  // ==========================================
  
  // Elements for AgentX
  const agentElements = {
    launcherContainer: document.getElementById('agentxLauncher'),
    activePanel: document.getElementById('agentActivePanel'),
    defaultSummary: document.getElementById('defaultConfigSummary'),
    agentSummary: document.getElementById('agentConfigSummary'),
    // Active Panel Elements
    activeName: document.getElementById('activeAgentName'),
    activeRole: document.getElementById('activeAgentRole'),
    activeAvatar: document.getElementById('activeAgentAvatar'),
    activeModel: document.getElementById('activeAgentModel'),
    activeTools: document.getElementById('activeAgentTools'),
    changeBtn: document.getElementById('changeAgentBtn'),
    // Summary Elements
    summaryName: document.getElementById('summaryAgentName'),
    summaryTools: document.getElementById('summaryAgentTools')
  };

  let agentListView = null;
  const agentSystemLog = {
      info: (...args) => console.info('[AgentSystem]', ...args),
      debug: (...args) => console.debug('[AgentSystem]', ...args),
      warn: (...args) => console.warn('[AgentSystem]', ...args),
      error: (...args) => console.error('[AgentSystem]', ...args)
  };

  async function initAgentSystem() {
    agentSystemLog.info('Initializing.');
    if (!agentElements.launcherContainer || !window.AgentListView) {
        agentSystemLog.error('Agent launcher container or AgentListView missing.', {
            container: !!agentElements.launcherContainer, 
            class: !!window.AgentListView 
        });
        return;
    }

    // Initialize AgentListView in Launcher Mode
    agentListView = new AgentListView(agentElements.launcherContainer, {
        launcherMode: true,
        showFilters: true,
        showSearch: true,
        onSelect: handleAgentSelection
    });

    // Check URL params for specific agent or conversation to skipping launcher
    const urlParams = new URLSearchParams(window.location.search);
    const hasConversation = urlParams.get('c');
    const agentIdParam = urlParams.get('agent');
    
    agentSystemLog.debug('Startup params:', { hasConversation, agentIdParam });

    // Wire up Change Agent Button
    if (agentElements.changeBtn) {
        agentElements.changeBtn.addEventListener('click', () => {
            showLauncher();
        });
    }

    // Wait for initial agent load performed by AgentListView initialization
    try {
        const initialLoadPromise = agentListView.readyPromise && typeof agentListView.readyPromise.then === 'function'
            ? agentListView.readyPromise
            : agentListView.load();
        await initialLoadPromise;
        agentSystemLog.info(`Loaded ${agentListView.agents.length} agents for launcher.`);

        // Fire custom event so persona-selector can inject personas after agents load
        window.dispatchEvent(new CustomEvent('agentx:agents-loaded', {
            detail: { agentCount: agentListView.agents.length }
        }));
    } catch (e) {
        agentSystemLog.error('Failed to load agents during initialization:', e);
    }

    // Check if we need to auto-select an agent from URL
    if (agentIdParam) {
        const preSelectedAgent = agentListView.agents.find(a => a._id === agentIdParam);
        agentSystemLog.debug('Pre-selected agent lookup:', preSelectedAgent?.name);
        if (preSelectedAgent) {
            handleAgentSelection(preSelectedAgent);
        } else {
            agentSystemLog.warn(`Agent ID ${agentIdParam} not found in list.`);
        }
    }

    // Decide whether to show launcher
    // If not loading a specific conversation and no agent selected, show launcher
    // Also check if we are just starting up
    if (!hasConversation && !state.agentId) {
        showLauncher();
    }
    
    // Add skip button listener (delegated since it might be re-rendered)
    agentElements.launcherContainer.addEventListener('click', (e) => {
        if (e.target.id === 'skipAgentBtn') {
            hideLauncher();
        }
    });
  }

  function handleAgentSelection(agent) {
      // Handle Deselection / Manual Mode
      if (!agent) {
          agentSystemLog.info('Clearing agent selection.');
          state.agent = null;
          state.agentId = null;
          
          if (agentElements.activeName) agentElements.activeName.textContent = 'None';
          if (agentElements.activeRole) agentElements.activeRole.textContent = 'Manual';
          if (agentElements.activeAvatar) agentElements.activeAvatar.innerHTML = '<i class="fas fa-robot"></i>';
          
          if (agentListView) agentListView.setSelectedAgent(null);

          hideLauncher();
          appendMessage({ role: 'system', content: 'Agent selection cleared. You are now in manual mode.' }, { persist: false, count: false });
          
          // Show default summary
          if (agentElements.summaryName) agentElements.summaryName.textContent = 'No Agent';
          return;
      }
      
      agentSystemLog.info('Selected agent:', { id: agent._id, name: agent.displayName });
      state.agent = agent;
      state.agentId = agent._id;
      
      // Sync list view selection if initialized
      if (agentListView) {
          agentListView.setSelectedAgent(agent._id);
      }
      
      // Update Model Selection
      if (agent.defaultModel) {
            // Force disable user interaction if we want to be strict, or just select it
            // elements.modelSelect.disabled = true; // Optional: Enforce agent model? 
            
           // If not found in select, maybe add it? 
           if (elements.modelSelect.querySelector(`option[value="${agent.defaultModel}"]`) === null) {
               const opt = document.createElement('option');
               opt.value = agent.defaultModel;
               opt.textContent = agent.defaultModel + ' (Agent)';
               elements.modelSelect.appendChild(opt);
           }
           elements.modelSelect.value = agent.defaultModel;
           state.settings.model = agent.defaultModel;
           updateConfigSummary();
      }
      
      // Update UI Panels
      updateAgentPanel(agent);
      updateChatHeader(agent);
      
      hideLauncher();
      
      // Notify user
      appendMessage({
          role: 'system',
          content: `Activated agent **${agent.displayName}**. ${agent.description ? agent.description.slice(0, 100) : ''}...`
      }, { persist: false, count: false });

      const pendingMessage = elements.messageInput?.value.trim();
      if (pendingMessage) {
          sendMessage();
      } else if (elements.messageInput) {
          elements.messageInput.focus();
      }
  }

  function updateAgentPanel(agent) {
      if (!agent) return;
      
      // Update Active Panel
      if (agentElements.activeName) agentElements.activeName.textContent = agent.displayName;
      if (agentElements.activeRole) agentElements.activeRole.textContent = agent.category ? agent.category.charAt(0).toUpperCase() + agent.category.slice(1) : 'Agent';
      
      // Avatar
      const avatarHtml = agent.avatar && agent.avatar.startsWith('http')
        ? `<img src="${agent.avatar}" alt="${agent.displayName}">`
        : `<i class="fas ${agent.avatar || 'fa-robot'}"></i>`;
      if (agentElements.activeAvatar) agentElements.activeAvatar.innerHTML = avatarHtml;

      // Stats
      const activeModelSpan = agentElements.activeModel?.querySelector('span');
      if (activeModelSpan) activeModelSpan.textContent = agent.defaultModel;
      const activeToolsSpan = agentElements.activeTools?.querySelector('span');
      if (activeToolsSpan) activeToolsSpan.textContent = `${agent.n8nTools?.length || 0} Tools`;
      
      // Summary Panel (Collapsed)
      if (agentElements.summaryName) agentElements.summaryName.textContent = agent.displayName;
      if (agentElements.summaryTools) agentElements.summaryTools.textContent = agent.n8nTools?.length || 0;
      
      // Toggle Visibility
      if (agentElements.activePanel) agentElements.activePanel.style.display = 'block';
      if (agentElements.agentSummary) agentElements.agentSummary.style.display = 'flex';
      if (agentElements.defaultSummary) agentElements.defaultSummary.style.display = 'none';
  }

  function updateChatHeader(agent) {
      // Find or create a header in the chat window top area
      let header = document.getElementById('chatAgentHeader');
      const chatWindow = document.getElementById('chatWindow');
      
      if (!agent) {
          if (header) header.remove();
          return;
      }
      
      if (!header) {
          header = document.createElement('div');
          header.id = 'chatAgentHeader';
          header.className = 'chat-agent-header';
          // Insert at the top of chatWindow
          chatWindow.insertBefore(header, chatWindow.firstChild);
      }
      
      const catConfig = agentListView && agentListView.agents ? (agent.category || 'general') : 'general';
      // Basic styling override for this dynamic element
      header.innerHTML = `
        <div class="chat-agent-header-content">
            <span class="chat-agent-avatar"><i class="fas ${agent.avatar || 'fa-robot'}"></i></span>
            <div class="chat-agent-info">
                <span class="chat-agent-name">Chatting with ${agent.displayName}</span>
                <span class="chat-agent-model"><i class="fas fa-microchip"></i> ${agent.defaultModel}</span>
            </div>
        </div>
      `;
  }

  function showLauncher() {
      if (agentElements.launcherContainer) {
          agentElements.launcherContainer.style.display = 'flex';
          if (agentListView && (!agentListView.agents || agentListView.agents.length === 0)) {
              agentListView.load();
          }
      }
  }

  function hideLauncher() {
      if (agentElements.launcherContainer) {
          agentElements.launcherContainer.style.display = 'none';
      }
  }

  // Initialize
  initAgentSystem();

});
