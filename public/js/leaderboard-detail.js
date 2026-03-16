/**
 * Leaderboard Detail Module
 * Modal views, charts, badges, level stars, CSV export
 */

// ============================================================================
// CHARTS
// ============================================================================

function initCharts() {
    const chartConfig = (label, color) => ({
        type: 'bar',
        data: { labels: [], datasets: [{ label, data: [], backgroundColor: color.replace('1)', '0.7)'), borderColor: color, borderWidth: 1 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: false, grace: '15%' } }
        }
    });

    const create = (id, label, color) => {
        const ctx = document.getElementById(id);
        if (!ctx) return;
        if (charts[id]) charts[id].destroy();
        charts[id] = new Chart(ctx, chartConfig(label, color));
    };

    create('perfLatencyChart', 'Latency (ms)', 'rgba(231, 76, 60, 1)');
    create('perfTokensChart', 'Tokens/sec', 'rgba(52, 152, 219, 1)');
    create('perfQualityChart', 'Quality Score', 'rgba(46, 204, 113, 1)');
    create('perfCompositeChart', 'Composite Score', 'rgba(241, 196, 15, 1)');
}

function updatePerformanceCharts(data) {
    const top10 = data.slice(0, 10);
    const labels = top10.map(m => truncateLabel(m.model));

    const update = (id, values) => {
        if (!charts[id]) return;
        charts[id].data.labels = labels;
        charts[id].data.datasets[0].data = values;
        charts[id].update();
    };

    update('perfLatencyChart', top10.map(m => m.avg_latency || 0));
    update('perfTokensChart', top10.map(m => parseFloat(m.avg_tokens_per_sec) || 0));
    update('perfQualityChart', top10.map(m => parseFloat(m.avg_quality) || 0));
    update('perfCompositeChart', top10.map(m => m._score || 0));
}

function truncateLabel(label) {
    return label.length > 20 ? label.substring(0, 18) + '...' : label;
}

// ============================================================================
// MODEL DETAIL MODAL
// ============================================================================

function showModelDetail(modelName, board, host) {
    const modal = document.getElementById('modelDetailModal');
    const modalName = document.getElementById('modalModelName');
    const modalBody = document.getElementById('modalBody');
    modalName.textContent = modelName;

    if (board === 'performance') {
        renderPerformanceDetail(modalBody, modelName, host);
    } else {
        renderQualityDetail(modalBody, modelName, host);
    }
    modal.style.display = 'flex';
}

