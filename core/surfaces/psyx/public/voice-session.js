'use strict';

// One private surface adapter around Core's capture, endpoint and playback loop.
// No Nestor session or personal memory route is used by PsyX.
let psyxVoiceSession = null;

function spokenVoiceText(text) {
  return window.NestorSpeech.speechText(text);
}

function chooseInitialVoice(catalog) {
  // Preserve an explicit choice, including the default of a chosen provider.
  try {
    if (localStorage.getItem(voicePreferences.STORAGE_KEY)) return;
  } catch { return; }
  const candidate = voicePreferences.preferredFemaleVoice(catalog, state.voice.prefs.language);
  if (!candidate) return;
  state.voice.prefs = { ...state.voice.prefs, ttsProvider: candidate.provider, ttsVoice: candidate.id };
  saveVoicePreferences();
}

function stopVoiceSession({ close = true } = {}) {
  psyxVoiceSession?.stop(true);
  state.voice.speech?.cancel();
  if (close && $('voiceSessionDialog').open) $('voiceSessionDialog').close();
  $('voiceSessionSafety').replaceChildren();
  $('voiceSessionSafety').hidden = true;
}

async function voiceSessionFetch(path, options, signal) {
  const epoch = state.accessEpoch;
  assertCurrentAccess(epoch);
  if (!state.unlocked) throw Object.assign(new Error('PsyX est verrouillé.'), { name: 'AbortError' });
  const response = await fetch('/api/psyx/voice/' + path, { credentials: 'same-origin', ...options, signal });
  assertCurrentAccess(epoch);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && payload.code === 'PSYX_LOCKED') showGate('La séance privée a expiré.');
    throw new Error(payload.message || `La voix a échoué (${response.status}).`);
  }
  return response;
}

function syncVoiceSessionSafety() {
  const source = $('safetyBanner');
  const target = $('voiceSessionSafety');
  target.replaceChildren();
  target.hidden = source.hidden;
  if (source.hidden || !$('voiceSessionDialog').open) return;
  const copy = source.cloneNode(true);
  copy.removeAttribute('id');
  copy.querySelector('button')?.remove();
  for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');
  target.append(copy);
}

function createPsyXVoiceSession() {
  const labels = { idle: 'Prêt à t’écouter.', starting: 'Ouverture du micro…', listening: 'Je t’écoute.',
    hearing: 'Tu as la parole.', transcribing: 'Je t’ai entendu…', thinking: 'Je réfléchis.',
    preparing: 'Préparation de la voix…', speaking: 'PsyX te répond.', paused: 'Micro et voix arrêtés.', error: 'La voix a été arrêtée.' };
  return new window.AgentXVoice.Conversation({
    holdingDelayMs: null,
    speechText: spokenVoiceText,
    openAudio: (signal, failed, options) => window.AgentXVoice.openAudio(signal, failed,
      { ...options, inputDeviceId: state.voice.prefs.inputDeviceId }),
    // The browser loop keeps only an ephemeral handle; Core creates a canonical
    // PsyX conversation on the first completed turn, just as for typed messages.
    createSession: async () => ({ surface: 'psyx' }),
    transcribe: async (blob, language, signal) => {
      const response = await voiceSessionFetch('transcribe', { method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/wav', 'X-PsyX-Language': language || 'fr' }, body: blob }, signal);
      const payload = await response.json();
      const transcript = payload.data || payload;
      return { text: transcript.text || '', language: transcript.language || language,
        ...(transcript.control === 'stop' ? { control: 'stop' } : {}) };
    },
    turn: async (_session, text, signal) => {
      const reply = await sendMessage(text, { source: 'voice', voiceSession: true, signal });
      if (!reply) throw new Error('La réponse n’a pas été confirmée. Reprends lorsque PsyX est prêt.');
      return reply;
    },
    // Full confirmed replies reach the speech boundary. This keeps Markdown
    // cleanup whole and prevents reading a partial code block or incomplete link.
    synthesize: async ({ text, language }, signal) => {
      const request = voicePreferences.synthesisRequest(spokenVoiceText(text), { ...state.voice.prefs, language });
      const response = await voiceSessionFetch('synthesize/stream', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }, signal);
      return response;
    },
    message: () => {},
  }, (phase, detail) => {
    $('voiceSessionPhase').textContent = phase === 'error' ? 'La voix a été arrêtée. Vérifie l’accès au micro et la connexion locale, puis reprends.' : detail || labels[phase] || 'Un instant…';
    $('voiceSessionDialog').dataset.phase = phase;
    const resting = ['idle', 'paused', 'error'].includes(phase);
    $('voiceSessionStart').disabled = !resting || state.busy || !state.ready;
    $('voiceSessionPause').disabled = resting;
    // The calm full-screen session must never obscure crisis resources.
    syncVoiceSessionSafety();
  });
}

async function startPsyXVoiceSession() {
  if (!state.unlocked || !state.ready || state.busy || !state.voice.reachable) return;
  psyxVoiceSession ||= createPsyXVoiceSession();
  await psyxVoiceSession.start({ language: state.voice.prefs.language, wakeWord: false, interruption: false });
}

function wireVoiceSession() {
  $('voiceSessionOpen').addEventListener('click', async () => {
    if (!state.unlocked || !state.ready || state.busy || (state.voice.recordingPending || state.voice.recorder?.state === 'recording')) return;
    state.voice.speech?.cancel();
    const chosen = state.voice.catalog?.voices?.find(voice => voice.provider === state.voice.prefs.ttsProvider && voice.id === state.voice.prefs.ttsVoice);
    $('voiceSessionVoice').textContent = voicePreferences.describePreferences(state.voice.prefs, state.voice.status) + (chosen?.locale ? ` · ${chosen.locale}` : '');
    $('voiceSessionDialog').showModal();
    syncVoiceSessionSafety();
    $('voiceSessionStart').disabled = !state.voice.enabled || !state.voice.reachable;
    if (!state.voice.enabled || !state.voice.reachable) {
      $('voiceSessionPhase').textContent = 'La voix locale est indisponible. Vérifie les réglages de voix.';
      return;
    }
    await startPsyXVoiceSession();
  });
  $('voiceSessionStart').addEventListener('click', startPsyXVoiceSession);
  $('voiceSessionPause').addEventListener('click', () => stopVoiceSession({ close: false }));
  $('voiceSessionEnd').addEventListener('click', () => stopVoiceSession());
  $('voiceSessionDialog').addEventListener('cancel', () => stopVoiceSession());
  $('voiceSessionDialog').addEventListener('close', () => stopVoiceSession({ close: false }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoiceSession(); });
  window.addEventListener('pagehide', () => stopVoiceSession());
}
