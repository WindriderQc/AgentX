'use strict';
const { randomUUID, createHash } = require('node:crypto');
const current = require('./personalHistoryManifestConfirmationCurrent');
const preservation = require('./personalHistoryPreservationContract');
const { digest } = require('./personalHistorySourceReviewSources');
const c = require('./personalHistorySemanticReviewContract');
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
const descriptors = sources => sources.map(source => ({ resources: source.resources.map(({ nextOffset, served, ...r }) => r) }));
function describe(value, nonce, reference, retained, read) {
  c.requireEvidence(value && Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
  const { reviewPacket, resources, page, semanticAcceptance, executionAllowed, ...original } = value;
  c.requireEvidence(original.contract === 'secretary.archive-semantic-review/v1' && semanticAcceptance === false && executionAllowed === false
    && c.exact(value, ['contract', 'requestId', 'messageId', 'threadId', 'sourceSha256', 'machineIdSha256', 'archiveIdSha256', 'raw', 'attachments',
      'metadataSha256', 'partsDecoded', 'attachmentsDecoded', 'reviewPacket', 'resources', 'semanticAcceptance', 'executionAllowed', ...(read ? ['page'] : [])]));
  const proof = preservation.describe({ ...original, contract: preservation.CONTRACT }, nonce, reference);
  const { reviewPacket: expectedGraph, ...expectedContent } = retained.content;
  c.requireEvidence(same(proof.content, expectedContent) && same(reviewPacket, expectedGraph)
    && proof.machineIdSha256 === retained.machineIdSha256 && proof.archiveIdSha256 === retained.archiveIdSha256
    && Array.isArray(resources) && resources.length >= 2 && resources.length <= 256);
  let total = 0; const seen = new Map();
  for (const r of resources) {
    c.requireEvidence(c.exact(r, ['kind', 'key', 'sha256', 'bytes'])
      && ['original', 'attachment', 'analysis', 'compound_member'].includes(r.kind)
      && typeof r.key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(r.key) && c.isHash(r.sha256)
      && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= 16 * 1024 * 1024
      && (!seen.has(`${r.kind}:${r.key}`) || (r.kind === 'compound_member' && same(seen.get(`${r.kind}:${r.key}`), r))));
    total += r.bytes; seen.set(`${r.kind}:${r.key}`, r);
  }
  c.requireEvidence(total <= 16 * 1024 * 1024 && resources.filter(r => r.kind === 'original').length === 1
    && resources.some(r => r.kind === 'original' && r.key === 'original' && r.sha256 === reference.sourceSha256 && r.bytes === proof.content.raw.bytes)
    && resources.filter(r => r.kind === 'analysis').length === 1 && resources.some(r => r.kind === 'analysis' && r.key === 'selected-analysis' && r.bytes > 0)
    && resources.filter(r => r.kind === 'compound_member').length <= reviewPacket.counts.compoundMembers
    && same(resources.filter(r => r.kind === 'attachment').map(r => ({ partId: r.key, sha256: r.sha256, bytes: r.bytes })).sort((a,b) => a.partId.localeCompare(b.partId)),
      [...proof.content.attachments].sort((a,b) => a.partId.localeCompare(b.partId))));
  if (read) {
    const r = resources[read.resource];
    c.requireEvidence(r && read.offset <= r.bytes && c.exact(page, ['resource', 'offset', 'nextOffset', 'contentBase64', 'chunkSha256'])
      && page.resource === read.resource && page.offset === read.offset && typeof page.contentBase64 === 'string'
      && page.contentBase64.length <= 43692 && c.isHash(page.chunkSha256));
    const bytes = Buffer.from(page.contentBase64, 'base64');
    c.requireEvidence(bytes.toString('base64') === page.contentBase64 && bytes.length === Math.min(32768, r.bytes - read.offset)
      && page.chunkSha256 === createHash('sha256').update(bytes).digest('hex')
      && page.nextOffset === (read.offset + bytes.length === r.bytes ? null : read.offset + bytes.length));
  }
  return { resources, ...(read ? { page } : {}) };
}
async function observe(selected, deps, read) {
  const observed = await current.observeWithEvidence(selected.manifestRequestId,
    { checks: selected.checks, before: selected.before, observationId: randomUUID() }, deps);
  if (observed.observation.snapshot.confirmationStatus !== 'current') throw c.error('EVIDENCE_CHANGED');
  const manifest = observed.preview.manifest;
  const control = deps.preservation.control || new (require('../../integrations/runtime-bridges/secretary-preservation-control').SecretaryPreservationControl)();
  const sources = []; let page;
  for (let index = 0; index < manifest.sources.length; index++) {
    const reference = manifest.sources[index], nonce = randomUUID(), chosen = read && read.source === index ? read : undefined;
    const value = await control.probeSemanticReview('primary', { requestId: nonce, messageId: reference.messageId,
      threadId: reference.threadId, sourceSha256: reference.sourceSha256,
      ...(chosen ? { resource: chosen.resource, offset: chosen.offset } : {}) });
    const described = describe(value, nonce, reference, manifest.restoration.snapshot.members[index].snapshot.copies[0], chosen);
    sources.push({ reference, resources: described.resources });
    if (chosen) page = { source: index, ...described.page };
  }
  if (read && !page) throw c.error('INVALID', 400);
  const snapshot = { contract: c.CONTRACT, purpose: 'human_selected_sources_and_recorded_analyses', inputSha256: digest(selected),
    current: observed.observation.snapshot.current, originalConfirmation: observed.observation.snapshot.confirmation,
    sources: descriptors(sources) };
  const blockers = manifest.decisions.snapshot.findings.some(row => row.snapshot.inventory.threadQuestions.length)
    ? ['thread_questions_unresolved'] : [];
  await current.assertEvidenceCurrent(observed, deps);
  return { ...observed, snapshot, bindingSha256: digest(snapshot), sources, blockers, ...(page ? { page } : {}) };
}
function preview(evidence, row) {
  return { sources: evidence.sources.map((source, i) => ({ reference: source.reference,
    resources: row.sources[i].resources.map(r => ({ kind: r.kind, key: r.key, sha256: r.sha256, bytes: r.bytes, nextOffset: r.nextOffset, served: r.served })) })),
  blockers: evidence.blockers };
}
module.exports = { observe, preview, describe, descriptors, same };
