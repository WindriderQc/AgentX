// models.js - Model loading and selection UI

import * as state from './state.js';
import { escapeHtml, debugLogThrottled } from './utils.js';
import { fetchOllamaHosts, fetchModelRegistry, patchModelRegistry, createModelRegistry } from './api.js';
import { updateBatchInfo } from './batch-config.js';

/**
 * Fetch Ollama hosts from AgentX config
 */
export async function loadOllamaHosts() {
    debugLogThrottled('loadOllamaHosts', 30000, 'Loading Ollama hosts...');
    const select = document.getElementById('host');

    try {
        const json = await fetchOllamaHosts();
        const data = json.data || json;

        if (data.hosts && data.hosts.length > 0) {
            state.setOllamaHosts(data.hosts);

            if (select) {
                select.innerHTML = state.ollamaHosts.map(h => {
                    const status = h.available ? '\u2713' : '\u2717';
                    const modelCount = h.models ? ` [${h.models.length} models]` : '';
                    return `<option value="${h.url}">${status} ${h.name} (${h.url})${modelCount}</option>`;
                }).join('');

                const firstAvailable = state.ollamaHosts.find(h => h.available);
                if (firstAvailable) {
                    select.value = firstAvailable.url;
                }

                try {
                    loadModelsForHost(select.value);
                } catch (e) {
                    console.error('Failed to load models for host:', e);
                }
                try {
                    await loadBatchModels(select.value);
                } catch (e) {
                    console.error('Failed to load batch models for host:', e);
                }
            }
        } else {
            throw new Error('No hosts configured');
        }
    } catch (err) {
        console.error('Failed to load Ollama hosts:', err);
        if (select) {
            const msg = err.name === 'AbortError' ? 'Request timed out' : 'No hosts available';
            select.innerHTML = `<option value="" selected disabled>${msg} - check server OLLAMA_HOST config</option>`;
        }
    }
}

/**
 * Load available models for selected host
 */
export function loadModelsForHost(hostUrl) {
    const host = state.ollamaHosts.find(h => h.url === hostUrl);
    const modelSelect = document.getElementById('model');

    if (!modelSelect) return;

    if (host && host.models && host.models.length > 0) {
        modelSelect.innerHTML = host.models.map(model =>
            `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`
        ).join('');
        modelSelect.value = host.models[0];
    } else {
        modelSelect.innerHTML = '<option value="">No models available</option>';
    }
}

/**
 * Fetch model registry and update cache
 */
export async function loadModelRegistry() {
    try {
        const json = await fetchModelRegistry();
        if (json.status === 'success') {
            const cache = {};
            json.data.models.forEach(m => {
                cache[m.modelName] = m;
            });
            state.setModelRegistryCache(cache);
            renderCategoryTabs();
        }
    } catch (err) {
        console.error('Failed to fetch model registry:', err);
    }
}

/**
 * Render category tabs
 */
export function renderCategoryTabs() {
    const categories = new Set();
    Object.values(state.modelRegistryCache).forEach(m => {
        if (m.categories && Array.isArray(m.categories)) {
            m.categories.forEach(c => {
                if (c) categories.add(c);
            });
        }
    });

    const sortedCategories = Array.from(categories).sort();
    const container = document.querySelector('.category-tabs');
    if (!container) return;

    const currentActive = document.querySelector('.category-tab.active');
    const activeCategory = currentActive ? currentActive.dataset.category : '';

    let html = `
        <button class="category-tab ${activeCategory === '' ? 'active' : ''}" data-category="" onclick="switchCategoryTab('')" style="padding: 10px 20px; background: none; border: none; border-bottom: 3px solid ${activeCategory === '' ? 'var(--accent)' : 'transparent'}; color: ${activeCategory === '' ? 'var(--accent)' : 'var(--muted)'}; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
            <i class="fas fa-globe" style="margin-right: 6px;"></i> Universal
        </button>
    `;

    sortedCategories.forEach(cat => {
        const isActive = activeCategory === cat;
        let icon = 'fa-tag';
        const lowerCat = cat.toLowerCase();
        if (lowerCat.includes('ops') || lowerCat.includes('glue')) icon = 'fa-bolt';
        else if (lowerCat.includes('code') || lowerCat.includes('dev')) icon = 'fa-code';
        else if (lowerCat.includes('reason') || lowerCat.includes('think')) icon = 'fa-brain';
        else if (lowerCat.includes('special')) icon = 'fa-star';
        else if (lowerCat.includes('general')) icon = 'fa-cubes';

        html += `
            <button class="category-tab ${isActive ? 'active' : ''}" data-category="${cat}" onclick="switchCategoryTab('${cat}')" style="padding: 10px 20px; background: none; border: none; border-bottom: 3px solid ${isActive ? 'var(--accent)' : 'transparent'}; color: ${isActive ? 'var(--accent)' : 'var(--muted)'}; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                <i class="fas ${icon}" style="margin-right: 6px;"></i> ${cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
        `;
    });

    container.innerHTML = html;
}

