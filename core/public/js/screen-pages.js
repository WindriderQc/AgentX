/* Node and browser share the validator. Models name IDs, never addresses. */
(function (root) {
  'use strict';
  const STATUSES = Object.freeze(['queued', 'in_progress', 'review', 'blocked', 'done']);
  const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const fallback = [{ id: 'pipeline', label: 'Pipeline', href: '/pipeline', mode: 'frame' }];
  // DiskX animation list (GraphysX <diskx-city play>): presentation steps only, never actions.
  const SHOW_SCENES = Object.freeze(['overview', 'duplicates', 'pairs', 'target', 'summary']);
  function diskxPlay(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return null;
    const words = value.split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
    if (!words.length || words.length > 24) return null;
    const known = word => SHOW_SCENES.includes(word) || /^tour-(?:[1-9]|1\d|20)$/.test(word) || /^group-[a-f0-9]{64}$/.test(word);
    return words.every(known) ? words.join(',') : null;
  }
  // GraphysX owns the tour and node catalogue. Core validates its bounded presentation grammar.
  const ECOSYSTEM_SCENES = Object.freeze(['overview', 'frank', 'services', 'alien', 'brutal', 'network', 'edge', 'spare', 'voice', 'image', 'memory', 'garage', 'watch', 'summary']);
  function ecosystemPlay(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return null;
    const words = value.split(',').map(word => word.trim().toLowerCase());
    return words.length <= 32 && words.every(word => ECOSYSTEM_SCENES.includes(word) || /^node-[a-z0-9][a-z0-9-]{0,63}$/.test(word)) ? words.join(',') : null;
  }
  function destination(value) {
    if (!value || !ID.test(value.id) || typeof value.label !== 'string' || !value.label.trim()
        || value.label.length > 80 || /[\u0000-\u001f\u007f]/.test(value.label)
        || typeof value.href !== 'string' || value.href.length > 2048
        || /[\u0000-\u0020\u007f\\]/.test(value.href)) return null;
    const relative = value.href.startsWith('/') && !value.href.startsWith('//');
    if (!relative && !/^https?:\/\//.test(value.href)) return null;
    try {
      const url = new URL(value.href, 'https://agentx.invalid');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return Object.freeze({ id: value.id, label: value.label.trim(),
        href: relative ? url.pathname + url.search + url.hash : url.href,
        mode: value.mode === 'frame' ? 'frame' : 'link', ...(value.conversation === true && { conversation: true }) });
    } catch { return null; }
  }
  function canonical(target) {
    return target ? [target.page, ...Object.entries(target.focus || {}).map(([key, value]) => `${key}=${value}`)].join(' ') : '';
  }
  function createCatalog(entries = fallback) {
    const records = Object.create(null);
    for (const value of (Array.isArray(entries) ? entries : []).slice(0, 100)) {
      const row = destination(value);
      if (row && !records[row.id]) records[row.id] = row;
    }
    const PAGES = Object.freeze(records);
    function parse(body) {
      const words = String(body || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const page = Object.hasOwn(PAGES, words[0]) ? words[0] : '';
      if (!page) return null;
      const focus = {};
      if (page === 'pipeline') for (const word of words.slice(1)) {
        const [key, value = ''] = word.split('=');
        if (key === 'status' && STATUSES.includes(value) || key === 'task' && /^\d{3,4}$/.test(value)) focus[key] = value;
      }
      if (page === 'diskx') for (const word of words.slice(1)) {
        const [key, value = ''] = word.split('=');
        if (key === 'group' && /^[a-f0-9]{64}$/.test(value)) focus.group = value;
        if (key === 'play' && diskxPlay(value)) focus.play = diskxPlay(value);
        if (key === 'report' && /^\d{4}-\d\d-\d\dt\d\d:\d\d:\d\d(?:\.\d{1,3})?z$/.test(value)
            && Number.isFinite(Date.parse(value))) focus.report = new Date(value).toISOString();
      }
      if (page === 'ecosystem') for (const word of words.slice(1)) {
        if (!word.startsWith('play=') || !ecosystemPlay(word.slice(5))) return null;
        focus.play = ecosystemPlay(word.slice(5));
      }
      if (page === 'personal-calendar') for (const word of words.slice(1)) {
        const [key, value = ''] = word.split('=');
        if (['start', 'end'].includes(key) && /^\d{4}-\d\d-\d\d$/.test(value)
            && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value) focus[key] = value;
      }
      return { page, focus };
    }
    function url(target, { screen = true } = {}) {
      const parsed = target && parse(canonical(target)), page = parsed && PAGES[parsed.page];
      if (!page) return '';
      if (page.mode !== 'frame' || !page.href.startsWith('/')) return page.href;
      const resolved = new URL(page.href, 'https://agentx.invalid');
      if (screen) resolved.searchParams.set('view', 'screen');
      resolved.searchParams.set('from', 'nestor');
      for (const [key, value] of Object.entries(parsed.focus)) resolved.searchParams.set(key, value);
      return resolved.pathname + resolved.search + resolved.hash;
    }
    const label = target => target && PAGES[target.page]?.label || '';
    const mode = target => target && PAGES[target.page]?.mode || 'link';
    const keepsConversation = target => target && PAGES[target.page] && !PAGES[target.page].conversation;
    return Object.freeze({ PAGES, STATUSES, parse, canonical, url, label, mode, keepsConversation, entries: Object.freeze(Object.values(PAGES)) });
  }
  let current = createCatalog();
  const api = Object.freeze({ STATUSES, SHOW_SCENES, ECOSYSTEM_SCENES, diskxPlay, ecosystemPlay, createCatalog, destination, canonical,
    configure(entries) { current = createCatalog(entries); },
    get PAGES() { return current.PAGES; }, get entries() { return current.entries; },
    parse: body => current.parse(body), url: (target, options) => current.url(target, options),
    label: target => current.label(target), mode: target => current.mode(target), keepsConversation: target => current.keepsConversation(target) });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXScreenPages = api;
})(typeof window === 'undefined' ? globalThis : window);
