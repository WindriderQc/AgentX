// Ollama host-scoped compare selection UI for Models page
// Persists to the same key used by Benchmark analytics.

const OLLAMA_COMPARE_STORAGE_KEY = 'agentx_benchmark_capability_compare_v1';

function safeJsonParse(raw) {
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

function selectionKey(sel) {
    return `${sel.model}@@${sel.host}`;
}

function loadCompareSelections() {
    const raw = localStorage.getItem(OLLAMA_COMPARE_STORAGE_KEY);
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];

    const out = [];
    for (const item of parsed) {
        const model = item?.model;
        const host = item?.host;
        if (typeof model === 'string' && model && typeof host === 'string' && host) {
            out.push({ model, host });
        }
    }
    return out;
}

function persistCompareSelections(selections) {
    try {
        localStorage.setItem(OLLAMA_COMPARE_STORAGE_KEY, JSON.stringify(selections));
    } catch (_) {
        // ignore
    }
}

async function fetchOllamaHosts() {
    const res = await fetch('/api/ollama-hosts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = json?.data || json;
    const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
    return hosts;
}

function renderHostOptions(hostSelect, hosts) {
    hostSelect.innerHTML = '';

    if (!hosts.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No hosts configured';
        opt.disabled = true;
        opt.selected = true;
        hostSelect.appendChild(opt);
        return;
    }

    for (const h of hosts) {
        const opt = document.createElement('option');
        opt.value = h.url;
        const status = h.available ? '✓' : '✗';
        const modelCount = Array.isArray(h.models) ? ` [${h.models.length} models]` : '';
        opt.textContent = `${status} ${h.name} (${h.url})${modelCount}`;
        hostSelect.appendChild(opt);
    }

    const firstAvailable = hosts.find(h => h && h.available && h.url);
    if (firstAvailable) hostSelect.value = firstAvailable.url;
}

function renderModelMultiSelect(modelSelect, host) {
    modelSelect.innerHTML = '';

    const models = Array.isArray(host?.models) ? host.models : [];
    if (!models.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models available for this host';
        opt.disabled = true;
        opt.selected = true;
        modelSelect.appendChild(opt);
        return;
    }

    for (const modelName of models) {
        const opt = document.createElement('option');
        opt.value = modelName;
        opt.textContent = modelName;
        modelSelect.appendChild(opt);
    }
}

function renderCompareList(container, emptyEl, selections) {
    if (!container) return;

    if (!selections.length) {
        container.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    container.innerHTML = selections.map((sel, idx) => {
        const label = escapeHtml(sel.model);
        const meta = escapeHtml(sel.host);
        return `
            <div class="meta-item" data-idx="${idx}" style="align-items: center; gap: 1rem;">
                <div style="display:flex; flex-direction: column; gap: 0.125rem;">
                    <span class="meta-value" style="font-family: 'Courier New', monospace;">${label}</span>
                    <span class="meta-label" style="font-size: 0.75rem;">${meta}</span>
                </div>
                <button type="button" class="btn-action danger" data-action="remove" style="max-width: 120px;">
                    <i class="fas fa-times"></i> Remove
                </button>
            </div>
        `;
    }).join('');

    container.onclick = (e) => {
        const btn = e.target.closest('button[data-action="remove"]');
        if (!btn) return;
        const row = e.target.closest('[data-idx]');
        const idx = row ? parseInt(row.dataset.idx, 10) : -1;
        if (!Number.isFinite(idx) || idx < 0) return;
        selections.splice(idx, 1);
        persistCompareSelections(selections);
        renderCompareList(container, emptyEl, selections);
    };
}

document.addEventListener('DOMContentLoaded', async () => {
    const hostSelect = document.getElementById('ollamaCompareHost');
    const modelSelect = document.getElementById('ollamaCompareModelSelect');
    const addBtn = document.getElementById('ollamaCompareAddBtn');
    const clearBtn = document.getElementById('ollamaCompareClearBtn');
    const refreshBtn = document.getElementById('ollamaCompareRefreshBtn');
    const listEl = document.getElementById('ollamaCompareList');
    const emptyEl = document.getElementById('ollamaCompareEmpty');

    if (!hostSelect || !modelSelect || !addBtn || !clearBtn || !refreshBtn || !listEl) return;

    let hosts = [];
    let selections = loadCompareSelections();

    async function refreshHosts() {
        try {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refreshing...';
            hosts = await fetchOllamaHosts();
            renderHostOptions(hostSelect, hosts);
            const host = hosts.find(h => h.url === hostSelect.value);
            renderModelMultiSelect(modelSelect, host);
        } catch (err) {
            console.error('Failed to load ollama hosts:', err);
            hostSelect.innerHTML = '<option value="" selected disabled>Failed to load hosts</option>';
            modelSelect.innerHTML = '<option value="" selected disabled>—</option>';
        } finally {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
        }
    }

    function updateButtons() {
        const host = hostSelect.value;
        const selectedCount = Array.from(modelSelect.selectedOptions || []).filter(o => o && o.value).length;
        addBtn.disabled = !host || selectedCount === 0;
        addBtn.innerHTML = `<i class="fas fa-plus"></i> Add Selected (${selectedCount})`;
        clearBtn.disabled = selections.length === 0;
    }

    hostSelect.addEventListener('change', () => {
        const host = hosts.find(h => h.url === hostSelect.value);
        renderModelMultiSelect(modelSelect, host);
        updateButtons();
    });

    modelSelect.addEventListener('change', updateButtons);

    addBtn.addEventListener('click', () => {
        const host = hostSelect.value;
        if (!host) return;

        const picked = Array.from(modelSelect.selectedOptions || [])
            .map(o => o?.value)
            .filter(Boolean);

        if (!picked.length) return;

        const existing = new Set(selections.map(selectionKey));
        for (const model of picked) {
            const sel = { model, host };
            const key = selectionKey(sel);
            if (existing.has(key)) continue;
            existing.add(key);
            selections.push(sel);
        }

        persistCompareSelections(selections);
        renderCompareList(listEl, emptyEl, selections);
        updateButtons();
    });

    clearBtn.addEventListener('click', () => {
        selections = [];
        persistCompareSelections(selections);
        renderCompareList(listEl, emptyEl, selections);
        updateButtons();
    });

    refreshBtn.addEventListener('click', async () => {
        await refreshHosts();
        updateButtons();
    });

    renderCompareList(listEl, emptyEl, selections);
    await refreshHosts();
    updateButtons();
});
