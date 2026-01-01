/**
 * PromptEditorModal Component
 * Modal for creating and editing prompt configurations with Monaco Editor
 */

export class PromptEditorModal {
  constructor() {
    this.modal = null;
    this.editor = null;
    this.mode = 'create'; // 'create' or 'edit'
    this.promptData = null;
    this.onSave = null;
    this.onCancel = null;

    this.initModal();
  }

  /**
   * Initialize modal DOM structure
   */
  initModal() {
    const modalHtml = `
      <div class="modal-overlay" id="promptEditorOverlay" style="display: none;">
        <div class="modal-container prompt-editor-modal">
          <div class="modal-header">
            <h2 id="editorModalTitle">
              <i class="fas fa-code"></i>
              <span id="editorModalTitleText">Create Prompt</span>
            </h2>
            <button class="modal-close" id="editorModalClose">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="modal-body">
            <form id="promptEditorForm">
              <!-- Basic Info Section -->
              <div class="form-section">
                <h3>Basic Information</h3>

                <div class="form-group">
                  <label for="promptName">
                    Prompt Name <span class="required">*</span>
                    <span class="field-hint">Unique identifier (e.g., "default_chat", "code_assistant")</span>
                  </label>
                  <input
                    type="text"
                    id="promptName"
                    name="name"
                    placeholder="e.g., default_chat"
                    required
                    pattern="[a-z0-9_]+"
                    title="Lowercase letters, numbers, and underscores only"
                  />
                  <div class="field-note">
                    Use snake_case. This groups versions together.
                  </div>
                </div>

                <div class="form-group">
                  <label for="promptDescription">
                    Description
                    <span class="field-hint">Brief explanation of this prompt's purpose</span>
                  </label>
                  <textarea
                    id="promptDescription"
                    name="description"
                    rows="2"
                    placeholder="e.g., Default conversational prompt for general chat interactions"
                  ></textarea>
                </div>

                <div class="form-row">
                  <div class="form-group">
                    <label for="promptAuthor">
                      Author
                      <span class="field-hint">Creator or maintainer name</span>
                    </label>
                    <input
                      type="text"
                      id="promptAuthor"
                      name="author"
                      placeholder="e.g., system, john.doe"
                    />
                  </div>

                  <div class="form-group">
                    <label for="promptTags">
                      Tags
                      <span class="field-hint">Comma-separated (e.g., chat, general, v2)</span>
                    </label>
                    <input
                      type="text"
                      id="promptTags"
                      name="tags"
                      placeholder="e.g., chat, general, production"
                    />
                  </div>
                </div>
              </div>

              <!-- System Prompt Section -->
              <div class="form-section">
                <h3>System Prompt <span class="required">*</span></h3>
                <div class="editor-toolbar">
                  <div class="editor-stats">
                    <span id="editorLineCount">Lines: 0</span>
                    <span id="editorCharCount">Characters: 0</span>
                    <span id="editorVarCount">Variables: 0</span>
                  </div>
                  <div class="editor-actions">
                    <button type="button" class="btn-sm ghost" id="insertTemplateVar">
                      <i class="fas fa-plus"></i> Insert Variable
                    </button>
                    <button type="button" class="btn-sm ghost" id="previewTemplate">
                      <i class="fas fa-eye"></i> Preview
                    </button>
                  </div>
                </div>
                <div id="monacoEditorContainer" style="width: 100%; height: 400px; border: 1px solid var(--panel-border); border-radius: 8px;"></div>
                <div class="field-note">
                  Use template variables like <code>{{userName}}</code>, <code>{{userProfile}}</code>, <code>{{ragContext}}</code> for dynamic content.
                </div>
              </div>

              <!-- Activation Settings Section -->
              <div class="form-section">
                <h3>Activation Settings</h3>

                <div class="form-row">
                  <div class="form-group">
                    <label class="checkbox-label">
                      <input
                        type="checkbox"
                        id="promptIsActive"
                        name="isActive"
                      />
                      <span>Activate immediately</span>
                    </label>
                    <div class="field-note">
                      Make this prompt active for A/B testing rotation.
                    </div>
                  </div>

                  <div class="form-group">
                    <label for="promptTrafficWeight">
                      Traffic Weight (0-100)
                      <span class="field-hint">Percentage of traffic for A/B tests</span>
                    </label>
                    <input
                      type="number"
                      id="promptTrafficWeight"
                      name="trafficWeight"
                      min="0"
                      max="100"
                      value="100"
                    />
                    <div class="field-note">
                      100 = All traffic. Use lower values for A/B testing.
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" id="editorCancelBtn">
              <i class="fas fa-times"></i> Cancel
            </button>
            <button type="button" class="btn-primary" id="editorSaveBtn">
              <i class="fas fa-save"></i> Save Prompt
            </button>
          </div>
        </div>
      </div>
    `;

    // Append to modals container or body
    const modalsContainer = document.getElementById('modals') || document.body;
    modalsContainer.insertAdjacentHTML('beforeend', modalHtml);

    this.modal = document.getElementById('promptEditorOverlay');
    this.attachEventListeners();
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Close buttons
    document.getElementById('editorModalClose').addEventListener('click', () => this.close());
    document.getElementById('editorCancelBtn').addEventListener('click', () => this.close());

    // Save button
    document.getElementById('editorSaveBtn').addEventListener('click', () => this.handleSave());

    // Click outside to close
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    // ESC key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.style.display !== 'none') {
        this.close();
      }
    });

    // Template variable insertion
    document.getElementById('insertTemplateVar').addEventListener('click', () => this.insertTemplateVariable());

    // Preview button
    document.getElementById('previewTemplate').addEventListener('click', () => this.previewTemplate());

    // Real-time stats update
    const nameInput = document.getElementById('promptName');
    nameInput.addEventListener('input', () => {
      if (this.mode === 'create') {
        this.validateName();
      }
    });
  }

  /**
   * Initialize Monaco Editor
   */
  async initMonacoEditor() {
    return new Promise((resolve, reject) => {
      if (typeof require === 'undefined') {
        reject(new Error('Monaco loader not available'));
        return;
      }

      require(['vs/editor/editor.main'], () => {
        this.editor = monaco.editor.create(document.getElementById('monacoEditorContainer'), {
          value: '',
          language: 'plaintext',
          theme: 'vs-dark',
          automaticLayout: true,
          minimap: { enabled: false },
          lineNumbers: 'on',
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          fontSize: 14,
          tabSize: 2,
          insertSpaces: true
        });

        // Update stats on content change
        this.editor.onDidChangeModelContent(() => {
          this.updateEditorStats();
        });

        resolve();
      });
    });
  }

  /**
   * Update editor statistics
   */
  updateEditorStats() {
    if (!this.editor) return;

    const content = this.editor.getValue();
    const lines = content.split('\n').length;
    const chars = content.length;
    const variables = (content.match(/\{\{[\w.]+\}\}/g) || []).length;

    document.getElementById('editorLineCount').textContent = `Lines: ${lines}`;
    document.getElementById('editorCharCount').textContent = `Characters: ${chars}`;
    document.getElementById('editorVarCount').textContent = `Variables: ${variables}`;
  }

  /**
   * Insert template variable at cursor
   */
  insertTemplateVariable() {
    const commonVars = [
      '{{userName}}',
      '{{userProfile}}',
      '{{ragContext}}',
      '{{conversationHistory}}',
      '{{currentDate}}',
      '{{systemTime}}'
    ];

    // Simple prompt for now - could be a dropdown in future
    const varName = prompt('Enter variable name (without braces):\n\nCommon variables:\n- userName\n- userProfile\n- ragContext\n- conversationHistory\n- currentDate\n- systemTime', 'userName');

    if (varName && this.editor) {
      const variable = `{{${varName}}}`;
      const selection = this.editor.getSelection();
      this.editor.executeEdits('', [{
        range: selection,
        text: variable
      }]);
      this.editor.focus();
    }
  }

  /**
   * Preview template with sample data
   */
  previewTemplate() {
    if (!this.editor) return;

    const template = this.editor.getValue();
    const sampleData = {
      userName: 'John Doe',
      userProfile: 'Software engineer interested in AI and automation',
      ragContext: '[Sample document context would appear here]',
      conversationHistory: 'User: Hello\nAssistant: Hi! How can I help?',
      currentDate: new Date().toLocaleDateString(),
      systemTime: new Date().toLocaleTimeString()
    };

    // Simple template replacement
    let preview = template;
    Object.keys(sampleData).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      preview = preview.replace(regex, sampleData[key]);
    });

    // Show in alert for now - could be a modal in future
    alert('Template Preview:\n\n' + preview);
  }

  /**
   * Validate prompt name (check for duplicates when creating)
   */
  validateName() {
    const nameInput = document.getElementById('promptName');
    const name = nameInput.value.trim();

    // Pattern validation
    if (name && !/^[a-z0-9_]+$/.test(name)) {
      nameInput.setCustomValidity('Use lowercase letters, numbers, and underscores only');
    } else {
      nameInput.setCustomValidity('');
    }
  }

  /**
   * Open modal in create mode
   */
  async openCreate(defaultName = '') {
    this.mode = 'create';
    this.promptData = null;

    // Update title
    document.getElementById('editorModalTitleText').textContent = 'Create Prompt';

    // Reset form
    document.getElementById('promptEditorForm').reset();
    document.getElementById('promptName').value = defaultName;
    document.getElementById('promptName').disabled = false;
    document.getElementById('promptIsActive').checked = false;
    document.getElementById('promptTrafficWeight').value = 100;

    // Initialize Monaco if not already done
    if (!this.editor) {
      try {
        await this.initMonacoEditor();
      } catch (err) {
        console.error('Failed to initialize Monaco:', err);
        // Fallback to textarea if Monaco fails
        this.useFallbackEditor();
      }
    }

    // Set default template
    if (this.editor) {
      this.editor.setValue('You are AgentX, a helpful AI assistant.\n\nUser Profile: {{userProfile}}\n\nPlease provide clear, concise, and accurate responses.');
      this.updateEditorStats();
    }

    // Show modal
    this.modal.style.display = 'flex';

    // Focus name input
    setTimeout(() => {
      document.getElementById('promptName').focus();
    }, 100);
  }

  /**
   * Open modal in edit mode
   */
  async openEdit(promptData) {
    this.mode = 'edit';
    this.promptData = promptData;

    // Update title
    document.getElementById('editorModalTitleText').textContent = `Edit Prompt: ${promptData.name} v${promptData.version}`;

    // Populate form
    document.getElementById('promptName').value = promptData.name;
    document.getElementById('promptName').disabled = true; // Can't change name in edit mode
    document.getElementById('promptDescription').value = promptData.description || '';
    document.getElementById('promptAuthor').value = promptData.author || '';
    document.getElementById('promptTags').value = (promptData.tags || []).join(', ');
    document.getElementById('promptIsActive').checked = promptData.isActive || false;
    document.getElementById('promptTrafficWeight').value = promptData.trafficWeight || 100;

    // Initialize Monaco if not already done
    if (!this.editor) {
      try {
        await this.initMonacoEditor();
      } catch (err) {
        console.error('Failed to initialize Monaco:', err);
        this.useFallbackEditor();
      }
    }

    // Set content
    if (this.editor) {
      this.editor.setValue(promptData.systemPrompt || '');
      this.updateEditorStats();
    }

    // Show modal
    this.modal.style.display = 'flex';
  }

  /**
   * Fallback to textarea if Monaco fails
   */
  useFallbackEditor() {
    const container = document.getElementById('monacoEditorContainer');
    container.innerHTML = `
      <textarea
        id="systemPromptTextarea"
        style="width: 100%; height: 400px; padding: 12px; background: rgba(0,0,0,0.3); border: none; color: var(--text); font-family: monospace; font-size: 14px; border-radius: 8px; resize: vertical;"
        placeholder="Enter system prompt..."
      ></textarea>
    `;

    const textarea = document.getElementById('systemPromptTextarea');
    textarea.addEventListener('input', () => {
      const content = textarea.value;
      const lines = content.split('\n').length;
      const chars = content.length;
      const variables = (content.match(/\{\{[\w.]+\}\}/g) || []).length;

      document.getElementById('editorLineCount').textContent = `Lines: ${lines}`;
      document.getElementById('editorCharCount').textContent = `Characters: ${chars}`;
      document.getElementById('editorVarCount').textContent = `Variables: ${variables}`;
    });
  }

  /**
   * Get system prompt content
   */
  getSystemPromptContent() {
    if (this.editor) {
      return this.editor.getValue();
    } else {
      const textarea = document.getElementById('systemPromptTextarea');
      return textarea ? textarea.value : '';
    }
  }

  /**
   * Handle save button click
   */
  async handleSave() {
    const form = document.getElementById('promptEditorForm');

    // Validate form
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const systemPrompt = this.getSystemPromptContent().trim();
    if (!systemPrompt) {
      alert('System prompt cannot be empty');
      return;
    }

    // Gather form data
    const formData = {
      name: document.getElementById('promptName').value.trim(),
      description: document.getElementById('promptDescription').value.trim(),
      author: document.getElementById('promptAuthor').value.trim() || 'unknown',
      tags: document.getElementById('promptTags').value.split(',').map(t => t.trim()).filter(Boolean),
      systemPrompt: systemPrompt,
      isActive: document.getElementById('promptIsActive').checked,
      trafficWeight: parseInt(document.getElementById('promptTrafficWeight').value) || 100
    };

    // Call save callback
    if (this.onSave) {
      const saveBtn = document.getElementById('editorSaveBtn');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

      try {
        await this.onSave(formData, this.mode, this.promptData);
        this.close();
      } catch (error) {
        alert(`Failed to save: ${error.message}`);
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Prompt';
      }
    }
  }

  /**
   * Close modal
   */
  close() {
    this.modal.style.display = 'none';

    if (this.onCancel) {
      this.onCancel();
    }
  }

  /**
   * Destroy editor and cleanup
   */
  destroy() {
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}
