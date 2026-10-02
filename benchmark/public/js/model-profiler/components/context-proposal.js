// public/js/model-profiler/components/context-proposal.js
/**
 * Pin context proposal: shown when a profile completes and on the profiler
 * card of a pinned model. Apply asks Core to change the pin; Core verifies
 * every resident in VRAM and short-prompt speed and reverts on regression.
 */

import { _fmtCtx, escAttr } from '../models-helpers.js';

const fmtCtx = value => (Number(value) > 0 ? _fmtCtx(Number(value)) : 'Modelfile default');
const fmtGiB = mib => (Number.isFinite(Number(mib)) && mib != null ? `${(Number(mib) / 1024).toFixed(1)} GB` : 'unknown');

function budgetLine(proposal) {
  const budgets = proposal.taskBudgets || {};
  const bits = [
    budgets.interactive ? `interactive ${_fmtCtx(budgets.interactive)}` : null,
    budgets.document ? `document ${_fmtCtx(budgets.document)}` : null
  ].filter(Boolean);
  return bits.length
    ? `<p class="mp-ctxp-note">Task budgets stay per request (${bits.join(' · ')}); they are not the pin allocation.</p>`
    : '';
}

function residentsLine(proposal) {
  const residents = proposal.coResidents || [];
  if (!residents.length) return '<li>Only pinned model on this host</li>';
  return residents.map(item => `<li>${escAttr(item.model)} fully in VRAM${item.observedContext ? ` at ${_fmtCtx(item.observedContext)}` : ''}${item.vramMiB != null ? ` (${fmtGiB(item.vramMiB)})` : ''}</li>`).join('');
}

function attemptLine(attempt) {
  const outcome = attempt?.outcome;
  if (attempt?.outcomeUnknown) {
    return '<p class="mp-ctxp-alert" role="status">Last Apply: outcome unknown — Core did not answer. Check the current pin (Nerve Center) before applying again.</p>';
  }
  if (!outcome) return '';
  const rollback = outcome.rollback === 'verified'
    ? 'the previous pin was restored and verified'
    : outcome.rollback === 'unverified' ? 'the previous pin settings were written but runtime restoration is unverified' : null;
  return `<p class="mp-ctxp-alert" role="status">Last Apply failed: ${escAttr(outcome.message || outcome.code)}${rollback ? ` — ${rollback}` : ''}.</p>`;
}

/** Pure renderer; `mode` is "completion" (all states) or "card" (offers only). */
export function renderContextProposal(proposal, { mode = 'completion' } = {}) {
  if (!proposal) return '';
  const status = proposal.status;
  const title = '<span class="mp-ctxp-kicker">Pin context</span>';
  if (status === 'proposed') {
    const verb = proposal.direction === 'decrease' ? 'Reduce' : 'Raise';
    const vram = proposal.expectedVram || {};
    const declined = proposal.declined
      ? `<p class="mp-ctxp-note">Kept current${proposal.declinedAt ? ` on ${escAttr(new Date(proposal.declinedAt).toLocaleString())}` : ''}. This proposal stays here until the pin matches or a newer profile replaces it.</p>`
      : '';
    return `<section class="mp-ctxp mp-ctxp--offer${proposal.declined ? ' is-declined' : ''}" aria-label="Pin context proposal for ${escAttr(proposal.modelName)}">
      ${title}
      <h4 class="mp-ctxp-title">${verb} pin ${fmtCtx(proposal.currentContext)} → ${_fmtCtx(proposal.proposedContext)}</h4>
      <dl class="mp-ctxp-facts">
        <div><dt>Current pin</dt><dd>${fmtCtx(proposal.currentContext)}</dd></div>
        <div><dt>Proposed</dt><dd>${_fmtCtx(proposal.proposedContext)}</dd></div>
        <div><dt>Expected VRAM</dt><dd>${fmtGiB(vram.hostUsedMiB)} host${vram.hostTotalMiB ? ` of ${fmtGiB(vram.hostTotalMiB)}` : ''}${vram.modelMiB != null ? ` · model ${fmtGiB(vram.modelMiB)}` : ''}</dd></div>
      </dl>
      <ul class="mp-ctxp-list">${residentsLine(proposal)}</ul>
      ${budgetLine(proposal)}
      ${declined}${attemptLine(proposal.lastAttempt)}
      <div class="mp-ctxp-actions">
        <button type="button" class="mp-action mp-action--teal mp-ctxp-apply">Apply</button>
        ${proposal.declined ? '' : '<button type="button" class="mp-action mp-ctxp-keep">Keep current</button>'}
      </div>
      <p class="mp-ctxp-feedback" role="status" aria-live="polite"></p>
    </section>`;
  }
  if (mode === 'card') return '';
  if (status === 'unknown_limit') {
    const q = proposal.qualification || {};
    const missing = q.missingResidents?.length ? ` Missing beside it: ${q.missingResidents.map(escAttr).join(', ')}.` : '';
    const candidates = q.candidates?.length ? `<p class="mp-ctxp-note">Candidates to qualify: ${q.candidates.map(_fmtCtx).join(', ')}.</p>` : '';
    return `<section class="mp-ctxp mp-ctxp--unknown" aria-label="Pin context limit unknown">
      ${title}
      <h4 class="mp-ctxp-title">Limit with co-residents unknown — current pin ${fmtCtx(proposal.currentContext)}</h4>
      <p>${escAttr(proposal.reason)}${missing} Verified alone: ${proposal.soloVerifiedContext ? _fmtCtx(proposal.soloVerifiedContext) : 'unknown'} (not a fit with the other pins).</p>
      ${candidates}<p class="mp-ctxp-note">${escAttr(q.instruction || '')}</p>
      ${budgetLine(proposal)}
    </section>`;
  }
  const messages = {
    matches: `The pin already uses ${fmtCtx(proposal.currentContext)}.`,
    not_pinned: 'This model is not pinned on this host; there is nothing to apply.'
  };
  return `<section class="mp-ctxp mp-ctxp--info" aria-label="Pin context">
    ${title}<p>${escAttr(messages[status] || proposal.reason || 'No pin context proposal.')}</p>
  </section>`;
}

