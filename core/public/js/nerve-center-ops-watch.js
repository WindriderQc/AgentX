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
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    function chip(tone, icon, label, title) {
        return `<span class="nc-host-chip${tone ? ` ${tone}` : ''}"${title ? ` title="${shared.escapeHtml(title)}"` : ''}>
            <i class="fas ${icon}" aria-hidden="true"></i> ${shared.escapeHtml(label)}</span>`;
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    // Critical findings are counted from the list; the rest of the count is attention.
    function severityCounts(report) {
        const critical = (Array.isArray(report.findings) ? report.findings : [])
            .filter(finding => finding?.severity === 'critical').length;
        return { critical, attention: Math.max(0, report.findingCount - critical) };
    }

    function reportView(report) {
        if (!report) {
            return { tone: 'idle', icon: 'fa-circle-question', headline: 'No check since Core started',
                meta: 'Run one now, or wait for the next automatic check.', summary: 'Not checked yet' };
        }
        const checked = `Checked ${shared.escapeHtml(when(report.at))}`;
        if (!report.findingCount) {
            return { tone: 'clear', icon: 'fa-circle-check', headline: 'Nothing needs attention', meta: checked,
                summary: 'Nothing needs attention' };
        }
        const counts = severityCounts(report);
        const source = report.source === 'model'
            ? `Written by ${shared.escapeHtml(report.model || 'the ops_watch model')}`
            : `Rule list, model unavailable${report.modelUnavailable ? ` (${shared.escapeHtml(report.modelUnavailable)})` : ''}`;
        const count = plural(report.findingCount, 'finding');
        return {
            tone: counts.critical ? 'critical' : 'findings',
            icon: 'fa-triangle-exclamation',
            headline: `${count} need${report.findingCount === 1 ? 's' : ''} attention`,
            chips: (counts.critical ? chip('danger', 'fa-circle-exclamation', `${counts.critical} critical`) : '')
                + (counts.attention ? chip('warn', 'fa-eye', `${counts.attention} attention`) : ''),
            meta: `${checked} · ${source}`,
            body: `<div class="nc-watch-report">${shared.escapeHtml(report.summary || '')}</div>`,
            summary: count
        };
    }

    function scheduleChip(settings, scheduled) {
        if (!settings.enabled) return chip('', 'fa-circle-pause', 'Automatic checks off');
        if (!scheduled) {
            return chip('warn', 'fa-triangle-exclamation', 'On, not scheduled in this process',
                'The settings are stored; the process that runs the watch applies them');
        }
        return chip('ok', 'fa-clock', `Every ${settings.intervalMinutes} min`, 'Automatic checks are running');
    }

    function settingsHtml(settings) {
        const origin = settings.source === 'saved' ? 'Saved here' : 'From the configuration file until saved here';
        return `<form class="nc-ops-watch-settings nc-form-bar" aria-label="Operations watch settings">
            <label class="nc-switch"><input type="checkbox" name="enabled"${settings.enabled ? ' checked' : ''}>
                <span class="nc-switch-track" aria-hidden="true"></span>Check automatically</label>
            <label class="nc-field"><span class="nc-field-label">Every</span>
                <span class="nc-field-row"><input class="nc-input nc-input-number" type="number" name="intervalMinutes" required
                    min="${settings.minMinutes}" max="${settings.maxMinutes}" step="1" value="${settings.intervalMinutes}"> minutes</span></label>
            <label class="nc-field"><span class="nc-field-label">Report language</span>
                <input class="nc-input" name="language" required maxlength="30" size="14" value="${shared.escapeHtml(settings.language)}"></label>
            <button class="nc-btn" type="submit"><i class="fas fa-save" aria-hidden="true"></i> Save</button>
            <span class="nc-ops-watch-status nc-form-bar-status" role="status" aria-live="polite">${origin}</span>
        </form>`;
    }

    function setHeaderSummary(view) {
        const summary = document.getElementById('nc-ops-watch-summary');
        if (!summary) return;
        summary.textContent = view.summary;
        summary.className = `nc-section-summary${view.tone === 'critical' ? ' critical' : view.tone === 'findings' ? ' attention' : ''}`;
    }

    // The report part alone is redrawn while a check runs, so polling never
    // erases what is being typed in the settings form.
    function renderReport(holder, data) {
        const view = reportView(data.report);
        holder.innerHTML = `<div class="nc-watch is-${view.tone}">
            <div class="nc-watch-head">
                <span class="nc-watch-icon"><i class="fas ${view.icon}" aria-hidden="true"></i></span>
                <div class="nc-watch-text">
                    <div class="nc-watch-headline"><span>${view.headline}</span>${view.chips || ''}</div>
                    <div class="nc-watch-meta">${view.meta}</div>
                </div>
                <div class="nc-watch-actions">
                    ${scheduleChip(data.settings, data.scheduled)}
                    <button class="nc-btn nc-ops-watch-check" type="button"${data.checking ? ' disabled' : ''}>
                        <i class="fas ${data.checking ? 'fa-spinner fa-spin' : 'fa-sync'}" aria-hidden="true"></i> ${data.checking ? 'Checking…' : 'Check now'}</button>
                </div>
            </div>
            ${view.body || ''}
        </div>
        <p class="nc-notice is-error nc-ops-watch-error" role="alert" hidden></p>`;
        holder.querySelector('.nc-ops-watch-check').addEventListener('click', event => checkNow(event.currentTarget, holder));
        setHeaderSummary(view);
        clearTimeout(pollTimer);
        if (data.checking) pollTimer = setTimeout(() => loadOpsWatch({ reportOnly: true }), POLL_MS);
    }

    function render(body, data, reportOnly) {
        const holder = reportOnly && body.querySelector('.nc-ops-watch-report');
        if (holder) return renderReport(holder, data);
        body.innerHTML = `<p class="nc-section-note">Monitoring rules find what needs attention; the <code>ops_watch</code> task's model writes one short report with a next action. It runs only when the findings change.</p>
            <div class="nc-ops-watch-report"></div>
            ${settingsHtml(data.settings)}`;
        body.querySelector('.nc-ops-watch-settings').addEventListener('submit', event => {
            event.preventDefault();
            save(event.currentTarget);
        });
        return renderReport(body.querySelector('.nc-ops-watch-report'), data);
    }

    async function checkNow(button, holder) {
        button.disabled = true;
        try {
            await shared.fetchJson(`${API}/check`, { method: 'POST' });
            await loadOpsWatch({ reportOnly: true });
        } catch (err) {
            button.disabled = false;
            const error = holder.querySelector('.nc-ops-watch-error');
            error.textContent = `The check did not start: ${err.message}`;
            error.hidden = false;
        }
    }

    async function save(form) {
        const status = form.querySelector('.nc-ops-watch-status');
        const body = {
            enabled: form.elements.enabled.checked,
            intervalMinutes: Number(form.elements.intervalMinutes.value),
            language: form.elements.language.value.trim()
        };
        status.classList.remove('is-error');
        status.textContent = 'Saving…';
        try {
            await shared.fetchJson(`${API}/settings`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            await loadOpsWatch();
        } catch (err) {
            status.classList.add('is-error');
            status.textContent = err.message;
        }
    }

    async function loadOpsWatch({ reportOnly = false } = {}) {
        const body = document.getElementById('sectionOpsWatchBody');
        if (!body) return;
        try {
            const json = await shared.fetchJson(API);
            render(body, json.data, reportOnly);
        } catch (err) {
            shared.renderSectionError(body, `Failed to load the operations watch: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterOpsWatch = { loadOpsWatch };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => loadOpsWatch());
    else loadOpsWatch();
})();
