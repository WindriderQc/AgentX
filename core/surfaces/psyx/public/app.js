'use strict';

const STORAGE_KEY = 'psyx.activeConversationId';
// Shared with the Node test suite (public/voice-preferences.js): browser-local voice
// preferences that travel with each request and never change VoiX service defaults.
const voicePreferences = window.PsyXVoicePreferences;
const MAX_CONTEXT_MESSAGES = 40;
const ACTION_PREFIX = '[PSYX_ACTION:';

const state = {
  mode: 'auto',
  depth: 'auto',
  applied: null,
  conversationId: localStorage.getItem(STORAGE_KEY) || null,
  history: [],
  busy: false,
  ready: false,
  unlocked: false,
  accessEpoch: 0,
  accessMode: 'token',
  modeConfig: {},
  depthConfig: {},
  psyxState: null,
  routing: null,
  sessions: [],
  sessionStatus: 'active',
  activeAbort: null,
  turnSequence: 0,
  thinkingObserved: false,
  managedSessionId: null,
  lastDrawerTrigger: null,
  voice: {
    enabled: false,
    reachable: false,
    recorder: null,
    mediaStream: null,
    chunks: [],
    stopTimer: null,
    playback: null,
    status: null,
    prefs: { ...voicePreferences.DEFAULTS }
  }
};

const $ = (id) => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const send = $('send');
const composer = $('composer');
const statusDot = $('statusDot');
const statusText = $('statusText');
const sessionLabel = $('sessionLabel');
const routeLabel = $('routeLabel');
const modeSummary = $('modeSummary');
const depthSummary = $('depthSummary');
const controlExplainer = $('controlExplainer');
const stateSaveStatus = $('stateSaveStatus');
const privacyGate = $('privacyGate');
const appShell = $('appShell');
const drawerBackdrop = $('drawerBackdrop');
const cancelGeneration = $('cancelGeneration');
const dataDialog = $('dataDialog');
const resetMemoryDialog = $('resetMemoryDialog');
const sessionDataDialog = $('sessionDataDialog');
const voiceDialog = $('voiceDialog');
const voiceRecord = $('voiceRecord');

