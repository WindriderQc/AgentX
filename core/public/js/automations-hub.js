(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('operationsApp')) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const localDate = date => new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
  const when = value => value ? new Intl.DateTimeFormat('fr-CA', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone}).format(new Date(value)) : 'Non communiqué';
  const clock = value => new Intl.DateTimeFormat('fr-CA', {hour: '2-digit', minute: '2-digit', timeZone: timezone}).format(new Date(value));
  const kinds = {command: ['fa-terminal', 'Commande'], agent: ['fa-user-gear', 'Agent'], 'native-core': ['fa-gears', 'Fonction native'], backup: ['fa-box-archive', 'Sauvegarde'], archive: ['fa-clock-rotate-left', 'Archive']};
  const states = {completed: ['good', 'Réussie'], failed: ['error', 'En erreur'], running: ['live', 'En cours'], unknown: ['warning', 'À vérifier'], attention: ['error', 'À surveiller'], paused: ['neutral', 'En pause'], archived: ['neutral', 'Archivée'], never: ['neutral', 'À valider'], skipped: ['neutral', 'Ignorée'], cancelled: ['neutral', 'Annulée']};
  let snapshot = null, search = '', calendarData = null, loading = false, requestedDate = null;
  const expanded = new Set();
  let compact = true;
  try {compact = localStorage.getItem('agentx.automations.density') !== 'detailed';} catch {}
  const badge = state => {const [tone, label] = states[state] || states.unknown; return `<span class="oj-badge oj-badge-${tone}">${label}</span>`;};
  function cadence(job) {
    const schedule = job.schedule || {};
    if (schedule.type === 'once') return `Une fois · ${when(schedule.at)}`;
    if (schedule.type === 'daily') return `Chaque jour à ${schedule.at}`;
    if (schedule.type === 'interval') return schedule.minutes < 60 ? `Toutes les ${schedule.minutes} minutes` : `Toutes les ${schedule.minutes / 60} heures`;
    const parts = (schedule.cron || '').split(' ');
    if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*') {
      const time = `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
      if (parts[4] === '*') return `Chaque jour à ${time}`;
      if (parts[4] === '1-5') return `En semaine à ${time}`;
      const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
      if (days[parts[4]]) return `Chaque ${days[parts[4]]} à ${time}`;
    }
    return schedule.cron ? `Cron · ${schedule.cron}` : 'Horaire natif';
  }
  function card(job) {
    const [icon, kind] = kinds[job.kind] || kinds.agent;
    const last = job.lastRun;
    const available = snapshot?.sources.find(source => source.id === job.owner)?.available;
    const ownerAction = job.archived ? '<span class="oj-subtle">Référence conservée · aucun départ</span>' : available
      ? `<a class="oj-button oj-button-quiet" href="${esc(job.controlUrl)}${job.agentId && job.owner === 'openclaw' ? `?agent=${encodeURIComponent(job.agentId)}` : ''}" ${job.owner === 'openclaw' ? 'target="_blank" rel="noopener noreferrer"' : ''}>Gérer dans ${esc(job.ownerLabel)} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`
      : '<span class="oj-badge oj-badge-warning">Propriétaire indisponible</span>';
    return `<article class="oj-job oj-native-job" data-job-id="${esc(job.id)}" style="--job-color:${job.owner === 'core' ? '#ffd180' : '#baa3ff'}">
      <div class="oj-job-top"><div class="oj-job-identity"><div class="oj-job-icon"><i class="fas ${icon}" aria-hidden="true"></i></div><div><h3>${esc(job.name)}</h3><span class="oj-kind">${esc(job.ownerLabel)} · ${kind}</span></div></div>${badge(job.state)}</div>
      <p class="oj-job-description">${esc(job.description || (job.kind === 'native-core' ? 'Traitement interne du runtime OpenClaw.' : 'Planification et exécution conservées dans le runtime natif.'))}</p>
      <div class="oj-route"><span class="oj-route-node"><i class="fas fa-gears" aria-hidden="true"></i>${esc(job.ownerLabel)}</span>${job.agentId ? `<i class="fas fa-arrow-right oj-route-arrow" aria-hidden="true"></i><span class="oj-route-node">${esc(job.agentId)}</span>` : ''}</div>
      <div class="oj-job-details"><div><span class="oj-detail-label">DÉCLENCHEMENT</span><strong class="oj-detail-value">${esc(job.archived ? 'Ancienne projection' : cadence(job))}</strong><span class="oj-detail-caption">${esc(job.schedule.timezone || 'Fuseau natif non communiqué')}</span></div><div><span class="oj-detail-label">PROCHAIN DÉPART</span><strong class="oj-detail-value">${esc(job.archived ? 'Aucun' : job.enabled ? when(job.nextRunAt) : 'Départs automatiques en pause')}</strong><span class="oj-detail-caption">${esc(last ? `Dernier départ : ${when(last.startedAt)}` : 'Aucun reçu communiqué')}</span></div></div>
      <p class="oj-result${last?.state === 'failed' ? ' oj-result-error' : ''}"><i class="fas ${last?.state === 'failed' ? 'fa-circle-exclamation' : 'fa-clock-rotate-left'}" aria-hidden="true"></i><span>${esc(last ? `${states[last.state]?.[1] || 'Résultat à vérifier'} · détails et historique dans ${job.ownerLabel}` : job.archived ? 'Historique conservé dans la projection.' : 'Première exécution à valider.')}</span></p>
      <div class="oj-job-actions">${ownerAction}</div></article>`;
  }
  function update(value, query = '') {
    snapshot = value; search = query.toLocaleLowerCase();
    if (!snapshot) return;
    $('automationSources').innerHTML = snapshot.sources.map(source => {
      const jobs = snapshot.jobs.filter(job => job.owner === source.id && !job.archived);
      return `<button class="oj-source-pill" data-source-owner="${esc(source.id)}" title="${esc(source.observedAt ? `Relevé ${when(source.observedAt)}` : 'Aucun relevé disponible')}"><span class="oj-source-dot ${source.available ? 'online' : 'offline'}"></span><strong>${esc(source.label)}</strong><span>${jobs.filter(job => job.enabled).length} actifs / ${jobs.length}</span>${source.available ? '' : `<small>${source.stale ? 'Ancien relevé' : 'Indisponible'}</small>`}</button>`;
    }).join('');
    if (calendarData) renderCalendar();
  }
  function decorate() {
    $('operationsJobs').classList.toggle('oj-jobs-compact', compact);
    $('densityCompact').setAttribute('aria-pressed', String(compact));
    $('densityDetailed').setAttribute('aria-pressed', String(!compact));
    $('operationsJobs').querySelectorAll('.oj-job').forEach((card, index) => {
      const id = card.dataset.jobId;
      if (!card.querySelector('.oj-job-expanded')) {
        const details = document.createElement('div'); details.className = 'oj-job-expanded'; details.id = `automation-details-${index}`;
        card.querySelectorAll('.oj-job-description,.oj-route,.oj-result').forEach(element => details.append(element));
        card.insertBefore(details, card.querySelector('.oj-job-actions'));
        const button = document.createElement('button'); button.type = 'button'; button.className = 'oj-button oj-button-quiet oj-expand-button';
        button.dataset.jobExpand = id; button.setAttribute('aria-controls', details.id);
        button.setAttribute('aria-label', `Afficher les détails de ${card.querySelector('h3').textContent}`);
        button.innerHTML = '<i class="fas fa-chevron-down" aria-hidden="true"></i>';
        card.querySelector('.oj-job-actions').append(button);
      }
      card.classList.toggle('oj-job-is-expanded', expanded.has(id));
      card.querySelector('[data-job-expand]').setAttribute('aria-expanded', String(!compact || expanded.has(id)));
    });
  }
  function renderCalendar() {
    if (!snapshot || !calendarData) return;
    const names = new Map(snapshot.jobs.map(job => [job.id, job]));
    const rows = calendarData.rows.filter(row => {
      const job = names.get(row.jobId);
      return job && (!search || `${job.name} ${job.description} ${job.ownerLabel} ${job.agentId || ''}`.toLocaleLowerCase().includes(search));
    }).sort((a, b) => (a.occurrences[0] || 'z').localeCompare(b.occurrences[0] || 'z'));
    const total = rows.reduce((sum, row) => sum + row.occurrences.length, 0);
    const stale = (calendarData.sources || []).filter(source => !source.available).map(source => source.label);
    $('calendarContext').textContent = `${timezone} · ${rows.length} traitements · ${total} départs ou vérifications prévus${stale.length ? ` · relevés à vérifier : ${stale.join(', ')}` : ''}`;
    $('automationCalendar').innerHTML = rows.length ? rows.map(row => {
      const job = names.get(row.jobId), starts = row.occurrences;
      const frequent = starts.length > 6;
      return `<article class="oj-calendar-row"><div class="oj-calendar-time">${starts.length ? esc(clock(starts[0])) : '—'}${frequent ? `<small>→ ${esc(clock(starts[starts.length - 1]))}</small>` : ''}</div>
        <div class="oj-calendar-copy"><h3>${esc(job.name)}</h3><span>${esc(job.ownerLabel)}${job.agentId ? ` · ${esc(job.agentId)}` : ''} · ${esc(cadence(job))}</span>${row.error ? '<p class="oj-calendar-warning">Horaire incomplet : consulter le propriétaire pour les départs exacts.</p>' : ''}
        ${frequent ? `<details><summary>${starts.length}${row.truncated ? '+' : ''} ${row.conditional ? 'vérifications' : 'départs'} · voir les heures</summary><div class="oj-calendar-slots">${starts.map(at => `<time datetime="${esc(at)}">${esc(clock(at))}</time>`).join('')}</div></details>` : `<div class="oj-calendar-slots">${starts.map(at => `<time datetime="${esc(at)}">${esc(clock(at))}</time>`).join('')}</div>`}</div>
        <span class="oj-badge oj-badge-${row.conditional ? 'neutral' : 'live'}">${row.conditional ? 'Selon la source' : 'Planifié'}</span></article>`;
    }).join('') : '<div class="oj-empty"><i class="fas fa-calendar-check" aria-hidden="true"></i><h3>Aucun départ prévu dans cette vue</h3><p>Changez de jour ou de recherche.</p></div>';
    $('automationCalendar').setAttribute('aria-busy', 'false');
  }
  async function calendar() {
    if (loading || !snapshot) return;
    loading = true;
    const date = $('calendarDate').value;
    requestedDate = date;
    $('automationCalendar').setAttribute('aria-busy', 'true');
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(`/api/automations/calendar?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`, {signal: controller.signal});
      const body = await response.json();
      if (!response.ok || body.status !== 'success') throw Error('Unavailable');
      if ($('calendarDate').value === date) {calendarData = body.data; renderCalendar();}
    } catch {
      $('automationCalendar').innerHTML = '<div class="oj-empty"><h3>Calendrier indisponible</h3><p>Actualisez pour recevoir les horaires. Aucun départ n’est supposé confirmé.</p></div>';
      $('automationCalendar').setAttribute('aria-busy', 'false');
    } finally {clearTimeout(deadline); loading = false; if ($('calendarDate').value !== requestedDate) calendar();}
  }
  $('calendarDate').value = localDate(new Date());
  $('calendarDate').addEventListener('change', () => {if ($('calendarDate').value) calendar();});
  function shift(days) {
    const date = new Date(`${$('calendarDate').value || localDate(new Date())}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
    $('calendarDate').value = date.toISOString().slice(0, 10); calendar();
  }
  $('calendarPrevious').addEventListener('click', () => shift(-1));
  $('calendarNext').addEventListener('click', () => shift(1));
  $('calendarToday').addEventListener('click', () => {$('calendarDate').value = localDate(new Date()); calendar();});
  $('automationSources').addEventListener('click', event => {
    const button = event.target.closest('[data-source-owner]');
    if (button) {$('jobsOwner').value = button.dataset.sourceOwner; $('jobsOwner').dispatchEvent(new Event('change')); $('jobsTab').click();}
  });
  $('operationsJobs').addEventListener('click', event => {
    const button = event.target.closest('[data-job-expand]');
    if (!button) return;
    const id = button.dataset.jobExpand;
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    decorate();
  });
  for (const [id, value] of [['densityCompact', true], ['densityDetailed', false]]) $(id).addEventListener('click', () => {
    compact = value; try {localStorage.setItem('agentx.automations.density', compact ? 'compact' : 'detailed');} catch {} decorate();
  });
  window.AutomationsHub = {card, update, calendar, decorate};
})();
