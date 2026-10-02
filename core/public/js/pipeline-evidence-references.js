(function () {
  'use strict';
  // Copyable evidence references for one task dossier. Core projects the chain
  // (agentx.pipeline-evidence-references/v1); this view only joins the launch
  // request and delivery observations already loaded by the page, and only on
  // an exact match. A reference is text to copy, never an action control.
  const SCHEMA = 'agentx.pipeline-evidence-references/v1';
  const REQUEST_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const RECEIPT_RE = /^[a-f0-9]{64}$/;
  const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)$/;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const UNKNOWN = {
    not_recorded: 'Unknown — not recorded for this attempt',
    malformed: 'Unknown — the recorded value is not a valid reference',
    conflict: 'Unknown — the same value appears on several attempts; no link is made',
    absent: 'Unknown — no receipt recorded for this attempt',
  };

  function copyButton(value, label) {
    return `<button type="button" class="pipeline-evidence-copy" data-copy-evidence-ref="${esc(value)}" aria-label="Copy ${esc(label)}"><i class="fas fa-copy" aria-hidden="true"></i><span>Copy</span></button>`;
  }
  function reference(label, value, display) {
    return `<div class="pipeline-evidence-row"><dt>${esc(label)}</dt><dd><code title="${esc(value)}">${esc(display || value)}</code>${copyButton(value, `${label} reference`)}</dd></div>`;
  }
  function unknown(label, text, tone = 'unknown') {
    return `<div class="pipeline-evidence-row"><dt>${esc(label)}</dt><dd class="pipeline-evidence-${tone}">${esc(text)}</dd></div>`;
  }
  function attemptLink(pipelineId, attempt) {
    const url = new URL('/pipeline', window.location.origin);
    url.searchParams.set('task', pipelineId);
    url.searchParams.set('attempt', String(attempt));
    return url.href;
  }

  // The PR is linked only when the delivery observation names this exact task
  // and attempt, and Core's delivery gate proved the exact PR, exact head and
  // sealed receipt binding (kept after merge). Product PRs carry no binding.
  function pullRequestRow(row, pipelineId, delivery) {
    if (!delivery) return unknown('Pull request', 'Unknown — delivery status is not loaded');
    if (delivery.ambiguous) return unknown('Pull request', 'Unknown — several delivery observations name this task; no link is made', 'conflict');
    if (delivery.pipelineId !== pipelineId) return unknown('Pull request', 'Unknown — no delivery observation for this task');
    if (Number(delivery.attempt) !== row.attempt) return unknown('Pull request', `Not this attempt — the delivery observation concerns attempt ${Number(delivery.attempt) || 'unknown'}`);
    if (delivery.stage === 'receipt_mismatch') return unknown('Pull request', 'Mismatch — the PR is not bound to this attempt’s sealed receipt; no link is made', 'conflict');
    const pr = delivery.pullRequest;
    if (!pr) return unknown('Pull request', 'None recorded for this attempt');
    const fingerprint = String(delivery.receipt?.fingerprint || '');
    if (row.receipt.status !== 'recorded' || fingerprint !== row.receipt.fingerprint) {
      return unknown('Pull request', 'Unknown — the delivery receipt does not match this attempt’s receipt; no link is made', 'conflict');
    }
    const binding = delivery.receiptBinding;
    if (!binding || binding.exactPullRequest !== true || binding.exactHead !== true || binding.sealedReceipt !== true) {
      return unknown('Pull request', `PR #${Number(pr.number) || '?'} — receipt binding not proven; no link is made`, 'conflict');
    }
    const match = String(pr.url || '').match(PR_URL_RE);
    if (!match || Number(match[1]) !== Number(pr.number)) return unknown('Pull request', `PR #${Number(pr.number) || '?'} — link unverified; no link is made`, 'conflict');
    return `<div class="pipeline-evidence-row"><dt>Pull request</dt><dd><a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">PR #${esc(pr.number)}</a>${pr.headSha ? ` <code>${esc(String(pr.headSha).slice(0, 12))}</code>` : ''}${copyButton(pr.url, 'pull request link')}</dd></div>`;
  }

  function requestRow(row, launchRun) {
    if (row.request.status !== 'recorded' || !REQUEST_RE.test(row.request.requestId || '')) {
      return unknown('Launch request', UNKNOWN[row.request.status] || UNKNOWN.not_recorded, row.request.status === 'conflict' ? 'conflict' : 'unknown');
    }
    const phase = launchRun?.requestId === row.request.requestId ? ` · host phase ${String(launchRun.phase || 'unknown').replace(/_/g, ' ')}` : '';
    return `<div class="pipeline-evidence-row"><dt>Launch request</dt><dd><code>${esc(row.request.requestId)}</code>${copyButton(row.request.requestId, 'launch request id')}${phase ? `<small>${esc(phase)}</small>` : ''}</dd></div>`;
  }

  function attemptCard(refs, row, context) {
    const latest = refs.attempts.find(item => item.current);
    const standing = row.current ? 'Current attempt'
      : latest ? `Historical — attempt ${latest.attempt} is current` : 'Standing unknown';
    const receipt = row.receipt.status === 'recorded' && RECEIPT_RE.test(row.receipt.fingerprint || '')
      ? reference('Worker receipt', row.receipt.fingerprint, `${row.receipt.fingerprint.slice(0, 16)}…`)
        + (row.receipt.source ? unknown('Receipt source', row.receipt.source, 'plain') : '')
      : unknown('Worker receipt', UNKNOWN[row.receipt.status] || UNKNOWN.absent, row.receipt.status === 'conflict' ? 'conflict' : 'unknown');
    const lease = row.lease.status === 'recorded'
      ? `<div class="pipeline-evidence-row"><dt>Lease fingerprint</dt><dd><code>${esc(row.lease.ref)}</code>${copyButton(row.lease.ref, 'lease fingerprint')}${refs.activeLease?.attempt === row.attempt ? (refs.activeLease.status === 'bound' ? '<small>Active lease</small>' : '<small>Lease inactive — the task is no longer in progress</small>') : ''}</dd></div>`
      : unknown('Lease fingerprint', UNKNOWN[row.lease.status] || UNKNOWN.not_recorded, row.lease.status === 'conflict' ? 'conflict' : 'unknown');
    return `<article class="pipeline-evidence-attempt" id="pipeline-evidence-attempt-${esc(row.attempt)}" data-evidence-attempt="${esc(row.attempt)}" tabindex="-1">
      <header><strong>Attempt ${esc(row.attempt)}</strong><span>${esc(standing)} · ${esc(String(row.finalState).replace(/_/g, ' '))} · review ${esc(row.reviewOutcome)}</span></header>
      <dl>
        ${reference('Attempt', row.ref)}
        ${requestRow(row, context.launchRun)}
        ${lease}
        ${receipt}
        ${pullRequestRow(row, refs.pipelineId, context.delivery)}
      </dl>
      <div class="pipeline-evidence-actions">
        <button type="button" class="pipeline-btn compact" data-evidence-show-attempt="${esc(row.attempt)}"><i class="fas fa-magnifying-glass-chart" aria-hidden="true"></i><span>Show attempt ${esc(row.attempt)} dossier</span></button>
        ${copyButton(attemptLink(refs.pipelineId, row.attempt), `link to attempt ${row.attempt}`).replace('<span>Copy</span>', '<span>Copy attempt link</span>')}
      </div>
    </article>`;
  }

  function launchNotice(refs, launchRun) {
    if (!launchRun || launchRun.pipelineId !== refs.pipelineId || !REQUEST_RE.test(String(launchRun.requestId || ''))) return '';
    if (refs.attempts.some(row => row.request.requestId === launchRun.requestId)) return '';
    return `<p class="pipeline-evidence-notice">Latest launch request <code>${esc(launchRun.requestId)}</code>${copyButton(launchRun.requestId, 'launch request id')} (${esc(String(launchRun.phase || 'unknown').replace(/_/g, ' '))}) is not recorded on any attempt of this task. No attempt is inferred from it.</p>`;
  }

  function markup(task, context = {}) {
    const refs = task?.evidenceReferences;
    if (!refs || refs.schema !== SCHEMA || refs.pipelineId !== task.pipelineId || !Array.isArray(refs.attempts)) return '';
    const launch = launchNotice(refs, context.launchRun);
    if (!refs.attempts.length && !launch) return '';
    const loaded = Array.isArray(context.deliveryItems);
    const deliveries = loaded ? context.deliveryItems.filter(item => item?.pipelineId === refs.pipelineId) : [];
    const delivery = deliveries.length === 1 ? deliveries[0] : deliveries.length > 1 ? { ambiguous: true } : loaded ? {} : null;
    const ctx = { launchRun: context.launchRun, delivery };
    const conflicts = Array.isArray(refs.conflicts) && refs.conflicts.length
      ? `<p class="pipeline-evidence-notice pipeline-evidence-conflict" role="note">Reference conflict: ${refs.conflicts.map(item => esc(String(item.code).replace(/_/g, ' '))).join(' · ')}. Affected references stay unknown.</p>` : '';
    return `<details class="pipeline-evidence-refs" data-evidence-refs="${esc(refs.pipelineId)}">
      <summary>Evidence references <span class="pipeline-drawer-count">${refs.attempts.length}</span></summary>
      <p class="pipeline-muted">Copyable identifiers for tracing an attempt through launch, lease, receipt and PR. They grant no action. Lease ids, tokens, epochs, release bodies and machine paths are never shown; a lease appears only as a one-way fingerprint.</p>
      <div class="pipeline-evidence-live" role="status" aria-live="polite"></div>
      ${conflicts}${launch}
      ${task.evidenceReferences.task?.ref ? `<dl>${reference('Task', task.evidenceReferences.task.ref)}</dl>` : ''}
      ${refs.attempts.map(row => attemptCard(refs, row, ctx)).join('')}
    </details>`;
  }

  // The launch panel shows its own request id; the dossier resolves which
  // attempt (if any) recorded it.
  function launchMarkup(run) {
    if (!run || !REQUEST_RE.test(String(run.requestId || ''))) return '';
    return `<span class="pipeline-evidence-launch">Request <code>${esc(run.requestId)}</code>${copyButton(run.requestId, 'launch request id')}</span>`;
  }

  async function copy(button) {
    const value = button.dataset.copyEvidenceRef || '';
    const live = button.closest('[data-evidence-refs]')?.querySelector('.pipeline-evidence-live');
    const say = text => { if (live) live.textContent = text; button.title = text; };
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(value);
      say('Copied');
    } catch {
      const code = button.parentElement?.querySelector('code');
      if (code) window.getSelection()?.selectAllChildren(code);
      say('Clipboard unavailable — the reference is selected for manual copy.');
    }
  }

  function showAttempt(root, attempt, focusTarget) {
    const panel = root.querySelector('[data-evidence-refs]');
    if (panel) panel.open = true;
    const dossier = root.querySelector(`#pipeline-attempt-${CSS.escape(String(attempt))}`);
    const target = focusTarget === 'dossier' && dossier ? dossier : root.querySelector(`#pipeline-evidence-attempt-${CSS.escape(String(attempt))}`);
    if (!target) return false;
    target.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
    return true;
  }

  // Deep link: /pipeline?task=0307&attempt=2 opens this attempt's references
  // once, after the dossier renders. An absent attempt stays unresolved.
  let pendingDeepLink = (() => {
    const params = new URLSearchParams(window.location.search);
    const task = params.get('task'), attempt = params.get('attempt');
    return /^\d{3,4}$/.test(task || '') && /^[1-9]\d{0,3}$/.test(attempt || '') ? { task, attempt } : null;
  })();
  function resolveDeepLink() {
    if (!pendingDeepLink) return;
    const panel = document.querySelector(`[data-evidence-refs="${pendingDeepLink.task}"]`);
    if (!panel) return;
    const root = panel.closest('#pipelineDrawerBody') || document;
    const { attempt } = pendingDeepLink;
    pendingDeepLink = null;
    if (!showAttempt(root, attempt)) {
      panel.open = true;
      const live = panel.querySelector('.pipeline-evidence-live');
      if (live) live.textContent = `Attempt ${attempt} is not recorded on this task; no other attempt is substituted.`;
    }
  }

  document.addEventListener('click', event => {
    const copyTarget = event.target.closest?.('[data-copy-evidence-ref]');
    if (copyTarget) { copy(copyTarget); return; }
    const show = event.target.closest?.('[data-evidence-show-attempt]');
    if (show) showAttempt(show.closest('#pipelineDrawerBody') || document, show.dataset.evidenceShowAttempt, 'dossier');
  });
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => { resolveDeepLink(); if (!pendingDeepLink) observer.disconnect(); });
    document.addEventListener('DOMContentLoaded', () => {
      if (pendingDeepLink) observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  window.PipelineEvidenceReferences = { markup, launchMarkup, showAttempt };
})();
