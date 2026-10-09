'use strict';
window.ImageLabIntents = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let draft;
  const initialStatus = 'Les dimensions restent à qualifier ; une référence du labo n’est pas encore un parent de l’atelier courant.';
  function render() {
    return `<section class="ready-section"><span class="eyebrow">PRÉPARATION SANS GPU</span><h2>Préparer un plan depuis une recette.</h2><p>Choisis une scène, une retouche ou une finition archivée, puis précise ton brief. Le plan conserve la recette exacte et ses paramètres connus. Il ne lance aucun calcul.</p>
      <form id="lab-intent"><div class="ready-controls"><label>Usage<select id="intent-catalogue" required><option value="">Choisir…</option><option value="scenes">Scènes</option><option value="edit">Retouches</option><option value="finish16">Finitions et natifs MAX</option></select></label>
      <label>Recette<select id="intent-entry" required disabled><option value="">Choisir un usage</option></select></label>
      <label>Largeur<input id="intent-width" type="number" min="256" max="8192" step="32" required></label><label>Hauteur<input id="intent-height" type="number" min="256" max="8192" step="32" required></label>
      <label>Graine<input id="intent-seed" type="number" min="0" max="281474976710655" step="1" required></label></div>
      <p id="intent-evidence"></p><label class="ready-brief">Brief exact<textarea id="intent-prompt" required maxlength="8000" rows="4"></textarea></label>
      <label class="ready-brief">Éléments à conserver, si utile<textarea id="intent-approved" maxlength="2000" rows="2" placeholder="Ex. garder la position des personnages et la couleur du pot."></textarea></label>
      <p id="intent-status" role="status">${initialStatus}</p>
      <button id="intent-export" class="button" type="submit" disabled>Exporter le plan JSON</button></form></section>`;
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
      const label = { text_to_image: 'Création indépendante', reference_edit: 'Retouche avec référence', reference_finish: 'Finition du parent' }[value.operation];
      field('evidence').textContent = `${label} · ${value.parameters.steps ?? 'étapes non documentées'}${value.parameters.steps !== null ? ' étapes' : ''}${value.parameters.denoise !== null ? ' · bruit ' + value.parameters.denoise : ''} · ${value.declaredParentSha256.length ? value.declaredParentSha256.length + ' référence(s) historique(s)' : 'aucun parent déclaré'}.`;
    };
    const load = async (restore) => {
      const generation = ++loading, id = field('catalogue').value;
      catalogue = undefined; field('entry').disabled = true; field('export').disabled = true;
      if (!pending) field('status').textContent = initialStatus;
      field('entry').innerHTML = '<option value="">Chargement…</option>'; field('evidence').textContent = '';
      if (!id) { field('entry').innerHTML = '<option value="">Choisir un usage</option>'; return; }
      try {
        const response = await fetch('/images/labo/api/recipes/' + id, { cache: 'no-store' }); const result = await response.json();
        if (generation !== loading || !form.isConnected) return;
        if (!response.ok) throw new Error(result.message || 'Recettes indisponibles.');
        catalogue = result.catalogue;
        field('entry').innerHTML = '<option value="">Choisir…</option>' + catalogue.entries.map((value, index) => `<option value="${index}">${esc(value.title)} · ${esc(value.width ?? '?')} × ${esc(value.height ?? '?')}${value.role ? ' · ' + esc(value.role === 'refine' ? 'finition' : 'natif') : ''} · ${esc(value.id)}</option>`).join('');
        field('entry').disabled = false;
        if (restore?.catalogue === id && restore.sha256 === catalogue.sha256) {
          field('entry').value = restore.entry; choose(true);
        } else if (restore?.catalogue === id) {
          preserveOnReselect = true;
          field('status').textContent = 'Les recettes ont changé. Ton brief est conservé ; choisis la recette à nouveau.';
        }
        remember();
      } catch (error) {
        if (generation === loading && form.isConnected) {
          field('entry').innerHTML = '<option value="">Indisponible</option>';
          field('status').textContent = 'Recettes indisponibles. Réessaie avec ↻.';
        }
      }
    };
    field('catalogue').onchange = () => load(); field('entry').onchange = () => choose();
    const changed = event => { revision++; if (event.type === 'input') edited.add(event.target.id.replace('intent-', '')); remember(); };
    form.addEventListener('input', changed); form.addEventListener('change', changed);
    form.onsubmit = async event => {
      event.preventDefault(); const value = selected(); if (!value || pending) return;
      const requestedRevision = revision; pending = true;
      field('export').disabled = true; field('status').textContent = 'Préparation du plan…';
      try {
        const response = await fetch('/images/labo/api/intents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          labSelection: { catalogueId: catalogue.id, catalogueSha256: catalogue.sha256, kind: value.kind, entryId: value.id },
          prompt: field('prompt').value, approvedElements: field('approved').value,
          width: Number(field('width').value), height: Number(field('height').value), seed: Number(field('seed').value)
        }) });
        const intent = await response.json();
        if (!form.isConnected || requestedRevision !== revision) {
          if (form.isConnected) field('status').textContent = 'Choix modifié. Exporte le nouveau plan.';
          return;
        }
        if (!response.ok) throw new Error(intent.message || 'Préparation refusée.');
        const url = URL.createObjectURL(new Blob([JSON.stringify(intent, null, 2) + '\n'], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = intent.id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        field('status').textContent = 'Plan exporté avec la recette choisie. Aucun job soumis.';
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
