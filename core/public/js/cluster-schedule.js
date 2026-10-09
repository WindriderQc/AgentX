/**
 * Cluster Schedule Dashboard — v2
 *
 * 1. Live host cards — VRAM bar, active model, next job, health badge
 * 2. Background services strip — persistent monitors collapsed out of timeline
 * 3. Grouped timeline — rows grouped by taskType, collapsible, with now line
 * 4. Upcoming + Alerts cards
 * 5. Conflict detection
 */

const API_BASE = '/api/cluster';
const LIVE_POLL_MS = 30000;
const TIMELINE_POLL_MS = 60000;
const COUNTDOWN_TICK_MS = 1000;
const SCHEDULE_DATE = window.ClusterScheduleDate;
const UPCOMING_PROJECTION = window.ClusterScheduleUpcoming;
const HEADLINE_PROJECTION = window.ClusterScheduleHeadline;
const OPERATOR_TIME_ZONE = SCHEDULE_DATE.browserTimeZone();
// One display locale for every date and time on the page, with a 24-hour clock.
const UI_LOCALE = 'en-US';

const TASK_COLORS = {
  benchmark: '#f59e0b', sync: '#3b82f6', cleanup: '#8b5cf6',
  monitoring: '#22c55e', inference: '#7cf0ff', maintenance: '#6b7280',
  ingestion: '#ec4899', backup: '#f97316', scanning: '#14b8a6',
  diagnostics: '#a78bfa'
};

const HOST_COLORS = ['#7cf0ff', '#f97316', '#22c55e', '#a78bfa', '#f59e0b'];

const SOURCE_META = {
  agentx: { label: 'AgentX', color: '#38bdf8' },
  'agentx-system': { label: 'External scheduler', color: '#f59e0b' },
  'ollama-persistent': { label: 'Persistent GPU', color: '#22c55e' }
};

const CATEGORY_LABELS = {
  monitoring: 'MON', maintenance: 'MAINT', sync: 'SYNC', benchmark: 'BENCH',
  inference: 'AI', diagnostics: 'DIAG', cleanup: 'CLEAN', ingestion: 'INGEST',
  backup: 'BAK', scanning: 'SCAN'
};

let livePollTimer = null;
let timelinePollTimer = null;
let countdownTimer = null;
let nextTasksData = [];
let conflictsData = [];
let overdueData = [];
let claimsData = [];
let liveHostsData = [];
let currentDate = SCHEDULE_DATE.localDateKey(new Date(), OPERATOR_TIME_ZONE);
let lastObservedToday = currentDate;
let viewMode = 'task';
let collapsedGroups = new Set();
let servicesCollapsed = false;
let actualView = 'heatmap';
let showHighFreqLightJobs = false;
let showNoGpuTasks = true;
let servicePopoverPinnedId = null;
let lastServiceHoverId = null;
let persistentServicesData = [];
let visibleTimelineEntries = [];
let upcomingTimelineEntries = [];
let tooltipAnchor = null;
let visibleTimelineHosts = [];
let renderedTimelineMode = null;
let lastTimelineMobile = window.innerWidth <= 700;

// ── API ─────────────────────────────────────────────────────

let failedRequests = 0;

// Turn network failures, proxy HTML pages and API errors into short,
// readable messages instead of raw JSON parse errors.
async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (_error) {
    failedRequests += 1;
    throw new Error('Core is unreachable');
  }
  let json = null;
  try { json = await res.json(); } catch (_error) { json = null; }
  if (!json || json.status !== 'success') {
    failedRequests += 1;
    throw new Error(json?.error || `Server returned HTTP ${res.status}`);
  }
  return json.data;
}

// ── Date Nav ────────────────────────────────────────────────

function updateDateLabel() {
  const el = document.getElementById('dateLabel');
  const zoneEl = document.getElementById('dateZoneLabel');
  const description = SCHEDULE_DATE.describeCalendarDate(currentDate, {
    now: new Date(),
    timeZone: OPERATOR_TIME_ZONE,
    locale: UI_LOCALE
  });
  el.textContent = description.label;
  el.setAttribute('datetime', currentDate);
  el.title = `Browser-local calendar${OPERATOR_TIME_ZONE ? ` (${OPERATOR_TIME_ZONE})` : ''}`;
  if (zoneEl) zoneEl.textContent = OPERATOR_TIME_ZONE || 'Browser local time';
}
function shiftDate(delta) {
  currentDate = SCHEDULE_DATE.addCalendarDays(currentDate, delta);
  updateDateLabel(); loadTimeline(); loadConflicts();
  if (actualView === 'avp') loadActualVsPlanned();
}
function goToday() { currentDate = SCHEDULE_DATE.localDateKey(new Date(), OPERATOR_TIME_ZONE); updateDateLabel(); loadTimeline(); loadConflicts(); if (actualView === 'avp') loadActualVsPlanned(); }
function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('viewTask').classList.toggle('active', mode === 'task');
  document.getElementById('viewHost').classList.toggle('active', mode === 'host');
  document.getElementById('viewTask').setAttribute('aria-pressed', String(mode === 'task'));
  document.getElementById('viewHost').setAttribute('aria-pressed', String(mode === 'host'));
  syncTimelineFilterUI();
  loadTimeline(); loadConflicts();
}
function isToday() { return SCHEDULE_DATE.isToday(currentDate, new Date(), OPERATOR_TIME_ZONE); }
function isPastDate() { return currentDate < SCHEDULE_DATE.localDateKey(new Date(), OPERATOR_TIME_ZONE); }
function calendarQuery() {
  const params = new URLSearchParams({ date: currentDate });
  if (OPERATOR_TIME_ZONE) params.set('timezone', OPERATOR_TIME_ZONE);
  return params.toString();
}

