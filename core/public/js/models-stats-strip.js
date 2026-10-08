/**
 * Models Unified — Stats Strip
 *
 * Renders the four inventory cards above the model library: active tags,
 * storage on disk, runtime hosts and benchmark coverage. Depends on globals
 * defined in models-unified.js (loaded first): escapeHtml, scoreColor,
 * CAT_COLORS. The UnifiedModels instance is passed as `self`.
 *
 * The ids statTotal, statStorage and statHosts keep a plain leading number:
 * models-experience.js reads them for the readiness banner.
 */

const STRIP_HOST_COLORS = ['#7cf0ff', '#eeb0ff', '#fb923c', '#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#94a3b8'];

function stripSetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function stripSetHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function stripPlural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Hostname of an endpoint URL; two endpoints on one machine share it. */
function stripMachineOf(url) {
    try { return new URL(url).hostname || url; } catch { return url || 'unknown'; }
}

/**
 * Bytes actually on disk. Two Ollama endpoints on the same machine (e.g. a
 * GPU and a CPU instance on different ports) serve the same blobs, so a
 * digest present on one machine is counted once. Without a digest the
 * install is counted as-is.
 */
function stripDiskUsage(models) {
    const seen = new Set();
    const byMachine = new Map();
    let raw = 0;
    let disk = 0;
    for (const m of models) {
        const size = Number(m.size) || 0;
        raw += size;
        const machine = m.provider === 'ollama' ? stripMachineOf(m.source?.url) : m.provider || 'other';
        const digest = m.source?.metadata?.digest;
        const key = digest ? `${machine}|${digest}` : null;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        disk += size;
        if (!byMachine.has(machine)) byMachine.set(machine, { bytes: 0, names: new Set() });
        const entry = byMachine.get(machine);
        entry.bytes += size;
        entry.names.add(m.source?.hostName || machine);
    }
    const machines = [...byMachine.entries()]
        .filter(([, v]) => v.bytes > 0)
        .map(([machine, v]) => ({ machine, bytes: v.bytes, label: [...v.names].sort((a, b) => a.length - b.length)[0] }))
        .sort((a, b) => b.bytes - a.bytes);
    return { raw, disk, machines };
}

function stripSegments(parts, total) {
    if (!total) return '<span class="strip-bar-empty"></span>';
    return parts.map(p => `<span class="strip-seg" style="flex:${p.value} 1 0; background:${p.color}" title="${escapeHtml(p.title)}"></span>`).join('');
}

function stripLegend(parts, format) {
    return parts.map(p => `<span class="strip-legend-item"><i style="background:${p.color}"></i>${escapeHtml(p.label)} <b>${escapeHtml(format(p.value))}</b></span>`).join('');
}

function renderModelsCard(self, active, gone) {
    const activeLogical = self.uniqueLogicalModels(active);
    const goneLogical = self.uniqueLogicalModels(gone);
    const ollama = active.filter(m => m.provider === 'ollama');
    const hostCount = new Set(ollama.map(m => m.source?.url).filter(Boolean)).size;
    const custom = activeLogical.filter(m => m.provider === 'custom').length;

    stripSetText('statTotal', String(activeLogical.length));
    stripSetText('statTotalSub', `${stripPlural(ollama.length, 'install')} on ${stripPlural(hostCount, 'host')}`);

    const chips = [];
    if (custom) chips.push(`<span class="strip-chip">${custom} custom</span>`);
    if (goneLogical.length) chips.push(`<span class="strip-chip is-muted" title="Tags no longer installed on any host; their history is kept"><i class="fas fa-ghost"></i> ${goneLogical.length} retired</span>`);
    stripSetHtml('statTotalChips', chips.join(''));

    const byCat = new Map();
    for (const m of activeLogical) {
        const cat = String(m.categories?.[0] || 'uncategorized').toLowerCase();
        byCat.set(cat, (byCat.get(cat) || 0) + 1);
    }
    const parts = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([cat, value]) => ({
        label: cat, value, title: `${cat}: ${value}`,
        color: CAT_COLORS[cat]?.border || 'rgba(148,163,184,0.45)',
    }));
    stripSetHtml('statTotalBar', stripSegments(parts, activeLogical.length));
    stripSetHtml('statTotalLegend', stripLegend(parts.slice(0, 3), String));
}

