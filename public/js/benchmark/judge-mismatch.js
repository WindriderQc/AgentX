// judge-mismatch.js
// Tier-awareness layer for the depth matrix.
// Shows per-level required judge tier, highlights mismatches, renders a
// summary banner, and offers a "Best judge for this run" suggestion.

import * as state from './state.js';
import { escapeHtml } from './utils.js';

// ── Tier meta (mirrors backend judgeTierResolver) ──────────────────────────

const TIER_RANK  = { basic: 1, standard: 2, advanced: 3, premium: 4 };
const TIER_LABEL = { basic: 'BASIC', standard: 'STD', advanced: 'ADV', premium: 'PRO' };
const TIER_COLOR = {
    basic:    { bg: 'rgba(108,117,125,0.2)',  border: 'rgba(108,117,125,0.6)',  text: '#adb5bd' },
    standard: { bg: 'rgba(13,110,253,0.15)',  border: 'rgba(13,110,253,0.5)',   text: '#4096ff' },
    advanced: { bg: 'rgba(25,135,84,0.15)',   border: 'rgba(25,135,84,0.5)',    text: '#52c41a' },
    premium:  { bg: 'rgba(220,53,69,0.15)',   border: 'rgba(220,53,69,0.5)',    text: '#ff4d4f' }
};

// ── Helpers ────────────────────────────────────────────────────────────────

function higherTier(left, right) {
    const leftRank = TIER_RANK[left] || 0;
    const rightRank = TIER_RANK[right] || 0;
    return rightRank > leftRank ? right : left;
}

/**
 * Return the tier required for a given level using prompt metadata when available.
 */
export function requiredTierForLevel(level) {
    let requiredTier = (state.judgeTierMap && state.judgeTierMap[level]) || 'standard';
    const prompts = Array.isArray(state.benchmarkPrompts) ? state.benchmarkPrompts : [];

    for (const prompt of prompts) {
        if (Number(prompt && prompt.level) !== Number(level)) continue;

        if (prompt && prompt.required_judge_tier) {
            requiredTier = higherTier(requiredTier, prompt.required_judge_tier);
        }

        const categoryTier = prompt && prompt.category
            ? state.categoryTierMap && state.categoryTierMap[prompt.category]
            : null;
        if (categoryTier) {
            requiredTier = higherTier(requiredTier, categoryTier);
        }
    }

    return requiredTier;
}

/**
 * Infer tier for a model name when no registry entry is present.
 * Mirrors backend judgeTierResolver.inferJudgeTier().
 */
function inferTierFromName(modelName) {
    if (!modelName) return 'standard';
    const n = modelName.toLowerCase();
    if (/70b|72b|671b|405b/.test(n)) return 'premium';
    if (/32b|34b|30b|40b/.test(n)) return 'advanced';
    if (/14b|13b|20b|22b/.test(n)) return 'advanced';
    if (/7b|8b|9b|q5|q6|q8/.test(n)) return 'standard';
    if (/3b|2b|1\.5b/.test(n)) return 'basic';
    return 'standard';
}

function resolveTierValue(explicitTier, inferredTier) {
    if (!explicitTier) return inferredTier;
    if (!inferredTier) return explicitTier;
    return higherTier(explicitTier, inferredTier);
}

function effectiveCandidateTier(candidate) {
    const explicitTier = candidate && candidate.capabilities && candidate.capabilities.judgeTier;
    const inferredTier = inferTierFromName(candidate && candidate.modelName);
    return resolveTierValue(explicitTier, inferredTier);
}

/**
 * Resolve the current judge tier from state.currentJudgeConfig.
 * Uses the stronger of attached tier metadata and the model-name heuristic.
 */
export function currentJudgeTier() {
    const cfg = state.currentJudgeConfig || {};
    const explicitTier = cfg.judgeTier || cfg.tier || '';
    const inferredTier = inferTierFromName(cfg.model || '');
    return resolveTierValue(explicitTier, inferredTier) || 'standard';
}

/**
 * Given an array of selected levels, return the strongest required tier.
 */
export function strongestRequiredTier(levels) {
    let bestTier = 'basic';
    for (const lvl of levels) {
        const t = requiredTierForLevel(lvl);
        bestTier = higherTier(bestTier, t);
    }
    return bestTier;
}

// ── Tier badge HTML ────────────────────────────────────────────────────────

export function tierBadgeHtml(tier, title = '') {
    const c = TIER_COLOR[tier] || TIER_COLOR.standard;
    const label = TIER_LABEL[tier] || tier.toUpperCase();
    return `<span class="judge-tier-badge" title="${escapeHtml(title)}"
        style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.72em;font-weight:700;
        letter-spacing:.5px;background:${c.bg};border:1px solid ${c.border};color:${c.text};">${label}</span>`;
}

