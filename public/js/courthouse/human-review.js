/**
 * Courthouse Human Review Module
 * Review queue for benchmark results flagged by judge confidence system.
 * Allows humans to override/confirm judge scores.
 */

const HumanReview = (() => {
    const API = '/api/benchmark';
    let currentResults = [];
    let expandedId = null;
    let filters = { model: '', batch_id: '', max_confidence: 0.7 };

    function init() {
        setupListeners();
        loadReviewQueue();
    }

    function setupListeners() {
        const refreshBtn = document.getElementById('reviewRefreshBtn');
        const filterModel = document.getElementById('reviewFilterModel');
        const filterConfidence = document.getElementById('reviewFilterConfidence');
        const filterConfidenceVal = document.getElementById('reviewFilterConfidenceVal');

        if (refreshBtn) refreshBtn.addEventListener('click', loadReviewQueue);
        if (filterModel) filterModel.addEventListener('change', () => {
            filters.model = filterModel.value;
            loadReviewQueue();
        });
        if (filterConfidence) {
            filterConfidence.addEventListener('input', () => {
                filters.max_confidence = parseFloat(filterConfidence.value);
                if (filterConfidenceVal) filterConfidenceVal.textContent = filters.max_confidence.toFixed(2);
            });
            filterConfidence.addEventListener('change', loadReviewQueue);
        }
    }

    async function loadReviewQueue() {
        const container = document.getElementById('reviewQueueContainer');
        if (!container) return;

        container.innerHTML = renderLoadingState();

        try {
            const params = new URLSearchParams({ limit: '50' });
            if (filters.model) params.set('model', filters.model);
            if (filters.batch_id) params.set('batch_id', filters.batch_id);
            if (filters.max_confidence) params.set('max_confidence', filters.max_confidence);

            const res = await fetch(`${API}/results/needs-review?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            const { data } = await res.json();

            currentResults = data.results || [];
            const stats = data.stats || {};

            renderStats(stats);
            renderQueue(currentResults);
            populateModelFilter(currentResults);
        } catch (err) {
            console.error('Failed to load review queue:', err);
            container.innerHTML = renderErrorState(err.message);
        }
    }

    function renderStats(stats) {
        const el = (id) => document.getElementById(id);
        const pending = (stats.total || 0) - (stats.reviewed || 0);

        if (el('reviewPending')) {
            el('reviewPending').textContent = pending;
            el('reviewPending').style.color = pending > 10 ? '#e74c3c' : pending > 0 ? '#f1c40f' : '#2ecc71';
        }
        if (el('reviewCompleted')) {
            el('reviewCompleted').textContent = stats.reviewed || 0;
            el('reviewCompleted').style.color = '#2ecc71';
        }
        if (el('reviewTotal')) el('reviewTotal').textContent = stats.total || 0;
        if (el('reviewAvgConfidence')) {
            const conf = stats.avg_confidence;
            el('reviewAvgConfidence').textContent = conf != null ? conf.toFixed(2) : '-';
            if (conf != null) {
                el('reviewAvgConfidence').style.color = conf >= 0.7 ? '#2ecc71' : conf >= 0.5 ? '#f1c40f' : '#e74c3c';
            }
        }
    }

    function populateModelFilter(results) {
        const select = document.getElementById('reviewFilterModel');
        if (!select) return;
        const models = [...new Set(results.map(r => r.model).filter(Boolean))].sort();
        const current = select.value;
        select.innerHTML = '<option value="">All Models</option>' +
            models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
        if (current) select.value = current;
    }

    function renderQueue(results) {
        const container = document.getElementById('reviewQueueContainer');
        if (!container) return;

        if (!results.length) {
            container.innerHTML = `
                <div style="text-align: center; padding: 60px 20px; color: var(--muted);">
                    <i class="fas fa-check-circle" style="font-size: 3em; margin-bottom: 16px; color: #2ecc71; opacity: 0.6;"></i>
                    <p style="font-size: 1.1em; margin: 0;">No results need review</p>
                    <p style="font-size: 0.9em; margin-top: 8px;">All flagged results have been reviewed, or none were flagged.</p>
                </div>`;
            return;
        }

        container.innerHTML = results.map((r, idx) => renderCard(r, idx)).join('');
        attachCardListeners();
    }

    function renderCard(result, idx) {
        const isReviewed = result.human_score != null;
        const isExpanded = expandedId === result._id;
        const confidence = result.judge_confidence;
        const confColor = confidence >= 0.7 ? '#2ecc71' : confidence >= 0.5 ? '#f1c40f' : '#e74c3c';
        const judgeScore = result.quality_score != null ? result.quality_score.toFixed(1) : '-';
        const reviewStatus = isReviewed
            ? `<span style="color: #2ecc71;"><i class="fas fa-check-circle"></i> Reviewed: ${result.human_score.toFixed(1)}</span>`
            : `<span style="color: #f1c40f;"><i class="fas fa-clock"></i> Pending</span>`;

        const deviation = isReviewed && result.quality_score != null
            ? Math.abs(result.human_score - result.quality_score).toFixed(1)
            : null;

        const deviationBadge = deviation != null
            ? `<span style="padding: 2px 8px; border-radius: 4px; font-size: 0.8em; background: ${parseFloat(deviation) > 2 ? 'rgba(231,76,60,0.2)' : 'rgba(46,204,113,0.2)'}; color: ${parseFloat(deviation) > 2 ? '#e74c3c' : '#2ecc71'};">&Delta; ${deviation}</span>`
            : '';

        return `
        <div class="review-card ${isReviewed ? 'reviewed' : 'pending'}" data-id="${result._id}" data-idx="${idx}">
            <div class="review-card-header" data-action="toggle" data-id="${result._id}">
                <div class="review-card-left">
                    <div class="review-card-title">
                        <span style="font-weight: 600; color: var(--text);">${esc(result.prompt_name || 'Unknown')}</span>
                        <span class="review-level-badge">L${result.prompt_level || '?'}</span>
                        <span style="color: var(--muted); font-size: 0.85em;">${esc(result.prompt_category || '')}</span>
                    </div>
                    <div style="display: flex; gap: 16px; align-items: center; margin-top: 4px; font-size: 0.85em;">
                        <span style="color: var(--muted);">${esc(result.model || 'Unknown model')}</span>
                        <span style="color: ${confColor};" title="Judge confidence">
                            <i class="fas fa-brain"></i> ${confidence != null ? confidence.toFixed(2) : '-'}
                        </span>
                        <span style="color: var(--accent);" title="Judge score">
                            <i class="fas fa-gavel"></i> ${judgeScore}
                        </span>
                        ${deviationBadge}
                    </div>
                </div>
                <div class="review-card-right">
                    ${reviewStatus}
                    <i class="fas fa-chevron-${isExpanded ? 'up' : 'down'}" style="color: var(--muted); margin-left: 8px;"></i>
                </div>
            </div>
            ${isExpanded ? renderExpandedContent(result) : ''}
        </div>`;
    }

    function renderExpandedContent(result) {
        const isReviewed = result.human_score != null;
        const reasons = result.review_reason || 'Low judge confidence';
        const sliderDefault = isReviewed ? result.human_score : (result.quality_score != null ? result.quality_score : 5);

        return `
        <div class="review-card-body">
            <div class="review-issues">
                <div style="font-weight: 600; font-size: 0.85em; color: var(--muted); margin-bottom: 6px;">
                    <i class="fas fa-exclamation-triangle" style="color: #f1c40f;"></i> Flagged Because:
                </div>
                <div style="font-size: 0.9em; color: var(--text); padding: 8px 12px; background: rgba(241,196,15,0.08); border-radius: 6px; border-left: 3px solid #f1c40f;">
                    ${esc(reasons)}
                </div>
            </div>

            <div class="review-detail-grid">
                <div class="review-detail-item">
                    <span class="review-detail-label">Batch</span>
                    <span class="review-detail-value">${esc(result.batch_id || '-')}</span>
                </div>
                <div class="review-detail-item">
                    <span class="review-detail-label">Judged</span>
                    <span class="review-detail-value">${result.timestamp ? new Date(result.timestamp).toLocaleDateString() : '-'}</span>
                </div>
                ${isReviewed ? `
                <div class="review-detail-item">
                    <span class="review-detail-label">Reviewed</span>
                    <span class="review-detail-value">${result.human_reviewed_at ? new Date(result.human_reviewed_at).toLocaleDateString() : '-'}</span>
                </div>` : ''}
            </div>

            <div class="review-scoring-section">
                <div class="review-comparison">
                    <div class="review-score-box judge">
                        <div class="review-score-label"><i class="fas fa-gavel"></i> Judge Score</div>
                        <div class="review-score-value">${result.quality_score != null ? result.quality_score.toFixed(1) : '-'}</div>
                    </div>
                    <div class="review-score-arrow">
                        <i class="fas fa-arrows-alt-h"></i>
                    </div>
                    <div class="review-score-box human ${isReviewed ? 'filled' : ''}">
                        <div class="review-score-label"><i class="fas fa-user"></i> Human Score</div>
                        <div class="review-score-value" id="humanScoreDisplay_${result._id}">
                            ${isReviewed ? result.human_score.toFixed(1) : '?'}
                        </div>
                    </div>
                </div>

                <div class="review-input-area">
                    <label style="font-size: 0.85em; color: var(--muted); display: block; margin-bottom: 6px;">
                        Your score (0-10):
                    </label>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="range" min="0" max="10" step="0.5"
                               value="${sliderDefault}"
                               class="review-slider" id="reviewSlider_${result._id}"
                               data-id="${result._id}">
                        <span class="review-slider-value" id="reviewSliderVal_${result._id}">
                            ${sliderDefault.toFixed(1)}
                        </span>
                    </div>
                    <div class="review-quick-scores">
                        ${[0, 2, 4, 5, 6, 7, 8, 9, 10].map(s =>
                            `<button class="review-quick-btn" data-score="${s}" data-id="${result._id}">${s}</button>`
                        ).join('')}
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <button class="review-submit-btn" data-id="${result._id}" data-reviewed="${isReviewed}">
                            <i class="fas fa-check"></i> ${isReviewed ? 'Update Review' : 'Submit Review'}
                        </button>
                        <button class="review-rejudge-btn btn-secondary btn-sm" data-id="${result._id}">
                            <i class="fas fa-redo"></i> Re-judge
                        </button>
                        <button class="review-inspect-btn btn-secondary btn-sm" data-id="${result._id}">
                            <i class="fas fa-search"></i> Full Details
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
    }

    function attachCardListeners() {
        document.querySelectorAll('[data-action="toggle"]').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.dataset.id;
                expandedId = expandedId === id ? null : id;
                renderQueue(currentResults);
            });
        });

        document.querySelectorAll('.review-slider').forEach(slider => {
            slider.addEventListener('input', () => {
                const val = document.getElementById(`reviewSliderVal_${slider.dataset.id}`);
                const display = document.getElementById(`humanScoreDisplay_${slider.dataset.id}`);
                if (val) val.textContent = parseFloat(slider.value).toFixed(1);
                if (display) display.textContent = parseFloat(slider.value).toFixed(1);
            });
        });

        document.querySelectorAll('.review-quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const slider = document.getElementById(`reviewSlider_${btn.dataset.id}`);
                const val = document.getElementById(`reviewSliderVal_${btn.dataset.id}`);
                const display = document.getElementById(`humanScoreDisplay_${btn.dataset.id}`);
                if (slider) slider.value = btn.dataset.score;
                if (val) val.textContent = parseFloat(btn.dataset.score).toFixed(1);
                if (display) display.textContent = parseFloat(btn.dataset.score).toFixed(1);
            });
        });

        document.querySelectorAll('.review-submit-btn').forEach(btn => {
            btn.addEventListener('click', () => submitReview(btn.dataset.id));
        });
        document.querySelectorAll('.review-rejudge-btn').forEach(btn => {
            btn.addEventListener('click', () => rejudgeResult(btn.dataset.id));
        });
        document.querySelectorAll('.review-inspect-btn').forEach(btn => {
            btn.addEventListener('click', () => inspectResult(btn.dataset.id));
        });
    }

    async function submitReview(resultId) {
        const slider = document.getElementById(`reviewSlider_${resultId}`);
        if (!slider) return;

        const score = parseFloat(slider.value);
        const btn = document.querySelector(`.review-submit-btn[data-id="${resultId}"]`);
        const wasReviewed = btn?.dataset.reviewed === 'true';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

        try {
            const res = await fetch(`${API}/results/${resultId}/human-review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ human_score: score, reviewer: 'courthouse_user' })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            showToast(`Review saved: ${score.toFixed(1)}`, 'success');
            const idx = currentResults.findIndex(r => r._id === resultId);
            if (idx >= 0) {
                currentResults[idx].human_score = score;
                currentResults[idx].human_reviewed_at = new Date().toISOString();
            }
            renderQueue(currentResults);
            loadReviewQueue();
        } catch (err) {
            console.error('Submit review failed:', err);
            showToast('Failed to save review: ' + err.message, 'error');
            if (btn) {
                btn.disabled = false;
                const label = wasReviewed ? 'Update Review' : 'Submit Review';
                btn.innerHTML = `<i class="fas fa-check"></i> ${label}`;
            }
        }
    }

    async function rejudgeResult(resultId) {
        const btn = document.querySelector(`.review-rejudge-btn[data-id="${resultId}"]`);
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Re-judging...'; }

        try {
            const res = await fetch(`${API}/results/${resultId}/rejudge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { data } = await res.json();

            const newScore = data?.quality_score;
            showToast(`Re-judged: new score ${newScore != null ? newScore.toFixed(1) : '?'}`, 'success');
            loadReviewQueue();
        } catch (err) {
            console.error('Re-judge failed:', err);
            showToast('Re-judge failed: ' + err.message, 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-redo"></i> Re-judge'; }
        }
    }

    async function inspectResult(resultId) {
        try {
            const res = await fetch(`${API}/results/${resultId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { data } = await res.json();
            showInspectModal(data);
        } catch (err) {
            showToast('Failed to load details: ' + err.message, 'error');
        }
    }

    function showInspectModal(r) {
        let overlay = document.getElementById('reviewInspectOverlay');
        if (overlay) overlay.remove();

        const latency = r.latency != null ? `${(r.latency / 1000).toFixed(2)}s` : null;
        const tokens = r.tokens?.total || r.tokens?.completion || null;
        const errorInfo = r.error ? `${r.error_type || 'error'}: ${r.error}` : null;

        overlay = document.createElement('div');
        overlay.id = 'reviewInspectOverlay';
        overlay.className = 'review-inspect-overlay';
        overlay.innerHTML = `
            <div class="review-inspect-modal">
                <div class="review-inspect-header">
                    <h3><i class="fas fa-search"></i> Result Inspector</h3>
                    <button class="review-inspect-close">&times;</button>
                </div>
                <div class="review-inspect-body">
                    <!-- Metadata bar -->
                    <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; font-size: 0.85em; color: var(--muted);">
                        <span><strong>Model:</strong> ${esc(r.model || '-')}</span>
                        <span><strong>Level:</strong> ${r.prompt_level || '-'}</span>
                        <span><strong>Category:</strong> ${esc(r.prompt_category || '-')}</span>
                        ${latency ? `<span><strong>Latency:</strong> ${latency}</span>` : ''}
                        ${tokens ? `<span><strong>Tokens:</strong> ${tokens}</span>` : ''}
                        ${r.judge_confidence != null ? `<span><strong>Confidence:</strong> ${r.judge_confidence.toFixed(2)}</span>` : ''}
                        ${r.prompt_complexity != null ? `<span><strong>Complexity:</strong> ${r.prompt_complexity}</span>` : ''}
                    </div>

                    ${errorInfo ? `
                    <div class="review-inspect-section">
                        <h4><i class="fas fa-exclamation-circle" style="color: #e74c3c;"></i> Execution Error</h4>
                        <pre class="review-inspect-pre" style="border-color: rgba(231,76,60,0.3);">${esc(errorInfo)}</pre>
                    </div>` : ''}

                    <div class="review-inspect-section">
                        <h4><i class="fas fa-question-circle"></i> Prompt</h4>
                        <pre class="review-inspect-pre">${esc(r.prompt || 'N/A')}</pre>
                    </div>

                    ${r.expected_answer ? `
                    <div class="review-inspect-section">
                        <h4><i class="fas fa-bullseye"></i> Expected Answer</h4>
                        <pre class="review-inspect-pre">${esc(r.expected_answer)}</pre>
                    </div>` : ''}

                    <div class="review-inspect-section">
                        <h4><i class="fas fa-comment"></i> Model Response</h4>
                        <pre class="review-inspect-pre">${esc(r.response || 'N/A')}</pre>
                    </div>

                    ${r.thinking ? `
                    <div class="review-inspect-section">
                        <h4><i class="fas fa-brain"></i> Model Thinking</h4>
                        <pre class="review-inspect-pre">${esc(r.thinking)}</pre>
                    </div>` : ''}

                    ${r.quality_explanation ? `
                    <div class="review-inspect-section">
                        <h4><i class="fas fa-gavel"></i> Judge Explanation</h4>
                        <pre class="review-inspect-pre">${esc(r.quality_explanation)}</pre>
                    </div>` : ''}

                    <div class="review-inspect-section">
                        <h4><i class="fas fa-chart-bar"></i> Score Breakdown</h4>
                        ${renderBreakdown(r.quality_breakdown)}
                    </div>

                    ${r.truncation ? `
                    <div class="review-inspect-section">
                        <h4><i class="fas fa-cut"></i> Truncation Info</h4>
                        <div style="font-size: 0.9em; color: var(--muted); display: flex; gap: 16px;">
                            ${r.truncation.response_truncated ? '<span style="color: #e74c3c;">Response truncated</span>' : ''}
                            ${r.truncation.judge_input_truncated ? '<span style="color: #f1c40f;">Judge input truncated</span>' : ''}
                            ${r.truncation.judge_output_truncated ? '<span style="color: #e74c3c;">Judge output truncated</span>' : ''}
                            ${!r.truncation.response_truncated && !r.truncation.judge_input_truncated && !r.truncation.judge_output_truncated ? '<span style="color: #2ecc71;">No truncation</span>' : ''}
                        </div>
                    </div>` : ''}
                </div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.querySelector('.review-inspect-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    function renderBreakdown(breakdown) {
        if (!breakdown || typeof breakdown !== 'object') {
            return '<div style="color: var(--muted);">No breakdown available</div>';
        }
        const entries = Object.entries(breakdown).filter(([, v]) => v != null && typeof v === 'number');
        if (!entries.length) return '<div style="color: var(--muted);">No breakdown available</div>';

        return `<div class="review-breakdown-grid">${entries.map(([key, val]) => {
            const pct = Math.max(0, Math.min(100, val * 10));
            const color = val >= 7 ? '#2ecc71' : val >= 5 ? '#f1c40f' : '#e74c3c';
            return `
                <div class="review-breakdown-item">
                    <div class="review-breakdown-label">${esc(key.replace(/_/g, ' '))}</div>
                    <div class="review-breakdown-bar-bg">
                        <div class="review-breakdown-bar" style="width: ${pct}%; background: ${color};"></div>
                    </div>
                    <div class="review-breakdown-val" style="color: ${color};">${val.toFixed(1)}</div>
                </div>`;
        }).join('')}</div>`;
    }

    function renderLoadingState() {
        return `<div style="text-align: center; padding: 40px; color: var(--muted);">
            <i class="fas fa-spinner fa-spin" style="font-size: 2em; margin-bottom: 12px;"></i>
            <p>Loading review queue...</p></div>`;
    }

    function renderErrorState(msg) {
        return `<div style="text-align: center; padding: 40px; color: #e74c3c;">
            <i class="fas fa-exclamation-circle" style="font-size: 2em; margin-bottom: 12px;"></i>
            <p>Failed to load: ${esc(msg)}</p></div>`;
    }

    function showToast(msg, type) {
        if (window.CourthouseAnalytics?.showToast) {
            window.CourthouseAnalytics.showToast(msg, type);
        } else {
            console.log(`[${type}] ${msg}`);
        }
    }

    function esc(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    return { init, loadReviewQueue };
})();

window.HumanReview = HumanReview;
