// batch-execution.js - runBatch, pollBatchProgress orchestration

import * as state from './state.js';
import { getWorkspaceHeaders } from './api.js';
import { startBatchTest, stopBatchTest, fetchBatchProgress, fetchActiveBatches, recoverBatchApi, fetchBatchHistory, validateJudgeModelApi } from './api.js';
import { renderBatchPlan, setAdvancedMode, setHyperMode, getAnomalyThresholds, hydrateThresholdInputs, bindThresholdInputs, getDepthConfig, getSelectedLevels } from './batch-config.js';
import { hasTierMismatch } from './judge-mismatch.js';
import { escapeHtml, formatDuration, toFiniteNumber, summarizeNumbers, countBy, topCounts, formatHostLabel, findRowByAttr } from './utils.js';
import { updateTimeline, resetTimelineState } from './timeline.js';
import { pickRepresentativeResultId, pickRepresentativeResultIdForModel } from './results-analysis.js';
import { showJudgeDetails } from './judge-details.js';
import { buildBatchScoringBar } from './results-table.js';

/**
 * Gather execution config from form inputs
 * Merges with current config from server
 */
function gatherExecutionConfig() {
    const config = { ...state.currentExecutionConfig };

    // Hint settings from the prominent hints panel
    const lengthEnabled = document.getElementById('hintLengthEnabled');
    const lengthTemplate = document.getElementById('hintLengthTemplate');
    const customHint = document.getElementById('hintCustomText');

    if (lengthEnabled) {
        config.include_length_hint = lengthEnabled.checked;
    }
    if (lengthTemplate && lengthTemplate.value.trim()) {
        config.length_hint_template = lengthTemplate.value.trim();
    }
    if (customHint) {
        config.custom_hint = customHint.value.trim();
    }

    // Also read from settings modal if present (for backwards compatibility)
    const execTokenMax = document.getElementById('execTokenMax');
    const execTokenMin = document.getElementById('execTokenMin');
    const execTokenMultiplier = document.getElementById('execTokenMultiplier');

    if (execTokenMax && execTokenMax.value) {
        config.response_max_tokens = parseInt(execTokenMax.value, 10) || 32000;
    }
    if (execTokenMin && execTokenMin.value) {
        config.response_min_tokens = parseInt(execTokenMin.value, 10) || 100;
    }
    if (execTokenMultiplier && execTokenMultiplier.value) {
        config.response_tokens_multiplier = parseFloat(execTokenMultiplier.value) || 1;
    }

    return config;
}

/**
 * Reset batch UI to initial state
 */
export function resetBatchUI() {
    const btn = document.getElementById('runBatchBtn');
    const stopBtn = document.getElementById('stopBatchBtn');
    const execProgressBar = document.getElementById('execProgressBar');
    const judgeProgressBar = document.getElementById('judgeProgressBar');
    const status = document.getElementById('batchStatus');
    const judgeHealthContainer = document.getElementById('judgeHealthContainer');
    const perModelContainer = document.getElementById('perModelProgressContainer');
    const advancedDetails = document.getElementById('advancedBatchDetails');
    const hyperDetails = document.getElementById('hyperBatchDetails');
    const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
    const toggleHyperBtn = document.getElementById('toggleHyperBtn');
    const batchLastUpdated = document.getElementById('batchLastUpdated');

    if (btn) {
        btn.disabled = false;
        btn.textContent = 'Start Batch Test';
    }
    if (stopBtn) stopBtn.style.display = 'none';

    if (execProgressBar) execProgressBar.classList.remove('active');
    if (judgeProgressBar) judgeProgressBar.classList.remove('active');
    if (status) status.style.display = 'none';
    if (judgeHealthContainer) judgeHealthContainer.style.display = 'none';
    if (perModelContainer) perModelContainer.style.display = 'none';

    if (batchLastUpdated) batchLastUpdated.textContent = '';

    const showAdvanced = localStorage.getItem('benchmarkShowAdvanced') === 'true';
    const showHyper = localStorage.getItem('benchmarkShowHyper') === 'true';
    if (toggleAdvancedBtn) toggleAdvancedBtn.textContent = showAdvanced ? 'Hide details' : 'Show details';
    if (toggleHyperBtn) {
        toggleHyperBtn.style.display = showAdvanced ? 'inline-block' : 'none';
        toggleHyperBtn.textContent = showHyper ? 'Hide hyper details' : 'Show hyper details';
    }
    if (advancedDetails) advancedDetails.style.display = showAdvanced ? 'block' : 'none';
    if (hyperDetails) hyperDetails.style.display = (showAdvanced && showHyper) ? 'block' : 'none';

    if (state.batchPollInterval) {
        clearInterval(state.batchPollInterval);
        state.setBatchPollInterval(null);
    }
    state.setCurrentBatchId(null);
    localStorage.removeItem('currentBatchId');

    const batchInfo = document.getElementById('batchInfo');
    if (batchInfo) batchInfo.innerHTML = '';
}

/**
 * Run batch test
 */
