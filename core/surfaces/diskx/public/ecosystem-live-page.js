/* Core owns the feed. Refresh every node automatically; selection only chooses
   what to discuss. The GraphysX component acknowledges updates after rendering. */
(function () {
  'use strict';
  const view = document.querySelector('agentx-ecosystem[data-live-state="true"]');
  if (!view || !window.PollingController) return;
  let closed = false, generation = 0, controller = null, started = false;
  function visible() {
    try { return !closed && !document.hidden && (!window.frameElement || window.frameElement.getClientRects().length > 0); }
    catch { return false; }
  }
  function invalidate() {
    generation += 1;
    controller?.abort(); controller = null;
  }
  async function update() {
    if (!visible() || typeof view.setLiveState !== 'function') return;
    const version = ++generation;
    const abort = new AbortController(); controller = abort;
    const deadline = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetch('/api/nerve-center/ecosystem/live', { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error('Live state unavailable');
      const envelope = await response.json();
      if (version !== generation || !visible()) return;
      if (envelope.status !== 'success' || !view.setLiveState(envelope.data)) throw new Error('Live state refused');
    } catch {
      if (version === generation && visible()) view.setLiveState(null);
    } finally {
      clearTimeout(deadline);
      if (controller === abort) controller = null;
    }
  }
  const poller = new window.PollingController();
  poller.addTask('ecosystem-live', update, 10000);
  function start() {
    if (closed || started || !view.state?.()?.presentation) return;
    started = true;
    if (typeof view.setLiveState !== 'function') {
      const status = document.getElementById('diskx-status');
      if (status) { status.hidden = false; status.textContent = 'États AgentX indisponibles dans cette version de la carte.'; }
      return;
    }
    poller.start();
  }
  for (const event of ['ecosystem-ready', 'ecosystem-first-frame']) view.addEventListener(event, start);
  for (const event of ['ecosystem-closed', 'ecosystem-error']) view.addEventListener(event, input => {
    if (event === 'ecosystem-error' && input.detail?.stage === 'play') return;
    closed = true; invalidate(); poller.destroy(); observer?.disconnect();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) invalidate(); });
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) { invalidate(); return; }
    if (started) { poller.stop(); poller.start(); }
  }) : null;
  observer?.observe(view);
  window.addEventListener('pagehide', () => { invalidate(); poller.stop(); observer?.disconnect(); });
  window.addEventListener('pageshow', () => { if (started && !closed) { poller.start(); observer?.observe(view); } });
  start();
}());
