'use strict';
// First parental code, set on the AgentX host; link to change a stored code.
(async () => {
  const unlockForm = document.getElementById('unlockForm');
  const setup = document.getElementById('codeSetup');
  const hostOnly = document.getElementById('codeSetupHostOnly');
  const change = document.getElementById('codeChange');
  const form = document.getElementById('codeSetupForm');
  const code = document.getElementById('newCode');
  const confirm = document.getElementById('confirmCode');
  const statusNode = document.getElementById('codeSetupStatus');
  const button = form.querySelector('button');

  let status;
  try {
    const response = await fetch('/api/access/session', { credentials: 'same-origin' });
    status = response.ok ? (await response.json()).data : null;
  } catch { return; } // The unlock form stays as it is.
  if (!status) return;
  if (status.configured) { change.hidden = status.managedByConfig; return; }
  unlockForm.hidden = true;
  if (!status.setupAllowed) { hostOnly.hidden = false; return; }
  setup.hidden = false;
  code.focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (code.value !== confirm.value) { statusNode.textContent = 'Les deux codes ne correspondent pas.'; confirm.focus(); return; }
    button.disabled = true; statusNode.textContent = 'Enregistrement…';
    try {
      const response = await fetch('/api/access/code/setup', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, confirm: confirm.value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      code.value = ''; confirm.value = '';
      location.reload();
    } catch (error) {
      statusNode.textContent = error.message || 'Enregistrement impossible. Réessaie.';
      button.disabled = false;
    }
  });
})();