/**
 * Save model note to registry
 */
export async function saveModelNote(model, note) {
    if (!state.modelRegistryCache[model]) {
        state.modelRegistryCache[model] = { modelName: model, displayName: model };
    }
    state.modelRegistryCache[model].userNote = note;

    try {
        let { res, status } = await patchModelRegistry(model, { userNote: note });

        if (status === 404) {
            await createModelRegistry({
                modelName: model,
                displayName: model,
                userNote: note,
                categories: ['generalist']
            });
        }

        if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
            window.BenchmarkAnalytics.showToast(`Note saved for ${model}`, 'success');
        }
    } catch (err) {
        console.error('Failed to save note:', err);
        if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
            window.BenchmarkAnalytics.showToast(`Failed to save note for ${model}`, 'error');
        }
    }
}

/**
 * Save model category to registry
 */
export async function saveModelCategory(model, category) {
    if (!state.modelRegistryCache[model]) {
        state.modelRegistryCache[model] = { modelName: model, displayName: model };
    }
    state.modelRegistryCache[model].categories = [category];
    renderCategoryTabs();

    try {
        let { res, status } = await patchModelRegistry(model, { categories: [category] });

        if (status === 404) {
            await createModelRegistry({
                modelName: model,
                displayName: model,
                categories: [category]
            });
        }

        if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
            window.BenchmarkAnalytics.showToast(`Category updated for ${model}`, 'success');
        }

        updateModelSelectionBadges();
    } catch (err) {
        console.error('Failed to save category:', err);
        if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
            window.BenchmarkAnalytics.showToast(`Failed to save category for ${model}`, 'error');
        }
    }
}

/**
 * Load models for batch testing
 */
