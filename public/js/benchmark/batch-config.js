// batch-config.js - Batch configuration, depth matrix, level/model matrix

import * as state from './state.js';
import { escapeHtml, formatHostLabel } from './utils.js';
import { currentJudgeTier, refreshJudgeTierUI, requiredTierForLevel, strongestRequiredTier } from './judge-mismatch.js';

// ─── Depth Configuration ───────────────────────────────────────────

const DEPTH_STORAGE_KEY = 'benchmarkDepthConfig';
const DEPTH_OPTIONS = ['off', 'single', 'light', 'half', 'full'];

const DEFAULT_DEPTH_CONFIG = {
    1: 'light', 2: 'light', 3: 'light', 4: 'light', 5: 'light',
    6: 'light', 7: 'light', 8: 'light', 9: 'light', 10: 'light'
};

// Approximate prompt counts per level (used for UI estimation only)
// Actual counts come from the database at runtime
const LEVEL_PROMPT_META = {
    1:  { prompts: 16, categories: 10 },
    2:  { prompts: 16, categories: 10 },
    3:  { prompts: 16, categories: 10 },
    4:  { prompts: 22, categories: 10 },
    5:  { prompts: 22, categories: 10 },
    6:  { prompts: 12, categories: 6 },
    7:  { prompts: 12, categories: 6 },
    8:  { prompts: 12, categories: 6 },
    9:  { prompts: 6,  categories: 6 },
    10: { prompts: 6,  categories: 6 }
};

const LEVEL_LABELS = {
    1: 'Trivial', 2: 'Simple', 3: 'Easy', 4: 'Moderate', 5: 'Medium',
    6: 'Challenging', 7: 'Hard', 8: 'Very Hard', 9: 'Extreme', 10: 'Master'
};

/**
 * Read depth config from localStorage (or return defaults)
 */
export function getDepthConfig() {
    try {
        const raw = localStorage.getItem(DEPTH_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_DEPTH_CONFIG };
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            // Merge with defaults so new levels are covered
            return { ...DEFAULT_DEPTH_CONFIG, ...parsed };
        }
    } catch (e) {
        console.warn('Failed to parse depth config:', e);
    }
    return { ...DEFAULT_DEPTH_CONFIG };
}

/**
 * Save depth config to localStorage
 */
