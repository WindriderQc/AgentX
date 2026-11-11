/* Super Dad: small live frames beside Nestor's full-screen face. Each frame reads one existing
   Core view and opens the page that owns it: model activity and GPU power (Nerve Center live
   activity) and the heavy-work queue (Automations). A failed or old read says so; nothing is
   guessed. Only the full-screen "plein" view shows them, never over photos, and they read
   nothing while hidden or folded. */
(function (root) {
  'use strict';
  const ACTIVITY_URL = '/api/nerve-center/live-activity?minutes=15';
  const QUEUE_URL = '/api/cluster/schedule/heavy-queue';
  const ACTIVITY_MS = 30 * 1000;
  const QUEUE_MS = 2 * 60 * 1000;
  const CHECK_MS = 5000;
  const STALE_MS = 3 * 60 * 1000;
  const FOLDED_KEY = 'household.nestor.frames.folded';
  const MINUTE = 60 * 1000;

  const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

  // Requests per minute over the window (missing minutes are zero), what runs now, and
  // how many requests heavy work holds.
  function activityView(data, now = Date.now()) {
    const recent = data?.recent?.ok ? data.recent.data : null;
    const requests = data?.requests?.ok ? data.requests.data : null;
    if (!recent && !requests) return null;
    let series = null, total = null, failed = null;
    if (recent) {
      const minutes = Math.max(1, Math.min(60, finite(recent.windowMinutes) || 15));
      const end = Math.floor((Date.parse(data.sampledAt) || now) / MINUTE) * MINUTE;
      const counts = new Map((recent.perMinute || []).map(row => [Math.floor(Date.parse(row.t) / MINUTE) * MINUTE, row]));
      series = Array.from({ length: minutes }, (_, index) => finite(counts.get(end - (minutes - 1 - index) * MINUTE)?.n) || 0);
      total = finite(recent.total) ?? series.reduce((sum, n) => sum + n, 0);
      failed = (recent.perMinute || []).reduce((sum, row) => sum + (finite(row.failed) || 0), 0);
    }
    return { series, total, failed, minutes: series?.length || null,
      active: Array.isArray(requests?.active) ? requests.active.length : null,
      heavy: finite(requests?.heavyWorkInFlight) };
  }

  // Each GPU's last power sample against its limit; an old sample is marked, not shown as now.
  function gpuView(data, now = Date.now()) {
    const hosts = data?.power?.ok ? data.power.data?.hosts : null;
    if (!hosts || typeof hosts !== 'object') return null;
    const rows = [];
    for (const [host, value] of Object.entries(hosts)) {
      const gpus = Object.entries(value?.gpus || {});
      for (const [index, samples] of gpus) {
        const last = Array.isArray(samples) ? samples[samples.length - 1] : null;
        const watts = finite(last?.w), limit = finite(last?.limit);
        const at = Date.parse(last?.t);
        rows.push({ id: host + ':' + index, label: gpus.length > 1 ? `${host} · ${index}` : host, watts, limit,
          share: watts !== null && limit ? Math.max(0, Math.min(1, watts / limit)) : null,
          stale: !Number.isFinite(at) || now - at > STALE_MS });
      }
    }
    return rows;
  }

  // The queue's own summary counts; never re-derived from the job list.
  function queueView(data) {
    if (!data?.available || !data.summary?.counts) return null;
    const counts = data.summary.counts, n = key => finite(counts[key]) || 0;
    return { running: n('running') + n('dispatching'), waiting: n('automatic_queue'), decide: n('action_required'), uncertain: n('uncertain') };
  }

  function readFolded() { try { return root.localStorage?.getItem(FOLDED_KEY) === '1'; } catch { return false; } }
  function saveFolded(value) { try { root.localStorage?.setItem(FOLDED_KEY, value ? '1' : '0'); } catch { /* per-device convenience */ } }

  function mount({ space = 'personal', documentRef = root.document, now = () => Date.now(), fetchImpl = root.fetch?.bind(root) } = {}) {
    const doc = documentRef;
    if (space === 'family' || !doc?.body) return null;
    const host = doc.createElement('aside');
    host.className = 'nestor-frames';
    host.setAttribute('aria-label', 'Cadres en direct');
    host.innerHTML = `<button type="button" class="nestor-frames-toggle" aria-expanded="true" aria-controls="nestorFramesList">Cadres</button>
      <div class="nestor-frames-list" id="nestorFramesList">
        <a class="nestor-frame" data-frame="activity" href="/nerve-center" title="Ouvrir Nerve Center">
          <h2>Activité des modèles</h2><p class="nestor-frame-big"></p><svg class="nestor-frame-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline/></svg><p class="nestor-frame-note"></p></a>
        <a class="nestor-frame" data-frame="gpu" href="/nerve-center" title="Ouvrir Nerve Center">
          <h2>Puissance GPU</h2><ul class="nestor-frame-bars"></ul><p class="nestor-frame-note"></p></a>
        <a class="nestor-frame" data-frame="queue" href="/automations?view=calendar" title="Ouvrir la file des travaux lourds">
          <h2>Travaux lourds</h2><p class="nestor-frame-big"></p><p class="nestor-frame-note"></p></a>
      </div>`;
    doc.body.append(host);
    const toggle = host.querySelector('.nestor-frames-toggle');
    const frame = name => host.querySelector(`[data-frame=${name}]`);
    let folded = readFolded(), disposed = false, lastActivity = 0, lastQueue = 0, busy = false;

    const setFolded = value => {
      folded = value; host.dataset.folded = String(value); toggle.setAttribute('aria-expanded', String(!value));
      toggle.textContent = value ? 'Cadres ›' : 'Cadres';
      saveFolded(value);
    };
    setFolded(folded);
    toggle.addEventListener('click', () => { setFolded(!folded); check(); });

    // The stylesheet decides where frames fit (plein view, wide screen, no photo).
    const shown = () => !doc.hidden && !folded && doc.body.dataset.avatarView === 'plein'
      && root.getComputedStyle?.(host).display !== 'none';
    const read = async url => {
      const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || !body?.data) throw new Error('unavailable');
      return body.data;
    };
    const set = (name, selector, value) => { frame(name).querySelector(selector).textContent = value; };

    function renderActivity(view) {
      const spark = frame('activity').querySelector('polyline');
      if (!view) {
        set('activity', '.nestor-frame-big', '—'); set('activity', '.nestor-frame-note', 'Lecture indisponible');
        spark.setAttribute('points', ''); frame('activity').dataset.state = 'unavailable'; return;
      }
      delete frame('activity').dataset.state;
      set('activity', '.nestor-frame-big', view.total === null ? '—' : `${view.total} requêtes · ${view.minutes} min`);
      const max = Math.max(1, ...(view.series || [0]));
      const step = view.series && view.series.length > 1 ? 100 / (view.series.length - 1) : 100;
      spark.setAttribute('points', (view.series || []).map((n, i) => `${(i * step).toFixed(1)},${(26 - (n / max) * 24).toFixed(1)}`).join(' '));
      set('activity', '.nestor-frame-note', [view.active === null ? null : `${view.active} en cours`,
        view.heavy ? `${view.heavy} pour un travail lourd` : null, view.failed ? `${view.failed} en échec` : null].filter(Boolean).join(' · ') || 'Calme');
    }
    function renderGpu(rows) {
      const list = frame('gpu').querySelector('.nestor-frame-bars');
      if (!rows?.length) { list.replaceChildren(); set('gpu', '.nestor-frame-note', 'Lecture indisponible'); frame('gpu').dataset.state = 'unavailable'; return; }
      delete frame('gpu').dataset.state;
      list.replaceChildren(...rows.map(row => {
        const item = doc.createElement('li');
        if (row.stale) item.dataset.stale = 'true';
        const name = doc.createElement('span'); name.textContent = row.label;
        const bar = doc.createElement('i'); bar.style.setProperty('--share', String(row.share ?? 0));
        const value = doc.createElement('span'); value.textContent = row.stale ? 'ancien' : row.watts === null ? '—' : Math.round(row.watts) + ' W';
        item.append(name, bar, value);
        return item;
      }));
      set('gpu', '.nestor-frame-note', rows.some(row => row.stale) ? 'Certaines mesures datent de plus de 3 min' : '');
    }
    function renderQueue(view) {
      if (!view) { set('queue', '.nestor-frame-big', '—'); set('queue', '.nestor-frame-note', 'Lecture indisponible'); frame('queue').dataset.state = 'unavailable'; return; }
      delete frame('queue').dataset.state;
      set('queue', '.nestor-frame-big', view.running ? `${view.running} en cours` : 'Rien en cours');
      set('queue', '.nestor-frame-note', [view.waiting ? `${view.waiting} en file` : null, view.decide ? `${view.decide} à décider` : null,
        view.uncertain ? `${view.uncertain} à vérifier` : null].filter(Boolean).join(' · ') || 'File vide');
      frame('queue').dataset.attention = String(view.decide + view.uncertain > 0);
    }

    async function check() {
      if (disposed || busy || !fetchImpl || !shown()) return;
      busy = true;
      const at = now();
      try {
        const jobs = [];
        if (at - lastActivity >= ACTIVITY_MS) {
          lastActivity = at;
          jobs.push(read(ACTIVITY_URL).then(data => { renderActivity(activityView(data, now())); renderGpu(gpuView(data, now())); },
            () => { renderActivity(null); renderGpu(null); }));
        }
        if (at - lastQueue >= QUEUE_MS) {
          lastQueue = at;
          jobs.push(read(QUEUE_URL).then(data => renderQueue(queueView(data)), () => renderQueue(null)));
        }
        await Promise.all(jobs);
      } finally { busy = false; }
    }
    const timer = root.setInterval(check, CHECK_MS);
    const onVisibility = () => { if (!doc.hidden) check(); };
    doc.addEventListener('visibilitychange', onVisibility);
    check();
    return {
      check,
      dispose() {
        disposed = true; root.clearInterval(timer);
        doc.removeEventListener('visibilitychange', onVisibility);
        host.remove();
      }
    };
  }

  const api = { mount, activityView, gpuView, queueView };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NestorFrames = api;
})(typeof window === 'undefined' ? globalThis : window);
