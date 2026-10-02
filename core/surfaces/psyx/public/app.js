'use strict';

const STORAGE_KEY = 'psyx.activeConversationId';
// Shared with the Node test suite (public/voice-preferences.js): browser-local voice
// preferences that travel with each request and never change VoiX service defaults.
const voicePreferences = window.PsyXVoicePreferences;
const MAX_CONTEXT_MESSAGES = 40;
const ACTION_PREFIX = '[PSYX_ACTION:';

const state = {
  mode: 'talk',
  depth: 'normal',
  nextMode: null,
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
const brainMode = $('brainMode');
const brainRoute = $('brainRoute');
const brainModel = $('brainModel');
const brainHost = $('brainHost');
const brainThinking = $('brainThinking');
const stateSaveStatus = $('stateSaveStatus');
const privacyGate = $('privacyGate');
const appShell = $('appShell');
const drawerBackdrop = $('drawerBackdrop');
const cancelGeneration = $('cancelGeneration');
const brainContext = $('brainContext');
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
  state.unlocked = false;
  state.ready = false;
  state.history = [];
  state.sessions = [];
  state.psyxState = null;
  messages.replaceChildren();
  for (const form of document.querySelectorAll('form')) form.reset();
  input.value = '';
  sessionLabel.textContent = 'PsyX locked';
  $('sessionDataTitle').textContent = 'PsyX conversation';
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
}

function setReady(ready, label) {
  state.ready = ready;
  statusDot.classList.toggle('online', ready);
  statusDot.classList.toggle('offline', !ready);
  statusText.textContent = label;
  setBusy(false);
}

function currentModeInfo(mode = state.mode) {
  return state.modeConfig[mode] || { title: mode, short: '', description: '' };
}

function currentDepthInfo(depth = state.depth) {
  return state.depthConfig[depth] || {
    title: depth,
    short: '',
    description: '',
    taskType: depth === 'deep' ? 'deep_reasoning' : 'analysis',
    think: depth === 'deep'
  };
}

function updateControlExplanation() {
  const mode = currentModeInfo();
  const depth = currentDepthInfo();
  modeSummary.textContent = `${mode.title || state.mode} · ${mode.short || ''}`;
  depthSummary.textContent = `${depth.title || state.depth} · ${depth.short || ''}`;
  const armed = state.nextMode ? `<br><strong>Next turn:</strong> ${escapeHtml(currentModeInfo(state.nextMode).title)} (one-shot)` : '';
  controlExplainer.innerHTML = `<strong>${escapeHtml(mode.title || state.mode)}</strong>: ${escapeHtml(mode.description || '')}<br><strong>${escapeHtml(depth.title || state.depth)}</strong>: ${escapeHtml(depth.description || '')}${armed}`;
  brainMode.textContent = `${depth.title || state.depth} · ${state.depth === 'deep' ? 'deliberate' : 'strong local'}`;
  brainThinking.textContent = depth.think ? 'thinking requested' : 'thinking off';
  updateBrainRouting();
  const planArmed = state.nextMode === 'plan';
  $('planAction').classList.toggle('armed', planArmed);
  $('planAction').setAttribute('aria-pressed', String(planArmed));
}

