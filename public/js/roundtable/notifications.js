/**
 * Roundtable Notifications
 * Browser Notification API + webhook config persistence.
 */

const NOTIFY_STORAGE_KEY = 'roundtableNotifyConfig';

/**
 * Initialize notifications module
 * @param {Object} deps - { $ }
 * @returns {Object}
 */
export function initNotifications(deps) {
  const { $ } = deps;

  function loadNotifyConfig() {
    try {
      const raw = localStorage.getItem(NOTIFY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function saveNotifyConfig() {
    try {
      const config = {
        browser: $.rtNotifyBrowser?.checked ?? true,
        slack: $.rtNotifySlack?.value?.trim() || '',
        webhook: $.rtNotifyWebhook?.value?.trim() || ''
      };
      localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(config));
    } catch { /* ignore */ }
  }

  function restoreNotifyConfig() {
    const config = loadNotifyConfig();
    if ($.rtNotifyBrowser) $.rtNotifyBrowser.checked = config.browser !== false;
    if ($.rtNotifySlack && config.slack) $.rtNotifySlack.value = config.slack;
    if ($.rtNotifyWebhook && config.webhook) $.rtNotifyWebhook.value = config.webhook;

    $.rtNotifyBrowser?.addEventListener('change', saveNotifyConfig);
    $.rtNotifySlack?.addEventListener('change', saveNotifyConfig);
    $.rtNotifyWebhook?.addEventListener('change', saveNotifyConfig);
  }

  function getNotifyPayload() {
    const payload = {};
    const slack = $.rtNotifySlack?.value?.trim();
    const webhook = $.rtNotifyWebhook?.value?.trim();
    if (slack) payload.slack = slack;
    if (webhook) payload.webhook = webhook;
    return Object.keys(payload).length > 0 ? payload : null;
  }

  function requestBrowserNotificationPermission() {
    if (!$.rtNotifyBrowser?.checked) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function sendBrowserNotification(doc) {
    if (!$.rtNotifyBrowser?.checked) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const status = doc.status === 'completed' ? 'Completed' : 'Failed';
    const question = doc.question.substring(0, 80);

    new Notification(`Roundtable ${status}`, {
      body: question,
      icon: '/favicon.ico',
      tag: `roundtable-${doc._id}`
    });
  }

  return {
    restoreNotifyConfig,
    getNotifyPayload,
    requestBrowserNotificationPermission,
    sendBrowserNotification
  };
}
