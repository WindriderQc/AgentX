/**
 * Cluster Schedule Dashboard — Frontend Logic
 *
 * Four components:
 * 1. Live State Bar — polls /api/cluster/schedule/live every 30s
 * 2. 24h Timeline Heatmap — by-task or by-host view with date nav
 * 3. Next Up — countdown list
 * 4. Conflict Detection — warns about overlapping tasks on same host
 */

const API_BASE = '/api/cluster';
const LIVE_POLL_MS = 30000;
const COUNTDOWN_TICK_MS = 1000;

const TASK_COLORS = {
  benchmark: '#f59e0b',
  sync: '#3b82f6',
  cleanup: '#8b5cf6',
  monitoring: '#22c55e',
  inference: '#7cf0ff',
  maintenance: '#6b7280',
  ingestion: '#ec4899',
  backup: '#f97316',
  scanning: '#14b8a6',
  diagnostics: '#a78bfa'
};

let livePollTimer = null;
let countdownTimer = null;
let nextTasksData = [];
let currentDate = new Date().toISOString().slice(0, 10);
let viewMode = 'task'; // 'task' or 'host'

// ── Date Navigation ──────────────────────────────────────────────

function updateDateLabel() {
  const el = document.getElementById('dateLabel');
  const d = new Date(currentDate + 'T12:00:00');
  const today = new Date().toISOString().slice(0, 10);
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  el.textContent = currentDate === today ? `${label} (Today)` : label;
}

function shiftDate(delta) {
  const d = new Date(currentDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  currentDate = d.toISOString().slice(0, 10);
  updateDateLabel();
  loadTimeline();
  loadConflicts();
}

function goToday() {
  currentDate = new Date().toISOString().slice(0, 10);
  updateDateLabel();
  loadTimeline();
  loadConflicts();
}

function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('viewTask').classList.toggle('active', mode === 'task');
  document.getElementById('viewHost').classList.toggle('active', mode === 'host');
  loadTimeline();
  loadConflicts();
}

// ── API Helpers ────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.error || 'API error');
  return json.data;
}

// ── Live State Bar ─────────────────────────────────────────────

async function loadLiveState() {
  const container = document.getElementById('liveBar');
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/live`);
    renderLiveBar(container, data.hosts);
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> Failed to load live state: ${escapeHtml(err.message)}</div>`;
  }
}