// ── Live Host Cards (enriched) ──────────────────────────────

async function loadLiveState() {
  const container = document.getElementById('liveBar');
  const [liveResult, nextResult, ecosystemResult] = await Promise.allSettled([
    fetchJSON(`${API_BASE}/schedule/live`),
    fetchJSON(`${API_BASE}/schedule/next?count=20`),
    fetchJSON('/api/nerve-center/ecosystem')
  ]);

  const scheduleAvailable = nextResult.status === 'fulfilled';
  const nextData = scheduleAvailable ? nextResult.value : null;
  const nextTasks = nextData?.tasks || [];

  if (liveResult.status === 'fulfilled') {
    renderLiveBar(container, liveResult.value.hosts, nextTasks, { scheduleAvailable });
    updateLiveEvidence(liveResult.value);
  } else {
    liveHostsData = [];
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> Host details unavailable: ${esc(liveResult.reason?.message || 'unknown error')}</div>`;
    updateLiveEvidence(null);
  }

  if (ecosystemResult.status === 'fulfilled') {
    try {
      const headline = HEADLINE_PROJECTION.projectEcosystemHeadline(ecosystemResult.value);
      updateHeaderStatus(headline, nextTasks, {
        scheduleAvailable,
        scheduleEvidence: nextData?.evidence || null
      });
    } catch (error) {
      updateHeaderStatusUnavailable(error);
    }
  } else {
    updateHeaderStatusUnavailable(ecosystemResult.reason);
  }
  renderAttention();
}

function updateLiveEvidence(liveData) {
  const el = document.getElementById('liveEvidence');
  if (!el) return;
  try {
    const evidence = HEADLINE_PROJECTION.projectLiveDetailEvidence(liveData);
    el.dataset.status = 'observed';
    el.dataset.authority = evidence.authority;
    el.dataset.evidenceScope = evidence.scope;
    el.dataset.observedAt = evidence.observedAt;
    el.textContent = `Host cards polled ${formatEvidenceTime(evidence.observedAt)}.`;
    el.title = 'Loaded models and VRAM come from polling each host directly; the host counts above come from the ecosystem snapshot.';
  } catch (_error) {
    el.dataset.status = 'unavailable';
    delete el.dataset.authority;
    delete el.dataset.evidenceScope;
    delete el.dataset.observedAt;
    el.textContent = 'Host details are unavailable right now; loaded models and VRAM are unknown, not zero.';
    el.title = '';
  }
}

function renderLiveBar(container, hosts, nextTasks, { scheduleAvailable = true } = {}) {
  liveHostsData = hosts || [];
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }

  container.innerHTML = hosts.map(h => {
    const isOnline = h.status === 'online';
    const statusClass = isOnline ? 'online' : 'unreachable';
    const models = h.models || [];
    const hasModels = models.length > 0;

    // VRAM
    const totalUsed = models.reduce((s, m) => s + (m.sizeVram || 0), 0);
    const capacityMb = h.vramMb || 0;
    const capacityGb = (capacityMb / 1024).toFixed(0);
    const usedGb = (totalUsed / 1073741824).toFixed(1);
    const freeBytes = Math.max(0, capacityMb * 1048576 - totalUsed);
    const freeGb = (freeBytes / 1073741824).toFixed(1);
    const usedPct = capacityMb > 0 ? Math.min(100, (totalUsed / (capacityMb * 1048576)) * 100) : 0;
    const vramFillClass = usedPct > 85 ? 'high' : usedPct > 50 ? 'mid' : 'low';
    const freeClass = usedPct > 85 ? 'critical' : usedPct > 50 ? 'tight' : '';
    const isIdle = !hasModels && isOnline;

    // Workload state — one badge that captures the meaningful state
    let stateBadgeClass, stateBadgeLabel;
    if (!isOnline)     { stateBadgeClass = 'down';    stateBadgeLabel = 'OFFLINE'; }
    else if (hasModels){ stateBadgeClass = 'ok';      stateBadgeLabel = 'ACTIVE'; }
    else               { stateBadgeClass = 'idle';    stateBadgeLabel = 'NO MODEL'; }

    const gpuLine = h.gpu?.model || h.gpuModel || '';

    // Optional IP from the explicitly configured runtime URL.
    const ipMatch = (h.url || '').match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    const hostIp = ipMatch ? ipMatch[0] : '';

    // Loaded model display
    const modelsHtml = hasModels
      ? `<div class="cs-host-model-summary">Loaded ${models.length} model${models.length !== 1 ? 's' : ''}</div>
         <div class="cs-host-models-loaded">${models.map(m => `<span class="cs-model-tag">${esc(m.name || m.model)}</span>`).join('')}</div>`
      : `<div class="cs-host-models-idle"><i class="fas fa-circle-notch" style="font-size:9px;margin-right:5px;opacity:0.4"></i>No model loaded</div>`;

    // Scheduled jobs for this host (non-service-tick)
    const allHostJobs = scheduleAvailable
      ? nextTasks.filter(t => t.host === h.id && !isServiceTick(t))
      : [];
    const hostJobsSoon = allHostJobs.filter(t => t.msFromNow >= 0 && t.msFromNow < 3600000);
    const nextJob     = allHostJobs[0];                    // soonest scheduled job
    const nextGpuJob  = allHostJobs.find(t => t.model);   // soonest GPU-bound job

    // VRAM row: context-aware
    let vramLine = '';
    if (capacityMb > 0) {
      if (isIdle) {
        vramLine = `<div class="cs-host-vram-idle"><span style="color:#22c55e;font-size:10px">⬤</span> ${capacityGb} GB available</div>`;
      } else if (hasModels) {
        vramLine = `
          <div class="cs-vram-bar" style="margin-top:6px"><div class="cs-vram-fill ${vramFillClass}" style="width:${usedPct.toFixed(1)}%"></div></div>
          <div class="cs-host-detail">
            <span>${usedGb} / ${capacityGb} GB VRAM</span>
            <span class="cs-vram-free ${freeClass}">${freeGb} GB free</span>
          </div>`;
      }
    }

    // Footer: next job + queue
    let footerHtml = '';
    if (!isOnline) {
      footerHtml = `<div class="cs-host-footer-offline"><i class="fas fa-exclamation-triangle"></i> Host unreachable</div>`;
    } else if (!scheduleAvailable) {
      footerHtml = '<div class="cs-host-next" style="font-style:italic">Schedule unavailable.</div>';
    } else if (nextJob) {
      const jobCount = hostJobsSoon.length;
      const countPart = jobCount > 1 ? `<span class="cs-host-queue-count">${jobCount} jobs in next hour</span>` : '';
      footerHtml = `<div class="cs-host-next"><i class="fas fa-clock"></i> Next scheduled: ${esc(nextJob.name)} <span class="cs-host-next-time">${formatCountdown(nextJob.msFromNow)}</span> ${countPart}</div>`;
      // If next job is light but there's an upcoming GPU job, surface it
      if (!nextJob.model && nextGpuJob && nextGpuJob !== nextJob) {
        footerHtml += `<div class="cs-host-next-gpu"><i class="fas fa-microchip"></i> Next GPU run: ${esc(nextGpuJob.model)} in ${formatCountdown(nextGpuJob.msFromNow)}</div>`;
      }
    } else {
      footerHtml = '<div class="cs-host-next" style="font-style:italic">No scheduled jobs assigned to this host today</div>';
    }

    const cardClass = !isOnline ? ' down' : hasModels ? ' active' : '';

    return `
      <div class="cs-host-card${cardClass}">
        <div class="cs-host-header">
          <span class="cs-status-dot ${statusClass}"></span>
          <div class="cs-host-title">
            <span class="cs-host-name">${esc(h.name)}</span>
            <span class="cs-host-role">${gpuLine}${hostIp ? ` · <span class="cs-host-ip">${hostIp}</span>` : ''}</span>
          </div>
          <span class="cs-health-badge ${stateBadgeClass}">${stateBadgeLabel}</span>
        </div>
        ${modelsHtml}
        ${vramLine}
        <div class="cs-host-card-footer">${footerHtml}</div>
      </div>`;
  }).join('');

}

function updateHeaderStatus(headline, nextTasks, { scheduleAvailable = true, scheduleEvidence = null } = {}) {
  const el = document.getElementById('headerStatus');
  if (!el) return;
  el.dataset.status = headline.status;
  el.dataset.authority = headline.authority;
  el.dataset.evidenceScope = headline.scope;
  el.dataset.observedAt = headline.observedAt;

  const scheduledNext = nextTasks.filter(t => !isServiceTick(t) && t.msFromNow >= 0 && t.msFromNow < 3600000);
  const gpuJobs = scheduledNext.filter(t => t.model).length;
  const lightJobs = scheduledNext.length - gpuJobs;
  const scheduleObservedAt = scheduleEvidence?.observedAt;
  const scheduleTitle = scheduleObservedAt && !Number.isNaN(Date.parse(scheduleObservedAt))
    ? `Schedule as of ${formatEvidenceTime(scheduleObservedAt)}`
    : 'Schedule';

  let scheduleHtml;
  if (!scheduleAvailable) {
    scheduleHtml = '<span class="cs-header-status-item warn"><i class="fas fa-clock" style="font-size:9px"></i> schedule unavailable</span>';
  } else if (scheduledNext.length > 0) {
    scheduleHtml = `<span class="cs-header-status-item" title="${esc(scheduleTitle)}"><i class="fas fa-clock" style="font-size:9px"></i> ${scheduledNext.length} next hour${gpuJobs ? ` · ${gpuJobs} GPU` : ''}${lightJobs ? ` · ${lightJobs} light` : ''}</span>`;
  } else {
    scheduleHtml = `<span class="cs-header-status-item" title="${esc(scheduleTitle)}"><i class="fas fa-clock" style="font-size:9px"></i> quiet next hour</span>`;
  }

  el.innerHTML = [
    `<span class="cs-header-status-item" title="Ecosystem snapshot from ${esc(formatEvidenceTime(headline.observedAt))}">${headline.configuredHosts} configured hosts</span>`,
    `<span class="cs-header-status-item ${headline.onlineHosts > 0 ? 'ok' : ''}"><i class="fas fa-circle" style="font-size:7px"></i> ${headline.onlineHosts} online</span>`,
    `<span class="cs-header-status-item ${headline.offlineHosts > 0 ? 'err' : ''}">${headline.offlineHosts} offline</span>`,
    `<span class="cs-header-status-item"><i class="fas fa-tags" style="font-size:9px"></i> ${headline.observedModels} model tags</span>`,
    scheduleHtml,
  ].filter(Boolean).join('<span class="cs-header-sep" aria-hidden="true"> · </span>');
}

function updateHeaderStatusUnavailable(error) {
  const el = document.getElementById('headerStatus');
  if (!el) return;
  el.dataset.status = 'unavailable';
  delete el.dataset.authority;
  delete el.dataset.evidenceScope;
  delete el.dataset.observedAt;
  el.innerHTML = `<span class="cs-header-status-item err"><i class="fas fa-triangle-exclamation"></i> Host summary unavailable${error?.message ? `: ${esc(error.message)}` : ''}</span>`;
}

// ── Timeline ────────────────────────────────────────────────

async function loadTimeline() {
  const container = document.getElementById('heatmapContainer');
  try {
    const endpoint = viewMode === 'host' ? 'timeline-by-host' : 'timeline';
    const [data, schedules] = await Promise.all([
      fetchJSON(`${API_BASE}/schedule/${endpoint}?${calendarQuery()}`),
      fetchJSON(`${API_BASE}/schedule?enabled=true`).catch(() => ({ entries: [] }))
    ]);
    const enrich = entries => UPCOMING_PROJECTION.withScheduleDetails(entries, schedules.entries);
    if (viewMode === 'host') {
      data.hosts = data.hosts.map(host => ({ ...host, tasks: enrich(host.tasks) }));
      document.getElementById('servicesStrip').style.display = 'none';
      upcomingTimelineEntries = data.hosts.flatMap(host => host.tasks || []);
      const hosts = data.hosts.map(host => ({
        ...host,
        tasks: filterTimelineEntries(host.tasks || [])
      }));
      visibleTimelineEntries = hosts.flatMap(host => host.tasks || []);
      visibleTimelineHosts = hosts;
      renderedTimelineMode = 'host';
      renderHostHeatmap(container, hosts);
      renderLegendFromHosts(hosts);
    } else {
      const { persistent, scheduled } = splitTimeline(enrich(data.timeline));
      const continuousServices = persistent.filter(entry => entry.source !== 'ollama-persistent');
      persistentServicesData = persistent;
      upcomingTimelineEntries = scheduled;

      // Schedule filters should not change the separate continuous-services strip.
      const visibleServices = continuousServices;
      const visibleScheduled = filterTimelineEntries(scheduled);
      visibleTimelineEntries = visibleScheduled;
      renderedTimelineMode = 'task';

      renderServicesStrip(visibleServices);
      renderGroupedHeatmap(container, visibleScheduled);
      renderLegend(visibleScheduled);
    }
    overdueData = isToday()
      ? UPCOMING_PROJECTION.findOverdueEntries(upcomingTimelineEntries, { now: Date.now() })
      : [];
    loadNextTasks();
  } catch (err) {
    overdueData = [];
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
  renderAttention();
}

// Split timeline into 24/7 continuous services vs schedulable jobs.
function splitTimeline(timeline) {
  if (!timeline) return { persistent: [], scheduled: [] };
  const persistent = [];
  const scheduled = [];
  for (const entry of timeline) {
    const isContinuous = entry.slots.length === 1 && entry.slots[0].continuous;
    if (isContinuous) persistent.push(entry);
    else scheduled.push(entry);
  }
  return { persistent, scheduled };
}

function filterTimelineEntries(entries) {
  return (entries || []).filter(entry => {
    if (!showNoGpuTasks && isNoGpuTaskEntry(entry)) return false;
    if (!showHighFreqLightJobs && isHighFrequencyLightJob(entry)) return false;
    return true;
  });
}

function isNoGpuTaskEntry(entry) {
  return !entry?.model && entry?.source !== 'ollama-persistent';
}

function isHighFrequencyLightJob(entry) {
  return UPCOMING_PROJECTION.isHighFrequencyLightJob(entry);
}

function setTimelineFilter(filterName, checked) {
  if (filterName === 'highFreq') showHighFreqLightJobs = checked;
  if (filterName === 'noGpu') showNoGpuTasks = checked;
  loadTimeline();
}

function syncTimelineFilterUI() {
  const filters = document.getElementById('timelineFilters');
  if (filters) filters.style.display = viewMode === 'task' ? 'flex' : 'none';
}

// ── Grouped Task Heatmap ────────────────────────────────────

function renderGroupedHeatmap(container, timeline) {
  if (window.innerWidth <= 700) { renderMobileTimeline(container, timeline); return; }
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

    const gpuCount = entries.filter(e => e.model).length;
    const infraCount = entries.length - gpuCount;
    const countLabel = gpuCount > 0
      ? `${gpuCount} AI job${gpuCount !== 1 ? 's' : ''}${infraCount > 0 ? `, ${infraCount} sys` : ''}`
      : `${infraCount} sys job${infraCount !== 1 ? 's' : ''}`;
    html += `<div class="cs-group-header" role="button" tabindex="0" aria-expanded="${!isCollapsed}" data-group-key="${esc(groupKey)}">
      <i class="fas fa-caret-down toggle ${toggleIcon}"></i>
      <span style="color:${color}">${(groupKey).toUpperCase()}</span>
      <span class="cs-group-count">${countLabel}</span>
    </div>`;

    for (const entry of entries) {
      const hiddenClass = isCollapsed ? ' cs-group-hidden' : '';
      const isInfra = isNoGpuTaskEntry(entry);
      const infraClass = isInfra ? ' cs-hm-label-infra' : '';
      const hostMeta = getHostMeta(entry.host);
      const hostLabel = hostMeta ? hostMeta.label : '';

      const cadence = getCadenceLabel(entry);
      html += `<div class="cs-hm-label${hiddenClass}${infraClass}" title="${esc(entry.name)}${isInfra ? ' [no GPU — infra task]' : ''}${hostLabel ? ' · ' + hostLabel : ''}${cadence ? ' · ' + cadence : ''}">
        <span class="cs-label-name">${esc(entry.name)}</span>
        ${cadence ? `<span class="cs-cadence-pill">${cadence}</span>` : ''}
        ${hostLabel ? `<span class="cs-host-tag ${hostMeta.id}">${esc(hostLabel)}</span>` : ''}
      </div>`;

      for (let h = 0; h < 24; h++) {
        const pastClass = isToday() && h < currentHour ? ' past' : '';
        const slotsHtml = getSlotSegments(entry.slots, h, h + 1, entry.taskType, entry.name, isInfra, { host: entry.host, source: entry.source, model: entry.model, estimatedDurationMs: entry.estimatedDurationMs, vramMb: entry.vramMb });
        html += `<div class="cs-hm-cell${pastClass}${hiddenClass}" data-hour="${h}" data-name="${esc(entry.name)}" data-type="${entry.taskType}">${slotsHtml}</div>`;
      }
    }
  }

  html += '</div>';

  // Now line
  if (isToday() && currentHour >= 0) {
    const gridCols = 25; // 1 label + 24 hours
    const labelWidthPx = 230;
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

  const now = new Date();
  const nowTimeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let line = container.querySelector('.cs-now-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'cs-now-line';
    container.appendChild(line);
  }
  line.innerHTML = `<span class="cs-now-label">${nowTimeStr}</span>`;
  line.style.left = lineLeft + 'px';
  line.style.top = '0';
  line.style.height = grid.offsetHeight + 'px';
}

function toggleGroup(groupKey) {
  const hadFocus = document.activeElement?.dataset?.groupKey === groupKey;
  if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
  else collapsedGroups.add(groupKey);
  const container = document.getElementById('heatmapContainer');
  hideTooltip();
  renderGroupedHeatmap(container, visibleTimelineEntries);
  if (hadFocus) {
    [...container.querySelectorAll('.cs-group-header')]
      .find(header => header.dataset.groupKey === groupKey)?.focus();
  }
}

// ── Host Gantt View ─────────────────────────────────────────

function renderHostHeatmap(container, hosts) {
  if (window.innerWidth <= 700) {
    renderMobileTimeline(container, (hosts || []).flatMap(host =>
      (host.tasks || []).map(task => ({ ...task, host: task.host || host.hostId }))));
    return;
  }
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
    html += `<div class="cs-host-row-label" title="${esc(host.hostName)}${vramInfo ? ' · ' + vramInfo : ''}"><i class="fas fa-server" style="color:#7cf0ff;font-size:10px"></i> ${esc(host.hostName)} ${vramInfo ? `<span class="cs-vram-info">${vramInfo}</span>` : ''}</div>`;

    for (let h = 0; h < 24; h++) {
      const pastClass = isToday() && h < currentHour ? ' past' : '';
      let slotsHtml = '';
      for (const task of host.tasks) {
        slotsHtml += getSlotSegments(task.slots, h, h + 1, task.taskType, task.name, false, { host: host.hostId || host.hostName, source: task.source, model: task.model, estimatedDurationMs: task.estimatedDurationMs, vramMb: task.vramMb });
      }
      html += `<div class="cs-hm-cell${pastClass}" data-hour="${h}" data-name="${esc(host.hostName)}" data-type="host">${slotsHtml}</div>`;
    }
  }

  html += '</div>';
  container.innerHTML = html;
  if (isToday()) positionNowLine(container);
  attachTooltipEvents(container);
}

// ── Slot Rendering ──────────────────────────────────────────

function getSlotSegments(slots, hourStart, hourEnd, taskType, taskName, isInfra = false, meta = {}) {
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
    const infraClass = isInfra ? ' infra' : '';
    html += `<div class="cs-hm-slot cs-timeline-detail ${taskType}${contClass}${infraClass}"
      style="left:${left}%;width:${width}%"
      ${slotDetailAttributes(taskType, taskName, isInfra, meta, slotStart, slotEnd)}></div>`;
  }
  return html;
}

function slotDetailAttributes(taskType, name, isInfra, meta, start, end) {
  const time = `${formatTime(start)}–${formatTime(end)}`;
  return `tabindex="0" role="button" aria-label="${esc(`${name}, ${time}, ${getHostMeta(meta.host).label}`)}"
    data-tt-name="${esc(name)}" data-tt-type="${esc(taskType)}" data-tt-time="${esc(time)}"
    data-tt-host="${esc(meta.host || '')}" data-tt-source="${esc(meta.source || '')}"
    data-tt-model="${esc(meta.model || '')}" data-tt-duration="${meta.estimatedDurationMs || 0}"
    data-tt-vram="${meta.vramMb || 0}" data-tt-infra="${isInfra ? '1' : '0'}"`;
}

function renderMobileTimeline(container, entries) {
  const remaining = UPCOMING_PROJECTION.buildRemainingTimelineSlots(entries);
  if (!remaining.length) {
    container.innerHTML = isPastDate()
      ? '<div class="cs-empty">This day is over; no upcoming tasks remain.</div>'
      : '<div class="cs-empty">No upcoming tasks</div>';
    return;
  }
  container.innerHTML = `<ol class="cs-mobile-timeline">${remaining.map(({ entry, slot }) => {
    const start = new Date(slot.start), end = new Date(slot.end);
    const host = getHostMeta(entry.host).label;
    return `<li><div class="cs-mobile-slot cs-timeline-detail"
      ${slotDetailAttributes(entry.taskType, entry.name, isNoGpuTaskEntry(entry), entry, start, end)}>
      <time datetime="${esc(slot.start)}">${esc(formatTime(start))}</time>
      <span class="cs-mobile-name" title="${esc(entry.name)}">${esc(entry.name)}</span>
      <span class="cs-mobile-meta"><span title="${esc(host)}">${esc(host)}</span>
        <span class="cs-task-badge ${esc(entry.taskType)}">${esc(entry.taskType)}</span></span>
    </div></li>`;
  }).join('')}</ol>`;
  attachTooltipEvents(container);
}

function getHostMeta(hostId) {
  if (!hostId || hostId === 'unassigned') {
    return { id: 'unassigned', label: 'No host assigned', color: '#94a3b8' };
  }
  const index = Math.abs([...String(hostId)].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % HOST_COLORS.length;
  const live = liveHostsData.find(host => host.id === hostId);
  return { id: hostId, label: live?.name || hostId, color: HOST_COLORS[index] };
}

function getSourceMeta(sourceId, metadata) {
  if (!sourceId) return { label: 'Unknown', color: '#64748b' };
  if (sourceId === 'agentx-system' && metadata?.scheduler === 'openclaw') {
    return { label: 'OpenClaw mirror', color: '#f59e0b' };
  }
  return SOURCE_META[sourceId] || { label: sourceId, color: '#64748b' };
}

// ── Conflicts ───────────────────────────────────────────────

async function loadConflicts() {
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/conflicts?${calendarQuery()}`);
    conflictsData = data.conflicts || [];
  } catch {
    conflictsData = [];
  }
  renderAttention();
}

