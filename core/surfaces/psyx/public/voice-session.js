'use strict';

// One private surface adapter around Core's capture, endpoint and playback loop.
// No Nestor session or personal memory route is used by PsyX.
let psyxVoiceSession = null;
let psyxVoicePhase = 'idle';

function spokenVoiceText(text) {
  return window.NestorSpeech.speechText(text);
}

// The private adapter shares rung tracking with Household but keeps device speech disabled.
// A failed accepted stream must never request the same selected voice again.
async function synthesizePsyXSpeech({ text, language, after = null }, signal) {
  state.voice.ladder ||= window.AgentXSpeechLadder.createSpeechLadder({
    request: async ({ text, language, choice }, signal) => {
      signal?.throwIfAborted();
      const request = voicePreferences.synthesisRequest(spokenVoiceText(text),
        { ...state.voice.prefs, language, ttsProvider: choice.provider, ttsVoice: choice.voice });
      return fetch('/api/psyx/voice/synthesize/stream', { credentials: 'same-origin', method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    },
    deviceVoice: () => false,
    unavailable: 'PsyX speech is unavailable. The complete answer remains on screen.',
  });
  return state.voice.ladder.speak({ text, language: language || state.voice.prefs.language, after,
    choices: [{ provider: state.voice.prefs.ttsProvider, voice: state.voice.prefs.ttsVoice }] }, signal);
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



  signal?.throwIfAborted();
  const response = await fetch('/api/psyx/voice/' + path, { credentials: 'same-origin', ...options, signal });

  signal?.throwIfAborted();
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));

    throw Object.assign(new Error(payload.message || `Voice failed (${response.status}).`), { code: payload.code, status: response.status });
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

// Start is available whenever the loop rests; a turn still being answered only
// delays it, so the button follows both the phase and the busy state.
function syncVoiceSessionControls() {
  const resting = ['idle', 'paused', 'error', 'reviewing'].includes(psyxVoicePhase);
  $('voiceSessionStart').disabled = !resting || state.busy || !state.ready || !state.voice.enabled || !state.voice.reachable;
  // While reviewing, the microphone is quiet but still open: Pause must stay able to release it.
  $('voiceSessionPause').disabled = resting && psyxVoicePhase !== 'reviewing';
}

function createPsyXVoiceSession() {
  const labels = { idle: 'Ready to listen.', starting: 'Opening the microphone…', listening: 'Listening.',
    hearing: 'Go ahead.', transcribing: 'I heard you…', thinking: 'Thinking.', waiting: 'One moment…',
    preparing: 'Preparing the voice…', speaking: 'PsyX is replying.', paused: 'Microphone and voice stopped.', error: 'Voice was stopped.',
    reviewing: 'I couldn’t transcribe that. Press Start to continue.', resuming: 'Listening again…' };
  return new window.AgentXVoice.Conversation({
    holdingDelayMs: null,
    speechText: spokenVoiceText,
    openAudio: (signal, failed, options) => window.AgentXVoice.openAudio(signal, failed,
      { ...options, inputDeviceId: state.voice.prefs.inputDeviceId }),
    // The browser loop keeps only an ephemeral handle; Core creates a canonical
    // PsyX conversation on the first completed turn, just as for typed messages.
    createSession: async () => ({ surface: 'psyx' }),
    // The person starts speaking: wake speech recognition while they talk (best effort).
    warm: () => voiceSessionFetch('warm', { method: 'POST' }),
    transcribe: async (blob, language, signal) => {
      let response;
      try {
        response = await voiceSessionFetch('transcribe', { method: 'POST',
          headers: { 'Content-Type': blob.type || 'audio/wav', 'X-PsyX-Language': language || 'fr' }, body: blob }, signal);
      } catch (error) {
        // A cough or a door is not a failure: an empty text lets the loop listen again.
        if (error.code === 'PSYX_VOICE_NO_SPEECH') return { text: '', language };
        throw error;
      }
      const payload = await response.json();
      const transcript = payload.data || payload;
      const metadata = {};
      for (const key of ['model', 'effectiveModel', 'requestedModel', 'detectedLanguage', 'sttMs']) {
        if (transcript[key] !== undefined) metadata[key] = transcript[key];
      }
      return { text: transcript.text || '', language: transcript.language || language,
        ...metadata,
        ...(transcript.control === 'stop' ? { control: 'stop' } : {}) };
    },
    turn: async (_session, text, signal) => {
      const reply = await sendMessage(text, { source: 'voice', voiceSession: true, signal });
      if (!reply) throw new Error('The reply was not confirmed. Continue when PsyX is ready.');
      return reply;
    },
    // Full confirmed replies reach the speech boundary. This keeps Markdown
    // cleanup whole and prevents reading a partial code block or incomplete link.
    synthesize: synthesizePsyXSpeech,
    message: () => {},
  }, (phase, detail) => {
    // The shared loop's own detail for a failed transcription is in English; PsyX shows its label.
    $('voiceSessionPhase').textContent = phase === 'error' ? 'Voice was stopped. Check microphone access and the local connection, then continue.'
      : phase === 'reviewing' ? labels.reviewing : detail || labels[phase] || 'One moment…';
    $('voiceSessionDialog').dataset.phase = phase;
    psyxVoicePhase = phase;
    syncVoiceSessionControls();
    // The calm full-screen session must never obscure crisis resources.
    syncVoiceSessionSafety();
  });
}

async function startPsyXVoiceSession() {
  if (!state.ready || state.busy || !state.voice.reachable) return;
  psyxVoiceSession ||= createPsyXVoiceSession();
  await psyxVoiceSession.start({ language: state.voice.prefs.language, wakeWord: false, interruption: false });
}

function wireVoiceSession() {
  $('voiceSessionOpen').addEventListener('click', async () => {
    if (!state.ready || state.busy || (state.voice.recordingPending || state.voice.recorder?.state === 'recording')) return;
    state.voice.speech?.cancel();
    const chosen = state.voice.catalog?.voices?.find(voice => voice.provider === state.voice.prefs.ttsProvider && voice.id === state.voice.prefs.ttsVoice);
    $('voiceSessionVoice').textContent = voicePreferences.describePreferences(state.voice.prefs, state.voice.status) + (chosen?.locale ? ` · ${chosen.locale}` : '');
    $('voiceSessionDialog').showModal();
    syncVoiceSessionSafety();
    syncVoiceSessionControls();
    if (!state.voice.enabled || !state.voice.reachable) {
      $('voiceSessionPhase').textContent = 'Local voice is unavailable. Check the voice settings.';
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