try {
  state.voice.prefs = voicePreferences.readPreferences(localStorage);
} catch { state.voice.prefs = voicePreferences.normalizePreferences({}); }

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderText(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function addMessage(role, content, extraClass = '') {
  const article = document.createElement('article');
  const visualRole = role === 'action' ? 'action' : role;
  article.className = `message ${visualRole} ${extraClass}`.trim();
  const avatar = role === 'user' ? 'YOU' : role === 'action' ? '↳' : 'PX';
  article.innerHTML = `<div class="avatar">${avatar}</div><div class="bubble">${renderText(content)}</div>`;
  messages.appendChild(article);
  article.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return article;
}

function createStreamingAssistant() {
  const article = addMessage('assistant', '', 'streaming');
  const bubble = article.querySelector('.bubble');
  let text = '';
  return {
    article,
    append(token) {
      text += String(token || '');
      bubble.innerHTML = renderText(text);
      article.scrollIntoView({ behavior: 'auto', block: 'end' });
    },
    set(value) {
      text = String(value || '');
      bubble.innerHTML = renderText(text);
    },
    text: () => text
  };
}

function clearRenderedConversation() {
  for (const node of [...messages.querySelectorAll('.message:not(.intro)')]) node.remove();
}

function showGate(message = '') {
  clearSessionExperience();
  stopVoiceSession();
  state.accessEpoch += 1;
  state.turnSequence += 1;
  state.activeAbort?.abort();
  state.voice.speech?.cancel();
  state.voice.mediaStream?.getTracks().forEach(track => track.stop());
  clearTimeout(state.voice.stopTimer);
  if (state.voice.recorder?.state === 'recording') state.voice.recorder.stop();
  state.voice.recorder = null;
  state.voice.mediaStream = null;
  state.voice.chunks = [];
  stopReviewWatch();
  review.last = null;
  hideSafety();
  resetFollowUp();
  resetProfileDraft();
  stopDreamWatch();
  resetToolbox();
  state.unlocked = false;
  state.ready = false;
  state.history = [];
  state.sessions = [];
  state.psyxState = null;
  clearSetup();
  // The static intro stays; the conversation and the recap of past sessions go.
  clearRenderedConversation();
  if ($('openingRecap')) { $('openingRecap').replaceChildren(); $('openingRecap').hidden = true; }
  for (const form of document.querySelectorAll('form')) form.reset();
  input.value = '';
  sessionLabel.textContent = 'PsyX verrouillé';
  $('sessionDataTitle').textContent = 'Conversation PsyX';
  renderSessions();
  renderPsyXState();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  closeDrawers({ restoreFocus: false });
  document.body.classList.add('psyx-locked');
  privacyGate.hidden = false;
  appShell.setAttribute('aria-hidden', 'true');
  $('unlockStatus').textContent = message;
  setTimeout(() => $('unlockCode').focus(), 0);
}

function hideGate() {
  state.unlocked = true;
  document.body.classList.remove('psyx-locked');
  privacyGate.hidden = true;
  appShell.setAttribute('aria-hidden', 'false');
}

function setBusy(busy) {
  state.busy = busy;
  send.disabled = busy || !state.ready;
  input.disabled = busy || !state.ready;
  send.hidden = busy;
  cancelGeneration.hidden = !busy;
  updateVoiceButton();
  syncVoiceSessionControls();
}

function setReady(ready, label) {
  state.ready = ready;
  statusDot.classList.toggle('online', ready);
  statusDot.classList.toggle('offline', !ready);
  statusText.textContent = label;
  setBusy(false);
}

const AUTO_INFO = { title: 'Auto', short: 'PsyX décide.', description: 'Après chaque réponse, PsyX réfléchit à la conversation et choisit comment répondre ensuite.' };
// French labels for the interface; the server's English descriptions stay model-facing.
const MODE_LABELS = {
  talk: { title: 'Écoute', short: 'Rester avec le vécu.', description: 'Rester proche de l’expérience vécue, aider à nommer ce qui se passe, sans sauter trop vite à l’analyse ou aux solutions.' },
  analyze: { title: 'Analyse', short: 'Comprendre le mécanisme.', description: 'Cartographier déclencheurs, croyances, dynamiques émotionnelles, contradictions, hypothèses concurrentes et boucles.' },
  challenge: { title: 'Confrontation', short: 'Mettre l’histoire à l’épreuve.', description: 'Confronter les suppositions, l’évitement, la rationalisation et les certitudes que les faits ne soutiennent pas.' },
  plan: { title: 'Plan', short: 'Passer à l’action.', description: 'Transformer la compréhension en une petite intervention observable : expérience, limite, conversation ou décision.' }
};
const DEPTH_LABELS = {
  normal: { title: 'Normale', short: 'Raisonnement local solide.', description: 'Concis, conversationnel et utile.' },
  deep: { title: 'Profonde', short: 'Raisonnement plus délibéré.', description: 'Formulation délibérée, hypothèses concurrentes, tendances dans le temps et effets de second ordre, sans verbosité.' }
};

function currentModeInfo(mode = state.mode) {
  if (mode === 'auto') return AUTO_INFO;
  return { title: mode, short: '', description: '', ...state.modeConfig[mode], ...MODE_LABELS[mode] };
}

function currentDepthInfo(depth = state.depth) {
  if (depth === 'auto') return AUTO_INFO;
  return {
    title: depth,
    short: '',
    description: '',
    taskType: depth === 'deep' ? 'deep_reasoning' : 'analysis',
    think: depth === 'deep',
    ...state.depthConfig[depth],
    ...DEPTH_LABELS[depth]
  };
}

// What the next reply will use: an explicit choice, or the review's
// recommendation for this conversation when the choice is auto.
function upcomingControl() {
  const next = state.conversationId ? sessionDigest(state.conversationId)?.next : null;
  const autoMode = state.mode === 'auto';
  const autoDepth = state.depth === 'auto';
  return {
    mode: autoMode ? next?.stance || 'talk' : state.mode,
    depth: autoDepth ? next?.depth || 'normal' : state.depth,
    auto: { mode: autoMode, depth: autoDepth },
    reason: autoMode ? next?.reason || '' : ''
  };
}

function renderStance() {
  const control = state.busy && state.applied ? state.applied : upcomingControl();
  const stance = currentModeInfo(control.mode).title || control.mode;
  const prefix = state.busy && state.applied ? 'Réponse en cours' : 'Prochaine réponse';
  $('stanceDot').dataset.stance = control.mode;
  $('stanceLabel').textContent = `${prefix} : ${stance}${control.auto.mode ? ' · auto' : ''}${control.depth === 'deep' ? ' · réflexion profonde' : ''}`;
  $('stanceReason').textContent = control.reason
    || (control.auto.mode
      ? 'PsyX choisit sa posture après avoir réfléchi à la conversation.'
      : 'Posture choisie par toi. Choisis Auto pour laisser PsyX décider.');
  renderFrontier(control);
}

function updateControlExplanation() {
  const mode = currentModeInfo();
  const depth = currentDepthInfo();
  modeSummary.textContent = `${mode.title || state.mode} · ${mode.short || ''}`;
  depthSummary.textContent = `${depth.title || state.depth} · ${depth.short || ''}`;
  controlExplainer.innerHTML = state.mode === 'auto' && state.depth === 'auto'
    ? `<strong>Auto</strong> ${escapeHtml(AUTO_INFO.description)}`
    : `<strong>${escapeHtml(mode.title || state.mode)}</strong> ${escapeHtml(mode.description || '')}<br><strong>${escapeHtml(depth.title || state.depth)}</strong> ${escapeHtml(depth.description || '')}`;
  renderStance();
  updateBrainRouting();
}

function updateContextStatus() {
  const recentCount = state.history.filter((item) => item.role !== 'action').length;
  $('contextStatus').textContent = `${recentCount} message${recentCount === 1 ? '' : 's'} récent${recentCount === 1 ? '' : 's'} affiché${recentCount === 1 ? '' : 's'} (maximum ${MAX_CONTEXT_MESSAGES}). Le contexte de confiance est reconstruit depuis le stockage de PsyX.`;
  const coverage = state.applied?.contextCoverage;
  if (coverage) $('contextStatus').textContent += ` Pour cette réponse : ${coverage.includedMessages}/${coverage.availableMessages} messages précédents transmis${coverage.complete ? '.' : ' · contexte partiel.'}`;
}

function stripLegacyControlPrefix(content) {
  const value = String(content || '');
  if (!value.startsWith('[PSYX SESSION CONTROL]')) return value;
  const marker = '[/PSYX SESSION CONTROL]';
  const markerIndex = value.indexOf(marker);
  return markerIndex < 0 ? value : value.slice(markerIndex + marker.length).trim();
}

function actionMessage(type) {
  return {
    role: 'action',
    action: type,
    content: type === 'deep_reflection' ? 'Réflexion profonde demandée' : `Action PsyX · ${type}`
  };
}

function parseAction(content) {
  const value = String(content || '');
  if (!value.startsWith(ACTION_PREFIX)) return null;
  const end = value.indexOf(']');
  if (end < 0) return null;
  const type = value.slice(ACTION_PREFIX.length, end);
  return actionMessage(type);
}

function normalizeConversationMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .filter((item) => item && ['user', 'assistant', 'action'].includes(item.role))
    .map((item) => {
      if (item.role === 'action') {
        return actionMessage(item.action || parseAction(item.content)?.action || 'unknown');
      }
      if (item.role === 'user') {
        const content = stripLegacyControlPrefix(item.content);
        return parseAction(content) || { role: 'user', content };
      }
      return { role: 'assistant', content: String(item.content || '') };
    })
    .filter((item) => item.content.trim())
    .slice(-MAX_CONTEXT_MESSAGES);
}

