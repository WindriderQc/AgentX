'use strict';
window.ImageLabIntents = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let draft;
  const initialStatus = 'The dimensions remain to be qualified; a lab reference is not yet a parent of the current workshop.';
  function render() {
    return `<section class="ready-section"><span class="eyebrow">PREPARATION WITHOUT GPU</span><h2>Prepare a plan from a recipe.</h2><p>Choose an archived scene, edit or finish, then specify your brief. The plan keeps the exact recipe and its known parameters. It starts no computation.</p>
      <form id="lab-intent"><div class="ready-controls"><label>Use<select id="intent-catalogue" required><option value="">Choose…</option><option value="scenes">Scenes</option><option value="edit">Edits</option><option value="finish16">MAX finishes and natives</option></select></label>
      <label>Recipe<select id="intent-entry" required disabled><option value="">Choose a use</option></select></label>
      <label>Width<input id="intent-width" type="number" min="256" max="8192" step="32" required></label><label>Height<input id="intent-height" type="number" min="256" max="8192" step="32" required></label>
      <label>Seed<input id="intent-seed" type="number" min="0" max="281474976710655" step="1" required></label></div>
      <p id="intent-evidence"></p><label class="ready-brief">Exact brief<textarea id="intent-prompt" required maxlength="8000" rows="4"></textarea></label>
      <label class="ready-brief">Elements to keep, if useful<textarea id="intent-approved" maxlength="2000" rows="2" placeholder="E.g. keep the characters’ positions and the pot’s color."></textarea></label>
      <p id="intent-status" role="status">${initialStatus}</p>
      <button id="intent-export" class="button" type="submit" disabled>Export the JSON plan</button></form></section>`;
  }
  async function bind() {
    const form = document.querySelector('#lab-intent');
    if (!form) return;
    const field = name => form.querySelector('#intent-' + name);
    let catalogue, loading = 0, revision = 0, pending = false, preserveOnReselect = false;
    const edited = new Set(draft?.edited || []);
    const selected = () => field('entry').value === '' ? undefined : catalogue?.entries[Number(field('entry').value)];
    const remember = () => { draft = { catalogue: field('catalogue').value, entry: field('entry').value,
      sha256: catalogue?.sha256, edited: [...edited], values: Object.fromEntries(['width', 'height', 'seed', 'prompt', 'approved'].map(name => [name, field(name).value])) }; };
    const choose = (keepRequest = false) => {
      const value = selected(); field('export').disabled = pending || !value;
      if (!pending) field('status').textContent = initialStatus;
      if (!value) return;
      if (!keepRequest && !preserveOnReselect) {
        for (const [name, proposed] of Object.entries({ width: value.width, height: value.height, seed: value.parameters.seed, prompt: value.prompt })) {
          if (!edited.has(name)) field(name).value = proposed ?? '';
        }
      }
      preserveOnReselect = false;
      const label = { text_to_image: 'Independent creation', reference_edit: 'Edit with reference', reference_finish: 'Parent finish' }[value.operation];
      field('evidence').textContent = `${label} · ${value.parameters.steps ?? 'steps not documented'}${value.parameters.steps !== null ? ' steps' : ''}${value.parameters.denoise !== null ? ' · denoise ' + value.parameters.denoise : ''} · ${value.declaredParentSha256.length ? value.declaredParentSha256.length + ' historical reference(s)' : 'no declared parent'}.`;
    };
    const load = async (restore) => {
      const generation = ++loading, id = field('catalogue').value;
      catalogue = undefined; field('entry').disabled = true; field('export').disabled = true;
      if (!pending) field('status').textContent = initialStatus;
      field('entry').innerHTML = '<option value="">Loading…</option>'; field('evidence').textContent = '';
      if (!id) { field('entry').innerHTML = '<option value="">Choose a use</option>'; return; }
      try {
        const response = await fetch('/images/labo/api/recipes/' + id, { cache: 'no-store' }); const result = await response.json();
        if (generation !== loading || !form.isConnected) return;
        if (!response.ok) throw new Error(result.message || 'Recipes unavailable.');
        catalogue = result.catalogue;
        field('entry').innerHTML = '<option value="">Choose…</option>' + catalogue.entries.map((value, index) => `<option value="${index}">${esc(value.title)} · ${esc(value.width ?? '?')} × ${esc(value.height ?? '?')}${value.role ? ' · ' + esc(value.role === 'refine' ? 'finish' : 'native') : ''} · ${esc(value.id)}</option>`).join('');
        field('entry').disabled = false;
        if (restore?.catalogue === id && restore.sha256 === catalogue.sha256) {
          field('entry').value = restore.entry; choose(true);
        } else if (restore?.catalogue === id) {
          preserveOnReselect = true;
          field('status').textContent = 'The recipes changed. Your brief is kept; choose the recipe again.';
        }
        remember();
      } catch (error) {
        if (generation === loading && form.isConnected) {
          field('entry').innerHTML = '<option value="">Unavailable</option>';
          field('status').textContent = 'Recipes unavailable. Try again with ↻.';
        }
      }
    };
    field('catalogue').onchange = () => load(); field('entry').onchange = () => choose();
    const changed = event => { revision++; if (event.type === 'input') edited.add(event.target.id.replace('intent-', '')); remember(); };
    form.addEventListener('input', changed); form.addEventListener('change', changed);
    form.onsubmit = async event => {
      event.preventDefault(); const value = selected(); if (!value || pending) return;
      const requestedRevision = revision; pending = true;
      field('export').disabled = true; field('status').textContent = 'Preparing the plan…';
      try {
        const response = await fetch('/images/labo/api/intents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          labSelection: { catalogueId: catalogue.id, catalogueSha256: catalogue.sha256, kind: value.kind, entryId: value.id },
          prompt: field('prompt').value, approvedElements: field('approved').value,
          width: Number(field('width').value), height: Number(field('height').value), seed: Number(field('seed').value)
        }) });
        const intent = await response.json();
        if (!form.isConnected || requestedRevision !== revision) {
          if (form.isConnected) field('status').textContent = 'Choice changed. Export the new plan.';
          return;
        }
        if (!response.ok) throw new Error(intent.message || 'Preparation refused.');
        const url = URL.createObjectURL(new Blob([JSON.stringify(intent, null, 2) + '\n'], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = intent.id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        field('status').textContent = 'Plan exported with the chosen recipe. No job submitted.';
      } catch (error) { if (form.isConnected && requestedRevision === revision) field('status').textContent = error.message; }
      finally { pending = false; if (form.isConnected) field('export').disabled = !selected(); }
    };
    if (draft) {
      const restore = draft;
      field('catalogue').value = restore.catalogue;
      for (const [name, value] of Object.entries(restore.values)) field(name).value = value;
      await load(restore);
    }
  }
  return { render, bind };
})();
