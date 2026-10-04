/* Shared, ephemeral browser editor for Core's user-confirmed conversation recap. */
(function (root) {
  'use strict';
  function mount({ host, api, base, currentId, prepare = () => {}, onSaved = () => {}, onResume, title = 'Point de séance' }) {
    const doc = host.ownerDocument;
    const dialog = doc.createElement('dialog'); dialog.className = 'conversation-recap-dialog';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<form><header><h2></h2><button type="button" data-close aria-label="Fermer">×</button></header>
      <p>Garde ce qui t’est utile. Tu peux modifier la proposition avant de l’enregistrer.</p>
      <label>Résumé<textarea name="summary" rows="4" maxlength="2000" required></textarea></label>
      <label>Ce que je retiens <small>Facultatif</small><textarea name="takeaway" rows="2" maxlength="1000"></textarea></label>
      <label>Prochaine étape <small>Facultatif</small><textarea name="nextStep" rows="2" maxlength="1000"></textarea></label>
      <p data-status role="status" aria-live="polite"></p>
      <footer><button type="button" data-reload>Recharger</button><button type="button" data-draft>Proposer un résumé</button><button type="submit">Enregistrer le point</button></footer></form>`;
    dialog.querySelector('h2').textContent = title; doc.body.append(dialog);
    const form = dialog.querySelector('form'), status = dialog.querySelector('[data-status]');
    const input = name => form.elements.namedItem(name);
    const path = id => `${base}/${encodeURIComponent(id)}/recap`;
    let epoch = 0, viewEpoch = 0, editingId = null, snapshot = null, working = false;
    const writeFields = values => ['summary', 'takeaway', 'nextStep'].forEach(key => { input(key).value = values?.[key] || ''; });
    const setWorking = (value, lockFields = false) => { working = value; for (const b of form.querySelectorAll('footer button')) b.disabled = value;
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
      const heading = doc.createElement('strong'); heading.textContent = data?.recap ? title : 'Avant de partir'; host.append(heading);
      if (data?.recap) {
        for (const [key, label] of [['summary', ''], ['takeaway', 'À retenir : '], ['nextStep', 'Prochaine étape : ']]) {
          if (!data.recap[key]) continue;
          const p = doc.createElement('p'); p.textContent = label + data.recap[key]; host.append(p);
        }
        if (data.recap.stale) { const note = doc.createElement('small'); note.textContent = 'La conversation a évolué depuis ce point.'; host.append(note); }
      }
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = data?.recap ? 'Modifier le point' : 'Faire le point';
      button.onclick = () => void open(id || data.sessionId); host.append(button);
      if (!id && data?.sessionId && onResume) {
        const resume = doc.createElement('button'); resume.type = 'button'; resume.textContent = 'Reprendre cet échange';
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
        const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Recharger le point de séance';
        retry.onclick = () => void refresh(); host.append(retry);
      }
    }
    async function open(id = currentId()) {
      if (!id) return;
      const token = ++epoch;
      if (await prepare() === false || token !== epoch) return; editingId = id; snapshot = null;
      writeFields(null); status.textContent = 'Chargement…'; setWorking(true, true);
      if (!dialog.open) dialog.showModal();
      try {
        const data = await api(path(id));
        if (token !== epoch || !dialog.open) return;
        snapshot = data; writeFields(data.recap); status.textContent = data.recap?.stale ? 'La conversation a évolué. Mets à jour ce que tu souhaites retenir.' : '';
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
      setWorking(true); status.textContent = 'Préparation du résumé…';
      try {
        const data = await api(`${path(id)}/draft`, { method: 'POST', body: '{}' });
        if (token !== epoch || !dialog.open) return;
        snapshot = data;
        if (['summary', 'takeaway', 'nextStep'].some((key, i) => input(key).value !== before[i])) {
          status.textContent = 'Ton texte a changé pendant la préparation. Il a été conservé ; tu peux enregistrer ton point.'; return;
        }
        writeFields(data.draft);
        status.textContent = `Proposition à relire · ${data.coverage.includedMessages} messages sur ${data.coverage.availableMessages}. Rien n’est enregistré avant ta validation.`;
      } catch (error) { if (token === epoch) status.textContent = error.message; }
      finally { if (token === epoch) setWorking(false); }
    };
    form.onsubmit = async event => {
      event.preventDefault(); if (working || !snapshot) return;
      const token = epoch, id = editingId; setWorking(true, true); status.textContent = 'Enregistrement…';
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
