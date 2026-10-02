/**
 * Chat message rendering: sanitizing, turn identity, status line, modal,
 * message bubbles and the feedback row.
 */
import { appendRagDisplay } from './chat-rag-sources.js';

function sanitizeHTML(dirty) {
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify not loaded - rendering escaped text.');
    return String(dirty ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
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

function messageIdOf(message) {
  const value = message?.id ?? message?._id ?? null;
  return value === null || value === undefined ? null : String(value);
}

/**
 * Resolve the user turn paired with one rendered assistant response.
 *
 * New responses carry an explicit source id. Historical responses fall back
 * to their exact assistant id and the closest preceding user turn. Content is
 * deliberately never used as identity because repeated prompts are valid.
 */
export function userTurnForAssistant(history, assistantMessage) {
  const turns = Array.isArray(history) ? history : [];
  const explicitUserId = assistantMessage?.retryUserMessageId
    || assistantMessage?.sourceUserMessageId
    || null;

  if (explicitUserId) {
    const normalizedUserId = String(explicitUserId);
    return turns.find((turn) => (
      turn?.role === 'user' && messageIdOf(turn) === normalizedUserId
    )) || null;
  }

  const assistantId = messageIdOf(assistantMessage);
  let assistantIndex = turns.indexOf(assistantMessage);
  if (assistantIndex < 0 && assistantId) {
    assistantIndex = turns.findIndex((turn) => (
      turn?.role === 'assistant' && messageIdOf(turn) === assistantId
    ));
  }
  if (assistantIndex < 0) return null;

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === 'user') return turns[index];
  }
  return null;
}

