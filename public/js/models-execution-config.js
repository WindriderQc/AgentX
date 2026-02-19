/**
 * Model Execution Config Module
 *
 * Modal for viewing and editing per-model execution config.
 * Shows auto-detected defaults vs user overrides.
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

        this.currentModel = null;
        this.currentConfig = null;

        this.setupListeners();
    }

    setupListeners() {
        if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
        if (this.modal) this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });
        if (this.saveBtn) this.saveBtn.addEventListener('click', () => this.save());
        if (this.resetBtn) this.resetBtn.addEventListener('click', () => this.reset());
        if (this.syncBtn) this.syncBtn.addEventListener('click', () => this.syncRegistry());
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
        } catch (err) {
            if (this.ctxDefaultEl) this.ctxDefaultEl.textContent = `Failed: ${err.message}`;
        }
    }

    render() {
        const { effective, defaults, overrides } = this.currentConfig;

        // Context window
        const ctxEff = effective?.num_ctx;
        if (ctxEff) {
            const sourceLabel = this.sourceLabel(ctxEff.source);
            const defaultVal = defaults?.num_ctx != null ? defaults.num_ctx : 8192;
            if (this.ctxDefaultEl) this.ctxDefaultEl.innerHTML = `${sourceLabel} <strong>${ctxEff.value}</strong> (auto-detected: ${defaultVal})`;
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
            user: '<i class="fas fa-pen" style="color:#fbbf24;" title="User override"></i>',
            system: '<i class="fas fa-minus" style="color:var(--muted);" title="System default"></i>'
        };
        return icons[source] || icons.system;
    }

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
