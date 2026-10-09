/* Cluster Schedule measured-utilization views. Loaded after the dashboard controller. */

// ── Actual Utilization ──────────────────────────────────────

function setActualView(mode) {
  actualView = mode;
  document.getElementById('btnHeatmap').classList.toggle('active', mode === 'heatmap');
  document.getElementById('btnAvp').classList.toggle('active', mode === 'avp');
  document.getElementById('btnHeatmap').setAttribute('aria-pressed', String(mode === 'heatmap'));
  document.getElementById('btnAvp').setAttribute('aria-pressed', String(mode === 'avp'));
  document.querySelector('.cs-actual-controls').style.display = mode === 'heatmap' ? '' : 'none';
  if (mode === 'heatmap') loadActualHeatmap();
  else loadActualVsPlanned();
}

function actualViewChanged() {
  if (actualView === 'heatmap') loadActualHeatmap();
  else loadActualVsPlanned();
}

// Utilization colour ramp: 0% → dim, 1-20% → green, 20-50% → lime, 50-75% → amber, 75-90% → orange, 90%+ → red
function utilColor(pct) {
  if (pct <= 0) return 'rgba(255,255,255,0.04)';
  if (pct < 20)  return '#22c55e';
  if (pct < 50)  return '#84cc16';
  if (pct < 75)  return '#f59e0b';
  if (pct < 90)  return '#f97316';
  return '#ef4444';
}

