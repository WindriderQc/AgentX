'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const mp = pixels => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(pixels / 1e6)} MP`;
  function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function recipeCard(recipe) {
    const card = node('article'); card.append(node('h3', recipe.label));
    if (recipe.description) card.append(node('p', recipe.description));
    const list = node('dl');
    const rows = [['Steps', recipe.steps], ['Maximum size', recipe.maxPixels ? mp(recipe.maxPixels) : null], ['Precision', recipe.precision],
      ['Generator', recipe.diffusion], ['Text encoder', recipe.encoder], ['Decoder', recipe.vae],
      ['With a reference', recipe.editingFraming === 'first-reference' ? 'The result takes the format of the first attached image.' : 'The result keeps the requested format.']];
    for (const [label, value] of rows) { if (value === undefined || value === null || value === '') continue;
      const row = node('div'); row.append(node('dt', label), node('dd', String(value))); list.append(row); }
    card.append(list); return card;
  }
  async function load() {
    const status = $('guide-recipes-status');
    try {
      const r = await fetch('/api/images/workshop'); const view = await r.json();
      if (!r.ok || !view.ok) throw new Error(view.message || 'Service unavailable.');
      if (view.worker?.label) $('guide-host').textContent = `IMAGE PC · ${view.worker.label}`.toUpperCase();
      if (view.worker?.gpu) $('guide-gpu').textContent = view.worker.gpu;
      if (view.worker?.vramGiB) $('guide-vram').textContent = `${view.worker.vramGiB} GB, only one, shared`;
      $('guide-recipes').replaceChildren(...view.profiles.map(recipeCard));
      status.textContent = view.profiles.length ? `Up to ${view.maxReferences} references per request; sides from ${view.dimensions.minEdge} to ${view.dimensions.maxEdge} px.` : 'No recipe is configured.';
    } catch (error) { status.textContent = `The recipes cannot be read right now. ${error.message}`; }
  }
  load();
})();
