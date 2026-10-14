/* Browse source conversations, then clarify one finding against its revision.
   Search covers every loaded page. No inferred wording is silently rewritten. */
(function () {
  function mount({ app, api, esc, onReviewed }) {
    const view = window.HouseholdPersonalFindingView;
    const host = document.createElement('article');
    host.id = 'dad-proposals'; host.className = 'card full dad-proposals';
    host.innerHTML = `<header class="finding-heading"><div><p class="card-kicker">From your correspondence</p><h2>Things to clarify</h2><p>Extracted requests and observations. Open the exchange before deciding what still needs you.</p></div><span data-review-count class="finding-total">…</span></header>
      <div data-review-categories class="finding-tabs" role="group" aria-label="Finding category"></div>
      <div class="finding-tools"><label class="finding-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" data-review-search placeholder="Search a person, subject or phrase" aria-label="Search all findings"></label><select data-review-quality aria-label="Evidence filter"><option value="">All evidence</option><option value="past-date">Past extracted dates</option><option value="missing-source">No email link</option></select><label class="finding-dismissed"><input type="checkbox" data-review-dismissed> Set aside</label></div>
      <p data-review-status role="status" class="finding-status"></p><div class="finding-workspace"><section class="finding-browser" aria-label="Source conversations"><div class="finding-results" data-review-results aria-live="polite">Reading your list…</div><div data-review-list class="finding-list"></div><div class="finding-pagination"><button type="button" data-review-page="previous" aria-label="Previous conversations">←</button><span data-review-page-label></span><button type="button" data-review-page="next" aria-label="Next conversations">→</button></div></section><section data-review-detail class="finding-detail" id="finding-selected-detail" aria-label="Selected finding"></section></div>`;
    (app.querySelector('.dad-side') || app.querySelector('#dad-inbox')).after(host);
    const get = selector => host.querySelector(selector);
    const list = get('[data-review-list]'), detail = get('[data-review-detail]'), status = get('[data-review-status]');
    const dismissed = get('[data-review-dismissed]'), search = get('[data-review-search]'), quality = get('[data-review-quality]');
    const labels = { email: 'Requests', background: 'Background', platform: 'Technical', assistant: 'Secretary', '': 'Everything' };
    const reasons = { email: 'Extracted from email', platform: 'Technical follow-up', assistant: 'Secretary reading or analysis' };
    const drafts = new Map();
    let tasks = [], groups = [], category = 'email', offset = 0, selectedKey = null, selectedId = null, refreshSeq = 0, busy = false;
    const limit = 16;
    const date = value => value ? new Date(value).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const rememberDraft = () => {
      const form = detail.querySelector('form');
      if (form) drafts.set(form.dataset.proposal, { title: form.elements.title.value, dueAt: form.elements.dueAt.value });
    };
    function renderDetail(focus = false) {
      const group = groups.find(group => group.key === selectedKey);
      if (!group) { detail.innerHTML = '<div class="finding-empty"><span aria-hidden="true">↗</span><h3>Choose an exchange</h3><p>Read its context and decide whether an action belongs on your list.</p></div>'; return; }
      const task = group.tasks.find(task => task.id === selectedId) || group.tasks[0]; selectedId = task.id;
      const draft = drafts.get(task.id) || { title: view.displayTitle(task), dueAt: '' }, source = view.mailSource(task.sourceUrl);
      const related = tasks.filter(other => source && view.mailSource(other.sourceUrl)?.key === source.key).length;
      const technical = task.category !== 'email';
      detail.innerHTML = `<div class="finding-detail-top"><button type="button" class="finding-back" data-review-back>← Exchanges</button><span class="finding-kind">${esc(reasons[task.category] || 'Extracted finding')}</span><small>#${esc(task.id)}</small></div>
        ${group.tasks.length > 1 ? `<label class="finding-item-picker">Findings in this exchange<select data-review-item>${group.tasks.map(item => `<option value="${esc(item.id)}" ${item.id === task.id ? 'selected' : ''}>${esc(view.displayTitle(item))}</option>`).join('')}</select></label>` : ''}
        <h3 class="finding-title" tabindex="-1">${esc(view.displayTitle(task))}</h3><div class="finding-qualification"><span>${technical ? 'Background follow-up' : 'Your responsibility and the current status are unverified'}</span>${task.dueAt ? `<span class="finding-date">${view.flags(task).pastDate ? 'Past extracted date' : 'Unconfirmed date'} · ${esc(date(task.dueAt))}</span>` : ''}</div>
        <section class="finding-context"><h4>Recorded context <small>Secretary extraction</small></h4><p>${esc(view.contextExcerpt(task) || 'No context was recorded. Check the source before keeping an action.')}</p>${source ? `<a class="finding-source-link" href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">Read the email exchange <span aria-hidden="true">↗</span></a>` : '<p class="finding-source-missing">No email link recorded.</p>'}</section>
        <details class="finding-original" data-proposal-source><summary>Original wording & source note</summary><p><strong>${esc(task.title)}</strong></p><p>${esc(task.note || 'No source note was recorded.')}</p><small>${task.createdAt ? `Added to the list ${esc(date(task.createdAt))}. ` : ''}The original email has not been re-read by this screen.</small></details>
        ${related > group.tasks.length ? `<button type="button" class="finding-related" data-review-related>See all ${related} findings from this exchange</button>` : ''}
        ${dismissed.checked ? '<div class="finding-resolution"><p>Set aside. The source is still available.</p><button type="button" data-proposal-action="restore">Restore finding</button></div>' : technical ? `<div class="finding-resolution"><h4>${task.category === 'platform' ? 'Keep technical work in its workspace' : 'Keep reading progress with the Secretary'}</h4><p>${task.category === 'platform' ? 'This finding has not become a personal commitment.' : 'A reading offset is background progress, rather than an action for your day.'}</p>${task.category === 'platform' ? `<a class="button compact" href="/pipeline?task=${encodeURIComponent(task.id)}">Open technical record ↗</a>` : ''}<button type="button" data-proposal-action="dismiss">Set aside</button></div>` : `<details class="finding-edit" data-proposal-edit><summary>Make this my action <span aria-hidden="true">+</span></summary><form data-proposal="${esc(task.id)}"><p>After checking the exchange, write what you will do. Choose a date only if it is confirmed.</p><label>My action<textarea name="title" maxlength="200" rows="2" required>${esc(draft.title)}</textarea></label><label>Due date <small>optional</small><input type="date" name="dueAt" value="${esc(draft.dueAt)}"></label><button class="primary" type="submit">Add to my actions</button></form></details><div class="finding-resolution"><button type="button" data-proposal-action="dismiss">Set aside</button><small>Keep the source for later.</small></div>`}`;
      if (focus) { host.classList.add('finding-detail-open'); detail.querySelector('.finding-title').focus({ preventScroll: true }); if (matchMedia('(max-width: 760px)').matches) detail.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
    function render() {
      rememberDraft(); groups = view.groupFindings(tasks, { category, query: search.value, quality: quality.value });
      if (offset >= groups.length) offset = 0;
      const visible = groups.slice(offset, offset + limit);
      if (!visible.some(group => group.key === selectedKey)) { selectedKey = visible[0]?.key || null; selectedId = null; }
      const findingCount = groups.reduce((sum, group) => sum + group.tasks.length, 0);
      const linked = groups.filter(group => group.sourceUrl).length, unlinked = groups.length - linked;
      get('[data-review-results]').textContent = `${findingCount} ${findingCount === 1 ? 'finding' : 'findings'}${linked ? ` · ${linked} ${linked === 1 ? 'exchange' : 'exchanges'}` : ''}${unlinked ? ` · ${unlinked} without an email link` : ''}`;
      get('[data-review-count]').textContent = String(tasks.length);
      get('[data-review-categories]').innerHTML = (category === 'background' ? ['email', 'background', 'platform', 'assistant', ''] : ['email', 'platform', 'assistant', '']).map(key => `<button type="button" data-review-category="${key}" aria-pressed="${category === key}">${labels[key]} <span>${key === 'background' ? tasks.filter(task => ['platform', 'assistant'].includes(task.category)).length : key ? tasks.filter(task => task.category === key).length : tasks.length}</span></button>`).join('');
      list.innerHTML = visible.length ? visible.map(group => `<button type="button" class="finding-thread" data-review-thread="${esc(group.key)}" aria-pressed="${selectedKey === group.key}" aria-controls="finding-selected-detail"><span class="finding-thread-top"><small>${group.sourceUrl ? 'Email exchange' : 'Source not linked'}</small><span class="finding-thread-count">${group.tasks.length}</span></span><strong>${esc(group.title)}</strong>${group.title !== group.preview ? `<span class="finding-thread-preview">${esc(group.preview)}</span>` : ''}<span class="finding-thread-foot"><small>${group.latestAt ? `Added ${esc(date(group.latestAt))}` : 'Date not recorded'}</small>${group.pastDates ? '<small class="finding-thread-date">Past date</small>' : ''}</span></button>`).join('') : '<div class="finding-no-results"><strong>No matching findings</strong><p>Try another phrase or evidence filter.</p><button type="button" data-review-clear>Clear filters</button></div>';
      get('[data-review-page="previous"]').disabled = offset === 0; get('[data-review-page="next"]').disabled = offset + limit >= groups.length;
      get('[data-review-page-label]').textContent = groups.length ? `${offset + 1}–${offset + visible.length} of ${groups.length}` : '0 exchanges'; renderDetail();
    }
    async function refresh() {
      const seq = ++refreshSeq; host.setAttribute('aria-busy', 'true');
      const loaded = new Map(); let nextOffset = 0, total = null;
      try {
        do {
          const data = await api(`/api/secretary/tasks?scope=${dismissed.checked ? 'dismissed' : 'review'}&limit=100&offset=${nextOffset}`);
          if (seq !== refreshSeq) return;
          if (total !== null && data.totalCount !== total) throw new Error('Your list changed during loading. Refresh to search the complete list.');
          total = data.totalCount; data.tasks.forEach(task => loaded.set(task.id, task));
          if (data.hasMore && (!Number.isInteger(data.nextOffset) || data.nextOffset <= nextOffset)) throw new Error('The complete list could not be loaded. Refresh to try again.');
          nextOffset = data.hasMore ? data.nextOffset : null;
        } while (nextOffset !== null);
        if (loaded.size !== total) throw new Error('Your list changed during loading. Refresh to search the complete list.');
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
        status.textContent = decision === 'accept' ? 'Added to your actions.' : decision === 'restore' ? 'Finding restored.' : 'Set aside. Its source is retained.';
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
