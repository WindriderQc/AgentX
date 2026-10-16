        // Helper: JSON request headers
        function jsonHeaders() {
            return { 'Content-Type': 'application/json' };
        }

        // Helper: escape stored text (names, scenarios, request paths) before
        // it is written into markup; any LAN client can store these values.
        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (c) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[c]);
        }

        // Performance Dashboard Controller
        const PerformanceDashboard = {
            // State
            charts: {},
            data: {},
            refreshInterval: null,
            autoRefreshEnabled: false,
            refreshCountdown: 60,
            currentTimeRange: 24,
            currentEndpoint: '',
            sortColumn: 'date',
            sortDirection: 'desc',
            requestSeq: {},
            loadingAll: false,

            // Initialization
            async init() {
                this.bindEvents();
                await this.loadAll();
                this.startRefreshCountdown();
            },

            // Fetch JSON with a timeout; an HTTP error or a non-success envelope throws.
            async fetchJson(url, options = {}) {
                const response = await fetch(url, { headers: jsonHeaders(), ...options, signal: AbortSignal.timeout(30000) });
                let result = null;
                try { result = await response.json(); } catch (_) { /* non-JSON error page */ }
                if (!response.ok || !result || result.status !== 'success') {
                    throw new Error(result?.message || `HTTP ${response.status}`);
                }
                return result;
            },

            // Each panel keeps only its newest response: a slow 7-day query that
            // lands after a 1-hour one must not repaint the panel.
            beginRequest(key) {
                const id = (this.requestSeq[key] || 0) + 1;
                this.requestSeq[key] = id;
                return () => this.requestSeq[key] === id;
            },

            // Hide a chart and show its message; the previous range's chart must not stay visible.
            showChartEmpty(chartKey, canvasId, emptyId, message) {
                if (this.charts[chartKey]) {
                    this.charts[chartKey].destroy();
                    this.charts[chartKey] = null;
                }
                document.getElementById(canvasId).parentElement.hidden = true;
                const empty = document.getElementById(emptyId);
                empty.textContent = message;
                empty.classList.add('visible');
            },

            showChart(canvasId, emptyId) {
                document.getElementById(canvasId).parentElement.hidden = false;
                document.getElementById(emptyId).classList.remove('visible');
            },

            // Load dashboard stats
            async loadDashboard() {
                const isCurrent = this.beginRequest('dashboard');
                try {
                    const result = await this.fetchJson(`/api/performance/dashboard?hours=${this.currentTimeRange}`);
                    if (isCurrent() && result.data) this.updateStatsCards(result.data);
                } catch (err) {
                    if (!isCurrent()) return;
                    console.error('Failed to load dashboard:', err);
                    const status = document.getElementById('systemStatus');
                    status.className = 'badge unknown';
                    status.textContent = 'Unavailable';
                }
            },

            // Load all data. An auto-refresh tick skips while a load is running;
            // user actions always reload (stale responses are dropped per panel).
            async loadAll({ fromTimer = false } = {}) {
                if (fromTimer && this.loadingAll) return;
                this.loadingAll = true;
                try {
                    await Promise.all([
                    this.loadDashboard(),
                    this.loadLatencyTrends(),
                    this.loadThroughput(),
                    this.loadLoadTests(),
                    this.loadBaselines(),
                    this.populateEndpointFilter()
                    ]);
                } finally {
                    this.loadingAll = false;
                }
            },

            // Bind event listeners
            bindEvents() {
                // Header controls
                document.getElementById('refreshBtn').addEventListener('click', () => this.loadAll());
                document.getElementById('timeRangeSelect').addEventListener('change', (e) => {
                    this.currentTimeRange = parseInt(e.target.value);
                    this.loadAll();
                });
                // Only the latency trend has per-endpoint data.
                document.getElementById('endpointFilter').addEventListener('change', (e) => {
                    this.currentEndpoint = e.target.value;
                    this.loadLatencyTrends();
                });
                document.querySelectorAll('#loadTestsTable th.sortable').forEach(th => {
                    th.addEventListener('click', () => this.sortLoadTests(th.dataset.sort));
                    th.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.sortLoadTests(th.dataset.sort);
                        }
                    });
                });
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden && this.autoRefreshEnabled) this.loadAll();
                });
                document.getElementById('autoRefreshToggle').addEventListener('change', (e) => {
                    this.autoRefreshEnabled = e.target.checked;
                    if (this.autoRefreshEnabled) {
                        this.startAutoRefresh();
                    } else {
                        this.stopAutoRefresh();
                    }
                });

                // Import test button
                document.getElementById('importTestBtn').addEventListener('click', () => {
                    document.getElementById('importTestModal').classList.add('active');
                });
                document.getElementById('cancelImportBtn').addEventListener('click', () => {
                    document.getElementById('importTestModal').classList.remove('active');
                });
                document.getElementById('importTestForm').addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.importLoadTest();
                });

                // Create baseline button
                document.getElementById('createBaselineBtn').addEventListener('click', () => {
                    this.openCreateBaselineModal();
                });
                document.getElementById('cancelBaselineBtn').addEventListener('click', () => {
                    document.getElementById('createBaselineModal').classList.remove('active');
                });
                document.getElementById('createBaselineForm').addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.createBaseline();
                });

                // Escape closes an open dialog
                document.addEventListener('keydown', (e) => {
                    if (e.key !== 'Escape') return;
                    document.querySelectorAll('.modal-overlay.active').forEach(overlay => overlay.classList.remove('active'));
                });

                // Close modals on overlay click
                document.querySelectorAll('.modal-overlay').forEach(overlay => {
                    overlay.addEventListener('click', (e) => {
                        if (e.target === overlay) {
                            overlay.classList.remove('active');
                        }
                    });
                });
            },



            // Update stats cards
            updateStatsCards(data) {
                const statusBadge = document.getElementById('systemStatus');
                const status = data.system_health || 'unknown';
                statusBadge.className = `badge ${status}`;
                statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);

                const metrics = data.metrics_24h || {};
                const trends = data.trends || {};

                // null means no request was recorded: show unknown, not 0 ms or 100%.
                const show = (value, format) => (value === null || value === undefined ? '—' : format(Number(value)));
                document.getElementById('avgResponseTime').textContent = show(metrics.avg_latency, v => `${v.toFixed(0)}ms`);
                this.updateTrend('responseTrend', trends.avg_latency_pct);

                const throughput = Number(metrics.throughput_rps || 0);
                document.getElementById('throughput').textContent = throughput.toFixed(1);
                this.updateTrend('throughputTrend', trends.throughput_pct);

                const errorRate = Number(metrics.error_rate || 0);
                const errorEl = document.getElementById('errorRate');
                errorEl.textContent = show(metrics.error_rate, v => `${v.toFixed(2)}%`);
                errorEl.style.color = errorRate > 5 ? '#ef4444' : errorRate > 1 ? '#fbbf24' : 'inherit';
                this.updateTrend('errorTrend', trends.error_rate_pct);

                document.getElementById('uptime').textContent = show(metrics.uptime_percent, v => `${v.toFixed(2)}%`);
                document.getElementById('p95Latency').textContent = show(metrics.p95_latency, v => `${v.toFixed(0)}ms`);

                const modelBound = document.getElementById('modelBoundNote');
                if (modelBound) {
                    const count = Number(metrics.model_bound_requests || 0);
                    modelBound.textContent = count > 0
                        ? `${count} model-bound request${count === 1 ? '' : 's'} (chat, generation, embeddings, event streams) in this period are measured on AI activity, not here.`
                        : 'Chat, generation, embedding and streaming requests are measured on AI activity, not here.';
                }
                this.updateTrend('p95Trend', trends.p95_latency_pct);

                // Sources / provenance indicator
                const indicator = document.getElementById('sourcesIndicator');
                if (indicator) {
                    const src = data.sources || {};

                    const prod = src.production || {};
                    const prodParts = [
                        `Production snapshots (hourly, last ${prod.hours || this.currentTimeRange}h)`
                    ];
                    if (Number.isFinite(prod.snapshots)) prodParts.push(`${prod.snapshots} snapshots`);
                    if (Number.isFinite(prod.total_requests)) prodParts.push(`${prod.total_requests} req`);
                    if (prod.last_snapshot_hour) prodParts.push(`last ${new Date(prod.last_snapshot_hour).toLocaleString()}`);

                    const breakdown = prod.breakdown || {};
                    const breakdownParts = [];
                    if (Number.isFinite(breakdown.api_requests)) breakdownParts.push(`API ${breakdown.api_requests}`);
                    if (Number.isFinite(breakdown.non_api_requests)) breakdownParts.push(`Non‑API ${breakdown.non_api_requests}`);
                    if (Number.isFinite(breakdown.total_endpoint_requests)) breakdownParts.push(`Total ${breakdown.total_endpoint_requests}`);
                    const delta = Number(breakdown.delta_vs_total_requests);
                    if (Number.isFinite(delta) && delta !== 0) {
                        const sign = delta > 0 ? '+' : '';
                        breakdownParts.push(`Δ ${sign}${delta}`);
                    }
                    const breakdownText = breakdownParts.length
                        ? `Breakdown: ${breakdownParts.join(' • ')}${(Number.isFinite(delta) && delta !== 0) ? ' (endpoint rollup vs total req)' : ''}`
                        : '';

                    const categoryLabel = (key) => {
                        switch (key) {
                            case 'chat': return 'Chat';
                            case 'conversations': return 'Conversations';
                            case 'history': return 'History';
                            case 'rag': return 'RAG/Search';
                            case 'batch_workflows': return 'Batch/Workflows';
                            case 'auth': return 'Auth';
                            case 'alerts': return 'Alerts';
                            case 'metrics': return 'Metrics';
                            case 'admin': return 'Admin';
                            case 'other_api': return 'Other API';
                            case 'batch_ui': return 'Batch (UI)';
                            case 'ui_pages': return 'UI Pages';
                            case 'ui_performance': return 'Performance UI';
                            case 'other_non_api': return 'Other Non‑API';
                            default: return key;
                        }
                    };

                    const categoryRows = Array.isArray(prod.category_breakdown) ? prod.category_breakdown : [];
                    const categoryText = categoryRows.length
                        ? `Categories: ${categoryRows
                            .filter(r => r && typeof r.category === 'string')
                            .slice(0, 6)
                            .map(r => {
                                const count = Number(r.count || 0);
                                const err = Number(r.error_rate || 0);
                                const lat = Number(r.avg_latency || 0);
                                const extras = [];
                                if (Number.isFinite(err) && err > 0) extras.push(`${err.toFixed(2)}% err`);
                                if (Number.isFinite(lat) && lat > 0) extras.push(`${lat.toFixed(0)}ms avg`);
                                return `${escapeHtml(categoryLabel(r.category))} ${count}${extras.length ? ` (${extras.join(', ')})` : ''}`;
                            })
                            .join(' • ')}`
                        : '';

                    const hotspots = [];
                    for (const r of categoryRows) {
                        if (!r || typeof r.category !== 'string') continue;
                        const err = Number(r.error_rate || 0);
                        const lat = Number(r.avg_latency || 0);
                        const count = Number(r.count || 0);
                        if (!Number.isFinite(count) || count <= 0) continue;
                        if ((Number.isFinite(err) && err >= 2) || (Number.isFinite(lat) && lat >= 250)) {
                            const parts = [];
                            if (Number.isFinite(err) && err >= 2) parts.push(`${err.toFixed(2)}% err`);
                            if (Number.isFinite(lat) && lat >= 250) parts.push(`${lat.toFixed(0)}ms avg`);
                            hotspots.push(`${escapeHtml(categoryLabel(r.category))} (${parts.join(', ')})`);
                        }
                    }

                    const top = Array.isArray(prod.top_endpoints) ? prod.top_endpoints : [];
                    const topText = top.length
                        ? `Top: ${top.map(e => {
                            const err = Number(e.error_rate || 0);
                            const lat = Number(e.avg_latency || 0);
                            const extras = [];
                            if (Number.isFinite(err) && err > 0) extras.push(`${err.toFixed(2)}% err`);
                            if (Number.isFinite(lat) && lat > 0) extras.push(`${lat.toFixed(0)}ms avg`);
                            return `${escapeHtml(e.method)} ${escapeHtml(e.path)} (${escapeHtml(e.count)}${extras.length ? `, ${extras.join(', ')}` : ''})`;
                        }).join(' • ')}`
                        : '';

                    const topErrors = Array.isArray(prod.top_error_endpoints) ? prod.top_error_endpoints : [];
                    const topErrorsText = topErrors.length
                        ? `Top errors: ${topErrors.map(e => {
                            const err = Number(e.error_rate || 0);
                            const count = Number(e.count || 0);
                            const extra = Number.isFinite(err) ? `${err.toFixed(2)}%` : '0%';
                            return `${escapeHtml(e.method)} ${escapeHtml(e.path)} (${extra}, ${count})`;
                        }).join(' • ')}`
                        : '';

                    const topSlow = Array.isArray(prod.top_slow_endpoints) ? prod.top_slow_endpoints : [];
                    const topSlowText = topSlow.length
                        ? `Top slow: ${topSlow.map(e => {
                            const lat = Number(e.avg_latency || 0);
                            const count = Number(e.count || 0);
                            return `${escapeHtml(e.method)} ${escapeHtml(e.path)} (${lat.toFixed(0)}ms, ${count})`;
                        }).join(' • ')}`
                        : '';

                    const hotspotText = hotspots.length ? `Hotspots: ${hotspots.slice(0, 4).join(' • ')}` : '';

                    const legendParts = [
                        'Legend: API = /api/*',
                        'Batch (UI) = /batch/*',
                        'UI Pages = /dashboard, /active-stats',
                        'Δ = endpoint rollup − total req'
                    ];
                    const legendText = legendParts.join(' • ');

                    const loadTest = src.latest_load_test;
                    const loadTestText = loadTest
                        ? `Latest load test: ${escapeHtml(loadTest.scenario || loadTest.name || '—')} (${new Date(loadTest.timestamp).toLocaleString()})`
                        : 'Latest load test: none';

                    const baseline = src.active_baseline;
                    const baselineText = baseline
                        ? `Active baseline: ${escapeHtml(baseline.name)}`
                        : 'Active baseline: none';

                    const scopeText = src.tracking_scope
                        ? `Tracking scope: ${escapeHtml(src.tracking_scope)}`
                        : 'Tracking scope: non-static, non-health HTTP requests';

                    const extraLines = [breakdownText, categoryText, hotspotText, topText, topErrorsText, topSlowText, legendText].filter(Boolean);
                    const extraHtml = extraLines.length ? `<br>${extraLines.join('<br>')}` : '';

                    indicator.innerHTML = `<strong>Sources:</strong> ${prodParts.join(' • ')}<br>${loadTestText} • ${baselineText}${extraHtml}<br>${scopeText}`;
                }
            },

            // Update trend indicator
            updateTrend(elementId, trend) {
                const el = document.getElementById(elementId);
                if (!el) return;
                // null == no comparable prior window; render nothing rather than a fake 0%.
                if (trend === undefined || trend === null) {
                    el.innerHTML = '';
                    el.className = 'trend';
                    return;
                }

                if (trend > 0) {
                    el.innerHTML = `<i class="fas fa-arrow-up"></i> ${Math.abs(trend).toFixed(1)}%`;
                    el.className = 'trend up';
                } else if (trend < 0) {
                    el.innerHTML = `<i class="fas fa-arrow-down"></i> ${Math.abs(trend).toFixed(1)}%`;
                    el.className = 'trend down';
                } else {
                    el.innerHTML = '<i class="fas fa-minus"></i> 0%';
                    el.className = 'trend';
                }
            },

            // Load latency trends
            async loadLatencyTrends() {
                const isCurrent = this.beginRequest('latency');
                try {
                    const params = new URLSearchParams({ hours: this.currentTimeRange });
                    if (this.currentEndpoint) params.append('endpoint', this.currentEndpoint);
                    const result = await this.fetchJson(`/api/performance/latency-trends?${params}`);
                    if (!isCurrent()) return;

                    const trends = Array.isArray(result?.data?.trends) ? result.data.trends : [];
                    if (trends.length > 0) {
                        this.showChart('latencyTrendsChart', 'latencyTrendsEmpty');
                        this.renderLatencyTrendChart(trends);
                    } else {
                        this.showChartEmpty('latencyTrends', 'latencyTrendsChart', 'latencyTrendsEmpty', 'No latency data available for this time range.');
                    }
                } catch (err) {
                    if (!isCurrent()) return;
                    console.error('Failed to load latency trends:', err);
                    this.showChartEmpty('latencyTrends', 'latencyTrendsChart', 'latencyTrendsEmpty', 'Could not load latency trends. Try Refresh.');
                }
            },

            // Load throughput (all endpoints; the route has no per-endpoint data)
            async loadThroughput() {
                const isCurrent = this.beginRequest('throughput');
                try {
                    const result = await this.fetchJson(`/api/performance/throughput?hours=${this.currentTimeRange}`);
                    if (!isCurrent()) return;

                    const throughput = Array.isArray(result?.data?.throughput) ? result.data.throughput : [];
                    if (throughput.length > 0) {
                        this.showChart('throughputChart', 'throughputEmpty');
                        this.renderThroughputChart(throughput);
                    } else {
                        this.showChartEmpty('throughput', 'throughputChart', 'throughputEmpty', 'No throughput data available for this time range.');
                    }
                } catch (err) {
                    if (!isCurrent()) return;
                    console.error('Failed to load throughput:', err);
                    this.showChartEmpty('throughput', 'throughputChart', 'throughputEmpty', 'Could not load throughput. Try Refresh.');
                }
            },

            // Populate endpoint filter for the selected range, keeping the current choice.
            async populateEndpointFilter() {
                const isCurrent = this.beginRequest('endpoints');
                try {
                    const result = await this.fetchJson(`/api/performance/endpoints?hours=${this.currentTimeRange}`);
                    if (!isCurrent() || !Array.isArray(result.data)) return;

                    const select = document.getElementById('endpointFilter');
                    const selected = this.currentEndpoint;
                    select.length = 1; // keep "All Endpoints"
                    const endpoints = selected && !result.data.includes(selected) ? [selected, ...result.data] : result.data;
                    endpoints.forEach(endpoint => {
                        const option = document.createElement('option');
                        option.value = endpoint;
                        option.textContent = endpoint;
                        select.appendChild(option);
                    });
                    select.value = selected;
                } catch (err) {
                    console.error('Failed to load endpoints:', err);
                }
            },

            // Auto-refresh
            startAutoRefresh() {
                this.stopAutoRefresh();
                this.refreshCountdown = 60;
                this.refreshInterval = setInterval(() => {
                    this.refreshCountdown = 60;
                    // A hidden tab does not need fresh numbers; refresh when it is shown.
                    if (document.hidden) return;
                    this.loadAll({ fromTimer: true });
                }, 60000); // Refresh every 60 seconds
            },

            stopAutoRefresh() {
                if (this.refreshInterval) {
                    clearInterval(this.refreshInterval);
                    this.refreshInterval = null;
                }
            },

            startRefreshCountdown() {
                setInterval(() => {
                    if (this.autoRefreshEnabled && this.refreshCountdown > 0) {
                        this.refreshCountdown--;
                        document.getElementById('refreshCountdown').textContent = `(${this.refreshCountdown}s)`;
                    } else if (this.autoRefreshEnabled) {
                        this.refreshCountdown = 60;
                    } else {
                        document.getElementById('refreshCountdown').textContent = '';
                    }
                }, 1000);
            }
        };
