/**
 * Model Comparison Logic
 * Renders the side-by-side comparison view.
 */

class ModelComparator {
    constructor(unifiedModels) {
        this.unifiedModels = unifiedModels;
        this.modal = document.getElementById('comparisonModal');
        this.container = document.getElementById('comparisonContainer');
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        document.getElementById('compareNowBtn')?.addEventListener('click', () => {
            this.openComparison();
        });

        this.modal.querySelector('.close-modal')?.addEventListener('click', () => {
            this.modal.classList.remove('active');
        });
    }

    openComparison() {
        const ids = Array.from(this.unifiedModels.comparisonList);
        if (ids.length < 2) {
            alert('Please select at least 2 models to compare.');
            return;
        }

        const models = ids.map(id => this.unifiedModels.allModels.find(m => (m.id || m.name) === id)).filter(Boolean);
        this.renderComparison(models);
        this.modal.classList.add('active');
    }

    renderComparison(models) {
        if (!this.container) return;

        // Define rows
        const rows = [
            { label: 'Provider', key: 'provider', format: (v) => `<span class="badge badge-${v==='ollama'?'orange':v==='n8n'?'pink':'indigo'}">${v}</span>` },
            { label: 'Parameters', key: 'parameters', extract: m => m.details?.parameter_size || m.parameters || '-' },
            { label: 'Context', key: 'context', extract: m => (m.details?.context_length || 4096).toLocaleString() },
            { label: 'Quantization', key: 'quantization', extract: m => m.details?.quantization_level || m.quantization || '-' },
            { label: 'Size (Disk)', key: 'size', extract: m => (m.size ? (m.size/1024/1024/1024).toFixed(2)+' GB' : '-') },
            { label: 'Format', key: 'format', extract: m => m.details?.format || 'GGUF' },
            { label: 'Family', key: 'family', extract: m => m.details?.family || m.family || '-' },
            { label: 'Modified', key: 'mod', extract: m => new Date(m.modified_at || Date.now()).toLocaleDateString() }
        ];

        // CSS Grid Template: Header col + 1 col per model
        this.container.style.gridTemplateColumns = `200px repeat(${models.length}, minmax(250px, 1fr))`;
        
        let html = '';

        // 1. Header Row (Model Names)
        html += `<div class="comp-header">Model</div>`;
        models.forEach(m => {
            html += `<div class="comp-cell" style="font-weight:bold; font-size:1.1em; color:#fff;">${m.name}</div>`;
        });

        // 2. Data Rows
        rows.forEach(row => {
            html += `<div class="comp-header">${row.label}</div>`;
            models.forEach(m => {
                let val = row.extract ? row.extract(m) : m[row.key];
                if (row.format) val = row.format(val);
                html += `<div class="comp-cell">${val}</div>`;
            });
        });

        this.container.innerHTML = html;
    }
}

window.ModelComparator = ModelComparator;
