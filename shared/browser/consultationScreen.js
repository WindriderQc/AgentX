/* Fixed GET reads of existing domain projections. No native action client,
   inference, navigation, collector or automatic refresh is mounted here. */
(function (root) {
  'use strict';
  const page = document.body.dataset.screenPage;
  const status = document.getElementById('screen-status');
  const prefix = document.body.dataset.readPrefix;
  if (typeof prefix !== 'string' || prefix && (!prefix.startsWith('/') || prefix.startsWith('//') || /[?#\\]/.test(prefix))) return;
  const paths = page === 'profiler' ? { overview: `${prefix}/api/profiler/dashboard` }
    : page === 'cluster-schedule' ? { timeline: '/api/cluster/schedule/timeline', queue: '/api/cluster/schedule/heavy-queue' } : null;
  if (!paths) return;
  let version = 0;
  const text = value => typeof value === 'string' ? value.slice(0, 240) : 'Non renseigné';
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : 'Date non renseignée';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Non mesuré';
  function lines(key, values, total = values.length) {
    const host = document.querySelector(`[data-screen-content="${key}"]`);
    const list = document.createElement('ul');
    for (const value of values.slice(0, 40)) {
      const row = document.createElement('li'); row.textContent = value; list.append(row);
    }
    const coverage = document.createElement('p');
    coverage.textContent = values.length ? `${Math.min(values.length, 40)} / ${total} éléments affichés.` : 'Aucun élément dans cette lecture.';
    host.replaceChildren(coverage, list);
  }
  function profiler(data) {
    if (!Array.isArray(data.hosts) || !data.funnel || !Array.isArray(data.staleProfiles)) throw Error('Invalid profiler read');
    lines('hosts', data.hosts.map(host => `${text(host.displayName || host.hostId)} · baseline : ${date(host.baseline?.testedAt)}`));
    lines('models', [
      `Disponibles : ${count(data.funnel.available)} · profilés : ${count(data.funnel.profiled)} · comparés : ${count(data.funnel.benchmarked)}`,
      ...data.staleProfiles.map(model => `${text(model.modelName || model.model)} · profil périmé`)
    ]);
  }
  function timeline(data) {
    if (!Array.isArray(data.timeline)) throw Error('Invalid timeline read');
    lines('timeline', data.timeline.map(row => `${text(row.name)} · ${(row.slots || []).slice(0, 8).map(slot => `${date(slot.start)} → ${date(slot.end)}`).join(' ; ')}`));
    document.querySelector('[data-screen-content="timeline"]').prepend(document.createTextNode(`${text(data.date)} · ${text(data.timezone)}`));
  }
  function queue(data) {
    if (data.available !== true) throw Error('Unavailable queue');
    if (Array.isArray(data.jobs)) lines('queue', data.jobs.map(job => `${text(job.title)} · ${text(job.presentation?.label || job.state)} · ${date(job.reservation?.start)}`));
    else if (Array.isArray(data.running) && Array.isArray(data.waiting)) {
      lines('queue', [...data.running, ...data.waiting].map(job => `${text(job.job)} · ${text(job.timing)}`));
    } else throw Error('Invalid queue read');
    const note = document.createElement('p');
    note.textContent = `Source : ${text(data.authority)} · portée : ${text(data.scope)} · observation : ${date(data.observedAt)}.`
      + (data.authority === 'instance.QUEUE.md' ? ` Conseil de l’instance modifié le ${date(data.modifiedAt)} ; état natif non confirmé.` : ' Une réservation ne prouve pas un lancement.');
    document.querySelector('[data-screen-content="queue"]').prepend(note);
  }
  async function refresh() {
    const current = ++version;
    root.AgentXPresentedContent = { contract: 'agentx.presentation/v1', state: 'loading' };
    status.textContent = 'Lecture en cours…';
    document.querySelectorAll('[data-screen-content]').forEach(host => host.replaceChildren());
    const results = await Promise.allSettled(Object.entries(paths).map(async ([key, path]) => {
      const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (!response.ok || body.status !== 'success' || !body.data) throw Error('Unavailable read');
      return { key, data: body.data };
    }));
    if (current !== version) return;
    let unavailable = false;
    for (let index = 0; index < results.length; index++) {
      const result = results[index], key = Object.keys(paths)[index];
      try {
        if (result.status !== 'fulfilled') throw Error('Unavailable read');
        if (key === 'overview') profiler(result.value.data);
        else if (key === 'timeline') timeline(result.value.data);
        else queue(result.value.data);
      } catch {
        unavailable = true;
        const hosts = key === 'overview' ? ['hosts', 'models'] : [key];
        for (const name of hosts) {
          const host = document.querySelector(`[data-screen-content="${name}"]`);
          host.textContent = 'Lecture indisponible. Actualisez pour réessayer.';
        }
      }
    }
    root.AgentXPresentedContent = { contract: 'agentx.presentation/v1', state: unavailable ? 'unavailable' : 'ready' };
    status.dataset.state = unavailable ? 'unavailable' : 'ready';
    status.textContent = unavailable ? 'Lecture partielle ou indisponible.' : 'Lecture affichée. Les dates des sources restent distinctes de cette consultation.';
    root.dispatchEvent(new Event('agentx-screen-read'));
  }
  document.getElementById('screen-refresh').addEventListener('click', refresh);
  refresh();
})(window);
