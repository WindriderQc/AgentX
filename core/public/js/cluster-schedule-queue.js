/** Core heavy-work requests and explicit legacy migration. */
let heavyQueuePage = 0;
let heavyQueueData = null;
let heavyQueueView = 'active';
const HEAVY_QUEUE_API = '/api/cluster/schedule/work-queue';
// Kinds Core launches itself at their slot (Run now, or the owner's automatic start).
const CORE_LAUNCHED_KINDS = ['profiler', 'embedding-reindex'];

async function loadHeavyQueue() {
  const container = document.getElementById('heavyQueueList');
  if (!container) return;
  try {
    heavyQueueData = await fetchJSON(HEAVY_QUEUE_API);
    renderHeavyQueue(container, heavyQueueData);
  } catch (error) {
    container.innerHTML = `<div class="cs-empty">Heavy queue unavailable: ${esc(error.message)}</div>`;
  }
}

function renderHeavyQueue(container, queue) {
  if (queue.authority === 'core.heavy-work-queue') return renderCoreHeavyQueue(container, queue);
  if (!queue.available) {
    container.innerHTML = '<div class="cs-empty" title="Mount the instance QUEUE.md into Core to show it here.">No heavy-job queue configured.</div>';
    return;
  }
  const running = queue.running || [];
  const waiting = queue.waiting || [];
  let html = `<div class="cs-queue-note">Legacy planning list · updated ${esc(formatEvidenceTime(queue.modifiedAt))}. Migration preserves this snapshot in Core; QUEUE.md becomes an archive.</div>`;
  if (queue.migrationRequired) html += '<button type="button" class="cs-queue-button" data-queue-action="migrate">Migrate this snapshot to Core</button>';
  const group = (title, rows) => {
    html += `<div class="cs-queue-group">${title} <span>${rows.length}</span></div>`;
    html += rows.slice(0, 6).map(item => `
      <div class="cs-next-item cs-queue-item">
        <div>
          <div class="cs-next-name">${esc(item.job)}</div>
          <div class="cs-next-meta">
            <span class="cs-source-chip cadence">P${Number(item.priority)}</span>
            <span>${esc(item.hosts)}</span>
            ${item.estimated ? `<span>${esc(item.estimated)}</span>` : ''}
            ${item.timing ? `<span>${esc(item.timing)}</span>` : ''}
          </div>
        </div>
      </div>`).join('');
    if (rows.length > 6) html += `<div class="cs-queue-note">${rows.length - 6} more ${title.toLowerCase()} jobs not shown</div>`;
  };
  group('Running', running);
  group('Waiting', waiting);
  if (!running.length && !waiting.length) html += '<div class="cs-empty">No heavy jobs running or waiting.</div>';
  container.innerHTML = html;
}

