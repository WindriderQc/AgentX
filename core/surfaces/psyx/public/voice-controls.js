'use strict';

// PsyX voice: browser-local preferences, push-to-talk recording, local
// transcription and spoken replies. Loaded before app.js, whose shared
// state and helpers these functions use at call time.

function saveVoicePreferences() {
  try { state.voice.prefs = voicePreferences.writePreferences(localStorage, state.voice.prefs); }
  catch { state.voice.prefs = voicePreferences.normalizePreferences(state.voice.prefs); }
}

function syncVoicePreferenceControls() {
  $('voiceSpokenReplies').checked = state.voice.prefs.spokenReplies;
  $('voiceLanguage').value = state.voice.prefs.language;
}

function updateVoicePreference(field, value) {
  stopVoiceSession();
  state.voice.speech?.cancel();
  state.voice.prefs = { ...state.voice.prefs, ...(field === 'ttsProvider' || field === 'language' ? { ttsVoice: '' } : {}), [field]: value };
  saveVoicePreferences();
  const rejected = field === 'ttsVoice' && String(value || '').trim() && !state.voice.prefs.ttsVoice;
  syncVoicePreferenceControls();
  $('voiceActionStatus').textContent = rejected
    ? 'Choose an installed voice or a valid Kokoro blend.'
    : 'Saved in this browser. The shared VoiX settings did not change.';
}

function voiceSecureContextAvailable() {
  return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

function updateVoiceButton() {
  const recording = state.voice.recorder?.state === 'recording';
  const available = state.voice.enabled && state.voice.reachable && voiceSecureContextAvailable();
  voiceRecord.disabled = !recording && (!available || !state.ready || state.busy || state.voice.recordingPending);
  voiceRecord.textContent = recording ? 'Stop' : 'Mic';
  voiceRecord.classList.toggle('recording', recording);
  voiceRecord.setAttribute('aria-label', recording ? 'Stop recording' : 'Record a voice message');
  voiceRecord.title = available
    ? (recording ? 'Stop and transcribe this recording' : 'Record a private, local voice message')
    : 'Recording needs the trusted PsyX HTTPS address and a reachable VoiX service';
}

function renderVoiceStatus(status = null, error = null) {
  $('voiceStatusText').textContent = !state.voice.enabled ? 'Voice is not enabled on this installation'
    : status?.reachable ? 'Local voice ready' : error?.message || 'Local voice unavailable';
  syncVoicePreferenceControls(); updateVoiceButton();
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
    chooseInitialVoice(catalog);
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


async function transcribeRecording(blob) {
  const captureSequence = state.voice.captureSequence;
  if (!state.ready) return;
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
  assertCurrentCapture(captureSequence);

  if (!response.ok || payload.ok === false) throw new Error(payload.message || `Transcription failed (${response.status})`);
  const transcript = String(payload.data?.text || payload.text || '').trim();
  if (!transcript) throw new Error('No speech detected.');
  input.value = input.value.trim() ? `${input.value.trim()} ${transcript}` : transcript;
  resizeInput();
  $('voiceActionStatus').textContent = 'Transcribed locally. No audio was kept.';
  // Only a reply that will be spoken is asked for in spoken form; dictation read on screen stays a normal reply.
  if (state.voice.prefs.autoSend) await sendMessage(input.value, state.voice.prefs.spokenReplies && state.voice.reachable ? { source: 'voice' } : {});
  else input.focus();
}

async function stopVoiceRecording() {
  const captureSequence = state.voice.captureSequence;
  const recorder = state.voice.recorder;
  if (!recorder || recorder.state !== 'recording') return;
  clearTimeout(state.voice.stopTimer);
  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
  assertCurrentCapture(captureSequence);
  state.voice.mediaStream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(state.voice.chunks, { type: recorder.mimeType || 'audio/webm' });
  state.voice.recorder = null;
  state.voice.mediaStream = null;
  state.voice.chunks = [];
  updateVoiceButton();
  await transcribeRecording(blob);
}

async function startVoiceRecording() {
  if ($('voiceSessionDialog').open) return;
  const captureSequence = state.voice.captureSequence;
  if (!state.ready) return;
  if (!voiceSecureContextAvailable()) throw new Error('Use the trusted PsyX HTTPS address to record.');
  state.voice.speech?.cancel();
  const deviceId = state.voice.prefs.inputDeviceId;
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true
  });
  if (captureSequence !== state.voice.captureSequence) {
    mediaStream.getTracks().forEach(track => track.stop());
    assertCurrentCapture(captureSequence);
  }
  const preferredType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = preferredType ? new MediaRecorder(mediaStream, { mimeType: preferredType }) : new MediaRecorder(mediaStream);
  state.voice.mediaStream = mediaStream;
  state.voice.recorder = recorder;
  state.voice.chunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (captureSequence === state.voice.captureSequence && event.data.size) state.voice.chunks.push(event.data);
  });
  recorder.start(250);
  state.voice.stopTimer = setTimeout(() => void stopVoiceRecording().catch(showVoiceError), 120000);
  $('voiceActionStatus').textContent = 'Recording… press Stop when you are done.';
  updateVoiceButton();
}

