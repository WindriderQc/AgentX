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

    const shouldHydrate = needsDetailHydration(result);
    setHydrationStatus(shouldHydrate, shouldHydrate ? 'Loading full prompt/response…' : '');

    // Compact batch payload omits full prompt/response by default.
    // Hydrate from result details endpoint on-demand for this modal.
    hydrateJudgeDetailResult(result, resultIndex)
        .then((hydrated) => {
            setHydrationStatus(false);
            if (hydrated) {
                populateJudgeModal(hydrated, resultIndex);
            }
        })
        .catch((err) => {
            setHydrationStatus(false);
            console.warn('Failed to hydrate judge detail result:', err.message);
        });
}

function setHydrationStatus(isLoading, message = '') {
    const modal = document.getElementById('judgeDetailsModal');
    const modalBody = modal ? modal.querySelector('.modal-body') : null;
    if (!modalBody) return;

    let statusEl = document.getElementById('judgeDetailsHydrationStatus');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'judgeDetailsHydrationStatus';
        statusEl.style.cssText = 'display:none;margin-bottom:10px;padding:8px 10px;border-radius:6px;border:1px solid rgba(124,240,255,0.35);background:rgba(124,240,255,0.12);color:var(--text);font-size:0.9em;';
        modalBody.insertBefore(statusEl, modalBody.firstChild);
    }

    if (isLoading) {
        statusEl.textContent = message || 'Loading details…';
        statusEl.style.display = 'block';
    } else {
        statusEl.style.display = 'none';
    }
}

function getResultIdentifier(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.id) return String(result.id);
    if (result._id) return String(result._id);
    return null;
}

function needsDetailHydration(result) {
    if (!result || typeof result !== 'object') return false;
    const hasPrompt = typeof result.prompt === 'string' && result.prompt.length > 0;
    const hasResponse = typeof result.response === 'string' && result.response.length > 0;
    return !(hasPrompt && hasResponse);
}

async function hydrateJudgeDetailResult(result, resultIndex) {
    if (!needsDetailHydration(result)) return null;

    const resultId = getResultIdentifier(result);
    if (!resultId) return null;

    const res = await fetch(`/api/benchmark/results/${encodeURIComponent(resultId)}`);
    if (!res.ok) return null;

    const json = await res.json().catch(() => null);
    if (!json || json.status !== 'success' || !json.data) return null;

    const merged = {
        ...result,
        ...json.data,
        id: resultId
    };

    const snapshot = Array.isArray(state.currentBatchResults) ? [...state.currentBatchResults] : [];
    if (resultIndex >= 0 && resultIndex < snapshot.length) {
        const currentAtIndexId = getResultIdentifier(snapshot[resultIndex]);
        if (currentAtIndexId === resultId) {
            snapshot[resultIndex] = merged;
            state.setCurrentBatchResults(snapshot);
        }
    }

    return merged;
}

/**
 * Populate judge details modal
 * Uses the actual element IDs from benchmark.html
 */
