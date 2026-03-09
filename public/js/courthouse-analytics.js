/**
 * Courthouse Analytics Module
 * Judge performance analytics extracted from benchmark-analytics.js
 * Provides judge leaderboard, radar comparison, and breakdown analysis
 */

const CourthouseAnalytics = (() => {
    // Disable Chart.js animations globally
    if (typeof Chart !== 'undefined') {
        Chart.defaults.animation = false;
        Chart.defaults.animations = { colors: false, x: false };
        Chart.defaults.transitions = { active: { animation: { duration: 0 } } };
    }

    const BENCHMARK_API = '/api/benchmark';

    // Judge breakdown chart
    let judgeBreakdownChart = null;

    // Compare charts
    let judgeRadarChart = null;

    // Compare selections
    const judgeSelections = []; // { judge_model, judge_host }

    // Cache
    let judgeLeaderboardCache = null;

    const STORAGE_KEYS = {
        judges: 'agentx_courthouse_judge_compare_v1'
    };

    /**
     * Initialize courthouse analytics
     */
    function init() {
        restoreCompareSelections();
        loadJudgeStats();
        setupEventListeners();
        setupJudgeCompareUI();
        setupValidationListeners();
        loadTierCompatibility();
    }

    function restoreCompareSelections() {
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

    function persistJudgeSelections() {
        try {
            localStorage.setItem(STORAGE_KEYS.judges, JSON.stringify(judgeSelections));
        } catch (_) {
            // ignore
        }
    }

    function setupEventListeners() {
        // Judge breakdown controls
        const breakdownSelect = document.getElementById('judgeBreakdownSelect');
        const breakdownGroupBy = document.getElementById('judgeBreakdownGroupBy');
        const breakdownSort = document.getElementById('judgeBreakdownSort');
        const breakdownRefresh = document.getElementById('judgeBreakdownRefreshBtn');
        if (breakdownSelect) breakdownSelect.addEventListener('change', () => loadJudgeBreakdown());
        if (breakdownGroupBy) breakdownGroupBy.addEventListener('change', () => loadJudgeBreakdown());
        if (breakdownSort) breakdownSort.addEventListener('change', () => loadJudgeBreakdown());
        if (breakdownRefresh) breakdownRefresh.addEventListener('click', () => loadJudgeBreakdown());
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

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
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

        container.onclick = (e) => {
            const btn = e.target.closest('.compare-chip-remove');
            if (!btn) return;
            const chip = e.target.closest('.compare-chip');
            const idxStr = chip?.dataset?.idx;
            const idx = idxStr ? parseInt(idxStr, 10) : -1;
            if (Number.isFinite(idx) && idx >= 0) onRemove(idx);
        };
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
                animation: false,
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

    function populateJudgeCompareSelect(leaderboard) {
        const container = document.getElementById('judgeCompareContainer');
        const selectEl = document.getElementById('judgeCompareSelect');
        if (!selectEl) return;

        if (!leaderboard || leaderboard.length === 0) {
            selectEl.innerHTML = '<option value="">No judges available</option>';
            return;
        }

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
            return;
        }

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
                if (text && text.trim().startsWith('<!DOCTYPE')) {
                    throw new Error('Server returned HTML instead of JSON (API route missing or server not restarted)');
                }
                throw new Error(`Unexpected content-type for breakdown: ${contentType || 'unknown'}`);
            }
            const payload = await res.json();
            const data = payload?.data;
            const effectiveGroupBy = data?.groupBy || groupBy;
            let groups = Array.isArray(data?.groups) ? data.groups : [];

            // Client-side sorting
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
            showToast(err?.message ? `Judge breakdown: ${err.message}` : 'Judge breakdown failed', 'error');

            const msg = (err?.message && String(err.message).includes('HTML instead of JSON'))
                ? 'HTML fallback'
                : 'error';
            setJudgeBreakdownStatus('error', msg);

            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">Failed to load breakdown</td></tr>';
            renderJudgeBreakdownChart({ groupBy: 'level', groups: [] });
            renderJudgeBreakdownInsights({ groupBy: 'level', groups: [] });
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
                    animation: false,
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
     * Load Judge Leaderboard and Stats
     */
    async function loadJudgeStats() {
        try {
            const res = await fetch(`${BENCHMARK_API}/judge-leaderboard`);
            const { data } = await res.json();

            const { leaderboard } = data;

            judgeLeaderboardCache = leaderboard || [];
            populateJudgeCompareSelect(judgeLeaderboardCache);
            populateJudgeBreakdownSelect(judgeLeaderboardCache);

            // Update summary stats
            if (leaderboard && leaderboard.length > 0) {
                const totalEvals = leaderboard.reduce((sum, j) => sum + (j.count || 0), 0);
                const avgLatency = leaderboard.reduce((sum, j) => sum + (j.avg_latency || 0), 0) / leaderboard.length;
                const avgSuccess = leaderboard.reduce((sum, j) => sum + (j.success_rate || 0), 0) / leaderboard.length;

                const statTotalEl = document.getElementById('statTotalEvaluations');
                const statJudgesEl = document.getElementById('statActiveJudges');
                const statLatencyEl = document.getElementById('statAvgLatency');
                const statSuccessEl = document.getElementById('statOverallSuccess');

                if (statTotalEl) statTotalEl.textContent = totalEvals.toLocaleString();
                if (statJudgesEl) statJudgesEl.textContent = leaderboard.length;
                if (statLatencyEl) statLatencyEl.textContent = `${(avgLatency / 1000).toFixed(1)}s`;
                if (statSuccessEl) statSuccessEl.textContent = `${Math.round(avgSuccess)}%`;
            }

            // Render Leaderboard Table
            const tableBody = document.getElementById('judgeLeaderboardBody');

            if (tableBody) {
                if (leaderboard.length === 0) {
                    tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">No judge data available</td></tr>';
                } else {
                    tableBody.innerHTML = leaderboard.map(judge => {
                        // Calculate "Gavel Score" (Composite)
                        const speedScore = Math.max(0, 100 - (judge.avg_latency / 10000 * 100));
                        const reliabilityScore = judge.success_rate;
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
                                    ${judge.avg_latency != null ? (judge.avg_latency / 1000).toFixed(2) + 's' : 'N/A'}
                                </td>
                                <td style="padding: 12px 8px; text-align: center;">
                                    <span style="color: ${(judge.success_rate || 0) > 95 ? '#2ecc71' : (judge.success_rate || 0) > 80 ? '#f1c40f' : '#e74c3c'}">
                                        ${judge.success_rate != null ? Math.round(judge.success_rate) + '%' : 'N/A'}
                                    </span>
                                </td>
                                <td style="padding: 12px 8px; text-align: center;">
                                    ${judge.avg_score_given != null ? judge.avg_score_given.toFixed(1) : 'N/A'}
                                </td>
                            </tr>
                        `;
                    }).join('');
                }
            }

            // Load breakdown for selected (or top) judge
            await loadJudgeBreakdown();

        } catch (err) {
            console.error('Failed to load judge stats:', err);
            showToast('Failed to load judge statistics', 'error');
        }
    }

    /**
     * Show toast notification
     */
    function showToast(message, type = 'info') {
        console.log(`[${type.toUpperCase()}] ${message}`);

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

    // ============ Validation Functions ============

    // Charts for validation
    let calibrationHistogramChart = null;
    let lengthBiasChart = null;
    let formatBiasChart = null;
    let failureReasonsChart = null;
    let failuresByCategoryChart = null;

    /**
     * Setup validation event listeners
     */
    function setupValidationListeners() {
        // Tab switching
        document.querySelectorAll('.validation-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.validation-tab').forEach(t => {
                    t.classList.remove('active');
                    t.style.background = 'transparent';
                    t.style.color = 'var(--muted)';
                });
                tab.classList.add('active');
                tab.style.background = 'rgba(124, 240, 255, 0.1)';
                tab.style.color = 'var(--accent)';

                document.querySelectorAll('.validation-tab-content').forEach(c => c.style.display = 'none');
                const tabId = tab.dataset.tab + 'Tab';
                const content = document.getElementById(tabId);
                if (content) content.style.display = 'block';
            });
        });

        // Health check button
        const healthBtn = document.getElementById('runHealthCheckBtn');
        if (healthBtn) healthBtn.addEventListener('click', runHealthCheck);

        // Consistency test button
        const consistencyBtn = document.getElementById('runConsistencyBtn');
        if (consistencyBtn) consistencyBtn.addEventListener('click', runConsistencyTest);

        // Bias detection button
        const biasBtn = document.getElementById('runBiasBtn');
        if (biasBtn) biasBtn.addEventListener('click', runBiasDetection);

        // Calibration button
        const calibrationBtn = document.getElementById('runCalibrationBtn');
        if (calibrationBtn) calibrationBtn.addEventListener('click', runCalibrationAnalysis);
    }

    /**
     * Run comprehensive health check
     */
    async function runHealthCheck() {
        const btn = document.getElementById('runHealthCheckBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/health`);
            const { data } = await res.json();

            // Update health stats
            const healthScore = document.getElementById('healthScore');
            const healthConsistency = document.getElementById('healthConsistency');
            const healthCalibration = document.getElementById('healthCalibration');
            const healthFailureRate = document.getElementById('healthFailureRate');

            if (healthScore) {
                healthScore.textContent = data.overall?.health_score ?? '-';
                healthScore.style.color = data.overall?.health_score >= 80 ? '#2ecc71' :
                    data.overall?.health_score >= 60 ? '#f1c40f' : '#e74c3c';
            }

            if (healthConsistency) {
                const stdDev = data.consistency?.avg_std_dev;
                healthConsistency.textContent = stdDev !== undefined ? stdDev.toFixed(3) : '-';
                if (stdDev !== undefined) {
                    healthConsistency.style.color = stdDev < 0.3 ? '#2ecc71' : stdDev < 0.5 ? '#f1c40f' : '#e74c3c';
                }
            }

            if (healthCalibration) {
                healthCalibration.textContent = data.calibration?.calibration_grade ?? '-';
            }

            if (healthFailureRate) {
                const rate = data.failures?.failure_rate;
                healthFailureRate.textContent = rate !== undefined ? rate.toFixed(1) + '%' : '-';
                if (rate !== undefined) {
                    healthFailureRate.style.color = rate < 5 ? '#2ecc71' : rate < 15 ? '#f1c40f' : '#e74c3c';
                }
            }

            // Show issues if any
            const issuesContainer = document.getElementById('healthIssues');
            const issuesList = document.getElementById('healthIssuesList');
            if (issuesContainer && issuesList) {
                if (data.overall?.issues?.length > 0) {
                    issuesContainer.style.display = 'block';
                    issuesList.innerHTML = data.overall.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('');
                } else {
                    issuesContainer.style.display = 'none';
                }
            }

            showToast(`Health check complete: ${data.overall?.status || 'unknown'}`,
                data.overall?.status === 'healthy' ? 'success' : 'warning');

            // Also populate failures tab if data available
            if (data.failures) {
                populateFailuresTab(data.failures);
            }

        } catch (err) {
            console.error('Health check failed:', err);
            showToast('Health check failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-stethoscope"></i> Run Health Check';
            }
        }
    }

    /**
     * Run consistency test
     */
    async function runConsistencyTest() {
        const btn = document.getElementById('runConsistencyBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/validate/consistency`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sampleSize: 10, repeats: 3 })
            });
            const { data } = await res.json();

            const placeholder = document.getElementById('consistencyPlaceholder');
            const results = document.getElementById('consistencyResults');
            if (placeholder) placeholder.style.display = 'none';
            if (results) results.style.display = 'block';

            // Update stats
            const avgStdDev = document.getElementById('consistencyAvgStdDev');
            const maxStdDev = document.getElementById('consistencyMaxStdDev');
            const score = document.getElementById('consistencyScore');
            const pass = document.getElementById('consistencyPass');

            if (avgStdDev) avgStdDev.textContent = data.summary?.avg_std_dev?.toFixed(3) ?? '-';
            if (maxStdDev) maxStdDev.textContent = data.summary?.max_std_dev?.toFixed(3) ?? '-';
            if (score) score.textContent = data.summary?.consistency_score?.toFixed(1) ?? '-';
            if (pass) {
                pass.textContent = data.summary?.pass ? 'PASS' : 'FAIL';
                pass.style.color = data.summary?.pass ? '#2ecc71' : '#e74c3c';
            }

            // Populate table
            const tbody = document.getElementById('consistencyTableBody');
            if (tbody && data.details) {
                tbody.innerHTML = data.details.map(d => `
                    <tr>
                        <td style="padding: 8px;">${escapeHtml(d.prompt_name || 'N/A')}</td>
                        <td style="padding: 8px;">${escapeHtml(d.category || 'N/A')}</td>
                        <td style="padding: 8px; text-align: center;">${d.original_score?.toFixed(1) ?? '-'}</td>
                        <td style="padding: 8px;">${d.scores?.map(s => s.toFixed(1)).join(', ') || '-'}</td>
                        <td style="padding: 8px; text-align: center;">${d.mean?.toFixed(2) ?? '-'}</td>
                        <td style="padding: 8px; text-align: center; color: ${d.stdDev < 0.3 ? '#2ecc71' : d.stdDev < 0.5 ? '#f1c40f' : '#e74c3c'}">
                            ${d.stdDev?.toFixed(3) ?? '-'}
                        </td>
                    </tr>
                `).join('');
            }

            showToast('Consistency test complete', 'success');

        } catch (err) {
            console.error('Consistency test failed:', err);
            showToast('Consistency test failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-random"></i> Test Consistency';
            }
        }
    }

    /**
     * Run bias detection
     */
    async function runBiasDetection() {
        const btn = document.getElementById('runBiasBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/validate/bias?sampleSize=100`);
            const { data } = await res.json();

            const placeholder = document.getElementById('biasPlaceholder');
            const results = document.getElementById('biasResults');
            if (placeholder) placeholder.style.display = 'none';
            if (results) results.style.display = 'block';

            // Update stats
            const samplesEl = document.getElementById('biasSamplesAnalyzed');
            const lengthEl = document.getElementById('biasLengthDetected');
            const modelsEl = document.getElementById('biasModelsAnalyzed');

            if (samplesEl) samplesEl.textContent = data.summary?.samples_analyzed ?? '-';
            if (lengthEl) {
                lengthEl.textContent = data.summary?.length_bias_detected ? 'Detected' : 'Minimal';
                lengthEl.style.color = data.summary?.length_bias_detected ? '#e74c3c' : '#2ecc71';
            }
            if (modelsEl) modelsEl.textContent = data.summary?.models_analyzed ?? '-';

            // Length bias chart
            if (data.length_bias) {
                const ctx = document.getElementById('lengthBiasChart');
                if (ctx) {
                    if (lengthBiasChart) lengthBiasChart.destroy();
                    const labels = Object.keys(data.length_bias);
                    const scores = labels.map(l => data.length_bias[l]?.avg_score || 0);
                    lengthBiasChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [{
                                label: 'Avg Score',
                                data: scores,
                                backgroundColor: 'rgba(124, 240, 255, 0.4)',
                                borderColor: '#7CF0FF',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                y: { beginAtZero: true, max: 10, ticks: { color: '#888' } },
                                x: { ticks: { color: '#888' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }

            // Format bias chart
            if (data.format_bias) {
                const ctx = document.getElementById('formatBiasChart');
                if (ctx) {
                    if (formatBiasChart) formatBiasChart.destroy();
                    const labels = Object.keys(data.format_bias);
                    const scores = labels.map(l => data.format_bias[l]?.avg_score || 0);
                    formatBiasChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: labels.map(l => l.replace(/_/g, ' ')),
                            datasets: [{
                                label: 'Avg Score',
                                data: scores,
                                backgroundColor: 'rgba(0, 255, 159, 0.4)',
                                borderColor: '#00FF9F',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                y: { beginAtZero: true, max: 10, ticks: { color: '#888' } },
                                x: { ticks: { color: '#888' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }

            // Recommendations
            const recList = document.getElementById('biasRecommendationsList');
            if (recList && data.recommendations) {
                recList.innerHTML = data.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('');
            }

            showToast('Bias detection complete', 'success');

        } catch (err) {
            console.error('Bias detection failed:', err);
            showToast('Bias detection failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-balance-scale-left"></i> Detect Bias';
            }
        }
    }

    /**
     * Run calibration analysis
     */
    async function runCalibrationAnalysis() {
        const btn = document.getElementById('runCalibrationBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/validate/calibration?days=30`);
            const { data } = await res.json();

            const placeholder = document.getElementById('calibrationPlaceholder');
            const results = document.getElementById('calibrationResults');
            if (placeholder) placeholder.style.display = 'none';
            if (results) results.style.display = 'block';

            // Update stats
            const meanEl = document.getElementById('calibrationMean');
            const stdDevEl = document.getElementById('calibrationStdDev');
            const skewEl = document.getElementById('calibrationSkewness');
            const gradeEl = document.getElementById('calibrationGrade');

            if (meanEl) meanEl.textContent = data.summary?.mean?.toFixed(2) ?? '-';
            if (stdDevEl) stdDevEl.textContent = data.summary?.std_dev?.toFixed(2) ?? '-';
            if (skewEl) skewEl.textContent = data.summary?.skewness?.toFixed(2) ?? '-';
            if (gradeEl) {
                gradeEl.textContent = data.summary?.calibration_grade ?? '-';
                const grade = data.summary?.calibration_grade;
                gradeEl.style.color = grade === 'A' ? '#2ecc71' : grade === 'B' ? '#f1c40f' : '#e74c3c';
            }

            // Histogram chart
            if (data.histogram) {
                const ctx = document.getElementById('calibrationHistogram');
                if (ctx) {
                    if (calibrationHistogramChart) calibrationHistogramChart.destroy();
                    const labels = Object.keys(data.histogram).sort((a, b) => parseFloat(a) - parseFloat(b));
                    const counts = labels.map(l => data.histogram[l] || 0);
                    calibrationHistogramChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [{
                                label: 'Count',
                                data: counts,
                                backgroundColor: 'rgba(124, 240, 255, 0.4)',
                                borderColor: '#7CF0FF',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                y: { beginAtZero: true, ticks: { color: '#888' } },
                                x: { ticks: { color: '#888' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }

            // Level discrimination
            const levelEl = document.getElementById('levelDiscrimination');
            if (levelEl && data.level_discrimination) {
                const levels = Object.entries(data.level_discrimination).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
                levelEl.innerHTML = `
                    <table style="width: 100%; font-size: 0.9em;">
                        <tr style="color: var(--muted);"><th style="text-align: left; padding: 4px;">Level</th><th style="text-align: right; padding: 4px;">Avg Score</th></tr>
                        ${levels.map(([level, score]) => `
                            <tr>
                                <td style="padding: 4px;">Level ${level}</td>
                                <td style="padding: 4px; text-align: right; color: var(--accent);">${score.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </table>
                    <div style="margin-top: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 0.85em; color: var(--muted);">
                        ${data.summary?.discrimination_ok ?
                            '<span style="color: #2ecc71;">Good discrimination: harder levels get lower scores</span>' :
                            '<span style="color: #e74c3c;">Poor discrimination: scores don\'t correlate with difficulty</span>'}
                    </div>
                `;
            }

            showToast('Calibration analysis complete', 'success');

        } catch (err) {
            console.error('Calibration analysis failed:', err);
            showToast('Calibration analysis failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-sliders-h"></i> Check Calibration';
            }
        }
    }

    /**
     * Populate failures tab from health check data
     */
    function populateFailuresTab(failuresData) {
        const placeholder = document.getElementById('failuresPlaceholder');
        const results = document.getElementById('failuresResults');
        if (placeholder) placeholder.style.display = 'none';
        if (results) results.style.display = 'block';

        // Update stats
        const totalEl = document.getElementById('failuresTotal');
        const rateEl = document.getElementById('failuresRate');
        const emptyEl = document.getElementById('failuresEmpty');
        const healthEl = document.getElementById('failuresHealth');

        if (totalEl) totalEl.textContent = failuresData.total_judge_attempts ?? '-';
        if (rateEl) {
            rateEl.textContent = (failuresData.failure_rate?.toFixed(1) ?? '-') + '%';
            rateEl.style.color = failuresData.failure_rate < 5 ? '#2ecc71' : failuresData.failure_rate < 15 ? '#f1c40f' : '#e74c3c';
        }
        if (emptyEl) emptyEl.textContent = failuresData.empty_responses ?? '-';
        if (healthEl) {
            healthEl.textContent = failuresData.health_status ?? '-';
            healthEl.style.color = failuresData.health_status === 'healthy' ? '#2ecc71' :
                failuresData.health_status === 'degraded' ? '#f1c40f' : '#e74c3c';
        }

        // Failure reasons chart
        if (failuresData.failure_reasons) {
            const ctx = document.getElementById('failureReasonsChart');
            if (ctx) {
                if (failureReasonsChart) failureReasonsChart.destroy();
                const labels = Object.keys(failuresData.failure_reasons);
                const counts = labels.map(l => failuresData.failure_reasons[l] || 0);
                failureReasonsChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: labels.map(l => l.replace(/_/g, ' ')),
                        datasets: [{
                            data: counts,
                            backgroundColor: ['#FF6B9D', '#7CF0FF', '#FFD700', '#A78BFA', '#34D399', '#00FF9F']
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: false,
                        plugins: {
                            legend: { position: 'right', labels: { color: '#888' } }
                        }
                    }
                });
            }
        }

        // Failures by category chart
        if (failuresData.failures_by_category) {
            const ctx = document.getElementById('failuresByCategoryChart');
            if (ctx) {
                if (failuresByCategoryChart) failuresByCategoryChart.destroy();
                const labels = Object.keys(failuresData.failures_by_category);
                const counts = labels.map(l => failuresData.failures_by_category[l] || 0);
                failuresByCategoryChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels,
                        datasets: [{
                            label: 'Failures',
                            data: counts,
                            backgroundColor: 'rgba(255, 107, 157, 0.4)',
                            borderColor: '#FF6B9D',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: false,
                        scales: {
                            y: { beginAtZero: true, ticks: { color: '#888' } },
                            x: { ticks: { color: '#888' } }
                        },
                        plugins: { legend: { display: false } }
                    }
                });
            }
        }

        // Recommendations
        const recList = document.getElementById('failuresRecommendationsList');
        if (recList && failuresData.recommendations) {
            recList.innerHTML = failuresData.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('');
        }
    }

    // ─── Tier Compatibility Matrix ─────────────────────────────────────

    const TIER_META = {
        basic:    { icon: '\u2714', color: '#27ae60', bg: 'rgba(39,174,96,0.15)',  border: 'rgba(39,174,96,0.35)', models: '2-3B (tinyllama, phi-2, gemma-2b)', desc: 'Small/fast models — trivial prompts with clear correct answers' },
        standard: { icon: '\u2605', color: '#3498db', bg: 'rgba(52,152,219,0.15)', border: 'rgba(52,152,219,0.35)', models: '7-9B (qwen2.5:7b, mistral, llama3.1:8b)', desc: 'Mid-size models — the key differentiation zone for most benchmarks' },
        advanced: { icon: '\u26A1', color: '#e67e22', bg: 'rgba(230,126,34,0.15)', border: 'rgba(230,126,34,0.35)', models: '14-32B (qwen2.5:14b, codellama:34b, command-r)', desc: 'Large models — nuanced evaluation of complex multi-step problems' },
        premium:  { icon: '\uD83D\uDC8E', color: '#e74c3c', bg: 'rgba(231,76,60,0.15)',  border: 'rgba(231,76,60,0.35)', models: '70B+ (llama3.1:70b, qwen2.5:72b)', desc: 'Flagship models — complex multi-constraint problems requiring deep reasoning' }
    };

    const LEVEL_LABELS = {
        1: 'Trivial', 2: 'Simple', 3: 'Easy', 4: 'Moderate', 5: 'Medium',
        6: 'Challenging', 7: 'Hard', 8: 'Very Hard', 9: 'Extreme', 10: 'Master'
    };

    const LEVEL_EXPLANATIONS = {
        basic:    'Clear right/wrong answers — small models can assess correctness',
        standard: 'Requires understanding code logic and nuance — needs a 7B+ judge',
        advanced: 'Multi-step reasoning and subtle quality differences — needs 14B+',
        premium:  'Complex multi-constraint evaluation — flagship models needed'
    };

    const CATEGORY_EXPLANATIONS = {
        coding:              'Verifying code correctness and logic — needs decent reasoning',
        reasoning:           'Evaluating logical chains — needs solid inference capability',
        factual:             'Checking factual accuracy — needs reliable knowledge base',
        creative:            'Assessing creativity is subjective — small judges suffice',
        'instruction-following': 'Binary compliance check — small models handle well',
        math:                'Verifying mathematical correctness — needs calculation ability',
        summarization:       'Checking coverage and conciseness — straightforward evaluation',
        'multi-turn-reasoning': 'Tracking context across turns — needs strong working memory',
        'context-retention': 'Measuring recall over long contexts — needs decent attention',
        translation:         'Comparing translation quality — pattern matching suffices',
        'edge-cases':        'Spotting subtle boundary conditions — needs careful analysis',
        general:             'Broad general evaluation — basic models handle fine',
        refactoring:         'Judging code improvement quality — needs code understanding',
        debugging:           'Evaluating bug identification — needs code tracing ability',
        explanation:         'Checking clarity of explanations — straightforward to judge',
        dialogue:            'Assessing conversational quality — basic evaluation'
    };

    function tierBadge(tier) {
        const m = TIER_META[tier] || TIER_META.basic;
        return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:4px;font-size:0.82em;font-weight:600;background:${m.bg};color:${m.color};border:1px solid ${m.border};">${m.icon} ${tier}</span>`;
    }

    function qualifyingJudges(tier, tierRank) {
        const rank = tierRank[tier] || 1;
        return Object.keys(TIER_META)
            .filter(t => (tierRank[t] || 1) >= rank)
            .map(t => `<span style="font-size:0.82em;color:${TIER_META[t].color};" title="${TIER_META[t].models}">${TIER_META[t].icon} ${t} (${TIER_META[t].models.split('(')[0].trim()})</span>`)
            .join(', ');
    }

    async function loadTierCompatibility() {
        try {
            const res = await fetch(`${BENCHMARK_API}/config`);
            const json = await res.json();
            const data = json.data || {};
            const levelTierMap = data.judge_tier_map || {};
            const categoryTierMap = data.category_tier_map || {};
            const tierRank = data.tier_rank || { basic: 1, standard: 2, advanced: 3, premium: 4 };
            const presets = data.judge_presets || {};

            // Render tier legend
            const legendEl = document.getElementById('tierLegend');
            if (legendEl) {
                legendEl.innerHTML = Object.entries(TIER_META).map(([tier, m]) =>
                    `<div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:${m.bg};border:1px solid ${m.border};border-radius:6px;">
                        ${tierBadge(tier)}
                        <span style="font-size:0.82em;color:var(--muted);">${m.models}</span>
                    </div>`
                ).join('');
            }

            // Render level table
            const levelBody = document.getElementById('tierLevelBody');
            if (levelBody) {
                let html = '';
                for (let level = 1; level <= 10; level++) {
                    const tier = levelTierMap[level] || 'basic';
                    html += `<tr>
                        <td style="font-weight:700;text-align:center;">${level}</td>
                        <td>${LEVEL_LABELS[level] || ''}</td>
                        <td style="text-align:center;">${tierBadge(tier)}</td>
                        <td>${qualifyingJudges(tier, tierRank)}</td>
                        <td style="font-size:0.82em;color:var(--muted);max-width:300px;">${LEVEL_EXPLANATIONS[tier] || ''}</td>
                    </tr>`;
                }
                levelBody.innerHTML = html;
            }

            // Render category table — sort by tier rank descending (hardest first)
            const catBody = document.getElementById('tierCategoryBody');
            if (catBody) {
                const cats = Object.entries(categoryTierMap)
                    .sort((a, b) => (tierRank[b[1]] || 1) - (tierRank[a[1]] || 1));
                let html = '';
                for (const [cat, tier] of cats) {
                    html += `<tr>
                        <td><span class="badge bg-light text-dark border text-capitalize" style="font-size:0.88em;">${escapeHtml(cat)}</span></td>
                        <td style="text-align:center;">${tierBadge(tier)}</td>
                        <td>${qualifyingJudges(tier, tierRank)}</td>
                        <td style="font-size:0.82em;color:var(--muted);max-width:300px;">${CATEGORY_EXPLANATIONS[cat] || ''}</td>
                    </tr>`;
                }
                catBody.innerHTML = html;
            }
        } catch (err) {
            console.error('Failed to load tier compatibility:', err);
        }
    }

    // Public API
    return {
        init,
        loadJudgeStats,
        refreshJudgeCompare,
        loadJudgeBreakdown,
        showToast,
        runHealthCheck,
        runConsistencyTest,
        runBiasDetection,
        runCalibrationAnalysis
    };
})();

// Keep global API for inline onclick handlers
window.CourthouseAnalytics = CourthouseAnalytics;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        CourthouseAnalytics.init();
    });
} else {
    CourthouseAnalytics.init();
}
