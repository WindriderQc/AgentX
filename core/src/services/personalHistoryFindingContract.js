'use strict';

const { randomUUID } = require('node:crypto');
const { failure } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'secretary.archive-findings/v1';
const SECTIONS = Object.freeze({ actions: 'action', memories: 'fact', deliverables: 'deliverable', invoices: 'invoice' });
const HASH = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const invalid = () => failure('The native recorded finding inventory is unavailable or invalid.', 503, 'HISTORY_FINDINGS_UNAVAILABLE');

function describe(value, requestId, source) {
  const keys = ['contract', 'requestId', 'messageId', 'threadId', 'sourceSha256', 'evidenceHash', 'reviewSha256',
    'metadataSha256', 'raw', 'findings', 'threadQuestions', 'scope', 'semanticAcceptance', 'executionAllowed'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 || value.contract !== CONTRACT || value.requestId !== requestId
    || value.messageId !== source.messageId || value.threadId !== source.threadId || value.sourceSha256 !== source.sourceSha256
    || ![value.evidenceHash, value.reviewSha256, value.metadataSha256].every(isHash)
    || !value.raw || Object.keys(value.raw).some(key => !['sha256', 'bytes'].includes(key))
    || value.raw.sha256 !== source.sourceSha256 || !Number.isSafeInteger(value.raw.bytes) || value.raw.bytes < 1 || value.raw.bytes > 16 * 1024 * 1024
    || value.scope !== 'recorded-selected-message-findings-and-thread-questions'
    || value.semanticAcceptance !== false || value.executionAllowed !== false
    || !Array.isArray(value.findings) || value.findings.length > 256
    || !Array.isArray(value.threadQuestions) || value.threadQuestions.length > 128) throw invalid();
  const seen = new Set(), findings = value.findings.map(item => {
    if (!item || Object.keys(item).some(key => !['findingId', 'section'].includes(key)) || !isHash(item.findingId)
      || !Object.hasOwn(SECTIONS, item.section) || seen.has(item.findingId)) throw invalid();
    seen.add(item.findingId); return { findingId: item.findingId, section: item.section };
  }).sort((a, b) => a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0);
  seen.clear();
  const threadQuestions = value.threadQuestions.map(item => {
    if (!item || Object.keys(item).some(key => key !== 'questionId') || !isHash(item.questionId) || seen.has(item.questionId)) throw invalid();
    seen.add(item.questionId); return { questionId: item.questionId };
  }).sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0);
  return { contract: CONTRACT, reference: source, evidenceHash: value.evidenceHash, reviewSha256: value.reviewSha256,
    metadataSha256: value.metadataSha256, raw: { sha256: value.raw.sha256, bytes: value.raw.bytes }, findings, threadQuestions,
    scope: value.scope, semanticAcceptance: false, executionAllowed: false };
}

async function collect(reference, control) {
  const requestId = randomUUID();
  try { return describe(await control.probe({ requestId, ...reference }), requestId, reference); }
  catch { throw invalid(); }
}

function reconcile(inventory, entries, nativeStates) {
  const source = inventory.reference;
  const pins = new Map(nativeStates.map(state => [state.snapshot.entryId, state]));
  const cited = entries.map(entry => ({ entry,
    refs: [entry.source, ...(entry.relatedSources || [])].filter(ref => ref?.system === 'gmail'
      && ref.messageId === source.messageId && ref.threadId === source.threadId && ref.sourceSha256 === source.sourceSha256) }));
  const findings = inventory.findings.map(finding => {
    const records = cited.filter(row => row.refs.some(ref => ref.findingId === finding.findingId)).map(({ entry }) => {
      const native = pins.get(entry.id), blockers = [];
      const at = entry.decision?.at;
      const dated = at instanceof Date ? Number.isFinite(at.getTime()) : typeof at === 'string' && Number.isFinite(Date.parse(at));
      if (entry.kind !== SECTIONS[finding.section]) blockers.push('kind_differs_from_native_import_kind');
      if (entry.reviewState === 'candidate' || typeof entry.decision?.reason !== 'string' || !entry.decision.reason.trim()
        || !dated) blockers.push('owner_decision_not_recorded');
      if (['action', 'deliverable'].includes(entry.kind) && entry.reviewState === 'retained') blockers.push('retained_action_still_open');
      if (native.snapshot.pendingSourceDecisions) blockers.push('pending_source_review_intent');
      return { entryId: entry.id, revision: entry.revision, kind: entry.kind, state: entry.reviewState,
        fingerprint: native.fingerprint, blockers };
    }).sort((a, b) => a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);
    return { ...finding, records, status: !records.length ? 'no_core_reference'
      : records.some(record => record.blockers.length) ? 'needs_review' : 'observed_decision' };
  });
  const known = new Set(inventory.findings.map(finding => finding.findingId));
  const unmatchedEntries = cited.filter(row => row.refs.some(ref => !known.has(ref.findingId))).map(({ entry }) => entry.id).sort();
  const counts = { recordedFindings: findings.length, noCoreReference: 0, needsReview: 0, observedDecision: 0,
    threadQuestions: inventory.threadQuestions.length, unmatchedEntries: unmatchedEntries.length };
  for (const finding of findings) counts[finding.status === 'no_core_reference' ? 'noCoreReference'
    : finding.status === 'needs_review' ? 'needsReview' : 'observedDecision'] += 1;
  const blockers = [];
  if (!findings.length) blockers.push('empty_recorded_finding_set_not_semantic_acceptance');
  if (counts.noCoreReference || counts.needsReview) blockers.push('recorded_findings_need_review');
  if (counts.threadQuestions) blockers.push('thread_questions_unresolved');
  if (unmatchedEntries.length) blockers.push('core_references_outside_recorded_finding_set');
  return { findings, unmatchedEntries, counts, blockers,
    meaning: 'Recorded finding/reference/decision observations only; no comprehension, authenticated person, downstream settlement or cleanup acceptance.' };
}

module.exports = { CONTRACT, collect, describe, reconcile };
