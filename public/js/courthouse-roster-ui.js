/**
 * courthouse-roster-ui.js
 * Per-host Judge Roster panel for courthouse.html
 *
 * Loads judge-roster + judge-defaults from /api/benchmark, renders a card per
 * Ollama host showing all available judges with their tier/reliability/latency
 * stats, and lets admins set/clear the default judge per host.
 */

(function () {
    'use strict';

    const TIER_RANK = { basic: 1, standard: 2, advanced: 3, premium: 4 };
    const TIER_LABEL = { basic: 'BASIC', standard: 'STD', advanced: 'ADV', premium: 'PRO' };
    const TIER_COLORS = {
        basic: { bg: 'rgba(108,117,125,0.2)', border: 'rgba(108,117,125,0.5)', text: '#adb5bd' },
        standard: { bg: 'rgba(13,110,253,0.15)', border: 'rgba(13,110,253,0.5)', text: '#4096ff' },
        advanced: { bg: 'rgba(25,135,84,0.15)', border: 'rgba(25,135,84,0.5)', text: '#52c41a' },
        premium: { bg: 'rgba(220,53,69,0.15)', border: 'rgba(220,53,69,0.5)', text: '#ff4d4f' }
    };

    function tierBadge(tier) {
        const c = TIER_COLORS[tier] || TIER_COLORS.standard;
        const label = TIER_LABEL[tier] || (tier || '?').toUpperCase();
        return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:0.72em;
            font-weight:700;letter-spacing:.5px;background:${c.bg};border:1px solid ${c.border};
            color:${c.text};">${label}</span>`;
    }

    function tierCell(judge) {
        const tier = judge.tier;
        const inferred = judge.inferredTier;
        const hasConflict = judge.hasConflict || (judge.source !== 'discovered' && inferred && inferred !== tier);
        const c = tier
            ? (TIER_COLORS[tier] || TIER_COLORS.standard)
            : { bg: 'rgba(100,100,100,0.2)', border: 'rgba(100,100,100,0.4)', text: '#888' };

        const opts = [
            !tier ? '<option value="" selected disabled>?</option>' : '',
            ...['basic', 'standard', 'advanced', 'premium'].map(t =>
                `<option value="${t}"${tier === t ? ' selected' : ''}>${TIER_LABEL[t]}</option>`)
        ].join('');

        const conflictHint = hasConflict
            ? `<span title="Registry tier: ${TIER_LABEL[tier] || '?'}. Size heuristic suggests: ${TIER_LABEL[inferred] || inferred}. Select the correct tier to save."
                style="color:#f39c12;cursor:help;font-size:0.9em;margin-left:2px;flex-shrink:0;">⚠</span>`
            : '';

        return `<div style="display:flex;align-items:center;gap:3px;justify-content:center;">
            <select class="roster-tier-select"
                data-model="${esc(judge.modelName)}"
                data-original-tier="${esc(tier || '')}"
                title="Click to change judge tier"
                style="font-size:0.72em;font-weight:700;padding:2px 6px;border-radius:4px;
                    background:${c.bg};border:1px solid ${c.border};color:${c.text};
                    cursor:pointer;appearance:none;-webkit-appearance:none;
                    text-align:center;letter-spacing:.5px;width:56px;">
                ${opts}
            </select>${conflictHint}
        </div>`;
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

    function sourceBadge(source) {
        if (source === 'discovered') {
            return `<span style="font-size:0.72em;color:var(--muted);background:rgba(255,255,255,0.06);
                padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.08);">auto-detected</span>`;
        }
        return '';
    }

    function esc(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c]));
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

    function renderJudgeRow(judge, isDefault) {
        const defaultBadge = isDefault
            ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.75em;
                font-weight:700;background:rgba(124,240,255,0.15);border:1px solid rgba(124,240,255,0.45);
                color:var(--accent);margin-left:6px;"><i class="fas fa-star"></i> DEFAULT</span>`
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

        const evalCount = judge.evalCount > 0
            ? `<span style="color:var(--muted);font-size:0.82em;">${judge.evalCount.toLocaleString()} evals</span>`
            : '<span style="color:var(--muted);font-size:0.82em;">no evals</span>';

        const calibratedAt = judge.calibratedAt
            ? `<span style="color:var(--muted);font-size:0.75em;" title="Last calibrated">
                <i class="fas fa-flask"></i> ${new Date(judge.calibratedAt).toLocaleDateString()}
               </span>`
            : '';

        return `<tr data-model="${esc(judge.modelName)}">
            <td style="padding:10px 8px;vertical-align:middle;">
                <div style="font-weight:600;font-size:0.92em;">${esc(judge.modelName)}${defaultBadge}</div>
                <div style="margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    ${sourceBadge(judge.source)} ${calibratedAt}
                </div>
            </td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${tierCell(judge)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${reliabilityBadge(judge.reliability)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${latencyBadge(judge.avgLatencyMs)}</td>
            <td style="padding:10px 8px;text-align:center;vertical-align:middle;">${evalCount}</td>
            <td style="padding:10px 8px;text-align:right;vertical-align:middle;">${setDefaultBtn}</td>
        </tr>`;
    }

    function renderHostPanel(panel) {
        const defaultModel = panel.defaultJudgeModel;
        const judges = panel.judges || [];
        const tierCoverage = [...new Set(judges.map(j => j.tier).filter(Boolean))]
            .sort((a, b) => (TIER_RANK[b] || 0) - (TIER_RANK[a] || 0));

        const coverageBadges = tierCoverage.map(t => tierBadge(t)).join(' ');
        const countLabel = `${judges.length} judge${judges.length !== 1 ? 's' : ''} available`;

        const defaultInfo = defaultModel
            ? `<span style="color:var(--muted);font-size:0.85em;">Default: </span>
               <code style="font-size:0.85em;color:var(--accent);">${esc(defaultModel)}</code>`
            : '<span style="color:var(--muted);font-size:0.85em;font-style:italic;">No default set — uses server config</span>';

        const rows = judges.length === 0
            ? `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted);">
                <i class="fas fa-ghost"></i> No judge-capable models detected on this host
               </td></tr>`
            : judges.map(j => renderJudgeRow(j, j.modelName === defaultModel)).join('');

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
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Tier</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Reliability</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Avg Latency</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:center;">Evals</th>
                            <th style="padding:8px;font-size:0.8em;color:var(--muted);font-weight:600;text-align:right;">Action</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div style="padding:10px 18px;background:rgba(0,0,0,0.12);border-top:1px solid rgba(255,255,255,0.05);
                font-size:0.8em;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <i class="fas fa-info-circle"></i>
                <span>Tier coverage: ${coverageBadges || '<em>none</em>'}</span>
                <span style="margin-left:8px;">Levels 1-3 need BASIC · 4-6 need STD · 7-8 need ADV · 9-10 need PRO</span>
            </div>
        </div>`;
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

        container.innerHTML = panels.map(p => renderHostPanel(p)).join('');

        container.querySelectorAll('.roster-tier-select').forEach(select => {
            select.addEventListener('change', async e => {
                const sel = e.currentTarget;
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
                        const j = await resp.json().catch(() => ({}));
                        throw new Error(j.error || `HTTP ${resp.status}`);
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

        container.querySelectorAll('.roster-set-default-btn').forEach(btn => {
            btn.addEventListener('click', async e => {
                const hostPanel = e.currentTarget.closest('.roster-host-panel');
                const hostUrl = hostPanel && hostPanel.dataset.host;
                const model = e.currentTarget.dataset.model;
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

        container.querySelectorAll('.roster-clear-default-btn').forEach(btn => {
            btn.addEventListener('click', async e => {
                const hostPanel = e.currentTarget.closest('.roster-host-panel');
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
