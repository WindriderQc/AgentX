/* Cluster Schedule attention list. Loaded after the dashboard controller. */

// ── Attention Tab ───────────────────────────────────────────

function renderAttention() {
  renderConflictBanner();
  const container = document.getElementById('attentionList');
  const items = [];

  // One row per job set that overflows a host's VRAM; repeated windows are counted.
  for (const conflict of summarizeConflicts(conflictsData)) {
    items.push({ type: 'error', icon: 'fa-bolt', label: 'VRAM overflow',
      detail: describeConflict(conflict) });
  }

  for (const host of liveHostsData) {
    if (host.status === 'online') continue;
    items.push({ type: 'error', icon: 'fa-server', label: `${host.name || host.id || 'Host'} unreachable`, detail: 'Host is not responding to Ollama API polling' });
  }

  for (const entry of overdueData) {
    items.push({ type: 'warn', icon: 'fa-clock', label: `${entry.name} overdue`,
      detail: `Expected at ${formatClockTime(entry.expectedAt)}; last recorded run ${formatEvidenceTime(entry.lastRun)}` });
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div style="padding:12px 4px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <i class="fas fa-check-circle" style="color:#22c55e;font-size:16px"></i>
          <span style="font-size:13px;font-weight:600;color:#22c55e">No issues detected</span>
        </div>
        <div style="font-size:11px;color:#374151;display:flex;flex-direction:column;gap:4px">
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>0 projected VRAM overflows</div>
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>0 overdue tasks with run evidence</div>
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>All reachable hosts online</div>
        </div>
      </div>`;
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

function renderConflictBanner() {
  const banner = document.getElementById('conflictBanner');
  const text = document.getElementById('conflictText');
  if (!banner || !text) return;
  const unique = summarizeConflicts(conflictsData).map(describeConflict);
  if (!unique.length) {
    banner.classList.add('hidden');
    return;
  }
  text.textContent = `${unique.length} projected VRAM overflow${unique.length > 1 ? 's' : ''}: ${unique.slice(0, 3).join('; ')}${unique.length > 3 ? ` (+${unique.length - 3} more)` : ''}`;
  banner.classList.remove('hidden');
}

function summarizeConflicts(conflicts) {
  const groups = new Map();
  for (const conflict of (conflicts || [])) {
    const tasks = conflict.tasks || [];
    const jobs = [...new Set(tasks.filter(task => !task.resident).map(task => task.name))].sort();
    const residents = [...new Set(tasks.filter(task => task.resident).map(task => task.name))].sort();
    const key = [conflict.hostId, ...jobs].join('\u0000');
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.requiredVramMb = Math.max(existing.requiredVramMb, conflict.requiredVramMb || 0);
      continue;
    }
    groups.set(key, {
      jobs,
      residents,
      hostLabel: getHostMeta(conflict.hostId).label,
      requiredVramMb: conflict.requiredVramMb || 0,
      capacityVramMb: conflict.capacityVramMb || 0,
      count: 1
    });
  }
  return [...groups.values()];
}

function describeConflict(conflict) {
  const gb = mb => `${(mb / 1024).toFixed(1)} GB`;
  const residents = conflict.residents.length ? ` with resident ${conflict.residents.join(', ')}` : '';
  const windows = conflict.count > 1 ? ` (${conflict.count} windows)` : '';
  return `${conflict.jobs.join(' + ')}${residents} need ${gb(conflict.requiredVramMb)} of ${gb(conflict.capacityVramMb)} on ${conflict.hostLabel}${windows}`;
}
