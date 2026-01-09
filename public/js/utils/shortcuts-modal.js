/**
 * Keyboard Shortcuts Help Modal
 * Standalone modal showing all available keyboard shortcuts
 * No dependencies - works globally
 */

const ShortcutsHelpModal = (() => {
  let isOpen = false;
  let overlay = null;

  // Define all shortcuts (can be extended)
  const shortcuts = [
    {
      category: 'Chat Actions',
      items: [
        { keys: 'Ctrl+Enter', description: 'Send message' },
        { keys: 'Ctrl+N', description: 'New conversation' },
        { keys: 'Ctrl+K', description: 'Open command palette' },
        { keys: 'Ctrl+/', description: 'Show shortcuts (this dialog)' },
        { keys: 'Escape', description: 'Close dialogs/modals' }
      ]
    },
    {
      category: 'Navigation',
      items: [
        { keys: 'Ctrl+H', description: 'Toggle history sidebar' },
        { keys: 'Ctrl+B', description: 'Toggle sidebar' },
        { keys: 'Tab', description: 'Navigate between fields' }
      ]
    },
    {
      category: 'Text Editing',
      items: [
        { keys: 'Ctrl+A', description: 'Select all text' },
        { keys: 'Ctrl+C', description: 'Copy selected text' },
        { keys: 'Ctrl+V', description: 'Paste text' },
        { keys: 'Ctrl+Z', description: 'Undo' },
        { keys: 'Ctrl+Y', description: 'Redo' }
      ]
    }
  ];

  function createModal() {
    const modal = document.createElement('div');
    modal.className = 'shortcuts-modal-overlay';
    modal.innerHTML = `
      <div class="shortcuts-modal">
        <div class="shortcuts-modal-header">
          <h2>
            <i class="fas fa-keyboard"></i>
            Keyboard Shortcuts
          </h2>
          <button class="shortcuts-modal-close" aria-label="Close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="shortcuts-modal-body">
          ${shortcuts.map(category => `
            <div class="shortcuts-category">
              <h3>${category.category}</h3>
              <div class="shortcuts-list">
                ${category.items.map(item => `
                  <div class="shortcut-item">
                    <span class="shortcut-keys">${formatKeys(item.keys)}</span>
                    <span class="shortcut-desc">${item.description}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <div class="shortcuts-modal-footer">
          <p><i class="fas fa-lightbulb"></i> Tip: Hover over buttons to see their shortcuts!</p>
        </div>
      </div>
    `;

    return modal;
  }

  function formatKeys(keys) {
    return keys.split('+')
      .map(key => `<kbd>${key}</kbd>`)
      .join('<span class="key-separator">+</span>');
  }

  function injectStyles() {
    if (document.getElementById('shortcuts-modal-styles')) return;

    const style = document.createElement('style');
    style.id = 'shortcuts-modal-styles';
    style.textContent = `
      .shortcuts-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
        animation: fadeIn 0.2s ease-out;
        backdrop-filter: blur(4px);
      }

      .shortcuts-modal {
        background: var(--bg, #1a1a1a);
        color: var(--text, #fff);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        width: 90%;
        max-width: 700px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        animation: slideUp 0.3s ease-out;
      }

      .shortcuts-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 24px 24px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .shortcuts-modal-header h2 {
        margin: 0;
        font-size: 24px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .shortcuts-modal-header h2 i {
        color: var(--accent, #ee80ff);
      }

      .shortcuts-modal-close {
        background: none;
        border: none;
        color: var(--muted, #999);
        font-size: 24px;
        cursor: pointer;
        padding: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: all 0.2s;
      }

      .shortcuts-modal-close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--text, #fff);
      }

      .shortcuts-modal-body {
        padding: 24px;
        overflow-y: auto;
        flex: 1;
      }

      .shortcuts-category {
        margin-bottom: 32px;
      }

      .shortcuts-category:last-child {
        margin-bottom: 0;
      }

      .shortcuts-category h3 {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 600;
        color: var(--accent, #ee80ff);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .shortcuts-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .shortcut-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        background: rgba(255, 255, 255, 0.03);
        border-radius: 8px;
        transition: background 0.2s;
      }

      .shortcut-item:hover {
        background: rgba(255, 255, 255, 0.06);
      }

      .shortcut-keys {
        display: flex;
        align-items: center;
        gap: 4px;
        font-family: 'Courier New', monospace;
        min-width: 180px;
      }

      .shortcut-keys kbd {
        display: inline-block;
        padding: 4px 10px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.4;
        color: var(--text, #fff);
        background: linear-gradient(to bottom, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2), 0 0 0 2px rgba(255,255,255,0.05) inset;
      }

      .key-separator {
        color: var(--muted, #999);
        font-weight: bold;
        padding: 0 2px;
      }

      .shortcut-desc {
        flex: 1;
        color: var(--muted, #ccc);
        font-size: 14px;
      }

      .shortcuts-modal-footer {
        padding: 16px 24px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.02);
        border-radius: 0 0 12px 12px;
      }

      .shortcuts-modal-footer p {
        margin: 0;
        font-size: 13px;
        color: var(--muted, #999);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .shortcuts-modal-footer i {
        color: var(--accent, #ee80ff);
      }

      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @media (max-width: 768px) {
        .shortcuts-modal {
          width: 95%;
          max-height: 90vh;
        }

        .shortcuts-modal-header {
          padding: 20px 16px 12px;
        }

        .shortcuts-modal-header h2 {
          font-size: 20px;
        }

        .shortcuts-modal-body {
          padding: 16px;
        }

        .shortcut-item {
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
        }

        .shortcut-keys {
          min-width: auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function show() {
    if (isOpen) return;

    injectStyles();
    overlay = createModal();
    document.body.appendChild(overlay);
    isOpen = true;

    // Close button handler
    const closeBtn = overlay.querySelector('.shortcuts-modal-close');
    closeBtn.addEventListener('click', hide);

    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        hide();
      }
    });

    // Escape key to close
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        hide();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Focus close button for accessibility
    setTimeout(() => closeBtn.focus(), 100);
  }

  function hide() {
    if (!isOpen || !overlay) return;

    overlay.style.animation = 'fadeOut 0.2s ease-out';
    setTimeout(() => {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      overlay = null;
      isOpen = false;
    }, 200);
  }

  // Add fadeOut animation
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.getElementById('shortcuts-modal-styles');
      if (style) {
        style.textContent += `
          @keyframes fadeOut {
            from { opacity: 1; }
            to { opacity: 0; }
          }
        `;
      }
    });
  }

  return {
    show,
    hide,
    isOpen: () => isOpen
  };
})();

// Export for global use
if (typeof window !== 'undefined') {
  window.ShortcutsHelpModal = ShortcutsHelpModal;
}
