/**
 * Cluster Schedule Dashboard — v2
 *
 * 1. Live host cards — VRAM bar, active model, next job, health badge
 * 2. Background services strip — persistent monitors collapsed out of timeline
 * 3. Grouped timeline — rows grouped by taskType, collapsible, with now line
 * 4. Right panel — Next Up + Attention tabs
 * 5. Conflict detection
 */

const API_BASE = '/api/cluster';
const LIVE_POLL_MS = 30000;
const COUNTDOWN_TICK_MS = 1000;

const TASK_COLORS = {
  benchmark: '#f59e0b', sync: '#3b82f6', cleanup: '#8b5cf6',
  monitoring: '#22c55e', inference: '#7cf0ff', maintenance: '#6b7280',
  ingestion: '#ec4899', backup: '#f97316', scanning: '#14b8a6',
  diagnostics: '#a78bfa'
};

const CATEGORY_LABELS = {
  monitoring: 'MON', maintenance: 'MAINT', sync: 'SYNC', benchmark: 'BENCH',
  inference: 'AI', diagnostics: 'DIAG', cleanup: 'CLEAN', ingestion: 'INGEST',
  backup: 'BAK', scanning: 'SCAN'
};

// Known host VRAM capacities (MB)
const HOST_VRAM = { primary: 12288, secondary: 16384, tertiary: 24576 };

let livePollTimer = null;
let countdownTimer = null;
let nextTasksData = [];
let conflictsData = [];
let currentDate = new Date().toISOString().slice(0, 10);
let viewMode = 'task';
let collapsedGroups = new Set();
let servicesCollapsed = false;

// ── API ─────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.error || 'API error');
  return json.data;
}

// ── Date Nav ────────────────────────────────────────────────

function updateDateLabel() {
  const el = document.getElementById('dateLabel');
  const d = new Date(currentDate + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  el.textContent = isToday() ? `${label} (Today)` : label;
}
function shiftDate(delta) {
  const d = new Date(currentDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  currentDate = d.toISOString().slice(0, 10);
  updateDateLabel(); loadTimeline(); loadConflicts();
}
function goToday() { currentDate = new Date().toISOString().slice(0, 10); updateDateLabel(); loadTimeline(); loadConflicts(); }
function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('viewTask').classList.toggle('active', mode === 'task');
  document.getElementById('viewHost').classList.toggle('active', mode === 'host');
  loadTimeline(); loadConflicts();
}
function isToday() { return currentDate === new Date().toISOString().slice(0, 10); }

// ── Tabs ────────────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll('.cs-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tabId === 'next') || (i === 1 && tabId === 'attention'));
  });
  document.getElementById('tabNext').classList.toggle('active', tabId === 'next');
  document.getElementById('tabAttention').classList.toggle('active', tabId === 'attention');
}

// ── Live Host Cards (enriched) ──────────────────────────────