function renderCoreHeavyQueue(container, queue) {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const all = queue.jobs || [];
  const pending = all.filter(job => !terminal.has(job.state));
  const finished = all.filter(job => terminal.has(job.state));
  const rank = job => job.state === 'uncertain' ? 0 : ['running', 'dispatching'].includes(job.state) ? 1
    : job.state === 'reserved' && Date.parse(job.reservation?.end) > Date.now() ? 2 : job.state === 'requested' ? 3 : 4;
  const jobs = heavyQueueView === 'finished'
    ? finished.sort((a, b) => String(b.finishedAt || b.updatedAt || b.createdAt).localeCompare(String(a.finishedAt || a.updatedAt || a.createdAt)))
    : pending.sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || String(a.reservation?.start || a.createdAt).localeCompare(String(b.reservation?.start || b.createdAt)));
  const size = 10;
  heavyQueuePage = Math.min(heavyQueuePage, Math.max(0, Math.ceil(jobs.length / size) - 1));
  let html = `<div class="cs-queue-actions" role="group" aria-label="Demandes de travaux lourds">
    <button type="button" class="cs-queue-button" data-queue-action="active" aria-pressed="${heavyQueueView === 'active'}">À traiter · ${pending.length}</button>
    <button type="button" class="cs-queue-button" data-queue-action="finished" aria-pressed="${heavyQueueView === 'finished'}">Terminées · ${finished.length}</button></div>`;
  html += '<div class="cs-queue-note">Demandes de Nestor et des sessions de code. Les créneaux sont estimés; Core vérifie la disponibilité au lancement.</div>';
  html += `<div class="cs-queue-note"><a href="${HEAVY_QUEUE_API}/export">Exporter la file</a> · ${Number(queue.archivedCount || 0)} archivées</div>`;
  html += jobs.slice(heavyQueuePage * size, (heavyQueuePage + 1) * size).map(job => {
    const editable = ['requested', 'reserved'].includes(job.state);
    const active = ['dispatching', 'running', 'uncertain'].includes(job.state);
    const expired = job.state === 'reserved' && Date.parse(job.reservation.end) <= Date.now();
    const overrun = active && job.reservation && Date.parse(job.reservation.end) < Date.now();
    const launchable = CORE_LAUNCHED_KINDS.includes(job.kind) && Boolean(job.executor);
    const now = Date.now();
    const runnable = launchable && job.state === 'reserved' && Date.parse(job.reservation.start) <= now
      && now < Date.parse(job.reservation.end) && (!job.startBefore || now < Date.parse(job.startBefore));
    return `<article class="cs-next-item cs-queue-item" data-queue-id="${esc(job.id)}">
      <div>
        <div class="cs-next-name">${esc(job.title)}</div>
        <div class="cs-next-meta"><span>P${Number(job.priority)} · ${esc(job.kind)} · ${esc(expired ? 'window expired' : job.state)}</span></div>
        <div class="cs-next-meta">${esc(job.hosts.join(', ') || job.legacyRow?.hosts || 'Hosts need review')}</div>
        ${job.reservation ? `<div class="cs-next-meta">${esc(formatEvidenceTime(job.reservation.start))} → ${esc(formatEvidenceTime(job.reservation.end))} (estimated)${job.reservation.when === 'asap' ? ' · as soon as possible' : job.reservation.when === 'tonight' ? ' · tonight' : ''}</div>` : ''}
        ${job.state === 'reserved' && !expired ? `<div class="cs-queue-start${job.reservation.autoStart ? ' is-auto' : ''}">${job.reservation.autoStart
          ? '<i class="fas fa-play-circle" aria-hidden="true"></i> Starts automatically at its time'
          : launchable ? '<i class="fas fa-hand-pointer" aria-hidden="true"></i> Waits for you: use Run now during its slot' : '<i class="fas fa-terminal" aria-hidden="true"></i> Started by its own executor'}</div>` : ''}
        ${job.dispatchedAt ? `<div class="cs-next-meta">Dispatch recorded ${esc(formatEvidenceTime(job.dispatchedAt))}${job.finishedAt ? ` · settled ${esc(formatEvidenceTime(job.finishedAt))}` : ''}</div>` : ''}
        ${job.releaseReceipt ? `<div class="cs-next-meta">Receipt: ${esc(job.releaseReceipt.authority)}</div>` : ''}
        ${overrun ? '<div class="cs-queue-note">Past estimated end; waiting for an executor and release receipt.</div>' : ''}
        <div class="cs-next-meta">${esc(job.source.type)} ${esc(job.source.ref || '')} ${esc(job.source.taskId || '')}</div>
        ${job.source.issueUrl ? `<a href="${esc(job.source.issueUrl)}" target="_blank" rel="noopener">GitHub issue</a>` : ''}
        ${job.operation ? `<div class="cs-next-meta">Operation ${esc(job.operation.id)}</div>` : ''}
        ${job.reason ? `<div class="cs-queue-note">${esc(job.reason)}</div>` : ''}
        <details><summary>Request and receipts</summary><pre class="cs-queue-receipt">${esc(JSON.stringify(job, null, 2))}</pre></details>
        <div class="cs-queue-actions">
          ${runnable ? '<button type="button" class="cs-queue-button cs-queue-button--primary" data-queue-action="run">Run now</button>' : ''}
          ${editable && job.hosts.length ? `<button type="button" class="cs-queue-button" data-queue-action="reserve">${job.state === 'reserved' ? 'Change slot' : 'Plan a slot'}</button>` : ''}
          ${editable ? '<button type="button" class="cs-queue-button" data-queue-action="cancel">Cancel request</button>' : ''}
          ${active ? '<button type="button" class="cs-queue-button" data-queue-action="reconcile">Check executor result</button>' : ''}
        </div>
      </div>
    </article>`;
  }).join('');
  if (!jobs.length) html += `<div class="cs-empty">${heavyQueueView === 'finished' ? 'Aucune demande terminée dans la file courante.' : 'Aucun travail lourd à traiter.'}</div>`;
  if (jobs.length > size) html += `<div class="cs-queue-actions">
    <button type="button" class="cs-queue-button" data-queue-action="previous" ${heavyQueuePage === 0 ? 'disabled' : ''}>Previous</button>
    <span>${heavyQueuePage * size + 1}–${Math.min((heavyQueuePage + 1) * size, jobs.length)} / ${jobs.length}</span>
    <button type="button" class="cs-queue-button" data-queue-action="next" ${(heavyQueuePage + 1) * size >= jobs.length ? 'disabled' : ''}>Next</button></div>`;
  container.innerHTML = html;
}