/**
 * Returns true if the current judge tier is below what any selected level needs.
 * Used by batch-execution to show a confirmation before starting.
 */
export function hasTierMismatch(activeLevels) {
    const judgeRank = TIER_RANK[currentJudgeTier()] || 0;
    return (activeLevels || []).some(lvl => (TIER_RANK[requiredTierForLevel(lvl)] || 0) > judgeRank);
}

// ── Per-row tier cell in depth matrix ─────────────────────────────────────

/**
 * Inject a "Required Tier" column header into the depth matrix table.
 * Called once on init.
 */
export function injectTierColumnHeader() {
    const thead = document.querySelector('#depthMatrix thead tr');
    if (!thead || thead.querySelector('.judge-tier-th')) return;
    const th = document.createElement('th');
    th.className = 'judge-tier-th';
    th.title = 'Minimum judge tier needed to score this level accurately';
    th.style.cssText = 'font-size:0.78em;color:var(--muted);text-align:center;white-space:nowrap;padding:6px 8px;';
    th.innerHTML = '<i class="fas fa-gavel" style="margin-right:4px;"></i>Tier';
    thead.appendChild(th);
}

/**
 * Update (or inject) the tier cell for a single row.
 */
function updateRowTierCell(row, level, judgeTier) {
    const requiredTier = requiredTierForLevel(level);
    const reqRank = TIER_RANK[requiredTier] || 0;
    const curRank = TIER_RANK[judgeTier] || 0;
    const mismatch = curRank < reqRank;

    let cell = row.querySelector('.judge-tier-td');
    if (!cell) {
        cell = document.createElement('td');
        cell.className = 'judge-tier-td';
        cell.style.cssText = 'text-align:center;vertical-align:middle;padding:4px 6px;';
        row.appendChild(cell);
    }

    const tooltip = mismatch
        ? `Needs ${requiredTier.toUpperCase()} — current judge is ${judgeTier.toUpperCase()}`
        : `Required: ${requiredTier.toUpperCase()}`;

    cell.innerHTML = tierBadgeHtml(requiredTier, tooltip);
    cell.title = tooltip;

    // Row highlight
    row.classList.toggle('judge-tier-mismatch', mismatch);
    if (mismatch) {
        row.style.outline = '1px solid rgba(220,53,69,0.35)';
        row.style.background = 'rgba(220,53,69,0.04)';
    } else {
        row.style.outline = '';
        row.style.background = '';
    }
}

/**
 * Refresh all tier cells in the depth matrix for the active levels.
 * @param {number[]} activeLevels — levels with depth !== 'off'
 */
export function refreshDepthMatrixTierCells(activeLevels) {
    const activeLevelSet = new Set(activeLevels);
    const tbody = document.getElementById('depthMatrixBody');
    if (!tbody) return;

    const judgeTier = currentJudgeTier();

    for (const row of tbody.querySelectorAll('tr[data-level]')) {
        const level = parseInt(row.dataset.level, 10);
        if (!activeLevelSet.has(level)) {
            // Level is 'off' — clear mismatch styling, remove tier cell
            row.classList.remove('judge-tier-mismatch');
            row.style.outline = '';
            row.style.background = '';
            const cell = row.querySelector('.judge-tier-td');
            if (cell) cell.innerHTML = '<span style="color:var(--muted);font-size:0.8em;">—</span>';
            continue;
        }
        updateRowTierCell(row, level, judgeTier);
    }
}

// ── Mismatch banner ────────────────────────────────────────────────────────

/**
 * Render (or update) the mismatch banner above the depth matrix.
 * @param {number[]} activeLevels
 */
