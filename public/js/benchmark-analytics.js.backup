/**
 * Benchmark Analytics Enhancements
 * Provides advanced analytics UI components for benchmark system
 * - Configuration Presets
 * - Real-Time Active Batch Monitoring
 * - Performance Trends Charts
 * - Batch Comparison
 * - Tag Management
 */
import { PollingController } from './utils/polling-controller.js';

const BenchmarkAnalytics = (() => {
    const BENCHMARK_API = '/api/benchmark';
    let poller = null;
    let trendsChart = null;
    let comparisonChart = null;
    let judgeStrictnessChart = null;
    let lastComparisonData = null;

    // Judge breakdown chart
    let judgeBreakdownChart = null;

    // Compare charts
    let capabilityChart = null;
    let judgeRadarChart = null;

    // Compare selections
    const capabilitySelections = []; // { model, host }
    const judgeSelections = []; // { judge_model, judge_host }

    // Cache
    let judgeLeaderboardCache = null;

    const STORAGE_KEYS = {
        capability: 'agentx_benchmark_capability_compare_v1',
        judges: 'agentx_benchmark_judge_compare_v1'
    };
    
    let currentFilters = {
        modelCategory: null,
        promptCategory: null,
        tag: null,
        sort: 'composite'
    };

    /**
     * Initialize all analytics components
     */
    function init() {
        restoreCompareSelections();
        loadPresets();
        startActiveMonitoring();
        loadTrends();
        loadTagStats();
        loadJudgeStats();
        loadBatchHistory(); // Populate batch dropdowns
        setupEventListeners();

        // New compare UIs
        setupCapabilityCompareUI();
        setupJudgeCompareUI();
    }

    function restoreCompareSelections() {
        // Capability
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.capability);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    parsed.forEach(item => {
                        const model = item?.model;
                        const host = item?.host;
                        if (typeof model === 'string' && model && typeof host === 'string' && host) {
                            capabilitySelections.push({ model, host });
                        }
                    });
                }
            }
        } catch (_) {
            // ignore
        }

        // Judges
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.judges);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    parsed.forEach(item => {
                        const judge_model = item?.judge_model;
                        const judge_host = item?.judge_host;
                        if (typeof judge_model === 'string' && judge_model) {
                            judgeSelections.push({
                                judge_model,
                                judge_host: typeof judge_host === 'string' && judge_host ? judge_host : null
                            });
                        }
                    });
                }
            }
        } catch (_) {
            // ignore
        }
    }

    function persistCapabilitySelections() {
        try {
            localStorage.setItem(STORAGE_KEYS.capability, JSON.stringify(capabilitySelections));
        } catch (_) {
            // ignore
        }
    }

    function persistJudgeSelections() {
        try {
            localStorage.setItem(STORAGE_KEYS.judges, JSON.stringify(judgeSelections));
        } catch (_) {
            // ignore
        }
    }

    /**
     * Setup event listeners
     */
    function setupEventListeners() {
        // Trends time period selector
        const periodSelector = document.getElementById('trendsPeriod');
        if (periodSelector) {
            periodSelector.addEventListener('change', () => loadTrends());
        }

        // Refresh Judge Stats
        const refreshJudgeBtn = document.getElementById('refreshJudgeStatsBtn');
        if (refreshJudgeBtn) {
            refreshJudgeBtn.addEventListener('click', () => loadJudgeStats());
        }

        // Judge breakdown controls
        const breakdownSelect = document.getElementById('judgeBreakdownSelect');
        const breakdownGroupBy = document.getElementById('judgeBreakdownGroupBy');
        const breakdownSort = document.getElementById('judgeBreakdownSort');
        const breakdownRefresh = document.getElementById('judgeBreakdownRefreshBtn');
        if (breakdownSelect) breakdownSelect.addEventListener('change', () => loadJudgeBreakdown());
        if (breakdownGroupBy) breakdownGroupBy.addEventListener('change', () => loadJudgeBreakdown());
        if (breakdownSort) breakdownSort.addEventListener('change', () => loadJudgeBreakdown());
        if (breakdownRefresh) breakdownRefresh.addEventListener('click', () => loadJudgeBreakdown());

        // Trend model filter
        const modelFilter = document.getElementById('trendsModelFilter');
        if (modelFilter) {
            modelFilter.addEventListener('change', () => loadTrends());
        }

        // Timeline batch selector
        const timelineSelect = document.getElementById('timelineBatchSelect');
        if (timelineSelect) {
            timelineSelect.addEventListener('change', (e) => loadTimeline(e.target.value));
        }

        // Capability model selector
        const capabilitySelect = document.getElementById('capabilityModelSelect');
        if (capabilitySelect) {
            capabilitySelect.addEventListener('change', (e) => loadCapabilityAnalysis(e.target.value));
        }

        // Batch comparison selector
        const compareBtn = document.getElementById('compareBatchesBtn');
        if (compareBtn) {
            compareBtn.addEventListener('click', compareBatches);
        }

        // Export comparison button
        const exportBtn = document.getElementById('exportComparisonBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', exportComparisonCSV);
        }

        // Tag filter chips
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-chip')) {
                const tag = e.target.dataset.tag;
                filterByTag(tag);
            }
        });
    }

    function computePearsonCorrelation(xs, ys) {
        if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) return null;
        const pairs = xs
            .map((x, i) => ({ x: Number(x), y: Number(ys[i]) }))
            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (pairs.length < 2) return null;

        const n = pairs.length;
        const meanX = pairs.reduce((a, p) => a + p.x, 0) / n;
        const meanY = pairs.reduce((a, p) => a + p.y, 0) / n;

        let num = 0;
        let denX = 0;
        let denY = 0;
        for (const p of pairs) {
            const dx = p.x - meanX;
            const dy = p.y - meanY;
            num += dx * dy;
            denX += dx * dx;
            denY += dy * dy;
        }
        const den = Math.sqrt(denX * denY);
        if (!Number.isFinite(den) || den === 0) return null;
        const r = num / den;
        if (!Number.isFinite(r)) return null;
        return Math.max(-1, Math.min(1, r));
    }

    function renderJudgeBreakdownChart({ groupBy, groups }) {
        const ctx = document.getElementById('judgeBreakdownChart');
        const emptyEl = document.getElementById('judgeBreakdownChartEmpty');
        if (!ctx) return;

        if (!Array.isArray(groups) || groups.length === 0) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (judgeBreakdownChart) {
                judgeBreakdownChart.destroy();
                judgeBreakdownChart = null;
            }
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        const labels = groups.map(g => {
            const key = g.key === null || g.key === undefined ? 'N/A' : String(g.key);
            if (groupBy === 'model' && key.length > 22) return key.slice(0, 19) + '…';
            return key;
        });

        const fullLabels = groups.map(g => (g.key === null || g.key === undefined ? 'N/A' : String(g.key)));
        const latencySeconds = groups.map(g => (Number(g.avg_latency) || 0) / 1000);
        const tokens = groups.map(g => Number(g.avg_test_tokens) || 0);

        const c1 = getPaletteColor(0);
        const c2 = getPaletteColor(1);

        if (judgeBreakdownChart) judgeBreakdownChart.destroy();
        judgeBreakdownChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        type: 'bar',
                        label: 'Avg Judge Latency (s)',
                        data: latencySeconds,
                        backgroundColor: c1.bg,
                        borderColor: c1.border,
                        borderWidth: 1,
                        yAxisID: 'yLatency'
                    },
                    {
                        type: 'line',
                        label: 'Avg Test Tokens',
                        data: tokens,
                        borderColor: c2.border,
                        backgroundColor: c2.bg,
                        tension: 0.25,
                        pointRadius: 2,
                        pointHoverRadius: 4,
                        yAxisID: 'yTokens'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: '#888' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const idx = items?.[0]?.dataIndex;
                                if (idx === null || idx === undefined) return '';
                                return groupBy === 'model' ? fullLabels[idx] : `Level ${fullLabels[idx]}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#888' }
                    },
                    yLatency: {
                        position: 'left',
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#888' },
                        title: { display: true, text: 'Seconds', color: '#888' }
                    },
                    yTokens: {
                        position: 'right',
                        beginAtZero: true,
                        grid: { display: false },
                        ticks: { color: '#888' },
                        title: { display: true, text: 'Tokens', color: '#888' }
                    }
                }
            }
        });
    }

    function renderJudgeBreakdownInsights({ groupBy, groups }) {
        const insightsEl = document.getElementById('judgeBreakdownInsights');
        if (!insightsEl) return;

        if (!Array.isArray(groups) || groups.length === 0) {
            insightsEl.innerHTML = '<div style="color: var(--muted);">No insights yet.</div>';
            return;
        }

        const byLatency = [...groups].sort((a, b) => (Number(b.avg_latency) || 0) - (Number(a.avg_latency) || 0));
        const slowest = byLatency[0];
        const fastest = byLatency[byLatency.length - 1];

        const xs = groups.map(g => Number(g.avg_test_tokens) || 0);
        const ys = groups.map(g => Number(g.avg_latency) || 0);
        const r = computePearsonCorrelation(xs, ys);

        const rText = (r === null)
            ? 'N/A'
            : `${r.toFixed(2)} (${Math.abs(r) >= 0.6 ? 'strong' : Math.abs(r) >= 0.3 ? 'moderate' : 'weak'})`;

        const label = (row) => {
            const key = row?.key === null || row?.key === undefined ? 'N/A' : String(row.key);
            return groupBy === 'model' ? key : `Level ${key}`;
        };

        insightsEl.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div style="font-weight: 700; color: var(--text);">Summary</div>
                <div style="display: grid; grid-template-columns: 1fr; gap: 10px;">
                    <div style="display: flex; justify-content: space-between; gap: 10px;">
                        <div style="color: var(--muted);">Slowest group</div>
                        <div style="color: var(--text); font-weight: 600; text-align: right;">
                            ${escapeHtml(label(slowest))} • ${(((Number(slowest.avg_latency) || 0) / 1000)).toFixed(2)}s
                        </div>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 10px;">
                        <div style="color: var(--muted);">Fastest group</div>
                        <div style="color: var(--text); font-weight: 600; text-align: right;">
                            ${escapeHtml(label(fastest))} • ${(((Number(fastest.avg_latency) || 0) / 1000)).toFixed(2)}s
                        </div>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 10px;">
                        <div style="color: var(--muted);">Tokens ↔ Judge latency correlation</div>
                        <div style="color: var(--text); font-weight: 600; text-align: right;">${escapeHtml(rText)}</div>
                    </div>
                </div>

                <div style="margin-top: 6px; padding: 10px; border-radius: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);">
                    <div style="color: var(--muted); font-size: 0.9em; line-height: 1.4;">
                        If correlation is positive, higher judge ms is usually explained by longer answers (more tokens) and/or higher-level prompts.
                    </div>
                </div>
            </div>
        `;
    }

    function getSelectedHost() {
        const hostEl = document.getElementById('host');
        return hostEl ? hostEl.value : '';
    }

    function getActiveProfileKey() {
        const profileEl = document.getElementById('scoringProfile');
        const profile = profileEl ? profileEl.value : 'interactive';
        if (profile === 'reasoning') return 'reasoning_score';
        if (profile === 'coding') return 'coding_score';
        return 'interactive_score';
    }

    async function ensureDashboardLoaded() {
        if (window.latestBenchmarkData && Array.isArray(window.latestBenchmarkData.model_stats)) return;
        if (typeof window.loadDashboard === 'function') {
            try {
                await window.loadDashboard();
            } catch (_) {
                // ignore
            }
        }
    }

    function selectionKeyModel(sel) {
        return `${sel.model}@@${sel.host || ''}`;
    }

    function selectionKeyJudge(sel) {
        return `${sel.judge_model}@@${sel.judge_host || ''}`;
    }

    function getPaletteColor(index) {
        const palette = [
            { border: '#00FF9F', bg: 'rgba(0, 255, 159, 0.18)' },
            { border: '#7CF0FF', bg: 'rgba(124, 240, 255, 0.16)' },
            { border: '#FF6B9D', bg: 'rgba(255, 107, 157, 0.14)' },
            { border: '#FFD700', bg: 'rgba(255, 215, 0, 0.14)' },
            { border: '#A78BFA', bg: 'rgba(167, 139, 250, 0.14)' },
            { border: '#34D399', bg: 'rgba(52, 211, 153, 0.14)' }
        ];
        return palette[index % palette.length];
    }

    function renderChipList(containerId, items, onRemove) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!items.length) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = items.map((item, idx) => {
            const label = item.label;
            const meta = item.meta;
            return `
                <span class="compare-chip" data-idx="${idx}">
                    <span>${escapeHtml(label)}</span>
                    ${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}
                    <button type="button" class="compare-chip-remove" title="Remove" aria-label="Remove">×</button>
                </span>
            `;
        }).join('');

        // delegate
        container.onclick = (e) => {
            const btn = e.target.closest('.compare-chip-remove');
            if (!btn) return;
            const chip = e.target.closest('.compare-chip');
            const idxStr = chip?.dataset?.idx;
            const idx = idxStr ? parseInt(idxStr, 10) : -1;
            if (Number.isFinite(idx) && idx >= 0) onRemove(idx);
        };
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function setupCapabilityCompareUI() {
        const addBtn = document.getElementById('capabilityAddSelectedBtn');
        const addTopBtn = document.getElementById('capabilityAddTopBtn');
        const clearBtn = document.getElementById('capabilityClearBtn');
        const refreshBtn = document.getElementById('capabilityRefreshBtn');

        function updateAddButtonState() {
            if (!addBtn) return;
            const host = getSelectedHost();
            const checkedCount = document.querySelectorAll('.batch-model-checkbox:checked').length;
            addBtn.disabled = !host;
            addBtn.title = host
                ? `Adds ${checkedCount} checked model(s) using ${host}`
                : 'Select an Ollama Host first';
            addBtn.innerHTML = `<i class="fas fa-plus"></i> Add Checked (${checkedCount}) @ Host`;

            if (addTopBtn) {
                addTopBtn.disabled = !host;
                addTopBtn.title = host
                    ? `Adds top leaderboard models using ${host}`
                    : 'Select an Ollama Host first';
            }
        }

        if (addBtn) {
            addBtn.addEventListener('click', () => {
                addCheckedModelsToCapabilityCompare();
                updateAddButtonState();
            });
        }

        if (addTopBtn) {
            addTopBtn.addEventListener('click', async () => {
                await addTopModelsToCapabilityCompare(3);
                updateAddButtonState();
            });
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                capabilitySelections.splice(0, capabilitySelections.length);
                refreshCapabilityCompare();
                updateAddButtonState();
            });
        }
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                refreshCapabilityCompare();
                updateAddButtonState();
            });
        }

        const hostEl = document.getElementById('host');
        if (hostEl) {
            hostEl.addEventListener('change', () => {
                updateAddButtonState();
            });
        }

        document.addEventListener('change', (e) => {
            const target = e.target;
            if (target && target.classList && target.classList.contains('batch-model-checkbox')) {
                updateAddButtonState();
            }
        });

        // initial state
        refreshCapabilityCompare();
        updateAddButtonState();
    }

    async function addTopModelsToCapabilityCompare(topN = 3) {
        const host = getSelectedHost();
        if (!host) {
            showToast('Select an Ollama host first', 'warning');
            return;
        }

        await ensureDashboardLoaded();
        const rows = Array.isArray(window.latestBenchmarkData?.model_stats)
            ? window.latestBenchmarkData.model_stats
            : [];

        if (!rows.length) {
            showToast('No leaderboard data yet — try Refresh or run a batch', 'warning');
            return;
        }

        const profileKey = getActiveProfileKey();
        const hostRows = rows
            .filter(r => r && r.host === host)
            .filter(r => Number(r.tests) > 0);

        if (!hostRows.length) {
            showToast('No leaderboard entries for this host yet', 'warning');
            return;
        }

        const scored = hostRows
            .map(r => {
                const primary = Number.parseFloat(r[profileKey]);
                const fallback = Number.parseFloat(r.composite);
                const score = Number.isFinite(primary) ? primary : (Number.isFinite(fallback) ? fallback : null);
                return { r, score };
            })
            .filter(x => x.score !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(1, Number(topN) || 1));

        if (!scored.length) {
            showToast('No usable scores found for this host yet', 'warning');
            return;
        }

        const existing = new Set(capabilitySelections.map(selectionKeyModel));
        let added = 0;

        for (const { r } of scored) {
            const model = r?.model;
            if (!model) continue;
            const sel = { model, host };
            const key = selectionKeyModel(sel);
            if (existing.has(key)) continue;
            capabilitySelections.push(sel);
            existing.add(key);
            added++;
        }

        if (added > 0) showToast(`Added top ${added} model(s)`, 'success');
        refreshCapabilityCompare();
    }

    function addCheckedModelsToCapabilityCompare() {
        const host = getSelectedHost();
        if (!host) {
            showToast('Select an Ollama host first', 'warning');
            return;
        }

        const checked = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'))
            .map(cb => cb.value)
            .filter(Boolean);

        if (!checked.length) {
            showToast('Check one or more models to add', 'warning');
            return;
        }

        const existing = new Set(capabilitySelections.map(selectionKeyModel));
        let added = 0;

        for (const model of checked) {
            const sel = { model, host };
            const key = selectionKeyModel(sel);
            if (existing.has(key)) continue;
            capabilitySelections.push(sel);
            existing.add(key);
            added++;
        }

        if (added > 0) {
            showToast(`Added ${added} model(s)`, 'success');
        }
        refreshCapabilityCompare();
    }

    async function refreshCapabilityCompare() {
        persistCapabilitySelections();
        // chips
        renderChipList(
            'capabilityCompareList',
            capabilitySelections.map(sel => ({
                label: sel.model,
                meta: sel.host ? `@ ${sel.host}` : ''
            })),
            (idx) => {
                capabilitySelections.splice(idx, 1);
                refreshCapabilityCompare();
            }
        );

        const emptyEl = document.getElementById('capabilityEmpty');
        const insightsEl = document.getElementById('capabilityInsights');
        if (insightsEl) insightsEl.innerHTML = '';

        if (!capabilitySelections.length) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (capabilityChart) {
                capabilityChart.destroy();
                capabilityChart = null;
            }
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        const ctx = document.getElementById('capabilityRadarChart');
        if (!ctx) return;

        try {
            const breakdowns = await Promise.all(
                capabilitySelections.map(async sel => {
                    const res = await fetch(`${BENCHMARK_API}/quality-breakdown?model=${encodeURIComponent(sel.model)}&host=${encodeURIComponent(sel.host)}`);
                    const json = await res.json();
                    return { sel, data: json.data };
                })
            );

            // Derive categories from API response (fixed list today)
            const categories = (breakdowns[0]?.data?.categories || []).slice();
            const labels = categories.map(c => c.charAt(0).toUpperCase() + c.slice(1));

            const datasets = breakdowns.map((b, idx) => {
                const byModel = b.data?.by_category?.[b.sel.model] || {};
                const values = categories.map(cat => {
                    const raw = byModel?.[cat]?.avg_quality ?? byModel?.[cat]?.avg_score;
                    const num = raw === null || raw === undefined ? 0 : parseFloat(raw);
                    return Number.isFinite(num) ? num : 0;
                });

                const c = getPaletteColor(idx);
                const label = `${b.sel.model} @ ${b.sel.host}`;

                return {
                    label,
                    data: values,
                    fill: true,
                    backgroundColor: c.bg,
                    borderColor: c.border,
                    pointBackgroundColor: c.border,
                    pointBorderColor: '#fff',
                    pointHoverBackgroundColor: '#fff',
                    pointHoverBorderColor: c.border
                };
            });

            if (capabilityChart) capabilityChart.destroy();
            capabilityChart = new Chart(ctx, {
                type: 'radar',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        r: {
                            angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' },
                            pointLabels: {
                                color: '#fff',
                                font: { size: 12, weight: 'bold' }
                            },
                            ticks: {
                                backdropColor: 'transparent',
                                color: 'rgba(255, 255, 255, 0.5)',
                                min: 0,
                                max: 10,
                                stepSize: 2
                            },
                            suggestedMin: 0,
                            suggestedMax: 10
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            labels: { color: '#E0E7FF' }
                        },
                        tooltip: {
                            backgroundColor: 'rgba(10, 14, 39, 0.9)',
                            titleColor: '#fff',
                            bodyColor: '#ccc',
                            borderColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            padding: 10,
                            callbacks: {
                                label: function(context) {
                                    return `${context.dataset.label}: ${context.raw.toFixed(1)} / 10`;
                                }
                            }
                        }
                    }
                }
            });

            // Insights: best/worst per dataset
            if (insightsEl) {
                const insightRows = datasets.map(ds => {
                    const values = ds.data;
                    let bestIdx = 0;
                    let worstIdx = 0;
                    values.forEach((v, i) => {
                        if (v > values[bestIdx]) bestIdx = i;
                        if (v < values[worstIdx]) worstIdx = i;
                    });
                    return `
                        <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; margin-bottom: 10px;">
                            <div style="font-weight: 600; color: var(--text); margin-bottom: 6px;">${escapeHtml(ds.label)}</div>
                            <div style="color: var(--muted); font-size: 0.9em; line-height: 1.5;">
                                Strongest: <strong>${escapeHtml(labels[bestIdx])}</strong> (${values[bestIdx].toFixed(1)})<br>
                                Weakest: <strong>${escapeHtml(labels[worstIdx])}</strong> (${values[worstIdx].toFixed(1)})
                            </div>
                        </div>
                    `;
                }).join('');
                insightsEl.innerHTML = `
                    <h4 style="margin: 0 0 12px; color: var(--accent);"><i class="fas fa-lightbulb"></i> Compare Insights</h4>
                    ${insightRows}
                `;
            }
        } catch (err) {
            console.error('Failed to refresh capability compare:', err);
            showToast('Failed to load capability data', 'error');
        }
    }

    /**
     * Load and display configuration presets
     */
    async function loadPresets() {
        try {
            const res = await fetch(`${BENCHMARK_API}/presets`);
            const { data } = await res.json();

            const container = document.getElementById('presetsContainer');
            if (!container) return;

            container.innerHTML = data.presets.map(preset => `
                <div class="preset-card" data-preset-id="${preset.id}">
                    <div class="preset-header">
                        <h4>${preset.name}</h4>
                        <span class="preset-duration">${preset.estimated_duration}</span>
                    </div>
                    <p class="preset-description">${preset.description}</p>
                    <div class="preset-config">
                        <div class="preset-badge">
                            <i class="fas fa-layer-group"></i> Levels: ${preset.config.levels.join(', ')}
                        </div>
                        <div class="preset-badge">
                            ${preset.config.quality_scoring
                                ? '<i class="fas fa-check-circle"></i> Quality Scoring'
                                : '<i class="fas fa-times-circle"></i> No Scoring'}
                        </div>
                    </div>
                    <div class="preset-recommended">
                        <i class="fas fa-lightbulb"></i> ${preset.recommended_for}
                    </div>
                    <button class="btn-preset" onclick="BenchmarkAnalytics.applyPreset('${preset.id}')">
                        <i class="fas fa-bolt"></i> Use Preset
                    </button>
                </div>
            `).join('');
        } catch (err) {
            console.error('Failed to load presets:', err);
        }
    }

    /**
     * Apply a configuration preset
     */
    async function applyPreset(presetId) {
        try {
            const res = await fetch(`${BENCHMARK_API}/presets`);
            const { data } = await res.json();
            const preset = data.presets.find(p => p.id === presetId);

            if (!preset) return;

            // Apply levels
            [1, 2, 3, 4, 5].forEach(level => {
                const checkbox = document.getElementById(`level${level}`);
                if (checkbox) {
                    checkbox.checked = preset.config.levels.includes(level);
                }
            });

            // Apply quality scoring
            const qualityCheckbox = document.getElementById('qualityScoring');
            if (qualityCheckbox) {
                qualityCheckbox.checked = preset.config.quality_scoring;
            }

            // Show confirmation
            showToast(`✓ ${preset.name} preset applied`, 'success');

            // Scroll to batch form
            document.querySelector('.batch-section')?.scrollIntoView({ behavior: 'smooth' });
        } catch (err) {
            console.error('Failed to apply preset:', err);
            showToast('Failed to apply preset', 'error');
        }
    }

    /**
     * Start real-time monitoring of active batches
     */
    function startActiveMonitoring() {
        // Initial load
        loadActiveStats();

        // Poll every 3 seconds (pause-on-blur via shared controller)
        if (poller) poller.destroy();
        poller = new PollingController();
        poller.addTask('active-batches', loadActiveStats, 3000, { runOnStart: false });
        poller.start();
    }

    /**
     * Stop active monitoring
     */
    function stopActiveMonitoring() {
        if (poller) {
            poller.destroy();
            poller = null;
        }
    }

    /**
     * Load active batch statistics
     */
    async function loadActiveStats() {
        try {
            const res = await fetch(`${BENCHMARK_API}/active-stats`);
            const { data } = await res.json();

            const container = document.getElementById('activeStatsContainer');
            if (!container) return;

            if (data.active_batches === 0) {
                container.innerHTML = `
                    <div class="no-active-batches">
                        <i class="fas fa-check-circle"></i>
                        <p>No active batches</p>
                        <button class="btn-secondary btn-sm" onclick="document.querySelector('.batch-section')?.scrollIntoView({ behavior: 'smooth' })" style="margin-top: 12px;">
                            <i class="fas fa-plus"></i> Start New Batch
                        </button>
                    </div>
                `;
                return;
            }

            // Update active batches widget
            container.innerHTML = `
                <div class="active-stats-header">
                    <h3><i class="fas fa-play-circle"></i> Active Batches (${data.active_batches})</h3>
                    ${data.estimated_completion_time ? `
                        <div class="eta-badge">
                            <i class="fas fa-clock"></i>
                            ETA: ${formatDuration(data.estimated_completion_time)}
                        </div>
                    ` : ''}
                </div>
                <div class="active-batches-grid">
                    ${data.batches.map(batch => `
                        <div class="active-batch-card">
                            <div class="batch-name">${batch.run_name}</div>
                            <div class="batch-progress-bar">
                                <div class="batch-progress-fill" style="width: ${batch.progress}%"></div>
                            </div>
                            <div class="batch-stats">
                                <span>${batch.completed} / ${batch.total}</span>
                                <span>${batch.progress.toFixed(1)}%</span>
                                ${batch.eta_ms ? `<span class="eta">${formatDuration(batch.eta_ms)}</span>` : ''}
                            </div>
                            ${batch.judge_progress !== undefined ? `
                                <div class="judge-progress">
                                    <small>Quality Scoring: ${batch.judge_progress.toFixed(0)}%</small>
                                </div>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (err) {
            console.error('Failed to load active stats:', err);
        }
    }

    /**
     * Load performance trends chart
     */
    async function loadTrends() {
        try {
            const period = document.getElementById('trendsPeriod')?.value || '7';
            const model = document.getElementById('trendsModelFilter')?.value || '';

            const res = await fetch(`${BENCHMARK_API}/trends?days=${period}${model ? `&model=${model}` : ''}`);
            const { data } = await res.json();

            const ctx = document.getElementById('trendsChart');
            if (!ctx) return;

            // Prepare chart data
            const labels = data.trends.map(t => {
                if (t._id.hour !== undefined) {
                    return `${t._id.month}/${t._id.day} ${t._id.hour}:00`;
                }
                return `${t._id.month}/${t._id.day}`;
            });

            const datasets = [
                {
                    label: 'Avg Latency (ms)',
                    data: data.trends.map(t => t.avg_latency),
                    borderColor: '#7CF0FF',
                    backgroundColor: 'rgba(124, 240, 255, 0.1)',
                    yAxisID: 'y',
                    tension: 0.3
                },
                {
                    label: 'Avg Quality Score (x10)',
                    data: data.trends.map(t => t.avg_quality ? t.avg_quality * 10 : null),
                    borderColor: '#00FF9F',
                    backgroundColor: 'rgba(0, 255, 159, 0.1)',
                    yAxisID: 'y1',
                    tension: 0.3
                },
                {
                    label: 'Tokens/sec',
                    data: data.trends.map(t => t.avg_tokens_per_sec || null),
                    borderColor: '#FF6B9D',
                    backgroundColor: 'rgba(255, 107, 157, 0.1)',
                    yAxisID: 'y1',
                    tension: 0.3
                }
            ];

            // Destroy existing chart
            if (trendsChart) {
                trendsChart.destroy();
            }

            // Create new chart
            trendsChart = new Chart(ctx, {
                type: 'line',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: {
                            position: 'top',
                            labels: { color: '#E0E7FF' }
                        },
                        title: {
                            display: true,
                            text: `Performance Trends - ${data.model === 'all' ? 'All Models' : data.model}`,
                            color: '#E0E7FF'
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#94A3B8' },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: { display: true, text: 'Latency (ms)', color: '#7CF0FF' },
                            ticks: { color: '#7CF0FF' },
                            grid: { color: 'rgba(124, 240, 255, 0.1)' }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: { display: true, text: 'Quality / Tokens/sec', color: '#00FF9F' },
                            ticks: { color: '#00FF9F' },
                            grid: { display: false }
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Failed to load trends:', err);
        }
    }

    /**
     * Load capability radar chart for a model
     */
    async function loadCapabilityAnalysis(modelName) {
        if (!modelName) return;

        try {
            const host = getSelectedHost();
            const res = await fetch(`${BENCHMARK_API}/quality-breakdown?model=${encodeURIComponent(modelName)}${host ? `&host=${encodeURIComponent(host)}` : ''}`);
            const json = await res.json();
            const data = json.data;

            const ctx = document.getElementById('capabilityRadarChart');
            const insightsContainer = document.getElementById('capabilityInsights');
            
            if (!ctx || !insightsContainer) return;

            // Process data for chart (API shape: by_category[model][category])
            const categories = data.categories || [];
            const byModel = data.by_category?.[modelName] || {};
            const scores = categories.map(cat => {
                const raw = byModel?.[cat]?.avg_quality ?? byModel?.[cat]?.avg_score;
                const num = raw === null || raw === undefined ? 0 : parseFloat(raw);
                return Number.isFinite(num) ? num : 0;
            });

            // Destroy existing chart
            if (capabilityChart) {
                capabilityChart.destroy();
            }

            // Create Radar Chart
            capabilityChart = new Chart(ctx, {
                type: 'radar',
                data: {
                    labels: categories.map(c => c.charAt(0).toUpperCase() + c.slice(1)),
                    datasets: [{
                        label: host ? `${modelName} @ ${host}` : modelName,
                        data: scores,
                        fill: true,
                        backgroundColor: 'rgba(0, 255, 159, 0.2)',
                        borderColor: '#00FF9F',
                        pointBackgroundColor: '#00FF9F',
                        pointBorderColor: '#fff',
                        pointHoverBackgroundColor: '#fff',
                        pointHoverBorderColor: '#00FF9F'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        r: {
                            angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' },
                            pointLabels: {
                                color: '#fff',
                                font: { size: 12, weight: 'bold' }
                            },
                            ticks: {
                                backdropColor: 'transparent',
                                color: 'rgba(255, 255, 255, 0.5)',
                                min: 0,
                                max: 10,
                                stepSize: 2
                            },
                            suggestedMin: 0,
                            suggestedMax: 10
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(10, 14, 39, 0.9)',
                            titleColor: '#fff',
                            bodyColor: '#ccc',
                            borderColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            padding: 10,
                            callbacks: {
                                label: function(context) {
                                    return `Score: ${context.raw.toFixed(1)} / 10`;
                                }
                            }
                        }
                    }
                }
            });

            // Generate Insights
            const bestCat = categories.reduce((a, b) =>
                (byModel?.[a]?.avg_quality || 0) > (byModel?.[b]?.avg_quality || 0) ? a : b
            , categories[0]);
            
            const worstCat = categories.reduce((a, b) => 
                (byModel?.[a]?.avg_quality || 0) < (byModel?.[b]?.avg_quality || 0) ? a : b
            , categories[0]);

            const bestScore = (byModel?.[bestCat]?.avg_quality !== undefined && byModel?.[bestCat]?.avg_quality !== null)
                ? parseFloat(byModel[bestCat].avg_quality).toFixed(1)
                : 'N/A';
            const worstScore = (byModel?.[worstCat]?.avg_quality !== undefined && byModel?.[worstCat]?.avg_quality !== null)
                ? parseFloat(byModel[worstCat].avg_quality).toFixed(1)
                : 'N/A';
            const totalTests = data.overall.length;

            insightsContainer.innerHTML = `
                <h4 style="margin: 0 0 16px; color: var(--accent);"><i class="fas fa-lightbulb"></i> Capability Insights</h4>
                <div style="display: grid; gap: 12px;">
                    <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">
                        <div style="color: var(--muted); font-size: 0.9em;">Strongest Category</div>
                        <div style="font-size: 1.1em; font-weight: 600; color: #fff;">
                            ${bestCat.charAt(0).toUpperCase() + bestCat.slice(1)} 
                            <span style="color: #00FF9F;">(${bestScore})</span>
                        </div>
                    </div>
                    <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">
                        <div style="color: var(--muted); font-size: 0.9em;">Weakest Category</div>
                        <div style="font-size: 1.1em; font-weight: 600; color: #fff;">
                            ${worstCat.charAt(0).toUpperCase() + worstCat.slice(1)} 
                            <span style="color: #FF6B9D;">(${worstScore})</span>
                        </div>
                    </div>
                    <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">
                        <div style="color: var(--muted); font-size: 0.9em;">Data Points</div>
                        <div style="font-size: 1.1em; font-weight: 600; color: #fff;">
                            ${totalTests} tests analyzed
                        </div>
                    </div>
                </div>
                <div style="margin-top: 20px; font-size: 0.9em; color: var(--muted); line-height: 1.5;">
                    This model excels at <strong>${bestCat}</strong> tasks but may struggle with <strong>${worstCat}</strong>. 
                    ${totalTests < 5 ? '<br><br><i class="fas fa-exclamation-triangle" style="color: #FFD700;"></i> Low sample size - run more tests for accurate analysis.' : ''}
                </div>
            `;

        } catch (err) {
            console.error('Failed to load capability analysis:', err);
        }
    }

    function setupJudgeCompareUI() {
        const addBtn = document.getElementById('judgeAddCompareBtn');
        const addTopBtn = document.getElementById('judgeAddTopCompareBtn');
        const clearBtn = document.getElementById('judgeClearCompareBtn');
        const refreshBtn = document.getElementById('judgeRefreshCompareBtn');
        const selectEl = document.getElementById('judgeCompareSelect');

        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const raw = selectEl?.value || '';
                if (!raw) {
                    showToast('Select a judge to add', 'warning');
                    return;
                }
                const [judge_model, judge_host] = raw.split('@@');
                const sel = { judge_model, judge_host: judge_host || null };
                const key = selectionKeyJudge(sel);
                const existing = new Set(judgeSelections.map(selectionKeyJudge));
                if (!existing.has(key)) {
                    judgeSelections.push(sel);
                    refreshJudgeCompare();
                }
            });
        }

        if (addTopBtn) {
            addTopBtn.addEventListener('click', async () => {
                await addTopJudgeToCompare();
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                judgeSelections.splice(0, judgeSelections.length);
                refreshJudgeCompare();
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => refreshJudgeCompare());
        }

        refreshJudgeCompare();
    }

    async function ensureJudgeLeaderboardLoaded() {
        if (Array.isArray(judgeLeaderboardCache) && judgeLeaderboardCache.length) return judgeLeaderboardCache;
        try {
            await loadJudgeStats();
        } catch (_) {
            // ignore
        }
        return Array.isArray(judgeLeaderboardCache) ? judgeLeaderboardCache : [];
    }

    async function addTopJudgeToCompare() {
        const leaderboard = await ensureJudgeLeaderboardLoaded();
        if (!leaderboard.length) {
            showToast('No judge leaderboard data yet', 'warning');
            return;
        }

        const top = leaderboard[0];
        const sel = { judge_model: top.judge_model, judge_host: top.judge_host || null };
        const key = selectionKeyJudge(sel);
        const existing = new Set(judgeSelections.map(selectionKeyJudge));
        if (existing.has(key)) {
            showToast('Top judge is already in compare', 'warning');
            return;
        }

        judgeSelections.push(sel);
        showToast('Added top judge', 'success');
        refreshJudgeCompare();
    }

    function populateJudgeCompareSelect(leaderboard) {
        const container = document.getElementById('judgeCompareContainer');
        const selectEl = document.getElementById('judgeCompareSelect');
        if (!selectEl) return;

        if (!leaderboard || leaderboard.length === 0) {
            selectEl.innerHTML = '<option value="">No judges available</option>';
            if (container) container.style.display = 'none';
            return;
        }

        if (container) container.style.display = 'block';

        selectEl.innerHTML = '<option value="">Select judge...</option>' +
            leaderboard.map(j => {
                const key = `${j.judge_model}@@${j.judge_host || ''}`;
                const label = `${j.judge_model} @ ${j.judge_host || 'N/A'}`;
                return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
            }).join('');
    }

    function populateJudgeBreakdownSelect(leaderboard) {
        const container = document.getElementById('judgeBreakdownContainer');
        const selectEl = document.getElementById('judgeBreakdownSelect');
        if (!selectEl) return;

        if (!leaderboard || leaderboard.length === 0) {
            selectEl.innerHTML = '<option value="">No judges available</option>';
            if (container) container.style.display = 'none';
            return;
        }

        if (container) container.style.display = 'block';

        const current = selectEl.value;
        selectEl.innerHTML = '<option value="">Select judge...</option>' +
            leaderboard.map(j => {
                const key = `${j.judge_model}@@${j.judge_host || ''}`;
                const label = `${j.judge_model} @ ${j.judge_host || 'N/A'}`;
                return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
            }).join('');

        // Preserve selection if possible; else default to top judge.
        if (current) {
            selectEl.value = current;
        }
        if (!selectEl.value && leaderboard.length > 0) {
            selectEl.value = `${leaderboard[0].judge_model}@@${leaderboard[0].judge_host || ''}`;
        }
    }

    function parseJudgeKey(raw) {
        if (!raw || typeof raw !== 'string') return null;
        const parts = raw.split('@@');
        const judge_model = (parts[0] || '').trim();
        const judge_host = (parts[1] || '').trim();
        if (!judge_model) return null;
        return { judge_model, judge_host: judge_host ? judge_host : null };
    }

    function setJudgeBreakdownStatus(state, message) {
        const el = document.getElementById('judgeBreakdownStatus');
        if (!el) return;

        const spans = el.querySelectorAll('span');
        const dot = spans[0] || null;
        const text = spans[1] || null;

        const msg = message ? String(message) : '';
        if (text) text.textContent = msg ? `API: ${msg}` : 'API: idle';

        // Use existing theme primitives (no new hard-coded colors)
        let color = 'var(--muted)';
        if (state === 'ok') color = 'var(--accent)';
        if (state === 'warn') color = 'var(--accent-2)';
        if (dot) dot.style.background = color;

        el.style.borderColor = (state === 'error') ? 'rgba(255,255,255,0.12)' : 'var(--panel-border)';
    }

    function renderJudgeBreakdownTable({ groupBy, groups }) {
        const tbody = document.getElementById('judgeBreakdownBody');
        const thead = document.getElementById('judgeBreakdownHead');
        if (!tbody || !thead) return;

        const groupLabel = groupBy === 'model' ? 'Model' : 'Level';
        thead.innerHTML = `
            <tr>
                <th>${escapeHtml(groupLabel)}</th>
                <th>Evaluations</th>
                <th>Avg Judge Latency</th>
                <th>Success Rate</th>
                <th>Avg Score Given</th>
                <th>Avg Test Tokens</th>
            </tr>
        `;

        if (!Array.isArray(groups) || groups.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">No breakdown data available</td></tr>';
            renderJudgeBreakdownChart({ groupBy, groups: [] });
            renderJudgeBreakdownInsights({ groupBy, groups: [] });
            return;
        }

        tbody.innerHTML = groups.map(row => {
            const key = row.key === null || row.key === undefined ? 'N/A' : String(row.key);
            const count = Number(row.count) || 0;
            const avgLatencyMs = Number(row.avg_latency) || 0;
            const successRate = Number(row.success_rate) || 0;
            const avgScore = (row.avg_score_given === null || row.avg_score_given === undefined) ? null : Number(row.avg_score_given);
            const avgTokens = (row.avg_test_tokens === null || row.avg_test_tokens === undefined) ? null : Number(row.avg_test_tokens);

            return `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 12px 8px; font-weight: 600; color: var(--text);">${escapeHtml(key)}</td>
                    <td style="padding: 12px 8px; text-align: center;">${count}</td>
                    <td style="padding: 12px 8px; text-align: center;">${(avgLatencyMs / 1000).toFixed(2)}s</td>
                    <td style="padding: 12px 8px; text-align: center;">
                        <span style="color: ${successRate > 95 ? '#2ecc71' : successRate > 80 ? '#f1c40f' : '#e74c3c'}">${Math.round(successRate)}%</span>
                    </td>
                    <td style="padding: 12px 8px; text-align: center;">${avgScore === null || Number.isNaN(avgScore) ? '-' : avgScore.toFixed(1)}</td>
                    <td style="padding: 12px 8px; text-align: center;">${avgTokens === null || Number.isNaN(avgTokens) ? '-' : Math.round(avgTokens)}</td>
                </tr>
            `;
        }).join('');

        renderJudgeBreakdownChart({ groupBy, groups });
        renderJudgeBreakdownInsights({ groupBy, groups });
    }

    async function loadJudgeBreakdown() {
        const selectEl = document.getElementById('judgeBreakdownSelect');
        const groupByEl = document.getElementById('judgeBreakdownGroupBy');
        const sortEl = document.getElementById('judgeBreakdownSort');
        const tbody = document.getElementById('judgeBreakdownBody');
        const container = document.getElementById('judgeBreakdownContainer');
        if (!selectEl || !groupByEl || !tbody) return;

        const parsed = parseJudgeKey(selectEl.value);
        if (!parsed) {
            setJudgeBreakdownStatus('warn', 'select judge');
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">Select a judge to view breakdown</td></tr>';
            return;
        }

        const groupBy = groupByEl.value === 'model' ? 'model' : 'level';
        const sortBy = sortEl ? String(sortEl.value || 'count') : 'count';
        const params = new URLSearchParams({
            judge_model: parsed.judge_model,
            groupBy
        });
        if (parsed.judge_host) params.set('judge_host', parsed.judge_host);
        if (groupBy === 'model') params.set('limit', '25');

        try {
            if (container) container.style.display = 'block';
            setJudgeBreakdownStatus('warn', 'loading');
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">Loading breakdown...</td></tr>';
            const res = await fetch(`${BENCHMARK_API}/judge-breakdown?${params.toString()}`);
            const contentType = res.headers.get('content-type') || '';
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 180)}` : ''}`);
            }
            if (!contentType.includes('application/json')) {
                const text = await res.text().catch(() => '');
                // Common failure mode: API route missing → static HTML fallback
                if (text && text.trim().startsWith('<!DOCTYPE')) {
                    throw new Error('Server returned HTML instead of JSON (API route missing or server not restarted)');
                }
                throw new Error(`Unexpected content-type for breakdown: ${contentType || 'unknown'}`);
            }
            const payload = await res.json();
            const data = payload?.data;
            const effectiveGroupBy = data?.groupBy || groupBy;
            let groups = Array.isArray(data?.groups) ? data.groups : [];

            // Client-side sorting for a richer UX
            const sorter = {
                count: (a, b) => (Number(b.count) || 0) - (Number(a.count) || 0),
                latency: (a, b) => (Number(b.avg_latency) || 0) - (Number(a.avg_latency) || 0),
                tokens: (a, b) => (Number(b.avg_test_tokens) || 0) - (Number(a.avg_test_tokens) || 0),
                success: (a, b) => (Number(b.success_rate) || 0) - (Number(a.success_rate) || 0)
            };
            groups = [...groups].sort(sorter[sortBy] || sorter.count);

            renderJudgeBreakdownTable({ groupBy: effectiveGroupBy, groups });

            const groupsCount = Array.isArray(groups) ? groups.length : 0;
            setJudgeBreakdownStatus('ok', `ok • ${groupsCount} groups`);
        } catch (err) {
            console.error('Failed to load judge breakdown:', err);
            try {
                showToast(err?.message ? `Judge breakdown: ${err.message}` : 'Judge breakdown failed', 'error');
            } catch (_) {
                // ignore
            }

            const msg = (err?.message && String(err.message).includes('HTML instead of JSON'))
                ? 'HTML fallback'
                : 'error';
            setJudgeBreakdownStatus('error', msg);

            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">Failed to load breakdown</td></tr>';
            renderJudgeBreakdownChart({ groupBy, groups: [] });
            renderJudgeBreakdownInsights({ groupBy, groups: [] });
        }
    }

    async function refreshJudgeCompare() {
        persistJudgeSelections();
        renderChipList(
            'judgeCompareList',
            judgeSelections.map(sel => ({
                label: sel.judge_model,
                meta: sel.judge_host ? `@ ${sel.judge_host}` : '@ N/A'
            })),
            (idx) => {
                judgeSelections.splice(idx, 1);
                refreshJudgeCompare();
            }
        );

        const emptyEl = document.getElementById('judgeRadarEmpty');
        const ctx = document.getElementById('judgeRadarChart');
        if (!ctx) return;

        if (!judgeSelections.length) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (judgeRadarChart) {
                judgeRadarChart.destroy();
                judgeRadarChart = null;
            }
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        try {
            const leaderboard = judgeLeaderboardCache || (await (async () => {
                const res = await fetch(`${BENCHMARK_API}/judge-leaderboard`);
                const { data } = await res.json();
                judgeLeaderboardCache = data.leaderboard || [];
                populateJudgeCompareSelect(judgeLeaderboardCache);
                return judgeLeaderboardCache;
            })());

            const labels = ['Speed', 'Reliability', 'Diligence', 'Avg Score Given'];

            const datasets = judgeSelections.map((sel, idx) => {
                const row = leaderboard.find(j => j.judge_model === sel.judge_model && (j.judge_host || null) === (sel.judge_host || null));
                const avgLatency = row?.avg_latency || 0;
                const successRate = row?.success_rate || 0;
                const avgExplanationLen = row?.avg_explanation_len || 0;
                const avgScoreGiven = row?.avg_score_given || 0;

                const speedScore = Math.max(0, 100 - (avgLatency / 10000 * 100));
                const diligenceScore = Math.min(100, (avgExplanationLen / 500 * 100));
                const avgScorePct = Math.max(0, Math.min(100, (avgScoreGiven / 10) * 100));

                const c = getPaletteColor(idx);
                return {
                    label: `${sel.judge_model} @ ${sel.judge_host || 'N/A'}`,
                    data: [speedScore, successRate, diligenceScore, avgScorePct],
                    fill: true,
                    backgroundColor: c.bg,
                    borderColor: c.border,
                    pointBackgroundColor: c.border,
                    pointBorderColor: '#fff',
                    pointHoverBackgroundColor: '#fff',
                    pointHoverBorderColor: c.border
                };
            });

            if (judgeRadarChart) judgeRadarChart.destroy();
            judgeRadarChart = new Chart(ctx, {
                type: 'radar',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        r: {
                            angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' },
                            pointLabels: { color: '#fff', font: { size: 12, weight: 'bold' } },
                            ticks: {
                                backdropColor: 'transparent',
                                color: 'rgba(255, 255, 255, 0.5)',
                                min: 0,
                                max: 100,
                                stepSize: 20
                            },
                            suggestedMin: 0,
                            suggestedMax: 100
                        }
                    },
                    plugins: {
                        legend: { display: true, position: 'top', labels: { color: '#E0E7FF' } },
                        tooltip: {
                            backgroundColor: 'rgba(10, 14, 39, 0.9)',
                            titleColor: '#fff',
                            bodyColor: '#ccc',
                            borderColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            padding: 10,
                            callbacks: {
                                label: function(context) {
                                    return `${context.dataset.label}: ${context.raw.toFixed(0)} / 100`;
                                }
                            }
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Failed to refresh judge compare:', err);
            showToast('Failed to load judge compare data', 'error');
        }
    }

    /**
     * Compare multiple batches
     */
    async function compareBatches() {
        try {
            const checkbox1 = document.getElementById('compareBatch1')?.value;
            const checkbox2 = document.getElementById('compareBatch2')?.value;

            if (!checkbox1 || !checkbox2) {
                showToast('Please select two batches to compare', 'warning');
                return;
            }

            const res = await fetch(`${BENCHMARK_API}/compare-batches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_ids: [checkbox1, checkbox2] })
            });

            const { data } = await res.json();
            lastComparisonData = data;

            // Show export button
            const exportBtn = document.getElementById('exportComparisonBtn');
            if (exportBtn) exportBtn.style.display = 'inline-block';

            // Display comparison table
            const container = document.getElementById('comparisonResults');
            if (!container) return;

            container.innerHTML = `
                <div class="comparison-stats">
                    <div class="comparison-stat">
                        <div class="stat-label">Avg Duration</div>
                        <div class="stat-value">${formatDuration(data.stats.avg_duration_ms)}</div>
                    </div>
                    ${data.stats.fastest_batch ? `
                        <div class="comparison-stat">
                            <div class="stat-label">Fastest</div>
                            <div class="stat-value">${data.stats.fastest_batch.name}</div>
                            <small>${formatDuration(data.stats.fastest_batch.duration)}</small>
                        </div>
                    ` : ''}
                    ${data.stats.slowest_batch ? `
                        <div class="comparison-stat">
                            <div class="stat-label">Slowest</div>
                            <div class="stat-value">${data.stats.slowest_batch.name}</div>
                            <small>${formatDuration(data.stats.slowest_batch.duration)}</small>
                        </div>
                    ` : ''}
                </div>
                <table class="comparison-table">
                    <thead>
                        <tr>
                            <th>Metric</th>
                            ${data.comparison.map(b => `<th>${b.run_name}</th>`).join('')}
                            <th>Delta</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Total Tests</td>
                            ${data.comparison.map(b => `<td>${b.total_tests}</td>`).join('')}
                            <td>${calculateDelta(data.comparison, 'total_tests')}</td>
                        </tr>
                        <tr>
                            <td>Success Rate</td>
                            ${data.comparison.map(b => `<td>${b.success_rate}%</td>`).join('')}
                            <td class="${getDeltaClass(data.comparison, 'success_rate')}">
                                ${calculateDelta(data.comparison, 'success_rate')}%
                            </td>
                        </tr>
                        <tr>
                            <td>Avg Quality</td>
                            ${data.comparison.map(b => `<td>${b.avg_quality !== null ? b.avg_quality : 'N/A'}</td>`).join('')}
                            <td class="${getDeltaClass(data.comparison, 'avg_quality')}">
                                ${calculateDelta(data.comparison, 'avg_quality')}
                            </td>
                        </tr>
                        <tr>
                            <td>Avg Composite</td>
                            ${data.comparison.map(b => `<td>${b.avg_composite !== null ? b.avg_composite : 'N/A'}</td>`).join('')}
                            <td class="${getDeltaClass(data.comparison, 'avg_composite')}">
                                ${calculateDelta(data.comparison, 'avg_composite')}
                            </td>
                        </tr>
                        <tr>
                            <td>Duration</td>
                            ${data.comparison.map(b => `
                                <td>${b.execution_metrics?.total_duration_ms
                                    ? formatDuration(b.execution_metrics.total_duration_ms)
                                    : 'N/A'}</td>
                            `).join('')}
                            <td>${data.comparison[0].execution_metrics && data.comparison[1].execution_metrics
                                ? formatDuration(Math.abs(
                                    data.comparison[0].execution_metrics.total_duration_ms -
                                    data.comparison[1].execution_metrics.total_duration_ms
                                  ))
                                : 'N/A'}</td>
                        </tr>
                        <tr>
                            <td>Tests/min</td>
                            ${data.comparison.map(b => `
                                <td>${b.execution_metrics?.tests_per_minute || 'N/A'}</td>
                            `).join('')}
                            <td>${calculateDelta(data.comparison.map(b => ({
                                tests_per_minute: b.execution_metrics?.tests_per_minute || 0
                            })), 'tests_per_minute')}</td>
                        </tr>
                    </tbody>
                </table>
            `;

            container.style.display = 'block';
        } catch (err) {
            console.error('Failed to compare batches:', err);
            showToast('Failed to compare batches', 'error');
        }
    }

    /**
     * Export comparison data as CSV
     */
    function exportComparisonCSV() {
        if (!lastComparisonData || !lastComparisonData.comparison) {
            showToast('No comparison data to export', 'warning');
            return;
        }

        const data = lastComparisonData.comparison;
        const headers = ['Metric', ...data.map(b => b.run_name), 'Delta'];
        const rows = [];

        // Helper to get delta
        const getDelta = (field) => calculateDelta(data, field);

        // Total Tests
        rows.push(['Total Tests', ...data.map(b => b.total_tests), getDelta('total_tests')]);
        
        // Success Rate
        rows.push(['Success Rate', ...data.map(b => b.success_rate + '%'), getDelta('success_rate') + '%']);
        
        // Avg Quality
        rows.push(['Avg Quality', ...data.map(b => b.avg_quality !== null ? b.avg_quality : 'N/A'), getDelta('avg_quality')]);
        
        // Avg Composite
        rows.push(['Avg Composite', ...data.map(b => b.avg_composite !== null ? b.avg_composite : 'N/A'), getDelta('avg_composite')]);
        
        // Duration
        rows.push(['Duration', ...data.map(b => b.execution_metrics?.total_duration_ms ? formatDuration(b.execution_metrics.total_duration_ms) : 'N/A'), 
            data[0].execution_metrics && data[1].execution_metrics 
                ? formatDuration(Math.abs(data[0].execution_metrics.total_duration_ms - data[1].execution_metrics.total_duration_ms)) 
                : 'N/A'
        ]);

        // Tests/min
        rows.push(['Tests/min', ...data.map(b => b.execution_metrics?.tests_per_minute || 'N/A'), 
            calculateDelta(data.map(b => ({ tests_per_minute: b.execution_metrics?.tests_per_minute || 0 })), 'tests_per_minute')
        ]);

        // Convert to CSV
        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        // Download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `benchmark_comparison_${new Date().toISOString().slice(0,10)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * Load tag statistics
     */
    async function loadTagStats() {
        try {
            const res = await fetch(`${BENCHMARK_API}/stats-by-tag`);
            const { data } = await res.json();

            const container = document.getElementById('tagStatsContainer');
            if (!container) return;

            if (data.tags.length === 0) {
                container.innerHTML = '<p class="no-data">No tagged batches yet</p>';
                return;
            }

            container.innerHTML = `
                <div class="tag-chips">
                    ${data.tags.map(tag => {
                        const isActive = currentFilters.tag === tag.tag;
                        return `
                        <div class="tag-chip ${isActive ? 'active' : ''}" 
                             data-tag="${tag.tag}"
                             onclick="BenchmarkAnalytics.filterByTag('${tag.tag}')"
                             style="${isActive ? 'border-color: var(--accent); background: rgba(124, 240, 255, 0.1);' : ''}">
                            <span class="tag-name">${tag.tag}</span>
                            <span class="tag-count">${tag.count}</span>
                            <div class="tag-details">
                                <small>✓ ${tag.completed} completed</small>
                                <small>⚡ ${tag.avg_success_rate} success</small>
                            </div>
                        </div>
                    `}).join('')}
                </div>
            `;
        } catch (err) {
            console.error('Failed to load tag stats:', err);
        }
    }

    /**
     * Filter batches by tag
     */
    function filterByTag(tag) {
        currentFilters.tag = tag;
        showToast(`Filtering by tag: ${tag}`, 'info');
        if (window.loadDashboard) window.loadDashboard();
    }

    function filterByModelCategory(category) {
        currentFilters.modelCategory = category || null;
        if (window.loadDashboard) window.loadDashboard();
    }

    function filterByPromptCategory(category) {
        currentFilters.promptCategory = category || null;
        if (window.loadDashboard) window.loadDashboard();
    }

    function getActiveFilters() {
        return currentFilters;
    }

    function clearAllFilters() {
        currentFilters = { modelCategory: null, promptCategory: null, tag: null, sort: 'composite' };
        const modelFilter = document.getElementById('modelCategoryFilter');
        if (modelFilter) modelFilter.value = '';
        const promptFilter = document.getElementById('promptCategoryFilter');
        if (promptFilter) promptFilter.value = '';
        if (window.loadDashboard) window.loadDashboard();
    }

    /**
     * Calculate delta between two values
     */
    function calculateDelta(items, field) {
        if (items.length < 2) return '0';
        const val1 = parseFloat(items[0][field]) || 0;
        const val2 = parseFloat(items[1][field]) || 0;
        const delta = val2 - val1;
        return delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    }

    /**
     * Get CSS class for delta (positive/negative)
     */
    function getDeltaClass(items, field) {
        const delta = calculateDelta(items, field);
        const val = parseFloat(delta);
        if (val > 0) return 'delta-positive';
        if (val < 0) return 'delta-negative';
        return '';
    }

    /**
     * Format duration in ms to human readable
     */
    function formatDuration(ms) {
        if (!ms) return 'N/A';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Show toast notification
     */
    function showToast(message, type = 'info') {
        // Try to use existing toast if available
        if (window.Toast && typeof window.Toast.show === 'function') {
            window.Toast.show(message, type);
            return;
        }

        // Fallback to simple alert
        console.log(`[${type.toUpperCase()}] ${message}`);

        // Create simple toast element
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${type === 'success' ? '#00FF9F' : type === 'error' ? '#FF6B9D' : '#7CF0FF'};
            color: #0A0E27;
            border-radius: 8px;
            font-weight: 600;
            z-index: 10000;
            animation: slideIn 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Load Judge Leaderboard and Stats
     */
    async function loadJudgeStats() {
        try {
            const res = await fetch(`${BENCHMARK_API}/judge-leaderboard`);
            const { data } = await res.json();
            
            const { leaderboard, activity } = data;

            judgeLeaderboardCache = leaderboard || [];
            populateJudgeCompareSelect(judgeLeaderboardCache);
            populateJudgeBreakdownSelect(judgeLeaderboardCache);

            // 1. Render Leaderboard Table
            const tableBody = document.getElementById('judgeLeaderboardBody');
            const container = document.getElementById('judgeLeaderboardContainer');
            
            if (container) container.style.display = 'block';

            if (tableBody) {
                if (leaderboard.length === 0) {
                    tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">No judge data available</td></tr>';
                } else {
                    tableBody.innerHTML = leaderboard.map(judge => {
                        // Calculate "Gavel Score" (Composite)
                        // Speed (0-100, lower is better, cap at 10s)
                        const speedScore = Math.max(0, 100 - (judge.avg_latency / 10000 * 100));
                        // Reliability (0-100)
                        const reliabilityScore = judge.success_rate;
                        // Diligence (0-100, cap at 500 chars)
                        const diligenceScore = Math.min(100, (judge.avg_explanation_len / 500 * 100));
                        
                        const gavelScore = Math.round((speedScore * 0.3) + (reliabilityScore * 0.5) + (diligenceScore * 0.2));
                        
                        return `
                            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <td style="padding: 12px 8px;">
                                    <div style="font-weight: 600; color: var(--text);">${judge.judge_model}</div>
                                    <div style="font-size: 0.8em; color: var(--muted);" title="Composite score: Speed (30%) + Reliability (50%) + Diligence (20%)">
                                        Gavel Score: <span style="color: var(--accent);">${gavelScore}</span>
                                    </div>
                                </td>
                                <td style="padding: 12px 8px; font-size: 0.9em; color: var(--muted);">${judge.judge_host || 'N/A'}</td>
                                <td style="padding: 12px 8px; text-align: center;">${judge.count}</td>
                                <td style="padding: 12px 8px; text-align: center;">
                                    ${(judge.avg_latency / 1000).toFixed(2)}s
                                </td>
                                <td style="padding: 12px 8px; text-align: center;">
                                    <span style="color: ${judge.success_rate > 95 ? '#2ecc71' : judge.success_rate > 80 ? '#f1c40f' : '#e74c3c'}">
                                        ${Math.round(judge.success_rate)}%
                                    </span>
                                </td>
                                <td style="padding: 12px 8px; text-align: center;">
                                    ${judge.avg_score_given.toFixed(1)}
                                </td>
                            </tr>
                        `;
                    }).join('');
                }
            }

            // 2. Render Activity Feed
            const feedContainer = document.getElementById('judgeActivityFeed');
            if (feedContainer) {
                if (activity.length === 0) {
                    feedContainer.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 10px;">No recent activity</div>';
                } else {
                    feedContainer.innerHTML = activity.map(act => {
                        const timeAgo = Math.round((Date.now() - new Date(act.timestamp).getTime()) / 1000);
                        const timeText = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.round(timeAgo/60)}m ago`;
                        return `
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: rgba(255,255,255,0.03); border-radius: 4px;">
                                <div>
                                    <div style="color: var(--text); font-weight: 500;">${act.judge_model} <span style="color: var(--muted); font-weight: 400;">judged</span> ${act.model}</div>
                                    <div style="color: var(--muted); font-size: 0.9em;">${act.prompt_category || 'general'} • ${(act.scoring_time_ms/1000).toFixed(1)}s</div>
                                </div>
                                <div style="text-align: right;">
                                    <div style="font-weight: 700; color: ${act.quality_score >= 8 ? '#2ecc71' : act.quality_score >= 5 ? '#f1c40f' : '#e74c3c'};">
                                        ${act.quality_score !== null ? act.quality_score.toFixed(1) : '-'}
                                    </div>
                                    <div style="color: var(--muted); font-size: 0.8em;">${timeText}</div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }

            // 3. Render Strictness Chart (using the most active judge)
            if (leaderboard.length > 0) {
                const topJudge = leaderboard[0];
                const ctx = document.getElementById('judgeStrictnessChart');
                
                if (ctx) {
                    if (judgeStrictnessChart) {
                        judgeStrictnessChart.destroy();
                    }

                    const dist = topJudge.score_distribution || {};
                    const labels = ['0-2', '2-4', '4-6', '6-8', '8-10'];
                    const data = labels.map(l => dist[l] || 0);

                    judgeStrictnessChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: labels,
                            datasets: [{
                                label: `Score Dist (${topJudge.judge_model})`,
                                data: data,
                                backgroundColor: 'rgba(124, 240, 255, 0.5)',
                                borderColor: '#7CF0FF',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false },
                                tooltip: {
                                    callbacks: {
                                        title: () => `Judge: ${topJudge.judge_model}`
                                    }
                                }
                            },
                            scales: {
                                y: {
                                    beginAtZero: true,
                                    grid: { color: 'rgba(255,255,255,0.05)' },
                                    ticks: { color: '#888' }
                                },
                                x: {
                                    grid: { display: false },
                                    ticks: { color: '#888' }
                                }
                            }
                        }
                    });
                }
            }

            // 4. Render breakdown for selected (or top) judge
            await loadJudgeBreakdown();

        } catch (err) {
            console.error('Failed to load judge stats:', err);
        }
    }

    /**
     * Load batch history for dropdowns
     */
    async function loadBatchHistory() {
        try {
            const res = await fetch(`${BENCHMARK_API}/batches?limit=50`);
            const json = await res.json();
            const batches = json.data?.batches || []; 

            const populate = (id) => {
                const el = document.getElementById(id);
                if (!el) return;
                const current = el.value;
                el.innerHTML = '<option value="">Select batch...</option>' + 
                    batches.map(b => `<option value="${b._id}">${b.run_name || 'Batch ' + b._id.substring(0,8)} (${new Date(b.started_at).toLocaleString()})</option>`).join('');
                if (current) el.value = current;
            };

            populate('compareBatch1');
            populate('compareBatch2');
            populate('timelineBatchSelect');

        } catch (err) {
            console.error('Failed to load batch history:', err);
        }
    }

    let timelineChartInstance = null;

    /**
     * Load and render execution timeline for a batch
     */
    async function loadTimeline(batchId) {
        const container = document.getElementById('timelineContainer');
        const emptyState = document.getElementById('timelineEmptyState');
        const canvas = document.getElementById('timelineChart');

        if (!batchId) {
            if (container) container.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/batch/${batchId}/timeline`);
            const json = await res.json();
            
            if (!json.data || !json.data.timeline) {
               throw new Error('No timeline data found');
            }
            
            const timeline = json.data.timeline;

            if (container) container.style.display = 'block';
            if (emptyState) emptyState.style.display = 'none';

            if (!canvas) return;

            // Filter for completed tests and judges which have duration
            const tasks = timeline.filter(e => (e.event === 'test_complete' || e.event === 'judge_complete') && e.duration_ms);
            
            // Create data points [start, end]
            const chartData = tasks.map((t, index) => {
                const end = t.time_since_start_ms;
                const start = Math.max(0, end - t.duration_ms);
                // Use prompt text or ID for label if available, otherwise generic
                let label = `Task ${index + 1}`;
                if (t.event === 'judge_complete') label += ' (Judge)';
                
                return {
                    x: [start, end],
                    y: label, 
                    type: t.event === 'test_complete' ? 'Test' : 'Judge',
                    details: t
                };
            });

            if (timelineChartInstance) {
                timelineChartInstance.destroy();
            }

            timelineChartInstance = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: chartData.map(d => d.y),
                    datasets: [
                        {
                            label: 'Execution Duration',
                            data: chartData.map(d => d.x),
                            backgroundColor: chartData.map(d => d.type === 'Test' ? 'rgba(124, 240, 255, 0.6)' : 'rgba(255, 107, 157, 0.6)'),
                            borderColor: chartData.map(d => d.type === 'Test' ? '#7CF0FF' : '#FF6B9D'),
                            borderWidth: 1,
                            borderSkipped: false,
                            barPercentage: 0.8,
                            categoryPercentage: 0.8
                        }
                    ]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const raw = context.raw; // [start, end]
                                    const duration = raw[1] - raw[0];
                                    const item = chartData[context.dataIndex];
                                    return `${item.type}: ${duration.toFixed(0)}ms (Start: ${raw[0].toFixed(0)}ms)`;
                                }
                            }
                        },
                        title: {
                            display: true,
                            text: `Timeline - ${json.data.batch_id}`,
                            color: '#E0E7FF'
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            position: 'bottom',
                            title: { display: true, text: 'Time since start (ms)', color: '#94A3B8' },
                            ticks: { color: '#94A3B8' },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' },
                            min: 0
                        },
                        y: {
                            ticks: { 
                                color: '#E0E7FF',
                                font: { size: 10 }
                            },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        }
                    }
                }
            });

        } catch (err) {
            console.error('Failed to load timeline:', err);
            // Don't overwrite container if it failed, just log
        }
    }

    // ===============================================
    // RESPONSIVE HELPERS
    // ===============================================

    function setupResponsiveHelpers() {
        // Detect screen types
        const isMobile = window.matchMedia('(max-width: 767px)').matches;
        const isTouch = 'ontouchstart' in window;
        const isUltraWide = window.matchMedia('(min-width: 1920px)').matches;

        // Add device classes to body
        if (isMobile || isTouch) {
            document.body.classList.add('is-mobile');
        }
        if (isUltraWide) {
            document.body.classList.add('is-ultra-wide');
        }

        // Mobile-specific enhancements
        if (isMobile) {
            // Add swipe hints for scrollable tables
            const tables = document.querySelectorAll('.comparison-table');
            tables.forEach(table => {
                if (table.scrollWidth > table.clientWidth) {
                    const hint = document.createElement('div');
                    hint.className = 'mobile-scroll-hint';
                    hint.innerHTML = '<i class="fa-solid fa-chevron-right"></i> Swipe to see more';
                    hint.style.cssText = `
                        position: sticky;
                        left: 0;
                        padding: 8px 12px;
                        background: rgba(124, 240, 255, 0.1);
                        border: 1px solid rgba(124, 240, 255, 0.3);
                        border-radius: 6px;
                        font-size: 0.8rem;
                        color: var(--accent);
                        margin: 10px 0;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        animation: pulse 2s infinite;
                    `;

                    table.parentElement.insertBefore(hint, table);

                    // Hide hint after first scroll
                    table.addEventListener('scroll', () => {
                        hint.style.display = 'none';
                    }, { once: true });
                }
            });

            // Pull-to-refresh gesture
            let touchStartY = 0;
            document.addEventListener('touchstart', (e) => {
                touchStartY = e.touches[0].clientY;
            });

            document.addEventListener('touchmove', (e) => {
                const touchY = e.touches[0].clientY;
                const touchDiff = touchY - touchStartY;

                // If pulling down at top of page
                if (window.scrollY === 0 && touchDiff > 100) {
                    const hint = document.getElementById('pull-refresh-hint');
                    if (!hint) {
                        const refreshHint = document.createElement('div');
                        refreshHint.id = 'pull-refresh-hint';
                        refreshHint.innerHTML = '<i class="fa-solid fa-arrow-down"></i> Release to refresh';
                        refreshHint.style.cssText = `
                            position: fixed;
                            top: 20px;
                            left: 50%;
                            transform: translateX(-50%);
                            padding: 10px 20px;
                            background: var(--accent);
                            color: #000;
                            border-radius: 20px;
                            font-size: 0.9rem;
                            font-weight: 600;
                            z-index: 9999;
                            animation: bounceIn 0.3s ease;
                        `;
                        document.body.appendChild(refreshHint);
                    }
                }
            });

            document.addEventListener('touchend', () => {
                const hint = document.getElementById('pull-refresh-hint');
                if (hint) {
                    hint.remove();
                    window.location.reload();
                }
            });
        }

        // Viewport height fix for mobile browsers
        const setVH = () => {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
        };

        setVH();
        window.addEventListener('resize', setVH);
        window.addEventListener('orientationchange', setVH);

        // Prevent double-tap zoom on touch devices
        if (isTouch) {
            document.querySelectorAll('.btn, .preset-card, .tag-chip').forEach(el => {
                el.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    el.click();
                }, { passive: false });
            });
        }

        // Ultra-wide screen optimizations
        if (isUltraWide) {
            // Add expand button for comparison table
            const comparisonTables = document.querySelectorAll('.comparison-table');
            comparisonTables.forEach(table => {
                const container = table.closest('.comparison-section');
                if (container && !container.querySelector('.expand-table-btn')) {
                    const expandBtn = document.createElement('button');
                    expandBtn.className = 'btn btn-sm expand-table-btn';
                    expandBtn.innerHTML = '<i class="fa-solid fa-expand"></i> Expand';
                    expandBtn.style.cssText = 'position: absolute; top: 10px; right: 10px; z-index: 10;';

                    expandBtn.addEventListener('click', () => {
                        container.classList.toggle('expanded');
                        if (container.classList.contains('expanded')) {
                            container.style.maxWidth = '100%';
                            expandBtn.innerHTML = '<i class="fa-solid fa-compress"></i> Compress';
                        } else {
                            container.style.maxWidth = '';
                            expandBtn.innerHTML = '<i class="fa-solid fa-expand"></i> Expand';
                        }
                    });

                    container.style.position = 'relative';
                    container.appendChild(expandBtn);
                }
            });
        }

        console.log('🎸 Benchmark responsive helpers loaded!');
        console.log(`📱 Screen: ${window.innerWidth}x${window.innerHeight}`);
        console.log(`📱 Mobile: ${isMobile}, Touch: ${isTouch}, Ultra-Wide: ${isUltraWide}`);
    }

    // Public API
    return {
        init,
        applyPreset,
        loadTrends,
        loadActiveStats,
        loadTagStats,
        loadJudgeStats,
        loadCapabilityAnalysis,
        compareBatches,
        stopActiveMonitoring,
        filterByModelCategory,
        filterByPromptCategory,
        filterByTag,
        getActiveFilters,
        clearAllFilters,
        showToast,
        setupResponsiveHelpers
    };
})();

// Keep existing global API for inline onclick handlers
window.BenchmarkAnalytics = BenchmarkAnalytics;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        BenchmarkAnalytics.init();
        BenchmarkAnalytics.setupResponsiveHelpers();
    });
} else {
    BenchmarkAnalytics.init();
    BenchmarkAnalytics.setupResponsiveHelpers();
}
