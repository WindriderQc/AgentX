/**
 * Self-Healing Rules Dashboard for AgentX
 * Monitor and manage self-healing rules with real-time execution tracking
 *
 * Features:
 * - List all rules with enable/disable toggles
 * - Show rule execution history (last 50)
 * - Display cooldown timers
 * - Edit rule parameters (threshold, cooldown)
 * - Test rule conditions manually
 * - View rule effectiveness metrics
 */

import { apiClient } from './utils/api-client.js';

class SelfHealingDashboard {
    constructor(options = {}) {
        this.containerId = options.containerId || 'self-healing-container';
        this.statsContainerId = options.statsContainerId || 'self-healing-stats';
        this.historyContainerId = options.historyContainerId || 'self-healing-history';
        this.refreshInterval = options.refreshInterval || 30000; // 30 seconds

        // State
        this.rules = [];
        this.executionHistory = [];
        this.engineStatus = null;
        this.autoRefreshTimer = null;
        this.cooldownTimers = new Map();

        // Strategy configuration
        this.strategyConfig = {
            model_failover: {
                icon: 'fa-exchange-alt',
                color: '#0dcaf0',
                label: 'Model Failover',
                description: 'Switch to backup Ollama host'
            },
            prompt_rollback: {
                icon: 'fa-undo',
                color: '#ffc107',
                label: 'Prompt Rollback',
                description: 'Revert to previous prompt version'
            },
            service_restart: {
                icon: 'fa-sync-alt',
                color: '#dc3545',
                label: 'Service Restart',
                description: 'Restart service via PM2'
            },
            throttle_requests: {
                icon: 'fa-tachometer-alt',
                color: '#fd7e14',
                label: 'Throttle Requests',
                description: 'Enable rate limiting'
            },
            alert_only: {
                icon: 'fa-bell',
                color: '#6c757d',
                label: 'Alert Only',
                description: 'Send notifications without action'
            },
            scale_up: {
                icon: 'fa-arrow-up',
                color: '#198754',
                label: 'Scale Up',
                description: 'Increase resource allocation'
            }
        };

        // Priority colors
        this.priorityConfig = {
            1: { label: 'Critical', color: '#dc3545', class: 'danger' },
            2: { label: 'High', color: '#fd7e14', class: 'warning' },
            3: { label: 'Medium', color: '#ffc107', class: 'warning' },
            4: { label: 'Low', color: '#0dcaf0', class: 'info' }
        };
    }

    /**
     * Initialize the dashboard
     */
    async init() {
        try {
            await this.loadStatus();
            await this.loadRules();
            await this.loadHistory();
            this.startAutoRefresh();
            this.startCooldownTimers();
            console.log('Self-Healing Dashboard initialized');
        } catch (error) {
            console.error('Failed to initialize Self-Healing Dashboard:', error);
            this.showToast('Failed to initialize dashboard', 'error');
        }
    }

    /**
     * Load engine status
     */
    async loadStatus() {
        try {
            const response = await apiClient.get('/self-healing/status');
            this.engineStatus = response.data || response;
            this.renderStatus();
        } catch (error) {
            console.error('Failed to load status:', error);
            this.showToast('Failed to load engine status', 'error');
        }
    }

    /**
     * Load all rules
     */
    async loadRules() {
        try {
            const response = await apiClient.get('/self-healing/rules');
            this.rules = response.data?.rules || response.rules || [];
            this.renderRules();
        } catch (error) {
            console.error('Failed to load rules:', error);
            this.showToast('Failed to load rules', 'error');
        }
    }

    /**
     * Load execution history
     */
    async loadHistory() {
        try {
            const response = await apiClient.get('/self-healing/history');
            this.executionHistory = response.data?.history || response.history || [];
            this.renderHistory();
        } catch (error) {
            console.error('Failed to load history:', error);
            this.showToast('Failed to load history', 'error');
        }
    }

