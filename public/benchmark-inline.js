        const BENCHMARK_API = '/api/benchmark';
        let latencyChart, tokensChart, qualityChart, compositeChart;
        let ollamaHosts = [];
        let currentSortBy = 'composite';
        let currentJudgeConfig = {};
        let lastDashboardOverview = null;
        let lastRecentTests = [];
        let showSuccessRateDetails = false;

        // Helper: Get headers with workspace context
        function getWorkspaceHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            if (window.WorkspaceManager && typeof window.WorkspaceManager.addWorkspaceHeader === 'function') {
                const workspaceHeaders = window.WorkspaceManager.addWorkspaceHeader({});
                Object.assign(headers, workspaceHeaders);
            }
            return headers;
        }

        // Debug logging (opt-in via ?debug=1 or localStorage.benchmarkDebug=true)
        const BENCHMARK_DEBUG = (
            new URLSearchParams(window.location.search).get('debug') === '1' ||
            localStorage.getItem('benchmarkDebug') === 'true'
        );
        const __debugLastLogAt = Object.create(null);
        function debugLog(...args) {
            if (BENCHMARK_DEBUG) console.log(...args);
        }
        function debugLogThrottled(key, intervalMs, ...args) {
            if (!BENCHMARK_DEBUG) return;
            const now = Date.now();
            const last = __debugLastLogAt[key] || 0;
            if (now - last < intervalMs) return;
            __debugLastLogAt[key] = now;
            console.log(...args);
        }

        function escapeJsString(value = '') {
            return String(value)
                .replace(/\\/g, '\\\\')
                .replace(/'/g, '\\\'')
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n');
        }

        function buildRecentTestsModelOptions(recentTests) {
            const select = document.getElementById('recentTestsModelFilter');
            if (!select) return;

            const prevValue = select.value;
            const models = new Set();
            for (const t of (Array.isArray(recentTests) ? recentTests : [])) {
                if (t && t.model) models.add(String(t.model));
            }
            const sorted = Array.from(models).sort((a, b) => a.localeCompare(b));

            select.innerHTML = ['<option value="">All</option>']
                .concat(sorted.map(m => `<option value="${String(m).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}">${String(m).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</option>`))
                .join('');

            // Keep selection if still valid
            if (prevValue && sorted.includes(prevValue)) select.value = prevValue;
        }

        function getRecentTestsFilters() {
            const failuresOnlyEl = document.getElementById('recentTestsFailuresOnly');
            const modelFilterEl = document.getElementById('recentTestsModelFilter');
            return {
                failuresOnly: !!(failuresOnlyEl && failuresOnlyEl.checked),
                model: modelFilterEl ? String(modelFilterEl.value || '') : ''
            };
        }

        function applyRecentTestsFilters(recentTests) {
            const { failuresOnly, model } = getRecentTestsFilters();
            return (Array.isArray(recentTests) ? recentTests : []).filter(t => {
                if (!t) return false;
                if (failuresOnly && t.success === true) return false;
                if (model && String(t.model || '') !== model) return false;
                return true;
            });
        }

        function rerenderRecentTests() {
            const filtered = applyRecentTestsFilters(lastRecentTests);
            renderRecentTests(filtered);
        }

        function renderSuccessRateDetails() {
            const el = document.getElementById('successRateDetails');
            if (!el) return;
            if (!showSuccessRateDetails) {
                el.style.display = 'none';
                return;
            }

            const o = lastDashboardOverview;
            const total = o && Number.isFinite(Number(o.total_tests)) ? Number(o.total_tests) : 0;
            const successful = o && Number.isFinite(Number(o.successful)) ? Number(o.successful) : 0;
            const failed = o && Number.isFinite(Number(o.failed)) ? Number(o.failed) : 0;
            el.textContent = `${successful} successful • ${failed} failed • ${total} total`;
            el.style.display = 'block';
        }

        function renderRecentTests(recentTests) {
            const container = document.getElementById('recentTestsList');
            if (!container) return;

            const items = Array.isArray(recentTests) ? recentTests : [];
            if (items.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px;">No tests yet</div>';
                return;
            }

            const esc = (s) => String(s || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const fmtTime = (iso) => {
                try {
                    const d = new Date(iso);
                    if (Number.isNaN(d.getTime())) return '';
                    return d.toLocaleString();
                } catch {
                    return '';
                }
            };

            container.innerHTML = items.map((t) => {
                const ok = t && t.success === true;
                const model = esc(t && t.model);
                const host = esc(t && t.host);
                const latency = (t && Number.isFinite(Number(t.latency))) ? `${Math.round(Number(t.latency))} ms` : '-';
                const tps = (t && t.tokens_per_sec !== undefined && t.tokens_per_sec !== null) ? esc(t.tokens_per_sec) : '-';
                const level = (t && t.prompt_level) ? esc(t.prompt_level) : '-';
                const when = fmtTime(t && t.timestamp);
                const error = !ok ? esc(t && t.error) : '';

                return `
                    <div style="padding: 10px 12px; border-bottom: 1px solid var(--panel-border);">
                        <div style="display:flex; justify-content: space-between; align-items: baseline; gap: 10px;">
                            <div style="font-weight: 600; color: var(--text);">${ok ? '✓' : '✗'} ${model}</div>
                            <div style="color: var(--muted); font-size: 0.85em;">${esc(when)}</div>
                        </div>
                        <div style="color: var(--muted); font-size: 0.85em; margin-top: 2px; opacity: 0.9;">${host}</div>
                        <div style="display:flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; font-size: 0.9em; color: rgba(255,255,255,0.88);">
                            <div>Latency: <span style="color: var(--text);">${esc(latency)}</span></div>
                            <div>Tokens/s: <span style="color: var(--text);">${tps}</span></div>
                            <div>Level: <span style="color: var(--text);">${level}</span></div>
                        </div>
                        ${!ok && error ? `<div style="margin-top: 6px; color: rgba(231,76,60,0.95); font-size: 0.85em; line-height: 1.35;">${error}</div>` : ''}
                    </div>
                `;
            }).join('');
        }

        function toggleSuccessRateDetails() {
            showSuccessRateDetails = !showSuccessRateDetails;
            renderSuccessRateDetails();
        }

        // Modal Logic
        function setupModals() {
            const settingsModal = document.getElementById('settingsModal');
            const helpModal = document.getElementById('helpModal');
            const settingsBtn = document.getElementById('settingsBtn');
            const helpBtn = document.getElementById('helpBtn');
            const closeBtns = document.querySelectorAll('.close, .close-btn');

            if (settingsBtn) {
                settingsBtn.onclick = () => {
                    loadJudgeConfig();
                    settingsModal.style.display = 'block';
                };
            }

            if (helpBtn) {
                helpBtn.onclick = () => helpModal.style.display = 'block';
            }

            closeBtns.forEach(btn => {
                btn.onclick = function () {
                    this.closest('.modal').style.display = 'none';
                }
            });

            window.onclick = (event) => {
                if (event.target == settingsModal) settingsModal.style.display = 'none';
                if (event.target == helpModal) helpModal.style.display = 'none';
            };

            const refreshBtn = document.getElementById('refreshJudgeDetailsBtn');
            if (refreshBtn) {
                refreshBtn.onclick = async () => {
                    if (!window.currentJudgeDetailId) return;
                    await pollBatchProgress();
                    // Re-open using stable id (keeps step-by-step view in sync)
                    showJudgeDetails(window.currentJudgeDetailId);
                };
            }

            // Judge Temp Slider
            const tempSlider = document.getElementById('judgeTemp');
            const tempVal = document.getElementById('judgeTempVal');
            if (tempSlider) {
                tempSlider.oninput = () => tempVal.textContent = tempSlider.value;
            }

            // Save Settings
            const saveBtn = document.getElementById('saveSettingsBtn');
            if (saveBtn) {
                saveBtn.onclick = () => {
                    currentJudgeConfig = {
                        model: document.getElementById('judgeModel').value,
                        temperature: parseFloat(document.getElementById('judgeTemp').value),
                        timeout: parseInt(document.getElementById('judgeTimeout').value),
                        num_predict: parseInt(document.getElementById('judgeMaxTokens')?.value) || 200,
                        concurrency: parseInt(document.getElementById('judgeConcurrency').value) || 2,
                        judge_same_host: !!document.getElementById('judgeSameHost')?.checked,
                        prompts: {
                            reasoning: document.getElementById('promptReasoning').value,
                            code: document.getElementById('promptCode').value,
                            factual: document.getElementById('promptFactual').value,
                            math: document.getElementById('promptMath').value,
                            creative: document.getElementById('promptCreative').value
                        }
                    };
                    settingsModal.style.display = 'none';
                };
            }
        }

        function formatHostLabel(url) {
            if (!url) return 'Unknown';
            if (url.includes('192.168.2.99')) return 'UGFrank';
            if (url.includes('192.168.2.12')) return 'UGBrutal';
            if (url.includes('localhost')) return 'Local';
            return url.replace('http://', '').replace(':11434', '');
        }

        function formatDuration(ms) {
            if (!ms || !Number.isFinite(ms) || ms <= 0) return '-';
            const totalSeconds = Math.ceil(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            if (minutes <= 0) return `${totalSeconds}s`;
            return `${minutes}m ${seconds}s`;
        }

        function updateTimeline(batch) {
            if (!batch || !batch.timeline) return;

            const eventsContainer = document.getElementById('timelineEvents');
            const summaryContainer = document.getElementById('timelineSummary');

            if (!eventsContainer || !summaryContainer) return;

            const timeline = batch.timeline || [];
            const recentEvents = timeline.slice(-20); // Show last 20 events

            // Calculate event type icons and colors
            const getEventDisplay = (event) => {
                switch (event.event) {
                    case 'test_start':
                        return { icon: 'fa-play-circle', color: '#3498db', label: 'Test Started' };
                    case 'test_complete':
                        return { icon: 'fa-check-circle', color: '#2ecc71', label: 'Test Completed' };
                    case 'judge_start':
                        return { icon: 'fa-gavel', color: '#9b59b6', label: 'Judging Started' };
                    case 'judge_complete':
                        return { icon: 'fa-certificate', color: '#1abc9c', label: 'Judging Complete' };
                    case 'error':
                        return { icon: 'fa-exclamation-circle', color: '#e74c3c', label: 'Error' };
                    default:
                        return { icon: 'fa-info-circle', color: '#95a5a6', label: event.event };
                }
            };

            // Render timeline events
            const eventsHtml = recentEvents.map((event, index) => {
                const display = getEventDisplay(event);
                const timestamp = new Date(event.timestamp).toLocaleTimeString();
                const durationText = event.duration_ms ? ` (${event.duration_ms < 1000 ? `${event.duration_ms}ms` : `${(event.duration_ms / 1000).toFixed(1)}s`})` : '';
                const modelText = event.model ? `<span style="color: ${display.color}; font-weight: 500;">${event.model}</span>` : '';
                const errorText = event.error ? `<div style="color: #e74c3c; font-size: 0.9em; margin-top: 2px;">${event.error}</div>` : '';

                return `
                    <div style="display: flex; align-items: start; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <i class="fas ${display.icon}" style="color: ${display.color}; margin-top: 2px;"></i>
                        <div style="flex: 1;">
                            <div style="color: var(--text);">${display.label}${durationText}</div>
                            <div style="color: var(--muted); font-size: 0.9em; margin-top: 2px;">
                                ${modelText}${modelText && event.prompt_id ? ' → ' : ''}${event.prompt_id || ''}
                            </div>
                            ${errorText}
                        </div>
                        <div style="color: var(--muted); font-size: 0.85em; white-space: nowrap;">${timestamp}</div>
                    </div>
                `;
            }).join('');

            eventsContainer.innerHTML = eventsHtml || '<div style="color: var(--muted); padding: 8px 0;">No events yet</div>';

            // Calculate summary statistics
            const testEvents = timeline.filter(e => e.event === 'test_complete');
            const judgeEvents = timeline.filter(e => e.event === 'judge_complete');
            const errorEvents = timeline.filter(e => e.event === 'error');

            const avgTestDuration = testEvents.length > 0
                ? Math.round(testEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / testEvents.length)
                : null;

            const avgJudgeDuration = judgeEvents.length > 0
                ? Math.round(judgeEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / judgeEvents.length)
                : null;

            const summaryHtml = `
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;">
                    <div>
                        <div style="font-weight: 600; color: var(--text);">Total Events</div>
                        <div>${timeline.length}</div>
                    </div>
                    <div>
                        <div style="font-weight: 600; color: var(--text);">Tests Completed</div>
                        <div style="color: #2ecc71;">${testEvents.length}</div>
                    </div>
                    <div>
                        <div style="font-weight: 600; color: var(--text);">Errors</div>
                        <div style="color: ${errorEvents.length > 0 ? '#e74c3c' : 'var(--muted)'}">${errorEvents.length}</div>
                    </div>
                    <div>
                        <div style="font-weight: 600; color: var(--text);">Avg Test Time</div>
                        <div>${avgTestDuration ? `${(avgTestDuration / 1000).toFixed(1)}s` : '-'}</div>
                    </div>
                    <div>
                        <div style="font-weight: 600; color: var(--text);">Avg Judge Time</div>
                        <div>${avgJudgeDuration ? `${(avgJudgeDuration / 1000).toFixed(1)}s` : '-'}</div>
                    </div>
                </div>
            `;

            summaryContainer.innerHTML = summaryHtml;
        }

        function toFiniteNumber(v) {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        }

        function percentile(sortedValuesAsc, p) {
            const xs = Array.isArray(sortedValuesAsc) ? sortedValuesAsc : [];
            if (xs.length === 0) return null;
            const clamped = Math.max(0, Math.min(1, p));
            const idx = (xs.length - 1) * clamped;
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            if (lo === hi) return xs[lo];
            const w = idx - lo;
            return xs[lo] * (1 - w) + xs[hi] * w;
        }

        function summarizeNumbers(values) {
            const xs = (Array.isArray(values) ? values : [])
                .map(toFiniteNumber)
                .filter(v => v !== null)
                .slice()
                .sort((a, b) => a - b);
            if (xs.length === 0) {
                return { n: 0, min: null, max: null, mean: null, p10: null, p50: null, p90: null, p95: null };
            }
            const sum = xs.reduce((acc, v) => acc + v, 0);
            return {
                n: xs.length,
                min: xs[0],
                max: xs[xs.length - 1],
                mean: sum / xs.length,
                p10: percentile(xs, 0.10),
                p50: percentile(xs, 0.50),
                p90: percentile(xs, 0.90),
                p95: percentile(xs, 0.95)
            };
        }

        function countBy(items, getKey) {
            const counts = Object.create(null);
            for (const item of (Array.isArray(items) ? items : [])) {
                const key = getKey(item);
                if (!key) continue;
                counts[key] = (counts[key] || 0) + 1;
            }
            return counts;
        }

        function topCounts(countsObj, limit = 5) {
            const entries = Object.entries(countsObj || {})
                .map(([k, v]) => ({ key: k, count: Number(v) || 0 }))
                .filter(e => e.count > 0)
                .sort((a, b) => b.count - a.count);
            return entries.slice(0, limit);
        }

        function inferOppositeHostUrl(execHostUrl) {
            if (!execHostUrl) return null;
            const other = Array.isArray(ollamaHosts)
                ? ollamaHosts.find(h => h && h.url && h.url !== execHostUrl)
                : null;
            return other ? other.url : null;
        }

        function renderBatchPlan(plan, fallbackHostUrl, qualityScoringEnabled, executionMode = 'latency') {
            if (!plan) {
                const judgeModel = currentJudgeConfig.model || '(server default)';
                const exec = fallbackHostUrl ? formatHostLabel(fallbackHostUrl) : '(unknown)';
                const judgeHostUrl = qualityScoringEnabled
                    ? (currentJudgeConfig.judge_same_host ? fallbackHostUrl : inferOppositeHostUrl(fallbackHostUrl))
                    : null;
                const judgeHost = qualityScoringEnabled ? formatHostLabel(judgeHostUrl) : 'Disabled';

                const modeIcon = executionMode === 'throughput' ? '🔥' : '⚡';
                const modeLabel = executionMode === 'throughput' ? 'Throughput Mode' : 'Latency Mode';
                const modeColor = executionMode === 'throughput' ? 'warning' : 'info';

                return `
                    <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                        <span class="badge bg-light text-dark border">Exec: ${exec}</span>
                        <span class="text-muted">•</span>
                        <span class="badge bg-light text-dark border">Judge: ${judgeModel}</span>
                        <span class="text-muted">•</span>
                        <span class="badge bg-light text-dark border">Judge Host: ${judgeHost}</span>
                        <span class="text-muted">•</span>
                        <span class="badge bg-${modeColor} text-dark">${modeIcon} ${modeLabel}</span>
                    </div>
                `;
            }

            const judgeModel = plan.judge_model || currentJudgeConfig.model || '(server default)';
            const modeIcon = executionMode === 'throughput' ? '🔥' : '⚡';
            const modeLabel = executionMode === 'throughput' ? 'Throughput Mode' : 'Latency Mode';
            const modeColor = executionMode === 'throughput' ? 'warning' : 'info';

            let html = '';

            // 1. Judge Info Header with Execution Mode
            html += `<div class="d-flex align-items-center mb-3 p-2 bg-light rounded border">`;
            html += `<i class="fas fa-gavel me-2 text-primary"></i>`;
            html += `<strong class="me-2">Judge Model:</strong>`;
            html += `<span class="badge bg-primary me-2">${judgeModel}</span>`;
            if (!qualityScoringEnabled) {
                html += `<span class="badge bg-danger me-2">Disabled</span>`;
            }
            html += `<span class="text-muted me-2">•</span>`;
            html += `<span class="badge bg-${modeColor} text-dark">${modeIcon} ${modeLabel}</span>`;
            html += `</div>`;

            // 2. Execution Nodes
            if (Array.isArray(plan.exec_hosts) && plan.exec_hosts.length > 0) {
                html += `<div class="card mb-3 shadow-0 border">`;
                html += `<div class="card-header py-2 bg-light"><strong>Execution Nodes</strong></div>`;
                html += `<ul class="list-group list-group-flush">`;
                
                for (const h of plan.exec_hosts) {
                    const execLabel = formatHostLabel(h.exec_host);
                    const judgeLabel = qualityScoringEnabled ? formatHostLabel(h.judge_host) : 'Disabled';
                    const modelCount = Array.isArray(h.models) ? h.models.length : 0;
                    
                    html += `<li class="list-group-item p-2">`;
                    html += `<div class="row align-items-center g-2">`;
                    html += `<div class="col-md-5"><small class="text-muted d-block">Execution Host</small><span class="text-break font-monospace" style="font-size: 0.9em;">${execLabel}</span></div>`;
                    html += `<div class="col-md-5"><small class="text-muted d-block">Judge Host</small><span class="text-break font-monospace" style="font-size: 0.9em;">${judgeLabel}</span></div>`;
                    html += `<div class="col-md-2 text-end">`;
                    html += `<span class="badge bg-secondary mb-1 d-inline-block" title="Models">${modelCount} models</span><br>`;
                    html += `<span class="badge bg-info text-dark" title="Tests">${h.tests} tests</span>`;
                    html += `</div>`;
                    html += `</div>`;
                    html += `</li>`;
                }
                html += `</ul></div>`;
            }

            // 3. Workload Breakdown
            if (Array.isArray(plan.categories) && plan.categories.length > 0) {
                html += `<div class="card shadow-0 border">`;
                html += `<div class="card-header py-2 bg-light"><strong>Workload Breakdown</strong></div>`;
                html += `<div class="table-responsive">`;
                html += `<table class="table table-sm table-striped mb-0 align-middle" style="font-size: 0.9em;">`;
                html += `<thead class="table-light"><tr><th>Category</th><th class="text-center">Prompts</th><th class="text-center">Models</th><th class="text-end">Total Tests</th></tr></thead>`;
                html += `<tbody>`;
                
                for (const c of plan.categories) {
                    html += `<tr>`;
                    html += `<td class="fw-bold text-capitalize">${c.category}</td>`;
                    html += `<td class="text-center">${c.prompt_count}</td>`;
                    html += `<td class="text-center">${plan.total_models}</td>`;
                    html += `<td class="text-end fw-bold">${c.tests}</td>`;
                    html += `</tr>`;
                }
                
                html += `</tbody></table></div></div>`;
            }

            return html;
        }

        async function loadJudgeConfig() {
            try {
                const res = await fetch(`${BENCHMARK_API}/config`, {
                    headers: getWorkspaceHeaders()
                });
                const json = await res.json();
                if (json.status === 'success') {
                    const config = json.data.judge_config;
                    const scoringConfigs = json.data.scoring_configs;

                    // Populate Judge Model Dropdown (using all available models from current host)
                    const hostUrl = document.getElementById('host').value;
                    const host = ollamaHosts.find(h => h.url === hostUrl);
                    const judgeSelect = document.getElementById('judgeModel');

                    if (host && host.models && judgeSelect) {
                        // If current config model is not in list, add it or select default
                        const currentModel = currentJudgeConfig.model || config.model;

                        judgeSelect.innerHTML = host.models.map(m =>
                            `<option value="${m}" ${m === currentModel ? 'selected' : ''}>${m}</option>`
                        ).join('');
                    }

                    // Set other values if not already set by user
                    if (Object.keys(currentJudgeConfig).length === 0) {
                        if (document.getElementById('judgeTemp')) {
                            document.getElementById('judgeTemp').value = config.temperature;
                            document.getElementById('judgeTempVal').textContent = config.temperature;
                        }
                        if (document.getElementById('judgeTimeout')) {
                            document.getElementById('judgeTimeout').value = config.timeout;
                        }
                        if (document.getElementById('judgeMaxTokens')) {
                            document.getElementById('judgeMaxTokens').value = config.num_predict || 200;
                        }
                        if (document.getElementById('judgeConcurrency')) {
                            document.getElementById('judgeConcurrency').value = config.concurrency || 2;
                            document.getElementById('judgeConcurrencyVal').textContent = config.concurrency || 2;
                        }

                        if (document.getElementById('judgeSameHost')) {
                            document.getElementById('judgeSameHost').checked = !!config.judge_same_host;
                        }

                        // Initialize current config
                        currentJudgeConfig = { ...config };
                    }

                    // Keep checkbox in sync with current config
                    if (document.getElementById('judgeSameHost')) {
                        document.getElementById('judgeSameHost').checked = !!currentJudgeConfig.judge_same_host;
                    }

                    // Keep max tokens in sync with current config
                    if (document.getElementById('judgeMaxTokens')) {
                        document.getElementById('judgeMaxTokens').value = currentJudgeConfig.num_predict || config.num_predict || 200;
                    }

                    // Populate Prompts (either from current config or default)
                    const prompts = currentJudgeConfig.prompts || {};
                    if (scoringConfigs) {
                        document.getElementById('promptReasoning').value = prompts.reasoning || scoringConfigs.reasoning.prompt;
                        document.getElementById('promptCode').value = prompts.code || scoringConfigs.code.prompt;
                        document.getElementById('promptFactual').value = prompts.factual || scoringConfigs.factual.prompt;
                        document.getElementById('promptMath').value = prompts.math || scoringConfigs.math.prompt;
                        document.getElementById('promptCreative').value = prompts.creative || scoringConfigs.creative.prompt;
                    }
                }
            } catch (err) {
                console.error('Failed to load judge config:', err);
            }
        }

        // Fetch Ollama hosts from AgentX config
        async function loadOllamaHosts() {
            debugLogThrottled('loadOllamaHosts', 30000, 'Loading Ollama hosts...');
            const select = document.getElementById('host');

            try {
                // Add timeout to client-side fetch
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

                const res = await fetch('/api/ollama-hosts', { 
                    signal: controller.signal,
                    headers: getWorkspaceHeaders()
                });
                clearTimeout(timeoutId);

                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                const json = await res.json();
                const data = json.data || json;

                if (data.hosts && data.hosts.length > 0) {
                    ollamaHosts = data.hosts;

                    // Populate host select
                    if (select) {
                        select.innerHTML = ollamaHosts.map(h => {
                            const status = h.available ? '✓' : '✗';
                            const modelCount = h.models ? ` [${h.models.length} models]` : '';
                            return `<option value="${h.url}">${status} ${h.name} (${h.url})${modelCount}</option>`;
                        }).join('');

                        // Set default to first available host
                        const firstAvailable = ollamaHosts.find(h => h.available);
                        if (firstAvailable) {
                            select.value = firstAvailable.url;
                        }

                        // Load models for default host
                        try {
                            loadModelsForHost(select.value);
                        } catch (e) {
                            console.error('Failed to load models for host:', e);
                        }
                        try {
                            loadBatchModels(select.value);
                        } catch (e) {
                            console.error('Failed to load batch models for host:', e);
                        }
                    }
                } else {
                    throw new Error('No hosts configured');
                }
            } catch (err) {
                console.error('Failed to load Ollama hosts:', err);
                if (select) {
                    const msg = err.name === 'AbortError' ? 'Request timed out' : 'No hosts available';
                    select.innerHTML = `<option value="" selected disabled>${msg} — check server OLLAMA_HOST config</option>`;
                }
            }
        }

        // Load available models for selected host
        function loadModelsForHost(hostUrl) {
            const host = ollamaHosts.find(h => h.url === hostUrl);
            const modelSelect = document.getElementById('model');

            if (!modelSelect) return;

            if (host && host.models && host.models.length > 0) {
                // Populate model dropdown
                modelSelect.innerHTML = host.models.map(model =>
                    `<option value="${model}">${model}</option>`
                ).join('');

                // Select first model by default
                modelSelect.value = host.models[0];
            } else {
                modelSelect.innerHTML = '<option value="">No models available</option>';
            }
        }

        // Update models when host changes
        document.getElementById('host').addEventListener('change', (e) => {
            try {
                loadModelsForHost(e.target.value);
            } catch (err) {
                console.error('Failed to load models for selected host:', err);
            }
            try {
                loadBatchModels(e.target.value); // Also update batch model checkboxes
            } catch (err) {
                console.error('Failed to load batch models for selected host:', err);
            }
        });

        // Update help text when execution mode changes
        const executionModeSelect = document.getElementById('executionMode');
        const executionModeHelp = document.getElementById('executionModeHelp');
        if (executionModeSelect && executionModeHelp) {
            executionModeSelect.addEventListener('change', (e) => {
                if (e.target.value === 'throughput') {
                    executionModeHelp.innerHTML = '<i class="fas fa-rocket" style="color: #e67e22;"></i> <strong>Throughput Mode:</strong> Tests run in parallel with concurrency=2. Maximizes throughput testing but latency measurements may be distorted by queueing effects. Use for capacity testing.';
                } else {
                    executionModeHelp.innerHTML = '<i class="fas fa-stopwatch" style="color: #3498db;"></i> <strong>Latency Mode:</strong> Tests run serially (one at a time) with concurrency=1. Provides clean, fair latency measurements without queue interference. Recommended for model comparison.';
                }
            });
        }

        let modelRegistryCache = {};

        async function fetchModelRegistry() {
            try {
                const res = await fetch('/api/models/registry', {
                    headers: getWorkspaceHeaders()
                });
                const json = await res.json();
                if (json.status === 'success') {
                    modelRegistryCache = {};
                    json.data.models.forEach(m => {
                        modelRegistryCache[m.modelName] = m;
                    });
                    renderCategoryTabs();
                }
            } catch (err) {
                console.error('Failed to fetch model registry:', err);
            }
        }

        function renderCategoryTabs() {
            const categories = new Set();
            Object.values(modelRegistryCache).forEach(m => {
                if (m.categories && Array.isArray(m.categories)) {
                    m.categories.forEach(c => {
                        if (c) categories.add(c);
                    });
                }
            });

            const sortedCategories = Array.from(categories).sort();
            const container = document.querySelector('.category-tabs');
            if (!container) return;

            // Keep the current active category if possible
            const currentActive = document.querySelector('.category-tab.active');
            const activeCategory = currentActive ? currentActive.dataset.category : '';

            let html = `
                <button class="category-tab ${activeCategory === '' ? 'active' : ''}" data-category="" onclick="switchCategoryTab('')" style="padding: 10px 20px; background: none; border: none; border-bottom: 3px solid ${activeCategory === '' ? 'var(--accent)' : 'transparent'}; color: ${activeCategory === '' ? 'var(--accent)' : 'var(--muted)'}; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                    <i class="fas fa-globe" style="margin-right: 6px;"></i> Universal
                </button>
            `;

            sortedCategories.forEach(cat => {
                const isActive = activeCategory === cat;
                const safeCat = escapeJsString(cat);
                // Choose an icon based on category name
                let icon = 'fa-tag';
                const lowerCat = cat.toLowerCase();
                if (lowerCat.includes('ops') || lowerCat.includes('glue')) icon = 'fa-bolt';
                else if (lowerCat.includes('code') || lowerCat.includes('dev')) icon = 'fa-code';
                else if (lowerCat.includes('reason') || lowerCat.includes('think')) icon = 'fa-brain';
                else if (lowerCat.includes('special')) icon = 'fa-star';
                else if (lowerCat.includes('general')) icon = 'fa-cubes';

                html += `
                    <button class="category-tab ${isActive ? 'active' : ''}" data-category="${cat}" onclick="switchCategoryTab('${safeCat}')" style="padding: 10px 20px; background: none; border: none; border-bottom: 3px solid ${isActive ? 'var(--accent)' : 'transparent'}; color: ${isActive ? 'var(--accent)' : 'var(--muted)'}; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                        <i class="fas ${icon}" style="margin-right: 6px;"></i> ${cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </button>
                `;
            });

            container.innerHTML = html;
        }

        async function saveModelNote(model, note) {
            // Optimistic update
            if (!modelRegistryCache[model]) {
                modelRegistryCache[model] = { modelName: model, displayName: model };
            }
            modelRegistryCache[model].userNote = note;

            try {
                // Try PATCH first
                let res = await fetch(`/api/models/registry/${encodeURIComponent(model)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userNote: note })
                });
                
                if (res.status === 404) {
                    // Create if not exists
                    res = await fetch('/api/models/registry', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            modelName: model, 
                            displayName: model,
                            userNote: note,
                            categories: ['generalist'] // Default
                        })
                    });
                }
                
                if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
                    window.BenchmarkAnalytics.showToast(`Note saved for ${model}`, 'success');
                }
            } catch (err) {
                console.error('Failed to save note:', err);
                if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
                    window.BenchmarkAnalytics.showToast(`Failed to save note for ${model}`, 'error');
                }
            }
        }
        
        // Expose to window for onblur
        window.saveModelNote = saveModelNote;

        async function saveModelCategory(model, category) {
             // Optimistic update
            if (!modelRegistryCache[model]) {
                modelRegistryCache[model] = { modelName: model, displayName: model };
            }
            modelRegistryCache[model].categories = [category];
            renderCategoryTabs();

            try {
                // Try PATCH first
                let res = await fetch(`/api/models/registry/${encodeURIComponent(model)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ categories: [category] })
                });
                
                if (res.status === 404) {
                    // Create if not exists
                    res = await fetch('/api/models/registry', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            modelName: model, 
                            displayName: model,
                            categories: [category]
                        })
                    });
                }

                if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
                    window.BenchmarkAnalytics.showToast(`Category updated for ${model}`, 'success');
                }
                
                // Update badges to reflect new category
                updateModelSelectionBadges();
            } catch (err) {
                console.error('Failed to save category:', err);
                if (window.BenchmarkAnalytics && window.BenchmarkAnalytics.showToast) {
                    window.BenchmarkAnalytics.showToast(`Failed to save category for ${model}`, 'error');
                }
            }
        }
        window.saveModelCategory = saveModelCategory;

        // Load models for batch testing
        async function loadBatchModels(hostUrl) {
            await fetchModelRegistry();
            const host = ollamaHosts.find(h => h.url === hostUrl);
            const tbody = document.getElementById('modelSelectionTableBody');
            
            if (!tbody) return;

            if (host && host.models && host.models.length > 0) {
                tbody.innerHTML = host.models.map(model => {
                    const safeId = model.replace(/[^a-zA-Z0-9]/g, '_');
                    const safeModelJs = escapeJsString(model);
                    
                    // Get from registry or fallback to local storage (migration path) or empty
                    const registryEntry = modelRegistryCache[model];
                    const savedNote = registryEntry ? (registryEntry.userNote || '') : (localStorage.getItem(`agentx_model_note_${model}`) || '');
                    
                    // Try to find test count from global data if available
                    let testCount = '-';
                    if (window.latestBenchmarkData && window.latestBenchmarkData.model_stats) {
                        // Match both model name AND host to avoid cross-host confusion
                        const stats = window.latestBenchmarkData.model_stats.find(m => m.model === model && m.host === hostUrl);
                        if (stats) {
                             testCount = Number(stats.tests || 0) + Number(stats.failed_tests || 0);
                        }
                    }

                    // Determine category: Registry > Heuristic > Default
                    let category = 'generalist';
                    if (registryEntry && registryEntry.categories && registryEntry.categories.length > 0) {
                        category = registryEntry.categories[0];
                    } else {
                        // Heuristic fallback
                        if (model.includes('coder') || model.includes('deepseek-coder')) category = 'coding';
                        else if (model.includes('math')) category = 'reasoning'; // Map math to reasoning
                        else if (model.includes('reasoning') || model.includes('r1')) category = 'reasoning';
                        else if (model.includes('ops')) category = 'ops';
                    }
                    
                    // Collect all known categories for datalist
                    const allCategories = new Set(['generalist', 'coding', 'reasoning', 'ops', 'specialist', 'judge']);
                    Object.values(modelRegistryCache).forEach(m => {
                        if (m.categories) m.categories.forEach(c => {
                            if (c) allCategories.add(c);
                        });
                    });
                    
                    const datalistOptions = Array.from(allCategories).sort().map(c => 
                        `<option value="${c}">`
                    ).join('');
                    
                    return `
                    <tr data-model="${model}">
                        <td style="text-align: center; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <input type="checkbox" id="batch_${safeId}" value="${model}" class="batch-model-checkbox">
                        </td>
                        <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <label for="batch_${safeId}" style="cursor: pointer; font-weight: 500;">${model}</label>
                                <div class="model-badges" style="display: flex; gap: 4px;"></div>
                            </div>
                        </td>
                        <td style="text-align: center; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--muted);">
                            ${testCount}
                        </td>
                        <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <input type="text" list="category-list-${safeId}" value="${category}" 
                                onchange="saveModelCategory('${safeModelJs}', this.value)"
                                style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.1); color: var(--text); border-radius: 4px; padding: 4px 8px; font-size: 0.9em; width: 100%;">
                            <datalist id="category-list-${safeId}">
                                ${datalistOptions}
                            </datalist>
                        </td>
                        <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <input type="text" class="model-note-input" data-model="${model}" value="${savedNote}" placeholder="Add note..." 
                                style="width: 100%; background: transparent; border: none; color: var(--text); border-bottom: 1px solid transparent; padding: 4px;"
                                onfocus="this.style.borderBottom='1px solid var(--accent)'"
                                onblur="this.style.borderBottom='1px solid transparent'; saveModelNote('${safeModelJs}', this.value)">
                        </td>
                    </tr>
                `}).join('');
                
                // Update badges immediately after rendering
                updateModelSelectionBadges();
            } else {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--muted);">No models available</td></tr>';
            }

            updateBatchInfo();
            filterModelList(); // Apply initial filters if any
        }

        // Filter model list based on search and category
        function filterModelList() {
            const search = document.getElementById('modelSearchInput').value.toLowerCase();
            const category = document.getElementById('modelCategoryFilterSelect').value.toLowerCase();
            const rows = document.querySelectorAll('#modelSelectionTableBody tr[data-model]');
            let visibleCount = 0;

            rows.forEach(row => {
                const model = row.getAttribute('data-model').toLowerCase();
                const modelCategoryInput = row.querySelector('input[list^="category-list-"]');
                const modelCategory = modelCategoryInput ? modelCategoryInput.value.toLowerCase() : '';
                
                const matchesSearch = model.includes(search);
                const matchesCategory = category === '' || modelCategory === category || (category === 'specialist' && !['ops', 'coding', 'reasoning', 'generalist'].includes(modelCategory));

                if (matchesSearch && matchesCategory) {
                    row.style.display = '';
                    visibleCount++;
                } else {
                    row.style.display = 'none';
                }
            });

            document.getElementById('modelCountDisplay').textContent = `${visibleCount} models shown`;
        }

        // Select/Deselect all visible models
        function selectAllVisibleModels(select) {
            const rows = document.querySelectorAll('#modelSelectionTableBody tr[data-model]');
            rows.forEach(row => {
                if (row.style.display !== 'none') {
                    const checkbox = row.querySelector('.batch-model-checkbox');
                    if (checkbox) checkbox.checked = select;
                }
            });
            updateBatchInfo();
        }

        // Event listeners for filters
        const modelSearchInput = document.getElementById('modelSearchInput');
        if (modelSearchInput) modelSearchInput.addEventListener('input', filterModelList);
        const modelCategoryFilterSelect = document.getElementById('modelCategoryFilterSelect');
        if (modelCategoryFilterSelect) modelCategoryFilterSelect.addEventListener('change', filterModelList);

        function updateModelSelectionBadges() {
            const offenders = window.benchmarkOffenders;
            const rows = document.querySelectorAll('#modelSelectionTableBody tr[data-model]');
            
            rows.forEach(row => {
                const model = row.getAttribute('data-model');
                const badgeContainer = row.querySelector('.model-badges');
                if (!badgeContainer) return;

                let badgesHtml = '';

                // Category Badge
                if (modelRegistryCache[model] && modelRegistryCache[model].categories && modelRegistryCache[model].categories.length > 0) {
                    const cat = modelRegistryCache[model].categories[0];
                    let icon = 'fa-tag';
                    let color = '#95a5a6'; // Default gray
                    let bg = 'rgba(149, 165, 166, 0.15)';
                    
                    const lowerCat = cat.toLowerCase();
                    if (lowerCat.includes('ops') || lowerCat.includes('glue')) { 
                        icon = 'fa-bolt'; 
                        color = '#f1c40f'; 
                        bg = 'rgba(241, 196, 15, 0.15)';
                    }
                    else if (lowerCat.includes('code') || lowerCat.includes('dev')) { 
                        icon = 'fa-code'; 
                        color = '#9b59b6'; 
                        bg = 'rgba(155, 89, 182, 0.15)';
                    }
                    else if (lowerCat.includes('reason') || lowerCat.includes('think')) { 
                        icon = 'fa-brain'; 
                        color = '#e91e63'; 
                        bg = 'rgba(233, 30, 99, 0.15)';
                    }
                    else if (lowerCat.includes('special')) { 
                        icon = 'fa-star'; 
                        color = '#f39c12'; 
                        bg = 'rgba(243, 156, 18, 0.15)';
                    }
                    else if (lowerCat.includes('general')) { 
                        icon = 'fa-cubes'; 
                        color = '#3498db'; 
                        bg = 'rgba(52, 152, 219, 0.15)';
                    }
                    
                    const catDisplay = cat.charAt(0).toUpperCase() + cat.slice(1);
                    
                    badgesHtml += `<span title="Category: ${catDisplay}" style="
                        color: ${color}; 
                        background: ${bg};
                        border: 1px solid ${color}40;
                        font-size: 0.75rem; 
                        font-weight: 600;
                        padding: 2px 8px; 
                        border-radius: 12px; 
                        margin-right: 6px;
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                    ">
                        <i class="fas ${icon}" style="font-size: 0.9em;"></i> ${catDisplay}
                    </span>`;
                }

                // Offender Badges
                if (offenders) {
                    const isOffender = (offenderObj) => {
                        if (!offenderObj) return false;
                        // Handle both old format (string) and new format (object)
                        if (typeof offenderObj === 'string') return model === offenderObj;
                        // Match by model name only - the offender might be on a different host
                        // but we still want to flag the model name as problematic
                        return model === offenderObj.model;
                    };

                    if (isOffender(offenders.slowest)) {
                        badgesHtml += `<span title="⚠️ Worst Latency" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 4px;
                            font-size: 0.7rem;
                            padding: 3px 8px;
                            margin-right: 6px;
                            border-radius: 12px;
                            background: linear-gradient(135deg, rgba(231, 76, 60, 0.25) 0%, rgba(192, 57, 43, 0.15) 100%);
                            border: 1.5px solid rgba(231, 76, 60, 0.5);
                            color: #e74c3c;
                            font-weight: 700;
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            box-shadow: 0 2px 4px rgba(231, 76, 60, 0.2);
                        ">🐌 SLOW</span>`;
                    }
                    if (isOffender(offenders.lowestTps)) {
                        badgesHtml += `<span title="⚠️ Worst Throughput" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 4px;
                            font-size: 0.7rem;
                            padding: 3px 8px;
                            margin-right: 6px;
                            border-radius: 12px;
                            background: linear-gradient(135deg, rgba(230, 126, 34, 0.25) 0%, rgba(211, 84, 0, 0.15) 100%);
                            border: 1.5px solid rgba(230, 126, 34, 0.5);
                            color: #e67e22;
                            font-weight: 700;
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            box-shadow: 0 2px 4px rgba(230, 126, 34, 0.2);
                        ">🐢 SLUG</span>`;
                    }
                    if (isOffender(offenders.lowestQuality)) {
                        badgesHtml += `<span title="⚠️ Lowest Quality Score" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 4px;
                            font-size: 0.7rem;
                            padding: 3px 8px;
                            margin-right: 6px;
                            border-radius: 12px;
                            background: linear-gradient(135deg, rgba(243, 156, 18, 0.25) 0%, rgba(230, 126, 34, 0.15) 100%);
                            border: 1.5px solid rgba(243, 156, 18, 0.5);
                            color: #f39c12;
                            font-weight: 700;
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            box-shadow: 0 2px 4px rgba(243, 156, 18, 0.2);
                        ">⭐ POOR</span>`;
                    }
                    if (isOffender(offenders.mostFailures)) {
                        badgesHtml += `<span title="⚠️ Most Test Failures" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 4px;
                            font-size: 0.7rem;
                            padding: 3px 8px;
                            margin-right: 6px;
                            border-radius: 12px;
                            background: linear-gradient(135deg, rgba(192, 57, 43, 0.3) 0%, rgba(142, 36, 36, 0.2) 100%);
                            border: 1.5px solid rgba(192, 57, 43, 0.6);
                            color: #c0392b;
                            font-weight: 700;
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            box-shadow: 0 2px 4px rgba(192, 57, 43, 0.25);
                        ">⚠️ UNSTABLE</span>`;
                    }
                }

                badgeContainer.innerHTML = badgesHtml;
            });
        }
        
        // Expose to window
        window.updateModelSelectionBadges = updateModelSelectionBadges;



        // Select all models checkbox
        const selectAllModelsTable = document.getElementById('selectAllModelsTable');
        if (selectAllModelsTable) {
            selectAllModelsTable.addEventListener('change', (e) => {
                const checkboxes = document.querySelectorAll('.batch-model-checkbox');
                checkboxes.forEach(cb => cb.checked = e.target.checked);
                updateBatchInfo();
            });
        }

        // Update batch info when selections change
        document.addEventListener('change', (e) => {
            if (e.target.classList.contains('batch-model-checkbox') ||
                e.target.id.startsWith('level')) {
                updateBatchInfo();
            }
        });

        function updateBatchInfo() {
            const selectedLevels = [1, 2, 3, 4, 5].filter(l => {
                const el = document.getElementById(`level${l}`);
                return !!(el && el.checked);
            });
            const selectedModels = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'));

            // Update batch model count display
            const batchModelCountEl = document.getElementById('batchModelCount');
            if (batchModelCountEl) {
                batchModelCountEl.textContent = selectedModels.length;
            }

            // Each level has 4 prompts (from our seed data)
            const promptsPerLevel = 4;
            const totalTests = selectedLevels.length * promptsPerLevel * selectedModels.length;

            const info = document.getElementById('batchInfo');
            if (totalTests > 0) {
                info.textContent = `${selectedModels.length} models × ${selectedLevels.length} levels (${selectedLevels.length * promptsPerLevel} prompts) = ${totalTests} tests`;
            } else {
                info.textContent = 'Select levels and models to start';
            }
        }

        // Run batch test
        let currentBatchId = null;
        let batchPollInterval = null;

        function resetBatchUI() {
            const btn = document.getElementById('runBatchBtn');
            const stopBtn = document.getElementById('stopBatchBtn');
            const execProgressBar = document.getElementById('execProgressBar');
            const judgeProgressBar = document.getElementById('judgeProgressBar');
            const status = document.getElementById('batchStatus');
            const judgeHealthContainer = document.getElementById('judgeHealthContainer');
            const perModelContainer = document.getElementById('perModelProgressContainer');
            const advancedDetails = document.getElementById('advancedBatchDetails');
            const hyperDetails = document.getElementById('hyperBatchDetails');
            const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
            const toggleHyperBtn = document.getElementById('toggleHyperBtn');
            const batchLastUpdated = document.getElementById('batchLastUpdated');

            btn.disabled = false;
            btn.textContent = 'Start Batch Test';
            stopBtn.style.display = 'none';

            execProgressBar.classList.remove('active');
            judgeProgressBar.classList.remove('active');
            status.style.display = 'none';
            if (judgeHealthContainer) judgeHealthContainer.style.display = 'none';
            if (perModelContainer) perModelContainer.style.display = 'none';

            if (batchLastUpdated) batchLastUpdated.textContent = '';

            // Keep disclosure state persisted; just ensure containers reflect state.
            const showAdvanced = localStorage.getItem('benchmarkShowAdvanced') === 'true';
            const showHyper = localStorage.getItem('benchmarkShowHyper') === 'true';
            if (toggleAdvancedBtn) toggleAdvancedBtn.textContent = showAdvanced ? 'Hide details' : 'Show details';
            if (toggleHyperBtn) {
                toggleHyperBtn.style.display = showAdvanced ? 'inline-block' : 'none';
                toggleHyperBtn.textContent = showHyper ? 'Hide hyper details' : 'Show hyper details';
            }
            if (advancedDetails) advancedDetails.style.display = showAdvanced ? 'block' : 'none';
            if (hyperDetails) hyperDetails.style.display = (showAdvanced && showHyper) ? 'block' : 'none';

            if (batchPollInterval) {
                clearInterval(batchPollInterval);
                batchPollInterval = null;
            }
            currentBatchId = null;
            localStorage.removeItem('currentBatchId');

            const batchInfo = document.getElementById('batchInfo');
            if (batchInfo) batchInfo.innerHTML = '';

        }

        function setAdvancedMode(showAdvanced) {
            localStorage.setItem('benchmarkShowAdvanced', showAdvanced ? 'true' : 'false');
            if (!showAdvanced) {
                localStorage.setItem('benchmarkShowHyper', 'false');
            }

            const advancedDetails = document.getElementById('advancedBatchDetails');
            const hyperDetails = document.getElementById('hyperBatchDetails');
            const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
            const toggleHyperBtn = document.getElementById('toggleHyperBtn');
            const judgeHealthContainer = document.getElementById('judgeHealthContainer');
            const perModelContainer = document.getElementById('perModelProgressContainer');

            if (toggleAdvancedBtn) toggleAdvancedBtn.textContent = showAdvanced ? 'Hide details' : 'Show details';
            if (toggleHyperBtn) toggleHyperBtn.style.display = showAdvanced ? 'inline-block' : 'none';
            if (advancedDetails) advancedDetails.style.display = showAdvanced ? 'block' : 'none';
            if (!showAdvanced) {
                if (judgeHealthContainer) judgeHealthContainer.style.display = 'none';
                if (perModelContainer) perModelContainer.style.display = 'none';
            }

            const showHyper = localStorage.getItem('benchmarkShowHyper') === 'true';
            if (toggleHyperBtn) toggleHyperBtn.textContent = showHyper ? 'Hide hyper details' : 'Show hyper details';
            if (hyperDetails) hyperDetails.style.display = (showAdvanced && showHyper) ? 'block' : 'none';
        }

        function setHyperMode(showHyper) {
            localStorage.setItem('benchmarkShowHyper', showHyper ? 'true' : 'false');
            const toggleHyperBtn = document.getElementById('toggleHyperBtn');
            const hyperDetails = document.getElementById('hyperBatchDetails');
            if (toggleHyperBtn) toggleHyperBtn.textContent = showHyper ? 'Hide hyper details' : 'Show hyper details';
            if (hyperDetails) {
                const showAdvanced = localStorage.getItem('benchmarkShowAdvanced') === 'true';
                hyperDetails.style.display = (showAdvanced && showHyper) ? 'block' : 'none';
            }
        }

        function getAnomalyThresholds() {
            const defaults = {
                exec_fail_pct: 10,
                judge_fail_pct: 5,
                lag_factor: 5,
                avg_near_timeout_pct: 80,
                model_min_n: 5,
                model_exec_out_pct: 20,
                model_judge_out_pct: 10,
                model_tps_below_median_pct: 30,
                model_judge_ms_above_median_pct: 50
            };
            try {
                const raw = localStorage.getItem('benchmarkAnomalyThresholds');
                if (!raw) return defaults;
                const parsed = JSON.parse(raw);
                return { ...defaults, ...(parsed || {}) };
            } catch {
                return defaults;
            }
        }

        function setAnomalyThresholds(next) {
            localStorage.setItem('benchmarkAnomalyThresholds', JSON.stringify(next));
        }

        function hydrateThresholdInputs() {
            const t = getAnomalyThresholds();
            const map = [
                ['thrExecFail', 'exec_fail_pct'],
                ['thrJudgeFail', 'judge_fail_pct'],
                ['thrLagFactor', 'lag_factor'],
                ['thrAvgNearTimeout', 'avg_near_timeout_pct'],
                ['thrModelMinN', 'model_min_n'],
                ['thrModelExecOut', 'model_exec_out_pct'],
                ['thrModelJudgeOut', 'model_judge_out_pct'],
                ['thrModelTpsBelowMed', 'model_tps_below_median_pct'],
                ['thrModelJudgeMsAboveMed', 'model_judge_ms_above_median_pct']
            ];
            for (const [id, key] of map) {
                const el = document.getElementById(id);
                if (el) el.value = String(t[key]);
            }
        }

        function bindThresholdInputs() {
            const container = document.getElementById('hyperThresholds');
            if (!container || container.dataset.bound) return;
            container.addEventListener('change', () => {
                const t = getAnomalyThresholds();
                const readNum = (id, fallback) => {
                    const el = document.getElementById(id);
                    const v = el ? Number(el.value) : NaN;
                    return Number.isFinite(v) ? v : fallback;
                };
                const next = {
                    exec_fail_pct: readNum('thrExecFail', t.exec_fail_pct),
                    judge_fail_pct: readNum('thrJudgeFail', t.judge_fail_pct),
                    lag_factor: readNum('thrLagFactor', t.lag_factor),
                    avg_near_timeout_pct: readNum('thrAvgNearTimeout', t.avg_near_timeout_pct),
                    model_min_n: readNum('thrModelMinN', t.model_min_n),
                    model_exec_out_pct: readNum('thrModelExecOut', t.model_exec_out_pct),
                    model_judge_out_pct: readNum('thrModelJudgeOut', t.model_judge_out_pct),
                    model_tps_below_median_pct: readNum('thrModelTpsBelowMed', t.model_tps_below_median_pct),
                    model_judge_ms_above_median_pct: readNum('thrModelJudgeMsAboveMed', t.model_judge_ms_above_median_pct)
                };
                setAnomalyThresholds(next);
            });
            const resetBtn = document.getElementById('resetThresholdsBtn');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    localStorage.removeItem('benchmarkAnomalyThresholds');
                    hydrateThresholdInputs();
                });
            }
            container.dataset.bound = 'true';
        }

        function findRowByAttr(container, attrName, attrValue) {
            if (!container) return null;
            const rows = Array.from(container.querySelectorAll(`tr[${attrName}]`));
            return rows.find(r => r.getAttribute(attrName) === attrValue) || null;
        }

        function getResultIdOrIndex(result, index) {
            if (result && result.id) return String(result.id);
            return String(index);
        }

        function pickRepresentativeResultId(mode = 'failure') {
            const results = Array.isArray(window.currentBatchResults) ? window.currentBatchResults : [];
            if (results.length === 0) return null;

            const toNum = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };

            const isFailure = (r) => {
                const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                return m === 'exec_failed' || m === 'llm_failed' || r.success === false;
            };

            if (mode === 'worst_latency') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r) continue;
                    const latency = toNum(r.latency);
                    if (latency === null) continue;
                    if (!best || latency > best.latency) {
                        best = { latency, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            if (mode === 'worst_throughput') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r) continue;
                    const tps = toNum(r.tokens_per_sec);
                    if (tps === null) continue;
                    if (!best || tps < best.tps) {
                        best = { tps, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            if (mode === 'longest_judge') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r) continue;
                    const ms = toNum(r.scoring_time_ms);
                    if (ms === null) continue;
                    if (!best || ms > best.ms) {
                        best = { ms, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            if (mode === 'lowest_quality') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r) continue;
                    const q = toNum(r.quality_score);
                    if (q === null) continue;
                    if (!best || q < best.quality) {
                        best = { quality: q, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            // failure (default)
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r && isFailure(r)) return getResultIdOrIndex(r, i);
            }

            // fallback: first result
            return getResultIdOrIndex(results[0], 0);
        }

        function pickRepresentativeResultIdForModel(model, mode = 'failure') {
            const results = Array.isArray(window.currentBatchResults) ? window.currentBatchResults : [];
            if (!model || results.length === 0) return null;

            const isFailure = (r) => {
                const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                return m === 'exec_failed' || m === 'llm_failed' || r.success === false;
            };

            const toNum = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };

            if (mode === 'worst_latency') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r || r.model !== model) continue;
                    const latency = toNum(r.latency);
                    if (latency === null) continue;
                    if (!best || latency > best.latency) {
                        best = { latency, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            if (mode === 'worst_throughput') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r || r.model !== model) continue;
                    const tps = toNum(r.tokens_per_sec);
                    if (tps === null) continue;
                    if (!best || tps < best.tps) {
                        best = { tps, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            if (mode === 'longest_judge') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r || r.model !== model) continue;
                    const ms = toNum(r.scoring_time_ms);
                    if (ms === null) continue;
                    if (!best || ms > best.ms) {
                        best = { ms, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            if (mode === 'lowest_quality') {
                let best = null;
                let bestIdx = -1;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    if (!r || r.model !== model) continue;
                    const q = toNum(r.quality_score);
                    if (q === null) continue;
                    if (!best || q < best.quality) {
                        best = { quality: q, r };
                        bestIdx = i;
                    }
                }
                if (best && bestIdx >= 0) return getResultIdOrIndex(best.r, bestIdx);
            }

            // Prefer: a failure for that model (exec_failed/llm_failed)
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r && r.model === model && isFailure(r)) return getResultIdOrIndex(r, i);
            }

            // Else: first result for that model
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r && r.model === model) return getResultIdOrIndex(r, i);
            }

            return null;
        }

        document.getElementById('stopBatchBtn').addEventListener('click', async () => {
            if (confirm('Stop current batch? This will clear the local session.')) {
                if (currentBatchId) {
                    try {
                        const res = await fetch(`${BENCHMARK_API}/batch/${currentBatchId}/stop`, { method: 'POST' });
                        if (res.status === 404) {
                            // Batch already completed or doesn't exist - this is fine
                            console.log('Batch already completed or not found');
                        } else if (!res.ok) {
                            const json = await res.json().catch(() => ({}));
                            console.warn('Failed to stop batch:', json.error || `HTTP ${res.status}`);
                        }
                    } catch (e) {
                        console.error('Network error stopping batch', e);
                    }
                }
                resetBatchUI();
            }
        });

        document.getElementById('runBatchBtn').addEventListener('click', async () => {
            const selectedLevels = [1, 2, 3, 4, 5].filter(l =>
                document.getElementById(`level${l}`).checked
            );
            const selectedModels = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'))
                .map(cb => cb.value);
            const host = document.getElementById('host').value;
            const qualityScoring = document.getElementById('qualityScoring').checked;

            if (selectedLevels.length === 0) {
                alert('Please select at least one prompt level');
                return;
            }

            if (selectedModels.length === 0) {
                alert('Please select at least one model');
                return;
            }

            const btn = document.getElementById('runBatchBtn');
            const stopBtn = document.getElementById('stopBatchBtn');
            const status = document.getElementById('batchStatus');
            const execProgressBar = document.getElementById('execProgressBar');
            const judgeProgressBar = document.getElementById('judgeProgressBar');
            const batchInfo = document.getElementById('batchInfo');

            btn.disabled = true;
            btn.textContent = 'Starting...';
            stopBtn.style.display = 'inline-block';

            status.style.display = 'none';
            execProgressBar.classList.add('active');
            judgeProgressBar.classList.add('active');
            document.getElementById('execProgressFill').style.width = '0%';
            document.getElementById('execProgressText').textContent = 'Exec: 0%';
            document.getElementById('judgeProgressFill').style.width = '0%';
            document.getElementById('judgeProgressText').textContent = 'Judge: 0%';

            const perModelContainer = document.getElementById('perModelProgressContainer');
            if (perModelContainer) perModelContainer.style.display = 'none';

            // Clear previous results
            document.getElementById('batchResultsContainer').style.display = 'none';
            document.getElementById('batchResultsBody').innerHTML = '';
            window.currentBatchResults = [];
            window.currentJudgeDetailId = null;
            if (batchInfo) batchInfo.innerHTML = '';

            // Get tags and description
            const tagsInput = document.getElementById('batchTags');
            const descriptionInput = document.getElementById('batchDescription');
            const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t) : [];
            const description = descriptionInput ? descriptionInput.value.trim() : '';

            // Get execution mode
            const executionMode = document.getElementById('executionMode').value;

            try {
                const res = await fetch(`${BENCHMARK_API}/batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        host,
                        models: selectedModels,
                        levels: selectedLevels,
                        quality_scoring: qualityScoring,
                        judge_config: currentJudgeConfig,
                        tags,
                        description,
                        execution_mode: executionMode
                    })
                });

                const json = await res.json();

                if (json.status === 'success') {
                    currentBatchId = json.data.batch_id;
                    localStorage.setItem('currentBatchId', currentBatchId);
                    btn.textContent = qualityScoring ? 'Running (with quality)...' : 'Running...';

                    if (batchInfo) {
                        batchInfo.innerHTML = renderBatchPlan(json.data.plan, host, qualityScoring);
                    }

                    // Poll for progress
                    batchPollInterval = setInterval(pollBatchProgress, 2000);

                    // Hide active batch warning since we're now tracking it
                    refreshActiveBatch();
                } else if (res.status === 409) {
                    // Another batch is already running
                    btn.disabled = false;
                    btn.textContent = 'Start Batch Test';
                    stopBtn.style.display = 'none';
                    execProgressBar.classList.remove('active');
                    judgeProgressBar.classList.remove('active');

                    const activeBatch = json.active_batch;
                    const message = json.message || 'Another batch is already running';

                    if (activeBatch && activeBatch.is_stuck) {
                        // Offer to recover stuck batch
                        if (confirm(`${message}\n\nWould you like to recover the stuck batch and try again?`)) {
                            await recoverBatch(activeBatch.id);
                            // Retry after a brief delay
                            setTimeout(() => document.getElementById('runBatchBtn').click(), 1000);
                        }
                    } else {
                        alert(message + '\n\nYou can view the running batch by clicking "View This Batch" in the warning banner above.');
                    }

                    // Show the active batch warning
                    refreshActiveBatch();
                } else {
                    throw new Error(json.error || 'Failed to start batch');
                }
            } catch (err) {
                status.className = 'status error';
                status.textContent = `✗ Error: ${err.message}`;
                status.style.display = 'block';
                resetBatchUI();
            }
        });

        function showJudgeDetails(index) {
            let result = null;
            if (typeof index === 'string') {
                result = (window.currentBatchResults || []).find(r => r && r.id === index);
                window.currentJudgeDetailId = index;
            } else {
                result = window.currentBatchResults[index];
                window.currentJudgeDetailId = result && result.id ? result.id : null;
            }
            if (!result) return;

            // Prompt name
            document.getElementById('detailPromptName').textContent = result.prompt_name;

            // Response preview
            document.getElementById('detailResponse').textContent = result.response_preview || 'No preview available';

            // Scoring method and judge model info
            const scoringMethod = result.scoring_method || 'unknown';
            const judgeModel = result.judge_model || 'Not specified';

            let methodBadge = '';
            let judgePromptText = '';
            let explanationText = '';

            if (scoringMethod === 'quick' || scoringMethod === 'quick_scored') {
                methodBadge = '<span style="background: linear-gradient(135deg, #3498db 0%, #2ecc71 100%); color: white; padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 600; display: inline-block; margin-bottom: 8px;">⚡ Quick Pattern Match</span>';
                judgePromptText = 'Quick scoring used (no judge model invoked).';
                const expectedAnswer = result.expected_answer || 'expected answer unavailable';
                const quickInfo = result.quick_pattern ? ` Pattern: "${result.quick_pattern}"` : '';
                explanationText = result.quality_explanation || `Quick scoring compared response against expected answer "${expectedAnswer}".${quickInfo}`;
            } else if (scoringMethod === 'llm_judge' || scoringMethod === 'llm_judged') {
                methodBadge = `<span style="background: linear-gradient(135deg, #9b59b6 0%, #e74c3c 100%); color: white; padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 600; display: inline-block; margin-bottom: 8px;">🤖 LLM Judge</span> <span style="color: var(--muted); font-size: 0.85em; margin-left: 8px;">Model: ${judgeModel}</span>`;
                judgePromptText = result.judge_prompt || 'Judge prompt not available';
                explanationText = result.quality_explanation || 'No explanation available';
            } else if (scoringMethod === 'exec_failed') {
                methodBadge = '<span style="background: rgba(238, 176, 255, 0.15); color: var(--accent-2); border: 1px solid rgba(238, 176, 255, 0.35); padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 700; display: inline-block; margin-bottom: 8px;">⚠️ Execution Failed (no judge output)</span>';
                judgePromptText = 'No judge prompt: execution failed before a response could be judged.';
                explanationText = result.error || result.quality_explanation || 'The model call failed, so there was nothing to judge.';
            } else if (scoringMethod === 'llm_failed') {
                methodBadge = '<span style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 600; display: inline-block; margin-bottom: 8px;">❌ Judge Failed</span>';
                judgePromptText = result.judge_prompt || 'Judge prompt attempted but failed';
                explanationText = result.quality_explanation || result.error || 'Judge model encountered an error. Quality score could not be determined.';
            } else if (scoringMethod === 'pending') {
                methodBadge = '<span style="background: linear-gradient(135deg, #f1c40f 0%, #f39c12 100%); color: #1a1a1a; padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 700; display: inline-block; margin-bottom: 8px;">⏳ Scoring Pending</span>';
                judgePromptText = 'Quality scoring is pending. Please wait for judge results.';
                explanationText = 'Scoring has not completed yet.';
            } else if (scoringMethod === 'disabled') {
                methodBadge = '<span style="background: rgba(255,255,255,0.1); color: var(--muted); padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 600; display: inline-block; margin-bottom: 8px;">🚫 Quality Scoring Disabled</span>';
                judgePromptText = 'Quality scoring was disabled for this run.';
                explanationText = 'No judge prompt or explanation available because scoring was disabled.';
            } else {
                methodBadge = '<span style="background: rgba(255,255,255,0.1); color: var(--muted); padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 600; display: inline-block; margin-bottom: 8px;">❓ Unknown Method</span>';
                judgePromptText = 'Scoring method unknown or not recorded';
                explanationText = result.quality_explanation || 'No explanation available';
            }

            // Populate modal fields
            document.getElementById('detailScoringMethod').innerHTML = methodBadge;
            document.getElementById('detailJudgePrompt').textContent = judgePromptText;
            document.getElementById('detailExplanation').textContent = explanationText;

            // Scores
            const qualityScore = result.quality_score !== undefined && result.quality_score !== null ? result.quality_score : 'N/A';
            const compositeScore = result.composite_score !== undefined && result.composite_score !== null ? result.composite_score : 'N/A';
            document.getElementById('detailQualityScore').textContent = qualityScore;
            document.getElementById('detailCompositeScore').textContent = compositeScore;

            // Composite Breakdown
            const breakdownContainer = document.getElementById('detailCompositeBreakdown');
            if (result.normalized_scores && result.composite_score !== undefined && breakdownContainer) {
                const n = result.normalized_scores;
                breakdownContainer.innerHTML = `
                 <div style="font-size: 0.9em; color: var(--muted); background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; border: 1px solid var(--panel-border);">
                    <div style="margin-bottom: 8px; font-weight: 600; color: var(--text); display:flex; justify-content:space-between;">
                        <span>Composite Score Calculation</span>
                        <i class="fas fa-calculator" style="color:var(--accent);"></i>
                    </div>
                    <div style="display: grid; grid-template-columns: 80px 1fr 90px; gap: 8px; align-items: center; font-size: 0.9em;">
                        
                        <div style="color: #2ecc71; font-weight:500;">Quality</div>
                        <div style="height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow:hidden;">
                            <div style="width: ${n.quality * 10}%; height: 100%; background: #2ecc71;"></div>
                        </div>
                        <div style="text-align:right;">${n.quality} <span style="color:#666;">× 50%</span></div>
                        
                        <div style="color: #3498db; font-weight:500;">Latency</div>
                        <div style="height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow:hidden;">
                            <div style="width: ${n.latency * 10}%; height: 100%; background: #3498db;"></div>
                        </div>
                        <div style="text-align:right;">${n.latency} <span style="color:#666;">× 30%</span></div>
                        
                        <div style="color: #9b59b6; font-weight:500;">Speed</div>
                        <div style="height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow:hidden;">
                            <div style="width: ${n.speed * 10}%; height: 100%; background: #9b59b6;"></div>
                        </div>
                        <div style="text-align:right;">${n.speed} <span style="color:#666;">× 20%</span></div>
                        
                        <div style="grid-column: 1 / -1; height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0;"></div>
                        
                        <div style="grid-column: 1 / 2; color: var(--text); font-weight:bold;">Total</div>
                        <div style="grid-column: 2 / 3;"></div>
                        <div style="grid-column: 3 / 4; text-align:right; font-weight:bold; color: var(--accent);">${compositeScore}</div>
                    </div>
                 </div>
                 `;
            } else if (breakdownContainer) {
                breakdownContainer.innerHTML = '';
            }

            // Step-by-step judging view
            const method = (result.scoring_method || 'unknown').toLowerCase();
            const steps = [];

            if (method === 'exec_failed' || result.success === false) {
                steps.push({ label: 'Executed test', state: 'failed' });
                steps.push({ label: 'Judging skipped (no response)', state: 'done' });
            } else {
                steps.push({ label: 'Generated response', state: 'done' });
            }

            if (method === 'exec_failed') {
                // Already handled above.
            } else if (method === 'disabled') {
                steps.push({ label: 'Judging disabled', state: 'done' });
            } else if (method === 'pending') {
                steps.push({ label: 'Queued for judging', state: 'done' });
                steps.push({ label: 'Scoring in progress', state: 'current' });
            } else if (method === 'quick_scored') {
                steps.push({ label: 'Queued for judging', state: 'done' });
                steps.push({ label: 'Quick scoring complete', state: 'done' });
            } else if (method === 'llm_judged' || method === 'llm_judge') {
                steps.push({ label: 'Queued for judging', state: 'done' });
                steps.push({ label: 'LLM judging complete', state: 'done' });
            } else if (method === 'llm_failed') {
                steps.push({ label: 'Queued for judging', state: 'done' });
                steps.push({ label: 'LLM judging failed', state: 'failed' });
            } else {
                steps.push({ label: 'Judging state unknown', state: 'current' });
            }

            const stepHtml = steps.map(s => {
                const color = s.state === 'done' ? 'var(--accent)' : (s.state === 'failed' ? '#e74c3c' : 'var(--muted)');
                const icon = s.state === 'done' ? '<i class="fas fa-check"></i>' : (s.state === 'failed' ? '<i class="fas fa-times"></i>' : '<i class="fas fa-ellipsis-h"></i>');
                return `<div style="display:flex; gap:10px; align-items:center; margin: 6px 0; color:${color};">${icon}<span>${s.label}</span></div>`;
            }).join('');
            document.getElementById('detailJudgeSteps').innerHTML = stepHtml;

            const updatedAt = result.timestamp ? new Date(result.timestamp).toLocaleString() : 'unknown';
            const judgeHost = result.judge_host ? formatHostLabel(result.judge_host) : 'N/A';
            const judgeModelName = result.judge_model || currentJudgeConfig.model || 'N/A';
            const judgeDuration = result.scoring_time_ms ? `${(result.scoring_time_ms / 1000).toFixed(2)}s` : 'N/A';
            const scoringType = result.scoring_type ? result.scoring_type.charAt(0).toUpperCase() + result.scoring_type.slice(1) : 'Standard';

            document.getElementById('detailJudgeMeta').innerHTML = `
                <div class="d-flex flex-wrap gap-3 align-items-center p-2 bg-dark rounded border border-secondary">
                    <div title="Last Updated"><i class="far fa-clock me-1 text-muted"></i> ${updatedAt}</div>
                    <div class="vr text-secondary"></div>
                    <div title="Judge Host"><i class="fas fa-server me-1 text-muted"></i> ${judgeHost}</div>
                    <div class="vr text-secondary"></div>
                    <div title="Judge Model"><i class="fas fa-robot me-1 text-muted"></i> ${judgeModelName}</div>
                    <div class="vr text-secondary"></div>
                    <div title="Judge Duration"><i class="fas fa-stopwatch me-1 text-muted"></i> ${judgeDuration}</div>
                    <div class="vr text-secondary"></div>
                    <div title="Scoring Type"><i class="fas fa-tasks me-1 text-muted"></i> ${scoringType}</div>
                </div>
            `;

            document.getElementById('judgeDetailsModal').style.display = 'block';
        }

        async function loadBatchHistory() {
            const container = document.getElementById('batchHistoryList');
            if (!container) return;
            
            try {
                const res = await fetch(`${BENCHMARK_API}/batches`);
                const json = await res.json();
                
                if (json.status === 'success' && json.data.batches) {
                    if (json.data.batches.length === 0) {
                        container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 15px;">No previous batches found<br/><span style="font-size: 0.9em;">(Batch runs appear here — Quick Single Tests show under Recent Tests)</span></div>';
                        return;
                    }
                    
                    container.innerHTML = json.data.batches.map(b => {
                        const date = new Date(b.created_at).toLocaleString();
                        const statusColor = b.status === 'completed' ? '#2ecc71' : (b.status === 'failed' ? '#e74c3c' : '#f1c40f');
                        const qualityBadge = b.quality_scoring ? '<span class="badge bg-primary" style="font-size: 0.7em; padding: 2px 6px; margin-left: 6px;">Quality</span>' : '';
                        const isCurrent = currentBatchId === b._id;
                        const activeClass = isCurrent ? 'background: rgba(255,255,255,0.1); border-left: 3px solid var(--accent);' : '';
                        
                        return `
                            <div class="history-item" onclick="loadBatchDetails('${b._id}')" style="padding: 12px; border-bottom: 1px solid var(--panel-border); cursor: pointer; transition: background 0.2s; ${activeClass}">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <div style="font-weight: 600; color: var(--text); font-size: 0.95em;">${b.run_name || 'Untitled Batch'}</div>
                                    <div style="font-size: 0.8em; color: var(--muted);">${date}</div>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
                                    <div style="font-size: 0.85em; color: var(--muted);">
                                        ${b.models ? b.models.length : 0} models • ${b.total_tests || 0} tests
                                        ${qualityBadge}
                                    </div>
                                    <div style="font-size: 0.85em; color: ${statusColor}; text-transform: capitalize; font-weight: 500;">
                                        ${b.status}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');
                    
                    // Add hover effect via JS
                    document.querySelectorAll('.history-item').forEach(item => {
                        if (!item.style.background.includes('rgba')) {
                            item.onmouseover = () => item.style.background = 'rgba(255,255,255,0.05)';
                            item.onmouseout = () => item.style.background = 'transparent';
                        }
                    });

                    // Also populate batch comparison dropdowns
                    const batch1Select = document.getElementById('compareBatch1');
                    const batch2Select = document.getElementById('compareBatch2');
                    if (batch1Select && batch2Select) {
                        const batchOptions = json.data.batches
                            .filter(b => b.status === 'completed')
                            .map(b => `<option value="${b._id}">${b.run_name || 'Untitled'} - ${new Date(b.created_at).toLocaleDateString()}</option>`)
                            .join('');
                        batch1Select.innerHTML = '<option value="">Select batch...</option>' + batchOptions;
                        batch2Select.innerHTML = '<option value="">Select batch...</option>' + batchOptions;
                    }

                }
            } catch (err) {
                console.error('Failed to load history:', err);
                container.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 15px;">Failed to load history</div>';
            }
        }

        async function refreshActiveBatch() {
            try {
                const res = await fetch(`${BENCHMARK_API}/batches/active`);
                const json = await res.json();

                if (json.status === 'success' && Array.isArray(json.data) && json.data.length > 0) {
                    const warning = document.getElementById('activeBatchWarning');
                    const info = document.getElementById('activeBatchInfo');

                    const batch = json.data[0]; // Single batch system

                    // If this is OUR current batch, don't show the warning
                    if (batch._id === currentBatchId) {
                        warning.style.display = 'none';
                        return;
                    }

                    warning.style.display = 'block';
                    const inactiveSeconds = batch.inactive_seconds || 0;
                    const activityStatus = batch.activity_status || 'active';
                    const isStuck = batch.is_stuck || false;

                    const statusColor = isStuck ? '#e74c3c' : (activityStatus === 'slow' ? '#f39c12' : '#2ecc71');
                    const statusIcon = isStuck ? 'fa-exclamation-circle' : (activityStatus === 'slow' ? 'fa-clock' : 'fa-circle');
                    const statusText = isStuck ? 'STUCK' : (activityStatus === 'slow' ? 'SLOW' : 'ACTIVE');

                    const progress = batch.progress || 0;
                    const judgeProgress = batch.judge_progress || 0;

                    info.innerHTML = `
                        <div style="padding: 12px; background: rgba(0,0,0,0.2); border-radius: 8px; border-left: 4px solid ${statusColor};">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <div style="font-weight: 600; color: var(--text); margin-bottom: 4px;">
                                        ${batch.run_name || 'Untitled Batch'}
                                    </div>
                                    <div style="font-size: 0.85em; color: var(--muted);">
                                        ${batch.models ? batch.models.length : 0} models • ${batch.completed}/${batch.total_tests} tests
                                        ${batch.judge_total > 0 ? ` • ${batch.judge_completed}/${batch.judge_total} judged` : ''}
                                    </div>
                                    <div style="font-size: 0.8em; color: var(--muted); margin-top: 2px;">
                                        Last activity: ${inactiveSeconds < 60 ? `${inactiveSeconds}s ago` : `${Math.floor(inactiveSeconds / 60)}m ago`}
                                    </div>
                                    ${batch.current_test && batch.current_test.model ? `
                                        <div style="margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 6px;">
                                            <div style="font-size: 0.85em; color: var(--accent); font-weight: 500;">
                                                <i class="fas fa-cogs"></i> Currently testing: <strong>${batch.current_test.model}</strong>
                                            </div>
                                            <div style="font-size: 0.8em; color: var(--muted); margin-top: 2px;">
                                                ${batch.current_test.prompt_name || batch.current_test.prompt_id || 'Unknown prompt'}
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                                <div style="text-align: right;">
                                    <div style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(0,0,0,0.3); border-radius: 16px; margin-bottom: 8px;">
                                        <i class="fas ${statusIcon}" style="color: ${statusColor}; font-size: 0.9em;"></i>
                                        <span style="color: ${statusColor}; font-weight: 600; font-size: 0.85em;">${statusText}</span>
                                    </div>
                                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                                        <button class="btn-secondary btn-sm" onclick="attachToBatch('${batch._id}')" style="padding: 6px 12px; font-size: 0.85em;">
                                            <i class="fas fa-link"></i> View This Batch
                                        </button>
                                        ${isStuck ? `<button class="btn-secondary btn-sm" onclick="recoverBatch('${batch._id}')" style="padding: 6px 12px; font-size: 0.85em; background: rgba(231, 76, 60, 0.2); border-color: rgba(231, 76, 60, 0.5); color: #e74c3c;">
                                            <i class="fas fa-life-ring"></i> Recover
                                        </button>` : ''}
                                    </div>
                                </div>
                            </div>
                            <div style="margin-top: 8px; display: flex; gap: 10px;">
                                <div style="flex: 1;">
                                    <div style="height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                                        <div style="height: 100%; width: ${progress}%; background: var(--accent); transition: width 0.3s;"></div>
                                    </div>
                                    <div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">Exec: ${progress}%</div>
                                </div>
                                ${batch.judge_total > 0 ? `<div style="flex: 1;">
                                    <div style="height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                                        <div style="height: 100%; width: ${judgeProgress}%; background: #9b59b6; transition: width 0.3s;"></div>
                                    </div>
                                    <div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">Judge: ${judgeProgress}%</div>
                                </div>` : ''}
                            </div>
                        </div>
                    `;
                } else {
                    document.getElementById('activeBatchWarning').style.display = 'none';
                }
            } catch (err) {
                console.error('Failed to fetch active batch:', err);
            }
        }

        // Keep the old function name for compatibility but redirect to single batch
        const refreshActiveBatches = refreshActiveBatch;

        async function attachToBatch(batchId) {
            if (!currentBatchId || confirm('Switch to viewing this batch? Your current view will be replaced.')) {
                currentBatchId = batchId;
                localStorage.setItem('currentBatchId', batchId);
                await loadBatchDetails(batchId);
                refreshActiveBatch(); // Hide warning once attached
            }
        }

        async function recoverBatch(batchId) {
            if (!confirm('Mark this batch as stopped? This will allow you to start a new batch.')) {
                return;
            }

            try {
                const res = await fetch(`${BENCHMARK_API}/batch/${batchId}/recover`, {
                    method: 'POST'
                });
                const json = await res.json();

                if (json.status === 'success') {
                    alert('Batch marked as stopped successfully. You can now start a new batch.');
                    refreshActiveBatch();
                    loadBatchHistory();
                } else {
                    alert(`Failed to recover batch: ${json.error || 'Unknown error'}`);
                }
            } catch (err) {
                console.error('Failed to recover batch:', err);
                alert(`Error: ${err.message}`);
            }
        }

        async function loadBatchDetails(batchId) {
            if (currentBatchId === batchId) return; // Already viewing
            
            // Stop any active polling for previous batch
            if (batchPollInterval) {
                clearInterval(batchPollInterval);
                batchPollInterval = null;
            }
            
            currentBatchId = batchId;
            localStorage.setItem('currentBatchId', batchId);
            
            // Reset UI elements
            document.getElementById('batchResultsContainer').style.display = 'none';
            document.getElementById('batchResultsBody').innerHTML = '';
            document.getElementById('batchStatus').style.display = 'none';
            document.getElementById('batchInfo').innerHTML = '';
            
            // Update history selection visually
            loadBatchHistory(); 
            
            // Trigger poll immediately to load data
            await pollBatchProgress();
            
            // Scroll to top of batch section
            document.querySelector('.batch-section').scrollIntoView({ behavior: 'smooth' });
        }

        async function pollBatchProgress() {
            if (!currentBatchId) return;

            try {
                const res = await fetch(`${BENCHMARK_API}/batch/${currentBatchId}`);

                if (res.status === 429) {
                    console.warn('Rate limited polling batch progress, skipping...');
                    const status = document.getElementById('batchStatus');
                    if (status.style.display !== 'none') {
                        status.textContent = 'Connection limited, retrying...';
                    }
                    return;
                }

                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`);
                }

                const json = await res.json();
                const batch = json.data;

                if (!batch) {
                    throw new Error('No batch data in response');
                }

                const showAdvanced = localStorage.getItem('benchmarkShowAdvanced') === 'true';
                const showHyper = localStorage.getItem('benchmarkShowHyper') === 'true';
                const results = Array.isArray(batch.results) ? batch.results : [];

                // Get level-specific gradient for progress bars
                const getLevelGradient = (level) => {
                    const lvl = Number(level);
                    switch (lvl) {
                        case 1: return 'linear-gradient(90deg, #dc2626 0%, #f87171 100%)'; // Red
                        case 2: return 'linear-gradient(90deg, #10b981 0%, #34d399 100%)'; // Green
                        case 3: return 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%)'; // Yellow
                        case 4: return 'linear-gradient(90deg, #06b6d4 0%, #22d3ee 100%)'; // Blue/Cyan
                        case 5: return 'linear-gradient(90deg, #ffd700 0%, #ffed4e 100%)'; // Gold
                        default: return 'linear-gradient(90deg, var(--accent) 0%, rgba(238, 176, 255, 0.8) 100%)'; // Default
                    }
                };

                const clampedProgress = Math.min(Number(batch.progress) || 0, 100);
                const execBar = document.getElementById('execProgressBar');
                const execFill = document.getElementById('execProgressFill');
                const execTextEl = document.getElementById('execProgressText');
                if (execBar && execFill && execTextEl) {
                    execBar.classList.add('active');
                    // Set background based on current test level
                    const currentLevel = batch.current_test && batch.current_test.prompt_level;
                    execFill.style.background = currentLevel ? getLevelGradient(currentLevel) : '';
                    execFill.style.width = `${clampedProgress}%`;
                    execFill.style.borderRadius = clampedProgress >= 99 ? '16px' : '16px 0 0 16px';
                    execTextEl.textContent = `Exec: ${clampedProgress}% (${batch.completed}/${batch.total_tests})`;
                }

                const judgeTotal = Number(batch.judge_total) || 0;
                const judgeTotalEffective = Number(batch.judge_total_effective ?? (batch.judge_stats ? batch.judge_stats.total : null)) || 0;
                const judgeCompleted = Number(batch.judge_completed) || 0;
                const judgeProgressPlanned = Math.min(Number(batch.judge_progress) || 0, 100);
                const judgeProgressEffective = Math.min(Number(batch.judge_progress_effective ?? (batch.judge_total_effective ? (judgeTotalEffective > 0 ? Math.round((judgeCompleted / judgeTotalEffective) * 100) : 0) : null)) || 0, 100);

                const judgeBar = document.getElementById('judgeProgressBar');
                const judgeFill = document.getElementById('judgeProgressFill');
                const judgeTextEl = document.getElementById('judgeProgressText');
                if (judgeBar && judgeFill && judgeTextEl) {
                    if (judgeTotal > 0) {
                        judgeBar.classList.add('active');
                        judgeFill.style.width = `${judgeProgressPlanned}%`;
                        judgeFill.style.borderRadius = judgeProgressPlanned >= 99 ? '16px' : '16px 0 0 16px';

                        const effSuffix = (judgeTotalEffective > 0 && judgeTotalEffective !== judgeTotal)
                            ? ` • eff: ${judgeProgressEffective}% (${judgeCompleted}/${judgeTotalEffective})`
                            : '';
                        judgeTextEl.textContent = `Judge: ${judgeProgressPlanned}% (${judgeCompleted}/${judgeTotal})${effSuffix}`;
                    } else {
                        judgeBar.classList.remove('active');
                    }
                }

                const batchLastUpdated = document.getElementById('batchLastUpdated');
                if (batchLastUpdated) {
                    batchLastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
                }

                // Update Current Test Indicator with Enhanced Details
                const currentTestIndicator = document.getElementById('currentTestIndicator');
                const currentTest = batch.current_test;
                if (currentTest && currentTest.model && currentTest.stage !== 'idle' && batch.status === 'running') {
                    currentTestIndicator.style.display = 'block';

                    const stageIcon = currentTest.stage === 'judging' ? '<i class="fas fa-gavel"></i>' : '<i class="fas fa-cogs"></i>';
                    const stageText = currentTest.stage === 'judging' ? 'Judging Response' : 'Executing Test';

                    // Add test number and level info with themed colors
                    const testNum = currentTest.test_number || (batch.completed + 1);
                    const totalTests = batch.total_tests || 0;
                    const getLevelBadgeStyle = (level) => {
                        const lvl = Number(level);
                        switch (lvl) {
                            case 1: return 'background: rgba(220, 38, 38, 0.2); color: #f87171;'; // Red
                            case 2: return 'background: rgba(16, 185, 129, 0.2); color: #34d399;'; // Green
                            case 3: return 'background: rgba(245, 158, 11, 0.2); color: #fbbf24;'; // Yellow
                            case 4: return 'background: rgba(6, 182, 212, 0.2); color: #22d3ee;'; // Blue/Cyan
                            case 5: return 'background: rgba(255, 215, 0, 0.2); color: #ffed4e;'; // Gold
                            default: return 'background: rgba(46, 204, 113, 0.2); color: #2ecc71;'; // Fallback
                        }
                    };
                    const levelBadge = currentTest.prompt_level ? ` <span style="${getLevelBadgeStyle(currentTest.prompt_level)} padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: 600;">L${currentTest.prompt_level}</span>` : '';

                    document.getElementById('currentTestStage').innerHTML = `${stageIcon} ${stageText} <span style="color: var(--muted); font-weight: 400;">(${testNum}/${totalTests})</span>${levelBadge}`;
                    document.getElementById('currentTestModel').textContent = currentTest.model || '';
                    document.getElementById('currentTestPrompt').textContent = currentTest.prompt_name || currentTest.prompt_id || 'Unknown';

                    // Calculate duration with sub-second precision
                    if (currentTest.started_at) {
                        const duration = (Date.now() - new Date(currentTest.started_at).getTime()) / 1000;
                        const durationText = duration < 10
                            ? `${duration.toFixed(1)}s`
                            : `${Math.floor(duration)}s`;
                        document.getElementById('currentTestDuration').textContent = durationText;

                        // Add warning if test is taking too long (> 60s)
                        if (duration > 60) {
                            document.getElementById('currentTestDuration').innerHTML = `${durationText} <span style="color: #f39c12; margin-left: 4px;"><i class="fas fa-exclamation-triangle"></i></span>`;
                        }
                    }
                } else if (batch.status === 'judging') {
                    // Show that we're in judging phase
                    currentTestIndicator.style.display = 'block';
                    document.getElementById('currentTestStage').innerHTML = '<i class="fas fa-gavel"></i> Judging Responses';
                    document.getElementById('currentTestModel').textContent = '';
                    document.getElementById('currentTestPrompt').textContent = `${judgeCompleted}/${judgeTotal} scored`;
                    document.getElementById('currentTestDuration').textContent = '';
                } else {
                    currentTestIndicator.style.display = 'none';
                }

                // Update Timeline (if running or has events)
                const timelineContainer = document.getElementById('timelineContainer');
                if (batch.status === 'running' || batch.status === 'judging' || batch.status === 'completed') {
                    if (batch.timeline && batch.timeline.length > 0) {
                        timelineContainer.style.display = 'block';
                        updateTimeline(batch);
                    }
                } else {
                    timelineContainer.style.display = 'none';
                }

                // Update Judge Health Stats
                const judgeHealthContainer = document.getElementById('judgeHealthContainer');
                if (batch.judge_stats && judgeTotal > 0 && showAdvanced) {
                    const stats = batch.judge_stats;
                    const lag = stats.lag || 0;
                    const avgTime = stats.avg_time_ms ? (stats.avg_time_ms / 1000).toFixed(2) + 's' : '-';
                    const pending = Number.isFinite(stats.pending) ? stats.pending : Math.max(0, judgeTotal - judgeCompleted);
                    const judgeFailed = stats.failed || 0;
                    const execFailed = stats.exec_failed || 0;
                    const timeoutMs = stats.timeout_ms || currentJudgeConfig.timeout || 30000;
                    const etaAvg = stats.eta_avg_ms ? formatDuration(stats.eta_avg_ms) : '-';
                    const etaWorst = stats.eta_worst_ms ? formatDuration(stats.eta_worst_ms) : '-';
                    
                    // Determine health status based on lag
                    // Lag > 5 is warning, > 10 is critical (assuming concurrency ~2)
                    let healthColor = '#2ecc71'; // Green
                    let healthIcon = '<i class="fas fa-check-circle"></i>';
                    let healthText = 'Healthy';
                    
                    if (lag > 10) {
                        healthColor = '#e74c3c'; // Red
                        healthIcon = '<i class="fas fa-exclamation-triangle"></i>';
                        healthText = 'Overloaded';
                    } else if (lag > 4) {
                        healthColor = '#f1c40f'; // Yellow
                        healthIcon = '<i class="fas fa-clock"></i>';
                        healthText = 'Busy';
                    }

                    const latencyStats = summarizeNumbers(results.map(r => r && r.latency));
                    const tpsStats = summarizeNumbers(results.map(r => r && r.tokens_per_sec).filter(v => Number(v) > 0));
                    const judgeMsStats = summarizeNumbers(results.map(r => r && r.scoring_time_ms).filter(v => Number(v) > 0));
                    const qualityStats = summarizeNumbers(results.map(r => r && r.quality_score));

                    const execHostCounts = countBy(results, (r) => r && r.host ? formatHostLabel(r.host) : null);
                    const judgeHostCounts = countBy(results, (r) => r && r.judge_host ? formatHostLabel(r.judge_host) : null);
                    const methodCounts = countBy(results, (r) => {
                        const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                        return m || null;
                    });
                    const topExecHosts = topCounts(execHostCounts, 3);
                    const topJudgeHosts = topCounts(judgeHostCounts, 3);
                    const topMethods = topCounts(methodCounts, 4);

                    const fmtMs = (ms) => (ms === null ? '-' : `${Math.round(ms)}ms`);
                    const fmtSec = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(2)}s`);
                    const fmtNum = (n, digits = 2) => (n === null ? '-' : Number(n).toFixed(digits));
                    const fmtQuality = (q) => (q === null ? '-' : Number(q).toFixed(2));
                    const fmtTop = (arr) => arr.length === 0
                        ? '-'
                        : arr.map(e => `${e.key}:${e.count}`).join(' ');

                    // Per-model offenders (clickable)
                    const models = Array.from(new Set(results.map(r => r && r.model).filter(Boolean)));
                    const perModelPerf = models.map(model => {
                        const modelResults = results.filter(r => r && r.model === model);
                        const lat = summarizeNumbers(modelResults.map(r => r && r.latency));
                        const tps = summarizeNumbers(modelResults.map(r => r && r.tokens_per_sec).filter(v => Number(v) > 0));
                        const judge = summarizeNumbers(modelResults.map(r => r && r.scoring_time_ms).filter(v => Number(v) > 0));
                        const quality = summarizeNumbers(modelResults.map(r => r && r.quality_score));
                        return { model, lat, tps, judge, quality };
                    });
                    const pickMax = (arr, getVal) => {
                        let best = null;
                        for (const item of arr) {
                            const v = getVal(item);
                            if (!Number.isFinite(v)) continue;
                            if (!best || v > best.v) best = { item, v };
                        }
                        return best ? best.item : null;
                    };
                    const pickMin = (arr, getVal) => {
                        let best = null;
                        for (const item of arr) {
                            const v = getVal(item);
                            if (!Number.isFinite(v)) continue;
                            if (!best || v < best.v) best = { item, v };
                        }
                        return best ? best.item : null;
                    };

                    const worstLatencyModel = pickMax(perModelPerf, (p) => p.lat && Number.isFinite(p.lat.p95) ? p.lat.p95 : null);
                    const worstThroughputModel = pickMin(perModelPerf, (p) => p.tps && Number.isFinite(p.tps.p10) ? p.tps.p10 : null);
                    const longestJudgeModel = pickMax(perModelPerf, (p) => p.judge && Number.isFinite(p.judge.p95) ? p.judge.p95 : null);
                    const lowestQualityModel = pickMin(perModelPerf, (p) => p.quality && Number.isFinite(p.quality.p10) ? p.quality.p10 : null);

                    const offenderChip = (label, model, mode, valueText) => {
                        if (!model || !model.model) return '';
                        const safeModel = String(model.model).replace(/"/g, '&quot;');
                        const safeValue = valueText ? String(valueText).replace(/"/g, '&quot;') : '';
                        return `<button type="button" class="btn-secondary" data-action="inspect-model" data-model="${safeModel}" data-mode="${mode}" style="padding: 4px 8px;" title="${label}: ${safeModel}${safeValue ? ` (${safeValue})` : ''}">${label}: <span style="font-weight:700;">${safeModel}</span>${safeValue ? ` <span style=\"color: var(--muted);\">(${safeValue})</span>` : ''}</button>`;
                    };

                    const chips = [
                        offenderChip('Worst latency', worstLatencyModel, 'worst_latency', worstLatencyModel && worstLatencyModel.lat && Number.isFinite(worstLatencyModel.lat.p95) ? `${Math.round(worstLatencyModel.lat.p95)}ms p95` : ''),
                        offenderChip('Worst throughput', worstThroughputModel, 'worst_throughput', worstThroughputModel && worstThroughputModel.tps && Number.isFinite(worstThroughputModel.tps.p10) ? `${worstThroughputModel.tps.p10.toFixed(2)} t/s p10` : ''),
                        offenderChip('Longest judge', longestJudgeModel, 'longest_judge', longestJudgeModel && longestJudgeModel.judge && Number.isFinite(longestJudgeModel.judge.p95) ? `${Math.round(longestJudgeModel.judge.p95)}ms p95` : ''),
                        offenderChip('Lowest quality', lowestQualityModel, 'lowest_quality', lowestQualityModel && lowestQualityModel.quality && Number.isFinite(lowestQualityModel.quality.p10) ? `${lowestQualityModel.quality.p10.toFixed(2)} p10` : '')
                    ].filter(Boolean);

                    const offenderStrip = chips.length > 0
                        ? `<div style="width: 100%; margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; align-items:center;">
                            <div style="color: var(--muted); font-size: 0.85em; margin-right: 4px;">Top offenders:</div>
                            ${chips.join('')}
                           </div>`
                        : '';

                    judgeHealthContainer.style.display = 'block';
                    judgeHealthContainer.classList.add('judge-health-grid');
                    judgeHealthContainer.innerHTML = `
                        <div class="judge-health-main">
                            <div style="color: ${healthColor}; font-weight: 600;">
                                ${healthIcon} Judge Status: ${healthText}
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Items waiting to be judged">
                                <span style="color: var(--muted);">Queue Lag:</span> 
                                <span style="font-weight: 600; color: ${lag > 5 ? '#f1c40f' : 'var(--text)'};">${lag}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Items remaining to be judged">
                                <span style="color: var(--muted);">Pending:</span>
                                <span style="font-weight: 600;">${pending}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Judge failures">
                                <span style="color: var(--muted);">Judge Failed:</span>
                                <span style="font-weight: 600;">${judgeFailed}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Execution failures (no judgeable output)">
                                <span style="color: var(--muted);">Exec Failed:</span>
                                <span style="font-weight: 600;">${execFailed}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Average time per judgment">
                                <span style="color: var(--muted);">Avg Time:</span> 
                                <span style="font-weight: 600;">${avgTime}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="ETA based on average judge time">
                                <span style="color: var(--muted);">ETA (avg):</span>
                                <span style="font-weight: 600;">${etaAvg}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Worst-case ETA using configured timeout">
                                <span style="color: var(--muted);">ETA (worst):</span>
                                <span style="font-weight: 600;">${etaWorst}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Latency distribution (all results with numeric latency)">
                                <span style="color: var(--muted);">Latency p50/p95:</span>
                                <span style="font-weight: 600;">${fmtMs(latencyStats.p50)} / ${fmtMs(latencyStats.p95)}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Throughput distribution (tokens/sec, numeric > 0)">
                                <span style="color: var(--muted);">t/s p50/p10:</span>
                                <span style="font-weight: 600;">${fmtNum(tpsStats.p50)} / ${fmtNum(tpsStats.p10)}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Judge time distribution (ms, numeric > 0)">
                                <span style="color: var(--muted);">Judge ms p50/p95:</span>
                                <span style="font-weight: 600;">${fmtMs(judgeMsStats.p50)} / ${fmtMs(judgeMsStats.p95)}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Quality score distribution (0-10)">
                                <span style="color: var(--muted);">Quality p50/p10:</span>
                                <span style="font-weight: 600;">${fmtQuality(qualityStats.p50)} / ${fmtQuality(qualityStats.p10)}</span>
                            </div>
                            ${offenderStrip}
                        </div>
                        <div class="judge-health-meta">
                            Concurrency: ${stats.concurrency || 2} • Timeout: ${timeoutMs}ms<br/>
                            <span title="Host split (exec)">Exec hosts: ${fmtTop(topExecHosts)}</span> •
                            <span title="Host split (judge)">Judge hosts: ${fmtTop(topJudgeHosts)}</span><br/>
                            <span title="Scoring method counts">Methods: ${fmtTop(topMethods)}</span> •
                            <span title="Latency summary">lat n=${latencyStats.n} avg=${fmtSec(latencyStats.mean)} max=${fmtSec(latencyStats.max)}</span>
                        </div>
                    `;

                    if (!judgeHealthContainer.dataset.bound) {
                        judgeHealthContainer.addEventListener('click', (e) => {
                            const btn = e.target && e.target.closest && e.target.closest('[data-action="inspect-model"]');
                            if (!btn) return;
                            const model = btn.getAttribute('data-model');
                            const mode = btn.getAttribute('data-mode') || 'failure';
                            const idOrIndex = pickRepresentativeResultIdForModel(model, mode);
                            if (idOrIndex !== null && typeof window.showJudgeDetails === 'function') {
                                window.showJudgeDetails(idOrIndex);
                            }
                        });
                        judgeHealthContainer.dataset.bound = 'true';
                    }
                } else {
                    judgeHealthContainer.style.display = 'none';
                }

                // Per-model progress table (exec + judge)
                const perModelContainer = document.getElementById('perModelProgressContainer');
                try {
                    const models = Array.isArray(batch.models) && batch.models.length > 0
                        ? batch.models
                        : Array.from(new Set((batch.results || []).map(r => r && r.model).filter(Boolean)));

                    const totalTests = Number(batch.total_tests) || 0;
                    const perModelPlanned = (models.length > 0 && totalTests > 0)
                        ? Math.round(totalTests / models.length)
                        : 0;

                    const perModelPlannedFromPlan = (batch.plan && Number.isFinite(batch.plan.total_prompts))
                        ? Number(batch.plan.total_prompts)
                        : perModelPlanned;

                    const isQualityEnabled = batch.quality_scoring !== false;
                    const showHyperDetails = showHyper;

                    const thresholds = getAnomalyThresholds();
                    const minSamples = Math.max(1, Number(thresholds.model_min_n) || 5);

                    const judgeDoneMethods = new Set(['quick', 'quick_scored', 'llm_judge', 'llm_judged', 'llm_failed', 'exec_failed']);
                    const isJudgeDone = (r) => {
                        const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                        return judgeDoneMethods.has(m);
                    };

                    const isJudgeFailed = (r) => {
                        const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                        return m === 'llm_failed';
                    };

                    const isExecFailed = (r) => {
                        const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                        return m === 'exec_failed' || r.success === false;
                    };

                    if (perModelContainer && models.length > 0 && perModelPlannedFromPlan > 0 && showAdvanced) {
                        // Median baselines (model-level averages) for quick relative indicators
                        const perModelAggForMedian = models.map(model => {
                            const modelResults = results.filter(r => r && r.model === model);
                            const tpsValues = modelResults
                                .map(r => parseFloat(r.tokens_per_sec))
                                .filter(v => !isNaN(v) && v > 0);
                            const judgeMsValues = modelResults
                                .map(r => Number(r && r.scoring_time_ms))
                                .filter(v => Number.isFinite(v) && v > 0);
                            const avgTps = tpsValues.length > 0 ? (tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length) : null;
                            const avgJudgeMs = judgeMsValues.length > 0 ? (judgeMsValues.reduce((sum, v) => sum + v, 0) / judgeMsValues.length) : null;
                            return { model, avgTps, tpsN: tpsValues.length, avgJudgeMs, judgeMsN: judgeMsValues.length };
                        });
                        const median = (values) => {
                            const xs = (Array.isArray(values) ? values : []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
                            if (xs.length === 0) return null;
                            const mid = Math.floor(xs.length / 2);
                            return (xs.length % 2 === 1) ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
                        };
                        const tpsMedianModelAvg = median(perModelAggForMedian.map(x => x.avgTps).filter(v => Number.isFinite(v) && v > 0));
                        const judgeMsMedianModelAvg = median(perModelAggForMedian.map(x => x.avgJudgeMs).filter(v => Number.isFinite(v) && v > 0));

                        const rows = models.map(model => {
                            const modelResults = results.filter(r => r && r.model === model);
                            const execDone = modelResults.length;
                            const execFailed = modelResults.filter(isExecFailed).length;
                            const execPct = Math.min(100, Math.round((execDone / perModelPlannedFromPlan) * 100));

                            const judgeDone = isQualityEnabled ? modelResults.filter(isJudgeDone).length : 0;
                            const judgeFailed = isQualityEnabled ? modelResults.filter(isJudgeFailed).length : 0;
                            const judgePct = isQualityEnabled
                                ? Math.min(100, Math.round((judgeDone / perModelPlannedFromPlan) * 100))
                                : 0;

                            const judgeEffPct = (isQualityEnabled && execDone > 0)
                                ? Math.min(100, Math.round((judgeDone / execDone) * 100))
                                : 0;

                            const execBar = `
                                <div style="height: 10px; background: rgba(255,255,255,0.06); border: 1px solid var(--panel-border); border-radius: 999px; overflow: hidden;">
                                    <div style="height: 100%; width: ${execPct}%; background: var(--accent);"></div>
                                </div>
                                <div style="margin-top: 4px; color: var(--muted); font-size: 0.85em;">${execDone}/${perModelPlannedFromPlan} (fail ${execFailed})</div>
                            `;

                            const judgeBar = isQualityEnabled ? `
                                <div style="height: 10px; background: rgba(255,255,255,0.06); border: 1px solid var(--panel-border); border-radius: 999px; overflow: hidden;">
                                    <div style="height: 100%; width: ${judgePct}%; background: var(--accent-2);"></div>
                                </div>
                                <div style="margin-top: 4px; color: var(--muted); font-size: 0.85em;">${judgeDone}/${perModelPlannedFromPlan} (eff ${judgeEffPct}% • fail ${judgeFailed})</div>
                            ` : `<div style="color: var(--muted);">Disabled</div>`;

                            const latencyAgg = summarizeNumbers(modelResults.map(r => r && r.latency));
                            const tpsAgg = summarizeNumbers(modelResults.map(r => r && r.tokens_per_sec).filter(v => Number(v) > 0));
                            const judgeAgg = summarizeNumbers(modelResults.map(r => r && r.scoring_time_ms).filter(v => Number(v) > 0));
                            const qualityAgg = summarizeNumbers(modelResults.map(r => r && r.quality_score));

                            const execHostCounts = countBy(modelResults, (r) => r && r.host ? formatHostLabel(r.host) : null);
                            const judgeHostCounts = countBy(modelResults, (r) => r && r.judge_host ? formatHostLabel(r.judge_host) : null);
                            const methodCounts = countBy(modelResults, (r) => (r && r.scoring_method) ? String(r.scoring_method).toLowerCase() : null);
                            const promptLevelCounts = countBy(modelResults, (r) => (r && r.prompt_level !== undefined && r.prompt_level !== null) ? String(r.prompt_level) : null);
                            const promptCategoryCounts = countBy(modelResults, (r) => (r && r.prompt_category) ? String(r.prompt_category) : null);

                            const ratioOrNull = (a, b) => {
                                if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
                                return a / b;
                            };
                            const tpsVsMedian = ratioOrNull(tpsAgg.mean, tpsMedianModelAvg);
                            const judgeMsVsMedian = ratioOrNull(judgeAgg.mean, judgeMsMedianModelAvg);
                            const formatRatio = (x) => (x === null ? '-' : `${x.toFixed(2)}×`);
                            const ratioColor = (x, invert = false) => {
                                if (x === null) return 'var(--muted)';
                                // throughput: higher is better, judge ms: lower is better
                                const good = invert ? (x <= 0.85) : (x >= 1.15);
                                const bad = invert ? (x >= 1.25) : (x <= 0.75);
                                if (good) return '#2ecc71';
                                if (bad) return '#e74c3c';
                                return 'var(--text)';
                            };

                            const tpsBelowPct = Math.max(0, Math.min(100, Number(thresholds.model_tps_below_median_pct) || 30));
                            const judgeMsAbovePct = Math.max(0, Math.min(300, Number(thresholds.model_judge_ms_above_median_pct) || 50));
                            const tpsCutoff = (tpsMedianModelAvg !== null && Number.isFinite(tpsMedianModelAvg))
                                ? (tpsMedianModelAvg * (1 - (tpsBelowPct / 100)))
                                : null;
                            const judgeMsCutoff = (judgeMsMedianModelAvg !== null && Number.isFinite(judgeMsMedianModelAvg))
                                ? (judgeMsMedianModelAvg * (1 + (judgeMsAbovePct / 100)))
                                : null;

                            const reasons = [];
                            const execRate = execDone > 0 ? (execFailed / execDone) : 0;
                            const judgeRate = judgeDone > 0 ? (judgeFailed / judgeDone) : 0;
                            const execOutPct = Math.max(0, Math.min(100, Number(thresholds.model_exec_out_pct) || 20)) / 100;
                            const judgeOutPct = Math.max(0, Math.min(100, Number(thresholds.model_judge_out_pct) || 10)) / 100;

                            if (execDone >= minSamples && execRate >= execOutPct) reasons.push('<span class="badge bg-danger">FAIL</span>');
                            if (isQualityEnabled && judgeDone >= minSamples && judgeRate >= judgeOutPct) reasons.push('<span class="badge bg-warning text-dark">JFAIL</span>');
                            if (tpsCutoff !== null && tpsAgg.n >= minSamples && Number.isFinite(tpsAgg.mean) && tpsAgg.mean <= tpsCutoff) reasons.push('<span class="badge bg-info text-dark">LOW TPS</span>');
                            if (judgeMsCutoff !== null && judgeAgg.n >= minSamples && Number.isFinite(judgeAgg.mean) && judgeAgg.mean >= judgeMsCutoff) reasons.push('<span class="badge bg-info text-dark">SLOW JUDGE</span>');

                            const aggCell = (primary, secondary, title) => {
                                return `
                                    <div title="${title}" style="white-space: nowrap;">
                                        <div style="font-weight: 600; color: var(--text);">${primary}</div>
                                        <div style="color: var(--muted); font-size: 0.82em;">${secondary}</div>
                                    </div>
                                `;
                            };

                            const latencyCell = aggCell(
                                latencyAgg.n > 0 ? `${Math.round(latencyAgg.p50)}ms` : '-',
                                latencyAgg.n > 0 ? `p95 ${Math.round(latencyAgg.p95)}ms` : `n=0`,
                                latencyAgg.n > 0 ? `n=${latencyAgg.n} avg=${Math.round(latencyAgg.mean)}ms min=${Math.round(latencyAgg.min)}ms max=${Math.round(latencyAgg.max)}ms` : 'No latency data'
                            );
                            const tpsCell = aggCell(
                                tpsAgg.n > 0 ? `${tpsAgg.p50.toFixed(2)} t/s` : '-',
                                tpsAgg.n > 0
                                    ? `p10 ${tpsAgg.p10.toFixed(2)} • vs med ${formatRatio(tpsVsMedian)}`
                                    : `n=0`,
                                tpsAgg.n > 0 ? `n=${tpsAgg.n} avg=${tpsAgg.mean.toFixed(2)} p95=${tpsAgg.p95.toFixed(2)} min=${tpsAgg.min.toFixed(2)}` : 'No throughput data'
                            );
                            const judgeMsCell = aggCell(
                                judgeAgg.n > 0 ? `${Math.round(judgeAgg.p50)}ms` : '-',
                                judgeAgg.n > 0
                                    ? `p95 ${Math.round(judgeAgg.p95)}ms • vs med ${formatRatio(judgeMsVsMedian)}`
                                    : `n=0`,
                                judgeAgg.n > 0 ? `n=${judgeAgg.n} avg=${Math.round(judgeAgg.mean)}ms max=${Math.round(judgeAgg.max)}ms` : 'No judge-time data'
                            );
                            const qualityCell = aggCell(
                                qualityAgg.n > 0 ? `${qualityAgg.p50.toFixed(2)}` : '-',
                                qualityAgg.n > 0 ? `p10 ${qualityAgg.p10.toFixed(2)}` : `n=0`,
                                qualityAgg.n > 0 ? `n=${qualityAgg.n} avg=${qualityAgg.mean.toFixed(2)} p95=${qualityAgg.p95.toFixed(2)} min=${qualityAgg.min.toFixed(2)}` : 'No quality data'
                            );

                            const recentErrors = modelResults
                                .filter(r => isExecFailed(r) || isJudgeFailed(r))
                                .slice(-5)
                                .map(r => ({
                                    prompt_id: r.prompt_id,
                                    scoring_method: r.scoring_method,
                                    error: r.error || null,
                                    host: r.host || null,
                                    judge_host: r.judge_host || null
                                }));

                            const modelSnapshot = {
                                model,
                                planned: perModelPlannedFromPlan,
                                exec: {
                                    done: execDone,
                                    failed: execFailed,
                                    percent: execPct
                                },
                                judge: isQualityEnabled ? {
                                    done: judgeDone,
                                    failed: judgeFailed,
                                    percent_planned: judgePct,
                                    percent_effective: judgeEffPct
                                } : { disabled: true },
                                aggregates: {
                                    latency_ms: latencyAgg,
                                    tokens_per_sec: tpsAgg,
                                    judge_time_ms: judgeAgg,
                                    quality_score: qualityAgg,
                                    vs_median: {
                                        model_avg_tokens_per_sec_ratio: tpsVsMedian,
                                        model_avg_judge_time_ms_ratio: judgeMsVsMedian
                                    }
                                },
                                breakdowns: {
                                    exec_host: execHostCounts,
                                    judge_host: judgeHostCounts,
                                    scoring_method: methodCounts,
                                    prompt_level: promptLevelCounts,
                                    prompt_category: promptCategoryCounts
                                },
                                recent_errors: recentErrors,
                                sample_result: null,
                                samples: null
                            };

                            // Attach a sample (best-effort) so the user can inspect immediately
                            try {
                                const sampleFailure = pickRepresentativeResultIdForModel(model, 'failure');
                                const sampleWorstLatency = pickRepresentativeResultIdForModel(model, 'worst_latency');
                                const sampleWorstThroughput = pickRepresentativeResultIdForModel(model, 'worst_throughput');
                                const sampleLongestJudge = pickRepresentativeResultIdForModel(model, 'longest_judge');
                                const sampleLowestQuality = pickRepresentativeResultIdForModel(model, 'lowest_quality');
                                const samples = {
                                    failure: sampleFailure,
                                    worst_latency: sampleWorstLatency,
                                    worst_throughput: sampleWorstThroughput,
                                    longest_judge: sampleLongestJudge,
                                    lowest_quality: sampleLowestQuality
                                };
                                modelSnapshot.samples = samples;
                                if (sampleFailure) modelSnapshot.sample_result = { id_or_index: sampleFailure };
                            } catch (e) {
                                // ignore
                            }

                            const hyperToggle = showHyperDetails
                                ? `<button type="button" class="btn-secondary" data-action="toggle-model-hyper" data-model="${String(model).replace(/"/g, '&quot;')}" style="padding: 6px 10px;">Hyper</button>`
                                : '';

                            return `
                                <tr data-model-main-row="${String(model).replace(/\"/g, '&quot;')}">
                                    <td style="padding: 10px 10px; font-weight: 600; color: var(--text); white-space: nowrap;">
                                        <div style="display:flex; align-items:center; justify-content: space-between; gap: 10px;">
                                            <div style="display:flex; flex-direction: column; gap: 4px;">
                                                <span>${model}</span>
                                                ${reasons.length > 0 ? `<div style="display:flex; gap: 6px; flex-wrap: wrap;">${reasons.join('')}</div>` : ''}
                                            </div>
                                            ${hyperToggle}
                                        </div>
                                    </td>
                                    <td style="padding: 10px 10px; min-width: 220px;">${execBar}</td>
                                    <td style="padding: 10px 10px; min-width: 220px;">${judgeBar}</td>
                                    <td style="padding: 10px 10px; min-width: 140px;">${latencyCell}</td>
                                    <td style="padding: 10px 10px; min-width: 140px;">
                                        <div style="color: ${ratioColor(tpsVsMedian, false)};">${tpsCell}</div>
                                    </td>
                                    <td style="padding: 10px 10px; min-width: 140px;">
                                        <div style="color: ${ratioColor(judgeMsVsMedian, true)};">${judgeMsCell}</div>
                                    </td>
                                    <td style="padding: 10px 10px; min-width: 140px;">${qualityCell}</td>
                                </tr>
                                <tr data-model-hyper-row="${String(model).replace(/"/g, '&quot;')}" style="display:none;">
                                    <td colspan="7" style="padding: 0 10px 10px;">
                                        <div class="advanced-details" style="margin-top: 0;">
                                            <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 6px;">
                                                <div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">
                                                    <div style="font-weight: 700; color: var(--text);">${model} — hyper snapshot</div>
                                                    <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="failure" data-model="${String(model).replace(/\"/g, '&quot;')}" style="padding: 6px 10px;">Inspect failure</button>
                                                    <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="worst_latency" data-model="${String(model).replace(/\"/g, '&quot;')}" style="padding: 6px 10px;">Inspect worst latency</button>
                                                    <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="worst_throughput" data-model="${String(model).replace(/\"/g, '&quot;')}" style="padding: 6px 10px;">Inspect worst throughput</button>
                                                    <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="longest_judge" data-model="${String(model).replace(/\"/g, '&quot;')}" style="padding: 6px 10px;">Inspect longest judge</button>
                                                    <button type="button" class="btn-secondary" data-action="inspect-model" data-mode="lowest_quality" data-model="${String(model).replace(/\"/g, '&quot;')}" style="padding: 6px 10px;">Inspect lowest quality</button>
                                                </div>
                                                <div style="color: var(--muted); font-size: 0.85em;">recent_errors capped at 5</div>
                                            </div>
                                            <pre style="margin:0;">${JSON.stringify(modelSnapshot, null, 2)}</pre>
                                        </div>
                                    </td>
                                </tr>
                            `;
                        }).join('');

                        perModelContainer.style.display = 'block';
                        perModelContainer.innerHTML = `
                            <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 10px;">
                                <div style="font-weight: 700; color: var(--text);">Per-model Progress</div>
                                <div style="color: var(--muted); font-size: 0.85em;">Planned per model: ${perModelPlannedFromPlan}</div>
                            </div>
                            <div style="overflow-x: auto;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr style="text-align:left; color: var(--muted); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">
                                            <th style="padding: 8px 10px;">Model</th>
                                            <th style="padding: 8px 10px;">Exec</th>
                                            <th style="padding: 8px 10px;">Judge</th>
                                            <th style="padding: 8px 10px;">Latency</th>
                                            <th style="padding: 8px 10px;">t/s</th>
                                            <th style="padding: 8px 10px;">Judge ms</th>
                                            <th style="padding: 8px 10px;">Quality</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${rows}
                                    </tbody>
                                </table>
                            </div>
                        `;

                        if (!perModelContainer.dataset.hyperBound) {
                            perModelContainer.addEventListener('click', (e) => {
                                const inspectBtn = e.target && e.target.closest && e.target.closest('[data-action="inspect-model"]');
                                if (inspectBtn) {
                                    const model = inspectBtn.getAttribute('data-model');
                                    const mode = inspectBtn.getAttribute('data-mode') || 'failure';
                                    const idOrIndex = pickRepresentativeResultIdForModel(model, mode);
                                    if (idOrIndex !== null && typeof window.showJudgeDetails === 'function') {
                                        window.showJudgeDetails(idOrIndex);
                                    }
                                    return;
                                }

                                const btn = e.target && e.target.closest && e.target.closest('[data-action="toggle-model-hyper"]');
                                if (!btn) return;
                                const model = btn.getAttribute('data-model');
                                const row = findRowByAttr(perModelContainer, 'data-model-hyper-row', model);
                                if (!row) return;
                                const isOpen = row.style.display !== 'none';
                                row.style.display = isOpen ? 'none' : '';
                                btn.textContent = isOpen ? 'Hyper' : 'Hide';
                            });
                            perModelContainer.dataset.hyperBound = 'true';
                        }
                    } else if (perModelContainer) {
                        perModelContainer.style.display = 'none';
                    }
                } catch (e) {
                    // Never let UI crash polling.
                    const perModelContainer = document.getElementById('perModelProgressContainer');
                    if (perModelContainer) perModelContainer.style.display = 'none';
                }

                // Show plan info during run/resume
                const batchInfo = document.getElementById('batchInfo');
                // Always update if plan is available, to ensure persistence on refresh
                if (batchInfo && (batch.plan || batch.judge_config || batch.host)) {
                    // Only update if content is missing or we have a better plan object now
                    if (batchInfo.innerHTML.trim() === '' || batch.plan) {
                         batchInfo.innerHTML = renderBatchPlan(batch.plan, batch.host, batch.quality_scoring !== false);
                    }
                }

                // Update status text if resuming
                const status = document.getElementById('batchStatus');
                if (status.textContent === 'Resuming session...') {
                    status.style.display = 'none';
                }

                // Warn if server reports completed beyond planned tests
                if (Number(batch.completed) > Number(batch.total_tests)) {
                    status.className = 'status error';
                    status.style.display = 'block';
                    status.textContent = `⚠ Warning: completed (${batch.completed}) exceeds planned tests (${batch.total_tests}). This usually indicates duplicate execution or a prior error. Batch ID: ${currentBatchId}`;
                }

                // Update Results Table
                if (results.length > 0) {
                    const container = document.getElementById('batchResultsContainer');
                    const tbody = document.getElementById('batchResultsBody');
                    container.style.display = 'block';

                    window.currentBatchResults = results;
                    tbody.innerHTML = results.map((r, idx) => {
                        const qualityScore = r.quality_score !== undefined && r.quality_score !== null ? r.quality_score : '-';
                        const qualityClass = qualityScore >= 7 ? 'quality-high' : qualityScore >= 4 ? 'quality-mid' : (qualityScore !== '-' ? 'quality-low' : '');

                        const lat = toFiniteNumber(r.latency);
                        const tps = toFiniteNumber(r.tokens_per_sec);
                        const judgeMs = toFiniteNumber(r.scoring_time_ms);
                        const perfLine = (lat !== null || tps !== null)
                            ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">${lat !== null ? `L: ${Math.round(lat)}ms` : 'L: -'} • ${tps !== null ? `t/s: ${tps.toFixed(2)}` : 't/s: -'}</div>`
                            : '';
                        const judgeLine = (judgeMs !== null)
                            ? `<div style="font-size: 0.75em; color: var(--muted);">Judge ms: ${Math.round(judgeMs)}ms</div>`
                            : '';

                        const hostInfo = r.host ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">Exec: ${formatHostLabel(r.host)}</div>` : '';
                        const judgeInfo = r.judge_host ? `<div style="font-size: 0.75em; color: var(--muted);">Judge: ${formatHostLabel(r.judge_host)}</div>` : '';
                        const judgeStatus = r.scoring_method ? `<div style="font-size: 0.75em; color: var(--muted);">Status: ${r.scoring_method}</div>` : '';

                        return `
                            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <td style="padding: 8px 12px;">
                                    ${r.model}
                                    ${hostInfo}
                                </td>
                                <td style="padding: 8px 12px;">${r.prompt_name}${perfLine}</td>
                                <td style="padding: 8px 12px; text-align: center;" class="${qualityClass}">
                                    ${qualityScore}
                                    ${judgeInfo}
                                    ${judgeStatus}
                                    ${judgeLine}
                                </td>
                                <td style="padding: 8px 12px; text-align: center;">
                                    <button class="btn-secondary btn-sm" onclick="showJudgeDetails('${r.id || idx}')">
                                        <i class="fas fa-eye"></i> Details
                                    </button>
                                </td>
                            </tr>
                        `;
                    }).join('');
                }

                // Hyper details: structured snapshot (avoid full results array)
                const hyperPre = document.getElementById('hyperBatchJson');
                const hyperDetails = document.getElementById('hyperBatchDetails');
                const hyperAnomalies = document.getElementById('hyperAnomalies');
                const hyperThresholds = document.getElementById('hyperThresholds');
                if (hyperPre && hyperDetails) {
                    if (showAdvanced && showHyper) {
                        hyperDetails.style.display = 'block';
                        if (hyperThresholds) hyperThresholds.style.display = 'block';
                        hydrateThresholdInputs();
                        bindThresholdInputs();

                        const thresholds = getAnomalyThresholds();

                        const completed = Number(batch.completed) || 0;
                        const failed = Number(batch.failed) || 0;
                        const execFailRate = completed > 0 ? (failed / completed) : 0;
                        const judgeFailed = Number(batch.judge_failed) || 0;
                        const judgeCompleted = Number(batch.judge_completed) || 0;
                        const judgeFailRate = judgeCompleted > 0 ? (judgeFailed / judgeCompleted) : 0;
                        const judgeStats = batch.judge_stats || null;

                        const models = Array.isArray(batch.models) && batch.models.length > 0
                            ? batch.models
                            : Array.from(new Set(results.map(r => r && r.model).filter(Boolean)));

                        const judgeDoneMethods = new Set(['quick', 'quick_scored', 'llm_judge', 'llm_judged', 'llm_failed', 'exec_failed']);
                        const isJudgeDone = (r) => {
                            const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                            return judgeDoneMethods.has(m);
                        };
                        const isJudgeFailed = (r) => {
                            const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                            return m === 'llm_failed';
                        };
                        const isExecFailed = (r) => {
                            const m = (r && r.scoring_method ? String(r.scoring_method).toLowerCase() : '');
                            return m === 'exec_failed' || r.success === false;
                        };

                        const anomalies = [];
                        if (completed > 0 && execFailRate >= (Number(thresholds.exec_fail_pct) / 100)) {
                            anomalies.push(`High exec failure rate: ${(execFailRate * 100).toFixed(1)}% (${failed}/${completed})`);
                        }
                        if (judgeCompleted > 0 && judgeFailRate >= (Number(thresholds.judge_fail_pct) / 100)) {
                            anomalies.push(`High judge failure rate: ${(judgeFailRate * 100).toFixed(1)}% (${judgeFailed}/${judgeCompleted})`);
                        }
                        if (judgeStats && Number.isFinite(judgeStats.lag) && Number.isFinite(judgeStats.concurrency)) {
                            const lag = Number(judgeStats.lag) || 0;
                            const conc = Math.max(1, Number(judgeStats.concurrency) || 1);
                            if (lag >= conc * Math.max(1, Number(thresholds.lag_factor) || 5)) {
                                anomalies.push(`Judge backlog high: lag ${lag} (concurrency ${conc})`);
                            }
                        }
                        if (judgeStats && Number.isFinite(judgeStats.avg_time_ms) && Number.isFinite(judgeStats.timeout_ms)) {
                            const avg = Number(judgeStats.avg_time_ms) || 0;
                            const timeout = Math.max(1, Number(judgeStats.timeout_ms) || 1);
                            if (avg >= timeout * (Math.max(0, Math.min(100, Number(thresholds.avg_near_timeout_pct) || 80)) / 100)) {
                                anomalies.push(`Judge avg time near timeout: ${Math.round(avg)}ms / ${timeout}ms`);
                            }
                        }

                        // Per-model outliers (only flag once we have a minimum sample)
                        const modelAnomalies = [];
                        const median = (values) => {
                            const xs = (Array.isArray(values) ? values : []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
                            if (xs.length === 0) return null;
                            const mid = Math.floor(xs.length / 2);
                            return (xs.length % 2 === 1) ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
                        };
                        const modelStats = models.map(model => {
                            const modelResults = results.filter(r => r && r.model === model);
                            const execDone = modelResults.length;
                            const execFailedCount = modelResults.filter(isExecFailed).length;
                            const execRate = execDone > 0 ? (execFailedCount / execDone) : 0;
                            const judgeDone = modelResults.filter(isJudgeDone).length;
                            const judgeFailedCount = modelResults.filter(isJudgeFailed).length;
                            const judgeRate = judgeDone > 0 ? (judgeFailedCount / judgeDone) : 0;

                            const tpsValues = modelResults
                                .map(r => Number(r && r.tokens_per_sec))
                                .filter(v => Number.isFinite(v) && v > 0);
                            const judgeMsValues = modelResults
                                .map(r => Number(r && r.scoring_time_ms))
                                .filter(v => Number.isFinite(v) && v > 0);
                            const avgTps = tpsValues.length > 0
                                ? (tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length)
                                : null;
                            const avgJudgeMs = judgeMsValues.length > 0
                                ? (judgeMsValues.reduce((sum, v) => sum + v, 0) / judgeMsValues.length)
                                : null;

                            return {
                                model,
                                execDone,
                                execFailedCount,
                                execRate,
                                judgeDone,
                                judgeFailedCount,
                                judgeRate,
                                tpsN: tpsValues.length,
                                avgTps,
                                judgeMsN: judgeMsValues.length,
                                avgJudgeMs
                            };
                        });

                        // Identify worst-by-rate with basic guardrails
                        const minSamples = Math.max(1, Number(thresholds.model_min_n) || 5);
                        const execOutliers = modelStats
                            .filter(s => s.execDone >= minSamples)
                            .sort((a, b) => b.execRate - a.execRate)
                            .slice(0, 3)
                            .filter(s => s.execRate >= (Math.max(0, Math.min(100, Number(thresholds.model_exec_out_pct) || 20)) / 100));
                        for (const s of execOutliers) {
                            modelAnomalies.push({
                                type: 'exec_failure_outlier',
                                model: s.model,
                                inspect_mode: 'failure',
                                message: `Exec failures high: ${(s.execRate * 100).toFixed(1)}% (${s.execFailedCount}/${s.execDone})`
                            });
                        }

                        const judgeOutliers = modelStats
                            .filter(s => s.judgeDone >= minSamples)
                            .sort((a, b) => b.judgeRate - a.judgeRate)
                            .slice(0, 3)
                            .filter(s => s.judgeRate >= (Math.max(0, Math.min(100, Number(thresholds.model_judge_out_pct) || 10)) / 100));
                        for (const s of judgeOutliers) {
                            modelAnomalies.push({
                                type: 'judge_failure_outlier',
                                model: s.model,
                                inspect_mode: 'failure',
                                message: `Judge failures high: ${(s.judgeRate * 100).toFixed(1)}% (${s.judgeFailedCount}/${s.judgeDone})`
                            });
                        }

                        // Throughput / judge-time outliers vs median baseline
                        const tpsBelowPct = Math.max(0, Math.min(100, Number(thresholds.model_tps_below_median_pct) || 30));
                        const judgeMsAbovePct = Math.max(0, Math.min(300, Number(thresholds.model_judge_ms_above_median_pct) || 50));

                        let tpsMedian = null;
                        let tpsCutoff = null;
                        let tpsEligibleModels = 0;
                        let judgeMsMedian = null;
                        let judgeMsCutoff = null;
                        let judgeMsEligibleModels = 0;

                        const throughputOutliers = [];
                        const judgeTimeOutliers = [];

                        const tpsBaseline = modelStats.filter(s => Number.isFinite(s.avgTps) && s.tpsN >= minSamples);
                        tpsEligibleModels = tpsBaseline.length;
                        tpsMedian = median(tpsBaseline.map(s => s.avgTps));
                        if (tpsMedian !== null && tpsMedian > 0 && tpsBelowPct > 0) {
                            tpsCutoff = tpsMedian * (1 - (tpsBelowPct / 100));
                            const tpsOutliers = tpsBaseline
                                .filter(s => s.avgTps !== null && s.avgTps <= tpsCutoff)
                                .sort((a, b) => (a.avgTps / tpsMedian) - (b.avgTps / tpsMedian))
                                .slice(0, 3);
                            for (const s of tpsOutliers) {
                                throughputOutliers.push({
                                    model: s.model,
                                    avg_tps: Number.isFinite(s.avgTps) ? Number(s.avgTps.toFixed(6)) : null,
                                    median_tps: Number(tpsMedian.toFixed(6)),
                                    ratio_vs_median: Number.isFinite(s.avgTps) ? Number((s.avgTps / tpsMedian).toFixed(6)) : null,
                                    n: s.tpsN
                                });
                                modelAnomalies.push({
                                    type: 'throughput_outlier',
                                    model: s.model,
                                    inspect_mode: 'worst_throughput',
                                    message: `Throughput low vs median: ${s.avgTps.toFixed(2)} t/s (median ${tpsMedian.toFixed(2)} t/s; n=${s.tpsN})`
                                });
                            }
                        }

                        const judgeMsBaseline = modelStats.filter(s => Number.isFinite(s.avgJudgeMs) && s.judgeMsN >= minSamples);
                        judgeMsEligibleModels = judgeMsBaseline.length;
                        judgeMsMedian = median(judgeMsBaseline.map(s => s.avgJudgeMs));
                        if (judgeMsMedian !== null && judgeMsMedian > 0 && judgeMsAbovePct > 0) {
                            judgeMsCutoff = judgeMsMedian * (1 + (judgeMsAbovePct / 100));
                            const judgeMsOutliers = judgeMsBaseline
                                .filter(s => s.avgJudgeMs !== null && s.avgJudgeMs >= judgeMsCutoff)
                                .sort((a, b) => (b.avgJudgeMs / judgeMsMedian) - (a.avgJudgeMs / judgeMsMedian))
                                .slice(0, 3);
                            for (const s of judgeMsOutliers) {
                                judgeTimeOutliers.push({
                                    model: s.model,
                                    avg_ms: Number.isFinite(s.avgJudgeMs) ? Math.round(s.avgJudgeMs) : null,
                                    median_ms: Math.round(judgeMsMedian),
                                    ratio_vs_median: Number.isFinite(s.avgJudgeMs) ? Number((s.avgJudgeMs / judgeMsMedian).toFixed(6)) : null,
                                    n: s.judgeMsN
                                });
                                modelAnomalies.push({
                                    type: 'judge_time_outlier',
                                    model: s.model,
                                    inspect_mode: 'longest_judge',
                                    message: `Judge time high vs median: ${Math.round(s.avgJudgeMs)}ms (median ${Math.round(judgeMsMedian)}ms; n=${s.judgeMsN})`
                                });
                            }
                        }

                        const batchDistributions = {
                            latency_ms: summarizeNumbers(results.map(r => r && r.latency)),
                            tokens_per_sec: summarizeNumbers(results.map(r => r && r.tokens_per_sec).filter(v => Number(v) > 0)),
                            judge_time_ms: summarizeNumbers(results.map(r => r && r.scoring_time_ms).filter(v => Number(v) > 0)),
                            quality_score: summarizeNumbers(results.map(r => r && r.quality_score))
                        };
                        const batchBreakdowns = {
                            exec_host: countBy(results, (r) => r && r.host ? formatHostLabel(r.host) : null),
                            judge_host: countBy(results, (r) => r && r.judge_host ? formatHostLabel(r.judge_host) : null),
                            scoring_method: countBy(results, (r) => (r && r.scoring_method) ? String(r.scoring_method).toLowerCase() : null),
                            prompt_level: countBy(results, (r) => (r && r.prompt_level !== undefined && r.prompt_level !== null) ? String(r.prompt_level) : null),
                            prompt_category: countBy(results, (r) => (r && r.prompt_category) ? String(r.prompt_category) : null)
                        };

                        const groupAverages = (getKey) => {
                            const buckets = Object.create(null);
                            for (const r of results) {
                                const key = getKey(r);
                                if (!key) continue;
                                if (!buckets[key]) buckets[key] = { n: 0, lat: [], q: [] };
                                buckets[key].n += 1;
                                const lat = toFiniteNumber(r && r.latency);
                                const q = toFiniteNumber(r && r.quality_score);
                                if (lat !== null) buckets[key].lat.push(lat);
                                if (q !== null) buckets[key].q.push(q);
                            }
                            const out = [];
                            for (const [key, b] of Object.entries(buckets)) {
                                const latStats = summarizeNumbers(b.lat);
                                const qStats = summarizeNumbers(b.q);
                                out.push({
                                    key,
                                    n: b.n,
                                    avg_latency_ms: latStats.n > 0 ? latStats.mean : null,
                                    p50_latency_ms: latStats.n > 0 ? latStats.p50 : null,
                                    p95_latency_ms: latStats.n > 0 ? latStats.p95 : null,
                                    avg_quality: qStats.n > 0 ? qStats.mean : null