export function renderMismatchBanner(activeLevels) {
    const container = document.getElementById('judgeMismatchBanner');
    if (!container) return;

    const judgeTier = currentJudgeTier();
    const judgeRank = TIER_RANK[judgeTier] || 0;
    const judgeModel = (state.currentJudgeConfig && state.currentJudgeConfig.model) || '(default)';

    // Find mismatched levels
    const mismatchedLevels = activeLevels.filter(lvl => {
        const reqRank = TIER_RANK[requiredTierForLevel(lvl)] || 0;
        return reqRank > judgeRank;
    });

    if (mismatchedLevels.length === 0) {
        container.style.display = 'none';
        return;
    }

    const strongestRequired = strongestRequiredTier(mismatchedLevels);
    const strongestReqColor = TIER_COLOR[strongestRequired] || TIER_COLOR.standard;

    // Find a better judge from registry if available
    let suggestion = null;
    const judgeModels = Object.values(state.modelRegistryCache || {})
        .filter(m => Array.isArray(m.categories) && m.categories.includes('judge'));
    const reqRank = TIER_RANK[strongestRequired] || 0;
    const capable = judgeModels
        .filter(m => {
            const t = effectiveCandidateTier(m);
            return (TIER_RANK[t] || 0) >= reqRank;
        })
        .sort((a, b) => {
            const ta = TIER_RANK[effectiveCandidateTier(a)] || 0;
            const tb = TIER_RANK[effectiveCandidateTier(b)] || 0;
            return ta - tb; // pick lowest tier that still qualifies (least overkill)
        });
    if (capable.length > 0) {
        suggestion = capable[0];
    }

    const levelsStr = mismatchedLevels.join(', ');
    const suggestionHtml = suggestion
        ? `<button class="judge-mismatch-suggest-btn"
                style="margin-left:12px;padding:4px 10px;border-radius:5px;border:1px solid ${strongestReqColor.border};
                background:${strongestReqColor.bg};color:${strongestReqColor.text};cursor:pointer;font-size:0.85em;font-weight:600;"
                data-model="${escapeHtml(suggestion.modelName)}"
                title="Switch judge to ${escapeHtml(suggestion.modelName)}">
            <i class="fas fa-magic"></i> Use ${escapeHtml(suggestion.modelName)}
           </button>`
        : '';

    const modelSizeHint =
        strongestRequired === 'advanced' ? '14B+ model (e.g. qwen2.5:14b)' :
                                           '7B+ model';

    container.style.display = 'flex';
    container.innerHTML = `
        <div style="display:flex;align-items:flex-start;flex-wrap:wrap;gap:10px;padding:13px 16px;
            background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.55);
            border-radius:8px;font-size:0.88em;width:100%;box-sizing:border-box;">
            <i class="fas fa-ban" style="color:#e74c3c;flex-shrink:0;margin-top:3px;font-size:1.1em;"></i>
            <div style="flex:1;min-width:200px;">
                <strong style="color:#e74c3c;font-size:1em;">Batch blocked — judge tier too low</strong><br>
                <span style="color:var(--text);">Levels <strong>${levelsStr}</strong> require at least
                ${tierBadgeHtml(strongestRequired)}, but current judge
                (<code>${escapeHtml(judgeModel)}</code>) is ${tierBadgeHtml(judgeTier)}.
                Running with an under-tiered judge produces unreliable scores.</span><br>
                <span style="color:var(--muted);font-size:0.9em;margin-top:4px;display:inline-block;">
                    <strong>To fix:</strong> load a <strong>${modelSizeHint}</strong> on the judge host,
                    open <a href="/courthouse.html" target="_blank"
                        style="color:var(--accent);text-decoration:underline;">Courthouse → Judge Roster</a>,
                    set its <code>judgeTier</code> to <code>${strongestRequired}</code>,
                    then select it as judge here.
                </span>
            </div>
            <div style="display:flex;gap:6px;align-items:flex-start;flex-shrink:0;flex-wrap:wrap;padding-top:2px;">
                ${suggestionHtml}
                <a href="/courthouse.html" target="_blank"
                    style="padding:4px 10px;border-radius:5px;border:1px solid rgba(124,240,255,0.4);
                    background:rgba(124,240,255,0.08);color:var(--accent);font-size:0.85em;
                    font-weight:600;text-decoration:none;white-space:nowrap;">
                    <i class="fas fa-balance-scale"></i> Courthouse
                </a>
                <button class="judge-mismatch-dismiss-btn"
                    style="padding:4px 8px;background:none;border:1px solid rgba(220,53,69,0.35);
                    color:#e74c3c;border-radius:4px;cursor:pointer;font-size:0.85em;"
                    title="Dismiss banner (batch still cannot start)">Dismiss</button>
            </div>
        </div>`;

    // Suggest button — updates judge config
    container.querySelector('.judge-mismatch-suggest-btn')?.addEventListener('click', (e) => {
        const model = e.currentTarget.dataset.model;
        if (!model) return;
        // Dispatch a custom event; index.js listens and applies the suggested judge
        document.dispatchEvent(new CustomEvent('judgeSuggestionApply', { detail: { model } }));
    });

    container.querySelector('.judge-mismatch-dismiss-btn')?.addEventListener('click', () => {
        container.style.display = 'none';
    });
}

// ── Master refresh — call whenever judge or levels change ──────────────────

/**
 * @param {number[]} activeLevels
 */
export function refreshJudgeTierUI(activeLevels) {
    injectTierColumnHeader();
    refreshDepthMatrixTierCells(activeLevels);
    renderMismatchBanner(activeLevels);
}
