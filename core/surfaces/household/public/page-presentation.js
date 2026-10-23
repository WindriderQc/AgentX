'use strict';

// Personal pages have their own workspace. Keep frames in place when switching
// layouts so their scroll position, forms and running interface survive.
(function exposePagePresentation(root) {
  function mount({ visual }) {
    const layout = visual.closest?.('.conversation-layout');
    if (!layout) return null;
    const region = document.createElement('section');
    region.className = 'page-presentation';
    region.hidden = true;
    region.setAttribute('aria-label', 'Page et conversation');
    region.innerHTML = `<header class="page-presentation-toolbar">
      <label>Page affichée <select aria-label="Page affichée"></select></label>
      <button type="button" class="button" aria-expanded="false" aria-controls="conversationPageBoard">Afficher la page</button>
    </header><section id="conversationPageBoard" class="page-presentation-board conversation-board"></section>`;
    layout.prepend(region);
    const board = region.querySelector('.page-presentation-board');
    const picker = region.querySelector('select');
    const toggle = region.querySelector('button');
    let cards = [], latest = null, selected = null;

    function present(active) {
      region.classList.toggle('is-active', active);
      toggle.textContent = active ? 'Retour à la conversation' : 'Afficher la page';
      toggle.setAttribute('aria-expanded', String(active));
      board.hidden = !active;
      root.dispatchEvent(new CustomEvent('nestor-page-presentation'));
      if (active) root.scrollTo({ top: 0, behavior: 'instant' });
    }
    function select(card) {
      selected = card;
      cards.forEach(item => { item.hidden = item !== card; });
      picker.value = String(cards.indexOf(card));
    }
    toggle.addEventListener('click', () => present(!region.classList.contains('is-active')));
    picker.addEventListener('change', () => select(cards[Number(picker.value)]));

    // The app replaces its root on navigation; release temporary avatar layout.
    const observer = new MutationObserver(() => {
      if (region.isConnected) return;
      observer.disconnect();
      root.dispatchEvent(new CustomEvent('nestor-page-presentation'));
    });
    observer.observe(layout.closest('#app'), { childList: true });
    return { board, update(next) {
      cards = next;
      region.hidden = !cards.length;
      picker.replaceChildren(...cards.map((card, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = card.querySelector('.display-block-title')?.textContent
          || root.AgentXScreenPages.label(card._screenTarget);
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