async function loadClaims() {
  const container = document.getElementById('claimsList');
  if (!container) return;

  try {
    const data = await fetchJSON(`${API_BASE}/schedule/claims`);
    claimsData = data.claims || [];
    renderClaims(container);
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

function renderClaims(container) {
  if (!claimsData.length) {
    container.innerHTML = `
      <div class="cs-empty cs-claims-empty">
        <i class="fas fa-feather-pointed"></i>
        <div>No active placement claims</div>
        <div class="cs-claims-empty-note">Claims appear here when a job reserves a host before it runs.</div>
      </div>`;
    return;
  }

  const sortedClaims = [...claimsData].sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
  container.innerHTML = sortedClaims.map((claim) => {
    const hostMeta = getHostMeta(claim.host);
    const ttlMs = Math.max(new Date(claim.expiresAt).getTime() - Date.now(), 0);
    return `
      <div class="cs-claim-item">
        <div class="cs-claim-header">
          <span class="cs-host-tag ${hostMeta.id}">${esc(hostMeta.label)}</span>
          <span class="cs-claim-expiry">${formatCountdown(ttlMs)}</span>
        </div>
        <div class="cs-claim-model">${esc(claim.model || 'Unknown model')}</div>
        <div class="cs-claim-meta">
          <span><i class="fas fa-user-clock"></i> ${esc(claim.caller || 'unknown')}</span>
          <span><i class="fas fa-hourglass-half"></i> until ${esc(formatClockTime(claim.expiresAt))}</span>
        </div>
      </div>`;
  }).join('');
}

// ── Tooltip ─────────────────────────────────────────────────

function attachTooltipEvents(container) {
  container.querySelectorAll('.cs-timeline-detail').forEach(el => {
    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mouseleave', () => { if (document.activeElement !== el) hideTooltip(); });
    el.addEventListener('mousemove', moveTooltip);
    el.addEventListener('focus', showTooltip);
    el.addEventListener('blur', hideTooltip);
    el.addEventListener('click', showTooltip);
    el.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      showTooltip(event);
    });
  });
}
function showTooltip(e) {
  const anchor = e.currentTarget || e.target;
  if (tooltipAnchor && tooltipAnchor !== anchor) tooltipAnchor.removeAttribute('aria-describedby');
  tooltipAnchor = anchor;
  anchor.setAttribute('aria-describedby', 'tooltip');
  const d = anchor.dataset;
  const name    = d.ttName || '';
  const type    = d.ttType || '';
  const time    = d.ttTime || '';
  const host    = d.ttHost || '';
  const source  = d.ttSource || '';
  const model   = d.ttModel || '';
  const dur     = parseInt(d.ttDuration || '0');
  const vram    = parseInt(d.ttVram || '0');
  const isInfra = d.ttInfra === '1';

  const hostLabel  = host   ? (getHostMeta(host).label   || host)   : '';
  const sourceLabel = source ? (getSourceMeta(source).label || source) : '';

  const rows = [];
  if (time)        rows.push(row('fa-clock',      time,        ''));
  if (hostLabel)   rows.push(row('fa-server',     hostLabel,   ''));
  if (sourceLabel) rows.push(row('fa-tag',        sourceLabel, ''));
  if (model)       rows.push(row('fa-microchip',  model,       'hi'));
  if (dur > 0)     rows.push(row('fa-hourglass-half', '~' + formatDuration(dur), ''));
  if (vram > 0)    rows.push(row('fa-memory',     (vram / 1024).toFixed(1) + ' GB VRAM', 'warn'));
  if (isInfra)     rows.push(row('fa-cog',        'no GPU — infra task', 'dim'));

  const typeColor = TASK_COLORS[type] || '#64748b';
  document.getElementById('tooltipType').innerHTML =
    type ? `<span style="color:${typeColor}">${type.toUpperCase()}</span>` : '';
  document.getElementById('tooltipName').textContent = name;
  document.getElementById('tooltipRows').innerHTML = rows.join('');
  document.getElementById('tooltip').classList.add('visible');
  document.getElementById('tooltip').setAttribute('aria-hidden', 'false');
  moveTooltip(e);
}

