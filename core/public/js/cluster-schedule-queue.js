/** Read-only projection of the instance's operator-managed heavy-job queue. */
async function loadHeavyQueue() {
  const container = document.getElementById('heavyQueueList');
  if (!container) return;
  try {
    renderHeavyQueue(container, await fetchJSON(`${API_BASE}/schedule/heavy-queue`));
  } catch (error) {
    container.innerHTML = `<div class="cs-empty">Heavy queue unavailable: ${esc(error.message)}</div>`;
  }
}

function renderHeavyQueue(container, queue) {
  if (!queue.available) {
    container.innerHTML = '<div class="cs-empty" title="Mount the instance QUEUE.md into Core to show it here.">No heavy-job queue configured.</div>';
    return;
  }
  const running = queue.running || [];
  const waiting = queue.waiting || [];
  let html = `<div class="cs-queue-note">Updated ${esc(formatEvidenceTime(queue.modifiedAt))} · planning list only; entries do not reserve a host or start a job.</div>`;
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
