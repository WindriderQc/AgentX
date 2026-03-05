/**
 * Chat voice — STT/TTS functions, recording, voice health
 */

let recognition = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimer = null;
let claudeSessionId = null;
let claudeSessionId = null;

export function updateVoiceFieldVisibility(elements) {
  const sttProv = elements.sttProviderSelect?.value || 'auto';
  const ttsOn = elements.ttsToggle?.checked;
  const ttsProv = document.getElementById('ttsProviderSelect')?.value || 'browser';
  if (elements.whisperModelField) {
    elements.whisperModelField.style.display = (sttProv === 'auto' || sttProv === 'local') ? '' : 'none';
  }
  const ttsProviderField = document.getElementById('ttsProviderField');
  if (ttsProviderField) ttsProviderField.style.display = ttsOn ? '' : 'none';
  if (elements.ttsVoiceField) {
    elements.ttsVoiceField.style.display = (ttsOn && ttsProv === 'openai') ? '' : 'none';
  }
}

function setHealthDot(el, status) {
  if (!el) return;
  el.className = 'voice-health-dot ' + status;
}

export async function checkVoiceHealth(elements, state) {
  try {
    const res = await fetch('/api/voice/health?models=true');
    if (!res.ok) return;
    const { data } = await res.json();

    const sttPref = elements.sttProviderSelect?.value || state.settings?.sttProvider || 'auto';
    if (sttPref === 'browser') {
      state.voiceProvider = 'browser';
    } else if (sttPref === 'openai') {
      state.voiceProvider = data?.stt?.openai ? 'server' : 'browser';
    } else if (sttPref === 'local') {
      state.voiceProvider = data?.stt?.local ? 'server' : 'browser';
    } else {
      state.voiceProvider = (data?.stt?.local || data?.stt?.openai) ? 'server' : 'browser';
    }

    const sttStatus = data?.stt?.local ? 'healthy' : (data?.stt?.openai ? 'partial' : 'unavailable');
    setHealthDot(elements.sttHealthDot, sttStatus);
    setHealthDot(elements.sttHealthDotInner, sttStatus);
    const ttsStatus = (data?.tts?.openai || data?.tts?.local) ? 'healthy' : 'partial';
    setHealthDot(elements.ttsHealthDot, ttsStatus);

    if (data?.models?.length && elements.whisperModelSelect) {
      const saved = state.settings?.whisperModel || '';
      elements.whisperModelSelect.innerHTML = '<option value="">Server default</option>';
      data.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m.replace('Systran/faster-whisper-', '');
        elements.whisperModelSelect.appendChild(opt);
      });
      if (saved) elements.whisperModelSelect.value = saved;
    }

    if (data?.languages?.length && elements.sttLanguageSelect) {
      const saved = state.settings?.sttLanguage || 'en';
      elements.sttLanguageSelect.innerHTML = '';
      data.languages.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.name;
        elements.sttLanguageSelect.appendChild(opt);
      });
      elements.sttLanguageSelect.value = saved;
    }

    updateVoiceFieldVisibility(elements);
    console.log(`Voice: STT=${state.voiceProvider}, local=${data?.stt?.local}, openai=${data?.stt?.openai}`);
  } catch (err) {
    console.warn('Voice health check failed:', err);
    state.voiceProvider = 'browser';
    setHealthDot(elements.sttHealthDot, 'unavailable');
    setHealthDot(elements.sttHealthDotInner, 'unavailable');
  }
}

function showVoiceStatus(text) {
  const el = document.getElementById('voiceStatus');
  if (el) { el.textContent = text; el.style.display = text ? 'inline' : 'none'; }
}

