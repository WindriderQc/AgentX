// prompt-explorer.js — Prompt browser, detail view, category breakdown, preview selection

import * as state from './state.js';
import { escapeHtml } from './utils.js';
import { getDepthConfig, getSelectedLevels } from './batch-config.js';

// ─── Constants ─────────────────────────────────────────────────────

const SCORING_TYPE_COLORS = {
    coding:      '#7c9fff',
    reasoning:   '#a78bfa',
    math:        '#fbbf24',
    knowledge:   '#34d399',
    instruction: '#06b6d4',
    creative:    '#f87171',
    translation: '#f472b6'
};

const LEVEL_LABELS = {
    1: 'Basic', 2: 'Intermediate', 3: 'Advanced', 4: 'Expert', 5: 'Master'
};

// ─── State ─────────────────────────────────────────────────────────

let explorerVisible = false;
let expandedLevels = new Set();
let searchFilter = '';
let categoryFilter = '';
let scoringFilter = '';

// ─── Helpers ───────────────────────────────────────────────────────

function getScoringColor(type) {
    return SCORING_TYPE_COLORS[type] || '#95a5a6';
}

function groupByLevel(prompts) {
    const groups = {};
    for (const p of prompts) {
        const lvl = p.level || 0;
        if (!groups[lvl]) groups[lvl] = [];
        groups[lvl].push(p);
    }
    return groups;
}

function groupByCategory(prompts) {
    const groups = {};
    for (const p of prompts) {
        const cat = p.category || 'uncategorized';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(p);
    }
    return groups;
}

function matchesFilters(prompt) {
    if (searchFilter) {
        const q = searchFilter.toLowerCase();
        const name = (prompt.name || '').toLowerCase();
        const text = (prompt.prompt || '').toLowerCase();
        const cat = (prompt.category || '').toLowerCase();
        if (!name.includes(q) && !text.includes(q) && !cat.includes(q)) return false;
    }
    if (categoryFilter && (prompt.category || '') !== categoryFilter) return false;
    if (scoringFilter && (prompt.scoring_type || '') !== scoringFilter) return false;
    return true;
}

function getAllCategories(prompts) {
    const cats = new Set();
    for (const p of prompts) if (p.category) cats.add(p.category);
    return [...cats].sort();
}

function getAllScoringTypes(prompts) {
    const types = new Set();
    for (const p of prompts) if (p.scoring_type) types.add(p.scoring_type);
    return [...types].sort();
}

function truncate(text, maxLen = 120) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '\u2026';
}

// ─── Prompt Explorer Panel ─────────────────────────────────────────

/**
 * Toggle the explorer panel visibility
 */
export function toggleExplorer() {
    explorerVisible = !explorerVisible;
    const panel = document.getElementById('promptExplorerPanel');
    const btn = document.getElementById('togglePromptExplorerBtn');
    if (panel) panel.style.display = explorerVisible ? 'block' : 'none';
    if (btn) {
        btn.innerHTML = explorerVisible
            ? '<i class="fas fa-chevron-up"></i> Hide Prompt Explorer'
            : '<i class="fas fa-chevron-down"></i> Browse Prompts';
    }
    if (explorerVisible) renderExplorer();
}

/**
 * Main render for the explorer panel
 */