export async function runBatch() {
    const depthConfig = getDepthConfig();
    const selectedLevels = getSelectedLevels(depthConfig);
    const selectedModels = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'))
        .map(cb => cb.value);
    const host = document.getElementById('host')?.value;

    if (selectedLevels.length === 0) {
        alert('Please select at least one prompt level (set depth to something other than Off)');
        return;
    }

    if (selectedModels.length === 0) {
        alert('Please select at least one model');
        return;
    }

    // Hard block: if judge tier is below what selected levels require, refuse to start.
    // The banner (judgeMismatchBanner) already explains what to fix — just ensure it’s
    // visible and scroll to it so the user sees the guidance immediately.
    if (hasTierMismatch(selectedLevels)) {
        // Force-show the blocker banner (in case it was dismissed) and scroll to it.
        // The banner content is already rendered by index.js on any judge/level change.
        const banner = document.getElementById('judgeMismatchBanner');
        if (banner) {
            banner.style.display = 'flex';
            banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return; // do not start
    }

    const btn = document.getElementById('runBatchBtn');
    const stopBtn = document.getElementById('stopBatchBtn');
    const status = document.getElementById('batchStatus');
    const execProgressBar = document.getElementById('execProgressBar');
    const judgeProgressBar = document.getElementById('judgeProgressBar');
    const batchInfo = document.getElementById('batchInfo');

    btn.disabled = true;
    btn.textContent = 'Starting...';
    stopBtn.style.display = 'inline-block';

    status.style.display = 'none';
    execProgressBar.classList.add('active');
    judgeProgressBar.classList.add('active');
    document.getElementById('execProgressFill').style.width = '0%';
    document.getElementById('execProgressText').textContent = 'Exec: 0%';
    document.getElementById('judgeProgressFill').style.width = '0%';
    document.getElementById('judgeProgressText').textContent = 'Judge: 0%';

    const perModelContainer = document.getElementById('perModelProgressContainer');
    if (perModelContainer) perModelContainer.style.display = 'none';

    // Clear previous results and reset timeline state
    document.getElementById('batchResultsContainer').style.display = 'none';
    document.getElementById('batchResultsBody').innerHTML = '';
    state.setCurrentBatchResults([]);
    state.setCurrentJudgeDetailId(null);
    state.setLastTimelineHash(null);
    state.setLastTimelineResultIds(new Set());
    if (batchInfo) batchInfo.innerHTML = '';

    // Immediately blank the timeline so the previous batch doesn't show
    const currentTestIndicator = document.getElementById('currentTestIndicator');
    if (currentTestIndicator) currentTestIndicator.style.display = 'none';
    resetTimelineState();

    // Reset error counter and truncation inspector state for new batch
    pollConsecutiveErrors = 0;
    if (window.BenchmarkAnalytics && typeof window.BenchmarkAnalytics.resetTruncationState === 'function') {
        window.BenchmarkAnalytics.resetTruncationState();
    }

    // Get tags and description
    const tagsInput = document.getElementById('batchTags');
    const descriptionInput = document.getElementById('batchDescription');
    const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t) : [];
    const description = descriptionInput ? descriptionInput.value.trim() : '';

    // Get execution mode
    const executionMode = document.getElementById('executionMode')?.value || 'latency';

    // Gather execution config from form inputs (hints, token limits, etc.)
    const executionConfig = gatherExecutionConfig();

    try {
        // Pre-flight: validate judge model before starting batch
        const judgeHost = state.currentJudgeConfig.host;
        const judgeModel = state.currentJudgeConfig.model;
        if (judgeHost && judgeModel) {
            btn.textContent = 'Validating judge...';
            try {
                const { res: valRes, json: valJson } = await validateJudgeModelApi(judgeHost, judgeModel);
                if (valRes.status === 422) {
                    const availList = (valJson.available_models || []).slice(0, 10).join(', ') || 'none';
                    alert(`Judge model validation failed: ${valJson.error}\n\nAvailable models: ${availList}`);
                    resetBatchUI();
                    return;
                } else if (!valRes.ok) {
                    alert(`Judge validation error: ${valJson.error || valJson.message || 'Unknown error'}`);
                    resetBatchUI();
                    return;
                }
            } catch (valErr) {
                alert(`Judge validation failed: ${valErr.message}`);
                resetBatchUI();
                return;
            }
            btn.textContent = 'Starting...';
        }

        const { res, json } = await startBatchTest({
            host,
            models: selectedModels,
            levels: selectedLevels,
            depth_config: depthConfig,
            judge_config: state.currentJudgeConfig,
            execution_config: executionConfig,
            tags,
            description,
            execution_mode: executionMode
        });

        if (json.status === 'success') {
            state.setCurrentBatchId(json.data.batch_id);
            localStorage.setItem('currentBatchId', json.data.batch_id);
            btn.textContent = 'Running (with quality)...';

            if (batchInfo) {
                batchInfo.innerHTML = renderBatchPlan(json.data.plan, host, true, executionMode);
            }

            // Poll for progress
            const interval = setInterval(pollBatchProgress, 2000);
            state.setBatchPollInterval(interval);
        } else if (res.status === 422) {
            // Show inline error in batchInfo so user sees it with full context
            const batchInfoEl = document.getElementById('batchInfo');
            let errorHtml = '';
            if (json.issues && json.issues.length > 0) {
                const issueItems = json.issues
                    .map(i => `<li style="margin:4px 0;">${escapeHtml(i)}</li>`)
                    .join('');
                errorHtml = `
                    <div style="padding:16px 18px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.5);
                        border-radius:8px;margin-top:10px;">
                        <div style="font-weight:700;color:#e74c3c;margin-bottom:8px;">
                            <i class="fas fa-ban"></i> Batch blocked — preflight failed
                        </div>
                        <ul style="margin:0;padding-left:20px;font-size:0.9em;line-height:1.6;">${issueItems}</ul>
                        <div style="margin-top:10px;font-size:0.85em;color:var(--muted);">
                            Fix the issues above, then try again.
                            <a href="/courthouse.html" target="_blank"
                                style="color:var(--accent);text-decoration:underline;margin-left:6px;">
                                Open Courthouse → Judge Roster
                            </a>
                        </div>
                    </div>`;
            } else if (json.error && json.error.includes('Judge model')) {
                const availList = (json.available_models || []).slice(0, 8).join(', ') || 'none';
                errorHtml = `<div style="padding:14px 16px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.5);
                    border-radius:8px;margin-top:10px;">
                    <strong style="color:#e74c3c;"><i class="fas fa-ban"></i> Judge model not found</strong><br>
                    <span style="font-size:0.9em;">${escapeHtml(json.error)}</span><br>
                    <span style="font-size:0.85em;color:var(--muted);">Available on judge host: ${escapeHtml(availList)}</span>
                </div>`;
            } else {
                const availList = (json.available_models || []).slice(0, 8).join(', ') || 'none';
                errorHtml = `<div style="padding:14px 16px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.5);
                    border-radius:8px;margin-top:10px;">
                    <strong style="color:#e74c3c;"><i class="fas fa-ban"></i> Execution host error</strong><br>
                    <span style="font-size:0.9em;">${escapeHtml(json.error || 'Unknown error')}</span><br>
                    <span style="font-size:0.85em;color:var(--muted);">Available models: ${escapeHtml(availList)}</span>
                </div>`;
            }
            if (batchInfoEl) batchInfoEl.innerHTML = errorHtml;
            resetBatchUI();
            return;
        } else if (res.status === 409) {
            const activeBatch = json.active_batch;
            const message = json.message || 'Another batch is already running';

            if (activeBatch && activeBatch.is_stuck) {
                if (confirm(`${message}\n\nWould you like to recover the stuck batch and try again?`)) {
                    await recoverBatch(activeBatch.id);
                    setTimeout(() => document.getElementById('runBatchBtn').click(), 1000);
                } else {
                    resetBatchUI();
                }
            } else if (activeBatch && activeBatch.id) {
                // Show stop button and resume monitoring the active batch
                state.setCurrentBatchId(activeBatch.id);
                localStorage.setItem('currentBatchId', activeBatch.id);
                btn.disabled = true;
                btn.textContent = `Running (${activeBatch.progress || 0}%)...`;
                stopBtn.style.display = 'inline-block';
                execProgressBar.classList.add('active');
                judgeProgressBar.classList.add('active');

                // Start polling so user sees live progress
                pollBatchProgress();
                const interval = setInterval(pollBatchProgress, 2000);
                state.setBatchPollInterval(interval);
            } else {
                alert(message);
                resetBatchUI();
            }
        } else {
            throw new Error(json.error || 'Failed to start batch');
        }
    } catch (err) {
        status.className = 'status error';
        status.textContent = `Error: ${err.message}`;
        status.style.display = 'block';
        resetBatchUI();
    }
}

/**
 * Stop batch test
 */
export async function stopBatch() {
    if (confirm('Stop current batch? This will clear the local session.')) {
        if (state.currentBatchId) {
            try {
                const res = await stopBatchTest(state.currentBatchId);
                if (res.status === 404) {
                    console.log('Batch already completed or not found');
                } else if (!res.ok) {
                    const json = await res.json().catch(() => ({}));
                    console.warn('Failed to stop batch:', json.error || `HTTP ${res.status}`);
                }
            } catch (e) {
                console.error('Network error stopping batch', e);
            }
        }
        resetBatchUI();
    }
}

