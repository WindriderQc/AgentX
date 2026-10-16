/** Human summary and progressive disclosure for product analytics. */
(function () {
  'use strict';

  var cockpit;
  var surface;

  function text(id) {
    return document.getElementById(id)?.textContent.trim() || '';
  }

  function parseCompactNumber(value) {
    var match = String(value || '')
      .trim()
      .match(/-?\d{1,3}(?:[,\s\u00a0\u202f]\d{3})+(?:\.\d+)?(?:\s*[kmb](?![a-z]))?|-?\d+(?:\.\d+)?(?:\s*[kmb](?![a-z]))?/i);
    if (!match) return null;

    // Accept locale group separators (1 234, 1,234) as well as compact units.
    var compact = match[0].replace(/[,\s\u00a0\u202f]/g, '');
    var suffix = compact.slice(-1).toLowerCase();
    var multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix] || 1;
    var numericText = multiplier === 1 ? compact : compact.slice(0, -1);
    var parsed = Number(numericText);
    return Number.isFinite(parsed) ? parsed * multiplier : null;
  }

  function number(id) {
    return parseCompactNumber(text(id));
  }

  function formatCount(value) {
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
  }

  function observedLabel(value) {
    var label = String(value || '').trim();
    if (!label || /^(?:—|--|n\/?a|unknown|loading…?)$/i.test(label)) return null;
    return label;
  }

  /**
   * Knowledge-usage phrase for the cockpit summary. The tile carries the
   * Signal Evidence Contract state on data attributes; a low-sample rate is
   * repeated with its n, and a non-measured state is never phrased as usage.
   */
  function knowledgeUsagePhrase(label, state, sample) {
    var observed = observedLabel(label);
    if (!observed) return null;
    if (state && state !== 'observed' && state !== 'insufficient_sample') return null;
    if (state === 'insufficient_sample') {
      return observed + ' of conversations used knowledge (low sample' + (sample ? ', ' + sample : '') + ')';
    }
    return observed + ' of conversations used knowledge';
  }

  function refreshSummary() {
    var conversations = number('totalConversations');
    var messages = number('totalMessages');
    var ragUsageElement = document.getElementById('ragUsage');
    var ragUsage = knowledgeUsagePhrase(text('ragUsage'), ragUsageElement?.dataset.signalState, ragUsageElement?.dataset.signalSample);
    var documents = number('ragTotalDocs');
    var windowLabel = document.querySelector('#analyticsWindow option:checked')?.textContent.toLowerCase() || 'selected period';

    document.getElementById('analytics-chat-detail').textContent = conversations == null
      ? 'Counted when Explore the details is opened'
      : formatCount(conversations) + ' conversation' + (conversations === 1 ? '' : 's') + ' · ' + formatCount(messages || 0) + ' messages';
    document.getElementById('analytics-knowledge-detail').textContent = documents == null
      ? (ragUsage ? ragUsage + ' · ' + windowLabel : 'Counted when Explore the details is opened')
      : formatCount(documents) + ' document' + (documents === 1 ? '' : 's') + ' indexed · ' + (ragUsage || 'usage not observed') + ' · ' + windowLabel;
  }

  function syncCockpitAccessibility() {
    surface.inert = !cockpit.open;
    if (cockpit.open) surface.removeAttribute('aria-hidden');
    else surface.setAttribute('aria-hidden', 'true');
  }

  function openTo(targetId) {
    if (targetId === 'chatLaneHeading') document.dispatchEvent(new CustomEvent('analytics:show-chat-lane'));
    cockpit.open = true;
    syncCockpitAccessibility();
    requestAnimationFrame(function () {
      var target = document.getElementById(targetId);
      if (!target) return;
      target.tabIndex = -1;
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
    });
  }

  function refreshAll() {
    document.dispatchEvent(new Event('analytics:refresh-live'));
    ['infRefreshBtn', 'refreshBtn'].forEach(function (id) {
      document.getElementById(id)?.click();
    });
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', function () {
    cockpit = document.getElementById('analytics-cockpit');
    surface = cockpit.querySelector('.analytics-cockpit-surface');

    cockpit.addEventListener('toggle', syncCockpitAccessibility);
    document.querySelectorAll('[data-analytics-target]').forEach(function (button) {
      button.addEventListener('click', function () { openTo(button.dataset.analyticsTarget); });
    });
    document.getElementById('analytics-experience-refresh').addEventListener('click', refreshAll);
    ['infCalls', 'infErrors', 'infCancellations', 'infErrorRate', 'totalConversations', 'totalMessages', 'ragUsage', 'ragTotalDocs'].forEach(function (id) {
      var element = document.getElementById(id);
      if (element) new MutationObserver(refreshSummary).observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-signal-state', 'data-signal-sample'] });
    });

    syncCockpitAccessibility();
    refreshSummary();
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseCompactNumber: parseCompactNumber,
      observedLabel: observedLabel,
      knowledgeUsagePhrase: knowledgeUsagePhrase
    };
  }
})();
