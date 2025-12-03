(() => {
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

  const defaults = {
    host: 'localhost',
    port: '11434',
    model: '',
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
    settings: loadSettings(),
    conversationId: null, // Current conversation ID
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem('agentx-settings');
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
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

  function updateRangeDisplays() {
    document.querySelectorAll('.value[data-for="temperature"]').forEach((el) => {
      el.textContent = elements.temperature.value;
    });
    document.querySelectorAll('.value[data-for="topP"]').forEach((el) => {
      el.textContent = elements.topP.value;
    });
  }

  function hydrateForm() {
    const cfg = state.settings;
    elements.hostInput.value = cfg.host;
    elements.portInput.value = cfg.port;
    elements.modelSelect.value = cfg.model;
    elements.systemPrompt.value = cfg.system;
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

  function setStatus(text, tone = 'muted') {
    elements.statusChip.textContent = text;
    const color = tone === 'success' ? '#7cf0ff' : tone === 'error' ? '#ff9ca0' : '#93a0b5';
    elements.statusChip.style.color = color;
  }

  function setFeedback(text, tone = 'muted') {
    elements.feedback.textContent = text;
    elements.feedback.style.color = tone === 'success' ? '#9ff6ff' : tone === 'error' ? '#ffb3b8' : 'var(--muted)';
  }

  // Modified to support message ID for feedback
  function renderMessage(role, content, messageId = null, feedback = null) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role === 'user' ? 'user' : 'assistant'}`;
    if (messageId) bubble.dataset.id = messageId;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span>${role === 'user' ? 'You' : 'AgentX'}</span>`;

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
    elements.chatWindow.appendChild(bubble);
    elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
  }

  function appendMessage(role, content, options = {}) {
    const persist = options.persist !== false;
    const count = options.count !== false;
    // Note: Render happens here for temporary display, but re-rendered properly on reload/load history
    // For immediate feedback we render without ID first, or we wait for server response?
    // We'll render immediately, and if we get an ID later (from server), we can update it?
    // Actually, for simplicity, we render immediately. The ID is only needed for feedback on assistant messages.

    renderMessage(role, content, options.messageId, options.feedback);

    if (persist) {
      state.history.push({ role, content });
    }
    if (count) {
      if (role === 'user') {
        state.stats.messages += 1;
      }
      if (role === 'assistant') {
        state.stats.replies += 1;
      }
    }
    elements.statMessages.textContent = state.stats.messages;
    elements.statReplies.textContent = state.stats.replies;
  }

  function clearChat() {
    state.history = [];
    state.conversationId = null;
    state.stats = { messages: 0, replies: 0 };
    elements.chatWindow.innerHTML = '';
    appendMessage('assistant', 'Chat cleared. Choose a model and say hi!', { persist: false, count: false });
    loadHistoryList(); // Refresh list to show new conversation if any
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
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
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
      console.error(err);
      setStatus('Connection failed', 'error');
      setFeedback(err.message, 'error');
    }
  }

  async function sendMessage() {
    if (state.sending) return;
    const message = elements.messageInput.value.trim();
    const model = elements.modelSelect.value;
    if (!message) return;
    if (!model) {
      setFeedback('Select an Ollama model first.', 'error');
      return;
    }

    appendMessage('user', message);
    elements.messageInput.value = '';
    state.sending = true;
    elements.sendBtn.textContent = 'Sending…';

    try {
      const payload = {
        target: targetHost(),
        model,
        system: elements.systemPrompt.value.trim(),
        options: readOptions(),
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

      state.conversationId = data.conversationId; // Update ID

      const responseText =
        data.data?.message?.content ||
        data.data?.response ||
        data.data?.output ||
        'No response from Ollama.';

      // We need to know the message ID of the assistant response to attach feedback
      // The current API response structure from our backend wrapper needs to provide this if possible.
      // Or we reload the conversation messages?
      // For now, let's just append. If we want feedback on *this* message immediately, we might need to fetch the message ID.
      // But we can't get subdocument ID easily without reloading or returning it.
      // Let's rely on reloading the chat if we want perfect ID sync, OR return the whole updated conversation.

      // Since we just saved it, let's try to get the ID from the backend response if we modified it to return the new message ID.
      // But we didn't.
      // HACK: We will reload the conversation silently or just fetch the history list to update the sidebar.

      appendMessage('assistant', responseText, {
          // Ideally we'd have the ID here.
          // Future improvement: Return the new message ID in the /chat response.
      });

      setFeedback('Response received.', 'success');
      loadHistoryList(); // Update sidebar

      // Refetch full conversation to get IDs for feedback
      if(state.conversationId) loadConversation(state.conversationId);

    } catch (err) {
      console.error(err);
      appendMessage('assistant', `⚠️ ${err.message || 'Request failed.'}`, { persist: false });
      setFeedback(err.message, 'error');
      setStatus('Check Ollama host/port.', 'error');
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
                  feedback: msg.feedback
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
    hydrateForm();
    attachEvents();
    clearChat();
    fetchModels();
    loadHistoryList(); // Load history on start
    setStatus('Ready');
    setFeedback('Set host/model, then start chatting.');
  }

  init();
})();
