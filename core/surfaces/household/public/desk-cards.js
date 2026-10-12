/* Dad's Desk "To sort", "Ideas to sort" and the household shopping list (Dad's Desk and the
   Kids Room). Core owns both; these cards only read and call its routes.
   app.js renders the pages, so the cards mount next to its elements. */
(function () {
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok || body.ok === false || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
    return body.data;
  }
  const post = (url, payload) => api(url, { method: 'POST', body: JSON.stringify(payload) });
  const day = (value) => value ? new Date(value).toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  // A chosen day means noon local time, like the desk's other date pickers.
  const noon = (value) => new Date(`${value}T12:00:00`).toISOString();

  // ---- To sort: old deadlines to confirm and tasks whose activity passed ----
  function mountTriage(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<div class="row"><div class="grow"><p class="card-kicker">To sort</p><h2>Still useful?</h2>
      <p class="muted">Old due dates (often taken from old emails) and tasks whose activity has passed. Nothing closes on its own: close it, give the date of the activity it serves, or set a new due date.</p></div>
      <span data-triage-count class="pill">…</span></div><p data-triage-status class="muted" role="status"></p><div data-triage-list class="stack"></div>`;
    const list = host.querySelector('[data-triage-list]');
    const status = (message) => { host.querySelector('[data-triage-status]').textContent = message; };
    const row = (task) => {
      const why = task.lane === 'expired'
        ? `activity passed on ${day(task.relevantUntil)}`
        : `due ${day(task.dueAt)}${task.createdAt ? ` · captured ${day(task.createdAt)}` : ''}`;
      const since = Date.parse(task.lane === 'expired' ? task.relevantUntil : task.dueAt);
      const age = Number.isFinite(since) ? Math.floor((Date.now() - since) / 86400000) : '';
      return `<div class="dad-task ${task.lane === 'expired' ? '' : 'stale'}" data-ref="${esc(task.id)}" data-task-ref="${esc(task.id)}" data-task-age="${age}">
        <div class="dad-task-main"><span class="dad-task-id">#${esc(task.id)}</span><div><strong>${esc(task.title)}</strong><small>${esc(why)}</small></div></div>
        <div class="row wrap dad-task-actions"><button class="compact dad-done" data-triage="close">Close</button>
        <input type="date" data-triage-date aria-label="Date for #${esc(task.id)}">
        <button class="compact" data-triage="relevant" title="The task stays useful until this date (day of the activity)">Useful until</button>
        <button class="compact" data-triage="due" title="New date to do the task">New due date</button></div></div>`;
    };
    async function load() {
      try {
        const data = await api('/api/secretary/tasks?limit=100');
        const tasks = (data.tasks || []).filter((task) => ['recheck', 'expired'].includes(task.lane));
        host.querySelector('[data-triage-count]').textContent = String(tasks.length);
        host.hidden = tasks.length === 0 && !host.dataset.touched;
        list.innerHTML = tasks.length ? tasks.map(row).join('')
          : '<div class="dad-clear"><span>✓</span><strong>Nothing to sort.</strong><small>No old due date or past activity.</small></div>';
        window.HouseholdDadDay?.clamp?.(list, 3);
        window.HouseholdDadDay?.selectable?.(list, { close: (ref) => post('/api/secretary/tasks/complete', { ref, note: 'Fermée en lot depuis Dad\'s Desk : plus utile.', by: 'household-dad-desk' }), done: (closed) => { host.dataset.touched = 'true'; status(`${closed} task${closed === 1 ? '' : 's'} closed.`); return load(); } });
      } catch (error) { status(error.message); }
    }
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-triage]');
      if (!button) return;
      const item = button.closest('[data-ref]');
      const ref = item.dataset.ref;
      const date = item.querySelector('[data-triage-date]').value;
      const action = button.dataset.triage;
      if (action !== 'close' && !date) { status('Choose a date first.'); return; }
      button.disabled = true;
      host.dataset.touched = 'true';
      try {
        if (action === 'close') await post('/api/secretary/tasks/complete', { ref, note: 'Fermée depuis Dad\'s Desk : plus utile.', by: 'household-dad-desk' });
        if (action === 'relevant') await post('/api/secretary/tasks/update', { ref, relevantUntil: noon(date), by: 'household-dad-desk' });
        if (action === 'due') await post('/api/secretary/tasks/update', { ref, dueAt: noon(date), by: 'household-dad-desk' });
        status(`#${ref}: ${action === 'close' ? 'closed' : action === 'relevant' ? `useful until ${day(noon(date))}` : `new due date ${day(noon(date))}`}.`);
        await load();
      } catch (error) { button.disabled = false; status(error.message); }
    });
    load();
  }

  // ---- Ideas to sort: ideas and reminders from the children and Nestor (#13) ----
  function mountIdeas(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<div class="row"><div class="grow"><p class="card-kicker">Ideas to sort</p><h2>Ideas and reminders</h2>
      <p class="muted">What the kids or Nestor noted for you. Nothing happens before you choose: remember (a fact), personal task, AgentX TODO, later or reject.</p></div>
      <span data-ideas-count class="pill">…</span></div><p data-ideas-status class="muted" role="status"></p><div data-ideas-list class="stack"></div>`;
    const list = host.querySelector('[data-ideas-list]');
    const status = (message) => { host.querySelector('[data-ideas-status]').textContent = message; };
    const from = (idea) => `${idea.origin === 'family' ? 'Kids' : idea.origin === 'secretary' ? 'Secretary' : 'Nestor'} · ${idea.memory ? 'to remember' : idea.kind === 'reminder' ? 'reminder' : 'idea'}${idea.createdAt ? ` · ${day(idea.createdAt)}` : ''}`;
    const row = (idea) => `<div class="dad-task" data-idea="${esc(idea.id)}">
        <div class="dad-task-main"><div><strong>${esc(idea.text)}</strong><small>${esc(from(idea))}</small></div></div>
        <div class="row wrap dad-task-actions">${idea.memory ? '<button class="compact primary" data-idea-action="memory">Remember</button>' : ''}<button class="compact${idea.memory ? '' : ' primary'}" data-idea-action="personal">Personal task</button>
        <select class="compact" data-idea-service aria-label="AgentX TODO service">
          <option value="">TODO service…</option><option value="agentx-coding">Coding Team</option>
          <option value="core">Core</option><option value="benchmark">Benchmark</option>
          <option value="rag">RAG</option><option value="data">Data</option>
        </select><button class="compact" data-idea-action="task">AgentX TODO</button><button class="compact" data-idea-action="park">Later</button>
        <button class="compact danger" data-idea-action="reject">Reject</button></div></div>`;
    async function load() {
      try {
        const ideas = ((await api('/api/family/ideas')).ideas || []).filter((idea) => idea.status === 'inbox' || idea.status === 'triaged');
        host.querySelector('[data-ideas-count]').textContent = String(ideas.length);
        host.hidden = ideas.length === 0 && !host.dataset.touched;
        list.innerHTML = ideas.length ? ideas.map(row).join('')
          : '<div class="dad-clear"><span>✓</span><strong>Nothing to sort.</strong><small>No idea or reminder waiting.</small></div>';
        window.HouseholdDadDay?.clamp?.(list, 3);
      } catch (error) { status(error.message); }
    }
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-idea-action]');
      if (!button) return;
      const id = button.closest('[data-idea]').dataset.idea;
      const action = button.dataset.ideaAction;
      const service = action === 'task' ? button.closest('[data-idea]').querySelector('[data-idea-service]').value : '';
      if (action === 'task' && !service) { status('Choose the AgentX TODO service.'); return; }
      button.disabled = true;
      host.dataset.touched = 'true';
      try {
        if (action === 'memory') {
          await post(`/api/family/ideas/${encodeURIComponent(id)}/promote`, { targetType: 'memory' });
          status('Saved to your memories.');
        } else if (action === 'personal' || action === 'task') {
          const data = await post(`/api/family/ideas/${encodeURIComponent(id)}/promote`, { targetType: action, ...(service ? { service } : {}) });
          status(`${action === 'task' ? 'AgentX TODO' : 'Personal task'} #${data.task.pipelineId} created.`);
        } else {
          await post(`/api/family/ideas/${encodeURIComponent(id)}/set-aside`, { action });
          status(action === 'park' ? 'Kept for later.' : 'Rejected.');
        }
        await load();
      } catch (error) { button.disabled = false; status(error.message); }
    });
    load();
  }

  // ---- Household shopping list: children add, the parent crosses off ----
  function mountShopping(host) {
    host.dataset.mounted = 'true';
    const parent = host.dataset.shoppingList === 'dad';
    host.innerHTML = `<p class="card-kicker">Groceries</p><h2>${parent ? 'Grocery list' : 'Missing something?'}</h2>
      <p class="muted">${parent ? 'The same list as Nestor. Check off what was bought.' : 'Add what needs buying. Dad will see the list.'}</p>
      <form data-shopping-form class="row"><input data-shopping-input maxlength="120" required autocomplete="off" placeholder="milk, apples, bread…" aria-label="Item to buy" class="grow"><button class="primary">Add</button></form>
      <p data-shopping-status class="muted" role="status"></p><ul data-shopping-items class="shopping-items stack"></ul>`;
    const items = host.querySelector('[data-shopping-items]');
    const status = (message) => { host.querySelector('[data-shopping-status]').textContent = message; };
    const render = (list = []) => {
      items.innerHTML = list.length ? list.map((text) => `<li class="row"><span class="grow">${esc(text)}</span>${parent ? `<button class="compact" data-bought="${esc(text)}">Bought ✓</button>` : ''}</li>`).join('')
        : '<li class="muted">The list is empty.</li>';
    };
    const load = async () => { try { render((await api('/api/family/shopping')).items); } catch (error) { status(error.message); } };
    host.querySelector('[data-shopping-form]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = host.querySelector('[data-shopping-input]');
      const wanted = input.value.split(',').map((text) => text.trim()).filter(Boolean);
      if (!wanted.length) return;
      try {
        const data = await post('/api/family/shopping/add', { items: wanted });
        input.value = '';
        status(data.alreadyThere?.length ? `Already on the list: ${data.alreadyThere.join(', ')}.` : 'Added.');
        render(data.items);
      } catch (error) { status(error.message); }
    });
    items.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-bought]');
      if (!button) return;
      button.disabled = true;
      try { render((await post('/api/family/shopping/bought', { items: [button.dataset.bought] })).items); status(''); }
      catch (error) { button.disabled = false; status(error.message); }
    });
    load();
  }

  function scan() {
    const inbox = document.querySelector('.dad-inbox');
    if (inbox && !document.querySelector('[data-dad-triage]')) {
      inbox.insertAdjacentHTML('beforebegin', '<article class="card full dad-triage" id="dad-triage" data-dad-triage></article>');
    }
    if (inbox && !document.querySelector('[data-dad-ideas]')) {
      inbox.insertAdjacentHTML('beforebegin', '<article class="card full dad-ideas" id="dad-ideas" data-dad-ideas hidden></article>');
    }
    const capture = document.querySelector('.dad-capture');
    if (capture && !document.querySelector('[data-shopping-list="dad"]')) {
      capture.insertAdjacentHTML('afterend', '<article class="card dad-shopping" data-shopping-list="dad"></article>');
    }
    const kids = document.getElementById('kidsContent');
    if (kids && !document.querySelector('[data-shopping-list="kid"]')) {
      kids.insertAdjacentHTML('afterend', '<article class="kids-help kids-shopping" data-shopping-list="kid"></article>');
    }
    document.querySelectorAll('[data-dad-triage]:not([data-mounted])').forEach(mountTriage);
    document.querySelectorAll('[data-dad-ideas]:not([data-mounted])').forEach(mountIdeas);
    document.querySelectorAll('[data-shopping-list]:not([data-mounted])').forEach(mountShopping);
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan);
}());
