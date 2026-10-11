'use strict';
globalThis.AgentXImageTextPolicy = { mount({ getContext, onChange = () => {}, onAdvice = () => {} }) {
  const $ = id => document.getElementById(id), engine = globalThis.ImageTextPolicy;
  if (!$('image-text-policy') || !engine) return { getValue: () => undefined, getError: () => '', refresh() {}, setValue() {}, reset() {} };
  let labels = [];
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  function getValue(options) {
    try { return engine.validate({ version: 1, enabled: $('image-text-enabled').checked, strategy: $('image-text-strategy').value, labels: $('image-text-enabled').checked ? labels : [] }); }
    catch (error) { if (options?.draft) return undefined; throw error; }
  }
  function getError(options) {
    try {
      const value = getValue(), context = getContext();
      engine.known(value, context.constraints);
      if (!options?.forPlanning) engine.compose(context.prompt || '', context.constraints, value);
      return '';
    } catch (error) { return error.message; }
  }
  function refresh() {
    const context = getContext(), enabled = $('image-text-enabled').checked;
    $('image-text-options').hidden = !enabled;
    $('image-text-enabled').disabled = context.locked;
    $('image-text-strategy').disabled = context.locked;
    $('image-text-policy-add').disabled = context.locked || labels.length >= engine.MAX_LABELS;
    $('image-text-policy-advice').disabled = context.locked || !context.prompt?.trim() || !!getError({ forPlanning: true });
    for (const input of $('image-text-policy-labels').querySelectorAll('textarea, button')) input.disabled = context.locked;
    $('image-text-policy-status').textContent = getError() || (enabled
      ? $('image-text-strategy').value === 'two-pass' ? 'L’image sera générée sans lettres. Les textes seront préparés ensuite dans les calques, avec un placement à vérifier.' : 'Les textes générés devront être relus après le rendu.'
      : 'Consigne de rendu : aucun texte dans l’image.');
  }
  function render() {
    $('image-text-policy-labels').replaceChildren();
    labels.forEach((item, index) => {
      const row = node('li'), exact = node('label', `Texte exact ${index + 1}`), content = node('textarea'), place = node('label', 'Placement souhaité · facultatif'), placement = node('textarea'), remove = node('button', 'Retirer');
      content.value = item.text; content.rows = 2; content.maxLength = 600;
      placement.value = item.placement; placement.rows = 2; placement.maxLength = 480;
      content.addEventListener('input', () => { item.text = content.value; refresh(); onChange(); });
      placement.addEventListener('input', () => { item.placement = placement.value; refresh(); onChange(); });
      remove.type = 'button'; remove.setAttribute('aria-label', `Retirer le texte ${index + 1}`);
      remove.addEventListener('click', () => { if (getContext().locked) return; labels = labels.filter(value => value.id !== item.id); render(); onChange(); });
      exact.append(content); place.append(placement); row.append(exact, place, remove); $('image-text-policy-labels').append(row);
    });
    refresh();
  }
  $('image-text-enabled').addEventListener('change', () => { refresh(); onChange(); });
  $('image-text-strategy').addEventListener('change', () => { refresh(); onChange(); });
  $('image-text-policy-add').addEventListener('click', () => {
    if (getContext().locked || labels.length >= engine.MAX_LABELS) return;
    labels.push({ id: crypto.randomUUID(), text: '', placement: '' }); render(); onChange();
    $('image-text-policy-labels').lastElementChild.querySelector('textarea').focus();
  });
  $('image-text-policy-advice').addEventListener('click', () => { if (!getContext().locked) onAdvice(); });
  return { getValue, getError, refresh,
    setValue(value, protectedItems) {
      const policy = engine.validate(value) || { version: 1, enabled: !!protectedItems?.items.some(item => item.kind === 'exact-text'), strategy: 'single-pass', labels: [] };
      labels = policy.labels; $('image-text-enabled').checked = policy.enabled; $('image-text-strategy').value = policy.strategy; render(); onChange();
    },
    reset() { labels = []; $('image-text-enabled').checked = false; $('image-text-strategy').value = 'auto'; render(); onChange(); }
  };
} };
