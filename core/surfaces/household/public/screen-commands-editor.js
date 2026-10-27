'use strict';

// See and edit the screen commands (#924): the built-in words for each action,
// plus the owner's own exact phrases, which Core keeps for every owner device.
(function exposeScreenCommandsEditor(root) {
  const ENDPOINT = '/api/voice-personas/private/screen-commands';

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function mount({ host, api, onChange = () => {} }) {
    const commands = root.NestorScreenCommands;
    if (!host || !commands) return { phrases: () => [] };
    let saved = { revision: 0, phrases: [] }, draft = [], available = false, busy = false;
    const button = node('button', 'button', 'Commandes');
    button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
    host.prepend(button);
    const dialog = node('dialog', 'screen-commands-dialog');
    dialog.setAttribute('aria-labelledby', 'screenCommandsTitle');
    dialog.innerHTML = `<form method="dialog"><header><h2 id="screenCommandsTitle">Commandes d’écran</h2>
      <button type="button" data-close aria-label="Fermer">×</button></header>
      <p class="screen-commands-help">Dites ou tapez une de ces phrases pendant qu’un contenu est affiché : l’écran change tout de suite, sans appeler Nestor.
      Seule la phrase entière compte, avec ou sans « Nestor » ou « s’il te plaît ». Une phrase plus longue reste une demande.</p>
      <div data-list></div>
      <fieldset class="screen-commands-add"><legend>Ajouter une phrase</legend>
        <label>Phrase <input data-phrase maxlength="80" autocomplete="off" placeholder="ex. plein pot"></label>
        <label>Action <select data-action></select></label>
        <button type="button" class="button" data-add>Ajouter</button></fieldset>
      <p data-status role="status" aria-live="polite"></p>
      <footer><button type="button" class="button" data-cancel>Annuler</button><button type="submit" class="button" data-save>Enregistrer</button></footer></form>`;
    document.body.append(dialog);
    const list = dialog.querySelector('[data-list]'), status = dialog.querySelector('[data-status]');
    const phraseInput = dialog.querySelector('[data-phrase]'), actionSelect = dialog.querySelector('[data-action]');
    actionSelect.replaceChildren(...Object.entries(commands.ACTIONS).map(([action, { label }]) => {
      const option = node('option', '', label); option.value = action; return option;
    }));

    function controls() {
      for (const control of dialog.querySelectorAll('input, select, [data-add], [data-save], [data-remove]')) control.disabled = busy || !available;
    }
    function render() {
      list.replaceChildren(...Object.entries(commands.ACTIONS).map(([action, { label, examples }]) => {
        const row = node('section', 'screen-commands-action');
        row.append(node('h3', '', label), node('p', 'screen-commands-builtin', examples.join(' · ')));
        const own = draft.filter(item => item.action === action);
        if (own.length) {
          const chips = node('ul', 'screen-commands-own');
          own.forEach(item => {
            const chip = node('li', '', item.phrase);
            const remove = node('button', '', '×');
            remove.type = 'button'; remove.dataset.remove = ''; remove.setAttribute('aria-label', `Retirer « ${item.phrase} »`);
            remove.addEventListener('click', () => { draft = draft.filter(entry => entry !== item); render(); });
            chip.append(remove); chips.append(chip);
          });
          row.append(chips);
        }
        return row;
      }));
      controls();
    }
    async function load() {
      try { saved = await api(ENDPOINT); available = true; }
      catch { available = false; }
      onChange(saved.phrases || []);
      return saved;
    }
    function add() {
      const next = [...draft, { phrase: phraseInput.value, action: actionSelect.value }];
      const checked = commands.validate(next);
      if (checked.error) { status.textContent = checked.error; return; }
      draft = checked.phrases; phraseInput.value = ''; status.textContent = 'Ajoutée. Enregistrez pour l’utiliser.';
      render(); phraseInput.focus();
    }

    button.addEventListener('click', async () => {
      status.textContent = 'Chargement…';
      await load();
      draft = [...(saved.phrases || [])];
      status.textContent = available ? '' : 'Vos phrases sont indisponibles pour le moment ; la liste intégrée fonctionne.';
      render(); dialog.showModal();
    });
    dialog.querySelector('[data-add]').addEventListener('click', add);
    phraseInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    for (const close of dialog.querySelectorAll('[data-close], [data-cancel]')) close.addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      busy = true; controls(); status.textContent = 'Enregistrement…';
      try {
        saved = await api(ENDPOINT, { method: 'PUT', body: JSON.stringify({ revision: saved.revision, phrases: draft }) });
        onChange(saved.phrases); status.textContent = 'Enregistré.'; dialog.close();
      } catch (error) { status.textContent = error.message || 'Enregistrement impossible.'; }
      finally { busy = false; controls(); }
    });
    void load();
    return { phrases: () => saved.phrases || [], open: () => button.click() };
  }

  root.NestorScreenCommandsEditor = Object.freeze({ mount, ENDPOINT });
}(typeof window !== 'undefined' ? window : globalThis));
