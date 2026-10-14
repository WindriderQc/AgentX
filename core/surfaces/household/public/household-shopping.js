/* One shared list, owned by Core. The family screen adds; parent screens check purchases. */
(function () {
  'use strict';
  function mount({ host, api, esc, canBuy = false, language = 'en' }) {
    const french = {
      'Shopping list': 'Liste de courses', 'The same list for the family and Nestor.': 'La liste partagée avec la famille et Nestor.',
      'Item to add': 'Article à ajouter', 'Add an item…': 'Ajouter un article…', Add: 'Ajouter', Bought: 'Acheté',
      'Refresh list': 'Actualiser la liste', 'The list is empty. Add what the house is missing.': 'La liste est vide. Ajoutez ce qui manque à la maison.',
      'Loading the list…': 'Lecture de la liste…', 'Saving…': 'Enregistrement…',
      'Could not refresh. The list shown may have changed. Try again.': 'Actualisation impossible. Réessayez pour vérifier la liste.',
      'List unavailable. Try again with Refresh list.': 'Liste indisponible. Utilisez « Actualiser la liste » pour réessayer.',
      'This item is already on the list.': 'Cet article est déjà dans la liste.', 'Item added.': 'Article ajouté.',
      'This item has already left the list.': 'Cet article a déjà quitté la liste.', 'Item marked as bought.': 'Article marqué comme acheté.',
      'Save not confirmed. Refresh the list before trying again.': 'Enregistrement non confirmé. Actualisez la liste avant de réessayer.'
    };
    const t = text => language === 'fr' ? french[text] || text : text;
    host.innerHTML = `<details class="household-shopping"><summary><span>${t('Shopping list')}</span><span data-shopping-count class="pill">…</span></summary>
      <p class="muted">${t('The same list for the family and Nestor.')}</p>
      <form data-shopping-form class="shopping-form"><label class="sr-only" for="householdShoppingItem">${t('Item to add')}</label><input id="householdShoppingItem" data-shopping-input required maxlength="120" placeholder="${t('Add an item…')}" autocomplete="off"><button class="primary" type="submit">${t('Add')}</button></form>
      <p data-shopping-status role="status" aria-live="polite"></p><ul data-shopping-items class="shopping-items"></ul>
      <button data-shopping-refresh class="compact" type="button">${t('Refresh list')}</button></details>`;
    const input = host.querySelector('[data-shopping-input]');
    const status = host.querySelector('[data-shopping-status]');
    const list = host.querySelector('[data-shopping-items]');
    const buttons = () => host.querySelectorAll('button');
    let busy = false, loaded = false, request = 0;
    function render(items) {
      loaded = true;
      host.querySelector('[data-shopping-count]').textContent = `${items.length} article${items.length === 1 ? '' : 's'}`;
      list.innerHTML = items.length ? items.map(item => `<li><span>${esc(item)}</span>${canBuy ? `<button class="compact" type="button" data-shopping-bought="${esc(item)}" aria-label="${esc(language === 'fr' ? `Marquer ${item} comme acheté` : `Mark ${item} as bought`)}">${t('Bought')}</button>` : ''}</li>`).join('') : `<li class="muted">${t('The list is empty. Add what the house is missing.')}</li>`;
    }
    async function refresh() {
      if (busy) return;
      const current = ++request;
      status.textContent = t('Loading the list…');
      try {
        const data = await api('/api/family/shopping');
        if (current !== request) return;
        render(data.items); status.textContent = '';
      } catch {
        if (current === request) status.textContent = loaded
          ? t('Could not refresh. The list shown may have changed. Try again.')
          : t('List unavailable. Try again with Refresh list.');
      }
    }
    async function change(action, item) {
      if (busy) return;
      busy = true; ++request;
      buttons().forEach(button => { button.disabled = true; });
      status.textContent = t('Saving…');
      try {
        const data = await api(`/api/family/shopping/${action}`, { method: 'POST', body: JSON.stringify({ items: [item] }) });
        render(data.items);
        if (action === 'add') {
          if (input.value.trim() === item) input.value = '';
          status.textContent = data.alreadyThere?.length ? t('This item is already on the list.') : t('Item added.');
        } else status.textContent = data.notFound?.length ? t('This item has already left the list.') : t('Item marked as bought.');
      } catch {
        status.textContent = t('Save not confirmed. Refresh the list before trying again.');
      } finally { busy = false; buttons().forEach(button => { button.disabled = false; }); }
    }
    host.querySelector('[data-shopping-form]').onsubmit = event => {
      event.preventDefault(); const item = input.value.trim(); if (item) void change('add', item);
    };
    list.onclick = event => {
      const button = event.target.closest('[data-shopping-bought]');
      if (canBuy && button) void change('bought', button.dataset.shoppingBought);
    };
    host.querySelector('[data-shopping-refresh]').onclick = refresh;
    host.querySelector('details').addEventListener('toggle', () => { if (host.querySelector('details').open && !loaded) void refresh(); });
    return { refresh };
  }
  window.HouseholdShopping = { mount };
})();
