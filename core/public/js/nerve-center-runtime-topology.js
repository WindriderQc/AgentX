(function () {
    'use strict';

    // Runtime topology (#360), read-only: the modes the instance declared for a
    // GPU host group, which one is running, and why another is not.
    const shared = window.NerveCenterShared;

    const STATUS = {
        active: 'Active', partial: 'Partly running', inactive: 'Inactive'
    };
    const GROUP_STATE = {
        active: null,
        conflict: 'More than one mode looks active: check the endpoints.',
        transitional: 'No mode is fully running: a mode is starting, stopping or missing a pin.',
        none_active: 'No declared mode is running.'
    };
    const REASON = {
        not_registered: 'not a registered inference host',
        offline: 'runtime not reachable',
        no_pins: 'no pinned model',
        pins_not_resident: 'pinned model not loaded'
    };

    function endpointRow(endpoint) {
        const pins = endpoint.pins.length
            ? endpoint.pins.map(pin => `${shared.escapeHtml(pin.model)}${pin.contextSize ? ` · ${shared.escapeHtml(String(pin.contextSize))}` : ''}`).join(', ')
            : '—';
        const state = endpoint.ready ? 'ready' : shared.escapeHtml(REASON[endpoint.reason] || endpoint.reason || 'unknown');
        return `<tr>
            <td>${shared.escapeHtml(endpoint.role)}</td>
            <td><code>${shared.escapeHtml(endpoint.url)}</code>${endpoint.hostName ? ` <span class="nc-muted">${shared.escapeHtml(endpoint.hostName)}</span>` : ''}</td>
            <td>${endpoint.resources.length ? shared.escapeHtml(endpoint.resources.length === 1 ? '1 GPU' : `${endpoint.resources.length} GPUs`) : '—'}</td>
            <td>${pins}</td>
            <td>${state}</td>
        </tr>`;
    }

    function modeBlock(mode, activeMode) {
        return `<div class="nc-mb-16" data-topology-mode="${shared.escapeHtml(mode.id)}">
            <strong>${shared.escapeHtml(mode.label)}</strong>
            <span class="nc-muted"> — ${shared.escapeHtml(STATUS[mode.status] || mode.status)}${mode.id === activeMode ? ' (running now)' : ''}</span>
            <table class="nc-table"><thead><tr><th>Role</th><th>Endpoint</th><th>GPUs</th><th>Pins</th><th>State</th></tr></thead>
            <tbody>${mode.endpoints.map(endpointRow).join('')}</tbody></table>
        </div>`;
    }

    function build(topology) {
        if (!topology) return '';
        if (!topology.configured) {
            return `<div class="nc-host-card nc-mb-16 nc-td-lg" id="ncTopologyCard">
                <h4 class="nc-title">Runtime topology</h4>
                <p class="nc-muted">No topology modes are declared (AGENTX_RUNTIME_TOPOLOGY_JSON). Routing uses hosts directly.</p>
            </div>`;
        }
        if (!topology.valid) {
            return `<div class="nc-host-card nc-mb-16 nc-td-lg" id="ncTopologyCard">
                <h4 class="nc-title">Runtime topology</h4>
                <p class="nc-muted">The topology declaration is invalid; fix AGENTX_RUNTIME_TOPOLOGY_JSON in the instance env file.</p>
            </div>`;
        }
        return `<div class="nc-host-card nc-mb-16 nc-td-lg" id="ncTopologyCard">
            <h4 class="nc-title">Runtime topology</h4>
            <p class="nc-muted">Read-only. Shows which declared mode runs on each GPU host group. Switching modes is not available yet.</p>
            ${topology.groups.map(group => `<div class="nc-mb-16" data-topology-group="${shared.escapeHtml(group.id)}">
                <h5 class="nc-title">${shared.escapeHtml(group.label)}</h5>
                ${GROUP_STATE[group.state] ? `<p class="nc-muted">${shared.escapeHtml(GROUP_STATE[group.state])}</p>` : ''}
                ${group.modes.map(mode => modeBlock(mode, group.activeMode)).join('')}
            </div>`).join('')}
            <p class="nc-muted">Observed ${shared.escapeHtml(new Date(topology.observedAt).toLocaleTimeString())}.</p>
        </div>`;
    }

    window.NerveCenterRuntimeTopology = { build };
})();
