'use strict';

// A live projection of approved memory and pending reviews; no second store.
const formulationDrafts = new Map();

const FORMULATION_SECTIONS = {
  activeThreads: 'Ce qui t’occupe', patterns: 'Les tendances observées',
  hypotheses: 'Les hypothèses à vérifier', openLoops: 'Les questions ouvertes', notes: 'Ce que tu veux retenir'
};

function formulationProvenance(item) {
  const source = SOURCE_LABELS[item.source] || 'source inconnue';
  const date = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('fr-CA') : null;
  const bits = [source, item.correctedBy === 'user' ? 'corrigé par toi' : null, date].filter(Boolean);
  const evidence = (item.evidence || []).map(text => `<blockquote>${escapeHtml(text)}</blockquote>`).join('');
  return `<small>${escapeHtml(bits.join(' · '))}</small>${item.sourceConversationId
    ? `<small>Séance source : ${escapeHtml(item.sourceConversationId)}</small>`
    : '<small>Séance source non enregistrée.</small>'}${evidence}`;
}

function renderFormulation() {
  const container = $('formulationList');
  const present = new Set(Object.entries(FORMULATION_SECTIONS).flatMap(([key]) => (state.psyxState?.[key] || []).map(item => `${key}:${item.id}`)));
  for (const key of formulationDrafts.keys()) if (!present.has(key)) formulationDrafts.delete(key);
  const sections = Object.entries(FORMULATION_SECTIONS).map(([key, title]) => {
    const items = state.psyxState?.[key] || [];
    if (!items.length) return '';
    return `<section class="state-section"><h4>${escapeHtml(title)}</h4>${items.map(item => `
      <article class="proposal-card" data-formulation-key="${escapeHtml(key)}" data-formulation-id="${escapeHtml(item.id)}" data-formulation-revision="${formulationDrafts.get(`${key}:${item.id}`)?.revision ?? state.psyxState.revision}">
        <label>Observation révisable<textarea rows="3" maxlength="${key === 'notes' ? 1000 : 500}" aria-label="Corriger l’observation">${escapeHtml(formulationDrafts.get(`${key}:${item.id}`)?.text ?? item.text)}</textarea></label>
        ${formulationProvenance(item)}
        <div class="proposal-actions"><button type="button" data-formulation-save>Enregistrer ma correction</button><button type="button" data-formulation-remove>Retirer</button></div>
      </article>`).join('')}</section>`;
  }).join('');
  const pending = state.psyxState?.proposals || [];
  container.innerHTML = sections || '<p class="state-empty">Aucune observation validée pour l’instant. Les revues de tes séances pourront proposer des pistes que tu choisiras de garder.</p>';
  if (pending.length) container.innerHTML += `<section class="state-section"><h4>À valider (${pending.length})</h4><p class="state-help">Ces propositions ne font pas encore partie de la mémoire utilisée pour répondre.</p>${pending.map(item => `
    <article class="proposal-card"><strong>${escapeHtml(item.text || item.hypothesis || item.result || 'Suivi d’expérience')}</strong>
      <small>Revue PsyX · séance source : ${escapeHtml(item.conversationId || 'non enregistrée')}</small>
      ${(item.evidence || []).map(text => `<blockquote>${escapeHtml(text)}</blockquote>`).join('')}
    </article>`).join('')}</section>`;
  $('formulationProposals').hidden = !pending.length;
}

function wireFormulation() {
  $('formulationProposals').addEventListener('click', () => {
    activateStateTab($('tabMemory'));
    $('proposalsSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('formulationList').addEventListener('input', event => {
    const card = event.target.closest('[data-formulation-id]');
    if (card) formulationDrafts.set(`${card.dataset.formulationKey}:${card.dataset.formulationId}`, { text: event.target.value, revision: Number(card.dataset.formulationRevision) });
  });
  $('formulationList').addEventListener('click', async event => {
    const button = event.target.closest('[data-formulation-save], [data-formulation-remove]');
    if (!button || !state.unlocked) return;
    const card = button.closest('[data-formulation-id]');
    const key = card.dataset.formulationKey, id = card.dataset.formulationId;
    button.disabled = true;
    try {
      if (button.hasAttribute('data-formulation-remove')) await removeStateItem(key, id);
      else {
        const text = card.querySelector('textarea').value.trim();
        if (!text) throw new Error('Écris une observation ou choisis Retirer.');
        const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
          method: 'PATCH', body: JSON.stringify({ text, expectedRevision: Number(card.dataset.formulationRevision) })
        });
        formulationDrafts.delete(`${key}:${id}`);
        state.psyxState = result.state;
        renderPsyXState();
      }
      formulationDrafts.delete(`${key}:${id}`);
      $('formulationStatus').textContent = 'Ta modification est enregistrée.';
    } catch (error) {
      if (error.code === 'PSYX_LOCKED') return;
      if (error.status === 409) { formulationDrafts.delete(`${key}:${id}`); await loadPsyXState().catch(() => {}); }
      $('formulationStatus').textContent = error.status === 409
        ? 'La mémoire a changé entre-temps. Vérifie la nouvelle observation avant de la corriger.' : error.message;
    } finally { button.disabled = false; }
  });
}
