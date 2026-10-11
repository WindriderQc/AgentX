/* Read-only projection of Nestor's concurrent conversation work. */
(function (root) {
  'use strict';

  const STAGES = [
    ['stt', 'Transcription'], ['guardian', 'Gardien'], ['review', 'Revue'],
    ['tools', 'Outils'], ['agents', 'Agents'], ['tts', 'Voix']
  ];
  const EVENT_LABELS = {
    request_received: 'Demande conservée', context_ready: 'Contexte préparé', guardian_started: 'Gardien démarré',
    guardian_settled: 'Gardien terminé', guardian_handled: 'Réponse directe conservée',
    read_requested: 'Lecture demandée', dispatch_marked: 'Relais vers le travail privé',
    native_started: 'Agent démarré', native_observed: 'Agent observé', native_reconciled: 'Agent retrouvé',
    native_call_observed: 'Appel natif observé', native_tool_admitted: 'Outil admis',
    tool_result: 'Résultat d’outil vérifié', result_published: 'Avis disponible',
    native_result_published: 'Résultat natif disponible', native_settled: 'Agent terminé',
    dispatch_uncertain: 'État du relais inconnu', preparation_refused: 'Préparation refusée',
    intake_recovered: 'Demande retrouvée', presentation_displayed: 'Résultat affiché',
    presentation_claim: 'Lecture réservée', presentation_replay: 'Relecture demandée',
    presentation_started: 'Lecture audio commencée', presentation_completed: 'Lecture audio terminée',
    presentation_interrupted: 'Lecture audio interrompue', presentation_deferred: 'Lecture audio reportée',
    owner_pause: 'Travail mis en pause', owner_resume: 'Travail repris', owner_cancel: 'Travail annulé'
  };
  const validMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const duration = value => validMs(value) ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s` : 'inconnue';
  const time = value => { const date = new Date(value); if (!Number.isFinite(date.getTime())) return 'heure inconnue';
    const pad = number => String(number).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; };
  const safe = value => typeof value === 'string' ? value.slice(0, 160) : '';

  function createModel() {
    let sessionId = null, gap = false, stale = false, order = 0;
    const turns = new Map(), works = new Map(), events = new Map();
    function follow(id) {
      if (!id || id === sessionId) return false;
      sessionId = id; gap = false; stale = false; order = 0; turns.clear(); works.clear(); events.clear();
      return true;
    }
    function reset() { sessionId = null; gap = false; stale = false; order = 0; turns.clear(); works.clear(); events.clear(); }
    function turn(id, fields = {}) {
      if (!id) return null;
      let row = turns.get(id);
      if (!row) { row = { id, order: ++order, channel: 'unknown', stream: [], reviews: [], activities: [] }; turns.set(id, row); }
      Object.assign(row, fields);
      return row;
    }
    function begin(session, id, channel = 'unknown') {
      follow(session); const row = turn(id);
      if (row) {
        row.channel = channel; row.live = true;
      }
    }
    function capture(session, id) {
      begin(session, id, 'voice');
      const row = turn(id);
      if (row) row.phase = 'transcribing';
    }
    function captureEnd(id) {
      const row = turns.get(id);
      if (row && row.phase === 'transcribing') { row.phase = 'capture_ended'; row.live = false; }
    }
    function stream(id, event) {
      const row = turn(id);
      if (!row || !event || !['accepted', 'speaker', 'tools', 'status', 'delta', 'done', 'deferred', 'error', 'interrupted'].includes(event.type)) return;
      if (event.type === 'delta' && row.firstText || event.type === 'status' && event.phase !== 'activity' && row.phase === event.phase
          || ['accepted', 'done', 'deferred', 'error', 'interrupted'].includes(event.type) && row.stream.includes(event.type)) return false;
      if (event.type === 'speaker') row.speaker = safe(event.speaker?.name || event.speaker?.agentId);
      if (event.type === 'tools') row.toolCount = Array.isArray(event.evidence?.receipts) ? event.evidence.receipts.length : 0;
      if (event.type === 'status') {
        row.phase = safe(event.phase);
        const activity = event.activity;
        if (event.phase === 'activity' && activity && ['tool', 'member_addressed', 'waiting_agent'].includes(activity.kind)) {
          const observed = { kind: activity.kind, agentId: safe(activity.agentId), tool: safe(activity.tool) };
          if (!row.activities.some(item => item.kind === observed.kind && item.agentId === observed.agentId && item.tool === observed.tool)) row.activities.push(observed);
        }
      }
      if (event.type === 'delta') row.firstText = true;
      if (event.type === 'done') { row.done = true; row.live = false; row.traceId = safe(event.data?.traceId) || row.traceId;
        row.serverTimings = event.data?.serverTimings || row.serverTimings;
        row.adviceRefs = Array.isArray(event.data?.adviceRefs) ? event.data.adviceRefs : row.adviceRefs; }
      if (event.type === 'error') { row.error = true; row.live = false; }
      if (event.type === 'deferred') { row.deferred = true; row.live = false; }
      if (event.type === 'interrupted') { row.interrupted = true; row.live = false; }
      // Browser observations are kept apart from Core's wall-clock event order.
      if (!row.stream.includes(event.type)) row.stream.push(event.type);
    }
    function timings(id, value) { const row = turn(id); if (row && value && typeof value === 'object') row.voiceTimings = value; }
    function restore(session, saved = []) {
      follow(session);
      let historyOrder = 0;
      for (const item of saved) {
        const id = item.clientTurnId || item.traceId;
        const row = turn(id);
        if (!row) continue;
        row.channel = item.channel || row.channel;
        row.traceId = safe(item.traceId) || row.traceId;
        row.historyOrder = historyOrder++;
        row.live = false;
        if (!row.startedAt && item.createdAt) row.startedAt = item.createdAt;
        row.done = !!item.replyText || item.outcome === 'completed';
        row.interrupted = item.interrupted === true;
        row.voiceTimings = item.voiceTimings || row.voiceTimings;
        row.serverTimings = item.serverTimings || row.serverTimings;
        row.adviceRefs = Array.isArray(item.adviceRefs) ? item.adviceRefs : row.adviceRefs;
        if (item.toolEvidence) row.toolCount = Array.isArray(item.toolEvidence.receipts) ? item.toolEvidence.receipts.length : 0;
        row.speaker = safe(item.speakerAgentId || row.speaker);
      }
      // An inclusion receipt can reconstruct its source, but says nothing about
      // whether that historical advice is still available or was superseded.
      for (const row of turns.values()) for (const ref of row.adviceRefs || []) {
        if (ref.source !== 'brain' || !ref.adviceId || !ref.sourceTurnId) continue;
        const source = [...turns.values()].find(candidate => candidate.traceId === ref.sourceTurnId);
        if (!source) continue;
        const key = ref.adviceId + ':' + String(ref.version);
        if (!source.reviews.some(item => item.key === key)) source.reviews.push({
          key, turnId: source.id, available: false, replaced: null, reconstructed: true
        });
      }
    }
    function review(id, value) {
      const row = turn(id);
      if (!row || !value) return;
      const key = safe(value.adviceId || value.id || value.traceId || id) + ':' + String(value.version || 1);
      if (row.reviews.some(item => item.key === key)) return;
      const chronology = snapshot().turns.map(item => item.id);
      const replaced = chronology.indexOf(id) < chronology.length - 1;
      if (!replaced) for (const previous of turns.values()) previous.reviews.forEach(item => { item.replaced = true; });
      row.reviews.push({ key, turnId: id, available: true, replaced, included: false });
    }
    function ingest(session, data) {
      follow(session);
      if (!data || typeof data !== 'object') return;
      let changed = stale || data.snapshotRequired === true && !gap;
      stale = false;
      gap ||= data.snapshotRequired === true;
      for (const item of data.items || []) {
        if (!item?.id || !item.turnId || item.sessionId !== sessionId) continue;
        const prior = works.get(item.id);
        if (!prior || (Number(item.revision) || 0) > (Number(prior.revision) || 0)) { works.set(item.id, item); changed = true; }
        const owner = turn(item.turnId);
        if (owner && item.receivedAt && (!owner.startedAt || Date.parse(item.receivedAt) < Date.parse(owner.startedAt))) owner.startedAt = item.receivedAt;
      }
      for (const event of data.events || []) {
        if (!Number.isSafeInteger(event.sequence) || !event.workId || events.has(event.sequence)) continue;
        events.set(event.sequence, event); changed = true;
      }
      return changed;
    }
    function pollFailure(id) { if (id !== sessionId || stale) return false; stale = true; return true; }
    function snapshot() {
      const rows = [...turns.values()].sort((a, b) => {
        if (a.historyOrder !== undefined && b.historyOrder !== undefined) return a.historyOrder - b.historyOrder;
        const first = Date.parse(a.startedAt), second = Date.parse(b.startedAt);
        return Number.isFinite(first) && Number.isFinite(second) && first !== second ? first - second : a.order - b.order;
      });
      const brainRefs = new Map(), workRefs = new Map(), worksByTurn = new Map(), eventsByTurn = new Map();
      const append = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
      for (const row of rows) for (const ref of row.adviceRefs || []) {
        const key = ref.source === 'brain' ? `${ref.adviceId}:${ref.version}` : ref.source === 'work' ? `${ref.workId}:${ref.version}` : null;
        const map = ref.source === 'brain' ? brainRefs : workRefs;
        if (key) append(map, key, { ...ref, targetTurnId: row.id });
      }
      for (const item of works.values()) append(worksByTurn, item.turnId, item);
      const chronology = [...events.values()].sort((a, b) => a.sequence - b.sequence).map(event => {
        const turnId = works.get(event.workId)?.turnId || null;
        if (turnId) append(eventsByTurn, turnId, event);
        return { ...event, turnId };
      });
      return { sessionId, gap, stale, events: chronology,
        turns: rows.map(row => ({ ...row, reviews: row.reviews.map(advice => ({ ...advice,
          includedIn: brainRefs.get(advice.key) || [] })),
        works: (worksByTurn.get(row.id) || []).map(item => ({ ...item,
          includedIn: workRefs.get(`${item.id}:${item.result?.version}`) || [] })),
        events: eventsByTurn.get(row.id) || [] })) };
    }
    return { follow, reset, begin, capture, captureEnd, stream, timings, restore, review, ingest, pollFailure, snapshot };
  }

  function stageState(stage, row) {
    const work = row.works.at(-1), voice = row.voiceTimings || {}, server = row.serverTimings || {};
    if (stage === 'stt') return row.channel === 'text' ? ['Sans voix', 'Message écrit']
      : validMs(voice.sttDone) ? ['Terminé', `Reconnaissance : ${duration(voice.sttDone)} après fin de parole`]
        : row.phase === 'transcribing' && row.live ? ['En cours', 'Transcription démarrée dans le navigateur']
          : ['Inconnu', 'Aucune mesure STT conservée'];
    if (stage === 'guardian') {
      const status = work?.guardianStatus;
      if (row.telemetryStale && ['pending', 'running', 'uncertain'].includes(status)) return ['Incertain', 'Dernier état Core non actualisé'];
      if (status && status !== 'unknown') return [{ pending: 'En attente', running: 'Actif', completed: 'Terminé', cancelled: 'Interrompu', failed: 'Échec', uncertain: 'Incertain' }[status] || 'Inconnu', work.guardianRunId ? `Run ${work.guardianRunId}` : 'Run non observé'];
      if (row.done) return ['Inconnu', 'Réponse reçue, exécution du Gardien non attestée'];
      if (row.error || row.interrupted) return ['Incertain', 'Flux terminé, état du Gardien non attesté'];
      if (row.deferred) return ['Inconnu', 'Demande conservée, exécution du Gardien non attestée'];
      if (row.phase === 'waiting_host') return row.telemetryStale ? ['Incertain', 'Dernier état Core non actualisé']
        : ['En attente', 'Hôte occupé, cause signalée par Core · durée inconnue'];
      return row.live && row.stream?.includes('accepted') ? ['En attente', 'Requête acceptée, démarrage du Gardien non attesté'] : ['Inconnu', 'Aucun reçu du Gardien'];
    }
    if (stage === 'review') {
      const advice = row.reviews.at(-1);
      if (work && ['failed', 'cancelled', 'paused'].includes(work.state)) {
        const labels = { failed: 'Échec', cancelled: 'Annulé', paused: 'En pause' };
        const reasons = { native_preparation_refused: 'préparation de l’agent refusée',
          native_result_not_published: 'résultat non publié', owner_cancelled_before_dispatch: 'annulé avant relais' };
        const code = typeof work.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(work.reason) ? work.reason : '';
        return [labels[work.state], `Travail ${work.id} · ${reasons[code] || (code ? `motif Core : ${code}` : 'motif non détaillé')}`];
      }
      if (work?.result) return work.includedIn?.length ? ['Inclus', `Travail ${work.id} · contexte du tour ${work.includedIn[0].targetTurnId}`]
        : ['Disponible', `Travail ${work.id} · version ${work.result.version}`];
      if (work?.resultDisposition === 'no_work') return ['Terminé', `Travail ${work.id} · aucun complément utile`];
      if (advice) return [advice.replaced ? 'Remplacé' : advice.includedIn?.length ? 'Inclus' : 'Disponible',
        advice.includedIn?.length ? `Contexte du tour ${advice.includedIn[0].targetTurnId}` : `Avis du tour ${advice.turnId} · inclusion non attestée`];
      if (work && ['received', 'queued', 'dispatching', 'running', 'uncertain'].includes(work.state)) {
        const dispatched = row.events?.some(event => event.workId === work.id && event.type === 'dispatch_marked');
        const started = row.events?.some(event => event.workId === work.id && event.type === 'native_started');
        const active = work.state === 'dispatching' && dispatched || work.state === 'running' && (dispatched || started);
        return [row.telemetryStale || work.state === 'uncertain' ? 'Incertain' : active ? 'En cours' : 'En attente',
          `${row.telemetryStale ? 'Dernier état Core non actualisé · ' : ''}Travail ${work.id}${active ? ' · relais attesté' : ' · relais non attesté'}`];
      }
      return ['Inconnu', 'Aucun avis de revue observé'];
    }
    if (stage === 'tools') {
      const worker = (work?.tools || []).length, guardian = row.toolCount || 0;
      const admitted = work?.nativeAdmissions?.length || 0;
      return worker || guardian ? ['Observés', `Gardien : ${guardian} reçu${guardian > 1 ? 's' : ''} · travail : ${worker} reçu${worker > 1 ? 's' : ''}`]
        : admitted ? ['Admis', `${admitted} admission${admitted > 1 ? 's' : ''} · résultat non attesté`]
          : row.activities?.some(item => item.tool) ? ['Signalés', 'Outil signalé par le flux · résultat non attesté'] : ['Inconnu', 'Aucun reçu d’outil'];
    }
    if (stage === 'agents') {
      const agents = [...new Set([work?.attempt?.agentId, ...(row.activities || []).map(item => item.agentId)].filter(Boolean))];
      const started = row.events?.some(item => item.workId === work?.id && item.type === 'native_started');
      const settled = row.events?.some(item => item.workId === work?.id && item.type === 'native_settled');
      const active = work?.state === 'running' && work.attempt?.runId && started && !settled;
      return agents.length ? [active ? row.telemetryStale ? 'Incertain' : 'Actif'
        : work?.attempt?.runId || row.activities?.some(item => item.agentId) ? 'Observé' : 'Relais préparé',
        `${agents.join(', ')}${work?.attempt?.runId ? ` · run ${work.attempt.runId}` : ''}`]
        : row.speaker ? ['Observé', row.speaker] : ['Inconnu', 'Aucune délégation attestée'];
    }
    if (stage === 'tts') return row.channel === 'text' ? ['Sans voix', 'Réponse écrite']
      : validMs(voice.firstAudio) ? [voice.interrupted || row.interrupted ? 'Interrompu' : 'Lecture demandée', `Tentative de lecture : ${duration(voice.firstAudio)} après fin de parole · son non attesté`]
        : ['Inconnu', 'Aucune tentative de lecture conservée'];
    return ['Inconnu', 'Aucune donnée'];
  }

  function node(tag, className, value) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (value !== undefined) element.textContent = value; return element;
  }
  function intervals(events) {
    const starts = { guardian_started: 'guardian_settled', dispatch_marked: 'native_started',
      native_started: 'native_settled', presentation_claim: 'presentation_started' };
    const labels = { guardian_started: 'Gardien actif', dispatch_marked: 'Relais avant démarrage',
      native_started: 'Agent actif ou en attente interne', presentation_claim: 'Attente avant lecture' };
    const out = [];
    for (const start of events) {
      const endType = starts[start.type];
      if (!endType) continue;
      const end = events.find(item => item.workId === start.workId && item.sequence > start.sequence && item.type === endType);
      const elapsed = Date.parse(end?.at) - Date.parse(start.at);
      if (end && validMs(elapsed)) out.push(`${labels[start.type]} : ${duration(elapsed)} (horloge Core)`);
    }
    return out;
  }
  function measuredSpan(events, startType, endTypes) {
    for (const start of events || []) {
      if (start.type !== startType) continue;
      const end = (events || []).find(item => item.workId === start.workId && item.sequence > start.sequence && endTypes.includes(item.type));
      const elapsed = Date.parse(end?.at) - Date.parse(start.at);
      if (end && validMs(elapsed)) return elapsed;
    }
    return null;
  }
  function create({ host, signal = null }) {
    const model = createModel();
    let selected = null, turnLimit = 24, eventLimit = 80;
    const overview = node('div', 'workflow-map'); overview.setAttribute('aria-label', 'Composants du parcours');
    const panel = node('details', 'workflow-panel');
    const summary = node('summary', 'workflow-toggle', 'Journal et reçus');
    const body = node('div', 'workflow-body'); panel.append(summary, body); host.append(overview, panel);
    function render() {
      const focused = document.activeElement?.closest?.('[data-key]');
      const focusKey = focused && host.contains?.(focused) ? focused.dataset.key : null;
      const restoreFocus = () => {
        if (!focusKey) return;
        const target = [...host.querySelectorAll('[data-key]')].find(item => item.dataset.key === focusKey);
        (target?.matches('button') ? target : target?.querySelector('summary'))?.focus();
      };
      const view = model.snapshot();
      const rows = view.turns, current = rows.find(row => row.id === selected) || rows.at(-1);
      if (current) selected = current.id;
      summary.textContent = `Journal et reçus${rows.length ? ` · ${rows.length} tour${rows.length > 1 ? 's' : ''}` : ''}`;
      const expanded = new Set([...overview.querySelectorAll?.('details[open]') || [], ...body.querySelectorAll?.('details[open]') || []].map(item => item.dataset.key));
      overview.replaceChildren();
      const chosen = { ...(current || { channel: 'unknown', works: [], reviews: [] }), telemetryStale: view.stale };
      const symbols = { stt: '〰', guardian: '◆', review: '✦', tools: '⌘', agents: '↗', tts: '♫' };
      const stateFor = key => stageState(key, chosen);
      const isActive = state => ['Actif', 'En cours'].includes(state);
      const card = key => {
        const label = STAGES.find(stage => stage[0] === key)[1], [state, detail] = stateFor(key);
        const element = node('details', 'workflow-component'); element.dataset.key = `stage:${key}`;
        element.dataset.stage = key;
        element.dataset.tone = isActive(state) ? 'active'
          : ['Échec', 'Incertain', 'Interrompu', 'Annulé', 'En pause', 'En attente'].includes(state) ? 'caution'
            : ['Terminé', 'Disponible', 'Inclus'].includes(state) ? 'complete'
              : ['Inconnu', 'Sans voix'].includes(state) ? 'unknown' : 'observed';
        element.open = expanded.has(element.dataset.key);
        const title = node('summary');
        const icon = node('span', 'workflow-icon', symbols[key]); icon.setAttribute('aria-hidden', 'true');
        const copy = node('span', 'workflow-copy'); copy.append(node('strong', 'workflow-label', label), node('small', 'workflow-caption', detail));
        const status = node('span', 'workflow-state'); const led = node('span', 'workflow-led');
        led.setAttribute('aria-hidden', 'true'); status.append(led, node('span', '', state));
        title.append(icon, copy, status);
        const activity = node('span', 'workflow-signal'); activity.setAttribute('aria-hidden', 'true');
        element.append(title, node('p', 'workflow-detail', detail), activity);
        return element;
      };
      const activeCount = STAGES.filter(([key]) => isActive(stateFor(key)[0])).length;
      if (signal) {
        const active = STAGES.filter(([key]) => isActive(stateFor(key)[0])).map(([, label]) => label);
        const waiting = STAGES.filter(([key]) => stateFor(key)[0] === 'En attente').map(([, label]) => label);
        signal.textContent = current ? `Tour ${rows.indexOf(current) + 1} · ${active.length ? `En cours : ${active.join(', ')}`
          : waiting.length ? `En attente : ${waiting.join(', ')}` : 'activité non attestée'}${view.stale ? ' · Core non actualisé' : ''}`
          : 'Aucun tour en cours';
      }
      const compact = root.matchMedia?.('(max-width: 760px)')?.matches;
      const head = node('div', 'workflow-map-head');
      head.dataset.live = String(activeCount > 0 && !view.stale);
      head.dataset.stale = String(view.stale);
      head.append(node('div', 'workflow-kicker', 'SIGNAL / NESTOR'),
        node('strong', 'workflow-map-title', current ? `Tour ${rows.indexOf(current) + 1} · ${current.channel === 'voice' ? compact ? 'voix' : 'conversation vocale' : current.channel === 'text' ? compact ? 'texte' : 'conversation écrite' : 'canal inconnu'}` : 'En attente d’un tour'));
      head.append(node('span', 'workflow-live-count', view.stale ? 'Données Core non actualisées' : `${activeCount} composant${activeCount > 1 ? 's' : ''} en cours`));
      overview.append(head);
      const meters = node('div', 'workflow-meters'); meters.setAttribute('aria-label', 'Chronos mesurés');
      const voice = current?.voiceTimings || {}, guardianMs = measuredSpan(current?.events, 'guardian_started', ['guardian_settled']);
      const reviewMs = measuredSpan(current?.events, 'dispatch_marked', ['result_published', 'native_result_published']);
      const meter = (label, value, basis, active = false) => {
        const block = node('div', 'workflow-meter'); block.dataset.active = String(active && !validMs(value) && !view.stale);
        block.append(node('span', 'workflow-meter-label', label),
          node('strong', 'workflow-meter-value', validMs(value) ? duration(value) : active ? 'En cours' : 'Inconnue'),
          node('small', 'workflow-meter-basis', basis));
        const signal = node('span', 'workflow-meter-signal'); signal.setAttribute('aria-hidden', 'true'); block.append(signal);
        meters.append(block);
      };
      meter('TRANSCRIPTION', voice.sttDone, 'Navigateur · fin de parole', isActive(stateFor('stt')[0]));
      meter('GARDIEN', guardianMs, 'Core · début → fin', isActive(stateFor('guardian')[0]));
      meter('REVUE', reviewMs, 'Core · relais → avis', isActive(stateFor('review')[0]));
      meter('LECTURE DEMANDÉE', voice.firstAudio, 'Navigateur · fin de parole', isActive(stateFor('tts')[0]));
      overview.append(meters);
      const flow = node('div', 'workflow-flow'); flow.setAttribute('aria-label', 'Flux du tour et travail de fond');
      const origin = node('div', 'workflow-origin');
      origin.append(node('span', 'workflow-origin-mark', '◎'), node('span', 'workflow-origin-label', current ? `Votre tour · ${current.id}` : 'Votre prochain tour'));
      flow.append(origin);
      const lanes = node('div', 'workflow-lanes');
      const immediate = node('section', 'workflow-lane workflow-lane-immediate');
      immediate.dataset.connected = String(!!current && (current.channel !== 'unknown' || current.stream?.length
        || current.events?.some(event => event.type === 'guardian_started')));
      immediate.append(node('h3', 'workflow-lane-title', '01  CONVERSATION DIRECTE'),
        node('p', 'workflow-lane-subtitle', 'Nestor reste disponible pendant le travail de fond.'));
      const link = connected => { const edge = node('div', 'workflow-edge'); edge.dataset.connected = String(!!connected); edge.setAttribute('aria-hidden', 'true'); return edge; };
      const has = type => current?.events?.some(event => event.type === type);
      immediate.append(card('stt'),
        link(current?.channel === 'voice' && validMs(voice.requestSent) && has('guardian_started')),
        card('guardian'),
        link(current?.done && validMs(voice.firstAudio)),
        card('tts'));
      const background = node('section', 'workflow-lane workflow-lane-background');
      background.dataset.connected = String(!!current?.reviews?.length || !!current?.works?.some(work => work.turnId === current.id && current.events.some(event => event.workId === work.id && event.type === 'request_received')));
      background.append(node('h3', 'workflow-lane-title', '02  REVUE EN ARRIÈRE-PLAN'),
        node('p', 'workflow-lane-subtitle', 'Un avis peut arriver après la réponse.'));
      background.append(card('review'),
        link(current?.works?.some(work => work.attempt?.agentId && current.events.some(event => event.workId === work.id && event.type === 'native_started'))),
        card('agents'));
      lanes.dataset.split = String(immediate.dataset.connected === 'true' && background.dataset.connected === 'true');
      flow.dataset.hasTurn = String(immediate.dataset.connected === 'true' || background.dataset.connected === 'true');
      lanes.append(immediate, background); flow.append(lanes);
      const services = node('div', 'workflow-services');
      services.append(node('div', 'workflow-services-heading', 'SERVICES MOBILISÉS'));
      const tools = card('tools'); services.append(tools);
      const guardianTools = (current?.toolCount || 0) > 0;
      const reviewTools = current?.works?.some(work => work.tools?.length);
      if (guardianTools || reviewTools) services.append(node('p', 'workflow-handoffs',
        [guardianTools ? 'Gardien → Outils · reçus du tour' : '', reviewTools ? 'Revue → Outils · reçus du travail' : ''].filter(Boolean).join('    ')));
      flow.append(services);
      const resources = node('section', 'workflow-resources'); resources.setAttribute('aria-label', 'Ressources observées');
      resources.append(node('h3', '', 'RESSOURCES OBSERVÉES'));
      const latestWork = current?.works?.at(-1), toolReceipts = (current?.toolCount || 0) + (latestWork?.tools?.length || 0);
      const resource = (label, value) => { const item = node('div', 'workflow-resource'); item.append(node('small', '', label), node('strong', '', value)); resources.append(item); };
      resource('AGENT / RUN', latestWork?.attempt?.agentId ? `${latestWork.attempt.agentId}${latestWork.attempt.runId ? ` · ${latestWork.attempt.runId}` : ' · run inconnu'}` : 'Aucun run attesté');
      resource('OUTILS', toolReceipts ? `${toolReceipts} reçu${toolReceipts > 1 ? 's' : ''} observé${toolReceipts > 1 ? 's' : ''}` : 'Aucun reçu');
      resource('JOURNAL CORE', view.stale ? 'Non actualisé' : view.events.length ? `${view.events.length} événement${view.events.length > 1 ? 's' : ''} reçu${view.events.length > 1 ? 's' : ''}` : 'Aucun événement reçu');
      const passages = node('section', 'workflow-passages'); passages.setAttribute('aria-label', 'Derniers passages attestés');
      passages.append(node('h3', '', 'DERNIERS PASSAGES'));
      const recent = view.events.slice(-3);
      if (!recent.length) passages.append(node('p', 'workflow-empty', 'Aucun passage Core attesté.'));
      for (const item of recent) {
        const owner = rows.find(row => row.id === item.turnId);
        const entry = node('div', 'workflow-passage');
        entry.append(node('time', '', time(item.at)), node('span', '', EVENT_LABELS[item.type] || 'Événement enregistré'),
          node('small', '', `${owner ? `Tour ${rows.indexOf(owner) + 1} · ` : ''}Travail ${item.workId}`));
        passages.append(entry);
      }
      overview.append(flow, ...(compact ? [] : [resources, passages]),
        node('p', 'workflow-map-note', 'Liaisons et passages fondés sur les reçus du tour. Un avis inclus ne prouve pas son influence.'));
      body.replaceChildren();
      if (!panel.open) { restoreFocus(); return; }
      const intro = node('p', 'workflow-intro', 'Étapes observées dans cette conversation. Plusieurs composants peuvent travailler en même temps.');
      body.append(intro);
      if (compact) body.append(resources, passages);
      if (!current) { body.append(node('p', 'workflow-empty', 'Aucun tour enregistré. Les composants apparaîtront ici.')); return; }
      const picker = node('div', 'workflow-turns'); picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', 'Choisir un tour');
      if (rows.length > turnLimit) {
        const more = node('button', 'workflow-more', `Afficher ${Math.min(24, rows.length - turnLimit)} tours précédents`);
        more.type = 'button'; more.dataset.key = 'turns-more'; more.onclick = () => { turnLimit += 24; render(); }; picker.append(more);
      }
      rows.slice(-turnLimit).forEach((row, index) => {
        const button = node('button', 'workflow-turn', `Tour ${rows.length - Math.min(rows.length, turnLimit) + index + 1}${row.interrupted ? ' · interrompu' : ''}`);
        button.dataset.key = `turn:${row.id}`;
        button.type = 'button'; button.setAttribute('aria-pressed', String(row.id === selected));
        button.onclick = () => { selected = row.id; render(); body.querySelector?.('button[aria-pressed="true"]')?.focus(); }; picker.append(button);
      });
      body.append(picker);
      const identity = node('p', 'workflow-identity', `Tour ${rows.indexOf(current) + 1} · ID ${current.id}`); body.append(identity);
      const timing = node('div', 'workflow-timing');
      const server = current.serverTimings || {};
      timing.append(node('h3', '', 'Durées mesurées'), node('p', '',
        `Navigateur, depuis fin de parole : STT ${duration(voice.sttDone)}, requête ${duration(voice.requestSent)}, premier texte ${duration(voice.firstDelta)}, début de lecture demandé ${duration(voice.firstAudio)}. Cela n'atteste pas un son entendu. Traitement STT déclaré : ${duration(voice.sttServer)}.`),
        node('p', '', `Serveur, depuis début de requête : contexte prêt à ${duration(server.prepared)}, réponse reçue à ${duration(server.executed)}.`),
        node('small', '', 'Origines d’horloge distinctes : ces durées ne sont pas additionnées. Une valeur absente reste inconnue.'));
      for (const value of intervals(current.events)) timing.append(node('p', '', value));
      body.append(timing);
      const heading = node('h3', '', 'Chronologie commune du travail'); body.append(heading);
      if (view.events.length > eventLimit) {
        const more = node('button', 'workflow-more', `Afficher ${Math.min(80, view.events.length - eventLimit)} événements précédents`);
        more.type = 'button'; more.dataset.key = 'events-more'; more.onclick = () => { eventLimit += 80; render(); }; body.append(more);
      }
      const list = node('ol', 'workflow-events');
      for (const event of view.events.slice(-eventLimit)) {
        const owner = rows.find(row => row.id === event.turnId);
        const work = owner?.works.find(item => item.id === event.workId);
        const entry = node('li', 'workflow-event');
        const when = node('time', '', time(event.at));
        if (event.at) when.dateTime = String(event.at);
        const label = EVENT_LABELS[event.type] || 'Événement enregistré';
        entry.append(when, node('span', '', label), node('small', '', `${owner ? `Tour ${rows.indexOf(owner) + 1} · ` : ''}Travail ${event.workId}${work?.attempt?.agentId && /^(dispatch_|native_)/.test(event.type) ? ` · ${work.attempt.agentId}` : ''}`));
        list.append(entry);
      }
      body.append(list);
      if (!view.events.length) body.append(node('p', 'workflow-empty', 'Aucun événement de travail conservé pour cette conversation.'));
      if (view.gap) body.append(node('p', 'workflow-gap', 'Une partie de l’historique des événements n’est plus disponible. Les étapes manquantes restent inconnues.'));
      if (view.stale) body.append(node('p', 'workflow-gap', 'Les données Core ne sont plus actualisées. Les étapes encore actives restent incertaines.'));
      for (const work of current.works) {
        const detail = node('details', 'workflow-evidence');
        detail.dataset.key = `work:${work.id}`; detail.open = expanded.has(detail.dataset.key);
        detail.append(node('summary', '', `Reçus · travail ${work.id}`));
        detail.append(node('p', '', `Classification ${work.classification || 'inconnue'} · état ${work.state || 'inconnu'} · révision ${work.revision}`));
        if (work.reason) detail.append(node('p', '', `Cause déclarée : ${work.reason}`));
        if (work.attempt) detail.append(node('p', '', `Agent ${work.attempt.agentId || 'inconnu'} · tentative ${work.attempt.id || 'inconnue'} · run ${work.attempt.runId || 'inconnu'}`));
        for (const tool of work.tools || []) detail.append(node('p', '', `Outil ${tool.tool || 'inconnu'} · reçu ${tool.id || 'inconnu'} · run ${tool.runId || 'inconnu'} · ${tool.status || 'état inconnu'}`));
        for (const call of work.nativeAdmissions || []) detail.append(node('p', '', `Admission ${call.tool || 'outil inconnu'} · ${call.id || 'ID inconnu'} · résultat non attesté`));
        if (work.result) detail.append(node('p', '', `Avis disponible · version ${work.result.version} · ${work.includedIn?.length ? `inclus dans le contexte du tour ${work.includedIn.map(ref => ref.targetTurnId).join(', ')}` : 'inclusion dans un tour ultérieur non attestée'}. Une inclusion ne prouve pas son influence.`));
        if (work.resultDisposition === 'no_work') detail.append(node('p', '', 'Revue terminée · aucun complément utile publié.'));
        body.append(detail);
      }
      if (current.activities.length) {
        const activity = node('details', 'workflow-evidence'); activity.dataset.key = `activity:${current.id}`;
        activity.open = expanded.has(activity.dataset.key); activity.append(node('summary', '', 'Activités signalées pendant ce tour'));
        for (const item of current.activities) activity.append(node('p', '', `${item.kind === 'tool' ? 'Outil' : 'Relais'} : ${item.tool || item.agentId || 'ID inconnu'}${item.agentId && item.tool ? ` · agent ${item.agentId}` : ''} · résultat non déduit du signal`));
        body.append(activity);
      }
      for (const advice of current.reviews) body.append(node('p', 'workflow-advice',
        `Avis ${advice.key} · ${advice.replaced === true ? 'remplacé' : advice.reconstructed ? 'statut actuel inconnu' : 'disponible'} · ${advice.includedIn?.length ? `inclus dans le contexte du tour ${advice.includedIn.map(ref => ref.targetTurnId).join(', ')}` : 'inclusion non attestée'} · influence non prouvée`));
      for (const ref of current.adviceRefs || []) body.append(node('p', 'workflow-advice',
        `Contexte de ce tour : ${ref.source === 'work' ? `travail ${ref.workId}` : `avis ${ref.adviceId}`} · version ${ref.version} · couverture ${(ref.coverage || []).join(', ') || 'inconnue'} · influence non prouvée`));
      restoreFocus();
    }
    function update(action) { if (action() !== false) render(); }
    render();
    panel.addEventListener?.('toggle', render);
    return {
      model, panel, render,
      reset: () => update(() => { model.reset(); selected = null; turnLimit = 24; eventLimit = 80; }),
      follow: id => update(() => { if (!model.follow(id)) return false; selected = null; turnLimit = 24; eventLimit = 80; }),
      begin: (session, id, channel) => update(() => { model.begin(session, id, channel); selected = id; }),
      capture: (session, id) => update(() => { model.capture(session, id); selected = id; }),
      captureEnd: id => update(() => model.captureEnd(id)),
      stream: (id, event) => update(() => model.stream(id, event)),
      timings: (id, value) => update(() => model.timings(id, value)),
      restore: (session, turns) => update(() => model.restore(session, turns)),
      review: (id, value) => update(() => model.review(id, value)),
      ingest: (session, data) => update(() => model.ingest(session, data)),
      pollFailure: id => update(() => model.pollFailure(id))
    };
  }
  const api = { create, createModel, stageState, duration, intervals };
  root.NestorWorkflow = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
