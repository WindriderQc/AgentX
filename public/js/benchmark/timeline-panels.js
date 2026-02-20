// timeline-panels.js - Extracted rendering panels for timeline view
// Performance summary, event list, and heatmap

import { escapeHtml, summarizeNumbers } from './utils.js';

function formatTime(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render the performance summary stats panel
 * @param {Array} sorted - Sorted results array
 * @param {Object} globalStats - Pre-computed global averages
 */
export function renderStatsSummary(sorted, globalStats) {
    const statsSummary = document.getElementById('timelineStatsSummary');
    if (!statsSummary || !sorted.length) return;

    const latencies = sorted.filter(r => r.latency).map(r => r.latency).sort((a, b) => a - b);
    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

    const totalTests = sorted.length;
    const successCount = sorted.filter(r => r.success).length;
    const successRate = ((successCount / totalTests) * 100).toFixed(1);
    const avgTps = globalStats.avgTps > 0 ? globalStats.avgTps.toFixed(1) : '0.0';
    const avgQuality = globalStats.avgQuality.toFixed(1);

    const formatMs = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

    statsSummary.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px;">
            <div style="text-align: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="color: rgba(255,255,255,0.6); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Total Tests</div>
                <div style="color: var(--accent); font-size: 1.8em; font-weight: 700;">${totalTests}</div>
            </div>
            <div style="text-align: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="color: rgba(255,255,255,0.6); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Success Rate</div>
                <div style="color: ${successRate >= 90 ? '#2ecc71' : (successRate >= 70 ? '#f39c12' : '#e74c3c')}; font-size: 1.8em; font-weight: 700;">${successRate}%</div>
            </div>
            <div style="text-align: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="color: rgba(255,255,255,0.6); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Avg Latency</div>
                <div style="color: var(--text); font-size: 1.8em; font-weight: 700;">${formatMs(globalStats.avgLatency)}</div>
            </div>
            <div style="text-align: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="color: rgba(255,255,255,0.6); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">P95 Latency</div>
                <div style="color: var(--text); font-size: 1.8em; font-weight: 700;">${formatMs(p95)}</div>
            </div>
            <div style="text-align: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="color: rgba(255,255,255,0.6); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Avg Throughput</div>
                <div style="color: var(--text); font-size: 1.8em; font-weight: 700;">${avgTps}<span style="font-size: 0.5em; color: rgba(255,255,255,0.5);"> tok/s</span></div>
            </div>
            <div style="text-align: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="color: rgba(255,255,255,0.6); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Avg Quality</div>
                <div style="color: ${avgQuality >= 8 ? '#2ecc71' : (avgQuality >= 6 ? '#f39c12' : '#e74c3c')}; font-size: 1.8em; font-weight: 700;">${avgQuality}<span style="font-size: 0.5em; color: rgba(255,255,255,0.5);">/10</span></div>
            </div>
        </div>
    `;
    statsSummary.style.display = 'block';
}

/**
 * Render the collapsible execution timeline event list
 * @param {Array} batchTimeline - Array of batch timeline events
 */
export function renderEventList(batchTimeline) {
    const timelineContainerEl = document.getElementById('timelineContainer');
    const timelineSummaryEl = document.getElementById('timelineSummary');
    const timelineEventsEl = document.getElementById('timelineEvents');

    if (!timelineContainerEl || !timelineSummaryEl || !timelineEventsEl || !batchTimeline.length) {
        if (timelineContainerEl) timelineContainerEl.style.display = 'none';
        return;
    }

    timelineContainerEl.style.display = 'block';
    const timelineContentEl = document.getElementById('timelineContent');
    const timelineChevronEl = document.getElementById('timelineChevron');
    if (timelineContentEl) timelineContentEl.style.display = 'block';
    if (timelineChevronEl) timelineChevronEl.className = 'fas fa-chevron-up';

    const eventCounts = {};
    let firstEventTime = Infinity;
    let lastEventTime = 0;

    batchTimeline.forEach(event => {
        const eventType = event.event || 'unknown';
        eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;
        const eventTime = event.time_since_start_ms || 0;
        if (eventTime < firstEventTime) firstEventTime = eventTime;
        if (eventTime > lastEventTime) lastEventTime = eventTime;
    });

    const elapsedTime = lastEventTime - (firstEventTime === Infinity ? 0 : firstEventTime);
    const testCompletes = eventCounts['test_complete'] || 0;
    const judgeCompletes = eventCounts['judge_complete'] || 0;
    const errors = eventCounts['error'] || 0;

    timelineSummaryEl.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center;">
            <div><strong style="color: var(--accent);">${batchTimeline.length}</strong> <span style="color: var(--muted);">events</span></div>
            <div><strong style="color: #2ecc71;">${testCompletes}</strong> <span style="color: var(--muted);">tests</span></div>
            <div><strong style="color: #9b59b6;">${judgeCompletes}</strong> <span style="color: var(--muted);">judged</span></div>
            ${errors > 0 ? `<div><strong style="color: #e74c3c;">${errors}</strong> <span style="color: var(--muted);">errors</span></div>` : ''}
            <div style="margin-left: auto;"><i class="fas fa-clock" style="color: var(--muted); margin-right: 4px;"></i><span style="color: var(--muted);">Elapsed:</span> <strong>${formatTime(elapsedTime)}</strong></div>
        </div>
    `;

    const eventStyles = {
        'prep_start': { icon: 'fa-plug', color: '#3498db', label: 'Prep Started' },
        'judge_warmup_start': { icon: 'fa-gavel', color: '#9b59b6', label: 'Judge Warmup' },
        'judge_warmup_complete': { icon: 'fa-check-circle', color: '#9b59b6', label: 'Judge Ready' },
        'tests_start': { icon: 'fa-rocket', color: '#2ecc71', label: 'Tests Started' },
        'model_warmup_complete': { icon: 'fa-bolt', color: '#f39c12', label: 'Model Warmed' },
        'test_complete': { icon: 'fa-robot', color: '#2ecc71', label: 'Test Complete' },
        'judge_complete': { icon: 'fa-gavel', color: '#9b59b6', label: 'Judged' },
        'error': { icon: 'fa-exclamation-triangle', color: '#e74c3c', label: 'Error' },
        'batch_complete': { icon: 'fa-flag-checkered', color: '#2ecc71', label: 'Batch Complete' }
    };

    const sortedEvents = [...batchTimeline].sort((a, b) =>
        (b.time_since_start_ms || 0) - (a.time_since_start_ms || 0)
    );

    const eventsHtml = sortedEvents.map(event => {
        const warmupFailed = (
            (event.event === 'model_warmup_complete' || event.event === 'judge_warmup_complete') &&
            event.success === false
        );
        const style = warmupFailed
            ? { icon: 'fa-exclamation-triangle', color: '#e74c3c', label: 'Warmup Failed' }
            : (eventStyles[event.event] || { icon: 'fa-circle', color: 'var(--muted)', label: event.event });
        const timeStr = formatTime(event.time_since_start_ms || 0);
        const durationStr = event.duration_ms ? ` (${formatTime(event.duration_ms)})` : '';
        const modelStr = event.model ? `<span style="color: var(--accent); font-weight: 500;">${escapeHtml(event.model)}</span> • ` : '';
        const promptStr = event.prompt ? `<span style="color: var(--muted); font-size: 0.85em;">${escapeHtml(event.prompt.substring(0, 50))}${event.prompt.length > 50 ? '...' : ''}</span>` : '';
        const qualityStr = event.quality_score !== undefined ? `<span style="color: #f39c12; margin-left: 8px;">Q${Number(event.quality_score).toFixed(1)}</span>` : '';
        const errorStr = event.error ? `<span style="color: #e74c3c; font-size: 0.85em; display: block; margin-top: 2px;">${escapeHtml(event.error)}</span>` : '';

        return `
            <div style="display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); align-items: flex-start;">
                <div style="width: 60px; text-align: right; color: var(--muted); font-size: 0.8em; flex-shrink: 0; padding-top: 2px;">
                    ${timeStr}
                </div>
                <div style="width: 24px; text-align: center; flex-shrink: 0;">
                    <i class="fas ${style.icon}" style="color: ${style.color};"></i>
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <span style="font-weight: 600; color: ${style.color};">${style.label}</span>
                        <span style="color: var(--muted); font-size: 0.85em;">${durationStr}</span>
                        ${qualityStr}
                    </div>
                    <div style="margin-top: 2px;">
                        ${modelStr}${promptStr}
                    </div>
                    ${errorStr}
                </div>
            </div>
        `;
    }).join('');

    timelineEventsEl.innerHTML = eventsHtml || '<div style="padding: 20px; text-align: center; color: var(--muted);">No events to display</div>';
}

/**
 * Render the performance heatmap comparison table
 * @param {Map} resultsByModel - Map of model name to results array
 */
export function renderPerformanceHeatmap(resultsByModel) {
    const heatmapSection = document.getElementById('performanceHeatmapSection');
    const heatmapContainer = document.getElementById('performanceHeatmap');
    if (!heatmapContainer || resultsByModel.size <= 1) return;

    const modelStats = [];
    for (const [model, modelResults] of resultsByModel.entries()) {
        if (modelResults.length === 0) continue;

        const successCount = modelResults.filter(r => r.success).length;
        const infraFailCount = modelResults.filter(r => r.success === false && (r.infra_error === true || String(r.error_type || '').toLowerCase() === 'infra')).length;
        const failCount = modelResults.length - successCount;
        const modelFailCount = Math.max(0, failCount - infraFailCount);
        const successRate = (successCount / modelResults.length) * 100;
        const latencies = modelResults.filter(r => r.latency).map(r => r.latency);
        const qualities = modelResults.filter(r => r.quality_score != null).map(r => r.quality_score);
        const tps = modelResults
            .map(r => parseFloat(r.tokens_per_sec))
            .filter(v => !isNaN(v) && v > 0);

        const latencyStats = summarizeNumbers(latencies);
        const qualityStats = summarizeNumbers(qualities);
        const tpsStats = summarizeNumbers(tps);

        modelStats.push({
            model,
            successRate,
            avgLatency: latencyStats.mean || 0,
            avgQuality: qualityStats.mean || 0,
            avgTps: tpsStats.mean || 0,
            testCount: modelResults.length,
            successCount,
            failCount,
            infraFailCount,
            modelFailCount,
            latencyStats,
            qualityStats,
            tpsStats
        });
    }

    if (modelStats.length === 0) return;

    const latencyMeans = modelStats.map(m => m.avgLatency).filter(l => Number.isFinite(l) && l > 0);
    const minLatency = latencyMeans.length ? Math.min(...latencyMeans) : 0;
    const maxLatency = latencyMeans.length ? Math.max(...latencyMeans) : 0;
    const tpsMeans = modelStats.map(m => m.avgTps).filter(v => Number.isFinite(v) && v > 0);
    const maxTps = tpsMeans.length ? Math.max(...tpsMeans) : 0;

    const getHeatColor = (value, reverse = false) => {
        if (reverse) value = 100 - value;
        if (value >= 80) return 'linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%)';
        if (value >= 60) return 'linear-gradient(135deg, #10b981 0%, #34d399 100%)';
        if (value >= 40) return 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)';
        if (value >= 20) return 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)';
        return 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)';
    };

    const getHeatLabel = (value) => {
        if (!Number.isFinite(value)) return '\u2014';
        if (value >= 80) return 'Great';
        if (value >= 60) return 'Good';
        if (value >= 40) return 'OK';
        if (value >= 20) return 'Low';
        return 'Poor';
    };

    const statByModel = new Map(modelStats.map(s => [s.model, s]));
    const formatMs = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

    const heatmapHtml = `
        <table style="width: 100%; border-collapse: separate; border-spacing: 4px; font-size: 0.9em;">
            <thead>
                <tr>
                    <th style="padding: 10px 12px; text-align: left; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px;">Model</th>
                    <th style="padding: 10px 12px; text-align: center; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px;">Tests</th>
                    <th style="padding: 10px 12px; text-align: center; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px;">Success Rate</th>
                    <th style="padding: 10px 12px; text-align: center; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px;">Avg Latency</th>
                    <th style="padding: 10px 12px; text-align: center; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px;">Avg Quality</th>
                    <th style="padding: 10px 12px; text-align: center; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px;">Throughput</th>
                </tr>
            </thead>
            <tbody>
                ${modelStats.map(stat => {
                    const latencyNorm = (maxLatency > minLatency && stat.avgLatency > 0)
                        ? (1 - ((stat.avgLatency - minLatency) / (maxLatency - minLatency))) * 100
                        : 50;
                    const qualityNorm = (stat.avgQuality / 10) * 100;
                    const tpsNorm = maxTps > 0 ? (stat.avgTps / maxTps) * 100 : 50;
                    const safeModel = escapeHtml(stat.model);

                    return `
                        <tr style="transition: all 0.2s ease;">
                            <td style="padding: 10px 12px; color: var(--text); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px; cursor: help;" class="heatmap-cell" data-model="${safeModel}" data-metric="model" data-score="" title="${safeModel}">
                                ${safeModel}
                            </td>
                            <td style="padding: 10px 12px; text-align: center; color: var(--text); background: rgba(0,0,0,0.2); border-radius: 4px; cursor: help;" class="heatmap-cell" data-model="${safeModel}" data-metric="tests" data-score="" title="Tests: ${stat.testCount} (pass ${stat.successCount}, fail ${stat.failCount}${Number.isFinite(stat.infraFailCount) ? `; infra ${stat.infraFailCount}, model ${stat.modelFailCount}` : ''})">
                                ${stat.testCount}
                            </td>
                            <td style="padding: 10px 12px; text-align: center; font-weight: 600; background: ${getHeatColor(stat.successRate)}; color: white; border-radius: 4px; cursor: help; transition: all 0.2s ease;" class="heatmap-cell" data-model="${safeModel}" data-metric="success" data-score="${stat.successRate}" title="Success: ${stat.successRate.toFixed(1)}% (${stat.successCount}/${stat.testCount})">
                                ${stat.successRate.toFixed(1)}%
                            </td>
                            <td style="padding: 10px 12px; text-align: center; font-weight: 600; background: ${getHeatColor(latencyNorm)}; color: white; border-radius: 4px; cursor: help; transition: all 0.2s ease;" class="heatmap-cell" data-model="${safeModel}" data-metric="latency" data-score="${latencyNorm}" title="Latency: avg ${formatMs(stat.avgLatency)} • p95 ${stat.latencyStats?.p95 ? formatMs(stat.latencyStats.p95) : '-'} (${getHeatLabel(latencyNorm)})">
                                ${formatMs(stat.avgLatency)}
                            </td>
                            <td style="padding: 10px 12px; text-align: center; font-weight: 600; background: ${getHeatColor(qualityNorm)}; color: white; border-radius: 4px; cursor: help; transition: all 0.2s ease;" class="heatmap-cell" data-model="${safeModel}" data-metric="quality" data-score="${qualityNorm}" title="Quality: avg ${stat.avgQuality.toFixed(1)}/10 (${getHeatLabel(qualityNorm)})">
                                ${stat.avgQuality.toFixed(1)}/10
                            </td>
                            <td style="padding: 10px 12px; text-align: center; font-weight: 600; background: ${getHeatColor(tpsNorm)}; color: white; border-radius: 4px; cursor: help; transition: all 0.2s ease;" class="heatmap-cell" data-model="${safeModel}" data-metric="tps" data-score="${tpsNorm}" title="Throughput: avg ${stat.avgTps.toFixed(1)} tok/s (${getHeatLabel(tpsNorm)})">
                                ${stat.avgTps.toFixed(1)} tok/s
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;

    heatmapContainer.innerHTML = heatmapHtml;
    heatmapSection.style.display = 'block';

    // Update legend ranges
    const legendLatencyEl = document.getElementById('heatmapLegendLatency');
    const legendTpsEl = document.getElementById('heatmapLegendTps');
    if (legendLatencyEl) {
        legendLatencyEl.textContent = (minLatency > 0 && maxLatency > 0)
            ? `Latency scale: ${formatMs(minLatency)} \u2192 ${formatMs(maxLatency)} (avg)`
            : 'Latency scale: \u2014';
    }
    if (legendTpsEl) {
        legendTpsEl.textContent = (maxTps > 0)
            ? `Throughput scale: 0 \u2192 ${maxTps.toFixed(1)} tok/s (avg)`
            : 'Throughput scale: \u2014';
    }

    // Rich hover details tooltip
    const ensureHeatmapTooltip = () => {
        let el = document.getElementById('heatmapTooltip');
        if (!el) {
            el = document.createElement('div');
            el.id = 'heatmapTooltip';
            el.className = 'heatmap-tooltip';
            document.body.appendChild(el);
        }
        return el;
    };

    const tooltipEl = ensureHeatmapTooltip();
    const hideTooltip = () => {
        tooltipEl.style.display = 'none';
        tooltipEl.innerHTML = '';
    };

    const positionTooltip = (evt) => {
        const pad = 12;
        const offset = 14;
        const rect = tooltipEl.getBoundingClientRect();
        let x = evt.clientX + offset;
        let y = evt.clientY + offset;
        if (x + rect.width + pad > window.innerWidth) x = evt.clientX - rect.width - offset;
        if (y + rect.height + pad > window.innerHeight) y = evt.clientY - rect.height - offset;
        x = Math.max(pad, Math.min(window.innerWidth - rect.width - pad, x));
        y = Math.max(pad, Math.min(window.innerHeight - rect.height - pad, y));
        tooltipEl.style.left = `${x}px`;
        tooltipEl.style.top = `${y}px`;
    };

    const fmtPct = (p) => `${Number(p).toFixed(1)}%`;
    const fmtTok = (t) => `${Number(t).toFixed(1)} tok/s`;
    const fmtQ = (q) => `${Number(q).toFixed(1)}/10`;
    const fmtMsTooltip = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
    const fmtOrDash = (v, fmt) => (Number.isFinite(v) ? fmt(v) : '\u2014');

    const renderTooltip = (stat, metric, score) => {
        const metricLabel = ({
            model: 'Model',
            tests: 'Tests',
            success: 'Success rate',
            latency: 'Latency',
            quality: 'Quality',
            tps: 'Throughput'
        })[metric] || 'Details';

        const scoreLabel = getHeatLabel(score);
        const headline = metric === 'tests'
            ? `${stat.testCount} tests`
            : metric === 'model'
                ? 'Summary'
                : `${metricLabel} \u2022 ${scoreLabel}`;

        const latencyP50 = stat.latencyStats ? stat.latencyStats.p50 : null;
        const latencyP95 = stat.latencyStats ? stat.latencyStats.p95 : null;
        const tpsP10 = stat.tpsStats ? stat.tpsStats.p10 : null;
        const tpsP50 = stat.tpsStats ? stat.tpsStats.p50 : null;
        const qP10 = stat.qualityStats ? stat.qualityStats.p10 : null;
        const qP50 = stat.qualityStats ? stat.qualityStats.p50 : null;

        tooltipEl.innerHTML = `
            <div class="title">${escapeHtml(stat.model)}</div>
            <div class="sub">${escapeHtml(headline)}</div>
            <div class="grid">
                <div class="k">Tests</div><div class="v">${stat.testCount}</div>
                <div class="k">Success</div><div class="v">${fmtPct(stat.successRate)} (${stat.successCount}/${stat.testCount})</div>
                <div class="k">Latency</div><div class="v">avg ${fmtMsTooltip(stat.avgLatency)} \u2022 p50 ${fmtOrDash(latencyP50, fmtMsTooltip)} \u2022 p95 ${fmtOrDash(latencyP95, fmtMsTooltip)}</div>
                <div class="k">Quality</div><div class="v">avg ${fmtQ(stat.avgQuality)} \u2022 p50 ${fmtOrDash(qP50, fmtQ)} \u2022 p10 ${fmtOrDash(qP10, fmtQ)}</div>
                <div class="k">Throughput</div><div class="v">avg ${fmtTok(stat.avgTps)} \u2022 p50 ${fmtOrDash(tpsP50, fmtTok)} \u2022 p10 ${fmtOrDash(tpsP10, fmtTok)}</div>
            </div>
        `;
    };

    const cells = heatmapContainer.querySelectorAll('.heatmap-cell');
    cells.forEach(cell => {
        cell.addEventListener('mouseenter', function (evt) {
            this.style.transform = 'scale(1.05)';
            this.style.zIndex = '10';

            const model = this.dataset.model;
            const metric = this.dataset.metric;
            const stat = statByModel.get(model);
            if (!stat) return;

            const score = Number(this.dataset.score);
            renderTooltip(stat, metric, score);
            tooltipEl.style.display = 'block';
            positionTooltip(evt);
        });
        cell.addEventListener('mousemove', positionTooltip);
        cell.addEventListener('mouseleave', function () {
            this.style.transform = 'scale(1)';
            this.style.zIndex = '1';
            hideTooltip();
        });
    });
}
