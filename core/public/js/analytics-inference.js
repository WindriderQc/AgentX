/**
 * Platform Inference panel.
 *
 * Reads /api/analytics/inference/summary — the `inferencelogs` collection —
 * rather than `conversations`, which only the chat UI writes.
 *
 * Series colours are the validated dark-mode categorical palette (adjacent-pair
 * CVD dE 8.4, normal-vision 19.3 on this surface). Fixed order, never cycled:
 * a caller keeps its colour when the filter changes the series count.
 */

import { averageSignal, buildSignal, formatSignal, parseSignal } from '/dist/signal-evidence.js';

const $ = (id) => document.getElementById(id);

function compact(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function ms(n) {
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

/**
 * Render one Signal Evidence Contract signal into a tile value. The text is
 * the measured value or the shared placeholder; the state travels on data
 * attributes so the cockpit summary and tests can read it, and the optional
 * note carries the human label (`Not observed`, `Low sample`, …).
 */
function renderSignal(id, signal, noteId) {
  const view = formatSignal(signal);
  const el = $(id);
  if (el) {
    el.textContent = view.text;
    el.dataset.signalState = view.state;
    el.dataset.signalTone = view.tone;
    el.dataset.signalSample = view.sample;
    el.title = view.detail;
  }
  const note = noteId ? $(noteId) : null;
  if (note) note.textContent = view.label ? ` · ${view.label}` : '';
  return view;
}

/**
 * Prefer the server-attested signals; derive them from the raw totals only
 * when an older payload carries none, so n=0 never renders as "0ms".
 */
function classifierSignals(d) {
  const t = d.totals || {};
  const signals = d.signals || {};
  const n = t.classifiedCalls || 0;
  return {
    avg: parseSignal(signals.avgClassificationMs) || averageSignal({
      id: 'analytics.inference.avg_classification_ms',
      sum: (t.avgClassificationMs || 0) * n, count: n, unit: 'ms'
    }),
    total: parseSignal(signals.avgTotalForClassifiedMs) || averageSignal({
      id: 'analytics.inference.avg_total_for_classified_ms',
      sum: (t.avgTotalForClassifiedMs || 0) * n, count: n, unit: 'ms'
    }),
    overhead: parseSignal(signals.classificationOverheadPct) || buildSignal({
      id: 'analytics.inference.classification_overhead_pct',
      state: n > 0 && Number.isFinite(t.classificationOverheadPct) ? 'observed' : 'missing',
      value: n > 0 && Number.isFinite(t.classificationOverheadPct) ? t.classificationOverheadPct : null,
      unit: 'percent',
      sample: { n }
    })
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[char]);
}

async function fetchSummary(windowKey) {
  const res = await fetch(`/api/analytics/inference/summary?window=${encodeURIComponent(windowKey)}`, {
    headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.ok === false || !body.data) throw new Error(body?.message || 'Malformed response');
  return body.data;
}

function renderTiles(d) {
  const t = d.totals || {};
  // The full scope sentence lives in the tooltip; the hint stays short.
  if ($('infScope') && d.scope) $('infScope').title = d.scope;
  setText('infScope', 'Recorded AgentX calls');
  setText('infCalls', compact(t.calls));
  setText('infCallsPerDay', compact(t.callsPerDay));
  setText('infTokensOut', compact(t.tokensOut));
  setText('infTokensIn', compact(t.tokensIn));
  const observed = Number(t.calls) > 0;
  setText('infErrorRate', observed ? `${(t.errorRate ?? 0).toFixed(2)}%` : '—');
  setText('infErrors', compact(t.errors));
  setText('infCancellations', compact(t.cancellations));
  setText('infHours', `${(t.inferenceHours ?? 0).toFixed(1)}h`);
  setText('infTokPerSec', observed ? (t.tokensOutPerSecond ?? 0).toFixed(1) : '—');

  setText('infFallbackRate', observed ? `${(t.fallbackRate ?? 0).toFixed(2)}%` : '—');
  setText('infFallbacks', compact(t.fallbackCalls));
  setText('infAvgLatency', observed ? ms(t.avgLatencyMs) : '—');
  const classifier = classifierSignals(d);
  renderSignal('infAvgClassification', classifier.avg, 'infAvgClassificationNote');
  setText('infClassifiedCalls', compact(t.classifiedCalls ?? 0));
  renderSignal('infClassificationPct', classifier.overhead, 'infClassificationPctNote');
  const totalView = formatSignal(classifier.total);
  setText('infClassifiedTotal', totalView.text);
  // Only Playground auto-routing classifies; with no classified call the
  // tile would hold nothing but "Not observed".
  const classifierChip = $('infClassifierChip');
  if (classifierChip) classifierChip.hidden = !(Number(t.classifiedCalls) > 0);

  const degraded = (d.byDegraded || []).find(row => row.degraded === true || row.degraded === 'true');
  setText('infDegraded', observed ? compact(degraded?.calls || 0) : '—');
  setText('infDegradedNote', degraded?.calls
    ? `${(degraded.errorRate || 0).toFixed(1)}% of them failed`
    : observed ? 'none in this period' : '—');

  const errorLink = $('infErrorLink');
  if (errorLink) {
    const params = new URLSearchParams({ status: 'error,timeout' });
    if (d.window?.from) params.set('from', new Date(d.window.from).toISOString());
    if (d.window?.to) params.set('to', new Date(d.window.to).toISOString());
    errorLink.href = `/api/analytics/inference/logs?${params.toString()}`;
  }

  const errEl = $('infErrorRate');
  if (errEl) errEl.style.color = t.errorRate > 5 ? '#f87171' : t.errorRate > 1 ? '#f59e0b' : 'inherit';

  const local = d.local || {};
  setText('infLocalHours', `${(local.inferenceHours ?? 0).toFixed(1)}h`);
  setText('infLocalCalls', compact(local.calls));

  const cloud = d.cloud || {};
  // null means "no resolvable price", which is not the same as zero spend.
  setText('infCloudSpend', Number.isFinite(cloud.estimatedCostUsd)
    ? `$${cloud.estimatedCostUsd.toFixed(4)}`
    : (cloud.calls ? 'unpriced' : '$0.00'));
  setText('infCloudNote', cloud.calls
    ? `${compact(cloud.calls)} cloud calls${cloud.unpricedModels?.length ? ` · ${cloud.unpricedModels.length} unpriced` : ''}`
    : 'no cloud-routed calls');
}

// Producers that send no value (explicit-model clients send no task type;
// some callers send no contract) are "not declared", not a real category.
function dimensionLabel(value) {
  if (value == null || value === '' || value === 'unknown') return 'not declared';
  return String(value).replace(/_/g, ' ');
}

function errorTone(rate) {
  return rate > 5 ? 'is-bad' : rate > 1 ? 'is-warn' : '';
}

/**
 * One compact bar list per dimension: the top five values by calls, then
 * "all others". The bar is the share of all recorded calls in the window.
 */
function dimensionRows(rows, key, total, limit = 5) {
  const sorted = [...rows].sort((a, b) => (b.calls || 0) - (a.calls || 0));
  const shown = sorted.slice(0, limit).map(row => ({
    label: dimensionLabel(row[key]), calls: row.calls || 0,
    errorRate: row.errorRate || 0, cancellationRate: row.cancellationRate || 0,
    undeclared: dimensionLabel(row[key]) === 'not declared'
  }));
  const rest = sorted.slice(limit);
  if (rest.length) {
    const calls = rest.reduce((sum, row) => sum + (row.calls || 0), 0);
    const errors = rest.reduce((sum, row) => sum + (row.calls || 0) * (row.errorRate || 0) / 100, 0);
    shown.push({ label: `${rest.length} others`, calls, errorRate: calls > 0 ? errors / calls * 100 : 0, cancellationRate: null, other: true });
  }
  return shown.map(row => ({ ...row, share: total > 0 ? row.calls / total * 100 : 0 }));
}

function renderDimensionBreakdowns(d) {
  const container = $('infDimensionBreakdowns');
  if (!container) return;
  const total = d.totals?.calls || 0;
  const dimensions = [
    ['Caller', d.byCaller || [], 'caller'],
    ['Consumer contract', d.byConsumerContract || [], 'consumerContract'],
    ['Task type', d.byTaskType || [], 'taskType'],
  ];
  container.innerHTML = dimensions.map(([title, rows, key]) => `<div class="wb-dim">
      <h4>${title}</h4>
      ${rows.length ? dimensionRows(rows, key, total).map(row => `<div class="wb-bar${row.other ? ' is-other' : ''}${row.undeclared ? ' is-undeclared' : ''}" title="${escapeHtml(`${row.label}: ${row.calls.toLocaleString('en-US')} calls · ${row.errorRate.toFixed(1)}% errors${row.cancellationRate == null ? '' : ` · ${row.cancellationRate.toFixed(1)}% canceled`}`)}">
        <span class="wb-bar-name" style="--share:${Math.max(0, Math.min(100, row.share)).toFixed(1)}%"><span>${escapeHtml(row.label)}</span></span>
        <span class="wb-bar-calls">${compact(row.calls)}</span>
        <span class="wb-bar-err ${errorTone(row.errorRate)}">${row.errorRate.toFixed(1)}%</span>
      </div>`).join('') : '<p class="wb-empty">No data</p>'}
    </div>`).join('');
}

// AgentX may label a cloud route through the local OpenClaw gateway
// (openclaw:model:openrouter/...); the provider prefix still makes it cloud.
const CLOUD_ROUTE = /(^|[:/])(openrouter|openai|anthropic|gemini|groq|mistral|together|deepseek-api)\//i;
function isCloudModel(m) {
  return Boolean(m.isCloud) || CLOUD_ROUTE.test(String(m.model || ''));
}

function renderModelTable(d) {
  const body = $('infModelTableBody');
  if (!body) return;
  const rows = d.byModel || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="wb-empty">No inference recorded in this window.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((m) => {
    const cloud = isCloudModel(m);
    const where = cloud
      ? `<span class="wb-tag wb-tag-cloud">cloud${Number.isFinite(m.estimatedCostUsd) ? ` · $${m.estimatedCostUsd.toFixed(4)}` : ' · unpriced'}</span>`
      : '<span class="wb-tag">local</span>';
    // Embedding models produce no output tokens: throughput does not apply.
    const embedding = !(m.tokensOut > 0);
    const tokPerSec = embedding ? '<span class="wb-muted" title="No output tokens (embedding or failed calls)">n/a</span>'
      : Number.isFinite(m.tokensOutPerSecond) ? m.tokensOutPerSecond.toFixed(1) : '—';
    return `<tr>
      <td class="wb-model" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</td>
      <td>${compact(m.calls)}</td>
      <td><span class="${errorTone(m.errorRate)}">${(m.errorRate || 0).toFixed(1)}%</span> <span class="wb-muted">· ${(m.cancellationRate || 0).toFixed(1)}%</span></td>
      <td>${embedding ? '<span class="wb-muted">—</span>' : compact(m.tokensOut)}</td>
      <td>${ms(m.avgLatencyMs)}</td>
      <td>${tokPerSec}</td>
      <td>${where}</td>
    </tr>`;
  }).join('');
}

/**
 * Codex entitlement. The federated endpoint has always computed this block;
 * the page simply never rendered it.
 */
async function renderCodex(windowKey) {
  const version = loadVersion;
  const section = $('infCodexSection');
  if (!section) return;
  // Federated provider/Codex telemetry is intentionally outside the
  // product-safe demo profile; do not probe a route the profile rejects.
  if (document.body.dataset.agentxProfile === 'demo') {
    section.style.display = 'none';
    return;
  }
  try {
    const res = await fetch(`/api/analytics/federated?window=${encodeURIComponent(windowKey === 'usage' ? '24h' : windowKey)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    if (version !== loadVersion) return;
    if (!res.ok) { section.style.display = 'none'; return; }
    const body = await res.json();
    if (version !== loadVersion) return;
    const c = body?.codexSubscription;
    if (!c || !c.available) { section.style.display = 'none'; return; }

    section.style.display = '';
    setText('infCodexPlan', c.plan?.name
      ? `${c.plan.name}${Number.isFinite(c.plan.monthlyCostUsd) ? ` · $${c.plan.monthlyCostUsd}/mo` : ''}`
      : '—');

    const used = c.quota?.primary?.usedPercent;
    setText('infCodexQuota', Number.isFinite(used) ? `${used}%` : '—');
    const resetMs = c.quota?.primary?.resetsAtMs;
    setText('infCodexReset', Number.isFinite(resetMs)
      ? `resets ${new Date(resetMs).toLocaleDateString()}`
      : 'no reset reported');

    setText('infCodexTokens', compact(c.currentMonth?.totalTokens));
    setText('infCodexSessions', compact(c.currentMonth?.sessions));
    setText('infCodexCached', Number.isFinite(c.cachedInputPct) ? `${c.cachedInputPct.toFixed(1)}%` : '—');
    const rateKnown = Number.isFinite(c.effectiveCostPer1MTokensUsd);
    setText('infCodexRate', rateKnown ? `$${c.effectiveCostPer1MTokensUsd.toFixed(4)}` : '—');
    if ($('infCodexRateChip')) $('infCodexRateChip').hidden = !rateKnown;
    setText('infCodexMessage', c.valueMessage || '');
  } catch (err) {
    if (version !== loadVersion) return;
    section.style.display = 'none';
    console.error('Codex entitlement fetch failed:', err);
  }
}

/**
 * The chat-lane widgets (usage, feedback, RAG adoption, all four cost panels)
 * read `conversations`, which only POST /api/chat and /api/chat/stream write.
 * On a fleet driven by agents, proxies and pipelines that collection is empty,
 * so those six sections rendered as a wall of "No data" and zeros that looked
 * like a broken page rather than an unused feature.
 *
 * Collapse them to a single honest line when the window holds no conversations,
 * with an opt-in to show them anyway. They come back automatically the moment
 * someone uses the chat UI.
 */
let chatLoadVersion = 0;
let chatLaneForced = false;

function setChatLaneVisible(visible) {
  document.querySelectorAll('.chat-lane').forEach((el) => {
    el.style.display = visible ? '' : 'none';
  });
}

function showChatLane() {
  chatLaneForced = true;
  ++chatLoadVersion;
  setChatLaneVisible(true);
  if ($('chatLaneHeading')) $('chatLaneHeading').style.display = '';
  if ($('chatLaneEmptyNote')) $('chatLaneEmptyNote').style.display = 'none';
}

async function applyChatLaneCollapse() {
  const version = ++chatLoadVersion;
  const note = $('chatLaneEmptyNote');
  const heading = $('chatLaneHeading');
  if (!note || chatLaneForced) return;

  const select = $('analyticsWindow');
  const since = Date.parse(select?.dataset.usageSince || '');
  const to = new Date();
  const from = select?.value === 'usage' && Number.isFinite(since)
    ? new Date(since)
    : new Date(to.getTime() - ({ '24h': 1, '7d': 7, '30d': 30 }[select?.value] || 1) * 86400000);
  const days = (to - from) / 86400000;

  let conversations = null;
  try {
    const res = await fetch(`/api/analytics/usage?from=${from.toISOString()}&to=${to.toISOString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    if (res.ok) {
      const body = await res.json();
      const d = body?.data || body;
      conversations = Number.isFinite(d?.totalConversations) ? d.totalConversations : null;
    }
  } catch (err) {
    console.error('Chat-lane probe failed:', err);
  }

  if (version !== chatLoadVersion) return;
  // Unknown (probe failed) is not the same as zero — leave the widgets alone.
  if (conversations === null || conversations > 0) {
    note.style.display = 'none';
    setChatLaneVisible(true);
    if (heading) heading.style.display = '';
    return;
  }

  setChatLaneVisible(false);
  if (heading) heading.style.display = 'none';
  note.style.display = '';
  note.innerHTML = `<strong>No conversations in the ${days <= 1 ? 'last 24 hours' : `last ${Math.round(days)} days`}.</strong>
    The conversation and cost panels read the <code>conversations</code> collection;
    agent, pipeline and proxy traffic is in Platform inference above.
    <a href="#" id="chatLaneShowAnyway" style="color: var(--accent);">Show them anyway</a>.`;

  const link = $('chatLaneShowAnyway');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showChatLane();
    });
  }
}

let loadVersion = 0;
async function load() {
  const version = ++loadVersion;
  const windowKey = $('analyticsWindow')?.value || '24h';
  setText('analytics-period-badge', $('analyticsWindow')?.selectedOptions?.[0]?.textContent || 'selected period');
  document.dispatchEvent(new CustomEvent('analytics:inference', { detail: { state: 'loading', windowKey } }));
  try {
    const data = await fetchSummary(windowKey);
    if (version !== loadVersion) return;
    document.dispatchEvent(new CustomEvent('analytics:inference', { detail: { state: 'ready', data, windowKey } }));
    renderTiles(data);
    renderModelTable(data);
    renderDimensionBreakdowns(data);
  } catch (err) {
    if (version !== loadVersion) return;
    document.dispatchEvent(new CustomEvent('analytics:inference', { detail: { state: 'error', windowKey } }));
    console.error('Inference analytics failed:', err);
    ['infCalls', 'infCallsPerDay', 'infTokensOut', 'infTokensIn', 'infErrorRate', 'infErrors', 'infCancellations',
      'infHours', 'infTokPerSec', 'infFallbackRate', 'infFallbacks', 'infAvgLatency', 'infLocalHours', 'infLocalCalls', 'infCloudSpend'].forEach((id) => setText(id, '—'));
    setText('infScope', `Could not load inference analytics: ${err.message}`);
  }
  if (version !== loadVersion) return;
  const gate = window.AgentXAnalyticsCockpit?.whenOpen || ((_key, run) => run());
  gate('codex', () => renderCodex(windowKey));
  gate('chatLane', applyChatLaneCollapse);
}

function init() {
  $('infRefreshBtn')?.addEventListener('click', load);
  // load() also re-probes the chat lane for the new Period.
  $('analyticsWindow')?.addEventListener('change', load);
  $('refreshBtn')?.addEventListener('click', applyChatLaneCollapse);
  document.addEventListener('analytics:show-chat-lane', showChatLane);
  initializePeriod().then(load);
}

async function initializePeriod() {
  const select = $('analyticsWindow');
  const requested = new URLSearchParams(location.search).get('window');
  try {
    const res = await fetch('/api/analytics/inference/usage-period', {
      headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error('Reporting period unavailable');
    if (body.data?.since) {
      const since = new Date(body.data.since);
      if (!Number.isFinite(+since)) throw new Error('Invalid reporting period');
      select.add(new Option('Since daily use began', 'usage'), 0);
      select.value = 'usage';
      // Every detail panel reads this boundary so "since" never means 24 hours.
      select.dataset.usageSince = since.toISOString();
      setText('ao-period-note', `Daily use began ${since.toLocaleString()}. Earlier activity remains in the rolling periods. This period includes all recorded traffic.`);
    }
  } catch {
    setText('ao-period-note', 'Daily-use reporting boundary unavailable. Showing a rolling period.');
  }
  if ([...select.options].some(option => option.value === requested)) select.value = requested;
  // Detail panels wait for this before their first read.
  window.AgentXAnalyticsPeriodReady = true;
  document.dispatchEvent(new Event('analytics:period-ready'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
