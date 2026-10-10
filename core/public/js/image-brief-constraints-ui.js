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
  function isValid() {
    try { contract.compose(getContext().prompt || '', getValue()); return true; } catch { return false; }
  }
  function refresh() {
    const context = getContext();
    $('image-constraint-add').disabled = context.locked || items.length >= contract.MAX_ITEMS;
    $('image-constraint-text').disabled = context.locked;
    $('image-constraint-kind').disabled = context.locked;
    for (const button of $('image-constraint-list').querySelectorAll('button')) button.disabled = context.locked;
    for (const input of $('image-constraint-list').querySelectorAll('textarea')) input.disabled = context.locked;
    try {
      const composed = contract.compose(context.prompt || '', getValue());
      $('image-constraints-counter').textContent = `${items.length} contrainte(s) · brief transmis : ${composed.length} / ${contract.MAX_PROMPT} caractères`;
      $('image-constraints-counter').dataset.invalid = 'false';
    } catch (error) {
      $('image-constraints-counter').textContent = error.message;
      $('image-constraints-counter').dataset.invalid = 'true';
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
