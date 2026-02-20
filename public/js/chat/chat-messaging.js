/**
 * Chat messaging — sendMessage, streaming, appendMessage, renderMessage
 */
import { getRagOptions, readOptions, targetHost, readProfileInputs, updateConfigSummary } from './chat-config.js';

function sanitizeHTML(dirty) {
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify not loaded - XSS protection disabled!');
    return dirty;
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

// Exported for use by other modules (quality assessment, history)
export { sanitizeHTML };

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function setStatus(elements, text, tone = 'muted') {
  elements.statusChip.textContent = text;
  const color = tone === 'success' ? '#7cf0ff' : tone === 'error' ? '#ff9ca0' : '#93a0b5';
  elements.statusChip.style.color = color;
}

export function setFeedback(elements, text, tone = 'muted') {
  elements.feedback.textContent = text;
  elements.feedback.style.color = tone === 'success' ? '#9ff6ff' : tone === 'error' ? '#ffb3b8' : 'var(--muted)';
}

/**
 * Show a modal dialog (replaces browser confirm/alert for structured content)
 */
export function showModal(title, bodyHTML) {
  let overlay = document.getElementById('genericModal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'genericModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:600px;max-height:80vh;overflow-y:auto;">
        <div class="modal-header">
          <h2 id="genericModalTitle"></h2>
          <button class="close-btn" id="genericModalClose">&times;</button>
        </div>
        <div class="modal-body" id="genericModalBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
    overlay.querySelector('#genericModalClose').addEventListener('click', () => overlay.classList.add('hidden'));
  }
  overlay.querySelector('#genericModalTitle').textContent = title;
  overlay.querySelector('#genericModalBody').innerHTML = sanitizeHTML(bodyHTML);
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
}

function buildRagSourceViewer(source, idx, setFeedbackFn) {
  const viewSource = () => {
    const title = source.metadata?.filename || 'Unknown Source';
    const score = source.score ? `${(source.score * 100).toFixed(0)}% match` : '';
    const content = source.content || source.excerpt || 'No content available';
    const bodyHTML = `
      <p><strong>Source:</strong> ${title} ${score ? `<span style="color:var(--accent)">(${score})</span>` : ''}</p>
      ${source.metadata?.filepath ? `<p style="font-size:0.8rem;color:var(--muted);">Path: ${source.metadata.filepath}</p>` : ''}
      <pre style="background:#000;padding:12px;border-radius:6px;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word;font-size:0.85rem;">${content}</pre>
    `;
    showModal(`Source [${idx + 1}]: ${title}`, bodyHTML);
  };
  return viewSource;
}

export function renderMessage(message, state, elements) {
  const role = message.role;
  const content = message.content;
  const messageId = message.id || message._id || null;
  const createdAt = message.createdAt || new Date().toISOString();
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
  meta.appendChild(document.createTextNode(' \u2022 '));
  meta.appendChild(time);

  const body = document.createElement('div');
  body.className = 'message-body';
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

  // Message action bar (hover actions)
  if (role !== 'system' && !isSystemMessage) {
    const actionBar = document.createElement('div');
    actionBar.className = 'message-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
      }).catch(() => {
        copyBtn.innerHTML = '<i class="fas fa-times"></i>';
        setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
      });
    });
    actionBar.appendChild(copyBtn);

    if (role === 'user') {
      // Edit button (repopulates composer)
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.title = 'Edit';
      editBtn.innerHTML = '<i class="fas fa-pen"></i>';
      editBtn.addEventListener('click', () => {
        elements.messageInput.value = content;
        elements.messageInput.focus();
      });
      actionBar.appendChild(editBtn);
    }

    if (role === 'assistant') {
      // Regenerate button
      const regenBtn = document.createElement('button');
      regenBtn.className = 'msg-action-btn';
      regenBtn.title = 'Regenerate';
      regenBtn.innerHTML = '<i class="fas fa-redo"></i>';
      regenBtn.addEventListener('click', () => {
        // Find the last user message
        const lastUserMsg = [...state.history].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          elements.messageInput.value = lastUserMsg.content;
          // Trigger send
          elements.sendBtn.click();
        }
      });
      actionBar.appendChild(regenBtn);
    }

    bubble.appendChild(actionBar);
  }

  // Code block copy buttons
  const codeBlocks = body.querySelectorAll('pre code, pre');
  codeBlocks.forEach((block) => {
    if (block.parentElement.tagName === 'PRE' && block.tagName === 'CODE') {
      // It's a <pre><code> — work with the <pre>
      const pre = block.parentElement;
      if (pre.querySelector('.code-block-header')) return; // already processed

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const header = document.createElement('div');
      header.className = 'code-block-header';

      // Detect language from class
      const langClass = Array.from(block.classList).find(c => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : '';
      const langLabel = document.createElement('span');
      langLabel.className = 'code-lang-label';
      langLabel.textContent = lang;
      header.appendChild(langLabel);

      const copyCodeBtn = document.createElement('button');
      copyCodeBtn.className = 'code-copy-btn';
      copyCodeBtn.innerHTML = '<i class="fas fa-copy"></i> Copy';
      copyCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(block.textContent).then(() => {
          copyCodeBtn.innerHTML = '<i class="fas fa-check"></i> Copied';
          setTimeout(() => { copyCodeBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        }).catch(() => {
          copyCodeBtn.innerHTML = '<i class="fas fa-times"></i> Failed';
          setTimeout(() => { copyCodeBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        });
      });
      header.appendChild(copyCodeBtn);

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    }
  });

  // RAG Citation Display
  if (role === 'assistant' && message.ragSources && Array.isArray(message.ragSources) && message.ragSources.length > 0) {
    const citationsDiv = document.createElement('details');
    citationsDiv.className = 'message-citations';

    const citationsTitle = document.createElement('summary');
    citationsTitle.className = 'citations-title';
    citationsTitle.style.cursor = 'pointer';
    citationsTitle.style.listStyle = 'none';
    citationsTitle.innerHTML = '<i class="fas fa-chevron-right" style="font-size: 0.8em; margin-right: 6px; transition: transform 0.2s;"></i><i class="fas fa-book"></i><span>Sources</span>';
    citationsDiv.appendChild(citationsTitle);

    citationsDiv.addEventListener('toggle', () => {
      const icon = citationsTitle.querySelector('.fa-chevron-right');
      icon.style.transform = citationsDiv.open ? 'rotate(90deg)' : 'rotate(0deg)';
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
        sourceScore.textContent = `${(source.score * 100).toFixed(0)}% match`;
      }

      sourceHeader.appendChild(sourceNum);
      sourceHeader.appendChild(sourceTitle);
      if (source.score) sourceHeader.appendChild(sourceScore);

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

      const viewSource = buildRagSourceViewer(source, idx, (msg, tone) => setFeedback(elements, msg, tone));
      sourceItem.addEventListener('click', viewSource);
      sourceItem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewSource(); }
      });

      citationsDiv.appendChild(sourceItem);
    });

    bubble.appendChild(citationsDiv);
  }

  // Stats Footer + Cost Display
  if (state.showStats && role === 'assistant' && (message.stats || message.cost)) {
    const statsDiv = document.createElement('div');
    statsDiv.className = 'message-stats';
    const parts = [];
    if (message.stats) {
      const { usage, performance } = message.stats;
      if (usage) parts.push(`${usage.totalTokens} tokens`);
      if (performance) {
        const duration = (performance.totalDuration / 1e9).toFixed(2);
        const tps = performance.tokensPerSecond ? `(${performance.tokensPerSecond} t/s)` : '';
        parts.push(`${duration}s ${tps}`);
      }
    }
    if (message.cost && message.cost.totalCost > 0) {
      const cost = message.cost.totalCost;
      parts.push(cost < 0.01 ? `$${cost.toFixed(6)}` : `$${cost.toFixed(4)}`);
    }
    if (parts.length > 0) {
      statsDiv.textContent = parts.join(' \u2022 ');
      bubble.appendChild(statsDiv);
    }
  }

  // Feedback controls for actual AI responses
  if (role === 'assistant' && messageId && !messageId.startsWith('a-')) {
    bubble.appendChild(buildFeedbackRow(messageId, state, elements));
  }

  elements.chatWindow.appendChild(bubble);
  elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
}

