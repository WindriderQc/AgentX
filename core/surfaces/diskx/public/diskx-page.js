/* DiskX page status: shows the <diskx-city> presentation receipts as text.
   Events are receipts of what the city drew, never of an action on files. */
(function () {
  'use strict';
  const status = document.getElementById('diskx-status');
  const city = document.querySelector('diskx-city');
  if (!status || !city) return;
  const say = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); status.hidden = false; };

  city.addEventListener('diskx-ready', () => { status.hidden = true; });
  city.addEventListener('diskx-group-shown', (event) => {
    const places = Number(event.detail?.places);
    say(Number.isFinite(places)
      ? `Groupe affiché : ${places} copie(s). Règle de conservation du rapport, pas une autorisation.`
      : 'Groupe affiché. Règle de conservation du rapport, pas une autorisation.');
  });
  city.addEventListener('diskx-error', (event) => {
    const stage = event.detail?.stage ? ` (${String(event.detail.stage).slice(0, 40)})` : '';
    say(`DiskX${stage} : ${String(event.detail?.message || 'erreur inconnue').slice(0, 300)}`, true);
  });
  // The module is relayed by Core; an unconfigured or unpublished module never defines the element.
  setTimeout(() => {
    if (!window.customElements?.get('diskx-city')) say('Le module DiskX n’est pas disponible sur cette instance.', true);
  }, 15000);
}());
