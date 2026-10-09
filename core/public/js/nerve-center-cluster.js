(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    function extractIpFromUrl(url) {
        if (!url) return '';
        try {
            return new URL(url).hostname || '';
        } catch {
            const match = String(url).match(/^(?:https?:\/\/)?([^/:?#]+)/i);
            return match ? match[1] : '';
        }
    }

    // One-line GPU summary for the host card header. Multi-GPU hosts get a
    // ×count suffix when the cards are identical (e.g. "NVIDIA GeForce RTX
    // 3090 ×2") so the name isn't silently truncated to gpus[0] next to a
    // *summed* VRAM total — otherwise "RTX 3090 | 48.0GB" reads as one 48GB
    // card. Mixed GPUs are joined with " + ".
    function summarizeGpuNames(gpus) {
        const names = (gpus || []).map(g => (g && g.name) || '').filter(Boolean);
        if (names.length === 0) return '';
        if (names.length === 1) return names[0];
        return names.every(n => n === names[0])
            ? `${names[0]} ×${names.length}`
            : names.join(' + ');
    }

    // Collector throttle names (nvidia-smi bits) -> card badge families.
    function throttleFamily(reason) {
        if (reason === 'sw_thermal' || reason === 'hw_thermal') return 'thermal';
        if (reason === 'sw_power_cap' || reason === 'hw_power_brake') return 'power';
        return reason;
    }

    function formatAge(ms) {
        if (!Number.isFinite(Number(ms))) return '';
        const seconds = Math.round(Number(ms) / 1000);
        if (seconds < 90) return `${seconds}s`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 90) return `${minutes} min`;
        const hours = Math.round(minutes / 60);
        return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
    }

    // Live GPU telemetry comes from Data's GPU collector through
    // /api/nerve-center/inference/gpu-status. Only fresh samples carry values.
    function telemetryDoc(row) {
        if (!row) return {};
        const gpus = Array.isArray(row.gpus) ? row.gpus : [];
        return {
            gpus,
            gpuTelemetry: row.telemetry || null,
            nvidia: gpus.length ? {
                gpus: gpus.map(gpu => ({
                    temperature: gpu.temperature,
                    powerDraw: gpu.powerDraw,
                    powerLimit: gpu.powerLimit,
                    throttleReasons: [...new Set((gpu.throttleReasons || []).map(throttleFamily))]
                }))
            } : null,
            lastSeen: row.telemetry?.sampledAt || null,
            ollamaEnvironment: row.ollamaEnvironment || null
        };
    }

    function buildTelemetryChip(telemetry) {
        const status = telemetry?.status;
        if (!status) return '';
        const age = formatAge(telemetry.ageMs);
        const error = telemetry.lastError ? shared.escapeHtml(telemetry.lastError) : '';
        if (status === 'fresh') {
            return `<span class="nc-host-chip" title="GPU collector sample${age ? ` ${age} old` : ''}"><i class="fas fa-satellite-dish"></i> live${age ? ` · ${age}` : ''}</span>`;
        }
        if (status === 'stale') {
            return `<span class="nc-host-chip warn" title="${error || 'No fresh GPU sample'}"><i class="fas fa-clock"></i> GPU data stale${age ? ` · ${age}` : ''}</span>`;
        }
        const label = status === 'unavailable' ? 'GPU telemetry unavailable'
            : status === 'no_collector_host' ? 'GPU not collected' : 'no GPU sample yet';
        return `<span class="nc-host-chip" title="${error || label}" style="opacity:0.7;"><i class="fas fa-circle-question"></i> ${label}</span>`;
    }

    function normalizePinnedEntries(pref) {
        const entries = Array.isArray(pref?.pinnedModels) ? pref.pinnedModels : [];
        return entries
            .filter(e => e && e.model)
            .map(e => ({
                model: e.model,
                keepAlive: typeof e.keepAlive === 'number' ? e.keepAlive : -1,
                contextSize: typeof e.contextSize === 'number' ? e.contextSize : 0,
                autoRestore: e.autoRestore !== false,
                numThread: typeof e.numThread === 'number' ? e.numThread : 0
            }));
    }

    function mergeHostData(ollama, doc, cfg, mem, pref) {
        const hostname = ollama.hostname || doc.hostname || cfg.name || '--';
        const configuredIp = extractIpFromUrl(cfg.url || pref?.hostUrl || ollama.ollamaUrl || doc.ollamaUrl || '');
        const ip = configuredIp;
        const hostKey = ollama.ollamaHostKey || cfg.id || '';

        const ollamaStatus = ollama.ollamaStatus || mem.status || '';
        const docStatus = doc.status || 'offline';
        let status = 'offline';
        if (ollamaStatus === 'online' && docStatus === 'online') status = 'online';
        else if (ollamaStatus === 'online' || docStatus === 'online') status = 'online';
        else if (docStatus === 'degraded') status = 'degraded';

        const gpus = doc.gpus || [];
        const gpuName = summarizeGpuNames(gpus);
        const gpuTemp = gpus.length > 0 ? gpus[0].temperature : null;
        const gpuUtil = gpus.length > 0 ? gpus[0].utilization : null;

        const preferenceRunningModels = Array.isArray(pref?.live?.runningModels)
            ? pref.live.runningModels
            : [];
        const ollamaRunningModels = Array.isArray(ollama.ollamaRunningModels)
            ? ollama.ollamaRunningModels
            : [];
        const memoryRunningModels = Array.isArray(mem.runningModels) ? mem.runningModels : [];
        const runningModels = ollamaRunningModels.length > 0
            ? ollamaRunningModels
            : (preferenceRunningModels.length > 0 ? preferenceRunningModels : memoryRunningModels);

        const loadedModelVramMiB = Math.round(runningModels.reduce((sum, model) => {
            const bytes = Number(model?.sizeVram ?? model?.size_vram ?? 0);
            return sum + (Number.isFinite(bytes) && bytes > 0 ? bytes : 0);
        }, 0) / (1024 * 1024));

        const ollamaVram = ollama.ollamaVram || doc.ollamaVram || {};
        let vramTotalMiB = Number(ollamaVram.totalMiB)
            || Number(pref?.vramTotalMiB)
            || Number(pref?.gpu?.vramTotalMiB)
            || 0;
        let vramUsedMiB = Number(ollamaVram.usedMiB) || loadedModelVramMiB;
        if (vramTotalMiB === 0 && gpus.length > 0) {
            vramTotalMiB = gpus.reduce((sum, gpu) => sum + (gpu.vramTotal || 0), 0);
            vramUsedMiB = gpus.reduce((sum, gpu) => sum + (gpu.vramUsed || 0), 0);
        }

        return {
            hostKey,
            hostname,
            ip,
            configuredIp,
            status,
            gpuName,
            gpuTemp,
            gpuUtil,
            gpus,
            vramTotalMiB,
            vramUsedMiB,
            runningModels,
            availableModels: ollama.ollamaModels || mem.models || [],
            cpuUsage: doc.cpu?.usage ?? null,
            memUsage: doc.memory?.usagePercent ?? null,
            memTotal: doc.memory?.total || 0,
            memUsed: doc.memory?.used || 0,
            ollamaVersion: ollama.ollamaVersion || mem.version || '',
            ollamaLatency: ollama.ollamaLatencyMs ?? mem.latencyMs ?? null,
            ollamaStatus,
            lastChecked: ollama.ollamaLastChecked || pref?.live?.observedAt || null,
            lastSeen: doc.lastSeen || null,
            uptime: doc.uptime || 0,
            disks: doc.disks || [],
            nvidia: doc?.nvidia || null,
            gpuTelemetry: doc?.gpuTelemetry || null,
            swap: doc?.swap || null,
            ollamaService: doc?.ollamaService || null,
            ollamaEnvironment: doc?.ollamaEnvironment || null,
            // Host preference fields — the canonical shape uses
            // `pinnedEntries` (array of {model,keepAlive,contextSize,autoRestore}).
            // The first entry remains the primary pin; every entry has its own controls.
            pinnedEntries: normalizePinnedEntries(pref),
            maxConcurrentModels: pref?.maxConcurrentModels || 1,
            ollamaConcurrency: pref?.ollamaConcurrency || null,
            modelParallelism: Array.isArray(pref?.live?.modelParallelism) ? pref.live.modelParallelism : [],
            driftModels: pref?.driftModels || [],
            hostUrl: pref?.hostUrl || '',
            prefDisplayName: pref?.displayName || '',
            prefGpuModel: pref?.gpu?.model || '',
            prefLive: pref?.live || {},
            gpuHealth: pref?.live?.gpuHealth || null,
            // Declared in the inference host registry: a CPU instance keeps its pins out of VRAM.
            residency: cfg.residency === 'cpu' ? 'cpu' : 'gpu',
            pinStatus: pref?.status || 'idle',
            pinLive: pref?.live?.allPinnedLoaded ?? pref?.live?.pinnedLoaded ?? null,
        };
    }

    function buildMiniBar(label, percent) {
        const rounded = Math.round(percent);
        const color = rounded > 85 ? 'var(--danger)' : rounded > 60 ? '#f59e0b' : 'var(--success)';
        return `
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:2px;">
                    <span>${label}</span><span>${rounded}%</span>
                </div>
                <div style="width:100%;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
                    <div style="width:${rounded}%;height:100%;background:${color};border-radius:2px;transition:width 0.5s ease;"></div>
                </div>
            </div>`;
    }

    function buildHostDetail(host) {
        let html = '';

        if (host.gpus.length > 0) {
            html += '<div class="nc-fs-11b">GPUs</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:10px;">';
            host.gpus.forEach((gpu, index) => {
                const totalGb = (gpu.vramTotal / 1024).toFixed(1);
                const usedGb = (gpu.vramUsed / 1024).toFixed(1);
                const percent = gpu.vramTotal > 0 ? Math.round((gpu.vramUsed / gpu.vramTotal) * 100) : 0;
                html += `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                        <td style="padding:4px 0;color:var(--muted);">GPU ${gpu.index != null ? gpu.index : index}</td>
                        <td style="padding:4px 6px;">${shared.escapeHtml(gpu.name || '--')}</td>
                        <td class="nc-td-right-sm">${usedGb} / ${totalGb} GB (${percent}%)</td>
                        ${gpu.temperature != null ? `<td class="nc-td-right-sm">${gpu.temperature}&deg;C</td>` : '<td></td>'}
                        ${gpu.utilization != null ? `<td class="nc-td-right-sm">${gpu.utilization}% util</td>` : '<td></td>'}
                    </tr>`;
            });
            html += '</table>';
        }

        if (host.runningModels.length > 0) {
            html += '<div class="nc-fs-11b">Loaded Models</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:10px;">';
            host.runningModels.forEach(model => {
                if (typeof model === 'string') {
                    html += `<tr><td style="padding:3px 0;"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model))}</span></td></tr>`;
                    return;
                }

                const sizeGb = model.size ? `${(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB` : '--';
                const vramBytes = model.sizeVram ?? model.size_vram;
                const vramGb = vramBytes != null && Number.isFinite(Number(vramBytes)) ? `${(Number(vramBytes) / (1024 * 1024 * 1024)).toFixed(2)} GB` : '--';
                html += `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                        <td style="padding:4px 0;"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model.name))}</span></td>
                        <td class="nc-td-muted-sm">Size: ${sizeGb}</td>
                        <td class="nc-td-muted-sm">VRAM: ${vramGb}</td>
                        <td class="nc-td-muted-sm">Expires: ${shared.timeAgo(model.expiresAt ?? model.expires_at)}</td>
                    </tr>`;
            });
            html += '</table>';
        }

        if (host.availableModels.length > 0) {
            html += `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">${host.availableModels.length} available model${host.availableModels.length !== 1 ? 's' : ''}</div>`;
        }

        const systemRows = [];
        if (host.ollamaVersion) systemRows.push(['Ollama', `v${host.ollamaVersion}`]);
        if (host.uptime > 0) systemRows.push(['Uptime', shared.formatUptime(host.uptime)]);
        if (host.lastSeen) systemRows.push(['GPU sample', shared.timeAgo(host.lastSeen)]);
        if (host.gpuTelemetry?.lastError) systemRows.push(['GPU collector', host.gpuTelemetry.lastError]);
        if (host.lastChecked) systemRows.push(['Ollama Checked', shared.timeAgo(host.lastChecked)]);
        if (host.configuredIp) systemRows.push(['Configured IP', host.configuredIp]);

        if (host.disks.length > 0) {
            const mainDisk = host.disks.find(disk => disk.mount === '/') || host.disks[0];
            if (mainDisk) {
                const totalGb = (mainDisk.total / (1024 * 1024 * 1024)).toFixed(0);
                systemRows.push(['Disk (' + mainDisk.mount + ')', `${mainDisk.usagePercent || 0}% of ${totalGb} GB`]);
            }
        }

        if (systemRows.length > 0) {
            html += '<div class="nc-fs-11b">System</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
            systemRows.forEach(([label, value]) => {
                html += `
                    <tr>
                        <td style="padding:3px 0;color:var(--muted);width:40%;">${shared.escapeHtml(label)}</td>
                        <td style="padding:3px 0;">${shared.escapeHtml(value)}</td>
                    </tr>`;
            });
            html += '</table>';
        }

        // GPU Processes table
        const procs = host.nvidia?.processes || [];
        const gpuProcsHtml = procs.length > 0
          ? `<div style="margin-top:8px;"><strong style="font-size:0.8rem;">GPU Processes</strong>
              <table style="width:100%;font-size:0.8rem;margin-top:4px;border-collapse:collapse;">
                <tr style="color:var(--muted);font-size:0.72rem;text-transform:uppercase;">
                  <td style="padding:2px 6px;">PID</td><td>Process</td><td class="nc-td-right">VRAM</td>
                </tr>
                ${procs.map(p => `<tr><td style="padding:2px 6px;">${p.pid}</td><td>${shared.escapeHtml(p.name)}</td><td class="nc-td-right">${p.vramMiB} MiB</td></tr>`).join('')}
              </table></div>`
          : '';
        html += gpuProcsHtml;

        return html || '<div style="font-size:11px;color:var(--muted);">No additional details available</div>';
    }

    function isPinnedModelLoaded(host, model) {
        return (host.runningModels || []).some(rm => {
            const rmName = typeof rm === 'string' ? rm : (rm.name || '');
            return rmName === model || rmName.startsWith(model + ':');
        });
    }

    function buildPinnedModelChip(host, entry, index, options = {}) {
        const m = entry.model;
        const loaded = isPinnedModelLoaded(host, m);
        const isPrimary = index === 0;
        const allowRemove = options.allowRemove !== false;
        const isDrift = (host.driftModels || []).includes(m);
        const icon = isPrimary ? 'fa-thumbtack' : (loaded ? 'fa-circle-check' : 'fa-circle-pause');
        const color = loaded ? 'color:#4ade80;' : 'color:#f59e0b;';
        const driftBadge = isDrift
            ? '<i class="fas fa-triangle-exclamation nc-drift-icon" title="No direct task route; may serve other capabilities"></i>'
            : '';
        return '<span class="nc-model-tag default nc-pinned-chip' + (isPrimary ? ' primary' : '') + (isDrift ? ' drift' : '') + '">' +
            '<i class="fas ' + icon + '" style="' + color + 'font-size:9px;" title="' + (loaded ? 'Loaded' : 'Not loaded') + '"></i>' +
            '<span>' + shared.escapeHtml(shared.shortModel(m)) + '</span>' +
            driftBadge +
            (allowRemove ? '<button class="nc-pref-remove-default" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" data-model="' + shared.escapeHtml(m) + '"' +
                ' title="Remove from pinned set" aria-label="Remove pin ' + shared.escapeHtml(m) + '">' +
                '<i class="fas fa-xmark"></i></button>' : '') +
            '</span>';
    }

    // The GPU collector's latest reading of the host's Ollama service settings.
    function collectedOllamaSettings(host) {
        const env = host.ollamaEnvironment;
        const timestamp = Date.parse(env?.observedAt);
        if (!env || !Number.isFinite(timestamp) || timestamp > Date.now() + 30000) return null;
        const origin = env.source === 'windows-registry' ? 'Windows environment' : 'systemd unit ' + (env.unit || '');
        return { env, values: env.ok && env.values ? env.values : {}, origin, age: formatAge(Math.max(0, Date.now() - timestamp)) };
    }

    // A parallel-request observation recorded through the host-preference API.
    function recordedConcurrency(host) {
        const observation = host.ollamaConcurrency;
        const timestamp = Date.parse(observation?.observedAt);
        const known = Number.isSafeInteger(observation?.numParallel) && observation.numParallel > 0
            && Number.isFinite(timestamp) && timestamp <= Date.now() + 30000;
        return { observation, timestamp, known };
    }

    // Request slots each resident model gets: Ollama forces one for embeddings
    // and for the architectures its scheduler runs sequentially; any other
    // model follows the server setting.
    function buildModelParallelism(host, configured) {
        const rows = (host.modelParallelism || []).filter(item => item && item.model);
        if (!rows.length) return '';
        const describe = item => item.requestSlots === 1
            ? (item.reason === 'architecture' ? '1 (architecture ' + shared.escapeHtml(item.family || item.architecture || '') + ')' : '1 (embedding model)')
            : item.reason === 'server_setting' ? (configured ? shared.escapeHtml(configured) + ' (server setting)' : 'server setting') : 'unknown';
        return '<div style="margin-top:2px;"><span style="color:var(--muted);">Effective</span> ' + rows.map(item =>
            '<span style="margin-right:10px;white-space:nowrap;"><span style="color:var(--muted);">' + shared.escapeHtml(shared.shortModel(item.model)) +
            '</span> <strong>' + describe(item) + '</strong></span>').join(' ') + '</div>';
    }

    function buildOllamaConcurrency(host) {
        const { observation, timestamp, known } = recordedConcurrency(host);
        const observed = known ? new Date(timestamp).toLocaleString() : '';
        const ageDays = known ? Math.floor((Date.now() - timestamp) / 86400000) : 0;
        // Without a recorded observation, a value the collector read is shown as such.
        const collected = known ? null : collectedOllamaSettings(host);
        const collectedValue = collected && Object.prototype.hasOwnProperty.call(collected.values, 'OLLAMA_NUM_PARALLEL')
            ? collected.values.OLLAMA_NUM_PARALLEL : '';
        const configured = known ? String(observation.numParallel) : collectedValue;
        return '<div class="nc-ollama-concurrency" style="margin-bottom:8px;font-size:11px;overflow-wrap:anywhere;">' +
            '<span style="color:var(--muted);">Parallel requests per model</span> · <strong>' +
            (configured ? shared.escapeHtml(configured) + ' configured' : 'Unknown') + '</strong>' +
            (known ? '<div style="color:var(--muted);" title="' + shared.escapeHtml(observation.source || '') + '">Last observed: ' +
                shared.escapeHtml(observed) + (ageDays >= 1 ? ' · ' + ageDays + 'd old' : '') + '</div>' : '') +
            (collectedValue ? '<div style="color:var(--muted);">Read by the GPU collector from the ' +
                shared.escapeHtml(collected.origin) + (collected.age ? ' · ' + collected.age + ' ago' : '') + '</div>' : '') +
            buildModelParallelism(host, configured) +
            '<div style="color:var(--muted);">Extra requests queue. VRAM, context and AgentX admission can lower concurrency.</div></div>';
    }

    const OLLAMA_SETTING_ROWS = [
        ['OLLAMA_KV_CACHE_TYPE', 'KV cache', 'f16 (default)'],
        ['OLLAMA_FLASH_ATTENTION', 'Flash attention', 'Ollama default'],
        ['OLLAMA_MAX_LOADED_MODELS', 'Loaded models', 'Ollama default'],
        ['OLLAMA_SCHED_SPREAD', 'Spread across GPUs', 'Ollama default'],
        ['CUDA_VISIBLE_DEVICES', 'Visible GPUs', 'all'],
        ['OLLAMA_KEEP_ALIVE', 'Keep alive', null],
        ['OLLAMA_CONTEXT_LENGTH', 'Default context', null],
        ['OLLAMA_MAX_QUEUE', 'Queue limit', null],
        ['OLLAMA_GPU_OVERHEAD', 'GPU overhead', null],
        ['OLLAMA_LLM_LIBRARY', 'LLM library', null],
        ['OLLAMA_VULKAN', 'Vulkan', null]
    ];

    function buildOllamaServiceSettings(host) {
        const collected = collectedOllamaSettings(host);
        if (!collected) return '';
        const { env, values, origin, age } = collected;
        const muted = text => '<div style="color:var(--muted);">' + text + '</div>';
        const source = 'Read by the GPU collector from the ' + shared.escapeHtml(origin) + (age ? ' · ' + age + ' ago' : '');
        const open = '<div class="nc-ollama-settings" style="margin-bottom:8px;font-size:11px;overflow-wrap:anywhere;">' +
            '<span style="color:var(--muted);">Ollama server settings</span>';
        if (!env.ok) {
            return open + ' · <strong>not read</strong>' + muted(shared.escapeHtml(env.error || '')) + muted(source) + '</div>';
        }
        const has = key => Object.prototype.hasOwnProperty.call(values, key);
        // The parallel-request line shows the collector's value unless an
        // observation was recorded; then a differing reading must stay visible.
        const settingRows = recordedConcurrency(host).known && has('OLLAMA_NUM_PARALLEL')
            ? [['OLLAMA_NUM_PARALLEL', 'Parallel requests', null], ...OLLAMA_SETTING_ROWS]
            : OLLAMA_SETTING_ROWS;
        const rows = settingRows
            .filter(([key, , fallback]) => has(key) || fallback !== null)
            .map(([key, label, fallback]) => {
                const value = !has(key) ? fallback
                    : values[key] === '' ? (key === 'CUDA_VISIBLE_DEVICES' ? 'none' : 'empty') : values[key];
                return '<span style="margin-right:10px;white-space:nowrap;"><span style="color:var(--muted);">' + label +
                    '</span> <strong>' + shared.escapeHtml(value) + '</strong></span>';
            }).join(' ');
        const notes = [];
        if (env.activeSince) notes.push('Service started ' + shared.escapeHtml(env.activeSince) + '.');
        if (env.needDaemonReload) notes.push('The unit changed on disk and systemd has not reloaded it.');
        if (env.environmentFiles) notes.push('The unit also reads an environment file; its values are not shown.');
        if ((env.rejectedKeys || []).length) notes.push('Unexpected value ignored: ' + shared.escapeHtml(env.rejectedKeys.join(', ')) + '.');
        return open + '<div style="margin-top:2px;">' + rows + '</div>' +
            muted(source + '. A service not restarted since a change still runs the previous values.') +
            (notes.length ? muted(notes.join(' ')) : '') + '</div>';
    }

    function buildPinnedModelsSection(host) {
        const entries = host.pinnedEntries || [];
        const hostAttr = 'data-host-url="' + shared.escapeHtml(host.hostUrl) + '"';
        const options = (host.availableModels || []).filter(am => {
            const name = typeof am === 'string' ? am : am.name;
            return !entries.some(entry => entry.model === name);
        }).map(am => {
            const name = typeof am === 'string' ? am : am.name;
            return '<option value="' + shared.escapeHtml(name) + '">' + shared.escapeHtml(shared.shortModel(name)) + '</option>';
        }).join('');
        const swapOptions = (host.availableModels || []).map(am => {
            const name = typeof am === 'string' ? am : am.name;
            return '<option value="' + shared.escapeHtml(name) + '">' + shared.escapeHtml(shared.shortModel(name)) + '</option>';
        }).join('');
        const slots = Math.max(host.maxConcurrentModels || 1, entries.length);
        const slotOptions = Array.from({ length: Math.max(4, slots) }, (_, i) => i + 1).map(n =>
            '<option value="' + n + '"' + (n === slots ? ' selected' : '') + (n < entries.length ? ' disabled' : '') + '>' + n + '</option>'
        ).join('');
        const loadedCount = entries.filter(entry => isPinnedModelLoaded(host, entry.model)).length;
        const pinnedRows = entries.map((entry, index) => {
            const modelAttr = hostAttr + ' data-model="' + shared.escapeHtml(entry.model) + '"';
            const durations = [...new Set([-1, 0, 300, 600, 1800, 3600, entry.keepAlive])];
            const keepAliveOptions = durations.map(value => {
                const label = value === -1 ? '∞' : value === 0 ? 'Off' : value + 's';
                return '<option value="' + value + '"' + (value === entry.keepAlive ? ' selected' : '') + '>' + label + '</option>';
            }).join('');
            return '<div class="nc-pinned-secondary-row" style="display:flex;align-items:center;flex-wrap:wrap;">' +
                '<span class="nc-pinned-field-label">' + (index === 0 ? 'Primary' : 'Also pinned') + '</span>' +
                buildPinnedModelChip(host, entry, index) +
                '<span class="nc-pinned-note">Context: ' + (entry.contextSize || 'model default') + '</span>' +
                '<label class="nc-defaults-slots">Keep alive ' +
                    '<select class="nc-inline-select nc-pref-keepalive-select" ' + modelAttr +
                    ' aria-label="Keep alive for ' + shared.escapeHtml(entry.model) + '">' + keepAliveOptions + '</select></label>' +
                '<label class="nc-defaults-slots" title="CPU threads Ollama may use for this model (num_thread)">CPU threads ' +
                    '<select class="nc-inline-select nc-pin-threads-select" ' + modelAttr +
                    ' aria-label="CPU threads for ' + shared.escapeHtml(entry.model) + '">' +
                    [...new Set([0, 2, 4, 6, 8, 12, 16, entry.numThread || 0])].sort((a, b) => a - b).map(value =>
                        '<option value="' + value + '"' + (value === (entry.numThread || 0) ? ' selected' : '') + '>' + (value || 'Auto') + '</option>'
                    ).join('') + '</select></label>' +
                '<label class="nc-pinned-autorestore"><input type="checkbox" class="nc-pin-autorestore" ' + modelAttr +
                    ' aria-label="Auto restore ' + shared.escapeHtml(entry.model) + '"' + (entry.autoRestore ? ' checked' : '') + '> Auto restore</label>' +
                '</div>';
        }).join('');
        const loadedLine = (host.runningModels || []).map(model => {
            const name = typeof model === 'string' ? model : model.name;
            const size = Number(model?.size);
            const vram = Number(model?.sizeVram ?? model?.size_vram);
            const cpuHost = host.residency === 'cpu';
            const spill = size > 0 && Number.isFinite(vram) && (cpuHost ? vram > 0 : vram < size);
            return '<span class="nc-model-tag"' + (spill ? ' style="color:#f59e0b;"' : '') + '>' +
                shared.escapeHtml(shared.shortModel(name)) + (spill ? (cpuHost ? ' · uses VRAM' : ' · CPU spill') : '') + '</span>';
        }).join(' ') || '<span class="nc-pinned-note">Nothing loaded</span>';
        return '<div class="nc-defaults-panel nc-pinned-panel">' +
            buildOllamaConcurrency(host) +
            buildOllamaServiceSettings(host) +
            '<div class="nc-pinned-header"><div class="nc-pinned-title">' +
                '<span class="nc-defaults-label">Pinned Models</span>' +
                '<span class="nc-pinned-note">' + loadedCount + '/' + entries.length + ' loaded</span></div>' +
                '<label class="nc-defaults-slots" title="Declared resident slots; configure Ollama on the host to match">Resident slots ' +
                    '<select class="nc-inline-select nc-pref-max-select nc-pref-slot-select" ' + hostAttr + ' aria-label="Resident slots">' + slotOptions + '</select></label></div>' +
            pinnedRows +
            '<div class="nc-pinned-runtime-row" style="flex-wrap:wrap;justify-content:flex-start;"><span class="nc-pinned-field-label">Loaded now</span>' + loadedLine +
                '<div class="nc-pinned-swap-controls"><select class="nc-inline-select nc-pin-swap-select" ' + hostAttr + ' aria-label="Temporarily load model">' +
                    '<option value="">Swap to...</option>' + swapOptions + '</select>' +
                    '<button class="nc-btn nc-pin-swap nc-btn-icon" ' + hostAttr + ' title="Temporarily swap loaded model" aria-label="Temporarily swap loaded model"><i class="fas fa-arrows-rotate"></i></button></div></div>' +
            '<div class="nc-defaults-actions nc-pinned-add-row">' +
                '<select class="nc-inline-select nc-pref-add-select nc-pref-add-select-wide" ' + hostAttr + ' aria-label="Add pinned model">' +
                    '<option value="">Add pinned model...</option>' + options + '</select>' +
                '<button class="nc-btn nc-pref-add-default nc-btn-icon" ' + hostAttr + ' title="Add pinned model" aria-label="Add pinned model"><i class="fas fa-plus"></i></button>' +
                '<button class="nc-btn nc-pin-restore nc-btn-icon" ' + hostAttr + ' title="Restore all pins" aria-label="Restore all pins"><i class="fas fa-rotate-left"></i></button>' +
                (entries.length ? '<button class="nc-btn nc-pin-clear nc-btn-icon" ' + hostAttr + ' title="Clear pinned set" aria-label="Clear pinned set"><i class="fas fa-xmark"></i></button>' : '') +
                '</div></div>';
    }

    function buildHostCard(host) {
        const vramPercent = host.vramTotalMiB > 0 ? Math.round((host.vramUsedMiB / host.vramTotalMiB) * 100) : 0;
        const vramClass = vramPercent > 85 ? 'danger' : vramPercent > 60 ? 'warning' : '';
        const vramTotalGb = (host.vramTotalMiB / 1024).toFixed(1);
        const vramUsedGb = (host.vramUsedMiB / 1024).toFixed(1);
        const gpuLine = host.gpuName ? `${host.gpuName}${host.vramTotalMiB > 0 ? ` | ${vramTotalGb}GB` : ''}` : '';
        const modelTags = host.runningModels.length > 0
            ? host.runningModels.map(model => {
                const name = typeof model === 'string' ? model : (model.name || '--');
                return `<span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(name))}</span>`;
            }).join(' ')
            : '<span style="font-size:11px;color:var(--muted);">No models loaded</span>';

        // Optional runtime metadata, when provided by the configured endpoint.
        const nvidia = host.nvidia;
        const nGpu = nvidia?.gpus?.[0];
        const gpuTempValue = nGpu?.temperature ?? host.gpuTemp;
        const tempLine = gpuTempValue != null
          ? `<span class="nc-host-chip" title="GPU Temperature"><i class="fas fa-temperature-three-quarters"></i> ${Math.round(gpuTempValue)}°C</span>`
          : '';
        const powerLine = nGpu?.powerDraw != null
          ? `<span class="nc-host-chip" title="GPU Power"><i class="fas fa-bolt"></i> ${Math.round(nGpu.powerDraw)}W / ${Math.round(nGpu.powerLimit)}W</span>`
          : '';
        const fanLine = nGpu?.fanSpeed != null
          ? `<span class="nc-host-chip ${nGpu.fanSpeed > 85 ? 'warn' : ''}" title="Fan Speed"><i class="fas fa-fan"></i> ${nGpu.fanSpeed}%</span>`
          : '';
        const driverLine = nvidia?.driverVersion
          ? `<span class="nc-host-chip" title="NVIDIA Driver">drv ${shared.escapeHtml(nvidia.driverVersion)}</span>`
          : '';
        // Severity-tiered throttle badges: thermal = danger, power = warn, idle = hidden
        const throttleReasons = (nGpu?.throttleReasons || []).filter(r => r !== 'idle');
        const hasThermal = throttleReasons.includes('thermal');
        const throttleBadge = hasThermal
          ? `<span class="nc-host-chip danger" title="${shared.escapeHtml(throttleReasons.join(', '))}"><i class="fas fa-triangle-exclamation"></i> THROTTLED</span>`
          : throttleReasons.length > 0
            ? `<span class="nc-host-chip warn" title="${shared.escapeHtml(throttleReasons.join(', '))}"><i class="fas fa-bolt"></i> POWER CAP</span>`
            : '';

        const svcStatus = host.ollamaService?.status;
        const svcDot = svcStatus === 'running'
          ? '<span style="color:#4ade80;font-size:8px;margin-right:3px;" title="Ollama service running">&#9679;</span>'
          : svcStatus === 'failed'
            ? '<span style="color:#f87171;font-size:8px;margin-right:3px;" title="Ollama service failed">&#9679;</span>'
            : '';
        const svcUptime = (svcStatus === 'running' && host.ollamaService?.uptimeSeconds)
          ? `<span style="font-size:0.7rem;color:var(--muted);margin-left:4px;">up ${shared.formatUptime(host.ollamaService.uptimeSeconds)}</span>`
          : '';

        const swapLine = (host.swap?.used > 0)
          ? buildMiniBar('Swap', Math.round((host.swap.used / host.swap.total) * 100))
          : '';

        const ollamaOk = host.ollamaStatus === 'online';
        const ollamaIndicator = `<span class="nc-host-ollama ${ollamaOk ? 'ok' : 'down'}">
            ${svcDot}<i class="fas fa-${ollamaOk ? 'check-circle' : 'times-circle'}"></i>
            Ollama ${ollamaOk ? 'reachable' : 'unreachable'}${host.ollamaLatency != null && ollamaOk ? ` &middot; ${host.ollamaLatency}ms` : ''}${svcUptime}
        </span>`;

        return `
            <div class="nc-host-card" data-host="${shared.escapeHtml(host.hostKey)}">
                <div class="nc-host-card-header">
                    <div class="nc-host-card-title">
                        <span class="nc-status-dot ${host.status}"></span>
                        <span class="nc-host-card-name">${shared.escapeHtml(host.hostname)}</span>
                        ${host.hostKey ? `<span class="nc-host-key-badge">${shared.escapeHtml(host.hostKey)}</span>` : ''}
                        ${host.residency === 'cpu' ? '<span class="nc-host-key-badge" title="CPU instance: pins are expected outside VRAM">CPU</span>' : ''}
                    </div>
                    <div class="nc-host-card-status">${ollamaIndicator}</div>
                </div>
                <div class="nc-host-meta">
                    <div class="nc-host-meta-line">
                        ${host.ip ? `<span>${shared.escapeHtml(host.ip)}</span>` : ''}
                        ${gpuLine ? `<span>${shared.escapeHtml(gpuLine)}</span>` : ''}
                    </div>
                    <div class="nc-host-chip-row">
                        ${buildTelemetryChip(host.gpuTelemetry)}${tempLine}${powerLine}${fanLine}${driverLine}${throttleBadge}
                    </div>
                </div>
                <div class="nc-host-card-main">
                    ${window.NerveCenterGpuHealth?.render(host.gpuHealth) || ''}
                    <div class="nc-host-loaded-models">${modelTags}</div>
                    ${host.vramTotalMiB > 0 ? `
                        <div class="nc-host-vram-section">
                            <div class="nc-vram-bar-track">
                                <div class="nc-vram-bar-fill ${vramClass}" style="width:${vramPercent}%;"></div>
                            </div>
                            <div class="nc-host-vram-labels">
                                <span>VRAM ${vramUsedGb} / ${vramTotalGb} GB</span>
                                <span>${vramPercent}%</span>
                            </div>
                        </div>
                    ` : '<div class="nc-host-vram-section"><div style="font-size:10px;color:var(--muted);">VRAM data unavailable</div></div>'}
                    ${(host.cpuUsage !== null || host.memUsage !== null) ? `
                        <div class="nc-host-mini-meters">
                            <div class="nc-mini-bar-grid">
                                ${host.cpuUsage !== null ? buildMiniBar('CPU', host.cpuUsage) : ''}
                                ${host.memUsage !== null ? buildMiniBar('RAM', host.memUsage) : ''}
                                ${swapLine}
                            </div>
                        </div>
                    ` : ''}
                    ${buildPinnedModelsSection(host)}
                </div>
                <div class="nc-host-detail" id="nc-host-detail-${shared.escapeHtml(host.hostKey)}" style="display:none;border-top:1px solid var(--panel-border);margin-top:10px;padding-top:10px;">
                    ${buildHostDetail(host)}
                </div>
                <button type="button" class="nc-btn nc-host-expand" aria-expanded="false" aria-controls="nc-host-detail-${shared.escapeHtml(host.hostKey)}">Host details <i class="fas fa-chevron-down nc-expand-icon" aria-hidden="true"></i></button>
            </div>`;
    }

    function buildClusterGrid(cards) {
        return `<div class="nc-host-cards">${cards.map(buildHostCard).join('')}</div>`;
    }

    function attachHostCardHandlers() {
        document.querySelectorAll('.nc-host-card[data-host]').forEach(card => {
            card.querySelector('.nc-host-expand')?.addEventListener('click', event => {
                const detail = card.querySelector('.nc-host-detail');
                const icon = card.querySelector('.nc-expand-icon');
                if (!detail) return;

                const isVisible = detail.style.display !== 'none';
                detail.style.display = isVisible ? 'none' : 'block';
                event.currentTarget.setAttribute('aria-expanded', String(!isVisible));
                if (icon) {
                    icon.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
                }
            });
        });
    }

    function showPinError(control, error) {
        const panel = control.closest('.nc-pinned-panel');
        if (!panel) return;
        let message = panel.querySelector('.nc-pin-error');
        if (!message) {
            message = document.createElement('div');
            message.className = 'nc-pin-error';
            message.setAttribute('role', 'alert');
            panel.appendChild(message);
        }
        message.textContent = error.message;
    }

    function attachClusterPreferenceHandlers() {
        // Max concurrent models selector
        document.querySelectorAll('.nc-pref-max-select').forEach(select => {
            select.addEventListener('change', async () => {
                const hostUrl = select.dataset.hostUrl;
                const maxConcurrentModels = parseInt(select.value, 10);
                try {
                    const data = await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ maxConcurrentModels })
                    });
                    if (data.status === 'success') {
                        window.NerveCenterCluster?.loadCluster();
                    }
                } catch (err) {
                    showPinError(select, err);
                }
            });
        });

        // Mutate one entry on the server. Sending a stale complete list here
        // could overwrite another operator's addition or the embedding pin.
        document.querySelectorAll('.nc-pref-keepalive-select').forEach(select => {
            select.addEventListener('change', async () => {
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(select.dataset.hostUrl)}/pin`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: select.dataset.model, keepAlive: Number(select.value) })
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) { showPinError(select, err); }
            });
        });
        document.querySelectorAll('.nc-pin-threads-select').forEach(select => {
            select.addEventListener('change', async () => {
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(select.dataset.hostUrl)}/pin`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: select.dataset.model, numThread: Number(select.value) })
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) { showPinError(select, err); }
            });
        });
        document.querySelectorAll('.nc-pref-add-default, .nc-pref-remove-default').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const removing = button.classList.contains('nc-pref-remove-default');
                const select = document.querySelector(`.nc-pref-add-select[data-host-url="${CSS.escape(hostUrl)}"]`);
                const model = removing ? button.dataset.model : select?.value;
                if (!model) return;
                button.disabled = true;
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/pin`, {
                        method: removing ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model })
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) { showPinError(button, err); }
                finally { button.disabled = false; }
            });
        });

        // Warm pinned models
        document.querySelectorAll('.nc-pref-reload').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                button.disabled = true;
                const origHtml = button.innerHTML;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/reload`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 2000);
                } catch (err) {
                    console.error('Failed to reload defaults:', err);
                } finally {
                    button.disabled = false;
                    button.innerHTML = origHtml;
                }
            });
        });
    }

    function attachPinHandlers() {
        document.querySelectorAll('.nc-pin-set').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const select = document.querySelector(`.nc-pin-model-select[data-host-url="${CSS.escape(hostUrl)}"]`);
                const model = select?.value;
                if (!model) return;
                button.disabled = true;
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/pin`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model })
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 1000);
                } catch (err) {
                    console.error('Failed to set pin:', err);
                } finally {
                    button.disabled = false;
                }
            });
        });

        document.querySelectorAll('.nc-pin-restore').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                button.disabled = true;
                const origHtml = button.innerHTML;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/restore`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 2000);
                } catch (err) {
                    showPinError(button, err);
                } finally {
                    button.disabled = false;
                    button.innerHTML = origHtml;
                }
            });
        });

        document.querySelectorAll('.nc-pin-clear').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const headers = await window.AgentXTypedConfirmation.confirm({
                    action: 'CLEAR HOST PIN',
                    resource: hostUrl,
                    title: 'Clear pinned model',
                    description: `Clear the persisted model pin for ${hostUrl}? Automatic placement may select a different model afterward.`
                });
                if (!headers) return;
                button.disabled = true;
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/pin`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json', ...headers }
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) {
                    console.error('Failed to clear pin:', err);
                } finally {
                    button.disabled = false;
                }
            });
        });

        document.querySelectorAll('.nc-pin-swap').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const select = document.querySelector(`.nc-pin-swap-select[data-host-url="${CSS.escape(hostUrl)}"]`);
                const model = select?.value;
                if (!model) return;
                button.disabled = true;
                const origHtml = button.innerHTML;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/swap`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model })
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 2000);
                } catch (err) {
                    console.error('Failed to swap model:', err);
                } finally {
                    button.disabled = false;
                    button.innerHTML = origHtml;
                }
            });
        });

        document.querySelectorAll('.nc-pin-autorestore').forEach(checkbox => {
            checkbox.addEventListener('change', async () => {
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(checkbox.dataset.hostUrl)}/pin`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: checkbox.dataset.model, autoRestore: checkbox.checked })
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) { checkbox.checked = !checkbox.checked; showPinError(checkbox, err); }
            });
        });
    }

    async function loadCluster() {
        const body = document.getElementById('sectionClusterBody');
        if (!body) return;

        shared.renderSectionLoading(body, 'Loading cluster data...');

        try {
            const [ollamaJson, hostPrefsJson, gpuJson] = await Promise.all([
                shared.fetchJson('/api/ollama-hosts'),
                shared.fetchJson('/api/nerve-center/host-preferences'),
                shared.fetchJson('/api/nerve-center/inference/gpu-status').catch(() => ({ data: [] }))
            ]);
            const gpuByHost = new Map((gpuJson.data || []).map(row => [row.hostId, row]));
            const hostPrefs = hostPrefsJson.data || [];
            const prefByUrl = new Map(hostPrefs.map(p => [p.hostUrl, p]));

            const ollamaData = ollamaJson.data || {};
            const configuredHosts = ollamaData.hosts || [];
            const cards = configuredHosts.map((host) => mergeHostData({
                hostId: host.id,
                hostname: host.name || host.id,
                ollamaHostKey: host.id,
                ollamaStatus: host.available ? 'online' : 'offline',
                ollamaUrl: host.url,
                ollamaVersion: host.ollamaVersion || '',
                ollamaModelCount: (host.installedModels || []).length,
                ollamaModels: host.installedModels || host.models || []
            }, telemetryDoc(gpuByHost.get(host.id)), host, {}, prefByUrl.get(host.url)));

            if (cards.length === 0) {
                body.innerHTML = '<div class="nc-section-placeholder nc-muted"><i class="fas fa-server"></i> No cluster hosts found</div>';
                return;
            }

            body.innerHTML = buildClusterGrid(cards);
            attachHostCardHandlers();
            attachClusterPreferenceHandlers();
            attachPinHandlers();
            // Occupancy over a window loads on its own and never holds the cards.
            void window.NerveCenterGpuOccupancy?.mount(body);
        } catch (err) {
            console.error('[NerveCenter] loadCluster failed', err);
            shared.renderSectionError(body, `Failed to load cluster data: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterCluster = { loadCluster };
})();
