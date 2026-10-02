// batch-config-launch.js — preflight display, form submit and batch launch for the
// benchmark-v2 batch config form. Extracted from batch-config.js. It reads the form
// state (current host, harness targets) and depth helpers from that module only
// inside its functions, so the import cycle is safe at load.

import { esc } from './helpers.js';
import {
    _currentHost, _deriveLevels, _estimateCount, _harnessTargetMap, _readLevelDepth, LEVELS
} from './batch-config.js';
import {
    fetchActiveProfilingState, findProfilingForHost, formatProfilingLockout
} from './profiling-lockout.js';
import { getSelectedJudge } from './judge-roster.js';
import { _readAdvancedSettings } from './batch-config-advanced.js';
import { preflight } from './api.js';
import { _readMultiJudgeFromUI } from './batch-config-multijudge.js';

let _launchInFlight = false;

// ── Preflight display helpers ─────────────────────────────────────────────────

function _setLaunchSummaryStatus(state, message, detail = '') {
    const statusEl = document.getElementById('ls-launch-status');
    if (!statusEl) return;

    statusEl.dataset.launchState = state;
    statusEl.className = `ls-launch-status ls-launch-${state}`;
    statusEl.innerHTML = `
      <span class="ls-launch-status-kicker">${esc(message)}</span>
      ${detail ? `<span class="ls-launch-status-detail">${esc(detail)}</span>` : ''}`;
}

function _publishLaunchStatus(container, state, message, detail = '') {
    _setLaunchSummaryStatus(state, message, detail);
    container.dispatchEvent(new CustomEvent('benchmark-launch-status', {
        bubbles: true,
        detail: { state, message, detail }
    }));
}

