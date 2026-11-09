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
    let drainRefresh = null;
    const requests = new Map();
    let listedHosts = [];
    let hostReadVersion = 0;
    let changingControl = false;

    async function readHosts() {
        const version = ++hostReadVersion;
        try {
            const json = await shared.fetchJson(API);
            if (version !== hostReadVersion) return null;
            listedHosts = json.data?.hosts || [];
            return listedHosts;
        } catch (error) {
            if (version !== hostReadVersion) return null;
            listedHosts = [];
            throw error;
        }
    }

    function scheduleDrainRefresh() {
        window.clearTimeout(drainRefresh);
        if (listedHosts.some(host => host.control?.state === 'draining')) drainRefresh = window.setTimeout(loadHosts, 3000);
    }

    function controlCell(host, tag = 'td') {
        const state = host.control?.state;
        if (!state) return `<${tag}>Unavailable</${tag}>`;
        const active = state !== 'playing';
        const label = state === 'paused' ? 'Paused — manual use' : state === 'draining' ? 'Draining — wait before manual use' : 'AgentX in control';
        const action = active ? 'play' : 'pause';
        return `<${tag} class="nc-host-control-cell" data-label="AgentX control"><span role="status">${shared.escapeHtml(label)}</span>
            <button type="button" class="nc-btn nc-host-control" data-host-id="${shared.escapeHtml(host.id)}"
                data-action="${action}" data-revision="${host.control.revision}" aria-label="${active ? 'Play' : 'Pause'} AgentX on ${shared.escapeHtml(host.name || host.id)}"
                title="${active ? 'Stop direct tests before returning control. AgentX restores its saved pins.' : 'Pause every lane of this machine until Play. Active work finishes first.'}">
                <i class="fas fa-${active ? 'play' : 'pause'}" aria-hidden="true"></i> ${active ? 'Play' : 'Pause'}</button>
            ${state === 'draining' ? `<small>${host.control.blockers.length} active owner(s). Release sessions or reconcile uncertain work through their owner.</small>` : ''}</${tag}>`;
    }

    async function refreshLiveControls({ reload = false } = {}) {
        if (reload) {
            if (changingControl) return;
            try { if (!(await readHosts())) return; scheduleDrainRefresh(); }
            catch { listedHosts = []; }
        }
        document.querySelectorAll?.('.nc-live-host-control').forEach(slot => {
            const host = listedHosts.find(row => row.id === slot.dataset.hostId);
            if (!host) { slot.textContent = 'AgentX control unavailable'; return; }
            slot.innerHTML = controlCell(host, 'div')
                + (notice?.tone === 'error' ? `<small role="alert">${shared.escapeHtml(notice.text)}</small>` : '');
            slot.querySelector('.nc-host-control')?.addEventListener('click', event => changeControl(event.currentTarget));
        });
    }

    async function changeControl(button) {
        if (changingControl) return;
        const { hostId, action, revision } = button.dataset;
        const key = `${hostId}:${action}:${revision}`;
        if (!requests.has(key)) requests.set(key, { action, expectedRevision: Number(revision), requestId: window.crypto.randomUUID() });
        button.disabled = true;
        changingControl = true;
        hostReadVersion++;
        try {
            const json = await shared.fetchJson(`${API}/${encodeURIComponent(hostId)}/control`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requests.get(key))
            });
            requests.delete(key);
            notice = { tone: 'ok', text: json.data.control.state === 'draining'
                ? 'Pause requested. Wait for Paused — manual use before starting your test.'
                : action === 'pause' ? 'Paused until Play. You can use the machine directly.' : 'AgentX has control again. Saved pins resume through the reconciler.' };
        } catch (err) {
            notice = { tone: 'error', text: `Control outcome needs checking: ${err.message}. The list below reads the saved state.` };
        } finally {
            changingControl = false;
        }
        return refreshAll();
    }

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
            ${controlCell(host)}
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
        body.querySelectorAll('.nc-host-control').forEach(button => button.addEventListener('click', () => changeControl(button)));
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
        if (changingControl) return;
        window.clearTimeout(drainRefresh);
        const body = document.getElementById('sectionHostsBody');
        if (!body) return;
        shared.trackSectionFocus?.(body);
        try {
            const hosts = await readHosts();
            if (!hosts) return;
            body.innerHTML = `<p class="nc-section-note">Pause gives you every CPU/GPU lane of the machine for direct use. Wait for “Paused — manual use”. AgentX resumes only when you press Play; stop your direct test first. Resident models stay loaded until you change them.</p>
                <div class="nc-hosts"><table class="nc-table nc-hosts-table">
                    <thead><tr><th scope="col">Host</th><th scope="col">Address</th><th scope="col">Residency</th><th scope="col">Concurrent requests</th><th scope="col">AgentX control</th><th scope="col" aria-label="Actions"></th></tr></thead>
                    <tbody>${hosts.map(hostRow).join('') || '<tr><td colspan="6" class="nc-hosts-empty">No host yet: add the first one below.</td></tr>'}</tbody>
                </table></div>
                ${noticeHtml()}
                ${addForm()}`;
            setHeaderSummary(hosts);
            attach(body);
            refreshLiveControls();
            shared.restoreSectionFocus?.(body);
            scheduleDrainRefresh();
        } catch (err) {
            listedHosts = [];
            refreshLiveControls();
            shared.renderSectionError(body, `Failed to load hosts: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    async function refreshAll() {
        await loadHosts();
        window.NerveCenterCluster?.loadCluster?.();
    }

    window.NerveCenterHosts = { loadHosts, refreshLiveControls };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadHosts);
    else loadHosts();
})();
