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
      $('image-starter-references').textContent = `Starting point: ${count} reference${count > 1 ? 's' : ''}. Currently: ${context.referenceCount}.`;
      const preferred = context.profiles.find(p => p.family === item.preferredFamily);
      $('image-starter-recipe').textContent = preferred ? `Suggested recipe: ${preferred.label}. You can choose another recipe.` : '';
      $('image-starter-tips').replaceChildren(...item.tips.map(tip => {
        const row = document.createElement('li'); row.textContent = tip; return row;
      }));
      $('image-starter-replace').textContent = context.hasPrompt ? 'This button replaces the current brief. References and settings stay selected.' : 'The template prepares your brief. Replace the bracketed passages before creating.';
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
        if (!response.ok) throw new Error('Templates are unavailable right now.');
        const data = await response.json();
        if (data.version !== 1 || !Array.isArray(data.starters) || !data.starters.length) throw new Error('Templates are unavailable right now.');
        starters = data.starters;
        for (const item of starters) {
          const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; select.append(option);
        }
        refresh();
      } catch { $('image-starter-status').textContent = 'Templates are unavailable right now. You can write your brief directly.'; }
    })();
    refresh();
    return { refresh, ready };
  }
  globalThis.AgentXImageStarters = { mount };
})();
