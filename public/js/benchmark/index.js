// index.js - Main entry point, DOMContentLoaded init, orchestration

import * as state from './state.js';
import { escapeHtml, debugLog } from './utils.js';
import { getWorkspaceHeaders, fetchBenchmarkConfig, fetchBenchmarkPrompts, fetchActiveBatches, fetchBatchProgress } from './api.js';
import { initChartDefaults } from './charts.js';
import { loadOllamaHosts, loadModelsForHost, loadBatchModels, filterModelList, selectAllVisibleModels, loadModelRegistry, renderCategoryTabs } from './models.js';
import { updateBatchInfo, renderDepthMatrix, bindDepthMatrix, updateDepthSummary, setAllDepths, getDepthConfig, getSelectedLevels, setAdvancedMode, setHyperMode, hydrateThresholdInputs, bindThresholdInputs } from './batch-config.js';
import { runBatch, stopBatch, pollBatchProgress, resetBatchUI, recoverBatch, loadBatchHistory } from './batch-execution.js';
import { showJudgeDetails, closeJudgeDetails } from './judge-details.js';
import { pickRepresentativeResultId } from './results-analysis.js';
import { loadRecentTestsTimeline, getTimelineMode, scheduleTimelineScrollSync, showTimelineTooltip } from './timeline.js';
import { rerenderRecentTests, toggleSuccessRateDetails } from './recent-tests.js';
import { refreshJudgeTierUI } from './judge-mismatch.js';

const JUDGE_CONFIG_STORAGE_KEY = 'benchmarkJudgeConfig';
let judgeNumCtxTouched = false;

/**
 * Setup modals (close on click outside, escape key)
 */
function setupModals() {
    // Click outside to close
    window.addEventListener('click', (e) => {
        const judgeModal = document.getElementById('judgeDetailsModal');
        const presetModal = document.getElementById('presetManagementModal');
        const settingsModal = document.getElementById('settingsModal');

        if (e.target === judgeModal) {
            judgeModal.style.display = 'none';
        }
        if (e.target === presetModal) {
            presetModal.style.display = 'none';
        }
        if (e.target === settingsModal) {
            settingsModal.style.display = 'none';
        }
    });

    // Close buttons
    document.querySelectorAll('.modal-close, [data-modal-close], .modal .close').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            if (modal) modal.style.display = 'none';
        });
    });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(modal => {
                if (modal.style.display !== 'none') {
                    modal.style.display = 'none';
                }
            });
        }
    });
}

