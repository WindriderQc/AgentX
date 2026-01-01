/**
 * TemplateTester Component
 * Modal interface for testing prompt templates with variable substitution
 * Provides real-time preview and before/after comparison
 */

export class TemplateTester {
  constructor() {
    this.modal = null;
    this.promptData = null;
    this.variables = new Map(); // Variable name -> value
    this.onClose = null;

    this.initModal();
  }

  /**
   * Initialize modal DOM structure
   */
  initModal() {
    const modalHtml = `
      <div class="modal-overlay" id="templateTesterOverlay" style="display: none;">
        <div class="modal-container template-tester-modal">
          <div class="modal-header">
            <h2>
              <i class="fas fa-flask"></i>
              <span id="testerModalTitle">Test Template</span>
            </h2>
            <button class="modal-close" id="testerModalClose">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="modal-body">
            <div class="tester-container">
              <!-- Left Pane: Variable Inputs -->
              <div class="tester-left-pane">
                <div class="pane-header">
                  <h3>
                    <i class="fas fa-sliders-h"></i>
                    Template Variables
                  </h3>
                  <span class="var-count" id="variableCount">0 variables</span>
                </div>

                <div class="variable-inputs" id="variableInputs">
                  <!-- Variables will be dynamically inserted here -->
                </div>

                <div class="no-variables" id="noVariables" style="display: none;">
                  <i class="fas fa-info-circle"></i>
                  <p>No template variables detected.</p>
                  <small>Use <code>{{variableName}}</code> syntax to add variables.</small>
                </div>

                <div class="pane-footer">
                  <button type="button" class="btn-secondary btn-block" id="resetVariablesBtn">
                    <i class="fas fa-undo"></i>
                    Reset to Defaults
                  </button>
                </div>
              </div>

              <!-- Right Pane: Template Preview -->
              <div class="tester-right-pane">
                <div class="pane-header">
                  <h3>
                    <i class="fas fa-eye"></i>
                    Preview
                  </h3>
                  <div class="preview-actions">
                    <button type="button" class="btn-sm ghost" id="copyPreviewBtn" title="Copy to clipboard">
                      <i class="fas fa-copy"></i>
                      Copy
                    </button>
                    <button type="button" class="btn-sm ghost" id="toggleViewBtn" title="Toggle view mode">
                      <i class="fas fa-columns"></i>
                      Split
                    </button>
                  </div>
                </div>

                <div class="preview-content" id="previewContent">
                  <!-- Preview modes: rendered or split view -->
                  <div class="preview-mode-rendered" id="previewRendered">
                    <pre id="renderedOutput"></pre>
                  </div>

                  <div class="preview-mode-split" id="previewSplit" style="display: none;">
                    <div class="split-section">
                      <div class="split-label">
                        <i class="fas fa-code"></i>
                        Template
                      </div>
                      <pre id="templateSource"></pre>
                    </div>
                    <div class="split-divider"></div>
                    <div class="split-section">
                      <div class="split-label">
                        <i class="fas fa-check-circle"></i>
                        Rendered
                      </div>
                      <pre id="renderedSplit"></pre>
                    </div>
                  </div>
                </div>

                <div class="preview-stats" id="previewStats">
                  <span><i class="fas fa-text-height"></i> <span id="charCount">0</span> characters</span>
                  <span><i class="fas fa-align-left"></i> <span id="lineCount">0</span> lines</span>
                  <span><i class="fas fa-magic"></i> <span id="varReplaceCount">0</span> substitutions</span>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" id="testerCloseBtn">
              <i class="fas fa-times"></i>
              Close
            </button>
          </div>
        </div>
      </div>
    `;

    // Append to modals container or body
    const modalsContainer = document.getElementById('modals') || document.body;
    modalsContainer.insertAdjacentHTML('beforeend', modalHtml);

    this.modal = document.getElementById('templateTesterOverlay');
    this.attachEventListeners();
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Close buttons
    document.getElementById('testerModalClose').addEventListener('click', () => this.close());
    document.getElementById('testerCloseBtn').addEventListener('click', () => this.close());

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

    // Reset variables button
    document.getElementById('resetVariablesBtn').addEventListener('click', () => this.resetVariables());

    // Copy preview button
    document.getElementById('copyPreviewBtn').addEventListener('click', () => this.copyPreview());

    // Toggle view button
    document.getElementById('toggleViewBtn').addEventListener('click', () => this.toggleView());
  }