function turnMatchesHistoryTail(history, humanText, actionType) {
  if (history.length < 2 || history.at(-1)?.role !== 'assistant') return false;
  const request = history.at(-2);
  if (actionType) return request?.role === 'action' && request.action === actionType;
  return request?.role === 'user' && request.content === humanText;
}

function historySignature(history) {
  return JSON.stringify(history.map((item) => [item.role, item.action || null, item.content]));
}

async function reconcileCompletedTurn(conversationId, humanText, actionType, previousSignature, turnSequence) {
  if (!conversationId) return false;
  // A cancel/disconnect can race PsyX's final persistence and the terminal SSE
  // event. Re-read only the known scoped session; never infer completion from a
  // partial browser buffer.
  for (const waitMs of [150, 350, 700, 1200, 1800]) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      const conversation = await api(
        `/api/psyx/sessions/${encodeURIComponent(conversationId)}`,
        { cache: 'no-store' }
      );
      const serverHistory = normalizeConversationMessages(conversation.messages);
      if (historySignature(serverHistory) === previousSignature
        || !turnMatchesHistoryTail(serverHistory, humanText, actionType)) continue;
      if (state.turnSequence !== turnSequence || state.busy) {
        await loadSessions();
        return true;
      }
      state.history = serverHistory;
      clearRenderedConversation();
      for (const item of state.history) addMessage(item.role, item.content);
      updateContextStatus();
      sessionLabel.textContent = conversation.title || `Séance ${String(conversationId).slice(-8)}`;
      await loadSessions();
      highlightActiveSession();
      return true;
    } catch (error) {
      if (error.code === 'PSYX_LOCKED') return false;
      if (waitMs === 1800) console.warn('PsyX cancel reconciliation skipped', error);
    }
  }
  return false;
}

