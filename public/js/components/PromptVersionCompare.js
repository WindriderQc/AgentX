/**
 * PromptVersionCompare Component
 * Side-by-side comparison of different versions of the same prompt
 * Shows system prompt diffs, stats comparison, and trending indicators
 */

export class PromptVersionCompare {
  constructor(api, toast) {
    this.api = api;
    this.toast = toast;
    this.overlay = null;
    this.isOpen = false;
    this.promptName = null;
    this.versions = [];
    this.selectedVersions = [null, null]; // [version1, version2]
  }

  /**
   * Open comparison modal for a specific prompt
   * @param {string} promptName - Name of the prompt to compare versions
   */
  async open(promptName) {
    if (this.isOpen) return;

    this.promptName = promptName;
    this.selectedVersions = [null, null];

    // Fetch all versions for this prompt
    try {
      this.versions = await this.api.getByName(promptName);

      if (!this.versions || this.versions.length < 2) {
        this.toast.error('Need at least 2 versions to compare');
        return;
      }

      // Sort versions by version number descending
      this.versions.sort((a, b) => b.version - a.version);

      // Pre-select the two most recent versions
      this.selectedVersions = [
        this.versions[0].version,
        this.versions[1]?.version || this.versions[0].version
      ];

      this.render();
      this.isOpen = true;
    } catch (error) {
      console.error('Failed to load versions:', error);
      this.toast.error(`Failed to load versions: ${error.message}`);
    }
  }

