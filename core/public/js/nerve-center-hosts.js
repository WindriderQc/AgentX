/**
 * Nerve Center — inference host registry.
 *
 * Lists every Ollama endpoint, registers a new LAN endpoint (GPU or CPU),
 * edits residency, name and concurrent requests, removes a registered one.
 * The configuration file hosts stay listed and can be annotated, not removed.
 */
(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    const API = '/api/nerve-center/inference-hosts';

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
        const source = host.source === 'registry' ? 'Registered' : host.source === 'env' ? 'Configuration file' : 'Benchmark config';
        return `<tr data-host-id="${id}">
            <td><strong>${shared.escapeHtml(host.name || host.id)}</strong><div class="nc-muted">${id} · ${source}</div></td>
            <td><code>${shared.escapeHtml(host.url)}</code></td>
            <td><select class="nc-inline-select nc-host-residency" data-host-id="${id}" aria-label="Residency of ${id}">${residencyOptions(host.residency || 'gpu')}</select></td>
            <td><select class="nc-inline-select nc-host-inflight" data-host-id="${id}" aria-label="Concurrent requests on ${id}"
                title="Requests Core sends at once per model; a CPU instance usually serves one">${inflightOptions(host.maxInflight)}</select></td>
            <td>${host.removable ? `<button class="nc-btn nc-btn-icon nc-host-remove" data-host-id="${id}" title="Remove host" aria-label="Remove ${id}"><i class="fas fa-trash"></i></button>` : ''}</td>
        </tr>`;
    }

    function addForm() {
        return `<form class="nc-host-add" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:12px;font-size:11px;">
            <label>Id <input class="nc-inline-select" name="id" required pattern="[a-z0-9][a-z0-9-]{0,31}" placeholder="frank-cpu" size="12"></label>
            <label>Name <input class="nc-inline-select" name="name" placeholder="Local CPU" size="14"></label>
            <label>Address <input class="nc-inline-select" name="url" required placeholder="http://192.168.1.20:11435" size="24"></label>
            <label>Residency <select class="nc-inline-select" name="residency">${residencyOptions('gpu')}</select></label>
            <button class="nc-btn" type="submit"><i class="fas fa-plus" aria-hidden="true"></i> Add host</button>
            <span class="nc-host-add-status nc-muted" role="status" aria-live="polite"></span>
        </form>`;
    }

    async function patch(hostId, body, control) {
        control.disabled = true;
        try {
            await shared.fetchJson(`${API}/${encodeURIComponent(hostId)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            await refreshAll();
        } catch (err) {
            control.title = err.message;
            control.style.outline = '1px solid var(--danger)';
        } finally {
            control.disabled = false;
        }
    }

    async function remove(hostId, button) {
        const headers = await window.AgentXTypedConfirmation.confirm({
            action: 'REMOVE HOST', resource: hostId, title: 'Remove inference host',
            description: `Remove ${hostId}? Core stops routing to it. Its resident models must be cleared first.`
        });
        if (!headers) return;
        button.disabled = true;
        try {
            await shared.fetchJson(`${API}/${encodeURIComponent(hostId)}`, { method: 'DELETE', headers });
            await refreshAll();
        } catch (err) {
            button.title = err.message;
            button.style.outline = '1px solid var(--danger)';
            button.disabled = false;
        }
    }

    async function submit(form) {
        const status = form.querySelector('.nc-host-add-status');
        const body = Object.fromEntries(new FormData(form).entries());
        status.textContent = 'Checking the address…';
        try {
            const json = await shared.fetchJson(API, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            const reach = json.data?.reachability;
            status.textContent = reach?.reachable
                ? `Added. Ollama ${reach.version || ''} answered.`
                : `Added, but Ollama did not answer (${reach?.error || 'unknown'}).`;
            form.reset();
            await refreshAll();
        } catch (err) {
            status.textContent = err.message;
        }
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
            body.innerHTML = `<p class="nc-muted">Each Ollama endpoint is a host. A machine can run a GPU instance and a CPU instance side by side; declare the CPU one so its pins are expected outside VRAM.</p>
                <table class="nc-table"><thead><tr><th>Host</th><th>Address</th><th>Residency</th><th>Concurrent requests</th><th></th></tr></thead>
                <tbody>${hosts.map(hostRow).join('') || '<tr><td colspan="5" class="nc-muted">No host yet: add the first one below.</td></tr>'}</tbody></table>
                ${addForm()}`;
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
