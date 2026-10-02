// index.js — Leaderboard v2 entry point
// Wires all sections together: hero, podium, grouped model board, scoring
// system, category map. The server groups its rows into one group per model
// and host; this page renders those groups and never selects a cohort itself.

import {
    fetchDashboard,
    fetchGeneralistLeaderboard,
    fetchGroundTruthGaps,
    fetchHosts
} from './api.js';

import { renderHero }             from './hero.js';
import { renderPodium }           from './podium.js';
import { renderCombinedBoard }    from './combined-board.js';
import { renderCategoryMap }       from './category-map.js';
import { renderScoringSystem }     from './scoring-system.js';
import { groupsFromResponse }      from './view-model.js';
import { esc }                     from './verdict.js';
import { initSectionCollapse }    from '../components/section-collapse.js';
import { showFatalError, showSectionError } from '../components/error-banner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the initial loading skeleton in <main> */
function showLoadingState(main) {
    main.innerHTML = `<div class="r-loading" style="padding:3rem;text-align:center;color:var(--r-text-dim,#888);">
        <div style="font-size:1.5rem;margin-bottom:0.5rem;">⏳</div>
        <div>Loading leaderboard data…</div>
    </div>`;
}

/** Replace <main> contents with a fatal error state + retry button */
function showErrorState(main, err) {
    main.innerHTML = `<button class="r-nav-btn r-primary" id="retry-btn" style="display:block;margin:1rem auto;">Retry</button>`;
    showFatalError(`Failed to load leaderboard: ${err.message}`, main);
    const retryBtn = main.querySelector('#retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => init());
}

function hideInactiveSurface(element) {
    if (!element) return;
    element.hidden = true;
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
}

/** Short host label from a URL (strip scheme + :11434) — fallback display name. */
function shortHostName(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

/**
 * Build the Hosts selector — one coherent control that replaces BOTH the old
 * host/current/all scope buttons AND the hero's click-to-filter
 * pills. Every host option is data-driven from the configured-host list, so
 * there are no hard-coded host names. Reads left→right as:
 *   [ All hosts ]  ● host gpu  ● host gpu  …  ┊  [ All history ]
 */
function hostSelectOptionsHtml(hosts) {
    const chips = (Array.isArray(hosts) ? hosts : []).map(h => {
        const url = h.url || h.host || '';
        if (!url) return '';
        const name = h.name || h.id || shortHostName(url);
        const online = h.available !== false;
        return `<button type="button" class="r-host-opt" data-host-url="${esc(url)}" title="Show only results from ${esc(name)}">
            <span class="r-host-opt-dot ${online ? 'on' : 'off'}"></span>
            <span class="r-host-opt-name">${esc(name)}</span>
        </button>`;
    }).join('');
    return `<button type="button" class="r-host-opt r-host-all" data-host-scope="current" title="Every host in the current configured fleet">All hosts</button>
        ${chips}
        <span class="r-fb-div" aria-hidden="true"></span>
        <button type="button" class="r-host-opt r-host-arch" data-host-scope="all" title="Every host ever benchmarked, including retired hardware">
            <i class="fas fa-clock-rotate-left" aria-hidden="true"></i> All history
        </button>`;
}

/** Restore the section containers after a successful initial fetch */
function restoreShell(main, hosts = []) {
    main.innerHTML = `
        <details id="filter-bar" class="r-filterbar" aria-label="Leaderboard filters" open>
            <summary class="r-filter-summary">
                <span><i class="fas fa-sliders" aria-hidden="true"></i> Filters</span>
                <small id="filter-summary-value">Quality · all difficulty levels</small>
            </summary>
            <div class="r-filter-body">
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-arrow-down-wide-short" aria-hidden="true"></i> Rank by</span>
                <div class="r-seg">
                    <button type="button" class="r-seg-btn" data-axis="composite" title="Blended deterministic + judge score">Composite</button>
                    <button type="button" class="r-seg-btn" data-axis="quality" title="Common quality score; required when cloud models are shown">Quality</button>
                    <button type="button" class="r-seg-btn" data-axis="deterministic" title="Rule-based deterministic scoring only">Deterministic</button>
                    <button type="button" class="r-seg-btn" data-axis="subjective" title="Judge-model scoring only">Judge</button>
                </div>
            </div>
            <div class="r-fgroup r-fgroup-hosts">
                <span class="r-fgroup-label"><i class="fas fa-server" aria-hidden="true"></i> Hosts</span>
                <div class="r-host-select">${hostSelectOptionsHtml(hosts)}</div>
            </div>
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-cloud" aria-hidden="true"></i> Sources</span>
                <label class="r-archive-toggle" title="Include OpenClaw and Hermès cloud-model evidence in server-side ranks, charts and exports">
                    <input type="checkbox" id="include-cloud-models">
                    <span>Cloud models</span>
                </label>
            </div>
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-gauge-high" aria-hidden="true"></i> Difficulty</span>
                <div class="r-seg">
                    <button type="button" class="r-seg-btn" data-challenge-scope="foundation" title="Only L1-L3 foundation prompts">Foundation</button>
                    <button type="button" class="r-seg-btn" data-challenge-scope="advanced" title="Only L4-L5 hard prompts">Hard L4-L5</button>
                    <button type="button" class="r-seg-btn" data-challenge-scope="all" title="All prompt levels, with a hard-level coverage penalty">All levels</button>
                </div>
            </div>
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-box-archive" aria-hidden="true"></i> Archive</span>
                <label class="r-archive-toggle" title="Show registered benchmark rows for models no longer present on their Ollama host">
                    <input type="checkbox" id="include-unavailable-models">
                    <span>Show deleted</span>
                </label>
            </div>
            <p class="r-view-summary" id="view-summary" aria-live="polite"></p>
            </div>
        </details>
        <div id="leaderboard" class="r-section"></div>
        <details id="leaderboard-cohort-overview" class="r-cohort-lab">
            <summary>
                <span><i class="fas fa-layer-group" aria-hidden="true"></i> Cohort visuals & scoring</span>
                <small>Podium view, fleet summary, scoring method and category heatmap</small>
            </summary>
            <div class="r-cohort-lab-body">
                <section id="hero"></section>
                <section id="podium"></section>
                <div id="scoring-system" class="r-section"></div>
                <div id="category-map" class="r-section"></div>
            </div>
        </details>`;
    // Open on a wide screen, folded behind its summary on a phone. The summary
    // is hidden on a wide screen, so a bar folded there could never reopen:
    // follow the viewport as it changes, not only at load.
    const filterBar = main.querySelector('#filter-bar');
    if (filterBar && typeof window.matchMedia === 'function') {
        const narrow = window.matchMedia('(max-width: 700px)');
        filterBar.open = !narrow.matches;
        narrow.addEventListener?.('change', event => { filterBar.open = !event.matches; });
    }
}

// Module-level state — survives re-init() calls so chip clicks pick the right axis
let _currentAxis = 'composite';
// Host filtering is now a single coherent control. _hostScope is the configured
// fleet ('current') or the full archive ('all'); _selectedHost narrows to one
// host URL and always implies 'current' scope. Default to the full archive so
// the board is never empty just because the current primary host has no
// benchmark coverage yet.
let _hostScope = 'all';
let _selectedHost = null;
let _challengeScope = 'all';
let _includeUnavailableModels = false;
let _includeCloud = true;

try {
    _includeUnavailableModels = localStorage.getItem('leaderboardIncludeUnavailableModels') === 'true';
    _includeCloud = localStorage.getItem('leaderboardIncludeCloud') !== 'false';
    const savedHostScope = localStorage.getItem('leaderboardHostScope');
    if (savedHostScope === 'current' || savedHostScope === 'all') _hostScope = savedHostScope;
    const savedHost = localStorage.getItem('leaderboardSelectedHost');
    if (savedHost) { _selectedHost = savedHost; _hostScope = 'current'; }
} catch (_) {}

function wireAxisChip(main, leaderboardMeta = {}, coverageRes = null) {
    const bar = main.querySelector('#filter-bar');
    if (!bar) return;

    // Rank-by (score axis)
    bar.querySelectorAll('[data-axis]').forEach(btn => {
        if (_includeCloud && btn.dataset.axis === 'composite') {
            btn.disabled = true;
            btn.title = 'Composite quality + latency is available only when Cloud models is unchecked';
        }
        if (btn.dataset.axis === _currentAxis) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (btn.dataset.axis === _currentAxis) return;
            _currentAxis = btn.dataset.axis;
            init();
        });
    });

    const cloudToggle = bar.querySelector('#include-cloud-models');
    if (cloudToggle) {
        cloudToggle.checked = _includeCloud;
        cloudToggle.addEventListener('change', () => {
            _includeCloud = cloudToggle.checked;
            if (_includeCloud && _currentAxis === 'composite') _currentAxis = 'quality';
            try { localStorage.setItem('leaderboardIncludeCloud', String(_includeCloud)); } catch (_) {}
            init();
        });
    }

    // Hosts — one selector: All hosts / a single host / All history.
    const applyHostChoice = (scope, host) => {
        _hostScope = scope;
        _selectedHost = host;
        try {
            localStorage.setItem('leaderboardHostScope', scope);
            if (host) localStorage.setItem('leaderboardSelectedHost', host);
            else localStorage.removeItem('leaderboardSelectedHost');
        } catch (_) {}
        init();
    };
    bar.querySelectorAll('.r-host-opt').forEach(btn => {
        const url = btn.dataset.hostUrl || null;
        const scopeAttr = btn.dataset.hostScope || null; // 'current' (All hosts) | 'all' (All history)
        const isActive = scopeAttr === 'all'
            ? _hostScope === 'all'
            : scopeAttr === 'current'
                ? (_hostScope === 'current' && !_selectedHost)
                : (_hostScope === 'current' && _selectedHost === url);
        if (isActive) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (scopeAttr === 'all') applyHostChoice('all', null);
            else if (scopeAttr === 'current') applyHostChoice('current', null);
            else if (url) applyHostChoice('current', _selectedHost === url ? null : url); // click again to clear
        });
    });

    // Difficulty (challenge cohort)
    bar.querySelectorAll('[data-challenge-scope]').forEach(btn => {
        const scope = btn.dataset.challengeScope;
        if (scope === _challengeScope) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (scope === _challengeScope) return;
            _challengeScope = ['all', 'foundation'].includes(scope) ? scope : 'advanced';
            init();
        });
    });

    const unavailableToggle = bar.querySelector('#include-unavailable-models');
    if (unavailableToggle) {
        unavailableToggle.checked = _includeUnavailableModels;
        unavailableToggle.addEventListener('change', () => {
            _includeUnavailableModels = unavailableToggle.checked;
            try {
                localStorage.setItem('leaderboardIncludeUnavailableModels', String(_includeUnavailableModels));
            } catch (_) {}
            init();
        });
    }

    // Plain-language summary of the active view — turns the control states into
    // one readable sentence so users always know what the board is showing.
    const summaryEl = bar.querySelector('#view-summary');
    if (summaryEl) {
        const axisLabel = { composite: 'Composite', quality: 'Quality', deterministic: 'Deterministic', subjective: 'Judge' }[_currentAxis] || 'Quality';
        const hostLabel = _hostScope === 'all'
            ? 'all hosts ever benchmarked'
            : _selectedHost
                ? (bar.querySelector('.r-host-opt.is-active .r-host-opt-name')?.textContent?.trim() || 'one host')
                : 'every configured host';
        const diffLabel = _challengeScope === 'foundation'
            ? 'foundation prompts (L1–L3)'
            : _challengeScope === 'all'
                ? 'all difficulty levels'
                : 'hard prompts (L4–L5)';
        const archiveNote = _includeUnavailableModels
            ? ' <span class="r-vs-dot">·</span> including deleted models'
            : '';
        const cloudNote = _includeCloud ? ' <span class="r-vs-dot">·</span> cloud included' : ' <span class="r-vs-dot">·</span> local only';
        // Hard-level judge scores are not human-calibrated until every L4–L5
        // cell meets its target: say so on the hard view, in the sentence.
        const hard = (coverageRes?.data || coverageRes)?.hard_scope || null;
        const hardNote = _challengeScope === 'advanced' && _currentAxis !== 'deterministic' && hard?.ready !== true
            ? ` <span class="r-vs-dot">·</span> Hard L4–L5 judge evidence is provisional: ${hard ? `${hard.cells_meeting_target || 0}/${hard.total_cells || 14} cells meet the human calibration target` : 'human calibration coverage unknown'}`
            : '';
        summaryEl.innerHTML = `<i class="fas fa-eye" aria-hidden="true"></i> <span class="r-vs-text">Showing the <b>${axisLabel}</b> ranking across <b>${hostLabel}</b>, scored on <b>${diffLabel}</b>${cloudNote}${archiveNote}.${hardNote}</span>`;
        const compactSummary = bar.querySelector('#filter-summary-value');
        if (compactSummary) compactSummary.textContent = `${axisLabel} · ${diffLabel}`;
    }
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