function renderPerformanceDetail(modalBody, modelName, host) {
    const model = host
        ? performanceData.find(m => m.model === modelName && m.host === host)
        : performanceData.find(m => m.model === modelName);
    if (!model) return;

    const score = getProfileScore(model);
    const tests = model.tests || 1;
    const failed = model.failed_tests || 0;
    const execSuccessPct = Math.round(((tests - failed) / tests) * 100);
    const fullPassPct = Number.isFinite(Number(model.full_pass_rate)) ? Math.round(Number(model.full_pass_rate)) : 0;
    const judgeFailed = Number(model.judge_failed_tests) || 0;
    const judgePending = Number(model.judge_pending_tests) || 0;
    const fullPassed = Number(model.full_passed_tests) || 0;
    const hostLabel = extractHostName(model.host);

    modalBody.innerHTML = `
        <div class="detail-grid">
            <div class="detail-item" title="Server-calculated composite score for selected profile">
                <span class="detail-label">Composite Score <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value highlight">${score.toFixed(1)}</span>
            </div>
            <div class="detail-item" title="Generalist-adjusted quality score (0-10 scale)">
                <span class="detail-label">Quality Score <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${parseFloat(model.avg_quality || 0).toFixed(1)}</span>
            </div>
            <div class="detail-item" title="Average time from request to first response">
                <span class="detail-label">Avg Latency <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${(model.avg_latency || 0).toLocaleString()}ms</span>
            </div>
            <div class="detail-item" title="Output generation speed">
                <span class="detail-label">Tokens/sec <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${parseFloat(model.avg_tokens_per_sec || 0).toFixed(1)}</span>
            </div>
            <div class="detail-item" title="Execution success only: ${tests - failed} successful out of ${tests} judged-or-executed rows">
                <span class="detail-label">Exec Success <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${execSuccessPct}%</span>
            </div>
            <div class="detail-item" title="Full pass = execution success plus completed judge score">
                <span class="detail-label">Full Pass <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${fullPassPct}%</span>
            </div>
            <div class="detail-item" title="Execution success / execution fail / full pass">
                <span class="detail-label">Test Split</span>
                <span class="detail-value">${tests - failed} / ${failed} / ${fullPassed}</span>
            </div>
            <div class="detail-item" title="Judge failures after successful execution">
                <span class="detail-label">Judge Fail</span>
                <span class="detail-value">${judgeFailed}</span>
            </div>
            <div class="detail-item" title="Successful executions still waiting for judge completion">
                <span class="detail-label">Judge Pending</span>
                <span class="detail-value">${judgePending}</span>
            </div>
        </div>

        <h4>Profile Scores <span class="tip-text" title="Server-calculated composite scores for different use cases">i</span></h4>
        <div class="info-box">
            <span class="info-note">Each profile weights Quality, Speed, and Full Pass differently.</span>
        </div>
        <div class="detail-grid">
            <div class="detail-item" title="General-purpose: Quality 45%, Speed 30%, Full Pass 25%">
                <span class="detail-label">Balanced <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${parseFloat(model.balanced_score || 0).toFixed(1)}</span>
            </div>
            <div class="detail-item" title="Chat/real-time: Quality 40%, Latency 40%, Full Pass 20%">
                <span class="detail-label">Interactive <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${parseFloat(model.interactive_score || 0).toFixed(1)}</span>
            </div>
            <div class="detail-item" title="Analysis: Quality 80%, Speed 10%, Full Pass 10%">
                <span class="detail-label">Reasoning <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${parseFloat(model.reasoning_score || 0).toFixed(1)}</span>
            </div>
            <div class="detail-item" title="Code gen: Quality 70%, Speed 20%, Full Pass 10%">
                <span class="detail-label">Coding <i class="fas fa-info-circle tip-icon"></i></span>
                <span class="detail-value">${parseFloat(model.coding_score || 0).toFixed(1)}</span>
            </div>
        </div>

        ${model.host ? `
        <h4>Host Information</h4>
        <div class="info-box">
            <div class="info-row">
                <span class="info-label">Host:</span>
                <span class="info-value">${hostLabel}</span>
            </div>
        </div>
        ` : ''}
    `;
}