async function loadLiveState() {
  const container = document.getElementById('liveBar');
  try {
    const [liveData, nextData] = await Promise.all([
      fetchJSON(`${API_BASE}/schedule/live`),
      fetchJSON(`${API_BASE}/schedule/next?count=20`)
    ]);
    renderLiveBar(container, liveData.hosts, nextData.tasks || []);
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

function renderLiveBar(container, hosts, nextTasks) {
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }

  container.innerHTML = hosts.map(h => {
    const isOnline = h.status === 'online';
    const statusClass = isOnline ? 'online' : 'unreachable';
    const models = h.models || [];
    const hasModels = models.length > 0;

    // VRAM usage
    const totalUsed = models.reduce((s, m) => s + (m.sizeVram || 0), 0);
    const totalUsedGb = (totalUsed / 1073741824).toFixed(1);
    const capacityMb = h.vramMb || HOST_VRAM[h.id] || 0;
    const capacityGb = (capacityMb / 1024).toFixed(0);
    const usedPct = capacityMb > 0 ? Math.min(100, (totalUsed / (capacityMb * 1048576)) * 100) : 0;
    const vramClass = usedPct > 85 ? 'high' : usedPct > 50 ? 'mid' : 'low';

    // Health badge
    let healthClass, healthLabel;
    if (!isOnline) { healthClass = 'down'; healthLabel = 'DOWN'; }
    else if (hasModels) { healthClass = 'ok'; healthLabel = 'ACTIVE'; }
    else { healthClass = 'idle'; healthLabel = 'IDLE'; }

    // Model tags
    const modelsHtml = hasModels
      ? models.map(m => `<span class="cs-model-tag">${esc(m.name || m.model)}</span>`).join('')
      : '<span style="color:#475569">No models loaded</span>';

    // Next job for this host
    const hostNext = nextTasks.find(t => t.host === h.id);
    const nextHtml = hostNext
      ? `<div class="cs-host-next"><i class="fas fa-clock"></i> Next: ${esc(hostNext.name)} in ${formatCountdown(hostNext.msFromNow)}</div>`
      : '';

    const cardClass = !isOnline ? ' down' : '';

    return `
      <div class="cs-host-card${cardClass}">
        <div class="cs-host-header">
          <span class="cs-status-dot ${statusClass}"></span>
          <span class="cs-host-name">${esc(h.name)}</span>
          <span class="cs-health-badge ${healthClass}">${healthLabel}</span>
        </div>
        <div class="cs-host-models">${modelsHtml}</div>
        ${capacityMb > 0 ? `
          <div class="cs-vram-bar"><div class="cs-vram-fill ${vramClass}" style="width:${usedPct.toFixed(1)}%"></div></div>
          <div class="cs-host-detail"><span>${totalUsedGb} / ${capacityGb} GB VRAM</span><span>${usedPct.toFixed(0)}%</span></div>
        ` : ''}
        ${nextHtml}
      </div>`;
  }).join('');
}

// ── Timeline ────────────────────────────────────────────────

async function loadTimeline() {
  const container = document.getElementById('heatmapContainer');
  try {
    if (viewMode === 'host') {
      const data = await fetchJSON(`${API_BASE}/schedule/timeline-by-host?date=${currentDate}`);
      document.getElementById('servicesStrip').style.display = 'none';
      renderHostHeatmap(container, data.hosts);
      renderLegendFromHosts(data.hosts);
    } else {
      const data = await fetchJSON(`${API_BASE}/schedule/timeline?date=${currentDate}`);
      const { persistent, scheduled } = splitTimeline(data.timeline);
      renderServicesStrip(persistent);
      renderGroupedHeatmap(container, scheduled);
      renderLegend(scheduled);
    }
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

// Split timeline into persistent services vs actual scheduled jobs
function splitTimeline(timeline) {
  if (!timeline) return { persistent: [], scheduled: [] };
  const persistent = [];
  const scheduled = [];
  for (const entry of timeline) {
    const isContinuous = entry.slots.length === 1 && entry.slots[0].continuous;
    const isHighFreq = entry.slots.length > 12; // more than 12 runs/day = background service
    if (isContinuous || isHighFreq) persistent.push(entry);
    else scheduled.push(entry);
  }
  return { persistent, scheduled };
}

// ── Persistent Services Strip ───────────────────────────────

function renderServicesStrip(persistent) {
  const strip = document.getElementById('servicesStrip');
  const grid = document.getElementById('servicesGrid');
  const count = document.getElementById('servicesCount');

  if (persistent.length === 0) { strip.style.display = 'none'; return; }
  strip.style.display = 'block';
  count.textContent = `(${persistent.length})`;

  grid.innerHTML = persistent.map(p => {
    const color = TASK_COLORS[p.taskType] || '#666';
    return `<div class="cs-service-chip">
      <span class="cs-service-dot active" style="background:${color}"></span>
      ${esc(p.name)}
      <span style="color:#475569;font-size:10px">${p.slots.length > 1 ? p.slots.length + 'x/day' : '24/7'}</span>
    </div>`;
  }).join('');
}

function toggleServices() {
  servicesCollapsed = !servicesCollapsed;
  document.getElementById('servicesGrid').classList.toggle('collapsed', servicesCollapsed);
  document.getElementById('servicesToggle').classList.toggle('collapsed', servicesCollapsed);
}

// ── Grouped Task Heatmap ────────────────────────────────────

function renderGroupedHeatmap(container, timeline) {
  if (!timeline || timeline.length === 0) {
    container.innerHTML = '<div class="cs-empty">No scheduled jobs for this day</div>';
    return;
  }

  const currentHour = isToday() ? new Date().getHours() : -1;
  const nowMinuteFrac = isToday() ? new Date().getMinutes() / 60 : -1;

  // Group by taskType
  const groups = {};
  for (const entry of timeline) {
    const g = entry.taskType || 'other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(entry);
  }

  // Sort groups: monitoring first, then alphabetical
  const groupOrder = ['monitoring', 'inference', 'benchmark', 'maintenance', 'sync', 'diagnostics', 'scanning', 'cleanup', 'ingestion', 'backup'];
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ia = groupOrder.indexOf(a), ib = groupOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  let html = '<div class="cs-heatmap-grid">';
  // Header
  html += '<div class="cs-hm-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="cs-hm-header">${String(h).padStart(2, '0')}</div>`;
  }

  for (const groupKey of sortedKeys) {
    const entries = groups[groupKey];
    const isCollapsed = collapsedGroups.has(groupKey);
    const toggleIcon = isCollapsed ? 'collapsed' : '';
    const color = TASK_COLORS[groupKey] || '#666';

    html += `<div class="cs-group-header" onclick="toggleGroup('${groupKey}')">
      <i class="fas fa-caret-down toggle ${toggleIcon}"></i>
      <span style="color:${color}">${(groupKey).toUpperCase()}</span>
      <span class="cs-group-count">${entries.length} job${entries.length > 1 ? 's' : ''}</span>
    </div>`;

    for (const entry of entries) {
      const hiddenClass = isCollapsed ? ' cs-group-hidden' : '';
      const prefix = CATEGORY_LABELS[entry.taskType] || '';
      const hostTag = entry.host ? entry.host.slice(0, 3).toUpperCase() : '';

      html += `<div class="cs-hm-label${hiddenClass}" title="${esc(entry.name)}${entry.host ? ' [' + entry.host + ']' : ''}">
        <span class="cs-cat-prefix">${prefix}</span>${esc(entry.name)}
        ${hostTag ? `<span class="cs-host-tag">${hostTag}</span>` : ''}
      </div>`;

      for (let h = 0; h < 24; h++) {
        const pastClass = isToday() && h < currentHour ? ' past' : '';
        const curClass = h === currentHour ? ' current-hour' : '';
        const slotsHtml = getSlotSegments(entry.slots, h, h + 1, entry.taskType, entry.name);
        html += `<div class="cs-hm-cell${pastClass}${curClass}${hiddenClass}" data-hour="${h}" data-name="${esc(entry.name)}" data-type="${entry.taskType}">${slotsHtml}</div>`;
      }
    }
  }

  html += '</div>';

  // Now line
  if (isToday() && currentHour >= 0) {
    const gridCols = 25; // 1 label + 24 hours
    const labelWidthPx = 200;
    const nowPct = ((currentHour + nowMinuteFrac) / 24) * 100;
    html += `<div class="cs-now-line" style="left:calc(${labelWidthPx}px + ${nowPct}% * (100% - ${labelWidthPx}px) / 100%)"></div>`;
  }

  container.innerHTML = html;

  // Position now line precisely using JS after render
  if (isToday()) positionNowLine(container);
  attachTooltipEvents(container);
}

function positionNowLine(container) {
  const grid = container.querySelector('.cs-heatmap-grid');
  if (!grid) return;
  const nowFrac = (new Date().getHours() + new Date().getMinutes() / 60) / 24;
  const gridRect = grid.getBoundingClientRect();
  // First column is the label column (200px)
  const firstCell = grid.querySelector('.cs-hm-cell');
  if (!firstCell) return;
  const cellsStart = firstCell.getBoundingClientRect().left - gridRect.left;
  const cellsWidth = gridRect.width - cellsStart;
  const lineLeft = cellsStart + cellsWidth * nowFrac;

  let line = container.querySelector('.cs-now-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'cs-now-line';
    line.innerHTML = '<span class="cs-now-label">NOW</span>';
    container.appendChild(line);
  }
  line.style.left = lineLeft + 'px';
  line.style.top = '0';
  line.style.height = grid.offsetHeight + 'px';
}

function toggleGroup(groupKey) {
  if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
  else collapsedGroups.add(groupKey);
  loadTimeline();
}

// ── Host Gantt View ─────────────────────────────────────────

function renderHostHeatmap(container, hosts) {
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }
  const currentHour = isToday() ? new Date().getHours() : -1;

  let html = '<div class="cs-heatmap-grid">';
  html += '<div class="cs-hm-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="cs-hm-header">${String(h).padStart(2, '0')}</div>`;
  }

  for (const host of hosts) {
    const vramInfo = host.vramCapacityMb ? `${(host.vramCapacityMb / 1024).toFixed(0)} GB` : '';
    html += `<div class="cs-host-row-label"><i class="fas fa-server" style="color:#7cf0ff;font-size:10px"></i> ${esc(host.hostName)} ${vramInfo ? `<span class="cs-vram-info">${vramInfo}</span>` : ''}</div>`;

    for (let h = 0; h < 24; h++) {
      const pastClass = isToday() && h < currentHour ? ' past' : '';
      const curClass = h === currentHour ? ' current-hour' : '';
      let slotsHtml = '';
      for (const task of host.tasks) {
        slotsHtml += getSlotSegments(task.slots, h, h + 1, task.taskType, task.name);
      }
      html += `<div class="cs-hm-cell${pastClass}${curClass}" data-hour="${h}" data-name="${esc(host.hostName)}" data-type="host">${slotsHtml}</div>`;
    }
  }

  html += '</div>';
  container.innerHTML = html;
  if (isToday()) positionNowLine(container);
  attachTooltipEvents(container);
}

