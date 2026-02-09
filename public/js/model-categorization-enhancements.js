// ===============================================
// MODEL CATEGORIZATION PAGE ENHANCEMENTS
// Keyboard Shortcuts, Search/Filter, Export, Chart Skeletons
// ===============================================

// Global state
let activeFilters = new Set();

// ===============================================
// KEYBOARD SHORTCUTS
// ===============================================

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveDirtyCategories();
        }

        if (e.key === 'Escape') {
            const searchInput = document.getElementById('modelSearchInput');
            if (searchInput && searchInput.value) {
                searchInput.value = '';
                filterModels();
                document.getElementById('clearSearchBtn').style.display = 'none';
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
            e.preventDefault();
            exportCsv();
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'a' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            document.querySelectorAll('.model-select').forEach(cb => cb.checked = true);
            if (typeof updateSelectedCount === 'function') updateSelectedCount();
        }

        if (e.key === '?' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            showShortcutsModal();
        }
    });
}

function showShortcutsModal() {
    document.getElementById('shortcutsModal')?.classList.add('active');
}

function closeShortcutsModal() {
    document.getElementById('shortcutsModal')?.classList.remove('active');
}

window.closeShortcutsModal = closeShortcutsModal;

document.addEventListener('click', (e) => {
    const modal = document.getElementById('shortcutsModal');
    if (modal && e.target === modal) closeShortcutsModal();
});

function saveDirtyCategories() {
    const dirtyRows = document.querySelectorAll('tr.dirty');
    if (dirtyRows.length === 0) {
        if (typeof showToast === 'function') showToast('No changes to save', 'warning');
        return;
    }

    let saved = 0;
    dirtyRows.forEach(row => {
        const saveBtn = row.querySelector('[id^="save-"]');
        if (saveBtn && !saveBtn.disabled) {
            saveBtn.click();
            saved++;
        }
    });

    if (saved > 0 && typeof showToast === 'function') {
        showToast(`Saving ${saved} model(s)...`, 'success');
    }
}

// ===============================================
// SEARCH & FILTER
// ===============================================

function setupSearchAndFilter() {
    const searchInput = document.getElementById('modelSearchInput');
    const clearBtn = document.getElementById('clearSearchBtn');
    const filterChipsContainer = document.getElementById('categoryFilterChips');

    if (!searchInput || !filterChipsContainer) return;

    let searchDebounce;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            filterModels();
            clearBtn.style.display = e.target.value ? 'block' : 'none';
        }, 300);
    });

    clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        filterModels();
    });

    if (typeof CATEGORIES !== 'undefined') {
        CATEGORIES.forEach(cat => {
            const chip = document.createElement('div');
            chip.className = 'filter-chip';

            const icon = typeof getCategoryIcon === 'function' ? getCategoryIcon(cat) : 'fa-tag';
            const label = typeof capitalize === 'function' ? capitalize(cat) : cat;

            chip.innerHTML = `<i class="${icon}"></i> ${label}`;
            chip.dataset.category = cat;

            chip.addEventListener('click', () => {
                if (activeFilters.has(cat)) {
                    activeFilters.delete(cat);
                    chip.classList.remove('active');
                } else {
                    activeFilters.add(cat);
                    chip.classList.add('active');
                }
                filterModels();
            });

            filterChipsContainer.appendChild(chip);
        });
    }
}

function filterModels() {
    const searchTerm = document.getElementById('modelSearchInput')?.value.toLowerCase() || '';
    const rows = document.querySelectorAll('#modelsTableBody tr');
    let visibleCount = 0;

    rows.forEach(row => {
        const modelName = row.querySelector('.model-name-col')?.textContent.toLowerCase() || '';
        const modelCategories = Array.from(row.querySelectorAll('.category-checkboxes input:checked'))
            .map(cb => cb.value);

        const matchesSearch = !searchTerm || modelName.includes(searchTerm);
        const matchesFilter = activeFilters.size === 0 ||
            modelCategories.some(cat => activeFilters.has(cat));

        if (matchesSearch && matchesFilter) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });
}

// ===============================================
// CSV EXPORT
// ===============================================

