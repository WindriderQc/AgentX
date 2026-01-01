// Authentication check
async function checkAuth() {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.status === 'success') {
        displayUserInfo(data.user);
        return true;
      }
    }
    
    // Not authenticated - show login button
    showLoginButton();
    return false;
  } catch (error) {
    console.log('Auth check failed:', error);
    showLoginButton();
    return false;
  }
}

function showLoginButton() {
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.style.display = 'block';
  }
}

function displayUserInfo(user) {
  const userMenu = document.getElementById('userMenu');
  const userName = document.getElementById('userName');
  
  if (userMenu && userName) {
    userName.textContent = user.name || user.email;
    userMenu.style.display = 'flex';
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
    
    localStorage.removeItem('user');
    window.location.href = '/login.html';
  } catch (error) {
    console.error('Logout failed:', error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Check authentication first
  checkAuth();

  const elements = {
    chatWindow: document.getElementById('chatWindow'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    clearBtn: document.getElementById('clearBtn'),
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
    // Auth elements
    userMenu: document.getElementById('userMenu'),
    userName: document.getElementById('userName'),
    logoutBtn: document.getElementById('logoutBtn'),
    loginBtn: document.getElementById('loginBtn'),
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
    showStats: true, // V4: Toggle message stats
  };

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
      useRag: elements.ragToggle.checked,
      showStats: elements.statsToggle.checked, // V4: Save stats preference
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
    elements.ragToggle.checked = cfg.useRag !== undefined ? cfg.useRag : true;
    elements.statsToggle.checked = state.showStats; // V4
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
    meta.innerHTML = `<span>${role === 'user' ? 'You' : 'AgentX'}</span>`;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(createdAt);
    meta.appendChild(document.createTextNode(' • '));
    meta.appendChild(time);

    const body = document.createElement('div');
    if (typeof marked !== 'undefined') {
      // Configure marked options if needed
      // marked.setOptions({ breaks: true }); 
      body.innerHTML = marked.parse(content);
    } else {
      body.textContent = content;
    }

    bubble.appendChild(meta);
    bubble.appendChild(body);

    // V4: Stats Footer
    if (state.showStats && message.stats && role === 'assistant') {
      const statsDiv = document.createElement('div');
      statsDiv.className = 'message-stats';
      statsDiv.style.fontSize = '0.75rem';
      statsDiv.style.color = 'var(--muted)';
      statsDiv.style.marginTop = '0.5rem';
      statsDiv.style.paddingTop = '0.5rem';
      statsDiv.style.borderTop = '1px solid rgba(255,255,255,0.05)';

      const { usage, performance } = message.stats;
      const parts = [];

      if (usage) {
        parts.push(`${usage.totalTokens} tokens`);
      }
      if (performance) {
        // Convert ns to s
        const duration = (performance.totalDuration / 1e9).toFixed(2);
        const tps = performance.tokensPerSecond ? `(${performance.tokensPerSecond} t/s)` : '';
        parts.push(`${duration}s ${tps}`);
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
      const res = await fetch(`/api/ollama/models?target=${encodeURIComponent(targetHost())}`);
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

    try {
      const payload = {
        target: targetHost(),
        model,
        system: elements.systemPrompt.value.trim(),
        options: readOptions(),
        stream: elements.streamToggle.checked,
        useRag: elements.ragToggle.checked,
        threadId: state.threadId,
        message,
        profile: readProfileInputs(),
        messages: state.history,
        conversationId: state.conversationId
      };

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      });
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

      // Reload conversation to sync message IDs for feedback
      if(state.conversationId) {
          // Preserve model selection - user may have changed it from what's saved in DB
          loadConversation(state.conversationId, true);
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
          const res = await fetch('/api/history');
          const { data } = await res.json();
          elements.historyList.innerHTML = '';
          data.forEach(item => {
              const div = document.createElement('div');
              div.className = 'history-item';
              div.innerHTML = `
                <div class="title">${item.title}</div>
                <div class="date">${new Date(item.date).toLocaleString()}</div>
              `;
              div.onclick = () => loadConversation(item.id);
              elements.historyList.appendChild(div);
          });
          return data;
      } catch (err) {
          console.error('Failed to load history', err);
          return [];
      }
  }

  async function loadConversation(id, preserveModelSelection = false) {
      try {
          const res = await fetch(`/api/history/${id}`);
          const { data } = await res.json();
          state.conversationId = data._id;
          state.history = []; // We will rebuild history from DB
          elements.chatWindow.innerHTML = '';

          state.stats.messages = 0;
          state.stats.replies = 0;

            data.messages.forEach(msg => {
                // Manually construct message object to include stats
                const messageObj = {
                    role: msg.role,
                    content: msg.content,
                    createdAt: msg.createdAt,
                    id: msg._id,
                    feedback: msg.feedback,
                    stats: msg.stats // V4: Pass stats to rendering
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

      } catch (err) {
          console.error('Failed to load conversation', err);
      }
  }

  async function submitFeedback(messageId, rating) {
      if(!state.conversationId) return;
      try {
          await fetch('/api/feedback', {
            method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  conversationId: state.conversationId,
                  messageId,
                  rating
              }),
              credentials: 'include'
          });
          // Refresh to show active state
          loadConversation(state.conversationId);
      } catch (err) {
          console.error('Feedback failed', err);
      }
  }

  async function loadProfile() {
      try {
          const res = await fetch('/api/profile');
          const { data } = await res.json();
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
      } catch (err) {
          console.error('Failed to save profile', err);
          setFeedback('Failed to save profile.', 'error');
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
  let isRecording = false;

  function startVoiceInput() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setFeedback('Speech recognition not supported in this browser.', 'error');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isRecording = true;
      elements.micBtn.classList.add('recording');
      elements.micBtn.setAttribute('aria-pressed', 'true');
      setStatus('Listening...', 'success');
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      elements.messageInput.value = transcript;
      // Optional: Automatically send? For now let user review.
      // sendMessage();
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error', event.error);
      setFeedback(`Voice error: ${event.error}`, 'error');
      cleanupVoiceInput();
    };

    recognition.onend = () => {
      cleanupVoiceInput();
    };

    // Cancel any ongoing speech when starting input
    window.speechSynthesis.cancel();
    recognition.start();
  }

  function stopVoiceInput() {
    // User requested stop
    if (recognition) {
      // recognition.stop() will trigger onend, which calls cleanupVoiceInput
      recognition.stop();
    } else {
      cleanupVoiceInput();
    }
  }

  function cleanupVoiceInput() {
    recognition = null;
    isRecording = false;
    elements.micBtn.classList.remove('recording');
    elements.micBtn.setAttribute('aria-pressed', 'false');
    setStatus('Idle');
  }

  function toggleVoiceInput() {
    if (isRecording) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }

  function speakText(text) {
    if (!state.settings.tts) return;

    // Simple browser TTS
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
    elements.micBtn.addEventListener('click', toggleVoiceInput);
    elements.ttsToggle.addEventListener('change', persistSettings);
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.clearBtn.addEventListener('click', clearChat);
    elements.refreshModels.addEventListener('click', () => fetchModels(true));
    elements.saveDefaults.addEventListener('click', persistSettings);
    
    // Auth events
    if (elements.logoutBtn) {
      elements.logoutBtn.addEventListener('click', logout);
    }
    if (elements.loginBtn) {
      elements.loginBtn.addEventListener('click', () => {
        window.location.href = '/login.html';
      });
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
    });
    
    if (elements.statsToggle) elements.statsToggle.addEventListener('change', persistSettings);

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
    elements.threadId.textContent = state.threadId;
    hydrateForm();
    attachEvents();
    clearChat();
    loadProfile();
    await fetchModels();

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
    });

    // Initialize config summary
    updateConfigSummary();

    // Load history and open latest conversation if available
    const history = await loadHistoryList();
    if (history && history.length > 0) {
        loadConversation(history[0].id);
    } else {
        setStatus('Ready');
        setFeedback('Set host/model, then start chatting.');
    }
  }

  // Load server config first, then initialize
  loadServerConfig().then(() => {
    init();
  }).catch(err => {
    console.warn('Server config load failed, using defaults:', err);
    init();
  });
});