function readStoredJudgeConfig() {
    try {
        const raw = localStorage.getItem(JUDGE_CONFIG_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (err) {
        console.warn('Failed to parse stored judge config:', err);
        return null;
    }
}

function writeStoredJudgeConfig(config) {
    try {
        localStorage.setItem(JUDGE_CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
        console.warn('Failed to persist judge config:', err);
    }
}

function coerceNumber(value, fallback = null) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

async function resolveBatchToResume(savedBatchId) {
    try {
        const activeResponse = await fetchActiveBatches();
        const activeBatches = Array.isArray(activeResponse?.data) ? activeResponse.data : [];
        const activeBatch = activeBatches.find((batch) => (
            batch && ['running', 'judging'].includes(batch.status)
        ));

        if (activeBatch) {
            return activeBatch.id || activeBatch._id || null;
        }
    } catch (err) {
        console.warn('Failed to fetch active batches:', err);
    }

    return savedBatchId || null;
}

function getJudgeModelCandidates() {
    const seen = new Set();
    const candidates = [];

    (state.ollamaHosts || []).forEach((host) => {
        (host.models || []).forEach((modelName) => {
            if (!modelName || seen.has(modelName)) return;
            seen.add(modelName);
            candidates.push(state.modelRegistryCache[modelName] || { modelName });
        });
    });

    return candidates.sort((a, b) => (a.modelName || '').localeCompare(b.modelName || ''));
}

function judgeTierRank(tier) {
    return ({ basic: 1, standard: 2, advanced: 3, premium: 4 })[tier] || 0;
}

function inferJudgeTierFromName(modelName) {
    const normalized = (modelName || '').toLowerCase();
    if (/70b|72b|671b|405b/.test(normalized)) return 'premium';
    if (/32b|34b|30b|40b|14b|13b|20b|22b/.test(normalized)) return 'advanced';
    if (/7b|8b|9b/.test(normalized)) return 'standard';
    if (/3b|2b|1\.5b/.test(normalized)) return 'basic';
    return '';
}

function normalizeJudgeModelName(modelName) {
    return String(modelName || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function getAvailableJudgeModelsForHost(hostUrl) {
    if (!hostUrl) return [];
    const host = (state.ollamaHosts || []).find((entry) => entry.url === hostUrl);
    return Array.isArray(host?.models) ? host.models.filter(Boolean) : [];
}

function getJudgeHostRecommendation(hostUrl) {
    if (!hostUrl || !state.judgeHostRecommendations) return null;
    return state.judgeHostRecommendations[hostUrl] || null;
}

function formatJudgeHostLabel(hostUrl) {
    if (!hostUrl) return '(not set)';
    const matched = (state.ollamaHosts || []).find((host) => host.url === hostUrl);
    return matched ? `${matched.name} (${hostUrl})` : hostUrl;
}

function syncJudgeNumCtxToRecommendation(force = false) {
    const judgeHostEl = document.getElementById('judgeHost');
    const judgeModelEl = document.getElementById('judgeModel');
    const judgeNumCtxEl = document.getElementById('judgeNumCtx');
    const recommendation = getJudgeHostRecommendation(judgeHostEl?.value || '');
    if (!judgeNumCtxEl || !recommendation?.recommended?.num_ctx) return;
    const selectedModel = judgeModelEl?.value || '';
    const matchesRecommendedModel = normalizeJudgeModelName(selectedModel) === normalizeJudgeModelName(recommendation.recommended.model);
    if (!force && selectedModel && !matchesRecommendedModel) return;
    if (!force && judgeNumCtxTouched) return;
    judgeNumCtxEl.value = String(recommendation.recommended.num_ctx);
}

function renderJudgeRecommendationPanel() {
    const headline = document.getElementById('judgeCapacityHeadline');
    const details = document.getElementById('judgeCapacityDetails');
    const current = document.getElementById('judgeCapacityCurrent');
    const grid = document.getElementById('judgeHostRecommendationGrid');
    const applyBtn = document.getElementById('applyJudgeRecommendationBtn');
    if (!headline || !details || !current || !grid || !applyBtn) return;

    const judgeHostEl = document.getElementById('judgeHost');
    const judgeModelEl = document.getElementById('judgeModel');
    const judgeNumCtxEl = document.getElementById('judgeNumCtx');
    const selectedHost = judgeHostEl?.value || '';
    const selectedModel = judgeModelEl?.value || '';
    const selectedNumCtx = coerceNumber(judgeNumCtxEl?.value, null);
    const recommendation = getJudgeHostRecommendation(selectedHost);
    const recommended = recommendation?.recommended || null;

    applyBtn.disabled = !recommended;

    if (!recommendation) {
        headline.textContent = 'Host-aware judge guidance unavailable';
        details.textContent = 'No recommendation data was returned for the selected host.';
        current.innerHTML = '';
    } else if (!recommended) {
        headline.textContent = `No judge recommendation for ${recommendation.hostName || selectedHost}`;
        details.textContent = recommendation.available
            ? 'No suitable judge candidate was found on this host.'
            : 'Host inventory is unavailable, so recommendations could not be generated.';
        current.innerHTML = '';
    } else {
        const matchesModel = normalizeJudgeModelName(selectedModel) === normalizeJudgeModelName(recommended.model);
        const matchesCtx = selectedNumCtx === recommended.num_ctx;
        headline.textContent = `Best available judge on ${recommendation.hostName}`;
        details.textContent = `${recommended.model} at ${recommended.num_ctx.toLocaleString()} ctx. ${recommended.summary}.`;
        current.innerHTML = `
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
                <span class="judge-preview-badge" style="border-color:${matchesModel ? 'rgba(46, 204, 113, 0.4)' : 'rgba(241, 196, 15, 0.4)'}; color:${matchesModel ? '#2ecc71' : '#f1c40f'};">
                    ${matchesModel ? 'Model aligned' : 'Current model differs'}
                </span>
                <span class="judge-preview-badge" style="border-color:${matchesCtx ? 'rgba(46, 204, 113, 0.4)' : 'rgba(241, 196, 15, 0.4)'}; color:${matchesCtx ? '#2ecc71' : '#f1c40f'};">
                    ${matchesCtx ? 'Context aligned' : `Recommended ${recommended.num_ctx.toLocaleString()} ctx`}
                </span>
                ${recommendation.configuredDefault ? `<span class="judge-preview-badge">Configured default: ${escapeHtml(recommendation.configuredDefault)}</span>` : ''}
            </div>
        `;
    }

    const cards = Object.values(state.judgeHostRecommendations || {}).map((entry) => {
        const rec = entry?.recommended || null;
        const hostLabel = entry.hostName || entry.hostUrl;
        if (!rec) {
            return `
                <div style="padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03);">
                    <div style="font-weight:600; color:var(--text);">${escapeHtml(hostLabel)}</div>
                    <div style="font-size:0.82em; color:var(--muted); margin-top:4px;">No recommendation available</div>
                </div>
            `;
        }

        const isSelected = selectedHost && entry.hostUrl === selectedHost;
        return `
            <div style="padding:10px; border-radius:8px; border:1px solid ${isSelected ? 'rgba(124, 240, 255, 0.35)' : 'rgba(255,255,255,0.08)'}; background:${isSelected ? 'rgba(124, 240, 255, 0.08)' : 'rgba(255,255,255,0.03)'};">
                <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
                    <div style="font-weight:600; color:var(--text);">${escapeHtml(hostLabel)}</div>
                    <div style="font-size:0.78em; color:var(--muted);">${entry.hostVramMb ? `${Number(entry.hostVramMb).toLocaleString()} MiB` : 'VRAM unknown'}</div>
                </div>
                <div style="margin-top:6px; color:var(--text); font-size:0.86em;">${escapeHtml(rec.model)}</div>
                <div style="margin-top:4px; font-size:0.8em; color:var(--muted);">${rec.num_ctx.toLocaleString()} ctx · ${escapeHtml(rec.tier || 'unrated')} · ${escapeHtml(rec.contextSource)}</div>
            </div>
        `;
    });
    grid.innerHTML = cards.join('') || '<div style="font-size:0.85em; color:var(--muted);">No host recommendations available.</div>';
}

function applyJudgeRecommendationToForm(hostUrl = null) {
    const judgeHostEl = document.getElementById('judgeHost');
    const judgeModelEl = document.getElementById('judgeModel');
    if (!judgeHostEl || !judgeModelEl) return;

    const targetHost = hostUrl || judgeHostEl.value || '';
    const recommendation = getJudgeHostRecommendation(targetHost);
    const recommended = recommendation?.recommended || null;
    if (!recommended) {
        renderJudgeRecommendationPanel();
        return;
    }

    judgeHostEl.value = targetHost;
    populateJudgeModelSelect(targetHost);
    const matchedModel = findBestJudgeModelMatch(recommended.model, getAvailableJudgeModelsForHost(targetHost));
    if (matchedModel) {
        judgeModelEl.value = matchedModel;
    }
    judgeNumCtxTouched = false;
    syncJudgeNumCtxToRecommendation(true);
    renderJudgeRecommendationPanel();
}

function findBestJudgeModelMatch(targetModel, availableModels) {
    const normalizedTarget = normalizeJudgeModelName(targetModel);
    if (!normalizedTarget) return null;
    const models = Array.isArray(availableModels) ? availableModels : [];

    const exact = models.find((name) => normalizeJudgeModelName(name) === normalizedTarget);
    if (exact) return exact;

    const targetCore = normalizedTarget.split(':').pop();
    const sameSuffix = models.find((name) => normalizeJudgeModelName(name).split(':').pop() === targetCore);
    if (sameSuffix) return sameSuffix;

    return null;
}

function resolveJudgeDisplayTier(model) {
    const registryTier = model.capabilities && model.capabilities.judgeTier;
    const inferredTier = inferJudgeTierFromName(model.modelName || '');
    if (!registryTier) return inferredTier;
    if (!inferredTier) return registryTier;
    return judgeTierRank(inferredTier) > judgeTierRank(registryTier) ? inferredTier : registryTier;
}

function judgeTierBadge(model) {
    const tier = resolveJudgeDisplayTier(model);
    if (!tier) return '';
    const badges = { basic: 'BASIC', standard: 'STD', advanced: 'ADV', premium: 'PRO' };
    return badges[tier] ? ' [' + badges[tier] + ']' : '';
}

function populateJudgeModelSelect(hostOverride = null) {
    const select = document.getElementById('judgeModel');
    if (!select) return;
    const selectedHost = hostOverride !== null ? hostOverride : (document.getElementById('judgeHost')?.value || state.currentJudgeConfig.host || '');
    const hostModels = getAvailableJudgeModelsForHost(selectedHost);
    const hasHostScopedModels = hostModels.length > 0;
    const candidates = hasHostScopedModels
        ? hostModels.map((modelName) => state.modelRegistryCache[modelName] || { modelName })
        : getJudgeModelCandidates();

    const existingWarning = document.getElementById('judgeModelWarning');
    if (existingWarning) existingWarning.remove();

    if (candidates.length === 0) {
        select.innerHTML = '<option value="" disabled>No host models available</option>';
        return;
    }

    const current = select.value || state.currentJudgeConfig.model || '';
    select.innerHTML = candidates
        .map(model => {
            const name = model.modelName || model;
            const badge = judgeTierBadge(model);
            return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + badge + '</option>';
        })
        .join('');

    const availableNames = candidates.map((candidate) => candidate.modelName || candidate);
    const matchedCurrent = findBestJudgeModelMatch(current, availableNames);
    if (matchedCurrent) {
        select.value = matchedCurrent;
    } else {
        if (current) {
            const replacement = (candidates[0] && candidates[0].modelName) || candidates[0];
            const hostLabel = selectedHost || '(no host selected)';
            const availablePreview = availableNames.slice(0, 8).join(', ') || 'none';
            const warningBanner = document.createElement('div');
            warningBanner.id = 'judgeModelWarning';
            warningBanner.style.cssText = 'background: rgba(243, 156, 18, 0.15); border: 1px solid rgba(243, 156, 18, 0.5); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 0.85em; color: #f39c12;';
            warningBanner.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Configured judge model <strong>' + escapeHtml(current) + '</strong> is not available on <strong>' + escapeHtml(hostLabel) + '</strong>. Using <strong>' + escapeHtml(replacement) + '</strong> instead.<br><span style="opacity:0.85;">Available on this host: ' + escapeHtml(availablePreview) + '</span>';
            select.parentElement.insertBefore(warningBanner, select);
        }
        select.value = (candidates[0] && candidates[0].modelName) || candidates[0];
        const next = { ...state.currentJudgeConfig, model: select.value };
        state.setCurrentJudgeConfig(next);
        writeStoredJudgeConfig(next);
    }
}

function populateJudgeHostSelect() {
    const select = document.getElementById('judgeHost');
    if (!select) return;
    const currentValue = select.value || state.currentJudgeConfig.host || '';
    let options = '<option value="">(no host selected)</option>';
    if (Array.isArray(state.ollamaHosts)) {
        state.ollamaHosts.forEach(host => {
            const status = host.available ? '\u2713' : '\u2717';
            options += '<option value="' + host.url + '">' + status + ' ' + host.name + ' (' + host.url + ')</option>';
        });
    }
    select.innerHTML = options;
    if (currentValue) select.value = currentValue;
}

function applyJudgeConfigToForm(config) {
    if (!config) return;

    const judgeHost = document.getElementById('judgeHost');
    if (judgeHost) judgeHost.value = config.host || '';
    const judgeModel = document.getElementById('judgeModel');
    if (judgeModel && config.model) judgeModel.value = config.model;

    const judgeTemp = document.getElementById('judgeTemp');
    const judgeTempVal = document.getElementById('judgeTempVal');
    if (judgeTemp && config.temperature !== undefined && config.temperature !== null) {
        judgeTemp.value = String(config.temperature);
        if (judgeTempVal) judgeTempVal.textContent = String(config.temperature);
    }
    const judgeTimeout = document.getElementById('judgeTimeout');
    if (judgeTimeout && config.timeout !== undefined && config.timeout !== null) {
        judgeTimeout.value = String(config.timeout);
    }
    const judgeMaxTokens = document.getElementById('judgeMaxTokens');
    if (judgeMaxTokens && config.num_predict !== undefined && config.num_predict !== null) {
        judgeMaxTokens.value = String(config.num_predict);
    }
    const judgeNumCtx = document.getElementById('judgeNumCtx');
    if (judgeNumCtx && config.num_ctx !== undefined && config.num_ctx !== null) {
        judgeNumCtx.value = String(config.num_ctx);
    }
    const judgeConcurrency = document.getElementById('judgeConcurrency');
    const judgeConcurrencyVal = document.getElementById('judgeConcurrencyVal');
    if (judgeConcurrency && config.concurrency !== undefined && config.concurrency !== null) {
        judgeConcurrency.value = String(config.concurrency);
        if (judgeConcurrencyVal) judgeConcurrencyVal.textContent = String(config.concurrency);
    }
}

function getJudgeConfigOverridesFromForm() {
    const overrides = {};
    const judgeHostEl = document.getElementById('judgeHost');
    const judgeModel = document.getElementById('judgeModel');

    overrides.host = (judgeHostEl && judgeHostEl.value) ? judgeHostEl.value : null;
    overrides.model = (judgeModel && judgeModel.value) ? judgeModel.value : null;

    const judgeTemp = document.getElementById('judgeTemp');
    if (judgeTemp && judgeTemp.value !== '') overrides.temperature = coerceNumber(judgeTemp.value, 0.1);
    const judgeTimeout = document.getElementById('judgeTimeout');
    if (judgeTimeout && judgeTimeout.value !== '') overrides.timeout = coerceNumber(judgeTimeout.value, 120000);
    const judgeMaxTokens = document.getElementById('judgeMaxTokens');
    if (judgeMaxTokens && judgeMaxTokens.value !== '') overrides.num_predict = coerceNumber(judgeMaxTokens.value, 200);
    const judgeNumCtx = document.getElementById('judgeNumCtx');
    if (judgeNumCtx && judgeNumCtx.value !== '') overrides.num_ctx = coerceNumber(judgeNumCtx.value, 8192);
    const judgeConcurrency = document.getElementById('judgeConcurrency');
    if (judgeConcurrency && judgeConcurrency.value !== '') overrides.concurrency = coerceNumber(judgeConcurrency.value, 2);

    return overrides;
}

/**
 * Commit the current form values to state and persist.
 * Called only from the Save button — not on intermediate field changes.
 */
function commitJudgeConfigFromForm() {
    const overrides = getJudgeConfigOverridesFromForm();
    const next = { ...state.currentJudgeConfig, ...overrides };
    if (!next.host) delete next.host;
    if (!next.model) delete next.model;
    state.setCurrentJudgeConfig(next);
    writeStoredJudgeConfig(next);
    updateJudgeConfigPreview();
    renderDepthMatrix();
    updateDepthSummary();
    const depthCfg = getDepthConfig();
    const activeLevels = getSelectedLevels(depthCfg);
    refreshJudgeTierUI(activeLevels);
}

/**
 * Update the always-visible judge config preview card in the main batch panel
 */
function updateJudgeConfigPreview() {
    const el = document.getElementById('judgeConfigPreview');
    if (!el) return;
    const cfg = state.currentJudgeConfig || {};
    const model = cfg.model || '(not set)';
    const hostRaw = cfg.host || null;
    const concurrency = cfg.concurrency || 2;
    const timeout = cfg.timeout ? `${Math.round(cfg.timeout / 1000)}s` : '120s';
    const numCtx = Number(cfg.num_ctx || 8192);

    const hostLabel = formatJudgeHostLabel(hostRaw);
    const hostModels = getAvailableJudgeModelsForHost(hostRaw);
    const judgeAvailableOnHost = hostRaw && model ? !!findBestJudgeModelMatch(model, hostModels) : true;
    const availabilityBadge = hostRaw && !judgeAvailableOnHost
        ? `<span class="judge-preview-badge" style="color:#f59e0b;border-color:rgba(245,158,11,0.4);" title="Pinned judge model is not available on the selected judge host">model missing on host</span>`
        : '';

    el.innerHTML = `
        <div class="judge-preview-card">
            <span class="judge-preview-label"><i class="fas fa-gavel"></i> Judge</span>
            <span class="judge-preview-badge is-model">${escapeHtml(model)}</span>
            <span class="judge-preview-separator">on</span>
            <span class="judge-preview-badge is-host" title="${escapeHtml(hostLabel)}">${escapeHtml(hostLabel)}</span>
            <span class="judge-preview-pill">Pinned judge</span>
            ${availabilityBadge}
            <span class="judge-preview-badge">${numCtx.toLocaleString()} ctx</span>
            <span class="judge-preview-badge">×${concurrency} parallel</span>
            <span class="judge-preview-badge">${timeout} timeout</span>
        </div>`;
}

function bindJudgeSettingsUI() {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const saveBtn = document.getElementById('saveSettingsBtn');
    const cancelBtn = document.getElementById('cancelSettingsBtn');

    // ── Open modal ────────────────────────────────────────────────────────
    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', () => {
            populateJudgeHostSelect();
            populateJudgeModelSelect();
            applyJudgeConfigToForm(state.currentJudgeConfig);
            judgeNumCtxTouched = false;
            renderJudgeRecommendationPanel();
            settingsModal.style.display = 'block';
        });
    }

    // ── Save: commit form → state, persist, close ─────────────────────────
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            commitJudgeConfigFromForm();
            if (settingsModal) settingsModal.style.display = 'none';
        });
    }

    // ── Cancel: discard (state was never touched), close ──────────────────
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            if (settingsModal) settingsModal.style.display = 'none';
        });
    }

    // ── Temperature: display-only update (no state touch) ─────────────────
    const judgeTemp = document.getElementById('judgeTemp');
    const judgeTempVal = document.getElementById('judgeTempVal');
    if (judgeTemp && judgeTempVal) {
        judgeTemp.addEventListener('input', () => {
            judgeTempVal.textContent = judgeTemp.value;
        });
    }

    // ── Concurrency: display-only update ──────────────────────────────────
    const judgeConcurrency = document.getElementById('judgeConcurrency');
    const judgeConcurrencyVal = document.getElementById('judgeConcurrencyVal');
    if (judgeConcurrency && judgeConcurrencyVal) {
        judgeConcurrency.addEventListener('input', () => {
            judgeConcurrencyVal.textContent = judgeConcurrency.value;
        });
    }

    // ── Pinned host change: auto-suggest model from per-host defaults ──────
    const judgeHostEl = document.getElementById('judgeHost');
    if (judgeHostEl) {
        judgeHostEl.addEventListener('change', () => {
            const hostUrl = judgeHostEl.value;
            populateJudgeModelSelect(hostUrl);
            const recommendedModel = getJudgeHostRecommendation(hostUrl)?.recommended?.model || null;
            const defaultModel = recommendedModel || (hostUrl && state.judgeHostDefaults && state.judgeHostDefaults[hostUrl]);
            if (defaultModel) {
                const judgeModelEl = document.getElementById('judgeModel');
                if (judgeModelEl) {
                    const matchedModel = findBestJudgeModelMatch(defaultModel, getAvailableJudgeModelsForHost(hostUrl));
                    if (matchedModel) judgeModelEl.value = matchedModel;
                }
            }
            judgeNumCtxTouched = false;
            syncJudgeNumCtxToRecommendation(false);
            renderJudgeRecommendationPanel();
        });
    }

    const judgeModelEl = document.getElementById('judgeModel');
    if (judgeModelEl) {
        judgeModelEl.addEventListener('change', () => {
            syncJudgeNumCtxToRecommendation(false);
            renderJudgeRecommendationPanel();
        });
    }

    const judgeNumCtxEl = document.getElementById('judgeNumCtx');
    if (judgeNumCtxEl) {
        judgeNumCtxEl.addEventListener('input', () => {
            judgeNumCtxTouched = true;
            renderJudgeRecommendationPanel();
        });
    }

    const applyRecommendationBtn = document.getElementById('applyJudgeRecommendationBtn');
    if (applyRecommendationBtn) {
        applyRecommendationBtn.addEventListener('click', () => {
            applyJudgeRecommendationToForm();
        });
    }

    // ── judgeSuggestionApply: from the mismatch banner (outside modal) ─────
    // Always applies immediately to state (banner is main-page UI, not modal).
    document.addEventListener('judgeSuggestionApply', (e) => {
        const model = e.detail && e.detail.model;
        if (!model) return;
        const next = { ...state.currentJudgeConfig, model };
        state.setCurrentJudgeConfig(next);
        writeStoredJudgeConfig(next);
        updateJudgeConfigPreview();
        populateJudgeModelSelect();
        applyJudgeConfigToForm(next);
        judgeNumCtxTouched = false;
        renderJudgeRecommendationPanel();
        const depthCfg = getDepthConfig();
        refreshJudgeTierUI(getSelectedLevels(depthCfg));
    });
}

