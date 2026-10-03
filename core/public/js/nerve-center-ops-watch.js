/**
 * Nerve Center — operations watch.
 *
 * Shows the latest report (what the rules flag, explained by the `ops_watch`
 * model), runs a check on demand, and edits the watch settings in place:
 * on/off, interval and report language.
 */
(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    const API = '/api/nerve-center/ops-watch';
    const POLL_MS = 5000;
    let pollTimer = null;

    function when(iso) {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    }

    function reportHtml(report) {
        if (!report) return '<p class="nc-muted">No check since Core started.</p>';
        const checked = `Checked ${shared.escapeHtml(when(report.at))}`;
        if (!report.findingCount) return `<p><strong>Nothing needs attention.</strong> <span class="nc-muted">${checked}</span></p>`;
        const source = report.source === 'model'
            ? `Written by ${shared.escapeHtml(report.model || 'the ops_watch model')}`
            : `Rule list, model unavailable${report.modelUnavailable ? ` (${shared.escapeHtml(report.modelUnavailable)})` : ''}`;
        return `<p><strong>${report.findingCount} finding(s)</strong> <span class="nc-muted">· ${checked} · ${source}</span></p>
            <div style="white-space:pre-wrap;border-left:3px solid var(--warning, #d29922);padding:6px 10px;margin:6px 0;">${shared.escapeHtml(report.summary || '')}</div>`;
    }

    function settingsHtml(settings, scheduled) {
        const origin = settings.source === 'saved' ? 'Saved here' : 'From the configuration file until saved here';
        const state = !settings.enabled ? 'Off' : scheduled ? 'Running' : 'On, not scheduled in this process';
        return `<form class="nc-ops-watch-settings" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:12px;font-size:11px;">
            <label><input type="checkbox" name="enabled"${settings.enabled ? ' checked' : ''}> Check automatically</label>
            <label>Every <input class="nc-inline-select" type="number" name="intervalMinutes" required min="${settings.minMinutes}" max="${settings.maxMinutes}"
                step="1" value="${settings.intervalMinutes}" style="width:70px;"> minutes</label>
            <label>Report language <input class="nc-inline-select" name="language" required maxlength="30" size="12" value="${shared.escapeHtml(settings.language)}"></label>
            <button class="nc-btn" type="submit"><i class="fas fa-save" aria-hidden="true"></i> Save</button>
            <span class="nc-ops-watch-status nc-muted" role="status" aria-live="polite">${state} · ${origin}</span>
        </form>`;
    }

    function render(body, data) {
        body.innerHTML = `<p class="nc-muted">Monitoring rules find what needs attention; the <code>ops_watch</code> task's model writes one short report with a next action. It runs only when the findings change.</p>
            ${reportHtml(data.report)}
            <button class="nc-btn nc-ops-watch-check" type="button"${data.checking ? ' disabled' : ''}>
                <i class="fas ${data.checking ? 'fa-spinner fa-spin' : 'fa-sync'}" aria-hidden="true"></i> ${data.checking ? 'Checking…' : 'Check now'}</button>
            ${settingsHtml(data.settings, data.scheduled)}`;
        body.querySelector('.nc-ops-watch-check').addEventListener('click', event => checkNow(event.currentTarget));
        body.querySelector('.nc-ops-watch-settings').addEventListener('submit', event => {
            event.preventDefault();
            save(event.currentTarget);
        });
        clearTimeout(pollTimer);
        if (data.checking) pollTimer = setTimeout(loadOpsWatch, POLL_MS);
    }

    async function checkNow(button) {
        button.disabled = true;
        try {
            await shared.fetchJson(`${API}/check`, { method: 'POST' });
            await loadOpsWatch();
        } catch (err) {
            button.disabled = false;
            button.title = err.message;
            button.style.outline = '1px solid var(--danger)';
        }
    }

    async function save(form) {
        const status = form.querySelector('.nc-ops-watch-status');
        const body = {
            enabled: form.elements.enabled.checked,
            intervalMinutes: Number(form.elements.intervalMinutes.value),
            language: form.elements.language.value.trim()
        };
        status.textContent = 'Saving…';
        try {
            await shared.fetchJson(`${API}/settings`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            await loadOpsWatch();
        } catch (err) {
            status.textContent = err.message;
        }
    }

    async function loadOpsWatch() {
        const body = document.getElementById('sectionOpsWatchBody');
        if (!body) return;
        try {
            const json = await shared.fetchJson(API);
            render(body, json.data);
        } catch (err) {
            shared.renderSectionError(body, `Failed to load the operations watch: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterOpsWatch = { loadOpsWatch };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadOpsWatch);
    else loadOpsWatch();
})();
