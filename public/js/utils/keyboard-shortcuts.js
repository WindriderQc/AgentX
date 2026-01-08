/**
 * Keyboard Shortcuts Manager
 *
 * Centralized keyboard shortcut management system for AgentX.
 * Features:
 * - Context-aware shortcuts (ignore when typing in input fields)
 * - Modifier key normalization (Ctrl/Cmd cross-platform)
 * - Conflict detection and prevention
 * - Browser shortcut override prevention
 * - Dynamic registration/unregistration
 *
 * Usage:
 *   const manager = KeyboardShortcutManager.getInstance();
 *   manager.register('Ctrl+K', () => openCommandPalette(), {
 *     description: 'Open command palette',
 *     category: 'general'
 *   });
 */

export class KeyboardShortcutManager {
  static instance = null;

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!KeyboardShortcutManager.instance) {
      KeyboardShortcutManager.instance = new KeyboardShortcutManager();
    }
    return KeyboardShortcutManager.instance;
  }

  constructor() {
    if (KeyboardShortcutManager.instance) {
      return KeyboardShortcutManager.instance;
    }

    this.shortcuts = new Map(); // Map<keyCombo, {handler, options}>
    this.enabled = true;
    this.isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    // Context elements where shortcuts should be ignored
    this.ignoreElements = ['INPUT', 'TEXTAREA', 'SELECT'];

    // Bind the handler
    this.handleKeyDown = this.handleKeyDown.bind(this);

    // Initialize
    this.init();
  }

  /**
   * Initialize the keyboard shortcuts system
   */
  init() {
    document.addEventListener('keydown', this.handleKeyDown, true);
    console.log('[KeyboardShortcuts] Manager initialized');
  }

  /**
   * Normalize modifier keys for cross-platform compatibility
   * Converts Ctrl to Cmd on Mac, keeps Ctrl on Windows/Linux
   */
  normalizeKey(key) {
    // Convert Mod+X to Ctrl+X (Windows/Linux) or Cmd+X (Mac)
    if (key.includes('Mod+')) {
      const modifier = this.isMac ? 'Cmd' : 'Ctrl';
      return key.replace('Mod+', modifier + '+');
    }

    // Normalize key names
    return key
      .replace(/Control/gi, 'Ctrl')
      .replace(/Command/gi, 'Cmd')
      .replace(/Meta/gi, 'Cmd')
      .replace(/Option/gi, 'Alt')
      .split('+')
      .map(part => part.trim())
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('+');
  }

  /**
   * Get current modifier state from keyboard event
   */
  getEventModifiers(event) {
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Cmd');
    return modifiers;
  }

  /**
   * Convert keyboard event to key combination string
   */
  eventToKeyCombo(event) {
    const modifiers = this.getEventModifiers(event);
    let key = event.key;

    // Normalize key names
    if (key === ' ') key = 'Space';
    if (key === 'Escape') key = 'Esc';
    if (key.length === 1) key = key.toUpperCase();

    // Don't include the modifier key itself
    if (['Control', 'Alt', 'Shift', 'Meta', 'Cmd'].includes(key)) {
      return null;
    }

    // Build combo string
    const combo = [...modifiers, key].join('+');
    return this.normalizeKey(combo);
  }

  /**
   * Check if the current context should ignore shortcuts
   */
  shouldIgnoreShortcut(event) {
    if (!this.enabled) return true;

    const target = event.target;
    const tagName = target.tagName;

    // Ignore shortcuts when typing in input fields
    if (this.ignoreElements.includes(tagName)) {
      // Exception: Allow Ctrl+Enter in textareas/inputs
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        return false;
      }

      // Exception: Allow Ctrl+K (command palette) everywhere
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        return false;
      }

      // Exception: Allow Escape key everywhere
      if (event.key === 'Escape') {
        return false;
      }

      return true;
    }

    // Ignore if contenteditable
    if (target.isContentEditable) {
      return true;
    }

    return false;
  }

  /**
   * Handle keydown events
   */
  handleKeyDown(event) {
    // Check if we should ignore this shortcut
    if (this.shouldIgnoreShortcut(event)) {
      return;
    }

    // Convert event to key combo
    const keyCombo = this.eventToKeyCombo(event);
    if (!keyCombo) return;

    // Check if we have a handler for this combo
    const shortcut = this.shortcuts.get(keyCombo);
    if (!shortcut) return;

    // Prevent default browser behavior for registered shortcuts
    event.preventDefault();
    event.stopPropagation();

    // Execute handler
    try {
      shortcut.handler(event);
      console.log(`[KeyboardShortcuts] Executed: ${keyCombo}`);
    } catch (error) {
      console.error(`[KeyboardShortcuts] Error executing ${keyCombo}:`, error);
    }
  }

  /**
   * Register a keyboard shortcut
   *
   * @param {string} keyCombo - Key combination (e.g., "Ctrl+K", "Mod+Enter")
   * @param {Function} handler - Handler function to execute
   * @param {Object} options - Additional options
   * @param {string} options.description - Human-readable description
   * @param {string} options.category - Category for grouping
   * @param {boolean} options.preventDefault - Prevent default browser behavior (default: true)
   * @returns {boolean} Success status
   */
  register(keyCombo, handler, options = {}) {
    const normalized = this.normalizeKey(keyCombo);

    // Check for conflicts
    if (this.shortcuts.has(normalized)) {
      console.warn(`[KeyboardShortcuts] Shortcut ${normalized} is already registered. Overwriting.`);
    }

    // Store shortcut
    this.shortcuts.set(normalized, {
      handler,
      keyCombo: normalized,
      description: options.description || '',
      category: options.category || 'general',
      preventDefault: options.preventDefault !== false
    });

    console.log(`[KeyboardShortcuts] Registered: ${normalized} - ${options.description || 'No description'}`);
    return true;
  }

  /**
   * Unregister a keyboard shortcut
   *
   * @param {string} keyCombo - Key combination to unregister
   * @returns {boolean} Success status
   */
  unregister(keyCombo) {
    const normalized = this.normalizeKey(keyCombo);
    const existed = this.shortcuts.delete(normalized);

    if (existed) {
      console.log(`[KeyboardShortcuts] Unregistered: ${normalized}`);
    }

    return existed;
  }

  /**
   * Get all registered shortcuts
   *
   * @returns {Array} Array of shortcut objects
   */
  getShortcuts() {
    return Array.from(this.shortcuts.values());
  }

  /**
   * Get shortcuts grouped by category
   *
   * @returns {Object} Shortcuts grouped by category
   */
  getShortcutsByCategory() {
    const grouped = {};

    for (const shortcut of this.shortcuts.values()) {
      const category = shortcut.category || 'general';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(shortcut);
    }

    return grouped;
  }

  /**
   * Check if a key combination is registered
   *
   * @param {string} keyCombo - Key combination to check
   * @returns {boolean} Whether the shortcut is registered
   */
  isRegistered(keyCombo) {
    const normalized = this.normalizeKey(keyCombo);
    return this.shortcuts.has(normalized);
  }

  /**
   * Clear all registered shortcuts
   */
  clear() {
    this.shortcuts.clear();
    console.log('[KeyboardShortcuts] All shortcuts cleared');
  }

  /**
   * Enable keyboard shortcuts
   */
  enable() {
    this.enabled = true;
    console.log('[KeyboardShortcuts] Shortcuts enabled');
  }

  /**
   * Disable keyboard shortcuts
   */
  disable() {
    this.enabled = false;
    console.log('[KeyboardShortcuts] Shortcuts disabled');
  }

  /**
   * Destroy the keyboard shortcuts manager
   */
  destroy() {
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.clear();
    console.log('[KeyboardShortcuts] Manager destroyed');
  }

  /**
   * Format key combo for display (platform-aware)
   *
   * @param {string} keyCombo - Key combination
   * @returns {string} Formatted key combo for display
   */
  formatKeyCombo(keyCombo) {
    const normalized = this.normalizeKey(keyCombo);

    // Replace with platform-specific symbols
    if (this.isMac) {
      return normalized
        .replace(/Cmd/g, '⌘')
        .replace(/Ctrl/g, '⌃')
        .replace(/Alt/g, '⌥')
        .replace(/Shift/g, '⇧');
    }

    return normalized;
  }

  /**
   * Get platform-specific modifier key name
   *
   * @returns {string} Platform modifier key ('Cmd' on Mac, 'Ctrl' elsewhere)
   */
  getPlatformModifier() {
    return this.isMac ? 'Cmd' : 'Ctrl';
  }

  /**
   * Get platform-specific modifier key symbol
   *
   * @returns {string} Platform modifier symbol ('⌘' on Mac, 'Ctrl' elsewhere)
   */
  getPlatformModifierSymbol() {
    return this.isMac ? '⌘' : 'Ctrl';
  }
}

// Create and export singleton instance
export const keyboardShortcuts = KeyboardShortcutManager.getInstance();

// Export as default as well for convenience
export default KeyboardShortcutManager;