export async function loadBatchModels(hostUrl) {
    await loadModelRegistry();
    const host = state.ollamaHosts.find(h => h.url === hostUrl);
    const tbody = document.getElementById('modelSelectionTableBody');

    if (!tbody) return;

    if (host && host.models && host.models.length > 0) {
        tbody.innerHTML = host.models.map(model => {
            const safeId = model.replace(/[^a-zA-Z0-9]/g, '_');
            const registryEntry = state.modelRegistryCache[model];
            const savedNote = registryEntry ? (registryEntry.userNote || '') : (localStorage.getItem(`agentx_model_note_${model}`) || '');

            let testCount = '-';
            if (window.latestBenchmarkData && window.latestBenchmarkData.model_stats) {
                const stats = window.latestBenchmarkData.model_stats.find(m => m.model === model && m.host === hostUrl);
                if (stats) {
                    const total = Number(stats.tests || 0) + Number(stats.failed_tests || 0);
                    const infraFailed = Number.isFinite(stats.infra_failed_tests) ? Number(stats.infra_failed_tests) : null;
                    const modelFailed = Number.isFinite(stats.model_failed_tests) ? Number(stats.model_failed_tests) : null;

                    if (infraFailed !== null || modelFailed !== null) {
                        const parts = [];
                        if (infraFailed !== null) parts.push(`infra ${infraFailed}`);
                        if (modelFailed !== null) parts.push(`model ${modelFailed}`);
                        testCount = `${total}<div style="font-size: 0.72em; color: var(--muted); margin-top: 2px;">${parts.join(' • ')}</div>`;
                    } else {
                        testCount = total;
                    }
                }
            }

            let category = 'generalist';
            if (registryEntry && registryEntry.categories && registryEntry.categories.length > 0) {
                category = registryEntry.categories[0];
            } else {
                if (model.includes('coder') || model.includes('deepseek-coder')) category = 'coding';
                else if (model.includes('math')) category = 'reasoning';
                else if (model.includes('reasoning') || model.includes('r1')) category = 'reasoning';
                else if (model.includes('ops')) category = 'ops';
            }

            const allCategories = new Set(['generalist', 'coding', 'reasoning', 'ops', 'specialist', 'judge']);
            Object.values(state.modelRegistryCache).forEach(m => {
                if (m.categories) m.categories.forEach(c => {
                    if (c) allCategories.add(c);
                });
            });

            const datalistOptions = Array.from(allCategories).sort().map(c =>
                `<option value="${c}">`
            ).join('');

            return `
            <tr data-model="${escapeHtml(model)}">
                <td style="text-align: center; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <input type="checkbox" id="batch_${safeId}" value="${escapeHtml(model)}" class="batch-model-checkbox">
                </td>
                <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <label for="batch_${safeId}" style="cursor: pointer; font-weight: 500;">${escapeHtml(model)}</label>
                        <div class="model-badges" style="display: flex; gap: 4px;"></div>
                    </div>
                </td>
                <td style="text-align: center; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--muted);">
                    ${testCount}
                </td>
                <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <input type="text" class="model-category-input" data-model="${model}" list="category-list-${safeId}" value="${category}"
                        style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.1); color: var(--text); border-radius: 4px; padding: 4px 8px; font-size: 0.9em; width: 100%;">
                    <datalist id="category-list-${safeId}">
                        ${datalistOptions}
                    </datalist>
                </td>
                <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <input type="text" class="model-note-input" data-model="${model}" value="${savedNote}" placeholder="Add note..."
                        style="width: 100%; background: transparent; border: none; color: var(--text); border-bottom: 1px solid transparent; padding: 4px;">
                </td>
            </tr>
        `}).join('');

        const categoryInputs = tbody.querySelectorAll('.model-category-input');
        categoryInputs.forEach(input => {
            input.addEventListener('change', (event) => {
                const model = event.target.dataset.model;
                if (model) saveModelCategory(model, event.target.value);
            });
        });

        const noteInputs = tbody.querySelectorAll('.model-note-input');
        noteInputs.forEach(input => {
            input.addEventListener('focus', (event) => {
                event.target.style.borderBottom = '1px solid var(--accent)';
            });
            input.addEventListener('blur', (event) => {
                event.target.style.borderBottom = '1px solid transparent';
                const model = event.target.dataset.model;
                if (model) saveModelNote(model, event.target.value);
            });
        });

        updateModelSelectionBadges();

        const selectAllToggle = document.getElementById('selectAllModelsTable');
        if (selectAllToggle) {
            selectAllToggle.checked = true;
        }
        selectAllVisibleModels(true);
    } else {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--muted);">No models available</td></tr>';
        const selectAllToggle = document.getElementById('selectAllModelsTable');
        if (selectAllToggle) {
            selectAllToggle.checked = false;
        }
        updateBatchInfo();
    }

    filterModelList();
}

/**
 * Filter model list based on search and category
 */
export function filterModelList() {
    const searchEl = document.getElementById('modelSearchInput');
    const categoryEl = document.getElementById('modelCategoryFilterSelect');
    const search = searchEl ? searchEl.value.toLowerCase() : '';
    const category = categoryEl ? categoryEl.value.toLowerCase() : '';
    const rows = document.querySelectorAll('#modelSelectionTableBody tr[data-model]');
    let visibleCount = 0;

    rows.forEach(row => {
        const model = row.getAttribute('data-model').toLowerCase();
        const modelCategoryInput = row.querySelector('input[list^="category-list-"]');
        const modelCategory = modelCategoryInput ? modelCategoryInput.value.toLowerCase() : '';

        const matchesSearch = model.includes(search);
        const matchesCategory = category === '' || modelCategory === category || (category === 'specialist' && !['ops', 'coding', 'reasoning', 'generalist'].includes(modelCategory));

        if (matchesSearch && matchesCategory) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });

    const countDisplay = document.getElementById('modelCountDisplay');
    if (countDisplay) {
        countDisplay.textContent = `${visibleCount} models shown`;
    }
}

/**
 * Select/Deselect all visible models
 */
export function selectAllVisibleModels(select) {
    const rows = document.querySelectorAll('#modelSelectionTableBody tr[data-model]');
    rows.forEach(row => {
        if (row.style.display !== 'none') {
            const checkbox = row.querySelector('.batch-model-checkbox');
            if (checkbox) checkbox.checked = select;
        }
    });
    updateBatchInfo();
}

/**
 * Update model selection badges
 */