/**
 * Switch between category tabs
 */
function switchCategoryTab(category) {
    const tabs = document.querySelectorAll('.category-tab');
    tabs.forEach(tab => {
        const isActive = tab.dataset.category === category;
        if (isActive) {
            tab.classList.add('active');
            tab.style.borderBottomColor = 'var(--accent)';
            tab.style.color = 'var(--accent)';
        } else {
            tab.classList.remove('active');
            tab.style.borderBottomColor = 'transparent';
            tab.style.color = 'var(--muted)';
        }
    });

    const modelFilter = document.getElementById('modelCategoryFilter');
    if (modelFilter) {
        modelFilter.value = category;
    }

    if (window.BenchmarkAnalytics && typeof window.BenchmarkAnalytics.filterByModelCategory === 'function') {
        window.BenchmarkAnalytics.filterByModelCategory(category);
    }

    updateLeaderboardHeader(category);
    showCategoryInsights(category);
}

/**
 * Update leaderboard header based on active category
 */
function updateLeaderboardHeader(category) {
    const headerText = document.querySelector('.leaderboard h2');
    const bestOverallText = document.getElementById('bestOverallText');

    let title = 'Model Leaderboard';
    let subtitle = 'All models ranked across all task types';

    if (category) {
        title = `${category.charAt(0).toUpperCase() + category.slice(1)} Specialists`;
        subtitle = `Models in the '${category}' category`;
    }

    if (headerText) {
        headerText.innerHTML = `<i class="fas fa-trophy" style="color: var(--accent);"></i> ${title}`;
    }
    if (bestOverallText) {
        bestOverallText.textContent = subtitle;
    }
}