function populateJudgeModal(result, resultIndex) {
    const scoringMethod = String(result.scoring_method || '').toLowerCase();
    const isExecFailed = (result.success === false) || (scoringMethod === 'exec_failed');
    const isJudgeFailed = scoringMethod === 'llm_failed';
    const isFailed = isExecFailed || isJudgeFailed;

    const isInfraFail = isFailed && (result.infra_error === true || String(result.error_type || '').toLowerCase() === 'infra');
    const failType = isFailed
        ? (isInfraFail ? 'infra' : (String(result.error_type || '').toLowerCase() === 'model' ? 'model' : 'unknown'))
        : null;
    const failBadgeHtml = isFailed
        ? (() => {
            const label = failType === 'infra' ? 'INFRA' : failType === 'model' ? 'MODEL' : 'UNKNOWN';
            const icon = failType === 'infra' ? 'fa-network-wired' : failType === 'model' ? 'fa-bug' : 'fa-question-circle';
            const http = Number.isFinite(result.error_http_status) ? ` HTTP ${result.error_http_status}` : '';
            const msgRaw = (result.error || result.error_message || '').toString();
            const msg = msgRaw.replace(/\s+/g, ' ').trim().slice(0, 220);
            const title = `${label}${http}${msg ? `: ${msg}` : ''}`;
            return ` <span class="fail-badge ${failType}" title="${escapeHtml(title)}"><i class="fas ${icon}"></i>${label}</span>`;
        })()
        : '';

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
            scoreHtml = `<span style="color: #e74c3c; font-weight: 600;"><i class="fas fa-times-circle"></i> FAILED</span>${failBadgeHtml}`;
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
        if (isExecFailed) {
            judgeStepsEl.innerHTML = `<div style="color: #e74c3c;"><i class="fas fa-exclamation-triangle"></i> Test failed - no judging performed</div>`;
        } else if (isJudgeFailed) {
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
            const errMsgRaw = (result.error || result.error_message || result.quality_explanation || '').toString();
            const errMsg = errMsgRaw.replace(/\s+/g, ' ').trim();
            steps.push(`<div><i class="fas fa-gavel" style="color: #e74c3c; width: 20px;"></i> Judge failed${errMsg ? `: ${escapeHtml(errMsg).slice(0, 180)}` : ''}</div>`);
            judgeStepsEl.innerHTML = steps.join('');
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
        if (isExecFailed) {
            responseEl.innerHTML = `<span style="color: #e74c3c;"><strong>Error:</strong> ${escapeHtml(result.error || 'Unknown error')}</span>`;
        } else {
            responseEl.textContent = result.response || result.response_preview || 'No response captured';
        }
    }

    // Judge prompt (input to judge) - element ID: detailJudgePrompt
    const judgePromptEl = document.getElementById('detailJudgePrompt');
    if (judgePromptEl) {
        if (result.judge_prompt || result.judge_input) {
            judgePromptEl.textContent = result.judge_prompt || result.judge_input;
        } else {
            // Reconstruct from prompt + response
            const prompt = result.prompt || result.prompt_text || result.prompt_preview || '';
            const response = result.response || result.response_preview || '';
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
        if (isExecFailed) {
            explanationEl.innerHTML = '<span style="color: var(--muted);">Not available for failed tests</span>';
            explanationEl.style.borderLeftColor = '#e74c3c';
            explanationEl.style.background = 'rgba(231, 76, 60, 0.1)';
        } else if (isJudgeFailed) {
            const failureText = result.quality_explanation || result.error || 'Judge failed without additional details.';
            explanationEl.textContent = failureText;
            explanationEl.style.borderLeftColor = '#e74c3c';
            explanationEl.style.background = 'rgba(231, 76, 60, 0.1)';
        } else if (result.quality_explanation || result.judge_reasoning || result.quality_reasoning || result.judge_explanation) {
            explanationEl.textContent = result.quality_explanation || result.judge_reasoning || result.quality_reasoning || result.judge_explanation;
            explanationEl.style.borderLeftColor = '#2ecc71';
            explanationEl.style.background = 'rgba(46, 204, 113, 0.1)';
        } else {
            explanationEl.textContent = 'No explanation available from judge';
            explanationEl.style.borderLeftColor = 'var(--muted)';
            explanationEl.style.background = 'rgba(0,0,0,0.1)';
        }
    }

    // Scoring Breakdown section (semantic, format, quality)
    let scoringBreakdownEl = document.getElementById('detailScoringBreakdown');
    if (!scoringBreakdownEl) {
        const parent = explanationEl ? explanationEl.parentElement : document.querySelector('.modal-body');
        if (parent) {
            const container = document.createElement('div');
            container.className = 'detail-section';
            container.style.marginTop = '20px';
            container.innerHTML = `
                <h4>Scoring Breakdown</h4>
                <div id="detailScoringBreakdown" class="explanation-box" style="border-left-color: var(--accent-2, #9b59b6);"></div>
            `;
            if (explanationEl && explanationEl.parentElement) {
                explanationEl.parentElement.after(container);
            } else {
                parent.appendChild(container);
            }
            scoringBreakdownEl = document.getElementById('detailScoringBreakdown');
        }
    }

    if (scoringBreakdownEl) {
        const hasSemantic = result.semantic_score !== undefined && result.semantic_score !== null;
        const hasFormat = result.format_score !== undefined && result.format_score !== null;
        const hasQuality = result.quality_score !== undefined && result.quality_score !== null;

        const hasAccuracy = result.accuracy_score !== undefined && result.accuracy_score !== null;
        const hasCompliance = result.compliance_score !== undefined && result.compliance_score !== null;

        if (hasSemantic || hasFormat || hasAccuracy || hasCompliance) {
            const rows = [];
            if (hasQuality) {
                const qColor = result.quality_score >= 7 ? '#2ecc71' : result.quality_score >= 4 ? '#f39c12' : '#e74c3c';
                rows.push(`<div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <span>Quality Score (overall)</span>
                    <span style="font-weight: 600; color: ${qColor};">${Number(result.quality_score).toFixed(1)}/10</span>
                </div>`);
            }
            if (hasAccuracy) {
                const aColor = result.accuracy_score >= 7 ? '#2ecc71' : result.accuracy_score >= 4 ? '#f39c12' : '#e74c3c';
                rows.push(`<div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <span><i class="fas fa-bullseye" style="color: ${aColor}; width: 18px;"></i> Accuracy <span style="color: var(--muted); font-size: 0.85em;">(content correctness, deterministic)</span></span>
                    <span style="font-weight: 600; color: ${aColor};">${Number(result.accuracy_score).toFixed(1)}/10</span>
                </div>`);
            }
            if (hasCompliance) {
                const cColor = result.compliance_score >= 7 ? '#2ecc71' : result.compliance_score >= 4 ? '#f39c12' : '#e74c3c';
                rows.push(`<div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <span><i class="fas fa-clipboard-check" style="color: ${cColor}; width: 18px;"></i> Compliance <span style="color: var(--muted); font-size: 0.85em;">(conciseness, format, instruction-following)</span></span>
                    <span style="font-weight: 600; color: ${cColor};">${Number(result.compliance_score).toFixed(1)}/10</span>
                </div>`);
            }
            if (hasSemantic) {
                const sColor = result.semantic_score >= 7 ? '#2ecc71' : result.semantic_score >= 4 ? '#f39c12' : '#e74c3c';
                rows.push(`<div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <span>Semantic Score <span style="color: var(--muted); font-size: 0.85em;">(correctness ignoring format)</span></span>
                    <span style="font-weight: 600; color: ${sColor};">${Number(result.semantic_score).toFixed(1)}/10</span>
                </div>`);
            }
            if (hasFormat) {
                const fCompliant = result.format_compliant;
                const fIcon = fCompliant === true ? '<i class="fas fa-check-circle" style="color: #2ecc71;"></i>' :
                              fCompliant === false ? '<i class="fas fa-times-circle" style="color: #e74c3c;"></i>' : '';
                const fColor = result.format_score >= 7 ? '#2ecc71' : result.format_score >= 4 ? '#f39c12' : '#e74c3c';
                rows.push(`<div style="display: flex; justify-content: space-between; padding: 4px 0;">
                    <span>${fIcon} Format Compliance <span style="color: var(--muted); font-size: 0.85em;">(output format match)</span></span>
                    <span style="font-weight: 600; color: ${fColor};">${Number(result.format_score).toFixed(1)}/10</span>
                </div>`);
            }
            scoringBreakdownEl.innerHTML = rows.join('');
            scoringBreakdownEl.style.borderLeftColor = 'var(--accent-2, #9b59b6)';
            scoringBreakdownEl.style.background = 'rgba(0,0,0,0.1)';
        } else {
            scoringBreakdownEl.innerHTML = '<span style="color: var(--muted);">Dual scoring data not available for this result.</span>';
            scoringBreakdownEl.style.borderLeftColor = 'var(--muted)';
            scoringBreakdownEl.style.background = 'rgba(0,0,0,0.05)';
        }
    }

    // Complexity Analysis - element ID: detailComplexity
    // This section shows the complexity vs judge capability analysis
    let complexityEl = document.getElementById('detailComplexity');
    
    // Create section if it doesn't exist
    if (!complexityEl) {
        const parent = explanationEl ? explanationEl.parentElement : document.querySelector('.modal-body');
        if (parent) {
            const container = document.createElement('div');
            container.className = 'detail-section';
            container.style.marginTop = '20px';
            container.innerHTML = `
                <h4>Complexity Analysis</h4>
                <div id="detailComplexity" class="explanation-box" style="border-left-color: var(--accent);"></div>
            `;
            // Insert after explanation if possible, otherwise append
            if (explanationEl && explanationEl.parentElement) {
                explanationEl.parentElement.after(container);
            } else {
                parent.appendChild(container);
            }
            complexityEl = document.getElementById('detailComplexity');
        }
    }

    if (complexityEl) {
        if (result.prompt_complexity) {
            const complexity = result.prompt_complexity;
            const confidence = result.judge_confidence !== undefined ? result.judge_confidence : 1.0;
            const needsReview = result.needs_review || false;
            
            // Determine status color
            let color = '#2ecc71'; // Green (Good)
            let status = 'Reliable Evaluation';
            
            if (needsReview) {
                color = '#e74c3c'; // Red (Review Needed)
                status = 'Review Needed';
            } else if (confidence < 0.8) {
                color = '#f39c12'; // Orange (Caution)
                status = 'Low Confidence';
            } else if (complexity > 7) {
                color = '#3498db'; // Blue (High Complexity)
                status = 'High Complexity';
            }

            const barWidth = Math.min(100, Math.max(0, complexity * 10));
            
            complexityEl.innerHTML = `
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <div>
                        <strong>Complexity Score:</strong> ${complexity.toFixed(1)}/10
                        <div style="font-size: 0.8em; color: var(--muted); margin-top: 2px;">
                            Based on prompt length, instructions, and constraints
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <span class="badge" style="background: ${color}; color: white;">${status}</span>
                        <div style="font-size: 0.8em; color: var(--muted); margin-top: 4px;">
                            Judge Confidence: ${(confidence * 100).toFixed(0)}%
                        </div>
                    </div>
                </div>
                
                <div class="progress-bar" style="height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-bottom: 12px;">
                    <div style="width: ${barWidth}%; height: 100%; background: linear-gradient(90deg, #2ecc71 0%, ${complexity > 5 ? '#f39c12' : '#2ecc71'} 50%, ${complexity > 8 ? '#e74c3c' : '#f39c12'} 100%);"></div>
                </div>

                ${result.review_reason ? `
                <div style="background: rgba(231, 76, 60, 0.1); border: 1px solid rgba(231, 76, 60, 0.3); border-radius: 4px; padding: 8px; margin-top: 10px;">
                    <i class="fas fa-exclamation-triangle" style="color: #e74c3c; margin-right: 6px;"></i>
                    <strong>Warning:</strong> ${escapeHtml(result.review_reason)}
                </div>
                ` : ''}
            `;
            complexityEl.style.borderLeftColor = color;
            complexityEl.style.background = result.needs_review ? 'rgba(231, 76, 60, 0.05)' : 'rgba(0,0,0,0.1)';
        } else {
            complexityEl.innerHTML = '<span style="color: var(--muted);">Complexity analysis not available for this test result.</span>';
            complexityEl.style.borderLeftColor = 'var(--muted)';
            complexityEl.style.background = 'rgba(0,0,0,0.05)';
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
