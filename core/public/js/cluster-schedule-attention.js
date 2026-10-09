/* Cluster Schedule attention list. Loaded after the dashboard controller. */

// ── Attention Tab ───────────────────────────────────────────

function renderAttention() {
  const container = document.getElementById('attentionList');
  const items = [];

  // One row per overlapping pair on a host; repeated occurrences are counted.
  for (const conflict of summarizeConflicts(conflictsData)) {
    items.push({ type: 'error', icon: 'fa-bolt', label: 'Schedule conflict',
      detail: `${conflict.nameA} overlaps ${conflict.nameB} on ${conflict.hostLabel}${conflict.count > 1 ? ` (${conflict.count} runs)` : ''}` });
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
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>0 schedule conflicts</div>
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

function summarizeConflicts(conflicts) {
  const pairs = new Map();
  for (const conflict of (conflicts || [])) {
    const names = [conflict.taskA?.name, conflict.taskB?.name].sort();
    const key = `${conflict.hostId}\u0000${names[0]}\u0000${names[1]}`;
    const existing = pairs.get(key);
    if (existing) existing.count += 1;
    else pairs.set(key, { nameA: names[0], nameB: names[1], hostLabel: getHostMeta(conflict.hostId).label, count: 1 });
  }
  return [...pairs.values()];
}
