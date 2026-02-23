/**
 * Model Execution Config Module
 *
 * Modal for viewing and editing per-model execution config.
 * Shows auto-detected defaults vs user overrides.
 * Includes context probe UI for empirical testing.
 */

class ModelExecutionConfig {
    constructor() {
        this.modal = document.getElementById('execConfigModal');
        this.titleEl = document.getElementById('execConfigTitle');
        this.ctxInput = document.getElementById('execConfigNumCtx');
        this.tempInput = document.getElementById('execConfigTemperature');
        this.ctxDefaultEl = document.getElementById('execConfigCtxDefault');
        this.tempDefaultEl = document.getElementById('execConfigTempDefault');
        this.reasonEl = document.getElementById('execConfigReason');
        this.saveBtn = document.getElementById('execConfigSave');
        this.resetBtn = document.getElementById('execConfigReset');
        this.closeBtn = document.getElementById('closeExecConfigModal');
        this.syncBtn = document.getElementById('syncRegistryBtn');

        // Context probe elements
        this.probeRunBtn = document.getElementById('contextProbeRunBtn');
        this.probeStatusEl = document.getElementById('contextProbeStatus');
        this.probeDetailsEl = document.getElementById('contextProbeDetails');
        this.probeShowStepsBtn = document.getElementById('probeShowSteps');
        this.probeStepsList = document.getElementById('probeStepsList');

        this.currentModel = null;
        this.currentConfig = null;
        this.probePollTimer = null;

        this.setupListeners();
    }