function buildFeedbackRow(messageId, state, elements) {
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
      up.disabled = true;
      down.disabled = true;
      comment.disabled = true;
      await sendFeedback(state, messageId, rating, comment.value);
      up.style.display = 'none';
      down.style.display = 'none';
      comment.style.display = 'none';
      label.style.display = 'none';
      status.textContent = rating > 0 ? 'Thanks! Marked helpful.' : 'Noted. Feedback saved.';
    } catch (err) {
      status.textContent = err.message;
      up.disabled = false;
      down.disabled = false;
      comment.disabled = false;
    }
  };

  const up = document.createElement('button');
  up.className = 'ghost';
  up.textContent = '\ud83d\udc4d';
  up.title = 'Good answer';
  up.addEventListener('click', () => send(1));

  const down = document.createElement('button');
  down.className = 'ghost';
  down.textContent = '\ud83d\udc4e';
  down.title = 'Needs work';
  down.addEventListener('click', () => send(-1));

  row.appendChild(up);
  row.appendChild(down);
  row.appendChild(comment);
  row.appendChild(status);
  return row;
}

async function sendFeedback(state, messageId, rating, comment) {
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

export function appendMessage(messageOrRole, contentOrOptions, state, elements, renderLogList, updateAnalyzeButtonVisibility, maybeOptions) {
  const isStringPayload = typeof messageOrRole === 'string';
  const options = isStringPayload ? (maybeOptions || {}) : (contentOrOptions || {});
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

  renderMessage(message, state, elements);

  if (persist) state.history.push(message);
  if (count) {
    if (message.role === 'user') state.stats.messages += 1;
    if (message.role === 'assistant') state.stats.replies += 1;
  }
  elements.statMessages.textContent = state.stats.replies;
  renderLogList(state.history);
  updateAnalyzeButtonVisibility();
}

export function renderLogList(elements, messages) {
  if (!elements.logWindow) return;
  elements.logWindow.innerHTML = '';
  const recent = (messages || []).slice(-8).reverse();
  recent.forEach((msg) => {
    const item = document.createElement('div');
    item.className = 'log-item';
    const left = document.createElement('div');
    left.innerHTML = `<strong>${msg.role === 'user' ? 'User' : 'AgentX'}</strong><div class="log-meta">${formatTime(msg.createdAt)}</div>`;
    const right = document.createElement('div');
    right.className = 'log-meta';
    right.textContent = `${msg.content.slice(0, 42)}${msg.content.length > 42 ? '\u2026' : ''}`;
    item.appendChild(left);
    item.appendChild(right);
    elements.logWindow.appendChild(item);
  });
}

function buildPayload(elements, state, defaults, message) {
  const ragOpts = getRagOptions(elements);
  return {
    target: targetHost(elements, defaults),
    model: elements.modelSelect.value,
    system: elements.systemPrompt.value.trim(),
    options: {
      ...readOptions(elements),
      persona: elements.promptSelect?.value || 'default_chat',
      ragExpand: ragOpts.ragExpand,
      ragHybrid: ragOpts.ragHybrid,
      ragRerank: ragOpts.ragRerank,
      ragCompress: ragOpts.ragCompress
    },
    useRag: ragOpts.useRag,
    ragTopK: ragOpts.ragTopK,
    threadId: state.threadId,
    agentId: state.agentId,
    message,
    profile: readProfileInputs(elements),
    messages: state.history,
    conversationId: state.conversationId
  };
}

export async function sendMessageStreamFetch(ctx, msgInput, modelInput) {
  const { elements, state, defaults, helpers } = ctx;
  const message = msgInput || elements.messageInput.value.trim();

  const payload = buildPayload(elements, state, defaults, message);

  const assistantMessageDiv = document.createElement('div');
  assistantMessageDiv.className = 'message assistant';
  assistantMessageDiv.dataset.messageId = `a-${Date.now()}`;

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

  elements.sendBtn.textContent = 'Stop';
  elements.sendBtn.onclick = () => {
    if (state.streamAbortController) {
      state.streamAbortController.abort();
      state.streamAbortController = null;
    }
    state.sending = false;
    elements.sendBtn.textContent = 'Send';
    elements.sendBtn.onclick = () => helpers.sendMessage();
    helpers.setFeedback('Streaming stopped.', 'warning');
  };

  let fullContent = '';
  let thinkingContent = '';
  let doneReceived = false;

  const safeParseJson = (text, fallback) => {
    try { return JSON.parse(text); } catch { return fallback; }
  };

  const dispatchEvent = (eventName, rawData) => {
    if (eventName === 'token') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      fullContent += data.content || '';
      try {
        contentDiv.innerHTML = sanitizeHTML(marked.parse(fullContent));
      } catch (e) {
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
        role: 'assistant', content: fullContent,
        createdAt: new Date().toISOString(),
        id: finalData.messageId || null,
        stats: finalData.stats || null,
        thinking: thinkingContent || null
      };
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      helpers.appendMessage(assistantMessage);
      helpers.speakText(fullContent);
      helpers.setFeedback('Response received.', 'success');
      helpers.loadHistoryList();
      if (state.conversationId) helpers.loadConversation(state.conversationId, true);
      if (window.checkSetupProgress) setTimeout(() => window.checkSetupProgress(), 500);
      doneReceived = true;
      return;
    }
    if (eventName === 'error') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      throw new Error(data.message || 'Streaming failed.');
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
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) { eventName = line.slice('event:'.length).trim() || 'message'; continue; }
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      }
      const data = dataLines.join('\n');
      if (eventName !== 'message') dispatchEvent(eventName, data);
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
      parseAndDispatchSse(decoder.decode(value, { stream: true }), bufferState);
      if (doneReceived) { abortController.abort(); }
    }
    if (!doneReceived) {
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      helpers.appendMessage({ role: 'assistant', content: fullContent || '(no content)', createdAt: new Date().toISOString() });
      helpers.setFeedback('Response received.', 'success');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      if (fullContent || thinkingContent) {
        helpers.appendMessage(
          { role: 'assistant', content: fullContent || '(stopped)', createdAt: new Date().toISOString(), thinking: thinkingContent || null },
          { persist: false }
        );
      }
      return;
    }
    console.error('Fetch streaming error:', err);
    if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
    helpers.appendMessage(
      { role: 'assistant', content: `\u26a0\ufe0f ${err.message || 'Streaming failed.'}`, createdAt: new Date().toISOString() },
      { persist: false }
    );
    helpers.setFeedback(err.message, 'error');
  } finally {
    state.streamAbortController = null;
    state.sending = false;
    elements.sendBtn.textContent = 'Send';
    elements.sendBtn.onclick = () => helpers.sendMessage();
  }
}

