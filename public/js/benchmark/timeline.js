// timeline.js - renderBatchEventTimeline and related functions

import * as state from './state.js';
import { BENCHMARK_API } from './state.js';
import { escapeHtml, encodeTooltip, decodeTooltip, summarizeNumbers } from './utils.js';
import { fetchBatchTimeline, fetchActiveBatches, fetchAdvancedResults } from './api.js';

/**
 * Get timeline mode from selector
 */
export function getTimelineMode() {
    const modeSelect = document.getElementById('timelineMode');
    return modeSelect ? modeSelect.value : 'results';
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
 * Render batch event timeline
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
 * Load recent tests timeline
 */
export async function loadRecentTestsTimeline() {
    try {
        const resActive = await fetchActiveBatches();
        let targetBatch = resActive.status === 'success' && resActive.data?.[0] ? resActive.data[0] : null;

        // If no active batch, get most recent
        if (!targetBatch) {
            try {
                const res = await fetch(`${BENCHMARK_API}/batches?limit=1`);
                if (res.ok) {
                    const json = await res.json();
                    const batches = json.data?.batches || json.data || [];
                    targetBatch = batches[0] || null;
                }
            } catch (err) {
                console.warn('Failed to fetch recent batches', err);
            }
        }

        const timelineVisual = document.getElementById('timelineVisual');
        const timelineEmptyState = document.getElementById('timelineEmptyState');

        if (timelineVisual && timelineEmptyState && getTimelineMode() === 'events') {
            await renderBatchEventTimeline(timelineVisual, timelineEmptyState, targetBatch);
        }
    } catch (err) {
        console.error('Failed to load timeline:', err);
    }
}

// Expose to window for inline handlers
if (typeof window !== 'undefined') {
    window.showTimelineTooltip = showTimelineTooltip;
}
