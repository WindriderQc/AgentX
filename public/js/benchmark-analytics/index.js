/**
 * Benchmark Analytics Enhancements
 * Provides advanced analytics UI components for benchmark system
 * - Configuration Presets
 * - Real-Time Active Batch Monitoring
 * - Performance Trends Charts
 * - Batch Comparison
 * - Tag Management
 */

// Import from config
import { currentFilters, resetFilters, resetTruncationState } from './config.js';

// Import from modules
import { startActiveMonitoring, stopActiveMonitoring, loadActiveStats } from './monitoring.js';
import { loadPresets, applyPreset } from './presets.js';
import {
    loadTrends,
    loadTimeline,
    loadBatchHistory,
    loadTagStats,
    filterByTag,
    filterByModelCategory,
    filterByPromptCategory,
    getActiveFilters,
    clearAllFilters
} from './trends.js';
import {
    restoreCompareSelections,
    loadJudgeStats,
    setupJudgeCompareUI,
    loadJudgeBreakdown
} from './judges.js';
import { compareBatches, exportComparisonCSV } from './comparison.js';
import {
    loadTruncationStats,
    setupTruncationWidget,
    applyTruncationFilter,
    openTruncationInspector,
    setupInspectorModal
} from './truncation.js';
import { showToast } from './utils.js';

/**
 * Initialize all analytics components
 */
function init() {
    restoreCompareSelections();
    loadPresets();
    startActiveMonitoring();
    if (document.getElementById('trendsChart')) {
        loadTrends();
    }
    loadTagStats();
    loadJudgeStats();
    loadBatchHistory(); // Populate batch dropdowns
    setupEventListeners();

    // New compare UIs
    setupJudgeCompareUI();

    // Truncation stats widget
    setupTruncationWidget();
    setupInspectorModal();
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

/**
 * Placeholder for capability analysis (removed - now in compare-insights.html)
 */
function loadCapabilityAnalysis(model) {
    // Capability analysis moved to compare-insights.html
    console.log('Capability analysis for model:', model);
}

/**
 * Setup responsive helpers for mobile/tablet/desktop
 */
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

    console.log('Benchmark responsive helpers loaded!');
    console.log(`Screen: ${window.innerWidth}x${window.innerHeight}`);
    console.log(`Mobile: ${isMobile}, Touch: ${isTouch}, Ultra-Wide: ${isUltraWide}`);
}

// Public API object
const BenchmarkAnalytics = {
    init,
    applyPreset,
    loadTrends,
    loadActiveStats,
    loadTagStats,
    loadJudgeStats,
    loadTruncationStats,
    setupTruncationWidget,
    applyTruncationFilter,
    openTruncationInspector,
    resetTruncationState,
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

// Export for ES6 module usage
export default BenchmarkAnalytics;
