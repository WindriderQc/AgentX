// Config Optimizer - Test and compare config presets

let allConfigs = [];
let selectedConfigs = new Set();
let testResults = new Map();
let availableModels = [];
let testScenarios = [];
let currentScenarioFilter = 'all';

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfigs();
    await loadModels();
    await loadTestScenarios();
    setupEventListeners();
});

// Load all config variants
async function loadConfigs() {
    try {
        const response = await fetch('/api/config-variants');
        if (!response.ok) throw new Error('Failed to fetch config variants');

        const data = await response.json();
        allConfigs = data.data.variants;

        renderConfigGallery();
    } catch (error) {
        console.error('Error loading configs:', error);
        document.getElementById('configGallery').innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error loading configs: ${error.message}</p>
                <button onclick="loadConfigs()" class="btn-primary">Retry</button>
            </div>
        `;
    }
}

// Load available models
async function loadModels() {
    try {
        const response = await fetch('/api/models');
        if (!response.ok) throw new Error('Failed to fetch models');

        const data = await response.json();
        availableModels = data.models || [];

        renderModelSelector();
    } catch (error) {
        console.error('Error loading models:', error);
        document.getElementById('modelSelector').innerHTML = `
            <option value="">Error loading models</option>
        `;
    }
}

// Load test scenarios
async function loadTestScenarios() {
    try {
        const response = await fetch('/api/config-variants/test-scenarios/list');
        if (!response.ok) throw new Error('Failed to fetch test scenarios');

        const data = await response.json();
        testScenarios = data.data.test_scenarios || [];

        renderTestScenarios();
    } catch (error) {
        console.error('Error loading test scenarios:', error);
        document.getElementById('scenariosGrid').innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error loading test scenarios: ${error.message}</p>
            </div>
        `;
    }
}

