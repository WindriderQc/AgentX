// results-table.js - Result table rendering, filtering, sorting

import * as state from './state.js';
import { escapeHtml, toFiniteNumber, formatHostLabel } from './utils.js';

/**
 * Render results table
 */
export function renderResultsTable(results, tbody) {
    if (!tbody) return;

    tbody.innerHTML = results.map((r, idx) => {
        const isFailed = r.success === false;
        const qualityScore = r.quality_score !== undefined && r.quality_score !== null ? r.quality_score : '-';
        const qualityClass = qualityScore >= 7 ? 'quality-high' : qualityScore >= 4 ? 'quality-mid' : (qualityScore !== '-' ? 'quality-low' : '');

        const lat = toFiniteNumber(r.latency);
        const tps = toFiniteNumber(r.tokens_per_sec);
        const perfLine = (lat !== null || tps !== null)
            ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">${lat !== null ? `L: ${Math.round(lat)}ms` : 'L: -'} | ${tps !== null ? `t/s: ${tps.toFixed(2)}` : 't/s: -'}</div>`
            : '';

        const hostInfo = r.host ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">Exec: ${formatHostLabel(r.host)}</div>` : '';
        const judgeInfo = r.judge_host ? `<div style="font-size: 0.75em; color: var(--muted);">Judge: ${formatHostLabel(r.judge_host)}</div>` : '';

        const rowStyle = isFailed
            ? 'border-bottom: 1px solid rgba(231, 76, 60, 0.3); background: rgba(231, 76, 60, 0.05);'
            : 'border-bottom: 1px solid rgba(255,255,255,0.05);';

        return `
            <tr style="${rowStyle}">
                <td style="padding: 8px 12px;">
                    ${isFailed ? '<i class="fas fa-exclamation-triangle" style="color: #e74c3c; margin-right: 6px;"></i>' : ''}${escapeHtml(r.model)}
                    ${hostInfo}
                </td>
                <td style="padding: 8px 12px;">
                    ${escapeHtml(r.prompt_name)}${perfLine}
                </td>
                <td style="padding: 8px 12px; text-align: center;" class="${qualityClass}">
                    ${isFailed ? '<span style="color: #e74c3c; font-weight: 600;">FAILED</span>' : qualityScore}
                    ${judgeInfo}
                </td>
                <td style="padding: 8px 12px; text-align: center;">
                    <button class="btn-secondary btn-sm" onclick="showJudgeDetails('${r.id || idx}')">
                        <i class="fas fa-${isFailed ? 'exclamation-circle' : 'eye'}"></i> ${isFailed ? 'Error' : 'Details'}
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Sort results
 */
export function sortResults(results, sortBy) {
    const sorted = [...results];

    switch (sortBy) {
        case 'quality':
            sorted.sort((a, b) => {
                const qa = a.quality_score ?? -1;
                const qb = b.quality_score ?? -1;
                return qb - qa;
            });
            break;
        case 'latency':
            sorted.sort((a, b) => {
                const la = a.latency ?? Infinity;
                const lb = b.latency ?? Infinity;
                return la - lb;
            });
            break;
        case 'tps':
            sorted.sort((a, b) => {
                const ta = a.tokens_per_sec ?? 0;
                const tb = b.tokens_per_sec ?? 0;
                return tb - ta;
            });
            break;
        case 'model':
            sorted.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
            break;
        case 'status':
            sorted.sort((a, b) => {
                if (a.success === b.success) return 0;
                return a.success ? 1 : -1; // Failures first
            });
            break;
        default:
            // Keep original order (timestamp)
            break;
    }

    return sorted;
}

/**
 * Filter results
 */
export function filterResults(results, filters) {
    let filtered = [...results];

    if (filters.model) {
        filtered = filtered.filter(r => r.model === filters.model);
    }

    if (filters.failuresOnly) {
        filtered = filtered.filter(r => r.success === false);
    }

    if (filters.minQuality !== undefined) {
        filtered = filtered.filter(r => (r.quality_score || 0) >= filters.minQuality);
    }

    if (filters.maxLatency !== undefined) {
        filtered = filtered.filter(r => (r.latency || Infinity) <= filters.maxLatency);
    }

    return filtered;
}

/**
 * Get unique models from results
 */
export function getUniqueModels(results) {
    const models = new Set();
    results.forEach(r => {
        if (r.model) models.add(r.model);
    });
    return Array.from(models).sort();
}

/**
 * Calculate result statistics
 */
export function calculateResultStats(results) {
    const stats = {
        total: results.length,
        success: 0,
        failed: 0,
        avgLatency: 0,
        avgTps: 0,
        avgQuality: 0,
        successRate: 0
    };

    if (results.length === 0) return stats;

    let latencySum = 0;
    let latencyCount = 0;
    let tpsSum = 0;
    let tpsCount = 0;
    let qualitySum = 0;
    let qualityCount = 0;

    results.forEach(r => {
        if (r.success) {
            stats.success++;
        } else {
            stats.failed++;
        }

        if (r.latency) {
            latencySum += r.latency;
            latencyCount++;
        }

        if (r.tokens_per_sec) {
            tpsSum += parseFloat(r.tokens_per_sec);
            tpsCount++;
        }

        if (r.quality_score !== undefined && r.quality_score !== null) {
            qualitySum += r.quality_score;
            qualityCount++;
        }
    });

    stats.successRate = (stats.success / stats.total) * 100;
    stats.avgLatency = latencyCount > 0 ? latencySum / latencyCount : 0;
    stats.avgTps = tpsCount > 0 ? tpsSum / tpsCount : 0;
    stats.avgQuality = qualityCount > 0 ? qualitySum / qualityCount : 0;

    return stats;
}