function renderQualityDetail(modalBody, modelName, host) {
    const model = host
        ? qualityData.find(m => m.name === modelName && m.host === host)
        : qualityData.find(m => m.name === modelName);
    if (!model) return;

    const categoryRows = Object.entries(model.categoryAverages)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, score]) => {
            const weight = CATEGORY_WEIGHTS[cat] || 0;
            const isUntested = !(Number.isFinite(score) && score > 0);
            const contribution = isUntested ? 0 : (score * weight);
            const barBg = isUntested ? 'rgba(255,255,255,0.18)' : getScoreColor(score);
            const rowStyle = isUntested ? 'opacity: 0.65;' : '';
            const scoreText = isUntested ? '\u2014' : score.toFixed(1);
            const contribText = isUntested ? '\u2014' : contribution.toFixed(1);

            return `
                <div class="category-row" style="${rowStyle}">
                    <span class="cat-name">${formatCategory(cat)}${isUntested ? ' <span style="color: var(--text-muted); font-size: 0.85em;">(not covered)</span>' : ''}</span>
                    <div class="cat-bar-container">
                        <div class="cat-bar" style="width: ${isUntested ? 2 : score}%; background: ${barBg};"></div>
                    </div>
                    <span class="cat-score">${scoreText}</span>
                    <span class="cat-weight">${(weight * 100).toFixed(0)}%</span>
                    <span class="cat-contrib">${contribText}</span>
                </div>
            `;
        }).join('');

    const testedCats = Object.values(model.categoryAverages).filter(s => s > 0).length;

    const levels = Object.keys(model.testsByLevel || {}).map(Number).sort((a, b) => a - b);
    const levelBars = levels.map(level => {
        const count = model.testsByLevel[level];
        const maxCount = Math.max(...Object.values(model.testsByLevel));
        const pct = (count / maxCount) * 100;
        return `<div class="level-bar-row">
            <span class="level-num">L${level}</span>
            <div class="level-bar-bg"><div class="level-bar-fill" style="width: ${pct}%; background: ${getLevelColor(level)};"></div></div>
            <span class="level-count">${count}</span>
        </div>`;
    }).join('');

    modalBody.innerHTML = `
        <div class="detail-grid">
            <div class="detail-item">
                <span class="detail-label">Generalist Score <i class="fas fa-info-circle tip-icon" data-tip="Final score: weighted quality - coverage penalty + consistency bonus"></i></span>
                <span class="detail-value highlight">${model.generalistScore.toFixed(1)}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Coverage <i class="fas fa-info-circle tip-icon" data-tip="% of ${Object.keys(CATEGORY_WEIGHTS).length} categories tested"></i></span>
                <span class="detail-value">${model.coverage}%</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Consistency <i class="fas fa-info-circle tip-icon" data-tip="Lower stddev = more predictable performance"></i></span>
                <span class="detail-value">${model.consistencyScore}%</span>
                <span class="detail-sub">\u03c3 = ${model.stdDev}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Total Tests</span>
                <span class="detail-value">${model.totalTests}</span>
            </div>
        </div>

        <h4>Tests by Difficulty Level <span class="tip-text" data-tip="Green=easy, Yellow=medium, Red=hard, Purple=extreme">i</span></h4>
        <div class="level-distribution">
            ${levelBars || '<span class="no-data">No level data</span>'}
        </div>

        <div class="info-box">
            <div class="info-row">
                <span class="info-label">Unweighted Avg (${testedCats} categories):</span>
                <span class="info-value">${model.avgScore.toFixed(1)}</span>
            </div>
            <span class="info-note">Simple mean across tested categories, ignoring weights</span>
        </div>

        <div class="info-box consistency-info">
            <div class="info-row">
                <span class="info-label">Standard Deviation (\u03c3):</span>
                <span class="info-value">${model.stdDev}</span>
            </div>
            <span class="info-note">
                <strong>\u03c3 &lt; 15</strong> = Consistent performer (+5 bonus).
                Lower \u03c3 = more reliable across different task types.
            </span>
        </div>

        <h4>Score Breakdown <span class="tip-text" data-tip="How the final Generalist Score is calculated">i</span></h4>
        <div class="formula-breakdown">
            <div class="formula-line">
                <span>Weighted Sum:</span>
                <span class="formula-value">+${model.weightedSum.toFixed(1)}</span>
            </div>
            ${model.coveragePenalty > 0 ? `
                <div class="formula-line penalty">
                    <span>Coverage Penalty:</span>
                    <span class="formula-value">-${model.coveragePenalty.toFixed(1)}</span>
                </div>
            ` : ''}
            ${model.consistencyBonus > 0 ? `
                <div class="formula-line bonus">
                    <span>Consistency Bonus:</span>
                    <span class="formula-value">+${model.consistencyBonus}</span>
                </div>
            ` : ''}
            <div class="formula-line total">
                <span><strong>Final Score:</strong></span>
                <span class="formula-value"><strong>${model.generalistScore.toFixed(1)}</strong></span>
            </div>
        </div>

        <h4>Category Performance</h4>
        <div class="category-breakdown">
            <div class="category-header">
                <span>Category</span>
                <span>Score</span>
                <span>Weight</span>
                <span>Contrib</span>
            </div>
            ${categoryRows}
        </div>
    `;
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function showMethodology() {
    document.getElementById('methodologyModal').style.display = 'flex';
}

window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
};

// ============================================================================
// BADGES & OFFENDERS
// ============================================================================

function calculateOffenders(data) {
    if (!data || data.length === 0) return {};
    const withLatency = data.filter(m => m.avg_latency > 0);
    const withTps = data.filter(m => parseFloat(m.avg_tokens_per_sec) > 0);
    const withQuality = data.filter(m => parseFloat(m.avg_quality) > 0);
    const withFailures = data.filter(m => (m.failed_tests || 0) > 0);

    return {
        slowest: withLatency.length ? withLatency.reduce((a, b) => a.avg_latency > b.avg_latency ? a : b) : null,
        lowestTps: withTps.length ? withTps.reduce((a, b) => parseFloat(a.avg_tokens_per_sec) < parseFloat(b.avg_tokens_per_sec) ? a : b) : null,
        lowestQuality: withQuality.length ? withQuality.reduce((a, b) => parseFloat(a.avg_quality) < parseFloat(b.avg_quality) ? a : b) : null,
        mostFailures: withFailures.length ? withFailures.reduce((a, b) => (a.failed_tests || 0) > (b.failed_tests || 0) ? a : b) : null
    };
}