function updateContextStatus() {
  const recentCount = state.history.filter((item) => item.role !== 'action').length;
  brainContext.textContent = `${recentCount}/${MAX_CONTEXT_MESSAGES} recent`;
  $('contextStatus').textContent = `${recentCount} recent message${recentCount === 1 ? '' : 's'} shown (maximum ${MAX_CONTEXT_MESSAGES}). The trusted context is rebuilt from PsyX-owned storage.`;
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
    content: type === 'deep_reflection' ? 'Deep reflection requested' : `PsyX action · ${type}`
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
      sessionLabel.textContent = conversation.title || `Session ${String(conversationId).slice(-8)}`;
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
    showGate('PsyX was locked or the private session expired.');
  }
  if (!response.ok || payload.status === 'error' || payload.ok === false) {
    const error = new Error(payload.message || `Request failed (${response.status})`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload.data ?? payload;
}

function assertCurrentAccess(epoch) {
  if (epoch !== state.accessEpoch) {
    throw Object.assign(new Error('PsyX was locked while this request was in progress.'), { name: 'AbortError', code: 'PSYX_LOCKED' });
  }
}

function saveVoicePreferences() {
  try { state.voice.prefs = voicePreferences.writePreferences(localStorage, state.voice.prefs); }
  catch { state.voice.prefs = voicePreferences.normalizePreferences(state.voice.prefs); }
}

function syncVoicePreferenceControls() {
  const prefs = state.voice.prefs;
  $('voiceSpokenReplies').checked = prefs.spokenReplies;
  $('voiceAutoSend').checked = prefs.autoSend;
  $('voiceLanguage').value = prefs.language;
  $('voiceTtsProvider').value = prefs.ttsProvider;
  const choices = window.VoixAudio?.choices(state.voice.catalog, prefs.language, prefs.ttsProvider) || [];
  const select = $('voiceTtsVoice'); select.replaceChildren(new Option('Language default', ''));
  for (const voice of choices) {
    const option = new Option(`${voice.name} · ${voice.locale}${voice.available ? '' : ' · unavailable'}`, voice.id);
    option.disabled = !voice.available; option.title = voice.reason || ''; select.add(option);
  }
  if (prefs.ttsVoice && !choices.some(v => v.id === prefs.ttsVoice)) select.add(new Option(`Saved / custom: ${prefs.ttsVoice}`, prefs.ttsVoice));
  select.value = prefs.ttsVoice; select.disabled = !state.voice.reachable;
  $('voiceTtsCustom').value = prefs.ttsVoice; $('voiceTtsCustom').disabled = !state.voice.reachable;
  for (const option of $('voiceTtsProvider').options) {
    const provider = state.voice.catalog?.providers?.find(p => p.id === option.value);
    option.disabled = provider ? !provider.available : false;
    option.title = provider?.reason || '';
  }
  $('voicePreferenceSummary').textContent = `This browser speaks with ${voicePreferences.describePreferences(prefs, state.voice.status)}. Applied per request; shared VoiX settings stay unchanged.`;
}

function updateVoicePreference(field, value) {
  state.voice.speech?.cancel();
  state.voice.prefs = { ...state.voice.prefs, ...(field === 'ttsProvider' || field === 'language' ? { ttsVoice: '' } : {}), [field]: value };
  saveVoicePreferences();
  const rejected = field === 'ttsVoice' && String(value || '').trim() && !state.voice.prefs.ttsVoice;
  syncVoicePreferenceControls();
  $('voiceActionStatus').textContent = rejected
    ? 'Select an installed voice or enter a valid Kokoro blend.'
    : 'Saved in this browser. Shared VoiX settings were not changed.';
}

function voiceSecureContextAvailable() {
  return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

function updateVoiceButton() {
  const recording = state.voice.recorder?.state === 'recording';
  const available = state.voice.enabled && state.voice.reachable && voiceSecureContextAvailable();
  voiceRecord.disabled = !recording && (!available || !state.ready || state.busy);
  voiceRecord.textContent = recording ? 'Stop' : 'Mic';
  voiceRecord.classList.toggle('recording', recording);
  voiceRecord.setAttribute('aria-label', recording ? 'Stop voice recording' : 'Record a voice message');
  voiceRecord.title = available
    ? (recording ? 'Stop and transcribe this recording' : 'Record a private local voice message')
    : 'Voice recording needs the trusted HTTPS PsyX address and a reachable VoiX service';
}

function renderVoiceStatus(status = null, error = null) {
  const secure = voiceSecureContextAvailable();
  $('voiceSecureNotice').textContent = secure ? '' : 'Microphone access is blocked on this address. Open PsyX through its trusted HTTPS network address.';
  $('voiceStatusDot').classList.toggle('online', Boolean(status?.reachable));
  $('voiceStatusDot').classList.toggle('offline', !status?.reachable);
  $('voiceStatusText').textContent = !state.voice.enabled
    ? 'Voice is not enabled on this deployment'
    : status?.reachable ? 'Local VoiX is ready' : 'Local VoiX is unavailable';
  $('voiceStatusDetail').textContent = status?.reachable
    ? `${status.config?.whisperModel || 'Whisper'} speech recognition · service default ${status.config?.ttsProvider || 'local'} speech · VoiX ${status.serviceVersion || ''}`
    : (error?.message || 'Audio stays disabled until the private voice service is reachable.');
  for (const id of ['voiceLanguage', 'voiceTtsProvider', 'voiceInputDevice', 'voiceFindDevices', 'voiceTest']) {
    $(id).disabled = !status?.reachable;
  }
  syncVoicePreferenceControls();
  updateVoiceButton();
}

async function loadVoiceStatus() {
  if (!state.voice.enabled) {
    state.voice.reachable = false;
    renderVoiceStatus();
    return;
  }
  $('voiceStatusText').textContent = 'Checking local VoiX…';
  try {
    const [status, catalog] = await Promise.all([api('/api/psyx/voice/status', { cache: 'no-store' }), api('/api/psyx/voice/catalog', { cache: 'no-store' }).catch(() => null)]);
    state.voice.catalog = catalog;
    state.voice.reachable = Boolean(status.reachable);
    // Service defaults are shown for context only; this browser's preferences stay its own.
    state.voice.status = status;
    renderVoiceStatus(status);
  } catch (error) {
    state.voice.reachable = false;
    state.voice.status = null;
    renderVoiceStatus(null, error);
  }
}

async function refreshMicrophones({ requestPermission = false } = {}) {
  if (!voiceSecureContextAvailable()) throw new Error('Use the trusted HTTPS PsyX address to allow microphone access.');
  if (requestPermission) {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  const selected = state.voice.prefs.inputDeviceId;
  $('voiceInputDevice').innerHTML = '<option value="">System default</option>' + devices.map((device, index) =>
    `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Microphone ${index + 1}`)}</option>`
  ).join('');
  $('voiceInputDevice').value = devices.some((device) => device.deviceId === selected) ? selected : '';
}

async function transcribeRecording(blob) {
  const accessEpoch = state.accessEpoch;
  if (!state.unlocked) return;
  $('voiceActionStatus').textContent = 'Transcribing locally…';
  const response = await fetch('/api/psyx/voice/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': blob.type || 'audio/webm',
      'X-PsyX-Language': state.voice.prefs.language || 'fr'
    },
    body: blob
  });
  const payload = await response.json().catch(() => ({}));
  assertCurrentAccess(accessEpoch);
  if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('PsyX was locked or the private session expired.');
  if (!response.ok || payload.ok === false) throw new Error(payload.message || `Transcription failed (${response.status})`);
  const transcript = String(payload.data?.text || payload.text || '').trim();
  if (!transcript) throw new Error('No speech was detected.');
  input.value = input.value.trim() ? `${input.value.trim()} ${transcript}` : transcript;
  resizeInput();
  $('voiceActionStatus').textContent = 'Transcribed locally. No audio was stored.';
  if (state.voice.prefs.autoSend) await sendMessage(input.value);
  else input.focus();
}

async function stopVoiceRecording() {
  const accessEpoch = state.accessEpoch;
  const recorder = state.voice.recorder;
  if (!recorder || recorder.state !== 'recording') return;
  clearTimeout(state.voice.stopTimer);
  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
  assertCurrentAccess(accessEpoch);
  state.voice.mediaStream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(state.voice.chunks, { type: recorder.mimeType || 'audio/webm' });
  state.voice.recorder = null;
  state.voice.mediaStream = null;
  state.voice.chunks = [];
  updateVoiceButton();
  await transcribeRecording(blob);
}

async function startVoiceRecording() {
  const accessEpoch = state.accessEpoch;
  if (!state.unlocked) return;
  if (!voiceSecureContextAvailable()) throw new Error('Use the trusted HTTPS PsyX address to record voice.');
  state.voice.speech?.cancel();
  const deviceId = state.voice.prefs.inputDeviceId;
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true
  });
  if (accessEpoch !== state.accessEpoch) {
    mediaStream.getTracks().forEach(track => track.stop());
    assertCurrentAccess(accessEpoch);
  }
  const preferredType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = preferredType ? new MediaRecorder(mediaStream, { mimeType: preferredType }) : new MediaRecorder(mediaStream);
  state.voice.mediaStream = mediaStream;
  state.voice.recorder = recorder;
  state.voice.chunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (accessEpoch === state.accessEpoch && event.data.size) state.voice.chunks.push(event.data);
  });
  recorder.start(250);
  state.voice.stopTimer = setTimeout(() => void stopVoiceRecording().catch(showVoiceError), 120000);
  $('voiceActionStatus').textContent = 'Recording… select Stop when you are done.';
  updateVoiceButton();
}

function showVoiceError(error) {
  $('voiceActionStatus').textContent = error?.message || 'Voice failed.';
  updateVoiceButton();
}

async function toggleVoiceRecording() {
  try {
    if (state.voice.recorder?.state === 'recording') await stopVoiceRecording();
    else await startVoiceRecording();
  } catch (error) {
    state.voice.mediaStream?.getTracks().forEach((track) => track.stop());
    state.voice.recorder = null;
    state.voice.mediaStream = null;
    showVoiceError(error);
  }
}

async function speakText(text) {
  if (!state.unlocked || !state.voice.enabled || !state.voice.reachable || !String(text || '').trim()) return;
  try {
    if (!window.VoixAudio) throw new Error('The local speech player is unavailable.');
    state.voice.speech ||= new window.VoixAudio.Speech({
      onReceipt: receipt => { $('voiceActionStatus').textContent = `Voice: ${receipt.provider} · ${receipt.voice} · ${receipt.language}`; },
      onMetrics: metrics => { $('voiceActionStatus').title = JSON.stringify(metrics); },
    });
    const request = voicePreferences.synthesisRequest(text, state.voice.prefs);
    await state.voice.speech.speak(async signal => {
      const response = await fetch('/api/psyx/voice/synthesize/stream', {
        method: 'POST', signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('PsyX was locked or the private session expired.');
        throw new Error(payload.message || `Speech failed (${response.status})`);
      }
      return response;
    });
  } catch (error) { if (error.name !== 'AbortError') showVoiceError(error); }
}

async function restoreConversation(conversationId = state.conversationId) {
  if (!conversationId) return;
  try {
    const conversation = await api(`/api/psyx/sessions/${encodeURIComponent(conversationId)}`);
    if (conversation.promptName && conversation.promptName !== 'psyx') throw new Error('Saved conversation is not a PsyX session');
    if (conversation.lifecycle?.status === 'archived') {
      startNewSession(false);
      return;
    }
    state.conversationId = String(conversationId);
    localStorage.setItem(STORAGE_KEY, state.conversationId);
    state.history = normalizeConversationMessages(conversation.messages);
    clearRenderedConversation();
    for (const item of state.history) addMessage(item.role, item.content);
    updateContextStatus();
    sessionLabel.textContent = conversation.title || `Session ${state.conversationId.slice(-8)}`;
    highlightActiveSession();
  } catch (error) {
    if (error.code !== 'PSYX_LOCKED') console.warn('PsyX session restore skipped', error);
    if (state.unlocked) startNewSession(false);
  }
}

async function loadPsyXState() {
  state.psyxState = await api('/api/psyx/state');
  renderPsyXState();
}

async function addStateItem(key, text, extra = {}) {
  stateSaveStatus.textContent = 'saving…';
  try {
    const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify({ text, ...extra })
    });
    state.psyxState = result.state;
    renderPsyXState();
    stateSaveStatus.textContent = `synced · r${state.psyxState.revision ?? 0}`;
  } catch (error) {
    stateSaveStatus.textContent = 'save failed';
    throw error;
  }
}

async function removeStateItem(key, id) {
  stateSaveStatus.textContent = 'saving…';
  const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.psyxState = result.state;
  renderPsyXState();
  stateSaveStatus.textContent = `synced · r${state.psyxState.revision ?? 0}`;
}

async function loadRouting() {
  try {
    state.routing = await api('/api/psyx/routing');
    renderRoutingDetails();
    updateBrainRouting();
  } catch (error) {
    console.warn('Routing config unavailable', error);
    $('routingDetails').textContent = 'Inference routing details are unavailable.';
  }
}

function getLaneConfig(depth = state.depth) {
  const taskType = depth === 'deep' ? 'deep_reasoning' : 'analysis';
  const entry = state.routing?.taskConfigState?.[taskType]?.effective || state.routing?.taskModels?.[taskType] || null;
  return { taskType, entry };
}

function updateBrainRouting(lastResult = null) {
  const { taskType, entry } = getLaneConfig();
  const routing = lastResult?.routing || {};
  const model = routing.routedModel || lastResult?.model || entry?.model || 'model unresolved';
  const host = routing.routedHost || entry?.host || 'host unresolved';
  brainRoute.textContent = `${model} @ ${host}`;
  brainModel.textContent = model;
  brainHost.textContent = String(host).toUpperCase();
  routeLabel.textContent = `${currentDepthInfo().title || state.depth} · ${model}${host ? ` @ ${host}` : ''}`;
  brainRoute.dataset.taskType = taskType;
}

function renderRoutingDetails() {
  const normal = getLaneConfig('normal');
  const deep = getLaneConfig('deep');
  $('routingDetails').innerHTML = `
    <div class="route-row"><span>Normal</span><strong>${escapeHtml(normal.entry?.model || '—')}</strong><em>${escapeHtml(normal.entry?.host || '—')}</em><small>technical lane: analysis</small></div>
    <div class="route-row"><span>Deep</span><strong>${escapeHtml(deep.entry?.model || '—')}</strong><em>${escapeHtml(deep.entry?.host || '—')}</em><small>technical lane: deep_reasoning</small></div>
    <p class="state-help">Mode controls the psychological stance. These technical lanes only choose the inference substrate.</p>
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
  } catch (error) { if (error.code !== 'PSYX_LOCKED') throw error; }
}

function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.round(diff / 60000);
  if (minutes < 2) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString();
}

