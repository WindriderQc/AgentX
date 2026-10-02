/* Core owns selected notes independently of the conversation engine. */
window.mountPersonalNotes = function ({ host, evidence, api, esc }) {
  host.innerHTML = `<summary>Souvenirs personnels</summary><p class="muted">Tes notes personnelles, conservées dans AgentX et disponibles dans tes conversations Nestor.</p>
    <div class="row wrap"><button type="button" data-note-add>Ajouter un souvenir</button><button type="button" data-note-refresh>Actualiser</button></div>
    <p data-note-status class="muted" role="status">Ouvre cette section pour consulter tes souvenirs.</p>
    <form data-note-form hidden><label for="personalNoteText">Note</label><textarea id="personalNoteText" rows="4" maxlength="2000" required></textarea>
      <label for="personalNoteKind">Type</label><select id="personalNoteKind"><option value="fact">Fait</option><option value="preference">Préférence</option><option value="decision">Décision</option></select>
      <div class="row wrap"><button type="submit">Enregistrer</button><button type="button" data-note-cancel>Annuler</button></div></form>
    <div data-note-list class="personal-note-list"></div><small>Oublier retire le souvenir sélectionné. Les anciennes conversations conservent leur texte.</small>`;
  const get = name => host.querySelector(`[data-note-${name}]`);
  const form = get('form'), input = host.querySelector('#personalNoteText'), kind = host.querySelector('#personalNoteKind');
  let rows = [], editId = null, busy = false, request = 0;
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date indisponible';
  const lock = value => { busy = value; host.querySelectorAll('button, textarea, select').forEach(el => { el.disabled = value; }); };
  const call = body => api('/api/voice-personas/private/notes', { method: 'POST', body: JSON.stringify(body) });
  const edit = note => {
    editId = note?.id || null; input.value = note?.text || ''; kind.value = note?.kind || 'fact';
    form.hidden = false; input.focus(); input.setSelectionRange(0, 0); input.scrollTop = 0;
  };
  const cancel = () => { form.hidden = true; editId = null; input.value = ''; };
  async function load() {
    const epoch = ++request;
    get('status').textContent = 'Chargement des souvenirs…';
    try {
      const data = await call({ operation: 'list' });
      if (epoch !== request) return;
      rows = data.notes;
      get('list').innerHTML = rows.length ? rows.map(note => `<article class="personal-note"><p>${esc(note.text)}</p>
        <small>${esc({ fact: 'Fait', preference: 'Préférence', decision: 'Décision' }[note.kind] || note.kind)} · ${esc(date(note.updatedAt))} · Nestor personnel</small>
        <div class="row wrap"><button type="button" data-note-edit="${esc(note.id)}">Modifier</button><button type="button" data-note-forget="${esc(note.id)}">Oublier</button></div></article>`).join('')
        : '<p class="empty">Aucun souvenir personnel enregistré pour le moment.</p>';
      get('status').textContent = data.truncated ? `${rows.length} souvenirs affichés sur ${data.total}.` : `${data.total} souvenir${data.total === 1 ? '' : 's'} personnel${data.total === 1 ? '' : 's'}.`;
      get('list').scrollTop = 0;
    } catch (error) {
      if (epoch !== request) return;
      rows = []; get('list').replaceChildren();
      get('status').textContent = 'Les souvenirs n’ont pas pu être chargés. Utilise Actualiser pour réessayer.';
      throw error;
    }
  }
  async function mutate(body, success) {
    if (busy) return;
    ++request; lock(true);
    try {
      const receipt = await call(body);
      cancel();
      try { await load(); get('status').textContent = success(receipt); }
      catch { get('status').textContent = success(receipt) + ' La liste n’a pas pu être rechargée; utilise Actualiser.'; }
    } catch { get('status').textContent = 'La modification n’a pas pu être confirmée. Ton brouillon est conservé ; actualise avant de réessayer.'; }
    finally { lock(false); }
  }
  host.addEventListener('toggle', () => { if (host.open && !busy) void load().catch(() => {}); });
  get('refresh').onclick = () => { if (!busy) void load().catch(() => {}); };
  get('add').onclick = () => edit();
  get('cancel').onclick = cancel;
  form.onsubmit = event => {
    event.preventDefault();
    void mutate({ operation: 'remember', ...(editId ? { id: editId } : {}), text: input.value.trim(), kind: kind.value },
      result => result.changed === false ? 'Ce souvenir est déjà enregistré.' : result.created ? 'Souvenir enregistré.' : 'Souvenir corrigé. Les prochaines réponses utiliseront la nouvelle version.');
  };
  get('list').onclick = event => {
    if (busy) return;
    const target = event.target.closest('button');
    const id = target?.dataset.noteEdit || target?.dataset.noteForget;
    const note = rows.find(row => row.id === id);
    if (!note) return;
    if (target.dataset.noteEdit) edit(note);
    else void mutate({ operation: 'forget', id }, result => result.removed ? 'Souvenir oublié.' : 'Ce souvenir était déjà absent.');
  };
  function show(value) {
    evidence.hidden = !value;
    if (!value) { evidence.replaceChildren(); return; }
    const count = value.notes?.length || 0;
    const skipped = value.status === 'not-required';
    const legacyCount = value.legacyHouseholdUsedCount ?? value.legacyHouseholdReadCount ?? 0;
    const personalStatus = skipped ? 'Souvenirs non consultés' : value.status === 'ready' ? `${count} souvenir${count === 1 ? '' : 's'}` : 'Souvenirs indisponibles';
    const status = `Contexte personnel · ${personalStatus}${legacyCount ? ` · ${legacyCount} anciennes notes` : ''}`;
    evidence.innerHTML = `<summary>${esc(status)}</summary><p class="muted">Souvenirs fournis pour la dernière réponse.</p>
      ${value.saved ? '<p>Selected note saved to your personal Nestor.</p>' : ''}
      ${skipped ? '<p>Souvenirs personnels and earlier topics were not consulted for this exchange.</p>' : value.status !== 'ready' ? '<p>The personal source could not be read. This does not mean it contains no notes.</p>' : ''}
      ${(value.notes || []).map(note => `<p>${esc(note.text)}${note.textTruncated ? '…' : ''}<small>Nestor personnel · ${esc(date(note.updatedAt))}</small></p>`).join('')}
      ${value.notesTruncated ? '<p>Only part of the selected notes is included. Open Souvenirs personnels to see the full list.</p>' : ''}
      ${value.previousGoal ? `<p>Previous topic: ${esc(value.previousGoal.text)}<small>${esc(date(value.previousGoal.at))} · conversation context</small></p>` : ''}
      ${value.sources?.personal_tasks ? `<p>Personal tasks: ${value.sources.personal_tasks === 'available' ? 'consulted' : 'unavailable'}</p>` : ''}
      ${value.legacyHouseholdStatus === 'unavailable' ? '<p>Earlier Household notes could not be read.</p>' : ''}
      ${value.legacyHouseholdReadCount ? `<p>${value.legacyHouseholdReadCount} earlier Household note(s) read; ${Number.isInteger(value.legacyHouseholdUsedCount) ? `${value.legacyHouseholdUsedCount} relevant excerpt(s) supplied.` : 'only bounded excerpts are supplied.'} <a href="/dad/memories">Souvenirs</a></p>` : ''}`;
    if (host.open && !busy) void load().catch(() => {});
  }
  return { show };
};