export async function sendMessage(ctx) {
  const { elements, state, defaults, helpers } = ctx;
  if (state.sending) return;
  const message = elements.messageInput.value.trim();
  const model = elements.modelSelect.value;
  if (!message) return;
  if (!model) {
    helpers.setFeedback('Select a model first.', 'error');
    return;
  }

  const userMessage = { role: 'user', content: message, id: `u-${Date.now()}`, createdAt: new Date().toISOString() };
  helpers.appendMessage(userMessage);
  elements.messageInput.value = '';
  elements.messageInput.style.height = 'auto'; // Reset auto-resize
  state.sending = true;
  elements.sendBtn.textContent = 'Sending\u2026';

  if (elements.streamToggle && elements.streamToggle.checked) {
    await sendMessageStreamFetch(ctx, message, model);
    return;
  }

  try {
    const payload = { ...buildPayload(elements, state, defaults, message), stream: false };
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
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Chat failed');

    state.profile = data.data?.profile || state.profile;
    state.conversationId = data.data?.conversationId || state.conversationId;

    const responseText = data.data?.message?.content || data.data?.response || data.data?.output || 'No response from Ollama.';
    const assistantMessage = {
      role: 'assistant', content: responseText,
      createdAt: new Date().toISOString(),
      id: data.data?.messageId || null,
      stats: data.data?.stats || null
    };
    helpers.appendMessage(assistantMessage);
    helpers.speakText(responseText);

    if (data.warning) {
      helpers.setFeedback(`\u26a0\ufe0f ${data.warning}`, 'warning');
      setTimeout(() => helpers.setFeedback('Response received.', 'success'), 3000);
    } else {
      helpers.setFeedback('Response received.', 'success');
    }
    helpers.loadHistoryList();
    if (state.conversationId) helpers.refreshStats(state.conversationId);
    if (state.conversationId) helpers.loadConversation(state.conversationId, true);
    if (window.checkSetupProgress) setTimeout(() => window.checkSetupProgress(), 500);
  } catch (err) {
    console.error(err);
    helpers.appendMessage(
      { role: 'assistant', content: `\u26a0\ufe0f ${err.message || 'Request failed.'}`, createdAt: new Date().toISOString() },
      { persist: false }
    );
    helpers.setFeedback(err.message, 'error');
    helpers.setStatus('Check host/model.', 'error');
  } finally {
    state.sending = false;
    elements.sendBtn.textContent = 'Send';
  }
}