// Render config gallery
function renderConfigGallery() {
    const gallery = document.getElementById('configGallery');

    if (!allConfigs || allConfigs.length === 0) {
        gallery.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No config presets available</p>
            </div>
        `;
        return;
    }

    gallery.innerHTML = allConfigs.map(config => {
        const isSelected = selectedConfigs.has(config._id);
        const params = config.parameters || {};

        return `
            <div class="config-card ${isSelected ? 'selected' : ''}" data-config-id="${config._id}">
                <div class="config-card-header">
                    <h3 class="config-card-title">${escapeHtml(config.name)}</h3>
                    <span class="config-card-badge ${config.isSystem ? 'system' : 'custom'}">
                        ${config.isSystem ? 'System' : 'Custom'}
                    </span>
                </div>

                <p class="config-card-description">${escapeHtml(config.description || 'No description available')}</p>

                ${config.tags && config.tags.length > 0 ? `
                    <div class="config-card-tags">
                        ${config.tags.map(tag => `<span class="config-tag">${escapeHtml(tag)}</span>`).join('')}
                    </div>
                ` : ''}

                ${config.use_cases && config.use_cases.length > 0 ? `
                    <div class="config-card-tags">
                        ${config.use_cases.map(uc => `<span class="config-tag"><i class="fas fa-lightbulb"></i> ${escapeHtml(uc)}</span>`).join('')}
                    </div>
                ` : ''}

                <div class="config-card-params">
                    ${params.temperature !== null && params.temperature !== undefined ? `
                        <div class="config-param">
                            <span class="config-param-label">Temperature</span>
                            <span class="config-param-value">${params.temperature}</span>
                        </div>
                    ` : ''}
                    ${params.top_p !== null && params.top_p !== undefined ? `
                        <div class="config-param">
                            <span class="config-param-label">Top P</span>
                            <span class="config-param-value">${params.top_p}</span>
                        </div>
                    ` : ''}
                    ${params.top_k !== null && params.top_k !== undefined ? `
                        <div class="config-param">
                            <span class="config-param-label">Top K</span>
                            <span class="config-param-value">${params.top_k}</span>
                        </div>
                    ` : ''}
                    ${params.num_ctx !== null && params.num_ctx !== undefined ? `
                        <div class="config-param">
                            <span class="config-param-label">Context</span>
                            <span class="config-param-value">${params.num_ctx}</span>
                        </div>
                    ` : ''}
                    ${params.num_predict !== null && params.num_predict !== undefined ? `
                        <div class="config-param">
                            <span class="config-param-label">Max Tokens</span>
                            <span class="config-param-value">${params.num_predict}</span>
                        </div>
                    ` : ''}
                </div>

                <div class="config-card-checkbox">
                    ${isSelected ? '<i class="fas fa-check"></i>' : ''}
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers to config cards
    document.querySelectorAll('.config-card').forEach(card => {
        card.addEventListener('click', () => toggleConfigSelection(card.dataset.configId));
    });
}

// Render model selector
function renderModelSelector() {
    const selector = document.getElementById('modelSelector');

    if (!availableModels || availableModels.length === 0) {
        selector.innerHTML = '<option value="">No models available</option>';
        return;
    }

    selector.innerHTML = `
        <option value="">Select a model...</option>
        ${availableModels.map(model => `
            <option value="${model.name}">${model.name}</option>
        `).join('')}
    `;
}

// Toggle config selection
function toggleConfigSelection(configId) {
    if (selectedConfigs.has(configId)) {
        selectedConfigs.delete(configId);
    } else {
        if (selectedConfigs.size >= 4) {
            alert('Maximum 4 configs can be selected for comparison');
            return;
        }
        selectedConfigs.add(configId);
    }

    renderConfigGallery();
    renderSelectedConfigsList();
    updateRunTestsButton();
}

// Render selected configs list
function renderSelectedConfigsList() {
    const list = document.getElementById('selectedConfigsList');

    if (selectedConfigs.size === 0) {
        list.innerHTML = `
            <div class="empty-state-small">
                <i class="fas fa-hand-pointer"></i>
                Select up to 4 configs from the gallery above
            </div>
        `;
        return;
    }

    list.innerHTML = Array.from(selectedConfigs).map(configId => {
        const config = allConfigs.find(c => c._id === configId);
        if (!config) return '';

        return `
            <div class="selected-config-chip">
                ${config.name}
                <i class="fas fa-times" onclick="toggleConfigSelection('${configId}')"></i>
            </div>
        `;
    }).join('');
}

// Update run tests button state
function updateRunTestsButton() {
    const btn = document.getElementById('runTestsBtn');
    const prompt = document.getElementById('testPrompt').value.trim();
    const model = document.getElementById('modelSelector').value;

    btn.disabled = !(selectedConfigs.size > 0 && prompt && model);
}

// Render test scenarios
function renderTestScenarios() {
    const grid = document.getElementById('scenariosGrid');

    if (!testScenarios || testScenarios.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No test scenarios available</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = testScenarios.map(scenario => {
        const isHidden = currentScenarioFilter !== 'all' && scenario.category !== currentScenarioFilter;
        return `
            <div class="scenario-card ${isHidden ? 'hidden' : ''}" data-scenario-id="${scenario.scenario_id}" data-category="${scenario.category}">
                <div class="scenario-header">
                    <h4 class="scenario-title">${escapeHtml(scenario.name)}</h4>
                    <span class="scenario-category-badge ${scenario.category}">${escapeHtml(scenario.category)}</span>
                </div>
                <p class="scenario-prompt">${escapeHtml(scenario.prompt)}</p>
                <div class="scenario-optimal-config">
                    <i class="fas fa-bullseye"></i>
                    Optimal: ${scenario.optimal_config}
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers to scenario cards
    document.querySelectorAll('.scenario-card').forEach(card => {
        card.addEventListener('click', () => loadScenario(card.dataset.scenarioId));
    });

    // Enable run suite button if we have scenarios
    document.getElementById('runSuiteBtn').disabled = testScenarios.length === 0;
}

// Load a scenario into the testing form
function loadScenario(scenarioId) {
    const scenario = testScenarios.find(s => s.scenario_id === scenarioId);
    if (!scenario) return;

    // Set the prompt
    document.getElementById('testPrompt').value = scenario.prompt;

    // Find and select the optimal config
    const optimalConfig = allConfigs.find(c => c.name === scenario.optimal_config);
    if (optimalConfig) {
        selectedConfigs.clear();
        selectedConfigs.add(optimalConfig._id);

        // Also add alternative configs if available
        if (scenario.alternative_configs && scenario.alternative_configs.length > 0) {
            scenario.alternative_configs.slice(0, 3).forEach(altName => {
                const altConfig = allConfigs.find(c => c.name === altName);
                if (altConfig && selectedConfigs.size < 4) {
                    selectedConfigs.add(altConfig._id);
                }
            });
        }

        renderConfigGallery();
        renderSelectedConfigsList();
    }

    updateRunTestsButton();
    analyzePromptAndRecommend();

    // Scroll to testing panel
    document.querySelector('.testing-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Filter scenarios by category
function filterScenarios(category) {
    currentScenarioFilter = category;

    // Update filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.category === category);
    });

    // Show/hide scenario cards
    document.querySelectorAll('.scenario-card').forEach(card => {
        const shouldShow = category === 'all' || card.dataset.category === category;
        card.classList.toggle('hidden', !shouldShow);
    });
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('testPrompt').addEventListener('input', () => {
        updateRunTestsButton();
        analyzePromptAndRecommend();
    });
    document.getElementById('modelSelector').addEventListener('change', () => {
        updateRunTestsButton();
        analyzePromptAndRecommend();
    });
    document.getElementById('runTestsBtn').addEventListener('click', runTests);
    document.getElementById('clearResultsBtn').addEventListener('click', clearResults);

    // Scenario filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => filterScenarios(btn.dataset.category));
    });

    // Run suite button
    document.getElementById('runSuiteBtn').addEventListener('click', runScenarioSuite);
}

// Analyze prompt and recommend config
function analyzePromptAndRecommend() {
    const prompt = document.getElementById('testPrompt').value.trim();
    if (!prompt) return;

    const recommendationsPanel = document.getElementById('recommendationsPanel');
    const recommendationContent = document.getElementById('recommendationContent');

    // Simple heuristics for recommendation
    let recommendedConfig = null;
    let reason = '';

    const lowerPrompt = prompt.toLowerCase();

    // Code detection
    if (lowerPrompt.includes('code') || lowerPrompt.includes('function') ||
        lowerPrompt.includes('python') || lowerPrompt.includes('javascript') ||
        lowerPrompt.includes('class') || lowerPrompt.includes('algorithm')) {

        recommendedConfig = allConfigs.find(c =>
            c.name === 'Code Review Precision' ||
            c.name === 'Code Review' ||
            c.name === 'Deterministic'
        );
        reason = 'Your prompt appears to be code-related. Low-temperature configs (0.0-0.2) provide more deterministic and precise code generation.';
    }
    // Creative content detection
    else if (lowerPrompt.includes('story') || lowerPrompt.includes('creative') ||
             lowerPrompt.includes('write') || lowerPrompt.includes('narrative') ||
             lowerPrompt.includes('poem') || lowerPrompt.includes('imagine')) {

        recommendedConfig = allConfigs.find(c =>
            c.name === 'Storytelling' ||
            c.name === 'Storyteller Rich' ||
            c.name === 'Creative'
        );
        reason = 'Your prompt appears to be creative writing. Higher-temperature configs (1.0-1.2) provide more varied and imaginative outputs.';
    }
    // Reasoning/analysis detection
    else if (lowerPrompt.includes('analyze') || lowerPrompt.includes('explain') ||
             lowerPrompt.includes('why') || lowerPrompt.includes('reason') ||
             lowerPrompt.includes('compare') || lowerPrompt.includes('evaluate')) {

        recommendedConfig = allConfigs.find(c =>
            c.name === 'Deep Reasoning' ||
            c.name === 'Socratic Reasoner' ||
            c.name === 'Longform Analyst'
        );
        reason = 'Your prompt requires analytical reasoning. Configs optimized for structured thinking and step-by-step analysis work best.';
    }
    // Factual/research detection
    else if (lowerPrompt.includes('fact') || lowerPrompt.includes('research') ||
             lowerPrompt.includes('what is') || lowerPrompt.includes('define') ||
             lowerPrompt.includes('information about')) {

        recommendedConfig = allConfigs.find(c =>
            c.name === 'Factual Research' ||
            c.name === 'Factual Fast' ||
            c.name === 'Technical Writing'
        );
        reason = 'Your prompt appears to be factual or research-oriented. Low-temperature configs with high context provide precise, evidence-based answers.';
    }
    // Long document detection
    else if (lowerPrompt.includes('summarize') || lowerPrompt.includes('summary') ||
             lowerPrompt.includes('document') || lowerPrompt.length > 500) {

        recommendedConfig = allConfigs.find(c =>
            c.name === 'Long Document Analysis' ||
            c.name === 'Extended Context' ||
            c.name === 'Longform Analyst'
        );
        reason = 'Your prompt involves long-form content. Configs with extended context (16k-32k tokens) are recommended for comprehensive analysis.';
    }
    // Default to balanced
    else {
        recommendedConfig = allConfigs.find(c => c.name === 'Balanced');
        reason = 'For general-purpose tasks, a balanced configuration provides good all-around performance.';
    }

    if (recommendedConfig) {
        recommendationContent.innerHTML = `
            <div class="recommendation-item">
                <h3><i class="fas fa-star"></i> ${recommendedConfig.name}</h3>
                <p>${recommendedConfig.description}</p>
                <div class="recommendation-reason">
                    <i class="fas fa-lightbulb"></i>
                    <span class="recommendation-reason-text">${reason}</span>
                </div>
            </div>
        `;
        recommendationsPanel.style.display = 'block';
    }
}

function validateConfigParameters(params = {}) {
    const errors = [];

    if (params.temperature !== null && params.temperature !== undefined) {
        if (params.temperature < 0 || params.temperature > 2) {
            errors.push(`Temperature ${params.temperature} out of range (0-2)`);
        }
    }

    if (params.top_p !== null && params.top_p !== undefined) {
        if (params.top_p < 0 || params.top_p > 1) {
            errors.push(`Top P ${params.top_p} out of range (0-1)`);
        }
    }

    if (params.top_k !== null && params.top_k !== undefined) {
        if (params.top_k < 1) {
            errors.push(`Top K ${params.top_k} must be positive`);
        }
    }

    return errors;
}

// Run tests in parallel
async function runTests() {
    const prompt = document.getElementById('testPrompt').value.trim();
    const model = document.getElementById('modelSelector').value;

    if (!prompt || !model || selectedConfigs.size === 0) return;

    // Show results panel
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('clearResultsBtn').style.display = 'inline-flex';

    // Clear previous results
    testResults.clear();

    // Initialize metrics table
    const metricsBody = document.getElementById('metricsTableBody');
    metricsBody.innerHTML = Array.from(selectedConfigs).map(configId => {
        const config = allConfigs.find(c => c._id === configId);
        return `
            <tr data-config-id="${configId}">
                <td class="metric-config-name">${config.name}</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
                <td><span class="status-badge running"><i class="fas fa-spinner fa-spin"></i> Running</span></td>
            </tr>
        `;
    }).join('');

    // Initialize results grid
    const resultsGrid = document.getElementById('resultsGrid');
    resultsGrid.innerHTML = Array.from(selectedConfigs).map(configId => {
        const config = allConfigs.find(c => c._id === configId);
        return `
            <div class="result-card" data-config-id="${configId}">
                <div class="result-card-header">
                    <h3 class="result-card-title">${config.name}</h3>
                </div>
                <div class="result-card-output">
                    <pre><i class="fas fa-spinner fa-spin"></i> Generating response...</pre>
                </div>
                <div class="result-card-stats">
                    <div class="result-stat">
                        <div class="result-stat-label">Latency</div>
                        <div class="result-stat-value">-</div>
                    </div>
                    <div class="result-stat">
                        <div class="result-stat-label">Tokens</div>
                        <div class="result-stat-value">-</div>
                    </div>
                    <div class="result-stat">
                        <div class="result-stat-label">Tokens/sec</div>
                        <div class="result-stat-value">-</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Run tests in parallel
    const testPromises = Array.from(selectedConfigs).map(async configId => {
        const config = allConfigs.find(c => c._id === configId);
        const validationErrors = validateConfigParameters(config.parameters || {});

        if (validationErrors.length > 0) {
            console.error(`Invalid config ${config.name}:`, validationErrors);
            const errorMessage = validationErrors.join(', ');
            const invalidResult = {
                config: config,
                output: `Invalid configuration: ${errorMessage}`,
                latency: 0,
                tokens: 0,
                tokensPerSec: 0,
                success: false,
                error: errorMessage
            };
            testResults.set(configId, invalidResult);
            updateResultDisplay(configId, invalidResult);
            return;
        }

        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: prompt,
                    model: model,
                    options: config.parameters
                })
            });

            clearTimeout(timeoutId);

            const endTime = Date.now();
            const latency = endTime - startTime;

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            const result = {
                config: config,
                output: data.data?.response || data.response || data.message || 'No response',
                latency: latency,
                tokens: data.data?.stats?.eval_count || 0,
                tokensPerSec: data.data?.stats?.eval_count && latency ?
                    ((data.data.stats.eval_count / latency) * 1000).toFixed(2) : 0,
                success: true
            };

            testResults.set(configId, result);
            updateResultDisplay(configId, result);

        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                const timeoutResult = {
                    config: config,
                    output: 'Test timed out after 60 seconds',
                    latency: 0,
                    tokens: 0,
                    tokensPerSec: 0,
                    success: false,
                    error: 'Test timed out after 60 seconds'
                };
                testResults.set(configId, timeoutResult);
                updateResultDisplay(configId, timeoutResult);
                return;
            }

            console.error(`Error testing config ${config.name}:`, error);
            const result = {
                config: config,
                output: `Error: ${error.message}`,
                latency: 0,
                tokens: 0,
                tokensPerSec: 0,
                success: false,
                error: error.message
            };

            testResults.set(configId, result);
            updateResultDisplay(configId, result);
        }
    });

    await Promise.all(testPromises);

    // Find best result based on tokens/sec
    highlightBestResult();
}

