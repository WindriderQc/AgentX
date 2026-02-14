// batch-config.js - Batch configuration, depth matrix, level/model matrix

import * as state from './state.js';
import { escapeHtml, formatHostLabel, inferOppositeHostUrl } from './utils.js';

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
 */
export function renderDepthMatrix() {
    const tbody = document.getElementById('depthMatrixBody');
    if (!tbody) return;

    const config = getDepthConfig();
    let html = '';

    for (let level = 1; level <= 10; level++) {
        const currentDepth = config[level] || 'light';
        const est = calculatePromptCount(level, currentDepth);
        const label = LEVEL_LABELS[level] || '';

        html += `<tr data-level="${level}">`;
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
            summaryEl.textContent = `~${totalPrompts} prompts across ${selectedLevels.length} levels (${levelsStr})`;
        }
    }

    const batchModelCountEl = document.getElementById('batchModelCount');
    if (batchModelCountEl) {
        batchModelCountEl.textContent = modelCount;
    }

    const info = document.getElementById('batchInfo');
    if (info) {
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
export function renderBatchPlan(plan, fallbackHostUrl, qualityScoringEnabled, executionMode = 'latency') {
    if (!plan) {
        const judgeModel = state.currentJudgeConfig.model || '(server default)';
        const exec = fallbackHostUrl ? formatHostLabel(fallbackHostUrl) : '(unknown)';
        const judgeHostUrl = qualityScoringEnabled
            ? (state.currentJudgeConfig.judge_same_host ? fallbackHostUrl : inferOppositeHostUrl(fallbackHostUrl, state.ollamaHosts))
            : null;
        const judgeHost = qualityScoringEnabled ? formatHostLabel(judgeHostUrl) : 'Disabled';

        const modeIcon = executionMode === 'throughput' ? '\uD83D\uDD25' : '\u26A1';
        const modeLabel = executionMode === 'throughput' ? 'Throughput Mode' : 'Latency Mode';
        const modeColor = executionMode === 'throughput' ? 'warning' : 'info';
        const execConfig = state.currentExecutionConfig || {};
        const maxTokens = execConfig.response_max_tokens || 32000;

        return `
            <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                <span class="badge bg-light text-dark border">Exec: ${exec}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-light text-dark border">Judge: ${judgeModel}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-light text-dark border">Judge Host: ${judgeHost}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-${modeColor} text-dark">${modeIcon} ${modeLabel}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-light text-dark border">Max: ${maxTokens} tokens</span>
            </div>
        `;
    }

    const judgeModel = plan.judge_model || state.currentJudgeConfig.model || '(server default)';
    const modeIcon = executionMode === 'throughput' ? '\uD83D\uDD25' : '\u26A1';
    const modeLabel = executionMode === 'throughput' ? 'Throughput Mode' : 'Latency Mode';
    const modeColor = executionMode === 'throughput' ? 'warning' : 'info';
    const execConfig = plan.execution_config || state.currentExecutionConfig || {};
    const maxTokens = execConfig.response_max_tokens || 32000;
    const hasLengthHint = execConfig.include_length_hint;
    const hasCustomHint = execConfig.custom_hint && execConfig.custom_hint.trim();
    const hasAnyHint = hasLengthHint || hasCustomHint;
    const categories = Array.isArray(plan.categories) ? plan.categories : [];
    const {
        totalCategoryPrompts,
        projectedTests,
        categoryCount
    } = resolveWorkloadSummary(plan, categories);

    let html = '';

    html += `<div class="d-flex align-items-center mb-3 p-2 bg-light rounded border flex-wrap gap-1">`;
    html += `<i class="fas fa-gavel me-2 text-primary"></i>`;
    html += `<strong class="me-2">Judge Model:</strong>`;
    html += `<span class="badge bg-primary me-2">${judgeModel}</span>`;
    if (!qualityScoringEnabled) {
        html += `<span class="badge bg-danger me-2">Disabled</span>`;
    }
    html += `<span class="text-muted me-2">-</span>`;
    html += `<span class="badge bg-${modeColor} text-dark">${modeIcon} ${modeLabel}</span>`;
    html += `<span class="text-muted mx-2">-</span>`;
    html += `<span class="badge bg-light text-dark border">Max: ${maxTokens} tokens</span>`;
    if (hasAnyHint) {
        html += `<span class="text-muted mx-2">-</span>`;
        html += `<span class="badge" style="background: rgba(155, 89, 182, 0.2); color: #9b59b6; border: 1px solid rgba(155, 89, 182, 0.4);">`;
        html += `<i class="fas fa-magic"></i> Hints: `;
        const hintParts = [];
        if (hasLengthHint) hintParts.push('Length');
        if (hasCustomHint) hintParts.push('Custom');
        html += hintParts.join(' + ');
        html += `</span>`;
    }
    html += `</div>`;

    html += `<div class="card mb-3 shadow-0 border">`;
    html += `<div class="card-header py-2 bg-light"><strong>Run Snapshot</strong></div>`;
    html += `<div class="card-body py-2">`;
    html += `<div class="d-flex flex-wrap gap-2">`;
    html += `<span class="badge bg-light text-dark border">Categories: ${categoryCount}</span>`;
    html += `<span class="badge bg-light text-dark border">Prompts: ${totalCategoryPrompts}</span>`;
    html += `<span class="badge bg-light text-dark border">Projected Tests: ${projectedTests}</span>`;
    html += `</div>`;
    html += `</div></div>`;

    if (Array.isArray(plan.exec_hosts) && plan.exec_hosts.length > 0) {
        html += `<div class="card mb-3 shadow-0 border">`;
        html += `<div class="card-header py-2 bg-light"><strong>Execution Nodes</strong></div>`;
        html += `<ul class="list-group list-group-flush">`;
        for (const h of plan.exec_hosts) {
            const execLabel = formatHostLabel(h.exec_host);
            const judgeLabel = qualityScoringEnabled ? formatHostLabel(h.judge_host) : 'Disabled';
            const modelCount = Array.isArray(h.models) ? h.models.length : 0;
            html += `<li class="list-group-item p-2">`;
            html += `<div class="row align-items-center g-2">`;
            html += `<div class="col-md-5"><small class="text-muted d-block">Execution Host</small><span class="text-break font-monospace" style="font-size: 0.9em;">${execLabel}</span></div>`;
            html += `<div class="col-md-5"><small class="text-muted d-block">Judge Host</small><span class="text-break font-monospace" style="font-size: 0.9em;">${judgeLabel}</span></div>`;
            html += `<div class="col-md-2 text-end">`;
            html += `<span class="badge bg-secondary mb-1 d-inline-block" title="Models">${modelCount} models</span><br>`;
            html += `<span class="badge bg-info text-dark" title="Tests">${h.tests} tests</span>`;
            html += `</div></div></li>`;
        }
        html += `</ul></div>`;
    }

    if (categories.length > 0) {
        html += `<div class="card shadow-0 border">`;
        html += `<div class="card-header py-2 bg-light"><strong>Workload Breakdown</strong></div>`;
        html += `<div class="table-responsive">`;
        html += `<table class="table table-sm table-striped mb-0 align-middle" style="font-size: 0.9em;">`;
        html += `<thead class="table-light"><tr><th>Category</th><th class="text-center">Prompts</th><th class="text-center">Models</th><th class="text-end">Total Tests</th></tr></thead>`;
        html += `<tbody>`;
        for (const c of categories) {
            const categoryLabel = escapeHtml(String(c.category || 'uncategorized'));
            const promptCount = Number(c.prompt_count) || 0;
            html += `<tr>`;
            html += `<td class="fw-bold"><span class="badge bg-light text-dark border text-capitalize">${categoryLabel}</span></td>`;
            html += `<td class="text-center"><span class="badge bg-light text-dark">${promptCount}</span></td>`;
            html += `<td class="text-center">${plan.total_models}</td>`;
            html += `<td class="text-end fw-bold">${c.tests}</td>`;
            html += `</tr>`;
        }
        html += `</tbody></table></div></div>`;
    }

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
