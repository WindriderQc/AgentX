/* Dad's Desk "À trier", "Idées à trier" and the household shopping list (Dad's Desk and the
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
  const day = (value) => value ? new Date(value).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  // A chosen day means noon local time, like the desk's other date pickers.
  const noon = (value) => new Date(`${value}T12:00:00`).toISOString();

  // ---- À trier: old deadlines to confirm and tasks whose activity passed ----
  function mountTriage(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<div class="row"><div class="grow"><p class="card-kicker">À trier</p><h2>Encore utile ?</h2>
      <p class="muted">Vieilles échéances (souvent tirées d'anciens courriels) et tâches dont l'activité est passée. Rien ne se ferme tout seul : fermez-la, ou donnez la date de l'activité qu'elle sert, ou une nouvelle échéance.</p></div>
      <span data-triage-count class="pill">…</span></div><p data-triage-status class="muted" role="status"></p><div data-triage-list class="stack"></div>`;
    const list = host.querySelector('[data-triage-list]');
    const status = (message) => { host.querySelector('[data-triage-status]').textContent = message; };
    const row = (task) => {
      const why = task.lane === 'expired'
        ? `activité passée le ${day(task.relevantUntil)}`
        : `échéance du ${day(task.dueAt)}${task.createdAt ? ` · capturée le ${day(task.createdAt)}` : ''}`;
      const since = Date.parse(task.lane === 'expired' ? task.relevantUntil : task.dueAt);
      const age = Number.isFinite(since) ? Math.floor((Date.now() - since) / 86400000) : '';
      return `<div class="dad-task ${task.lane === 'expired' ? '' : 'stale'}" data-ref="${esc(task.id)}" data-task-ref="${esc(task.id)}" data-task-age="${age}">
        <div class="dad-task-main"><span class="dad-task-id">#${esc(task.id)}</span><div><strong>${esc(task.title)}</strong><small>${esc(why)}</small></div></div>
        <div class="row wrap dad-task-actions"><button class="compact dad-done" data-triage="close">Fermer</button>
        <input type="date" data-triage-date aria-label="Date pour #${esc(task.id)}">
        <button class="compact" data-triage="relevant" title="La tâche reste utile jusqu'à cette date (jour de l'activité)">Utile jusqu'au</button>
        <button class="compact" data-triage="due" title="Nouvelle date pour faire la tâche">Nouvelle échéance</button></div></div>`;
    };
    async function load() {
      try {
        const data = await api('/api/secretary/tasks?limit=100');
        const tasks = (data.tasks || []).filter((task) => ['recheck', 'expired'].includes(task.lane));
        host.querySelector('[data-triage-count]').textContent = String(tasks.length);
        host.hidden = tasks.length === 0 && !host.dataset.touched;
        list.innerHTML = tasks.length ? tasks.map(row).join('')
          : '<div class="dad-clear"><span>✓</span><strong>Rien à trier.</strong><small>Aucune vieille échéance ni activité passée.</small></div>';
        window.HouseholdDadDay?.clamp?.(list, 3);
        window.HouseholdDadDay?.selectable?.(list, { close: (ref) => post('/api/secretary/tasks/complete', { ref, note: 'Fermée en lot depuis Dad\'s Desk : plus utile.', by: 'household-dad-desk' }), done: (closed) => { host.dataset.touched = 'true'; status(`${closed} tâche${closed === 1 ? '' : 's'} fermée${closed === 1 ? '' : 's'}.`); return load(); } });
      } catch (error) { status(error.message); }
    }
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-triage]');
      if (!button) return;
      const item = button.closest('[data-ref]');
      const ref = item.dataset.ref;
      const date = item.querySelector('[data-triage-date]').value;
      const action = button.dataset.triage;
      if (action !== 'close' && !date) { status('Choisissez d\'abord une date.'); return; }
      button.disabled = true;
      host.dataset.touched = 'true';
      try {
        if (action === 'close') await post('/api/secretary/tasks/complete', { ref, note: 'Fermée depuis Dad\'s Desk : plus utile.', by: 'household-dad-desk' });
        if (action === 'relevant') await post('/api/secretary/tasks/update', { ref, relevantUntil: noon(date), by: 'household-dad-desk' });
        if (action === 'due') await post('/api/secretary/tasks/update', { ref, dueAt: noon(date), by: 'household-dad-desk' });
        status(`#${ref} : ${action === 'close' ? 'fermée' : action === 'relevant' ? `utile jusqu'au ${day(noon(date))}` : `nouvelle échéance le ${day(noon(date))}`}.`);
        await load();
      } catch (error) { button.disabled = false; status(error.message); }
    });
    load();
  }

  // ---- Idées à trier: ideas and reminders from the children and Nestor (#13) ----
  function mountIdeas(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<div class="row"><div class="grow"><p class="card-kicker">Idées à trier</p><h2>Idées et rappels</h2>
      <p class="muted">Ce que les enfants ou Nestor ont noté pour vous. Rien n'est fait avant votre choix : retenir (un fait), tâche perso, TODO AgentX, plus tard ou rejeter.</p></div>
      <span data-ideas-count class="pill">…</span></div><p data-ideas-status class="muted" role="status"></p><div data-ideas-list class="stack"></div>`;
    const list = host.querySelector('[data-ideas-list]');
    const status = (message) => { host.querySelector('[data-ideas-status]').textContent = message; };
    const from = (idea) => `${idea.origin === 'family' ? 'Enfants' : idea.origin === 'secretary' ? 'Secrétaire' : 'Nestor'} · ${idea.memory ? 'à retenir' : idea.kind === 'reminder' ? 'rappel' : 'idée'}${idea.createdAt ? ` · ${day(idea.createdAt)}` : ''}`;
    const row = (idea) => `<div class="dad-task" data-idea="${esc(idea.id)}">
        <div class="dad-task-main"><div><strong>${esc(idea.text)}</strong><small>${esc(from(idea))}</small></div></div>
        <div class="row wrap dad-task-actions">${idea.memory ? '<button class="compact primary" data-idea-action="memory">Retenir</button>' : ''}<button class="compact${idea.memory ? '' : ' primary'}" data-idea-action="personal">Tâche perso</button>
        <button class="compact" data-idea-action="task">TODO AgentX</button><button class="compact" data-idea-action="park">Plus tard</button>
        <button class="compact danger" data-idea-action="reject">Rejeter</button></div></div>`;
    async function load() {
      try {
        const ideas = ((await api('/api/family/ideas')).ideas || []).filter((idea) => idea.status === 'inbox' || idea.status === 'triaged');
        host.querySelector('[data-ideas-count]').textContent = String(ideas.length);
        host.hidden = ideas.length === 0 && !host.dataset.touched;
        list.innerHTML = ideas.length ? ideas.map(row).join('')
          : '<div class="dad-clear"><span>✓</span><strong>Rien à trier.</strong><small>Aucune idée ni rappel en attente.</small></div>';
        window.HouseholdDadDay?.clamp?.(list, 3);
      } catch (error) { status(error.message); }
    }
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-idea-action]');
      if (!button) return;
      const id = button.closest('[data-idea]').dataset.idea;
      const action = button.dataset.ideaAction;
      button.disabled = true;
      host.dataset.touched = 'true';
      try {
        if (action === 'memory') {
          await post(`/api/family/ideas/${encodeURIComponent(id)}/promote`, { targetType: 'memory' });
          status('Retenu dans tes souvenirs.');
        } else if (action === 'personal' || action === 'task') {
          const data = await post(`/api/family/ideas/${encodeURIComponent(id)}/promote`, { targetType: action });
          status(`${action === 'task' ? 'TODO AgentX' : 'Tâche perso'} #${data.task.pipelineId} créée.`);
        } else {
          await post(`/api/family/ideas/${encodeURIComponent(id)}/set-aside`, { action });
          status(action === 'park' ? 'Gardée pour plus tard.' : 'Rejetée.');
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
    host.innerHTML = `<p class="card-kicker">Épicerie</p><h2>${parent ? 'Liste d\'épicerie' : 'Il manque quelque chose ?'}</h2>
      <p class="muted">${parent ? 'La même liste que Nestor. Cochez ce qui est acheté.' : 'Ajoute ce qu\'il faut acheter. Papa verra la liste.'}</p>
      <form data-shopping-form class="row"><input data-shopping-input maxlength="120" required autocomplete="off" placeholder="lait, pommes, pain…" aria-label="Article à acheter" class="grow"><button class="primary">Ajouter</button></form>
      <p data-shopping-status class="muted" role="status"></p><ul data-shopping-items class="shopping-items stack"></ul>`;
    const items = host.querySelector('[data-shopping-items]');
    const status = (message) => { host.querySelector('[data-shopping-status]').textContent = message; };
    const render = (list = []) => {
      items.innerHTML = list.length ? list.map((text) => `<li class="row"><span class="grow">${esc(text)}</span>${parent ? `<button class="compact" data-bought="${esc(text)}">Acheté ✓</button>` : ''}</li>`).join('')
        : '<li class="muted">La liste est vide.</li>';
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
        status(data.alreadyThere?.length ? `Déjà sur la liste : ${data.alreadyThere.join(', ')}.` : 'Ajouté.');
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
