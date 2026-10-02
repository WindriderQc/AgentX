'use strict';

// PsyX State panel: longitudinal memory items, experiments and tabs.
// Loaded before app.js, whose shared state and helpers these functions use at call time.

async function loadPsyXState() {
  state.psyxState = await api('/api/psyx/state');
  renderPsyXState();
}

async function addStateItem(key, text, extra = {}) {
  stateSaveStatus.textContent = 'enregistrement…';
  try {
    const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify({ text, ...extra })
    });
    state.psyxState = result.state;
    renderPsyXState();
    stateSaveStatus.textContent = `synchronisé · r${state.psyxState.revision ?? 0}`;
  } catch (error) {
    stateSaveStatus.textContent = 'échec de l’enregistrement';
    throw error;
  }
}

async function removeStateItem(key, id) {
  stateSaveStatus.textContent = 'enregistrement…';
  const result = await api(`/api/psyx/state/items/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.psyxState = result.state;
  renderPsyXState();
  stateSaveStatus.textContent = `synchronisé · r${state.psyxState.revision ?? 0}`;
}

const SOURCE_LABELS = { user: 'toi', psyx: 'PsyX', legacy: 'ancien', import: 'import' };
const ITEM_STATUS_LABELS = { working: 'en test', confirmed: 'confirmé', rejected: 'rejeté', resolved: 'résolu' };
const EXPERIMENT_STATUS_LABELS = { planned: 'prévue', active: 'en cours', completed: 'terminée', abandoned: 'abandonnée' };

function stateItemMeta(item) {
  const bits = [];
  if (item.source) bits.push(SOURCE_LABELS[item.source] || item.source);
  if (Number.isFinite(item.confidence)) bits.push(`${Math.round(item.confidence * 100)}%`);
  if (item.status && item.status !== 'active') bits.push(ITEM_STATUS_LABELS[item.status] || item.status);
  return bits.join(' · ');
}

function renderStateItems(containerId, key) {
  const container = $(containerId);
  const values = state.psyxState?.[key] || [];
  if (!values.length) {
    container.innerHTML = '<div class="state-empty">Rien pour l’instant.</div>';
    return;
  }
  container.innerHTML = values.map((item) => `
    <div class="state-item">
      <div><span>${escapeHtml(item.text)}</span>${stateItemMeta(item) ? `<small>${escapeHtml(stateItemMeta(item))}</small>` : ''}</div>
      <button type="button" data-state-remove="${escapeHtml(key)}" data-id="${escapeHtml(item.id)}" aria-label="Retirer">×</button>
    </div>
  `).join('');
}

function renderExperiments() {
  const container = $('experimentsList');
  const experiments = state.psyxState?.experiments || [];
  if (!experiments.length) {
    container.innerHTML = '<div class="state-empty">Aucune expérience pour l’instant. Crées-en une quand une prise de conscience mérite d’être testée dans la vraie vie.</div>';
    return;
  }
  container.innerHTML = experiments.slice().reverse().map((item) => `
    <article class="experiment-card">
      <div class="experiment-top">
        <span class="experiment-status ${escapeHtml(item.status)}">${escapeHtml(EXPERIMENT_STATUS_LABELS[item.status] || item.status)}</span>
        <select data-experiment-status="${escapeHtml(item.id)}" aria-label="Statut de l’expérience">
          ${['planned', 'active', 'completed', 'abandoned'].map((status) => `<option value="${status}" ${status === item.status ? 'selected' : ''}>${EXPERIMENT_STATUS_LABELS[status]}</option>`).join('')}
        </select>
      </div>
      <strong>${escapeHtml(item.hypothesis || 'Expérience')}</strong>
      <p><b>Action :</b> ${escapeHtml(item.action || '—')}</p>
      ${item.expectedSignal ? `<p><b>Signal :</b> ${escapeHtml(item.expectedSignal)}</p>` : ''}
      ${experimentFollowUpHtml(item)}
      <textarea data-experiment-result="${escapeHtml(item.id)}" rows="2" placeholder="Qu’est-ce qui s’est passé?">${escapeHtml(item.result || '')}</textarea>
      <button type="button" class="experiment-save" data-experiment-save="${escapeHtml(item.id)}">Enregistrer le résultat</button>
    </article>
  `).join('');
}

function renderPsyXState() {
  renderStateItems('threadsList', 'activeThreads');
  renderStateItems('notesList', 'notes');
  renderStateItems('loopsList', 'openLoops');
  renderStateItems('patternsList', 'patterns');
  renderStateItems('hypothesesList', 'hypotheses');
  renderExperiments();
  renderProposals();
  renderFollowUp();
  updateControlExplanation();
  renderSessions();
  renderOpening();
  stateSaveStatus.textContent = `synchronisé · r${state.psyxState?.revision ?? 0}`;
}

function activateStateTab(tab, { focus = false } = {}) {
  for (const node of document.querySelectorAll('.state-tab')) {
    const active = node === tab;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
    node.tabIndex = active ? 0 : -1;
  }
  for (const view of document.querySelectorAll('.state-view')) {
    const active = view.dataset.view === tab.dataset.tab;
    view.classList.toggle('active', active);
    view.hidden = !active;
  }
  if (focus) tab.focus();
}

function wireStatePanel() {
  document.querySelectorAll('[data-state-add]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const field = form.querySelector('input');
      const value = field.value.trim();
      if (!value) return;
      field.value = '';
      await addStateItem(form.dataset.stateAdd, value);
    });
  });

  $('insightsPanel').addEventListener('click', async (event) => {
    const remove = event.target.closest('[data-state-remove]');
    if (remove) {
      await removeStateItem(remove.dataset.stateRemove, remove.dataset.id);
      return;
    }
    const saveExperiment = event.target.closest('[data-experiment-save]');
    if (saveExperiment) {
      const id = saveExperiment.dataset.experimentSave;
      const card = saveExperiment.closest('.experiment-card');
      const result = card.querySelector(`[data-experiment-result="${CSS.escape(id)}"]`)?.value || '';
      const status = card.querySelector(`[data-experiment-status="${CSS.escape(id)}"]`)?.value || 'planned';
      const response = await api(`/api/psyx/state/experiments/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ result, status })
      });
      state.psyxState = response.state;
      renderPsyXState();
    }
  });

  document.querySelectorAll('.state-tab').forEach((tab) => {
    tab.addEventListener('click', () => activateStateTab(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('.state-tab')];
      const current = tabs.indexOf(tab);
      let next = current;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else next = (current - 1 + tabs.length) % tabs.length;
      activateStateTab(tabs[next], { focus: true });
    });
  });

  const experimentDialog = $('experimentDialog');
  $('newExperiment').addEventListener('click', () => {
    experimentDialog.showModal();
    setTimeout(() => experimentDialog.querySelector('textarea')?.focus(), 0);
  });
  $('saveExperiment').addEventListener('click', async () => {
    const form = $('experimentForm');
    const data = new FormData(form);
    const hypothesis = String(data.get('hypothesis') || '').trim();
    const action = String(data.get('action') || '').trim();
    if (!hypothesis || !action) return;
    const response = await api('/api/psyx/state/experiments', {
      method: 'POST',
      body: JSON.stringify({ hypothesis, action, expectedSignal: String(data.get('expectedSignal') || '').trim() })
    });
    state.psyxState = response.state;
    renderPsyXState();
    form.reset();
    experimentDialog.close();
  });
}
