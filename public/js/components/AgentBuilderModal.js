
/**
 * Agent Builder Modal
 * Modal for creating and editing AgentX entities
 */

class AgentBuilderModal {
    constructor() {
        this.overlay = null;
        this.agent = null;
        this.mode = 'create';
        this.onSave = null;
        this.tools = []; // Initialize logic state for tools
        
        this.DEFAULT_ICONS = [
            'fa-robot', 'fa-code', 'fa-brain', 'fa-book', 'fa-calculator', 
            'fa-palette', 'fa-star', 'fa-user-astronaut', 'fa-user-tie',
            'fa-user-doctor', 'fa-user-graduate', 'fa-user-ninja',
            'fa-coffee', 'fa-mug-hot', 'fa-flask', 'fa-rocket'
        ];
    }

    /**
     * Create and return the modal HTML structure
     */
    render() {
        return `
            <div class="agent-builder-modal">
                <div class="builder-header">
                    <h2>
                        <i class="fas fa-robot"></i> 
                        <span id="builderTitle">Create Agent</span>
                    </h2>
                    <button class="icon-btn" id="closeBuilderBtn"><i class="fas fa-times"></i></button>
                </div>

                <div class="builder-tabs">
                    <button class="builder-tab active" data-tab="identity">
                        <i class="fas fa-id-card"></i> Identity
                    </button>
                    <button class="builder-tab" data-tab="model">
                        <i class="fas fa-microchip"></i> Model
                    </button>
                    <button class="builder-tab" data-tab="persona">
                        <i class="fas fa-theater-masks"></i> Persona
                    </button>
                    <button class="builder-tab" data-tab="tools">
                        <i class="fas fa-tools"></i> Tools (N8N)
                    </button>
                </div>

                <div class="builder-body">
                    <!-- Tab 1: Identity -->
                    <div class="builder-section active" id="tab-identity">
                        <div class="form-row" style="display:flex; gap:20px;">
                            <div class="form-group" style="flex:1;">
                                <label>Agent Name</label>
                                <input type="text" class="form-input" id="agentName" placeholder="e.g. Coding Assistant">
                            </div>
                            <div class="form-group" style="width:200px;">
                                <label>Category</label>
                                <select class="form-select" id="agentCategory">
                                    <option value="general">General</option>
                                    <option value="coding">Coding</option>
                                    <option value="reasoning">Reasoning</option>
                                    <option value="factual">Factual</option>
                                    <option value="creative">Creative</option>
                                    <option value="math">Math</option>
                                    <option value="specialist">Specialist</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Description</label>
                            <textarea class="form-textarea" id="agentDescription" placeholder="Short description of what this agent does..."></textarea>
                        </div>

                        <div class="form-group">
                            <label>Avatar Icon</label>
                            <input type="hidden" id="agentAvatar" value="fa-robot">
                            <div class="icon-grid" id="iconGrid">
                                ${this.DEFAULT_ICONS.map(icon => `
                                    <div class="icon-option ${icon === 'fa-robot' ? 'selected' : ''}" data-icon="${icon}">
                                        <i class="fas ${icon}"></i>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>

                    <!-- Tab 2: Model -->
                    <div class="builder-section" id="tab-model">
                        <div class="form-group">
                            <label>Default Model</label>
                            <select class="form-select" id="agentModel">
                                <option value="">Loading models...</option>
                            </select>
                            <p class="field-note">The primary LLM used by this agent.</p>
                        </div>
                        
                        <div class="form-group">
                             <label>Capabilities</label>
                             <div class="checkbox-row">
                                 <label style="display:inline-flex; gap:8px; align-items:center;">
                                     <input type="checkbox" id="capRag" checked> Supports RAG
                                 </label>
                                 <br>
                                 <label style="display:inline-flex; gap:8px; align-items:center;">
                                     <input type="checkbox" id="capStream" checked> Supports Streaming
                                 </label>
                             </div>
                        </div>
                    </div>

                    <!-- Tab 3: Persona -->
                    <div class="builder-section" id="tab-persona">
                        <div class="form-group">
                            <label>Linked Persona (Prompt Template)</label>
                            <select class="form-select" id="agentPromptConfig">
                                <option value="">Select a persona...</option>
                            </select>
                            <p class="field-note">
                                Select an existing prompt template or 
                                <a href="#" id="createNewPromptLink" style="color:var(--accent);">create a new one</a>.
                            </p>
                        </div>

                        <div class="preview-box" id="personaPreview" style="display:none; padding:12px; background:rgba(0,0,0,0.3); border-radius:8px;">
                            <h4 style="margin:0 0 8px 0; color:var(--accent);">System Prompt Preview</h4>
                            <div class="markdown-preview" id="personaPreviewContent"></div>
                        </div>
                    </div>

                    <!-- Tab 4: Tools -->
                    <div class="builder-section" id="tab-tools">
                        <div class="tool-list-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <label style="margin:0;">Active Tools</label>
                            <button class="btn-sm ghost" id="addToolBtn"><i class="fas fa-plus"></i> Add Tool</button>
                        </div>

                        <div class="tool-list" id="toolList">
                            <!-- Tools injected here -->
                            <div class="empty-state-mini">
                                <p class="text-muted">No tools configured.</p>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="builder-footer">
                    <button class="btn-secondary" id="cancelBuilderBtn">Cancel</button>
                    <button class="btn-primary" id="saveAgentBtn">Save Agent</button>
                </div>
            </div>
        `;
    }

    /**
     * Show the modal
     */
    async open(agent = null, callback) {
        this.agent = agent;
        this.mode = agent ? 'edit' : 'create';
        this.onSave = callback;

        // Create overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.innerHTML = this.render();
        document.body.appendChild(this.overlay);

        // Bind events
        this.bindEvents();

        // Load data in parallel
        await Promise.all([
            this.loadModels(),
            this.loadPrompts()
        ]);

        // Populate fields if editing
        if (this.agent) {
            this.populateForm();
        }

        // Focus name
        setTimeout(() => document.getElementById('agentName').focus(), 100);
    }

    /**
     * Close the modal
     */
    close() {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
    }

    /**
     * Bind UI events
     */
    bindEvents() {
        // Close buttons
        this.overlay.querySelector('#closeBuilderBtn').onclick = () => this.close();
        this.overlay.querySelector('#cancelBuilderBtn').onclick = () => this.close();

        // Tabs
        const tabs = this.overlay.querySelectorAll('.builder-tab');
        tabs.forEach(tab => {
            tab.onclick = () => {
                // Deactivate all
                tabs.forEach(t => t.classList.remove('active'));
                this.overlay.querySelectorAll('.builder-section').forEach(s => s.classList.remove('active'));
                
                // Activate clicked
                tab.classList.add('active');
                const targetId = `tab-${tab.dataset.tab}`;
                this.overlay.querySelector(`#${targetId}`).classList.add('active');
            };
        });

        // Icon selection
        const icons = this.overlay.querySelectorAll('.icon-option');
        icons.forEach(icon => {
            icon.onclick = () => {
                icons.forEach(i => i.classList.remove('selected'));
                icon.classList.add('selected');
                document.getElementById('agentAvatar').value = icon.dataset.icon;
            };
        });
        
        // Save
        this.overlay.querySelector('#saveAgentBtn').onclick = () => this.save();
        
        // Prompt Preview
        const promptSelect = document.getElementById('agentPromptConfig');
        promptSelect.onchange = () => this.updatePromptPreview();

        // Tools
        this.overlay.querySelector('#addToolBtn').onclick = () => this.addTool();
        
        // Tool Event Delegation (hacky but works for now without fuller component)
        const modalEl = this.overlay.querySelector('.agent-builder-modal');
        modalEl.addEventListener('editTool', (e) => {
            const index = e.detail;
            const tool = this.tools[index];
            // Simple edit
            const newUrl = prompt('Update Webhook URL:', tool.webhookUrl);
            if (newUrl) { 
                this.tools[index].webhookUrl = newUrl; 
                this.renderTools();
            }
        });
        modalEl.addEventListener('deleteTool', (e) => {
            this.deleteTool(e.detail);
        });
    }

    /**
     * Load available Ollama models
     */
    async loadModels() {
        try {
            const res = await fetch('/api/tags');
            const data = await res.json();
            const select = document.getElementById('agentModel');
            
            if (data.models && data.models.length > 0) {
                select.innerHTML = data.models.map(m => 
                    `<option value="${m.name}">${m.name}</option>`
                ).join('');
            } else {
                select.innerHTML = '<option value="">No models found</option>';
            }
        } catch (err) {
            console.error('Failed to load models:', err);
        }
    }

    /**
     * Load available PromptConfigs
     */
    async loadPrompts() {
        try {
            const res = await fetch('/api/prompts');
            const data = await res.json(); // Assuming standard response structure
            this.promptConfigs = data.data || [];
            
            const select = document.getElementById('agentPromptConfig');
            select.innerHTML = '<option value="">Select a persona...</option>' + 
                this.promptConfigs.map(p => 
                    `<option value="${p._id}">${p.name} (v${p.activeVersion})</option>`
                ).join('');
        } catch (err) {
            console.error('Failed to load prompts:', err);
        }
    }

    populateForm() {
        const a = this.agent;
        document.getElementById('builderTitle').textContent = 'Edit Agent';
        document.getElementById('agentName').value = a.name; // Use internal name as display name for now? Or separating?
        // Actually structure has displayName
        document.getElementById('agentName').value = a.displayName || a.name;
        document.getElementById('agentCategory').value = a.category;
        document.getElementById('agentDescription').value = a.description || '';
        document.getElementById('agentModel').value = a.defaultModel;
        document.getElementById('agentPromptConfig').value = a.promptConfigId?._id || a.promptConfigId;
        
        document.getElementById('capRag').checked = a.capabilities?.supportsRag !== false;
        document.getElementById('capStream').checked = a.capabilities?.supportsStreaming !== false;

        // Avatar
        const icon = a.avatar || 'fa-robot';
        const iconEl = this.overlay.querySelector(`.icon-option[data-icon="${icon}"]`);
        if (iconEl) iconEl.click();
        
        this.tools = a.n8nTools || [];
        this.renderTools();
    }

    renderTools() {
        const container = document.getElementById('toolList');
        if (!container) return;

        if (this.tools.length === 0) {
            container.innerHTML = `
                <div class="empty-state-mini" style="text-align:center; padding:20px; color:var(--muted); border:1px dashed var(--panel-border); border-radius:8px;">
                    <p>No tools configured.</p>
                </div>`;
            return;
        }

        container.innerHTML = this.tools.map((tool, index) => `
            <div class="tool-item">
                <div class="tool-icon"><i class="fas fa-bolt"></i></div>
                <div class="tool-details">
                    <div class="tool-name">${tool.name}</div>
                    <div class="tool-desc">${tool.description || 'No description'}</div>
                    <div class="tool-meta" style="font-size:11px; color:var(--accent); margin-top:2px;">
                        ${tool.webhookUrl ? tool.webhookUrl.split('/webhook/')[1]?.substring(0, 15) + '...' : 'No Webhook'}
                    </div>
                </div>
                <div class="tool-actions">
                    <button class="btn-sm icon-btn" onclick="document.querySelector('.agent-builder-modal').dispatchEvent(new CustomEvent('editTool', {detail: ${index}}))">
                        <i class="fas fa-pencil-alt"></i>
                    </button>
                    <button class="btn-sm icon-btn" style="color:#f87171;" onclick="document.querySelector('.agent-builder-modal').dispatchEvent(new CustomEvent('deleteTool', {detail: ${index}}))">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    addTool() {
        // Simple prompt for now - Phase 2 can have a dedicated modal
        const name = prompt('Tool Function Name (e.g. get_weather):');
        if (!name) return;
        
        const description = prompt('Tool Description (for LLM):', 'Retrieves current weather for a location');
        const webhookUrl = prompt('N8N Webhook URL:', 'https://n8n.instance.com/webhook/...');
        
        if (name && webhookUrl) {
            this.tools.push({
                name: name.toLowerCase().replace(/\s+/g, '_'),
                description,
                webhookUrl,
                inputSchema: { type: 'object', properties: {} }, // Default empty schema
                isActive: true
            });
            this.renderTools();
        }
    }

    deleteTool(index) {
        if (confirm('Remove this tool?')) {
            this.tools.splice(index, 1);
            this.renderTools();
        }
    }
    
    updatePromptPreview() {
        const id = document.getElementById('agentPromptConfig').value;
        const config = this.promptConfigs?.find(p => p._id === id);
        const previewEl = document.getElementById('personaPreview');
        const contentEl = document.getElementById('personaPreviewContent');
        
        if (config) {
            const version = config.versions.find(v => v.version === config.activeVersion);
            contentEl.textContent = version ? version.text : 'No text content.';
            previewEl.style.display = 'block';
        } else {
            previewEl.style.display = 'none';
        }
    }

    async save() {
        const data = {
            name: document.getElementById('agentName').value, // Used as internal ID usually, but here unified?
            displayName: document.getElementById('agentName').value,
            category: document.getElementById('agentCategory').value,
            description: document.getElementById('agentDescription').value,
            avatar: document.getElementById('agentAvatar').value,
            defaultModel: document.getElementById('agentModel').value,
            promptConfigId: document.getElementById('agentPromptConfig').value,
            n8nTools: this.tools, // Include tools in save payload
            capabilities: {
                supportsRag: document.getElementById('capRag').checked,
                supportsStreaming: document.getElementById('capStream').checked
            }
        };
        
        if (!data.displayName || !data.defaultModel || !data.promptConfigId) {
            alert('Please fill in all required fields (Name, Model, Persona)');
            return;
        }
        
        // Auto-generate name slug if creating
        if (this.mode === 'create') {
            data.name = data.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        }

        try {
            const url = this.mode === 'create' ? '/api/agents' : `/api/agents/${this.agent._id}`;
            const method = this.mode === 'create' ? 'POST' : 'PUT';
            
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            const result = await res.json();
            if (result.status === 'success') {
                this.close();
                if (this.onSave) this.onSave(result.data);
            } else {
                alert('Error submitting form: ' + result.message);
            }
        } catch (err) {
            console.error(err);
            alert('Failed to save agent');
        }
    }
}

// Export global
window.AgentBuilderModal = AgentBuilderModal;
