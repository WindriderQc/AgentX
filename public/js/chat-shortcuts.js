/**
 * Chat Shortcuts Registration
 *
 * Registers all keyboard shortcuts for the chat interface.
 * Priority 1 shortcuts (essential for chat operations):
 * - Ctrl+K - Open Command Palette
 * - Ctrl+Enter - Send Message
 * - Ctrl+N - New Chat
 * - Ctrl+L - Clear Chat
 * - Ctrl+R - Toggle RAG
 * - Ctrl+M - Focus Model Selector
 * - Ctrl+P - Search Conversations
 * - Up/Down - Navigate Input History
 *
 * @requires KeyboardShortcutManager
 * @requires CommandPalette
 */

import { KeyboardShortcutManager } from './utils/keyboard-shortcuts.js';
import { CommandPalette } from './components/CommandPalette.js';

/**
 * Initialize keyboard shortcuts for chat interface
 *
 * @param {Object} handlers - Object containing handler functions
 * @param {Function} handlers.sendMessage - Send current message
 * @param {Function} handlers.clearChat - Clear chat history
 * @param {Function} handlers.newChat - Start new chat (alias for clearChat)
 * @param {Function} handlers.toggleRAG - Toggle RAG feature
 * @param {Function} handlers.focusModelSelector - Focus model dropdown
 * @param {Function} handlers.openConversations - Open conversations panel
 * @param {Function} handlers.focusInput - Focus message input
 * @param {Function} handlers.navigateHistory - Navigate input history
 */
export function initializeChatShortcuts(handlers) {
  const manager = KeyboardShortcutManager.getInstance();
  const palette = new CommandPalette();

  // Validate handlers
  const requiredHandlers = [
    'sendMessage',
    'clearChat',
    'toggleRAG',
    'focusModelSelector',
    'openConversations',
    'focusInput'
  ];

  for (const handler of requiredHandlers) {
    if (!handlers[handler]) {
      console.error(`[ChatShortcuts] Missing required handler: ${handler}`);
    }
  }

  // ============================================================================
  // COMMAND PALETTE
  // ============================================================================

  // Register Ctrl+K to open command palette
  manager.register('Ctrl+K', () => {
    palette.open();
  }, {
    description: 'Open command palette',
    category: 'general'
  });

  // ============================================================================
  // REGISTER COMMANDS IN COMMAND PALETTE
  // ============================================================================

  // Chat Commands
  palette.registerCommand({
    id: 'send-message',
    name: 'Send Message',
    description: 'Send the current message',
    category: 'chat',
    icon: 'fa-paper-plane',
    shortcut: 'Ctrl+Enter',
    handler: handlers.sendMessage,
    keywords: ['send', 'submit', 'post']
  });

  palette.registerCommand({
    id: 'new-chat',
    name: 'New Chat',
    description: 'Start a new conversation',
    category: 'chat',
    icon: 'fa-plus',
    shortcut: 'Ctrl+N',
    handler: handlers.clearChat,
    keywords: ['new', 'start', 'begin', 'create']
  });

  palette.registerCommand({
    id: 'clear-chat',
    name: 'Clear Chat',
    description: 'Clear current conversation',
    category: 'chat',
    icon: 'fa-trash',
    shortcut: 'Ctrl+L',
    handler: handlers.clearChat,
    keywords: ['clear', 'delete', 'reset', 'remove']
  });

  // Navigation Commands
  palette.registerCommand({
    id: 'focus-input',
    name: 'Focus Message Input',
    description: 'Focus the message input field',
    category: 'navigation',
    icon: 'fa-keyboard',
    shortcut: 'Esc',
    handler: handlers.focusInput,
    keywords: ['focus', 'input', 'message', 'type']
  });

  palette.registerCommand({
    id: 'focus-model-selector',
    name: 'Focus Model Selector',
    description: 'Focus the model selection dropdown',
    category: 'navigation',
    icon: 'fa-robot',
    shortcut: 'Ctrl+M',
    handler: handlers.focusModelSelector,
    keywords: ['model', 'select', 'choose', 'ai']
  });

  palette.registerCommand({
    id: 'search-conversations',
    name: 'Search Conversations',
    description: 'Open conversation history panel',
    category: 'navigation',
    icon: 'fa-history',
    shortcut: 'Ctrl+P',
    handler: handlers.openConversations,
    keywords: ['history', 'search', 'find', 'conversations', 'past']
  });

  // RAG Commands
  palette.registerCommand({
    id: 'toggle-rag',
    name: 'Toggle RAG',
    description: 'Enable or disable RAG (Retrieval Augmented Generation)',
    category: 'rag',
    icon: 'fa-database',
    shortcut: 'Ctrl+R',
    handler: handlers.toggleRAG,
    keywords: ['rag', 'retrieval', 'search', 'context']
  });

  if (handlers.toggleRAGExpand) {
    palette.registerCommand({
      id: 'toggle-rag-expand',
      name: 'Toggle Query Expansion',
      description: 'Enable or disable RAG query expansion',
      category: 'rag',
      icon: 'fa-expand',
      handler: handlers.toggleRAGExpand,
      keywords: ['rag', 'expand', 'query', 'expansion']
    });
  }

  if (handlers.toggleRAGHybrid) {
    palette.registerCommand({
      id: 'toggle-rag-hybrid',
      name: 'Toggle Hybrid Search',
      description: 'Enable or disable RAG hybrid search',
      category: 'rag',
      icon: 'fa-search-plus',
      handler: handlers.toggleRAGHybrid,
      keywords: ['rag', 'hybrid', 'search']
    });
  }

  // Settings Commands
  if (handlers.openSettings) {
    palette.registerCommand({
      id: 'open-settings',
      name: 'Open Settings',
      description: 'Open settings panel',
      category: 'settings',
      icon: 'fa-cog',
      handler: handlers.openSettings,
      keywords: ['settings', 'preferences', 'config', 'options']
    });
  }

  if (handlers.openProfile) {
    palette.registerCommand({
      id: 'open-profile',
      name: 'Open Profile',
      description: 'Open user profile settings',
      category: 'settings',
      icon: 'fa-user',
      handler: handlers.openProfile,
      keywords: ['profile', 'user', 'account', 'preferences']
    });
  }

  if (handlers.saveSettings) {
    palette.registerCommand({
      id: 'save-settings',
      name: 'Save Settings',
      description: 'Save current settings as defaults',
      category: 'settings',
      icon: 'fa-save',
      handler: handlers.saveSettings,
      keywords: ['save', 'settings', 'defaults', 'persist']
    });
  }

  if (handlers.refreshModels) {
    palette.registerCommand({
      id: 'refresh-models',
      name: 'Refresh Models',
      description: 'Reload available models from server',
      category: 'settings',
      icon: 'fa-sync',
      handler: handlers.refreshModels,
      keywords: ['refresh', 'reload', 'models', 'update']
    });
  }

  // ============================================================================
  // DIRECT KEYBOARD SHORTCUTS (Priority 1)
  // ============================================================================

  // Ctrl+Enter - Send Message
  manager.register('Ctrl+Enter', () => {
    handlers.sendMessage();
  }, {
    description: 'Send message',
    category: 'chat'
  });

  // Ctrl+N - New Chat
  manager.register('Ctrl+N', () => {
    handlers.clearChat();
  }, {
    description: 'New chat',
    category: 'chat'
  });

  // Ctrl+L - Clear Chat
  manager.register('Ctrl+L', () => {
    handlers.clearChat();
  }, {
    description: 'Clear chat',
    category: 'chat'
  });

  // Ctrl+R - Toggle RAG (prevent browser refresh)
  manager.register('Ctrl+R', () => {
    handlers.toggleRAG();
  }, {
    description: 'Toggle RAG',
    category: 'rag'
  });

  // Ctrl+M - Focus Model Selector
  manager.register('Ctrl+M', () => {
    handlers.focusModelSelector();
  }, {
    description: 'Focus model selector',
    category: 'navigation'
  });

  // Ctrl+P - Search Conversations
  manager.register('Ctrl+P', () => {
    handlers.openConversations();
  }, {
    description: 'Search conversations',
    category: 'navigation'
  });

  // Escape - Focus Input (when not in input already)
  manager.register('Escape', () => {
    // Close any open modals first
    const openModals = document.querySelectorAll('.modal-overlay, .command-palette-overlay');
    if (openModals.length > 0) {
      return; // Let the modal handle Escape
    }

    // Focus input
    handlers.focusInput();
  }, {
    description: 'Focus input / Close modal',
    category: 'navigation'
  });

  console.log('[ChatShortcuts] Initialized keyboard shortcuts and command palette');

  // Return instances for cleanup/testing
  return {
    manager,
    palette
  };
}