function buildModelBadges(model, offenders, isBestOverall) {
    let badges = '';
    if (isBestOverall) {
        badges += `<span class="badge badge-best" title="Best Overall Composite Score">&#x1F451; BEST</span>`;
    }
    if (model.recommended_category) {
        const catConfig = getCategoryConfig(model.recommended_category);
        badges += `<span class="badge badge-category ${catConfig.cssClass}" style="--cat-color: ${catConfig.color}; --cat-bg: ${catConfig.bg};" title="Best at: ${catConfig.label}">
            <i class="fas ${catConfig.icon}"></i> ${catConfig.label}
        </span>`;
    }
    if (offenders) {
        const key = (m) => `${m?.model}@@${m?.host}`;
        const mk = key(model);
        if (offenders.slowest && key(offenders.slowest) === mk) badges += `<span class="badge badge-offender badge-slow" title="Worst Latency">&#x1F40C; SLOW</span>`;
        if (offenders.lowestTps && key(offenders.lowestTps) === mk) badges += `<span class="badge badge-offender badge-slug" title="Worst Throughput">&#x1F422; SLUG</span>`;
        if (offenders.lowestQuality && key(offenders.lowestQuality) === mk) badges += `<span class="badge badge-offender badge-poor" title="Lowest Quality">&#x2B50; POOR</span>`;
        if (offenders.mostFailures && key(offenders.mostFailures) === mk) badges += `<span class="badge badge-offender badge-unstable" title="Most Failures">&#x26A0;&#xFE0F; UNSTABLE</span>`;
    }
    return badges;
}

const CATEGORY_CONFIG_MAP = {
    coding:    { icon: 'fa-code',          color: '#7c9fff', bg: 'rgba(124, 159, 255, 0.15)', cssClass: 'badge-coding',     label: 'Coding' },
    reasoning: { icon: 'fa-brain',         color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.15)', cssClass: 'badge-reasoning',  label: 'Reasoning' },
    ops:       { icon: 'fa-bolt',          color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)',  cssClass: 'badge-ops',        label: 'Ops/Glue' },
    specialist:{ icon: 'fa-star',          color: '#ec4899', bg: 'rgba(236, 72, 153, 0.15)',  cssClass: 'badge-specialist', label: 'Specialist' },
    generalist:{ icon: 'fa-cubes',         color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.15)', cssClass: 'badge-generalist', label: 'Generalist' },
    embedding: { icon: 'fa-vector-square', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.15)',  cssClass: 'badge-embedding',  label: 'Embedding' },
    judge:     { icon: 'fa-gavel',         color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)',  cssClass: 'badge-judge',      label: 'Judge' },
    factual:   { icon: 'fa-book',          color: '#34d399', bg: 'rgba(52, 211, 153, 0.15)',  cssClass: 'badge-factual',    label: 'Factual' },
    math:      { icon: 'fa-calculator',    color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.15)',  cssClass: 'badge-math',       label: 'Math' },
    creative:  { icon: 'fa-paint-brush',   color: '#f87171', bg: 'rgba(248, 113, 113, 0.15)', cssClass: 'badge-creative',   label: 'Creative' },
    general:   { icon: 'fa-tag',           color: '#64748b', bg: 'rgba(100, 116, 139, 0.15)', cssClass: 'badge-general',    label: 'General' },
    'instruction-following': { icon: 'fa-list-check',   color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.15)',   cssClass: 'badge-if', label: 'Instruction Following' },
    'summarization':         { icon: 'fa-compress-alt', color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.15)',  cssClass: 'badge-sum', label: 'Summarization' },
    'translation':           { icon: 'fa-language',     color: '#f472b6', bg: 'rgba(244, 114, 182, 0.15)', cssClass: 'badge-tl', label: 'Translation' },
    'multi-turn-reasoning':  { icon: 'fa-comments',     color: '#c084fc', bg: 'rgba(192, 132, 252, 0.15)', cssClass: 'badge-mtr', label: 'Multi-Turn' },
    'context-retention':     { icon: 'fa-memory',       color: '#fb923c', bg: 'rgba(251, 146, 60, 0.15)',  cssClass: 'badge-cr', label: 'Context Retention' },
    'edge-cases':            { icon: 'fa-exclamation-triangle', color: '#a3e635', bg: 'rgba(163, 230, 53, 0.15)', cssClass: 'badge-ec', label: 'Edge Cases' },
    'refactoring':           { icon: 'fa-recycle',      color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)',  cssClass: 'badge-rf', label: 'Refactoring' },
    'debugging':             { icon: 'fa-bug',          color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)',   cssClass: 'badge-db', label: 'Debugging' },
    'explanation':           { icon: 'fa-chalkboard-teacher', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.15)', cssClass: 'badge-ex', label: 'Explanation' },
    'dialogue':              { icon: 'fa-comment-dots', color: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.15)',  cssClass: 'badge-dl', label: 'Dialogue' }
};

