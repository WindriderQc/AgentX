/**
 * Nerve Center — Principal model and runtime topology.
 *
 * Core keeps one principal choice (Standard or Abliterated, served as
 * agentx-primary) on one host. Its card and the runtime topology card form one
 * panel, placed inside the live card of the machine that hosts the principal
 * model. Until that card exists (or if no machine matches), the panel stays in
 * its own "Principal model and topology" section. The panel is built once per
 * load and moved, never rebuilt, when the live cards refresh, so a choice in
 * progress keeps its state. This stays the one place that changes the
 * principal model.
 */
(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    const principalCard = window.NerveCenterPrincipalModel;
    const topologyCard = window.NerveCenterRuntimeTopology;
    const state = { principal: null, topology: null };

    function addressOf(url) {
        try { return new URL(url).hostname; } catch (_) { return ''; }
    }

    // Held by reference: a detached panel is not in the document, so no id lookup finds it.
    let panelNode = null;
    function panel() { return panelNode || document.getElementById('ncModelPanel'); }

    // The machine address that hosts the principal model, or null.
    function principalAddress() {
        return state.principal?.hostUrl ? addressOf(state.principal.hostUrl) || null : null;
    }

    // Move the panel into the matching machine card, or back to its section.
    function place() {
        const node = panel();
        const section = document.getElementById('sectionModel');
        const body = document.getElementById('sectionModelBody');
        if (!node || !section || !body) return false;
        const address = principalAddress();
        const slot = address
            ? [...document.querySelectorAll('[data-model-slot]')].find(el => el.dataset.modelSlot === address) : null;
        const target = slot || body;
        if (node.parentNode !== target) target.appendChild(node);
        section.hidden = Boolean(slot);
        return Boolean(slot);
    }

    // The live cards keep the panel out of their re-render, then call place().
    function detach() {
        const node = panel();
        if (node && node.parentNode) node.parentNode.removeChild(node);
        return node;
    }

    function holdsFocus() {
        const node = panel();
        return Boolean(node && document.activeElement && node.contains(document.activeElement));
    }

    async function loadModel() {
        const body = document.getElementById('sectionModelBody');
        if (!body) return;
        shared.trackSectionFocus?.(body);
        detach();
        panelNode = null;
        shared.renderSectionLoading(body, 'Loading the principal model...');
        try {
            const [principalJson, topologyJson] = await Promise.all([
                shared.fetchJson('/api/nerve-center/principal-model'),
                // Read-only and optional: a failure leaves the topology card out.
                shared.fetchJson('/api/nerve-center/runtime-topology').catch(() => null)
            ]);
            const firstPrincipal = !state.principal;
            state.principal = principalJson.status === 'success' ? principalJson.data : null;
            state.topology = topologyJson?.status === 'success' ? topologyJson.data : null;
            body.innerHTML = `<div class="nc-model-grid" id="ncModelPanel" role="group" aria-label="Principal model and runtime topology">
                <div class="nc-model-cell">${principalCard.build(state.principal)}</div>
                <div class="nc-model-cell">${topologyCard.build(state.topology)}</div>
            </div>`;
            const reload = async () => {
                await loadModel();
                window.NerveCenterLive?.loadLive?.({ quiet: true });
            };
            panelNode = document.getElementById('ncModelPanel');
            principalCard.attach(state.principal, reload);
            topologyCard.attach?.(state.topology, reload);
            // The live cards may have rendered first: let them name the principal host.
            place();
            if (firstPrincipal && state.principal && document.querySelector('[data-model-slot]')) {
                window.NerveCenterLive?.loadLive?.({ quiet: true });
            }
            shared.restoreSectionFocus?.(body);
        } catch (err) {
            console.error('[NerveCenter] loadModel failed', err);
            shared.renderSectionError(body, `Failed to load the principal model: ${err.message}`);
            const section = document.getElementById('sectionModel');
            if (section) section.hidden = false;
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterModel = { loadModel, place, detach, holdsFocus, principalAddress, state };
})();
