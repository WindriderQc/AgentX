'use strict';

// Where PsyX thinks: the local routes or the frontier cloud model. The badge
// always says where the next reply is produced, and the setting lets the user
// choose. Loaded before app.js, whose shared state and helpers these functions
// use at call time.

const frontierUi = { supported: false, model: '', defaultMode: 'local', fallbackNote: '' };

function setFrontierCapabilities(frontier) {
  frontierUi.supported = frontier?.supported === true;
  frontierUi.model = frontier?.model || '';
  frontierUi.defaultMode = frontier?.defaultMode || 'local';
  frontierUi.fallbackNote = '';
  renderFrontier();
}

function frontierMode() {
  return frontierUi.supported ? state.psyxState?.settings?.frontierMode || frontierUi.defaultMode : 'local';
}

function frontierLocationFor(depth) {
  const mode = frontierMode();
  return mode === 'all' || (mode === 'deep' && depth === 'deep') ? 'frontier' : 'local';
}

// The setup checklist row about content leaving the house.
function frontierSetupLabel() {
  if (!frontierUi.supported) return 'Réponses, revues et portraits sur les voies locales';
  return { all: `Conversations, revues et portraits par ${frontierUi.model}; le contexte sélectionné est transmis au cloud`,
    deep: `Réponses profondes, revues et portraits par ${frontierUi.model}; les réponses normales sont locales`,
    local: `Réponses, revues et portraits locaux; ${frontierUi.model} est désactivé` }[frontierMode()];
}

function renderFrontier(control = null) {
  const badge = $('locationBadge');
  if (!badge) return;
  const location = control?.location || frontierLocationFor(control?.depth || 'normal');
  // The note about the last reply gives way as soon as a new reply is being produced.
  const note = control?.location ? '' : frontierUi.fallbackNote;
  const cloud = frontierUi.supported && location === 'frontier' && !note;
  badge.hidden = !frontierUi.supported;
  badge.dataset.location = cloud ? 'frontier' : 'local';
  badge.textContent = note || (cloud ? `☁ ${frontierUi.model}` : 'Local');
  badge.title = cloud
    ? 'Cette réponse transmet le contexte sélectionné au modèle cloud. AgentX conserve les données de référence; le service distant peut aussi conserver des traces.'
    : 'Cette réponse est produite sur tes machines.';
  $('frontierSection').hidden = !frontierUi.supported;
  for (const input of document.querySelectorAll('input[name="frontierMode"]')) input.checked = input.value === frontierMode();
  for (const node of document.querySelectorAll('[data-frontier-model]')) node.textContent = frontierUi.model;
}

// After a reply: say so when the cloud model was asked but the local route answered.
function noteFrontierResult(result) {
  frontierUi.fallbackNote = result?.routing?.fallbackFrom === 'frontier' ? `Local · ${frontierUi.model} indisponible` : '';
}

function wireFrontier() {
  for (const input of document.querySelectorAll('input[name="frontierMode"]')) {
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      $('frontierStatus').textContent = 'Enregistrement…';
      try {
        const result = await api('/api/psyx/state/settings', { method: 'POST', body: JSON.stringify({ frontierMode: input.value }) });
        state.psyxState = result.state;
        frontierUi.fallbackNote = '';
        $('frontierStatus').textContent = 'Enregistré.';
      } catch (error) {
        $('frontierStatus').textContent = 'Le réglage n’a pas été enregistré.';
      }
      renderPsyXState();
      renderSetup();
    });
  }
}
