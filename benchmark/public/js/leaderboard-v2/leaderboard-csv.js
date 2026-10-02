// leaderboard-csv.js — export the displayed groups (headline + history) as CSV.

import { authorityReasons, describeHeadline, describeHistoryRow, isAuthoritative, verdictReasons } from './verdict.js';
import { formatDate } from './cohort-history.js';

const CATS = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];

// `rank` is the rank the screen showed (generalist: the server rank; a
// category: the position by that category), `rankScope` says which, and
// `serverRank` is the server's generalist rank whatever the screen showed.
export const CSV_HEADERS = [
    'rowKind', 'rank', 'rankScope', 'serverRank', 'comparable', 'verdictReasons', 'authoritative', 'graderStatus', 'graderCauses', 'headlineOrHistoryReason', 'model', 'host', 'hostName',
    'provider', 'tier', 'harness', 'harnessVersion', 'qualityCohortFingerprint', 'judgeModel', 'scorerVersions',
    'contexts', 'firstResult', 'lastResult', 'results', 'score', 'qualityRaw', 'coveragePenalty', 'difficultyPenalty',
    'evidencePenalty', 'coveragePercent', 'fullScope', 'meanAxisScore', 'meanAxisField',
    'tokPerSecTotal', 'tokPerSecGeneration', 'latencyMeanMs', 'latencyP95Ms', 'ttftMeasuredMs', 'ttftHostBaselineMs',
    'successes', 'attempts', 'infraErrors', 'successRate', 'providerCostUsd',
    ...CATS
];

/**
 * One CSV field. Text a spreadsheet would run as a formula (a leading
 * = + - @ tab or CR) is prefixed with an apostrophe, the standard
 * neutralisation; numbers and booleans pass through untouched.
 */
export function csvEscape(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    let text = String(value);
    const formulaLike = /^[=+\-@\t\r]/.test(text);
    if (formulaLike) text = `'${text}`;
    return formulaLike || /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function countsText(map) {
    return Object.entries(map || {}).map(([key, count]) => `${key}:${count}`).join(' ');
}

function fixed(value, digits) {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? '' : Number(value).toFixed(digits);
}

function rowValues(entry, group, kind) {
    const parts = entry.scoreParts || null;
    const attempts = entry.attempts || entry.successRateDetail || null;
    const headline = kind === 'headline';
    return [
        kind,
        headline && group.comparable ? (group.displayedRank ?? group.rank ?? '') : '',
        headline ? (group.rankScope || 'generalist') : '',
        headline && group.comparable && group.rank != null ? group.rank : '',
        headline ? group.comparable : false,
        verdictReasons(entry).join(' '),
        headline ? isAuthoritative(entry) : false,
        entry.graderQualification?.status || 'unknown',
        [...authorityReasons(entry), ...(entry.graderQualification?.causes || [])].join(' '),
        headline ? describeHeadline(group) : describeHistoryRow(entry),
        entry.model || '',
        entry.host || '',
        entry.hostName || group.hostName || '',
        entry.provider || 'ollama',
        entry.tier || 'local',
        entry.harness?.name || '',
        entry.harness?.version || '',
        entry.qualityCohortFingerprint || '',
        entry.judgeModel || '',
        countsText(entry.scorerVersions),
        countsText(entry.contextCounts),
        formatDate(entry.earliestTimestamp) || '',
        formatDate(entry.latestTimestamp) || '',
        entry.resultCount ?? entry.testCount ?? '',
        parts ? fixed(parts.score, 3) : '',
        parts ? fixed(parts.quality, 3) : '',
        parts ? fixed(parts.coverage, 3) : '',
        parts ? fixed(parts.difficulty, 3) : '',
        parts ? fixed(parts.evidence, 3) : '',
        entry.coverage ?? '',
        entry.fullScopeEligible === true,
        entry.cohortScore ? fixed(entry.cohortScore.mean10, 3) : '',
        entry.cohortScore?.field || '',
        entry.tokPerSec ?? '',
        entry.tokPerSecGen ?? '',
        entry.avgLatency ?? '',
        entry.p95Latency ?? '',
        entry.benchmarkTtft ?? '',
        entry.hostTtft ?? '',
        attempts?.successes ?? '',
        attempts?.attempts ?? '',
        attempts?.infraErrors ?? '',
        attempts?.successRate ?? entry.successRate ?? '',
        (entry.tier || 'local') === 'local' ? '' : Number(entry.providerCostNanodollars || 0) / 1e9,
        ...CATS.map(cat => (entry.categoryScores?.[cat] != null ? Number(entry.categoryScores[cat]).toFixed(2) : ''))
    ];
}

/** One line per headline and per history row, in display order. */
export function buildCsvFromGroups(groups) {
    const lines = [CSV_HEADERS.join(',')];
    for (const group of groups || []) {
        lines.push(rowValues(group.headline, group, 'headline').map(csvEscape).join(','));
        for (const row of group.history || []) {
            lines.push(rowValues(row, group, 'history').map(csvEscape).join(','));
        }
    }
    return lines.join('\n');
}

export function csvFilename(date = new Date()) {
    return `leaderboard-${date.toISOString().slice(0, 10)}.csv`;
}

export function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
