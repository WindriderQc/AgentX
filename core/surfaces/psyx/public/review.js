'use strict';

// PsyX background review in the browser: a subtle indicator while PsyX reflects
// on the conversation, and the proposals it makes for memory. Nothing enters
// memory until the user keeps it. Loaded before app.js, whose shared state and
// helpers these functions use at call time.

const PROPOSAL_LABELS = {
  activeThreads: 'Sujet', notes: 'Note', patterns: 'Tendance', hypotheses: 'Hypothèse', openLoops: 'Question ouverte', experiments: 'Expérience'
};
const REVIEW_POLL_MS = 2500;
const REVIEW_POLL_LIMIT_MS = 10 * 60 * 1000;

const review = { enabled: false, watch: null, last: null, editing: null };

function pendingProposals() {
  return state.psyxState?.proposals || [];
}

function renderReviewIndicator(status = review.last) {
  const chip = $('reviewStatus');
  const pending = pendingProposals().length;
  const running = status && ['queued', 'running'].includes(status.status);
  chip.hidden = !review.enabled || (!running && !pending && status?.status !== 'failed' && status?.status !== 'done');
  chip.classList.toggle('running', Boolean(running));
  chip.classList.toggle('has-proposals', !running && pending > 0);
  chip.classList.toggle('failed', status?.status === 'failed');
  chip.textContent = running
    ? 'PsyX réfléchit à cette conversation…'
    : status?.status === 'failed'
      ? 'La réflexion automatique n’a pas abouti'
      : pending
        ? `PsyX a réfléchi · ${pending} proposition${pending === 1 ? '' : 's'} à valider`
        : 'PsyX a réfléchi · rien de nouveau à retenir';
  chip.title = running
    ? 'Une revue en arrière-plan relit la conversation. Elle n’écrit jamais dans la conversation et rien n’entre en mémoire sans toi.'
    : status?.model ? `Dernière revue par ${status.model}` : '';
  const badge = pending ? String(pending) : '';
  for (const id of ['insightsToggle', 'tabMemory']) $(id).dataset.badge = badge;
}

function stopReviewWatch() {
  clearTimeout(review.watch?.timer);
  review.watch = null;
}

async function pollReview(conversationId, accessEpoch, startedAt) {
  if (accessEpoch !== state.accessEpoch || review.watch?.conversationId !== conversationId) return;
  try {
    const status = await api(`/api/psyx/review/status?conversationId=${encodeURIComponent(conversationId)}`, { cache: 'no-store' });
    if (accessEpoch !== state.accessEpoch || state.conversationId !== conversationId) return;
    review.enabled = status.enabled !== false;
    review.last = status;
    if (['done', 'failed'].includes(status.status)) {
      stopReviewWatch();
      await loadPsyXState();
      await loadSessions();
      // "Nothing new" is worth a glance, not a permanent label.
      if (status.status === 'done') setTimeout(() => {
        if (review.last === status && !pendingProposals().length) { review.last = null; renderReviewIndicator(); }
      }, 8000);
      return;
    }
    renderReviewIndicator(status);
  } catch (error) {
    if (error.code === 'PSYX_LOCKED') return stopReviewWatch();
  }
  if (Date.now() - startedAt > REVIEW_POLL_LIMIT_MS) return stopReviewWatch();
  review.watch.timer = setTimeout(() => void pollReview(conversationId, accessEpoch, startedAt), REVIEW_POLL_MS);
}

function watchReview(conversationId) {
  if (!review.enabled || !conversationId) return;
  stopReviewWatch();
  review.last = { status: 'queued' };
  renderReviewIndicator();
  review.watch = { conversationId, timer: null };
  void pollReview(conversationId, state.accessEpoch, Date.now());
}

