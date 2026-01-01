/**
 * ConversationReviewModal Component
 * Displays negative feedback conversations for a specific prompt version
 * Allows filtering, export, and triggering AI-powered analysis
 */

export class ConversationReviewModal {
  constructor(toast) {
    this.toast = toast;
    this.overlay = null;
    this.isOpen = false;
    this.promptName = null;
    this.promptVersion = null;
    this.conversations = [];
    this.filteredConversations = [];
    this.selectedFilter = 'all'; // all, week, month
    this.loading = false;
  }

  /**
   * Open modal to review conversations for a prompt
   * @param {string} promptName - Name of the prompt
   * @param {number} promptVersion - Version number of the prompt
   */
  async open(promptName, promptVersion) {
    if (this.isOpen) return;

    this.promptName = promptName;
    this.promptVersion = promptVersion;
    this.selectedFilter = 'all';
    
    this.render();
    this.isOpen = true;
    
    // Load conversations after rendering
    await this.loadConversations();
  }

  /**
   * Close the modal
   */
  close() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.isOpen = false;
    this.promptName = null;
    this.promptVersion = null;
    this.conversations = [];
    this.filteredConversations = [];
  }

  /**
   * Load conversations from API
   */
  async loadConversations() {
    if (this.loading) return;

    this.loading = true;
    this.showLoading(true);

    try {
      const params = new URLSearchParams({
        promptName: this.promptName,
        promptVersion: this.promptVersion.toString(),
        minFeedback: '-1', // Negative feedback only
        limit: '50'
      });

      const response = await fetch(`/api/dataset/conversations?${params}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      if (result.status !== 'success') {
        throw new Error(result.message || 'Failed to load conversations');
      }

      this.conversations = result.data.conversations || [];
      this.applyFilter();
      this.renderConversationList();
    } catch (error) {
      console.error('Failed to load conversations:', error);
      this.toast.error(`Failed to load conversations: ${error.message}`);
      this.showError(error.message);
    } finally {
      this.loading = false;
      this.showLoading(false);
    }
  }

  /**
   * Apply time-based filter to conversations
   */
  applyFilter() {
    const now = new Date();
    let cutoffDate;

    switch (this.selectedFilter) {
      case 'week':
        cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        cutoffDate = null;
    }

    if (cutoffDate) {
      this.filteredConversations = this.conversations.filter(conv => 
        new Date(conv.createdAt) >= cutoffDate
      );
    } else {
      this.filteredConversations = [...this.conversations];
    }
  }

  /**
   * Render the modal
   */
  render() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay conversation-review-overlay';
    this.overlay.innerHTML = `
      <div class="modal-container conversation-review-modal">
        <div class="modal-header">
          <h2>
            <i class="fas fa-comments"></i>
            Review Negative Conversations
          </h2>
          <button class="modal-close" id="reviewClose" title="Close">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="modal-subheader">
          <div class="prompt-info">
            <span class="prompt-name">${this.escapeHtml(this.promptName)}</span>
            <span class="prompt-version">v${this.promptVersion}</span>
          </div>
          <div class="filter-tabs">
            <button class="filter-tab ${this.selectedFilter === 'all' ? 'active' : ''}" data-filter="all">
              <i class="fas fa-globe"></i> All Time
            </button>
            <button class="filter-tab ${this.selectedFilter === 'week' ? 'active' : ''}" data-filter="week">
              <i class="fas fa-calendar-week"></i> This Week
            </button>
            <button class="filter-tab ${this.selectedFilter === 'month' ? 'active' : ''}" data-filter="month">
              <i class="fas fa-calendar-alt"></i> Last 30 Days
            </button>
          </div>
        </div>

        <div class="modal-body">
          <div id="conversationLoading" class="loading-state" style="display: none;">
            <div class="spinner"></div>
            <p>Loading conversations...</p>
          </div>

          <div id="conversationError" class="error-state" style="display: none;">
            <i class="fas fa-exclamation-triangle"></i>
            <p id="errorMessage">Failed to load conversations</p>
          </div>

          <div id="conversationList" class="conversation-list">
            <!-- Conversations will be rendered here -->
          </div>
        </div>

        <div class="modal-footer">
          <div class="footer-left">
            <span id="conversationCount" class="conversation-count">—</span>
          </div>
          <div class="footer-actions">
            <button class="btn-secondary" id="exportConversationsBtn">
              <i class="fas fa-download"></i> Export JSON
            </button>
            <button class="btn-primary" id="analyzeWithLlmBtn">
              <i class="fas fa-robot"></i> Analyze with LLM
            </button>
            <button class="btn-secondary" id="closeReviewBtn">
              <i class="fas fa-times"></i> Close
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    this.attachEventListeners();
  }

  /**
   * Render conversation list
   */
  renderConversationList() {
    const container = document.getElementById('conversationList');
    if (!container) return;

    const countEl = document.getElementById('conversationCount');
    if (countEl) {
      countEl.textContent = `${this.filteredConversations.length} conversations`;
    }

    if (this.filteredConversations.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-inbox"></i>
          <h3>No Conversations Found</h3>
          <p>No negative feedback conversations for this prompt version in the selected time range.</p>
        </div>
      `;
      return;
    }

    const conversationsHtml = this.filteredConversations.map((conv, index) => 
      this.renderConversationCard(conv, index)
    ).join('');

    container.innerHTML = conversationsHtml;
  }

  /**
   * Render a single conversation card
   */
  renderConversationCard(conversation, index) {
    const date = new Date(conversation.createdAt).toLocaleString();
    const model = conversation.model || 'Unknown';
    
    // Extract user messages and assistant responses
    const messages = conversation.messages || [];
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    
    // Find messages with negative feedback
    const negativeMessages = messages.filter(m => m.feedback?.rating === -1);
    
    return `
      <div class="conversation-card" data-index="${index}">
        <div class="card-header">
          <div class="card-meta">
            <span class="card-date">
              <i class="fas fa-clock"></i> ${date}
            </span>
            <span class="card-model">
              <i class="fas fa-microchip"></i> ${this.escapeHtml(model)}
            </span>
            <span class="card-messages">
              <i class="fas fa-comments"></i> ${messages.length} messages
            </span>
            <span class="card-negative">
              <i class="fas fa-thumbs-down"></i> ${negativeMessages.length} negative
            </span>
          </div>
          <button class="expand-btn" data-index="${index}">
            <i class="fas fa-chevron-down"></i>
          </button>
        </div>
        
        <div class="card-preview">
          ${userMessages.length > 0 ? `
            <div class="preview-message">
              <strong>User:</strong> ${this.truncateText(userMessages[0].content, 150)}
            </div>
          ` : ''}
          ${assistantMessages.length > 0 ? `
            <div class="preview-message">
              <strong>Assistant:</strong> ${this.truncateText(assistantMessages[0].content, 150)}
            </div>
          ` : ''}
        </div>

        <div class="card-details" id="details-${index}" style="display: none;">
          <div class="message-thread">
            ${messages.map(msg => this.renderMessage(msg)).join('')}
          </div>
          ${negativeMessages.length > 0 ? `
            <div class="feedback-section">
              <h4><i class="fas fa-comment-alt"></i> Negative Feedback</h4>
              ${negativeMessages.map(msg => `
                <div class="feedback-item">
                  ${msg.feedback.comment ? `
                    <p><strong>Comment:</strong> ${this.escapeHtml(msg.feedback.comment)}</p>
                  ` : '<p><em>No comment provided</em></p>'}
                  <small>Rating: ${msg.feedback.rating}</small>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render a single message
   */
  renderMessage(message) {
    const roleClass = message.role === 'user' ? 'user-message' : 'assistant-message';
    const icon = message.role === 'user' ? 'fa-user' : 'fa-robot';
    const feedbackBadge = message.feedback?.rating ? `
      <span class="feedback-badge ${message.feedback.rating === 1 ? 'positive' : 'negative'}">
        <i class="fas fa-thumbs-${message.feedback.rating === 1 ? 'up' : 'down'}"></i>
      </span>
    ` : '';

    return `
      <div class="message ${roleClass}">
        <div class="message-header">
          <i class="fas ${icon}"></i>
          <strong>${message.role === 'user' ? 'User' : 'Assistant'}</strong>
          ${feedbackBadge}
        </div>
        <div class="message-content">${this.escapeHtml(message.content)}</div>
      </div>
    `;
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Close buttons
    const closeButtons = [
      this.overlay.querySelector('#reviewClose'),
      this.overlay.querySelector('#closeReviewBtn')
    ];
    closeButtons.forEach(btn => {
      if (btn) {
        btn.addEventListener('click', () => this.close());
      }
    });

    // Click outside to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Filter tabs
    this.overlay.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.selectedFilter = tab.dataset.filter;
        
        // Update active state
        this.overlay.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Re-filter and render
        this.applyFilter();
        this.renderConversationList();
      });
    });

    // Expand/collapse conversation details
    this.overlay.addEventListener('click', (e) => {
      const expandBtn = e.target.closest('.expand-btn');
      if (expandBtn) {
        const index = expandBtn.dataset.index;
        const details = document.getElementById(`details-${index}`);
        const icon = expandBtn.querySelector('i');
        
        if (details) {
          const isExpanded = details.style.display !== 'none';
          details.style.display = isExpanded ? 'none' : 'block';
          icon.className = isExpanded ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
        }
      }
    });

    // Export button
    const exportBtn = this.overlay.querySelector('#exportConversationsBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportConversations());
    }

    // Analyze with LLM button
    const analyzeBtn = this.overlay.querySelector('#analyzeWithLlmBtn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', () => this.analyzeWithLlm());
    }
  }

  /**
   * Export conversations as JSON
   */
  exportConversations() {
    try {
      const data = {
        promptName: this.promptName,
        promptVersion: this.promptVersion,
        exportDate: new Date().toISOString(),
        filter: this.selectedFilter,
        count: this.filteredConversations.length,
        conversations: this.filteredConversations
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `conversations-${this.promptName}-v${this.promptVersion}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.toast.success(`Exported ${this.filteredConversations.length} conversations`);
    } catch (error) {
      console.error('Export failed:', error);
      this.toast.error('Failed to export conversations');
    }
  }

  /**
   * Analyze conversations with LLM
   * Dispatches event for PromptImprovementWizard to handle
   */
  analyzeWithLlm() {
    if (this.filteredConversations.length === 0) {
      this.toast.error('No conversations to analyze');
      return;
    }

    // Close this modal and trigger improvement wizard
    this.close();

    const event = new CustomEvent('improve-prompt', {
      detail: {
        promptName: this.promptName,
        promptVersion: this.promptVersion,
        conversations: this.filteredConversations
      }
    });
    document.dispatchEvent(event);
  }

  /**
   * Show/hide loading state
   */
  showLoading(show) {
    const loadingEl = document.getElementById('conversationLoading');
    if (loadingEl) {
      loadingEl.style.display = show ? 'flex' : 'none';
    }
  }

  /**
   * Show error state
   */
  showError(message) {
    const errorEl = document.getElementById('conversationError');
    const messageEl = document.getElementById('errorMessage');
    if (errorEl && messageEl) {
      messageEl.textContent = message;
      errorEl.style.display = 'flex';
    }
  }

  /**
   * Truncate text with ellipsis
   */
  truncateText(text, maxLength) {
    if (!text) return '';
    const escaped = this.escapeHtml(text);
    return escaped.length > maxLength 
      ? escaped.substring(0, maxLength) + '...' 
      : escaped;
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
