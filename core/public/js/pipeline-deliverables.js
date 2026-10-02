(function () {
  'use strict';
  // Task deliverables panel for one dossier. Core owns the registry
  // (agentx.pipeline-task-deliverable-receipt/v1); this view reads it in the
  // task's own scope and keeps storage, availability and external delivery
  // apart. A listed file is "present"; only a receipt or download recomputes
  // its SHA-256, and a missing or altered file is never offered for download.
  const SHA_RE = /^[a-f0-9]{64}$/;
  const ID_RE = /^[a-f0-9]{24}$/;
  const STALE_MS = 30000;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const cache = new Map();
  const AVAILABILITY = {
    available: { icon: 'fa-circle-check', tone: 'ok', text: 'Available · SHA-256 verified' },
    present_unverified: { icon: 'fa-circle-info', tone: 'plain', text: 'Stored bytes present · digest not checked yet' },
    missing: { icon: 'fa-circle-xmark', tone: 'bad', text: 'Missing · the stored bytes are gone; not served' },
    corrupt: { icon: 'fa-triangle-exclamation', tone: 'bad', text: 'Altered · the bytes no longer match the SHA-256; not served' },
  };

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return 'unknown size';
    if (n < 1024) return `${n} B`;
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`;
  }
  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
  }
  function entry(pipelineId) {
    if (!cache.has(pipelineId)) cache.set(pipelineId, { status: 'idle', rows: [], error: null, at: 0, open: false, message: '' });
    return cache.get(pipelineId);
  }

  function availabilityRow(row) {
    const meta = AVAILABILITY[row.availability?.status];
    if (!meta) return '<dd class="pipeline-evidence-unknown">Unknown availability · not offered for download</dd>';
    const when = row.availability?.hashVerified && row.availability?.checkedAt ? ` · ${esc(formatTime(row.availability.checkedAt))}` : '';
    return `<dd class="pipeline-deliverable-${meta.tone}"><i class="fas ${meta.icon}" aria-hidden="true"></i><span>${esc(meta.text)}${when}</span></dd>`;
  }
  const servable = row => ['available', 'present_unverified'].includes(row.availability?.status);

  function card(pipelineId, row) {
    if (!ID_RE.test(String(row.id || '')) || !SHA_RE.test(String(row.sha256 || ''))) {
      return '<article class="pipeline-evidence-attempt"><p class="pipeline-evidence-unknown">Unknown deliverable · the record is malformed and is not offered.</p></article>';
    }
    const origin = row.attempt ? `Attempt ${esc(row.attempt)} · ${esc(row.producer?.declared || 'unknown worker')}` : `Operator upload · ${esc(row.producer?.declared || 'unknown')}`;
    return `<article class="pipeline-evidence-attempt pipeline-deliverable" data-deliverable="${esc(row.id)}">
      <header><strong>${esc(row.name)}</strong><span>${esc(row.mimeType)} · ${esc(formatSize(row.size))} · ${origin}</span></header>
      <dl>
        <div class="pipeline-evidence-row"><dt>SHA-256</dt><dd><code title="${esc(row.sha256)}">${esc(row.sha256.slice(0, 16))}…</code><button type="button" class="pipeline-evidence-copy" data-copy-deliverable="${esc(row.sha256)}" aria-label="Copy SHA-256 of ${esc(row.name)}"><i class="fas fa-copy" aria-hidden="true"></i><span>Copy</span></button></dd></div>
        <div class="pipeline-evidence-row"><dt>Storage</dt><dd class="pipeline-evidence-plain">${row.storage?.status === 'stored' ? `Stored in Core · ${esc(formatTime(row.storage.storedAt))}` : 'Unknown storage state'}</dd></div>
        <div class="pipeline-evidence-row"><dt>Availability</dt>${availabilityRow(row)}</div>
        <div class="pipeline-evidence-row"><dt>External delivery</dt><dd class="pipeline-evidence-plain">${row.externalDelivery?.status === 'none' ? 'None · Core does not send deliverables to a third party' : 'Unknown'}</dd></div>
        <div class="pipeline-evidence-row"><dt>Scope</dt><dd class="pipeline-evidence-plain">${esc(row.scope?.taskRef || '')} · ${esc(row.scope?.lane || 'unknown')} lane · not indexed as memory</dd></div>
      </dl>
      <div class="pipeline-evidence-actions">
        <button type="button" class="pipeline-btn compact" data-verify-deliverable="${esc(row.id)}" data-deliverable-task="${esc(pipelineId)}"><i class="fas fa-fingerprint" aria-hidden="true"></i><span>Verify SHA-256</span></button>
        ${servable(row) ? `<button type="button" class="pipeline-btn compact" data-download-deliverable="${esc(row.id)}" data-deliverable-task="${esc(pipelineId)}"><i class="fas fa-download" aria-hidden="true"></i><span>Download</span></button>` : ''}
      </div>
    </article>`;
  }

  function body(pipelineId) {
    const state = entry(pipelineId);
    const live = `<div class="pipeline-evidence-live" role="status" aria-live="polite">${esc(state.message)}</div>`;
    if (state.status === 'error' && !state.rows.length) {
      return `${live}<p class="pipeline-evidence-notice pipeline-evidence-conflict" role="alert">Deliverables unavailable: ${esc(state.error)}</p>
        <button type="button" class="pipeline-btn compact" data-retry-deliverables="${esc(pipelineId)}">Retry</button>`;
    }
    if (state.status !== 'ready' && !state.rows.length) {
      return `${live}<p class="pipeline-muted"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading deliverables…</p>`;
    }
    const stale = state.status === 'error' ? `<p class="pipeline-evidence-notice pipeline-evidence-conflict">Refresh failed (${esc(state.error)}); last loaded list shown.</p>` : '';
    return `${live}${stale}${state.rows.length ? state.rows.map(row => card(pipelineId, row)).join('')
      : '<div class="pipeline-empty">No deliverable is registered for this task.</div>'}`;
  }

  function render(pipelineId) {
    document.querySelectorAll(`[data-pipeline-deliverables="${CSS.escape(pipelineId)}"]`).forEach(panel => {
      const focused = document.activeElement && panel.contains(document.activeElement)
        ? [...document.activeElement.attributes].find(attr => attr.name.startsWith('data-'))?.name : null;
      const focusedValue = focused ? document.activeElement.getAttribute(focused) : null;
      panel.querySelector('.pipeline-deliverables-body').innerHTML = body(pipelineId);
      const count = panel.querySelector('.pipeline-drawer-count');
      if (count) count.textContent = entry(pipelineId).status === 'ready' ? String(entry(pipelineId).rows.length) : '…';
      if (focused) panel.querySelector(`[${focused}="${CSS.escape(focusedValue)}"]`)?.focus();
    });
  }

  async function readJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error */ }
    if (!response.ok || !payload?.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
    return payload.data;
  }

  async function load(pipelineId) {
    const state = entry(pipelineId);
    if (state.status === 'loading') return;
    state.status = 'loading';
    try {
      const data = await readJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/deliverables`);
      state.rows = Array.isArray(data?.deliverables) ? data.deliverables : [];
      state.status = 'ready';
      state.error = null;
    } catch (error) {
      state.status = 'error';
      state.error = String(error.message || error);
    }
    state.at = Date.now();
    render(pipelineId);
  }

  async function verify(pipelineId, id) {
    const state = entry(pipelineId);
    state.message = 'Recomputing SHA-256…';
    render(pipelineId);
    try {
      const data = await readJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/deliverables/${encodeURIComponent(id)}`);
      state.rows = state.rows.map(row => (row.id === id ? data.receipt : row));
      const meta = AVAILABILITY[data.receipt?.availability?.status];
      state.message = `${data.receipt?.name || 'Deliverable'}: ${meta ? meta.text : 'unknown availability'}`;
    } catch (error) {
      state.message = `Verification failed: ${String(error.message || error)}`;
    }
    render(pipelineId);
  }

  // The server refuses altered bytes; the browser checks the digest again
  // (when Web Crypto is available) before handing the file to the viewer.
  async function download(pipelineId, id) {
    const state = entry(pipelineId);
    const row = state.rows.find(item => item.id === id);
    if (!row) return;
    state.message = `Downloading ${row.name}…`;
    render(pipelineId);
    try {
      const response = await fetch(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/deliverables/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' });
      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { /* non-JSON error */ }
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (response.headers.get('X-AgentX-Deliverable-Sha256') !== row.sha256) throw new Error('the served digest differs from the registry');
      let checked = 'SHA-256 verified by Core';
      if (window.crypto?.subtle && blob.arrayBuffer) {
        const digest = [...new Uint8Array(await window.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (digest !== row.sha256) throw new Error('the received bytes do not match the SHA-256; the file was not saved');
        checked = 'SHA-256 verified by Core and this browser';
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = row.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      state.message = `${row.name} downloaded · ${checked}`;
    } catch (error) {
      state.message = `Download refused: ${String(error.message || error)}`;
    }
    render(pipelineId);
  }

  async function copy(button) {
    const panel = button.closest('[data-pipeline-deliverables]');
    const live = panel?.querySelector('.pipeline-evidence-live');
    const say = text => { if (live) live.textContent = text; button.title = text; };
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(button.dataset.copyDeliverable || '');
      say('SHA-256 copied');
    } catch {
      const code = button.parentElement?.querySelector('code');
      if (code) window.getSelection()?.selectAllChildren(code);
      say('Clipboard unavailable — the digest is selected for manual copy.');
    }
  }

  // Called while the dossier renders; the list loads (or refreshes when
  // stale) after the markup is in place, and the last list stays visible.
  function markup(task) {
    const pipelineId = String(task?.pipelineId || '');
    if (!/^[0-9A-Za-z_-]{1,16}$/.test(pipelineId)) return '';
    const state = entry(pipelineId);
    if (state.status !== 'loading' && Date.now() - state.at > STALE_MS) setTimeout(() => load(pipelineId), 0);
    const count = state.status === 'ready' ? String(state.rows.length) : '…';
    return `<details class="pipeline-evidence-refs pipeline-deliverables" data-pipeline-deliverables="${esc(pipelineId)}"${state.open ? ' open' : ''}>
      <summary>Deliverables <span class="pipeline-drawer-count">${count}</span></summary>
      <p class="pipeline-muted">Files this task produced, kept in Core within this task's scope. The SHA-256 is checked before a download is served. Deliverables are not memory and are never sent to a third party from here.</p>
      <div class="pipeline-deliverables-body">${body(pipelineId)}</div>
    </details>`;
  }

  document.addEventListener('click', event => {
    const copyTarget = event.target.closest?.('[data-copy-deliverable]');
    if (copyTarget) { copy(copyTarget); return; }
    const verifyTarget = event.target.closest?.('[data-verify-deliverable]');
    if (verifyTarget) { verify(verifyTarget.dataset.deliverableTask, verifyTarget.dataset.verifyDeliverable); return; }
    const downloadTarget = event.target.closest?.('[data-download-deliverable]');
    if (downloadTarget) { download(downloadTarget.dataset.deliverableTask, downloadTarget.dataset.downloadDeliverable); return; }
    const retry = event.target.closest?.('[data-retry-deliverables]');
    if (retry) { entry(retry.dataset.retryDeliverables).message = 'Retrying…'; load(retry.dataset.retryDeliverables); }
  });
  document.addEventListener('toggle', event => {
    const panel = event.target;
    if (panel?.dataset?.pipelineDeliverables) entry(panel.dataset.pipelineDeliverables).open = panel.open;
  }, true);

  window.PipelineDeliverables = { markup, refresh: load };
})();