/**
 * Show category-specific insights
 */
function showCategoryInsights(category) {
    const insightsPanel = document.getElementById('categoryInsights');
    const insightsTitle = document.getElementById('insightsTitle');
    const insightsContent = document.getElementById('insightsContent');

    if (!category) {
        if (insightsTitle) insightsTitle.textContent = 'Universal Leaderboard - All Models';
        if (insightsContent) insightsContent.innerHTML = '<strong>Overview:</strong> All models ranked across all task types using composite scoring.<br><strong>Key Metric:</strong> Composite score balances quality, speed, and full pass rate.<br><strong>Terms:</strong> Exec Success means the run completed. Full Pass means the run completed and received a judge score. Judge Fail means execution worked but judging failed.<br><strong>Tip:</strong> Use category tabs for task-specific rankings.';
        if (insightsPanel) insightsPanel.style.display = 'block';
        return;
    }

    if (insightsTitle) insightsTitle.textContent = `${category.charAt(0).toUpperCase() + category.slice(1)} Category`;
    if (insightsContent) insightsContent.innerHTML = `<strong>Overview:</strong> Showing models tagged with <code>${escapeHtml(category)}</code>.<br><strong>Tip:</strong> Use this view to compare models within this specific domain.`;
    if (insightsPanel) insightsPanel.style.display = 'block';
}

