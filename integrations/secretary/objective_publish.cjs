#!/usr/bin/env node
'use strict';

// Publish native review receipts through Core's existing context importer.
// These files are execution/recovery evidence, never a second memory authority.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function durable(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const target = exclusive ? file : `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(target, exclusive ? 'wx' : 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(target, file);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function nativeSource(record, findingId) {
  const ref = record.nativeRef || {};
  if (!['gmail', 'outlook-export'].includes(ref.system) || !/^[a-f0-9]{64}$/.test(ref.sourceSha256 || '')) throw new Error('Missing native original provenance');
  return { system: ref.system, id: ref.messageId, threadId: ref.threadId, messageId: ref.messageId,
    sourceSha256: ref.sourceSha256, findingId, direction: ref.direction || 'unknown' };
}
function sourceRecord(record) {
  if (typeof record.body !== 'string' || hash(record.body) !== record.bodySha256) throw new Error('Exact source body integrity failed');
  return { id: record.id, kind: 'mail', subject: record.subject, body: record.body, bodySha256: record.bodySha256,
    date: timestamp(record.mailDate), authority: 'source-record', nativeRef: record.nativeRef,
    provenance: { owner: 'secretary-objective-review', bodyScope: record.bodyScope } };
}
function boundEquivalentCopies(finding, records) {
  const mandatory = records.filter(record => record.bodyScope !== 'verified-equivalent-unit-not-read-by-model');
  const aliases = records.filter(record => record.bodyScope === 'verified-equivalent-unit-not-read-by-model');
  const proof = records.map(record => ({ id: record.id, bodySha256: record.bodySha256, nativeRef: record.nativeRef,
    claimsWithExactQuotes: finding.claimsWithExactQuotes.filter(c => c.sourceId === record.id) }));
  const selected = [...mandatory], represented = new Set(), omitted = [];
  const mandatoryClaims = finding.claimsWithExactQuotes.filter(c => mandatory.some(r => r.id === c.sourceId));
  let claims = mandatoryClaims.length;
  let bytes = Buffer.byteLength(JSON.stringify(mandatory)) + Buffer.byteLength(JSON.stringify(mandatoryClaims));
  for (const record of [...aliases].sort((a, b) => Buffer.byteLength(a.body) - Buffer.byteLength(b.body))) {
    const group = record.nativeRef.system;
    const count = finding.claimsWithExactQuotes.filter(c => c.sourceId === record.id).length;
    const size = Buffer.byteLength(JSON.stringify(record)) + Buffer.byteLength(JSON.stringify(finding.claimsWithExactQuotes.filter(c => c.sourceId === record.id)));
    const reason = represented.has(group) ? 'equivalent-copy-grouped-by-source-system'
      : Buffer.byteLength(record.body) > 1024 * 1024 ? 'equivalent-body-over-core-limit'
        : selected.length >= 100 || claims + count > 100 || bytes + size > 1536 * 1024 ? 'equivalent-copy-core-context-budget' : null;
    if (reason) { omitted.push({ sourceId: record.id, reason }); continue; }
    selected.push(record); represented.add(group); claims += count; bytes += size;
  }
  return { records: selected, claims: finding.claimsWithExactQuotes.filter(c => selected.some(r => r.id === c.sourceId)),
    proof, limits: { totalSourceRecords: records.length, importedSourceRecords: selected.length,
      totalQuotedClaims: finding.claimsWithExactQuotes.length, importedQuotedClaims: claims,
      omittedEquivalentCopies: omitted.length, equivalentCopies: aliases.length,
      policy: 'Canonical model evidence plus one bounded equivalent copy per source system; no distinct evidence omitted',
      proofManifestSha256: hash(JSON.stringify(proof)), omitted } };
}
function applyDateReview(payload, review) {
  if (!review) return payload;
  const findingId = payload.timeline.legacyId;
  if (review.findingId !== findingId || !Array.isArray(review.clear) || !review.clear.length ||
      review.clear.some(side => !['start', 'end', 'ongoing'].includes(side)) || new Set(review.clear).size !== review.clear.length ||
      typeof review.reason !== 'string' || !review.reason.trim() || review.reason.length > 2000 ||
      typeof review.question !== 'string' || !review.question.trim() || review.question.length > 2000 || !timestamp(review.reviewedAt)) {
    throw new Error('Date adjudication needs its exact finding, temporal fields to clear, bounded reason/question and review timestamp');
  }
  const t = payload.timeline;
  const proposal = { date: t.date, precision: t.precision, endDate: t.endDate, endPrecision: t.endPrecision,
    ongoing: t.ongoing, originalDate: t.originalDate, rationale: t.rationale, uncertainty: t.notes };
  if (review.modelProposal && !isDeepStrictEqual(review.modelProposal, proposal)) throw new Error('Core date review refers to another model proposal; inspect before replacement');
  t.metadata.dateReview = { contract: 'secretary.objective-date-audit/v1', findingId, clear: review.clear,
    reason: review.reason, question: review.question, reviewedAt: timestamp(review.reviewedAt),
    authority: 'automated-source-audit-not-owner-confirmation', modelProposal: proposal };
  if (review.clear.includes('start')) { t.date = null; t.precision = 'unknown'; payload.entry.eventDate = ''; payload.entry.eventDatePrecision = 'unknown'; }
  if (review.clear.includes('end')) { t.endDate = null; t.endPrecision = 'unknown'; }
  if (review.clear.includes('ongoing')) t.ongoing = false;
  t.dateEstimateNote = review.reason;
  t.reviewQuestions = [review.question];
  t.notes = 'Temporalité à préciser; interprétation automatique non confirmée.';
  if (review.clear.some(side => side !== 'ongoing')) t.tentativeDate = true;
  return payload;
}
function nativeDateReview(entry) { return entry?.context?.importedTimeline?.metadata?.dateReview || entry?.timeline?.metadata?.dateReview || null; }
function build(finding, indexed, { matches = [], dateReview = null } = {}) {
  if (!/^objective-[a-f0-9]{64}$/.test(finding.id || '') || finding.userConfirmed !== false || finding.reviewState !== 'candidate') throw new Error('Only native unconfirmed objective candidates can be imported');
  const allRecords = finding.sourceIds.map(id => { const record = indexed.get(id); if (!record) throw new Error(`Missing quoted source ${id}`); return record; });
  const bounded = boundEquivalentCopies(finding, allRecords);
  const records = bounded.records;
  const findingId = finding.id.slice('objective-'.length);
  const primary = nativeSource(records[0], findingId);
  for (const claim of finding.claimsWithExactQuotes) {
    if (!indexed.get(claim.sourceId)?.body.includes(claim.quote)) throw new Error('Quote is not exact in its saved source');
  }
  const importId = `objective:${finding.objectiveId}:${finding.objectiveVersion}:${findingId}`;
  const related = matches.filter(row => row.timeline?.legacyId).slice(0, 5);
  const proposals = related.map(row => ({ kind: 'hypothesis', entryId: row.id, legacyId: row.timeline.legacyId,
    reason: 'Même original natif et citation commune; identité du fait proposée, à valider.', sourceKey: row.sourceKey }));
  const payload = { importId, expectedContextRevision: 0,
    entry: { kind: 'fact', text: finding.title, actor: finding.subjectName, sourceDate: timestamp(records[0].mailDate),
      eventDate: finding.startDate || '', eventDatePrecision: finding.startPrecision,
      eventDateAsWritten: finding.originalDate.length <= 200 ? finding.originalDate : '',
      sourceStatus: `Relevé ${finding.occurrenceStatus}; sujet ${finding.subject}; interprétation non confirmée`,
      source: primary, relatedSources: records.slice(1, 19).map(record => nativeSource(record, findingId)) },
    timeline: { legacyId: finding.id, title: finding.title, description: finding.description, category: finding.category,
      date: finding.startDate, precision: finding.startPrecision, endDate: finding.endDate, endPrecision: finding.endPrecision,
      ongoing: finding.ongoing, originalDate: finding.originalDate, subjectPerson: finding.subjectName,
      occurrenceStatus: finding.occurrenceStatus, claimType: finding.claimType === 'hypothesis' ? 'hypothesis' : 'assertion',
      reviewState: 'candidate', confirmationBasis: 'source-record', rationale: finding.rationale, notes: finding.uncertainty,
      sourceIndependence: finding.sourceIndependence || 'not-established',
      sourceIds: records.map(r => r.id), claimsWithExactQuotes: bounded.claims,
      proposedRelations: [...(finding.relationHints || []), ...proposals],
      metadata: { objectiveId: finding.objectiveId, objectiveVersion: finding.objectiveVersion,
        subject: finding.subject, subjectName: finding.subjectName, userConfirmed: false,
        proofLimits: Object.fromEntries(Object.entries(bounded.limits).filter(([key]) => key !== 'omitted')) } },
    sourceRecords: records.map(sourceRecord),
    relations: related.map(row => ({ id: `objective-match-${hash(`${finding.id}:${row.id}`)}`, title: 'Fait possiblement déjà relevé',
      kind: 'hypothesis', eventIds: [finding.id, row.timeline.legacyId],
      summary: 'La nouvelle lecture et le relevé existant citent le même original et un passage commun.',
      rationale: 'Rapprochement de provenance et de citation, sans fusion ni changement du relevé antérieur.',
      limits: 'Une même source ne constitue pas une corroboration indépendante; les formulations et dates restent à revoir.',
      sourceIndependence: 'not-established', claimsWithExactQuotes: bounded.claims.slice(0, 1) })), media: [] };
  return applyDateReview(payload, dateReview);
}
function matches(finding, indexed, existing) {
  const hashes = new Set(finding.sourceIds.map(id => indexed.get(id)?.nativeRef?.sourceSha256));
  const quotes = finding.claimsWithExactQuotes.map(c => c.quote.replace(/\s+/gu, ' ').trim()).filter(q => q.length >= 30);
  return existing.filter(row => !String(row.importId || '').startsWith('objective:') && hashes.has(row.source?.sourceSha256) && row.timeline?.claimsWithExactQuotes?.some(c => {
    const prior = c.quote.replace(/\s+/gu, ' ').trim();
    return prior.length >= 30 && quotes.some(q => prior.includes(q) || q.includes(prior));
  }));
}
function client(base, fetchImpl = fetch) {
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Core URL must use HTTP(S)');
  return async (pathname, body) => {
    const response = await fetchImpl(new URL(pathname, origin), { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-service-caller': 'secretary-objective-publisher' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const answer = await response.json();
    if (!response.ok || answer.ok === false || answer.status === 'error') throw Object.assign(new Error('Core context import refused'), { status: response.status, code: answer.code });
    return answer.data;
  };
}
async function lookup(call, importId, contextHash = null) {
  const answer = await call(`/api/secretary/history?limit=100&importId=${encodeURIComponent(importId)}`);
  if (answer.total > 1) throw new Error('Import identity resolves to several entries');
  const entry = answer.entries[0];
  if (!entry) return null;
  if (contextHash && entry.contextHash !== contextHash) throw new Error('Core has another context under this import identity; preserve owner state');
  return { importId, entryId: entry.id, sourceKey: entry.sourceKey, contextHash: entry.contextHash,
    contextRevision: entry.contextRevision, reconciled: true, assertionState: entry.assertionState, reviewState: entry.reviewState,
    dateReview: nativeDateReview(entry) };
}
async function publishOne(directory, payload, normalized, call) {
  const root = path.join(directory, 'publication', hash(payload.importId));
  const expected = normalized.context.inputHash;
  const current = await lookup(call, payload.importId);
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const prior = path.join(root, name);
    if (!fs.existsSync(path.join(prior, 'intent.json')) || fs.existsSync(path.join(prior, 'receipt.json')) || fs.existsSync(path.join(prior, 'refused.json'))) continue;
    const intent = read(path.join(prior, 'intent.json'));
    if (!current || current.contextHash !== intent.contextHash) throw new Error('Original publication outcome remains uncertain; no replacement was sent');
    durable(path.join(prior, 'receipt.json'), current);
  }
  if (current?.contextHash === expected) return current;
  if (current?.dateReview && !isDeepStrictEqual(current.dateReview, payload.timeline.metadata?.dateReview)) {
    throw new Error('Core date adjudication changed; reload the native review before source enrichment');
  }
  // Source enrichment uses the current Core context revision; the importer
  // preserves owner overrides/review decisions. This is never a fuzzy merge.
  payload = { ...payload, expectedContextRevision: current?.contextRevision || 0 };
  const payloadHash = hash(JSON.stringify(payload));
  const home = path.join(root, payloadHash);
  const intentFile = path.join(home, 'intent.json');
  const receiptFile = path.join(home, 'receipt.json');
  if (fs.existsSync(intentFile)) throw new Error('This exact publication attempt already has a terminal refusal; inspect its receipt');
  durable(intentFile, { schema: 'secretary.objective-publication/v1', importId: payload.importId,
    contextHash: expected, payloadSha256: payloadHash, expectedContextRevision: payload.expectedContextRevision,
    at: new Date().toISOString() }, true);
  durable(path.join(home, 'payload.json'), payload);
  try {
    const answer = await call('/api/secretary/history/context/import', { entries: [payload] });
    const receipt = answer.results?.[0];
    if (!receipt || receipt.importId !== payload.importId || receipt.contextHash !== expected) throw new Error('Core did not return the expected durable context receipt');
    durable(receiptFile, receipt);
    return receipt;
  } catch (error) {
    // Never replay a possibly accepted mutation. The canonical identity/hash is
    // the only recovery proof, even when the transport's response was lost.
    const receipt = await lookup(call, payload.importId);
    if (receipt?.contextHash === expected) { durable(receiptFile, receipt); return receipt; }
    if (error.status >= 400 && error.status < 500) {
      durable(path.join(home, 'refused.json'), { at: new Date().toISOString(), status: error.status, code: error.code || null });
      throw new Error('Core refused this exact context revision; preserve its response before a newly planned attempt');
    }
    durable(path.join(home, 'unconfirmed.json'), { at: new Date().toISOString(), errorType: error.name, code: error.code || null });
    throw new Error('Publication outcome is unconfirmed; inspect this native import identity before continuation');
  }
}
async function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const options = {};
  while (argv.length) { const key = argv.shift(); if (!key.startsWith('--') || !argv.length) throw new Error('Use named CLI arguments'); options[key.slice(2)] = argv.shift(); }
  if (!['plan', 'publish'].includes(command) || !options.directory) throw new Error('Use plan|publish --directory <native objective directory> --core <Core URL>');
  const directory = path.resolve(options.directory);
  if (fs.existsSync(path.join(directory, 'worker.lock'))) throw new Error('Wait for the native objective worker to release its lock');
  const contract = require(options.contract ? path.resolve(options.contract) : '../../core/src/services/personalHistoryContextContract');
  const findings = read(path.join(directory, 'findings.json'));
  const records = new Map(read(path.join(directory, 'sources.json')).map(row => [row.id, row]));
  const call = options.core ? client(options.core) : null;
  const existing = [];
  if (call) {
    let offset = 0;
    for (;;) {
      const page = await call(`/api/secretary/history?limit=100&offset=${offset}`);
      existing.push(...page.entries);
      if (page.nextOffset === null || page.nextOffset === undefined) break;
      if (page.nextOffset <= offset) throw new Error('Core history pagination did not advance');
      offset = page.nextOffset;
    }
  }
  const supplied = options.adjudications ? read(path.resolve(options.adjudications)) : [];
  if (!Array.isArray(supplied) || supplied.some(row => !row || !findings.some(f => f.id === row.findingId)) ||
      new Set(supplied.map(row => row.findingId)).size !== supplied.length) throw new Error('Adjudications must reference distinct current native findings');
  const plan = findings.map(finding => {
    const importId = `objective:${finding.objectiveId}:${finding.objectiveVersion}:${finding.id.slice('objective-'.length)}`;
    const retained = nativeDateReview(existing.find(row => row.importId === importId));
    const requested = supplied.find(row => row.findingId === finding.id);
    const payload = build(finding, records, { matches: matches(finding, records, existing), dateReview: requested || retained });
    if (retained && !isDeepStrictEqual(retained, payload.timeline.metadata.dateReview)) throw new Error('A supplied date adjudication differs from Core; preserve the native decision before a new review');
    return payload;
  });
  durable(path.join(directory, 'publication-proof-manifest.json'), findings.map(finding => {
    const bounded = boundEquivalentCopies(finding, finding.sourceIds.map(id => records.get(id)));
    return { findingId: finding.id, ...bounded.limits, sources: bounded.proof };
  }));
  const normalized = plan.map(value => contract.normalize(value)); // All validate before any mutation.
  durable(path.join(directory, 'publication-plan.json'), { at: new Date().toISOString(), entries: plan,
    contextHashes: normalized.map(value => value.context.inputHash) });
  if (command === 'plan') { console.log(JSON.stringify({ entries: plan.length, proposedMatches: plan.reduce((n, p) => n + p.relations.length, 0), published: 0 })); return; }
  if (!call || !/^[1-9]\d*$/.test(options['max-entries'] || '')) throw new Error('Publication needs Core and an explicit positive --max-entries budget');
  const receipts = [];
  let writes = 0;
  for (let i = 0; i < plan.length && writes < Number(options['max-entries']); i++) {
    const receipt = await publishOne(directory, plan[i], normalized[i], call);
    receipts.push(receipt);
    if (!receipt.reconciled) writes++;
  }
  durable(path.join(directory, 'publication-summary.json'), { at: new Date().toISOString(), receipts });
  console.log(JSON.stringify({ publishedOrReconciled: receipts.length, writes, candidates: plan.length, confirmed: 0 }));
}
module.exports = { build, applyDateReview, nativeDateReview, sourceRecord, boundEquivalentCopies, matches, client, lookup, publishOne, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
