// api.js - API helpers and fetch wrappers

import { BENCHMARK_API } from './state.js';

/**
 * Get headers with workspace context
 */
export function getWorkspaceHeaders(extra = {}) {
    const baseHeaders = { 'Content-Type': 'application/json', ...extra };
    if (window.WorkspaceManager && typeof window.WorkspaceManager.addWorkspaceHeader === 'function') {
        const withWorkspace = window.WorkspaceManager.addWorkspaceHeader({ headers: baseHeaders });
        return withWorkspace.headers || baseHeaders;
    }
    return baseHeaders;
}

/**
 * Fetch benchmark config
 */
export async function fetchBenchmarkConfig() {
    const res = await fetch(`${BENCHMARK_API}/config`, {
        headers: getWorkspaceHeaders()
    });
    return res.json();
}

/**
 * Fetch judge roster (all judges with metadata + per-host availability)
 */
export async function fetchJudgeRoster() {
    const res = await fetch(`${BENCHMARK_API}/judge-roster`, {
        headers: getWorkspaceHeaders()
    });
    return res.json();
}

/**
 * Fetch per-host default judge config
 */
export async function fetchJudgeDefaults() {
    const res = await fetch(`${BENCHMARK_API}/judge-defaults`, {
        headers: getWorkspaceHeaders()
    });
    return res.json();
}

/**
 * Save default judge for a host
 * @param {string} hostUrl
 * @param {string|null} judgeModel  — null to clear
 */
export async function saveJudgeDefault(hostUrl, judgeModel) {
    const res = await fetch(`${BENCHMARK_API}/judge-defaults`, {
        method: 'PUT',
        headers: getWorkspaceHeaders(),
        body: JSON.stringify({ hostUrl, judgeModel })
    });
    return res.json();
}

/**
 * Fetch Ollama hosts
 */
export async function fetchOllamaHosts(timeoutMs = 8000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch('/api/ollama-hosts', {
        signal: controller.signal,
        headers: getWorkspaceHeaders()
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    return res.json();
}

/**
 * Fetch model registry
 */
export async function fetchModelRegistry() {
    const res = await fetch('/api/models/registry', {
        headers: getWorkspaceHeaders()
    });
    return res.json();
}

/**
 * Update model in registry (PATCH)
 */
export async function patchModelRegistry(model, data) {
    const res = await fetch(`/api/models/registry/${encodeURIComponent(model)}`, {
        method: 'PATCH',
        headers: getWorkspaceHeaders(),
        body: JSON.stringify(data)
    });
    return { res, status: res.status, json: await res.json().catch(() => null) };
}

/**
 * Create model in registry (POST)
 */
export async function createModelRegistry(data) {
    const res = await fetch('/api/models/registry', {
        method: 'POST',
        headers: getWorkspaceHeaders(),
        body: JSON.stringify(data)
    });
    return res.json();
}

/**
 * Validate judge model availability and output capability
 */
export async function validateJudgeModelApi(host, model) {
    const res = await fetch(`${BENCHMARK_API}/validate-judge`, {
        method: 'POST',
        headers: getWorkspaceHeaders(),
        body: JSON.stringify({ host, model })
    });
    return { res, json: await res.json() };
}

/**
 * Start batch test
 */
export async function startBatchTest(data) {
    const res = await fetch(`${BENCHMARK_API}/batch`, {
        method: 'POST',
        headers: getWorkspaceHeaders(),
        body: JSON.stringify(data)
    });
    return { res, json: await res.json() };
}

/**
 * Stop batch test
 */
export async function stopBatchTest(batchId) {
    const res = await fetch(`${BENCHMARK_API}/batch/${batchId}/stop`, {
        method: 'POST',
        headers: getWorkspaceHeaders()
    });
    return res;
}

/**
 * Fetch batch progress
 */
export async function fetchBatchProgress(batchId) {
    const res = await fetch(`${BENCHMARK_API}/batch/${batchId}`);
    if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
    }
    return res.json();
}

/**
 * Fetch batch timeline
 */
export async function fetchBatchTimeline(batchId) {
    const res = await fetch(`${BENCHMARK_API}/batch/${batchId}/timeline`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * Fetch batch history
 */
export async function fetchBatchHistory() {
    const res = await fetch(`${BENCHMARK_API}/batches`);
    return res.json();
}

/**
 * Fetch active batches
 */
export async function fetchActiveBatches() {
    const res = await fetch(`${BENCHMARK_API}/batches/active`);
    return res.json();
}

/**
 * Recover stuck batch
 */
export async function recoverBatchApi(batchId) {
    const res = await fetch(`${BENCHMARK_API}/batch/${batchId}/recover`, {
        method: 'POST',
        headers: getWorkspaceHeaders()
    });
    return res.json();
}

/**
 * Run single benchmark test
 */
export async function runSingleTest(data) {
    const res = await fetch(`${BENCHMARK_API}/test`, {
        method: 'POST',
        headers: getWorkspaceHeaders(),
        body: JSON.stringify(data)
    });
    return res.json();
}

/**
 * Delete all benchmark results
 */
export async function deleteAllResults() {
    const res = await fetch(`${BENCHMARK_API}/results`, {
        method: 'DELETE',
        headers: getWorkspaceHeaders()
    });
    return { res, json: await res.json().catch(() => null) };
}

/**
 * Delete failed benchmark results
 */
export async function deleteFailedResults() {
    const res = await fetch(`${BENCHMARK_API}/results/failed`, {
        method: 'DELETE',
        headers: getWorkspaceHeaders()
    });
    return { res, json: await res.json().catch(() => null) };
}

/**
 * Fetch advanced results
 */
export async function fetchAdvancedResults(batchId, limit = 5000) {
    const res = await fetch(`${BENCHMARK_API}/results/advanced?batchId=${batchId}&limit=${limit}`);
    return res.json();
}