// Update result display
function updateResultDisplay(configId, result) {
    // Update metrics table
    const metricsRow = document.querySelector(`#metricsTableBody tr[data-config-id="${configId}"]`);
    if (metricsRow) {
        metricsRow.innerHTML = `
            <td class="metric-config-name">${result.config.name}</td>
            <td class="metric-value">${result.latency}ms</td>
            <td class="metric-value">${result.tokens}</td>
            <td class="metric-value">${result.tokensPerSec}</td>
            <td>
                <span class="status-badge ${result.success ? 'success' : 'error'}">
                    ${result.success ? '<i class="fas fa-check"></i> Success' : '<i class="fas fa-times"></i> Error'}
                </span>
            </td>
        `;
    }

    // Update results grid
    const resultCard = document.querySelector(`.results-grid .result-card[data-config-id="${configId}"]`);
    if (resultCard) {
        resultCard.innerHTML = `
            <div class="result-card-header">
                <h3 class="result-card-title">${result.config.name}</h3>
            </div>
            <div class="result-card-output">
                <pre>${escapeHtml(result.output)}</pre>
            </div>
            <button class="copy-btn" onclick="copyToClipboard('${configId}')">
                <i class="fas fa-copy"></i> Copy Output
            </button>
            <div class="result-card-stats">
                <div class="result-stat">
                    <div class="result-stat-label">Latency</div>
                    <div class="result-stat-value">${result.latency}ms</div>
                </div>
                <div class="result-stat">
                    <div class="result-stat-label">Tokens</div>
                    <div class="result-stat-value">${result.tokens}</div>
                </div>
                <div class="result-stat">
                    <div class="result-stat-label">Tokens/sec</div>
                    <div class="result-stat-value">${result.tokensPerSec}</div>
                </div>
            </div>
        `;
    }
}