export function turnActionForRequest(turnAction) {
  if (!turnAction) return null;
  const kind = turnAction.kind || turnAction.action;
  const sourceUserMessageId = turnAction.sourceUserMessageId == null
    ? null
    : String(turnAction.sourceUserMessageId);
  const sourceAssistantMessageId = turnAction.sourceAssistantMessageId == null
    ? null
    : String(turnAction.sourceAssistantMessageId);

  if ((kind !== 'ask-again' && kind !== 'retry') || !sourceUserMessageId) return null;
  if (kind === 'ask-again' && !sourceAssistantMessageId) return null;
  if (kind === 'retry' && sourceAssistantMessageId !== null) return null;

  return { kind, sourceUserMessageId, sourceAssistantMessageId };
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function modelFromStats(message) {
  return message?.stats?.meta?.model
    || message?.stats?.meta?.routingInfo?.routedModel
    || message?.stats?.meta?.routingInfo?.model
    || null;
}

function buildMessageRuntimeInfo(message) {
  if (!message || message.role !== 'assistant') return null;
  const routingInfo = message.routingInfo
    || message.metadata?.routingInfo
    || message.meta?.routingInfo
    || message.stats?.meta?.routingInfo
    || null;
  const model = routingInfo?.model
    || routingInfo?.routedModel
    || message.metadata?.model
    || modelFromStats(message);
  if (!model) return null;

  const host = routingInfo?.hostName || routingInfo?.routedHost || routingInfo?.host || routingInfo?.routedHostUrl || '';
  const route = routingInfo?.taskType || (routingInfo?.autoRouted ? 'auto' : routingInfo ? 'direct' : '');
  return { model, host, route };
}

export function setStatus(elements, text, tone = 'muted') {
  elements.statusChip.textContent = text;
  elements.statusChip.dataset.tone = tone;
  const container = elements.statusChip.closest('.chat-command-status');
  if (container) container.dataset.tone = tone;
  const icon = container?.querySelector('.chat-command-status__icon i');
  if (icon) {
    const working = /loading|sending|thinking|routing|waiting/i.test(text);
    icon.className = tone === 'success'
      ? 'fas fa-circle-check'
      : tone === 'error'
        ? 'fas fa-circle-xmark'
        : tone === 'warning'
          ? 'fas fa-triangle-exclamation'
          : working
            ? 'fas fa-circle-notch fa-spin'
            : 'fas fa-circle-info';
  }
}

export function setFeedback(elements, text, tone = 'muted') {
  elements.feedback.textContent = text;
  elements.feedback.style.color = tone === 'success' ? '#9ff6ff' : tone === 'error' ? '#ffb3b8' : tone === 'warning' ? '#ffd166' : 'var(--muted)';
}

export function handleSendButtonAction({ elements, state, helpers }) {
  const activeController = state.streamAbortController;
  if (!activeController) {
    void helpers.sendMessage();
    return 'send';
  }

  state.streamStopRequestedController = activeController;
  activeController.abort();
  // The active attempt owns `state.sending` and the controller until its
  // finally block settles. This prevents a late old attempt from clearing a
  // newer request that the user launched during an abort race.
  elements.sendBtn.disabled = true;
  elements.sendBtn.textContent = 'Stopping\u2026';
  helpers.setFeedback('Stopping stream\u2026', 'warning');
  return 'stop';
}

export function isUserRequestedStreamStop(error, state, requestAbortController) {
  return error?.name === 'AbortError'
    && state.streamStopRequestedController === requestAbortController;
}

/**
 * Show a modal dialog (replaces browser confirm/alert for structured content)
 */
export function showModal(title, bodyHTML) {
  let dialog = document.getElementById('genericModal');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'genericModal';
    dialog.className = 'chat-detail-dialog';
    dialog.setAttribute('aria-labelledby', 'genericModalTitle');
    dialog.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2 id="genericModalTitle"></h2>
          <button type="button" class="close-btn" id="genericModalClose" aria-label="Close details" autofocus>&times;</button>
        </div>
        <div class="modal-body" id="genericModalBody"></div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.querySelector('#genericModalClose').addEventListener('click', () => dialog.close());
  }
  dialog.querySelector('#genericModalTitle').textContent = title;
  const body = dialog.querySelector('#genericModalBody');
  if (typeof bodyHTML === 'string') body.innerHTML = sanitizeHTML(bodyHTML);
  else body.replaceChildren(bodyHTML);
  if (!dialog.open) dialog.showModal();
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

  const runtimeInfo = buildMessageRuntimeInfo(message);
  if (runtimeInfo) {
    const modelBadge = document.createElement('span');
    modelBadge.className = 'message-model-badge';
    modelBadge.textContent = runtimeInfo.model;
    modelBadge.title = [
      `model: ${runtimeInfo.model}`,
      runtimeInfo.host ? `host: ${runtimeInfo.host}` : '',
      runtimeInfo.route ? `route: ${runtimeInfo.route}` : ''
    ].filter(Boolean).join('\n');
    meta.appendChild(document.createTextNode(' \u2022 '));
    meta.appendChild(modelBadge);
  }

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

    if (role === 'assistant' && (messageId || message.retryUserMessageId)) {
      const isRetry = Boolean(message.retryUserMessageId);
      // A completed persisted reply is not replaced by the current API. Call
      // that operation "Ask again" and persist an honest new user turn. Retry
      // is reserved for an attempt that never reached a durable completion.
      const actionLabel = isRetry ? 'Retry' : 'Ask again';
      const turnActionBtn = document.createElement('button');
      turnActionBtn.type = 'button';
      turnActionBtn.className = 'msg-action-btn';
      turnActionBtn.title = actionLabel;
      turnActionBtn.dataset.turnAction = isRetry ? 'retry' : 'ask-again';
      turnActionBtn.setAttribute('aria-label', `${actionLabel} this turn`);
      turnActionBtn.innerHTML = '<i class="fas fa-redo" aria-hidden="true"></i>';
      turnActionBtn.addEventListener('click', async () => {
        const userTurn = userTurnForAssistant(state.history, message);
        const userMessageId = messageIdOf(userTurn);
        if (!userTurn || !userMessageId || typeof state._helpers?.sendMessage !== 'function') {
          state._helpers?.setFeedback?.('This turn no longer has stable message evidence. Reload the conversation and try again.', 'error');
          return;
        }

        turnActionBtn.disabled = true;
        try {
          await state._helpers.sendMessage({
            action: isRetry ? 'retry' : 'ask-again',
            sourceUserMessageId: userMessageId,
            sourceAssistantMessageId: messageId
          });
        } finally {
          if (turnActionBtn.isConnected) turnActionBtn.disabled = false;
        }
      });
      actionBar.appendChild(turnActionBtn);
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

  if (role === 'assistant') appendRagDisplay(bubble, message, showModal);

  // Web Search Sources Display
  const webResults = (role === 'assistant') && (message.webSearchResults || message.metadata?.webSearchResults);
  if (webResults && Array.isArray(webResults) && webResults.length > 0) {
    const webSourcesDiv = document.createElement('details');
    webSourcesDiv.className = 'message-web-sources';

    const webTitle = document.createElement('summary');
    webTitle.className = 'web-sources-title';
    webTitle.style.cursor = 'pointer';
    webTitle.style.listStyle = 'none';
    webTitle.innerHTML = `<i class="fas fa-chevron-right" style="font-size: 0.8em; margin-right: 6px; transition: transform 0.2s;"></i><i class="fas fa-globe"></i><span>Web Sources (${webResults.length})</span>`;
    webSourcesDiv.appendChild(webTitle);

    webSourcesDiv.addEventListener('toggle', () => {
      const icon = webTitle.querySelector('.fa-chevron-right');
      if (icon) icon.style.transform = webSourcesDiv.open ? 'rotate(90deg)' : 'rotate(0deg)';
    });

    webResults.forEach((result, idx) => {
      const item = document.createElement('div');
      item.className = 'web-source-item';

      const link = document.createElement('a');
      link.href = safeExternalUrl(result.url);
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'web-source-link';
      link.textContent = result.title || `Source ${idx + 1}`;

      item.appendChild(link);

      if (result.snippet) {
        const snippet = document.createElement('div');
        snippet.className = 'web-source-snippet';
        snippet.textContent = result.snippet;
        item.appendChild(snippet);
      }

      webSourcesDiv.appendChild(item);
    });

    bubble.appendChild(webSourcesDiv);
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

  // Per-message routing badge (Chat Intelligence layer)
  if (message.role === 'assistant' && typeof ChatIntelligence !== 'undefined') {
    const routingInfo = message.routingInfo || message.meta?.routingInfo;
    if (routingInfo) {
      const badge = ChatIntelligence.createRoutingBadge(routingInfo);
      if (badge) bubble.appendChild(badge);
    }
  }

  elements.chatWindow.appendChild(bubble);
  elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
}

function buildFeedbackRow(messageId, state, elements) {
  const row = document.createElement('div');
  row.className = 'feedback-row';

  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = 'Was this helpful?';
  row.appendChild(label);

  const controls = document.createElement('div');
  controls.className = 'feedback-controls';

  const comment = document.createElement('input');
  comment.type = 'text';
  comment.className = 'feedback-comment';
  comment.placeholder = 'Add an optional note, then click thumbs.';
  comment.autocomplete = 'off';

  const noteToggle = document.createElement('button');
  noteToggle.className = 'ghost small feedback-note-toggle';
  noteToggle.type = 'button';
  noteToggle.textContent = 'Add note';
  noteToggle.setAttribute('aria-expanded', 'false');

  const cancelNote = document.createElement('button');
  cancelNote.className = 'ghost small feedback-note-toggle';
  cancelNote.type = 'button';
  cancelNote.textContent = 'Hide note';
  cancelNote.style.display = 'none';

  const status = document.createElement('span');
  status.className = 'muted';

  const setNoteVisibility = (visible) => {
    comment.classList.toggle('visible', visible);
    noteToggle.style.display = visible ? 'none' : '';
    cancelNote.style.display = visible ? '' : 'none';
    noteToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible) comment.focus();
    else comment.value = '';
  };

  const send = async (rating) => {
    try {
      up.disabled = true;
      down.disabled = true;
      noteToggle.disabled = true;
      cancelNote.disabled = true;
      comment.disabled = true;
      await sendFeedback(state, messageId, rating, comment.value);
      up.style.display = 'none';
      down.style.display = 'none';
      noteToggle.style.display = 'none';
      cancelNote.style.display = 'none';
      comment.style.display = 'none';
      controls.style.display = 'none';
      label.style.display = 'none';
      status.textContent = rating > 0 ? 'Thanks! Marked helpful.' : 'Noted. Feedback saved.';
    } catch (err) {
      status.textContent = err.message;
      up.disabled = false;
      down.disabled = false;
      noteToggle.disabled = false;
      cancelNote.disabled = false;
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

  noteToggle.addEventListener('click', () => setNoteVisibility(true));
  cancelNote.addEventListener('click', () => setNoteVisibility(false));
  comment.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setNoteVisibility(false);
    }
  });

  controls.appendChild(up);
  controls.appendChild(down);
  controls.appendChild(noteToggle);
  controls.appendChild(cancelNote);
  row.appendChild(controls);
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

export { messageIdOf };
