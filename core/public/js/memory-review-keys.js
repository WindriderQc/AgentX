/**
 * Dreaming Review keyboard handling. J/K move between candidates; A/R/D/E act
 * only on the candidate that holds focus, never on a default one, so a stray
 * key press cannot open a decision for a memory the owner is not looking at.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MemoryReviewKeys = api;
}(typeof window !== 'undefined' ? window : null, () => {
  const ACTIONS = Object.freeze({ a: 'approve', r: 'reject', d: 'defer', e: 'edit_approve' });

  // index is the focused candidate's position, or -1 when focus is elsewhere.
  function resolveShortcut(key, { count, index }) {
    const pressed = String(key || '').toLowerCase();
    if (!count) return null;
    if (pressed === 'j' || pressed === 'k') {
      if (index < 0) return { move: 0 };
      return { move: Math.max(0, Math.min(count - 1, index + (pressed === 'j' ? 1 : -1))) };
    }
    const action = ACTIONS[pressed];
    return action && index >= 0 ? { action } : null;
  }

  // Keeps Tab and Shift+Tab inside an open dialog.
  function trapTab(event, container) {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll('button:not(:disabled), textarea:not([hidden])')]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return Object.freeze({ ACTIONS, resolveShortcut, trapTab });
}));