async function api(url, options = {}) {
  const accessEpoch = state.accessEpoch;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  assertCurrentAccess(accessEpoch);
  if (response.status === 401 && payload.code === 'PSYX_LOCKED') {
    showGate('PsyX a été verrouillé ou la séance privée a expiré.');
  }
  if (!response.ok || payload.status === 'error' || payload.ok === false) {
    const error = new Error(payload.message || `La requête a échoué (${response.status})`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload.data ?? payload;
}

function assertCurrentAccess(epoch) {
  if (epoch !== state.accessEpoch) {
    throw Object.assign(new Error('PsyX a été verrouillé pendant cette requête.'), { name: 'AbortError', code: 'PSYX_LOCKED' });
  }
}

async function restoreConversation(conversationId = state.conversationId) {
  clearSessionExperience();
  stopVoiceSession();
  if (!conversationId) return;
  try {
    const conversation = await api(`/api/psyx/sessions/${encodeURIComponent(conversationId)}`);
    if (conversation.promptName && conversation.promptName !== 'psyx') throw new Error('La conversation enregistrée n’est pas une séance PsyX');
    if (conversation.lifecycle?.status === 'archived') {
      startNewSession(false);
      return;
    }
    state.conversationId = String(conversationId);
    localStorage.setItem(STORAGE_KEY, state.conversationId);
    state.history = normalizeConversationMessages(conversation.messages);
    hideSafety();
    frontierUi.fallbackNote = '';
    clearRenderedConversation();
    for (const item of state.history) addMessage(item.role, item.content);
    updateContextStatus();
    sessionLabel.textContent = conversation.title || `Séance ${state.conversationId.slice(-8)}`;
    highlightActiveSession();
    renderOpening();
    void resumeReviewStatus(state.conversationId);
  } catch (error) {
    if (error.code !== 'PSYX_LOCKED') console.warn('PsyX session restore skipped', error);
    if (state.unlocked) startNewSession(false);
  }
}

async function loadRouting() {
  try {
    state.routing = await api('/api/psyx/routing');
    renderRoutingDetails();
    updateBrainRouting();
  } catch (error) {
    console.warn('Routing config unavailable', error);
    $('routingDetails').textContent = 'Les détails du routage sont indisponibles.';
  }
}

function getLaneConfig(depth = upcomingControl().depth) {
  const taskType = depth === 'deep' ? 'deep_reasoning' : 'analysis';
  const entry = state.routing?.taskConfigState?.[taskType]?.effective || state.routing?.taskModels?.[taskType] || null;
  return { taskType, entry };
}

// The footer keeps the technical route discreet; the Brain tab has the details.
function updateBrainRouting(lastResult = null, note = '') {
  const depth = lastResult?.control?.depth || upcomingControl().depth;
  // A frontier reply names its own model; the local lanes come from the router.
  const entry = !lastResult && frontierLocationFor(depth) === 'frontier' ? { model: frontierUi.model, host: '' } : getLaneConfig(depth).entry;
  const routing = lastResult?.routing || {};
  const model = routing.routedModel || lastResult?.model || entry?.model || 'modèle non résolu';
  const host = routing.routedHost || entry?.host || '';
  routeLabel.textContent = `${currentDepthInfo(depth).title || depth} · ${model}${host ? ` @ ${host}` : ''}${note ? ` · ${note}` : ''}`;
}

function renderRoutingDetails() {
  const normal = getLaneConfig('normal');
  const deep = getLaneConfig('deep');
  $('routingDetails').innerHTML = `
    <div class="route-row"><span>Normale</span><strong>${escapeHtml(normal.entry?.model || '—')}</strong><em>${escapeHtml(normal.entry?.host || '—')}</em><small>voie technique : analysis</small></div>
    <div class="route-row"><span>Profonde</span><strong>${escapeHtml(deep.entry?.model || '—')}</strong><em>${escapeHtml(deep.entry?.host || '—')}</em><small>voie technique : deep_reasoning</small></div>
    <p class="state-help">La posture règle l’approche psychologique; ces voies techniques choisissent seulement le modèle qui répond.</p>
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
    renderSessionExperience();
  } catch (error) { if (error.code !== 'PSYX_LOCKED') throw error; }
}

function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.round(diff / 60000);
  if (minutes < 2) return 'maintenant';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} j`;
  return date.toLocaleDateString();
}

function renderSessions() {
  const list = $('sessionsList');
  if (!state.sessions.length) {
    list.innerHTML = `<div class="panel-empty">Aucune séance ${state.sessionStatus === 'archived' ? 'archivée' : 'active'}.</div>`;
    return;
  }
  list.innerHTML = state.sessions.map((item) => `
    <article class="session-card ${String(item.id) === state.conversationId ? 'active' : ''}" data-session-id="${escapeHtml(item.id)}">
      <button class="session-open" type="button" ${state.sessionStatus === 'archived' ? `data-session-options="${escapeHtml(item.id)}"` : `data-session-open="${escapeHtml(item.id)}"`}>
        <strong>${escapeHtml(item.title || 'Conversation PsyX')}</strong>
        <span>${escapeHtml(item.sessionRecap?.summary || sessionDigest(item.id)?.summary || item.preview || 'Pas d’aperçu')}</span>
        <small>${state.sessionStatus === 'archived' ? 'Archivée · ' : ''}${escapeHtml(relativeDate(item.updatedAt))}${item.model ? ` · ${escapeHtml(item.model)}` : ''}${item.promptVersion ? ` · prompt v${escapeHtml(item.promptVersion)}` : ''}</small>
      </button>
      <div class="session-actions">
        <button type="button" data-session-rename="${escapeHtml(item.id)}" aria-label="Renommer la séance">✎</button>
        <button type="button" data-session-options="${escapeHtml(item.id)}" aria-label="Options de la séance">•••</button>
      </div>
    </article>
  `).join('');
}

function highlightActiveSession() {
  for (const node of document.querySelectorAll('.session-card')) node.classList.toggle('active', node.dataset.sessionId === state.conversationId);
}

async function bootstrap() {
  const accessEpoch = state.accessEpoch;
  setReady(false, 'Démarrage de PsyX…');
  try {
    const payload = await api('/api/psyx/bootstrap', { method: 'POST', body: '{}' });
    if (payload?.persona?.active !== true) throw new Error('Le persona PsyX n’est pas actif');
    setSetupCapabilities(payload);
    state.modeConfig = payload.modes || {};
    state.depthConfig = payload.depths || {};
    state.voice.enabled = payload.voice?.enabled === true;
    review.enabled = payload.review?.automatic === true;
    setFrontierCapabilities(payload.frontier);
    const lifecycle = payload.conversationLifecycle || {};
    $('lifecycleStatus').textContent = lifecycle.archive
      ? 'L’archivage et la restauration des conversations sont disponibles.'
      : 'Le stockage du cycle de vie des conversations est indisponible.';
    updateControlExplanation();
    await Promise.all([loadPsyXState(), loadRouting(), loadSessions(), loadVoiceStatus()]);
    await loadToolbox().catch(() => {});
    await restoreConversation();
    assertCurrentAccess(accessEpoch);
    watchDream();
    renderSetup();
    setReady(true, 'PsyX prêt');
    sessionLabel.textContent = state.conversationId ? sessionLabel.textContent : 'Nouvelle conversation';
    if (window.matchMedia('(min-width: 900px)').matches) input.focus({ preventScroll: true });
  } catch (error) {
    if (error.code !== 'PSYX_LOCKED') {
      setReady(false, 'PsyX indisponible');
      console.error('PsyX bootstrap failed', error);
    }
  }
}

function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; }
  catch { return { event, data: { content: dataLines.join('\n') } }; }
}