  /**
   * Close the comparison modal
   */
  close() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.isOpen = false;
    this.promptName = null;
    this.versions = [];
    this.selectedVersions = [null, null];
  }

  /**
   * Render the comparison modal
   */
  render() {
    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay version-compare-overlay';
    this.overlay.innerHTML = `
      <div class="modal-container version-compare-modal">
        <div class="modal-header">
          <h2>
            <i class="fas fa-columns"></i>
            Compare Versions: ${this.escapeHtml(this.promptName)}
          </h2>
          <button class="modal-close" id="compareClose" title="Close">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="modal-body">
          <!-- Version Selectors -->
          <div class="version-selectors">
            <div class="version-selector-group">
              <label>
                <i class="fas fa-code"></i>
                Version 1
              </label>
              <select id="version1Select" class="version-select">
                ${this.renderVersionOptions(0)}
              </select>
            </div>
            <div class="version-selector-divider">
              <i class="fas fa-exchange-alt"></i>
            </div>
            <div class="version-selector-group">
              <label>
                <i class="fas fa-code"></i>
                Version 2
              </label>
              <select id="version2Select" class="version-select">
                ${this.renderVersionOptions(1)}
              </select>
            </div>
          </div>

          <!-- Comparison Content -->
          <div id="comparisonContent" class="comparison-content">
            ${this.renderComparison()}
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" id="closeCompareBtn">
            <i class="fas fa-times"></i> Close
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // Attach event listeners
    this.attachEventListeners();
  }

  /**
   * Render version selector options
   */
  renderVersionOptions(index) {
    return this.versions.map(v => {
      const selected = v.version === this.selectedVersions[index] ? 'selected' : '';
      const label = `v${v.version} ${v.isActive ? '(Active)' : ''}`;
      return `<option value="${v.version}" ${selected}>${this.escapeHtml(label)}</option>`;
    }).join('');
  }

  /**
   * Render the comparison view
   */
  renderComparison() {
    const v1Data = this.versions.find(v => v.version === this.selectedVersions[0]);
    const v2Data = this.versions.find(v => v.version === this.selectedVersions[1]);

    if (!v1Data || !v2Data) {
      return '<p class="no-selection">Select versions to compare</p>';
    }

    return `
      <!-- Stats Comparison -->
      <div class="stats-comparison">
        <h3><i class="fas fa-chart-bar"></i> Performance Metrics</h3>
        <div class="stats-grid">
          ${this.renderStatsCard(v1Data, 'Version ' + v1Data.version)}
          <div class="stats-divider"></div>
          ${this.renderStatsCard(v2Data, 'Version ' + v2Data.version)}
        </div>
      </div>

      <!-- System Prompt Diff -->
      <div class="prompt-diff">
        <h3>
          <i class="fas fa-file-code"></i>
          System Prompt Comparison
        </h3>
        <div class="diff-view">
          ${this.renderDiff(v1Data.systemPrompt, v2Data.systemPrompt, v1Data.version, v2Data.version)}
        </div>
      </div>

      <!-- Metadata Comparison -->
      <div class="metadata-comparison">
        <h3><i class="fas fa-info-circle"></i> Metadata</h3>
        <div class="metadata-grid">
          ${this.renderMetadataCard(v1Data)}
          <div class="metadata-divider"></div>
          ${this.renderMetadataCard(v2Data)}
        </div>
      </div>
    `;
  }

  /**
   * Render stats card for a version
   */
  renderStatsCard(version, label) {
    const stats = version.stats || {};
    const impressions = stats.impressions || 0;
    const positiveCount = stats.positiveCount || 0;
    const negativeCount = stats.negativeCount || 0;
    const total = positiveCount + negativeCount;
    const positiveRate = total > 0 ? (positiveCount / total) * 100 : 0;
    const negativeRate = total > 0 ? (negativeCount / total) * 100 : 0;

    // Determine status
    let statusClass = 'good';
    let statusText = 'Healthy';
    if (positiveRate < 50) {
      statusClass = 'poor';
      statusText = 'Poor';
    } else if (positiveRate < 70) {
      statusClass = 'caution';
      statusText = 'Fair';
    }

    // Calculate trending (simplified - could be enhanced with historical data)
    const trending = this.calculateTrendingIndicator(version);

    return `
      <div class="stats-card">
        <div class="stats-card-header">
          <div class="stats-label">${this.escapeHtml(label)}</div>
          <span class="status-badge ${statusClass}">${statusText}</span>
        </div>

        <div class="stats-metrics">
          <div class="metric-item">
            <div class="metric-label">
              <i class="fas fa-eye"></i>
              Impressions
            </div>
            <div class="metric-value">${this.formatNumber(impressions)}</div>
          </div>

          <div class="metric-item">
            <div class="metric-label">
              <i class="fas fa-thumbs-up"></i>
              Positive Rate
            </div>
            <div class="metric-value positive">
              ${positiveRate.toFixed(1)}%
              ${trending ? trending : ''}
            </div>
          </div>

          <div class="metric-item">
            <div class="metric-label">
              <i class="fas fa-check-circle"></i>
              Positive
            </div>
            <div class="metric-value">${this.formatNumber(positiveCount)}</div>
          </div>

          <div class="metric-item">
            <div class="metric-label">
              <i class="fas fa-times-circle"></i>
              Negative
            </div>
            <div class="metric-value">${this.formatNumber(negativeCount)}</div>
          </div>

          <div class="metric-item">
            <div class="metric-label">
              <i class="fas fa-percentage"></i>
              Negative Rate
            </div>
            <div class="metric-value negative">
              ${negativeRate.toFixed(1)}%
            </div>
          </div>

          <div class="metric-item full-width">
            <div class="feedback-bar">
              <div class="feedback-positive" style="width: ${positiveRate}%"></div>
              <div class="feedback-negative" style="width: ${negativeRate}%"></div>
            </div>
          </div>
        </div>

        ${!version.isActive ? `
          <div class="stats-card-actions">
            <button class="btn-primary btn-sm" data-version-id="${version._id}" data-action="activate">
              <i class="fas fa-check"></i> Make Active
            </button>
          </div>
        ` : `
          <div class="stats-card-badge">
            <i class="fas fa-star"></i> Currently Active
          </div>
        `}
      </div>
    `;
  }

  /**
   * Calculate trending indicator
   */
  calculateTrendingIndicator(version) {
    // This is a simplified version - in production, you'd fetch historical data
    // For now, we'll show a placeholder or omit
    const stats = version.stats || {};
    const impressions = stats.impressions || 0;

    if (impressions === 0) {
      return '<span class="trending-badge new"><i class="fas fa-sparkles"></i> New</span>';
    }

    // Could be enhanced with actual trending data from analytics API
    return '';
  }

  /**
   * Render metadata card
   */
  renderMetadataCard(version) {
    return `
      <div class="metadata-card">
        <div class="metadata-item">
          <span class="metadata-label">Version:</span>
          <span class="metadata-value">v${version.version}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Status:</span>
          <span class="metadata-value">
            <span class="status-badge ${version.isActive ? 'active' : 'inactive'}">
              ${version.isActive ? 'Active' : 'Inactive'}
            </span>
          </span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Traffic Weight:</span>
          <span class="metadata-value">${version.trafficWeight || 100}%</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Author:</span>
          <span class="metadata-value">${this.escapeHtml(version.author || 'unknown')}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Created:</span>
          <span class="metadata-value">${this.formatDate(version.createdAt)}</span>
        </div>
        ${version.description ? `
          <div class="metadata-item full-width">
            <span class="metadata-label">Description:</span>
            <span class="metadata-value">${this.escapeHtml(version.description)}</span>
          </div>
        ` : ''}
        ${version.tags && version.tags.length > 0 ? `
          <div class="metadata-item full-width">
            <span class="metadata-label">Tags:</span>
            <span class="metadata-value">
              ${version.tags.map(tag => `<span class="tag-badge">${this.escapeHtml(tag)}</span>`).join('')}
            </span>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render text diff between two system prompts
   */
  renderDiff(text1, text2, v1, v2) {
    // Simple word-by-word diff implementation
    const words1 = text1.split(/(\s+)/);
    const words2 = text2.split(/(\s+)/);

    // Use a simple LCS-based diff algorithm
    const diff = this.computeDiff(words1, words2);

    return `
      <div class="diff-columns">
        <div class="diff-column left">
          <div class="diff-header">
            <i class="fas fa-code"></i>
            Version ${v1}
          </div>
          <div class="diff-content">
            ${this.renderDiffSide(diff, 'left')}
          </div>
        </div>
        <div class="diff-column right">
          <div class="diff-header">
            <i class="fas fa-code"></i>
            Version ${v2}
          </div>
          <div class="diff-content">
            ${this.renderDiffSide(diff, 'right')}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Compute diff between two arrays of words
   * Returns array of {type: 'add'|'remove'|'same', value: string}
   */
  computeDiff(arr1, arr2) {
    const diff = [];
    const m = arr1.length;
    const n = arr2.length;

    // Simple LCS-based diff (Myers algorithm simplified)
    const lcs = this.longestCommonSubsequence(arr1, arr2);

    let i = 0, j = 0, k = 0;

    while (i < m || j < n) {
      if (k < lcs.length && i < m && arr1[i] === lcs[k]) {
        diff.push({ type: 'same', value: arr1[i] });
        i++;
        j++;
        k++;
      } else if (k < lcs.length && j < n && arr2[j] === lcs[k]) {
        diff.push({ type: 'add', value: arr2[j] });
        j++;
      } else if (i < m) {
        diff.push({ type: 'remove', value: arr1[i] });
        i++;
      } else {
        diff.push({ type: 'add', value: arr2[j] });
        j++;
      }
    }

    return diff;
  }

  /**
   * Longest Common Subsequence
   */
  longestCommonSubsequence(arr1, arr2) {
    const m = arr1.length;
    const n = arr2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (arr1[i - 1] === arr2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find LCS
    const lcs = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (arr1[i - 1] === arr2[j - 1]) {
        lcs.unshift(arr1[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return lcs;
  }

  /**
   * Render one side of the diff
   */
  renderDiffSide(diff, side) {
    let html = '<pre class="diff-text">';

    for (const item of diff) {
      if (side === 'left') {
        if (item.type === 'remove') {
          html += `<span class="diff-removed">${this.escapeHtml(item.value)}</span>`;
        } else if (item.type === 'same') {
          html += this.escapeHtml(item.value);
        }
        // Skip 'add' items for left side
      } else {
        if (item.type === 'add') {
          html += `<span class="diff-added">${this.escapeHtml(item.value)}</span>`;
        } else if (item.type === 'same') {
          html += this.escapeHtml(item.value);
        }
        // Skip 'remove' items for right side
      }
    }

    html += '</pre>';
    return html;
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Close button
    document.getElementById('compareClose')?.addEventListener('click', () => {
      this.close();
    });

    document.getElementById('closeCompareBtn')?.addEventListener('click', () => {
      this.close();
    });

    // Version selectors
    document.getElementById('version1Select')?.addEventListener('change', (e) => {
      this.selectedVersions[0] = parseInt(e.target.value);
      this.updateComparison();
    });

    document.getElementById('version2Select')?.addEventListener('change', (e) => {
      this.selectedVersions[1] = parseInt(e.target.value);
      this.updateComparison();
    });

    // Make Active buttons
    document.querySelectorAll('[data-action="activate"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const versionId = e.currentTarget.dataset.versionId;
        await this.handleActivateVersion(versionId);
      });
    });

    // Click outside to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // ESC key to close
    const escHandler = (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  /**
   * Update comparison content when version selection changes
   */
  updateComparison() {
    const content = document.getElementById('comparisonContent');
    if (content) {
      content.innerHTML = this.renderComparison();

      // Re-attach activate button listeners
      document.querySelectorAll('[data-action="activate"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const versionId = e.currentTarget.dataset.versionId;
          await this.handleActivateVersion(versionId);
        });
      });
    }
  }

  /**
   * Handle version activation
   */
  async handleActivateVersion(versionId) {
    try {
      await this.api.activate(versionId);
      this.toast.success('Version activated successfully');

      // Refresh versions data
      this.versions = await this.api.getByName(this.promptName);
      this.updateComparison();

      // Emit event for parent to refresh
      window.dispatchEvent(new CustomEvent('prompt-version-changed', {
        detail: { promptName: this.promptName }
      }));
    } catch (error) {
      console.error('Failed to activate version:', error);
      this.toast.error(`Failed to activate: ${error.message}`);
    }
  }

  /**
   * Format number with commas
   */
  formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toLocaleString();
  }

  /**
   * Format date
   */
  formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
