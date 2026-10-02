/**
 * Model Profiler — live probe state, VRAM display, probe alerts and probe panel.
 */
import { esc } from './hosts-format.js';

function getProbeState(state, hostId) {
  state.liveProbeStatus = state.liveProbeStatus || {};
  return state.liveProbeStatus[hostId] || null;
}

function setProbeState(state, hostId, data) {
  state.liveProbeStatus = state.liveProbeStatus || {};
  state.liveProbeStatus[hostId] = data;
}

function fmtMiB(mib) {
  if (mib == null) return '—';
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MiB`;
}

function getHostVramDisplay(host, probeState) {
  const baselineUsed = host.gpu?.vramUsedMiB || host.baseline?.vramUsedMiB || 0;
  const telemetry = probeState?.telemetry || {};
  const source = String(telemetry.source || '');
  const liveTotal = Number(telemetry.vramTotalMiB || 0);
  const liveUsed = Number(telemetry.vramUsedMiB || 0);
  const used = liveUsed || baselineUsed;

  if (liveTotal > 0) {
    return {
      total: liveTotal,
      used,
      stat: fmtMiB(liveTotal),
      totalLabel: `${fmtMiB(liveTotal)} live`,
      usedLabel: `${fmtMiB(used)} used`,
      title: `${fmtMiB(used)} / ${fmtMiB(liveTotal)} (${source || 'configured profile'})`
    };
  }

  if (liveUsed > 0) {
    return {
      total: 0,
      used: liveUsed,
      stat: 'N/D',
      totalLabel: 'N/D total',
      usedLabel: `${fmtMiB(liveUsed)} loaded`,
      title: 'Ollama reports loaded VRAM; configure the host profile to record total VRAM.'
    };
  }

  return {
    total: 0,
    used: 0,
    stat: 'N/D',
    totalLabel: 'N/D total',
    usedLabel: '— live used',
    title: 'No running-model VRAM or configured total is available.'
  };
}

function formatProbeVram(telemetry) {
  const used = telemetry.vramUsedMiB != null ? fmtMiB(telemetry.vramUsedMiB) : null;
  const total = telemetry.vramTotalMiB != null ? fmtMiB(telemetry.vramTotalMiB) : null;
  if (used && total) return `${used} / ${total}`;
  if (used) return `${used} loaded / N/D total`;
  return 'N/D';
}

function probePill(label, ok, detail) {
  const cls = ok ? 'mp-probe-pill mp-probe-pill--ok' : 'mp-probe-pill mp-probe-pill--warn';
  return `<span class="${cls}"><strong>${esc(label)}</strong>${detail ? ` ${esc(detail)}` : ''}</span>`;
}

function uniqueProbeMessages(messages) {
  const seen = new Set();
  return messages
    .map(msg => String(msg || '').trim())
    .filter((msg) => {
      if (!msg || seen.has(msg)) return false;
      seen.add(msg);
      return true;
    });
}

function buildProbeAlerts({ telemetry }) {
  const diagnostics = telemetry?.diagnostics || {};
  const notes = Array.isArray(diagnostics.notes) ? diagnostics.notes : [];
  const alerts = [];

  if (telemetry?.actionRequired && telemetry?.error) {
    alerts.push({
      tone: 'critical',
      title: 'Telemetry action required',
      detail: telemetry.error
    });
  }

  const fallbackSource = String(telemetry?.source || '');
  if (fallbackSource === 'core-db-override' || fallbackSource === 'static-profile' || fallbackSource === 'ollama-ps') {
    alerts.push({
      tone: 'warn',
      title: 'Using fallback telemetry',
      detail: `Source is ${fallbackSource}; the product reports only Ollama runtime data and explicitly configured host metadata.`
    });
  }

  for (const note of uniqueProbeMessages(notes)) {
    if (note === telemetry?.error) continue;
    alerts.push({
      tone: /reported vram|pressure/i.test(note) ? 'warn' : 'info',
      title: 'Hardware note',
      detail: note
    });
  }

  return alerts;
}

function renderProbeAlerts(alerts) {
  if (!alerts.length) return '';
  return `<div class="mp-probe-alerts">
    ${alerts.map(alert => `<div class="mp-probe-alert mp-probe-alert--${esc(alert.tone)}">
      <strong>${esc(alert.title)}</strong>
      <span>${esc(alert.detail)}</span>
    </div>`).join('')}
  </div>`;
}

function renderProbePanel(result) {
  if (!result) {
    return `<div class="mp-probe-panel"><div class="mp-probe-title">Live probes <span>Checking runtime...</span></div></div>`;
  }
  if (result.loading) {
    return `<div class="mp-probe-panel"><div class="mp-probe-title">Live probes <span>Checking runtime...</span></div></div>`;
  }
  if (result.error) {
    return `<div class="mp-probe-panel mp-probe-panel--error">
      <div class="mp-probe-title">Live probes <span>Error</span></div>
      <div class="mp-probe-error">${esc(result.error)}</div>
    </div>`;
  }

  const telemetry = result.telemetry || {};
  const ollama = result.ollama || {};
  const statusLabel = result.status === 'ready' ? 'Ready' : result.status === 'offline' ? 'Offline' : 'Partial';
  const vram = formatProbeVram(telemetry);
  const running = Array.isArray(telemetry.runningModels) && telemetry.runningModels.length
    ? telemetry.runningModels.map(m => m.name).slice(0, 3).join(', ')
    : 'none';
  const alerts = buildProbeAlerts({ telemetry });
  const panelClass = alerts.some(alert => alert.tone === 'critical')
    ? 'mp-probe-panel mp-probe-panel--critical'
    : alerts.length ? 'mp-probe-panel mp-probe-panel--warn'
    : 'mp-probe-panel';

  return `<div class="${panelClass}">
    <div class="mp-probe-title">Live probes <span>${esc(statusLabel)}</span></div>
    <div class="mp-probe-pills">
      ${probePill('Ollama', !!ollama.ok, ollama.ok ? `${ollama.modelCount || 0} models` : (ollama.error || 'unreachable'))}
      ${probePill('GPU', !!telemetry.ok, telemetry.ok ? `${telemetry.source || 'live'} ${vram}` : 'no telemetry')}
    </div>
    ${renderProbeAlerts(alerts)}
    <div class="mp-probe-grid">
      <div><span>Host</span><strong>${esc(result.hostUrl || '—')}</strong></div>
      <div><span>GPU</span><strong>${esc(telemetry.gpuName || telemetry.source || '—')}</strong></div>
      <div><span>Util</span><strong>${telemetry.utilization == null ? '—' : `${telemetry.utilization}%`}</strong></div>
      <div><span>Running</span><strong>${esc(running)}</strong></div>
    </div>
  </div>`;
}

export { getHostVramDisplay, getProbeState, renderProbePanel, setProbeState };