// Highlight best result
function highlightBestResult() {
    const successfulResults = Array.from(testResults.values()).filter(r => r.success);

    if (successfulResults.length === 0) return;

    // Find best by tokens/sec
    const bestResult = successfulResults.reduce((best, current) => {
        return parseFloat(current.tokensPerSec) > parseFloat(best.tokensPerSec) ? current : best;
    });

    // Highlight in metrics table
    document.querySelectorAll('#metricsTableBody tr').forEach(row => {
        const configId = row.dataset.configId;
        const result = testResults.get(configId);

        if (result && result.success) {
            const tokensPerSecCell = row.cells[3];
            if (result === bestResult) {
                tokensPerSecCell.classList.add('metric-best');
            }
        }
    });

    // Highlight in results grid
    const bestCard = document.querySelector(`.results-grid .result-card[data-config-id="${Array.from(testResults.entries()).find(([_, r]) => r === bestResult)?.[0]}"]`);
    if (bestCard) {
        bestCard.classList.add('best');
        const header = bestCard.querySelector('.result-card-header');
        if (header) {
            const badge = document.createElement('span');
            badge.className = 'best-badge';
            badge.innerHTML = '<i class="fas fa-trophy"></i> Best Performance';
            header.appendChild(badge);
        }
    }
}

// Clear results
function clearResults() {
    testResults.clear();
    document.getElementById('resultsPanel').style.display = 'none';
    document.getElementById('clearResultsBtn').style.display = 'none';
    document.getElementById('metricsTableBody').innerHTML = '';
    document.getElementById('resultsGrid').innerHTML = '';
}

