'use strict';
globalThis.AgentXImageConstraints = { mount({ getContext, onChange = () => {} }) {
  const $ = id => document.getElementById(id), contract = globalThis.ImageBriefConstraints;
  if (!$('image-constraints')) return { getValue: () => undefined, isValid: () => true, setValue() {}, reset() {}, refresh() {} };
  let items = [], next = 0;
  const node = (tag, text) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
  function getValue(options) {
    try { return contract.validate({ version: 1, items }); }
    catch (error) { if (options?.draft) return undefined; throw error; }
  }
  function isValid(options) {
    try {
      const prompt = getContext().prompt || '';
      if (prompt.length > (options?.forPlanning ? contract.MAX_BRIEF : contract.MAX_PROMPT)) return false;
      (options?.forPlanning ? contract.composeBrief : contract.compose)(prompt, getValue()); return true;
    } catch { return false; }
  }
  function refresh() {
    const context = getContext();
    $('image-constraint-add').disabled = context.locked || items.length >= contract.MAX_ITEMS;
    $('image-constraint-text').disabled = context.locked;
    $('image-constraint-kind').disabled = context.locked;
    for (const button of $('image-constraint-list').querySelectorAll('button')) button.disabled = context.locked;
    for (const input of $('image-constraint-list').querySelectorAll('textarea')) input.disabled = context.locked;
    const briefCounter = $('image-brief-counter'), format = value => new Intl.NumberFormat('fr-CA').format(value);
    try {
      const prompt = context.prompt || '', value = getValue(), suffix = contract.block(value);
      const length = contract.visual(prompt, value).length + (suffix ? suffix.length + 2 : 0);
      if (briefCounter) {
        briefCounter.textContent = `Brief conservé : ${format(prompt.length)} / ${format(contract.MAX_BRIEF)} caractères · rendu avec contraintes : ${format(length)} / ${format(contract.MAX_PROMPT)}.`;
        briefCounter.dataset.invalid = String(prompt.length > contract.MAX_PROMPT || length > contract.MAX_PROMPT);
        if (prompt.length > contract.MAX_BRIEF || length > contract.MAX_BRIEF) briefCounter.textContent += ' Réduis le brief avant de consulter Hermes ; tout le texte collé reste conservé.';
        else if (prompt.length > contract.MAX_PROMPT || length > contract.MAX_PROMPT) briefCounter.textContent += ' Création indisponible : le texte saisi ou le brief avec contraintes dépasse 8 000 caractères. Utilise « Affiner mon brief » avec Hermes, ou réduis le texte.';
      }
      if (prompt.length > contract.MAX_PROMPT) throw new Error('Le brief saisi dépasse 8 000 caractères. Utilise « Affiner mon brief » avec Hermes, ou réduis le texte.');
      const composed = contract.compose(prompt, value);
      $('image-constraints-counter').textContent = `${items.length} contrainte(s) · brief transmis : ${composed.length} / ${contract.MAX_PROMPT} caractères`;
      $('image-constraints-counter').dataset.invalid = 'false';
    } catch (error) {
      $('image-constraints-counter').textContent = error.message;
      $('image-constraints-counter').dataset.invalid = 'true';
      if (briefCounter && !isValid({ forPlanning: true })) {
        let reason = error.message;
        if ((context.prompt || '').length > contract.MAX_BRIEF) reason = 'Le brief dépasse 32 000 caractères. Réduis-le avant de consulter Hermes ; tout le texte collé reste conservé.';
        else { try { contract.composeBrief(context.prompt || '', getValue()); } catch (planningError) { reason = planningError.message; } }
        briefCounter.textContent = `Brief conservé : ${format((context.prompt || '').length)} / ${format(contract.MAX_BRIEF)} caractères. ${reason}`;
        briefCounter.dataset.invalid = 'true';
      }
    }
  }
  function render() {
    $('image-constraint-list').replaceChildren();
    for (const item of items) {
      const row = node('li'), label = node('label', contract.KINDS[item.kind]), input = node('textarea'), remove = node('button', 'Retirer');
      input.id = `image-constraint-${item.id}`; input.value = item.text; input.rows = 2; input.maxLength = contract.MAX_TEXT * 2;
      label.htmlFor = input.id; remove.type = 'button'; remove.setAttribute('aria-label', `Retirer la contrainte ${contract.KINDS[item.kind]}`);
      input.addEventListener('input', () => { item.text = input.value; refresh(); onChange(); });
      remove.addEventListener('click', () => { if (getContext().locked) return; items = items.filter(value => value.id !== item.id); render(); onChange(); });
      row.append(label, input, remove); $('image-constraint-list').append(row);
    }
    refresh();
  }
  $('image-constraint-add').addEventListener('click', () => {
    if (getContext().locked) return;
    try {
      const text = $('image-constraint-text').value;
      const id = globalThis.crypto?.randomUUID?.() || `constraint-${Date.now()}-${++next}`;
      const value = contract.validate({ version: 1, items: [...items, { id, kind: $('image-constraint-kind').value, text }] });
      items = value.items; $('image-constraint-text').value = ''; $('image-constraints-notice').textContent = ''; render(); onChange();
    } catch (error) { $('image-constraints-notice').textContent = error.message; }
  });
  return { getValue, isValid, refresh,
    setValue(value) { items = contract.validate(value)?.items || []; render(); onChange(); },
    reset() { items = []; $('image-constraint-text').value = ''; $('image-constraints-notice').textContent = ''; render(); onChange(); }
  };
} };
