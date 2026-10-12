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
  if (!frontierUi.supported) return 'Replies, reviews and portraits on the local lanes';
  return { all: `Conversations, reviews and portraits by ${frontierUi.model}; the selected context is sent to the cloud`,
    deep: `Deep replies, reviews and portraits by ${frontierUi.model}; normal replies are local`,
    local: `Local replies, reviews and portraits; ${frontierUi.model} is turned off` }[frontierMode()];
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
    ? 'This reply sends the selected context to the cloud model. AgentX keeps the reference data; the remote service may also keep traces.'
    : 'This reply is produced on your machines.';
  $('frontierSection').hidden = !frontierUi.supported;
  for (const input of document.querySelectorAll('input[name="frontierMode"]')) input.checked = input.value === frontierMode();
  for (const node of document.querySelectorAll('[data-frontier-model]')) node.textContent = frontierUi.model;
}

// After a reply: say so when the cloud model was asked but the local route answered.
function noteFrontierResult(result) {
  frontierUi.fallbackNote = result?.routing?.fallbackFrom === 'frontier' ? `Local · ${frontierUi.model} unavailable` : '';
}

function wireFrontier() {
  for (const input of document.querySelectorAll('input[name="frontierMode"]')) {
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      $('frontierStatus').textContent = 'Saving…';
      try {
        const result = await api('/api/psyx/state/settings', { method: 'POST', body: JSON.stringify({ frontierMode: input.value }) });
        state.psyxState = result.state;
        frontierUi.fallbackNote = '';
        $('frontierStatus').textContent = 'Saved.';
      } catch (error) {
        $('frontierStatus').textContent = 'The setting was not saved.';
      }
      renderPsyXState();
      renderSetup();
    });
  }
}