// Copy output to clipboard
window.copyToClipboard = async function(configId) {
    const result = testResults.get(configId);
    if (!result) return;

    try {
        await navigator.clipboard.writeText(result.output);

        // Visual feedback
        const btn = event.target.closest('.copy-btn');
        const originalHTML = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';

        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = originalHTML;
        }, 2000);
    } catch (error) {
        console.error('Failed to copy:', error);
        alert('Failed to copy to clipboard');
    }
};

// Export comparison to JSON
window.exportComparison = function() {
    const exportData = {
        timestamp: new Date().toISOString(),
        prompt: document.getElementById('testPrompt').value,
        model: document.getElementById('modelSelector').value,
        results: Array.from(testResults.values()).map(result => ({
            config: {
                name: result.config.name,
                parameters: result.config.parameters
            },
            output: result.output,
            metrics: {
                latency: result.latency,
                tokens: result.tokens,
                tokensPerSec: result.tokensPerSec
            },
            success: result.success
        }))
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `config-comparison-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// Run scenario suite (batch test all scenarios)
async function runScenarioSuite() {
    if (!testScenarios || testScenarios.length === 0) {
        alert('No test scenarios available');
        return;
    }

    const model = document.getElementById('modelSelector').value;
    if (!model) {
        alert('Please select a model first');
        return;
    }

    const btn = document.getElementById('runSuiteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running Suite...';

    const suiteResults = [];
    let completed = 0;

    for (const scenario of testScenarios) {
        const optimalConfig = allConfigs.find(c => c.name === scenario.optimal_config);
        if (!optimalConfig) {
            console.warn(`Config not found for scenario: ${scenario.name}`);
            continue;
        }

        try {
            const startTime = Date.now();
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: scenario.prompt,
                    model: model,
                    options: optimalConfig.parameters
                })
            });

            const endTime = Date.now();
            const data = await response.json();

            suiteResults.push({
                scenario: scenario.name,
                category: scenario.category,
                config: optimalConfig.name,
                latency: endTime - startTime,
                tokens: data.eval_count || 0,
                success: response.ok
            });

            completed++;
            btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Running Suite (${completed}/${testScenarios.length})...`;

        } catch (error) {
            console.error(`Error testing scenario ${scenario.name}:`, error);
            suiteResults.push({
                scenario: scenario.name,
                category: scenario.category,
                config: optimalConfig.name,
                error: error.message,
                success: false
            });
        }
    }

    // Export suite results
    const blob = new Blob([JSON.stringify(suiteResults, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scenario-suite-results-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-play-circle"></i> Run Full Suite';

    alert(`Suite completed! ${completed}/${testScenarios.length} scenarios tested. Results exported.`);
}

// Utility: Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