function row(icon, text, cls) {
  return `<div class="cs-tooltip-row"><i class="fas ${icon}"></i><span class="${cls}">${esc(text)}</span></div>`;
}

function hideTooltip() {
  const tooltip = document.getElementById('tooltip');
  tooltip.classList.remove('visible');
  tooltip.setAttribute('aria-hidden', 'true');
  tooltipAnchor?.removeAttribute('aria-describedby');
  tooltipAnchor = null;
}
function moveTooltip(e) {
  const t = document.getElementById('tooltip');
  const rect = (e.currentTarget || tooltipAnchor)?.getBoundingClientRect();
  if (!rect) return;
  const margin = 12;
  const pointer = e.type === 'mouseenter' || e.type === 'mousemove';
  let left = pointer ? e.clientX + 14 : rect.left;
  let top = pointer ? e.clientY + 14 : rect.bottom + 10;
  left = Math.max(margin, Math.min(left, window.innerWidth - t.offsetWidth - margin));
  if (top + t.offsetHeight > window.innerHeight - margin) top = rect.top - t.offsetHeight - 10;
  top = Math.max(margin, top);
  t.style.left = left + 'px';
  t.style.top  = top  + 'px';
}

// ── Next Up ─────────────────────────────────────────────────

async function loadNextTasks() {
  const container = document.getElementById('nextList');
  nextTasksData = buildUpcomingTasksFromTimeline(upcomingTimelineEntries);
  renderNextTasks(container);
  startCountdown();
}

