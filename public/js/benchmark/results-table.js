// results-table.js - Result table rendering, filtering, sorting

import * as state from './state.js';
import { escapeHtml, toFiniteNumber, formatHostLabel } from './utils.js';

/**
 * Render results table
 */
export function renderResultsTable(results, tbody) {
    if (!tbody) return;

    const getFailureBadgeHtml = (r) => {
        const isFailed = r.success === false;
        if (!isFailed) return '';

        const isInfra = r.infra_error === true || String(r.error_type || '').toLowerCase() === 'infra';
        const type = isInfra ? 'infra' : (String(r.error_type || '').toLowerCase() === 'model' ? 'model' : 'unknown');
        const label = type === 'infra' ? 'INFRA' : type === 'model' ? 'MODEL' : 'UNKNOWN';
        const icon = type === 'infra' ? 'fa-network-wired' : type === 'model' ? 'fa-bug' : 'fa-question-circle';
        const http = Number.isFinite(r.error_http_status) ? ` HTTP ${r.error_http_status}` : '';

        const msgRaw = (r.error || r.error_message || '').toString();
        const msg = msgRaw.replace(/\s+/g, ' ').trim().slice(0, 220);
        const title = `${label}${http}${msg ? `: ${msg}` : ''}`;

        return `<span class="fail-badge ${type}" title="${escapeHtml(title)}"><i class="fas ${icon}"></i>${label}</span>`;
    };

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

        let judgeInfo = r.judge_host ? `<div style="font-size: 0.75em; color: var(--muted);">Judge: ${formatHostLabel(r.judge_host)}</div>` : '';

        // Dual score display: semantic + format
        const hasSemantic = r.semantic_score !== undefined && r.semantic_score !== null;
        const hasFormat = r.format_score !== undefined && r.format_score !== null;
        let dualScoreHtml = '';
        if (!isFailed && (hasSemantic || hasFormat)) {
            const parts = [];
            if (hasSemantic) {
                const semColor = r.semantic_score >= 7 ? '#2ecc71' : r.semantic_score >= 4 ? '#f39c12' : '#e74c3c';
                parts.push(`<span style="color: ${semColor};" title="Semantic: correctness ignoring format">S:${Number(r.semantic_score).toFixed(1)}</span>`);
            }
            if (hasFormat) {
                const fmtIcon = r.format_compliant ? '<i class="fas fa-check" style="color: #2ecc71;"></i>' : '<i class="fas fa-times" style="color: #e74c3c;"></i>';
                parts.push(`<span title="Format compliance">${fmtIcon} F:${Number(r.format_score).toFixed(0)}</span>`);
            }
            dualScoreHtml = `<div style="font-size: 0.75em; margin-top: 2px;">${parts.join(' ')}</div>`;
        }

        // Enhanced confidence badges
        let confidenceHtml = '';
        if (r.judge_confidence !== undefined && r.judge_confidence !== null) {
            if (r.needs_review) {
                const reviewTitle = r.review_reason ? escapeHtml(r.review_reason) : 'Manual review recommended';
                confidenceHtml = `<span class="badge" style="background: #e74c3c; color: white; font-size: 0.7em; padding: 2px 6px; border-radius: 4px; cursor: help;" title="${reviewTitle}"><i class="fas fa-exclamation-triangle"></i> Review</span>`;
            } else if (r.judge_confidence < 0.8) {
                confidenceHtml = `<span class="badge" style="background: #f39c12; color: white; font-size: 0.7em; padding: 2px 6px; border-radius: 4px;" title="Judge confidence: ${(r.judge_confidence * 100).toFixed(0)}%"><i class="fas fa-exclamation-circle"></i> Low Conf</span>`;
            } else if (r.prompt_complexity && r.prompt_complexity > 8) {
                confidenceHtml = `<span class="badge" style="background: #3498db; color: white; font-size: 0.7em; padding: 2px 6px; border-radius: 4px;" title="Complexity: ${r.prompt_complexity.toFixed(1)}/10"><i class="fas fa-brain"></i> Complex</span>`;
            }
        }

        const rowStyle = isFailed
            ? 'border-bottom: 1px solid rgba(231, 76, 60, 0.3); background: rgba(231, 76, 60, 0.05);'
            : 'border-bottom: 1px solid rgba(255,255,255,0.05);';

        const failureBadge = getFailureBadgeHtml(r);

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
                    ${isFailed ? `<span style="color: #e74c3c; font-weight: 600;">FAILED</span>${failureBadge}` : qualityScore}
                    ${dualScoreHtml}
                    ${confidenceHtml}
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
        filtered = filtered.filter(r => (r.quality_score ?? 0) >= filters.minQuality);
    }

    if (filters.maxLatency !== undefined) {
        filtered = filtered.filter(r => {
            const latency = toFiniteNumber(r.latency);
            return (latency ?? Infinity) <= filters.maxLatency;
        });
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
 * Build batch-level confidence/scoring summary bar HTML
 */
export function buildBatchScoringBar(results) {
    if (!results || results.length === 0) return '';

    const successResults = results.filter(r => r.success !== false);
    if (successResults.length === 0) return '';

    // Avg confidence
    const confValues = successResults.map(r => r.judge_confidence).filter(v => v !== undefined && v !== null);
    const avgConf = confValues.length > 0 ? (confValues.reduce((s, v) => s + v, 0) / confValues.length) : null;

    // Needs review count
    const reviewCount = successResults.filter(r => r.needs_review).length;

    // Format non-compliant count
    const formatResults = successResults.filter(r => r.format_compliant !== undefined && r.format_compliant !== null);
    const formatNonCompliant = formatResults.filter(r => r.format_compliant === false).length;

    // Avg semantic vs quality gap
    const dualScoreResults = successResults.filter(r =>
        r.semantic_score !== undefined && r.semantic_score !== null &&
        r.quality_score !== undefined && r.quality_score !== null
    );

    const parts = [];

    if (avgConf !== null) {
        const confColor = avgConf >= 0.8 ? '#2ecc71' : avgConf >= 0.6 ? '#f39c12' : '#e74c3c';
        parts.push(`<span style="color: ${confColor};" title="Average judge confidence"><i class="fas fa-shield-alt"></i> Conf: ${(avgConf * 100).toFixed(0)}%</span>`);
    }

    if (reviewCount > 0) {
        parts.push(`<span style="color: #e74c3c;" title="Results needing manual review"><i class="fas fa-exclamation-triangle"></i> Review: ${reviewCount}</span>`);
    }

    if (formatResults.length > 0) {
        const fmtColor = formatNonCompliant === 0 ? '#2ecc71' : '#f39c12';
        parts.push(`<span style="color: ${fmtColor};" title="Format non-compliant results"><i class="fas fa-align-left"></i> Fmt fail: ${formatNonCompliant}/${formatResults.length}</span>`);
    }

    if (parts.length === 0) return '';

    return `<div style="display: flex; gap: 16px; padding: 8px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--panel-border); border-radius: 6px; font-size: 0.85em; margin-bottom: 10px; flex-wrap: wrap; align-items: center;">
        <span style="color: var(--muted); font-weight: 600;">Scoring Summary</span>
        ${parts.join('<span style="color: rgba(255,255,255,0.1);">|</span>')}
    </div>`;
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

        const latency = toFiniteNumber(r.latency);
        if (latency !== null) {
            latencySum += latency;
            latencyCount++;
        }

        const tps = toFiniteNumber(r.tokens_per_sec);
        if (tps !== null) {
            tpsSum += tps;
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
