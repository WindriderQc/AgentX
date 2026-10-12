/* Nearby everyday destinations; the shared product navigation remains the catalogue. */
(function () {
  'use strict';
  const personal = [['/dad', 'Nestor'], ['/dad/day', 'My day'], ['/dad/memories', 'Memories'], ['/dad/family', 'Family tracking']];
  const family = [['/panel', 'Nestor Family'], ['/kids', 'Kids'], ['/lecture', 'Reading'], ['/kids/sounds', 'Sounds']];
  function mount(app, path) {
    const parent = path.startsWith('/dad');
    const destinations = parent ? personal : family;
    const nav = document.createElement('nav'); nav.className = 'household-wayfinding';
    nav.setAttribute('aria-label', parent ? 'Personal space' : 'Family space');
    for (const [href, label] of destinations) {
      const link = document.createElement('a'); link.href = href; link.textContent = label;
      if (path === href) link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
    app.prepend(nav);
  }
  window.HouseholdNavigation = { mount };
})();
