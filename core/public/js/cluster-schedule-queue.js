/** Core heavy-work requests and explicit legacy migration. */
let heavyQueuePage = 0;
let heavyQueueData = null;
const HEAVY_QUEUE_API = '/api/cluster/schedule/work-queue';

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
  const jobs = queue.jobs || [];
  const size = 10;
  heavyQueuePage = Math.min(heavyQueuePage, Math.max(0, Math.ceil(jobs.length / size) - 1));
  let html = '<div class="cs-queue-note">Requests from Nestor and coding sessions. Planned slots do not hold a GPU; Core admission remains required at launch.</div>';
  html += `<div class="cs-queue-note"><a href="${HEAVY_QUEUE_API}/export">Download queue snapshot</a> · ${Number(queue.archivedCount || 0)} archived</div>`;
  if (queue.legacy) html += '<div class="cs-queue-note">QUEUE.md is an archived snapshot. Submit new work to Core.</div>';
  html += jobs.slice(heavyQueuePage * size, (heavyQueuePage + 1) * size).map(job => {
    const editable = ['requested', 'reserved'].includes(job.state);
    const active = ['dispatching', 'running', 'uncertain'].includes(job.state);
    const expired = job.state === 'reserved' && Date.parse(job.reservation.end) <= Date.now();
    const overrun = active && job.reservation && Date.parse(job.reservation.end) < Date.now();
    return `<article class="cs-next-item cs-queue-item" data-queue-id="${esc(job.id)}">
      <div>
        <div class="cs-next-name">${esc(job.title)}</div>
        <div class="cs-next-meta"><span>P${Number(job.priority)} · ${esc(job.kind)} · ${esc(expired ? 'window expired' : job.state)}</span></div>
        <div class="cs-next-meta">${esc(job.hosts.join(', ') || job.legacyRow?.hosts || 'Hosts need review')}</div>
        ${job.reservation ? `<div class="cs-next-meta">${esc(formatEvidenceTime(job.reservation.start))} → ${esc(formatEvidenceTime(job.reservation.end))} (estimated)</div>` : ''}
        ${overrun ? '<div class="cs-queue-note">Past estimated end; waiting for an executor and release receipt.</div>' : ''}
        <div class="cs-next-meta">${esc(job.source.type)} ${esc(job.source.ref || '')} ${esc(job.source.taskId || '')}</div>
        ${job.source.issueUrl ? `<a href="${esc(job.source.issueUrl)}" target="_blank" rel="noopener">GitHub issue</a>` : ''}
        ${job.operation ? `<div class="cs-next-meta">Operation ${esc(job.operation.id)}</div>` : ''}
        ${job.reason ? `<div class="cs-queue-note">${esc(job.reason)}</div>` : ''}
        <details><summary>Request and receipts</summary><pre class="cs-queue-receipt">${esc(JSON.stringify(job, null, 2))}</pre></details>
        <div class="cs-queue-actions">
          ${editable && job.hosts.length ? '<button type="button" class="cs-queue-button" data-queue-action="reserve">Plan a slot</button>' : ''}
          ${editable ? '<button type="button" class="cs-queue-button" data-queue-action="cancel">Cancel request</button>' : ''}
          ${active ? '<button type="button" class="cs-queue-button" data-queue-action="reconcile">Check executor result</button>' : ''}
        </div>
      </div>
    </article>`;
  }).join('');
  if (!jobs.length) html += '<div class="cs-empty">No heavy-work requests. Coding sessions submit them through the operator queue tool.</div>';
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
function openQueueReservation(job) {
  const dialog = document.getElementById('heavyQueueReservation');
  const form = dialog.querySelector('form');
  form.dataset.queueId = job.id;
  form.dataset.revision = job.revision;
  form.elements.start.value = '';
  form.elements.priority.value = job.priority;
  dialog.querySelector('[data-queue-title]').textContent = job.title;
  dialog.querySelector('[data-queue-zone]').textContent = `Your device timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Duration: ${job.estimatedMinutes} min (estimated).`;
  dialog.querySelector('[role="alert"]').textContent = '';
  dialog.showModal();
}
document.getElementById('heavyQueueList')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-queue-action]');
  if (!button) return;
  const action = button.dataset.queueAction;
  const container = document.getElementById('heavyQueueList');
  if (action === 'previous' || action === 'next') {
    heavyQueuePage += action === 'next' ? 1 : -1;
    return renderHeavyQueue(container, heavyQueueData);
  }
  const id = button.closest('[data-queue-id]')?.dataset.queueId;
  const job = heavyQueueData.jobs?.find(item => item.id === id);
  if (action === 'reserve') return openQueueReservation(job);
  button.disabled = true;
  try {
    if (action === 'migrate') await queueWrite('/migrate', { sha256: heavyQueueData.sha256 });
    else await queueWrite(`/${id}/${action}`, action === 'cancel' ? { expectedRevision: job.revision } : {});
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
    const start = new Date(form.elements.start.value);
    if (!Number.isFinite(start.getTime())) throw new Error('Choose a valid start time');
    await queueWrite(`/${form.dataset.queueId}/reserve`, { expectedRevision: Number(form.dataset.revision),
      start: start.toISOString(), priority: Number(form.elements.priority.value) });
    form.closest('dialog').close();
    await Promise.all([loadHeavyQueue(), loadTimeline()]);
  } catch (error) { output.textContent = error.message; }
});
