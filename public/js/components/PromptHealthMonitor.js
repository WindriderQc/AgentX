/**
 * PromptHealthMonitor Component
 * Monitors prompt health and alerts for low-performing prompts
 * Triggers feedback-driven improvement workflows
 */

export class PromptHealthMonitor {
  constructor(containerId, toast) {
    this.container = document.getElementById(containerId);
    this.toast = toast;
    this.lowPerformingPrompts = [];
    this.loading = false;
    this.isDismissed = false;
    this.threshold = 0.70; // Alert threshold for positive rate
    this.minFeedbackCount = 50; // Minimum feedback to consider

    this.init();
  }

  /**
   * Initialize the monitor
   */
  init() {
    if (!this.container) {
      console.error('PromptHealthMonitor: Container not found');
      return;
    }

    this.loadHealthData();

    // Listen for prompt updates to refresh
    document.addEventListener('prompt-version-changed', () => {
      this.loadHealthData();
    });
  }

  /**
   * Load prompt health data from analytics API
   */
  async loadHealthData() {
    if (this.loading) return;

    this.loading = true;

    try {
      // Calculate date range for last 7 days
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Fetch feedback summary with threshold parameter
      const params = new URLSearchParams({
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        threshold: this.threshold.toString()
      });

      const response = await fetch(`/api/analytics/feedback/summary?${params}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      if (result.status !== 'success') {
        throw new Error(result.message || 'Failed to load health data');
      }

      // Extract low performing prompts (already filtered by API with threshold)
      const { lowPerformingPrompts = [] } = result.data;
      
      // Additional client-side filter to ensure minimum feedback count
      this.lowPerformingPrompts = lowPerformingPrompts.filter(p => 
        p.total >= this.minFeedbackCount
      ).sort((a, b) => a.rate - b.rate); // Sort by rate ascending (worst first)

      this.render();
    } catch (error) {
      console.error('Failed to load prompt health data:', error);
      // Silently fail - this is a non-critical monitoring feature
    } finally {
      this.loading = false;
    }
  }

  /**
   * Render the health alert banner
   */
  render() {
    if (!this.container) return;

    // Don't show if dismissed or no issues found
    if (this.isDismissed || this.lowPerformingPrompts.length === 0) {
      this.container.innerHTML = '';
      this.container.style.display = 'none';
      return;
    }

    const promptCount = this.lowPerformingPrompts.length;
    const worstPrompt = this.lowPerformingPrompts[0]; // Assuming sorted by rate
    const worstRate = (worstPrompt.rate * 100).toFixed(1);

    const html = `
      <div class="prompt-health-alert" role="alert">
        <div class="alert-icon">
          <i class="fas fa-exclamation-triangle"></i>
        </div>
        <div class="alert-content">
          <div class="alert-header">
            <h4>
              <i class="fas fa-heartbeat"></i>
              Prompt Health Alert
            </h4>
            <button class="dismiss-btn" title="Dismiss alert">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <p class="alert-message">
            <strong>${promptCount}</strong> ${promptCount === 1 ? 'prompt is' : 'prompts are'} underperforming 
            (positive rate below ${(this.threshold * 100).toFixed(0)}%).
            ${worstPrompt ? `Worst: <strong>${this.escapeHtml(worstPrompt.promptName)}</strong> v${worstPrompt.promptVersion} at ${worstRate}%` : ''}
          </p>
          <div class="alert-actions">
            <button class="btn-review-conversations" data-prompt-name="${this.escapeHtml(worstPrompt.promptName)}" data-prompt-version="${worstPrompt.promptVersion}">
              <i class="fas fa-search"></i> Review Conversations
            </button>
            <button class="btn-create-improved" data-prompt-name="${this.escapeHtml(worstPrompt.promptName)}" data-prompt-version="${worstPrompt.promptVersion}">
              <i class="fas fa-magic"></i> Create Improved Version
            </button>
            <button class="btn-view-all-issues">
              <i class="fas fa-list"></i> View All (${promptCount})
            </button>
          </div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
    this.container.style.display = 'block';

    // Attach event listeners
    this.attachEventListeners();
  }

  /**
   * Attach event listeners to alert buttons
   */
  attachEventListeners() {
    // Dismiss button
    const dismissBtn = this.container.querySelector('.dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        this.dismiss();
      });
    }

    // Review conversations button
    const reviewBtn = this.container.querySelector('.btn-review-conversations');
    if (reviewBtn) {
      reviewBtn.addEventListener('click', () => {
        const promptName = reviewBtn.dataset.promptName;
        const promptVersion = parseInt(reviewBtn.dataset.promptVersion);
        this.handleReviewConversations(promptName, promptVersion);
      });
    }

    // Create improved version button
    const improveBtn = this.container.querySelector('.btn-create-improved');
    if (improveBtn) {
      improveBtn.addEventListener('click', () => {
        const promptName = improveBtn.dataset.promptName;
        const promptVersion = parseInt(improveBtn.dataset.promptVersion);
        this.handleCreateImproved(promptName, promptVersion);
      });
    }

    // View all issues button
    const viewAllBtn = this.container.querySelector('.btn-view-all-issues');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => {
        this.handleViewAllIssues();
      });
    }
  }

  /**
   * Dismiss the alert banner
   */
  dismiss() {
    this.isDismissed = true;
    this.container.style.display = 'none';
    this.toast.show('Alert dismissed. Refresh page to see it again.', 'info');
  }

  /**
   * Handle "Review Conversations" button click
   * Dispatches event for ConversationReviewModal to handle
   */
  handleReviewConversations(promptName, promptVersion) {
    const event = new CustomEvent('review-prompt-conversations', {
      detail: { promptName, promptVersion }
    });
    document.dispatchEvent(event);
  }

  /**
   * Handle "Create Improved Version" button click
   * Dispatches event for PromptImprovementWizard to handle
   */
  handleCreateImproved(promptName, promptVersion) {
    const event = new CustomEvent('improve-prompt', {
      detail: { promptName, promptVersion }
    });
    document.dispatchEvent(event);
  }

  /**
   * Handle "View All Issues" button click
   * Shows modal with all low-performing prompts
   */
  handleViewAllIssues() {
    const event = new CustomEvent('view-all-prompt-issues', {
      detail: { prompts: this.lowPerformingPrompts }
    });
    document.dispatchEvent(event);
  }

  /**
   * Refresh health data
   */
  refresh() {
    this.isDismissed = false;
    this.loadHealthData();
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
