document.addEventListener('DOMContentLoaded', () => {
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
    statReplies: document.getElementById('statReplies'),
    refreshModels: document.getElementById('refreshModels'),
    testConnection: document.getElementById('testConnection'),
    saveDefaults: document.getElementById('saveDefaults'),
    feedback: document.getElementById('feedback'),
    quickActions: document.querySelectorAll('[data-quick]'),
    streamToggle: document.getElementById('streamToggle'),
    logWindow: document.getElementById('logWindow'),
    threadId: document.getElementById('threadId'),
    memoryLanguage: document.getElementById('memoryLanguage'),
    memoryRole: document.getElementById('memoryRole'),
    memoryStyle: document.getElementById('memoryStyle'),
    saveProfile: document.getElementById('saveProfile'),
    refreshProfile: document.getElementById('refreshProfile'),
    // New Elements
    historyList: document.getElementById('historyList'),
    newChatBtn: document.getElementById('newChatBtn'),
    profileBtn: document.getElementById('profileBtn'),
    profileModal: document.getElementById('profileModal'),
    closeProfileBtn: document.getElementById('closeProfileBtn'),
    saveProfileBtn: document.getElementById('saveProfileBtn'),
    userAbout: document.getElementById('userAbout'),
    userInstructions: document.getElementById('userInstructions'),
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
    stream: false,
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
      system: elements.systemPrompt.value.trim() || defaults.system,
      options: readOptions(),
    };
    localStorage.setItem('agentx-settings', JSON.stringify(payload));
    state.settings = payload;
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
    // Use saved settings if they exist, otherwise use defaults (which may include server config)
    elements.hostInput.value = cfg.host || defaults.host;
    elements.portInput.value = cfg.port || defaults.port;
    elements.modelSelect.value = cfg.model;
    elements.systemPrompt.value = cfg.system;
    elements.streamToggle.checked = cfg.stream;
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

  function renderMessage(message, feedback = null) {
    const role = message.role;
    const content = message.content;
    const messageId = message.id || message._id || null;
    const createdAt = message.createdAt || new Date().toISOString();

    const bubble = document.createElement('div');
    bubble.className = `bubble ${role === 'user' ? 'user' : 'assistant'}`;
    if (messageId) bubble.dataset.id = messageId;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span>${role === 'user' ? 'You' : 'AgentX'}</span>`;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(createdAt);
    meta.appendChild(document.createTextNode(' • '));
    meta.appendChild(time);

    // Feedback UI for Assistant messages
    if (role === 'assistant' && messageId) {
      const feedbackDiv = document.createElement('div');
      feedbackDiv.className = 'feedback-actions';

      const upBtn = document.createElement('button');
      upBtn.innerHTML = '👍';
      upBtn.className = `feedback-btn ${feedback?.rating === 1 ? 'active' : ''}`;
      upBtn.onclick = () => submitFeedback(messageId, 1);

      const downBtn = document.createElement('button');
      downBtn.innerHTML = '👎';
      downBtn.className = `feedback-btn ${feedback?.rating === -1 ? 'active' : ''}`;
      downBtn.onclick = () => submitFeedback(messageId, -1);

      feedbackDiv.appendChild(upBtn);
      feedbackDiv.appendChild(downBtn);
      meta.appendChild(feedbackDiv);
    }

    const body = document.createElement('p');
    body.textContent = content;

    bubble.appendChild(meta);
    bubble.appendChild(body);

    if (role === 'assistant') {
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
        await sendFeedback(messageId, rating, comment.value);
        status.textContent = rating > 0 ? 'Thanks! Marked helpful.' : 'Noted. Feedback saved.';
      } catch (err) {
        status.textContent = err.message;
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

    renderMessage(message, options.feedback || message.feedback);

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
    elements.statMessages.textContent = state.stats.messages;
    elements.statReplies.textContent = state.stats.replies;
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
    } catch (err) {
      console.warn('Failed to fetch models:', err.message);
      setStatus('Model refresh failed', 'error');
      setFeedback('Click "Refresh models" to retry connection', 'info');
      // Add a default option so UI doesn't break
      elements.modelSelect.innerHTML = '<option value="">Click "Refresh models"</option>';
    }
  }



  function readProfileInputs() {
    return {
      language: elements.memoryLanguage.value.trim(),
      role: elements.memoryRole.value.trim(),
      style: elements.memoryStyle.value.trim(),
    };
  }

  async function loadLogs() {
    try {
      const res = await fetch(`/api/logs?threadId=${encodeURIComponent(state.threadId)}`);
      if (!res.ok) {
        refreshMessages();
        return;
      }
      const data = await res.json();
      if (data.status === 'success' && data.data?.messages) {
        state.history = data.data.messages;
        refreshMessages();
        return;
      }
    } catch (err) {
      // Silently skip if logs endpoint not available
    }
    refreshMessages();
  }

  function refreshMessages() {
    elements.chatWindow.innerHTML = '';
    state.stats = { messages: 0, replies: 0 };
    state.history.forEach((msg) => appendMessage(msg, { persist: false }));
  }

  async function sendFeedback(messageId, rating, comment) {
    const payload = { threadId: state.threadId, messageId, rating, comment };
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Chat failed');
      }

      state.profile = data.data?.profile || state.profile;
      const response = data.data?.message || {
        role: 'assistant',
        content: 'No response from AgentX backend.',
        createdAt: new Date().toISOString(),
        id: `a-${Date.now()}`,
      };

      appendMessage(response);
      state.conversationId = data.conversationId; // Update ID

      const responseText =
        data.data?.message?.content ||
        data.data?.response ||
        data.data?.output ||
        'No response from Ollama.';

      appendMessage('assistant', responseText);

      setFeedback('Response received.', 'success');
      loadHistoryList();

      // Reload conversation to sync message IDs for feedback
      if(state.conversationId) loadConversation(state.conversationId);

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
      loadLogs();
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
      } catch (err) {
          console.error('Failed to load history', err);
      }
  }

  async function loadConversation(id) {
      try {
          const res = await fetch(`/api/history/${id}`);
          const { data } = await res.json();
          state.conversationId = data._id;
          state.history = []; // We will rebuild history from DB
          elements.chatWindow.innerHTML = '';

          state.stats.messages = 0;
          state.stats.replies = 0;

            data.messages.forEach(msg => {
                appendMessage(msg.role, msg.content, {
                    persist: true, // It's already in DB, but we want it in local state.history for context
                    count: true,
                    messageId: msg._id,
                    feedback: msg.feedback,
                    createdAt: msg.createdAt,
                });
            });

          // Restore settings from conversation if needed? No, keep current settings.
          // But maybe update model select?
          if(data.model) elements.modelSelect.value = data.model;

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
              })
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
              })
          });
          elements.profileModal.classList.add('hidden');
          setFeedback('Profile saved.', 'success');
      } catch (err) {
          console.error('Failed to save profile', err);
          setFeedback('Failed to save profile.', 'error');
      }
  }

  function attachEvents() {
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.clearBtn.addEventListener('click', clearChat);
    elements.refreshModels.addEventListener('click', () => fetchModels(false));
    elements.testConnection.addEventListener('click', () => fetchModels(true));
    elements.saveDefaults.addEventListener('click', persistSettings);
    elements.saveProfile.addEventListener('click', saveProfile);
    elements.refreshProfile.addEventListener('click', loadProfile);

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
    });

    elements.streamToggle.addEventListener('change', persistSettings);

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
  }

  function init() {
    // Load settings after defaults are potentially updated by server config
    state.settings = loadSettings();
    elements.threadId.textContent = state.threadId;
    hydrateForm();
    attachEvents();
    clearChat();
    loadProfile();
    fetchModels();
    loadHistoryList(); // Load history on start
    setStatus('Ready');
    setFeedback('Set host/model, then start chatting.');
    loadLogs();
  }

  // Load server config first, then initialize
  loadServerConfig().then(() => {
    init();
  }).catch(err => {
    console.warn('Server config load failed, using defaults:', err);
    init();
  });
});
