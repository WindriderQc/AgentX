// batch-config.js - Batch configuration, presets, level/model matrix

import * as state from './state.js';
import { escapeHtml, formatHostLabel, inferOppositeHostUrl } from './utils.js';

// Preset configurations
export const BENCHMARK_PRESETS = {
    quick: {
        name: 'Quick Test',
        levels: [1, 2, 3, 4],
        description: '20 prompts, levels 1-4',
        estimatedTime: '~5 minutes',
        details: [
            '20 prompts, levels 1-4',
            'Core categories only (coding, reasoning, factual)',
            'Estimated time: ~5 minutes'
        ]
    },
    standard: {
        name: 'Standard Benchmark',
        levels: [3, 4, 5, 6, 7],
        description: '60 prompts, levels 3-7',
        estimatedTime: '~15 minutes',
        details: [
            '60 prompts, levels 3-7',
            'All 12 categories (5 prompts each)',
            'Recommended for most models',
            'Estimated time: ~15 minutes'
        ]
    },
    comprehensive: {
        name: 'Comprehensive Benchmark',
        levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        description: '120 prompts, levels 1-10',
        estimatedTime: '~45 minutes',
        details: [
            '120 prompts, levels 1-10',
            'All 12 categories (10 prompts each)',
            'For detailed model profiling',
            'Estimated time: ~45 minutes'
        ]
    },
    overkill: {
        name: 'Overkill Benchmark',
        levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        description: '240 prompts, levels 1-10 (with variations)',
        estimatedTime: '~2 hours',
        details: [
            '240 prompts, levels 1-10 (with variations)',
            'All 12 categories, multiple samples per level',
            'For exhaustive testing and leaderboards',
            'Estimated time: ~2 hours'
        ]
    }
};

/**
 * Update batch info display
 */
export function updateBatchInfo() {
    const selectedLevels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(l => {
        const el = document.getElementById(`level${l}`);
        return !!(el && el.checked);
    });
    const selectedModels = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'));

    const batchModelCountEl = document.getElementById('batchModelCount');
    if (batchModelCountEl) {
        batchModelCountEl.textContent = selectedModels.length;
    }

    // Each level has 4 prompts (from our seed data)
    const promptsPerLevel = 4;
    const totalTests = selectedLevels.length * promptsPerLevel * selectedModels.length;

    const info = document.getElementById('batchInfo');
    if (info) {
        if (totalTests > 0) {
            info.textContent = `${selectedModels.length} models x ${selectedLevels.length} levels (${selectedLevels.length * promptsPerLevel} prompts) = ${totalTests} tests`;
        } else {
            info.textContent = 'Select levels and models to start';
        }
    }
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
        const capsLabel = (execConfig.response_max_tokens || execConfig.response_tokens_multiplier)
            ? `Caps: min ${execConfig.response_min_tokens || '-'} / max ${execConfig.response_max_tokens || '-'} / x${execConfig.response_tokens_multiplier || '-'}`
            : null;
        const hintLabel = execConfig.include_length_hint ? 'Length hint: on' : 'Length hint: off';

        return `
            <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                <span class="badge bg-light text-dark border">Exec: ${exec}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-light text-dark border">Judge: ${judgeModel}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-light text-dark border">Judge Host: ${judgeHost}</span>
                <span class="text-muted">-</span>
                <span class="badge bg-${modeColor} text-dark">${modeIcon} ${modeLabel}</span>
                ${capsLabel ? `<span class="text-muted">-</span><span class="badge bg-light text-dark border">${capsLabel}</span>` : ''}
                <span class="text-muted">-</span>
                <span class="badge bg-light text-dark border">${hintLabel}</span>
            </div>
        `;
    }

    const judgeModel = plan.judge_model || state.currentJudgeConfig.model || '(server default)';
    const modeIcon = executionMode === 'throughput' ? '\uD83D\uDD25' : '\u26A1';
    const modeLabel = executionMode === 'throughput' ? 'Throughput Mode' : 'Latency Mode';
    const modeColor = executionMode === 'throughput' ? 'warning' : 'info';
    const execConfig = plan.execution_config || state.currentExecutionConfig || {};
    const capsLabel = (execConfig.response_max_tokens || execConfig.response_tokens_multiplier)
        ? `Caps: min ${execConfig.response_min_tokens || '-'} / max ${execConfig.response_max_tokens || '-'} / x${execConfig.response_tokens_multiplier || '-'}`
        : null;
    const hintLabel = execConfig.include_length_hint ? 'Length hint: on' : 'Length hint: off';

    let html = '';

    // 1. Judge Info Header with Execution Mode
    html += `<div class="d-flex align-items-center mb-3 p-2 bg-light rounded border">`;
    html += `<i class="fas fa-gavel me-2 text-primary"></i>`;
    html += `<strong class="me-2">Judge Model:</strong>`;
    html += `<span class="badge bg-primary me-2">${judgeModel}</span>`;
    if (!qualityScoringEnabled) {
        html += `<span class="badge bg-danger me-2">Disabled</span>`;
    }
    html += `<span class="text-muted me-2">-</span>`;
    html += `<span class="badge bg-${modeColor} text-dark">${modeIcon} ${modeLabel}</span>`;
    if (capsLabel) {
        html += `<span class="text-muted mx-2">-</span>`;
        html += `<span class="badge bg-light text-dark border">${capsLabel}</span>`;
    }
    html += `<span class="text-muted mx-2">-</span>`;
    html += `<span class="badge bg-light text-dark border">${hintLabel}</span>`;
    html += `</div>`;

    // 2. Execution Nodes
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
            html += `</div>`;
            html += `</div>`;
            html += `</li>`;
        }
        html += `</ul></div>`;
    }

    // 3. Workload Breakdown
    if (Array.isArray(plan.categories) && plan.categories.length > 0) {
        html += `<div class="card shadow-0 border">`;
        html += `<div class="card-header py-2 bg-light"><strong>Workload Breakdown</strong></div>`;
        html += `<div class="table-responsive">`;
        html += `<table class="table table-sm table-striped mb-0 align-middle" style="font-size: 0.9em;">`;
        html += `<thead class="table-light"><tr><th>Category</th><th class="text-center">Prompts</th><th class="text-center">Models</th><th class="text-end">Total Tests</th></tr></thead>`;
        html += `<tbody>`;

        for (const c of plan.categories) {
            html += `<tr>`;
            html += `<td class="fw-bold text-capitalize">${c.category}</td>`;
            html += `<td class="text-center">${c.prompt_count}</td>`;
            html += `<td class="text-center">${plan.total_models}</td>`;
            html += `<td class="text-end fw-bold">${c.tests}</td>`;
            html += `</tr>`;
        }

        html += `</tbody></table></div></div>`;
    }

    return html;
}

