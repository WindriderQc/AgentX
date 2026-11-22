(function () {
  'use strict';
  const panel = document.querySelector('[data-infrastructure]');
  if (!panel) return;
  const scene = window.HouseXScenes?.get(panel.querySelector('[data-network-scene]'));
  if (!scene || !window.PollingController) return;

  const labels = Object.freeze({
    online: 'Joignable', busy: 'Occupé', parked: 'En veille', degraded: 'Dégradé',
    offline: 'Non joignable', unknown: 'Indéterminé', stale: 'Relevé expiré'
  });
  const scopes = Object.freeze({
    inference_endpoints: 'Points d’inférence', product_service: 'Service AgentX'
  });
  const controls = new Map(Array.from(panel.querySelectorAll('[data-pin]'), button => [button.dataset.pin, button]));
  const title = panel.querySelector('[data-observed-node]');
  const stateLine = panel.querySelector('[data-node-state]');
  const sourceLine = panel.querySelector('[data-node-source]');
  const timeLine = panel.querySelector('[data-node-time]');
  const format = new Intl.DateTimeFormat('fr-CA', {
    dateStyle:'short', timeStyle:'medium', timeZone:panel.dataset.timezone
  });
  let selected = controls.keys().next().value, observations = new Map();
  let request, expiration, checked = false, intersects = true, pageActive = true;

  const updateText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const visible = () => pageActive && intersects && !panel.hidden && !document.hidden;

  function displayState(node, now) {
    if (!node) return 'unknown';
    if (node.freshness === 'stale' || node.freshness === 'current' && node.expiresAt <= now) return 'stale';
    return node.freshness === 'current' ? node.state : 'unknown';
  }

  function render() {
    clearTimeout(expiration);
    const now = Date.now();
    const colors = new Map();
    const node = observations.get(selected);
    for (const [id, button] of controls) {
      const state = displayState(observations.get(id), now);
      colors.set(id, state);
      button.dataset.liveState = state;
      button.setAttribute('aria-pressed', String(id === selected));
    }
    scene.setObservations(colors);
    updateText(title, controls.get(selected).textContent);
    updateText(stateLine, checked ? labels[displayState(node, now)] : 'En attente d’un relevé');
    updateText(sourceLine, node?.scope || 'Indisponible');
    updateText(timeLine, node?.observedAt ? format.format(node.observedAt) : 'Indisponible');
    const next = Math.min(...Array.from(observations.values(), value => value.expiresAt).filter(value => value > now));
    if (visible() && Number.isFinite(next)) expiration = setTimeout(render, next - now + 20);
  }

  async function refresh() {
    if (!visible() || request) return;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/nerve-center/ecosystem/live', { cache:'no-store', signal:controller.signal });
      if (!response.ok) return;
      const { status, data } = await response.json();
      if (status !== 'success' || !/^agentx\.ecosystem-live\/v[12]$/.test(data?.contract)
          || !Array.isArray(data.nodes) || request !== controller || !visible()) return;
      const globalExpiry = Date.parse(data.expiresAt);
      if (!Number.isFinite(globalExpiry)) return;
      const next = new Map();
      for (const row of data.nodes) {
        if (!controls.has(row?.id) || !Object.hasOwn(scopes, row.source)) continue;
        const observedAt = Date.parse(row.observedAt);
        const expiresAt = Date.parse(row.expiresAt);
        next.set(row.id, {
          scope:scopes[row.source],
          freshness:row.freshness === 'current' && !Number.isFinite(observedAt) ? 'unknown' : row.freshness,
          state:Object.hasOwn(labels, row.state) ? row.state : 'unknown',
          observedAt:Number.isFinite(observedAt) ? observedAt : null,
          expiresAt:Math.min(globalExpiry, Number.isFinite(expiresAt) ? expiresAt : 0)
        });
      }
      observations = next;
    } catch {
      // An interrupted refresh cannot make a previous reading newer.
    } finally {
      clearTimeout(timeout);
      if (request === controller) {
        request = null;
        if (visible()) { checked = true; render(); }
      }
    }
  }

  const poller = new window.PollingController();
  poller.addTask('housex-ecosystem', refresh, 10000);
  function synchronize() {
    if (visible()) {
      render();
      poller.start();
    } else {
      request?.abort();
      request = null;
      clearTimeout(expiration);
      poller.stop();
    }
  }
  for (const [id, button] of controls) button.addEventListener('click', () => {
    if (id === selected) return;
    selected = id;
    scene.focus(id);
    render();
  });
  document.addEventListener('housex-view-changed', synchronize);
  document.addEventListener('visibilitychange', synchronize);
  window.addEventListener('pagehide', () => { pageActive = false; synchronize(); });
  window.addEventListener('pageshow', () => { pageActive = true; synchronize(); });
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(entries => {
      intersects = entries.some(entry => entry.isIntersecting);
      synchronize();
    }).observe(panel);
  }
  synchronize();
})();
