/**
 * courthouse-roster-ui.js
 * Governance view for per-host judge defaults and tier metadata.
 */

(function () {
    'use strict';

    const FALLBACK_TIERS = {
        basic: { label: 'Basic', shortLabel: 'BASIC', modelRange: '2-3B', rank: 1 },
        standard: { label: 'Standard', shortLabel: 'STD', modelRange: '7-9B', rank: 2 },
        advanced: { label: 'Advanced', shortLabel: 'ADV', modelRange: '14-32B', rank: 3 },
        premium: { label: 'Premium', shortLabel: 'PRO', modelRange: '70B+', rank: 4 }
    };

    const TIER_COLORS = {
        basic: { bg: 'rgba(108,117,125,0.2)', border: 'rgba(108,117,125,0.5)', text: '#adb5bd' },
        standard: { bg: 'rgba(13,110,253,0.15)', border: 'rgba(13,110,253,0.5)', text: '#4096ff' },
        advanced: { bg: 'rgba(25,135,84,0.15)', border: 'rgba(25,135,84,0.5)', text: '#52c41a' },
        premium: { bg: 'rgba(220,53,69,0.15)', border: 'rgba(220,53,69,0.5)', text: '#ff4d4f' }
    };

    function esc(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c]));
    }

    function getTierDefinitions(raw = {}) {
        return Object.keys(FALLBACK_TIERS).reduce((acc, tier) => {
            acc[tier] = { ...FALLBACK_TIERS[tier], ...(raw[tier] || {}) };
            return acc;
        }, {});
    }

    function tierBadge(tier, definitions) {
        if (!tier) {
            return '<span style="color:var(--muted);font-size:0.82em;">—</span>';
        }
        const colors = TIER_COLORS[tier] || TIER_COLORS.standard;
        const meta = definitions[tier] || FALLBACK_TIERS[tier] || {};
        const label = meta.shortLabel || meta.label || String(tier).toUpperCase();
        const title = [meta.label, meta.modelRange, meta.description].filter(Boolean).join(' · ');
        return `<span title="${esc(title)}" style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:0.72em;
            font-weight:700;letter-spacing:.5px;background:${colors.bg};border:1px solid ${colors.border};
            color:${colors.text};">${esc(label)}</span>`;
    }

    function sourceBadge(source) {
        if (!source) return '';
        const labelMap = {
            curated: 'curated',
            calibrated: 'calibrated',
            inferred: 'inferred',
            legacy: 'legacy',
            discovered: 'discovered'
        };
        return `<span style="font-size:0.72em;color:var(--muted);background:rgba(255,255,255,0.06);
            padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.08);">${esc(labelMap[source] || source)}</span>`;
    }

    function reliabilityBadge(rel) {
        if (rel === null || rel === undefined) return '<span style="color:var(--muted);font-size:0.82em;">—</span>';
        const pct = Math.round(rel * 100);
        const color = `hsl(${Math.round(rel * 120)}, 65%, 52%)`;
        return `<span style="color:${color};font-weight:600;">${pct}%</span>`;
    }

    function latencyBadge(ms) {
        if (ms === null || ms === undefined) return '<span style="color:var(--muted);font-size:0.82em;">—</span>';
        const label = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        const color = ms < 3000 ? '#27ae60' : ms < 8000 ? '#f39c12' : '#e74c3c';
        return `<span style="color:${color};">${label}</span>`;
    }

    function formatCtx(numCtx) {
        if (numCtx === null || numCtx === undefined) return '—';
        return `${Number(numCtx).toLocaleString()} ctx`;
    }

    function contextSourceLabel(source) {
        const labels = {
            override: 'override',
            context_test: 'probed',
            execution_default: 'registry',
            capabilities: 'legacy'
        };
        return labels[source] || source || 'unknown';
    }

    function renderContextCell(judge) {
        const ctx = judge.contextWindow || {};
        if (!ctx.effectiveNumCtx) {
            return '<span style="color:var(--muted);font-size:0.82em;">—</span>';
        }

        const detailParts = [];
        if (ctx.probedNumCtx) detailParts.push(`Probed ${formatCtx(ctx.probedNumCtx)}`);
        if (ctx.defaultNumCtx) detailParts.push(`Registry ${formatCtx(ctx.defaultNumCtx)}`);
        if (ctx.overrideNumCtx) detailParts.push(`Override ${formatCtx(ctx.overrideNumCtx)}`);

        return `<div style="display:flex;flex-direction:column;gap:4px;align-items:center;">
            <div style="font-weight:600;">${formatCtx(ctx.effectiveNumCtx)}</div>
            <div style="font-size:0.74em;color:var(--muted);">${esc(contextSourceLabel(ctx.source))}</div>
            <div style="font-size:0.72em;color:var(--muted);text-align:center;">${esc(detailParts.join(' · ') || 'No probe data')}</div>
        </div>`;
    }

    function renderCuratedTierCell(judge, tierDefinitions) {
        const tierMeta = judge.tierMeta || {};
        const curatedTier = tierMeta.curatedTier || judge.tier || '';
        const inferredTier = tierMeta.inferredTier || judge.inferredTier || '';
        const hasConflict = !!(judge.hasConflict || (curatedTier && inferredTier && curatedTier !== inferredTier));
        const colors = curatedTier
            ? (TIER_COLORS[curatedTier] || TIER_COLORS.standard)
            : { bg: 'rgba(100,100,100,0.2)', border: 'rgba(100,100,100,0.4)', text: '#888' };

        const opts = Object.keys(tierDefinitions).map((tier) =>
            `<option value="${tier}"${curatedTier === tier ? ' selected' : ''}>${esc(tierDefinitions[tier].shortLabel || tierDefinitions[tier].label || tier)}</option>`
        ).join('');

        const conflictHint = hasConflict
            ? `<span title="Curated tier and inferred tier differ. Review governance metadata before saving."
                style="color:#f39c12;cursor:help;font-size:0.9em;margin-left:2px;flex-shrink:0;">⚠</span>`
            : '';

        return `<div style="display:flex;align-items:center;gap:3px;justify-content:center;">
            <select class="roster-tier-select"
                data-model="${esc(judge.modelName)}"
                data-original-tier="${esc(curatedTier)}"
                title="Set curated tier"
                style="font-size:0.72em;font-weight:700;padding:2px 6px;border-radius:4px;
                    background:${colors.bg};border:1px solid ${colors.border};color:${colors.text};
                    cursor:pointer;appearance:none;-webkit-appearance:none;
                    text-align:center;letter-spacing:.5px;width:64px;">
                ${opts}
            </select>${conflictHint}
        </div>`;
    }

    function renderTierSourceCell(judge, tierDefinitions) {
        const tierMeta = judge.tierMeta || {};
        const effectiveTier = tierMeta.effectiveTier || judge.tier || null;
        const recommendedTier = tierMeta.recommendedTier || null;
        const calibratedTier = tierMeta.calibratedTier || null;
        const inferredTier = tierMeta.inferredTier || null;

        return `<div style="display:flex;flex-direction:column;gap:4px;align-items:center;">
            <div>${tierBadge(effectiveTier, tierDefinitions)}</div>
            <div style="font-size:0.74em;color:var(--muted);">${sourceBadge(tierMeta.source || judge.source)}</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;">
                ${recommendedTier ? `<span title="Recommended tier">${tierBadge(recommendedTier, tierDefinitions)}</span>` : ''}
                ${calibratedTier && calibratedTier !== recommendedTier ? `<span title="Calibrated tier">${tierBadge(calibratedTier, tierDefinitions)}</span>` : ''}
                ${inferredTier ? `<span title="Inferred tier">${tierBadge(inferredTier, tierDefinitions)}</span>` : ''}
            </div>
        </div>`;
    }

    function renderJudgeRow(judge, isDefault, tierDefinitions) {
        const tierMeta = judge.tierMeta || {};
        const defaultBadge = isDefault
            ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.75em;
                font-weight:700;background:rgba(124,240,255,0.15);border:1px solid rgba(124,240,255,0.45);
                color:var(--accent);margin-left:6px;"><i class="fas fa-star"></i> DEFAULT ON HOST</span>`
            : '';

        const setDefaultBtn = !isDefault
            ? `<button class="roster-set-default-btn btn-secondary btn-sm"
                    data-model="${esc(judge.modelName)}"
                    style="font-size:0.78em;padding:3px 9px;">
                    <i class="fas fa-star"></i> Set Default
                </button>`
            : `<button class="roster-clear-default-btn btn-secondary btn-sm"
                    data-model="${esc(judge.modelName)}"
                    style="font-size:0.78em;padding:3px 9px;border-color:rgba(124,240,255,0.4);color:var(--accent);">
                    <i class="fas fa-times"></i> Clear
                </button>`;

        const calibratedAt = judge.calibratedAt
            ? `<span style="color:var(--muted);font-size:0.75em;" title="Last calibrated">
                <i class="fas fa-flask"></i> ${new Date(judge.calibratedAt).toLocaleDateString()}
               </span>`
            : '';

        const evalCount = judge.evalCount > 0
            ? `<span style="color:var(--muted);font-size:0.82em;">${judge.evalCount.toLocaleString()} evals</span>`
            : '<span style="color:var(--muted);font-size:0.82em;">no evals</span>';

        const recommendedDetail = tierMeta.recommendedTier || tierMeta.calibratedTier
            ? `${tierBadge(tierMeta.recommendedTier || tierMeta.calibratedTier, tierDefinitions)}`
            : '<span style="color:var(--muted);font-size:0.82em;">—</span>';

        return `<tr data-model="${esc(judge.modelName)}">
            <td style="padding:10px 8px;vertical-align:middle;">
                <div style="font-weight:600;font-size:0.92em;">${esc(judge.modelName)}${defaultBadge}</div>
                <div style="margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    ${sourceBadge(judge.source)} ${calibratedAt}
                </div>
            </td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${renderTierSourceCell(judge, tierDefinitions)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${renderCuratedTierCell(judge, tierDefinitions)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${recommendedDetail}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${renderContextCell(judge)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${reliabilityBadge(judge.reliability)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${latencyBadge(judge.avgLatencyMs)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${evalCount}</td>
            <td style="padding:10px 8px;text-align:right;vertical-align:middle;">${setDefaultBtn}</td>
        </tr>`;
    }

    function renderLevelPolicy(levelRequirements, tierDefinitions) {
        if (!Array.isArray(levelRequirements) || levelRequirements.length === 0) {
            return '<span style="color:var(--muted);">Tier policy unavailable</span>';
        }

        const bands = [];
        let start = null;
        let previous = null;

        for (const item of levelRequirements) {
            if (!start) {
                start = item;
                previous = item;
                continue;
            }
            if (item.requiredTier === previous.requiredTier && item.level === previous.level + 1) {
                previous = item;
                continue;
            }
            bands.push({ start, end: previous });
            start = item;
            previous = item;
        }

        if (start && previous) {
            bands.push({ start, end: previous });
        }

        return bands.map(({ start: bandStart, end }) => {
            const levelLabel = bandStart.level === end.level
                ? `L${bandStart.level}`
                : `L${bandStart.level}-${end.level}`;
            return `<span>${esc(levelLabel)} ${tierBadge(bandStart.requiredTier, tierDefinitions)}</span>`;
        }).join('<span style="color:var(--muted);"> · </span>');
    }

    function renderHostPanel(panel, rosterData, tierDefinitions) {
        const defaultModel = panel.defaultJudgeModel;
        const judges = panel.judges || [];
        const tierRank = rosterData.tierRank || { basic: 1, standard: 2, advanced: 3, premium: 4 };
        const tierCoverage = [...new Set(judges.map((judge) => judge.tierMeta?.effectiveTier || judge.tier).filter(Boolean))]
            .sort((a, b) => (tierRank[b] || 0) - (tierRank[a] || 0));

        const coverageBadges = tierCoverage.map((tier) => tierBadge(tier, tierDefinitions)).join(' ');
        const countLabel = `${judges.length} judge${judges.length !== 1 ? 's' : ''} available`;
        const defaultInfo = defaultModel
            ? `<span style="color:var(--muted);font-size:0.85em;">Default per host: </span>
               <code style="font-size:0.85em;color:var(--accent);">${esc(defaultModel)}</code>`
            : '<span style="color:var(--muted);font-size:0.85em;font-style:italic;">No host default set</span>';

        const rows = judges.length === 0
            ? `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted);">
                <i class="fas fa-ghost"></i> No judge-capable models detected on this host
               </td></tr>`
            : judges.map((judge) => renderJudgeRow(judge, judge.modelName === defaultModel, tierDefinitions)).join('');

        return `
        <div class="roster-host-panel" data-host="${esc(panel.hostUrl)}"
            style="border:1px solid var(--panel-border);border-radius:10px;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
                padding:14px 18px;background:rgba(0,0,0,0.25);border-bottom:1px solid var(--panel-border);">
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                    <span style="font-size:1.05em;font-weight:700;">
                        <i class="fas fa-server" style="color:var(--accent);margin-right:6px;"></i>
                        ${esc(panel.hostName)}
                    </span>
                    <code style="font-size:0.82em;color:var(--muted);background:rgba(255,255,255,0.05);
                        padding:2px 8px;border-radius:4px;">${esc(panel.hostUrl)}</code>
                    <span style="font-size:0.82em;color:var(--muted);">${countLabel}</span>
                    <span style="display:flex;gap:4px;align-items:center;">${coverageBadges}</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    ${defaultInfo}
                </div>
            </div>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="background:rgba(0,0,0,0.15);">
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:left;">Model</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Effective</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Curated</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Cal/Rec</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Context</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Reliability</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Avg Latency</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Evals</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:right;">Host Default</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div style="padding:10px 18px;background:rgba(0,0,0,0.12);border-top:1px solid rgba(255,255,255,0.05);
                font-size:0.8em;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <i class="fas fa-info-circle"></i>
                <span>Tier coverage: ${coverageBadges || '<em>none</em>'}</span>
                <span style="margin-left:8px;">Context comes from override, probe, or registry metadata.</span>
                <span style="margin-left:8px;">${renderLevelPolicy(rosterData.levelRequirements || [], tierDefinitions)}</span>
            </div>
        </div>`;
    }

    async function fetchRoster() {
        const res = await fetch('/api/benchmark/judge-roster');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function saveDefault(hostUrl, judgeModel) {
        const res = await fetch('/api/benchmark/judge-defaults', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostUrl, judgeModel })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    function bindInteractions(container) {
        container.querySelectorAll('.roster-tier-select').forEach((select) => {
            select.addEventListener('change', async (event) => {
                const sel = event.currentTarget;
                const modelName = sel.dataset.model;
                const newTier = sel.value;
                const oldTier = sel.dataset.originalTier;
                sel.disabled = true;
                sel.style.opacity = '0.5';
                try {
                    const resp = await fetch(`/api/benchmark/judge-roster/${encodeURIComponent(modelName)}/tier`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ tier: newTier })
                    });
                    if (!resp.ok) {
                        const body = await resp.json().catch(() => ({}));
                        throw new Error(body.error || `HTTP ${resp.status}`);
                    }
                    await loadRoster();
                } catch (err) {
                    alert(`Failed to update tier: ${err.message}`);
                    sel.value = oldTier;
                    sel.disabled = false;
                    sel.style.opacity = '';
                }
            });
        });

        container.querySelectorAll('.roster-set-default-btn').forEach((btn) => {
            btn.addEventListener('click', async (event) => {
                const hostPanel = event.currentTarget.closest('.roster-host-panel');
                const hostUrl = hostPanel && hostPanel.dataset.host;
                const model = event.currentTarget.dataset.model;
                if (!hostUrl || !model) return;
                try {
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                    await saveDefault(hostUrl, model);
                    await loadRoster();
                } catch (err) {
                    alert(`Failed to save default: ${err.message}`);
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-star"></i> Set Default';
                }
            });
        });

        container.querySelectorAll('.roster-clear-default-btn').forEach((btn) => {
            btn.addEventListener('click', async (event) => {
                const hostPanel = event.currentTarget.closest('.roster-host-panel');
                const hostUrl = hostPanel && hostPanel.dataset.host;
                if (!hostUrl) return;
                try {
                    btn.disabled = true;
                    await saveDefault(hostUrl, null);
                    await loadRoster();
                } catch (err) {
                    alert(`Failed to clear default: ${err.message}`);
                    btn.disabled = false;
                }
            });
        });
    }

    function renderRoster(data) {
        const container = document.getElementById('judgeRosterPanels');
        if (!container) return;

        const panels = data.hostPanels || [];
        if (panels.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);">
                <i class="fas fa-plug" style="font-size:2em;opacity:0.4;margin-bottom:8px;"></i>
                <p>No Ollama hosts configured.</p>
            </div>`;
            return;
        }

        const tierDefinitions = getTierDefinitions(data.judgeTiers || {});
        container.innerHTML = panels.map((panel) => renderHostPanel(panel, data, tierDefinitions)).join('');
        bindInteractions(container);
    }

    async function loadRoster() {
        const container = document.getElementById('judgeRosterPanels');
        if (!container) return;
        try {
            const json = await fetchRoster();
            if (json.status !== 'success') throw new Error(json.error || 'Unknown error');
            renderRoster(json.data);
        } catch (err) {
            container.innerHTML = `<div style="padding:20px;color:#e74c3c;">
                <i class="fas fa-exclamation-circle"></i> Failed to load roster: ${esc(err.message)}
            </div>`;
        }
    }

    function init() {
        loadRoster();
        const refreshBtn = document.getElementById('rosterRefreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', loadRoster);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CourthouseRoster = { loadRoster };
})();