async function queueWrite(suffix, body) {
  const response = await fetch(HEAVY_QUEUE_API + suffix, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-service-caller': 'cluster-schedule-ui' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.message || 'Queue update failed');
  return result.data;
}
function localInput(iso) {
  const date = iso ? new Date(iso) : null;
  return date && Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}
function slotText(slot) {
  const time = value => new Date(value).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `${time(slot.start)} → ${time(slot.end)} (estimated)`;
}
// Ask Core which slot this choice gives, before anything is booked (#878).
async function previewQueueSlot(form) {
  const when = form.elements.when.value;
  const output = form.querySelector('[data-queue-slot]');
  form.querySelector('[data-queue-at]').hidden = when !== 'at';
  form.elements.start.required = when === 'at';
  if (when === 'at') { output.textContent = 'Core checks this time against other work when you save.'; return; }
  output.textContent = 'Finding the slot…';
  try {
    const slot = await fetchJSON(`${HEAVY_QUEUE_API}/${encodeURIComponent(form.dataset.queueId)}/place?when=${when}`);
    output.textContent = slot.fits === false
      ? (when === 'tonight' ? 'No free slot long enough tonight. Choose As soon as possible or a time.' : 'No free slot before this request\'s start limit.')
      : `Core will plan it ${slotText(slot)}.`;
  } catch (error) { output.textContent = `Slot unavailable: ${error.message}`; }
}
function openQueueReservation(job) {
  const dialog = document.getElementById('heavyQueueReservation');
  const form = dialog.querySelector('form');
  form.dataset.queueId = job.id;
  form.dataset.revision = job.revision;
  // A planned slot opens on its own choice and time, in the device's zone.
  const chosen = job.reservation?.when || (job.reservation ? 'at' : 'asap');
  form.querySelector(`input[name="when"][value="${chosen}"]`).checked = true;
  form.elements.start.value = localInput(job.reservation?.start);
  form.elements.priority.value = job.priority;
  const auto = form.querySelector('[data-queue-auto]');
  const launchable = CORE_LAUNCHED_KINDS.includes(job.kind) && Boolean(job.executor);
  auto.hidden = !launchable;
  form.elements.autoStart.checked = launchable && (job.reservation ? job.reservation.autoStart === true : true);
  dialog.querySelector('[data-queue-title]').textContent = job.title;
  dialog.querySelector('[data-queue-zone]').textContent = `Your device timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Duration: ${job.estimatedMinutes} min (estimated).`;
  dialog.querySelector('[role="alert"]').textContent = '';
  dialog.showModal();
  previewQueueSlot(form);
}
document.querySelector('#heavyQueueReservation form')?.addEventListener('change', event => {
  if (event.target.name === 'when') previewQueueSlot(event.currentTarget);
});
document.getElementById('heavyQueueList')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-queue-action]');
  if (!button) return;
  const action = button.dataset.queueAction;
  const container = document.getElementById('heavyQueueList');
  if (action === 'active' || action === 'finished') {
    heavyQueueView = action;
    heavyQueuePage = 0;
    return renderHeavyQueue(container, heavyQueueData);
  }
  if (action === 'previous' || action === 'next') {
    heavyQueuePage += action === 'next' ? 1 : -1;
    return renderHeavyQueue(container, heavyQueueData);
  }
  const id = button.closest('[data-queue-id]')?.dataset.queueId;
  const job = heavyQueueData.jobs?.find(item => item.id === id);
  if (action === 'reserve') return openQueueReservation(job);
  if (action === 'run' && !window.confirm(`Start “${job.title}” now on ${job.hosts.join(', ')}? It runs about ${job.estimatedMinutes} min.`)) return;
  button.disabled = true;
  try {
    if (action === 'migrate') await queueWrite('/migrate', { sha256: heavyQueueData.sha256 });
    else await queueWrite(`/${id}/${action}`, ['cancel', 'run'].includes(action) ? { expectedRevision: job.revision } : {});
    await Promise.all([loadHeavyQueue(), loadTimeline()]);
  } catch (error) {
    document.getElementById('heavyQueueError').textContent = error.message;
    button.disabled = false;
  }
});
document.querySelector('#heavyQueueReservation form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if (event.submitter?.value === 'cancel') return document.getElementById('heavyQueueReservation').close();
  const output = form.closest('dialog').querySelector('[role="alert"]');
  try {
    const when = form.elements.when.value;
    const body = { expectedRevision: Number(form.dataset.revision), when, priority: Number(form.elements.priority.value),
      ...(form.querySelector('[data-queue-auto]').hidden ? {} : { autoStart: form.elements.autoStart.checked === true }) };
    if (when === 'at') {
      const start = new Date(form.elements.start.value);
      if (!Number.isFinite(start.getTime())) throw new Error('Choose a valid start time');
      body.at = start.toISOString();
    }
    await queueWrite(`/${form.dataset.queueId}/place`, body);
    form.closest('dialog').close();
    await Promise.all([loadHeavyQueue(), loadTimeline()]);
  } catch (error) { output.textContent = error.message; }
});
