/* Parent task filters, recorded deadlines and revision-bound edits. No inferred routines. */
(function () {
  'use strict';
  const fold = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr-CA');
  function nextDay(day, offset) {
    const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  }
  function matches(chore, { profile = '', view = 'all', query = '', today } = {}) {
    if (profile && chore.profileId !== profile) return false;
    if (query && !fold(`${chore.title} ${chore.note}`).includes(fold(query.trim()))) return false;
    if (view === 'review') return chore.status === 'review';
    if (view === 'today') return chore.dueToday || chore.overdue;
    if (view === 'week') return Boolean(chore.dueDay && chore.dueDay >= today && chore.dueDay < nextDay(today, 7));
    if (view === 'undated') return !chore.dueAt;
    return true;
  }
  function mount({ host, list, api, esc, refresh, toast }) {
    const frequency = window.FamilyFrequency;
    host.innerHTML = `<section class="family-plan" aria-label="Organize responsibilities">
      <div class="family-metrics"><button type="button" data-family-view="all" aria-pressed="true"><strong data-family-total>…</strong><span>Active</span></button><button type="button" data-family-view="review" aria-pressed="false"><strong data-family-review>…</strong><span>To approve</span></button><button type="button" data-family-view="today" aria-pressed="false"><strong data-family-today>…</strong><span>Today / overdue</span></button><button type="button" data-family-view="week" aria-pressed="false"><strong data-family-week>…</strong><span>Next 7 days</span></button></div>
      <div class="family-filter-bar"><label><span>Child</span><select data-family-profile><option value="">All children</option></select></label><label class="grow"><span>Search a task</span><input data-family-query type="search" maxlength="160" placeholder="Title or instructions…"></label><button type="button" data-family-undated class="compact" aria-pressed="false">Undated</button><button type="button" data-family-refresh class="compact">Refresh</button></div>
      <p data-family-coverage class="muted" role="status"></p><details class="family-agenda"><summary>Due dates in the next 7 days</summary><p class="muted">Recorded task dates. Upcoming repeats appear after approval.</p><div data-family-agenda class="family-agenda-grid"></div></details>
      <p data-family-result class="muted" role="status" aria-live="polite"></p></section>
      <dialog data-family-edit aria-labelledby="familyEditTitle"><form data-family-edit-form><h2 id="familyEditTitle">Edit the task</h2><p class="muted">Changes apply to this routine and its upcoming repeats.</p>
      <label><span>Task</span><input name="title" required maxlength="160"></label><label><span>For</span><select name="profileId" required></select></label><div class="family-edit-grid"><label><span>Date</span><input name="dueAt" type="date"></label><label><span>Frequency</span><select name="cadence">${frequency.options()}</select></label><label><span>Stars</span><select name="stars">${[1,2,3,4,5].map(value => `<option>${value}</option>`).join('')}</select></label>${frequency.fields()}</div><label><span>Optional instructions</span><textarea name="note" rows="3" maxlength="1000"></textarea></label><p data-family-edit-status role="status" aria-live="polite"></p><div class="row wrap"><button type="submit" class="primary">Save</button><button type="button" data-family-edit-close>Close</button></div></form></dialog>`;
    const pick = selector => host.querySelector(selector);
    const dialog = pick('dialog'), form = pick('[data-family-edit-form]');
    let chores = [], profiles = [], today = '', view = 'all', edit = null, saving = false, pending = false;
    const syncFrequency = frequency.bind(form, form.elements.cadence, () => today || new Date().toISOString().slice(0, 10));
    function render() {
      if (!today) return;
      const selected = pick('[data-family-profile]').value;
      const filtered = chores.filter(chore => matches(chore, { profile: selected, view, query: pick('[data-family-query]').value, today }));
      const profileMap = new Map(profiles.map(profile => [profile.id, profile]));
      filtered.sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review') || Number(b.overdue) - Number(a.overdue) || String(a.dueDay || '9999').localeCompare(String(b.dueDay || '9999')) || a.priority - b.priority);
      pick('[data-family-result]').textContent = `${filtered.length} of ${chores.length} tasks shown`;
      host.querySelectorAll('[data-family-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.familyView === view)));
      pick('[data-family-undated]').setAttribute('aria-pressed', String(view === 'undated'));
      list.innerHTML = filtered.length ? filtered.map(chore => {
        const profile = profileMap.get(chore.profileId), waiting = chore.status === 'review';
        const date = chore.dueDay ? new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${chore.dueDay}T12:00:00Z`)) : 'Undated';
        return `<article class="parent-chore ${waiting ? 'warning' : ''}"><div class="grow"><strong>${esc(profile?.avatar || '⭐')} ${esc(chore.title)}</strong><small>${esc(profile?.displayName || chore.profileId)} · ${esc(frequency.label(chore))} · ${'★'.repeat(chore.stars)} · ${esc(date)}</small>${chore.note ? `<p class="family-chore-note">${esc(chore.note)}</p>` : ''}<span class="pill ${waiting ? 'waiting' : chore.overdue ? 'down' : chore.dueToday ? 'ok' : ''}">${waiting ? 'To approve' : chore.overdue ? 'Overdue' : chore.dueToday ? 'Today' : 'To do'}</span></div><div class="row wrap">${waiting ? `<button class="compact primary" data-chore-action="approve" data-ref="${esc(chore.id)}">Approve</button><button class="compact" data-chore-action="reopen" data-ref="${esc(chore.id)}">Redo</button>` : `<button class="compact" data-chore-edit="${esc(chore.id)}">Edit</button>`}<button class="compact danger" data-chore-action="cancel" data-ref="${esc(chore.id)}">Cancel</button></div></article>`;
      }).join('') : '<div class="family-clear"><strong>No task in this view.</strong><p>Change the filters or add a responsibility.</p></div>';
      if (pending) list.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const inProfile = chores.filter(chore => !selected || chore.profileId === selected);
      for (const [selector, predicate] of [['total', () => true], ['review', chore => chore.status === 'review'], ['today', chore => chore.dueToday || chore.overdue], ['week', chore => matches(chore, { view: 'week', today })]]) {
        pick(`[data-family-${selector}]`).textContent = inProfile.filter(predicate).length;
      }
      pick('[data-family-agenda]').innerHTML = Array.from({ length: 7 }, (_, offset) => {
        const day = nextDay(today, offset), tasks = inProfile.filter(chore => chore.dueDay === day);
        const label = new Intl.DateTimeFormat('en-CA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
        return `<section class="family-agenda-day"><h3>${offset === 0 ? 'Today' : esc(label)}</h3>${tasks.length ? tasks.map(chore => `<p><strong>${esc(chore.title)}</strong><small>${esc(profileMap.get(chore.profileId)?.displayName || chore.profileId)}${chore.status === 'review' ? ' · to approve' : ''}</small></p>`).join('') : '<p class="muted">Nothing due</p>'}</section>`;
      }).join('');
    }
    function update(profileRows, data) {
      profiles = profileRows; chores = data.chores; today = data.today || new Date().toISOString().slice(0, 10);
      const previous = pick('[data-family-profile]').value;
      pick('[data-family-profile]').innerHTML = '<option value="">All children</option>' + profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profile.displayName)}</option>`).join('');
      if (profiles.some(profile => profile.id === previous)) pick('[data-family-profile]').value = previous;
      pick('[data-family-coverage]').textContent = data.hasMore ? 'View limited to the first 100 active tasks. Counters and due dates cover this list.' : '';
      render();
    }
    host.addEventListener('click', event => {
      const button = event.target.closest('[data-family-view]');
      if (button) { view = button.dataset.familyView; render(); }
    });
    pick('[data-family-undated]').onclick = () => { view = view === 'undated' ? 'all' : 'undated'; render(); };
    pick('[data-family-profile]').onchange = render; pick('[data-family-query]').oninput = render;
    pick('[data-family-refresh]').onclick = refresh;
    list.onclick = async event => {
      const editButton = event.target.closest('[data-chore-edit]');
      if (editButton && !pending) {
        edit = chores.find(chore => chore.id === editButton.dataset.choreEdit);
        if (!edit) return;
        form.elements.profileId.innerHTML = profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profile.displayName)}</option>`).join('');
        if (!profiles.some(profile => profile.id === edit.profileId)) { toast('The profile is archived. Choose an active profile to edit this task.'); }
        for (const key of ['title', 'note', 'profileId', 'cadence', 'stars']) form.elements[key].value = edit[key] ?? '';
        form.elements.dueAt.value = edit.dueDay || '';
        frequency.fill(form, edit); syncFrequency();
        pick('[data-family-edit-status]').textContent = ''; dialog.showModal(); return;
      }
      const button = event.target.closest('[data-chore-action]');
      if (!button || pending) return;
      if (button.dataset.choreAction === 'cancel' && !window.confirm('Cancel this task?')) return;
      pending = true; list.querySelectorAll('button').forEach(node => { node.disabled = true; });
      try {
        await api(`/api/family/chores/${button.dataset.choreAction}`, { method: 'POST', body: JSON.stringify({ ref: button.dataset.ref }) });
        toast(button.dataset.choreAction === 'approve' ? 'Task approved.' : button.dataset.choreAction === 'reopen' ? 'Task set back to do.' : 'Task cancelled.');
        await refresh();
      } catch { toast('Action not confirmed. Refresh the tasks before trying again.'); }
      finally { pending = false; list.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    };
    const close = () => { if (!saving) dialog.close(); };
    pick('[data-family-edit-close]').onclick = close;
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    form.onsubmit = async event => {
      event.preventDefault(); if (!edit || saving) return;
      const values = { ref: edit.id, expectedRevision: edit.revision };
      for (const key of ['title', 'note', 'profileId', 'cadence']) values[key] = form.elements[key].value;
      values.dueAt = form.elements.dueAt.value || null; values.stars = Number(form.elements.stars.value);
      Object.assign(values, frequency.read(form, values.cadence));
      saving = true; form.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        await api('/api/family/chores/update', { method: 'POST', body: JSON.stringify(values) });
        dialog.close(); toast('Task updated.'); await refresh();
      } catch (error) { pick('[data-family-edit-status]').textContent = error.status === 409
        ? 'This task changed. Close this window, refresh and open Edit again. Your text stays here until you close it.'
        : 'Save not confirmed. Your changes stay in this form. Refresh before trying again.'; }
      finally { saving = false; form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    };
    return { update };
  }
  window.FamilyOrganizer = { mount, matches, nextDay };
})();
