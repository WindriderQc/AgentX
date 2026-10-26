#!/usr/bin/env node
'use strict';

// Publish native review receipts through Core's existing context importer.
// These files are execution/recovery evidence, never a second memory authority.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
function build(finding, indexed, { matches = [] } = {}) {
  if (!/^objective-[a-f0-9]{64}$/.test(finding.id || '') || finding.userConfirmed !== false || finding.reviewState !== 'candidate') throw new Error('Only native unconfirmed objective candidates can be imported');
  const records = finding.sourceIds.map(id => { const record = indexed.get(id); if (!record) throw new Error(`Missing quoted source ${id}`); return record; });
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
      sourceIds: finding.sourceIds, claimsWithExactQuotes: finding.claimsWithExactQuotes,
      proposedRelations: [...(finding.relationHints || []), ...proposals],
      metadata: { objectiveId: finding.objectiveId, objectiveVersion: finding.objectiveVersion,
        subject: finding.subject, subjectName: finding.subjectName, userConfirmed: false } },
    sourceRecords: records.map(sourceRecord),
    relations: related.map(row => ({ id: `objective-match-${hash(`${finding.id}:${row.id}`)}`, title: 'Fait possiblement déjà relevé',
      kind: 'hypothesis', eventIds: [finding.id, row.timeline.legacyId],
      summary: 'La nouvelle lecture et le relevé existant citent le même original et un passage commun.',
      rationale: 'Rapprochement de provenance et de citation, sans fusion ni changement du relevé antérieur.',
      limits: 'Une même source ne constitue pas une corroboration indépendante; les formulations et dates restent à revoir.',
      sourceIndependence: 'not-established', claimsWithExactQuotes: finding.claimsWithExactQuotes })), media: [] };
  return payload;
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
    contextRevision: entry.contextRevision, reconciled: true, assertionState: entry.assertionState, reviewState: entry.reviewState };
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
  const plan = findings.map(finding => build(finding, records, { matches: matches(finding, records, existing) }));
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
module.exports = { build, sourceRecord, matches, client, lookup, publishOne, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