let pollConsecutiveErrors = 0;
const POLL_MAX_CONSECUTIVE_ERRORS = 10;

/**
 * Poll batch progress
 */
export async function pollBatchProgress() {
    if (!state.currentBatchId) return;

    try {
        const json = await fetchBatchProgress(state.currentBatchId);
        const batch = json.data;

        if (!batch) {
            throw new Error('No batch data in response');
        }

        pollConsecutiveErrors = 0;

        const showAdvanced = localStorage.getItem('benchmarkShowAdvanced') === 'true';
        const showHyper = localStorage.getItem('benchmarkShowHyper') === 'true';
        const results = Array.isArray(batch.results) ? batch.results : [];

        // Update state
        state.setCurrentBatchResults(results);

        // Update progress bars
        updateProgressBars(batch);

        // Update timeline
        updateTimeline(batch);

        // Update current test indicator
        updateCurrentTestIndicator(batch);
        updateJudgeStatusPanel(batch);

        // Update judge health stats if advanced mode
        if (showAdvanced && batch.judge_stats) {
            updateJudgeHealthStats(batch, results);
        }

        // Update per-model progress if advanced mode
        if (showAdvanced) {
            updatePerModelProgress(batch, results, showHyper);
        }

        // Update batch plan info
        const batchInfo = document.getElementById('batchInfo');
        if (batchInfo && (batch.plan || batch.judge_config || batch.host)) {
            if (batchInfo.innerHTML.trim() === '' || batch.plan) {
                batchInfo.innerHTML = renderBatchPlan(batch.plan, batch.host, true);
            }
        }

        // Update results table
        if (results.length > 0) {
            updateResultsTable(results, batch.results_meta, batch);
        }

        // Update hyper details if enabled
        if (showAdvanced && showHyper) {
            updateHyperDetails(batch, results);
        }

        // Check for terminal state
        const isTerminalState = ['completed', 'stopped', 'failed', 'interrupted'].includes(batch.status);
        if (isTerminalState) {
            handleBatchComplete(batch);
        }
    } catch (err) {
        console.error('Failed to poll batch progress:', err);
        if (err.message.includes('404')) {
            resetBatchUI();
            return;
        }
        pollConsecutiveErrors++;
        if (pollConsecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
            console.error(`Polling stopped after ${POLL_MAX_CONSECUTIVE_ERRORS} consecutive errors`);
            const status = document.getElementById('batchStatus');
            if (status) {
                status.className = 'status error';
                status.textContent = 'Lost connection to batch. Click "Start Batch Test" to retry.';
                status.style.display = 'block';
            }
            resetBatchUI();
        }
    }
}

/**
 * Update progress bars
 */
function updateProgressBars(batch) {
    const clampedProgress = Math.min(Number(batch.progress) || 0, 100);
    const execFill = document.getElementById('execProgressFill');
    const execTextEl = document.getElementById('execProgressText');

    if (execFill && execTextEl) {
        execFill.style.width = `${clampedProgress}%`;
        execFill.style.borderRadius = clampedProgress >= 99 ? '16px' : '16px 0 0 16px';
        execTextEl.textContent = `Exec: ${clampedProgress}% (${batch.completed}/${batch.total_tests})`;
    }

    const judgeTotal = Number(batch.judge_total) || 0;
    const judgeCompleted = Number(batch.judge_completed) || 0;
    const judgeProgressPlanned = Math.min(Number(batch.judge_progress) || 0, 100);

    const judgeFill = document.getElementById('judgeProgressFill');
    const judgeTextEl = document.getElementById('judgeProgressText');
    const judgeBar = document.getElementById('judgeProgressBar');

    if (judgeBar && judgeFill && judgeTextEl) {
        if (judgeTotal > 0) {
            judgeBar.classList.add('active');
            judgeFill.style.width = `${judgeProgressPlanned}%`;
            judgeFill.style.borderRadius = judgeProgressPlanned >= 99 ? '16px' : '16px 0 0 16px';
            judgeTextEl.textContent = `Judge: ${judgeProgressPlanned}% (${judgeCompleted}/${judgeTotal})`;
        } else {
            judgeBar.classList.remove('active');
        }
    }

    const batchLastUpdated = document.getElementById('batchLastUpdated');
    if (batchLastUpdated) {
        batchLastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }
}

/**
 * Update the persistent judge status panel shown during active batch execution
 */
