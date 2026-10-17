/* One workshop for standalone tests and the current conversation's diagnostics. */
(function (root) {
  'use strict';
  
  const V = root.AgentXVoiceWorkshopView;
  const { names, paths, tabs } = V;
  const examples = {
    initial: { fr:'Bonjour ! Prenons le temps de vérifier les mots, les nombres et les pauses.', en:'Hello! Let’s take the time to check the words, the numbers, and the pauses.' },
    natural: { fr:'Salut ! On prend le temps de se parler. Comment se passe ta journée ?', en:'Hi! Let’s take some time to chat. How is your day going?' },
    numbers: { fr:'Un, deux, un, deux. Sept, dix-sept et soixante-dix. Rendez-vous le 7 septembre, à 14 h 30.', en:'One, two, one, two. Seven, seventeen, and seventy. Let’s meet on September 7 at 2:30 p.m.' },
    english: { fr:'Bonjour ! Vérifions le rythme, les nombres et les pauses. Sept, dix-sept, soixante-dix.', en:'Hello! Let’s check the rhythm, the numbers, and the pauses. Seven, seventeen, seventy.' },
  };
  const number = (x, suffix = '') => Number.isFinite(x) ? Math.round(x).toLocaleString('fr-CA') + suffix : 'Non mesuré';
  async function request(url, options = {}) {
    const response = await root.fetch(url, { credentials: 'same-origin', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false || payload.status === 'error') throw new Error(payload.message || `Service indisponible (${response.status}).`);
    return payload.data ?? payload;
  }
  async function mount({ host, scope = 'personal', tab = 'microphone', conversation = null, selection = () => ({}), personas: supplied = null,
    extraSettings = null, flow = null, measurements = () => ({}), onClose = () => {}, onSaved = () => {}, signal = null, api = request } = {}) {
    const S = root.AgentXVoiceSettings;
    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    scope = S.SCOPES.includes(scope) ? scope : 'personal';
    const embedded = Boolean(conversation);
    host.innerHTML = V.template(scope, embedded);
    const find = selector => host.querySelector(selector), role = name => find(`[data-role="${name}"]`), field = name => find(`[data-field="${name}"]`);
    const life = new AbortController(), state = { busy: false, destroyed: false, catalog: null, personas: supplied || [], lastResult: null, tab, speech: 'idle', speechRun: 0, replaying: false, replayRun: 0, receipt: null, sessionDetail: '' };
    let prefs, standalone, interval, textLanguage = 'fr', exampleName = 'initial';
    const textDrafts = new Map();
    const visual = V.create(host);
    signal?.addEventListener('abort', () => life.abort(), { once:true });
    find('[data-action="close"]')?.addEventListener('click', onClose, { signal:life.signal });
    const notice = text => { role('notice').textContent = text || ''; };
    const hasSpeechText = () => Boolean(field('speechText').value.trim());
    const canStopSpeech = () => embedded
      ? ['speaking','preparing'].includes(conversation.state) && Boolean(conversation.activeTurn) && !conversation.activeTurn.speech.signal.aborted
      : ['preparing','scheduled'].includes(state.speech);
    const setRows = (node, rows) => { node.replaceChildren(); for (const [label, value] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value ?? 'Non observé'; node.append(dt, dd); } };
    const capture = () => S.normalize(Object.fromEntries([...host.querySelectorAll('[data-capture]')].map(el => [el.dataset.capture, el.value === '' ? NaN : Number(el.value)])), true);
    const draft = () => ({ ...prefs, language: field('language').value, voice: field('voice').value,
      wakeWord: field('wakeWord').checked, interruption: field('interruption').checked, linksClickable: field('linksClickable').checked,
      spokenReplies: field('spokenReplies').checked, autoSend: field('autoSend').checked, inputDeviceId: field('inputDeviceId').value });
    function voiceOptions(select, lang, selected = '') {
      select.replaceChildren(new Option('Voix effective du parcours', ''));
      for (const voice of state.catalog?.voices || []) {
        if (voice.language !== lang) continue;
        const key = voice.provider + '|' + voice.id, option = new Option(`${voice.name} · ${voice.locale || lang}${voice.available ? '' : ' · indisponible'}`, key);
        option.disabled = !voice.available; select.add(option);
      }
      if (selected && ![...select.options].some(o => o.value === selected)) { const option = new Option('Voix enregistrée · disponibilité non confirmée', selected); select.add(option); }
      select.value = selected;
    }
    function updateExample(language, preset = null) {
      const text = field('speechText').value;
      const example = Object.entries(examples).find(([,texts]) => texts[textLanguage] === text);
      if (example) { exampleName = example[0]; textDrafts.delete(textLanguage); }
      else textDrafts.set(textLanguage, text);
      if (preset) { exampleName = preset; textDrafts.delete(language); }
      field('speechText').value = textDrafts.has(language) ? textDrafts.get(language) : examples[exampleName][language];
      field('speechText').lang = language === 'fr' ? 'fr-CA' : 'en';
      textLanguage = language;
    }
    function renderPrefs() {
      prefs = S.read(scope, state.personas);
      if (scope === 'psyx') try {
        if (!root.localStorage.getItem(root.PsyXVoicePreferences.STORAGE_KEY)) {
          const candidate = root.PsyXVoicePreferences.preferredFemaleVoice(state.catalog, prefs.language);
          if (candidate) prefs.voice = candidate.provider + '|' + candidate.id;
        }
      } catch {}
      const selectedId = embedded ? selection().personaId : null;
      if (selectedId && ['personal','family'].includes(scope) && state.personas.some(p => p.id === selectedId)) {
        const profile = root.PersonaPresentation.read((() => { try { return root.localStorage; } catch { return null; } })(), state.personas).profiles[selectedId];
        prefs.personaId = selectedId; prefs.language = profile?.language || 'fr'; prefs.voice = profile?.selections?.[prefs.language] || '';
      }
      field('language').value = prefs.language; field('testLanguage').value = prefs.language;
      updateExample(prefs.language);
      if (field('compareLanguage')) field('compareLanguage').value = prefs.language === 'fr' ? 'en' : 'fr';
      voiceOptions(field('voice'), prefs.language, prefs.voice); voiceOptions(field('testVoice'), prefs.language, prefs.voice);
      for (const key of ['wakeWord','interruption','linksClickable','spokenReplies','autoSend']) field(key).checked = prefs[key] === true;
      if (prefs.inputDeviceId) field('inputDeviceId').add(new Option('Micro enregistré', prefs.inputDeviceId));
      field('inputDeviceId').value = prefs.inputDeviceId;
      for (const [key, value] of Object.entries(prefs.capture)) find(`[data-capture="${key}"]`).value = value;
      role('owner').textContent = prefs.owner;
      role('psyx').hidden = scope !== 'psyx'; role('wake').hidden = !['personal','family'].includes(scope); role('links').hidden = scope !== 'family'; role('interrupt').hidden = !['personal','family'].includes(scope);
    }
    function showTab(value) {
      const selected = Object.hasOwn(tabs, value) ? value : 'microphone'; state.tab = selected;
      for (const node of host.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== selected;
      for (const button of host.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === selected));
    }
    function refresh() {
      if (state.destroyed) return;
      const active = conversation || standalone?.conversation, info = active?.audio?.reviewStatus();
      const phase = active?.state || 'idle';
      if (state.comparisonExcerptId && state.comparisonExcerptId !== info?.id) {
        role('comparison')?.replaceChildren(); state.comparisonExcerptId = null;
      }
      if (embedded) setRows(role('timings'), Object.entries(measurements()).filter(([,v]) => typeof v === 'number').map(([k,v]) => [k, number(v, ' ms')]));
      const level = active?.audio?.readInputLevel() || 0;
      role('level').value = Math.min(1, level * 5);
      if (active?.audio) role('device').textContent = active.audio.deviceLabel || 'Micro de cet appareil';
      const recognitionFailed = info?.stt === 'failed';
      if (recognitionFailed) state.lastResult = null;
      const result = state.lastResult || info?.attempt || {};
      setText(role('transcript'), recognitionFailed ? 'Transcription indisponible. Réécoutez l’extrait, puis reprenez l’écoute.' : result.control === 'stop' ? 'Commande Stop' : state.lastResult?.text ?? info?.text ?? 'Votre prochaine phrase apparaîtra ici.');
      const recognition = result.recognition || {};
      visual.update({ phase, embedded, hasAudio:Boolean(active?.audio), recognition:result, recognitionFailed, level, speech:state.speech, receipt:state.receipt, detail:state.sessionDetail, wakeWord:field('wakeWord').checked, language:state.tab === 'speech' ? field('testLanguage').value : field('language').value });
      setText(role('flowState'), embedded ? 'Conversation courante · ' + role('phase').textContent : 'Les essais STT et TTS de cet atelier n’envoient aucune demande au cerveau ni aux outils.');
      setRows(role('metrics'), [['Extrait disponible', info?.id ? number(info.seconds * 1000, ' ms') : null],
        ['Identité STT', result.recognitionId || recognition.id], ['Modèle effectif', result.effectiveModel || result.model],
        ['Langue demandée / décodée', [result.language, result.detectedLanguage].filter(Boolean).join(' / ') || null],
        ['Attente du verrou STT', number(recognition.queueMs, ' ms')], ['Décodage STT', number(recognition.decodeMs, ' ms')],
        ['Traitement STT déclaré', number(result.sttMs, ' ms')], ['Exécution STT observée', [recognition.device, recognition.computeType].filter(Boolean).join(' · ') || null], ['Service ayant répondu', result.usedUpstream || null], ['Écho rejeté', info ? number(info.rejectedMs, ' ms') : null], ['Échantillonnage', info ? number(info.sampleRate, ' Hz') : null], ['Annulation d’écho navigateur', info?.echoCancellation === undefined ? null : info.echoCancellation ? 'Active' : 'Inactive'], ['Réduction du bruit', info?.noiseSuppression === undefined ? null : info.noiseSuppression ? 'Active' : 'Inactive'], ['Gain automatique', info?.autoGainControl === undefined ? null : info.autoGainControl ? 'Actif' : 'Inactif']]);
      role('clip').textContent = info?.id ? `Extrait temporaire · effacement dans ${Math.max(0,Math.ceil((info.expiresAt-Date.now())/1000))} s. Capturé avant le filtre d’écho ; traitements navigateur déjà appliqués.` : 'Aucun extrait disponible.';
      const reviewing = phase === 'reviewing', canReview = ['listening','hearing','reviewing'].includes(phase) && !active?.activeTurn && !active?.turnPending;
      for (const action of ['review','recent']) find(`[data-action="${action}"]`).disabled = state.busy || !canReview || (action === 'review' ? !info?.id : !info?.recentSeconds);
      for (const action of ['replay','erase']) find(`[data-action="${action}"]`).disabled = state.busy || !reviewing || !info?.id;
      const compare = find('[data-action="compare"]'); if (compare) compare.disabled = state.busy || !reviewing || !info?.id;
      find('[data-action="start"]').disabled = state.busy || !['idle','paused','error','reviewing'].includes(phase);
      find('[data-action="stopReplay"]').disabled = !state.replaying;
      find('[data-action="stopSpeech"]').disabled = !canStopSpeech();
      find('[data-action="speak"]').disabled = embedded || state.busy || !root.VoixAudio?.Speech || !hasSpeechText();
    }
    const exclusive = async work => {
      if (state.busy || state.destroyed) return;
      state.busy = true; refresh();
      try { await work(); } catch (error) { if (error.name !== 'AbortError') notice(error.message); }
      finally { state.busy = false; if (!state.destroyed) refresh(); }
    };
    showTab(tab);
    notice('Chargement des informations vocales…');
    // Load only the selected surface's authorized voice metadata. No warming or synthesis.
    try {
      if (scope === 'psyx') {
        const status = await api('/api/psyx/voice/status', { signal: life.signal });
        if (status.enabled === false) throw new Error('La voix PsyX n’est pas configurée.');
        state.catalog = await api('/api/psyx/voice/catalog', { signal: life.signal });
        setRows(role('service'), [['Source', 'Service protégé PsyX'], ['Modèle', status.config?.whisperModel], ['Moteur', status.config?.ttsProvider]]);
      } else {
        const results = await Promise.allSettled([api('/api/voice-personas/catalog', { signal: life.signal }), api('/api/voix/catalog', { signal: life.signal }), api('/api/voix/settings', { signal: life.signal })]);
        if (results[0].status === 'fulfilled') state.personas = results[0].value.personas || [];
        if (results[1].status === 'fulfilled') state.catalog = results[1].value;
        if (results[2].status === 'fulfilled') { const s = results[2].value; setRows(role('service'), [['Source', 'Service principal · démarrage'], ['Modèle', s.model], ['Appareil', s.device], ['Calcul', s.computeType], ['Seuil VAD', s.vadThreshold], ['Attente maximale', number(s.queueTimeoutSeconds, ' s')]]); }
        const failed = results.filter(r => r.status === 'rejected'); if (failed.length) notice(failed.map(r => r.reason.message).join(' '));
      }
    } catch (error) { notice(error.message); }
    if (life.signal.aborted) return { destroy() {} };
    if (role('notice').textContent === 'Chargement des informations vocales…') notice('');
    renderPrefs();
    function describeShared() {
      const selected = state.personas.find(p => p.id === field('sharedPersona')?.value), voice = selected?.voice || {};
      if (!field('sharedProvider')) return;
      find('[data-action="sharedVoice"]').disabled = !selected;
      field('sharedProvider').value = voice.provider || state.catalog?.providers?.find(p => p.available)?.id || 'kokoro';
      field('sharedFr').value = voice.voices?.fr || ''; field('sharedEn').value = voice.voices?.en || '';
      role('sharedStatus').textContent = selected ? `Origine effective : ${voice.source || 'catalogue'}. Une sauvegarde devient un choix de personnalité.` : 'Personnalité indisponible.';
    }
    if (scope === 'personal') {
      field('sharedPersona').replaceChildren(...state.personas.filter(p => p.id !== 'native_personality').map(p => new Option(p.name, p.id)));
      field('sharedProvider').replaceChildren(...(state.catalog?.providers || []).map(p => new Option(p.name || p.id, p.id)));
      const requested = new URLSearchParams(root.location.search).get('persona');
      if (requested && !state.personas.some(p => p.id === requested)) {
        field('sharedPersona').prepend(new Option('Créer ou choisir la personnalité concernée', '')); field('sharedPersona').value = '';
        notice('La personnalité demandée n’est pas disponible. Créez-la dans Team ou choisissez explicitement une personnalité existante.');
      } else field('sharedPersona').value = requested || prefs.personaId || 'nestor';
      field('sharedPersona').addEventListener('change', describeShared, { signal:life.signal }); describeShared();
    }
    if (!root.VoixAudio?.Speech) { notice([role('notice').textContent, 'Le lecteur TTS est indisponible. Les réglages et les diagnostics micro restent accessibles.'].filter(Boolean).join(' ')); find('[data-action="speak"]').disabled = true; }
    const persona = () => state.personas.find(p => p.id === prefs.personaId) || state.personas.find(p => p.id === 'nestor') || {};
    standalone = root.AgentXVoiceWorkshopSession.create({ scope, language: () => field('language').value, capture, preferences: draft, persona,
      changed: (_phase, detail) => { state.sessionDetail = detail || ''; if (!state.destroyed) refresh(); },
      scheduled: () => { if (!state.destroyed && state.speech === 'preparing') { state.speech = 'scheduled'; refresh(); } },
      result: value => { state.lastResult = value; refresh(); },
      timing: values => setRows(role('timings'), Object.entries(values).filter(([k,v]) => typeof v === 'number' && (/Ms$|_ms$/.test(k) || ['sttDone','sttServer','audioMs','silenceMs'].includes(k))).filter(([k]) => !['requestSent','firstDelta','firstAudio','firstFrameScheduled','firstSignalScheduled'].includes(k)).map(([k,v]) => [k, number(v, ' ms')])),
      receipt: value => { if (state.destroyed || !['preparing','scheduled'].includes(state.speech)) return; state.receipt = { ...state.receipt, ...value }; setRows(role('speechReceipt'), Object.entries(state.receipt).filter(([,v]) => ['string','number','boolean'].includes(typeof v)).map(([k,v]) => [k, String(v)])); refresh(); } });
    if (extraSettings) role('extraSettings').append(extraSettings);
    const flowHome = flow?.parentNode ? { parent: flow.parentNode, next: flow.nextSibling } : null;
    if (flow) role('flow').append(flow);
    const current = () => conversation || standalone.conversation;
    function stopReplay() {
      if (!state.replaying) return;
      ++state.replayRun; state.replaying = false;
      current().reviewSpeech?.abort();
      role('replayState').textContent = 'Réécoute arrêtée.';
    }
    host.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.tab || button.dataset.stepTab) { showTab(button.dataset.tab || button.dataset.stepTab); return refresh(); }
      if (button.dataset.preset) {
        const lang = button.dataset.preset === 'english' ? 'en' : field('testLanguage').value;
        const selectedVoice = field('testLanguage').value === lang ? field('testVoice').value : '';
        updateExample(lang, button.dataset.preset); field('testLanguage').value = lang; voiceOptions(field('testVoice'),lang,selectedVoice); return refresh();
      }
      switch (button.dataset.action) {
        case 'close': return onClose();
        case 'start': state.speech = 'idle'; role('replayState').textContent = ''; return exclusive(() => embedded ? conversation.start(selection()) : standalone.start());
        case 'pause': stopReplay(); role('replayState').textContent = ''; state.speechRun++; if (['preparing','scheduled'].includes(state.speech)) state.speech = 'stopped'; current().stop(true); standalone.pause(); state.lastResult = null; return refresh();
        case 'review': current().review('last'); return refresh();
        case 'recent': current().review('microphone'); return refresh();
        case 'replay': return exclusive(async () => {
          const run = ++state.replayRun; state.replaying = true;
          role('replayState').textContent = 'Réécoute en cours…'; refresh();
          try { await current().replay(); }
          finally { if (run === state.replayRun) { state.replaying = false; role('replayState').textContent = ''; } }
        });
        case 'erase': current().forgetReview(); role('replayState').textContent = ''; state.lastResult = null; field('expected').value = ''; role('comparison')?.replaceChildren(); return refresh();
        case 'stopReplay': stopReplay(); return refresh();
        case 'stopSpeech':
          if (!canStopSpeech()) return refresh();
          if (embedded) { void current().interrupt(undefined, { stop:true }); notice('Voix interrompue. Le travail en cours continue.'); }
          else { state.speechRun++; state.speech = 'stopped'; standalone.stopSpeech(); }
          return refresh();
        case 'defaults': for (const [k,v] of Object.entries(S.DEFAULTS)) find(`[data-capture="${k}"]`).value = v; return;
        case 'compare': return exclusive(async () => { const value = await standalone.compare(field('compareLanguage').value); state.comparisonExcerptId = value.excerptId; V.comparison(role('comparison'),value); });
        case 'speak':
          if (!hasSpeechText()) return refresh();
          return exclusive(async () => {
            const value = field('testVoice').value, split = value.indexOf('|'), run = ++state.speechRun;
            state.speech = 'preparing'; state.receipt = null; role('speechReceipt').replaceChildren(); notice(''); refresh();
            try {
              await standalone.speak(field('speechText').value, split >= 0 ? { provider:value.slice(0,split),voice:value.slice(split+1) } : null, field('testLanguage').value);
              if (run === state.speechRun) state.speech = 'done';
            } catch (error) { if (run === state.speechRun) state.speech = error.name === 'AbortError' ? 'stopped' : 'error'; throw error; }
          });
        case 'sharedVoice': return exclusive(async () => {
          const id = field('sharedPersona').value, provider = field('sharedProvider').value;
          if (!state.personas.some(p => p.id === id) || !['kokoro','voxcpm','windows_sapi'].includes(provider)) throw new Error('Choisir une personnalité et un moteur disponibles.');
          const voices = Object.fromEntries([['fr',field('sharedFr').value.trim()],['en',field('sharedEn').value.trim()]].filter(([,v]) => v));
          await api('/api/prompts/catalog/' + encodeURIComponent(id), { method:'PUT', signal:life.signal,
            headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ voice:{ provider, voices } }) });
          const updated = await api('/api/voice-personas/catalog', { signal:life.signal }); state.personas = updated.personas || state.personas;
          describeShared(); role('sharedStatus').textContent = 'Voix de personnalité enregistrée dans Core. Les parcours déjà ouverts reliront leur catalogue après rechargement.';
        });
        case 'devices': return exclusive(async () => { const devices = await S.microphones(life.signal, { requestPermission: !current().audio }); field('inputDeviceId').replaceChildren(new Option('Micro système par défaut',''), ...devices.map((d,i) => new Option(d.label || `Micro ${i+1}`, d.deviceId))); field('inputDeviceId').value = prefs.inputDeviceId; });
      }
    }, { signal: life.signal });
    role('settings').addEventListener('submit', event => { event.preventDefault(); void exclusive(async () => {
      const validated = capture(), next = draft();
      // Validate everything before the first write. These keys retain their existing owners.
      if (next.voice && !S.validVoice(next.voice)) throw new Error('Voix invalide.');
      S.save(scope, next, validated, state.personas);
      role('saved').textContent = 'Enregistré sur ce navigateur. Les paramètres de capture seront lus à la prochaine ouverture du micro.';
      prefs = S.read(scope, state.personas); onSaved(prefs);
    }); }, { signal: life.signal });
    field('language').addEventListener('change', () => { voiceOptions(field('voice'), field('language').value); field('testLanguage').value = field('language').value; updateExample(field('testLanguage').value); voiceOptions(field('testVoice'), field('testLanguage').value); if (field('compareLanguage')) field('compareLanguage').value = field('language').value === 'fr' ? 'en' : 'fr'; refresh(); }, { signal: life.signal });
    field('testLanguage').addEventListener('change', () => { updateExample(field('testLanguage').value); voiceOptions(field('testVoice'), field('testLanguage').value); refresh(); }, { signal: life.signal });
    field('speechText').addEventListener('input', refresh, { signal: life.signal });
    field('scope').addEventListener('change', () => { root.location.href = '/voice-lab?scope=' + field('scope').value; }, { signal: life.signal });
    const pause = () => { stopReplay(); role('replayState').textContent = ''; state.speechRun++; state.speech = 'idle'; standalone.pause(); if (embedded && document.hidden) conversation.stop(true); field('expected').value = ''; state.lastResult = null; role('comparison')?.replaceChildren(); refresh(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); }, { signal: life.signal });
    root.addEventListener('pagehide', pause, { signal: life.signal });
    interval = setInterval(refresh, 200); showTab(tab); refresh();
    return { destroy() { stopReplay(); state.destroyed = true; state.speechRun++; life.abort(); clearInterval(interval); standalone.destroy(); textDrafts.clear(); field('speechText').value = ''; field('expected').value = ''; state.lastResult = null; role('comparison')?.replaceChildren();
      if (flowHome?.parent.isConnected) flowHome.parent.insertBefore(flow, flowHome.next?.parentNode === flowHome.parent ? flowHome.next : null);
    }, refresh };
  }
  async function open(options) {
    const dialog = document.createElement('dialog'); dialog.className = 'voice-workshop-dialog'; dialog.setAttribute('aria-label', 'Atelier vocal');
    document.body.append(dialog); const host = document.createElement('div'); dialog.append(host);
    let mounted; const life = new AbortController();
    const close = () => dialog.close();
    dialog.addEventListener('close', () => { life.abort(); mounted?.destroy(); options.conversation?.reviewSpeech?.abort(); dialog.remove(); }, { once:true });
    dialog.showModal(); mounted = await mount({ ...options, host, signal:life.signal, onClose:close });
    if (!dialog.open) mounted.destroy();
    return mounted;
  }
  root.AgentXVoiceWorkshop = { mount, open };
})(window);