function _resetLaunchButton() {
    const btn = document.querySelector('#ls-launch-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = 'Launch Benchmark';
    btn.style.opacity = '';
}

/** Extract warnings from the nested preflight checks object */
function _collectPreflightWarnings(pf) {
    if (!pf?.checks) return [];
    const warnings = [];
    // Top-level warnings (dedication, etc.)
    if (Array.isArray(pf.warnings)) warnings.push(...pf.warnings);
    const c = pf.checks;
    if (Array.isArray(c.hosts)) {
        c.hosts.forEach(h => {
            if (Array.isArray(h.warnings)) warnings.push(...h.warnings);
            if (h.host_ok === false) warnings.push(`Host ${h.host || 'unknown'}: ${h.error || 'unreachable'}`);
        });
    }
    if (c.judge) {
        if (Array.isArray(c.judge.warnings)) warnings.push(...c.judge.warnings);
        if (Array.isArray(c.judge.blockers)) warnings.push(...c.judge.blockers);
    }
    if (c.prompts) {
        if (Array.isArray(c.prompts.warnings)) warnings.push(...c.prompts.warnings);
        if (Array.isArray(c.prompts.blockers)) warnings.push(...c.prompts.blockers);
    }
    if (c.dedication?.warnings?.length) {
        warnings.push(...c.dedication.warnings);
    }
    return warnings;
}

/** Show a preflight issues/warnings banner above the launch button */
function _showPreflightBanner(container, errors, warnings, isBlocking) {
    _clearPreflightBanner(container);
    if (!errors.length && !warnings.length) return;
    const banner = document.createElement('div');
    banner.id = 'bv2-preflight-banner';
    banner.style.cssText = `margin:0.5rem 0;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.72rem;line-height:1.5;border:1px solid ${isBlocking ? 'rgba(239,83,80,0.3)' : 'rgba(210,153,34,0.3)'};background:${isBlocking ? 'rgba(239,83,80,0.08)' : 'rgba(210,153,34,0.08)'};color:${isBlocking ? 'var(--r-error,#f85149)' : 'var(--r-warn,#d29922)'}`;
    const title = isBlocking ? 'Preflight errors (launch blocked):' : 'Preflight warnings:';
    let html = `<div style="font-weight:600;margin-bottom:0.25rem;">${esc(title)}</div><ul style="margin:0;padding-left:1.2rem;">`;
    for (const e of errors)   html += `<li>${esc(e)}</li>`;
    for (const w of warnings) html += `<li>${esc(w)}</li>`;
    html += '</ul>';
    banner.innerHTML = html;
    const errEl = container.querySelector('#bv2-form-error');
    if (errEl) errEl.parentNode.insertBefore(banner, errEl);
    else container.appendChild(banner);
}

/** Remove preflight banner if present */
function _clearPreflightBanner(container) {
    const existing = container.querySelector('#bv2-preflight-banner');
    if (existing) existing.remove();
}

// ── Form submit / launch ──────────────────────────────────────────────────────

function _wireSubmit(container, host, onLaunch) {
    const form = container.querySelector('#bv2-batch-form');
    if (!form) return;

    form.addEventListener('submit', async e => {
        e.preventDefault();
        await _handleLaunch(container, host, onLaunch);
    });
}

async function _handleLaunch(container, host, onLaunch) {
    if (_launchInFlight) return;
    _launchInFlight = true;
    const btn = document.querySelector('#ls-launch-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
        await _launchBatch(container, host, onLaunch);
    } finally {
        _launchInFlight = false;
        _resetLaunchButton();
    }
}

async function _launchBatch(container, host, onLaunch) {
    const errEl = container.querySelector('#bv2-form-error');
    const btn   = document.querySelector('#ls-launch-btn');

    if (container.dataset.quickPending) {
        _publishLaunchStatus(container, 'blocked', 'Checking measured settings', 'Wait for Quick comparison to finish checking, then launch.');
        return;
    }

    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.style.display = ''; } }
    function clearErr()   { if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; } }

    clearErr();
    _clearPreflightBanner(container);
    _publishLaunchStatus(
        container,
        'checking',
        'Checking launch inputs',
        'Validating host, models, judge, and selected prompt depth.'
    );

    // 1. Execution host — from infrastructure selection, not a dropdown
    const execHostUrl = _currentHost?.hostUrl || _currentHost?.url || '';
    const selectedCandidateCbs = Array.from(container.querySelectorAll('.bv2-model-cb:checked'));
    const needsOllamaHost = selectedCandidateCbs.some((cb) => cb.dataset.executionKind !== 'harness');
    if (!execHostUrl && needsOllamaHost) {
        const message = 'Select an execution host in the Infrastructure section above.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        return;
    }

    try {
        if (execHostUrl && needsOllamaHost) {
        _publishLaunchStatus(
            container,
            'checking',
            'Checking profiler activity',
            'Confirming the selected host is not busy with profiling.'
        );
            const profilingState = await fetchActiveProfilingState();
            const activeProfiling = findProfilingForHost(_currentHost || execHostUrl, profilingState);
            if (activeProfiling.length) {
                const message = `${formatProfilingLockout(activeProfiling)}. Wait for profiling to finish or cancel it before launching a benchmark.`;
                showErr(message);
                _publishLaunchStatus(container, 'blocked', 'Launch blocked by profiler', message);
                return;
            }
        }
    } catch (err) {
        const message = `Could not verify profiler activity: ${err.message}`;
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Profiler check failed', message);
        return;
    }

    // 2. Selected models
    const modelCbs = selectedCandidateCbs;
    if (!modelCbs.length) {
        const message = 'Select at least one model.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        return;
    }
    const localModelCbs = modelCbs.filter((cb) => cb.dataset.executionKind !== 'harness');
    const cloudModelCbs = modelCbs.filter((cb) => cb.dataset.executionKind === 'harness');
    const models = localModelCbs.map(cb => cb.value);
    const targets = [
        ...localModelCbs.map((cb) => ({ host: cb.dataset.host || execHostUrl, model: cb.value })),
        ...cloudModelCbs.map((cb) => _harnessTargetMap.get(cb.dataset.targetId)).filter(Boolean)
    ];

    // 3. Judge config (from roster or fallback)
    const judge = getSelectedJudge(container);
    const cloudJudgeTarget = judge.targetId ? _harnessTargetMap.get(judge.targetId) : null;
    if (!judge.model) {
        const message = 'Select a judge model.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        return;
    }
    if (!judge.host && !cloudJudgeTarget)  {
        const message = 'Select a judge host.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        return;
    }

    // 4. Level depth
    const depthConfig = _readLevelDepth(container);
    const levels      = _deriveLevels(depthConfig);
    if (!levels.length) {
        const message = 'All levels are Off — enable at least one.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        return;
    }
    const advSettings = _readAdvancedSettings(container);

    // 5. Preflight — surface errors and warnings before launch
    if (btn) { btn.disabled = true; btn.textContent = '\u27F3 Preflight\u2026'; }
    _publishLaunchStatus(
        container,
        'preflight',
        'Running preflight checks',
        'Checking host reachability, selected models, judge availability, prompts, and batch locks.'
    );

    let preflightResult;
    try {
        const hasHarnessExecution = cloudModelCbs.length > 0 || !!cloudJudgeTarget;
        const pfRes = hasHarnessExecution ? { data: {
            ready: true,
            issues: [],
            checks: { harness_catalog: { ready: true, server_revalidates_before_each_cell: true } }
        } } : await preflight({
            targets: models.map(model => ({ host: execHostUrl, model })),
            judge_config: {
                model: judge.model,
                host: judge.host,
                temperature: advSettings.temperature,
                num_predict: advSettings.num_predict,
                num_ctx: advSettings.num_ctx,
                max_retries: advSettings.max_retries,
                timeout: advSettings.timeout,
                voting_count: advSettings.voting_count,
                think: advSettings.think
            },
            levels,
            execution_config: {
                force_num_ctx: advSettings.force_num_ctx,
                response_max_tokens: advSettings.response_max_tokens,
                answer_contract_mode: advSettings.answer_contract_mode,
                include_length_hint: !!advSettings.include_length_hint,
                length_hint_template: advSettings.length_hint_template,
                custom_hint: advSettings.custom_hint,
                think: container.querySelector('#bv2-think')?.value || 'best_qualified'
            }
        });
        preflightResult = pfRes?.data || pfRes;
    } catch (err) {
        const message = `Preflight failed: ${err.message}`;
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Preflight failed', message);
        return;
    }

    // Collect warnings from the checks object
    const pfWarnings = _collectPreflightWarnings(preflightResult);

    // If preflight has blocking issues, show them and abort
    if (preflightResult && preflightResult.ready === false) {
        const issues = preflightResult.issues || [];
        const detail = issues.length ? issues.map(i => '\u2022 ' + i).join('\n') : 'Unknown preflight error';
        showErr('Preflight blocked:\n' + detail);
        _showPreflightBanner(container, issues, pfWarnings, true);
        _publishLaunchStatus(
            container,
            'blocked',
            'Preflight blocked launch',
            issues.length ? issues.join(' • ') : 'Unknown preflight error'
        );
        return;
    }

    // If there are warnings but preflight passed, show them but allow launch
    if (pfWarnings.length > 0) {
        _showPreflightBanner(container, [], pfWarnings, false);
    } else {
        _clearPreflightBanner(container);
    }

    // 6. Build payload — merge advanced settings into judge_config and execution_config
    const think = container.querySelector('#bv2-think')?.value || 'best_qualified';
    const selectedPromptCount = LEVELS.reduce((sum, level) => sum + _estimateCount(level, depthConfig[level] || 'off'), 0);
    const repeats = Math.max(1, Math.min(5, Number(advSettings.exec_repeats) || 1));
    const paidCandidateTargets = targets.filter((target) => target?.tier === 'paid_cloud');
    const callsPerCandidate = selectedPromptCount * repeats;
    let maxCalls = paidCandidateTargets.length * callsPerCandidate;
    const judgeAttempts = Math.max(1, Math.min(6, Number(advSettings.max_retries ?? 2) + 1));
    if (cloudJudgeTarget?.tier === 'paid_cloud') maxCalls += targets.length * callsPerCandidate * judgeAttempts;
    const paidUnits = [
        ...paidCandidateTargets.map((target) => ({ target, calls: callsPerCandidate })),
        ...(cloudJudgeTarget?.tier === 'paid_cloud' ? [{ target: cloudJudgeTarget, calls: targets.length * callsPerCandidate * judgeAttempts }] : [])
    ];
    const inputTokensPerCall = 32_000;
    const outputTokensPerCall = Math.max(1, Number(advSettings.response_max_tokens) || 32_000);
    const maxCostNanodollars = paidUnits.reduce((sum, { target, calls }) => {
        const price = target.pricing || {};
        return sum + calls * Number(price.callNanodollars || 0)
            + calls * Math.ceil(inputTokensPerCall * Number(price.inputNanodollarsPerMillion || 0) / 1_000_000)
            + calls * Math.ceil(outputTokensPerCall * Number(price.outputNanodollarsPerMillion || 0) / 1_000_000);
    }, 0);
    let paidApproval = null;
    if (maxCalls > 0) {
        const estimatedUsd = (maxCostNanodollars / 1e9).toFixed(6);
        if (!window.confirm(`Paid cloud execution\n\nWorst-case manual estimate: US$${estimatedUsd}\nCalls: ${maxCalls}\nTokens: ${maxCalls * (inputTokensPerCall + outputTokensPerCall)}\n\nApprove this one batch?`)) {
            _publishLaunchStatus(container, 'blocked', 'Paid execution not approved', 'No provider call was made.');
            return;
        }
        paidApproval = {
            confirmed: true,
            maxCalls,
            maxTokens: maxCalls * (inputTokensPerCall + outputTokensPerCall),
            maxCostNanodollars
        };
    }
    const batchConfig = {
        host: execHostUrl || 'harness',
        models,
        targets,
        levels,
        depth_config: depthConfig,
        judge_config: {
            model: judge.model,
            host: judge.host,
            ...(cloudJudgeTarget ? { target: cloudJudgeTarget } : {}),
            temperature: advSettings.temperature,
            num_predict: advSettings.num_predict,
            num_ctx: advSettings.num_ctx,
            max_retries: advSettings.max_retries,
            timeout: advSettings.timeout,
            voting_count: advSettings.voting_count,
            think: advSettings.think
        },
        multi_judge:  _readMultiJudgeFromUI(container),
        execution_config: {
            think,
            response_max_tokens: advSettings.response_max_tokens,
            per_test_timeout_ms: advSettings.per_test_timeout_ms,
            warmup_timeout_cold: advSettings.warmup_timeout_cold,
            warmup_timeout_loaded: advSettings.warmup_timeout_loaded,
            judge_drain_timeout_ms: advSettings.judge_drain_timeout_ms,
            judge_stall_timeout_ms: advSettings.judge_stall_timeout_ms,
            answer_contract_mode: advSettings.answer_contract_mode,
            include_length_hint: !!advSettings.include_length_hint,
            length_hint_template: advSettings.length_hint_template,
            custom_hint: advSettings.custom_hint,
            // Fairness — undefined means "use server default", null means "explicitly off"
            force_num_ctx: (advSettings.force_num_ctx === '' || advSettings.force_num_ctx === undefined)
                ? null : Number(advSettings.force_num_ctx) || null,
            temperature: advSettings.exec_temperature,
            top_p: advSettings.exec_top_p,
            top_k: advSettings.exec_top_k,
            repeat_penalty: advSettings.exec_repeat_penalty,
            seed: (advSettings.exec_seed === '' || advSettings.exec_seed === undefined || advSettings.exec_seed === null)
                ? null : Number(advSettings.exec_seed),
            repeats
        },
        paid_approval: paidApproval,
    };

    if (btn) { btn.textContent = 'Launching\u2026'; }
    _publishLaunchStatus(
        container,
        'launching',
        'Launching benchmark',
        `${targets.length} target${targets.length === 1 ? '' : 's'} across ${levels.length} active level${levels.length === 1 ? '' : 's'}.`
    );

    if (typeof onLaunch === 'function') {
        await onLaunch(batchConfig);
    }
}

export { _wireSubmit };
