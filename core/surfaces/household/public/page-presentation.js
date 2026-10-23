'use strict';

// All personal content shares one workspace. Keep frames in place when switching
// layouts so their scroll position, forms and running interface survive.
(function exposePagePresentation(root) {
  function mount({ visual }) {
    const layout = visual.closest?.('.conversation-layout');
    if (!layout) return null;
    const region = document.createElement('section');
    region.className = 'page-presentation';
    region.hidden = true;
    region.setAttribute('aria-label', 'Contenu et conversation');
    region.innerHTML = `<header class="page-presentation-toolbar">
      <label>Contenu <select aria-label="Contenu affiché"></select></label>
      <div class="page-presentation-actions">
        <button type="button" class="button" data-action="expand" aria-pressed="false">Agrandir</button>
        <button type="button" class="button" data-action="toggle" aria-expanded="false" aria-controls="conversationPageBoard">Afficher le contenu</button>
      </div>
    </header><section id="conversationPageBoard" class="page-presentation-board conversation-board"></section>`;
    layout.prepend(region);
    const board = region.querySelector('.page-presentation-board');
    const picker = region.querySelector('select');
    const toggle = region.querySelector('[data-action="toggle"]');
    const expand = region.querySelector('[data-action="expand"]');
    let cards = [], latest = null, selected = null;

    function present(active) {
      region.classList.toggle('is-active', active);
      toggle.textContent = active ? 'Fermer le contenu' : 'Afficher le contenu';
      toggle.setAttribute('aria-expanded', String(active));
      board.hidden = !active;
      expand.hidden = !active;
      root.dispatchEvent(new CustomEvent('nestor-page-presentation'));
      if (!active) {
        region.classList.remove('is-expanded'); expand.setAttribute('aria-pressed', 'false'); expand.textContent = 'Agrandir';
      }
    }
    function select(card) {
      selected = card;
      cards.forEach(item => { item.hidden = item !== card; });
      picker.value = String(cards.indexOf(card));
    }
    toggle.addEventListener('click', () => present(!region.classList.contains('is-active')));
    picker.addEventListener('change', () => { select(cards[Number(picker.value)]); present(true); });
    expand.addEventListener('click', () => {
      const expanded = region.classList.toggle('is-expanded');
      expand.setAttribute('aria-pressed', String(expanded)); expand.textContent = expanded ? 'Réduire' : 'Agrandir';
    });
    region.addEventListener('keydown', event => {
      if (event.key === 'Escape' && region.classList.contains('is-active')) {
        event.preventDefault(); present(false); toggle.focus();
      }
    });

    // The app replaces its root on navigation; release temporary avatar layout.
    const observer = new MutationObserver(() => {
      if (region.isConnected) return;
      observer.disconnect();
      root.dispatchEvent(new CustomEvent('nestor-page-presentation'));
    });
    observer.observe(layout.closest('#app'), { childList: true });
    return { board, active: () => region.classList.contains('is-active'), update(next) {
      cards = next;
      region.hidden = !cards.length;
      picker.replaceChildren(...cards.map((card, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = card.querySelector('.display-block-title')?.textContent
          || (card._screenTarget && root.AgentXScreenPages.label(card._screenTarget))
          || ({ text: 'Note', list: 'Liste', table: 'Tableau', code: 'Code', image: 'Image', scene: 'Scène', secret: 'Secret', link: 'Lien' }[card.dataset.kind] || 'Contenu');
        return option;
      }));
      if (!cards.length) { latest = selected = null; present(false); return; }
      const added = cards[0] !== latest;
      select(added || !cards.includes(selected) ? cards[0] : selected);
      latest = cards[0];
      if (added) present(true);
      else board.hidden = !region.classList.contains('is-active');
    } };
  }
  root.NestorPagePresentation = Object.freeze({ mount });
}(typeof window !== 'undefined' ? window : globalThis));