function renderNextTasks(container) {
  if (nextTasksData.length === 0) {
    container.innerHTML = isPastDate()
      ? '<div class="cs-empty">This day is over; no upcoming tasks remain.</div>'
      : '<div class="cs-empty">No upcoming tasks</div>';
    return;
  }

  // Split: system ticks (high-frequency interval pollers < 1h) vs scheduled jobs (cron or long interval)
  const sysTasks = nextTasksData.filter(t => isServiceTick(t));
  const scheduledTasks = nextTasksData.filter(t => !isServiceTick(t));

  let html = '';

  if (scheduledTasks.length > 0) {
    html += `<div class="cs-next-section">Scheduled Jobs <span class="cs-next-section-meta">${scheduledTasks.length}</span></div>`;
    html += scheduledTasks.map(task => renderNextItem(task, nextTasksData.indexOf(task))).join('');
  }

  if (sysTasks.length > 0) {
    const due = sysTasks.filter(t => t.msFromNow <= 0).length;
    const dueSoon = sysTasks.filter(t => t.msFromNow > 0 && t.msFromNow < 300000).length;
    const upcomingOccurrences = sysTasks.reduce((total, task) => total + (task.occurrenceCount || 1), 0);
    html += `<div class="cs-next-section cs-next-section-split">
      System Ticks
      <span class="cs-next-section-meta"> ${sysTasks.length} job${sysTasks.length === 1 ? '' : 's'} · ${upcomingOccurrences} upcoming run${upcomingOccurrences === 1 ? '' : 's'}</span>
      ${due > 0 ? `<span class="cs-next-section-meta"> · ${due} due now</span>` : ''}
      ${dueSoon > 0 ? `<span class="cs-next-section-meta"> · ${dueSoon} in &lt;5m</span>` : ''}
    </div>`;
    html += sysTasks.map(task => renderNextItem(task, nextTasksData.indexOf(task))).join('');
  }

  container.innerHTML = html || '<div class="cs-empty">No upcoming tasks</div>';
}