export function renderExplorer() {
    const container = document.getElementById('promptExplorerContent');
    if (!container) return;

    const allPrompts = state.benchmarkPrompts || [];
    if (allPrompts.length === 0) {
        container.innerHTML = '<div class="pe-empty">No benchmark prompts loaded. Check database seeding.</div>';
        return;
    }

    const depthConfig = getDepthConfig();
    const selectedLevels = getSelectedLevels(depthConfig);
    const filtered = allPrompts.filter(matchesFilters);
    const byLevel = groupByLevel(filtered);

    // Filters bar
    let html = renderFiltersBar(allPrompts);

    // Stats bar
    const totalSelected = filtered.filter(p => selectedLevels.includes(p.level)).length;
    html += `<div class="pe-stats-bar">
        <span>${filtered.length} prompts shown</span>
        <span class="pe-stats-sep">\u00b7</span>
        <span>${totalSelected} in active selection (${selectedLevels.length} levels)</span>
    </div>`;

    // Level groups
    const levelNums = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
    for (const level of levelNums) {
        const levelPrompts = byLevel[level];
        const isActive = selectedLevels.includes(level);
        const depth = depthConfig[level] || 'off';
        const isExpanded = expandedLevels.has(level);
        const label = LEVEL_LABELS[level] || `Level ${level}`;
        const catBreak = groupByCategory(levelPrompts);
        const catCount = Object.keys(catBreak).length;

        html += `<div class="pe-level-group ${isActive ? 'is-active' : 'is-inactive'}">`;
        html += `<div class="pe-level-header" data-level="${level}">`;
        html += `<div class="pe-level-left">`;
        html += `<i class="fas fa-chevron-${isExpanded ? 'down' : 'right'} pe-expand-icon"></i>`;
        html += `<span class="pe-level-badge">${level}</span>`;
        html += `<span class="pe-level-name">${escapeHtml(label)}</span>`;
        html += `<span class="pe-level-meta">${levelPrompts.length} prompts \u00b7 ${catCount} categories \u00b7 depth: <strong>${depth}</strong></span>`;
        html += `</div>`;
        html += `<div class="pe-level-cats">${renderInlineCategoryBadges(level, levelPrompts)}</div>`;
        html += `</div>`;

        if (isExpanded) {
            html += `<div class="pe-level-body">`;
            const catEntries = Object.entries(catBreak).sort((a, b) => a[0].localeCompare(b[0]));
            for (const [cat, catPrompts] of catEntries) {
                html += `<div class="pe-category-section">`;
                html += `<div class="pe-category-header">`;
                html += `<span class="pe-cat-badge" style="--badge-color:${getScoringColor(cat)}">${escapeHtml(cat)}</span>`;
                html += `<span class="pe-category-count">${catPrompts.length} prompts</span>`;
                html += `</div>`;

                for (const prompt of catPrompts) {
                    html += renderPromptCard(prompt);
                }
                html += `</div>`;
            }
            html += `</div>`;
        }

        html += `</div>`;
    }

    container.innerHTML = html;
}

function renderInlineCategoryBadges(level, levelPrompts) {
    const cats = {};
    for (const p of levelPrompts) {
        const c = p.category || 'other';
        cats[c] = (cats[c] || 0) + 1;
    }
    return Object.entries(cats)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => {
            const color = getScoringColor(cat);
            return `<span class="pe-cat-badge" style="--badge-color:${color}" title="${escapeHtml(cat)}: ${count} prompts">${escapeHtml(cat)}<span class="pe-cat-count">${count}</span></span>`;
        }).join('');
}

function renderFiltersBar(allPrompts) {
    const categories = getAllCategories(allPrompts);
    const scoringTypes = getAllScoringTypes(allPrompts);

    let html = `<div class="pe-filters">`;
    html += `<div class="pe-filter-group">`;
    html += `<input type="text" id="peSearchInput" class="pe-search" placeholder="Search prompts..." value="${escapeHtml(searchFilter)}">`;
    html += `</div>`;

    html += `<div class="pe-filter-group">`;
    html += `<select id="peCategoryFilter" class="pe-select">`;
    html += `<option value="">All Categories</option>`;
    for (const cat of categories) {
        const sel = cat === categoryFilter ? ' selected' : '';
        html += `<option value="${escapeHtml(cat)}"${sel}>${escapeHtml(cat)}</option>`;
    }
    html += `</select></div>`;

    html += `<div class="pe-filter-group">`;
    html += `<select id="peScoringFilter" class="pe-select">`;
    html += `<option value="">All Scoring Types</option>`;
    for (const st of scoringTypes) {
        const sel = st === scoringFilter ? ' selected' : '';
        html += `<option value="${escapeHtml(st)}"${sel}>${escapeHtml(st)}</option>`;
    }
    html += `</select></div>`;

    html += `<div class="pe-filter-group pe-filter-actions">`;
    html += `<button type="button" class="btn-link pe-expand-all-btn" id="peExpandAllBtn">Expand All</button>`;
    html += `<button type="button" class="btn-link pe-collapse-all-btn" id="peCollapseAllBtn">Collapse All</button>`;
    html += `</div>`;

    html += `</div>`;
    return html;
}

