/**
 * Benchmark Analytics - Configuration & Shared State
 * Contains API endpoints, storage keys, filters, and chart instances
 */

// Disable Chart.js animations globally to prevent distracting refreshes
if (typeof Chart !== 'undefined') {
    Chart.defaults.animation = false;
    Chart.defaults.animations = { colors: false, x: false };
    Chart.defaults.transitions = { active: { animation: { duration: 0 } } };
}

// API Endpoint
export const BENCHMARK_API = '/api/benchmark';

// Storage keys for localStorage persistence
export const STORAGE_KEYS = {
    judges: 'agentx_benchmark_judge_compare_v1'
};

// Current filters state
export let currentFilters = {
    modelCategory: null,
    promptCategory: null,
    tag: null,
    sort: 'composite'
};

// Reset filters (used by clearAllFilters)
export function resetFilters() {
    currentFilters = {
        modelCategory: null,
        promptCategory: null,
        tag: null,
        sort: 'composite'
    };
}

// Chart instances - mutable references stored here
export const chartInstances = {
    trendsChart: null,
    comparisonChart: null,
    judgeStrictnessChart: null,
    judgeBreakdownChart: null,
    judgeRadarChart: null,
    timelineChart: null
};

// Poller instance
export let poller = null;
export function setPoller(p) {
    poller = p;
}

// Last comparison data (for CSV export)
export let lastComparisonData = null;
export function setLastComparisonData(data) {
    lastComparisonData = data;
}

// Judge selections for compare feature
export const judgeSelections = [];

// Judge leaderboard cache
export let judgeLeaderboardCache = null;
export function setJudgeLeaderboardCache(cache) {
    judgeLeaderboardCache = cache;
}

// Truncation filter state
let _activeTruncationFilter = null;
export function getActiveTruncationFilter() {
    return _activeTruncationFilter;
}
export function setActiveTruncationFilter(filter) {
    _activeTruncationFilter = filter;
}

// Inspector state
let _inspectorActiveFilter = 'all';
export function getInspectorActiveFilter() {
    return _inspectorActiveFilter;
}
export function setInspectorActiveFilter(filter) {
    _inspectorActiveFilter = filter;
}

let _inspectorData = [];
export function getInspectorData() {
    return _inspectorData;
}
export function setInspectorData(data) {
    _inspectorData = data;
}