/**
 * Load judge configuration
 */
async function loadJudgeConfig() {
    try {
        const json = await fetchBenchmarkConfig();
        const data = json.data || {};
        const judgeConfig = data.judge_config || data.judgeConfig || {};
        const executionConfig = data.execution_config || data.executionConfig || {};
        const storedJudgeConfig = readStoredJudgeConfig();

        // Persist tier metadata to state so other modules can use it
        if (data.judge_tier_map) state.setJudgeTierMap(data.judge_tier_map);
        if (data.judge_tier_rank) state.setJudgeTierRank(data.judge_tier_rank);
        if (data.judge_host_defaults) state.setJudgeHostDefaults(data.judge_host_defaults);
        if (data.judge_host_recommendations) state.setJudgeHostRecommendations(data.judge_host_recommendations);

        // Server is authoritative for model.
        // localStorage persists UI preferences (host, temperature, concurrency, timeout, num_predict, num_ctx).
        const uiOnlyKeys = ['host', 'model', 'temperature', 'timeout', 'num_predict', 'num_ctx', 'concurrency'];
        const storedUiPrefs = {};
        if (storedJudgeConfig) {
            for (const key of uiOnlyKeys) {
                if (storedJudgeConfig[key] !== undefined) {
                    storedUiPrefs[key] = storedJudgeConfig[key];
                }
            }
        }
        const mergedJudgeConfig = { ...judgeConfig, ...storedUiPrefs };
        // Strip stale/empty/wildcard host so benchmark state never keeps invalid hosts
        const h = mergedJudgeConfig.host || '';
        if (!h || h === 'http://0.0.0.0' || /\/\/0\.0\.0\.0(:\d+)?$/.test(h)) {
            delete mergedJudgeConfig.host;
        }

        state.setCurrentJudgeConfig(mergedJudgeConfig);
        state.setCurrentExecutionConfig(executionConfig);

        // Store tier configuration for UI display
        if (data.judge_tier_map) state.setJudgeTierMap(data.judge_tier_map);
        if (data.category_tier_map) state.setCategoryTierMap(data.category_tier_map);
        if (data.tier_rank) state.setTierRank(data.tier_rank);
        if (data.judge_presets) state.setJudgePresets(data.judge_presets);

        populateJudgeModelSelect();
        applyJudgeConfigToForm(mergedJudgeConfig);
        updateJudgeConfigPreview();
        renderJudgeRecommendationPanel();

        // Refresh tier indicators after config loads
        const depthCfg = getDepthConfig();
        const activeLevels = getSelectedLevels(depthCfg);
        refreshJudgeTierUI(activeLevels);
    } catch (err) {
        console.error('Failed to load judge config:', err);
    }
}

