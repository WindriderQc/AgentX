// public/js/model-profiler/components/lane-capability.js
/**
 * Lane capability cards (#832): what each pinned or routed model is ready for
 * on its host, read from existing Profiler evidence. Rendering is pure; the
 * only action builds a heavy-work queue request and never starts a model.
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
    </section>
    <footer class="lc-card-foot">
      <p class="lc-provenance">${escAttr(ageText(provenance.ageDays))}${provenance.depth ? ` · ${escAttr(provenance.depth)} profile` : ''}</p>
      ${gapList}
      <div class="lc-actions">
        <button type="button" class="lc-measure" data-lane-action="measure" data-lane-index="${index}"${canQueue ? '' : ' disabled title="The host of this lane is not configured in the Profiler"'}>
          <i class="fas fa-moon" aria-hidden="true"></i> Measure tonight
        </button>
        <span class="lc-action-status" role="status" aria-live="polite">${canQueue ? '' : 'This host is not configured in the Profiler, so it cannot be measured from here.'}</span>
      </div>
    </footer>
  </article>`;
}

export function renderLaneSummary(lanes) {
  const list = Array.isArray(lanes) ? lanes : [];
  const count = state => list.filter(lane => lane.capability?.readiness?.codingAgent === state).length;
  const knee = list.filter(lane => laneWarnings(lane).length).length;
  const quality = list.filter(lane => lane.capability?.quality?.status !== 'verified').length;
  return `<span class="lc-summary-item"><strong>${list.length}</strong> ${list.length === 1 ? 'lane' : 'lanes'}</span>
    <span class="lc-summary-item${knee ? ' is-warn' : ''}"><strong>${knee}</strong> past the speed knee</span>
    <span class="lc-summary-item${quality ? ' is-warn' : ''}"><strong>${quality}</strong> without verified quality</span>
    <span class="lc-summary-item${count('not_measured') ? ' is-dim' : ''}"><strong>${count('ready')}</strong> ready for coding agents</span>`;
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