    setupListeners() {
        if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
        if (this.modal) this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });
        if (this.saveBtn) this.saveBtn.addEventListener('click', () => this.save());
        if (this.resetBtn) this.resetBtn.addEventListener('click', () => this.reset());
        if (this.syncBtn) this.syncBtn.addEventListener('click', () => this.syncRegistry());
        if (this.probeRunBtn) this.probeRunBtn.addEventListener('click', () => this.runProbe());
        if (this.probeShowStepsBtn) this.probeShowStepsBtn.addEventListener('click', () => this.toggleSteps());
    }

    async open(modelName) {
        this.currentModel = modelName;
        if (this.titleEl) this.titleEl.textContent = `Config: ${modelName}`;
        if (this.modal) this.modal.classList.add('active');

        // Clear inputs while loading
        if (this.ctxInput) this.ctxInput.value = '';
        if (this.tempInput) this.tempInput.value = '';
        if (this.ctxDefaultEl) this.ctxDefaultEl.textContent = 'Loading...';
        if (this.tempDefaultEl) this.tempDefaultEl.textContent = '';
        if (this.reasonEl) this.reasonEl.textContent = '';
        this.resetProbeUI();

        try {
            const resp = await fetch(`/api/models/registry/${encodeURIComponent(modelName)}/execution-config`);
            if (!resp.ok) {
                const errText = resp.status === 404 ? 'Model not in registry yet. Run Sync first.' : `Error: ${resp.status}`;
                if (this.ctxDefaultEl) this.ctxDefaultEl.textContent = errText;
                return;
            }
            const data = await resp.json();
            this.currentConfig = data.data;
            this.render();
            this.loadProbeStatus();
        } catch (err) {
            if (this.ctxDefaultEl) this.ctxDefaultEl.textContent = `Failed: ${err.message}`;
        }
    }

    render() {
        const { effective, defaults, overrides, contextTest } = this.currentConfig;

        // Context window
        const ctxEff = effective?.num_ctx;
        if (ctxEff) {
            const sourceLabel = this.sourceLabel(ctxEff.source);
            const defaultVal = defaults?.num_ctx != null ? defaults.num_ctx : 8192;
            const testedInfo = contextTest?.testedNumCtx ? ` | tested: ${contextTest.testedNumCtx}` : '';
            if (this.ctxDefaultEl) this.ctxDefaultEl.innerHTML = `${sourceLabel} <strong>${ctxEff.value}</strong> (auto: ${defaultVal}${testedInfo})`;
            if (this.ctxInput) this.ctxInput.value = overrides?.num_ctx ?? '';
            if (this.ctxInput) this.ctxInput.placeholder = String(ctxEff.value);
        }

        // Temperature
        const tempEff = effective?.temperature;
        if (tempEff) {
            const sourceLabel = this.sourceLabel(tempEff.source);
            if (this.tempDefaultEl) this.tempDefaultEl.innerHTML = `${sourceLabel} <strong>${tempEff.value}</strong>`;
            if (this.tempInput) this.tempInput.value = overrides?.temperature ?? '';
            if (this.tempInput) this.tempInput.placeholder = String(tempEff.value);
        }

        // Reason
        const reason = effective?._reason || defaults?._reason;
        if (this.reasonEl) {
            this.reasonEl.innerHTML = reason
                ? `<i class="fas fa-info-circle"></i> ${this.escapeHtml(reason)}`
                : '';
        }
    }

    sourceLabel(source) {
        const icons = {
            auto: '<i class="fas fa-cog" style="color:#7cf0ff;" title="Auto-detected"></i>',
            tested: '<i class="fas fa-microscope" style="color:#4ade80;" title="Empirically tested"></i>',
            user: '<i class="fas fa-pen" style="color:#fbbf24;" title="User override"></i>',
            system: '<i class="fas fa-minus" style="color:var(--muted);" title="System default"></i>'
        };
        return icons[source] || icons.system;
    }

    // ── Context Probe UI ───────────────────────────────────────────────────

    resetProbeUI() {
        if (this.probeStatusEl) this.probeStatusEl.textContent = 'Loading...';
        if (this.probeDetailsEl) this.probeDetailsEl.style.display = 'none';
        if (this.probeStepsList) { this.probeStepsList.style.display = 'none'; this.probeStepsList.innerHTML = ''; }
        this.stopProbePoll();
    }

    async loadProbeStatus() {
        if (!this.currentModel) return;
        try {
            const resp = await fetch(`/api/models/registry/${encodeURIComponent(this.currentModel)}/context-test`);
            if (resp.status === 404) {
                if (this.probeStatusEl) this.probeStatusEl.textContent = 'No test run yet. Click "Run Test" to probe context limits.';
                return;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const { data } = await resp.json();
            this.renderProbeResult(data);

            if (data.status === 'running') this.startProbePoll();
        } catch (err) {
            if (this.probeStatusEl) this.probeStatusEl.textContent = `Failed to load: ${err.message}`;
        }
    }

    renderProbeResult(data) {
        if (!data || !data.status) {
            if (this.probeStatusEl) this.probeStatusEl.textContent = 'No test run yet.';
            return;
        }

        if (data.status === 'running') {
            if (this.probeStatusEl) this.probeStatusEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:#7cf0ff;"></i> Probe running...';
            if (this.probeRunBtn) { this.probeRunBtn.disabled = true; this.probeRunBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running'; }
            if (this.probeDetailsEl) this.probeDetailsEl.style.display = 'none';
            return;
        }

        if (data.status === 'failed') {
            if (this.probeStatusEl) this.probeStatusEl.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#f87171;"></i> Failed: ${this.escapeHtml(data.error || 'Unknown error')}`;
            if (this.probeRunBtn) { this.probeRunBtn.disabled = false; this.probeRunBtn.innerHTML = '<i class="fas fa-redo"></i> Retry'; }
            if (this.probeDetailsEl) this.probeDetailsEl.style.display = 'none';
            return;
        }

        // Completed
        if (this.probeStatusEl) this.probeStatusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#4ade80;"></i> Tested — max usable context: <strong>${data.testedNumCtx?.toLocaleString()}</strong>`;
        if (this.probeRunBtn) { this.probeRunBtn.disabled = false; this.probeRunBtn.innerHTML = '<i class="fas fa-redo"></i> Re-test'; }
        if (this.probeDetailsEl) this.probeDetailsEl.style.display = 'block';

        this.setText('probeTestedCtx', data.testedNumCtx?.toLocaleString() ?? '—');
        this.setText('probeTheoMax', data.modelTheoreticalMax?.toLocaleString() ?? '—');
        this.setText('probeBaseline', data.baselineTokensPerSec ? `${data.baselineTokensPerSec} tok/s` : '—');
        this.setText('probeAtLimit', data.atLimitTokensPerSec ? `${data.atLimitTokensPerSec} tok/s` : '—');
        this.setText('probeDegradation', data.degradationPct != null ? `${data.degradationPct}%` : '—');
        this.setText('probeVram', data.vramAtLimitMiB ? `${data.vramAtLimitMiB} MiB` : '—');

        if (data.testedAt) {
            const el = document.getElementById('probeTestedAt');
            if (el) el.textContent = `Tested ${new Date(data.testedAt).toLocaleString()} (${Math.round((data.testDurationMs || 0) / 1000)}s)`;
        }

        // Render steps
        if (data.steps?.length && this.probeStepsList) {
            this.probeStepsList.innerHTML = data.steps.map(s => {
                const cls = s.passed ? 'pass' : 'fail';
                const icon = s.passed ? '&#10003;' : '&#10007;';
                const vram = s.vramUsedMiB ? ` | ${s.vramUsedMiB}/${s.vramTotalMiB} MiB` : '';
                return `<div class="probe-step ${cls}">${icon} ctx=${s.numCtx} ${s.tokensPerSec} tok/s ${s.latencyMs}ms${vram} <span style="color:var(--muted);">${this.escapeHtml(s.reason || '')}</span></div>`;
            }).join('');
        }
    }

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    toggleSteps() {
        if (!this.probeStepsList) return;
        const visible = this.probeStepsList.style.display !== 'none';
        this.probeStepsList.style.display = visible ? 'none' : 'block';
        if (this.probeShowStepsBtn) {
            this.probeShowStepsBtn.innerHTML = visible
                ? '<i class="fas fa-chevron-down"></i> Show probe steps'
                : '<i class="fas fa-chevron-up"></i> Hide probe steps';
        }
    }

    async runProbe() {
        if (!this.currentModel) return;
        if (this.probeRunBtn) { this.probeRunBtn.disabled = true; this.probeRunBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting'; }
        if (this.probeStatusEl) this.probeStatusEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:#7cf0ff;"></i> Starting probe...';

        try {
            const resp = await fetch(`/api/models/registry/${encodeURIComponent(this.currentModel)}/context-test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force: true })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.message || `HTTP ${resp.status}`);
            }
            if (this.probeStatusEl) this.probeStatusEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:#7cf0ff;"></i> Probe running...';
            this.startProbePoll();
        } catch (err) {
            if (this.probeStatusEl) this.probeStatusEl.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#f87171;"></i> ${this.escapeHtml(err.message)}`;
            if (this.probeRunBtn) { this.probeRunBtn.disabled = false; this.probeRunBtn.innerHTML = '<i class="fas fa-play"></i> Run Test'; }
        }
    }

    startProbePoll() {
        this.stopProbePoll();
        this.probePollTimer = setInterval(() => this.pollProbe(), 5000);
    }

    stopProbePoll() {
        if (this.probePollTimer) { clearInterval(this.probePollTimer); this.probePollTimer = null; }
    }

    async pollProbe() {
        if (!this.currentModel) { this.stopProbePoll(); return; }
        try {
            const resp = await fetch(`/api/models/registry/${encodeURIComponent(this.currentModel)}/context-test`);
            if (!resp.ok) return;
            const { data } = await resp.json();
            this.renderProbeResult(data);
            if (data.status !== 'running') {
                this.stopProbePoll();
                // Refresh the config display since effective num_ctx may have changed
                const cfgResp = await fetch(`/api/models/registry/${encodeURIComponent(this.currentModel)}/execution-config`);
                if (cfgResp.ok) {
                    const cfgData = await cfgResp.json();
                    this.currentConfig = cfgData.data;
                    this.render();
                }
            }
        } catch (_) { /* poll failures are transient */ }
    }

    // ── Save / Reset / Sync ────────────────────────────────────────────────

    async save() {
        if (!this.currentModel) return;
        const body = {};
        const ctxVal = this.ctxInput?.value;
        const tempVal = this.tempInput?.value;
        if (ctxVal) body.num_ctx = parseInt(ctxVal, 10);
        if (tempVal) body.temperature = parseFloat(tempVal);

        if (Object.keys(body).length === 0) return;

        try {
            this.saveBtn.disabled = true;
            this.saveBtn.textContent = 'Saving...';
            const resp = await fetch(`/api/models/registry/${encodeURIComponent(this.currentModel)}/execution-config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this.currentConfig = { ...this.currentConfig, ...data.data, effective: data.data.effective };
            this.render();
        } catch (err) {
            alert(`Failed to save: ${err.message}`);
        } finally {
            this.saveBtn.disabled = false;
            this.saveBtn.textContent = 'Save Override';
        }
    }

    async reset() {
        if (!this.currentModel) return;
        if (!confirm('Reset to auto-detected defaults?')) return;

        try {
            this.resetBtn.disabled = true;
            this.resetBtn.textContent = 'Resetting...';
            const resp = await fetch(`/api/models/registry/${encodeURIComponent(this.currentModel)}/execution-config`, {
                method: 'DELETE'
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this.currentConfig = { ...this.currentConfig, ...data.data, effective: data.data.effective, overrides: {} };
            this.render();
            if (this.ctxInput) this.ctxInput.value = '';
            if (this.tempInput) this.tempInput.value = '';
        } catch (err) {
            alert(`Failed to reset: ${err.message}`);
        } finally {
            this.resetBtn.disabled = false;
            this.resetBtn.textContent = 'Reset to Auto';
        }
    }

    async syncRegistry() {
        const btn = this.syncBtn;
        if (!btn) return;
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
        btn.disabled = true;

        try {
            const resp = await fetch('/api/models/registry/sync-hosts', { method: 'POST' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const r = data.data;
            const parts = [];
            if (r.created) parts.push(`${r.created} new`);
            if (r.updated) parts.push(`${r.updated} updated`);
            if (r.retired) parts.push(`${r.retired} retired`);
            const msg = parts.length > 0 ? parts.join(', ') : `${r.unchanged} up to date`;
            btn.innerHTML = `<i class="fas fa-check"></i> ${msg}`;
            // Refresh models list
            if (window.unifiedModels) window.unifiedModels.fetchModels();
            setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 3000);
        } catch (err) {
            btn.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Failed`;
            setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 3000);
        }
    }

    close() {
        if (this.modal) this.modal.classList.remove('active');
        this.currentModel = null;
        this.currentConfig = null;
        this.stopProbePoll();
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.modelExecutionConfig = new ModelExecutionConfig();
});
