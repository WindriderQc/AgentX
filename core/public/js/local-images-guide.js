'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const mp = pixels => `${new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 }).format(pixels / 1e6)} MP`;
  function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function recipeCard(recipe) {
    const card = node('article'); card.append(node('h3', recipe.label));
    if (recipe.description) card.append(node('p', recipe.description));
    const list = node('dl');
    const rows = [['Étapes', recipe.steps], ['Taille maximale', recipe.maxPixels ? mp(recipe.maxPixels) : null], ['Précision', recipe.precision],
      ['Générateur', recipe.diffusion], ['Encodeur de texte', recipe.encoder], ['Décodeur', recipe.vae],
      ['Avec une référence', recipe.editingFraming === 'first-reference' ? 'Le résultat prend le format de la première image jointe.' : 'Le résultat garde le format demandé.']];
    for (const [label, value] of rows) { if (value === undefined || value === null || value === '') continue;
      const row = node('div'); row.append(node('dt', label), node('dd', String(value))); list.append(row); }
    card.append(list); return card;
  }
  async function load() {
    const status = $('guide-recipes-status');
    try {
      const r = await fetch('/api/images/workshop'); const view = await r.json();
      if (!r.ok || !view.ok) throw new Error(view.message || 'Service indisponible.');
      if (view.worker?.label) $('guide-host').textContent = `PC IMAGE · ${view.worker.label}`.toUpperCase();
      if (view.worker?.gpu) $('guide-gpu').textContent = view.worker.gpu;
      if (view.worker?.vramGiB) $('guide-vram').textContent = `${view.worker.vramGiB} Go, une seule, partagée`;
      $('guide-recipes').replaceChildren(...view.profiles.map(recipeCard));
      status.textContent = view.profiles.length ? `Jusqu’à ${view.maxReferences} références par demande ; côtés de ${view.dimensions.minEdge} à ${view.dimensions.maxEdge} px.` : 'Aucune recette n’est configurée.';
    } catch (error) { status.textContent = `Lecture des recettes impossible pour l’instant. ${error.message}`; }
  }
  load();
})();
