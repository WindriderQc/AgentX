        const BENCHMARK_API = '/api/benchmark';
        let latencyChart, tokensChart, qualityChart, compositeChart;
        let ollamaHosts = [];
        let currentSortBy = 'composite';
        let currentJudgeConfig = {};

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

        function inferOppositeHostUrl(execHostUrl) {
            if (!execHostUrl) return null;
            const other = Array.isArray(ollamaHosts)
                ? ollamaHosts.find(h => h && h.url && h.url !== execHostUrl)
                : null;
            return other ? other.url : null;
        }

        function renderBatchPlan(plan, fallbackHostUrl, qualityScoringEnabled) {
            if (!plan) {
                const judgeModel = currentJudgeConfig.model || '(server default)';
                const exec = fallbackHostUrl ? formatHostLabel(fallbackHostUrl) : '(unknown)';
                const judgeHostUrl = qualityScoringEnabled
                    ? (currentJudgeConfig.judge_same_host ? fallbackHostUrl : inferOppositeHostUrl(fallbackHostUrl))
                    : null;
                const judgeHost = qualityScoringEnabled ? formatHostLabel(judgeHostUrl) : 'Disabled';

                return `
                    <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                        <span class="badge bg-light text-dark border">Exec: ${exec}</span>
                        <span class="text-muted">•</span>
                        <span class="badge bg-light text-dark border">Judge: ${judgeModel}</span>
                        <span class="text-muted">•</span>
                        <span class="badge bg-light text-dark border">Judge Host: ${judgeHost}</span>
                    </div>
                `;
            }

            const judgeModel = plan.judge_model || currentJudgeConfig.model || '(server default)';
            let html = '';

            // 1. Judge Info Header
            html += `<div class="d-flex align-items-center mb-3 p-2 bg-light rounded border">`;
            html += `<i class="fas fa-gavel me-2 text-primary"></i>`;
            html += `<strong class="me-2">Judge Model:</strong>`;
            html += `<span class="badge bg-primary me-2">${judgeModel}</span>`;
            if (!qualityScoringEnabled) {
                html += `<span class="badge bg-danger">Disabled</span>`;
            }
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
                const res = await fetch(`${BENCHMARK_API}/config`);
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
            try {
                const res = await fetch('/api/ollama-hosts');
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                const json = await res.json();
                const data = json.data || json;

                if (data.hosts && data.hosts.length > 0) {
                    ollamaHosts = data.hosts;

                    // Populate host select
                    const select = document.getElementById('host');
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
                    loadModelsForHost(select.value);
                } else {
                    throw new Error('No hosts configured');
                }
            } catch (err) {
                console.error('Failed to load Ollama hosts:', err);
                document.getElementById('host').innerHTML =
                    '<option value="http://localhost:11434">Default (http://localhost:11434)</option>';
            }
        }

        // Load available models for selected host
        function loadModelsForHost(hostUrl) {
            const host = ollamaHosts.find(h => h.url === hostUrl);
            const modelSelect = document.getElementById('model');

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
            loadModelsForHost(e.target.value);
            loadBatchModels(e.target.value); // Also update batch model checkboxes
        });

        // Load models for batch testing
        function loadBatchModels(hostUrl) {
            const host = ollamaHosts.find(h => h.url === hostUrl);
            const container = document.getElementById('modelCheckboxes');

            if (host && host.models && host.models.length > 0) {
                container.innerHTML = host.models.map(model => {
                    const safeId = model.replace(/[^a-zA-Z0-9]/g, '_');
                    return `
                    <label class="model-checkbox">
                        <input type="checkbox" id="batch_${safeId}" value="${model}" class="batch-model-checkbox">
                        <label for="batch_${safeId}">${model}</label>
                    </label>
                `}).join('');
            } else {
                container.innerHTML = '<p style="color: #666;">No models available</p>';
            }

            updateBatchInfo();
        }

        // Select all models checkbox
        document.getElementById('selectAllModels').addEventListener('change', (e) => {
            const checkboxes = document.querySelectorAll('.batch-model-checkbox');
            checkboxes.forEach(cb => cb.checked = e.target.checked);
            updateBatchInfo();
        });

        // Update batch info when selections change
        document.addEventListener('change', (e) => {
            if (e.target.classList.contains('batch-model-checkbox') ||
                e.target.id.startsWith('level')) {
                updateBatchInfo();
            }
        });

        function updateBatchInfo() {
            const selectedLevels = [1, 2, 3, 4, 5].filter(l =>
                document.getElementById(`level${l}`).checked
            );
            const selectedModels = Array.from(document.querySelectorAll('.batch-model-checkbox:checked'));

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
            const progressBar = document.getElementById('progressBar');
            const status = document.getElementById('batchStatus');

            btn.disabled = false;
            btn.textContent = 'Start Batch Test';
            stopBtn.style.display = 'none';

            progressBar.classList.remove('active');
            status.style.display = 'none';

            if (batchPollInterval) {
                clearInterval(batchPollInterval);
                batchPollInterval = null;
            }
            currentBatchId = null;
            localStorage.removeItem('currentBatchId');

            const batchInfo = document.getElementById('batchInfo');
            if (batchInfo) batchInfo.innerHTML = '';
        }

        document.getElementById('stopBatchBtn').addEventListener('click', async () => {
            if (confirm('Stop current batch? This will clear the local session.')) {
                if (currentBatchId) {
                    try {
                        await fetch(`${BENCHMARK_API}/batch/${currentBatchId}/stop`, { method: 'POST' });
                    } catch (e) {
                        console.error('Failed to stop batch on server', e);
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
            const progressBar = document.getElementById('progressBar');
            const batchInfo = document.getElementById('batchInfo');

            btn.disabled = true;
            btn.textContent = 'Starting...';
            stopBtn.style.display = 'inline-block';

            status.style.display = 'none';
            progressBar.classList.add('active');
            document.getElementById('progressFill').style.width = '0%';
            document.getElementById('progressText').textContent = '0%';

            // Clear previous results
            document.getElementById('batchResultsContainer').style.display = 'none';
            document.getElementById('batchResultsBody').innerHTML = '';
            window.currentBatchResults = [];
            window.currentJudgeDetailId = null;
            if (batchInfo) batchInfo.innerHTML = '';

            try {
                const res = await fetch(`${BENCHMARK_API}/batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        host,
                        models: selectedModels,
                        levels: selectedLevels,
                        quality_scoring: qualityScoring,
                        judge_config: currentJudgeConfig
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
            steps.push({ label: 'Generated response', state: 'done' });

            if (method === 'disabled') {
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
                        container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 15px;">No previous batches found</div>';
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

                }
            } catch (err) {
                console.error('Failed to load history:', err);
                container.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 15px;">Failed to load history</div>';
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

                // Restore progress bar color if it was greyed out
                document.getElementById('progressFill').style.background = '';
                const clampedProgress = Math.min(Number(batch.progress) || 0, 100);
                document.getElementById('progressFill').style.width = `${clampedProgress}%`;
                document.getElementById('progressFill').style.borderRadius = clampedProgress >= 99 ? '16px' : '16px 0 0 16px';
                const judgeTotal = Number(batch.judge_total) || 0;
                const judgeCompleted = Number(batch.judge_completed) || 0;
                const judgeProgress = Math.min(Number(batch.judge_progress) || 0, 100);

                const genText = `${clampedProgress}% (${batch.completed}/${batch.total_tests})`;
                const judgeText = judgeTotal > 0 ? ` • Judge: ${judgeProgress}% (${judgeCompleted}/${judgeTotal})` : '';
                document.getElementById('progressText').textContent = genText + judgeText;

                // Update Judge Health Stats
                const judgeStatsContainer = document.getElementById('judgeStatsContainer');
                if (batch.judge_stats && judgeTotal > 0) {
                    const stats = batch.judge_stats;
                    const lag = stats.lag || 0;
                    const avgTime = stats.avg_time_ms ? (stats.avg_time_ms / 1000).toFixed(2) + 's' : '-';

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

                    judgeStatsContainer.style.display = 'flex';
                    judgeStatsContainer.style.justifyContent = 'space-between';
                    judgeStatsContainer.style.alignItems = 'center';
                    judgeStatsContainer.innerHTML = `
                        <div style="display: flex; gap: 15px; align-items: center;">
                            <div style="color: ${healthColor}; font-weight: 600;">
                                ${healthIcon} Judge Status: ${healthText}
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Items waiting to be judged">
                                <span style="color: var(--muted);">Queue Lag:</span>
                                <span style="font-weight: 600; color: ${lag > 5 ? '#f1c40f' : 'var(--text)'};">${lag}</span>
                            </div>
                            <div class="vr" style="background: rgba(255,255,255,0.1); width: 1px; height: 14px;"></div>
                            <div title="Average time per judgment">
                                <span style="color: var(--muted);">Avg Time:</span>
                                <span style="font-weight: 600;">${avgTime}</span>
                            </div>
                        </div>
                        <div style="font-size: 0.9em; color: var(--muted);">
                            Concurrency: ${stats.concurrency || 2}
                        </div>
                    `;
                } else {
                    judgeStatsContainer.style.display = 'none';
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
                if (batch.results && batch.results.length > 0) {
                    const container = document.getElementById('batchResultsContainer');
                    const tbody = document.getElementById('batchResultsBody');
                    container.style.display = 'block';

                    window.currentBatchResults = batch.results;
                    tbody.innerHTML = batch.results.map((r, idx) => {
                        const qualityScore = r.quality_score !== undefined && r.quality_score !== null ? r.quality_score : '-';
                        const qualityClass = qualityScore >= 7 ? 'quality-high' : qualityScore >= 4 ? 'quality-mid' : (qualityScore !== '-' ? 'quality-low' : '');

                        const hostInfo = r.host ? `<div style="font-size: 0.75em; color: var(--muted); margin-top: 2px;">Exec: ${formatHostLabel(r.host)}</div>` : '';
                        const judgeInfo = r.judge_host ? `<div style="font-size: 0.75em; color: var(--muted);">Judge: ${formatHostLabel(r.judge_host)}</div>` : '';
                        const judgeStatus = r.scoring_method ? `<div style="font-size: 0.75em; color: var(--muted);">Status: ${r.scoring_method}</div>` : '';

                        return `
                            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <td style="padding: 8px 12px;">
                                    ${r.model}
                                    ${hostInfo}
                                </td>
                                <td style="padding: 8px 12px;">${r.prompt_name}</td>
                                <td style="padding: 8px 12px; text-align: center;" class="${qualityClass}">
                                    ${qualityScore}
                                    ${judgeInfo}
                                    ${judgeStatus}
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

                if (batch.status === 'completed') {
                    clearInterval(batchPollInterval);
                    batchPollInterval = null;
                    localStorage.removeItem('currentBatchId');

                    const status = document.getElementById('batchStatus');

                    // Check if judging is actually complete
                    const judgeTotal = Number(batch.judge_total) || 0;
                    const judgeCompleted = Number(batch.judge_completed) || 0;

                    if (judgeTotal > 0 && judgeCompleted < judgeTotal) {
                        status.className = 'status warning';
                        status.style.background = 'rgba(241, 196, 15, 0.1)';
                        status.style.borderColor = 'rgba(241, 196, 15, 0.3)';
                        status.style.color = '#f1c40f';
                        status.innerHTML = `
                            <i class="fas fa-exclamation-triangle"></i> Batch execution finished, but judging is incomplete (${judgeCompleted}/${judgeTotal}).<br>
                            <small>The server process may have stopped or judging failed silently. Check logs.</small>
                        `;
                    } else {
                        status.className = 'status success';
                        status.textContent = `✓ Batch completed! ${batch.completed} tests run (${batch.success_rate} success)`;
                    }

                    status.style.display = 'block';
                    status.style.display = 'block';

                    const btn = document.getElementById('runBatchBtn');
                    const stopBtn = document.getElementById('stopBatchBtn');
                    btn.disabled = false;
                    btn.textContent = 'Start Batch Test';
                    stopBtn.style.display = 'none';

                    // Refresh dashboard
                    loadDashboard();
                }
            } catch (err) {
                console.error('Failed to poll batch progress:', err);
                // If 404 (batch not found), clear local storage
                if (err.message.includes('404')) {
                    resetBatchUI();
                }
            }
        }

        // Initialize charts
        function initCharts() {
            const latencyCtx = document.getElementById('latencyChart').getContext('2d');
            const tokensCtx = document.getElementById('tokensChart').getContext('2d');
            const qualityCtx = document.getElementById('qualityChart').getContext('2d');
            const compositeCtx = document.getElementById('compositeChart').getContext('2d');

            latencyChart = new Chart(latencyCtx, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Average Latency (ms)',
                        data: [],
                        backgroundColor: 'rgba(102, 126, 234, 0.8)',
                        borderColor: 'rgba(102, 126, 234, 1)',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true } }
                }
            });

            tokensChart = new Chart(tokensCtx, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Tokens per Second',
                        data: [],
                        backgroundColor: 'rgba(118, 75, 162, 0.8)',
                        borderColor: 'rgba(118, 75, 162, 1)',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true } }
                }
            });

            qualityChart = new Chart(qualityCtx, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Quality Score (0-10)',
                        data: [],
                        backgroundColor: 'rgba(46, 204, 113, 0.8)',
                        borderColor: 'rgba(46, 204, 113, 1)',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, max: 10 } }
                }
            });

            compositeChart = new Chart(compositeCtx, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Composite Score (0-10)',
                        data: [],
                        backgroundColor: 'rgba(241, 196, 15, 0.8)',
                        borderColor: 'rgba(241, 196, 15, 1)',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, max: 10 } }
                }
            });
        }

        // Load dashboard data
        async function loadDashboard() {
            try {
                const res = await fetch(`${BENCHMARK_API}/dashboard?sort=${currentSortBy}`);

                if (res.status === 429) {
                    console.warn('Rate limited loading dashboard, skipping...');
                    return;
                }

                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`);
                }

                const json = await res.json();
                const data = json.data || json; // Handle both wrapped and unwrapped responses

                if (!data || !data.overview) {
                    throw new Error('Invalid dashboard data structure');
                }

                // Update stats
                document.getElementById('totalTests').textContent = data.overview.total_tests;
                document.getElementById('successRate').innerHTML =
                    data.overview.success_rate.replace('%', '<span class="stat-unit">%</span>');

                if (data.model_stats && data.model_stats.length > 0) {
                    const fastest = data.model_stats[0];
                    document.getElementById('avgLatency').innerHTML =
                        `${fastest.avg_latency}<span class="stat-unit">ms</span>`;
                    document.getElementById('fastestModel').textContent = fastest.model;

                    // Update charts
                    const chartLabels = data.model_stats.map(m => {
                        const hostLabel = m.host ? formatHostLabel(m.host) : '';
                        // Only append host if it's not localhost or if we have multiple hosts
                        return hostLabel && hostLabel !== 'localhost' ? `${m.model} (${hostLabel})` : m.model;
                    });

                    latencyChart.data.labels = chartLabels;
                    latencyChart.data.datasets[0].data = data.model_stats.map(m => m.avg_latency);
                    latencyChart.update();

                    tokensChart.data.labels = chartLabels;
                    tokensChart.data.datasets[0].data = data.model_stats.map(m => parseFloat(m.avg_tokens_per_sec));
                    tokensChart.update();

                    // Update quality chart
                    qualityChart.data.labels = chartLabels;
                    qualityChart.data.datasets[0].data = data.model_stats.map(m => parseFloat(m.avg_quality) || 0);
                    qualityChart.update();

                    // Update composite chart
                    compositeChart.data.labels = chartLabels;
                    compositeChart.data.datasets[0].data = data.model_stats.map(m => parseFloat(m.avg_composite) || 0);
                    compositeChart.update();

                    // Find best overall model (highest composite score)
                    const modelsWithComposite = data.model_stats.filter(m => m.avg_composite && parseFloat(m.avg_composite) > 0);
                    let bestOverallModel = null;
                    if (modelsWithComposite.length > 0) {
                        bestOverallModel = modelsWithComposite.reduce((best, current) =>
                            parseFloat(current.avg_composite) > parseFloat(best.avg_composite) ? current : best
                        );
                    }

                    // Update best overall text
                    const bestOverallText = document.getElementById('bestOverallText');
                    if (bestOverallText) {
                        if (bestOverallModel) {
                            bestOverallText.innerHTML = `👑 Best Overall: <strong style="color: #2ecc71;">${bestOverallModel.model}</strong> <span style="color: #888;">(${bestOverallModel.avg_composite} composite)</span>`;
                        } else {
                            bestOverallText.innerHTML = `👑 Best Overall: <span style="color: #888;">Run tests with quality scoring</span>`;
                        }
                    }

                    // Update leaderboard
                    const tbody = document.getElementById('leaderboard');
                    tbody.innerHTML = data.model_stats.map((model, idx) => {
                        let badge = '';
                        if (idx === 0) badge = '<span class="badge gold">🥇 1st</span>';
                        else if (idx === 1) badge = '<span class="badge silver">🥈 2nd</span>';
                        else if (idx === 2) badge = '<span class="badge bronze">🥉 3rd</span>';
                        else badge = `<span>${idx + 1}</span>`;

                        const qualityVal = parseFloat(model.avg_quality);
                        const compositeVal = parseFloat(model.avg_composite);
                        const qualityDisplay = !isNaN(qualityVal) ? model.avg_quality : '-';
                        const compositeDisplay = !isNaN(compositeVal) ? model.avg_composite : '-';
                        const qualityClass = qualityVal >= 7 ? 'quality-high' : qualityVal >= 4 ? 'quality-mid' : (qualityVal > 0 ? 'quality-low' : '');

                        // Highlight best overall model
                        const isBestOverall = bestOverallModel && model.model === bestOverallModel.model;
                        const rowClass = isBestOverall ? 'best-overall' : '';

                        const crown = isBestOverall ? '👑 ' : '';
                        const hostLabel = model.host ? formatHostLabel(model.host) : 'Unknown';
                        return `
                            <tr class="${rowClass}">
                                <td>${badge}</td>
                                <td>
                                    <strong>${crown}${model.model}</strong>
                                    <div style="font-size: 0.8em; color: var(--muted); margin-top: 2px; opacity: 0.7;">${hostLabel}</div>
                                </td>
                                <td>${model.avg_latency} ms</td>
                                <td>${model.avg_tokens_per_sec}</td>
                                <td class="${qualityClass}">${qualityDisplay}</td>
                                <td style="font-weight: bold;">${compositeDisplay}</td>
                                <td>${model.tests}</td>
                            </tr>
                        `;
                    }).join('');
                }
            } catch (err) {
                console.error('Failed to load dashboard:', err);
            }
        }

        // Sort selector change handler
        document.getElementById('sortBy').addEventListener('change', (e) => {
            currentSortBy = e.target.value;
            loadDashboard();
        });

        // Run test
        document.getElementById('testForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const btn = document.getElementById('runBtn');
            const status = document.getElementById('status');

            btn.disabled = true;
            btn.textContent = 'Running...';
            status.style.display = 'none';

            try {
                const res = await fetch(`${BENCHMARK_API}/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        host: document.getElementById('host').value,
                        prompt: document.getElementById('prompt').value
                    })
                });

                const json = await res.json();
                const data = json.data || json;

                if (data.success) {
                    status.className = 'status success';
                    status.textContent = `✓ Test completed in ${data.latency}ms (${data.tokens_per_sec} tokens/s)`;
                } else {
                    status.className = 'status error';
                    status.textContent = `✗ Test failed: ${data.error || json.error}`;
                }

                status.style.display = 'block';
                loadDashboard();
            } catch (err) {
                status.className = 'status error';
                status.textContent = `✗ Error: ${err.message}`;
                status.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Run Test';
            }
        });

        // Initialize
        loadOllamaHosts().then(() => {
            // Load batch models for first available host
            const firstHost = document.getElementById('host').value;
            if (firstHost) {
                loadBatchModels(firstHost);
            }

            // Load judge defaults so the UI can display the actual judge model (not just "default")
            loadJudgeConfig();

            // Check for active batch
            const savedBatchId = localStorage.getItem('currentBatchId');
            if (savedBatchId) {
                console.log('Resuming batch:', savedBatchId);
                currentBatchId = savedBatchId;

                const btn = document.getElementById('runBatchBtn');
                const stopBtn = document.getElementById('stopBatchBtn');
                const progressBar = document.getElementById('progressBar');
                const status = document.getElementById('batchStatus');

                btn.disabled = true;
                btn.textContent = 'Resuming...';
                stopBtn.style.display = 'inline-block';
                progressBar.classList.add('active');

                // Initialize progress bar visual state
                document.getElementById('progressFill').style.width = '100%'; // Show full width but indeterminate or waiting
                document.getElementById('progressFill').style.background = 'linear-gradient(90deg, var(--muted) 0%, var(--panel-border) 100%)'; // Grey out until update
                document.getElementById('progressText').textContent = 'Connecting...';

                status.style.display = 'block';
                status.className = 'status';
                status.textContent = 'Resuming session...';

                // Start polling immediately
                pollBatchProgress();
                batchPollInterval = setInterval(pollBatchProgress, 2000);
            }

            // Load history
            loadBatchHistory();
            document.getElementById('refreshHistoryBtn').addEventListener('click', loadBatchHistory);
        });
        initCharts();
        loadDashboard();
        setupModals();
        setInterval(loadDashboard, 10000); // Refresh every 10s