function updateJudgeStatusPanel(batch) {
    const panel = document.getElementById('judgeStatusPanel');
    if (!panel) return;

    const isActive = batch.status === 'running' || batch.status === 'judging';
    if (!isActive) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';

    const cfg = batch.judge_config || {};
    const model = cfg.model || batch.plan?.judge_model || '(default)';
    const hostRaw = cfg.host || null;
    const autoUpgrade = !!cfg.judge_tier_auto_upgrade;
    const concurrency = cfg.concurrency || 2;

    // Resolve judge host label
    let hostLabel = '(auto)';
    if (cfg.judge_same_host) {
        hostLabel = '(same host)';
    } else if (hostRaw) {
        // Try to get short name from known hosts
        const knownHosts = (typeof state !== 'undefined' && state.ollamaHosts) || [];
        const matched = knownHosts.find(h => h.url === hostRaw);
        hostLabel = matched ? matched.name : hostRaw.replace(/^https?:\/\//, '').replace(/:11434$/, '');
    }

    const tierUpgrades = (batch.judge_stats && batch.judge_stats.tier_upgrades) || 0;

    const modelEl = document.getElementById('judgeStatusModel');
    const hostEl = document.getElementById('judgeStatusHost');
    const upgradeEl = document.getElementById('judgeStatusUpgrade');
    const concEl = document.getElementById('judgeStatusConcurrency');
    const scoredEl = document.getElementById('judgeStatusScored');
    const totalEl = document.getElementById('judgeStatusTotal');
    const latEl = document.getElementById('judgeStatusAvgLatency');
    const tierUpgradeEl = document.getElementById('judgeStatusTierUpgrades');

    if (modelEl) modelEl.textContent = model;
    if (hostEl) { hostEl.textContent = hostLabel; hostEl.title = hostRaw || 'auto'; }
    if (upgradeEl) {
        upgradeEl.innerHTML = autoUpgrade
            ? `<span style="background:rgba(231,76,60,0.15);color:#e74c3c;border:1px solid rgba(231,76,60,0.3);border-radius:4px;padding:1px 6px;font-size:0.78em;">⚡ Auto-upgrade ON</span>`
            : `<span style="background:rgba(39,174,96,0.12);color:#27ae60;border:1px solid rgba(39,174,96,0.25);border-radius:4px;padding:1px 6px;font-size:0.78em;">✓ Fixed model</span>`;
    }
    if (concEl) concEl.textContent = `×${concurrency} parallel`;
    if (scoredEl) scoredEl.textContent = String(batch.judge_completed || 0);
    if (totalEl) totalEl.textContent = String(batch.judge_total || 0);
    if (tierUpgradeEl) {
        if (autoUpgrade && tierUpgrades > 0) {
            tierUpgradeEl.style.display = '';
            tierUpgradeEl.innerHTML = `<span title="Number of prompts where a higher-tier judge was auto-selected" ` +
                `style="color:#e74c3c;font-size:0.78em;margin-left:6px;">` +
                `<i class="fas fa-arrow-up"></i> ${tierUpgrades} tier upgrade${tierUpgrades !== 1 ? 's' : ''}</span>`;
        } else {
            tierUpgradeEl.style.display = 'none';
        }
    }

    // Show avg judge latency if available from batch stats
    if (latEl && batch.avg_judge_latency_ms) {
        latEl.textContent = `· avg ${(batch.avg_judge_latency_ms / 1000).toFixed(1)}s/score`;
    } else if (latEl) {
        latEl.textContent = '';
    }
}

/**
 * Update current test indicator
 */
function updateCurrentTestIndicator(batch) {
    const currentTestIndicator = document.getElementById('currentTestIndicator');
    const currentTest = batch.current_test;

    if (currentTest && currentTest.stage === 'warmup' && batch.status === 'running') {
        currentTestIndicator.style.display = 'block';
        document.getElementById('currentTestStage').innerHTML = '<i class="fas fa-fire-alt"></i> Warming up judge model';
        document.getElementById('currentTestModel').textContent = currentTest.model || '';
        document.getElementById('currentTestPrompt').textContent = `Loading on ${currentTest.prompt_name || 'judge host'}…`;
        if (currentTest.started_at) {
            const duration = (Date.now() - new Date(currentTest.started_at).getTime()) / 1000;
            document.getElementById('currentTestDuration').textContent = duration < 10 ? `${duration.toFixed(1)}s` : `${Math.floor(duration)}s`;
        }
    } else if (currentTest && currentTest.model && currentTest.stage !== 'idle' && batch.status === 'running') {
        currentTestIndicator.style.display = 'block';

        const stageIcon = currentTest.stage === 'judging' ? '<i class="fas fa-gavel"></i>' : '<i class="fas fa-cogs"></i>';
        const stageText = currentTest.stage === 'judging' ? 'Judging Response' : 'Executing Test';
        const testNum = currentTest.test_number || (batch.completed + 1);

        document.getElementById('currentTestStage').innerHTML = `${stageIcon} ${stageText} <span style="color: var(--muted); font-weight: 400;">(${testNum}/${batch.total_tests})</span>`;
        document.getElementById('currentTestModel').textContent = currentTest.model || '';
        document.getElementById('currentTestPrompt').textContent = currentTest.prompt_name || currentTest.prompt_id || 'Unknown';

        if (currentTest.started_at) {
            const duration = (Date.now() - new Date(currentTest.started_at).getTime()) / 1000;
            const durationText = duration < 10 ? `${duration.toFixed(1)}s` : `${Math.floor(duration)}s`;
            document.getElementById('currentTestDuration').textContent = durationText;
        }
    } else if (batch.status === 'judging') {
        currentTestIndicator.style.display = 'block';
        document.getElementById('currentTestStage').innerHTML = '<i class="fas fa-gavel"></i> Judging Responses';
        document.getElementById('currentTestModel').textContent = '';
        document.getElementById('currentTestPrompt').textContent = `${batch.judge_completed}/${batch.judge_total} scored`;
        document.getElementById('currentTestDuration').textContent = '';
    } else {
        currentTestIndicator.style.display = 'none';
    }
}

/**
 * Update judge health stats display
 */
function updateJudgeHealthStats(batch, results) {
    const judgeHealthContainer = document.getElementById('judgeHealthContainer');
    const stats = batch.judge_stats;
    const judgeTotal = Number(batch.judge_total) || 0;
    const judgeCompleted = Number(batch.judge_completed) || 0;

    if (!stats || judgeTotal <= 0) {
        if (judgeHealthContainer) judgeHealthContainer.style.display = 'none';
        return;
    }

    const lag = stats.lag || 0;
    const avgTime = stats.avg_time_ms ? (stats.avg_time_ms / 1000).toFixed(2) + 's' : '-';
    const pending = Number.isFinite(stats.pending) ? stats.pending : Math.max(0, judgeTotal - judgeCompleted);
    const judgeFailed = stats.failed || 0;
    const execFailed = stats.exec_failed || 0;

    let healthColor = '#2ecc71';
    let healthIcon = '<i class="fas fa-check-circle"></i>';
    let healthText = 'Healthy';

    if (lag > 10) {
        healthColor = '#e74c3c';
        healthIcon = '<i class="fas fa-exclamation-triangle"></i>';
        healthText = 'Overloaded';
    } else if (lag > 4) {
        healthColor = '#f1c40f';
        healthIcon = '<i class="fas fa-clock"></i>';
        healthText = 'Busy';
    }

    const warmupFallbackCount = stats.warmup_fallback_count || 0;
    const isSameHostFallback = stats.judge_same_host_fallback || false;

    judgeHealthContainer.style.display = 'block';
    judgeHealthContainer.innerHTML = `
        <div class="judge-health-main">
            <div style="color: ${healthColor}; font-weight: 600;">
                ${healthIcon} Judge Status: ${healthText}
            </div>
            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
            <div title="Items waiting to be judged">
                <span style="color: var(--muted);">Queue Lag:</span>
                <span style="font-weight: 600; color: ${lag > 5 ? '#f1c40f' : 'var(--text)'};">${lag}</span>
            </div>
            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
            <div title="Items remaining to be judged">
                <span style="color: var(--muted);">Pending:</span>
                <span style="font-weight: 600;">${pending}</span>
            </div>
            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
            <div title="Judge failures">
                <span style="color: var(--muted);">Judge Failed:</span>
                <span style="font-weight: 600;">${judgeFailed}</span>
            </div>
            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
            <div title="Average time per judgment">
                <span style="color: var(--muted);">Avg Time:</span>
                <span style="font-weight: 600;">${avgTime}</span>
            </div>
            ${isSameHostFallback ? `
            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
            <div title="Cross-host judge warmup failed; judging on same host as execution (may affect latency)">
                <span style="color: #e67e22; font-weight: 600;">
                    <i class="fas fa-exchange-alt"></i> Same-Host Fallback
                </span>
            </div>` : ''}
        </div>
    `;
}

/**
 * Update per-model progress with full stats
 */
function updatePerModelProgress(batch, results, showHyper) {
    const perModelContainer = document.getElementById('perModelProgressContainer');
    if (!perModelContainer) return;

    const configuredModels = Array.isArray(batch.models) && batch.models.length > 0
        ? batch.models.filter(Boolean)
        : [];
    const sampledResultModels = Array.from(new Set(results.map(r => r && r.model).filter(Boolean)));
    const fullCounterModels = batch && batch.per_model_counters
        ? Object.keys(batch.per_model_counters)
        : [];
    const models = Array.from(new Set([...configuredModels, ...fullCounterModels, ...sampledResultModels]));
    const perModelCounters = batch && batch.per_model_counters ? batch.per_model_counters : {};

    // Get planned tests per model from batch plan
    const perModelPlannedFromPlan = batch.plan && batch.plan.tests_per_model
        ? batch.plan.tests_per_model
        : (batch.total_tests && models.length > 0 ? Math.ceil(batch.total_tests / models.length) : 0);

    const isQualityEnabled = true;
    const thresholds = getAnomalyThresholds();
    const minSamples = Math.max(1, Number(thresholds.min_samples) || 3);
    const showHyperDetails = showHyper;

    if (models.length === 0 || perModelPlannedFromPlan <= 0) {
        perModelContainer.style.display = 'none';
        return;
    }

    const isExecFailed = (r) => r && r.success === false;
    const isJudgeDone = (r) => r && r.quality_score !== undefined && r.quality_score !== null;
    const isJudgeFailed = (r) => {
        if (!r) return false;
        const m = String(r.scoring_method || '').toLowerCase();
        return m === 'llm_failed';
    };

    // Median baselines for relative indicators
    const perModelAggForMedian = models.map(model => {
        const modelResults = results.filter(r => r && r.model === model);
        const tpsValues = modelResults
            .map(r => toFiniteNumber(r && r.tokens_per_sec))
            .filter(v => v !== null && v > 0);
        const judgeMsValues = modelResults
            .map(r => toFiniteNumber(r && r.scoring_time_ms))
            .filter(v => v !== null && v > 0);
        const avgTps = tpsValues.length > 0 ? (tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length) : null;
        const avgJudgeMs = judgeMsValues.length > 0 ? (judgeMsValues.reduce((sum, v) => sum + v, 0) / judgeMsValues.length) : null;
        return { model, avgTps, tpsN: tpsValues.length, avgJudgeMs, judgeMsN: judgeMsValues.length };
    });

    const medianBaseline = (values) => {
        const xs = (Array.isArray(values) ? values : []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
        if (xs.length === 0) return null;
        const mid = Math.floor(xs.length / 2);
        return (xs.length % 2 === 1) ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    };

    const tpsMedianModelAvg = medianBaseline(perModelAggForMedian.map(x => x.avgTps).filter(v => Number.isFinite(v) && v > 0));
    const judgeMsMedianModelAvg = medianBaseline(perModelAggForMedian.map(x => x.avgJudgeMs).filter(v => Number.isFinite(v) && v > 0));

    const rows = models.map(model => {
        const modelResults = results.filter(r => r && r.model === model);
        const fullModelCounters = perModelCounters[model] || null;
        const execDone = Number.isFinite(fullModelCounters && fullModelCounters.exec_done)
            ? fullModelCounters.exec_done
            : modelResults.length;
        const execFailed = Number.isFinite(fullModelCounters && fullModelCounters.exec_failed)
            ? fullModelCounters.exec_failed
            : modelResults.filter(isExecFailed).length;
        const execPct = Math.min(100, Math.round((execDone / perModelPlannedFromPlan) * 100));

        const judgeDone = isQualityEnabled
            ? (
                Number.isFinite(fullModelCounters && fullModelCounters.judge_done)
                    ? fullModelCounters.judge_done
                    : modelResults.filter(isJudgeDone).length
            )
            : 0;
        const judgeFailed = isQualityEnabled
            ? (
                Number.isFinite(fullModelCounters && fullModelCounters.judge_failed)
                    ? fullModelCounters.judge_failed
                    : modelResults.filter(isJudgeFailed).length
            )
            : 0;
        const judgePct = isQualityEnabled
            ? Math.min(100, Math.round((judgeDone / perModelPlannedFromPlan) * 100))
            : 0;

        const judgeEffPct = (isQualityEnabled && execDone > 0)
            ? Math.min(100, Math.round((judgeDone / execDone) * 100))
            : 0;

        const execBar = `
            <div style="height: 10px; background: rgba(255,255,255,0.06); border: 1px solid var(--panel-border); border-radius: 999px; overflow: hidden;">
                <div style="height: 100%; width: ${execPct}%; background: var(--accent);"></div>
            </div>
            <div style="margin-top: 4px; color: var(--muted); font-size: 0.85em;">${execDone}/${perModelPlannedFromPlan} (fail ${execFailed})</div>
        `;

        const judgeBar = isQualityEnabled ? `
            <div style="height: 10px; background: rgba(255,255,255,0.06); border: 1px solid var(--panel-border); border-radius: 999px; overflow: hidden;">
                <div style="height: 100%; width: ${judgePct}%; background: var(--accent-2);"></div>
            </div>
            <div style="margin-top: 4px; color: var(--muted); font-size: 0.85em;">${judgeDone}/${perModelPlannedFromPlan} (eff ${judgeEffPct}% • fail ${judgeFailed})</div>
        ` : `<div style="color: var(--muted);">Disabled</div>`;

        const latencyAgg = summarizeNumbers(modelResults.map(r => r && r.latency));
        const tpsAgg = summarizeNumbers(modelResults.map(r => r && r.tokens_per_sec).filter(v => Number(v) > 0));
        const judgeAgg = summarizeNumbers(modelResults.map(r => r && r.scoring_time_ms).filter(v => Number(v) > 0));
        const qualityAgg = summarizeNumbers(modelResults.map(r => r && r.quality_score));

        const execHostCounts = countBy(modelResults, (r) => r && r.host ? formatHostLabel(r.host) : null);
        const judgeHostCounts = countBy(modelResults, (r) => r && r.judge_host ? formatHostLabel(r.judge_host) : null);
        const methodCounts = countBy(modelResults, (r) => (r && r.scoring_method) ? String(r.scoring_method).toLowerCase() : null);
        const promptLevelCounts = countBy(modelResults, (r) => (r && r.prompt_level !== undefined && r.prompt_level !== null) ? String(r.prompt_level) : null);
        const promptCategoryCounts = countBy(modelResults, (r) => (r && r.prompt_category) ? String(r.prompt_category) : null);

        const ratioOrNull = (a, b) => {
            if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
            return a / b;
        };
        const tpsVsMedian = ratioOrNull(tpsAgg.mean, tpsMedianModelAvg);
        const judgeMsVsMedian = ratioOrNull(judgeAgg.mean, judgeMsMedianModelAvg);
        const formatRatio = (x) => (x === null ? '-' : `${x.toFixed(2)}x`);
        const ratioColor = (x, invert = false) => {
            if (x === null) return 'var(--muted)';
            const good = invert ? (x <= 0.85) : (x >= 1.15);
            const bad = invert ? (x >= 1.25) : (x <= 0.75);
            if (good) return '#2ecc71';
            if (bad) return '#e74c3c';
            return 'var(--text)';
        };

        // Anomaly detection
        const tpsBelowPct = Math.max(0, Math.min(100, Number(thresholds.model_tps_below_median_pct) || 30));
        const judgeMsAbovePct = Math.max(0, Math.min(300, Number(thresholds.model_judge_ms_above_median_pct) || 50));
        const tpsCutoff = (tpsMedianModelAvg !== null && Number.isFinite(tpsMedianModelAvg))
            ? (tpsMedianModelAvg * (1 - (tpsBelowPct / 100)))
            : null;
        const judgeMsCutoff = (judgeMsMedianModelAvg !== null && Number.isFinite(judgeMsMedianModelAvg))
            ? (judgeMsMedianModelAvg * (1 + (judgeMsAbovePct / 100)))
            : null;

        const reasons = [];
        const execRate = execDone > 0 ? (execFailed / execDone) : 0;
        const judgeRate = judgeDone > 0 ? (judgeFailed / judgeDone) : 0;
        const execOutPct = Math.max(0, Math.min(100, Number(thresholds.model_exec_out_pct) || 20)) / 100;
        const judgeOutPct = Math.max(0, Math.min(100, Number(thresholds.model_judge_out_pct) || 10)) / 100;

        if (execDone >= minSamples && execRate >= execOutPct) reasons.push('<span class="badge bg-danger">FAIL</span>');
        if (isQualityEnabled && judgeDone >= minSamples && judgeRate >= judgeOutPct) reasons.push('<span class="badge bg-warning text-dark">JFAIL</span>');
        if (tpsCutoff !== null && tpsAgg.n >= minSamples && Number.isFinite(tpsAgg.mean) && tpsAgg.mean <= tpsCutoff) reasons.push('<span class="badge bg-info text-dark">LOW TPS</span>');
        if (judgeMsCutoff !== null && judgeAgg.n >= minSamples && Number.isFinite(judgeAgg.mean) && judgeAgg.mean >= judgeMsCutoff) reasons.push('<span class="badge bg-info text-dark">SLOW JUDGE</span>');

        const aggCell = (primary, secondary, title) => `
            <div title="${title}" style="white-space: nowrap;">
                <div style="font-weight: 600; color: var(--text);">${primary}</div>
                <div style="color: var(--muted); font-size: 0.82em;">${secondary}</div>
            </div>
        `;

        const latencyCell = aggCell(
            latencyAgg.n > 0 ? `${Math.round(latencyAgg.p50)}ms` : '-',
            latencyAgg.n > 0 ? `p95 ${Math.round(latencyAgg.p95)}ms` : `n=0`,
            latencyAgg.n > 0 ? `n=${latencyAgg.n} avg=${Math.round(latencyAgg.mean)}ms min=${Math.round(latencyAgg.min)}ms max=${Math.round(latencyAgg.max)}ms` : 'No latency data'
        );
        const tpsCell = aggCell(
            tpsAgg.n > 0 ? `${tpsAgg.p50.toFixed(2)} t/s` : '-',
            tpsAgg.n > 0 ? `p10 ${tpsAgg.p10.toFixed(2)} • vs med ${formatRatio(tpsVsMedian)}` : `n=0`,
            tpsAgg.n > 0 ? `n=${tpsAgg.n} avg=${tpsAgg.mean.toFixed(2)} p95=${tpsAgg.p95.toFixed(2)} min=${tpsAgg.min.toFixed(2)}` : 'No throughput data'
        );
        const judgeMsCell = aggCell(
            judgeAgg.n > 0 ? `${Math.round(judgeAgg.p50)}ms` : '-',
            judgeAgg.n > 0 ? `p95 ${Math.round(judgeAgg.p95)}ms • vs med ${formatRatio(judgeMsVsMedian)}` : `n=0`,
            judgeAgg.n > 0 ? `n=${judgeAgg.n} avg=${Math.round(judgeAgg.mean)}ms max=${Math.round(judgeAgg.max)}ms` : 'No judge-time data'
        );
        const qualityCell = aggCell(
            qualityAgg.n > 0 ? `${qualityAgg.p50.toFixed(2)}` : '-',
            qualityAgg.n > 0 ? `p10 ${qualityAgg.p10.toFixed(2)}` : `n=0`,
            qualityAgg.n > 0 ? `n=${qualityAgg.n} avg=${qualityAgg.mean.toFixed(2)} p95=${qualityAgg.p95.toFixed(2)} min=${qualityAgg.min.toFixed(2)}` : 'No quality data'
        );

        // Build hyper snapshot for expandable row
        const recentErrors = modelResults
            .filter(r => isExecFailed(r) || isJudgeFailed(r))
            .slice(-5)
            .map(r => ({
                prompt_id: r.prompt_id,
                scoring_method: r.scoring_method,
                error: r.error || null,
                host: r.host || null,
                judge_host: r.judge_host || null
            }));

        const modelSnapshot = {
            model,
            planned: perModelPlannedFromPlan,
            exec: { done: execDone, failed: execFailed, percent: execPct },
            judge: isQualityEnabled ? { done: judgeDone, failed: judgeFailed, percent_planned: judgePct, percent_effective: judgeEffPct } : { disabled: true },
            aggregates: {
                latency_ms: latencyAgg,
                tokens_per_sec: tpsAgg,
                judge_time_ms: judgeAgg,
                quality_score: qualityAgg,
                vs_median: { model_avg_tokens_per_sec_ratio: tpsVsMedian, model_avg_judge_time_ms_ratio: judgeMsVsMedian }
            },
            breakdowns: { exec_host: execHostCounts, judge_host: judgeHostCounts, scoring_method: methodCounts, prompt_level: promptLevelCounts, prompt_category: promptCategoryCounts },
            recent_errors: recentErrors
        };

        const hyperToggle = showHyperDetails
            ? `<button type="button" class="btn-secondary" data-action="toggle-model-hyper" data-model="${String(model).replace(/"/g, '&quot;')}" style="padding: 6px 10px;">Hyper</button>`
            : '';

        return `
            <tr data-model-main-row="${String(model).replace(/"/g, '&quot;')}">
                <td style="padding: 10px 10px; font-weight: 600; color: var(--text); white-space: nowrap;">
                    <div style="display:flex; align-items:center; justify-content: space-between; gap: 10px;">
                        <div style="display:flex; flex-direction: column; gap: 4px;">
                            <span>${escapeHtml(model)}</span>
                            ${reasons.length > 0 ? `<div style="display:flex; gap: 6px; flex-wrap: wrap;">${reasons.join('')}</div>` : ''}
                        </div>
                        ${hyperToggle}
                    </div>
                </td>
                <td style="padding: 10px 10px; min-width: 220px;">${execBar}</td>
                <td style="padding: 10px 10px; min-width: 220px;">${judgeBar}</td>
                <td style="padding: 10px 10px; min-width: 140px;">${latencyCell}</td>
                <td style="padding: 10px 10px; min-width: 140px;"><div style="color: ${ratioColor(tpsVsMedian, false)};">${tpsCell}</div></td>
                <td style="padding: 10px 10px; min-width: 140px;"><div style="color: ${ratioColor(judgeMsVsMedian, true)};">${judgeMsCell}</div></td>
                <td style="padding: 10px 10px; min-width: 140px;">${qualityCell}</td>
            </tr>
            <tr data-model-hyper-row="${String(model).replace(/"/g, '&quot;')}" style="display:none;">
                <td colspan="7" style="padding: 0 10px 10px;">
                    <div class="advanced-details" style="margin-top: 0;">
                        <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 6px;">
                            <div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">
                                <div style="font-weight: 700; color: var(--text);">${escapeHtml(model)} — hyper snapshot</div>
                                <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="failure" data-model="${String(model).replace(/"/g, '&quot;')}" style="padding: 6px 10px;">Inspect failure</button>
                                <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="worst_latency" data-model="${String(model).replace(/"/g, '&quot;')}" style="padding: 6px 10px;">Inspect worst latency</button>
                                <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="lowest_quality" data-model="${String(model).replace(/"/g, '&quot;')}" style="padding: 6px 10px;">Inspect lowest quality</button>
                            </div>
                        </div>
                        <pre style="margin:0;">${JSON.stringify(modelSnapshot, null, 2)}</pre>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    perModelContainer.style.display = 'block';
    const resultsMeta = batch && batch.results_meta ? batch.results_meta : null;
    const sampledNotice = resultsMeta && resultsMeta.truncated
        ? ` | detailed metric columns use sampled results (${resultsMeta.returned}/${resultsMeta.total})`
        : '';

    perModelContainer.innerHTML = `
        <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 10px;">
            <div style="font-weight: 700; color: var(--text);">Per-model Progress</div>
            <div style="color: var(--muted); font-size: 0.85em;">Planned per model: ${perModelPlannedFromPlan}${sampledNotice}</div>
        </div>
        <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="text-align:left; color: var(--muted); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">
                        <th style="padding: 8px 10px;">Model</th>
                        <th style="padding: 8px 10px;">Exec</th>
                        <th style="padding: 8px 10px;">Judge</th>
                        <th style="padding: 8px 10px;">Latency</th>
                        <th style="padding: 8px 10px;">t/s</th>
                        <th style="padding: 8px 10px;">Judge ms</th>
                        <th style="padding: 8px 10px;">Quality</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>
    `;

    // Bind click handlers for hyper toggle and inspect buttons
    if (!perModelContainer.dataset.hyperBound) {
        perModelContainer.addEventListener('click', (e) => {
            const inspectBtn = e.target && e.target.closest && e.target.closest('[data-action="inspect-model"]');
            if (inspectBtn) {
                const model = inspectBtn.getAttribute('data-model');
                const mode = inspectBtn.getAttribute('data-mode') || 'failure';
                const idOrIndex = pickRepresentativeResultIdForModel(model, mode);
                if (idOrIndex !== null && typeof window.showJudgeDetails === 'function') {
                    window.showJudgeDetails(idOrIndex);
                }
                return;
            }

            const btn = e.target && e.target.closest && e.target.closest('[data-action="toggle-model-hyper"]');
            if (!btn) return;
            const model = btn.getAttribute('data-model');
            const row = findRowByAttr(perModelContainer, 'data-model-hyper-row', model);
            if (!row) return;
            const isOpen = row.style.display !== 'none';
            row.style.display = isOpen ? 'none' : '';
            btn.textContent = isOpen ? 'Hyper' : 'Hide';
        });
        perModelContainer.dataset.hyperBound = 'true';
    }
}

/**
 * Update results table
 */
function updateResultsTable(results, resultsMeta, batch) {
    const container = document.getElementById('batchResultsContainer');
    const tbody = document.getElementById('batchResultsBody');
    container.style.display = 'block';

    // Scoring summary bar
    let scoringBarEl = document.getElementById('batchScoringBar');
    if (!scoringBarEl) {
        scoringBarEl = document.createElement('div');
        scoringBarEl.id = 'batchScoringBar';
        const table = tbody.closest('table');
        if (table) table.parentElement.insertBefore(scoringBarEl, table);
    }
    scoringBarEl.innerHTML = buildBatchScoringBar(results);

    // Truncation notice when results are paginated
    let truncNotice = document.getElementById('batchResultsTruncNotice');
    if (resultsMeta && resultsMeta.truncated) {
        if (!truncNotice) {
            truncNotice = document.createElement('div');
            truncNotice.id = 'batchResultsTruncNotice';
            truncNotice.style.cssText = 'padding: 6px 12px; color: var(--muted); font-size: 0.85em; text-align: right;';
            const table = tbody.closest('table');
            if (table) table.parentElement.insertBefore(truncNotice, table.nextSibling);
        }
        truncNotice.textContent = `Showing ${resultsMeta.returned} of ${resultsMeta.total} results`;
    } else if (truncNotice) {
        truncNotice.remove();
    }

    const getFailureBadgeHtml = (r) => {
        const isFailed = r.success === false;
        if (!isFailed) return '';

        const isInfra = r.infra_error === true || String(r.error_type || '').toLowerCase() === 'infra';
        const type = isInfra ? 'infra' : (String(r.error_type || '').toLowerCase() === 'model' ? 'model' : 'unknown');
        const label = type === 'infra' ? 'INFRA' : type === 'model' ? 'MODEL' : 'UNKNOWN';
        const icon = type === 'infra' ? 'fa-network-wired' : type === 'model' ? 'fa-bug' : 'fa-question-circle';
        const http = Number.isFinite(r.error_http_status) ? ` HTTP ${r.error_http_status}` : '';

        const msgRaw = (r.error || r.error_message || '').toString();
        const msg = msgRaw.replace(/\s+/g, ' ').trim().slice(0, 220);
        const title = `${label}${http}${msg ? `: ${msg}` : ''}`;

        return `<span class="fail-badge ${type}" title="${escapeHtml(title)}"><i class="fas ${icon}"></i>${label}</span>`;
    };

    tbody.innerHTML = results.map((r, idx) => {
        const isFailed = r.success === false;
        const qualityScore = r.quality_score !== undefined && r.quality_score !== null ? r.quality_score : '-';
        const qualityClass = qualityScore >= 7 ? 'quality-high' : qualityScore >= 4 ? 'quality-mid' : (qualityScore !== '-' ? 'quality-low' : '');

        const lat = toFiniteNumber(r.latency);
        const tps = toFiniteNumber(r.tokens_per_sec);
        const perfLine = (lat !== null || tps !== null)
            ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">${lat !== null ? `L: ${Math.round(lat)}ms` : 'L: -'} | ${tps !== null ? `t/s: ${tps.toFixed(2)}` : 't/s: -'}</div>`
            : '';

        const hostInfo = r.host ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">Exec: ${formatHostLabel(r.host)}</div>` : '';
        const isJudgeSameHostFallback = r.host && r.judge_host && r.host === r.judge_host && batch && batch.judge_same_host_fallback;
        const judgeHostLabel = r.judge_host ? formatHostLabel(r.judge_host) : '';
        const judgeInfo = r.judge_host ? `<div style="font-size: 0.75em; color: ${isJudgeSameHostFallback ? '#e67e22' : 'var(--muted)'};">Judge: ${judgeHostLabel}${isJudgeSameHostFallback ? ' <i class="fas fa-exchange-alt" title="Fallback: judging on same host due to cross-host warmup failure"></i>' : ''}</div>` : '';

        const rowStyle = isFailed
            ? 'border-bottom: 1px solid rgba(231, 76, 60, 0.3); background: rgba(231, 76, 60, 0.05);'
            : 'border-bottom: 1px solid rgba(255,255,255,0.05);';

        const failureBadge = getFailureBadgeHtml(r);

        return `
            <tr style="${rowStyle}">
                <td style="padding: 8px 12px;">
                    ${isFailed ? '<i class="fas fa-exclamation-triangle" style="color: #e74c3c; margin-right: 6px;"></i>' : ''}${escapeHtml(r.model)}
                    ${hostInfo}
                </td>
                <td style="padding: 8px 12px;">
                    ${escapeHtml(r.prompt_name)}${perfLine}
                </td>
                <td style="padding: 8px 12px; text-align: center;" class="${qualityClass}">
                    ${isFailed ? `<span style="color: #e74c3c; font-weight: 600;">FAILED</span>${failureBadge}` : qualityScore}
                    ${judgeInfo}
                </td>
                <td style="padding: 8px 12px; text-align: center;">
                    <button class="btn-secondary btn-sm" onclick="showJudgeDetails('${r.id || idx}')">
                        <i class="fas fa-${isFailed ? 'exclamation-circle' : 'eye'}"></i> ${isFailed ? 'Error' : 'Details'}
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    if (typeof window.BenchmarkAnalytics !== 'undefined' && window.BenchmarkAnalytics.applyTruncationFilter) {
        window.BenchmarkAnalytics.applyTruncationFilter();
    }
}

/**
 * Update hyper details (simplified)
 */
function updateHyperDetails(batch, results) {
    const hyperPre = document.getElementById('hyperBatchJson');
    const hyperDetails = document.getElementById('hyperBatchDetails');

    if (!hyperPre || !hyperDetails) return;

    hyperDetails.style.display = 'block';
    hydrateThresholdInputs();
    bindThresholdInputs();

    // Create simplified snapshot
    const snapshot = {
        id: batch._id || state.currentBatchId,
        status: batch.status,
        progress: batch.progress,
        completed: batch.completed,
        total_tests: batch.total_tests,
        judge_completed: batch.judge_completed,
        judge_total: batch.judge_total,
        results_count: results.length
    };

    hyperPre.textContent = JSON.stringify(snapshot, null, 2);
}

/**
 * Handle batch complete
 */
function handleBatchComplete(batch) {
    if (state.batchPollInterval) {
        clearInterval(state.batchPollInterval);
        state.setBatchPollInterval(null);
    }
    localStorage.removeItem('currentBatchId');

    // Don't clear currentBatchId yet - keep it so truncation stats show batch results
    // state.setCurrentBatchId(null);

    const status = document.getElementById('batchStatus');
    const btn = document.getElementById('runBatchBtn');
    const stopBtn = document.getElementById('stopBatchBtn');

    btn.disabled = false;
    btn.textContent = 'Start Batch Test';
    stopBtn.style.display = 'none';

    if (batch.status === 'completed') {
        status.className = 'status success';
        const fallbackNote = batch.judge_same_host_fallback ? ' [Judge: same-host fallback]' : '';
        status.textContent = `Batch completed! ${batch.completed} tests run (${batch.success_rate} success)${fallbackNote}`;
    } else if (batch.status === 'stopped') {
        status.className = 'status warning';
        status.textContent = `Batch stopped by user (${batch.completed}/${batch.total_tests} tests completed)`;
    } else if (batch.status === 'failed') {
        status.className = 'status error';
        status.textContent = `Batch failed (${batch.completed}/${batch.total_tests} tests completed)`;
    }

    status.style.display = 'block';

    // Refresh truncation stats to show final batch truncation data
    if (window.BenchmarkAnalytics && typeof window.BenchmarkAnalytics.loadTruncationStats === 'function') {
        window.BenchmarkAnalytics.loadTruncationStats();
    }
}

/**
 * Recover stuck batch
 */
export async function recoverBatch(batchId) {
    if (!confirm('Mark this batch as stopped? This will allow you to start a new batch.')) {
        return;
    }

    try {
        const json = await recoverBatchApi(batchId);

        if (json.status === 'success') {
            alert('Batch marked as stopped successfully. You can now start a new batch.');
            loadBatchHistory();
        } else {
            alert(`Failed to recover batch: ${json.error || 'Unknown error'}`);
        }
    } catch (err) {
        console.error('Failed to recover batch:', err);
        alert(`Error: ${err.message}`);
    }
}

/**
 * Load batch details
 */
export async function loadBatchDetails(batchId) {
    if (state.currentBatchId === batchId) return;

    if (state.batchPollInterval) {
        clearInterval(state.batchPollInterval);
        state.setBatchPollInterval(null);
    }

    state.setCurrentBatchId(batchId);
    localStorage.setItem('currentBatchId', batchId);

    document.getElementById('batchResultsContainer').style.display = 'none';
    document.getElementById('batchResultsBody').innerHTML = '';
    document.getElementById('batchStatus').style.display = 'none';
    document.getElementById('batchInfo').innerHTML = '';

    pollConsecutiveErrors = 0;
    loadBatchHistory();
    await pollBatchProgress();

    // Start polling if batch is still active (pollBatchProgress handles terminal states)
    if (state.currentBatchId && !state.batchPollInterval) {
        const interval = setInterval(pollBatchProgress, 2000);
        state.setBatchPollInterval(interval);
    }

    document.querySelector('.batch-section')?.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Load batch history
 */
export async function loadBatchHistory() {
    const container = document.getElementById('batchHistoryList');
    if (!container) return;

    try {
        const json = await fetchBatchHistory();

        if (json.status === 'success' && json.data.batches) {
            if (json.data.batches.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 15px;">No previous batches found</div>';
                return;
            }

            container.innerHTML = json.data.batches.map(b => {
                const date = new Date(b.created_at).toLocaleString();
                const statusColor = b.status === 'completed' ? '#2ecc71' : (b.status === 'failed' ? '#e74c3c' : '#f1c40f');

                return `<div class="history-item" onclick="loadBatchDetails('${b._id}')" style="padding: 4px 10px; border-bottom: 1px solid var(--panel-border); cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                    <div style="font-size: 0.83em; font-weight: 500; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${b.run_name || 'Untitled Batch'}</div>
                    <div style="font-size: 0.75em; color: var(--muted); white-space: nowrap;">${b.models ? b.models.length : 0}m · ${b.total_tests || 0}t · ${date}</div>
                    <div style="font-size: 0.75em; color: ${statusColor}; text-transform: capitalize; white-space: nowrap;">${b.status}</div>
                </div>`;
            }).join('');
        }
    } catch (err) {
        console.error('Failed to load history:', err);
        container.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 15px;">Failed to load history</div>';
    }
}

// Expose to window for legacy code and onclick handlers
if (typeof window !== 'undefined') {
    window.showJudgeDetails = showJudgeDetails;
    window.recoverBatch = recoverBatch;
    window.loadBatchDetails = loadBatchDetails;
}