export function updateModelSelectionBadges() {
    const offenders = window.benchmarkOffenders;
    const rows = document.querySelectorAll('#modelSelectionTableBody tr[data-model]');

    rows.forEach(row => {
        const model = row.getAttribute('data-model');
        const badgeContainer = row.querySelector('.model-badges');
        if (!badgeContainer) return;

        let badgesHtml = '';

        // Category Badge
        if (state.modelRegistryCache[model] && state.modelRegistryCache[model].categories && state.modelRegistryCache[model].categories.length > 0) {
            const cat = state.modelRegistryCache[model].categories[0];
            let icon = 'fa-tag';
            let color = '#95a5a6';
            let bg = 'rgba(149, 165, 166, 0.15)';

            const lowerCat = cat.toLowerCase();
            if (lowerCat.includes('ops') || lowerCat.includes('glue')) {
                icon = 'fa-bolt';
                color = '#f1c40f';
                bg = 'rgba(241, 196, 15, 0.15)';
            }
            else if (lowerCat.includes('code') || lowerCat.includes('dev')) {
                icon = 'fa-code';
                color = '#9b59b6';
                bg = 'rgba(155, 89, 182, 0.15)';
            }
            else if (lowerCat.includes('reason') || lowerCat.includes('think')) {
                icon = 'fa-brain';
                color = '#e91e63';
                bg = 'rgba(233, 30, 99, 0.15)';
            }
            else if (lowerCat.includes('special')) {
                icon = 'fa-star';
                color = '#f39c12';
                bg = 'rgba(243, 156, 18, 0.15)';
            }
            else if (lowerCat.includes('general')) {
                icon = 'fa-cubes';
                color = '#3498db';
                bg = 'rgba(52, 152, 219, 0.15)';
            }

            const catDisplay = cat.charAt(0).toUpperCase() + cat.slice(1);

            badgesHtml += `<span title="Category: ${escapeHtml(catDisplay)}" style="
                color: ${color};
                background: ${bg};
                border: 1px solid ${color}40;
                font-size: 0.75rem;
                font-weight: 600;
                padding: 2px 8px;
                border-radius: 12px;
                margin-right: 6px;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            ">
                <i class="fas ${icon}" style="font-size: 0.9em;"></i> ${escapeHtml(catDisplay)}
            </span>`;
        }

        // Offender Badges
        if (offenders) {
            const isOffender = (offenderObj) => {
                if (!offenderObj) return false;
                if (typeof offenderObj === 'string') return model === offenderObj;
                return model === offenderObj.model;
            };

            if (isOffender(offenders.slowest)) {
                badgesHtml += `<span title="Worst Latency" style="
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 0.7rem; padding: 3px 8px; margin-right: 6px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, rgba(231, 76, 60, 0.25) 0%, rgba(192, 57, 43, 0.15) 100%);
                    border: 1.5px solid rgba(231, 76, 60, 0.5);
                    color: #e74c3c; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.05em; box-shadow: 0 2px 4px rgba(231, 76, 60, 0.2);
                ">SLOW</span>`;
            }
            if (isOffender(offenders.lowestTps)) {
                badgesHtml += `<span title="Worst Throughput" style="
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 0.7rem; padding: 3px 8px; margin-right: 6px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, rgba(230, 126, 34, 0.25) 0%, rgba(211, 84, 0, 0.15) 100%);
                    border: 1.5px solid rgba(230, 126, 34, 0.5);
                    color: #e67e22; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.05em; box-shadow: 0 2px 4px rgba(230, 126, 34, 0.2);
                ">SLUG</span>`;
            }
            if (isOffender(offenders.lowestQuality)) {
                badgesHtml += `<span title="Lowest Quality Score" style="
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 0.7rem; padding: 3px 8px; margin-right: 6px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, rgba(243, 156, 18, 0.25) 0%, rgba(230, 126, 34, 0.15) 100%);
                    border: 1.5px solid rgba(243, 156, 18, 0.5);
                    color: #f39c12; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.05em; box-shadow: 0 2px 4px rgba(243, 156, 18, 0.2);
                ">POOR</span>`;
            }
            if (isOffender(offenders.mostFailures)) {
                badgesHtml += `<span title="Most Test Failures" style="
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 0.7rem; padding: 3px 8px; margin-right: 6px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, rgba(192, 57, 43, 0.3) 0%, rgba(142, 36, 36, 0.2) 100%);
                    border: 1.5px solid rgba(192, 57, 43, 0.6);
                    color: #c0392b; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.05em; box-shadow: 0 2px 4px rgba(192, 57, 43, 0.25);
                ">UNSTABLE</span>`;
            }
        }

        badgeContainer.innerHTML = badgesHtml;
    });
}

// Expose to window for legacy code
if (typeof window !== 'undefined') {
    window.saveModelNote = saveModelNote;
    window.saveModelCategory = saveModelCategory;
    window.updateModelSelectionBadges = updateModelSelectionBadges;
}
