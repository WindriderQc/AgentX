/**
 * AgentX Shared Frontend Utilities
 * Canonical implementations of common helpers, always available as window.AgentXUtils.
 *
 * Loaded via footer-scripts.ejs before page-specific scripts.
 */
window.AgentXUtils = (() => {
  /**
   * Show a toast notification using the global Toast object.
   * @param {string} msg
   * @param {'info'|'success'|'warning'|'error'} type
   */
  function showToast(msg, type = 'info') {
    if (typeof Toast !== 'undefined' && typeof Toast[type] === 'function') {
      Toast[type](msg);
    } else {
      console.log(`[${type}] ${msg}`);
    }
  }

  /**
   * Escape HTML special characters to prevent XSS.
   * @param {*} str
   * @returns {string}
   */
  // Quotes are escaped too: callers put the result inside attribute values,
  // where an unescaped " would end the attribute (DOM textContent leaves quotes).
  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * Format a byte count as a human-readable string (e.g. "4.2 MB").
   * @param {number} bytes
   * @returns {string}
   */
  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes < 0) return '--';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  return { showToast, escapeHtml, formatBytes };
})();