/**
 * Apply level preset
 */
export function applyLevelPreset(preset) {
    let levelsToSelect = [];

    switch (preset) {
        case 'all':
            levelsToSelect = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            break;
        case 'basic':
            levelsToSelect = [1, 2, 3, 4];
            break;
        case 'intermediate':
            levelsToSelect = [3, 4, 5, 6, 7];
            break;
        case 'advanced':
            levelsToSelect = [6, 7, 8, 9, 10];
            break;
    }

    // Uncheck all first
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`level${i}`);
        if (checkbox) checkbox.checked = false;
    }

    // Check selected levels
    levelsToSelect.forEach(level => {
        const checkbox = document.getElementById(`level${level}`);
        if (checkbox) checkbox.checked = true;
    });

    updateLevelsSummary();
    updateBatchInfo();
}

/**
 * Apply preset levels from BENCHMARK_PRESETS
 */
export function applyPresetLevels(levels) {
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`level${i}`);
        if (checkbox) checkbox.checked = false;
    }

    levels.forEach(level => {
        const checkbox = document.getElementById(`level${level}`);
        if (checkbox) checkbox.checked = true;
    });

    updateLevelsSummary();
    updateBatchInfo();
}

/**
 * Update levels summary display
 */
export function updateLevelsSummary() {
    const selectedLevels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(l => {
        const el = document.getElementById(`level${l}`);
        return !!(el && el.checked);
    });

    const summaryEl = document.getElementById('levelsSummary');
    if (summaryEl) {
        if (selectedLevels.length === 0) {
            summaryEl.textContent = 'No levels selected';
        } else if (selectedLevels.length === 10) {
            summaryEl.textContent = 'All 10 levels selected (1-10)';
        } else {
            const levelStr = selectedLevels.join(', ');
            summaryEl.textContent = `${selectedLevels.length} level${selectedLevels.length > 1 ? 's' : ''} selected (${levelStr})`;
        }
    }
}

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

/**
 * Set anomaly thresholds in localStorage
 */
export function setAnomalyThresholds(next) {
    localStorage.setItem('benchmarkAnomalyThresholds', JSON.stringify(next));
}

/**
 * Hydrate threshold inputs from localStorage
 */
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

/**
 * Bind threshold input handlers
 */
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

/**
 * Set advanced mode
 */
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

/**
 * Set hyper mode
 */
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