function renderLiveBar(container, hosts) {
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }

  container.innerHTML = hosts.map(h => {
    const statusClass = h.status === 'online' ? 'online' : 'unreachable';
    const modelsHtml = (h.models || []).length > 0
      ? h.models.map(m => {
          const sizeGb = m.sizeVram ? (m.sizeVram / 1073741824).toFixed(1) + ' GB VRAM' : '';
          return `<span class="cs-model-tag" title="${escapeHtml(sizeGb)}">${escapeHtml(m.name || m.model)}</span>`;
        }).join('')
      : '<span class="cs-host-models">No models loaded</span>';

    const totalVram = (h.models || []).reduce((sum, m) => sum + (m.sizeVram || 0), 0);
    const vramStr = totalVram > 0 ? `${(totalVram / 1073741824).toFixed(1)} GB VRAM in use` : '';

    return `
      <div class="cs-host-card">
        <div class="cs-host-header">
          <span class="cs-status-dot ${statusClass}"></span>
          <span class="cs-host-name">${escapeHtml(h.name)} <span style="color:var(--muted);font-size:12px">(${escapeHtml(h.id)})</span></span>
        </div>
        <div class="cs-host-models">${modelsHtml}</div>
        ${vramStr ? `<div class="cs-host-vram"><i class="fas fa-memory"></i> ${vramStr}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ── Timeline Heatmap ───────────────────────────────────────────

async function loadTimeline() {
  const container = document.getElementById('heatmapContainer');
  try {
    if (viewMode === 'host') {
      const data = await fetchJSON(`${API_BASE}/schedule/timeline-by-host?date=${currentDate}`);
      renderHostHeatmap(container, data.hosts);
      renderLegendFromHosts(data.hosts);
    } else {
      const data = await fetchJSON(`${API_BASE}/schedule/timeline?date=${currentDate}`);
      renderTaskHeatmap(container, data.timeline);
      renderLegend(data.timeline);
    }
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> Failed to load timeline: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Task View (original) ────────────────────────────────────────

function renderTaskHeatmap(container, timeline) {
  if (!timeline || timeline.length === 0) {
    container.innerHTML = '<div class="cs-empty">No scheduled tasks for this day</div>';
    return;
  }
  const currentHour = isToday() ? new Date().getHours() : -1;
  const rows = timeline.map(entry => ({
    label: entry.name,
    taskType: entry.taskType,
    host: entry.host,
    model: entry.model,
    slots: entry.slots
  }));

  container.innerHTML = buildHeatmapGrid(rows, currentHour, false);
  attachTooltipEvents(container);
}

// ── Host View (new Gantt) ────────────────────────────────────────

function renderHostHeatmap(container, hosts) {
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }
  const currentHour = isToday() ? new Date().getHours() : -1;

  let html = '<div class="cs-heatmap-grid">';
  // Header row
  html += '<div class="cs-hm-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="cs-hm-header">${String(h).padStart(2, '0')}</div>`;
  }

  for (const host of hosts) {
    const vramInfo = host.vramCapacityMb ? `${(host.vramCapacityMb / 1024).toFixed(0)} GB` : '';
    html += `<div class="cs-host-row-label"><i class="fas fa-server" style="color:#7cf0ff;font-size:11px"></i> ${escapeHtml(host.hostName)} ${vramInfo ? `<span class="cs-vram-info">${vramInfo}</span>` : ''}</div>`;

    for (let h = 0; h < 24; h++) {
      const currentClass = h === currentHour ? ' current-hour' : '';
      // Collect all task slots that fall in this hour
      let slotsHtml = '';
      for (const task of host.tasks) {
        slotsHtml += getSlotSegments(task.slots, h, h + 1, task.taskType, task.name);
      }
      html += `<div class="cs-hm-cell${currentClass}" data-hour="${h}" data-name="${escapeHtml(host.hostName)}" data-type="host">${slotsHtml}</div>`;
    }
  }

  html += '</div>';
  container.innerHTML = html;
  attachTooltipEvents(container);
}

// ── Shared Heatmap Builder ───────────────────────────────────────

function buildHeatmapGrid(rows, currentHour) {
  let html = '<div class="cs-heatmap-grid">';
  html += '<div class="cs-hm-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="cs-hm-header">${String(h).padStart(2, '0')}</div>`;
  }

  for (const row of rows) {
    html += `<div class="cs-hm-label" title="${escapeHtml(row.host || 'any')}">${escapeHtml(truncate(row.label, 16))}</div>`;
    for (let h = 0; h < 24; h++) {
      const currentClass = h === currentHour ? ' current-hour' : '';
      const slotsInHour = getSlotSegments(row.slots, h, h + 1, row.taskType, row.label);
      html += `<div class="cs-hm-cell${currentClass}" data-hour="${h}" data-name="${escapeHtml(row.label)}" data-type="${row.taskType}">${slotsInHour}</div>`;
    }
  }

  html += '</div>';
  return html;
}

function getSlotSegments(slots, hourStart, hourEnd, taskType, taskName) {
  if (!slots || slots.length === 0) return '';
  taskName = taskName || taskType;

  let html = '';
  for (const slot of slots) {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    const slotStartHour = slotStart.getHours() + slotStart.getMinutes() / 60;
    const slotEndHour = slotEnd.getHours() + slotEnd.getMinutes() / 60 + (slotEnd.getDate() !== slotStart.getDate() ? 24 : 0);

    if (slotEndHour <= hourStart || slotStartHour >= hourEnd) continue;

    const visStart = Math.max(slotStartHour - hourStart, 0);
    const visEnd = Math.min(slotEndHour - hourStart, 1);
    const left = (visStart * 100).toFixed(1);
    const width = ((visEnd - visStart) * 100).toFixed(1);
    const contClass = slot.continuous ? ' continuous' : '';

    const timeStr = `${formatTime(slotStart)} - ${formatTime(slotEnd)}`;
    html += `<div class="cs-hm-slot ${taskType}${contClass}" style="left:${left}%;width:${width}%" data-tooltip-name="${escapeHtml(taskName)}" data-tooltip-detail="${escapeHtml(taskType + ' | ' + timeStr)}"></div>`;
  }
  return html;
}

function renderLegend(timeline) {
  const container = document.getElementById('legend');
  const seenTypes = new Set(timeline.map(t => t.taskType));
  container.innerHTML = Array.from(seenTypes).map(type =>
    `<div class="cs-legend-item"><div class="cs-legend-color" style="background:${TASK_COLORS[type] || '#666'}"></div> ${type}</div>`
  ).join('');
}

function renderLegendFromHosts(hosts) {
  const container = document.getElementById('legend');
  const seenTypes = new Set();
  for (const host of hosts) {
    for (const task of host.tasks) seenTypes.add(task.taskType);
  }
  container.innerHTML = Array.from(seenTypes).map(type =>
    `<div class="cs-legend-item"><div class="cs-legend-color" style="background:${TASK_COLORS[type] || '#666'}"></div> ${type}</div>`
  ).join('');
}

// ── Conflicts ────────────────────────────────────────────────────

async function loadConflicts() {
  const banner = document.getElementById('conflictBanner');
  const text = document.getElementById('conflictText');
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/conflicts?date=${currentDate}`);
    if (data.conflicts.length > 0) {
      const summaries = data.conflicts.map(c =>
        `${c.taskA.name} + ${c.taskB.name} on ${c.hostId}`
      );
      const unique = [...new Set(summaries)];
      text.textContent = `${data.count} conflict${data.count > 1 ? 's' : ''} detected: ${unique.slice(0, 3).join('; ')}${unique.length > 3 ? ` (+${unique.length - 3} more)` : ''}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch {
    banner.classList.add('hidden');
  }
}

// ── Tooltip ────────────────────────────────────────────────────

function attachTooltipEvents(container) {
  container.querySelectorAll('.cs-hm-slot').forEach(el => {
    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('mousemove', moveTooltip);
  });
}

function showTooltip(e) {
  const tooltip = document.getElementById('tooltip');
  const slot = e.target;
  document.getElementById('tooltipName').textContent = slot.dataset.tooltipName || '';
  document.getElementById('tooltipDetail').textContent = slot.dataset.tooltipDetail || '';
  tooltip.classList.add('visible');
}

function hideTooltip() {
  document.getElementById('tooltip').classList.remove('visible');
}

function moveTooltip(e) {
  const tooltip = document.getElementById('tooltip');
  tooltip.style.left = (e.clientX + 12) + 'px';
  tooltip.style.top = (e.clientY - 10) + 'px';
}

// ── Next Up ────────────────────────────────────────────────────

async function loadNextTasks() {
  const container = document.getElementById('nextList');
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/next?count=8`);
    nextTasksData = data.tasks || [];
    renderNextTasks(container);
    startCountdown();
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(err.message)}</div>`;
  }
}

