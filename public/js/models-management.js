/**
 * Model Management Logic
 * Handles CRUD, status changes, and add source workflows.
 */

class ModelManager {
    constructor(unifiedModels) {
        this.unifiedModels = unifiedModels;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Add Source Modal
        const addBtn = document.getElementById('addModelBtn');
        const modal = document.getElementById('addSourceModal');
        const closeBtns = modal.querySelectorAll('.close-modal');
        const tabBtns = modal.querySelectorAll('.tab-btn');

        addBtn?.addEventListener('click', () => modal.classList.add('active'));
        
        closeBtns.forEach(btn => btn.addEventListener('click', () => {
            modal.classList.remove('active');
            this.resetPullForm();
        }));

        // Tab Switching
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                modal.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab).classList.add('active');
            });
        });

        // Pull Action
        document.getElementById('btnPull')?.addEventListener('click', () => this.handlePull());

        // n8n Connect
        document.getElementById('n8nForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleN8nConnect(new FormData(e.target));
        });
    }

    async handlePull() {
        const input = document.getElementById('pullModelName');
        const progress = document.getElementById('pullProgress');
        const name = input.value.trim();

        if (!name) return alert('Please enter a model name');

        input.disabled = true;
        progress.classList.remove('hidden');
        progress.querySelector('.status-text').innerText = `Requesting pull for ${name}...`;

        try {
            const res = await fetch('/api/models/ollama/pull', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json();

            if (data.status === 'success') {
                progress.querySelector('.status-text').innerText = 'Pull started successfully. You can close this window.';
                setTimeout(() => {
                    document.getElementById('addSourceModal').classList.remove('active');
                    this.unifiedModels.init(); // Refresh list
                    this.resetPullForm();
                }, 1500);
            } else {
                throw new Error(data.message);
            }
        } catch (err) {
            progress.querySelector('.status-text').innerText = `Error: ${err.message}`;
            input.disabled = false;
        }
    }

    resetPullForm() {
        const input = document.getElementById('pullModelName');
        const progress = document.getElementById('pullProgress');
        if(input) { input.value = ''; input.disabled = false; }
        if(progress) progress.classList.add('hidden');
    }

    async handleN8nConnect(formData) {
        // Implementation for n8n connect form
        const data = Object.fromEntries(formData.entries());
        data.provider = 'n8n'; 
        
        try {
            const res = await fetch('/api/models/sources/n8n', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });
            const result = await res.json();
            
            if(result.status === 'success') {
                 alert(`Connected to n8n source: ${data.name}`);
                 document.getElementById('addSourceModal').classList.remove('active');
                 this.unifiedModels.init();
            } else {
                 alert(`Failed to connect: ${result.message}`);
            }
        } catch(e) {
            console.error(e);
            alert('Error connecting to n8n.');
        }
    }

    async deleteModel(model) {
        if (!confirm(`Are you sure you want to delete ${model.name}? This cannot be undone.`)) return;

        try {
            let endpoint = '';
            if (model.source?.type === 'ollama-host' || model.provider === 'ollama') {
                endpoint = `/api/models/ollama/${encodeURIComponent(model.name)}`;
            } else if (model.provider === 'n8n') {
                endpoint = `/api/models/sources/n8n/${model.id}`;
            } else {
                alert('Deletion not supported for this provider yet.');
                return;
            }

            const res = await fetch(endpoint, { method: 'DELETE' });
            if (res.ok) {
                this.unifiedModels.fetchModels(); // Refresh
                alert('Model deleted.');
            } else {
                alert('Failed to delete model.');
            }
        } catch (err) {
            console.error(err);
            alert('Error deleting model.');
        }
    }

    async startModel(model) {
        if (model.provider !== 'ollama' && model.source?.type !== 'ollama-host') {
            alert('Start/Stop is only available for Ollama models.');
            return;
        }
        
        // Starting in Ollama usually means just "pulling" into memory or ensuring it's there.
        // We can hit /api/generate with a dry run or user our new start/stop proxy if we made one.
        // We didn't make a specific "start" proxy in backend, but "pull" ensures it.
        // Actually, just running a chat warms it up.
        // But the user wants a specific "Start" action.
        // Let's call a simple "preload" via /api/chat with empty prompt.
        
        try {
           alert(`Starting ${model.name}... This may take a moment.`);
           // A dry-run request
           const res = await fetch('/api/chat', { // OR a dedicated endpoint if we had one.
               method: 'POST',
               headers: {'Content-Type': 'application/json'},
               body: JSON.stringify({ model: model.name, messages: [], stream: false })
           });
           
           if(res.ok) alert(`${model.name} is ready.`);
           else alert('Failed to start model.');

        } catch (e) {
            console.error(e);
            alert('Error starting model.');
        }
    }
    
    async testModel(model) {
        // Quick test modal or redirect to chat
        // For Phase 2, redirecting to chat with the model selected is a good "Test".
        // Or opening a mini-modal. 
        // Let's use startChat since it's robust.
        window.location.href = `/chat?model=${encodeURIComponent(model.name)}`;
    }
}

// Attach to window for easy access
window.ModelManager = ModelManager;