function renderPromptCard(prompt) {
    const color = getScoringColor(prompt.scoring_type || prompt.category);
    const expectedTokens = prompt.expected_tokens ? `~${prompt.expected_tokens} tokens` : '';
    const hasCriteria = Array.isArray(prompt.judge_criteria) && prompt.judge_criteria.length > 0;
    const hasExpectedAnswer = !!prompt.expected_answer;
    const hasRefAnswer = !!prompt.reference_answer;
    const hasDimensions = Array.isArray(prompt.scoring_dimensions) && prompt.scoring_dimensions.length > 0;
    const hasDeterministic = prompt.deterministic_scoring && prompt.deterministic_scoring.type;
    const hasContract = prompt.output_contract && prompt.output_contract.type;
    const promptId = prompt._id || prompt.id || prompt.name || '';

    let html = `<div class="pe-prompt-card" data-prompt-id="${escapeHtml(promptId)}">`;

    // Header row
    html += `<div class="pe-prompt-header">`;
    html += `<div class="pe-prompt-name">${escapeHtml(prompt.name || 'Unnamed')}</div>`;
    html += `<div class="pe-prompt-badges">`;
    html += `<span class="pe-scoring-badge" style="--badge-color:${color}">${escapeHtml(prompt.scoring_type || 'unknown')}</span>`;
    if (expectedTokens) {
        html += `<span class="pe-token-badge">${expectedTokens}</span>`;
    }
    if (hasDeterministic) {
        html += `<span class="pe-determ-badge" title="Deterministic scoring: ${escapeHtml(prompt.deterministic_scoring.type)}"><i class="fas fa-robot"></i> ${escapeHtml(prompt.deterministic_scoring.type)}</span>`;
    }
    if (hasContract) {
        html += `<span class="pe-contract-badge" title="Output contract: ${escapeHtml(prompt.output_contract.type)}"><i class="fas fa-file-contract"></i> ${escapeHtml(prompt.output_contract.type)}</span>`;
    }
    html += `</div></div>`;

    // Prompt text preview
    html += `<div class="pe-prompt-text">${escapeHtml(truncate(prompt.prompt, 200))}</div>`;

    // Detail toggle
    html += `<div class="pe-prompt-detail-toggle" data-prompt-id="${escapeHtml(promptId)}">`;
    html += `<span class="pe-detail-btn"><i class="fas fa-info-circle"></i> Details</span>`;

    const indicators = [];
    if (hasExpectedAnswer) indicators.push('Expected Answer');
    if (hasCriteria) indicators.push(`${prompt.judge_criteria.length} Criteria`);
    if (hasRefAnswer) indicators.push('Reference Answer');
    if (hasDimensions) indicators.push(`${prompt.scoring_dimensions.length} Dimensions`);
    if (indicators.length > 0) {
        html += `<span class="pe-detail-indicators">${indicators.join(' \u00b7 ')}</span>`;
    }
    html += `</div>`;

    // Detail body (hidden by default)
    html += `<div class="pe-prompt-details" style="display:none;" data-details-for="${escapeHtml(promptId)}">`;

    if (hasExpectedAnswer) {
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-bullseye"></i> Expected Answer</div>`;
        html += `<div class="pe-detail-value">${escapeHtml(prompt.expected_answer)}</div>`;
        html += `</div>`;
    }

    if (hasCriteria) {
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-gavel"></i> Judge Criteria</div>`;
        html += `<ul class="pe-criteria-list">`;
        for (const c of prompt.judge_criteria) {
            html += `<li>${escapeHtml(c)}</li>`;
        }
        html += `</ul></div>`;
    }

    if (hasRefAnswer) {
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-book"></i> Reference Answer</div>`;
        html += `<div class="pe-detail-value pe-ref-answer">${escapeHtml(prompt.reference_answer)}</div>`;
        html += `</div>`;
    }

    if (hasDimensions) {
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-chart-bar"></i> Scoring Dimensions</div>`;
        html += `<div class="pe-dimensions-grid">`;
        for (const dim of prompt.scoring_dimensions) {
            html += `<div class="pe-dimension-card">`;
            html += `<div class="pe-dim-header"><strong>${escapeHtml(dim.name)}</strong><span class="pe-dim-weight">\u00d7${dim.weight}</span></div>`;
            html += `<div class="pe-dim-desc">${escapeHtml(dim.description)}</div>`;
            if (dim.rubric) html += `<div class="pe-dim-rubric">${escapeHtml(dim.rubric)}</div>`;
            html += `</div>`;
        }
        html += `</div></div>`;
    }

    if (hasDeterministic) {
        const ds = prompt.deterministic_scoring;
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-robot"></i> Deterministic Scoring</div>`;
        html += `<div class="pe-detail-value">Type: <strong>${escapeHtml(ds.type)}</strong>`;
        if (ds.case_sensitive) html += ' \u00b7 Case-sensitive';
        if (ds.numeric_tolerance) html += ` \u00b7 Tolerance: ${ds.numeric_tolerance}`;
        if (ds.must_contain && ds.must_contain.length) {
            html += `<br>Must contain: ${ds.must_contain.map(mc => escapeHtml(mc.pattern || mc)).join(', ')}`;
        }
        html += `</div></div>`;
    }

    if (hasContract) {
        const oc = prompt.output_contract;
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-file-contract"></i> Output Contract</div>`;
        html += `<div class="pe-detail-value">Format: <strong>${escapeHtml(oc.type)}</strong>`;
        if (oc.pattern) html += `<br>Pattern: <code>${escapeHtml(oc.pattern)}</code>`;
        if (oc.template) html += `<br>Template: <code>${escapeHtml(oc.template)}</code>`;
        if (oc.description) html += `<br>${escapeHtml(oc.description)}`;
        html += `</div></div>`;
    }

    if (prompt.prompt && prompt.prompt.length > 200) {
        html += `<div class="pe-detail-section">`;
        html += `<div class="pe-detail-label"><i class="fas fa-align-left"></i> Full Prompt</div>`;
        html += `<div class="pe-detail-value pe-full-prompt">${escapeHtml(prompt.prompt)}</div>`;
        html += `</div>`;
    }

    html += `</div></div>`;
    return html;
}

