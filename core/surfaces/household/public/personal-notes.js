/* Core owns selected notes independently of the conversation engine. */
window.mountPersonalNotes = function ({ host, evidence, api, esc }) {
  host.innerHTML = `<summary>Personal memories</summary><p class="muted">Your personal notes, kept in AgentX and available in your Nestor conversations.</p>
    <div class="row wrap"><button type="button" data-note-add>Add a memory</button><button type="button" data-note-refresh>Refresh</button></div>
    <p data-note-status class="muted" role="status">Open this section to see your memories.</p>
    <form data-note-form hidden><label for="personalNoteText">Note</label><textarea id="personalNoteText" rows="4" maxlength="2000" required></textarea>
      <label for="personalNoteKind">Type</label><select id="personalNoteKind"><option value="fact">Fact</option><option value="preference">Preference</option><option value="decision">Decision</option></select>
      <div class="row wrap"><button type="submit">Save</button><button type="button" data-note-cancel>Cancel</button></div></form>
    <div data-note-list class="personal-note-list"></div><small>Forget removes the selected memory. Earlier conversations keep their text.</small>`;
  const get = name => host.querySelector(`[data-note-${name}]`);
  const form = get('form'), input = host.querySelector('#personalNoteText'), kind = host.querySelector('#personalNoteKind');
  let rows = [], editId = null, busy = false, request = 0;
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
  const lock = value => { busy = value; host.querySelectorAll('button, textarea, select').forEach(el => { el.disabled = value; }); };
  const call = body => api('/api/voice-personas/private/notes', { method: 'POST', body: JSON.stringify(body) });
  const edit = note => {
    editId = note?.id || null; input.value = note?.text || ''; kind.value = note?.kind || 'fact';
    form.hidden = false; input.focus(); input.setSelectionRange(0, 0); input.scrollTop = 0;
  };
  const cancel = () => { form.hidden = true; editId = null; input.value = ''; };
  async function load() {
    const epoch = ++request;
    get('status').textContent = 'Loading memories…';
    try {
      const data = await call({ operation: 'list' });
      if (epoch !== request) return;
      rows = data.notes;
      get('list').innerHTML = rows.length ? rows.map(note => `<article class="personal-note"><p>${esc(note.text)}</p>
        <small>${esc({ fact: 'Fact', preference: 'Preference', decision: 'Decision' }[note.kind] || note.kind)} · ${esc(date(note.updatedAt))} · Personal Nestor</small>
        <div class="row wrap"><button type="button" data-note-edit="${esc(note.id)}">Edit</button><button type="button" data-note-forget="${esc(note.id)}">Forget</button></div></article>`).join('')
        : '<p class="empty">No personal memory saved yet.</p>';
      get('status').textContent = data.truncated ? `${rows.length} of ${data.total} memories shown.` : `${data.total} personal ${data.total === 1 ? 'memory' : 'memories'}.`;
      get('list').scrollTop = 0;
    } catch (error) {
      if (epoch !== request) return;
      rows = []; get('list').replaceChildren();
      get('status').textContent = 'Memories could not be loaded. Use Refresh to try again.';
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
      catch { get('status').textContent = success(receipt) + ' The list could not be reloaded; use Refresh.'; }
    } catch { get('status').textContent = 'The change could not be confirmed. Your draft is kept; refresh before trying again.'; }
    finally { lock(false); }
  }
  host.addEventListener('toggle', () => { if (host.open && !busy) void load().catch(() => {}); });
  get('refresh').onclick = () => { if (!busy) void load().catch(() => {}); };
  get('add').onclick = () => edit();
  get('cancel').onclick = cancel;
  form.onsubmit = event => {
    event.preventDefault();
    void mutate({ operation: 'remember', ...(editId ? { id: editId } : {}), text: input.value.trim(), kind: kind.value },
      result => result.changed === false ? 'This memory is already saved.' : result.created ? 'Memory saved.' : 'Memory corrected. Upcoming answers will use the new version.');
  };
  get('list').onclick = event => {
    if (busy) return;
    const target = event.target.closest('button');
    const id = target?.dataset.noteEdit || target?.dataset.noteForget;
    const note = rows.find(row => row.id === id);
    if (!note) return;
    if (target.dataset.noteEdit) edit(note);
    else void mutate({ operation: 'forget', id }, result => result.removed ? 'Memory forgotten.' : 'This memory was already gone.');
  };
  function show(value) {
    evidence.hidden = !value;
    if (!value) { evidence.replaceChildren(); return; }
    const count = value.notes?.length || 0;
    const skipped = value.status === 'not-required';
    const legacyCount = value.legacyHouseholdUsedCount ?? value.legacyHouseholdReadCount ?? 0;
    const personalStatus = skipped ? 'Memories not consulted' : value.status === 'ready' ? `${count} ${count === 1 ? 'memory' : 'memories'}` : 'Memories unavailable';
    const status = `Personal context · ${personalStatus}${legacyCount ? ` · ${legacyCount} older notes` : ''}`;
    evidence.innerHTML = `<summary>${esc(status)}</summary><p class="muted">Memories provided for the last answer.</p>
      ${value.saved ? '<p>Selected note saved to your personal Nestor.</p>' : ''}
      ${skipped ? '<p>Personal memories and earlier topics were not consulted for this exchange.</p>' : value.status !== 'ready' ? '<p>The personal source could not be read. This does not mean it contains no notes.</p>' : ''}
      ${(value.notes || []).map(note => `<p>${esc(note.text)}${note.textTruncated ? '…' : ''}<small>Personal Nestor · ${esc(date(note.updatedAt))}</small></p>`).join('')}
      ${value.notesTruncated ? '<p>Only part of the selected notes is included. Open Personal memories to see the full list.</p>' : ''}
      ${value.previousGoal ? `<p>Previous topic: ${esc(value.previousGoal.text)}<small>${esc(date(value.previousGoal.at))} · conversation context</small></p>` : ''}
      ${value.sources?.personal_tasks ? `<p>Personal tasks: ${value.sources.personal_tasks === 'available' ? 'consulted' : 'unavailable'}</p>` : ''}
      ${value.legacyHouseholdStatus === 'unavailable' ? '<p>Earlier Household notes could not be read.</p>' : ''}
      ${value.legacyHouseholdReadCount ? `<p>${value.legacyHouseholdReadCount} earlier Household note(s) read; ${Number.isInteger(value.legacyHouseholdUsedCount) ? `${value.legacyHouseholdUsedCount} relevant excerpt(s) supplied.` : 'only bounded excerpts are supplied.'} <a href="/dad/memories">Memories</a></p>` : ''}`;
    if (host.open && !busy) void load().catch(() => {});
  }
  return { show };
};
