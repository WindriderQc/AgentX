(() => {
  'use strict';
  const root = document.getElementById('operationsApp');
  if (!root) return;
  const $ = id => document.getElementById(id);
  const API = '/api/operations/jobs';
  const PENDING_KEY = 'agentx.operations.pending.v1';
  const icons = {'codex-usage': 'fa-chart-simple', 'memory-review-submit': 'fa-brain', 'offhost-backup': 'fa-box-archive', 'archive-mirror': 'fa-copy', 'bundle-delivery': 'fa-file-invoice'};
  const colors = {'codex-usage': '#83b3ff', 'memory-review-submit': '#baa3ff', 'offhost-backup': '#ffd180', 'archive-mirror': '#66e0c0', 'bundle-delivery': '#ffb3d3'};
  const categories = {'codex-usage': 'Activité', 'memory-review-submit': 'Mémoire', 'offhost-backup': 'Sauvegarde', 'archive-mirror': 'Archives', 'bundle-delivery': 'Livraison'};
  const labels = {accepted: 'Acceptée', running: 'En cours', completed: 'Réussie', failed: 'En erreur', cancelled: 'Annulée', unknown: 'À vérifier', 'waiting-host': 'Poste indisponible', never: 'À valider', attention: 'Intervention requise', paused: 'En pause', enabled: 'Activée', disabled: 'Désactivée'};
  const activeStates = new Set(['accepted', 'running', 'unknown', 'waiting-host']);
  const errors = {REVISION_CONFLICT: 'Les réglages ont changé. Actualisez puis recommencez.', JOB_ACTIVE: 'Une demande est déjà en cours pour ce traitement.',
    HOST_UNAVAILABLE: 'Le poste est indisponible. La demande est conservée pour son retour.', NATIVE_OUTCOME_UNKNOWN: 'La réponse du serveur est indisponible. La même demande reste enregistrée : actualisez pour vérifier son résultat.',
    INVALID_TIMEZONE: 'Ce fuseau horaire n’est pas reconnu.', INVALID_TIME: 'Choisissez une heure valide.', SOURCE_UNAVAILABLE: 'La source est indisponible. Aucun nouveau départ n’a été lancé.',
    WAITING_BACKUP: 'Une sauvegarde Core terminée est nécessaire avant la copie.', WAITING_SNAPSHOT: 'Un snapshot d’archives est nécessaire avant la copie.'};
  const state = {snapshot: null, tab: 'jobs', search: '', jobsFilter: 'all', inventoryFilter: 'all', historyOffset: 0, noticeKind: null, busy: new Set(), connected: false, lastLaunch: {}, pending: readPending(), loading: false};
  let poll = null;
  let editing = null;
  let editRevision = null;
  function readPending() {try {return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');} catch {return {};}}
  function savePending() {try {localStorage.setItem(PENDING_KEY, JSON.stringify(state.pending));} catch {}}
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const count = value => new Intl.NumberFormat('fr-CA').format(Number(value) || 0);
  function when(value, full = false) {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Aucun départ reçu';
    const options = {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'};
    if (full) options.year = 'numeric';
    return new Intl.DateTimeFormat('fr-CA', options).format(new Date(value));
  }
  function duration(ms) {if (ms == null) return '—'; if (ms < 1000) return '< 1 s'; if (ms < 60000) return `${Math.round(ms / 1000)} s`; return `${Math.round(ms / 60000)} min`;}
  function bytes(n) {if (!n) return '0 octet'; const units = ['o', 'Ko', 'Mo', 'Go', 'To']; const power = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return `${new Intl.NumberFormat('fr-CA', {maximumFractionDigits: 1}).format(n / 1024 ** power)} ${units[power]}`;}
  function badge(status) {
    const tone = ['completed', 'enabled'].includes(status) ? 'good' : ['running', 'accepted'].includes(status) ? 'live' : ['failed', 'attention'].includes(status) ? 'error' : ['unknown', 'waiting-host'].includes(status) ? 'warning' : 'neutral';
    return `<span class="oj-badge oj-badge-${tone}">${esc(labels[status] || status || '—')}</span>`;
  }
  function cadence(job) {
    if (job.schedule.type === 'daily') return `Chaque jour à ${job.schedule.at}`;
    const minutes = job.schedule.minutes;
    return minutes < 60 ? `Toutes les ${minutes} minutes` : minutes === 60 ? 'Toutes les heures' : `Toutes les ${minutes / 60} heures`;
  }
  function dependency(job) {
    if (job.gateType === 'core-backup') return 'Après une sauvegarde Core réussie';
    if (job.gateType === 'snapshot') return 'Après un nouveau snapshot';
    if (job.gateType === 'file') return 'Après une nouvelle publication';
    return cadence(job);
  }
  function resultText(run) {
    if (!run) return 'La première exécution reste à valider.';
    if (run.state === 'unknown') return 'Résultat non confirmé. La demande reste protégée contre un second départ.';
    if (run.state === 'waiting-host') return 'Le poste est indisponible. Reprise de la même demande à son retour.';
    if (run.state === 'failed') return `Dernière exécution en erreur${run.exitCode != null ? ` · code ${run.exitCode}` : ''}.`;
    if (['running', 'accepted'].includes(run.state)) return 'La demande est reçue. Le résultat sera ajouté à l’historique.';
    const metrics = run.metrics || {};
    const parts = [];
    if ('files' in metrics) parts.push(`${count(metrics.files)} fichier${metrics.files === 1 ? '' : 's'}`);
    if ('bytes' in metrics) parts.push(bytes(metrics.bytes));
    if ('accepted' in metrics) parts.push(`${count(metrics.accepted)} élément${metrics.accepted === 1 ? '' : 's'} accepté${metrics.accepted === 1 ? '' : 's'}`);
    if (metrics.verified) parts.push('empreintes vérifiées');
    if (!parts.length) parts.push('Exécution terminée');
    return parts.join(' · ');
  }
  function notice(message, success = false, kind = 'action') {
    state.noticeKind = message ? kind : null;
    const el = $('operationsNotice');
    el.textContent = message;
    el.hidden = !message;
    el.classList.toggle('oj-success', success);
  }
  async function api(path = '', options = {}) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(API + path, {headers: {'Content-Type': 'application/json'}, ...options, signal: controller.signal});
      const body = await response.json();
      if (!response.ok || body.status !== 'success') {
        const error = new Error(errors[body.error?.code] || 'Le traitement n’a pas pu être confirmé. Actualisez son état.');
        error.code = body.error?.code;
        error.status = response.status;
        throw error;
      }
      return body.data;
    } finally {clearTimeout(deadline);}
  }
  async function load(refresh = false) {
    if (state.loading) return;
    state.loading = true;
    $('operationsRefresh').disabled = true;
    try {
      state.snapshot = await api(`?offset=${state.historyOffset}${refresh ? '&refresh=1' : ''}`);
      state.connected = state.snapshot.available;
      for (const [id, requestId] of Object.entries(state.pending)) {
        if (state.snapshot.jobs.some(job => job.id === id && job.lastRun?.requestId === requestId) || state.snapshot.history.some(run => run.requestId === requestId)) delete state.pending[id];
      }
      savePending();
      render();
    } catch {
      state.connected = false;
      $('operationsConnection').innerHTML = badge('unknown');
      $('operationsSupervisor').textContent = 'Connexion au superviseur indisponible';
      $('operationsHeartbeat').textContent = 'Les dernières données restent visibles. Les actions attendent le retour de la connexion.';
      notice('Le serveur ne répond pas. Les traitements système continuent sous leur superviseur ; leur résultat reste à confirmer.', false, 'connection');
      if (!state.snapshot) $('operationsJobs').innerHTML = empty('Lecture indisponible', 'Actualisez lorsque le serveur revient. Aucun résultat n’est supposé réussi.', 'fa-plug-circle-xmark');
      renderJobs();
    } finally {
      state.loading = false;
      $('operationsRefresh').disabled = false;
      clearTimeout(poll);
      if (!document.hidden) poll = setTimeout(() => load(), 15000);
    }
  }
  function empty(title, message, icon = 'fa-inbox') {return `<div class="oj-empty"><i class="fas ${esc(icon)}" aria-hidden="true"></i><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;}
  function isAttention(job) {return ['failed', 'unknown', 'attention', 'waiting-host'].includes(job.state) || (job.enabled && job.source.code === 'SOURCE_UNAVAILABLE');}
  function render() {
    const snapshot = state.snapshot;
    if (!snapshot.available) {
      $('operationsSupervisor').textContent = 'Superviseur à configurer';
      $('operationsHeartbeat').textContent = 'Aucun traitement n’est configuré pour cette instance.';
      $('operationsConnection').innerHTML = badge('never');
      $('operationsJobs').innerHTML = empty('Le serveur attend sa configuration', 'L’opérateur peut raccorder les collecteurs et les copies nécessaires à cette instance.', 'fa-server');
      $('operationsJobs').setAttribute('aria-busy', 'false');
      return;
    }
    if (state.noticeKind === 'connection' || (state.noticeKind === 'inventory' && !snapshot.inventory.unavailable.length)) notice('');
    const jobs = snapshot.jobs;
    const legacy = snapshot.inventory.rows.filter(row => row.category === 'migrated' && row.enabled).length;
    const stamp = snapshot.supervisor.lastTickAt;
    const fresh = stamp && Date.now() - Date.parse(stamp) < 180000;
    $('operationsSupervisor').textContent = `Piloté par ${snapshot.supervisor.label}`;
    $('operationsHeartbeat').textContent = stamp ? `Dernier passage ${when(stamp)} · horaires du serveur, données sur leur machine` : 'Le premier passage du superviseur reste à recevoir.';
    $('operationsConnection').innerHTML = `<span class="oj-badge oj-badge-${fresh ? 'good' : 'warning'}"><i class="fas fa-circle" aria-hidden="true"></i> ${fresh ? 'À jour' : 'À vérifier'}</span>`;
    $('metricActive').textContent = count(jobs.filter(job => job.enabled).length);
    $('metricRunning').textContent = count(jobs.filter(job => ['accepted', 'running'].includes(job.state)).length);
    $('metricAttention').textContent = count(jobs.filter(isAttention).length);
    $('metricAttention').parentElement.classList.toggle('oj-needs-attention', jobs.some(isAttention));
    $('metricLegacy').textContent = snapshot.inventory.observedAt ? count(legacy) : '—';
    $('metricLegacy').parentElement.classList.toggle('oj-needs-attention', legacy > 0);
    $('jobsCount').textContent = count(jobs.length);
    $('historyCount').textContent = count(snapshot.historyTotal);
    $('inventoryCount').textContent = snapshot.inventory.observedAt ? count(snapshot.inventory.rows.length) : '—';
    if (snapshot.inventory.unavailable.length) notice('L’inventaire Windows est ancien : le poste est indisponible. Les derniers résultats reçus restent affichés.', false, 'inventory');
    renderJobs(); renderHistory(); renderInventory();
  }
  function renderJobs() {
    if (!state.snapshot?.available) return;
    const prior = document.activeElement;
    const focusAction = prior?.dataset.action;
    const focusJob = prior?.dataset.job;
    const query = state.search.toLocaleLowerCase();
    const jobs = state.snapshot.jobs.filter(job => (!query || `${job.name} ${job.description} ${job.hostLabel}`.toLocaleLowerCase().includes(query)) &&
      (state.jobsFilter === 'all' || (state.jobsFilter === 'active' && job.enabled) || (state.jobsFilter === 'paused' && !job.enabled) || (state.jobsFilter === 'attention' && isAttention(job))));
    $('operationsJobs').innerHTML = jobs.length ? jobs.map(job => {
      const busy = state.busy.has(job.id) || activeStates.has(job.state);
      const disabled = !state.connected || state.busy.has(job.id);
      const nextLabel = job.gateType ? 'PROCHAINE VÉRIFICATION' : 'PROCHAIN DÉPART';
      const next = job.enabled ? when(job.nextRunAt) : 'Départs automatiques en pause';
      const run = job.lastRun;
      return `<article class="oj-job" style="--job-color:${colors[job.kind] || '#83b3ff'}">
        <div class="oj-job-top"><div class="oj-job-identity"><div class="oj-job-icon"><i class="fas ${icons[job.kind] || 'fa-gears'}" aria-hidden="true"></i></div><div><h3>${esc(job.name)}</h3><span class="oj-kind">${esc(categories[job.kind] || 'Traitement')}</span></div></div>${badge(!job.enabled && !activeStates.has(job.state) ? 'paused' : job.state)}</div>
        <p class="oj-job-description">${esc(job.description)}</p>
        <div class="oj-route"><span class="oj-route-node"><i class="fas fa-server" aria-hidden="true"></i>${esc(job.supervisorLabel)}</span><i class="fas fa-arrow-right oj-route-arrow" aria-label="déclenche sur"></i><span class="oj-route-node"><i class="fas fa-desktop" aria-hidden="true"></i>${esc(job.hostLabel)}</span></div>
        <div class="oj-job-details"><div><span class="oj-detail-label">DÉCLENCHEMENT</span><strong class="oj-detail-value">${esc(dependency(job))}</strong><span class="oj-detail-caption">${esc(job.gateType ? `Vérification : ${cadence(job).toLocaleLowerCase()}` : job.schedule.timezone)}</span></div><div><span class="oj-detail-label">${nextLabel}</span><strong class="oj-detail-value">${esc(next)}</strong><span class="oj-detail-caption">${esc(run ? `Dernier départ : ${when(run.startedAt || run.createdAt)}` : 'Première exécution à valider')}</span></div></div>
        <p class="oj-result${run?.state === 'failed' ? ' oj-result-error' : ''}"><i class="fas ${run?.state === 'failed' ? 'fa-circle-exclamation' : 'fa-check-circle'}" aria-hidden="true"></i><span>${esc(resultText(run))}</span></p>
        <div class="oj-job-actions"><button class="oj-button oj-button-primary" data-action="run" data-job="${job.id}" ${disabled || busy ? 'disabled' : ''}><i class="fas fa-play" aria-hidden="true"></i>${state.pending[job.id] ? 'Vérifier ma demande' : 'Exécuter'}</button>
        <button class="oj-button oj-button-quiet" data-action="toggle" data-job="${job.id}" ${disabled ? 'disabled' : ''}><i class="fas ${job.enabled ? 'fa-pause' : 'fa-play'}" aria-hidden="true"></i>${job.enabled ? 'Pause' : 'Reprendre'}</button>
        ${job.state === 'unknown' && run ? `<button class="oj-button oj-button-quiet" data-action="reconcile" data-job="${job.id}" ${disabled ? 'disabled' : ''}>Vérifier</button>` : ''}
        <button class="oj-button oj-button-quiet oj-settings-button" data-action="settings" data-job="${job.id}" aria-label="Régler la fréquence de ${esc(job.name)}" ${disabled ? 'disabled' : ''}><i class="fas fa-sliders" aria-hidden="true"></i></button></div></article>`;
    }).join('') : empty('Aucun traitement dans cette vue', 'Essayez un autre filtre ou une autre recherche.');
    $('operationsJobs').setAttribute('aria-busy', 'false');
    if (focusAction && focusJob) $('operationsJobs').querySelector(`[data-action="${focusAction}"][data-job="${focusJob}"]`)?.focus({preventScroll: true});
  }
  function renderHistory() {
    const snapshot = state.snapshot;
    if (!snapshot?.available) return;
    const names = Object.fromEntries(snapshot.jobs.map(job => [job.id, job.name]));
    const query = state.search.toLocaleLowerCase();
    const history = snapshot.history.filter(run => !query || (names[run.jobId] || run.jobId).toLocaleLowerCase().includes(query));
    $('operationsHistory').innerHTML = history.length ? history.map(run => `<tr><td><span class="oj-table-name">${esc(names[run.jobId] || run.jobId)}</span></td><td>${badge(run.state)}</td><td>${run.trigger === 'scheduled' ? 'Automatique' : 'Manuel'}</td><td>${esc(when(run.startedAt || run.createdAt, true))}</td><td>${esc(duration(run.durationMs))}</td><td>${esc(resultText(run))}</td></tr>`).join('') : '<tr><td colspan="6" class="oj-table-empty">Aucune exécution reçue dans cette vue.</td></tr>';
    $('historyPageLabel').textContent = snapshot.historyTotal ? `${count(state.historyOffset + 1)}–${count(Math.min(state.historyOffset + 50, snapshot.historyTotal))} sur ${count(snapshot.historyTotal)}` : 'Aucune exécution';
    $('historyPrevious').disabled = state.historyOffset === 0 || !state.connected;
    $('historyNext').disabled = state.historyOffset + 50 >= snapshot.historyTotal || !state.connected;
  }
  function inventoryCadence(row) {
    return row.triggers.map(trigger => {
      if (trigger.interval) return ({PT5M: 'Toutes les 5 min', PT15M: 'Toutes les 15 min', PT1H: 'Toutes les heures', P1D: 'Chaque jour'})[trigger.interval] || trigger.interval;
      if (trigger.type === 'MSFT_TaskLogonTrigger') return 'À la connexion';
      if (trigger.type === 'MSFT_TaskBootTrigger') return 'Au démarrage';
      if (trigger.type === 'MSFT_TaskDailyTrigger') return `Chaque jour${trigger.start ? ` · ${trigger.start.slice(11, 16)}` : ''}`;
      if (trigger.type === 'MSFT_TaskWeeklyTrigger') return 'Chaque semaine';
      if (trigger.type === 'MSFT_TaskEventTrigger') return 'Sur événement';
      return 'À la demande';
    }).join(' · ') || 'À la demande';
  }
  function assessment(row) {
    return ({'server-managed': 'Pilotée par le serveur', 'disable-legacy-schedule': 'Ancien horaire encore actif', 'missing-executable': 'Exécutable absent', retired: 'Ancienne tâche', reserve: 'Réserve', review: 'Rôle à confirmer', 'provider-managed': 'Gérée par son logiciel'})[row.assessment] || 'À examiner';
  }
  function renderInventory() {
    const inventory = state.snapshot?.inventory;
    if (!inventory) return;
    const query = state.search.toLocaleLowerCase();
    const rows = inventory.rows.filter(row => (!query || `${row.name} ${row.hostLabel}`.toLocaleLowerCase().includes(query)) &&
      (state.inventoryFilter === 'all' || row.category === state.inventoryFilter || (state.inventoryFilter === 'review' && ['missing-executable', 'disable-legacy-schedule', 'review'].includes(row.assessment))));
    $('inventoryAge').textContent = inventory.observedAt ? `${count(rows.length)} tâches affichées · relevé ${when(inventory.observedAt)}${inventory.unavailable.length ? ' · poste actuellement indisponible' : ''}` : 'Le premier inventaire du poste reste à recevoir.';
    $('operationsInventory').innerHTML = rows.length ? rows.map(row => `<tr><td><span class="oj-table-name">${esc(row.name)}</span><span class="oj-table-subtitle">${esc(row.hostLabel)}</span></td><td>${badge(row.enabled ? 'enabled' : 'disabled')}</td><td>${esc(inventoryCadence(row))}</td><td>${row.lastResult == null ? '—' : row.lastResult === 267011 ? 'Jamais exécutée' : esc(row.lastResult)}</td><td>${esc(assessment(row))}</td></tr>`).join('') : '<tr><td colspan="5" class="oj-table-empty">Aucune tâche dans cette vue.</td></tr>';
  }
  function setTab(name, focus = false) {
    state.tab = name;
    for (const tab of root.querySelectorAll('[data-tab]')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; tab.classList.toggle('active', selected);
      $(tab.getAttribute('aria-controls')).hidden = !selected;
      if (focus && selected) tab.focus();
    }
  }
  function openSettings(job) {
    editing = job.id; editRevision = state.snapshot.revision;
    const form = $('operationsSettingsForm');
    $('settingsTitle').textContent = job.name;
    form.elements.type.value = job.schedule.type;
    form.elements.minutes.value = String(job.schedule.minutes || 60);
    if (!form.elements.minutes.value) {
      const option = document.createElement('option'); option.value = String(job.schedule.minutes); option.textContent = `${job.schedule.minutes} minutes`; form.elements.minutes.add(option); form.elements.minutes.value = option.value;
    }
    form.elements.at.value = job.schedule.at || '03:45';
    form.elements.timezone.value = job.schedule.timezone;
    $('settingsDependency').textContent = job.gateType ? `${dependency(job)}. La fréquence règle la vérification de la source ; la dépendance reste requise.` : 'Choisissez le rythme adapté à la fraîcheur des données dont vous avez besoin.';
    $('settingsError').textContent = ''; settingsType(); $('operationsSettings').showModal();
  }
  function settingsType() {const daily = $('operationsSettingsForm').elements.type.value === 'daily'; $('settingsInterval').hidden = daily; $('settingsDaily').hidden = !daily;}
  async function act(action, identifier) {
    const job = state.snapshot.jobs.find(item => item.id === identifier);
    if (!job || !state.connected) return;
    if (action === 'settings') {openSettings(job); return;}
    if (action === 'run') {
      if (state.lastLaunch[identifier] && Date.now() - state.lastLaunch[identifier] < 1500) return;
      state.lastLaunch[identifier] = Date.now();
    }
    state.busy.add(identifier); renderJobs();
    try {
      if (action === 'run') {
        const requestId = state.pending[identifier] || crypto.randomUUID();
        state.pending[identifier] = requestId; savePending();
        await api(`/${identifier}/run`, {method: 'POST', body: JSON.stringify({requestId, revision: state.snapshot.revision})});
        delete state.pending[identifier]; savePending();
        notice('Demande reçue. Son résultat apparaîtra dans l’historique.', true);
      } else if (action === 'toggle') {
        await api(`/${identifier}`, {method: 'PATCH', body: JSON.stringify({revision: state.snapshot.revision, enabled: !job.enabled})});
        notice(job.enabled ? 'Les prochains départs sont en pause. Une exécution déjà acceptée conserve son suivi.' : 'Les départs automatiques reprennent.', true);
      } else if (action === 'reconcile') {
        const result = await api(`/runs/${job.lastRun.requestId}/reconcile`, {method: 'POST'});
        notice(result.state === 'unknown' ? 'Le résultat reste non confirmé. Aucun second départ n’a été lancé.' : 'Le reçu natif a été vérifié.', result.state !== 'unknown');
      }
    } catch (error) {
      if (action === 'run' && [400, 404, 409].includes(error.status) && error.code !== 'NATIVE_OUTCOME_UNKNOWN') {delete state.pending[identifier]; savePending();}
      notice(error.message || errors.NATIVE_OUTCOME_UNKNOWN);
    } finally {state.busy.delete(identifier); await load(true); renderJobs();}
  }
  root.addEventListener('click', event => {const button = event.target.closest('[data-action]'); if (button && !button.disabled) act(button.dataset.action, button.dataset.job);});
  root.querySelectorAll('[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
    tab.addEventListener('keydown', event => {
      const names = ['jobs', 'history', 'inventory']; const index = names.indexOf(state.tab);
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {event.preventDefault(); setTab(event.key === 'Home' ? names[0] : event.key === 'End' ? names[2] : names[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3], true);}
    });
  });
  $('operationsSearch').addEventListener('input', event => {state.search = event.target.value; renderJobs(); renderHistory(); renderInventory();});
  $('jobsFilter').addEventListener('change', event => {state.jobsFilter = event.target.value; renderJobs();});
  $('inventoryFilter').addEventListener('change', event => {state.inventoryFilter = event.target.value; renderInventory();});
  $('operationsRefresh').addEventListener('click', () => load(true));
  $('historyPrevious').addEventListener('click', () => {state.historyOffset = Math.max(0, state.historyOffset - 50); load(true);});
  $('historyNext').addEventListener('click', () => {state.historyOffset += 50; load(true);});
  ['settingsClose', 'settingsCancel'].forEach(id => $(id).addEventListener('click', () => $('operationsSettings').close()));
  $('operationsSettingsForm').elements.type.addEventListener('change', settingsType);
  $('operationsSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const schedule = {type: form.elements.type.value, timezone: form.elements.timezone.value.trim()};
    if (schedule.type === 'daily') schedule.at = form.elements.at.value; else schedule.minutes = Number(form.elements.minutes.value);
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      await api(`/${editing}`, {method: 'PATCH', body: JSON.stringify({revision: editRevision, schedule})});
      $('operationsSettings').close(); notice('Fréquence enregistrée pour les prochains départs.', true); await load(true);
    } catch (error) {$('settingsError').textContent = error.message || 'La fréquence n’a pas pu être enregistrée.';}
    finally {submit.disabled = false;}
  });
  document.addEventListener('visibilitychange', () => {clearTimeout(poll); if (!document.hidden) load(true);});
  load();
})();
