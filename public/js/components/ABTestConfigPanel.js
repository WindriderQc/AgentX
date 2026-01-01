/**
 * ABTestConfigPanel Component
 * Modal for configuring A/B test traffic weights across prompt versions
 */

export class ABTestConfigPanel {
  constructor() {
    this.modal = null;
    this.promptName = null;
    this.versions = [];
    this.weights = {};
    this.showInactive = false;
    this.onSave = null;
    this.onCancel = null;

    this.initModal();
  }

  /**
   * Initialize modal DOM structure
   */
  initModal() {
    const modalHtml = `
      <div class="modal-overlay" id="abTestConfigOverlay" style="display: none;">
        <div class="modal-container ab-test-modal">
          <div class="modal-header">
            <h2 id="abTestModalTitle">
              <i class="fas fa-flask"></i>
              <span>Configure A/B Test</span>
            </h2>
            <button class="modal-close" id="abTestModalClose">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="modal-body">
            <!-- Prompt Info -->
            <div class="ab-test-info">
              <div class="info-row">
                <span class="info-label">Prompt:</span>
                <span class="info-value" id="abTestPromptName">-</span>
              </div>
              <div class="info-row">
                <span class="info-label">Active Versions:</span>
                <span class="info-value" id="abTestActiveCount">-</span>
              </div>
              <div class="info-row">
                <span class="info-label">Total Traffic:</span>
                <span class="info-value" id="abTestTotalWeight">-</span>
              </div>
            </div>

            <!-- Validation Warning -->
            <div class="validation-warning" id="validationWarning" style="display: none;">
              <i class="fas fa-exclamation-triangle"></i>
              <span id="validationMessage">-</span>
            </div>

            <!-- Show/Hide Inactive Toggle -->
            <div class="toolbar-controls">
              <label class="checkbox-label">
                <input type="checkbox" id="showInactiveToggle" />
                <span>Show inactive versions</span>
              </label>
            </div>

            <!-- Version Weights List -->
            <div class="version-weights-container">
              <div class="versions-header">
                <span>Version</span>
                <span>Traffic Weight</span>
              </div>
              <div id="versionWeightsList"></div>
            </div>

            <!-- Traffic Distribution Visualization -->
            <div class="distribution-section">
              <h3>Traffic Distribution Preview</h3>
              <div class="distribution-chart" id="distributionChart"></div>
              <div class="distribution-legend" id="distributionLegend"></div>
            </div>

            <!-- Bulk Actions -->
            <div class="bulk-actions">
              <button type="button" class="btn-sm ghost" id="activateAllBtn">
                <i class="fas fa-play"></i> Activate All
              </button>
              <button type="button" class="btn-sm ghost" id="deactivateAllBtn">
                <i class="fas fa-pause"></i> Deactivate All
              </button>
              <button type="button" class="btn-sm ghost" id="equalDistributeBtn">
                <i class="fas fa-balance-scale"></i> Equal Distribution
              </button>
              <button type="button" class="btn-sm ghost" id="resetWeightsBtn">
                <i class="fas fa-undo"></i> Reset
              </button>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" id="abTestCancelBtn">
              <i class="fas fa-times"></i> Cancel
            </button>
            <button type="button" class="btn-primary" id="abTestSaveBtn">
              <i class="fas fa-save"></i> Save Configuration
            </button>
          </div>
        </div>
      </div>
    `;

    // Append to modals container or body
    const modalsContainer = document.getElementById('modals') || document.body;
    modalsContainer.insertAdjacentHTML('beforeend', modalHtml);

    this.modal = document.getElementById('abTestConfigOverlay');
    this.attachEventListeners();
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Close buttons
    document.getElementById('abTestModalClose').addEventListener('click', () => this.close());
    document.getElementById('abTestCancelBtn').addEventListener('click', () => this.close());

    // Save button
    document.getElementById('abTestSaveBtn').addEventListener('click', () => this.handleSave());

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

    // Show inactive toggle
    document.getElementById('showInactiveToggle').addEventListener('change', (e) => {
      this.showInactive = e.target.checked;
      this.renderVersionWeights();
      this.updateDistribution();
    });

    // Bulk actions
    document.getElementById('activateAllBtn').addEventListener('click', () => this.activateAll());
    document.getElementById('deactivateAllBtn').addEventListener('click', () => this.deactivateAll());
    document.getElementById('equalDistributeBtn').addEventListener('click', () => this.equalDistribute());
    document.getElementById('resetWeightsBtn').addEventListener('click', () => this.resetWeights());
  }