export async function fetchModels(ctx, showStatus = true) {
  const { elements, state, defaults, helpers } = ctx;
  if (showStatus) helpers.setStatus('Connecting\u2026');
  try {
    const fetchOptions = {};
    const host = targetHost(elements, defaults);
    const res = await fetch(
      `/api/ollama/models?target=${encodeURIComponent(host)}`,
      window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
    );
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'Unable to load models');
    elements.modelSelect.innerHTML = '';
    if (!data.data || data.data.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models found';
      elements.modelSelect.appendChild(opt);
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a model\u2026';
      elements.modelSelect.appendChild(placeholder);
      data.data.forEach((model) => {
        const opt = document.createElement('option');
        opt.value = model.name;
        opt.textContent = model.name;
        elements.modelSelect.appendChild(opt);
      });
      if (state.settings.model) elements.modelSelect.value = state.settings.model;
    }
    helpers.setStatus(`Connected to ${host}`, 'success');
    helpers.setFeedback('Models refreshed from Ollama.', 'success');
    updateConfigSummary(elements);
  } catch (err) {
    console.warn('Failed to fetch models:', err.message);
    helpers.setStatus('Connection failed', 'error');
    let userMessage = 'Unable to connect to Ollama.';
    if (err.message.includes('EHOSTUNREACH') || err.message.includes('ECONNREFUSED')) {
      userMessage = `Cannot reach ${targetHost(elements, defaults)}. Check if Ollama is running.`;
    } else if (err.message.includes('ETIMEDOUT')) {
      userMessage = `Connection timed out.`;
    } else if (err.message.includes('500')) {
      userMessage = err.message;
    }
    helpers.setFeedback(userMessage, 'error');
    elements.modelSelect.innerHTML = '<option value="">\u26a0\ufe0f Connection failed</option>';
  }
}
