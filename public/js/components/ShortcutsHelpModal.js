/**
 * Shortcuts Help Modal Component
 *
 * A modal dialog that displays all available keyboard shortcuts,
 * grouped by category with platform-specific key representations.
 *
 * Features:
 * - Platform-aware key display (Cmd on Mac, Ctrl elsewhere)
 * - Category grouping
 * - Searchable shortcuts list
 * - Keyboard navigation (Esc to close)
 *
 * Usage:
 *   const helpModal = new ShortcutsHelpModal(keyboardShortcutManager);
 *   helpModal.open();
 */

export class ShortcutsHelpModal {
  constructor(shortcutManager) {
    this.shortcutManager = shortcutManager;
    this.isOpen = false;
    this.overlay = null;

    // Listen for custom event
    document.addEventListener('show-shortcuts-help', () => this.open());
  }

  /**
   * Open the shortcuts help modal
   */
  open() {
    if (this.isOpen) return;

    this.createOverlay();
    this.isOpen = true;

    // Focus on close button for keyboard accessibility
    setTimeout(() => {
      const closeBtn = this.overlay.querySelector('.shortcuts-help-close');
      if (closeBtn) closeBtn.focus();
    }, 100);
  }

  /**
   * Close the shortcuts help modal
   */
  close() {
    if (!this.isOpen) return;

    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }

    this.isOpen = false;
    this.overlay = null;
  }

  /**
   * Create the overlay DOM structure
   */
  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay shortcuts-help-overlay';

    const shortcuts = this.shortcutManager.getShortcutsByCategory();
    const isMac = this.shortcutManager.isMac;

    this.overlay.innerHTML = `
      <div class="modal-container shortcuts-help-modal">
        <div class="modal-header">
          <h2>
            <i class="fas fa-keyboard"></i>
            Keyboard Shortcuts
          </h2>
          <button class="modal-close shortcuts-help-close" title="Close (Esc)">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="shortcuts-help-content">
          ${this.renderIntroduction(isMac)}
          ${this.renderShortcutCategories(shortcuts, isMac)}
        </div>

        <div class="shortcuts-help-footer">
          <p class="shortcuts-help-tip">
            <i class="fas fa-lightbulb"></i>
            <strong>Tip:</strong> Press <kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd> to open the command palette for quick access to all commands.
          </p>
        </div>
      </div>
    `;

    // Attach event listeners
    const closeBtn = this.overlay.querySelector('.shortcuts-help-close');
    closeBtn.addEventListener('click', () => this.close());

    // Close on Escape key
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
    document.addEventListener('keydown', handleKeyDown);

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
   * Render introduction section
   */
  renderIntroduction(isMac) {
    return `
      <div class="shortcuts-help-intro">
        <p>
          AgentX supports keyboard shortcuts to help you work faster.
          Use <kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd> to open the command palette,
          or use the shortcuts below for direct access.
        </p>
      </div>
    `;
  }

  /**
   * Render shortcut categories
   */
  renderShortcutCategories(shortcuts, isMac) {
    const categoryNames = {
      general: 'General',
      chat: 'Chat Actions',
      navigation: 'Navigation',
      rag: 'RAG & Search',
      settings: 'Settings'
    };

    const categoryOrder = ['general', 'chat', 'navigation', 'rag', 'settings'];

    let html = '<div class="shortcuts-help-sections">';

    // Render in specific order
    for (const category of categoryOrder) {
      if (!shortcuts[category] || shortcuts[category].length === 0) {
        continue;
      }

      const categoryName = categoryNames[category] || category;
      html += this.renderShortcutSection(categoryName, shortcuts[category], isMac);
    }

    // Render any remaining categories not in the order list
    for (const [category, shortcutList] of Object.entries(shortcuts)) {
      if (!categoryOrder.includes(category) && shortcutList.length > 0) {
        const categoryName = categoryNames[category] || this.formatCategoryName(category);
        html += this.renderShortcutSection(categoryName, shortcutList, isMac);
      }
    }

    html += '</div>';
    return html;
  }

  /**
   * Render a single shortcut section
   */
  renderShortcutSection(categoryName, shortcuts, isMac) {
    return `
      <div class="shortcuts-help-section">
        <h3 class="shortcuts-help-section-title">
          <i class="fas ${this.getCategoryIcon(categoryName)}"></i>
          ${categoryName}
        </h3>
        <div class="shortcuts-help-list">
          ${shortcuts.map(shortcut => this.renderShortcutItem(shortcut, isMac)).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render a single shortcut item
   */
  renderShortcutItem(shortcut, isMac) {
    const keyCombo = this.formatKeyCombo(shortcut.keyCombo, isMac);

    return `
      <div class="shortcuts-help-item">
        <div class="shortcuts-help-item-description">
          ${this.escapeHtml(shortcut.description)}
        </div>
        <div class="shortcuts-help-item-keys">
          ${keyCombo}
        </div>
      </div>
    `;
  }

  /**
   * Format key combination for display with proper styling
   */
  formatKeyCombo(keyCombo, isMac) {
    // Split by + and format each key
    const keys = keyCombo.split('+');

    return keys.map(key => {
      let displayKey = key;

      // Replace with platform-specific symbols
      if (isMac) {
        const symbols = {
          'Cmd': '⌘',
          'Ctrl': '⌃',
          'Alt': '⌥',
          'Shift': '⇧',
          'Enter': '↵',
          'Esc': '⎋',
          'Space': '␣',
          'ArrowUp': '↑',
          'ArrowDown': '↓',
          'ArrowLeft': '←',
          'ArrowRight': '→'
        };
        displayKey = symbols[key] || key;
      } else {
        // Windows/Linux friendly names
        const names = {
          'Enter': '↵',
          'Esc': 'Esc',
          'Space': 'Space',
          'ArrowUp': '↑',
          'ArrowDown': '↓',
          'ArrowLeft': '←',
          'ArrowRight': '→'
        };
        displayKey = names[key] || key;
      }

      return `<kbd>${displayKey}</kbd>`;
    }).join('<span class="shortcuts-help-plus">+</span>');
  }

  /**
   * Get icon for category
   */
  getCategoryIcon(categoryName) {
    const icons = {
      'General': 'fa-star',
      'Chat Actions': 'fa-comments',
      'Navigation': 'fa-compass',
      'RAG & Search': 'fa-database',
      'Settings': 'fa-cog'
    };

    return icons[categoryName] || 'fa-folder';
  }

  /**
   * Format category name (capitalize first letter)
   */
  formatCategoryName(category) {
    return category.charAt(0).toUpperCase() + category.slice(1);
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
   * Destroy the shortcuts help modal
   */
  destroy() {
    this.close();
  }
}

/**
 * Initialize and create a global shortcuts help modal
 */
export function initializeShortcutsHelp(shortcutManager) {
  const helpModal = new ShortcutsHelpModal(shortcutManager);

  // Add global function to show shortcuts
  window.showKeyboardShortcuts = () => helpModal.open();

  console.log('[ShortcutsHelp] Initialized shortcuts help modal');

  return helpModal;
}

// Export as default
export default ShortcutsHelpModal;
