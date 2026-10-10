/* Parent task filters, recorded deadlines and revision-bound edits. No inferred routines. */
(function () {
  'use strict';
  const cadenceLabel = { once: 'Ponctuelle', daily: 'Chaque jour', weekly: 'Chaque semaine' };
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
    host.innerHTML = `<section class="family-plan" aria-label="Organiser les responsabilités">
      <div class="family-metrics"><button type="button" data-family-view="all" aria-pressed="true"><strong data-family-total>…</strong><span>Actives</span></button><button type="button" data-family-view="review" aria-pressed="false"><strong data-family-review>…</strong><span>À valider</span></button><button type="button" data-family-view="today" aria-pressed="false"><strong data-family-today>…</strong><span>Aujourd’hui / en retard</span></button><button type="button" data-family-view="week" aria-pressed="false"><strong data-family-week>…</strong><span>7 prochains jours</span></button></div>
      <div class="family-filter-bar"><label><span>Enfant</span><select data-family-profile><option value="">Tous les enfants</option></select></label><label class="grow"><span>Rechercher une tâche</span><input data-family-query type="search" maxlength="160" placeholder="Titre ou consigne…"></label><button type="button" data-family-undated class="compact" aria-pressed="false">Sans date</button><button type="button" data-family-refresh class="compact">Actualiser</button></div>
      <p data-family-coverage class="muted" role="status"></p><details class="family-agenda"><summary>Échéances des 7 prochains jours</summary><p class="muted">Dates enregistrées des tâches. Les prochaines répétitions apparaissent après validation.</p><div data-family-agenda class="family-agenda-grid"></div></details>
      <p data-family-result class="muted" role="status" aria-live="polite"></p></section>
      <dialog data-family-edit aria-labelledby="familyEditTitle"><form data-family-edit-form><h2 id="familyEditTitle">Modifier la tâche</h2><p class="muted">Les changements s’appliquent à cette routine et à ses prochaines répétitions.</p>
      <label><span>Tâche</span><input name="title" required maxlength="160"></label><label><span>Pour</span><select name="profileId" required></select></label><div class="family-edit-grid"><label><span>Date</span><input name="dueAt" type="date"></label><label><span>Fréquence</span><select name="cadence">${Object.entries(cadenceLabel).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label><label><span>Étoiles</span><select name="stars">${[1,2,3,4,5].map(value => `<option>${value}</option>`).join('')}</select></label></div><label><span>Consigne facultative</span><textarea name="note" rows="3" maxlength="1000"></textarea></label><p data-family-edit-status role="status" aria-live="polite"></p><div class="row wrap"><button type="submit" class="primary">Enregistrer</button><button type="button" data-family-edit-close>Fermer</button></div></form></dialog>`;
    const pick = selector => host.querySelector(selector);
    const dialog = pick('dialog'), form = pick('[data-family-edit-form]');
    let chores = [], profiles = [], today = '', view = 'all', edit = null, saving = false, pending = false;
    function render() {
      if (!today) return;
      const selected = pick('[data-family-profile]').value;
      const filtered = chores.filter(chore => matches(chore, { profile: selected, view, query: pick('[data-family-query]').value, today }));
      const profileMap = new Map(profiles.map(profile => [profile.id, profile]));
      filtered.sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review') || Number(b.overdue) - Number(a.overdue) || String(a.dueDay || '9999').localeCompare(String(b.dueDay || '9999')) || a.priority - b.priority);
      pick('[data-family-result]').textContent = `${filtered.length} sur ${chores.length} tâches affichées`;
      host.querySelectorAll('[data-family-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.familyView === view)));
      pick('[data-family-undated]').setAttribute('aria-pressed', String(view === 'undated'));
      list.innerHTML = filtered.length ? filtered.map(chore => {
        const profile = profileMap.get(chore.profileId), waiting = chore.status === 'review';
        const date = chore.dueDay ? new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${chore.dueDay}T12:00:00Z`)) : 'Sans date';
        return `<article class="parent-chore ${waiting ? 'warning' : ''}"><div class="grow"><strong>${esc(profile?.avatar || '⭐')} ${esc(chore.title)}</strong><small>${esc(profile?.displayName || chore.profileId)} · ${esc(cadenceLabel[chore.cadence] || chore.cadence)} · ${'★'.repeat(chore.stars)} · ${esc(date)}</small>${chore.note ? `<p class="family-chore-note">${esc(chore.note)}</p>` : ''}<span class="pill ${waiting ? 'waiting' : chore.overdue ? 'down' : chore.dueToday ? 'ok' : ''}">${waiting ? 'À valider' : chore.overdue ? 'En retard' : chore.dueToday ? 'Aujourd’hui' : 'À faire'}</span></div><div class="row wrap">${waiting ? `<button class="compact primary" data-chore-action="approve" data-ref="${esc(chore.id)}">Valider</button><button class="compact" data-chore-action="reopen" data-ref="${esc(chore.id)}">À refaire</button>` : `<button class="compact" data-chore-edit="${esc(chore.id)}">Modifier</button>`}<button class="compact danger" data-chore-action="cancel" data-ref="${esc(chore.id)}">Annuler</button></div></article>`;
      }).join('') : '<div class="family-clear"><strong>Aucune tâche dans cette vue.</strong><p>Change les filtres ou ajoute une responsabilité.</p></div>';
      if (pending) list.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const inProfile = chores.filter(chore => !selected || chore.profileId === selected);
      for (const [selector, predicate] of [['total', () => true], ['review', chore => chore.status === 'review'], ['today', chore => chore.dueToday || chore.overdue], ['week', chore => matches(chore, { view: 'week', today })]]) {
        pick(`[data-family-${selector}]`).textContent = inProfile.filter(predicate).length;
      }
      pick('[data-family-agenda]').innerHTML = Array.from({ length: 7 }, (_, offset) => {
        const day = nextDay(today, offset), tasks = inProfile.filter(chore => chore.dueDay === day);
        const label = new Intl.DateTimeFormat('fr-CA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
        return `<section class="family-agenda-day"><h3>${offset === 0 ? 'Aujourd’hui' : esc(label)}</h3>${tasks.length ? tasks.map(chore => `<p><strong>${esc(chore.title)}</strong><small>${esc(profileMap.get(chore.profileId)?.displayName || chore.profileId)}${chore.status === 'review' ? ' · à valider' : ''}</small></p>`).join('') : '<p class="muted">Aucune échéance</p>'}</section>`;
      }).join('');
    }
    function update(profileRows, data) {
      profiles = profileRows; chores = data.chores; today = data.today || new Date().toISOString().slice(0, 10);
      const previous = pick('[data-family-profile]').value;
      pick('[data-family-profile]').innerHTML = '<option value="">Tous les enfants</option>' + profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profile.displayName)}</option>`).join('');
      if (profiles.some(profile => profile.id === previous)) pick('[data-family-profile]').value = previous;
      pick('[data-family-coverage]').textContent = data.hasMore ? 'Vue limitée aux 100 premières tâches actives. Les compteurs et échéances couvrent cette liste.' : '';
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
        if (!profiles.some(profile => profile.id === edit.profileId)) { toast('Le profil est archivé. Choisis un profil actif pour modifier cette tâche.'); }
        for (const key of ['title', 'note', 'profileId', 'cadence', 'stars']) form.elements[key].value = edit[key] ?? '';
        form.elements.dueAt.value = edit.dueDay || '';
        pick('[data-family-edit-status]').textContent = ''; dialog.showModal(); return;
      }
      const button = event.target.closest('[data-chore-action]');
      if (!button || pending) return;
      if (button.dataset.choreAction === 'cancel' && !window.confirm('Annuler cette tâche ?')) return;
      pending = true; list.querySelectorAll('button').forEach(node => { node.disabled = true; });
      try {
        await api(`/api/family/chores/${button.dataset.choreAction}`, { method: 'POST', body: JSON.stringify({ ref: button.dataset.ref }) });
        toast(button.dataset.choreAction === 'approve' ? 'Tâche validée.' : button.dataset.choreAction === 'reopen' ? 'Tâche remise à faire.' : 'Tâche annulée.');
        await refresh();
      } catch { toast('Action non confirmée. Actualise les tâches avant de réessayer.'); }
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
      saving = true; form.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        await api('/api/family/chores/update', { method: 'POST', body: JSON.stringify(values) });
        dialog.close(); toast('Tâche mise à jour.'); await refresh();
      } catch (error) { pick('[data-family-edit-status]').textContent = error.status === 409
        ? 'Cette tâche a changé. Ferme cette fenêtre, actualise et ouvre à nouveau Modifier. Ton texte reste ici jusqu’à la fermeture.'
        : 'Enregistrement non confirmé. Tes changements restent dans ce formulaire. Actualise avant de réessayer.'; }
      finally { saving = false; form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    };
    return { update };
  }
  window.FamilyOrganizer = { mount, matches, nextDay };
})();
