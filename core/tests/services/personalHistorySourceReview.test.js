'use strict';

const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const reviews = require('../../src/services/personalHistorySourceReview');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { archive } = require('../fixtures/historySourceArchive');

describe('source-bound historical scope reviews', () => {
  let fixture, id, deps;
  const prepared = async key => (await reviews.prepare(id, { requestId: key || randomUUID(), revision: 0 }, deps)).review;
  const decision = review => ({ snapshotHash: review.snapshotHash, revision: review.entryRevision,
    decision: 'reviewed_scope', reason: 'I reviewed these exact text representations only.' });
  async function serve(review) {
    for (let source = 0; source < review.sources.length; source++) {
      for (const part of review.sources[source].parts || []) {
        if (!part.readable) continue;
        let offset = 0;
        do {
          const result = await reviews.page(id, review.requestId, { source, part: part.partIndex, offset }, deps);
          review = result.review; offset = result.page.nextOffset;
        } while (offset !== null);
      }
    }
    return review;
  }
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); await Suppression.createIndexes(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({});
    fixture = await archive(); deps = { audience: 'owner', mail: fixture.mail };
    id = (await history.record({ kind: 'action', text: 'Synthetic unresolved request', sourceDate: '2024-01-01T00:00:00Z', source: fixture.source })).entry.id;
  });
  afterEach(async () => fixture.cleanup());

  test('pins native original headers separately from assertion actors and dates', async () => {
    const review = await prepared();
    expect(review.sources[0].headers).toEqual({ From: 'Synthetic <source@example.invalid>', To: '', Cc: '', Date: '', Subject: 'Synthetic source' });
    expect((await Entry.findById(id).lean()).sourceReviews[0].snapshot.contract).toBe('agentx.history-source-review/v2');
    expect((await reviews.get(id, review.requestId, deps)).review.nativeState).toBe('observed');
    // The assertion date is not a substitute for an absent original Date.
    expect(review.sources[0].headers.Date).toBe('');
  });

  test.each(['From', 'Date', 'Subject'])('changed native %s refuses page delivery and a late decision', async name => {
    const review = await serve(await prepared());
    deps.mail = { archived: async args => {
      const result = await fixture.mail.archived(args);
      return { ...result, headers: { ...result.headers, [name]: 'Different native observation' } };
    } };
    expect((await reviews.get(id, review.requestId, deps)).review.nativeState).toBe('stale');
    await expect(reviews.page(id, review.requestId, { source: 0, part: review.sources[0].parts[0].partIndex, offset: 0 }, deps)).rejects.toMatchObject({ statusCode: 409 });
    await expect(reviews.decide(id, review.requestId, decision(review), deps)).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(id).lean()).sourceReviews[0].decision).toBeNull();
  });

  test('missing, invalid or oversized native headers remain unavailable, without borrowing assertion metadata', async () => {
    const native = await fixture.mail.archived({ messageId: fixture.source.messageId, sha256: fixture.source.sourceSha256 });
    for (const headers of [undefined, [], { ...native.headers, From: 42 }, { ...native.headers, Subject: 'x'.repeat(2001) }]) {
      deps.mail = { archived: async () => ({ ...native, headers }) };
      const review = await prepared();
      expect(review.sources[0]).toMatchObject({ status: 'unavailable' });
      expect(review.sources[0].headers).toBeUndefined();
      expect(review.coverage.status).toBe('unknown');
    }
  });

  test('native header limit remains a visible gap and Unicode uses the native character bound', async () => {
    deps.mail = { archived: async args => {
      const result = await fixture.mail.archived(args);
      return { ...result, headers: { ...result.headers, Subject: '🦉'.repeat(2000) } };
    } };
    const review = await prepared();
    expect(review.sources[0].status).toBe('available');
    expect(review.coverage.gaps).toContainEqual({ source: 0, code: 'original_header_length_limit' });
  });

  test('frozen v1 reviews resume and decide with their original hash and no synthesized headers', async () => {
    const review = await prepared();
    const saved = (await Entry.findById(id).lean()).sourceReviews[0];
    saved.snapshot.contract = 'agentx.history-source-review/v1';
    saved.snapshot.sources.forEach(source => { delete source.headers; });
    saved.snapshotHash = digest(saved.snapshot);
    await Entry.updateOne({ _id: id }, { $set: { sourceReviews: [saved] } });
    let observed = (await reviews.get(id, review.requestId, deps)).review;
    expect(observed.nativeState).toBe('observed');
    expect(observed.snapshotHash).toBe(saved.snapshotHash);
    expect(observed.sources[0].headers).toBeUndefined();
    observed = await serve(observed);
    const result = await reviews.decide(id, review.requestId, decision(observed), deps);
    expect(result.receipt.snapshotHash).toBe(saved.snapshotHash);
    expect(result.review.sources[0].headers).toBeUndefined();
    expect((await reviews.get(id, review.requestId, deps)).review.nativeState).toBe('observed');
  });

  test('prepares, serves Unicode native pages and records only explicit text-scope review', async () => {
    let review = await prepared();
    expect(review.coverage.status).toBe('partial');
    expect(review.sources[0]).toMatchObject({ status: 'available', readerContract: 'secretary.archive-reader/v3' });
    await expect(reviews.decide(id, review.requestId, decision(review), deps)).rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INCOMPLETE' });
    review = await serve(review);
    expect(review.coverage.status).toBe('served_selected_text');
    expect(review.coverage.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'attachments_not_reviewed' }), expect.objectContaining({ code: 'html_supplement_not_reviewed' })]));
    const result = await reviews.decide(id, review.requestId, decision(review), deps);
    expect(result.receipt).toMatchObject({ decision: 'reviewed_scope', authenticatedPerson: null, executionAllowed: false });
    const row = await Entry.findById(id).lean();
    expect(row).toMatchObject({ revision: 1, reviewState: 'candidate', assertionState: 'unknown', text: 'Synthetic unresolved request' });
    expect(row.sourceReviews).toHaveLength(1);
    expect(JSON.stringify(row.sourceReviews)).not.toContain('A synthetic source 🦉');
  });

  test('lost preparation and decision replies reuse their original identities without native replay', async () => {
    const key = randomUUID(), review = await prepared(key), calls = fixture.calls;
    expect((await reviews.prepare(id, { requestId: key, revision: 0 }, deps)).replayed).toBe(true);
    expect(fixture.calls).toBe(calls);
    const read = await serve(review), first = await reviews.decide(id, key, decision(read), deps), after = fixture.calls;
    const replay = await reviews.decide(id, key, decision(read), deps);
    expect(replay).toMatchObject({ replayed: true, receipt: first.receipt });
    expect(fixture.calls).toBe(after);
    await expect(reviews.decide(id, key, { ...decision(read), reason: 'Different intent' }, deps)).rejects.toMatchObject({ statusCode: 409 });
    await expect(reviews.prepare(id, { requestId: key, revision: 1 }, deps)).rejects.toMatchObject({ statusCode: 409 });
    const newer = (await reviews.prepare(id, { requestId: randomUUID(), revision: 1 }, deps)).review;
    expect(newer.history).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: key, decision: 'reviewed_scope' })]));
  });

  test('a request UUID cannot be borrowed by another historical assertion', async () => {
    const key = randomUUID(); await prepared(key);
    const other = (await history.record({ kind: 'fact', text: 'Other assertion', sourceDate: '2024-01-01T00:00:00Z',
      source: { ...fixture.source, findingId: 'b'.repeat(64) } })).entry.id;
    await expect(reviews.prepare(other, { requestId: key, revision: 0 }, deps)).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(other).lean()).sourceReviews).toHaveLength(0);
  });

  test('Core retains the original intent before native rechecking and resumes it by reference only', async () => {
    const review = await serve(await prepared()), input = decision(review), intentHash = digest(input);
    let releaseRead, entered;
    const nativeEntered = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { releaseRead = resolve; });
    const original = reviews.decide(id, review.requestId, input, { audience: 'owner', mail: { archived: async args => {
      entered(); await gate; return fixture.mail.archived(args);
    } } });
    try {
      await nativeEntered;
      const pending = (await reviews.get(id, review.requestId, deps)).review;
      expect(pending).toMatchObject({ decision: null, decisionIntent: { intentHash, input, executionAllowed: false } });
      expect((await Entry.findById(id).lean()).revision).toBe(0);
      await expect(reviews.decide(id, review.requestId, { ...input, reason: 'A replacement intent' }, deps)).rejects.toMatchObject({ statusCode: 409 });
      const accepted = await reviews.decide(id, review.requestId, { intentHash }, deps);
      expect(accepted.receipt).toMatchObject({ intentHash, decision: input.decision, reason: input.reason, executionAllowed: false });
      releaseRead();
      expect(await original).toMatchObject({ replayed: true, receipt: accepted.receipt });
      expect((await Entry.findById(id).lean()).revision).toBe(1);
    } finally { releaseRead(); await original.catch(() => {}); }
  });

  test('an unknown reference or a corrupted retained intent cannot supply decision contents', async () => {
    const review = await prepared(), input = { ...decision(review), decision: 'needs_follow_up' };
    const calls = fixture.calls;
    await expect(reviews.decide(id, review.requestId, { intentHash: digest(input) }, deps))
      .rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INTENT_UNKNOWN' });
    await expect(reviews.decide(id, review.requestId, { intentHash: digest(input), reason: 'Injected' }, deps))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(fixture.calls).toBe(calls);
    await reviews.decide(id, review.requestId, input, deps);
    await Entry.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(id) },
      { $set: { 'sourceReviews.0.decisionIntent.input.reason': 'Corrupted retained reason' } });
    await expect(reviews.get(id, review.requestId, deps)).rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INTEGRITY' });
    await expect(reviews.decide(id, review.requestId, { intentHash: digest(input) }, deps))
      .rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INTEGRITY' });
    const revision = (await Entry.findById(id).lean()).revision;
    await history.review(id, { revision, state: 'forgotten' });
    expect((await Entry.findById(id).lean()).sourceReviews).toEqual([]);
    await expect(reviews.get(id, review.requestId, deps)).resolves.toEqual({ erased: true, requestId: review.requestId, executionAllowed: false });
  });

  test('source erasure preserves only an opaque transport fence against UUID reuse', async () => {
    const key = randomUUID(); await prepared(key);
    await history.review(id, { revision: 0, state: 'forgotten' });
    const forgotten = await Entry.findById(id).lean();
    expect(forgotten.sourceReviews).toHaveLength(0);
    expect(forgotten.sourceReviewRequestKeys).toEqual([digest(key)]);
    const other = (await history.record({ kind: 'fact', text: 'Another source assertion', sourceDate: '2024-01-01T00:00:00Z',
      source: { ...fixture.source, findingId: 'e'.repeat(64) } })).entry.id;
    const calls = fixture.calls;
    await expect(reviews.prepare(other, { requestId: key, revision: 0 }, deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.calls).toBe(calls);
  });

  test('a lost page response replays identical bytes without advancing coverage twice', async () => {
    const review = await prepared(), part = review.sources[0].parts[0];
    const input = { source: 0, part: part.partIndex, offset: 0 };
    const first = await reviews.page(id, review.requestId, input, deps);
    const before = (await Entry.findById(id).lean()).sourceReviews[0];
    const replay = await reviews.page(id, review.requestId, input, deps);
    const after = (await Entry.findById(id).lean()).sourceReviews[0];
    expect(replay).toMatchObject({ replayed: true, page: first.page });
    expect(after.readRevision).toBe(before.readRevision);
    expect(after.coverage).toEqual(before.coverage);
  });

  test('family scope and client authority flags refuse before native reading', async () => {
    await expect(reviews.prepare(id, { requestId: randomUUID(), revision: 0 }, { audience: 'family', mail: fixture.mail })).rejects.toMatchObject({ statusCode: 403 });
    await expect(reviews.prepare(id, { requestId: randomUUID(), revision: 0, verified: true }, deps)).rejects.toMatchObject({ statusCode: 400 });
    expect(fixture.calls).toBe(0);
  });

  test('provider/auth unavailability is unknown and cannot produce a reviewed-scope decision', async () => {
    deps.mail = { archived: async () => { throw Object.assign(new Error('Synthetic auth outage'), { code: 'SECRETARY_MAIL_HOST_UNAVAILABLE' }); } };
    const review = await prepared();
    expect(review.coverage.status).toBe('unknown');
    expect(review.sources[0].status).toBe('unavailable');
    await expect(reviews.decide(id, review.requestId, decision(review), deps)).rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INCOMPLETE' });
    const result = await reviews.decide(id, review.requestId, { ...decision(review), decision: 'needs_follow_up' }, deps);
    expect(result.receipt).toMatchObject({ decision: 'needs_follow_up', coverage: { status: 'unknown' }, executionAllowed: false });
  });

  test('an unsupported related source is a gap, never silently omitted or imported', async () => {
    await Entry.updateOne({ _id: id }, { $set: { relatedSources: [{ system: 'document', id: 'synthetic-document', sourceSha256: 'b'.repeat(64), findingId: 'c'.repeat(64) }] } });
    const review = await prepared();
    expect(review.sources).toHaveLength(2);
    expect(review.sources[1]).toMatchObject({ status: 'unavailable', code: 'SOURCE_READER_NOT_SUPPORTED' });
    expect(review.coverage.status).toBe('unknown');
  });

  test('out-of-order pages, forged snapshots and native version changes cannot advance review', async () => {
    const review = await prepared(), part = review.sources[0].parts.find(part => part.readable);
    await expect(reviews.page(id, review.requestId, { source: 0, part: part.partIndex, offset: 10000 }, deps)).rejects.toMatchObject({ statusCode: 400 });
    await expect(reviews.decide(id, review.requestId, { ...decision(review), snapshotHash: '0'.repeat(64) }, deps)).rejects.toMatchObject({ statusCode: 409 });
    await fixture.damage();
    expect((await reviews.get(id, review.requestId, deps)).review.nativeState).toBe('unknown');
    await expect(reviews.page(id, review.requestId, { source: 0, part: part.partIndex, offset: 0 }, deps)).rejects.toThrow();
    expect((await Entry.findById(id).lean()).sourceReviews[0].readRevision).toBe(0);
  });

  test('native byte changes after page delivery refuse a late decision', async () => {
    const review = await serve(await prepared()); await fixture.damage();
    await expect(reviews.decide(id, review.requestId, decision(review), deps)).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(id).lean()).sourceReviews[0].decision).toBeNull();
  });

  test('context updates invalidate a prepared snapshot even without an entry revision bump', async () => {
    const review = await prepared();
    // Same revision counter, independent canonical context version changed.
    await Entry.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(id) }, { $set: {
      context: { revision: 1, inputHash: 'c'.repeat(64), overrides: {} }
    } });
    expect((await reviews.get(id, review.requestId, deps)).review).toMatchObject({ entryCurrent: false, nativeState: 'stale' });
    await expect(reviews.page(id, review.requestId, { source: 0, part: review.sources[0].parts[0].partIndex, offset: 0 }, deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  test.each(['prepare', 'page', 'decision'])('forgetting during %s erases state and refuses the late result', async phase => {
    const review = phase === 'prepare' ? null : phase === 'decision' ? await serve(await prepared()) : await prepared();
    let once = false;
    deps.mail = { archived: async args => {
      const result = await fixture.mail.archived(args);
      if (!once) { once = true; await history.review(id, { revision: 0, state: 'forgotten' }); }
      return result;
    } };
    const operation = phase === 'prepare' ? prepared() : phase === 'page'
      ? reviews.page(id, review.requestId, { source: 0, part: review.sources[0].parts[0].partIndex, offset: 0 }, deps)
      : reviews.decide(id, review.requestId, decision(review), deps);
    await expect(operation).rejects.toMatchObject({ statusCode: 404 });
    expect((await Entry.findById(id).lean()).sourceReviews).toHaveLength(0);
    if (review) await expect(reviews.get(id, review.requestId, deps)).resolves.toMatchObject({ erased: true, executionAllowed: false });
    else await expect(reviews.get(id, randomUUID(), deps)).rejects.toMatchObject({ statusCode: 404 });
  });

  test.each(['prepare', 'page', 'decision'])('owner modifications during %s refuse late source receipts', async phase => {
    const review = phase === 'prepare' ? null : phase === 'decision' ? await serve(await prepared()) : await prepared();
    let once = false;
    deps.mail = { archived: async args => { const result = await fixture.mail.archived(args);
      if (!once) { once = true; await history.review(id, { revision: 0, state: 'retained', reason: 'A different owner decision' }); }
      return result; } };
    const operation = phase === 'prepare' ? prepared() : phase === 'page'
      ? reviews.page(id, review.requestId, { source: 0, part: review.sources[0].parts[0].partIndex, offset: 0 }, deps)
      : reviews.decide(id, review.requestId, decision(review), deps);
    await expect(operation).rejects.toMatchObject({ statusCode: 409 });
    const row = await Entry.findById(id).lean();
    expect(row.reviewState).toBe('retained');
    if (phase === 'prepare') expect(row.sourceReviews).toHaveLength(0);
    else expect(row.sourceReviews[0].decision).toBeNull();
  });

  test('the existing source-note erasure path removes prepared reviews during a native page read', async () => {
    const note = 'd'.repeat(24);
    await Entry.updateOne({ _id: id }, { $set: { 'source.personalNoteId': note } });
    const review = await prepared(), part = review.sources[0].parts[0];
    deps.mail = { archived: async args => {
      const result = await fixture.mail.archived(args);
      await require('../../src/services/personalHistoryPrivacy').forgetSourceNote({ id: note, text: 'A synthetic forgotten note' });
      return result;
    } };
    await expect(reviews.page(id, review.requestId, { source: 0, part: part.partIndex, offset: 0 }, deps)).rejects.toMatchObject({ statusCode: 404 });
    expect((await Entry.findById(id).lean()).sourceReviews).toHaveLength(0);
  });

  test('stored snapshot corruption is refused before another source read', async () => {
    const review = await prepared(), calls = fixture.calls;
    await Entry.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(id) }, { $set: { 'sourceReviews.0.snapshot.scope': 'corrupt' } });
    await expect(reviews.get(id, review.requestId, deps)).rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INTEGRITY' });
    await expect(reviews.prepare(id, { requestId: review.requestId, revision: 0 }, deps)).rejects.toMatchObject({ code: 'HISTORY_SOURCE_REVIEW_INTEGRITY' });
    expect(fixture.calls).toBe(calls);
  });
});
