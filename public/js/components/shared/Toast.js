/**
 * Toast Notification System
 * Displays temporary notification messages
 */

export class Toast {
  constructor(container) {
    this.container = container || document.getElementById('toastContainer');
    if (!this.container) {
      // Create container if it doesn't exist
      this.container = document.createElement('div');
      this.container.id = 'toastContainer';
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  }

  /**
   * Show a toast notification
   * @param {string} message - Message to display
   * @param {string} type - 'success', 'error', or 'info'
   * @param {number} duration - Duration in ms (default: 4000)
   */
  show(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // Icon based on type
    const iconMap = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      info: 'fa-info-circle'
    };

    toast.innerHTML = `
      <i class="fas ${iconMap[type] || iconMap.info}"></i>
      <span>${message}</span>
    `;

    this.container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Auto-remove after duration
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300); // Wait for fade-out animation
    }, duration);

    return toast;
  }

  /**
   * Show success toast
   */
  success(message, duration) {
    return this.show(message, 'success', duration);
  }

  /**
   * Show error toast
   */
  error(message, duration) {
    return this.show(message, 'error', duration);
  }

  /**
   * Show info toast
   */
  info(message, duration) {
    return this.show(message, 'info', duration);
  }
}
