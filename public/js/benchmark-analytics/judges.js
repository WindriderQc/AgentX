/**
 * Benchmark Analytics - Judge Stats & Compare
 * Judge leaderboard, breakdown, and comparison features
 */

import {
    BENCHMARK_API,
    STORAGE_KEYS,
    chartInstances,
    judgeSelections,
    judgeLeaderboardCache,
    setJudgeLeaderboardCache
} from './config.js';
import {
    getPaletteColor,
    escapeHtml,
    showToast,
    selectionKeyJudge,
    parseJudgeKey,
    renderChipList,
    computePearsonCorrelation
} from './utils.js';

/**
 * Restore judge compare selections from localStorage
 */
export function restoreCompareSelections() {
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

/**
 * Persist judge selections to localStorage
 */
function persistJudgeSelections() {
    try {
        localStorage.setItem(STORAGE_KEYS.judges, JSON.stringify(judgeSelections));
    } catch (_) {
        // ignore
    }
}

/**
 * Set judge breakdown status indicator
 */
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

/**
 * Render judge breakdown chart
 */
export function renderJudgeBreakdownChart({ groupBy, groups }) {
    const ctx = document.getElementById('judgeBreakdownChart');
    const emptyEl = document.getElementById('judgeBreakdownChartEmpty');
    if (!ctx) return;

    if (!Array.isArray(groups) || groups.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        if (chartInstances.judgeBreakdownChart) {
            chartInstances.judgeBreakdownChart.destroy();
            chartInstances.judgeBreakdownChart = null;
        }
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const labels = groups.map(g => {
        const key = g.key === null || g.key === undefined ? 'N/A' : String(g.key);
        if (groupBy === 'model' && key.length > 22) return key.slice(0, 19) + '...';
        return key;
    });

    const fullLabels = groups.map(g => (g.key === null || g.key === undefined ? 'N/A' : String(g.key)));
    const latencySeconds = groups.map(g => (Number(g.avg_latency) || 0) / 1000);
    const tokens = groups.map(g => Number(g.avg_test_tokens) || 0);

    const c1 = getPaletteColor(0);
    const c2 = getPaletteColor(1);

    if (chartInstances.judgeBreakdownChart) chartInstances.judgeBreakdownChart.destroy();
    chartInstances.judgeBreakdownChart = new Chart(ctx, {
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

/**
 * Render judge breakdown insights
 */
export function renderJudgeBreakdownInsights({ groupBy, groups }) {
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
                        ${escapeHtml(label(slowest))} - ${(((Number(slowest.avg_latency) || 0) / 1000)).toFixed(2)}s
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; gap: 10px;">
                    <div style="color: var(--muted);">Fastest group</div>
                    <div style="color: var(--text); font-weight: 600; text-align: right;">
                        ${escapeHtml(label(fastest))} - ${(((Number(fastest.avg_latency) || 0) / 1000)).toFixed(2)}s
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; gap: 10px;">
                    <div style="color: var(--muted);">Tokens <-> Judge latency correlation</div>
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

/**
 * Render judge breakdown table
 */
export function renderJudgeBreakdownTable({ groupBy, groups }) {
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

/**
 * Load judge breakdown data
 */
export async function loadJudgeBreakdown() {
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
            // Common failure mode: API route missing -> static HTML fallback
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
        setJudgeBreakdownStatus('ok', `ok - ${groupsCount} groups`);
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

/**
 * Populate judge compare dropdown
 */
export function populateJudgeCompareSelect(leaderboard) {
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

/**
 * Populate judge breakdown dropdown
 */
export function populateJudgeBreakdownSelect(leaderboard) {
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

/**
 * Ensure judge leaderboard is loaded
 */
async function ensureJudgeLeaderboardLoaded() {
    if (Array.isArray(judgeLeaderboardCache) && judgeLeaderboardCache.length) return judgeLeaderboardCache;
    try {
        await loadJudgeStats();
    } catch (_) {
        // ignore
    }
    return Array.isArray(judgeLeaderboardCache) ? judgeLeaderboardCache : [];
}

/**
 * Add top judge to compare
 */
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

/**
 * Refresh judge compare UI
 */
export async function refreshJudgeCompare() {
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
        if (chartInstances.judgeRadarChart) {
            chartInstances.judgeRadarChart.destroy();
            chartInstances.judgeRadarChart = null;
        }
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    try {
        const leaderboard = judgeLeaderboardCache || (await (async () => {
            const res = await fetch(`${BENCHMARK_API}/judge-leaderboard`);
            const { data } = await res.json();
            setJudgeLeaderboardCache(data.leaderboard || []);
            populateJudgeCompareSelect(judgeLeaderboardCache);
            return judgeLeaderboardCache;
        })());

        const labels = ['Speed', 'Reliability', 'Diligence', 'Avg Score Given'];

        const datasets = judgeSelections.map((sel, idx) => {
            const row = leaderboard.find(j => j.judge_model === sel.judge_model && (j.judge_host || null) === (sel.judge_host || null));
            const avgLatency = row?.avg_latency ?? 0;
            const successRate = row?.success_rate ?? 0;
            const avgExplanationLen = row?.avg_explanation_len ?? 0;
            const avgScoreGiven = row?.avg_score_given ?? 0;

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

        if (chartInstances.judgeRadarChart) chartInstances.judgeRadarChart.destroy();
        chartInstances.judgeRadarChart = new Chart(ctx, {
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
 * Setup judge compare UI event listeners
 */
export function setupJudgeCompareUI() {
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

/**
 * Load Judge Leaderboard and Stats
 */
export async function loadJudgeStats() {
    try {
        const res = await fetch(`${BENCHMARK_API}/judge-leaderboard`);
        const { data } = await res.json();

        const { leaderboard, activity } = data;

        setJudgeLeaderboardCache(leaderboard || []);
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
                                <div style="color: var(--muted); font-size: 0.9em;">${act.prompt_category || 'general'} - ${act.scoring_time_ms != null ? (act.scoring_time_ms/1000).toFixed(1) + 's' : 'N/A'}</div>
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
                if (chartInstances.judgeStrictnessChart) {
                    chartInstances.judgeStrictnessChart.destroy();
                }

                const dist = topJudge.score_distribution || {};
                const labels = ['0-2', '2-4', '4-6', '6-8', '8-10'];
                const data = labels.map(l => dist[l] || 0);

                chartInstances.judgeStrictnessChart = new Chart(ctx, {
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
                        animation: false,
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