  /**
   * Open modal with prompt name and versions
   * @param {string} promptName - Name of the prompt
   * @param {Array} versions - Array of version objects
   */
  async open(promptName, versions) {
    this.promptName = promptName;
    this.versions = versions.map(v => ({
      ...v,
      originalWeight: v.trafficWeight || 100,
      originalActive: v.isActive || false
    }));

    // Initialize weights from current values
    this.weights = {};
    this.versions.forEach(v => {
      this.weights[v._id] = {
        weight: v.trafficWeight || 100,
        isActive: v.isActive || false
      };
    });

    // Update header info
    document.getElementById('abTestPromptName').textContent = promptName;
    this.updateHeaderInfo();

    // Reset show inactive toggle
    document.getElementById('showInactiveToggle').checked = false;
    this.showInactive = false;

    // Render version weights
    this.renderVersionWeights();

    // Update distribution chart
    this.updateDistribution();

    // Show modal
    this.modal.style.display = 'flex';
  }

  /**
   * Update header info (active count, total weight)
   */
  updateHeaderInfo() {
    const activeVersions = this.versions.filter(v => this.weights[v._id].isActive);
    const totalWeight = activeVersions.reduce((sum, v) => sum + this.weights[v._id].weight, 0);

    document.getElementById('abTestActiveCount').textContent = activeVersions.length;
    document.getElementById('abTestTotalWeight').textContent = `${totalWeight}%`;

    // Validation
    this.validateWeights(totalWeight, activeVersions.length);
  }

  /**
   * Validate weights sum to 100%
   */
  validateWeights(totalWeight, activeCount) {
    const warning = document.getElementById('validationWarning');
    const message = document.getElementById('validationMessage');
    const saveBtn = document.getElementById('abTestSaveBtn');

    if (activeCount === 0) {
      warning.style.display = 'flex';
      message.textContent = 'At least one version must be active';
      saveBtn.disabled = true;
      return false;
    }

    if (totalWeight !== 100) {
      warning.style.display = 'flex';
      message.textContent = `Traffic weights must sum to 100% (currently ${totalWeight}%)`;
      saveBtn.disabled = true;
      return false;
    }

    warning.style.display = 'none';
    saveBtn.disabled = false;
    return true;
  }

  /**
   * Render version weights list
   */
  renderVersionWeights() {
    const container = document.getElementById('versionWeightsList');
    container.innerHTML = '';

    const versionsToShow = this.showInactive
      ? this.versions
      : this.versions.filter(v => this.weights[v._id].isActive);

    if (versionsToShow.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--muted); padding: 20px;">No versions to display</p>';
      return;
    }