async function loadBenchmarkPrompts() {
    try {
        const json = await fetchBenchmarkPrompts();
        const data = json.data || {};
        state.setBenchmarkPrompts(data.prompts || []);

        renderDepthMatrix();
        updateDepthSummary();
        refreshJudgeTierUI(getSelectedLevels(getDepthConfig()));
    } catch (err) {
        console.error('Failed to load benchmark prompts:', err);
    }
}

/**
 * Initialize benchmark UI
 */
async function initBenchmarkUI() {
    debugLog('Initializing Benchmark UI...');

    // Initialize Chart.js defaults
    initChartDefaults();

    // Setup shared modal interactions
    setupModals();

    // Setup judge settings modal interactions
    bindJudgeSettingsUI();

    // Host change handler
    const hostSelect = document.getElementById('host');
    if (hostSelect) {
        hostSelect.addEventListener('change', async (e) => {
            loadModelsForHost(e.target.value);
            await loadBatchModels(e.target.value);
        });
    }

    // Model search and filter
    const modelSearchInput = document.getElementById('modelSearchInput');
    const modelCategoryFilterSelect = document.getElementById('modelCategoryFilterSelect');
    if (modelSearchInput) {
        modelSearchInput.addEventListener('input', filterModelList);
    }
    if (modelCategoryFilterSelect) {
        modelCategoryFilterSelect.addEventListener('change', filterModelList);
    }

    // Select all/none buttons
    const selectAllBtn = document.getElementById('selectAllModelsBtn');
    const selectNoneBtn = document.getElementById('selectNoneModelsBtn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => selectAllVisibleModels(true));
    }
    if (selectNoneBtn) {
        selectNoneBtn.addEventListener('click', () => selectAllVisibleModels(false));
    }
    const selectAllCheckbox = document.getElementById('selectAllModelsTable');
    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
            selectAllVisibleModels(e.target.checked);
        });
    }

    // Batch model checkbox changes
    document.addEventListener('change', (e) => {
        if (e.target.classList.contains('batch-model-checkbox')) {
            updateBatchInfo();
        }
    });

    // Run batch button
    const runBatchBtn = document.getElementById('runBatchBtn');
    if (runBatchBtn) {
        runBatchBtn.addEventListener('click', runBatch);
    }

    // Stop batch button
    const stopBatchBtn = document.getElementById('stopBatchBtn');
    if (stopBatchBtn) {
        stopBatchBtn.addEventListener('click', stopBatch);
    }

    // Profile selector
    const profileSelector = document.getElementById('scoringProfile');
    if (profileSelector) {
        profileSelector.addEventListener('change', (e) => {
            const profile = e.target.value;
            const sortSelector = document.getElementById('sortBy');
            if (['composite', 'interactive', 'reasoning', 'coding'].includes(state.currentSortBy)) {
                state.setCurrentSortBy(profile);
                if (sortSelector) sortSelector.value = 'composite';
            }
        });
    }

    // Sort selector
    const sortBy = document.getElementById('sortBy');
    if (sortBy) {
        sortBy.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val === 'composite') {
                const profile = document.getElementById('scoringProfile')?.value || 'interactive';
                state.setCurrentSortBy(profile);
            } else {
                state.setCurrentSortBy(val);
            }
        });
    }

    // Test form
    const testForm = document.getElementById('testForm');
    if (testForm) {
        testForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('runBtn');
            const status = document.getElementById('status');

            btn.disabled = true;
            btn.textContent = 'Running...';
            status.style.display = 'none';

            try {
                const res = await fetch(`${state.BENCHMARK_API}/test`, {
                    method: 'POST',
                    headers: getWorkspaceHeaders(),
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        host: document.getElementById('host').value,
                        prompt: document.getElementById('prompt').value
                    })
                });

                const json = await res.json();
                const data = json.data || json;

                if (data.success) {
                    status.className = 'status success';
                    status.textContent = `Test completed in ${data.latency}ms (${data.tokens_per_sec} tokens/s)`;
                } else {
                    status.className = 'status error';
                    status.textContent = `Test failed: ${data.error || json.error}`;
                }

                status.style.display = 'block';
            } catch (err) {
                status.className = 'status error';
                status.textContent = `Error: ${err.message}`;
                status.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Run Test';
            }
        });
    }

    // Load Ollama hosts
    try {
        await loadOllamaHosts();
    } catch (err) {
        console.error('Failed to load Ollama hosts:', err);
    }

    // Disclosure defaults
    if (localStorage.getItem('benchmarkShowAdvanced') === null) {
        localStorage.setItem('benchmarkShowAdvanced', 'false');
    }
    if (localStorage.getItem('benchmarkShowHyper') === null) {
        localStorage.setItem('benchmarkShowHyper', 'false');
    }

    // Advanced toggle
    const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
    if (toggleAdvancedBtn) {
        toggleAdvancedBtn.addEventListener('click', () => {
            const current = localStorage.getItem('benchmarkShowAdvanced') === 'true';
            setAdvancedMode(!current);
        });
    }

    // Hyper toggle
    const toggleHyperBtn = document.getElementById('toggleHyperBtn');
    if (toggleHyperBtn) {
        toggleHyperBtn.addEventListener('click', () => {
            const current = localStorage.getItem('benchmarkShowHyper') === 'true';
            setHyperMode(!current);
        });
    }

    // Timeline toggle
    const toggleTimelineBtn = document.getElementById('toggleTimelineBtn');
    if (toggleTimelineBtn) {
        toggleTimelineBtn.addEventListener('click', () => {
            const content = document.getElementById('timelineContent');
            const chevron = document.getElementById('timelineChevron');
            if (content && chevron) {
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'block' : 'none';
                chevron.className = isHidden ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
            }
        });
    }

    // Copy hyper JSON button
    const copyHyperJsonBtn = document.getElementById('copyHyperJsonBtn');
    if (copyHyperJsonBtn) {
        copyHyperJsonBtn.addEventListener('click', async () => {
            const pre = document.getElementById('hyperBatchJson');
            if (!pre) return;
            try {
                await navigator.clipboard.writeText(pre.textContent || '');
                const prev = copyHyperJsonBtn.textContent;
                copyHyperJsonBtn.textContent = 'Copied';
                setTimeout(() => { copyHyperJsonBtn.textContent = prev; }, 800);
            } catch (e) { /* ignore */ }
        });
    }

    // Batch inspect buttons
    const bindBatchInspect = (btn, mode) => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            const idOrIndex = pickRepresentativeResultId(mode);
            if (idOrIndex !== null) {
                showJudgeDetails(idOrIndex);
            }
        });
    };

    bindBatchInspect(document.getElementById('inspectBatchFailureBtn'), 'failure');
    bindBatchInspect(document.getElementById('inspectBatchWorstLatencyBtn'), 'worst_latency');
    bindBatchInspect(document.getElementById('inspectBatchWorstThroughputBtn'), 'worst_throughput');
    bindBatchInspect(document.getElementById('inspectBatchLongestJudgeBtn'), 'longest_judge');
    bindBatchInspect(document.getElementById('inspectBatchLowestQualityBtn'), 'lowest_quality');

    // Apply initial state
    setAdvancedMode(localStorage.getItem('benchmarkShowAdvanced') === 'true');

    // Load batch models
    const firstHost = document.getElementById('host')?.value;
    if (firstHost) {
        await loadBatchModels(firstHost);
    }

    // Load judge config
    await loadJudgeConfig();
    await loadBenchmarkPrompts();

    // Check for active batch
    const savedBatchId = localStorage.getItem('currentBatchId');
    const batchIdToResume = await resolveBatchToResume(savedBatchId);
    if (batchIdToResume) {
        debugLog('Attempting to resume batch:', batchIdToResume);
        try {
            const json = await fetchBatchProgress(batchIdToResume);
            const batch = json.data;

            if (batch && (batch.status === 'running' || batch.status === 'judging')) {
                debugLog('Resuming active batch:', batchIdToResume);
                state.setCurrentBatchId(batchIdToResume);
                localStorage.setItem('currentBatchId', batchIdToResume);

                const btn = document.getElementById('runBatchBtn');
                const stopBtn = document.getElementById('stopBatchBtn');
                btn.disabled = true;
                btn.textContent = 'Resuming...';
                stopBtn.style.display = 'inline-block';

                pollBatchProgress();
                const interval = setInterval(pollBatchProgress, 2000);
                state.setBatchPollInterval(interval);
            } else {
                localStorage.removeItem('currentBatchId');
            }
        } catch (err) {
            console.error('Failed to validate saved batch:', err);
            localStorage.removeItem('currentBatchId');
        }
    }

    // Load history
    loadBatchHistory();

    // Recent tests filters
    const recentTestsFailuresOnly = document.getElementById('recentTestsFailuresOnly');
    if (recentTestsFailuresOnly) {
        recentTestsFailuresOnly.addEventListener('change', rerenderRecentTests);
    }
    const recentTestsModelFilter = document.getElementById('recentTestsModelFilter');
    if (recentTestsModelFilter) {
        recentTestsModelFilter.addEventListener('change', rerenderRecentTests);
    }

    // Success rate card
    const successRateCard = document.getElementById('successRateCard');
    if (successRateCard) {
        successRateCard.style.cursor = 'pointer';
        successRateCard.title = 'Click for exec-success vs full-pass breakdown';
        successRateCard.addEventListener('click', toggleSuccessRateDetails);
    }

    // Reset buttons
    const resetLeaderboardBtn = document.getElementById('resetLeaderboardBtn');
    if (resetLeaderboardBtn) {
        resetLeaderboardBtn.addEventListener('click', async () => {
            if (!confirm('Reset all benchmark tests? This cannot be undone.')) return;
            if (!confirm('Are you sure?')) return;

            try {
                resetLeaderboardBtn.disabled = true;
                resetLeaderboardBtn.textContent = 'Resetting...';

                const res = await fetch(`${state.BENCHMARK_API}/results`, { method: 'DELETE' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                if (window.loadDashboard) await window.loadDashboard();

                resetLeaderboardBtn.textContent = 'Reset Tests';
                resetLeaderboardBtn.disabled = false;
            } catch (err) {
                console.error('Failed to reset results:', err);
                alert(`Failed to reset: ${err.message}`);
                resetLeaderboardBtn.textContent = 'Reset Tests';
                resetLeaderboardBtn.disabled = false;
            }
        });
    }

    // Depth matrix initialization
    renderDepthMatrix();
    bindDepthMatrix();

    // Depth quick-action buttons
    const depthAllLightBtn = document.getElementById('depthAllLightBtn');
    if (depthAllLightBtn) {
        depthAllLightBtn.addEventListener('click', () => setAllDepths('light'));
    }
    const depthAllOffBtn = document.getElementById('depthAllOffBtn');
    if (depthAllOffBtn) {
        depthAllOffBtn.addEventListener('click', () => setAllDepths('off'));
    }

    // Timeline controls
    const timelineModeSelect = document.getElementById('timelineMode');
    const timelineOrderSelect = document.getElementById('timelineOrder');
    const timelineZoomSelect = document.getElementById('timelineZoom');

    const updateTimelineControls = () => {
        const mode = getTimelineMode();
        if (timelineZoomSelect) {
            timelineZoomSelect.style.display = mode === 'events' ? '' : 'none';
        }
        if (timelineOrderSelect) {
            timelineOrderSelect.style.display = mode === 'events' ? 'none' : '';
        }
    };

    if (timelineOrderSelect) {
        const savedOrder = localStorage.getItem('benchmarkTimelineOrder');
        if (savedOrder) {
            timelineOrderSelect.value = savedOrder;
        }
        timelineOrderSelect.addEventListener('change', () => {
            localStorage.setItem('benchmarkTimelineOrder', timelineOrderSelect.value);
            loadRecentTestsTimeline();
        });
    }

    if (timelineModeSelect) {
        timelineModeSelect.addEventListener('change', () => {
            updateTimelineControls();
            loadRecentTestsTimeline();
        });
    }

    if (timelineZoomSelect) {
        timelineZoomSelect.addEventListener('change', loadRecentTestsTimeline);
    }

    updateTimelineControls();
    loadRecentTestsTimeline();

    // Periodic refresh
    setInterval(() => {
        if (window.loadDashboard) window.loadDashboard();
        loadRecentTestsTimeline();
    }, 2000);

    // Initialize UI
    updateDepthSummary();

    debugLog('Benchmark UI initialized');
}

// Expose functions to window for legacy inline onclick handlers
/** Run calibration test for the selected judge model */
async function calibrateJudgeModel() {
    const btn = document.getElementById('calibrateJudgeBtn');
    const resultDiv = document.getElementById('calibrationResult');
    const judgeModel = document.getElementById('judgeModel');
    if (!btn || !resultDiv || !judgeModel) return;

    const model = judgeModel.value;
    if (!model) return;

    // Get host from current config
    const host = state.currentJudgeConfig.host || '';

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calibrating...';
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'rgba(52, 152, 219, 0.1)';
    resultDiv.style.border = '1px solid rgba(52, 152, 219, 0.3)';
    resultDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running 5 calibration tests...';

    try {
        const res = await fetch('/api/benchmark/judge/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, model })
        });
        const json = await res.json();

        if (json.status === 'success') {
            const d = json.data;
            const tierColors = { basic: '#e74c3c', standard: '#f39c12', advanced: '#2ecc71', premium: '#9b59b6' };
            const color = tierColors[d.tier] || '#95a5a6';
            const passRate = Math.round(d.reliability * 100);

            resultDiv.style.background = `rgba(${d.reliability >= 0.8 ? '46, 204, 113' : '231, 76, 60'}, 0.1)`;
            resultDiv.style.border = `1px solid ${color}`;
            resultDiv.innerHTML = `
                <div style="margin-bottom: 6px;"><strong>Tier:</strong> <span style="color: ${color}; font-weight: bold; text-transform: uppercase;">${d.tier}</span></div>
                <div><strong>Reliability:</strong> ${passRate}% (${d.tests_passed}/${d.tests_total} tests passed)</div>
                <div><strong>Avg Latency:</strong> ${d.avg_latency_ms}ms</div>
                <div style="margin-top: 6px; font-size: 0.8em; opacity: 0.7;">
                    ${d.details.map(t => `${t.passed ? '\u2705' : '\u274C'} ${t.id} (${t.latency_ms}ms)`).join(' | ')}
                </div>
            `;
        } else {
            resultDiv.style.background = 'rgba(231, 76, 60, 0.1)';
            resultDiv.style.border = '1px solid rgba(231, 76, 60, 0.5)';
            resultDiv.innerHTML = `<i class="fas fa-times-circle"></i> ${json.error || 'Calibration failed'}`;
        }
    } catch (err) {
        resultDiv.style.background = 'rgba(231, 76, 60, 0.1)';
        resultDiv.innerHTML = `<i class="fas fa-times-circle"></i> ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-flask"></i> Calibrate Judge';
    }
}

window.calibrateJudgeModel = calibrateJudgeModel;
window.switchCategoryTab = switchCategoryTab;
window.showJudgeDetails = showJudgeDetails;
window.closeJudgeDetails = closeJudgeDetails;
window.recoverBatch = recoverBatch;
window.showTimelineTooltip = showTimelineTooltip;

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBenchmarkUI);
} else {
    initBenchmarkUI();
}
