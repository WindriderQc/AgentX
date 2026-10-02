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
    const section = family ? 'family' : personal ? 'personal' : ['/voice', '/voice.html', '/voix', '/voice/native'].includes(path) ? 'conversation' : ['/', '/ecosystem'].includes(path) ? 'home' : null;
    document.querySelectorAll('.primary-nav a').forEach(link => {
      const active = link.dataset.section === section;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', link.pathname === path ? 'page' : 'location');
      else link.removeAttribute('aria-current');
    });
    const pages = family ? [['/panel', 'Avec Nestor'], ['/kids', 'Enfants'], ['/lecture', 'Lecture']]
      : personal ? [['/dad', 'Avec mon agent'], ['/dad/day', 'Ma journée'], ['/dad/memories', 'Souvenirs'], ['/dad/family', 'Suivi familial']] : [];
    const subnav = document.getElementById('householdSectionNav');
    subnav.hidden = !pages.length;
    subnav.innerHTML = pages.map(([href, label]) => {
      const active = path === href || (href === '/kids' && path.startsWith('/kids/'));
      return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ''}>${label}</a>`;
    }).join('');
    const tools = document.getElementById('householdTools');
    const close = (restoreFocus = false) => {
      if (!tools.open) return;
      tools.open = false;
      if (restoreFocus) tools.querySelector('summary').focus();
    };
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && tools.open) { event.preventDefault(); close(true); } });
    document.addEventListener('click', event => { if (!tools.contains(event.target)) close(); });
    tools.addEventListener('focusout', event => { if (!tools.contains(event.relatedTarget)) close(); });
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
      body: JSON.stringify({ packId, scopeId, modeId })
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

  async function speak(text, languageHint = '', override = null) {
    text = window.NestorSpeech.speechText(text);
    if (!text || state.outputMuted) return;
    const profile = window.NestorSpeech.speechProfile(text, languageHint);
    stopPlayback();
    try {
      if (!window.VoixAudio) throw new Error('Local speech player unavailable');
      state.speech ||= new window.VoixAudio.Speech();
      const choice = override || window.VoixAudio.splitVoice(readingVoices[profile.language]) || { provider: 'kokoro', voice: profile.nativeVoice };
      await state.speech.speak(async signal => {
        const response = await fetch('/api/voix/synthesize/stream', {
          method: 'POST', signal, credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, language: profile.language, tts_provider: choice.provider,
            voice: choice.voice || '', native_defaults: choice.native_defaults === true }),
        });
        if (!response.ok) throw new Error('Local speech is unavailable. Select another local voice or use the explicit browser preview.');
        return response;
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

  function ecosystemLiveBadge(key, label = 'checking live') {
    return `<span class="ecosystem-live"><span class="status-dot" data-ecosystem-dot="${esc(key)}" aria-hidden="true"></span><small data-ecosystem-status="${esc(key)}">${esc(label)}</small></span>`;
  }

  function ecosystemWorkspace({ href, glyph, title, description, liveKey = '', note = '', preflight = '' }) {
    const status = liveKey ? ecosystemLiveBadge(liveKey) : `<small class="ecosystem-note">${esc(note)}</small>`;
    const preflightAttr = preflight ? ` data-launch-preflight="${esc(preflight)}"` : '';
    return `<a class="ecosystem-workspace" href="${esc(href)}"${preflightAttr}><span class="ecosystem-glyph" aria-hidden="true">${esc(glyph)}</span><span class="ecosystem-workspace-copy"><strong>${esc(title)}</strong><small>${esc(description)}</small></span>${status}<span class="ecosystem-arrow" aria-hidden="true">→</span></a>`;
  }

  // One-click launches leave AgentX for a private runtime. Ask the server
  // first whether the launch can succeed, so a failure names its cause instead
  // of ending in a blank tab: a product/configuration fault, an offline
  // gateway, or (when every server-side check passed) a browser policy or
  // extension blocking the launched host.
  function attachLaunchPreflights(root) {
    root.querySelectorAll('a[data-launch-preflight]').forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        const target = link.dataset.launchPreflight;
        try {
          const preflight = await api(`/api/openclaw/control-launch-preflight/${encodeURIComponent(target)}`);
          if (preflight.status !== 'ok') {
            const failing = (preflight.checks || []).filter((check) => check.state === 'blocked').map((check) => check.id).join(', ');
            toast(`OpenClaw ne peut pas être lancé : ${preflight.code || 'préflight bloqué'} (${failing || 'vérification'}).`);
            return;
          }
          if (preflight.browserHint) console.info(preflight.browserHint);
          window.location.assign(link.getAttribute('href'));
        } catch (error) {
          toast(`Préflight OpenClaw indisponible : ${error.message}`);
        }
      });
    });
  }

  function benchmarkHref(pathname) {
    return `http://${location.hostname}:3081${pathname}`;
  }

  function ecosystemTemplate() {
    const household = [
      { href: '/dad/day', glyph: 'J', title: 'Ma journée', description: 'Les tâches et le courrier.', liveKey: 'household' },
      { href: '/dad', glyph: 'D', title: 'Super Dad', description: 'Ton agent, tes outils et tes souvenirs privés.', liveKey: 'voix' },
      { href: '/panel', glyph: 'F', title: 'Famille', description: 'Nestor, les enfants et la lecture.', liveKey: 'household' },
      { href: '/dad/memories', glyph: 'N', title: 'Souvenirs', description: 'Relire les échanges et gérer ce qui est retenu.', liveKey: 'nestor' }
    ];
    const work = [
      { href: '/api/openclaw/control-launch/chat', glyph: 'O', title: 'OpenClaw', description: 'Le bureau agentique protégé (Control UI officiel), vérifié avant le lancement.', liveKey: 'openclaw', preflight: 'chat' },
      { href: '/api/dsh/control-launch', glyph: 'S', title: 'DSH Studio', description: 'L’équipe d’exécution : studio de code isolé, lancé depuis AgentX.', liveKey: 'dsh' },
      { href: '/pipeline', glyph: 'C', title: 'Coding Team', description: 'Travail, attribution, revue et preuves dans Pipeline.', note: 'vérité des tâches' },
      { href: '/agent-ops', glyph: 'A', title: 'Agent Ops', description: 'Agents, automatisations et exceptions opérationnelles.', note: 'cockpit en lecture seule' }
    ];
    const dataAndMind = [
      { href: '/data-toolbox', glyph: 'D', title: 'Data', description: 'Stockage, réseau, bases, flux et Janitor en lecture bornée.', liveKey: 'data' },
      { href: '/psyx', glyph: 'P', title: 'PsyX', description: 'Espace privé longitudinal et conversationnel.', liveKey: 'psyx' }
    ];
    const proofAndSystem = [
      { href: '/portal/', glyph: 'X', title: 'AgentX Portal', description: 'Le workspace Produit complet : Core, Benchmark et RAG.', note: 'Produit complet' },
      { href: benchmarkHref('/leaderboard'), glyph: 'B', title: 'Benchmarks', description: 'Résultats, profils et comparaison de modèles.', liveKey: 'benchmark' },
      { href: '/nerve-center', glyph: 'S', title: 'Santé système', description: 'Hôtes, modèles, routage, alertes et posture RAG.', liveKey: 'system' },
      { href: '/models', glyph: 'M', title: 'Modèles', description: 'Inventaire et preuves attachées aux artefacts actifs.', note: 'autorité Produit' }
    ];
    const links = (items) => items.map(ecosystemWorkspace).join('');
    return `<section class="home-heading"><p class="eyebrow">Bienvenue chez vous</p><h1>Qu’aimeriez-vous faire ?</h1><p class="lede">Parler, organiser votre journée ou retrouver la famille.</p></section>
      <section class="ecosystem-primary household-spaces" aria-label="Nos espaces"><a class="ecosystem-primary-link dad" href="/dad"><span class="ecosystem-primary-index">01</span><span><small>Privé</small><strong>Super Dad</strong><span>Ton agent, tes outils et tes souvenirs.</span></span></a><a class="ecosystem-primary-link nestor" href="/panel"><span class="ecosystem-primary-index">02</span><span><small>Partagé</small><strong>Famille</strong><span>Parler à Nestor, apprendre et vivre la maison.</span></span>${ecosystemLiveBadge('voix')}</a></section>
      <section id="ecosystemWorkspaces" class="ecosystem-directory" aria-labelledby="ecosystemDirectoryTitle"><div class="ecosystem-directory-heading"><div><h2 id="ecosystemDirectoryTitle">Applications & outils</h2><p class="muted">Pour aller plus loin, ouvrez l’espace dont vous avez besoin.</p></div><a class="button compact" href="/portal/" target="_blank" rel="noopener">Ouvrir AgentX Portal ↗</a></div><div class="ecosystem-groups"><details class="ecosystem-group"><summary><span><small>Au quotidien</small><strong>Maison & notes</strong></span><span>4 espaces</span></summary><div class="ecosystem-workspace-list">${links(household)}</div></details><details class="ecosystem-group"><summary><span><small>Travailler</small><strong>Agents & Coding Team</strong></span><span>4 espaces</span></summary><div class="ecosystem-workspace-list">${links(work)}</div></details><details class="ecosystem-group"><summary><span><small>Explorer</small><strong>Data & PsyX</strong></span><span>2 espaces</span></summary><div class="ecosystem-workspace-list">${links(dataAndMind)}</div></details><details class="ecosystem-group"><summary><span><small>Configurer</small><strong>AgentX & système</strong></span><span>4 espaces</span></summary><p class="ecosystem-help">Portal donne accès aux fonctions avancées d’AgentX.</p><div class="ecosystem-workspace-list">${links(proofAndSystem)}</div></details></div>
      <details class="home-service-status"><summary>État des services <span id="ecosystemPulse" class="pill waiting">lecture en cours</span></summary><p><strong id="ecosystemPulseTitle">Vérification des services…</strong></p><p id="ecosystemPulseDetail" class="muted"></p><small id="ecosystemUpdated" class="muted"></small></details></section>`;

  }

  function setEcosystemStatus(key, status, label) {
    const tone = status === 'ok' ? 'ok' : status === 'degraded' ? 'degraded' : status === 'down' ? 'down' : '';
    document.querySelectorAll(`[data-ecosystem-dot="${key}"]`).forEach((node) => { node.className = `status-dot ${tone}`.trim(); });
    document.querySelectorAll(`[data-ecosystem-status="${key}"]`).forEach((node) => { node.textContent = label; });
  }

  async function loadEcosystem() {
    app.innerHTML = ecosystemTemplate();
    document.title = 'Accueil · AgentX';
    setRuntime('waiting', 'checking ecosystem');
    attachLaunchPreflights(app);
    const [panelResult, dataResult, psyxResult, dshResult] = await Promise.allSettled([
      api('/api/panel/status'),
      api('/api/data-toolbox/status'),
      api('/api/psyx/status'),
      api('/api/dsh/status')
    ]);

    // DSH Studio has its own configuration authority; it is not an OpenClaw
    // sub-state. Configured means launchable through AgentX, not "live".
    const dshConfigured = dshResult.status === 'fulfilled' && dshResult.value?.configured === true;
    setEcosystemStatus('dsh', dshConfigured ? 'ok' : 'down', dshConfigured ? 'DSH Studio configuré · lancement protégé' : (dshResult.status === 'fulfilled' ? 'DSH Studio non configuré' : 'DSH Studio : état indisponible'));

    if (panelResult.status === 'fulfilled') {
      const panel = panelResult.value;
      const crew = new Map((panel.crew || []).map((member) => [member.id, member]));
      const services = new Map((panel.services || []).map((service) => [String(service.name || '').toLowerCase(), service]));
      const crewStatus = (id, fallback) => crew.get(id)?.status || fallback;
      const householdReady = ['nestor', 'agentx', 'voix'].every((id) => crewStatus(id, 'down') === 'ok');
      setEcosystemStatus('household', householdReady ? 'ok' : 'degraded', householdReady ? 'Household prêt' : 'Household à vérifier');
      setEcosystemStatus('nestor', crewStatus('nestor', 'down'), crewStatus('nestor', 'down') === 'ok' ? 'Nestor prêt' : 'Nestor indisponible');
      setEcosystemStatus('openclaw', crewStatus('openclaw', 'down'), crewStatus('openclaw', 'down') === 'ok' ? 'OpenClaw prêt' : 'OpenClaw à vérifier');
      setEcosystemStatus('voix', crewStatus('voix', 'down'), crewStatus('voix', 'down') === 'ok' ? 'VoiX prêt' : 'VoiX indisponible');
      const benchmark = services.get('benchmark');
      setEcosystemStatus('benchmark', benchmark?.status || 'down', benchmark?.status === 'ok' ? 'Benchmark prêt' : 'Benchmark indisponible');
      const attention = [
        ...(panel.crew || []).filter((member) => member.status !== 'ok').map((member) => `${member.name} à vérifier`),
        ...(panel.fleet?.attention || [])
      ];
      const servicesReady = (panel.services || []).filter((service) => service.status === 'ok').length;
      const hostsReady = Number(panel.fleet?.onlineHosts || 0);
      const hostsTotal = Number(panel.fleet?.configuredHosts || 0);
      const systemStatus = panel.status === 'ok' ? 'ok' : 'degraded';
      setEcosystemStatus('system', systemStatus, `${servicesReady}/${panel.services?.length || 0} services · ${hostsReady}/${hostsTotal} hôtes`);
      document.getElementById('ecosystemPulse').textContent = panel.status === 'ok' ? 'prêt' : 'à vérifier';
      document.getElementById('ecosystemPulse').className = `pill ${panel.status === 'ok' ? 'ok' : 'waiting'}`;
      document.getElementById('ecosystemPulseTitle').textContent = panel.status === 'ok' ? 'Les fondations sont prêtes.' : 'Points à vérifier';
      document.getElementById('ecosystemPulseDetail').textContent = `${servicesReady}/${panel.services?.length || 0} services · ${hostsReady}/${hostsTotal} hôtes${attention.length ? ` · ${attention.join(' · ')}` : ''}`;
      document.getElementById('ecosystemUpdated').textContent = `Projection live · ${new Date(panel.generatedAt || Date.now()).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`;
      setRuntime(panel.status === 'ok' ? true : 'waiting', panel.status === 'ok' ? 'ecosystem ready' : 'attention');
    } else {
      for (const key of ['household', 'nestor', 'openclaw', 'voix', 'benchmark', 'system']) setEcosystemStatus(key, 'down', 'live state unavailable');
      document.getElementById('ecosystemPulse').textContent = 'indisponible';
      document.getElementById('ecosystemPulse').className = 'pill down';
      document.getElementById('ecosystemPulseTitle').textContent = 'La projection live ne répond pas.';
      document.getElementById('ecosystemPulseDetail').textContent = panelResult.reason?.message || 'Les portes restent visibles, sans état inventé.';
      setRuntime(false, 'ecosystem unavailable');
    }

    if (dataResult.status === 'fulfilled') {
      const data = dataResult.value;
      const healthy = Number(data.dataService?.healthy || 0);
      const total = Number(data.dataService?.total || 0);
      const ok = Boolean(total) && healthy === total;
      setEcosystemStatus('data', ok ? 'ok' : 'degraded', total ? `Data ${healthy}/${total} sources` : 'Data status incomplete');
    } else setEcosystemStatus('data', 'down', 'Data unavailable');

    if (psyxResult.status === 'fulfilled') {
      const psyx = psyxResult.value;
      const active = psyx.extension === 'psyx-standalone' && psyx.persona?.installed === true && psyx.persona?.active === true;
      const version = psyx.serviceVersion || psyx.extensionVersion || '';
      setEcosystemStatus('psyx', active ? 'ok' : 'degraded', active ? `PsyX ${version || 'active'}` : 'PsyX needs attention');
    } else setEcosystemStatus('psyx', 'down', 'PsyX unavailable');
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
    app.innerHTML = `<section class="hero"><div class="hero-copy"><p class="eyebrow">Private parent controls</p><h1>Guide the rhythm.</h1><p class="lede">Create kid profiles, set one-time or recurring responsibilities, approve check-ins, and review every child-safe Nestor turn. These controls are available only on the private household surface.</p></div><aside class="hero-copy hero-status"><span id="parentSummary" class="clock">0</span><span class="muted">active family routines</span></aside></section><section class="parent-grid"><article id="familyLaunchCard" class="card full family-launch"><div class="row"><div class="grow"><p class="card-kicker">First family launch · explicit setup</p><h2>Open Kids Room with a real rhythm</h2><p class="muted">Name the first profile, edit or uncheck every suggestion, then create the profile and selected routines together. Nothing is created until you press Launch.</p></div><span class="pill">private</span></div><form id="familyLaunchForm" class="stack"><div class="parent-profile-form"><label><span>Name shown at home</span><input id="launchProfileName" maxlength="80" required placeholder="Kid name"></label><label><span>Avatar</span><input id="launchProfileAvatar" maxlength="8" value="⭐" aria-label="Starter profile avatar"></label><label><span>Age band</span><select id="launchProfileAge"><option value="little">Little</option><option value="school" selected>School age</option><option value="teen">Teen</option></select></label></div><fieldset class="launch-routines"><legend>Editable starter routines · choose 1–5</legend><div class="launch-routine"><input type="checkbox" checked aria-label="Include first starter routine"><input data-launch-title maxlength="160" value="Remettre tes choses à leur place" aria-label="First routine title"><select data-launch-cadence aria-label="First routine cadence"><option value="daily" selected>Daily</option><option value="weekly">Weekly</option><option value="once">One time</option></select><select data-launch-stars aria-label="First routine stars"><option>1</option><option selected>2</option><option>3</option><option>4</option><option>5</option></select><input class="launch-note" data-launch-note maxlength="1000" value="Commence par ce que tu as utilisé en dernier." aria-label="First routine hint"></div><div class="launch-routine"><input type="checkbox" checked aria-label="Include second starter routine"><input data-launch-title maxlength="160" value="Préparer tes choses pour demain" aria-label="Second routine title"><select data-launch-cadence aria-label="Second routine cadence"><option value="daily" selected>Daily</option><option value="weekly">Weekly</option><option value="once">One time</option></select><select data-launch-stars aria-label="Second routine stars"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select><input class="launch-note" data-launch-note maxlength="1000" value="Sac, vêtements ou tout ce dont tu auras besoin." aria-label="Second routine hint"></div><div class="launch-routine"><input type="checkbox" checked aria-label="Include third starter routine"><input data-launch-title maxlength="160" value="Aider à ranger un espace commun" aria-label="Third routine title"><select data-launch-cadence aria-label="Third routine cadence"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="once">One time</option></select><select data-launch-stars aria-label="Third routine stars"><option>1</option><option>2</option><option>3</option><option selected>4</option><option>5</option></select><input class="launch-note" data-launch-note maxlength="1000" value="Demande à papa quel espace a besoin d’aide." aria-label="Third routine hint"></div></fieldset><div class="row wrap"><button id="familyLaunchButton" class="primary">Launch profile + selected routines</button><a class="button" href="/kids">Preview safe guest room</a></div></form></article><article class="card full"><h2>Family profiles</h2><form id="profileForm" class="parent-profile-form"><label><span>Name shown at home</span><input id="profileName" maxlength="80" required placeholder="Kid name"></label><label><span>Avatar</span><input id="profileAvatar" maxlength="8" value="⭐" aria-label="Profile avatar"></label><label><span>Age band</span><select id="profileAge"><option value="little">Little</option><option value="school" selected>School age</option><option value="teen">Teen</option></select></label><button class="primary">Add profile</button></form><div id="profiles" class="profile-list"></div></article><article class="card full"><h2>Add a responsibility</h2><form id="choreForm" class="parent-chore-form"><label><span>For</span><select id="choreProfile" required></select></label><label class="wide-field"><span>What needs doing?</span><input id="choreTitle" maxlength="160" required placeholder="Put school bag by the door"></label><label><span>When</span><input id="choreDue" type="date"></label><label><span>Repeats</span><select id="choreCadence"><option value="once">One time</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label><label><span>Stars</span><select id="choreStars"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label><label class="wide-field"><span>Helpful note</span><input id="choreNote" maxlength="1000" placeholder="A short, concrete hint"></label><button class="primary">Add to Kids Room</button></form><div id="choreSetupEmpty" class="empty" hidden>Create a profile before adding responsibilities.</div><div id="chores" class="stack"></div></article><article class="card full"><div class="row"><div class="grow"><h2>Child-safe Nestor journal</h2><p class="muted">Question, answer, safety flags, and routing evidence. Raw audio is never retained.</p></div><span id="journalCount" class="pill">0 recent turns</span><button id="refreshJournal">Refresh</button></div><div id="journal" class="stack"></div></article></section>`;
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

  async function loadVoice() {
    app.innerHTML = `<section class="hero voice-hero"><div class="hero-copy"><div class="voice-hero-heading"><p class="eyebrow">Nestor · live household voice</p><span class="voice-sovereign-mark">local · scoped · audio ephemeral by default</span></div><h1>Native voice.</h1><p class="lede">Microphone and speaker on the VoiX computer. For this phone or PC, open Conversation.</p><nav class="voice-hero-links" aria-label="Nestor workspaces"><a class="button primary" href="/dad">Dad's private desk</a><a class="button" href="/voice-personas">Personas</a><a class="button" href="/api/openclaw/control-launch/chat">Agent team</a></nav></div><aside class="hero-copy hero-status voice-core-status"><div id="voiceOrb" class="voice-orb" data-state="connecting" aria-hidden="true"><span>N</span></div><div class="voice-core-copy"><span id="voixHealth" class="pill">checking VoiX</span><strong id="voiceLiveState">connecting</strong><span id="voiceSessionSummary" class="muted">Waiting for the native session.</span></div></aside></section>
      <section class="voice-cockpit-grid">
        <article class="card voice-live-card"><div class="voice-live-heading"><div><p class="card-kicker">Live native session</p><h2>One turn, end to end</h2></div><div class="row wrap"><span id="voicePersona" class="pill">personality pending</span><span id="voiceLane" class="pill">capabilities pending</span></div></div>
          <div class="voice-control-bar"><button id="voiceStart" class="primary" type="button">Start listening</button><button id="voiceStop" type="button">Stop session</button><button id="voiceCancel" type="button">Interrupt turn</button><span id="voiceEchoGuard" class="pill ok">feedback guard armed</span><span class="muted">Explicit controls · the microphone never starts with the page.</span></div>
          <div id="voiceSignal" class="voice-signal" data-signal="waiting"><div class="voice-signal-copy"><small>Live microphone</small><strong id="voiceSignalLabel">waiting for stream</strong></div><div id="voiceSignalTrack" class="voice-signal-track" role="meter" aria-label="Live microphone energy" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="voiceSignalMeter"></span></div><small id="voiceSignalDetail">Checking the local privacy boundary…</small></div>
          <div class="voice-stage-rail" aria-label="Live voice stages">
            <div id="voiceStageListen" class="voice-stage"><span>1</span><strong>Listen</strong><small>VAD + mic</small></div>
            <div id="voiceStageStt" class="voice-stage"><span>2</span><strong>STT</strong><small>Whisper</small></div>
            <div id="voiceStageRoute" class="voice-stage"><span>3</span><strong>Route</strong><small>AgentX</small></div>
            <div id="voiceStageLlm" class="voice-stage"><span>4</span><strong>LLM</strong><small>stream</small></div>
            <div id="voiceStageTts" class="voice-stage"><span>5</span><strong>TTS</strong><small>local voice</small></div>
            <div id="voiceStagePlayback" class="voice-stage"><span>6</span><strong>Play</strong><small>speaker</small></div>
          </div>
          <div class="voice-execution-strip" aria-label="Execution activity"><span>Execution</span><div><small>Tools</small><strong id="voiceToolsState">none launched</strong></div><div><small>Skills</small><strong id="voiceSkillsState">none launched</strong></div><div><small>Agents</small><strong id="voiceAgentsState">none launched</strong></div></div>
          <div class="voice-exchange"><div class="message user"><small>You</small><span id="voiceTranscript">Waiting for speech…</span></div><div class="message assistant"><small>Nestor</small><span id="voiceReply">Ready when you are.</span></div></div>
          <div class="voice-route-strip"><div><small>Lane</small><strong id="voiceRouteTask">discussion</strong></div><div><small>Host</small><strong id="voiceRouteHost">pending</strong></div><div><small>Model</small><strong id="voiceRouteModel">pending</strong></div><div><small>Routing proof</small><strong id="voiceRouteSource">next turn</strong></div></div>
          <div class="voice-metrics"><div><strong id="voiceMetricStt">—</strong><span>STT</span></div><div><strong id="voiceMetricToken">—</strong><span>first token</span></div><div><strong id="voiceMetricTts">—</strong><span>TTS chunk</span></div><div><strong id="voiceMetricAudio">—</strong><span>first audio</span></div><div><strong id="voiceMetricDone">—</strong><span>turn complete</span></div></div>
          <details class="voice-drawer voice-device-drawer"><summary><span>Audio binding</span><strong id="voiceDeviceBinding">not yet proven</strong></summary><div class="voice-device-strip" role="region" aria-label="Current voice devices"><div><small>Requested mic</small><strong id="voiceInputConfigured">waiting</strong></div><div><small>Opened mic</small><strong id="voiceInputResolved">waiting for session</strong></div><div><small>Opened output</small><strong id="voiceOutputResolved">waiting for session</strong></div><div><small>Binding</small><strong>session-start receipt</strong></div></div><p id="voiceDeviceHint" class="muted voice-device-hint">The live session receipt will name the endpoints it actually opened. Stop and start after changing Windows audio devices.</p></details>
        </article>
        <article class="card voice-session-card"><div class="row"><div class="grow"><p class="card-kicker">Session profile</p><h2>Who speaks with which Nestor?</h2></div><span id="voiceConversationState" class="pill">Family · default</span></div><div class="voice-session-settings"><section><label class="stack"><span>Memory and identity lane</span><select id="voiceConversationMode"><option value="family" selected>Family · shared household</option><option value="dad">Dad · private personal</option></select></label><button id="voiceConversationApply" type="button">Use Family</button><p id="voiceConversationNote" class="muted dad-quiet">Family is the default for an unknown speaker. Stop the current session before changing modes.</p></section><section><label class="stack"><span>Conversation posture</span><select id="voicePersonality"><option value="">Loading personalities…</option></select></label><button id="voicePersonalityApply" type="button">Use on next session</button><strong id="voicePersonalityName" class="voice-profile-name">Nestor</strong><p id="voicePersonalityDescription" class="muted dad-quiet">Reading the active native profile…</p><p id="voicePersonalityNote" class="muted dad-quiet">Every personal persona uses the same agent, tools and memory.</p></section><section><label class="stack"><span>Speaking voice</span><select id="voiceTTS"><option value="kokoro">Kokoro · current blend</option><option value="windows_sapi">Windows SAPI · system voice</option><option value="voxcpm" disabled>VoxCPM2 · Voice A</option></select></label><label class="stack"><span>French voice</span><select id="voiceTTSFrench"><option value="">Persona / language default</option></select></label><label class="stack"><span>English voice</span><select id="voiceTTSEnglish"><option value="">Persona / language default</option></select></label><button id="voiceTTSApply" type="button" disabled>Use on next session</button><p id="voiceTTSNote" class="muted dad-quiet">Choose a voice for the next native session. Personality and Family or Dad mode are selected separately.</p></section></div><div class="voice-identity-note"><strong>Speaker identity</strong><span>Recognition may eventually suggest a user-labelled hint. It never selects Dad or unlocks tools; Dad always requires the owner's explicit control.</span></div></article>
        <aside class="voice-compact-side">
          <details class="card voice-truth-card voice-drawer"><summary><div><p class="card-kicker">AgentX Voice v1</p><strong>Capability truth</strong></div><span id="voiceContractState" class="pill">checking</span></summary><div class="voice-truth-grid"><div><small>Push-to-talk</small><strong id="voicePushState">checking</strong></div><div><small>Native session</small><strong id="voiceSessionCapability">checking</strong></div><div><small>Wake gate</small><strong id="voiceWakeState">checking</strong></div><div><small>Sovereign archive</small><strong id="voiceArchivePersistence">checking</strong></div><div><small>Improvement vault</small><strong id="voiceMediaVaultState">checking</strong></div><div><small>Speaker recognition</small><strong id="voiceSpeakerRecognitionState">not installed</strong></div><div><small>Runtime</small><strong id="voixRuntime">checking</strong></div><div><small>Voice</small><strong id="voiceTimbre">checking</strong></div><div><small>Language</small><strong id="voiceLanguage">checking</strong></div></div><p id="voiceBrowserContext" class="muted dad-quiet">Checking browser microphone boundary…</p><p class="muted dad-quiet">The native wake gate decides whether to launch a turn. Normal Family and Dad audio stays ephemeral unless you explicitly save the latest accepted utterance below.</p></details>
          <details class="card voice-media-vault-card voice-drawer" id="voiceMediaVault"><summary><div><p class="card-kicker">Opt-in evidence</p><strong>Voice improvement vault</strong></div><span id="voiceMediaVaultPill" class="pill">checking</span></summary><div class="voice-media-vault-body"><div class="voice-vault-boundary"><strong>Normal audio stays ephemeral.</strong><span>Only the latest wake-accepted utterance is held briefly in RAM. Saving is explicit, encrypted locally, and never feeds memory, RAG, Dad access, or emotion authority.</span></div><div id="voiceMediaCandidate" class="voice-media-candidate" data-state="waiting" aria-live="polite"><small>Latest accepted utterance</small><strong>Waiting for a candidate</strong><span>Speak to Nestor first; nothing is saved automatically.</span></div><form id="voiceMediaForm" class="voice-media-form"><label><span>Use</span><select id="voiceMediaCategory"><option value="pronunciation">Pronunciation</option><option value="stt-correction">STT correction</option><option value="acoustic-condition">Room acoustics</option><option value="speaker-enrollment">Speaker enrolment</option><option value="emotion-research">Emotion research</option></select></label><label><span>Speaker</span><select id="voiceMediaSubject"><option value="adult">Adult</option><option value="child">Child</option><option value="unknown">Unknown</option></select></label><label><span>Speaker label</span><input id="voiceMediaSpeaker" maxlength="120" placeholder="Optional, except enrolment" autocomplete="off"></label><label><span>Note</span><input id="voiceMediaLabel" maxlength="120" placeholder="Why keep this sample?" autocomplete="off"></label><label class="voice-vault-check voice-media-span"><input id="voiceMediaConsent" type="checkbox"><span>I explicitly approve saving this one candidate.</span></label><label id="voiceMediaGuardianRow" class="voice-vault-check voice-media-span" hidden><input id="voiceMediaGuardian" type="checkbox"><span>I am the guardian and approve this child's sample.</span></label><label id="voiceMediaResearchRow" class="voice-vault-check voice-media-span" hidden><input id="voiceMediaResearch" type="checkbox"><span>I approve research use; no emotion claim is produced.</span></label><button id="voiceMediaSave" class="primary voice-media-span" type="submit" disabled>Save encrypted clip</button></form><div class="voice-vault-library-heading"><div><strong>Saved evidence</strong><small id="voiceMediaVaultUsage">0 clips</small></div><button id="voiceMediaRefresh" type="button">Refresh</button></div><div id="voiceMediaClips" class="voice-media-clips" aria-live="polite"><div class="empty">Open this drawer to load encrypted clips.</div></div></div></details>
          <article class="card voice-memory-card"><div class="row"><div class="grow"><p id="voiceMemoryKicker" class="card-kicker">Family conversation memory</p><h2 id="voiceMemoryTitle">Household continuity, parent-visible</h2></div><span id="voiceMemoryState" class="pill">checking</span></div><div class="voice-memory-grid"><div><small>Live context</small><strong id="voiceContextDepth">0 / 6 turns</strong></div><div><small id="voiceMemoryOutboxLabel">Turn handoff</small><strong id="voiceMemoryOutbox">checking</strong></div><div><small id="voiceMemoryArchiveLabel">Family journal</small><strong id="voiceMemoryArchive">Household-owned</strong></div><div><small id="voiceMemoryProposedLabel">Review</small><strong id="voiceMemoryProposed">Parent-visible</strong></div></div><p id="voiceMemoryPolicy" class="muted dad-quiet">Family keeps bounded text in the Household parent audit; VoiX keeps aggregate events only, and audio remains ephemeral.</p><button id="voiceMemoryReviewToggle" type="button" aria-expanded="false" hidden>Review what Nestor learned</button><div id="voiceMemoryReview" class="voice-memory-review" hidden><section><h3>Suggestions</h3><div id="voiceMemoryCandidates" class="stack"><div class="empty">No suggestions loaded.</div></div></section><section><h3>Remembered now</h3><div id="voiceMemoryActive" class="stack"><div class="empty">No memories loaded.</div></div></section></div></article>
          <details class="card voice-check-card voice-drawer"><summary><div><p class="card-kicker">Voice check</p><strong>Preview the selected voice</strong></div><span class="pill">This browser speaker</span></summary><form id="ttsForm" class="stack"><textarea id="ttsText">Bonjour! Nestor est prêt à discuter.</textarea><p id="ttsLanguage" class="muted" aria-live="polite">Matching text and voice…</p><div class="row wrap"><button class="primary">Preview selected voice</button><button id="browserSpeak" type="button">Browser fallback</button></div></form></details>
        </aside>
        <article class="card voice-events-card"><div class="row"><div class="grow"><p class="card-kicker">Bounded operational trace</p><h2>What Nestor is doing</h2></div><span id="voiceEventCount" class="pill">0 events</span></div><div id="voiceEvents" class="voice-event-feed" aria-live="polite"><div class="empty">Waiting for the native event stream.</div></div></article>
      </section>`;
      const [healthResult, contractResult, configResult, catalogResult] = await Promise.allSettled([
        api('/api/voix/health'), api('/api/voix/contract'), api('/api/voix/config'), api('/api/voix/catalog')
      ]);
      const localCatalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
      const renderNativeVoices = (provider, config = {}) => {
        for (const [id, language] of [['voiceTTSFrench', 'fr'], ['voiceTTSEnglish', 'en']]) {
          const select = document.getElementById(id);
          select.replaceChildren(new Option('Persona / language default', ''));
          const voices = window.VoixAudio?.choices(localCatalog, language, provider) || [];
          for (const voice of voices) {
            const option = new Option(`${voice.name} · ${voice.locale}${voice.available ? '' : ' · unavailable'}`, voice.id);
            option.disabled = !voice.available; option.title = voice.reason || ''; select.add(option);
          }
          const selected = config['tts_voice_' + language] || '';
          if (selected && !voices.some(v => v.id === selected)) select.add(new Option(`Saved voice: ${selected}`, selected));
          select.value = selected;
        }
      };
      document.getElementById('voiceTTS').addEventListener('change', event => renderNativeVoices(event.target.value));
      let activeConversationMode = 'family';
      let conversationSelectionDirty = false;
      let conversationNoteOverride = '';
      let memoryReviewOpen = false;
      let mediaVaultStatus = null;
      let mediaVaultCandidateId = '';
      let mediaVaultBusy = false;
      let lastMediaCandidateReceipt = '';
      const conversationSelector = document.getElementById('voiceConversationMode');
      const renderConversationMode = (mode) => {
        activeConversationMode = mode === 'dad' ? 'dad' : 'family';
        conversationSelectionDirty = false;
        const family = activeConversationMode === 'family';
        conversationSelector.value = activeConversationMode;
        document.getElementById('voiceConversationState').textContent = family ? 'Family · default' : 'Dad · explicitly active';
        document.getElementById('voiceConversationState').className = family ? 'pill ok' : 'pill waiting';
        document.getElementById('voiceConversationApply').textContent = family ? 'Use Family' : 'Activate Dad';
        if (!conversationNoteOverride) {
          document.getElementById('voiceConversationNote').textContent = family
            ? 'Family is the safe default. Stop the current session before changing modes.'
            : 'Dad uses private personal memory only after this explicit selection. Stop, activate, then Start.';
        }
        document.getElementById('voiceMemoryKicker').textContent = family ? 'Family conversation memory' : 'Private Dad conversation memory';
        document.getElementById('voiceMemoryTitle').textContent = family ? 'Household continuity, parent-visible' : 'Your personal agent owns continuity';
        document.getElementById('voiceMemoryOutboxLabel').textContent = family ? 'Turn handoff' : 'Agent session';
        document.getElementById('voiceMemoryArchiveLabel').textContent = family ? 'Family journal' : 'Private archive';
        document.getElementById('voiceMemoryProposedLabel').textContent = family ? 'Review' : 'Needs review';
        document.getElementById('voiceMemoryPolicy').textContent = family
          ? 'Family turns use the Household notebook and parent audit for bounded text; VoiX keeps aggregate events only, and audio remains ephemeral.'
          : 'Dad uses the same personal agent session as Conversation. OpenClaw owns its history, tools and memory; VoiX provides the audio transport. Audio remains ephemeral.';
        const reviewToggle = document.getElementById('voiceMemoryReviewToggle');
        reviewToggle.hidden = family;
        if (family) {
          memoryReviewOpen = false;
          document.getElementById('voiceMemoryReview').hidden = true;
          reviewToggle.setAttribute('aria-expanded', 'false');
          document.getElementById('voiceMemoryState').textContent = 'household';
          document.getElementById('voiceMemoryState').className = 'pill ok';
          document.getElementById('voiceMemoryOutbox').textContent = 'per completed turn';
          document.getElementById('voiceMemoryArchive').textContent = 'Household-owned';
          document.getElementById('voiceMemoryProposed').textContent = 'Parent-visible';
        }
      };
      conversationSelector.addEventListener('change', () => {
        conversationSelectionDirty = true;
        conversationNoteOverride = '';
        const family = conversationSelector.value === 'family';
        document.getElementById('voiceConversationApply').textContent = family ? 'Use Family' : 'Activate Dad';
        document.getElementById('voiceConversationNote').textContent = family
          ? 'Family is the safe default. Stop the current session, apply Family, then Start.'
          : 'Dad stays closed until you press Activate Dad. A voice or wake word cannot do this.';
      });
      let nativeWarmup = null;
      if (healthResult.status === 'fulfilled') {
        const data = healthResult.value;
        nativeWarmup = data.warmup || null;
        const warming = ['pending', 'running'].includes(nativeWarmup?.state);
        document.getElementById('voixHealth').textContent = warming ? `VoiX warming · ${nativeWarmup?.stage || 'models'}` : 'VoiX online';
        document.getElementById('voixHealth').className = warming ? 'pill waiting' : 'pill ok';
      document.getElementById('voixRuntime').textContent = data.version || data.serviceVersion || 'online';
    } else {
      document.getElementById('voixHealth').textContent = healthResult.reason.message;
      document.getElementById('voixHealth').className = 'pill down';
      document.getElementById('voixRuntime').textContent = 'offline';
      document.getElementById('voiceLiveState').textContent = 'VoiX unavailable';
    }
    if (contractResult.status === 'fulfilled') {
      const contract = contractResult.value;
      document.getElementById('voiceContractState').textContent = contract.version;
      document.getElementById('voiceContractState').className = 'pill ok';
      document.getElementById('voicePushState').textContent = contract.capabilities?.pushToTalk?.status || 'unknown';
      document.getElementById('voiceWakeState').textContent = contract.capabilities?.wakeWord?.status || 'unknown';
      document.getElementById('voiceSessionCapability').textContent = contract.capabilities?.nativeSessions?.status || 'unknown';
      document.getElementById('voiceMediaVaultState').textContent = contract.capabilities?.mediaVault?.status || 'unknown';
      document.getElementById('voiceSpeakerRecognitionState').textContent = contract.capabilities?.speakerRecognition?.matcherStatus || 'unknown';
    } else {
      document.getElementById('voiceContractState').textContent = 'missing';
      document.getElementById('voiceContractState').className = 'pill down';
      document.getElementById('voicePushState').textContent = 'unknown';
      document.getElementById('voiceSessionCapability').textContent = 'unknown';
      document.getElementById('voiceMediaVaultState').textContent = 'unknown';
      document.getElementById('voiceSpeakerRecognitionState').textContent = 'unknown';
    }
    if (configResult.status === 'fulfilled') {
      const config = configResult.value.config || {};
      const staticConfig = configResult.value.static || {};
      const profiles = staticConfig.nestor_personalities || [];
      const profile = profiles.find((entry) => entry.id === config.persona) || profiles[0];
      renderConversationMode(config.conversation_mode || 'family');
      const selector = document.getElementById('voicePersonality');
      selector.innerHTML = profiles.map((entry) => `<option value="${esc(entry.id)}"${entry.id === config.persona ? ' selected' : ''}>${esc(entry.label)}</option>`).join('') || '<option value="">No profiles reported</option>';
      document.getElementById('voicePersona').textContent = profile?.label || config.persona || 'default personality';
      document.getElementById('voicePersonalityName').textContent = profile?.label || 'Nestor';
      document.getElementById('voicePersonalityDescription').textContent = profile?.description || 'Native Nestor conversation profile.';
      document.getElementById('voiceLane').textContent = config.conversation_mode === 'dad' && config.brain === 'nestor' ? 'personal agent · tools available' : 'Family · scoped conversation';
      const voiceParts = String(staticConfig.kokoro_voice || '').split('+').filter(Boolean).map((part) => {
        const [voiceId, weight] = part.split(':');
        const name = String(voiceId || '').split('_').slice(1).join(' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || voiceId;
        return { name, weight: Number(weight) };
      });
      const voiceNames = voiceParts.map((part) => part.name).filter(Boolean).join(' + ');
      const voiceRatio = voiceParts.length > 1 && voiceParts.every((part) => Number.isFinite(part.weight))
        ? ` · ${voiceParts.map((part) => Math.round(part.weight * 100)).join('/')}`
        : '';
      const provider = config.tts_provider || staticConfig.tts_provider_default || 'native';
      const voiceTimbre = document.getElementById('voiceTimbre');
      const voiceLabels = { kokoro: `Kokoro · ${voiceNames || 'default'}${voiceRatio}`, windows_sapi: 'Windows SAPI · system voice', voxcpm: 'VoxCPM2 · Voice A' };
      voiceTimbre.textContent = voiceLabels[provider] || provider;
      voiceTimbre.title = provider === 'kokoro' ? staticConfig.kokoro_voice || 'Native default voice' : voiceLabels[provider] || provider;
      renderNativeVoices(provider, config);
      const voiceSelector = document.getElementById('voiceTTS');
      voiceSelector.value = provider;
      voiceSelector.querySelector('[value="voxcpm"]').disabled = !staticConfig.voxcpm_configured;
      document.getElementById('voiceTTSApply').disabled = false;
      const voiceLocale = (provider === 'kokoro' ? staticConfig.kokoro_language : config.language) || 'unknown';
      document.getElementById('voiceLanguage').textContent = voiceLocale.replace(/^([a-z]{2})-([a-z]{2})$/i, (_match, language, region) => `${language.toLowerCase()}-${region.toUpperCase()}`);
    }
    document.getElementById('voiceBrowserContext').textContent = window.isSecureContext
      ? 'Trusted HTTPS is active; the browser may request microphone permission when you press a mic.'
      : 'Text and playback work here; microphone capture requires the trusted HTTPS household link.';
      setRuntime(
        healthResult.status === 'fulfilled' && contractResult.status === 'fulfilled' ? (['pending', 'running'].includes(nativeWarmup?.state) ? 'waiting' : true) : false,
        healthResult.status === 'fulfilled' ? (['pending', 'running'].includes(nativeWarmup?.state) ? 'voice warming' : 'voice ready') : 'voice down'
      );
    const mediaVaultDrawer = document.getElementById('voiceMediaVault');
    const mediaVaultCategory = document.getElementById('voiceMediaCategory');
    const mediaVaultSubject = document.getElementById('voiceMediaSubject');
    const mediaVaultConsent = document.getElementById('voiceMediaConsent');
    const mediaVaultGuardian = document.getElementById('voiceMediaGuardian');
    const mediaVaultResearch = document.getElementById('voiceMediaResearch');
    const mediaVaultSpeaker = document.getElementById('voiceMediaSpeaker');
    const mediaVaultSave = document.getElementById('voiceMediaSave');
    const formatBytes = (value) => {
      const bytes = Math.max(0, Number(value) || 0);
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };
    const updateMediaVaultGates = () => {
      const child = mediaVaultSubject.value === 'child';
      const emotion = mediaVaultCategory.value === 'emotion-research';
      const enrollment = mediaVaultCategory.value === 'speaker-enrollment';
      document.getElementById('voiceMediaGuardianRow').hidden = !child;
      document.getElementById('voiceMediaResearchRow').hidden = !emotion;
      if (!child) mediaVaultGuardian.checked = false;
      if (!emotion) mediaVaultResearch.checked = false;
      const ready = mediaVaultStatus?.state === 'ready'
        && mediaVaultStatus?.safetyConfirmed === true
        && Boolean(mediaVaultCandidateId)
        && mediaVaultConsent.checked
        && (!child || mediaVaultGuardian.checked)
        && (!emotion || mediaVaultResearch.checked)
        && (!enrollment || (mediaVaultSubject.value !== 'unknown' && mediaVaultSpeaker.value.trim()));
      mediaVaultSave.disabled = mediaVaultBusy || !ready;
      mediaVaultSave.textContent = mediaVaultBusy ? 'Working…' : 'Save encrypted clip';
    };
    const renderMediaVaultStatus = (status, { trustedCandidateId = false } = {}) => {
      mediaVaultStatus = status || {};
      const safe = mediaVaultStatus.safetyConfirmed === true;
      const ready = safe && mediaVaultStatus.state === 'ready';
      const candidate = mediaVaultStatus.candidate || {};
      if (trustedCandidateId) mediaVaultCandidateId = candidate.candidateId || '';
      else if (!candidate.available) mediaVaultCandidateId = '';
      const pill = document.getElementById('voiceMediaVaultPill');
      pill.textContent = !safe ? 'boundary unconfirmed' : ready ? 'ready · opt-in' : mediaVaultStatus.state || 'unavailable';
      pill.className = ready ? 'pill ok' : safe ? 'pill waiting' : 'pill down';
      document.getElementById('voiceMediaVaultState').textContent = ready ? 'ready · explicit only' : pill.textContent;
      document.getElementById('voiceMediaVaultUsage').textContent = `${mediaVaultStatus.clips?.count || 0} clips · ${formatBytes(mediaVaultStatus.clips?.bytes)}`;
      const candidateNode = document.getElementById('voiceMediaCandidate');
      const duration = Math.max(0, Number(candidate.durationMs) || 0);
      const expires = Math.max(0, Number(candidate.expiresInSeconds) || 0);
      if (!safe) {
        candidateNode.dataset.state = 'unsafe';
        candidateNode.innerHTML = '<small>Safety boundary</small><strong>Saving is closed</strong><span>VoiX did not confirm the no-passive-capture contract.</span>';
      } else if (candidate.available) {
        candidateNode.dataset.state = expires <= 20 ? 'expiring' : 'ready';
        candidateNode.innerHTML = `<small>Latest accepted utterance</small><strong>${mediaVaultCandidateId ? 'Ready to save' : 'Recent candidate detected'} · ${(duration / 1000).toFixed(1)} s</strong><span>${mediaVaultCandidateId ? `${Math.round(expires)} s remaining` : 'Open this drawer to obtain its short-lived save token'} · ${esc(candidate.conversationMode || 'family')} · RAM only</span>`;
      } else {
        candidateNode.dataset.state = 'waiting';
        candidateNode.innerHTML = '<small>Latest accepted utterance</small><strong>Waiting for a candidate</strong><span>Speak to Nestor first; nothing is saved automatically.</span>';
      }
      updateMediaVaultGates();
    };
    const renderMediaVaultClips = (clips) => {
      const root = document.getElementById('voiceMediaClips');
      root.innerHTML = clips.length
        ? clips.map((clip) => {
          const category = String(clip.category || 'evidence').replaceAll('-', ' ');
          const title = clip.label || clip.speakerLabel || category;
          const speaker = clip.speakerLabel || clip.subjectKind || 'unknown speaker';
          const created = clip.createdAt ? new Date(clip.createdAt).toLocaleDateString() : 'date unavailable';
          return `<div class="voice-media-clip"><div><strong>${esc(title)}</strong><small>${esc(category)} · ${esc(speaker)} · ${(Math.max(0, Number(clip.durationMs) || 0) / 1000).toFixed(1)} s · ${esc(created)}</small></div><div class="voice-media-clip-actions"><button type="button" data-voice-media-listen="${esc(clip.clipId)}">Listen</button><button class="danger" type="button" data-voice-media-delete="${esc(clip.clipId)}">Delete</button></div></div>`;
        }).join('')
        : '<div class="empty">No encrypted evidence clips. Normal conversation audio is still ephemeral.</div>';
    };
    const refreshMediaVault = async () => {
      if (mediaVaultBusy) return;
      mediaVaultBusy = true;
      updateMediaVaultGates();
      try {
        const [status, library] = await Promise.all([
          api('/api/voix/media-vault/status'),
          api('/api/voix/media-vault/clips')
        ]);
        renderMediaVaultStatus(status, { trustedCandidateId: true });
        renderMediaVaultClips(library.clips || []);
      } catch (error) {
        mediaVaultStatus = null;
        mediaVaultCandidateId = '';
        const pill = document.getElementById('voiceMediaVaultPill');
        pill.textContent = 'unavailable';
        pill.className = 'pill down';
        document.getElementById('voiceMediaClips').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      } finally {
        mediaVaultBusy = false;
        updateMediaVaultGates();
      }
    };
    [mediaVaultCategory, mediaVaultSubject].forEach((node) => node.addEventListener('change', updateMediaVaultGates));
    [mediaVaultConsent, mediaVaultGuardian, mediaVaultResearch].forEach((node) => node.addEventListener('change', updateMediaVaultGates));
    mediaVaultSpeaker.addEventListener('input', updateMediaVaultGates);
    mediaVaultDrawer.addEventListener('toggle', () => {
      if (mediaVaultDrawer.open) refreshMediaVault();
    });
    document.getElementById('voiceMediaRefresh').addEventListener('click', refreshMediaVault);
    document.getElementById('voiceMediaForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      updateMediaVaultGates();
      if (mediaVaultSave.disabled || mediaVaultBusy) return;
      mediaVaultBusy = true;
      updateMediaVaultGates();
      try {
        await api('/api/voix/media-vault/clips', {
          method: 'POST',
          body: JSON.stringify({
            candidateId: mediaVaultCandidateId,
            category: mediaVaultCategory.value,
            subjectKind: mediaVaultSubject.value,
            speakerLabel: mediaVaultSpeaker.value,
            label: document.getElementById('voiceMediaLabel').value,
            consent: mediaVaultConsent.checked,
            guardianApproved: mediaVaultGuardian.checked,
            researchConsent: mediaVaultResearch.checked
          })
        });
        mediaVaultCandidateId = '';
        mediaVaultConsent.checked = false;
        toast('One encrypted voice evidence clip saved');
      } catch (error) {
        toast(error.message);
      } finally {
        mediaVaultBusy = false;
        await refreshMediaVault();
      }
    });
    document.getElementById('voiceMediaClips').addEventListener('click', async (event) => {
      const listen = event.target.closest('[data-voice-media-listen]');
      const remove = event.target.closest('[data-voice-media-delete]');
      if (!listen && !remove) return;
      const clipId = (listen || remove).dataset[listen ? 'voiceMediaListen' : 'voiceMediaDelete'];
      if (listen) {
        stopPlayback();
        const audio = new Audio(`/api/voix/media-vault/clips/${encodeURIComponent(clipId)}/audio`);
        state.activeAudio = audio;
        audio.addEventListener('ended', () => {
          if (state.activeAudio === audio) state.activeAudio = null;
        }, { once: true });
        try { await audio.play(); }
        catch (error) { stopPlayback(); toast(error.message); }
        return;
      }
      if (!window.confirm('Delete this encrypted voice evidence clip? This cannot be undone.')) return;
      try {
        await api(`/api/voix/media-vault/clips/${encodeURIComponent(clipId)}`, { method: 'DELETE' });
        toast('Encrypted voice evidence clip deleted');
        await refreshMediaVault();
      } catch (error) { toast(error.message); }
    });
    const ttsText = document.getElementById('ttsText');
    const updateTtsLanguage = () => {
      const profile = window.NestorSpeech.speechProfile(ttsText.value);
      document.getElementById('ttsLanguage').textContent = `${profile.label} text · ${profile.label} voice`;
    };
    ttsText.addEventListener('input', updateTtsLanguage);
    updateTtsLanguage();
    document.getElementById('ttsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const language = window.NestorSpeech.speechProfile(ttsText.value).language;
      await speak(ttsText.value, language, { provider: document.getElementById('voiceTTS').value,
        voice: document.getElementById(language === 'fr' ? 'voiceTTSFrench' : 'voiceTTSEnglish').value, native_defaults: true });
    });
    document.getElementById('browserSpeak').addEventListener('click', () => {
      const profile = window.NestorSpeech.speechProfile(ttsText.value);
      stopPlayback();
      browserSpeak(ttsText.value, profile);
    });

    let controlBusy = false;
    const runVoiceControl = async (action) => {
      if (controlBusy) return;
      controlBusy = true;
      try {
        await api(`/api/voix/sessions/${action}`, { method: 'POST', body: '{}' });
        toast(action === 'start' ? 'Nestor is starting the microphone' : action === 'stop' ? 'Voice session stopped' : 'Current turn interrupted');
        await refreshNativeSession();
      } catch (error) {
        toast(error.message);
      } finally {
        controlBusy = false;
      }
    };
    document.getElementById('voiceStart').addEventListener('click', () => runVoiceControl('start'));
    document.getElementById('voiceStop').addEventListener('click', () => runVoiceControl('stop'));
    document.getElementById('voiceCancel').addEventListener('click', () => runVoiceControl('cancel'));
    document.getElementById('voiceConversationApply').addEventListener('click', async () => {
      if (controlBusy) return;
      controlBusy = true;
      const applyButton = document.getElementById('voiceConversationApply');
      applyButton.disabled = true;
      const mode = conversationSelector.value === 'dad' ? 'dad' : 'family';
      try {
        conversationNoteOverride = '';
        const result = await api('/api/voix/config/conversation-mode', {
          method: 'POST',
          body: JSON.stringify({ mode })
        });
        renderConversationMode(result.mode);
        memoryLastRefreshAt = 0;
        await refreshVoiceMemory(true);
        toast(mode === 'dad' ? 'Dad mode explicitly activated for the next session' : 'Family mode selected');
      } catch (error) {
        conversationSelectionDirty = false;
        conversationSelector.value = activeConversationMode;
        document.getElementById('voiceConversationApply').textContent = activeConversationMode === 'family' ? 'Use Family' : 'Activate Dad';
        conversationNoteOverride = error.status === 409
          ? 'Stop the current session first. Its context stays inside the current Family or Dad boundary.'
          : error.message;
        document.getElementById('voiceConversationNote').textContent = conversationNoteOverride;
        toast(error.message);
      } finally {
        controlBusy = false;
        applyButton.disabled = false;
      }
    });
    document.getElementById('voicePersonalityApply').addEventListener('click', async () => {
      const selector = document.getElementById('voicePersonality');
      if (!selector.value) return;
      try {
        const result = await api('/api/voix/config/personality', { method: 'POST', body: JSON.stringify({ persona: selector.value }) });
        const profile = (configResult.status === 'fulfilled' ? configResult.value.static?.nestor_personalities || [] : []).find((entry) => entry.id === result.persona);
        document.getElementById('voicePersona').textContent = profile?.label || result.persona;
        document.getElementById('voicePersonalityName').textContent = profile?.label || 'Nestor';
        document.getElementById('voicePersonalityDescription').textContent = profile?.description || 'Native Nestor conversation profile.';
        document.getElementById('voicePersonalityNote').textContent = result.applies === 'immediately' ? 'Ready now.' : 'Saved. Stop and start the session to use it.';
        toast('Personality saved');
      } catch (error) {
        toast(error.message);
      }
    });

    document.getElementById('voiceTTSApply').addEventListener('click', async () => {
      const button = document.getElementById('voiceTTSApply');
      const selector = document.getElementById('voiceTTS');
      button.disabled = true;
      selector.disabled = true;
      try {
        const result = await api('/api/voix/config/tts', { method: 'POST', body: JSON.stringify({ tts_provider: selector.value, tts_voice_fr: document.getElementById('voiceTTSFrench').value, tts_voice_en: document.getElementById('voiceTTSEnglish').value, persist: true }) });
        const timbre = document.getElementById('voiceTimbre');
        timbre.textContent = selector.selectedOptions[0].textContent;
        timbre.title = timbre.textContent;
        document.getElementById('voiceTTSNote').textContent = result.saved ? 'Voice preferences saved across restarts. ' + (result.applies === 'immediately' ? 'Ready for the next session.' : 'Stop and start to apply them.') : 'Applied for this process only.';
        toast('Voice saved');
      } catch (error) {
        document.getElementById('voiceTTSNote').textContent = error.message;
        toast(error.message);
      } finally {
        button.disabled = false;
        selector.disabled = false;
      }
    });

    const formatMs = (value) => Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : '—';
    const latest = (events, type) => [...events].reverse().find((event) => event.type === type);
    const renderExecution = (events) => {
      const receipts = latest(events, 'agent_tools')?.receipts || [];
      for (const [id, selected] of [
        ['voiceToolsState', receipts],
        ['voiceSkillsState', receipts.filter(row => /skill/.test(row.tool))],
        ['voiceAgentsState', receipts.filter(row => /sessions_spawn|subagent|delegate/.test(row.tool))]
      ]) {
        const node = document.getElementById(id);
        node.textContent = selected.length ? selected.map(row => row.tool + ' · ' + row.status).join(', ') : 'no receipt';
        node.className = selected.length ? 'active' : '';
      }
      return receipts.length;
    };
    const eventDetail = (event) => {
      if (event.type === 'inference_route') return [event.task_type, event.host_key, event.model].filter(Boolean).join(' · ');
      if (event.type === 'transcript' || event.type === 'clause' || event.type === 'reply') return event.text || '';
      if (event.type === 'state') return event.state || '';
      if (event.type === 'wake_ignored') return 'room speech discarded before transcript, memory, AgentX, and TTS';
      if (event.type === 'wake_waiting') return 'local wake gate armed; address Nestor to open the follow-up window';
      if (event.type === 'session_started') return [event.conversation_mode, event.brain, event.persona, event.lane].filter(Boolean).join(' · ');
      if (event.type === 'session_warming') return `warming ${event.stage || 'models'}`;
      if (event.type === 'session_ready') return [[event.input_device_resolved || event.input_device, event.output_device_resolved || event.output_device].filter(Boolean).join(' → '), event.barge_in_mode?.replaceAll('_', ' ')].filter(Boolean).join(' · ');
      if (event.type === 'playback_echo_rejected') return `blocked “${event.text || 'recent TTS'}” · ${Math.round((Number(event.similarity) || 0) * 100)}% match`;
      if (event.type === 'speech_ended') return `${formatMs(event.duration_ms)} · RMS ${event.rms ?? '—'}`;
      if (event.type === 'first_token' || event.type === 'first_clause' || event.type === 'tts_first_chunk') return formatMs(event.ms);
      if (event.type === 'inference_completed') return event.completion_tokens ? `${event.completion_tokens} tokens` : 'complete';
      if (event.type === 'memory_context') return `${event.recalled || 0} approved note${event.recalled === 1 ? '' : 's'} recalled`;
      if (event.type === 'memory_committed') return `turn ${event.sequence || '—'} safely queued`;
      if (event.type === 'memory_synchronized') return `${event.delivered || 0} delivered · ${event.pending || 0} pending`;
      if (event.type === 'memory_commit_failed' || event.type === 'memory_sync_degraded') return event.message || 'memory continuity stopped safely';
      if (event.type === 'media_candidate_ready') return `${formatMs(event.duration_ms)} · RAM only · ${Math.round(Number(event.expires_in_seconds) || 0)} s to opt in`;
      if (event.type === 'media_clip_saved') return `${String(event.category || 'evidence').replaceAll('-', ' ')} · encrypted locally · no identity authority`;
      if (event.type === 'media_clip_deleted') return 'encrypted evidence removed';
      if (/(^|_)(tool|skill|agent|delegate|handoff)(s)?(_|$)/.test(String(event.type || ''))) {
        return [event.name || event.tool || event.skill || event.agent, event.state || event.status, formatMs(event.duration_ms)].filter((value) => value && value !== '—').join(' · ');
      }
      if (event.type === 'error') return event.message || 'turn failed safely';
      return event.reason || '';
    };
    const renderStages = (session, events) => {
      const stages = {
        voiceStageListen: events.some((event) => event.type === 'speech_started'),
        voiceStageStt: events.some((event) => event.type === 'transcript'),
        voiceStageRoute: events.some((event) => event.type === 'inference_route'),
        voiceStageLlm: events.some((event) => ['first_token', 'inference_completed'].includes(event.type)),
        voiceStageTts: events.some((event) => event.type === 'tts_first_chunk'),
        voiceStagePlayback: events.some((event) => event.type === 'reply')
      };
      Object.entries(stages).forEach(([id, done]) => {
        const node = document.getElementById(id);
        node.classList.toggle('done', done);
        node.classList.remove('active');
      });
      const active = {
        listening: 'voiceStageListen', transcribing: 'voiceStageStt', thinking: 'voiceStageLlm', speaking: 'voiceStagePlayback'
      }[session.state];
      if (active) document.getElementById(active).classList.add('active');
    };
    let nativeRefreshTimer = null;
    let nativeRefreshInFlight = false;
    let nativeRefreshFailures = 0;
    let memoryLastRefreshAt = 0;
    const memoryPill = (state) => state === 'synchronized' ? 'pill ok' : state === 'processing' || state === 'pending' ? 'pill waiting' : 'pill down';
    const renderMemoryItems = (candidates, memories) => {
      const candidateRoot = document.getElementById('voiceMemoryCandidates');
      const activeRoot = document.getElementById('voiceMemoryActive');
      candidateRoot.innerHTML = candidates.length
        ? candidates.map((item) => `<div class="voice-memory-item"><div><strong>${esc(item.statement)}</strong><small>${esc(item.type.replaceAll('_', ' '))} · review required</small></div><div class="row"><button type="button" data-memory-approve="${esc(item.id)}">Keep</button><button type="button" data-memory-reject="${esc(item.id)}">Discard</button></div></div>`).join('')
        : '<div class="empty">Nothing waiting for review.</div>';
      activeRoot.innerHTML = memories.length
        ? memories.map((item) => `<div class="voice-memory-item"><div><strong>${esc(item.text)}</strong><small>${esc(item.source || 'private memory')}</small></div><button type="button" data-memory-forget="${esc(item.id)}">Forget</button></div>`).join('')
        : '<div class="empty">No approved private memories yet.</div>';
    };
    const refreshVoiceMemory = async (force = false) => {
      if (activeConversationMode === 'family') {
        document.getElementById('voiceMemoryState').textContent = 'household';
        document.getElementById('voiceMemoryState').className = 'pill ok';
        document.getElementById('voiceMemoryOutbox').textContent = 'per completed turn';
        document.getElementById('voiceMemoryArchive').textContent = 'Household-owned';
        document.getElementById('voiceMemoryProposed').textContent = 'Parent-visible';
        return;
      }
      if (!force && Date.now() - memoryLastRefreshAt < 15000) return;
      memoryLastRefreshAt = Date.now();
      try {
        const status = await api('/api/voix/memory/status');
        document.getElementById('voiceMemoryState').textContent = status.state || 'unknown';
        document.getElementById('voiceMemoryState').className = memoryPill(status.state);
        document.getElementById('voiceMemoryArchive').textContent = `${status.activeMemories || 0} approved`;
        document.getElementById('voiceMemoryProposed').textContent = String(status.proposed || 0);
        if (memoryReviewOpen) {
          const [candidateData, activeData] = await Promise.all([
            api('/api/voix/memory/candidates?status=proposed'),
            api('/api/voix/memory/active')
          ]);
          renderMemoryItems(candidateData.candidates || [], activeData.memories || []);
        }
      } catch (error) {
        document.getElementById('voiceMemoryState').textContent = 'unavailable';
        document.getElementById('voiceMemoryState').className = 'pill down';
        document.getElementById('voiceMemoryArchive').textContent = error.status === 429 ? 'cooling down' : 'unavailable';
      }
    };
    document.getElementById('voiceMemoryReviewToggle').addEventListener('click', async () => {
      if (activeConversationMode !== 'dad') return;
      memoryReviewOpen = !memoryReviewOpen;
      document.getElementById('voiceMemoryReview').hidden = !memoryReviewOpen;
      document.getElementById('voiceMemoryReviewToggle').setAttribute('aria-expanded', String(memoryReviewOpen));
      if (memoryReviewOpen) await refreshVoiceMemory(true);
    });
    document.getElementById('voiceMemoryReview').addEventListener('click', async (event) => {
      if (activeConversationMode !== 'dad') return;
      const approve = event.target.closest('[data-memory-approve]');
      const reject = event.target.closest('[data-memory-reject]');
      const forget = event.target.closest('[data-memory-forget]');
      if (!approve && !reject && !forget) return;
      try {
        if (approve || reject) {
          const target = approve || reject;
          await api(`/api/voix/memory/candidates/${encodeURIComponent(target.dataset[approve ? 'memoryApprove' : 'memoryReject'])}/review`, {
            method: 'POST', body: JSON.stringify({ action: approve ? 'approve' : 'reject' })
          });
          toast(approve ? 'Memory approved' : 'Suggestion discarded');
        } else {
          await api(`/api/voix/memory/${encodeURIComponent(forget.dataset.memoryForget)}/forget`, { method: 'POST', body: '{}' });
          toast('Memory forgotten');
        }
        memoryLastRefreshAt = 0;
        await refreshVoiceMemory(true);
      } catch (error) { toast(error.message); }
    });
    const scheduleNativeRefresh = (delayMs) => {
      clearTimeout(nativeRefreshTimer);
      if (document.hidden || location.pathname !== '/voice/native') return;
      nativeRefreshTimer = setTimeout(refreshNativeSession, delayMs);
    };
    const refreshNativeSession = async () => {
      clearTimeout(nativeRefreshTimer);
      if (nativeRefreshInFlight || document.hidden || location.pathname !== '/voice/native') return;
      nativeRefreshInFlight = true;
      let nextRefreshMs = 3000;
      try {
        const snapshot = await api('/api/voix/sessions/snapshot');
        const session = snapshot.session || {};
        const events = snapshot.events || [];
        if (!conversationSelectionDirty && session.conversation?.mode) {
          renderConversationMode(session.conversation.mode);
        }
        nativeRefreshFailures = 0;
        nextRefreshMs = ['warming', 'transcribing', 'thinking', 'speaking'].includes(session.state) ? 750 : 3000;
        setRuntime(true, 'voice ready');
        document.getElementById('voixHealth').textContent = 'VoiX online';
        document.getElementById('voixHealth').className = 'pill ok';
        document.getElementById('voiceLiveState').textContent = session.running
          ? session.state === 'warming'
            ? `warming · ${session.warmup?.stage || 'models'}`
            : session.state || 'running'
          : 'session stopped';
        document.getElementById('voiceOrb').dataset.state = session.running ? session.state || 'running' : 'idle';
        const wake = session.wake || {};
        document.getElementById('voiceWakeState').textContent = wake.enabled
          ? `${wake.state || 'armed'} · local gate`
          : 'available · session off';
        document.getElementById('voiceStart').disabled = session.running || controlBusy;
        document.getElementById('voiceStop').disabled = !session.running || controlBusy;
        document.getElementById('voiceCancel').disabled = !session.running || !['thinking', 'speaking', 'transcribing'].includes(session.state) || controlBusy;
        document.getElementById('voiceSessionSummary').textContent = session.sessionId
          ? `${activeConversationMode === 'family' ? 'Family' : 'Dad'} · ${session.turns} completed turn${session.turns === 1 ? '' : 's'} · ${session.sessionId.slice(0, 12)}`
          : 'No native session is active.';
        const contextTurns = Math.min(6, Math.max(0, Number(session.turns) || 0));
        document.getElementById('voiceContextDepth').textContent = `${contextTurns} / 6 turns`;
        const outbox = session.memory || {};
        document.getElementById('voiceMemoryOutbox').textContent = activeConversationMode === 'family'
          ? 'per completed turn'
          : !outbox.enabled
            ? 'disabled'
            : outbox.pending
              ? `${outbox.pending} pending`
              : 'synchronized';
        if (activeConversationMode === 'dad' && outbox.enabled && outbox.state === 'error') {
          document.getElementById('voiceMemoryState').textContent = 'local error';
          document.getElementById('voiceMemoryState').className = 'pill down';
        }
        document.getElementById('voiceTranscript').textContent = session.lastTranscript || 'Waiting for speech…';
        document.getElementById('voiceReply').textContent = session.lastReply || 'Ready when you are.';
        const metrics = session.metrics || {};
        const signal = session.inputSignal || {};
        const signalLevel = Math.max(0, Math.min(100, Math.round(Math.max(Number(signal.rms) * 1200, Number(signal.peak) * 400) || 0)));
        const signalNode = document.getElementById('voiceSignal');
        const signalLabel = document.getElementById('voiceSignalLabel');
        const signalTrack = document.getElementById('voiceSignalTrack');
        document.getElementById('voiceSignalMeter').style.width = `${signalLevel}%`;
        signalTrack.setAttribute('aria-valuenow', String(signalLevel));
        if (!session.running || signal.ageMs == null) {
          signalNode.dataset.signal = 'waiting';
          signalLabel.textContent = session.running ? 'opening stream' : 'session stopped';
        } else if (signal.suppressedForPlayback) {
          signalNode.dataset.signal = 'suppressed';
          signalLabel.textContent = 'Nestor speaking · mic ignored';
        } else if (signal.recentEnergy) {
          signalNode.dataset.signal = signal.speechLikely ? 'speech' : 'energy';
          signalLabel.textContent = signal.speechLikely ? 'speech detected' : 'microphone responded';
        } else {
          signalNode.dataset.signal = 'quiet';
          signalLabel.textContent = 'stream live · room quiet';
        }
        const speechConfidence = signal.vadProbability == null ? null : Math.round(Number(signal.vadProbability) * 100);
        document.getElementById('voiceSignalDetail').textContent = signal.suppressedForPlayback
          ? 'Room-speaker feedback is excluded. Use Interrupt to stop Nestor.'
          : `${signalLevel}% live level${speechConfidence == null ? '' : ` · ${speechConfidence}% speech confidence`} · audio ephemeral`;
        document.getElementById('voiceArchivePersistence').textContent = session.archive?.enabled
          ? (session.conversation?.mode === 'dad' ? 'text only · no audio' : 'aggregate only · no audio')
          : 'not active';
        renderMediaVaultStatus(session.mediaVault || {});
        document.getElementById('voiceMetricStt').textContent = formatMs(metrics.stt_ms);
        document.getElementById('voiceMetricToken').textContent = formatMs(metrics.first_token_ms);
        document.getElementById('voiceMetricTts').textContent = formatMs(metrics.tts_first_chunk_ms);
        document.getElementById('voiceMetricAudio').textContent = formatMs(metrics.first_audio_ms);
        document.getElementById('voiceMetricDone').textContent = formatMs(metrics.reply_done_ms);
        const route = latest(events, 'inference_route');
        const ready = latest(events, 'session_ready');
        const rejectedEchoes = events.filter((event) => event.type === 'playback_echo_rejected');
        const echoGuard = document.getElementById('voiceEchoGuard');
        echoGuard.textContent = rejectedEchoes.length
          ? `${rejectedEchoes.length} feedback echo${rejectedEchoes.length === 1 ? '' : 'es'} blocked`
          : ready?.barge_in_mode === 'speaker_safe'
            ? 'speaker-safe · use Interrupt'
            : ready?.barge_in_mode === 'headset_full_duplex'
              ? 'headset · full-duplex'
              : ready?.barge_in_mode === 'disabled'
                ? 'barge-in disabled'
                : 'feedback guard armed';
        echoGuard.className = 'pill ok';
        document.getElementById('voiceInputConfigured').textContent = ready?.input_device_configured || ready?.input_device || 'waiting';
        document.getElementById('voiceInputResolved').textContent = ready?.input_device_resolved || 'legacy receipt';
        document.getElementById('voiceOutputResolved').textContent = ready?.output_device_resolved || ready?.output_device || 'waiting for session';
        document.getElementById('voiceDeviceBinding').textContent = ready?.input_device_resolved && ready?.output_device_resolved
          ? 'proven at session start'
          : 'restart for exact proof';
        document.getElementById('voiceDeviceHint').textContent = ready?.input_device_resolved
          ? `This session opened ${ready.input_device_resolved} and ${ready.output_device_resolved || 'the reported output'}. Stop and start after changing Windows audio devices.`
          : 'The current receipt predates exact device proof. Stop and start this native session to rebind and identify both endpoints.';
        document.getElementById('voiceRouteTask').textContent = route?.task_type || 'discussion';
        document.getElementById('voiceRouteHost').textContent = route?.host_key || 'pending next turn';
        document.getElementById('voiceRouteModel').textContent = route?.model || 'pending next turn';
        document.getElementById('voiceRouteSource').textContent = route?.routing_source || 'bounded AgentX route';
        const executionReceipts = renderExecution(events);
        document.getElementById('voiceLane').textContent = executionReceipts
          ? `action · ${executionReceipts} execution receipt${executionReceipts === 1 ? '' : 's'}`
          : session.conversation?.toolsEnabled ? 'personal agent · tools available' : 'scoped conversation';
        renderStages(session, events);
        document.getElementById('voiceEventCount').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
        document.getElementById('voiceEvents').innerHTML = events.length
          ? events.slice(-40).reverse().map((event) => `<div class="voice-event"><span class="voice-event-dot ${/(^|_)(tool|skill|agent|delegate|handoff)(s)?(_|$)/.test(String(event.type || '')) ? 'execution ' : ''}${esc(event.type)}"></span><div><strong>${esc(event.type.replaceAll('_', ' '))}</strong><small>${esc(eventDetail(event))}</small></div><time>${esc(event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '')}</time></div>`).join('')
          : '<div class="empty">No events in this in-memory session yet.</div>';
        const mediaCandidate = latest(events, 'media_candidate_ready');
        const mediaCandidateReceipt = mediaCandidate
          ? `${mediaCandidate.timestamp || ''}:${mediaCandidate.duration_ms || ''}:${mediaCandidate.expires_in_seconds || ''}`
          : '';
        if (mediaVaultDrawer.open && mediaCandidateReceipt && mediaCandidateReceipt !== lastMediaCandidateReceipt) {
          lastMediaCandidateReceipt = mediaCandidateReceipt;
          await refreshMediaVault();
        }
        await refreshVoiceMemory();
      } catch (error) {
        nativeRefreshFailures += 1;
        if (error.status === 429) {
          nextRefreshMs = Math.max(error.retryAfterMs || 15000, 15000);
          setRuntime('waiting', 'cockpit cooling down');
          document.getElementById('voiceLiveState').textContent = 'display paused · retrying';
          document.getElementById('voixHealth').textContent = 'VoiX state unchanged';
          document.getElementById('voixHealth').className = 'pill waiting';
        } else {
          nextRefreshMs = Math.min(30000, 3000 * (2 ** Math.min(nativeRefreshFailures, 3)));
          document.getElementById('voiceLiveState').textContent = 'session evidence unavailable';
          document.getElementById('voiceOrb').dataset.state = 'error';
          document.getElementById('voiceEvents').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
        }
      } finally {
        nativeRefreshInFlight = false;
        scheduleNativeRefresh(nextRefreshMs);
      }
    };
    await refreshNativeSession();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(nativeRefreshTimer);
      else refreshNativeSession();
    });
  }

  function deviceTemplate() {
    return `<section class="hero device-hero"><div class="hero-copy"><p class="eyebrow">Surface Phase 0 · physical evidence</p><h1>Prove this device.</h1><p class="lede">Run every check on the real household Surface. Browser observations and explicit physical confirmations become one bounded receipt; no audio or transcript is retained.</p><div class="row wrap"><a class="button" href="/panel">Open Panel</a><a class="button" href="/lecture">Open Reader</a><a class="button" href="/dad/family">Open Journal</a></div></div><aside class="hero-copy hero-status"><div><span id="deviceStatus" class="pill">loading contract</span><p id="deviceLatest" class="muted">No physical claim has been made.</p></div><div><strong id="deviceProgress">0/0</strong><span class="muted"> checks witnessed</span></div></aside></section>
      <section class="device-layout"><article class="card full"><div class="row"><div class="grow"><p class="card-kicker">Privacy-safe run</p><h2>Device identity</h2><p class="muted">Use a stable label and the name of the adult physically witnessing this run. Partial progress stays only in this browser tab; a refresh can resume the same run for up to two hours, and no partial receipt reaches the server.</p></div><span class="pill">push-to-talk only</span></div><div class="acceptance-fields"><label><span>Device label</span><input id="deviceLabel" value="Household Surface" maxlength="80" autocomplete="off"></label><label><span>Confirmed by</span><input id="deviceConfirmedBy" maxlength="60" placeholder="Adult witness" autocomplete="off"></label></div></article>
      <article class="card full"><p class="card-kicker">Browser witnessed</p><h2>Live device checks</h2><p class="muted">These controls require real browser events. A mouse click does not count as touch, and typing does not count as a reconnect or resume.</p><div id="deviceObserved" class="acceptance-grid"></div></article>
      <article class="card full"><p class="card-kicker">Adult confirmed</p><h2>Whole-panel checks</h2><p class="muted">Complete the linked Panel, Reader, Journal, secretary, output-device, and admin-verifier steps before checking these declarations.</p><div id="deviceConfirmed" class="acceptance-grid"></div></article>
      <article class="card full"><div class="row"><div class="grow"><p class="card-kicker">Separate native capability</p><h2>Wake gate stays outside Phase 0</h2><p class="muted">The native VoiX wake gate is available after an explicit session start and has its own acoustic acceptance. It does not count toward this Surface push-to-talk receipt.</p></div><span class="pill ok">available separately</span></div></article>
      <article class="card full acceptance-submit"><div><h2>Record the receipt</h2><p class="muted">The button stays closed until all checks pass and both identity fields are filled. Submission stores evidence labels, timestamps, device facts, and a SHA-256 fingerprint—never audio or recognized words.</p></div><button id="deviceSubmit" class="primary" disabled>Record Phase 0 acceptance</button></article></section>`;
  }

  async function loadDeviceCheck() {
    const draftKey = 'agentx:surface-phase0-draft:v1';
    const draftMaxAgeMs = 2 * 60 * 60 * 1000;
    const alwaysRecheck = new Set(['trusted_https', 'viewport_layout']);
    app.innerHTML = deviceTemplate();
    let runStartedAt = new Date();
    let runId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    const evidence = new Map();
    let requirements = [];
    let captureBusy = false;
    let speakerFinished = false;
    let muteAudio = null;
    let offlineSeenAt = null;
    let hiddenSeen = false;

    const observedControls = {
      trusted_https: '<p>Checked automatically from this page.</p>',
      viewport_layout: '<p>Checked automatically after the acceptance layout renders.</p>',
      microphone_transcription: '<p>Say a short phrase. The live waveform proves that this device is hearing you; only the recognized word count is kept in this page.</p><div class="mic-waveform-shell"><canvas id="deviceMicWaveform" class="mic-waveform" width="640" height="96" aria-label="Live microphone waveform"></canvas><span id="deviceMicSignal" class="mic-signal" aria-live="polite">The waveform appears only while recording and is not retained.</span></div><button id="deviceMic">Start microphone</button>',
      microphone_mute: '<p>Start a capture, watch for a live signal, then mute it. The sample is discarded without transcription.</p><div class="mic-waveform-shell"><canvas id="deviceMuteWaveform" class="mic-waveform" width="640" height="96" aria-label="Live mute-test waveform"></canvas><span id="deviceMuteSignal" class="mic-signal" aria-live="polite">No recording is kept and this test never requests transcription.</span></div><button id="deviceMicMute">Start mute test</button>',
      speaker_playback: '<p>Play the fixed local phrase, then confirm that you heard it from the intended speaker.</p><div class="row wrap"><button id="deviceSpeaker">Play phrase</button><label class="inline-check"><input id="deviceSpeakerHeard" type="checkbox" disabled> I heard the whole phrase</label></div>',
      output_mute: '<p>Start the longer phrase, wait for sound, then stop it while it is speaking.</p><div class="row wrap"><button id="deviceMuteStart">Start mute test</button><button id="deviceMuteStop" disabled>Stop sound now</button></div>',
      touch_input: '<p>Touch the pad with a finger. Mouse and trackpad events are ignored.</p><button id="deviceTouchPad" class="interaction-pad">Touch here</button>',
      keyboard_input: '<p>Focus this field and press any letter or number.</p><input id="deviceKeyboard" maxlength="1" placeholder="Press one key" autocomplete="off">',
      offline_recovery: '<p>With no capture or audio active, disconnect networking, wait for the offline state, reconnect, and leave this page open.</p><span id="deviceNetworkHint" class="muted">Waiting for a real offline event…</span>',
      resume_recovery: '<p>Lock/sleep the Surface or switch away, then return to this page. A successful Panel status read completes the check.</p><span id="deviceResumeHint" class="muted">Waiting for hidden → visible…</span>'
    };
    const confirmationText = {
      kiosk_launch: 'I cold-booted this Surface: the dedicated session reached full-screen Panel with no certificate warning.',
      reader_journal: 'I used Reader by touch and opened Journal with both touch and keyboard.',
      secretary_flow: 'I created one unique disposable personal task and proved the two-touch completion removed only that task.',
      output_device: 'I changed the Windows default output device and the next Nestor phrase followed it.',
      family_surface: 'I closed diagnostics and confirmed that operator links and detailed service cards stayed out of the family home.',
      admin_verifier: 'From the admin PC, verify-post-reboot.ps1 reported every automated check PASS for this Surface.'
    };

    function checkCard(requirement, content) {
      return `<section class="acceptance-check" data-check="${esc(requirement.id)}"><div class="check-heading"><strong>${esc(requirement.label)}</strong><span class="pill">waiting</span></div>${content}</section>`;
    }

    function updateProgress() {
      const passed = requirements.filter((requirement) => evidence.has(requirement.id)).length;
      document.getElementById('deviceProgress').textContent = `${passed}/${requirements.length}`;
      const identityReady = document.getElementById('deviceLabel').value.trim().length >= 2
        && document.getElementById('deviceConfirmedBy').value.trim().length >= 2;
      document.getElementById('deviceSubmit').disabled = passed !== requirements.length || !identityReady;
    }

    function requirementSignature() {
      return requirements.map((requirement) => `${requirement.id}:${requirement.mode}`).join('|');
    }

    function clearDraft() {
      try { sessionStorage.removeItem(draftKey); } catch (_error) { /* storage can be unavailable */ }
    }

    function persistDraft() {
      if (!requirements.length) return;
      try {
        const checks = requirements
          .filter((requirement) => !alwaysRecheck.has(requirement.id) && evidence.has(requirement.id))
          .map((requirement) => {
            const check = evidence.get(requirement.id);
            return {
              id: check.id,
              passed: true,
              evidenceCode: check.evidenceCode,
              observedAt: check.observedAt
            };
          });
        sessionStorage.setItem(draftKey, JSON.stringify({
          schemaVersion: 1,
          origin: location.origin,
          requirementSignature: requirementSignature(),
          runId,
          startedAt: runStartedAt.toISOString(),
          savedAt: new Date().toISOString(),
          deviceLabel: document.getElementById('deviceLabel').value.slice(0, 80),
          confirmedBy: document.getElementById('deviceConfirmedBy').value.slice(0, 60),
          checks
        }));
      } catch (_error) { /* the physical run remains usable without storage */ }
    }

    function renderRequirementState(requirementId, passed) {
      const card = document.querySelector(`[data-check="${requirementId}"]`);
      if (!card) return;
      card.classList.toggle('passed', passed);
      const pill = card.querySelector('.pill');
      pill.textContent = passed ? 'passed' : 'waiting';
      pill.className = passed ? 'pill ok' : 'pill';
    }

    function restoreDraft() {
      let draft;
      try {
        const serialized = sessionStorage.getItem(draftKey);
        if (!serialized) return 0;
        draft = JSON.parse(serialized);
      } catch (_error) {
        clearDraft();
        return 0;
      }

      const startedAtMs = Date.parse(draft?.startedAt);
      const now = Date.now();
      const validEnvelope = draft?.schemaVersion === 1
        && draft.origin === location.origin
        && draft.requirementSignature === requirementSignature()
        && typeof draft.runId === 'string'
        && /^[a-f0-9-]{20,80}$/i.test(draft.runId)
        && Number.isFinite(startedAtMs)
        && startedAtMs <= now + 5 * 60 * 1000
        && now - startedAtMs <= draftMaxAgeMs
        && typeof draft.deviceLabel === 'string'
        && draft.deviceLabel.length <= 80
        && typeof draft.confirmedBy === 'string'
        && draft.confirmedBy.length <= 60
        && Array.isArray(draft.checks);
      if (!validEnvelope) {
        clearDraft();
        return 0;
      }

      const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
      const uniqueIds = new Set();
      const validChecks = draft.checks.every((check) => {
        const requirement = requirementById.get(check?.id);
        const observedAtMs = Date.parse(check?.observedAt);
        if (!requirement || alwaysRecheck.has(requirement.id) || uniqueIds.has(requirement.id)) return false;
        uniqueIds.add(requirement.id);
        return check.passed === true
          && check.evidenceCode === `${requirement.mode}:${requirement.id}`
          && Number.isFinite(observedAtMs)
          && observedAtMs >= startedAtMs
          && observedAtMs <= now + 5 * 60 * 1000;
      });
      if (!validChecks) {
        clearDraft();
        return 0;
      }

      runId = draft.runId;
      runStartedAt = new Date(startedAtMs);
      document.getElementById('deviceLabel').value = draft.deviceLabel;
      document.getElementById('deviceConfirmedBy').value = draft.confirmedBy;
      draft.checks.forEach((check) => {
        evidence.set(check.id, check);
        renderRequirementState(check.id, true);
        const confirmation = document.querySelector(`[data-confirm-check="${check.id}"]`);
        if (confirmation) confirmation.checked = true;
      });
      return draft.checks.length;
    }

    function mark(requirementId, detail) {
      if (!requirements.some((requirement) => requirement.id === requirementId)) return;
      evidence.set(requirementId, {
        id: requirementId,
        passed: true,
        evidenceCode: `${requirements.find((requirement) => requirement.id === requirementId).mode}:${requirementId}`,
        localDetail: String(detail || 'passed').slice(0, 180),
        observedAt: new Date().toISOString()
      });
      renderRequirementState(requirementId, true);
      persistDraft();
      updateProgress();
    }

    function unmark(requirementId) {
      evidence.delete(requirementId);
      renderRequirementState(requirementId, false);
      persistDraft();
      updateProgress();
    }

    function cleanupAcceptanceAudio(audio, url) {
      if (state.activeAudio === audio) state.activeAudio = null;
      if (state.activeAudioUrl === url) state.activeAudioUrl = null;
      URL.revokeObjectURL(url);
    }

    function startAcceptanceWaveform(stream, canvasId, statusId) {
      const canvas = document.getElementById(canvasId);
      const status = document.getElementById(statusId);
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!canvas || !AudioContextClass) {
        if (status) status.textContent = 'Live waveform unavailable; capture can still complete safely.';
        return { stop: async () => {} };
      }

      let context;
      let source;
      let analyser;
      let animationFrame = 0;
      let stopped = false;
      let signalSeen = false;
      const drawContext = canvas.getContext('2d');
      if (!drawContext) {
        if (status) status.textContent = 'Live waveform unavailable; capture can still complete safely.';
        return { stop: async () => {} };
      }

      try {
        context = new AudioContextClass();
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        context.resume().catch(() => {});
      } catch (_error) {
        context?.close().catch(() => {});
        if (status) status.textContent = 'Live waveform unavailable; capture can still complete safely.';
        return { stop: async () => {} };
      }

      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        if (stopped) return;
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
        if (peak >= 4) signalSeen = true;

        drawContext.clearRect(0, 0, canvas.width, canvas.height);
        drawContext.fillStyle = '#07131d';
        drawContext.fillRect(0, 0, canvas.width, canvas.height);
        drawContext.strokeStyle = signalSeen ? '#55d9d0' : '#7693a5';
        drawContext.lineWidth = 3;
        drawContext.beginPath();
        const sliceWidth = canvas.width / Math.max(1, samples.length - 1);
        samples.forEach((value, index) => {
          const x = index * sliceWidth;
          const y = (value / 255) * canvas.height;
          if (index === 0) drawContext.moveTo(x, y);
          else drawContext.lineTo(x, y);
        });
        drawContext.stroke();
        canvas.classList.toggle('signal-seen', signalSeen);
        const signalMessage = signalSeen
          ? 'Voice signal detected live. Nothing from this waveform is retained.'
          : 'Listening for a voice signal…';
        if (status && status.textContent !== signalMessage) status.textContent = signalMessage;
        animationFrame = requestAnimationFrame(draw);
      };
      draw();

      return {
        signalSeen: () => signalSeen,
        stop: async (message = 'Capture stopped. Waveform discarded.') => {
          if (stopped) return;
          stopped = true;
          cancelAnimationFrame(animationFrame);
          source.disconnect();
          analyser.disconnect();
          samples.fill(128);
          canvas.classList.remove('signal-seen');
          drawContext.clearRect(0, 0, canvas.width, canvas.height);
          if (context.state !== 'closed') await context.close().catch(() => {});
          if (status) status.textContent = message;
        }
      };
    }

    async function acceptanceAudio(text, languageHint = '') {
      stopPlayback();
      const profile = window.NestorSpeech.speechProfile(text, languageHint);
      const response = await fetch('/api/voix/synthesize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: profile.language, voice: profile.nativeVoice, response_format: 'wav' })
      });
      if (!response.ok) throw new Error('Local Nestor speech is unavailable');
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      state.activeAudio = audio;
      state.activeAudioUrl = url;
      return { audio, url };
    }

    async function recover(checkId, hintId, detail) {
      const hint = document.getElementById(hintId);
      try {
        await api('/api/panel/status');
        mark(checkId, detail);
        if (hint) hint.textContent = 'Panel status recovered successfully.';
      } catch (error) {
        if (hint) hint.textContent = `Recovery read failed: ${error.message}. Repeat the cycle.`;
      }
    }

    const acceptance = await api('/api/household/device-acceptance/contract');
    requirements = acceptance.checks || [];
    document.getElementById('deviceStatus').textContent = acceptance.latest ? 'prior receipt exists' : 'physical acceptance pending';
    document.getElementById('deviceStatus').className = `pill ${acceptance.latest ? 'ok' : 'down'}`;
    document.getElementById('deviceLatest').textContent = acceptance.latest
      ? `${acceptance.latest.deviceLabel} passed ${new Date(acceptance.latest.completedAt).toLocaleString()} · ${acceptance.latest.fingerprint.slice(0, 12)}`
      : 'No stored Phase 0 receipt. This page does not infer a pass from software deployment.';
    document.getElementById('deviceObserved').innerHTML = requirements
      .filter((requirement) => requirement.mode === 'observed')
      .map((requirement) => checkCard(requirement, observedControls[requirement.id] || '<p>Browser observation required.</p>')).join('');
    document.getElementById('deviceConfirmed').innerHTML = requirements
      .filter((requirement) => requirement.mode === 'confirmed')
      .map((requirement) => checkCard(requirement, `<label class="confirmation"><input type="checkbox" data-confirm-check="${esc(requirement.id)}"> <span>${esc(confirmationText[requirement.id] || requirement.label)}</span></label>`)).join('');

    const restoredChecks = restoreDraft();
    const exactHttps = window.isSecureContext && location.protocol === 'https:';
    if (exactHttps) mark('trusted_https', `secure HTTPS origin ${location.origin}`);
    const fits = document.documentElement.scrollWidth <= window.innerWidth + 2;
    if (fits) mark('viewport_layout', `${window.innerWidth}x${window.innerHeight} CSS px; no horizontal overflow`);
    if (restoredChecks) toast(`Restored ${restoredChecks} physical check(s) from this tab. HTTPS and layout were rechecked now.`);

    document.querySelectorAll('[data-confirm-check]').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) mark(input.dataset.confirmCheck, 'adult witness explicitly confirmed the displayed declaration');
      else unmark(input.dataset.confirmCheck);
    }));
    ['deviceLabel', 'deviceConfirmedBy'].forEach((id) => document.getElementById(id).addEventListener('input', () => {
      persistDraft();
      updateProgress();
    }));

    document.getElementById('deviceTouchPad').addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') mark('touch_input', 'browser received pointerType=touch on the acceptance pad');
      else toast('That was not a touch event. Use a finger on the Surface screen.');
    });
    document.getElementById('deviceKeyboard').addEventListener('keydown', (event) => {
      if (event.key.length === 1) mark('keyboard_input', `physical keyboard event observed for key class ${/\d/.test(event.key) ? 'number' : 'character'}`);
    });

    const microphoneButton = document.getElementById('deviceMic');
    microphoneButton.addEventListener('click', async () => {
      if (microphoneButton.recording) {
        microphoneButton.recording.stop();
        return;
      }
      if (captureBusy) return toast('Finish the current microphone check first.');
      let stream = null;
      let waveform = null;
      try {
        captureBusy = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        waveform = startAcceptanceWaveform(stream, 'deviceMicWaveform', 'deviceMicSignal');
        const chunks = [];
        const recorder = new MediaRecorder(stream);
        microphoneButton.recording = recorder;
        recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((track) => track.stop());
          await waveform.stop('Capture stopped. Transcribing locally; waveform discarded.');
          microphoneButton.recording = null;
          microphoneButton.disabled = true;
          microphoneButton.textContent = 'Transcribing locally…';
          try {
            const text = await transcribe(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
            const words = text.trim().split(/\s+/).filter(Boolean).length;
            if (!words) throw new Error('No words were recognized');
            mark('microphone_transcription', `local transcription returned ${words} recognized word(s); words not retained`);
            microphoneButton.textContent = 'Microphone passed';
            document.getElementById('deviceMicSignal').textContent = `${words} word(s) recognized locally. Audio, transcript, and waveform were not retained.`;
          } catch (error) {
            microphoneButton.disabled = false;
            microphoneButton.textContent = 'Retry microphone';
            document.getElementById('deviceMicSignal').textContent = `No usable transcription returned: ${error.message}`;
            toast(error.message);
          } finally { captureBusy = false; }
        });
        recorder.start();
        microphoneButton.textContent = 'Stop and transcribe';
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        await waveform?.stop('Capture failed. No waveform was retained.');
        captureBusy = false;
        toast(error.message);
      }
    });

    const muteMicButton = document.getElementById('deviceMicMute');
    muteMicButton.addEventListener('click', async () => {
      if (muteMicButton.recording) {
        muteMicButton.discard = true;
        muteMicButton.recording.stop();
        return;
      }
      if (captureBusy) return toast('Finish the current microphone check first.');
      let stream = null;
      let waveform = null;
      try {
        captureBusy = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        waveform = startAcceptanceWaveform(stream, 'deviceMuteWaveform', 'deviceMuteSignal');
        const recorder = new MediaRecorder(stream);
        muteMicButton.recording = recorder;
        muteMicButton.discard = false;
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((track) => track.stop());
          await waveform.stop('Capture discarded without transcription. Waveform discarded too.');
          muteMicButton.recording = null;
          if (muteMicButton.discard) {
            mark('microphone_mute', 'active MediaRecorder stopped and sample was discarded before any transcription request');
            muteMicButton.textContent = 'Mute/discard passed';
            muteMicButton.disabled = true;
          }
          else {
            muteMicButton.textContent = 'Retry mute test';
            document.getElementById('deviceMuteSignal').textContent = 'Capture ended before explicit discard. Repeat this check.';
          }
          captureBusy = false;
        });
        recorder.start();
        muteMicButton.textContent = 'Mute and discard now';
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        await waveform?.stop('Capture failed. No waveform was retained.');
        captureBusy = false;
        toast(error.message);
      }
    });

    const speakerButton = document.getElementById('deviceSpeaker');
    const speakerHeard = document.getElementById('deviceSpeakerHeard');
    speakerButton.addEventListener('click', async () => {
      speakerFinished = false;
      speakerHeard.checked = false;
      speakerHeard.disabled = true;
      unmark('speaker_playback');
      try {
        const { audio, url } = await acceptanceAudio('Bonjour. Nestor parle maintenant sur le haut-parleur choisi.', 'fr');
        audio.addEventListener('ended', () => {
          speakerFinished = true;
          speakerHeard.disabled = false;
          cleanupAcceptanceAudio(audio, url);
          toast('Playback finished. Confirm only if you heard the whole phrase.');
        }, { once: true });
        await audio.play();
      } catch (error) {
        stopPlayback();
        toast(error.message);
      }
    });
    speakerHeard.addEventListener('change', () => {
      if (speakerHeard.checked && speakerFinished) mark('speaker_playback', 'fixed local phrase completed and adult witness confirmed it was audible');
      else unmark('speaker_playback');
    });

    const muteStart = document.getElementById('deviceMuteStart');
    const muteStop = document.getElementById('deviceMuteStop');
    muteStart.addEventListener('click', async () => {
      unmark('output_mute');
      muteStop.disabled = true;
      try {
        muteAudio = await acceptanceAudio('Ceci est le test de coupure du son. La phrase continue assez longtemps pour que tu puisses arrêter la lecture immédiatement avec le bouton visible.', 'fr');
        muteAudio.audio.addEventListener('timeupdate', () => {
          if (muteAudio && muteAudio.audio.currentTime > 0.1) muteStop.disabled = false;
        });
        const currentMuteAudio = muteAudio;
        muteAudio.audio.addEventListener('ended', () => {
          if (muteAudio === currentMuteAudio) {
            cleanupAcceptanceAudio(currentMuteAudio.audio, currentMuteAudio.url);
            muteAudio = null;
            muteStop.disabled = true;
            toast('The phrase ended before mute was observed. Start the test again.');
          }
        }, { once: true });
        await muteAudio.audio.play();
      } catch (error) { stopPlayback(); muteAudio = null; toast(error.message); }
    });
    muteStop.addEventListener('click', () => {
      if (!muteAudio || muteAudio.audio.currentTime <= 0.1) return;
      const { audio, url } = muteAudio;
      audio.pause();
      const stoppedAt = audio.currentTime;
      const stopped = audio.paused;
      audio.removeAttribute('src');
      audio.load();
      cleanupAcceptanceAudio(audio, url);
      muteAudio = null;
      muteStop.disabled = true;
      if (stopped) mark('output_mute', `active browser audio paused at ${stoppedAt.toFixed(2)} seconds and source was cleared`);
    });

    window.addEventListener('offline', () => {
      offlineSeenAt = new Date();
      document.getElementById('deviceNetworkHint').textContent = 'Offline observed. Reconnect networking now…';
    });
    window.addEventListener('online', () => {
      if (offlineSeenAt) recover('offline_recovery', 'deviceNetworkHint', `offline event followed by online event and healthy Panel read after ${Math.max(1, Math.round((Date.now() - offlineSeenAt.getTime()) / 1000))}s`);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenSeen = true;
        document.getElementById('deviceResumeHint').textContent = 'Hidden state observed. Return to this page…';
      } else if (hiddenSeen) {
        recover('resume_recovery', 'deviceResumeHint', 'hidden state followed by visible state and healthy Panel read');
      }
    });

    document.getElementById('deviceSubmit').addEventListener('click', async () => {
      const button = document.getElementById('deviceSubmit');
      button.disabled = true;
      try {
        const result = await api('/api/household/device-acceptance/receipts', {
          method: 'POST',
          body: JSON.stringify({
            runId,
            deviceLabel: document.getElementById('deviceLabel').value,
            confirmedBy: document.getElementById('deviceConfirmedBy').value,
            startedAt: runStartedAt.toISOString(),
            origin: location.origin,
            clientInfo: {
              platform: navigator.userAgentData?.platform || navigator.platform || 'unknown',
              locale: navigator.language || 'unknown',
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio || 1,
              secureContext: window.isSecureContext
            },
            checks: requirements.map((requirement) => {
              const check = evidence.get(requirement.id);
              return {
                id: check.id,
                passed: check.passed,
                evidenceCode: check.evidenceCode,
                observedAt: check.observedAt
              };
            })
          })
        });
        document.getElementById('deviceStatus').textContent = 'Phase 0 passed';
        document.getElementById('deviceStatus').className = 'pill ok';
        document.getElementById('deviceLatest').textContent = `${result.receipt.deviceLabel} · ${result.receipt.fingerprint}`;
        button.textContent = 'Acceptance recorded';
        clearDraft();
        setRuntime(true, 'device accepted');
      } catch (error) {
        toast(error.message);
        updateProgress();
      }
    });
    updateProgress();
    setRuntime(true, acceptance.latest ? 'prior device receipt' : 'device gate open');
  }

  async function start() {
    navActive(); app.innerHTML = '<div class="empty" role="status">Chargement…</div>';
    try {
      if (location.pathname === '/' || location.pathname === '/ecosystem') return await loadEcosystem();
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
      if (location.pathname === '/voice/native') return await loadVoice();
      if (['/voice', '/voice.html', '/voix'].includes(location.pathname)) return await window.mountConversation({ app, api, esc });
      if (location.pathname === '/device-check') return await loadDeviceCheck();
      app.innerHTML = '<div class="empty">Page introuvable.</div>';
    } catch (error) {
      console.error('Household page initialization failed', error); setRuntime(false, 'indisponible');
      app.innerHTML = '<article class="card full danger-box"><h1>Cette page est momentanément indisponible.</h1><p>Réessaie dans un instant.</p><button type="button" id="householdRetry">Réessayer</button></article>'; document.getElementById('householdRetry').onclick = () => location.reload();
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
