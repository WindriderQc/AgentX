Object.assign(PerformanceDashboard, {
            // Load baselines
            async loadBaselines() {
                const loading = document.getElementById('baselineLoading');
                const empty = document.getElementById('baselinesEmpty');
                try {
                    loading.classList.add('active');
                    const response = await fetch('/api/performance/baselines', { signal: AbortSignal.timeout(30000) });
                    const result = await response.json();
                    loading.classList.remove('active');
                    if (!response.ok || result.status !== 'success') throw new Error(result.message || `HTTP ${response.status}`);

                    const baselines = Array.isArray(result?.data?.baselines) ? result.data.baselines : [];
                    this.renderBaselines(baselines);
                    this.setBaselinesEmpty('No Baselines Created', 'Create a baseline to track performance over time');
                    empty.style.display = baselines.length ? 'none' : 'block';

                    // The comparison card and alerts only exist while a baseline is active.
                    if (baselines.some(b => b.active)) {
                        await this.loadBaselineComparison();
                    } else {
                        this.clearBaselineComparison();
                    }
                } catch (err) {
                    console.error('Failed to load baselines:', err);
                    loading.classList.remove('active');
                    this.renderBaselines([]);
                    this.clearBaselineComparison();
                    this.setBaselinesEmpty('Baselines unavailable', 'Could not load baselines. Try Refresh.');
                    empty.style.display = 'block';
                }
            },

            setBaselinesEmpty(title, detail) {
                const empty = document.getElementById('baselinesEmpty');
                empty.querySelector('h3').textContent = title;
                empty.querySelector('p').textContent = detail;
            },

            clearBaselineComparison() {
                document.getElementById('activeBaselineCard').style.display = 'none';
                document.getElementById('comparisonGrid').innerHTML = '';
                document.getElementById('regressionAlerts').innerHTML = '';
            },

            // Render baselines list
            renderBaselines(baselines) {
                const list = document.getElementById('baselineList');
                list.innerHTML = '';

                baselines.forEach(baseline => {
                    const item = document.createElement('div');
                    item.classList.add('baseline-item');
                    if (baseline.active) {
                        item.classList.add('active');
                    }

                    const created = baseline.created_at || baseline.createdAt;
                    const date = created ? new Date(created).toLocaleDateString() : '—';

                    item.innerHTML = `
                        <div class="baseline-info">
                            <div class="baseline-name">${escapeHtml(baseline.name)}</div>
                            <div class="baseline-meta">
                                Created: ${date} ${baseline.active ? '• <strong style="color: var(--accent);">ACTIVE</strong>' : ''}
                            </div>
                        </div>
                        <div class="baseline-actions">
                            ${!baseline.active ? `
                                <button type="button" class="action-btn activate-baseline-btn">
                                    <i class="fas fa-check" aria-hidden="true"></i> Activate
                                </button>
                            ` : ''}
                            <button type="button" class="action-btn delete-baseline-btn">
                                <i class="fas fa-trash" aria-hidden="true"></i> Delete
                            </button>
                        </div>
                    `;

                    list.appendChild(item);

                    const activateBtn = item.querySelector('.activate-baseline-btn');
                    if (activateBtn) {
                        activateBtn.addEventListener('click', () => this.activateBaseline(baseline._id));
                    }
                    // The typed confirmation in deleteBaseline is the only prompt.
                    item.querySelector('.delete-baseline-btn').addEventListener('click', () => this.deleteBaseline(baseline._id));
                });
            },

            // Load baseline comparison
            async loadBaselineComparison() {
                const hours = this.currentTimeRange;
                try {
                    const response = await fetch(`/api/performance/baseline-compare?hours=${hours}`, { signal: AbortSignal.timeout(30000) });
                    const result = await response.json();
                    if (hours !== this.currentTimeRange) return;

                    if (response.ok && result.status === 'success' && result.data) {
                        this.renderBaselineComparison(result.data);
                        this.renderRegressions(result.data.regressions);
                    } else {
                        // 404: the active baseline has nothing to compare against in this window.
                        this.clearBaselineComparison();
                    }
                } catch (err) {
                    console.error('Failed to load baseline comparison:', err);
                    this.clearBaselineComparison();
                }
            },

            // Render baseline comparison
            renderBaselineComparison(data) {
                const card = document.getElementById('activeBaselineCard');
                card.style.display = 'block';

                document.getElementById('activeBaselineName').textContent = data.baseline.name;
                document.getElementById('activeBaselineDate').textContent = data.baseline.created_at
                    ? new Date(data.baseline.created_at).toLocaleDateString()
                    : '—';

                const grid = document.getElementById('comparisonGrid');
                grid.innerHTML = '';

                const metrics = [
                    { key: 'avg_response_time', label: 'Avg Response Time', unit: 'ms', lowerIsBetter: true },
                    { key: 'p95_latency', label: 'P95 Latency', unit: 'ms', lowerIsBetter: true },
                    { key: 'throughput_rps', label: 'Throughput', unit: 'rps', lowerIsBetter: false },
                    { key: 'error_rate', label: 'Error Rate', unit: '%', lowerIsBetter: true }
                ];

                const format = (value, unit) => (value === null || value === undefined || !Number.isFinite(Number(value))
                    ? '—'
                    : `${Number(value).toFixed(unit === '%' ? 2 : 1)}${unit}`);

                metrics.forEach(metric => {
                    const rawBaseline = data.baseline.metrics?.[metric.key];
                    const rawCurrent = data.current?.[metric.key];
                    const baselineValue = Number(rawBaseline);
                    const currentValue = Number(rawCurrent);
                    // A zero or missing side has no meaningful percentage change.
                    const comparable = rawBaseline != null && rawCurrent != null
                        && Number.isFinite(baselineValue) && Number.isFinite(currentValue) && baselineValue !== 0;
                    const diff = comparable ? ((currentValue - baselineValue) / baselineValue) * 100 : null;
                    const isImprovement = diff !== null && (metric.lowerIsBetter ? diff < 0 : diff > 0);
                    const diffText = diff === null ? 'n/a' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`;
                    const diffClass = diff === null || diff === 0 ? '' : (isImprovement ? 'positive' : 'negative');

                    const item = document.createElement('div');
                    item.classList.add('comparison-item');
                    item.innerHTML = `
                        <div class="metric-label">${metric.label}</div>
                        <div class="metric-values">
                            <span class="baseline-value">${format(rawBaseline, metric.unit)}</span>
                            <span style="color: var(--muted);" aria-label="compared with">→</span>
                            <span class="current-value">${format(rawCurrent, metric.unit)}</span>
                            <span class="diff ${diffClass}">${diffText}</span>
                        </div>
                    `;
                    grid.appendChild(item);
                });
            },

            // Render the regressions the server detected; the client does not
            // recompute them with its own thresholds.
            renderRegressions(regressions) {
                const alertsContainer = document.getElementById('regressionAlerts');
                alertsContainer.innerHTML = '';
                const labels = { p95_latency: 'P95 latency', error_rate: 'Error rate' };
                const units = { p95_latency: 'ms', error_rate: '%' };

                (Array.isArray(regressions) ? regressions : []).forEach(regression => {
                    const unit = units[regression.metric] || '';
                    const value = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(unit === '%' ? 2 : 0)}${unit}` : '—');
                    const alert = document.createElement('div');
                    alert.classList.add('alert-banner');
                    alert.setAttribute('role', 'alert');
                    alert.innerHTML = `
                        <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                        <div class="alert-content">
                            <h4>Performance Regression Detected</h4>
                            <p>${escapeHtml(labels[regression.metric] || regression.metric)} above its ${escapeHtml(regression.threshold || 'threshold')}: ${value(regression.baseline)} → ${value(regression.current)}</p>
                        </div>
                    `;
                    alertsContainer.appendChild(alert);
                });
            },

            // Open create baseline modal
            openCreateBaselineModal() {
                // Populate load test dropdown
                fetch('/api/performance/load-tests?limit=10')
                    .then(res => res.json())
                    .then(result => {
                        const tests = result?.data?.tests || [];
                        if (result.status === 'success' && tests.length > 0) {
                            const select = document.getElementById('baselineLoadTest');
                            select.innerHTML = '<option value="">Select a load test...</option>';
                            tests.forEach(test => {
                                const option = document.createElement('option');
                                option.value = test._id;
                                option.textContent = `${test.scenario} - ${new Date(test.timestamp).toLocaleDateString()}`;
                                select.appendChild(option);
                            });
                        }
                    });

                document.getElementById('createBaselineModal').classList.add('active');
            },

            // Create baseline
            async createBaseline() {
                try {
                    const name = document.getElementById('baselineName').value;
                    const description = document.getElementById('baselineDescription').value;
                    const source = document.getElementById('baselineSource').value;
                    const loadTestId = document.getElementById('baselineLoadTest').value;

                    const data = { name, description };

                    if (source === 'loadtest' && loadTestId) {
                        data.source = 'load_test';
                        data.loadTestId = loadTestId;
                    } else {
                        data.source = 'manual';
                    }

                    const response = await fetch('/api/performance/baselines', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        alert('Baseline created successfully!');
                        document.getElementById('createBaselineModal').classList.remove('active');
                        document.getElementById('createBaselineForm').reset();
                        await this.loadBaselines();
                    } else {
                        alert('Failed to create baseline: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Create baseline failed:', err);
                    alert('Failed to create baseline: ' + err.message);
                }
            },

            // Set baseline from test
            setBaselineFromTest(testId) {
                document.getElementById('baselineSource').value = 'loadtest';
                document.getElementById('loadTestSelectGroup').style.display = 'block';
                document.getElementById('baselineLoadTest').value = testId;
                this.openCreateBaselineModal();
            },

            // Activate baseline
            async activateBaseline(id) {
                try {
                    const response = await fetch(`/api/performance/baselines/${id}/activate`, {
                        method: 'POST'
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        await this.loadBaselines();
                    } else {
                        alert('Failed to activate baseline: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Activate baseline failed:', err);
                    alert('Failed to activate baseline: ' + err.message);
                }
            },

            // Delete baseline
            async deleteBaseline(id) {
                const headers = await window.AgentXTypedConfirmation.confirm({
                    action: 'DELETE PERFORMANCE BASELINE',
                    resource: id,
                    title: 'Delete performance baseline',
                    description: 'Delete this comparison baseline? Historical test results remain, but this baseline record cannot be recovered.'
                });
                if (!headers) return;
                try {
                    const response = await fetch(`/api/performance/baselines/${id}`, {
                        method: 'DELETE',
                        headers
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        await this.loadBaselines();
                    } else {
                        alert('Failed to delete baseline: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Delete baseline failed:', err);
                    alert('Failed to delete baseline: ' + err.message);
                }
            }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    PerformanceDashboard.init();
});
