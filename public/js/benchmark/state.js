// state.js - Global shared state for the benchmark module

// API endpoint
export const BENCHMARK_API = '/api/benchmark';

// Charts
export let latencyChart = null;
export let tokensChart = null;
export let qualityChart = null;
export let compositeChart = null;
export let chartHighlightTimeout = null;
export let chartsInitialized = false;

// State
export let ollamaHosts = [];
export let currentSortBy = 'composite';
export let currentJudgeConfig = {};
export let currentExecutionConfig = {};
export let lastDashboardOverview = null;
export let lastRecentTests = [];
export let showSuccessRateDetails = false;
export let modelRegistryCache = {};

// Batch state
export let currentBatchId = null;
export let batchPollInterval = null;
export let currentBatchResults = [];
export let currentJudgeDetailId = null;

// Timeline state
export let lastTimelineResultIds = new Set();
export let lastTimelineHash = null;
export let timelineScrollRaf = null;
export let benchmarkTooltipEl = null;

// Debug flags
export const BENCHMARK_DEBUG = (
    new URLSearchParams(window.location.search).get('debug') === '1' ||
    localStorage.getItem('benchmarkDebug') === 'true'
);
export const __debugLastLogAt = Object.create(null);

// Setters for mutable state
export function setLatencyChart(chart) { latencyChart = chart; }
export function setTokensChart(chart) { tokensChart = chart; }
export function setQualityChart(chart) { qualityChart = chart; }
export function setCompositeChart(chart) { compositeChart = chart; }
export function setChartHighlightTimeout(timeout) { chartHighlightTimeout = timeout; }
export function setChartsInitialized(value) { chartsInitialized = value; }

export function setOllamaHosts(hosts) { ollamaHosts = hosts; }
export function setCurrentSortBy(sortBy) { currentSortBy = sortBy; }
export function setCurrentJudgeConfig(config) { currentJudgeConfig = config; }
export function setCurrentExecutionConfig(config) { currentExecutionConfig = config; }
export function setLastDashboardOverview(overview) { lastDashboardOverview = overview; }
export function setLastRecentTests(tests) { lastRecentTests = tests; }
export function setShowSuccessRateDetails(show) { showSuccessRateDetails = show; }
export function setModelRegistryCache(cache) { modelRegistryCache = cache; }

export function setCurrentBatchId(id) {
    currentBatchId = id;
    if (typeof window !== 'undefined') {
        window.currentBatchId = id;
    }
}
export function setBatchPollInterval(interval) { batchPollInterval = interval; }
export function setCurrentBatchResults(results) {
    currentBatchResults = results;
    if (typeof window !== 'undefined') {
        window.currentBatchResults = results;
    }
}
export function setCurrentJudgeDetailId(id) {
    currentJudgeDetailId = id;
    if (typeof window !== 'undefined') {
        window.currentJudgeDetailId = id;
    }
}

export function setLastTimelineResultIds(ids) { lastTimelineResultIds = ids; }
export function setLastTimelineHash(hash) { lastTimelineHash = hash; }
export function setTimelineScrollRaf(raf) { timelineScrollRaf = raf; }
export function setBenchmarkTooltipEl(el) { benchmarkTooltipEl = el; }

/**
 * Reset batch-related state for a new batch
 */
export function resetBatchState() {
    currentBatchId = null;
    currentBatchResults = [];
    currentJudgeDetailId = null;
    lastTimelineResultIds = new Set();
    lastTimelineHash = null;

    if (typeof window !== 'undefined') {
        window.currentBatchId = null;
        window.currentBatchResults = [];
        window.currentJudgeDetailId = null;
        window.lastTimelineHash = null;
    }
}

// Expose to window for legacy code
if (typeof window !== 'undefined') {
    window.currentBatchId = currentBatchId;
    window.currentBatchResults = currentBatchResults;
    window.currentJudgeDetailId = currentJudgeDetailId;
    window.latestBenchmarkData = null;
    window.benchmarkOffenders = null;
}