function renderSessions() {
  const list = $('sessionsList');
  if (!state.sessions.length) {
    list.innerHTML = `<div class="panel-empty">No ${escapeHtml(state.sessionStatus)} PsyX sessions.</div>`;
    return;
  }
  list.innerHTML = state.sessions.map((item) => `
    <article class="session-card ${String(item.id) === state.conversationId ? 'active' : ''}" data-session-id="${escapeHtml(item.id)}">
      <button class="session-open" type="button" ${state.sessionStatus === 'archived' ? `data-session-options="${escapeHtml(item.id)}"` : `data-session-open="${escapeHtml(item.id)}"`}>
        <strong>${escapeHtml(item.title || 'PsyX conversation')}</strong>
        <span>${escapeHtml(item.preview || 'No preview')}</span>
        <small>${state.sessionStatus === 'archived' ? 'Archived · ' : ''}${escapeHtml(relativeDate(item.updatedAt))}${item.model ? ` · ${escapeHtml(item.model)}` : ''}${item.promptVersion ? ` · prompt v${escapeHtml(item.promptVersion)}` : ''}</small>
      </button>
      <div class="session-actions">
        <button type="button" data-session-rename="${escapeHtml(item.id)}" aria-label="Rename session">✎</button>
        <button type="button" data-session-options="${escapeHtml(item.id)}" aria-label="Session options">•••</button>
      </div>
    </article>
  `).join('');
}

