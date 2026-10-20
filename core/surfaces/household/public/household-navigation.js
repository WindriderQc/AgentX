/* Nearby everyday destinations; the shared product navigation remains the catalogue. */
(function () {
  'use strict';
  const personal = [['/dad', 'Nestor'], ['/dad/day', 'My day'], ['/dad/memories', 'Memories'], ['/dad/history', 'Archives à revoir'], ['/dad/family', 'Family tracking'], ['/dad/family/plants', 'Plants']];
  const family = [['/panel', 'Nestor Family'], ['/kids', 'Kids'], ['/lecture', 'Reading'], ['/kids/sounds', 'Sounds'], ['/kids/plants', 'Ma jungle']];
  function mount(app, path) {
    const parent = path.startsWith('/dad');
    const destinations = parent ? personal : family;
    const nav = document.createElement('nav'); nav.className = 'household-wayfinding';
    nav.setAttribute('aria-label', parent ? 'Personal space' : 'Family space');
    const dayLabels = { 'My day': 'Ma journée', Memories: 'Souvenirs', 'Family tracking': 'Famille', Plants: 'Plantes' };
    if (path === '/dad/day') nav.setAttribute('aria-label', 'Mon espace personnel');
    for (const [href, label] of destinations) {
      const link = document.createElement('a'); link.href = href; link.textContent = path === '/dad/day' ? dayLabels[label] || label : label;
      if (path === href) link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
    app.prepend(nav);
  }
  window.HouseholdNavigation = { mount };
})();
