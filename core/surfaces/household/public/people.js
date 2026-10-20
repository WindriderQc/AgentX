(function () {
  'use strict';
  window.mountPeople = async function ({ app, api, esc }) {
    const reasons = { 'shared-email': 'Même adresse courriel', 'shared-phone': 'Même numéro de téléphone',
      'same-name': 'Même nom complet — à vérifier, ce peut être deux personnes' };
    const day = value => value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium' }).format(new Date(value)) : '';
    app.innerHTML = `<section class="personal-history people"><header><p class="card-kicker">PERSONNEL</p><h1>Personnes</h1>
      <p>Les personnes de vos courriels et de vos carnets de contacts. Rien n’est fusionné sans votre accord, et une fusion se défait.</p></header>
      <h2>Fusions à décider</h2><p data-people-merge-status class="muted" role="status"></p><div data-people-merges class="history-list"></div>
      <details data-people-done><summary>Fusions acceptées</summary><div data-people-accepted class="history-list"></div></details>
      <h2>Toutes les personnes</h2><form data-people-search class="history-filters"><label>Rechercher<input type="search" name="query" maxlength="200" placeholder="Un nom, une adresse ou une organisation"></label><button type="submit">Afficher</button></form>
      <p data-people-status role="status" aria-live="polite"></p><div data-people-list class="history-list"></div>
      <nav class="row wrap" aria-label="Pages des personnes"><button type="button" data-people-prev>Précédentes</button><button type="button" data-people-next>Suivantes</button></nav></section>`;
    const get = name => app.querySelector(`[data-people-${name}]`);
    let offset = 0, next = null, merges = [], accepted = [];
    const brief = person => person ? `<strong>${esc(person.displayName || 'Sans nom')}</strong>
      <span class="muted">${esc([...person.emails.slice(0, 3), ...person.phones.slice(0, 2)].join(' · '))}</span>
      <span class="muted">${person.exchanges} échange(s)${person.lastSeen ? ` · dernier ${esc(day(person.lastSeen))}` : ''}</span>` : '<span class="muted">Personne indisponible</span>';
    const mergeCard = (row, done) => `<article class="history-entry" data-merge="${esc(row.id)}"><p class="card-kicker">${esc(reasons[row.reason] || row.reason)}${row.evidence ? ` · ${esc(row.evidence)}` : ''}</p>
      <div class="people-pair"><div>${brief(row.a)}</div><div>${brief(row.b)}</div></div>
      <div class="row wrap">${done ? '<button type="button" data-decide="undo">Défaire cette fusion</button>'
        : '<button type="button" data-decide="accept">Fusionner</button><button type="button" data-decide="dismiss">Ce sont deux personnes</button>'}</div></article>`;
    const personCard = person => `<article class="history-entry" data-person="${esc(person.id)}"><details data-person-details="${esc(person.id)}">
      <summary>${brief(person)}</summary><div data-person-body><p class="muted">Lecture…</p></div></details></article>`;
    async function loadMerges() {
      try {
        [merges, accepted] = await Promise.all([api('/api/secretary/people/merges?limit=50').then(r => r.proposals),
          api('/api/secretary/people/merges?state=accepted&limit=50').then(r => r.proposals)]);
        get('merges').innerHTML = merges.length ? merges.map(row => mergeCard(row, false)).join('') : '<p class="empty">Aucune fusion à décider.</p>';
        get('accepted').innerHTML = accepted.length ? accepted.map(row => mergeCard(row, true)).join('') : '<p class="empty">Aucune fusion acceptée.</p>';
        get('merge-status').textContent = merges.length ? `${merges.length} fusion(s) proposée(s).` : '';
      } catch { get('merge-status').textContent = 'Les fusions sont indisponibles pour le moment.'; }
    }
    async function loadPeople() {
      const query = new FormData(get('search')).get('query');
      const params = new URLSearchParams({ limit: '30', offset: String(offset), ...(query ? { query } : {}) });
      get('status').textContent = 'Lecture des personnes…';
      try {
        const result = await api(`/api/secretary/people?${params}`);
        next = result.nextOffset;
        get('list').innerHTML = result.people.length ? result.people.map(personCard).join('') : '<p class="empty">Aucune personne dans cette sélection.</p>';
        get('status').textContent = `${result.total} personne(s), les plus fréquentes d’abord${result.people.length ? ` · ${offset + 1}–${offset + result.people.length}` : ''}`;
      } catch { get('list').replaceChildren(); get('status').textContent = 'La liste est indisponible. Utilisez Afficher pour la relire.'; }
      finally { get('prev').disabled = offset === 0; get('next').disabled = next === null; }
    }
    async function showPerson(details) {
      const body = details.querySelector('[data-person-body]');
      try {
        const { person, exchanges, cards, souvenirs } = await api(`/api/secretary/people/${encodeURIComponent(details.dataset.personDetails)}`);
        body.innerHTML = `<dl><div><dt>Noms vus</dt><dd>${esc(person.names.join(', ') || '—')}</dd></div>
          <div><dt>Adresses</dt><dd>${esc(person.emails.join(', ') || '—')}</dd></div>
          <div><dt>Téléphones</dt><dd>${esc(person.phones.join(', ') || '—')}</dd></div>
          <div><dt>Organisations</dt><dd>${esc(person.organizations.join(', ') || '—')}</dd></div>
          <div><dt>Échanges</dt><dd>${person.exchanges}${person.firstSeen ? ` · du ${esc(day(person.firstSeen))} au ${esc(day(person.lastSeen))}` : ''}</dd></div></dl>
          ${souvenirs.length ? `<h3>Souvenirs</h3><ul>${souvenirs.map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>` : ''}
          ${cards.length ? `<h3>Fiches de contact</h3><ul>${cards.map(c => `<li>${esc([c.name, c.email, ...c.phones, c.organization].filter(Boolean).join(' · '))}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</li>`).join('')}</ul>` : ''}
          ${exchanges.length ? `<h3>Derniers échanges</h3><ul>${exchanges.slice(0, 15).map(x => `<li>${esc(day(x.occurredAt) || 'Date inconnue')} · ${x.direction === 'sent' ? 'envoyé à' : 'reçu de'} ${esc(x.name || x.email)}</li>`).join('')}</ul>` : ''}`;
        details.dataset.loaded = 'true';
      } catch { body.textContent = 'Cette personne ne peut pas être lue pour le moment.'; }
    }
    app.addEventListener('toggle', event => {
      const details = event.target;
      if (details.matches?.('[data-person-details]') && details.open && !details.dataset.loaded) void showPerson(details);
    }, true);
    app.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-decide]');
      const card = button?.closest('[data-merge]');
      if (!card) return;
      const row = [...merges, ...accepted].find(item => item.id === card.dataset.merge);
      if (!row) return;
      const action = button.dataset.decide;
      if (action === 'accept' && !window.confirm(`Fusionner « ${row.a?.displayName} » et « ${row.b?.displayName} » en une seule personne ?\n\nVous pourrez défaire cette fusion.`)) return;
      app.querySelectorAll('[data-decide]').forEach(el => { el.disabled = true; });
      let message = { accept: 'Fusion faite.', dismiss: 'Gardées comme deux personnes.', undo: 'Fusion défaite.' }[action];
      try {
        await api(`/api/secretary/people/merges/${encodeURIComponent(row.id)}/${action}`, { method: 'POST', body: JSON.stringify({ revision: row.revision }) });
      } catch { message = 'La décision n’a pas pu être confirmée. La liste est relue; réessayez au besoin.'; }
      await Promise.all([loadMerges(), loadPeople()]);
      get('merge-status').textContent = message;
    });
    get('search').onsubmit = event => { event.preventDefault(); offset = 0; void loadPeople(); };
    get('prev').onclick = () => { offset = Math.max(0, offset - 30); void loadPeople(); };
    get('next').onclick = () => { if (next !== null) { offset = next; void loadPeople(); } };
    await Promise.all([loadMerges(), loadPeople()]);
  };
})();