function highlightActiveSession() {
  for (const node of document.querySelectorAll('.session-card')) node.classList.toggle('active', node.dataset.sessionId === state.conversationId);
}

function stateItemMeta(item) {
  const bits = [];
  if (item.source) bits.push(item.source);
  if (Number.isFinite(item.confidence)) bits.push(`${Math.round(item.confidence * 100)}%`);
  if (item.status && item.status !== 'active') bits.push(item.status);
  return bits.join(' · ');
}

function renderStateItems(containerId, key) {
  const container = $(containerId);
  const values = state.psyxState?.[key] || [];
  if (!values.length) {
    container.innerHTML = '<div class="state-empty">Nothing captured yet.</div>';
    return;
  }
  container.innerHTML = values.map((item) => `
    <div class="state-item">
      <div><span>${escapeHtml(item.text)}</span>${stateItemMeta(item) ? `<small>${escapeHtml(stateItemMeta(item))}</small>` : ''}</div>
      <button type="button" data-state-remove="${escapeHtml(key)}" data-id="${escapeHtml(item.id)}" aria-label="Remove">×</button>
    </div>
  `).join('');
}

function renderExperiments() {
  const container = $('experimentsList');
  const experiments = state.psyxState?.experiments || [];
  if (!experiments.length) {
    container.innerHTML = '<div class="state-empty">No experiments yet. Create one when an insight is worth testing in real life.</div>';
    return;
  }
  container.innerHTML = experiments.slice().reverse().map((item) => `
    <article class="experiment-card">
      <div class="experiment-top">
        <span class="experiment-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
        <select data-experiment-status="${escapeHtml(item.id)}" aria-label="Experiment status">
          ${['planned', 'active', 'completed', 'abandoned'].map((status) => `<option value="${status}" ${status === item.status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
      </div>
      <strong>${escapeHtml(item.hypothesis || 'Experiment')}</strong>
      <p><b>Action:</b> ${escapeHtml(item.action || '—')}</p>
      ${item.expectedSignal ? `<p><b>Signal:</b> ${escapeHtml(item.expectedSignal)}</p>` : ''}
      <textarea data-experiment-result="${escapeHtml(item.id)}" rows="2" placeholder="What happened?">${escapeHtml(item.result || '')}</textarea>
      <button type="button" class="experiment-save" data-experiment-save="${escapeHtml(item.id)}">Save result</button>
    </article>
  `).join('');
}

function renderPsyXState() {
  renderStateItems('threadsList', 'activeThreads');
  renderStateItems('notesList', 'notes');
  renderStateItems('loopsList', 'openLoops');
  renderStateItems('patternsList', 'patterns');
  renderStateItems('hypothesesList', 'hypotheses');
  renderExperiments();
  stateSaveStatus.textContent = `synced · r${state.psyxState?.revision ?? 0}`;
}

async function bootstrap() {
  const accessEpoch = state.accessEpoch;
  setReady(false, 'Starting PsyX…');
  try {
    const payload = await api('/api/psyx/bootstrap', { method: 'POST', body: '{}' });
    if (payload?.persona?.active !== true) throw new Error('PsyX persona is not active');
    state.modeConfig = payload.modes || {};
    state.depthConfig = payload.depths || {};
    state.voice.enabled = payload.voice?.enabled === true;
    const lifecycle = payload.conversationLifecycle || {};
    $('lifecycleStatus').textContent = lifecycle.archive
      ? 'PsyX-owned conversation archive and restore are available.'
      : 'Conversation lifecycle storage is unavailable.';
    updateControlExplanation();
    await Promise.all([loadPsyXState(), loadRouting(), loadSessions(), loadVoiceStatus()]);
    await restoreConversation();
    assertCurrentAccess(accessEpoch);
    setReady(true, 'PsyX ready');
    input.focus();
  } catch (error) {
    if (error.code !== 'PSYX_LOCKED') {
      setReady(false, 'PsyX unavailable');
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
    if (response.status === 401 && body.code === 'PSYX_LOCKED') showGate('PsyX was locked or the private session expired.');
    const error = new Error(body.message || `Chat failed (${response.status})`);
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

  const effectiveMode = overrides.mode || state.nextMode || state.mode;
  const effectiveDepth = overrides.depth || state.depth;
  const depthInfo = currentDepthInfo(effectiveDepth);
  const turnSequence = ++state.turnSequence;
  const previousHistorySignature = historySignature(state.history);

  if (actionType) addMessage('action', actionMessage(actionType).content);
  else addMessage('user', humanText);

  input.value = '';
  resizeInput();
  setBusy(true);
  state.thinkingObserved = false;
  brainThinking.textContent = depthInfo.think ? 'thinking requested' : 'thinking off';
  const stream = createStreamingAssistant();
  state.activeAbort = new AbortController();

  let finalResult = null;
  let streamError = null;

  try {
    await streamChat({
      message: humanText,
      conversationId: state.conversationId || undefined,
      psyx: { mode: effectiveMode, depth: effectiveDepth, action: actionType }
    }, (event, data) => {
      if (!state.unlocked || state.turnSequence !== turnSequence) return;
      if (event === 'token') stream.append(data.content || '');
      else if (event === 'thinking') {
        state.thinkingObserved = true;
        brainThinking.textContent = 'thinking observed';
      } else if (event === 'done') {
        finalResult = data;
      } else if (event === 'error') {
        streamError = new Error(data.message || 'Streaming error');
      }
    }, state.activeAbort.signal);

    if (!state.unlocked || state.turnSequence !== turnSequence) return;

    if (streamError) throw streamError;
    if (!finalResult) {
      const interrupted = new Error('The connection ended before PsyX confirmed completion.');
      interrupted.code = 'PSYX_STREAM_INCOMPLETE';
      throw interrupted;
    }
    const assistantContent = stream.text().trim() || String(finalResult?.response || finalResult?.message?.content || '').trim();
    if (!assistantContent) throw new Error('The inference provider returned an empty response');
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
      sessionLabel.textContent = `Session ${state.conversationId.slice(-8)}`;
    }
    updateBrainRouting(finalResult);
    if (effectiveDepth === 'deep' && !state.thinkingObserved) brainThinking.textContent = 'thinking requested · not observed';
    await loadSessions();
    if (state.voice.prefs.spokenReplies) void speakText(assistantContent);
  } catch (error) {
    if (!state.unlocked || state.turnSequence !== turnSequence) return;
    if (error.name === 'AbortError') {
      stream.set('Cancelled.');
      brainThinking.textContent = 'cancelled';
    } else {
      stream.article.classList.add('error');
      const partial = stream.text().trim();
      stream.set(partial
        ? `${partial}\n\n[Response interrupted. PsyX did not confirm completion to this browser; reload session history before retrying.]`
        : `I couldn't complete that turn. ${error.message}`);
      await loadSessions().catch(() => {});
    }
    if (error.code !== 'PSYX_LOCKED' && state.conversationId) {
      void reconcileCompletedTurn(
        state.conversationId,
        humanText,
        actionType,
        previousHistorySignature,
        turnSequence
      ).then((reconciled) => {
        if (reconciled && state.turnSequence === turnSequence && !state.busy) {
          brainThinking.textContent = effectiveDepth === 'deep'
            ? (state.thinkingObserved ? 'thinking observed' : 'thinking requested · not observed')
            : 'thinking off';
        }
      });
    }
  } finally {
    if (state.turnSequence === turnSequence) {
      state.activeAbort = null;
      state.nextMode = null;
      updateControlExplanation();
      setBusy(false);
      if (state.unlocked) input.focus();
    }
  }
}

