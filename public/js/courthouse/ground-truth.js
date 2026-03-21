/**
 * Courthouse Ground Truth Module
 * Manage expert-curated reference scores for judge validation.
 * Provides CRUD, accuracy summaries, and problematic entry detection.
 */

const GroundTruth = (() => {
    const API = '/api/benchmark/judge/ground-truth';
    let entries = [];
    let summary = null;

    const CATEGORIES = [
        'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
    ];

    function init() {
        setupListeners();
        loadAll();
    }

    function getActiveCategory() {
        const el = document.getElementById('gtFilterCategory');
        return el ? el.value : '';
    }

    function setupListeners() {
        const refreshBtn = document.getElementById('gtRefreshBtn');
        const addBtn = document.getElementById('gtAddBtn');
        const runEvalBtn = document.getElementById('gtRunEvalBtn');
        const filterCategory = document.getElementById('gtFilterCategory');

        if (refreshBtn) refreshBtn.addEventListener('click', loadAll);
        if (addBtn) addBtn.addEventListener('click', showAddModal);
        if (runEvalBtn) runEvalBtn.addEventListener('click', runGroundTruthEval);
        if (filterCategory) filterCategory.addEventListener('change', () => loadEntries(filterCategory.value));
    }

    async function loadAll() {
        await Promise.all([loadEntries(getActiveCategory()), loadSummary(), loadProblematic()]);
    }

    async function loadEntries(category) {
        const container = document.getElementById('gtEntriesContainer');
        if (!container) return;
        container.innerHTML = loadingHtml('Loading ground truth entries...');

        try {
            const params = new URLSearchParams({ limit: '100' });
            if (category) params.set('category', category);
            const res = await fetch(`${API}?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { data } = await res.json();
            entries = data.entries || [];
            renderEntries(entries, data.total);
        } catch (err) {
            container.innerHTML = errorHtml(err.message);
        }
    }

    async function loadSummary() {
        try {
            const res = await fetch(`${API}/summary`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { data } = await res.json();
            summary = data;
            renderSummary(data);
        } catch (err) {
            console.error('Failed to load GT summary:', err);
        }
    }

    async function loadProblematic() {
        const container = document.getElementById('gtProblematicContainer');
        if (!container) return;

        try {
            const res = await fetch(`${API}/problematic?threshold=2.0&limit=10`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { data } = await res.json();
            renderProblematic(data.entries || []);
        } catch (err) {
            container.innerHTML = `<div style="color: var(--muted); font-size: 0.9em;">Could not load problematic entries</div>`;
        }
    }

    function renderSummary(data) {
        const el = (id) => document.getElementById(id);
        const overall = data?.overall || {};
        const cats = Array.isArray(data?.by_category) ? data.by_category : [];

        if (el('gtTotalEntries')) el('gtTotalEntries').textContent = overall.total_entries || 0;
        if (el('gtCategoriesCovered')) el('gtCategoriesCovered').textContent = cats.length;
        if (el('gtAvgDeviation')) {
            const dev = overall.avg_deviation;
            el('gtAvgDeviation').textContent = dev != null ? dev.toFixed(2) : '-';
            if (dev != null) el('gtAvgDeviation').style.color = dev < 1 ? '#2ecc71' : dev < 2 ? '#f1c40f' : '#e74c3c';
        }
        if (el('gtValidatedEntries')) {
            el('gtValidatedEntries').textContent = overall.total_entries || 0;
        }

        const catContainer = document.getElementById('gtCategoryBreakdown');
        if (catContainer) {
            if (cats.length === 0) {
                catContainer.innerHTML = '<div style="color: var(--muted);">No category data yet. Run an evaluation first.</div>';
                return;
            }
            catContainer.innerHTML = cats.map(info => {
                const cat = info._id || 'unknown';
                const dev = info.avg_deviation;
                const color = dev != null ? (dev < 1 ? '#2ecc71' : dev < 2 ? '#f1c40f' : '#e74c3c') : 'var(--muted)';
                return `
                    <div class="gt-cat-row">
                        <span class="gt-cat-name">${esc(cat)}</span>
                        <span class="gt-cat-count">${info.count} entries</span>
                        <span class="gt-cat-dev" style="color: ${color};">
                            ${dev != null ? `&Delta; ${dev.toFixed(2)}` : 'Not validated'}
                        </span>
                    </div>`;
            }).join('');
        }
    }

    function renderEntries(list, total) {
        const container = document.getElementById('gtEntriesContainer');
        if (!container) return;

        if (!list.length) {
            container.innerHTML = `
                <div style="text-align: center; padding: 50px; color: var(--muted);">
                    <i class="fas fa-database" style="font-size: 3em; margin-bottom: 16px; opacity: 0.5;"></i>
                    <p>No ground truth entries yet</p>
                    <p style="font-size: 0.9em;">Click "Add Entry" to create expert-curated reference scores</p>
                </div>`;
            return;
        }

        container.innerHTML = `
            <div style="color: var(--muted); font-size: 0.85em; margin-bottom: 12px;">
                Showing ${list.length} of ${total || list.length} entries
            </div>
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Category</th>
                        <th>Difficulty</th>
                        <th>Expert Score</th>
                        <th>Avg Deviation</th>
                        <th>Validations</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${list.map(renderEntryRow).join('')}</tbody>
            </table>`;

        container.querySelectorAll('.gt-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteEntry(btn.dataset.id, btn.dataset.name));
        });
        container.querySelectorAll('.gt-detail-btn').forEach(btn => {
            btn.addEventListener('click', () => showEntryDetail(btn.dataset.id));
        });
        container.querySelectorAll('.gt-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleActive(btn.dataset.id, btn.dataset.active === 'true'));
        });
    }

    function renderEntryRow(entry) {
        const stats = entry.validation_stats || {};
        const dev = stats.avg_deviation;
        const devColor = dev != null ? (dev < 1 ? '#2ecc71' : dev < 2 ? '#f1c40f' : '#e74c3c') : 'var(--muted)';
        const diffColor = entry.difficulty >= 8 ? '#e74c3c' : entry.difficulty >= 5 ? '#f1c40f' : '#2ecc71';
        const isActive = entry.active !== false;

        return `
            <tr style="${!isActive ? 'opacity: 0.5;' : ''}">
                <td style="padding: 10px 8px;">
                    <div style="font-weight: 600; color: var(--text);">${esc(entry.name)}</div>
                    ${entry.tags?.length ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">${entry.tags.map(t => esc(t)).join(', ')}</div>` : ''}
                </td>
                <td style="padding: 10px 8px;">
                    <span class="gt-category-badge">${esc(entry.category)}</span>
                </td>
                <td style="padding: 10px 8px; text-align: center;">
                    <span style="color: ${diffColor}; font-weight: 600;">${entry.difficulty || '-'}</span>
                </td>
                <td style="padding: 10px 8px; text-align: center;">
                    <span style="color: var(--accent); font-weight: 700; font-size: 1.1em;">
                        ${entry.expert_scores?.overall != null ? entry.expert_scores.overall.toFixed(1) : '-'}
                    </span>
                </td>
                <td style="padding: 10px 8px; text-align: center;">
                    <span style="color: ${devColor}; font-weight: 600;">
                        ${dev != null ? dev.toFixed(2) : '-'}
                    </span>
                </td>
                <td style="padding: 10px 8px; text-align: center;">
                    ${stats.total_runs || 0}
                </td>
                <td style="padding: 10px 8px; text-align: center;">
                    <span style="color: ${isActive ? '#2ecc71' : '#e74c3c'}; font-size: 0.85em;">
                        ${isActive ? 'Active' : 'Inactive'}
                    </span>
                </td>
                <td style="padding: 10px 8px;">
                    <div style="display: flex; gap: 6px;">
                        <button class="gt-detail-btn btn-secondary btn-sm" data-id="${entry._id}" title="View details">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="gt-toggle-btn btn-secondary btn-sm" data-id="${entry._id}" data-active="${isActive}" title="${isActive ? 'Deactivate' : 'Activate'}">
                            <i class="fas fa-${isActive ? 'pause' : 'play'}"></i>
                        </button>
                        <button class="gt-delete-btn btn-secondary btn-sm" data-id="${entry._id}" data-name="${esc(entry.name)}" title="Delete" style="color: #e74c3c;">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
    }

    function renderProblematic(list) {
        const container = document.getElementById('gtProblematicContainer');
        if (!container) return;

        if (!list.length) {
            container.innerHTML = `<div style="color: var(--muted); font-size: 0.9em; padding: 12px;">
                <i class="fas fa-check-circle" style="color: #2ecc71;"></i> No high-deviation entries found
            </div>`;
            return;
        }

        container.innerHTML = `
            <div style="font-size: 0.85em; color: var(--muted); margin-bottom: 8px;">
                Entries where judge deviates significantly (&Delta; >= 2.0)
            </div>
            ${list.map(e => {
                const dev = e.validation_stats?.avg_deviation;
                return `
                <div class="gt-problem-item">
                    <div class="gt-problem-name">${esc(e.name)}</div>
                    <div class="gt-problem-meta">
                        <span>${esc(e.category)}</span>
                        <span>Expert: ${e.expert_scores?.overall != null ? e.expert_scores.overall.toFixed(1) : '?'}</span>
                        <span style="color: #e74c3c; font-weight: 600;">&Delta; ${dev?.toFixed(2) || '?'}</span>
                    </div>
                </div>`;
            }).join('')}`;
    }

    function showAddModal() {
        let overlay = document.getElementById('gtAddOverlay');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'gtAddOverlay';
        overlay.className = 'review-inspect-overlay';
        overlay.innerHTML = `
            <div class="review-inspect-modal" style="max-width: 700px;">
                <div class="review-inspect-header">
                    <h3><i class="fas fa-plus-circle"></i> Add Ground Truth Entry</h3>
                    <button class="review-inspect-close">&times;</button>
                </div>
                <div class="review-inspect-body">
                    <form id="gtAddForm" class="gt-add-form">
                        <div class="gt-form-row">
                            <label>Name <span style="color: #e74c3c;">*</span></label>
                            <input type="text" name="name" required placeholder="unique-identifier-for-this-entry">
                        </div>
                        <div class="gt-form-row">
                            <label>Category <span style="color: #e74c3c;">*</span></label>
                            <select name="category" required>
                                <option value="">Select...</option>
                                ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
                            </select>
                        </div>
                        <div class="gt-form-row">
                            <label>Prompt <span style="color: #e74c3c;">*</span></label>
                            <textarea name="prompt" rows="3" required placeholder="The prompt/task given to the model"></textarea>
                        </div>
                        <div class="gt-form-row">
                            <label>Response <span style="color: #e74c3c;">*</span></label>
                            <textarea name="response" rows="4" required placeholder="The model response to evaluate"></textarea>
                        </div>
                        <div class="gt-form-row">
                            <label>Expected Answer (optional)</label>
                            <textarea name="expected_answer" rows="2" placeholder="If applicable"></textarea>
                        </div>
                        <div class="gt-form-grid">
                            <div class="gt-form-row">
                                <label>Expert Score (0-10) <span style="color: #e74c3c;">*</span></label>
                                <input type="number" name="expert_score" min="0" max="10" step="0.5" required>
                            </div>
                            <div class="gt-form-row">
                                <label>Difficulty (1-10)</label>
                                <input type="number" name="difficulty" min="1" max="10" value="5">
                            </div>
                        </div>
                        <div class="gt-form-row">
                            <label>Expert Rationale <span style="color: #e74c3c;">*</span></label>
                            <textarea name="expert_rationale" rows="3" required placeholder="Why this score? Explain the expert reasoning"></textarea>
                        </div>
                        <div class="gt-form-row">
                            <label>Tags (comma-separated)</label>
                            <input type="text" name="tags" placeholder="e.g. edge-case, tricky, baseline">
                        </div>
                        <div style="display: flex; gap: 8px; margin-top: 16px;">
                            <button type="submit" class="review-submit-btn">
                                <i class="fas fa-save"></i> Save Entry
                            </button>
                            <button type="button" class="btn-secondary btn-sm gt-cancel-btn">Cancel</button>
                        </div>
                    </form>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.querySelector('.review-inspect-close').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.gt-cancel-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        overlay.querySelector('#gtAddForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await createEntry(new FormData(e.target));
            overlay.remove();
        });
    }

    async function createEntry(formData) {
        const body = {
            name: formData.get('name'),
            prompt: formData.get('prompt'),
            response: formData.get('response'),
            category: formData.get('category'),
            expected_answer: formData.get('expected_answer') || null,
            expert_scores: { overall: parseFloat(formData.get('expert_score')) },
            expert_rationale: formData.get('expert_rationale'),
            difficulty: parseInt(formData.get('difficulty'), 10) || 5,
            tags: (formData.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean)
        };

        try {
            const res = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            showToast('Ground truth entry created', 'success');
            loadAll();
        } catch (err) {
            showToast('Failed to create: ' + err.message, 'error');
        }
    }

    async function deleteEntry(id, name) {
        if (!confirm(`Delete ground truth entry "${name}"?`)) return;
        try {
            const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            showToast('Entry deleted', 'success');
            loadAll();
        } catch (err) {
            showToast('Delete failed: ' + err.message, 'error');
        }
    }

    async function toggleActive(id, currentlyActive) {
        try {
            const res = await fetch(`${API}/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !currentlyActive })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            showToast(`Entry ${currentlyActive ? 'deactivated' : 'activated'}`, 'success');
            loadAll();
        } catch (err) {
            showToast('Toggle failed: ' + err.message, 'error');
        }
    }

    function showEntryDetail(id) {
        const entry = entries.find(e => e._id === id);
        if (!entry) return;

        let overlay = document.getElementById('gtDetailOverlay');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'gtDetailOverlay';
        overlay.className = 'review-inspect-overlay';

        const history = (entry.validation_history || []).slice(-10).reverse();

        overlay.innerHTML = `
            <div class="review-inspect-modal" style="max-width: 750px;">
                <div class="review-inspect-header">
                    <h3><i class="fas fa-database"></i> ${esc(entry.name)}</h3>
                    <button class="review-inspect-close">&times;</button>
                </div>
                <div class="review-inspect-body">
                    <div class="gt-detail-meta">
                        <span class="gt-category-badge">${esc(entry.category)}</span>
                        <span>Difficulty: ${entry.difficulty}</span>
                        <span>Expert Score: <strong style="color: var(--accent);">${entry.expert_scores?.overall != null ? entry.expert_scores.overall.toFixed(1) : '-'}</strong></span>
                        <span>${entry.active !== false ? '<span style="color:#2ecc71;">Active</span>' : '<span style="color:#e74c3c;">Inactive</span>'}</span>
                    </div>
                    <div class="review-inspect-section">
                        <h4>Expert Rationale</h4>
                        <pre class="review-inspect-pre">${esc(entry.expert_rationale)}</pre>
                    </div>
                    <div class="review-inspect-section">
                        <h4>Prompt</h4>
                        <pre class="review-inspect-pre">${esc(entry.prompt)}</pre>
                    </div>
                    <div class="review-inspect-section">
                        <h4>Response</h4>
                        <pre class="review-inspect-pre">${esc(entry.response)}</pre>
                    </div>
                    ${history.length ? `
                    <div class="review-inspect-section">
                        <h4><i class="fas fa-history"></i> Validation History (last ${history.length})</h4>
                        <table class="data-table" style="font-size: 0.9em;">
                            <thead><tr><th>Judge Model</th><th>Judge Score</th><th>Deviation</th><th>Date</th></tr></thead>
                            <tbody>${history.map(h => {
                                const devColor = h.deviation < 1 ? '#2ecc71' : h.deviation < 2 ? '#f1c40f' : '#e74c3c';
                                return `<tr>
                                    <td style="padding: 6px 8px;">${esc(h.judge_model)}</td>
                                    <td style="padding: 6px 8px; text-align: center;">${h.judge_score?.toFixed(1) ?? '-'}</td>
                                    <td style="padding: 6px 8px; text-align: center; color: ${devColor}; font-weight: 600;">${h.deviation?.toFixed(2) ?? '-'}</td>
                                    <td style="padding: 6px 8px; color: var(--muted);">${h.timestamp ? new Date(h.timestamp).toLocaleDateString() : '-'}</td>
                                </tr>`;
                            }).join('')}</tbody>
                        </table>
                    </div>` : ''}
                </div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.querySelector('.review-inspect-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    async function runGroundTruthEval() {
        const btn = document.getElementById('gtRunEvalBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Evaluating...'; }

        try {
            const category = getActiveCategory();
            const body = { limit: 50 };
            if (category) body.category = category;

            const res = await fetch('/api/benchmark/judge/validate/ground-truth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { data } = await res.json();

            showToast(`Evaluation complete: MAE ${data.summary?.mae?.toFixed(2) ?? '?'}, Correlation ${data.summary?.correlation?.toFixed(2) ?? '?'}`, 'success');
            showEvalResults(data);
            loadAll();
        } catch (err) {
            showToast('Evaluation failed: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-flask"></i> Run Evaluation'; }
        }
    }

    function showEvalResults(data) {
        const container = document.getElementById('gtEvalResults');
        if (!container) return;
        container.style.display = 'block';

        const s = data.summary || {};
        const grade = s.accuracy_grade || '-';
        const gradeColor = grade === 'A' ? '#2ecc71' : grade === 'B' ? '#f1c40f' : '#e74c3c';

        container.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 12px; color: var(--text);">
                <i class="fas fa-flask"></i> Latest Evaluation Results
            </div>
            <div class="stats-grid" style="margin-bottom: 12px;">
                <div class="stat-card">
                    <div class="stat-value" style="color: ${gradeColor};">${esc(grade)}</div>
                    <div class="stat-label">Accuracy Grade</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${s.mae != null ? s.mae.toFixed(2) : '-'}</div>
                    <div class="stat-label">MAE</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${s.rmse != null ? s.rmse.toFixed(2) : '-'}</div>
                    <div class="stat-label">RMSE</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${s.correlation != null ? s.correlation.toFixed(2) : '-'}</div>
                    <div class="stat-label">Correlation</div>
                </div>
            </div>
            ${s.bias_direction ? `<div style="font-size: 0.9em; color: var(--muted); padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                Bias direction: <strong style="color: var(--text);">${esc(s.bias_direction)}</strong>
                ${s.entries_evaluated ? ` | ${s.entries_evaluated} entries evaluated` : ''}
            </div>` : ''}`;
    }

    function loadingHtml(msg) {
        return `<div style="text-align: center; padding: 40px; color: var(--muted);">
            <i class="fas fa-spinner fa-spin" style="font-size: 2em; margin-bottom: 12px;"></i>
            <p>${msg}</p></div>`;
    }
    function errorHtml(msg) {
        return `<div style="text-align: center; padding: 40px; color: #e74c3c;">
            <i class="fas fa-exclamation-circle" style="font-size: 2em; margin-bottom: 12px;"></i>
            <p>Error: ${esc(msg)}</p></div>`;
    }
    function showToast(msg, type) {
        if (window.CourthouseAnalytics?.showToast) window.CourthouseAnalytics.showToast(msg, type);
    }
    function esc(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    return { init, loadAll };
})();

window.GroundTruth = GroundTruth;
