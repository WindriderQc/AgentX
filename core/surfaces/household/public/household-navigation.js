/* Nearby everyday destinations; the shared product navigation remains the catalogue. */
(function () {
  'use strict';
  const personal = [['/dad', 'Nestor'], ['/dad/day', 'Ma journée'], ['/dad/memories', 'Souvenirs'], ['/dad/family', 'Suivi familial']];
  const family = [['/panel', 'Nestor Famille'], ['/kids', 'Enfants'], ['/lecture', 'Lecture'], ['/kids/sounds', 'Sons']];
  function mount(app, path) {
    const parent = path.startsWith('/dad');
    const destinations = parent ? personal : family;
    const nav = document.createElement('nav'); nav.className = 'household-wayfinding';
    nav.setAttribute('aria-label', parent ? 'Espace personnel' : 'Espace famille');
    for (const [href, label] of destinations) {
      const link = document.createElement('a'); link.href = href; link.textContent = label;
      if (path === href) link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
    app.prepend(nav);
  }
  window.HouseholdNavigation = { mount };
})();
