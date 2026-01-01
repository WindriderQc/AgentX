/**
 * PerformanceMetricsDashboard Component
 * Displays real-time performance metrics for prompts
 * Shows impressions, positive/negative rates, trending indicators
 */

export class PerformanceMetricsDashboard {
  constructor(containerId, state) {
    this.container = document.getElementById(containerId);
    this.state = state;
    this.isCollapsed = false;
    this.autoRefresh = false;
    this.refreshInterval = null;
    this.selectedTimeRange = '7d';
    this.selectedModel = 'all'; // New: model filter
    this.metricsData = null;
    this.loading = false;
    this.availableModels = []; // New: list of available models

    this.init();
  }

  /**
   * Initialize the dashboard
   */
  init() {
    if (!this.container) {
      console.error('PerformanceMetricsDashboard: Container not found');
      return;
    }

    this.render();
    this.attachEventListeners();
    this.loadMetrics();
  }

  /**
   * Render the dashboard structure
   */
  render() {
    const html = `
      <div class="metrics-dashboard ${this.isCollapsed ? 'collapsed' : ''}">
        <div class="dashboard-header">
          <div class="header-left">
            <h3>
              <i class="fas fa-chart-line"></i>
              Performance Metrics
            </h3>
            <span class="metrics-subtitle">Real-time prompt analytics</span>
          </div>
          <div class="header-actions">
            <select id="metricsModelFilter" class="model-filter-selector" title="Filter by model">
              <option value="all">All Models</option>
              ${this.availableModels.map(model =>
                `<option value="${this.escapeHtml(model)}" ${this.selectedModel === model ? 'selected' : ''}>${this.escapeHtml(model)}</option>`
              ).join('')}
            </select>
            <select id="metricsTimeRange" class="time-range-selector">
              <option value="7d" ${this.selectedTimeRange === '7d' ? 'selected' : ''}>Last 7 days</option>
              <option value="30d" ${this.selectedTimeRange === '30d' ? 'selected' : ''}>Last 30 days</option>
              <option value="90d" ${this.selectedTimeRange === '90d' ? 'selected' : ''}>Last 90 days</option>
              <option value="all" ${this.selectedTimeRange === 'all' ? 'selected' : ''}>All time</option>
            </select>
            <button id="metricsRefreshBtn" class="btn-icon" title="Refresh metrics">
              <i class="fas fa-sync-alt"></i>
            </button>
            <label class="auto-refresh-toggle" title="Auto-refresh every 30s">
              <input type="checkbox" id="autoRefreshToggle" ${this.autoRefresh ? 'checked' : ''} />
              <span class="toggle-label">Auto</span>
            </label>
            <button id="metricsCollapseBtn" class="btn-icon" title="Collapse/Expand">
              <i class="fas ${this.isCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
            </button>
          </div>
        </div>

        <div class="dashboard-content" ${this.isCollapsed ? 'style="display: none;"' : ''}>
          <div id="metricsLoading" class="metrics-loading" style="display: none;">
            <div class="spinner-small"></div>
            <span>Loading metrics...</span>
          </div>

          <div id="metricsError" class="metrics-error" style="display: none;">
            <i class="fas fa-exclamation-triangle"></i>
            <span id="metricsErrorMessage">Failed to load metrics</span>
          </div>

          <div id="metricsContent" class="metrics-content">
            <!-- Metric cards will be rendered here -->
          </div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Collapse/Expand button
    const collapseBtn = document.getElementById('metricsCollapseBtn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => this.toggleCollapse());
    }

    // Refresh button
    const refreshBtn = document.getElementById('metricsRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.loadMetrics());
    }

    // Auto-refresh toggle
    const autoRefreshToggle = document.getElementById('autoRefreshToggle');
    if (autoRefreshToggle) {
      autoRefreshToggle.addEventListener('change', (e) => {
        this.autoRefresh = e.target.checked;
        this.handleAutoRefresh();
      });
    }

    // Time range selector
    const timeRangeSelector = document.getElementById('metricsTimeRange');
    if (timeRangeSelector) {
      timeRangeSelector.addEventListener('change', (e) => {
        this.selectedTimeRange = e.target.value;
        this.loadMetrics();
      });
    }

    // Model filter selector
    const modelFilterSelector = document.getElementById('metricsModelFilter');
    if (modelFilterSelector) {
      modelFilterSelector.addEventListener('change', (e) => {
        this.selectedModel = e.target.value;
        this.loadMetrics();
      });
    }
  }

  /**
   * Toggle collapse state
   */
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    const dashboard = this.container.querySelector('.metrics-dashboard');
    const content = this.container.querySelector('.dashboard-content');
    const icon = document.querySelector('#metricsCollapseBtn i');

    if (this.isCollapsed) {
      dashboard.classList.add('collapsed');
      content.style.display = 'none';
      icon.className = 'fas fa-chevron-down';
    } else {
      dashboard.classList.remove('collapsed');
      content.style.display = 'block';
      icon.className = 'fas fa-chevron-up';
    }
  }

  /**
   * Handle auto-refresh toggle
   */
  handleAutoRefresh() {
    if (this.autoRefresh) {
      // Start auto-refresh (every 30 seconds)
      this.refreshInterval = setInterval(() => {
        this.loadMetrics();
      }, 30000);
    } else {
      // Stop auto-refresh
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
    }
  }

  /**
   * Get date range for API call
   */
  getDateRange() {
    const to = new Date();
    let from;

    switch (this.selectedTimeRange) {
      case '7d':
        from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case 'all':
        from = new Date('2020-01-01'); // Far past date
        break;
      default:
        from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    return { from: from.toISOString(), to: to.toISOString() };
  }

  /**
   * Load metrics from analytics API
   */
  async loadMetrics() {
    if (this.loading) return;

    this.loading = true;
    this.showLoading(true);
    this.hideError();

    try {
      // Get days from selected time range
      let days = 7;
      switch (this.selectedTimeRange) {
        case '7d': days = 7; break;
        case '30d': days = 30; break;
        case '90d': days = 90; break;
        case 'all': days = 3650; break; // ~10 years
      }

      // Build API URL with model filter
      let apiUrl = `/api/analytics/prompt-metrics?days=${days}`;
      if (this.selectedModel && this.selectedModel !== 'all') {
        apiUrl += `&model=${encodeURIComponent(this.selectedModel)}`;
      }

      // Fetch prompt metrics with model breakdown
      const response = await fetch(apiUrl, { credentials: 'include' });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      if (result.status !== 'success') {
        throw new Error(result.message || 'Failed to load metrics');
      }

      this.metricsData = result.data;

      // Fetch trending data
      let trendingUrl = `/api/analytics/trending?days=${days}`;
      if (this.selectedModel && this.selectedModel !== 'all') {
        trendingUrl += `&model=${encodeURIComponent(this.selectedModel)}`;
      }

      try {
        const trendingResponse = await fetch(trendingUrl, { credentials: 'include' });
        if (trendingResponse.ok) {
          const trendingResult = await trendingResponse.json();
          if (trendingResult.status === 'success') {
            this.trendingData = trendingResult.data.trending;
          }
        }
      } catch (err) {
        console.warn('Failed to load trending data:', err);
        this.trendingData = null;
      }

      // Extract available models from data
      this.extractAvailableModels();

      this.renderMetrics();
    } catch (error) {
      console.error('Failed to load metrics:', error);
      this.showError(error.message);
    } finally {
      this.loading = false;
      this.showLoading(false);
    }
  }

  /**
   * Extract unique models from metrics data
   */
  extractAvailableModels() {
    if (!this.metricsData || !this.metricsData.prompts) return;

    const models = new Set();
    this.metricsData.prompts.forEach(prompt => {
      if (prompt.byModel) {
        prompt.byModel.forEach(modelData => {
          if (modelData.model) {
            models.add(modelData.model);
          }
        });
      }
    });

    this.availableModels = Array.from(models).sort();

    // Update model filter dropdown if it exists
    const modelFilter = document.getElementById('metricsModelFilter');
    if (modelFilter && this.availableModels.length > 0) {
      // Preserve current selection
      const currentSelection = this.selectedModel;

      // Rebuild options
      modelFilter.innerHTML = '<option value="all">All Models</option>' +
        this.availableModels.map(model =>
          `<option value="${this.escapeHtml(model)}" ${currentSelection === model ? 'selected' : ''}>${this.escapeHtml(model)}</option>`
        ).join('');
    }
  }

  /**
   * Render metrics cards
   */
  renderMetrics() {
    const content = document.getElementById('metricsContent');
    if (!content || !this.metricsData) return;

    const { prompts } = this.metricsData;

    // If no data, show empty state
    if (!prompts || prompts.length === 0) {
      content.innerHTML = `
        <div class="metrics-empty">
          <i class="fas fa-chart-line"></i>
          <p>No metrics available for the selected time range</p>
          <small>Metrics will appear once prompts are used and receive feedback</small>
        </div>
      `;
      return;
    }

    // Render metric cards using new data structure
    const cardsHtml = prompts.map(prompt =>
      this.renderMetricCard(prompt)
    ).join('');

    content.innerHTML = `
      <div class="metrics-grid">
        ${cardsHtml}
      </div>
    `;

    // Attach click handlers for detailed view
    content.querySelectorAll('.metric-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.metric-actions') && !e.target.closest('.model-breakdown-toggle')) {
          const promptName = card.dataset.promptName;
          this.viewDetailedAnalytics(promptName);
        }
      });
    });

    // Attach model breakdown toggle handlers
    content.querySelectorAll('.model-breakdown-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = e.target.closest('.metric-card');
        const breakdown = card.querySelector('.model-breakdown');
        const icon = toggle.querySelector('i');

        if (breakdown.style.display === 'none') {
          breakdown.style.display = 'block';
          icon.className = 'fas fa-chevron-up';
        } else {
          breakdown.style.display = 'none';
          icon.className = 'fas fa-chevron-down';
        }
      });
    });
  }

  /**
   * Aggregate breakdown data by prompt name
   */
  aggregateByPromptName(breakdown) {
    const groups = {};

    breakdown.forEach(item => {
      const name = item.promptName || 'unknown';

      if (!groups[name]) {
        groups[name] = {
          totalFeedback: 0,
          positive: 0,
          negative: 0,
          versions: []
        };
      }

      groups[name].totalFeedback += item.total;
      groups[name].positive += item.positive;
      groups[name].negative += item.negative;
      groups[name].versions.push(item);
    });

    // Calculate positive rate for each group
    Object.values(groups).forEach(group => {
      group.positiveRate = group.totalFeedback > 0
        ? group.positive / group.totalFeedback
        : 0;
    });

    return groups;
  }

  /**
   * Render a single metric card
   */
  renderMetricCard(prompt) {
    const { promptName, promptVersion, overall, byModel } = prompt;
    const positiveRate = overall.positiveRate;
    const negativeRate = 1 - positiveRate;

    // Calculate trending
    const trending = this.calculateTrending(prompt);

    // Determine status color
    let statusClass = 'good';
    if (positiveRate < 0.5) statusClass = 'poor';
    else if (positiveRate < 0.7) statusClass = 'caution';

    // Render model breakdown section
    const modelBreakdownHtml = byModel && byModel.length > 0 ? `
      <div class="model-breakdown" style="display: none;">
        <div class="breakdown-header">
          <i class="fas fa-server"></i>
          <span>Performance by Model</span>
        </div>
        <div class="breakdown-list">
          ${byModel.map(modelData => {
            const modelPositiveRate = modelData.positiveRate;
            let modelStatus = 'good';
            if (modelPositiveRate < 0.5) modelStatus = 'poor';
            else if (modelPositiveRate < 0.7) modelStatus = 'caution';

            return `
              <div class="breakdown-item ${modelStatus}">
                <div class="breakdown-model">
                  <i class="fas fa-cube"></i>
                  <span>${this.escapeHtml(modelData.model)}</span>
                </div>
                <div class="breakdown-metrics">
                  <span class="breakdown-rate ${modelStatus}">${(modelPositiveRate * 100).toFixed(1)}%</span>
                  <span class="breakdown-count">${modelData.positive}/${modelData.total}</span>
                </div>
                <div class="breakdown-bar">
                  <div class="bar-positive" style="width: ${modelPositiveRate * 100}%"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    ` : '';

    return `
      <div class="metric-card ${statusClass}" data-prompt-name="${this.escapeHtml(promptName)}">
        <div class="metric-card-header">
          <div class="metric-name">
            <i class="fas fa-code"></i>
            <span>${this.escapeHtml(promptName)} <span class="version-badge">v${promptVersion}</span></span>
          </div>
          <div class="metric-status">
            <span class="status-badge ${statusClass}">
              ${positiveRate >= 0.7 ? 'Healthy' : positiveRate >= 0.5 ? 'Fair' : 'Poor'}
            </span>
          </div>
        </div>

        <div class="metric-card-body">
          <div class="metric-row">
            <div class="metric-item">
              <div class="metric-label">
                <i class="fas fa-eye"></i>
                Total Feedback
              </div>
              <div class="metric-value">${this.formatNumber(overall.total)}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">
                <i class="fas fa-thumbs-up"></i>
                Positive Rate
              </div>
              <div class="metric-value positive">
                ${(positiveRate * 100).toFixed(1)}%
                ${trending ? `
                  <span class="trending-indicator trending-${trending.color}" title="${trending.tooltip}">
                    <i class="fas ${trending.icon}"></i>
                    <span class="trending-label">${trending.label}</span>
                  </span>
                ` : ''}
              </div>
            </div>
          </div>

          <div class="metric-row">
            <div class="metric-item">
              <div class="metric-label">
                <i class="fas fa-check-circle"></i>
                Positive
              </div>
              <div class="metric-value">${this.formatNumber(overall.positive)}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">
                <i class="fas fa-times-circle"></i>
                Negative
              </div>
              <div class="metric-value">${this.formatNumber(overall.negative)}</div>
            </div>
          </div>

          <!-- Progress bar -->
          <div class="feedback-bar">
            <div class="feedback-positive" style="width: ${positiveRate * 100}%"></div>
            <div class="feedback-negative" style="width: ${negativeRate * 100}%"></div>
          </div>

          <!-- Model breakdown toggle -->
          ${byModel && byModel.length > 1 ? `
            <div class="metric-footer">
              <button class="model-breakdown-toggle">
                <i class="fas fa-server"></i>
                <span>${byModel.length} models</span>
                <i class="fas fa-chevron-down"></i>
              </button>
            </div>
          ` : byModel && byModel.length === 1 ? `
            <div class="metric-footer">
              <span class="single-model">
                <i class="fas fa-cube"></i>
                ${this.escapeHtml(byModel[0].model)}
              </span>
            </div>
          ` : ''}

          <!-- Model breakdown section -->
          ${modelBreakdownHtml}
        </div>

        <div class="metric-card-actions">
          <button class="btn-sm ghost" onclick="event.stopPropagation(); window.location.href='/analytics.html?promptName=${encodeURIComponent(promptName)}'">
            <i class="fas fa-chart-bar"></i>
            Details
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Calculate trending indicator using trending API data
   * Compares current period vs previous period
   */
  calculateTrending(data) {
    // If no trending data available, return null
    if (!this.trendingData || !Array.isArray(this.trendingData)) {
      return null;
    }

    // Find matching trending data for this prompt
    const trending = this.trendingData.find(item =>
      item.promptName === data.promptName &&
      item.promptVersion === data.promptVersion
    );

    if (!trending) {
      return null;
    }

    // Return trending indicator based on status
    switch (trending.status) {
      case 'improving':
        return {
          direction: 'up',
          icon: 'fa-arrow-up',
          color: 'success',
          label: `+${(trending.percentChange || 0).toFixed(1)}%`,
          tooltip: `Improving: ${(trending.delta * 100).toFixed(1)}% increase in positive rate`
        };
      case 'declining':
        return {
          direction: 'down',
          icon: 'fa-arrow-down',
          color: 'danger',
          label: `${(trending.percentChange || 0).toFixed(1)}%`,
          tooltip: `Declining: ${Math.abs(trending.delta * 100).toFixed(1)}% decrease in positive rate`
        };
      case 'stable':
        return {
          direction: 'stable',
          icon: 'fa-minus',
          color: 'muted',
          label: 'Stable',
          tooltip: 'Performance stable compared to previous period'
        };
      case 'new':
        return {
          direction: 'new',
          icon: 'fa-sparkles',
          color: 'info',
          label: 'New',
          tooltip: 'New prompt with no previous data'
        };
      default:
        return null;
    }
  }

  /**
   * View detailed analytics for a prompt
   */
  viewDetailedAnalytics(promptName) {
    window.location.href = `/analytics.html?promptName=${encodeURIComponent(promptName)}`;
  }

  /**
   * Show loading state
   */
  showLoading(show) {
    const loading = document.getElementById('metricsLoading');
    const content = document.getElementById('metricsContent');

    if (loading && content) {
      loading.style.display = show ? 'flex' : 'none';
      content.style.display = show ? 'none' : 'block';
    }

    // Update refresh button
    const refreshBtn = document.querySelector('#metricsRefreshBtn i');
    if (refreshBtn) {
      if (show) {
        refreshBtn.classList.add('fa-spin');
      } else {
        refreshBtn.classList.remove('fa-spin');
      }
    }
  }

  /**
   * Show error state
   */
  showError(message) {
    const errorDiv = document.getElementById('metricsError');
    const errorMessage = document.getElementById('metricsErrorMessage');
    const content = document.getElementById('metricsContent');

    if (errorDiv && errorMessage && content) {
      errorDiv.style.display = 'flex';
      errorMessage.textContent = message;
      content.style.display = 'none';
    }
  }

  /**
   * Hide error state
   */
  hideError() {
    const errorDiv = document.getElementById('metricsError');
    if (errorDiv) {
      errorDiv.style.display = 'none';
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
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Destroy component and cleanup
   */
  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