// One fill for heatmap cells and legend swatches. Alpha lives in the
// background so the percentage printed in the cell stays readable.
function utilCellBackground(pct, observed = true) {
  if (!observed) return 'rgba(255,255,255,0.02)';
  if (pct <= 0) return 'rgba(255,255,255,0.06)';
  const hex = utilColor(pct);
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const alpha = Math.max(0.25, pct / 100);
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function renderUtilLegend() {
  const bar = document.getElementById('utilLegendBar');
  if (!bar) return;
  const legend = document.getElementById('utilLegend');
  legend.style.display = 'flex';
  const stops = [0, 10, 25, 45, 65, 80, 95];
  bar.innerHTML = stops.map(p =>
    `<div class="cs-util-swatch" style="background:${utilCellBackground(p)}" title="${p}%"></div>`
  ).join('');
}

async function loadActualHeatmap() {
  const days = parseInt(document.getElementById('heatmapDays')?.value || '7', 10);
  const container = document.getElementById('actualContent');
  container.innerHTML = '<div class="cs-loading"><i class="fas fa-spinner fa-spin"></i> Loading heatmap...</div>';
  try {
    const params = new URLSearchParams({ days: String(days) });
    if (OPERATOR_TIME_ZONE) params.set('timezone', OPERATOR_TIME_ZONE);
    const hasObservedEvidence = renderUtilHeatmap(container, await fetchJSON(`${API_BASE}/schedule/heatmap?${params}`));
    if (hasObservedEvidence) renderUtilLegend();
    else document.getElementById('utilLegend').style.display = 'none';
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
    document.getElementById('utilLegend').style.display = 'none';
  }
}

function renderUtilHeatmap(container, data) {
  // hosts are identity objects keyed into grid; older payloads used strings.
  const { hosts = [], days = [], grid = {} } = data;
  if (!hosts.length || !days.length) {
    container.innerHTML = '<div class="cs-empty">No GPU usage measured yet. It appears here once inference calls are recorded.</div>';
    return false;
  }

  const hostKey = host => typeof host === 'string' ? host : host.key;
  const hasObservedEvidence = hosts.some(host => (grid[hostKey(host)] || []).some(day =>
    Array.isArray(day) && day.some(value => Number.isFinite(value))
  ));
  if (!hasObservedEvidence) {
    container.innerHTML = '<div class="cs-empty">No GPU usage measured for these days (unknown, not zero).</div>';
    return false;
  }

  let html = `<div class="cs-actual-note">Measured utilization by day and hour (${esc(data.timeZone || 'UTC')}).</div>`;
  for (const host of hosts) {
    const rows = grid[hostKey(host)] || [];
    const hostHasEvidence = rows.some(day =>
      Array.isArray(day) && day.some(value => Number.isFinite(value))
    );
    if (!hostHasEvidence) continue;

    // grid is days-major, hours-minor: rows[dayIdx][hourIdx]
    html += `<div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:600;color:#fff;margin-bottom:8px">
        <i class="fas fa-server" style="color:#7cf0ff;margin-right:6px;font-size:10px"></i>${esc(typeof host === 'string' ? host : (host.displayName || host.key))}
      </div>
      <div style="overflow-x:auto">
        <div class="cs-util-grid" style="grid-template-columns:70px repeat(24,1fr);min-width:640px;gap:2px">`;

    // Header: hour labels
    html += '<div class="cs-util-h-label"></div>';
    for (let h = 0; h < 24; h++) {
      html += `<div class="cs-util-h-label">${String(h).padStart(2, '0')}</div>`;
    }

    // Rows: one per day
    for (let di = 0; di < days.length; di++) {
      const dateLabel = SCHEDULE_DATE.formatCalendarDate(days[di], {
        locale: UI_LOCALE,
        format: { month: 'short', day: 'numeric' }
      });
      html += `<div class="cs-util-label-cell">${dateLabel}</div>`;
      const hourRow = rows[di] || new Array(24).fill(null);
      for (let h = 0; h < 24; h++) {
        const rawPct = hourRow[h];
        const observed = Number.isFinite(rawPct);
        const pct = observed ? rawPct : 0;
        const label = `${dateLabel} ${String(h).padStart(2, '0')}:00 — ${observed ? `${pct.toFixed(0)}% utilization` : 'not measured'}`;
        html += `<div class="cs-util-cell" style="background:${utilCellBackground(pct, observed)}"
          title="${label}" aria-label="${label}">${observed && pct >= 1 ? Math.round(pct) : ''}</div>`;
      }
    }

    html += '</div></div></div>';
  }

  container.innerHTML = html;
  return Boolean(html);
}

async function loadActualVsPlanned() {
  const container = document.getElementById('actualContent');
  document.getElementById('utilLegend').style.display = 'none';
  container.innerHTML = '<div class="cs-loading"><i class="fas fa-spinner fa-spin"></i> Loading actual vs planned...</div>';
  try {
    renderActualVsPlanned(container, await fetchJSON(`${API_BASE}/schedule/actual-vs-planned?${calendarQuery()}`));
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

function renderActualVsPlanned(container, data) {
  const { planned = [], actualByHost = {} } = data;
  const hasActualEvidence = Object.values(actualByHost).some(rows =>
    (rows || []).some(row => Number.isFinite(row?.utilizationPct))
  );
  const hasAssignedGpuPlan = planned.some(host => (host.tasks || []).some(task => task.model));

  if (!hasAssignedGpuPlan && !hasActualEvidence) {
    container.innerHTML = '<div class="cs-empty">No GPU jobs assigned to a host and no measured usage for this date.</div>';
    return;
  }

  let html = hasAssignedGpuPlan ? '' : '<div class="cs-empty">No GPU job is assigned to a host on this date; the measured usage below is not linked to scheduled jobs.</div>';
  const HOUR_PCT = (1 / 24 * 100).toFixed(3);

  const renderTrack = (hostName, tasks, actualRows) => {
    const actualMap = {};
    for (const r of (actualRows || [])) actualMap[r.hour] = r;

    html += `<div class="cs-avp-host">
      <div class="cs-avp-host-label">
        <i class="fas fa-server" style="color:#7cf0ff;font-size:10px"></i>
        ${esc(hostName)}
        ${tasks.length ? `<span class="cs-avp-host-meta">${tasks.length} planned task${tasks.length > 1 ? 's' : ''}</span>` : '<span class="cs-avp-host-meta warn">measured only</span>'}
      </div>
      <div class="cs-avp-track">`;

    // Grid lines at 0, 6, 12, 18, 24h
    for (let h = 0; h <= 24; h += 6) {
      const left = (h / 24 * 100).toFixed(2);
      html += `<div class="cs-avp-gridline" style="left:${left}%"></div>`;
      if (h < 24) html += `<div class="cs-avp-hour-label" style="left:calc(${left}% + 2px)">${String(h).padStart(2, '0')}</div>`;
    }

    // Actual utilization bars — bottom 50%, per-hour
    for (let h = 0; h < 24; h++) {
      const a = actualMap[h];
      if (!a || !Number.isFinite(a.utilizationPct)) continue;
      const left = (h / 24 * 100).toFixed(3);
      const color = utilColor(a.utilizationPct);
      const heightPct = Math.max(5, a.utilizationPct / 2); // max 50% of track height
      html += `<div class="cs-avp-actual" style="left:${left}%;width:${HOUR_PCT}%;height:${heightPct.toFixed(1)}%;background:${color};opacity:0.4"
        title="${String(h).padStart(2, '0')}:00 actual ${a.utilizationPct.toFixed(0)}% (${a.totalCalls || 0} call${a.totalCalls === 1 ? '' : 's'})"></div>`;
    }

    // Planned task slots — top area
    for (const task of tasks) {
      for (const slot of (task.slots || [])) {
        const s = new Date(slot.start);
        const e = new Date(slot.end);
        const startHour = s.getHours() + s.getMinutes() / 60;
        // Derive the end from the duration: a slot ending at midnight is 24h, not 0h.
        const endHour = Math.min(24, startHour + Math.max(0, e - s) / 3600000);
        const left  = (startHour / 24 * 100).toFixed(2);
        const width = Math.max((endHour - startHour) / 24 * 100, 0.4).toFixed(2);
        const color = TASK_COLORS[task.taskType] || '#666';
        html += `<div class="cs-avp-planned" style="left:${left}%;width:${width}%;top:6px;height:36%;background:${color}"
          title="${esc(task.name)} ${formatTime(s)}–${formatTime(e)}"></div>`;
      }
    }

    html += '</div></div>';
  };

  // Render planned hosts
  const plannedHostNames = new Set();
  for (const host of planned) {
    const tasks = (host.tasks || []).filter(task => task.model);
    const actualRows = actualByHost[host.hostName] || [];
    if (!tasks.length && !actualRows.length) continue;
    plannedHostNames.add(host.hostName);
    renderTrack(host.hostName, tasks, actualRows);
  }

  // Render actual-only hosts
  for (const [hostName, rows] of Object.entries(actualByHost)) {
    if (plannedHostNames.has(hostName)) continue;
    if (!rows.some(r => Number.isFinite(r?.utilizationPct))) continue;
    renderTrack(hostName, [], rows);
  }

  // Legend
  html += `<div class="cs-avp-legend">
    <div style="display:flex;align-items:center;gap:4px"><div class="cs-avp-legend-swatch" style="background:linear-gradient(90deg,${TASK_COLORS.benchmark},${TASK_COLORS.ingestion},${TASK_COLORS.inference})"></div>Planned run (top, colored by job type)</div>
    <div style="display:flex;align-items:center;gap:4px"><div class="cs-avp-legend-swatch" style="background:linear-gradient(90deg,${utilColor(10)},${utilColor(60)},${utilColor(95)});opacity:0.6"></div>Measured utilization (bottom, height and color = load)</div>
  </div>`;

  container.innerHTML = html || '<div class="cs-empty">No planned runs or measured usage for this date.</div>';
}
