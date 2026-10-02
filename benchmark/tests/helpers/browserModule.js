'use strict';
/**
 * Load a browser ES module from public/js into a vm context without jsdom.
 * Imports are stripped and supplied as `stubs`; `export` keywords are removed
 * and the named symbols are returned. Real modules can be chained by passing
 * one module's exports as the next one's stubs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_JS = path.join(__dirname, '../../public/js');
// `/js/benchmark-categories.js` and `/js/csv-cell.js` are generated from
// shared/; modules that import them receive the same values here.
const { BENCHMARK_CATEGORIES, BENCHMARK_CATEGORY_KEYS } = require('../../../shared/benchmarkCategories');
const { csvCell } = require('../../../shared/csvCell');
const SHARED_STUBS = {
    CATEGORY_KEYS: BENCHMARK_CATEGORY_KEYS,
    CATEGORY_META: BENCHMARK_CATEGORIES,
    BENCHMARK_CATEGORY_META: BENCHMARK_CATEGORIES,
    csvCell
};

function loadBrowserModule(relativeFile, exportNames, stubs = {}) {
    const sourcePath = path.join(PUBLIC_JS, relativeFile);
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
    source = source.replace(/^export\s+(const|let)\s+/gm, '$1 ');
    source = source.replace(/export\s+(async\s+)?function\s+/g, (_, asyncKeyword = '') => `${asyncKeyword}function `);
    source += `\nmodule.exports = { ${exportNames} };\n`;

    const context = {
        module: { exports: {} },
        exports: {},
        console,
        document: { addEventListener: () => {}, querySelector: () => null },
        localStorage: { getItem: () => null },
        ...SHARED_STUBS,
        ...stubs
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

/** The real leaderboard-v2 verdict, cohort-history and CSV modules, merged. */
function loadLeaderboardTextModules() {
    const verdict = loadBrowserModule('leaderboard-v2/verdict.js',
        'esc, REASON_TEXT, HEADLINE_REASON_TEXT, HISTORY_REASON_TEXT, humanizeReason, reasonLabel, shortCohort, isComparable, verdictReasons, isPartialCoverage, coverageGaps, describeHeadline, describeHistoryRow, collectReasonCodes, reasonLegendHtml, GRADER_CAUSE_TEXT, describeGraderCause, isAuthoritative, authorityReasons, graderSummary');
    const history = loadBrowserModule('leaderboard-v2/cohort-history.js',
        'formatDate, formatDateRange, formatScorerVersions, formatContexts, successText, SUCCESS_DEFINITION, provenanceHtml, scorePartsText, metricsHtml, historyHtml, promptCoverageText',
        verdict);
    const csv = loadBrowserModule('leaderboard-v2/leaderboard-csv.js',
        'CSV_HEADERS, buildCsvFromGroups, csvFilename',
        { ...verdict, ...history });
    return { ...verdict, ...history, ...csv };
}

module.exports = { loadBrowserModule, loadLeaderboardTextModules, PUBLIC_JS };
