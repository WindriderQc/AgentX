Object.assign(PerformanceDashboard, {
            // Load load tests
            async loadLoadTests() {
                const isCurrent = this.beginRequest('loadTests');
                const loading = document.getElementById('loadTestsLoading');
                const empty = document.getElementById('loadTestsEmpty');
                try {
                    loading.classList.add('active');
                    const result = await this.fetchJson('/api/performance/load-tests?limit=50');
                    if (!isCurrent()) return;
                    this.loadTests = Array.isArray(result?.data?.tests) ? result.data.tests : [];
                    this.setLoadTestsEmpty('No Load Tests Found', null);
                    this.renderSortedLoadTests();
                } catch (err) {
                    if (!isCurrent()) return;
                    console.error('Failed to load load tests:', err);
                    this.loadTests = [];
                    this.setLoadTestsEmpty('Load tests unavailable', 'Could not load load tests. Try Refresh.');
                    this.renderSortedLoadTests();
                } finally {
                    if (isCurrent()) loading.classList.remove('active');
                }
            },

            setLoadTestsEmpty(title, detail) {
                const empty = document.getElementById('loadTestsEmpty');
                const heading = empty.querySelector('h3');
                const text = empty.querySelector('p');
                if (!this.loadTestsEmptyDefault && text) this.loadTestsEmptyDefault = text.textContent;
                if (heading) heading.textContent = title;
                if (text) text.textContent = detail || this.loadTestsEmptyDefault || '';
            },

            renderSortedLoadTests() {
                const tests = this.sortedLoadTests(this.loadTests || []);
                const hasTests = tests.length > 0;
                if (hasTests) this.renderLoadTestsTable(tests);
                document.getElementById('loadTestsTableContainer').style.display = hasTests ? 'block' : 'none';
                document.getElementById('loadTestsEmpty').style.display = hasTests ? 'none' : 'block';
            },

            sortedLoadTests(tests) {
                const value = (test) => {
                    switch (this.sortColumn) {
                        case 'scenario': return String(test.scenario || '').toLowerCase();
                        case 'duration': return Number(test.summary?.duration) || 0;
                        case 'rps': return Number(test.summary?.rps_max ?? test.summary?.rps_mean) || 0;
                        case 'success': return 100 - (Number(test.summary?.error_rate) || 0);
                        case 'p95': return Number(test.latency?.p95) || 0;
                        default: return new Date(test.timestamp).getTime() || 0;
                    }
                };
                const direction = this.sortDirection === 'asc' ? 1 : -1;
                return [...tests].sort((a, b) => {
                    const left = value(a);
                    const right = value(b);
                    return left < right ? -direction : left > right ? direction : 0;
                });
            },

            // Render load tests table
            renderLoadTestsTable(tests) {
                const tbody = document.getElementById('loadTestsBody');
                tbody.innerHTML = '';

                tests.forEach(test => {
                    const row = document.createElement('tr');
                    row.dataset.testId = test._id;

                    const date = new Date(test.timestamp).toLocaleString();
                    const scenario = test.scenario || 'Load Test';
                    const duration = test.summary?.duration ? `${(test.summary.duration / 60).toFixed(1)}m` : '—';
                    const rps = Number(test.summary?.rps_max ?? test.summary?.rps_mean);
                    const rpsText = Number.isFinite(rps) ? rps.toFixed(1) : '—';
                    const errorRate = Number(test.summary?.error_rate || 0);
                    const successRate = (100 - errorRate).toFixed(1);
                    const p95 = test.latency?.p95 ? `${Number(test.latency.p95).toFixed(0)}ms` : '—';
                    const status = errorRate > 0 ? 'warning' : 'success';

                    row.innerHTML = `
                        <td>${date}</td>
                        <td>${escapeHtml(scenario)}</td>
                        <td class="text-right mono">${duration}</td>
                        <td class="text-right mono">${rpsText}</td>
                        <td class="text-right mono">${successRate}%</td>
                        <td class="text-right mono">${p95}</td>
                        <td class="text-center">
                            <span class="badge ${status === 'success' ? 'healthy' : 'degraded'}" style="font-size: 10px; padding: 4px 8px;">
                                ${status === 'success' ? 'PASS' : 'WARN'}
                            </span>
                        </td>
                        <td class="text-center">
                            <button class="action-btn view-details-btn" data-test-id="${escapeHtml(test._id)}">
                                <i class="fas fa-eye"></i> Details
                            </button>
                        </td>
                    `;

                    tbody.appendChild(row);

                    // Attach event listeners
                    row.querySelector('.view-details-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.toggleTestDetails(test._id, test);
                    });
                });
            },

            // Toggle test details
            toggleTestDetails(testId, testData) {
                const row = document.querySelector(`tr[data-test-id="${CSS.escape(String(testId))}"]`);
                const existingDetails = row.nextElementSibling;

                if (existingDetails && existingDetails.classList.contains('test-details-row')) {
                    existingDetails.remove();
                    row.classList.remove('expanded');
                    return;
                }

                row.classList.add('expanded');

                const detailsRow = document.createElement('tr');
                detailsRow.classList.add('test-details-row');
                detailsRow.innerHTML = `
                    <td colspan="8">
                        <div class="test-details">
                            <h4>Test Summary</h4>
                            <div class="detail-grid">
                                <div class="detail-item">
                                    <div class="detail-label">Scenario</div>
                                    <div class="detail-value">${escapeHtml(testData.scenario || 'N/A')}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Duration</div>
                                    <div class="detail-value">${testData.summary?.duration ? `${(testData.summary.duration / 60).toFixed(1)} minutes` : 'N/A'}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Total Requests</div>
                                    <div class="detail-value">${Number(testData.summary?.requests_completed) || 0}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">RPS (Mean)</div>
                                    <div class="detail-value">${Number.isFinite(testData.summary?.rps_mean) ? Number(testData.summary.rps_mean).toFixed(2) : 'N/A'}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">RPS (Max)</div>
                                    <div class="detail-value">${Number.isFinite(testData.summary?.rps_max) ? Number(testData.summary.rps_max).toFixed(2) : 'N/A'}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">P50 Latency</div>
                                    <div class="detail-value">${Number.isFinite(testData.latency?.median) ? Number(testData.latency.median).toFixed(0) : 'N/A'} ms</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">P95 Latency</div>
                                    <div class="detail-value">${Number.isFinite(testData.latency?.p95) ? Number(testData.latency.p95).toFixed(0) : 'N/A'} ms</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">P99 Latency</div>
                                    <div class="detail-value">${Number.isFinite(testData.latency?.p99) ? Number(testData.latency.p99).toFixed(0) : 'N/A'} ms</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Errors</div>
                                    <div class="detail-value">${testData.summary?.error_rate ? `${Number(testData.summary.error_rate).toFixed(2)}%` : '0.00%'}</div>
                                </div>
                            </div>
                            ${testData.notes ? `<p style="margin-top: 12px; color: var(--muted); font-size: 12px;"><strong>Notes:</strong> ${escapeHtml(testData.notes)}</p>` : ''}
                        </div>
                    </td>
                `;

                row.after(detailsRow);
            },

            // Sort load tests
            sortLoadTests(key) {
                if (this.sortColumn === key) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortColumn = key;
                    this.sortDirection = 'desc';
                }

                document.querySelectorAll('#loadTestsTable th.sortable').forEach(th => {
                    th.classList.remove('sorted-asc', 'sorted-desc');
                    const active = th.dataset.sort === key;
                    if (active) th.classList.add(this.sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
                    th.setAttribute('aria-sort', active ? (this.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
                });

                this.renderSortedLoadTests();
            },

            // Import load test
            async importLoadTest() {
                const submit = document.getElementById('importTestSubmit');
                if (submit.disabled) return;
                submit.disabled = true;
                try {
                    const fileInput = document.getElementById('testFile');
                    const scenario = document.getElementById('testScenario').value;
                    const notes = document.getElementById('testNotes').value;

                    if (!fileInput.files || !fileInput.files[0]) {
                        alert('Please select a file to upload');
                        return;
                    }

                    const file = fileInput.files[0];
                    const fileContent = await file.text();
                    const artilleryData = JSON.parse(fileContent);

                    const nameBase = file.name ? file.name.replace(/\.[^.]+$/, '') : 'load-test';
                    const formData = {
                        name: notes ? `${nameBase} - ${notes}` : nameBase,
                        scenario: scenario || 'Load Test',
                        raw_report: artilleryData,
                        timestamp: new Date().toISOString()
                    };

                    const response = await fetch('/api/performance/load-tests', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(formData)
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        alert('Load test imported successfully!');
                        document.getElementById('importTestModal').classList.remove('active');
                        document.getElementById('importTestForm').reset();
                        await this.loadLoadTests();
                    } else {
                        alert('Failed to import load test: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Import failed:', err);
                    alert('Failed to import load test: ' + err.message);
                } finally {
                    submit.disabled = false;
                }
            }
});
