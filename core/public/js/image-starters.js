'use strict';
(() => {
  function mount({ getContext, apply }) {
    const $ = id => document.getElementById(id);
    const select = $('image-starter'), button = $('image-starter-apply');
    let starters = [];
    const current = () => starters.find(item => item.id === select.value);
    function refresh() {
      const item = current(), context = getContext();
      select.disabled = context.locked || !starters.length;
      button.disabled = context.locked || !item;
      $('image-starter-details').hidden = !item;
      if (!item) return;
      $('image-starter-description').textContent = item.description;
      const count = item.referenceCount;
      $('image-starter-references').textContent = `Point de départ : ${count} référence${count > 1 ? 's' : ''}. Actuellement : ${context.referenceCount}.`;
      const preferred = context.profiles.find(p => p.family === item.preferredFamily);
      $('image-starter-recipe').textContent = preferred ? `Recette suggérée : ${preferred.label}. Tu peux choisir une autre recette.` : '';
      $('image-starter-tips').replaceChildren(...item.tips.map(tip => {
        const row = document.createElement('li'); row.textContent = tip; return row;
      }));
      $('image-starter-replace').textContent = context.hasPrompt ? 'Ce bouton remplace le brief actuel. Les références et réglages restent sélectionnés.' : 'Le canevas prépare ton brief. Remplace les passages entre crochets avant de créer.';
    }
    select.addEventListener('change', refresh);
    button.addEventListener('click', () => {
      const item = current();
      if (!item || getContext().locked) return;
      apply(item.prompt); refresh();
    });
    const ready = (async () => {
      try {
        const response = await fetch('/data/image-starters.json');
        if (!response.ok) throw new Error('Les canevas sont indisponibles pour le moment.');
        const data = await response.json();
        if (data.version !== 1 || !Array.isArray(data.starters) || !data.starters.length) throw new Error('Les canevas sont indisponibles pour le moment.');
        starters = data.starters;
        for (const item of starters) {
          const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; select.append(option);
        }
        refresh();
      } catch { $('image-starter-status').textContent = 'Les canevas sont indisponibles pour le moment. Tu peux écrire ton brief directement.'; }
    })();
    refresh();
    return { refresh, ready };
  }
  globalThis.AgentXImageStarters = { mount };
})();