// ── Slot Rendering ──────────────────────────────────────────

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
    html += `<div class="cs-hm-slot ${taskType}${contClass}" style="left:${left}%;width:${width}%" data-tooltip-name="${esc(taskName)}" data-tooltip-detail="${esc(taskType + ' | ' + timeStr)}"></div>`;
  }
  return html;
}

// ── Legend ───────────────────────────────────────────────────

function renderLegend(timeline) {
  const el = document.getElementById('legend');
  const types = new Set(timeline.map(t => t.taskType));
  el.innerHTML = Array.from(types).map(t =>
    `<div class="cs-legend-item"><div class="cs-legend-color" style="background:${TASK_COLORS[t] || '#666'}"></div>${t}</div>`
  ).join('');
}
function renderLegendFromHosts(hosts) {
  const el = document.getElementById('legend');
  const types = new Set();
  for (const h of hosts) for (const t of h.tasks) types.add(t.taskType);
  el.innerHTML = Array.from(types).map(t =>
    `<div class="cs-legend-item"><div class="cs-legend-color" style="background:${TASK_COLORS[t] || '#666'}"></div>${t}</div>`
  ).join('');
}

// ── Conflicts ───────────────────────────────────────────────

async function loadConflicts() {
  const banner = document.getElementById('conflictBanner');
  const text = document.getElementById('conflictText');
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/conflicts?date=${currentDate}`);
    conflictsData = data.conflicts || [];
    if (conflictsData.length > 0) {
      const summaries = conflictsData.map(c => `${c.taskA.name} + ${c.taskB.name} on ${c.hostId}`);
      const unique = [...new Set(summaries)];
      text.textContent = `${data.count} conflict${data.count > 1 ? 's' : ''}: ${unique.slice(0, 3).join('; ')}${unique.length > 3 ? ` (+${unique.length - 3} more)` : ''}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    renderAttention();
  } catch { banner.classList.add('hidden'); renderAttention(); }
}

