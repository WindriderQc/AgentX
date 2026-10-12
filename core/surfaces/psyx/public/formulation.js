'use strict';

// A live projection of approved memory and pending reviews; no second store.
const formulationDrafts = new Map();

const FORMULATION_SECTIONS = {
  goals: 'Your goals', activeThreads: 'What’s on your mind', patterns: 'Observed patterns',
  hypotheses: 'Hypotheses to check', openLoops: 'Open questions', notes: 'What you want to remember'
};

function formulationProvenance(item) {
  const source = SOURCE_LABELS[item.source] || 'unknown source';
  const date = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('en-CA') : null;
  const bits = [source, item.correctedBy === 'user' ? 'corrected by you' : null, date].filter(Boolean);
  const evidence = (item.evidence || []).map(text => `<blockquote>${escapeHtml(text)}</blockquote>`).join('');
  return `<small>${escapeHtml(bits.join(' · '))}</small>${item.sourceConversationId
    ? `<small>Source session: ${escapeHtml(item.sourceConversationId)}</small>`
    : '<small>Source session not recorded.</small>'}${evidence}`;
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
        <label>Revisable observation<textarea rows="3" maxlength="${key === 'notes' ? 1000 : 500}" aria-label="Correct the observation">${escapeHtml(formulationDrafts.get(`${key}:${item.id}`)?.text ?? item.text)}</textarea></label>
        ${formulationProvenance(item)}
        <div class="proposal-actions"><button type="button" data-formulation-save>Save my correction</button><button type="button" data-formulation-remove>Remove</button></div>
      </article>`).join('')}</section>`;
  }).join('');
  const pending = state.psyxState?.proposals || [];
  container.innerHTML = sections || '<p class="state-empty">No approved observations yet. Reviews of your sessions can suggest leads that you choose to keep.</p>';
  if (pending.length) container.innerHTML += `<section class="state-section"><h4>To approve (${pending.length})</h4><p class="state-help">These proposals are not yet part of the memory used to reply.</p>${pending.map(item => `
    <article class="proposal-card"><strong>${escapeHtml(item.text || item.hypothesis || item.result || 'Experiment follow-up')}</strong>
      <small>PsyX review · source session: ${escapeHtml(item.conversationId || 'not recorded')}</small>
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
    if (!button) return;
    const card = button.closest('[data-formulation-id]');
    const key = card.dataset.formulationKey, id = card.dataset.formulationId;
    button.disabled = true;
    try {
      if (button.hasAttribute('data-formulation-remove')) await removeStateItem(key, id);
      else {
        const text = card.querySelector('textarea').value.trim();
        if (!text) throw new Error('Write an observation or choose Remove.');
        const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
          method: 'PATCH', body: JSON.stringify({ text, expectedRevision: Number(card.dataset.formulationRevision) })
        });
        formulationDrafts.delete(`${key}:${id}`);
        state.psyxState = result.state;
        renderPsyXState();
      }
      formulationDrafts.delete(`${key}:${id}`);
      $('formulationStatus').textContent = 'Your change is saved.';
    } catch (error) {

      if (error.status === 409) { formulationDrafts.delete(`${key}:${id}`); await loadPsyXState().catch(() => {}); }
      $('formulationStatus').textContent = error.status === 409
        ? 'Memory changed in the meantime. Check the new observation before correcting it.' : error.message;
    } finally { button.disabled = false; }
  });
}