async function streamChat(payload, onEvent, signal) {
  const response = await fetch('/api/psyx/chat/stream', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && body.code === 'PSYX_LOCKED') showGate('PsyX a été verrouillé ou la séance privée a expiré.');
    const error = new Error(body.message || `La conversation a échoué (${response.status})`);
    error.code = body.code;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (!block || block.startsWith(':')) continue;
      const parsed = parseSseBlock(block);
      if (parsed) onEvent(parsed.event, parsed.data);
    }
  }
}

async function sendMessage(text, overrides = {}) {
  const humanText = String(text || '').trim();
  const actionType = overrides.action || null;
  if ((!humanText && !actionType) || state.busy || !state.ready) return;

  const effectiveMode = overrides.mode || state.mode;
  const effectiveDepth = overrides.depth || state.depth;
  const turnSequence = ++state.turnSequence;
  const previousHistorySignature = historySignature(state.history);

  if (actionType) addMessage('action', actionMessage(actionType).content);
  else addMessage('user', humanText);

  input.value = '';
  resizeInput();
  setBusy(true);
  state.thinkingObserved = false;
  state.applied = null;
  const stream = createStreamingAssistant();
  state.activeAbort = new AbortController();
  const requestAbort = state.activeAbort;
  const cancelVoice = () => requestAbort.abort();
  overrides.signal?.addEventListener('abort', cancelVoice, { once: true });
  if (overrides.signal?.aborted) cancelVoice();

  let finalResult = null;
  let streamError = null;

  try {
    await streamChat({
      message: humanText,
      conversationId: state.conversationId || undefined,
      psyx: { mode: effectiveMode, depth: effectiveDepth, action: actionType, source: overrides.source === 'voice' ? 'voice' : 'text' }
    }, (event, data) => {
      if (!state.unlocked || state.turnSequence !== turnSequence) return;
      if (event === 'token') { stream.append(data.content || ''); overrides.onDelta?.(data.content || ''); }
      else if (event === 'control') {
        state.applied = data;
        renderStance();
        updateContextStatus();
      } else if (event === 'route' && data.location && state.applied) {
        // The frontier model was asked but the local route answers: say so while it answers.
        state.applied = { ...state.applied, location: data.location, contextCoverage: data.contextCoverage || state.applied.contextCoverage };
        renderStance();
        updateContextStatus();
      } else if (event === 'safety') {
        showSafety(data.resources);
      } else if (event === 'thinking') {
        state.thinkingObserved = true;
      } else if (event === 'done') {
        finalResult = data;
      } else if (event === 'error') {
        streamError = new Error(data.message || 'Erreur de diffusion');
      }
    }, state.activeAbort.signal);

    if (!state.unlocked || state.turnSequence !== turnSequence) return;

    if (streamError) throw streamError;
    if (!finalResult) {
      const interrupted = new Error('La connexion s’est terminée avant que PsyX confirme la fin de la réponse.');
      interrupted.code = 'PSYX_STREAM_INCOMPLETE';
      throw interrupted;
    }
    const assistantContent = stream.text().trim() || String(finalResult?.response || finalResult?.message?.content || '').trim();
    if (!assistantContent) throw new Error('Le modèle a renvoyé une réponse vide');
    if (!stream.text().trim()) stream.set(assistantContent);

    state.history.push(
      actionType
        ? actionMessage(actionType)
        : { role: 'user', content: humanText },
      { role: 'assistant', content: assistantContent }
    );
    state.history = state.history.slice(-MAX_CONTEXT_MESSAGES);
    updateContextStatus();

    if (finalResult?.conversationId) {
      state.conversationId = String(finalResult.conversationId);
      localStorage.setItem(STORAGE_KEY, state.conversationId);
      sessionLabel.textContent = `Séance ${state.conversationId.slice(-8)}`;
    }
    // Thinking is a local-route notion; the frontier model reasons on its own.
    const deep = (finalResult.control?.depth || effectiveDepth) === 'deep' && finalResult.routing?.location !== 'frontier';
    updateBrainRouting(finalResult, deep ? (state.thinkingObserved ? 'thinking observed' : 'thinking requested, not observed') : '');
    await loadSessions();
    noteFrontierResult(finalResult);
    if (finalResult?.review?.scheduled) watchReview(state.conversationId);
    maybeAskCheckIn();
    if (state.voice.prefs.spokenReplies && !overrides.voiceSession) void speakText(assistantContent);
    return { text: assistantContent, language: state.voice.prefs.language };
  } catch (error) {
    if (!state.unlocked || state.turnSequence !== turnSequence) return;
    if (error.name === 'AbortError') {
      stream.set('Annulé.');
    } else {
      stream.article.classList.add('error');
      const partial = stream.text().trim();
      stream.set(partial
        ? `${partial}\n\n[Réponse interrompue. PsyX n’a pas confirmé la fin à ce navigateur; recharge la séance avant de réessayer.]`
        : `Je n’ai pas pu terminer cette réponse. ${error.message}`);
      await loadSessions().catch(() => {});
    }
    if (error.code !== 'PSYX_LOCKED' && state.conversationId) {
      void reconcileCompletedTurn(
        state.conversationId,
        humanText,
        actionType,
        previousHistorySignature,
        turnSequence
      );
    }
    if (overrides.voiceSession) throw error;
  } finally {
    overrides.signal?.removeEventListener('abort', cancelVoice);
    if (state.turnSequence === turnSequence) {
      state.activeAbort = null;
      setBusy(false);
      state.applied = null;
      updateControlExplanation();
      if (state.unlocked && !overrides.voiceSession) input.focus();
    }
  }
}

