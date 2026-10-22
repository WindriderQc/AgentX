/* The same catalogue used by Nestor, reachable without a model turn. */
(function (root) {
  'use strict';
  function mount({ host, onShow, catalog = root.AgentXScreenPages }) {
    const details = document.createElement('details'); details.className = 'conversation-screen-picker';
    const summary = document.createElement('summary'); summary.textContent = 'Pages et services';
    const list = document.createElement('div'); list.className = 'conversation-screen-destinations';
    for (const entry of catalog?.entries || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button';
      button.textContent = entry.label;
      button.addEventListener('click', () => { onShow({ kind: 'page', body: entry.id, title: entry.label }); details.open = false; });
      list.append(button);
    }
    details.append(summary, list); host.append(details);
    return { dispose: () => details.remove() };
  }
  root.NestorScreenPicker = { mount };
})(typeof window === 'undefined' ? globalThis : window);