function describeApplied(result) {
  const speed = result?.contextApply?.speed;
  return speed
    ? `Applied. Short prompt ${speed.before?.tokensPerSec} → ${speed.after?.tokensPerSec} tok/s; every resident verified in VRAM.`
    : 'Applied and verified.';
}

/** Render one proposal into `el` and wire Apply / Keep current. */
export function mountContextProposal(el, proposal, { hostId, api, mode = 'completion', onDecided } = {}) {
  el.innerHTML = renderContextProposal(proposal, { mode });
  const section = el.querySelector('.mp-ctxp--offer');
  if (!section) return;
  const feedback = section.querySelector('.mp-ctxp-feedback');
  const buttons = [...section.querySelectorAll('button')];
  const decide = async (decision) => {
    buttons.forEach(button => { button.disabled = true; });
    section.setAttribute('aria-busy', 'true');
    feedback.textContent = decision === 'apply'
      ? 'Applying — reloading pins, verifying VRAM for every resident and short-prompt speed…'
      : 'Saving…';
    try {
      const result = await api.decideContextProposal(proposal.modelName, {
        hostId, proposalId: proposal.proposalId, contextSize: proposal.proposedContext, decision
      });
      const next = result?.proposal || null;
      if (next && (next.status === 'proposed' || mode === 'completion')) {
        mountContextProposal(el, next, { hostId, api, mode, onDecided });
      } else {
        el.innerHTML = '';
      }
      const note = el.querySelector('.mp-ctxp-feedback') || el.appendChild(Object.assign(document.createElement('p'), { className: 'mp-ctxp-feedback', role: 'status' }));
      note.textContent = decision === 'apply' ? describeApplied(result) : 'Kept the current pin.';
      onDecided?.(result);
    } catch (error) {
      const outcome = error.payload?.outcome;
      const next = error.payload?.proposal;
      if (next) mountContextProposal(el, next, { hostId, api, mode, onDecided });
      const note = el.querySelector('.mp-ctxp-feedback');
      const message = outcome?.code === 'PIN_CONTEXT_APPLY_OUTCOME_UNKNOWN'
        ? 'Outcome unknown: Core did not answer. Check the current pin before applying again.'
        : `${error.message}${outcome?.rollback === 'unverified' ? ' Runtime restoration is unverified; check the host before retrying.' : ''}`;
      if (note) note.textContent = message;
      else el.insertAdjacentHTML('beforeend', `<p class="mp-ctxp-alert" role="alert">${escAttr(message)}</p>`);
      el.querySelectorAll('.mp-ctxp button').forEach(button => { button.disabled = false; });
    } finally {
      el.querySelector('.mp-ctxp')?.removeAttribute('aria-busy');
    }
  };
  section.querySelector('.mp-ctxp-apply')?.addEventListener('click', () => decide('apply'));
  section.querySelector('.mp-ctxp-keep')?.addEventListener('click', () => decide('keep_current'));
}

// The latest completion result per host/model, so the notice survives the
// models view re-render that follows a completed profile.
const completionNotices = new Map();
const modelKey = name => String(name || '').trim().toLowerCase().replace(/:latest$/, '');
const noticeKey = (hostId, model) => `${hostId}\n${modelKey(model)}`;

export function rememberCompletionProposal(hostId, modelName, proposal) {
  if (hostId && modelName && proposal) completionNotices.set(noticeKey(hostId, modelName), proposal);
}

function mountCompletionNotice(slot, hostId, proposal, api) {
  mountContextProposal(slot, proposal, { hostId, api, mode: 'completion' });
  const section = slot.querySelector('.mp-ctxp');
  if (!section || proposal.status === 'proposed') return;
  section.insertAdjacentHTML('beforeend', '<button type="button" class="mp-action mp-ctxp-dismiss">Dismiss</button>');
  section.querySelector('.mp-ctxp-dismiss').addEventListener('click', () => {
    completionNotices.delete(noticeKey(hostId, slot.dataset.model));
    slot.innerHTML = '';
  });
}

/** Fill every card slot on the page with the host's open proposals. */
export async function hydrateContextProposals(root, hostId, api) {
  const slots = [...root.querySelectorAll('.mp-ctxp-slot[data-model]')];
  if (!hostId || !slots.length || !api?.getContextProposals) return;
  let data = null;
  try {
    data = await api.getContextProposals(hostId);
  } catch {
    data = null; // Cards keep only completion notices; a failed read offers nothing.
  }
  const byModel = new Map((data?.proposals || []).map(proposal => [modelKey(proposal.modelName), proposal]));
  for (const slot of slots) {
    const live = byModel.get(modelKey(slot.dataset.model));
    const notice = completionNotices.get(noticeKey(hostId, slot.dataset.model));
    if (live?.status === 'proposed') {
      mountContextProposal(slot, live, { hostId, api, mode: 'card' });
    } else if (notice && notice.status !== 'proposed') {
      mountCompletionNotice(slot, hostId, notice, api);
    } else {
      slot.innerHTML = '';
    }
  }
}
