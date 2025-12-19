async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await resp.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_e) {
    payload = { status: 'error', message: text };
  }

  if (!resp.ok) {
    const msg = payload && payload.message ? payload.message : `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderLines(el, lines) {
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}

let dataapiBaseUrl = null;
let activeScanId = null;
let scanPollTimer = null;

async function loadInfo() {
  const info = await api('/api/dataapi/info');
  dataapiBaseUrl = info?.data?.baseUrl || null;
}

async function refreshScans() {
  const scansEl = document.getElementById('scansList');
  const statusEl = document.getElementById('scanStatus');
  statusEl.textContent = 'Loading scans…';

  const out = await api('/api/dataapi/storage/scans?limit=10&skip=0');
  const scans = out?.data?.data?.scans || out?.data?.data?.data?.scans || out?.data?.data?.scans || [];

  if (!Array.isArray(scans) || scans.length === 0) {
    renderLines(scansEl, ['(no scans found)']);
    statusEl.textContent = 'Ready.';
    return;
  }

  renderLines(
    scansEl,
    scans.map((s) => {
      const id = esc(s._id || s.scan_id || '');
      const st = esc(s.status || '');
      const roots = Array.isArray(s.roots) ? s.roots.join(', ') : '';
      const counts = s.counts ? ` files=${s.counts.files_seen ?? '?'} upserts=${s.counts.upserts ?? '?'}` : '';
      return `<button class="chip" data-scan-id="${id}" style="margin-right:6px;">${id}</button> ${st}${counts} <span style="opacity:.7">${esc(roots)}</span>`;
    })
  );

  scansEl.querySelectorAll('[data-scan-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-scan-id');
      if (!id) return;
      await setActiveScan(id);
    });
  });

  statusEl.textContent = 'Ready.';
}

async function setActiveScan(id) {
  activeScanId = id;
  document.getElementById('activeScanId').textContent = id;
  document.getElementById('stopScanBtn').disabled = false;
  await pollScanStatus();
  if (scanPollTimer) clearInterval(scanPollTimer);
  scanPollTimer = setInterval(pollScanStatus, 1500);
}

async function pollScanStatus() {
  if (!activeScanId) return;
  const statusEl = document.getElementById('scanStatus');
  try {
    const out = await api(`/api/dataapi/storage/status/${encodeURIComponent(activeScanId)}`);
    const d = out?.data?.data || out?.data;
    statusEl.textContent = `Status: ${d?.status || 'unknown'} | live=${String(d?.live)} | files_seen=${d?.counts?.files_seen ?? '?'} | upserts=${d?.counts?.upserts ?? '?'} | errors=${d?.counts?.errors ?? 0}`;
    if (d?.status === 'complete' || d?.status === 'stopped') {
      if (scanPollTimer) clearInterval(scanPollTimer);
    }
  } catch (e) {
    statusEl.textContent = `Status error: ${e.message}`;
  }
}

async function startScan() {
  const statusEl = document.getElementById('scanStatus');
  const rootsRaw = document.getElementById('scanRoots').value;
  const extRaw = document.getElementById('scanExt').value;
  const batchRaw = document.getElementById('scanBatch').value;

  const roots = rootsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const extensions = extRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const batch_size = batchRaw ? Number(batchRaw) : 1000;

  statusEl.textContent = 'Starting scan…';

  const out = await api('/api/dataapi/storage/scan', {
    method: 'POST',
    body: { roots, extensions, batch_size }
  });

  const scanId = out?.data?.data?.scan_id || out?.data?.data?.data?.scan_id || out?.data?.scan_id;
  if (scanId) {
    await setActiveScan(String(scanId));
    await refreshScans();
  }
  statusEl.textContent = `Scan started. scan_id=${scanId || '(unknown)'}`;
}

async function stopScan() {
  if (!activeScanId) return;
  const statusEl = document.getElementById('scanStatus');
  statusEl.textContent = 'Stopping scan…';
  await api(`/api/dataapi/storage/stop/${encodeURIComponent(activeScanId)}`, { method: 'POST' });
  await pollScanStatus();
}

async function runSearch() {
  const statusEl = document.getElementById('filesStatus');
  const resultsEl = document.getElementById('filesResults');
  const q = document.getElementById('searchQuery').value.trim();
  if (!q) {
    statusEl.textContent = 'Enter a query.';
    return;
  }

  statusEl.textContent = 'Searching…';
  const out = await api(`/api/dataapi/files/search?q=${encodeURIComponent(q)}&limit=50&skip=0`);
  const results = out?.data?.data?.results || out?.data?.data?.data?.results || [];
  const total = out?.data?.data?.pagination?.total ?? out?.data?.data?.data?.pagination?.total;

  if (!Array.isArray(results) || results.length === 0) {
    renderLines(resultsEl, ['(no matches)']);
    statusEl.textContent = 'Done.';
    return;
  }

  renderLines(
    resultsEl,
    results.map((f) => {
      const p = esc(f.path || f._id || '');
      const sz = esc(f.sizeFormatted || f.size || '');
      const mt = esc(f.mtime || '');
      return `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${p}</span> <span style="opacity:.7">(${sz})</span> <span style="opacity:.5">${mt}</span>`;
    })
  );

  statusEl.textContent = `Done. ${results.length}${total !== undefined ? ` / total ${total}` : ''}.`;
}

async function loadDuplicates() {
  const statusEl = document.getElementById('filesStatus');
  const resultsEl = document.getElementById('filesResults');
  statusEl.textContent = 'Loading duplicates…';

  const out = await api('/api/dataapi/files/duplicates');
  const groups = out?.data?.data?.duplicates || out?.data?.data?.data?.duplicates || [];
  const summary = out?.data?.data?.summary || out?.data?.data?.data?.summary || null;

  if (!Array.isArray(groups) || groups.length === 0) {
    renderLines(resultsEl, ['(no duplicates found)']);
    statusEl.textContent = 'Done.';
    return;
  }

  renderLines(
    resultsEl,
    groups.slice(0, 100).map((g) => {
      const name = esc(g.filename || '');
      const count = esc(g.count || '');
      const size = esc(g.sizeFormatted || '');
      const wasted = esc(g.wastedSpaceFormatted || '');
      return `${name} • x${count} • ${size} • wasted ${wasted}`;
    })
  );

  statusEl.textContent = `Done. Groups=${groups.length}${summary?.totalWastedSpaceFormatted ? ` • wasted ${summary.totalWastedSpaceFormatted}` : ''}.`;
}

async function loadStats() {
  const statusEl = document.getElementById('filesStatus');
  const resultsEl = document.getElementById('filesResults');
  statusEl.textContent = 'Loading stats…';

  const out = await api('/api/dataapi/files/stats');
  const stats = out?.data?.data || out?.data;

  renderLines(resultsEl, [`<pre style="margin:0; white-space: pre-wrap;">${esc(JSON.stringify(stats, null, 2))}</pre>`]);
  statusEl.textContent = 'Done.';
}

async function refreshExports() {
  const statusEl = document.getElementById('exportsStatus');
  const listEl = document.getElementById('exportsList');
  statusEl.textContent = 'Loading exports…';

  const out = await api('/api/dataapi/files/exports');
  const exportsArr = out?.data?.data?.exports || out?.data?.data?.data?.exports || out?.data?.exports || [];

  if (!Array.isArray(exportsArr) || exportsArr.length === 0) {
    renderLines(listEl, ['(no exports found)']);
    statusEl.textContent = 'Done.';
    return;
  }

  const base = (dataapiBaseUrl || '').replace(/\/+$/, '');

  renderLines(
    listEl,
    exportsArr.map((e) => {
      const name = esc(e.filename || e.name || '');
      const size = esc(e.sizeFormatted || e.size || '');
      const ts = esc(e.created || e.created_at || '');
      const href = base ? `${base}/exports/${encodeURIComponent(name)}` : null;
      const link = href ? `<a class="ghost small" href="${esc(href)}" target="_blank" rel="noreferrer">Download</a>` : '';
      return `${name} <span style="opacity:.7">(${size})</span> <span style="opacity:.5">${ts}</span> ${link}`;
    })
  );

  statusEl.textContent = 'Done.';
}

async function refreshLive() {
  const statusEl = document.getElementById('liveStatus');
  const resultsEl = document.getElementById('liveResults');
  statusEl.textContent = 'Loading live data…';

  const [issOut, quakesOut] = await Promise.all([
    api('/api/dataapi/live/iss'),
    api('/api/dataapi/live/quakes')
  ]);

  const issRows = Array.isArray(issOut?.data?.data) ? issOut.data.data : (Array.isArray(issOut?.data) ? issOut.data : []);
  const quakeRows = Array.isArray(quakesOut?.data?.data) ? quakesOut.data.data : (Array.isArray(quakesOut?.data) ? quakesOut.data : []);

  const issPreview = issRows[0] ? JSON.stringify(issRows[0]) : null;
  const quakePreview = quakeRows[0] ? JSON.stringify(quakeRows[0]) : null;

  renderLines(resultsEl, [
    `ISS records: ${issRows.length}`,
    issPreview ? `<pre style="margin:0; white-space: pre-wrap; opacity:.8;">${esc(issPreview)}</pre>` : '(no ISS records)',
    '',
    `Quakes records: ${quakeRows.length}`,
    quakePreview ? `<pre style="margin:0; white-space: pre-wrap; opacity:.8;">${esc(quakePreview)}</pre>` : '(no Quake records)'
  ]);

  statusEl.textContent = 'Done.';
}

function wire() {
  document.getElementById('refreshScansBtn').addEventListener('click', () => refreshScans().catch((e) => (document.getElementById('scanStatus').textContent = e.message)));
  document.getElementById('startScanBtn').addEventListener('click', () => startScan().catch((e) => (document.getElementById('scanStatus').textContent = e.message)));
  document.getElementById('stopScanBtn').addEventListener('click', () => stopScan().catch((e) => (document.getElementById('scanStatus').textContent = e.message)));

  document.getElementById('searchBtn').addEventListener('click', () => runSearch().catch((e) => (document.getElementById('filesStatus').textContent = e.message)));
  document.getElementById('loadDuplicatesBtn').addEventListener('click', () => loadDuplicates().catch((e) => (document.getElementById('filesStatus').textContent = e.message)));
  document.getElementById('loadStatsBtn').addEventListener('click', () => loadStats().catch((e) => (document.getElementById('filesStatus').textContent = e.message)));

  document.getElementById('refreshExportsBtn').addEventListener('click', () => refreshExports().catch((e) => (document.getElementById('exportsStatus').textContent = e.message)));
  document.getElementById('refreshLiveBtn').addEventListener('click', () => refreshLive().catch((e) => (document.getElementById('liveStatus').textContent = e.message)));
}

(async function init() {
  wire();
  try {
    await loadInfo();
  } catch (_e) {
    // ignore - download links will be hidden
  }

  // eager load lightweight panels
  refreshScans().catch(() => {});
  refreshExports().catch(() => {});
  refreshLive().catch(() => {});
})();
