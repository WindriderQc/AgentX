// cohort-history.js — provenance, score parts, labelled figures and the
// per-cohort history under a leaderboard row.
//
// Every number rendered here says what it is: "tok/s (total)" is not
// "tok/s (generation)", "latency mean" is not "p95", a measured TTFT is not
// the host baseline, and success is successes over attempts minus
// infrastructure errors — "unknown" when that denominator is zero.

import { esc, describeHistoryRow, humanizeReason, reasonLabel, shortCohort, verdictReasons } from './verdict.js';

export function formatDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function formatDateRange(earliest, latest) {
    const from = formatDate(earliest);
    const to = formatDate(latest);
    if (!from && !to) return 'dates unknown';
    if (!from || !to || from === to) return to || from;
    return `${from} → ${to}`;
}

export function formatMs(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const ms = Number(value);
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function counts(map, { prefix = '', joiner = ' · ' } = {}) {
    const entries = Object.entries(map || {})
        .filter(([, count]) => Number(count) > 0)
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    if (!entries.length) return '—';
    return entries.map(([value, count]) => `${prefix}${value} ×${count}`).join(joiner);
}

export function formatScorerVersions(scorerVersions) {
    return counts(scorerVersions);
}

export function formatContexts(contextCounts) {
    return counts(contextCounts);
}

/** "19/20 = 95 %" with its definition, or "unknown" with why. */
export function successText(entry) {
    const attempts = entry?.attempts || entry?.successRateDetail || null;
    if (!attempts) return entry?.successRate != null ? `${entry.successRate} %` : 'unknown';
    const denominator = attempts.successRateDenominator ?? (attempts.attempts - attempts.infraErrors);
    if (attempts.successRate == null || !(denominator > 0)) {
        return `unknown (${attempts.attempts ?? 0} attempts, ${attempts.infraErrors ?? 0} infrastructure errors, no denominator)`;
    }
    return `${attempts.successes}/${denominator} = ${attempts.successRate} %`;
}

export const SUCCESS_DEFINITION = 'success = successes ÷ (attempts − infrastructure errors)';

/** Judge, scorer version, contexts, results and dates on one strip. */
export function provenanceHtml(entry) {
    const judge = entry.judgeModel || (entry.judgeModels || [])[0] || null;
    const items = [
        ['Judge', judge ? esc(judge) : 'unknown', 'Judge model that scored these rows'],
        ['Scorer', esc(formatScorerVersions(entry.scorerVersions)), 'Scorer version behind the score, with row counts'],
        ['Contexts', esc(formatContexts(entry.contextCounts)), 'num_ctx of the rows, with row counts'],
        ['Results', esc(String(entry.resultCount ?? entry.testCount ?? 0)), 'Rows behind this score'],
        ['Dates', esc(formatDateRange(entry.earliestTimestamp, entry.latestTimestamp)), 'First and last result behind this score'],
        ['Cohort', esc(shortCohort(entry.qualityCohortFingerprint)), esc(entry.qualityCohortFingerprint || 'no cohort fingerprint')]
    ];
    return `<dl class="cb-prov">${items.map(([label, value, title]) => `<div title="${title}"><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

function amount(value) {
    return Math.abs(Number(value) || 0).toFixed(2);
}

/**
 * The score and its parts, so a penalized number is never shown alone:
 * the raw quality first, then each penalty, always subtracted.
 */
export function scorePartsText(entry) {
    const parts = entry.scoreParts;
    if (!parts || parts.score == null) {
        return entry.filtered ? 'Score withheld.' : 'No comparable score for this cohort.';
    }
    const quality = parts.quality != null ? parts.quality.toFixed(2) : '—';
    const tested = entry.testedCategories != null && entry.coverage != null
        ? ` (${entry.testedCategories} categories, ${entry.coverage} % coverage)`
        : entry.coverage != null ? ` (${entry.coverage} % coverage)` : '';
    const terms = [`quality ${quality}`, `coverage −${amount(parts.coverage)}${tested}`];
    if (parts.difficulty) terms.push(`hard-level −${amount(parts.difficulty)}`);
    if (parts.evidence) terms.push(`evidence −${amount(parts.evidence)}`);
    return `Score ${parts.score.toFixed(2)} / 10 = ${terms.join(' ')}`;
}

/** Labelled speed, latency, TTFT and success figures. */
export function metricsHtml(entry) {
    const item = (label, value, title) => `<li title="${esc(title)}"><span>${label}</span><strong>${esc(value)}</strong></li>`;
    const speedTotal = entry.tokPerSec != null ? `${entry.tokPerSec} tok/s` : '—';
    const speedGen = entry.tokPerSecGen != null ? `${entry.tokPerSecGen} tok/s` : 'not recorded';
    return `<ul class="cb-metrics">
    ${item('tok/s (total)', speedTotal, 'Output tokens over the whole request time, including prompt evaluation')}
    ${item('tok/s (generation)', speedGen, 'Output tokens over the time after prompt evaluation; needs prompt_eval_duration_ms on the rows')}
    ${item('latency mean / p95', `${formatMs(entry.avgLatency)} / ${formatMs(entry.p95Latency)}`, 'Mean and 95th-percentile request latency')}
    ${item('TTFT measured / host baseline', `${formatMs(entry.benchmarkTtft)} / ${formatMs(entry.hostTtft)}`, 'Measured streamed time to first token, then the warmed host baseline')}
    ${item('success', successText(entry), SUCCESS_DEFINITION)}
  </ul>`;
}

function historyScore(row) {
    if (row.scoreParts?.score != null) return `${row.scoreParts.score.toFixed(2)} / 10 score`;
    if (row.cohortScore?.mean10 != null) return `${row.cohortScore.mean10.toFixed(2)} / 10 mean ${String(row.cohortScore.field || 'score').replace(/_score$/, '')} (not a ranked score)`;
    return 'not scored';
}

function historyCoverage(row) {
    if (row.scoreParts?.score == null) return '—';
    return `${row.coverage ?? '—'} %${row.fullScopeEligible ? ' (full scope)' : ''}`;
}

function historyAttempts(row) {
    const attempts = row.attempts || row.successRateDetail || null;
    if (!attempts) return '—';
    return `${attempts.successes ?? 0}/${attempts.attempts ?? 0} (${attempts.infraErrors ?? 0} infra)`;
}

function historyRowHtml(row) {
    const reasons = verdictReasons(row);
    const why = [describeHistoryRow(row), ...reasons.map(reasonLabel)].join(' · ');
    const cell = (label, value, title = '') => `<td data-label="${label}"${title ? ` title="${esc(title)}"` : ''}>${value}</td>`;
    return `<tr data-cohort="${esc(row.qualityCohortFingerprint || '')}">
      ${cell('Dates', esc(formatDateRange(row.earliestTimestamp, row.latestTimestamp)))}
      ${cell('Judge', esc(row.judgeModel || 'unknown'))}
      ${cell('Scorer', esc(formatScorerVersions(row.scorerVersions)))}
      ${cell('Contexts', esc(formatContexts(row.contextCounts)))}
      ${cell('Score', esc(historyScore(row)))}
      ${cell('Coverage', esc(historyCoverage(row)))}
      ${cell('Attempts', esc(historyAttempts(row)), 'successes / attempts (infrastructure errors)')}
      ${cell('Why not headline', esc(why), reasons.map(humanizeReason).join(' '))}
    </tr>`;
}

/** Expandable history of the other cohorts of a group; empty when there are none. */
export function historyHtml(group) {
    const history = group?.history || [];
    if (!history.length) return '';
    const count = history.length;
    return `<details class="cb-history" data-group-key="${esc(group.key)}">
    <summary>${count} other cohort${count === 1 ? '' : 's'} of this model on this host</summary>
    <table class="cb-history-table">
      <thead><tr><th>Dates</th><th>Judge</th><th>Scorer</th><th>Contexts</th><th>Score</th><th>Coverage</th><th>Attempts</th><th>Why not headline</th></tr></thead>
      <tbody>${history.map(historyRowHtml).join('')}</tbody>
    </table>
  </details>`;
}
