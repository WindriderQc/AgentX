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
    function review(id, value, sourceSession = sessionId) {
      if (sourceSession !== sessionId || !value) return false;
      const row = turn(id);
      if (!row) return false;
      const key = safe(value.adviceId || value.id || value.traceId || id) + ':' + String(value.version || 1);
      if (row.reviews.some(item => item.key === key)) return false;
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
      const advice = row.reviews.at(-1);
      if (work && ['failed', 'cancelled', 'paused'].includes(work.state)) {
        const labels = { failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused' };
        const reasons = { native_preparation_refused: 'agent preparation refused',
          native_result_not_published: 'result not published', owner_cancelled_before_dispatch: 'cancelled before handoff' };
        const code = typeof work.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(work.reason) ? work.reason : '';
        return [labels[work.state], `Work ${work.id} · ${reasons[code] || (code ? `Core reason: ${code}` : 'reason not detailed')}`];
      }
      if (work?.result) return work.includedIn?.length ? ['Included', `Work ${work.id} · context of turn ${work.includedIn[0].targetTurnId}`]
        : ['Available', `Work ${work.id} · version ${work.result.version}`];
      if (work?.resultDisposition === 'no_work') return ['Done', `Work ${work.id} · nothing useful to add`];
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
    if (stage === 'tts') return row.channel === 'text' ? ['No voice', 'Written answer']
      : validMs(voice.firstAudio) ? [voice.interrupted || row.interrupted ? 'Interrupted' : 'Playback requested', `Playback attempt: ${duration(voice.firstAudio)} after end of speech · sound not attested`]
        : ['Unknown', 'No playback attempt kept'];
    return ['Unknown', 'No data'];
  }

  function node(tag, className, value) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (value !== undefined) element.textContent = value; return element;
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
        (target?.matches('button') ? target : target?.querySelector('summary'))?.focus();
      };
      const view = model.snapshot();
      const rows = view.turns, current = rows.find(row => row.id === selected) || rows.at(-1);
      if (current) selected = current.id;
      summary.textContent = `Log and receipts${rows.length ? ` · ${rows.length} turn${rows.length > 1 ? 's' : ''}` : ''}`;
      const expanded = new Set([...overview.querySelectorAll?.('details[open]') || [], ...body.querySelectorAll?.('details[open]') || []].map(item => item.dataset.key));
      overview.replaceChildren();
      const chosen = { ...(current || { channel: 'unknown', works: [], reviews: [] }), telemetryStale: view.stale };
      const symbols = { stt: '〰', guardian: '◆', review: '✦', tools: '⌘', agents: '↗', tts: '♫' };
      const stateFor = key => stageState(key, chosen);
      const isActive = state => ['Active', 'In progress'].includes(state);
      const card = key => {
        const label = STAGES.find(stage => stage[0] === key)[1], [state, detail] = stateFor(key);
        const element = node('details', 'workflow-component'); element.dataset.key = `stage:${key}`;
        element.dataset.stage = key;
        element.dataset.tone = isActive(state) ? 'active'
          : ['Failed', 'Uncertain', 'Interrupted', 'Cancelled', 'Paused', 'Waiting'].includes(state) ? 'caution'
            : ['Done', 'Available', 'Included'].includes(state) ? 'complete'
              : ['Unknown', 'No voice'].includes(state) ? 'unknown' : 'observed';
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
        const waiting = STAGES.filter(([key]) => stateFor(key)[0] === 'Waiting').map(([, label]) => label);
        signal.textContent = current ? `Turn ${rows.indexOf(current) + 1} · ${active.length ? `In progress: ${active.join(', ')}`
          : waiting.length ? `Waiting: ${waiting.join(', ')}` : 'activity not attested'}${view.stale ? ' · Core not refreshed' : ''}`
          : 'No turn in progress';
      }
      const compact = root.matchMedia?.('(max-width: 760px)')?.matches;
      const head = node('div', 'workflow-map-head');
      head.dataset.live = String(activeCount > 0 && !view.stale);
      head.dataset.stale = String(view.stale);
      head.append(node('div', 'workflow-kicker', 'SIGNAL / NESTOR'),
        node('strong', 'workflow-map-title', current ? `Turn ${rows.indexOf(current) + 1} · ${current.channel === 'voice' ? compact ? 'voice' : 'voice conversation' : current.channel === 'text' ? compact ? 'text' : 'text conversation' : 'unknown channel'}` : 'Waiting for a turn'));
      head.append(node('span', 'workflow-live-count', view.stale ? 'Core data not refreshed' : `${activeCount} component${activeCount > 1 ? 's' : ''} in progress`));
      overview.append(head);
      const meters = node('div', 'workflow-meters'); meters.setAttribute('aria-label', 'Measured timings');
      const voice = current?.voiceTimings || {}, guardianMs = measuredSpan(current?.events, 'guardian_started', ['guardian_settled']);
      const reviewMs = measuredSpan(current?.events, 'dispatch_marked', ['result_published', 'native_result_published']);
      const meter = (label, value, basis, active = false) => {
        const block = node('div', 'workflow-meter'); block.dataset.active = String(active && !validMs(value) && !view.stale);
        block.append(node('span', 'workflow-meter-label', label),
          node('strong', 'workflow-meter-value', validMs(value) ? duration(value) : active ? 'In progress' : 'Unknown'),
          node('small', 'workflow-meter-basis', basis));
        const signal = node('span', 'workflow-meter-signal'); signal.setAttribute('aria-hidden', 'true'); block.append(signal);
        meters.append(block);
      };
      meter('TRANSCRIPTION', voice.sttDone, 'Browser · end of speech', isActive(stateFor('stt')[0]));
      meter('GUARDIAN', guardianMs, 'Core · start → end', isActive(stateFor('guardian')[0]));
      meter('REVIEW', reviewMs, 'Core · handoff → advice', isActive(stateFor('review')[0]));
      meter('PLAYBACK REQUESTED', voice.firstAudio, 'Browser · end of speech', isActive(stateFor('tts')[0]));
      overview.append(meters);
      const flow = node('div', 'workflow-flow'); flow.setAttribute('aria-label', 'Turn flow and background work');
      const origin = node('div', 'workflow-origin');
      origin.append(node('span', 'workflow-origin-mark', '◎'), node('span', 'workflow-origin-label', current ? `Your turn · ${current.id}` : 'Your next turn'));
      flow.append(origin);
      const lanes = node('div', 'workflow-lanes');
      const immediate = node('section', 'workflow-lane workflow-lane-immediate');
      immediate.dataset.connected = String(!!current && (current.channel !== 'unknown' || current.stream?.length
        || current.events?.some(event => event.type === 'guardian_started')));
      immediate.append(node('h3', 'workflow-lane-title', '01  DIRECT CONVERSATION'),
        node('p', 'workflow-lane-subtitle', 'Nestor stays available during background work.'));
      const link = connected => { const edge = node('div', 'workflow-edge'); edge.dataset.connected = String(!!connected); edge.setAttribute('aria-hidden', 'true'); return edge; };
      const has = type => current?.events?.some(event => event.type === type);
      immediate.append(card('stt'),
        link(current?.channel === 'voice' && validMs(voice.requestSent) && has('guardian_started')),
        card('guardian'),
        link(current?.done && validMs(voice.firstAudio)),
        card('tts'));
      const background = node('section', 'workflow-lane workflow-lane-background');
      background.dataset.connected = String(!!current?.reviews?.length || !!current?.works?.some(work => work.turnId === current.id && current.events.some(event => event.workId === work.id && event.type === 'request_received')));
      background.append(node('h3', 'workflow-lane-title', '02  BACKGROUND REVIEW'),
        node('p', 'workflow-lane-subtitle', 'Advice can arrive after the answer.'));
      background.append(card('review'),
        link(current?.works?.some(work => work.attempt?.agentId && current.events.some(event => event.workId === work.id && event.type === 'native_started'))),
        card('agents'));
      lanes.dataset.split = String(immediate.dataset.connected === 'true' && background.dataset.connected === 'true');
      flow.dataset.hasTurn = String(immediate.dataset.connected === 'true' || background.dataset.connected === 'true');
      lanes.append(immediate, background); flow.append(lanes);
      const services = node('div', 'workflow-services');
      services.append(node('div', 'workflow-services-heading', 'SERVICES IN USE'));
      const tools = card('tools'); services.append(tools);
      const guardianTools = (current?.toolCount || 0) > 0;
      const reviewTools = current?.works?.some(work => work.tools?.length);
      if (guardianTools || reviewTools) services.append(node('p', 'workflow-handoffs',
        [guardianTools ? 'Guardian → Tools · turn receipts' : '', reviewTools ? 'Review → Tools · work receipts' : ''].filter(Boolean).join('    ')));
      flow.append(services);
      const resources = node('section', 'workflow-resources'); resources.setAttribute('aria-label', 'Observed resources');
      resources.append(node('h3', '', 'OBSERVED RESOURCES'));
      const latestWork = current?.works?.at(-1), toolReceipts = (current?.toolCount || 0) + (latestWork?.tools?.length || 0);
      const resource = (label, value) => { const item = node('div', 'workflow-resource'); item.append(node('small', '', label), node('strong', '', value)); resources.append(item); };
      resource('AGENT / RUN', latestWork?.attempt?.agentId ? `${latestWork.attempt.agentId}${latestWork.attempt.runId ? ` · ${latestWork.attempt.runId}` : ' · unknown run'}` : 'No run attested');
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
      overview.append(flow, ...(compact ? [] : [resources, passages]),
        node('p', 'workflow-map-note', 'Links and steps are based on turn receipts. Included advice does not prove its influence.'));
      body.replaceChildren();
      if (!panel.open) { restoreFocus(); return; }
      const intro = node('p', 'workflow-intro', 'Steps observed in this conversation. Several components can work at the same time.');
      body.append(intro);
      if (compact) body.append(resources, passages);
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
      for (const ref of current.adviceRefs || []) body.append(node('p', 'workflow-advice',
        `Context of this turn: ${ref.source === 'work' ? `work ${ref.workId}` : `advice ${ref.adviceId}`} · version ${ref.version} · coverage ${(ref.coverage || []).join(', ') || 'unknown'} · influence not proven`));
      restoreFocus();
    }
    function update(action) { if (action() !== false) render(); }
    render();
    panel.addEventListener?.('toggle', render);
    return {
      model, panel, render,
      reset: () => update(() => { model.reset(); selected = null; turnOffset = 0; eventOffset = 0; }),
      follow: id => update(() => { if (!model.follow(id)) return false; selected = null; turnOffset = 0; eventOffset = 0; }),
      begin: (session, id, channel) => update(() => { model.begin(session, id, channel); selected = id; turnOffset = 0; eventOffset = 0; }),
      capture: (session, id) => update(() => { model.capture(session, id); selected = id; turnOffset = 0; eventOffset = 0; }),
      captureEnd: id => update(() => model.captureEnd(id)),
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