function renderNextItem(task, i) {
  const sourceMeta = getSourceMeta(task.source, task.metadata);
  const sourceClass = task.source || 'agentx';
  const hostLabel = task.host ? getHostMeta(task.host).label : '';
  const cadenceLabel = isServiceTick(task) ? getCadenceLabel(task) : '';
  return `
    <div class="cs-next-item">
      <div style="min-width:0;flex:1">
        <div class="cs-next-name">${esc(task.name)}</div>
        <div class="cs-next-meta">
          <span class="cs-task-badge ${task.taskType}">${task.taskType}</span>
          ${hostLabel ? `<span style="font-size:10px"><i class="fas fa-server" style="font-size:8px;margin-right:2px"></i>${esc(hostLabel)}</span>` : ''}
          <span class="cs-source-chip ${sourceClass}" title="${esc(task.lastRun ? `Last run ${task.metadata?.lastStatus || 'unknown'} ${formatEvidenceTime(task.lastRun)}` : 'Planned run; no run recorded yet')}">${esc(sourceMeta.label)}</span>
          ${cadenceLabel ? `<span class="cs-source-chip cadence">${esc(cadenceLabel)}</span>` : ''}
          ${task.occurrenceLabel ? `<span class="cs-source-chip cadence">${esc(task.occurrenceLabel)}</span>` : ''}
        </div>
      </div>
      <div class="cs-next-countdown" id="countdown-${i}">${formatUpcomingDisplay(task)}</div>
    </div>`;
}

