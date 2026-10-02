'use strict';

// PsyX voice: browser-local preferences, push-to-talk recording, local
// transcription and spoken replies. Loaded before app.js, whose shared
// state and helpers these functions use at call time.

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
  const select = $('voiceTtsVoice'); select.replaceChildren(new Option('Voix par défaut de la langue', ''));
  for (const voice of choices) {
    const option = new Option(`${voice.name} · ${voice.locale}${voice.available ? '' : ' · indisponible'}`, voice.id);
    option.disabled = !voice.available; option.title = voice.reason || ''; select.add(option);
  }
  if (prefs.ttsVoice && !choices.some(v => v.id === prefs.ttsVoice)) select.add(new Option(`Enregistrée / personnalisée : ${prefs.ttsVoice}`, prefs.ttsVoice));
  select.value = prefs.ttsVoice; select.disabled = !state.voice.reachable;
  $('voiceTtsCustom').value = prefs.ttsVoice; $('voiceTtsCustom').disabled = !state.voice.reachable;
  for (const option of $('voiceTtsProvider').options) {
    const provider = state.voice.catalog?.providers?.find(p => p.id === option.value);
    option.disabled = provider ? !provider.available : false;
    option.title = provider?.reason || '';
  }
  $('voicePreferenceSummary').textContent = `Ce navigateur parle avec ${voicePreferences.describePreferences(prefs, state.voice.status)}. Appliqué à chaque requête; les réglages partagés de VoiX ne changent pas.`;
}

function updateVoicePreference(field, value) {
  state.voice.speech?.cancel();
  state.voice.prefs = { ...state.voice.prefs, ...(field === 'ttsProvider' || field === 'language' ? { ttsVoice: '' } : {}), [field]: value };
  saveVoicePreferences();
  const rejected = field === 'ttsVoice' && String(value || '').trim() && !state.voice.prefs.ttsVoice;
  syncVoicePreferenceControls();
  $('voiceActionStatus').textContent = rejected
    ? 'Choisis une voix installée ou un mélange Kokoro valide.'
    : 'Enregistré dans ce navigateur. Les réglages partagés de VoiX n’ont pas changé.';
}

function voiceSecureContextAvailable() {
  return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

function updateVoiceButton() {
  const recording = state.voice.recorder?.state === 'recording';
  const available = state.voice.enabled && state.voice.reachable && voiceSecureContextAvailable();
  voiceRecord.disabled = !recording && (!available || !state.ready || state.busy);
  voiceRecord.textContent = recording ? 'Stop' : 'Micro';
  voiceRecord.classList.toggle('recording', recording);
  voiceRecord.setAttribute('aria-label', recording ? 'Arrêter l’enregistrement' : 'Enregistrer un message vocal');
  voiceRecord.title = available
    ? (recording ? 'Arrêter et transcrire cet enregistrement' : 'Enregistrer un message vocal privé et local')
    : 'L’enregistrement demande l’adresse HTTPS de confiance de PsyX et un service VoiX joignable';
}

function renderVoiceStatus(status = null, error = null) {
  const secure = voiceSecureContextAvailable();
  $('voiceSecureNotice').textContent = secure ? '' : 'Le micro est bloqué à cette adresse. Ouvre PsyX par son adresse HTTPS de confiance.';
  $('voiceStatusDot').classList.toggle('online', Boolean(status?.reachable));
  $('voiceStatusDot').classList.toggle('offline', !status?.reachable);
  $('voiceStatusText').textContent = !state.voice.enabled
    ? 'La voix n’est pas activée sur cette installation'
    : status?.reachable ? 'VoiX local est prêt' : 'VoiX local est indisponible';
  $('voiceStatusDetail').textContent = status?.reachable
    ? `Reconnaissance ${status.config?.whisperModel || 'Whisper'} · synthèse par défaut ${status.config?.ttsProvider || 'locale'} · VoiX ${status.serviceVersion || ''}`
    : (error?.message || 'L’audio reste désactivé tant que le service de voix privé est injoignable.');
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
  $('voiceStatusText').textContent = 'Vérification de VoiX local…';
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
  if (!voiceSecureContextAvailable()) throw new Error('Utilise l’adresse HTTPS de confiance de PsyX pour autoriser le micro.');
  if (requestPermission) {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  const selected = state.voice.prefs.inputDeviceId;
  $('voiceInputDevice').innerHTML = '<option value="">Micro par défaut du système</option>' + devices.map((device, index) =>
    `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Micro ${index + 1}`)}</option>`
  ).join('');
  $('voiceInputDevice').value = devices.some((device) => device.deviceId === selected) ? selected : '';
}

async function transcribeRecording(blob) {
  const accessEpoch = state.accessEpoch;
  if (!state.unlocked) return;
  $('voiceActionStatus').textContent = 'Transcription locale…';
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
  if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('PsyX a été verrouillé ou la séance privée a expiré.');
  if (!response.ok || payload.ok === false) throw new Error(payload.message || `La transcription a échoué (${response.status})`);
  const transcript = String(payload.data?.text || payload.text || '').trim();
  if (!transcript) throw new Error('Aucune parole détectée.');
  input.value = input.value.trim() ? `${input.value.trim()} ${transcript}` : transcript;
  resizeInput();
  $('voiceActionStatus').textContent = 'Transcrit localement. Aucun audio n’a été conservé.';
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
  if (!voiceSecureContextAvailable()) throw new Error('Utilise l’adresse HTTPS de confiance de PsyX pour enregistrer.');
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
  $('voiceActionStatus').textContent = 'Enregistrement… appuie sur Stop quand tu as fini.';
  updateVoiceButton();
}

function showVoiceError(error) {
  $('voiceActionStatus').textContent = error?.message || 'La voix a échoué.';
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
    if (!window.VoixAudio) throw new Error('Le lecteur de voix local est indisponible.');
    state.voice.speech ||= new window.VoixAudio.Speech({
      onReceipt: receipt => { $('voiceActionStatus').textContent = `Voix : ${receipt.provider} · ${receipt.voice} · ${receipt.language}`; },
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
        if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('PsyX a été verrouillé ou la séance privée a expiré.');
        throw new Error(payload.message || `La synthèse a échoué (${response.status})`);
      }
      return response;
    });
  } catch (error) { if (error.name !== 'AbortError') showVoiceError(error); }
}

function wireVoiceControls() {
  $('voiceSettings').addEventListener('click', async () => {
    syncVoicePreferenceControls();
    $('voiceActionStatus').textContent = '';
    voiceDialog.showModal();
    await loadVoiceStatus();
    await refreshMicrophones().catch(() => {});
  });
  $('voiceRefresh').addEventListener('click', loadVoiceStatus);
  $('voiceFindDevices').addEventListener('click', async () => {
    $('voiceActionStatus').textContent = 'Demande d’accès au micro…';
    try {
      await refreshMicrophones({ requestPermission: true });
      $('voiceActionStatus').textContent = 'Micros actualisés.';
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
  $('voiceStop').addEventListener('click', () => { state.voice.speech?.cancel(); $('voiceActionStatus').textContent = 'Voix arrêtée.'; });
  $('voiceTtsCustom').addEventListener('change', () => updateVoicePreference('ttsVoice', $('voiceTtsCustom').value.trim()));
  voiceRecord.addEventListener('click', toggleVoiceRecording);
}