function startNewSession(focus = true) {
  clearSessionExperience();
  stopVoiceSession();
  state.conversationId = null;
  state.history = [];
  localStorage.removeItem(STORAGE_KEY);
  stopReviewWatch();
  review.last = null;
  renderReviewIndicator();
  sessionLabel.textContent = 'Nouvelle conversation';
  hideSafety();
  $('checkInPrompt').hidden = true;
  followUp.openingDone = false;
  frontierUi.fallbackNote = '';
  renderOpening();
  clearRenderedConversation();
  updateContextStatus();
  updateBrainRouting();
  highlightActiveSession();
  if (focus) input.focus();
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function syncSegmentedControls() {
  for (const [containerId, key] of [['modeControl', 'mode'], ['depthControl', 'depth']]) {
    for (const node of $(containerId).querySelectorAll('button')) {
      const active = node.dataset[key] === state[key];
      node.classList.toggle('active', active);
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
}

function wireSegmented(containerId, stateKey) {
  $(containerId).addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || state.busy) return;
    state[stateKey] = button.dataset[stateKey];
    syncSegmentedControls();
    updateControlExplanation();
  });
}

function drawerMode() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function syncDrawerAccessibility() {
  const mobile = drawerMode();
  const sessionsOpen = document.body.classList.contains('sessions-open');
  const insightsOpen = document.body.classList.contains('insights-open');
  for (const [panel, open] of [[$('sessionsPanel'), sessionsOpen], [$('insightsPanel'), insightsOpen]]) {
    const hidden = mobile && !open;
    panel.inert = hidden;
    if (hidden) panel.setAttribute('aria-hidden', 'true');
    else panel.removeAttribute('aria-hidden');
  }
}

function closeDrawers({ restoreFocus = true } = {}) {
  const wasOpen = document.body.classList.contains('sessions-open') || document.body.classList.contains('insights-open');
  const trigger = state.lastDrawerTrigger;
  document.body.classList.remove('sessions-open', 'insights-open');
  $('sessionsToggle').setAttribute('aria-expanded', 'false');
  $('insightsToggle').setAttribute('aria-expanded', 'false');
  drawerBackdrop.hidden = true;
  syncDrawerAccessibility();
  state.lastDrawerTrigger = null;
  if (restoreFocus && wasOpen && trigger?.focus) trigger.focus();
}