    /**
     * Render engine status banner
     */
    renderStatus() {
        const container = document.getElementById(this.statsContainerId);
        if (!container || !this.engineStatus) return;

        const { enabled, rules, executions } = this.engineStatus;

        container.innerHTML = `
            <div class="row g-3 mb-4">
                <div class="col-md-2">
                    <div class="card ${enabled ? 'bg-success' : 'bg-secondary'} text-white">
                        <div class="card-body text-center">
                            <i class="fas ${enabled ? 'fa-check-circle' : 'fa-pause-circle'} fa-2x mb-2"></i>
                            <h6 class="mb-0">${enabled ? 'Enabled' : 'Disabled'}</h6>
                            <small>Engine Status</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-primary text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${rules.total}</h3>
                            <small>Total Rules</small>
                            <div class="mt-1">
                                <small class="badge bg-light text-dark">${rules.enabled} active</small>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-info text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${executions.total}</h3>
                            <small>Total Executions</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-warning text-dark">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${executions.recentlyExecuted || 0}</h3>
                            <small>In Cooldown</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-dark text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${Object.keys(rules.byStrategy || {}).length}</h3>
                            <small>Strategies</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-secondary text-white">
                        <div class="card-body text-center p-2">
                            <button class="btn btn-light btn-sm w-100 mb-1" onclick="window.selfHealingDashboard.reloadRules()">
                                <i class="fas fa-sync-alt"></i> Reload
                            </button>
                            <button class="btn btn-outline-light btn-sm w-100" onclick="window.selfHealingDashboard.evaluateAllRules()">
                                <i class="fas fa-play"></i> Evaluate
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render rules list
     */
    renderRules() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        if (this.rules.length === 0) {
            container.innerHTML = `
                <div class="alert alert-info text-center">
                    <i class="fas fa-info-circle"></i> No self-healing rules configured
                </div>
            `;
            return;
        }

        // Group rules by strategy
        const groupedRules = this.rules.reduce((acc, rule) => {
            const strategy = rule.remediation.strategy;
            if (!acc[strategy]) acc[strategy] = [];
            acc[strategy].push(rule);
            return acc;
        }, {});

        let html = '';
        for (const [strategy, rules] of Object.entries(groupedRules)) {
            const config = this.strategyConfig[strategy] || this.strategyConfig.alert_only;
            html += `
                <div class="card mb-3">
                    <div class="card-header" style="background-color: ${config.color}15; border-left: 4px solid ${config.color};">
                        <h6 class="mb-0">
                            <i class="fas ${config.icon}" style="color: ${config.color};"></i>
                            ${config.label}
                            <span class="badge bg-secondary float-end">${rules.length} rule(s)</span>
                        </h6>
                    </div>
                    <div class="card-body p-2">
                        ${rules.map(rule => this.renderRuleCard(rule)).join('')}
                    </div>
                </div>
            `;
        }

        container.innerHTML = html;
    }

    /**
     * Render individual rule card
     */
    renderRuleCard(rule) {
        const priorityConfig = this.priorityConfig[rule.remediation.priority] || this.priorityConfig[4];
        const isEnabled = rule.enabled !== false;
        const cooldown = this.getCooldownInfo(rule);
        const metrics = this.getRuleMetrics(rule);

        return `
            <div class="card mb-2 ${isEnabled ? '' : 'opacity-50'}" data-rule-name="${rule.name}">
                <div class="card-body p-3">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <div class="flex-grow-1">
                            <h6 class="mb-1">
                                <span class="badge bg-${priorityConfig.class} me-2">${priorityConfig.label}</span>
                                ${this.escapeHtml(rule.description)}
                            </h6>
                            <small class="text-muted">Rule: ${rule.name}</small>
                        </div>
                        <div class="form-check form-switch">
                            <input class="form-check-input" type="checkbox"
                                   ${isEnabled ? 'checked' : ''}
                                   onchange="window.selfHealingDashboard.toggleRule('${rule.name}', this.checked)"
                                   title="${isEnabled ? 'Disable' : 'Enable'} rule">
                        </div>
                    </div>

                    <!-- Rule Details -->
                    <div class="row g-2 mb-2">
                        <div class="col-md-3">
                            <div class="border rounded p-2 bg-light">
                                <small class="text-muted d-block">Detection</small>
                                <strong>${rule.detectionQuery.metric}</strong>
                                <div class="text-muted small">
                                    ${rule.detectionQuery.comparison.replace('_', ' ')} ${rule.detectionQuery.threshold}
                                </div>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="border rounded p-2 bg-light">
                                <small class="text-muted d-block">Cooldown</small>
                                <strong>${rule.remediation.cooldown}</strong>
                                ${cooldown.inCooldown ? `
                                    <div class="text-warning small">
                                        <i class="fas fa-clock"></i> ${cooldown.remainingText}
                                    </div>
                                ` : `
                                    <div class="text-success small">
                                        <i class="fas fa-check"></i> Ready
                                    </div>
                                `}
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="border rounded p-2 bg-light">
                                <small class="text-muted d-block">Approval</small>
                                <strong>${rule.remediation.requiresApproval ? 'Required' : 'Automated'}</strong>
                                <div class="text-muted small">
                                    ${rule.remediation.automated ? 'Auto-execute' : 'Manual'}
                                </div>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="border rounded p-2 bg-light">
                                <small class="text-muted d-block">Executions</small>
                                <strong>${metrics.executions}</strong>
                                <div class="text-muted small">
                                    Success: ${metrics.successRate}%
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Tags -->
                    ${rule.tags ? `
                        <div class="mb-2">
                            ${rule.tags.map(tag => `<span class="badge bg-secondary me-1">${tag}</span>`).join('')}
                        </div>
                    ` : ''}

                    <!-- Actions -->
                    <div class="btn-group btn-group-sm" role="group">
                        <button class="btn btn-outline-primary"
                                onclick="window.selfHealingDashboard.testRule('${rule.name}')"
                                title="Test rule condition"
                                ${cooldown.inCooldown ? 'disabled' : ''}>
                            <i class="fas fa-vial"></i> Test
                        </button>
                        <button class="btn btn-outline-success"
                                onclick="window.selfHealingDashboard.executeRule('${rule.name}')"
                                title="Execute remediation"
                                ${cooldown.inCooldown || !isEnabled ? 'disabled' : ''}>
                            <i class="fas fa-play"></i> Execute
                        </button>
                        <button class="btn btn-outline-info"
                                onclick="window.selfHealingDashboard.editRule('${rule.name}')"
                                title="Edit parameters">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                        <button class="btn btn-outline-secondary"
                                onclick="window.selfHealingDashboard.viewRuleHistory('${rule.name}')"
                                title="View execution history">
                            <i class="fas fa-history"></i> History
                        </button>
                        <button class="btn btn-outline-dark"
                                onclick="window.selfHealingDashboard.viewRuleDetails('${rule.name}')"
                                title="View full details">
                            <i class="fas fa-info-circle"></i> Details
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render execution history
     */
    renderHistory() {
        const container = document.getElementById(this.historyContainerId);
        if (!container) return;

        const limit = 50;
        const recentHistory = this.executionHistory.slice(0, limit);

        if (recentHistory.length === 0) {
            container.innerHTML = `
                <div class="alert alert-info text-center">
                    <i class="fas fa-info-circle"></i> No execution history available
                </div>
            `;
            return;
        }

        const historyHtml = recentHistory.map(entry => {
            const timeAgo = this.formatTimeAgo(entry.lastExecuted);
            const cooldownRemaining = this.formatDuration(entry.cooldownRemaining);

            return `
                <div class="card mb-2">
                    <div class="card-body p-2">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <strong>${this.escapeHtml(entry.ruleName)}</strong>
                                <br>
                                <small class="text-muted">
                                    <i class="fas fa-clock"></i> ${timeAgo}
                                </small>
                            </div>
                            <div class="text-end">
                                ${entry.cooldownRemaining > 0 ? `
                                    <span class="badge bg-warning">
                                        <i class="fas fa-hourglass-half"></i> ${cooldownRemaining}
                                    </span>
                                ` : `
                                    <span class="badge bg-success">
                                        <i class="fas fa-check"></i> Ready
                                    </span>
                                `}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div class="card">
                <div class="card-header">
                    <h6 class="mb-0">
                        <i class="fas fa-history"></i> Recent Executions (Last ${limit})
                    </h6>
                </div>
                <div class="card-body p-2" style="max-height: 600px; overflow-y: auto;">
                    ${historyHtml}
                </div>
            </div>
        `;
    }

    /**
     * Get cooldown information for a rule
     */
    getCooldownInfo(rule) {
        const historyEntry = this.executionHistory.find(h => h.ruleName === rule.name);

        if (!historyEntry || historyEntry.cooldownRemaining <= 0) {
            return { inCooldown: false, remainingMs: 0, remainingText: 'Ready' };
        }

        return {
            inCooldown: true,
            remainingMs: historyEntry.cooldownRemaining,
            remainingText: this.formatDuration(historyEntry.cooldownRemaining)
        };
    }

    /**
     * Get effectiveness metrics for a rule
     */
    getRuleMetrics(rule) {
        // This would ideally come from a dedicated metrics endpoint
        // For now, calculate from execution history
        const ruleExecutions = this.executionHistory.filter(h => h.ruleName === rule.name);

        return {
            executions: ruleExecutions.length,
            successRate: 100, // Placeholder - would need status tracking
            lastExecuted: ruleExecutions.length > 0 ? ruleExecutions[0].lastExecuted : null
        };
    }

    /**
     * Toggle rule enable/disable
     */
    async toggleRule(ruleName, enabled) {
        // Note: This would require a PUT endpoint to update rule configuration
        // For now, show a notification
        this.showToast(
            `Rule "${ruleName}" ${enabled ? 'enabled' : 'disabled'}. Note: This requires server-side implementation.`,
            'info'
        );

        // Update local state
        const rule = this.rules.find(r => r.name === ruleName);
        if (rule) {
            rule.enabled = enabled;
            this.renderRules();
        }
    }

    /**
     * Test rule condition manually
     */
    async testRule(ruleName) {
        try {
            this.showToast(`Testing rule: ${ruleName}...`, 'info');

            const response = await apiClient.post('/self-healing/evaluate', {
                ruleName
            });

            const result = response.data?.evaluation || response.evaluation;

            if (result.shouldTrigger) {
                this.showToast(`Rule would trigger: ${result.reason}`, 'success');
            } else {
                this.showToast(`Rule would not trigger: ${result.reason}`, 'info');
            }

            // Show detailed results in modal
            this.showTestResults(ruleName, result);

        } catch (error) {
            console.error('Failed to test rule:', error);
            this.showToast('Failed to test rule', 'error');
        }
    }

    /**
     * Execute rule remediation manually
     */
    async executeRule(ruleName) {
        if (!confirm(`Are you sure you want to execute remediation for rule "${ruleName}"?`)) {
            return;
        }

        try {
            this.showToast(`Executing remediation: ${ruleName}...`, 'info');

            const response = await apiClient.post('/self-healing/execute', {
                ruleName,
                context: {
                    manual: true,
                    triggeredBy: 'dashboard'
                }
            });

            const result = response.data || response;

            if (result.status === 'success') {
                this.showToast('Remediation executed successfully', 'success');
            } else if (result.status === 'pending_approval') {
                this.showToast('Remediation requires approval', 'info');
            } else {
                this.showToast(`Remediation ${result.status}: ${result.error || 'Unknown'}`, 'error');
            }

            // Reload data
            await this.loadHistory();
            this.renderRules();

        } catch (error) {
            console.error('Failed to execute rule:', error);
            this.showToast('Failed to execute rule', 'error');
        }
    }

    /**
     * Edit rule parameters
     */
    async editRule(ruleName) {
        const rule = this.rules.find(r => r.name === ruleName);
        if (!rule) return;

        const modalHtml = `
            <div class="modal fade" id="editRuleModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Edit Rule Parameters</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <form id="editRuleForm">
                                <div class="mb-3">
                                    <label class="form-label">Rule Name</label>
                                    <input type="text" class="form-control" value="${rule.name}" disabled>
                                </div>

                                <h6>Detection Parameters</h6>
                                <div class="row mb-3">
                                    <div class="col-md-6">
                                        <label class="form-label">Threshold</label>
                                        <input type="number" class="form-control" id="edit-threshold"
                                               value="${rule.detectionQuery.threshold}">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Window</label>
                                        <input type="text" class="form-control" id="edit-window"
                                               value="${rule.detectionQuery.window}"
                                               placeholder="e.g., 5m, 1h, 24h">
                                    </div>
                                </div>

                                <h6>Remediation Parameters</h6>
                                <div class="row mb-3">
                                    <div class="col-md-6">
                                        <label class="form-label">Cooldown</label>
                                        <input type="text" class="form-control" id="edit-cooldown"
                                               value="${rule.remediation.cooldown}"
                                               placeholder="e.g., 15m, 1h, 24h">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Priority</label>
                                        <select class="form-select" id="edit-priority">
                                            <option value="1" ${rule.remediation.priority === 1 ? 'selected' : ''}>1 - Critical</option>
                                            <option value="2" ${rule.remediation.priority === 2 ? 'selected' : ''}>2 - High</option>
                                            <option value="3" ${rule.remediation.priority === 3 ? 'selected' : ''}>3 - Medium</option>
                                            <option value="4" ${rule.remediation.priority === 4 ? 'selected' : ''}>4 - Low</option>
                                        </select>
                                    </div>
                                </div>

                                <div class="form-check mb-3">
                                    <input class="form-check-input" type="checkbox" id="edit-requires-approval"
                                           ${rule.remediation.requiresApproval ? 'checked' : ''}>
                                    <label class="form-check-label" for="edit-requires-approval">
                                        Requires Approval
                                    </label>
                                </div>

                                <div class="alert alert-warning">
                                    <i class="fas fa-exclamation-triangle"></i>
                                    <strong>Note:</strong> Parameter changes require server-side implementation.
                                    This is a UI demonstration.
                                </div>
                            </form>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-primary"
                                    onclick="window.selfHealingDashboard.saveRuleEdits('${ruleName}')">
                                Save Changes
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.showModal(modalHtml, 'editRuleModal');
    }

    /**
     * Save rule edits
     */
    saveRuleEdits(ruleName) {
        const threshold = document.getElementById('edit-threshold').value;
        const window = document.getElementById('edit-window').value;
        const cooldown = document.getElementById('edit-cooldown').value;
        const priority = document.getElementById('edit-priority').value;
        const requiresApproval = document.getElementById('edit-requires-approval').checked;

        this.showToast(`Rule parameters updated (UI only). Server-side implementation needed.`, 'info');

        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('editRuleModal'));
        modal.hide();
    }

    /**
     * View rule execution history
     */
    async viewRuleHistory(ruleName) {
        try {
            const response = await apiClient.get(`/self-healing/history/${ruleName}`);
            const history = response.data?.history || response.history || [];

            const modalHtml = `
                <div class="modal fade" id="ruleHistoryModal" tabindex="-1">
                    <div class="modal-dialog modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Execution History: ${ruleName}</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <div class="modal-body">
                                ${history.length === 0 ? `
                                    <div class="alert alert-info">
                                        <i class="fas fa-info-circle"></i> No execution history for this rule
                                    </div>
                                ` : `
                                    <div class="list-group">
                                        ${history.map(entry => `
                                            <div class="list-group-item">
                                                <div class="d-flex justify-content-between">
                                                    <div>
                                                        <strong>Executed:</strong> ${new Date(entry.lastExecuted).toLocaleString()}
                                                    </div>
                                                    <div>
                                                        ${entry.cooldownRemaining > 0 ? `
                                                            <span class="badge bg-warning">In Cooldown</span>
                                                        ` : `
                                                            <span class="badge bg-success">Ready</span>
                                                        `}
                                                    </div>
                                                </div>
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            this.showModal(modalHtml, 'ruleHistoryModal');

        } catch (error) {
            console.error('Failed to load rule history:', error);
            this.showToast('Failed to load rule history', 'error');
        }
    }

    /**
     * View full rule details
     */
    viewRuleDetails(ruleName) {
        const rule = this.rules.find(r => r.name === ruleName);
        if (!rule) return;

        const modalHtml = `
            <div class="modal fade" id="ruleDetailsModal" tabindex="-1">
                <div class="modal-dialog modal-xl">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Rule Details: ${rule.name}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <h6>Description</h6>
                            <p>${this.escapeHtml(rule.description)}</p>

                            <h6>Detection Configuration</h6>
                            <pre class="bg-dark text-light p-3 rounded">${JSON.stringify(rule.detectionQuery, null, 2)}</pre>

                            <h6>Remediation Configuration</h6>
                            <pre class="bg-dark text-light p-3 rounded">${JSON.stringify(rule.remediation, null, 2)}</pre>

                            <h6>Notification Channels</h6>
                            <pre class="bg-dark text-light p-3 rounded">${JSON.stringify(rule.notifications, null, 2)}</pre>

                            ${rule.conditions ? `
                                <h6>Additional Conditions</h6>
                                <pre class="bg-dark text-light p-3 rounded">${JSON.stringify(rule.conditions, null, 2)}</pre>
                            ` : ''}

                            <h6>Full Rule JSON</h6>
                            <pre class="bg-dark text-light p-3 rounded">${JSON.stringify(rule, null, 2)}</pre>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.showModal(modalHtml, 'ruleDetailsModal');
    }

    /**
     * Show test results in modal
     */
    showTestResults(ruleName, result) {
        const modalHtml = `
            <div class="modal fade" id="testResultsModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Test Results: ${ruleName}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="alert ${result.shouldTrigger ? 'alert-success' : 'alert-info'}">
                                <h6>
                                    <i class="fas ${result.shouldTrigger ? 'fa-check-circle' : 'fa-info-circle'}"></i>
                                    ${result.shouldTrigger ? 'Rule Would Trigger' : 'Rule Would Not Trigger'}
                                </h6>
                                <p class="mb-0"><strong>Reason:</strong> ${result.reason}</p>
                            </div>

                            <h6>Evaluation Details</h6>
                            <pre class="bg-dark text-light p-3 rounded">${JSON.stringify(result, null, 2)}</pre>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            ${result.shouldTrigger ? `
                                <button type="button" class="btn btn-primary"
                                        onclick="window.selfHealingDashboard.executeRule('${ruleName}'); bootstrap.Modal.getInstance(document.getElementById('testResultsModal')).hide();">
                                    Execute Remediation
                                </button>
                            ` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.showModal(modalHtml, 'testResultsModal');
    }

    /**
     * Reload rules from configuration file
     */
    async reloadRules() {
        try {
            this.showToast('Reloading rules from configuration...', 'info');

            const response = await apiClient.post('/self-healing/rules/load');
            const count = response.data?.count || response.count || 0;

            this.showToast(`Successfully loaded ${count} rule(s)`, 'success');

            // Refresh dashboard
            await this.loadStatus();
            await this.loadRules();

        } catch (error) {
            console.error('Failed to reload rules:', error);
            this.showToast('Failed to reload rules', 'error');
        }
    }

    /**
     * Evaluate all rules
     */
    async evaluateAllRules() {
        try {
            this.showToast('Evaluating all rules...', 'info');

            const response = await apiClient.post('/self-healing/evaluate');
            const data = response.data || response;

            const message = `Evaluation complete: ${data.triggered || 0} triggered, ${data.skipped || 0} skipped, ${data.failed || 0} failed`;
            this.showToast(message, data.triggered > 0 ? 'success' : 'info');

            // Refresh dashboard
            await this.loadHistory();
            this.renderRules();

        } catch (error) {
            console.error('Failed to evaluate rules:', error);
            this.showToast('Failed to evaluate rules', 'error');
        }
    }

    /**
     * Start cooldown countdown timers
     */
    startCooldownTimers() {
        // Update cooldown displays every second
        setInterval(() => {
            const historyEntries = document.querySelectorAll('[data-rule-name]');
            historyEntries.forEach(async (element) => {
                // Trigger re-render of cooldown displays
                await this.loadHistory();
                this.renderRules();
            });
        }, 60000); // Update every minute
    }

    /**
     * Start auto-refresh
     */
    startAutoRefresh() {
        this.stopAutoRefresh();
        this.autoRefreshTimer = setInterval(async () => {
            await this.loadStatus();
            await this.loadRules();
            await this.loadHistory();
        }, this.refreshInterval);
    }

    /**
     * Stop auto-refresh
     */
    stopAutoRefresh() {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
        }
    }

    /**
     * Utility: Show modal
     */
    showModal(html, modalId) {
        // Remove existing modal if any
        const existingModal = document.getElementById(modalId);
        if (existingModal) existingModal.remove();

        // Add modal to DOM
        document.body.insertAdjacentHTML('beforeend', html);

        // Show modal (using Bootstrap 5)
        const modal = new bootstrap.Modal(document.getElementById(modalId));
        modal.show();
    }

    /**
     * Utility: Format duration in milliseconds
     */
    formatDuration(ms) {
        if (ms <= 0) return 'Ready';

        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    /**
     * Utility: Format time ago
     */
    formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);

        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;

        return new Date(date).toLocaleDateString();
    }

    /**
     * Utility: Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        if (window.toast) {
            window.toast[type](message);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    /**
     * Cleanup
     */
    destroy() {
        this.stopAutoRefresh();
        this.cooldownTimers.clear();
    }
}

// Export for use in other modules
export default SelfHealingDashboard;

// Also expose globally for onclick handlers
window.SelfHealingDashboard = SelfHealingDashboard;
