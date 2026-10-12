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
    <div class="proposal-actions"><button type="submit" class="proposal-keep">Save</button><button type="button" data-assessment-cancel>Cancel</button></div>
  </form>`;
}

function renderToolbox() {
  const kinds = Object.keys(toolbox.definitions);
  $('assessmentSection').hidden = !kinds.length;
  // A review or a dream finishing in the background re-renders the panel: never rebuild a form he is filling.
  if (!(toolbox.open && $('assessmentList').querySelector('[data-assessment-form]'))) $('assessmentList').innerHTML = kinds.map(kind => {
    const definition = toolbox.definitions[kind];
    const results = assessmentResults(kind);
    const last = results.at(-1);
    const due = toolbox.due.includes(kind);
    const history = results.slice(-6).map(item => item.score).join(' → ');
    return `<article class="proposal-card">
      <strong>${escapeHtml(definition.title)}</strong>
      ${last ? `<span>Latest: <b>${last.score}/${definition.max}</b> · ${escapeHtml(last.band)} · ${escapeHtml(new Date(last.at).toLocaleDateString('en-CA'))}</span>${results.length > 1 ? `<small>Trend: ${escapeHtml(history)}</small>` : ''}`
        : '<span>Not filled in yet.</span>'}
      ${toolbox.open === kind ? assessmentForm(kind, definition)
        : `<div class="proposal-actions"><button type="button" data-assessment-open="${escapeHtml(kind)}">${due ? 'Answer (2 minutes)' : 'Retake now'}</button></div>`}
    </article>`;
  }).join('');
  if (toolbox.note) $('assessmentNote').textContent = toolbox.note;
  $('techniqueList').innerHTML = toolbox.techniques.map(card => `<details class="technique-card"><summary>${escapeHtml(card.name)} · ${card.minutes} min</summary><ol>${card.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></details>`).join('');
  const chip = $('assessmentChip');
  chip.hidden = !toolbox.due.length || assessmentSnoozed() || toolbox.open !== null;
  chip.textContent = 'A 2-minute assessment is available';
  chip.title = 'Mood and anxiety, the standard questionnaires. The score is computed by code; PsyX follows how it changes with you. Nothing is mandatory: this reminder goes away for a week when you open it.';
}

async function submitAssessment(form) {
  const kind = form.dataset.assessmentForm;
  const picked = toolbox.definitions[kind].items.map((_, index) => new FormData(form).get(`q${index}`));
  // A question left blank is never counted as "never".
  if (picked.some(value => value === null)) throw new Error('Answer every question before saving.');
  const answers = picked.map(Number);
  const result = await api('/api/psyx/state/assessments', { method: 'POST', body: JSON.stringify({ kind, answers }) });
  state.psyxState = result.state;
  toolbox.due = result.due || [];
  toolbox.open = null;
  const definition = toolbox.definitions[kind];
  toolbox.note = `Noted: ${result.assessment.score}/${definition.max} (${result.assessment.band}). This measures the last two weeks; it is not a diagnosis.`;
  form.remove();
  if (result.safety) {
    // The resources must be seen now: say it here, and bring the banner in front of the memory panel.
    toolbox.note += ' You reported thoughts of death or of hurting yourself: you don’t have to go through this alone. 9-8-8 (call or text, 24/7), or 911 in immediate danger.';
    showSafety(result.safety.resources);
    if (drawerMode()) closeDrawers();
  }
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
    $('assessmentNote').textContent = '';
    $('assessmentList').querySelector('[data-assessment-form]')?.remove();
    renderToolbox();
  });
  $('assessmentList').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    try { await submitAssessment(event.target); } catch (error) {
      { $('assessmentNote').textContent = error.message; button.disabled = false; }
    }
  });
}