// ── Attention Tab ───────────────────────────────────────────

function renderAttention() {
  const container = document.getElementById('attentionList');
  const items = [];

  // Conflicts
  for (const c of conflictsData) {
    items.push({ type: 'error', icon: 'fa-bolt', label: 'Schedule conflict',
      detail: `${c.taskA.name} overlaps ${c.taskB.name} on ${c.hostId}` });
  }

  // Down hosts (from live bar data)
  document.querySelectorAll('.cs-host-card.down').forEach(card => {
    const name = card.querySelector('.cs-host-name')?.textContent || 'Host';
    items.push({ type: 'error', icon: 'fa-server', label: `${name} unreachable`, detail: 'Host is not responding to Ollama API polling' });
  });

  // Tasks showing "Now" in next up = possibly overdue
  for (const t of nextTasksData) {
    if (t.msFromNow <= 0) {
      items.push({ type: 'warn', icon: 'fa-clock', label: `${t.name} overdue`, detail: `Was expected to run — may be stale or stuck` });
    }
  }

  if (items.length === 0) {
    container.innerHTML = '<div class="cs-empty"><i class="fas fa-check-circle" style="color:#22c55e"></i> All clear</div>';
    return;
  }

  container.innerHTML = items.map(it => `
    <div class="cs-attn-item${it.type === 'warn' ? ' warn' : ''}">
      <span class="cs-attn-icon"><i class="fas ${it.icon}"></i></span>
      <span class="cs-attn-label">${esc(it.label)}</span>
      <div class="cs-attn-detail">${esc(it.detail)}</div>
    </div>
  `).join('');
}

