'use strict';

// PsyX follow-up in the browser: experiments that are due for a check-in,
// their outcome in one tap, and short 0-10 self-ratings with their trend.
// Loaded before app.js, whose shared state and helpers these functions use at call time.

const OUTCOME_LABELS = { worked: 'Ça a marché', partly: 'En partie', did_not_work: 'Pas marché', not_done: 'Pas fait' };
const CHECK_IN_AFTER_MESSAGES = 8;
const followUp = { askedIn: new Set(), lastNote: '', openingDone: false };

function experimentIsDue(item) {
  return ['planned', 'active'].includes(item.status) && item.checkInAt && new Date(item.checkInAt).getTime() <= Date.now();
}

function dueExperiments() {
  return (state.psyxState?.experiments || []).filter(experimentIsDue);
}

// The part of an experiment card about its follow-up: when, and how it went.
function experimentFollowUpHtml(item) {
  const open = ['planned', 'active'].includes(item.status);
  const when = item.checkInAt ? new Date(item.checkInAt).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' }) : '';
  const head = item.outcome && !open
    ? `<p class="experiment-outcome">Résultat : <strong>${escapeHtml(OUTCOME_LABELS[item.outcome] || item.outcome)}</strong></p>`
    : open && when ? `<p class="experiment-due ${experimentIsDue(item) ? 'due' : ''}">${experimentIsDue(item) ? 'À faire le point' : `Faire le point le ${escapeHtml(when)}`}</p>` : '';
  const buttons = open ? `<div class="outcome-actions" role="group" aria-label="Comment ça s’est passé?">${Object.entries(OUTCOME_LABELS)
    .map(([outcome, label]) => `<button type="button" data-experiment-outcome="${escapeHtml(item.id)}" data-outcome="${outcome}">${label}</button>`).join('')}</div>` : '';
  return head + buttons;
}

async function recordOutcome(id, outcome) {
  const card = document.querySelector(`[data-experiment-result="${CSS.escape(id)}"]`);
  const result = card?.value.trim() || '';
  const response = await api(`/api/psyx/state/experiments/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ outcome, ...(result ? { result } : {}) })
  });
  state.psyxState = response.state;
  renderPsyXState();
}

function checkInButtons(phase) {
  return `<div class="check-in-scale" role="group" aria-label="De 0 à 10">${Array.from({ length: 11 }, (_, score) =>
    `<button type="button" data-check-in="${score}" data-phase="${phase}">${score}</button>`).join('')}</div>`;
}

// Opening a new session: one optional rating before starting.
function openingCheckInHtml() {
  if (followUp.openingDone) return `<p class="check-in-done">${escapeHtml(followUp.lastNote)}. Merci.</p>`;
  return `<div class="check-in"><p><strong>Avant de commencer :</strong> ce qui te pèse, ça pèse combien en ce moment, de 0 à 10? <em>Facultatif.</em></p>${checkInButtons('start')}</div>`;
}

// Once per conversation, after a few exchanges, a discreet invitation to rate again.
function maybeAskCheckIn() {
  const box = $('checkInPrompt');
  const messagesSoFar = state.history.filter((item) => item.role !== 'action').length;
  if (!state.conversationId || followUp.askedIn.has(state.conversationId) || messagesSoFar < CHECK_IN_AFTER_MESSAGES) return;
  followUp.askedIn.add(state.conversationId);
  box.innerHTML = `<div class="check-in"><p>Et maintenant, ça pèse combien, de 0 à 10?</p>${checkInButtons('during')}<button type="button" class="check-in-close" data-check-in-close aria-label="Plus tard">×</button></div>`;
  box.hidden = false;
}

async function recordCheckIn(score, phase) {
  const response = await api('/api/psyx/state/check-ins', {
    method: 'POST', body: JSON.stringify({ score, phase, conversationId: state.conversationId || undefined })
  });
  state.psyxState = response.state;
  followUp.lastNote = `Noté : ${score}/10`;
  if (phase === 'start') followUp.openingDone = true;
  $('checkInPrompt').hidden = true;
  renderPsyXState();
}

// A small trend line of the latest ratings in Memory.
function renderCheckInTrend() {
  const section = $('checkInSection');
  const items = (state.psyxState?.checkIns || []).slice(-20);
  section.hidden = !items.length;
  if (!items.length) return;
  const width = 240, height = 48;
  const x = (index) => items.length === 1 ? width / 2 : (index * width) / (items.length - 1);
  const y = (score) => 4 + ((10 - score) * (height - 8)) / 10;
  const points = items.map((item, index) => `${x(index).toFixed(1)},${y(item.score).toFixed(1)}`).join(' ');
  const week = items.filter((item) => Date.now() - new Date(item.at).getTime() < 7 * 24 * 60 * 60 * 1000);
  const average = week.length ? (week.reduce((sum, item) => sum + item.score, 0) / week.length).toFixed(1) : '—';
  $('checkInTrend').innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Évolution des ${items.length} dernières mesures">
      <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${items.map((item, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(item.score).toFixed(1)}" r="2.5"><title>${item.score}/10 · ${escapeHtml(new Date(item.at).toLocaleDateString('fr-CA'))}</title></circle>`).join('')}
    </svg>
    <p class="state-help">Dernière : <strong>${items.at(-1).score}/10</strong> · moyenne sur 7 jours : ${average}${followUp.lastNote ? ` · ${escapeHtml(followUp.lastNote)}` : ''}</p>`;
}

function renderFollowUp() {
  $('tabExperiments').dataset.badge = dueExperiments().length ? String(dueExperiments().length) : '';
  renderCheckInTrend();
}

function wireFollowUp() {
  document.addEventListener('click', async (event) => {
    const outcome = event.target.closest('[data-experiment-outcome]');
    if (outcome) return recordOutcome(outcome.dataset.experimentOutcome, outcome.dataset.outcome);
    const checkIn = event.target.closest('[data-check-in]');
    if (checkIn) return recordCheckIn(Number(checkIn.dataset.checkIn), checkIn.dataset.phase);
    if (event.target.closest('[data-check-in-close]')) $('checkInPrompt').hidden = true;
  });
}
