(function () {
    'use strict';

    // Runtime topology (#360): the modes the instance declared for a GPU host
    // group, which one is running, and the switch between them. A switch drains
    // the group, so it needs a typed confirmation. The card reads only Core:
    // it stays readable when the host actuator is unreachable.
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
    const STEPS = ['requested', 'draining', 'actuating', 'loading', 'verifying', 'active'];
    const STATE_LABEL = {
        requested: 'Requested',
        draining: 'Draining the group (waiting for running work)',
        actuating: 'Switching the runtime services',
        loading: 'Loading the pinned models',
        verifying: 'Checking residency, a test answer and pin drift',
        rolling_back: 'Rolling back to the previous mode',
        active: 'Active',
        refused: 'Refused (nothing changed)',
        rolled_back: 'Rolled back: the previous mode serves again',
        uncertain: 'Uncertain: the group stays fenced until operator recovery'
    };
    const WHY = {
        host_busy: 'other work holds the group (a workload, a claim or a maintenance lease)',
        drain_timeout: 'running requests did not finish within the drain bound',
        benchmark_claim_active: 'a Benchmark claim holds a host of the group',
        maintenance_recovery_required: 'a maintenance lease waits for operator recovery',
        already_active: 'the target was already running',
        core_restarted: 'Core restarted during the switch',
        actuator_not_reached: 'the host actuator was not reached',
        actuator_not_configured: 'no host actuator is configured'
    };
    const TERMINAL = ['active', 'refused', 'rolled_back', 'uncertain'];
    const POLL_MS = 3000;

    function esc(value) { return shared.escapeHtml(String(value ?? '')); }

    function why(reason) {
        if (!reason) return '';
        return WHY[reason] || reason.replace(/_/g, ' ');
    }

    function confirmationPhrase(groupId, mode) {
        return `SWITCH ${groupId} TO ${mode}`;
    }

    function endpointRow(endpoint) {
        const pins = endpoint.pins.length
            ? endpoint.pins.map(pin => `${esc(pin.model)}${pin.contextSize ? ` · ${esc(pin.contextSize)}` : ''}`).join(', ')
            : '—';
        const state = endpoint.ready ? 'ready' : esc(REASON[endpoint.reason] || endpoint.reason || 'unknown');
        return `<tr>
            <td>${esc(endpoint.role)}</td>
            <td><code>${esc(endpoint.url)}</code>${endpoint.hostName ? ` <span class="nc-muted">${esc(endpoint.hostName)}</span>` : ''}</td>
            <td>${endpoint.resources.length ? esc(endpoint.resources.length === 1 ? '1 GPU' : `${endpoint.resources.length} GPUs`) : '—'}</td>
            <td>${pins}</td>
            <td>${state}</td>
        </tr>`;
    }

    function modeBlock(mode, activeMode, intendedMode) {
        const notes = [];
        if (mode.id === activeMode) notes.push('running now');
        else if (mode.id !== intendedMode && intendedMode) notes.push('parked');
        return `<div class="nc-mb-16" data-topology-mode="${esc(mode.id)}">
            <strong>${esc(mode.label)}</strong>
            <span class="nc-muted"> — ${esc(STATUS[mode.status] || mode.status)}${notes.length ? ` (${esc(notes.join(', '))})` : ''}</span>
            <table class="nc-table"><thead><tr><th>Role</th><th>Endpoint</th><th>GPUs</th><th>Pins</th><th>State</th></tr></thead>
            <tbody>${mode.endpoints.map(endpoint => endpointRow(endpoint)).join('')}</tbody></table>
        </div>`;
    }

    function time(value) {
        return value ? new Date(value).toLocaleTimeString() : '';
    }

    /** Progress or receipt of one switch record. */
    function progressHtml(record) {
        if (!record) return '';
        const reached = new Set((record.transitions || []).map(item => item.state));
        const terminal = TERMINAL.includes(record.state);
        const steps = STEPS.map(step => {
            const done = reached.has(step) && (step !== record.state || terminal);
            const current = step === record.state && !terminal;
            return `<li class="${current ? 'nc-step-current' : done ? 'nc-step-done' : 'nc-step-pending'}">${esc(STATE_LABEL[step])}${current ? ' …' : done ? ' ✓' : ''}</li>`;
        }).join('');
        const lines = [`<strong>${esc(record.fromMode || '?')} → ${esc(record.targetMode)}</strong>: ${esc(STATE_LABEL[record.state] || record.state)}`];
        if (record.reason) lines.push(`Reason: ${esc(why(record.reason))}`);
        if (record.message && !terminal) lines.push(esc(record.message));
        if (record.blockers?.length) {
            lines.push(`Waiting for: ${record.blockers.map(item => esc(`${item.kind || 'work'}${item.owner ? ` (${item.owner})` : ''}`)).join(', ')}`);
        }
        const verification = record.verification;
        if (terminal && verification?.residency) {
            const resident = verification.residency.every(item => item.ok) ? 'all pins on GPU at their context' : 'residency incomplete';
            const smoke = verification.smoke ? (verification.smoke.every(item => item.ok) ? 'test answer ok' : 'test answer failed') : null;
            const drift = verification.drift ? `pin drift ${verification.drift.status}` : null;
            lines.push(esc([resident, smoke, drift].filter(Boolean).join(' · ')));
        }
        if (record.timings?.totalMs) lines.push(`Took ${esc(Math.round(record.timings.totalMs / 1000))} s.`);
        if (record.state === 'uncertain') {
            lines.push('Read the actuator status for this request, bring the host to a known mode, then recover the maintenance lease (Operations guide, “Switching modes”).');
        }
        const when = record.finishedAt ? `Ended ${esc(time(record.finishedAt))}.` : record.createdAt ? `Started ${esc(time(record.createdAt))}.` : '';
        return `<div class="nc-topology-progress" data-switch-state="${esc(record.state)}">
            <p>${lines.join('<br>')}</p>
            ${record.state === 'refused' && !reached.has('actuating') ? '' : `<ol class="nc-topology-steps">${steps}</ol>`}
            <p class="nc-muted">Switch ${esc(record.requestId)}. ${when}</p>
        </div>`;
    }

    function controlBlock(group) {
        const info = group.switch || {};
        const running = info.inProgress || (info.last && !TERMINAL.includes(info.last.state));
        if (!info.actuatorConfigured) {
            return `<p class="nc-muted">Switching is not available for this group: no host actuator is configured (AGENTX_TOPOLOGY_ACTUATORS_JSON).</p>`;
        }
        const targets = group.modes.filter(mode => mode.id !== group.activeMode);
        const blocked = running ? 'A switch is running.' : group.state !== 'active' ? 'A switch needs exactly one running mode.' : '';
        return `<div class="nc-topology-control" data-group="${esc(group.id)}">
            <label for="ncTopologyTarget-${esc(group.id)}">Switch to </label>
            <select id="ncTopologyTarget-${esc(group.id)}" class="nc-inline-select nc-topology-target" data-group="${esc(group.id)}" ${blocked ? 'disabled' : ''}>
                ${targets.map(mode => `<option value="${esc(mode.id)}">${esc(mode.label)}</option>`).join('')}
            </select>
            <button type="button" class="nc-btn nc-topology-apply" data-group="${esc(group.id)}" ${blocked || !targets.length ? 'disabled' : ''}>Apply</button>
            ${blocked ? `<span class="nc-muted"> ${esc(blocked)}</span>` : ''}
            <div class="nc-topology-confirm" data-group="${esc(group.id)}" hidden>
                <p class="nc-muted">The switch drains this host group: requests there wait or are refused with “topology switch in progress” until it ends, usually 5 to 15 minutes. Models reload and prompt caches are lost.</p>
                <label>Type <code class="nc-topology-phrase"></code> to confirm:
                    <input type="text" class="nc-topology-phrase-input" data-group="${esc(group.id)}" autocomplete="off" spellcheck="false">
                </label>
                <button type="button" class="nc-btn nc-topology-confirm-go" data-group="${esc(group.id)}" disabled>Switch now</button>
                <button type="button" class="nc-btn nc-topology-confirm-cancel" data-group="${esc(group.id)}">Cancel</button>
            </div>
        </div>`;
    }

    function groupBlock(group) {
        const info = group.switch || {};
        const record = info.last || null;
        return `<div class="nc-mb-16" data-topology-group="${esc(group.id)}">
            <h5 class="nc-title">${esc(group.label)}</h5>
            <p>Current mode: <strong>${esc(group.activeMode || 'none')}</strong>${info.intendedMode && info.intendedMode !== group.activeMode ? ` <span class="nc-muted">(intended: ${esc(info.intendedMode)})</span>` : ''}</p>
            ${GROUP_STATE[group.state] ? `<p class="nc-muted">${esc(GROUP_STATE[group.state])}</p>` : ''}
            ${controlBlock(group)}
            <div class="nc-topology-progress-slot" id="ncTopologyProgress-${esc(group.id)}">${progressHtml(record)}</div>
            ${group.modes.map(mode => modeBlock(mode, group.activeMode, info.intendedMode)).join('')}
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
            <p class="nc-muted">Which declared mode runs on each GPU host group. The endpoints of the other modes are parked: stopped on purpose, without alerts. Independent of the Standard/Abliterated choice.</p>
            ${topology.groups.map(groupBlock).join('')}
            <p class="nc-muted">Observed ${esc(time(topology.observedAt))}.</p>
        </div>`;
    }

    function newRequestId() {
        const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return `nc-${random}`.slice(0, 100);
    }

    async function submitSwitch(fetchJson, body) {
        const reply = await fetchJson('/api/nerve-center/runtime-topology/switch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        if (reply.status !== 'success') throw new Error(reply.message || 'The switch was refused');
        return reply.data;
    }

    /** Follow a switch until it ends; `onUpdate` gets each record. */
    async function followSwitch(fetchJson, requestId, onUpdate, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), limit = 1200 } = {}) {
        for (let read = 0; read < limit; read += 1) {
            let record = null;
            try {
                const reply = await fetchJson(`/api/nerve-center/runtime-topology/switch/${encodeURIComponent(requestId)}`);
                record = reply.status === 'success' ? reply.data : null;
            } catch { record = null; } // a missed read is retried; the switch runs in Core
            if (record) {
                onUpdate(record);
                if (TERMINAL.includes(record.state)) return record;
            }
            await sleep(POLL_MS);
        }
        return null;
    }

    function attach(topology, reload, { doc = document, fetchJson = shared.fetchJson, toast = globalThis.Toast } = {}) {
        if (!topology?.configured || !topology.valid) return;
        const card = doc.getElementById('ncTopologyCard');
        if (!card) return;
        for (const group of topology.groups) {
            const info = group.switch || {};
            const slot = doc.getElementById(`ncTopologyProgress-${group.id}`);
            const update = record => { if (slot) slot.innerHTML = progressHtml(record); };
            const pending = info.inProgress?.id || (info.last && !TERMINAL.includes(info.last.state) ? info.last.requestId : null);
            if (pending) followSwitch(fetchJson, pending, update).then(() => reload());
        }
        card.querySelectorAll('.nc-topology-apply').forEach(button => button.addEventListener('click', () => {
            const groupId = button.dataset.group;
            const select = card.querySelector(`.nc-topology-target[data-group="${groupId}"]`);
            const confirm = card.querySelector(`.nc-topology-confirm[data-group="${groupId}"]`);
            confirm.querySelector('.nc-topology-phrase').textContent = confirmationPhrase(groupId, select.value);
            confirm.hidden = false;
            confirm.querySelector('.nc-topology-phrase-input').value = '';
            confirm.querySelector('.nc-topology-confirm-go').disabled = true;
        }));
        card.querySelectorAll('.nc-topology-phrase-input').forEach(input => input.addEventListener('input', () => {
            const groupId = input.dataset.group;
            const select = card.querySelector(`.nc-topology-target[data-group="${groupId}"]`);
            const go = card.querySelector(`.nc-topology-confirm-go[data-group="${groupId}"]`);
            go.disabled = input.value.trim() !== confirmationPhrase(groupId, select.value);
        }));
        card.querySelectorAll('.nc-topology-confirm-cancel').forEach(button => button.addEventListener('click', () => {
            card.querySelector(`.nc-topology-confirm[data-group="${button.dataset.group}"]`).hidden = true;
        }));
        card.querySelectorAll('.nc-topology-confirm-go').forEach(button => button.addEventListener('click', async () => {
            const groupId = button.dataset.group;
            const group = topology.groups.find(item => item.id === groupId);
            const select = card.querySelector(`.nc-topology-target[data-group="${groupId}"]`);
            const input = card.querySelector(`.nc-topology-phrase-input[data-group="${groupId}"]`);
            if (input.value.trim() !== confirmationPhrase(groupId, select.value)) return;
            button.disabled = true;
            const slot = doc.getElementById(`ncTopologyProgress-${groupId}`);
            const update = record => { if (slot) slot.innerHTML = progressHtml(record); };
            try {
                const record = await submitSwitch(fetchJson, { groupId, targetMode: select.value,
                    expectedActiveMode: group.activeMode, requestId: newRequestId() });
                card.querySelector(`.nc-topology-confirm[data-group="${groupId}"]`).hidden = true;
                update(record);
                const final = await followSwitch(fetchJson, record.requestId, update);
                if (final?.state === 'active') toast?.success?.(`Topology: ${groupId} runs ${final.targetMode}`);
                else if (final) toast?.error?.(`Topology switch ${STATE_LABEL[final.state] || final.state}${final.reason ? `: ${why(final.reason)}` : ''}`);
            } catch (error) {
                toast?.error?.(error.message);
                button.disabled = false;
            } finally {
                await reload();
            }
        }));
    }

    window.NerveCenterRuntimeTopology = { build, attach, progressHtml, confirmationPhrase, followSwitch, submitSwitch };
})();
