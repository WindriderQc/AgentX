'use strict';
// Change of the stored parental code. Requires an open adult session.
(async () => {
  const form = document.getElementById('codeChangeForm');
  const managed = document.getElementById('codeManaged');
  const statusNode = document.getElementById('codeStatus');
  const current = document.getElementById('currentCode');
  const code = document.getElementById('newCode');
  const confirm = document.getElementById('confirmCode');
  const button = form.querySelector('button');
  const say = text => { statusNode.textContent = text; };

  try {
    const response = await fetch('/api/access/session', { credentials: 'same-origin' });
    const status = (await response.json()).data;
    if (status.managedByConfig) { managed.hidden = false; return; }
  } catch { say('État du code indisponible. Réessaie.'); return; }
  form.hidden = false;
  current.focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (code.value !== confirm.value) { say('Les deux nouveaux codes ne correspondent pas.'); confirm.focus(); return; }
    button.disabled = true; say('Enregistrement…');
    try {
      const response = await fetch('/api/access/code/change', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: current.value, code: code.value, confirm: confirm.value }) });
      const result = await response.json();
      current.value = '';
      if (!response.ok) throw new Error(result.message);
      code.value = ''; confirm.value = '';
      say('Code parental changé.');
    } catch (error) { say(error.message || 'Changement impossible. Réessaie.'); current.focus(); }
    button.disabled = false;
  });
})();