function updateRecordingTimer() {
  if (!recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  showVoiceStatus(`Recording... ${elapsed}s`);
}

function cleanupVoiceInput(elements) {
  recognition = null;
  mediaRecorder = null;
  audioChunks = [];
  isRecording = false;
  recordingStartTime = null;
  clearInterval(recordingTimer);
  recordingTimer = null;
  elements.micBtn.classList.remove('recording');
  elements.micBtn.setAttribute('aria-pressed', 'false');
  showVoiceStatus('');
}

async function startServerVoiceInput(elements, state, helpers) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg' });

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordingTimer);
      showVoiceStatus('Transcribing...');
      helpers.setStatus('Transcribing...', 'success');

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      const formData = new FormData();
      formData.append('audio', blob, 'recording.webm');

      try {
        // Claude Code mode: send audio directly to /api/voice/claude
        if (elements.claudeCodeToggle?.checked) {
          showVoiceStatus('Sending to Claude Code...');
          helpers.setStatus('Sending to Claude Code...', 'success');
          formData.append('language', elements.sttLanguageSelect?.value || 'en');
          if (claudeSessionId) formData.append('continueSession', 'true');
          const res = await fetch('/api/voice/claude', { method: 'POST', body: formData });
          if (!res.ok) throw new Error(`Claude Code failed: ${res.status}`);
          const { data } = await res.json();
          if (data?.transcription) {
            elements.messageInput.value = data.transcription;
            helpers.appendMessage('user', data.transcription);
            helpers.appendMessage('assistant', '**Claude Code** (' + (data.claudeDuration/1000).toFixed(1) + 's):\n\n' + (typeof data.claudeResponse === 'string' ? data.claudeResponse : JSON.stringify(data.claudeResponse, null, 2)));
            if (data.claudeSessionId) claudeSessionId = data.claudeSessionId;
            if (data.claudeSessionId) claudeSessionId = data.claudeSessionId;
            helpers.setFeedback(`Claude Code done (STT: ${data.sttProvider} ${data.sttDuration}ms, Claude: ${data.claudeDuration}ms)`, 'success');
          } else {
            helpers.setFeedback('No speech detected. Try again.', 'error');
          }
        } else {
          // Normal mode: transcribe only, fill input
          const params = new URLSearchParams();
          const sttProv = elements.sttProviderSelect?.value || state.settings?.sttProvider || 'auto';
          params.set('provider', (sttProv === 'openai') ? 'openai' : 'local');
          const lang = elements.sttLanguageSelect?.value || 'en';
          if (lang) params.set('language', lang);
          const model = elements.whisperModelSelect?.value || '';
          if (model) params.set('model', model);
          const res = await fetch(`/api/voice/transcribe?${params}`, { method: 'POST', body: formData });
          if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
          const { data } = await res.json();
          if (data?.text) {
            elements.messageInput.value = data.text;
            helpers.setFeedback(`Transcribed (${data.provider}, ${data.duration}ms)`, 'success');
            if (state.settings?.voiceAutoSend) helpers.sendMessage();
          } else {
            helpers.setFeedback('No speech detected. Try again.', 'error');
          }
        }
      } catch (err) {
        console.error('Server voice error:', err);
        helpers.setFeedback(`Voice error: ${err.message}`, 'error');
      }
      cleanupVoiceInput(elements);
    };

    mediaRecorder.start();
    isRecording = true;
    recordingStartTime = Date.now();
    recordingTimer = setInterval(updateRecordingTimer, 1000);
    elements.micBtn.classList.add('recording');
    elements.micBtn.setAttribute('aria-pressed', 'true');
    showVoiceStatus('Recording... 0s');
    helpers.setStatus('Recording...', 'success');
    window.speechSynthesis.cancel();
  } catch (err) {
    console.error('Microphone access error:', err);
    helpers.setFeedback(`Mic error: ${err.message}. Falling back to browser.`, 'error');
    startBrowserVoiceInput(elements, state, helpers);
  }
}

function stopServerVoiceInput(elements) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanupVoiceInput(elements);
  }
}

function startBrowserVoiceInput(elements, state, helpers) {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    helpers.setFeedback('Speech recognition not supported in this browser.', 'error');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  const langCode = elements.sttLanguageSelect?.value || state.settings?.sttLanguage || 'en';
  recognition.lang = langCode.length === 2 ? `${langCode}-${langCode.toUpperCase()}` : langCode;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isRecording = true;
    elements.micBtn.classList.add('recording');
    elements.micBtn.setAttribute('aria-pressed', 'true');
    showVoiceStatus('Listening...');
    helpers.setStatus('Listening...', 'success');
  };
  recognition.onresult = (event) => {
    elements.messageInput.value = event.results[0][0].transcript;
    if (state.settings?.voiceAutoSend) helpers.sendMessage();
  };
  recognition.onerror = (event) => {
    console.error('Speech recognition error', event.error);
    helpers.setFeedback(`Voice error: ${event.error}`, 'error');
    cleanupVoiceInput(elements);
  };
  recognition.onend = () => cleanupVoiceInput(elements);

  window.speechSynthesis.cancel();
  recognition.start();
}

function stopBrowserVoiceInput(elements) {
  if (recognition) recognition.stop();
  else cleanupVoiceInput(elements);
}

export function toggleVoiceInput(elements, state, helpers) {
  if (isRecording) {
    if (state.voiceProvider === 'server') stopServerVoiceInput(elements);
    else stopBrowserVoiceInput(elements);
  } else {
    if (state.voiceProvider === 'server') startServerVoiceInput(elements, state, helpers);
    else startBrowserVoiceInput(elements, state, helpers);
  }
}

export async function speakText(state, text) {
  if (!state.settings.tts) return;
  const provider = state.settings.ttsProvider || 'browser';

  if (provider !== 'browser') {
    try {
      const voice = state.settings?.ttsVoice || 'alloy';
      const res = await fetch('/api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, provider, voice })
      });
      if (res.ok && res.headers.get('content-type')?.startsWith('audio/')) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play();
        return;
      }
    } catch (err) {
      console.warn('Server TTS failed, falling back to browser:', err.message);
    }
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const setVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Google US English')) ||
                      voices.find(v => v.lang === 'en-US') ||
                      voices[0];
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
  };
  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.addEventListener('voiceschanged', setVoice, { once: true });
  } else {
    setVoice();
  }
}