function renderStorageCard(self, active) {
    const { raw, disk, machines } = stripDiskUsage(active);
    stripSetText('statStorage', self.formatBytes(disk));
    const shared = raw - disk;
    stripSetText('statStorageSub', shared > 0
        ? `${self.formatBytes(raw)} listed by endpoints · shared files counted once`
        : stripPlural(machines.length, 'machine'));
    const parts = machines.map((m, i) => ({
        label: m.label, value: m.bytes, title: `${m.label} (${m.machine}): ${self.formatBytes(m.bytes)}`,
        color: STRIP_HOST_COLORS[i % STRIP_HOST_COLORS.length],
    }));
    stripSetHtml('statStorageBar', stripSegments(parts, disk));
    stripSetHtml('statStorageLegend', stripLegend(parts.slice(0, 3), v => self.formatBytes(v, true)));
}

function renderHostsCard(self) {
    const hosts = self.getHostSummaries().filter(h => h.url);
    const s = self.sources || {};
    const customCount = Number(s?.custom?.count || 0) || self.getActiveModels().filter(m => m?.provider === 'custom').length;
    const live = self.loadedModels.size > 0;
    const online = hosts.filter(h => h.status === 'online').length;
    const loaded = hosts.reduce((n, h) => n + h.loadedModels.length, 0);

    stripSetText('statHosts', String(hosts.length));
    const badge = document.getElementById('statHostsOnline');
    if (badge) {
        badge.hidden = !live;
        badge.className = `strip-status ${online === hosts.length ? 'is-ok' : online ? 'is-warn' : 'is-down'}`;
        badge.textContent = `${online} online`;
    }
    const parts = [];
    parts.push(live ? `${stripPlural(loaded, 'model')} in memory` : 'Live state unavailable');
    if (customCount) parts.push(`${customCount} custom provider${customCount === 1 ? '' : 's'}`);
    stripSetText('statHostsSub', parts.join(' · '));

    stripSetHtml('statHostsList', hosts.map(h => {
        const title = `${h.name}: ${h.status} · ${stripPlural(h.models.length, 'model')}${h.loadedModels.length ? ` · ${h.loadedModels.length} loaded` : ''}`;
        return `<span class="strip-host is-${h.status}" title="${escapeHtml(title)}"><i></i>${escapeHtml(h.name)}<b>${h.models.length}</b></span>`;
    }).join(''));
}

function renderBenchmarkCard(self, active) {
    const activeLogical = self.uniqueLogicalModels(active);
    const benchmarked = self.uniqueLogicalModels(self.allModels.filter(m => m.benchmarkStats?.avgCompositeScore > 0));
    const activeKeys = new Set(activeLogical.map(m => `${m.provider}:${String(m.name).toLowerCase().replace(/:latest$/, '')}`));
    const covered = benchmarked.filter(m => activeKeys.has(`${m.provider}:${String(m.name).toLowerCase().replace(/:latest$/, '')}`)).length;
    const pct = activeLogical.length ? Math.round(covered / activeLogical.length * 100) : 0;

    stripSetText('statBenchmarked', String(covered));
    stripSetText('statBenchmarkedOf', `/ ${activeLogical.length}`);
    stripSetHtml('statBenchmarkBar', `<span class="strip-seg" style="flex:0 0 ${pct}%; background:var(--accent)"></span>`);

    if (!benchmarked.length) {
        stripSetHtml('statAvgScore', 'No benchmark evidence yet');
        return;
    }
    const avg = benchmarked.reduce((n, m) => n + m.benchmarkStats.avgCompositeScore, 0) / benchmarked.length;
    const best = benchmarked.reduce((a, b) => (b.benchmarkStats.avgCompositeScore > a.benchmarkStats.avgCompositeScore ? b : a));
    const retired = benchmarked.length - covered;
    stripSetHtml('statAvgScore', [
        `${pct}% of active tags`,
        `avg <b style="color:${scoreColor(avg)}">${avg.toFixed(1)}</b>`,
        retired ? `${retired} retired` : '',
    ].filter(Boolean).join(' · '));
    stripSetHtml('statBenchmarkBest', `<i class="fas fa-trophy"></i> ${escapeHtml(best.name)} <b style="color:${scoreColor(best.benchmarkStats.avgCompositeScore)}">${best.benchmarkStats.avgCompositeScore.toFixed(1)}</b>`);
}

function renderStatsStrip(self) {
    const active = self.getActiveModels();
    const gone = self.getGoneModels();
    renderModelsCard(self, active, gone);
    renderStorageCard(self, active);
    renderHostsCard(self);
    renderBenchmarkCard(self, active);
}
