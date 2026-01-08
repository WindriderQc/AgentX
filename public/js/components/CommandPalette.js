/**
 * Command Palette Component
 *
 * A fuzzy-search command palette for quick access to AgentX features.
 * Features:
 * - Fuzzy search with character-in-order matching
 * - Keyboard navigation (Up/Down/Enter/Esc)
 * - Recent commands history (localStorage)
 * - Command execution with callbacks
 * - Category grouping and icons
 *
 * Usage:
 *   const palette = new CommandPalette();
 *   palette.registerCommand({
 *     id: 'new-chat',
 *     name: 'New Chat',
 *     description: 'Start a new conversation',
 *     category: 'chat',
 *     icon: 'fa-plus',
 *     handler: () => newChat()
 *   });
 *   palette.open();
 */

export class CommandPalette {
  constructor() {
    this.commands = new Map(); // Map<id, command>
    this.isOpen = false;
    this.selectedIndex = 0;
    this.filteredCommands = [];
    this.recentCommands = this.loadRecentCommands();
    this.maxRecentCommands = 5;

    // DOM elements (created on first open)
    this.overlay = null;
    this.searchInput = null;
    this.resultsList = null;

    // Bind methods
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleSearchInput = this.handleSearchInput.bind(this);
    this.handleCommandClick = this.handleCommandClick.bind(this);
  }

  /**
   * Register a command
   *
   * @param {Object} command - Command object
   * @param {string} command.id - Unique command ID
   * @param {string} command.name - Display name
   * @param {string} command.description - Command description
   * @param {string} command.category - Category for grouping
   * @param {string} command.icon - Font Awesome icon class
   * @param {Function} command.handler - Handler function
   * @param {string} command.shortcut - Keyboard shortcut (optional)
   */
  registerCommand(command) {
    if (!command.id || !command.name || !command.handler) {
      console.error('[CommandPalette] Invalid command:', command);
      return false;
    }

    this.commands.set(command.id, {
      id: command.id,
      name: command.name,
      description: command.description || '',
      category: command.category || 'general',
      icon: command.icon || 'fa-terminal',
      handler: command.handler,
      shortcut: command.shortcut || '',
      keywords: command.keywords || []
    });

    return true;
  }

  /**
   * Unregister a command
   */
  unregisterCommand(id) {
    return this.commands.delete(id);
  }

  /**
   * Get all registered commands
   */
  getCommands() {
    return Array.from(this.commands.values());
  }

  /**
   * Open the command palette
   */
  open() {
    if (this.isOpen) return;

    this.createOverlay();
    this.isOpen = true;
    this.selectedIndex = 0;

    // Show recent commands initially
    this.filteredCommands = this.getRecentCommandObjects();
    this.render();

    // Focus search input
    setTimeout(() => {
      this.searchInput.focus();
    }, 100);
  }

  /**
   * Close the command palette
   */
  close() {
    if (!this.isOpen) return;

    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }

    this.isOpen = false;
    this.overlay = null;
    this.searchInput = null;
    this.resultsList = null;
  }

  /**
   * Create the overlay DOM structure
   */
  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'command-palette-overlay';
    this.overlay.innerHTML = `
      <div class="command-palette-container">
        <div class="command-palette-header">
          <i class="fas fa-search command-palette-search-icon"></i>
          <input
            type="text"
            class="command-palette-input"
            placeholder="Type a command or search..."
            autocomplete="off"
            spellcheck="false"
          />
          <button class="command-palette-close" title="Close (Esc)">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="command-palette-results" id="commandPaletteResults">
          <!-- Results will be rendered here -->
        </div>
        <div class="command-palette-footer">
          <div class="command-palette-hint">
            <kbd>↑</kbd><kbd>↓</kbd> Navigate
            <kbd>↵</kbd> Select
            <kbd>Esc</kbd> Close
          </div>
        </div>
      </div>
    `;

    // Get references to elements
    this.searchInput = this.overlay.querySelector('.command-palette-input');
    this.resultsList = this.overlay.querySelector('.command-palette-results');
    const closeBtn = this.overlay.querySelector('.command-palette-close');

    // Attach event listeners
    this.searchInput.addEventListener('input', this.handleSearchInput);
    this.searchInput.addEventListener('keydown', this.handleKeyDown);
    closeBtn.addEventListener('click', () => this.close());

    // Close on overlay click (not container)
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Append to body
    document.body.appendChild(this.overlay);
  }

  /**
   * Handle search input
   */
  handleSearchInput(event) {
    const query = event.target.value.trim();

    if (!query) {
      // Show recent commands when empty
      this.filteredCommands = this.getRecentCommandObjects();
    } else {
      // Filter commands with fuzzy search
      this.filteredCommands = this.fuzzySearch(query);
    }

    this.selectedIndex = 0;
    this.render();
  }

  /**
   * Fuzzy search commands
   * Character-in-order matching algorithm
   */
  fuzzySearch(query) {
    const lowerQuery = query.toLowerCase();
    const results = [];

    for (const command of this.commands.values()) {
      const score = this.fuzzyMatch(lowerQuery, command);
      if (score > 0) {
        results.push({ ...command, score });
      }
    }

    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Fuzzy match algorithm
   * Returns a score (0 = no match, higher = better match)
   */
  fuzzyMatch(query, command) {
    const searchText = `${command.name} ${command.description} ${command.keywords.join(' ')}`.toLowerCase();

    let score = 0;
    let queryIndex = 0;
    let lastMatchIndex = -1;

    // Character-in-order matching
    for (let i = 0; i < searchText.length && queryIndex < query.length; i++) {
      if (searchText[i] === query[queryIndex]) {
        score += 1;

        // Bonus for consecutive matches
        if (lastMatchIndex === i - 1) {
          score += 5;
        }

        // Bonus for match at word start
        if (i === 0 || searchText[i - 1] === ' ') {
          score += 10;
        }

        lastMatchIndex = i;
        queryIndex++;
      }
    }

    // Must match all characters in query
    if (queryIndex !== query.length) {
      return 0;
    }

    // Bonus for exact match
    if (command.name.toLowerCase() === query) {
      score += 100;
    }

    // Bonus for name match vs description match
    if (command.name.toLowerCase().includes(query)) {
      score += 50;
    }

    return score;
  }

  /**
   * Handle keyboard navigation
   */
  handleKeyDown(event) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectedIndex = Math.min(
          this.selectedIndex + 1,
          this.filteredCommands.length - 1
        );
        this.render();
        this.scrollToSelected();
        break;

      case 'ArrowUp':
        event.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.render();
        this.scrollToSelected();
        break;

      case 'Enter':
        event.preventDefault();
        this.executeSelected();
        break;

      case 'Escape':
        event.preventDefault();
        this.close();
        break;
    }
  }

  /**
   * Scroll to selected item
   */
  scrollToSelected() {
    const selectedItem = this.resultsList.querySelector('.command-item.selected');
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * Execute selected command
   */
  executeSelected() {
    const command = this.filteredCommands[this.selectedIndex];
    if (!command) return;

    this.executeCommand(command);
  }

  /**
   * Execute a command
   */
  executeCommand(command) {
    try {
      // Add to recent commands
      this.addRecentCommand(command.id);

      // Close palette
      this.close();

      // Execute handler
      command.handler();

      console.log(`[CommandPalette] Executed: ${command.name}`);
    } catch (error) {
      console.error(`[CommandPalette] Error executing ${command.name}:`, error);
    }
  }

  /**
   * Handle command click
   */
  handleCommandClick(event) {
    const item = event.currentTarget;
    const index = parseInt(item.dataset.index, 10);
    const command = this.filteredCommands[index];

    if (command) {
      this.executeCommand(command);
    }
  }

  /**
   * Render the results list
   */
  render() {
    if (!this.resultsList) return;

    if (this.filteredCommands.length === 0) {
      this.resultsList.innerHTML = `
        <div class="command-empty">
          <i class="fas fa-search"></i>
          <p>No commands found</p>
        </div>
      `;
      return;
    }

    const isShowingRecent = this.searchInput.value.trim() === '';
    let html = '';

    if (isShowingRecent && this.filteredCommands.length > 0) {
      html += '<div class="command-section-title">Recent Commands</div>';
    }

    // Group by category if not searching
    if (!isShowingRecent) {
      const grouped = this.groupByCategory(this.filteredCommands);

      for (const [category, commands] of Object.entries(grouped)) {
        html += `<div class="command-section-title">${this.formatCategory(category)}</div>`;

        commands.forEach((command, idx) => {
          const globalIndex = this.filteredCommands.indexOf(command);
          html += this.renderCommandItem(command, globalIndex);
        });
      }
    } else {
      // Render recent commands
      this.filteredCommands.forEach((command, idx) => {
        html += this.renderCommandItem(command, idx);
      });
    }

    this.resultsList.innerHTML = html;

    // Attach click listeners
    this.resultsList.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('click', this.handleCommandClick);
    });
  }

  /**
   * Render a single command item
   */
  renderCommandItem(command, index) {
    const isSelected = index === this.selectedIndex;
    const shortcut = command.shortcut ? `<kbd>${command.shortcut}</kbd>` : '';

    return `
      <div class="command-item ${isSelected ? 'selected' : ''}" data-index="${index}">
        <div class="command-item-icon">
          <i class="fas ${command.icon}"></i>
        </div>
        <div class="command-item-content">
          <div class="command-item-name">${this.escapeHtml(command.name)}</div>
          <div class="command-item-description">${this.escapeHtml(command.description)}</div>
        </div>
        ${shortcut ? `<div class="command-item-shortcut">${shortcut}</div>` : ''}
      </div>
    `;
  }

  /**
   * Group commands by category
   */
  groupByCategory(commands) {
    const grouped = {};

    commands.forEach(command => {
      const category = command.category || 'general';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(command);
    });

    return grouped;
  }

  /**
   * Format category name for display
   */
  formatCategory(category) {
    const categoryNames = {
      chat: 'Chat',
      navigation: 'Navigation',
      settings: 'Settings',
      rag: 'RAG & Search',
      general: 'General'
    };

    return categoryNames[category] || category.charAt(0).toUpperCase() + category.slice(1);
  }

  /**
   * Load recent commands from localStorage
   */
  loadRecentCommands() {
    try {
      const stored = localStorage.getItem('agentx_recent_commands');
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('[CommandPalette] Error loading recent commands:', error);
      return [];
    }
  }

  /**
   * Save recent commands to localStorage
   */
  saveRecentCommands() {
    try {
      localStorage.setItem('agentx_recent_commands', JSON.stringify(this.recentCommands));
    } catch (error) {
      console.error('[CommandPalette] Error saving recent commands:', error);
    }
  }

  /**
   * Add a command to recent commands
   */
  addRecentCommand(commandId) {
    // Remove if already exists
    this.recentCommands = this.recentCommands.filter(id => id !== commandId);

    // Add to front
    this.recentCommands.unshift(commandId);

    // Limit to max recent commands
    if (this.recentCommands.length > this.maxRecentCommands) {
      this.recentCommands = this.recentCommands.slice(0, this.maxRecentCommands);
    }

    this.saveRecentCommands();
  }

  /**
   * Get recent command objects
   */
  getRecentCommandObjects() {
    return this.recentCommands
      .map(id => this.commands.get(id))
      .filter(cmd => cmd !== undefined);
  }

  /**
   * Clear recent commands
   */
  clearRecentCommands() {
    this.recentCommands = [];
    this.saveRecentCommands();
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
   * Destroy the command palette
   */
  destroy() {
    this.close();
    this.commands.clear();
  }
}

// Export singleton instance
export const commandPalette = new CommandPalette();

// Export class as default
export default CommandPalette;
