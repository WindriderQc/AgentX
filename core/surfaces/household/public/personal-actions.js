/* Owner actions: complete listing, readable dates, source context and a revision
   checked editor. This component never promotes a mail finding on its own. */
(function () {
  function mount({ host, api, esc, onChanged }) {
    const sourceView = window.HouseholdPersonalFindingView;
    host.innerHTML = `<header class="action-heading"><div><p class="card-kicker">Un pas à la fois</p><h2>Mes actions <span data-actions-count></span></h2></div><a class="action-quick-add" href="#dad-capture">＋ Ajouter</a><label class="action-search"><span aria-hidden="true">⌕</span><input type="search" data-actions-search aria-label="Rechercher dans mes actions" placeholder="Retrouver une action…"></label></header>
      <div class="action-filters" role="group" aria-label="Filtrer mes actions"></div>
      <p data-actions-status role="status" class="action-status"></p><div data-actions-list class="stack"></div>
      <div class="action-pagination"><button type="button" data-actions-page="previous">← Précédent</button><span data-actions-range></span><button type="button" data-actions-page="next">Suivant →</button></div>
      <dialog class="action-dialog" aria-labelledby="action-editor-title"><form data-action-editor><header><div><p class="card-kicker">Mon engagement</p><h2 id="action-editor-title">Modifier mon action</h2></div><button type="button" data-action-cancel aria-label="Fermer">✕</button></header><label>Ce que je vais faire<textarea name="title" maxlength="200" rows="3" required></textarea></label><div class="action-editor-options"><label>Date <small>facultative</small><input type="date" name="dueAt"></label><label>Priorité<select name="priority"><option value="1">Très haute</option><option value="2">Haute</option><option value="3">Normale</option><option value="4">Basse</option><option value="5">Très basse</option></select></label></div><section data-action-context></section><p data-action-error role="alert"></p><footer><button type="button" data-action-cancel>Annuler</button><button type="submit" class="primary">Enregistrer</button></footer></form></dialog>`;
    const get = selector => host.querySelector(selector), list = get('[data-actions-list]');
    const dialog = get('dialog'), form = get('form'), search = get('[data-actions-search]'), status = get('[data-actions-status]');
    const filters = { all: 'Toutes', today: 'Aujourd’hui', upcoming: 'À venir', inbox: 'Sans date', recheck: 'Dates à revoir' };
    let tasks = [], filter = 'all', offset = 0, seq = 0, editing = null, busy = false;
    const limit = 12;
    const inFilter = (task, key) => key === 'all' || key === 'today' && (task.dueToday || task.overdue)
      || key === 'recheck' && (task.expired || task.recheck) || task.lane === key;
    const localDate = task => task.dueDate || (task.dueAt ? new Intl.DateTimeFormat('en-CA').format(new Date(task.dueAt)) : '');
    const label = task => task.expired || task.recheck ? 'Date à revoir' : task.overdue ? 'En retard'
      : task.dueToday ? 'Aujourd’hui' : task.dueAt ? new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short' }).format(new Date(`${localDate(task)}T12:00:00`)) : 'Sans date';
    function reviewMarkup(task) {
      const review = task.dossierReview || task.dossierHistory;
      if (!review) return `<small class="muted">${task.evidenceSignals ? `${Number(task.evidenceSignals.count)} nouvel indice à recouper avec les dernières sources.` : 'État du dossier à recouper avec les dernières sources.'}</small>`;
      const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('fr-CA') : 'Date non établie';
      const link = citation => {
        try { const url = new URL(citation.url); return url.protocol === 'https:' && ['mail.google.com', 'calendar.google.com'].includes(url.hostname) ? `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Ouvrir la source</a>` : ''; } catch (_) { return ''; }
      };
      const coverage = value => ({ read: 'lecture complète', partial: 'lecture partielle', unavailable: 'indisponible', not_linked: 'source non liée' }[value] || 'à vérifier');
      const actions = { keep: 'Conserver ouverte', update: 'Mettre à jour', complete: 'Terminer', cancel: 'Annuler la tâche' };
      return `<details class="action-dossier"><summary>${task.dossierReview ? 'Proposition sur ce dossier' : review.decision?.decision === 'dismiss' ? 'Proposition écartée — preuves conservées' : 'Dernière décision — preuves conservées'} · ${esc(when(review.observedAt))}</summary><p>${esc(review.summary)}</p>
        ${review.schedulingDecision ? `<p>Décision de date : ${esc(review.schedulingDecision)}</p>` : ''}${review.appointment ? `<p>Rendez-vous : ${esc(review.appointment)}</p>` : ''}
        ${review.action === 'update' ? `<p>Action proposée : <strong>${esc(review.title)}</strong> · échéance : ${esc(when(review.dueAt))}</p>` : ''}
        <p>Engagement attribué à : ${esc(review.actor || 'À clarifier')}</p>
        ${review.remainingWork.length ? `<p>Préparation et travail restant : ${review.remainingWork.map(esc).join(' · ')}</p>` : ''}
        ${review.uncertainties.length ? `<p>À clarifier : ${review.uncertainties.map(esc).join(' · ')}</p>` : ''}
        <p>Lecture des sources sélectionnées le ${esc(when(review.observedAt))}. Courriels : ${esc(coverage(review.coverage.mail))} · agenda : ${esc(coverage(review.coverage.calendar))} · pièces jointes : ${esc(coverage(review.coverage.documents))}. Les documents externes restent à vérifier.</p>
        ${review.citations.map(cite => `<blockquote><p>${esc(cite.quote)}</p><small>${esc(when(cite.date))} · ${link(cite)}</small></blockquote>`).join('')}
        ${task.dossierReview ? `<div class="row wrap"><button type="button" data-dossier-apply="${esc(task.id)}">${esc(actions[review.action])}</button><button type="button" data-dossier-dismiss="${esc(task.id)}">Écarter cette proposition</button></div>` : '<p>Cette revue est conservée; les échanges ultérieurs restent à vérifier.</p>'}</details>`;
    }
    function setBusy(value) {
      busy = value;
      host.setAttribute('aria-busy', String(value));
      list.querySelectorAll('button').forEach(button => { button.disabled = value; });
    }
    function render() {
      const words = sourceView.fold(search.value).trim().split(/\s+/).filter(Boolean);
      const matching = tasks.filter(task => inFilter(task, filter) && words.every(word => sourceView.fold(`${task.title} ${task.note}`).includes(word)));
      if (offset >= matching.length) offset = 0;
      const visible = matching.slice(offset, offset + limit);
      get('[data-actions-count]').textContent = String(tasks.length);
      get('.action-filters').innerHTML = Object.entries(filters).filter(([key]) => key !== 'recheck' || tasks.some(task => inFilter(task, key))).map(([key, name]) => `<button type="button" data-actions-filter="${key}" aria-pressed="${key === filter}">${name}<span>${tasks.filter(task => inFilter(task, key)).length}</span></button>`).join('');
      list.innerHTML = visible.length ? visible.map(task => `<div class="dad-task ${task.overdue ? 'overdue' : task.dueToday ? 'due-today' : ''}" data-task-ref="${esc(task.id)}"><button type="button" class="action-check" data-action-done="${esc(task.id)}" aria-label="Terminer : ${esc(task.title)}"><span aria-hidden="true">✓</span></button><div class="dad-task-main"><strong>${esc(task.title)}</strong><small><span class="action-date ${task.overdue ? 'action-late' : ''}">${esc(label(task))}</span>${task.priority <= 2 ? '<span class="action-priority">Prioritaire</span>' : ''}${task.origin === 'email' ? '<span>Issue d’un courriel · validée</span>' : task.origin === 'chat' ? '<span>Conversation</span>' : ''}</small>${reviewMarkup(task)}</div><div class="dad-task-actions"><details class="dad-task-schedule"><summary aria-label="Planifier : ${esc(task.title)}">Planifier</summary><div><button type="button" data-action-schedule="${esc(task.id)}" data-schedule="0">Aujourd’hui</button><button type="button" data-action-schedule="${esc(task.id)}" data-schedule="1">Demain</button><button type="button" data-action-schedule="${esc(task.id)}" data-schedule="7">Dans une semaine</button></div></details><button type="button" class="action-edit" data-action-edit="${esc(task.id)}" aria-label="Modifier : ${esc(task.title)}">Modifier</button></div></div>`).join('') : `<div class="action-empty"><span aria-hidden="true">✓</span><strong>${search.value ? 'Aucune action correspondante' : filter === 'all' ? 'Votre liste est libre' : 'Aucune action dans cette catégorie'}</strong><p>${search.value ? 'Essayez un autre mot ou revenez à toutes les actions.' : 'Ajoutez une action quand vous en avez besoin.'}</p></div>`;
      get('.action-pagination').hidden = matching.length <= limit;
      get('[data-actions-range]').textContent = `${offset + 1}–${offset + visible.length} sur ${matching.length}`;
      get('[data-actions-page="previous"]').disabled = offset === 0;
      get('[data-actions-page="next"]').disabled = offset + limit >= matching.length;
      if (busy) list.querySelectorAll('button').forEach(button => { button.disabled = true; });
    }
    async function refresh() {
      const run = ++seq, rows = new Map(); let next = 0, total = null;
      host.setAttribute('aria-busy', 'true');
      try {
        do {
          const data = await api(`/api/secretary/tasks?scope=active&limit=100&offset=${next}`);
          if (run !== seq) return;
          if (total !== null && total !== data.totalCount) throw Error('La liste a changé pendant la lecture. Actualisez pour la recharger.');
          total = data.totalCount; data.tasks.forEach(task => rows.set(task.id, task));
          if (data.hasMore && (!Number.isInteger(data.nextOffset) || data.nextOffset <= next)) throw Error('La liste complète n’a pas pu être chargée. Actualisez pour réessayer.');
          next = data.hasMore ? data.nextOffset : null;
        } while (next !== null);
        if (rows.size !== total) throw Error('La liste a changé pendant la lecture. Actualisez pour la recharger.');
        tasks = [...rows.values()]; render();
      } catch (error) { if (run === seq) status.textContent = error.message; }
      finally { if (run === seq) host.setAttribute('aria-busy', String(busy)); }
    }
    const edit = (task, changes) => api('/api/secretary/tasks/edit', { method: 'POST', body: JSON.stringify({ ref: task.id, revision: task.revision, title: task.title, dueAt: task.dueAt, priority: task.priority, ...changes }) });
    function openEditor(task) {
      editing = task; form.elements.title.value = task.title; form.elements.dueAt.value = localDate(task); form.elements.priority.value = String(task.priority);
      get('[data-action-error]').textContent = '';
      const source = sourceView.mailSource(task.sourceUrl);
      get('[data-action-context]').innerHTML = task.note || source ? `<details><summary>Contexte et source</summary><p>${esc(task.note)}</p>${source ? `<a href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">Ouvrir le courriel ↗</a>` : ''}</details>` : '';
      dialog.showModal(); form.elements.title.focus();
    }
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return; setBusy(true);
      form.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const dueAt = form.elements.dueAt.value === localDate(editing) ? editing.dueAt : form.elements.dueAt.value || null;
        await edit(editing, { title: form.elements.title.value, dueAt, priority: Number(form.elements.priority.value) });
        dialog.close(); status.textContent = 'Action mise à jour.'; await onChanged(); get(`[data-action-edit="${editing.id}"]`)?.focus({ preventScroll: true });
      } catch (error) { get('[data-action-error]').textContent = error.message; }
      finally { setBusy(false); form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    host.addEventListener('click', async event => {
      if (busy) return;
      if (event.target.closest('[data-action-cancel]')) { dialog.close(); return; }
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.actionsFilter) { filter = button.dataset.actionsFilter; offset = 0; render(); get(`[data-actions-filter="${filter}"]`).focus(); return; }
      if (button.dataset.actionsPage) { offset += button.dataset.actionsPage === 'next' ? limit : -limit; render(); return; }
      if (button.dataset.dossierApply || button.dataset.dossierDismiss) {
        const task = tasks.find(task => task.id === (button.dataset.dossierApply || button.dataset.dossierDismiss));
        if (!task?.dossierReview) return;
        if (button.dataset.dossierApply && !button.dataset.confirmed) { button.dataset.confirmed = 'true'; button.textContent = 'Confirmer cette décision'; return; }
        setBusy(true); button.disabled = true;
        try {
          await api(`/api/secretary/tasks/dossier/${task.dossierReview.id}/decision`, { method: 'POST', body: JSON.stringify({
            proposalHash: task.dossierReview.proposalHash, revision: task.revision,
            decision: button.dataset.dossierApply ? 'apply' : 'dismiss'
          }) });
          status.textContent = 'Décision enregistrée dans le dossier.'; await onChanged();
        } catch (error) { status.textContent = error.message; button.disabled = false; }
        finally { setBusy(false); }
        return;
      }
      const task = tasks.find(task => task.id === (button.dataset.actionEdit || button.dataset.actionDone || button.dataset.actionSchedule));
      if (!task) return;
      if (button.dataset.actionEdit) { openEditor(task); return; }
      if (button.dataset.actionDone && !button.dataset.confirmed) { button.dataset.confirmed = 'true'; button.classList.add('confirming'); button.innerHTML = 'Confirmer'; button.setAttribute('aria-label', `Confirmer la fin de : ${task.title}`); return; }
      setBusy(true); button.disabled = true;
      try {
        if (button.dataset.actionDone) await api('/api/secretary/tasks/complete', { method: 'POST', body: JSON.stringify({ ref: task.id, expectedDueAt: task.dueAt, by: 'household-dad-desk' }) });
        else { const day = new Date(); day.setDate(day.getDate() + Number(button.dataset.schedule)); await edit(task, { dueAt: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}` }); }
        status.textContent = button.dataset.actionDone ? 'Action terminée.' : 'Date mise à jour.'; await onChanged();
      } catch (error) { status.textContent = error.message; button.disabled = false; }
      finally { setBusy(false); }
    });
    search.addEventListener('input', () => { offset = 0; render(); });
    return { refresh };
  }
  window.HouseholdPersonalActions = { mount };
}());
