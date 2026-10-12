(() => {
  'use strict';

  const app = document.getElementById('app');
  const toastNode = document.getElementById('toast');
  const state = {
    session: null,
    packs: [],
    history: [],
    recording: null,
    chunks: [],
    micMuted: false,
    outputMuted: false,
    activeAudio: null,
    activeAudioUrl: null,
    activeSound: null
  };
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const readingVoiceKey = 'household.reading.voices.v1';
  let readingVoices = {};
  try { readingVoices = window.PersonaPresentation.selections(JSON.parse(localStorage.getItem(readingVoiceKey) || '{}')); } catch { /* tab-only settings */ }
  const readingDialog = document.getElementById('readingVoiceDialog');
  const readingSelects = { fr: document.getElementById('readingVoiceFr'), en: document.getElementById('readingVoiceEn') };
  document.getElementById('readingVoiceSettings').onclick = async () => {
    readingDialog.showModal();
    document.getElementById('readingVoiceSave').disabled = true;
    document.getElementById('readingVoicePreview').disabled = true;
    const status = document.getElementById('readingVoiceStatus'); status.textContent = 'Loading local voices…';
    try {
      const catalog = await api('/api/voix/catalog');
      for (const [language, select] of Object.entries(readingSelects)) {
        select.length = 1;
        for (const provider of catalog.providers || []) {
          const group = document.createElement('optgroup'); group.label = provider.name;
          for (const voice of window.VoixAudio.choices(catalog, language, provider.id)) {
            const option = new Option(`${voice.name} · ${voice.locale}${voice.available ? '' : ' · unavailable'}`, window.VoixAudio.voiceKey(voice));
            option.disabled = !voice.available; group.append(option);
          }
          if (group.children.length) select.append(group);
        }
        const saved = readingVoices[language] || '';
        if (saved && ![...select.options].some(option => option.value === saved)) {
          const option = new Option(`Saved voice unavailable: ${saved.split('|')[1]}`, saved); option.disabled = true; select.append(option);
        }
        select.value = saved;
      }
      status.textContent = 'The preview plays through this browser’s speaker.';
      document.getElementById('readingVoiceSave').disabled = false;
      document.getElementById('readingVoicePreview').disabled = false;
    } catch { status.textContent = 'The local catalog is unavailable. Saved choices are kept.'; }
  };
  document.getElementById('readingVoiceSave').onclick = () => {
    readingVoices = window.PersonaPresentation.selections(Object.fromEntries(Object.entries(readingSelects).map(([language, select]) => [language, select.value])));
    try { localStorage.setItem(readingVoiceKey, JSON.stringify(readingVoices)); document.getElementById('readingVoiceStatus').textContent = 'Voices saved on this browser.'; }
    catch { document.getElementById('readingVoiceStatus').textContent = 'Choices apply to this tab only. The browser refuses to save them.'; }
  };
  document.getElementById('readingVoicePreview').onclick = () => speak('Bonjour. Voici la voix choisie pour les lectures en français.', 'fr',
    window.VoixAudio.splitVoice(readingSelects.fr.value) || { provider: 'kokoro', voice: 'ff_siwis' });
  document.getElementById('readingVoiceStop').onclick = () => stopPlayback();
  document.getElementById('readingVoiceClose').onclick = () => readingDialog.close();
  readingDialog.addEventListener('close', () => stopPlayback());

  function toast(message) {
    toastNode.textContent = message;
    toastNode.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastNode.classList.remove('show'), 3200);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok || body.status === 'error') {
      const error = new Error(body.message || `HTTP ${response.status}`);
      error.status = response.status;
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      error.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : null;
      throw error;
    }
    return body.data ?? body;
  }

  function setRuntime(ok, label) {
    const node = document.getElementById('runtimePill');
    node.textContent = label;
    node.className = `runtime-pill ${ok === true ? 'ok' : ok === 'waiting' ? 'waiting' : 'down'}`;
  }

  function navActive() {
    const path = location.pathname;
    const family = path === '/panel' || path.startsWith('/kids') || path === '/lecture';
    const personal = path.startsWith('/dad') || path.startsWith('/voice-personas') || path.startsWith('/lecture/parents') || ['/voice', '/voice.html', '/voix'].includes(path);
    document.getElementById('readingVoiceSettings').hidden = !(family || personal);
  }

  function clock() {
    const node = document.getElementById('clock');
    if (node) node.textContent = new Intl.DateTimeFormat('en-CA', { hour: '2-digit', minute: '2-digit' }).format(new Date());
  }

  async function ensureSession(packId, scopeId = 'family', modeId = '', signal) {
    const privateLane = packId === 'personal_operator';
    if (state.session?.packId === packId && state.session.scopeId === scopeId && (!modeId || state.session.modeId === modeId)) return state.session;
    const data = await api(`/api/voice-personas/${privateLane ? 'private/' : ''}sessions`, {
      method: 'POST',
      signal,
      // Kids Room and Lecture are Nestor too: the conversation carries his personality, so its
      // voice (including the instance's voice for him) is the one these pages read with.
      body: JSON.stringify({ packId, scopeId, modeId, personaId: 'nestor' })
    });
    signal?.throwIfAborted();
    state.session = data.session;
    state.history = [];
    return state.session;
  }

  async function turn(packId, text, channel = 'text', options = {}) {
    const privateLane = packId === 'personal_operator';
    const scopeId = options.scopeId || (privateLane ? 'personal' : 'family');
    const session = await ensureSession(packId, scopeId, options.modeId || '', options.signal);
    const data = await api(`/api/voice-personas/${privateLane ? 'private/' : ''}sessions/${encodeURIComponent(session.sessionId)}/turns/text`, {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({ text, channel })
    });
    options.signal?.throwIfAborted();
    const reply = data.reply?.text || '';
    if (data.session) state.session = data.session;
    state.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    state.history = state.history.slice(-8);
    return { reply, data };
  }

  function voiceBar(prefix) {
    return `<div class="voice-bar" aria-label="Voice privacy controls"><span id="${prefix}VoiceState" class="voice-state" data-state="checking" role="status" aria-live="polite">Push-to-talk · checking microphone…</span><div class="voice-toggles"><button id="${prefix}MicToggle" class="compact" type="button" aria-pressed="false">Mic on</button><button id="${prefix}SoundToggle" class="compact" type="button" aria-pressed="false">Sound on</button></div></div>`;
  }

  function setVoiceStatus(prefix, status, label) {
    const node = document.getElementById(`${prefix}VoiceState`);
    if (!node) return;
    node.dataset.state = status;
    node.textContent = label;
  }

  function stopPlayback() {
    state.speech?.cancel();
    if (state.activeAudio) {
      state.activeAudio.pause();
      state.activeAudio.removeAttribute('src');
      state.activeAudio.load();
      state.activeAudio = null;
    }
    if (state.activeSound) {
      state.activeSound.pause();
      state.activeSound = null;
    }
    if (state.activeAudioUrl) {
      URL.revokeObjectURL(state.activeAudioUrl);
      state.activeAudioUrl = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  // Legacy clips use their own audio element; wait for it before the next clip.
  // Speech now resolves after its final scheduled audio node has ended. Previously it would
  // talk over the answer. Wait for whichever voice path is live to finish, with
  // a ceiling so a stalled synthesiser never swallows the sound.
  function whenSpeechEnds(timeoutMs = 25000) {
    return new Promise((resolve) => {
      const audio = state.activeAudio;
      if (audio) {
        const done = () => resolve();
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setTimeout(done, timeoutMs);
        return;
      }
      if ('speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const finished = !window.speechSynthesis.speaking && !window.speechSynthesis.pending;
          if (finished || Date.now() - startedAt > timeoutMs) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
        return;
      }
      resolve();
    });
  }

  // Support optional catalog gains. The reviewed household pack is normalized
  // in its files and plays at unity gain, including without a Web Audio graph.
  let soundGainContext = null;
  function amplify(audio, gain) {
    if (!(gain > 1)) return;
    try {
      soundGainContext = soundGainContext || new (window.AudioContext || window.webkitAudioContext)();
      if (soundGainContext.state === 'suspended') soundGainContext.resume();
      const node = soundGainContext.createGain();
      node.gain.value = gain;
      soundGainContext.createMediaElementSource(audio).connect(node).connect(soundGainContext.destination);
    } catch (_error) { /* unamplified playback is still playback */ }
  }

  // The clip the turn selected: a real recording served from the extension's own
  // static assets, never a URL the model produced.
  async function playSound(sound, { afterSpeech = true } = {}) {
    if (!sound || !sound.url || state.outputMuted) return false;
    if (afterSpeech) await whenSpeechEnds();
    if (state.outputMuted) return false;
    if (state.activeSound) state.activeSound.pause();
    const audio = new Audio(sound.url);
    amplify(audio, sound.gain);
    state.activeSound = audio;
    // After an answer a clip is punctuation, so a long field recording is cut
    // short; a tap on the sound wall asked for the whole thing and gets it.
    const cutoff = afterSpeech ? setTimeout(() => {
      if (state.activeSound === audio) { audio.pause(); state.activeSound = null; }
    }, 9000) : null;
    audio.addEventListener('ended', () => {
      if (cutoff) clearTimeout(cutoff);
      if (state.activeSound === audio) state.activeSound = null;
    }, { once: true });
    try {
      await audio.play();
      return true;
    } catch (_error) {
      if (state.activeSound === audio) state.activeSound = null;
      return false;
    }
  }

  // A sound is a reward, not a surprise: the chip stays on screen so the child
  // can play it again without asking again.
  function showSoundChip(node, sound) {
    if (!node) return;
    node.querySelectorAll('[data-sound-chip]').forEach((chip) => chip.remove());
    if (!sound || !sound.url) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sound-chip';
    chip.dataset.soundChip = sound.id;
    chip.innerHTML = `<span aria-hidden="true">${esc(sound.emoji)}</span><span>${esc(`Hear ${sound.label.en} again`)}</span>`;
    chip.addEventListener('click', () => playSound(sound, { afterSpeech: false }));
    node.appendChild(chip);
  }

  function browserSpeak(text, profile) {
    if (!text || state.outputMuted || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = profile.locale;
    const voice = window.NestorSpeech.pickBrowserVoice(window.speechSynthesis.getVoices(), profile);
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  // The turn decides which voice reads its own reply; detecting from the
  // question here is what made a French answer speak in an English voice.
  function replyLanguage(result) {
    return result?.data?.reply?.language
      || window.NestorSpeech.detectSpeechLanguage(result?.reply || '');
  }

  // Kids Room and Lecture speak through the voice ladder the conversations use
  // (PersonaPresentation.speechChoices): the reading voice chosen on this
  // browser, then the conversation's personality voice (Nestor, with the
  // instance's voice for him), then that personality's catalog voice.
  async function speak(text, languageHint = '', override = null) {
    text = window.NestorSpeech.speechText(text);
    if (!text || state.outputMuted) return;
    const profile = window.NestorSpeech.speechProfile(text, languageHint);
    stopPlayback();
    try {
      if (!window.VoixAudio) throw new Error('Local speech player unavailable');
      state.speech ||= new window.VoixAudio.Speech();
      const choices = override ? [override]
        : window.PersonaPresentation.speechChoices(state.session?.persona, profile.language, { selections: readingVoices });
      await state.speech.speak(async signal => {
        for (const choice of choices) {
          const response = await fetch('/api/voix/synthesize/stream', {
            method: 'POST', signal, credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, language: profile.language, tts_provider: choice.provider,
              voice: choice.voice || '', native_defaults: choice.native_defaults === true }),
          });
          if (response.ok) return response;
        }
        throw new Error('Local speech is unavailable. Select another local voice or use the explicit browser preview.');
      });
    } catch (error) { if (error.name !== 'AbortError') toast(error.message); }
  }

  async function transcribe(blob) {
    const form = new FormData();
    form.append('file', blob, 'household.webm');
    form.append('language', 'fr');
    const response = await fetch('/api/voix/transcribe', { method: 'POST', credentials: 'include', body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || 'Transcription failed');
    return body.data?.text || body.text || body.transcript || '';
  }

  function bindRecorder(button, onText, prefix) {
    if (!button) return;
    const idleLabel = button.textContent;
    const stopLabel = button.dataset.stopLabel || '■ Stop';
    const micToggle = document.getElementById(`${prefix}MicToggle`);
    const soundToggle = document.getElementById(`${prefix}SoundToggle`);
    const supported = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder;

    function ready() {
      button.classList.remove('recording');
      button.textContent = idleLabel;
      button.setAttribute('aria-pressed', 'false');
      if (state.micMuted) {
        button.disabled = true;
        button.title = 'Microphone paused';
        setVoiceStatus(prefix, 'muted', 'Mic off · no capture possible');
      } else if (!window.isSecureContext) {
        button.disabled = true;
        button.title = 'Microphone requires trusted HTTPS';
        setVoiceStatus(prefix, 'unavailable', 'Text ready · open the trusted HTTPS link to talk');
      } else if (!supported) {
        button.disabled = true;
        button.title = 'Microphone capture is unavailable in this browser';
        setVoiceStatus(prefix, 'unavailable', 'Mic unavailable · use the keyboard');
      } else {
        button.disabled = false;
        button.title = 'Push to talk. Nothing listens until you press.';
        setVoiceStatus(prefix, 'ready', 'Mic ready · press to talk · never listening continuously');
      }
    }

    if (micToggle) {
      micToggle.addEventListener('click', () => {
        state.micMuted = !state.micMuted;
        micToggle.setAttribute('aria-pressed', String(state.micMuted));
        micToggle.textContent = state.micMuted ? 'Mic off' : 'Mic on';
        if (state.micMuted && state.recording) {
          state.recording.discard = true;
          if (state.recording.recorder.state !== 'inactive') state.recording.recorder.stop();
        }
        ready();
      });
    }
    if (soundToggle) {
      soundToggle.addEventListener('click', () => {
        state.outputMuted = !state.outputMuted;
        soundToggle.setAttribute('aria-pressed', String(state.outputMuted));
        soundToggle.textContent = state.outputMuted ? 'Sound off' : 'Sound on';
        if (state.outputMuted) stopPlayback();
      });
    }
    ready();

    button.addEventListener('click', async () => {
      if (state.recording) {
        if (state.recording.button !== button) return;
        setVoiceStatus(prefix, 'stopping', 'Capture done · preparing…');
        if (state.recording.recorder.state !== 'inactive') state.recording.recorder.stop();
        return;
      }
      if (state.micMuted || !supported) return;
      try {
        setVoiceStatus(prefix, 'permission', 'Allow the mic for this turn only…');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (state.micMuted) {
          stream.getTracks().forEach((track) => track.stop());
          ready();
          return;
        }
        state.chunks = [];
        const recorder = new MediaRecorder(stream);
        const recording = { recorder, stream, button, discard: false };
        state.recording = recording;
        recorder.addEventListener('dataavailable', (event) => { if (event.data.size) state.chunks.push(event.data); });
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((track) => track.stop());
          if (state.recording === recording) state.recording = null;
          button.classList.remove('recording');
          button.setAttribute('aria-pressed', 'false');
          if (recording.discard || state.micMuted) {
            state.chunks = [];
            ready();
            return;
          }
          button.disabled = true;
          let failed = false;
          try {
            setVoiceStatus(prefix, 'transcribing', 'Transcribing locally…');
            const text = await transcribe(new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' }));
            if (!text) throw new Error('No words heard. Try again or use the keyboard.');
            setVoiceStatus(prefix, 'thinking', 'Nestor is preparing an answer…');
            await onText(text);
          } catch (error) {
            failed = true;
            setVoiceStatus(prefix, 'error', error.message);
            toast(error.message);
          } finally {
            state.chunks = [];
            button.disabled = state.micMuted || !supported;
            if (!failed || state.micMuted) ready();
          }
        });
        recorder.start();
        button.classList.add('recording');
        button.textContent = stopLabel;
        button.setAttribute('aria-pressed', 'true');
        setVoiceStatus(prefix, 'listening', 'Mic on · press again to finish');
      } catch (error) {
        setVoiceStatus(prefix, 'error', 'Mic denied · use the keyboard or change the permission');
        toast(error.message);
      }
    });
  }

  async function loadPanel() {
    await window.mountConversation({ app, api, esc, space: 'family' });
    app.insertAdjacentHTML('beforeend', `<section class="ecosystem-primary household-spaces" aria-label="Family activities"><a class="ecosystem-primary-link" href="/kids"><span class="ecosystem-primary-index">01</span><span><small>Kids</small><strong>Learn & pitch in</strong><span>Activities and household responsibilities.</span></span></a><a class="ecosystem-primary-link" href="/lecture"><span class="ecosystem-primary-index">02</span><span><small>Reading</small><strong>Read together</strong><span>Explore a text with Nestor.</span></span></a></section>`);
    const shopping = document.createElement('section'); shopping.className = 'card household-shared-list'; app.append(shopping);
    window.HouseholdShopping.mount({ host: shopping, api, esc });
  }

  async function loadMemories() {
    app.innerHTML = `<section class="home-heading"><p class="eyebrow">Super Dad · private</p><h1>My memories.</h1><p class="lede">The facts, preferences and decisions you ask your agent to remember.</p></section><section class="memory-page"><details id="selectedNotes"></details><details id="memoryEvidence" hidden></details><details><summary>Earlier memories</summary><p>Notes kept in the Household notebook remain available here.</p><button id="legacyNotesLoad" type="button">View older notes</button><div id="legacyNotesList"></div></details></section>`;
    window.mountPersonalNotes({ host: document.getElementById('selectedNotes'), evidence: document.getElementById('memoryEvidence'), api, esc });
    document.getElementById('selectedNotes').open = true;
    document.getElementById('legacyNotesLoad').onclick = async () => {
      const host = document.getElementById('legacyNotesList'); host.textContent = 'Loading…';
      try {
        const result = await api('/api/voice-personas/memory/search', { method: 'POST', body: JSON.stringify({ packId: 'personal_operator', scopeId: 'personal', query: '' }) });
        host.innerHTML = result.memory.results.map(note => `<article class="personal-note"><p>${esc(note.text)}</p><small>Old notebook · ${esc(note.topic)}</small></article>`).join('') || '<p>No older notes.</p>';
      } catch { host.textContent = 'Older notes are unavailable right now.'; }
    };
    setRuntime(true, 'page ready');
  }

  // Ma journée lives in dad-day.js; it borrows the shared helpers.
  async function loadDad() {
    return window.HouseholdDadDay.load({ app, api, esc, toast, setRuntime, speak, clock });
  }

  function kidsTemplate() {
    return `<section class="kids-room"><div class="kids-shell"><a id="kidSoundDoor" class="kids-sound-door" href="/kids/sounds" hidden><span class="kids-sound-door-mark" aria-hidden="true">🔊</span><span><strong>Sound wall</strong><small id="kidSoundDoorCount">sounds to discover</small></span></a><header class="kids-header"><div><p class="eyebrow">Kids corner · reviewed by Dad · local AI · no tools</p><h1>One thing at a time.</h1><p class="lede">Ask a question, learn, practice or find a small safe step. No profile needed; Dad approves every checked task.</p></div><label class="kids-profile"><span>Who are you? (optional)</span><select id="kidProfile" aria-label="Family profile (optional)"><option value="">Guest</option></select></label></header><div id="kidsEmpty" class="kids-welcome" hidden><div><p class="card-kicker">Ready right away</p><h2>You can ask your questions.</h2><p>No name needed to talk to Nestor or use Reading. A profile is only for your household responsibilities.</p></div><div class="row wrap"><a class="button primary" href="/lecture">Open Reading</a><a class="button" href="/dad/family">Dad: add profiles and tasks</a></div></div><section id="kidsContent" class="kids-grid" hidden><article id="kidNextCard" class="next-chore"><p class="card-kicker">What do I do now?</p><div id="kidNext"></div></article><aside id="kidProgressCard" class="kids-progress"><p class="card-kicker">Today</p><div id="kidProgress"></div></aside><article class="kids-help"><div class="row"><div class="grow"><p class="card-kicker">Nestor helps you learn</p><h2>How can I help?</h2></div><a class="button compact" href="/lecture">Open Reading</a></div><div class="kid-ai-boundary" role="note"><strong>Nestor is an AI, not a person.</strong><span>It can be wrong. Don’t share private information. A parent can read this conversation. Check important things with a trusted adult.</span></div><div class="kid-mode-grid" aria-label="Choose how Nestor helps you"><button type="button" class="kid-mode active" data-kid-mode-choice="family" data-description="A short, clear answer and a way to check it." aria-pressed="true"><strong>Ask</strong><small>A clear answer</small></button><button type="button" class="kid-mode" data-kid-mode-choice="learn" data-description="Understand an idea with an example and a question to check." aria-pressed="false"><strong>Learn</strong><small>Explain + check</small></button><button type="button" class="kid-mode" data-kid-mode-choice="steps" data-description="Break a safe task into small steps, one at a time." aria-pressed="false"><strong>Steps</strong><small>Start small</small></button><button type="button" class="kid-mode" data-kid-mode-choice="practice" data-description="One question at a time, with gentle correction." aria-pressed="false"><strong>Practice</strong><small>One try at a time</small></button><button type="button" class="kid-mode" data-kid-mode-choice="mission" data-description="Help with a responsibility a parent already approved." aria-pressed="false"><strong>Home mission</strong><small>Approved tasks</small></button></div><p id="kidModeDescription" class="kid-mode-description">A short, clear answer and a way to check it.</p><div class="kid-starters" aria-label="Question ideas"><button type="button" data-kid-prompt-mode="learn" data-kid-prompt="Why do leaves change color? Help me understand.">Learn something</button><button type="button" data-kid-prompt-mode="steps" data-kid-prompt="Help me start a safe task, one small step at a time.">Start carefully</button><button type="button" data-kid-prompt-mode="practice" data-kid-prompt="Help me practice with one question at a time.">Practice</button><button type="button" data-kid-prompt-mode="mission" data-kid-prompt="Help me with a responsibility my parent already approved.">Home mission</button></div>${voiceBar('kid')}<div id="kidHelpReply" class="reader-reply small" role="status" aria-live="polite">Je peux t’aider à réfléchir et à apprendre. Je ne peux pas utiliser d’outils, contrôler la maison ou approuver une tâche.</div><form id="kidHelpForm" class="reader-controls"><button id="kidHelpMic" class="mic" type="button" data-stop-label="■ Stop" aria-label="Ask out loud">● Talk</button><input id="kidHelpInput" maxlength="300" autocomplete="off" placeholder="What do you want help with?" aria-label="Ask Nestor for help"><button class="primary">Ask</button></form></article></section></div></section>`;
  }

  async function loadKids() {
    app.innerHTML = kidsTemplate();
    let currentRoom = null;
    let activeKidMode = 'family';
    const profileSelect = document.getElementById('kidProfile');
    function selectKidMode(modeId) {
      const choice = document.querySelector(`[data-kid-mode-choice="${modeId}"]`);
      if (!choice) return;
      activeKidMode = modeId;
      state.session = null;
      state.history = [];
      stopPlayback();
      document.querySelectorAll('[data-kid-mode-choice]').forEach((button) => {
        const active = button === choice;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      document.getElementById('kidModeDescription').textContent = choice.dataset.description;
      document.getElementById('kidHelpReply').textContent = `${choice.querySelector('strong').textContent} mode ready. What do you want help with?`;
    }
    async function refreshRoom() {
      const profileId = profileSelect.value;
      if (!profileId) return;
      try {
        const data = await api(`/api/family/room?profileId=${encodeURIComponent(profileId)}`);
        currentRoom = data.room;
        const next = data.room.next;
        document.getElementById('kidNext').innerHTML = next
          ? `<div class="kid-chore-title"><span class="kid-avatar">${esc(data.profile.avatar)}</span><div><h2>${esc(next.title)}</h2><p>${esc(next.note || 'You know what to do. Ask Nestor if you want help.')}</p></div></div><div class="kid-chore-meta"><span>${'★'.repeat(next.stars)}</span><span>${esc(next.cadence === 'once' ? 'once' : `every ${next.cadence === 'daily' ? 'day' : 'week'}`)}</span>${next.overdue ? '<span class="danger-box">overdue</span>' : next.dueToday ? '<span class="warning">due today</span>' : ''}</div><button id="kidCheckIn" class="primary kid-done" data-ref="${esc(next.id)}">Done!</button>`
          : `<div class="kid-clear"><span>✓</span><h2>${data.room.waiting.length ? 'Everything is checked.' : 'All done!'}</h2><p>${data.room.waiting.length ? 'Dad will check what you checked off.' : 'Go play, read, create or help someone.'}</p></div>`;
        const upcoming = data.room.available.slice(next ? 1 : 0, 4);
        document.getElementById('kidProgress').innerHTML = `<div class="kid-score"><strong>${data.room.completedToday}</strong><span>approved today</span></div><div class="kid-score"><strong>${data.room.waiting.length}</strong><span>waiting for Dad</span></div>${upcoming.length ? `<div class="kid-upcoming"><small>Later</small>${upcoming.map((task) => `<span>${esc(task.title)}</span>`).join('')}</div>` : ''}`;
        const checkIn = document.getElementById('kidCheckIn');
        if (checkIn) checkIn.addEventListener('click', async () => {
          checkIn.disabled = true;
          try {
            await api('/api/family/chores/check-in', { method: 'POST', body: JSON.stringify({ profileId, ref: checkIn.dataset.ref }) });
            await refreshRoom();
          } catch (error) { toast(error.message); checkIn.disabled = false; }
        });
        setRuntime(true, 'kids room ready');
      } catch (error) {
        setRuntime(false, 'kids room unavailable');
        document.getElementById('kidNext').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      }
    }
    try {
      const data = await api('/api/family/profiles');
      const hasProfiles = data.profiles.length > 0;
      profileSelect.innerHTML = hasProfiles
        ? data.profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.avatar)} ${esc(profile.displayName)}</option>`).join('')
        : '<option value="">Guest</option>';
      document.getElementById('kidsEmpty').hidden = hasProfiles;
      document.getElementById('kidsContent').hidden = false;
      document.getElementById('kidNextCard').hidden = !hasProfiles;
      document.getElementById('kidProgressCard').hidden = !hasProfiles;
      profileSelect.disabled = !hasProfiles;
      if (hasProfiles) await refreshRoom(); else setRuntime(true, 'safe chat ready');
    } catch (error) {
      document.getElementById('kidsEmpty').hidden = false;
      document.getElementById('kidsEmpty').innerHTML = `<div><p class="card-kicker">Profiles unavailable</p><h2>Help is still available.</h2><p>${esc(error.message)}</p></div><a class="button primary" href="/lecture">Open Reading</a>`;
      document.getElementById('kidsContent').hidden = false;
      document.getElementById('kidNextCard').hidden = true;
      document.getElementById('kidProgressCard').hidden = true;
      profileSelect.disabled = true;
      setRuntime(false, 'profiles unavailable · safe chat ready');
    }
    profileSelect.addEventListener('change', refreshRoom);
    async function askForHelp(text, channel = 'text') {
      const reply = document.getElementById('kidHelpReply');
      reply.textContent = 'Thinking…';
      const chore = activeKidMode === 'mission' ? currentRoom?.next?.title : '';
      try {
        const result = await turn('kidx_nestor', `${chore ? `Responsabilité gérée par le parent dans Kids Room : « ${chore} ». ` : ''}${text}`, channel, { modeId: activeKidMode });
        reply.textContent = result.reply;
        const language = replyLanguage(result);
        await speak(result.reply, language);
        showSoundChip(reply, result.data.sound);
        await playSound(result.data.sound);
      } catch (error) { reply.textContent = `Try again? ${error.message}`; }
    }
    document.getElementById('kidHelpForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('kidHelpInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await askForHelp(text);
    });
    document.querySelectorAll('[data-kid-mode-choice]').forEach((button) => button.addEventListener('click', () => selectKidMode(button.dataset.kidModeChoice)));
    document.querySelectorAll('[data-kid-prompt]').forEach((button) => button.addEventListener('click', () => {
      selectKidMode(button.dataset.kidPromptMode);
      const input = document.getElementById('kidHelpInput');
      input.value = button.dataset.kidPrompt;
      input.focus();
    }));
    bindRecorder(document.getElementById('kidHelpMic'), (text) => askForHelp(text, 'voice'), 'kid');
    // The door only appears once the pack is known to have clips, so an empty
    // library never advertises a room with nothing in it.
    try {
      const catalog = await api('/api/voice-personas/sounds');
      if (catalog.sounds.length) {
        document.getElementById('kidSoundDoorCount').textContent = `${catalog.sounds.length} sounds to discover`;
        document.getElementById('kidSoundDoor').hidden = false;
      }
    } catch (_error) { /* no door, the room still works */ }
  }

  function kidSoundsTemplate() {
    return `<section class="kids-room"><div class="kids-shell"><header class="kids-header"><div><p class="eyebrow">Sound wall · animals and imagination</p><h1>Tap an animal to hear it</h1><p class="lede">Discover animal calls and a T-Rex sound effect! Imitations and sound effects are marked. Nestor plays the same sounds when you ask for them.</p></div><a class="button" href="/kids">← Back</a></header><div id="kidSoundWall" class="sound-wall" role="group" aria-label="Animal sounds"></div><div id="kidSoundsEmpty" class="empty" hidden>No sounds are installed yet.</div><p class="muted sound-credits"><a href="/assets/household/sounds/CREDITS.md" target="_blank" rel="noopener">Sound sources, authors and licenses</a></p></div></section>`;
  }

  // The wall plays from the same catalog the turn selects from, so a tap can
  // never produce a clip Nestor would not have chosen itself.
  async function loadKidSounds() {
    app.innerHTML = kidSoundsTemplate();
    const wall = document.getElementById('kidSoundWall');
    try {
      const catalog = await api('/api/voice-personas/sounds');
      const byId = new Map(catalog.sounds.map((sound) => [sound.id, sound]));
      const labelOf = (sound) => sound.label.en.replace(/^(?:a|an|the)\s+/i, '');
      const alphabet = new Intl.Collator('en', { sensitivity: 'base', ignorePunctuation: true });
      const sortedSounds = [...catalog.sounds].sort((a, b) => alphabet.compare(labelOf(a), labelOf(b)));
      wall.innerHTML = sortedSounds.map((sound) => `<button type="button" class="sound-tile" data-sound-id="${esc(sound.id)}"><span aria-hidden="true">${esc(sound.emoji)}</span><small>${esc(labelOf(sound))}</small></button>`).join('');
      wall.addEventListener('click', (event) => {
        const tile = event.target.closest('[data-sound-id]');
        if (tile) playSound(byId.get(tile.dataset.soundId), { afterSpeech: false });
      });
      document.getElementById('kidSoundsEmpty').hidden = Boolean(catalog.sounds.length);
      setRuntime(true, `${catalog.sounds.length} sounds ready`);
    } catch (error) {
      document.getElementById('kidSoundsEmpty').hidden = false;
      setRuntime(false, 'sounds unavailable');
    }
  }

  function readerTemplate() {
    return `<section class="reader"><div class="reader-shell"><div class="reader-face" aria-hidden="true">☺</div><p class="eyebrow">KidX Reader · Nestor</p><h1>Which word do you want to understand?</h1>${voiceBar('reader')}<div id="readerReply" class="reader-reply" role="status" aria-live="polite">Press the mic or type your word.</div><p id="readerHeard" class="muted reader-heard" aria-live="polite"></p><form id="readerForm" class="reader-controls"><button id="readerMic" class="mic" type="button" data-stop-label="■ Done" aria-label="Record a word">● Talk</button><input id="readerInput" maxlength="180" autocomplete="off" placeholder="type your word or sentence…" aria-label="Word or phrase"><button class="primary">Ask</button></form><div class="row" style="justify-content:center;margin-top:1rem"><button id="readerReplay" type="button" disabled>Hear again</button><a class="button" href="/panel">Home</a></div></div></section>`;
  }

  async function loadReader() {
    app.innerHTML = readerTemplate();
    setRuntime(true, 'reader ready');
    let lastReply = '';
    async function ask(text, channel = 'text') {
      const reply = document.getElementById('readerReply');
      const heard = document.getElementById('readerHeard');
      // Always show what reached Nestor so a parent can tell a hearing problem from a thinking problem.
      heard.textContent = channel === 'voice' ? `Heard: “${text}”` : `You typed: “${text}”`;
      reply.textContent = 'Thinking…';
      try {
        const result = await turn('kidx_reader', text, channel);
        lastReply = result.reply;
        reply.textContent = lastReply;
        document.getElementById('readerReplay').disabled = false;
        await speak(lastReply, 'fr');
        showSoundChip(reply, result.data.sound);
        await playSound(result.data.sound);
      } catch (error) { reply.textContent = `Try again? ${error.message}`; }
    }
    document.getElementById('readerForm').addEventListener('submit', async (event) => { event.preventDefault(); const input = document.getElementById('readerInput'); const text = input.value.trim(); if (!text) return; input.value = ''; await ask(text); });
    document.getElementById('readerReplay').addEventListener('click', () => speak(lastReply, 'fr'));
    bindRecorder(document.getElementById('readerMic'), (text) => ask(text, 'voice'), 'reader');
  }

  async function loadParents() {
    return window.HouseholdParents.load({ app, api, esc, setRuntime, toast });
  }

  async function loadPersonas() {
    app.innerHTML = `<section class="hero"><div class="hero-copy"><p class="eyebrow">Private extension</p><h1>Voice personas.</h1><p class="lede">Versioned household roles with scoped memory, bounded audit previews and deterministic child-safety escalation.</p></div><aside class="hero-copy hero-status"><span id="personaSession" class="pill">no session</span><span class="muted">Mongo-owned private state</span></aside></section><section class="toolbar"><label><span>Persona</span><select id="pack"></select></label><label><span>Mode</span><select id="mode"></select></label><label><span>Scope</span><input id="scope" value="personal"></label><button id="newSession" class="primary">New session</button></section><section class="two-col"><article class="card full chat">${voiceBar('persona')}<div id="personaTranscript" class="transcript"><div class="message system">Choose a persona and start a session.</div></div><form id="personaForm" class="composer"><button id="personaMic" class="mic" type="button" data-stop-label="■ Stop" aria-label="Record voice">● Talk</button><input id="personaInput" placeholder="Type a turn…"><button class="primary">Send</button></form></article><aside class="side"><article class="card full"><h2>Scoped memory</h2><form id="memoryForm" class="stack"><input id="memoryTopic" value="general" placeholder="topic"><textarea id="memoryText" placeholder="Save a private fact…"></textarea><button>Save memory</button></form><form id="memorySearch" class="row" style="margin-top:.7rem"><input id="memoryQuery" placeholder="Search memory"><button>Find</button></form><div id="memoryResults" class="stack"></div></article><article class="card full"><h2>Recent audit</h2><p id="personaHistoryPolicy" class="muted"></p><div id="personaAudit" class="stack"></div></article></aside></section>`;
    const packData = await api('/api/voice-personas/packs');
    state.packs = packData.packs;
    const packSelect = document.getElementById('pack');
    packSelect.innerHTML = state.packs.map((pack) => `<option value="${esc(pack.id)}">${esc(pack.name)}</option>`).join('');
    function renderModes() {
      const pack = state.packs.find((item) => item.id === packSelect.value);
      document.getElementById('mode').innerHTML = pack.modes.map((mode) => `<option value="${esc(mode.id)}">${esc(mode.label)}</option>`).join('');
      document.getElementById('scope').value = pack.defaultScopeId;
      document.getElementById('personaHistoryPolicy').textContent = `Conversation context: up to ${pack.history.maximumMessages} recent messages, with their full text.`;
    }
    renderModes(); packSelect.addEventListener('change', renderModes);
    async function create() {
      state.session = null; state.history = [];
      await ensureSession(packSelect.value, document.getElementById('scope').value, document.getElementById('mode').value);
      document.getElementById('personaSession').textContent = `${state.session.packId} · ${state.session.sessionId.slice(0,8)}`;
      document.getElementById('personaTranscript').innerHTML = '<div class="message system">Session ready.</div>';
      await refreshAudit();
    }
    async function send(text, channel = 'text') {
      if (!state.session) await create();
      const transcript = document.getElementById('personaTranscript');
      transcript.insertAdjacentHTML('beforeend', `<div class="message user">${esc(text)}</div><div class="message assistant pending">Thinking…</div>`);
      const pending = transcript.querySelector('.pending:last-child');
      try { const result = await turn(packSelect.value, text, channel, { scopeId: document.getElementById('scope').value, modeId: document.getElementById('mode').value }); pending.textContent = result.reply; }
      catch (error) { pending.textContent = error.message; }
      await refreshAudit(); transcript.scrollTop = transcript.scrollHeight;
    }
    async function refreshAudit() {
      const query = new URLSearchParams({ packId: packSelect.value, scopeId: document.getElementById('scope').value, limit: '8' });
      const data = await api(`/api/voice-personas/audit/recent?${query}`);
      document.getElementById('personaAudit').innerHTML = data.audit.length ? data.audit.map((row) => `<div class="audit"><strong>${esc(row.inputText)}</strong><small>${esc(row.replyText)} · ${esc(row.model || 'deterministic')}</small></div>`).join('') : '<div class="empty">No turns.</div>';
    }
    document.getElementById('newSession').addEventListener('click', create);
    document.getElementById('personaForm').addEventListener('submit', async (event) => { event.preventDefault(); const input = document.getElementById('personaInput'); const text = input.value.trim(); if (!text) return; input.value = ''; await send(text); });
    bindRecorder(document.getElementById('personaMic'), (text) => send(text, 'voice'), 'persona');
    document.getElementById('memoryForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/voice-personas/memory', { method: 'POST', body: JSON.stringify({ packId: packSelect.value, scopeId: document.getElementById('scope').value, topic: document.getElementById('memoryTopic').value, text: document.getElementById('memoryText').value }) }); document.getElementById('memoryText').value = ''; toast('Memory saved'); } catch (error) { toast(error.message); } });
    document.getElementById('memorySearch').addEventListener('submit', async (event) => { event.preventDefault(); try { const data = await api('/api/voice-personas/memory/search', { method: 'POST', body: JSON.stringify({ packId: packSelect.value, scopeId: document.getElementById('scope').value, query: document.getElementById('memoryQuery').value }) }); document.getElementById('memoryResults').innerHTML = data.memory.results.map((row) => `<div class="memory"><strong>${esc(row.topic)}</strong><div>${esc(row.text)}</div></div>`).join('') || '<div class="empty">No matches.</div>'; } catch (error) { toast(error.message); } });
    setRuntime(true, 'personas ready');
  }

  async function start() {
    navActive(); app.innerHTML = '<div class="empty" role="status">Loading…</div>';
    try {
      if (location.pathname === '/panel') return await loadPanel();
      if (['/dad/memories', '/voice-personas', '/voice-personas.html'].includes(location.pathname)) return await loadMemories();
      if (location.pathname === '/dad/family') return await loadParents();
      if (location.pathname === '/dad/day') return await loadDad();
      if (location.pathname === '/dad') return await window.mountConversation({ app, api, esc, space: 'personal' });
      if (location.pathname === '/kids/sounds') return await loadKidSounds();
      if (location.pathname.startsWith('/kids')) return await loadKids();
      if (location.pathname === '/lecture') return await loadReader();
      if (location.pathname.startsWith('/lecture/parents')) return await loadParents();
      if (location.pathname === '/voice-personas/debug') return await loadPersonas();
      if (['/voice', '/voice.html', '/voix'].includes(location.pathname)) return await window.mountConversation({ app, api, esc });
      if (location.pathname === '/device-check') return await window.HouseholdDeviceCheck.load({ app, esc, state, api, toast, transcribe, stopPlayback, setRuntime });
      app.innerHTML = '<div class="empty">Page not found.</div>';
    } catch (error) {
      console.error('Household page initialization failed', error); setRuntime(false, 'unavailable');
      app.innerHTML = '<article class="card full danger-box"><h1>This page is temporarily unavailable.</h1><p>Try again in a moment.</p><button type="button" id="householdRetry">Try again</button></article>'; document.getElementById('householdRetry').onclick = () => location.reload();
    } finally {
      if (['/dad', '/dad/day', '/dad/memories', '/dad/family', '/panel', '/kids', '/kids/sounds', '/lecture'].includes(location.pathname)) {
        window.HouseholdNavigation.mount(app, location.pathname);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
