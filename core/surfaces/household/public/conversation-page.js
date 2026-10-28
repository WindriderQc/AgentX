/* Engine selection is scoped to the surface; credentials never enter the browser. */
window.ConversationEngines = {
  available(runtime, family) {
    return [runtime?.openclawConfigured !== false && 'openclaw', 'agentx', !family && runtime?.hermesConfigured === true && 'hermes'].filter(Boolean);
  },
  choose(runtime, family, preferred) {
    const available = this.available(runtime, family);
    return [preferred, runtime?.defaultBackend, 'openclaw', 'agentx'].find(value => available.includes(value));
  },
  label(backend) { return ({ hermes: 'Hermes', openclaw: 'OpenClaw', agentx: 'AgentX / Ollama' })[backend] || 'Conversation engine'; },
  observed(data) {
    const backend = data?.routing?.backend;
    const source = data?.routing?.source || data?.routingSource;
    const engine = backend || (typeof source === 'string' && source.startsWith('hermes/') ? 'hermes' : null);
    const value = typeof data?.model === 'string' ? data.model : data?.model?.model;
    const model = typeof value === 'string' ? value.slice(0, 160) : '';
    return engine ? this.label(engine) + (model ? ' · ' + model : '') : '';
  }
};
/* One browser conversation: shared persona, existing household session, local mic. */
window.mountConversation = async function ({ app, api, esc, space = 'personal', autoStart = true }) {
  const P = PersonaPresentation, engines = window.ConversationEngines;
  const family = space === 'family';
  const defaultListening = family ? 'wake' : 'open';
  const listeningKey = 'household.space.' + space + '.listening';
  const sessionBase = '/api/voice-personas/' + (family ? 'family' : 'private') + '/sessions';
  const [{ personas: catalog, runtime }, agentCatalog, screenCatalog] = await Promise.all([api('/api/voice-personas/catalog'),
    family ? Promise.resolve({ agents: [{ id: 'family', name: 'Nestor Family' }] }) : api('/api/voice-personas/private/agents').catch(() => null),
    family ? null : api('/api/voice-personas/private/screen-pages').catch(() => null)]);
  if (!family && screenCatalog) window.AgentXScreenPages?.configure(screenCatalog.destinations);
  const personas = family ? catalog.filter(p => p.id === 'nestor') : catalog;
  const agents = agentCatalog?.agents?.length ? agentCatalog.agents : [{ id: 'main', name: 'Main', personalNotes: true }];
  if (!personas?.length) throw new Error('No style is available. Choose one in Prompts.');
  app.innerHTML = `<section class="conversation-shell">
    <header class="conversation-heading"><p class="eyebrow">${family ? 'Nestor · Family' : 'Super Dad · Personal'}</p><h1>With Nestor.</h1><p id="conversationListeningHint">${family ? "Say “Hey/Eille/Oh/Ah Nestor”, then speak naturally." : "Open conversation: speak freely while the mic is on."}</p></header>
    <nav class="conversation-toolbar" aria-label="Conversation actions">
      <button id="conversationSettingsToggle" class="button space-settings-toggle" type="button" aria-expanded="false" aria-controls="conversationSettings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg><span>Settings</span><span id="conversationSettingsSummary" class="space-settings-summary"></span><svg class="space-settings-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <button id="conversationNew" class="button" type="button">New conversation</button>
      <button id="conversationHistoryToggle" class="button" type="button" aria-expanded="false" aria-controls="conversationHistory">Recent</button>
    </nav>
    <section id="conversationSettings" class="conversation-settings space-settings" aria-label="Space settings" hidden>
      <div class="ss-group" aria-labelledby="ssModes"><h2 id="ssModes" class="ss-title">Modes</h2>
        <div class="ss-grid">
        <div class="ss-row" id="conversationModelRow"${family ? ' hidden' : ''}><div class="ss-text"><span class="ss-label">Model</span><span id="conversationModelHint" class="ss-hint" role="status">Used by the next conversation.</span><span id="conversationOpenStatus" class="ss-hint ss-live" role="status" hidden></span></div>
          <label class="ss-switch ss-two"><span>Standard</span><input id="conversationOpen" type="checkbox" role="switch" aria-label="Abliterated model"><i aria-hidden="true"></i><span>Abliterated</span></label></div>
        <div class="ss-row"><div class="ss-text"><span class="ss-label">Language</span><span class="ss-hint">Speech, recognition and greetings.</span></div>
          <fieldset id="conversationLanguage" class="ss-segmented"><legend class="sr-only">Language</legend><label><input type="radio" name="conversationLanguage" value="fr" checked><span>Français</span></label><label><input type="radio" name="conversationLanguage" value="en"><span>English</span></label></fieldset></div>
        <div class="ss-row"><div class="ss-text"><span class="ss-label">Listening</span><span id="conversationWakeHint" class="ss-hint"></span></div>
          <label class="ss-switch ss-two"><span>Open mic</span><input id="conversationWake" type="checkbox" role="switch" aria-label="Wait for Hey Nestor"><i aria-hidden="true"></i><span>“Hey Nestor”</span></label></div>
        <div class="ss-row"><div class="ss-text"><span class="ss-label">Interrupt by speaking</span><span class="ss-hint">Talking over Nestor stops its answer.</span></div>
          <label class="ss-switch"><input id="conversationInterrupt" type="checkbox" role="switch" aria-label="Interrupt by speaking"><i aria-hidden="true"></i></label></div>
        ${family ? '' : `<div class="ss-row"><div class="ss-text"><label class="ss-label" for="conversationEphemeral">Conversation éphémère</label><span class="ss-hint">Pour les prochains échanges.</span></div>
          <label class="ss-switch"><input id="conversationEphemeral" type="checkbox" role="switch" aria-describedby="conversationPrivacyNotice"><i aria-hidden="true"></i></label></div>
          <p id="conversationPrivacyNotice" class="ss-hint" role="status"></p><button id="conversationPrivacyDirect" type="button" class="button" hidden>Utiliser Ollama direct pour l’éphémère</button>`}
        </div>
      </div>
      <div class="ss-group" id="conversationWho" aria-labelledby="ssWho"${family ? ' hidden' : ''}><h2 id="ssWho" class="ss-title">Who answers <small>set when a conversation starts</small></h2>
        <div id="conversationLocked" class="ss-lock" role="status" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span id="conversationLockedText"></span><button id="conversationLockedNew" class="ss-link" type="button">New conversation</button></div>
        <div class="ss-fields">
          <label class="ss-field">Engine<select id="conversationBackend"><option value="openclaw" ${runtime?.openclawConfigured === false ? 'disabled' : ''}>OpenClaw</option><option value="agentx">AgentX / Ollama</option>${!family && runtime?.hermesConfigured === true ? '<option value="hermes">Hermes</option>' : ''}</select></label>
          <label class="ss-field" id="conversationNativeAgent">Member<select id="conversationAgent">${agents.map(agent => `<option value="${esc(agent.id)}" ${agent.id === 'main' ? 'selected' : ''}>${esc(agent.name)}</option>`).join('')}</select></label>
          <label class="ss-field" id="conversationPersonaField">Style<select id="conversationPersona">${personas.map(p => `<option value="${esc(p.id)}" ${p.id === 'nestor' ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        </div>
        <p class="ss-note"><span id="personaDescription"></span> <span id="conversationAgentDescription"></span></p>
      </div>
      <nav class="ss-links" aria-label="Related settings">
        <button id="conversationWorkshop" class="ss-link" type="button">Voice workshop<small>mic, voices, diagnostics</small></button>
        ${family ? '' : `<button id="conversationPerformance" class="ss-link" type="button">Context and performance<small>what Core adds</small></button>
        <a class="ss-link" href="/dad/memories">My memories<small>personal notes</small></a>
        <a class="ss-link" href="/api/openclaw/control-launch/chat" target="_blank" rel="noopener">OpenClaw members<small>tools, native memory</small></a>`}
      </nav>
      <p id="conversationPreferencesStatus" class="ss-hint" role="status"></p>
    </section>
    ${family ? '' : '<nav id="conversationTeam" class="conversation-team" aria-label="Team" hidden></nav>'}
    <section id="conversationHistory" class="conversation-history" aria-label="Recent conversations" hidden>
      <div class="conversation-history-heading"><h2>Resume a conversation</h2><button id="conversationHistoryClose" class="button" type="button">Close</button></div>
      <div id="conversationRecent" class="conversation-recent" aria-live="polite"></div>
      ${family ? '' : '<a href="/dad/memories" class="conversation-native">My memories</a>'}
    </section>
    <section id="conversationRecap" class="conversation-recap" aria-label="Conversation recap" hidden></section>
    <div class="conversation-layout"><section class="conversation-stage" aria-label="Conversation"><div class="conversation-cockpit${family ? ' conversation-cockpit-family' : ''}">
      <div class="conversation-live"><div id="conversationPresence" class="conversation-presence" data-state="idle" aria-hidden="true"><span id="conversationInitial">N</span></div>
      ${family ? '' : '<div id="nestorProgress" class="nestor-progress-host" hidden></div>'}
      <p id="conversationStatus" class="conversation-status" role="status" aria-live="polite">Getting Nestor ready…</p><p id="conversationVoiceNotice" class="muted" role="status" hidden></p>
      <p id="conversationBrowserSttIndicator" class="conversation-browser-stt" hidden></p><section id="conversationBrowserSttNotice" class="conversation-audio" aria-label="Browser speech recognition" role="alert" hidden></section>
      <div class="conversation-actions"><button id="conversationStart" type="button" class="button primary" hidden disabled>Turn on Nestor</button></div>
      ${family ? '' : '<p id="conversationWorkflowSignal" class="conversation-workflow-signal" aria-label="Current workflow summary"></p>'}</div><div class="conversation-dialogue">
      <section id="conversationVisual" class="conversation-board conversation-visual" aria-label="Images" hidden></section>
      <div id="conversationResume" class="conversation-resume" role="region" aria-label="Resume" hidden></div>
      ${family ? '' : '<section id="conversationWork" class="conversation-work" aria-label="Nestor’s requests and results" aria-live="polite" hidden></section>'}
      <div id="conversationTranscript" class="conversation-transcript" role="log" aria-label="Messages" aria-live="polite"><p class="empty">Our conversation will appear here.</p></div>
      <section id="conversationBoard" class="conversation-board" aria-label="On screen" hidden></section>
      <section id="conversationBrain" class="conversation-board conversation-brain" aria-label="Leads" hidden></section>
      <details id="conversationPersonalContext" class="personal-context" hidden></details>
      <section id="conversationTools" class="conversation-audio" aria-label="Tools and actions" hidden>
        <p id="conversationToolsStatus" role="status"></p>
        <details><summary>Tool results</summary><pre id="conversationToolsReceipt"></pre></details>
      </section>
      <form id="conversationText" class="conversation-text"><label class="sr-only" for="conversationMessage">Message</label><textarea id="conversationMessage" rows="2" placeholder="Write a message…" required maxlength="4000"></textarea><button class="button" type="submit">Send</button></form>
      ${family ? '' : '<details class="conversation-attachments"><summary>Attach an image or document</summary><label class="sr-only" for="conversationFiles">Attachments</label><input id="conversationFiles" type="file" multiple accept="image/png,image/jpeg,.txt,.md,.csv,.json,.pdf"><p class="muted">Up to 3 files · JPEG or PNG photos up to 50 MB (Nestor receives a reduced copy; the original is archived) · text or text PDF up to 2 MB (20 pages, 24,000 characters maximum). Add a message to send them.</p><div id="conversationDraftFiles" aria-live="polite"></div></details>'}
      <p id="conversationExecution" class="conversation-context muted" role="status" hidden></p><p id="conversationAgentContext" class="conversation-context muted"></p>
    </div>${family ? '' : '<section id="conversationWorkflow" aria-label="Nestor component workflow"></section>'}</div></section></div></section>`;
  const el = id => document.getElementById(id);
  const composer = window.ConversationComposer.mount({ input: el('conversationMessage'), form: el('conversationText'), family });
  // Shown, never spoken (#167): secrets exist only in the private space.
  const board = window.DisplayBoard.createScreen({ text: el('conversationBoard'), visual: el('conversationVisual') }, { secrets: !family, space: family ? 'family' : 'personal' });
  const companion = family ? null : window.NestorPresentationCompanion?.create({ host: app.querySelector('.conversation-live'),
    board, api, base: sessionBase, getSession: () => conversation.session });
  // "Agrandis", "ferme", "suivant"… act on Nestor's content workspace without a turn. Famille has no such workspace.
  const screenWords = family ? null : window.NestorScreenCommandsEditor?.mount({ host: app.querySelector('.page-presentation-actions'), api });
  let idlePhotos = null;
  const screenCommand = family ? null : window.NestorScreenCommands?.handler(board, { phrases: () => screenWords?.phrases() || [] });
  // The avatar dock paces a math picture to Nestor's first word; the Images zone draws it.
  // Shown live: in the avatar's interactive scene Nestor steps aside and that zone comes first.
  const show = block => {
    companion?.explicit();
    if (!board.add(block)) return;
    el('conversationVisual').closest('.conversation-stage').dataset.shown = ['page', 'image', 'scene'].includes(block.kind) ? 'visual' : 'text';
    activity('show');
  };
  const pagePicker = family ? null : window.NestorScreenPicker.mount({ host: app.querySelector('.conversation-toolbar'), onShow: show });
  window.addEventListener('nestor-review-destination', event => { if (!family && event.detail) show(event.detail); });
  const clearBoard = () => { companion?.reset(); board.clear(); activity('clear'); };
  window.addEventListener('persona-scene', event => {
    const detail = event.detail || {};
    if (detail.space === (family ? 'family' : 'personal') && detail.scene) show({ key: 'scene', kind: 'scene', title: detail.caption || '', scene: detail.scene });
  });
  const backendPicker = el('conversationBackend');
  backendPicker.value = engines.choose(runtime, family);
  const agentPicker = el('conversationAgent');
  agentPicker.disabled = family || !agentCatalog;
  if (family) agentPicker.value = 'family';
  const selectedAgent = () => agents.find(agent => agent.id === agentPicker.value) || agents[0];
  const team = family ? [] : ConversationTeam.members(personas, agents);
  const picker = el('conversationPersona'), open = el('conversationOpen');
  const privacyChoice = window.ConversationPrivacy.create();
  let privacyBackend = null;
  // Language is a two-button choice; the rest of the page reads it like a field.
  const languageField = el('conversationLanguage');
  const language = {
    get value() { return languageField.querySelector('input:checked')?.value || 'fr'; },
    set value(next) { const input = languageField.querySelector(`input[value="${next === 'en' ? 'en' : 'fr'}"]`); if (input) input.checked = true; },
    get disabled() { return languageField.disabled; }, set disabled(value) { languageField.disabled = value; },
    set title(value) { languageField.title = value; },
    set onchange(handler) { languageField.onchange = handler; },
    addEventListener: (...args) => languageField.addEventListener(...args)
  };
  const transcript = el('conversationTranscript');
  const diagnosticFlow = family ? null : el('conversationWorkflow');
  const fallbackSettings = document.createElement('div');
  const wake = el('conversationWake');
  wake.checked = family;
  const progress = family ? null : NestorProgress.create({ host: el('nestorProgress'), getLanguage: () => language.value });
  const workflow = family ? null : NestorWorkflow.create({ host: diagnosticFlow, signal: el('conversationWorkflowSignal'), onSnapshot: view => progress.update(view) });
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
      label.textContent = spoken ? 'Brain remark · spoken' : 'Brain remark · shown only (Nestor was not speaking then)';
      row.dataset.spoken = String(spoken); row.append(label, document.createTextNode(remark.text)); transcript.append(row); transcript.scrollTop = transcript.scrollHeight;
    } });
  const work = family ? null : NestorWork.create({ host: el('conversationWork'), base: sessionBase, api,
    getConversation: () => conversation, getLanguage: () => language.value, maySpeak: () => !textBusy,
    onShow: block => show(block), onSnapshot: (id, data) => workflow.ingest(id, data), onPollError: id => workflow.pollFailure(id) });
  // The parent's private notes never mount in the family space, even hidden.
  const personalNotes = family ? { show() {} } : mountPersonalNotes({ host: document.createElement('details'), evidence: el('conversationPersonalContext'), api, esc });
  const selected = () => personas.find(p => p.id === picker.value) || personas[0];
  const blockedOpenMessage = 'The alternate model is unavailable. The inference host must be restored to continue.';
  const interruption = el('conversationInterrupt');
  interruption.checked = true;
  let lastPlaybackMetrics = {}, latestVoiceTimings = {};
  const stopPreview = () => { previewAbort?.abort(); previewAbort = null; };
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
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button'; remove.textContent = 'Remove';
      remove.disabled = textBusy; remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.onclick = () => { draftFiles.splice(index, 1); renderDraftFiles(); };
      row.append(label, remove); host.append(row);
    });
  }
  if (!family) el('conversationFiles').onchange = event => {
    const files = Array.from(event.target.files || []);
    if (files.length + draftFiles.length > 3 || !files.every(NestorAttachmentImages.accepts)) {
      el('conversationStatus').textContent = 'Choose at most 3 files: photos up to 50 MB, documents up to 2 MB.';
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
        reader.onerror = () => reject(new Error('The file cannot be read.')); reader.readAsDataURL(file);
      });
      const data = await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/attachments`, {
        method: 'POST', signal, body: JSON.stringify({ name: file.name, dataUrl }) });
      refs.push(data.attachment);
      // The archive keeps the photo as taken; a missing archive never blocks the turn.
      if (image && !session.ephemeral) await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/attachments/${encodeURIComponent(data.attachment.id)}/original`, {
        method: 'POST', signal, body: original,
        headers: { 'Content-Type': original.type || 'application/octet-stream', 'X-Original-Name': encodeURIComponent(original.name) } })
        .catch(error => { if (signal?.aborted) throw error; console.warn('Original photo not archived', error.message); });
    }
    return refs;
  }
  const interruptedTurns = new Set();
  const openHold = new HouseholdOpen.OpenHold(hold => {
    el('conversationOpenStatus').hidden = backendPicker.value === 'hermes' || !openHold.active && !openHold.restoreUntil;
    el('conversationOpenStatus').textContent = HouseholdOpen.describe(hold, openHold.active);
    const context = [hold?.hold?.numCtx && 'requested ' + hold.hold.numCtx, hold?.residentContextLength && 'loaded ' + hold.residentContextLength].filter(Boolean).join(', ');
    if (openHold.active && context) el('conversationOpenStatus').textContent += ' · Context ' + context + '.';
    summarize();
    if (openHold.active && hold?.phase === 'blocked') {
      el('conversationStatus').textContent = blockedOpenMessage;
    } else if (el('conversationStatus').textContent === blockedOpenMessage) {
      el('conversationStatus').textContent = labels[conversation.state];
    }
  });
  let storage;
  try { storage = window.localStorage; } catch { /* preferences remain usable in memory */ }
  let preferences = P.read(storage, catalog);
  const backendKey = 'household.space.' + space + '.backend';
  if (!family) { try { backendPicker.value = engines.choose(runtime, false, storage?.getItem(backendKey)); } catch {} }
  try { const savedListening = storage?.getItem(listeningKey); wake.checked = (['wake', 'open'].includes(savedListening) ? savedListening : defaultListening) === 'wake'; } catch {}
  const describeListening = () => {
    el('conversationListeningHint').textContent = wake.checked ? 'Say “Hey/Eille/Oh/Ah Nestor”, then speak naturally.' : 'Open conversation: speak freely while the mic is on.';
    el('conversationWakeHint').textContent = wake.checked ? 'Nestor waits for its name, then listens until Pause.' : 'Nestor hears everything while the mic is on.';
    summarize();
  };
  // The closed Settings button still shows the modes in force.
  function summarize() {
    const parts = family || backendPicker.value === 'hermes' ? [] : [open.checked ? 'Abliterated' : 'Standard'];
    parts.push(wake.checked ? 'Hey Nestor' : 'Open mic', language.value.toUpperCase());
    if (!family && privacyChoice.snapshot().ephemeral) parts.push('Éphémère');
    el('conversationSettingsSummary').textContent = parts.join(' · ');
    el('conversationSettingsToggle').dataset.abliterated = String(!family && open.checked && backendPicker.value !== 'hermes');
  }
  // Settings disclosure also reveals the engine choice after starting afresh.
  window.ConversationSettings.mount({ panel: el('conversationSettings'), toggle: el('conversationSettingsToggle'),
    engine: backendPicker, newButton: el('conversationLockedNew'), startNew: () => el('conversationNew').click() });
  wake.onchange = () => { conversation.setWakeWord(wake.checked); try { storage?.setItem(listeningKey, wake.checked ? 'wake' : 'open'); } catch {} describeListening(); };
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
  const savePreferences = () => {
    if (!family) { preferences.personaId = picker.value; preferences.agentId = agentPicker.value; }
    preferences.interruption = interruption.checked;
    preferences.profiles[picker.value] = P.profile({ ...preferences.profiles[picker.value], language: language.value });
    const saved = P.save(storage, preferences);
    el('conversationPreferencesStatus').textContent = saved ? '' : 'This browser cannot save these choices; they apply to this visit only.';
  };
  async function releaseOpen() {
    return openHold.release();
  }
  const selection = () => ({ wakeWord: wake.checked, backend: backendPicker.value, agentId: family ? 'family' : backendPicker.value === 'hermes' ? 'main' : selectedAgent().id, personaId: selected().id, personaVersion: selected().version,
    inference: { open: !family && backendPicker.value !== 'hermes' && open.checked }, voice: { presentation: chosenVoice(), selections: preferences.profiles[picker.value]?.selections || {} }, language: language.value,
    visual: null, interruption: interruption.checked, ...(!family && privacyChoice.snapshot()) });
  function renderPrivacy() {
    if (family) return;
    const choice = privacyChoice.snapshot(), backend = privacyBackend || conversation.session?.backend || backendPicker.value;
    el('conversationEphemeral').checked = choice.ephemeral;
    el('conversationPrivacyDirect').hidden = !choice.ephemeral || backend === 'agentx';
    el('conversationPrivacyNotice').textContent = (choice.ephemeral ? window.ConversationPrivacy.notice + ' ' : '')
      + (conversation.session?.ephemeral && !choice.ephemeral ? window.ConversationPrivacy.boundary : window.ConversationPrivacy.prior)
      + (choice.ephemeral && backend === 'agentx' ? ' Ollama direct utilise le contexte fourni et les actions d’affichage ; les outils natifs Hermes/OpenClaw ne sont pas exécutés.' : '')
      + (choice.ephemeral && backend !== 'agentx' ? ' Ce moteur conserve ses sessions natives. Choisis Ollama direct pour continuer en éphémère. Ollama direct utilise le routage AgentX et n’exécute pas les outils natifs Hermes/OpenClaw.' : '');
    summarize();
  }
  async function preparePrivacy(session, choice, signal) {
    if (family) return session;
    const target = choice.ephemeral ? choice.backend || session.backend : session.backend;
    if (Boolean(session.ephemeral) === choice.ephemeral && session.ephemeralExplicit === choice.ephemeralExplicit && target === session.backend) return session;
    const { backend: _backend, ...policy } = choice;
    const data = await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/privacy`, {
      method: 'POST', signal, body: JSON.stringify({ ...policy, ...(target !== session.backend ? { backend: target } : {}) }) });
    signal.throwIfAborted(); backendPicker.value = data.session.backend;
    if (data.session.ephemeral) recap?.clear();
    if (data.contextReset) {
      clearBoard(); brain.reset(); work?.reset(); workflow?.reset(); recap?.clear(); personalNotes.show(null);
      const row = document.createElement('p'); row.className = 'muted'; row.textContent = window.ConversationPrivacy.boundary; transcript.append(row);
    }
    return data.session;
  }
  const requestPrivacy = () => { const choice = privacyChoice.snapshot(); return Object.freeze({ ...choice, ...(choice.ephemeral && privacyBackend ? { backend: privacyBackend } : {}) }); };
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
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = 'Play sound';
      button.onclick = async () => {
        if (previewAbort) { stopPreview(); return; }
        conversation.stop(true); const abort = new AbortController(); previewAbort = abort; button.textContent = 'Stop sound';
        try { await P.preview(signal => NestorConversation.recording(sound, signal), abort.signal, sound.gain); }
        catch (error) { if (!abort.signal.aborted) el('conversationStatus').textContent = error.message; }
        finally { if (previewAbort === abort) previewAbort = null; button.textContent = 'Play sound'; }
      }; row.append(document.createElement('br'), button);
    }
    if (interrupted) { row.dataset.interrupted = 'true'; row.setAttribute('aria-label', 'Interrupted reply'); }
    transcript.scrollTop = transcript.scrollHeight;
  };
  async function createSession(prefs, signal) {
    recap?.clear();
    // A new session has no history: never leave an older transcript on screen beside it.
    if (transcript.querySelector('.conversation-message')) {
      transcript.innerHTML = '<p class="empty">Our conversation will appear here.</p>'; partial = null; clearBoard(); brain.reset();
    }
    const data = await api(sessionBase, { method: 'POST', signal,
      body: JSON.stringify({ ...prefs, packId: family ? 'kidx_nestor' : 'personal_operator', scopeId: family ? 'family' : 'personal', ...(family ? { modeId: 'family' } : {}), label: selected().name }) });
    preferences.lastVoice = prefs.voice.presentation; savePreferences();
    if (prefs.inference.open) {
      if (signal.aborted) return data.session;
      await openHold.start();
      if (signal.aborted) await releaseOpen();
    }
    if (!data.session.ephemeral) { workflow?.follow(data.session.sessionId); work?.follow(data.session.sessionId); }
    return data.session;
  }
  async function streamedTurn(session, text, signal, onDelta = () => {}, { turnId, attachmentIds, onNotice, onSayEnd, requestPolicy = requestPrivacy() } = {}) {
    session = await preparePrivacy(session, requestPolicy, signal);
    signal.throwIfAborted(); conversation.session = session; describe();
    const turnLanguage = language.value === 'en' ? 'en' : 'fr';
    turnId ||= crypto.randomUUID();
    const presentationCompanion = companion?.begin(session, turnId) === true;
    personalNotes.show(null);
    activeBrowserTurn = turnId; activity('turn'); brain.cancel(); turnSpeaker = null;
    workflow?.begin(session.sessionId, turnId, textBusy ? 'text' : 'voice');
    let response;
    try {
      response = await fetch(`${sessionBase}/${encodeURIComponent(session.sessionId)}/turns/text`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, turnId, attachmentIds, ...(!family && { ephemeral: session.ephemeral, screen: board.context(), presentationCompanion, presentationPinned: companion?.pinned() === true }), language: turnLanguage, channel: textBusy ? 'text' : 'voice', stream: true, soundPlayback: true }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || 'Conversation unavailable'); }
    } catch (error) { workflow?.stream(turnId, { type: signal.aborted ? 'interrupted' : 'error' }); throw error; }
    if (!session.ephemeral) { work?.follow(session.sessionId); companion?.follow(); }
    if (response.status === 202) {
      workflow?.stream(turnId, { type: 'deferred' });
      const body = await response.json();
      const saved = body.data;
      if (saved?.reply) return saved.reply;
      return { text: turnLanguage === 'en' ? 'Your request is saved. I’m checking its result without running it again.'
        : 'Ta demande est enregistrée. Je vérifie son résultat sans la relancer.', language: turnLanguage };
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', answer = '', result, noticed = false, workAccepted = false;
    const said = new Set();
    const agentName = id => agents.find(agent => agent.id === id)?.name || id.charAt(0).toUpperCase() + id.slice(1);
    const consume = line => {
      if (signal.aborted) throw new DOMException('Conversation cancelled', 'AbortError');
      if (!line.trim()) return;
      const event = JSON.parse(line);
      workflow?.stream(turnId, event);
      if (event.type === 'accepted') { workAccepted = true; void work?.poll(); }
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'speaker') { turnSpeaker = event.speaker || null; if (turnSpeaker) el('conversationStatus').textContent = `${turnSpeaker.name} is replying.`; }
      if (event.type === 'tools') { showTools(event.evidence); activity('tools', { count: event.evidence?.receipts?.length || 1 }); }
      if (event.type === 'scene' && !interruptedTurns.has(turnId)) activity('scene', { scene: event.scene });
      if (event.type === 'show' && !interruptedTurns.has(turnId)) show(event.block);
      if (event.type === 'status' && event.phase === 'activity') voiceHealth.activity();
      if (!interruptedTurns.has(turnId) && event.type === 'status' && event.phase === 'activity') {
        // Nestor says what it is doing (tools, another agent) once per line.
        const line = AgentActivity.describe(event.activity, agentName);
        if (line && !said.has(line.text)) {
          said.add(line.text); el('conversationStatus').textContent = line.text;
          if (line.spoken) {
            transcript.querySelector('.empty')?.remove();
            const row = document.createElement('div'); row.className = 'conversation-message activity'; row.textContent = line.text;
            transcript.insertBefore(row, partial); transcript.scrollTop = transcript.scrollHeight;
            onNotice?.(line.text);
          }
        }
      }
      if (!interruptedTurns.has(turnId) && event.type === 'status' && ['loading', 'pending', 'waiting_host'].includes(event.phase)) {
        el('conversationStatus').textContent = event.phase === 'waiting_host'
          ? 'Nestor is waiting for its computer to finish a running test (less than a minute). Your message is kept.'
          : event.phase === 'loading'
          ? 'Loading your Open model… your message is waiting here.'
          : 'Waiting for the current model work on inference-host…';
        // In a voice turn Nestor says it once, before the answer (#62).
        if (event.phase === 'waiting_host' && !noticed) { noticed = true; activity('host-busy'); onNotice?.(turnLanguage === 'en'
          ? 'One moment, I’m finishing a test on my computer.' : 'Un instant, je termine un test en cours sur mon ordinateur.'); }
      }
      if (event.type === 'delta' && !interruptedTurns.has(turnId)) {
        answer += event.delta;
        if (!partial) { partial = document.createElement('div'); partial.className = 'conversation-message assistant'; if (turnSpeaker) partial.dataset.speaker = turnSpeaker.name; transcript.append(partial); }
        partial.textContent = answer; onDelta(event.delta); activity('delta', { size: event.delta.length });
      }
      // Core has sent every spoken word; pictures, tools and the record follow before `done`.
      if (event.type === 'say_end' && !interruptedTurns.has(turnId)) onSayEnd?.();
      if (event.type === 'done') { result = event.data; activity('done', { sessionId: session.sessionId, traceId: event.data?.traceId }); if (!workAccepted && !session.ephemeral) void brain.follow(session.sessionId, event.data?.traceId).then(review => workflow?.review(turnId, review, session.sessionId)); if (!session.ephemeral) void work?.poll(); }
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
      if (!session.ephemeral) void recap?.refresh(session.sessionId);
      personalNotes.show(result.continuity?.personal); degradedReply = result.routing?.fallbackUsed === true;
      showTools(result.tools);
      showExecution(result);
      // The agent consulted a team member (#41): its answer is collected and said like a member's late reply.
      if (result.consult) void followMember(session, result.consult.turnId, result.consult.speaker);
      return { ...result.reply, sound: result.sound };
    } catch (error) { workflow?.stream(turnId, { type: signal.aborted ? 'interrupted' : 'error' }); throw error; }
    finally { await reader.cancel().catch(() => {}); }
  }
  const labels = { idle: 'Ready to listen.', starting: 'Turning on the microphone…', listening: 'Listening…', hearing: 'Listening…', transcribing: 'One moment…', waiting: 'Finishing the previous answer…', thinking: 'Thinking…', preparing: 'Preparing the answer…', speaking: 'Nestor is answering…', paused: 'Mic off.', error: 'Conversation paused.', reviewing: 'Mic off for replay.', resuming: 'Resuming after playback…' };
  // The voice ladder and the VoiX backup (X-Voix-Upstream) share one notice.
  let ladderNotice = '', voixUpstream = '';
  // What the page measured on the last turn: slow recognition, a slow answer, choppy speech.
  const voiceHealth = new AgentXVoiceHealth.VoiceHealth();
  const renderVoiceNotice = () => { const text = [NestorVoixUpstream.composeNotice(ladderNotice, voixUpstream), voiceHealth.notice()].filter(Boolean).join(' '), node = el('conversationVoiceNotice'); node.hidden = !text; node.textContent = text; };
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
    unavailable: 'Voice is unavailable right now. Your conversation continues in text.' });
  // `after` is speech that failed while it played: the clause restarts on the voice below it.
  async function synthesize(text, lang, persona, voicePrefs, signal, source = 'Conversation', after = null) {
    const choices = P.speechChoices(persona, lang, voicePrefs);
    const response = await voiceLadder.speak({ text, language: lang, choices, after }, signal);
    const rung = voiceLadder.rungOf(response);
    voiceNotice(response.browserSpeech ? 'Server voice unavailable: using this browser’s voice.' : rung ? 'Chosen voice unavailable: using a backup voice.' : '');
    if (response.browserSpeech) return response;
    // The speech receipt moved to the voice workshop; a page without it still speaks.
    const receipt = el('conversationSpeechReceipt');
    if (receipt && !signal.aborted) {
      const acknowledged = decodeURIComponent(response.headers.get('X-Voix-Voice') || '');
      const actualLanguage = response.headers.get('X-Nestor-Speech-Language');
      receipt.hidden = false;
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
  const avatar = window.AvatarDock?.mount({ space: family ? 'family' : 'personal', status: el('conversationStatus'),
    // The same button pauses an active conversation: a tap only ever starts or resumes one.
    onTap: () => { const start = el('conversationStart'); if (start.hidden || start.disabled || !['idle', 'paused', 'error'].includes(conversation.state)) return false; start.click(); return true; } });
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
    const name = speaker?.name || 'The other agent';
    const url = `${sessionBase}/${encodeURIComponent(session.sessionId)}/member-reply?turn=${encodeURIComponent(turnId)}`;
    const here = () => conversation.session?.sessionId === session.sessionId;
    el('conversationStatus').textContent = `${name} is continuing in the background. Its answer will be spoken as soon as it is ready.`;
    for (let round = 0; round < 20 && here(); round += 1) {
      let work;
      try { work = (await api(url))?.work; } catch { return; }
      if (!work || !here()) return;
      if (work.pending) continue;
      transcript.querySelector('.empty')?.remove();
      const row = document.createElement('div');
      if (work.status !== 'answered' || !work.reply?.text) {
        row.className = 'conversation-message activity'; row.textContent = `${name} could not finish its answer.`;
        transcript.append(row); transcript.scrollTop = transcript.scrollHeight;
        return;
      }
      row.className = 'conversation-message assistant'; row.dataset.speaker = name; row.dataset.spoken = 'false';
      row.textContent = work.reply.text; transcript.append(row); transcript.scrollTop = transcript.scrollHeight;
      // Said at the first pause; the text is already on screen and in the history.
      for (let attempt = 0; attempt < 90 && here(); attempt += 1) {
        if (await conversation.interject(work.reply)) { row.dataset.spoken = 'true'; return; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return;
    }
  }
  const conversation = new NestorConversation.Conversation({
    requestPolicy: requestPrivacy, prepareTurnSession: preparePrivacy,
    readyToSpeak: () => avatar?.ready,
    openAudio: (signal, onError, options) => NestorConversation.openAudio(signal, onError, { ...options, captureScope: family ? 'family' : 'personal', observeSpeech: true,
      onPlaybackMetrics: metrics => { lastPlaybackMetrics = metrics; voiceHealth.segment(metrics); renderVoiceNotice(); } }).then(audio => speechFallback.wrapAudio(audio)), createSession, message, turn: streamedTurn,
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
      workflow?.stream(activeBrowserTurn, { type: 'interrupted' });
      const row = partial || transcript.querySelector('.conversation-message.assistant:last-of-type');
      if (row) { row.dataset.interrupted = 'true'; row.setAttribute('aria-label', 'Interrupted reply'); }
      partial = null;
    },
    transcribe: (blob, lang, signal) => speechFallback.transcribe(blob, lang, signal),
    localControl: (text, options) => idlePhotos?.localControl(text, options) || screenCommand?.(text, options) || null,
    transcriptionStarted: turnId => workflow?.capture(conversation.session?.sessionId, turnId),
    transcriptionDone: (turnId, values) => { latestVoiceTimings = values || {}; workflow?.timings(turnId, values); },
    transcriptionEnded: (turnId, receipt) => workflow?.captureEnd(turnId, receipt),
    // Recognition started during a pause uses the local transcriber only: the browser's own
    // recognizer hands its text over once, and an early failure must not switch engines.
    transcribeEarly: (blob, lang, signal) => (speechFallback.state().active ? null : transcribeLocal(blob, lang, signal)),
    // The person starts speaking: wake speech recognition while they talk (best effort).
    warm: () => fetch('/api/voix/warm', { method: 'POST' }),
    // The voice loop's timeline of a spoken turn, kept by Core on that recorded turn.
    timings: (session, turnId, timings) => { latestVoiceTimings = timings; voiceHealth.turn(turnId, timings); workflow?.timings(turnId, timings); renderVoiceNotice(); return api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/voice-timings`,
      { method: 'POST', keepalive: true, body: JSON.stringify({ turnId, timings }) }); },
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
      const lang = language.value === 'en' ? 'en' : 'fr';
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
    if (conversation.session?.sessionId && !conversation.session.ephemeral) { workflow?.follow(conversation.session.sessionId); work?.follow(conversation.session.sessionId); }
    if (state === 'listening') void work?.naturalPause();
    if (state === 'idle' && !open.checked) void releaseOpen();
    if (state === 'starting') void speechFallback.probe(() => api('/api/voix/health'));
    speechFallback.sync();
    el('conversationStatus').textContent = detail || (state === 'listening' && conversation.selection?.wakeWord ? (conversation.wake.active() ? 'Listening · conversation continues until Pause.' : 'Standby · say “Hey/Eille/Oh/Ah Nestor”.') : labels[state]);
    el('conversationPresence').dataset.state = state;
    const reviewing = state === 'reviewing';
    const active = !['idle', 'paused', 'error', 'reviewing'].includes(state);
    holdScreen(active || textBusy);
    el('conversationStart').disabled = textBusy && !active;
    el('conversationStart').hidden = enteringSpace && !active;
    el('conversationStart').textContent = active ? (language.value === 'fr' ? 'Pause de la voix' : 'Pause voice')
      : conversation.session ? (language.value === 'fr' ? 'Reprendre la voix' : 'Resume voice') : 'Turn on Nestor';
    el('conversationStart').title = active
      ? language.value === 'fr' ? 'Arrête le micro et la lecture audio. Les demandes déjà enregistrées restent suivies ci-dessous.'
        : 'Stops the microphone and audio playback. Saved requests remain tracked below.'
      : language.value === 'fr' ? 'Active le micro pour continuer la conversation.' : 'Turns on the microphone to continue the conversation.';
    const lockReason = renderTeam(active || textBusy);
    el('conversationWho').dataset.locked = String(!!lockReason);
    // Language and interruption are read at each turn, so they stay changeable while the conversation runs.
    for (const node of [language, interruption]) { node.disabled = false; node.title = ''; }
    [backendPicker, agentPicker, picker, open].forEach(node => {
      node.disabled = active || !!conversation.session || textBusy || (node === agentPicker && (family || !agentCatalog || backendPicker.value !== 'openclaw'));
      node.title = node.disabled && lockReason ? lockReason : '';
    });
    renderModel();
    renderPrivacy();
    wake.disabled = textBusy || !['idle', 'paused', 'error', 'listening'].includes(state);
    // Waiting voice (open listening or wake standby) accepts a typed message as its next turn.
    const typing = active && !conversation.canType();
    el('conversationText').querySelector('button').disabled = typing || reviewing || textBusy;
    if (!family) { el('conversationFiles').disabled = typing || reviewing || textBusy; renderDraftFiles(); }
    renderAudioReview();
    window.dispatchEvent(new CustomEvent('persona-presence', { detail: { personaId: conversation.session?.persona?.id || selected().id,
      personaVersion: conversation.session?.persona?.version || selected().version, state, visual: conversation.session?.visual || conversation.session?.persona?.visual || selected().visual || null,
      sample: { speech: () => conversation.audio?.readSpeechSample?.(), input: () => conversation.audio?.readInputLevel?.(),
        // Waiting for "Hey Nestor": the face dozes until the word wakes him.
        asleep: () => !!conversation.selection?.wakeWord && ['listening', 'hearing'].includes(conversation.state) && !conversation.wake.active() } } }));
  });
  renderSpeechFallback = NestorSpeechFallback.mountSpeechFallbackPanel(speechFallback, { notice: el('conversationBrowserSttNotice'),
    settings: fallbackSettings, indicator: el('conversationBrowserSttIndicator') },
  { onConsent: () => { if (conversation.state === 'reviewing') void conversation.start(selection()); } });
  let workshop = null;
  function renderAudioReview() {
    if (conversation.state === 'listening' && conversation.selection?.wakeWord) el('conversationStatus').textContent = conversation.wake.active() ? 'Listening · conversation continues until Pause.' : 'Standby · say “Hey/Eille/Oh/Ah Nestor”.';
    workshop?.refresh();
  }
  function syncVoicePreferences() {
    preferences = P.read(storage, catalog); interruption.checked = preferences.interruption;
    language.value = P.profile(preferences.profiles[picker.value]).language;
    try { const saved = storage?.getItem(listeningKey); wake.checked = (['wake','open'].includes(saved) ? saved : defaultListening) === 'wake'; } catch {}
    conversation.setLanguage(language.value); conversation.setInterruption(interruption.checked); conversation.setWakeWord(wake.checked);
    if (conversation.selection) conversation.selection.voice = selection().voice;
    describeListening(); describe();
  }
  window.addEventListener('storage', event => { if (event.key === 'household.conversation.preferences.v2' || event.key === listeningKey) syncVoicePreferences(); });
  window.addEventListener('pageshow', event => { if (event.persisted) syncVoicePreferences(); });
  el('conversationWorkshop').onclick = async () => {
    workshop = await window.AgentXVoiceWorkshop.open({ scope: family ? 'family' : 'personal', conversation, selection,
      personas: catalog, measurements: () => ({ ...latestVoiceTimings, ...lastPlaybackMetrics }), extraSettings: fallbackSettings, flow: family ? null : diagnosticFlow,
      onSaved: () => { conversation.stop(true); syncVoicePreferences(); } });
  };
  function showExecution(data) {
    const text = engines.observed(data);
    el('conversationExecution').textContent = text;
    el('conversationExecution').hidden = family || !text;
  }
  function showTools(evidence) {
    const receipts = evidence?.receipts || [];
    const box = el('conversationTools'); box.hidden = !receipts.length && !['unavailable', 'not_supported'].includes(evidence?.status);
    if (box.hidden) return;
    el('conversationToolsStatus').textContent = evidence.status === 'not_supported' ? engines.label(conversation.session?.backend || backendPicker.value) + ' · no tool receipts supported for this answer.' : evidence.status === 'unavailable'
      ? 'Tool receipts are unavailable.'
      : receipts.map(receipt => receipt.tool + (receipt.status === 'failed' ? ' · failed'
        : receipt.status === 'verified' ? ' · result received'
          : receipt.observed ? ' · call observed, result not verified' : ' · result unavailable')).join(' · ');
    el('conversationToolsReceipt').textContent = JSON.stringify(evidence, null, 2);
  }
  // The team member this conversation is (or will be) with, and why settings are locked.
  function renderTeam(busy = false) {
    if (family) return '';
    const backend = conversation.session?.backend || backendPicker.value;
    companion?.configure(backend);
    if (backend === 'hermes') {
      el('conversationTeam').hidden = true;
      const notice = conversation.session ? 'Hermes · start a new conversation to change engines.' : '';
      el('conversationLockedText').textContent = notice; el('conversationLocked').hidden = !notice;
      el('conversationLockedNew').hidden = !conversation.session;
      return notice;
    }
    const activeAgentId = conversation.session?.agentId || agentPicker.value;
    const locked = !!conversation.session;
    ConversationTeam.render(el('conversationTeam'), { list: team, activeAgentId, locked: locked || busy, esc });
    const notice = ConversationTeam.lockNotice({ locked, busy: busy && !locked, name: ConversationTeam.memberName(team, agents, activeAgentId) });
    el('conversationLockedText').textContent = notice;
    el('conversationLocked').hidden = !notice;
    el('conversationLockedNew').hidden = !locked;
    return notice;
  }
  if (!family) el('conversationTeam').onclick = (event) => {
    const card = event.target.closest('button[data-agent]');
    if (!card || card.disabled || conversation.session) return;
    backendPicker.value = 'openclaw';
    try { storage?.setItem(backendKey, 'openclaw'); } catch {}
    agentPicker.value = card.dataset.agent;
    picker.value = card.dataset.persona;
    picker.onchange();
  };
  // The style picker offers what suits the chosen member; a resumed conversation keeps its own.
  function syncStyles() {
    if (family || conversation.session) return;
    const offered = backendPicker.value === 'hermes' ? ConversationTeam.stylesFor(personas, 'main') : ConversationTeam.stylesFor(personas, agentPicker.value);
    if (!offered.length) return;
    const current = offered.some(p => p.id === picker.value) ? picker.value : (offered.find(p => p.agentId === agentPicker.value) || offered[0]).id;
    picker.replaceChildren(...offered.map(p => new Option(p.name, p.id)));
    picker.value = current;
    el('conversationPersonaField').hidden = offered.length < 2;
  }
  // Why the model switch is fixed, or what it will do.
  function renderModel() {
    const backend = conversation.session?.backend || backendPicker.value, hint = el('conversationModelHint');
    if (backend === 'hermes') { open.disabled = true; hint.textContent = 'Hermes uses its own model; Abliterated does not apply.'; }
    else if (conversation.session) hint.textContent = (open.checked ? 'Abliterated' : 'Standard') + ' for this conversation. Start a new one to switch.';
    else if (textBusy) hint.textContent = 'Locked while Nestor is working.';
    else hint.textContent = open.checked ? 'Local uncensored model, loaded on demand.' : 'Everyday model.';
    open.title = open.disabled ? hint.textContent : '';
    summarize();
  }
  function describe() {
    syncStyles(); renderTeam();
    const agent = agents.find(agent => agent.id === (conversation.session?.agentId || agentPicker.value)) || selectedAgent();
    const backend = conversation.session?.backend || backendPicker.value;
    const native = backend === 'openclaw', hermes = backend === 'hermes';
    if (hermes) { open.checked = false; el('conversationOpenStatus').hidden = true; }
    agentPicker.disabled = family || !native || !agentCatalog || !!conversation.session;
    // With two or more members, the "Talk with" bar is the member picker.
    el('conversationNativeAgent').hidden = !native || !el('conversationTeam')?.hidden;
    el('conversationAgentDescription').textContent = hermes ? 'Hermes uses its own account and model; voice and history stay in AgentX.'
      : !native ? 'AgentX routing picks the model.' : agentCatalog ? `${agent.name} · OpenClaw model ${agent.model || 'native default'}.`
      : 'Member list unavailable; Main still answers.';
    renderModel();
    el('conversationAgentContext').textContent = family ? 'Nestor · family conversations and memories.' : hermes ? 'Nestor · Hermes conversation with the context provided by AgentX.' : native ? agent.name + ' · conversations, tools and private memories.' : 'Conversation with the context provided to AgentX.';
    if (family) { open.checked = false; personalNotes.show(null); }
    const p = conversation.session?.persona || selected();
    const visual = conversation.session?.visual || p.visual;
    el('conversationInitial').textContent = p.name.charAt(0);
    el('conversationInitial').hidden = visual?.style === 'orb';
    el('conversationPresence').dataset.style = visual?.style || 'initials';
    el('conversationPresence').style.setProperty('--presence-color', P.visual(visual)?.color || '#52cfc5');
    el('personaDescription').textContent = p.description || p.name;
  }
  const restoreProfile = () => {
    const profile = P.profile(preferences.profiles[picker.value]);
    language.value = profile.language;
  };
  backendPicker.onchange = () => {
    privacyBackend = null;
    if (!engines.available(runtime, family).includes(backendPicker.value)) backendPicker.value = engines.choose(runtime, family);
    if (!family) { try { storage?.setItem(backendKey, backendPicker.value); } catch {} }
    if (backendPicker.value === 'hermes') { open.checked = false; if (personas.some(p => p.id === 'nestor')) picker.value = 'nestor'; void releaseOpen(); }
    restoreProfile(); describe();
  };
  agentPicker.onchange = () => { savePreferences(); describe(); };
  picker.onchange = () => { restoreProfile(); savePreferences(); describe(); };
  for (const field of [language]) field.onchange = () => { savePreferences(); describe(); work?.refresh(); };
  language.addEventListener('change', () => { conversation.setLanguage(language.value); summarize(); });
  interruption.onchange = () => { savePreferences(); conversation.setInterruption(interruption.checked); };
  restoreProfile(); describe();
  open.onchange = () => { privacyChoice.select(open.checked); if (open.checked) void openHold.start(); else void releaseOpen(); renderModel(); renderPrivacy(); };
  if (!family) {
    el('conversationEphemeral').onchange = event => { privacyChoice.choose(event.target.checked); renderPrivacy(); };
    el('conversationPrivacyDirect').onclick = () => {
      privacyBackend = 'agentx';
      if (!conversation.session) { backendPicker.value = 'agentx'; describe(); }
      renderPrivacy();
    };
  }
  // What a press on Activer Nestor or Reprendre starts; opening a saved conversation starts it too.
  const startVoice = options => {
    preferences.lastVoice = chosenVoice(); savePreferences();
    if (open.checked) void openHold.start();
    return conversation.start(selection(), options);
  };
  el('conversationStart').onclick = () => {
    if (!['idle', 'paused', 'error', 'reviewing'].includes(conversation.state)) { conversation.stop(true); return; }
    return startVoice();
  };
  el('conversationNew').onclick = () => {
    privacyChoice.reset(open.checked); privacyBackend = null;
    recap?.clear();
    el('conversationResume').hidden = true; setHistoryOpen(false); conversation.stop(); work?.reset(); workflow?.reset(); void releaseOpen(); partial = null;
    transcript.innerHTML = '<p class="empty">Our conversation will appear here.</p>'; clearBoard(); brain.reset(); showExecution(null);
    personalNotes.show(null);
    showTools(null); if (!privacyChoice.snapshot().ephemeral) void recap?.refresh();
    el('conversationMessage').value = ''; composer.sync(); draftFiles = []; renderDraftFiles(); restoreProfile(); describe(); el('conversationMessage').focus();
  };
  // Enter sends, Shift+Enter adds a line; an IME composition keeps its Enter.
  el('conversationMessage').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    el('conversationText').requestSubmit();
  });
  el('conversationText').onsubmit = async event => {
    event.preventDefault();
    const typed = el('conversationMessage');
    if (!draftFiles.length && screenCommand?.(typed.value)) { typed.value = ''; composer.sync(); return; }
    if (!textBusy && conversation.canType()) return typedDuringVoice();
    if (textBusy || !['idle', 'paused', 'error'].includes(conversation.state)) return;
    const input = el('conversationMessage'), text = input.value.trim(); if (!text) return;
    const submittedPrivacy = requestPrivacy();
    let shown = false;
    textBusy = true; conversation.abort = new AbortController(); const epoch = ++conversation.epoch;
    conversation.show('thinking');
    try {
      if (open.checked) await openHold.start();
      if (!conversation.current(epoch)) return;
      let session = conversation.session || await createSession({ ...selection(), ...submittedPrivacy }, conversation.abort.signal);
      session = await preparePrivacy(session, submittedPrivacy, conversation.abort.signal);
      if (!conversation.current(epoch)) return;
      conversation.session = session;
      const attachments = await uploadDraftFiles(session, conversation.abort.signal);
      if (!conversation.current(epoch)) return;
      message('user', text, false, null, attachments);
      // The message now lives in the transcript: empty the composer at once,
      // unless the person already started typing the next one.
      shown = true; if (input.value.trim() === text) input.value = '';
      draftFiles = []; renderDraftFiles();
      const reply = await streamedTurn(conversation.session, text, conversation.abort.signal, undefined, { attachmentIds: attachments.map(item => item.id), requestPolicy: submittedPrivacy });
      if (conversation.current(epoch)) { message('assistant', reply.text, false, reply.sound); conversation.show('paused'); }
    } catch (error) {
      // A failed send gives the text back so it can be sent again.
      if (shown && !input.value.trim()) input.value = text;
      if (conversation.current(epoch)) conversation.fail(error, epoch);
    }
    finally {
      composer.sync(); textBusy = false; conversation.show(conversation.state, el('conversationStatus').textContent);
      if (document.hidden) void releaseOpen(); // finished while the page was hidden
    }
  };
  async function typedDuringVoice() {
    const input = el('conversationMessage'), text = input.value.trim(); if (!text) return;
    textBusy = true; conversation.show(conversation.state);
    const submittedPrivacy = requestPrivacy();
    let attachments = null, failure = '';
    try { conversation.session = await preparePrivacy(conversation.session, submittedPrivacy, conversation.abort.signal); attachments = await uploadDraftFiles(conversation.session, conversation.abort.signal); }
    catch (error) { failure = error.message; }
    textBusy = false;
    if (!attachments) { conversation.show(conversation.state, failure); return; }
    if (input.value.trim() === text) input.value = '';
    draftFiles = []; renderDraftFiles();
    if (!await conversation.typed(text, { attachments, requestPolicy: submittedPrivacy }) && !input.value.trim()) input.value = text;
    composer.sync();
  }
  // A hidden page stops listening; a typed turn already sent is left to finish.
  const visit = family ? null : window.NestorGuidedVisit.mount({ host: app.querySelector('.conversation-toolbar'),
    onExpire: () => { if (document.hidden && !textBusy) { conversation.stop(true); void releaseOpen(); } } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !visit?.active()) { if (!textBusy) { conversation.stop(true); void releaseOpen(); } } });
  window.addEventListener('pagehide', () => { progress?.dispose(); visit?.dispose(); pagePicker?.dispose(); work?.dispose(); stopPreview(); conversation.stop(); void openHold.release({ watch: false }); });
  el('runtimePill').textContent = 'ready';
  conversation.show('idle');
  const performance = family ? null : ConversationPreferences.mount({ button: el('conversationPerformance'), api, endpoint: '/api/voice-personas/preferences',
    note: 'These settings control the additions Core provides. With OpenClaw, the agent’s own memory, history and tools are set in its native interface.',
    integrations: [{ title: 'Models, routing and local hosts', href: '/nerve-center' }, { title: 'Native agent memory and tools · OpenClaw', href: '/api/openclaw/control-launch/chat' }],
    onSaved: () => brain.reset()
  });
  window.addEventListener('pagehide', () => performance?.clear());
  const recap = family ? null : ConversationRecap.mount({ host: el('conversationRecap'), api, base: sessionBase,
    currentId: () => conversation.session?.sessionId || null, title: 'Conversation recap',
    prepare: async () => { if (textBusy || conversation.state === 'thinking') return false; conversation.stop(true); await releaseOpen(); },
    onResume: async id => { const data = await api(`${sessionBase}/${encodeURIComponent(id)}/history`); return resumeSession(data.session, el('conversationHistoryToggle')); }
  });
  if (!privacyChoice.snapshot().ephemeral) void recap?.refresh();
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
    el('conversationResume').hidden = true; conversation.stop();
    void releaseOpen();
    const epoch = conversation.epoch;
    button.disabled = true;
    el('conversationStatus').textContent = 'Loading the conversation…';
    try {
      const data = await api(`${sessionBase}/${encodeURIComponent(session.sessionId)}/history`);
      if (epoch !== conversation.epoch) return;
      conversation.session = data.session; privacyChoice.restore(data.session); privacyBackend = null; renderPrivacy(); workflow?.follow(data.session.sessionId); work?.follow(data.session.sessionId);
      draftFiles = []; renderDraftFiles();
      const saved = data.session;
      if (saved.persona && !personas.some(p => p.id === saved.persona.id)) { personas.push(saved.persona); picker.add(new Option(saved.persona.name, saved.persona.id)); }
      if (!agents.some(agent => agent.id === (saved.agentId || 'main'))) {
        agents.push({ id: saved.agentId, name: saved.agentId }); agentPicker.add(new Option(saved.agentId, saved.agentId));
      }
      agentPicker.value = saved.agentId || 'main';
      backendPicker.value = engines.choose(runtime, family, saved.backend);
      if (!family && engines.available(runtime, false).includes(saved.backend)) { try { storage?.setItem(backendKey, saved.backend); } catch {} }
      picker.value = saved.persona?.id || 'nestor'; open.checked = !!saved.inference?.open;
      language.value = P.profile(data.session.voice).language;
      transcript.replaceChildren(); partial = null; clearBoard(); brain.reset();
      (data.turns || []).forEach(turn => {
        if (turn.inputText) message('user', turn.inputText, false, null, turn.attachments);
        if (turn.replyText) message('assistant', turn.replyText, turn.interrupted, null, [], turn.speakerAgentId ? ConversationTeam.memberName(team, agents, turn.speakerAgentId) : '');
        board.restore(turn.display);
      });
      workflow?.restore(data.session.sessionId, data.turns || []);
      if (data.turns?.length >= data.policy?.maximumDisplayedTurns && saved.turnCount > data.turns.length) {
        const earlier = document.createElement('p'); earlier.className = 'conversation-earlier';
        earlier.textContent = `The ${data.turns.length} most recent messages are shown; older ones remain saved.`;
        transcript.prepend(earlier);
      }
      void ConversationImages.resume(`${sessionBase}/${encodeURIComponent(data.session.sessionId)}`, block => { if (!board.has(`image:${block.operation.id}`)) board.add(block); },
        { current: () => conversation.session?.sessionId === data.session.sessionId }); // starting voice moves the epoch
      personalNotes.show(data.turns?.at(-1)?.personalContinuity);
      showTools(data.turns?.at(-1)?.toolEvidence);
      showExecution(data.turns?.at(-1));
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
    const recent = el('conversationRecent'); recent.textContent = 'Loading conversations…';
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
        button.querySelector('.conversation-history-meta').textContent = (family ? 'Family' : 'Super Dad') + ' · ' + personaName.split(' ·')[0];
        const stamp = session.lastTurnAt || session.createdAt, date = stamp ? new Date(stamp) : null;
        const when = date && Number.isFinite(date.getTime()) ? date.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Date unavailable';
        const count = Number.isFinite(session.turnCount) ? ' · ' + session.turnCount + (session.turnCount === 1 ? ' message' : ' messages') : '';
        button.querySelector('.conversation-history-date').textContent = when + count;
        button.onclick = () => resumeSession(session, button);
        const item = document.createElement('div'); item.className = 'conversation-history-entry';
        item.append(button);
        if (!family) {
          const actions = document.createElement('div'); actions.className = 'conversation-history-actions';
          const download = document.createElement('a'); download.className = 'button'; download.textContent = 'Export';
          download.href = `${sessionBase}/${encodeURIComponent(session.sessionId)}/export`; download.download = 'agentx-conversation.json';
          const erase = document.createElement('button'); erase.type = 'button'; erase.className = 'button'; erase.textContent = 'Delete';
          erase.onclick = async () => {
            if (!window.confirm('Delete this conversation and its files in AgentX? Memories saved separately and copies in external services are kept.')) return;
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
      if (!recent.children.length) recent.textContent = 'No conversation to resume yet.';
    } catch {
      if (request === historyRequest) recent.textContent = 'Recent conversations are unavailable. Close and reopen the history to try again.';
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
      card.innerHTML = '<p><strong>Resume the last conversation</strong> <span class="muted"></span></p>'
        + '<p class="conversation-resume-preview"></p><div class="conversation-resume-actions">'
        + '<button type="button" class="button primary">Resume</button><button type="button" class="button">Dismiss</button></div>';
      card.querySelector('.muted').textContent = '· ' + (minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`);
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
      } else el('conversationStatus').textContent = 'Turn on Nestor once to allow the mic and sound.';
    } catch { el('conversationStatus').textContent = 'Press Turn on Nestor to set up this device.'; }
  }
  idlePhotos = window.NestorIdlePhotos?.mount({ host: app.querySelector('.conversation-toolbar'), api, space,
    standby: () => !!conversation.selection?.wakeWord && !conversation.wake.active(),
    busy: () => textBusy || !['idle', 'paused', 'listening'].includes(conversation.state)
      || !el('conversationSettings').hidden || !!document.querySelector('dialog[open]')
      || !!el('conversationMessage').value.trim(),
    controls: {
      Settings: () => { if (el('conversationSettings').hidden) el('conversationSettingsToggle').click(); },
      Flow: () => { if (family) return el('conversationWorkshop').click(); diagnosticFlow.querySelectorAll('details').forEach(node => { node.open = true; }); diagnosticFlow.scrollIntoView({ block: 'start' }); },
      'Diagnostic micro': () => el('conversationWorkshop').click(),
      'Micro · activer / pause': () => el('conversationStart').click()
    }
  });
  window.addEventListener('pagehide', event => { if (event.persisted) idlePhotos?.activity(); else idlePhotos?.dispose(); });
  enteringSpace = false;
  conversation.show(conversation.state, el('conversationStatus').textContent);

};
