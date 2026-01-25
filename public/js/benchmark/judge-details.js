// judge-details.js - showJudgeDetails modal

import * as state from './state.js';
import { escapeHtml, toFiniteNumber, formatHostLabel } from './utils.js';

/**
 * Show judge details modal for a result
 */
export function showJudgeDetails(idOrIndex) {
    const results = state.currentBatchResults;
    if (!Array.isArray(results) || results.length === 0) {
        console.warn('No results available');
        return;
    }

    state.setCurrentJudgeDetailId(idOrIndex);
    window.currentJudgeDetailId = idOrIndex;

    // Find result by ID or index
    let result = null;
    let resultIndex = -1;

    if (typeof idOrIndex === 'number') {
        resultIndex = idOrIndex;
        result = results[idOrIndex];
    } else {
        const idStr = String(idOrIndex);
        resultIndex = results.findIndex(r =>
            String(r.id) === idStr ||
            String(r._id) === idStr
        );
        if (resultIndex >= 0) {
            result = results[resultIndex];
        } else {
            // Try parsing as index
            const idx = parseInt(idStr, 10);
            if (!isNaN(idx) && idx >= 0 && idx < results.length) {
                resultIndex = idx;
                result = results[idx];
            }
        }
    }

    if (!result) {
        console.warn('Result not found:', idOrIndex);
        return;
    }

    const modal = document.getElementById('judgeDetailsModal');
    if (!modal) {
        console.warn('Judge details modal not found');
        return;
    }

    // Populate modal content
    populateJudgeModal(result, resultIndex);

    // Show modal
    modal.style.display = 'block';
}

/**
 * Populate judge details modal
 * Uses the actual element IDs from benchmark.html
 */
