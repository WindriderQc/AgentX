// timeline.js - renderBatchEventTimeline and related functions

import * as state from './state.js';
import { BENCHMARK_API } from './state.js';
import { escapeHtml, encodeTooltip, decodeTooltip, summarizeNumbers } from './utils.js';
import { fetchBatchTimeline, fetchActiveBatches, fetchAdvancedResults } from './api.js';
import { renderStatsSummary, renderEventList, renderPerformanceHeatmap } from './timeline-panels.js';

// Track previous result IDs and hash for incremental update detection
let lastTimelineResultIds = new Set();
let lastTimelineHash = null;

/**
 * Get timeline mode from selector
 */
export function getTimelineMode() {
    const modeSelect = document.getElementById('timelineMode');
    return modeSelect ? modeSelect.value : 'results';
}

/**
 * Get timeline ordering from selector or localStorage
 */
export function getTimelineOrder() {
    const orderSelect = document.getElementById('timelineOrder');
    if (orderSelect && orderSelect.value) return orderSelect.value;
    return localStorage.getItem('benchmarkTimelineOrder') || 'execution';
}

/**
 * Get timeline zoom from selector
 */
export function getTimelineZoom() {
    const zoomSelect = document.getElementById('timelineZoom');
    const zoom = zoomSelect ? Number(zoomSelect.value) : 1;
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * Schedule timeline scroll sync
 */
export function scheduleTimelineScrollSync(stickToEnd = true) {
    if (state.timelineScrollRaf) cancelAnimationFrame(state.timelineScrollRaf);
    const raf = requestAnimationFrame(() => {
        state.setTimelineScrollRaf(null);
        syncTimelineScroll(stickToEnd);
    });
    state.setTimelineScrollRaf(raf);
}

/**
 * Sync timeline scroll across tracks
 */
function syncTimelineScroll(stickToEnd = true) {
    const timelineVisual = document.getElementById('timelineVisual');
    const controls = document.getElementById('timelineScrollControls');
    const range = document.getElementById('timelineScrollRange');
    if (!timelineVisual || !controls || !range) return;

    if (timelineVisual.offsetParent === null) {
        controls.style.display = 'none';
        return;
    }

    const tracks = Array.from(timelineVisual.querySelectorAll('.timeline-track, .timeline-track-absolute'));
    if (!tracks.length) {
        controls.style.display = 'none';
        return;
    }

    const maxScroll = tracks.reduce((max, track) => {
        return Math.max(max, track.scrollWidth - track.clientWidth);
    }, 0);

    if (maxScroll <= 1) {
        controls.style.display = 'none';
        return;
    }

    controls.style.display = 'block';
    range.min = 0;
    range.max = Math.ceil(maxScroll);
    range.step = 1;

    const targetValue = stickToEnd ? maxScroll : Math.min(Number(range.value) || 0, maxScroll);
    range.value = Math.round(targetValue);

    // Apply scroll
    const ratio = maxScroll > 0 ? targetValue / maxScroll : 0;
    tracks.forEach((track) => {
        const trackMax = track.scrollWidth - track.clientWidth;
        if (trackMax > 0) {
            track.scrollLeft = trackMax * ratio;
        }
    });
}

/**
 * Show timeline tooltip
 */
export function showTimelineTooltip(e, htmlContent) {
    let tooltip = document.getElementById('timeline-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'timeline-tooltip';
        tooltip.className = 'custom-tooltip';
        tooltip.style.cssText = `
            position: fixed;
            background: linear-gradient(135deg, #1a1d26 0%, #14171e 100%);
            border: 1px solid rgba(124, 240, 255, 0.3);
            border-radius: 12px;
            padding: 16px;
            color: #eee;
            font-size: 0.85em;
            line-height: 1.6;
            z-index: 9999;
            box-shadow: 0 12px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(124, 240, 255, 0.1);
            pointer-events: none;
            max-width: 350px;
            backdrop-filter: blur(12px);
            opacity: 0;
            transform: translateY(5px);
            transition: opacity 0.2s ease, transform 0.2s ease;
        `;
        document.body.appendChild(tooltip);
    }
    tooltip.innerHTML = decodeTooltip(htmlContent);
    tooltip.style.display = 'block';

    requestAnimationFrame(() => {
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'translateY(0)';
    });

    const moveHandler = (evt) => {
        const x = evt.clientX + 18;
        const y = evt.clientY + 18;
        const maxX = window.innerWidth - 370;
        const maxY = window.innerHeight - tooltip.offsetHeight - 20;
        tooltip.style.left = Math.min(x, maxX) + 'px';
        tooltip.style.top = Math.min(y, maxY) + 'px';
    };
    moveHandler(e);
    document.addEventListener('mousemove', moveHandler);

    const hoverTarget = e.currentTarget || e.target;
    hoverTarget.onmouseleave = () => {
        tooltip.style.opacity = '0';
        tooltip.style.transform = 'translateY(5px)';
        setTimeout(() => {
            tooltip.style.display = 'none';
        }, 200);
        document.removeEventListener('mousemove', moveHandler);
    };
}

/**
 * Render batch event timeline (events mode)
 */
export async function renderBatchEventTimeline(timelineVisual, timelineEmptyState, activeBatch) {
    if (!timelineVisual || !timelineEmptyState) return;

    if (!activeBatch || !activeBatch._id) {
        timelineVisual.style.display = 'none';
        timelineEmptyState.style.display = 'block';
        scheduleTimelineScrollSync(false);
        return;
    }

    try {
        const json = await fetchBatchTimeline(activeBatch._id);
        const timeline = json.data?.timeline || [];

        if (!timeline.length) {
            timelineVisual.style.display = 'none';
            timelineEmptyState.style.display = 'block';
            scheduleTimelineScrollSync(false);
            return;
        }

        timelineVisual.style.display = 'block';
        timelineEmptyState.style.display = 'none';

        // Event definitions
        const renderableEvents = new Set([
            'prep_start', 'judge_warmup_start', 'judge_warmup_complete', 'tests_start',
            'model_warmup_complete', 'test_complete', 'judge_complete', 'error'
        ]);

        const eventVisuals = {
            prep_start: { icon: 'fa-plug', class: 'segment-warmup-judge', label: 'LLM Load' },
            judge_warmup_start: { icon: 'fa-gavel', class: 'segment-warmup-judge', label: 'Judge Warmup' },
            judge_warmup_complete: { icon: 'fa-check-circle', class: 'segment-warmup-judge', label: 'Judge Warmup Stabilized' },
            tests_start: { icon: 'fa-rocket', class: 'segment-running', label: 'Launching Tests' },
            model_warmup_complete: { icon: 'fa-bolt', class: 'segment-warmup', label: 'Model Warmup' },
            test_complete: { icon: 'fa-robot', class: 'segment-success', label: 'Test Complete' },
            judge_complete: { icon: 'fa-gavel', class: 'segment-judging', label: 'Judging Complete' },
            error: { icon: 'fa-exclamation-triangle', class: 'segment-error', label: 'Test Failed' }
        };

        // Filter and calculate timeline bounds
        const filtered = timeline.filter(event => renderableEvents.has(event.event));
        let maxEndMs = 0;
        filtered.forEach((event) => {
            const end = Number(event.time_since_start_ms) || 0;
            maxEndMs = Math.max(maxEndMs, end);
        });

        const totalDurationMs = Math.max(1, maxEndMs);
        const zoom = getTimelineZoom();
        const baseWidth = Math.max(600, Math.round((totalDurationMs / 1000) * 20));
        const trackWidth = Math.round(baseWidth * zoom);
        const scale = trackWidth / totalDurationMs;

        // Group events by lane
        const eventsByLane = new Map();
        filtered.forEach((event) => {
            const laneKey = getLaneKey(event);
            if (!eventsByLane.has(laneKey)) {
                eventsByLane.set(laneKey, []);
            }
            eventsByLane.get(laneKey).push(event);
        });

        // Build HTML (simplified)
        const rowsHtml = Array.from(eventsByLane.entries()).map(([laneKey, laneEvents]) => {
            laneEvents.sort((a, b) => (a.time_since_start_ms || 0) - (b.time_since_start_ms || 0));

            const segmentsHtml = laneEvents.map(event => {
                const visual = eventVisuals[event.event] || eventVisuals.test_complete;
                const endMs = Number(event.time_since_start_ms) || 0;
                const durationMs = Number(event.duration_ms) || 200;
                const startMs = Math.max(0, endMs - durationMs);
                const left = Math.round(startMs * scale);
                const width = Math.max(6, Math.round(durationMs * scale));

                return `<div class="timeline-segment ${visual.class}" style="position:absolute; left:${left}px; width:${width}px; height:20px;"></div>`;
            }).join('');

            return `
                <div class="timeline-model-row">
                    <div class="timeline-model-label">${escapeHtml(laneKey)}</div>
                    <div class="timeline-track-absolute" style="position:relative; width:${trackWidth}px; height:24px;">${segmentsHtml}</div>
                </div>
            `;
        }).join('');

        timelineVisual.innerHTML = `<div class="timeline-wrapper">${rowsHtml}</div>`;
        scheduleTimelineScrollSync(true);
    } catch (err) {
        console.error('Failed to render timeline:', err);
        timelineEmptyState.style.display = 'block';
        timelineVisual.style.display = 'none';
    }
}

/**
 * Get lane key for an event
 */
function getLaneKey(event) {
    const prepEvents = new Set(['prep_start', 'tests_start']);
    const judgePrepEvents = new Set(['judge_warmup_start', 'judge_warmup_complete']);

    if (prepEvents.has(event.event)) return 'Prep';
    if (judgePrepEvents.has(event.event)) return 'Judge Prep';

    const model = event.model || 'Unknown';
    if (event.event === 'judge_complete') return `${model} (Judge)`;
    return model;
}

/**
 * Update timeline display
 */
export function updateTimeline(batch) {
    // This is called during polling - simplified implementation
    // Full implementation would update the live timeline visual
}

/**
 * Format time in ms to human readable
 */
function formatTime(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms/1000).toFixed(1)}s`;
}

/**
 * Get result level number
 */
function getResultLevel(result) {
    if (!result) return null;
    const rawLevel = result.prompt_level
        ?? result.promptLevel
        ?? result.difficulty
        ?? result.level
        ?? result.test_level
        ?? result.testLevel;
    if (rawLevel === null || rawLevel === undefined) return null;
    const numeric = Number(rawLevel);
    if (Number.isFinite(numeric)) return numeric;
    const match = String(rawLevel).match(/\d+/);
    return match ? Number(match[0]) : null;
}

function normalizeString(value) {
    return (value || '').toString().trim().toLowerCase();
}

function getTimestampValue(result) {
    const ts = Date.parse(result?.timestamp);
    return Number.isFinite(ts) ? ts : 0;
}

function compareArrays(a, b) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
        const av = a[i];
        const bv = b[i];
        if (av === bv) continue;
        if (av === undefined) return -1;
        if (bv === undefined) return 1;
        if (av < bv) return -1;
        if (av > bv) return 1;
    }
    return 0;
}

function getPromptSortKey(result) {
    const level = getResultLevel(result);
    const levelSort = Number.isFinite(level) ? level : 999;
    const category = normalizeString(result?.prompt_category);
    const name = normalizeString(result?.prompt_name);
    const prompt = normalizeString(result?.prompt);
    const id = normalizeString(result?._id);
    return [levelSort, category, name, prompt, id];
}

function getResultComparator(order) {
    switch (order) {
        case 'prompt':
            return (a, b) => compareArrays(getPromptSortKey(a), getPromptSortKey(b));
        case 'level':
            return (a, b) => {
                const levelA = getResultLevel(a);
                const levelB = getResultLevel(b);
                const aLevel = Number.isFinite(levelA) ? levelA : 999;
                const bLevel = Number.isFinite(levelB) ? levelB : 999;
                if (aLevel !== bLevel) return aLevel - bLevel;
                return getTimestampValue(a) - getTimestampValue(b);
            };
        case 'quality':
            return (a, b) => {
                const qaRaw = Number(a?.quality_score);
                const qbRaw = Number(b?.quality_score);
                const qa = Number.isFinite(qaRaw) ? qaRaw : -1;
                const qb = Number.isFinite(qbRaw) ? qbRaw : -1;
                if (qa !== qb) return qb - qa;
                return getTimestampValue(a) - getTimestampValue(b);
            };
        case 'execution':
        default:
            return (a, b) => getTimestampValue(a) - getTimestampValue(b);
    }
}

/**
 * Load recent tests timeline - handles both 'results' and 'events' modes
 */
export async function loadRecentTestsTimeline() {
    try {
        // First check for active batch, then fall back to most recent batch
        const resActive = await fetchActiveBatches();

        let targetBatch = null;
        if (resActive.status === 'success' && resActive.data?.[0]) {
            targetBatch = resActive.data[0];
        }

        // If no active batch, get the most recent batch
        if (!targetBatch) {
            try {
                const resBatches = await fetch(`${BENCHMARK_API}/batches?limit=1`);
                if (resBatches.ok) {
                    const batchesJson = await resBatches.json();
                    const batches = batchesJson.data?.batches || batchesJson.data || [];
                    targetBatch = batches[0] || null;
                }
            } catch (err) {
                console.warn('Failed to fetch recent batches', err);
            }
        }

        let results = [];
        let batchTimeline = [];

        // Fetch results for the target batch
        if (targetBatch && targetBatch._id) {
            try {
                const [resResults, resTimeline] = await Promise.all([
                    fetch(`${BENCHMARK_API}/results/advanced?batchId=${targetBatch._id}&limit=5000`),
                    fetch(`${BENCHMARK_API}/batch/${targetBatch._id}/timeline`)
                ]);

                if (resResults.ok) {
                    const resultsJson = await resResults.json();
                    results = resultsJson.data?.results || [];
                }

                if (resTimeline.ok) {
                    const timelineJson = await resTimeline.json();
                    batchTimeline = timelineJson.data?.timeline || [];
                }
            } catch (err) {
                console.warn('Failed to load batch data', err);
            }
        }

        // Use targetBatch as activeBatch for compatibility with rest of function
        const activeBatch = targetBatch;

        // Update batch info label
        const batchInfoEl = document.getElementById('timelineBatchInfo');
        const batchLabelEl = document.getElementById('timelineBatchLabel');
        if (batchInfoEl && batchLabelEl) {
            if (targetBatch) {
                const batchName = targetBatch.name || targetBatch._id?.slice(-8) || 'Unknown';
                const status = targetBatch.status || 'unknown';
                const statusIcon = status === 'running' ? '<i class="fas fa-sync fa-spin"></i>' :
                                  status === 'completed' ? '<i class="fas fa-check-circle" style="color:#2ecc71"></i>' :
                                  status === 'failed' ? '<i class="fas fa-times-circle" style="color:#e74c3c"></i>' :
                                  '<i class="fas fa-clock"></i>';
                const resultCount = results.length;
                const modelCount = targetBatch.models?.length || new Set(results.map(r => r.model)).size;
                batchLabelEl.innerHTML = `${statusIcon} <strong>${escapeHtml(batchName)}</strong> &mdash; ${modelCount} model${modelCount !== 1 ? 's' : ''}, ${resultCount} test${resultCount !== 1 ? 's' : ''}`;
                batchInfoEl.style.display = 'block';
            } else {
                batchInfoEl.style.display = 'none';
            }
        }

        const timelineVisual = document.getElementById('timelineVisual');
        const timelineEmptyState = document.getElementById('timelineEmptyState');
        const statsSummaryEl = document.getElementById('timelineStatsSummary');
        const heatmapSectionEl = document.getElementById('performanceHeatmapSection');

        // Handle events mode
        if (timelineVisual && timelineEmptyState && getTimelineMode() === 'events') {
            if (statsSummaryEl) statsSummaryEl.style.display = 'none';
            if (heatmapSectionEl) heatmapSectionEl.style.display = 'none';
            await renderBatchEventTimeline(timelineVisual, timelineEmptyState, activeBatch);
            return;
        }

        // Handle results mode (rest of function)
        if (!results.length && !activeBatch) {
            if (timelineVisual) timelineVisual.style.display = 'none';
            if (timelineEmptyState) timelineEmptyState.style.display = 'block';
            if (batchInfoEl) batchInfoEl.style.display = 'none';
            scheduleTimelineScrollSync(false);
            return;
        }

        // Check for new results only (incremental update)
        const currentResultIds = new Set(results.map(r => r._id));
        const hasNewResults = results.some(r => !lastTimelineResultIds.has(r._id));

        // Create a hash of the result data to detect updates (not just new results)
        const resultHash = results.map(r => `${r._id}-${r.success}-${r.quality_score ?? 'null'}`).join('|');
        const timelineHash = batchTimeline
            .map(e => `${e.event}-${e.model || ''}-${e.time_since_start_ms || 0}-${e.duration_ms || 0}-${e.success}`)
            .join('|');
        const timelineOrder = getTimelineOrder();
        const combinedHash = `${resultHash}::${timelineHash}::${timelineOrder}`;

        // If no new results and data hasn't changed, skip the full re-render
        if (!hasNewResults && lastTimelineResultIds.size > 0 && lastTimelineHash === combinedHash) {
            return;
        }

        lastTimelineResultIds = currentResultIds;
        lastTimelineHash = combinedHash;

        if (timelineVisual) timelineVisual.style.display = 'block';
        if (timelineEmptyState) timelineEmptyState.style.display = 'none';

        // Sort by timestamp (oldest first)
        const sorted = [...results].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Calculate global averages for comparison
        const globalStats = {
            avgLatency: 0,
            avgTps: 0,
            avgQuality: 0,
            avgJudgeTime: 0,
            successRate: 0
        };

        if (sorted.length > 0) {
            const validLatencies = sorted.filter(r => r.latency).map(r => r.latency);
            const validTps = sorted
                .map(r => parseFloat(r.tokens_per_sec))
                .filter(v => !isNaN(v) && v > 0);
            const validQuality = sorted.filter(r => r.quality_score != null).map(r => r.quality_score);
            const validJudge = sorted.filter(r => r.scoring_time_ms != null).map(r => r.scoring_time_ms);
            const successCount = sorted.filter(r => r.success).length;

            globalStats.avgLatency = validLatencies.length ? validLatencies.reduce((a,b) => a+b, 0) / validLatencies.length : 0;
            globalStats.avgTps = validTps.length ? validTps.reduce((a,b) => a+b, 0) / validTps.length : 0;
            globalStats.avgQuality = validQuality.length ? validQuality.reduce((a,b) => a+b, 0) / validQuality.length : 0;
            globalStats.avgJudgeTime = validJudge.length ? validJudge.reduce((a,b) => a+b, 0) / validJudge.length : 0;
            globalStats.successRate = (successCount / sorted.length) * 100;
        }

        // Group results by model
        const resultsByModel = new Map();
        sorted.forEach((result) => {
            const model = result.model || 'Unknown Model';
            if (!resultsByModel.has(model)) {
                resultsByModel.set(model, []);
            }
            resultsByModel.get(model).push(result);
        });

        const resultComparator = getResultComparator(timelineOrder);
        for (const modelResults of resultsByModel.values()) {
            modelResults.sort(resultComparator);
        }

        const prepEventTypes = new Set([
            'prep_start',
            'judge_warmup_start',
            'judge_warmup_complete',
            'tests_start'
        ]);
        const prepLaneEvents = batchTimeline
            .filter(event => prepEventTypes.has(event.event))
            .sort((a, b) => (a.time_since_start_ms || 0) - (b.time_since_start_ms || 0));

        const modelWarmups = new Map();
        batchTimeline.forEach((event) => {
            if (event.event !== 'model_warmup_complete' || !event.model) return;
            const current = modelWarmups.get(event.model);
            const time = Number(event.time_since_start_ms) || 0;
            if (!current || time < current.time_since_start_ms) {
                modelWarmups.set(event.model, event);
            }
        });

        // Ensure active model is in the map if it doesn't have results yet
        if (activeBatch && activeBatch.status === 'running' && activeBatch.model) {
            if (!resultsByModel.has(activeBatch.model)) {
                resultsByModel.set(activeBatch.model, []);
            }
        }
        for (const model of modelWarmups.keys()) {
            if (!resultsByModel.has(model)) {
                resultsByModel.set(model, []);
            }
        }

        const stageVisuals = {
            test: { icon: 'fa-robot', class: 'segment-success' },
            'test-error': { icon: 'fa-exclamation-triangle', class: 'segment-error' },
            judging: { icon: 'fa-gavel', class: 'segment-judging' },
            running: { icon: 'fa-cog fa-spin', class: 'segment-running' },
            queued: { icon: 'fa-clock', class: 'segment-queued' },
            warmup: { icon: 'fa-bolt', class: 'segment-warmup' },
            'judge-prep': { icon: 'fa-gavel', class: 'segment-warmup-judge' }
        };

        const getSegmentVisual = (result) => {
            if (result.__lane === 'judge_prep') return stageVisuals['judge-prep'];
            if (result.__lane === 'model_warmup') return stageVisuals['warmup'];
            if (result.success === false) return stageVisuals['test-error'];
            if (result.success) {
                const level = getResultLevel(result);
                if (Number.isFinite(level) && level >= 1 && level <= 10) {
                    return { icon: 'fa-check-circle', class: `segment-level-${level}` };
                }
            }
            return stageVisuals['test'];
        };

        let rowsHtml = '';

        // Calculate global max latency for proportional width scaling ("race view")
        let globalMaxLatency = 0;
        for (const modelResults of resultsByModel.values()) {
            for (const r of modelResults) {
                const lat = r.latency || 0;
                if (lat > globalMaxLatency) globalMaxLatency = lat;
            }
        }
        for (const event of prepLaneEvents) {
            const dur = Number(event.duration_ms) || 0;
            if (dur > globalMaxLatency) globalMaxLatency = dur;
        }
        for (const warmup of modelWarmups.values()) {
            const dur = Number(warmup.duration_ms) || 0;
            if (dur > globalMaxLatency) globalMaxLatency = dur;
        }
        // Ensure a minimum max to avoid division issues
        if (globalMaxLatency < 500) globalMaxLatency = 500;

        // Calculate total duration per model for "race view" scaling
        const modelTotalDurations = new Map();
        for (const [model, modelResults] of resultsByModel.entries()) {
            const warmup = modelWarmups.get(model);
            const warmupTime = warmup ? (Number(warmup.duration_ms) || 0) : 0;
            const testsTime = modelResults.reduce((sum, r) => sum + (r.latency || 0), 0);
            modelTotalDurations.set(model, warmupTime + testsTime);
        }

        // Find the max total duration (this model fills the track)
        let maxTotalDuration = 0;
        for (const total of modelTotalDurations.values()) {
            if (total > maxTotalDuration) maxTotalDuration = total;
        }
        if (maxTotalDuration < 1000) maxTotalDuration = 1000;

        // Get actual track width dynamically from the container
        const timelineContainer = document.getElementById('timelineVisual');
        const containerWidth = timelineContainer ? timelineContainer.offsetWidth : 1200;
        // Account for label width (~180px) and padding (~40px)
        const TRACK_WIDTH = Math.max(400, containerWidth - 220);

        // Calculate pixel width for a segment based on its duration
        const calcSegmentWidth = (durationMs) => {
            if (!durationMs || durationMs <= 0) return 6;
            const width = Math.round((durationMs / maxTotalDuration) * TRACK_WIDTH);
            return Math.max(6, Math.min(width, TRACK_WIDTH));
        };

        const prepEventVisuals = {
            prep_start: { icon: 'fa-plug', class: 'segment-warmup-judge', label: 'Prep Started' },
            judge_warmup_start: { icon: 'fa-gavel', class: 'segment-warmup-judge', label: 'Judge Warmup' },
            judge_warmup_complete: { icon: 'fa-check-circle', class: 'segment-warmup-judge', label: 'Judge Warmup Stabilized' },
            tests_start: { icon: 'fa-rocket', class: 'segment-running', label: 'Launching Tests' }
        };

        if (prepLaneEvents.length > 0) {
            const prepSegmentsHtml = prepLaneEvents.map((event) => {
                const visual = prepEventVisuals[event.event] || prepEventVisuals.prep_start;
                const durationMs = Number(event.duration_ms) || 0;
                const widthPx = calcSegmentWidth(durationMs || 500);
                const tooltipHtml = `
                    <div style="border-bottom: 1px solid rgba(124, 240, 255, 0.2); padding-bottom: 6px; margin-bottom: 6px;">
                        <strong><i class="fas ${visual.icon}" style="margin-right: 8px; color: var(--accent);"></i>${escapeHtml(visual.label)}</strong>
                    </div>
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 6px 12px;">
                        ${event.model ? `
                        <span style="color: rgba(255,255,255,0.6);">Model:</span>
                        <span style="font-weight: 600;">${escapeHtml(event.model)}</span>
                        ` : ''}
                        ${durationMs ? `
                        <span style="color: rgba(255,255,255,0.6);">Duration:</span>
                        <span style="font-weight: 600;">${formatTime(durationMs)}</span>
                        ` : ''}
                        ${event.error ? `
                        <span style="color: rgba(255,255,255,0.6);">Note:</span>
                        <span style="color: rgba(255,255,255,0.6);">${escapeHtml(event.error)}</span>
                        ` : ''}
                    </div>
                `.trim();
                const tooltipEncoded = encodeTooltip(tooltipHtml);
                return `
                    <div class="timeline-segment-group" style="width: ${widthPx}px;" onmouseenter="showTimelineTooltip(event, '${tooltipEncoded}')">
                        <div class="timeline-segment ${visual.class}" style="width: 100%;">
                        </div>
                    </div>
                `;
            }).join('');

            rowsHtml += `
                <div class="timeline-model-row prep-lane">
                    <div class="timeline-model-label">
                        Prep <span class="prep-lane-badge">Prep</span>
                    </div>
                    <div class="timeline-track">
                        ${prepSegmentsHtml}
                    </div>
                </div>
            `;
        }

        const orderedModels = [];
        const preferredModels = activeBatch && Array.isArray(activeBatch.models) ? activeBatch.models : [];
        preferredModels.forEach((model) => {
            if (resultsByModel.has(model)) orderedModels.push(model);
        });
        for (const model of resultsByModel.keys()) {
            if (!orderedModels.includes(model)) orderedModels.push(model);
        }

        // Iterate over models to build rows
        for (const model of orderedModels) {
            const modelResults = resultsByModel.get(model) || [];
            let segmentsHtml = '';

            const warmupEvent = modelWarmups.get(model);

            if (warmupEvent) {
                const durationMs = Number(warmupEvent.duration_ms) || 0;
                const warmupWidthPx = calcSegmentWidth(durationMs);
                const tooltipHtml = `
                    <div style="border-bottom: 1px solid rgba(124, 240, 255, 0.2); padding-bottom: 6px; margin-bottom: 6px;">
                        <strong><i class="fas fa-bolt" style="margin-right: 8px; color: var(--accent);"></i>Model Warmup Ready</strong>
                    </div>
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 6px 12px;">
                        <span style="color: rgba(255,255,255,0.6);">Model:</span>
                        <span style="font-weight: 600;">${escapeHtml(model)}</span>
                        ${durationMs ? `
                        <span style="color: rgba(255,255,255,0.6);">Duration:</span>
                        <span style="font-weight: 600;">${formatTime(durationMs)}</span>
                        ` : ''}
                        ${warmupEvent.error ? `
                        <span style="color: rgba(255,255,255,0.6);">Note:</span>
                        <span style="color: rgba(255,255,255,0.6);">${escapeHtml(warmupEvent.error)}</span>
                        ` : ''}
                    </div>
                `.trim();
                const tooltipEncoded = encodeTooltip(tooltipHtml);
                segmentsHtml += `
                    <div class="timeline-segment-group" style="width: ${warmupWidthPx}px;" onmouseenter="showTimelineTooltip(event, '${tooltipEncoded}')">
                        <div class="timeline-segment segment-warmup" style="width: 100%;">
                        </div>
                    </div>
                `;
            }

            segmentsHtml += modelResults.map((result, idx) => {
                const visual = getSegmentVisual(result);
                const inferenceTime = result.latency || 0;
                const judgingTime = result.scoring_time_ms || 0;
                const totalTime = inferenceTime + judgingTime;

                const inferenceStr = formatTime(inferenceTime);
                const judgingStr = formatTime(judgingTime);
                const totalStr = formatTime(totalTime);

                const qualityScore = Number.isFinite(result.quality_score)
                    ? result.quality_score
                    : null;
                const levelNumber = getResultLevel(result);

                // Tooltip HTML for Custom Tooltip with Performance Comparisons
                const promptTextRaw = result.prompt ? (result.prompt.length > 80 ? result.prompt.substring(0, 80) + '...' : result.prompt) : 'No prompt';
                const promptText = escapeHtml(promptTextRaw);
                const responseTextRaw = result.response ? (result.response.length > 200 ? result.response.substring(0, 200) + '...' : result.response) : '';
                const responseText = escapeHtml(responseTextRaw);
                const modelName = escapeHtml(result.model || 'Unknown Model');

                // Performance indicators
                const hasBaseline = Number.isFinite(globalStats.avgLatency) && globalStats.avgLatency > 0;
                const latencyDiff = hasBaseline ? ((inferenceTime - globalStats.avgLatency) / globalStats.avgLatency * 100).toFixed(0) : 0;
                const latencyIndicator = hasBaseline
                    ? (inferenceTime < globalStats.avgLatency
                        ? `<span style="color:#2ecc71">▼ ${Math.abs(latencyDiff)}% faster</span>`
                        : (inferenceTime > globalStats.avgLatency
                            ? `<span style="color:#e74c3c">▲ ${latencyDiff}% slower</span>`
                            : '<span style="color:#95a5a6">● average</span>'))
                    : '<span style="color:#95a5a6">● average</span>';

                const qualityDiff = globalStats.avgQuality && Number.isFinite(qualityScore)
                    ? ((qualityScore - globalStats.avgQuality) / globalStats.avgQuality * 100).toFixed(0)
                    : 0;
                const qualityIndicator = Number.isFinite(qualityScore) && globalStats.avgQuality
                    ? (qualityScore > globalStats.avgQuality
                        ? `<span style="color:#2ecc71">▲ ${Math.abs(qualityDiff)}% above avg</span>`
                        : (qualityScore < globalStats.avgQuality
                            ? `<span style="color:#e74c3c">▼ ${Math.abs(qualityDiff)}% below avg</span>`
                            : '<span style="color:#95a5a6">● average</span>'))
                    : '';

                // Parse tokens_per_sec (handles both string and number types)
                const tokensPerSec = parseFloat(result.tokens_per_sec);
                const tpsDisplay = !isNaN(tokensPerSec) && tokensPerSec > 0 ? `${tokensPerSec.toFixed(1)} tok/s` : '-';
                const tpsDiff = globalStats.avgTps && !isNaN(tokensPerSec) ? ((tokensPerSec - globalStats.avgTps) / globalStats.avgTps * 100).toFixed(0) : 0;
                const tpsIndicator = !isNaN(tokensPerSec) && tokensPerSec > 0 && globalStats.avgTps ? (tokensPerSec > globalStats.avgTps ? `<span style="color:#2ecc71">▲ ${Math.abs(tpsDiff)}%</span>` : (tokensPerSec < globalStats.avgTps ? `<span style="color:#e74c3c">▼ ${Math.abs(tpsDiff)}%</span>` : '<span style="color:#95a5a6">●</span>')) : '';

                const tooltipHtml = `
                    <div style="border-bottom: 2px solid rgba(124, 240, 255, 0.3); padding-bottom: 8px; margin-bottom: 10px;">
                        <h4 style="margin: 0 0 4px; color: #7cf0ff; font-size: 1.15em; font-weight: 600;"><i class="fas ${visual.icon}" style="margin-right: 8px;"></i>${modelName}</h4>
                        <div style="font-size: 0.8em; color: rgba(255,255,255,0.6);">${new Date(result.timestamp).toLocaleString()}</div>
                    </div>
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; margin-bottom: 10px;">
                        <span style="color: rgba(255,255,255,0.6);">Status:</span>
                        <span style="font-weight: 600; color:${result.success?'#2ecc71':'#e74c3c'}">
                            ${result.success ? '<i class="fas fa-check-circle"></i> Success' : '<i class="fas fa-times-circle"></i> Failed'}
                        </span>

                        <span style="color: rgba(255,255,255,0.6);">Total Time:</span>
                        <span style="font-weight: 600;">${totalStr}</span>

                        <span style="color: rgba(255,255,255,0.6);">Inference:</span>
                        <div>
                            <span style="font-weight: 600;">${inferenceStr}</span>
                            <span style="font-size: 0.85em; margin-left: 6px;">${latencyIndicator}</span>
                        </div>

                        ${judgingTime ? `
                        <span style="color: rgba(255,255,255,0.6);">Judging:</span>
                        <span style="font-weight: 600; color:#9b59b6">${judgingStr}</span>
                        ` : ''}

                        ${Number.isFinite(qualityScore) ? `
                        <span style="color: rgba(255,255,255,0.6);">Quality:</span>
                        <div>
                            <span style="font-weight: 600; color:#f39c12">Q${qualityScore.toFixed(1)} / 10</span>
                            <span style="font-size: 0.85em; margin-left: 6px;">${qualityIndicator}</span>
                        </div>
                        ` : ''}

                        ${result.tokens_per_sec ? `
                        <span style="color: rgba(255,255,255,0.6);">Throughput:</span>
                        <div>
                            <span style="font-weight: 600;">${tpsDisplay}</span>
                            <span style="font-size: 0.85em; margin-left: 6px;">${tpsIndicator}</span>
                        </div>
                        ` : ''}

                        ${Number.isFinite(levelNumber) && levelNumber >= 1 ? `
                        <span style="color: rgba(255,255,255,0.6);">Difficulty:</span>
                        <span style="font-weight: 600;">Level ${levelNumber}</span>
                        ` : ''}
                    </div>
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1);">
                        <div style="color: rgba(255,255,255,0.5); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Prompt:</div>
                        <div style="color: rgba(255,255,255,0.7); font-style: italic; font-size: 0.85em; line-height: 1.4;">
                            <i class="fas fa-quote-left" style="font-size: 0.7em; opacity: 0.5; margin-right: 4px;"></i>${promptText}<i class="fas fa-quote-right" style="font-size: 0.7em; opacity: 0.5; margin-left: 4px;"></i>
                        </div>
                    </div>
                    ${responseText ? `
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.05);">
                        <div style="color: rgba(255,255,255,0.5); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Response:</div>
                        <div style="color: rgba(124, 240, 255, 0.8); font-size: 0.85em; line-height: 1.4; max-height: 100px; overflow-y: auto;">
                            ${responseText}
                        </div>
                    </div>
                    ` : ''}
                `.trim();
                const tooltipEncoded = encodeTooltip(tooltipHtml);

                // Width proportional to latency - race view effect
                const widthPx = calcSegmentWidth(inferenceTime);

                // Single segment block showing inference only
                return `
                    <div class="timeline-segment-group" style="width: ${widthPx}px;" onmouseenter="showTimelineTooltip(event, '${tooltipEncoded}')">
                        <div class="timeline-segment ${visual.class}" style="width: 100%;">
                        </div>
                    </div>`;
            }).join('');

            // Check for Active State - IMPROVED LOGIC
            if (activeBatch && activeBatch.status === 'running' && activeBatch.model === model) {
                const currentTest = activeBatch.current_test;

                let activeStage = 'running';
                let activeText = 'Running...';
                let activeIcon = 'fa-cog fa-spin';
                let bubbleText = 'Processing Test...';

                if (currentTest) {
                    if (currentTest.stage === 'judging' || (activeBatch.current_phase === 'judging')) {
                        activeStage = 'judging';
                        activeText = 'Judging';
                        activeIcon = 'fa-gavel';
                        const promptSnippet = currentTest.prompt ? (currentTest.prompt.length > 20 ? currentTest.prompt.substring(0, 20) + '...' : currentTest.prompt) : 'Response';
                        bubbleText = `Judging: ${escapeHtml(promptSnippet)}...`;
                    } else {
                        const promptSnippet = currentTest.prompt ? (currentTest.prompt.length > 20 ? currentTest.prompt.substring(0, 20) + '...' : currentTest.prompt) : 'Prompt';
                        bubbleText = `Running: ${escapeHtml(promptSnippet)}...`;
                    }
                }

                const visualClass = stageVisuals[activeStage].class;

                // Force append to the track so it's always visible at end
                segmentsHtml += `
                <div class="timeline-segment-group" style="width: 140px; opacity: 1; margin-left:8px; display:flex; flex-direction:column; justify-content:center; align-items:flex-start; overflow:visible;">
                    <div class="timeline-segment ${visualClass}" style="width: 100%; height: 20px; margin-bottom: 2px;">
                        <span>${activeText}</span>
                    </div>
                    <div style="font-size:0.7em; color:var(--accent); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px; padding-left:4px;">
                        ${bubbleText}
                    </div>
                </div>`;
            }

            const safeModelLabel = escapeHtml(model);

            rowsHtml += `
            <div class="timeline-model-row">
                <div class="timeline-model-label">
                    ${safeModelLabel}
                </div>
                <div class="timeline-track">
                    ${segmentsHtml}
                </div>
            </div>`;
        }

        if (timelineVisual) {
            timelineVisual.innerHTML = `
                <div class="timeline-wrapper">
                    ${rowsHtml}
                </div>
            `;
        }
        scheduleTimelineScrollSync(true);

        // Populate Performance Summary Panel
        renderStatsSummary(sorted, globalStats);

        // Populate Collapsible Execution Timeline (event list)
        renderEventList(batchTimeline);

        // Generate Performance Heatmap
        renderPerformanceHeatmap(resultsByModel);

    } catch (err) {
        console.error('Failed to load timeline:', err);
        const timelineVisual = document.getElementById('timelineVisual');
        if (timelineVisual && !timelineVisual.innerHTML.trim()) {
             timelineVisual.innerHTML = `<div style="padding:20px; text-align:center; color:var(--muted)">Failed to load timeline data</div>`;
        }
    }
}

// Expose to window for inline handlers
if (typeof window !== 'undefined') {
    window.showTimelineTooltip = showTimelineTooltip;
}
