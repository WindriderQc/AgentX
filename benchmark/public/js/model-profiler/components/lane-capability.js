// public/js/model-profiler/components/lane-capability.js
/**
 * Lane capability cards (#832): what each pinned or routed model is ready for
 * on its host, read from existing Profiler evidence. Rendering is pure; the
 * only actions record heavy-work queue requests and plan their night slots.
 * Core starts a planned measurement only when the owner opted in.
 */

import { _fmtCtx, escAttr } from '../models-helpers.js';

export const TASK_LABELS = {
  daily_operator: 'Daily assistant',
  code_generation: 'Coding',
  master_brain: 'Master brain',
  conversation: 'Conversation',
  classification: 'Classification',
  summarization: 'Summaries',
  judging: 'Judging'
};

const READINESS = {
  ready: { label: 'Ready', tone: 'good' },
  speed_only: { label: 'Speed only', tone: 'warn', hint: 'Speed is measured; answer quality at this size is not' },
  unverified: { label: 'Unverified', tone: 'warn', hint: 'Recommendations need a fresh standard profile' },
  limited: { label: 'Limited', tone: 'warn', hint: 'Measured, but below the minimum for autonomous work steps' },
  not_measured: { label: 'Not measured', tone: 'dim' }
};

const fmtCtx = value => (Number(value) > 0 ? _fmtCtx(Number(value)) : '—');
const fmtRate = value => (Number(value) > 0 ? `${Number(value) >= 100 ? Math.round(value) : Number(value).toFixed(1)} tok/s` : '—');
const fmtMs = value => (Number(value) > 0 ? (value >= 10000 ? `${(value / 1000).toFixed(0)} s` : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`) : '—');

export function taskLabel(task) {
  return TASK_LABELS[task] || String(task || '').replace(/_/g, ' ');
}

export function ageText(days) {
  if (days === null || days === undefined) return 'never measured';
  if (days === 0) return 'measured today';
  if (days === 1) return 'measured yesterday';
  return `measured ${days} days ago`;
}

function readinessPill(name, state) {
  const meta = READINESS[state] || READINESS.not_measured;
  const title = meta.hint ? ` title="${escAttr(meta.hint)}"` : '';
  return `<span class="lc-ready lc-ready--${meta.tone}"${title}><span class="lc-ready-name">${escAttr(name)}</span><span class="lc-ready-state">${meta.label}</span></span>`;
}

/**
 * Context gauge on a log2 scale. Markers are drawn only for measured values;
 * the runtime window (pin) is a separate line so a window past the speed knee
 * is visible at a glance.
 */
export function renderContextGauge(capability, pinContext) {
  const c = capability?.context || {};
  const q = capability?.quality || {};
  const top = Math.max(c.theoreticalMax || 0, c.max || 0, pinContext || 0);
  if (!top) return '<p class="lc-empty">No context measurement for this exact artifact.</p>';
  const low = 2048;
  const pos = value => Math.max(0, Math.min(100, (Math.log2(Math.max(value, low)) - Math.log2(low)) / (Math.log2(top) - Math.log2(low) || 1) * 100));
  const markers = [
    { key: 'knee', value: c.knee, label: `Speed knee (≤${c.kneeDegradationPct || 15}% slower)` },
    { key: 'interactive', value: c.interactive, label: 'Interactive' },
    { key: 'document', value: c.document, label: 'Documents' },
    { key: 'quality', value: q.status === 'verified' ? q.context : null, label: 'Quality verified' }
  ].filter(marker => Number(marker.value) > 0);
  const verified = Number(c.max) > 0 ? `<span class="lc-gauge-fill" style="width:${pos(c.max).toFixed(1)}%"></span>` : '';
  const knee = Number(c.knee) > 0 ? `<span class="lc-gauge-slow" style="left:${pos(c.knee).toFixed(1)}%;width:${(pos(c.max || top) - pos(c.knee)).toFixed(1)}%"></span>` : '';
  const ticks = markers.map(marker =>
    `<span class="lc-gauge-mark lc-gauge-mark--${marker.key}" style="left:${pos(marker.value).toFixed(1)}%" title="${escAttr(`${marker.label}: ${fmtCtx(marker.value)}`)}"></span>`).join('');
  const pin = Number(pinContext) > 0
    ? `<span class="lc-gauge-pin" style="left:${pos(pinContext).toFixed(1)}%" title="${escAttr(`Runtime window: ${fmtCtx(pinContext)}`)}"></span>` : '';
  const legend = [
    ['max', 'Max verified', c.max], ['pin', 'Runtime window', pinContext], ...markers.map(marker => [marker.key, marker.label, marker.value])
  ].filter(([, , value]) => Number(value) > 0)
    .map(([key, label, value]) => `<li><span><i class="lc-swatch lc-swatch--${key}" aria-hidden="true"></i>${escAttr(label)}</span><strong>${fmtCtx(value)}</strong></li>`).join('');
  const qualityUnknown = q.status !== 'verified' ? '<li class="lc-legend-missing"><span><i class="lc-swatch lc-swatch--missing" aria-hidden="true"></i>Quality verified</span><strong>unknown</strong></li>' : '';
  return `<div class="lc-gauge" role="img" aria-label="Context measurements up to ${escAttr(fmtCtx(top))}">
      <span class="lc-gauge-track"></span>${verified}${knee}${ticks}${pin}
    </div>
    <div class="lc-gauge-scale"><span>${fmtCtx(low)}</span><span>${fmtCtx(top)}</span></div>
    <ul class="lc-legend">${legend}${qualityUnknown}</ul>`;
}

/**
 * Session growth sparkline: call time against session size, one dot per turn,
 * red where the answer was wrong. Drawn to one scale from the data.
 */
export function renderSessionCurve(curve) {
  const rows = (Array.isArray(curve) ? curve : []).filter(row => row.contextTokens > 0 && row.latencyMs > 0);
  if (rows.length < 2) return '';
  const W = 300; const H = 84; const L = 34; const B = 18; const T = 6; const R = 6;
  const maxX = Math.max(...rows.map(row => row.contextTokens));
  const maxY = Math.max(...rows.map(row => row.latencyMs));
  const x = v => L + (W - L - R) * v / maxX;
  const y = v => T + (H - T - B) * (1 - v / maxY);
  const path = rows.map((row, i) => `${i ? 'L' : 'M'}${x(row.contextTokens).toFixed(1)} ${y(row.latencyMs).toFixed(1)}`).join(' ');
  const dots = rows.map(row => `<circle cx="${x(row.contextTokens).toFixed(1)}" cy="${y(row.latencyMs).toFixed(1)}" r="2.6" class="${row.correct ? 'lc-dot' : 'lc-dot lc-dot--wrong'}"></circle>`).join('');
  const sec = v => `${Math.round(v / 1000)} s`;
  return `<figure class="lc-curve">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Call time as the session grows, up to ${fmtCtx(maxX)} and ${sec(maxY)}">
      <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="lc-axis"></line>
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="lc-axis"></line>
      <text x="${L - 4}" y="${T + 8}" text-anchor="end">${sec(maxY)}</text>
      <text x="${L - 4}" y="${H - B}" text-anchor="end">0</text>
      <text x="${W - R}" y="${H - 4}" text-anchor="end">${fmtCtx(maxX)}</text>
      <text x="${L}" y="${H - 4}">session size</text>
      <path d="${path}" class="lc-line"></path>${dots}
    </svg>
    <figcaption>Call time as one agent session grows${rows.some(row => !row.correct) ? '; red dots are wrong answers' : ''}.</figcaption>
  </figure>`;
}

function renderConcurrency(concurrency) {
  const messages = {
    not_measured: 'Not measured yet (Full profile).',
    no_co_resident: 'No other model was resident on this endpoint when measured.',
    not_resident: 'Not measured: the model was not resident.',
    inventory_unavailable: 'Not measured: resident models could not be read.',
    unmeasured: 'Not measured: every pair reloaded or failed.'
  };
  if (concurrency?.status === 'evicted') {
    return '<p class="lc-concurrency is-bad">Does not stay loaded together with a co-resident model: one evicts the other.</p>';
  }
  if (concurrency?.status !== 'measured') {
    return `<p class="lc-concurrency is-dim">${escAttr(messages[concurrency?.status] || messages.not_measured)}</p>`;
  }
  const rows = (concurrency.pairs || []).filter(pair => pair.status === 'measured').map(pair =>
    `<li><span>with ${escAttr(pair.model)}</span><strong>${Math.round(pair.selfSlowdownPct ?? 0)} % slower</strong><span class="lc-concurrency-other">it slows ${Math.round(pair.otherSlowdownPct ?? 0)} %</span></li>`).join('');
  return `<ul class="lc-concurrency-list">${rows}</ul>`;
}

function renderRemeasure(remeasure) {
  if (!remeasure?.needed) return '';
  return `<div class="lc-proposal" role="note">
    <strong><i class="fas fa-rotate" aria-hidden="true"></i> Re-measurement proposed</strong>
    <ul>${(remeasure.reasons || []).map(reason => `<li>${escAttr(reason.text || reason.code)}</li>`).join('')}</ul>
  </div>`;
}

function renderAgentBlock(agent) {
  if (agent?.status !== 'measured') {
    return `<section class="lc-block" aria-label="Agent work"><h4>Agent work</h4>
      <p class="lc-empty">Not measured yet. A Full profile measures a growing session, structured output, verification and tool turns.</p></section>`;
  }
  const tools = `${agent.reliableToolTurns} turns${agent.toolChecksTotal ? ` · ${agent.toolChecksCorrect}/${agent.toolChecksTotal} right` : ''}`;
  return `<section class="lc-block" aria-label="Agent work"><h4>Agent work</h4>
    <dl class="lc-speed lc-agent">
      <div class="lc-agent-step"><dt>Recommended step</dt><dd>${fmtCtx(agent.recommendedStepContext)}</dd></div>
      <div><dt>Tool calls</dt><dd>${escAttr(tools)}</dd></div>
      <div><dt>Structured output</dt><dd>${agent.reliableOutputTokens ? `${fmtCtx(agent.reliableOutputTokens)} tok` : '—'}</dd></div>
      <div><dt>Finds mismatches up to</dt><dd>${fmtCtx(agent.verificationVerifiedContext)}</dd></div>
    </dl>
    ${renderSessionCurve(agent.sessionCurve)}
  </section>`;
}

export function laneWarnings(lane) {
  const c = lane?.capability?.context || {};
  const warnings = [];
  if (Number(lane?.pinContext) > 0 && Number(c.knee) > 0 && lane.pinContext > c.knee) {
    warnings.push(`The runtime window (${fmtCtx(lane.pinContext)}) is past the speed knee (${fmtCtx(c.knee)}). A long agent session on this lane slows down as its context grows; size work steps below the knee.`);
  }
  if (Number(lane?.pinContext) > 0 && Number(c.max) > 0 && lane.pinContext > c.max) {
    warnings.push(`The runtime window (${fmtCtx(lane.pinContext)}) is larger than the verified maximum (${fmtCtx(c.max)}).`);
  }
  return warnings;
}

export function renderLaneCard(lane, index = 0) {
  const cap = lane?.capability || {};
  const t = cap.throughput || {};
  const gaps = Array.isArray(cap.gaps) ? cap.gaps : [];
  const tasks = (lane.tasks || []).map(task => `<span class="lc-chip">${escAttr(taskLabel(task))}</span>`).join('');
  const pinned = lane.pinned ? '<span class="lc-chip lc-chip--pin" title="Pinned resident on this host">Pinned</span>' : '';
  const warnings = laneWarnings(lane).map(text => `<p class="lc-warning" role="note"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ${escAttr(text)}</p>`).join('');
  const prefill = (t.longPrefill || []).length
    ? `<table class="lc-prefill"><caption>Reading long prompts</caption><thead><tr><th scope="col">Context</th><th scope="col">Read speed</th><th scope="col">First token</th></tr></thead><tbody>${t.longPrefill.map(row =>
      `<tr><td>${fmtCtx(row.numCtx)}</td><td>${fmtRate(row.promptTokensPerSec)}</td><td>${fmtMs(row.ttftMs)}</td></tr>`).join('')}</tbody></table>`
    : '';
  const gapList = gaps.length
    ? `<details class="lc-gaps"><summary>${gaps.length} missing ${gaps.length === 1 ? 'measurement' : 'measurements'}</summary><ul>${gaps.map(gap =>
      `<li>${escAttr(gap.text || gap.code)}</li>`).join('')}</ul></details>`
    : '<p class="lc-complete">All capability measurements are present.</p>';
  const canQueue = Boolean(cap.hostId && cap.model);
  const open = measurementOpen(lane.measurement);
  const provenance = cap.provenance || {};
  return `<article class="lc-card" data-lane-index="${index}">
    <header class="lc-card-head">
      <div class="lc-card-title">
        <h3 class="lc-model" title="${escAttr(cap.model || lane.model)}">${escAttr(cap.model || lane.model || 'Unknown model')}</h3>
        <p class="lc-host">${escAttr(lane.hostName || cap.hostUrl || '')}${lane.residency === 'cpu' ? ' · CPU' : ''}</p>
      </div>
      <div class="lc-chips">${pinned}${tasks}</div>
    </header>
    <div class="lc-readiness" aria-label="Readiness">
      ${readinessPill('Chat', cap.readiness?.chat)}${readinessPill('Documents', cap.readiness?.documents)}${readinessPill('Coding agent', cap.readiness?.codingAgent)}
    </div>
    ${warnings}
    ${renderRemeasure(cap.remeasure)}
    <section class="lc-block" aria-label="Context">
      <h4>Context</h4>
      ${renderContextGauge(cap, lane.pinContext)}
    </section>
    <section class="lc-block" aria-label="Speed">
      <h4>Speed</h4>
      <dl class="lc-speed">
        <div><dt>Writing</dt><dd>${fmtRate(t.generationTokensPerSec)}</dd></div>
        <div><dt>Reading</dt><dd>${fmtRate(t.promptTokensPerSec)}</dd></div>
        <div><dt>First token</dt><dd>${fmtMs(t.ttftP50Ms)}</dd></div>
        <div><dt>Test context</dt><dd>${fmtCtx(t.measuredAtNumCtx)}</dd></div>
      </dl>
      ${prefill}
      <h4 class="lc-subhead">Answering beside co-resident models</h4>
      ${renderConcurrency(cap.concurrency)}
    </section>
    ${renderAgentBlock(cap.agent)}
    <footer class="lc-card-foot">
      <p class="lc-provenance">${escAttr(ageText(provenance.ageDays))}${provenance.depth ? ` · ${escAttr(provenance.depth)} profile` : ''}</p>
      ${gapList}
      ${renderMeasurement(lane.measurement)}
      <div class="lc-actions">
        ${open ? '' : `<button type="button" class="lc-measure" data-lane-action="measure" data-lane-index="${index}"${canQueue ? ' title="Plans a Full profile tonight; Core starts it at its time"' : ' disabled title="The host of this lane is not configured in the Profiler"'}>
          <i class="fas fa-moon" aria-hidden="true"></i> Measure tonight
        </button>`}
        <span class="lc-action-status" role="status" aria-live="polite">${canQueue ? '' : 'This host is not configured in the Profiler, so it cannot be measured from here.'}</span>
      </div>
    </footer>
  </article>`;
}

export function renderLaneSummary(lanes) {
  const list = Array.isArray(lanes) ? lanes : [];
  const count = state => list.filter(lane => lane.capability?.readiness?.codingAgent === state).length;
  const unmeasured = list.filter(lane => lane.capability?.agent?.status !== 'measured').length;
  const proposed = list.filter(lane => lane.capability?.remeasure?.needed).length;
  const knee = list.filter(lane => laneWarnings(lane).length).length;
  const quality = list.filter(lane => lane.capability?.quality?.status !== 'verified').length;
  return `<span class="lc-summary-item"><strong>${list.length}</strong> ${list.length === 1 ? 'lane' : 'lanes'}</span>
    <span class="lc-summary-item${knee ? ' is-warn' : ''}"><strong>${knee}</strong> past the speed knee</span>
    <span class="lc-summary-item${quality ? ' is-warn' : ''}"><strong>${quality}</strong> without verified quality</span>
    <span class="lc-summary-item${count('not_measured') ? ' is-dim' : ''}"><strong>${count('ready')}</strong> ready for coding agents</span>
    <span class="lc-summary-item${unmeasured ? ' is-dim' : ''}"><strong>${unmeasured}</strong> without agent measurements</span>
    <span class="lc-summary-item${proposed ? ' is-warn' : ''}"><strong>${proposed}</strong> ${proposed === 1 ? 're-measurement' : 're-measurements'} proposed</span>`;
}

/**
 * Night window for a Full profile of one lane, in the browser's time zone.
 * The Benchmark server builds the queue request itself for a current lane;
 * recording it starts nothing, and the owner still reserves it.
 */
export function buildMeasureRequest(lane, now = new Date()) {
  const cap = lane?.capability || {};
  if (!cap.hostId || !cap.model || !cap.hostUrl) throw new Error('This lane has no configured Profiler host');
  const start = new Date(now);
  start.setHours(23, 0, 0, 0);
  if (start <= now) start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(6, 0, 0, 0);
  return { model: cap.model, hostUrl: cap.hostUrl, notBefore: start.toISOString(), startBefore: end.toISOString() };
}

/** Lanes the night campaign measures: those with a re-measurement proposal. */
export function campaignTargets(lanes) {
  return (Array.isArray(lanes) ? lanes : []).filter(lane => lane.capability?.hostId && lane.capability.remeasure?.needed === true);
}

export function campaignText(targets) {
  if (!targets.length) return 'No lane needs re-measurement: every lane has a current Full profile for its installed model and runtime.';
  const hosts = new Set(targets.map(lane => lane.hostName || lane.capability.hostId));
  return `Measure ${targets.length} ${targets.length === 1 ? 'lane' : 'lanes'} tonight, 23:00 to 06:00, `
    + `on ${hosts.size} ${hosts.size === 1 ? 'host' : 'hosts'}: the lanes with a re-measurement proposal. `
    + 'A Full profile takes about three hours.';
}

// Core's public URL (the page passes it); Automations lives in Core.
let coreBase = '';
export function setCoreBase(url) { coreBase = String(url || '').replace(/\/+$/, ''); }
export const calendarUrl = () => `${coreBase}/automations?view=calendar`;

export function clock(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const calendarLink = label => `<a href="${escAttr(calendarUrl())}">${escAttr(label)}</a>`;

/** One line on the card: where this lane's measurement request stands. */
export function renderMeasurement(m) {
  if (!m) return '';
  const span = m.start ? `${clock(m.start)}–${clock(m.end)}` : '';
  const views = {
    requested: ['wait', 'fa-hourglass-half', `Requested, no slot yet. ${calendarLink('Plan it in Automations → Calendar')}.`],
    reserved: m.autoStart
      ? ['planned', 'fa-calendar-check', `Planned ${span}; starts automatically. ${calendarLink('See it in the calendar')}.`]
      : ['wait', 'fa-calendar', `Planned ${span}; start it yourself then from ${calendarLink('Automations → Calendar')}.`],
    dispatching: ['running', 'fa-spinner', 'Starting now.'],
    running: ['running', 'fa-wave-square', `Measuring now${m.end ? `, about until ${clock(m.end)}` : ''}.`],
    uncertain: ['bad', 'fa-circle-question', `Launch outcome unknown; it will not be retried. ${calendarLink('Check it in Automations')}.`],
    completed: ['done', 'fa-circle-check', `Measured${m.finishedAt ? ` ${escAttr(new Date(m.finishedAt).toLocaleDateString())}` : ''}. Refresh to read the new values.`],
    failed: ['bad', 'fa-circle-xmark', `The last measurement failed. ${calendarLink('Read its receipt')}.`],
    cancelled: ['wait', 'fa-ban', 'The last measurement request was cancelled.']
  };
  const [tone, icon, text] = views[m.state] || ['wait', 'fa-circle-info', escAttr(m.state)];
  return `<p class="lc-measurement lc-measurement--${tone}" role="note"><i class="fas ${icon}" aria-hidden="true"></i> <span>${text}</span></p>`;
}

/** Whether the lane already has a request waiting, planned or running. */
export function measurementOpen(m) {
  return Boolean(m) && ['requested', 'reserved', 'dispatching', 'running', 'uncertain'].includes(m.state);
}

/** The night plan, before anything is recorded. */
export function renderCampaignPlan(plan, targets = []) {
  const slots = Array.isArray(plan?.slots) ? plan.slots : [];
  if (!slots.length) return '';
  const name = slot => targets.find(lane => lane.capability?.hostId === slot.hostId && lane.capability?.model === slot.model)?.hostName || slot.hostName || slot.hostId;
  const late = slots.filter(slot => !slot.fits).length;
  const machines = Array.isArray(plan.machines) ? plan.machines : [];
  const lastEnd = slots.filter(slot => slot.fits).reduce((last, slot) => (slot.end > last ? slot.end : last), '');
  const summary = late
    ? `<p class="lc-plan-note is-warn" role="note"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ${late} of ${slots.length} would end after ${clock(plan.windowEnd)}. They are recorded but not planned; choose another night for them in ${calendarLink('Automations → Calendar')}.</p>`
    : `<p class="lc-plan-note">${slots.length} ${slots.length === 1 ? 'lane' : 'lanes'} on ${machines.length} ${machines.length === 1 ? 'machine' : 'machines'}: one lane at a time per machine, machines in parallel. Done by about ${clock(lastEnd)}.</p>`;
  const rows = slots.map(slot => `<tr class="${slot.fits ? '' : 'is-late'}">
      <th scope="row"><span class="lc-plan-model">${escAttr(slot.model)}</span><span class="lc-plan-host">${escAttr(name(slot))}</span></th>
      <td>${escAttr(slot.machine)}</td>
      <td>${clock(slot.start)}–${clock(slot.end)}</td>
      <td>${slot.fits ? '<span class="lc-plan-fit">Fits</span>' : `<span class="lc-plan-late">Ends after ${clock(plan.windowEnd)}</span>`}</td>
    </tr>`).join('');
  return `${summary}
    <div class="lc-plan-scroll"><table class="lc-plan"><caption class="lc-sr">Night plan</caption>
      <thead><tr><th scope="col">Lane</th><th scope="col">Machine</th><th scope="col">Time</th><th scope="col">Window</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

/** What was recorded and planned, one line per lane. */
export function campaignResultText(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const failed = rows.filter(row => row.error).length;
  const unplanned = rows.filter(row => !row.error && !row.planned).length;
  const head = result.autoStart
    ? `${result.planned} planned; Core starts each one at its time.`
    : `${result.planned} planned; start each from Automations → Calendar at its time.`;
  return [head, unplanned ? `${unplanned} recorded without a slot.` : '', failed ? `${failed} not recorded.` : ''].filter(Boolean).join(' ');
}
