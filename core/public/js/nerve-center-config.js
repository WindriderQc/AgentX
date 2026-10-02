(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    if (!shared) return;

    // Read-only view of GET /api/nerve-center/config-status. Settings live in
    // the instance env file; this section shows which ones are customized,
    // which run on their default and which are not configured, per service.
    const STATES = {
        custom: { label: 'Customized', color: '#4ade80', hint: 'Set in the instance, different from the default' },
        default: { label: 'Default', color: '#94a3b8', hint: 'Not set in the instance; the compose default or the code fallback applies' },
        off: { label: 'Not configured', color: '#fbbf24', hint: 'Not set and no default: the option is off' },
        unknown: { label: 'Not reported', color: '#64748b', hint: 'This service does not report its environment yet' },
    };
    const FILTERS = [
        { id: 'attention', label: 'Instance options not configured' },
        { id: 'custom', label: 'Customized' },
        { id: 'all', label: 'All' },
    ];

    let payload = null;
    let filter = 'attention';
    let query = '';

    const esc = value => shared.escapeHtml(value == null ? '' : String(value));

    function matches(variable) {
        if (filter === 'attention' && !(variable.state === 'off' && variable.forwarded)) return false;
        if (filter === 'custom' && variable.state !== 'custom') return false;
        if (!query) return true;
        const text = `${variable.name} ${variable.category} ${variable.description}`.toLowerCase();
        return text.includes(query);
    }

    function valueCell(variable) {
        if (variable.secret) return variable.set ? '<span class="nc-muted">secret set</span>' : '<span class="nc-muted">—</span>';
        if (variable.value !== null && variable.value !== undefined) return `<code>${esc(variable.value)}</code>`;
        if (variable.default !== null && variable.default !== undefined) return `<span class="nc-muted">default</span> <code>${esc(variable.default)}</code>`;
        if (variable.fallback) return `<span class="nc-muted">default: ${esc(variable.fallback)}</span>`;
        return '<span class="nc-muted">—</span>';
    }

    function badge(state) {
        const s = STATES[state] || STATES.unknown;
        return `<span class="nc-model-tag" style="border-color:${s.color};color:${s.color}" title="${esc(s.hint)}">${esc(s.label)}</span>`;
    }

    function summaryCards(services) {
        return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px">${services.map(svc => {
            const s = svc.summary || {};
            const body = svc.reported === false
                ? `<div class="nc-muted" style="font-size:0.8em">${esc(svc.reason || 'not reported')} · ${s.total || 0} settings</div>`
                : `<div style="font-size:1.1em;font-weight:700;color:var(--text-bright)">${s.custom || 0} customized</div>
                   <div class="nc-muted" style="font-size:0.8em">${s.default || 0} default · ${s.off || 0} not configured</div>`;
            return `<div class="nc-host-card" style="padding:12px">
                <div class="nc-muted" style="font-size:0.8em;text-transform:uppercase">${esc(svc.service)}</div>${body}</div>`;
        }).join('')}</div>`;
    }

    function rows(services) {
        const list = [];
        for (const svc of services) {
            for (const variable of svc.variables || []) {
                if (matches(variable)) list.push({ ...variable, service: svc.service });
            }
        }
        list.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.service.localeCompare(b.service));
        if (!list.length) {
            return `<div class="nc-muted" style="padding:12px">${filter === 'attention'
                ? 'Every instance option forwarded by compose is set or has a default.'
                : 'No setting matches.'}</div>`;
        }
        let category = null;
        return `<div style="overflow-x:auto"><table class="nc-table" style="width:100%">
            <thead><tr><th>Setting</th><th>Service</th><th>State</th><th>Value</th><th>Purpose</th></tr></thead>
            <tbody>${list.map(v => {
                const head = v.category !== category
                    ? `<tr><td colspan="5" style="padding-top:14px;font-weight:700;text-transform:uppercase;font-size:0.78em;color:var(--text-bright)">${esc(v.category)}</td></tr>`
                    : '';
                category = v.category;
                const reach = v.forwarded ? '' : ' <span class="nc-muted" title="Read by the code but not forwarded by docker-compose.yml: only the instance override can set it">(override only)</span>';
                return `${head}<tr>
                    <td><code>${esc(v.name)}</code>${reach}</td>
                    <td class="nc-muted">${esc(v.service)}</td>
                    <td>${badge(v.state)}</td>
                    <td style="max-width:280px;overflow-wrap:anywhere">${valueCell(v)}</td>
                    <td style="max-width:420px">${v.description ? esc(v.description) : '<span class="nc-muted">Not documented yet</span>'}</td>
                </tr>`;
            }).join('')}</tbody></table></div>`;
    }

    function render() {
        const body = document.getElementById('nc-config-body');
        if (!body || !payload) return;
        const services = payload.services || [];
        const controls = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
            ${FILTERS.map(f => `<button type="button" class="nc-btn${f.id === filter ? ' active' : ''}" data-config-filter="${f.id}" aria-pressed="${f.id === filter}">${esc(f.label)}</button>`).join('')}
            <input type="search" id="nc-config-search" placeholder="Filter by name or purpose" value="${esc(query)}" aria-label="Filter settings" style="flex:1;min-width:180px">
        </div>
        <div class="nc-muted" style="font-size:0.75em;margin-bottom:8px">Settings are edited in the instance env file and take effect when the service is recreated. Secret values are never shown. Generated ${payload.generatedAt ? shared.timeAgo(payload.generatedAt) : ''}.</div>`;
        body.innerHTML = summaryCards(services) + controls + `<div id="nc-config-rows">${rows(services)}</div>`;
        body.querySelectorAll('[data-config-filter]').forEach(btn => btn.addEventListener('click', () => {
            filter = btn.dataset.configFilter;
            render();
        }));
        const search = body.querySelector('#nc-config-search');
        search.addEventListener('input', () => {
            query = search.value.trim().toLowerCase();
            document.getElementById('nc-config-rows').innerHTML = rows(services);
        });
    }

    async function loadConfig() {
        const body = document.getElementById('nc-config-body');
        if (!body) return;
        shared.setSectionBusy(body, true);
        try {
            const res = await shared.fetchJson('/api/nerve-center/config-status');
            payload = res.data || { services: [] };
            render();
        } catch (err) {
            shared.renderSectionError(body, 'Configuration status unavailable');
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterConfig = { loadConfig };
})();
