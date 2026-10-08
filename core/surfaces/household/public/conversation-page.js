/* One browser conversation: shared persona, existing household session, local mic. */
window.mountConversation = async function ({ app, api, esc, space = 'personal', autoStart = true }) {
  const P = PersonaPresentation;
  const family = space === 'family';
  const defaultListening = family ? 'wake' : 'open';
  const listeningKey = 'household.space.' + space + '.listening';
  const sessionBase = '/api/voice-personas/' + (family ? 'family' : 'private') + '/sessions';
  const [{ personas: catalog, runtime }, agentCatalog] = await Promise.all([api('/api/voice-personas/catalog'),
    family ? Promise.resolve({ agents: [{ id: 'family', name: 'Nestor Famille' }] }) : api('/api/voice-personas/private/agents').catch(() => null)]);
  const personas = family ? catalog.filter(p => p.id === 'nestor') : catalog;
  const agents = agentCatalog?.agents?.length ? agentCatalog.agents : [{ id: 'main', name: 'Main', personalNotes: true }];
  if (!personas?.length) throw new Error('No personalities are available. Open Prompts to choose one.');
  app.innerHTML = `<section class="conversation-shell">
    <header class="conversation-heading"><h1>Avec Nestor.</h1><p id="conversationListeningHint">${family ? "Dis « Hey Nestor » ou « Eille Nestor », puis parle naturellement." : "Conversation ouverte : parle librement tant que le micro est actif."}</p></header>
    <nav class="conversation-toolbar" aria-label="Conversation actions">
      <button id="conversationNew" class="button" type="button">Nouvel échange</button>
      <button id="conversationHistoryToggle" class="button" type="button" aria-expanded="false" aria-controls="conversationHistory">Récents</button>
    </nav>
    ${family ? '' : '<nav id="conversationTeam" class="conversation-team" aria-label="Équipe" hidden></nav>'}
    <section id="conversationHistory" class="conversation-history" aria-label="Conversations récentes" hidden>
      <div class="conversation-history-heading"><h2>Reprendre un échange</h2><button id="conversationHistoryClose" class="button" type="button">Fermer</button></div>
      <div id="conversationRecent" class="conversation-recent" aria-live="polite"></div>
      ${family ? '' : '<a href="/dad/memories" class="conversation-native">Mes souvenirs</a>'}
    </section>
    <section id="conversationRecap" class="conversation-recap" aria-label="Point de l’échange" hidden></section>
    <div class="conversation-layout"><details class="conversation-settings" id="conversationSettings"><summary>Réglages de l’espace</summary>
      ${family ? '' : '<button id="conversationPerformance" class="button" type="button">Contexte et performance</button><button id="familyPerformance" class="button" type="button">Réglages de performance · Famille</button>'}
      <p id="conversationLocked" class="conversation-locked" role="status" hidden></p>
      <label for="conversationPersona">Style</label><select id="conversationPersona">${personas.map(p => `<option value="${esc(p.id)}" ${p.id === 'nestor' ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <p id="personaDescription" class="muted"></p><p class="muted">Le style donne le ton. Le membre apporte ses outils et ses souvenirs.</p>
      <details id="conversationAgentSettings"><summary id="conversationAgentHeading">Agent & model</summary>
        <label for="conversationBackend">Moteur de conversation</label><select id="conversationBackend"><option value="openclaw" ${runtime?.openclawConfigured === false ? 'disabled' : ''}>OpenClaw</option><option value="agentx">AgentX / Ollama</option></select><p class="muted">Tes souvenirs restent dans AgentX avec les deux moteurs. OpenClaw ajoute ses outils et ses actions.</p>
        <div id="conversationNativeAgent"><label for="conversationAgent">OpenClaw agent</label><select id="conversationAgent">${agents.map(agent => `<option value="${esc(agent.id)}" ${agent.id === 'main' ? 'selected' : ''}>${esc(agent.name)} · ${esc(agent.id)}</option>`).join('')}</select>
        <p class="muted">Changing agents starts a separate conversation with that agent’s own tools, permissions and memory.</p>
        <a href="/api/openclaw/control-launch/chat" target="_blank" rel="noopener">Configure agents in OpenClaw</a></div><p id="conversationAgentDescription" class="muted"></p>
      </details>
      <label class="conversation-toggle"><input id="conversationOpen" type="checkbox"> Modèle alternatif (Open) <span class="muted">Changer le modèle de cette conversation</span></label><p id="conversationOpenStatus" class="muted" role="status" hidden></p>
      <details id="conversationOpenDetails" hidden><summary>Open model details</summary><p id="conversationOpenContext" class="muted"></p></details>
      <details><summary>Voix et langue</summary><label for="conversationLanguage">Langue</label><select id="conversationLanguage"><option value="auto">Automatique · français / English</option><option value="fr">Français</option><option value="en">English</option></select>
      <p id="voiceDescription" class="muted"></p>
      <button id="conversationPreview" class="button" type="button">Écouter la voix</button><p id="conversationPreviewStatus" class="muted" role="status"></p>
      <p id="conversationSpeechReceipt" class="muted" hidden></p>
      ${family ? '' : '<p class="muted">La voix, l’apparence et la personnalité d’un membre se règlent sur sa fiche : <a href="/agent-ops#agents">Équipe</a>.</p>'}
      <p id="conversationPreferencesStatus" class="muted"></p></details>
      <details id="conversationNotes" hidden></details>
      <details><summary>Écoute</summary><label class="conversation-toggle"><input id="conversationInterruption" type="checkbox" checked> Interrompre Nestor en parlant</label><p id="conversationInterruptionStatus" class="muted">Utilise l’annulation d’écho du navigateur. Un casque peut aider dans une pièce bruyante.</p>
      <label class="conversation-toggle"><input id="conversationWake" type="checkbox" ${family ? "checked" : ""}> Exiger « Hey Nestor »</label><p class="muted">Avec réveil vocal, Nestor revient en veille après 30 secondes sans intervention ou dès « Merci Nestor ». En conversation ouverte, il répond aux paroles tant que le micro est actif. Les phrases sont transcrites sur le réseau local avant la détection du nom ; seules les phrases adressées à Nestor entrent dans la conversation.</p><div id="conversationBrowserSttSettings" hidden></div>${family ? '' : '<a href="/device-check" class="conversation-native">Vérifier le micro et le haut-parleur</a>'}</details>
      <details id="conversationAudio" class="conversation-audio"><summary>Audio & transcription</summary>
        <p id="conversationDevice" class="muted">Microphone et haut-parleurs de cet appareil</p>
        <p class="muted">Réécoute jusqu’à 20 secondes de ce microphone, ou la fin de ta dernière prise de parole. Un extrait reste dans cet onglet pendant au plus 2 minutes. Pause, Nouvel échange ou quitter la page l’efface.</p>
        <div class="conversation-audio-actions"><button id="conversationInspectMic" class="button" type="button" disabled>Réécouter le micro récent</button><button id="conversationInspectPhrase" class="button" type="button" disabled>Réécouter la fin de la prise</button></div>
        <p id="conversationAudioStatus" class="muted">Start a conversation to capture audio.</p>
        <div id="conversationAudioExcerpt" hidden><p id="conversationAudioCapture" class="muted"></p><p id="conversationAudioTranscript" class="conversation-audio-transcript"></p>
          <div class="conversation-audio-actions"><button id="conversationReplay" class="button" type="button">Play excerpt</button><button id="conversationReplayStop" class="button" type="button">Stop playback</button><button id="conversationAudioErase" class="button" type="button">Erase excerpt</button></div>
        </div>
      </details>
    </details><section class="conversation-stage" aria-label="Conversation">
      <div class="conversation-live"><div id="conversationPresence" class="conversation-presence" data-state="idle" aria-hidden="true"><span id="conversationInitial">N</span></div>
      <p id="conversationStatus" class="conversation-status" role="status" aria-live="polite">Préparation de Nestor…</p><p id="conversationVoiceNotice" class="muted" role="status" hidden></p>
      <p id="conversationBrowserSttIndicator" class="conversation-browser-stt" hidden></p><section id="conversationBrowserSttNotice" class="conversation-audio" aria-label="Reconnaissance du navigateur" role="alert" hidden></section>
      <div class="conversation-actions"><button id="conversationStart" type="button" class="button primary" hidden disabled>Activer Nestor</button></div></div>
      <section id="conversationVisual" class="conversation-board conversation-visual" aria-label="Images" hidden></section>
      <div id="conversationResume" class="conversation-resume" role="region" aria-label="Reprendre" hidden></div>
      <div id="conversationTranscript" class="conversation-transcript" role="log" aria-label="Transcript" aria-live="polite"><p class="empty">Nos échanges apparaîtront ici.</p></div>
      <section id="conversationBoard" class="conversation-board" aria-label="À l’écran" hidden></section>
      <section id="conversationBrain" class="conversation-board conversation-brain" aria-label="Pistes" hidden></section>
      <details id="conversationPersonalContext" class="personal-context" hidden></details>
      <section id="conversationTools" class="conversation-audio" aria-label="Outils et actions" hidden>
        <p id="conversationToolsStatus" role="status"></p>
        <details><summary>Résultat des outils</summary><pre id="conversationToolsReceipt"></pre></details>
      </section>
      <form id="conversationText" class="conversation-text"><label class="sr-only" for="conversationMessage">Message</label><textarea id="conversationMessage" rows="2" placeholder="Écris un message…" required maxlength="4000"></textarea><button class="button" type="submit">Envoyer</button></form>
      ${family ? '' : '<details class="conversation-attachments"><summary>Joindre une image ou un document</summary><label class="sr-only" for="conversationFiles">Pièces jointes</label><input id="conversationFiles" type="file" multiple accept="image/png,image/jpeg,.txt,.md,.csv,.json,.pdf"><p class="muted">3 fichiers maximum · photos JPEG ou PNG jusqu’à 50 Mo (Nestor reçoit une copie réduite, l’original est archivé) · texte ou PDF texte de 2 Mo (20 pages, 24 000 caractères maximum). Ajoute un message pour les envoyer.</p><div id="conversationDraftFiles" aria-live="polite"></div></details>'}
      <p id="conversationAgentContext" class="conversation-context muted"></p>
    </section></div></section>`;
  const el = id => document.getElementById(id);
  // Shown, never spoken (#167): secrets exist only in the private space.
  const board = window.DisplayBoard.createScreen({ text: el('conversationBoard'), visual: el('conversationVisual') }, { secrets: !family, space: family ? 'family' : 'personal' });
  // The avatar dock paces a math picture to Nestor's first word; the Images zone draws it.
  window.addEventListener('persona-scene', event => {
    const detail = event.detail || {};
    if (detail.space === (family ? 'family' : 'personal') && detail.scene) board.add({ key: 'scene', kind: 'scene', title: detail.caption || '', scene: detail.scene });
  });
  const backendPicker = el('conversationBackend');
  backendPicker.value = runtime?.defaultBackend || 'openclaw';
  const agentPicker = el('conversationAgent');
  agentPicker.disabled = family || !agentCatalog;
  if (family) { agentPicker.value = 'family'; el('conversationAgentSettings').hidden = true; app.querySelector('label[for=conversationPersona]').hidden = true; el('conversationPersona').hidden = true; el('conversationOpen').closest('label').hidden = true; }
  const selectedAgent = () => agents.find(agent => agent.id === agentPicker.value) || agents[0];
  const team = family ? [] : ConversationTeam.members(personas, agents);
  const picker = el('conversationPersona'), open = el('conversationOpen'), language = el('conversationLanguage');
  const transcript = el('conversationTranscript');
  // The background brain (#169): tapping a suggestion asks it; a remark is spoken at a pause
  // when the voice conversation is listening, otherwise shown in the transcript.
  const brain = window.NestorBrain.create(el('conversationBrain'), { base: sessionBase,
    onAsk: question => { el('conversationMessage').value = question; el('conversationText').requestSubmit(); },
    onRevision: block => board.add(block),
    onInterject: async remark => {
      const spoken = await conversation.interject({ text: remark.text });
      transcript.querySelector('.empty')?.remove();
      const row = document.createElement('div'); row.className = 'conversation-message assistant interjection';
      const label = document.createElement('small'); label.className = 'interjection-label';
      label.textContent = spoken ? 'Remarque du cerveau · dite' : 'Remarque du cerveau · affichée seulement (Nestor ne parlait pas à ce moment)';
      row.dataset.spoken = String(spoken); row.append(label, document.createTextNode(remark.text)); transcript.append(row); row.scrollIntoView({ block: 'nearest' });
    } });
  const personalNotes = mountPersonalNotes({ host: el('conversationNotes'), evidence: el('conversationPersonalContext'), api, esc });
  const selected = () => personas.find(p => p.id === picker.value) || personas[0];
  const blockedOpenMessage = 'Open is unavailable. inference-host needs recovery before this conversation can continue.';
  const interruption = el('conversationInterruption');
  let enteringSpace = autoStart;
  let textBusy = false, partial = null, previewAbort = null, activeBrowserTurn = null, degradedReply = false;
  let draftFiles = [];
  const attachmentUrl = (sessionId, id) => `${sessionBase}/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`;
  function renderDraftFiles() {
    if (family) return;
    const host = el('conversationDraftFiles'); host.replaceChildren();
    draftFiles.forEach((file, index) => {
      const row = document.createElement('div'); row.className = 'conversation-attachment';
      const label = document.createElement('span'); label.textContent = file.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button'; remove.textContent = 'Retirer';
      remove.disabled = textBusy; remove.setAttribute('aria-label', `Retirer ${file.name}`);
      remove.onclick = () => { draftFiles.splice(index, 1); renderDraftFiles(); };
      row.append(label, remove); host.append(row);
    });
  }
  if (!family) el('conversationFiles').onchange = event => {
    const files = Array.from(event.target.files || []);
    if (files.length + draftFiles.length > 3 || !files.every(NestorAttachmentImages.accepts)) {
      el('conversationStatus').textContent = 'Choisis au plus 3 fichiers : photos de 50 Mo, documents de 2 Mo.';
    } else { draftFiles.push(...files); renderDraftFiles(); }
    event.target.value = '';
  };
  async function uploadDraftFiles(session, signal) {
    const refs = [];
    for (const original of draftFiles) {
      const image = NestorAttachmentImages.isImage(original);
      const file = image ? await NestorAttachmentImages.reduce(original) : original;
      const types = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
      const mimeType = types[file.name.split('.').at(-1).toLowerCase()] || file.type;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(`data:${mimeType};base64,${String(reader.result).split(',')[1]}`);
        reader.onerror = () => reject(new Error('Le fichier ne peut pas être lu.')); reader.readAsDataURL(file);
      });
      const data = await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/attachments`, {
        method: 'POST', signal, body: JSON.stringify({ name: file.name, dataUrl }) });
      refs.push(data.attachment);
      // The archive keeps the photo as taken; a missing archive never blocks the turn.
      if (image) await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/attachments/${encodeURIComponent(data.attachment.id)}/original`, {
        method: 'POST', signal, body: original,
        headers: { 'Content-Type': original.type || 'application/octet-stream', 'X-Original-Name': encodeURIComponent(original.name) } })
        .catch(error => { if (signal?.aborted) throw error; console.warn('Original photo not archived', error.message); });
    }
    return refs;
  }
  const interruptedTurns = new Set();
  const openHold = new HouseholdOpen.OpenHold(hold => {
    el('conversationOpenStatus').hidden = !openHold.active && !openHold.restoreUntil;
    el('conversationOpenStatus').textContent = HouseholdOpen.describe(hold, openHold.active);
    el('conversationOpenDetails').hidden = !openHold.active;
    el('conversationOpenContext').textContent = 'Requested context: ' + (hold?.hold?.numCtx ?? 'unavailable')
      + ' · Resident context: ' + (hold?.residentContextLength ?? 'unavailable');
    if (openHold.active && hold?.phase === 'blocked') {
      el('conversationStatus').textContent = blockedOpenMessage;
    } else if (el('conversationStatus').textContent === blockedOpenMessage) {
      el('conversationStatus').textContent = labels[conversation.state];
    }
  });
  let storage;
  try { storage = window.localStorage; } catch { /* preferences remain usable in memory */ }
  let preferences = P.read(storage, catalog);
  try { const savedListening = storage?.getItem(listeningKey); el('conversationWake').checked = (['wake', 'open'].includes(savedListening) ? savedListening : defaultListening) === 'wake'; } catch {}
  const describeListening = () => { el('conversationListeningHint').textContent = el('conversationWake').checked ? 'Dis « Hey Nestor » ou « Eille Nestor », puis parle naturellement.' : 'Conversation ouverte : parle librement tant que le micro est actif.'; };
  el('conversationWake').onchange = () => { conversation.setWakeWord(el('conversationWake').checked); try { storage?.setItem(listeningKey, el('conversationWake').checked ? 'wake' : 'open'); } catch {} describeListening(); };
  describeListening();
  picker.value = family ? 'nestor' : preferences.personaId;
  if (!family) {
    // The saved agent, else the one whose own personality was saved: a team member's voice never sits on another agent.
    const known = (id) => (id && agents.some(agent => agent.id === id) ? id : null);
    agentPicker.value = known(preferences.agentId) || known(personas.find(p => p.id === picker.value)?.agentId) || agentPicker.value;
  }
  interruption.checked = preferences.interruption;
  // Voice and appearance come from the member's persona (Agent Ops, Team); this page only picks who and in which style.
  const chosenVoice = () => P.chosenVoice(selected(), '', preferences.lastVoice);
  const stopPreview = () => { previewAbort?.abort(); previewAbort = null; };
  const savePreferences = () => {
    if (!family) { preferences.personaId = picker.value; preferences.agentId = agentPicker.value; }
    preferences.interruption = interruption.checked;
    preferences.profiles[picker.value] = P.profile({ language: language.value });
    const saved = P.save(storage, preferences);
    el('conversationPreferencesStatus').textContent = saved
      ? 'Le membre, le style et la langue sont conservés sur ce navigateur.'
      : 'Préférences actives pour cette visite ; ce navigateur ne permet pas de les conserver.';
  };
  async function releaseOpen() {
    return openHold.release();
  }
  const selection = () => ({ wakeWord: el('conversationWake').checked, backend: backendPicker.value, agentId: family ? 'family' : selectedAgent().id, personaId: selected().id, personaVersion: selected().version,
    inference: { open: !family && open.checked }, voice: { presentation: chosenVoice(), selections: {} }, language: language.value,
    visual: null, interruption: interruption.checked });
  // The team member answering this turn when it addressed one directly (#41); null for the conversation's agent.
  let turnSpeaker = null;
  const message = (role, text, interrupted = false, sound = null, attachments = [], speakerName = role === 'assistant' ? turnSpeaker?.name : '') => {
    transcript.querySelector('.empty')?.remove(); el('conversationResume').hidden = true;
    let row = role === 'assistant' ? partial : null;
    if (!row) { row = document.createElement('div'); row.className = `conversation-message ${role}`; transcript.append(row); }
    row.textContent = role === 'assistant' && sound ? NestorSpeech.withoutMediaReferences(text) : text; partial = null;
    if (speakerName) row.dataset.speaker = speakerName; else delete row.dataset.speaker;
    if (role === 'assistant' && degradedReply) { row.dataset.degraded = 'true'; degradedReply = false; } // #135 fallback model
    attachments.forEach(attachment => {
      const link = document.createElement('a'); link.href = attachmentUrl(conversation.session.sessionId, attachment.id);
      link.target = '_blank'; link.rel = 'noopener'; link.className = 'conversation-attachment'; link.textContent = attachment.name;
      if (attachment.kind === 'image') {
        const preview = document.createElement('img'); preview.src = link.href; preview.alt = attachment.name; preview.loading = 'lazy'; link.prepend(preview);
      }
      row.append(link);
    });
    if (sound) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = 'Écouter le son';
      button.onclick = async () => {
        if (previewAbort) { stopPreview(); return; }
        conversation.stop(true); const abort = new AbortController(); previewAbort = abort; button.textContent = 'Arrêter le son';
        try { await P.preview(signal => NestorConversation.recording(sound, signal), abort.signal, sound.gain); }
        catch (error) { if (!abort.signal.aborted) el('conversationStatus').textContent = error.message; }
        finally { if (previewAbort === abort) previewAbort = null; button.textContent = 'Écouter le son'; }
      }; row.append(document.createElement('br'), button);
    }
    if (interrupted) { row.dataset.interrupted = 'true'; row.setAttribute('aria-label', 'Interrupted reply'); }
    row.scrollIntoView({ block: 'nearest' });
  };
  async function createSession(prefs, signal) {
    recap?.clear();
    // A new session has no history: never leave an older transcript on screen beside it.
    if (transcript.querySelector('.conversation-message')) {
      transcript.innerHTML = '<p class="empty">Nos échanges apparaîtront ici.</p>'; partial = null; board.clear(); brain.reset();
    }
    const data = await api(sessionBase, { method: 'POST', signal,
      body: JSON.stringify({ ...prefs, packId: family ? 'kidx_nestor' : 'personal_operator', scopeId: family ? 'family' : 'personal', ...(family ? { modeId: 'family' } : {}), label: selected().name }) });
    preferences.lastVoice = prefs.voice.presentation; savePreferences();
    if (prefs.inference.open) {
      if (signal.aborted) return data.session;
      await openHold.start();
      if (signal.aborted) await releaseOpen();
    }
    return data.session;
  }
  async function streamedTurn(session, text, signal, onDelta = () => {}, { turnId, attachmentIds, onNotice, onSayEnd } = {}) {
    personalNotes.show(null);
    activeBrowserTurn = turnId; activity('turn'); brain.cancel(); turnSpeaker = null;
    const response = await fetch(`${sessionBase}/${encodeURIComponent(session.sessionId)}/turns/text`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, turnId, attachmentIds, channel: textBusy ? 'text' : 'voice', stream: true, soundPlayback: true }) });
    if (!response.ok) { const body = await response.json(); throw new Error(body.message || 'Conversation unavailable'); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', answer = '', result, noticed = false;
    const said = new Set();
    const agentName = id => agents.find(agent => agent.id === id)?.name || id.charAt(0).toUpperCase() + id.slice(1);
    const consume = line => {
      if (signal.aborted) throw new DOMException('Conversation cancelled', 'AbortError');
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'speaker') { turnSpeaker = event.speaker || null; if (turnSpeaker) el('conversationStatus').textContent = `${turnSpeaker.name} te répond.`; }
      if (event.type === 'tools') { showTools(event.evidence); activity('tools', { count: event.evidence?.receipts?.length || 1 }); }
      if (event.type === 'scene' && !interruptedTurns.has(turnId)) activity('scene', { scene: event.scene });
      if (event.type === 'show' && !interruptedTurns.has(turnId)) board.add(event.block);
      if (!interruptedTurns.has(turnId) && event.type === 'status' && event.phase === 'activity') {
        // Nestor says what it is doing (tools, another agent) once per line.
        const line = AgentActivity.describe(event.activity, agentName);
        if (line && !said.has(line.text)) {
          said.add(line.text); el('conversationStatus').textContent = line.text;
          if (line.spoken) {
            transcript.querySelector('.empty')?.remove();
            const row = document.createElement('div'); row.className = 'conversation-message activity'; row.textContent = line.text;
            transcript.insertBefore(row, partial); row.scrollIntoView({ block: 'nearest' });
            onNotice?.(line.text);
          }
        }
      }
      if (!interruptedTurns.has(turnId) && event.type === 'status' && ['loading', 'pending', 'waiting_host'].includes(event.phase)) {
        el('conversationStatus').textContent = event.phase === 'waiting_host'
          ? 'Nestor attend que son ordinateur termine un test en cours (moins d’une minute). Ton message est gardé.'
          : event.phase === 'loading'
          ? 'Loading your Open model… your message is waiting here.'
          : 'Waiting for the current model work on inference-host…';
        // In a voice turn Nestor says it once, before the answer (#62).
        if (event.phase === 'waiting_host' && !noticed) { noticed = true; activity('host-busy'); onNotice?.('Un instant, je termine un test en cours sur mon ordinateur.'); }
      }
      if (event.type === 'delta' && !interruptedTurns.has(turnId)) {
        answer += event.delta;
        if (!partial) { partial = document.createElement('div'); partial.className = 'conversation-message assistant'; if (turnSpeaker) partial.dataset.speaker = turnSpeaker.name; transcript.append(partial); }
        partial.textContent = answer; onDelta(event.delta); activity('delta', { size: event.delta.length });
      }
      // Core has sent every spoken word; pictures, tools and the record follow before `done`.
      if (event.type === 'say_end' && !interruptedTurns.has(turnId)) onSayEnd?.();
      if (event.type === 'done') { result = event.data; activity('done', { sessionId: session.sessionId, traceId: event.data?.traceId }); void brain.follow(session.sessionId, event.data?.traceId); }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (done) break;
      }
      if (pending.trim()) consume(pending);
      if (!result?.reply) throw new Error('The reply was interrupted. Start again when ready.');
      void recap?.refresh(session.sessionId);
      personalNotes.show(result.continuity?.personal); degradedReply = result.routing?.fallbackUsed === true;
      showTools(result.tools);
      // The agent consulted a team member (#41): its answer is collected and said like a member's late reply.
      if (result.consult) void followMember(session, result.consult.turnId, result.consult.speaker);
      return { ...result.reply, sound: result.sound };
    } finally { await reader.cancel().catch(() => {}); }
  }
  const labels = { idle: 'Prêt à écouter.', starting: 'Activation du microphone…', listening: 'Je t’écoute…', hearing: 'Je t’écoute…', transcribing: 'Un instant…', waiting: 'Je termine la réponse précédente…', thinking: 'Je réfléchis…', preparing: 'Je prépare la réponse…', speaking: 'Nestor répond…', paused: 'Micro coupé.', error: 'Conversation en pause.', reviewing: 'Micro coupé pour la réécoute.', resuming: 'Reprise après la lecture…' };
  // The voice ladder and the VoiX backup (X-Voix-Upstream) share one notice.
  let ladderNotice = '', voixUpstream = '';
  const renderVoiceNotice = () => { const text = NestorVoixUpstream.composeNotice(ladderNotice, voixUpstream), node = el('conversationVoiceNotice'); node.hidden = !text; node.textContent = text; };
  const voiceNotice = text => { ladderNotice = text || ''; renderVoiceNotice(); };
  const noteUpstream = state => { const active = typeof state === 'string' ? state : state?.active; if (active) { voixUpstream = active; renderVoiceNotice(); } };
  const refreshUpstream = () => api('/api/voix/upstream').then(noteUpstream, () => {});
  refreshUpstream();
  // Fallback ladder: chosen voice, persona voice, catalog voice, then the browser's own voice.
  const voiceLadder = AgentXSpeechLadder.createSpeechLadder({
    async request({ text, language: lang, choice }, signal) {
      const response = await fetch('/api/voix/synthesize/stream', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: lang, voice: choice.voice, tts_provider: choice.provider }) });
      noteUpstream(response.headers.get('X-Voix-Upstream'));
      return response;
    },
    deviceVoice: () => 'speechSynthesis' in window,
    unavailable: 'La voix est indisponible pour le moment. Ta conversation continue par écrit.' });
  // `after` is speech that failed while it played: the clause restarts on the voice below it.
  async function synthesize(text, lang, persona, voicePrefs, signal, source = 'Conversation', after = null) {
    const choices = P.speechChoices(persona, lang, voicePrefs);
    const response = await voiceLadder.speak({ text, language: lang, choices, after }, signal);
    const rung = voiceLadder.rungOf(response);
    voiceNotice(response.browserSpeech ? 'Voix du serveur indisponible : voix de ce navigateur.' : rung ? 'Voix choisie indisponible : voix de secours.' : '');
    if (response.browserSpeech) return response;
    if (!signal.aborted) {
      const acknowledged = decodeURIComponent(response.headers.get('X-Voix-Voice') || '');
      const actualLanguage = response.headers.get('X-Nestor-Speech-Language');
      const receipt = el('conversationSpeechReceipt'); receipt.hidden = false;
      receipt.textContent = source + ' synthesis · ' + persona.name + ' · '
        + (actualLanguage || lang) + ' · ' + (acknowledged || choices[rung].voice)
        + (acknowledged ? ' (voice acknowledged by the speech proxy)' : ' (requested voice; no proxy receipt)');
    }
    return response;
  }
  // Keep the screen on while a conversation is active. A phone that sleeps
  // hides the page, which pauses the conversation and drops the pending reply.
  let screenLock = null, screenWanted = false, screenRequest = null;
  function holdScreen(wanted) {
    screenWanted = wanted;
    if (wanted && !screenLock && !screenRequest && !document.hidden && navigator.wakeLock) {
      screenRequest = navigator.wakeLock.request('screen').then(lock => {
        screenLock = lock;
        lock.addEventListener('release', () => { if (screenLock === lock) screenLock = null; });
        if (!screenWanted) holdScreen(false);
      }).catch(() => {}).finally(() => { screenRequest = null; });
    } else if (!wanted && screenLock) {
      const lock = screenLock; screenLock = null; lock.release().catch(() => {});
    }
  }
  // The docked avatar (avatar-dock.js) follows these and the persona-presence samplers.
  const activity = (kind, detail = {}) => window.dispatchEvent(new CustomEvent('persona-activity', { detail: { space, kind, ...detail } }));
  let lastGreeting = '', lastWakeReply = '';
  const avatar = window.AvatarDock?.mount({ space: family ? 'family' : 'personal' });
  // Browser speech recognition only with the instance gate and this browser's consent (per space).
  let renderSpeechFallback = () => {};
  async function transcribeLocal(blob, lang, signal) {
    const body = new FormData(); body.append('file', blob, 'speech.wav');
    body.append('language', NestorSpeech.transcriptionLanguage(lang));
    const result = await api('/api/voix/transcribe', { method: 'POST', body, signal });
    refreshUpstream();
    return result;
  }
  const speechFallback = NestorSpeechFallback.createSpeechFallback({ space, storage, allowed: runtime?.browserSpeechFallback?.[family ? 'family' : 'personal'] === true,
    Recognition: window.SpeechRecognition || window.webkitSpeechRecognition, onChange: state => renderSpeechFallback(state),
    listening: () => ['listening', 'hearing', 'transcribing', 'waiting', 'thinking', 'preparing', 'speaking'].includes(conversation.state),
    language: () => conversation.selection?.language || language.value,
    transcribeLocal });
  // The reply of a member whose turn went on in the background (member-work.js on Core).
  async function followMember(session, turnId, speaker) {
    const name = speaker?.name || 'L’autre agent';
    const url = `${sessionBase}/${encodeURIComponent(session.sessionId)}/member-reply?turn=${encodeURIComponent(turnId)}`;
    const here = () => conversation.session?.sessionId === session.sessionId;
    el('conversationStatus').textContent = `${name} continue en arrière-plan. Sa réponse sera dite dès qu’elle est prête.`;
    for (let round = 0; round < 20 && here(); round += 1) {
      let work;
      try { work = (await api(url))?.work; } catch { return; }
      if (!work || !here()) return;
      if (work.pending) continue;
      transcript.querySelector('.empty')?.remove();
      const row = document.createElement('div');
      if (work.status !== 'answered' || !work.reply?.text) {
        row.className = 'conversation-message activity'; row.textContent = `${name} n’a pas pu terminer sa réponse.`;
        transcript.append(row); row.scrollIntoView({ block: 'nearest' });
        return;
      }
      row.className = 'conversation-message assistant'; row.dataset.speaker = name; row.dataset.spoken = 'false';
      row.textContent = work.reply.text; transcript.append(row); row.scrollIntoView({ block: 'nearest' });
      // Said at the first pause; the text is already on screen and in the history.
      for (let attempt = 0; attempt < 90 && here(); attempt += 1) {
        if (await conversation.interject(work.reply)) { row.dataset.spoken = 'true'; return; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return;
    }
  }
  const conversation = new NestorConversation.Conversation({
    readyToSpeak: () => avatar?.ready,
    openAudio: (signal, onError, options) => NestorConversation.openAudio(signal, onError, { ...options, observeSpeech: true,
      onPlaybackMetrics: metrics => { el('voiceDescription').title = `Last segment: ${metrics.first_scheduled_ms} ms to schedule; ${metrics.buffer_gaps} buffer gaps (${metrics.buffer_gap_ms} ms). Browser timing, not acoustic measurement.`; } }).then(audio => speechFallback.wrapAudio(audio)), createSession, message, turn: streamedTurn,
    async interrupt(session, turnId, signal, { stop = false } = {}) {
      let result;
      do {
        result = await api(sessionBase + '/' + encodeURIComponent(session.sessionId) + '/interrupt',
          { method: 'POST', signal, body: JSON.stringify({ turnId, ...(stop ? { stop: true } : {}) }) });
      } while (result.pending && !signal.aborted);
      // A team member keeps working when the person speaks again; its reply is said at the next pause.
      if (result.detached) void followMember(session, turnId, turnSpeaker);
      return result;
    },
    interrupted() {
      interruptedTurns.add(activeBrowserTurn);
      const row = partial || transcript.querySelector('.conversation-message.assistant:last-of-type');
      if (row) { row.dataset.interrupted = 'true'; row.setAttribute('aria-label', 'Interrupted reply'); }
      partial = null;
    },
    transcribe: (blob, lang, signal) => speechFallback.transcribe(blob, lang, signal),
    // Recognition started during a pause uses the local transcriber only: the browser's own
    // recognizer hands its text over once, and an early failure must not switch engines.
    transcribeEarly: (blob, lang, signal) => (speechFallback.state().active ? null : transcribeLocal(blob, lang, signal)),
    // The person starts speaking: wake speech recognition while they talk (best effort).
    warm: () => fetch('/api/voix/warm', { method: 'POST' }),
    // The voice loop's timeline of a spoken turn, kept by Core on that recorded turn.
    timings: (session, turnId, timings) => api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/voice-timings`,
      { method: 'POST', keepalive: true, body: JSON.stringify({ turnId, timings }) }),
    async synthesize(reply, signal) {
      // The voice loop chose one language for the whole turn; a clause is never re-scored.
      const lang = NestorSpeech.normalizeSpeechLanguage(reply.language) || 'fr';
      // A member who answers directly speaks with its own personality's voice, not the session's choices.
      const speaker = reply.speaker?.personaId ? reply.speaker : turnSpeaker;
      const member = speaker && personas.find(p => p.id === speaker.personaId);
      const persona = member || conversation.session?.persona || selected();
      return synthesize(reply.text, lang, persona, member ? {} : conversation.session?.voice || {}, signal, 'Conversation', reply.after);
    },
    // The household speaks French unless English was chosen; the browser's own
    // locale greeted a French family in English. The line
    // shows in the transcript too, and the face opens its eyes as it is spoken.
    async greet(session, signal) {
      const lang = language.value === 'en' || (language.value === 'auto' && session?.voice?.language === 'en') ? 'en' : 'fr';
      const text = lastGreeting = NestorGreetings.greetingFor({ space, language: lang, wakeWord: !!conversation.selection?.wakeWord, previous: lastGreeting });
      // While the greeting is spoken, Core warms this conversation's own prompt (voice-warmup.js),
      // so the first question is not preceded by a full prompt read. Best effort.
      if (!family && session?.sessionId) void api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/warm`,
        { method: 'POST', body: JSON.stringify({ greeting: text }) }).catch(() => {});
      const speech = await synthesize(text, lang, session?.persona || selected(), session?.voice || {}, signal, 'Greeting');
      if (!signal.aborted) message('assistant', text);
      return speech;
    },
    wakeReply() {
      const lang = language.value === 'en' ? 'en' : 'fr';
      return { text: lastWakeReply = NestorGreetings.wakeReply({ language: lang, previous: lastWakeReply }), language: lang };
    }
  }, (state, detail) => {
    if (state === 'idle' && !open.checked) void releaseOpen();
    if (state === 'starting') void speechFallback.probe(() => api('/api/voix/health'));
    speechFallback.sync();
    el('conversationStatus').textContent = detail || (state === 'listening' && conversation.selection?.wakeWord ? (conversation.wake.active() ? 'Je t’écoute. Continue, ou dis « Merci Nestor ».' : 'En veille · dis « Hey Nestor ».') : labels[state]);
    el('conversationPresence').dataset.state = state;
    const reviewing = state === 'reviewing';
    const active = !['idle', 'paused', 'error', 'reviewing'].includes(state);
    holdScreen(active || textBusy);
    el('conversationStart').disabled = textBusy && !active;
    el('conversationStart').hidden = enteringSpace && !active;
    el('conversationStart').textContent = active ? 'Pause' : conversation.session ? 'Reprendre' : 'Activer Nestor';
    const lockReason = renderTeam(active || textBusy);
    // Language and interruption are read at each turn, so they stay changeable while the conversation runs.
    for (const node of [language, interruption]) { node.disabled = false; node.title = ''; }
    [backendPicker, agentPicker, picker, open].forEach(node => {
      node.disabled = active || !!conversation.session || textBusy || (node === agentPicker && (family || !agentCatalog || backendPicker.value !== 'openclaw'));
      node.title = node.disabled && lockReason ? lockReason : '';
    });
    el('conversationWake').disabled = textBusy || !['idle', 'paused', 'error', 'listening'].includes(state);
    // Waiting voice (open listening or wake standby) accepts a typed message as its next turn.
    const typing = active && !conversation.canType();
    el('conversationText').querySelector('button').disabled = typing || reviewing || textBusy;
    if (!family) { el('conversationFiles').disabled = typing || reviewing || textBusy; renderDraftFiles(); }
    el('conversationPreview').disabled = active || reviewing || textBusy;
    if (conversation.audio) el('conversationInterruptionStatus').textContent = !interruption.checked
      ? 'Spoken interruption is off. Listening resumes after each reply.'
      : conversation.audio.canInterrupt ? 'You can speak to interrupt. Echo cancellation is enabled.'
        : 'This browser did not enable echo cancellation. Listening resumes after each reply.';
    if (conversation.audio) el('conversationDevice').textContent = conversation.audio.deviceLabel || 'Microphone on this device';
    if (reviewing) el('conversationAudio').open = true;
    renderAudioReview();
    window.dispatchEvent(new CustomEvent('persona-presence', { detail: { personaId: conversation.session?.persona?.id || selected().id,
      personaVersion: conversation.session?.persona?.version || selected().version, state, visual: conversation.session?.visual || conversation.session?.persona?.visual || selected().visual || null,
      sample: { speech: () => conversation.audio?.readSpeechSample?.(), input: () => conversation.audio?.readInputLevel?.(),
        // Waiting for "Hey Nestor": the face dozes until the word wakes him.
        asleep: () => !!conversation.selection?.wakeWord && ['listening', 'hearing'].includes(conversation.state) && !conversation.wake.active() } } }));
  });
  renderSpeechFallback = NestorSpeechFallback.mountSpeechFallbackPanel(speechFallback, { notice: el('conversationBrowserSttNotice'),
    settings: el('conversationBrowserSttSettings'), indicator: el('conversationBrowserSttIndicator') },
  { onConsent: () => { if (conversation.state === 'reviewing') void conversation.start(selection()); } });
  function renderAudioReview() {
    if (conversation.state === 'listening' && conversation.selection?.wakeWord) el('conversationStatus').textContent = conversation.wake.active() ? 'Je t’écoute. Continue, ou dis « Merci Nestor ».' : 'En veille · dis « Hey Nestor ».';
    const info = conversation.audio?.reviewStatus();
    const reviewing = conversation.state === 'reviewing';
    const canReview = ['listening', 'hearing', 'reviewing'].includes(conversation.state) && !conversation.activeTurn && !conversation.turnPending;
    el('conversationInspectMic').disabled = !canReview || !info?.recentSeconds;
    el('conversationInspectPhrase').disabled = !canReview || !info?.id || info.stt === 'not-sent';
    el('conversationAudioStatus').textContent = reviewing ? (info?.id
      ? 'Listening is off. This excerpt is played locally and is not sent for transcription.'
      : 'No excerpt remains. Resume conversation to capture again.')
      : !conversation.audio ? 'Start a conversation to capture audio.'
        : canReview ? 'Reviewing pauses the microphone. You choose when to resume.' : 'Replay is available after the current reply.';
    el('conversationAudioExcerpt').hidden = !reviewing || !info?.id;
    if (!reviewing || !info?.id) {
      el('conversationAudioCapture').textContent = ''; el('conversationAudioTranscript').textContent = ''; return;
    }
    const enabled = value => value === undefined ? 'unknown' : value ? 'on' : 'off';
    const remaining = Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000));
    el('conversationAudioCapture').textContent = info.seconds.toFixed(1) + ' s · ' + new Date(info.capturedAt).toLocaleTimeString() + ' · erases in ' + remaining + ' s. '
      + 'Captured before our echo rejection; browser processing applies. ' + (info.sampleRate / 1000) + ' kHz · echo cancellation ' + enabled(info.echoCancellation)
      + ' · noise reduction ' + enabled(info.noiseSuppression) + ' · automatic gain ' + enabled(info.autoGainControl) + '. '
      + Math.round(info.rejectedMs) + ' ms rejected by our echo filter.';
    el('conversationAudioTranscript').textContent = info.stt === 'transcribed' ? 'STT: ' + info.text
      : ({ control: 'Commande de silence reconnue localement. Aucune réponse lancée.', 'not-sent': 'Not sent to STT. This can include silence or rejected sounds.', empty: 'STT returned no text.', failed: 'STT failed. No model reply was started for this phrase.', pending: 'Transcription pending.' })[info.stt] || '';
    if (info.attempt?.model) el('conversationAudioTranscript').textContent += '\nSTT model: ' + info.attempt.model;
    if (info.attempt?.language) el('conversationAudioTranscript').textContent += ' · reported language: ' + info.attempt.language;
    if (info.attempt?.sttMs !== undefined) el('conversationAudioTranscript').textContent += ' · ' + info.attempt.sttMs + ' ms';
  }
  function showTools(evidence) {
    const receipts = evidence?.receipts || [];
    const box = el('conversationTools'); box.hidden = !receipts.length && !['unavailable', 'not_supported'].includes(evidence?.status);
    if (box.hidden) return;
    el('conversationToolsStatus').textContent = evidence.status === 'not_supported' ? 'AgentX / Ollama · réponse avec contexte, sans outils OpenClaw.' : evidence.status === 'unavailable'
      ? 'Les reçus des outils sont indisponibles.'
      : receipts.map(receipt => receipt.tool + (receipt.status === 'failed' ? ' · échec'
        : receipt.status === 'verified' ? ' · résultat reçu'
          : receipt.observed ? ' · appel observé, résultat non vérifié' : ' · résultat indisponible')).join(' · ');
    el('conversationToolsReceipt').textContent = JSON.stringify(evidence, null, 2);
  }
  el('conversationInspectMic').onclick = () => { conversation.review('microphone'); renderAudioReview(); };
  el('conversationInspectPhrase').onclick = () => { conversation.review('last'); renderAudioReview(); };
  el('conversationReplay').onclick = () => conversation.replay();
  el('conversationReplayStop').onclick = () => conversation.reviewSpeech?.abort();
  el('conversationAudioErase').onclick = () => { conversation.forgetReview(); renderAudioReview(); };
  let audioReviewClock = setInterval(renderAudioReview, 1000);
  window.addEventListener('pageshow', event => {
    if (event.persisted) { clearInterval(audioReviewClock); audioReviewClock = setInterval(renderAudioReview, 1000); renderAudioReview(); }
  });
  // The team member this conversation is (or will be) with, and why settings are locked.
  function renderTeam(busy = false) {
    if (family) return '';
    const activeAgentId = conversation.session?.agentId || agentPicker.value;
    const locked = !!conversation.session;
    ConversationTeam.render(el('conversationTeam'), { list: team, activeAgentId, locked: locked || busy, esc });
    const notice = ConversationTeam.lockNotice({ locked, busy: busy && !locked, name: ConversationTeam.memberName(team, agents, activeAgentId) });
    el('conversationLocked').textContent = notice;
    el('conversationLocked').hidden = !notice;
    return notice;
  }
  if (!family) el('conversationTeam').onclick = (event) => {
    const card = event.target.closest('button[data-agent]');
    if (!card || card.disabled || conversation.session) return;
    backendPicker.value = 'openclaw';
    agentPicker.value = card.dataset.agent;
    picker.value = card.dataset.persona;
    picker.onchange();
  };
  // The style picker offers what suits the chosen member; a resumed conversation keeps its own.
  function syncStyles() {
    if (family || conversation.session) return;
    const offered = ConversationTeam.stylesFor(personas, agentPicker.value);
    if (!offered.length) return;
    const current = offered.some(p => p.id === picker.value) ? picker.value : (offered.find(p => p.agentId === agentPicker.value) || offered[0]).id;
    picker.replaceChildren(...offered.map(p => new Option(p.name, p.id)));
    picker.value = current;
    picker.hidden = app.querySelector('label[for=conversationPersona]').hidden = offered.length < 2;
  }
  function describe() {
    syncStyles(); renderTeam();
    const agent = agents.find(agent => agent.id === (conversation.session?.agentId || agentPicker.value)) || selectedAgent();
    const native = (conversation.session?.backend || backendPicker.value) === 'openclaw';
    agentPicker.disabled = family || !native || !agentCatalog || !!conversation.session;
    el('conversationNativeAgent').hidden = !native;
    el('conversationAgentHeading').textContent = native ? 'Agent & model · ' + agent.name : 'Agent & model · AgentX / Ollama';
    el('conversationAgentDescription').textContent = !native ? 'Model selected by AgentX routing. Open applies the existing local model override.' : agentCatalog
      ? `Model inherited from OpenClaw: ${agent.model || 'native default'}. Open is an explicit model override; its native fallback chain is disabled for that override.`
      : 'Agent configuration is unavailable. The existing Main conversation remains available.';
    el('conversationAgentContext').textContent = family ? 'Nestor · conversations et souvenirs familiaux.' : native ? agent.name + ' · conversations, outils et souvenirs privés.' : 'Conversation avec le contexte fourni à AgentX.';
    el('conversationNotes').hidden = family;
    if (family) { el('conversationAgentSettings').hidden = true; picker.hidden = true; open.checked = false; }
    if (family) { el('conversationNotes').open = false; personalNotes.show(null); }
    const p = conversation.session?.persona || selected();
    const visual = conversation.session?.visual || p.visual;
    el('conversationInitial').textContent = p.name.charAt(0);
    el('conversationInitial').hidden = visual?.style === 'orb';
    el('conversationPresence').dataset.style = visual?.style || 'initials';
    el('conversationPresence').style.setProperty('--presence-color', P.visual(visual)?.color || '#52cfc5');
    el('personaDescription').textContent = p.description || p.name;
    const speech = P.speechFor(p, language.value === 'en' ? 'en' : 'fr', selection().voice);
    el('voiceDescription').textContent = `Voix de ${p.name.split(' ·')[0]} : ${speech.provider} · ${speech.voice}.`;
  }
  const restoreProfile = () => {
    const profile = P.profile(preferences.profiles[picker.value]);
    language.value = profile.language;
  };
  backendPicker.onchange = () => { stopPreview(); describe(); };
  agentPicker.onchange = () => { stopPreview(); savePreferences(); describe(); };
  picker.onchange = () => { stopPreview(); restoreProfile(); savePreferences(); describe(); };
  for (const field of [language, interruption]) field.onchange = () => { stopPreview(); savePreferences(); describe(); };
  language.addEventListener('change', () => conversation.setLanguage(language.value));
  interruption.addEventListener('change', () => conversation.setInterruption(interruption.checked));
  el('conversationPreview').onclick = async () => {
    if (previewAbort) { stopPreview(); return; }
    const abort = new AbortController(); previewAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 30000);
    el('conversationPreview').textContent = 'Arrêter la voix';
    el('conversationPreviewStatus').textContent = 'Préparation de la voix…';
    const lang = language.value === 'auto' ? (navigator.language?.startsWith('fr') ? 'fr' : 'en') : language.value;
    const persona = conversation.session?.persona || selected();
    const name = persona.id === 'native_personality' ? selectedAgent().name : persona.name.split(' ·')[0];
    const text = lang === 'fr' ? 'Bonjour, je suis ' + name + '. Voici ma voix pour notre prochaine conversation.'
      : 'Hello, I am ' + name + '. This is my voice for our next conversation.';
    try {
      preferences.lastVoice = chosenVoice(); savePreferences();
      await P.preview(signal => synthesize(text, lang, persona, selection().voice, signal, 'Preview'), abort.signal);
      if (!abort.signal.aborted) el('conversationPreviewStatus').textContent = 'Écoute terminée.';
    } catch (error) { if (!abort.signal.aborted) el('conversationPreviewStatus').textContent = error.message; }
    finally {
      clearTimeout(timeout);
      if (!previewAbort || previewAbort === abort) {
        previewAbort = null; el('conversationPreview').textContent = 'Écouter la voix';
        if (abort.signal.aborted) el('conversationPreviewStatus').textContent = 'Écoute arrêtée.';
      }
    }
  };
  restoreProfile(); describe();
  open.onchange = () => { if (open.checked) void openHold.start(); else void releaseOpen(); };
  // What a press on Activer Nestor or Reprendre starts; opening a saved conversation starts it too.
  const startVoice = options => {
    stopPreview(); preferences.lastVoice = chosenVoice(); savePreferences();
    if (open.checked) void openHold.start();
    return conversation.start(selection(), options);
  };
  el('conversationStart').onclick = () => {
    if (!['idle', 'paused', 'error', 'reviewing'].includes(conversation.state)) { conversation.stop(true); return; }
    return startVoice();
  };
  el('conversationNew').onclick = () => {
    recap?.clear();
    el('conversationResume').hidden = true; setHistoryOpen(false); stopPreview(); conversation.stop(); void releaseOpen(); partial = null;
    transcript.innerHTML = '<p class="empty">Nos échanges apparaîtront ici.</p>'; board.clear(); brain.reset();
    personalNotes.show(null);
    showTools(null); void recap?.refresh();
    el('conversationMessage').value = ''; draftFiles = []; renderDraftFiles(); restoreProfile(); describe(); picker.focus();
  };
  // Enter sends, Shift+Enter adds a line; an IME composition keeps its Enter.
  el('conversationMessage').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    el('conversationText').requestSubmit();
  });
  el('conversationText').onsubmit = async event => {
    event.preventDefault();
    if (!textBusy && conversation.canType()) return typedDuringVoice();
    if (textBusy || !['idle', 'paused', 'error'].includes(conversation.state)) return;
    const input = el('conversationMessage'), text = input.value.trim(); if (!text) return;
    let shown = false;
    stopPreview(); textBusy = true; conversation.abort = new AbortController(); const epoch = ++conversation.epoch;
    conversation.show('thinking');
    try {
      if (open.checked) await openHold.start();
      if (!conversation.current(epoch)) return;
      const session = conversation.session || await createSession(selection(), conversation.abort.signal);
      if (!conversation.current(epoch)) return;
      conversation.session = session;
      const attachments = await uploadDraftFiles(session, conversation.abort.signal);
      if (!conversation.current(epoch)) return;
      message('user', text, false, null, attachments);
      // The message now lives in the transcript: empty the composer at once,
      // unless the person already started typing the next one.
      shown = true; if (input.value.trim() === text) input.value = '';
      draftFiles = []; renderDraftFiles();
      const reply = await streamedTurn(conversation.session, text, conversation.abort.signal, undefined, { attachmentIds: attachments.map(item => item.id) });
      if (conversation.current(epoch)) { message('assistant', reply.text, false, reply.sound); conversation.show('paused'); }
    } catch (error) {
      // A failed send gives the text back so it can be sent again.
      if (shown && !input.value.trim()) input.value = text;
      if (conversation.current(epoch)) conversation.fail(error, epoch);
    }
    finally { textBusy = false; conversation.show(conversation.state, el('conversationStatus').textContent); }
  };
  async function typedDuringVoice() {
    const input = el('conversationMessage'), text = input.value.trim(); if (!text) return;
    stopPreview(); textBusy = true; conversation.show(conversation.state);
    let attachments = null, failure = '';
    try { attachments = await uploadDraftFiles(conversation.session, conversation.abort.signal); }
    catch (error) { failure = error.message; }
    textBusy = false;
    if (!attachments) { conversation.show(conversation.state, failure); return; }
    if (input.value.trim() === text) input.value = '';
    draftFiles = []; renderDraftFiles();
    if (!await conversation.typed(text, { attachments }) && !input.value.trim()) input.value = text;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPreview(); conversation.stop(true); void releaseOpen(); } });
  window.addEventListener('pagehide', () => { clearInterval(audioReviewClock); stopPreview(); conversation.stop(); void openHold.release({ watch: false }); });
  el('runtimePill').textContent = 'ready';
  conversation.show('idle');
  const performance = family ? null : ConversationPreferences.mount({ button: el('conversationPerformance'), api, endpoint: '/api/voice-personas/preferences',
    note: 'Ces réglages pilotent les ajouts fournis par Core. Avec OpenClaw, la mémoire, l’historique et les outils propres à l’agent se règlent dans son interface native.',
    integrations: [{ title: 'Modèles, routage et hôtes locaux', href: '/nerve-center' }, { title: 'Mémoire et outils de l’agent natif · OpenClaw', href: '/api/openclaw/control-launch/chat' }],
    onSaved: () => brain.reset()
  });
  const familyPerformance = family ? null : ConversationPreferences.mount({ button: el('familyPerformance'), api, endpoint: '/api/voice-personas/preferences?space=family', title: 'Famille · Contexte et performance' });
  window.addEventListener('pagehide', () => { performance?.clear(); familyPerformance?.clear(); });
  const recap = family ? null : ConversationRecap.mount({ host: el('conversationRecap'), api, base: sessionBase,
    currentId: () => conversation.session?.sessionId || null, title: 'Point de l’échange',
    prepare: async () => { if (textBusy || conversation.state === 'thinking') return false; stopPreview(); conversation.stop(true); await releaseOpen(); },
    onResume: async id => { const data = await api(`${sessionBase}/${encodeURIComponent(id)}/history`); return resumeSession(data.session, el('conversationHistoryToggle')); }
  });
  void recap?.refresh();
  let historyRequest = 0;
  function setHistoryOpen(visible, restoreFocus = false) {
    el('conversationHistory').hidden = !visible;
    el('conversationHistoryToggle').setAttribute('aria-expanded', String(visible));
    ++historyRequest;
    if (visible) void loadRecent(historyRequest);
    else if (restoreFocus) el('conversationHistoryToggle').focus();
  }
  el('conversationHistoryToggle').onclick = () => setHistoryOpen(el('conversationHistory').hidden);
  el('conversationHistoryClose').onclick = () => setHistoryOpen(false, true);
  el('conversationHistory').onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); setHistoryOpen(false, true); }
  };
  // Opens a saved conversation from Core: the same on every device (#120).
  async function resumeSession(session, button) {
    recap?.clear();
    el('conversationResume').hidden = true; stopPreview(); conversation.stop();
    void releaseOpen();
    const epoch = conversation.epoch;
    button.disabled = true;
    el('conversationStatus').textContent = 'Chargement de la conversation…';
    try {
      const data = await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/history`);
      if (epoch !== conversation.epoch) return;
      conversation.session = data.session;
      draftFiles = []; renderDraftFiles();
      const saved = data.session;
      if (saved.persona && !personas.some(p => p.id === saved.persona.id)) { personas.push(saved.persona); picker.add(new Option(saved.persona.name, saved.persona.id)); }
      if (!agents.some(agent => agent.id === (saved.agentId || 'main'))) {
        agents.push({ id: saved.agentId, name: saved.agentId }); agentPicker.add(new Option(saved.agentId, saved.agentId));
      }
      agentPicker.value = saved.agentId || 'main';
      backendPicker.value = saved.backend || runtime?.defaultBackend || 'openclaw';
      picker.value = saved.persona?.id || 'nestor'; open.checked = !!saved.inference?.open;
      language.value = data.session.voice?.language || 'auto';
      transcript.replaceChildren(); partial = null; board.clear(); brain.reset();
      (data.turns || []).forEach(turn => {
        if (turn.inputText) message('user', turn.inputText, false, null, turn.attachments);
        if (turn.replyText) message('assistant', turn.replyText, turn.interrupted, null, [], turn.speakerAgentId ? ConversationTeam.memberName(team, agents, turn.speakerAgentId) : '');
        board.restore(turn.display);
      });
      void ConversationImages.resume(`${sessionBase}/${encodeURIComponent(data.session.sessionId)}`, block => { if (!board.has(`image:${block.operation.id}`)) board.add(block); },
        { current: () => conversation.session?.sessionId === data.session.sessionId }); // starting voice moves the epoch
      personalNotes.show(data.turns?.at(-1)?.personalContinuity);
      showTools(data.turns?.at(-1)?.toolEvidence);
      void recap?.refresh();
      describe(); conversation.show('paused'); setHistoryOpen(false); el('conversationStart').focus();
      // Opening a conversation resumes it: no second press on Reprendre. As on arrival, voice starts
      // by itself only where the microphone is already granted; elsewhere that press asks for it.
      const permission = await navigator.permissions?.query({ name: 'microphone' }).catch(() => null);
      if (permission?.state === 'granted' && epoch === conversation.epoch) void startVoice({ automatic: true });
    } catch (error) { if (epoch === conversation.epoch) el('conversationStatus').textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function loadRecent(request) {
    const recent = el('conversationRecent'); recent.textContent = 'Chargement des échanges…';
    try {
      const { sessions } = await api(sessionBase + '/recent?limit=5' + (family ? '' : '&preview=true'));
      if (request !== historyRequest) return;
      recent.replaceChildren();
      for (const session of (sessions || [])) {
        const personaName = session.persona?.name || "Nestor";
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button conversation-history-item';
        const preview = session.lastTurn?.inputPreview || session.lastTurn?.replyPreview || '';
        const customLabel = session.label && session.label !== personaName ? session.label : '';
        button.innerHTML = '<strong></strong><span class="conversation-history-preview"></span><span class="conversation-history-meta"></span><span class="conversation-history-date"></span>';
        button.querySelector('strong').textContent = customLabel || preview || personaName;
        const previewNode = button.querySelector('.conversation-history-preview');
        previewNode.textContent = preview; previewNode.hidden = !customLabel || !preview;
        button.querySelector('.conversation-history-meta').textContent = (family ? 'Famille' : 'Super Dad') + ' · ' + personaName.split(' ·')[0];
        const stamp = session.lastTurnAt || session.createdAt, date = stamp ? new Date(stamp) : null;
        const when = date && Number.isFinite(date.getTime()) ? date.toLocaleString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Date unavailable';
        const count = Number.isFinite(session.turnCount) ? ' · ' + session.turnCount + (session.turnCount === 1 ? ' échange' : ' échanges') : '';
        button.querySelector('.conversation-history-date').textContent = when + count;
        button.onclick = () => resumeSession(session, button);
        const item = document.createElement('div'); item.className = 'conversation-history-entry';
        item.append(button);
        if (!family) {
          const actions = document.createElement('div'); actions.className = 'conversation-history-actions';
          const download = document.createElement('a'); download.className = 'button'; download.textContent = 'Exporter';
          download.href = `${sessionBase}/${encodeURIComponent(session.sessionId)}/export`; download.download = 'agentx-conversation.json';
          const erase = document.createElement('button'); erase.type = 'button'; erase.className = 'button'; erase.textContent = 'Effacer';
          erase.onclick = async () => {
            if (!window.confirm('Effacer cette conversation et ses fichiers dans AgentX ? Les souvenirs enregistrés séparément et les copies des services externes restent conservés.')) return;
            erase.disabled = true;
            try {
              await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE CONVERSATION' }) });
              if (conversation.session?.sessionId === session.sessionId) el('conversationNew').click();
              setHistoryOpen(true);
            } catch (error) { el('conversationStatus').textContent = error.message; erase.disabled = false; }
          };
          actions.append(download, erase); item.append(actions);
        }
        recent.append(item);
      }
      if (!recent.children.length) recent.textContent = 'Aucun échange à reprendre pour le moment.';
    } catch {
      if (request === historyRequest) recent.textContent = 'Les conversations récentes sont indisponibles. Ferme puis rouvre l’historique pour réessayer.';
    }
  }
  // Super Dad offers its latest conversation on every device, so an exchange
  // started on the phone continues on the PC with one tap (#120). Famille does not.
  const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
  async function offerResume() {
    const card = el('conversationResume');
    try {
      const { sessions = [] } = await api(sessionBase + '/recent?limit=1&preview=true');
      const [latest] = sessions, at = Date.parse(latest?.lastTurnAt || '');
      if (!latest || !Number.isFinite(at) || Date.now() - at > RESUME_WINDOW_MS
        || conversation.session?.sessionId === latest.sessionId || transcript.querySelector('.conversation-message')) return;
      const minutes = Math.max(1, Math.round((Date.now() - at) / 60000));
      card.innerHTML = '<p><strong>Reprendre la dernière conversation</strong> <span class="muted"></span></p>'
        + '<p class="conversation-resume-preview"></p><div class="conversation-resume-actions">'
        + '<button type="button" class="button primary">Reprendre</button><button type="button" class="button">Ignorer</button></div>';
      card.querySelector('.muted').textContent = '· ' + (minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.round(minutes / 60)} h`);
      card.querySelector('.conversation-resume-preview').textContent = latest.lastTurn?.inputPreview || latest.lastTurn?.replyPreview || '';
      const [resume, dismiss] = card.querySelectorAll('button');
      resume.onclick = () => resumeSession(latest, resume);
      dismiss.onclick = () => { card.hidden = true; };
      card.hidden = false;
    } catch { card.hidden = true; }
  }
  if (!family) void offerResume();
  if (autoStart && !document.hidden) {
    try {
      const permission = await navigator.permissions?.query({ name: 'microphone' });
      if (permission?.state === 'granted') {
        await conversation.start(selection(), { automatic: true });
      } else el('conversationStatus').textContent = 'Active Nestor une première fois pour autoriser le micro et le son.';
    } catch { el('conversationStatus').textContent = 'Appuie sur Activer Nestor pour préparer cet appareil.'; }
  }
  enteringSpace = false;
  conversation.show(conversation.state, el('conversationStatus').textContent);

};
