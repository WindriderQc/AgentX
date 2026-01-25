// timeline.js - renderBatchEventTimeline and related functions

import * as state from './state.js';
import { BENCHMARK_API } from './state.js';
import { escapeHtml, encodeTooltip, decodeTooltip, summarizeNumbers } from './utils.js';
import { fetchBatchTimeline, fetchActiveBatches, fetchAdvancedResults } from './api.js';

// Track previous result IDs for incremental update detection
let lastTimelineResultIds = new Set();

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
        const resultHash = results.map(r => `${r._id}-${r.success}-${r.quality_score || 'null'}`).join('|');
        const timelineHash = batchTimeline
            .map(e => `${e.event}-${e.model || ''}-${e.time_since_start_ms || 0}-${e.duration_ms || 0}-${e.success}`)
            .join('|');
        const timelineOrder = getTimelineOrder();
        const combinedHash = `${resultHash}::${timelineHash}::${timelineOrder}`;

        // If no new results and data hasn't changed, skip the full re-render
        if (!hasNewResults && lastTimelineResultIds.size > 0 && window.lastTimelineHash === combinedHash) {
            return;
        }

        lastTimelineResultIds = currentResultIds;
        window.lastTimelineHash = combinedHash;

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
            const validQuality = sorted.filter(r => r.quality_score).map(r => r.quality_score);
            const validJudge = sorted.filter(r => r.scoring_time_ms).map(r => r.scoring_time_ms);
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
        const statsSummary = document.getElementById('timelineStatsSummary');
        if (statsSummary && sorted.length > 0) {
            // Calculate percentiles for latency
            const latencies = sorted.filter(r => r.latency).map(r => r.latency).sort((a, b) => a - b);
            const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
            const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;
            const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)] : 0;

            const totalTests = sorted.length;
            const successCount = sorted.filter(r => r.success).length;
            const successRate = ((successCount / totalTests) * 100).toFixed(1);
            const avgTps = globalStats.avgTps > 0 ? globalStats.avgTps.toFixed(1) : '0.0';
            const avgQuality = globalStats.avgQuality.toFixed(1);

            const formatMs = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;

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

        // Generate Performance Heatmap
        const heatmapSection = document.getElementById('performanceHeatmapSection');
        const heatmapContainer = document.getElementById('performanceHeatmap');
        if (heatmapContainer && resultsByModel.size > 1) {
            // Calculate per-model stats
            const modelStats = [];
            for (const [model, modelResults] of resultsByModel.entries()) {
                if (modelResults.length === 0) continue;

                const successCount = modelResults.filter(r => r.success).length;
                const failCount = modelResults.length - successCount;
                const successRate = (successCount / modelResults.length) * 100;
                const latencies = modelResults.filter(r => r.latency).map(r => r.latency);
                const qualities = modelResults.filter(r => r.quality_score).map(r => r.quality_score);
                const tps = modelResults
                    .map(r => parseFloat(r.tokens_per_sec))
                    .filter(v => !isNaN(v) && v > 0);

                const latencyStats = summarizeNumbers(latencies);
                const qualityStats = summarizeNumbers(qualities);
                const tpsStats = summarizeNumbers(tps);

                const avgLatency = latencyStats.mean || 0;
                const avgQuality = qualityStats.mean || 0;
                const avgTps = tpsStats.mean || 0;

                modelStats.push({
                    model,
                    successRate,
                    avgLatency,
                    avgQuality,
                    avgTps,
                    testCount: modelResults.length,
                    successCount,
                    failCount,
                    latencyStats,
                    qualityStats,
                    tpsStats
                });
            }

            if (modelStats.length > 0) {
                // Find min/max for normalization
                const latencyMeans = modelStats.map(m => m.avgLatency).filter(l => Number.isFinite(l) && l > 0);
                const minLatency = latencyMeans.length ? Math.min(...latencyMeans) : 0;
                const maxLatency = latencyMeans.length ? Math.max(...latencyMeans) : 0;

                const tpsMeans = modelStats.map(m => m.avgTps).filter(v => Number.isFinite(v) && v > 0);
                const maxTps = tpsMeans.length ? Math.max(...tpsMeans) : 0;

                // Themed color scale function (0-100) using test level themes
                const getHeatColor = (value, reverse = false) => {
                    if (reverse) value = 100 - value;
                    if (value >= 80) return 'linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%)';
                    if (value >= 60) return 'linear-gradient(135deg, #10b981 0%, #34d399 100%)';
                    if (value >= 40) return 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)';
                    if (value >= 20) return 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)';
                    return 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)';
                };

                const getHeatLabel = (value) => {
                    if (!Number.isFinite(value)) return '—';
                    if (value >= 80) return 'Great';
                    if (value >= 60) return 'Good';
                    if (value >= 40) return 'OK';
                    if (value >= 20) return 'Low';
                    return 'Poor';
                };

                const statByModel = new Map(modelStats.map(s => [s.model, s]));

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

                                const formatMs = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;
                                const safeModel = escapeHtml(stat.model);

                                return `
                                    <tr style="transition: all 0.2s ease;">
                                        <td style="padding: 10px 12px; color: var(--text); font-weight: 600; background: rgba(0,0,0,0.2); border-radius: 4px; cursor: help;" class="heatmap-cell" data-model="${safeModel}" data-metric="model" data-score="" title="${safeModel}">
                                            ${safeModel}
                                        </td>
                                        <td style="padding: 10px 12px; text-align: center; color: var(--text); background: rgba(0,0,0,0.2); border-radius: 4px; cursor: help;" class="heatmap-cell" data-model="${safeModel}" data-metric="tests" data-score="" title="Tests: ${stat.testCount} (pass ${stat.successCount}, fail ${stat.failCount})">
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
                const formatMsLegend = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;
                if (legendLatencyEl) {
                    legendLatencyEl.textContent = (minLatency > 0 && maxLatency > 0)
                        ? `Latency scale: ${formatMsLegend(minLatency)} → ${formatMsLegend(maxLatency)} (avg)`
                        : 'Latency scale: —';
                }
                if (legendTpsEl) {
                    legendTpsEl.textContent = (maxTps > 0)
                        ? `Throughput scale: 0 → ${maxTps.toFixed(1)} tok/s (avg)`
                        : 'Throughput scale: —';
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
                const fmtMs = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
                const fmtOrDash = (v, fmt) => (Number.isFinite(v) ? fmt(v) : '—');

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
                            : `${metricLabel} • ${scoreLabel}`;

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
                            <div class="k">Latency</div><div class="v">avg ${fmtMs(stat.avgLatency)} • p50 ${fmtOrDash(latencyP50, fmtMs)} • p95 ${fmtOrDash(latencyP95, fmtMs)}</div>
                            <div class="k">Quality</div><div class="v">avg ${fmtQ(stat.avgQuality)} • p50 ${fmtOrDash(qP50, fmtQ)} • p10 ${fmtOrDash(qP10, fmtQ)}</div>
                            <div class="k">Throughput</div><div class="v">avg ${fmtTok(stat.avgTps)} • p50 ${fmtOrDash(tpsP50, fmtTok)} • p10 ${fmtOrDash(tpsP10, fmtTok)}</div>
                        </div>
                    `;
                };

                const cells = heatmapContainer.querySelectorAll('.heatmap-cell');
                cells.forEach(cell => {
                    cell.addEventListener('mouseenter', function(evt) {
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
                    cell.addEventListener('mouseleave', function() {
                        this.style.transform = 'scale(1)';
                        this.style.zIndex = '1';
                        hideTooltip();
                    });
                });
            }
        }

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