function populateJudgeModal(result, resultIndex) {
    const isFailed = result.success === false;

    // Prompt name/level - element ID: detailPromptName
    const promptNameEl = document.getElementById('detailPromptName');
    if (promptNameEl) {
        const name = result.prompt_name || result.prompt_id || 'Unknown';
        const level = result.prompt_level || result.level || '';
        const model = result.model || 'Unknown';
        promptNameEl.innerHTML = `${escapeHtml(name)}${level ? ` (L${level})` : ''} <span style="color: var(--muted); font-weight: normal;">- ${escapeHtml(model)}</span>`;
    }

    // Scoring method - element ID: detailScoringMethod
    const scoringMethodEl = document.getElementById('detailScoringMethod');
    if (scoringMethodEl) {
        const judgeModel = result.judge_model || state.currentJudgeConfig.model || 'Default Judge';
        const q = toFiniteNumber(result.quality_score);
        let scoreHtml = '';
        if (isFailed) {
            scoreHtml = '<span style="color: #e74c3c; font-weight: 600;"><i class="fas fa-times-circle"></i> FAILED</span>';
        } else if (q !== null) {
            let color = '#2ecc71';
            if (q < 4) color = '#e74c3c';
            else if (q < 7) color = '#f39c12';
            scoreHtml = `<span style="color: ${color}; font-weight: 600;">${q.toFixed(1)}/10</span>`;
        } else {
            scoreHtml = '<span style="color: var(--muted);">Pending...</span>';
        }
        scoringMethodEl.innerHTML = `${escapeHtml(judgeModel)} &nbsp;|&nbsp; Score: ${scoreHtml}`;
    }

    // Judging steps / metadata - element ID: detailJudgeSteps, detailJudgeMeta
    const judgeStepsEl = document.getElementById('detailJudgeSteps');
    const judgeMetaEl = document.getElementById('detailJudgeMeta');
    if (judgeStepsEl) {
        if (isFailed) {
            judgeStepsEl.innerHTML = `<div style="color: #e74c3c;"><i class="fas fa-exclamation-triangle"></i> Test failed - no judging performed</div>`;
        } else {
            const steps = [];
            steps.push(`<div><i class="fas fa-robot" style="color: var(--accent); width: 20px;"></i> Model executed prompt</div>`);
            if (result.latency) {
                const lat = toFiniteNumber(result.latency);
                steps.push(`<div><i class="fas fa-clock" style="color: var(--muted); width: 20px;"></i> Latency: ${lat < 1000 ? lat + 'ms' : (lat/1000).toFixed(2) + 's'}</div>`);
            }
            if (result.tokens_per_sec) {
                const tps = toFiniteNumber(result.tokens_per_sec);
                if (tps !== null) {
                    steps.push(`<div><i class="fas fa-tachometer-alt" style="color: var(--muted); width: 20px;"></i> Throughput: ${tps.toFixed(2)} tok/s</div>`);
                }
            }
            steps.push(`<div><i class="fas fa-gavel" style="color: #9b59b6; width: 20px;"></i> Judge evaluated response</div>`);
            if (result.scoring_time_ms) {
                const jt = toFiniteNumber(result.scoring_time_ms);
                steps.push(`<div><i class="fas fa-hourglass-half" style="color: var(--muted); width: 20px;"></i> Judge time: ${jt < 1000 ? jt + 'ms' : (jt/1000).toFixed(2) + 's'}</div>`);
            }
            judgeStepsEl.innerHTML = steps.join('');
        }
    }
    if (judgeMetaEl) {
        const meta = [];
        if (result.host) meta.push(`Host: ${formatHostLabel(result.host)}`);
        if (result.judge_host) meta.push(`Judge Host: ${formatHostLabel(result.judge_host)}`);
        if (result.timestamp) meta.push(`Time: ${new Date(result.timestamp).toLocaleString()}`);
        judgeMetaEl.textContent = meta.join(' | ');
    }

    // Model response - element ID: detailResponse
    const responseEl = document.getElementById('detailResponse');
    if (responseEl) {
        if (isFailed) {
            responseEl.innerHTML = `<span style="color: #e74c3c;"><strong>Error:</strong> ${escapeHtml(result.error || 'Unknown error')}</span>`;
        } else {
            responseEl.textContent = result.response || 'No response captured';
        }
    }

    // Judge prompt (input to judge) - element ID: detailJudgePrompt
    const judgePromptEl = document.getElementById('detailJudgePrompt');
    if (judgePromptEl) {
        if (result.judge_prompt || result.judge_input) {
            judgePromptEl.textContent = result.judge_prompt || result.judge_input;
        } else {
            // Reconstruct from prompt + response
            const prompt = result.prompt || result.prompt_text || '';
            const response = result.response || '';
            if (prompt || response) {
                judgePromptEl.innerHTML = `<strong>Prompt:</strong>\n${escapeHtml(prompt)}\n\n<strong>Response:</strong>\n${escapeHtml(response)}`;
            } else {
                judgePromptEl.textContent = 'Not available';
            }
        }
    }

    // Judge explanation - element ID: detailExplanation
    const explanationEl = document.getElementById('detailExplanation');
    if (explanationEl) {
        if (isFailed) {
            explanationEl.innerHTML = '<span style="color: var(--muted);">Not available for failed tests</span>';
            explanationEl.style.borderLeftColor = '#e74c3c';
            explanationEl.style.background = 'rgba(231, 76, 60, 0.1)';
        } else if (result.judge_reasoning || result.quality_reasoning || result.judge_explanation) {
            explanationEl.textContent = result.judge_reasoning || result.quality_reasoning || result.judge_explanation;
            explanationEl.style.borderLeftColor = '#2ecc71';
            explanationEl.style.background = 'rgba(46, 204, 113, 0.1)';
        } else {
            explanationEl.textContent = 'No explanation available from judge';
            explanationEl.style.borderLeftColor = 'var(--muted)';
            explanationEl.style.background = 'rgba(0,0,0,0.1)';
        }
    }
}

/**
 * Update navigation buttons
 */
function updateNavigationButtons(currentIndex) {
    const results = state.currentBatchResults;
    const prevBtn = document.getElementById('judgeDetailPrevBtn');
    const nextBtn = document.getElementById('judgeDetailNextBtn');
    const indexEl = document.getElementById('judgeDetailIndex');

    if (prevBtn) {
        prevBtn.disabled = currentIndex <= 0;
        prevBtn.onclick = () => {
            if (currentIndex > 0) {
                showJudgeDetails(currentIndex - 1);
            }
        };
    }

    if (nextBtn) {
        nextBtn.disabled = currentIndex >= results.length - 1;
        nextBtn.onclick = () => {
            if (currentIndex < results.length - 1) {
                showJudgeDetails(currentIndex + 1);
            }
        };
    }

    if (indexEl) {
        indexEl.textContent = `${currentIndex + 1} / ${results.length}`;
    }
}

/**
 * Close judge details modal
 */
export function closeJudgeDetails() {
    const modal = document.getElementById('judgeDetailsModal');
    if (modal) {
        modal.style.display = 'none';
    }
    state.setCurrentJudgeDetailId(null);
    window.currentJudgeDetailId = null;
}

// Expose to window for legacy code
if (typeof window !== 'undefined') {
    window.showJudgeDetails = showJudgeDetails;
    window.closeJudgeDetails = closeJudgeDetails;
}