function setDepthConfig(config) {
    try {
        localStorage.setItem(DEPTH_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
        console.warn('Failed to save depth config:', e);
    }
}

/**
 * Estimate prompt count for a given level and depth
 */
function calculatePromptCount(level, depth) {
    const meta = LEVEL_PROMPT_META[level] || { prompts: 10, categories: 6 };
    switch (depth) {
        case 'off':    return 0;
        case 'single': return 1;
        case 'light':  return meta.categories; // 1 per category
        case 'half':   return Math.max(meta.categories, Math.ceil(meta.prompts / 2)); // ~50%, min 1/cat
        case 'full':   return meta.prompts;
        default:       return 0;
    }
}

/**
 * Get total estimated prompts from current depth config
 */
function getTotalEstimatedPrompts(config) {
    let total = 0;
    for (let level = 1; level <= 10; level++) {
        const depth = (config && config[level]) || 'off';
        total += calculatePromptCount(level, depth);
    }
    return total;
}


function resolveWorkloadSummary(plan, categories) {
    const promptCounts = categories
        .map((c) => Number(c.prompt_count) || 0)
        .filter((n) => n > 0);

    const raw = (plan && plan.workload_summary && typeof plan.workload_summary === 'object')
        ? plan.workload_summary
        : {};

    const totalCategoryPrompts = Number.isFinite(Number(raw.total_category_prompts))
        ? Number(raw.total_category_prompts)
        : promptCounts.reduce((sum, n) => sum + n, 0);

    const projectedTests = Number.isFinite(Number(raw.projected_tests))
        ? Number(raw.projected_tests)
        : ((Number(plan && plan.total_models) || 0) * totalCategoryPrompts);

    const categoryCount = Number.isFinite(Number(raw.category_count))
        ? Number(raw.category_count)
        : categories.length;

    return {
        totalCategoryPrompts,
        projectedTests,
        categoryCount
    };
}

/**
 * Get selected levels (non-off) from depth config
 */
export function getSelectedLevels(config) {
    const levels = [];
    for (let level = 1; level <= 10; level++) {
        const depth = (config && config[level]) || 'off';
        if (depth !== 'off') levels.push(level);
    }
    return levels;
}

/**
 * Render the depth matrix table body
 * Note: tier badge cells are injected dynamically by judge-mismatch.js via refreshDepthMatrixTierCells()
 */
export function renderDepthMatrix() {
    const tbody = document.getElementById('depthMatrixBody');
    if (!tbody) return;

    const config = getDepthConfig();
    const rankMap = state.tierRank || { basic: 1, standard: 2, advanced: 3, premium: 4 };
    const judgeTier = currentJudgeTier();
    const judgeRank = rankMap[judgeTier] || 0;
    let html = '';

    for (let level = 1; level <= 10; level++) {
        const currentDepth = config[level] || 'light';
        const est = calculatePromptCount(level, currentDepth);
        const label = LEVEL_LABELS[level] || '';
        const requiredTier = requiredTierForLevel(level);
        const requiredRank = rankMap[requiredTier] || 1;
        const meetsIt = judgeRank >= requiredRank;
        const rowWarn = (!meetsIt && currentDepth !== 'off') ? ' style="background:rgba(231,76,60,0.06);"' : '';

        html += `<tr data-level="${level}"${rowWarn}>`;
        html += `<td class="level-col"><span class="depth-level-num">${level}</span><span class="depth-level-label">${label}</span></td>`;

        for (const opt of DEPTH_OPTIONS) {
            const checked = currentDepth === opt ? 'checked' : '';
            const id = `depth_${level}_${opt}`;
            html += `<td class="depth-radio-cell">`;
            html += `<input type="radio" name="depth_${level}" id="${id}" value="${opt}" ${checked} class="depth-radio" data-level="${level}" data-depth="${opt}">`;
            html += `<label for="${id}" class="depth-radio-label depth-opt-${opt}">${opt === 'off' ? '—' : opt[0].toUpperCase()}</label>`;
            html += `</td>`;
        }

        html += `<td class="count-col"><span class="depth-est-count">${est}</span></td>`;
        html += `</tr>`;
    }

    tbody.innerHTML = html;
}

/**
 * Update total prompts summary in the depth matrix footer
 */
export function updateDepthSummary() {
    const config = getDepthConfig();
    const totalPrompts = getTotalEstimatedPrompts(config);
    const selectedLevels = getSelectedLevels(config);
    const selectedModels = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'));
    const modelCount = selectedModels.length;

    const summaryEl = document.getElementById('depthSummary');
    if (summaryEl) {
        if (selectedLevels.length === 0) {
            summaryEl.textContent = 'All levels off — select at least one';
        } else {
            const levelsStr = selectedLevels.join(', ');
            const rankMap = state.tierRank || { basic: 1, standard: 2, advanced: 3, premium: 4 };
            const maxTier = strongestRequiredTier(selectedLevels);
            const maxRank = rankMap[maxTier] || 1;
            const judgeTier = currentJudgeTier();
            const judgeRank = rankMap[judgeTier] || 0;
            const meets = judgeRank >= maxRank;
            const tierNote = meets
                ? ` — judge tier OK (${judgeTier} ≥ ${maxTier})`
                : ` — ⚠ judge tier ${judgeTier} < required ${maxTier}`;
            summaryEl.innerHTML = `~${totalPrompts} prompts across ${selectedLevels.length} levels (${levelsStr})` +
                `<span style="margin-left:8px;font-size:0.88em;color:${meets ? '#27ae60' : '#e74c3c'};">${tierNote}</span>`;
        }
    }

    const batchModelCountEl = document.getElementById('batchModelCount');
    if (batchModelCountEl) {
        batchModelCountEl.textContent = modelCount;
    }

    const info = document.getElementById('batchInfo');
    if (info) {
        info.classList.add('is-summary');
        if (totalPrompts > 0 && modelCount > 0) {
            const totalTests = totalPrompts * modelCount;
            info.textContent = `${modelCount} models × ~${totalPrompts} prompts = ~${totalTests} tests`;
        } else {
            info.textContent = 'Select levels and models to start';
        }
    }
}

/**
 * Bind depth matrix radio change events
 */
export function bindDepthMatrix() {
    const tbody = document.getElementById('depthMatrixBody');
    if (!tbody) return;

    tbody.addEventListener('change', (e) => {
        if (!e.target.classList.contains('depth-radio')) return;

        const level = parseInt(e.target.dataset.level, 10);
        const depth = e.target.dataset.depth;

        const config = getDepthConfig();
        config[level] = depth;
        setDepthConfig(config);

        // Update the estimate count in this row
        const row = e.target.closest('tr');
        if (row) {
            const countEl = row.querySelector('.depth-est-count');
            if (countEl) countEl.textContent = calculatePromptCount(level, depth);
        }

        updateDepthSummary();

        // Refresh judge tier indicators when levels change
        const activeLevels = getSelectedLevels(getDepthConfig());
        refreshJudgeTierUI(activeLevels);
    });
}

/**
 * Set all levels to a specific depth
 */
export function setAllDepths(depth) {
    const config = {};
    for (let level = 1; level <= 10; level++) {
        config[level] = depth;
    }
    setDepthConfig(config);
    renderDepthMatrix();
    updateDepthSummary();
    refreshJudgeTierUI(getSelectedLevels(config));
}

// ─── Batch Info (updated to use depth config) ──────────────────────

/**
 * Update batch info display (delegates to depth summary)
 */
export function updateBatchInfo() {
    updateDepthSummary();
}

/**
 * Render batch plan display
 */
export function renderBatchPlan(plan, fallbackHostUrl, _qualityScoringEnabled = true, executionMode = 'latency') {
    if (!plan) {
        const judgeModel = state.currentJudgeConfig.model || '(not set)';
        const exec = fallbackHostUrl ? formatHostLabel(fallbackHostUrl) : '(unknown)';
        const judgeHost = formatHostLabel(state.currentJudgeConfig.host || '');
        const execConfig = state.currentExecutionConfig || {};
        const maxTokens = execConfig.response_max_tokens || 32000;
        const judgeNumCtx = Number((state.currentJudgeConfig && state.currentJudgeConfig.num_ctx) || 8192);

        return `
            <div class="batch-plan-shell">
                <div class="batch-plan-header">
                    <div class="batch-plan-title">
                        <span class="batch-plan-chip is-emphasis"><i class="fas fa-server"></i>${escapeHtml(exec)}</span>
                        <span class="batch-plan-chip"><i class="fas fa-gavel"></i>${escapeHtml(judgeModel)}</span>
                        <span class="batch-plan-chip is-host">${escapeHtml(judgeHost || '(not set)')}</span>
                    </div>
                    <div class="batch-plan-meta">
                        <span class="batch-plan-chip">Max ${maxTokens} tokens</span>
                        <span class="batch-plan-chip">${judgeNumCtx.toLocaleString()} judge ctx</span>
                    </div>
                </div>
            </div>
        `;
    }

    const judgeModel = plan.judge_model || state.currentJudgeConfig.model || '(server default)';
    const modeIcon = executionMode === 'throughput' ? '\uD83D\uDD25' : '\u26A1';
    const modeLabel = executionMode === 'throughput' ? 'Throughput Mode' : 'Latency Mode';
    const execConfig = plan.execution_config || state.currentExecutionConfig || {};
    const maxTokens = execConfig.response_max_tokens || 32000;
    const hasLengthHint = execConfig.include_length_hint;
    const hasCustomHint = execConfig.custom_hint && execConfig.custom_hint.trim();
    const categories = Array.isArray(plan.categories) ? plan.categories : [];
    const {
        totalCategoryPrompts,
        projectedTests,
        categoryCount
    } = resolveWorkloadSummary(plan, categories);

    let html = '';

    // Resolve judge host label for the plan header
    const planJudgeHostRaw = (Array.isArray(plan.exec_hosts) && plan.exec_hosts[0])
        ? plan.exec_hosts[0].judge_host : null;
    const planJudgeHostLabel = planJudgeHostRaw
        ? (() => {
            const known = (state.ollamaHosts || []).find(h => h.url === planJudgeHostRaw);
            return known ? known.name : planJudgeHostRaw.replace(/^https?:\/\//, '').replace(/:11434$/, '');
        })()
        : '(not set)';
    const planJudgeNumCtx = Number(plan.judge_num_ctx || (state.currentJudgeConfig && state.currentJudgeConfig.num_ctx) || 8192);
    const planConcurrency = (state.currentJudgeConfig && state.currentJudgeConfig.concurrency) || 2;
    const planTimeoutSec = Math.round(((state.currentJudgeConfig && state.currentJudgeConfig.timeout) || 120000) / 1000);
    const hintParts = [];
    if (hasLengthHint) hintParts.push('Length');
    if (hasCustomHint) hintParts.push('Custom');

    html += `<div class="batch-plan-shell">`;
    html += `<div class="batch-plan-header">`;
    html += `<div class="batch-plan-title">`;
    html += `<strong>Active batch configuration</strong>`;
    html += `<span class="batch-plan-chip is-emphasis"><i class="fas fa-gavel"></i>${escapeHtml(judgeModel)}</span>`;
    html += `<span class="batch-plan-chip is-success">Pinned judge</span>`;
    html += `<span class="batch-plan-chip is-host" title="${escapeHtml(planJudgeHostRaw || '(not set)')}"><i class="fas fa-server"></i>${escapeHtml(planJudgeHostLabel)}</span>`;
    html += `</div>`;
    html += `<div class="batch-plan-meta">`;
    html += `<span class="batch-plan-chip">${modeIcon} ${modeLabel}</span>`;
    html += `<span class="batch-plan-chip">Max ${maxTokens} tokens</span>`;
    html += `<span class="batch-plan-chip"><i class="fas fa-ruler-horizontal"></i>${planJudgeNumCtx.toLocaleString()} judge ctx</span>`;
    html += `<span class="batch-plan-chip"><i class="fas fa-layer-group"></i>×${planConcurrency} concurrent</span>`;
    html += `<span class="batch-plan-chip"><i class="fas fa-clock"></i>${planTimeoutSec}s timeout</span>`;
    if (hintParts.length) {
        html += `<span class="batch-plan-chip"><i class="fas fa-magic"></i>Hints: ${hintParts.join(' + ')}</span>`;
    }
    html += `</div>`;
    html += `</div>`;

    html += `<div class="batch-plan-grid">`;
    html += `<div class="batch-plan-section">`;
    html += `<div class="batch-plan-section-header"><i class="fas fa-chart-pie"></i>Run Snapshot</div>`;
    html += `<div class="batch-plan-section-body">`;
    html += `<div class="batch-plan-stats">`;
    html += `<div class="batch-plan-stat"><div class="batch-plan-stat-label">Categories</div><div class="batch-plan-stat-value">${categoryCount}</div></div>`;
    html += `<div class="batch-plan-stat"><div class="batch-plan-stat-label">Prompts</div><div class="batch-plan-stat-value">${totalCategoryPrompts}</div></div>`;
    html += `<div class="batch-plan-stat"><div class="batch-plan-stat-label">Projected Tests</div><div class="batch-plan-stat-value">${projectedTests}</div></div>`;
    html += `</div>`;
    html += `</div>`;
    html += `</div>`;

    html += `<div class="batch-plan-section">`;
    html += `<div class="batch-plan-section-header"><i class="fas fa-network-wired"></i>Execution Nodes</div>`;
    html += `<div class="batch-plan-section-body">`;
    if (Array.isArray(plan.exec_hosts) && plan.exec_hosts.length > 0) {
        html += `<div class="batch-node-list">`;
        for (const h of plan.exec_hosts) {
            const execLabel = formatHostLabel(h.exec_host);
            const judgeLabel = formatHostLabel(h.judge_host);
            const nodeModelCount = Array.isArray(h.models) ? h.models.length : 0;
            html += `<div class="batch-node-card">`;
            html += `<div class="batch-node-hosts">`;
            html += `<div><span class="batch-node-host-label">Execution Host</span><div class="batch-node-host-value">${escapeHtml(execLabel)}</div></div>`;
            html += `<div><span class="batch-node-host-label">Judge Host</span><div class="batch-node-host-value">${escapeHtml(judgeLabel)}</div></div>`;
            html += `</div>`;
            html += `<div class="batch-node-metrics">`;
            html += `<span class="batch-node-metric">${nodeModelCount} models</span>`;
            html += `<span class="batch-node-metric">${h.tests} tests</span>`;
            html += `</div>`;
            html += `</div>`;
        }
        html += `</div>`;
    } else {
        html += `<div class="batch-plan-stat-label">No execution nodes resolved yet.</div>`;
    }
    html += `</div>`;
    html += `</div>`;

    if (categories.length > 0) {
        html += `<div class="batch-plan-section" style="grid-column: 1 / -1;">`;
        html += `<div class="batch-plan-section-header"><i class="fas fa-table-list"></i>Workload Breakdown</div>`;
        html += `<div class="batch-plan-section-body">`;
        html += `<div style="overflow-x:auto;">`;
        html += `<table class="batch-workload-table">`;
        html += `<thead><tr><th>Category</th><th class="num">Prompts</th><th class="num">Models</th><th class="num">Total Tests</th></tr></thead>`;
        html += `<tbody>`;
        for (const c of categories) {
            const categoryLabel = escapeHtml(String(c.category || 'uncategorized'));
            const promptCount = Number(c.prompt_count) || 0;
            html += `<tr>`;
            html += `<td><span class="batch-workload-category">${categoryLabel}</span></td>`;
            html += `<td class="num">${promptCount}</td>`;
            html += `<td class="num">${plan.total_models}</td>`;
            html += `<td class="num">${c.tests}</td>`;
            html += `</tr>`;
        }
        html += `</tbody></table></div></div></div>`;
    }

    html += `</div></div>`;
    return html;
}

// ─── Anomaly Thresholds ────────────────────────────────────────────

/**
 * Get anomaly thresholds from localStorage
 */
export function getAnomalyThresholds() {
    const defaults = {
        exec_fail_pct: 10,
        judge_fail_pct: 5,
        lag_factor: 5,
        avg_near_timeout_pct: 80,
        model_min_n: 5,
        model_exec_out_pct: 20,
        model_judge_out_pct: 10,
        model_tps_below_median_pct: 30,
        model_judge_ms_above_median_pct: 50
    };
    try {
        const raw = localStorage.getItem('benchmarkAnomalyThresholds');
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        return { ...defaults, ...(parsed || {}) };
    } catch {
        return defaults;
    }
}

export function setAnomalyThresholds(next) {
    localStorage.setItem('benchmarkAnomalyThresholds', JSON.stringify(next));
}

export function hydrateThresholdInputs() {
    const t = getAnomalyThresholds();
    const map = [
        ['thrExecFail', 'exec_fail_pct'],
        ['thrJudgeFail', 'judge_fail_pct'],
        ['thrLagFactor', 'lag_factor'],
        ['thrAvgNearTimeout', 'avg_near_timeout_pct'],
        ['thrModelMinN', 'model_min_n'],
        ['thrModelExecOut', 'model_exec_out_pct'],
        ['thrModelJudgeOut', 'model_judge_out_pct'],
        ['thrModelTpsBelowMed', 'model_tps_below_median_pct'],
        ['thrModelJudgeMsAboveMed', 'model_judge_ms_above_median_pct']
    ];
    for (const [id, key] of map) {
        const el = document.getElementById(id);
        if (el) el.value = String(t[key]);
    }
}

export function bindThresholdInputs() {
    const container = document.getElementById('hyperThresholds');
    if (!container || container.dataset.bound) return;
    container.addEventListener('change', () => {
        const t = getAnomalyThresholds();
        const readNum = (id, fallback) => {
            const el = document.getElementById(id);
            const v = el ? Number(el.value) : NaN;
            return Number.isFinite(v) ? v : fallback;
        };
        const next = {
            exec_fail_pct: readNum('thrExecFail', t.exec_fail_pct),
            judge_fail_pct: readNum('thrJudgeFail', t.judge_fail_pct),
            lag_factor: readNum('thrLagFactor', t.lag_factor),
            avg_near_timeout_pct: readNum('thrAvgNearTimeout', t.avg_near_timeout_pct),
            model_min_n: readNum('thrModelMinN', t.model_min_n),
            model_exec_out_pct: readNum('thrModelExecOut', t.model_exec_out_pct),
            model_judge_out_pct: readNum('thrModelJudgeOut', t.model_judge_out_pct),
            model_tps_below_median_pct: readNum('thrModelTpsBelowMed', t.model_tps_below_median_pct),
            model_judge_ms_above_median_pct: readNum('thrModelJudgeMsAboveMed', t.model_judge_ms_above_median_pct)
        };
        setAnomalyThresholds(next);
    });
    const resetBtn = document.getElementById('resetThresholdsBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            localStorage.removeItem('benchmarkAnomalyThresholds');
            hydrateThresholdInputs();
        });
    }
    container.dataset.bound = 'true';
}

