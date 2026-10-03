'use strict';

// Standard questionnaires (scored by the server, never by a model) and the
// technique cards PsyX draws from. A questionnaire is offered, never imposed.
// Loaded before app.js, whose shared state and helpers these functions use at call time.

const ASSESSMENT_SNOOZE_KEY = 'psyx.assessment.snooze';
const ASSESSMENT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

const toolbox = { definitions: {}, due: [], techniques: [], open: null, note: '' };

async function loadToolbox() {
  const data = await api('/api/psyx/toolbox', { cache: 'no-store' });
  Object.assign(toolbox, { definitions: data.assessments || {}, due: data.due || [], techniques: data.techniques || [] });
  renderToolbox();
}

function assessmentSnoozed() {
  try { return Date.now() - Number(localStorage.getItem(ASSESSMENT_SNOOZE_KEY) || 0) < ASSESSMENT_SNOOZE_MS; } catch { return false; }
}

function assessmentResults(kind) {
  return (state.psyxState?.assessments || []).filter(item => item.kind === kind);
}

function assessmentForm(kind, definition) {
  return `<form class="assessment-form" data-assessment-form="${escapeHtml(kind)}">
    <p class="state-help">${escapeHtml(definition.intro)}</p>
    ${definition.items.map((text, index) => `<fieldset><legend>${index + 1}. ${escapeHtml(text)}</legend>${definition.choices.map((label, value) => `
      <label><input type="radio" name="q${index}" value="${value}" required> ${escapeHtml(label)}</label>`).join('')}</fieldset>`).join('')}
    <div class="proposal-actions"><button type="submit" class="proposal-keep">Enregistrer</button><button type="button" data-assessment-cancel>Annuler</button></div>
  </form>`;
}

function renderToolbox() {
  const kinds = Object.keys(toolbox.definitions);
  $('assessmentSection').hidden = !kinds.length;
  $('assessmentList').innerHTML = kinds.map(kind => {
    const definition = toolbox.definitions[kind];
    const results = assessmentResults(kind);
    const last = results.at(-1);
    const due = toolbox.due.includes(kind);
    const history = results.slice(-6).map(item => item.score).join(' → ');
    return `<article class="proposal-card">
      <strong>${escapeHtml(definition.title)}</strong>
      ${last ? `<span>Dernier : <b>${last.score}/${definition.max}</b> · ${escapeHtml(last.band)} · ${escapeHtml(new Date(last.at).toLocaleDateString('fr-CA'))}</span>${results.length > 1 ? `<small>Évolution : ${escapeHtml(history)}</small>` : ''}`
        : '<span>Pas encore rempli.</span>'}
      ${toolbox.open === kind ? assessmentForm(kind, definition)
        : `<div class="proposal-actions"><button type="button" data-assessment-open="${escapeHtml(kind)}">${due ? 'Répondre (2 minutes)' : 'Refaire maintenant'}</button></div>`}
    </article>`;
  }).join('');
  $('assessmentNote').textContent = toolbox.note;
  $('techniqueList').innerHTML = toolbox.techniques.map(card => `<details class="technique-card"><summary>${escapeHtml(card.name)} · ${card.minutes} min</summary><ol>${card.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></details>`).join('');
  const chip = $('assessmentChip');
  chip.hidden = !toolbox.due.length || assessmentSnoozed() || toolbox.open !== null;
  chip.textContent = 'Un bilan de 2 minutes est disponible';
  chip.title = 'Humeur et anxiété, les questionnaires standards. Le score est calculé par le code; PsyX en suit l’évolution avec toi. Rien d’obligatoire : ce rappel se retire pour une semaine quand tu l’ouvres.';
}

async function submitAssessment(form) {
  const kind = form.dataset.assessmentForm;
  const answers = toolbox.definitions[kind].items.map((_, index) => Number(new FormData(form).get(`q${index}`)));
  const result = await api('/api/psyx/state/assessments', { method: 'POST', body: JSON.stringify({ kind, answers }) });
  state.psyxState = result.state;
  toolbox.due = result.due || [];
  toolbox.open = null;
  const definition = toolbox.definitions[kind];
  toolbox.note = `Noté : ${result.assessment.score}/${definition.max} (${result.assessment.band}). C’est une mesure des deux dernières semaines, pas un diagnostic.`;
  if (result.safety) showSafety(result.safety.resources);
  renderPsyXState();
}

function resetToolbox() {
  toolbox.open = null;
  toolbox.note = '';
}

function wireToolbox() {
  $('assessmentChip').addEventListener('click', () => {
    try { localStorage.setItem(ASSESSMENT_SNOOZE_KEY, String(Date.now())); } catch { /* the chip simply shows again */ }
    activateStateTab($('tabMemory'));
    if (drawerMode()) openDrawer('insights');
    $('assessmentSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    renderToolbox();
  });
  $('assessmentList').addEventListener('click', event => {
    const open = event.target.closest('[data-assessment-open]');
    if (open) toolbox.open = open.dataset.assessmentOpen;
    else if (event.target.closest('[data-assessment-cancel]')) toolbox.open = null;
    else return;
    toolbox.note = '';
    renderToolbox();
  });
  $('assessmentList').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    try { await submitAssessment(event.target); } catch (error) {
      if (error.code !== 'PSYX_LOCKED') { $('assessmentNote').textContent = error.message; button.disabled = false; }
    }
  });
}
