'use strict';
const form = document.getElementById('unlockForm');
const statusNode = document.getElementById('unlockStatus');
const code = document.getElementById('parentalCode');
const button = form.querySelector('button');
let numericCodeLength = null;

function submitCompleteCode(event) {
  if (event?.isComposing || button.disabled || code.value.length !== numericCodeLength || !/^[0-9]+$/.test(code.value)) return;
  form.requestSubmit();
}

code.addEventListener('input', submitCompleteCode);
code.addEventListener('change', submitCompleteCode);
fetch('/api/access/session', { credentials: 'same-origin' })
  .then(response => response.ok ? response.json() : null)
  .then(result => {
    const length = result?.data?.numericCodeLength;
    if (!Number.isInteger(length) || length < 1 || length > 128) return;
    numericCodeLength = length;
    code.maxLength = length;
    submitCompleteCode(); // Password managers may fill before the session response arrives.
  })
  .catch(() => {}); // Manual submission remains available when status cannot load.

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true; statusNode.textContent = 'Ouverture…';
  try {
    const response = await fetch('/api/access/unlock', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.value, next: new URLSearchParams(location.search).get('next') }) });
    code.value = '';
    const result = await response.json();
    if (!response.ok) throw new Error(result.code === 'ADULT_ACCESS_NOT_CONFIGURED' ? 'Le code parental n’est pas encore défini. Définis-le depuis l’ordinateur qui héberge AgentX.' : result.message);
    location.replace(result.data.next);
  } catch (error) { statusNode.textContent = error.message || 'Ouverture impossible. Réessaie.'; button.disabled = false; code.focus(); }
});