  /**
   * Open template tester modal
   * @param {Object} promptData - Prompt configuration object
   */
  open(promptData) {
    if (!promptData || !promptData.systemPrompt) {
      console.error('Invalid prompt data:', promptData);
      return;
    }

    this.promptData = promptData;

    // Update modal title
    document.getElementById('testerModalTitle').textContent =
      `Test Template: ${promptData.name} v${promptData.version}`;

    // Parse template and extract variables
    this.extractVariables(promptData.systemPrompt);

    // Generate variable inputs
    this.renderVariableInputs();

    // Initial render
    this.updatePreview();

    // Show modal
    this.modal.style.display = 'flex';
  }

  /**
   * Extract all template variables from the prompt
   * Supports {{variable}} and {{nested.property}} syntax
   */
  extractVariables(template) {
    this.variables.clear();

    // Match all {{variableName}} patterns
    const regex = /\{\{([\w.]+)\}\}/g;
    const matches = template.matchAll(regex);

    const found = new Set();
    for (const match of matches) {
      const varName = match[1];
      found.add(varName);
    }

    // Sort variables for consistent display
    const sortedVars = Array.from(found).sort();

    // Initialize with default values
    sortedVars.forEach(varName => {
      this.variables.set(varName, this.getDefaultValue(varName));
    });

    // Update count
    document.getElementById('variableCount').textContent =
      `${this.variables.size} variable${this.variables.size !== 1 ? 's' : ''}`;

    // Show/hide no variables message
    document.getElementById('noVariables').style.display =
      this.variables.size === 0 ? 'flex' : 'none';
    document.getElementById('variableInputs').style.display =
      this.variables.size === 0 ? 'none' : 'block';
  }

