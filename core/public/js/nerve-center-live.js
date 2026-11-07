/**
 * Nerve Center — Live view.
 *
 * One read-only card per physical machine: its GPUs right now, the models each
 * Ollama endpoint holds (pinned or not), endpoints parked by the runtime
 * topology, and the heavy-work reservations and Benchmark claims that hold it.
 * Endpoints are grouped by the address they share. Editing stays in Host settings.
 * Each machine takes the full width; power gauges, power history and the live
 * requests card come from nerve-center-live-charts.js when it is loaded.
 */
(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    const POLL_MS = 20000;
    const DAY_MS = 86400000;
    const ACTIVE_JOB_STATES = ['dispatching', 'running', 'uncertain'];
    const OPEN_JOB_STATES = ['requested', 'reserved', ...ACTIVE_JOB_STATES];

    function esc(value) { return shared.escapeHtml(String(value ?? '')); }

    function addressOf(url) {
        try { return new URL(url).hostname; } catch (_) { return ''; }
    }

    function sameUrl(left, right) {
        return shared.normalizeHostUrl(left) === shared.normalizeHostUrl(right);
    }

    function gib(mib) { return (Number(mib) / 1024).toFixed(1); }

    function clockTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '--';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function dayAndTime(value, now) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '--';
        const sameDay = new Date(now).toDateString() === date.toDateString();
        return sameDay ? clockTime(value)
            : `${date.toLocaleDateString([], { weekday: 'short' })} ${clockTime(value)}`;
    }

    // The mode a group should run: its recorded switch intent, else what runs.
    function intendedMode(group, topology) {
        return group.switch?.intendedMode || group.intendedMode || group.activeMode
            || topology.switch?.intendedMode || topology.activeMode || null;
    }

    function switching(group, topology) {
        return Boolean(group.switch?.inProgress || topology.switch?.inProgress);
    }

    // Endpoints the runtime topology parks on purpose: they belong only to modes
    // other than the one the group should run, so "unreachable" is expected.
    // During a switch nothing is called parked.
    function parkedUrls(topology) {
        const parked = new Set();
        if (!topology || topology.configured === false || !Array.isArray(topology.groups)) return parked;
        topology.groups.forEach(group => {
            const intended = switching(group, topology) ? null : intendedMode(group, topology);
            if (!intended || !Array.isArray(group.modes)) return;
            const live = new Set();
            const others = new Set();
            group.modes.forEach(mode => (mode.endpoints || []).forEach(endpoint => {
                const url = shared.normalizeHostUrl(endpoint.url);
                (mode.id === intended ? live : others).add(url);
            }));
            others.forEach(url => { if (!live.has(url)) parked.add(url); });
        });
        return parked;
    }

    function topologyModeFor(topology, urls) {
        if (!topology || !Array.isArray(topology.groups)) return null;
        for (const group of topology.groups) {
            const modes = Array.isArray(group.modes) ? group.modes : [];
            const touches = modes.some(mode => (mode.endpoints || []).some(e => urls.some(url => sameUrl(url, e.url))));
            if (!touches) continue;
            const intended = intendedMode(group, topology);
            const running = modes.find(mode => mode.status === 'active');
            const target = modes.find(mode => mode.id === intended);
            return {
                label: (running || target)?.label || intended || 'unknown',
                settled: Boolean(running) && (!target || running.id === target.id),
                switching: switching(group, topology)
            };
        }
        return null;
    }

    // Short endpoint label inside its machine card: "host-b CPU" → "CPU".
    function endpointLabel(name, machineName, residency) {
        const text = String(name || '');
        if (text === machineName) return residency === 'cpu' ? 'CPU engine' : 'GPU engine';
        const rest = text.startsWith(machineName) ? text.slice(machineName.length).trim() : text;
        return rest || text;
    }

    function buildEndpoint(host, pref, parked) {
        const running = Array.isArray(pref?.live?.runningModels) ? pref.live.runningModels : [];
        const pins = (Array.isArray(pref?.pinnedModels) ? pref.pinnedModels : []).filter(p => p && p.model).map(p => p.model);
        const loadedNames = running.map(m => m?.name).filter(Boolean);
        const online = host.available === true;
        return {
            id: host.id,
            name: host.name || host.id,
            url: host.url,
            residency: host.residency === 'cpu' ? 'cpu' : 'gpu',
            state: online ? 'up' : (parked.has(shared.normalizeHostUrl(host.url)) ? 'parked' : 'down'),
            loaded: running.map(m => ({
                name: m.name,
                pinned: pins.includes(m.name) || m.matchedPinned === true,
                context: Number(m.contextLength) || null
            })),
            vramMiB: running.reduce((sum, m) => sum + (Number(m.sizeVram) > 0 ? Number(m.sizeVram) : 0), 0) / (1024 * 1024),
            pins,
            missingPins: online ? pins.filter(model => !loadedNames.includes(model)) : [],
            benchmarkClaim: pref?.benchmarkClaim || null
        };
    }

    // Group the registered endpoints by machine address, in registry order.
    function groupMachines({ hosts = [], prefs = [], gpuRows = [], topology = null } = {}) {
        const parked = parkedUrls(topology);
        const prefByUrl = new Map(prefs.map(pref => [shared.normalizeHostUrl(pref.hostUrl), pref]));
        const gpuByHost = new Map(gpuRows.map(row => [row.hostId, row]));
        const machines = [];
        const byAddress = new Map();
        hosts.forEach(host => {
            const address = addressOf(host.url) || host.id;
            let machine = byAddress.get(address);
            if (!machine) {
                machine = { address, hosts: [] };
                byAddress.set(address, machine);
                machines.push(machine);
            }
            machine.hosts.push(host);
        });
        return machines.map(machine => {
            const withGpu = machine.hosts
                .map(host => ({ host, gpu: gpuByHost.get(host.id) }))
                .filter(entry => Array.isArray(entry.gpu?.gpus) && entry.gpu.gpus.length > 0);
            const main = machine.hosts.find(host => host.residency !== 'cpu' && withGpu.some(e => e.host === host))
                || machine.hosts.find(host => host.residency !== 'cpu') || machine.hosts[0];
            const name = main.name || main.id;
            const gpuEntry = withGpu.find(entry => entry.host === main) || withGpu[0] || null;
            const endpoints = machine.hosts.map(host => buildEndpoint(host, prefByUrl.get(shared.normalizeHostUrl(host.url)), parked));
            return {
                name,
                address: machine.address,
                mainHostId: main.id,
                urls: machine.hosts.map(host => host.url),
                gpus: gpuEntry ? gpuEntry.gpu.gpus : [],
                telemetry: gpuEntry?.gpu?.telemetry || null,
                endpoints,
                mode: topologyModeFor(topology, machine.hosts.map(host => host.url))
            };
        });
    }

    function jobTouches(job, machine) {
        return (job.hosts || []).some(url => addressOf(url) === machine.address);
    }

    function openJobs(jobs) {
        return (Array.isArray(jobs) ? jobs : []).filter(job => OPEN_JOB_STATES.includes(job.state));
    }

    // Now: recorded as dispatching/running/uncertain, or a reserved slot that is open.
    function jobPhase(job, now) {
        if (ACTIVE_JOB_STATES.includes(job.state)) return job.state === 'uncertain' ? 'uncertain' : 'running';
        if (job.state !== 'reserved' || !job.reservation) return 'waiting';
        const start = Date.parse(job.reservation.start);
        const end = Date.parse(job.reservation.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return 'waiting';
        if (now >= end) return 'expired';
        return now >= start ? 'open' : 'upcoming';
    }

    function machineWork(machine, jobs, claims, now) {
        const mine = openJobs(jobs).filter(job => jobTouches(job, machine));
        const withPhase = mine.map(job => ({ job, phase: jobPhase(job, now) }));
        const current = withPhase.filter(entry => ['running', 'uncertain', 'open'].includes(entry.phase));
        const next = withPhase.filter(entry => entry.phase === 'upcoming')
            .sort((a, b) => Date.parse(a.job.reservation.start) - Date.parse(b.job.reservation.start))[0] || null;
        const machineClaims = (Array.isArray(claims) ? claims : []).filter(claim => addressOf(claim.hostUrl) === machine.address);
        const endpointClaims = machine.endpoints.filter(e => e.benchmarkClaim?.batchId)
            .map(e => ({ hostUrl: e.url, ...e.benchmarkClaim }));
        const allClaims = machineClaims.length > 0 ? machineClaims : endpointClaims;
        return {
            current,
            next,
            waiting: withPhase.filter(entry => entry.phase === 'waiting').length,
            claims: allClaims
        };
    }

    function telemetryStale(telemetry) {
        return Boolean(telemetry) && telemetry.status && telemetry.status !== 'fresh';
    }

    function holdsWork(work) {
        return Boolean(work) && (work.current.length > 0 || work.claims.length > 0);
    }

    // Plain list of what needs a look, shared by the status line and the cards.
    // A pin unloaded while reserved work or a claim holds the machine is expected:
    // it is reported as held, not as a problem.
    function machineIssues(machine, work = null) {
        const issues = [];
        machine.endpoints.forEach(endpoint => {
            if (endpoint.state === 'down') issues.push(`${machine.name}: ${endpointLabel(endpoint.name, machine.name, endpoint.residency)} unreachable`);
            if (endpoint.missingPins.length > 0 && !holdsWork(work)) {
                issues.push(`${machine.name}: pin not loaded (${endpoint.missingPins.map(shared.shortModel).join(', ')})`);
            }
        });
        if (telemetryStale(machine.telemetry)) issues.push(`${machine.name}: GPU readings are ${machine.telemetry.status}`);
        // A missing pin already explains an unsettled mode; say it once.
        if (machine.mode && !machine.mode.settled && !machine.mode.switching && issues.length === 0 && !holdsWork(work)) {
            issues.push(`${machine.name}: no topology mode fully running`);
        }
        return issues;
    }

    function heldNote(machine, work) {
        if (!holdsWork(work)) return null;
        const unloaded = machine.endpoints.some(e => e.missingPins.length > 0);
        return `${machine.name}: reserved work holds it${unloaded ? ', pins unloaded until it ends' : ''}`;
    }

    function statusSummary(machines, works = []) {
        const up = machines.filter(m => m.endpoints.some(e => e.state === 'up')).length;
        const issues = machines.flatMap((m, index) => machineIssues(m, works[index]));
        const held = machines.map((m, index) => heldNote(m, works[index])).filter(Boolean);
        return { up, total: machines.length, issues, held, tone: up < machines.length ? 'critical' : (issues.length ? 'attention' : 'nominal') };
    }

    function gpuRow(gpu) {
        const used = Number(gpu.vramUsed) || 0;
        const total = Number(gpu.vramTotal) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
        const util = Number.isFinite(Number(gpu.utilization)) ? `${Math.round(gpu.utilization)}%` : '--';
        const temp = Number.isFinite(Number(gpu.temperature)) ? `${Math.round(gpu.temperature)}°C` : '';
        const power = Number.isFinite(Number(gpu.powerDraw)) ? `${Math.round(gpu.powerDraw)} W` : '';
        const thermal = (gpu.throttleReasons || []).includes('thermal');
        const label = String(gpu.name || 'GPU').replace(/^NVIDIA GeForce /, '');
        return `<div class="nc-live-gpu">
            <div class="nc-live-gpu-head">
                <span><strong>GPU ${esc(gpu.index ?? '')}</strong> <span class="nc-muted">${esc(label)}</span></span>
                <span class="nc-live-gpu-util" title="GPU utilization now">${esc(util)}</span>
            </div>
            <div class="nc-live-bar" role="img" aria-label="VRAM ${pct}% used"><div class="nc-live-bar-fill${pct > 90 ? ' high' : ''}" style="width:${pct}%"></div></div>
            <div class="nc-live-gpu-foot">
                <span>VRAM ${gib(used)} / ${gib(total)} GiB</span>
                <span class="${thermal ? 'nc-live-warn' : ''}">${esc([temp, power].filter(Boolean).join(' · '))}${thermal ? ' · throttled' : ''}</span>
            </div>
        </div>`;
    }

    function endpointBlock(endpoint, machine, held) {
        const label = endpointLabel(endpoint.name, machine.name, endpoint.residency);
        const stateChip = endpoint.state === 'up' ? '<span class="nc-live-chip ok">up</span>'
            : endpoint.state === 'parked' ? '<span class="nc-live-chip muted" title="Stopped on purpose by the runtime topology">parked</span>'
                : '<span class="nc-live-chip danger">unreachable</span>';
        const models = endpoint.loaded.length > 0
            ? endpoint.loaded.map(model => `<li title="${esc(model.name)}${model.context ? ` · context ${model.context}` : ''}">
                <i class="fas ${model.pinned ? 'fa-thumbtack' : 'fa-cube'}" aria-hidden="true"></i>
                <span>${esc(shared.shortModel(model.name))}</span>${model.pinned ? '<span class="nc-sr-only"> (pinned)</span>' : ''}</li>`).join('')
            : (endpoint.state === 'up' ? '<li class="nc-muted">Nothing loaded</li>' : '');
        const pinList = esc(endpoint.missingPins.map(shared.shortModel).join(', '));
        const missing = endpoint.missingPins.length === 0 ? ''
            : held ? `<div class="nc-muted nc-live-small"><i class="fas fa-pause" aria-hidden="true"></i> Unloaded during reserved work: ${pinList}</div>`
                : `<div class="nc-live-warn"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> Pin not loaded: ${pinList}</div>`;
        return `<div class="nc-live-endpoint${endpoint.state === 'parked' ? ' parked' : ''}">
            <div class="nc-live-endpoint-head"><span>${esc(label)}</span>${stateChip}</div>
            ${models ? `<ul class="nc-live-models">${models}</ul>` : ''}
            ${missing}
        </div>`;
    }

    function workBlock(work, now) {
        const lines = [];
        work.current.forEach(({ job, phase }) => {
            const until = job.reservation?.end ? ` until ${esc(clockTime(job.reservation.end))}` : '';
            const tag = phase === 'open' ? 'Slot open' : phase === 'uncertain' ? 'Uncertain' : 'Running';
            lines.push(`<div class="nc-live-work now"><span class="nc-live-chip warn">${tag}</span> ${esc(job.title)}<span class="nc-muted">${until}</span></div>`);
        });
        work.claims.forEach(claim => {
            const claimEnd = claim.estimatedDurationMs && claim.claimedAt
                ? `<span class="nc-muted"> until about ${esc(clockTime(Date.parse(claim.claimedAt) + Number(claim.estimatedDurationMs)))}</span>` : '';
            lines.push(`<div class="nc-live-work now" title="${esc(claim.note || claim.batchId || '')}"><span class="nc-live-chip warn">Claim</span> ${esc(claim.owner || 'Benchmark')}${claimEnd}</div>`);
        });
        if (work.next) {
            lines.push(`<div class="nc-live-work"><span class="nc-live-chip muted">${esc(dayAndTime(work.next.job.reservation.start, now))}</span> ${esc(work.next.job.title)}</div>`);
        }
        if (work.waiting > 0) lines.push(`<div class="nc-muted nc-live-small">${work.waiting} waiting for a slot</div>`);
        if (lines.length === 0) lines.push('<div class="nc-muted nc-live-small">No reservation</div>');
        return `<div class="nc-live-work-list">${lines.join('')}</div>`;
    }

    // VRAM the GPUs report beyond what the machine's Ollama models hold: another
    // program (an image render, a test) is using the card. Only from fresh readings.
    function vramOutsideOllamaMiB(machine) {
        if (machine.gpus.length === 0 || telemetryStale(machine.telemetry)) return 0;
        const used = machine.gpus.reduce((sum, gpu) => sum + (Number(gpu.vramUsed) || 0), 0);
        const ollama = machine.endpoints.filter(e => e.residency === 'gpu').reduce((sum, e) => sum + e.vramMiB, 0);
        const outside = used - ollama;
        return outside > 1536 ? outside : 0;
    }

    // The model each machine is pinned to serve. Core has one principal model
    // (agentx-primary) on one host; the other machines serve their own pins.
    function mainPinLine(machine) {
        const principal = window.NerveCenterModel?.state?.principal || null;
        const hostsPrincipal = Boolean(principal?.hostUrl) && addressOf(principal.hostUrl) === machine.address;
        if (hostsPrincipal) {
            const choice = (principal.options || []).find(option => option.value === principal.selected)?.label || principal.selected || '';
            return `<span class="nc-live-small nc-live-principal"><i class="fas fa-brain" aria-hidden="true"></i> Principal model${choice ? `: ${esc(choice)}` : ''}${principal.model ? ` · ${esc(shared.shortModel(principal.model))}` : ''}</span>`;
        }
        const main = machine.endpoints.find(e => e.id === machine.mainHostId) || machine.endpoints[0];
        const pin = main?.pins?.[0];
        return `<span class="nc-live-small nc-muted">${pin ? `Main pin: <span class="nc-live-mode">${esc(shared.shortModel(pin))}</span>` : 'No pin'}</span>`;
    }

    function machineCard(machine, work, now) {
        const issues = machineIssues(machine, work);
        const held = holdsWork(work);
        const reachable = machine.endpoints.some(e => e.state === 'up');
        const badge = !reachable ? '<span class="nc-live-chip danger">down</span>'
            : issues.length ? `<span class="nc-live-chip warn">${issues.length} to check</span>`
                : held ? '<span class="nc-live-chip warn">busy</span>'
                    : '<span class="nc-live-chip ok">ok</span>';
        const telemetry = machine.telemetry?.sampledAt
            ? `<span class="nc-muted nc-live-small" title="GPU collector sample">read ${esc(shared.timeAgo(machine.telemetry.sampledAt))}</span>` : '';
        const gpus = machine.gpus.length > 0
            ? machine.gpus.map(gpuRow).join('')
            : '<div class="nc-muted nc-live-small">No GPU readings</div>';
        const modeState = machine.mode?.switching ? ' · switching' : (machine.mode && !machine.mode.settled ? ' · not fully running' : '');
        const mode = machine.mode
            ? `<span class="nc-live-small nc-muted">Mode: <span class="nc-live-mode">${esc(machine.mode.label)}</span>${esc(modeState)}</span>` : '';
        const mainPin = mainPinLine(machine);
        const charts = window.NerveCenterLiveCharts;
        const power = charts
            ? `<div class="nc-live-col nc-live-power">${charts.gauges(machine)}<div data-power-chart="${esc(machine.address)}"></div></div>` : '';
        return `<article class="nc-live-card" data-machine="${esc(machine.address)}" aria-label="${esc(machine.name)}">
            <header class="nc-live-card-head">
                <div class="nc-live-card-title"><h3>${esc(machine.name)}</h3>${mainPin}${mode}${telemetry}</div>
                ${badge}
            </header>
            <div class="nc-live-card-body">
                ${power}
                <div class="nc-live-col">
                    <div class="nc-live-gpus">${gpus}${vramOutsideOllamaMiB(machine)
                        ? `<div class="nc-muted nc-live-small" title="GPU memory in use that the Ollama models here do not account for">About ${gib(vramOutsideOllamaMiB(machine))} GiB used outside Ollama (another program)</div>` : ''}</div>
                    <div class="nc-live-endpoints">${machine.endpoints.map(e => endpointBlock(e, machine, held)).join('')}</div>
                </div>
                <div class="nc-live-col nc-live-card-foot">
                    <div class="nc-live-col-title">Work holding it</div>
                    ${workBlock(work, now)}
                    <button type="button" class="nc-link-btn nc-live-manage" data-host="${esc(machine.mainHostId)}">Manage pins <i class="fas fa-chevron-right" aria-hidden="true"></i></button>
                </div>
            </div>
            <div class="nc-live-model-slot" data-model-slot="${esc(machine.address)}"></div>
        </article>`;
    }

    function machineNameFor(url, machines) {
        const address = addressOf(url);
        return machines.find(m => m.address === address)?.name || address || url;
    }

    function queueCard(jobs, claims, machines, now, queueAvailable) {
        if (!queueAvailable) {
            return '<section class="nc-live-queue"><h3>Heavy-work queue</h3><div class="nc-muted nc-live-small">The queue could not be read.</div></section>';
        }
        const open = openJobs(jobs).map(job => ({ job, phase: jobPhase(job, now) }));
        const timed = open.filter(e => ['running', 'uncertain', 'open'].includes(e.phase)
            || (e.phase === 'upcoming' && Date.parse(e.job.reservation.start) - now < DAY_MS))
            .sort((a, b) => (Date.parse(a.job.reservation?.start) || 0) - (Date.parse(b.job.reservation?.start) || 0));
        const waiting = open.filter(e => e.phase === 'waiting').length;
        const later = open.filter(e => e.phase === 'upcoming').length - timed.filter(e => e.phase === 'upcoming').length;
        const rows = timed.map(({ job, phase }) => {
            const hostNames = [...new Set((job.hosts || []).map(url => machineNameFor(url, machines)))].join(', ');
            const end = job.reservation?.end ? `–${clockTime(job.reservation.end)}` : '';
            const label = phase === 'open' ? 'Slot open' : phase === 'uncertain' ? 'Uncertain' : 'Running';
            const when = phase === 'upcoming' ? `${dayAndTime(job.reservation.start, now)}${end}`
                : `${label}${job.reservation?.end ? ` →${clockTime(job.reservation.end)}` : ''}`;
            return `<li class="${phase === 'upcoming' ? '' : 'now'}">
                <span class="nc-live-queue-when">${esc(when)}</span>
                <span class="nc-live-queue-title" title="${esc(job.title)}">${esc(job.title)}</span>
                <span class="nc-muted nc-live-small">${esc(hostNames)}</span>
            </li>`;
        }).join('');
        const claimLine = Array.isArray(claims) && claims.length > 0
            ? `${claims.length} Benchmark claim${claims.length === 1 ? '' : 's'} active`
            : 'No Benchmark claim';
        const extra = [waiting ? `${waiting} waiting for a slot` : '', later > 0 ? `${later} later` : '', claimLine].filter(Boolean).join(' · ');
        return `<section class="nc-live-queue" aria-labelledby="ncLiveQueueTitle">
            <div class="nc-live-queue-head">
                <h3 id="ncLiveQueueTitle">Heavy-work queue · next 24 h</h3>
                <a class="nc-link-btn" href="/automations?view=calendar">Open calendar <i class="fas fa-arrow-right" aria-hidden="true"></i></a>
            </div>
            ${rows ? `<ul class="nc-live-queue-list">${rows}</ul>` : '<div class="nc-muted nc-live-small">Nothing reserved in the next 24 hours.</div>'}
            <div class="nc-muted nc-live-small">${esc(extra)}</div>
        </section>`;
    }

    function renderStatusLine(summary, observedAt) {
        const line = document.getElementById('ncStatusLine');
        if (!line) return;
        const headline = summary.tone === 'nominal'
            ? `${summary.up}/${summary.total} machines up · everything runs as expected`
            : `${summary.up}/${summary.total} machines up · ${summary.issues.length} to check`;
        line.className = `nc-status-line ${summary.tone}`;
        line.innerHTML = `<span class="nc-status-headline"><i class="fas ${summary.tone === 'nominal' ? 'fa-circle-check' : 'fa-triangle-exclamation'}" aria-hidden="true"></i> ${esc(headline)}</span>
            ${summary.issues.length ? `<ul class="nc-status-issues">${summary.issues.slice(0, 6).map(issue => `<li>${esc(issue)}</li>`).join('')}</ul>` : ''}
            ${summary.held?.length ? `<ul class="nc-status-held">${summary.held.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
            <span class="nc-muted nc-live-small">Live · updated ${esc(clockTime(observedAt))}, every ${POLL_MS / 1000} s</span>`;
    }

    function openHostSettings(hostId) {
        const section = document.getElementById('sectionCluster');
        if (!section) return;
        const opening = section.classList.contains('collapsed');
        if (opening) window.NerveCenter?.toggleSection?.('sectionCluster');
        const card = hostId ? document.querySelector(`#sectionClusterBody .nc-host-card[data-host="${CSS.escape(hostId)}"]`) : null;
        const focusTarget = card?.querySelector('select, button') || section.querySelector('h2');
        if (focusTarget) {
            if (!focusTarget.matches('select, button')) focusTarget.tabIndex = -1;
            focusTarget.focus({ preventScroll: true });
        }
        // An opening section grows during its transition: scroll once it has its height.
        const scroll = () => (card || section).scrollIntoView({ behavior: shared.motionSafeScrollBehavior(), block: 'start' });
        if (opening) setTimeout(scroll, 350); else scroll();
    }

    let liveLoad = 0;

    async function loadLive({ quiet = false } = {}) {
        const body = document.getElementById('sectionLiveBody');
        if (!body) return;
        // Never pull the principal panel from under an operator using it.
        if (quiet && window.NerveCenterModel?.holdsFocus?.()) return;
        const load = ++liveLoad;
        if (!quiet) {
            window.NerveCenterModel?.detach?.();
            window.NerveCenterModel?.place?.();
            shared.renderSectionLoading(body, 'Reading the machines...');
        }
        try {
            const [hostsJson, prefsJson, gpuJson, topologyJson, queueJson, healthJson] = await Promise.all([
                shared.fetchJson('/api/ollama-hosts'),
                shared.fetchJson('/api/nerve-center/host-preferences').catch(() => ({ data: [] })),
                shared.fetchJson('/api/nerve-center/inference/gpu-status').catch(() => ({ data: [] })),
                shared.fetchJson('/api/nerve-center/runtime-topology').catch(() => null),
                shared.fetchJson('/api/cluster/schedule/heavy-queue').catch(() => null),
                shared.fetchJson('/api/nerve-center/inference-health').catch(() => null)
            ]);
            if (load !== liveLoad) return;
            const now = Date.now();
            const machines = groupMachines({
                hosts: hostsJson?.data?.hosts || [],
                prefs: prefsJson?.data || [],
                gpuRows: Array.isArray(gpuJson?.data) ? gpuJson.data : [],
                topology: topologyJson?.status === 'success' ? topologyJson.data : null
            });
            const queue = queueJson?.data;
            const jobs = queue?.available === false ? [] : (queue?.jobs || []);
            const claims = (healthJson?.data || healthJson)?.benchmarkClaims || [];
            if (machines.length === 0) {
                body.innerHTML = '<div class="nc-section-placeholder nc-muted">No inference host is registered.</div>';
                return;
            }
            const works = machines.map(m => machineWork(m, jobs, claims, now));
            const charts = window.NerveCenterLiveCharts;
            const model = window.NerveCenterModel;
            if (model?.holdsFocus?.()) return;
            model?.detach?.();
            body.innerHTML = `<div class="nc-live-grid">${machines.map((m, index) => machineCard(m, works[index], now)).join('')}</div>
                <div class="nc-live-pair">
                    ${queueCard(jobs, claims, machines, now, Boolean(queue) && queue.available !== false)}
                    ${charts ? '<section class="nc-live-queue nc-live-requests" id="ncLiveRequests" aria-labelledby="ncLiveRequestsTitle" aria-live="off"></section>' : ''}
                </div>`;
            body.querySelectorAll('.nc-live-manage').forEach(button => {
                button.addEventListener('click', () => openHostSettings(button.dataset.host));
            });
            model?.place?.();
            charts?.attach?.({ machines, jobs, machineNameFor });
            renderStatusLine(statusSummary(machines, works), now);
        } catch (err) {
            if (load !== liveLoad) return;
            console.error('[NerveCenter] loadLive failed', err);
            shared.renderSectionError(body, `Could not read the machines: ${err.message}`);
            const line = document.getElementById('ncStatusLine');
            if (line) {
                line.className = 'nc-status-line critical';
                line.textContent = 'Live machine state is unavailable.';
            }
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    let poller = null;
    function startLive() {
        loadLive();
        window.NerveCenterLiveCharts?.start?.();
        if (poller || typeof setInterval !== 'function') return;
        poller = setInterval(() => {
            if (document.hidden) return;
            loadLive({ quiet: true });
        }, POLL_MS);
    }

    window.NerveCenterLive = {
        loadLive, startLive, groupMachines, parkedUrls, machineWork, machineIssues, statusSummary, jobPhase, endpointLabel, vramOutsideOllamaMiB,
        renderMachineCard: machineCard, mainPinLine
    };
})();
