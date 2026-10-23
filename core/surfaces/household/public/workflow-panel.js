/* Read-only projection of Nestor's concurrent conversation work. */
(function (root) {
  'use strict';

  const STAGES = [
    ['stt', 'Transcription'], ['guardian', 'Guardian'], ['review', 'Review'],
    ['tools', 'Tools'], ['agents', 'Agents'], ['tts', 'Voice']
  ];
  const EVENT_LABELS = {
    request_received: 'Request kept', context_ready: 'Context prepared', guardian_started: 'Guardian started',
    guardian_settled: 'Guardian finished', guardian_handled: 'Direct answer kept',
    read_requested: 'Read requested', dispatch_marked: 'Handoff to private work',
    native_started: 'Agent started', native_observed: 'Agent observed', native_reconciled: 'Agent found again',
    native_call_observed: 'Native call observed', native_tool_admitted: 'Tool admitted',
    tool_result: 'Tool result verified', result_published: 'Advice available',
    native_result_published: 'Native result available', native_settled: 'Agent finished',
    dispatch_uncertain: 'Handoff state unknown', preparation_refused: 'Preparation refused',
    intake_recovered: 'Request recovered', presentation_displayed: 'Result shown',
    presentation_claim: 'Playback reserved', presentation_replay: 'Replay requested',
    presentation_started: 'Audio playback started', presentation_completed: 'Audio playback finished',
    presentation_interrupted: 'Audio playback interrupted', presentation_deferred: 'Audio playback deferred',
    owner_pause: 'Work paused', owner_resume: 'Work resumed', owner_cancel: 'Work cancelled'
  };
  const validMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const duration = value => validMs(value) ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s` : 'unknown';
  const time = value => { const date = new Date(value); if (!Number.isFinite(date.getTime())) return 'unknown time';
    const pad = number => String(number).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; };
  const safe = value => typeof value === 'string' ? value.slice(0, 160) : '';

  function executionEvidence(data) {
    const source = safe(data?.routing?.source || data?.routingSource);
    const backend = safe(data?.routing?.backend) || (source.startsWith('hermes/') ? 'hermes' : '');
    const model = safe(typeof data?.model === 'string' ? data.model : data?.model?.model);
    return backend || model ? { backend, model } : null;
  }

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
        row.channel = channel; row.live = true; row.captureOnly = false;
      }
    }
    function capture(session, id) {
      follow(session);
      const row = turn(id);
      if (row) Object.assign(row, { channel: 'voice', phase: 'transcribing', live: true, captureOnly: true });
    }
    function captureEnd(id, receipt = {}) {
      const row = turns.get(id);
      if (row?.captureOnly) { row.phase = 'capture_ended'; row.live = false;
        row.captureOutcome = ['stop', 'activation', 'not_addressed', 'empty', 'echo', 'failed', 'cancelled', 'recognized'].includes(receipt.outcome) ? receipt.outcome : 'not_submitted'; }
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
        row.execution = executionEvidence(event.data) || row.execution;
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
        row.captureOnly = false; row.channel = item.channel || row.channel;
        row.traceId = safe(item.traceId) || row.traceId;
        row.historyOrder = historyOrder++;
        row.live = false;
        if (!row.startedAt && item.createdAt) row.startedAt = item.createdAt;
        row.done = !!item.replyText || item.outcome === 'completed';
        row.interrupted = item.interrupted === true;
        row.voiceTimings = item.voiceTimings || row.voiceTimings;
        row.serverTimings = item.serverTimings || row.serverTimings;
        row.execution = executionEvidence(item) || row.execution;
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
    function review(id, value, sourceSession = sessionId) {
      if (sourceSession !== sessionId || !value) return false;
      const row = turn(id);
      if (!row) return false;
      if (value.status === 'context_required') {
        const refusalId = safe(value.traceId || id);
        if (row.reviewRefusal?.id === refusalId) return false;
        row.reviewRefusal = { id: refusalId, reason: 'context_required' };
        return true;
      }
      const key = safe(value.adviceId || value.id || value.traceId || id) + ':' + String(value.version || 1);
      if (row.reviews.some(item => item.key === key)) return false;
      row.reviewRefusal = null;
      const chronology = snapshot().turns.map(item => item.id);
      const replaced = chronology.indexOf(id) < chronology.length - 1;
      if (!replaced) for (const previous of turns.values()) previous.reviews.forEach(item => { item.replaced = true; });
      row.reviews.push({ key, turnId: id, available: true, replaced, included: false });
      return true;
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
        const owner = turn(item.turnId, { captureOnly: false });
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
        captures: rows.filter(row => row.captureOnly),
        turns: rows.filter(row => !row.captureOnly).map(row => ({ ...row, reviews: row.reviews.map(advice => ({ ...advice,
          includedIn: brainRefs.get(advice.key) || [] })),
        works: (worksByTurn.get(row.id) || []).map(item => ({ ...item,
          includedIn: workRefs.get(`${item.id}:${item.result?.version}`) || [] })),
        events: eventsByTurn.get(row.id) || [] })) };
    }
    return { follow, reset, begin, capture, captureEnd, stream, timings, restore, review, ingest, pollFailure, snapshot };
  }

  function stageState(stage, row) {
    const work = row.works?.at(-1), voice = row.voiceTimings || {}, server = row.serverTimings || {};
    if (stage === 'stt') return row.channel === 'text' ? ['No voice', 'Written message']
      : validMs(voice.sttDone) ? ['Done', `Recognition: ${duration(voice.sttDone)} after end of speech`]
        : row.phase === 'transcribing' && row.live ? ['In progress', 'Transcription started in the browser']
          : ['Unknown', 'No STT measurement kept'];
    if (stage === 'guardian') {
      const status = work?.guardianStatus;
      if (row.telemetryStale && ['pending', 'running', 'uncertain'].includes(status)) return ['Uncertain', 'Latest Core state not refreshed'];
      if (status && status !== 'unknown') return [{ pending: 'Waiting', running: 'Active', completed: 'Done', cancelled: 'Interrupted', failed: 'Failed', uncertain: 'Uncertain' }[status] || 'Unknown', work.guardianRunId ? `Run ${work.guardianRunId}` : 'Run not observed'];
      if (row.done) return ['Unknown', 'Answer received, Guardian run not attested'];
      if (row.error || row.interrupted) return ['Uncertain', 'Stream ended, Guardian state not attested'];
      if (row.deferred) return ['Unknown', 'Request kept, Guardian run not attested'];
      if (row.phase === 'waiting_host') return row.telemetryStale ? ['Uncertain', 'Latest Core state not refreshed']
        : ['Waiting', 'Host busy, cause reported by Core · duration unknown'];
      return row.live && row.stream?.includes('accepted') ? ['Waiting', 'Request accepted, Guardian start not attested'] : ['Unknown', 'No Guardian receipt'];
    }
    if (stage === 'review') {
      const advice = row.reviews?.at(-1);
      if (work && ['failed', 'cancelled', 'paused'].includes(work.state)) {
        const labels = { failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused' };
        const reasons = { native_preparation_refused: 'agent preparation refused',
          CONVERSATION_CONTEXT_REQUIRED: 'not enough context to review the whole conversation',
          native_result_not_published: 'result not published', owner_cancelled_before_dispatch: 'cancelled before handoff' };
        const code = typeof work.reason === 'string' && (Object.hasOwn(reasons, work.reason) || /^[a-z][a-z0-9_]{0,79}$/.test(work.reason)) ? work.reason : '';
        return [labels[work.state], `Work ${work.id} · ${reasons[code] || (code ? `Core reason: ${code}` : 'reason not detailed')}`];
      }
      if (work?.result) {
        const included = work.includedIn?.[0];
        if (included?.coverage?.includes('result_excerpt')) return ['Excerpt',
          `Work ${work.id} · excerpt in context of turn ${included.targetTurnId}; full result retained in Core`];
        return included ? ['Included', `Work ${work.id} · context of turn ${included.targetTurnId}`]
          : ['Available', `Work ${work.id} · version ${work.result.version}`];
      }
      if (work?.resultDisposition === 'no_work') return ['Done', `Work ${work.id} · nothing useful to add`];
      if (row.reviewRefusal) return ['Unavailable', 'Complete background review lacked context; no partial advice used'];
      if (advice) return [advice.replaced ? 'Replaced' : advice.includedIn?.length ? 'Included' : 'Available',
        advice.includedIn?.length ? `Context of turn ${advice.includedIn[0].targetTurnId}` : `Advice for turn ${advice.turnId} · inclusion not attested`];
      if (work && ['received', 'queued', 'dispatching', 'running', 'uncertain'].includes(work.state)) {
        const dispatched = row.events?.some(event => event.workId === work.id && event.type === 'dispatch_marked');
        const started = row.events?.some(event => event.workId === work.id && event.type === 'native_started');
        const active = work.state === 'dispatching' && dispatched || work.state === 'running' && (dispatched || started);
        return [row.telemetryStale || work.state === 'uncertain' ? 'Uncertain' : active ? 'In progress' : 'Waiting',
          `${row.telemetryStale ? 'Latest Core state not refreshed · ' : ''}Work ${work.id}${active ? ' · handoff attested' : ' · handoff not attested'}`];
      }
      return ['Unknown', 'No review advice observed'];
    }
    if (stage === 'tools') {
      const worker = (work?.tools || []).length, guardian = row.toolCount || 0;
      const admitted = work?.nativeAdmissions?.length || 0;
      return worker || guardian ? ['Observed', `Guardian: ${guardian} receipt${guardian > 1 ? 's' : ''} · work: ${worker} receipt${worker > 1 ? 's' : ''}`]
        : admitted ? ['Admitted', `${admitted} admission${admitted > 1 ? 's' : ''} · result not attested`]
          : row.activities?.some(item => item.tool) ? ['Reported', 'Tool reported by the stream · result not attested'] : ['Unknown', 'No tool receipt'];
    }
    if (stage === 'agents') {
      const agents = [...new Set([work?.attempt?.agentId, ...(row.activities || []).map(item => item.agentId)].filter(Boolean))];
      const started = row.events?.some(item => item.workId === work?.id && item.type === 'native_started');
      const settled = row.events?.some(item => item.workId === work?.id && item.type === 'native_settled');
      const active = work?.state === 'running' && work.attempt?.runId && started && !settled;
      return agents.length ? [active ? row.telemetryStale ? 'Uncertain' : 'Active'
        : work?.attempt?.runId || row.activities?.some(item => item.agentId) ? 'Observed' : 'Handoff prepared',
        `${agents.join(', ')}${work?.attempt?.runId ? ` · run ${work.attempt.runId}` : ''}`]
        : row.speaker ? ['Observed', row.speaker] : ['Unknown', 'No delegation attested'];
    }
    if (stage === 'tts') return voice.interrupted || row.interrupted ? ['Interrupted', 'Playback interrupted; Main work has its own receipt']
      : voice.playbackOutcome === 'failed' ? ['Failed', 'Browser playback did not complete; full text remains available']
        : voice.playbackOutcome === 'completed' ? ['Done', 'Browser playback finished; acoustic arrival is not measured']
      : validMs(voice.firstSignalScheduled) ? ['Signal scheduled', `Nonzero audio frame scheduled: ${duration(voice.firstSignalScheduled)} · browser observation, not acoustic arrival`]
        : validMs(voice.firstFrameScheduled) ? ['Frame scheduled', `Audio frame scheduled: ${duration(voice.firstFrameScheduled)} · silence may be included`]
          : row.channel === 'text' && !validMs(voice.firstAudio) ? ['No voice', 'Written answer']
      : validMs(voice.firstAudio) ? [voice.interrupted || row.interrupted ? 'Interrupted' : 'Playback requested', `Playback attempt: ${duration(voice.firstAudio)} after end of speech · sound not attested`]
        : ['Unknown', 'No playback attempt kept'];
    return ['Unknown', 'No data'];
  }

  function node(tag, className, value) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (value !== undefined) element.textContent = value; return element;
  }
  const ICONS = {
    stt: '<path d="M3 12h3l2-7 4 14 3-10 2 3h4"/>',
    guardian: '<path d="m12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
    review: '<path d="M9 4a4 4 0 0 0-4 4 4 4 0 0 0-1 7 4 4 0 0 0 5 5M15 4a4 4 0 0 1 4 4 4 4 0 0 1 1 7 4 4 0 0 1-5 5M12 3v18M5 8h3m-4 7h4m11-7h-3m4 7h-4"/>',
    tools: '<path d="m14 7 3 3 4-4a6 6 0 0 1-7 8l-6 6a3 3 0 0 1-4-4l6-6a6 6 0 0 1 8-7z"/>',
    agents: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M12 7v5M5 16v-4h14v4"/>',
    tts: '<path d="M4 10h4l5-5v14l-5-5H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
  };
  function stageIcon(key) {
    const icon = node('span', 'workflow-icon'); icon.setAttribute('aria-hidden', 'true');
    // Icons are fixed source SVGs; observed text always goes through textContent.
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
    return icon;
  }
  const activeState = state => ['Active', 'In progress'].includes(state);
  function stageTone(state) {
    return activeState(state) ? 'active'
      : ['Failed', 'Uncertain', 'Interrupted', 'Cancelled', 'Paused', 'Waiting', 'Unavailable'].includes(state) ? 'caution'
        : ['Done', 'Available', 'Included'].includes(state) ? 'complete'
          : ['Unknown', 'No voice'].includes(state) ? 'unknown' : 'observed';
  }
  function svgNode(tag, attributes = {}, value) {
    const element = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    for (const [key, content] of Object.entries(attributes)) element.setAttribute(key, content);
    if (value !== undefined) element.textContent = value;
    return element;
  }
  function flowGraph(stateFor, connections, stale, compact, inspect) {
    const figure = node('figure', 'workflow-graph'); figure.dataset.key = 'graph';
    figure.dataset.compact = String(compact);
    const svg = svgNode('svg', { viewBox: compact ? '0 0 350 358' : '0 0 740 248', role: 'group',
      'aria-label': `Turn flow. ${STAGES.map(([key, label]) => `${label}: ${stateFor(key)[0]}`).join('. ')}. Solid paths have recorded handoffs; dotted paths await evidence.` });
    const route = (name, path, connected, target) => {
      const tone = connected ? !stale && activeState(stateFor(target)[0]) ? 'active' : 'recorded' : 'pending';
      const group = svgNode('g', { class: 'workflow-route', 'data-key': `route:${name}`, 'data-stage': target,
        'data-connected': String(!!connected), 'data-tone': tone });
      group.append(svgNode('path', { d: path, class: 'workflow-route-base' }), svgNode('path', { d: path, class: 'workflow-route-packet' }));
      svg.append(group);
    };
    route('recognition', compact ? 'M87 106V150' : 'M212 66H270', connections.recognition, 'guardian');
    route('playback', compact ? 'M87 226V270' : 'M470 66H528', connections.playback, 'tts');
    route('background', compact ? 'M166 188H175V68H184' : 'M370 104V119Q370 127 362 127H120Q112 127 112 135V162', connections.background, 'review');
    if (connections.guardianTools) route('guardian-tools', compact ? 'M166 206H175V250H263V270' : 'M420 104V119Q420 127 428 127H620Q628 127 628 135V162', true, 'tools');
    route('delegation', compact ? 'M263 106V150' : 'M212 200H270', connections.delegation, 'agents');
    route('tools', compact ? 'M263 226V270' : 'M470 200H528', connections.tools, 'tools');
    svg.append(svgNode('text', { x: compact ? 8 : 12, y: 15, class: 'workflow-graph-lane' }, compact ? '01 / DIRECT' : '01 / DIRECT ANSWER'),
      svgNode('text', { x: compact ? 184 : 12, y: compact ? 15 : 149, class: 'workflow-graph-lane workflow-graph-lane-background' }, compact ? '02 / BACKGROUND' : '02 / BACKGROUND WORK'));
    const positions = compact
      ? [['stt', 8, 30], ['guardian', 8, 150], ['tts', 8, 270], ['review', 184, 30], ['agents', 184, 150], ['tools', 184, 270]]
      : [['stt', 12, 28], ['guardian', 270, 28], ['tts', 528, 28], ['review', 12, 162], ['agents', 270, 162], ['tools', 528, 162]];
    for (const [key, x, y] of positions) {
      const [state] = stateFor(key), label = STAGES.find(stage => stage[0] === key)[1];
      const group = svgNode('g', { transform: `translate(${x} ${y})`, class: 'workflow-graph-node',
        'data-stage': key, 'data-key': `graph:${key}`, 'data-tone': stale && activeState(state) ? 'unknown' : stageTone(state),
        role: 'button', tabindex: '0', 'aria-label': `${label}: ${state}. Inspect stage receipts.` });
      group.addEventListener?.('click', () => inspect(key));
      group.addEventListener?.('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); inspect(key); } });
      const icon = svgNode('g', { transform: compact ? 'translate(12 16)' : 'translate(15 16)', class: 'workflow-graph-icon', fill: 'none', stroke: 'currentColor',
        'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      icon.innerHTML = ICONS[key];
      group.append(svgNode('rect', { width: compact ? 158 : 200, height: 76, rx: 12, class: 'workflow-graph-node-bg' }),
        svgNode('circle', { cx: compact ? 24 : 27, cy: 28, r: 19, class: 'workflow-graph-halo' }), icon,
        svgNode('text', { x: compact ? 47 : 56, y: 28, class: 'workflow-graph-label' }, label),
        svgNode('circle', { cx: compact ? 49 : 61, cy: 49, r: 3, class: 'workflow-graph-led' }),
        svgNode('text', { x: compact ? 58 : 72, y: 53, class: 'workflow-graph-state' }, compact && state === 'Playback requested' ? 'Requested' : state));
      for (let bar = 0; bar < (compact ? 9 : 12); bar++) group.append(svgNode('rect', { x: 16 + bar * 14, y: 65, width: 8, height: 2,
        rx: 1, class: 'workflow-graph-bar', style: `--bar-delay:${bar * -90}ms` }));
      svg.append(group);
    }
    figure.append(svg, node('figcaption', 'workflow-graph-legend', 'Solid paths · recorded handoffs    /    Dotted paths · awaiting evidence    /    Select a stage to inspect'));
    return figure;
  }
  function reconcileChildren(parent, fresh) {
    if (!parent.childNodes) { parent.replaceChildren(...fresh.children); return; }
    // Retain stage DOM and animation clocks across polling, timing and stream updates.
    const key = element => element.nodeType === 1 ? element.getAttribute('data-key') : null;
    const desired = [...fresh.childNodes];
    for (let index = 0; index < desired.length; index++) {
      const next = desired[index], identity = key(next);
      let old = parent.childNodes[index];
      if (identity && key(old || {}) !== identity) old = [...parent.childNodes].find(child => key(child) === identity);
      if (!old || old.nodeName !== next.nodeName || key(old) !== identity) { parent.insertBefore(next, parent.childNodes[index] || null); continue; }
      if (old !== parent.childNodes[index]) parent.insertBefore(old, parent.childNodes[index] || null);
      if (old.nodeType !== 1) { if (old.textContent !== next.textContent) old.textContent = next.textContent; continue; }
      for (const attribute of [...old.attributes]) if (!next.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) if (old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
      reconcileChildren(old, next);
    }
    while (parent.childNodes.length > desired.length) parent.lastChild.remove();
  }
  function intervals(events) {
    const starts = { guardian_started: 'guardian_settled', dispatch_marked: 'native_started',
      native_started: 'native_settled', presentation_claim: 'presentation_started' };
    const labels = { guardian_started: 'Guardian active', dispatch_marked: 'Handoff before start',
      native_started: 'Agent active or waiting internally', presentation_claim: 'Wait before playback' };
    const out = [];
    for (const start of events) {
      const endType = starts[start.type];
      if (!endType) continue;
      const end = events.find(item => item.workId === start.workId && item.sequence > start.sequence && item.type === endType);
      const elapsed = Date.parse(end?.at) - Date.parse(start.at);
      if (end && validMs(elapsed)) out.push(`${labels[start.type]}: ${duration(elapsed)} (Core clock)`);
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
    const compactMedia = root.matchMedia?.('(max-width: 760px)');
    let compactFlow = !!compactMedia?.matches || (host.getBoundingClientRect?.().width || Infinity) < 600;
    let selected = null, turnOffset = 0, eventOffset = 0;
    const overview = node('div', 'workflow-map'); overview.setAttribute('aria-label', 'Workflow components');
    const panel = node('details', 'workflow-panel');
    const summary = node('summary', 'workflow-toggle', 'Log and receipts');
    const body = node('div', 'workflow-body'); panel.append(summary, body); host.append(overview, panel);
    function render() {
      const focused = document.activeElement?.closest?.('[data-key]');
      const focusKey = focused && host.contains?.(focused) ? focused.dataset.key : null;
      const restoreFocus = () => {
        if (!focusKey) return;
        const controls = [...host.querySelectorAll('[data-key]')];
        const target = controls.find(item => item.dataset.key === focusKey)
          || (/(turns|events)-(older|newer)/.test(focusKey)
            ? controls.find(item => item.dataset.key === focusKey.replace(/(older|newer)$/, (_, direction) => direction === 'older' ? 'newer' : 'older'))
            : null);
        (target?.matches('button') || target?.getAttribute?.('role') === 'button' ? target : target?.querySelector('summary'))?.focus({ preventScroll: true });
      };
      const view = model.snapshot();
      const rows = view.turns, current = rows.find(row => row.id === selected) || rows.at(-1);
      if (current) selected = current.id;
      summary.textContent = `Log and receipts${rows.length ? ` · ${rows.length} turn${rows.length > 1 ? 's' : ''}` : ''}`;
      const expanded = new Set([...overview.querySelectorAll?.('details[open]') || [], ...body.querySelectorAll?.('details[open]') || []].map(item => item.dataset.key));
      const canvas = node('div');
      const chosen = { ...(current || { channel: 'unknown', works: [], reviews: [] }), telemetryStale: view.stale };
      const stateFor = key => stageState(key, chosen);
      const isActive = activeState;
      const card = key => {
        const label = STAGES.find(stage => stage[0] === key)[1], [state, detail] = stateFor(key);
        const element = node('details', 'workflow-component'); element.dataset.key = `stage:${key}`;
        element.dataset.stage = key;
        element.dataset.tone = view.stale && isActive(state) ? 'unknown' : stageTone(state);
        element.open = expanded.has(element.dataset.key);
        const title = node('summary');
        const icon = stageIcon(key);
        const caption = node('small', 'workflow-caption', detail); caption.setAttribute('title', detail);
        const copy = node('span', 'workflow-copy'); copy.append(node('strong', 'workflow-label', label), caption);
        const status = node('span', 'workflow-state'); const led = node('span', 'workflow-led');
        led.setAttribute('aria-hidden', 'true'); status.append(led, node('span', '', state));
        title.append(icon, copy, status);
        const activity = node('span', 'workflow-signal'); activity.setAttribute('aria-hidden', 'true');
        element.append(title, node('p', 'workflow-detail', detail), activity);
        return element;
      };
      const activeCount = view.stale ? 0 : STAGES.filter(([key]) => isActive(stateFor(key)[0])).length;
      if (signal) {
        const active = STAGES.filter(([key]) => isActive(stateFor(key)[0])).map(([, label]) => label);
        const waiting = STAGES.filter(([key]) => stateFor(key)[0] === 'Waiting').map(([, label]) => label);
        signal.textContent = current ? `Turn ${rows.indexOf(current) + 1} · ${active.length ? `In progress: ${active.join(', ')}`
          : waiting.length ? `Waiting: ${waiting.join(', ')}` : current.done ? 'Answer received' : 'activity not attested'}${view.stale ? ' · Core not refreshed' : ''}`
          : 'No turn in progress';
      }
      const compact = compactFlow;
      const head = node('div', 'workflow-map-head');
      head.dataset.key = 'head';
      head.dataset.live = String(activeCount > 0 && !view.stale);
      head.dataset.stale = String(view.stale);
      head.append(node('div', 'workflow-kicker', 'SIGNAL / NESTOR'),
        node('strong', 'workflow-map-title', current ? `Turn ${rows.indexOf(current) + 1} · ${current.channel === 'voice' ? compact ? 'voice' : 'voice conversation' : current.channel === 'text' ? compact ? 'text' : 'text conversation' : 'unknown channel'}` : 'Waiting for a turn'));
      head.append(node('span', 'workflow-live-count', view.stale ? 'Core data not refreshed' : activeCount ? `${activeCount} component${activeCount > 1 ? 's' : ''} in progress` : 'No active stage'));
      canvas.append(head);
      const lastCapture = view.captures.at(-1);
      const captureLabels = { stop: 'Stop recognized · no new request', activation: 'Activation recognized · conversation open',
        not_addressed: 'Not addressed · no request', empty: 'No recognized words · no request', echo: 'Playback echo filtered · no request',
        failed: 'Transcription failed · no request', cancelled: 'Capture cancelled · no request', recognized: 'Capture recognized · no Core request',
        not_submitted: 'Capture ended · no Core request' };
      if (lastCapture) { const captureStatus = node('p', 'workflow-capture-status', lastCapture.live
        ? 'Microphone · recognizing speech; no request submitted yet'
        : `Microphone · ${captureLabels[lastCapture.captureOutcome] || 'No Core request'}`);
        captureStatus.dataset.live = String(!!lastCapture.live); captureStatus.dataset.key = 'capture-status'; canvas.append(captureStatus); }
      const meters = node('div', 'workflow-meters'); meters.setAttribute('aria-label', 'Measured timings');
      meters.dataset.key = 'meters';
      const voice = current?.voiceTimings || {}, guardianMs = measuredSpan(current?.events, 'guardian_started', ['guardian_settled']);
      const reviewMs = measuredSpan(current?.events, 'dispatch_marked', ['result_published', 'native_result_published']);
      const longest = Math.max(1, ...[voice.sttDone, guardianMs, reviewMs, voice.firstAudio].filter(validMs));
      const meter = (key, label, value, basis, active = false) => {
        const block = node('div', 'workflow-meter'); block.dataset.active = String(active && !validMs(value) && !view.stale);
        block.dataset.key = `meter:${key}`;
        block.dataset.stage = key; block.dataset.measured = String(validMs(value));
        block.setAttribute('style', `--metric-fill:${validMs(value) ? Math.max(2, value / longest * 100) : 0}%`);
        block.append(node('span', 'workflow-meter-label', label),
          node('strong', 'workflow-meter-value', validMs(value) ? duration(value) : active ? 'In progress' : 'Unknown'),
          node('small', 'workflow-meter-basis', basis));
        const signal = node('span', 'workflow-meter-signal'); signal.setAttribute('aria-hidden', 'true'); block.append(signal);
        meters.append(block);
      };
      meter('stt', 'TRANSCRIPTION', voice.sttDone, 'Browser · end of speech', isActive(stateFor('stt')[0]));
      meter('guardian', 'GUARDIAN', guardianMs, 'Core · start → end', isActive(stateFor('guardian')[0]));
      meter('review', 'REVIEW', reviewMs, 'Core · handoff → advice', isActive(stateFor('review')[0]));
      meter('tts', 'PLAYBACK REQUESTED', voice.firstAudio, 'Browser · end of speech', isActive(stateFor('tts')[0]));
      canvas.append(meters);
      const flow = node('div', 'workflow-flow'); flow.setAttribute('aria-label', 'Turn flow and background work');
      flow.dataset.key = 'flow';
      const origin = node('div', 'workflow-origin');
      origin.setAttribute('title', current?.id || 'No turn received');
      origin.append(node('span', 'workflow-origin-mark', '◎'), node('span', 'workflow-origin-label', current ? `Your turn · ${String(rows.indexOf(current) + 1).padStart(2, '0')}` : 'Your next turn'));
      flow.append(origin);
      const lanes = node('div', 'workflow-lanes');
      const immediate = node('section', 'workflow-lane workflow-lane-immediate');
      immediate.dataset.connected = String(!!current && (current.channel !== 'unknown' || current.stream?.length
        || current.events?.some(event => event.type === 'guardian_started')));
      immediate.append(node('h3', 'workflow-lane-title', '01  DIRECT CONVERSATION'),
        node('p', 'workflow-lane-subtitle', 'Nestor stays available during background work.'));
      const link = connected => { const edge = node('div', 'workflow-edge'); edge.dataset.connected = String(!!connected); edge.setAttribute('aria-hidden', 'true'); return edge; };
      const has = type => current?.events?.some(event => event.type === type);
      const connections = {
        recognition: current?.channel === 'voice' && validMs(voice.requestSent) && has('guardian_started'),
        playback: current?.done && validMs(voice.firstAudio),
        delegation: current?.works?.some(work => work.attempt?.agentId && current.events.some(event => event.workId === work.id && event.type === 'native_started')),
        tools: current?.works?.some(work => work.tools?.length), guardianTools: (current?.toolCount || 0) > 0
      };
      immediate.append(card('stt'),
        link(connections.recognition),
        card('guardian'),
        link(connections.playback),
        card('tts'));
      const background = node('section', 'workflow-lane workflow-lane-background');
      background.dataset.connected = String(!!current?.reviews?.length || !!current?.works?.some(work => work.turnId === current.id && current.events.some(event => event.workId === work.id && event.type === 'request_received')));
      background.append(node('h3', 'workflow-lane-title', '02  BACKGROUND REVIEW'),
        node('p', 'workflow-lane-subtitle', 'Advice can arrive after the answer.'));
      background.append(card('review'),
        link(connections.delegation),
        card('agents'));
      lanes.dataset.split = String(immediate.dataset.connected === 'true' && background.dataset.connected === 'true');
      flow.dataset.hasTurn = String(immediate.dataset.connected === 'true' || background.dataset.connected === 'true');
      connections.background = lanes.dataset.split === 'true' && (has('dispatch_marked') || !!current?.reviews?.length);
      const inspect = key => {
        const inspector = host.querySelector('.workflow-inspector');
        const stage = host.querySelector(`details[data-key="stage:${key}"]`);
        if (inspector && stage) { inspector.open = true; stage.open = true; stage.querySelector('summary')?.focus({ preventScroll: true }); }
      };
      flow.append(flowGraph(stateFor, connections, view.stale, compact, inspect));
      const milestone = node('div', 'workflow-milestone');
      const lastStep = current?.events?.at(-1);
      milestone.append(node('span', 'workflow-milestone-label', view.stale ? 'LAST KNOWN STEP' : 'LATEST STEP'),
        node('span', '', lastStep ? `${time(lastStep.at)} · ${EVENT_LABELS[lastStep.type] || 'Recorded event'}` : 'No Core step recorded'));
      flow.append(milestone);
      const inspector = node('details', 'workflow-inspector'); inspector.dataset.key = 'inspector'; inspector.open = expanded.has('inspector');
      inspector.append(node('summary', 'workflow-inspector-toggle', 'Inspect stages and resources'));
      lanes.append(immediate, background); inspector.append(lanes); flow.append(inspector);
      const services = node('div', 'workflow-services');
      services.append(node('div', 'workflow-services-heading', 'SERVICES IN USE'));
      const tools = card('tools'); services.append(tools);
      const guardianTools = (current?.toolCount || 0) > 0;
      const reviewTools = current?.works?.some(work => work.tools?.length);
      if (guardianTools || reviewTools) services.append(node('p', 'workflow-handoffs',
        [guardianTools ? 'Guardian → Tools · turn receipts' : '', reviewTools ? 'Review → Tools · work receipts' : ''].filter(Boolean).join('    ')));
      inspector.append(services);
      const resources = node('section', 'workflow-resources'); resources.setAttribute('aria-label', 'Observed resources');
      resources.append(node('h3', '', 'OBSERVED RESOURCES'));
      const latestWork = current?.works?.at(-1), toolReceipts = (current?.toolCount || 0) + (latestWork?.tools?.length || 0);
      const resource = (label, value) => { const item = node('div', 'workflow-resource'); item.append(node('small', '', label), node('strong', '', value)); resources.append(item); };
      resource('AGENT / RUN', latestWork?.attempt?.agentId ? `${latestWork.attempt.agentId}${latestWork.attempt.runId ? ` · ${latestWork.attempt.runId}` : ' · unknown run'}` : 'No run attested');
      if (current?.execution) resource('ENGINE / MODEL', [current.execution.backend, current.execution.model].filter(Boolean).join(' · '));
      resource('TOOLS', toolReceipts ? `${toolReceipts} receipt${toolReceipts > 1 ? 's' : ''} observed` : 'No receipt');
      resource('CORE LOG', view.stale ? 'Not refreshed' : view.events.length ? `${view.events.length} event${view.events.length > 1 ? 's' : ''} received` : 'No event received');
      const passages = node('section', 'workflow-passages'); passages.setAttribute('aria-label', 'Latest attested steps');
      passages.append(node('h3', '', 'LATEST STEPS'));
      const recent = view.events.slice(-3);
      if (!recent.length) passages.append(node('p', 'workflow-empty', 'No attested Core step.'));
      for (const item of recent) {
        const owner = rows.find(row => row.id === item.turnId);
        const entry = node('div', 'workflow-passage');
        entry.append(node('time', '', time(item.at)), node('span', '', EVENT_LABELS[item.type] || 'Recorded event'),
          node('small', '', `${owner ? `Turn ${rows.indexOf(owner) + 1} · ` : ''}Work ${item.workId}`));
        passages.append(entry);
      }
      inspector.append(resources, passages);
      const note = node('p', 'workflow-map-note', 'Links and steps are based on turn receipts. Included advice does not prove its influence.'); note.dataset.key = 'map-note';
      canvas.append(flow, note);
      reconcileChildren(overview, canvas);
      body.replaceChildren();
      if (!panel.open) { restoreFocus(); return; }
      if (view.captures.length) {
        const captures = node('details', 'workflow-captures'); captures.dataset.key = 'captures';
        captures.open = expanded.has('captures'); captures.append(node('summary', '', `Microphone captures · ${view.captures.length} · not conversation turns`));
        for (const capture of view.captures.slice(-24)) captures.append(node('p', '', `${capture.id} · ${capture.live ? 'Recognizing' : captureLabels[capture.captureOutcome] || 'No Core request'} · STT ${duration(capture.voiceTimings?.sttDone)}`));
        body.append(captures);
      }
      const intro = node('p', 'workflow-intro', 'Steps observed in this conversation. Several components can work at the same time.');
      body.append(intro);
      if (!current) { body.append(node('p', 'workflow-empty', 'No turn recorded. Components will appear here.')); return; }
      const picker = node('div', 'workflow-turns'); picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', 'Choose a turn');
      const turnEnd = rows.length - turnOffset, turnStart = Math.max(0, turnEnd - 24);
      if (turnStart > 0) {
        const older = node('button', 'workflow-more', '24 earlier turns');
        older.type = 'button'; older.dataset.key = 'turns-older'; older.onclick = () => { turnOffset += 24; render(); }; picker.append(older);
      }
      rows.slice(turnStart, turnEnd).forEach((row, index) => {
        const button = node('button', 'workflow-turn', `Turn ${turnStart + index + 1}${row.interrupted ? ' · interrupted' : ''}`);
        button.dataset.key = `turn:${row.id}`;
        button.type = 'button'; button.setAttribute('aria-pressed', String(row.id === selected));
        button.onclick = () => { selected = row.id; render(); body.querySelector?.('button[aria-pressed="true"]')?.focus(); }; picker.append(button);
      });
      if (turnOffset > 0) {
        const newer = node('button', 'workflow-more', '24 later turns');
        newer.type = 'button'; newer.dataset.key = 'turns-newer'; newer.onclick = () => { turnOffset = Math.max(0, turnOffset - 24); render(); }; picker.append(newer);
      }
      body.append(picker);
      const identity = node('p', 'workflow-identity', `Turn ${rows.indexOf(current) + 1} · ID ${current.id}`); body.append(identity);
      const timing = node('div', 'workflow-timing');
      const server = current.serverTimings || {};
      timing.append(node('h3', '', 'Measured durations'), node('p', '',
        `Browser, from end of speech: STT ${duration(voice.sttDone)}, request ${duration(voice.requestSent)}, first text ${duration(voice.firstDelta)}, playback start requested ${duration(voice.firstAudio)}. This does not attest that sound was heard. Reported STT processing: ${duration(voice.sttServer)}.`),
        node('p', '', `Server, from start of request: context ready at ${duration(server.prepared)}, answer received at ${duration(server.executed)}.`),
        node('small', '', 'Different clock origins: these durations are not added together. A missing value stays unknown.'));
      const recognition = voice.recognition;
      if (recognition) {
        timing.append(node('p', '', `Recognition request: ${recognition.recognitionId || 'not reported'} · ${recognition.mode || 'capture mode not reported'}. Requested language: ${recognition.requestedLanguage || 'not reported'}; decoded language: ${recognition.decodedLanguage || 'not reported'} (${recognition.languageSource || 'source not reported'}).`),
          node('p', '', `Whisper lock wait: ${duration(recognition.queueMs)}; processing: ${duration(recognition.decodeMs)}. Uploaded audio: ${Number.isFinite(recognition.audioSeconds) ? recognition.audioSeconds.toFixed(2) + ' s' : 'not reported'}; after speech filter (including padding): ${Number.isFinite(recognition.speechSeconds) ? recognition.speechSeconds.toFixed(2) + ' s' : 'not reported'}. Submitted bytes: ${recognition.submittedBytes ?? 'not reported'}; complete capture bytes: ${recognition.captureBytes ?? 'not reported'}.`),
          node('small', '', 'Browser-reported recognition diagnostics; they do not establish word accuracy. No audio is stored here.'));
      }
      for (const value of intervals(current.events)) timing.append(node('p', '', value));
      body.append(timing);
      const heading = node('h3', '', 'Shared work timeline'); body.append(heading);
      const eventEnd = view.events.length - eventOffset, eventStart = Math.max(0, eventEnd - 80);
      if (eventStart > 0) {
        const older = node('button', 'workflow-more', '80 earlier events');
        older.type = 'button'; older.dataset.key = 'events-older'; older.onclick = () => { eventOffset += 80; render(); }; body.append(older);
      }
      const list = node('ol', 'workflow-events');
      for (const event of view.events.slice(eventStart, eventEnd)) {
        const owner = rows.find(row => row.id === event.turnId);
        const work = owner?.works.find(item => item.id === event.workId);
        const entry = node('li', 'workflow-event');
        const when = node('time', '', time(event.at));
        if (event.at) when.dateTime = String(event.at);
        const label = EVENT_LABELS[event.type] || 'Recorded event';
        entry.append(when, node('span', '', label), node('small', '', `${owner ? `Turn ${rows.indexOf(owner) + 1} · ` : ''}Work ${event.workId}${work?.attempt?.agentId && /^(dispatch_|native_)/.test(event.type) ? ` · ${work.attempt.agentId}` : ''}`));
        list.append(entry);
      }
      body.append(list);
      if (eventOffset > 0) {
        const newer = node('button', 'workflow-more', '80 later events');
        newer.type = 'button'; newer.dataset.key = 'events-newer'; newer.onclick = () => { eventOffset = Math.max(0, eventOffset - 80); render(); }; body.append(newer);
      }
      if (!view.events.length) body.append(node('p', 'workflow-empty', 'No work event kept for this conversation.'));
      if (view.gap) body.append(node('p', 'workflow-gap', 'Part of the event history is no longer available. Missing steps stay unknown.'));
      if (view.stale) body.append(node('p', 'workflow-gap', 'Core data is no longer refreshed. Steps still active stay uncertain.'));
      for (const work of current.works) {
        const detail = node('details', 'workflow-evidence');
        detail.dataset.key = `work:${work.id}`; detail.open = expanded.has(detail.dataset.key);
        detail.append(node('summary', '', `Receipts · work ${work.id}`));
        detail.append(node('p', '', `Classification ${work.classification || 'unknown'} · state ${work.state || 'unknown'} · revision ${work.revision}`));
        if (work.reason) detail.append(node('p', '', `Reported cause: ${work.reason}`));
        if (work.attempt) detail.append(node('p', '', `Agent ${work.attempt.agentId || 'unknown'} · attempt ${work.attempt.id || 'unknown'} · run ${work.attempt.runId || 'unknown'}`));
        for (const tool of work.tools || []) detail.append(node('p', '', `Tool ${tool.tool || 'unknown'} · receipt ${tool.id || 'unknown'} · run ${tool.runId || 'unknown'} · ${tool.status || 'unknown state'}`));
        for (const call of work.nativeAdmissions || []) detail.append(node('p', '', `Admission ${call.tool || 'unknown tool'} · ${call.id || 'unknown ID'} · result not attested`));
        if (work.result) detail.append(node('p', '', `Advice available · version ${work.result.version} · ${work.includedIn?.length ? `included in the context of turn ${work.includedIn.map(ref => ref.targetTurnId).join(', ')}` : 'inclusion in a later turn not attested'}. Inclusion does not prove influence.`));
        if (work.resultDisposition === 'no_work') detail.append(node('p', '', 'Review finished · nothing useful published.'));
        body.append(detail);
      }
      if (current.activities.length) {
        const activity = node('details', 'workflow-evidence'); activity.dataset.key = `activity:${current.id}`;
        activity.open = expanded.has(activity.dataset.key); activity.append(node('summary', '', 'Activities reported during this turn'));
        for (const item of current.activities) activity.append(node('p', '', `${item.kind === 'tool' ? 'Tool' : 'Handoff'}: ${item.tool || item.agentId || 'unknown ID'}${item.agentId && item.tool ? ` · agent ${item.agentId}` : ''} · result not inferred from the signal`));
        body.append(activity);
      }
      for (const advice of current.reviews) body.append(node('p', 'workflow-advice',
        `Advice ${advice.key} · ${advice.replaced === true ? 'replaced' : advice.reconstructed ? 'current status unknown' : 'available'} · ${advice.includedIn?.length ? `included in the context of turn ${advice.includedIn.map(ref => ref.targetTurnId).join(', ')}` : 'inclusion not attested'} · influence not proven`));
      if (current.reviewRefusal) body.append(node('p', 'workflow-advice',
        `Review ${current.reviewRefusal.id}: unavailable; complete context required; no advice was produced`));
      for (const ref of current.adviceRefs || []) body.append(node('p', 'workflow-advice',
        `Context of this turn: ${ref.source === 'work' ? `work ${ref.workId}` : `advice ${ref.adviceId}`} · version ${ref.version} · coverage ${(ref.coverage || []).join(', ') || 'unknown'} · influence not proven`));
      restoreFocus();
    }
    function update(action) { if (action() !== false) render(); }
    render();
    panel.addEventListener?.('toggle', render);
    const resizeFlow = () => {
      const width = host.getBoundingClientRect?.().width || Infinity;
      const next = !!compactMedia?.matches || width < 600;
      if (next !== compactFlow) { compactFlow = next; render(); }
    };
    compactMedia?.addEventListener?.('change', resizeFlow);
    const resizeObserver = root.ResizeObserver ? new root.ResizeObserver(resizeFlow) : null;
    resizeObserver?.observe(host);
    return {
      model, panel, render,
      reset: () => update(() => { model.reset(); selected = null; turnOffset = 0; eventOffset = 0; }),
      follow: id => update(() => { if (!model.follow(id)) return false; selected = null; turnOffset = 0; eventOffset = 0; }),
      begin: (session, id, channel) => update(() => { model.begin(session, id, channel); selected = id; turnOffset = 0; eventOffset = 0; }),
      capture: (session, id) => update(() => { model.capture(session, id); selected = id; turnOffset = 0; eventOffset = 0; }),
      captureEnd: (id, receipt) => update(() => model.captureEnd(id, receipt)),
      stream: (id, event) => update(() => model.stream(id, event)),
      timings: (id, value) => update(() => model.timings(id, value)),
      restore: (session, turns) => update(() => model.restore(session, turns)),
      review: (id, value, session) => update(() => model.review(id, value, session)),
      ingest: (session, data) => update(() => model.ingest(session, data)),
      pollFailure: id => update(() => model.pollFailure(id))
    };
  }
  const api = { create, createModel, stageState, duration, intervals };
  root.NestorWorkflow = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
