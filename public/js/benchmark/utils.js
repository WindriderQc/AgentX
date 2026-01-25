// utils.js - Utility functions

import { BENCHMARK_DEBUG, __debugLastLogAt } from './state.js';

/**
 * SECURITY: Escape HTML to prevent XSS
 */
export function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms) {
    if (!ms || !Number.isFinite(ms) || ms <= 0) return '-';
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${totalSeconds}s`;
    return `${minutes}m ${seconds}s`;
}

/**
 * Convert value to finite number or null
 */
export function toFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Calculate percentile from sorted array
 */
export function percentile(sortedValuesAsc, p) {
    const xs = Array.isArray(sortedValuesAsc) ? sortedValuesAsc : [];
    if (xs.length === 0) return null;
    const clamped = Math.max(0, Math.min(1, p));
    const idx = (xs.length - 1) * clamped;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return xs[lo];
    const w = idx - lo;
    return xs[lo] * (1 - w) + xs[hi] * w;
}

/**
 * Debug logging (opt-in via ?debug=1 or localStorage.benchmarkDebug=true)
 */
export function debugLog(...args) {
    if (BENCHMARK_DEBUG) console.log(...args);
}

/**
 * Throttled debug logging
 */
export function debugLogThrottled(key, intervalMs, ...args) {
    if (!BENCHMARK_DEBUG) return;
    const now = Date.now();
    const last = __debugLastLogAt[key] || 0;
    if (now - last < intervalMs) return;
    __debugLastLogAt[key] = now;
    console.log(...args);
}

/**
 * Summarize an array of numbers
 */
export function summarizeNumbers(values) {
    const xs = (Array.isArray(values) ? values : [])
        .map(toFiniteNumber)
        .filter(v => v !== null)
        .slice()
        .sort((a, b) => a - b);
    if (xs.length === 0) {
        return { n: 0, min: null, max: null, mean: null, p10: null, p50: null, p90: null, p95: null };
    }
    const sum = xs.reduce((acc, v) => acc + v, 0);
    return {
        n: xs.length,
        min: xs[0],
        max: xs[xs.length - 1],
        mean: sum / xs.length,
        p10: percentile(xs, 0.10),
        p50: percentile(xs, 0.50),
        p90: percentile(xs, 0.90),
        p95: percentile(xs, 0.95)
    };
}

/**
 * Count items by key
 */
export function countBy(items, getKey) {
    const counts = Object.create(null);
    for (const item of (Array.isArray(items) ? items : [])) {
        const key = getKey(item);
        if (!key) continue;
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

/**
 * Get top counts from counts object
 */
export function topCounts(countsObj, limit = 5) {
    const entries = Object.entries(countsObj || {})
        .map(([k, v]) => ({ key: k, count: Number(v) || 0 }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count);
    return entries.slice(0, limit);
}

/**
 * Format host label from URL
 */
export function formatHostLabel(url) {
    if (!url) return 'Unknown';
    if (url.includes('192.168.2.99')) return 'UGFrank';
    if (url.includes('192.168.2.12')) return 'UGBrutal';
    if (url.includes('localhost')) return 'Local';
    return url.replace('http://', '').replace(':11434', '');
}

/**
 * Infer opposite host URL from current execution host
 */
export function inferOppositeHostUrl(execHostUrl, hosts) {
    if (!execHostUrl) return null;
    const other = Array.isArray(hosts)
        ? hosts.find(h => h && h.url && h.url !== execHostUrl)
        : null;
    return other ? other.url : null;
}

/**
 * Tooltip encoding helpers
 */
export const encodeTooltip = (value = '') => encodeURIComponent(String(value)).replace(/'/g, '%27');
export const decodeTooltip = (value = '') => {
    try {
        return decodeURIComponent(value);
    } catch (err) {
        return value;
    }
};

/**
 * Find row by attribute in container
 */
export function findRowByAttr(container, attrName, attrValue) {
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll(`tr[${attrName}]`));
    return rows.find(r => r.getAttribute(attrName) === attrValue) || null;
}

/**
 * Get result ID or index
 */
export function getResultIdOrIndex(result, index) {
    if (result && result.id) return String(result.id);
    return String(index);
}
