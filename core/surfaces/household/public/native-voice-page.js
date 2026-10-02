/* Native voice (/voice/native): the VoiX session console. It starts and stops
   the native voice session, follows its events, metrics and memory, and
   manages the voice media vault through Core's /api/voix routes.
   app.js routes here and lends its shared helpers through ctx. */
(function () {
  let app, api, esc, state, toast, setRuntime, stopPlayback, speak, browserSpeak;

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

  window.HouseholdNativeVoice = {
    load(ctx) {
      ({ app, api, esc, state, toast, setRuntime, stopPlayback, speak, browserSpeak } = ctx);
      return loadVoice();
    }
  };
})();