function renderNextTasks(container) {
  if (nextTasksData.length === 0) {
    container.innerHTML = '<div class="cs-empty">No upcoming tasks</div>';
    return;
  }

  container.innerHTML = nextTasksData.map((task, i) => `
    <div class="cs-next-item">
      <div>
        <div class="cs-next-name">${escapeHtml(task.name)}</div>
        <div class="cs-next-meta">
          <span class="cs-task-badge ${task.taskType}">${task.taskType}</span>
          <span>${escapeHtml(task.source)}</span>
          ${task.host ? `<span><i class="fas fa-server"></i> ${escapeHtml(task.host)}</span>` : ''}
        </div>
      </div>
      <div class="cs-next-countdown" id="countdown-${i}">${formatCountdown(task.msFromNow)}</div>
    </div>
  `).join('');
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const startedAt = Date.now();

  countdownTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    nextTasksData.forEach((task, i) => {
      const el = document.getElementById(`countdown-${i}`);
      if (el) {
        const remaining = Math.max(0, task.msFromNow - elapsed);
        el.textContent = formatCountdown(remaining);
      }
    });
  }, COUNTDOWN_TICK_MS);
}

function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Utilities ──────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '\u2026' : str;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function isToday() {
  return currentDate === new Date().toISOString().slice(0, 10);
}

// ── Refresh / Init ─────────────────────────────────────────────

async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  const icon = btn.querySelector('i');
  icon.classList.add('spinning');
  try {
    await Promise.all([loadLiveState(), loadTimeline(), loadNextTasks(), loadConflicts()]);
  } finally {
    icon.classList.remove('spinning');
  }
}

function startLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(loadLiveState, LIVE_POLL_MS);
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  updateDateLabel();
  refreshAll();
  startLivePolling();
});
