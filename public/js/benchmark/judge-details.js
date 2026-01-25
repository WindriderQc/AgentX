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
 */
function populateJudgeModal(result, resultIndex) {
    const isFailed = result.success === false;

    // Title
    const titleEl = document.getElementById('judgeDetailsTitle');
    if (titleEl) {
        if (isFailed) {
            titleEl.innerHTML = `<i class="fas fa-exclamation-triangle" style="color: #e74c3c;"></i> Test Failed - ${escapeHtml(result.model)}`;
        } else {
            titleEl.textContent = `Judge Details - ${escapeHtml(result.model)}`;
        }
    }

    // Model info
    const modelEl = document.getElementById('judgeDetailModel');
    if (modelEl) {
        modelEl.textContent = result.model || 'Unknown';
    }

    // Host info
    const hostEl = document.getElementById('judgeDetailHost');
    if (hostEl) {
        hostEl.textContent = formatHostLabel(result.host);
    }

    // Judge host info
    const judgeHostEl = document.getElementById('judgeDetailJudgeHost');
    if (judgeHostEl) {
        judgeHostEl.textContent = formatHostLabel(result.judge_host) || 'N/A';
    }

    // Status
    const statusEl = document.getElementById('judgeDetailStatus');
    if (statusEl) {
        if (isFailed) {
            statusEl.innerHTML = '<span style="color: #e74c3c; font-weight: 600;"><i class="fas fa-times-circle"></i> FAILED</span>';
        } else {
            statusEl.innerHTML = '<span style="color: #2ecc71; font-weight: 600;"><i class="fas fa-check-circle"></i> SUCCESS</span>';
        }
    }

    // Prompt
    const promptEl = document.getElementById('judgeDetailPrompt');
    if (promptEl) {
        promptEl.textContent = result.prompt || result.prompt_text || 'N/A';
    }

    // Prompt name/level
    const promptNameEl = document.getElementById('judgeDetailPromptName');
    if (promptNameEl) {
        const name = result.prompt_name || result.prompt_id || 'Unknown';
        const level = result.prompt_level || result.level || '';
        promptNameEl.textContent = level ? `${name} (L${level})` : name;
    }

    // Response
    const responseEl = document.getElementById('judgeDetailResponse');
    if (responseEl) {
        if (isFailed) {
            responseEl.innerHTML = `<div style="color: #e74c3c; padding: 12px; background: rgba(231, 76, 60, 0.1); border-radius: 8px;">
                <strong>Error:</strong> ${escapeHtml(result.error || 'Unknown error')}
            </div>`;
        } else {
            responseEl.textContent = result.response || 'N/A';
        }
    }

    // Latency
    const latencyEl = document.getElementById('judgeDetailLatency');
    if (latencyEl) {
        const lat = toFiniteNumber(result.latency);
        if (lat !== null) {
            latencyEl.textContent = lat < 1000 ? `${lat}ms` : `${(lat / 1000).toFixed(2)}s`;
        } else {
            latencyEl.textContent = '-';
        }
    }

    // Tokens per second
    const tpsEl = document.getElementById('judgeDetailTps');
    if (tpsEl) {
        const tps = toFiniteNumber(result.tokens_per_sec);
        tpsEl.textContent = tps !== null ? `${tps.toFixed(2)} tok/s` : '-';
    }

    // Token counts
    const tokensEl = document.getElementById('judgeDetailTokens');
    if (tokensEl) {
        const inputTokens = result.input_tokens || result.prompt_eval_count || '-';
        const outputTokens = result.output_tokens || result.eval_count || '-';
        tokensEl.textContent = `In: ${inputTokens} / Out: ${outputTokens}`;
    }

    // Quality score
    const qualityEl = document.getElementById('judgeDetailQuality');
    if (qualityEl) {
        if (isFailed) {
            qualityEl.innerHTML = '<span style="color: #e74c3c;">N/A</span>';
        } else {
            const q = toFiniteNumber(result.quality_score);
            if (q !== null) {
                let color = '#2ecc71';
                if (q < 4) color = '#e74c3c';
                else if (q < 7) color = '#f39c12';
                qualityEl.innerHTML = `<span style="color: ${color}; font-weight: 600;">${q.toFixed(1)}/10</span>`;
            } else {
                qualityEl.textContent = 'Pending...';
            }
        }
    }

    // Judge reasoning
    const reasoningEl = document.getElementById('judgeDetailReasoning');
    if (reasoningEl) {
        if (isFailed) {
            reasoningEl.innerHTML = '<div style="color: var(--muted);">Not available for failed tests</div>';
        } else if (result.judge_reasoning || result.quality_reasoning) {
            reasoningEl.textContent = result.judge_reasoning || result.quality_reasoning;
        } else {
            reasoningEl.textContent = 'No reasoning available';
        }
    }

    // Judge time
    const judgeTimeEl = document.getElementById('judgeDetailJudgeTime');
    if (judgeTimeEl) {
        const jt = toFiniteNumber(result.scoring_time_ms);
        if (jt !== null) {
            judgeTimeEl.textContent = jt < 1000 ? `${jt}ms` : `${(jt / 1000).toFixed(2)}s`;
        } else {
            judgeTimeEl.textContent = '-';
        }
    }

    // Judge model
    const judgeModelEl = document.getElementById('judgeDetailJudgeModel');
    if (judgeModelEl) {
        judgeModelEl.textContent = result.judge_model || state.currentJudgeConfig.model || 'Default';
    }

    // Timestamp
    const timestampEl = document.getElementById('judgeDetailTimestamp');
    if (timestampEl) {
        if (result.timestamp) {
            timestampEl.textContent = new Date(result.timestamp).toLocaleString();
        } else {
            timestampEl.textContent = '-';
        }
    }

    // Navigation buttons
    updateNavigationButtons(resultIndex);
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
