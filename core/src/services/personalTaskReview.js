'use strict';

// Mail extraction establishes a proposal, never the owner's commitment. Older
// imports have no review field; derive their pending state without rewriting
// private source records or treating an inferred deadline as overdue.
const MAIL_EVIDENCE = /Secretary deep review\b|\bsecretary:[^\s:]+:|https:\/\/mail\.google\.com\//i;
const PLATFORM_WORK = /\b(?:Dependabot|CVE-\d{4}|GHSA-|GitHub|GitLab|Jenkins|deploy(?:ment)?|déploiement|workflow|build\s+(?:failed|failure|échoué))\b/i;
const ASSISTANT_WORK = /\b(?:continuer|poursuivre|finir|fin de|continue|resume|finish)\s+(?:la\s+)?(?:lecture|reading)\b|\b(?:offset\s*\d+|nextOffset|pageId)\b/i;

function mailDerived(task = {}) {
  return task.origin === 'email' || task.personalReview?.reason === 'email'
    || MAIL_EVIDENCE.test(String(task.spec || task.note || ''));
}

function reviewReason(task = {}) {
  const title = String(task.title || '');
  if (PLATFORM_WORK.test(title) || /\bCI(?:\s*\/\s*CD)?\b/.test(title)) return 'platform';
  if (ASSISTANT_WORK.test(title)) return 'assistant';
  return mailDerived(task) ? 'email' : null;
}

function personalReview(task = {}) {
  const stored = task.personalReview;
  const reason = stored?.reason || reviewReason(task);
  const state = ['pending', 'accepted', 'dismissed'].includes(stored?.state)
    ? stored.state : reason ? 'pending' : 'accepted';
  return { state, reason, reviewedAt: stored?.reviewedAt || null };
}

function sourceUrl(task = {}) {
  const match = String(task.spec || task.note || '').match(/https:\/\/mail\.google\.com\/[^\s)<>"']{1,300}/);
  return match ? match[0].replace(/[.,;]+$/, '') : null;
}

module.exports = { mailDerived, personalReview, reviewReason, sourceUrl };