function getCategoryConfig(category) {
    const key = (category || '').toLowerCase();
    return CATEGORY_CONFIG_MAP[key] || { icon: 'fa-tag', color: '#95a5a6', bg: 'rgba(149, 165, 166, 0.15)', cssClass: '', label: category || 'Unknown' };
}

// ============================================================================
// LEVEL STARS
// ============================================================================

function buildLevelStars(levelStats) {
    if (!levelStats || typeof levelStats !== 'object') return '';
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(level => {
        const count = Number(levelStats[level] || levelStats[String(level)] || 0);
        if (count <= 0) {
            return `<span class="level-star-slot empty" title="Level ${level}: 0 tests"><span class="level-num">${level}</span></span>`;
        }
        const displayCount = count >= 100 ? '99+' : count;
        return `
            <span class="level-star-slot" title="Level ${level}: ${count} tests">
                <span class="level-star level-${level}"><i class="fas fa-star"></i></span>
                <span class="level-star-count">${displayCount}</span>
            </span>
        `;
    }).join('');
}

// ============================================================================
// CSV EXPORT
// ============================================================================

function exportAllToCSV() {
    const headers = [
        'Rank (Perf)', 'Model', 'Host', 'Composite', 'Quality', 'Latency (ms)', 'Tok/s',
        'Balanced', 'Interactive', 'Reasoning', 'Coding', 'Tests',
        'Rank (Qual)', 'Generalist', 'Coverage %', 'Consistency %', 'Top Category'
    ];

    const perfSorted = [...performanceData]
        .map(m => ({ ...m, _score: getProfileScore(m) }))
        .sort((a, b) => b._score - a._score);
    const qualSorted = [...qualityData].sort((a, b) => b.generalistScore - a.generalistScore);

    const toKey = (name, host) => `${name || ''}@@${host || ''}`;
    const perfRankByKey = new Map(perfSorted.map((m, idx) => [toKey(m.model, m.host), idx + 1]));
    const qualRankByKey = new Map(qualSorted.map((m, idx) => [toKey(m.name, m.host), idx + 1]));
    const perfByKey = new Map(perfSorted.map(m => [toKey(m.model, m.host), m]));
    const qualByKey = new Map(qualSorted.map(m => [toKey(m.name, m.host), m]));

    const orderedKeys = [];
    const seen = new Set();
    perfSorted.forEach(m => { const k = toKey(m.model, m.host); if (!seen.has(k)) { seen.add(k); orderedKeys.push(k); } });
    qualSorted.forEach(m => { const k = toKey(m.name, m.host); if (!seen.has(k)) { seen.add(k); orderedKeys.push(k); } });

    const rows = orderedKeys.map(key => {
        const perf = perfByKey.get(key);
        const qual = qualByKey.get(key);
        const modelName = perf?.model || qual?.name || '';
        const host = perf?.host || qual?.host || '';
        const hostLabel = extractHostName(host);

        return [
            perf ? perfRankByKey.get(key) : '',
            modelName,
            hostLabel,
            perf ? perf._score.toFixed(1) : '',
            perf ? parseFloat(perf.avg_quality || 0).toFixed(1) : '',
            perf ? perf.avg_latency || '' : '',
            perf ? parseFloat(perf.avg_tokens_per_sec || 0).toFixed(1) : '',
            perf ? parseFloat(perf.balanced_score || 0).toFixed(1) : '',
            perf ? parseFloat(perf.interactive_score || 0).toFixed(1) : '',
            perf ? parseFloat(perf.reasoning_score || 0).toFixed(1) : '',
            perf ? parseFloat(perf.coding_score || 0).toFixed(1) : '',
            perf ? perf.tests || '' : '',
            qual ? qualRankByKey.get(key) : '',
            qual ? qual.generalistScore.toFixed(1) : '',
            qual ? qual.coverage : '',
            qual ? qual.consistencyScore : '',
            qual ? qual.topCategory : ''
        ];
    });

    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leaderboard-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