function openDrawer(kind) {
  if (!drawerMode()) return;
  closeDrawers({ restoreFocus: false });
  const sessions = kind === 'sessions';
  state.lastDrawerTrigger = $(sessions ? 'sessionsToggle' : 'insightsToggle');
  document.body.classList.add(sessions ? 'sessions-open' : 'insights-open');
  $(sessions ? 'sessionsToggle' : 'insightsToggle').setAttribute('aria-expanded', 'true');
  drawerBackdrop.hidden = false;
  syncDrawerAccessibility();
  $(sessions ? 'sessionsPanel' : 'insightsPanel').focus();
}

function openSessionOptions(conversationId) {
  const session = state.sessions.find((item) => String(item.id) === String(conversationId));
  if (!session) return;
  state.managedSessionId = String(conversationId);
  $('sessionDataTitle').textContent = session.title || 'Conversation PsyX';
  const archived = session.lifecycle?.status === 'archived';
  $('sessionLifecycleCopy').textContent = archived
    ? 'Restaurer ramène cette conversation dans les séances actives. La suppression définitive est irréversible.'
    : 'Archiver retire cette conversation des séances actives sans la supprimer. Elle pourra être restaurée.';
  $('archiveSession').hidden = archived;
  $('restoreSession').hidden = !archived;
  $('sessionDeleteConfirmation').checked = false;
  $('confirmPermanentDelete').disabled = true;
  sessionDataDialog.showModal();
  setTimeout(() => $(archived ? 'restoreSession' : 'archiveSession').focus(), 0);
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

cancelGeneration.addEventListener('click', () => state.activeAbort?.abort());
$('newSession').addEventListener('click', async () => {
  closeDrawers({ restoreFocus: false });
  selectSessionStatus('active');
  startNewSession();
  await loadSessions();
});
$('stanceToggle').addEventListener('click', () => {
  const open = $('stancePanel').hidden;
  $('stancePanel').hidden = !open;
  $('stanceToggle').setAttribute('aria-expanded', String(open));
});

$('sessionsList').addEventListener('click', async (event) => {
  const open = event.target.closest('[data-session-open]');
  if (open) {
    await restoreConversation(open.dataset.sessionOpen);
    closeDrawers({ restoreFocus: false });
    input.focus();
    return;
  }
  const rename = event.target.closest('[data-session-rename]');
  if (rename) {
    const session = state.sessions.find((item) => String(item.id) === rename.dataset.sessionRename);
    const nextTitle = window.prompt('Renommer la séance', session?.title || '');
    if (!nextTitle?.trim()) return;
    await api(`/api/psyx/sessions/${encodeURIComponent(rename.dataset.sessionRename)}`, { method: 'PATCH', body: JSON.stringify({ title: nextTitle.trim() }) });
    await loadSessions();
    if (rename.dataset.sessionRename === state.conversationId) sessionLabel.textContent = nextTitle.trim();
    return;
  }
  const options = event.target.closest('[data-session-options]');
  if (options) openSessionOptions(options.dataset.sessionOptions);
});

document.querySelectorAll('[data-session-status]').forEach((button) => {
  button.addEventListener('click', async () => {
    selectSessionStatus(button.dataset.sessionStatus);
    await loadSessions();
  });
});

async function lockPsyxNow() {
  if (state.accessMode === 'trusted-network') return;
  setReady(false, 'PsyX verrouillé');
  showGate('PsyX est verrouillé.');
  try { await api('/api/psyx/auth/lock', { method: 'POST', body: '{}' }); } catch { /* lock locally regardless */ }
}

$('settingsPsyx').addEventListener('click', () => {
  $('dataStatus').textContent = '';
  dataDialog.showModal();
});

$('exportPsyx').addEventListener('click', async () => {
  const accessEpoch = state.accessEpoch;
  $('dataStatus').textContent = 'Préparation de l’export…';
  try {
    const response = await fetch('/api/psyx/export', { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    assertCurrentAccess(accessEpoch);
    if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('PsyX a été verrouillé ou la séance privée a expiré.');
    if (!response.ok) throw new Error(payload.message || `L’export a échoué (${response.status})`);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `psyx-export-${String(payload.exportedAt || new Date().toISOString()).slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    $('dataStatus').textContent = `Export téléchargé avec ${payload.transcriptData?.conversationCount ?? 0} conversation(s) PsyX.`;
  } catch (error) {
    $('dataStatus').textContent = error.message;
  }
});

$('openResetMemory').addEventListener('click', () => {
  dataDialog.close();
  $('resetMemoryConfirmation').value = '';
  $('confirmResetMemory').disabled = true;
  resetMemoryDialog.showModal();
  setTimeout(() => $('resetMemoryConfirmation').focus(), 0);
});

$('resetMemoryConfirmation').addEventListener('input', () => {
  $('confirmResetMemory').disabled = $('resetMemoryConfirmation').value !== 'RESET PSYX MEMORY';
});

$('confirmResetMemory').addEventListener('click', async () => {
  const confirmation = $('resetMemoryConfirmation').value;
  if (confirmation !== 'RESET PSYX MEMORY') return;
  const cleanState = await api('/api/psyx/state/reset', {
    method: 'POST',
    body: JSON.stringify({ confirmation })
  });
  state.psyxState = cleanState;
  renderPsyXState();
  resetMemoryDialog.close();
});

resetMemoryDialog.addEventListener('close', () => {
  if (state.unlocked) $('settingsPsyx').focus();
});

$('sessionDeleteConfirmation').addEventListener('change', () => {
  $('confirmPermanentDelete').disabled = !$('sessionDeleteConfirmation').checked;
});

$('archiveSession').addEventListener('click', async () => {
  const conversationId = state.managedSessionId;
  if (!conversationId) return;
  await api(`/api/psyx/sessions/${encodeURIComponent(conversationId)}/archive`, {
    method: 'POST',
    body: '{}'
  });
  sessionDataDialog.close();
  if (conversationId === state.conversationId) startNewSession(false);
  await loadSessions();
});

$('restoreSession').addEventListener('click', async () => {
  const conversationId = state.managedSessionId;
  if (!conversationId) return;
  await api(`/api/psyx/sessions/${encodeURIComponent(conversationId)}/restore`, {
    method: 'POST',
    body: '{}'
  });
  sessionDataDialog.close();
  selectSessionStatus('active');
  await loadSessions();
});

$('confirmPermanentDelete').addEventListener('click', async () => {
  const conversationId = state.managedSessionId;
  if (!conversationId || !$('sessionDeleteConfirmation').checked) return;
  await api(`/api/psyx/sessions/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation: 'PERMANENTLY DELETE' })
  });
  sessionDataDialog.close();
  state.managedSessionId = null;
  if (conversationId === state.conversationId) startNewSession(false);
  await loadSessions();
});