function startNewSession(focus = true) {
  state.conversationId = null;
  state.history = [];
  localStorage.removeItem(STORAGE_KEY);
  sessionLabel.textContent = 'New conversation';
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
    if (stateKey === 'mode') state.nextMode = null;
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
  $('sessionDataTitle').textContent = session.title || 'PsyX conversation';
  const archived = session.lifecycle?.status === 'archived';
  $('sessionLifecycleCopy').textContent = archived
    ? 'Restore returns this conversation to active sessions. Permanent deletion cannot be undone.'
    : 'Archive removes this conversation from active sessions without deleting it. It can be restored later.';
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
$('reflectAction').addEventListener('click', () => sendMessage(
  '',
  { mode: 'analyze', depth: 'deep', action: 'deep_reflection' }
));
$('planAction').addEventListener('click', () => {
  state.nextMode = state.nextMode === 'plan' ? null : 'plan';
  updateControlExplanation();
  input.focus();
});

$('captureAction').addEventListener('click', () => {
  $('captureText').value = '';
  $('captureContext').value = '';
  $('captureDialog').showModal();
  setTimeout(() => $('captureText').focus(), 0);
});
$('saveCapture').addEventListener('click', async () => {
  const value = $('captureText').value.trim();
  if (!value) return;
  const context = $('captureContext').value.trim();
  await addStateItem('activeThreads', value, context ? { evidence: [context] } : {});
  $('captureDialog').close();
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
    const nextTitle = window.prompt('Rename PsyX session', session?.title || '');
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

document.querySelectorAll('[data-state-add]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = form.querySelector('input');
    const value = field.value.trim();
    if (!value) return;
    field.value = '';
    await addStateItem(form.dataset.stateAdd, value);
  });
});