    versionsToShow.forEach(version => {
      const item = this.createVersionWeightItem(version);
      container.appendChild(item);
    });
  }

  /**
   * Create a version weight configuration item
   */
  createVersionWeightItem(version) {
    const item = document.createElement('div');
    item.className = 'version-weight-item';
    if (this.weights[version._id].isActive) {
      item.classList.add('active');
    }

    const weight = this.weights[version._id].weight;
    const isActive = this.weights[version._id].isActive;

    // Stats
    const positiveRate = this.calculatePositiveRate(version.stats);
    const impressions = version.stats?.impressions || 0;

    item.innerHTML = `
      <div class="version-weight-header">
        <div class="version-info">
          <label class="checkbox-label">
            <input
              type="checkbox"
              class="version-active-toggle"
              data-version-id="${version._id}"
              ${isActive ? 'checked' : ''}
            />
            <span class="version-label">
              <strong>v${version.version}</strong>
              ${version.description ? `<span class="version-desc">${this.escapeHtml(version.description)}</span>` : ''}
            </span>
          </label>
        </div>
        <div class="version-stats-mini">
          <span title="Impressions"><i class="fas fa-eye"></i> ${this.formatNumber(impressions)}</span>
          <span title="Positive Rate"><i class="fas fa-thumbs-up"></i> ${(positiveRate * 100).toFixed(1)}%</span>
        </div>
      </div>

      <div class="weight-controls">
        <input
          type="range"
          class="weight-slider"
          data-version-id="${version._id}"
          min="0"
          max="100"
          value="${weight}"
          ${!isActive ? 'disabled' : ''}
        />
        <input
          type="number"
          class="weight-input"
          data-version-id="${version._id}"
          min="0"
          max="100"
          value="${weight}"
          ${!isActive ? 'disabled' : ''}
        />
        <span class="weight-unit">%</span>
      </div>
    `;

    // Attach event listeners
    const checkbox = item.querySelector('.version-active-toggle');
    const slider = item.querySelector('.weight-slider');
    const input = item.querySelector('.weight-input');

    checkbox.addEventListener('change', (e) => {
      this.weights[version._id].isActive = e.target.checked;
      slider.disabled = !e.target.checked;
      input.disabled = !e.target.checked;
      item.classList.toggle('active', e.target.checked);
      this.updateHeaderInfo();
      this.updateDistribution();
    });

    slider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      this.weights[version._id].weight = value;
      input.value = value;
      this.updateHeaderInfo();
      this.updateDistribution();
    });

    input.addEventListener('input', (e) => {
      let value = parseInt(e.target.value) || 0;
      value = Math.max(0, Math.min(100, value));
      this.weights[version._id].weight = value;
      slider.value = value;
      e.target.value = value;
      this.updateHeaderInfo();
      this.updateDistribution();
    });

    return item;
  }

  /**
   * Update traffic distribution visualization
   */
  updateDistribution() {
    const activeVersions = this.versions.filter(v => this.weights[v._id].isActive);
    const totalWeight = activeVersions.reduce((sum, v) => sum + this.weights[v._id].weight, 0);

    const chartContainer = document.getElementById('distributionChart');
    const legendContainer = document.getElementById('distributionLegend');

    if (activeVersions.length === 0) {
      chartContainer.innerHTML = '<p style="text-align: center; color: var(--muted); padding: 20px;">No active versions</p>';
      legendContainer.innerHTML = '';
      return;
    }

    // Clear containers
    chartContainer.innerHTML = '';
    legendContainer.innerHTML = '';

    // Color palette
    const colors = [
      'rgb(124, 240, 255)',
      'rgb(52, 211, 153)',
      'rgb(251, 191, 36)',
      'rgb(248, 113, 113)',
      'rgb(168, 85, 247)',
      'rgb(96, 165, 250)'
    ];

    // Create bar chart
    activeVersions.forEach((version, index) => {
      const weight = this.weights[version._id].weight;
      const percentage = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
      const color = colors[index % colors.length];

      // Bar segment
      const segment = document.createElement('div');
      segment.className = 'distribution-bar';
      segment.style.width = `${percentage}%`;
      segment.style.background = color;
      segment.title = `v${version.version}: ${weight}% (${percentage.toFixed(1)}% of total)`;
      chartContainer.appendChild(segment);

      // Legend item
      const legendItem = document.createElement('div');
      legendItem.className = 'legend-item';
      legendItem.innerHTML = `
        <div class="legend-color" style="background: ${color};"></div>
        <div class="legend-label">
          <strong>v${version.version}</strong>
          <span>${weight}%</span>
        </div>
      `;
      legendContainer.appendChild(legendItem);
    });
  }

  /**
   * Bulk Actions
   */
  activateAll() {
    this.versions.forEach(v => {
      this.weights[v._id].isActive = true;
    });
    this.renderVersionWeights();
    this.updateHeaderInfo();
    this.updateDistribution();
  }

  deactivateAll() {
    this.versions.forEach(v => {
      this.weights[v._id].isActive = false;
    });
    this.renderVersionWeights();
    this.updateHeaderInfo();
    this.updateDistribution();
  }

  equalDistribute() {
    const activeVersions = this.versions.filter(v => this.weights[v._id].isActive);
    if (activeVersions.length === 0) return;

    const equalWeight = Math.floor(100 / activeVersions.length);
    const remainder = 100 - (equalWeight * activeVersions.length);

    activeVersions.forEach((v, index) => {
      // Give remainder to first version
      this.weights[v._id].weight = equalWeight + (index === 0 ? remainder : 0);
    });

    this.renderVersionWeights();
    this.updateHeaderInfo();
    this.updateDistribution();
  }

  resetWeights() {
    this.versions.forEach(v => {
      this.weights[v._id] = {
        weight: v.originalWeight,
        isActive: v.originalActive
      };
    });
    this.renderVersionWeights();
    this.updateHeaderInfo();
    this.updateDistribution();
  }

  /**
   * Handle save button click
   */
  async handleSave() {
    const activeVersions = this.versions.filter(v => this.weights[v._id].isActive);
    const totalWeight = activeVersions.reduce((sum, v) => sum + this.weights[v._id].weight, 0);

    // Validate
    if (!this.validateWeights(totalWeight, activeVersions.length)) {
      return;
    }

    // Prepare data
    const versionConfigs = this.versions.map(v => ({
      version: v.version,
      weight: this.weights[v._id].weight,
      isActive: this.weights[v._id].isActive
    }));

    // Call save callback
    if (this.onSave) {
      const saveBtn = document.getElementById('abTestSaveBtn');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

      try {
        await this.onSave(this.promptName, versionConfigs);
        this.close();
      } catch (error) {
        alert(`Failed to save A/B test configuration: ${error.message}`);
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Configuration';
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
   * Destroy modal and cleanup
   */
  destroy() {
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}
