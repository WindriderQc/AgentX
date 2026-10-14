/* Browse source conversations, then clarify one finding against its revision.
   Search covers every loaded page. No inferred wording is silently rewritten. */
(function () {
  function mount({ app, api, esc, onReviewed, onSummary = () => {} }) {
    const view = window.HouseholdPersonalFindingView;
    const host = document.createElement('article');
    host.id = 'dad-proposals'; host.className = 'card full dad-proposals';
    host.innerHTML = `<header class="finding-heading"><div><p class="card-kicker">LE CONTEXTE AVANT L’ACTION</p><h2>Vos échanges, au même endroit</h2><p>Les relevés restent regroupés par courriel. Vous choisissez ce qui devient votre action.</p></div><span data-review-count class="finding-total">…</span></header>
      <div data-review-categories class="finding-tabs" role="group" aria-label="Catégorie de suivi"></div>
      <div class="finding-tools"><label class="finding-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" data-review-search placeholder="Une personne, un sujet, une phrase…" aria-label="Rechercher dans tous les relevés"></label><select data-review-quality aria-label="Filtrer les sources"><option value="">Toutes les sources</option><option value="past-date">Dates extraites déjà passées</option><option value="missing-source">Sans lien vers un courriel</option></select><label class="finding-dismissed"><input type="checkbox" data-review-dismissed> Mis de côté</label></div>
      <p data-review-status role="status" class="finding-status"></p><div class="finding-workspace"><section class="finding-browser" aria-label="Échanges sources"><div class="finding-results" data-review-results aria-live="polite">Lecture de votre liste…</div><div data-review-list class="finding-list"></div><div class="finding-pagination"><button type="button" data-review-page="previous" aria-label="Échanges précédents">←</button><span data-review-page-label></span><button type="button" data-review-page="next" aria-label="Échanges suivants">→</button></div></section><section data-review-detail class="finding-detail" id="finding-selected-detail" aria-label="Relevé sélectionné"></section></div>`;
    (app.querySelector('.dad-side') || app.querySelector('#dad-inbox')).after(host);
    const get = selector => host.querySelector(selector);
    const list = get('[data-review-list]'), detail = get('[data-review-detail]'), status = get('[data-review-status]');
    const dismissed = get('[data-review-dismissed]'), search = get('[data-review-search]'), quality = get('[data-review-quality]');
    const labels = { email: 'Courriels', background: 'Autres suivis', platform: 'Technique', assistant: 'Secrétariat', '': 'Tout' };
    const reasons = { email: 'Relevé de correspondance', platform: 'Suivi technique', assistant: 'Lecture ou analyse du Secrétariat' };
    const drafts = new Map();
    let tasks = [], groups = [], category = 'email', offset = 0, selectedKey = null, selectedId = null, refreshSeq = 0, busy = false;
    const limit = 16;
    const date = value => value ? new Date(value).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const rememberDraft = () => {
      const form = detail.querySelector('form');
      if (form) drafts.set(form.dataset.proposal, { title: form.elements.title.value, dueAt: form.elements.dueAt.value });
    };
    function renderDetail(focus = false) {
      const group = groups.find(group => group.key === selectedKey);
      if (!group) { detail.innerHTML = '<div class="finding-empty"><span aria-hidden="true">↗</span><h3>Choisissez un échange</h3><p>Retrouvez le contexte et choisissez ce qui mérite une action.</p></div>'; return; }
      const task = group.tasks.find(task => task.id === selectedId) || group.tasks[0]; selectedId = task.id;
      // A finding can describe a resolved or historical exchange. Require the
      // owner to name their action rather than confirming that wording by habit.
      const draft = drafts.get(task.id) || { title: '', dueAt: '' }, source = view.mailSource(task.sourceUrl);
      const related = tasks.filter(other => source && view.mailSource(other.sourceUrl)?.key === source.key).length;
      const technical = task.category !== 'email';
      detail.innerHTML = `<div class="finding-detail-top"><button type="button" class="finding-back" data-review-back>← Les échanges</button><span class="finding-kind">${esc(reasons[task.category] || 'Relevé enregistré')}</span><small>#${esc(task.id)}</small></div>
        ${group.tasks.length > 1 ? `<label class="finding-item-picker">Relevés de cet échange<select data-review-item>${group.tasks.map(item => `<option value="${esc(item.id)}" ${item.id === task.id ? 'selected' : ''}>${esc(view.displayTitle(item))}</option>`).join('')}</select></label>` : ''}
        <h3 class="finding-title" tabindex="-1">${esc(view.displayTitle(task))}</h3><div class="finding-qualification"><span>${technical ? 'Suivi en arrière-plan' : 'À lire avant d’en faire votre action'}</span>${task.dueAt ? `<span class="finding-date">${view.flags(task).pastDate ? 'Ancienne date extraite' : 'Date non confirmée'} · ${esc(date(task.dueAt))}</span>` : ''}</div>
        <section class="finding-context"><h4>Le contexte enregistré <small>Source et précisions</small></h4><p>${esc(view.contextExcerpt(task) || 'Aucun contexte enregistré. Consultez la source avant de retenir une action.')}</p>${source ? `<a class="finding-source-link" href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">Ouvrir le courriel <span aria-hidden="true">↗</span></a>` : '<p class="finding-source-missing">Sans lien vers un courriel recorded.</p>'}</section>
        <details class="finding-original" data-proposal-source><summary>Libellé et note complets</summary><p><strong>${esc(task.title)}</strong></p><p>${esc(task.note || 'Aucune note source enregistrée.')}</p><small>${task.createdAt ? `Ajouté à la liste le ${esc(date(task.createdAt))}. ` : ''}Cet écran affiche les informations enregistrées, sans nouvelle lecture du courriel.</small></details>
        ${related > group.tasks.length ? `<button type="button" class="finding-related" data-review-related>Voir les ${related} relevés de cet échange</button>` : ''}
        ${dismissed.checked ? '<div class="finding-resolution"><p>Mis de côté. La source reste accessible.</p><button type="button" data-proposal-action="restore">Remettre dans les relevés</button></div>' : technical ? `<div class="finding-resolution"><h4>${task.category === 'platform' ? 'Le suivi technique a son espace' : 'La lecture reste avec le Secrétariat'}</h4><p>${task.category === 'platform' ? 'Ce suivi reste distinct de vos engagements personnels.' : 'La progression de lecture reste dans le dossier du Secrétariat.'}</p>${task.category === 'platform' ? `<a class="button compact" href="/pipeline?task=${encodeURIComponent(task.id)}">Ouvrir le dossier technique ↗</a>` : ''}<button type="button" data-proposal-action="dismiss">Mettre de côté</button></div>` : `<details class="finding-edit" data-proposal-edit><summary>En faire mon action <span aria-hidden="true">+</span></summary><form data-proposal="${esc(task.id)}"><p>Écrivez ce que vous avez décidé de faire. Laissez la date vide si elle n’est pas confirmée.</p><label>Mon action<textarea name="title" maxlength="200" rows="2" required>${esc(draft.title)}</textarea></label><label>Date <small>facultative</small><input type="date" name="dueAt" value="${esc(draft.dueAt)}"></label><button class="primary" type="submit">Ajouter à mes actions</button></form></details><div class="finding-resolution"><button type="button" data-proposal-action="dismiss">Mettre de côté</button><small>Le relevé reste accessible dans « Mis de côté ».</small></div>`}`;
      if (focus) { host.classList.add('finding-detail-open'); detail.querySelector('.finding-title').focus({ preventScroll: true }); if (matchMedia('(max-width: 760px)').matches) detail.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
    function render() {
      rememberDraft(); groups = view.groupFindings(tasks, { category, query: search.value, quality: quality.value });
      if (offset >= groups.length) offset = 0;
      const visible = groups.slice(offset, offset + limit);
      if (!visible.some(group => group.key === selectedKey)) { selectedKey = visible[0]?.key || null; selectedId = null; }
      const findingCount = groups.reduce((sum, group) => sum + group.tasks.length, 0);
      const linked = groups.filter(group => group.sourceUrl).length, unlinked = groups.length - linked;
      get('[data-review-results]').textContent = `${findingCount} ${findingCount === 1 ? 'relevé' : 'relevés'}${linked ? ` · ${linked} ${linked === 1 ? 'échange' : 'échanges'}` : ''}${unlinked ? ` · ${unlinked} sans lien vers un courriel` : ''}`;
      get('[data-review-count]').textContent = String(tasks.length);
      const mailGroups = view.groupFindings(tasks, { category: 'email' });
      if (!dismissed.checked) onSummary({ exchanges: mailGroups.filter(group => group.sourceUrl).length, findings: tasks.filter(task => task.category === 'email').length });
      get('[data-review-categories]').innerHTML = (category === 'background' ? ['email', 'background', 'platform', 'assistant', ''] : ['email', 'platform', 'assistant', '']).map(key => `<button type="button" data-review-category="${key}" aria-pressed="${category === key}">${labels[key]} <span>${key === 'background' ? tasks.filter(task => ['platform', 'assistant'].includes(task.category)).length : key ? tasks.filter(task => task.category === key).length : tasks.length}</span></button>`).join('');
      list.innerHTML = visible.length ? visible.map(group => `<button type="button" class="finding-thread" data-review-thread="${esc(group.key)}" aria-pressed="${selectedKey === group.key}" aria-controls="finding-selected-detail"><span class="finding-thread-top"><small>${group.sourceUrl ? 'Échange de courriels' : 'Source sans lien'}</small><span class="finding-thread-count">${group.tasks.length}</span></span><strong>${esc(group.title)}</strong>${group.title !== group.preview ? `<span class="finding-thread-preview">${esc(group.preview)}</span>` : ''}<span class="finding-thread-foot"><small>${group.latestAt ? `Enregistré le ${esc(date(group.latestAt))}` : 'Date non enregistrée'}</small>${group.pastDates ? '<small class="finding-thread-date">Date passée</small>' : ''}</span></button>`).join('') : '<div class="finding-no-results"><strong>Aucun relevé correspondant</strong><p>Essayez un autre mot ou un autre filtre.</p><button type="button" data-review-clear>Effacer les filtres</button></div>';
      get('[data-review-page="previous"]').disabled = offset === 0; get('[data-review-page="next"]').disabled = offset + limit >= groups.length;
      get('[data-review-page-label]').textContent = groups.length ? `${offset + 1}–${offset + visible.length} sur ${groups.length}` : '0 échange'; renderDetail();
    }
    async function refresh() {
      const seq = ++refreshSeq; host.setAttribute('aria-busy', 'true');
      const loaded = new Map(); let nextOffset = 0, total = null;
      try {
        do {
          const data = await api(`/api/secretary/tasks?scope=${dismissed.checked ? 'dismissed' : 'review'}&limit=100&offset=${nextOffset}`);
          if (seq !== refreshSeq) return;
          if (total !== null && data.totalCount !== total) throw new Error('La liste a changé pendant la lecture. Actualisez pour la recharger.');
          total = data.totalCount; data.tasks.forEach(task => loaded.set(task.id, task));
          if (data.hasMore && (!Number.isInteger(data.nextOffset) || data.nextOffset <= nextOffset)) throw new Error('La liste complète n’a pas pu être chargée. Actualisez pour réessayer.');
          nextOffset = data.hasMore ? data.nextOffset : null;
        } while (nextOffset !== null);
        if (loaded.size !== total) throw new Error('La liste a changé pendant la lecture. Actualisez pour la recharger.');
        rememberDraft(); tasks = [...loaded.values()]; render();
      } catch (error) { if (seq === refreshSeq) status.textContent = error.message; }
      finally { if (seq === refreshSeq) host.setAttribute('aria-busy', 'false'); }
    }
    async function review(decision) {
      if (busy) return;
      const task = tasks.find(task => task.id === selectedId); if (!task) return;
      rememberDraft(); const payload = { ref: task.id, revision: task.revision, decision };
      if (decision === 'accept') Object.assign(payload, { title: drafts.get(task.id).title, dueAt: drafts.get(task.id).dueAt || null });
      busy = true; detail.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        await api('/api/secretary/tasks/review', { method: 'POST', body: JSON.stringify(payload) }); drafts.delete(task.id);
        status.textContent = decision === 'accept' ? 'Ajouté à vos actions.' : decision === 'restore' ? 'Relevé remis dans la liste.' : 'Mis de côté. La source est conservée.';
        host.classList.remove('finding-detail-open'); selectedKey = null; selectedId = null;
        await onReviewed(); window.dispatchEvent(new Event('household-personal-tasks-changed'));
      } catch (error) { status.textContent = error.message; detail.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
      finally { busy = false; }
    }
    host.addEventListener('submit', event => { event.preventDefault(); review('accept'); });
    host.addEventListener('click', event => {
      if (busy) return;
      const action = event.target.closest('[data-proposal-action]'); if (action) { review(action.dataset.proposalAction); return; }
      const thread = event.target.closest('[data-review-thread]');
      if (thread) { rememberDraft(); selectedKey = thread.dataset.reviewThread; selectedId = null; render(); renderDetail(true); }
      const filter = event.target.closest('[data-review-category]'); if (filter) { category = filter.dataset.reviewCategory; offset = 0; host.classList.remove('finding-detail-open'); render(); get(`[data-review-category="${category}"]`).focus({ preventScroll: true }); }
      const page = event.target.closest('[data-review-page]'); if (page) { offset += page.dataset.reviewPage === 'next' ? limit : -limit; render(); list.scrollTop = 0; }
      if (event.target.closest('[data-review-clear]')) { search.value = ''; quality.value = ''; render(); }
      if (event.target.closest('[data-review-related]')) { rememberDraft(); const key = selectedKey; category = ''; search.value = ''; quality.value = ''; const all = view.groupFindings(tasks, { category: '' }); offset = Math.max(0, Math.floor(all.findIndex(group => group.key === key) / limit) * limit); render(); renderDetail(true); }
      if (event.target.closest('[data-review-back]')) { host.classList.remove('finding-detail-open'); list.querySelector('[aria-pressed="true"]')?.focus(); }
    });
    host.addEventListener('change', event => { if (event.target.matches('[data-review-item]')) { rememberDraft(); selectedId = event.target.value; renderDetail(); get('[data-review-item]')?.focus({ preventScroll: true }); } });
    search.addEventListener('input', () => { offset = 0; host.classList.remove('finding-detail-open'); render(); }); quality.addEventListener('change', () => { offset = 0; host.classList.remove('finding-detail-open'); render(); });
    dismissed.addEventListener('change', () => { offset = 0; selectedKey = null; host.classList.remove('finding-detail-open'); refresh(); });
    app.addEventListener('click', event => {
      const target = event.target.closest('[data-finding-category]');
      if (target && !busy) { category = target.dataset.findingCategory; offset = 0; search.value = ''; quality.value = ''; host.classList.remove('finding-detail-open'); render(); }
    });
    return { refresh };
  }
  window.HouseholdPersonalTaskReview = { mount };
}());