// On session restore, show a review still in progress for that conversation.
async function resumeReviewStatus(conversationId) {
  stopReviewWatch();
  review.last = null;
  renderReviewIndicator();
  if (!review.enabled || !conversationId) return;
  try {
    const status = await api(`/api/psyx/review/status?conversationId=${encodeURIComponent(conversationId)}`, { cache: 'no-store' });
    if (state.conversationId !== conversationId) return;
    if (['queued', 'running'].includes(status.status)) watchReview(conversationId);
  } catch { /* the indicator stays quiet */ }
}

function proposalBody(item) {
  if (item.kind === 'experiments') {
    return `<strong>${escapeHtml(item.hypothesis)}</strong><span><b>Action :</b> ${escapeHtml(item.action)}</span>${item.expectedSignal ? `<span><b>Signal :</b> ${escapeHtml(item.expectedSignal)}</span>` : ''}`;
  }
  if (review.editing === item.id) {
    return `<textarea data-proposal-text="${escapeHtml(item.id)}" rows="3" maxlength="${item.kind === 'notes' ? 1000 : 500}" aria-label="Modifier la proposition">${escapeHtml(item.text)}</textarea>`;
  }
  return `<strong>${escapeHtml(item.text)}</strong>`;
}

function renderProposals() {
  const container = $('proposalsList');
  const items = pendingProposals();
  $('proposalsSection').hidden = !items.length;
  container.innerHTML = items.slice().reverse().map((item) => `
    <article class="proposal-card" data-proposal="${escapeHtml(item.id)}">
      <div class="proposal-kind">${escapeHtml(PROPOSAL_LABELS[item.kind] || item.kind)}${Number.isFinite(item.confidence) ? ` · ${Math.round(item.confidence * 100)}%` : ''}</div>
      <div class="proposal-body">${proposalBody(item)}</div>
      ${item.evidence?.length ? `<blockquote>${escapeHtml(item.evidence[0])}</blockquote>` : ''}
      ${item.rationale ? `<p class="state-help">${escapeHtml(item.rationale)}</p>` : ''}
      <div class="proposal-actions">
        <button type="button" class="proposal-keep" data-proposal-accept="${escapeHtml(item.id)}">${review.editing === item.id ? 'Enregistrer et garder' : 'Garder'}</button>
        ${item.kind === 'experiments' || review.editing === item.id ? '' : `<button type="button" data-proposal-edit="${escapeHtml(item.id)}">Modifier</button>`}
        <button type="button" data-proposal-reject="${escapeHtml(item.id)}">Écarter</button>
      </div>
    </article>
  `).join('');
  renderReviewIndicator();
}

async function settleProposal(id, action, body = {}) {
  stateSaveStatus.textContent = 'enregistrement…';
  const result = await api(`/api/psyx/state/proposals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
  review.editing = null;
  state.psyxState = result.state;
  // Once every proposal is settled the indicator has nothing left to say.
  if (!pendingProposals().length && !['queued', 'running'].includes(review.last?.status)) review.last = null;
  renderPsyXState();
}

function wireReview() {
  $('proposalsList').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-proposal-edit]');
    if (edit) {
      review.editing = edit.dataset.proposalEdit;
      renderProposals();
      $('proposalsList').querySelector('textarea')?.focus();
      return;
    }
    const accept = event.target.closest('[data-proposal-accept]');
    if (accept) {
      const id = accept.dataset.proposalAccept;
      const text = $('proposalsList').querySelector(`[data-proposal-text="${CSS.escape(id)}"]`)?.value.trim();
      await settleProposal(id, 'accept', text ? { text } : {});
      return;
    }
    const reject = event.target.closest('[data-proposal-reject]');
    if (reject) await settleProposal(reject.dataset.proposalReject, 'reject');
  });
  $('reviewStatus').addEventListener('click', () => {
    activateStateTab($('tabMemory'));
    if (drawerMode()) openDrawer('insights');
    $('proposalsSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function sessionDigest(conversationId) {
  return (state.psyxState?.sessionDigests || []).find((item) => item.conversationId === String(conversationId)) || null;
}