// ─── Preview Selection ─────────────────────────────────────────────

export function renderPreviewSelection() {
    const modal = document.getElementById('previewSelectionModal');
    const modalBody = document.getElementById('previewSelectionBody');
    if (!modal || !modalBody) return;

    const allPrompts = state.benchmarkPrompts || [];
    const depthConfig = getDepthConfig();
    const selectedLevels = getSelectedLevels(depthConfig);

    if (selectedLevels.length === 0) {
        modalBody.innerHTML = '<div class="pe-empty">No levels selected. Set at least one level to a depth other than Off.</div>'; 
        modal.style.display = 'flex';
        return;
    }

    const sampled = simulateSampling(allPrompts, depthConfig);
    const byLevel = groupByLevel(sampled);
    const levelNums = Object.keys(byLevel).map(Number).sort((a, b) => a - b);

    let html = `<div class="pe-preview-summary">`;
    html += `<strong>${sampled.length}</strong> prompts would be tested across <strong>${levelNums.length}</strong> levels`;
    html += `</div>`;

    html += `<div class="pe-preview-table-wrap"><table class="pe-preview-table">`;
    html += `<thead><tr><th>Level</th><th>Category</th><th>Prompt Name</th><th>Type</th><th>Tokens</th></tr></thead>`;
    html += `<tbody>`;

    for (const level of levelNums) {
        const levelPrompts = byLevel[level];
        const depth = depthConfig[level] || 'off';
        const label = LEVEL_LABELS[level] || `L${level}`;

        for (let i = 0; i < levelPrompts.length; i++) {
            const p = levelPrompts[i];
            const color = getScoringColor(p.scoring_type || p.category);
            html += `<tr>`;
            if (i === 0) {
                html += `<td rowspan="${levelPrompts.length}" class="pe-preview-level-cell"><span class="pe-level-badge">${level}</span> ${escapeHtml(label)}<br><span class="pe-preview-depth">${depth}</span></td>`;
            }
            html += `<td><span class="pe-cat-badge" style="--badge-color:${color}">${escapeHtml(p.category)}</span></td>`;
            html += `<td>${escapeHtml(p.name)}</td>`;
            html += `<td class="pe-type-cell">${escapeHtml(p.scoring_type || '')}</td>`;
            html += `<td class="pe-tokens-cell">${p.expected_tokens || '-'}</td>`;
            html += `</tr>`;
        }
    }

    html += `</tbody></table></div>`;

    modalBody.innerHTML = html;
    modal.style.display = 'flex';
}

