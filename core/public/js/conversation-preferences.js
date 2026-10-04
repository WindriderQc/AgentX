/* Shared editor for Core-owned optional conversation work. No content is stored in the browser. */
(function (root) {
  'use strict';
  function mount({ button, api, endpoint, title = 'Contexte et performance', onSaved = () => {}, integrations = [], note = '' }) {
    const doc = button.ownerDocument, dialog = doc.createElement('dialog');
    dialog.className = 'conversation-preferences-dialog'; dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<form><header><div><h2></h2><p>Choisis les ajouts utiles à tes échanges.</p></div><button type="button" data-close aria-label="Fermer">×</button></header>
      <p data-scope></p><p data-note class="conversation-preferences-help" hidden></p><div class="conversation-preferences-presets"><button type="button" data-light>Allégé</button><button type="button" data-reload>Recharger</button><button type="button" data-default>Par défaut</button></div>
      <p class="conversation-preferences-help">Allégé coupe les ajouts facultatifs. Par défaut reprend les réglages initiaux de cet espace. Tes données restent conservées.</p>
      <div data-groups></div><div data-integrations></div><p class="conversation-preferences-help">Les contrôles d’accès, d’intégrité et de sécurité restent actifs. Un calcul déjà lancé peut finir ; son résultat est écarté si les réglages ont changé.</p>
      <p data-status role="status" aria-live="polite"></p><footer><button type="button" data-cancel>Annuler</button><button type="submit">Enregistrer les réglages</button></footer></form>`;
    dialog.querySelector('h2').textContent = title; doc.body.append(dialog);
    if (note) { const node = dialog.querySelector('[data-note]'); node.hidden = false; node.textContent = note; }
    const form = dialog.querySelector('form'), groups = dialog.querySelector('[data-groups]'), status = dialog.querySelector('[data-status]');
    let epoch = 0, snapshot = null, draft = {}, busy = false;
    const endpointFor = () => typeof endpoint === 'function' ? endpoint() : endpoint;
    const resolved = key => Object.hasOwn(draft, key) ? draft[key] : snapshot.defaults[key];
    function working(value) { busy = value; for (const control of form.querySelectorAll('input, button:not([data-close]):not([data-cancel])')) control.disabled = value; }
    function render() {
      groups.replaceChildren();
      const labels = { playground: 'Playground', psyx: 'PsyX', nestor: 'Nestor personnel', family: 'Famille · contrôle parental' };
      dialog.querySelector('[data-scope]').textContent = `Réglages pour ${labels[snapshot.surface] || snapshot.surface} · appliqués aux prochains échanges.`;
      for (const group of [...new Set(snapshot.catalog.map(item => item.group))]) {
        const items = snapshot.catalog.filter(item => item.group === group), details = doc.createElement('details');
        const summary = doc.createElement('summary'); details.append(summary);
        const count = () => { summary.textContent = `${items[0].groupTitle} · ${items.filter(item => item.type !== 'number' && resolved(item.key)).length}/${items.filter(item => item.type !== 'number').length} sélectionnés`; };
        count(); details.open = group === 'background' || snapshot.catalog.length <= 5;
        for (const item of items) {
          const label = doc.createElement('label'); label.className = 'conversation-preference-option';
          const input = doc.createElement('input'); input.type = item.type === 'number' ? 'number' : 'checkbox'; input.name = item.key; input.disabled = busy;
          if (item.type === 'number') { input.value = resolved(item.key); input.min = item.min; input.max = item.max; input.step = item.step; input.required = true; } else input.checked = resolved(item.key);
          const copy = doc.createElement('span'), heading = doc.createElement('strong'), description = doc.createElement('span'), cost = doc.createElement('small');
          heading.textContent = item.title; description.textContent = item.description; cost.textContent = item.cost;
          copy.append(heading, description, cost); label.append(input, copy); details.append(label);
          input.onchange = () => { draft[item.key] = item.type === 'number' ? Number(input.value) : input.checked; count(); status.textContent = 'Modifications à enregistrer.'; };
        }
        groups.append(details);
      }
    }
    async function open() {
      const token = ++epoch; snapshot = null; draft = {}; groups.replaceChildren(); status.textContent = 'Chargement des réglages…';
      working(true); if (!dialog.open) dialog.showModal();
      try {
        const data = await api(endpointFor()); if (token !== epoch || !dialog.open) return;
        snapshot = data; draft = { ...data.overrides }; render(); status.textContent = '';
      } catch (error) { if (token === epoch) status.textContent = error.message + ' · Ferme puis rouvre pour réessayer.'; }
      finally { if (token === epoch) working(false); }
    }
    button.onclick = () => void open();
    dialog.querySelector('[data-reload]').onclick = () => void open();
    dialog.querySelector('[data-light]').onclick = () => { if (!snapshot) return; draft = { ...draft, ...Object.fromEntries(snapshot.catalog.filter(item => item.type !== 'number').map(item => [item.key, false])) }; render(); status.textContent = 'Profil allégé prêt. Enregistre pour l’appliquer.'; };
    dialog.querySelector('[data-default]').onclick = () => { if (!snapshot) return; draft = {}; render(); status.textContent = 'Valeurs par défaut prêtes. Enregistre pour les appliquer.'; };
    for (const control of dialog.querySelectorAll('[data-close], [data-cancel]')) control.onclick = () => dialog.close();
    dialog.addEventListener('close', () => { epoch++; snapshot = null; draft = {}; groups.replaceChildren(); status.textContent = ''; working(false); });
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || !snapshot) return;
      const token = epoch; working(true); status.textContent = 'Enregistrement…';
      try {
        const data = await api(endpointFor(), { method: 'PUT', body: JSON.stringify({ revision: snapshot.revision, values: draft }) });
        if (token !== epoch || !dialog.open) return;
        snapshot = data; draft = { ...data.overrides }; render(); await onSaved(data);
        status.textContent = 'Réglages enregistrés. Ils s’appliquent aux prochains échanges.';
      } catch (error) { if (token === epoch) status.textContent = error.message; }
      finally { if (token === epoch) working(false); }
    };
    const links = dialog.querySelector('[data-integrations]');
    for (const item of integrations) {
      const link = doc.createElement('a'); link.textContent = item.title; link.href = item.href; links.append(link);
      if (item.action) link.onclick = event => { event.preventDefault(); dialog.close(); item.action(); };
    }
    return { open, clear() { epoch++; if (dialog.open) dialog.close(); groups.replaceChildren(); draft = {}; snapshot = null; status.textContent = ''; }, destroy() { this.clear(); dialog.remove(); } };
  }
  root.ConversationPreferences = { mount };
})(typeof window === 'undefined' ? globalThis : window);