  /**
   * Get sensible default value for a variable
   */
  getDefaultValue(varName) {
    const defaults = {
      'userName': 'John Doe',
      'userProfile': 'Software engineer interested in AI and automation. Prefers concise explanations with code examples.',
      'user.name': 'John Doe',
      'user.email': 'john.doe@example.com',
      'ragContext': '[Sample RAG context: This is retrieved information from your knowledge base. It would contain relevant documentation, facts, or references related to the user\'s query.]',
      'conversationHistory': 'User: Hello!\nAssistant: Hi! How can I help you today?\nUser: I need help with testing.',
      'currentDate': new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      }),
      'systemTime': new Date().toLocaleTimeString('en-US'),
      'profile.preferences': 'Language: English, Timezone: UTC-5, Response Style: Detailed',
      'profile.about': 'User profile information would appear here.',
      'customInstructions': 'Always provide code examples when explaining technical concepts.',
      'contextWindow': '8192 tokens',
      'modelName': 'llama3.2:latest',
      'temperature': '0.7',
      'topP': '0.9'
    };

    // Check for exact match
    if (defaults.hasOwnProperty(varName)) {
      return defaults[varName];
    }

    // Check for pattern matches
    if (varName.toLowerCase().includes('date')) {
      return new Date().toLocaleDateString();
    }
    if (varName.toLowerCase().includes('time')) {
      return new Date().toLocaleTimeString();
    }
    if (varName.toLowerCase().includes('name')) {
      return 'Sample Name';
    }
    if (varName.toLowerCase().includes('context') || varName.toLowerCase().includes('rag')) {
      return '[Sample context information]';
    }
    if (varName.toLowerCase().includes('history')) {
      return 'Sample conversation history...';
    }

    // Default fallback
    return `[${varName}]`;
  }

  /**
   * Render variable input fields
   */
  renderVariableInputs() {
    const container = document.getElementById('variableInputs');
    container.innerHTML = '';

    this.variables.forEach((value, varName) => {
      const inputHtml = `
        <div class="variable-group">
          <label for="var-${varName}">
            <code>{{${varName}}}</code>
          </label>
          <textarea
            id="var-${varName}"
            class="variable-input"
            rows="${this.getTextareaRows(value)}"
            data-var-name="${varName}"
            placeholder="Enter value for ${varName}..."
          >${this.escapeHtml(value)}</textarea>
          <div class="variable-hint">${this.getVariableHint(varName)}</div>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', inputHtml);
    });

    // Attach input event listeners
    container.querySelectorAll('.variable-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const varName = e.target.dataset.varName;
        this.variables.set(varName, e.target.value);
        this.updatePreview();
      });

      // Auto-resize textarea
      input.addEventListener('input', (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
      });
    });
  }

  /**
   * Get appropriate number of textarea rows for value
   */
  getTextareaRows(value) {
    const lines = value.split('\n').length;
    return Math.min(Math.max(lines, 2), 8);
  }

  /**
   * Get helpful hint for a variable
   */
  getVariableHint(varName) {
    const hints = {
      'userName': 'User\'s display name',
      'userProfile': 'User\'s profile description and preferences',
      'ragContext': 'Retrieved context from knowledge base',
      'conversationHistory': 'Recent conversation messages',
      'currentDate': 'Current date',
      'systemTime': 'Current time',
      'customInstructions': 'User\'s custom prompt instructions'
    };

    return hints[varName] || 'Custom variable value';
  }

  /**
   * Update the preview pane with rendered template
   */
  updatePreview() {
    if (!this.promptData) return;

    let template = this.promptData.systemPrompt;
    let substitutionCount = 0;
    const unmatchedVars = [];

    // Perform variable substitution
    let rendered = template;
    this.variables.forEach((value, varName) => {
      const regex = new RegExp(`\\{\\{${this.escapeRegex(varName)}\\}\\}`, 'g');
      const matches = rendered.match(regex);
      if (matches) {
        substitutionCount += matches.length;
        rendered = rendered.replace(regex, value);
      }
    });

    // Check for unmatched variables (variables in template not in our map)
    const allVarsInTemplate = template.match(/\{\{([\w.]+)\}\}/g) || [];
    allVarsInTemplate.forEach(v => {
      const varName = v.slice(2, -2); // Remove {{ and }}
      if (!this.variables.has(varName)) {
        unmatchedVars.push(varName);
      }
    });

    // Update rendered preview
    document.getElementById('renderedOutput').textContent = rendered;
    document.getElementById('renderedSplit').textContent = rendered;

    // Update template source (for split view)
    document.getElementById('templateSource').textContent = template;

    // Highlight unmatched variables in red (in split view template)
    if (unmatchedVars.length > 0) {
      let highlightedTemplate = template;
      unmatchedVars.forEach(varName => {
        const regex = new RegExp(`\\{\\{${this.escapeRegex(varName)}\\}\\}`, 'g');
        highlightedTemplate = highlightedTemplate.replace(
          regex,
          `<span class="unmatched-var">{{${varName}}}</span>`
        );
      });
      document.getElementById('templateSource').innerHTML = highlightedTemplate;
    }

    // Update stats
    document.getElementById('charCount').textContent = rendered.length.toLocaleString();
    document.getElementById('lineCount').textContent = rendered.split('\n').length;
    document.getElementById('varReplaceCount').textContent = substitutionCount;
  }

  /**
   * Reset all variables to default values
   */
  resetVariables() {
    this.variables.forEach((value, varName) => {
      const defaultValue = this.getDefaultValue(varName);
      this.variables.set(varName, defaultValue);
    });

    // Update input fields
    this.variables.forEach((value, varName) => {
      const input = document.getElementById(`var-${varName}`);
      if (input) {
        input.value = value;
        // Trigger resize
        input.style.height = 'auto';
        input.style.height = input.scrollHeight + 'px';
      }
    });

    this.updatePreview();
  }

  /**
   * Copy rendered preview to clipboard
   */
  async copyPreview() {
    const rendered = document.getElementById('renderedOutput').textContent;

    try {
      await navigator.clipboard.writeText(rendered);

      // Show visual feedback
      const btn = document.getElementById('copyPreviewBtn');
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
      btn.style.color = 'rgb(52, 211, 153)';

      setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.style.color = '';
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard');
    }
  }

  /**
   * Toggle between rendered and split view
   */
  toggleView() {
    const rendered = document.getElementById('previewRendered');
    const split = document.getElementById('previewSplit');
    const btn = document.getElementById('toggleViewBtn');

    if (rendered.style.display === 'none') {
      // Switch to rendered view
      rendered.style.display = 'block';
      split.style.display = 'none';
      btn.innerHTML = '<i class="fas fa-columns"></i> Split';
    } else {
      // Switch to split view
      rendered.style.display = 'none';
      split.style.display = 'flex';
      btn.innerHTML = '<i class="fas fa-file-alt"></i> Rendered';
      // Update preview to ensure split view is current
      this.updatePreview();
    }
  }

  /**
   * Close modal
   */
  close() {
    this.modal.style.display = 'none';
    this.variables.clear();
    this.promptData = null;

    if (this.onClose) {
      this.onClose();
    }
  }

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape special regex characters
   */
  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Destroy component and cleanup
   */
  destroy() {
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}
