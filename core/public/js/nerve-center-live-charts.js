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
            <div class="nc-power-head"><span>Power</span>${legend}</div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Power history of ${esc(machine.name)} over the last ${WINDOW_MINUTES} minutes">
                <line class="nc-power-grid" x1="0" y1="${y(50)}" x2="${W}" y2="${y(50)}"/>
                <line class="nc-power-grid" x1="0" y1="${y(100) + 0.5}" x2="${W}" y2="${y(100) + 0.5}"/>
                ${lines}
            </svg>
            <div class="nc-power-axis"><span>−${WINDOW_MINUTES} min</span><span>dashed line: 50 % of limit</span><span>now</span></div>
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

    function clock(ms) {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    // Failure reasons are Core's stable codes; the common ones in plain words.
    const REASON_WORDS = Object.freeze({
        upstream_timeout: 'timed out',
        upstream_error: 'model server error',
        connection_failure: 'could not connect',
        connection_unavailable: 'machine unreachable',
        provider_rejected: 'rejected by the provider',
        provider_temporarily_unavailable: 'provider unavailable',
        response_processing_error: 'reply could not be read',
        workload_reserved: 'machine reserved for heavy work',
        maintenance_active: 'machine in maintenance',
        inference_active: 'machine busy',
        benchmark_claim_active: 'machine held by Benchmark',
        topology_switch_in_progress: 'mode switch in progress',
        lane_context_exceeded: 'prompt too long for the lane',
        unclassified_error: 'error (not classified)'
    });
    function reasonText(code, status) {
        if (code && REASON_WORDS[code]) return REASON_WORDS[code];
        if (code) return String(code).replace(/_/g, ' ');
        return status === 'timeout' ? 'timed out' : 'failed';
    }

    function durationShort(ms) {
        const n = num(ms);
        if (n == null || n <= 0) return '';
        return n < 1000 ? `${Math.round(n)} ms` : n < 60000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s` : ageText(n);
    }

    // The whole minutes the chart draws: the partial oldest minute is left out.
    function chartMinutes(windowMinutes, now) {
        const minutes = [];
        const from = now - windowMinutes * 60000;
        for (let m = Math.floor(from / 60000) + 1; m <= Math.floor(now / 60000); m++) minutes.push(m);
        return minutes;
    }

    // Selected minute and its requests, kept across the 10 s repaint.
    let minuteDetail = null;

    function activityChart(recent, heavyBands, now) {
        const W = 300; const H = 72; const TOP = 4;
        const from = now - recent.windowMinutes * 60000;
        const counts = new Map((recent.perMinute || []).map(row => [Math.floor(Date.parse(row.t) / 60000), row]));
        const minutes = chartMinutes(recent.windowMinutes, now);
        const peak = Math.max(0, ...minutes.map(m => counts.get(m)?.n || 0));
        const max = Math.max(1, peak);
        const failedTotal = minutes.reduce((sum, m) => sum + Math.min(counts.get(m)?.n || 0, counts.get(m)?.failed || 0), 0);
        const okTotal = minutes.reduce((sum, m) => sum + (counts.get(m)?.n || 0), 0) - failedTotal;
        const bw = W / Math.max(1, minutes.length);
        const y = n => H - (n / max) * (H - TOP);
        const selected = minuteDetail ? Math.floor(minuteDetail.minute / 60000) : null;
        const bars = minutes.map((m, i) => {
            const row = counts.get(m);
            const n = row?.n || 0;
            const failed = Math.min(n, row?.failed || 0);
            const ok = n - failed;
            const x = (i * bw + 1).toFixed(1);
            const w = Math.max(1, bw - 2).toFixed(1);
            const okTop = y(ok);
            const parts = [];
            if (ok > 0) parts.push(`<rect class="nc-activity-bar" x="${x}" y="${okTop.toFixed(1)}" width="${w}" height="${(H - okTop).toFixed(1)}"/>`);
            if (failed > 0) {
                // A small surface gap between the ok and failed segments.
                const top = y(n);
                const bottom = ok > 0 ? okTop - 1 : H;
                parts.push(`<rect class="nc-activity-bar failed" x="${x}" y="${top.toFixed(1)}" width="${w}" height="${Math.max(1, bottom - top).toFixed(1)}"/>`);
            }
            const label = `${clock(m * 60000)}: ${n} request${n === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`;
            return `<g class="nc-activity-minute${selected === m ? ' selected' : ''}">
                <rect class="nc-activity-hit" data-minute="${m * 60000}" x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" tabindex="0" role="button" aria-label="${esc(label)}"><title>${esc(label)}</title></rect>
                ${parts.join('')}</g>`;
        }).join('');
        const xAt = t => ((Math.min(Math.max(t, from), now) - from) / (now - from)) * W;
        // Overlapping heavy-work periods merge into one band, so the shade stays even.
        const merged = [];
        heavyBands.map(band => ({ start: Math.max(band.start, from), end: Math.min(band.end, now), titles: [band.title] }))
            .filter(band => band.end > band.start)
            .sort((a, b) => a.start - b.start)
            .forEach(band => {
                const last = merged[merged.length - 1];
                if (last && band.start <= last.end) { last.end = Math.max(last.end, band.end); last.titles.push(...band.titles); }
                else merged.push(band);
            });
        const bands = merged.map(band => ({ ...band, title: band.titles.join(' · ') })).map(band => `<rect class="nc-activity-heavy" x="${xAt(band.start).toFixed(1)}" y="0" width="${Math.max(1, xAt(band.end) - xAt(band.start)).toFixed(1)}" height="${H}"><title>Heavy work: ${esc(band.title)}</title></rect>`).join('');
        const ticks = minutes.map((m, i) => (m % 5 === 0
            ? `<span style="left:${(((i + 0.5) * bw) / W * 100).toFixed(1)}%">${esc(clock(m * 60000))}</span>` : '')).join('');
        const legend = `<span class="nc-activity-legend">
                <span><i class="ok"></i>ok ${okTotal}</span>
                <span><i class="failed"></i>failed ${failedTotal}</span>
                ${heavyBands.length ? '<span><i class="heavy"></i>heavy work running</span>' : ''}
            </span>`;
        return `<div class="nc-activity">
            <div class="nc-power-head"><span class="nc-activity-title">Requests per minute</span>${legend}</div>
            <div class="nc-activity-plot">
                <div class="nc-activity-scale" aria-hidden="true"><span>${peak}</span><span>0</span></div>
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="group" aria-label="${okTotal + failedTotal} requests in the last ${recent.windowMinutes} minutes, ${failedTotal} failed. Each bar is one minute; select one for its requests.">
                    <line class="nc-activity-grid" x1="0" y1="${y(max).toFixed(1)}" x2="${W}" y2="${y(max).toFixed(1)}"/>
                    ${bands}${bars}
                </svg>
            </div>
            <div class="nc-activity-ticks" aria-hidden="true">${ticks}</div>
            ${minuteDetail ? minutePanel(minuteDetail, recent) : '<div class="nc-muted nc-live-small">Tap a bar to see that minute’s requests.</div>'}
        </div>`;
    }

    function minutePanel(detail, ctx) {
        const head = `<div class="nc-minute-head">
                <strong>${esc(clock(detail.minute))}</strong>
                <span class="nc-muted">${detail.state === 'ok' ? `${detail.data.total} request${detail.data.total === 1 ? '' : 's'}${detail.failed ? ` · ${detail.failed} failed` : ''}` : ''}</span>
                <button type="button" class="nc-link-btn" data-minute-close>Close</button>
            </div>`;
        if (detail.state === 'loading') return `<div class="nc-minute">${head}<div class="nc-muted nc-live-small">Reading that minute...</div></div>`;
        if (detail.state === 'error') return `<div class="nc-minute">${head}<div class="nc-muted nc-live-small">The requests of that minute could not be read.</div></div>`;
        const machineName = ctx?.machineNameFor ? url => ctx.machineNameFor(url, ctx.machines || []) : url => url;
        const rows = detail.data.requests.map(item => {
            const ok = item.status === 'success';
            return `<li class="${ok ? '' : 'failed'}">
                <span class="nc-live-queue-title" title="${esc(item.caller)}${item.model ? ` · ${esc(item.model)}` : ''}">${esc(callerName(item.caller))}${item.host ? ` <span class="nc-muted">→ ${esc(machineName(item.host))}</span>` : ''}</span>
                <span class="nc-muted">${esc(durationShort(item.durationMs))}</span>
                <span class="nc-live-chip ${ok ? 'ok' : 'danger'}">${ok ? 'ok' : esc(reasonText(item.reason, item.status))}</span>
            </li>`;
        }).join('');
        const more = detail.data.truncated ? `<div class="nc-muted nc-live-small">First ${detail.data.requests.length} of ${detail.data.total}.</div>` : '';
        return `<div class="nc-minute">${head}${rows ? `<ul class="nc-live-queue-list nc-minute-list">${rows}</ul>` : '<div class="nc-muted nc-live-small">No request recorded in that minute.</div>'}${more}</div>`;
    }

    async function selectMinute(minute) {
        if (minuteDetail?.minute === minute) { minuteDetail = null; paint(); return; }
        minuteDetail = { minute, state: 'loading' };
        paint();
        try {
            const json = await shared.fetchJson(`/api/nerve-center/live-activity/minute?at=${encodeURIComponent(new Date(minute).toISOString())}`);
            if (minuteDetail?.minute !== minute) return;
            const data = json?.data || { total: 0, requests: [] };
            minuteDetail = { minute, state: 'ok', data, failed: data.requests.filter(item => item.status !== 'success').length };
        } catch (_) {
            if (minuteDetail?.minute !== minute) return;
            minuteDetail = { minute, state: 'error' };
        }
        paint();
    }

    function bindChart(card) {
        card.querySelectorAll?.('[data-minute]').forEach(el => {
            const pick = () => selectMinute(Number(el.dataset.minute));
            el.addEventListener('click', pick);
            el.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
            });
        });
        card.querySelector?.('[data-minute-close]')?.addEventListener('click', () => { minuteDetail = null; paint(); });
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
                <h3 id="ncLiveRequestsTitle">Live requests</h3>
                <span class="nc-muted nc-live-small">${count}</span>
            </div>`;
        if (!requests?.ok) {
            return `${head('')}<div class="nc-muted nc-live-small">Core's request register could not be read.</div>`;
        }
        const active = requests.data.active || [];
        const work = active.filter(item => !item.maintenance);
        const upkeep = active.filter(item => item.maintenance);
        // Same minutes as the chart's bars, so the header and the legend agree.
        const total = recent?.ok ? chartMinutes(recent.data.windowMinutes, now)
            .reduce((sum, m) => sum + (recent.data.perMinute || []).filter(row => Math.floor(Date.parse(row.t) / 60000) === m)
                .reduce((n, row) => n + (row.n || 0), 0), 0) : null;
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
        const chart = recent?.ok ? activityChart({ ...recent.data, machines, machineNameFor }, heavyBands(jobs, now), now)
            : '<div class="nc-muted nc-live-small">Recent activity unknown.</div>';
        return `${head(count)}
            ${rows ? `<ul class="nc-live-queue-list">${rows}</ul>` : '<div class="nc-muted nc-live-small nc-live-idle">Nothing running through Core right now.</div>'}
            ${heavy}${maintenance}
            ${chart}
            ${callers}
            <a class="nc-link-btn nc-live-small" href="/analytics">Full history <i class="fas fa-arrow-right" aria-hidden="true"></i></a>`;
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
        if (!card) return;
        // Keep keyboard focus on the same bar across the repaint.
        const focused = document.activeElement?.dataset?.minute || null;
        card.innerHTML = requestsCard(lastActivity, { ...ctx, now });
        bindChart(card);
        if (focused) card.querySelector?.(`[data-minute="${focused}"]`)?.focus?.({ preventScroll: true });
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
        powerPct, powerTone, runs, callerName, ageText, reasonText, selectMinute,
        _resetMinute: () => { minuteDetail = null; }
    };
})();