function showVoiceError(error) {
  $('voiceActionStatus').textContent = error?.message || 'Voice failed.';
  updateVoiceButton();
}

async function toggleVoiceRecording() {
  if (state.voice.recordingPending) return;
  state.voice.recordingPending = true;
  updateVoiceButton();
  try {
    if (state.voice.recorder?.state === 'recording') await stopVoiceRecording();
    else await startVoiceRecording();
  } catch (error) {
    state.voice.mediaStream?.getTracks().forEach((track) => track.stop());
    state.voice.recorder = null;
    state.voice.mediaStream = null;
    showVoiceError(error);
  } finally {
    state.voice.recordingPending = false;
    updateVoiceButton();
  }
}

async function speakText(text, { readAloud = true, preserveSafety = false } = {}) {
  if (!state.ready || !state.voice.enabled || !state.voice.reachable || !String(text || '').trim()) return;
  try {
    if (!window.VoixAudio) throw new Error('The local voice player is unavailable.');
    state.voice.speech ||= new window.VoixAudio.Speech({
      retryUnplayed: true,
      playBrowser: window.AgentXVoice.speakWithBrowser,
      onReceipt: receipt => { $('voiceActionStatus').textContent = `Voice: ${receipt.provider} · ${receipt.voice} · ${receipt.language}`; },
      onMetrics: metrics => { $('voiceActionStatus').title = JSON.stringify(metrics); },
    });
    const language = state.voice.prefs.language;
    const presented = window.AgentXSpokenPresentation.ordinarySpeech(text, { language, readAloud, preserveSafety });
    const segments = window.NestorSpeech.splitSpeechText(spokenVoiceText(presented, { readAloud }));
    await state.voice.speech.speak((signal, segment, after) => synthesizePsyXSpeech({ text: segment, language, after }, signal), { segments });
  } catch (error) { if (error.name !== 'AbortError') showVoiceError(error); }
}

function syncSavedVoicePreferences() {
  try { state.voice.prefs = voicePreferences.readPreferences(localStorage); } catch {}
  psyxVoiceSession?.setLanguage(state.voice.prefs.language); syncVoicePreferenceControls();
}
function wireVoiceControls() {
  window.addEventListener('storage', event => { if (event.key === voicePreferences.STORAGE_KEY) syncSavedVoicePreferences(); });
  window.addEventListener('pageshow', event => { if (event.persisted) syncSavedVoicePreferences(); });
  $('voiceSettings').addEventListener('click', async () => {
    psyxVoiceSession ||= createPsyXVoiceSession();
    await window.AgentXVoiceWorkshop.open({ scope: 'psyx', conversation: psyxVoiceSession,
      selection: () => ({ language: state.voice.prefs.language, wakeWord: false, interruption: false }),
      onSaved: () => { stopVoiceSession(); syncSavedVoicePreferences(); } });
  });
  $('voiceSpokenReplies').addEventListener('change', () => {
    state.voice.prefs.spokenReplies = $('voiceSpokenReplies').checked; saveVoicePreferences();
  });
  $('voiceLanguage').addEventListener('change', () => updateVoicePreference('language', $('voiceLanguage').value));
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelVoiceCapture(); });
  window.addEventListener('pagehide', cancelVoiceCapture);
  wireVoiceSession(); voiceRecord.addEventListener('click', toggleVoiceRecording);
}

// Capture cancellation is a microphone lifecycle guard, independent of human access.
function assertCurrentCapture(sequence) {
  if (sequence !== state.voice.captureSequence) {
    throw Object.assign(new Error('Voice capture was cancelled.'), { name: 'AbortError' });
  }
}

function cancelVoiceCapture() {
  state.voice.captureSequence += 1;
  clearTimeout(state.voice.stopTimer);
  state.voice.mediaStream?.getTracks().forEach(track => track.stop());
  if (state.voice.recorder?.state === 'recording') state.voice.recorder.stop();
  state.voice.recorder = null;
  state.voice.mediaStream = null;
  state.voice.chunks = [];
  updateVoiceButton();
}
