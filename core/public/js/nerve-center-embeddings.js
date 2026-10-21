/**
 * Nerve Center → Embeddings: the model, dimension and collection RAG serves,
 * the queued rebuild for another model and its progress. A change never
 * embeds anything at once: it queues a heavy-work request whose slot starts
 * the rebuild; search keeps the current collection until the new one is
 * complete. Cancel works until the switch.
 */
(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    if (!shared) return;

    const API = '/api/nerve-center/embeddings';
    const OPEN = ['requested', 'reserved', 'dispatching', 'running', 'uncertain'];
    const POLL_MS = 15000;
    const esc = value => shared.escapeHtml(String(value ?? ''));
    let timer = null;
    let requestKey = null;
    let current = null;

    async function call(url, options = {}) {
        const response = await fetch(url, { cache: 'no-store', ...options });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.message || `Request failed (${response.status})`), { code: body.code, details: body.details });
        return body.data;
    }

    function newKey() {
        return window.crypto?.randomUUID ? window.crypto.randomUUID()
            : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (Math.random() * 16 >> c / 4)).toString(16));
    }

    // Tonight 02:00 on this device, as a datetime-local value.
    function defaultSlot() {
        const slot = new Date();
        slot.setDate(slot.getDate() + (slot.getHours() >= 2 ? 1 : 0));
        slot.setHours(2, 0, 0, 0);
        return new Date(slot.getTime() - slot.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    function when(iso) {
        return iso ? new Date(iso).toLocaleString() : '—';
    }

    function profileHtml(profile, open) {
        const active = profile?.active || {};
        return `
            <div class="nc-embed-grid">
                <div class="nc-host-card"><div class="nc-muted nc-embed-label">Model</div><div class="nc-embed-value" data-embed-model>${esc(active.model)}</div></div>
                <div class="nc-host-card"><div class="nc-muted nc-embed-label">Dimension</div><div class="nc-embed-value">${esc(active.dimension)}</div></div>
                <div class="nc-host-card"><div class="nc-muted nc-embed-label">Collection</div><div class="nc-embed-value nc-embed-wrap">${esc(active.collection)}</div></div>
            </div>
            ${profile?.previous ? `<div class="nc-embed-previous"><p class="nc-muted nc-embed-note">Previous collection kept: ${esc(profile.previous.collection)} (${esc(profile.previous.model)}), switched ${esc(when(profile.activatedAt))}.</p>
                ${open ? '' : '<button type="button" class="nc-btn" data-embed-retire>Delete previous collection</button>'}</div>` : ''}`;
    }

    function progressHtml(build) {
        const progress = build?.progress || {};
        if (!build || !['copying', 'finalizing'].includes(build.status)) return '';
        const total = Number(progress.total) || 0;
        const done = Number(progress.documents) || 0;
        const label = build.status === 'finalizing' ? 'Switching collections' : `Copying ${done}${total ? ` of ${total}` : ''} documents`;
        return `<div class="nc-embed-progress"><label for="ncEmbedProgress">${esc(label)}</label>
            <progress id="ncEmbedProgress" data-embed-progress max="${total || 1}" value="${total ? done : 0}">${esc(label)}</progress></div>`;
    }

    function requestHtml(request, build) {
        if (!request) return '';
        const open = OPEN.includes(request.state);
        const failed = request.state === 'failed' ? (request.releaseReceipt?.error || build?.error || request.reason || 'The rebuild failed') : null;
        const stateText = {
            requested: 'Queued, without a slot', reserved: request.reservation?.autoStart ? 'Queued: starts automatically at its slot' : 'Queued: waits for Run now',
            dispatching: 'Starting', running: 'Rebuilding', uncertain: 'Needs reconciliation', completed: 'Switched', failed: 'Failed: the previous collection keeps serving',
            cancelled: 'Cancelled: the previous collection keeps serving'
        }[request.state] || request.state;
        const cancellable = ['requested', 'reserved'].includes(request.state) || (request.state === 'running' && build?.status === 'copying');
        return `
            <div class="nc-embed-request" data-embed-request="${esc(request.state)}" role="status" aria-live="polite">
                <div><strong>${esc(request.executor?.model)}</strong> · ${esc(request.executor?.dimension)} dimensions</div>
                <div data-embed-state>${esc(stateText)}</div>
                ${request.reservation ? `<div class="nc-muted">Slot ${esc(when(request.reservation.start))} → ${esc(when(request.reservation.end))} (estimated)</div>` : ''}
                ${failed ? `<div class="nc-embed-error" data-embed-error>${esc(failed)}</div>` : ''}
                ${open ? progressHtml(build) : ''}
                ${cancellable ? `<button type="button" class="nc-btn" data-embed-cancel>${request.state === 'running' ? 'Stop rebuild' : 'Cancel'}</button>` : ''}
            </div>`;
    }

    function formHtml(profile) {
        return `
            <form class="nc-embed-form" data-embed-form novalidate>
                <h3>Change the embedding model</h3>
                <p class="nc-muted">Every document is re-embedded into a new collection during the slot. Search keeps ${esc(profile?.active?.collection)} until the new one is complete; a failure or a cancellation keeps it.</p>
                <div class="nc-embed-fields">
                    <label>Model <input name="model" required autocomplete="off" placeholder="qllama/bge-m3:f16"></label>
                    <label>Dimension <input name="dimension" type="number" min="1" max="8192" required placeholder="1024"></label>
                    <label>Slot <input name="start" type="datetime-local" required value="${defaultSlot()}"></label>
                    <label>Estimated minutes <input name="estimatedMinutes" type="number" min="1" max="10080" value="60"></label>
                </div>
                <div class="nc-embed-error" role="alert" data-embed-form-error></div>
                <button type="submit" class="nc-btn">Queue rebuild</button>
            </form>`;
    }

    function render(data) {
        current = data;
        const body = document.getElementById('nc-embeddings-body');
        const open = data.request && OPEN.includes(data.request.state);
        body.innerHTML = profileHtml(data.profile, open) + requestHtml(data.request, data.build) + (open ? '' : formHtml(data.profile));
        body.querySelector('[data-embed-form]')?.addEventListener('submit', submit);
        body.querySelector('[data-embed-cancel]')?.addEventListener('click', cancel);
        body.querySelector('[data-embed-retire]')?.addEventListener('click', retire);
        clearTimeout(timer);
        if (open) timer = setTimeout(load, POLL_MS);
    }

    async function load() {
        const body = document.getElementById('nc-embeddings-body');
        if (!body) return;
        shared.setSectionBusy(body, true);
        try {
            render(await call(API));
            shared.finishSectionLoad(body);
        } catch (error) {
            shared.renderSectionError(body, `Embeddings unavailable: ${error.message}`);
        }
    }

    async function submit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const error = form.querySelector('[data-embed-form-error]');
        const model = form.elements.model.value.trim();
        const dimension = Number(form.elements.dimension.value);
        const local = form.elements.start.value ? new Date(form.elements.start.value) : null;
        error.textContent = '';
        if (!model || !Number.isInteger(dimension) || dimension < 1 || !local || Number.isNaN(local.getTime())) {
            error.textContent = 'Give the model, its vector dimension and a slot.';
            return;
        }
        const headers = await window.AgentXTypedConfirmation.confirm({
            action: 'CHANGE EMBEDDING MODEL TO', resource: model,
            title: 'Rebuild every RAG embedding',
            description: `At the slot, every document is re-embedded with ${model} into a new collection, then search switches to it. The current collection is kept.`
        });
        if (!headers) return;
        requestKey = requestKey || newKey();
        try {
            await call(`${API}/change`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({
                    model, dimension, expectedModel: current?.profile?.active?.model, requestKey,
                    start: local.toISOString(), estimatedMinutes: Number(form.elements.estimatedMinutes.value) || 60
                })
            });
            requestKey = null;
            await load();
        } catch (failure) {
            // A refusal is final for this attempt; a lost answer keeps the key to replay it.
            if (failure.code) requestKey = null;
            error.textContent = failure.message;
        }
    }

    async function cancel(event) {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await call(`${API}/requests/${encodeURIComponent(current.request.id)}/cancel`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedRevision: current.request.revision })
            });
            await load();
        } catch (failure) {
            button.disabled = false;
            button.insertAdjacentHTML('afterend', `<div class="nc-embed-error" role="alert">${esc(failure.message)}</div>`);
        }
    }

    async function retire(event) {
        const button = event.currentTarget;
        const { previous, revision } = current.profile;
        const headers = await window.AgentXTypedConfirmation.confirm({
            action: 'DELETE EMBEDDING COLLECTION', resource: previous.collection,
            title: 'Delete the previous embedding collection',
            description: `${previous.collection} (${previous.model}) is deleted from Qdrant. Going back to that model then needs a full rebuild.`
        });
        if (!headers) return;
        button.disabled = true;
        try {
            await call(`${API}/previous/retire`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ collection: previous.collection, expectedRevision: revision })
            });
            await load();
        } catch (failure) {
            button.disabled = false;
            button.insertAdjacentHTML('afterend', `<div class="nc-embed-error" role="alert">${esc(failure.message)}</div>`);
        }
    }

    document.addEventListener('DOMContentLoaded', load);
})();