sessionDataDialog.addEventListener('close', () => {
  state.managedSessionId = null;
});

$('sessionsToggle').addEventListener('click', () => openDrawer('sessions'));
$('insightsToggle').addEventListener('click', () => openDrawer('insights'));
document.querySelectorAll('[data-close-drawer]').forEach((button) => button.addEventListener('click', closeDrawers));
drawerBackdrop.addEventListener('click', closeDrawers);
window.addEventListener('resize', () => {
  if (!drawerMode()) closeDrawers({ restoreFocus: false });
  else syncDrawerAccessibility();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawers(); });

$('unlockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('unlockStatus').textContent = 'Déverrouillage…';
  $('unlockButton').disabled = true;
  try {
    await api('/api/psyx/auth/unlock', { method: 'POST', body: JSON.stringify({ code: $('unlockCode').value }) });
    $('unlockCode').value = '';
    hideGate();
    await bootstrap();
  } catch (error) {
    $('unlockStatus').textContent = error.message;
  } finally {
    $('unlockButton').disabled = false;
  }
});

$('lockPsyx').addEventListener('click', lockPsyxNow);
$('lockPsyxSettings').addEventListener('click', lockPsyxNow);

async function start() {
  wireVoiceControls();
  wireStatePanel();
  wireFormulation();
  wireSetup();
  wireReview();
  wireCare();
  wireSessionExperience();
  wireFrontier();
  wireProfile();
  wireDream();
  wireToolbox();
  wireFollowUp();
  wireSegmented('modeControl', 'mode');
  wireSegmented('depthControl', 'depth');
  resizeInput();
  updateContextStatus();
  syncDrawerAccessibility();
  renderVoiceStatus();
  setBusy(false);
  try {
    const auth = await api('/api/psyx/auth/status');
    state.accessMode = auth.accessMode || 'token';
    const trustedNetwork = state.accessMode === 'trusted-network';
    $('lockPsyx').hidden = trustedNetwork;
    $('lockPsyxSettings').hidden = trustedNetwork;
    $('privacySummary').textContent = trustedNetwork
      ? 'PsyX est ouvert aux appareils de ce réseau de confiance. Protège la base de données, les sauvegardes et la frontière du réseau.'
      : 'Ce navigateur reste déverrouillé jusqu’à 8 heures. Le code d’accès n’est jamais stocké dans le navigateur.';
    if (!auth.configured && !auth.loopback) {
      showGate('PsyX reste fermé par sécurité : configure PSYX_ACCESS_TOKEN sur l’hôte.');
      return;
    }
    if (!auth.unlocked) {
      showGate('Entre le code d’accès PsyX.');
      return;
    }
    hideGate();
    await bootstrap();
  } catch (error) {
    showGate(error.message);
  }
}

start();

window.addEventListener('pagehide', () => state.voice.speech?.cancel());