// ─── Advanced / Hyper mode ─────────────────────────────────────────

export function setAdvancedMode(showAdvanced) {
    localStorage.setItem('benchmarkShowAdvanced', showAdvanced ? 'true' : 'false');
    if (!showAdvanced) {
        localStorage.setItem('benchmarkShowHyper', 'false');
    }

    const advancedDetails = document.getElementById('advancedBatchDetails');
    const hyperDetails = document.getElementById('hyperBatchDetails');
    const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
    const toggleHyperBtn = document.getElementById('toggleHyperBtn');
    const judgeHealthContainer = document.getElementById('judgeHealthContainer');
    const perModelContainer = document.getElementById('perModelProgressContainer');

    if (toggleAdvancedBtn) toggleAdvancedBtn.textContent = showAdvanced ? 'Hide details' : 'Show details';
    if (toggleHyperBtn) toggleHyperBtn.style.display = showAdvanced ? 'inline-block' : 'none';
    if (advancedDetails) advancedDetails.style.display = showAdvanced ? 'block' : 'none';
    if (!showAdvanced) {
        if (judgeHealthContainer) judgeHealthContainer.style.display = 'none';
        if (perModelContainer) perModelContainer.style.display = 'none';
    }

    const showHyper = localStorage.getItem('benchmarkShowHyper') === 'true';
    if (toggleHyperBtn) toggleHyperBtn.textContent = showHyper ? 'Hide hyper details' : 'Show hyper details';
    if (hyperDetails) hyperDetails.style.display = (showAdvanced && showHyper) ? 'block' : 'none';
}

export function setHyperMode(showHyper) {
    localStorage.setItem('benchmarkShowHyper', showHyper ? 'true' : 'false');
    const toggleHyperBtn = document.getElementById('toggleHyperBtn');
    const hyperDetails = document.getElementById('hyperBatchDetails');
    if (toggleHyperBtn) toggleHyperBtn.textContent = showHyper ? 'Hide hyper details' : 'Show hyper details';
    if (hyperDetails) {
        const showAdvanced = localStorage.getItem('benchmarkShowAdvanced') === 'true';
        hyperDetails.style.display = (showAdvanced && showHyper) ? 'block' : 'none';
    }
}