$('insightsPanel').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-state-remove]');
  if (remove) {
    await removeStateItem(remove.dataset.stateRemove, remove.dataset.id);
    return;
  }
  const saveExperiment = event.target.closest('[data-experiment-save]');
  if (saveExperiment) {
    const id = saveExperiment.dataset.experimentSave;
    const card = saveExperiment.closest('.experiment-card');
    const result = card.querySelector(`[data-experiment-result="${CSS.escape(id)}"]`)?.value || '';
    const status = card.querySelector(`[data-experiment-status="${CSS.escape(id)}"]`)?.value || 'planned';
    const response = await api(`/api/psyx/state/experiments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ result, status })
    });
    state.psyxState = response.state;
    renderPsyXState();
  }
});

function activateStateTab(tab, { focus = false } = {}) {
  for (const node of document.querySelectorAll('.state-tab')) {
    const active = node === tab;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
    node.tabIndex = active ? 0 : -1;
  }
  for (const view of document.querySelectorAll('.state-view')) {
    const active = view.dataset.view === tab.dataset.tab;
    view.classList.toggle('active', active);
    view.hidden = !active;
  }
  if (focus) tab.focus();
}

document.querySelectorAll('.state-tab').forEach((tab) => {
  tab.addEventListener('click', () => activateStateTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.state-tab')];
    const current = tabs.indexOf(tab);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else next = (current - 1 + tabs.length) % tabs.length;
    activateStateTab(tabs[next], { focus: true });
  });
});

const experimentDialog = $('experimentDialog');
$('newExperiment').addEventListener('click', () => {
  experimentDialog.showModal();
  setTimeout(() => experimentDialog.querySelector('textarea')?.focus(), 0);
});
$('saveExperiment').addEventListener('click', async () => {
  const form = $('experimentForm');
  const data = new FormData(form);
  const hypothesis = String(data.get('hypothesis') || '').trim();
  const action = String(data.get('action') || '').trim();
  if (!hypothesis || !action) return;
  const response = await api('/api/psyx/state/experiments', {
    method: 'POST',
    body: JSON.stringify({ hypothesis, action, expectedSignal: String(data.get('expectedSignal') || '').trim() })
  });
  state.psyxState = response.state;
  renderPsyXState();
  form.reset();
  experimentDialog.close();
});

async function lockPsyxNow() {
  if (state.accessMode === 'trusted-network') return;
  setReady(false, 'PsyX locked');
  showGate('PsyX locked.');
  try { await api('/api/psyx/auth/lock', { method: 'POST', body: '{}' }); } catch { /* lock locally regardless */ }
}

$('settingsPsyx').addEventListener('click', () => {
  $('dataStatus').textContent = '';
  dataDialog.showModal();
});

$('voiceSettings').addEventListener('click', async () => {
  syncVoicePreferenceControls();
  $('voiceActionStatus').textContent = '';
  voiceDialog.showModal();
  await loadVoiceStatus();
  await refreshMicrophones().catch(() => {});
});
$('voiceRefresh').addEventListener('click', loadVoiceStatus);
$('voiceFindDevices').addEventListener('click', async () => {
  $('voiceActionStatus').textContent = 'Requesting browser microphone access…';
  try {
    await refreshMicrophones({ requestPermission: true });
    $('voiceActionStatus').textContent = 'Browser microphones refreshed.';
  } catch (error) { showVoiceError(error); }
});
$('voiceSpokenReplies').addEventListener('change', () => {
  state.voice.prefs.spokenReplies = $('voiceSpokenReplies').checked;
  saveVoicePreferences();
});
$('voiceAutoSend').addEventListener('change', () => {
  state.voice.prefs.autoSend = $('voiceAutoSend').checked;
  saveVoicePreferences();
});
$('voiceInputDevice').addEventListener('change', () => {
  state.voice.prefs.inputDeviceId = $('voiceInputDevice').value;
  saveVoicePreferences();
});
$('voiceLanguage').addEventListener('change', () => updateVoicePreference('language', $('voiceLanguage').value));
$('voiceTtsProvider').addEventListener('change', () => updateVoicePreference('ttsProvider', $('voiceTtsProvider').value));
$('voiceTtsVoice').addEventListener('change', () => updateVoicePreference('ttsVoice', $('voiceTtsVoice').value.trim()));
$('voiceTest').addEventListener('click', () => speakText(voicePreferences.testSentence(state.voice.prefs)));
$('voiceStop').addEventListener('click', () => { state.voice.speech?.cancel(); $('voiceActionStatus').textContent = 'Speech stopped.'; });
$('voiceTtsCustom').addEventListener('change', () => updateVoicePreference('ttsVoice', $('voiceTtsCustom').value.trim()));
voiceRecord.addEventListener('click', toggleVoiceRecording);

$('exportPsyx').addEventListener('click', async () => {
  const accessEpoch = state.accessEpoch;
  $('dataStatus').textContent = 'Preparing export…';
  try {
    const response = await fetch('/api/psyx/export', { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    assertCurrentAccess(accessEpoch);
    if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('PsyX was locked or the private session expired.');
    if (!response.ok) throw new Error(payload.message || `Export failed (${response.status})`);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `psyx-export-${String(payload.exportedAt || new Date().toISOString()).slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    $('dataStatus').textContent = `Export downloaded with ${payload.transcriptData?.conversationCount ?? 0} PsyX-owned conversation transcript(s).`;
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
  $('unlockStatus').textContent = 'Unlocking…';
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
      ? 'PsyX is open to devices that can reach this trusted network. Protect the database, backups, and network boundary.'
      : 'This browser stays unlocked for up to 8 hours. The access code is never stored in browser storage.';
    if (!auth.configured && !auth.loopback) {
      showGate('PsyX privacy is fail-closed: configure PSYX_ACCESS_TOKEN on the host.');
      return;
    }
    if (!auth.unlocked) {
      showGate('Enter the PsyX access code.');
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
