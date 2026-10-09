// combined-board.js — Compact model index + complete model evidence sheet.
//
// One row per model and host: rank, score, category profile, speed and any
// coverage gap. Opening a row shows the complete sheet: the headline cohort
// the server selected and why, its verdict, provenance, the score with its
// parts, labelled figures and the history of the other cohorts. Ranked rows
// come first; rows judged on other terms follow in a closed disclosure. This
// is presentation-only; ranking and routing contracts stay upstream.

import { getReadinessMap, getBadgeHtml } from '../model-profiler/components/readiness-cache.js';
import { speedometer, formatMs, valColor, shortHost } from './unified-board.js';
import { scoreColor } from '../components/score-color.js';
import {
  authorityReasons, collectReasonCodes, coverageGaps, describeHeadline, graderSummary, humanizeReason,
  isAuthoritative, isComparable, isPartialCoverage, reasonLabel, reasonLegendHtml, verdictReasons
} from './verdict.js';
import { historyHtml, metricsHtml, promptCoverageText, provenanceHtml, scorePartsText, successText, SUCCESS_DEFINITION } from './cohort-history.js';
import { buildCsvFromGroups, csvFilename, downloadCsv } from './leaderboard-csv.js';
import { CATEGORY_KEYS, BENCHMARK_CATEGORY_META } from '../benchmark-categories.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEDAL = ['🥇', '🥈', '🥉'];
const RANK_CLASS = ['r1', 'r2', 'r3'];

const CATEGORY_META = Object.fromEntries(CATEGORY_KEYS.map(key =>
  [key, { icon: BENCHMARK_CATEGORY_META[key].emoji, label: BENCHMARK_CATEGORY_META[key].label }]));
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function scoreClass(score) {
  if (score == null || !Number.isFinite(Number(score))) return '';
  if (score > 8) return 'h';
  if (score > 6) return 'm';
  return 'l';
}

function entryKey(entry) {
  return `${entry.model || ''}::${entry.host || ''}`;
}

function categoryScore(entry, category) {
  const raw = entry.categoryScores?.[category];
  return raw !== null && raw !== undefined && Number.isFinite(Number(raw))
    ? Number(raw)
    : null;
}

function buildDimMap(dims) {
  const map = {};
  for (const d of (dims || [])) {
    if (d.yesRate !== null && d.yesRate !== undefined && Number.isFinite(Number(d.yesRate))) {
      map[d.name] = Number(d.yesRate);
    }
  }
  return map;
}

/** A flat entry passed where a group is expected becomes a one-cohort group. */
function asGroup(item) {
  if (item && item.headline) return item;
  return {
    key: `${item?.model || ''}@@${item?.host || ''}`,
    model: item?.model,
    host: item?.host || null,
    hostName: item?.hostName || null,
    rank: null,
    comparable: isComparable(item),
    verdict: item?.verdict || null,
    headline: item,
    headlineReason: null,
    history: [],
    cohortCount: 1
  };
}

// ---------------------------------------------------------------------------
// Champions
// ---------------------------------------------------------------------------

function renderChampionBadges(entry, championMap) {
  const champs = championMap.get(entryKey(entry)) || [];
  if (champs.length === 0) return '<span class="cb-no-badge">—</span>';
  return champs.map(({ icon, label, score }) => `
    <span class="cb-champ" title="Best in ${label} (${score.toFixed(1)} / 10)">
      <span>${icon}</span><span>${label}</span>
    </span>`).join('');
}

// ---------------------------------------------------------------------------
// Best / Watch lane pills
// ---------------------------------------------------------------------------

function categoryExtremes(entry) {
  const scores = CATEGORY_ORDER
    .map(category => ({
      category,
      meta: CATEGORY_META[category],
      score: categoryScore(entry, category)
    }))
    .filter(item => item.score !== null);
  if (scores.length === 0) return { best: null, watch: null };
  const sorted = scores.sort((a, b) => b.score - a.score);
  return { best: sorted[0], watch: sorted[sorted.length - 1] };
}

function renderLanePill(item, tone, label) {
  if (!item) return '';
  return `<span class="cb-lane cb-lane-${tone}" title="${item.meta.label}: ${item.score.toFixed(1)} / 10">
    <span class="cb-lane-tag">${label}</span>
    <span>${item.meta.icon}</span>
    <strong>${item.score.toFixed(1)}</strong>
  </span>`;
}

// ---------------------------------------------------------------------------
// Trend / cal
// ---------------------------------------------------------------------------

function renderTrend(trend) {
  if (!trend) return '';
  const { direction, delta } = trend;
  if (direction === 'new') return `<span class="cb-trend new">NEW</span>`;
  if (direction === 'up') {
    const d = delta != null ? `+${Number(delta).toFixed(1)}` : '';
    return `<span class="cb-trend up">▲ ${d}</span>`;
  }
  if (direction === 'dn' || direction === 'down') {
    const d = delta != null ? `-${Math.abs(Number(delta)).toFixed(1)}` : '';
    return `<span class="cb-trend dn">▼ ${d}</span>`;
  }
  return '';
}

function renderCalBadge(entry) {
  const count = entry.testCount || 0;
  const calibrated = entry.judgeCalibrated || false;
  if (count === 0) return '<span title="Insufficient data" style="color:var(--r-text-dim)">—</span>';
  if (calibrated && count >= 10) return '<span title="Calibrated judge, 10+ results" style="color:var(--r-good)">✓</span>';
  return '<span title="Uncalibrated judge or few results" style="color:var(--r-anomaly)">⚠</span>';
}