async function init() {
    const main = document.querySelector('main');
    if (!main) return;

    showLoadingState(main);
    if (_includeCloud && _currentAxis === 'composite') _currentAxis = 'quality';

    // --- Step 1: critical parallel fetch ---
    let dashboardRes, generalistRes, hostsRes, coverageRes;
    try {
        [dashboardRes, generalistRes, hostsRes, coverageRes] = await Promise.all([
            fetchDashboard(_includeUnavailableModels, _includeCloud),
            fetchGeneralistLeaderboard(_currentAxis, _hostScope, _challengeScope, _includeUnavailableModels, _includeCloud),
            fetchHosts().catch(() => ({ hosts: [] })),
            fetchGroundTruthGaps().catch(() => null)
        ]);
    } catch (err) {
        console.error('[leaderboard] initial fetch failed:', err);
        showErrorState(main, err);
        return;
    }

    await renderLeaderboardPage(main, { dashboardRes, generalistRes, hostsRes, coverageRes });
}

/**
 * Render the page from already-fetched responses. `init()` calls this after
 * its fetch; the static fixture page under tests/fixtures calls it directly.
 */
export async function renderLeaderboardPage(main, { dashboardRes, generalistRes, hostsRes, coverageRes }) {
    const dashboard = dashboardRes?.data;
    const board = generalistRes?.data;
    if (dashboardRes?.status !== 'success' || generalistRes?.status !== 'success'
        || !Number.isSafeInteger(dashboard?.overview?.total_tests)
        || dashboard.overview.total_tests < 0
        || !Array.isArray(dashboard.model_stats)
        || !(Array.isArray(board?.groups) || Array.isArray(board?.leaderboard))) {
        showErrorState(main, new Error('Unexpected leaderboard response. Refresh and try again.'));
        return;
    }
    // Build host list + URL→friendly-name map; the list also feeds the Hosts selector.
    const hostsList = hostsRes?.hosts || hostsRes || [];
    const hostNameMap = {};
    if (Array.isArray(hostsList)) {
        for (const h of hostsList) {
            const url = h.url || h.host || '';
            const name = h.name || h.hostname || '';
            if (url && name) hostNameMap[url] = name;
        }
    }

    // Drop a stale single-host selection if that host is no longer configured,
    // so we never show an unexplained empty board from a removed host.
    if (_selectedHost && Array.isArray(hostsList)
        && !hostsList.some(h => (h.url || h.host) === _selectedHost)) {
        _selectedHost = null;
        try { localStorage.removeItem('leaderboardSelectedHost'); } catch (_) {}
    }

    // Restore section containers (the Hosts selector renders from hostsList)
    restoreShell(main, Array.isArray(hostsList) ? hostsList : []);
    wireAxisChip(main, generalistRes?.data || {}, coverageRes);

    // One board group per model and host, as the server grouped them. When a
    // single host is selected, narrow to it (the server returns the whole
    // configured fleet under 'current' scope).
    const boardGroups = groupsFromResponse(generalistRes?.data, {
        scoreAxis: _currentAxis, hostNameMap, selectedHost: _selectedHost
    });
    // Headline rows in the server's own shape (podium and hero read those
    // fields), and their board entries (category map and the model board).
    const rawHeadlines = boardGroups.map(group => group.raw);
    const rankings = boardGroups.map(group => group.headline);
    // The hero counts every result behind each model and host, all cohorts
    // included, not only the headline cohort's.
    const heroRows = boardGroups.map(group => ({ ...group.raw, totalTests: group.resultCount }));

    // --- Step 2: hero (async, handles its own host fetch internally) ---
    const heroEl = main.querySelector('#hero');
    if (heroEl) {
        try {
            await renderHero(heroEl, dashboardRes, {
                hostScope: _hostScope,
                challengeScope: _challengeScope,
                challengeLevelRange: generalistRes?.data?.challengeLevelRange || null,
                rankings: heroRows,
                hostsRes
            });
        } catch (err) {
            console.warn('[hero] render failed:', err);
            showSectionError(heroEl, 'Could not render hero section.');
        }
    }

    const historicalCount = Number(dashboardRes?.data?.overview?.total_tests || 0);
    const hasHistoricalEvidence = historicalCount > 0
        || (Array.isArray(dashboardRes?.data?.model_stats) && dashboardRes.data.model_stats.length > 0);
    if (!hasHistoricalEvidence) {
        const filterBar = main.querySelector('#filter-bar');
        hideInactiveSurface(filterBar);
        const leaderboardEl = main.querySelector('#leaderboard');
        if (leaderboardEl) {
            leaderboardEl.innerHTML = `
                <section class="results-empty-experience" role="status">
                    <span class="results-empty-icon" aria-hidden="true"><i class="fas fa-trophy"></i></span>
                    <h1>No ranked models yet</h1>
                    <p>Run one focused comparison to create the first evidence-backed ranking.</p>
                    <div class="results-empty-actions">
                        <a href="/"><i class="fas fa-play" aria-hidden="true"></i> Run a comparison</a>
                        <a href="/profiler"><i class="fas fa-microchip" aria-hidden="true"></i> Prepare a host</a>
                    </div>
                </section>`;
        }
        ['podium', 'scoring-system', 'category-map'].forEach(id => {
            const section = main.querySelector('#' + id);
            hideInactiveSurface(section);
        });
        hideInactiveSurface(main.querySelector('#leaderboard-cohort-overview'));
        return;
    }

    // --- Step 3: podium (comparable verdicts only; performance already on the rows) ---
    const podiumEl = main.querySelector('#podium');
    const categoryWeights = generalistRes?.data?.categoryWeights || null;
    if (podiumEl) {
        try {
            renderPodium(podiumEl, rawHeadlines, { categoryWeights });
        } catch (err) {
            console.warn('[podium] render failed:', err);
            showSectionError(podiumEl, 'Could not render podium.');
        }
    }

    // --- Step 3b: scoring system (How Scoring Works + Shared Weights + Customize) ---
    const scoringEl = main.querySelector('#scoring-system');
    if (scoringEl) {
        try {
            renderScoringSystem(scoringEl, { categoryWeights });
        } catch (err) {
            console.warn('[scoring-system] render failed:', err);
        }
    }

    // --- Step 4: grouped Model Leaderboard (one row per model and host) ---
    const leaderboardEl = main.querySelector('#leaderboard');
    if (leaderboardEl) {
        try {
            await renderCombinedBoard(leaderboardEl, boardGroups);
        } catch (err) {
            console.warn('[leaderboard] initial render failed:', err);
            showSectionError(leaderboardEl, 'Could not render Model Leaderboard.');
        }

        // Judge calibration is the only enrichment still fetched separately;
        // re-render once it is known. Category values already come from the
        // exact filtered leaderboard cohort and must not be overwritten.
        (async () => {
            try {
                const calRes = await fetch('/api/benchmark/judge/calibration-status').then(r => r.json());
                const targetKey = (host, model) => `${String(host || '').trim().replace(/\/+$/, '').toLowerCase()}@@${String(model || '').trim().toLowerCase()}`;
                const calibratedJudges = new Set(
                    (calRes.data?.matrices || []).map(m => targetKey(m.judge_host, m.judge_model))
                );
                for (const entry of rankings) {
                    entry.judgeCalibrated = (entry.judgeTargets || [])
                        .some(target => calibratedJudges.has(targetKey(target.host, target.model)));
                }
                await renderCombinedBoard(leaderboardEl, boardGroups);
                // Re-bind collapse handlers for the re-rendered section header
                initSectionCollapse(leaderboardEl);
            } catch (err) {
                console.warn('[leaderboard] calibration enrichment skipped:', err);
            }
        })();
    }

    // --- Step 7: category map (headline entries only, one per model and host) ---
    const categoryMapEl = main.querySelector('#category-map');
    if (categoryMapEl) {
        try {
            renderCategoryMap(categoryMapEl, rankings.filter(e => !e.filtered && e.rankable !== false));
        } catch (err) {
            console.warn('[category-map] render failed:', err);
            showSectionError(categoryMapEl, 'Could not render category map.');
        }
    }

    // Host filtering lives entirely in the #filter-bar Hosts selector (single
    // host narrowing is applied to the groups above). The CSV export button
    // is rendered and wired by the model board itself.

    // --- Step 8: section collapse ---
    initSectionCollapse(main);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// The static fixture page (tests/fixtures) marks <main data-leaderboard-source="fixture">
// and feeds renderLeaderboardPage itself; the served page fetches.
if (document.querySelector('main')?.dataset?.leaderboardSource !== 'fixture') {
    document.addEventListener('DOMContentLoaded', init);
}