/**
 * Setup input history navigation (Up/Down arrows in message input)
 *
 * @param {HTMLElement} inputElement - The message input element
 * @param {Function} getHistory - Function that returns message history array
 */
export function setupInputHistoryNavigation(inputElement, getHistory) {
  let historyIndex = -1;
  let currentInput = '';

  inputElement.addEventListener('keydown', (event) => {
    const history = getHistory();

    // Only handle arrow keys when input is focused
    if (event.target !== inputElement) return;

    // Only navigate history when input is empty or we're already navigating
    const isEmpty = inputElement.value.trim() === '';
    const isNavigating = historyIndex >= 0;

    if (event.key === 'ArrowUp') {
      // Prevent default cursor movement
      event.preventDefault();

      // Save current input if starting navigation
      if (historyIndex === -1) {
        currentInput = inputElement.value;
      }

      // Navigate up in history (older messages)
      if (history.length > 0) {
        historyIndex = Math.min(historyIndex + 1, history.length - 1);
        inputElement.value = history[history.length - 1 - historyIndex];
      }
    } else if (event.key === 'ArrowDown') {
      // Only handle if we're navigating history
      if (historyIndex > -1) {
        event.preventDefault();

        // Navigate down in history (newer messages)
        historyIndex--;

        if (historyIndex < 0) {
          // Restore original input
          inputElement.value = currentInput;
        } else {
          inputElement.value = history[history.length - 1 - historyIndex];
        }
      }
    } else if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      // Reset history navigation on any other key
      historyIndex = -1;
      currentInput = '';
    }
  });

  console.log('[ChatShortcuts] Input history navigation initialized');
}

/**
 * Show keyboard shortcuts help
 * Opens the shortcuts help modal
 */
export function showShortcutsHelp() {
  // This will be implemented with ShortcutsHelpModal
  const event = new CustomEvent('show-shortcuts-help');
  document.dispatchEvent(event);
}

// Export default as initializeChatShortcuts
export default initializeChatShortcuts;
