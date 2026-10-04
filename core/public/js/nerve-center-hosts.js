/**
 * Nerve Center — inference host registry.
 *
 * Lists every Ollama endpoint, registers a new LAN endpoint (GPU or CPU),
 * edits residency and concurrent requests, removes a registered one.
 * The configuration file hosts stay listed and can be annotated, not removed.
 */
(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    const API = '/api/nerve-center/inference-hosts';
    const SOURCES = {
        registry: { icon: 'fa-pen-to-square', label: 'Registered here' },
        env: { icon: 'fa-file-lines', label: 'Configuration file' }
    };
    const BENCHMARK_SOURCE = { icon: 'fa-gauge-high', label: 'Benchmark config' };
    // The outcome of the last change. Every change redraws the section, so the
    // message is kept here and drawn with it.
    let notice = null;

    function residencyOptions(selected) {
        return ['gpu', 'cpu'].map(value =>
            `<option value="${value}"${value === selected ? ' selected' : ''}>${value.toUpperCase()}</option>`).join('');
    }

    function inflightOptions(selected) {
        const values = [...new Set([0, 1, 2, 4, 8, selected || 0])].sort((a, b) => a - b);
        return values.map(value =>
            `<option value="${value}"${value === (selected || 0) ? ' selected' : ''}>${value || 'Default'}</option>`).join('');
    }

    function hostRow(host) {
        const id = shared.escapeHtml(host.id);
        const source = SOURCES[host.source] || BENCHMARK_SOURCE;
        const action = host.removable
            ? `<button class="nc-btn nc-btn-icon nc-btn-danger nc-host-remove" type="button" data-host-id="${id}" title="Remove host" aria-label="Remove ${id}"><i class="fas fa-trash" aria-hidden="true"></i></button>`
            : '<span class="nc-hosts-locked" title="Declared in the configuration file: it is removed there"><i class="fas fa-lock" aria-hidden="true"></i></span>';
        return `<tr data-host-id="${id}">
            <td><div class="nc-hosts-name"><strong>${shared.escapeHtml(host.name || host.id)}</strong><span class="nc-host-key-badge">${id}</span></div>
                <div class="nc-hosts-source"><i class="fas ${source.icon}" aria-hidden="true"></i> ${source.label}</div></td>
            <td><code class="nc-hosts-url">${shared.escapeHtml(host.url)}</code></td>
            <td data-label="Residency"><select class="nc-inline-select nc-host-residency" data-host-id="${id}" aria-label="Residency of ${id}">${residencyOptions(host.residency || 'gpu')}</select></td>
            <td data-label="Concurrent requests"><select class="nc-inline-select nc-host-inflight" data-host-id="${id}" aria-label="Concurrent requests on ${id}"
                title="Requests Core sends at once per model; a CPU instance usually serves one">${inflightOptions(host.maxInflight)}</select></td>
            <td class="nc-hosts-actions">${action}</td>
        </tr>`;
    }

    function addForm() {
        return `<form class="nc-host-add nc-form-bar" aria-label="Add an inference host">
            <span class="nc-form-bar-title">Add a host <small>Private network addresses only. An address is not edited afterwards: remove the host and add it again.</small></span>
            <label class="nc-field"><span class="nc-field-label">Id</span>
                <input class="nc-input" name="id" required pattern="[a-z0-9][a-z0-9-]{0,31}" placeholder="frank-cpu" size="14"
                    title="Lowercase letters, digits and dashes, 32 characters at most"></label>
            <label class="nc-field"><span class="nc-field-label">Name</span>
                <input class="nc-input" name="name" maxlength="64" placeholder="Local CPU" size="16"></label>
            <label class="nc-field"><span class="nc-field-label">Address</span>
                <input class="nc-input" name="url" required placeholder="http://192.168.1.20:11435" size="26"></label>
            <label class="nc-field"><span class="nc-field-label">Residency</span>
                <select class="nc-input" name="residency">${residencyOptions('gpu')}</select></label>
            <button class="nc-btn" type="submit"><i class="fas fa-plus" aria-hidden="true"></i> Add host</button>
            <span class="nc-host-add-status nc-form-bar-status" role="status" aria-live="polite"></span>
        </form>`;
    }

    function noticeHtml() {
        if (!notice) return '';
        const icon = notice.tone === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation';
        return `<p class="nc-notice is-${notice.tone} nc-hosts-notice" role="${notice.tone === 'ok' ? 'status' : 'alert'}">
            <i class="fas ${icon}" aria-hidden="true"></i> <span>${shared.escapeHtml(notice.text)}</span></p>`;
    }

    function setHeaderSummary(hosts) {
        const summary = document.getElementById('nc-hosts-summary');
        if (!summary) return;
        const cpu = hosts.filter(host => host.residency === 'cpu').length;
        summary.textContent = hosts.length
            ? `${hosts.length} host${hosts.length === 1 ? '' : 's'} · ${hosts.length - cpu} GPU · ${cpu} CPU`
            : 'No host yet';
    }

    // A refused change redraws the list too: the control returns to the saved value.
    async function patch(hostId, body, control) {
        control.disabled = true;
        try {
            await shared.fetchJson(`${API}/${encodeURIComponent(hostId)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            notice = null;
        } catch (err) {
            notice = { tone: 'error', text: `${hostId} was not changed: ${err.message}` };
            return loadHosts();
        }
        return refreshAll();
    }

    async function remove(hostId, button) {
        const headers = await window.AgentXTypedConfirmation.confirm({
            action: 'REMOVE HOST', resource: hostId, title: 'Remove inference host',
            description: `Remove ${hostId}? Core stops routing to it. Its resident models must be cleared first.`
        });
        if (!headers) return undefined;
        button.disabled = true;
        try {
            await shared.fetchJson(`${API}/${encodeURIComponent(hostId)}`, { method: 'DELETE', headers });
            notice = { tone: 'ok', text: `${hostId} was removed.` };
        } catch (err) {
            notice = { tone: 'error', text: `${hostId} was not removed: ${err.message}` };
            return loadHosts();
        }
        return refreshAll();
    }

    // A refused host keeps the form as typed; an added one redraws the section.
    async function submit(form) {
        const status = form.querySelector('.nc-host-add-status');
        const button = form.querySelector('button[type="submit"]');
        const body = Object.fromEntries(new FormData(form).entries());
        status.classList.remove('is-error');
        status.textContent = 'Checking the address…';
        button.disabled = true;
        try {
            const json = await shared.fetchJson(API, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            const reach = json.data?.reachability;
            notice = reach?.reachable
                ? { tone: 'ok', text: `${body.id} was added. Ollama${reach.version ? ` ${reach.version}` : ''} answered.` }
                : { tone: 'warn', text: `${body.id} was added, but Ollama did not answer (${reach?.error || 'unknown'}).` };
        } catch (err) {
            status.classList.add('is-error');
            status.textContent = err.message;
            button.disabled = false;
            return undefined;
        }
        return refreshAll();
    }

    function attach(body) {
        body.querySelectorAll('.nc-host-residency').forEach(select => select.addEventListener('change',
            () => patch(select.dataset.hostId, { residency: select.value }, select)));
        body.querySelectorAll('.nc-host-inflight').forEach(select => select.addEventListener('change',
            () => patch(select.dataset.hostId, { maxInflight: Number(select.value) || null }, select)));
        body.querySelectorAll('.nc-host-remove').forEach(button => button.addEventListener('click',
            () => remove(button.dataset.hostId, button)));
        body.querySelector('.nc-host-add')?.addEventListener('submit', event => {
            event.preventDefault();
            submit(event.currentTarget);
        });
    }

    async function loadHosts() {
        const body = document.getElementById('sectionHostsBody');
        if (!body) return;
        try {
            const json = await shared.fetchJson(API);
            const hosts = json.data?.hosts || [];
            body.innerHTML = `<p class="nc-section-note">Each Ollama endpoint is a host. A machine can run a GPU instance and a CPU instance side by side; declare the CPU one so its pins are expected outside VRAM.</p>
                <div class="nc-hosts"><table class="nc-table nc-hosts-table">
                    <thead><tr><th scope="col">Host</th><th scope="col">Address</th><th scope="col">Residency</th><th scope="col">Concurrent requests</th><th scope="col" aria-label="Actions"></th></tr></thead>
                    <tbody>${hosts.map(hostRow).join('') || '<tr><td colspan="5" class="nc-hosts-empty">No host yet: add the first one below.</td></tr>'}</tbody>
                </table></div>
                ${noticeHtml()}
                ${addForm()}`;
            setHeaderSummary(hosts);
            attach(body);
        } catch (err) {
            shared.renderSectionError(body, `Failed to load hosts: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    async function refreshAll() {
        await loadHosts();
        window.NerveCenterCluster?.loadCluster?.();
    }

    window.NerveCenterHosts = { loadHosts };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadHosts);
    else loadHosts();
})();
