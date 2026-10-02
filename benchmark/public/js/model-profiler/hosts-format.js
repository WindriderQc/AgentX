/**
 * Model Profiler — host formatting helpers and the Host Fit report.
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function vramMibToGb(mib) {
  if (!mib) return '—';
  return (mib / 1024).toFixed(1) + ' GB';
}

function normalizeGpuName(name) {
  return String(name || '')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .trim();
}

function getHostIdentityName(host) {
  return host.displayName || host.hostId || 'host';
}

function summarizeGpuNames(gpus, fallbackName) {
  const names = (Array.isArray(gpus) ? gpus : [])
    .map(gpu => normalizeGpuName(gpu.name || gpu.gpuName))
    .filter(Boolean);
  if (!names.length && fallbackName) names.push(normalizeGpuName(fallbackName));
  if (!names.length) return '';

  const counts = new Map();
  names.forEach(name => counts.set(name, (counts.get(name) || 0) + 1));
  return Array.from(counts.entries())
    .map(([name, count]) => count > 1 ? `${count} x ${name}` : name)
    .join(' + ');
}

function getHostHardwareSummary(host, probeState) {
  const telemetry = probeState?.telemetry || {};
  const gpus = Array.isArray(telemetry.gpus) && telemetry.gpus.length
    ? telemetry.gpus
    : (Array.isArray(host.gpus) ? host.gpus : []);
  const gpuLabel = summarizeGpuNames(gpus, telemetry.gpuName);
  const liveTotal = Number(telemetry.vramTotalMiB || 0);
  const staticTotal = Number(host.gpu?.vramTotalMiB || host.baseline?.vramTotalMiB || 0);
  const total = liveTotal || staticTotal;

  if (gpuLabel && total) return `${gpuLabel} · ${vramMibToGb(total)}${liveTotal ? ' live' : ''}`;
  if (gpuLabel) return gpuLabel;
  if (total) return `${vramMibToGb(total)} VRAM`;
  return '';
}

function isHostOnline(host, probeState) {
  if (probeState && !probeState.loading && !probeState.error) {
    if (probeState.status === 'ready') return true;
    if (probeState.ollama?.ok) return true;
    if (probeState.status === 'offline') return false;
  }
  return host.status === 'online';
}

function fmtToks(n) {
  if (n == null) return '—';
  return Number(n).toFixed(1) + ' tok/s';
}

function relTime(ts) {
  if (!ts) return 'just now';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'recently';
  const diff = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Fit Report rendering ─────────────────────────────────────────────────
function fmtCtx(n) {
  if (!n) return '—';
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function fitToneClass(tone) {
  return tone === 'crit' ? 'mp-fit-badge--crit' : tone === 'warn' ? 'mp-fit-badge--warn' : 'mp-fit-badge--ok';
}

function estVerdictBadge(v) {
  const map = {
    'fits':      ['mp-fit-badge--ok',   'fits'],
    'tight':     ['mp-fit-badge--warn', 'tight'],
    'too-large': ['mp-fit-badge--crit', 'too large'],
    'unknown':   ['mp-fit-badge--muted','unknown']
  };
  const [cls, label] = map[v] || map.unknown;
  return `<span class="mp-fit-badge ${cls}">${esc(label)}</span>`;
}

const FIT_USE_CASES = ['general', 'coding', 'reasoning', 'chat', 'long-context'];

function fitComposite(dims, weights) {
  if (!dims || !weights) return null;
  let sum = 0, wsum = 0;
  for (const k of ['quality', 'speed', 'fit', 'context']) {
    if (dims[k] != null && weights[k] != null) { sum += weights[k] * dims[k]; wsum += weights[k]; }
  }
  return wsum > 0 ? Math.round(sum / wsum) : null;
}

function fitCompChip(score) {
  if (score == null) return '';
  const tone = score >= 75 ? 'mp-fit-comp--hi' : score >= 50 ? 'mp-fit-comp--mid' : 'mp-fit-comp--lo';
  return `<span class="mp-fit-comp ${tone}" title="advisory heuristic fit score; not model-quality evidence">⬡${score}</span>`;
}

function fitMoeChip(m) {
  if (!m.moeActiveB) return '';
  return `<span class="mp-fit-moe" title="Mixture-of-Experts: ${m.moeActiveB}B active of ${m.paramB || '?'}B total — speed estimated from active params">MoE ${m.moeActiveB}B</span>`;
}

function renderFitReport(report, useCase) {
  if (!report || !report.host) return '<div class="mp-fit-empty">No report data.</div>';
  useCase = FIT_USE_CASES.includes(useCase) ? useCase : 'general';
  const h = report.host;
  const cap = report.capacity || {};
  const vram = report.vram || {};
  const rec = report.recommended;
  const recB = report.recommendedBenchmarked;
  const tm = report.throughputModel || {};
  const weights = (report.useCaseWeights || {})[useCase] || (report.useCaseWeights || {}).general || null;
  const vramStr = vram.totalMiB ? `${(vram.totalMiB / 1024).toFixed(1)} GB` : 'unknown';

  const pcie = (h.pcieGen && h.pcieWidth) ? `PCIe Gen${h.pcieGen} ×${h.pcieWidth}` : null;
  const baseStr = h.baseline
    ? `${h.baseline.tokensPerSec} tok/s · ${esc(h.baseline.referenceModel || 'baseline')}`
    : 'not tested';
  const headChips = [
    h.gpuName ? `<span class="mp-fit-chip"><b>${esc(h.gpuName)}</b></span>` : '',
    `<span class="mp-fit-chip">VRAM <b>${vramStr}</b> <span class="mp-fit-dim">${esc(vram.source || '')}</span></span>`,
    pcie ? `<span class="mp-fit-chip">${esc(pcie)}</span>` : '',
    h.cpuCores ? `<span class="mp-fit-chip">${h.cpuCores} cores</span>` : '',
    `<span class="mp-fit-chip">baseline <b>${esc(baseStr)}</b></span>`
  ].filter(Boolean).join('');

  const ucSelect = `<label class="mp-fit-uc"><span>optimize for</span><select class="mp-fit-usecase">${
    FIT_USE_CASES.map(u => `<option value="${u}"${u === useCase ? ' selected' : ''}>${u}</option>`).join('')
  }</select></label>`;

  const capBits = [
    `<b>${cap.installedCount || 0}</b> installed`,
    `<b>${cap.measuredCount || 0}</b> measured`,
    `<b>${cap.fitClean || 0}</b> clean`,
    cap.spills ? `<span class="mp-fit-warn"><b>${cap.spills}</b> spill</span>` : '',
    cap.largestRunnableParamsB ? `largest runnable <b>~${cap.largestRunnableParamsB}B</b> @Q4/8k` : ''
  ].filter(Boolean).join(' · ');

  // Composite per row, then sort copies by composite desc (nulls last).
  const withComp = list => (list || [])
    .map(m => ({ ...m, _comp: fitComposite(m.dims, weights) }))
    .sort((a, b) => (b._comp ?? -1) - (a._comp ?? -1) || (b.paramB || 0) - (a.paramB || 0));
  const measuredM = withComp(report.measured);
  const estimatedM = withComp(report.estimated);
  const bestFor = measuredM.find(m => m._comp != null) || null;

  let recHtml;
  if (rec) {
    const benchLine = (recB && recB.modelName !== rec.modelName)
      ? `<div class="mp-fit-rec__alt"><span class="mp-fit-rec__alt-star">✦</span> best benchmarked: <b>${esc(recB.modelName)}</b> <span class="mp-fit-dim">— ${esc(recB.reason)}</span></div>`
      : '';
    const ucLine = bestFor
      ? `<div class="mp-fit-rec__alt"><span class="mp-fit-rec__alt-star mp-fit-rec__alt-star--uc">⬡</span> best for <b>${esc(useCase)}</b>: <b>${esc(bestFor.modelName)}</b> <span class="mp-fit-dim">— score ${bestFor._comp}</span></div>`
      : '';
    recHtml = `<div class="mp-fit-rec"><span class="mp-fit-rec__star">★</span><div>
        <div class="mp-fit-rec__name">${esc(rec.modelName)}</div>
        <div class="mp-fit-rec__why">${esc(rec.reason)} <span class="mp-fit-dim">— advisory heuristic, not quality proof</span></div>
        ${ucLine}${benchLine}</div></div>`;
  } else {
    recHtml = `<div class="mp-fit-rec mp-fit-rec--none">No measured model yet — profile a model on this host to get a recommendation.</div>`;
  }

  const measuredRows = measuredM.map(m => {
    const rel = m.reliability ? `<span class="mp-fit-sub">${esc(m.reliability)}</span>` : '';
    const loadTip = [
      m.spillVerified !== true ? 'GPU residency unknown' : (m.spillDetected ? `spills at ${m.spillNumCtx || '?'}` : 'no spill verified'),
      m.coldLoadMs != null ? `cold load ${m.coldLoadMs}ms` : '',
      m.hotLoadMs != null ? `hot load ${m.hotLoadMs}ms` : '',
      m.modelVramMiB != null ? `${(m.modelVramMiB / 1024).toFixed(1)}GB on GPU` : ''
    ].filter(Boolean).join(' · ');
    let vramCell = '—';
    if (m.vramPct != null) {
      const pct = Math.min(100, m.vramPct);
      const barTone = m.vramPct > 90 ? 'mp-fit-bar__fill--crit' : m.vramPct > 75 ? 'mp-fit-bar__fill--warn' : 'mp-fit-bar__fill--ok';
      vramCell = `<div class="mp-fit-bar" title="${m.vramPct}% of ${vramStr} VRAM"><div class="mp-fit-bar__fill ${barTone}" style="width:${pct}%"></div></div><span class="mp-fit-bar__label">${m.vramPct}%</span>`;
    }
    return `<tr>
      <td class="mp-fit-name">${fitCompChip(m._comp)}${esc(m.modelName)} ${fitMoeChip(m)}</td>
      <td>${m.tokensPerSec != null ? m.tokensPerSec : '—'} ${rel}</td>
      <td class="mp-fit-vramcell">${vramCell}</td>
      <td title="max verified ${fmtCtx(m.maxVerifiedContext)}; document ${fmtCtx(m.recommendedDocumentContext)}">${fmtCtx(m.recommendedInteractiveContext)}</td>
      <td><span class="mp-fit-badge ${fitToneClass(m.fit.tone)}" title="${esc(loadTip)}">${esc(m.fit.label)}</span></td>
    </tr>`;
  }).join('');
  const measuredTable = measuredRows
    ? `<table class="mp-fit-table"><thead><tr><th>Profiled model</th><th>tok/s</th><th>VRAM</th><th>interactive ctx</th><th>fit</th></tr></thead><tbody>${measuredRows}</tbody></table>`
    : '<div class="mp-fit-empty">No models profiled on this host yet.</div>';

  let calib;
  if (tm.source === 'profiles') {
    calib = `calibrated from ${tm.nPoints} profile${tm.nPoints === 1 ? '' : 's'} · ${esc(tm.confidence)} confidence${tm.calibrationErrorPct != null ? ` · ±${tm.calibrationErrorPct}%` : ''}`;
  } else if (tm.source === 'baseline') {
    calib = `from host baseline — profile models to calibrate`;
  } else {
    calib = `generic estimate — no profiles on this host yet`;
  }

  const estRows = estimatedM.map(e => `
    <tr>
      <td class="mp-fit-name">${fitCompChip(e._comp)}${esc(e.modelName)} ${fitMoeChip(e)}</td>
      <td>${e.estTokensPerSec != null ? '~' + e.estTokensPerSec : '—'}</td>
      <td>${estVerdictBadge(e.verdict)}</td>
      <td>${fmtCtx(e.estMaxCtx)}</td>
      <td>${e.recommendedQuant ? `<span class="mp-fit-dim">try </span>${esc(e.recommendedQuant)}` : '—'}</td>
    </tr>`).join('');
  const estTable = estRows
    ? `<table class="mp-fit-table mp-fit-table--est"><thead><tr><th>Unprofiled model</th><th>~tok/s</th><th>fit</th><th>max ctx</th><th>rec. quant</th></tr></thead><tbody>${estRows}</tbody></table>`
    : '';

  return `<div class="mp-fit-report">
    <div class="mp-fit-toolbar"><div class="mp-fit-head">${headChips}</div>${ucSelect}</div>
    <div class="mp-fit-cap">${capBits}</div>
    ${recHtml}
    <div class="mp-fit-section-label">Measured runtime fit <span class="mp-fit-dim">— exact runtime profiles · ⬡ = advisory "${esc(useCase)}" heuristic</span></div>
    ${measuredTable}
    ${estTable ? `<div class="mp-fit-section-label">Estimated fit <span class="mp-fit-dim">— ${calib}</span></div>${estTable}` : ''}
    <div class="mp-fit-foot">Generated ${esc(relTime(report.generatedAt))} · Host Fit is advisory and never semantic quality evidence · ⬡ combines available benchmark summary or parameter/quant heuristic with speed, fit, and context for "${esc(useCase)}" · MoE speed from active params</div>
  </div>`;
}

export { esc, fmtToks, getHostHardwareSummary, getHostIdentityName, isHostOnline, relTime, renderFitReport };
