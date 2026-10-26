/* The existing Core presentation surface reads the existing GraphysX tour, after rendering. */
(function () {
  'use strict';
  const view = document.querySelector('agentx-ecosystem');
  const status = document.getElementById('diskx-status');
  if (!view || !status) return;
  let unavailable = false;
  Object.defineProperty(window, 'AgentXPresentedContent', { configurable: true, get() {
    const observation = unavailable ? null : view.state?.()?.presentation;
    return { contract: 'agentx.presentation/v1', state: unavailable ? 'unavailable' : observation ? 'ready' : 'loading',
      ...(observation && { observation }) };
  } });
  for (const event of ['ready', 'scene-changed', 'node-selected']) view.addEventListener('ecosystem-' + event, () => {
    unavailable = false; status.hidden = true;
  });
  view.addEventListener('ecosystem-closed', () => { unavailable = true; status.hidden = false; status.textContent = 'Visite fermée.'; });
  view.addEventListener('ecosystem-error', event => {
    if (event.detail?.stage !== 'play') unavailable = true;
    status.hidden = false; status.classList.add('error');
    status.textContent = 'Visite indisponible : ' + String(event.detail?.message || 'erreur de présentation').slice(0, 200);
  });
  setTimeout(() => {
    if (!window.customElements?.get('agentx-ecosystem')) {
      unavailable = true; status.hidden = false; status.textContent = 'Le module installé ne prend pas encore en charge la visite accompagnée.';
    }
  }, 15000);
}());
