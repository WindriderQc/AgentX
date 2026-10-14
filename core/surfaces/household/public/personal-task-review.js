/* Human review of extracted task proposals. Source text stays visible and
   unchanged; accepting requires choosing the action wording and its date. */
(function () {
  function mount({ app, api, esc, onReviewed }) {
    const host = document.createElement('article');
    host.id = 'dad-proposals';
    host.className = 'card full dad-proposals';
    host.innerHTML = `<div class="row"><h2 class="grow">Requests and follow-ups</h2><span data-review-count class="pill">…</span></div>
      <p>All findings stay available by category, with their source. An extracted request may need clarification about who must act and whether later replies settled it.</p>
      <div class="row wrap" data-review-categories role="group" aria-label="Finding category"></div>
      <label class="dad-proposal-dismissed"><input type="checkbox" data-review-dismissed> Show dismissed findings</label>
      <p data-review-status role="status" class="muted"></p><div data-review-list class="stack" aria-live="polite"></div>
      <div class="row wrap"><button type="button" class="compact" data-review-page="previous">Previous</button>
      <span data-review-page-label></span><button type="button" class="compact" data-review-page="next">Next</button></div>`;
    app.querySelector('#dad-inbox').before(host);
    const list = host.querySelector('[data-review-list]');
    const status = host.querySelector('[data-review-status]');
    const dismissed = host.querySelector('[data-review-dismissed]');
    let offset = 0;
    let tasks = [];
    let category = 'email';
    let refreshSeq = 0;
    const limit = 10;
    const reasons = {
      email: 'Request to clarify · extracted from email',
      platform: 'Technical follow-up · platform work',
      assistant: 'Secretary work · reading or analysis',
    };
    const row = task => `<form class="dad-task" data-proposal="${esc(task.id)}">
      <div class="dad-task-main"><span class="dad-task-id">#${esc(task.id)}</span><div class="stack dad-proposal-body">
        <small>${esc(reasons[task.personalReview.reason] || 'Extracted proposal')}</small>
        <strong class="dad-proposal-title">${esc(task.title)}</strong>
        <details data-proposal-source><summary>Original wording and source</summary><p class="dad-proposal-source">${esc(task.note || 'No source note was recorded.')}</p>
          ${task.sourceUrl ? `<a href="${esc(task.sourceUrl)}" target="_blank" rel="noopener noreferrer">Read email thread</a>` : ''}
          ${task.dueAt ? `<p>Unconfirmed date from extraction: ${esc(new Date(task.dueAt).toLocaleString('en-CA'))}</p>` : ''}</details>
        ${dismissed.checked ? '' : `<details class="dad-proposal-edit" data-proposal-edit><summary>Clarify and keep as my action</summary>
          <label>My action<textarea name="title" maxlength="200" rows="2" required aria-label="Action for #${esc(task.id)}">${esc(task.title)}</textarea></label>
          <label>Confirmed due date (leave empty for undated)<input type="date" name="dueAt"></label>
          <button class="compact primary" type="submit">Keep as my action</button></details>`}
      </div></div><div class="row wrap dad-task-actions">
        ${dismissed.checked ? '<button class="compact" type="button" data-proposal-action="restore">Restore finding</button>'
          : '<button class="compact" type="button" data-proposal-action="dismiss">Dismiss finding</button>'}
        <a class="button compact" href="/pipeline?task=${encodeURIComponent(task.id)}">View in Pipeline</a>
      </div></form>`;
    async function refresh() {
      const seq = ++refreshSeq;
      const data = await api(`/api/secretary/tasks?scope=${dismissed.checked ? 'dismissed' : 'review'}${category ? `&category=${category}` : ''}&limit=${limit}&offset=${offset}`);
      if (seq !== refreshSeq) return;
      if (offset && !data.tasks.length) { offset = Math.max(0, offset - limit); return refresh(); }
      tasks = data.tasks;
      host.querySelector('[data-review-count]').textContent = String(data.findingCount);
      const labels = { email: 'Requests to clarify', platform: 'Technical follow-ups', assistant: 'Secretary work' };
      host.querySelector('[data-review-categories]').innerHTML = ['', 'email', 'platform', 'assistant'].map(key => `<button type="button" class="compact" data-review-category="${key}" aria-pressed="${category === key}">${labels[key] || 'All findings'} · ${key ? data.categoryCounts[key] || 0 : data.findingCount}</button>`).join('');
      list.innerHTML = tasks.length ? tasks.map(row).join('') : '<p class="muted">No findings in this category.</p>';
      host.querySelector('[data-review-page="previous"]').disabled = offset === 0;
      host.querySelector('[data-review-page="next"]').disabled = !data.hasMore;
      host.querySelector('[data-review-page-label]').textContent = data.totalCount ? `${offset + 1}–${offset + tasks.length} of ${data.totalCount}` : '0';
    }
    async function review(form, decision) {
      const task = tasks.find(task => task.id === form.dataset.proposal);
      const payload = { ref: task.id, revision: task.revision, decision };
      if (decision === 'accept') {
        payload.title = form.elements.title.value;
        payload.dueAt = form.elements.dueAt.value || null;
      }
      form.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        await api('/api/secretary/tasks/review', { method: 'POST', body: JSON.stringify(payload) });
        status.textContent = decision === 'accept' ? `Action #${task.id} accepted.` : decision === 'restore' ? 'Finding restored to its category.' : 'Finding dismissed; its source is retained.';
        await onReviewed();
        window.dispatchEvent(new Event('household-personal-tasks-changed'));
      } catch (error) {
        status.textContent = error.message;
        form.querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    }
    host.addEventListener('submit', event => { event.preventDefault(); review(event.target, 'accept'); });
    host.addEventListener('click', event => {
      const action = event.target.closest('[data-proposal-action]');
      if (action) review(action.closest('form'), action.dataset.proposalAction);
      const filter = event.target.closest('[data-review-category]');
      if (filter) { category = filter.dataset.reviewCategory; offset = 0; refresh().catch(error => { status.textContent = error.message; }); }
      const page = event.target.closest('[data-review-page]');
      if (page) { offset += page.dataset.reviewPage === 'next' ? limit : -limit; refresh().catch(error => { status.textContent = error.message; }); }
    });
    dismissed.addEventListener('change', () => { offset = 0; refresh().catch(error => { status.textContent = error.message; }); });
    return { refresh };
  }
  window.HouseholdPersonalTaskReview = { mount };
}());
