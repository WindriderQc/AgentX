/* Core pages Nestor may put on the personal screen. Shared by the reply
 * channels (Node) and the display board (browser): the model names a page and
 * a bounded focus, never a URL, and both sides rebuild the address here. */
(function (root) {
  'use strict';
  const STATUSES = Object.freeze(['queued', 'in_progress', 'review', 'blocked', 'done']);
  const PAGES = Object.freeze({
    pipeline: Object.freeze({
      path: '/pipeline',
      label: 'Pipeline',
      focus: Object.freeze({
        status: value => (STATUSES.includes(value) ? value : ''),
        task: value => (/^\d{3,4}$/.test(value) ? value : '')
      })
    })
  });

  // "pipeline status=blocked task=812" → { page, focus }. Unknown pages give
  // null; unknown or invalid focus words are dropped.
  function parse(body) {
    const words = String(body || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const page = Object.prototype.hasOwnProperty.call(PAGES, words[0]) ? words[0] : '';
    if (!page) return null;
    const focus = {};
    for (const word of words.slice(1)) {
      const [key, value = ''] = word.split('=');
      const check = Object.prototype.hasOwnProperty.call(PAGES[page].focus, key) ? PAGES[page].focus[key] : null;
      const clean = check ? check(value) : '';
      if (clean) focus[key] = clean;
    }
    return { page, focus };
  }

  function canonical(target) {
    if (!target) return '';
    return [target.page, ...Object.entries(target.focus || {}).map(([key, value]) => `${key}=${value}`)].join(' ');
  }

  // view=screen drops the navigation; from=nestor reuses the page's bounded focus.
  function url(target) {
    if (!target || !PAGES[target.page]) return '';
    const params = new URLSearchParams({ view: 'screen', from: 'nestor', ...(target.focus || {}) });
    return `${PAGES[target.page].path}?${params}`;
  }

  function label(target) {
    return target && PAGES[target.page] ? PAGES[target.page].label : '';
  }

  const api = Object.freeze({ PAGES, STATUSES, parse, canonical, url, label });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXScreenPages = api;
})(typeof window === 'undefined' ? globalThis : window);
