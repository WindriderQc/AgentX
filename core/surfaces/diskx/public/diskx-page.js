/* DiskX page status: shows the <diskx-city> presentation receipts as text.
   Events are receipts of what the city drew, never of an action on files. */
(function () {
  'use strict';
  const status = document.getElementById('diskx-status');
  const city = document.querySelector('diskx-city');
  if (!status || !city) return;
  let readGeneration = 0;
  const content = (state, detail = {}) => {
    window.AgentXPresentedContent = { contract: 'agentx.presentation/v1', state, ...detail };
  };
  content('loading');
  const say = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); status.hidden = false; };

  async function readPresented(detail, group = null) {
    const generation = ++readGeneration;
    content('loading');
    try {
      const report = city.getAttribute('report') || detail?.reportGeneratedAt;
      if (!report) throw new Error('La version du rapport affiché est inconnue.');
      const query = new URLSearchParams({ report, ...(group ? { group } : {}) });
      const response = await fetch('/api/diskx/presentation?' + query, { cache: 'no-store', redirect: 'error' });
      const result = await response.json();
      if (generation !== readGeneration) return;
      if (!response.ok || !result.ok || !result.data?.read) throw new Error(result.message || 'Lecture du rapport indisponible.');
      content('ready', { read: result.data.read, filters: result.data.filters,
        selection: { group, outside: Number.isSafeInteger(detail?.outside) ? detail.outside : 0 } });
    } catch (error) {
      if (generation !== readGeneration) return;
      content('unavailable');
      say(String(error.message || 'Lecture du rapport indisponible.'), true);
    }
  }

  city.addEventListener('diskx-ready', () => { status.hidden = true; });
  city.addEventListener('diskx-report-read', event => { void readPresented(event.detail); });
  city.addEventListener('diskx-group-shown', (event) => {
    void readPresented(event.detail, event.detail?.sha256);
    const places = Number(event.detail?.places);
    say(Number.isFinite(places)
      ? `Groupe affiché : ${places} copie(s). Règle de conservation du rapport, pas une autorisation.`
      : 'Groupe affiché. Règle de conservation du rapport, pas une autorisation.');
  });
  city.addEventListener('diskx-error', (event) => {
    readGeneration++;
    content('unavailable');
    const stage = event.detail?.stage ? ` (${String(event.detail.stage).slice(0, 40)})` : '';
    say(`DiskX${stage} : ${String(event.detail?.message || 'erreur inconnue').slice(0, 300)}`, true);
  });
  // The module is relayed by Core; an unconfigured or unpublished module never defines the element.
  setTimeout(() => {
    if (!window.customElements?.get('diskx-city')) {
      readGeneration++; content('unavailable'); say('Le module DiskX n’est pas disponible sur cette instance.', true);
    }
  }, 15000);
}());
