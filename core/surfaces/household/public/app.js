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
    const status = document.getElementById('readingVoiceStatus'); status.textContent = 'Chargement des voix locales…';
    try {
      const catalog = await api('/api/voix/catalog');
      for (const [language, select] of Object.entries(readingSelects)) {
        select.length = 1;
        for (const provider of catalog.providers || []) {
          const group = document.createElement('optgroup'); group.label = provider.name;
          for (const voice of window.VoixAudio.choices(catalog, language, provider.id)) {
            const option = new Option(`${voice.name} · ${voice.locale}${voice.available ? '' : ' · indisponible'}`, window.VoixAudio.voiceKey(voice));
            option.disabled = !voice.available; group.append(option);
          }
          if (group.children.length) select.append(group);
        }
        const saved = readingVoices[language] || '';
        if (saved && ![...select.options].some(option => option.value === saved)) {
          const option = new Option(`Voix enregistrée indisponible : ${saved.split('|')[1]}`, saved); option.disabled = true; select.append(option);
        }
        select.value = saved;
      }
      status.textContent = 'L’aperçu utilise le haut-parleur de ce navigateur.';
      document.getElementById('readingVoiceSave').disabled = false;
      document.getElementById('readingVoicePreview').disabled = false;
    } catch { status.textContent = 'Le catalogue local est indisponible. Les choix enregistrés sont conservés.'; }
  };
  document.getElementById('readingVoiceSave').onclick = () => {
    readingVoices = window.PersonaPresentation.selections(Object.fromEntries(Object.entries(readingSelects).map(([language, select]) => [language, select.value])));
    try { localStorage.setItem(readingVoiceKey, JSON.stringify(readingVoices)); document.getElementById('readingVoiceStatus').textContent = 'Voix enregistrées sur ce navigateur.'; }
    catch { document.getElementById('readingVoiceStatus').textContent = 'Choix actifs pour cet onglet. Le navigateur refuse l’enregistrement.'; }
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
    window.AgentXAccess?.assertCurrent();
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
    if (node) node.textContent = new Intl.DateTimeFormat('fr-CA', { hour: '2-digit', minute: '2-digit' }).format(new Date());
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
    return `<div class="voice-bar" aria-label="Voice privacy controls"><span id="${prefix}VoiceState" class="voice-state" data-state="checking" role="status" aria-live="polite">Push-to-talk · checking microphone…</span><div class="voice-toggles"><button id="${prefix}MicToggle" class="compact" type="button" aria-pressed="false">Micro actif</button><button id="${prefix}SoundToggle" class="compact" type="button" aria-pressed="false">Son actif</button></div></div>`;
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
  function showSoundChip(node, sound, language = 'fr') {
    if (!node) return;
    node.querySelectorAll('[data-sound-chip]').forEach((chip) => chip.remove());
    if (!sound || !sound.url) return;
    const english = language === 'en';
    const label = english ? sound.label.en : sound.label.fr;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sound-chip';
    chip.dataset.soundChip = sound.id;
    chip.innerHTML = `<span aria-hidden="true">${esc(sound.emoji)}</span><span>${esc(english ? `Hear ${label} again` : `Réécoute ${label}`)}</span>`;
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
        setVoiceStatus(prefix, 'muted', 'Micro coupé · aucune capture possible');
      } else if (!window.isSecureContext) {
        button.disabled = true;
        button.title = 'Microphone requires trusted HTTPS';
        setVoiceStatus(prefix, 'unavailable', 'Texte prêt · ouvre le lien HTTPS de confiance pour parler');
      } else if (!supported) {
        button.disabled = true;
        button.title = 'Microphone capture is unavailable in this browser';
        setVoiceStatus(prefix, 'unavailable', 'Micro indisponible · utilise le clavier');
      } else {
        button.disabled = false;
        button.title = 'Push to talk. Nothing listens until you press.';
        setVoiceStatus(prefix, 'ready', 'Micro prêt · appuie pour parler · jamais en écoute continue');
      }
    }

    if (micToggle) {
      micToggle.addEventListener('click', () => {
        state.micMuted = !state.micMuted;
        micToggle.setAttribute('aria-pressed', String(state.micMuted));
        micToggle.textContent = state.micMuted ? 'Micro coupé' : 'Micro actif';
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
        soundToggle.textContent = state.outputMuted ? 'Son coupé' : 'Son actif';
        if (state.outputMuted) stopPlayback();
      });
    }
    ready();

    button.addEventListener('click', async () => {
      if (state.recording) {
        if (state.recording.button !== button) return;
        setVoiceStatus(prefix, 'stopping', 'Capture terminée · préparation…');
        if (state.recording.recorder.state !== 'inactive') state.recording.recorder.stop();
        return;
      }
      if (state.micMuted || !supported) return;
      try {
        setVoiceStatus(prefix, 'permission', 'Autorise le micro pour ce tour seulement…');
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
            setVoiceStatus(prefix, 'transcribing', 'Transcription locale…');
            const text = await transcribe(new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' }));
            if (!text) throw new Error('Aucun mot entendu. Réessaie ou utilise le clavier.');
            setVoiceStatus(prefix, 'thinking', 'Nestor prépare sa réponse…');
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
        setVoiceStatus(prefix, 'listening', 'Micro actif · appuie encore pour terminer');
      } catch (error) {
        setVoiceStatus(prefix, 'error', 'Micro refusé · utilise le clavier ou change la permission');
        toast(error.message);
      }
    });
  }

  async function loadPanel() {
    await window.mountConversation({ app, api, esc, space: 'family' });
    app.insertAdjacentHTML('beforeend', `<section class="ecosystem-primary household-spaces" aria-label="Activités en famille"><a class="ecosystem-primary-link" href="/kids"><span class="ecosystem-primary-index">01</span><span><small>Enfants</small><strong>Apprendre & participer</strong><span>Les activités et les responsabilités de la maison.</span></span></a><a class="ecosystem-primary-link" href="/lecture"><span class="ecosystem-primary-index">02</span><span><small>Lecture</small><strong>Lire ensemble</strong><span>Découvrir un texte avec Nestor.</span></span></a></section>`);
  }

  async function loadMemories() {
    app.innerHTML = `<section class="home-heading"><p class="eyebrow">Super Dad · privé</p><h1>Mes souvenirs.</h1><p class="lede">Les faits, préférences et décisions que tu demandes à ton agent de retenir.</p></section><section class="memory-page"><details id="selectedNotes"></details><details id="memoryEvidence" hidden></details><details><summary>Souvenirs précédents</summary><p>Les notes conservées dans le carnet Household restent consultables ici.</p><button id="legacyNotesLoad" type="button">Consulter les anciennes notes</button><div id="legacyNotesList"></div></details></section>`;
    window.mountPersonalNotes({ host: document.getElementById('selectedNotes'), evidence: document.getElementById('memoryEvidence'), api, esc });
    document.getElementById('selectedNotes').open = true;
    document.getElementById('legacyNotesLoad').onclick = async () => {
      const host = document.getElementById('legacyNotesList'); host.textContent = 'Chargement…';
      try {
        const result = await api('/api/voice-personas/memory/search', { method: 'POST', body: JSON.stringify({ packId: 'personal_operator', scopeId: 'personal', query: '' }) });
        host.innerHTML = result.memory.results.map(note => `<article class="personal-note"><p>${esc(note.text)}</p><small>Ancien carnet · ${esc(note.topic)}</small></article>`).join('') || '<p>Aucune ancienne note.</p>';
      } catch { host.textContent = 'Les anciennes notes sont indisponibles pour le moment.'; }
    };
    setRuntime(true, 'page prête');
  }

  // Ma journée lives in dad-day.js; it borrows the shared helpers.
  async function loadDad() {
    return window.HouseholdDadDay.load({ app, api, esc, toast, setRuntime, speak, clock });
  }

  function kidsTemplate() {
    return `<section class="kids-room"><div class="kids-shell"><a id="kidSoundDoor" class="kids-sound-door" href="/kids/sounds" hidden><span class="kids-sound-door-mark" aria-hidden="true">🔊</span><span><strong>Mur des sons</strong><small id="kidSoundDoorCount">sons à découvrir</small></span></a><header class="kids-header"><div><p class="eyebrow">Coin des enfants · revu par papa · IA locale · sans outils</p><h1>Une chose à la fois.</h1><p class="lede">Pose une question, apprends, pratique ou trouve une petite étape sécuritaire. Pas besoin de profil; papa approuve chaque tâche cochée.</p></div><label class="kids-profile"><span>Qui es-tu? (facultatif)</span><select id="kidProfile" aria-label="Profil de la famille (facultatif)"><option value="">Invité</option></select></label></header><div id="kidsEmpty" class="kids-welcome" hidden><div><p class="card-kicker">Prêt tout de suite</p><h2>Tu peux poser tes questions.</h2><p>Pas besoin de nom pour parler à Nestor ou utiliser la Lecture. Un profil sert seulement à tes responsabilités à la maison.</p></div><div class="row wrap"><a class="button primary" href="/lecture">Ouvrir la Lecture</a><a class="button" href="/dad/family">Papa : ajouter profils et tâches</a></div></div><section id="kidsContent" class="kids-grid" hidden><article id="kidNextCard" class="next-chore"><p class="card-kicker">Qu’est-ce que je fais maintenant?</p><div id="kidNext"></div></article><aside id="kidProgressCard" class="kids-progress"><p class="card-kicker">Aujourd’hui</p><div id="kidProgress"></div></aside><article class="kids-help"><div class="row"><div class="grow"><p class="card-kicker">Nestor t’aide à apprendre</p><h2>Comment je peux t’aider?</h2></div><a class="button compact" href="/lecture">Ouvrir la Lecture</a></div><div class="kid-ai-boundary" role="note"><strong>Nestor est une IA, pas une personne.</strong><span>Il peut se tromper. Ne donne pas d’informations privées. Un parent peut relire cette conversation. Vérifie les choses importantes avec un adulte de confiance.</span></div><div class="kid-mode-grid" aria-label="Choisis comment Nestor t’aide"><button type="button" class="kid-mode active" data-kid-mode-choice="family" data-description="Une réponse courte et claire, et une façon de la vérifier." aria-pressed="true"><strong>Demander</strong><small>Une réponse claire</small></button><button type="button" class="kid-mode" data-kid-mode-choice="learn" data-description="Comprendre une idée avec un exemple et une question pour vérifier." aria-pressed="false"><strong>Apprendre</strong><small>Expliquer + vérifier</small></button><button type="button" class="kid-mode" data-kid-mode-choice="steps" data-description="Découper une tâche sécuritaire en petites étapes, une à la fois." aria-pressed="false"><strong>Étapes</strong><small>Commencer petit</small></button><button type="button" class="kid-mode" data-kid-mode-choice="practice" data-description="Une question à la fois, avec une correction douce." aria-pressed="false"><strong>Pratiquer</strong><small>Un essai à la fois</small></button><button type="button" class="kid-mode" data-kid-mode-choice="mission" data-description="De l’aide pour une responsabilité déjà approuvée par un parent." aria-pressed="false"><strong>Mission maison</strong><small>Tâches approuvées</small></button></div><p id="kidModeDescription" class="kid-mode-description">Une réponse courte et claire, et une façon de la vérifier.</p><div class="kid-starters" aria-label="Idées de questions"><button type="button" data-kid-prompt-mode="learn" data-kid-prompt="Pourquoi les feuilles changent-elles de couleur? Aide-moi à comprendre.">Apprendre quelque chose</button><button type="button" data-kid-prompt-mode="steps" data-kid-prompt="Aide-moi à commencer une tâche sécuritaire, une petite étape à la fois.">Commencer prudemment</button><button type="button" data-kid-prompt-mode="practice" data-kid-prompt="Fais-moi pratiquer avec une question à la fois.">Pratiquer</button><button type="button" data-kid-prompt-mode="mission" data-kid-prompt="Aide-moi avec une responsabilité que mon parent a déjà approuvée.">Mission maison</button></div>${voiceBar('kid')}<div id="kidHelpReply" class="reader-reply small" role="status" aria-live="polite">Je peux t’aider à réfléchir et à apprendre. Je ne peux pas utiliser d’outils, contrôler la maison ou approuver une tâche.</div><form id="kidHelpForm" class="reader-controls"><button id="kidHelpMic" class="mic" type="button" data-stop-label="■ Arrêter" aria-label="Demander à voix haute">● Parler</button><input id="kidHelpInput" maxlength="300" autocomplete="off" placeholder="Avec quoi veux-tu de l’aide?" aria-label="Demander de l’aide à Nestor"><button class="primary">Demander</button></form></article></section></div></section>`;
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
      document.getElementById('kidHelpReply').textContent = `Mode ${choice.querySelector('strong').textContent} prêt. Avec quoi veux-tu de l’aide?`;
    }
    async function refreshRoom() {
      const profileId = profileSelect.value;
      if (!profileId) return;
      try {
        const data = await api(`/api/family/room?profileId=${encodeURIComponent(profileId)}`);
        currentRoom = data.room;
        const next = data.room.next;
        document.getElementById('kidNext').innerHTML = next
          ? `<div class="kid-chore-title"><span class="kid-avatar">${esc(data.profile.avatar)}</span><div><h2>${esc(next.title)}</h2><p>${esc(next.note || 'Tu sais quoi faire. Demande à Nestor si tu veux de l’aide.')}</p></div></div><div class="kid-chore-meta"><span>${'★'.repeat(next.stars)}</span><span>${esc(next.cadence === 'once' ? 'une fois' : `chaque ${next.cadence === 'daily' ? 'jour' : 'semaine'}`)}</span>${next.overdue ? '<span class="danger-box">en retard</span>' : next.dueToday ? '<span class="warning">pour aujourd’hui</span>' : ''}</div><button id="kidCheckIn" class="primary kid-done" data-ref="${esc(next.id)}">C’est fait!</button>`
          : `<div class="kid-clear"><span>✓</span><h2>${data.room.waiting.length ? 'Tout est coché.' : 'Tout est fait!'}</h2><p>${data.room.waiting.length ? 'Papa va vérifier ce que tu as coché.' : 'Va jouer, lire, créer ou aider quelqu’un.'}</p></div>`;
        const upcoming = data.room.available.slice(next ? 1 : 0, 4);
        document.getElementById('kidProgress').innerHTML = `<div class="kid-score"><strong>${data.room.completedToday}</strong><span>approuvées aujourd’hui</span></div><div class="kid-score"><strong>${data.room.waiting.length}</strong><span>en attente de papa</span></div>${upcoming.length ? `<div class="kid-upcoming"><small>Plus tard</small>${upcoming.map((task) => `<span>${esc(task.title)}</span>`).join('')}</div>` : ''}`;
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
        : '<option value="">Invité</option>';
      document.getElementById('kidsEmpty').hidden = hasProfiles;
      document.getElementById('kidsContent').hidden = false;
      document.getElementById('kidNextCard').hidden = !hasProfiles;
      document.getElementById('kidProgressCard').hidden = !hasProfiles;
      profileSelect.disabled = !hasProfiles;
      if (hasProfiles) await refreshRoom(); else setRuntime(true, 'safe chat ready');
    } catch (error) {
      document.getElementById('kidsEmpty').hidden = false;
      document.getElementById('kidsEmpty').innerHTML = `<div><p class="card-kicker">Profils indisponibles</p><h2>L’aide reste disponible.</h2><p>${esc(error.message)}</p></div><a class="button primary" href="/lecture">Ouvrir la Lecture</a>`;
      document.getElementById('kidsContent').hidden = false;
      document.getElementById('kidNextCard').hidden = true;
      document.getElementById('kidProgressCard').hidden = true;
      profileSelect.disabled = true;
      setRuntime(false, 'profiles unavailable · safe chat ready');
    }
    profileSelect.addEventListener('change', refreshRoom);
    async function askForHelp(text, channel = 'text') {
      const reply = document.getElementById('kidHelpReply');
      reply.textContent = 'Je réfléchis…';
      const chore = activeKidMode === 'mission' ? currentRoom?.next?.title : '';
      try {
        const result = await turn('kidx_nestor', `${chore ? `Responsabilité gérée par le parent dans Kids Room : « ${chore} ». ` : ''}${text}`, channel, { modeId: activeKidMode });
        reply.textContent = result.reply;
        const language = replyLanguage(result);
        await speak(result.reply, language);
        showSoundChip(reply, result.data.sound, language);
        await playSound(result.data.sound);
      } catch (error) { reply.textContent = `On réessaie? ${error.message}`; }
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
        document.getElementById('kidSoundDoorCount').textContent = `${catalog.sounds.length} sons à découvrir`;
        document.getElementById('kidSoundDoor').hidden = false;
      }
    } catch (_error) { /* no door, the room still works */ }
  }

  function kidSoundsTemplate() {
    return `<section class="kids-room"><div class="kids-shell"><header class="kids-header"><div><p class="eyebrow">Mur des sons · animaux et imagination</p><h1>Touche un animal pour l’entendre</h1><p class="lede">Découvre les cris des animaux et un bruitage de T-Rex ! Les imitations et les bruitages sont indiqués. Nestor joue les mêmes sons quand tu les lui demandes.</p></div><a class="button" href="/kids">← Retour</a></header><div id="kidSoundWall" class="sound-wall" role="group" aria-label="Sons d’animaux"></div><div id="kidSoundsEmpty" class="empty" hidden>Aucun son n’est installé pour l’instant.</div><p class="muted sound-credits"><a href="/assets/household/sounds/CREDITS.md" target="_blank" rel="noopener">Sources, auteurs et licences des sons</a></p></div></section>`;
  }

  // The wall plays from the same catalog the turn selects from, so a tap can
  // never produce a clip Nestor would not have chosen itself.
  async function loadKidSounds() {
    app.innerHTML = kidSoundsTemplate();
    const wall = document.getElementById('kidSoundWall');
    try {
      const catalog = await api('/api/voice-personas/sounds');
      const byId = new Map(catalog.sounds.map((sound) => [sound.id, sound]));
      const labelOf = (sound) => sound.label.fr.replace(/^(?:un|une|des)\s+/, '');
      const alphabet = new Intl.Collator('fr', { sensitivity: 'base', ignorePunctuation: true });
      const sortedSounds = [...catalog.sounds].sort((a, b) => alphabet.compare(labelOf(a), labelOf(b)));
      wall.innerHTML = sortedSounds.map((sound) => `<button type="button" class="sound-tile" data-sound-id="${esc(sound.id)}"><span aria-hidden="true">${esc(sound.emoji)}</span><small>${esc(labelOf(sound))}</small></button>`).join('');
      wall.addEventListener('click', (event) => {
        const tile = event.target.closest('[data-sound-id]');
        if (tile) playSound(byId.get(tile.dataset.soundId), { afterSpeech: false });
      });
      document.getElementById('kidSoundsEmpty').hidden = Boolean(catalog.sounds.length);
      setRuntime(true, `${catalog.sounds.length} sons prêts`);
    } catch (error) {
      document.getElementById('kidSoundsEmpty').hidden = false;
      setRuntime(false, 'sons indisponibles');
    }
  }

  function readerTemplate() {
    return `<section class="reader"><div class="reader-shell"><div class="reader-face" aria-hidden="true">☺</div><p class="eyebrow">KidX Reader · Nestor</p><h1>Quel mot veux-tu comprendre?</h1>${voiceBar('reader')}<div id="readerReply" class="reader-reply" role="status" aria-live="polite">Appuie sur le micro ou écris ton mot.</div><p id="readerHeard" class="muted reader-heard" aria-live="polite"></p><form id="readerForm" class="reader-controls"><button id="readerMic" class="mic" type="button" data-stop-label="■ Termine" aria-label="Record a word">● Parle</button><input id="readerInput" maxlength="180" autocomplete="off" placeholder="écris ton mot ou ta phrase…" aria-label="Word or phrase"><button class="primary">Demande</button></form><div class="row" style="justify-content:center;margin-top:1rem"><button id="readerReplay" type="button" disabled>Réécoute</button><a class="button" href="/panel">Maison</a></div></div></section>`;
  }

  async function loadReader() {
    app.innerHTML = readerTemplate();
    setRuntime(true, 'reader ready');
    let lastReply = '';
    async function ask(text, channel = 'text') {
      const reply = document.getElementById('readerReply');
      const heard = document.getElementById('readerHeard');
      // Always show what reached Nestor so a parent can tell a hearing problem from a thinking problem.
      heard.textContent = channel === 'voice' ? `J'ai entendu : « ${text} »` : `Tu as écrit : « ${text} »`;
      reply.textContent = 'Je réfléchis…';
      try {
        const result = await turn('kidx_reader', text, channel);
        lastReply = result.reply;
        reply.textContent = lastReply;
        document.getElementById('readerReplay').disabled = false;
        await speak(lastReply, 'fr');
        showSoundChip(reply, result.data.sound, 'fr');
        await playSound(result.data.sound);
      } catch (error) { reply.textContent = `On réessaie? ${error.message}`; }
    }
    document.getElementById('readerForm').addEventListener('submit', async (event) => { event.preventDefault(); const input = document.getElementById('readerInput'); const text = input.value.trim(); if (!text) return; input.value = ''; await ask(text); });
    document.getElementById('readerReplay').addEventListener('click', () => speak(lastReply, 'fr'));
    bindRecorder(document.getElementById('readerMic'), (text) => ask(text, 'voice'), 'reader');
  }

  async function loadParents() {
    app.innerHTML = `<section class="hero"><div class="hero-copy"><p class="eyebrow">Famille</p><h1>Espace parents</h1><p class="lede">Profils, tâches et échanges avec Nestor.</p></div><aside class="hero-copy hero-status"><span id="parentSummary" class="clock">0</span><span class="muted">tâches actives</span></aside></section><section class="parent-grid"><article id="familyLaunchCard" class="card full family-launch"><div class="row"><div class="grow"><p class="card-kicker">First family launch · explicit setup</p><h2>Open Kids Room with a real rhythm</h2><p class="muted">Name the first profile, edit or uncheck every suggestion, then create the profile and selected routines together. Nothing is created until you press Launch.</p></div><span class="pill">private</span></div><form id="familyLaunchForm" class="stack"><div class="parent-profile-form"><label><span>Name shown at home</span><input id="launchProfileName" maxlength="80" required placeholder="Kid name"></label><label><span>Avatar</span><input id="launchProfileAvatar" maxlength="8" value="⭐" aria-label="Starter profile avatar"></label><label><span>Age band</span><select id="launchProfileAge"><option value="little">Little</option><option value="school" selected>School age</option><option value="teen">Teen</option></select></label></div><fieldset class="launch-routines"><legend>Editable starter routines · choose 1–5</legend><div class="launch-routine"><input type="checkbox" checked aria-label="Include first starter routine"><input data-launch-title maxlength="160" value="Remettre tes choses à leur place" aria-label="First routine title"><select data-launch-cadence aria-label="First routine cadence"><option value="daily" selected>Daily</option><option value="weekly">Weekly</option><option value="once">One time</option></select><select data-launch-stars aria-label="First routine stars"><option>1</option><option selected>2</option><option>3</option><option>4</option><option>5</option></select><input class="launch-note" data-launch-note maxlength="1000" value="Commence par ce que tu as utilisé en dernier." aria-label="First routine hint"></div><div class="launch-routine"><input type="checkbox" checked aria-label="Include second starter routine"><input data-launch-title maxlength="160" value="Préparer tes choses pour demain" aria-label="Second routine title"><select data-launch-cadence aria-label="Second routine cadence"><option value="daily" selected>Daily</option><option value="weekly">Weekly</option><option value="once">One time</option></select><select data-launch-stars aria-label="Second routine stars"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select><input class="launch-note" data-launch-note maxlength="1000" value="Sac, vêtements ou tout ce dont tu auras besoin." aria-label="Second routine hint"></div><div class="launch-routine"><input type="checkbox" checked aria-label="Include third starter routine"><input data-launch-title maxlength="160" value="Aider à ranger un espace commun" aria-label="Third routine title"><select data-launch-cadence aria-label="Third routine cadence"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="once">One time</option></select><select data-launch-stars aria-label="Third routine stars"><option>1</option><option>2</option><option>3</option><option selected>4</option><option>5</option></select><input class="launch-note" data-launch-note maxlength="1000" value="Demande à papa quel espace a besoin d’aide." aria-label="Third routine hint"></div></fieldset><div class="row wrap"><button id="familyLaunchButton" class="primary">Launch profile + selected routines</button><a class="button" href="/kids">Preview safe guest room</a></div></form></article><article class="card full"><h2>Profils des enfants</h2><form id="profileForm" class="parent-profile-form"><label><span>Name shown at home</span><input id="profileName" maxlength="80" required placeholder="Kid name"></label><label><span>Avatar</span><input id="profileAvatar" maxlength="8" value="⭐" aria-label="Profile avatar"></label><label><span>Age band</span><select id="profileAge"><option value="little">Little</option><option value="school" selected>School age</option><option value="teen">Teen</option></select></label><button class="primary">Add profile</button></form><div id="profiles" class="profile-list"></div></article><article class="card full"><h2>Tâches</h2><form id="choreForm" class="parent-chore-form"><label><span>For</span><select id="choreProfile" required></select></label><label class="wide-field"><span>What needs doing?</span><input id="choreTitle" maxlength="160" required placeholder="Put school bag by the door"></label><label><span>When</span><input id="choreDue" type="date"></label><label><span>Repeats</span><select id="choreCadence"><option value="once">One time</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label><label><span>Stars</span><select id="choreStars"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label><label class="wide-field"><span>Helpful note</span><input id="choreNote" maxlength="1000" placeholder="A short, concrete hint"></label><button class="primary">Add to Kids Room</button></form><div id="choreSetupEmpty" class="empty" hidden>Create a profile before adding responsibilities.</div><div id="chores" class="stack"></div></article><article class="card full"><div class="row"><div class="grow"><h2>Échanges avec Nestor</h2><p class="muted">Questions et réponses des espaces Famille, Enfants et Lecture.</p></div><span id="journalCount" class="pill">0 recent turns</span><button id="refreshJournal">Refresh</button></div><div id="journal" class="stack"></div></article></section>`;
    document.getElementById('refreshJournal').parentElement.classList.add('wrap', 'journal-toolbar');
    document.getElementById('journalCount').insertAdjacentHTML('beforebegin', '<div class="row wrap journal-filters" role="group" aria-label="Journal view"><button type="button" class="compact journal-filter" data-journal-view="recent" aria-pressed="true">Recent</button><button type="button" class="compact journal-filter" data-journal-view="safety" aria-pressed="false">Safety</button><button type="button" class="compact journal-filter" data-journal-view="all" aria-pressed="false">All</button></div>');
    document.getElementById('profileForm').closest('article').hidden = true;
    document.getElementById('choreForm').closest('article').hidden = true;
    let profiles = [];
    let journalRows = [];
    let journalView = 'recent';
    // Names the clip a turn offered; an unknown id still shows as its raw id
    // rather than disappearing from the parent's view.
    const soundsById = new Map();
    const journalRecentLimit = 8;
    async function refreshFamily() {
      try {
        const [profileData, choreData] = await Promise.all([api('/api/family/profiles'), api('/api/family/chores')]);
        profiles = profileData.profiles;
        const hasProfiles = profiles.length > 0;
        document.getElementById('familyLaunchCard').hidden = hasProfiles;
        if (!hasProfiles) document.getElementById('familyLaunchButton').disabled = false;
        document.getElementById('profileForm').closest('article').hidden = !hasProfiles;
        document.getElementById('choreForm').closest('article').hidden = !hasProfiles;
        document.getElementById('profiles').innerHTML = profiles.length ? profiles.map((profile) => `<div class="profile-chip"><span class="kid-avatar">${esc(profile.avatar)}</span><div class="grow"><strong>${esc(profile.displayName)}</strong><small>${esc(profile.ageBand)}</small></div><button class="compact danger archive-profile" data-id="${esc(profile.id)}">Archive</button></div>`).join('') : '<div class="empty">No profiles yet. Add the first one above.</div>';
        document.getElementById('choreProfile').innerHTML = profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.avatar)} ${esc(profile.displayName)}</option>`).join('');
        document.getElementById('choreForm').hidden = !profiles.length;
        document.getElementById('choreSetupEmpty').hidden = Boolean(profiles.length);
        const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
        document.getElementById('chores').innerHTML = choreData.chores.length ? choreData.chores.map((chore) => {
          const profile = profileMap.get(chore.profileId);
          const waiting = chore.status === 'review';
          return `<div class="parent-chore ${waiting ? 'warning' : ''}"><div class="grow"><strong>${esc(profile?.avatar || '⭐')} ${esc(chore.title)}</strong><small>${esc(profile?.displayName || chore.profileId)} · ${esc(chore.cadence)} · ${'★'.repeat(chore.stars)}${chore.dueAt ? ` · ${esc(new Date(chore.dueAt).toLocaleDateString())}` : ''}${waiting ? ' · waiting for approval' : ''}</small></div><div class="row wrap">${waiting ? `<button class="compact primary chore-action" data-action="approve" data-ref="${esc(chore.id)}">Approve</button><button class="compact chore-action" data-action="reopen" data-ref="${esc(chore.id)}">Try again</button>` : ''}<button class="compact danger chore-action" data-action="cancel" data-ref="${esc(chore.id)}">Cancel</button></div></div>`;
        }).join('') : '<div class="empty">No active family responsibilities.</div>';
        document.getElementById('parentSummary').textContent = choreData.chores.length;
        document.querySelectorAll('.archive-profile').forEach((button) => button.addEventListener('click', async () => {
          if (!window.confirm('Archive this profile? Its existing routines stay in the audit trail.')) return;
          button.disabled = true;
          try { await api('/api/family/profiles/archive', { method: 'POST', body: JSON.stringify({ profileId: button.dataset.id }) }); await refreshFamily(); }
          catch (error) { toast(error.message); button.disabled = false; }
        }));
        document.querySelectorAll('.chore-action').forEach((button) => button.addEventListener('click', async () => {
          if (button.dataset.action === 'cancel' && !window.confirm('Cancel this responsibility?')) return;
          button.disabled = true;
          try { await api(`/api/family/chores/${button.dataset.action}`, { method: 'POST', body: JSON.stringify({ ref: button.dataset.ref }) }); await refreshFamily(); }
          catch (error) { toast(error.message); button.disabled = false; }
        }));
        setRuntime(true, 'parent controls ready');
      } catch (error) {
        setRuntime(false, 'parent controls unavailable');
        document.getElementById('chores').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      }
    }
    function renderJournal() {
      const safetyRows = journalRows.filter((row) => row.parentAttention || (Array.isArray(row.safetyFlags) && row.safetyFlags.length));
      const visibleRows = journalView === 'all'
        ? journalRows
        : journalView === 'safety' ? safetyRows : journalRows.slice(0, journalRecentLimit);
      const count = journalView === 'recent'
        ? `${visibleRows.length} of ${journalRows.length} turns`
        : journalView === 'safety' ? `${visibleRows.length} safety turns` : `${visibleRows.length} turns`;
      document.getElementById('journalCount').textContent = count;
      document.querySelectorAll('.journal-filter').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.journalView === journalView));
      });
      document.getElementById('journal').innerHTML = visibleRows.length ? visibleRows.map((row) => {
        return window.JournalDisplay.row(row, { esc, sound: row.soundId ? soundsById.get(row.soundId) : null });
      }).join('') : `<div class="empty">${journalRows.length ? 'No safety-flagged child turns in this window.' : 'No child turns yet.'}</div>`;
    }
    async function refreshJournal() {
      try {
        if (!soundsById.size) {
          const catalog = await api('/api/voice-personas/sounds').catch(() => ({ sounds: [] }));
          (catalog.sounds || []).forEach((sound) => soundsById.set(sound.id, sound));
        }
        const data = await api('/api/voice-personas/audit/recent?childSafe=true&limit=80');
        journalRows = Array.isArray(data.audit) ? data.audit : [];
        renderJournal();
      } catch (error) { document.getElementById('journal').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
    }
    document.getElementById('familyLaunchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('familyLaunchButton');
      const routines = [...document.querySelectorAll('.launch-routine')]
        .filter((row) => row.querySelector('input[type="checkbox"]').checked)
        .map((row) => ({
          title: row.querySelector('[data-launch-title]').value,
          note: row.querySelector('[data-launch-note]').value,
          cadence: row.querySelector('[data-launch-cadence]').value,
          stars: Number(row.querySelector('[data-launch-stars]').value)
        }));
      if (!routines.length) { toast('Choose at least one starter routine.'); return; }
      button.disabled = true;
      try {
        await api('/api/family/launch', {
          method: 'POST',
          body: JSON.stringify({
            profile: {
              displayName: document.getElementById('launchProfileName').value,
              avatar: document.getElementById('launchProfileAvatar').value,
              ageBand: document.getElementById('launchProfileAge').value
            },
            routines
          })
        });
        toast('Family room launched.');
        await refreshFamily();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    document.getElementById('profileForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/family/profiles', { method: 'POST', body: JSON.stringify({ displayName: document.getElementById('profileName').value, avatar: document.getElementById('profileAvatar').value, ageBand: document.getElementById('profileAge').value }) });
        document.getElementById('profileName').value = '';
        await refreshFamily();
      } catch (error) { toast(error.message); }
    });
    document.getElementById('choreForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const due = document.getElementById('choreDue').value;
      try {
        await api('/api/family/chores', { method: 'POST', body: JSON.stringify({ profileId: document.getElementById('choreProfile').value, title: document.getElementById('choreTitle').value, note: document.getElementById('choreNote').value, cadence: document.getElementById('choreCadence').value, stars: Number(document.getElementById('choreStars').value), dueAt: due ? new Date(`${due}T12:00:00`).toISOString() : null }) });
        document.getElementById('choreTitle').value = '';
        document.getElementById('choreNote').value = '';
        await refreshFamily();
      } catch (error) { toast(error.message); }
    });
    document.querySelectorAll('.journal-filter').forEach((button) => button.addEventListener('click', () => {
      journalView = button.dataset.journalView;
      renderJournal();
    }));
    document.getElementById('refreshJournal').addEventListener('click', refreshJournal);
    await Promise.all([refreshFamily(), refreshJournal()]);
  }

  async function loadPersonas() {
    app.innerHTML = `<section class="hero"><div class="hero-copy"><p class="eyebrow">Private extension</p><h1>Voice personas.</h1><p class="lede">Versioned household roles with scoped memory, bounded audit previews and deterministic child-safety escalation.</p></div><aside class="hero-copy hero-status"><span id="personaSession" class="pill">no session</span><span class="muted">Mongo-owned private state</span></aside></section><section class="toolbar"><label><span>Persona</span><select id="pack"></select></label><label><span>Mode</span><select id="mode"></select></label><label><span>Scope</span><input id="scope" value="personal"></label><button id="newSession" class="primary">New session</button></section><section class="two-col"><article class="card full chat">${voiceBar('persona')}<div id="personaTranscript" class="transcript"><div class="message system">Choose a persona and start a session.</div></div><form id="personaForm" class="composer"><button id="personaMic" class="mic" type="button" data-stop-label="■ Stop" aria-label="Record voice">● Talk</button><input id="personaInput" placeholder="Type a turn…"><button class="primary">Send</button></form></article><aside class="side"><article class="card full"><h2>Scoped memory</h2><form id="memoryForm" class="stack"><input id="memoryTopic" value="general" placeholder="topic"><textarea id="memoryText" placeholder="Save a private fact…"></textarea><button>Save memory</button></form><form id="memorySearch" class="row" style="margin-top:.7rem"><input id="memoryQuery" placeholder="Search memory"><button>Find</button></form><div id="memoryResults" class="stack"></div></article><article class="card full"><h2>Recent audit</h2><div id="personaAudit" class="stack"></div></article></aside></section>`;
    const packData = await api('/api/voice-personas/packs');
    state.packs = packData.packs;
    const packSelect = document.getElementById('pack');
    packSelect.innerHTML = state.packs.map((pack) => `<option value="${esc(pack.id)}">${esc(pack.name)}</option>`).join('');
    function renderModes() {
      const pack = state.packs.find((item) => item.id === packSelect.value);
      document.getElementById('mode').innerHTML = pack.modes.map((mode) => `<option value="${esc(mode.id)}">${esc(mode.label)}</option>`).join('');
      document.getElementById('scope').value = pack.defaultScopeId;
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
    navActive(); app.innerHTML = '<div class="empty" role="status">Chargement…</div>';
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
      if (location.pathname === '/voice/native') return await window.HouseholdNativeVoice.load({ app, api, esc, state, toast, setRuntime, stopPlayback, speak, browserSpeak });
      if (['/voice', '/voice.html', '/voix'].includes(location.pathname)) return await window.mountConversation({ app, api, esc });
      if (location.pathname === '/device-check') return await window.HouseholdDeviceCheck.load({ app, esc, state, api, toast, transcribe, stopPlayback, setRuntime });
      app.innerHTML = '<div class="empty">Page introuvable.</div>';
    } catch (error) {
      console.error('Household page initialization failed', error); setRuntime(false, 'indisponible');
      app.innerHTML = '<article class="card full danger-box"><h1>Cette page est momentanément indisponible.</h1><p>Réessaie dans un instant.</p><button type="button" id="householdRetry">Réessayer</button></article>'; document.getElementById('householdRetry').onclick = () => location.reload();
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
