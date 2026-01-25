/**
 * Benchmark Analytics - Utility Functions
 * Common helpers used across modules
 */

/**
 * Get palette color by index for chart styling
 */
export function getPaletteColor(index) {
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

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms) {
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
 * Format percentage value
 */
export function formatPercent(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 'N/A';
    return `${n.toFixed(1)}%`;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/**
 * Calculate delta between two values
 */
export function calculateDelta(items, field) {
    if (items.length < 2) return '0';
    const val1 = parseFloat(items[0][field]) || 0;
    const val2 = parseFloat(items[1][field]) || 0;
    const delta = val2 - val1;
    return delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
}

/**
 * Get CSS class for delta (positive/negative)
 */
export function getDeltaClass(items, field) {
    const delta = calculateDelta(items, field);
    const val = parseFloat(delta);
    if (val > 0) return 'delta-positive';
    if (val < 0) return 'delta-negative';
    return '';
}

/**
 * Compute Pearson correlation coefficient
 */
export function computePearsonCorrelation(xs, ys) {
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

/**
 * Show toast notification
 */
export function showToast(message, type = 'info') {
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
 * Generate selection key for model comparison
 */
export function selectionKeyModel(sel) {
    return `${sel.model}@@${sel.host || ''}`;
}

/**
 * Generate selection key for judge comparison
 */
export function selectionKeyJudge(sel) {
    return `${sel.judge_model}@@${sel.judge_host || ''}`;
}

/**
 * Parse judge key from combined string
 */
export function parseJudgeKey(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.split('@@');
    const judge_model = (parts[0] || '').trim();
    const judge_host = (parts[1] || '').trim();
    if (!judge_model) return null;
    return { judge_model, judge_host: judge_host ? judge_host : null };
}

/**
 * Render chip list for compare UI
 */
export function renderChipList(containerId, items, onRemove) {
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
                <button type="button" class="compare-chip-remove" title="Remove" aria-label="Remove">x</button>
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

/**
 * Get selected host from UI
 */
export function getSelectedHost() {
    const hostEl = document.getElementById('host');
    return hostEl ? hostEl.value : '';
}

/**
 * Get active scoring profile key
 */
export function getActiveProfileKey() {
    const profileEl = document.getElementById('scoringProfile');
    const profile = profileEl ? profileEl.value : 'interactive';
    if (profile === 'reasoning') return 'reasoning_score';
    if (profile === 'coding') return 'coding_score';
    return 'interactive_score';
}

/**
 * Ensure dashboard data is loaded
 */
export async function ensureDashboardLoaded() {
    if (window.latestBenchmarkData && Array.isArray(window.latestBenchmarkData.model_stats)) return;
    if (typeof window.loadDashboard === 'function') {
        try {
            await window.loadDashboard();
        } catch (_) {
            // ignore
        }
    }
}