/**
 * Client-side sampling simulation (mirrors backend promptSampling.js)
 */
function simulateSampling(prompts, depthConfig) {
    const byLevel = groupByLevel(prompts);
    const sampled = [];

    for (const [level, levelPrompts] of Object.entries(byLevel)) {
        const depth = depthConfig[level] || depthConfig[String(level)] || 'off';
        if (depth === 'off') continue;
        if (depth === 'full') {
            sampled.push(...levelPrompts);
            continue;
        }
        if (depth === 'single') {
            const rep = levelPrompts.find(p => p.representative);
            const picked = rep || levelPrompts[0];
            if (picked !== undefined) sampled.push(picked);
            continue;
        }

        const byCategory = groupByCategory(levelPrompts);

        if (depth === 'light') {
            for (const catPrompts of Object.values(byCategory)) {
                if (catPrompts.length > 0) sampled.push(catPrompts[0]);
            }
        }
    }

    return sampled;
}

// ─── Event Binding ─────────────────────────────────────────────────

let _searchTimer = null;

export function bindExplorer() {
    const toggleBtn = document.getElementById('togglePromptExplorerBtn');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleExplorer);

    const previewBtn = document.getElementById('previewSelectionBtn');
    if (previewBtn) previewBtn.addEventListener('click', renderPreviewSelection);

    const closePreview = document.getElementById('closePreviewModal');
    if (closePreview) {
        closePreview.addEventListener('click', () => {
            const modal = document.getElementById('previewSelectionModal');
            if (modal) modal.style.display = 'none';
        });
    }

    // Close preview modal on click outside
    const previewModal = document.getElementById('previewSelectionModal');
    if (previewModal) {
        previewModal.addEventListener('click', (e) => {
            if (e.target === previewModal) previewModal.style.display = 'none';
        });
    }

    const panel = document.getElementById('promptExplorerPanel');
    if (panel) {
        panel.addEventListener('click', handleExplorerClick);
        panel.addEventListener('input', handleExplorerInput);
        panel.addEventListener('change', handleExplorerChange);
    }

    // Re-render when depth config changes
    document.addEventListener('depth-config-changed', () => {
        refreshExplorerIfVisible();
    });
}

function handleExplorerClick(e) {
    const levelHeader = e.target.closest('.pe-level-header');
    if (levelHeader) {
        const level = parseInt(levelHeader.dataset.level, 10);
        if (expandedLevels.has(level)) {
            expandedLevels.delete(level);
        } else {
            expandedLevels.add(level);
        }
        renderExplorer();
        return;
    }

    const detailToggle = e.target.closest('.pe-prompt-detail-toggle');
    if (detailToggle) {
        const promptId = detailToggle.dataset.promptId;
        const details = document.querySelector(`[data-details-for="${CSS.escape(promptId)}"]`);
        if (details) {
            const isVisible = details.style.display !== 'none';
            details.style.display = isVisible ? 'none' : 'block';
            const icon = detailToggle.querySelector('i');
            if (icon) {
                icon.className = isVisible ? 'fas fa-info-circle' : 'fas fa-times-circle';
            }
        }
        return;
    }

    if (e.target.closest('#peExpandAllBtn')) {
        const allPrompts = state.benchmarkPrompts || [];
        const byLevel = groupByLevel(allPrompts);
        expandedLevels = new Set(Object.keys(byLevel).map(Number));
        renderExplorer();
        return;
    }

    if (e.target.closest('#peCollapseAllBtn')) {
        expandedLevels.clear();
        renderExplorer();
        return;
    }
}

function handleExplorerInput(e) {
    if (e.target.id === 'peSearchInput') {
        searchFilter = e.target.value.trim();
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => renderExplorer(), 200);
    }
}

function handleExplorerChange(e) {
    if (e.target.id === 'peCategoryFilter') {
        categoryFilter = e.target.value;
        renderExplorer();
    }
    if (e.target.id === 'peScoringFilter') {
        scoringFilter = e.target.value;
        renderExplorer();
    }
}

/**
 * Re-render explorer when depth config changes
 */
export function refreshExplorerIfVisible() {
    if (explorerVisible) renderExplorer();
}
