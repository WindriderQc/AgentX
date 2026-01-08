/**
 * PromptLibraryModal Component
 * Modal picker for quick prompt templates in chat interface
 * Features: category tabs, search, preview, variable filling
 */

export class PromptLibraryModal {
  constructor(promptTemplatesAPI) {
    this.api = promptTemplatesAPI;
    this.modal = null;
    this.templates = [];
    this.filteredTemplates = [];
    this.selectedTemplate = null;
    this.currentCategory = 'all';
    this.onInsert = null; // Callback when template is inserted

    this.initModal();
  }

  /**
   * Initialize modal DOM structure
   */
  initModal() {
    const modalHtml = `
      <div class="modal-overlay" id="promptLibraryOverlay" style="display: none;">
        <div class="modal-container prompt-library-modal">
          <div class="modal-header">
            <h2>
              <i class="fas fa-book"></i>
              Quick Prompts Library
            </h2>
            <button class="modal-close" id="promptLibraryClose">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="modal-body">
            <div class="library-container">
              <!-- Search Bar -->
              <div class="library-search">
                <div class="search-input-group">
                  <i class="fas fa-search"></i>
                  <input
                    type="text"
                    id="promptSearchInput"
                    placeholder="Search templates by name, description, or tags..."
                    autocomplete="off"
                  />
                  <button class="btn-clear" id="clearSearchBtn" style="display: none;">
                    <i class="fas fa-times"></i>
                  </button>
                </div>
              </div>

              <!-- Category Tabs -->
              <div class="library-tabs">
                <button class="tab-btn active" data-category="all">
                  <i class="fas fa-th"></i>
                  All
                  <span class="tab-count" id="countAll">0</span>
                </button>
                <button class="tab-btn" data-category="code">
                  <i class="fas fa-code"></i>
                  Code
                  <span class="tab-count" id="countCode">0</span>
                </button>
                <button class="tab-btn" data-category="writing">
                  <i class="fas fa-pen"></i>
                  Writing
                  <span class="tab-count" id="countWriting">0</span>
                </button>
                <button class="tab-btn" data-category="analysis">
                  <i class="fas fa-chart-line"></i>
                  Analysis
                  <span class="tab-count" id="countAnalysis">0</span>
                </button>
                <button class="tab-btn" data-category="general">
                  <i class="fas fa-lightbulb"></i>
                  General
                  <span class="tab-count" id="countGeneral">0</span>
                </button>
                <button class="tab-btn" data-category="custom">
                  <i class="fas fa-star"></i>
                  Custom
                  <span class="tab-count" id="countCustom">0</span>
                </button>
              </div>

              <!-- Templates Grid -->
              <div class="library-content">
                <div class="templates-grid" id="templatesGrid">
                  <!-- Templates will be rendered here -->
                </div>

                <div class="no-templates" id="noTemplates" style="display: none;">
                  <i class="fas fa-inbox"></i>
                  <p>No templates found</p>
                  <small>Try a different search or category</small>
                </div>

                <div class="loading-templates" id="loadingTemplates" style="display: none;">
                  <i class="fas fa-spinner fa-spin"></i>
                  <p>Loading templates...</p>
                </div>
              </div>

              <!-- Template Preview Panel (Slides in from right) -->
              <div class="template-preview" id="templatePreview" style="display: none;">
                <div class="preview-header">
                  <h3 id="previewName"></h3>
                  <button class="btn-close" id="closePreviewBtn">
                    <i class="fas fa-times"></i>
                  </button>
                </div>

                <div class="preview-meta">
                  <span class="category-badge" id="previewCategory"></span>
                  <span class="preview-tags" id="previewTags"></span>
                </div>

                <p class="preview-description" id="previewDescription"></p>

                <div class="preview-template">
                  <h4>Template</h4>
                  <pre id="previewTemplateText"></pre>
                </div>

                <div class="preview-placeholders" id="previewPlaceholders" style="display: none;">
                  <h4>Variables</h4>
                  <div class="placeholders-form" id="placeholdersForm">
                    <!-- Variable inputs will be rendered here -->
                  </div>
                </div>

                <div class="preview-actions">
                  <button class="btn-primary btn-block" id="insertTemplateBtn">
                    <i class="fas fa-plus-circle"></i>
                    Insert Template
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" id="promptLibraryCloseBtn">
              <i class="fas fa-times"></i>
              Close
            </button>
            <button type="button" class="btn-primary" id="manageTemplatesBtn">
              <i class="fas fa-cog"></i>
              Manage Templates
            </button>
          </div>
        </div>
      </div>
    `;

    const modalsContainer = document.getElementById('modals') || document.body;
    modalsContainer.insertAdjacentHTML('beforeend', modalHtml);

    this.modal = document.getElementById('promptLibraryOverlay');
    this.attachEventListeners();
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Close buttons
    document.getElementById('promptLibraryClose').addEventListener('click', () => this.close());
    document.getElementById('promptLibraryCloseBtn').addEventListener('click', () => this.close());

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

    // Search input
    const searchInput = document.getElementById('promptSearchInput');
    searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));

    // Clear search button
    document.getElementById('clearSearchBtn').addEventListener('click', () => {
      searchInput.value = '';
      this.handleSearch('');
    });

    // Category tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const category = e.currentTarget.dataset.category;
        this.selectCategory(category);
      });
    });

    // Close preview
    document.getElementById('closePreviewBtn').addEventListener('click', () => {
      this.closePreview();
    });

    // Insert template
    document.getElementById('insertTemplateBtn').addEventListener('click', () => {
      this.insertTemplate();
    });

    // Manage templates button
    document.getElementById('manageTemplatesBtn').addEventListener('click', () => {
      window.location.href = '/prompt-library.html';
    });
  }

  /**
   * Open modal
   */
  async open(onInsertCallback) {
    this.onInsert = onInsertCallback;
    this.modal.style.display = 'flex';

    // Load templates
    await this.loadTemplates();

    // Focus search input
    setTimeout(() => {
      document.getElementById('promptSearchInput').focus();
    }, 100);
  }

  /**
   * Close modal
   */
  close() {
    this.modal.style.display = 'none';
    this.closePreview();
    document.getElementById('promptSearchInput').value = '';
    this.currentCategory = 'all';
  }

  /**
   * Load templates from API
   */
  async loadTemplates() {
    const loadingEl = document.getElementById('loadingTemplates');
    const gridEl = document.getElementById('templatesGrid');
    const noTemplatesEl = document.getElementById('noTemplates');

    try {
      loadingEl.style.display = 'flex';
      gridEl.style.display = 'none';
      noTemplatesEl.style.display = 'none';

      this.templates = await this.api.list();
      this.filteredTemplates = [...this.templates];

      // Update category counts
      this.updateCategoryCounts();

      // Render templates
      this.renderTemplates();

      loadingEl.style.display = 'none';
      gridEl.style.display = 'grid';
    } catch (err) {
      console.error('Failed to load templates:', err);
      loadingEl.style.display = 'none';
      noTemplatesEl.style.display = 'flex';
      noTemplatesEl.querySelector('p').textContent = 'Failed to load templates';
      noTemplatesEl.querySelector('small').textContent = err.message;
    }
  }

  /**
   * Update category counts
   */
  updateCategoryCounts() {
    const counts = {
      all: this.templates.length,
      code: 0,
      writing: 0,
      analysis: 0,
      general: 0,
      custom: 0
    };

    this.templates.forEach(template => {
      if (counts[template.category] !== undefined) {
        counts[template.category]++;
      }
    });

    // Update count badges
    Object.keys(counts).forEach(category => {
      const countEl = document.getElementById(`count${category.charAt(0).toUpperCase() + category.slice(1)}`);
      if (countEl) {
        countEl.textContent = counts[category];
      }
    });
  }

  /**
   * Select category tab
   */
  selectCategory(category) {
    this.currentCategory = category;

    // Update active tab
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.category === category);
    });

    // Filter templates
    this.applyFilters();
  }

  /**
   * Handle search input
   */
  handleSearch(query) {
    const clearBtn = document.getElementById('clearSearchBtn');
    clearBtn.style.display = query.length > 0 ? 'block' : 'none';

    this.applyFilters(query);
  }

  /**
   * Apply category and search filters
   */
  applyFilters(searchQuery = '') {
    const query = searchQuery || document.getElementById('promptSearchInput').value;

    this.filteredTemplates = this.templates.filter(template => {
      // Category filter
      if (this.currentCategory !== 'all' && template.category !== this.currentCategory) {
        return false;
      }

      // Search filter
      if (query) {
        const searchLower = query.toLowerCase();
        const matchesName = template.name.toLowerCase().includes(searchLower);
        const matchesDescription = template.description.toLowerCase().includes(searchLower);
        const matchesTags = template.tags.some(tag => tag.toLowerCase().includes(searchLower));

        return matchesName || matchesDescription || matchesTags;
      }

      return true;
    });

    this.renderTemplates();
  }

  /**
   * Render templates grid
   */
  renderTemplates() {
    const gridEl = document.getElementById('templatesGrid');
    const noTemplatesEl = document.getElementById('noTemplates');

    if (this.filteredTemplates.length === 0) {
      gridEl.style.display = 'none';
      noTemplatesEl.style.display = 'flex';
      return;
    }

    gridEl.style.display = 'grid';
    noTemplatesEl.style.display = 'none';

    gridEl.innerHTML = this.filteredTemplates.map(template => this.renderTemplateCard(template)).join('');

    // Attach click listeners
    gridEl.querySelectorAll('.template-card').forEach(card => {
      card.addEventListener('click', () => {
        const templateId = card.dataset.templateId;
        const template = this.templates.find(t => t._id === templateId);
        if (template) {
          this.showPreview(template);
        }
      });
    });
  }

  /**
   * Render single template card
   */
  renderTemplateCard(template) {
    const systemBadge = template.isSystem ? '<span class="system-badge"><i class="fas fa-shield-alt"></i> System</span>' : '';
    const usageText = template.usageCount > 0 ? `Used ${template.usageCount} times` : 'Never used';

    return `
      <div class="template-card" data-template-id="${template._id}">
        <div class="card-header">
          <h4>${this.escapeHtml(template.name)}</h4>
          ${systemBadge}
        </div>
        <div class="card-category">
          <span class="category-badge category-${template.category}">
            ${this.getCategoryIcon(template.category)} ${template.category}
          </span>
        </div>
        <p class="card-description">${this.escapeHtml(template.description || 'No description')}</p>
        <div class="card-footer">
          <span class="card-meta">
            <i class="fas fa-tags"></i>
            ${template.placeholders.length} variables
          </span>
          <span class="card-usage">${usageText}</span>
        </div>
      </div>
    `;
  }

  /**
   * Get category icon
   */
  getCategoryIcon(category) {
    const icons = {
      code: '<i class="fas fa-code"></i>',
      writing: '<i class="fas fa-pen"></i>',
      analysis: '<i class="fas fa-chart-line"></i>',
      general: '<i class="fas fa-lightbulb"></i>',
      custom: '<i class="fas fa-star"></i>'
    };
    return icons[category] || '<i class="fas fa-file"></i>';
  }

  /**
   * Show template preview
   */
  showPreview(template) {
    this.selectedTemplate = template;

    const previewEl = document.getElementById('templatePreview');
    document.getElementById('previewName').textContent = template.name;
    document.getElementById('previewCategory').innerHTML = `${this.getCategoryIcon(template.category)} ${template.category}`;
    document.getElementById('previewDescription').textContent = template.description || 'No description';
    document.getElementById('previewTemplateText').textContent = template.template;

    // Render tags
    const tagsEl = document.getElementById('previewTags');
    if (template.tags && template.tags.length > 0) {
      tagsEl.innerHTML = template.tags.map(tag =>
        `<span class="tag-chip">${this.escapeHtml(tag)}</span>`
      ).join('');
    } else {
      tagsEl.innerHTML = '<span class="no-tags">No tags</span>';
    }

    // Render placeholders form
    if (template.placeholders && template.placeholders.length > 0) {
      document.getElementById('previewPlaceholders').style.display = 'block';
      this.renderPlaceholdersForm(template.placeholders);
    } else {
      document.getElementById('previewPlaceholders').style.display = 'none';
    }

    previewEl.style.display = 'block';
  }

  /**
   * Close preview panel
   */
  closePreview() {
    document.getElementById('templatePreview').style.display = 'none';
    this.selectedTemplate = null;
  }

  /**
   * Render placeholders form
   */
  renderPlaceholdersForm(placeholders) {
    const formEl = document.getElementById('placeholdersForm');
    formEl.innerHTML = placeholders.map(placeholder => `
      <div class="placeholder-field">
        <label for="var-${placeholder.name}">
          <code>{{${placeholder.name}}}</code>
        </label>
        <input
          type="text"
          id="var-${placeholder.name}"
          class="placeholder-input"
          data-var-name="${placeholder.name}"
          placeholder="Enter value..."
        />
      </div>
    `).join('');
  }

  /**
   * Insert template into chat
   */
  insertTemplate() {
    if (!this.selectedTemplate) return;

    let rendered = this.selectedTemplate.template;

    // Get variable values from form
    if (this.selectedTemplate.placeholders && this.selectedTemplate.placeholders.length > 0) {
      const formEl = document.getElementById('placeholdersForm');
      const inputs = formEl.querySelectorAll('.placeholder-input');

      inputs.forEach(input => {
        const varName = input.dataset.varName;
        const value = input.value || `{{${varName}}}`;
        const regex = new RegExp(`\\{\\{${this.escapeRegex(varName)}\\}\\}`, 'g');
        rendered = rendered.replace(regex, value);
      });
    }

    // Call insert callback
    if (this.onInsert) {
      this.onInsert(rendered);
    }

    // Record usage (fire and forget)
    this.api.render(this.selectedTemplate._id, {}).catch(err => {
      console.warn('Failed to record template usage:', err);
    });

    this.close();
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape regex special characters
   */
  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Destroy component
   */
  destroy() {
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}
