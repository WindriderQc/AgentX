'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const publisher = require('../../../../integrations/secretary/objective_publish.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const quote = 'Mon déménagement fictif est terminé en août 2014.';
  const source = { id: 'objective-' + 'a'.repeat(64), body: quote, bodySha256: hash(quote), subject: 'Source fictive',
    mailDate: '2014-08-20T10:00:00+00:00', bodyScope: 'exact-reviewed-passage',
    nativeRef: { system: 'gmail', messageId: 'message001', threadId: 'thread0001', sourceSha256: 'b'.repeat(64), direction: 'sent' } };
  const finding = { id: 'objective-' + 'c'.repeat(64), objectiveId: 'life', objectiveVersion: 'v1',
    title: 'Un déménagement fictif', description: 'La personne décrit son déménagement.', category: 'home',
    startDate: '2014-08', startPrecision: 'month', endDate: null, endPrecision: 'unknown', ongoing: false,
    originalDate: 'août 2014', subject: 'owner', subjectName: 'Personne fictive', occurrenceStatus: 'reported',
    claimType: 'direct', uncertainty: 'Jour inconnu.', rationale: 'Déclaration directe.', relationHints: [],
    reviewState: 'candidate', userConfirmed: false, sourceIds: [source.id], claimsWithExactQuotes: [{ sourceId: source.id, quote }] };
  return { finding, source, indexed: new Map([[source.id, source]]) };
}
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeCore({ lose = false, missing = false } = {}) {
  let entry = null, posts = 0;
  return { get posts() { return posts; }, set entry(value) { entry = value; }, get entry() { return entry; },
    async call(url, body) {
      if (!body) return { total: entry ? 1 : 0, entries: entry ? [entry] : [] };
      posts++;
      if (!missing) entry = { id: 'd'.repeat(24), sourceKey: 'e'.repeat(64), contextHash: 'expected', contextRevision: 1, assertionState: 'unknown', reviewState: 'candidate' };
      if (lose || missing) throw new TypeError('response lost');
      return { results: [{ importId: body.entries[0].importId, contextHash: 'expected', entryId: entry.id, contextRevision: 1, created: true }] };
    } };
}
test('native candidates map to Core context without user confirmation', () => {
  const { finding, source, indexed } = fixture();
  const result = publisher.build(finding, indexed);
  assert.equal(result.timeline.claimType, 'assertion');
  assert.equal(result.timeline.reviewState, 'candidate');
  assert.equal(result.entry.source.sourceSha256, source.nativeRef.sourceSha256);
  assert.equal(result.entry.sourceDate, '2014-08-20T10:00:00.000Z');
  assert.equal(result.timeline.date, '2014-08');
  assert.equal(result.timeline.metadata.subject, 'owner');
  assert.equal(result.sourceRecords[0].authority, 'source-record');
  assert.equal(result.timeline.claimsWithExactQuotes[0].quote, source.body);
  assert.equal(result.timeline.metadata.userConfirmed, false);
});
test('a source audit publishes an unknown date initially and retains the exact model proposal in Core metadata', () => {
  const { finding, source, indexed } = fixture();
  const review = { findingId: finding.id, clear: ['start'], reason: 'Seule une borne supérieure est attestée.',
    question: 'Quelle est la date réelle du déménagement ?', reviewedAt: '2026-10-26T18:00:00Z' };
  const result = publisher.build(finding, indexed, { dateReview: review });
  assert.equal(result.timeline.date, null); assert.equal(result.timeline.precision, 'unknown');
  assert.equal(result.entry.eventDate, ''); assert.equal(result.entry.eventDatePrecision, 'unknown');
  assert.equal(result.timeline.metadata.dateReview.modelProposal.date, '2014-08');
  assert.equal(result.timeline.metadata.dateReview.authority, 'automated-source-audit-not-owner-confirmation');
  assert.equal(result.timeline.reviewState, 'candidate'); assert.equal(result.timeline.metadata.userConfirmed, false);
  assert.deepEqual(result.timeline.claimsWithExactQuotes, finding.claimsWithExactQuotes);
  assert.equal(result.sourceRecords[0].body, source.body);
  assert.equal(finding.startDate, '2014-08');
  const retained = publisher.nativeDateReview({ context: { importedTimeline: result.timeline } });
  const resumed = publisher.build(finding, indexed, { dateReview: retained });
  assert.deepEqual(resumed, result);
});
test('date audit cannot invent a date or silently reuse another model proposal', () => {
  const { finding, indexed } = fixture();
  const base = { findingId: finding.id, clear: ['invent'], reason: 'Motif explicite.', question: 'Question explicite ?', reviewedAt: '2026-10-26T18:00:00Z' };
  assert.throws(() => publisher.build(finding, indexed, { dateReview: base }), /adjudication/);
  base.clear = ['start']; base.modelProposal = { date: '2000' };
  assert.throws(() => publisher.build(finding, indexed, { dateReview: base }), /another model proposal/);
});
test('a native date adjudication changed after planning cannot be overwritten by source enrichment', async t => {
  const dir = home(t), { finding, indexed } = fixture();
  const payload = publisher.build(finding, indexed);
  let posts = 0;
  const call = async (_url, body) => {
    if (body) { posts++; throw new Error('must not write'); }
    return { total: 1, entries: [{ id: 'd'.repeat(24), contextHash: 'earlier', contextRevision: 7,
      timeline: { metadata: { dateReview: { contract: 'native-existing-audit' } } } }] };
  };
  await assert.rejects(publisher.publishOne(dir, payload, { context: { inputHash: 'expected' } }, call), /adjudication changed/);
  assert.equal(posts, 0);
});
test('bad source hashes and quotes refuse before an API call', () => {
  const { finding, source, indexed } = fixture();
  source.bodySha256 = '0'.repeat(64);
  assert.throws(() => publisher.build(finding, indexed), /integrity/);
  source.bodySha256 = hash(source.body);
  finding.claimsWithExactQuotes[0].quote = 'Absent';
  assert.throws(() => publisher.build(finding, indexed), /not exact/);
});
test('a lost successful response reconciles the exact native import without replay', async t => {
  const dir = home(t), { finding, indexed } = fixture();
  const payload = publisher.build(finding, indexed), core = fakeCore({ lose: true });
  const first = await publisher.publishOne(dir, payload, { context: { inputHash: 'expected' } }, core.call);
  assert.equal(first.reconciled, true);
  await publisher.publishOne(dir, payload, { context: { inputHash: 'expected' } }, core.call);
  assert.equal(core.posts, 1);
});
test('an unconfirmed publication blocks replacement even when no entry is found', async t => {
  const dir = home(t), { finding, indexed } = fixture();
  const payload = publisher.build(finding, indexed), core = fakeCore({ missing: true });
  await assert.rejects(publisher.publishOne(dir, payload, { context: { inputHash: 'expected' } }, core.call), /unconfirmed/);
  await assert.rejects(publisher.publishOne(dir, payload, { context: { inputHash: 'expected' } }, core.call), /remains uncertain/);
  assert.equal(core.posts, 1);
});
test('source enrichment uses Core revision and retains existing owner state', async t => {
  const dir = home(t), { finding, indexed } = fixture();
  const payload = publisher.build(finding, indexed);
  let posted;
  const call = async (_url, body) => {
    if (!body) return { total: 1, entries: [{ id: 'd'.repeat(24), contextHash: 'earlier', contextRevision: 7, reviewState: 'retained', assertionState: 'confirmed' }] };
    posted = body.entries[0];
    return { results: [{ importId: payload.importId, contextHash: 'expected', entryId: 'd'.repeat(24), contextRevision: 8, changed: true }] };
  };
  await publisher.publishOne(dir, payload, { context: { inputHash: 'expected' } }, call);
  assert.equal(posted.expectedContextRevision, 7);
  assert.equal(posted.timeline.reviewState, 'candidate'); // descriptive import, never native review
});
test('existing facts are proposed as hypotheses, never overwritten or auto-merged', () => {
  const { finding, indexed, source } = fixture();
  const existing = [{ id: 'd'.repeat(24), sourceKey: 'e'.repeat(64), source: { sourceSha256: source.nativeRef.sourceSha256 },
    timeline: { legacyId: 'existing-fact', claimsWithExactQuotes: finding.claimsWithExactQuotes } }];
  const result = publisher.build(finding, indexed, { matches: publisher.matches(finding, indexed, existing) });
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].kind, 'hypothesis');
  assert.deepEqual(result.relations[0].eventIds, [finding.id, 'existing-fact']);
  assert.equal(result.entryId, undefined);
  assert.equal(existing[0].timeline.title, undefined);
});
test('hundreds of equivalent copies are grouped explicitly without losing distinct evidence or stopping publication', () => {
  const { finding, indexed, source } = fixture();
  for (let n = 0; n < 150; n++) {
    const id = `objective-${hash(`alias-${n}`)}`;
    indexed.set(id, { ...source, id, bodyScope: 'verified-equivalent-unit-not-read-by-model',
      nativeRef: { ...source.nativeRef, system: 'outlook-export', messageId: hash(id) } });
    finding.sourceIds.push(id); finding.claimsWithExactQuotes.push({ sourceId: id, quote: source.body });
  }
  const result = publisher.build(finding, indexed);
  assert.equal(result.sourceRecords.length, 2);
  assert.equal(result.timeline.claimsWithExactQuotes.length, 2);
  assert.equal(result.timeline.metadata.proofLimits.omittedEquivalentCopies, 149);
  assert.equal(result.timeline.metadata.proofLimits.totalSourceRecords, 151);
  assert.match(result.timeline.metadata.proofLimits.proofManifestSha256, /^[a-f0-9]{64}$/);
  const proof = publisher.boundEquivalentCopies(finding, finding.sourceIds.map(id => indexed.get(id)));
  assert.equal(proof.proof.length, 151);
  assert.equal(proof.limits.omitted.length, 149);
});
test('an oversized equivalent body is retained in native provenance while the original claim can still publish', () => {
  const { finding, indexed, source } = fixture();
  const id = 'objective-' + 'f'.repeat(64), body = source.body + '\n' + 'x'.repeat(1024 * 1024);
  indexed.set(id, { ...source, id, body, bodySha256: hash(body), bodyScope: 'verified-equivalent-unit-not-read-by-model' });
  finding.sourceIds.push(id); finding.claimsWithExactQuotes.push({ sourceId: id, quote: source.body });
  const result = publisher.build(finding, indexed);
  assert.equal(result.sourceRecords.length, 1);
  assert.equal(result.timeline.metadata.proofLimits.omittedEquivalentCopies, 1);
  assert.equal(result.timeline.claimsWithExactQuotes[0].quote, source.body);
});
