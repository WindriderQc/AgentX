/**
 * Nerve Center — live charts.
 *
 * Power gauges (percent of each GPU's own power limit), a sliding power history
 * per machine, and the live requests card: requests running through Core now
 * that are not heavy work, completed requests per minute, and the busiest
 * callers. Data: /api/nerve-center/live-activity (read-only), refreshed every
 * 10 s while the page is visible. A missing reading is shown as unknown, never 0.
 */
(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    const POLL_MS = 10000;
    const WINDOW_MINUTES = 15;
    const GAP_MS = 95000; // three missed 30 s samples break the line
    const SERIES_CLASSES = ['s0', 's1', 's2', 's3'];

    function esc(value) { return shared.escapeHtml(String(value ?? '')); }
    function num(value) { const n = Number(value); return value != null && value !== '' && Number.isFinite(n) ? n : null; }

    function powerPct(draw, limit) {
        const w = num(draw);
        const l = num(limit);
        if (w == null || l == null || l <= 0) return null;
        return Math.max(0, Math.min(100, (w / l) * 100));
    }

    function powerTone(pct) {
        if (pct == null) return 'unknown';
        if (pct >= 85) return 'hard';
        if (pct >= 20) return 'working';
        return 'idle';
    }

    const TONE_WORDS = { unknown: 'power unknown', idle: 'idle', working: 'working', hard: 'near its limit' };

    // Half-circle gauge, 0 % on the left, 100 % on the right.
    function gauge(gpu) {
        const pct = powerPct(gpu.powerDraw, gpu.powerLimit);
        const tone = powerTone(pct);
        const r = 38; const cx = 48; const cy = 46;
        const point = (v) => {
            const a = Math.PI * (1 - v);
            return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
        };
        const arc = (v0, v1, cls) => {
            const [x0, y0] = point(v0); const [x1, y1] = point(v1);
            return `<path class="${cls}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}"/>`;
        };
        const label = String(gpu.name || 'GPU').replace(/^NVIDIA GeForce /, '');
        const watts = pct == null ? 'power unknown'
            : `${Math.round(num(gpu.powerDraw))} / ${Math.round(num(gpu.powerLimit))} W`;
        let needle = '';
        let fill = '';
        if (pct != null) {
            const v = pct / 100;
            fill = arc(0, Math.max(v, 0.005), `nc-gauge-fill ${tone}`);
            const [nx, ny] = point(v);
            needle = `<line class="nc-gauge-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/><circle class="nc-gauge-hub" cx="${cx}" cy="${cy}" r="3"/>`;
        }
        const aria = pct == null ? `GPU ${gpu.index ?? ''} power unknown`
            : `GPU ${gpu.index ?? ''} power ${Math.round(pct)} percent of its limit, ${TONE_WORDS[tone]}`;
        return `<figure class="nc-gauge ${tone}">
            <svg viewBox="0 0 96 56" role="img" aria-label="${esc(aria)}">
                ${arc(0, 1, 'nc-gauge-track')}${fill}${needle}
            </svg>
            <figcaption>
                <span class="nc-gauge-value">${pct == null ? '—' : `${Math.round(pct)}%`}</span>
                <span class="nc-gauge-watts">${esc(watts)}</span>
                <span class="nc-gauge-label">GPU ${esc(gpu.index ?? '')} · ${esc(label)}</span>
            </figcaption>
        </figure>`;
    }

    function gauges(machine) {
        if (!machine.gpus.length) return '<div class="nc-muted nc-live-small">No GPU readings</div>';
        return `<div class="nc-gauges">${machine.gpus.map(gauge).join('')}</div>`;
    }

    // Split a series into drawable runs: a missing value or a long gap ends a run.
    function runs(series, from, to) {
        const out = [];
        let run = [];
        let lastT = null;
        series.forEach(point => {
            const t = Date.parse(point.t);
            if (!Number.isFinite(t) || t < from || t > to) return;
            const pct = powerPct(point.w, point.limit);
            if (pct == null || (lastT != null && t - lastT > GAP_MS)) {
                if (run.length) out.push(run);
                run = [];
            }
            if (pct != null) run.push({ t, pct });
            lastT = t;
        });
        if (run.length) out.push(run);
        return out;
    }

    function powerChart(machine, power, now) {
        const hostId = machine.telemetry?.collectorHostId;
        const host = hostId && power?.hosts ? power.hosts[hostId] : null;
        if (!host || host.error || !host.gpus) {
            return `<div class="nc-power-chart empty nc-muted nc-live-small">Power history unknown${host?.error ? ' (readings unavailable)' : ''}</div>`;
        }
        const W = 300; const H = 70; const from = now - WINDOW_MINUTES * 60000;
        const x = t => ((t - from) / (now - from)) * W;
        const y = pct => H - (pct / 100) * H;
        const indexes = Object.keys(host.gpus).map(Number).sort((a, b) => a - b);
        let drawn = 0;
        const lines = indexes.map((index, i) => runs(host.gpus[index], from, now).map(run => {
            drawn += run.length;
            if (run.length === 1) return `<circle class="nc-power-dot ${SERIES_CLASSES[i % 4]}" cx="${x(run[0].t).toFixed(1)}" cy="${y(run[0].pct).toFixed(1)}" r="1.8"/>`;
            return `<polyline class="nc-power-line ${SERIES_CLASSES[i % 4]}" points="${run.map(p => `${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')}"/>`;
        }).join('')).join('');
        const legend = indexes.length > 1
            ? `<span class="nc-power-legend">${indexes.map((index, i) => `<span class="${SERIES_CLASSES[i % 4]}">GPU ${index}</span>`).join('')}</span>` : '';
        return `<div class="nc-power-chart">
            <div class="nc-power-head"><span>Power · % of limit · last ${WINDOW_MINUTES} min</span>${legend}</div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Power history of ${esc(machine.name)} over the last ${WINDOW_MINUTES} minutes">
                <line class="nc-power-grid" x1="0" y1="${y(50)}" x2="${W}" y2="${y(50)}"/>
                <line class="nc-power-grid" x1="0" y1="${y(100) + 0.5}" x2="${W}" y2="${y(100) + 0.5}"/>
                ${lines}
            </svg>
            <div class="nc-power-axis"><span>−${WINDOW_MINUTES} min</span><span>dashed line: 50 %</span><span>now</span></div>
            ${drawn === 0 ? '<div class="nc-muted nc-live-small">No power reading in this window</div>' : ''}
        </div>`;
    }

    // Caller labels are contract names; drop the generic gateway prefixes.
    function callerName(label) {
        return String(label || 'Unknown caller').replace(/^(llm-gateway|agentx-household)\//, '');
    }

    function ageText(ms) {
        if (ms == null) return '--';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s} s`;
        const m = Math.floor(s / 60);
        return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
    }

    function activityChart(recent, heavyBands, now) {
        const W = 300; const H = 64;
        const from = now - recent.windowMinutes * 60000;
        const counts = new Map((recent.perMinute || []).map(row => [Math.floor(Date.parse(row.t) / 60000), row]));
        const minutes = [];
        for (let m = Math.floor(from / 60000) + 1; m <= Math.floor(now / 60000); m++) minutes.push(m);
        const max = Math.max(1, ...minutes.map(m => counts.get(m)?.n || 0));
        const bw = W / Math.max(1, minutes.length);
        const bars = minutes.map((m, i) => {
            const row = counts.get(m);
            const n = row?.n || 0;
            const h = (n / max) * (H - 4);
            const failed = row?.failed ? ` (${row.failed} failed)` : '';
            return `<rect class="nc-activity-bar${row?.failed ? ' failed' : ''}" x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${n} request${n === 1 ? '' : 's'}${failed}</title></rect>`;
        }).join('');
        const x = t => ((Math.min(Math.max(t, from), now) - from) / (now - from)) * W;
        const bands = heavyBands.map(band => `<rect class="nc-activity-heavy" x="${x(band.start).toFixed(1)}" y="0" width="${Math.max(1, x(band.end) - x(band.start)).toFixed(1)}" height="${H}"><title>Heavy work: ${esc(band.title)}</title></rect>`).join('');
        return `<div class="nc-activity">
            <div class="nc-power-head"><span>Requests per minute · last ${recent.windowMinutes} min (peak ${max})</span>
                ${heavyBands.length ? '<span class="nc-activity-key"><span class="heavy"></span>heavy work running</span>' : ''}</div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${recent.total} requests completed in the last ${recent.windowMinutes} minutes">${bands}${bars}</svg>
            <div class="nc-power-axis"><span>−${recent.windowMinutes} min</span><span>now</span></div>
        </div>`;
    }

    // Heavy-work jobs running now, drawn from their start (or the window start) to now.
    function heavyBands(jobs, now) {
        return (Array.isArray(jobs) ? jobs : []).filter(job => ['dispatching', 'running', 'uncertain'].includes(job.state)
            || (job.state === 'reserved' && Date.parse(job.reservation?.start) <= now && Date.parse(job.reservation?.end) > now))
            .map(job => ({ start: Date.parse(job.reservation?.start) || now - 60000, end: now, title: job.title || 'reserved work' }));
    }

    function requestsCard(activity, ctx) {
        const { machines = [], machineNameFor, jobs = [], now = Date.now() } = ctx || {};
        if (!activity) {
            return '<div class="nc-muted nc-live-small">Reading live requests...</div>';
        }
        const requests = activity.requests;
        const recent = activity.recent;
        const head = (count) => `<div class="nc-live-queue-head">
                <h3 id="ncLiveRequestsTitle">Live requests · not heavy work</h3>
                <span class="nc-muted nc-live-small">${count}</span>
            </div>`;
        if (!requests?.ok) {
            return `${head('')}<div class="nc-muted nc-live-small">Core's request register could not be read.</div>`;
        }
        const active = requests.data.active || [];
        const work = active.filter(item => !item.maintenance);
        const upkeep = active.filter(item => item.maintenance);
        const total = recent?.ok ? recent.data.total : null;
        const count = `${work.length} now${total != null ? ` · ${total} in ${recent.data.windowMinutes} min` : ''}`;
        const rows = work.map(item => `<li class="now">
                <span class="nc-live-queue-when">${esc(ageText(item.ageMs))}</span>
                <span class="nc-live-queue-title" title="${esc(item.label)}${item.model ? ` · ${esc(item.model)}` : ''}">${esc(callerName(item.label))} <span class="nc-muted">→ ${esc(machineNameFor ? machineNameFor(item.host, machines) : item.host)}</span></span>
                <span class="nc-live-chip ${item.state === 'UNKNOWN' ? 'warn' : 'ok'}">${item.state === 'UNKNOWN' ? 'uncertain' : item.stream ? 'streaming' : 'running'}</span>
            </li>`).join('');
        const heavy = requests.data.heavyWorkInFlight
            ? `<div class="nc-muted nc-live-small">Heavy work also has ${requests.data.heavyWorkInFlight} request${requests.data.heavyWorkInFlight === 1 ? '' : 's'} in flight (not listed).</div>` : '';
        const maintenance = upkeep.length
            ? `<div class="nc-muted nc-live-small">Core upkeep: ${upkeep.map(item => esc(callerName(item.label))).join(', ')}</div>` : '';
        const callers = recent?.ok && recent.data.byCaller.length
            ? `<div class="nc-activity-callers nc-live-small"><span class="nc-muted">Busiest callers:</span> ${recent.data.byCaller.map(row => `<span>${esc(callerName(row.label))} <strong>${row.n}</strong></span>`).join('')}</div>` : '';
        const chart = recent?.ok ? activityChart(recent.data, heavyBands(jobs, now), now)
            : '<div class="nc-muted nc-live-small">Recent activity unknown.</div>';
        return `${head(count)}
            ${rows ? `<ul class="nc-live-queue-list">${rows}</ul>` : '<div class="nc-muted nc-live-small nc-live-idle">Nothing running through Core right now.</div>'}
            ${heavy}${maintenance}
            ${chart}
            ${callers}`;
    }

    // Last data and context, so a machine re-render can redraw at once.
    let lastActivity = null;
    let lastContext = null;
    let load = 0;

    function paint() {
        const ctx = lastContext;
        if (!ctx) return;
        const now = Date.now();
        (ctx.machines || []).forEach(machine => {
            const slot = document.querySelector(`[data-power-chart="${CSS.escape(machine.address)}"]`);
            if (slot) slot.innerHTML = powerChart(machine, lastActivity?.power?.ok ? lastActivity.power.data : null, now);
        });
        const card = document.getElementById('ncLiveRequests');
        if (card) card.innerHTML = requestsCard(lastActivity, { ...ctx, now });
    }

    async function refresh() {
        const mine = ++load;
        try {
            const json = await shared.fetchJson(`/api/nerve-center/live-activity?minutes=${WINDOW_MINUTES}`);
            if (mine !== load) return;
            lastActivity = json?.data || null;
        } catch (err) {
            if (mine !== load) return;
            lastActivity = { requests: { ok: false }, recent: { ok: false }, power: { ok: false } };
        }
        paint();
    }

    // Called by the live view after each render with its machines and jobs.
    function attach(context) {
        lastContext = context;
        paint();
    }

    let poller = null;
    function start() {
        refresh();
        if (poller || typeof setInterval !== 'function') return;
        poller = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    }

    window.NerveCenterLiveCharts = {
        start, refresh, attach, gauge, gauges, powerChart, requestsCard, activityChart, heavyBands,
        powerPct, powerTone, runs, callerName, ageText
    };
})();