function formatClockTime(value) {
  return new Date(value).toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const startedAt = Date.now();
  countdownTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    nextTasksData.forEach((task, i) => {
      const el = document.getElementById(`countdown-${i}`);
      if (!el) return;
      if (task.running || task.displayMode === 'time') {
        el.textContent = formatUpcomingDisplay(task);
        return;
      }
      el.textContent = formatCountdown(Math.max(0, task.msFromNow - elapsed));
    });
  }, COUNTDOWN_TICK_MS);
}

function buildUpcomingTasksFromTimeline(entries) {
  return UPCOMING_PROJECTION.buildUpcomingTasks(entries, {
    now: Date.now(),
    todaySelected: isToday(),
    formatTime: value => formatTime(new Date(value)),
    maxItems: 25
  });
}

function formatUpcomingDisplay(task) {
  if (task.running) return 'Running';
  if (task.displayMode === 'time') return task.displayText || '';
  return formatCountdown(task.msFromNow);
}

// ── Utilities ───────────────────────────────────────────────

function esc(s) {
  return window.AgentXUtils.escapeHtml(s);
}
function formatTime(date) {
  return date.toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function formatEvidenceTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'at an unknown time';
  return date.toLocaleString(UI_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
}
function formatDuration(ms) {
  if (!ms || ms <= 0) return 'n/a';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m > 0 ? m + 'm' : ''}`.trim();
  if (m > 0) return `${m}m`;
  if (s > 0) return `${s}s`;
  return `${Math.round(ms / 60000)}m`;
}
function formatInterval(ms) {
  if (!ms || ms <= 0) return '?';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Use the declared interval or the chronological cron starts, never slot count guesses.
function getCadenceLabel(entry) {
  return UPCOMING_PROJECTION.getCadenceLabel(entry, value => formatTime(new Date(value)));
}

// Shared with the timeline's high-frequency light-job filter.
function isServiceTick(task) {
  return isHighFrequencyLightJob(task);
}

// ── Init / Refresh ──────────────────────────────────────────

async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  const icon = btn.querySelector('i');
  icon.classList.add('spinning');
  const failuresBefore = failedRequests;
  try {
    await Promise.all([
      loadLiveState(), loadTimeline(), loadConflicts(), loadClaims(), loadHeavyQueue(),
      actualView === 'heatmap' ? loadActualHeatmap() : loadActualVsPlanned()
    ]);
  } finally { icon.classList.remove('spinning'); }
  const failed = failedRequests - failuresBefore;
  if (failed > 0 && window.Toast) {
    window.Toast.warning(`Refresh incomplete: ${failed} section${failed === 1 ? '' : 's'} could not load.`);
  }
}

function startLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(() => {
    loadLiveState();
    loadClaims();
    loadHeavyQueue();
  }, LIVE_POLL_MS);
  if (timelinePollTimer) clearInterval(timelinePollTimer);
  timelinePollTimer = setInterval(refreshTimelineClock, TIMELINE_POLL_MS);
}

// Keep "now", past shading and upcoming countdowns current; follow midnight
// when the operator was watching today.
function refreshTimelineClock() {
  const today = SCHEDULE_DATE.localDateKey(new Date(), OPERATOR_TIME_ZONE);
  const wasToday = currentDate === lastObservedToday;
  lastObservedToday = today;
  if (wasToday && currentDate !== today) {
    currentDate = today;
    updateDateLabel();
  } else if (!isToday()) {
    return;
  }
  hideTooltip();
  loadTimeline();
  loadConflicts();
}

document.addEventListener('DOMContentLoaded', () => {
  updateDateLabel();
  syncTimelineFilterUI();
  refreshAll();
  startLivePolling();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.cs-timeline-detail')) hideTooltip();
  const popover = document.getElementById('servicePopover');
  if (!popover || !popover.classList.contains('visible') || !servicePopoverPinnedId) return;
  if (e.target.closest('.cs-service-chip') || e.target.closest('#servicePopover')) return;
  hideServicePopover(true);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideTooltip(); hideServicePopover(true); }
});

window.addEventListener('resize', () => {
  const mobile = window.innerWidth <= 700;
  if (mobile !== lastTimelineMobile) {
    lastTimelineMobile = mobile;
    if (renderedTimelineMode === viewMode) {
      hideTooltip();
      const container = document.getElementById('heatmapContainer');
      if (viewMode === 'host') renderHostHeatmap(container, visibleTimelineHosts);
      else renderGroupedHeatmap(container, visibleTimelineEntries);
    }
  }
  if (!servicePopoverPinnedId) return;
  const activeChip = document.querySelector(`.cs-service-chip[data-service-id="${servicePopoverPinnedId}"]`);
  if (activeChip) positionServicePopover(activeChip);
});