function exportCsv() {
    if (typeof allModels === 'undefined' || allModels.length === 0) {
        if (typeof showToast === 'function') showToast('No models to export', 'warning');
        return;
    }

    const headers = ['Model Name', 'Display Name', 'Provider', 'Parameters', 'Recommended Category', 'Confidence', 'Assigned Categories', 'Sync Status'];
    const rows = allModels.map(model => {
        const recCat = model.benchmarkStats?.bestCategory || 'Pending';
        const confidence = model.benchmarkStats?.confidence || 'N/A';
        const assignedCats = (model.categories || []).join('; ');

        let status = 'Connected';
        if (typeof syncStatus !== 'undefined') {
            const isDead = syncStatus.dead?.includes(model.name);
            const isNew = syncStatus.new?.includes(model.name);
            status = isDead ? 'Dead' : isNew ? 'New' : 'Connected';
        }

        return [
            model.name,
            model.displayName || model.name,
            model.provider || model.vendor || 'Unknown',
            model.parameters || 'N/A',
            recCat,
            typeof confidence === 'number' ? `${confidence}%` : confidence,
            assignedCats || 'None',
            status
        ];
    });

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `model-categories-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (typeof showToast === 'function') {
        showToast(`Exported ${allModels.length} models to CSV`, 'success');
    }
}

// ===============================================
// CHART LOADING SKELETONS
// ===============================================

function showChartSkeleton(containerId) {
    const container = document.querySelector(`#${containerId}`)?.parentElement;
    if (!container) return;

    const skeleton = document.createElement('div');
    skeleton.className = 'chart-skeleton';
    skeleton.id = `${containerId}-skeleton`;

    for (let i = 0; i < 6; i++) {
        const bar = document.createElement('div');
        bar.className = 'chart-skeleton-bar';
        skeleton.appendChild(bar);
    }

    const label = document.createElement('div');
    label.className = 'chart-loading-label';
    label.innerHTML = '<i class="fa-solid fa-spinner"></i> Loading chart...';
    skeleton.appendChild(label);

    container.style.position = 'relative';
    container.appendChild(skeleton);
}

function hideChartSkeleton(containerId) {
    const skeleton = document.getElementById(`${containerId}-skeleton`);
    if (skeleton) {
        skeleton.style.opacity = '0';
        setTimeout(() => skeleton.remove(), 300);
    }
}

// ===============================================
// INITIALIZATION
// ===============================================

document.addEventListener('DOMContentLoaded', () => {
    // Show chart skeletons early
    showChartSkeleton('categoryDistributionChart');
    showChartSkeleton('categoryPerformanceChart');

    // Initialize features after a short delay to ensure page is ready
    setTimeout(() => {
        setupKeyboardShortcuts();
        setupSearchAndFilter();

        document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
        document.getElementById('showShortcutsBtn')?.addEventListener('click', showShortcutsModal);

        // Hide skeletons after charts should be loaded
        setTimeout(() => {
            hideChartSkeleton('categoryDistributionChart');
            hideChartSkeleton('categoryPerformanceChart');
        }, 2000);

        // Setup responsive helpers
        setupResponsiveHelpers();

        console.log('🎸 Model Categorization enhancements loaded!');
        console.log(`📱 Screen: ${window.innerWidth}x${window.innerHeight}`);
    }, 200);
});

// ===============================================
// RESPONSIVE HELPERS
// ===============================================

function setupResponsiveHelpers() {
    // Detect mobile
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    const isTouch = 'ontouchstart' in window;

    if (isMobile || isTouch) {
        // Add mobile class to body
        document.body.classList.add('is-mobile');

        // Make table horizontally scrollable hint
        const tableContainer = document.querySelector('.table-container');
        if (tableContainer) {
            const scrollHint = document.createElement('div');
            scrollHint.className = 'mobile-scroll-hint';
            scrollHint.innerHTML = '<i class="fa-solid fa-chevron-right"></i> Swipe to see more';
            scrollHint.style.cssText = `
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

            tableContainer.insertBefore(scrollHint, tableContainer.firstChild);

            // Hide hint after first scroll
            tableContainer.addEventListener('scroll', () => {
                scrollHint.style.display = 'none';
            }, { once: true });
        }

        // Add pull-to-refresh hint
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

    // Prevent double-tap zoom on buttons
    if (isTouch) {
        document.querySelectorAll('.btn, .filter-chip, .checkbox-label').forEach(el => {
            el.addEventListener('touchend', (e) => {
                e.preventDefault();
                el.click();
            }, { passive: false });
        });
    }

    // Ultra-wide screen optimizations
    const isUltraWide = window.matchMedia('(min-width: 1920px)').matches;
    if (isUltraWide) {
        document.body.classList.add('is-ultra-wide');

        // Add "Expand Table" button for ultra-wide
        const tableContainer = document.querySelector('.table-container');
        if (tableContainer) {
            const expandBtn = document.createElement('button');
            expandBtn.className = 'btn btn-sm';
            expandBtn.innerHTML = '<i class="fa-solid fa-expand"></i> Expand Table';
            expandBtn.style.cssText = 'position: absolute; top: 10px; right: 10px; z-index: 10;';

            expandBtn.addEventListener('click', () => {
                tableContainer.classList.toggle('expanded');
                if (tableContainer.classList.contains('expanded')) {
                    tableContainer.style.maxWidth = '100%';
                    expandBtn.innerHTML = '<i class="fa-solid fa-compress"></i> Compress';
                } else {
                    tableContainer.style.maxWidth = '';
                    expandBtn.innerHTML = '<i class="fa-solid fa-expand"></i> Expand Table';
                }
            });

            tableContainer.style.position = 'relative';
            tableContainer.appendChild(expandBtn);
        }
    }
}
