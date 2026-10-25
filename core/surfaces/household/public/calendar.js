(function () {
  'use strict';
  const form = document.getElementById('calendar-period');
  const status = document.getElementById('calendar-status');
  const zone = document.getElementById('calendar-zone');
  const coverage = document.getElementById('calendar-coverage');
  const list = document.getElementById('calendar-events');
  let generation = 0;
  const content = (state, detail = {}) => {
    window.AgentXPresentedContent = { contract: 'agentx.presentation/v1', state, ...detail };
  };
  function node(tag, text) {
    const element = document.createElement(tag); element.textContent = text; return element;
  }
  function when(event, timeZone) {
    if (event.start.date) {
      return `${event.start.date} → ${event.end.date} (journée entière, fin exclue)`;
    }
    const format = new Intl.DateTimeFormat('fr-CA', { timeZone, year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
    return `${format.format(new Date(event.start.dateTime))} → ${format.format(new Date(event.end.dateTime))}`;
  }
  async function load(query) {
    const current = ++generation;
    content('loading'); list.replaceChildren(); coverage.textContent = ''; zone.textContent = '';
    status.textContent = 'Lecture de l’agenda…';
    try {
      const response = await fetch('/api/personal-calendar/view?' + query, { cache: 'no-store', redirect: 'error' });
      const result = await response.json();
      if (current !== generation) return;
      if (!response.ok || !result.ok || !result.data?.read || result.data.snapshot?.status !== 'available') throw new Error();
      const { read, snapshot } = result.data;
      const { filters, events } = snapshot;
      form.elements.start.value = filters.start; form.elements.end.value = filters.end;
      zone.textContent = `Calendrier principal · ${filters.timeZone} · consulté le ${new Date(snapshot.observedAt).toLocaleString('fr-CA')}`;
      for (const event of events) {
        const row = node('li', '');
        row.append(node('h2', event.title + (event.titleTruncated ? '… (titre abrégé)' : '')),
          node('p', when(event, filters.timeZone)));
        if (event.location) row.append(node('p', event.location + (event.locationTruncated ? '… (lieu abrégé)' : '')));
        row.append(node('p', ({ confirmed: 'Confirmé', tentative: 'Provisoire', cancelled: 'Annulé' })[event.status] || 'État non précisé'));
        list.append(row);
      }
      coverage.textContent = snapshot.coverage.hasMore
        ? 'Vue partielle : 50 événements au maximum. Choisissez une période plus courte pour consulter la suite.'
        : `${events.length} événement(s) dans cette période.`;
      status.textContent = events.length ? 'Agenda affiché.' : 'Aucun événement dans cette période.';
      content('ready', { read, filters });
    } catch {
      if (current !== generation) return;
      content('unavailable'); list.replaceChildren();
      status.textContent = 'Agenda indisponible. Réessayez avec Afficher.';
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void load(new URLSearchParams({ start: form.elements.start.value, end: form.elements.end.value }));
  });
  const initial = new URLSearchParams(window.location.search);
  initial.delete('view'); initial.delete('from');
  void load(initial);
}());
