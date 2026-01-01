/**
 * PromptListView Component
 * Displays all prompts in a card grid layout with version management
 */

export class PromptListView {
  constructor(container, state) {
    this.container = container;
    this.state = state;
    this.eventHandlers = {};
  }

  /**
   * Render prompts grid
   * @param {Object} prompts - Grouped prompts { [name]: [versions] }
   */
  render(prompts) {
    this.container.innerHTML = '';

    if (!prompts || Object.keys(prompts).length === 0) {
      this.container.innerHTML = '<p class="empty-message" style="text-align: center; color: var(--muted); padding: 40px;">No prompts match your filters.</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'prompt-cards-grid';

    for (const [name, versions] of Object.entries(prompts)) {
      const card = this.createPromptCard(name, versions);
      grid.appendChild(card);
    }

    this.container.appendChild(grid);
  }

  /**
   * Create a prompt card for a group of versions
   */
  createPromptCard(name, versions) {
    const card = document.createElement('div');
    card.className = 'prompt-card';

    const activeVersions = versions.filter(v => v.isActive);
    const latestVersion = versions[0]; // Already sorted by version DESC from backend

    card.innerHTML = `
      <div class="prompt-card-header">
        <h3 class="prompt-name">${this.escapeHtml(name)}</h3>
        <div class="prompt-badge-group">
          ${activeVersions.length > 0 ? `<span class="badge active">${activeVersions.length} Active</span>` : ''}
          <span class="badge total">${versions.length} Total</span>
        </div>
      </div>

      <p class="prompt-description">${this.escapeHtml(latestVersion.description || 'No description provided')}</p>

      <div class="versions-list">
        ${versions.slice(0, 5).map(v => this.createVersionItem(name, v)).join('')}
        ${versions.length > 5 ? `<div style="text-align: center; color: var(--muted); font-size: 12px; padding: 8px;">+${versions.length - 5} more versions</div>` : ''}
      </div>

      <div class="prompt-card-actions">
        <button class="btn-secondary" data-action="ab-test" data-name="${this.escapeHtml(name)}" title="Configure A/B Test">
          <i class="fas fa-flask"></i> A/B Test
        </button>
        <button class="btn-secondary" data-action="metrics" data-name="${this.escapeHtml(name)}" title="View Performance Metrics">
          <i class="fas fa-chart-line"></i> Metrics
        </button>
        <button class="btn-secondary" data-action="new-version" data-name="${this.escapeHtml(name)}" title="Create New Version">
          <i class="fas fa-plus"></i> New Version
        </button>
      </div>
    `;

    this.attachCardEventListeners(card, name);
    return card;
  }

  /**
   * Create a version item within a prompt card
   */
  createVersionItem(promptName, version) {
    const positiveRate = this.calculatePositiveRate(version.stats);
    const isActive = version.isActive;

    // Determine performance class
    let perfClass = 'neutral';
    if (positiveRate >= 0.7) perfClass = 'positive';
    else if (positiveRate < 0.5) perfClass = 'negative';

    return `
      <div class="version-item ${isActive ? 'active' : 'inactive'}">
        <div class="version-info">
          <span class="version-number">v${version.version}</span>
          <span class="status-badge ${isActive ? 'active' : 'inactive'}">
            ${isActive ? 'Active' : 'Inactive'}
          </span>
          ${isActive ? `<span class="traffic-weight">${version.trafficWeight || 100}%</span>` : ''}
        </div>

        <div class="version-stats">
          <span class="stat" title="Total Impressions">
            <i class="fas fa-eye"></i>
            ${this.formatNumber(version.stats?.impressions || 0)}
          </span>
          <span class="stat ${perfClass}" title="Positive Feedback Rate">
            <i class="fas fa-thumbs-up"></i>
            ${(positiveRate * 100).toFixed(1)}%
          </span>
        </div>

        <div class="version-actions">
          <button class="icon-btn"
                  data-action="edit"
                  data-id="${version._id}"
                  data-name="${this.escapeHtml(promptName)}"
                  data-version="${version.version}"
                  title="Edit Metadata">
            <i class="fas fa-edit"></i>
          </button>
          <button class="icon-btn"
                  data-action="test"
                  data-name="${this.escapeHtml(promptName)}"
                  data-version="${version.version}"
                  title="Test Template">
            <i class="fas fa-flask"></i>
          </button>
          ${isActive ?
            `<button class="icon-btn"
                     data-action="deactivate"
                     data-id="${version._id}"
                     title="Deactivate">
              <i class="fas fa-pause"></i>
            </button>` :
            `<button class="icon-btn"
                     data-action="activate"
                     data-id="${version._id}"
                     title="Activate">
              <i class="fas fa-play"></i>
            </button>`
          }
          ${!isActive ?
            `<button class="icon-btn danger"
                     data-action="delete"
                     data-id="${version._id}"
                     data-name="${this.escapeHtml(promptName)}"
                     data-version="${version.version}"
                     title="Delete">
              <i class="fas fa-trash"></i>
            </button>` : ''
          }
        </div>
      </div>
    `;
  }

  /**
   * Attach event listeners to card actions
   */
  attachCardEventListeners(card, promptName) {
    // Card-level actions
    card.querySelectorAll('[data-action="ab-test"]').forEach(btn => {
      btn.addEventListener('click', () => this.emit('configure-ab-test', { promptName }));
    });

    card.querySelectorAll('[data-action="metrics"]').forEach(btn => {
      btn.addEventListener('click', () => this.emit('view-metrics', { promptName }));
    });

    card.querySelectorAll('[data-action="new-version"]').forEach(btn => {
      btn.addEventListener('click', () => this.emit('new-version', { promptName }));
    });

    // Version-level actions
    card.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        const version = parseInt(btn.dataset.version);
        this.emit('edit', { promptName: name, version });
      });
    });

    card.querySelectorAll('[data-action="test"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        const version = parseInt(btn.dataset.version);
        this.emit('test-template', { promptName: name, version });
      });
    });

    card.querySelectorAll('[data-action="activate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.emit('activate', { promptId: btn.dataset.id });
      });
    });

    card.querySelectorAll('[data-action="deactivate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.emit('deactivate', { promptId: btn.dataset.id });
      });
    });

    card.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.emit('delete', {
          promptId: btn.dataset.id,
          promptName: btn.dataset.name,
          version: btn.dataset.version
        });
      });
    });
  }

  /**
   * Calculate positive feedback rate
   */
  calculatePositiveRate(stats) {
    if (!stats) return 0;
    const total = (stats.positiveCount || 0) + (stats.negativeCount || 0);
    return total > 0 ? (stats.positiveCount || 0) / total : 0;
  }

  /**
   * Format number with commas
   */
  formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toLocaleString();
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Register event handler
   */
  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
  }

  /**
   * Emit event to registered handlers
   */
  emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(handler => handler({ detail: data }));
    }
  }
}
