/* Shared, ephemeral browser editor for Core's user-confirmed conversation recap. */
(function (root) {
  'use strict';
  function mount({ host, api, base, currentId, prepare = () => {}, onSaved = () => {}, onResume, title = 'Session recap' }) {
    const doc = host.ownerDocument;
    const dialog = doc.createElement('dialog'); dialog.className = 'conversation-recap-dialog';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<form><header><h2></h2><button type="button" data-close aria-label="Close">×</button></header>
      <p>Keep what is useful to you. You can edit the suggestion before saving it.</p>
      <label>Summary<textarea name="summary" rows="4" maxlength="2000" required></textarea></label>
      <label>What I take away <small>Optional</small><textarea name="takeaway" rows="2" maxlength="1000"></textarea></label>
      <label>Next step <small>Optional</small><textarea name="nextStep" rows="2" maxlength="1000"></textarea></label>
      <p data-status role="status" aria-live="polite"></p>
      <footer><button type="button" data-reload>Reload</button><button type="button" data-draft>Suggest a summary</button><button type="submit">Save the recap</button></footer></form>`;
    dialog.querySelector('h2').textContent = title; doc.body.append(dialog);
    const form = dialog.querySelector('form'), status = dialog.querySelector('[data-status]');
    const input = name => form.elements.namedItem(name);
    const path = id => `${base}/${encodeURIComponent(id)}/recap`;
    let epoch = 0, viewEpoch = 0, editingId = null, snapshot = null, working = false;
    const writeFields = values => ['summary', 'takeaway', 'nextStep'].forEach(key => { input(key).value = values?.[key] || ''; });
    const setWorking = (value, lockFields = false) => { working = value; for (const b of form.querySelectorAll('footer button')) b.disabled = value || (b.hasAttribute('data-draft') && snapshot?.canDraft === false);
      for (const field of form.querySelectorAll('textarea')) field.disabled = value && lockFields;
    };
    function clear() {
      epoch++; viewEpoch++; editingId = null; snapshot = null; working = false;
      host.replaceChildren(); host.hidden = true; writeFields(null); status.textContent = '';
      if (dialog.open) dialog.close(); setWorking(false);
    }
    function render(data, id) {
      host.replaceChildren();
      if (!data?.recap && !id) { host.hidden = true; return; }
      host.hidden = false;
      const heading = doc.createElement('strong'); heading.textContent = data?.recap ? title : 'Before you go'; host.append(heading);
      if (data?.recap) {
        for (const [key, label] of [['summary', ''], ['takeaway', 'Takeaway: '], ['nextStep', 'Next step: ']]) {
          if (!data.recap[key]) continue;
          const p = doc.createElement('p'); p.textContent = label + data.recap[key]; host.append(p);
        }
        if (data.recap.stale) { const note = doc.createElement('small'); note.textContent = 'The conversation has moved on since this recap.'; host.append(note); }
      }
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = data?.recap ? 'Edit the recap' : 'Write a recap';
      button.onclick = () => void open(id || data.sessionId); host.append(button);
      if (!id && data?.sessionId && onResume) {
        const resume = doc.createElement('button'); resume.type = 'button'; resume.textContent = 'Resume this conversation';
        resume.onclick = () => onResume(data.sessionId); host.append(resume);
      }
    }
    async function refresh(id = currentId()) {
      const token = ++viewEpoch;
      try {
        const data = await api(id ? path(id) : `${base}/recap/latest`);
        if (token !== viewEpoch || currentId() !== id) return;
        render(data, id);
      } catch {
        if (token !== viewEpoch || currentId() !== id) return;
        // Do not leave the previous conversation's content after a failed read.
        host.replaceChildren(); host.hidden = false;
        const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Reload the session recap';
        retry.onclick = () => void refresh(); host.append(retry);
      }
    }
    async function open(id = currentId()) {
      if (!id) return;
      const token = ++epoch;
      if (await prepare() === false || token !== epoch) return; editingId = id; snapshot = null;
      writeFields(null); status.textContent = 'Loading…'; setWorking(true, true);
      if (!dialog.open) dialog.showModal();
      try {
        const data = await api(path(id));
        if (token !== epoch || !dialog.open) return;
        snapshot = data; writeFields(data.recap); status.textContent = data.recap?.stale ? 'The conversation has moved on. Update what you want to keep.' : '';
        if (data.canDraft === false) status.textContent += ' Automatic suggestions are off in Context and performance. You can write your recap directly.';
      } catch (error) { if (token === epoch) status.textContent = error.message; }
      finally { if (token === epoch) setWorking(false); }
    }
    dialog.querySelector('[data-reload]').onclick = () => { if (!working) void open(editingId); };
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { epoch++; editingId = null; snapshot = null; writeFields(null); status.textContent = ''; setWorking(false); });
    dialog.querySelector('[data-draft]').onclick = async () => {
      if (working || !snapshot) return;
      const token = epoch, id = editingId;
      const before = ['summary', 'takeaway', 'nextStep'].map(key => input(key).value);
      setWorking(true); status.textContent = 'Preparing the summary…';
      try {
        const data = await api(`${path(id)}/draft`, { method: 'POST', body: '{}' });
        if (token !== epoch || !dialog.open) return;
        snapshot = data;
        if (['summary', 'takeaway', 'nextStep'].some((key, i) => input(key).value !== before[i])) {
          status.textContent = 'Your text changed while the summary was being prepared. It was kept; you can save your recap.'; return;
        }
        writeFields(data.draft);
        status.textContent = `Suggestion to review · ${data.coverage.includedMessages} of ${data.coverage.availableMessages} messages. Nothing is saved until you confirm.`;
      } catch (error) { if (token === epoch) status.textContent = error.message; }
      finally { if (token === epoch) setWorking(false); }
    };
    form.onsubmit = async event => {
      event.preventDefault(); if (working || !snapshot) return;
      const token = epoch, id = editingId; setWorking(true, true); status.textContent = 'Saving…';
      try {
        const content = Object.fromEntries(['summary', 'takeaway', 'nextStep'].map(key => [key, input(key).value]));
        const data = await api(path(id), { method: 'PUT', body: JSON.stringify({ ...content, revision: snapshot.revision, sourceHash: snapshot.source.hash }) });
        if (token !== epoch || !dialog.open) return;
        dialog.close(); await onSaved(data); void refresh();
      } catch (error) { if (token === epoch) status.textContent = error.message; }
      finally { if (token === epoch) setWorking(false); }
    };
    return { refresh, open, clear, destroy() { clear(); dialog.remove(); } };
  }
  root.ConversationRecap = { mount };
})(typeof window === 'undefined' ? globalThis : window);
