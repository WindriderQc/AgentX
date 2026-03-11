/**
 * Courthouse Validation Module
 *
 * Judge health checks, consistency tests, bias detection, and calibration analysis.
 * Extracted from courthouse-analytics.js to keep within the 1200-line frontend limit.
 *
 * Consumed by: public/js/courthouse-analytics.js (imported as ES module)
 */

/**
 * Factory — call once, passing shared dependencies from the main IIFE.
 *
 * @param {Object}   deps
 * @param {Function} deps.showToast     - toast notification helper
 * @param {string}   deps.BENCHMARK_API - base API path
 * @param {Function} deps.escapeHtml    - HTML entity escaper
 * @returns {{ setupValidationListeners, runHealthCheck, runConsistencyTest, runBiasDetection, runCalibrationAnalysis }}
 */
export function makeValidation({ showToast, BENCHMARK_API, escapeHtml }) {
    // ============ Validation Functions ============

    // Charts for validation
    let calibrationHistogramChart = null;
    let lengthBiasChart = null;
    let formatBiasChart = null;
    let failureReasonsChart = null;
    let failuresByCategoryChart = null;

    /**
     * Setup validation event listeners
     */
    function setupValidationListeners() {
        // Tab switching
        document.querySelectorAll('.validation-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.validation-tab').forEach(t => {
                    t.classList.remove('active');
                    t.style.background = 'transparent';
                    t.style.color = 'var(--muted)';
                });
                tab.classList.add('active');
                tab.style.background = 'rgba(124, 240, 255, 0.1)';
                tab.style.color = 'var(--accent)';

                document.querySelectorAll('.validation-tab-content').forEach(c => c.style.display = 'none');
                const tabId = tab.dataset.tab + 'Tab';
                const content = document.getElementById(tabId);
                if (content) content.style.display = 'block';
            });
        });

        // Health check button
        const healthBtn = document.getElementById('runHealthCheckBtn');
        if (healthBtn) healthBtn.addEventListener('click', runHealthCheck);

        // Consistency test button
        const consistencyBtn = document.getElementById('runConsistencyBtn');
        if (consistencyBtn) consistencyBtn.addEventListener('click', runConsistencyTest);

        // Bias detection button
        const biasBtn = document.getElementById('runBiasBtn');
        if (biasBtn) biasBtn.addEventListener('click', runBiasDetection);

        // Calibration button
        const calibrationBtn = document.getElementById('runCalibrationBtn');
        if (calibrationBtn) calibrationBtn.addEventListener('click', runCalibrationAnalysis);
    }

    /**
     * Run comprehensive health check
     */
    async function runHealthCheck() {
        const btn = document.getElementById('runHealthCheckBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/health`);
            const { data } = await res.json();

            // Update health stats
            const healthScore = document.getElementById('healthScore');
            const healthConsistency = document.getElementById('healthConsistency');
            const healthCalibration = document.getElementById('healthCalibration');
            const healthFailureRate = document.getElementById('healthFailureRate');

            if (healthScore) {
                healthScore.textContent = data.overall?.health_score ?? '-';
                healthScore.style.color = data.overall?.health_score >= 80 ? '#2ecc71' :
                    data.overall?.health_score >= 60 ? '#f1c40f' : '#e74c3c';
            }

            if (healthConsistency) {
                const stdDev = data.consistency?.avg_std_dev;
                healthConsistency.textContent = stdDev !== undefined ? stdDev.toFixed(3) : '-';
                if (stdDev !== undefined) {
                    healthConsistency.style.color = stdDev < 0.3 ? '#2ecc71' : stdDev < 0.5 ? '#f1c40f' : '#e74c3c';
                }
            }

            if (healthCalibration) {
                healthCalibration.textContent = data.calibration?.calibration_grade ?? '-';
            }

            if (healthFailureRate) {
                const rate = data.failures?.failure_rate;
                healthFailureRate.textContent = rate !== undefined ? rate.toFixed(1) + '%' : '-';
                if (rate !== undefined) {
                    healthFailureRate.style.color = rate < 5 ? '#2ecc71' : rate < 15 ? '#f1c40f' : '#e74c3c';
                }
            }

            // Show issues if any
            const issuesContainer = document.getElementById('healthIssues');
            const issuesList = document.getElementById('healthIssuesList');
            if (issuesContainer && issuesList) {
                if (data.overall?.issues?.length > 0) {
                    issuesContainer.style.display = 'block';
                    issuesList.innerHTML = data.overall.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('');
                } else {
                    issuesContainer.style.display = 'none';
                }
            }

            showToast(`Health check complete: ${data.overall?.status || 'unknown'}`,
                data.overall?.status === 'healthy' ? 'success' : 'warning');

            // Also populate failures tab if data available
            if (data.failures) {
                populateFailuresTab(data.failures);
            }

        } catch (err) {
            console.error('Health check failed:', err);
            showToast('Health check failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-stethoscope"></i> Run Health Check';
            }
        }
    }

    /**
     * Run consistency test
     */
    async function runConsistencyTest() {
        const btn = document.getElementById('runConsistencyBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/validate/consistency`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sampleSize: 10, repeats: 3 })
            });
            const { data } = await res.json();

            const placeholder = document.getElementById('consistencyPlaceholder');
            const results = document.getElementById('consistencyResults');
            if (placeholder) placeholder.style.display = 'none';
            if (results) results.style.display = 'block';

            // Update stats
            const avgStdDev = document.getElementById('consistencyAvgStdDev');
            const maxStdDev = document.getElementById('consistencyMaxStdDev');
            const score = document.getElementById('consistencyScore');
            const pass = document.getElementById('consistencyPass');

            if (avgStdDev) avgStdDev.textContent = data.summary?.avg_std_dev?.toFixed(3) ?? '-';
            if (maxStdDev) maxStdDev.textContent = data.summary?.max_std_dev?.toFixed(3) ?? '-';
            if (score) score.textContent = data.summary?.consistency_score?.toFixed(1) ?? '-';
            if (pass) {
                pass.textContent = data.summary?.pass ? 'PASS' : 'FAIL';
                pass.style.color = data.summary?.pass ? '#2ecc71' : '#e74c3c';
            }

            // Populate table
            const tbody = document.getElementById('consistencyTableBody');
            if (tbody && data.details) {
                tbody.innerHTML = data.details.map(d => `
                    <tr>
                        <td style="padding: 8px;">${escapeHtml(d.prompt_name || 'N/A')}</td>
                        <td style="padding: 8px;">${escapeHtml(d.category || 'N/A')}</td>
                        <td style="padding: 8px; text-align: center;">${d.original_score?.toFixed(1) ?? '-'}</td>
                        <td style="padding: 8px;">${d.scores?.map(s => s.toFixed(1)).join(', ') || '-'}</td>
                        <td style="padding: 8px; text-align: center;">${d.mean?.toFixed(2) ?? '-'}</td>
                        <td style="padding: 8px; text-align: center; color: ${d.stdDev < 0.3 ? '#2ecc71' : d.stdDev < 0.5 ? '#f1c40f' : '#e74c3c'}">
                            ${d.stdDev?.toFixed(3) ?? '-'}
                        </td>
                    </tr>
                `).join('');
            }

            showToast('Consistency test complete', 'success');

        } catch (err) {
            console.error('Consistency test failed:', err);
            showToast('Consistency test failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-random"></i> Test Consistency';
            }
        }
    }

    /**
     * Run bias detection
     */
    async function runBiasDetection() {
        const btn = document.getElementById('runBiasBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/validate/bias?sampleSize=100`);
            const { data } = await res.json();

            const placeholder = document.getElementById('biasPlaceholder');
            const results = document.getElementById('biasResults');
            if (placeholder) placeholder.style.display = 'none';
            if (results) results.style.display = 'block';

            // Update stats
            const samplesEl = document.getElementById('biasSamplesAnalyzed');
            const lengthEl = document.getElementById('biasLengthDetected');
            const modelsEl = document.getElementById('biasModelsAnalyzed');

            if (samplesEl) samplesEl.textContent = data.summary?.samples_analyzed ?? '-';
            if (lengthEl) {
                lengthEl.textContent = data.summary?.length_bias_detected ? 'Detected' : 'Minimal';
                lengthEl.style.color = data.summary?.length_bias_detected ? '#e74c3c' : '#2ecc71';
            }
            if (modelsEl) modelsEl.textContent = data.summary?.models_analyzed ?? '-';

            // Length bias chart
            if (data.length_bias) {
                const ctx = document.getElementById('lengthBiasChart');
                if (ctx) {
                    if (lengthBiasChart) lengthBiasChart.destroy();
                    const labels = Object.keys(data.length_bias);
                    const scores = labels.map(l => data.length_bias[l]?.avg_score || 0);
                    lengthBiasChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [{
                                label: 'Avg Score',
                                data: scores,
                                backgroundColor: 'rgba(124, 240, 255, 0.4)',
                                borderColor: '#7CF0FF',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                y: { beginAtZero: true, max: 10, ticks: { color: '#888' } },
                                x: { ticks: { color: '#888' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }

            // Format bias chart
            if (data.format_bias) {
                const ctx = document.getElementById('formatBiasChart');
                if (ctx) {
                    if (formatBiasChart) formatBiasChart.destroy();
                    const labels = Object.keys(data.format_bias);
                    const scores = labels.map(l => data.format_bias[l]?.avg_score || 0);
                    formatBiasChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: labels.map(l => l.replace(/_/g, ' ')),
                            datasets: [{
                                label: 'Avg Score',
                                data: scores,
                                backgroundColor: 'rgba(0, 255, 159, 0.4)',
                                borderColor: '#00FF9F',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                y: { beginAtZero: true, max: 10, ticks: { color: '#888' } },
                                x: { ticks: { color: '#888' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }

            // Recommendations
            const recList = document.getElementById('biasRecommendationsList');
            if (recList && data.recommendations) {
                recList.innerHTML = data.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('');
            }

            showToast('Bias detection complete', 'success');

        } catch (err) {
            console.error('Bias detection failed:', err);
            showToast('Bias detection failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-balance-scale-left"></i> Detect Bias';
            }
        }
    }

    /**
     * Run calibration analysis
     */
    async function runCalibrationAnalysis() {
        const btn = document.getElementById('runCalibrationBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
        }

        try {
            const res = await fetch(`${BENCHMARK_API}/judge/validate/calibration?days=30`);
            const { data } = await res.json();

            const placeholder = document.getElementById('calibrationPlaceholder');
            const results = document.getElementById('calibrationResults');
            if (placeholder) placeholder.style.display = 'none';
            if (results) results.style.display = 'block';

            // Update stats
            const meanEl = document.getElementById('calibrationMean');
            const stdDevEl = document.getElementById('calibrationStdDev');
            const skewEl = document.getElementById('calibrationSkewness');
            const gradeEl = document.getElementById('calibrationGrade');

            if (meanEl) meanEl.textContent = data.summary?.mean?.toFixed(2) ?? '-';
            if (stdDevEl) stdDevEl.textContent = data.summary?.std_dev?.toFixed(2) ?? '-';
            if (skewEl) skewEl.textContent = data.summary?.skewness?.toFixed(2) ?? '-';
            if (gradeEl) {
                gradeEl.textContent = data.summary?.calibration_grade ?? '-';
                const grade = data.summary?.calibration_grade;
                gradeEl.style.color = grade === 'A' ? '#2ecc71' : grade === 'B' ? '#f1c40f' : '#e74c3c';
            }

            // Histogram chart
            if (data.histogram) {
                const ctx = document.getElementById('calibrationHistogram');
                if (ctx) {
                    if (calibrationHistogramChart) calibrationHistogramChart.destroy();
                    const labels = Object.keys(data.histogram).sort((a, b) => parseFloat(a) - parseFloat(b));
                    const counts = labels.map(l => data.histogram[l] || 0);
                    calibrationHistogramChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [{
                                label: 'Count',
                                data: counts,
                                backgroundColor: 'rgba(124, 240, 255, 0.4)',
                                borderColor: '#7CF0FF',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                y: { beginAtZero: true, ticks: { color: '#888' } },
                                x: { ticks: { color: '#888' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }

            // Level discrimination
            const levelEl = document.getElementById('levelDiscrimination');
            if (levelEl && data.level_discrimination) {
                const levels = Object.entries(data.level_discrimination).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
                levelEl.innerHTML = `
                    <table style="width: 100%; font-size: 0.9em;">
                        <tr style="color: var(--muted);"><th style="text-align: left; padding: 4px;">Level</th><th style="text-align: right; padding: 4px;">Avg Score</th></tr>
                        ${levels.map(([level, score]) => `
                            <tr>
                                <td style="padding: 4px;">Level ${level}</td>
                                <td style="padding: 4px; text-align: right; color: var(--accent);">${score.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </table>
                    <div style="margin-top: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 0.85em; color: var(--muted);">
                        ${data.summary?.discrimination_ok ?
                            '<span style="color: #2ecc71;">Good discrimination: harder levels get lower scores</span>' :
                            '<span style="color: #e74c3c;">Poor discrimination: scores don\'t correlate with difficulty</span>'}
                    </div>
                `;
            }

            showToast('Calibration analysis complete', 'success');

        } catch (err) {
            console.error('Calibration analysis failed:', err);
            showToast('Calibration analysis failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-sliders-h"></i> Check Calibration';
            }
        }
    }

    /**
     * Populate failures tab from health check data
     */
    function populateFailuresTab(failuresData) {
        const placeholder = document.getElementById('failuresPlaceholder');
        const results = document.getElementById('failuresResults');
        if (placeholder) placeholder.style.display = 'none';
        if (results) results.style.display = 'block';

        // Update stats
        const totalEl = document.getElementById('failuresTotal');
        const rateEl = document.getElementById('failuresRate');
        const emptyEl = document.getElementById('failuresEmpty');
        const healthEl = document.getElementById('failuresHealth');

        if (totalEl) totalEl.textContent = failuresData.total_judge_attempts ?? '-';
        if (rateEl) {
            rateEl.textContent = (failuresData.failure_rate?.toFixed(1) ?? '-') + '%';
            rateEl.style.color = failuresData.failure_rate < 5 ? '#2ecc71' : failuresData.failure_rate < 15 ? '#f1c40f' : '#e74c3c';
        }
        if (emptyEl) emptyEl.textContent = failuresData.empty_responses ?? '-';
        if (healthEl) {
            healthEl.textContent = failuresData.health_status ?? '-';
            healthEl.style.color = failuresData.health_status === 'healthy' ? '#2ecc71' :
                failuresData.health_status === 'degraded' ? '#f1c40f' : '#e74c3c';
        }

        // Failure reasons chart
        if (failuresData.failure_reasons) {
            const ctx = document.getElementById('failureReasonsChart');
            if (ctx) {
                if (failureReasonsChart) failureReasonsChart.destroy();
                const labels = Object.keys(failuresData.failure_reasons);
                const counts = labels.map(l => failuresData.failure_reasons[l] || 0);
                failureReasonsChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: labels.map(l => l.replace(/_/g, ' ')),
                        datasets: [{
                            data: counts,
                            backgroundColor: ['#FF6B9D', '#7CF0FF', '#FFD700', '#A78BFA', '#34D399', '#00FF9F']
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: false,
                        plugins: {
                            legend: { position: 'right', labels: { color: '#888' } }
                        }
                    }
                });
            }
        }

        // Failures by category chart
        if (failuresData.failures_by_category) {
            const ctx = document.getElementById('failuresByCategoryChart');
            if (ctx) {
                if (failuresByCategoryChart) failuresByCategoryChart.destroy();
                const labels = Object.keys(failuresData.failures_by_category);
                const counts = labels.map(l => failuresData.failures_by_category[l] || 0);
                failuresByCategoryChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels,
                        datasets: [{
                            label: 'Failures',
                            data: counts,
                            backgroundColor: 'rgba(255, 107, 157, 0.4)',
                            borderColor: '#FF6B9D',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: false,
                        scales: {
                            y: { beginAtZero: true, ticks: { color: '#888' } },
                            x: { ticks: { color: '#888' } }
                        },
                        plugins: { legend: { display: false } }
                    }
                });
            }
        }

        // Recommendations
        const recList = document.getElementById('failuresRecommendationsList');
        if (recList && failuresData.recommendations) {
            recList.innerHTML = failuresData.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('');
        }
    }

    return {
        setupValidationListeners,
        runHealthCheck,
        runConsistencyTest,
        runBiasDetection,
        runCalibrationAnalysis
    };
}