function confidenceClass(c) {
  if (c == null) return '';
  if (c <= 0.8) return 'good';
  if (c <= 1.4) return 'watch';
  return 'bad';
}

function compactCounts(counts, prefix = '') {
  const entries = Object.entries(counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]) || b[1] - a[1]);
  if (entries.length === 0) return '—';
  return entries.slice(0, 3)
    .map(([value, count]) => `${prefix}${value}:${count}`)
    .join(' ');
}

function playgroundUrl(entry) {
  if (entry?.executionTarget?.executionKind === 'harness' || entry?.host_available === false || !entry?.model) return null;
  const configuredCore = typeof document !== 'undefined' && typeof document.querySelector === 'function'
    ? document.querySelector('main[data-core-public-url]')?.dataset.corePublicUrl
    : null;
  if (!configuredCore) return null;
  try {
    const url = new URL('/playground', configuredCore);
    url.searchParams.set('model', entry.model);
    if (entry.host) url.searchParams.set('host', entry.host);
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Category bars (no dots — leaner version)
// ---------------------------------------------------------------------------

function categoryBars(dims, categoryEvidence = {}) {
  const dimMap = buildDimMap(dims);
  return CATEGORY_ORDER.map(cat => {
    const meta = CATEGORY_META[cat];
    const rate = dimMap[cat] ?? null;
    const pct = rate != null ? Math.round(rate * 100) : null;
    const clamped = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
    const score10 = rate != null ? rate * 10 : 0;
    const barColor = pct != null ? scoreColor(score10) : 'var(--r-border)';
    const valText = pct != null ? `${clamped}` : '—';
    const naCls = pct == null ? ' cb-bar-na' : '';
    const unavailableReason = categoryEvidence[cat] === 'review_pending'
      ? 'pending human review; provisional score withheld'
      : categoryEvidence[cat] === 'attempted_unscored'
        ? 'attempted; score unavailable'
        : 'not tested';
    const title = pct != null ? `${meta.label}: ${valText}%` : `${meta.label}: ${unavailableReason}`;
    return `<div class="cb-bar${naCls}" title="${title}">
      <span class="cb-bar-l">${meta.label}</span>
      <div class="cb-bar-track"><div class="cb-bar-fill" style="width:${clamped}%;background:${barColor}"></div></div>
      <span class="cb-bar-v">${valText}</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Timing column + speedometer
// ---------------------------------------------------------------------------

function timingColumn(entry) {
  const { avgLatency: avgLat, p95Latency: p95Lat, benchmarkTtft: ttft, hostTtft } = entry;
  const hasAny = avgLat != null || p95Lat != null || ttft != null || hostTtft != null;
  if (!hasAny) return '<div class="cb-no-data cb-timing-empty">No timing data</div>';

  const item = (label, val, good, warn, title) => `<div class="cb-time-item" title="${title}">
    <span class="cb-time-l">${label}</span>
    <span class="cb-time-v" style="color:${val != null ? valColor(val, good, warn) : 'var(--r-text-dim)'}">${formatMs(val)}</span>
  </div>`;

  return `<div class="cb-timing">
    ${item('latency mean', avgLat, 2000, 5000, 'Mean request latency')}
    ${item('latency p95', p95Lat, 4000, 8000, '95th-percentile request latency')}
    ${item('TTFT measured', ttft, 500, 2000, 'Measured streamed time to first token')}
    ${item('TTFT host baseline', hostTtft, 500, 2000, 'Warmed host baseline time to first token')}
  </div>`;
}

function speedoColumn(entry) {
  const tokPerSec = entry.tokPerSec;
  if (tokPerSec == null) return '<div class="cb-no-data cb-speedo-empty">No speed data</div>';
  const generation = entry.tokPerSecGen != null ? `${entry.tokPerSecGen} tok/s (generation)` : 'generation rate not recorded';
  return `<div class="cb-speedo" title="tok/s (total): output tokens over the whole request time, including prompt evaluation">${speedometer(tokPerSec, 100, {
    unit: 'tok/s (total)',
    size: 110,
    zones: [
      { pct: 0.15, color: '#ef5350' },
      { pct: 0.40, color: '#ffb74d' },
      { pct: 1.0,  color: '#4dd0e1' }
    ]
  })}<small class="cb-speedo-gen">${esc(generation)}</small></div>`;
}

// ---------------------------------------------------------------------------
// Compact row + complete model sheet
// ---------------------------------------------------------------------------

function detailKey(index) {
  return `model-detail-${index}`;
}

function compactCategoryStrip(entry) {
  return CATEGORY_ORDER.map(category => {
    const meta = CATEGORY_META[category];
    const score = categoryScore(entry, category);
    const pct = score == null ? 0 : Math.min(100, Math.max(0, score * 10));
    const state = score == null ? 'empty' : scoreClass(score);
    const value = score == null ? 'not scored' : `${score.toFixed(1)} / 10`;
    return `<span class="cb-spark ${state}" style="--spark-fill:${pct}%" title="${meta.label}: ${value}">
      <span class="cb-spark-fill"></span><span class="cb-spark-label">${meta.icon}</span>
    </span>`;
  }).join('');
}

/** "coverage −1.25 · hard-level −0.48": what separates the score from the quality. */
function scoreAdjustments(parts) {
  const terms = [
    ['coverage', -parts.coverage], ['hard-level', -parts.difficulty],
    ['evidence', -parts.evidence]
  ].filter(([, value]) => value).map(([label, value]) => `${label} −${Math.abs(value).toFixed(2)}`);
  return terms.length ? terms.join(' · ') : 'no adjustment';
}

/** "Thinking mode L4+ · 42/105 with thinking" — the mode behind a row, when thinking was used. */
function thinkingLabel(entry) {
  const thinking = entry?.thinking;
  if (!thinking || (!thinking.mode && !thinking.rows)) return '';
  const scope = thinking.mode ? `Thinking mode${thinking.minLevel ? ` L${thinking.minLevel}+` : ''}` : 'Thinking';
  return `${scope} · ${thinking.rows}/${entry.resultCount ?? entry.testCount ?? '?'} answers with thinking`;
}

function rowState(entry, comparable) {
  const notes = [];
  if (!comparable) {
    const reasons = verdictReasons(entry);
    notes.push(`Not ranked: ${reasons.length ? reasons.map(reasonLabel).join(', ') : 'no reason recorded'}`);
  } else {
    const authority = authorityReasons(entry);
    if (authority.length) notes.push(`Provisional rank: ${authority.map(reasonLabel).join(', ')}`);
    if (isPartialCoverage(entry)) {
      const gaps = coverageGaps(entry);
      notes.push(gaps ? `Partial coverage: missing ${gaps}` : 'Partial coverage');
    }
  }
  const thinking = thinkingLabel(entry);
  if (thinking) notes.push(thinking);
  if (entry.host_available === false) notes.push('deleted');
  return notes.join(' · ');
}

function renderDetailStat(label, value, { className = '', title = '', style = '' } = {}) {
  return `<div class="cb-detail-stat"${title ? ` title="${esc(title)}"` : ''}>
    <span class="cb-detail-stat-label">${label}</span>
    <strong class="cb-detail-stat-value ${className}"${style ? ` style="${style}"` : ''}>${value}</strong>
  </div>`;
}

function graderBlock(entry) {
  const lines = graderSummary(entry);
  if (!lines.length) return '';
  return `<div class="cb-grader"><strong>Grader</strong><ul>${lines.map(line => `<li>${esc(line)}</li>`).join('')}</ul></div>`;
}

function verdictBlock(entry, group, comparable) {
  const reasons = comparable ? authorityReasons(entry) : verdictReasons(entry);
  return `<div class="cb-row-verdict">
    <p class="cb-headline-why">${esc(describeHeadline(group))}</p>
    ${reasons.length ? `<ul class="cb-reasons">${reasons.map(code => `<li data-reason="${esc(code)}">${esc(humanizeReason(code))}</li>`).join('')}</ul>` : ''}
    ${graderBlock(entry)}
    ${provenanceHtml(entry)}
    <p class="cb-score-parts">${esc(scorePartsText(entry))}</p>
    ${entry.promptCoverage ? `<p class="cb-prompt-coverage">${esc(promptCoverageText(entry))}</p>` : ''}
    ${metricsHtml(entry)}
    ${historyHtml(group)}
  </div>`;
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

/**
 * One row. `options.group` carries the headline explanation and history;
 * `options.position` is the rank shown when the verdict is comparable and
 * `options.rankScope` says what it ranks: 'generalist' (the server's rank
 * across the whole board) or a category (position by that category's score).
 */
function renderRow(entry, index, championMap, readinessMap, { provisional = false, group = null, position = null, rankScope = 'generalist' } = {}) {
  const rowGroup = group || asGroup(entry);
  const comparable = rowGroup.comparable ?? isComparable(entry);
  const scopeLabel = rankScope !== 'generalist' ? (CATEGORY_META[rankScope]?.label || rankScope) : null;
  const shownPosition = position ?? (scopeLabel ? null : (rowGroup.rank ?? index + 1));
  const rankText = shownPosition == null ? null : scopeLabel ? `${ordinal(shownPosition)} in ${scopeLabel}` : `#${shownPosition}`;
  const rankTitle = shownPosition == null
    ? `Not scored in ${scopeLabel}`
    : scopeLabel
      ? `${ordinal(shownPosition)} in ${scopeLabel} among comparable verdicts (category order, not the generalist rank)`
      : `Rank ${shownPosition} among comparable verdicts (server ranking across the whole board)`;
  const model = entry.model || '—';
  const readinessBadge = readinessMap ? getBadgeHtml(model, readinessMap) : '';
  const hostName = entry.hostName || rowGroup.hostName || shortHost(entry.host) || '—';
  const judgeModel = entry.judgeModel || null;
  const useModelUrl = playgroundUrl(entry);
  const isLocal = (entry.tier || 'local') === 'local';
  const evidenceLevel = comparable ? 'comparable' : 'observation';
  const evidenceProof = comparable ? 'Comparable evidence' : 'Observation only';

  // A rank badge needs a comparable verdict. A medal additionally needs an
  // authoritative verdict (a qualified grader) and the generalist rank; a
  // comparable rank without one is marked provisional.
  const authoritative = comparable && isAuthoritative(entry);
  const canMedal = authoritative && !provisional && !scopeLabel && shownPosition != null && shownPosition <= 3;
  const provisionalRank = comparable && !authoritative && shownPosition != null;
  const provisionalTitle = provisionalRank
    ? ` — provisional: ${authorityReasons(entry).map(humanizeReason).join(' ')}`
    : '';
  const rank = canMedal
    ? `<span class="cb-medal ${RANK_CLASS[shownPosition - 1]}">${MEDAL[shownPosition - 1]}</span>`
    : comparable
      ? (rankText
        ? (scopeLabel
          ? `<span class="cb-rank-num cb-rank-cat${provisionalRank ? ' cb-rank-provisional' : ''}" title="${esc(rankTitle + provisionalTitle)}" aria-label="${esc(rankText)}${provisionalRank ? ', provisional' : ''}"><b>${ordinal(shownPosition)}</b><small>${esc(scopeLabel)}</small></span>`
          : `<span class="cb-rank-num${provisionalRank ? ' cb-rank-provisional' : ''}" title="${esc(rankTitle + provisionalTitle)}" aria-label="${esc(rankText)}${provisionalRank ? ', provisional' : ''}">${esc(rankText)}${provisionalRank ? '<small>provisional</small>' : ''}</span>`)
        : `<span class="cb-rank-num cb-rank-none" title="${esc(rankTitle)}" aria-label="${esc(rankTitle)}">—</span>`)
      : `<span class="cb-rank-num cb-rank-none" title="Unranked: no comparable verdict" aria-label="Unranked">—</span>`;

  const score = entry.filtered ? null : entry.score;
  const scoreCls = scoreClass(score);
  const leaderCls = shownPosition === 1 && canMedal ? ' cb-leader' : '';
  const scorePct = Number.isFinite(score) ? Math.min(100, Math.max(0, score * 10)) : 0;

  const { best, watch } = categoryExtremes(entry);
  const watchTone = watch && watch.score < 6 ? 'bad' : 'watch';

  // --- Full-sheet graphic columns ---
  const badgesCol = `<div class="cb-col cb-col-badges">
    <div class="cb-col-head">Badges</div>
    <div class="cb-badges">${renderChampionBadges(entry, championMap)}</div>
    <div class="cb-lanes">
      ${renderLanePill(best, 'best', 'Best')}
      ${renderLanePill(watch, watchTone, 'Watch')}
    </div>
  </div>`;

  const dims = entry.dimensions || [];
  const axisLabel = {
    composite: 'Composite',
    deterministic: 'Deterministic',
    subjective: 'Judge'
  }[entry.scoreAxis] || 'Score';

  // --- Full-sheet evidence stats ---
  const confidence = entry.confidence != null ? `±${entry.confidence.toFixed(2)}` : '—';
  const confCls = confidenceClass(entry.confidence);
  const tests = entry.testCount ?? '—';
  const levels = compactCounts(entry.promptLevelCounts, 'L');
  const contexts = compactCounts(entry.contextCounts);
  const difficultyPenalty = Number(entry.difficultyPenalty || 0);
  const evidencePenalty = Number(entry.evidenceConfidencePenalty || 0);
  const difficultyKnown = entry.difficultyCoverage != null
    && Number.isFinite(Number(entry.difficultyCoverage));
  const evidenceKnown = entry.evidenceConfidence != null
    && Number.isFinite(Number(entry.evidenceConfidence));
  const evidenceConfidence = evidenceKnown
    ? `${Math.round(Number(entry.evidenceConfidence) * 100)}%`
    : '—';
  const evidenceClass = !evidenceKnown ? '' : evidencePenalty > 0 ? 'watch' : 'good';
  const evidenceTitle = evidenceKnown
    ? `Average judge evidence confidence${entry.evidenceConfidenceTarget != null ? `; target ${Math.round(Number(entry.evidenceConfidenceTarget) * 100)}%` : ''}`
    : 'Judge-score provenance confidence is unknown. Legacy rows may still contain an LLM judge score while lacking modern scorer, artifact, or runtime identity.';
  const difficultyCoverage = difficultyKnown ? `${entry.difficultyCoverage}%` : '—';
  const difficultyClass = !difficultyKnown ? '' : difficultyPenalty > 0 ? 'bad' : 'good';
  const requiredLevels = (entry.requiredPromptLevels || []).map(l => `L${l}`).join(', ');
  const difficultyTitle = entry.fullScopeMinLevel
    ? `Required hard-level coverage: ${requiredLevels || `L${entry.fullScopeMinLevel}+`}`
    : 'Hard-level coverage';
  const unavailableBadge = entry.host_available === false
    ? '<span class="cb-unavailable-badge" title="This model is in the benchmark archive but is not currently present on its recorded Ollama host">Deleted</span>'
    : '';
  const nonComparableBadge = !comparable
    ? `<span class="cb-unavailable-badge" title="${esc(verdictReasons(entry).map(humanizeReason).join(' ') || 'Visible evidence only; excluded from rank')}">NOT RANKED</span>`
    : '';
  const harnessLabel = entry.harness?.name ? ` · ${entry.harness.name} ${entry.harness.version || ''}` : '';
  // An agent ranks beside bare models; its context and tools are part of what was measured.
  const agentTarget = entry.executionTarget?.mode === 'native_agent' ? entry.executionTarget : null;
  const agentTools = agentTarget?.nativePolicy?.tools?.length ?? null;
  const agentConfig = agentTarget ? [agentTarget.label, agentTarget.contextWindow ? `context ${agentTarget.contextWindow}` : null,
    agentTools != null ? `${agentTools} tool${agentTools === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') : '';
  const agentBadge = agentTarget ? `<span class="cb-use-model-proof" title="${esc(`Agent with its own prompt, context and tools: ${agentConfig}`)}">AGENT</span>` : '';
  const tierLabel = entry.tier === 'paid_cloud' ? 'paid cloud' : entry.tier === 'free_cloud' ? 'free cloud' : entry.residency === 'cpu' ? 'local · CPU' : 'local';
  const pricingLabel = entry.pricing?.kind && entry.pricing.kind !== 'free'
    ? ` · manual estimate · ${entry.pricing.source || 'declared price'}`
    : '';
  const providerCost = Number(entry.providerCostNanodollars || 0);
  const providerCostLabel = isLocal
    ? '—'
    : entry.pricing?.kind === 'free'
      ? 'US$0 (declared)'
      : `~US$${(providerCost / 1e9).toFixed(6)}`;
  const providerCostTitle = isLocal
    ? 'Local execution has no provider-price attribution'
    : entry.pricing?.kind === 'free'
      ? `Provider cost declared free by ${entry.pricing?.source || 'catalog'}`
      : `Manual estimated provider cost for these rows; source: ${entry.pricing?.source || 'catalog snapshot'}`;
  const reviewNeeded = entry.needsReviewCount ?? entry.reviewCount ?? 0;
  const lowConfidenceKnown = evidenceKnown
    || (entry.evidenceConfidenceCoverage != null && Number(entry.evidenceConfidenceCoverage) > 0);
  const lowConfidence = lowConfidenceKnown ? (entry.lowConfidenceCount ?? 0) : null;
  const lowConfidenceLabel = lowConfidence === null ? '—' : String(lowConfidence);
  const lowConfidenceClass = lowConfidence === null ? '' : lowConfidence > 0 ? 'watch' : 'good';
  const successRate = successText(entry);
  const succColor = entry.successRate != null
    ? (entry.successRate >= 90 ? '#81c784' : entry.successRate >= 70 ? '#ffb74d' : '#ef5350')
    : 'var(--r-text-dim)';
  const coeff = entry.perfCoeff != null ? entry.perfCoeff.toFixed(2) : '—';
  const coeffColor = entry.perfCoeff != null
    ? (entry.perfCoeff >= 0.9 ? '#4fc3f7' : entry.perfCoeff >= 0.7 ? '#ffb74d' : '#ef5350')
    : 'var(--r-text-dim)';

  const key = detailKey(index);
  const speedValue = entry.tokPerSec != null ? `${entry.tokPerSec} tok/s (total)` : 'no speed data';
  const ttftValue = entry.benchmarkTtft != null ? `TTFT measured ${formatMs(entry.benchmarkTtft)}` : 'TTFT not measured';
  const parts = entry.scoreParts || null;
  const partsStrong = parts ? `quality ${parts.quality != null ? parts.quality.toFixed(2) : '—'}` : `${tests} results`;
  const partsSmall = parts ? scoreAdjustments(parts) : (confidence === '—' ? 'uncertainty unknown' : `${confidence} uncertainty`);
  const summary = `<button type="button" class="cb-row-open" data-detail-key="${key}"
      aria-haspopup="dialog" aria-controls="cb-model-dialog" aria-label="Open full evidence sheet for ${esc(model)}">
    <span class="cb-rank">${rank}</span>
    <span class="cb-summary-id">
      <span class="cb-summary-model">${esc(model)}${readinessBadge}</span>
      <span class="cb-summary-source"><i class="fas fa-${isLocal ? 'server' : 'cloud'}" aria-hidden="true"></i> ${agentTarget ? 'agent · ' : ''}${esc(entry.provider || 'ollama')} · ${esc(tierLabel)} · ${esc(hostName)}</span>
      <span class="cb-summary-state" data-evidence-level="${esc(evidenceLevel)}" data-comparable="${comparable}" data-partial="${comparable && isPartialCoverage(entry)}">${esc(rowState(entry, comparable))}</span>
    </span>
    <span class="cb-summary-score" style="--score-pct:${scorePct}%" title="${parts ? esc(scorePartsText(entry)) : 'No comparable score'}">
      <span class="cb-score ${scoreCls}">${Number.isFinite(score) ? score.toFixed(2) : '—'}</span>
      <span class="cb-score-label">${comparable ? 'score' : 'not ranked'}</span>
    </span>
    <span class="cb-summary-categories" aria-label="Category score profile">${compactCategoryStrip(entry)}</span>
    <span class="cb-summary-pace">
      <strong>${esc(speedValue)}</strong><small>${esc(ttftValue)}</small>
    </span>
    <span class="cb-summary-coverage">
      <strong>${esc(partsStrong)}</strong><small>${esc(partsSmall)}</small>
    </span>
    <span class="cb-summary-open" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>
  </button>`;

  const detail = `<div class="cb-detail-sheet" data-detail-model="${esc(model)}">
    <header class="cb-detail-hero">
      <div class="cb-detail-rank">${rank}</div>
      <div class="cb-detail-identity">
        <p class="cb-detail-kicker">Complete model evidence</p>
        <h3 id="cb-model-dialog-title">${esc(model)}</h3>
        <div class="cb-detail-badges">${agentBadge}${readinessBadge}${unavailableBadge}${nonComparableBadge}<span class="cb-use-model-proof" data-evidence-level="${esc(evidenceLevel)}">${esc(evidenceProof)}</span></div>
      </div>
      <div class="cb-detail-score" style="--score-pct:${scorePct}%">
        ${renderTrend(entry.trend)}
        <strong class="${scoreCls}">${Number.isFinite(score) ? score.toFixed(2) : '—'}</strong>
        <span>${comparable ? 'score' : 'not ranked'} / 10</span>
      </div>
    </header>

    <section class="cb-detail-provenance" aria-label="Execution provenance">
      <div><span>Host</span><strong>${esc(hostName)}</strong><small>${esc(entry.host || 'Host identity unavailable')}</small></div>
      <div><span>Source</span><strong>${esc(entry.provider || 'ollama')} · ${esc(tierLabel)}</strong><small>${esc(`${agentTarget ? `agent · ${agentConfig}` : harnessLabel ? harnessLabel.replace(/^ · /, '') : 'direct model'}${pricingLabel}`)}</small></div>
      <div><span>Judge</span><strong>${esc(judgeModel || '—')}</strong><small>${judgeModel ? 'Observed judge target' : 'Judge identity unavailable'}</small></div>
      <div><span>Evidence</span><strong>${esc(evidenceProof)}</strong><small>${esc(entry.qualityCohortFingerprint || 'Cohort fingerprint unavailable')}</small></div>
    </section>
    ${verdictBlock(entry, rowGroup, comparable)}

    <div class="cb-detail-grid">
      <section class="cb-detail-panel cb-detail-categories">
        <div class="cb-detail-panel-head"><div><span>Capability profile</span><h4>${axisLabel} by category</h4></div><span class="cb-detail-panel-icon">◫</span></div>
        <div class="cb-detail-highlight-row">${badgesCol}</div>
        <div class="cb-detail-bars">${dims.length > 0 ? categoryBars(dims, entry.categoryEvidence) : '<div class="cb-no-data">No scored categories yet</div>'}</div>
      </section>

      <section class="cb-detail-panel cb-detail-performance">
        <div class="cb-detail-panel-head"><div><span>Runtime profile</span><h4>Speed & latency</h4></div><span class="cb-detail-panel-icon">↗</span></div>
        <div class="cb-detail-performance-grid">
          <div><div class="cb-col-head">Timing</div>${timingColumn(entry)}</div>
          <div><div class="cb-col-head">Throughput</div>${speedoColumn(entry)}</div>
        </div>
      </section>

      <section class="cb-detail-panel cb-detail-evidence">
        <div class="cb-detail-panel-head"><div><span>Evidence ledger</span><h4>Coverage, confidence & cost</h4></div><span class="cb-detail-panel-icon">◎</span></div>
        <div class="cb-detail-stat-grid">
          ${renderDetailStat('Tests', tests)}
          ${renderDetailStat('Levels', levels, { title: 'Prompt level mix' })}
          ${renderDetailStat('Contexts', contexts, { title: 'Context sizes used' })}
          ${renderDetailStat('Hard coverage', `${difficultyCoverage}${difficultyPenalty > 0 ? ` / -${difficultyPenalty.toFixed(1)}` : ''}`, { className: difficultyClass, title: difficultyTitle })}
          ${renderDetailStat('Evidence confidence', `${evidenceConfidence}${evidencePenalty > 0 ? ` / -${evidencePenalty.toFixed(1)}` : ''}`, { className: evidenceClass, title: evidenceTitle })}
          ${entry.fullScopeEligible === false ? renderDetailStat('Scope', 'PARTIAL', { className: 'watch', title: 'Run missing levels/categories before treating this as full-scope evidence' }) : ''}
          ${renderDetailStat('Uncertainty', confidence, { className: confCls, title: entry.confidenceMethod === 'weighted_category_prompt_means_t95' ? `Weighted 95% interval from ${entry.confidenceSampleSize || 0} independent prompt means; ${entry.confidenceRepeatCount || entry.testCount || 0} total attempts` : 'Uncertainty is unknown until each scored category has at least two independent prompt fixtures' })}
          ${renderDetailStat('Calibration', renderCalBadge(entry))}
          ${renderDetailStat('Needs review', reviewNeeded, { className: reviewNeeded > 0 ? 'watch' : 'good', title: 'Rows flagged for manual review; this is not the human-reviewed count' })}
          ${renderDetailStat('Low confidence', lowConfidenceLabel, { className: lowConfidenceClass, title: 'Rows with an observed judge confidence below 0.70' })}
          ${renderDetailStat('Success', esc(successRate), { style: `color:${succColor}`, title: SUCCESS_DEFINITION })}
          ${renderDetailStat('Provider cost', esc(providerCostLabel), { title: providerCostTitle })}
          ${renderDetailStat('Performance coeff.', coeff, { style: `color:${coeffColor}`, title: 'tok/s (total) normalised at 40 tok/s × success rate; unknown while the success rate is unknown' })}
        </div>
      </section>
    </div>

    <footer class="cb-detail-actions">
      <p><strong>Manual choice only.</strong> Opening a model never changes routing automatically.</p>
      <div>
        <a href="/benchmark/courthouse?model=${encodeURIComponent(model)}" class="cb-detail-action"><i class="fas fa-gavel" aria-hidden="true"></i> Review in Courthouse</a>
        <a href="/benchmark/efficiency-map" class="cb-detail-action"><i class="fas fa-chart-line" aria-hidden="true"></i> Efficiency Map</a>
        ${useModelUrl ? `<a href="${useModelUrl}" class="cb-detail-action cb-use-model" title="Open this exact model and host in Manual Chat; routing will not change automatically"><i class="fas fa-comment-dots" aria-hidden="true"></i> Use in Chat</a>` : ''}
      </div>
    </footer>
  </div>`;

  return `<article class="cb-row${leaderCls}${comparable ? ' cb-comparable' : ' cb-not-comparable'}" data-group-key="${esc(rowGroup.key || '')}">${summary}<template data-cb-detail="${key}">${detail}</template></article>`;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

const TRIAGE_OPTIONS = [
  { key: 'generalist', label: 'Generalist', icon: '🏁' },
  ...CATEGORY_ORDER.map(cat => ({ key: cat, label: CATEGORY_META[cat].label, icon: CATEGORY_META[cat].icon }))
];

function renderTriageChips(active) {
  return `<div class="cb-triage" role="tablist" aria-label="Sort leaderboard by category">
    ${TRIAGE_OPTIONS.map(opt => `
      <button class="cb-triage-chip${opt.key === active ? ' active' : ''}"
              data-cat="${opt.key}" role="tab"
              aria-selected="${opt.key === active}">
        <span class="cb-triage-ico">${opt.icon}</span><span>${opt.label}</span>
      </button>`).join('')}
  </div>`;
}

function sortRankings(rankings, mode) {
  if (mode === 'generalist' || !mode) {
    // Partial coverage is already priced into the score: order by score alone.
    return [...rankings].sort((a, b) => {
      if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }
  // Category mode — sort by that category score; entries lacking the score sink to bottom.
  return [...rankings].sort((a, b) => {
    const av = categoryScore(a, mode);
    const bv = categoryScore(b, mode);
    const aOk = av !== null;
    const bOk = bv !== null;
    if (aOk && bOk) return bv - av;
    if (aOk) return -1;
    if (bOk) return 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}

/** Sort groups by their headline entry with the same rules as entries. */
function sortGroups(groups, mode) {
  const byHeadline = new Map(groups.map(group => [group.headline, group]));
  return sortRankings(groups.map(group => group.headline), mode).map(entry => byHeadline.get(entry));
}

/** "Judged by <judge> · scorer 2.17 · …": the terms the ranked rows share. */
function boardSubtitle(groups) {
  const ranked = groups.find(group => group.comparable)?.headline || null;
  const mode = ranked?.thinking?.mode ? `Thinking mode (L${ranked.thinking.minLevel || 4}–L5, qualified models)` : null;
  const provisional = groups.some(group => group.comparable && !isAuthoritative(group.headline));
  const terms = [
    mode,
    ranked?.judgeModel ? `Judged by ${ranked.judgeModel}` : null,
    ranked?.verdict?.scorerFamily ? `scorer ${ranked.verdict.scorerFamily}` : null,
    provisional ? 'Ranks provisional where the grader is not qualified' : null
  ].filter(Boolean);
  return [...terms, 'Open a row for its full evidence'].join(' · ');
}

/**
 * The groups in display order with the rank the screen shows. In generalist
 * mode that is the server's rank (kept as is under a single-host view, so a
 * gap means a model on another host ranks between); in a category mode it
 * is the position by that category's score. The CSV export uses the same
 * objects, so it never writes a rank the screen did not show.
 */
export function rankedGroups(groups, mode) {
  const scope = mode && mode !== 'generalist' ? mode : 'generalist';
  const comparable = sortGroups(groups.filter(group => group.comparable), scope).map((group, position) => ({
    ...group,
    rankScope: scope,
    displayedRank: scope === 'generalist'
      ? (group.rank ?? position + 1)
      : (categoryScore(group.headline, scope) === null ? null : position + 1)
  }));
  const others = sortGroups(groups.filter(group => !group.comparable), scope)
    .map(group => ({ ...group, rankScope: scope, displayedRank: null }));
  return { comparable, others, scope };
}

/**
 * Ranked groups first; then the groups judged on other terms, without a
 * rank, in a closed disclosure. Each section keeps the active sort.
 */
function renderGroupSections(groups, mode, championMap, readinessMap, options = {}) {
  const { comparable, others, scope } = rankedGroups(groups, mode);
  let index = 0;
  const rows = (list) => list.map(group => renderRow(
    group.headline, index++, championMap, readinessMap,
    { ...options, group, position: group.displayedRank, rankScope: group.rankScope }
  )).join('');
  const rankedBy = scope === 'generalist' ? '' : ` by ${CATEGORY_META[scope]?.label || scope}`;
  const comparableSection = comparable.length
    ? `<h3 class="cb-section-title" id="cb-comparable-title">Ranking <small>${comparable.length} model${comparable.length === 1 ? '' : 's'}${rankedBy}</small></h3>${rows(comparable)}`
    : `<p class="cb-section-note" role="note">No model on this board was judged on the same terms as the others, so nothing is ranked. The rows below say why.</p>`;
  const othersSection = others.length
    ? `<details class="cb-unranked"${comparable.length ? '' : ' open'}><summary class="cb-section-title cb-section-unranked" id="cb-unranked-title">Other evidence <small>${others.length} not ranked: judged on other terms or without a score</small></summary>${rows(others)}</details>`
    : '';
  return `${comparableSection}${othersSection}`;
}

function dialogMarkup() {
  return `<dialog id="cb-model-dialog" class="cb-dialog" aria-labelledby="cb-model-dialog-title">
    <div class="cb-dialog-frame">
      <button type="button" class="cb-dialog-close" data-cb-dialog-close aria-label="Close model details">
        <i class="fas fa-xmark" aria-hidden="true"></i>
      </button>
      <div class="cb-dialog-content"></div>
    </div>
  </dialog>`;
}

function wireModelDialog(container) {
  if (!container || typeof container.addEventListener !== 'function') return;
  if (container._cbDialogWired) return;
  container._cbDialogWired = true;
  container.addEventListener('click', (event) => {
    const dialog = container.querySelector('#cb-model-dialog');
    if (!dialog) return;

    const closeButton = event.target.closest('[data-cb-dialog-close]');
    if (closeButton || event.target === dialog) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      return;
    }

    const trigger = event.target.closest('.cb-row-open');
    if (!trigger || !container.contains(trigger)) return;
    const template = Array.from(container.querySelectorAll('template[data-cb-detail]'))
      .find(candidate => candidate.dataset.cbDetail === trigger.dataset.detailKey);
    const content = dialog.querySelector('.cb-dialog-content');
    if (!template || !content) return;

    content.innerHTML = template.innerHTML;
    container._cbLastTrigger = trigger;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    requestAnimationFrame(() => dialog.querySelector('[data-cb-dialog-close]')?.focus());
  });
}

/** Keys of the history disclosures a viewer opened, so a re-render keeps them open. */
function openHistoryKeys(container) {
  if (typeof container?.querySelectorAll !== 'function') return new Set();
  return new Set(Array.from(container.querySelectorAll('.cb-history[open]')).map(node => node.dataset.groupKey));
}

function restoreOpenHistory(container, keys) {
  if (!keys.size || typeof container?.querySelectorAll !== 'function') return;
  for (const node of container.querySelectorAll('.cb-history')) {
    if (keys.has(node.dataset.groupKey)) node.open = true;
  }
}

/**
 * Render the grouped leaderboard. `input` is the board groups from
 * view-model.js; flat entries are accepted and treated as one-cohort groups.
 */
export async function renderCombinedBoard(container, input) {
  const groups = (input || []).map(asGroup);
  const activeDetailKey = container.querySelector?.('#cb-model-dialog[open]')
    ? container._cbLastTrigger?.dataset?.detailKey
    : null;
  const openHistory = openHistoryKeys(container);
  const readinessMap = await getReadinessMap().catch(() => ({}));
  // Medals follow each row's own authority (see renderRow), not a board flag.
  const provisional = false;
  const championMap = new Map();
  const comparableCount = groups.filter(group => group.comparable).length;
  const authoritativeCount = groups.filter(group => group.comparable && isAuthoritative(group.headline)).length;

  // Persist active triage on the container so re-renders preserve user choice.
  const active = container.dataset.triageMode || 'generalist';

  const head = `<div class="r-sec-head">
    <span class="r-sec-icon">🏁</span>
    <span class="r-sec-heading">
      <span class="r-sec-title r-t-cyan">Model leaderboard</span>
      <span class="cb-board-subtitle">${esc(boardSubtitle(groups))}</span>
    </span>
    <span class="cb-board-count">${comparableCount} ranked${comparableCount ? ` (${authoritativeCount === comparableCount ? 'all' : authoritativeCount} authoritative)` : ''}${groups.length > comparableCount ? ` · ${groups.length - comparableCount} other` : ''}</span>
    <span class="r-sec-toggle">▼</span>
  </div>`;

  const empty = groups.length === 0;
  const exportButton = `<button type="button" id="export-csv" class="cb-export-btn" title="Export the displayed rows, headline and history cohorts, as CSV"><i class="fas fa-download" aria-hidden="true"></i> Export CSV</button>`;
  const toolbar = `<div class="cb-toolbar">${renderTriageChips(active)}${exportButton}</div>`;

  const body = empty
    ? `<div class="r-empty">No rankings yet — launch a benchmark to populate the leaderboard.</div>`
    : `${toolbar}<div class="cb-list" id="cb-list">
        ${renderGroupSections(groups, active, championMap, readinessMap, { provisional })}
      </div>${reasonLegendHtml(collectReasonCodes(groups))}${dialogMarkup()}`;

  container.innerHTML = `${head}<div class="r-sec-body">${body}</div>`;

  if (empty) return;
  restoreOpenHistory(container, openHistory);
  wireModelDialog(container);
  const dialog = container.querySelector('#cb-model-dialog');
  if (dialog) {
    dialog.addEventListener('close', () => {
      const trigger = container._cbLastTrigger;
      container._cbLastTrigger = null;
      trigger?.focus();
    });
  }
  if (activeDetailKey) {
    requestAnimationFrame(() => {
      const trigger = Array.from(container.querySelectorAll('.cb-row-open'))
        .find(candidate => candidate.dataset.detailKey === activeDetailKey);
      trigger?.click();
    });
  }

  const exportBtn = container.querySelector('#export-csv');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      try {
        const { comparable, others } = rankedGroups(groups, container.dataset.triageMode || 'generalist');
        downloadCsv(buildCsvFromGroups([...comparable, ...others]), csvFilename());
      } catch (err) {
        console.error('[export-csv] failed:', err);
      }
    });
  }

  // Wire chip clicks — re-sort and re-render only the list, preserving section state.
  const triage = container.querySelector('.cb-triage');
  const list = container.querySelector('#cb-list');
  if (triage && list) {
    triage.addEventListener('click', (e) => {
      const chip = e.target.closest('.cb-triage-chip');
      if (!chip) return;
      const next = chip.dataset.cat;
      if (!next || next === container.dataset.triageMode) return;
      container.dataset.triageMode = next;
      // Update active state
      triage.querySelectorAll('.cb-triage-chip').forEach(c => {
        const on = c.dataset.cat === next;
        c.classList.toggle('active', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const opened = openHistoryKeys(container);
      list.innerHTML = renderGroupSections(groups, next, championMap, readinessMap, { provisional });
      restoreOpenHistory(container, opened);
    });
  }

  // Initialise dataset on first render
  if (!container.dataset.triageMode) container.dataset.triageMode = active;
}
