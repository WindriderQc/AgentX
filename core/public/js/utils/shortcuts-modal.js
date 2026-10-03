/**
 * Keyboard Shortcuts Help Modal
 * Page-context aware modal showing available keyboard shortcuts.
 * Self-registers Ctrl+/ (or Cmd+/) to toggle the modal on any page.
 *
 * API:
 *   ShortcutsHelpModal.show()           — open modal
 *   ShortcutsHelpModal.hide()           — close modal
 *   ShortcutsHelpModal.isOpen()         — boolean
 *   ShortcutsHelpModal.setShortcuts(arr)— replace the shortcuts list
 *   ShortcutsHelpModal.addCategory(name, items) — append a category
 *
 * Each page can call setShortcuts() on DOMContentLoaded to display
 * page-specific shortcuts. If no page calls it, the default "General"
 * category is shown.
 */

/**
 * Shared accessibility lifecycle for lightweight overlay dialogs.
 *
 * The shortcuts script is already loaded by every service that renders the
 * shared navigation, so keeping this primitive here avoids another cross-
 * service asset dependency. Dialog owners remain responsible for their visual
 * open/closed state; this controller owns background isolation, contained
 * keyboard focus, Escape requests, and opener restoration.
 */
window.AgentXModalAccessibility = window.AgentXModalAccessibility || (() => {
  const states = new WeakMap();
  const stack = [];
  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function focusableControls(dialog) {
    if (!dialog || typeof dialog.querySelectorAll !== 'function') return [];
    return Array.from(dialog.querySelectorAll(focusableSelector)).filter(control => {
      if (!control || control.hidden || control.disabled) return false;
      if (typeof control.getAttribute === 'function' && control.getAttribute('aria-hidden') === 'true') return false;
      if (typeof control.closest === 'function' && control.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      return true;
    });
  }

  function isolateBackground(dialog, documentRef) {
    const isolated = [];
    const body = documentRef && documentRef.body;
    if (!body || !body.children) return isolated;

    Array.from(body.children).forEach(child => {
      const containsDialog = child === dialog
        || (typeof child.contains === 'function' && child.contains(dialog));
      if (containsDialog || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
      isolated.push({
        element: child,
        inert: Boolean(child.inert),
        hadAriaHidden: typeof child.hasAttribute === 'function' && child.hasAttribute('aria-hidden'),
        ariaHidden: typeof child.getAttribute === 'function' ? child.getAttribute('aria-hidden') : null
      });
      child.inert = true;
      if (typeof child.setAttribute === 'function') child.setAttribute('aria-hidden', 'true');
    });
    return isolated;
  }

  function restoreBackground(isolated) {
    isolated.forEach(entry => {
      entry.element.inert = entry.inert;
      if (typeof entry.element.removeAttribute !== 'function') return;
      if (entry.hadAriaHidden) entry.element.setAttribute('aria-hidden', entry.ariaHidden);
      else entry.element.removeAttribute('aria-hidden');
    });
  }

  function activate(dialog, options = {}) {
    if (!dialog || states.has(dialog)) return;
    const documentRef = dialog.ownerDocument || document;
    const opener = options.opener || documentRef.activeElement || null;
    const state = {
      documentRef,
      opener,
      isolated: isolateBackground(dialog, documentRef),
      onRequestClose: typeof options.onRequestClose === 'function' ? options.onRequestClose : null,
      keydown: null
    };

    dialog.inert = false;
    if (typeof dialog.removeAttribute === 'function') dialog.removeAttribute('aria-hidden');

    state.keydown = event => {
      if (stack[stack.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (state.onRequestClose) state.onRequestClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const controls = focusableControls(dialog);
      if (!controls.length) {
        event.preventDefault();
        if (typeof dialog.focus === 'function') dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = documentRef.activeElement;
      const focusOutside = typeof dialog.contains === 'function' && !dialog.contains(active);
      if (event.shiftKey && (active === first || focusOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || focusOutside)) {
        event.preventDefault();
        first.focus();
      }
    };

    states.set(dialog, state);
    stack.push(dialog);
    documentRef.addEventListener('keydown', state.keydown, true);

    const initialFocus = options.initialFocus || focusableControls(dialog)[0] || dialog;
    if (initialFocus && typeof initialFocus.focus === 'function') initialFocus.focus();
  }

  function deactivate(dialog, options = {}) {
    const state = dialog && states.get(dialog);
    if (!state) return;
    state.documentRef.removeEventListener('keydown', state.keydown, true);
    const index = stack.lastIndexOf(dialog);
    if (index >= 0) stack.splice(index, 1);
    restoreBackground(state.isolated);
    states.delete(dialog);

    dialog.inert = true;
    if (typeof dialog.setAttribute === 'function') dialog.setAttribute('aria-hidden', 'true');
    if (options.restoreFocus !== false && state.opener && typeof state.opener.focus === 'function') {
      state.opener.focus({ preventScroll: true });
    }
  }

  return { activate, deactivate, focusableControls };
})();

window.ShortcutsHelpModal = window.ShortcutsHelpModal || (() => {
  let _isOpen = false;
  let _isClosing = false;
  let _overlay = null;
  let _trigger = null;
  const dialogId = 'keyboardShortcutsDialog';

  // Default shortcuts — every core page gets these
  let shortcuts = [
    {
      category: 'General',
      items: [
        { keys: 'Ctrl+/', description: 'Show keyboard shortcuts' },
        { keys: 'Escape', description: 'Close dialogs and modals' },
        { keys: 'Ctrl+Shift+B', description: 'Toggle Buddy panel' }
      ]
    }
  ];

  /** Replace the full shortcuts list */
  function setShortcuts(list) {
    shortcuts = list;
  }

  /** Append a category to the current list */
  function addCategory(category, items) {
    shortcuts.push({ category, items });
  }

  function formatKeys(keys) {
    return keys.split('+')
      .map(key => `<kbd>${key}</kbd>`)
      .join('<span class="sc-key-sep">+</span>');
  }

  function configureShortcutTriggers() {
    if (typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll('[data-nav-action="show-shortcuts"], #showShortcutsBtn').forEach(trigger => {
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', dialogId);
      if (!trigger.hasAttribute('aria-expanded')) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function createModal() {
    const el = document.createElement('div');
    el.id = dialogId;
    el.className = 'sc-modal-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'sc-modal-title');
    el.setAttribute('aria-describedby', 'sc-modal-instructions');
    el.setAttribute('tabindex', '-1');
    el.innerHTML = `
      <div class="sc-modal">
        <div class="sc-modal-header">
          <h2 id="sc-modal-title"><i class="fas fa-keyboard" aria-hidden="true"></i> Keyboard Shortcuts</h2>
          <button class="sc-modal-close" type="button" aria-label="Close keyboard shortcuts"><i class="fas fa-times" aria-hidden="true"></i></button>
        </div>
        <div class="sc-modal-body">
          ${shortcuts.map(cat => `
            <div class="sc-category">
              <h3>${cat.category}</h3>
              <div class="sc-list">
                ${cat.items.map(item => `
                  <div class="sc-item">
                    <span class="sc-keys">${formatKeys(item.keys)}</span>
                    <span class="sc-desc">${item.description}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <div class="sc-modal-footer">
          <p id="sc-modal-instructions"><i class="fas fa-lightbulb" aria-hidden="true"></i> Press <kbd>Ctrl</kbd><span class="sc-key-sep">+</span><kbd>/</kbd> anywhere to toggle this dialog.</p>
        </div>
      </div>
    `;
    return el;
  }

  // ── Show / Hide ─────────────────────────────────────────────

  function show() {
    if (_isOpen || _isClosing) return;
    const opener = document.activeElement;
    _trigger = opener && typeof opener.matches === 'function'
      && opener.matches('[data-nav-action="show-shortcuts"], #showShortcutsBtn')
      ? opener
      : null;
    if (_trigger) {
      _trigger.setAttribute('aria-haspopup', 'dialog');
      _trigger.setAttribute('aria-controls', dialogId);
      _trigger.setAttribute('aria-expanded', 'true');
    }
    _overlay = createModal();
    document.body.appendChild(_overlay);
    _isOpen = true;

    const closeBtn = _overlay.querySelector('.sc-modal-close');
    closeBtn.addEventListener('click', hide);
    _overlay.addEventListener('click', (e) => { if (e.target === _overlay) hide(); });
    window.AgentXModalAccessibility.activate(_overlay, {
      opener,
      initialFocus: closeBtn,
      onRequestClose: hide
    });
  }

  function hide() {
    if (!_isOpen || !_overlay) return;
    const ref = _overlay;
    _overlay = null;
    _isOpen = false;
    _isClosing = true;
    if (_trigger) _trigger.setAttribute('aria-expanded', 'false');
    _trigger = null;
    window.AgentXModalAccessibility.deactivate(ref);
    ref.classList.add('is-closing');
    setTimeout(() => {
      if (ref && ref.parentNode) ref.parentNode.removeChild(ref);
      _isClosing = false;
    }, 200);
  }

  // ── Global Ctrl+/ handler ───────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      _isOpen ? hide() : show();
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', configureShortcutTriggers, { once: true });
  } else {
    configureShortcutTriggers();
  }

  return {
    show,
    hide,
    isOpen: () => _isOpen,
    setShortcuts,
    addCategory
  };
})();

// window.ShortcutsHelpModal already assigned above via ||= pattern
