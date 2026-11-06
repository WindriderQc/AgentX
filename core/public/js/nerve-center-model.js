/**
 * Nerve Center — Principal model and runtime topology.
 *
 * The principal model card (Standard/Abliterated choice) and the runtime
 * topology card sit near the top of the page, in their own section, so the one
 * place that changes the principal model is visible without opening diagnostics.
 */
(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    const principalCard = window.NerveCenterPrincipalModel;
    const topologyCard = window.NerveCenterRuntimeTopology;

    async function loadModel() {
        const body = document.getElementById('sectionModelBody');
        if (!body) return;
        shared.trackSectionFocus?.(body);
        shared.renderSectionLoading(body, 'Loading the principal model...');
        try {
            const [principalJson, topologyJson] = await Promise.all([
                shared.fetchJson('/api/nerve-center/principal-model'),
                // Read-only and optional: a failure leaves the topology card out.
                shared.fetchJson('/api/nerve-center/runtime-topology').catch(() => null)
            ]);
            const principalModel = principalJson.status === 'success' ? principalJson.data : null;
            const runtimeTopology = topologyJson?.status === 'success' ? topologyJson.data : null;
            body.innerHTML = `<div class="nc-model-grid">
                <div class="nc-model-cell">${principalCard.build(principalModel)}</div>
                <div class="nc-model-cell">${topologyCard.build(runtimeTopology)}</div>
            </div>`;
            const reload = async () => {
                await loadModel();
                window.NerveCenterLive?.loadLive?.({ quiet: true });
            };
            principalCard.attach(principalModel, reload);
            topologyCard.attach?.(runtimeTopology, reload);
            shared.restoreSectionFocus?.(body);
        } catch (err) {
            console.error('[NerveCenter] loadModel failed', err);
            shared.renderSectionError(body, `Failed to load the principal model: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterModel = { loadModel };
})();
