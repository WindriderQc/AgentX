'use strict';

// PsyX voice: preferences, microphone capture, transcription and spoken replies.
// Classic script loaded before app.js; it only declares functions, which read
// app.js's shared constants (state, $, voicePreferences, ...) when called.

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
