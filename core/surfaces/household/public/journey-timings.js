/* Bounded browser observations only. No prompts, URLs, paths or transcripts. */
(function (root) {
  'use strict';
  function create({ now = () => root.performance.timeOrigin + root.performance.now() } = {}) {
    const requests = new Map(), presentations = new Map(), listeners = new Set();
    let active = null;
    const notify = () => { for (const fn of listeners) fn(); };
    function bounded(map, key, value) { map.set(key, value); if (map.size > 100) map.delete(map.keys().next().value); return value; }
    function begin(id) {
      active = id;
      if (requests.has(id)) return;
      bounded(requests, id, { id, requestedAt: now(), events: [], tools: [] }); notify();
    }
    function stream(id, event) {
      const row = requests.get(id); if (!row) return;
      const at = now();
      if (event.type === 'accepted') row.acceptedAt ??= at;
      if (event.type === 'delta') row.firstTextAt ??= at;
      if (event.type === 'status') {
        const activity = event.phase === 'activity' && event.activity;
        if (activity?.kind === 'processing') row.processingObservedAt ??= at;
        if (activity?.kind === 'tool') {
          row.tools.push({ tool: String(activity.tool || '').slice(0, 120), startedAt: at });
          if (row.tools.length > 100) row.tools.shift();
        }
        if (activity?.kind === 'tool_result') {
          const tool = row.tools.find(item => item.tool === activity.tool && !item.endedAt);
          if (tool) Object.assign(tool, { endedAt: at, state: activity.status });
        }
        if (row.events.length < 100) row.events.push({ phase: String(event.phase || '').slice(0, 40), at });
      }
      if (['done', 'error', 'interrupted'].includes(event.type)) {
        row.endedAt ??= at; row.outcome = event.type;
        if (active === id) active = null;
        const server = event.data?.serverTimings;
        if (server && typeof server === 'object') row.serverTimings = Object.fromEntries(Object.entries(server)
          .filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0));
      }
      notify();
    }
    function open(id, page) {
      const row = bounded(presentations, id, { id, page, requestId: active, openingAt: now() }); notify(); return row;
    }
    function mark(id, stage, at = now()) {
      const row = presentations.get(id);
      if (!row || !['frameLoadedAt', 'firstFrameAt', 'readyAt', 'errorAt'].includes(stage) || !Number.isFinite(at)) return;
      row[stage] ??= at; notify();
    }
    function absorb(id, child) {
      const row = presentations.get(id); if (!row || !child) return;
      for (const stage of ['firstFrameAt', 'readyAt', 'errorAt']) if (Number.isFinite(child[stage])) row[stage] ??= child[stage];
      if (child.navigation) row.navigation = child.navigation;
      if (child.module) row.module = child.module;
      notify();
    }
    const span = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
    function snapshot() {
      return JSON.parse(JSON.stringify({ contract: 'agentx.journey-timings/v1', clock: 'browser.timeOrigin+performance.now',
        requests: [...requests.values()].map(row => ({ ...row, demandMs: span(row.requestedAt, row.acceptedAt),
          requestToEndMs: span(row.requestedAt, row.endedAt), processingObservedMs: span(row.processingObservedAt, row.endedAt),
          tools: row.tools.map(tool => ({ ...tool, observedMs: span(tool.startedAt, tool.endedAt) })) })),
        presentations: [...presentations.values()].map(row => ({ ...row,
          openingToLoadMs: span(row.openingAt, row.frameLoadedAt), openingToFirstFrameMs: span(row.openingAt, row.firstFrameAt),
          loadToFirstFrameMs: span(row.frameLoadedAt, row.firstFrameAt),
          requestToOpeningMs: span(requests.get(row.requestId)?.requestedAt, row.openingAt),
          requestToFirstFrameMs: span(requests.get(row.requestId)?.requestedAt, row.firstFrameAt),
          openingToReadyMs: span(row.openingAt, row.readyAt) })) }));
    }
    return { begin, stream, open, mark, absorb, snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  }
  const api = create();
  api.create = create;
  root.AgentXJourneyTimings = api;
  if (typeof module === 'object' && module.exports) module.exports = { create };
  if (!root.document) return;
  // Installed on both page types before their module runs; events bubble after render.
  let pageId;
  function page() {
    if (pageId) return pageId;
    const view = root.document.querySelector('diskx-city,agentx-ecosystem');
    if (!view) return null;
    pageId = 'navigation'; api.open(pageId, view.tagName === 'DISKX-CITY' ? 'diskx' : 'ecosystem');
    return pageId;
  }
  function navigation() {
    const id = page(); if (!id) return;
    const entry = root.performance.getEntriesByType('navigation')[0];
    const module = root.performance.getEntriesByType('resource').find(item => new URL(item.name).pathname === '/api/diskx/diskx.js');
    api.absorb(id, { navigation: entry && { documentResponseMs: entry.responseEnd, domContentLoadedMs: entry.domContentLoadedEventEnd, loadMs: entry.loadEventEnd },
      module: module && { startMs: module.startTime, responseStartMs: module.responseStart, responseEndMs: module.responseEnd, durationMs: module.duration, transferSize: module.transferSize } });
  }
  for (const prefix of ['diskx', 'ecosystem']) {
    for (const [event, stage] of [['first-frame', 'firstFrameAt'], ['ready', 'readyAt'], ['error', 'errorAt']]) {
      root.document.addEventListener(`${prefix}-${event}`, e => {
        if (event === 'error' && e.detail?.stage === 'play') return;
        const id = page(); if (id) { api.mark(id, stage, e.detail?.at); navigation(); }
      });
    }
  }
  root.addEventListener('load', () => root.setTimeout(navigation, 0));
})(typeof window === 'undefined' ? globalThis : window);