// ── Tooltip ─────────────────────────────────────────────────

function attachTooltipEvents(container) {
  container.querySelectorAll('.cs-hm-slot').forEach(el => {
    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('mousemove', moveTooltip);
  });
}
function showTooltip(e) {
  const tooltip = document.getElementById('tooltip');
  document.getElementById('tooltipName').textContent = e.target.dataset.tooltipName || '';
  document.getElementById('tooltipDetail').textContent = e.target.dataset.tooltipDetail || '';
  tooltip.classList.add('visible');
}
function hideTooltip() { document.getElementById('tooltip').classList.remove('visible'); }
function moveTooltip(e) {
  const t = document.getElementById('tooltip');
  t.style.left = (e.clientX + 12) + 'px';
  t.style.top = (e.clientY - 10) + 'px';
}

// ── Next Up ─────────────────────────────────────────────────

async function loadNextTasks() {
  const container = document.getElementById('nextList');
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/next?count=10`);
    nextTasksData = data.tasks || [];
    renderNextTasks(container);
    startCountdown();
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
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
        <div class="cs-next-name">${esc(task.name)}</div>
        <div class="cs-next-meta">
          <span class="cs-task-badge ${task.taskType}">${task.taskType}</span>
          ${task.host ? `<span><i class="fas fa-server" style="font-size:9px"></i> ${esc(task.host)}</span>` : ''}
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
      if (el) el.textContent = formatCountdown(Math.max(0, task.msFromNow - elapsed));
    });
  }, COUNTDOWN_TICK_MS);
}

// ── Utilities ───────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── Init / Refresh ──────────────────────────────────────────

async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  const icon = btn.querySelector('i');
  icon.classList.add('spinning');
  try {
    await Promise.all([loadLiveState(), loadTimeline(), loadNextTasks(), loadConflicts()]);
  } finally { icon.classList.remove('spinning'); }
}

function startLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(loadLiveState, LIVE_POLL_MS);
}

document.addEventListener('DOMContentLoaded', () => {
  updateDateLabel();
  refreshAll();
  startLivePolling();
});
